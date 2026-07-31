// 22회차 Phase 0 — `src/tools/carAnchorUpper.ts` 순수 로직 검증.
// ★ 측정 도구다. 검출 경로에 배선되지 않는다 — 여기서 지키는 것은 **측정이 스스로 틀리지 않는가**와
//   **오염 격리 경계가 실제로 오염을 막는가** 두 가지뿐이다.

import { describe, expect, it } from 'vitest';
import { closeBayAt, degradeCar, groundAxisOf, scoreClosed, type ClosedBay, type RawCar } from '../src/tools/carAnchorUpper.js';
import type { TruthView } from '../src/ground/sceneTruth.js';
import { backprojectToGround, projectToPixel } from '../src/ground/project.js';
import { DEFAULT_BAY_OPTS } from '../src/ground/bayGeometry.js';
import type { GroundModel, PixelQuad } from '../src/ground/types.js';
import type { Vec3 } from '../src/ground/contactTypes.js';

/** 카메라 좌표계에서 y 아래로 5m 인 지면(n·X = d). 투영 관련 필드만 채운다. */
const model: GroundModel = {
  f: 1000,
  d: 5,
  n: [0, 1, 0],
  imgW: 1920,
  imgH: 1080,
  issues: [],
} as unknown as GroundModel;

/** 원점 위 5m 에서 정면(+z)을 보는 카메라. `sceneTruth.projectTruth` 규약대로 pan/tilt 0. */
const view: TruthView = {
  camPos: [0, 5, 0],
  panDeg: 0,
  tiltDeg: 30,
  fovDeg: 40,
  fovAxis: 'vertical',
  imgW: 1920,
  imgH: 1080,
  planeYM: 0,
};

const car = (over: Partial<RawCar> = {}): RawCar => ({
  carNameId: 'c1',
  presetId: 9,
  faceSlot: 9,
  visible: true,
  pos: { x: 0, y: 0, z: 20 },
  rotY: 0,
  prefabId: 1,
  ...over,
});

describe('오염 격리 — 강등 어댑터의 출력에는 오라클이 없다', () => {
  it('VehicleObservation 은 이미지 좌표만 담는다 (faceSlot·presetId·visible·pos·rotY 부재)', () => {
    const o = degradeCar(car(), view);
    const keys = Object.keys(o).sort();
    expect(keys).toEqual(['bboxPx', 'footprintPx', 'obsId', 'plateQuad', 'platePx', 'source'].sort());
    // 직렬화해도 오라클 필드명이 새어나오지 않는다(문자열 수준 봉인).
    const json = JSON.stringify(o);
    for (const forbidden of ['faceSlot', 'presetId', 'visible', 'rotY', 'prefabId']) {
      expect(json).not.toContain(forbidden);
    }
    expect(o.source).toBe('sim-projected');
  });

  it('faceSlot·presetId·visible 을 바꿔도 강등 결과가 비트 동일하다 — 어댑터가 읽지 않는다는 증명', () => {
    const a = degradeCar(car({ presetId: 1, faceSlot: 1, visible: true }), view);
    const b = degradeCar(car({ presetId: 5, faceSlot: 3, visible: false }), view);
    expect(JSON.stringify({ ...b, obsId: a.obsId })).toBe(JSON.stringify(a));
  });

  it('pos 를 바꾸면 강등 결과가 달라진다 — 투영에는 쓰인다(대조군)', () => {
    const a = degradeCar(car(), view);
    const b = degradeCar(car({ pos: { x: 3, y: 0, z: 20 } }), view);
    expect(JSON.stringify(b.footprintPx)).not.toBe(JSON.stringify(a.footprintPx));
  });
});

describe('강등 관측의 기하 정합', () => {
  it('접지 사각형은 4점 quad 이고 축정렬 박스는 그것을 포함한다', () => {
    const o = degradeCar(car(), view);
    expect(o.footprintPx).not.toBeNull();
    expect(o.bboxPx).not.toBeNull();
    const fp = o.footprintPx as PixelQuad;
    const bb = o.bboxPx!;
    for (const p of fp) {
      expect(p.x).toBeGreaterThanOrEqual(bb.x0 - 1e-9);
      expect(p.x).toBeLessThanOrEqual(bb.x1 + 1e-9);
      expect(p.y).toBeGreaterThanOrEqual(bb.y0 - 1e-9);
      expect(p.y).toBeLessThanOrEqual(bb.y1 + 1e-9);
    }
  });

  it('번호판은 차체보다 훨씬 작게 투영된다 (ⓑ-0 의 척도가 뒤바뀌지 않았는가)', () => {
    const o = degradeCar(car(), view);
    const bb = o.bboxPx!;
    expect(o.platePx).toBeGreaterThan(0);
    expect(o.platePx).toBeLessThan(bb.x1 - bb.x0);
  });

  it('멀수록 판이 작다 — 거리 역비례', () => {
    const near = degradeCar(car({ pos: { x: 0, y: 0, z: 15 } }), view).platePx;
    const far = degradeCar(car({ pos: { x: 0, y: 0, z: 30 } }), view).platePx;
    expect(near).toBeGreaterThan(far);
  });
});

