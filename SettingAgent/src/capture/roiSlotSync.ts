/**
 * PtzCamRoi.json(바닥 ROI 정본) → slot_setup **차등 동기**(비파괴). ROIMaker 수동 편집 저장 경로.
 *
 * `roiDbLoad.loadRoiIntoDb` 와의 차이 — 이것이 이 모듈의 존재 이유다:
 *   load-roi : `replaceSlotSetup` = DELETE + INSERT 전량 → vpd/lpd/occupy/pan/tilt/zoom/centered/img1/
 *              slot3d_front_center **전량 소실**. 전체 재적재 버튼 전용.
 *   sync-roi : `slot_roi` 만 UPDATE / 신규만 INSERT / 파일에 없는 행은 **삭제하지 않고 보고**.
 *              → 검출·점유·센터링 보존. ROI 손보정이 일상 조작이므로 이쪽이 기본 저장 경로다.
 *
 * 정본은 **파일 하나**다. 클라이언트는 `{}` 로 호출만 하고 DB 조작을 지시하지 않는다.
 *
 * 매칭 키 = `(cam_id, preset_id, preset_slotidx)`.
 *   전제: ROIMaker 는 신규를 배열 **끝에 append** 하고, 삭제는 행 제거가 아니라 **기하 비우기**(points:[])다
 *   → 배열 위치가 편집 중 흔들리지 않는다(설계서 §1.1 #13, §3 D-2).
 *   전제가 깨지면(외부에서 행 제거 등) `slot_id` 불일치로 **0건 반영 + 중단**한다.
 *
 * 안전 규약(roiDbLoad 와 동일 철학): 파일 없음/파싱 실패/유효 주차면 0건/아이덴티티 불일치
 *   → 쓰기를 **아예 하지 않고** { ok:false, error } 반환(DB 무변경).
 */
import { existsSync, readFileSync } from 'node:fs';
import { normalizePtzCamRoi } from './placeRoi.js';
import { buildSlots } from './roiDbLoad.js';
import type { SqliteStore } from './SqliteStore.js';
import type { SlotSetupRow, SlotSetupView } from './types.js';
import { stringify5 } from '../util/round.js';

/** 슬롯 매칭 키 — 배열 위치 기반(설계서 §3 D-2). */
function slotKey(camId: number, presetId: number, presetSlotIdx: number | null): string {
  return `${camId}:${presetId}:${presetSlotIdx ?? ''}`;
}

export interface RoiSlotDiff {
  /** slot_roi 만 바뀐 행(부분 UPDATE 대상). */
  updates: Array<{ slotId: number; slotRoi: string }>;
  /** 파일에만 있는 신규 행(INSERT 대상, enrichment 전부 null). */
  inserts: SlotSetupRow[];
  /** DB 에만 있는 행 — **삭제하지 않고 보고만** 한다. */
  orphans: Array<{ slotId: number; camId: number; presetId: number; presetSlotIdx: number | null }>;
  /** 같은 위치인데 slot_id 가 다른 행 — 아이덴티티 붕괴. 있으면 전량 중단한다. */
  mismatches: Array<{ camId: number; presetId: number; presetSlotIdx: number | null; fileSlotId: number; dbSlotId: number }>;
  /** 변경 없음 행 수(멱등성 지표). */
  unchanged: number;
}

/**
 * 기대 행(파일 파생) vs 현재 행(DB) 차등 계산 — 순수 함수(I/O·throw 없음).
 * `current.roi` 는 파싱된 폴리곤이므로 `stringify5` 로 되돌려 비교한다(DB 쓰기가 항상 stringify5 경유라 안정).
 */
