// slot_ptz.json 펼침·쓰기. Repository(setup_artifact 전용) 비오염 — 별도 writer.
// setup_artifact 는 읽기 전용 입력. 캘리브레이션 대상은 plateRoiByPreset 키마다 1 항목으로 펼친다.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SetupArtifact } from '../domain/types.js';
import { quadBoundingRect } from '../domain/geometry.js';
import type { PlateTarget, SlotPtzArtifact } from './types.js';

/**
 * setup_artifact → 캘리브레이션 대상 펼침. plateRoiByPreset 보유 슬롯 전부,
 * 키(`${camIdx}:${presetIdx}`)마다 1 항목. globalIdx 는 globalIndex 역참조(없으면 null).
 */
export function expandPlateTargets(artifact: SetupArtifact): PlateTarget[] {
  // slotId → globalIdx 역참조 맵(설계서 §2: 없으면 null).
  const globalBySlot = new Map<string, number>();
  for (const g of artifact.globalIndex) globalBySlot.set(g.slotId, g.globalIdx);

  const targets: PlateTarget[] = [];
  for (const slot of artifact.slots) {
    if (!slot.plateRoiByPreset) continue;
    for (const [key, quad] of Object.entries(slot.plateRoiByPreset)) {
      const [camStr, presetStr] = key.split(':');
      const camIdx = Number(camStr);
      const presetIdx = Number(presetStr);
      if (!Number.isInteger(camIdx) || !Number.isInteger(presetIdx)) continue;
      targets.push({
        camIdx,
        presetIdx,
        slotId: slot.slotId,
        globalIdx: globalBySlot.get(slot.slotId) ?? null,
        // 캘리브레이션 내부 math 는 rect 사용 → quad→축정렬 boundingRect 유도(기존 zoom/centering 재사용).
        plateRoi: quadBoundingRect(quad),
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
