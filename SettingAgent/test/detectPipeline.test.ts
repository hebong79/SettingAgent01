import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDetect, loadDetectCfg, type DetectDeps, type DetectCfg } from '../src/capture/detectPipeline.js';
import { buildGroundInputs } from '../src/ground/groundInputs.js';
import { estimateGroundModels } from '../src/ground/groundModel.js';
import { parseCameraViews } from '../src/setup/mapTargets.js';
import type { CapturedImage, VehicleBox, NormalizedQuad, NormalizedPoint } from '../src/domain/types.js';
import type { PlateBox } from '../src/clients/LpdClient.js';
import type { CameraList } from '../src/viewer/CameraSource.js';

/**
 * 검증자(qa-tester): runDetect 통합 유닛테스트(camera/vpd/lpd 스텁).
 * 근거: 01_architect_plan.md §04-B + 02_developer_changes.md §02-E/§02-F/§02-G QA 인계.
 * 경계면 교차: resolvePresetPtz(listCameras) → basePtz 가 프리셋 PTZ(echo 아님),
 * base 매칭(recovered:false) / 미검출 zoom 재시도 recovered(inverse+clamp) / 4회 소진 / summary shape.
 */

// readJpegSize 가 파싱 가능한 최소 JPEG(SOF0: 200×100).
const VALID_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x00, 0xc8, 0, 0, 0, 0, 0, 0, 0, 0,
]);

const PRESET_PTZ = { pan: 56.6, tilt: 7.4, zoom: 1.9 };

const cfg: DetectCfg = { fovBaseV: 24.017, aspect: 16 / 9, frontBias: 0.62, zoomFactors: [2, 3, 4, 5], zoomRef: 1 };

/** camera 스텁: listCameras(프리셋 PTZ 포함 필수) + requestImage(echo 0/0/1) + clampZoom. */
function makeCamera(opts: {
  presetPtz?: { pan: number; tilt: number; zoom: number } | null;
  listThrows?: boolean;
  requestThrows?: boolean;
} = {}) {
  const requestImage = vi.fn(async (camIdx: number, presetIdx: number, _ptz?: { pan?: number; tilt?: number; zoom?: number }): Promise<CapturedImage> => {
    if (opts.requestThrows) throw new Error('req_img down');
    // 시뮬 echo 는 항상 0/0/1(프리셋 PTZ 와 다르게) → basePtz 가 echo 가 아님을 검증 가능.
    return { camIdx, presetIdx, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: VALID_JPEG };
  });
  const listCameras = vi.fn(async (): Promise<CameraList> => {
    if (opts.listThrows) throw new Error('cameras down');
    const presets = opts.presetPtz
      ? [{ presetIdx: 1, label: 'p1', ...opts.presetPtz }]
      : [{ presetIdx: 1, label: 'p1' }]; // PTZ 미보유 → resolvePresetPtz null → echo 폴백.
    return { cameras: [{ camIdx: 1, name: 'C1', enabled: true, presets }] };
  });
  const clampZoom = vi.fn((z: number) => Math.min(10, Math.max(1, z)));
  return { requestImage, listCameras, clampZoom };
}

/** vpd 스텁: 고정 차량 목록 반환. */
function makeVpd(vehicles: VehicleBox[]) {
  return { detect: vi.fn(async (_jpg: Buffer) => vehicles) };
}

/** lpd 스텁: 호출 회차별 플레이트(0=base, 1..=view). */
function makeLpd(byCall: PlateBox[][]) {
  let i = 0;
  return { detect: vi.fn(async (_jpg: Buffer) => byCall[i++] ?? []) };
}

const quad = (cx: number, cy: number): NormalizedQuad => [
  { x: cx - 0.02, y: cy - 0.02 },
  { x: cx + 0.02, y: cy - 0.02 },
  { x: cx + 0.02, y: cy + 0.02 },
  { x: cx - 0.02, y: cy + 0.02 },
];
const plate = (cx: number, cy: number, confidence = 0.9): PlateBox => ({ quad: quad(cx, cy), confidence, cls: 'car_license_plate' });
const vehicle = (x: number, y: number, w: number, h: number, confidence = 0.8): VehicleBox => ({ rect: { x, y, w, h }, confidence, cls: 'vehicle' });

const centerOf = (q: NormalizedQuad) => ({ x: q.reduce((s, p) => s + p.x, 0) / 4, y: q.reduce((s, p) => s + p.y, 0) / 4 });

