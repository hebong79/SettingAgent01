import { readFileSync, existsSync } from 'node:fs';
import type { SetupTarget } from './SetupOrchestrator.js';

/**
 * mapConfig 자동 프리셋 로딩 (설계서 §8 "프리셋 정의 출처: mapConfig + Unity CameraPos PTZ 추출").
 * ParkSimMgr 의 camerapos 파싱 패턴을 이식하여, camerapos 파일에서 카메라/프리셋/PTZ 를 추출해
 * SetupOrchestrator 입력(SetupTarget[])으로 변환한다.
 */

/** camerapos 파일에서 추출한 카메라 뷰(=프리셋) 한 건. */
export interface CameraView {
  camIdx: number;
  presetIdx: number;
  label: string;
  /** PTZ: 각 항목의 pan/tilt/zoom 필드에서 직접 추출(없으면 undefined → 프리셋 인덱스만 전송). */
  pan?: number;
  tilt?: number;
  zoom?: number;
}

/** preset 파일에서 추출한 프리셋별 주차면 개수(기대값 검증용, 선택). */
export interface FaceGroup {
  camIdx: number;
  presetIdx: number;
  faceCount: number;
}

/**
 * camerapos JSON 을 카메라 뷰 목록으로 파싱.
 * - 형식 A: `{ datas: [ { datas: [ { cam_id, preset_id, sname, pan, tilt, zoom } ] } ] }`
 * - 형식 B: `{ datas: [ { preset_id|idx, sname, pan, tilt, zoom } ] }` (단일 카메라)
 */
export function parseCameraViews(camposJson: unknown): CameraView[] {
  const outer = (camposJson as { datas?: unknown[] })?.datas ?? [];
  const views: CameraView[] = [];
  for (const group of outer) {
    const g = group as Record<string, unknown>;
    if (Array.isArray(g?.datas)) {
      for (const v of g.datas as Record<string, unknown>[]) views.push(toView(v));
    } else if (g && (g.preset_id !== undefined || g.sname !== undefined || g.idx !== undefined)) {
      views.push(toView(g));
    }
  }
  return views;
}

function toView(v: Record<string, unknown>): CameraView {
  const camIdx = typeof v.cam_id === 'number' ? v.cam_id : 1;
  const presetIdx =
    typeof v.preset_id === 'number'
      ? v.preset_id
      : typeof v.idx === 'number'
        ? v.idx + 1 // idx 는 0-based → +1
        : 1;
  const label = typeof v.sname === 'string' ? v.sname : `Preset ${presetIdx}`;
  const pan = typeof v.pan === 'number' ? v.pan : undefined;
  const tilt = typeof v.tilt === 'number' ? v.tilt : undefined;
  const zoom = typeof v.zoom === 'number' ? v.zoom : undefined;
  return { camIdx, presetIdx, label, pan, tilt, zoom };
}

/** preset JSON 을 프리셋별 주차면 개수 목록으로 파싱. */
export function parseFaceGroups(presetJson: unknown): FaceGroup[] {
  const arr = ((presetJson as { datas?: unknown[] })?.datas ?? []) as Record<string, unknown>[];
  return arr.map((p) => ({
    camIdx: typeof p.camIdx === 'number' ? p.camIdx : 1,
    presetIdx: typeof p.idx === 'number' ? p.idx : 1,
    faceCount: typeof p.faceCount === 'number' ? p.faceCount : 0,
  }));
}

/** 카메라 뷰를 셋업 대상으로 변환(cam→preset 순 정렬, PTZ 보유 시 함께 전송). */
export function viewsToTargets(views: CameraView[]): SetupTarget[] {
  return [...views]
    .sort((a, b) => a.camIdx - b.camIdx || a.presetIdx - b.presetIdx)
    .map((v) => {
      const ptz =
        v.pan !== undefined || v.tilt !== undefined || v.zoom !== undefined
          ? { pan: v.pan, tilt: v.tilt, zoom: v.zoom }
          : undefined;
      return { camIdx: v.camIdx, presetIdx: v.presetIdx, label: v.label, ptz };
    });
}

export interface MapFiles {
  cameraposFile: string;
  presetFile?: string;
}

/** camerapos(필수)/preset(선택) 파일을 읽어 셋업 대상으로 변환. */
export function loadSetupTargets(files: MapFiles): SetupTarget[] {
  if (!existsSync(files.cameraposFile)) {
    throw new Error(`camerapos 파일이 없음: ${files.cameraposFile}`);
  }
  const campos = JSON.parse(readFileSync(files.cameraposFile, 'utf-8'));
  return viewsToTargets(parseCameraViews(campos));
}

/** preset 파일에서 (camIdx,presetIdx) → 기대 주차면 개수 맵을 만든다. 파일 없으면 빈 맵. */
export function loadExpectedFaces(presetFile?: string): Record<string, number> {
  if (!presetFile || !existsSync(presetFile)) return {};
  const json = JSON.parse(readFileSync(presetFile, 'utf-8'));
  const out: Record<string, number> = {};
  for (const f of parseFaceGroups(json)) out[`${f.camIdx}:${f.presetIdx}`] = f.faceCount;
  return out;
}
