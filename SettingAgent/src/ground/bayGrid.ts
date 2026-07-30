// 지면모델 주입형 베이 격자(순수 · IO 0 · 수동 ROI 무참조).
//
// ★ 3회차 경로(리더 루프2 §3-P2). 지면모델 (f, n, d) 가 **주어지면** 이미지가 공급할 것은 3 자유도뿐이다:
//     ① 행 방향  ← 검출된 근변 도색선(이미 rank 0~1 · 서브픽셀)을 지면으로 역투영
//     ② 격자 위상 ← 검출된 근변 코너(이미 참값 대비 0.1~15px)
//     ③ 나머지   ← 폭 2.5m · 깊이 5.0m 는 **상수**
//
// **소실점을 구하지 않는다.** 2회차 실패의 단일 지배 원인은 24px 스텁에서 소실점을 뽑으려 한 것이었고
// (각도 불확실도 ±2.4° → 소실점 수천 px 이탈 → f 3.5~6배 오차), 이 경로에는 그 항이 **없다**.
//
// 격자 간격이 상수이므로 적합해야 할 파라미터가 위상 1개뿐이다 — 잔차 적합도, 이면군 탐색도 없다.
// 선택은 전적으로 **재투영 도색지지**(P1)가 한다.

import { backprojectToGround, cross3, dot3, projectToPixel, unit3 } from './project.js';
import { groundModelFromIntrinsics } from './cameraIntrinsics.js';
import { canonicalizeQuad } from './groundGrid.js';
// ★ 18회차 B — 행 중복 제거용. **신규 IoU 구현 0줄**(R4): 기존 `quadIoU` 를 그대로 재사용한다.
import { quadIoU } from './autoRoiPlan.js';
import { quadPaintSupport, type BayDetectOpts, type BayQuad, type PaintSupport } from './bayGeometry.js';
import { imageSpanOf, refineLineRobust, type FrameGray, type PaintEvidence, type PaintOptions, type RefinedLine } from './floorPaint.js';
import type { Px, Vec3 } from './contactTypes.js';
import type { GroundModel } from './types.js';

/** 지면 위 행 좌표계 — 원점 + 폭축 u + 깊이축 v(카메라에서 멀어지는 쪽). */
export interface RowFrame {
  origin: Vec3;
  u: Vec3;
  v: Vec3;
}

/**
 * 검출된 근변선 → 지면 위 행 좌표계.
 * 직선 방정식이 정확하면 그 위 어느 두 점을 써도 같은 지면 직선이 나오므로,
 * **이미지 전 구간 끝점**(가장 긴 기저선)을 쓴다.
 */
export function rowFrameFromLine(model: GroundModel, line: readonly [number, number, number]): RowFrame | null {
  const sp = imageSpanOf(line, model.imgW, model.imgH);
  if (!sp) return null;
  const A = backprojectToGround({ x: sp.px0 + sp.dx * sp.tmin, y: sp.py0 + sp.dy * sp.tmin }, model);
  const B = backprojectToGround({ x: sp.px0 + sp.dx * sp.tmax, y: sp.py0 + sp.dy * sp.tmax }, model);
  if (!A || !B) return null;
  const u = unit3([B[0] - A[0], B[1] - A[1], B[2] - A[2]]);
  if (!u) return null;
  const v0 = unit3(cross3(model.n as Vec3, u));
  if (!v0) return null;
  // 깊이축 부호: 카메라에서 **멀어지는** 쪽(화면 위쪽 = y 감소).
  const here = projectToPixel(A, model);
  const there = projectToPixel([A[0] + v0[0] * 0.5, A[1] + v0[1] * 0.5, A[2] + v0[2] * 0.5], model);
  const v: Vec3 = here && there && there.y > here.y ? [-v0[0], -v0[1], -v0[2]] : v0;
  return { origin: A, u, v };
}

