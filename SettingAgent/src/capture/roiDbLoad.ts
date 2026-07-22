/**
 * PtzCamRoi.json(바닥 ROI 정본) → DB(place/camera/preset/slot_setup) 로딩 공용 모듈.
 *
 * 순수 조립(build*)은 이관 CLI(`src/tools/migrateToSettingDb.ts`)와 라우트(`POST /capture/slots/load-roi`)가
 * **같은 함수**를 쓴다(이중구현 금지). 파일 I/O + 안전 규약은 `loadRoiIntoDb` 가 담당.
 *
 * 안전 규약(★ slot_setup 통짜 wipe 방지):
 *   파일 없음 / JSON 파싱 실패 / 유효 주차면 0건 / FK 부모 없는 슬롯 제외 후 0건
 *   → `replaceSlotSetup` 을 **호출하지 않고** { ok:false, error } 반환(기존 slot_setup 무변경).
 */
import { existsSync, readFileSync } from 'node:fs';
import { normalizePtzCamRoi, normalizeGlobalIdx } from './placeRoi.js';
import type { SqliteStore } from './SqliteStore.js';
import type { SetupTarget } from '../setup/SetupOrchestrator.js';
import type { CameraView } from '../setup/mapTargets.js';
import type { CameraInfoRow, PresetPosRow, SlotSetupRow } from './types.js';
import { stringify5 } from '../util/round.js';

export const PLACE_ID = 1;
export const PLACE_NAME = 'Place01';

/** PtzCamRoi cameras[].camera → camera_info(자동탐색 미보유 필드는 NULL). */
export function buildCameras(ptzRaw: unknown, now: string): CameraInfoRow[] {
  const cameras = Array.isArray((ptzRaw as { cameras?: unknown })?.cameras)
    ? (ptzRaw as { cameras: unknown[] }).cameras
    : [];
  const out: CameraInfoRow[] = [];
  for (const entry of cameras) {
    const cam = (entry as { camera?: { cam_id?: unknown; imageWidth?: unknown; imageHeight?: unknown } })?.camera;
    const camId = Number(cam?.cam_id);
    if (!Number.isInteger(camId)) continue;
    out.push({
      camId,
      camName: null,
      camUuid: null,
      url: null,
      userId: null,
      password: null,
      rtspUrl: null,
      camType: 'ptz',
      camCompany: null,
      placeId: PLACE_ID,
      imgW: Number.isFinite(Number(cam?.imageWidth)) ? Number(cam?.imageWidth) : null,
      imgH: Number.isFinite(Number(cam?.imageHeight)) ? Number(cam?.imageHeight) : null,
      updatedAt: now,
    });
  }
  return out;
}

/**
 * PtzCamRoi cameras[].presets[] 에 **프리셋 PTZ 가 들어있으면** 그것을 preset_pos 로 만든다(선택 필드).
 * 시뮬레이터가 ROI 파일 하나로 카메라·프리셋·주차면을 모두 내보내면 camerapos.json 없이도 FK 부모가 선다.
 *
 * 허용 형태(둘 다 지원, 없으면 그 프리셋은 건너뜀 → 하위호환):
 *   { "preset_idx":1, "ptz": { "pan":22, "tilt":6.8, "zoom":1.69 }, "sname":"Preset 1", ... }
 *   { "preset_idx":1, "pan":22, "tilt":6.8, "zoom":1.69, ... }
 * pan/tilt/zoom 3개가 모두 유한수일 때만 채택한다(부분 입력은 무시 — 자리표시자로 강등).
 */
