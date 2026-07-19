/**
 * 1회성 이관 CLI (설계서 §5). 파일 정본(PtzCamRoi.json/camerapos.json/slot_ptz.json) → 신 DB.
 * 실행: `node dist/src/tools/migrateToSettingDb.js [dbPath]`  (기본 dbPath=data/setting.sqlite)
 *
 * ★ 구 observations.sqlite 는 절대 건드리지 않는다(롤백 지점) — 항상 신 파일에만 쓴다.
 * ★ 멱등: place/camera/preset 은 upsert, slot_setup 은 replace(DELETE 후 INSERT). 재실행 안전.
 *
 * 매핑(§5.1):
 *   place_info   ← 상수 {place_id:1, place_name:'Place01'}
 *   camera_info  ← PtzCamRoi cameras[].camera(cam_id/imageWidth/imageHeight, 나머지 NULL, cam_type='ptz')
 *   preset_pos   ← camerapos datas[].datas[](cam_id/preset_id/sname/pan/tilt/zoom)
 *   slot_setup   ← PtzCamRoi parking_spaces(slot_id=normalizeGlobalIdx, preset_slotidx=배열순 1-based, slot_roi=정규화 4점)
 *   센터라이징    ← slot_ptz.json items(있으면 slot_id=globalIdx 로 pan/tilt/zoom/centered=1 UPDATE)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadToolsConfig } from '../config/toolsConfig.js';
import { normalizePtzCamRoi, normalizeGlobalIdx } from '../capture/placeRoi.js';
import { SqliteStore } from '../capture/SqliteStore.js';
import type {
  CameraInfoRow,
  PlaceInfoRow,
  PresetPosRow,
  SlotCenteringRow,
  SlotSetupRow,
} from '../capture/types.js';
import { stringify5 } from '../util/round.js';

const PLACE_ID = 1;
const PLACE_NAME = 'Place01';

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf-8'));
}

/** PtzCamRoi cameras[].camera → camera_info(자동탐색 미보유 필드는 NULL). */
function buildCameras(ptzRaw: unknown, now: string): CameraInfoRow[] {
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

/** camerapos datas[].datas[] → preset_pos. */
function buildPresets(cameraposRaw: unknown, now: string): PresetPosRow[] {
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
function buildSlots(ptzRaw: unknown, now: string): SlotSetupRow[] {
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

/**
 * slot_ptz.json items → 센터라이징 UPDATE 행(slot_id=globalIdx). 수렴 성공 항목만.
 * globalIdx 미보유(null) 항목은 slot_id 매칭 불가 → 스킵(경고).
 */
function buildCentering(slotPtzRaw: unknown, now: string): { rows: SlotCenteringRow[]; skipped: number } {
  const items = Array.isArray((slotPtzRaw as { items?: unknown })?.items)
    ? (slotPtzRaw as { items: unknown[] }).items
    : [];
  const rows: SlotCenteringRow[] = [];
  let skipped = 0;
  for (const it of items) {
    const item = it as {
      globalIdx?: unknown;
      ptz?: { pan?: unknown; tilt?: unknown; zoom?: unknown };
      centered?: unknown;
      converged?: unknown;
    };
    if (!item?.centered || !item?.converged) continue; // 성공 항목만(PtzCalibrator.saveCenteringSlots 필터 계승)
    const slotId = Number(item?.globalIdx);
    if (!Number.isInteger(slotId)) {
      skipped += 1;
      continue;
    }
    rows.push({
      slotId,
      pan: Number(item?.ptz?.pan),
      tilt: Number(item?.ptz?.tilt),
      zoom: Number(item?.ptz?.zoom),
      centered: 1,
      img1: null,
      updatedAt: now,
    });
  }
  return { rows, skipped };
}

function main(): void {
  const t = loadToolsConfig();
  const dbPath = process.argv[2] ?? 'data/setting.sqlite';
  const ptzFile = join(t.store.dataDir, t.store.placeRoiFile);
  const cameraposFile = t.map.cameraposFile;
  const slotPtzFile = t.calibrate.outFile;
  const now = new Date().toISOString();

  console.log(`[migrate] 신 DB → ${dbPath}`);
  console.log(`[migrate] 소스: ptzCamRoi=${ptzFile} camerapos=${cameraposFile} slotPtz=${slotPtzFile}`);

  if (!existsSync(ptzFile)) {
    console.error(`[migrate] PtzCamRoi.json 없음: ${ptzFile}`);
    process.exit(1);
  }
  if (!existsSync(cameraposFile)) {
    console.error(`[migrate] camerapos.json 없음: ${cameraposFile}`);
    process.exit(1);
  }

  const ptzRaw = readJson(ptzFile);
  const cameraposRaw = readJson(cameraposFile);

  const place: PlaceInfoRow[] = [{ placeId: PLACE_ID, placeName: PLACE_NAME }];
  const cameras = buildCameras(ptzRaw, now);
  const presets = buildPresets(cameraposRaw, now);
  const slots = buildSlots(ptzRaw, now);

  const store = new SqliteStore(dbPath);
  try {
    // FK 부모 우선: place → camera → preset → slot.
    store.upsertPlaceInfo(place);
    store.upsertCameraInfo(cameras);
    store.upsertPresetPos(presets);
    store.replaceSlotSetup(slots);

    // 센터라이징 이관(파일 우선, 없으면 스킵 — 구 DB centering_slot 1행은 선택적).
    let centeredCount = 0;
    if (existsSync(slotPtzFile)) {
      const { rows, skipped } = buildCentering(readJson(slotPtzFile), now);
      if (rows.length > 0) store.upsertSlotCentering(rows);
      centeredCount = rows.length;
      if (skipped > 0) console.warn(`[migrate] slot_ptz 항목 ${skipped}건 globalIdx 미보유 → 센터라이징 스킵`);
    } else {
      console.log(`[migrate] slot_ptz.json 없음 → 센터라이징 스킵`);
    }

    console.log(
      `[migrate] 완료: place=${place.length} camera=${cameras.length} preset=${presets.length} ` +
        `slot=${slots.length} centered=${centeredCount}`,
    );
  } finally {
    store.close();
  }
}

main();
