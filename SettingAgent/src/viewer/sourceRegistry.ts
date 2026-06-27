import { CameraClient } from '../clients/CameraClient.js';
import type { ToolsConfig } from '../config/toolsConfig.js';
import type { CameraSource } from './CameraSource.js';
import { SimulatorSource } from './SimulatorSource.js';
import { RealPtzSource } from './RealPtzSource.js';

/**
 * cameraSources 설정 → Map<sourceId, CameraSource> 빌드(설계서 §13.5).
 * 하위호환: cameraSources 미설정 시 camera(단일 sim) 1개를 id='sim' 으로 등록.
 */
export function buildSourceRegistry(cfg: Pick<ToolsConfig, 'camera' | 'cameraSources'>): Map<string, CameraSource> {
  const sources = new Map<string, CameraSource>();

  if (!cfg.cameraSources || cfg.cameraSources.length === 0) {
    // 하위호환: 기존 단일 camera 설정을 sim 소스 1개로.
    sources.set('sim', new SimulatorSource(new CameraClient(cfg.camera)));
    return sources;
  }

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
