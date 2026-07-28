// setup.mapping.autoNumber 승격 서비스(설계서 §7-5).
//
// 전역번호 자동 부여는 지금까지 브라우저에만 있었다(`web/app.js:autoNumberManual` — 표시 순서대로
// 입력칸에 1..N 을 채운 뒤 사용자가 '저장' 을 눌러야 반영). 외부 제어자는 그 표를 갖고 있지 않다.
//
// 서버 기준 순서 = `slot_setup` 의 `ORDER BY cam_id, preset_id, preset_slotidx`(SqliteStore.getSlotSetup).
// 이는 웹 표의 기본 정렬과 같은 기준이다(카메라 → 프리셋 → 프리셋내 위치).
//
// 실제 재번호는 **기존 라우트**(`POST /mapping/renumber`)에 위임한다 — 검증(validateRenumberMapping)·
// DB 트랜잭션·파일 3종 전파를 재구현하지 않는다.

import { z } from 'zod';
import { callViaHttp } from '../bridge.js';
import { RpcCode, RpcMethodError } from '../errors.js';
import type { RpcContext } from '../types.js';

export const MappingAutoNumberSchema = z
  .object({
    /** 기본 true — 계산 결과만 돌려주고 **아무것도 쓰지 않는다**(파괴적 재번호의 안전 기본값). */
    dryRun: z.boolean().default(true),
  })
  .default({});

export async function mappingAutoNumber(raw: unknown, ctx: RpcContext): Promise<unknown> {
  const p = MappingAutoNumberSchema.parse(raw ?? {});
  const store = ctx.deps.store;
  if (!store) throw new RpcMethodError(RpcCode.UNAVAILABLE, 'sqlite 미배선');

  const rows = store.getSlotSetup(); // cam → preset → presetSlotIdx 정렬(단일 기준).
  if (rows.length === 0) throw new RpcMethodError(RpcCode.CONFLICT, 'slot_setup 비어있음 — ROI 로딩 먼저');

  const mapping = rows.map((r, i) => ({ oldSlotId: r.slotId, newSlotId: i + 1 }));
  const changed = mapping.filter((m) => m.oldSlotId !== m.newSlotId);

  if (changed.length === 0) {
    // 이미 1..N — 재번호를 호출하면 updated_at 만 흔들린다(웹 클라의 "배치 그대로면 건너뛴다" 규약과 동일).
    return { ok: true, dryRun: p.dryRun, total: rows.length, changed: 0, mapping, applied: false };
  }
  if (p.dryRun) {
    return { ok: true, dryRun: true, total: rows.length, changed: changed.length, mapping, applied: false };
  }

  const result = await callViaHttp(
    ctx.app,
    { method: 'POST', url: '/mapping/renumber', payload: { mapping } },
    ctx.token,
  );
  return { ok: true, dryRun: false, total: rows.length, changed: changed.length, applied: true, renumber: result };
}