describe('runDetect — resolvePresetPtz(listCameras) → basePtz 가 프리셋 PTZ(echo 아님)', () => {
  it('listCameras 프리셋 PTZ 보유 → basePtz===프리셋 PTZ, base requestImage 가 프리셋 PTZ 로 호출', async () => {
    const camera = makeCamera({ presetPtz: PRESET_PTZ });
    const deps: DetectDeps = { camera, vpd: makeVpd([]), lpd: makeLpd([[]]) };
    const out = await runDetect(deps, { cam: 1, preset: 1 }, cfg);
    // basePtz 는 echo(0/0/1) 가 아니라 프리셋 PTZ.
    expect(out.basePtz).toEqual(PRESET_PTZ);
    // base 프레임 요청이 프리셋 PTZ 를 명시했는지(3번째 인자).
    expect(camera.requestImage).toHaveBeenCalledWith(1, 1, PRESET_PTZ);
    expect(camera.listCameras).toHaveBeenCalledTimes(1);
  });

  it('listCameras throw → echo 폴백(basePtz=0/0/1), 예외 전파 없음', async () => {
    const camera = makeCamera({ listThrows: true });
    const deps: DetectDeps = { camera, vpd: makeVpd([]), lpd: makeLpd([[]]) };
    const out = await runDetect(deps, { cam: 1, preset: 1 }, cfg);
    expect(out.basePtz).toEqual({ pan: 0, tilt: 0, zoom: 1 });
    // 프리셋 PTZ 조회 실패 → base 요청은 ptz 미지정(undefined).
    expect(camera.requestImage).toHaveBeenCalledWith(1, 1, undefined);
  });

  it('프리셋이 목록에 있으나 PTZ 미보유 → echo 폴백', async () => {
    const camera = makeCamera({ presetPtz: null });
    const deps: DetectDeps = { camera, vpd: makeVpd([]), lpd: makeLpd([[]]) };
    const out = await runDetect(deps, { cam: 1, preset: 1 }, cfg);
    expect(out.basePtz).toEqual({ pan: 0, tilt: 0, zoom: 1 });
  });
});

describe('runDetect — base 매칭 차량(recovered:false)', () => {
  it('번호판 중심이 차량 rect 안 → 그대로 귀속, attempts=0, requestImage 1회(base 만)', async () => {
    const camera = makeCamera({ presetPtz: PRESET_PTZ });
    const v = vehicle(0.4, 0.4, 0.2, 0.2); // 중심 (0.5,0.5)
    const p = plate(0.5, 0.5); // 차량 rect 안
    const deps: DetectDeps = { camera, vpd: makeVpd([v]), lpd: makeLpd([[p]]) };
    const out = await runDetect(deps, { cam: 1, preset: 1 }, cfg);

    expect(out.vehicles).toHaveLength(1);
    const plateOut = out.vehicles[0].plate;
    expect(plateOut).toBeDefined();
    expect(plateOut!.recovered).toBe(false);
    expect(plateOut!.attempts).toBe(0);
    expect(plateOut!.quad).toBe(p.quad); // base 매칭은 원 quad 그대로(클램프 미적용).
    // 매칭됐으므로 zoom 재시도 없음 → base 요청 1회.
    expect(camera.requestImage).toHaveBeenCalledTimes(1);
    // 3인자 호출(모드 미지정) → 필터 미적용(계약 불변).
    expect(out.summary).toEqual({ vpdCount: 1, lpdCount: 1, recovered: 0, onPlaceOnly: false, filteredOut: 0, lpdFilteredOut: 0 });
  });
});

