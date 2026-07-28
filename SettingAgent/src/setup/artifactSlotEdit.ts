// 셋업 산출물(SetupArtifact) 슬롯 엔트리 편집 — `web/core.js` 4함수의 **자구 포팅**(순수·I/O 0).
//
// ★ 기준변은 항상 `web/core.js` 다(실운영 검증본). 이 파일은 그것을 따라갈 뿐이며,
//   `test/artifactSlotEditParity.test.ts` 가 web↔src 를 `toEqual` 로 봉인한다.
//   창의적 개선·알고리즘 발명 금지 — 값이 갈리면 그건 포팅 오류다.
//
// ★ 이름 주의(리더 결정 Q4): 여기서 말하는 "슬롯 추가/삭제"는 **setup_artifact.json 의 슬롯 엔트리 편집**이다.
//   실제 주차면(공간) 추가는 `place.space.add`(PtzCamRoi.json) + `slot.roi.sync`(DB 차등) 경로다.
//   이 모듈은 DB·ROI 정본을 한 글자도 건드리지 않는다.

import type { GlobalSlotIndex, ParkingSlot, Preset, SetupArtifact } from '../domain/types.js';

/**
 * = `web/core.js:799 rebuildGlobalIndex`.
 * 정렬: camIdx ASC → presetIdx ASC → coveredSlotIds 내 위치 ASC. globalIdx=i+1.
 * coveredSlotIds 에 없는 slot 은 뒤로(안전망, camIdx/presetIdx=0).
 */
export function rebuildGlobalIndex(
  slots: readonly ParkingSlot[] | undefined,
  presets: readonly Preset[] | undefined,
): GlobalSlotIndex[] {
  const slotSet = new Set((slots ?? []).map((s) => s.slotId));
  const ordered: Array<{ slotId: string; camIdx: number; presetIdx: number }> = [];
  const sortedPresets = [...(presets ?? [])].sort(
    (a, b) => a.camIdx - b.camIdx || a.presetIdx - b.presetIdx,
  );
  const placed = new Set<string>();
  for (const p of sortedPresets) {
    for (const id of p.coveredSlotIds ?? []) {
      if (slotSet.has(id) && !placed.has(id)) {
        placed.add(id);
        ordered.push({ slotId: id, camIdx: p.camIdx, presetIdx: p.presetIdx });
      }
    }
  }
  // coveredSlotIds 에 없는 slot(안전망): slots 순으로 뒤에 부여. camIdx/presetIdx 는 미상→0.
  for (const s of slots ?? []) {
    if (!placed.has(s.slotId)) {
      placed.add(s.slotId);
      ordered.push({ slotId: s.slotId, camIdx: 0, presetIdx: 0 });
    }
  }
  return ordered.map((o, i) => ({
    globalIdx: i + 1,
    slotId: o.slotId,
    camIdx: o.camIdx,
    presetIdx: o.presetIdx,
  }));
}

/**
 * = `web/core.js:833 removeSlot`.
 * slotId 슬롯을 slots·각 preset.coveredSlotIds 에서 제거 후 globalIndex 재구성.
 * createdAt 등 나머지 필드 보존. 불변(새 artifact 반환).
 * ★ 없는 slotId 에도 **조용히 통과**한다(웹과 동일) → 호출자가 사전 존재 확인을 해야 한다.
 */
export function removeSlot(artifact: SetupArtifact, slotId: string): SetupArtifact {
  const slots = (artifact.slots ?? []).filter((s) => s.slotId !== slotId);
  const presets = (artifact.presets ?? []).map((p) => ({
    ...p,
    coveredSlotIds: (p.coveredSlotIds ?? []).filter((id) => id !== slotId),
  }));
  const globalIndex = rebuildGlobalIndex(slots, presets);
  return { ...artifact, slots, presets, globalIndex };
}

/**
 * = `web/core.js:848 nextSlotId`.
 * 결번 충돌회피 slotId 생성. (camIdx,presetIdx) 의 기존 sN 최대치+1 부터 시작,
 * 전체 slotId 집합과 충돌 없을 때까지 증가. 형식 `c{cam}p{preset}s{N}`.
 */
export function nextSlotId(artifact: SetupArtifact, camIdx: number, presetIdx: number): string {
  const all = new Set((artifact?.slots ?? []).map((s) => s.slotId));
  const prefix = `c${camIdx}p${presetIdx}s`;
  let max = 0;
  for (const id of all) {
    if (typeof id === 'string' && id.startsWith(prefix)) {
      const n = Number(id.slice(prefix.length));
      if (Number.isInteger(n) && n > max) max = n;
    }
  }
  let n = max + 1;
  while (all.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

/**
 * = `web/core.js:870 insertSlotAt`.
 * 전역 인덱스 기준 중간삽입. newSlot 을 atGlobalIdx(1-based, [1,N+1] clamp) 위치에 꽂고 이후 globalIdx +1.
 * 대상 preset(camIdx,presetIdx: newSlot.roiByPreset 첫 key 파싱)의 coveredSlotIds 말미 append,
 * preset 부재 시 신규 preset push. globalIndex 는 **명시적 splice**(수동 전역위치 보존) —
 * rebuildGlobalIndex 는 coveredSlotIds 정규정렬로 수동 위치를 무시하므로 재사용하지 않는다.
 * 이미 존재하는 slotId 면 no-op(원본 참조 그대로 반환). 불변(새 artifact 반환).
 */
export function insertSlotAt(artifact: SetupArtifact, atGlobalIdx: number, newSlot: ParkingSlot): SetupArtifact {
  const slots = artifact.slots ?? [];
  if (slots.some((s) => s.slotId === newSlot.slotId)) return artifact; // 중복 방어(no-op).
  const key = Object.keys(newSlot.roiByPreset ?? {})[0] ?? '';
  const [kc, kp] = key.split(':').map(Number);
  const camIdx = Number.isFinite(kc) ? (kc as number) : 0;
  const presetIdx = Number.isFinite(kp) ? (kp as number) : 0;

  const nextSlots = [...slots, newSlot]; // slots 배열 순서는 전역순서를 결정하지 않음.

  let found = false;
  const nextPresets = (artifact.presets ?? []).map((p) => {
    if (p.camIdx === camIdx && p.presetIdx === presetIdx) {
      found = true;
      return { ...p, coveredSlotIds: [...(p.coveredSlotIds ?? []), newSlot.slotId] };
    }
    return p;
  });
  if (!found) {
    nextPresets.push({ camIdx, presetIdx, label: `${camIdx}:${presetIdx}`, coveredSlotIds: [newSlot.slotId] });
  }

  const base = [...(artifact.globalIndex ?? [])].sort((a, b) => a.globalIdx - b.globalIdx);
  const pos = Math.min(Math.max(1, atGlobalIdx), base.length + 1) - 1;
  base.splice(pos, 0, { globalIdx: 0, slotId: newSlot.slotId, camIdx, presetIdx });
  const nextGlobal = base.map((g, i) => ({ ...g, globalIdx: i + 1 }));

  return { ...artifact, slots: nextSlots, presets: nextPresets, globalIndex: nextGlobal };
}
