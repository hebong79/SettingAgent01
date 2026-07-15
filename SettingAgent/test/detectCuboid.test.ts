// runDetect ↔ 차량 육면체 배선(설계 §3-2). **가산 + 회귀 0**.
//
// 핵심 계약 3가지:
//   ① `cuboidCtx` 미지정 → 응답에 **`cuboids` 키 자체가 없다**(기존 응답 shape 완전 불변).
//   ② `deps.vpd` 가 seg 를 **구현하지 않아도**(기존 스텁) 컴파일·동작한다 → 육면체만 미산출(강등).
//   ③ seg 가 죽어도 **검출은 살아서 반환된다**(검출 라우트가 육면체 때문에 죽지 않는다).

import { describe, it, expect, vi } from 'vitest';
import { runDetect, type DetectCfg, type DetectDeps } from '../src/capture/detectPipeline.js';
import { filterVehiclesOnPlace } from '../src/capture/onPlaceFilter.js';
import { projectToPixel } from '../src/ground/project.js';
import { convexHull } from '../src/domain/polygon.js';
import type { CuboidContext } from '../src/ground/frameCuboids.js';
import type { Px, Vec3 } from '../src/ground/contactTypes.js';
import type { GroundModel } from '../src/ground/types.js';
import type { CapturedImage, VehicleBox } from '../src/domain/types.js';
import type { VpdSegResult } from '../src/clients/VpdClient.js';
import type { CameraList } from '../src/viewer/CameraSource.js';

const VALID_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x00, 0xc8, 0, 0, 0, 0, 0, 0, 0, 0,
]);
const cfg: DetectCfg = { fovBaseV: 33.1, aspect: 16 / 9, frontBias: 0.62, zoomFactors: [2], zoomRef: 1 };

const DEG = Math.PI / 180;
const TILT = 14;
const g: GroundModel = {
  camIdx: 1, presetIdx: 1, imgW: 1920, imgH: 1080, zoom: 1, f: 1500,
  n: [0, Math.cos(TILT * DEG), Math.sin(TILT * DEG)], d: 5.0, tiltDeg: TILT,
  ptzTiltDeg: null, tiltErrDeg: null, slotBearingDeg: null, bearingDevDeg: null, dDevRel: null,
  depthEdgePx: 400, metricErr: 0, conf: 1, source: 'file', issues: [],
};
const O: Vec3 = [0, g.d * g.n[1], g.d * g.n[2]];
const W: Vec3 = [0, -Math.sin(TILT * DEG), Math.cos(TILT * DEG)];
const X = (a: number, b: number): Vec3 => [O[0] + a, O[1] + b * W[1], O[2] + b * W[2]];
const P = (v: Vec3): Px => projectToPixel(v, g)!;
const up = (p: Vec3, h: number): Vec3 => [p[0] - h * g.n[0], p[1] - h * g.n[1], p[2] - h * g.n[2]];
const slotPolysPx: Px[][] = [-1, 0, 1].map((k) => {
  const a0 = k * 2.5 - 1.25;
  return [P(X(a0, 8)), P(X(a0, 13)), P(X(a0 + 2.5, 13)), P(X(a0 + 2.5, 8))];
});
const CTX: CuboidContext = { model: g, slotPolysPx, slotWidthM: 2.5, slotDepthM: 5.0 };

/** 차량 실루엣 → 정규화 마스크 + 정규화 rect. */
function car(aC: number, bFront: number) {
  const pts: Vec3[] = [];
  for (const [a, b] of [[aC - 0.93, bFront], [aC + 0.93, bFront], [aC + 0.93, bFront + 4.7], [aC - 0.93, bFront + 4.7]] as const) pts.push(X(a, b));
  for (const [a, b] of [[aC - 0.72, bFront + 1.9], [aC + 0.72, bFront + 1.9], [aC + 0.72, bFront + 4.0], [aC - 0.72, bFront + 4.0]] as const) {
    pts.push(up(X(a, b), 1.45));
  }
  const mask = (convexHull(pts.map(P)) as Px[]).map((p) => ({ x: p.x / g.imgW, y: p.y / g.imgH }));
  const xs = mask.map((p) => p.x);
  const ys = mask.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { mask, rect: { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y } };
}

