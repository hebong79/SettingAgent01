// 26회차 — 접지 콘투어 꺾임 분해(`src/tools/contactOrient.ts`) 유닛테스트.
// 설계 `_workspace/41_architect_plan_round26_contact_orientation.md` §11 단계7 의 6항목.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { frontEdgeOf, splitContour, tlsFit, type Px } from '../src/tools/contactOrient.js';
import { nearEdgeOf, vpdSegSource, type SegCache } from '../src/tools/imageObservation.js';
import { goldenTargets, GOLDEN_DIRS, type Target } from '../src/tools/sepAudit.js';

const SRC = readFileSync('src/tools/contactOrient.ts', 'utf8');
/** 봉인 검사 대상은 **주석을 제거한 코드** — 금지를 명시한 주석 문장이 검사를 깨면 안 된다(24회차 규약 승계). */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/)
  .map((l) => l.replace(/\/\/.*$/, ''))
  .join('\n');

let cached: Target | null = null;
async function oneTarget(): Promise<Target> {
  if (!cached) cached = (await goldenTargets(GOLDEN_DIRS.v1))[0];
  return cached;
}

function boxMask(x0: number, y0: number, x1: number, y1: number): Array<{ x: number; y: number }> {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

describe('26회차 contactOrient — 접지 꺾임 분해', () => {
  it('1. 합성 직각 L자 콘투어 → mode=kink · 꺾임각 90 근방 · 앞변이 짧은 변', async () => {
    const t = await oneTarget();
    // 화면 하단의 L: 왼쪽 20열이 수평(짧은 변), 오른쪽 40열이 경사(긴 변).
    const cols: Px[] = [];
    for (let i = 0; i < 20; i++) cols.push({ x: 600 + i * 4, y: 900 });
    for (let i = 1; i <= 40; i++) cols.push({ x: 676 + i * 4, y: 900 - i * 4 });
    const sp = splitContour(cols, 4);
    expect(sp).not.toBeNull();
    expect(sp!.kinkDeg).toBeGreaterThan(40);
    expect(sp!.gain).toBeGreaterThan(1.5);

    const chord = nearEdgeOf(cols);
    const fit = frontEdgeOf(cols, t.model, chord);
    expect(fit).not.toBeNull();
    expect(fit!.mode).toBe('kink');
    expect(fit!.kinkDeg).toBeGreaterThan(40);
    expect(fit!.other).not.toBeNull();
    // 채택된 앞변과 미채택 선분은 서로 다른 선분이다.
    expect(fit!.p0).not.toEqual(fit!.other![0]);
    // 픽셀 길이가 짧은 쪽(수평 20열 = 76px)이 앞변으로 잡힌다 — R3(시선직교)가 이 배치에서 그것을 고른다.
    const adopted = Math.hypot(fit!.p1.x - fit!.p0.x, fit!.p1.y - fit!.p0.y);
    const rejected = Math.hypot(fit!.other![1].x - fit!.other![0].x, fit!.other![1].y - fit!.other![0].y);
    expect(adopted).toBeLessThan(rejected);
  });

  it('2. 직선 콘투어 → mode=chord · 산출 좌표가 nearEdgeOf 와 완전 동일(폴백 동치성)', async () => {
    const t = await oneTarget();
    const cols: Px[] = Array.from({ length: 40 }, (_, i) => ({ x: 500 + i * 4, y: 800 }));
    const chord = nearEdgeOf(cols);
    expect(chord).not.toBeNull();
    const fit = frontEdgeOf(cols, t.model, chord);
    expect(fit).not.toBeNull();
    expect(fit!.mode).toBe('chord');
    // ★ 무회귀 안전판 — 폴백은 chord 를 **그대로** 돌려준다(재구현 아님).
    expect(fit!.p0).toEqual(chord![0]);
    expect(fit!.p1).toEqual(chord![1]);
    expect(fit!.splitIdx).toBeNull();
    expect(fit!.other).toBeNull();
  });

  it('3. 퇴화 입력 → null / chord 폴백', async () => {
    const t = await oneTarget();
    expect(frontEdgeOf([], t.model, null)).toBeNull(); // 콘투어도 chord 도 없다.
    expect(tlsFit([])).toBeNull();
    expect(tlsFit([{ x: 1, y: 1 }])).toBeNull();
    expect(splitContour([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }], 4)).toBeNull(); // 각 조각 4점 미만
    // x 폭 ≤4px 는 `nearEdgeOf` 가 chord 를 안 만든다 → 폴백 대상이 없어 null.
    const flat: Px[] = [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }];
    expect(frontEdgeOf(flat, t.model, nearEdgeOf(flat))).toBeNull();
  });

  it('4. 정적 봉인 — contactOrient.ts 에 오라클 토큰이 문자열로도 없다', () => {
    for (const tok of ['faceSlot', 'presetId', 'visible', 'rotY', 'pos.', 't.vis', 'degradeCar', 'simDegradedSource', 'carList']) {
      expect(CODE.includes(tok), `오라클 토큰 누출: ${tok}`).toBe(false);
    }
  });

  it('5. 정적 봉인 — §1-3 배제 토큰 부재(새 파일로의 봉인 세탁 방지)', () => {
    for (const tok of ['fitContactLine', 'buildFootprint', 'buildFrameCuboids', 'SlotAxes', 'slotPolysPx']) {
      expect(CODE.includes(tok), `§1-3 배제 대상 사용: ${tok}`).toBe(false);
    }
  });

  it('6. vpdSegSource 기본 인자 산출 == edge=chord 산출(기본값 회귀)', async () => {
    const t = await oneTarget();
    const dir = mkdtempSync(join(tmpdir(), 'r26seg-'));
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
    const dflt = vpdSegSource(dir).observe(t, null as never);
    const chord = vpdSegSource(dir, undefined, 'chord').observe(t, null as never);
    expect(dflt).toEqual(chord);
    expect(dflt.length).toBe(2);
    expect(dflt.map((o) => o.obsId)).toEqual(['seg#0', 'seg#3']);
  });
});
