import { describe, it, expect } from 'vitest';
// 순수 ROI 편집 로직(#1~#3) — DOM/fetch 미참조.
import {
  diffArtifactVsCameras,
  pointInRect,
  pointInQuad,
  hitTestSlots,
  rebuildGlobalIndex,
  removeSlot,
  clamp01Rect,
  resizeRect,
  updateSlotRoi,
  hitTestQuadVertex,
  moveQuadVertex,
  updateSlotFloorRoi,
} from '../web/core.js';
import { validateCoverage } from '../src/setup/GlobalIndexer.js';
import type { ArtifactLike } from '../web/core.js';

/** 3프리셋·소형 산출물(coveredSlotIds 순서 = position 진실). */
function sampleArtifact(): ArtifactLike {
  return {
    createdAt: 'T',
    presets: [
      { camIdx: 1, presetIdx: 1, label: '1:1', coveredSlotIds: ['a', 'b'] },
      { camIdx: 1, presetIdx: 2, label: '1:2', coveredSlotIds: ['c'] },
    ],
    slots: [
      { slotId: 'a', zone: 'z', roiByPreset: { '1:1': { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } } },
      { slotId: 'b', zone: 'z', roiByPreset: { '1:1': { x: 0.5, y: 0.5, w: 0.2, h: 0.2 } } },
      { slotId: 'c', zone: 'z', roiByPreset: { '1:2': { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } } },
    ],
    globalIndex: [
      { globalIdx: 1, slotId: 'a', camIdx: 1, presetIdx: 1 },
      { globalIdx: 2, slotId: 'b', camIdx: 1, presetIdx: 1 },
      { globalIdx: 3, slotId: 'c', camIdx: 1, presetIdx: 2 },
    ],
  };
}

describe('diffArtifactVsCameras (#4 진단)', () => {
  it('산출물 1:3 보유 + cameras 1:1,1:2만 → artifactOnly:[1:3]', () => {
    const artifact = {
      presets: [
        { camIdx: 1, presetIdx: 1 },
        { camIdx: 1, presetIdx: 2 },
        { camIdx: 1, presetIdx: 3 },
      ],
    };
    const cameras = [{ camIdx: 1, presets: [{ presetIdx: 1 }, { presetIdx: 2 }] }];
    const d = diffArtifactVsCameras(artifact, cameras);
    expect(d.artifactOnly).toEqual(['1:3']);
    expect(d.camerasOnly).toEqual([]);
  });
  it('빈 입력 방어', () => {
    expect(diffArtifactVsCameras(null, undefined)).toEqual({ artifactOnly: [], camerasOnly: [] });
  });
  it('cameras 에만 있는 키 → camerasOnly', () => {
    const d = diffArtifactVsCameras(
      { presets: [{ camIdx: 1, presetIdx: 1 }] },
      [{ camIdx: 1, presets: [{ presetIdx: 1 }, { presetIdx: 9 }] }],
    );
    expect(d.camerasOnly).toEqual(['1:9']);
  });
});

describe('pointInRect / pointInQuad (#1 히트테스트)', () => {
  const r = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
  it('내부', () => expect(pointInRect(0.3, 0.3, r)).toBe(true));
  it('경계(좌상)', () => expect(pointInRect(0.2, 0.2, r)).toBe(true));
  it('외부', () => expect(pointInRect(0.7, 0.7, r)).toBe(false));
  it('null rect 방어', () => expect(pointInRect(0.3, 0.3, null)).toBe(false));

  const quad = [
    { x: 0.2, y: 0.8 },
    { x: 0.8, y: 0.8 },
    { x: 0.7, y: 0.4 },
    { x: 0.3, y: 0.4 },
  ] as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
  it('quad 내부', () => expect(pointInQuad(0.5, 0.6, quad)).toBe(true));
  it('quad 외부', () => expect(pointInQuad(0.05, 0.05, quad)).toBe(false));
});

