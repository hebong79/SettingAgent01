// place.* 승격 서비스 — 주차면 ROI **단건 편집·자동보정 적용·되돌리기**(설계서 §7-1·2·3 / 다이어그램 §4-2).
// REST 에 대응 라우트가 **없는** 기능만 여기에 있다(있는 것은 브리지가 위임한다 — 이중구현 금지).
//
// 안전 규약(다이어그램 §8) — 모든 쓰기가 동일:
//   1) 정본 읽기(원문 문자열 보관)  2) 순수 편집(placeRoiEdit)  3) `.bak` 기록  4) 정본 쓰기
//   5) 쓰기 실패 시 `.bak` 에서 복원 시도 → 응답에 `backupFile` 을 실어 `place.revert` 로 되돌릴 수 있게 한다.
// `.bak` 명명·쓰기 순서는 `groundGridRoutes.apply` 가 이미 쓰는 검증된 규약을 그대로 따른다(신규 규약 0).

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { z } from 'zod';
import { normalizePtzCamRoi, applyPlaceRoiUpdateEx, type PlaceRoiSpace } from '../../capture/placeRoi.js';
import { backupPlaceRoiPathOf, fileNameOf } from '../../capture/placeRoiPaths.js';
import {
  appendSpace,
  clearPresetSpaces,
  clearSpaceGeometry,
  removeSpace,
  totalSpaces,
  transformPresetSpaces,
  updateSpace,
  type PresetSpaceMap,
} from '../../capture/placeRoiEdit.js';
import { stringify5 } from '../../util/round.js';
import { RpcCode, RpcMethodError } from '../errors.js';
import type { RpcContext } from '../types.js';

const PointSchema = z.object({ x: z.number(), y: z.number() });
const TargetSchema = z.object({
  camId: z.number().int().positive(),
  presetIdx: z.number().int().positive(),
  /** 동시 편집 가드(옵셔널) — 호출자가 본 **전체 면 수**. 다르면 -32005 + 파일 무변경. */
  expectTotal: z.number().int().nonnegative().optional(),
});

export const PlaceSpaceAddSchema = TargetSchema.extend({ points: z.array(PointSchema).min(3) });
export const PlaceSpaceUpdateSchema = TargetSchema.extend({
  idx: z.number().int().positive(),
  points: z.array(PointSchema).min(3),
});
export const PlaceSpaceDeleteSchema = TargetSchema.extend({
  idx: z.number().int().positive(),
  /** clear=기하만 비움(전역번호 보존·기본) / remove=엔트리 제거 + 1..N 재압축(DB 재구성 필요). */
  mode: z.enum(['clear', 'remove']).default('clear'),
});
export const PlacePresetClearSchema = TargetSchema.extend({
  confirm: z.literal(true),
  mode: z.enum(['clear', 'remove']).default('clear'),
});
export const PlaceAlignApplySchema = z.object({
  cam: z.number().int().positive(),
  preset: z.number().int().positive(),
  dx: z.number(),
  dy: z.number(),
  scale: z.number().positive(),
});
export const PlaceRevertSchema = z.object({ backupFile: z.string().min(1) });

/** 재압축(remove) 시 동반하는 경고 — 전역번호가 바뀌면 DB 귀속이 어긋난다. 조용히 넘기지 않는다. */
const RENUMBER_WARNING =
  '전역번호가 1..N 으로 재압축되었습니다 — slot.roi.load{confirm} 로 DB(slot_setup)를 재구성해야 검출·점유·센터라이징 귀속이 맞습니다';

/** placeRoiFile 미설정 → UNAVAILABLE(기능 미배선, 기존 라우트의 404 'place-roi 미설정' 과 같은 의미). */
function fileOf(ctx: RpcContext): string {
  const f = ctx.deps.placeRoiFile;
  if (!f) throw new RpcMethodError(RpcCode.UNAVAILABLE, 'place-roi 미설정');
  return f;
}

interface LoadedPlace {
  file: string;
  raw: string;
  json: unknown;
  byPreset: PresetSpaceMap;
}

