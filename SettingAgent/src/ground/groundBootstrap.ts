// 부트스트랩 — 주차면 1개 + PTZ → 카메라 상수, 그리고 드로잉 없는 프리셋의 GroundModel 조립(설계 §4).
//
// 재사용만 한다(신규 추정 수학 0줄): estimateGroundVPs / focalFromVPs / buildGroundPlane / poolFovBaseV /
//   buildPresetModel / focalFromZoom — 전부 groundModel.ts 의 기존 공개 함수. groundModel.ts 는 **변경 0줄**.
//
// ★ 정직성 규약(설계 §4-3, 리더 승인): buildAutoGroundModel 이 만드는 모델은 **이미지 증거가 0** 이다.
//   metricErr = 0, tiltErrDeg = 0 이 되지만 이는 **구성상 0**이지 품질이 아니다.
//   → conf 를 1.0 으로 채우지 않고 부트스트랩 프리셋의 conf 를 상속하며, 고정 issue 문구를 **항상** 붙인다.

import {
  buildGroundPlane,
  estimateGroundVPs,
  focalFromVPs,
  focalFromZoom,
  buildPresetModel,
  poolFovBaseV,
} from './groundModel.js';
import type { GroundModel, GroundOptions, PixelQuad } from './types.js';

const DEG = Math.PI / 180;

/** 자동 모델에 **항상** 붙는 정직성 문구(설계 §4-3). 테스트가 이 상수로 봉인한다. */
export const AUTO_MODEL_ISSUE =
  'source=auto: PTZ 로 유도된 모델 — metricErr/tiltErr 는 구성상 0이며 검증력이 없다';

/** 카메라 상수 — 프리셋 불변량. ground_grid.json 에 영속. */
export interface CameraGroundConstants {
  camIdx: number;
  imgW: number;
  imgH: number;
  /** 카메라 지상고(m). 리더 B-1 실측: 3프리셋 편차 0.00%. */
  d: number;
  /** zoom→f 유도용(도). poolFovBaseV 역산. */
  fovBaseV: number;
  /** roll 보정각(도). 이번 범위에서는 **항상 0**(가정) — 실카 확장 지점(설계 §8 R1). */
  rollDeg: number;
  /** 부트스트랩에 쓴 프리셋(추적성). */
  fromPresetIdx: number;
  /**
   * 부트스트랩 프리셋 모델의 conf. 자동 모델이 **그대로 상속**한다(그 이상의 근거가 없다).
   * ※ 설계서 인터페이스에는 없던 필드 — §4-3 의 "conf 를 1.0 으로 채우지 않는다" 를 지키려면 필수라 추가했다.
   */
  bootstrapConf: number;
  issues: string[];
}

/**
 * 기준 주차면 1개(픽셀 4점) + 그 프리셋 PTZ → 카메라 상수 + 그 프리셋의 GroundModel.
 * 실패(퇴화 quad·f²≤0·지평선 위·zoom 미상) → null.
 *
 * @param knownFovBaseV 같은 카메라의 **다른 프리셋**에서 이미 공동추정한 fovBaseV(도). 주면
 *   `focalFromVPs`(직교 소실점 제약)를 **건너뛰고** 그 값으로 f 를 유도한다.
 *   근거: fovBaseV 는 zoom 만의 함수인 **카메라 상수**이므로 프리셋을 건너 빌려도 된다
 *   (production `estimateGroundModels` 가 이미 카메라 단위로 공동추정한다). 신규 수학 0줄.
 *   용도: 기준면 하나만으로는 두 소실점이 직교 제약을 못 만족해 f²≤0 이 되는 프리셋 구제
 *   (실측: cam1 preset3 — QA 결함 4).
 */