describe('runDetect — 미검출 차량 zoom 재시도 → recovered(inverse+clamp)', () => {
  it('base LPD [] → 1차 뷰에서 번호판 → recovered:true, attempts:1, requestImage 2회, quad 중심이 vehicle rect 안', async () => {
    const camera = makeCamera({ presetPtz: PRESET_PTZ });
    const v = vehicle(0.3, 0.5, 0.2, 0.3); // xMin0.3 xMax0.5 yMin0.5 yMax0.8
    // base=[] (미검출), 1차 view=중심 근처 번호판.
    const deps: DetectDeps = { camera, vpd: makeVpd([v]), lpd: makeLpd([[], [plate(0.5, 0.5)]]) };
    const out = await runDetect(deps, { cam: 1, preset: 1 }, cfg);

    const plateOut = out.vehicles[0].plate;
    expect(plateOut).toBeDefined();
    expect(plateOut!.recovered).toBe(true);
    expect(plateOut!.attempts).toBe(1);
    // requestImage: base(1) + 뷰(1) = 2회.
    expect(camera.requestImage).toHaveBeenCalledTimes(2);
    // clampQuadCenterToRect 로 quad 중심이 vehicle rect 경계 안(경계 스냅 시 float 오차 허용 ε).
    const EPS = 1e-9;
    const c = centerOf(plateOut!.quad);
    expect(c.x).toBeGreaterThanOrEqual(v.rect.x - EPS);
    expect(c.x).toBeLessThanOrEqual(v.rect.x + v.rect.w + EPS);
    expect(c.y).toBeGreaterThanOrEqual(v.rect.y - EPS);
    expect(c.y).toBeLessThanOrEqual(v.rect.y + v.rect.h + EPS);
    // quad 전 점 [0,1] 범위.
    for (const pt of plateOut!.quad) {
      expect(pt.x).toBeGreaterThanOrEqual(0);
      expect(pt.x).toBeLessThanOrEqual(1);
      expect(pt.y).toBeGreaterThanOrEqual(0);
      expect(pt.y).toBeLessThanOrEqual(1);
    }
    expect(out.summary.recovered).toBe(1);
  });

  it('3차 뷰에서 성공 → attempts:3, requestImage 4회(base+3)', async () => {
    const camera = makeCamera({ presetPtz: PRESET_PTZ });
    const v = vehicle(0.3, 0.5, 0.2, 0.3);
    const deps: DetectDeps = { camera, vpd: makeVpd([v]), lpd: makeLpd([[], [], [], [plate(0.5, 0.5)]]) };
    const out = await runDetect(deps, { cam: 1, preset: 1 }, cfg);
    expect(out.vehicles[0].plate!.attempts).toBe(3);
    expect(camera.requestImage).toHaveBeenCalledTimes(4);
  });

  it('4회(zoomFactors) 소진 → plate undefined, requestImage 5회, recovered=0', async () => {
    const camera = makeCamera({ presetPtz: PRESET_PTZ });
    const v = vehicle(0.3, 0.5, 0.2, 0.3);
    // base + 4 뷰 모두 [].
    const deps: DetectDeps = { camera, vpd: makeVpd([v]), lpd: makeLpd([[], [], [], [], []]) };
    const out = await runDetect(deps, { cam: 1, preset: 1 }, cfg);
    expect(out.vehicles[0].plate).toBeUndefined();
    expect(camera.requestImage).toHaveBeenCalledTimes(5); // base + 4 뷰
    expect(out.summary.recovered).toBe(0);
  });
});

describe('runDetect — 반환 shape / summary 카운트', () => {
  it('imageSize·plates·summary(vpdCount/lpdCount/recovered) 정합', async () => {
    const camera = makeCamera({ presetPtz: PRESET_PTZ });
    const v1 = vehicle(0.4, 0.4, 0.2, 0.2); // 매칭됨
    const v2 = vehicle(0.05, 0.5, 0.15, 0.2); // 미검출 → 재시도 성공
    const basePlates = [plate(0.5, 0.5)]; // v1 에 매칭.
    const deps: DetectDeps = {
      camera,
      vpd: makeVpd([v1, v2]),
      lpd: makeLpd([basePlates, [plate(0.5, 0.5)]]), // base + v2 1차 뷰 성공.
    };
    const out = await runDetect(deps, { cam: 1, preset: 1 }, cfg);

    expect(out.cam).toBe(1);
    expect(out.preset).toBe(1);
    expect(out.imageSize).toEqual({ w: 200, h: 100 });
    // base LPD 전체(매칭 무관) 표시용.
    expect(out.plates).toHaveLength(1);
    expect(out.summary.vpdCount).toBe(2);
    expect(out.summary.lpdCount).toBe(1); // base LPD 개수(뷰 검출은 제외).
    expect(out.summary.recovered).toBe(1); // v2 복원 1건.
    expect(out.vehicles[0].plate!.recovered).toBe(false);
    expect(out.vehicles[1].plate!.recovered).toBe(true);
  });
});

