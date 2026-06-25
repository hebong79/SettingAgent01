import type { CameraClient } from '../clients/CameraClient.js';
import type { ToolsConfig } from '../config/toolsConfig.js';
import type { CameraView } from './mapTargets.js';

/**
 * 프리셋 자동 탐색(방안 B). cam/preset 인덱스를 1부터 순회하며 캡처를 시도해 존재하는 (cam,preset)
 * 목록을 CameraView[] 로 반환한다(캡처 응답의 실제 PTZ 포함). camerapos.json 없이 동작하며,
 * 결과를 camerapos.json 으로 저장(export)하면 이후엔 파일(A)로 정확·빠르게 재사용할 수 있다.
 *
 * 종료 규칙:
 * - 카메라 preset=1 캡처 실패 → 그 카메라 없음 → 카메라 순회 종료.
 * - 캡처되던 카메라에서 이후 preset 실패 → 그 카메라 프리셋 끝 → 다음 카메라.
 * - 상한(maxCameras/maxPresetsPerCamera)으로 폭주 방지.
 *
 * 주의: 일부 서버(실 PTZ)는 없는 프리셋에도 영상을 반환해 프리셋 경계가 불명확할 수 있다(옵트인 사유).
 */
export async function discoverViews(
  camera: CameraClient,
  opts: ToolsConfig['discovery'],
  log?: (msg: string) => void,
): Promise<CameraView[]> {
  const views: CameraView[] = [];
  for (let cam = 1; cam <= opts.maxCameras; cam++) {
    let found = 0;
    for (let preset = 1; preset <= opts.maxPresetsPerCamera; preset++) {
      try {
        const img = await camera.requestImage(cam, preset);
        views.push({ camIdx: cam, presetIdx: preset, label: `C${cam}-P${preset}`, pan: img.pan, tilt: img.tilt, zoom: img.zoom });
        found++;
      } catch {
        break;
      }
    }
    log?.(`cam ${cam}: 프리셋 ${found}개 발견`);
    if (found === 0) break;
  }
  return views;
}