describe('hitTestSlots (#1)', () => {
  const slots = [
    { slotId: 'a', roiByPreset: { '1:1': { x: 0.1, y: 0.1, w: 0.3, h: 0.3 } } },
    { slotId: 'b', roiByPreset: { '1:1': { x: 0.2, y: 0.2, w: 0.3, h: 0.3 } } }, // a 와 겹침
  ];
  it('단일 매칭', () => {
    expect(hitTestSlots({ nx: 0.12, ny: 0.12, slots, key: '1:1' })).toBe('a');
  });
  it('겹친 슬롯 → 배열 끝(상단) 우선', () => {
    expect(hitTestSlots({ nx: 0.25, ny: 0.25, slots, key: '1:1' })).toBe('b');
  });
  it('빈 곳 → null', () => {
    expect(hitTestSlots({ nx: 0.9, ny: 0.9, slots, key: '1:1' })).toBeNull();
  });
  it('vehicle 레이어 off → rect 히트 제외', () => {
    expect(hitTestSlots({ nx: 0.12, ny: 0.12, slots, key: '1:1', layers: { vehicle: false } })).toBeNull();
  });
  it('floor quad 차선 매칭(rect 없을 때)', () => {
    const fslots = [
      {
        slotId: 'f',
        roiByPreset: {},
        floorRoiByPreset: {
          '1:1': [
            { x: 0.2, y: 0.8 },
            { x: 0.8, y: 0.8 },
            { x: 0.7, y: 0.4 },
            { x: 0.3, y: 0.4 },
          ],
        },
      },
    ];
    expect(hitTestSlots({ nx: 0.5, ny: 0.6, slots: fslots, key: '1:1' })).toBe('f');
  });
});

describe('rebuildGlobalIndex (#2 정합 — coveredSlotIds 순서 진실)', () => {
  it('cam→preset→position 순으로 1..N', () => {
    const a = sampleArtifact();
    const gi = rebuildGlobalIndex(a.slots, a.presets);
    expect(gi.map((g) => g.slotId)).toEqual(['a', 'b', 'c']);
    expect(gi.map((g) => g.globalIdx)).toEqual([1, 2, 3]);
  });
  it('coveredSlotIds 순서가 진실(slotId sN 파싱 아님)', () => {
    const presets = [{ camIdx: 1, presetIdx: 1, label: '1:1', coveredSlotIds: ['b', 'a'] }];
    const slots = [
      { slotId: 'a', zone: 'z', roiByPreset: {} },
      { slotId: 'b', zone: 'z', roiByPreset: {} },
    ];
    const gi = rebuildGlobalIndex(slots, presets);
    expect(gi.map((g) => g.slotId)).toEqual(['b', 'a']);
  });
});

describe('removeSlot (#2 삭제)', () => {
  it('삭제 후 coverage ok, globalIdx 연속, coveredSlotIds 제거, 타 슬롯 ROI 불변', () => {
    const a = sampleArtifact();
    const next = removeSlot(a, 'b');
    expect(next.slots!.map((s) => s.slotId)).toEqual(['a', 'c']);
    const cov = validateCoverage(next.globalIndex as never, next.slots as never);
    expect(cov.ok).toBe(true);
    expect(next.globalIndex!.map((g) => g.globalIdx)).toEqual([1, 2]);
    expect(next.presets![0].coveredSlotIds).toEqual(['a']); // b 제거됨
    expect(next.slots![0].roiByPreset!['1:1']).toEqual(a.slots![0].roiByPreset!['1:1']); // a 불변
    // 원본 불변(불변 갱신).
    expect(a.slots!.length).toBe(3);
  });
});