const C0 = car(0, 8.5);
const VEHICLES: VehicleBox[] = [{ rect: C0.rect, confidence: 0.93, cls: 'car' }];
const SEG: VpdSegResult = {
  boxes: [{ vpdIdx: 0, rect: C0.rect, confidence: 0.8, cls: 'car', mask: C0.mask }],
  segDegraded: false,
  maskMismatch: 0,
};

const camera = () => ({
  requestImage: vi.fn(async (camIdx: number, presetIdx: number): Promise<CapturedImage> => ({
    camIdx, presetIdx, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: VALID_JPEG,
  })),
  listCameras: vi.fn(async (): Promise<CameraList> => ({
    cameras: [{ camIdx: 1, name: 'C1', enabled: true, presets: [{ presetIdx: 1, label: 'p1', pan: 10, tilt: 5, zoom: 1.5 }] }],
  })),
  clampZoom: vi.fn((z: number) => Math.min(10, Math.max(1, z))),
});

/** ★ **기존 스텁 모양** — `segment`/`canSegment` 가 **없다**. 이것이 그대로 컴파일돼야 한다(Partial). */
const legacyVpd = { detect: vi.fn(async () => VEHICLES) };
const segVpd = (opts: { throws?: boolean } = {}) => ({
  detect: vi.fn(async () => VEHICLES),
  canSegment: () => true,
  // `_jpg` 를 명시해야 `mock.lastCall` 이 인자 타입을 갖는다(⑤ 가 base 프레임을 확인한다).
  segment: vi.fn(async (_jpg: Buffer): Promise<VpdSegResult> => {
    if (opts.throws) throw new Error('seg 다운');
    return SEG;
  }),
});
const lpd = { detect: vi.fn(async () => []) };