async function loadPlace(ctx: RpcContext): Promise<LoadedPlace> {
  const file = fileOf(ctx);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw e.code === 'ENOENT'
      ? new RpcMethodError(RpcCode.NOT_FOUND, 'PtzCamRoi.json 없음', { file: fileNameOf(file) })
      : new RpcMethodError(RpcCode.INTERNAL, 'place-roi 읽기 실패', { detail: e.message });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new RpcMethodError(RpcCode.INTERNAL, 'place-roi 파싱 실패', { detail: (err as Error).message });
  }
  return { file, raw, json, byPreset: normalizePtzCamRoi(json).byPreset };
}

/** 동시 편집 가드 — 호출자가 본 전체 면 수와 다르면 **쓰기 전에** 끊는다(파일 무변경). */
function guardTotal(loaded: LoadedPlace, expectTotal?: number): void {
  if (expectTotal === undefined) return;
  const actual = totalSpaces(loaded.byPreset);
  if (actual !== expectTotal) {
    throw new RpcMethodError(
      RpcCode.CONFLICT,
      '전체 주차면 개수 불일치 — 저장하지 않음(다른 곳에서 파일이 바뀌었습니다)',
      { expected: expectTotal, actual },
    );
  }
}

/**
 * 변경된 프리셋 키들을 정본 JSON 에 반영하고 `.bak` → 정본 순으로 기록한다.
 * 재압축이 일어나면 **모든 키**를 함께 써야 한다(한 프리셋만 쓰면 파일이 혼합번호가 되어
 * 다음 로드에서 번호가 밀린다 — 2026-07-28 ROIMaker `markAllDirty` 교훈).
 */
async function writePlace(
  loaded: LoadedPlace,
  next: PresetSpaceMap,
  keys: string[],
): Promise<{ backupFile: string; issues: string[] }> {
  let json = loaded.json;
  const issues: string[] = [];
  for (const key of keys) {
    const [camId, presetIdx] = key.split(':').map(Number);
    const spaces: PlaceRoiSpace[] = next.get(key) ?? [];
    const r = applyPlaceRoiUpdateEx(json, { camId, presetIdx, spaces });
    json = r.json;
    issues.push(...r.issues);
  }
  const backupPath = backupPlaceRoiPathOf(loaded.file, new Date().toISOString());
  try {
    await writeFile(backupPath, loaded.raw, 'utf8');
  } catch (err) {
    throw new RpcMethodError(RpcCode.INTERNAL, '백업 실패 — 정본 무변경', { detail: (err as Error).message });
  }
  try {
    await writeFile(loaded.file, stringify5(json, 2), 'utf8');
  } catch (err) {
    let restored = true;
    try {
      await writeFile(loaded.file, loaded.raw, 'utf8');
    } catch {
      restored = false;
    }
    throw new RpcMethodError(
      RpcCode.INTERNAL,
      restored ? '정본 갱신 실패 — 백업에서 복원됨' : '정본 갱신 실패 — 자동 복원도 실패',
      { backupFile: fileNameOf(backupPath), detail: (err as Error).message },
    );
  }
  return { backupFile: fileNameOf(backupPath), issues };
}

/** 전역 재압축이 일어난 경우: 전 키를 쓴다. 아니면 대상 키만. */
function keysToWrite(before: PresetSpaceMap, after: PresetSpaceMap, targetKey: string): string[] {
  const renumbered = [...after.keys()].some((k) => {
    const a = before.get(k) ?? [];
    const b = after.get(k) ?? [];
    return k !== targetKey && (a.length !== b.length || a.some((sp, i) => sp.idx !== b[i]?.idx));
  });
  return renumbered ? [...new Set([...before.keys(), ...after.keys()])] : [targetKey];
}

export const PlaceSpacesListSchema = z
  .object({
    camId: z.number().int().positive().optional(),
    presetIdx: z.number().int().positive().optional(),
  })
  .default({});

/**
 * place.spaces.list — **정규화된**(0~1) 주차면 목록. `place.get`(raw JSON 서빙)과 달리
 * 서버가 `normalizePtzCamRoi` 를 적용해 돌려준다 — 외부 제어자가 픽셀↔정규화 변환을 재구현할 필요가 없다
 * (그 변환을 클라가 재구현하던 것이 좌표 규약이 갈리는 출발점이었다).
 */
