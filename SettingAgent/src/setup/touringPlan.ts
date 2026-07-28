// setup_result → Touring 순회 스텝 배열(순수 · I/O 0). `web/core.js:buildTouringPlan` 의 **자구 포팅본**.
//
// ★ 기준변은 web 쪽이다(실운영에서 검증된 구현) — 서버가 웹을 따라간다. 알고리즘을 "개선"하지 않는다.
//   두 구현의 값 일치는 `test/touringPlanParity.test.ts` 가 toEqual 깊은 비교로 봉인한다
//   (선례: occupancyRegionParity · quadCentroidParity). `src → web` import 는 금지이므로
//   포팅 + 파리티가 유일한 수단이다.
//
// 규칙(웹 주석 계승):
// - preset 스텝: 그룹(camId:presetId) 최초 진입 시 1개. ptz 는 런타임(resolvePresetPtz)이 채우므로 여기선 camId/presetId 만.
// - slot 스텝: centering 3값이 전부 non-null 인 슬롯만. 결손은 스킵(위장 이동 금지)하고 skipped 로 카운트.
// - slots 가 이미 정렬돼 있어도 방어적으로 재정렬한다(결정성).

/** slot 스텝의 목표 PTZ(= 슬롯 centering 값 그대로). */
export interface TourStepPtz {
  pan: number;
  tilt: number;
  zoom: number;
}

/** 순회 스텝 1개. preset 스텝은 {kind,camId,presetId} 만 갖는다(나머지 키 부재 — 웹과 동일 shape). */
export interface TourStep {
  kind: 'preset' | 'slot';
  camId: number;
  presetId: number;
  presetSlotIdx?: number | null;
  slotId?: number;
  ptz?: TourStepPtz;
}

export interface TourPlan {
  steps: TourStep[];
  skipped: number;
}

/** setup_result.slots 원소의 최소 표면. 런타임 파싱본이라 결손을 허용한다(웹과 동일 방어). */
interface TourSlotInput {
  slotId: number;
  camId: number;
  presetId: number;
  presetSlotIdx?: number | null;
  centering?: { pan?: number | null; tilt?: number | null; zoom?: number | null } | null;
}

/**
 * setup_result → {steps, skipped}. `null`/`undefined`/`{}`/비배열 slots 는 `{steps:[],skipped:0}`(throw 없음).
 * 정렬키: camId → presetId → (presetSlotIdx ?? 0) → slotId.
 */
export function buildTouringPlan(setupResult: unknown): TourPlan {
  const raw = (setupResult as { slots?: unknown } | null | undefined)?.slots;
  const slots = Array.isArray(raw) ? (raw as TourSlotInput[]) : [];
  const sorted = [...slots].sort(
    (a, b) =>
      a.camId - b.camId ||
      a.presetId - b.presetId ||
      (a.presetSlotIdx ?? 0) - (b.presetSlotIdx ?? 0) ||
      a.slotId - b.slotId,
  );
  const steps: TourStep[] = [];
  let skipped = 0;
  let curKey: string | null = null;
  for (const s of sorted) {
    const key = `${s.camId}:${s.presetId}`;
    if (key !== curKey) {
      curKey = key;
      steps.push({ kind: 'preset', camId: s.camId, presetId: s.presetId });
    }
    const c = s.centering;
    if (c && c.pan != null && c.tilt != null && c.zoom != null) {
      steps.push({
        kind: 'slot',
        camId: s.camId,
        presetId: s.presetId,
        presetSlotIdx: s.presetSlotIdx ?? null,
        slotId: s.slotId,
        ptz: { pan: c.pan, tilt: c.tilt, zoom: c.zoom },
      });
    } else {
      skipped += 1;
    }
  }
  return { steps, skipped };
}