export function bootstrapCameraConstants(
  input: {
    camIdx: number;
    imgW: number;
    imgH: number;
    presetIdx: number;
    zoom: number;
    tilt: number;
    pan: number;
    quad: PixelQuad;
  },
  opts: GroundOptions,
  knownFovBaseV?: number,
): { constants: CameraGroundConstants; model: GroundModel; issues: string[] } | null {
  const { camIdx, imgW, imgH, presetIdx, zoom, tilt, pan, quad } = input;
  if (!(imgW > 0) || !(imgH > 0)) return null;
  const cx = imgW / 2;
  const cy = imgH / 2;

  const vps = estimateGroundVPs([quad]);
  if (!vps) return null; // 퇴화 quad(비볼록·선분·최소면적 미달).
  // f 1차 후보: 기준면 단독(직교 소실점) → 실패 시 빌려온 fovBaseV 로 유도.
  const fSolo =
    focalFromVPs(vps.v1, vps.v2, cx, cy) ??
    (knownFovBaseV != null && knownFovBaseV > 0 ? focalFromZoom(zoom, knownFovBaseV, imgW, imgH) : null);
  if (fSolo == null) return null; // 직교 소실점 제약 위반(f²≤0)·무한원 + 폴백도 불가.
  const probe = buildGroundPlane([quad], fSolo, vps.v1, vps.v2, cx, cy, opts);
  const depthEdgePx = (probe?.depthFamily ?? 'a') === 'a' ? vps.edgePxA : vps.edgePxB;

  const pooled = poolFovBaseV([{ zoom, f: fSolo, depthEdgePx }], imgH);
  if (!pooled) return null; // zoom 미상/f 불량 → fovBaseV 역산 불가.

  const model = buildPresetModel(
    { preset: { camIdx, presetIdx, zoom, tilt, pan, quads: [quad] }, vps, fSolo, depthEdgePx },
    pooled,
    camIdx,
    imgW,
    imgH,
    cx,
    cy,
    opts,
  );
  if (!model) return null;

  const issues: string[] = [
    ...pooled.issues,
    '부트스트랩 표본 = 주차면 1개 — 프리셋 간 f 교차검증 불가(카메라 상수 정확도는 이 1면에 전적으로 의존)',
  ];
  // ★ R1(roll≠0) 노출: 추정 n 과 PTZ 유도 n(roll=0 가정)의 각차. 수정은 하지 않고 **드러내기만** 한다.
  const nPtz = ptzNormal(tilt);
  const cosang = model.n[0] * nPtz[0] + model.n[1] * nPtz[1] + model.n[2] * nPtz[2];
  const devDeg = Math.acos(Math.min(1, Math.max(-1, cosang))) / DEG;
  if (devDeg > 1.0) {
    issues.push(
      `추정 지면법선이 PTZ(tilt ${tilt.toFixed(2)}°, roll=0 가정) 유도 법선과 ${devDeg.toFixed(2)}° 차 — ` +
        'roll≠0 이거나 PTZ 보고 바이어스. 자동 프리셋 격자가 그만큼 회전한다',
    );
  }

  return {
    constants: {
      camIdx,
      imgW,
      imgH,
      d: model.d,
      fovBaseV: pooled.fovBaseV,
      rollDeg: 0,
      fromPresetIdx: presetIdx,
      bootstrapConf: model.conf,
      issues,
    },
    model,
    issues,
  };
}

/**
 * PTZ tilt → 지면 하향 단위법선(roll = 0 가정).
 * `groundModel.ts:505` 의 `tiltDeg = asin(n[2])` 의 **정확한 역**이다: asin(sin t) = t.
 * 카메라 좌표계는 x→우, y→하, z→전방 이므로 하향 성분 y = cos t > 0(t < 90°).
 */
export function ptzNormal(tiltDeg: number): [number, number, number] {
  const t = tiltDeg * DEG;
  return [0, Math.cos(t), Math.sin(t)];
}

/**
 * 드로잉 없는 프리셋의 GroundModel 조립(이미지 증거 0).
 *   f = focalFromZoom(zoom, fovBaseV, imgW, imgH)
 *   n = [0, cos t, sin t]   ← roll = 0
 *   d = 카메라 상수 재사용(프리셋 불변량 — 리더 B-1 실측 편차 0.00%)
 * source: 'auto' — `types.ts:70` 에 예약돼 있던 값이 **여기서 처음 실제로 쓰인다**.
 * f 유도 불가(zoom≤0 / fovBaseV≤0) → null.
 */
export function buildAutoGroundModel(
  c: CameraGroundConstants,
  preset: { presetIdx: number; zoom: number; tilt: number; pan: number },
): GroundModel | null {
  const f = focalFromZoom(preset.zoom, c.fovBaseV, c.imgW, c.imgH);
  if (f == null || !(f > 0)) return null;
  if (!Number.isFinite(preset.tilt) || !(c.d > 0)) return null;
  const n = ptzNormal(preset.tilt);
  return {
    camIdx: c.camIdx,
    presetIdx: preset.presetIdx,
    imgW: c.imgW,
    imgH: c.imgH,
    zoom: preset.zoom,
    f,
    n,
    d: c.d,
    tiltDeg: preset.tilt, // asin(n[2]) 와 항등(위 ptzNormal 주석).
    ptzTiltDeg: preset.tilt,
    tiltErrDeg: 0, // 구성상 0 — 품질 아님(AUTO_MODEL_ISSUE).
    // 이미지 증거가 없으므로 변군 방향(dirA)이 없다 → 방위 불변량을 **주장하지 않는다**.
    slotBearingDeg: null,
    bearingDevDeg: null,
    dDevRel: null,
    depthEdgePx: 0,
    metricErr: 0, // 구성상 0 — 품질 아님(AUTO_MODEL_ISSUE).
    conf: c.bootstrapConf, // 1.0 으로 채우지 않는다(설계 §4-3).
    source: 'auto',
    issues: [AUTO_MODEL_ISSUE],
  };
}
