import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/api/server.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import { writeCamerapos } from '../src/setup/cameraposWriter.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { CapturedImage } from '../src/domain/types.js';
import type { PresetProvider } from '../src/setup/presetProvider.js';
import type { CameraView } from '../src/setup/mapTargets.js';

const setupCfg = {
  presetSettleMs: 0, betweenPresetMs: 0, minConfidence: 0.5, roiPadding: 0, yBandTolerance: 0.1,
  accumFrames: 1, accumIntervalMs: 0, clusterDist: 0.06, clusterMinSupport: 1, lpdEnabled: false,
};
const fakeCamera = () => ({
  health: async () => true,
  requestImage: async (c: number, p: number): Promise<CapturedImage> => ({ camIdx: c, presetIdx: p, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('f') }),
} as unknown as CameraClient);
const fakeVpd = () => ({ health: async () => true, detect: async () => [] } as unknown as VpdClient);
const fakeRepo = () => ({ saveArtifact: () => {}, loadArtifact: () => null, path: 'mem' } as unknown as Repository);

/** 호출 횟수를 세는 가짜 공급자. */
function spyProvider(views: CameraView[]): PresetProvider & { calls: number } {
  return { name: 'fake', calls: 0, async listViews() { this.calls++; return views; } } as PresetProvider & { calls: number };
}

function mk(refreshOnRun: boolean, cposPath: string, provider: PresetProvider) {
  const camera = fakeCamera();
  const orchestrator = new SetupOrchestrator({ camera, vpd: fakeVpd(), repo: fakeRepo(), cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
  return buildServer({
    orchestrator, repo: fakeRepo(), camera, vpd: fakeVpd(),
    mapFiles: { cameraposFile: cposPath }, discovery: { enabled: false, maxCameras: 8, maxPresetsPerCamera: 8 },
    presetProvider: provider, refreshOnRun,
  });
}

describe('run-from-map 자동 갱신(refreshOnRun)', () => {
  it('refreshOnRun=true → 공급자로 camerapos 갱신 후 그 목록으로 셋업', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ref-'));
    try {
      const cpos = join(dir, 'camerapos.json');
      const provider = spyProvider([
        { camIdx: 1, presetIdx: 1, label: 'P1', pan: 22, tilt: 6, zoom: 1.6 },
        { camIdx: 1, presetIdx: 2, label: 'P2', pan: 56, tilt: 7, zoom: 1.9 },
      ]);
      const app = mk(true, cpos, provider);
      const r = await app.inject({ method: 'POST', url: '/setup/run-from-map' });
      const body = JSON.parse(r.body);
      expect(r.statusCode).toBe(200);
      expect(body.refreshed).toBe('fake');     // 갱신됨
      expect(body.loadedTargets).toBe(2);       // 갱신된 camerapos 의 2건 사용
      expect(provider.calls).toBe(1);
      expect(existsSync(cpos)).toBe(true);       // 파일 생성됨
      expect(readFileSync(cpos, 'utf-8')).toContain('preset_id');
      await app.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refreshOnRun=false → 공급자 호출 안 함, 기존 camerapos 사용', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ref-'));
    try {
      const cpos = join(dir, 'camerapos.json');
      // 기존 파일 1건 미리 작성
      writeCamerapos([{ camIdx: 1, presetIdx: 1, label: 'M1', pan: 10, tilt: 5, zoom: 2 }], cpos);
      const provider = spyProvider([{ camIdx: 9, presetIdx: 9, label: 'X' }]);
      const app = mk(false, cpos, provider);
      const r = await app.inject({ method: 'POST', url: '/setup/run-from-map' });
      const body = JSON.parse(r.body);
      expect(body.refreshed).toBe(false);
      expect(body.loadedTargets).toBe(1);       // 기존 파일(1건) 사용
      expect(provider.calls).toBe(0);           // 공급자 미호출
      await app.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