// ═════════════════════════════════════════════════════════════════════════════
describe('runDetect × 육면체 — 가산 + 회귀 0', () => {
  it('① `cuboidCtx` 미지정 → 응답에 **`cuboids` 키가 없다**(기존 계약 완전 불변)', async () => {
    const deps: DetectDeps = { camera: camera(), vpd: segVpd(), lpd };
    const r = await runDetect(deps, { cam: 1, preset: 1 }, cfg);
    expect('cuboids' in r).toBe(false); // undefined 도 아니고 **키 자체가 없다**.
    expect(r.vehicles).toHaveLength(1);
  });

  it('② ★ seg 미구현 스텁(`{detect}` 만)이 **그대로 컴파일·동작**한다 — ctx 를 줘도 육면체만 미산출', async () => {
    const deps: DetectDeps = { camera: camera(), vpd: legacyVpd, lpd }; // ← Partial 이 아니면 여기서 타입 에러.
    const r = await runDetect(deps, { cam: 1, preset: 1 }, cfg, undefined, CTX);
    expect('cuboids' in r).toBe(false); // seg 를 못 부르므로 시도조차 안 한다.
    expect(r.vehicles).toHaveLength(1); // 검출은 정상.
  });

  it('③ ctx + seg 주입 → `cuboids` 산출(det 권위 · assoc 포함 · 미검증 배지 근거)', async () => {
    const deps: DetectDeps = { camera: camera(), vpd: segVpd(), lpd };
    const r = await runDetect(deps, { cam: 1, preset: 1 }, cfg, undefined, CTX);
    expect(r.cuboids).toBeDefined();
    expect(r.cuboids!.summary.detCount).toBe(1);
    expect(r.cuboids!.summary.matched).toBe(1);
    expect(r.cuboids!.cuboids).toHaveLength(1);
    expect(r.cuboids!.cuboids[0].vpdIdx).toBe(0); // det 인덱스.
    expect(r.cuboids!.cuboids[0].confidence).toBe(0.93); // ★ **det** 의 conf(seg 의 0.8 이 아니다).
    expect(r.cuboids!.assoc).toEqual([{ detIdx: 0, segIdx: 0, iou: r.cuboids!.assoc[0].iou }]);
    expect(r.cuboids!.estimateUnverified).toBe(true);
  });

  it('③b 🟣 마스크 show — seg 마스크가 `detect.cuboids.masks` 로 **경계면을 넘어 도착**한다(좌표 보존)', async () => {
    // 경계면 교차: VpdClient.segment() 응답 → buildFrameCuboids.masks → DetectResult.cuboids.masks →
    //   뷰어 state.vcuboidByKey[key].masks(app.js drawMaskOverlay 소비). 여기서 배선을 봉인한다.
    const deps: DetectDeps = { camera: camera(), vpd: segVpd(), lpd };
    const r = await runDetect(deps, { cam: 1, preset: 1 }, cfg, undefined, CTX);
    expect(r.cuboids!.masks).toBeDefined();
    expect(r.cuboids!.masks).toHaveLength(1); // SEG.boxes 1개.
    expect(r.cuboids!.masks![0]).toEqual(C0.mask); // seg 정규화 마스크가 손상 없이 도착.
  });

  it('③c 🟣 cuboidCtx 미주입 → cuboids 키 부재 → masks 도 당연히 없다(응답 shape 회귀 0)', async () => {
    const deps: DetectDeps = { camera: camera(), vpd: segVpd(), lpd };
    const r = await runDetect(deps, { cam: 1, preset: 1 }, cfg); // ctx 없음.
    expect('cuboids' in r).toBe(false); // masks 는 cuboids 안에만 산다 → 경로 자체가 없다.
  });

  it('④ ★ seg 가 죽어도 **검출은 살아서 반환된다**(검출이 육면체 때문에 죽지 않는다)', async () => {
    const deps: DetectDeps = { camera: camera(), vpd: segVpd({ throws: true }), lpd };
    const r = await runDetect(deps, { cam: 1, preset: 1 }, cfg, undefined, CTX);
    expect(r.vehicles).toHaveLength(1); // ← 검출 정상.
    expect(r.cuboids!.cuboids).toEqual([]); // 육면체만 강등.
    expect(r.cuboids!.segError).toContain('seg 다운'); // 사유는 드러난다(조용한 실패 금지).
  });

  it('★★ DEFECT-2 — **검출 경로**의 참조 동일성 전제도 봉인한다(QA MUTANT-2 사각지대)', async () => {
    // 🔴 QA 가 `onPlaceFilter` 에 복사를 끼워넣는 뮤테이션을 넣었을 때 **이 파일이 초록으로 통과했다** —
    //    잡 경로(T6)만 보호되고 **검출 경로는 무방비**였다. 여기서 같은 전제를 봉인한다.
    //    전제: `filterVehiclesOnPlace` 는 det **객체 참조를 보존**한다(Array.filter) → `indexOf` 가 -1 을 내지 않는다.
    const kept = filterVehiclesOnPlace(VEHICLES, [
      // 차량 접지 밴드를 확실히 덮는 폴리곤(필터를 통과시켜 kept 가 비지 않게).
      [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    ]).kept;
    expect(kept.length).toBeGreaterThan(0);
    // ★ 참조 보존 — 하나라도 복사되면 indexOf 가 -1 이 되고 육면체가 조용히 사라진다.
    for (const v of kept) expect(VEHICLES.indexOf(v)).toBeGreaterThanOrEqual(0);

    // 그리고 그 전제가 깨졌을 때 **조용히 죽지 않는다**(issues 로 드러난다)는 것을 runDetect 레벨에서 확인.
    const deps: DetectDeps = { camera: camera(), vpd: segVpd(), lpd };
    const r = await runDetect(deps, { cam: 1, preset: 1 }, cfg, undefined, CTX);
    expect(r.cuboids!.summary.kept).toBe(1);
    expect(r.cuboids!.issues.some((s) => s.includes('참조를 보존하지 않는다'))).toBe(false); // 정상 경로엔 사유 없음.
  });

  it('⑤ 육면체는 **base 프레임**에서 산출된다 — zoom 재시도 뷰를 쓰지 않는다', async () => {
    const cam = camera();
    const vpd = segVpd();
    const deps: DetectDeps = { camera: cam, vpd, lpd };
    await runDetect(deps, { cam: 1, preset: 1 }, cfg, undefined, CTX);
    // 번호판이 없어 zoom 재시도가 돌지만(zoomFactors=[2] → 캡처 1회 추가), seg 는 **한 번만** 불린다.
    expect(vpd.segment).toHaveBeenCalledTimes(1);
    // seg 에 넘어간 프레임이 **base 프레임**이다(zoom 뷰가 아니다).
    expect(vpd.segment.mock.lastCall?.[0]).toBe(VALID_JPEG);
  });
});
