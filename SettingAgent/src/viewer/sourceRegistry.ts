import { CameraClient } from '../clients/CameraClient.js';
import { CRpcClient } from '../clients/CRpcClient.js';
import type { ToolsConfig } from '../config/toolsConfig.js';
import type { CameraSource } from './CameraSource.js';
import { SimulatorSource } from './SimulatorSource.js';
import { RealPtzSource } from './RealPtzSource.js';
import { RpcCameraSource } from './RpcCameraSource.js';
import { CameraposSource } from './CameraposSource.js';
import { RtspFfmpegAdapter } from '../stream/RtspFfmpegAdapter.js';

const DEFAULT_STREAMING = {
  ffmpegPath: 'ffmpeg', rtspTransport: 'tcp' as const, fps: 5, jpegQuality: 5, startupTimeoutMs: 10_000,
};

function rtspAdapter(
  src: NonNullable<ToolsConfig['realCamera']>,
  streaming?: ToolsConfig['cameraStreaming'],
): RtspFfmpegAdapter {
  if (!src.rtspUrl) throw new Error(`실카메라(${src.id}) RTSP URL이 없습니다`);
  return new RtspFfmpegAdapter({
    rtspUrl: src.rtspUrl,
    username: src.username,
    password: src.password,
    ...(streaming ?? DEFAULT_STREAMING),
  });
}

/**
 * cameraSources 설정 → Map<sourceId, CameraSource> 빌드(설계서 §13.5).
 * 기본 폴백: cameraSources 미설정 시 camerapos 소스(id='rpc') 1개를 등록(설계서 §3).
 * (뷰어 카메라/프리셋 = camerapos.json[카메라 PTZ 프리셋]. device 제어는 RpcCameraSource 합성 위임:
 *  list/move/snapshot=/rpc, stream=/stream(CameraClient) 위임.)
 */
export function buildSourceRegistry(
  cfg: Pick<ToolsConfig, 'camera' | 'cameraSources' | 'unityRpc' | 'map' | 'cameraMode' | 'realCamera'> &
    Partial<Pick<ToolsConfig, 'cameraRuntime' | 'cameraStreaming'>>,
): Map<string, CameraSource> {
  const sources = new Map<string, CameraSource>();

  // (A) 고급/다중: cameraSources 명시(길이>0) → 기존 경로 그대로. cameraMode 무시(precedence).
  if (cfg.cameraSources && cfg.cameraSources.length > 0) {
    const selectedId = cfg.cameraRuntime?.selectedCameraId;
    const ordered = selectedId
      ? [...cfg.cameraSources].sort((a, b) => Number(b.id === selectedId) - Number(a.id === selectedId))
      : cfg.cameraSources;
    for (const src of ordered) {
      if (src.kind === 'sim') {
        if (src.protocol === 'unity-rpc') {
          const rpc = new CRpcClient({ ...cfg.unityRpc, baseUrl: src.baseUrl ?? cfg.unityRpc.baseUrl });
          const inner = new RpcCameraSource(rpc, new CameraClient({ ...cfg.camera, baseUrl: src.baseUrl ?? cfg.camera.baseUrl }));
          sources.set(src.id, new CameraposSource(cfg.map.cameraposFile, inner, rpc));
        } else {
          // 레거시 기본은 REST(/req_img,/req_move,/cameras). 신규 설정은 protocol을 명시한다.
          const cam = new CameraClient({ ...cfg.camera, baseUrl: src.baseUrl ?? cfg.camera.baseUrl });
          sources.set(src.id, new SimulatorSource(cam));
        }
      } else {
        sources.set(src.id, new RealPtzSource(src, cfg.camera.imageTimeoutMs, rtspAdapter(src, cfg.cameraStreaming)));
      }
    }
    return sources;
  }

  // (B) 단일 소스: cameraMode 로 선택(cameraSources 미설정/빈배열).
  if (cfg.cameraMode === 'real') {
    // 리얼은 opt-in·미검증 — 미설정 시 조용한 폴백 대신 fail-fast 로 오설정을 드러낸다.
    if (!cfg.realCamera) throw new Error('리얼 카메라(realCamera) 설정이 없습니다');
    const rc = { ...cfg.realCamera, kind: 'hucoms' as const };
    sources.set(rc.id, new RealPtzSource(rc, cfg.camera.imageTimeoutMs, rtspAdapter(rc, cfg.cameraStreaming)));
    return sources;
  }

  // 'simulator'(기본) → 현재 폴백: camerapos 소스(파일 기반 목록 + RpcCameraSource 합성으로 device 제어 위임).
  const rpc = new CRpcClient(cfg.unityRpc);
  const inner = new RpcCameraSource(rpc, new CameraClient(cfg.camera));
  sources.set('rpc', new CameraposSource(cfg.map.cameraposFile, inner, rpc));
  return sources;
}
