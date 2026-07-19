import { describe, it, expect } from 'vitest';
import { lowerFrontAnchor, expandDiscoveryTargets } from '../src/calibrate/plateDiscoveryWriter.js';
import { projectToPixel, projectPointAtHeight, projectCuboidPixels, frontFaceCenterPx } from '../src/ground/project.js';
import type { GroundModel } from '../src/ground/types.js';
import type { Vec3 } from '../src/ground/contactTypes.js';
import type { NormalizedPoint } from '../src/domain/types.js';
import type { SlotSetupView } from '../src/capture/types.js';

/**
 * 검증자(qa-tester): 앵커 하향 lowerFrontAnchor(설계서 §2). 순수함수 — 외부 의존 0.
 * - V-7: 합성 사다리꼴 roi + frontCenter → 결과가 앞 edge 중점 B(h=0)와 frontCenter F(h=0.75) 사이,
 *        t=plateH/(H_CONST/2)=0.4/0.75≈0.5333 선형보간 수치 일치. roi 퇴화 → frontCenter 폴백.
 * - V-8: §2-1 "픽셀은 h 에 선형 → 정규화보간이 재투영과 항등" 주장 봉인.
 *        project.ts 실헬퍼(projectToPixel/projectPointAtHeight/projectCuboidPixels/frontFaceCenterPx)로
 *        합성 GroundModel 을 세워 roi·frontCenter 를 만들고, lowerFrontAnchor 결과를 h=0.4 재투영과 대조.
 */

const PLATE_H = 0.4;
const H_CONST = 1.5;
const T = PLATE_H / (H_CONST / 2); // 0.5333…

describe('lowerFrontAnchor · V-7 선형보간 + 폴백', () => {
  // 사다리꼴 roi: 코너 0,1 = 앞 edge(하단 y 큼), 2,3 = 뒤 edge(상단 y 작음). BOTTOM_EDGES 규약 [0,1]이 앞.
  const roi: NormalizedPoint[] = [
    { x: 0.30, y: 0.80 }, // 0 앞좌
    { x: 0.70, y: 0.80 }, // 1 앞우
    { x: 0.62, y: 0.60 }, // 2 뒤우
    { x: 0.38, y: 0.60 }, // 3 뒤좌
  ];
  const B = { x: 0.5, y: 0.8 }; // 앞 edge 중점(h=0)
  const F: NormalizedPoint = { x: 0.5, y: 0.65 }; // frontCenter(h=0.75 등가) — B 보다 위(y 작음)

  it('결과가 앞 edge 중점보다 위(y 작음)·frontCenter 보다 아래(y 큼), t≈0.5333 보간 수치 일치', () => {
    const r = lowerFrontAnchor(roi, F);
    // 아래(큰 y)=B(0.8) 위(작은 y)=F(0.65). 번호판 h=0.4 는 그 사이(F<r<B).
    expect(r.y).toBeGreaterThan(F.y); // frontCenter 보다 아래
    expect(r.y).toBeLessThan(B.y); // 앞 edge 중점보다 위
    // 정확한 선형보간값: B + (F-B)·t.
    expect(r.x).toBeCloseTo(B.x + (F.x - B.x) * T, 12);
    expect(r.y).toBeCloseTo(B.y + (F.y - B.y) * T, 12); // 0.8 + (-0.15)·0.5333 = 0.72
    expect(r.y).toBeCloseTo(0.72, 12);
  });

  it('plateH 인자 override 반영(0 → B 그대로, 0.75 → F 그대로)', () => {
    expect(lowerFrontAnchor(roi, F, 0)).toEqual(B); // h=0 → 앞 edge 중점
    const at075 = lowerFrontAnchor(roi, F, 0.75); // t=1 → F
    expect(at075.x).toBeCloseTo(F.x, 12);
    expect(at075.y).toBeCloseTo(F.y, 12);
  });

  it('앞 edge 판정: y평균 최대 edge 를 앞으로(회전된 코너순서도 기하 판정)', () => {
    // 코너를 회전시켜 앞 edge 를 [2,3] 위치로 옮겨도 동일 B 를 잡아야 한다.
    const rot: NormalizedPoint[] = [roi[2], roi[3], roi[0], roi[1]];
    const r = lowerFrontAnchor(rot, F);
    expect(r.y).toBeCloseTo(0.72, 12); // 동일 앞 edge(y=0.8) 기준 → 같은 결과
  });

  it('폴백: roi 길이≠4 → frontCenter 그대로', () => {
    expect(lowerFrontAnchor([{ x: 0.1, y: 0.1 }], F)).toEqual(F);
    expect(lowerFrontAnchor([], F)).toEqual(F);
  });

  it('폴백: 비유한 좌표 → frontCenter 그대로(throw 금지)', () => {
    const bad = [{ x: 0.3, y: 0.8 }, { x: NaN, y: 0.8 }, { x: 0.6, y: 0.6 }, { x: 0.4, y: 0.6 }];
    expect(lowerFrontAnchor(bad, F)).toEqual(F);
  });
});

/**
 * V-8 항등 봉인. 합성 GroundModel 로 4 바닥코너를 세우고:
 *   roi        = 바닥코너 픽셀(h=0) 정규화
 *   frontCenter= projectCuboidPixels(h=H_CONST) → frontFaceCenterPx (Finalizer 산출식 그대로) 정규화
 *   기대치     = 앞 두 코너를 h=PLATE_H 로 직접 재투영한 픽셀의 중점(정규화)
 * 그리고 lowerFrontAnchor(roi, frontCenter) 가 기대치와 일치함을 본다.
 *
 * ★ 주의(정직 봉인): projectPointAtHeight 는 **원근분모(n_z≠0) 때문에 h 에 엄밀히 선형이 아니다**
 *   (측정: 25° 틸트에서 정규화 편차 ≈1.4e-3). 설계 §2-1 의 "항등" 주장은 **선형투영 영역에서만 엄밀**하다.
 *   → 본 봉인은 n_z=0(광축이 지면과 평행, 즉 픽셀이 h 에 선형)인 GroundModel 에서 항등을 <1e-9 로 못박고,
 *     이어서 틸트 모델에서 편차가 sub-pixel(≈1.4e-3, 튜닝노브 PLATE_H 자체의 거칠기보다 작음)임을 정량 봉인한다.
 */
