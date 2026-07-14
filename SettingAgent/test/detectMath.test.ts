import { describe, it, expect } from 'vitest';
// 순수 결정형 모듈(외부 의존 0) 직접 import — captureCore 패턴.
import {
  fovV,
  fovH,
  vehicleCenterZoomPtz,
  inverseProjectPoint,
  inverseProjectQuad,
  projectBaseToView,
  clampQuadCenterToRect,
  type FovOpts,
  type CenterOpts,
} from '../src/calibrate/detectMath.js';
import type { NormalizedQuad, NormalizedRect } from '../src/domain/types.js';

/**
 * 검증자(qa-tester): detectMath 순수 함수 유닛테스트.
 * 근거: 01_architect_plan.md §04-A + 02_developer_changes.md §02-E/§02-G QA 인계.
 * fovV/fovH 단조·범위, vehicleCenterZoomPtz(tilt/pan 부호 +, top-left rect 규약),
 * inverse/project 왕복 자기일관성, clampQuadCenterToRect(내부/상단/하단/x-only/모양보존).
 */

const FOV_BASE_V = 24.017;
const fovOpts: FovOpts = { fovBaseV: FOV_BASE_V, zoomRef: 1, aspect: 16 / 9 };

describe('fovV / fovH — zoom↑ 시 fov↓ 단조, 값 범위', () => {
  it('fovV(1) === fovBaseV (atan∘tan 항등)', () => {
    expect(fovV(1, fovOpts)).toBeCloseTo(FOV_BASE_V, 6);
  });

  it('fovV 는 zoom↑ 에 대해 단조 감소', () => {
    const z1 = fovV(1, fovOpts);
    const z2 = fovV(2, fovOpts);
    const z4 = fovV(4, fovOpts);
    expect(z2).toBeLessThan(z1);
    expect(z4).toBeLessThan(z2);
    // 물리적 범위: 0 < fov < 180.
    expect(z1).toBeGreaterThan(0);
    expect(z1).toBeLessThan(180);
  });

  it('fovH 는 aspect(>1) 배 넓고, zoom↑ 에 대해 단조 감소', () => {
    // aspect=16/9>1 이므로 수평 FOV 가 수직보다 크다.
    expect(fovH(1, fovOpts)).toBeGreaterThan(fovV(1, fovOpts));
    expect(fovH(2, fovOpts)).toBeLessThan(fovH(1, fovOpts));
  });
});

describe('vehicleCenterZoomPtz — 부호(+/+) · top-left rect 규약 · zoom=base·factor', () => {
  const base = { pan: 20, tilt: 6, zoom: 1.6 };
  const centerOpts = (frontBias: number, zoomFactor: number): CenterOpts => ({
    ...fovOpts,
    frontBias,
    zoomFactor,
  });

  it('중앙 rect(cx=cy=0.5, frontBias=0.5) → pan≈base.pan, tilt≈base.tilt, zoom=base.zoom·factor', () => {
    // top-left 규약: cx=x+w/2, cy=y+h*frontBias. cx=0.5 위해 x=0.4,w=0.2; cy=0.5 위해 y=0.4,h=0.2,frontBias=0.5.
    const rect = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
    const out = vehicleCenterZoomPtz(rect, base, centerOpts(0.5, 3));
    expect(out.pan).toBeCloseTo(base.pan, 9);
    expect(out.tilt).toBeCloseTo(base.tilt, 9);
    expect(out.zoom).toBeCloseTo(base.zoom * 3, 9);
  });

  it('하단 차량(cy>0.5) → tilt 증가(부호 +)', () => {
    // y=0.7,h=0.2,frontBias=0.62 → cy=0.7+0.124=0.824>0.5.
    const rect = { x: 0.4, y: 0.7, w: 0.2, h: 0.2 };
    const out = vehicleCenterZoomPtz(rect, base, centerOpts(0.62, 2));
    expect(out.tilt).toBeGreaterThan(base.tilt);
  });

  it('우측 차량(cx>0.5) → pan 증가(부호 +)', () => {
    // x=0.7,w=0.2 → cx=0.8>0.5.
    const rect = { x: 0.7, y: 0.4, w: 0.2, h: 0.2 };
    const out = vehicleCenterZoomPtz(rect, base, centerOpts(0.5, 2));
    expect(out.pan).toBeGreaterThan(base.pan);
  });

  it('좌측 차량(cx<0.5) → pan 감소 / 상단 차량(cy<0.5) → tilt 감소(대칭)', () => {
    const rect = { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }; // cx=0.15, cy=0.15(frontBias=0.5) 둘 다 <0.5
    const out = vehicleCenterZoomPtz(rect, base, centerOpts(0.5, 2));
    expect(out.pan).toBeLessThan(base.pan);
    expect(out.tilt).toBeLessThan(base.tilt);
  });
});

