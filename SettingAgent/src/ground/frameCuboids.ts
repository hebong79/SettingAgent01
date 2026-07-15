// ★ 프레임 1장 → 차량 3D 육면체. **세 표면(정밀수집 잡 · 라이브 검출 · /capture/vehicle-cuboids)이
//   전부 이 함수를 부른다** — 산출 로직 중복 0(설계 §2. "두 개의 다른 진실" 금지).
//
// ★ det 가 권위다: 차량 목록·cls·confidence·bbox 는 **점유 판정이 쓰는 바로 그 det 배열**에서 온다.
//   seg 에서 오는 것은 **마스크 하나뿐**이다. 둘을 잇는 것이 `associateDetSeg`(이번 작업의 유일한 신규 알고리즘).
//
// 추정 수학 **신규 0줄** — `buildVehicleCuboids` / `computeAnchorMetrics` / `filterVehiclesOnPlace` /
//   `VpdClient.segment` 를 **한 줄도 안 고치고** 그대로 호출한다.
//
// 🔴 **throw 총 0건.** 정밀수집 잡이 이 함수 때문에 죽는 일은 없어야 한다(마스터 §5) — seg 실패·마스크 부재·
//   지면모델 없음은 전부 **강등**(육면체 없이 통과)이고 사유는 `issues[]` 로 드러난다(조용한 실패 금지).

import { buildVehicleCuboids, type SegVehicle } from './contact.js';
import { computeAnchorMetrics } from './anchor.js';
import { associateDetSeg, DEFAULT_ASSOC_OPTIONS, type AssocPair } from './segAssoc.js';
import { DEFAULT_ANCHOR_OPTIONS, DEFAULT_CONTACT_OPTIONS } from './contactTypes.js';
import { isVehicleOnPlace } from '../capture/onPlaceFilter.js';
import type { AnchorMetrics, Px, RejectedVehicle, VehicleCuboid } from './contactTypes.js';
import type { GroundModel } from './types.js';
import type { VpdClient } from '../clients/VpdClient.js';
import type { NormalizedPolygon, VehicleBox } from '../domain/types.js';
import { logger } from '../util/logger.js';

/** 프리셋별 육면체 산출 문맥(지면모델 + 슬롯). 라우트/잡이 해결해서 넘긴다 — 이 함수는 파일 IO 를 하지 않는다. */
export interface CuboidContext {
  model: GroundModel;
  /** 슬롯 폴리곤(**원본 픽셀** — 지면모델은 원본 픽셀에서만 성립한다). */
  slotPolysPx: Px[][];
  slotWidthM: number;
  slotDepthM: number;
}

/** 미정합 det(육면체 없이 통과) — **사유가 관측 가능하다**. 조용히 버리지 않는다. */
export interface UnmatchedDet {
  detIdx: number;
  bestIou: number;
  reason: string;
}

