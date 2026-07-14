// 라이브 VPD/LPD 검출 파이프라인(설계서 §04-B). 캡처 파이프라인과 독립 — on-demand 1프리셋 1회 멱등.
// VPD 차량 bbox + LPD 번호판 OBB 검출 → 매칭 → 미귀속 차량 zoom 재시도(최대 4회) → 역투영 복원.
// 좌표/매칭/역산 전부 결정형(LLM 무관). 매칭=plateMatch, 중심선택=controlMath 재사용(신규 매칭 0).

import { readFile } from 'node:fs/promises';
import type { CameraClient } from '../clients/CameraClient.js';
import type { VpdClient } from '../clients/VpdClient.js';
import type { LpdClient } from '../clients/LpdClient.js';
import type { NormalizedPoint, NormalizedQuad, NormalizedRect } from '../domain/types.js';
import { readJpegSize } from '../util/jpeg.js';
import { filterVehiclesOnPlace, filterPlatesOnPlace } from './onPlaceFilter.js';
import { matchPlatesToSlots } from '../setup/plateMatch.js';
import { pickNearestPlate } from '../calibrate/controlMath.js';
import { vehicleCenterZoomPtz, inverseProjectQuad, clampQuadCenterToRect, type FovOpts } from '../calibrate/detectMath.js';
import { parseCameraViews, type CameraView } from '../setup/mapTargets.js';
import { buildGroundInputs } from '../ground/groundInputs.js';
import { estimateGroundModels } from '../ground/groundModel.js';
import { buildFrameCuboids, type CuboidContext, type FrameCuboids } from '../ground/frameCuboids.js';
import type { GroundOptions } from '../ground/types.js';
import { logger } from '../util/logger.js';

/** runDetect 의존성(스텁 주입 가능한 구조적 최소 계약). */
export interface DetectDeps {
  camera: Pick<CameraClient, 'requestImage' | 'clampZoom' | 'listCameras'>;
  /**
   * ★ `segment`/`canSegment` 는 **Partial** 이다 — 기존 테스트 스텁(`{ detect }` 만 구현)이
   * **타입 에러 없이 그대로 컴파일**된다(회귀 0, CLAUDE.md §3). seg 부재 = 육면체 미산출(강등).
   */
  vpd: Pick<VpdClient, 'detect'> & Partial<Pick<VpdClient, 'segment' | 'canSegment'>>;
  lpd: Pick<LpdClient, 'detect'>;
}

/** 검출 설정(loadDetectCfg 로 PtzCamRoi.json 에서 도출 + 상수). */
export interface DetectCfg {
  fovBaseV: number;
  aspect: number;
  frontBias: number;
  zoomFactors: number[];
  zoomRef: number;
}

export interface DetectPlate {
  quad: NormalizedQuad;
  confidence: number;
  /** zoom 재시도로 역투영 복원된 번호판이면 true. */
  recovered: boolean;
  /** 복원까지 소요한 zoom 재시도 회차(귀속=0). */
  attempts: number;
}

export interface DetectVehicle {
  rect: NormalizedRect;
  confidence: number;
  cls: string;
  /** 귀속/복원된 번호판(없으면 undefined). */
  plate?: DetectPlate;
}

export interface DetectResult {
  imageSize: { w: number; h: number };
  cam: number;
  preset: number;
  basePtz: { pan: number; tilt: number; zoom: number };
  vehicles: DetectVehicle[];
  /**
   * base 프레임 LPD(표시용). 모드A 에서는 **주차면 위 차량 것만** 남긴다 —
   * keepPlate = (유지된 차량에 귀속) OR (번호판 중심 ∈ 주차면 폴리곤). 후자가 점유 판정 회귀를 막는다.
   */
  plates: { quad: NormalizedQuad; confidence: number }[];
  summary: {
    /** 필터 **전** 원 검출 수(의미 불변). vehicles.length = vpdCount − filteredOut. */
    vpdCount: number;
    /** 필터 **전** 원 번호판 검출 수(의미 불변). plates.length = lpdCount − lpdFilteredOut. */
    lpdCount: number;
    recovered: number;
    /** 실제 적용된 모드(강등 시 false). */
    onPlaceOnly: boolean;
    /** 주차면 필터로 제외된 차량 수(모드B/강등 시 0). */
    filteredOut: number;
    /** 주차면 필터로 제외된 번호판 수(모드B/강등 시 0). */
    lpdFilteredOut: number;
    /** 모드A 를 요청했으나 폴리곤이 없어 강등된 사유. */
    onPlaceDegraded?: string;
  };
  /**
   * ★ 차량 3D 육면체(가산·옵셔널). `cuboidCtx` 미주입 시 **키 자체가 없다** → 기존 응답 shape 과 완전히 동일(회귀 0).
   * 산출은 base 프레임(det bbox 가 나온 **바로 그 프레임**) 기준이며 zoom 재시도 뷰는 쓰지 않는다.
   */
  cuboids?: FrameCuboids;
}

