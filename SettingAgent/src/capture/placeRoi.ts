// 미리 정의된 주차면 폴리곤(PtzCamRoi.json) 백엔드 정규화 — web/core.js:normalizePtzCamRoi 동등 포팅(§06 H2).
// 순수·throw 금지(강등 철학): malformed 입력도 부분 결과 + issues 로 강등. finalize 조립에서 재사용.

import { readFile } from 'node:fs/promises';
import type { NormalizedPoint } from '../domain/types.js';

/** 프리셋별 정규화 주차면(파일 idx + 정규화 4점). */
export interface PlaceRoiSpace {
  idx: number;
  points: NormalizedPoint[];
}

/** 프리셋별 검수 리포트(1프리셋 1건). */
export interface PlaceRoiReport {
  camId: unknown;
  presetIdx: unknown;
  spaceCount: number;
  issues: string[];
}

/** normalizePtzCamRoi 반환: byPreset 맵(`${camId}:${presetIdx}` → 공간들) + 프리셋별 검수. */
export interface NormalizedPlaceRoi {
  byPreset: Map<string, PlaceRoiSpace[]>;
  report: PlaceRoiReport[];
}

/**
 * PtzCamRoi.json raw JSON → 프리셋별 정규화 폴리곤 + 검수 리포트.
 * 입력 shape: { cameras:[{ camera:{ cam_id, imageWidth, imageHeight }, presets:[{ preset_idx, parking_spaces:[{ idx, points:[[x,y]...] }] }] }] }.
 * 픽셀→`x/W, y/H` 정규화. cam_id↔camIdx, preset_idx↔presetIdx 동일 1-based. web/core.js 로직과 동등.
 */
export function normalizePtzCamRoi(json: unknown): NormalizedPlaceRoi {
  const byPreset = new Map<string, PlaceRoiSpace[]>();
  const report: PlaceRoiReport[] = [];
  if (!json || typeof json !== 'object') return { byPreset, report };
  const root = json as { cameras?: unknown };
  const cameras = Array.isArray(root.cameras) ? root.cameras : [];
  for (const camEntry of cameras) {
    const entry = camEntry as { camera?: { cam_id?: unknown; imageWidth?: unknown; imageHeight?: unknown }; presets?: unknown };
    const cam = entry?.camera;
    const camId = cam?.cam_id;
    const W = Number(cam?.imageWidth);
    const H = Number(cam?.imageHeight);
    const sizeOk = !!cam && Number.isFinite(W) && Number.isFinite(H) && W > 0 && H > 0;
    const presets = Array.isArray(entry?.presets) ? entry.presets : [];
    for (const presetRaw of presets) {
      const preset = presetRaw as { preset_idx?: unknown; parking_spaces?: unknown };
      const presetIdx = preset?.preset_idx;
      const rawSpaces = Array.isArray(preset?.parking_spaces) ? preset.parking_spaces : [];
      const issues: string[] = [];
      if (camId == null) issues.push('cam_id 누락');
      if (presetIdx == null) issues.push('preset_idx 누락');
      if (!sizeOk) issues.push('이미지 크기 누락/오류');
      if (!Array.isArray(preset?.parking_spaces) || rawSpaces.length === 0) issues.push('주차면 없음');

      const normSpaces: PlaceRoiSpace[] = [];
      for (const spRaw of rawSpaces) {
        const sp = spRaw as { idx?: unknown; points?: unknown };
        const idx = sp?.idx;
        if (idx == null) { issues.push('idx 누락'); continue; }
        const rawPts = sp?.points;
        if (!Array.isArray(rawPts)) { issues.push(`idx ${idx}: points 누락`); continue; }
        if (rawPts.length !== 4) issues.push(`idx ${idx}: 점 4개 아님(${rawPts.length}개)`);
        const pts = rawPts.map((p) => ({
          x: Array.isArray(p) ? Number(p[0]) : Number((p as { x?: unknown })?.x),
          y: Array.isArray(p) ? Number(p[1]) : Number((p as { y?: unknown })?.y),
        }));
        if (!sizeOk) continue; // 정규화 불가 → 이미 '이미지 크기 누락/오류' 기록, byPreset 미기록.
        const outOfRange = pts.some(
          (p) => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > W || p.y < 0 || p.y > H,
        );
        // 프레임 밖 좌표는 **정상일 수 있다** — 주차면이 화면 밖으로 걸치는 것은 정당하다(라이브 검증: preset1 idx7).
        // 점은 클램프·드롭 없이 그대로 보존한다(투영점으로서 유효 — 지면모델·육면체 모두 정상 동작).
        if (outOfRange) issues.push(`idx ${idx}: 좌표 프레임 밖(정상일 수 있음)`);
        normSpaces.push({ idx: idx as number, points: pts.map((p) => ({ x: p.x / W, y: p.y / H })) });
      }

      report.push({ camId, presetIdx, spaceCount: rawSpaces.length, issues });
      if (sizeOk && normSpaces.length) byPreset.set(`${camId}:${presetIdx}`, normSpaces);
    }
  }
  return { byPreset, report };
}