describe('clamp01Rect / resizeRect (#3 크기 조정)', () => {
  it('se 핸들 +δ → w/h 증가', () => {
    const r = resizeRect({ x: 0.2, y: 0.2, w: 0.2, h: 0.2 }, 'se', 0.1, 0.1);
    expect(r.w).toBeCloseTo(0.3, 6);
    expect(r.h).toBeCloseTo(0.3, 6);
    expect(r.x).toBeCloseTo(0.2, 6);
  });
  it('경계 클램프(1 초과 안 됨)', () => {
    const r = resizeRect({ x: 0.8, y: 0.8, w: 0.15, h: 0.15 }, 'se', 0.5, 0.5);
    expect(r.x + r.w).toBeLessThanOrEqual(1);
    expect(r.y + r.h).toBeLessThanOrEqual(1);
  });
  it('음수 폭 방지(붕괴 → 최소폭, 좌우 뒤집힘 정규화)', () => {
    const r = resizeRect({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, 'se', -0.5, -0.5);
    expect(r.w).toBeGreaterThan(0);
    expect(r.h).toBeGreaterThan(0);
  });
  it('clamp01Rect 음수 좌표 → 0', () => {
    const r = clamp01Rect({ x: -0.1, y: -0.2, w: 0.3, h: 0.3 });
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });
});

describe('resizeRect 변(edge) 드래그 n/s/w/e (설계 (f))', () => {
  // 기준 rect: left=0.2, top=0.2, right=0.6, bottom=0.6
  const base = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 } as const;

  it("'n'(상변) 하향 이동 → y·h 변화, x·w 불변", () => {
    const r = resizeRect(base, 'n', 0, 0.1); // top 0.2→0.3
    expect(r.y).toBeCloseTo(0.3, 6);
    expect(r.h).toBeCloseTo(0.3, 6);
    expect(r.x).toBeCloseTo(0.2, 6); // 직교축(x) 불변
    expect(r.w).toBeCloseTo(0.4, 6); // 직교축(w) 불변
  });

  it("'n'(상변) 상향 이동 → 높이 증가", () => {
    const r = resizeRect(base, 'n', 0, -0.1); // top 0.2→0.1
    expect(r.y).toBeCloseTo(0.1, 6);
    expect(r.h).toBeCloseTo(0.5, 6);
    expect(r.x).toBeCloseTo(0.2, 6);
    expect(r.w).toBeCloseTo(0.4, 6);
  });

  it("'s'(하변) 하향 이동 → h 변화, x·y·w 불변", () => {
    const r = resizeRect(base, 's', 0, 0.1); // bottom 0.6→0.7
    expect(r.y).toBeCloseTo(0.2, 6); // top 고정
    expect(r.h).toBeCloseTo(0.5, 6);
    expect(r.x).toBeCloseTo(0.2, 6);
    expect(r.w).toBeCloseTo(0.4, 6);
  });

  it("'w'(좌변) 좌향 이동 → x·w 변화, y·h 불변", () => {
    const r = resizeRect(base, 'w', -0.1, 0); // left 0.2→0.1
    expect(r.x).toBeCloseTo(0.1, 6);
    expect(r.w).toBeCloseTo(0.5, 6);
    expect(r.y).toBeCloseTo(0.2, 6); // 직교축(y) 불변
    expect(r.h).toBeCloseTo(0.4, 6); // 직교축(h) 불변
  });

  it("'e'(우변) 우향 이동 → w 변화, x·y·h 불변", () => {
    const r = resizeRect(base, 'e', 0.1, 0); // right 0.6→0.7
    expect(r.x).toBeCloseTo(0.2, 6); // left 고정
    expect(r.w).toBeCloseTo(0.5, 6);
    expect(r.y).toBeCloseTo(0.2, 6);
    expect(r.h).toBeCloseTo(0.4, 6);
  });

  it("'ndy' 는 상/하변에만, 'ndx' 는 좌/우변에만 영향(직교 델타 무시)", () => {
    // n 변에 ndx 를 줘도 x·w 는 변하지 않아야 함(top 만 이동).
    const rn = resizeRect(base, 'n', 0.3, 0.1);
    expect(rn.x).toBeCloseTo(0.2, 6);
    expect(rn.w).toBeCloseTo(0.4, 6);
    // e 변에 ndy 를 줘도 y·h 는 변하지 않아야 함(right 만 이동).
    const re = resizeRect(base, 'e', 0.1, 0.3);
    expect(re.y).toBeCloseTo(0.2, 6);
    expect(re.h).toBeCloseTo(0.4, 6);
  });

  it("'e' 변을 밖으로 밀면 x+w ≤ 1 로 클램프", () => {
    const r = resizeRect({ x: 0.9, y: 0.9, w: 0.05, h: 0.05 }, 'e', 0.5, 0);
    expect(r.x + r.w).toBeLessThanOrEqual(1);
    expect(r.w).toBeGreaterThan(0);
  });

  it("'w' 변을 음수 너머로 밀면 x ≥ 0 로 클램프, 최소폭 유지", () => {
    const r = resizeRect({ x: 0.1, y: 0.4, w: 0.2, h: 0.2 }, 'w', -0.5, 0);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.w).toBeGreaterThan(0);
  });

  it("'n' 변을 하변 너머로 밀면 min/abs 정규화로 rect 유지(w,h>0)", () => {
    // top 0.2→0.7 이 bottom 0.6 을 넘어감 → 상/하 스왑, y≈0.6
    const r = resizeRect({ x: 0.2, y: 0.2, w: 0.4, h: 0.4 }, 'n', 0, 0.5);
    expect(r.w).toBeGreaterThan(0);
    expect(r.h).toBeGreaterThan(0);
    expect(r.y).toBeCloseTo(0.6, 6);
    expect(r.x).toBeCloseTo(0.2, 6);
    expect(r.w).toBeCloseTo(0.4, 6);
  });

  it("'e' 변을 좌변 너머로 밀면 좌우 뒤집힘 정규화(w>0)", () => {
    // right 0.6→0.1 이 left 0.2 아래로 → 좌우 스왑, x≈0.1
    const r = resizeRect({ x: 0.2, y: 0.2, w: 0.4, h: 0.4 }, 'e', -0.5, 0);
    expect(r.w).toBeGreaterThan(0);
    expect(r.x).toBeCloseTo(0.1, 6);
    expect(r.y).toBeCloseTo(0.2, 6); // y·h 불변
    expect(r.h).toBeCloseTo(0.4, 6);
  });
});

