import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import { buildSourceRegistry } from '../src/viewer/sourceRegistry.js';
import { DEFAULT_TOOLS_CONFIG } from '../src/config/toolsConfig.js';
import { analyzeArtifact } from '../web/core.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { SqliteStore } from '../src/capture/SqliteStore.js';
import type { SlotSetupView } from '../src/capture/types.js';
import type { SetupArtifact, NormalizedPoint, NormalizedQuad } from '../src/domain/types.js';

/**
 * 검증자(qa-tester): GET /mapping·/viewer/api/mapping 의 파일↔DB 폴백(resolveMapping).
 * 설계서 §6.2 — 파일부재+DB→200 조립 / 파일우선(DB무시) / 빈파일+DB→조립 / 빈+빈→404 / sqlite미주입→404 / shape parity.
 * 기존 mappingDirect.test.ts 하네스(stubRepo/mk)를 재사용·확장(fake sqlite 주입).
 */

const setupCfg = {
  presetSettleMs: 0, betweenPresetMs: 0, minConfidence: 0.5, roiPadding: 0, yBandTolerance: 0.1,
  accumFrames: 1, accumIntervalMs: 0, clusterDist: 0.06, clusterMinSupport: 1, lpdEnabled: false,
};
const fakeCamera = () => ({ health: async () => true } as unknown as CameraClient);
const fakeVpd = () => ({ health: async () => true, detect: async () => [] } as unknown as VpdClient);

/** loadArtifact 가 주입된 산출물(또는 null)을 반환하는 repo 스텁. */
const stubRepo = (artifact: SetupArtifact | null): Repository =>
  ({ saveArtifact: () => {}, loadArtifact: () => artifact, path: 'mem' } as unknown as Repository);

/** getSlotSetup 만 노출하는 fake SqliteStore. resolveMapping 은 이 메서드만 호출(순수 읽기). */
const stubSqlite = (views: SlotSetupView[]): SqliteStore =>
  ({ getSlotSetup: () => views } as unknown as SqliteStore);

const poly = (pts: [number, number][]): NormalizedPoint[] => pts.map(([x, y]) => ({ x, y }));
const quad = (pts: [number, number][]): NormalizedQuad =>
  pts.map(([x, y]) => ({ x, y })) as unknown as NormalizedQuad;

/** SlotSetupView fixture. */
const view = (o: Partial<SlotSetupView> & Pick<SlotSetupView, 'slotId' | 'camId' | 'presetId'>): SlotSetupView => ({
  presetSlotIdx: null,
  presetKey: `${o.camId}:${o.presetId}`,
  roi: poly([[0.2, 0.3], [0.6, 0.3], [0.6, 0.7], [0.2, 0.7]]),
  vpd: null,
  lpd: null,
  occupyRange: null,
  pan: null,
  tilt: null,
  zoom: null,
  centered: false,
  img1: null,
  slot3dFrontCenter: null,
  updatedAt: null,
  ...o,
});

/** 헤드리스 buildServer(viewer 미활성, 가벼움). GET /mapping 검증용. */
const mkHeadless = (artifact: SetupArtifact | null, views: SlotSetupView[] | undefined): FastifyInstance => {
  const repo = stubRepo(artifact);
  const orchestrator = new SetupOrchestrator({ camera: fakeCamera(), vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
  return buildServer({
    orchestrator, repo, camera: fakeCamera(), vpd: fakeVpd(),
    ...(views !== undefined ? { sqlite: stubSqlite(views) } : {}),
  });
};

/** 뷰어 활성 buildServer(staticDir 필요). GET /viewer/api/mapping 검증용. */
const mkViewer = (artifact: SetupArtifact | null, views: SlotSetupView[]): { app: FastifyInstance; dir: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'mapdbfb-static-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>SPA</body></html>');
  const repo = stubRepo(artifact);
  const orchestrator = new SetupOrchestrator({ camera: fakeCamera(), vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
  const sources = buildSourceRegistry({ camera: DEFAULT_TOOLS_CONFIG.camera, cameraSources: undefined, unityRpc: DEFAULT_TOOLS_CONFIG.unityRpc, map: DEFAULT_TOOLS_CONFIG.map, cameraMode: 'simulator', realCamera: undefined });
  const app = buildServer({
    orchestrator, repo, camera: fakeCamera(), vpd: fakeVpd(), sqlite: stubSqlite(views),
    viewer: { enabled: true, allowMove: true, defaultFps: 3, staticDir: dir, controlToken: '' },
    sources,
  });
  return { app, dir };
};

let app: FastifyInstance | undefined;
let dir: string | undefined;
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; }
});

