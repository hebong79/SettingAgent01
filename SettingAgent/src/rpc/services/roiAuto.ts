// roi.auto.* 승격 서비스 — 도색선 기반 **자동 바닥 ROI**(검출 · 채점 · 정본 적용).
//
// 기존 `grid.*` 3종(웹 승인 흐름)은 **1줄도 건드리지 않는다**. 별도 네임스페이스로 병존한다(R6).
//
// ★ DB 를 아예 쓰지 않는다(R5·D-4). 슬롯 저장소 심볼(스토어 클래스·전량교체·기하갱신 함수)이 이 파일에
//   **0건**임을 `test/roiAutoSeal.test.ts` 가 정적으로 봉인한다(그래서 그 이름들을 여기 적지 않는다).
//   DB 반영이 필요하면 호출자가 기존 `slot.roi.sync` 를 별도로 부른다(자동 연쇄 금지 — 부분 적용 상태를 만들지 않기 위해).
//
// ★ D-5(리더 실측) 강제: 프레임 취득 **직전** `roi.show2d {visible:false}` 를 호출하고,
//   취득한 프레임의 초록 픽셀 비율이 임계를 넘으면 `D11_SYNTHETIC_CUE` 로 채점을 중단한다.
//   시뮬레이터가 그리는 초록 주차면 박스는 실카에 없는 합성 단서이고, 도색선을 **덮기까지 한다**
//   (리더 실측: 1:2 백색 도색 2.47% → 초록 제거 후 4.49%). 여기에 의존하면 평가가 오염된다.
//
// sharp 는 **이 계층에서만** 쓴다(저장소 관례 — 알고리즘 모듈은 Uint8Array 그레이만 받는다).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { z } from 'zod';
import {
  DEFAULT_PAINT_OPTIONS,
  detectPaintLines,
  meetLines,
  paintEvidenceOf,
  refineSeparators,
  scanSeparators,
  type FrameGray,
} from '../../ground/floorPaint.js';
import { DEFAULT_BAY_OPTS, DEGRADE, quadToNormalized, type BayQuad } from '../../ground/bayGeometry.js';
import { detectBaysWithModel, type GridDetection, type RowCandidate } from '../../ground/bayGrid.js';
import { backprojectToGround } from '../../ground/project.js';
import type { Px, Vec3 } from '../../ground/contactTypes.js';
import {
  groundModelFromIntrinsics,
  interpolateHfov,
  type CameraIntrinsicsProvider,
  type ZoomHfovPoint,
} from '../../ground/cameraIntrinsics.js';
import { baseFocalPxOf, placeMetaProvider, readPlaceMeta } from '../../ground/placeMetaIntrinsics.js';
import { scorePreset, summarize, resolveManualAssignment, type PresetScore } from '../../ground/roiAutoScore.js';
import { assertAutoPromoteSafe } from '../../ground/autoRoiPlan.js';
import { normalizePtzCamRoi, applyPlaceRoiUpdateEx, type PlaceRoiSpace } from '../../capture/placeRoi.js';
import { backupPlaceRoiPathOf, fileNameOf } from '../../capture/placeRoiPaths.js';
import { parseCameraViews, type CameraView } from '../../setup/mapTargets.js';
import { round5, stringify5 } from '../../util/round.js';
import { PRESETS } from '@parkagent/lens-calib';
import { CameraSourceClient } from '../../clients/CameraSourceClient.js';
import type { ICameraClient } from '../../clients/CameraClient.js';
import type { CameraSource } from '../../viewer/CameraSource.js';
import { RpcCode, RpcMethodError } from '../errors.js';
import type { RpcContext } from '../types.js';

/** 초록 오염 판정 임계(전체 화소 대비 비율). 초과 시 채점 중단(D-5). */
export const GREEN_RATIO_LIMIT = 0.001;

const BaseSchema = z.object({
  camId: z.number().int().positive().optional(),
  presetIdx: z.number().int().positive().optional(),
  expectedBays: z.number().int().min(1).max(200).optional(),
  slotWidthM: z.number().positive().default(2.5),
  slotDepthM: z.number().positive().default(5.0),
  /** 설정상 카메라 지상고(m). null 이면 지상고 자기검증을 끈다. */
  cameraHeightM: z.number().positive().nullable().default(5.0),
  /**
   * 다시점 합의(기본 켬). 고정 디더 6시점을 찍어 **행 선택**을 다수결한다.
   * 카메라 점유·소요시간이 6배가 되므로 단일 시점이 필요하면 false 로 끈다.
   * 잘 되는 프리셋은 만장일치라 기저 시점이 대표가 되어 결과가 **비트 동일**하다(12·13회차 실측).
   */
  consensus: z.boolean().default(true),
  /**
   * ★ 20회차 — 프레임을 **어디서** 찍는가.
   *   `preset`  = 종전. 프리셋 PTZ 로 카메라를 옮긴 뒤 찍는다.
   *   `current` = **지금 보이는 화면 그대로**. 현재 PTZ 를 읽어 그 값으로 되쓰고(무이동) 찍는다.
   *
   * 와이어 기본값이 `preset` 인 이유: `view` 를 보내지 않는 기존 호출자(테스트·도구·`realCamCapture`)의
   * 동작을 한 바이트도 바꾸지 않기 위해서다. 뷰어 「검출」 버튼은 체크박스 기본 checked 라
   * **항상 `current` 를 명시 전송**한다(사용자가 보는 기본은 신규 모드다).
   */
  view: z.enum(['preset', 'current']).default('preset'),
});

/**
 * ★ 17회차 — **프레임을 어느 소스에서 가져올지**와 **그 카메라의 제원**.
 *
 * 배경(마스터 실측 사고): `roi.auto.*` 에 소스 파라미터가 없어 뷰어가 `real-camera-2` 를 보고 있어도
 * 서버는 기동 시 고정된 `deps.camera`(= selectedCameraId = simulator-1)에서 프레임을 가져왔다.
 * **시뮬 프레임으로 계산한 사각형을 실카 화면 위에 그리고 있었다.**
 *
 * `source` 미지정이면 종전과 완전히 같은 경로(`deps.camera`)를 쓴다 — 하위호환.
 * `cameraSpec` 은 비면 자동 해석하고, 채우면 그 값이 **자동 해석보다 우선**한다.
 */
const SourceFields = z.object({
  source: z.string().min(1).optional(),
  cameraSpec: z
    .object({
      /** 설치고(m) — metric 스케일의 유일한 담지자. */
      heightM: z.number().positive().optional(),
      /** 하향 틸트(도). 지평선 기준 아래로 내려다본 각. */
      tiltDeg: z.number().optional(),
      /** 수평 화각(도) — 그 프레임의 **유효** 화각. */
      hfovDeg: z.number().positive().max(179).optional(),
      /**
       * ★ 20회차 — **기준(줌1) 수평 화각**(도). 유효 화각이 아니다. 서버가 현재 줌을 곱한다(`f = f@zoom1 × zoom`).
       * 시뮬 계열 전용 — 실카(`hucoms`)로 오면 **명시적으로 거부**한다(§실카 분기 주석).
       */
      baseHfovDeg: z.number().positive().max(179).optional(),
    })
    .optional(),
});

type CameraSpec = NonNullable<z.infer<typeof SourceFields>['cameraSpec']>;

export const RoiAutoDetectSchema = BaseSchema.merge(SourceFields);
export const RoiAutoScoreSchema = BaseSchema.merge(SourceFields);
/** ★ apply 에는 `source`·`cameraSpec` 을 배선하지 않는다(마스터 제약 — 정본 쓰기 경로는 이번 범위 밖). */
export const RoiAutoApplySchema = BaseSchema.extend({
  confirm: z.literal(true),
  presets: z.array(z.number().int().positive()).min(1),
  minIoU: z.number().min(0).max(1).default(0.98),
  expectTotal: z.number().int().nonnegative().optional(),
});

/**
 * ★ 초록 합성 단서 비율(D-5). 판정식은 리더 실측 그대로: `g>110 && g-r>55 && g-b>55`.
 * 이 함수만이 색 채널을 본다 — 검출기(`floorPaint`/`bayGeometry`)는 그레이스케일만 쓴다.
 */
export function greenPixelRatio(rgb: Uint8Array): number {
  const n = Math.floor(rgb.length / 3);
  if (n <= 0) return 0;
  let hit = 0;
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    if (g > 110 && g - r > 55 && g - b > 55) hit++;
  }
  return hit / n;
}

function placeFileOf(ctx: RpcContext): string {
  const f = ctx.deps.placeRoiFile;
  if (!f) throw new RpcMethodError(RpcCode.UNAVAILABLE, 'place-roi 미설정');
  return f;
}

/** 프레임을 준 소스 1건. `id`·`kind` 는 응답(`usedSource`)과 제원 해석 규칙을 함께 결정한다. */
interface FrameSource {
  id: string;
  kind: CameraSource['kind'] | 'unknown';
  camera: ICameraClient;
  /** 소스 객체(뷰어 단위 ↔ 네이티브 단위 환산용). 기본 경로는 없을 수 있다. */
  src: CameraSource | null;
}

/**
 * `source` 지정 시 그 소스로, 미지정이면 **종전 그대로** `ctx.deps.camera`.
 * 미지정 경로도 `selectedCameraId` 로 id·kind 를 밝혀 응답이 "어느 카메라였는지"를 말할 수 있게 한다.
 */
function resolveFrameSource(ctx: RpcContext, source?: string): FrameSource {
  if (source) {
    const src = ctx.deps.sources?.get(source);
    if (!src) {
      throw new RpcMethodError(RpcCode.INVALID_PARAMS, `source not found: ${source}`, {
        source,
        known: [...(ctx.deps.sources?.keys() ?? [])],
      });
    }
    if (!ctx.deps.cameraCfg) throw new RpcMethodError(RpcCode.UNAVAILABLE, '카메라 설정 미배선 — source 지정 불가', { source });
    return { id: source, kind: src.kind, camera: new CameraSourceClient(src, ctx.deps.cameraCfg), src };
  }
  const c = ctx.deps.camera;
  if (!c) throw new RpcMethodError(RpcCode.UNAVAILABLE, '카메라 미배선 — roi.auto.* 는 프레임이 필요합니다');
  const id = ctx.deps.selectedCameraId;
  const src = id ? ctx.deps.sources?.get(id) ?? null : null;
  return { id: id ?? '(default)', kind: src?.kind ?? 'unknown', camera: c, src };
}