describe('updateSlotRoi (#3)', () => {
  it('대상 slot roiByPreset[key] 만 교체, 타 슬롯 불변', () => {
    const a = sampleArtifact();
    const next = updateSlotRoi(a, 'a', '1:1', { x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(next.slots![0].roiByPreset!['1:1']).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(next.slots![1].roiByPreset!['1:1']).toEqual(a.slots![1].roiByPreset!['1:1']);
    // globalIndex 불변(slot 집합 불변).
    expect(next.globalIndex).toBe(a.globalIndex);
  });
});

// ===== floor ROI(4점 quad) 정점 개별 드래그 편집 (설계 §6) =====
// quad 는 4×{x,y}. 공용 quad(설계 §6 공용값).
type Pt = { x: number; y: number };
type Quad = [Pt, Pt, Pt, Pt];
const makeQuad = (): Quad => [
  { x: 0.2, y: 0.2 },
  { x: 0.8, y: 0.2 },
  { x: 0.8, y: 0.8 },
  { x: 0.2, y: 0.8 },
];

/** floor quad 를 보유한 산출물(2슬롯: 대상 f1, 비교 f2 + 차량 roi 병존). */
function floorArtifact(): ArtifactLike {
  return {
    createdAt: 'T',
    presets: [{ camIdx: 1, presetIdx: 1, label: '1:1', coveredSlotIds: ['f1', 'f2'] }],
    slots: [
      {
        slotId: 'f1',
        zone: 'z',
        roiByPreset: { '1:1': { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
        floorRoiByPreset: {
          '1:1': makeQuad(),
          '1:2': [
            { x: 0, y: 0 },
            { x: 0.1, y: 0 },
            { x: 0.1, y: 0.1 },
            { x: 0, y: 0.1 },
          ],
        },
      },
      {
        slotId: 'f2',
        zone: 'z',
        roiByPreset: { '1:1': { x: 0.5, y: 0.5, w: 0.2, h: 0.2 } },
        floorRoiByPreset: { '1:1': makeQuad() },
      },
    ],
    globalIndex: [
      { globalIdx: 1, slotId: 'f1', camIdx: 1, presetIdx: 1 },
      { globalIdx: 2, slotId: 'f2', camIdx: 1, presetIdx: 1 },
    ],
  };
}

describe('moveQuadVertex (§6 정점 개별 이동)', () => {
  it('index0 (+0.1,+0.1) → quad[0]={0.3,0.3}, 나머지 3정점 불변', () => {
    const q = makeQuad();
    const n = moveQuadVertex(q, 0, 0.1, 0.1);
    expect(n[0].x).toBeCloseTo(0.3, 6);
    expect(n[0].y).toBeCloseTo(0.3, 6);
    expect(n[1]).toEqual({ x: 0.8, y: 0.2 });
    expect(n[2]).toEqual({ x: 0.8, y: 0.8 });
    expect(n[3]).toEqual({ x: 0.2, y: 0.8 });
  });

  it('index2 (-0.1,0) → quad[2].x=0.7, quad[2].y 불변, 나머지 불변', () => {
    const q = makeQuad();
    const n = moveQuadVertex(q, 2, -0.1, 0);
    expect(n[2].x).toBeCloseTo(0.7, 6);
    expect(n[2].y).toBeCloseTo(0.8, 6);
    expect(n[0]).toEqual(q[0]);
    expect(n[1]).toEqual(q[1]);
    expect(n[3]).toEqual(q[3]);
  });

  it('각 index(0..3) 이동 시 해당 정점만 변하고 나머지 3정점 값 불변', () => {
    for (let idx = 0; idx < 4; idx++) {
      const q = makeQuad();
      const n = moveQuadVertex(q, idx, 0.05, -0.03);
      for (let i = 0; i < 4; i++) {
        if (i === idx) {
          expect(n[i].x).toBeCloseTo(q[i].x + 0.05, 6);
          expect(n[i].y).toBeCloseTo(q[i].y - 0.03, 6);
        } else {
          // 나머지 정점: 값 불변 + 동일 참조(불변 복사).
          expect(n[i]).toBe(q[i]);
        }
      }
    }
  });

  it('clamp 상한: index1 (+0.5,0) → x=1(clamp), 미초과', () => {
    const n = moveQuadVertex(makeQuad(), 1, 0.5, 0);
    expect(n[1].x).toBe(1);
    expect(n[1].y).toBeCloseTo(0.2, 6);
  });

  it('clamp 하한: index0 (-0.5,-0.5) → x=0,y=0', () => {
    const n = moveQuadVertex(makeQuad(), 0, -0.5, -0.5);
    expect(n[0].x).toBe(0);
    expect(n[0].y).toBe(0);
  });

  it('불변성: 반환 배열 !== 입력 배열, 입력 quad 배열·정점 객체 원본 값 미변형', () => {
    const q = makeQuad();
    const snap = JSON.parse(JSON.stringify(q));
    const n = moveQuadVertex(q, 0, 0.1, 0.1);
    expect(n).not.toBe(q); // 새 배열
    expect(q).toEqual(snap); // 원본 값 불변
    // 이동된 정점은 새 객체(원본 객체 미변형).
    expect(n[0]).not.toBe(q[0]);
  });

  it('방어: index 범위 밖(4) → 원본 얕은복사(값 불변, 새 배열)', () => {
    const q = makeQuad();
    const n = moveQuadVertex(q, 4, 0.1, 0.1);
    expect(n).toEqual(q);
    expect(n).not.toBe(q); // slice 얕은복사
  });
});

describe('hitTestQuadVertex (§6 정점 히트테스트)', () => {
  const q = makeQuad();
  it('정확히 정점0 위(0.2,0.2, tol=0.02) → 0', () => {
    expect(hitTestQuadVertex(q, 0.2, 0.2, 0.02, 0.02)).toBe(0);
  });
  it('tol 내 근접(0.205,0.205) → 0(히트)', () => {
    expect(hitTestQuadVertex(q, 0.205, 0.205, 0.02, 0.02)).toBe(0);
  });
  it('tol 밖(0.3,0.3) → null(미스)', () => {
    expect(hitTestQuadVertex(q, 0.3, 0.3, 0.02, 0.02)).toBeNull();
  });
  it('중앙(0.5,0.5) → null', () => {
    expect(hitTestQuadVertex(q, 0.5, 0.5, 0.02, 0.02)).toBeNull();
  });
  it('마지막 정점3(0.2,0.8) 히트 → 3', () => {
    expect(hitTestQuadVertex(q, 0.2, 0.8, 0.02, 0.02)).toBe(3);
  });
  it('tol 경계값(정확히 |dx|=tol) → 히트(<=)', () => {
    // 정점1=(0.8,0.2), nx=0.82 → |dx|=0.02=tolX 경계, ny=0.2.
    expect(hitTestQuadVertex(q, 0.82, 0.2, 0.02, 0.02)).toBe(1);
  });
  it('tolX/tolY 비대칭(tolX=0.05,tolY=0.001): x 통과·y 실패 → null', () => {
    // 정점0=(0.2,0.2). nx=0.24(|dx|=0.04<=0.05 통과), ny=0.21(|dy|=0.01>0.001 실패).
    expect(hitTestQuadVertex(q, 0.24, 0.21, 0.05, 0.001)).toBeNull();
  });
  it('첫 매칭 우선: tol 넓어 여러 정점 후보여도 index 오름차순 첫 정점', () => {
    // tol 을 크게(0.7) 주면 0..3 모두 근접이나 첫 i=0 반환.
    expect(hitTestQuadVertex(q, 0.5, 0.5, 0.7, 0.7)).toBe(0);
  });
  it('방어: quad=null → null', () => {
    expect(hitTestQuadVertex(null, 0.2, 0.2, 0.02, 0.02)).toBeNull();
  });
  it('N정점 일반화: 삼각형(3점)도 히트 지원(가변 다각형)', () => {
    const tri = [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.5, y: 0.8 }];
    expect(hitTestQuadVertex(tri as never, 0.2, 0.2, 0.02, 0.02)).toBe(0);
    expect(hitTestQuadVertex(tri as never, 0.5, 0.8, 0.02, 0.02)).toBe(2);
  });
  it('방어: 길이<3 → null', () => {
    const seg = [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }];
    expect(hitTestQuadVertex(seg as never, 0.2, 0.2, 0.02, 0.02)).toBeNull();
  });
});

describe('updateSlotFloorRoi (§6 불변 교체)', () => {
  const newQuad: Quad = [
    { x: 0.25, y: 0.25 },
    { x: 0.8, y: 0.2 },
    { x: 0.8, y: 0.8 },
    { x: 0.2, y: 0.8 },
  ];

  it('대상 slot floorRoiByPreset[1:1] 만 교체, 다른 key(1:2) 불변', () => {
    const a = floorArtifact();
    const before12 = a.slots![0].floorRoiByPreset!['1:2'];
    const next = updateSlotFloorRoi(a, 'f1', '1:1', newQuad);
    expect(next.slots![0].floorRoiByPreset!['1:1']).toEqual(newQuad);
    // 다른 key 는 동일 참조로 유지.
    expect(next.slots![0].floorRoiByPreset!['1:2']).toBe(before12);
  });

  it('다른 slot(f2) floor 불변, slots 길이 불변', () => {
    const a = floorArtifact();
    const next = updateSlotFloorRoi(a, 'f1', '1:1', newQuad);
    expect(next.slots![1]).toBe(a.slots![1]); // f2 미교체(동일 참조)
    expect(next.slots!.length).toBe(a.slots!.length);
  });

  it('globalIndex 참조 동일(slot 집합 불변)', () => {
    const a = floorArtifact();
    const next = updateSlotFloorRoi(a, 'f1', '1:1', newQuad);
    expect(next.globalIndex).toBe(a.globalIndex);
  });

  it('대상 slot 의 차량 roiByPreset 불변(floor 만 교체)', () => {
    const a = floorArtifact();
    const next = updateSlotFloorRoi(a, 'f1', '1:1', newQuad);
    expect(next.slots![0].roiByPreset).toBe(a.slots![0].roiByPreset);
  });

  it('원본 artifact 미변형(입력 slot 의 quad 원본 값 유지)', () => {
    const a = floorArtifact();
    const snap = JSON.parse(JSON.stringify(a.slots![0].floorRoiByPreset!['1:1']));
    updateSlotFloorRoi(a, 'f1', '1:1', newQuad);
    expect(a.slots![0].floorRoiByPreset!['1:1']).toEqual(snap);
    expect(a).not.toBe(undefined);
  });

  it('경계면 shape: moveQuadVertex 결과(4×{x,y})가 updateSlotFloorRoi 저장 shape과 일치', () => {
    // app.js mousemove 경로 재현: moveQuadVertex → updateSlotFloorRoi.
    const a = floorArtifact();
    const cur = a.slots![0].floorRoiByPreset!['1:1'] as Quad;
    const moved = moveQuadVertex(cur, 1, 0.05, 0.05);
    const next = updateSlotFloorRoi(a, 'f1', '1:1', moved);
    const stored = next.slots![0].floorRoiByPreset!['1:1'] as Quad;
    expect(stored).toBe(moved); // 그대로 저장(교체)
    expect(stored.length).toBe(4);
    for (const p of stored) {
      expect(typeof p.x).toBe('number');
      expect(typeof p.y).toBe('number');
    }
  });
});
