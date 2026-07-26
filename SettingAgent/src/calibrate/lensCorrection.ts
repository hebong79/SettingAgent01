// 렌즈 보정 어댑터 — @parkagent/lens-calib 를 ParkAgent 규약에 잇는 **유일한 연결점**.
//
// 컴포넌트는 Hucoms 네이티브 단위(픽셀 0~1920 · centidegree · zoompos)로 말하고, 뷰어는
// 정규화(0~1) 좌표로 말한다. 그 변환을 여기 한 곳에서만 한다. 컴포넌트는 이 파일의 존재를 모른다.
//
// ★ 설계 원칙(20260725 설계서 §10, §13):
//   1. **기본 OFF.** 표가 없으면 correct() 는 입력을 그대로 돌려준다 → 기존 산출값과 비트 동일.
//   2. **기기별 opt-in.** enabled:true 인 카메라에만 적용한다. 검증(A/B) 통과를 사람이 확인하고 켠다.
//   3. **시뮬레이터 금지.** 시뮬은 자기가 렌더하는 표로 조준하므로 이미 정확하다 — 걸면 없던 오차가 생긴다.
//      (이 파일은 실카 경로에만 주입되므로 구조적으로 차단된다.)

import { readFileSync } from 'node:fs';
import { CameraCalibration } from '@parkagent/lens-calib';
import type { CalibrationSpec } from '@parkagent/lens-calib';

/** data/lens_calibration.json 스키마(설계서 §8). 카메라는 소스 `id`(문자열)로 식별한다 —
 *  뷰어 cam 번호는 문맥마다 의미가 달라 모호하므로, sourceRegistry 가 아는 유일한 안정 키인
 *  cameraSources[].id 로 맞춘다(camIdx 는 하위호환용 선택 필드). */
interface LensCalibrationFile {
  cameras?: Array<
    CalibrationSpec & {
      id?: string;
      camIdx?: number;
      host?: string;
      enabled?: boolean;
    }
  >;
}

/** 정규화 지점을 렌즈 보정해 다시 정규화로 돌려주는 최소 인터페이스. RealPtzSource 가 주입받는다. */
export interface LensCorrector {
  /**
   * 정규화 클릭(0~1) → 보정된 정규화 좌표(0~1).
   * @param nativeZoomPos 장비 네이티브 zoompos(레지스터). 게인·곡면율이 줌의 함수이므로 필요하다.
   */
  correct(point: { x: number; y: number }, nativeZoomPos: number): { x: number; y: number };
}

const BASE_W = 1920;
const BASE_H = 1080;

/** 항등 보정 — 표가 없거나 비활성일 때. correct() 가 입력을 그대로 돌려준다. */
export const IDENTITY_CORRECTOR: LensCorrector = {
  correct: (point) => point,
};

/**
 * CameraCalibration 을 LensCorrector 로 감싼다. 정규화 ↔ 픽셀 환산만 담당한다.
 */
export function correctorFromCalibration(cal: CameraCalibration): LensCorrector {
  if (!cal.hasGain && !cal.hasDistortion) return IDENTITY_CORRECTOR;
  return {
    correct(point, nativeZoomPos) {
      const aim = cal.aim({
        x: clamp01(point.x) * BASE_W,
        y: clamp01(point.y) * BASE_H,
        zoom: nativeZoomPos,
      });
      return { x: aim.x / BASE_W, y: aim.y / BASE_H };
    },
  };
}

/**
 * 아티팩트 파일에서 해당 카메라의 보정을 로드한다. 아래 중 하나라도 아니면 **항등**을 돌려준다:
 *   파일 없음 · 해당 id 없음 · enabled:false · 표가 비어 있음.
 * 즉 "켜져 있고 실측 표가 있는 카메라"에만 실제 보정이 걸린다.
 *
 * @param cameraKey cameraSources[].id (권장) 또는 camIdx 숫자. 문자열이면 id, 숫자면 camIdx 로 매칭한다.
 */
export function loadLensCorrector(filePath: string, cameraKey: string | number): LensCorrector {
  let file: LensCalibrationFile;
  try {
    file = JSON.parse(readFileSync(filePath, 'utf8')) as LensCalibrationFile;
  } catch {
    return IDENTITY_CORRECTOR; // 파일이 없거나 깨졌으면 조용히 무보정 — 기존 동작.
  }
  const entry = file.cameras?.find((c) => (typeof cameraKey === 'string' ? c.id === cameraKey : c.camIdx === cameraKey));
  if (!entry || entry.enabled !== true) return IDENTITY_CORRECTOR;
  if (!entry.zoomHfov && !entry.centeringGain && !entry.lensDistortion && !entry.model) return IDENTITY_CORRECTOR;
  try {
    return correctorFromCalibration(CameraCalibration.from(entry, { frameWidth: BASE_W, frameHeight: BASE_H }));
  } catch {
    return IDENTITY_CORRECTOR; // 표가 잘못됐으면 무보정으로 강등 — 조준을 멈추게 하느니.
  }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, Number(v) || 0));
}
