// 27-A — 접지 콘투어 정제(`src/tools/contourRefine.ts`) 유닛테스트.
// 설계 `_workspace/51_architect_plan_round27_contour_refine.md` §9 단계 F 의 6항목.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dropFarTail, dropOccludedCols, dropRandomCols, seedOf, splitContour3 } from '../src/tools/contourRefine.js';
import { vpdSegSource, type SegCache } from '../src/tools/imageObservation.js';
import { goldenTargets, GOLDEN_DIRS, type Target } from '../src/tools/sepAudit.js';
import type { Px } from '../src/tools/contactOrient.js';

const SRC = readFileSync('src/tools/contourRefine.ts', 'utf8');
/** 봉인 검사 대상은 **주석을 제거한 코드**(26회차 규약 승계 — 금지를 명시한 주석이 검사를 깨면 안 된다). */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/)
  .map((l) => l.replace(/\/\/.*$/, ''))
  .join('\n');

let cached: Target | null = null;
async function oneTarget(): Promise<Target> {
  if (!cached) cached = (await goldenTargets(GOLDEN_DIRS.v1))[0];
  return cached;
}

/** 화면 하단의 곧은 콘투어 40열 — 정제 대상이 없는 합성 입력. */
function straightCols(): Px[] {
  const cols: Px[] = [];
  for (let i = 0; i < 40; i++) cols.push({ x: 600 + i * 4, y: 900 });
  return cols;
}

describe('27-A contourRefine — 접지 콘투어 정제', () => {
  it('1. 정제 함수는 입력 콘투어를 변형하지 않는다(불변성 · 새 배열 반환)', async () => {
    const t = await oneTarget();
    const cols = straightCols();
    const snapshot = JSON.parse(JSON.stringify(cols));
    const outs = [
      dropOccludedCols(cols, [], t.H),
      dropFarTail(cols, t.model, 3),
      dropRandomCols(cols, 5, seedOf('1:1#0')),
    ];
    expect(cols).toEqual(snapshot); // 원본 무변형.
    for (const o of outs) {
      expect(o).not.toBe(cols); // 새 배열.
      for (let i = 0; i < o.length; i++) expect(o[i]).not.toBe(cols.find((c) => c.x === o[i].x && c.y === o[i].y));
    }
  });

  it('2. 정제 대상이 없는 합성 입력 → 산출이 입력과 완전 동일(무회귀 안전판)', async () => {
    const t = await oneTarget();
    const cols = straightCols();
    // 다른 마스크가 없으면 가림 배제로 지워질 열이 없다.
    expect(dropOccludedCols(cols, [], t.H)).toEqual(cols);
    // 깊이가 균일한 곧은 열은 원경 꼬리가 없다(문턱 넉넉히).
    expect(dropFarTail(cols, t.model, 100)).toEqual(cols);
    // dropCount=0 이면 아무것도 지우지 않는다.
    expect(dropRandomCols(cols, 0, seedOf('x'))).toEqual(cols);
  });

  it('3. 퇴화 입력(빈 배열 · 4점 미만) → 빈 배열 또는 원본, 예외 없음', async () => {
    const t = await oneTarget();
    const tiny: Px[] = [{ x: 10, y: 20 }, { x: 14, y: 21 }, { x: 18, y: 22 }];
    expect(dropOccludedCols([], [], t.H)).toEqual([]);
    expect(dropFarTail([], t.model, 3)).toEqual([]);
    expect(dropRandomCols([], 3, 1)).toEqual([]);
    // 4점 미만은 minKeep 미달이므로 원본을 그대로 돌려준다(정제가 파괴가 되지 않게).
    expect(dropOccludedCols(tiny, [], t.H)).toEqual(tiny);
    expect(dropFarTail(tiny, t.model, 3)).toEqual(tiny);
    expect(dropRandomCols(tiny, 2, 1)).toEqual(tiny);
    expect(splitContour3(tiny, 4)).toBeNull();
    expect(splitContour3([], 4)).toBeNull();
    // N1 시드는 결정론이다(재현 가능 — 설계 §3-1).
    expect(seedOf('1:1#0')).toBe(seedOf('1:1#0'));
    const many = straightCols();
    expect(dropRandomCols(many, 6, seedOf('k'))).toEqual(dropRandomCols(many, 6, seedOf('k')));
  });

  it('4. 정적 봉인 — contourRefine.ts 에 오라클 토큰 부재(§6 Q6)', () => {
    for (const tok of ['faceSlot', 'presetId', 'visible', 'rotY', 'pos.', 't.vis', 'degradeCar', 'simDegradedSource', 'carList']) {
      expect(CODE.includes(tok)).toBe(false);
    }
  });

  it('5. 정적 봉인 — 배제 토큰 부재(fitContactLine·buildFootprint·buildFrameCuboids·SlotAxes·slotPolysPx)', () => {
    for (const tok of ['fitContactLine', 'buildFootprint', 'buildFrameCuboids', 'SlotAxes', 'slotPolysPx']) {
      expect(CODE.includes(tok)).toBe(false);
    }
    // `bottomContour` 재사용 유지 — 정제는 그 산출 뒤에 거는 후처리다.
    expect(readFileSync('src/tools/imageObservation.ts', 'utf8').includes('bottomContour')).toBe(true);
  });

  it('6. vpdSegSource 기본 인자 산출 == edge=\'chord\' 산출(기본값 회귀 · 26회차 6번 승계)', async () => {
    const t = await oneTarget();
    const dir = mkdtempSync(join(tmpdir(), 'r27a-'));
    const cache: SegCache = {
      frameHash: t.frameHash,
      key: t.key,
      W: t.W,
      H: t.H,
      boxes: [
        {
          vpdIdx: 0,
          confidence: 0.9,
          cls: 'car',
          rect: { x: 0.3, y: 0.5, w: 0.2, h: 0.2 },
          mask: [
            { x: 0.30, y: 0.50 },
            { x: 0.50, y: 0.50 },
            { x: 0.50, y: 0.68 },
            { x: 0.38, y: 0.70 },
            { x: 0.30, y: 0.62 },
          ],
        },
      ],
      segDegraded: false,
      maskMismatch: 0,
    };
    writeFileSync(join(dir, `${t.frameHash}_seg.json`), JSON.stringify(cache));
    const dflt = vpdSegSource(dir).observe(t, null as never);
    const chord = vpdSegSource(dir, undefined, 'chord').observe(t, null as never);
    expect(dflt).toEqual(chord);
    // 'kink2'(27-A F4)는 별도 모드이며 기본값을 오염시키지 않는다.
    const k2 = vpdSegSource(dir, undefined, 'kink2').observe(t, null as never);
    expect(k2.length).toBe(chord.length);
  });
});