/** median(빈 배열 → NaN). */
function median(xs: readonly number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

/** 지면 2D (a=폭방향, b=깊이방향) → 카메라좌표 3D. */
const pointAt = (fr: RowFrame, a: number, b: number): Vec3 => [
  fr.origin[0] + fr.u[0] * a + fr.v[0] * b,
  fr.origin[1] + fr.u[1] * a + fr.v[1] * b,
  fr.origin[2] + fr.u[2] * a + fr.v[2] * b,
];


/**
 * ★ 설치고 자가보정 — 관측된 베이 폭이 **규격 폭**과 맞도록 지상고를 되돌린다(4회차 U2).
 *
 * 근거(리더 유니티 직접 조회): 참 주차면 치수는 정확히 `xSize=2.5, zSize=5.0` 이다.
 * 그런데 `camera.position[1]=5.0` 으로 세운 모델로 역투영하면 폭이 **2.525m(+1.0%)** 로 나온다.
 * 즉 오차는 주차면이 아니라 **카메라 모델의 지상고**에 있다(참값 5.0/1.01 = 4.950m — 설계자가
 * 이미지 증거만으로 독립 추정한 값과 정확히 일치). `position[1]` 은 카메라 **오브젝트** 좌표이고
 * 광학중심·지면 y=0 가정이 5cm 어긋나 있다.
 *
 * 지상고 d 는 역투영 `X = d·m/(n·m)` 에서 모든 지면 거리에 **선형**으로 들어간다.
 * 따라서 `d_corrected = d_nominal × (규격폭 / 관측폭)` 한 번이면 스케일이 맞는다.
 *
 * **하드코딩이 아니라 관측 기반 보정이며 주차면 정답지를 쓰지 않는다.** 규격 폭은 시설 사양(도면·주차장 규격)이고
 * 실카에도 그대로 전이된다 — 설치고는 줄자 실측이라 어차피 오차가 있고, 주차면 폭은 규격이 정해져 있다.
 */
export interface HeightCalibration {
  /** 보정 전 지상고(m). */
  nominalM: number;
  /** 보정 후 지상고(m). */
  correctedM: number;
  /** 관측된 베이 폭(m, 보정 전 모델 기준). */
  measuredWidthM: number;
  /** 보정 계수 = 규격폭 / 관측폭. */
  factor: number;
  /** 보정 표본(인접 코너 간격) 수. */
  samples: number;
}

/**
 * ★ 격자가 정해진 **뒤에** 실제 칸 간격을 최소제곱으로 잰다.
 *
 * 순환을 피하는 것이 요점이다: 코너 간격만 보고 "2.5m 근처 값"을 median 하면 필터 창의 중앙이
 * 그대로 답으로 나온다(자기충족 측정). 대신 **격자가 배정한 정수 인덱스** `k` 를 고정하고
 * `a_i ≈ phase + k_i·s` 에서 `s` 만 자유 파라미터로 적합한다 — 배정은 도색지지가 정한 격자에서 오고,
 * 간격은 관측이 정한다.
 */
function estimateCellPitch(
  evid: readonly number[],
  phase: number,
  slotWidthM: number,
  tolRatio: number,
): { pitchM: number; samples: number } | null {
  let sk = 0;
  let skk = 0;
  let n = 0;
  for (const a of evid) {
    const k = Math.round((a - phase) / slotWidthM);
    if (k === 0) continue; // k=0 은 s 에 대한 정보가 없다(phase 자체).
    if (Math.abs(a - (phase + k * slotWidthM)) > slotWidthM * tolRatio) continue;
    sk += k * (a - phase);
    skk += k * k;
    n++;
  }
  if (n < 2 || !(skk > 0)) return null;
  const pitch = sk / skk;
  return Number.isFinite(pitch) && pitch > 0 ? { pitchM: pitch, samples: n } : null;
}

/** 격자 결과 → 지상고 보정. 계수가 허용 범위를 벗어나면 null(보정하지 않는다). */
export function calibrationFromGrid(
  evid: readonly number[],
  phase: number,
  model: GroundModel,
  opts: BayDetectOpts,
): HeightCalibration | null {
  if (!opts.calibrateHeight) return null;
  const p = estimateCellPitch(evid, phase, opts.slotWidthM, 0.25);
  if (!p) return null;
  const factor = opts.slotWidthM / p.pitchM;
  if (!Number.isFinite(factor) || Math.abs(factor - 1) > opts.maxHeightCorrection) return null;
  return { nominalM: model.d, correctedM: model.d * factor, measuredWidthM: p.pitchM, factor, samples: p.samples };
}

/** 지상고만 바꾼 모델 사본(f·n 불변 — 스케일만 조정). */
function withHeight(model: GroundModel, d: number, note: string): GroundModel {
  return { ...model, d, issues: [...model.issues, note] };
}

/** 픽셀 코너 → 행 좌표계의 폭방향 좌표 a. 역투영 실패 → null. */
export function widthCoordOf(fr: RowFrame, model: GroundModel, px: { x: number; y: number }): number | null {
  const X = backprojectToGround(px as Px, model);
  if (!X) return null;
  return dot3([X[0] - fr.origin[0], X[1] - fr.origin[1], X[2] - fr.origin[2]], fr.u);
}

/**
 * 행의 한쪽 끝이 **무엇 때문에** 끝났는가(18회차 A).
 *  'evidence' — 다음 칸이 프레임 안에 있는데 도색지지가 없다 = 행의 진짜 끝.
 *  'frame'    — 다음 칸이 프레임 밖이다 = 행의 끝이 아니라 **화면의 끝**(미완결).
 *  'span'     — 격자 생성 범위(`spanLo..spanHi`)가 먼저 끝났다.
 */
export type RowExtentEnd = 'evidence' | 'frame' | 'span';

export interface GridResult {
  frontLine: [number, number, number];
  frame: RowFrame;
  /** 채택된 격자 위상(폭방향 좌표, m). */
  phaseM: number;
  quads: BayQuad[];
  /** 근변 코너(픽셀) — 채택 격자에서 재투영한 값. */
  cornersPx: Array<{ x: number; y: number }>;
  paint: PaintSupport;
  /** 검출 코너와 채택 격자 경계의 폭방향 차이 median(m). 위상이 증거와 얼마나 맞는지. */
  phaseFitM: number | null;
  /** 커버리지 가중을 반영한 선택 점수. */
  effectiveScore?: number;
  /**
   * ★ 21회차 ① — **커버리지를 곱하기 전** 점수(`paint.score + phaseFitWeight·phaseTerm + aimCenterWeight·aimTerm`).
   *
   * `rows` 진입 기준선을 이 값으로 뽑는다. 커버리지 식을 고쳐도 이 값은 변하지 않으므로
   * **목록 진입 규칙이 `best` 점수식과 분리된다**(20c 가 부딪힌 결합의 해소).
   */
  baseScore?: number;
  /**
   * ★ 21회차 ② 진단 — 커버리지와 그 분자·분모. 도구가 식을 **다시 계산하지 않게** 값으로 노출한다
   * (`roiAutoPhaseTable` 이 구 식을 재계산하다 새 식과 갈라지는 것을 막는다 = U11 방지).
   */
  coverage?: number;
  /** 커버리지 분자 = Σ 칸별 근변지지(증거 가중 유효 칸수). */
  effCells?: number;
  /** 커버리지 분모 = 근변 도색 지지 구간의 칸 수(**위상 불변**). */
  denomCells?: number;
  /** 지상고 자가보정 결과(보정 안 했으면 null). */
  calibration: HeightCalibration | null;
  /** 이 격자를 세운 지면모델(보정 후). 잔차 분해가 자동·수동을 **같은 모델**로 역투영하는 데 쓴다. */
  modelUsed: GroundModel;
  /** 행의 지면거리 median(m) — quad 중심을 역투영한 카메라-지면 거리. 거리 타당성 게이트가 쓴다. */
  medianDepthM: number | null;
  /** 진단: 격자가 만든 칸별 (격자인덱스, 근변지지, 프레임안 여부). 채택 여부와 무관하게 전부. */
  cellDiag: Array<{ index: number; near: number; inFrame: boolean; kept: boolean }>;
  /**
   * ★ 18회차 — 행 범위가 양 끝에서 무엇 때문에 끝났는가. `rowExtentMode:'expected'` 면 null.
   * `'frame'` 이면 그 방향은 **미완결**이며 화면 밖으로 행이 더 이어질 수 있다(F-a).
   */
  extentEndedBy: { lo: RowExtentEnd; hi: RowExtentEnd } | null;
  /**
   * ★ 18회차 — 도색지지 없이 **가림으로 보고 보간한** 칸의 격자 인덱스.
   * 증거 없이 산출한 quad 임을 응답에서 숨기지 않는다.
   */
  filledIndices: number[];
  issues: string[];
}

/** 칸의 근변 중점이 프레임 안인가(18회차 A — `extentEndedBy` 판정. 기존 커버리지 판정과 같은 식). */
function nearMidInFrame(q: BayQuad, model: GroundModel): boolean {
  const mx = (q.quad[0].x + q.quad[3].x) / 2;
  const my = (q.quad[0].y + q.quad[3].y) / 2;
  return mx >= 0 && my >= 0 && mx < model.imgW && my < model.imgH;
}

/** 위상 하나로 격자를 세우고 quad 를 만든다. 투영 퇴화 칸은 **버린다**(부분 quad 금지). */
function buildAtPhase(
  fr: RowFrame,
  model: GroundModel,
  phase: number,
  kFrom: number,
  kTo: number,
  opts: BayDetectOpts,
): { quads: BayQuad[]; cornersPx: Array<{ x: number; y: number }> } {
  const w = opts.slotWidthM;
  const depth = opts.slotDepthM;
  const near: Array<{ x: number; y: number } | null> = [];
  const far: Array<{ x: number; y: number } | null> = [];
  for (let k = kFrom; k <= kTo + 1; k++) {
    const a = phase + k * w;
    near.push(projectToPixel(pointAt(fr, a, 0), model));
    far.push(projectToPixel(pointAt(fr, a, depth), model));
  }
  const quads: BayQuad[] = [];
  for (let i = 0; i + 1 < near.length; i++) {
    const n0 = near[i];
    const n1 = near[i + 1];
    const f0 = far[i];
    const f1 = far[i + 1];
    if (!n0 || !n1 || !f0 || !f1) continue;
    const q = canonicalizeQuad([n0, f0, f1, n1]);
    if (q) quads.push({ latticeIndex: kFrom + i, quad: q });
  }
  return { quads, cornersPx: near.filter((p): p is { x: number; y: number } => p != null) };
}

/**
 * 한 근변선 후보에 대해 **위상만** 탐색해 최적 격자를 고른다.
 *
 * 위상 후보 = ① 검출된 근변 코너들(고품질 증거) ② 균등 스윕(폴백). 고정 순서 전수 순회 — 난수 0.
 * 채점은 재투영 도색지지(P1) 단일 기준이다.
 */
export function fitRowGrid(
  model: GroundModel,
  front: RefinedLine,
  cornerPx: ReadonlyArray<{ x: number; y: number }>,
  evidence: PaintEvidence,
  paintOpts: PaintOptions,
  opts: BayDetectOpts,
): GridResult | null {
  // ★ 5회차 P2: **후보별 보정을 하지 않는다.** 지상고 보정은 승자 확정 후 프리셋당 1회만 한다
  //   (`detectBaysWithModel`). 후보별로 보정하면 틀린 행이 자기를 잘못 보정할 뿐 아니라
  //   **정답이지만 지는 행까지 나빠져** 선별 비교가 왜곡된다(4회차 실측: 1:2 rank3 0.9512 → 0.7386,
  //   2:2 rank1 0.7291 → 0.6915). 선별은 공칭 지상고에서 공평하게 겨룬다.
  const r = fitRowGridOnce(model, front, cornerPx, evidence, paintOpts, opts, null);
  return r ? r.result : null;
}

/** fitRowGrid 1패스(지상고 고정). 보정 루프가 두 번 호출한다. */
function fitRowGridOnce(
  model: GroundModel,
  front: RefinedLine,
  cornerPx: ReadonlyArray<{ x: number; y: number }>,
  evidence: PaintEvidence,
  paintOpts: PaintOptions,
  opts: BayDetectOpts,
  calib: HeightCalibration | null,
): { result: GridResult; evidWidths: number[] } | null {
  const w = opts.slotWidthM;
  const fr0 = rowFrameFromLine(model, front.line);
  if (!fr0) return null;
  // ★ 검출된 긴 도색선이 이 행의 **근변인지 원변인지 이미지만으로는 알 수 없다**(구현자 실측:
  //   1:2·2:2 에서 승자가 다른 도색선이었고, 참 행은 후보 안에 있었는데 표에서 졌다).
  //   그래서 깊이 방향 **양쪽 모두**를 후보로 둔다 — 선이 원변이면 카메라 쪽으로 뻗는 격자가 정답이다.
  //   canonicalizeQuad 가 기하로 근변/원변을 다시 배정하므로 도색지지 채점은 방향에 불변이다.
  const frames: RowFrame[] = [fr0, { origin: fr0.origin, u: fr0.u, v: [-fr0.v[0], -fr0.v[1], -fr0.v[2]] }];

  // 폭방향 좌표는 u 가 같으므로 방향과 무관하다 — 한 번만 계산한다.
  const evid: number[] = [];
  for (const p of cornerPx) {
    const a = widthCoordOf(fr0, model, p);
    if (a != null && Number.isFinite(a)) evid.push(a);
  }
  evid.sort((a, b) => a - b);

  // 격자를 세울 범위 — 검출 코너 스팬(없으면 이미지 구간 전체)에 여유 1칸.
  const sp = imageSpanOf(front.line, model.imgW, model.imgH);
  if (!sp) return null;
  const endA = widthCoordOf(fr0, model, { x: sp.px0 + sp.dx * sp.tmin, y: sp.py0 + sp.dy * sp.tmin });
  const endB = widthCoordOf(fr0, model, { x: sp.px0 + sp.dx * sp.tmax, y: sp.py0 + sp.dy * sp.tmax });
  const spanLo = Math.min(evid[0] ?? 0, endA ?? 0, endB ?? 0);
  const spanHi = Math.max(evid[evid.length - 1] ?? 0, endA ?? 0, endB ?? 0);
  if (!Number.isFinite(spanLo) || !Number.isFinite(spanHi) || spanHi - spanLo > opts.maxRowSpanM) return null;

  // ★ 21회차 ② — **위상 불변 분모**(F18 해소). 커버리지 분모를 "이 행의 근변 도색이 실제로 이어진
  //   구간이 몇 칸인가"로 잡는다. 근거는 세 가지다:
  //   ⓐ `front.endA/endB` 는 **정련된 근변선의 지지 구간 양 끝**이며 위상과 무관하다. 종전 분모
  //      `inFrameCells` 는 `kFrom..kTo`(= `phase` 의 함수)에서 셌기 때문에 **분모 자체가 위상 의존
  //      자유변수**였다(F18 · 20c 실측 11 vs 10). 위상을 옆으로 밀어 경계 칸을 프레임 밖으로 내보내면
  //      분모가 줄어 **보상**을 받는 병리가 있었다.
  //   ⓑ `expectedBays` 가 식에서 사라진다 — 20c 가 확정한 유일 생존 경로(`min(expectedBays, ...)`)가
  //      이 한 줄이었다. 이제 개수는 산출에 어떤 영향도 주지 못한다(H2 유닛테스트로 못 박는다).
  //   ⓒ 분모가 **도색 증거**에서 오므로 스케일이 행의 실제 길이를 따른다(이미지 구간 전체를 쓰면
  //      지평선 근처 행에서 200m 까지 벌어져 옳은 행이 벌점을 받는다).
  //   지지 구간을 역투영할 수 없으면 이미지 구간 폭으로 강등한다(throw 금지 규약).
  const supA = widthCoordOf(fr0, model, front.endA);
  const supB = widthCoordOf(fr0, model, front.endB);
  const supExtentM =
    supA != null && supB != null && Number.isFinite(supA) && Number.isFinite(supB) ? Math.abs(supB - supA) : spanHi - spanLo;
  /** 위상 불변 분모(칸). 0 칸으로 나누지 않도록 하한 1. */
  const denomCells = Math.max(1, supExtentM / w);

  // 위상 후보: 검출 코너 → 균등 스윕.
  const phases: number[] = [];
  for (const a of evid) phases.push(a);
  for (let j = 0; j < opts.phaseSteps; j++) phases.push(spanLo + (w * j) / opts.phaseSteps);

  let best: GridResult | null = null;
  for (const fr of frames) for (const phase of phases) {
    const kFrom = Math.floor((spanLo - phase) / w) - 1;
    const kTo = Math.ceil((spanHi - phase) / w) + 1;
    if (kTo - kFrom > opts.maxRowCells) continue;
    const built = buildAtPhase(fr, model, phase, kFrom, kTo, opts);
    if (!built.quads.length) continue;
    // 칸별 근변 지지로 걸러내고, 남은 것에서 이 행의 창을 고른다.
    //
    // ★ 18회차 A — 창을 고르는 규칙이 모드에 따라 갈린다.
    //   'expected' : 남은 것 중 **expectedBays 개 연속창**(17회차까지의 동작. 회귀 비교 전용).
    //   'evidence' : **내부 구멍은 보간, 바깥은 외삽 금지.** 구멍은 양쪽이 증거로 둘러싸인 구간이고
    //                (= 보간, 근거 있음), 행의 끝 너머는 한쪽에만 증거가 있다(= 외삽, 근거 없음).
    //                개수 정보를 전혀 쓰지 않는다.
    const scored = built.quads.map((q) => ({ q, sup: quadPaintSupport([q], evidence, paintOpts, opts) }));
    const kept = scored.filter((e) => e.sup.near >= opts.extendMinNearSupport);
    if (!kept.length) continue;
    let window = kept;
    let extentEndedBy: GridResult['extentEndedBy'] = null;
    const filledIndices: number[] = [];
    if (opts.rowExtentMode === 'expected') {
      if (kept.length > opts.expectedBays) {
        let bestSum = -1;
        for (let i = 0; i + opts.expectedBays <= kept.length; i++) {
          const slice = kept.slice(i, i + opts.expectedBays);
          // 연속 격자칸만 창으로 인정한다(구멍 난 묶음 금지).
          if (slice[slice.length - 1].q.latticeIndex - slice[0].q.latticeIndex !== opts.expectedBays - 1) continue;
          const sum = slice.reduce((s, e) => s + e.sup.near, 0);
          if (sum > bestSum) {
            bestSum = sum;
            window = slice;
          }
        }
        if (bestSum < 0) window = kept.slice(0, opts.expectedBays);
      }
    } else {
      // ① kept 를 격자인덱스 오름차순으로 보며 **연속 run** 으로 자른다.
      //    인접 kept 의 인덱스 차가 maxGap+1 이하면 사이 결손은 가림(같은 run), 넘으면 행의 끝(run 을 끊는다).
      //    새 튜닝 파라미터를 만들지 않는다 — 기존 maxGap 을 그대로 쓴다.
      const runs: Array<typeof kept> = [];
      for (const e of kept) {
        const cur = runs[runs.length - 1];
        if (cur && e.q.latticeIndex - cur[cur.length - 1].q.latticeIndex <= opts.maxGap + 1) cur.push(e);
        else runs.push([e]);
      }
      // ② run 이 여럿이면 근변지지 합이 최대인 run 을 이 위상의 창으로 삼는다(기존 bestSum 선택과 동형).
      let run = runs[0];
      let bestSum = -1;
      for (const r of runs) {
        const sum = r.reduce((s, e) => s + e.sup.near, 0);
        if (sum > bestSum) {
          bestSum = sum;
          run = r;
        }
      }
      // ③ run **내부**의 결손 칸을 되살린다. 격자는 이미 세워져 있으므로 새 좌표를 지어내지 않는다.
      const loIdx = run[0].q.latticeIndex;
      const hiIdx = run[run.length - 1].q.latticeIndex;
      const keptIdx = new Set(run.map((e) => e.q.latticeIndex));
      const filled = scored.filter((e) => e.q.latticeIndex >= loIdx && e.q.latticeIndex <= hiIdx);
      for (const e of filled) if (!keptIdx.has(e.q.latticeIndex)) filledIndices.push(e.q.latticeIndex);
      // ④ 창의 양 끝 밖으로는 **한 칸도 확장하지 않는다.** 끝난 이유만 기록한다.
      const endOf = (idx: number): RowExtentEnd => {
        const nb = scored.find((e) => e.q.latticeIndex === idx);
        if (!nb) return 'span';
        return nearMidInFrame(nb.q, model) ? 'evidence' : 'frame';
      };
      extentEndedBy = { lo: endOf(loIdx - 1), hi: endOf(hiIdx + 1) };
      window = filled;
    }
    const quads = window.map((e) => e.q);
    const paint = quadPaintSupport(quads, evidence, paintOpts, opts);
    if (paint.near < opts.minNearSupport) continue;
    // 검출 코너와 격자 경계의 거리(작을수록 위상이 증거와 맞는다).
    const devs0 = evid.map((a) => {
      const r = Math.abs(((((a - phase) % w) + w) % w) - w / 2);
      return w / 2 - r;
    });
    // ★ 커버리지 가중 — "덮어야 할 만큼 덮었는가"로 점수를 깎는다. 이것이 없으면 "도색 위의 짧은 2칸"이
    //   "도색 위의 온전한 4칸"을 이긴다(구현자 실측: 2:2 가 quad 2개짜리 엉뚱한 행을 골랐다).
    //   ★ 반증 #10(커버리지 페널티 완화·제거)과 **방향이 반대**다: 분자를 칸 수 → **증거 가중 유효 칸수**로
    //     바꾸므로 `near ≤ 1` 에 의해 새 분자 ≤ 옛 분자다(벌점은 같거나 더 세다). `coverageExponent` 무접촉.
    //
    // ★ 21회차 ② — **분자·분모를 같은 척도에 올린다**(20c 가 확정한 결함의 직접 수정).
    //   ⓐ 분자: `quads.length`(칸 **개수**) → `Σ 칸별 근변지지`(증거 가중 **유효** 칸수).
    //      20c 실측이 결함을 못 박았다: `paint.score` 는 칸당 **평균**인데 `coverage` 는 칸 **개수**라
    //      척도가 어긋나 있고, 반칸 밀린 위상은 **온전한 1칸을 반쪽 2칸으로 쪼개** 개수를 늘려
    //      길이 보너스(+16.7%)로 증거 열세(−11.8%)를 이겼다. 반쪽 칸을 반쪽으로만 세면 그 이득이 사라진다
    //      (P_정답 6.000 vs P_반칸 6.285 = +4.75% 로 축소, 증거 격차 +8.4% 가 이를 뒤집는다).
    //      ★ `paint.near × quads.length` 대신 **칸별 합을 직접** 쓴다 — 표본 가중 평균과 단순 평균이
    //        미세하게 다르므로(20c 검산 6.285 vs 6.286) 정의를 추정에 기대지 않는다.
    //   ⓑ 분모: 위상 의존 `min(expectedBays, inFrameCells)` → **위상 불변** `denomCells`(위 §참조).
    //   두 축을 동시에 고쳐야 한다 — 분모만 고치면 개수 보너스가 그대로 남고(실측: 6/11 vs 7/11 → 오답 승),
    //   분자만 고치면 F18 분모 병리가 남는다(20c: bays≥11 에서 위상 미끄러짐).
    const effCells = window.reduce((s, e) => s + e.sup.near, 0);
    // 종전 식(면수를 아는 호출자) — 분모가 위상 의존(F18)이고 분자가 칸 개수라 반칸 위상에 길이 보너스를 준다.
    //   그 병리는 20c 가 확정했고, 이 갈래는 **골든 기준선 재현 전용**으로 남긴다(`rowExtentMode:'expected'` 와 같은 규약).
    const inFrameCells = scored.filter((e) => {
      const mx = (e.q.quad[0].x + e.q.quad[3].x) / 2;
      const my = (e.q.quad[0].y + e.q.quad[3].y) / 2;
      return mx >= 0 && my >= 0 && mx < model.imgW && my < model.imgH;
    }).length;
    const coverage =
      opts.coverageDenom === 'phaseInvariant'
        ? Math.min(1, effCells / denomCells)
        : Math.min(1, quads.length / Math.max(1, Math.min(opts.expectedBays, inFrameCells || opts.expectedBays)));
    // ★ 위상 적합을 점수로 승격(4회차 U1). 검출 코너가 격자 경계에 몰릴수록 1 에 가깝다.
    //   ⚠ 이 항은 프리셋마다 방향이 갈린다 — 2:2 는 정답을 밀어주지만 1:2 는 오답을 밀어준다(구현자 실측).
    //   그래서 가중을 0 으로 두면 3회차와 동일 거동이며, 실측으로 이득이 확인된 경우에만 올린다.
    const phaseTermRaw = devs0.length ? median(devs0) : null;
    const phaseTerm = phaseTermRaw == null ? 0 : Math.max(0, 1 - phaseTermRaw / (w / 2));
    // ★ 조준 중심성 — quad 중심들이 화면 중앙에서 얼마나 떨어져 있는가(0=중앙, 1=프레임 끝).
    //   프리셋 PTZ 는 대상 열을 겨냥해 맞춘 것이므로 대상 열은 중앙 근처에 온다.
    let aimTerm = 0;
    if (opts.aimCenterWeight !== 0 && quads.length) {
      const cx = model.imgW / 2;
      const cy = model.imgH / 2;
      const half = Math.hypot(cx, cy);
      let acc = 0;
      for (const q of quads) {
        const qx = (q.quad[0].x + q.quad[1].x + q.quad[2].x + q.quad[3].x) / 4;
        const qy = (q.quad[0].y + q.quad[1].y + q.quad[2].y + q.quad[3].y) / 4;
        acc += Math.min(1, Math.hypot(qx - cx, qy - cy) / half);
      }
      aimTerm = 1 - acc / quads.length;
    }
    // ★ 21회차 ① — 커버리지 이전 점수를 **따로 이름 붙인다**(값은 종전과 동일한 곱의 앞부분).
    const baseScore = paint.score + opts.phaseFitWeight * phaseTerm + opts.aimCenterWeight * aimTerm;
    const effective = baseScore * Math.pow(coverage, opts.coverageExponent);
    const cornersPx: Array<{ x: number; y: number }> = [];
    for (const q of quads) cornersPx.push(q.quad[0]);
    if (quads.length) cornersPx.push(quads[quads.length - 1].quad[3]);
    const devs = devs0;
    const cand: GridResult = {
      frontLine: front.line,
      frame: fr,
      phaseM: phase,
      quads,
      cornersPx,
      paint,
      phaseFitM: devs.length ? median(devs) : null,
      calibration: calib,
      modelUsed: model,
      medianDepthM: (() => {
        const ds: number[] = [];
        for (const q of quads) {
          const cxq = (q.quad[0].x + q.quad[1].x + q.quad[2].x + q.quad[3].x) / 4;
          const cyq = (q.quad[0].y + q.quad[1].y + q.quad[2].y + q.quad[3].y) / 4;
          const X = backprojectToGround({ x: cxq, y: cyq }, model);
          if (X) ds.push(Math.hypot(X[0], X[1], X[2]));
        }
        return ds.length ? median(ds) : null;
      })(),
      cellDiag: scored.map((e) => {
        const mx = (e.q.quad[0].x + e.q.quad[3].x) / 2;
        const my = (e.q.quad[0].y + e.q.quad[3].y) / 2;
        return {
          index: e.q.latticeIndex,
          near: e.sup.near,
          inFrame: mx >= 0 && my >= 0 && mx < model.imgW && my < model.imgH,
          kept: quads.some((q) => q.latticeIndex === e.q.latticeIndex),
        };
      }),
      extentEndedBy,
      filledIndices,
      issues: calib ? [model.issues[model.issues.length - 1]] : [],
    };
    // 선택: 도색지지 desc → quad 수 desc → 위상 적합 asc. 동점은 순회 순서(먼저 담긴 쪽) 유지.
    cand.effectiveScore = effective;
    cand.baseScore = baseScore;
    cand.coverage = coverage;
    cand.effCells = effCells;
    cand.denomCells = denomCells;
    if (
      !best ||
      effective > (best.effectiveScore ?? 0) + 1e-12 ||
      (Math.abs(effective - (best.effectiveScore ?? 0)) <= 1e-12 && (cand.phaseFitM ?? 1e9) < (best.phaseFitM ?? 1e9))
    ) {
      best = cand;
    }
  }
  return best ? { result: best, evidWidths: evid } : null;
}


/**
 * ★ 8회차 — 근변선 **2자유도(오프셋+각도) 재적합**. 13면 정체의 유일한 원인을 직접 겨냥한다.
 *
 * 7회차 성분 분해가 밝힌 것: 폭·깊이·전단은 0.2% 이내로 정확하고, 결손은 전부 **근변선 배치**다.
 * 그리고 그 배치 오차는 평행이동이 아니라 **회전**이다 — 오프셋이 행을 따라 단조 변화하고
 * (1:1 +0.1268→+0.0331m, 2:1 +0.0352→+0.0775m) 전단은 0이다. 회전각 0.16~0.31°.
 *
 * 원인: 최초 근변선은 Hough 피크를 **마스크 지지 구간**에서만 TLS 적합한다. 차량 가림이 한쪽에 몰리면
 * 지레팔이 짧고 편중돼 각도가 편향된다. **1자유도(오프셋) 보정으로는 절반만 잡힌다.**
 *
 * 해법은 튜닝이 아니라 **관측을 더 하는 것**이다: 격자를 채택한 뒤에는 근변 경계가 실제로 뻗어야 할
 * 전 구간(행 전체)을 알 수 있으므로, 최초 검출이 지지를 얻지 못했던 구간까지 포함해 스트라이프 중심을
 * 다시 훑는다. 지레팔이 길어지면 회전 편향이 원리적으로 줄어든다. 과적합 위험이 없다.
 */
export function refitFrontLineOverRow(
  frame: FrameGray,
  front: readonly [number, number, number],
  quads: readonly BayQuad[],
  opts: PaintOptions,
  /** 행 전 구간에서 뜰 표본 수(지레팔을 길게 쓰기 위해 초기 검출보다 많이). */
  samples: number,
  /** 이물 절단 임계 계수(median + k·MAD). */
  trimK: number,
  /** >0 이면 구간 균등 가중 TLS. */
  uniformBins: number,
): RefinedLine | null {
  if (quads.length === 0) return null;
  const px0 = -front[2] * front[0];
  const py0 = -front[2] * front[1];
  const dx = -front[1];
  const dy = front[0];
  const proj = (q: { x: number; y: number }): number => (q.x - px0) * dx + (q.y - py0) * dy;
  // 근변 경계 전 구간 = 첫 칸의 근좌 ~ 마지막 칸의 근우.
  const ts: number[] = [];
  for (const q of quads) {
    ts.push(proj(q.quad[0]));
    ts.push(proj(q.quad[3]));
  }
  const lo = Math.min(...ts);
  const hi = Math.max(...ts);
  if (!(hi - lo > 1)) return null;
  const img = imageSpanOf(front, frame.width, frame.height);
  if (!img) return null;
  // 이미지 밖으로는 나가지 않되, 행 전 구간을 덮는다(최초 지지 구간보다 훨씬 길다).
  const tmin = Math.max(img.tmin, lo);
  const tmax = Math.min(img.tmax, hi);
  if (!(tmax - tmin > 1)) return null;
  return refineLineRobust(frame, front, { ...opts, samplesPerLine: samples }, { tmin, tmax, px0, py0, dx, dy }, trimK, 2, uniformBins);
}

/** 근변선 후보 1건 + 그 위의 검출 코너. */
export interface RowCandidate {
  front: RefinedLine;
  cornersPx: Array<{ x: number; y: number }>;
}

export interface GridDetection {
  best: GridResult | null;
  /**
   * ★ 18회차 B — 중복 제거된 **행 후보 전체**. `paint.score` desc 정렬.
   *
   * 한 프레임에 실재 주차열이 여럿이라는 것은 이미 확립된 사실이고(U14: 5뷰 가시 41면 vs 정본 23면),
   * 행 계산은 이미 후보마다 다 되어 있었다 — **버리던 것을 안 버릴 뿐**이다.
   *
   * `best` 와의 역할 구분:
   *   `best` = 조준(`aimCenterWeight`)·거리 게이트까지 고려한 **이 프리셋이 겨눈 대표 행**.
   *   `rows` = 도색 증거(`paint.score`)만으로 서열을 매긴 **보이는 행 전체**. 거리 게이트 미적용.
   *
   * ★ 19회차 — 중복 제거 **뒤에** 진입 문턱(`rowMinScoreRatio`·`rowMinNearSupport`)을 통과한 것만 담는다.
   */
  rows: GridResult[];
  /** 후보별 요약(진단). */
  tried: Array<{ votes: number; quads: number; nearSupport: number; score: number }>;
  issues: string[];
}

/**
 * 행 후보 중복 제거 — 서로 다른 전방선 후보 2개가 같은 물리 행에 latch 한 경우를 접는다.
 *
 * 판정은 **quad 집합 겹침 단일 기준**이다(새 기하 수식 0줄, `quadIoU` 재사용 = R4):
 * 점수 낮은 쪽 B 의 quad 중 A 의 어떤 quad 와 `quadIoU ≥ rowMergeIoU` 인 것이 절반을 넘으면 B 를 버린다.
 */
function dedupeRows(cands: readonly GridResult[], opts: BayDetectOpts): GridResult[] {
  // 정렬키에서 effectiveScore 를 쓰지 않는다 — aim 항이 곱해져 있어 "중앙에 있는 행"이 목록 1등이 되면
  // 서열 규약("도색 증거가 1순위")이 목록에서 역전된다. 서열은 도색 증거로 정한다.
  const order = cands
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.paint.score - a.r.paint.score || b.r.quads.length - a.r.quads.length || a.i - b.i);
  const out: GridResult[] = [];
  for (const { r } of order) {
    if (!r.quads.length) continue;
    let overlapped = false;
    for (const k of out) {
      let hit = 0;
      for (const q of r.quads) if (k.quads.some((p) => quadIoU(p.quad, q.quad) >= opts.rowMergeIoU)) hit++;
      if (hit / r.quads.length >= 0.5) {
        overlapped = true;
        break;
      }
    }
    if (!overlapped) out.push(r);
  }
  return out;
}