/** 모드A 옵션. 미지정 → 필터 없음(runDetect 3인자 계약 불변). */
export interface OnPlaceOpts {
  onlyOnPlace: boolean;
  /** 대상 프리셋 주차면 폴리곤(정규화). null/빈 → 강등(전량 통과). */
  polys: NormalizedPoint[][] | null;
  /** 강등 사유(호출측만 파일 부재/프리셋 0개를 구분할 수 있다). 미지정 시 일반 문구. */
  degradeReason?: string;
}

/**
 * fovBaseV 추정 실패 시 폴백(도). **zoom=1 기준** 수직 FOV.
 *
 * 이전 값 24.017 은 `PtzCamRoi.json` 의 `camera.fov` 였는데, 그것은 **zoom=1.4 에서의 fov 스냅샷**이라
 * base(zoom=1) 로 쓰면 f 가 +42% 틀린다(재중심 PTZ 가 항상 ~30% 미달 → 대상이 중심에서 평균 154px 이탈, 라이브 실측).
 * 33.1 은 **독립 3자 일치**로 고른 값이다:
 *   ① 라이브 실측(pan 2° 회전 → 픽셀 이동량 ZNCC, 프리셋 줌대역 zoom 1.4~1.9): 32.6~33.5°
 *   ② 지면모델 공동추정(poolFovBaseV, 실데이터): 33.102°
 *   ③ 설계서 GT(camera.fov=24.01697 @ zoom=1.4 역산): 33.167°
 * 폴백이 실제로 쓰이면 항상 advisory 로그를 남긴다(조용한 강등 금지 — 이 버그가 숨었던 이유).
 */
const FALLBACK_FOV_BASE_V = 33.1;
const FALLBACK_ASPECT = 16 / 9;
const FRONT_BIAS = 0.62;
const ZOOM_FACTORS = [2, 3, 4, 5];
const ZOOM_REF = 1;

/** fovBaseV 추정 소스(설계 C3 — **실카메라도 줄 수 있는 값만**). 미주입 시 폴백 상수로 강등. */
export interface DetectCfgSources {
  /** 프리셋 zoom 리드백(camerapos.json). 실 PTZ 도 주는 값. */
  cameraposFile?: string;
  /** 지면모델 추정 파라미터(tools.config `ground`). */
  ground?: GroundOptions;
}

/**
 * ★ C3(실카메라 호환): fovBaseV 를 **이미지 위의 점 + zoom 리드백**에서 추정한다.
 *
 * 이전 구현은 `PtzCamRoi.json` 의 `camera.fov` 를 읽었다. 그것은 두 가지 이유로 틀렸다:
 *   1) 실카메라는 fov 를 주지 못한다(줌 의존·대부분 미제공) — C3 위반.
 *   2) **Unity 에서도 틀린 값이었다.** `camera.fov` 는 저장 시점 카메라의 *현재* fov 스냅샷(zoom=1.4 → 24.017°)인데
 *      `FovOpts.fovBaseV` 는 **zoom=1 기준** FOV 를 뜻한다. 즉 줌이 걸린 fov 를 base 로 오인해 왔다.
 *      라이브 실측(pan 2° 회전 → 중앙부 픽셀 이동량): preset3(zoom 1.4) 실제 f≈2509px vs 구현이 가정한 f=3554px (+42%).
 *      그 결과 재중심 PTZ 가 항상 ~30% 미달해 대상이 중심에서 평균 154px 벗어났다(측정).
 *
 * 지면모델의 `poolFovBaseV` 는 카메라당 fovBaseV **하나**를 프리셋(zoom) 축으로 공동추정한다 —
 * 입력은 주차면 4점(이미지 픽셀)과 zoom 뿐이라 **실카메라에서도 그대로 성립**한다.
 * 추정 불가(소실점 실패 / zoom 미상 / ground 미주입) → null → 호출측이 폴백 상수로 강등(throw 금지).
 */