export interface FrameCuboids {
  imgW: number;
  imgH: number;
  /** ⚠️ `VehicleCuboid.vpdIdx` = **det(권위) 검출 인덱스**. 원본 마스크로 되짚는 키는 `assoc[].segIdx` 다. */
  cuboids: VehicleCuboid[];
  rejected: RejectedVehicle[];
  unmatched: UnmatchedDet[];
  /**
   * det↔seg 매핑(원본 되짚기 유일 키).
   *
   * ★ `segIdx` 는 **seg 응답 원문의 검출 인덱스**다 — `masks[segIdx]` / `bboxes[segIdx]` 로 바로 간다.
   *   ⚠️ `VpdClient.segment()` 는 **마스크 없는 검출을 drop** 하므로 `seg.boxes` 배열 위치는 원문 인덱스와 **어긋난다**
   *     (`maskMismatch > 0` 일 때). 그래서 출력 경계에서 `SegBox.vpdIdx`(원문 키)로 **되돌려서** 싣는다.
   *     내부 계산은 압축 배열 위치를 쓰지만, **payload 로 나가는 값은 언제나 원문 인덱스**다.
   *   (D-3 의 재발이었다 — QA 가 잡았다. 실측 3프레임이 maskDrop=0 이라 드러나지 않았다.)
   */
  assoc: AssocPair[];
  anchor: AnchorMetrics;
  summary: {
    /** 두 모델의 검출 개수 — **다를 수 있다**(다른 모델·다른 NMS). */
    detCount: number;
    segCount: number;
    /** 주차면 필터(det 권위 목록 기준). */
    kept: number;
    filteredOut: number;
    matched: number;
    unmatchedDet: number;
    segOnly: number;
    cuboidCount: number;
    rejectedCount: number;
    segDegraded: boolean;
    maskMismatch: number;
    /** 성능 실측(설계 §7) — 추측 금지. */
    segMs: number;
    buildMs: number;
  };
  issues: string[];
  /**
   * ★ seg **호출 자체가 실패**했을 때의 사유(타임아웃·네트워크·5xx). 없으면 undefined.
   *
   * ⚠️ 이 필드가 있는 이유 — **두 소비자의 실패 의미가 다르다**(구현 중 발견, 설계에 없던 구분):
   *   · `CaptureJob`(백그라운드) — seg 가 죽어도 **수집은 계속돼야 한다** → 강등하고 무시한다. 잡 사망 절대 금지.
   *   · `GET /capture/vehicle-cuboids`(요청-응답) — 사용자가 **육면체를 달라고** 물은 라우트다.
   *     VPD 에 닿지도 못했는데 `200 OK + 빈 배열` 을 주면 **하드 실패를 조용히 숨기는 것**이다 → 라우트는 **502**.
   *   (검출 0대로 인한 HTTP 500(S-1)은 실패가 아니라 정상 강등이다 → `summary.segDegraded` 로 구분된다.)
   * → 그래서 `buildFrameCuboids` 는 **throw 하지 않고**(잡 보호) 실패를 **데이터로 드러낸다**(라우트가 판단).
   */
  segError?: string;
  /**
   * ⚠️ **항상 true — 끌 수 없다.** 배치(X,Y) 정확도를 재는 정량 지표가 **없고**(D-1: 자기참조 잔차뿐),
   * L·H 는 **항상 차종 prior**(원리적 관측 불가). 화면이 이것을 배지로 드러내야 한다(정본 §9-1).
   */
  estimateUnverified: true;
  /**
   * ★ 시각화 전용(가산·옵셔널). **on-place seg 마스크 전부**(정규화 폴리곤) — VPD on-place 방식, 육면체 정합과 무관.
   *   seg 박스에 VPD det 과 동일한 on-place 필터(`isVehicleOnPlace`)를 직접 적용한다(마스터 요구, 설계 반전).
   *   육면체 정합(IoU≥0.4·1:1)에 묶으면 병합/밀착 차 마스크가 탈락해 요구 미충족 → on-place seg 직접 필터로 전환.
   *   강등(seg 호출 前) → 필드 없음. 점유·육면체 산출 로직은 이 필드를 읽지 않는다(순수 표시).
   */
  masks?: NormalizedPolygon[];
}

export interface BuildFrameCuboidsArgs {
  jpeg: Buffer;
  /** ★ 권위 — 점유 판정이 쓰는 **바로 그 det 배열**(주차면 필터 **전** 전량). 읽기 전용. */
  detBoxes: readonly VehicleBox[];
  /** 주차면 필터를 통과한 det 인덱스. 미지정 → 전량(필터 off 경로). */
  keptDetIdx?: readonly number[];
  vpd: Pick<VpdClient, 'segment' | 'canSegment'>;
  /** null → 육면체 미산출 + issue. **throw 금지.** */
  ctx: CuboidContext | null;
}

const emptyAnchor = (): AnchorMetrics => ({ depthDevM: null, phaseDevM: null, unmatchedRate: null, n: 0, issues: [] });

/**
 * 강등 응답(육면체 없이 통과). 잡·검출 어느 쪽도 죽지 않는다.
 *
 * ★ 불변식 유지(OBS-1): `unmatched.length === summary.unmatchedDet`.
 *   예전에는 `unmatchedDet = kept` 인데 `unmatched[] = []` 라서 **정상 경로의 불변식이 강등 경로에서만 깨졌다**
 *   (소비자가 "미정합 2대"를 보고 목록을 열면 비어 있었다). 강등 사유를 **차량마다** 채워 넣는다.
 */
