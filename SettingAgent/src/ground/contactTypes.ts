// 차량 접지선 → 3D 육면체(로드맵 5단계) 타입. 순수 타입 + 상수만, 로직·IO 없음.
//
// ★ 이 파일의 존재 이유는 **관측과 prior 의 경계를 코드로 못 박는 것**이다(설계 §3).
//   카메라는 차량의 **카메라 쪽 접지 윤곽**만 본다. 뒤·반대편 접지선은 차체 자신이 가리므로
//   가림 배제 규칙으로도 살릴 수 없다(다른 차량 마스크가 아니라 **자기 마스크 안**이다).
//   → 마스크가 주는 것은 "차가 어디까지 차지하는가"가 아니라 "카메라 쪽 접지 모서리가 지면 어디에 있는가" 다.

import type { NormalizedQuad } from '../domain/types.js';

/** 카메라 좌표계 3D 점/벡터(meter). GroundModel.n 과 같은 규약. */
export type Vec3 = [number, number, number];

/** 이미지 픽셀 점(원본 센서 픽셀 — 정규화 0..1 아님). */
export interface Px {
  x: number;
  y: number;
}

/**
 * ★ 육면체 6 DOF 각각의 **출처**. 필수 필드 — 문서와 코드가 갈라지지 않게 강제한다.
 *
 * `L: 'prior'` 는 **유니온이 아니라 리터럴**이다. 나중에 누가 "측면 접지선으로 L 을 관측하자"고 하면
 * 타입이 먼저 막고, 이 주석과 설계 §3-1(원리적 관측 불가)을 읽게 된다.
 */
export interface CuboidSource {
  /**
   * 위치 X,Y — 앞범퍼 접지선의 지면 역투영. 관측 아닌 육면체는 만들지 않는다.
   *
   * ⚠️ **'observed' 는 "관측에서 나왔다"는 뜻이지 "정확하다"는 뜻이 아니다.**
   *   **그 관측이 얼마나 정확한지 재는 지표는 현재 없다.**
   *   - `frontFitResidPx` 는 **자기참조 잔차**라 배치 오차에 눈이 멀었다(D-1 실증: 배치 1.34m 오차 → 0.00px).
   *   - 마스크 하단이 지면에서 z 만큼 뜨면(로커패널·범퍼하단·그림자) 접지선이 `D·z/(d−z)` 만큼 **뒤로 밀린다**.
   *     그 z 는 **미확정**이다(회귀 시도 → 주차 습관 setback 과 교락되어 분리 실패. §L4-6).
   *   - 배치 정확도를 재려면 **관측과 독립인 기준**이 필요하다: 육안(G3) / 외부 GT /
   *     **같은 차량을 서로 다른 D 에서 관측**(프리셋 시야 겹침 필요 — 현 데이터엔 공유 슬롯 0개).
   *   → 배치 정확도 지표를 **만들지 않았다**(없는 것을 있는 척하지 않는다). 이 주석이 그 사실의 유일한 기록이다.
   */
  position: 'observed';
  /** yaw — 슬롯 폴리곤 축(스트립 가정). 이미지에서 차량 방향을 재추정하지 않는다. */
  yaw: 'slot-prior';
  /** ★ L(길이) — 뒤쪽 접지선이 원리적으로 안 보인다 → **항상 prior**. */
  L: 'prior';
  /** W(폭) — 앞범퍼 접지선의 폭축 스팬. 유효열 부족/클램프 발동 시 prior 강등. */
  W: 'observed' | 'prior';
  /**
   * ★ H(높이) — **항상 prior**. 유니온이 아니라 리터럴이다(`L` 과 같은 방식 — 타입이 먼저 막는다).
   *
   * **차는 직육면체가 아니다 — 지붕은 짧고 뒤로 물러난 슬래브다.**
   * 마스크 상단을 육면체에 맞추면 그 접점은 **항상 모델의 뒤-상단 코너**(= tFront + L)가 되는데,
   * 그 코너는 **실제 지붕보다 멀리** 있어 이미지에서 더 위로 투영된다 → 맞추려면 h 를 낮춰야 한다
   * → **계통적 H 과소(실측 −0.30 ~ −0.42 m, 3프리셋 전부)**. 마스크 상단 역문제로는 H 를 관측할 수 없다.
   * (원리적으로 옳은 길은 육면체 실루엣 ↔ 마스크 정합이다 — 후속 과제. §L2-4 C안)
   */
  H: 'prior';
}