/**
 * F-b(연속 가림 4칸 이상) 진단 — 같은 행이 두 조각으로 끊긴 것이 의심되는 쌍을 **기록만** 한다.
 *
 * 전방선 각도 차 < 1° 이고 격자 위상 차가 칸 주기로 0.25m 미만이면 같은 행의 조각일 수 있다.
 * **자동 병합하지 않는다** — 진짜 이웃 행 둘(같은 도색 방향·같은 위상)을 하나로 붙일 수 있고,
 * 그건 "거리 하드 게이트"가 죽은 것과 같은 종류의 실패다. 판단은 상위에 남긴다.
 */
function rowFragmentNotes(rows: readonly GridResult[], slotWidthM: number): string[] {
  const out: string[] = [];
  const angOf = (l: readonly [number, number, number]) => (Math.atan2(l[1], l[0]) * 180) / Math.PI;
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      let dAng = Math.abs(angOf(rows[i].frontLine) - angOf(rows[j].frontLine)) % 180;
      if (dAng > 90) dAng = 180 - dAng;
      if (dAng >= 1) continue;
      const dp = Math.abs((((rows[i].phaseM - rows[j].phaseM) % slotWidthM) + slotWidthM) % slotWidthM);
      if (Math.min(dp, slotWidthM - dp) >= 0.25) continue;
      out.push(`행 조각 의심: rows#${i} ↔ rows#${j} (전방선 각 차 ${dAng.toFixed(3)}°, 위상 차 ${Math.min(dp, slotWidthM - dp).toFixed(3)}m) — 자동 병합하지 않는다`);
    }
  }
  return out;
}