function degraded(args: {
  imgW: number;
  imgH: number;
  detCount: number;
  keptIdx: readonly number[];
  filteredOut: number;
  issues: string[];
  segDegraded?: boolean;
  segMs?: number;
  segError?: string;
}): FrameCuboids {
  const reason = args.issues[args.issues.length - 1] ?? '육면체 미산출(강등)';
  return {
    ...(args.segError ? { segError: args.segError } : {}),
    imgW: args.imgW,
    imgH: args.imgH,
    cuboids: [],
    rejected: [],
    // 강등돼도 **어떤 차량이 왜 육면체를 못 받았는지** 드러난다(조용한 실패 금지).
    unmatched: args.keptIdx.map((detIdx) => ({ detIdx, bestIou: 0, reason })),
    assoc: [],
    anchor: emptyAnchor(),
    summary: {
      detCount: args.detCount,
      segCount: 0,
      kept: args.keptIdx.length,
      filteredOut: args.filteredOut,
      matched: 0,
      unmatchedDet: args.keptIdx.length,
      segOnly: 0,
      cuboidCount: 0,
      rejectedCount: 0,
      segDegraded: args.segDegraded ?? false,
      maskMismatch: 0,
      segMs: args.segMs ?? 0,
      buildMs: 0,
    },
    issues: args.issues,
    estimateUnverified: true,
  };
}

/**
 * det(권위) + seg(마스크) → 차량 육면체. 파이프라인은 기존 [0]~[9] **앞에 [−1] 정합만** 추가한 것이다.
 *
 * ```
 * [-1] associateDetSeg()      ★ 신규 — det bbox(권위) ↔ seg rect. 1:1.
 * [0]  vpd.segment()          기존 — 마스크를 얻기 위한 **추가 호출**(det 는 이미 호출됨)
 * [1]~[8] buildVehicleCuboids 기존 — 0줄 변경
 * [9]  computeAnchorMetrics   기존 — 0줄 변경
 * ```
 */
