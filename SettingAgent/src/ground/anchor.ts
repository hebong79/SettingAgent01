// ★ 2 DOF 앵커 지표(설계 §6) — 기존 4지표(metricErr·tiltErrDeg·dDevRel·bearingDevDeg)가 **원리적으로 침묵**하는
// "지면 위 평행이동"을 잡는 유일한 검출기. 순수 함수.
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 이것이 절대 앵커인가 — 두 개의 **독립** 관측을 비교하기 때문이다.
//   C_slot    (슬롯 지면 중심)  ← ROI 파일에서 온다      → ROI 를 Δ 밀면 **함께 움직인다**
//   C_vehicle (차량 접지 지면점) ← VPD 마스크 픽셀에서 온다 → **움직이지 않는다**
//   ∴ 지표 = C_vehicle − C_slot 는 정확히 −Δ 만큼 반응한다.
//
// 보조정리(지면모델 불변성): C_vehicle 은 GroundModel(f,n,d) 로 역투영되는데 그 모델 자체가 ROI 에서 추정된다.
//   그럼에도 f(소실점=직선의 **방향**) · n(방향들의 외적) · d(metricErr 불변 실측) 는 **지면 평행이동에 불변**이다.
//   → C_vehicle 은 정말로 가만히 있다. (여기가 무너지면 지표 전체가 무너진다 → T-8a 로 봉인)
//
// ★ C_vehicle 은 **접지 앞선**(frontGround)이다 — footprint 중심이 아니다(F-2).
//   중심 = 앞선 + PRIOR_L/2 이므로 **prior 가 지표에 주입**된다. prior 가 틀리면 지표가 조용히 틀린다.
//   앵커의 존재 이유는 "관측 대 관측" 비교이므로, prior 가 한 번도 곱해지지 않은 양만 쓴다.
//
// 🔴 알려진 한계(은닉 금지, 설계 §6-3): 슬롯 스트립은 **주기 2.5m 로 자기 자신에 겹친다.**
//   폭축으로 **정확히 k칸(k×2.5m)** 밀면 밀린 격자가 자기 자신과 겹치고 차량은 (다른 번호의) 슬롯 정중앙에
//   **딱 맞게** 앉는다 → phaseDevM 도 **원리적으로 침묵**한다. 닫히는 것은 **1.5 DOF**:
//     · 깊이축(비주기) — 완전히 닫힘 ✅
//     · 폭축 비정수배  — 닫힘 ✅   /   폭축 정수배 — **3지표 전부 침묵 가능** ❌ (F-3 실측: unmatchedRate 도 0)
//
// ★ **슬롯 배정(어느 차 ↔ 어느 슬롯)을 절대 쓰지 않는다.** 최근접 배정을 쓰면 밀린 슬롯이 차량을 다시 흡수해
//   지표가 스스로 침묵한다(순환). 아래 3지표는 전부 배정 없이 정의된다. (T-8c 로 봉인)
// ─────────────────────────────────────────────────────────────────────────────

import { circularMedianAngle, median } from '../domain/geometry.js';
import { pointInPolygon } from '../domain/polygon.js';
import { toAxisCoords } from './contact.js';
import { backprojectToGround } from './project.js';
import type { GroundModel } from './types.js';
import type { AnchorMetrics, AnchorOptions, Px, SlotAxes, Vec3, VehicleCuboid } from './contactTypes.js';

/** 주기 P 로 감기 → [−P/2, P/2). */
function wrapPeriod(x: number, P: number): number {
  return x - P * Math.round(x / P);
}

/**
 * 주기 P 의 **원형 중앙값**. domain/geometry.circularMedianAngle(주기 π, 축각) 패턴 재사용:
 * x(주기 P) → θ = π·x/P (주기 π) → 강건 대표각 → x = θ·P/π ∈ (−P/2, P/2].
 * 산술 median 을 쓰면 격자 경계(−1.25 / +1.25)에서 두 군으로 갈려 **0 근처로 잘못 접힌다** → 반드시 원형.
 */
function circularMedianPeriodic(xs: number[], P: number): number {
  if (xs.length === 0) return 0;
  const theta = circularMedianAngle(xs.map((x) => (Math.PI * x) / P));
  return (theta * P) / Math.PI;
}

/** 슬롯 폴리곤(픽셀) → 슬롯 기저 좌표계 폴리곤 {a,b}. 코너 하나라도 지평선 위면 그 슬롯 제외. */
function slotsInAxisCoords(
  slotPolysPx: readonly Px[][],
  g: GroundModel,
  axes: SlotAxes,
): Array<Array<{ x: number; y: number }>> {
  const out: Array<Array<{ x: number; y: number }>> = [];
  for (const poly of slotPolysPx) {
    if (poly.length < 3) continue;
    const ab: Array<{ x: number; y: number }> = [];
    let ok = true;
    for (const p of poly) {
      const X = backprojectToGround(p, g);
      if (!X) {
        ok = false;
        break;
      }
      const c = toAxisCoords(X, axes);
      ab.push({ x: c.a, y: c.b }); // pointInPolygon 재사용을 위해 {x,y} 로 담는다(단위는 meter).
    }
    if (ok) out.push(ab);
  }
  return out;
}

