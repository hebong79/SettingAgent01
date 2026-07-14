import { CameraClient } from '../clients/CameraClient.js';
import { CRpcClient } from '../clients/CRpcClient.js';
import type { ToolsConfig } from '../config/toolsConfig.js';
import type { CameraSource } from './CameraSource.js';
import { SimulatorSource } from './SimulatorSource.js';
import { RealPtzSource } from './RealPtzSource.js';
import { RpcCameraSource } from './RpcCameraSource.js';
import { CameraposSource } from './CameraposSource.js';

/**
 * cameraSources 설정 → Map<sourceId, CameraSource> 빌드(설계서 §13.5).
 * 기본 폴백: cameraSources 미설정 시 camerapos 소스(id='rpc') 1개를 등록(설계서 §3).
 * (뷰어 카메라/프리셋 = camerapos.json[카메라 PTZ 프리셋]. device 제어는 RpcCameraSource 합성 위임:
 *  list/move/snapshot=/rpc, stream=/stream(CameraClient) 위임.)
 */
export function buildSourceRegistry(
  cfg: Pick<ToolsConfig, 'camera' | 'cameraSources' | 'unityRpc' | 'map' | 'cameraMode' | 'realCamera'>,
): Map<string, CameraSource> {
  const sources = new Map<string, CameraSource>();

  // (A) 고급/다중: cameraSources 명시(길이>0) → 기존 경로 그대로. cameraMode 무시(precedence).
  if (cfg.cameraSources && cfg.cameraSources.length > 0) {
    for (const src of cfg.cameraSources) {
      if (src.kind === 'sim') {
        // sim 은 baseUrl 만 다른 camera 설정으로 CameraClient 재구성(나머지 항목은 기존 camera 재사용).
        const cam = new CameraClient({ ...cfg.camera, baseUrl: src.baseUrl ?? cfg.camera.baseUrl });
        sources.set(src.id, new SimulatorSource(cam));
      } else {
        sources.set(src.id, new RealPtzSource(src, cfg.camera.imageTimeoutMs));
      }
    }
    return sources;
  }

  // (B) 단일 소스: cameraMode 로 선택(cameraSources 미설정/빈배열).
  if (cfg.cameraMode === 'real') {
    // 리얼은 opt-in·미검증 — 미설정 시 조용한 폴백 대신 fail-fast 로 오설정을 드러낸다.
    if (!cfg.realCamera) throw new Error('리얼 카메라(realCamera) 설정이 없습니다');
    const rc = { ...cfg.realCamera, kind: 'hucoms' as const };
    sources.set(rc.id, new RealPtzSource(rc, cfg.camera.imageTimeoutMs));
    return sources;
  }

  // 'simulator'(기본) → 현재 폴백: camerapos 소스(파일 기반 목록 + RpcCameraSource 합성으로 device 제어 위임).
  const rpc = new CRpcClient(cfg.unityRpc);
  const inner = new RpcCameraSource(rpc, new CameraClient(cfg.camera));
  sources.set('rpc', new CameraposSource(cfg.map.cameraposFile, inner, rpc));
  return sources;
}