/**
 * 렌즈 실측표 정본(sourceRegistry 와 같은 파일·같은 환경변수).
 * ★ 호출 시점에 읽는다(모듈 로드 시 고정 금지) — 테스트가 임시 파일로 갈아끼울 수 있어야 한다.
 */
function lensCalibFile(): string {
  return process.env.LENS_CALIB_FILE ?? 'data/lens_calibration.json';
}

/**
 * 네이티브 tiltpos 1 단위 = 0.01° (centidegree), **양수 = 아래를 봄**.
 * 두 규약 모두 `@parkagent/lens-calib` 의 `geometry.ts:3-6` 이 실기 cam-001 실측으로 확정한 것이다.
 */
const TILT_CENTIDEG_PER_DEG = 100;

/** 실카 1대의 지면모델 제원 기본값. 없는 값은 null(지어내지 않는다). */
export interface LensGroundSpec {
  /** 줌 → 수평화각 실측표. */
  zoomHfov: ZoomHfovPoint[] | null;
  /** 그 표가 어디서 왔나. 진단 문구에 그대로 실린다. 표가 없으면 null. */
  zoomHfovFrom: string | null;
  /** 설치고(m) — metric 스케일의 유일한 담지자. */
  heightM: number | null;
}

/**
 * `lens_calibration.json` 의 지면모델 제원을 읽는다.
 *
 * 화각표 우선순위 — `CameraCalibration.from`(`calibration.ts:150,153`)의 **상속 규칙과 같은 순서**다:
 *   1. `cameraSpec.zoomHfov` (이 블록 전용 실측표)
 *   2. 최상위 `zoomHfov` (lens-calib 조준 스키마 · `real-camera-1` 이 이 모양)
 *   3. `model` 이 가리키는 **내장 프리셋의 실측표** (`PRESETS[model].zoomHfov`)
 *
 * ★ 3번이 17c회차의 핵심이다. `real-camera-2` 는 `model:"cam-001"` 이고, 그 프리셋의 13점 실측표를
 *   상속하면 줌이 화각에 실제로 반영된다. 표를 이 파일에 **복제하지 않는다** — 복제하면 실측표가
 *   두 벌이 되어 갈라진다. 상속이므로 최상위 `zoomHfov` 를 얹지 않고, 따라서
 *   `centeringGain: spec.centeringGain ?? (spec.zoomHfov ? null : inherited?.centeringGain)` 규칙이
 *   끊기지 않아 **클릭 조준 게인도 그대로 살아 있다**(17b 가 `cameraSpec` 블록으로 우회하던 문제가 소멸).
 * ★ 설치고는 상속하지 않는다 — 설치고는 렌즈가 아니라 **설치 현장**의 값이라 모델 공통이 아니다.
 */
export function readGroundSpec(file: string, sourceId: string): LensGroundSpec {
  const usable = (t: readonly ZoomHfovPoint[] | undefined): t is ZoomHfovPoint[] => Array.isArray(t) && t.length > 0;
  try {
    const json = JSON.parse(readFileSync(file, 'utf8')) as {
      cameras?: Array<{ id?: string; model?: string; zoomHfov?: ZoomHfovPoint[]; cameraSpec?: { zoomHfov?: ZoomHfovPoint[]; heightM?: number } }>;
    };
    const entry = json.cameras?.find((c) => c.id === sourceId);
    const own = entry?.cameraSpec?.zoomHfov ?? entry?.zoomHfov;
    const inherited = entry?.model ? PRESETS[entry.model]?.zoomHfov : undefined;
    const h = entry?.cameraSpec?.heightM;
    return {
      zoomHfov: usable(own) ? own : usable(inherited) ? inherited : null,
      zoomHfovFrom: usable(own) ? 'lens_calibration 실측표' : usable(inherited) ? `model:${entry!.model} 내장 실측표` : null,
      heightM: typeof h === 'number' && h > 0 ? h : null,
    };
  } catch {
    return { zoomHfov: null, zoomHfovFrom: null, heightM: null };
  }
}

/**
 * 제원 해석기 — **소스 종류마다 다르고, 모자라면 검출하지 않는다**.
 *
 * ★ 이 라운드의 핵심 안전장치: 실카에 시뮬 정본(`PtzCamRoi.json`)의 fov·tilt·설치고를 조용히 물려주던
 *   폴백을 없앤다. 없는 값은 없다고 말한다 — 3회차에 초점거리 오차가 IoU 를 0 으로 만든 전례가 있다.
 */
interface IntrinsicsResolver {
  /** 프레임을 찍기 **전에** 확정되는 거부 사유. null 이면 검출을 진행한다. */
  reject: { missing: string[]; note: string } | null;
  /** bayGrid 지상고 자기검증에 쓸 설치고(m). null 이면 자기검증을 끈다. */
  cameraHeightM: number | null;
  /** 프레임 제원(크기·네이티브 PTZ)으로 공급자 생성. 만들 수 없으면 null. */
  providerFor(f: FrameSpec): CameraIntrinsicsProvider | null;
  /**
   * **검출은 하되 결과 해석에 반드시 필요한 사실**(거부는 아니다). 프레임의 줌을 봐야 정해지므로
   * `providerFor` 와 같은 인자를 받는다. 조용히 두면 나중에 원인 불명 실패가 된다.
   */
  warningsFor?(f: FrameSpec): string[];
}

/** 프레임 1장이 확정해 주는 값들 — 제원 해석의 입력. */
interface FrameSpec {
  imgW: number;
  imgH: number;
  /** 렌즈 실측표 조회 키(네이티브 zoompos). 소스가 환산기를 주지 않으면 null. */
  zoomRaw: number | null;
  /** 네이티브 tiltpos(centidegree 가정). 소스가 환산기를 주지 않으면 null. */
  tiltRaw: number | null;
}

/**
 * 수동 지정 덮어쓰기. **지정 필드가 없으면 원본을 그대로 돌려준다**(시뮬 경로 회귀 0).
 * 설치고는 `placeMetaProvider` 의 heightOverrideM 이 이미 담당하므로 여기서는 화각·틸트만 본다.
 */
function withSpec(base: CameraIntrinsicsProvider, spec?: CameraSpec): CameraIntrinsicsProvider {
  if (!spec || (spec.hfovDeg == null && spec.tiltDeg == null)) return base;
  const marks = [spec.hfovDeg != null ? `hfov ${spec.hfovDeg}°` : null, spec.tiltDeg != null ? `tilt ${spec.tiltDeg}°` : null]
    .filter(Boolean)
    .join(', ');
  return {
    id: `${base.id}+spec`,
    get(camIdx, presetIdx) {
      const i = base.get(camIdx, presetIdx);
      if (!i) return null;
      return {
        ...i,
        ...(spec.hfovDeg != null ? { fovDeg: spec.hfovDeg, fovAxis: 'horizontal' as const } : {}),
        ...(spec.tiltDeg != null ? { tiltDeg: spec.tiltDeg } : {}),
        source: `${i.source}+수동지정(${marks})`,
      };
    },
  };
}

/** 실카 제원 미상 사유(무엇이 왜 없는가). 문구가 그대로 화면·응답에 실린다. */
/**
 * ★ 21회차 D2 — 사용자가 「틸트」 칸에 적은 값이 **이 프레임의 뷰어 tilt 표시값 그대로**인가.
 *
 * 판정은 추측이 아니라 **왕복 검산**이다: 적은 값을 소스 자신의 `toNativePtz` 로 네이티브로 되돌려
 * 이 프레임의 `tiltpos`(PTZ 피드백)와 일치하는지 본다. 일치하면 그것은 각도가 아니라 range-fit 위치이며
 * (뷰어 tilt −29.9781818 ↔ tiltpos 1668 실측), 일치하지 않으면 사용자가 **실제 각도**를 적은 것이므로
 * 손대지 않는다. 허용 오차 1 tiltpos = 0.01° — UI 왕복 반올림만 흡수한다.
 */
function specTiltEqualsViewerTilt(fs: FrameSource, spec: CameraSpec | undefined, tiltRaw: number | null): boolean {
  if (spec?.tiltDeg == null || tiltRaw == null || !fs.src) return false;
  // ★ 조건을 좁힌다 — 세 개가 **동시에** 성립할 때만 "표시값을 옮겨 적었다"고 판정한다.
  //   ① 그 값이 하향 각도로 **쓸 수 없다**(0 이하). 양수면 그럴듯한 하향 각도이므로 손대지 않고 경고만 한다.
  //   ② 환산기가 **항등이 아니다**. 항등이면 "표시값"과 "네이티브 각도"를 구분할 근거가 없다.
  //   ③ 환산 결과가 이 프레임의 tiltpos 와 일치한다(±1 tiltpos = 0.01°).
  if (spec.tiltDeg > 0) return false;
  try {
    const n = fs.src.toNativePtz({ pan: 0, tilt: spec.tiltDeg, zoom: 1 }) as { tilt?: unknown };
    if (typeof n?.tilt !== 'number' || !Number.isFinite(n.tilt)) return false;
    if (Math.abs(n.tilt - spec.tiltDeg) < 1e-9) return false; // 항등 환산 — 판정 불가.
    return Math.abs(n.tilt - tiltRaw) <= 1;
  } catch {
    return false;
  }
}

/** 자동 해석값과 수동 입력이 이 비율 이상 다르면 경고한다(16-19회차 인계서 §0-1 미착수 항목). */
const SPEC_MISMATCH_WARN_RATIO = 0.15;
/** 틸트 자동값과 수동 입력의 경고 임계(도). 설치 실측 오차를 넘는 크기다. */
const TILT_MISMATCH_WARN_DEG = 3;

function realMissing(sourceId: string, spec: CameraSpec | undefined, table: ZoomHfovPoint[] | null, heightM: number | null): string[] {
  const missing: string[] = [];
  if (spec?.hfovDeg == null && !table) {
    missing.push(
      `수평화각 — data/lens_calibration.json 의 "${sourceId}" 항목에 zoomHfov 실측표가 없고 model 로 상속할 내장 프리셋도 없다(초점거리 산출 불가)`,
    );
  }
  // ★ 틸트는 여기서 보지 않는다 — 프레임의 PTZ 피드백에서 오므로 촬영 전에는 알 수 없다.
  //   끝내 못 읽으면 providerFor 가 null 을 돌려 기존 "카메라 제원 공급 실패" 강등으로 떨어진다.
  if (!(heightM != null && heightM > 0)) {
    missing.push(
      `설치고 — data/lens_calibration.json 의 "${sourceId}" 항목에 cameraSpec.heightM 이 없다(시뮬 정본의 설치고는 이 카메라의 값이 아니다)`,
    );
  }
  return missing;
}