export async function buildFrameCuboids(args: BuildFrameCuboidsArgs): Promise<FrameCuboids> {
  const { detBoxes, ctx, vpd } = args;
  const detCount = detBoxes.length;

  // ★ `keptDetIdx` 검증 — **위반을 조용히 삼키지 않는다**(DEFECT-2. 팀 규약 "조용한 실패 금지").
  //   호출측은 `raw.indexOf(v)` (참조 동일성)로 이 배열을 만든다. 그 전제는 현재 참이지만
  //   (`filterVehiclesOnPlace` = Array.filter → 참조 보존), **누군가 필터에 복사를 끼워넣으면 조용히 깨진다.**
  //   예전 코드는 `.filter((i) => i >= 0)` 로 -1 을 **버려서** `cuboids:[]` + `issues:[]` 가 됐다 —
  //   운영자는 빈 오버레이만 보고 **사유를 볼 수 없었다**. 이제 사유가 payload 에 뜬다.
  const keptRaw = args.keptDetIdx ? [...args.keptDetIdx] : detBoxes.map((_, i) => i);
  const keptIdx = keptRaw.filter((i) => Number.isInteger(i) && i >= 0 && i < detCount);
  const preIssues: string[] = [];
  const badKept = keptRaw.length - keptIdx.length;
  if (badKept > 0) {
    const why =
      `keptDetIdx 해석 실패 ${badKept}건 — 주차면 필터가 det 객체 **참조를 보존하지 않는다**(indexOf → -1). ` +
      `해당 차량은 육면체를 만들지 못한다(점유 판정은 무영향).`;
    preIssues.push(why);
    logger.warn({ cat: 'ground', badKept, detCount }, why);
  }

  const filteredOut = detCount - keptIdx.length;
  const imgW = ctx?.model.imgW ?? 0;
  const imgH = ctx?.model.imgH ?? 0;
  const deg = (issue: string): FrameCuboids =>
    degraded({ imgW, imgH, detCount, keptIdx, filteredOut, issues: [...preIssues, issue] });

  if (!ctx) return deg('지면모델/슬롯 없음 — 육면체 미산출');
  if (!vpd.canSegment()) return deg('VPD seg 미배선(vpd.segPath 없음) — 육면체 미산출');
  if (ctx.slotPolysPx.length === 0) return deg('슬롯 폴리곤 0개 — yaw prior 불가, 육면체 미산출');

  // [0] seg 호출. 500(검출 0대·S-1)은 VpdClient 가 이미 빈 결과로 강등한다. 그 외 실패는 **여기서 흡수**한다
  //     (신규 방어 — 정밀수집 잡을 절대 죽이지 않는다).
  const t0 = Date.now();
  let seg: Awaited<ReturnType<VpdClient['segment']>>;
  try {
    seg = await vpd.segment(args.jpeg);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return degraded({
      imgW, imgH, detCount, keptIdx, filteredOut,
      issues: [...preIssues, `VPD seg 호출 실패 — 육면체 미산출(강등): ${msg}`],
      segMs: Date.now() - t0,
      segError: msg, // ★ 라우트는 이걸 보고 502 를 낸다 / 잡은 무시하고 계속 돈다(위 필드 주석).
    });
  }
  const segMs = Date.now() - t0;
  const model = ctx.model;
  const issues: string[] = [...preIssues, ...model.issues];
  if (seg.segDegraded) issues.push('VPD seg HTTP 500(검출 0대 — S-1) — 육면체 미산출(강등)');
  if (seg.maskMismatch > 0) issues.push(`VPD seg 마스크/bbox 짝 불일치 ${seg.maskMismatch}건 — 해당 차량 정합 후보에서 제외`);

  const tBuild = Date.now();

  // [−1] ★ 정합 — det bbox(권위) ↔ seg rect. 정규화 좌표에서 직접 IoU(A1: 두 응답의 정규화 기준이 같다).
  const segBoxes = seg.boxes; // 마스크 유효분만(VpdClient 가 이미 drop).
  const a = associateDetSeg(detBoxes.map((b) => b.rect), segBoxes.map((b) => b.rect), DEFAULT_ASSOC_OPTIONS);

  // 정합 결과 → SegVehicle 조립. **cls·confidence·bbox 는 det(권위) / mask 만 seg**(설계 §2-2).
  const px = (p: { x: number; y: number }): Px => ({ x: p.x * model.imgW, y: p.y * model.imgH });
  const segByDet = new Map(a.pairs.map((p) => [p.detIdx, p.segIdx]));

  const vehicles: SegVehicle[] = [];
  const unmatched: UnmatchedDet[] = [];
  for (const detIdx of keptIdx) {
    const segIdx = segByDet.get(detIdx);
    if (segIdx === undefined) {
      const best = a.bestIouByDet[detIdx] ?? 0;
      // ⚠️ 세 사유를 **정확히** 구분한다. "IoU 0.428 < 임계 0.4" 같은 **거짓 문장을 쓰지 않는다** —
      //   이 문자열이 운영자가 미정합을 이해하는 유일한 표면이다(실제로 한 번 틀린 문장을 냈다가 잡았다).
      const reason =
        best === 0
          ? 'seg 후보 0 — seg 모델이 이 차량을 못 봄(육면체 없이 통과)'
          : best < DEFAULT_ASSOC_OPTIONS.minIou
            ? `seg 최고 IoU ${best.toFixed(3)} < 임계 ${DEFAULT_ASSOC_OPTIONS.minIou} — 마스크 파편화/병합 의심(육면체 없이 통과)`
            : `1:1 경합 패배 — 최고 IoU ${best.toFixed(3)}(임계 이상)인 seg 를 **다른 det 이 더 높은 IoU 로 가져갔다**. ` +
              `det 두 대가 같은 마스크를 다툰다 = 마스크 병합 의심(육면체 없이 통과)`;
      unmatched.push({ detIdx, bestIou: best, reason });
      continue;
    }
    const d = detBoxes[detIdx];
    vehicles.push({
      vpdIdx: detIdx, // ★ **det(권위) 검출 인덱스.** 점유 판정이 쓰는 그 배열로 되짚는다.
      mask: segBoxes[segIdx].mask!.map(px), // seg 의 존재 이유 — 이것만 seg 에서 온다.
      cls: d.cls,
      confidence: d.confidence,
      bboxPx: {
        x1: d.rect.x * model.imgW,
        y1: d.rect.y * model.imgH,
        x2: (d.rect.x + d.rect.w) * model.imgW,
        y2: (d.rect.y + d.rect.h) * model.imgH,
      },
    });
  }

  // ⚠️ 가림 배제([2])는 **필터 전 전량 + seg-only 마스크까지** 쓴다(리더 승인 Q3).
  //   가림은 **실루엣의 물리적 성질**이지 det 권위와 무관하다 — 앞차가 뒷차 발을 가리면, 그 앞차가 det 에 없어도 **가린다**.
  //   occluder 는 오염된 접지열을 **제거만** 하고 육면체를 **만들 수 없다** → "det 가 권위"를 위반할 수 없다.
  //   자기 자신 제외는 `buildVehicleCuboids` 가 **참조 동일성**으로 한다 → 정합된 차량의 마스크는 vehicles 의 배열을 그대로 넣는다.
  const maskByDet = new Map(vehicles.map((v) => [v.vpdIdx, v.mask]));
  const occluderMasks: Px[][] = [];
  for (const p of a.pairs) {
    const own = maskByDet.get(p.detIdx);
    // 필터로 빠진 차(주차면 밖 통행차)도 **가리기는 한다** → 필터 전 전량을 넣는다.
    occluderMasks.push(own ?? segBoxes[p.segIdx].mask!.map(px));
  }
  for (const j of a.unmatchedSeg) occluderMasks.push(segBoxes[j].mask!.map(px)); // seg-only 도 occluder(Q3).

  const built = buildVehicleCuboids({
    vehicles,
    occluderMasks,
    slotPolysPx: ctx.slotPolysPx,
    ground: model,
    slotWidthM: ctx.slotWidthM,
    slotDepthM: ctx.slotDepthM,
    opts: DEFAULT_CONTACT_OPTIONS,
  });
  const anchor = computeAnchorMetrics(built.cuboids, ctx.slotPolysPx, model, built.axes, {
    ...DEFAULT_ANCHOR_OPTIONS,
    periodM: ctx.slotWidthM,
  });
  issues.push(...built.issues);

  // ★ 마스크 surface — **on-place seg 마스크 전부**(VPD on-place 방식, 육면체 정합과 무관).
  //   ⚠️ 반전 근거: 이전엔 육면체 정합(a.pairs, IoU≥0.4·1:1)에 묶었으나, 병합/밀착 차의 마스크가
  //      경합·저IoU 로 탈락해 "VPD 박스 있는 곳에 마스크 모두"라는 마스터 요구를 못 채웠다(실측 seg6→masks4).
  //      → det 정합·keptIdx 를 버리고 seg 박스에 **VPD 와 동일한 on-place 필터**(isVehicleOnPlace)를 직접 적용한다.
  //   `normSlotPolys` = ctx.slotPolysPx(픽셀)를 정규화 — captureRoutes 의 det on-place 필터와 **동일 폴리곤·동일 정규화**.
  const normSlotPolys = ctx.slotPolysPx.map((poly) => poly.map((p) => ({ x: p.x / model.imgW, y: p.y / model.imgH })));

  return {
    imgW: model.imgW,
    imgH: model.imgH,
    cuboids: built.cuboids,
    rejected: built.rejected,
    unmatched,
    // ★ DEFECT-1 — **출력 경계에서 원문 인덱스로 되돌린다.**
    //   `a.pairs[].segIdx` 는 `segBoxes`(= 마스크 drop 후 **압축** 배열)의 위치다. 그대로 내보내면
    //   `maskMismatch > 0` 일 때 소비자의 `masks[segIdx]` 가 **엉뚱한 차량**을 가리킨다(D-3 의 재발).
    //   `SegBox.vpdIdx` 가 바로 그 원문 키다 — 손에 쥐고도 안 쓰고 있었다.
    //   ⚠️ 내부 계산(`segByDet` · `occluderMasks`)은 `segBoxes` 를 인덱싱하므로 **압축 위치를 그대로 써야 한다.**
    //      되돌리는 것은 **payload 로 나가는 이 한 곳뿐**이다.
    assoc: a.pairs.map((p) => ({ ...p, segIdx: segBoxes[p.segIdx].vpdIdx })),
    anchor,
    summary: {
      detCount,
      segCount: segBoxes.length,
      kept: keptIdx.length,
      filteredOut,
      matched: vehicles.length,
      unmatchedDet: unmatched.length,
      segOnly: a.unmatchedSeg.length,
      cuboidCount: built.cuboids.length,
      rejectedCount: built.rejected.length,
      segDegraded: seg.segDegraded,
      maskMismatch: seg.maskMismatch,
      segMs,
      buildMs: Date.now() - tBuild,
    },
    issues,
    estimateUnverified: true,
    // ★ 시각화용 — on-place seg 마스크 전부(VPD on-place 방식). 육면체 정합·keptIdx 무관 = 병합/밀착 차도 표시.
    //   옵셔널 타입 방어로 filter. 강등 경로(degraded)엔 넣지 않는다(필드 부재).
    masks: segBoxes
      .filter((b) => isVehicleOnPlace(b.rect, normSlotPolys))
      .map((b) => b.mask)
      .filter((m): m is NormalizedPolygon => !!m),
  };
}
