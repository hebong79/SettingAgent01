// 23회차 이터레이션 1 — `src/tools/individualEngine.ts` 유닛테스트(설계 §8-6단계 8테스트).
// ★ Unity RPC 미사용 — 차량은 씬 정본(`_workspace/18_scene_spec.json`)에서 합성한다. 골든 프레임은 로컬 픽스처.

import { readFileSync } from 'node:fs';
import { describe, expect, it, beforeAll } from 'vitest';
import { MATCH_MIN_IOU } from '../src/ground/autoRoiPlan.js';
import type { PixelQuad } from '../src/ground/types.js';
import type { TruthView } from '../src/ground/sceneTruth.js';
import { goldenTargets, GOLDEN_DIRS, type Target } from '../src/tools/sepAudit.js';
import { degradeCar, viewsOf, worldFaces, type RawCar } from '../src/tools/carAnchorUpper.js';
import {
  GATE_OFF,
  closedOf,
  gateBay,
  proposeFromObservation,
  resolveBays,
  runEngine,
  scoreBays,
  simDegradedSource,
  type BayProposal,
  type GateParams,
} from '../src/tools/individualEngine.js';

const ENGINE_SRC = readFileSync('src/tools/individualEngine.ts', 'utf8');

/** 씬 면 중심에 차 1대씩 세운 합성 `car.list`. 오라클 필드는 **의도적으로** 채워 둔다(봉인 테스트의 대조군). */
function syntheticCars(): RawCar[] {
  return worldFaces().map((f, i) => ({
    carNameId: `syn-${String(i).padStart(2, '0')}`,
    presetId: 1,
    faceSlot: i + 1,
    visible: true,
    pos: { x: f.cx, y: 0.05, z: f.cz },
    rotY: f.widthIsX ? 0 : 90,
    prefabId: 1,
  }));
}

const quadsOf = (ps: readonly BayProposal[]): string => JSON.stringify(ps.map((p) => p.quad));

let targets: Target[];
let views: Map<string, TruthView>;
let t: Target;
let view: TruthView;

beforeAll(async () => {
  targets = await goldenTargets(GOLDEN_DIRS.v1);
  views = viewsOf(targets);
  t = targets.find((x) => x.key === '1:1')!;
  view = views.get('1:1')!;
}, 120_000);

describe('individualEngine — G1 구조 보증', () => {
  it('1. proposeFromObservation 은 관측 1건에 면 0 또는 1개만 낸다(배열을 못 낸다)', () => {
    const cars = syntheticCars();
    const src = simDegradedSource(cars);
    const obs = src.observe(t, view);
    expect(obs.length).toBeGreaterThan(0);
    for (const o of obs) {
      const p = proposeFromObservation(o, t, null);
      expect(Array.isArray(p)).toBe(false);
      if (p !== null) {
        expect(typeof p.obsId).toBe('string');
        expect(p.quad).toHaveLength(4);
      }
    }
    // 관측 수 ≥ 제안 수 — 관측 1건이 면 2개를 만드는 경로가 없다.
    const props = obs.map((o) => proposeFromObservation(o, t, null)).filter((p): p is BayProposal => p !== null);
    expect(props.length).toBeLessThanOrEqual(obs.length);
    expect(new Set(props.map((p) => p.obsId)).size).toBe(props.length);
  });

  it('2. 소스에 금지 토큰(G2·G3·G5·G6)이 하나도 없다 — 정적 봉인', () => {
    for (const tok of ['filledIndices', 'latticeIndex', 'expectedBays', 'coverage', 'refScore', 'rowMinScoreRatio', 'effectiveScore']) {
      expect(ENGINE_SRC.includes(tok), `금지 토큰 발견: ${tok}`).toBe(false);
    }
  });
});

describe('individualEngine — 오염 격리(P5 봉인)', () => {
  it('3. faceSlot·presetId·visible 을 바꿔도 산출 quad 가 JSON 비트 동일', () => {
    const base = syntheticCars();
    const tampered: RawCar[] = base.map((c, i) => ({ ...c, faceSlot: 999 - i, presetId: 7, visible: false }));
    const a = runEngine(t, view, simDegradedSource(base), GATE_OFF, null);
    const b = runEngine(t, view, simDegradedSource(tampered), GATE_OFF, null);
    expect(quadsOf(b.kept)).toBe(quadsOf(a.kept));
    expect(quadsOf(b.proposals)).toBe(quadsOf(a.proposals));
    expect(b.scoreGated).toEqual(a.scoreGated);
    // 게이트 켜도 동일해야 한다.
    const g: GateParams = { minFootprintAreaPx: 1000, maxOutOfFramePts: 2, depthLoM: null, depthHiM: null, minConfidence: 0 };
    expect(quadsOf(runEngine(t, view, simDegradedSource(tampered), g, null).kept)).toBe(
      quadsOf(runEngine(t, view, simDegradedSource(base), g, null).kept),
    );
  });

  it('4. (대조군) pos 를 바꾸면 산출이 달라진다', () => {
    const base = syntheticCars();
    const moved: RawCar[] = base.map((c) => ({ ...c, pos: { ...c.pos, x: c.pos.x + 1.3 } }));
    const a = runEngine(t, view, simDegradedSource(base), GATE_OFF, null);
    const b = runEngine(t, view, simDegradedSource(moved), GATE_OFF, null);
    expect(quadsOf(b.kept)).not.toBe(quadsOf(a.kept));
  });
});