export async function placeSpacesList(raw: unknown, ctx: RpcContext): Promise<unknown> {
  const p = PlaceSpacesListSchema.parse(raw ?? {});
  const loaded = await loadPlace(ctx);
  const wantKey = p.camId && p.presetIdx ? `${p.camId}:${p.presetIdx}` : null;
  const presets = [...loaded.byPreset.entries()]
    .filter(([key]) => {
      if (wantKey) return key === wantKey;
      if (p.camId) return key.startsWith(`${p.camId}:`);
      return true;
    })
    .map(([key, spaces]) => {
      const [camId, presetIdx] = key.split(':').map(Number);
      return { camId, presetIdx, key, spaces };
    });
  return { presets, total: totalSpaces(loaded.byPreset) };
}

/** place.space.add — 프리셋 끝에 주차면 1개 추가(idx 는 서버가 부여). */
export async function placeSpaceAdd(raw: unknown, ctx: RpcContext): Promise<unknown> {
  const p = PlaceSpaceAddSchema.parse(raw);
  const loaded = await loadPlace(ctx);
  guardTotal(loaded, p.expectTotal);
  const key = `${p.camId}:${p.presetIdx}`;
  const { map, idx } = appendSpace(loaded.byPreset, key, p.points);
  const { backupFile, issues } = await writePlace(loaded, map, [key]);
  return { ok: true, idx, spaceCount: (map.get(key) ?? []).length, total: totalSpaces(map), backupFile, issues };
}

/** place.space.update — 주차면 1개의 좌표 교체(idx 보존). */
export async function placeSpaceUpdate(raw: unknown, ctx: RpcContext): Promise<unknown> {
  const p = PlaceSpaceUpdateSchema.parse(raw);
  const loaded = await loadPlace(ctx);
  guardTotal(loaded, p.expectTotal);
  const key = `${p.camId}:${p.presetIdx}`;
  const { map, hit } = updateSpace(loaded.byPreset, key, p.idx, p.points);
  if (!hit) throw new RpcMethodError(RpcCode.NOT_FOUND, `cam${p.camId} preset${p.presetIdx} 에 idx ${p.idx} 없음`);
  const { backupFile, issues } = await writePlace(loaded, map, [key]);
  return { ok: true, idx: p.idx, total: totalSpaces(map), backupFile, issues };
}

/** place.space.delete — mode=clear(기본·번호보존) 또는 remove(재압축). */
export async function placeSpaceDelete(raw: unknown, ctx: RpcContext): Promise<unknown> {
  const p = PlaceSpaceDeleteSchema.parse(raw);
  const loaded = await loadPlace(ctx);
  guardTotal(loaded, p.expectTotal);
  const key = `${p.camId}:${p.presetIdx}`;
  const r = p.mode === 'remove' ? removeSpace(loaded.byPreset, p.idx) : clearSpaceGeometry(loaded.byPreset, key, p.idx);
  if (!r.hit) throw new RpcMethodError(RpcCode.NOT_FOUND, `idx ${p.idx} 없음`);
  const keys = keysToWrite(loaded.byPreset, r.map, key);
  const { backupFile, issues } = await writePlace(loaded, r.map, keys);
  return {
    ok: true,
    mode: p.mode,
    idx: p.idx,
    total: totalSpaces(r.map),
    backupFile,
    issues: p.mode === 'remove' ? [...issues, RENUMBER_WARNING] : issues,
  };
}

/** place.preset.clear — 한 프리셋의 주차면 전부 삭제(confirm 필수). */
export async function placePresetClear(raw: unknown, ctx: RpcContext): Promise<unknown> {
  const p = PlacePresetClearSchema.parse(raw);
  const loaded = await loadPlace(ctx);
  guardTotal(loaded, p.expectTotal);
  const key = `${p.camId}:${p.presetIdx}`;
  const before = loaded.byPreset.get(key) ?? [];
  if (before.length === 0) throw new RpcMethodError(RpcCode.NOT_FOUND, `cam${p.camId} preset${p.presetIdx} 에 지울 주차면이 없음`);
  let map: PresetSpaceMap;
  let removed: number;
  if (p.mode === 'remove') {
    const r = clearPresetSpaces(loaded.byPreset, key);
    map = r.map;
    removed = r.removed;
  } else {
    map = loaded.byPreset;
    for (const sp of before) map = clearSpaceGeometry(map, key, sp.idx).map;
    removed = before.length;
  }
  const keys = keysToWrite(loaded.byPreset, map, key);
  const { backupFile, issues } = await writePlace(loaded, map, keys);
  return {
    ok: true,
    mode: p.mode,
    cleared: removed,
    total: totalSpaces(map),
    backupFile,
    issues: p.mode === 'remove' ? [...issues, RENUMBER_WARNING] : issues,
  };
}