export function buildPresetsFromRoi(ptzRaw: unknown, now: string): PresetPosRow[] {
  const cameras = Array.isArray((ptzRaw as { cameras?: unknown })?.cameras)
    ? (ptzRaw as { cameras: unknown[] }).cameras
    : [];
  const out: PresetPosRow[] = [];
  for (const entry of cameras) {
    const e = entry as { camera?: { cam_id?: unknown }; presets?: unknown };
    const camId = Number(e?.camera?.cam_id);
    if (!Number.isInteger(camId)) continue;
    const presets = Array.isArray(e?.presets) ? e.presets : [];
    for (const pr of presets) {
      const p = pr as {
        preset_idx?: unknown; sname?: unknown; name?: unknown;
        ptz?: { pan?: unknown; tilt?: unknown; zoom?: unknown };
        pan?: unknown; tilt?: unknown; zoom?: unknown;
      };
      const presetId = Number(p?.preset_idx);
      if (!Number.isInteger(presetId)) continue;
      const src = p?.ptz ?? p;
      const pan = Number(src?.pan);
      const tilt = Number(src?.tilt);
      const zoom = Number(src?.zoom);
      if (!Number.isFinite(pan) || !Number.isFinite(tilt) || !Number.isFinite(zoom)) continue;
      const label = typeof p?.sname === 'string' ? p.sname : typeof p?.name === 'string' ? p.name : null;
      out.push({ camId, presetId, sname: label, pan, tilt, zoom, updatedAt: now });
    }
  }
  return out;
}

/**
 * ROI 파일이 프리셋 PTZ 를 담고 있으면 그것으로 수집 순회 대상(SetupTarget[])을 만든다.
 * camerapos.json 없이 ROI 정본 하나로 "ROI 로딩 → 시작" 이 같은 프리셋 집합을 쓰게 하는 경로.
 * PTZ 미보유 파일이면 빈 배열 → 호출부가 기존 camerapos 폴백을 그대로 탄다(하위호환).
 */
export function loadSetupTargetsFromRoi(placeRoiFile: string): SetupTarget[] {
  if (!existsSync(placeRoiFile)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(placeRoiFile, 'utf-8'));
  } catch {
    return [];
  }
  return buildPresetsFromRoi(raw, '')
    .sort((a, b) => a.camId - b.camId || a.presetId - b.presetId)
    .map((p) => ({
      camIdx: p.camId,
      presetIdx: p.presetId,
      label: p.sname ?? `C${p.camId}-P${p.presetId}`,
      ptz: { pan: p.pan, tilt: p.tilt, zoom: p.zoom },
    }));
}

/**
 * ROI 파일의 프리셋 PTZ → 뷰어/수집이 쓰는 CameraView[]. PTZ 미보유면 빈 배열.
 * `writeCamerapos` 로 camerapos.json 을 ROI 정본에서 파생 생성할 때 쓴다(카메라·프리셋 드롭다운 정합).
 */
export function roiToCameraViews(ptzRaw: unknown): CameraView[] {
  return buildPresetsFromRoi(ptzRaw, '')
    .sort((a, b) => a.camId - b.camId || a.presetId - b.presetId)
    .map((p) => ({
      camIdx: p.camId,
      presetIdx: p.presetId,
      label: p.sname ?? `Preset ${p.presetId}`,
      pan: p.pan,
      tilt: p.tilt,
      zoom: p.zoom,
    }));
}

/** camerapos datas[].datas[] → preset_pos. */
export function buildPresets(cameraposRaw: unknown, now: string): PresetPosRow[] {
  const groups = Array.isArray((cameraposRaw as { datas?: unknown })?.datas)
    ? (cameraposRaw as { datas: unknown[] }).datas
    : [];
  const out: PresetPosRow[] = [];
  for (const g of groups) {
    const inner = Array.isArray((g as { datas?: unknown })?.datas) ? (g as { datas: unknown[] }).datas : [];
    for (const d of inner) {
      const p = d as { cam_id?: unknown; preset_id?: unknown; sname?: unknown; pan?: unknown; tilt?: unknown; zoom?: unknown };
      const camId = Number(p?.cam_id);
      const presetId = Number(p?.preset_id);
      if (!Number.isInteger(camId) || !Number.isInteger(presetId)) continue;
      out.push({
        camId,
        presetId,
        sname: typeof p?.sname === 'string' ? p.sname : null,
        pan: Number(p?.pan),
        tilt: Number(p?.tilt),
        zoom: Number(p?.zoom),
        updatedAt: now,
      });
    }
  }
  return out;
}

/**
 * PtzCamRoi parking_spaces → slot_setup(기하만; 센터라이징 PTZ 는 별도 UPDATE).
 * slot_id = normalizeGlobalIdx 결과(전역 1..N). preset_slotidx = 프리셋 내 배열순 1-based.
 * slot_roi = 정규화 4점 폴리곤(NormalizedPoint[]) JSON.
 */
