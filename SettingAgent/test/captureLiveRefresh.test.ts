import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/api/server.js';
import { CaptureJob } from '../src/capture/CaptureJob.js';
import { Finalizer } from '../src/capture/Finalizer.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import { writeCamerapos } from '../src/setup/cameraposWriter.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { CapturedImage } from '../src/domain/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { PresetProvider } from '../src/setup/presetProvider.js';
import type { CameraView } from '../src/setup/mapTargets.js';

/**
 * /capture/start 의 라이브 프리셋 갱신 검증.
 * presetProvider 주입 시: targets 미지정이면 캐시(camerapos.json)가 아니라
 * 공급자(Unity /cameras)에서 매번 새로 받아 사용한다(이전 프리셋 순서 캐싱 제거).
 */

const captureCfg: ToolsConfig['capture'] = {
  defaultCount: 50, intervalMs: 1000, moveIntervalMs: 1000, checkpointEvery: 10,
  checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, dbFile: ':memory:',
  clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5, slotAssignGate: 0.12, moveBeforeCapture: true,
};
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

function makeServer(provider: PresetProvider | undefined, cposPath?: string) {
  const store = new SqliteStore(':memory:');
  const queue: Array<() => void> = [];
  const job = new CaptureJob({
    camera: fakeCamera(), vpd: fakeVpd(), cfg: captureCfg, lpdEnabled: false,
    setTimer: (fn) => { queue.push(fn); return queue as unknown as NodeJS.Timeout; },
    clearTimer: () => {}, sleep: async () => {}, now: () => 'T',
  });
  const finalizer = new Finalizer({ store, repo: fakeRepo(), cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
  const orchestrator = new SetupOrchestrator({ camera: fakeCamera(), vpd: fakeVpd(), repo: fakeRepo(), cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
  const app = buildServer({
    orchestrator, repo: fakeRepo(), camera: fakeCamera(), vpd: fakeVpd(),
    captureJob: job, finalizer, sqlite: store, capture: captureCfg,
    presetProvider: provider, mapFiles: cposPath ? { cameraposFile: cposPath } : undefined,
  });
  return { app, store };
}

let app: FastifyInstance | undefined;
let store: SqliteStore | undefined;
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  if (store) { store.close(); store = undefined; }
});

describe('/capture/start 라이브 프리셋 갱신', () => {
  it('presetProvider 주입 + targets 미지정 → 공급자에서 새로 받아 시작(캐시 미사용)', async () => {
    const provider = spyProvider([
      { camIdx: 1, presetIdx: 1, label: 'P1', pan: 22, tilt: 6, zoom: 1.6 },
      { camIdx: 1, presetIdx: 2, label: 'P2', pan: 56, tilt: 7, zoom: 1.9 },
    ]);
    const s = makeServer(provider); app = s.app; store = s.store;
    const r = await app.inject({ method: 'POST', url: '/capture/start', payload: { count: 3 } });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).ok).toBe(true);
    expect(provider.calls).toBe(1);   // 매 start 마다 라이브 조회
  });

  it('갱신 시 camerapos.json 도 새 목록으로 덮어씀(캐시 갱신)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cap-ref-'));
    try {
      const cpos = join(dir, 'camerapos.json');
      // 옛 캐시(프리셋 9) 미리 작성 → 갱신 후 사라져야 함
      writeCamerapos([{ camIdx: 9, presetIdx: 9, label: 'OLD', pan: 1, tilt: 1, zoom: 1 }], cpos);
      const provider = spyProvider([{ camIdx: 1, presetIdx: 1, label: 'NEW', pan: 22, tilt: 6, zoom: 1.6 }]);
      const s = makeServer(provider, cpos); app = s.app; store = s.store;
      const r = await app.inject({ method: 'POST', url: '/capture/start', payload: { count: 3 } });
      expect(r.statusCode).toBe(200);
      expect(provider.calls).toBe(1);
      expect(existsSync(cpos)).toBe(true);
      const txt = readFileSync(cpos, 'utf-8');
      expect(txt).toContain('NEW');           // 새 목록 반영
      expect(txt).not.toContain('OLD');        // 옛 캐시 제거
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('명시 targets 제공 시에는 공급자 호출 안 함(우선순위 유지)', async () => {
    const provider = spyProvider([{ camIdx: 1, presetIdx: 1, label: 'P1' }]);
    const s = makeServer(provider); app = s.app; store = s.store;
    const r = await app.inject({ method: 'POST', url: '/capture/start', payload: { count: 3, targets: [{ camIdx: 2, presetIdx: 5 }] } });
    expect(r.statusCode).toBe(200);
    expect(provider.calls).toBe(0);   // 명시 targets 우선
  });
});