describe('inverse/project — 왕복 자기일관성(projectBaseToView → inverseProjectPoint = 원점)', () => {
  const base = { pan: 22, tilt: 6.8, zoom: 1.6 };
  const viewPtz = { pan: 40, tilt: 18, zoom: 3.2 };

  it('임의 base 점 → project → inverse ≈ 원점(±1e-9)', () => {
    for (const point of [
      { x: 0.3, y: 0.7 },
      { x: 0.5, y: 0.5 },
      { x: 0.12, y: 0.88 },
      { x: 0.9, y: 0.2 },
    ]) {
      const view = projectBaseToView(point, viewPtz, base, fovOpts);
      const round = inverseProjectPoint(view, viewPtz, base, fovOpts);
      expect(round.x).toBeCloseTo(point.x, 9);
      expect(round.y).toBeCloseTo(point.y, 9);
    }
  });

  it('inverseProjectQuad = 4점 각각 inverseProjectPoint (길이·정합)', () => {
    const viewQuad: NormalizedQuad = [
      { x: 0.45, y: 0.45 },
      { x: 0.55, y: 0.45 },
      { x: 0.55, y: 0.55 },
      { x: 0.45, y: 0.55 },
    ];
    const out = inverseProjectQuad(viewQuad, viewPtz, base, fovOpts);
    expect(out).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      const p = inverseProjectPoint(viewQuad[i], viewPtz, base, fovOpts);
      expect(out[i].x).toBeCloseTo(p.x, 12);
      expect(out[i].y).toBeCloseTo(p.y, 12);
    }
  });

  it('뷰 중앙 quad → base 좌표(부호·스케일 정합: viewPtz 가 base 우측·하단이면 base 좌표도 우측·하단)', () => {
    const viewQuad: NormalizedQuad = [
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 0.5 },
    ];
    const out = inverseProjectQuad(viewQuad, viewPtz, base, fovOpts);
    // 뷰 중심(0.5,0.5) 은 viewPtz 방향점 → base 에서 그 방향(우측·하단, viewPtz.pan/tilt>base) 으로.
    expect(out[0].x).toBeGreaterThan(0.5);
    expect(out[0].y).toBeGreaterThan(0.5);
  });
});

describe('clampQuadCenterToRect — top-left rect, frontBias 처리, 모양 보존', () => {
  const rect: NormalizedRect = { x: 0.3, y: 0.5, w: 0.2, h: 0.3 }; // xMin0.3 xMax0.5 yMin0.5 yMax0.8
  const FRONT_BIAS = 0.62;
  // 중심 (cx,cy) 에 놓인 축정렬 quad(반폭 0.02).
  const quadAt = (cx: number, cy: number): NormalizedQuad => [
    { x: cx - 0.02, y: cy - 0.02 },
    { x: cx + 0.02, y: cy - 0.02 },
    { x: cx + 0.02, y: cy + 0.02 },
    { x: cx - 0.02, y: cy + 0.02 },
  ];
  const centerOf = (q: NormalizedQuad) => ({
    x: q.reduce((s, p) => s + p.x, 0) / 4,
    y: q.reduce((s, p) => s + p.y, 0) / 4,
  });

  it('중심이 이미 rect 안 → 원 참조 그대로(무변경)', () => {
    const q = quadAt(0.4, 0.65);
    const out = clampQuadCenterToRect(q, rect, FRONT_BIAS);
    expect(out).toBe(q); // 참조 동일(복사 아님).
  });

  it('상단 이탈(cy<yMin) → cy 를 rect.y+rect.h·frontBias(전면 근방)로 스냅, x 무변경', () => {
    const q = quadAt(0.4, 0.2); // cx 내부, cy=0.2<0.5
    const out = clampQuadCenterToRect(q, rect, FRONT_BIAS);
    const c = centerOf(out);
    expect(c.y).toBeCloseTo(rect.y + rect.h * FRONT_BIAS, 9); // 0.686
    expect(c.x).toBeCloseTo(0.4, 9); // x 미이탈 → 그대로
  });

  it('하단 이탈(cy>yMax) → rect 하단 경계로 클램프', () => {
    const q = quadAt(0.4, 0.95); // cy=0.95>yMax=0.8
    const out = clampQuadCenterToRect(q, rect, FRONT_BIAS);
    const c = centerOf(out);
    expect(c.y).toBeCloseTo(rect.y + rect.h, 9); // 0.8
  });

  it('x 만 이탈(cx<xMin, cy 내부) → x 만 nearest-edge, y 유지', () => {
    const q = quadAt(0.1, 0.65); // cx=0.1<xMin=0.3, cy 내부
    const out = clampQuadCenterToRect(q, rect, FRONT_BIAS);
    const c = centerOf(out);
    expect(c.x).toBeCloseTo(rect.x, 9); // 0.3
    expect(c.y).toBeCloseTo(0.65, 9); // 유지
  });

  it('클램프 시 4점 평행이동만(모양·크기·각도 보존 — edge 벡터 불변)', () => {
    const q = quadAt(0.1, 0.2); // x·y 둘 다 이탈
    const out = clampQuadCenterToRect(q, rect, FRONT_BIAS);
    // 원 quad 의 각 변 벡터 == 결과 quad 의 각 변 벡터.
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      expect(out[j].x - out[i].x).toBeCloseTo(q[j].x - q[i].x, 12);
      expect(out[j].y - out[i].y).toBeCloseTo(q[j].y - q[i].y, 12);
    }
    // 클램프 후 중심이 rect 안.
    const c = centerOf(out);
    expect(c.x).toBeGreaterThanOrEqual(rect.x);
    expect(c.x).toBeLessThanOrEqual(rect.x + rect.w);
    expect(c.y).toBeGreaterThanOrEqual(rect.y);
    expect(c.y).toBeLessThanOrEqual(rect.y + rect.h);
  });
});
