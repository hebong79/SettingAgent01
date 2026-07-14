import type { ICameraClient } from '../clients/CameraClient.js';
import type { ToolsConfig } from '../config/toolsConfig.js';
import type { CameraView } from './mapTargets.js';
import { discoverViews } from './discover.js';
import { fetchWithTimeout } from '../util/http.js';

/**
 * 프리셋 공급자(provider). camerapos.json(표준 포맷)을 채울 카메라/프리셋 목록의 출처를 추상화한다.
 * - 수동: 파일을 직접 작성(휴컴스처럼 벤더 API 가 프리셋을 안 줄 때).
 * - B(자동탐색): DiscoveryPresetProvider.
 * - A(벤더 API): 프리셋 목록을 주는 카메라/VMS 별로 이 인터페이스를 구현(예: OnvifPresetProvider).
 *
 * 어느 공급자든 listViews() 결과를 camerapos.json 으로 저장하면 이후 셋업은 파일(A)로 동작한다.
 */
export interface PresetProvider {
  readonly name: string;
  listViews(): Promise<CameraView[]>;
}

/** B(자동 탐색) 공급자. 카메라 probing 으로 목록 구성. */
export class DiscoveryPresetProvider implements PresetProvider {
  readonly name = 'discovery';
  constructor(
    private camera: ICameraClient,
    private opts: ToolsConfig['discovery'],
    private log?: (msg: string) => void,
  ) {}
  listViews(): Promise<CameraView[]> {
    return discoverViews(this.camera, this.opts, this.log);
  }
}

/** Unity 서버 `GET /cameras` 응답(A타입 명세). */
interface UnityCamerasResponse {
  cameras: Array<{
    camIdx: number;
    name?: string;
    enabled?: boolean;
    presets: Array<{ presetIdx: number; label?: string; pan?: number; tilt?: number; zoom?: number }>;
  }>;
}

/**
 * A(서버 목록 API) 공급자. Unity 서버의 `GET /cameras` 로 카메라/프리셋(+PTZ)을 정확히 가져온다.
 * (probing 과 달리 서버가 정확한 프리셋 수를 알려주므로 과다/과소 탐색 없음.)
 * 다른 벤더도 동일 응답을 주면 이 공급자를 그대로 쓰거나, 매핑만 다른 공급자를 추가하면 된다.
 */
export class UnityPresetProvider implements PresetProvider {
  readonly name = 'unity-api';
  private readonly baseUrl: string;
  constructor(baseUrl: string, private timeoutMs: number) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }
  async listViews(): Promise<CameraView[]> {
    const res = await fetchWithTimeout(`${this.baseUrl}/cameras`, { method: 'GET' }, this.timeoutMs);
    if (!res.ok) throw new Error(`GET /cameras 실패: HTTP ${res.status}`);
    const body = (await res.json()) as UnityCamerasResponse;
    const views: CameraView[] = [];
    for (const c of body.cameras ?? []) {
      if (c.enabled === false) continue;
      for (const p of c.presets ?? []) {
        views.push({
          camIdx: c.camIdx,
          presetIdx: p.presetIdx,
          label: p.label ?? `C${c.camIdx}-P${p.presetIdx}`,
          pan: p.pan,
          tilt: p.tilt,
          zoom: p.zoom,
        });
      }
    }
    return views;
  }
}

export interface ProviderDeps {
  camera: ICameraClient;
  discovery: ToolsConfig['discovery'];
  cameraBaseUrl: string;
  timeoutMs: number;
  log?: (msg: string) => void;
}

/**
 * presetProvider 설정으로 공급자를 생성. 'camerapos'(수동 파일)는 export 대상이 아니므로 null.
 */
export function createPresetProvider(cfg: ToolsConfig['presetProvider'], deps: ProviderDeps): PresetProvider | null {
  switch (cfg.type) {
    case 'discovery':
      return new DiscoveryPresetProvider(deps.camera, deps.discovery, deps.log);
    case 'unity-api':
      return new UnityPresetProvider(cfg.unityUrl || deps.cameraBaseUrl, deps.timeoutMs);
    case 'camerapos':
    default:
      return null;
  }
}