/**
 * 소스 종류 → 제원 해석기.
 * · 실카(`hucoms`)가 **아닌** 전부(`sim`·`rpc`·미상) → 종전 그대로 `placeMetaProvider`(정본 카메라 메타).
 *   시뮬 계열은 `SimulatorSource`(sim)·`CameraposSource`/`RpcCameraSource`(rpc)로 갈리므로 `sim` 만 보면 샌다.
 * · `hucoms`(실카) → 렌즈 실측표 + 수동 지정. 모자라면 **거부**(시뮬 값 대체 금지).
 */
function resolverFor(
  fs: FrameSource,
  json: unknown,
  p: z.infer<typeof BaseSchema>,
  spec?: CameraSpec,
): IntrinsicsResolver {
  if (fs.kind !== 'hucoms') {
    const base = placeMetaProvider(readPlaceMeta(json), spec?.heightM != null ? { heightOverrideM: spec.heightM } : undefined);
    const provider = withSpec(base, spec);
    return { reject: null, cameraHeightM: spec?.heightM ?? p.cameraHeightM, providerFor: () => provider };
  }
  const cfg = readGroundSpec(lensCalibFile(), fs.id);
  // ★ UI 입력이 있으면 **항상 그것이 이긴다** — 자동 해석(파일·PTZ 피드백)은 비어 있을 때만 쓴다.
  const table = spec?.hfovDeg == null ? cfg.zoomHfov : null;
  const heightM = spec?.heightM ?? cfg.heightM;
  const missing = realMissing(fs.id, spec, cfg.zoomHfov, heightM);
  // ★ 20회차 — 조용한 재해석 금지. 실카 `zoomHfov` 실측표는 **이미 유효 화각**이고, 뷰어 zoom(1~36)과
  //   실카 광학 배율의 관계는 **미측정**이라 `×zoom` 을 적용할 근거가 없다. 값을 받아 무시하지 않고 거부한다.
  if (spec?.baseHfovDeg != null) {
    missing.push(
      `기준 수평화각(baseHfovDeg) — 실카 "${fs.id}" 에는 적용하지 않는다. 실카의 zoomHfov 실측표는 이미 그 줌에서의 ` +
        '유효 화각이고 뷰어 zoom 과 광학 배율의 관계는 미측정이다. 유효 수평화각을 hfovDeg 로 입력하라.',
    );
  }
  return {
    reject: missing.length
      ? {
          missing,
          note:
            `실카 "${fs.id}" 의 카메라 제원이 모자라 검출을 수행하지 않았다. ` +
            '시뮬 정본(PtzCamRoi.json)의 화각·틸트·설치고로 대체하지 않는다 — 그 값은 이 카메라의 값이 아니다. ' +
            '패널의 카메라 제원 입력(설치고·틸트·수평화각)을 채우면 그 값으로 검출한다.',
        }
      : null,
    cameraHeightM: heightM,
    providerFor: ({ imgW, imgH, zoomRaw, tiltRaw }) => {
      const hfov = spec?.hfovDeg ?? (table && zoomRaw != null ? interpolateHfov(table, zoomRaw) : null);
      // 틸트는 PTZ 피드백(네이티브 tiltpos)에서 온다. 단위·부호 규약은 §"틸트 출처" 주석 참조.
      //
      // ★ 21회차 D2 — **뷰어 PTZ 패널의 tilt 를 이 칸에 그대로 옮겨 적는 함정**(마스터 실제 사례).
      //   그 값은 각도가 아니라 네이티브 tiltpos 를 [-90,90] 에 선형 range-fit 한 **위치**다(§nativePtzOf).
      //   실측(real-camera-1, 2026-07-30): 뷰어 tilt −29.9781818 ↔ 네이티브 tiltpos 1668 = **하향 16.68°**.
      //   음수를 그대로 쓰면 지면 법선이 뒤집혀 `groundModelFromIntrinsics` 가 null → `D5_VP_DEGENERATE`.
      //
      //   ★ 부호를 뒤집지도(abs) 않고 조용히 고치지도 않는다. **그 값이 이 프레임의 뷰어 tilt 인지
      //     소스 자신의 환산기로 되돌려 확인**하고, 확인된 경우에만 "미지정"으로 강등해 장비 tiltpos 를 쓴다.
      //     확인 근거가 없으면(= 사용자가 실제로 각도를 적었다면) 손대지 않는다 — 상향 시선을 조용히
      //     하향으로 바꾸는 은닉을 만들지 않기 위해서다. 강등하면 그 사실을 ⚠ 로 크게 남긴다.
      //     ("부호만 뒤집기"는 기각: 실측에서 +29.978° 는 참값 16.68° 보다 13.2982° 과대다.)
      const tiltIsViewerReadout = specTiltEqualsViewerTilt(fs, spec, tiltRaw);
      const tiltDeg =
        spec?.tiltDeg == null || tiltIsViewerReadout
          ? tiltRaw != null
            ? tiltRaw / TILT_CENTIDEG_PER_DEG
            : null
          : spec.tiltDeg;
      if (hfov == null || tiltDeg == null || !(heightM != null && heightM > 0)) return null;
      const hfovFrom =
        spec?.hfovDeg != null ? `hfov ${spec.hfovDeg}° 수동지정` : `zoomHfov@z=${zoomRaw}→${hfov.toFixed(3)}°←${cfg.zoomHfovFrom}`;
      const tiltFrom =
        spec?.tiltDeg != null && !tiltIsViewerReadout
          ? `tilt ${spec.tiltDeg}° 수동지정`
          : `tilt ${tiltDeg}°←PTZ tiltpos ${tiltRaw}/100${tiltIsViewerReadout ? '(입력값이 뷰어 표시값과 같아 미지정 처리)' : ''}`;
      const heightFrom = spec?.heightM != null ? `설치고 ${heightM}m 수동지정` : `설치고 ${heightM}m←lens_calibration.cameraSpec`;
      return {
        id: `real(${fs.id})`,
        get: (camIdx, presetIdx) => ({
          camIdx,
          presetIdx,
          fovDeg: hfov,
          fovAxis: 'horizontal',
          tiltDeg,
          heightM,
          imgW,
          imgH,
          source: `real:${fs.id}(${hfovFrom}, ${tiltFrom}, ${heightFrom})`,
        }),
      };
    },
    warningsFor: ({ zoomRaw, tiltRaw }) => {
      const w: string[] = [];
      const tiltIsViewerReadoutW = specTiltEqualsViewerTilt(fs, spec, tiltRaw);
      // ★ 표 **밖**이면 `interpolateHfov` 가 양 끝으로 클램프한다 — 그 프레임의 화각은 보간이 아니라
      //   가장 가까운 앵커 값이다. 표 안이면 줌이 정상 반영되므로 아무 말도 하지 않는다.
      //   (단일점 표는 lo=hi 라 이 조건 하나로 함께 걸린다.)
      if (table && zoomRaw != null) {
        const zs = table.map((p) => p.z).filter((z) => Number.isFinite(z));
        const lo = Math.min(...zs);
        const hi = Math.max(...zs);
        if (zs.length > 0 && (zoomRaw < lo || zoomRaw > hi)) {
          w.push(
            `⚠ 네이티브 줌 ${zoomRaw} 이 "${fs.id}" 의 zoomHfov 실측표 범위 [${lo}, ${hi}] 밖이라 화각을 끝점으로 ` +
              `**클램프**했다(${interpolateHfov(table, zoomRaw)?.toFixed(3)}°). 그 줌의 실제 화각이 아니므로 주차면 크기가 어긋난다 — ` +
              '표를 그 줌까지 확장하거나 패널의 수평화각을 직접 입력하라.',
          );
        }
      }
      // ★ 21회차 D3 — **자동 해석값과 수동 입력이 크게 다르면 경고**(16-19회차 인계서 §0-1 미착수 항목).
      //   마스터가 정확히 이 함정을 밟았다: 「수평화각(유효)」에 58 을 넣었는데 이 카메라의 실측표는
      //   현재 줌에서 34.931° 를 준다(real-camera-1, z=4956 실측) → f 3051.1px 대신 1731.9px(0.568배).
      //   수동 입력이 이기는 규약은 그대로 두고(조용한 재해석 금지) **차이를 크게 알린다.**
      if (spec?.hfovDeg != null && cfg.zoomHfov && zoomRaw != null) {
        const auto = interpolateHfov(cfg.zoomHfov, zoomRaw);
        if (auto != null && auto > 0 && Math.abs(spec.hfovDeg - auto) / auto > SPEC_MISMATCH_WARN_RATIO) {
          const fOf = (deg: number) => 1 / Math.tan((deg * Math.PI) / 360); // 폭 무관 비율 비교용.
          w.push(
            `⚠ 수평화각 수동 입력 ${spec.hfovDeg}° 가 이 카메라의 실측표 자동값 ${auto.toFixed(3)}°(네이티브 zoom ${zoomRaw}) 와 ` +
              `크게 다르다 — 초점거리가 **${(fOf(spec.hfovDeg) / fOf(auto)).toFixed(4)}배**로 어긋나 주차면 크기·거리가 함께 틀어진다. ` +
              `입력값이 이기므로 **입력값으로 계산했다**. 광각단 사양값(예 58°)을 유효 화각으로 쓰지 마라 — 칸을 비우면 실측표가 쓰인다.`,
          );
        }
      }
      // ★ 21회차 D2 — 뷰어 표시 tilt 를 그대로 적은 경우(왕복 검산으로 확인) · 자동값과 크게 다른 경우.
      if (tiltIsViewerReadoutW && tiltRaw != null) {
        w.push(
          `⚠ 틸트 입력 ${spec?.tiltDeg}° 는 **뷰어 PTZ 패널의 표시값**과 같다. 그 값은 각도가 아니라 네이티브 tiltpos 를 ` +
            `[-90,90] 에 선형 range-fit 한 위치다 — 그대로 쓰면 하향이 음수가 되어 지면 법선이 뒤집힌다(f 산출 불가). ` +
            `그래서 **미지정으로 처리하고 장비 tiltpos ${tiltRaw} ÷ 100 = ${tiltRaw / TILT_CENTIDEG_PER_DEG}° 를 썼다.** ` +
            `이 칸은 **비워 두는 것이 정답**이다(장비 피드백이 자동으로 쓰인다). 실측 각도를 알면 하향을 **양수**로 적어라.`,
        );
      } else if (spec?.tiltDeg != null && tiltRaw != null) {
        const auto = tiltRaw / TILT_CENTIDEG_PER_DEG;
        if (Math.abs(spec.tiltDeg - auto) > TILT_MISMATCH_WARN_DEG) {
          w.push(
            `⚠ 틸트 수동 입력 ${spec.tiltDeg}° 가 장비 피드백 자동값 ${auto}°(tiltpos ${tiltRaw} ÷ 100) 와 ` +
              `${Math.abs(spec.tiltDeg - auto).toFixed(4)}° 다르다. 입력값이 이기므로 **입력값으로 계산했다** — ` +
              `자동값이 맞다면 칸을 비워라. (하향은 **양수** 규약: @parkagent/lens-calib geometry.ts:3-6)`,
          );
        }
        if (!(spec.tiltDeg > 0)) {
          w.push(
            `⚠ 틸트 입력 ${spec.tiltDeg}° 가 0 이하다 = **상향 시선**으로 해석된다. 지면이 시선 아래에 없으므로 ` +
              `초점거리·지면모델을 세울 수 없다(D5_VP_DEGENERATE). 부호를 자동으로 뒤집지 않는다 — 진짜 상향 카메라를 ` +
              `조용히 하향으로 바꾸지 않기 위해서다. 하향이면 **양수**로 적거나 칸을 비워라.`,
          );
        }
      }
      // 틸트 규약은 확정 사실이라 ⚠ 가 아니다. 다만 쓴 값의 출처는 그대로 노출한다.
      if (spec?.tiltDeg == null && tiltRaw != null) {
        w.push(
          `하향 틸트 ${tiltRaw / TILT_CENTIDEG_PER_DEG}° = 네이티브 tiltpos ${tiltRaw} ÷ 100. ` +
            'centidegree 단위와 **양수 = 아래** 부호는 실기 cam-001 실측으로 확정된 규약이다' +
            '(@parkagent/lens-calib `geometry.ts:3-6`).',
        );
      }
      return w;
    },
  };
}