/**
 * 전역 인덱스 정규화 — `web/core.js:normalizeGlobalIdx` 동등 포팅(규칙 단일화, 파리티 테스트로 고정).
 * PtzCamRoi.json 의 `parking_spaces[].idx` 를 **파일 전체 고유한 전역번호(1..N)** 로 본다.
 * - 현재 idx 집합이 정확히 1..N 의 순열이면 **그대로 반환**(멱등 — 사용자가 재지정한 번호 보존).
 * - 아니면(프리셋별 0-based 중복·누락·비정수) `(cam asc → preset asc → parking_spaces 배열순)` 으로 1..N 재부여.
 * 순수·불변(재부여 시 새 Map/새 space 객체). 프리셋 소속·좌표·배열 순서 불변 — idx 값만 갱신.
 */
export function normalizeGlobalIdx(byPreset: Map<string, PlaceRoiSpace[]>): Map<string, PlaceRoiSpace[]> {
  const keys = [...byPreset.keys()].sort((a, b) => {
    const [ca, pa] = a.split(':').map(Number);
    const [cb, pb] = b.split(':').map(Number);
    return ca - cb || pa - pb;
  });
  const seen = new Set<number>();
  const n = keys.reduce((sum, key) => sum + (byPreset.get(key)?.length ?? 0), 0);
  let valid = true;
  for (const key of keys) {
    for (const sp of byPreset.get(key) ?? []) {
      if (!Number.isInteger(sp.idx) || sp.idx < 1 || sp.idx > n || seen.has(sp.idx)) valid = false;
      else seen.add(sp.idx);
    }
  }
  if (valid) return byPreset; // 이미 1..N 고유 → 무변경.
  const out = new Map<string, PlaceRoiSpace[]>();
  let next = 1;
  for (const key of keys) out.set(key, (byPreset.get(key) ?? []).map((sp) => ({ ...sp, idx: next++ })));
  return out;
}

/**
 * 주차면 자동보정 결과를 PtzCamRoi raw JSON 에 반영(불변, §04 PUT /capture/place-roi).
 * 정규화 spaces(`[{idx,points:[{x,y}×4]}]`)를 대상 카메라(cam_id) imageWidth/imageHeight 로 픽셀 역변환해
 * 해당 프리셋(preset_idx) parking_spaces 만 교체한다. 나머지 카메라·프리셋·메타(imageWidth 등)는 보존.
 * 대상 카메라/프리셋 부재·이미지 크기 오류면 원본 그대로 반환(방어적, throw 금지).
 */
export function applyPlaceRoiUpdate(
  json: unknown,
  update: { camId: unknown; presetIdx: unknown; spaces: PlaceRoiSpace[] },
): unknown {
  return applyPlaceRoiUpdateEx(json, update).json;
}

/**
 * 빈 상태에서 대상 카메라/프리셋 골격을 만들 때 쓰는 최소 메타(뷰어 실측값).
 * - imageWidth/imageHeight: `<img id="frame">` 의 naturalWidth/naturalHeight(정규화 좌표의 유일한 역변환 기준).
 * - pan/tilt/zoom: **L3 부트스트랩의 유일한 PTZ 출처**다. `planAutoRoi` 는 `buildGroundInputs(json, [])` 로
 *   camerapos 를 넘기지 않으므로, 이 값이 비면 `ref.zoom == null` → "PTZ 미상 — 부트스트랩 불가" 로 즉시 실패한다.
 */
export interface PlaceRoiSkeleton {
  imageWidth: number;
  imageHeight: number;
  pan?: number;
  tilt?: number;
  zoom?: number;
}

/**
 * `applyPlaceRoiUpdate` 확장판 — 반환에 `applied`(실제로 교체가 일어났는가) + `issues` 를 붙이고,
 * `create` 가 주어지면 **없는 카메라/프리셋 골격을 생성**한다(신규 주차장의 첫 주차면).
 *
 * `applied` 가 필요한 이유: 대상 cam/preset 이 없으면 기존 구현은 원본을 그대로 돌려주는데
 * 라우트는 `{ok:true}` 를 반환해 **아무것도 저장되지 않았는데 성공으로 보였다**(조용한 거짓 성공).
 *
 * `create` 는 **가산**이다 — 카메라·프리셋이 이미 있으면 아무것도 하지 않는다(기존 imageWidth 등 메타 덮어쓰기 금지).
 */