export function diffRoiSlots(expected: SlotSetupRow[], current: SlotSetupView[]): RoiSlotDiff {
  const byKey = new Map<string, SlotSetupView>();
  for (const c of current) byKey.set(slotKey(c.camId, c.presetId, c.presetSlotIdx), c);

  const diff: RoiSlotDiff = { updates: [], inserts: [], orphans: [], mismatches: [], unchanged: 0 };
  const seen = new Set<string>();

  for (const row of expected) {
    const key = slotKey(row.camId, row.presetId, row.presetSlotIdx ?? null);
    seen.add(key);
    const cur = byKey.get(key);
    if (!cur) {
      diff.inserts.push(row);
      continue;
    }
    if (cur.slotId !== row.slotId) {
      diff.mismatches.push({
        camId: row.camId,
        presetId: row.presetId,
        presetSlotIdx: row.presetSlotIdx ?? null,
        fileSlotId: row.slotId,
        dbSlotId: cur.slotId,
      });
      continue;
    }
    if (stringify5(cur.roi) !== row.slotRoi) diff.updates.push({ slotId: row.slotId, slotRoi: row.slotRoi });
    else diff.unchanged++;
  }

  for (const c of current) {
    if (seen.has(slotKey(c.camId, c.presetId, c.presetSlotIdx))) continue;
    diff.orphans.push({ slotId: c.slotId, camId: c.camId, presetId: c.presetId, presetSlotIdx: c.presetSlotIdx });
  }
  return diff;
}

export interface RoiSlotSyncResult {
  ok: boolean;
  updates: number;
  inserts: number;
  unchanged: number;
  orphans: RoiSlotDiff['orphans'];
  issues: string[];
  error?: string;
}

export interface RoiSlotSyncOptions {
  placeRoiFile: string;
  now: string;
}

function fail(error: string, issues: string[] = []): RoiSlotSyncResult {
  return { ok: false, updates: 0, inserts: 0, unchanged: 0, orphans: [], issues, error };
}

/**
 * 정본 파일 → slot_setup 차등 반영. 쓰기 순서는 **INSERT 먼저 → UPDATE 나중**.
 * 근거: 실패 가능성이 있는 쪽(PK/UNIQUE 충돌)을 먼저 실행해, 그 실패가 UPDATE 적용 이후에
 * 발생해 부분 반영으로 남는 것을 막는다(INSERT 실패 시 UPDATE 는 아직 0건).
 */
export function syncRoiToDb(store: SqliteStore, opts: RoiSlotSyncOptions): RoiSlotSyncResult {
  const issues: string[] = [];

  if (!existsSync(opts.placeRoiFile)) return fail(`ROI 파일 없음: ${opts.placeRoiFile} — DB 무변경`);
  let ptzRaw: unknown;
  try {
    ptzRaw = JSON.parse(readFileSync(opts.placeRoiFile, 'utf-8'));
  } catch (err) {
    return fail(`ROI 파일 파싱 실패: ${err instanceof Error ? err.message : String(err)} — DB 무변경`);
  }

  const { byPreset, report } = normalizePtzCamRoi(ptzRaw);
  for (const r of report) {
    for (const msg of r.issues) issues.push(`cam${r.camId}:preset${r.presetIdx} ${msg}`);
  }
  if (byPreset.size === 0) return fail('ROI 파일에 유효한 주차면 없음 — DB 무변경', issues);

  const expected = buildSlots(ptzRaw, opts.now);
  if (expected.length === 0) return fail('생성된 슬롯 0건 — DB 무변경', issues);

  const diff = diffRoiSlots(expected, store.getSlotSetup());

  if (diff.mismatches.length > 0) {
    const head = diff.mismatches
      .slice(0, 5)
      .map((m) => `cam${m.camId}:preset${m.presetId}#${m.presetSlotIdx} 파일=${m.fileSlotId} DB=${m.dbSlotId}`)
      .join(', ');
    return fail(
      `slot_id 아이덴티티 불일치 ${diff.mismatches.length}건 — DB 무변경(전역번호가 재부여된 상태일 수 있음): ${head}`,
      issues,
    );
  }

  for (const o of diff.orphans) {
    issues.push(
      `DB 에만 있는 슬롯 #${o.slotId}(cam${o.camId}:preset${o.presetId}#${o.presetSlotIdx}) — 자동 삭제하지 않음`,
    );
  }

  try {
    const inserted = diff.inserts.length ? store.insertSlotSetupRows(diff.inserts).inserted : 0;
    const changed = diff.updates.length ? store.updateSlotRoiGeometry(diff.updates, opts.now).changed : 0;
    return { ok: true, updates: changed, inserts: inserted, unchanged: diff.unchanged, orphans: diff.orphans, issues };
  } catch (err) {
    return fail(`DB 쓰기 실패: ${err instanceof Error ? err.message : String(err)}`, issues);
  }
}
