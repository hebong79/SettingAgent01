// 24회차 — 이미지 유래 관측원(`src/tools/imageObservation.ts`) 유닛테스트.
// 설계 `_workspace/21_architect_plan_round24_observation_source.md` §8 단계6 의 6항목.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { REGION_DEFAULTS } from '../src/domain/occupancyRegion.js';
import { lpdPlateSource, nearEdgeOf, vpdSegSource, type LpdCache, type SegCache, type SourceDrops } from '../src/tools/imageObservation.js';
import { GATE_OFF, gateBay, type BayProposal } from '../src/tools/individualEngine.js';
import { goldenTargets, GOLDEN_DIRS, type Target } from '../src/tools/sepAudit.js';

const SRC = readFileSync('src/tools/imageObservation.ts', 'utf8');
/**
 * 봉인 검사 대상은 **주석을 제거한 코드**다.
 * 주석에는 「t.vis 미접촉」·「fitContactLine 을 부르지 않는다」처럼 **금지를 명시하는 문장**이 있어야 하고,
 * 그 문장 때문에 봉인이 깨지면 검사가 문서화를 벌하는 꼴이 된다.
 */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/) // CRLF 체크아웃 대응: \r 이 줄 끝에 남으면 `.` 이 그것을 못 먹어 아래 주석 제거가 통째로 불발한다.
  .map((l) => l.replace(/\/\/.*$/, ''))
  .join('\n');

/** 골든 1프레임 — 모델(GroundModel)·W·H 가 실물이어야 역투영이 의미를 갖는다. */
let cached: Target | null = null;
async function oneTarget(): Promise<Target> {
  if (!cached) cached = (await goldenTargets(GOLDEN_DIRS.v1))[0];
  return cached;
}