/**
 * 주차면 필터(모드A) 배선 — 01_architect_plan.md §6 항목 12~15.
 * 시나리오는 onPlaceFilter.test.ts 와 동일한 원근 구도:
 *   BACK_ROW = 뒷줄 주차면(바닥 quad, y 0.30~0.45), 통로 = y > 0.45.
 *   PARKED  = 뒷줄에 주차된 차(접지 밴드가 폴리곤 안) — base LPD 로 번호판 귀속(재시도 0회).
 *   PASSING = 통로 통행차(중심은 폴리곤 안, 접지 밴드는 통로) + 번호판 없음 → 모드B 라면 zoom 4회 재시도.
 */
describe('runDetect — 주차면 필터(OnPlaceOpts)', () => {
  const BACK_ROW: NormalizedPoint[] = [
    { x: 0.30, y: 0.30 },
    { x: 0.56, y: 0.30 },
    { x: 0.58, y: 0.45 },
    { x: 0.28, y: 0.45 },
  ];
  const PARKED = vehicle(0.33, 0.18, 0.20, 0.26); // rect y 0.18~0.44 → 밴드 0.375~0.44 (폴리곤 내부)
  const PASSING = vehicle(0.32, 0.28, 0.20, 0.32); // rect y 0.28~0.60 → 밴드 0.52~0.60 (통로)
  // 주차차에만 귀속되는 번호판(통행차 rect(y≥0.28) 밖인 y=0.22 에 둔다 → 매칭 모호성 제거).
  const PARKED_PLATE = plate(0.43, 0.22);

  /** base LPD = 주차차 번호판 1건, 이후 뷰 LPD 는 전부 미검출(재시도 소진 관찰용). */
  const lpdStub = () => makeLpd([[PARKED_PLATE], [], [], [], []]);

  it('§6-12 {onlyOnPlace:true, polys} → 통행차 제외, summary(onPlaceOnly=true, filteredOut=1, vpdCount=필터 전)', async () => {
    const camera = makeCamera({ presetPtz: PRESET_PTZ });
    const deps: DetectDeps = { camera, vpd: makeVpd([PARKED, PASSING]), lpd: lpdStub() };
    const out = await runDetect(deps, { cam: 1, preset: 1 }, cfg, { onlyOnPlace: true, polys: [BACK_ROW] });

    expect(out.vehicles).toHaveLength(1);
    expect(out.vehicles[0].rect).toEqual(PARKED.rect); // 남은 것은 주차차.
    expect(out.summary.vpdCount).toBe(2); // **필터 전** 원 검출 수(의미 불변).
    expect(out.summary.filteredOut).toBe(1);
    expect(out.summary.onPlaceOnly).toBe(true);
    expect(out.summary.onPlaceDegraded).toBeUndefined();
    // 계약: vehicles.length === vpdCount − filteredOut (UI 가 "몇 대 중 몇 대" 를 그대로 표시).
    expect(out.vehicles).toHaveLength(out.summary.vpdCount - out.summary.filteredOut);
    /**
     * ★ 번호판도 모드A 필터 대상이다. 그럼에도 PARKED_PLATE 가 **살아남는 것이 정답**이다 —
     * 이 번호판의 중심(0.43,0.22)은 BACK_ROW 폴리곤(y 0.30~0.45) **밖**이지만
     * 유지된 차량 PARKED(rect y 0.18~0.44) 에 **귀속**되기 때문이다. 즉 이 케이스는 우연이 아니라
     * `keepPlate = (귀속) OR (폴리곤 내부)` 의 **(A) 귀속 항 실증**이다((A)를 빼면 여기서 깨진다).
     */
    expect(out.summary.lpdCount).toBe(1); // 필터 **전** 원 검출 수(의미 불변).
    expect(out.summary.lpdFilteredOut).toBe(0);
    expect(out.plates).toHaveLength(1);
  });

  it('★ 신규 — 통행차 번호판(kept 차량 밖 + 폴리곤 밖)은 모드A 에서 drop / 모드B 에서 유지', async () => {
    // PASSING(rect y 0.28~0.60) 위 번호판. 중심 (0.42,0.55): BACK_ROW(y≤0.45) 밖 + PARKED(rect y≤0.44) 밖.
    // → 모드A 에선 PASSING 이 제외되므로 어떤 kept 차량에도 귀속되지 못하고 (B) 로도 못 살아난다 = drop.
    const PASSING_PLATE = plate(0.42, 0.55);
    const lpd2 = () => makeLpd([[PARKED_PLATE, PASSING_PLATE], [], [], [], []]);

    const camA = makeCamera({ presetPtz: PRESET_PTZ });
    const outA = await runDetect(
      { camera: camA, vpd: makeVpd([PARKED, PASSING]), lpd: lpd2() },
      { cam: 1, preset: 1 }, cfg, { onlyOnPlace: true, polys: [BACK_ROW] },
    );
    expect(outA.plates).toHaveLength(1); // ← 마스터 스크린샷의 뒷줄 노란 박스가 사라지는 지점.
    expect(outA.plates[0].quad).toBe(PARKED_PLATE.quad);
    expect(outA.summary.lpdCount).toBe(2); // 원 검출 수는 불변.
    expect(outA.summary.lpdFilteredOut).toBe(1);

    // 대조군(모드B, 3인자): 번호판 2건 전량 유지.
    const camB = makeCamera({ presetPtz: PRESET_PTZ });
    const outB = await runDetect({ camera: camB, vpd: makeVpd([PARKED, PASSING]), lpd: lpd2() }, { cam: 1, preset: 1 }, cfg);
    expect(outB.plates).toHaveLength(2);
    expect(outB.summary.lpdFilteredOut).toBe(0);
  });

  it('★ 신규 — 불변식: plates.length === lpdCount − lpdFilteredOut (모드A/모드B/강등)', async () => {
    const cases = [
      { onPlace: { onlyOnPlace: true, polys: [BACK_ROW] } },
      { onPlace: { onlyOnPlace: false, polys: [BACK_ROW] } },
      { onPlace: { onlyOnPlace: true, polys: null } }, // 강등.
      { onPlace: undefined }, // 3인자 계약.
    ];
    for (const c of cases) {
      const out = await runDetect(
        { camera: makeCamera({ presetPtz: PRESET_PTZ }), vpd: makeVpd([PARKED, PASSING]), lpd: lpdStub() },
        { cam: 1, preset: 1 }, cfg, c.onPlace as never,
      );
      expect(out.plates).toHaveLength(out.summary.lpdCount - out.summary.lpdFilteredOut);
    }
  });

  it('★ 신규 — 복원(recovered) 번호판은 plates 배열과 무관하게 vehicles[].plate 로 유지된다(모드A)', async () => {
    // base LPD [] (주차차 번호판 미검출) → zoom 재시도로 복원. plates(base 표시용)는 0건이지만 차량은 번호판을 갖는다.
    const camera = makeCamera({ presetPtz: PRESET_PTZ });
    const deps: DetectDeps = { camera, vpd: makeVpd([PARKED]), lpd: makeLpd([[], [plate(0.5, 0.5)]]) };
    const out = await runDetect(deps, { cam: 1, preset: 1 }, cfg, { onlyOnPlace: true, polys: [BACK_ROW] });
    expect(out.vehicles[0].plate!.recovered).toBe(true);
    expect(out.plates).toHaveLength(0);
    expect(out.summary).toMatchObject({ lpdCount: 0, lpdFilteredOut: 0, recovered: 1 });
  });

  it('§6-12b 필터 후에도 번호판 매칭 인덱스 정합(축소된 vehicles 로 matchPlatesToSlots)', async () => {
    const camera = makeCamera({ presetPtz: PRESET_PTZ });
    const deps: DetectDeps = { camera, vpd: makeVpd([PARKED, PASSING]), lpd: lpdStub() };
    const out = await runDetect(deps, { cam: 1, preset: 1 }, cfg, { onlyOnPlace: true, polys: [BACK_ROW] });
    // 살아남은 차량(index 0)이 base 번호판을 그대로 귀속받아야 한다(인덱스가 밀리면 여기서 깨진다).
    expect(out.vehicles[0].plate).toBeDefined();
    expect(out.vehicles[0].plate!.recovered).toBe(false);
    expect(out.vehicles[0].plate!.quad).toBe(PARKED_PLATE.quad);
  });

  it('★ §6-13 카메라 호출 절감 — 통행차는 zoom 재시도 **진입 전** 제외(requestImage 1회 = base 만)', async () => {
    const camera = makeCamera({ presetPtz: PRESET_PTZ });
    const deps: DetectDeps = { camera, vpd: makeVpd([PARKED, PASSING]), lpd: lpdStub() };
    await runDetect(deps, { cam: 1, preset: 1 }, cfg, { onlyOnPlace: true, polys: [BACK_ROW] });
    expect(camera.requestImage).toHaveBeenCalledTimes(1); // base 만. 통행차에 대한 카메라 호출 0회.
  });

  it('★ §6-13b 대조군(모드B, 3인자) — 같은 입력에서 통행차가 zoom 4회 재시도 → requestImage 5회', async () => {
    const camera = makeCamera({ presetPtz: PRESET_PTZ });
    const deps: DetectDeps = { camera, vpd: makeVpd([PARKED, PASSING]), lpd: lpdStub() };
    const out = await runDetect(deps, { cam: 1, preset: 1 }, cfg); // 필터 없음
    expect(out.vehicles).toHaveLength(2);
    // base(1) + 통행차 zoom 재시도(4) = 5. → 모드A 의 절감(1회)이 실재함을 대조로 증명.
    expect(camera.requestImage).toHaveBeenCalledTimes(5);
  });

  it('§6-14 {onlyOnPlace:true, polys:null} → 강등(전량 통과) + onPlaceOnly=false + onPlaceDegraded 사유', async () => {
    const camera = makeCamera({ presetPtz: PRESET_PTZ });
    const deps: DetectDeps = { camera, vpd: makeVpd([PARKED, PASSING]), lpd: lpdStub() };
    const out = await runDetect(deps, { cam: 1, preset: 1 }, cfg, { onlyOnPlace: true, polys: null });

    expect(out.vehicles).toHaveLength(2); // 기준 부재 → 드롭 금지.
    expect(out.summary.onPlaceOnly).toBe(false); // **실제 적용된** 모드(요청이 아니라 결과).
    expect(out.summary.filteredOut).toBe(0);
    expect(out.summary.onPlaceDegraded).toBe('주차면 폴리곤 없음'); // degradeReason 미지정 시 기본 문구.
    // 번호판도 같은 이유로 필터하지 않는다(강등은 차량·번호판 공통 — 별도 사유/카운터 없음).
    expect(out.plates).toHaveLength(1);
    expect(out.summary.lpdFilteredOut).toBe(0);
  });

  it('§6-14b polys:[] → 동일 강등 / degradeReason 지정 시 호출측 문구 그대로', async () => {
    const camera = makeCamera({ presetPtz: PRESET_PTZ });
    const deps: DetectDeps = { camera, vpd: makeVpd([PARKED, PASSING]), lpd: lpdStub() };
    const out = await runDetect(deps, { cam: 1, preset: 1 }, cfg, {
      onlyOnPlace: true,
      polys: [],
      degradeReason: '프리셋 1:1 주차면 0개',
    });
    expect(out.vehicles).toHaveLength(2);
    expect(out.summary.onPlaceOnly).toBe(false);
    expect(out.summary.onPlaceDegraded).toBe('프리셋 1:1 주차면 0개'); // 파일 부재와 구별되는 사유.
  });

  it('§6-15 {onlyOnPlace:false} → 필터 함수 자체를 건너뜀(모드B 100% 복원, 강등 아님)', async () => {
    const camera = makeCamera({ presetPtz: PRESET_PTZ });
    const deps: DetectDeps = { camera, vpd: makeVpd([PARKED, PASSING]), lpd: lpdStub() };
    const out = await runDetect(deps, { cam: 1, preset: 1 }, cfg, { onlyOnPlace: false, polys: [BACK_ROW] });

    expect(out.vehicles).toHaveLength(2); // 폴리곤이 있어도 필터하지 않는다(사용자 선택).
    expect(out.summary.onPlaceOnly).toBe(false);
    expect(out.summary.filteredOut).toBe(0);
    expect(out.summary.onPlaceDegraded).toBeUndefined(); // 모드B 는 강등이 아니다.
  });

  it('§6-15b 3인자 호출(기존 계약) → onPlaceOnly=false, filteredOut=0, onPlaceDegraded 없음', async () => {
    const camera = makeCamera({ presetPtz: PRESET_PTZ });
    const deps: DetectDeps = { camera, vpd: makeVpd([PARKED]), lpd: makeLpd([[PARKED_PLATE]]) };
    const out = await runDetect(deps, { cam: 1, preset: 1 }, cfg);
    expect(out.summary).toEqual({ vpdCount: 1, lpdCount: 1, recovered: 0, onPlaceOnly: false, filteredOut: 0, lpdFilteredOut: 0 });
    expect(out.summary).not.toHaveProperty('onPlaceDegraded'); // 키 자체가 없다(옵셔널 스프레드).
  });
});

