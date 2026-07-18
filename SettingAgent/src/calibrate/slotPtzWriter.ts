// slot_ptz.json 펼침·쓰기. Repository(setup_artifact 전용) 비오염 — 별도 writer.
// setup_artifact 는 읽기 전용 입력. 캘리브레이션 대상은 plateRoiByPreset 키마다 1 항목으로 펼친다.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SetupArtifact } from '../domain/types.js';
import type { SlotSetupView } from '../capture/types.js';
import { quadBoundingRect } from '../domain/geometry.js';
import { logger } from '../util/logger.js';
import type { PlateTarget, SlotPtzArtifact } from './types.js';

/**
 * slot_setup → 캘리브레이션 대상 펼침. lpd(LPD OBB) 보유 슬롯만 1 항목씩.
 * globalIdx = 정수 slot_id(항상 존재), presetSlotIdx 는 DB preset_slotidx 그대로(재계산 금지).
 */
export function expandPlateTargetsFromSlotSetup(views: SlotSetupView[]): PlateTarget[] {
  const targets: PlateTarget[] = [];
  for (const v of views) {
    if (v.lpd == null) continue;
    targets.push({
      camIdx: v.camId,
      presetIdx: v.presetId,
      slotId: String(v.slotId),
      globalIdx: v.slotId,
      // 캘리브레이션 내부 math 는 rect 사용 → LPD quad→축정렬 boundingRect 유도.
      plateRoi: quadBoundingRect(v.lpd),
      presetSlotIdx: v.presetSlotIdx,
    });
  }
  return targets;
}

/**
 * @deprecated 센터라이징 소스가 slot_setup 으로 전환됨(expandPlateTargetsFromSlotSetup 사용). artifact 경로 잔존.
 *
 * setup_artifact → 캘리브레이션 대상 펼침. plateRoiByPreset 보유 슬롯 전부,
 * 키(`${camIdx}:${presetIdx}`)마다 1 항목. globalIdx 는 globalIndex 역참조(없으면 null).
 * presetSlotIdx 는 해당 프리셋 coveredSlotIds 순서(1-based, 미포함 시 null).
 */
export function expandPlateTargets(artifact: SetupArtifact): PlateTarget[] {
  // slotId → globalIdx 역참조 맵(설계서 §2: 없으면 null).
  const globalBySlot = new Map<string, number>();
  for (const g of artifact.globalIndex) globalBySlot.set(g.slotId, g.globalIdx);

  // `${camIdx}:${presetIdx}` → coveredSlotIds(프리셋 내 위치 순서) 맵.
  const coveredByPreset = new Map<string, string[]>();
  for (const p of artifact.presets) coveredByPreset.set(`${p.camIdx}:${p.presetIdx}`, p.coveredSlotIds);

  const targets: PlateTarget[] = [];
  for (const slot of artifact.slots) {
    if (!slot.plateRoiByPreset) continue;
    for (const [key, quad] of Object.entries(slot.plateRoiByPreset)) {
      const [camStr, presetStr] = key.split(':');
      const camIdx = Number(camStr);
      const presetIdx = Number(presetStr);
      if (!Number.isInteger(camIdx) || !Number.isInteger(presetIdx)) continue;
      const pos = coveredByPreset.get(key)?.indexOf(slot.slotId) ?? -1;
      if (pos < 0) {
        logger.warn({ slot: slot.slotId, cam: camIdx, preset: presetIdx }, '프리셋 coveredSlotIds 미포함 → presetSlotIdx null');
      }
      targets.push({
        camIdx,
        presetIdx,
        slotId: slot.slotId,
        globalIdx: globalBySlot.get(slot.slotId) ?? null,
        // 캘리브레이션 내부 math 는 rect 사용 → quad→축정렬 boundingRect 유도(기존 zoom/centering 재사용).
        plateRoi: quadBoundingRect(quad),
        presetSlotIdx: pos >= 0 ? pos + 1 : null,
      });
    }
  }
  return targets;
}

/** slot_ptz.json 저장(디렉터리 자동 생성). Repository 미사용 — 별도 파일. */
export function writeSlotPtz(artifact: SlotPtzArtifact, outFile: string): void {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(artifact, null, 2), 'utf-8');
}