describe('individualEngine — 게이트', () => {
  const mk = (over: Partial<BayProposal>): BayProposal => ({
    obsId: 'x',
    kind: 'sim-degraded',
    quad: [
      { x: 0, y: 0 },
      { x: 0, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 0 },
    ],
    centerGround: [0, 0, 10],
    headGround: [0, 0, 1],
    depthM: 20,
    footprintAreaPx: 5000,
    outOfFramePts: 0,
    edgeHit: { near: 0, far: 0, sideA: 0, sideB: 0 },
    ...over,
  });

  it('5. 각 조건이 독립으로 작동한다(failed 배열)', () => {
    const g: GateParams = { minFootprintAreaPx: 1000, maxOutOfFramePts: 1, depthLoM: 5, depthHiM: 30, minConfidence: 0 };
    expect(gateBay(mk({}), g)).toEqual({ pass: true, failed: [] });
    expect(gateBay(mk({ footprintAreaPx: 999 }), g).failed).toEqual(['area']);
    expect(gateBay(mk({ outOfFramePts: 2 }), g).failed).toEqual(['outOfFrame']);
    expect(gateBay(mk({ depthM: 4 }), g).failed).toEqual(['depthLo']);
    expect(gateBay(mk({ depthM: 31 }), g).failed).toEqual(['depthHi']);
    expect(gateBay(mk({ depthM: null }), g).failed).toEqual(['depthLo', 'depthHi']);
    // 여러 조건 동시 위반은 전부 기록된다.
    expect(gateBay(mk({ footprintAreaPx: 1, outOfFramePts: 4 }), g).failed).toEqual(['area', 'outOfFrame']);
    // depth 축은 null 이면 미적용.
    expect(gateBay(mk({ depthM: 999 }), { ...g, depthLoM: null, depthHiM: null }).pass).toBe(true);
  });
});

describe('individualEngine — 배타성', () => {
  const sq = (x: number, y: number, s = 100): PixelQuad => [
    { x, y },
    { x, y: y + s },
    { x: x + s, y: y + s },
    { x: x + s, y },
  ];
  const prop = (obsId: string, quad: PixelQuad, area: number, out = 0): BayProposal => ({
    obsId,
    kind: 'sim-degraded',
    quad,
    centerGround: [0, 0, 1],
    headGround: [0, 0, 1],
    depthM: 10,
    footprintAreaPx: area,
    outOfFramePts: out,
    edgeHit: { near: 0, far: 0, sideA: 0, sideB: 0 },
  });

  it('6. quadIoU ≥ mergeIoU 인 쌍에서 서열 상위만 남는다', () => {
    const big = prop('big', sq(0, 0), 9000);
    const small = prop('small', sq(5, 5), 100); // 거의 완전 겹침
    const kept = resolveBays([small, big], MATCH_MIN_IOU);
    expect(kept.map((p) => p.obsId)).toEqual(['big']);
    // 서열 2차 키(outOfFramePts asc) 확인 — 면적이 같으면 프레임 밖 점이 적은 쪽이 이긴다.
    const a = prop('a', sq(0, 0), 500, 2);
    const b = prop('b', sq(3, 3), 500, 0);
    expect(resolveBays([a, b], MATCH_MIN_IOU).map((p) => p.obsId)).toEqual(['b']);
  });

  it('7. 겹치지 않는 제안은 하나도 죽지 않는다', () => {
    const ps = [prop('p1', sq(0, 0), 300), prop('p2', sq(500, 0), 300), prop('p3', sq(0, 500), 300)];
    const kept = resolveBays(ps, MATCH_MIN_IOU);
    expect(kept).toHaveLength(3);
    expect(new Set(kept.map((p) => p.obsId))).toEqual(new Set(['p1', 'p2', 'p3']));
  });
});

describe('individualEngine — 채점', () => {
  it('8. 프리셋 접두 키로 면을 센다(프리셋 간 면 id 충돌 회귀 방지)', () => {
    const cars = syntheticCars();
    const keys: string[] = [];
    let totalFaces = 0;
    for (const tt of targets) {
      const vv = views.get(tt.key);
      if (!vv) continue;
      const run = runEngine(tt, vv, simDegradedSource(cars), GATE_OFF, null);
      for (const c of closedOf(run.kept, tt)) if (c.matchedFaceKey) keys.push(c.matchedFaceKey);
      totalFaces += scoreBays(run.kept, tt).faces;
    }
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k).toMatch(/^\d+:\d+\|r\d+f\d+$/);
    // 접두가 없으면 프리셋 간 충돌로 과소 계상된다 — 전역 Set 크기가 프리셋별 합계와 일치해야 한다.
    expect(new Set(keys).size).toBe(totalFaces);
  });
});