/**
 * 폴백 상수 = **34.6348°**(zoom=1 기준 수직 FOV = CObjCamera.DEFAULT_VERT_FOV).
 * 이전 값 24.017 은 `camera.fov`(zoom=1.4 에서의 fov 스냅샷)를 base 로 오인한 값이라 f 가 +42% 틀렸다.
 * [2026-07-15] Unity 줌↔FOV 를 각도 반비례식에서 **탄젠트 광학 모델**로 전환하면서 base 를 34.6348 로 정합했다
 *   (수평 58° @ 16:9 의 수직 FOV; Unity 탄젠트 SetZoomByFOV/detectMath.fovV 와 일치).
 *   종전 33.1 은 각도렌더 이미지에 탄젠트 추정을 피팅한 과도값이었다(레거시 데이터에서만 성립).
 */
const FALLBACK_FOV = 34.6348;

describe('loadDetectCfg — 추정 불가 시 폴백 상수', () => {
  it('placeRoiFile undefined → 폴백(fovBaseV=34.6348, aspect=16/9, frontBias/zoomFactors 상수)', async () => {
    const out = await loadDetectCfg(undefined, 1);
    expect(out.fovBaseV).toBeCloseTo(FALLBACK_FOV, 6);
    expect(out.aspect).toBeCloseTo(16 / 9, 6);
    expect(out.frontBias).toBe(0.62);
    expect(out.zoomFactors).toEqual([2, 3, 4, 5]);
    expect(out.zoomRef).toBe(1);
  });

  it('존재하지 않는 파일 경로 → 폴백(파싱 실패 흡수, throw 없음)', async () => {
    const out = await loadDetectCfg('/no/such/PtzCamRoi.json', 1);
    expect(out.fovBaseV).toBeCloseTo(FALLBACK_FOV, 6);
  });

  it('★ 폴백은 "줌 걸린 fov"(24.017)가 아니다 — 그 값을 쓰면 f 가 +42% 틀린다(회귀 방지)', () => {
    // 폴백이 24.017 로 되돌아가면 재중심 PTZ 가 ~30% 미달해 대상이 중심에서 평균 154px 벗어난다(라이브 실측).
    expect(FALLBACK_FOV).toBeGreaterThan(30);
    expect(Math.abs(FALLBACK_FOV - 24.017)).toBeGreaterThan(5);
  });
});