/** 마스크 하단 윤곽 1열(픽셀). */
export interface ContactCol {
  x: number;
  y: number;
}

/** 지면 기저(슬롯 폴리곤에서 유도). u = 폭축(주기 slotWidthM) / w = 깊이축(비주기, 카메라→안쪽 +). */
export interface SlotAxes {
  /** 폭축 단위벡터(카메라 좌표, 지면 평면 위). 스트립 진행방향. */
  u: Vec3;
  /** 깊이축 단위벡터(u 에 직교화됨). 부호 = 카메라에서 멀어지는 쪽. */
  w: Vec3;
  /** 지면 좌표 원점(전 슬롯 지면 코너의 중심). (a,b) = ((X−origin)·u, (X−origin)·w). */
  origin: Vec3;
  /** 슬롯별 u 축 방향의 스프레드(도, axial). > axisSpreadDeg 면 기각(스트립 가정 붕괴). */
  spreadDeg: number;
}

/** 차량 1대의 3D 육면체(관측 + prior). */
export interface VehicleCuboid {
  /**
   * ⚠️ **`buildVehicleCuboids` 입력 배열의 인덱스일 뿐 — VPD 검출 인덱스가 아니다.**
   * 입력은 (1) 마스크 없는 검출 drop, (2) 주차면 필터를 거치며 **두 번 재색인**된다.
   * 원본 검출로 되짚으려면 반드시 **`vpdIdx`** 를 써라. (0-based. cam/preset/slot 의 1-based 규약과 무관.)
   */
  boxIdx: number;
  /** ★ **원본 VPD 검출 인덱스**(0-based) — `bboxes[vpdIdx]`/`confidences[vpdIdx]`/`masks[vpdIdx]` 로 되짚는 유일한 키. */
  vpdIdx: number;
  cls: string;
  confidence: number;
  /** 바닥 4점(정규화 0..1). 규약 [FL,FR,RR,RL] — "앞"=카메라 쪽. 뷰어 projectCuboid 의 입력. */
  floorQuad: NormalizedQuad;
  /** 바닥 4점(지면 3D, 카메라좌표 m). 앵커 지표·검증용. */
  floorGround: [Vec3, Vec3, Vec3, Vec3];
  /**
   * ★ **관측된 접지 앞선의 중점**(지면 3D) = 앵커 지표의 C_vehicle.
   * `centerGround`(= 앞선 + PRIOR_L/2) 를 쓰면 **prior 가 지표에 주입**되어, prior 가 틀리면 지표가 조용히 틀린다(F-2).
   * 앵커는 **관측 대 관측**이어야 하므로 prior 가 한 번도 곱해지지 않은 이 점을 쓴다.
   */
  frontGround: Vec3;
  /** 접지 footprint 중심(지면 3D). ⚠️ PRIOR_L 의존 — 렌더/포함판정용. **깊이 지표에 쓰지 말 것**(F-2). */
  centerGround: Vec3;
  /** ⚠️ **관측치가 아니라 차종 prior**(= `PRIOR_H`). 마스크 상단으로 H 를 관측할 수 없다 — `CuboidSource.H` 참조. */
  heightM: number;
  widthM: number;
  lengthM: number;
  source: CuboidSource;
  /** 가림 배제 후 남은 유효 접지열 비율(0..1). 실측 하한 23%. */
  cleanRatio: number;
  /** 유효 접지열 수(가림 배제 후). */
  contactCols: number;
  /** 앞선 밴드 열 수 / 밴드 내 b 의 MAD(m) = **직선성**(bridge 게이트. v1 의 inlierRatio 를 대체 — v2 §B-1). */
  frontCount: number;
  frontMadM: number;
  /**
   * **앞선 적합 잔차**(px) — 재투영된 바닥 앞선(FL–FR) ↔ 그 앞선을 적합시킨 밴드 접지열의 수직거리 중앙값.
   *
   * 🔴 **이름 그대로 "적합 잔차"다. 배치(위치) 정확도가 아니다. 게이트로 쓰지 마라.**
   *   `tFront = median(앞선 밴드의 b)` 인데 이 값을 **그 밴드 자신과** 다시 비교한다(자기참조).
   *   ∴ 밴드가 Δb 만큼 **균일하게** 밀리면 tFront·FL·FR 이 함께 움직여 잔차는 **정확히 불변**이다.
   *   실증(검증자 D-1, 구현자 재현 — tilt 12°, D≈23m): 마스크 하단이 z 만큼 뜨면(로커패널·범퍼하단·그림자,
   *   설계 §A-2 ②) 접지선이 `push = D·z/(d−z)` 만큼 뒤로 밀리는데:
   *       z=0.10m → 배치 **+0.43m** 오차 / 이 값 **0.00px**
   *       z=0.30m → 배치 **+1.34m** 오차 / 이 값 **0.00px**
   *   (구명칭 `frontPxDev` + "밀림에 선형 반응 / 성공기준 ≤8px" 는 **거짓 주장**이었다 — 폐기됨.)
   *
   * 실제로 재는 것: **앞선 밴드가 얇고 곧은가**(직선성). `frontMadM` 의 픽셀판. **advisory 전용.**
   * 봉인: `test/cuboidBoundary.test.ts` §5.
   */
  frontFitResidPx: number | null;
  /**
   * ⚠️ **참고 출력 전용 — 성공 기준·게이트·배지에 쓰지 마라.** 재투영 육면체 AABB vs VPD bbox 의 IoU.
   * 폐기 근거(Loop 1 실증): **육안 명백 실패 육면체가 IoU 0.74~0.83**. AABB 는 육면체를 뭉개서
   * 깊이 방향 밀림을 작은 y 이동으로만 드러낸다 → **배치 오류에 구조적으로 둔감**하다.
   */
  reprojIou: number | null;
  /** advisory(강등 사유). throw 금지 — 조용한 실패 금지. */
  issues: string[];
}