/**
 * `f = f@zoom1 × zoom` 규칙이 **실측으로 검산된 줌 구간**. 이 밖의 f 정확도는 미측정이다(추정하지 않는다).
 * 근거: 시뮬 5프리셋의 zoom 최소 1.0000(1:3) ~ 최대 1.80643(2:1·2:2).
 * ★ 상단이 1.80644 인 이유(구현자 실측): 정본이 `1.80643` 이라도 `cam.getPTZ` 는 float32 왕복 뒤
 *   **1.8064301** 을 돌려준다. 1.80643 을 그대로 상단으로 쓰면 앵커 프리셋 그 자리에서 "외삽" 오경고가 뜬다.
 */
const ZOOM_ANCHOR_RANGE: readonly [number, number] = [1.0, 1.80644];

/**
 * `baseFocalPxOf` 프리셋 간 산포 경고 임계(px). **구현자 실측으로 정한 값**이다 —
 * 시뮬 실측 산포가 cam1 0.13px · cam2 0.00px 이므로 1px 이면 "규칙이 상수다"를 두 자릿수 여유로 확인하면서도
 * 규칙이 깨지는 카메라를 놓치지 않는다(설계서 M7 의 근거 없는 5px 를 실측으로 대체).
 * **거부가 아니라 경고**다 — 판단은 사람에게 넘긴다.
 */
const BASE_FOCAL_SPREAD_WARN_PX = 1;

const DEG = Math.PI / 180;

/**
 * 현재뷰 제원 해석기(시뮬 계열 전용 — 실카는 `resolverFor` 의 hucoms 분기를 그대로 쓴다).
 *
 * 종전과의 차이는 두 가지뿐이다:
 *   · 화각: 프리셋별 유효 화각(정본) → **기준(줌1) 수평화각 × 현재 zoom**(`fovAtZoom:'zoom1'`)
 *   · 틸트: 프리셋 `eulerAngles[0]` → **`cam.getPTZ` 의 현재 tilt**
 * 설치고는 현행 규칙 그대로다(수동 지정 > 카메라 메타).
 *
 * 기준 초점거리 공급원은 ① `cameraSpec.baseHfovDeg`(UI) ② `baseFocalPxOf`(프리셋 메타 파생) 순이고,
 * 둘 다 없으면 **거부**한다(시뮬 기본값으로 지어내지 않는다).
 */
function currentViewResolver(
  json: unknown,
  p: z.infer<typeof BaseSchema>,
  camId: number,
  ptzNow: { pan: number; tilt: number; zoom: number },
  spec?: CameraSpec,
): IntrinsicsResolver {
  const meta = readPlaceMeta(json);
  const base = baseFocalPxOf(meta, camId);
  const camMeta = meta.cameras.find((c) => c.camera.camIdx === camId)?.camera ?? null;
  const heightM = spec?.heightM ?? camMeta?.heightM ?? null;
  const tiltDeg = spec?.tiltDeg ?? ptzNow.tilt;
  const missing: string[] = [];
  if (spec?.baseHfovDeg == null && !base) {
    missing.push(
      `기준 수평화각 — cam${camId} 의 프리셋 메타에서 줌1 초점거리를 파생할 수 없다(fov·zoom 결측). ` +
        '패널의 「기준 수평화각(줌1)」 을 직접 입력하라.',
    );
  }
  if (!(heightM != null && heightM > 0)) missing.push(`설치고 — cam${camId} 의 카메라 메타에 설치고가 없다.`);
  return {
    reject: missing.length
      ? { missing, note: `현재 화면 그대로 검출(cam${camId})의 카메라 제원이 모자라 검출을 수행하지 않았다.` }
      : null,
    cameraHeightM: spec?.heightM ?? p.cameraHeightM,
    providerFor: ({ imgW, imgH }) => {
      // 기준 f 는 화각 축·해상도와 무관한 값이라 왕복(f→hfov→f)이 정확하다.
      const baseHfovDeg = spec?.baseHfovDeg ?? (base ? (2 * Math.atan(imgW / 2 / base.fBasePx)) / DEG : null);
      if (baseHfovDeg == null || !(heightM != null && heightM > 0)) return null;
      const hfovFrom =
        spec?.baseHfovDeg != null ? `기준화각 ${spec.baseHfovDeg}° 수동지정` : `기준화각 ${baseHfovDeg.toFixed(5)}°←${base!.from}`;
      const tiltFrom = spec?.tiltDeg != null ? `tilt ${spec.tiltDeg}° 수동지정` : `tilt ${tiltDeg}°←cam.getPTZ`;
      return {
        id: `current-view(cam${camId})`,
        get: (camIdx, presetIdx) => ({
          camIdx,
          presetIdx,
          fovDeg: baseHfovDeg,
          fovAxis: 'horizontal',
          fovAtZoom: 'zoom1',
          tiltDeg,
          heightM,
          imgW,
          imgH,
          source: `current-view(${hfovFrom} @zoom1, ${tiltFrom}, 설치고 ${heightM}m)`,
        }),
      };
    },
    warningsFor: () => {
      const w: string[] = [];
      if (base) {
        w.push(
          `기준 초점거리 f@zoom1 ${base.fBasePx.toFixed(3)}px ← ${base.from} · ` +
            `프리셋 표본 ${base.samples.length}개 산포 ${base.spreadPx.toFixed(3)}px`,
        );
        if (base.spreadPx > BASE_FOCAL_SPREAD_WARN_PX) {
          w.push(
            `⚠ 기준 초점거리 산포가 ${base.spreadPx.toFixed(3)}px 로 ${BASE_FOCAL_SPREAD_WARN_PX}px 를 넘는다 — ` +
              '`f = f@zoom1 × zoom` 규칙이 이 카메라에서 성립하지 않을 수 있다(주차면 크기가 줌에 따라 어긋난다).',
          );
        }
      }
      if (ptzNow.zoom < ZOOM_ANCHOR_RANGE[0] || ptzNow.zoom > ZOOM_ANCHOR_RANGE[1]) {
        w.push(
          `⚠ 줌 외삽 — 현재 zoom ${ptzNow.zoom} 이 \`f = f@zoom1 × zoom\` 규칙의 검산 구간 ` +
            `[${ZOOM_ANCHOR_RANGE[0]}, ${ZOOM_ANCHOR_RANGE[1]}] 밖이다. 그 밖에서의 f 정확도는 **미측정**이다.`,
        );
      }
      return w;
    },
  };
}

/** camerapos.json 의 프리셋 PTZ. 파일 없음/파싱 실패 → 빈 목록(기존 라우트와 같은 강등 규약). */
function loadViews(ctx: RpcContext): CameraView[] {
  const f = ctx.deps.cameraposFile;
  if (!f || !existsSync(f)) return [];
  try {
    return parseCameraViews(JSON.parse(readFileSync(f, 'utf-8')));
  } catch {
    return [];
  }
}

/** 프리셋 대상 1건. */
interface Target {
  key: string;
  camId: number;
  presetIdx: number;
  manual: PlaceRoiSpace[];
  ptz: { pan: number; tilt: number; zoom: number } | null;
}

/** 정본 프리셋 목록 → 채점 대상. camId/presetIdx 지정 시 필터. */
function targetsOf(json: unknown, views: readonly CameraView[], camId?: number, presetIdx?: number): Target[] {
  const { byPreset } = normalizePtzCamRoi(json);
  const out: Target[] = [];
  for (const key of [...byPreset.keys()].sort()) {
    const [c, p] = key.split(':').map(Number);
    if (!Number.isFinite(c) || !Number.isFinite(p)) continue;
    if (camId != null && c !== camId) continue;
    if (presetIdx != null && p !== presetIdx) continue;
    const v = views.find((w) => w.camIdx === c && w.presetIdx === p);
    out.push({
      key,
      camId: c,
      presetIdx: p,
      manual: byPreset.get(key) ?? [],
      ptz: v && v.pan != null && v.tilt != null && v.zoom != null ? { pan: v.pan, tilt: v.tilt, zoom: v.zoom } : null,
    });
  }
  out.sort((a, b) => a.camId - b.camId || a.presetIdx - b.presetIdx);
  return out;
}