export function applyPlaceRoiUpdateEx(
  json: unknown,
  update: { camId: unknown; presetIdx: unknown; spaces: PlaceRoiSpace[]; create?: PlaceRoiSkeleton },
): { json: unknown; applied: boolean; issues: string[] } {
  const issues: string[] = [];
  const create = update.create;
  let root: { cameras?: unknown; [k: string]: unknown };
  if (!json || typeof json !== 'object') {
    if (!create) {
      issues.push('PtzCamRoi JSON 형식이 아님 — 적용하지 않음');
      return { json, applied: false, issues };
    }
    root = { cameras: [] };
  } else {
    root = json as { cameras?: unknown; [k: string]: unknown };
  }
  // cameras 가 배열이 아니면 [] 로 정규화한다(기존 applyPlaceRoiUpdate 거동 그대로).
  let cameras = Array.isArray(root.cameras) ? root.cameras : [];

  // create: 대상 카메라/프리셋 골격 보강(있으면 무동작).
  if (create) {
    const hasCam = cameras.some((c) => (c as { camera?: { cam_id?: unknown } })?.camera?.cam_id === update.camId);
    if (!hasCam) {
      cameras = [
        ...cameras,
        {
          camera: { cam_id: update.camId, imageWidth: create.imageWidth, imageHeight: create.imageHeight },
          presets: [],
        },
      ];
      issues.push(`cam${update.camId} 신규 생성(${create.imageWidth}x${create.imageHeight})`);
    }
    cameras = cameras.map((camEntry) => {
      const entry = camEntry as { camera?: { cam_id?: unknown }; presets?: unknown };
      if (entry?.camera?.cam_id !== update.camId) return camEntry;
      const presets = Array.isArray(entry.presets) ? entry.presets : [];
      if (presets.some((p) => (p as { preset_idx?: unknown })?.preset_idx === update.presetIdx)) return camEntry;
      const preset: Record<string, unknown> = { preset_idx: update.presetIdx };
      // PTZ 는 있는 값만 기록(없는 키를 null 로 채우면 정상값과 구분이 안 된다).
      if (Number.isFinite(create.pan)) preset.pan = create.pan;
      if (Number.isFinite(create.tilt)) preset.tilt = create.tilt;
      if (Number.isFinite(create.zoom)) preset.zoom = create.zoom;
      preset.parking_spaces = [];
      issues.push(`cam${update.camId} preset${update.presetIdx} 신규 생성`);
      return { ...entry, presets: [...presets, preset] };
    });
  }

  let applied = false;
  const nextCameras = cameras.map((camEntry) => {
    const entry = camEntry as {
      camera?: { cam_id?: unknown; imageWidth?: unknown; imageHeight?: unknown };
      presets?: unknown;
    };
    const cam = entry?.camera;
    if (!cam || cam.cam_id !== update.camId) return camEntry;
    const W = Number(cam.imageWidth);
    const H = Number(cam.imageHeight);
    if (!Number.isFinite(W) || !Number.isFinite(H) || W <= 0 || H <= 0) {
      issues.push(`cam${update.camId}: 이미지 크기 누락/오류 — 적용하지 않음`);
      return camEntry;
    }
    const presets = Array.isArray(entry.presets) ? entry.presets : [];
    const nextPresets = presets.map((presetRaw) => {
      const preset = presetRaw as { preset_idx?: unknown; [k: string]: unknown };
      if (preset?.preset_idx !== update.presetIdx) return presetRaw;
      const parking_spaces = (update.spaces ?? []).map((sp) => ({
        idx: sp.idx,
        points: (sp.points ?? []).map((p) => [p.x * W, p.y * H]),
      }));
      applied = true;
      return { ...preset, parking_spaces };
    });
    return { ...entry, presets: nextPresets };
  });
  if (!applied) issues.push(`cam${update.camId} preset${update.presetIdx} 대상 없음 — 적용하지 않음`);
  return { json: { ...root, cameras: nextCameras }, applied, issues };
}

/**
 * 파일 경로 → 정규화 결과. 파일 미설정/없음/파싱실패 시 null(best-effort, loadDetectCfg 방어 패턴).
 */
export async function loadNormalizedPlaceRoi(file?: string): Promise<NormalizedPlaceRoi | null> {
  if (!file) return null;
  try {
    const raw = await readFile(file, 'utf8');
    return normalizePtzCamRoi(JSON.parse(raw));
  } catch {
    return null;
  }
}
