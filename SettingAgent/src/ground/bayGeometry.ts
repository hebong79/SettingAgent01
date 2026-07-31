// 도색 증거 → 베이 코너 4점(Stage B) — **순수 · IO 0 · 수동 ROI 무참조(R1)**.
//
// 이 파일은 수동 정본 모듈을 어떤 경로로도 import 하지 않는다(그래서 그 심볼 이름을 여기 적지 않는다).
// `test/roiAutoHoldout.test.ts` 가 소스 문자열로 정적 봉인한다.
//
// 재사용(R4): 투영 수학은 `project.ts`(backprojectToGround / projectToPixel), f 는 `groundModel.ts:focalFromVPs`,
//   quad 캐노니컬화는 `groundGrid.ts:canonicalizeQuad`. **신규 투영·IoU 수식 0줄.**
//
// 결정론(R2): 난수 0 · RANSAC 0. 소실점 가설은 후보 쌍 **전수 순회**로 만들고, 격자 배정은 삼중 전수 순회다.
//   동점은 항상 먼저 순회한 쪽(낮은 인덱스)이 이긴다.
//
// 기하 골격(설계 §2 Stage B):
//   근변 코너 = 전방 도색선 ∩ 분리선           ← 이미지에서 **직접** 검출
//   원변 코너 = 근변 코너 + 깊이방향 × (깊이/폭 비율)  ← 소실점 기하로 복원(원변은 차량에 완전히 가려 관측 불가)
//   깊이 절대치는 쓰지 않는다 — quad 형상은 `slotDepthM/slotWidthM` **비율**에만 의존한다.

import { focalFromVPs } from './groundModel.js';
import { canonicalizeQuad } from './groundGrid.js';
import { backprojectToGround, projectToPixel } from './project.js';
import {
  edgePaintSupport,
  lineThrough,
  meetLines as meet2,
  type EdgeSupport,
  type Line2,
  type PaintEvidence,
  type PaintOptions,
  type RefinedLine,
} from './floorPaint.js';
import type { Px, Vec3 } from './contactTypes.js';
import type { GroundModel, PixelQuad } from './types.js';

/** 강등 코드(설계 §7). 전부 수치 판정이며, 해당 구간은 자동 대상에서 **빠진다**(억지로 채우지 않는다). */
export const DEGRADE = {
  TOO_FEW_BAYS: 'D1_TOO_FEW_BAYS',
  NO_FRONT_LINE: 'D2_NO_FRONT_LINE',
  FEW_SEPARATORS: 'D3_FEW_SEPARATORS',
  ROW_RESID: 'D4_ROW_RESID',
  VP_DEGENERATE: 'D5_VP_DEGENERATE',
  HEIGHT_DEV: 'D6_HEIGHT_DEV',
  WIDTH_SPREAD: 'D7_WIDTH_SPREAD',
  NON_QUAD: 'D8_NON_QUAD',
  SLOT24: 'D9_SLOT24',
  ANCHOR_DEFECT: 'D10_ANCHOR_DEFECT',
  SYNTHETIC_CUE: 'D11_SYNTHETIC_CUE',
  /** 기하는 서지만 산출 격자가 도색 위에 있지 않다(P1 재투영 검증 실패). */
  NO_PAINT_SUPPORT: 'D12_NO_PAINT_SUPPORT',
} as const;