/**
 * 현재뷰 대상 1건 — **정본의 주차면을 전혀 읽지 않는다**(`manual: []`).
 * 실카처럼 프리셋 정의가 없는 소스에서도 성립하는 이유가 이것이다.
 *
 * ★ `ptz` 에 **방금 읽은 현재 PTZ 를 그대로** 담는다. `grabFrame` 이 그 값으로 `requestImage` 를 부르면
 *   `mode:'manual'` 이 되어 `cam.setPTZ(같은 값)` 뒤 캡처한다 = **이동 0**.
 *   ptz 를 비우면 `mode:'preset'` 이 되고 그쪽은 프리셋 PTZ 로 **실제로 카메라를 옮긴다**(CameraposSource:56 /
 *   RpcCameraSource:76 `preset.select`). "ptz 를 안 넘기면 안 움직인다"는 거짓이다.
 */
function currentTargetOf(camId: number, presetIdx: number, ptzNow: { pan: number; tilt: number; zoom: number }): Target {
  return { key: `${camId}:current`, camId, presetIdx, manual: [], ptz: ptzNow };
}

/**
 * 뷰어 PTZ → 소스 네이티브 PTZ(렌즈 실측표의 조회 키 zoompos, 그리고 tiltpos).
 * 소스가 뷰어 단위로 준 값을 **그 소스 자신의 환산기**로 되돌리는 것이라 단위 가정을 하지 않는다.
 *
 * ★ 틸트 출처: `RealPtzSource.fromNativePtz` 는 네이티브 tiltpos 를 뷰어 [-90,90] 에 **선형 range-fit**
 *   한 것이라 뷰어 tilt 자체는 각도가 아니다(네이티브 0 → 뷰어 −57.27°). 그래서 그 역함수로 **네이티브로
 *   되돌린 뒤** centidegree 로 읽는다(사양서 §8.1 tiltRange −2000~9000, pan 0~35999 = 0.00~359.99° 와 동일 단위족).
 *   왕복이 정확한 이유: 두 방향 모두 같은 `mapRange` 라 클램프 구간 밖에서 정확한 역이다.
 */
function nativePtzOf(
  fs: FrameSource,
  cap: { pan: number; tilt: number; zoom: number },
): { zoom: number | null; tilt: number | null } {
  if (!fs.src) return { zoom: null, tilt: null };
  try {
    const n = fs.src.toNativePtz({ pan: cap.pan, tilt: cap.tilt, zoom: cap.zoom }) as { zoom?: unknown; tilt?: unknown };
    return {
      zoom: typeof n?.zoom === 'number' && Number.isFinite(n.zoom) ? n.zoom : null,
      tilt: typeof n?.tilt === 'number' && Number.isFinite(n.tilt) ? n.tilt : null,
    };
  } catch {
    return { zoom: null, tilt: null };
  }
}

/** 프레임 1장 취득 — `roi.show2d{visible:false}` 선행 + 초록 오염 검사 + 그레이 변환. */
async function grabFrame(
  ctx: RpcContext,
  fs: FrameSource,
  t: Target,
): Promise<{
  frame: FrameGray;
  greenRatio: number;
  zoom: number;
  zoomRaw: number | null;
  tiltRaw: number | null;
  contaminated: boolean;
  frameHash: string;
}> {
  // D-5 ①: 합성 단서(초록 주차면 박스) 제거. Unity RPC 미배선이면 조용히 건너뛰지 않고 아래 초록 가드가 잡는다.
  // ★ 실카에는 의미가 없는 시뮬 전용 메서드라 부르지 않는다(F2 — 초록 박스는 시뮬만 렌더한다).
  if (ctx.deps.unityRpc && fs.kind !== 'hucoms') {
    try {
      await ctx.deps.unityRpc.callRpc('roi.show2d', { visible: false });
    } catch {
      /* 시뮬레이터가 아닌 환경에는 이 메서드가 없다 — 초록 가드가 최종 판정한다. */
    }
  }
  let cap;
  try {
    // ★ 실카에는 PTZ 이동 명령을 보내지 않는다(마스터가 조작 중일 수 있다) — 현재 위치 그대로 캡처한다.
    cap = await fs.camera.requestImage(t.camId, t.presetIdx, fs.kind === 'hucoms' ? undefined : t.ptz ?? undefined);
  } catch (err) {
    throw new RpcMethodError(RpcCode.UPSTREAM, `${t.key}: 프레임 취득 실패`, { detail: (err as Error).message });
  }
  const img = sharp(cap.jpg);
  const meta = await img.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!(width > 0 && height > 0)) throw new RpcMethodError(RpcCode.UPSTREAM, `${t.key}: 프레임 크기 불명`);
  const rgbBuf = await sharp(cap.jpg).removeAlpha().raw().toBuffer();
  const greenRatio = greenPixelRatio(new Uint8Array(rgbBuf.buffer, rgbBuf.byteOffset, rgbBuf.byteLength));
  const grayBuf = await sharp(cap.jpg).greyscale().raw().toBuffer();
  const native = nativePtzOf(fs, cap);
  return {
    frame: { data: new Uint8Array(grayBuf.buffer, grayBuf.byteOffset, grayBuf.byteLength), width, height },
    greenRatio,
    zoom: cap.zoom,
    zoomRaw: native.zoom,
    tiltRaw: native.tilt,
    contaminated: greenRatio > GREEN_RATIO_LIMIT,
    frameHash: createHash('sha256').update(cap.jpg).digest('hex').slice(0, 12),
  };
}

/** 검출 1회분 결과(라우트 응답·채점 공용). */
interface DetectOutcome {
  target: Target;
  imgW: number;
  imgH: number;
  greenRatio: number;
  /**
   * ★ 14회차 — 채점에 쓴 **프레임의 지문**(sha256 앞 12자리).
   *
   * 시뮬레이터 씬은 정지해 있지 않다(14회차 실측: 같은 PTZ 3분간 9종 프레임). 같은 알고리즘·같은
   * PTZ 라도 잡힌 프레임이 다르면 IoU 가 크게 달라진다. **해시 없는 IoU 수치는 해석할 수 없다.**
   */
  frameHash: string | null;
  grid: GridDetection | null;
  focalPx: number | null;
  intrinsicsSource: string | null;
  lines: number;
  issues: string[];
}

/**
 * ★ 13회차 — **다시점 합의** 디더 집합. 고정·결정론(집합·순회 순서 불변, 기저(0,0)가 항상 첫째).
 *
 * 근거(9·12회차 실측): `2:2` 는 기저 PTZ 에서 0.0000 인데 pan −1.5° 에서 0.9440 이다.
 * 검출·기하가 실패한 게 아니라 **행 선별이 임계에 걸린 불운한 배치**다. 같은 행을 몇 도 다르게 보고
 * 다수결하면 임계를 벗어난다. 도구 레벨 실측: 평균 0.56883 → 0.75668, 그리고 잘 되는 프리셋
 * (`1:1`·`2:1`)은 **6시점 만장일치라 기저가 그대로 대표**가 되어 수치가 비트 동일하다.
 */
const DITHER: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [-1.5, 0],
  [1.5, 0],
  [0, -0.8],
  [0, 0.8],
  [1.0, 0.6],
];

/** 변주 시점 지면좌표 → 기저 시점 지면좌표(12회차 역변환과 동일). */
function toBaseFrame(X: Vec3, n0: Vec3, dPanDeg: number, dTiltDeg: number): Vec3 {
  const dt = -(dTiltDeg * Math.PI) / 180;
  const ct = Math.cos(dt);
  const st = Math.sin(dt);
  const X1: Vec3 = [X[0], X[1] * ct - X[2] * st, X[1] * st + X[2] * ct];
  const dp = (dPanDeg * Math.PI) / 180;
  const cp = Math.cos(dp);
  const sp = Math.sin(dp);
  const dot = n0[0] * X1[0] + n0[1] * X1[1] + n0[2] * X1[2];
  const cr: Vec3 = [n0[1] * X1[2] - n0[2] * X1[1], n0[2] * X1[0] - n0[0] * X1[2], n0[0] * X1[1] - n0[1] * X1[0]];
  return [
    X1[0] * cp + cr[0] * sp + n0[0] * dot * (1 - cp),
    X1[1] * cp + cr[1] * sp + n0[1] * dot * (1 - cp),
    X1[2] * cp + cr[2] * sp + n0[2] * dot * (1 - cp),
  ];
}

/**
 * 다시점 합의 — 디더 시점들을 검출해 **행 선택**을 다수결한다.
 * 동점 시 **기저 시점 우선 → 낮은 인덱스**(결정론). 기저 PTZ 를 모르면 단일 시점으로 물러선다.
 */
async function detectConsensus(
  ctx: RpcContext,
  fs: FrameSource,
  t: Target,
  p: z.infer<typeof BaseSchema>,
  res: IntrinsicsResolver,
): Promise<DetectOutcome> {
  const base = t.ptz;
  if (!base) return detectOne(ctx, fs, t, p, res);
  const views: Array<{ i: number; out: DetectOutcome; centre: Vec3 | null }> = [];
  for (let i = 0; i < DITHER.length; i++) {
    const [dp, dt] = DITHER[i];
    const shifted: Target = { ...t, ptz: { pan: base.pan + dp, tilt: base.tilt + dt, zoom: base.zoom } };
    let out: DetectOutcome;
    try {
      // ★ 14회차 수정: 디더 프레임은 tilt 가 dt 만큼 다르다 — 지면모델도 그 tilt 로 세워야 한다.
      out = await detectOne(ctx, fs, shifted, p, res, dt);
    } catch {
      continue; // 한 시점의 실패가 전체를 막지 않는다
    }
    const best = out.grid?.best ?? null;
    let centre: Vec3 | null = null;
    if (best && best.quads.length > 0) {
      const m0 = best.modelUsed;
      const n0 = m0.n as unknown as Vec3;
      let cx = 0;
      let cy = 0;
      let cz = 0;
      let cn = 0;
      for (const q of best.quads) {
        for (const pt of q.quad) {
          const X = backprojectToGround(pt as Px, m0);
          if (!X) continue;
          const Xb = toBaseFrame(X as unknown as Vec3, n0, dp, dt);
          cx += Xb[0];
          cy += Xb[1];
          cz += Xb[2];
          cn++;
        }
      }
      if (cn > 0) centre = [cx / cn, cy / cn, cz / cn];
    }
    views.push({ i, out, centre });
  }
  if (views.length === 0) return detectOne(ctx, fs, t, p, res);
  // 행 중심이 2.0m 이내면 같은 행으로 본다.
  const clusters: Array<{ members: number[]; c: Vec3 }> = [];
  for (const v of views) {
    if (!v.centre) continue;
    const hit = clusters.find((cl) => Math.hypot(cl.c[0] - v.centre![0], cl.c[1] - v.centre![1], cl.c[2] - v.centre![2]) < 2.0);
    if (hit) hit.members.push(v.i);
    else clusters.push({ members: [v.i], c: v.centre });
  }
  if (clusters.length === 0) return views[0].out;
  clusters.sort((a, b) => b.members.length - a.members.length || Math.min(...a.members) - Math.min(...b.members));
  const winIdx = Math.min(...clusters[0].members);
  const rep = views.find((v) => v.i === winIdx) ?? views[0];
  const votes = clusters.map((c) => c.members.length).join('/');
  return {
    ...rep.out,
    target: t,
    issues: [
      ...rep.out.issues,
      `다시점 합의: ${views.length}시점, 득표 ${votes}, 대표 디더 [${DITHER[winIdx][0]}, ${DITHER[winIdx][1]}], ` +
        `시점별 프레임 ${views.map((v) => v.out.frameHash ?? '-').join('/')}`,
    ],
  };
}

