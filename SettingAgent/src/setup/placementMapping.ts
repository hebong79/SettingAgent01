// 슬롯 배치(카메라/프리셋/프리셋내 위치) 수동 변경 — 제출 검증(순수·DOM/DB 무의존).
// 라우트·테스트 공유 단일 게이트. 서버가 정본(클라 검증은 UX용) — renumberMapping 규약 동일.

export interface PlacementEntry {
  slotId: number;
  camId: number;
  presetId: number;
  presetSlotIdx: number;
}

/** 충돌 검사 시드: 제출에 포함되지 않은 기존 행의 현재 배치(삼중키). */
export interface CurrentPlacement {
  slotId: number;
  camId: number;
  presetId: number;
  presetSlotIdx: number | null;
}

export interface PlacementValidation {
  ok: boolean;
  /** 실패 사유(400 노출). */
  error?: string;
}

const tripleKey = (camId: number, presetId: number, idx: number | null): string =>
  `${camId}:${presetId}:${idx ?? 'null'}`;

/**
 * current = 현재 DB slot_setup 전량(배치 3필드). placements = 프론트 제출(부분 갱신 허용).
 * presetKeys = preset_info 에 등록된 `${camId}:${presetId}` 집합(FK 부모 — 없으면 INSERT 가 죽는다).
 *
 * 게이트:
 *  - placements 비어 있지 않음 / slotId 중복 없음 / 전부 현재 DB 에 존재
 *  - (camId,presetId) 가 preset_info 에 등록돼 있음(FK 사전검사 → 500 대신 400)
 *  - 최종 상태의 (cam,preset,slotidx) 삼중키가 고유 — **미제출 행의 현재 배치도 시드로 포함**
 *    (slot_setup UNIQUE(cam_id,preset_id,preset_slotidx) 위반을 트랜잭션 전에 잡는다)
 *
 * ★ preset_slotidx 의 1..M 연속성은 여기서 강제하지 않는다 — DB 제약이 아니고(NULL 허용),
 *   부분 갱신 API 에서 전체 연속성을 요구하면 정상적인 단건 이동이 막힌다. 연속성은 UI 게이트 담당.
 */
export function validateSlotPlacement(
  current: CurrentPlacement[],
  placements: PlacementEntry[],
  presetKeys: Set<string>,
): PlacementValidation {
  if (placements.length === 0) return { ok: false, error: '변경할 배치가 없습니다.' };

  const currentById = new Map(current.map((c) => [c.slotId, c]));
  const seen = new Set<number>();
  for (const p of placements) {
    if (!currentById.has(p.slotId)) {
      return { ok: false, error: `slotId ${p.slotId} 는 현재 슬롯에 없습니다.` };
    }
    if (seen.has(p.slotId)) {
      return { ok: false, error: `slotId ${p.slotId} 가 중복 제출되었습니다.` };
    }
    seen.add(p.slotId);
    if (!presetKeys.has(`${p.camId}:${p.presetId}`)) {
      return {
        ok: false,
        error: `등록되지 않은 카메라·프리셋입니다: cam${p.camId} preset${p.presetId} (preset_info 에 없음)`,
      };
    }
  }

  // 최종 상태 삼중키 고유성 — 미제출 행(현재 배치 유지)을 먼저 시드로 넣는다.
  const used = new Map<string, number>();
  for (const c of current) {
    if (seen.has(c.slotId)) continue; // 제출로 덮어써질 행은 현재값 무시.
    used.set(tripleKey(c.camId, c.presetId, c.presetSlotIdx), c.slotId);
  }
  for (const p of placements) {
    const key = tripleKey(p.camId, p.presetId, p.presetSlotIdx);
    const owner = used.get(key);
    if (owner !== undefined) {
      return {
        ok: false,
        error: `배치 충돌: cam${p.camId} preset${p.presetId} 위치${p.presetSlotIdx} 를 slot ${owner} 와 slot ${p.slotId} 가 함께 사용합니다.`,
      };
    }
    used.set(key, p.slotId);
  }

  return { ok: true };
}