export interface BayDetectOpts {
  slotWidthM: number;
  slotDepthM: number;
  /**
   * 프리셋의 베이 개수. 정본 **메타데이터**(개수)이며 기하가 아니다 — 설계 §3 선언 누출 1.
   *
   * ★ 18회차 — `bayGrid` 의 `rowExtentMode:'evidence'`(기본) 경로는 **이 값을 쓰지 않는다.**
   *   여전히 필수 필드인 이유는 구 경로(`detectBays`/`detectBaysPaired`)와 `'expected'` 회귀 모드가 쓰기 때문이다.
   */
  expectedBays: number;
  /** 설정상 카메라 지상고(m). 이미지 추정치의 자기검증에만 쓴다. 미상이면 null. */
  cameraHeightM: number | null;
  /** 격자 배정에서 허용하는 최대 결손 간격. */
  maxGap: number;
  /** 격자 인라이어 허용 잔차(px). */
  latticeTolPx: number;
  /** 격자 인라이어 최소 개수. */
  minPicks: number;
  /** 소실점 수렴 허용 잔차(px, 선분 길이 적응형). */
  vpTolPx: number;
  /** 전방선 위 근접 교점 병합 거리(px). */
  cornerMergePx: number;
  /** 등간격 잔차 상한(px) — 초과 시 D4. */
  maxRowResidPx: number;
  /** 폭 편차 상한(%) — 초과 시 D7. */
  maxWidthSpreadPct: number;
  /** 지상고 편차 상한(%) — 초과 시 D6 경고. */
  maxHeightDevPct: number;
  // ── 재투영 도색지지(P1)
  /**
   * 근변 도색지지 하한(0~1). 이 미만인 가설은 **후보에서 탈락**한다.
   * 근변은 카메라에 가장 가까운 도색선이라 가림이 가장 적다 — 여기에 지지가 없으면 그 격자는 도색 위에 있지 않다.
   */
  minNearSupport: number;
  /** 점수 가중 — 근변(필수). */
  nearWeight: number;
  /** 점수 가중 — 좌우 분리변(부분 지지만 기대: 스텁만 보인다). */
  sideWeight: number;
  /**
   * 점수 가중 — 원변(**요구하지 않는다**. 보너스일 뿐).
   * 설계자 실측(F2): 원변은 차량에 가려 도색 증거가 원리적으로 없다(검출 2~6/9). 요구하면 옳은 가설이 탈락한다.
   * 그러나 보이는 프리셋(2:2 는 전 4변이 보인다)에서는 근변/원변 모호성을 깨는 결정적 신호가 된다.
   */
  farWeight: number;
  // ── 평행 도색선 쌍(P2)
  /** 근변↔원변 현(chord)이 공통 소실점에 수렴해야 하는 허용 잔차(px). */
  chordResidPx: number;
  /** 재구성한 깊이/폭 이 slotDepthM/slotWidthM 에서 벗어나도 되는 상대 허용치. */
  depthRatioTol: number;
  // ── 격자 확장
  /** 확장 좌표가 기존 스팬의 이 배수를 넘으면 외삽을 멈춘다(지평선 근처 발산 방어). */
  maxExtendSpanFactor: number;
  /** 확장으로 생긴 quad 를 유지하는 근변 도색지지 하한. */
  extendMinNearSupport: number;
  // ── 지면모델 주입형 격자(bayGrid)
  /** 위상 균등 스윕 분할 수(한 칸을 몇 등분해 훑을 것인가). */
  phaseSteps: number;
  /** 행 스팬 상한(m). 이보다 넓으면 지평선 근처 역투영 발산으로 본다. */
  maxRowSpanM: number;
  /** 한 위상에서 만들 최대 칸 수(발산 방어). */
  maxRowCells: number;
  /** 커버리지(세운 칸/기대 칸) 가중 지수. 0 이면 커버리지 무시. */
  coverageExponent: number;
  /**
   * ★ 21회차 ② — 커버리지의 **분모·분자를 어느 척도로 잡는가**. 위상·개수 의존을 가르는 스위치다.
   *
   *  `'expectedBays'`(기본) — 종전 식. 분자 = 칸 **개수**, 분모 = `min(expectedBays, inFrameCells)`.
   *      **면수를 아는 호출자**(프리셋 모드 = 정본 면수)만 쓴다. 골든 기준선이 이 식에서 나온다.
   *      한계는 측정으로 확정돼 있다: 분모가 위상의 함수(F18)이고, 반칸 밀린 위상이 온전한 1칸을
   *      반쪽 2칸으로 쪼개 **개수 보너스**를 얻는다(20c) → 임의 뷰에서 `expectedBays ≥ 7` 이면 재현율 0.
   *
   *  `'phaseInvariant'` — 분자 = **Σ 칸별 근변지지**(증거 가중 유효 칸수), 분모 = **근변 도색 지지
   *      구간의 칸 수**. 둘 다 **위상과 무관**하고 `expectedBays` 를 읽지 않는다.
   *      **면수를 모르는 호출자**(현재 화면 그대로 · 칸을 비운 경우)가 쓴다. 실측(A 조건 pan60/tilt14/zoom1.3):
   *      `bays 1~16` 전 구간에서 승자 위상·재현율 0.6000·매칭 IoU 0.92783 이 **비트 동일**(종전은 ≥7 에서 0).
   *
   * ★ 왜 하나로 통일하지 않았는가(구현자 실측 · 리더 게이트 판정): 통일하면 골든 `rows` 정밀도가
   *   0.8571 → 0.5217 로 떨어진다(재현율 0.5854 유지 · 매칭 IoU 0.88860 → 0.91112). 원인은 검출이 아니라
   *   **`rows` 진입 문턱의 판별력 부재**다 — 1:2 의 참 행은 상대비 0.7164, 2:1 의 잡음 행은 0.7238~0.7330 로
   *   **잡음이 참보다 위에 있어** 어떤 문턱값으로도 가를 수 없다(구현자 실측). 그 문턱을 먼저 고쳐야 통일이 된다.
   */
  coverageDenom: 'expectedBays' | 'phaseInvariant';
  /** 위상 적합(검출 코너 ↔ 격자 경계 거리)의 선택 점수 가중. 0 이면 tie-break 로만 쓴다. */
  phaseFitWeight: number;
  /**
   * ★ 조준 중심성 가중 — 프리셋이 **겨냥한** 행을 고르기 위한 항(5회차).
   *
   * 근거(구현자 실측): 한 프레임에 **실재하는 주차열이 여럿** 있고, 도색지지는 그 중 어느 것이
   * 이 프리셋의 대상인지 말해 주지 못한다. 1:2 는 승자 quad 중심이 y=10~108(약 31m 거리),
   * 정답 행은 y=370~680 이었다. 둘 다 진짜 열이다.
   * 그러나 프리셋의 PTZ 는 운영자가 **대상 열을 향해** 맞춘 것이므로, 대상 열은 화면 중앙 근처에 온다.
   * 이것은 카메라 조준 사실이지 주차면 정답지가 아니다(fov·tilt 와 같은 부류).
   */
  aimCenterWeight: number;
  /**
   * ★ 행 거리 타당성 게이트(5회차 P3 대안) — 후보 행의 지면거리가 **최근접 후보의 이 배수**를 넘으면 탈락.
   *
   * 근거: 한 프레임에 실재 주차열이 여럿 있고, 먼 열은 프리셋의 대상이 아니다(구현자 실측:
   * 1:2 승자는 ~31m, 정답 행은 ~10m — 3.1배). 튜닝된 소프트 가중치보다 프레임 수에 덜 민감하다.
   * 0 이하면 게이트를 끈다.
   */
  maxRowDistanceRatio: number;
  /** ★ 근변선 2자유도 재적합 사용 여부(8회차). */
  refitFrontLine: boolean;
  /** 재적합 시 행 전 구간에서 뜨는 표본 수(지레팔을 길게 쓰기 위해 초기 검출보다 많이). */
  rowRefitSamples: number;
  /** 재적합 반복 횟수 상한. */
  rowRefitPasses: number;
  /** 법선 이동이 이보다 작으면 수렴으로 보고 멈춘다(px). */
  rowRefitStopPx: number;
  /** 재적합 이물 절단 임계 계수(median + k·MAD). 작을수록 공격적으로 자른다. */
  rowRefitTrimK: number;
  /** 재적합 채택 시 허용하는 근변 도색지지 하락폭. 이보다 크게 떨어지면 재적합을 버린다. */
  rowRefitSupportDrop: number;
  /** >0 이면 재적합에 **구간 균등 가중** TLS 를 쓴다(표본 밀집 편향 제거). 0 이면 비가중. */
  rowRefitUniformBins: number;
  /** 재적합 감쇠(0~1). 1 = 감쇠 없음. 진동하는 프리셋용. */
  rowRefitDamping: number;
  /**
   * ★ 행 범위 결정 방식(18회차 A). **`bayGrid` 전용** — 구 경로는 보지 않는다.
   *
   *  'evidence' — 도색지지가 연속인 구간(run)을 행으로 삼는다. **개수 정보를 쓰지 않는다**(기본).
   *               run 내부 결손은 가림으로 보고 보간하고, 창 밖으로는 한 칸도 외삽하지 않는다.
   *  'expected' — `expectedBays` N칸 연속창(17회차까지의 동작). **회귀 비교 전용.**
   *
   * `expectedBays` 명시 여부와 **연동하지 않는다**: 서비스는 정본 면수를 항상 채워 넣으므로
   * 연동하면 새 규칙이 영영 발화하지 않고, 실카는 반대로 상수를 명시해 옛 동작에 고정된다.
   */
  rowExtentMode: 'evidence' | 'expected';
  /**
   * 다중 행 목록(`GridDetection.rows`)에서 두 quad 를 **같은 칸**으로 볼 최소 IoU.
   * 겹침 비율이 절반을 넘으면 같은 행으로 보고 점수 낮은 쪽을 버린다.
   */
  rowMergeIoU: number;
  /**
   * ★ 19회차 — 다중 행 목록의 **진입 문턱 ①**: `best` 로 뽑힌 후보의 `paint.score` 대비 최소 비율.
   *
   * 절대값이 아니라 **상대비**인 이유: 프리셋마다 도색 대비·해상도가 달라 `paint.score` 스케일이 다르다
   * (실측 프리셋별 최대 0.919~1.559). 같은 프레임 안에서 비교해야 의미가 있다.
   * 0 이면 이 문턱을 쓰지 않는다(18회차 동작).
   */
  rowMinScoreRatio: number;
  /**
   * ★ 19회차 — 다중 행 목록의 **진입 문턱 ②**: 행의 근변 도색지지 하한(`paint.near`).
   * `minNearSupport`(격자 성립 하한)와 별개다 — 이건 "사람에게 보여줄 목록에 넣을 자격"이다.
   * 0 이면 이 문턱을 쓰지 않는다(18회차 동작).
   */
  rowMinNearSupport: number;
  /** ★ 설치고 자가보정 사용 여부(관측 폭 → 규격 폭). */
  calibrateHeight: boolean;
  /** 자가보정 계수의 허용 범위(|factor−1|). 이보다 크면 보정을 **거부**한다(엉뚱한 행 방어). */
  maxHeightCorrection: number;
}

export const DEFAULT_BAY_OPTS: Omit<BayDetectOpts, 'expectedBays'> = {
  slotWidthM: 2.5,
  slotDepthM: 5.0,
  cameraHeightM: 5.0,
  maxGap: 3,
  latticeTolPx: 3.0,
  minPicks: 4,
  vpTolPx: 4.0,
  cornerMergePx: 12,
  maxRowResidPx: 2.0,
  maxWidthSpreadPct: 12,
  maxHeightDevPct: 25,
  minNearSupport: 0.5,
  nearWeight: 1.0,
  sideWeight: 0.5,
  farWeight: 0.3,
  chordResidPx: 6.0,
  depthRatioTol: 0.25,
  maxExtendSpanFactor: 1.5,
  extendMinNearSupport: 0.35,
  phaseSteps: 40,
  maxRowSpanM: 200,
  maxRowCells: 60,
  coverageExponent: 1,
  // 기본은 종전 식이다 — 골든·프리셋 응답이 비트 동일해야 한다(무회귀 규약). 면수를 모르는 호출자만 바꾼다.
  coverageDenom: 'expectedBays',
  phaseFitWeight: 0,
  // 실측 스윕(5회차): 0/0.5/1.0 은 무효, **1.6 에서 1:2 가 0.00000 → 0.73858 로 전환**하고
  // 2.2 까지 동일(평탄역이라 임계 직전값이 아니다). 1:1·2:1·1:3 은 전 구간 불변.
  aimCenterWeight: 1.6,
  maxRowDistanceRatio: 0,
  refitFrontLine: true,
  rowRefitSamples: 61,
  // 10회차 실측: 패스 2 와 5 의 결과가 **완전히 동일**하다(1:1 은 pass2 에서 이동 0.0095px 로 수렴).
  // 반복 부족이 원인이 아니었다 — §2 참조.
  rowRefitPasses: 2,
  rowRefitStopPx: 0.1,
  // ★ 실측 스윕(8회차 §3): **절단 없음(0) + 엄격 가드**가 ≥0.98 통과 면수 최대(3면).
  //   이물 절단은 1:1 의 회전을 완전히 없애 균일 0.9774~0.9789 를 만들지만 전부 0.98 **직하**이고,
  //   2:1 은 표본이 59→31 로 줄며 0.966 → 0.904 로 후퇴한다. 긴 지레팔이 이물 제거보다 이득이 크다.
  rowRefitTrimK: 0,
  rowRefitSupportDrop: 0,
  // 균등가중은 실측상 무효였다(1:1 0.97667→0.97653) — 표본 59/61 이 살아남아 밀집 편향이 애초에 없다. 기본 0.
  rowRefitUniformBins: 0,
  // 감쇠 0.5 는 수렴을 매끄럽게 만들지만(1.577→0.784→0.391→0.199→0.097) IoU 는 오히려 내려간다
  // (1:1 0.97667→0.97559, 2:1 통과면 1→0). 같은 고정점에 느리게 갈 뿐이다. 기본 1(감쇠 없음).
  rowRefitDamping: 1,
  // ★ 18회차 기본값 — 마스터 목표 ①("개수를 모른 채 보이는 주차면을 모두 찾는다").
  rowExtentMode: 'evidence',
  rowMergeIoU: 0.5,
  // ★ 19회차 실측(골든 v1 5프리셋 · 후보 39개 · 씬 정답 라벨)으로 **골짜기를 보고** 정했다.
  //   `paint.score` 단독으로는 못 가른다 — 진짜 0.867~1.559 / 가짜 0.671~1.354 로 구간이 겹친다.
  //   `best` 대비 상대비로 바꾸면 0.916(가짜) ↔ 0.969(진짜) 사이에 폭 0.053 의 빈 구간이 생기고
  //   진짜 6개가 전부 그 위에 있다. 그 구간의 중앙(0.9425)을 잡아 0.94.
  rowMinScoreRatio: 0.94,
  // 위 문턱을 통과한 12개 안에서 `paint.near` 가 0.667(가짜) ↔ 0.714(진짜) 로 다시 갈린다(폭 0.047).
  //   ⚠ 표본은 진짜 6개뿐이라 과적합 위험이 있다 — 두 값 모두 **관측된 골짜기 중앙**이며 추정이 아니다.
  rowMinNearSupport: 0.69,
  calibrateHeight: true,
  maxHeightCorrection: 0.15,
};

