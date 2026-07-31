// 22회차 Phase 0 — `src/tools/anchorCloseUpper.ts` 순수 로직 검증.
// ★ 측정 도구다. 검출 경로에 배선되지 않는다 — 여기서 지키는 것은 **측정이 스스로 틀리지 않는가**뿐이다.

import { describe, expect, it } from 'vitest';
import { gateSweep, resolveExclusivity, rowPointPx, type AnchorCand } from '../src/tools/anchorCloseUpper.js';
import { auditQuadAt } from '../src/tools/sepAudit.js';
import type { GroundModel, PixelQuad } from '../src/ground/types.js';
// `RowFrame` 은 `types.ts` 가 아니라 `bayGrid.ts:25` 에서 export 된다.
import type { RowFrame } from '../src/ground/bayGrid.js';

/** 카메라 좌표계에서 y 아래로 5m 인 지면(n·X = d). `projectToPixel`/`backprojectToGround` 가 쓰는 필드만 채운다. */
const model: GroundModel = {
  f: 1000,
  d: 5,
  n: [0, 1, 0],
  imgW: 1920,
  imgH: 1080,
  issues: [],
} as unknown as GroundModel;

// 지면(y=5) 위의 행 좌표계 — u 는 가로, v 는 광축 방향 깊이. 광축을 지나지 않으므로 quad 가 퇴화하지 않는다.
const fr: RowFrame = { origin: [0, 5, 20], u: [1, 0, 0], v: [0, 0, 1] };

const quadAt = (x: number, y: number, w = 10, h = 10): PixelQuad =>
  [
    { x, y: y + h },
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
  ] as PixelQuad;

const cand = (over: Partial<AnchorCand>): AnchorCand => ({
  key: 't',
  rowIdx: 1,
  sepIdx: 0,
  dir: 'right',
  flipV: false,
  aAnchorM: 0,
  aLoM: 0,
  aPredM: 2.5,
  quad: quadAt(0, 0),
  predHit: 0,
  predChamferPx: 0,
  anchorHit: 0,
  near: 0,
  far: 0,
  side: 0,
  score: 0,
  sepSpanPx: 0,
  depthM: 20,
  bestIoU: 0,
  matchedFaceKey: null,
  ...over,
});

describe('rowPointPx — auditQuadAt 과 같은 좌표식인가(재발명 아님을 코드로 고정)', () => {
  it('네 코너가 auditQuadAt 결과와 같은 점집합이다(flipV 양쪽)', () => {
    for (const flipV of [false, true]) {
      const q = auditQuadAt(fr, model, 1.25, 2.5, 5, flipV);
      expect(q).not.toBeNull();
      const mine = [
        rowPointPx(fr, model, 1.25, 0, flipV),
        rowPointPx(fr, model, 1.25, 5, flipV),
        rowPointPx(fr, model, 3.75, 5, flipV),
        rowPointPx(fr, model, 3.75, 0, flipV),
      ];
      expect(mine.every((p) => p != null)).toBe(true);
      for (const c of q as PixelQuad)
        expect(mine.some((p) => p != null && Math.abs(p.x - c.x) < 1e-9 && Math.abs(p.y - c.y) < 1e-9)).toBe(true);
    }
  });

  it('flipV 는 v 축 부호만 뒤집는다(깊이 0 은 두 방향이 같은 점)', () => {
    expect(rowPointPx(fr, model, 2, 0, false)).toEqual(rowPointPx(fr, model, 2, 0, true));
    expect(rowPointPx(fr, model, 2, 3, false)).not.toEqual(rowPointPx(fr, model, 2, 3, true));
  });
});

describe('resolveExclusivity — 서열과 접기', () => {
  it('완전히 겹치는 후보 중 예측변 지지가 높은 하나만 남는다', () => {
    const kept = resolveExclusivity(
      [cand({ predHit: 0.2, sepSpanPx: 9 }), cand({ predHit: 0.9, sepSpanPx: 1 }), cand({ predHit: 0.5, sepSpanPx: 5 })],
      0.5,
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].predHit).toBe(0.9);
  });

  it('겹치지 않는 후보는 서로를 밀어내지 못한다(오검출이 배타성으로 사라지지 않는다)', () => {
    const kept = resolveExclusivity([cand({ quad: quadAt(0, 0) }), cand({ quad: quadAt(500, 500) })], 0.5);
    expect(kept).toHaveLength(2);
  });

  it('동점이면 sepSpanPx desc → 입력 인덱스 asc 로 결정론이다(난수 0)', () => {
    const a = cand({ predHit: 0.5, sepSpanPx: 3, sepIdx: 10 });
    const b = cand({ predHit: 0.5, sepSpanPx: 7, sepIdx: 20 });
    expect(resolveExclusivity([a, b], 0.5)[0].sepIdx).toBe(20);
    expect(resolveExclusivity([cand({ predHit: 0.5, sepIdx: 1 }), cand({ predHit: 0.5, sepIdx: 2 })], 0.5)[0].sepIdx).toBe(1);
  });
});

describe('gateSweep — 문턱별 성적', () => {
  const cs = [
    cand({ predHit: 0.9, quad: quadAt(0, 0), matchedFaceKey: 'r1f1' }),
    cand({ predHit: 0.9, quad: quadAt(200, 0), matchedFaceKey: 'r1f2' }),
    cand({ predHit: 0.1, quad: quadAt(400, 0), matchedFaceKey: 'r1f3' }),
    cand({ predHit: 0.1, quad: quadAt(600, 0) }),
  ];

  it('τ=0 은 전부 생존하고 참/잡음 수가 라벨과 맞는다', () => {
    const [r] = gateSweep(cs, [0], 10, 0.5);
    expect(r).toMatchObject({ survivors: 4, survTrue: 3, survNoise: 1, survivalRate: 1, kept: 4 });
    expect(r.recallFaces).toBe(3);
    expect(r.recall).toBe(0.3);
    expect(r.precision).toBe(0.75);
  });

  it('τ 를 올리면 잡음과 함께 참도 죽는다 — 재현율이 따라 내려간다', () => {
    const [r] = gateSweep(cs, [0.5], 10, 0.5);
    expect(r).toMatchObject({ survivors: 2, survTrue: 2, survNoise: 0, kept: 2, recallFaces: 2 });
    expect(r.precision).toBe(1);
    expect(r.recall).toBe(0.2);
  });

  it('같은 면을 가리키는 후보 여러 개는 재현율을 1면으로만 센다', () => {
    const dup = [cand({ predHit: 1, quad: quadAt(0, 0), matchedFaceKey: 'r1f1' }), cand({ predHit: 1, quad: quadAt(900, 0), matchedFaceKey: 'r1f1' })];
    const [r] = gateSweep(dup, [0], 10, 0.5);
    expect(r.kept).toBe(2);
    expect(r.recallFaces).toBe(1);
    expect(r.precision).toBe(0.5);
  });

  it('후보가 0개면 0으로 나누지 않는다', () => {
    const [r] = gateSweep([], [0], 41, 0.5);
    expect(r).toMatchObject({ survivors: 0, survivalRate: 0, kept: 0, recall: 0, precision: 0 });
  });
});