/**
 * 근변선 후보 전수 × 위상 전수 → 최적 격자. 수동 ROI 를 인자로 받지 않는다(R1).
 * 지면모델은 **주입**된다 — 이 함수는 f 도 소실점도 추정하지 않는다.
 */
export function detectBaysWithModel(
  candidates: readonly RowCandidate[],
  model: GroundModel,
  evidence: PaintEvidence,
  paintOpts: PaintOptions,
  opts: BayDetectOpts,
  /** 근변선 2자유도 재적합용 그레이 프레임. 없으면 재적합을 건너뛴다(순수성 유지). */
  frame?: FrameGray,
): GridDetection {
  const tried: GridDetection['tried'] = [];
  let best: GridResult | null = null;
  let bestCand: RowCandidate | null = null;
  // ① 선별 — 전 후보를 **공칭 지상고**에서 겨루게 한다(보정이 비교를 왜곡하지 않도록).
  //
  // ★ 서열 규약(리더 6회차 지시): **도색 증거가 1순위, 조준 중심성·거리는 동점 해소자**다.
  //   중심성을 과신하면 도색 증거를 이기는 순간 무너진다(실측: aimCenterWeight 3.0 에서 2:1 이 0.931 → 0.103).
  const scoredCands: Array<{ r: GridResult; c: RowCandidate }> = [];
  for (const c of candidates) {
    const r = fitRowGrid(model, c.front, c.cornersPx, evidence, paintOpts, opts);
    if (!r) continue;
    tried.push({ votes: c.front.votes, quads: r.quads.length, nearSupport: r.paint.near, score: r.paint.score });
    scoredCands.push({ r, c });
  }
  // ★ 18회차 B — `rows` 는 여기서 **곁가지로** 만든다. 아래 `best` 산출(거리 게이트 → argmax → 보정 → 재적합)은
  //   한 줄도 옮기지 않는다. 위치가 거리 게이트 **앞**인 것은 의미상 필수다: 게이트는 "먼 행을 버리는" 장치이고
  //   목표 ①("보이는 모든 면")은 먼 행도 찾아야 하므로 `maxRowDistanceRatio` 는 `pool`(=best 전용)에만 걸린다.
  // ★ 19회차 — **진입 문턱**. 18회차는 정렬만 하고 진입을 설계하지 않아 모든 전방선 후보가 격자를
  //   온전히 산출했고(검출 131개 중 진짜 24개, 정밀도 0.1832) 사람이 쓸 수 없는 목록이 됐다.
  //   기준선은 프리셋마다 스케일이 달라 절대값을 못 쓰므로 **상대 기준**이어야 한다.
  //
  // ★ 21회차 ① — **진입 기준선을 `effectiveScore` 에서 분리한다.**
  //   종전에는 "`best` 로 뽑힌 후보의 `paint.score`"를 기준선으로 썼다. 그러면 `best` 점수식
  //   (`effectiveScore` = 도색 × 커버리지 × 조준)을 한 줄만 고쳐도 기준선이 따라 움직여 **목록 전체가
  //   재편**된다 — 20c 실측: 커버리지 분자 1줄 수정이 `1:2` 의 rows 를 2행→1행으로 줄여 전체 정밀도를
  //   0.8571→0.6250 으로 떨어뜨린 주범이었다(그때 재현율 손실의 절반이 이 결합 탓이다).
  //   그래서 기준선을 **커버리지에 불변인 양**(`baseScore` = 도색 + 위상적합 + 조준)의 argmax 에서 뽑는다.
  //   ⓐ 커버리지 식을 고쳐도 이 선택은 움직이지 않는다 = 진입 규칙이 `best` 점수식과 분리된다.
  //   ⓑ 현행 골든에서는 `baseScore` argmax 와 `effectiveScore` argmax 가 **같은 후보**라 수치가 비트 동일하다
  //      (구현자 실측 — 5프리셋 전부. 다르면 이 리팩터는 성립하지 않으므로 그 사실을 먼저 확인했다).
  //   argmax 규약은 아래 `best` 선택과 같은 식(strict > + 1e-12, 동점은 먼저 담긴 쪽)이다.
  let refScore = 0;
  let refBase = -Infinity;
  for (const e of scoredCands) {
    const b = e.r.baseScore ?? e.r.paint.score;
    if (b > refBase + 1e-12) {
      refBase = b;
      refScore = e.r.paint.score;
    }
  }
  const rows = dedupeRows(
    scoredCands.map((e) => e.r),
    opts,
  ).filter((r) => r.paint.score >= refScore * opts.rowMinScoreRatio && r.paint.near >= opts.rowMinNearSupport);
  const rowIssues = opts.rowExtentMode === 'evidence' ? rowFragmentNotes(rows, opts.slotWidthM) : [];

  // 거리 타당성 게이트 — 최근접 후보 대비 지나치게 먼 행은 이 프리셋의 대상이 아니다.
  let pool = scoredCands;
  if (opts.maxRowDistanceRatio > 0) {
    const depths = scoredCands.map((e) => e.r.medianDepthM).filter((d): d is number => d != null && d > 0);
    if (depths.length) {
      const nearest = Math.min(...depths);
      const kept = scoredCands.filter((e) => e.r.medianDepthM == null || e.r.medianDepthM <= nearest * opts.maxRowDistanceRatio);
      if (kept.length) pool = kept;
    }
  }
  for (const e of pool) {
    if (!best || (e.r.effectiveScore ?? e.r.paint.score) > (best.effectiveScore ?? best.paint.score) + 1e-12) {
      best = e.r;
      bestCand = e.c;
    }
  }
  if (!best || !bestCand) {
    return {
      best: null,
      rows,
      tried,
      issues: [`D12_NO_PAINT_SUPPORT: 근변선 후보 ${candidates.length}개 중 도색지지 기준을 넘는 격자 0건`],
    };
  }

  // ② 보정 — 승자의 격자에서 실제 칸 간격을 재어 지상고를 프리셋당 **한 번** 고친 뒤 승자만 다시 세운다.
  //    선별은 이미 끝났으므로 이 단계는 순위를 바꾸지 않는다 — 스케일만 맞춘다.
  const issues: string[] = [...rowIssues];
  const probe = fitRowGridOnce(model, bestCand.front, bestCand.cornersPx, evidence, paintOpts, opts, null);
  const calib = probe ? calibrationFromGrid(probe.evidWidths, probe.result.phaseM, model, opts) : null;
  if (!calib) return { best, rows, tried, issues };
  const note =
    `지상고 자가보정: ${calib.nominalM.toFixed(3)}m → ${calib.correctedM.toFixed(3)}m ` +
    `(관측 칸간격 ${calib.measuredWidthM.toFixed(4)}m vs 규격 ${opts.slotWidthM}m, 계수 ${calib.factor.toFixed(5)}, 표본 ${calib.samples})`;
  const corrected = withHeight(model, calib.correctedM, note);
  const refit = fitRowGridOnce(corrected, bestCand.front, bestCand.cornersPx, evidence, paintOpts, opts, calib);
  if (!refit) {
    issues.push(`${note} — 보정 모델에서 격자 재구성 실패, 공칭 결과 유지`);
    return { best, rows, tried, issues };
  }
  issues.push(note);
  let adopted = refit.result;
  let adoptedCand = bestCand;

  // ③ 근변선 2자유도 재적합 — 채택 격자의 근변 전 구간에서 도색 중심을 다시 훑어 오프셋+각도를 잡는다.
  if (frame && opts.refitFrontLine) {
    for (let pass = 0; pass < opts.rowRefitPasses; pass++) {
      const raw = refitFrontLineOverRow(frame, adopted.frontLine, adopted.quads, paintOpts, opts.rowRefitSamples, opts.rowRefitTrimK, opts.rowRefitUniformBins);
      if (!raw) break;
      // ★ 감쇠(10회차) — 재적합이 진동하는 프리셋이 있다(구현자 실측 2:2: 이동 2.59 → 2.77 → 3.04px 로 **증가**).
      //   새 직선을 그대로 채택하지 않고 직전 직선과 섞는다. 감쇠 1.0 이면 감쇠 없음.
      const w = opts.rowRefitDamping;
      const blended: [number, number, number] = [
        adopted.frontLine[0] * (1 - w) + raw.line[0] * w,
        adopted.frontLine[1] * (1 - w) + raw.line[1] * w,
        adopted.frontLine[2] * (1 - w) + raw.line[2] * w,
      ];
      const bn = Math.hypot(blended[0], blended[1]);
      if (!(bn > 0)) break;
      const re: RefinedLine =
        w >= 1
          ? raw
          : { ...raw, line: [blended[0] / bn, blended[1] / bn, blended[2] / bn] };
      const next = fitRowGridOnce(corrected, re, adoptedCand.cornersPx, evidence, paintOpts, opts, calib);
      if (!next) break;
      // 재적합이 항상 이롭다고 가정하지 않는다. 다만 이물 절단 후에는 표본이 줄어 지지가 **소폭** 내려갈 수 있으므로
      // 미세 하락은 허용한다(허용치 초과 하락만 거부). 8회차 실측: 이 가드가 너무 빡빡해 2:1 재적합이 통째로 기각됐다.
      if (next.result.paint.near < adopted.paint.near - opts.rowRefitSupportDrop) break;
      const moved = Math.abs(re.line[2] - adopted.frontLine[2]);
      adopted = next.result;
      adoptedCand = { front: re, cornersPx: adoptedCand.cornersPx };
      const angDeg = (Math.atan2(re.line[1], re.line[0]) * 180) / Math.PI;
      issues.push(
        `근변선 재적합 pass${pass + 1}: 표본 ${re.hit}/${opts.rowRefitSamples}, 잔차 ${re.residPx.toFixed(2)}px, ` +
          `법선 c=${re.line[2].toFixed(4)} (이동 ${moved.toFixed(4)}px), 각 ${angDeg.toFixed(5)}°, 근변지지 ${next.result.paint.near.toFixed(3)}`,
      );
      if (moved < opts.rowRefitStopPx) break;
    }
  }
  return { best: adopted, rows, tried, issues };
}
