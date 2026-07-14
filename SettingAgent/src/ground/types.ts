// 지면모델(GroundModel) 타입 — 1단계(파일 경로 육면체). 순수 타입만, 로직·IO 없음.
// 좌표계 규약: 원본 센서 픽셀(imgW×imgH, 좌상단 원점, x→우 / y→하). 정규화(0..1) 아님.
//   근거(설계 §1-2): f·주점은 센서 픽셀에서만 물리적 의미를 가진다. 0..1 은 x/y 스케일이 달라 정사각픽셀 가정이 깨진다.
// 카메라 좌표계: x→우, y→하, z→전방(광축). 주점=이미지 중심, 정사각픽셀, 무왜곡 가정.

/** 동차 2D 벡터(점 또는 소실점). w≈0 이면 무한원(정규화 나눗셈 금지 — 설계 §4-6). */
export type Hom2 = [number, number, number];

/** 이미지 픽셀 4점 사각형. 규약: p0=근좌, p1=원좌, p2=원우, p3=근우(설계 §4-2). */
export type PixelQuad = [
  { x: number; y: number },
  { x: number; y: number },
  { x: number; y: number },
  { x: number; y: number },
];

/**
 * 프리셋 지면모델. 평면(n,d) + 내부파라미터(f) 로 지면을 완전히 규정한다.
 *
 * 설계 §6 의 `H`(3×3 호모그래피) 대신 **(f, n, d)** 파라미터화를 채택했다(등가·더 단순).
 *   - 지면 = { X ∈ 카메라좌표 | n·X = d }.  n = 단위 하향 법선, d = 카메라 지상고(m).
 *   - 픽셀 p 의 지면점: m = K⁻¹p,  X = d·m / (n·m).
 *   - 높이 h 점의 상: p_h ≃ p − h·((n·m)/d)·(K·n)   ← 뷰어 projectCuboid 가 쓰는 유일한 식.
 *   H 를 실으면 뷰어가 H⁻¹·분해(r1,r2,r3)를 재구현해야 하지만(이중구현), (f,n,d) 는 내적 2번이면 끝난다.
 *   H 로 표현 가능한 정보와 1:1 등가이며 지면 원점/방향(임의 선택분)만 빠진다 — 육면체는 그 값에 불변.
 */
export interface GroundModel {
  camIdx: number;
  presetIdx: number;
  imgW: number;
  imgH: number;
  /** 이 프리셋의 zoom(camerapos). f 를 fovBaseV 에서 유도한 근거. */
  zoom: number;
  /** 초점거리(px). 카메라당 fovBaseV 공동추정 → detectMath.fovV 로 유도(설계 §4-4). */
  f: number;
  /** 지면 하향 단위법선(카메라 좌표계). n·X = d. */
  n: [number, number, number];
  /** 카메라 지상고(m) = 지면까지의 수직거리. metric 스케일의 유일한 담지자. */
  d: number;
  /** 하향 틸트(도) = asin(n.z). 이미지 점만으로 추정한 값. */
  tiltDeg: number;
  /** 카메라가 보고한 프리셋 PTZ tilt(camerapos). 실카메라도 주는 값 — Unity 전용 아님. 미상이면 null. */
  ptzTiltDeg: number | null;
  /**
   * ★ 세로 정합 지표: 추정 tilt − PTZ tilt. ROI 가 **세로로** 어긋나면 그 오차가 tilt 로 흡수되므로
   * (실측: ROI 를 +200px 내리면 tilt 6.84°→2.94°) metricErr 는 못 잡고 이 값만 커진다.
   * metricErr(가로 정합) 과 상보. ptzTiltDeg 미상이면 null.
   */
  tiltErrDeg: number | null;
  /**
   * ★ 수직축 회전 검출용: 주차면 스트립의 방위각(도, mod 90) = PTZ pan + 카메라 지면전방 기준 슬롯방향 azimuth.
   * 카메라는 프리셋 사이에 **움직이지 않으므로** 이 값은 프리셋 불변량이어야 한다(같은 주차장 = 같은 스트립 방위).
   * 실측: 정상 스프레드 ~2.3° / 지면 30° 회전 → 정확히 30° 이동. pan 미상이면 null.
   */
  slotBearingDeg: number | null;
  /** 프리셋 간 방위 합의(원형평균, mod 90)로부터의 편차(도). |편차| 큰 프리셋 = ROI 가 수직축으로 회전됨. */
  bearingDevDeg: number | null;
  /** 프리셋 간 카메라고(d) 합의(중앙값) 대비 상대편차. 지면 균일스케일 오류 검출(d 는 프리셋 불변량). */
  dDevRel: number | null;
  /** 두 변군 중 픽셀길이 중앙값이 짧은 쪽(=조건수를 지배하는 baseline). 설계 §4-4 의 '깊이변' 지표. */
  depthEdgePx: number;
  /**
   * ★ 가로 정합 지표: 주차면 metric 재구성 상대오차(0~1). 경사/비평면·스케일 오배정 + **ROI 가로 평행이동** 탐지.
   * f/tilt 는 ROI 평행이동에 둔감하므로(실측 ±200px 에서 f 0.7%/tilt 0.05%) 이 지표가 유일한 가로 검출기다.
   */
  metricErr: number;
  /** 0~1 신뢰도(조건수 × metric 적합도). 낮으면 뷰어가 육면체를 그리지 않는다. */
  conf: number;
  /** 산출 경로. 1단계는 'file'(PtzCamRoi.json)만. 2~5단계 자동경로가 'auto' 로 합류(설계 §2). */
  source: 'file' | 'auto';
  /** advisory(강등 사유). throw 대신 여기에 쌓는다(placeRoiReport 패턴). */
  issues: string[];
}

/** 지면모델 추정 입력 1건(프리셋). 픽셀 quad + PTZ(zoom/tilt). */
export interface GroundPresetInput {
  camIdx: number;
  presetIdx: number;
  zoom: number | null;
  /** 카메라가 보고한 프리셋 tilt(도). 세로 정합 교차검증용(GroundModel.tiltErrDeg). 미상이면 null. */
  tilt: number | null;
  /** 카메라가 보고한 프리셋 pan(도). 수직축 회전 검출용(GroundModel.slotBearingDeg). 미상이면 null. */
  pan: number | null;
  quads: PixelQuad[];
}

/** 카메라 1대 분 추정 입력. fovBaseV 는 이 단위(카메라)로 공동추정한다. */
export interface GroundCameraInput {
  camIdx: number;
  imgW: number;
  imgH: number;
  presets: GroundPresetInput[];
}

/** 지면모델 추정 파라미터(tools.config `ground` 섹션). */
export interface GroundOptions {
  /** 조건수 게이트(px). 이 미만 프리셋은 fovBaseV 공동추정 표본에서 제외(설계 §4-4). */
  minDepthEdgePx: number;
  /** 주차면 폭(m) — metric 스케일 1순위 앵커(설계 §4-5 에서 2.53~2.58m 실측). */
  slotWidthM: number;
  /** 주차면 깊이(m) — 폭/깊이 대응 뒤집힘 판별에 사용(설계 §4-6). */
  slotDepthM: number;
}
