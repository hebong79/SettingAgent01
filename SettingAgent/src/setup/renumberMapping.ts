// 전역번호 재번호(A안) — old→new 매핑 순열 검증(순수·DOM/DB 무의존).
// 라우트·테스트 공유 단일 게이트. 서버가 정본(클라 검증은 UX용).

export interface RenumberEntry {
  oldSlotId: number;
  newSlotId: number;
}

export interface RenumberValidation {
  ok: boolean;
  /** 실패 사유(400 노출). */
  error?: string;
  /** 성공 시 old→new 순열. */
  idMap?: Map<number, number>;
}

/**
 * currentIds = 현재 DB slot_setup 의 slot_id 전량. mapping = 프론트 제출.
 * 순열 게이트(N = currentIds.length):
 *  - N > 0 (빈 DB 재번호 금지)
 *  - mapping.length === N
 *  - oldSlotId 집합 === currentIds 집합(전 행 커버·누락/추가/중복 없음)
 *  - newSlotId 전부 정수 && 집합 === {1..N}(고유 + 1..N 커버)
 * 통과 시 idMap(old→new) 반환. 실패 시 ok:false + 사람이 읽는 error.
 */
export function validateRenumberMapping(currentIds: number[], mapping: RenumberEntry[]): RenumberValidation {
  const n = currentIds.length;
  if (n === 0) return { ok: false, error: '재번호 대상 슬롯이 없습니다(DB slot_setup 비어 있음).' };
  if (mapping.length !== n) {
    return { ok: false, error: `매핑 개수(${mapping.length})가 슬롯 수(${n})와 다릅니다.` };
  }

  // old 집합 == currentIds 집합(전 행 정확히 1회 커버).
  const currentSet = new Set(currentIds);
  if (currentSet.size !== n) {
    return { ok: false, error: 'DB slot_id 에 중복이 있습니다(무결성 위반).' };
  }
  const seenOld = new Set<number>();
  for (const m of mapping) {
    if (!currentSet.has(m.oldSlotId)) {
      return { ok: false, error: `oldSlotId ${m.oldSlotId} 는 현재 슬롯에 없습니다.` };
    }
    if (seenOld.has(m.oldSlotId)) {
      return { ok: false, error: `oldSlotId ${m.oldSlotId} 가 중복되었습니다.` };
    }
    seenOld.add(m.oldSlotId);
  }

  // new 집합 == {1..N}(정수·고유·범위).
  const seenNew = new Set<number>();
  for (const m of mapping) {
    if (!Number.isInteger(m.newSlotId)) {
      return { ok: false, error: `newSlotId ${m.newSlotId} 는 정수가 아닙니다.` };
    }
    if (m.newSlotId < 1 || m.newSlotId > n) {
      return { ok: false, error: `newSlotId ${m.newSlotId} 가 1..${n} 범위를 벗어났습니다.` };
    }
    if (seenNew.has(m.newSlotId)) {
      return { ok: false, error: `newSlotId ${m.newSlotId} 가 중복되었습니다.` };
    }
    seenNew.add(m.newSlotId);
  }

  const idMap = new Map<number, number>();
  for (const m of mapping) idMap.set(m.oldSlotId, m.newSlotId);
  return { ok: true, idMap };
}