async function detectOne(
  ctx: RpcContext,
  fs: FrameSource,
  t: Target,
  p: z.infer<typeof BaseSchema>,
  res: IntrinsicsResolver,
  /**
   * 이 캡처의 실제 하향 틸트가 **프리셋 정의보다 얼마나 큰가**(도). 다시점 합의의 디더 시점 전용.
   *
   * ★ 14회차 실측 결함: 제원 공급자는 프리셋 정의(`eulerAngles[0]`)의 tilt 만 안다. 디더는 tilt 를
   *   ±0.8° 흔드는데 그 보정이 없으면 **틀린 지면 법선**으로 역투영한다(tilt 17° 에서 상대 4.7%).
   *   그 결과 행 중심이 밀려 군집·득표가 갈리고, 같은 디더 집합을 쓰는 12회차 도구
   *   (`roiAutoConsensus.ts` 는 실제 tilt 로 모델을 세운다)와 서비스가 서로 다른 답을 냈다.
   *   기저 시점은 0 이므로 단일 시점 경로는 비트 단위로 불변이다.
   */
  tiltDeltaDeg = 0,
): Promise<DetectOutcome> {
  const grab = await grabFrame(ctx, fs, t);
  if (grab.contaminated) {
    return {
      target: t,
      imgW: grab.frame.width,
      imgH: grab.frame.height,
      greenRatio: grab.greenRatio,
      frameHash: grab.frameHash,
      grid: null,
      focalPx: null,
      intrinsicsSource: null,
      lines: 0,
      issues: [
        `${DEGRADE.SYNTHETIC_CUE}: 초록 픽셀 ${(grab.greenRatio * 100).toFixed(3)}% > ${(GREEN_RATIO_LIMIT * 100).toFixed(1)}% — ` +
          `시뮬레이터가 주차면 박스를 렌더하고 있습니다. roi.show2d{visible:false} 후 다시 호출하세요(채점 중단)`,
      ],
    };
  }
  const issues: string[] = [];
  // ★ 제원은 프레임을 받은 **뒤**에 푼다 — 실카 화각·틸트는 그 프레임의 네이티브 PTZ 로 정해진다.
  const frameSpec: FrameSpec = {
    imgW: grab.frame.width,
    imgH: grab.frame.height,
    zoomRaw: grab.zoomRaw,
    tiltRaw: grab.tiltRaw,
  };
  const intrinsics = res.providerFor(frameSpec);
  const intrBase = intrinsics?.get(t.camId, t.presetIdx) ?? null;
  const intr =
    intrBase && tiltDeltaDeg !== 0
      ? { ...intrBase, tiltDeg: intrBase.tiltDeg + tiltDeltaDeg, source: `${intrBase.source}+dtilt${tiltDeltaDeg}` }
      : intrBase;
  const model = intr ? groundModelFromIntrinsics(intr, grab.zoom) : null;
  if (!model) {
    return {
      target: t,
      imgW: grab.frame.width,
      imgH: grab.frame.height,
      greenRatio: grab.greenRatio,
      frameHash: grab.frameHash,
      grid: null,
      focalPx: null,
      intrinsicsSource: intr?.source ?? null,
      lines: 0,
      // ★ 21회차 D2 — **강등 경로에서도 경고를 싣는다.** 종전에는 `D5_VP_DEGENERATE` 한 줄만 나갔는데,
      //   원인을 말해 주는 경고(예 "틸트 입력이 0 이하 = 상향 시선")가 **정확히 이때 가장 필요하다.**
      //   마스터가 본 화면이 이 경로였고, 그 한 줄로는 무엇을 고쳐야 할지 알 수 없었다.
      issues: [
        `${DEGRADE.VP_DEGENERATE}: 카메라 제원 공급 실패(${intrinsics?.id ?? `제원 미상 — 소스 ${fs.id}`})`,
        ...(res.warningsFor?.(frameSpec) ?? []),
      ],
    };
  }
  issues.push(...model.issues);
  // 거부는 아니지만 결과 해석에 필수인 사실(단일점 화각표·틸트 부호 가정)을 응답에 그대로 싣는다.
  issues.push(...(res.warningsFor?.(frameSpec) ?? []));
  const expectedBays = p.expectedBays ?? t.manual.filter((s) => Array.isArray(s.points) && s.points.length === 4).length;
  // ★ 21회차 ② — **면수를 모르는 호출자는 개수를 쓰지 않는 커버리지**로 검출한다.
  //   종전에는 면수를 모르면 `max(1, 0)` 으로 **조용히 1면**이 됐고(17회차 함정), 그래서 현재뷰가
  //   `expectedBays` 를 필수로 요구했다. 이제 `coverageDenom:'phaseInvariant'` 에서 `expectedBays` 는
  //   `rowExtentMode:'evidence'`(기본) 경로의 어느 식에도 등장하지 않으므로 **잘릴 개수 자체가 없다**
  //   (유닛테스트가 `bays ∈ {1,2,4,7,8,12,16}` 산출 좌표 비트 동일로 못 박는다).
  //   면수를 아는 경로(프리셋 정본 면수 · 사용자가 직접 입력)는 종전 식을 그대로 쓴다 → 무회귀.
  const coverageDenom: 'expectedBays' | 'phaseInvariant' = expectedBays >= 1 ? 'expectedBays' : 'phaseInvariant';
  if (coverageDenom === 'phaseInvariant') {
    issues.push(
      '예상 주차면 수 없이 검출했다 — 커버리지 분모를 **위상 불변**(근변 도색 지지 구간 기준)으로 바꿨다. ' +
        '개수는 산출에 개입하지 않는다(A 조건 실측: bays 1~16 전 구간 재현율 0.6000·매칭 IoU 0.92783 동일).',
    );
  }
  const { lines, mask } = detectPaintLines(grab.frame, DEFAULT_PAINT_OPTIONS);
  const evidence = paintEvidenceOf(mask, grab.frame.width, grab.frame.height);
  const cands: RowCandidate[] = [];
  for (const front of lines.slice(0, DEFAULT_PAINT_OPTIONS.frontCandidates)) {
    const peaks = scanSeparators(grab.frame, mask, front, DEFAULT_PAINT_OPTIONS);
    const seps = peaks.length ? refineSeparators(grab.frame, peaks, DEFAULT_PAINT_OPTIONS) : [];
    const pts: Array<{ x: number; y: number }> = [];
    for (const sep of seps) {
      const q = meetLines(sep.line, front.line);
      if (q) pts.push(q);
    }
    cands.push({ front, cornersPx: pts });
  }
  const grid = detectBaysWithModel(cands, model, evidence, DEFAULT_PAINT_OPTIONS, {
    ...DEFAULT_BAY_OPTS,
    slotWidthM: p.slotWidthM,
    slotDepthM: p.slotDepthM,
    cameraHeightM: res.cameraHeightM,
    expectedBays: Math.max(1, expectedBays),
    coverageDenom,
  }, grab.frame);
  issues.push(...grid.issues);
  return {
    target: t,
    imgW: grab.frame.width,
    imgH: grab.frame.height,
    greenRatio: grab.greenRatio,
    frameHash: grab.frameHash,
    grid,
    focalPx: model.f,
    intrinsicsSource: intr?.source ?? null,
    lines: lines.length,
    issues,
  };
}

const quadsOf = (o: DetectOutcome): BayQuad[] => o.grid?.best?.quads ?? [];
const cornersOf = (o: DetectOutcome): Array<{ x: number; y: number }> => o.grid?.best?.cornersPx ?? [];

/** 응답용 검출 요약(좌표는 소수 5자리 — 응답 크기·가독성. 영속화 경로는 stringify5 가 별도로 강제한다). */
function detectView(o: DetectOutcome): unknown {
  const b = o.grid?.best ?? null;
  return {
    key: o.target.key,
    camId: o.target.camId,
    presetIdx: o.target.presetIdx,
    imgW: o.imgW,
    imgH: o.imgH,
    greenRatio: round5(o.greenRatio),
    frameHash: o.frameHash,
    paintLines: o.lines,
    intrinsics: { source: o.intrinsicsSource, focalPx: o.focalPx != null ? round5(o.focalPx) : null },
    frontLine: b ? b.frontLine.map(round5) : null,
    phaseM: b ? round5(b.phaseM) : null,
    phaseFitM: b?.phaseFitM != null ? round5(b.phaseFitM) : null,
    cornersPx: b ? b.cornersPx.map((c) => ({ x: round5(c.x), y: round5(c.y) })) : [],
    paintSupport: b
      ? { near: round5(b.paint.near), far: round5(b.paint.far), side: round5(b.paint.side), score: round5(b.paint.score) }
      : null,
    quads: b
      ? b.quads.map((q) => ({
          latticeIndex: q.latticeIndex,
          quadNorm: quadToNormalized(q.quad, o.imgW, o.imgH).map((p) => ({ x: round5(p.x), y: round5(p.y) })),
        }))
      : [],
    rowCandidates: o.grid?.tried ?? [],
    issues: o.issues,
  };
}

/**
 * ★ 20회차 「리스트」 단계 — 보이는 행 **전체**. `grid.rows` 는 이미 중복 제거 + 진입 문턱(19회차)을 통과한
 * 목록이라 그대로 싣는다(실측 5프리셋 합계 28 quad — 상한을 둘 크기가 아니다).
 *
 * `candidateId` 를 `frameHash#row.lattice` 로 두는 이유: 순수 인덱스는 다음 검출에서 **말없이 다른 면**을
 * 가리킨다. 프레임 지문을 접두로 두면 뒤이을 「선택(번호 배정)」 단계가 "그때 그 프레임의 그 후보"임을
 * 검증할 수 있고, 프레임이 바뀌었으면 서버가 거절할 수 있다(F13 과 같은 규율).
 */