/** 자동 산출 quad 1건 — 격자 인덱스(0-based, 프리셋 로컬)와 픽셀 4점. */
export interface BayQuad {
  latticeIndex: number;
  quad: PixelQuad;
}

export interface BayDetection {
  frontLine: [number, number, number] | null;
  separators: Array<[number, number, number]>;
  /** 근변 코너(전방선 ∩ 분리선), 전방선 위 위치 오름차순. */
  cornersPx: Array<{ x: number; y: number }>;
  /** cornersPx 의 정수 격자 인덱스(결손 허용, 0 기준). */
  latticeIndex: number[];
  vpDepth: { x: number; y: number } | null;
  vpRow: { x: number; y: number } | null;
  focalPx: number | null;
  normal: [number, number, number] | null;
  /** 이미지 증거만으로 추정한 카메라 지상고(m). */
  cameraHeightM: number | null;
  quads: BayQuad[];
  diag: {
    lines: number;
    frontCandidates: number;
    hypotheses: number;
    rowResidPx: number | null;
    latticeResidPx: number | null;
    widthSpreadPct: number | null;
    heightDevPct: number | null;
    /** 선택된 가설의 재투영 도색지지(P1). 가설 0건이면 null. */
    paint: PaintSupport | null;
    /** 기하 게이트는 통과했으나 근변 도색지지 미달로 탈락한 가설 수. */
    rejectedByPaint: number;
    /** 단계별 탈락 수 — 어느 구속이 후보를 죽였는지 숫자로 드러낸다(가설 선별 디버깅의 유일한 창). */
    gate: { noLattice: number; buildFail: number; widthSpread: number; heightDev: number; paint: number };
    /** buildFromCorners 탈락 사유별 건수(강등 코드 → 수). 어느 기하 구속이 막는지 드러낸다. */
    buildIssues: Record<string, number>;
  };
  issues: string[];
}

/** 다수 직선의 최소제곱 교점(정규화 직선거리 최소화, 2×2 정규방정식 — 닫힌 해). */
export function meetLinesLS(lines: ReadonlyArray<Line2>): { x: number; y: number } | null {
  let saa = 0;
  let sab = 0;
  let sbb = 0;
  let sac = 0;
  let sbc = 0;
  for (const [a, b, c] of lines) {
    saa += a * a;
    sab += a * b;
    sbb += b * b;
    sac += a * c;
    sbc += b * c;
  }
  const det = saa * sbb - sab * sab;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const x = (-sac * sbb + sbc * sab) / det;
  const y = (-sbc * saa + sac * sab) / det;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/**
 * 선분(A,B)이 소실점 V 로 얼마나 정확히 향하는가 — **px 단위** 잔차.
 *
 * 각도 잔차를 쓰면 짧은 스텁이 원리적으로 불리해진다(길이 100px·중심오차 0.5px → 각오차 0.57°).
 * 길이로 정규화한 px 잔차가 서브픽셀 잡음과 직접 비교 가능한 유일한 척도다(구현자 실측 근거).
 */
export function vpResidPx(V: { x: number; y: number }, A: { x: number; y: number }, B: { x: number; y: number }): number {
  const mx = (A.x + B.x) / 2;
  const my = (A.y + B.y) / 2;
  const vx = V.x - mx;
  const vy = V.y - my;
  const vn = Math.hypot(vx, vy);
  if (!(vn > 1e-6)) return Number.POSITIVE_INFINITY;
  return Math.abs(vx * (A.y - my) - vy * (A.x - mx)) / vn;
}

/** 사영 1D 모형 `s(t) = (a t + b)/(c t + 1)`. */
export interface Projective1D {
  a: number;
  b: number;
  c: number;
}

/** 3×3 가우스 소거(부분 피벗). 특이 → null. */
function solve3x3(M: number[][]): [number, number, number] | null {
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    const tmp = M[c];
    M[c] = M[piv];
    M[piv] = tmp;
    if (Math.abs(M[c][c]) < 1e-12) return null;
    const d = M[c][c];
    for (let j = c; j <= 3; j++) M[c][j] /= d;
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = M[r][c];
      for (let j = c; j <= 3; j++) M[r][j] -= f * M[c][j];
    }
  }
  const out: [number, number, number] = [M[0][3], M[1][3], M[2][3]];
  return out.every(Number.isFinite) ? out : null;
}

/** 점-인덱스 쌍 → 사영 1D 최소제곱 적합(3×3 정규방정식). 표본 3개 미만/특이 → null. */
export function fitProjective1D(s: readonly number[], index: readonly number[]): Projective1D | null {
  if (s.length < 3 || s.length !== index.length) return null;
  const ata = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const atb = [0, 0, 0];
  for (let i = 0; i < s.length; i++) {
    const A = [index[i], 1, -s[i] * index[i]];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) ata[a][b] += A[a] * A[b];
      atb[a] += A[a] * s[i];
    }
  }
  const sol = solve3x3(ata.map((r, i) => [...r, atb[i]]));
  return sol ? { a: sol[0], b: sol[1], c: sol[2] } : null;
}

export const predictS = (m: Projective1D, t: number): number => (m.a * t + m.b) / (m.c * t + 1);
const inverseT = (m: Projective1D, s: number): number | null => {
  const den = m.a - s * m.c;
  return Math.abs(den) < 1e-12 ? null : (s - m.b) / den;
};

interface LatticePick {
  at: number;
  index: number;
  residPx: number;
}

/** 모델 → 인라이어(정수 인덱스 유일). 입력 s 는 오름차순. */
function inliersOf(s: readonly number[], m: Projective1D, tolPx: number, maxIndex: number): LatticePick[] {
  const out: LatticePick[] = [];
  const used = new Set<number>();
  for (let i = 0; i < s.length; i++) {
    const t = inverseT(m, s[i]);
    if (t == null || !Number.isFinite(t)) continue;
    const r = Math.round(t);
    if (r < -maxIndex || r > maxIndex || used.has(r)) continue;
    const d = Math.abs(predictS(m, r) - s[i]);
    if (d > tolPx) continue;
    used.add(r);
    out.push({ at: i, index: r, residPx: d });
  }
  return out;
}

/**
 * ★ 베이 개수 제약 — 인덱스 범위가 N 이내인 최대 창만 남긴다.
 * 없으면 격자 탐색이 잡음 교점으로 임의의 미세 격자를 만든다(구현자 실측: index 0..28 의 허위 격자).
 */
function trimToSpan(inl: readonly LatticePick[], N: number): LatticePick[] {
  if (!(N > 0)) return [...inl];
  let best: LatticePick[] = [];
  for (const anchor of inl) {
    const win = inl.filter((e) => e.index >= anchor.index && e.index <= anchor.index + N);
    if (win.length > best.length || (win.length === best.length && best.length > 0 && win[0].index < best[0].index)) {
      best = win;
    }
  }
  return best;
}

/**
 * 최대 사영등간격 부분집합 — 삼중 전수 순회 × 격자간격 후보. 난수 0.
 * 선택: 인라이어 수 desc → 잔차합 asc → 순회 순서(낮은 인덱스) 우선.
 */
