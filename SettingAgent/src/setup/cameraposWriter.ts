import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CameraView } from './mapTargets.js';

/**
 * CameraView[] 를 camerapos.json 표준 포맷(형식 A: 카메라별 그룹)으로 저장한다.
 * 공급자(자동탐색 B / 벤더 API A)의 결과를 파일로 내보내, 이후 셋업이 파일(A)로 동작하게 한다.
 * parseCameraViews 가 그대로 다시 읽을 수 있는 형태로 쓴다(왕복 호환).
 */
export function writeCamerapos(views: CameraView[], path: string): void {
  const byCam = new Map<number, CameraView[]>();
  for (const v of views) {
    if (!byCam.has(v.camIdx)) byCam.set(v.camIdx, []);
    byCam.get(v.camIdx)!.push(v);
  }
  const datas = [...byCam.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([camId, vs]) => ({
      cam_id: camId,
      datas: vs
        .slice()
        .sort((a, b) => a.presetIdx - b.presetIdx)
        .map((v) => {
          const entry: Record<string, unknown> = { cam_id: v.camIdx, preset_id: v.presetIdx, sname: v.label };
          if (typeof v.pan === 'number') entry.pan = v.pan;
          if (typeof v.tilt === 'number') entry.tilt = v.tilt;
          if (typeof v.zoom === 'number') entry.zoom = v.zoom;
          return entry;
        }),
    }));

  const out = {
    _comment: 'SettingAgent 생성(export). 공급자(자동탐색/벤더API)의 결과. 수동 편집 가능.',
    datas,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(out, null, 2), 'utf-8');
}