export function buildSlots(ptzRaw: unknown, now: string): SlotSetupRow[] {
  const { byPreset } = normalizePtzCamRoi(ptzRaw);
  const normalized = normalizeGlobalIdx(byPreset); // 전역 slot_id 확정(정본 정규화 유틸 재사용)
  const out: SlotSetupRow[] = [];
  // key 정렬(cam asc → preset asc) — normalizeGlobalIdx 와 동일 순서로 preset_slotidx 부여.
  const keys = [...normalized.keys()].sort((a, b) => {
    const [ca, pa] = a.split(':').map(Number);
    const [cb, pb] = b.split(':').map(Number);
    return ca - cb || pa - pb;
  });
  for (const key of keys) {
    const [camId, presetId] = key.split(':').map(Number);
    const spaces = normalized.get(key) ?? [];
    spaces.forEach((sp, i) => {
      out.push({
        slotId: sp.idx,
        camId,
        presetId,
        presetSlotIdx: i + 1, // 배열순 1-based
        slotRoi: stringify5(sp.points), // 정규화 NormalizedPoint[]
        vpdBbox: null,
        lpdObb: null,
        occupyRange: null,
        pan: null,
        tilt: null,
        zoom: null,
        centered: 0,
        img1: null,
        slot3dFrontCenter: null, // 마이그레이션엔 지면모델 없음 → null(다음 finalize 에서 채워짐).
        updatedAt: now,
      });
    });
  }
  return out;
}

export interface RoiDbLoadResult {
  ok: boolean;
  slots: number; // 실제 INSERT 된 slot_setup 행수
  cameras: number;
  presets: number;
  skipped: Array<{ camId: number; presetId: number; count: number; reason: string }>;
  issues: string[]; // normalizePtzCamRoi report 의 issues 평탄화 + 경고
  error?: string; // 실패 시 사유(이때 slot_setup 은 무변경)
}

export interface RoiDbLoadOptions {
  placeRoiFile: string;
  /** camerapos.json 경로(옵셔널). 없으면 preset upsert 를 건너뛰고 기존 preset_pos 로만 FK 판정. */
  cameraposFile?: string;
  now: string;
}

function fail(error: string, issues: string[], skipped: RoiDbLoadResult['skipped']): RoiDbLoadResult {
  return { ok: false, slots: 0, cameras: 0, presets: 0, skipped, issues, error };
}

/**
 * PtzCamRoi(+camerapos) → place/camera/preset upsert → slot_setup 전량 교체.
 * 부모 upsert 순서 고정: place_info → camera_info → preset_pos → replaceSlotSetup.
 */
