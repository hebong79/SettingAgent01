// PtzCamRoi.json + camerapos 뷰 → 지면모델 추정 입력(GroundCameraInput[]). 순수(파일 IO 는 라우트가 담당).
// 점 추출 규칙은 placeRoi.normalizePtzCamRoi 하나만 쓴다(이중구현 금지) — 0..1 정규화분을 imageWidth/Height 로
// 되돌려 **원본 픽셀** 좌표로 만든다. 지면모델은 원본 픽셀에서만 성립한다(설계 §1-2).

import { normalizePtzCamRoi } from '../capture/placeRoi.js';
import type { CameraView } from '../setup/mapTargets.js';
import type { GroundCameraInput, PixelQuad } from './types.js';

/** PtzCamRoi raw JSON + 프리셋 뷰(zoom 소스) → 카메라별 추정 입력. 파싱 불가분은 조용히 제외(throw 금지). */
export function buildGroundInputs(placeRoiJson: unknown, views: CameraView[]): GroundCameraInput[] {
  const { byPreset } = normalizePtzCamRoi(placeRoiJson);
  const ptzOf = new Map(views.map((v) => [`${v.camIdx}:${v.presetIdx}`, v]));

  const root = placeRoiJson as { cameras?: unknown };
  const cameras = Array.isArray(root?.cameras) ? root.cameras : [];
  const out: GroundCameraInput[] = [];
  for (const camEntry of cameras) {
    const entry = camEntry as {
      camera?: { cam_id?: unknown; imageWidth?: unknown; imageHeight?: unknown };
      presets?: unknown;
    };
    const camIdx = Number(entry?.camera?.cam_id);
    const imgW = Number(entry?.camera?.imageWidth);
    const imgH = Number(entry?.camera?.imageHeight);
    if (!Number.isFinite(camIdx) || !(imgW > 0) || !(imgH > 0)) continue;

    const presets: GroundCameraInput['presets'] = [];
    for (const presetRaw of Array.isArray(entry?.presets) ? entry.presets : []) {
      const presetIdx = Number((presetRaw as { preset_idx?: unknown })?.preset_idx);
      if (!Number.isFinite(presetIdx)) continue;
      const key = `${camIdx}:${presetIdx}`;
      const spaces = byPreset.get(key) ?? [];
      const quads: PixelQuad[] = [];
      for (const sp of spaces) {
        if (sp.points.length !== 4) continue; // 4점 아닌 면은 추정 표본 제외(강등).
        quads.push(sp.points.map((p) => ({ x: p.x * imgW, y: p.y * imgH })) as PixelQuad);
      }
      // PTZ 소스 우선순위: **ROI 파일 자체의 프리셋 PTZ** > camerapos 뷰.
      // 시뮬레이터가 내보내는 ROI 정본이 프리셋별 pan/tilt/zoom 을 담으므로 그것이 진실이고,
      // camerapos.json 은 뒤처진 사본일 수 있다(실측: cam1 preset3 zoom 이 ROI 1 vs camerapos 1.46583).
      const own = presetRaw as { ptz?: { pan?: unknown; tilt?: unknown; zoom?: unknown }; pan?: unknown; tilt?: unknown; zoom?: unknown };
      const ownSrc = own?.ptz ?? own;
      const ptz = ptzOf.get(key);
      const pick = (a: unknown, b: unknown): number | null =>
        typeof a === 'number' && Number.isFinite(a) ? a : typeof b === 'number' && Number.isFinite(b) ? b : null;
      presets.push({
        camIdx,
        presetIdx,
        zoom: pick(ownSrc?.zoom, ptz?.zoom),
        tilt: pick(ownSrc?.tilt, ptz?.tilt),
        pan: pick(ownSrc?.pan, ptz?.pan),
        quads,
      });
    }
    if (presets.length) out.push({ camIdx, imgW, imgH, presets });
  }
  return out;
}