/**
 * place.align.apply — `place.align.estimate`(=POST /capture/autocorrect)가 준 오프셋을
 * 해당 프리셋 주차면 전체에 적용해 정본에 저장한다.
 * 지금까지 이 **적용 계산은 브라우저에만** 있었다(`web/app.js:alignRun` → `transformPlaceRoiPreset`).
 */
export async function placeAlignApply(raw: unknown, ctx: RpcContext): Promise<unknown> {
  const p = PlaceAlignApplySchema.parse(raw);
  const loaded = await loadPlace(ctx);
  const key = `${p.cam}:${p.preset}`;
  const spaces = loaded.byPreset.get(key);
  if (!spaces?.length) throw new RpcMethodError(RpcCode.NOT_FOUND, `cam${p.cam} preset${p.preset} 주차면 없음`);
  const next = new Map(loaded.byPreset);
  next.set(key, transformPresetSpaces(spaces, { dx: p.dx, dy: p.dy, scale: p.scale }));
  const { backupFile, issues } = await writePlace(loaded, next, [key]);
  return { ok: true, spaceCount: spaces.length, dx: p.dx, dy: p.dy, scale: p.scale, backupFile, issues };
}

/** place.backups — 되돌릴 수 있는 `.bak` 목록(최신순). 브라우저 메모리에만 있던 undo 스택의 대체물. */
export async function placeBackups(_raw: unknown, ctx: RpcContext): Promise<unknown> {
  const file = fileOf(ctx);
  const name = fileNameOf(file);
  const dir = file.slice(0, file.length - name.length) || '.';
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    throw new RpcMethodError(RpcCode.NOT_FOUND, '디렉터리 조회 실패', { detail: (err as Error).message });
  }
  const backups = entries
    .filter((f) => f.startsWith(`${base}.`) && f.endsWith(`.bak${ext}`))
    .sort()
    .reverse();
  return { backups, count: backups.length };
}

/**
 * place.revert — `.bak` 하나를 정본으로 되돌린다. 되돌리기 **직전 상태도 새 `.bak`** 으로 남긴다
 * (되돌리기를 되돌릴 수 있어야 한다).
 * 경로 주입 방지: 파일명만 받아 정본 디렉터리에서 해석하고, `.bak` 패턴이 아니면 거부한다.
 */
export async function placeRevert(raw: unknown, ctx: RpcContext): Promise<unknown> {
  const p = PlaceRevertSchema.parse(raw);
  const file = fileOf(ctx);
  const name = fileNameOf(file);
  const dir = file.slice(0, file.length - name.length);
  const target = fileNameOf(p.backupFile); // 경로 성분 제거.
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  if (!target.startsWith(`${base}.`) || !target.endsWith(`.bak${ext}`)) {
    throw new RpcMethodError(RpcCode.INVALID_PARAMS, `백업 파일명이 아닙니다: ${target}`);
  }
  let content: string;
  try {
    content = await readFile(`${dir}${target}`, 'utf8');
  } catch (err) {
    throw new RpcMethodError(RpcCode.NOT_FOUND, '백업 파일 없음', { file: target, detail: (err as Error).message });
  }
  let current = '';
  try {
    current = await readFile(file, 'utf8');
  } catch {
    /* 정본이 없으면 되돌리기 직전 백업은 생략(복원 자체는 진행) */
  }
  let preRevert: string | null = null;
  if (current) {
    const p2 = backupPlaceRoiPathOf(file, new Date().toISOString());
    try {
      await writeFile(p2, current, 'utf8');
      preRevert = fileNameOf(p2);
    } catch {
      /* 되돌리기 직전 백업 실패는 강등 — 복원은 계속한다 */
    }
  }
  try {
    await writeFile(file, content, 'utf8');
  } catch (err) {
    throw new RpcMethodError(RpcCode.INTERNAL, '복원 실패', { detail: (err as Error).message });
  }
  return { ok: true, restoredFrom: target, preRevertBackup: preRevert };
}