export function loadRoiIntoDb(store: SqliteStore, opts: RoiDbLoadOptions): RoiDbLoadResult {
  const issues: string[] = [];
  const skipped: RoiDbLoadResult['skipped'] = [];

  if (!existsSync(opts.placeRoiFile)) {
    return fail(`ROI 파일 없음: ${opts.placeRoiFile} — DB 무변경`, issues, skipped);
  }
  let ptzRaw: unknown;
  try {
    ptzRaw = JSON.parse(readFileSync(opts.placeRoiFile, 'utf-8'));
  } catch (err) {
    return fail(`ROI 파일 파싱 실패: ${err instanceof Error ? err.message : String(err)} — DB 무변경`, issues, skipped);
  }

  const { byPreset, report } = normalizePtzCamRoi(ptzRaw);
  for (const r of report) {
    for (const msg of r.issues) issues.push(`cam${r.camId}:preset${r.presetIdx} ${msg}`);
  }
  if (byPreset.size === 0) {
    return fail('ROI 파일에 유효한 주차면 없음 — DB 무변경', issues, skipped);
  }

  const slots = buildSlots(ptzRaw, opts.now);
  if (slots.length === 0) {
    return fail('생성된 슬롯 0건 — DB 무변경', issues, skipped);
  }
  const cameras = buildCameras(ptzRaw, opts.now);

  // preset_pos 는 camerapos.json 이 정본. 없으면 upsert 생략(기존 행으로만 FK 판정).
  let presets: PresetPosRow[] = [];
  if (opts.cameraposFile && existsSync(opts.cameraposFile)) {
    try {
      presets = buildPresets(JSON.parse(readFileSync(opts.cameraposFile, 'utf-8')), opts.now);
    } catch (err) {
      issues.push(`camerapos.json 파싱 실패 — preset upsert 생략: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    issues.push('camerapos.json 없음 — preset upsert 생략(기존 preset_pos 로 FK 판정)');
  }

  try {
    // FK 부모 우선: place → camera → preset.
    store.upsertPlaceInfo([{ placeId: PLACE_ID, placeName: PLACE_NAME }]);
    store.upsertCameraInfo(cameras);
    if (presets.length > 0) store.upsertPresetPos(presets);

    // ROI 파일이 프리셋 PTZ 를 직접 담고 있으면 그것이 정본 — camerapos 뒤에 upsert 해 우선한다.
    const roiPresets = buildPresetsFromRoi(ptzRaw, opts.now);
    if (roiPresets.length > 0) {
      store.upsertPresetPos(roiPresets);
      issues.push(`ROI 파일의 프리셋 PTZ ${roiPresets.length}건 채택(camerapos.json 보다 우선)`);
    }

    // ROI 파일이 가진 (cam,preset) 중 preset_pos 에 없는 것은 **ROI 파일 기준으로 부모 행을 만든다**.
    // ROI 정본이 주차면의 소속 프리셋을 정의하므로, camerapos.json 이 뒤처졌다는 이유로 주차면을
    // 통째로 버리지 않는다(마스터 요청: 파일의 전 주차면 적재).
    // PTZ 는 실측이 아니므로 0/0/1 자리표시자 + sname 에 'PTZ 미상' 을 남기고 issues 로 보고한다.
    // ★ 안전 근거: preset_pos 의 pan/tilt/zoom 을 읽는 코드는 없다(카메라 이동은 camerapos.json/
    //   presetProvider 가 담당). 자리표시자가 카메라를 잘못 움직일 수 없다.
    // ★ camerapos 실측을 먼저 upsert 한 뒤 '아직 없는 키'에만 채우므로 실측값을 덮어쓰지 않는다.
    const havePresets = store.getPresetKeys();
    const placeholders: PresetPosRow[] = [];
    for (const key of byPreset.keys()) {
      if (havePresets.has(key)) continue;
      const [camId, presetId] = key.split(':').map(Number);
      placeholders.push({
        camId, presetId, sname: `C${camId}-P${presetId} (PTZ 미상)`,
        pan: 0, tilt: 0, zoom: 1, updatedAt: opts.now,
      });
    }
    if (placeholders.length > 0) {
      store.upsertPresetPos(placeholders);
      issues.push(
        `preset_pos 자리표시자 ${placeholders.length}건 생성(PTZ 미상 — camerapos.json 갱신 필요): ` +
          placeholders.map((p) => `cam${p.camId}:preset${p.presetId}`).join(', '),
      );
    }

    // FK 부모(preset_pos)가 없는 (cam,preset) 슬롯은 제외 — 전량 INSERT 실패 방지(방어적 잔존 경로).
    const parentKeys = store.getPresetKeys();
    const keep: SlotSetupRow[] = [];
    const dropped = new Map<string, number>();
    for (const s of slots) {
      const key = `${s.camId}:${s.presetId}`;
      if (parentKeys.has(key)) keep.push(s);
      else dropped.set(key, (dropped.get(key) ?? 0) + 1);
    }
    for (const [key, count] of dropped) {
      const [camId, presetId] = key.split(':').map(Number);
      skipped.push({ camId, presetId, count, reason: 'preset_pos 부모 없음(FK)' });
    }
    if (keep.length === 0) {
      return fail('FK 부모(preset_pos) 있는 슬롯 0건 — slot_setup 무변경', issues, skipped);
    }

    store.replaceSlotSetup(keep);
    // presets = ROI 파일이 정의한 (cam,preset) 그룹 수(= 적재된 프리셋 수). camerapos 행 수가 아니다.
    return { ok: true, slots: keep.length, cameras: cameras.length, presets: byPreset.size, skipped, issues };
  } catch (err) {
    // 트랜잭션 롤백 → slot_setup 무변경.
    return fail(`DB 쓰기 실패: ${err instanceof Error ? err.message : String(err)} — slot_setup 무변경`, issues, skipped);
  }
}