async function estimateFovBaseV(
  placeRoiJson: unknown,
  camId: number,
  sources: DetectCfgSources | undefined,
): Promise<number | null> {
  if (!sources?.ground) return null;
  let views: CameraView[] = [];
  if (sources.cameraposFile) {
    try {
      views = parseCameraViews(JSON.parse(await readFile(sources.cameraposFile, 'utf8')));
    } catch {
      /* camerapos 없음/파싱실패 → zoom 미상 → 추정 실패 → 폴백(강등) */
    }
  }
  const cam = buildGroundInputs(placeRoiJson, views).find((c) => c.camIdx === camId);
  if (!cam) return null;
  const { fovBaseV } = estimateGroundModels(cam, sources.ground);
  return fovBaseV != null && fovBaseV > 0 ? fovBaseV : null;
}

/**
 * PtzCamRoi.json 에서 검출 설정 도출(폴리곤 소스와 동일 파일 → 좌표계 일관).
 * `fovBaseV` 는 지면모델 공동추정(estimateFovBaseV), `aspect` 는 imageWidth/Height(실카메라도 주는 값).
 * **`camera.fov`/`position`/`eulerAngles` 는 읽지 않는다(C3).**
 * 파일 미설정/없음/파싱 실패/추정 실패 시 폴백 상수 + advisory 로그(UNKNOWN 강등 철학). 저빈도 on-demand — 캐시 불요.
 */