describe('GET /mapping — 파일↔DB 폴백(resolveMapping)', () => {
  it('(a) 파일 부재 + DB 2행 → 200 DB조립 artifact', async () => {
    app = mkHeadless(null, [
      view({ slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 0 }),
      view({ slotId: 2, camId: 1, presetId: 1, presetSlotIdx: 1 }),
    ]);
    const r = await app.inject({ method: 'GET', url: '/mapping' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as SetupArtifact;
    expect(body.slots).toHaveLength(2);
    expect(body.presets.length).toBeGreaterThanOrEqual(1);
    expect(body.globalIndex).toHaveLength(2);
    expect(body.slots.map((s) => s.slotId).sort()).toEqual(['1', '2']);
  });

  it('(b) 파일에 slots 존재 → 파일 우선(DB 무시)', async () => {
    const fileArtifact = {
      presets: [{ camIdx: 9, presetIdx: 9, label: 'FILE', coveredSlotIds: ['s-1'] }],
      slots: [{ slotId: 's-1', zone: 'FILEZONE', roiByPreset: { '9:9': { x: 0, y: 0, w: 1, h: 1 } } }],
      globalIndex: [{ globalIdx: 1, slotId: 's-1', camIdx: 9, presetIdx: 9 }],
      createdAt: 'FILE-TS',
    } as unknown as SetupArtifact;
    app = mkHeadless(fileArtifact, [view({ slotId: 99, camId: 1, presetId: 1 })]);
    const r = await app.inject({ method: 'GET', url: '/mapping' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as SetupArtifact;
    expect(body.slots).toHaveLength(1);
    expect(body.slots[0].slotId).toBe('s-1'); // 파일 그대로(DB slotId 99 아님)
    expect(body.slots[0].zone).toBe('FILEZONE');
    expect(body.createdAt).toBe('FILE-TS');
    expect(body.presets[0].label).toBe('FILE');
  });

  it('(c) 파일 존재하나 slots:[] + DB 1행 → DB조립(200)', async () => {
    const emptyFile = { presets: [], slots: [], globalIndex: [], createdAt: 'x' } as unknown as SetupArtifact;
    app = mkHeadless(emptyFile, [view({ slotId: 5, camId: 2, presetId: 3 })]);
    const r = await app.inject({ method: 'GET', url: '/mapping' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as SetupArtifact;
    expect(body.slots).toHaveLength(1);
    expect(body.slots[0].slotId).toBe('5');
    expect(body.slots[0].zone).toBe('cam2');
  });

  it('(d) 파일 부재 + DB 0행 → 404', async () => {
    app = mkHeadless(null, []);
    const r = await app.inject({ method: 'GET', url: '/mapping' });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body)).toEqual({ error: 'no setup artifact' });
  });

  it('(e) sqlite 미주입 + 파일 부재 → 404(옵셔널 가드)', async () => {
    app = mkHeadless(null, undefined);
    const r = await app.inject({ method: 'GET', url: '/mapping' });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body)).toEqual({ error: 'no setup artifact' });
  });

  it('(f) shape parity — DB조립 body 를 analyzeArtifact 가 소비(roi rect·hasPlate·globalIdx 정합)', async () => {
    const lpdQuad = quad([[0.3, 0.35], [0.5, 0.35], [0.5, 0.45], [0.3, 0.45]]);
    app = mkHeadless(null, [
      view({ slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 0, roi: poly([[0.2, 0.3], [0.6, 0.3], [0.6, 0.7], [0.2, 0.7]]), lpd: lpdQuad }),
      view({ slotId: 2, camId: 1, presetId: 1, presetSlotIdx: 1, lpd: null }),
    ]);
    const r = await app.inject({ method: 'GET', url: '/mapping' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    const an = analyzeArtifact(body);
    expect(an.ok).toBe(true);
    expect(an.totals.slots).toBe(2);
    expect(an.totals.withPlate).toBe(1);
    const s1 = an.slots.find((s: { slotId: string }) => s.slotId === '1')!;
    expect(s1.roi!.x).toBeCloseTo(0.2, 10);
    expect(s1.roi!.y).toBeCloseTo(0.3, 10);
    expect(s1.roi!.w).toBeCloseTo(0.4, 10); // 0.6-0.2 (부동소수점)
    expect(s1.roi!.h).toBeCloseTo(0.4, 10); // 0.7-0.3
    expect(s1.hasPlate).toBe(true);
    expect(s1.globalIdx).toBe(1); // globalIndex 정합
    const s2 = an.slots.find((s: { slotId: string }) => s.slotId === '2')!;
    expect(s2.hasPlate).toBe(false);
  });
});

describe('GET /viewer/api/mapping — 동일 resolveMapping 배선', () => {
  it('파일 부재 + DB 1행 → 200 DB조립 artifact', async () => {
    ({ app, dir } = mkViewer(null, [view({ slotId: 1, camId: 1, presetId: 1 })]));
    const r = await app.inject({ method: 'GET', url: '/viewer/api/mapping' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/json');
    const body = JSON.parse(r.body) as SetupArtifact;
    expect(body.slots).toHaveLength(1);
    expect(body.slots[0].slotId).toBe('1');
  });

  it('파일 부재 + DB 0행 → 404 유지', async () => {
    ({ app, dir } = mkViewer(null, []));
    const r = await app.inject({ method: 'GET', url: '/viewer/api/mapping' });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body)).toEqual({ error: 'no setup artifact' });
  });
});
