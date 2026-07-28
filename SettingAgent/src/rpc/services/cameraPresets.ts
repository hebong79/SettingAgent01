// cam.preset.* / cam.gotoPreset 승격 서비스(설계서 §7-7·9).
//
// 현행 `PUT /viewer/api/camerapos` 는 **파일 전체를 통째로** 받는다 — 프리셋 하나를 고치려면
// 클라이언트가 전체 배열을 들고 있어야 한다(웹 클라의 `savePreset`/`deletePreset` 이 그 일을 한다).
// 외부 제어자는 그 배열을 갖고 있지 않으므로 단건 연산이 필요하다.
//
// 정본은 `camerapos.json` 하나다. 읽기·쓰기 모두 기존 단일 구현(parseCameraViews / writeCamerapos)에 위임한다.

import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { parseCameraViews, type CameraView } from '../../setup/mapTargets.js';
import { writeCamerapos } from '../../setup/cameraposWriter.js';
import { callViaHttp } from '../bridge.js';
import { RpcCode, RpcMethodError } from '../errors.js';
import type { RpcContext } from '../types.js';

export const CamPresetUpsertSchema = z.object({
  camIdx: z.number().int().positive(),
  presetIdx: z.number().int().positive(),
  label: z.string().min(1).optional(),
  pan: z.number(),
  tilt: z.number(),
  zoom: z.number(),
});

export const CamPresetDeleteSchema = z.object({
  camIdx: z.number().int().positive(),
  presetIdx: z.number().int().positive(),
});

export const CamGotoPresetSchema = z.object({
  cam: z.number().int().positive(),
  preset: z.number().int().positive(),
  source: z.string().min(1).optional(),
});

function fileOf(ctx: RpcContext): string {
  const f = ctx.deps.cameraposFile;
  if (!f) throw new RpcMethodError(RpcCode.UNAVAILABLE, 'camerapos 파일 미설정');
  return f;
}

/** 현재 프리셋 목록(파일 없음 → 빈 목록. 기존 GET /viewer/api/camerapos 와 동일 강등 규약). */
function loadViews(file: string): CameraView[] {
  if (!existsSync(file)) return [];
  try {
    return parseCameraViews(JSON.parse(readFileSync(file, 'utf-8')));
  } catch {
    return [];
  }
}

/**
 * cam.preset.list — 프리셋 목록.
 *
 * ★ `GET /viewer/api/camerapos` 로 위임하지 **않는다**: 그 라우트는 `viewer.enabled && sources` 일 때만
 *   등록되므로 헤드리스 배포에서는 외부 제어자가 프리셋을 못 읽는다(테스트로 잡힌 결함).
 *   정본은 파일 하나이고 upsert/delete 도 파일을 직접 다루므로, 읽기도 같은 소스를 쓴다.
 */
export async function camPresetList(_raw: unknown, ctx: RpcContext): Promise<unknown> {
  const views = loadViews(fileOf(ctx));
  return { views, count: views.length };
}

/** cam.preset.upsert — (camIdx,presetIdx) 1건 추가/교체 후 전량 저장. */
export async function camPresetUpsert(raw: unknown, ctx: RpcContext): Promise<unknown> {
  const p = CamPresetUpsertSchema.parse(raw);
  const file = fileOf(ctx);
  const views = loadViews(file);
  const at = views.findIndex((v) => v.camIdx === p.camIdx && v.presetIdx === p.presetIdx);
  const entry: CameraView = {
    camIdx: p.camIdx,
    presetIdx: p.presetIdx,
    label: p.label ?? views[at]?.label ?? `Preset ${p.presetIdx}`,
    pan: p.pan,
    tilt: p.tilt,
    zoom: p.zoom,
  };
  const next = at >= 0 ? views.map((v, i) => (i === at ? entry : v)) : [...views, entry];
  writeCamerapos(next, file);
  return { ok: true, action: at >= 0 ? 'updated' : 'created', count: next.length, preset: entry };
}

/** cam.preset.delete — 1건 제거 후 전량 저장. 대상 없으면 NOT_FOUND(무변경). */
export async function camPresetDelete(raw: unknown, ctx: RpcContext): Promise<unknown> {
  const p = CamPresetDeleteSchema.parse(raw);
  const file = fileOf(ctx);
  const views = loadViews(file);
  const next = views.filter((v) => !(v.camIdx === p.camIdx && v.presetIdx === p.presetIdx));
  if (next.length === views.length) {
    throw new RpcMethodError(RpcCode.NOT_FOUND, `cam${p.camIdx} preset${p.presetIdx} 없음`);
  }
  writeCamerapos(next, file);
  return { ok: true, removed: 1, count: next.length };
}

/**
 * cam.gotoPreset — 프리셋의 PTZ 로 **실제 이동**한다.
 *
 * ★ 프리셋 인덱스만 바꾸는 것으로는 카메라가 움직이지 않는다(시뮬레이터는 현재 물리 위치를 계속 렌더한다 —
 *   2026-07-28 ROIMaker 라이브 검증). 그래서 camerapos 의 PTZ 를 찾아 `POST /viewer/api/move` 로 이동시킨다.
 * 이동 자체는 기존 라우트에 위임한다(zoom clamp·allowMove·토큰 게이트를 재구현하지 않는다).
 */
export async function camGotoPreset(raw: unknown, ctx: RpcContext): Promise<unknown> {
  const p = CamGotoPresetSchema.parse(raw);
  const file = fileOf(ctx);
  const hit = loadViews(file).find((v) => v.camIdx === p.cam && v.presetIdx === p.preset);
  if (!hit) throw new RpcMethodError(RpcCode.NOT_FOUND, `camerapos 에 cam${p.cam} preset${p.preset} 없음`);
  if (hit.pan === undefined || hit.tilt === undefined || hit.zoom === undefined) {
    throw new RpcMethodError(RpcCode.CONFLICT, `cam${p.cam} preset${p.preset} 에 PTZ 값이 없습니다`, { preset: hit });
  }
  const moved = await callViaHttp(
    ctx.app,
    {
      method: 'POST',
      url: '/viewer/api/move',
      payload: { cam: p.cam, pan: hit.pan, tilt: hit.tilt, zoom: hit.zoom, ...(p.source ? { source: p.source } : {}) },
    },
    ctx.token,
  );
  return { ok: true, cam: p.cam, preset: p.preset, ptz: { pan: hit.pan, tilt: hit.tilt, zoom: hit.zoom }, moved };
}