describe('ⓑ-2 닫기 — 규격 2.5×5.0 면 1개', () => {
  const head: Vec3 = [0, 0, 1];
  const center: Vec3 = [0, 5, 20];

  it('closeBayAt 이 낸 quad 를 지면으로 되돌리면 규격 치수가 나온다 (면 1개 · 격자 아님)', () => {
    const q = closeBayAt(center, head, model);
    expect(q).not.toBeNull();
    const G = (q as PixelQuad).map((p) => backprojectToGround(p, model));
    expect(G.every((g) => g != null)).toBe(true);
    const edges: number[] = [];
    for (let i = 0; i < 4; i++) {
      const a = G[i] as Vec3;
      const b = G[(i + 1) % 4] as Vec3;
      edges.push(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
    edges.sort((x, y) => x - y);
    expect(edges[0]).toBeCloseTo(DEFAULT_BAY_OPTS.slotWidthM, 6);
    expect(edges[1]).toBeCloseTo(DEFAULT_BAY_OPTS.slotWidthM, 6);
    expect(edges[2]).toBeCloseTo(DEFAULT_BAY_OPTS.slotDepthM, 6);
    expect(edges[3]).toBeCloseTo(DEFAULT_BAY_OPTS.slotDepthM, 6);
  });

  it('groundAxisOf 는 접지 사각형의 장축을 고른다 (차 길이축 = 면 깊이축)', () => {
    // 폭 1.85 × 길이 4.7 인 접지 사각형(지면 y=5, 길이축 = +z).
    const G: [Vec3, Vec3, Vec3, Vec3] = [
      [-0.925, 5, 17.65],
      [-0.925, 5, 22.35],
      [0.925, 5, 22.35],
      [0.925, 5, 17.65],
    ];
    const ax = groundAxisOf(G);
    expect(ax).not.toBeNull();
    expect(ax!.center[2]).toBeCloseTo(20, 9);
    expect(Math.abs(ax!.head[2])).toBeCloseTo(1, 9);
    expect(Math.abs(ax!.head[0])).toBeCloseTo(0, 9);
  });

  it('완전한 접지 사각형 → 닫은 면은 그 사각형과 같은 중심·같은 방위다 (왕복 무손실)', () => {
    const G: [Vec3, Vec3, Vec3, Vec3] = [
      [-0.925, 5, 17.65],
      [-0.925, 5, 22.35],
      [0.925, 5, 22.35],
      [0.925, 5, 17.65],
    ];
    const ax = groundAxisOf(G)!;
    const q = closeBayAt(ax.center, ax.head, model)!;
    const back = q.map((p) => backprojectToGround(p, model) as Vec3);
    const c: Vec3 = [
      back.reduce((s, p) => s + p[0], 0) / 4,
      back.reduce((s, p) => s + p[1], 0) / 4,
      back.reduce((s, p) => s + p[2], 0) / 4,
    ];
    expect(c[0]).toBeCloseTo(ax.center[0], 6);
    expect(c[2]).toBeCloseTo(ax.center[2], 6);
  });

  it('closeBayAt 의 quad 는 projectToPixel 과 정합한다 (투영 경로 일치)', () => {
    const q = closeBayAt(center, head, model)!;
    const corner: Vec3 = [center[0] - 1.25, center[1], center[2] - 2.5];
    const px = projectToPixel(corner, model)!;
    expect(q.some((p) => Math.abs(p.x - px.x) < 1e-9 && Math.abs(p.y - px.y) < 1e-9)).toBe(true);
  });
});

describe('scoreClosed — 회수면은 프리셋 접두 키로 센다', () => {
  const mk = (key: string | null): ClosedBay => ({
    obsId: 'x',
    path: 'seg',
    quad: [
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 0 },
    ],
    bestIoU: key ? 0.9 : 0.1,
    matchedFaceKey: key,
  });

  it('프리셋이 다르면 같은 면 id 라도 별개로 센다 (실행 1회차 버그 회귀 방지)', () => {
    const s = scoreClosed([mk('1:1|r1f1'), mk('1:2|r1f1'), mk(null)], 41);
    expect(s.outputs).toBe(3);
    expect(s.faces).toBe(2);
    expect(s.matched).toBe(2);
    expect(s.precision).toBe(2 / 3);
    expect(s.recall).toBe(2 / 41);
  });

  it('산출 0 이면 정밀도 0 (0 나눗셈 없음)', () => {
    const s = scoreClosed([], 41);
    expect(s.precision).toBe(0);
    expect(s.recall).toBe(0);
  });
});