export async function loadDetectCfg(
  placeRoiFile: string | undefined,
  camId: number,
  sources?: DetectCfgSources,
): Promise<DetectCfg> {
  let fovBaseV: number | null = null;
  let aspect = FALLBACK_ASPECT;
  let reason = 'placeRoiFile 미설정';
  if (placeRoiFile) {
    reason = '지면모델 추정 불가(소실점 실패 / zoom 미상 / ground 미주입)';
    try {
      const json = JSON.parse(await readFile(placeRoiFile, 'utf8'));
      const cm = (json.cameras ?? []).find((c: any) => c?.camera?.cam_id === camId)?.camera;
      if (cm && Number(cm.imageWidth) > 0 && Number(cm.imageHeight) > 0) {
        aspect = Number(cm.imageWidth) / Number(cm.imageHeight);
      }
      fovBaseV = await estimateFovBaseV(json, camId, sources);
    } catch (err) {
      reason = `설정 소스 로드 실패: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  // 폴백은 **항상** 드러낸다 — 조용히 강등되면 fovBaseV 오류가 또 숨는다(이번 버그의 재발 방지).
  if (fovBaseV == null) {
    logger.warn(
      { camId, reason, fovBaseV: FALLBACK_FOV_BASE_V },
      'fovBaseV 폴백 상수로 강등 — 재중심/역투영 정확도 저하 가능(카메라별 실측 권장)',
    );
    fovBaseV = FALLBACK_FOV_BASE_V;
  }
  return { fovBaseV, aspect, frontBias: FRONT_BIAS, zoomFactors: ZOOM_FACTORS, zoomRef: ZOOM_REF };
}

/**
 * 대상 프리셋의 실제 PTZ(pan/tilt/zoom)를 `GET /cameras`(뷰어와 동일 소스)에서 조회.
 * 시뮬레이터 `/req_img` 는 ptz 미지정 시 기본 0/0/1 로 렌더(preset_idx 만으론 시야를 안 잡음) →
 * base 프레임 요청에 반드시 이 값을 명시해야 한다(리더 실측 확정). 조회 실패/미보유 시 null(호출측 폴백).
 */
export async function resolvePresetPtz(
  camera: Pick<CameraClient, 'listCameras'>,
  camIdx: number,
  presetIdx: number,
): Promise<{ pan: number; tilt: number; zoom: number } | null> {
  try {
    const { cameras } = await camera.listCameras();
    const cam = cameras.find((c) => c.camIdx === camIdx);
    const preset = cam?.presets.find((p) => p.presetIdx === presetIdx);
    if (preset && preset.pan != null && preset.tilt != null && preset.zoom != null) {
      return { pan: preset.pan, tilt: preset.tilt, zoom: preset.zoom };
    }
    return null;
  } catch (err) {
    logger.warn({ camIdx, presetIdx, err: err instanceof Error ? err.message : String(err) }, '프리셋 PTZ 조회 실패 → echo 폴백');
    return null;
  }
}

/**
 * 1프리셋 1회 검출(멱등). base 프레임 VPD/LPD → 매칭 → 미귀속 차량마다 zoom 재시도(zoomFactors 소진까지).
 * 재시도 성공 시 뷰 응답 실적용 viewPtz 로 base 좌표 역투영(recovered). R2 반복(프리셋 순회·10회)은 라우트 밖(리더/프론트).
 */
export async function runDetect(
  deps: DetectDeps,
  args: { cam: number; preset: number },
  cfg: DetectCfg,
  onPlace?: OnPlaceOpts,
  /** ★ 차량 육면체 문맥(옵셔널·가산). 미지정 시 응답에 `cuboids` 키 자체가 없다 — 기존 계약 완전 불변. */
  cuboidCtx?: CuboidContext | null,
): Promise<DetectResult> {
  const { cam, preset } = args;
  // 프리셋 실제 PTZ 를 신뢰 원천으로 base 프레임을 렌더(시뮬 echo 0/0/1 불신 — 리더 실측 확정).
  const presetPtz = await resolvePresetPtz(deps.camera, cam, preset);
  const base = await deps.camera.requestImage(cam, preset, presetPtz ?? undefined);
  const basePtz = presetPtz ?? { pan: base.pan, tilt: base.tilt, zoom: base.zoom }; // 조회 실패 시에만 echo 폴백(장애 격리).
  const size = readJpegSize(base.jpg);

  const rawVehicles = await deps.vpd.detect(base.jpg);
  const platesBase = await deps.lpd.detect(base.jpg);

  // 모드A: 주차면 위 차량만 남긴다. **zoom 재시도 루프 진입 전**에 축소 → 통행차에 대한 카메라 호출 0회.
  // 폴리곤 부재 시 강등(전량 통과) + warn(조용한 폴백 금지).
  let vehicles = rawVehicles;
  let onPlaceOnly = false;
  let filteredOut = 0;
  let onPlaceDegraded: string | undefined;
  if (onPlace?.onlyOnPlace) {
    const r = filterVehiclesOnPlace(rawVehicles, onPlace.polys);
    vehicles = r.kept;
    if (r.degraded) {
      onPlaceDegraded = onPlace.degradeReason ?? '주차면 폴리곤 없음';
      logger.warn({ cam, preset, reason: onPlaceDegraded }, '주차면 필터 강등 — 모든 차량 통과(모드B)');
    } else {
      onPlaceOnly = true;
      filteredOut = r.filteredOut;
    }
  }

  // ★ 차량 3D 육면체(가산). 위치는 **주차면 필터 직후 · zoom 재시도 루프 前**(루프와 무관·독립).
  //   base 프레임(det bbox 가 나온 바로 그 프레임)에서 산출한다. seg 미배선/실패 → 강등(throw 0) → `cuboids` 미포함.
  //   `deps.vpd.segment` 가 없으면(기존 스텁) 아예 시도하지 않는다.
  let cuboids: FrameCuboids | undefined;
  if (cuboidCtx && deps.vpd.segment && deps.vpd.canSegment) {
    const vpdSeg = deps.vpd as Required<Pick<VpdClient, 'segment' | 'canSegment'>>;
    cuboids = await buildFrameCuboids({
      jpeg: base.jpg,
      detBoxes: rawVehicles, // ★ 권위 — 필터 전 전량(가림 배제의 근거).
      // 참조 동일성(필터 경로 무접촉). ⚠️ **-1 을 버리지 않는다**(DEFECT-2) — 전제가 깨지면 issues 로 드러난다.
      keptDetIdx: vehicles.map((v) => rawVehicles.indexOf(v)),
      vpd: vpdSeg,
      ctx: cuboidCtx,
    });
  }

  // VPD 박스를 BuiltSlot(positionIdx/roi/confidence)로 어댑트해 기존 매칭 재사용(신규 매칭 코드 0).
  const matched = matchPlatesToSlots(
    vehicles.map((v, i) => ({ positionIdx: i, roi: v.rect, confidence: v.confidence })),
    platesBase,
  );

  // 모드A: 표시용 번호판도 주차면 위 차량 것만 남긴다(귀속 OR 주차면 내부).
  // 게이트는 **실제 적용된 모드**(onPlaceOnly) — 강등 시엔 차량과 같은 이유로 번호판도 필터하지 않는다.
  // 귀속 판정은 filterPlatesOnPlace 안에서 matchPlatesToSlots 를 한 번 더 부른다(위 matched 와 동일 입력·동일 결과).
  // 순수 O(n·m), n·m ≤ ~20 → 중복 호출을 감수한다(matched 를 넘기면 CaptureJob 에 어댑터가 복제된다).
  let plates = platesBase;
  let lpdFilteredOut = 0;
  if (onPlaceOnly) {
    const rp = filterPlatesOnPlace(platesBase, vehicles, onPlace!.polys);
    plates = rp.kept;
    lpdFilteredOut = rp.filteredOut;
  }

  const fovOpts: FovOpts = { fovBaseV: cfg.fovBaseV, zoomRef: cfg.zoomRef, aspect: cfg.aspect };
  const outVehicles: DetectVehicle[] = [];
  let recovered = 0;

  for (let i = 0; i < vehicles.length; i++) {
    const v = vehicles[i];
    const baseQuad = matched.get(i);
    if (baseQuad) {
      const conf = platesBase.find((p) => p.quad === baseQuad)?.confidence ?? 1;
      outVehicles.push({ rect: v.rect, confidence: v.confidence, cls: v.cls, plate: { quad: baseQuad, confidence: conf, recovered: false, attempts: 0 } });
      continue;
    }
    // 미귀속(번호판 없는) 차량 → 앞쪽 확대 후 LPD 재검출(최대 zoomFactors.length 회).
    let plate: DetectPlate | undefined;
    for (let a = 0; a < cfg.zoomFactors.length; a++) {
      const ptz = vehicleCenterZoomPtz(v.rect, basePtz, { ...fovOpts, frontBias: cfg.frontBias, zoomFactor: cfg.zoomFactors[a] });
      const zoom = deps.camera.clampZoom(ptz.zoom);
      const view = await deps.camera.requestImage(cam, preset, { pan: ptz.pan, tilt: ptz.tilt, zoom });
      const viewPtz = { pan: view.pan, tilt: view.tilt, zoom: view.zoom }; // 실적용값(clampZoom/스냅 반영).
      const pick = pickNearestPlate(await deps.lpd.detect(view.jpg), { x: 0.5, y: 0.5, w: 0, h: 0 });
      if (pick) {
        const recQuad = inverseProjectQuad(pick.quad, viewPtz, basePtz, fovOpts);
        // 역투영은 지면원근 오차(§04-A3)로 차량 밖에 떨어질 수 있음 → zoom-in 대상 차량(v.rect)으로 중심 클램프(표시 위치 보정).
        const clamped = clampQuadCenterToRect(recQuad, v.rect, cfg.frontBias);
        plate = { quad: clamped, confidence: pick.confidence, recovered: true, attempts: a + 1 };
        recovered += 1;
        break;
      }
    }
    outVehicles.push({ rect: v.rect, confidence: v.confidence, cls: v.cls, plate });
  }

  return {
    imageSize: { w: size.width, h: size.height },
    cam,
    preset,
    basePtz,
    vehicles: outVehicles,
    plates: plates.map((p) => ({ quad: p.quad, confidence: p.confidence })),
    summary: {
      vpdCount: rawVehicles.length,
      lpdCount: platesBase.length,
      recovered,
      onPlaceOnly,
      filteredOut,
      lpdFilteredOut,
      ...(onPlaceDegraded ? { onPlaceDegraded } : {}),
    },
    ...(cuboids ? { cuboids } : {}), // 미산출 시 **키 자체가 없다**(기존 응답 shape 불변).
  };
}