/** 육면체를 못 만든 차량(사유 보존 — 조용히 사라지지 않는다). */
export interface RejectedVehicle {
  /** ⚠️ 입력 배열 인덱스. **VPD 검출 인덱스가 아니다** — `VehicleCuboid.boxIdx` 주석 참조. */
  boxIdx: number;
  /** ★ 원본 VPD 검출 인덱스(0-based). 강등된 차량을 원본 검출로 되짚는 유일한 키. */
  vpdIdx: number;
  issues: string[];
}

/**
 * ★ 2 DOF 앵커 지표(설계 §6). 프리셋 단위.
 * **슬롯 배정(어느 차 ↔ 어느 슬롯)을 절대 쓰지 않는다** — 최근접 배정을 쓰면 밀린 슬롯이 차량을 다시 흡수해
 * 지표가 스스로 침묵한다(순환).
 */
export interface AnchorMetrics {
  /** ① 깊이축 계통편차(m). 슬롯 깊이 중심 대비 차량 접지 중심의 median. **비주기 → 모든 밀림에 반응**. */
  depthDevM: number | null;
  /**
   * ② 폭축 격자 위상편차(m), ∈ [−P/2, P/2] (P = 슬롯 폭 2.5m).
   * ⚠️ **주기 P → Δ = k×2.5m 정수배 밀림에는 원리적으로 침묵한다**(설계 §6-3). 은닉 금지 — 알려진 한계.
   */
  phaseDevM: number | null;
  /**
   * ③ 어떤 슬롯 폴리곤에도 안 들어가는 차량 비율. advisory 전용 — **임계 게이팅 금지**.
   * ⚠️⚠️ **폭축 정수배 밀림에서 이 지표도 0 이 될 수 있다**(F-3 실측: 스트립 끝단에 차량이 없으면 신호 0).
   * 설계 §6-5 의 "약한 반응" 예측은 **틀렸다**. → **폭축 정수배 = 3지표 전부 침묵 가능**(원리적 한계, 은닉 금지).
   */
  unmatchedRate: number | null;
  /** 표본 수(유효 육면체 차량). < minAnchorN 이면 위 셋 전부 null. */
  n: number;
  issues: string[];
}