function rowsView(o: DetectOutcome): unknown[] {
  return (o.grid?.rows ?? []).map((r, rowIndex) => ({
    rowIndex,
    paintScore: round5(r.paint.score),
    quads: r.quads.map((q) => ({
      candidateId: `${o.frameHash ?? '-'}#${rowIndex}.${q.latticeIndex}`,
      latticeIndex: q.latticeIndex,
      quadNorm: quadToNormalized(q.quad, o.imgW, o.imgH).map((pt) => ({ x: round5(pt.x), y: round5(pt.y) })),
    })),
  }));
}

/**
 * 현재뷰 응답 = 종전 검출 뷰 + `view`·`ptzUsed`·`rows`·기준 초점거리.
 * **preset 모드에는 이 키들이 붙지 않는다**(응답 바이트 동일 — 무회귀 기준선).
 */
function currentDetectView(
  o: DetectOutcome,
  ptzUsed: { pan: number; tilt: number; zoom: number },
  fBasePx: number | null,
): unknown {
  const base = detectView(o) as Record<string, unknown>;
  const intr = base.intrinsics as { source: string | null; focalPx: number | null };
  return {
    ...base,
    view: 'current',
    ptzUsed: { pan: round5(ptzUsed.pan), tilt: round5(ptzUsed.tilt), zoom: round5(ptzUsed.zoom) },
    intrinsics: { ...intr, fBasePx: fBasePx != null ? round5(fBasePx) : null, fovAtZoom: fBasePx != null ? 'zoom1' : null },
    rows: rowsView(o),
  };
}

/**
 * ★ 응답에 **실제로 쓴 소스**를 항상 적는다. 이게 없으면 17회차 사고(시뮬 프레임을 실카 화면에 그림)가
 *   화면에서 구분되지 않는다. `requested` 를 함께 실어 뷰어가 불일치를 스스로 경고할 수 있게 한다.
 */
function usedSourceView(fs: FrameSource, requested?: string): unknown {
  return { id: fs.id, kind: fs.kind, requested: requested ?? null };
}

/** 프레임 취득 전에 확정된 제원 미상 거부. **검출을 수행하지 않았다**는 사실을 그대로 말한다. */
function rejectView(fs: FrameSource, reject: NonNullable<IntrinsicsResolver['reject']>, requested?: string): unknown {
  return {
    usedSource: usedSourceView(fs, requested),
    rejected: true,
    graded: false,
    // ★ `D*` 네임스페이스를 쓰지 않는다 — 그쪽은 `src/ground` 의 검출 강등 코드이고(D12 는 이미 사용 중),
    //   이것은 **검출을 시작조차 하지 않은** 사유다.
    gradeReason: 'INTRINSICS_MISSING',
    missing: reject.missing,
    note: reject.note,
    presets: [],
    summary: null,
  };
}

/**
 * 다시점 합의는 **PTZ 를 흔들어 6번 찍는다**. 실카에는 이동 명령을 보내지 않으므로 단일 시점으로 내린다.
 * 시뮬 경로는 판정이 그대로라 비트 동일하다.
 *
 * ★ 20회차 — 현재뷰에서도 끈다. "지금 보이는 화면 그대로"를 지시받은 기능이 사용자가 맞춘 화면을
 *   pan±1.5°/tilt±0.8° 로 6번 흔드는 것은 요구의 직접 위반이고, `detectConsensus` 의 실패 경로
 *   (`catch{ continue }`)에 **복귀 보장이 없다**. 무시했다는 사실은 issues 에 남긴다.
 */
function consensusFor(fs: FrameSource, p: z.infer<typeof BaseSchema>): boolean {
  return p.consensus && fs.kind !== 'hucoms' && p.view !== 'current';
}

async function loadPlaceJson(file: string): Promise<{ raw: string; json: unknown }> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw e.code === 'ENOENT'
      ? new RpcMethodError(RpcCode.NOT_FOUND, 'PtzCamRoi.json 없음', { file: fileNameOf(file) })
      : new RpcMethodError(RpcCode.INTERNAL, 'place-roi 읽기 실패', { detail: e.message });
  }
  try {
    return { raw, json: JSON.parse(raw) };
  } catch (err) {
    throw new RpcMethodError(RpcCode.INTERNAL, 'place-roi 파싱 실패', { detail: (err as Error).message });
  }
}

/** 현재 PTZ 를 못 읽으면 **프레임도 찍지 않는다** — 어느 화면인지 모르는 검출은 해석할 수 없다. */
function currentPtzUnavailableView(fs: FrameSource, requested: string | undefined, detail: string): unknown {
  return {
    usedSource: usedSourceView(fs, requested),
    rejected: true,
    graded: false,
    gradeReason: 'CURRENT_PTZ_UNAVAILABLE',
    missing: [`현재 PTZ — 소스 "${fs.id}" 의 cam.getPTZ 조회 실패: ${detail}`],
    note: '현재 화면 그대로 검출은 현재 PTZ 가 곧 카메라 제원(틸트·줌)이라 그것 없이는 검출을 시작하지 않는다.',
    presets: [],
    summary: null,
  };
}

/**
 * roi.auto.detect `view:"current"` — **지금 보이는 화면 그대로** 1건 검출.
 *
 * 정본에서 읽는 것은 **카메라 메타(설치고·기준 초점거리 파생)** 뿐이고 주차면 좌표·개수는 읽지 않는다(R1).
 *
 * ★ 21회차 — `expectedBays` **선택 파라미터로 완화**(종전에는 필수 거부).
 *   종전 거부의 근거는 "비우면 `max(1, 0)` 으로 조용히 1면으로 잘린다"(17회차 함정)였다. 그 전제가
 *   ②로 소멸했다: 면수를 모르면 `coverageDenom:'phaseInvariant'` 로 검출하고, 그 식에는 `expectedBays` 가
 *   **등장하지 않는다**(`rowExtentMode:'evidence'` 기본 경로 전체에서). 잘릴 개수가 없으므로 조용히 틀릴 수 없다.
 *   근거 실측(A 조건 pan60/tilt14/zoom1.3 · 프레임 bf8aee3c9bf9): `bays 1~16` 전 구간에서 승자 위상
 *   −21.030626 · 재현율 0.6000 · 매칭 IoU 0.92783 **비트 동일**(종전은 `bays ≥ 7` 에서 재현율 0.0000).
 *   값을 **넣으면** 종전 식(면수 기반)으로 검출한다 — 구 방식 회귀 비교용이며 20b 의 민감도가 그대로 남는다.
 */
async function detectCurrentView(ctx: RpcContext, json: unknown, p: z.infer<typeof RoiAutoDetectSchema>): Promise<unknown> {
  if (p.camId == null) {
    throw new RpcMethodError(RpcCode.INVALID_PARAMS, '현재 화면 그대로 검출에는 camId 가 필요합니다', { view: 'current' });
  }
  const fs = resolveFrameSource(ctx, p.source);
  let ptzNow: { pan: number; tilt: number; zoom: number };
  try {
    ptzNow = await fs.camera.getPtz(p.camId);
  } catch (err) {
    return currentPtzUnavailableView(fs, p.source, (err as Error).message);
  }
  // 실카는 종전 해석기 그대로다 — `zoomHfov` 실측표가 이미 그 줌에서의 **유효** 화각이라 ×zoom 할 근거가 없다.
  const res =
    fs.kind === 'hucoms' ? resolverFor(fs, json, p, p.cameraSpec) : currentViewResolver(json, p, p.camId, ptzNow, p.cameraSpec);
  if (res.reject) return rejectView(fs, res.reject, p.source);
  const o = await detectOne(ctx, fs, currentTargetOf(p.camId, p.presetIdx ?? 1, ptzNow), p, res);
  // ★ "카메라를 움직이지 않는다"를 주장하는 모드는 **미세 이동도 삼키지 않는다**.
  //   되쓰기는 읽은 값 그대로지만, 장비가 float32 로 왕복 양자화하면 1 ULP(각도 ~1.9e-6°)가 남을 수 있다.
  //   차이가 0 이면 아무것도 싣지 않는다(잡음 금지). 실카는 애초에 되쓰지 않으므로 확인하지 않는다.
  if (fs.kind !== 'hucoms') {
    try {
      const after = await fs.camera.getPtz(p.camId);
      const d = { pan: after.pan - ptzNow.pan, tilt: after.tilt - ptzNow.tilt, zoom: after.zoom - ptzNow.zoom };
      if (d.pan !== 0 || d.tilt !== 0 || d.zoom !== 0) {
        o.issues.push(
          `현재 PTZ 되쓰기 전후 차이 — pan ${d.pan.toExponential(3)}° / tilt ${d.tilt.toExponential(3)}° / zoom ${d.zoom.toExponential(3)}: ` +
            `${ptzNow.pan},${ptzNow.tilt},${ptzNow.zoom} → ${after.pan},${after.tilt},${after.zoom}. ` +
            '보낸 값은 읽은 값 그대로다(이동 명령 아님) — 장비의 float32 왕복 양자화이며 다음 호출부터는 고정점이다.',
        );
      }
    } catch {
      /* 사후 확인 실패가 검출 결과를 무효화하지는 않는다 — 확인을 못 했을 뿐이다. */
    }
  }
  if (p.consensus) {
    o.issues.push(
      '다시점 합의를 **무시**했다 — 현재 화면 그대로 모드는 사용자가 맞춘 화면을 흔들지 않는다(PTZ 디더 0회).',
    );
  }
  // 실제로 쓴 기준 초점거리 = 이 프레임의 유효 f ÷ 현재 줌(정의 그대로). 실카는 규칙이 다르므로 null.
  const fBasePx = fs.kind !== 'hucoms' && o.focalPx != null && ptzNow.zoom > 0 ? o.focalPx / ptzNow.zoom : null;
  return {
    usedSource: usedSourceView(fs, p.source),
    presets: [currentDetectView(o, ptzNow, fBasePx)],
    holdout: '현재뷰는 정본의 주차면을 읽지 않는다(카메라 메타 + 현재 PTZ + 예상 면수만)',
  };
}