/**
 * ★ C3(실카메라 호환) 봉인 — 프로덕션 검출 경로는 Unity `camera` 블록의 fov/position/eulerAngles 를 읽지 않는다.
 *
 * 이전 구현은 `camera.fov` 를 fovBaseV 로 삼았다. 그것은 실카메라가 못 주는 값일 뿐 아니라 **Unity 에서도 틀렸다**:
 * `camera.fov` 는 저장 시점 zoom(1.4)에서의 fov 스냅샷이고 `fovBaseV` 는 zoom=1 기준 FOV 이기 때문이다.
 * 이제 fovBaseV 는 지면모델 공동추정(이미지 4점 + camerapos zoom)에서 나온다 — 실카메라도 줄 수 있는 입력뿐.
 *
 * 동결 픽스처만 사용한다(런타임 가변 데이터 금지 — 02 §7 규약).
 */
describe('★ loadDetectCfg C3 — fovBaseV 는 지면모델 추정, camera.fov 미사용', () => {
  const GROUND = { minDepthEdgePx: 250, slotWidthM: 2.5, slotDepthM: 5.0 };
  const CAMPOS = 'test/fixtures/camerapos.sample.json';
  const UNITY_FIXTURE = 'test/fixtures/PtzCamRoi.unity.json';

  /** 픽스처를 변형해 임시 파일로 쓴다(원본 불변). */
  const writeTmp = (mutate: (json: any) => void): string => {
    const json = JSON.parse(readFileSync(UNITY_FIXTURE, 'utf8'));
    mutate(json);
    const path = join(mkdtempSync(join(tmpdir(), 'detectcfg-')), 'PtzCamRoi.json');
    writeFileSync(path, JSON.stringify(json), 'utf8');
    return path;
  };

  const load = (path: string) => loadDetectCfg(path, 1, { cameraposFile: CAMPOS, ground: GROUND });

  /**
   * ⚠️ 동결 픽스처(PtzCamRoi.unity.json)는 **레거시 각도모델** 지오메트리라, 탄젠트 추정기가 돌리면 ≈33.19°
   *   (각도모델 등가 base)를 낸다. 폴백은 이제 탄젠트 base 34.6348° 이므로 두 값이 다시 벌어져 **구별 가능**하다.
   *   (실운영 데이터를 탄젠트 Unity 로 재생성하면 추정도 34.6° 로 수렴한다.) 검출력은 **구조적 단언**으로 유지:
   *   추정 경로는 estimateGroundModels 의 출력과 **소수 9자리까지 동일**해야 한다 —
   *   조용히 폴백으로 떨어지면(34.6348) 이 단언이 깨진다.
   */
  it('추정 fovBaseV 는 폴백 상수와 **다른 값**이다 — 조용한 폴백 강등 검출(공허한 단언 방지)', async () => {
    const out = await load(UNITY_FIXTURE);
    expect(out.fovBaseV).toBeGreaterThan(30); // 실측 ≈33°(라이브 pan 회전 측정과 일치).
    expect(out.fovBaseV).not.toBeCloseTo(FALLBACK_FOV, 2); // 폴백이 아니라 **추정**이 쓰였다.
    expect(out.aspect).toBeCloseTo(16 / 9, 6); // aspect 는 imageWidth/Height — 실카메라도 주는 값(허용).
  });

  it('★ camera.fov 를 터무니없는 값으로 바꿔도 fovBaseV 불변 (= fov 를 읽지 않는다)', async () => {
    const base = await load(UNITY_FIXTURE);
    for (const bogus of [1, 179, 0, -5]) {
      const out = await load(writeTmp((j) => (j.cameras[0].camera.fov = bogus)));
      expect(out.fovBaseV).toBeCloseTo(base.fovBaseV, 9); // 소수 9자리까지 동일.
    }
  });

  it('★ fov/position/eulerAngles 를 삭제해도 동일 fovBaseV — 프로덕션은 이 필드들에 의존하지 않는다', async () => {
    const base = await load(UNITY_FIXTURE);
    const stripped = await load(
      writeTmp((j) => {
        delete j.cameras[0].camera.fov;
        delete j.cameras[0].camera.position;
        delete j.cameras[0].camera.eulerAngles;
      }),
    );
    expect(stripped.fovBaseV).toBeCloseTo(base.fovBaseV, 9);
    expect(stripped.aspect).toBeCloseTo(base.aspect, 9);
  });

  it('camera 블록 전체 삭제 → throw 없이 폴백 상수로 강등(cam_id/이미지크기 미상)', async () => {
    const out = await load(writeTmp((j) => delete j.cameras[0].camera));
    expect(out.fovBaseV).toBeCloseTo(FALLBACK_FOV, 6);
    expect(out.aspect).toBeCloseTo(16 / 9, 6);
  });

  it('camerapos 미주입(zoom 미상) → 추정 불가 → 폴백 강등(throw 없음)', async () => {
    const out = await loadDetectCfg(UNITY_FIXTURE, 1, { ground: GROUND });
    expect(out.fovBaseV).toBeCloseTo(FALLBACK_FOV, 6);
  });

  it('sources 미주입 → 폴백 강등(하위호환)', async () => {
    const out = await loadDetectCfg(UNITY_FIXTURE, 1);
    expect(out.fovBaseV).toBeCloseTo(FALLBACK_FOV, 6);
  });

  it('주차면 0개(추정 표본 없음) → 폴백 강등', async () => {
    const out = await load(writeTmp((j) => j.cameras[0].presets.forEach((p: any) => (p.parking_spaces = []))));
    expect(out.fovBaseV).toBeCloseTo(FALLBACK_FOV, 6);
  });

  it('추정 fovBaseV 는 GET /capture/ground-model 과 동일 값(이중구현 0)', async () => {
    const views = parseCameraViews(JSON.parse(readFileSync(CAMPOS, 'utf8')));
    const cam = buildGroundInputs(JSON.parse(readFileSync(UNITY_FIXTURE, 'utf8')), views)[0];
    const expected = estimateGroundModels(cam, GROUND).fovBaseV!;
    const out = await load(UNITY_FIXTURE);
    expect(out.fovBaseV).toBeCloseTo(expected, 9);
  });
});
