// 전역번호 재번호(A안) — slot_ptz.json 리맵. 순수 remap + best-effort 파일 IO 분리.
// slot_ptz 는 DB 로 재생성 불가(plateWidth/converged 가 DB 에 없음) → 파일 읽어 items 리맵 후 rewrite.

import { readFileSync, existsSync } from 'node:fs';
import { writeSlotPtz } from './slotPtzWriter.js';
import { logger } from '../util/logger.js';
import type { SlotPtzArtifact } from './types.js';

/**
 * items[].slotId/globalIdx 만 old→new 로 remap. plateWidth/converged/centered/ptz/camIdx/presetIdx/reason 보존.
 * idMap 에 없는 slotId 항목은 변경 없이 유지(best-effort — 정상적으로는 slot_setup 하위집합이라 전부 커버됨).
 * new globalIdx asc 재정렬. createdAt 은 원본 유지(센터링 데이터 자체는 불변임을 반영).
 */
export function remapSlotPtz(artifact: SlotPtzArtifact, idMap: Map<number, number>): SlotPtzArtifact {
  const items = artifact.items.map((it) => {
    const nid = idMap.get(Number(it.slotId));
    if (nid == null) return it; // 미커버는 그대로(방어)
    return { ...it, slotId: String(nid), globalIdx: nid };
  });
  items.sort((a, b) => (a.globalIdx ?? Infinity) - (b.globalIdx ?? Infinity));
  return { createdAt: artifact.createdAt, items };
}

/**
 * slot_ptz.json 파일을 읽어 remap 후 rewrite(best-effort — 절대 throw 로 라우트 죽이지 않음).
 * 반환: 'written' | 'skipped'(부재/파싱실패). 예외 삼킴(로그만).
 */
export function renumberSlotPtzFile(outFile: string, idMap: Map<number, number>): 'written' | 'skipped' {
  try {
    if (!existsSync(outFile)) return 'skipped';
    const parsed = JSON.parse(readFileSync(outFile, 'utf-8')) as SlotPtzArtifact;
    if (!parsed || !Array.isArray(parsed.items)) return 'skipped';
    writeSlotPtz(remapSlotPtz(parsed, idMap), outFile); // 기존 writer 재사용(stringify5·mkdir).
    return 'written';
  } catch (e) {
    logger.warn({ err: e, outFile }, 'slot_ptz 재번호 리맵 실패(격리)');
    return 'skipped';
  }
}