export function bestLattice(
  s: readonly number[],
  opts: Pick<BayDetectOpts, 'maxGap' | 'latticeTolPx' | 'minPicks' | 'expectedBays'>,
): { model: Projective1D; picks: LatticePick[]; residPx: number } | null {
  const n = s.length;
  if (n < opts.minPicks) return null;
  const maxIndex = opts.expectedBays + opts.maxGap + 2;
  let best: { m: Projective1D; inl: LatticePick[]; cost: number } | null = null;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        for (let g1 = 1; g1 <= opts.maxGap; g1++) {
          for (let g2 = 1; g2 <= opts.maxGap; g2++) {
            const sol = solve3x3([
              [0, 1, -s[i] * 0, s[i]],
              [g1, 1, -s[j] * g1, s[j]],
              [g1 + g2, 1, -s[k] * (g1 + g2), s[k]],
            ]);
            if (!sol) continue;
            const m: Projective1D = { a: sol[0], b: sol[1], c: sol[2] };
            const inl = trimToSpan(inliersOf(s, m, opts.latticeTolPx, maxIndex), opts.expectedBays);
            if (inl.length < opts.minPicks) continue;
            const cost = inl.reduce((x, y) => x + y.residPx, 0);
            if (!best || inl.length > best.inl.length || (inl.length === best.inl.length && cost < best.cost - 1e-9)) {
              best = { m, inl, cost };
            }
          }
        }
      }
    }
  }
  if (!best) return null;
  // 인라이어 전체로 재적합 → 재선별(2회 고정, 결정론).
  for (let it = 0; it < 2; it++) {
    const cur: { m: Projective1D; inl: LatticePick[]; cost: number } = best;
    const m = fitProjective1D(cur.inl.map((e) => s[e.at]), cur.inl.map((e) => e.index));
    if (!m) break;
    const inl = trimToSpan(inliersOf(s, m, opts.latticeTolPx, maxIndex), opts.expectedBays);
    if (inl.length < cur.inl.length) break;
    best = { m, inl, cost: inl.reduce((x, y) => x + y.residPx, 0) };
  }
  const found: { m: Projective1D; inl: LatticePick[]; cost: number } = best;
  const base = Math.min(...found.inl.map((e) => e.index));
  return {
    model: found.m,
    picks: found.inl.map((e) => ({ at: e.at, index: e.index - base, residPx: e.residPx })),
    residPx: Math.max(...found.inl.map((e) => e.residPx)),
  };
}

/** 검출 결과에서 조립한 지면모델(`source:'auto'`). 뷰어·진단이 기존 GroundModel 과 같은 규약으로 읽는다. */
function assembleModel(
  camIdx: number,
  presetIdx: number,
  imgW: number,
  imgH: number,
  zoom: number,
  f: number,
  n: [number, number, number],
  d: number,
  issues: string[],
): GroundModel {
  return {
    camIdx,
    presetIdx,
    imgW,
    imgH,
    zoom,
    f,
    n,
    d,
    tiltDeg: (Math.asin(Math.max(-1, Math.min(1, n[2]))) * 180) / Math.PI,
    ptzTiltDeg: null,
    tiltErrDeg: null,
    slotBearingDeg: null,
    bearingDevDeg: null,
    dDevRel: null,
    depthEdgePx: 0,
    metricErr: 0,
    conf: 0,
    source: 'auto',
    issues,
  };
}