/** 폴리곤 정점 평균(슬롯 중심 근사 — 직사각형이므로 무게중심과 동일). 폭축 격자 위상의 기준. */
function polyMean(poly: ReadonlyArray<{ x: number; y: number }>): { a: number; b: number } {
  const n = poly.length || 1;
  return {
    a: poly.reduce((s, p) => s + p.x, 0) / n,
    b: poly.reduce((s, p) => s + p.y, 0) / n,
  };
}

/** 슬롯 **앞선**(카메라 쪽 변)의 깊이축 좌표 = 코너 b 의 최솟값(+w 가 카메라에서 멀어지는 방향이므로). */
function slotFrontB(poly: ReadonlyArray<{ x: number; y: number }>): number {
  return Math.min(...poly.map((p) => p.y));
}

/**
 * ★ 앵커 지표 3종(프리셋 단위). 배정 없음 · 순수 · 결정형.
 * 표본(유효 육면체) < minAnchorN → 3지표 전부 **null**(median 이 의미 없다) + issue.
 */
export function computeAnchorMetrics(
  cuboids: readonly VehicleCuboid[],
  slotPolysPx: readonly Px[][],
  g: GroundModel,
  axes: SlotAxes | null,
  opts: AnchorOptions,
): AnchorMetrics {
  const issues: string[] = [];
  const n = cuboids.length;
  const none: AnchorMetrics = { depthDevM: null, phaseDevM: null, unmatchedRate: null, n, issues };
  if (!axes) {
    issues.push('슬롯 축 없음 — 앵커 지표 산출 불가');
    return none;
  }
  const slots = slotsInAxisCoords(slotPolysPx, g, axes);
  if (slots.length === 0) {
    issues.push('슬롯 폴리곤 0개(지면 역투영 실패) — 앵커 지표 산출 불가');
    return none;
  }
  if (n < opts.minAnchorN) {
    issues.push(`유효 육면체 ${n}대 < ${opts.minAnchorN}대 — 앵커 지표 3종 전부 null(median 무의미)`);
    return none;
  }

  // ★ C_vehicle = **접지 앞선**(frontGround). footprint 중심(= 앞선 + PRIOR_L/2)을 쓰면 prior 가 지표에 주입되어
  //   prior 가 틀리면 지표가 조용히 틀린다(F-2). 앵커는 **관측 대 관측**이어야 한다.
  const veh = cuboids.map((c) => toAxisCoords(c.frontGround, axes));
  const slotC = slots.map(polyMean); // 폭축 격자 위상(②)의 기준 — 중심이 맞다(주기 격자의 위상).

  // ① 깊이축 계통편차 — **비주기** → 임의 크기 밀림에 선형 반응. 배정 불필요.
  //    차량 **앞범퍼 접지선** vs 슬롯 **앞선**: 둘 다 관측/파일의 같은 기하량(앞선) → PRIOR_L 무관.
  //    ⚠️ 정상 상태의 값은 0 이 아니라 **차량이 슬롯 앞선에서 물러난 실제 거리**(물리량)다. 임계는 이를 감안해 확정한다(G6).
  //    차는 슬롯 깊이 방향으로 ±0.3m 흔들리지만 median 이 랜덤 성분을 지운다.
  const wSlot = median(slots.map(slotFrontB));
  const depthDevM = median(veh.map((c) => c.b - wSlot));

  // ② 폭축 격자 위상편차 — 주기 P(=슬롯 폭) → **비정수배 밀림에만** 반응(정수배는 원리적 침묵).
  const P = opts.periodM;
  const aGrid0 = circularMedianPeriodic(
    slotC.map((c) => c.a),
    P,
  );
  const phaseDevM = circularMedianPeriodic(
    veh.map((c) => wrapPeriod(c.a - aGrid0, P)),
    P,
  );

  // ③ 미배정 비율 — advisory 전용(게이팅 금지).
  //    ⚠️ **폭축 정수배 밀림에서는 이 지표도 0 이 될 수 있다**(F-3 실측). 설계 §6-5 의 "약한 반응" 예측은 틀렸다.
  //    포함 판정만은 **footprint 중심**을 쓴다(①②와 다름): 접지 앞선은 슬롯 경계에 바싹 붙어 있어
  //    차가 앞선에 살짝 걸치기만 해도 뒤집힌다 → 정합 오류가 아니라 **주차 습관**을 재는 지표가 되어버린다.
  //    (깊이 밀림은 어차피 ① 이 선형으로 잡으므로, 여기서는 민감도보다 **강건성**이 옳다.)
  let unmatched = 0;
  for (const c of cuboids) {
    const p = toAxisCoords(c.centerGround, axes);
    const inside = slots.some((poly) => pointInPolygon(poly, { x: p.a, y: p.b }));
    if (!inside) unmatched += 1;
  }
  const unmatchedRate = unmatched / n;

  return { depthDevM, phaseDevM, unmatchedRate, n, issues };
}