/** 접지선 파이프라인 파라미터. 임계는 리더의 실측(G6) 후 확정 — **이 한 곳에서만 바꾼다**. */
export interface ContactOptions {
  /** 하단 윤곽 스캔 컬럼 간격(px). */
  colStepPx: number;
  /** 가림 판정 오프셋(px). 윤곽점 바로 아래 이 만큼이 다른 차량 마스크 안이면 접지선 아님. */
  belowPx: number;
  /**
   * ★ v2 앞선 적합(near-edge). 오염이 전부 **단방향(+b)** 이므로 참된 접지는 b 최솟값 쪽에 있다.
   * `qNear` = 하위 분위수(최솟값 금지 — bridge/누출은 양방향). `frontBandM` = 그로부터의 밴드 두께(m).
   */
  qNear: number;
  frontBandM: number;
  /** 앞범퍼 검증: 앞선 밴드의 폭축 스팬 하한(m). 미만이면 **육면체 미산출**(flank 만 보임/원경/가림 과다). */
  minFrontSpanM: number;
  /** 앞선 밴드 최소 열 수. */
  minFrontCols: number;
  /** ★ bridge 게이트: 앞선 밴드 내 b 의 MAD 상한(m). **비율(inlierRatio)이 아니라 잔차로 잰다**(v2 §B-1). */
  frontMadMaxM: number;
  /** 최소 유효 접지열 수. 미만이면 육면체 미산출(가림 과다). */
  minContactCols: number;
  /** 최소 마스크 면적(px²). 미만이면 그 차량 skip. */
  minMaskAreaPx: number;
  /** cleanRatio 가 이 값 미만이면 산출은 하되 advisory. */
  cleanRatioWarn: number;
  /** 관측 폭이 이 값 미만이면 W prior 강등(m) — 병적 케이스(설계 §8 #10). */
  minWidthM: number;
  /**
   * ★ 관측 폭 클램프 대역(priorW 배수, F-1). 실루엣 하단 윤곽은 비정면 시야에서 **상단→하단 모서리를 잇는
   * 현(chord)** 위를 지나는데, 그 점들은 지면점이 아닌데 지면으로 역투영되어 폭을 부풀린다(실측 +18%).
   * 물리적으로 불가능한 폭을 잘라내고 **출처를 'prior' 로 강등**한다(현 기하 보정 모델은 만들지 않는다 — CLAUDE.md §2).
   */
  widthClampLoFactor: number;
  widthClampHiFactor: number;
  /** 슬롯 축 스프레드 상한(도). 초과 시 축 기각(육면체 미산출). */
  axisSpreadDeg: number;
  /** ★ 차종 prior(m) — G6 실측 후 리더가 조정. 한 곳에 모은다. */
  priorL: number;
  priorW: number;
  priorH: number;
}

/**
 * ★ 차종 prior(리더 결정 Q3 — 일반 세단 규격). G6 실측 후 여기만 고친다.
 *
 * ⚠️⚠️ **`PRIOR_H` 를 검증용 GT(시뮬레이터 차량 실제 전고)에 맞춰 "정밀화" 하지 마라.**
 *   H 는 이제 **관측이 아니라 이 prior 그 자체**다(`CuboidSource.H: 'prior'`). GT 를 여기에 흘려 넣으면
 *   검증(H 오차)이 **자기 자신을 검증하는 순환논법**이 된다. GT 는 테스트/하네스에만 존재해야 한다.
 *   현재 1.45 는 **GT 를 알기 전에** 일반 세단 규격으로 정한 값이다 — 그대로 둔다.
 */
export const PRIOR_L = 4.7;
export const PRIOR_W = 1.85;
export const PRIOR_H = 1.45;

export const DEFAULT_CONTACT_OPTIONS: ContactOptions = {
  colStepPx: 4,
  belowPx: 6,
  qNear: 0.05,
  frontBandM: 0.5,
  minFrontSpanM: 1.2,
  minFrontCols: 8,
  frontMadMaxM: 0.2,
  minContactCols: 12,
  minMaskAreaPx: 400,
  cleanRatioWarn: 0.25,
  minWidthM: 1.0,
  widthClampLoFactor: 0.85, // 1.5725 m @ PRIOR_W 1.85
  widthClampHiFactor: 1.15, // 2.1275 m @ PRIOR_W 1.85
  axisSpreadDeg: 10,
  priorL: PRIOR_L,
  priorW: PRIOR_W,
  priorH: PRIOR_H,
};

/** 앵커 지표 파라미터. 임계는 G6 실측 후 확정. */
export interface AnchorOptions {
  /** 슬롯 폭축 격자 주기(m) = 슬롯 폭. phaseDevM 의 주기. */
  periodM: number;
  /** 표본 하한. 미만이면 지표 3종 전부 null(median 이 의미 없다). */
  minAnchorN: number;
}

export const DEFAULT_ANCHOR_OPTIONS: AnchorOptions = { periodM: 2.5, minAnchorN: 3 };

/** 경보 임계(advisory 전용 — 게이팅하지 않는다). 리더 실측(G4/G6) 후 확정. */
export const DEPTH_DEV_M = 0.5;
export const PHASE_DEV_M = 0.4;