describe('lowerFrontAnchor · V-8 재투영 항등(project.ts 실헬퍼)', () => {
  function makeGround(tiltDeg: number): GroundModel {
    const t = (tiltDeg * Math.PI) / 180;
    // n = 하향 단위법선(카메라좌표 x→우,y→하,z→전방). tilt=0 → n=(0,1,0) → 픽셀이 h 에 엄밀 선형.
    const n: [number, number, number] = [0, Math.cos(t), Math.sin(t)];
    return {
      camIdx: 1, presetIdx: 1, imgW: 1920, imgH: 1080, zoom: 1, f: 1400, n, d: 8,
      tiltDeg, ptzTiltDeg: null, tiltErrDeg: null, slotBearingDeg: null, bearingDevDeg: null,
      dDevRel: null, depthEdgePx: 0, metricErr: 0, conf: 1, source: 'file', issues: [],
    };
  }
  // 지면 평면 n·X=d 위의 코너 생성(X0,X2 지정 → X1 해). 앞(근접)=작은 z.
  function onPlane(g: GroundModel, X0: number, X2: number): Vec3 {
    const [n0, n1, n2] = g.n;
    return [X0, (g.d - n0 * X0 - n2 * X2) / n1, X2];
  }
  const norm = (p: { x: number; y: number }, g: GroundModel): NormalizedPoint => ({ x: p.x / g.imgW, y: p.y / g.imgH });

  function scenario(g: GroundModel) {
    const Ga = onPlane(g, -2, 12); // 앞좌(z=12 근접)
    const Gb = onPlane(g, 2, 12); // 앞우
    const Gc = onPlane(g, 2.5, 20); // 뒤우(z=20)
    const Gd = onPlane(g, -2.5, 20); // 뒤좌
    const floor: Vec3[] = [Ga, Gb, Gc, Gd];
    const roi = floor.map((X) => norm(projectToPixel(X, g)!, g));
    const cub = projectCuboidPixels(floor, H_CONST, g)!;
    const F = norm(frontFaceCenterPx(cub)!, g);
    // 기대치: 앞 두 코너(Ga,Gb) h=PLATE_H 재투영 픽셀 중점.
    const p4a = projectPointAtHeight(Ga, PLATE_H, g)!;
    const p4b = projectPointAtHeight(Gb, PLATE_H, g)!;
    const expected = norm({ x: (p4a.x + p4b.x) / 2, y: (p4a.y + p4b.y) / 2 }, g);
    return { roi, F, expected };
  }

  it('선형투영 영역(n_z=0): lowerFrontAnchor == h=0.4 재투영 (오차 < 1e-9)', () => {
    const g = makeGround(0);
    const { roi, F, expected } = scenario(g);
    const r = lowerFrontAnchor(roi, F, PLATE_H);
    expect(Math.abs(r.x - expected.x)).toBeLessThan(1e-9);
    expect(Math.abs(r.y - expected.y)).toBeLessThan(1e-9);
  });

  it('틸트 모델(n_z≠0): 항등이 sub-pixel 근사(편차 0 초과 & < 3e-3) — §2-1 근사한계 정량 봉인', () => {
    const g = makeGround(25);
    const { roi, F, expected } = scenario(g);
    const r = lowerFrontAnchor(roi, F, PLATE_H);
    const dev = Math.max(Math.abs(r.x - expected.x), Math.abs(r.y - expected.y));
    expect(dev).toBeGreaterThan(0); // 엄밀 항등 아님(원근 비선형)
    expect(dev).toBeLessThan(3e-3); // 그러나 sub-pixel(≈1.4e-3) — 실용 무해
  });
});

describe('expandDiscoveryTargets · 하향앵커 반영', () => {
  const view = (over: Partial<SlotSetupView> = {}): SlotSetupView => ({
    slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1, presetKey: '1:1',
    roi: [], vpd: null, lpd: null, occupyRange: null, pan: null, tilt: null, zoom: null,
    centered: false, img1: null, slot3dFrontCenter: { x: 0.5, y: 0.5 }, updatedAt: null, ...over,
  });

  it('slot3d_front_center null → 대상 제외', () => {
    expect(expandDiscoveryTargets([view({ slot3dFrontCenter: null })])).toHaveLength(0);
  });

  it('roi 부재(길이≠4) → 앵커 = frontCenter 폴백(하향 미적용, 회귀 0)', () => {
    const [t] = expandDiscoveryTargets([view()]); // roi:[]
    expect(t.anchor).toEqual({ x: 0.5, y: 0.5 });
  });

  it('정상 roi → 앵커가 frontCenter 아래(하향 적용)', () => {
    const roi: NormalizedPoint[] = [
      { x: 0.30, y: 0.80 }, { x: 0.70, y: 0.80 }, { x: 0.62, y: 0.60 }, { x: 0.38, y: 0.60 },
    ];
    const [t] = expandDiscoveryTargets([view({ roi, slot3dFrontCenter: { x: 0.5, y: 0.65 } })]);
    expect(t.anchor!.y).toBeCloseTo(0.72, 12); // B(0.8)→F(0.65) t=0.5333 보간
    expect(t.anchor!.y).toBeGreaterThan(0.65); // frontCenter 보다 아래
  });
});