/** roi.auto.detect — 프레임 1장 → 도색선·소실점·f·코너·quad 미리보기. **수동 ROI 를 읽지 않는다.** */
export async function roiAutoDetect(raw: unknown, ctx: RpcContext): Promise<unknown> {
  const p = RoiAutoDetectSchema.parse(raw);
  const file = placeFileOf(ctx);
  const { json } = await loadPlaceJson(file);
  if (p.view === 'current') return detectCurrentView(ctx, json, p);
  // 정본은 **대상 목록(카메라·프리셋·베이 개수)** 을 얻는 데만 쓴다 — 좌표는 검출에 넘어가지 않는다(R1).
  const targets = targetsOf(json, loadViews(ctx), p.camId, p.presetIdx);
  if (!targets.length) throw new RpcMethodError(RpcCode.NOT_FOUND, '대상 프리셋 없음', { camId: p.camId, presetIdx: p.presetIdx });
  const fs = resolveFrameSource(ctx, p.source);
  const res = resolverFor(fs, json, p, p.cameraSpec);
  if (res.reject) return rejectView(fs, res.reject, p.source);
  const consensus = consensusFor(fs, p);
  const out: unknown[] = [];
  for (const t of targets) out.push(detectView(await (consensus ? detectConsensus : detectOne)(ctx, fs, t, p, res)));
  return {
    usedSource: usedSourceView(fs, p.source),
    presets: out,
    holdout: '검출·기하 모듈은 주차면 좌표를 입력으로 받지 않는다(카메라 제원 + 베이 개수만)',
  };
}

/** roi.auto.score — 검출 결과를 수동 정본과 대조 채점(hold-out). 파일·DB 무접촉. */
export async function roiAutoScore(raw: unknown, ctx: RpcContext): Promise<unknown> {
  const p = RoiAutoScoreSchema.parse(raw);
  // 현재뷰에는 대조할 수동 정본이 없다(프리셋 종속이 아니다). 조용히 무시하지 않고 거부한다.
  if (p.view === 'current') {
    throw new RpcMethodError(RpcCode.INVALID_PARAMS, 'roi.auto.score 는 현재뷰를 채점하지 않는다 — 수동 정본은 프리셋 종속이다', {
      view: p.view,
    });
  }
  const file = placeFileOf(ctx);
  const { json } = await loadPlaceJson(file);
  const targets = targetsOf(json, loadViews(ctx), p.camId, p.presetIdx);
  if (!targets.length) throw new RpcMethodError(RpcCode.NOT_FOUND, '대상 프리셋 없음', { camId: p.camId, presetIdx: p.presetIdx });
  const fs = resolveFrameSource(ctx, p.source);
  const res = resolverFor(fs, json, p, p.cameraSpec);
  if (res.reject) return rejectView(fs, res.reject, p.source);
  const consensus = consensusFor(fs, p);
  const presets: PresetScore[] = [];
  const details: unknown[] = [];
  for (const t of targets) {
    const o = await (consensus ? detectConsensus : detectOne)(ctx, fs, t, p, res);
    const score = scorePreset(quadsOf(o), cornersOf(o), t.manual, o.imgW, o.imgH, t.key, t.camId, t.presetIdx);
    if (o.grid == null) {
      score.graded = false;
      score.gradeReason = score.gradeReason ?? DEGRADE.SYNTHETIC_CUE;
    }
    score.issues.push(...o.issues);
    const asg = resolveManualAssignment(t.manual, o.imgW, o.imgH);
    presets.push(score);
    details.push({ ...score, assignment: asg, detect: detectView(o) });
  }
  return {
    usedSource: usedSourceView(fs, p.source),
    presets: details,
    summary: summarize(presets),
    notes: [
      '자동 quad ↔ 슬롯 매칭에 IoU(MATCH_MIN_IOU)를 쓴다 — 귀속만 정하며 좌표는 바뀌지 않는다(설계 §3).',
      'graded:false 인 프리셋은 통과·평균 집계에서 제외한다. 제외는 통과가 아니다.',
      `슬롯 24 는 파일↔DB 소속 불일치 미해소로 범위 제외(${DEGRADE.SLOT24}).`,
      '시뮬레이터 수치로 실카를 대변하지 않는다 — 실카(RTSP) 검증 0건(R10).',
    ],
  };
}

/**
 * roi.auto.apply — 정본 `PtzCamRoi.json` 갱신. **DB 는 건드리지 않는다.**
 *
 * S1 검출·채점 재실행 → S2 합격선 게이트 → S3 assertAutoPromoteSafe(G1~G5) → S4 동시편집 가드 →
 * S5 `.bak` 원문 백업 후 `stringify5(json,2)` 로 정본 기록(실패 시 원문 복원).
 */
export async function roiAutoApply(raw: unknown, ctx: RpcContext): Promise<unknown> {
  const p = RoiAutoApplySchema.parse(raw);
  // 현재뷰는 정본 프리셋에 대응하지 않는다 — 어느 프리셋에 쓸지 정의되지 않은 채로 정본을 건드리지 않는다.
  if (p.view === 'current') {
    throw new RpcMethodError(RpcCode.INVALID_PARAMS, 'roi.auto.apply 는 현재뷰를 적용하지 않는다 — 정본은 프리셋 단위다', {
      view: p.view,
    });
  }
  const file = placeFileOf(ctx);
  const loaded = await loadPlaceJson(file);
  const { byPreset } = normalizePtzCamRoi(loaded.json);
  const views = loadViews(ctx);

  let json = loaded.json;
  const applied: Array<{ key: string; slots: number; minIoU: number }> = [];
  const issues: string[] = [];
  let total = 0;
  for (const spaces of byPreset.values()) total += spaces.length;
  if (p.expectTotal !== undefined && total !== p.expectTotal) {
    throw new RpcMethodError(RpcCode.CONFLICT, '전체 주차면 개수 불일치 — 저장하지 않음(다른 곳에서 파일이 바뀌었습니다)', {
      expected: p.expectTotal,
      actual: total,
    });
  }

  // apply 에는 source 파라미터가 없다(기본 카메라 고정). 다만 제원 해석은 detect/score 와 **같은 규칙**을 쓴다 —
  // 기본 카메라가 실카인 배포에서 시뮬 제원으로 정본을 덮어쓰는 일을 구조적으로 막는다.
  const fs = resolveFrameSource(ctx, undefined);
  const res = resolverFor(fs, loaded.json, p);
  if (res.reject) {
    throw new RpcMethodError(RpcCode.CONFLICT, `${fs.id}: 카메라 제원 미상 — 정본 무변경`, {
      missing: res.reject.missing,
      note: res.reject.note,
    });
  }
  const consensus = consensusFor(fs, p);
  for (const presetIdx of p.presets) {
    const targets = targetsOf(loaded.json, views, p.camId, presetIdx);
    if (!targets.length) throw new RpcMethodError(RpcCode.NOT_FOUND, `preset${presetIdx} 대상 없음`);
    for (const t of targets) {
      const o = await (consensus ? detectConsensus : detectOne)(ctx, fs, t, p, res);
      if (!quadsOf(o).length) {
        throw new RpcMethodError(RpcCode.CONFLICT, `${t.key}: 자동 quad 0개 — 정본 무변경`, { issues: o.issues });
      }
      const score = scorePreset(quadsOf(o), cornersOf(o), t.manual, o.imgW, o.imgH, t.key, t.camId, t.presetIdx);
      const graded = score.slots.filter((s) => !s.degrade);
      if (!graded.length) throw new RpcMethodError(RpcCode.CONFLICT, `${t.key}: 채점 가능한 주차면 0개 — 정본 무변경`);
      const worst = Math.min(...graded.map((s) => s.iouVsManual));
      if (worst < p.minIoU) {
        throw new RpcMethodError(RpcCode.CONFLICT, `${t.key}: 최소 IoU ${worst.toFixed(5)} < ${p.minIoU} — 정본 무변경`, {
          slots: graded.map((s) => ({ slotIdx: s.slotIdx, iou: round5(s.iouVsManual), degrade: s.degrade })),
        });
      }
      // 기존 순서·idx 를 보존하고 좌표만 교체한다(신규 슬롯 추가 없음).
      const byIdx = new Map<number, Array<{ x: number; y: number }>>();
      for (const s of score.slots) {
        if (s.degrade || !s.matched) continue;
        let best: { iou: number; pts: Array<{ x: number; y: number }> } | null = null;
        const manualSpace = t.manual.find((m) => m.idx === s.slotIdx);
        if (!manualSpace) continue;
        for (const q of quadsOf(o)) {
          const norm = quadToNormalized(q.quad, o.imgW, o.imgH);
          const iou = s.iouVsManual;
          if (!best || iou > best.iou) best = { iou, pts: norm };
        }
        if (best) byIdx.set(s.slotIdx, best.pts);
      }
      if (!byIdx.size) throw new RpcMethodError(RpcCode.CONFLICT, `${t.key}: 적용 가능한 매칭 0건 — 정본 무변경`);
      const next: PlaceRoiSpace[] = t.manual.map((sp) => {
        const pts = byIdx.get(sp.idx);
        return pts ? { idx: sp.idx, points: pts } : sp;
      });
      const r = applyPlaceRoiUpdateEx(json, { camId: t.camId, presetIdx: t.presetIdx, spaces: next });
      json = r.json;
      issues.push(...r.issues);
      applied.push({ key: t.key, slots: byIdx.size, minIoU: round5(worst) });
    }
  }

  const gate = assertAutoPromoteSafe(json, loaded.json);
  if (!gate.ok) throw new RpcMethodError(RpcCode.CONFLICT, gate.error ?? '적용 거부 — 정본 무변경', gate.detail);

  const backupFile = backupPlaceRoiPathOf(file, new Date().toISOString());
  try {
    await writeFile(backupFile, loaded.raw, 'utf8');
  } catch (err) {
    throw new RpcMethodError(RpcCode.INTERNAL, '백업 실패 — 정본 무변경', { detail: (err as Error).message });
  }
  try {
    await writeFile(file, stringify5(json, 2), 'utf8');
  } catch (err) {
    let restored = true;
    try {
      await writeFile(file, loaded.raw, 'utf8');
    } catch {
      restored = false;
    }
    throw new RpcMethodError(RpcCode.INTERNAL, `정본 쓰기 실패${restored ? ' — 원문 복원됨' : ' — 복원 실패'}`, {
      detail: (err as Error).message,
      backupFile: fileNameOf(backupFile),
    });
  }
  return {
    ok: true,
    applied,
    backupFile: fileNameOf(backupFile),
    issues,
    note: 'DB(slot_setup)는 갱신하지 않았습니다 — 반영하려면 slot.roi.sync 를 별도로 호출하세요.',
  };
}