/** 정렬 median. 빈 배열 → NaN. */
function median(xs: readonly number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

interface BuildResult {
  vpRow: { x: number; y: number };
  focalPx: number;
  normal: [number, number, number];
  cameraHeightM: number;
  rowResidPx: number;
  widthSpreadPct: number;
  quads: BayQuad[];
  model: GroundModel;
}

/**
 * B5~B9. 근변 코너 + 깊이 소실점 → 행 소실점 · f · 지면법선 · 원변 코너 · quad.
 * 투영은 `project.ts` 만 쓴다(신규 수식 0). 어느 단계든 퇴화하면 **null + 사유**(throw 금지).
 */
export function buildFromCorners(
  corners: ReadonlyArray<{ x: number; y: number }>,
  index: readonly number[],
  vpDepth: { x: number; y: number },
  camIdx: number,
  presetIdx: number,
  imgW: number,
  imgH: number,
  zoom: number,
  opts: BayDetectOpts,
): { ok: BuildResult } | { ok: null; issue: string } {
  if (corners.length < 3 || corners.length !== index.length) return { ok: null, issue: `${DEGRADE.TOO_FEW_BAYS}: 코너 ${corners.length}개` };
  const cx = imgW / 2;
  const cy = imgH / 2;
  const first = corners[0];
  const last = corners[corners.length - 1];
  const L = Math.hypot(last.x - first.x, last.y - first.y);
  if (!(L > 1)) return { ok: null, issue: `${DEGRADE.TOO_FEW_BAYS}: 코너 퇴화(전방선 위 스팬 ${L.toFixed(2)}px)` };
  const ux = (last.x - first.x) / L;
  const uy = (last.y - first.y) / L;
  const s = corners.map((p) => (p.x - first.x) * ux + (p.y - first.y) * uy);
  const fit = fitProjective1D(s, index);
  if (!fit || Math.abs(fit.c) < 1e-12) return { ok: null, issue: `${DEGRADE.ROW_RESID}: 사영 1D 적합 실패` };
  let rowResidPx = 0;
  for (let i = 0; i < s.length; i++) rowResidPx = Math.max(rowResidPx, Math.abs(predictS(fit, index[i]) - s[i]));
  const sInf = fit.a / fit.c;
  const vpRow = { x: first.x + ux * sInf, y: first.y + uy * sInf };

  const focalPx = focalFromVPs([vpDepth.x, vpDepth.y, 1], [vpRow.x, vpRow.y, 1], cx, cy);
  if (focalPx == null) return { ok: null, issue: `${DEGRADE.VP_DEGENERATE}: VP 직교 구속으로 f 산출 불가` };
  if (!(focalPx > 0.3 * imgH) || !(focalPx < 5.0 * imgH)) {
    return { ok: null, issue: `${DEGRADE.VP_DEGENERATE}: f=${focalPx.toFixed(1)}px 가 [0.3,5.0]×imgH 밖 (PTZ zoom 폴백 금지)` };
  }

  // 지평선 h = VP_d × VP_r → 지면 하향 법선.
  const A: Vec3 = [vpDepth.x, vpDepth.y, 1];
  const B: Vec3 = [vpRow.x, vpRow.y, 1];
  const h: Vec3 = [A[1] * B[2] - A[2] * B[1], A[2] * B[0] - A[0] * B[2], A[0] * B[1] - A[1] * B[0]];
  const nRaw: Vec3 = [h[0] * focalPx, h[1] * focalPx, h[0] * cx + h[1] * cy + h[2]];
  const nn = Math.hypot(nRaw[0], nRaw[1], nRaw[2]);
  if (!(nn > 0)) return { ok: null, issue: `${DEGRADE.VP_DEGENERATE}: 지면 법선 퇴화` };
  const sign = nRaw[2] < 0 ? -1 : 1;
  const n: [number, number, number] = [(nRaw[0] / nn) * sign, (nRaw[1] / nn) * sign, (nRaw[2] / nn) * sign];

  // d=1 스케일 모델로 역투영 → 폭 측정 → metric d 확정.
  const unit = assembleModel(camIdx, presetIdx, imgW, imgH, zoom, focalPx, n, 1, []);
  const Xg: Vec3[] = [];
  for (const p of corners) {
    const X = backprojectToGround(p as Px, unit);
    if (!X) return { ok: null, issue: `${DEGRADE.VP_DEGENERATE}: 코너 역투영 실패(지평선 위)` };
    Xg.push(X);
  }
  const widths: number[] = [];
  for (let k = 0; k + 1 < Xg.length; k++) {
    const gap = index[k + 1] - index[k];
    if (!(gap > 0)) return { ok: null, issue: `${DEGRADE.ROW_RESID}: 격자 인덱스 비단조` };
    widths.push(Math.hypot(Xg[k + 1][0] - Xg[k][0], Xg[k + 1][1] - Xg[k][1], Xg[k + 1][2] - Xg[k][2]) / gap);
  }
  const wMed = median(widths);
  if (!(wMed > 0)) return { ok: null, issue: `${DEGRADE.VP_DEGENERATE}: 슬롯 폭 퇴화` };
  const widthSpreadPct = widths.length > 1 ? ((Math.max(...widths) - Math.min(...widths)) / wMed) * 100 : 0;
  const cameraHeightM = opts.slotWidthM / wMed;

  // 깊이 방향 = VP_d 시선(단위). 화면 위(원변)를 향하도록 부호 고정.
  const dl = Math.hypot((vpDepth.x - cx) / focalPx, (vpDepth.y - cy) / focalPx, 1);
  let D: Vec3 = [(vpDepth.x - cx) / focalPx / dl, (vpDepth.y - cy) / focalPx / dl, 1 / dl];
  const probe = projectToPixel([Xg[0][0] + D[0] * 0.01, Xg[0][1] + D[1] * 0.01, Xg[0][2] + D[2] * 0.01], unit);
  if (probe && probe.y > corners[0].y) D = [-D[0], -D[1], -D[2]];

  const depth = wMed * (opts.slotDepthM / opts.slotWidthM);
  const far: Px[] = [];
  for (const X of Xg) {
    const p = projectToPixel([X[0] + D[0] * depth, X[1] + D[1] * depth, X[2] + D[2] * depth], unit);
    if (!p) return { ok: null, issue: `${DEGRADE.VP_DEGENERATE}: 원변 코너 투영 실패` };
    far.push(p);
  }

  const quads: BayQuad[] = [];
  for (let k = 0; k + 1 < corners.length; k++) {
    if (index[k + 1] - index[k] !== 1) continue; // 결손 구간에는 quad 를 만들지 않는다(위장 금지).
    const q = canonicalizeQuad([corners[k], far[k], far[k + 1], corners[k + 1]]);
    if (!q) continue;
    quads.push({ latticeIndex: index[k], quad: q });
  }
  if (!quads.length) return { ok: null, issue: `${DEGRADE.TOO_FEW_BAYS}: 연속 격자 구간 0개` };

  return {
    ok: {
      vpRow,
      focalPx,
      normal: n,
      cameraHeightM,
      rowResidPx,
      widthSpreadPct,
      quads,
      model: assembleModel(camIdx, presetIdx, imgW, imgH, zoom, focalPx, n, cameraHeightM, []),
    },
  };
}

/** 전방선 후보 1개에 대한 분리선 묶음(floorPaint 가 만든다). */
export interface FrontHypothesis {
  front: RefinedLine;
  separators: RefinedLine[];
}

/** 가설 1건의 재투영 도색지지(P1). 값은 전 quad 평균 hitRatio(0~1). */
export interface PaintSupport {
  near: number;
  far: number;
  side: number;
  /** 근변 도색까지 거리의 median(px, 전 quad 평균). */
  nearChamferPx: number;
  /** 선택 점수 = near*nearW + side*sideW + far*farW. */
  score: number;
}

/**
 * ★ P1 — quad 를 **이미지로 되돌려** 4변이 도색을 덮는지 잰다.
 *
 * `canonicalizeQuad` 규약(p0=근좌, p1=원좌, p2=원우, p3=근우)에 따라 변의 역할이 정해진다:
 *   근변 = p0→p3 · 원변 = p1→p2 · 좌우(분리변) = p0→p1, p3→p2
 *
 * 이것이 빠져 있어서 격자를 통째로 5m 뒤/옆 행으로 옮긴 가설이 내부 일관성 구속을 전부 통과했다
 * (리더 루프1 진단 B — 2:2 는 참 근변선이 rank1·0.07px 인데 원변 도색선을 근변으로 골랐다).
 *
 * **수동 ROI 를 쓰지 않는다** — 입력은 도색 마스크의 거리변환뿐이다(R1 유지).
 */
export function quadPaintSupport(
  quads: readonly BayQuad[],
  ev: PaintEvidence,
  paintOpts: PaintOptions,
  opts: BayDetectOpts,
): PaintSupport {
  if (!quads.length) return { near: 0, far: 0, side: 0, nearChamferPx: Number.POSITIVE_INFINITY, score: 0 };
  let near = 0;
  let far = 0;
  let side = 0;
  let chamfer = 0;
  for (const q of quads) {
    const [p0, p1, p2, p3] = q.quad;
    const n: EdgeSupport = edgePaintSupport(ev, p0, p3, paintOpts);
    const f: EdgeSupport = edgePaintSupport(ev, p1, p2, paintOpts);
    const sA: EdgeSupport = edgePaintSupport(ev, p0, p1, paintOpts);
    const sB: EdgeSupport = edgePaintSupport(ev, p3, p2, paintOpts);
    near += n.hitRatio;
    far += f.hitRatio;
    side += (sA.hitRatio + sB.hitRatio) / 2;
    chamfer += n.chamferPx;
  }
  const k = quads.length;
  const res = { near: near / k, far: far / k, side: side / k, nearChamferPx: chamfer / k };
  return { ...res, score: res.near * opts.nearWeight + res.side * opts.sideWeight + res.far * opts.farWeight };
}

/**
 * Stage B 전체 — 전방선 후보 × 깊이 소실점 가설 × 격자 배정의 **결합 탐색**.
 *
 * 왜 결합인가(구현자 실측): 세 구속을 따로 쓰면 전부 통과하는 허위 해가 남는다.
 *   · 소실점 수렴만: 차체 모서리가 같은 3D 방향이라 함께 수렴한다.
 *   · 등간격만: 코너 4개는 3자유도 모형에 항상 맞는다(잔차 ≈ 0).
 *   둘을 **동시에** 요구하고 f 범위·폭편차·지상고 게이트까지 걸어야 후보가 줄어든다.
 *
 * 수동 ROI 를 인자로 받지 않는다(R1).
 */
export function detectBays(
  hypotheses: readonly FrontHypothesis[],
  evidence: PaintEvidence,
  paintOpts: PaintOptions,
  camIdx: number,
  presetIdx: number,
  imgW: number,
  imgH: number,
  zoom: number,
  opts: BayDetectOpts,
): BayDetection {
  const empty: BayDetection = {
    frontLine: null,
    separators: [],
    cornersPx: [],
    latticeIndex: [],
    vpDepth: null,
    vpRow: null,
    focalPx: null,
    normal: null,
    cameraHeightM: null,
    quads: [],
    diag: {
      lines: 0,
      frontCandidates: hypotheses.length,
      hypotheses: 0,
      rowResidPx: null,
      latticeResidPx: null,
      widthSpreadPct: null,
      heightDevPct: null,
      paint: null,
      rejectedByPaint: 0,
      gate: { noLattice: 0, buildFail: 0, widthSpread: 0, heightDev: 0, paint: 0 },
      buildIssues: {},
    },
    issues: [],
  };
  if (!hypotheses.length) return { ...empty, issues: [`${DEGRADE.NO_FRONT_LINE}: 전방선 후보 0개`] };

  interface Cand {
    front: RefinedLine;
    vpDepth: { x: number; y: number };
    corners: Array<{ x: number; y: number }>;
    index: number[];
    seps: RefinedLine[];
    latticeResid: number;
    build: BuildResult;
    heightDevPct: number;
    paint: PaintSupport;
  }
  const cands: Cand[] = [];
  let tried = 0;
  let rejectedByPaint = 0;
  const gate = { noLattice: 0, buildFail: 0, widthSpread: 0, heightDev: 0, paint: 0 };
  const buildIssues: Record<string, number> = {};
  /** 근변 지지 게이트에서 떨어진 가설 중 최고 점수 — 전부 탈락했을 때 사유를 수치로 남긴다. */
  let bestRejected: PaintSupport | null = null;

  for (const hyp of hypotheses) {
    const { front } = hyp;
    const ux = -front.line[1];
    const uy = front.line[0];
    const orgx = -front.line[2] * front.line[0];
    const orgy = -front.line[2] * front.line[1];
    const crossings: Array<{ sep: RefinedLine; p: { x: number; y: number }; s: number }> = [];
    for (const sep of hyp.separators) {
      const p = meet2(sep.line, front.line);
      if (!p) continue;
      crossings.push({ sep, p, s: (p.x - orgx) * ux + (p.y - orgy) * uy });
    }
    if (crossings.length < opts.minPicks) continue;
    crossings.sort((a, b) => a.s - b.s || a.p.x - b.p.x);

    const seen = new Set<string>();
    for (let i = 0; i < crossings.length; i++) {
      for (let j = i + 1; j < crossings.length; j++) {
        const seed = meet2(crossings[i].sep.line, crossings[j].sep.line);
        if (!seed || Math.abs(seed.x) > 1e6 || Math.abs(seed.y) > 1e6) continue;
        let sup = crossings.filter((c) => vpResidPx(seed, c.sep.endA, c.sep.endB) < opts.vpTolPx);
        if (sup.length < opts.minPicks) continue;
        // 지지 집합으로 소실점 재추정 → 재선별 1회(결정론적 1스텝, 난수 0).
        const refined = meetLinesLS(sup.map((c) => c.sep.line));
        const V = refined ?? seed;
        if (refined) sup = crossings.filter((c) => vpResidPx(V, c.sep.endA, c.sep.endB) < opts.vpTolPx);
        if (sup.length < opts.minPicks) continue;
        const sig = sup.map((c) => c.s.toFixed(0)).join(',');
        if (seen.has(sig)) continue;
        seen.add(sig);
        const merged: typeof sup = [];
        for (const c of sup) {
          const prev = merged[merged.length - 1];
          if (prev && c.s - prev.s < opts.cornerMergePx) {
            if (c.sep.spanPx > prev.sep.spanPx) merged[merged.length - 1] = c;
            continue;
          }
          merged.push(c);
        }
        if (merged.length < opts.minPicks) continue;
        tried++;
        const lat = bestLattice(merged.map((c) => c.s), opts);
        if (!lat) {
          gate.noLattice++;
          continue;
        }
        const corners = lat.picks.map((p) => merged[p.at].p);
        const index = lat.picks.map((p) => p.index);
        const built = buildFromCorners(corners, index, V, camIdx, presetIdx, imgW, imgH, zoom, opts);
        if (!built.ok) {
          gate.buildFail++;
          const code = built.issue.replace(/[\d.]+/g, '#');
          buildIssues[code] = (buildIssues[code] ?? 0) + 1;
          continue;
        }
        const b = built.ok;
        if (b.widthSpreadPct > opts.maxWidthSpreadPct) {
          gate.widthSpread++;
          continue;
        }
        const heightDevPct =
          opts.cameraHeightM != null && opts.cameraHeightM > 0
            ? (Math.abs(b.cameraHeightM - opts.cameraHeightM) / opts.cameraHeightM) * 100
            : 0;
        if (opts.cameraHeightM != null && heightDevPct > opts.maxHeightDevPct) {
          gate.heightDev++;
          continue;
        }
        // ★ P1 게이트 — 산출 quad 의 근변이 실제 도색 위에 있는가.
        const paint = quadPaintSupport(b.quads, evidence, paintOpts, opts);
        if (paint.near < opts.minNearSupport) {
          rejectedByPaint++;
          gate.paint++;
          if (!bestRejected || paint.score > bestRejected.score) bestRejected = paint;
          continue;
        }
        cands.push({
          front,
          vpDepth: V,
          corners,
          index,
          seps: merged.map((c) => c.sep),
          latticeResid: lat.residPx,
          build: b,
          heightDevPct,
          paint,
        });
      }
    }
  }

  if (!cands.length) {
    const why =
      rejectedByPaint > 0
        ? `${DEGRADE.NO_PAINT_SUPPORT}: 기하 게이트는 ${rejectedByPaint}건 통과했으나 전부 근변 도색지지 < ${opts.minNearSupport} ` +
          `(최고 near=${bestRejected ? bestRejected.near.toFixed(3) : '--'} far=${bestRejected ? bestRejected.far.toFixed(3) : '--'} ` +
          `side=${bestRejected ? bestRejected.side.toFixed(3) : '--'}) — 격자가 도색 위에 있지 않다`
        : `${DEGRADE.FEW_SEPARATORS}: 소실점 수렴 + 사영등간격 + f/폭/지상고 게이트를 모두 통과한 가설 0개(시도 ${tried}건)`;
    return { ...empty, diag: { ...empty.diag, hypotheses: tried, rejectedByPaint, gate, buildIssues }, issues: [why] };
  }
  // ★ 선택 1순위 = **재투영 도색지지 점수 desc**(P1). 2순위 코너 수 desc, 3순위 격자 잔차 asc,
  //   4순위 지상고 편차 asc. 동점은 순회 순서(먼저 담긴 쪽) 유지 — 난수 0.
  //
  // 왜 도색지지가 1순위여야 하는가: 나머지 구속(소실점 수렴·등간격·f범위·폭편차·지상고)은 전부
  // 격자의 **내부** 일관성이다. 격자를 통째로 옮겨도 전부 그대로 만족되므로 위치를 고정하지 못한다.
  // 도색지지만이 "그 격자가 **이 이미지의 이 자리**에 있는가"를 묻는 외부 증거다.
  //
  // ★ 반증된 대안(구현자가 1회차에 시도하고 되돌림): 지상고 편차를 1순위로 올리기.
  //   전 프리셋 지상고가 설정값 4% 이내로 맞았지만 IoU 는 붕괴했다(1:1 0.6004 → 0.0049).
  //   지상고 일치는 필요조건일 뿐 충분조건이 아니다 — 틀렸지만 자기일관된 기하도 지상고를 맞춘다.
  cands.sort(
    (a, b) =>
      b.paint.score - a.paint.score ||
      b.corners.length - a.corners.length ||
      a.latticeResid - b.latticeResid ||
      a.heightDevPct - b.heightDevPct,
  );
  const win = cands[0];
  const issues: string[] = [];
  // ★ 격자 확장 — 선별은 보수적으로, 생성은 N칸까지. 확장 칸은 도색지지로 개별 검증한다.
  const ext = extendLattice(win.corners, win.index, opts);
  if (ext) {
    const rebuilt = buildFromCorners(ext.corners, ext.index, win.vpDepth, camIdx, presetIdx, imgW, imgH, zoom, opts);
    if (rebuilt.ok) {
      const kept: BayQuad[] = [];
      for (const q of rebuilt.ok.quads) {
        const sup = quadPaintSupport([q], evidence, paintOpts, opts);
        if (sup.near >= opts.extendMinNearSupport) kept.push(q);
      }
      if (kept.length > win.build.quads.length) {
        issues.push(`격자 확장: quad ${win.build.quads.length} → ${kept.length}개(확장분은 근변 도색지지 ≥${opts.extendMinNearSupport} 로 개별 검증)`);
        win.corners = ext.corners;
        win.index = ext.index;
        win.build = { ...rebuilt.ok, quads: kept };
        win.paint = quadPaintSupport(kept, evidence, paintOpts, opts);
      }
    }
  }
  if (win.build.rowResidPx > opts.maxRowResidPx) {
    issues.push(`${DEGRADE.ROW_RESID}: 등간격 잔차 ${win.build.rowResidPx.toFixed(2)}px > ${opts.maxRowResidPx}px`);
  }
  if (win.build.widthSpreadPct > 5) issues.push(`${DEGRADE.WIDTH_SPREAD}: 근변 폭 편차 ${win.build.widthSpreadPct.toFixed(1)}%`);
  if (opts.cameraHeightM != null && win.heightDevPct > 5) {
    issues.push(`${DEGRADE.HEIGHT_DEV}: 이미지추정 지상고 ${win.build.cameraHeightM.toFixed(3)}m 가 설정 ${opts.cameraHeightM}m 대비 ${win.heightDevPct.toFixed(1)}% 이탈`);
  }
  if (win.build.quads.length < opts.expectedBays) {
    issues.push(`베이 ${opts.expectedBays}개 중 ${win.build.quads.length}개만 산출(결손 격자 구간은 quad 를 만들지 않는다)`);
  }
  return {
    frontLine: win.front.line,
    separators: win.seps.map((sp) => sp.line),
    cornersPx: win.corners,
    latticeIndex: win.index,
    vpDepth: win.vpDepth,
    vpRow: win.build.vpRow,
    focalPx: win.build.focalPx,
    normal: win.build.normal,
    cameraHeightM: win.build.cameraHeightM,
    quads: win.build.quads,
    diag: {
      lines: 0,
      frontCandidates: hypotheses.length,
      hypotheses: tried,
      rowResidPx: win.build.rowResidPx,
      latticeResidPx: win.latticeResid,
      widthSpreadPct: win.build.widthSpreadPct,
      heightDevPct: opts.cameraHeightM != null ? win.heightDevPct : null,
      paint: win.paint,
      rejectedByPaint,
      gate,
      buildIssues,
    },
    issues,
  };
}

/**
 * ★ 격자 확장 — 선별된 격자를 사영 1D 모형으로 좌우로 늘려 **베이 N칸까지 채운다**.
 *
 * 왜 필요한가(구현자 실측): 도색지지 게이트(P1)가 정밀도를 올리면서 **재현율을 떨어뜨렸다** —
 * 코너 4개만 살아남아 quad 가 2개뿐이고, 나머지 5면은 대응 quad 가 없어 IoU 0 이 된다
 * (1:1 베이 7개 중 quad 2개, 2:1 6개 중 2개). 선별과 생성이 한 덩어리였던 것이 원인이다.
 *
 * 선별은 보수적으로 두되, **확정된 격자에서 칸을 외삽**하고 각 칸을 도색지지로 개별 검증한다.
 * 격자 파라미터(사영 1D)는 이미 선별 단계에서 얻었으므로 새 추정이 없다 — 외삽만 한다.
 * 확장 칸이 도색지지 하한에 못 미치면 **버린다**(억지로 채우지 않는다).
 */
function extendLattice(
  corners: ReadonlyArray<{ x: number; y: number }>,
  index: readonly number[],
  opts: BayDetectOpts,
): { corners: Array<{ x: number; y: number }>; index: number[] } | null {
  if (corners.length < 3) return null;
  const first = corners[0];
  const last = corners[corners.length - 1];
  const L = Math.hypot(last.x - first.x, last.y - first.y);
  if (!(L > 1)) return null;
  const ux = (last.x - first.x) / L;
  const uy = (last.y - first.y) / L;
  const s = corners.map((p) => (p.x - first.x) * ux + (p.y - first.y) * uy);
  const fit = fitProjective1D(s, index);
  if (!fit) return null;
  const lo = Math.min(...index);
  const hi = Math.max(...index);
  // 베이 N 칸을 덮는 데 필요한 인덱스 범위(양쪽으로 균등 확장). 이미 넓으면 그대로.
  const need = opts.expectedBays;
  const span = hi - lo;
  const grow = Math.max(0, need - span);
  const from = lo - Math.ceil(grow / 2);
  const to = hi + Math.floor(grow / 2);
  const out: Array<{ x: number; y: number }> = [];
  const idx: number[] = [];
  for (let t = from; t <= to; t++) {
    const known = index.indexOf(t);
    if (known >= 0) {
      out.push(corners[known]);
      idx.push(t);
      continue;
    }
    const st = predictS(fit, t);
    if (!Number.isFinite(st)) return null;
    // 사영 극점(지평선) 근처는 외삽이 발산한다 — 기존 스팬의 몇 배를 넘으면 중단.
    if (Math.abs(st) > Math.abs(s[0]) + L * opts.maxExtendSpanFactor) continue;
    out.push({ x: first.x + ux * st, y: first.y + uy * st });
    idx.push(t);
  }
  return out.length > corners.length ? { corners: out, index: idx } : null;
}

// ── P2. 평행 도색선 **쌍** 탐색 ────────────────────────────────────
/** 근변선·원변선 쌍 가설 1건. 양쪽 선 각각에서 방향탐색으로 얻은 분리선 후보를 함께 넘긴다. */
export interface PairHypothesis {
  near: RefinedLine;
  far: RefinedLine;
  nearSeps: RefinedLine[];
  farSeps: RefinedLine[];
}

/** 직선 위 교점 + 파라미터. */
function crossingsOn(front: RefinedLine, seps: readonly RefinedLine[]): Array<{ sep: RefinedLine; p: { x: number; y: number }; s: number }> {
  const ux = -front.line[1];
  const uy = front.line[0];
  const ox = -front.line[2] * front.line[0];
  const oy = -front.line[2] * front.line[1];
  const out: Array<{ sep: RefinedLine; p: { x: number; y: number }; s: number }> = [];
  for (const sep of seps) {
    const p = meet2(sep.line, front.line);
    if (!p) continue;
    out.push({ sep, p, s: (p.x - ox) * ux + (p.y - oy) * uy });
  }
  out.sort((a, b) => a.s - b.s || a.p.x - b.p.x);
  return out;
}

/** 근접 교점 병합(같은 도색선의 이중 검출). */
function mergeCrossings<T extends { s: number; sep: RefinedLine }>(rows: readonly T[], mergePx: number): T[] {
  const out: T[] = [];
  for (const c of rows) {
    const prev = out[out.length - 1];
    if (prev && c.s - prev.s < mergePx) {
      if (c.sep.spanPx > prev.sep.spanPx) out[out.length - 1] = c;
      continue;
    }
    out.push(c);
  }
  return out;
}

/**
 * ★ P2 — 근변·원변을 **둘 다 이미지에서 검출**해 그 사이 현(chord)으로 깊이 소실점을 얻는다.
 *
 * 왜 필요한가(구현자 실측, 2:2): 차량이 슬롯을 채우고 있어 분리선의 **보이는 스텁이 13~35px 뿐**이다.
 * 그 길이로는 방향이 ±2° 수준으로만 정해져 소실점이 서지 않는다 — 참 전방선(오차 0.9px)을 줘도
 * 가설 97건 중 **79건이 `focalFromVPs` 직교 구속에서 죽었다**(부호 실패). 반면 근변 코너와 원변 코너를
 * 잇는 현은 **645px** 다. 같은 각도 잡음에서 방향 정밀도가 20배 이상 좋아진다.
 *
 * 부수 효과가 더 크다: 원변 코너를 **외삽하지 않고 측정**하므로 quad 4점이 전부 이미지 증거가 된다.
 * (기존 단일선 경로는 원변을 `깊이=폭×2` 비율로 외삽했다 — 그 비율이 틀리면 quad 전체가 틀어진다.)
 *
 * 실치수비 검사: 재구성한 깊이/폭 이 `slotDepthM/slotWidthM` 와 맞는지 게이트로 확인한다.
 * 이것이 "이 두 선이 **한 슬롯의 앞뒤**인가, 아니면 다른 행의 선인가"를 기하로 끊는다.
 *
 * 수동 ROI 를 인자로 받지 않는다(R1).
 */
export function detectBaysPaired(
  pairs: readonly PairHypothesis[],
  evidence: PaintEvidence,
  paintOpts: PaintOptions,
  camIdx: number,
  presetIdx: number,
  imgW: number,
  imgH: number,
  zoom: number,
  opts: BayDetectOpts,
): BayDetection {
  const empty: BayDetection = {
    frontLine: null,
    separators: [],
    cornersPx: [],
    latticeIndex: [],
    vpDepth: null,
    vpRow: null,
    focalPx: null,
    normal: null,
    cameraHeightM: null,
    quads: [],
    diag: {
      lines: 0,
      frontCandidates: pairs.length,
      hypotheses: 0,
      rowResidPx: null,
      latticeResidPx: null,
      widthSpreadPct: null,
      heightDevPct: null,
      paint: null,
      rejectedByPaint: 0,
      gate: { noLattice: 0, buildFail: 0, widthSpread: 0, heightDev: 0, paint: 0 },
      buildIssues: {},
    },
    issues: [],
  };

  interface PairCand {
    pair: PairHypothesis;
    corners: Array<{ x: number; y: number }>;
    farCorners: Array<{ x: number; y: number }>;
    index: number[];
    seps: Array<[number, number, number]>;
    vpDepth: { x: number; y: number };
    vpRow: { x: number; y: number };
    focalPx: number;
    normal: [number, number, number];
    cameraHeightM: number;
    depthRatio: number;
    latticeResid: number;
    quads: BayQuad[];
    paint: PaintSupport;
  }
  const cands: PairCand[] = [];
  const gate = { noLattice: 0, buildFail: 0, widthSpread: 0, heightDev: 0, paint: 0 };
  const buildIssues: Record<string, number> = {};
  let tried = 0;
  const cx = imgW / 2;
  const cy = imgH / 2;

  for (const pair of pairs) {
    const vpRow = meet2(pair.near.line, pair.far.line);
    if (!vpRow || !Number.isFinite(vpRow.x) || !Number.isFinite(vpRow.y)) continue;
    const nRows = mergeCrossings(crossingsOn(pair.near, pair.nearSeps), opts.cornerMergePx);
    const fRows = mergeCrossings(crossingsOn(pair.far, pair.farSeps), opts.cornerMergePx);
    if (nRows.length < opts.minPicks || fRows.length < 2) continue;
    const nLat = bestLattice(nRows.map((c) => c.s), opts);
    if (!nLat) {
      gate.noLattice++;
      continue;
    }
    const fLat = bestLattice(fRows.map((c) => c.s), { ...opts, minPicks: 2 });
    if (!fLat) {
      gate.noLattice++;
      continue;
    }
    const C = nLat.picks.map((p) => nRows[p.at].p);
    const cIdx = nLat.picks.map((p) => p.index);
    const F = fLat.picks.map((p) => fRows[p.at].p);
    const fIdx = fLat.picks.map((p) => p.index);

    // 근변·원변 격자의 인덱스 원점이 다를 수 있다 → 오프셋 전수 순회(고정 순서, 난수 0).
    for (let off = -opts.maxGap - 1; off <= opts.maxGap + 1; off++) {
      tried++;
      const pairedC: Array<{ x: number; y: number }> = [];
      const pairedF: Array<{ x: number; y: number }> = [];
      const pairedIdx: number[] = [];
      for (let k = 0; k < C.length; k++) {
        const j = fIdx.indexOf(cIdx[k] + off);
        if (j < 0) continue;
        pairedC.push(C[k]);
        pairedF.push(F[j]);
        pairedIdx.push(cIdx[k]);
      }
      // 근변 4개를 요구하면 원변이 3개만 보이는 프리셋에서 쌍 경로가 통째로 죽는다(구현자 실측: 2:2 전 쌍 탈락).
      // 현 소실점은 3개면 잔차 검사가 성립한다(2개는 항상 정확히 만나 검증력이 0).
      if (pairedC.length < 3) {
        buildIssues[`쌍 부족(matched=${pairedC.length})`] = (buildIssues[`쌍 부족(matched=${pairedC.length})`] ?? 0) + 1;
        continue;
      }
      // ★ 현(chord) = 근변코너 → 원변코너. 스텁이 아니라 슬롯 깊이 전체를 가로지른다.
      const chords: Array<[number, number, number]> = [];
      let chordOk = true;
      for (let k = 0; k < pairedC.length; k++) {
        const l = lineThrough(pairedC[k], pairedF[k]);
        if (!l) {
          chordOk = false;
          break;
        }
        chords.push(l);
      }
      if (!chordOk) continue;
      const vpDepth = meetLinesLS(chords);
      if (!vpDepth || !Number.isFinite(vpDepth.x) || !Number.isFinite(vpDepth.y)) {
        buildIssues['현 소실점 퇴화'] = (buildIssues['현 소실점 퇴화'] ?? 0) + 1;
        continue;
      }
      let chordResid = 0;
      for (let k = 0; k < pairedC.length; k++) chordResid = Math.max(chordResid, vpResidPx(vpDepth, pairedC[k], pairedF[k]));
      if (chordResid > opts.chordResidPx) {
        buildIssues[`현 수렴 잔차 초과`] = (buildIssues['현 수렴 잔차 초과'] ?? 0) + 1;
        continue;
      }

      const focalPx = focalFromVPs([vpDepth.x, vpDepth.y, 1], [vpRow.x, vpRow.y, 1], cx, cy);
      if (focalPx == null || !(focalPx > 0.3 * imgH) || !(focalPx < 5.0 * imgH)) {
        gate.buildFail++;
        buildIssues[`${DEGRADE.VP_DEGENERATE}: f`] = (buildIssues[`${DEGRADE.VP_DEGENERATE}: f`] ?? 0) + 1;
        continue;
      }
      const A: Vec3 = [vpDepth.x, vpDepth.y, 1];
      const B: Vec3 = [vpRow.x, vpRow.y, 1];
      const h: Vec3 = [A[1] * B[2] - A[2] * B[1], A[2] * B[0] - A[0] * B[2], A[0] * B[1] - A[1] * B[0]];
      const nRaw: Vec3 = [h[0] * focalPx, h[1] * focalPx, h[0] * cx + h[1] * cy + h[2]];
      const nn = Math.hypot(nRaw[0], nRaw[1], nRaw[2]);
      if (!(nn > 0)) continue;
      const sg = nRaw[2] < 0 ? -1 : 1;
      const normal: [number, number, number] = [(nRaw[0] / nn) * sg, (nRaw[1] / nn) * sg, (nRaw[2] / nn) * sg];
      const unit = assembleModel(camIdx, presetIdx, imgW, imgH, zoom, focalPx, normal, 1, []);
      const Xc: Vec3[] = [];
      const Xf: Vec3[] = [];
      let bpOk = true;
      for (let k = 0; k < pairedC.length; k++) {
        const a = backprojectToGround(pairedC[k] as Px, unit);
        const b = backprojectToGround(pairedF[k] as Px, unit);
        if (!a || !b) {
          bpOk = false;
          break;
        }
        Xc.push(a);
        Xf.push(b);
      }
      if (!bpOk) {
        gate.buildFail++;
        buildIssues[`${DEGRADE.VP_DEGENERATE}: 역투영`] = (buildIssues[`${DEGRADE.VP_DEGENERATE}: 역투영`] ?? 0) + 1;
        continue;
      }
      const widths: number[] = [];
      for (let k = 0; k + 1 < Xc.length; k++) {
        const gap = pairedIdx[k + 1] - pairedIdx[k];
        if (!(gap > 0)) continue;
        widths.push(Math.hypot(Xc[k + 1][0] - Xc[k][0], Xc[k + 1][1] - Xc[k][1], Xc[k + 1][2] - Xc[k][2]) / gap);
      }
      if (!widths.length) continue;
      const depths = Xc.map((X, k) => Math.hypot(Xf[k][0] - X[0], Xf[k][1] - X[1], Xf[k][2] - X[2]));
      const wMed = median(widths);
      const dMed = median(depths);
      if (!(wMed > 0) || !(dMed > 0)) continue;
      const widthSpreadPct = widths.length > 1 ? ((Math.max(...widths) - Math.min(...widths)) / wMed) * 100 : 0;
      if (widthSpreadPct > opts.maxWidthSpreadPct) {
        gate.widthSpread++;
        continue;
      }
      // ★ 실치수비 게이트 — 이 두 선이 한 슬롯의 앞뒤인가(5.0m : 2.5m)를 기하로 끊는다.
      const depthRatio = dMed / wMed;
      const want = opts.slotDepthM / opts.slotWidthM;
      if (Math.abs(depthRatio - want) / want > opts.depthRatioTol) {
        gate.buildFail++;
        buildIssues[`실치수비 불일치(깊이/폭)`] = (buildIssues['실치수비 불일치(깊이/폭)'] ?? 0) + 1;
        continue;
      }
      const cameraHeightM = opts.slotWidthM / wMed;
      const heightDevPct =
        opts.cameraHeightM != null && opts.cameraHeightM > 0
          ? (Math.abs(cameraHeightM - opts.cameraHeightM) / opts.cameraHeightM) * 100
          : 0;
      if (opts.cameraHeightM != null && heightDevPct > opts.maxHeightDevPct) {
        gate.heightDev++;
        continue;
      }
      // quad — 4점 전부 **측정값**이다(원변 외삽 없음).
      const quads: BayQuad[] = [];
      for (let k = 0; k + 1 < pairedC.length; k++) {
        if (pairedIdx[k + 1] - pairedIdx[k] !== 1) continue;
        const q = canonicalizeQuad([pairedC[k], pairedF[k], pairedF[k + 1], pairedC[k + 1]]);
        if (q) quads.push({ latticeIndex: pairedIdx[k], quad: q });
      }
      if (!quads.length) continue;
      const paint = quadPaintSupport(quads, evidence, paintOpts, opts);
      if (paint.near < opts.minNearSupport) {
        gate.paint++;
        continue;
      }
      cands.push({
        pair,
        corners: pairedC,
        farCorners: pairedF,
        index: pairedIdx,
        seps: chords,
        vpDepth,
        vpRow,
        focalPx,
        normal,
        cameraHeightM,
        depthRatio,
        latticeResid: nLat.residPx,
        quads,
        paint,
      });
    }
  }

  if (!cands.length) {
    return {
      ...empty,
      diag: { ...empty.diag, hypotheses: tried, gate, buildIssues, rejectedByPaint: gate.paint },
      issues: [`${DEGRADE.NO_PAINT_SUPPORT}: 평행 도색선 쌍 가설 ${tried}건 중 통과 0건`],
    };
  }
  cands.sort(
    (a, b) =>
      b.paint.score - a.paint.score ||
      b.corners.length - a.corners.length ||
      a.latticeResid - b.latticeResid ||
      Math.abs(a.depthRatio - opts.slotDepthM / opts.slotWidthM) - Math.abs(b.depthRatio - opts.slotDepthM / opts.slotWidthM),
  );
  const win = cands[0];
  const issues: string[] = [];
  if (win.quads.length < opts.expectedBays) {
    issues.push(`베이 ${opts.expectedBays}개 중 ${win.quads.length}개만 산출(결손 격자 구간은 quad 를 만들지 않는다)`);
  }
  return {
    frontLine: win.pair.near.line,
    separators: win.seps,
    cornersPx: win.corners,
    latticeIndex: win.index,
    vpDepth: win.vpDepth,
    vpRow: win.vpRow,
    focalPx: win.focalPx,
    normal: win.normal,
    cameraHeightM: win.cameraHeightM,
    quads: win.quads,
    diag: {
      lines: 0,
      frontCandidates: pairs.length,
      hypotheses: tried,
      rowResidPx: null,
      latticeResidPx: win.latticeResid,
      widthSpreadPct: null,
      heightDevPct: opts.cameraHeightM != null ? (Math.abs(win.cameraHeightM - opts.cameraHeightM) / opts.cameraHeightM) * 100 : null,
      paint: win.paint,
      rejectedByPaint: gate.paint,
      gate,
      buildIssues,
    },
    issues,
  };
}

/** 자동 quad 를 이미지 정규화 좌표(0..1)로. 정본 기입 단위와 같다. */
export function quadToNormalized(q: PixelQuad, imgW: number, imgH: number): Array<{ x: number; y: number }> {
  return q.map((p) => ({ x: p.x / imgW, y: p.y / imgH }));
}

/** 근변 코너 후보를 만든 전방선/분리선 조합을 진단 문자열로. */
export function describeLine(l: Line2): string {
  const th = ((Math.atan2(l[1], l[0]) * 180) / Math.PI + 180) % 180;
  return `θ=${th.toFixed(2)}° ρ=${(-l[2]).toFixed(2)}`;
}

export { lineThrough };