/** 사각형 마스크(정규화) 픽스처. */
function boxMask(x0: number, y0: number, x1: number, y1: number): Array<{ x: number; y: number }> {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

describe('24회차 imageObservation — 이미지 유래 관측원', () => {
  it('1. vpdSegSource: 캐시 마스크 → 관측 수·footprintPx 4점 유효', async () => {
    const t = await oneTarget();
    const dir = mkdtempSync(join(tmpdir(), 'r24seg-'));
    const cache: SegCache = {
      frameHash: t.frameHash,
      key: t.key,
      W: t.W,
      H: t.H,
      boxes: [
        { vpdIdx: 0, confidence: 0.9, cls: 'vehicle', rect: { x: 0.3, y: 0.4, w: 0.1, h: 0.1 }, mask: boxMask(0.3, 0.4, 0.4, 0.5) },
        { vpdIdx: 3, confidence: 0.5, cls: 'vehicle', rect: { x: 0.5, y: 0.45, w: 0.08, h: 0.08 }, mask: boxMask(0.5, 0.45, 0.58, 0.53) },
      ],
      segDegraded: false,
      maskMismatch: 0,
    };
    writeFileSync(join(dir, `${t.frameHash}_seg.json`), JSON.stringify(cache));
    const drops = new Map<string, SourceDrops>();
    const obs = vpdSegSource(dir, drops).observe(t, null as never);
    expect(obs.length).toBe(2);
    expect(obs.map((o) => o.obsId)).toEqual(['seg#0', 'seg#3']); // ★ 원본 vpdIdx 보존(배열 위치 아님).
    expect(obs.map((o) => o.confidence)).toEqual([0.9, 0.5]);
    for (const o of obs) {
      expect(o.footprintPx).not.toBeNull();
      expect(o.footprintPx!.length).toBe(4);
      for (const p of o.footprintPx!) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
      }
      expect(o.plateQuad).toBeNull();
      expect(o.platePx).toBe(0);
      expect(o.source).toBe('real-vpd-seg');
    }
    expect(drops.get(t.key)).toEqual({ total: 2, noContour: 0, noNearEdge: 0, noFootprint: 0, ok: 2 });
    // 캐시 없는 프레임 → 관측 0(위장 없이 빈 배열).
    expect(vpdSegSource(mkdtempSync(join(tmpdir(), 'r24empty-'))).observe(t, null as never)).toEqual([]);
  });

  it('2. lpdPlateSource 는 REGION_DEFAULTS 를 변형하지 않는다(정본 수치 불변)', async () => {
    const t = await oneTarget();
    const before = { ...REGION_DEFAULTS };
    const dir = mkdtempSync(join(tmpdir(), 'r24lpd-'));
    const cache: LpdCache = {
      frameHash: t.frameHash,
      key: t.key,
      W: t.W,
      H: t.H,
      plates: [{ quad: [{ x: 0.4, y: 0.5 }, { x: 0.44, y: 0.5 }, { x: 0.44, y: 0.52 }, { x: 0.4, y: 0.52 }], confidence: 0.8, cls: 'car_license_plate' }],
    };
    writeFileSync(join(dir, `${t.frameHash}_lpd.json`), JSON.stringify(cache));
    const obs = lpdPlateSource(dir).observe(t, null as never);
    expect(obs.length).toBe(1);
    expect(obs[0].obsId).toBe('lpd#0');
    expect(obs[0].footprintPx!.length).toBe(4);
    expect(obs[0].platePx).toBeGreaterThan(0);
    expect(obs[0].source).toBe('real-lpd');
    expect(REGION_DEFAULTS).toEqual(before); // 참조 대상이 그대로다.
    expect(REGION_DEFAULTS.widthScaleMin).toBe(3.5);
    expect(REGION_DEFAULTS.upRatio).toBe(0.9);
    expect(REGION_DEFAULTS.downRatio).toBe(0.6);
  });

  it('3. 정적 봉인 — 오라클 필드가 새 관측 경로에 문자열로도 없다', () => {
    for (const tok of ['faceSlot', 'presetId', 'visible', 'rotY', 'pos.', 't.vis']) {
      expect(CODE.includes(tok), `오라클 토큰 누출: ${tok}`).toBe(false);
    }
  });

  it('4. 정적 봉인 — SlotAxes 계열 상위 파이프라인 미사용(설계 §1-3)', () => {
    for (const tok of ['fitContactLine', 'buildFootprint', 'buildFrameCuboids', 'SlotAxes', 'slotPolysPx']) {
      expect(CODE.includes(tok), `§1-3 배제 대상 사용: ${tok}`).toBe(false);
    }
    expect(CODE.includes('bottomContour')).toBe(true); // 재사용은 유지.
  });

  it('5. nearEdgeOf — 로버스트 밴드(양 끝 튐 흡수) · 퇴화 입력 null', () => {
    expect(nearEdgeOf([])).toBeNull();
    expect(nearEdgeOf([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }])).toBeNull(); // 4점 미만
    const cols = Array.from({ length: 20 }, (_, i) => ({ x: i * 4, y: 100 }));
    cols[0].y = 900; // 좌단 단일 열 튐 — 중앙값이 흡수해야 한다.
    const e = nearEdgeOf(cols);
    expect(e).not.toBeNull();
    expect(e![0].y).toBe(100);
    expect(e![1].y).toBe(100);
    expect(e![0].x).toBe(0);
    expect(e![1].x).toBe(76);
    // x 폭이 4px 이하 → null(선분 불성립).
    expect(nearEdgeOf([{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }])).toBeNull();
  });

  it('6. 게이트 신규 축 minConfidence — 절대 문턱 1개 · 강등본(confidence 없음)은 무력', () => {
    const base: BayProposal = {
      obsId: 'x',
      kind: 'real-seg',
      quad: [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 0 }],
      centerGround: [0, 0, 10],
      headGround: [1, 0, 0],
      depthM: 10,
      footprintAreaPx: 5000,
      outOfFramePts: 0,
      edgeHit: { near: 0, far: 0, sideA: 0, sideB: 0 },
    };
    const g = { ...GATE_OFF, minConfidence: 0.7 };
    expect(gateBay({ ...base, confidence: 0.9 }, g).failed).toEqual([]);
    expect(gateBay({ ...base, confidence: 0.5 }, g).failed).toEqual(['conf']);
    expect(gateBay(base, g).failed).toEqual([]); // undefined → 1 취급(강등본 회귀 기준선 불변).
    expect(gateBay({ ...base, confidence: 0.5 }, GATE_OFF).failed).toEqual([]); // GATE_OFF 는 무력.
  });

  it('7. G1~G8 정적 봉인 7토큰 유지(23회차 승계 · individualEngine)', () => {
    const eng = readFileSync('src/tools/individualEngine.ts', 'utf8');
    for (const tok of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8']) expect(eng.includes(tok)).toBe(true);
    // 관측 1건 → 면 0/1 개(G1)를 타입으로 못박은 시그니처가 그대로다.
    expect(eng.includes('export function proposeFromObservation(o: VehicleObservation, t: Target, ev: PaintEvidence | null): BayProposal | null')).toBe(true);
  });
});
