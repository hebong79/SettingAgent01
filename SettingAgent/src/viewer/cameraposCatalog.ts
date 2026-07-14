import type { CameraView } from '../setup/mapTargets.js';
import type { CameraList } from './CameraSource.js';

/**
 * 카메라 PTZ 프리셋(camerapos.json 파싱 결과 = CameraView[])을 뷰어 드롭다운용 CameraList 로 변환(순수).
 * - camIdx 로 그룹핑 → cameras[{ camIdx, name, enabled, presets:[{presetIdx,label,pan,tilt,zoom}] }].
 * - name/enabled 는 device 목록(cam.list 응답)과 병합: device 에 있으면 name·enabled=true, 없으면 `C{camIdx}`·enabled=false([off]).
 * - 카메라 집합은 파일(views) 기준(디바이스 전용 항목은 표시하지 않음, 설계서 §1·§단계1).
 */
export function buildCameraList(
  views: CameraView[],
  devices?: Array<{ camId: number; name?: string }>,
): CameraList {
  const deviceById = new Map<number, { name?: string }>();
  for (const d of devices ?? []) deviceById.set(d.camId, { name: d.name });

  const byCam = new Map<number, CameraList['cameras'][number]>();
  for (const v of views) {
    let cam = byCam.get(v.camIdx);
    if (!cam) {
      const dev = deviceById.get(v.camIdx);
      cam = {
        camIdx: v.camIdx,
        name: dev?.name ?? `C${v.camIdx}`,
        enabled: deviceById.has(v.camIdx),
        presets: [],
      };
      byCam.set(v.camIdx, cam);
    }
    cam.presets.push({ presetIdx: v.presetIdx, label: v.label, pan: v.pan, tilt: v.tilt, zoom: v.zoom });
  }

  const cameras = [...byCam.values()].sort((a, b) => a.camIdx - b.camIdx);
  for (const c of cameras) c.presets.sort((a, b) => a.presetIdx - b.presetIdx);
  return { cameras };
}
