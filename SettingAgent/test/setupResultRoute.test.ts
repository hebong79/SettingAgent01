import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { CaptureJob } from '../src/capture/CaptureJob.js';
import { Finalizer } from '../src/capture/Finalizer.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import { SaveStore } from '../src/store/SaveStore.js';
import { writeSetupResultFiles, buildSetupResult, SETUP_RESULT_NAME } from '../src/store/setupResult.js';
import { stringify5 } from '../src/util/round.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { CapturedImage, NormalizedPoint, SetupArtifact } from '../src/domain/types.js';
import type { Repository } from '../src/store/Repository.js';
import type { CameraInfoRow, PlaceInfoRow, PresetPosRow, SlotSetupRow, SlotSetupView } from '../src/capture/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

/**
 * 검증자(qa-tester): 최종 결과물 생성 — DB(slot_setup) → 최종 결과물 파일 2벌.
 * 대상: `writeSetupResultFiles`(공통 진입점) + `POST /capture/setup-result`.
 * 뷰어의 'result 파일 생성' 버튼은 2026-07-24 제거(센터라이징 완료 시 자동 생성이 유일 경로) — 재추가 방지 가드만 남긴다.
 *
 * 불변식: 이력본(Setup_*)과 고정본(setup_result)의 **내용이 동일**하고, 둘 다 DB 정본을 그대로 반영한다.
 * 센터라이징 잡 done 경로도 같은 함수를 쓰므로 수동/자동 산출이 갈리지 않는다.
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
const fakeRepo = (): Repository => {
  const saved: SetupArtifact[] = [];
  return { saveArtifact: (a: SetupArtifact) => saved.push(a), loadArtifact: () => saved.at(-1) ?? null, path: 'mem' } as unknown as Repository;
};

const rectPoly = (x: number, y: number, w: number, h: number): NormalizedPoint[] => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];
const placeRow = (): PlaceInfoRow => ({ placeId: 1, placeName: 'Place01' });
const cameraRow = (): CameraInfoRow => ({
  camId: 1, camName: null, camUuid: null, url: null, userId: null, password: null, rtspUrl: null,
  camType: 'ptz', camCompany: null, placeId: 1, imgW: 1920, imgH: 1080, updatedAt: 'T',
});
const presetRow = (): PresetPosRow => ({ camId: 1, presetId: 1, sname: null, pan: 0, tilt: 0, zoom: 1, updatedAt: 'T' });
const slotRow = (slotId: number, over: Partial<SlotSetupRow> = {}): SlotSetupRow => ({
  slotId, camId: 1, presetId: 1, presetSlotIdx: slotId,
  slotRoi: JSON.stringify(rectPoly(0.1 * slotId, 0.3, 0.15, 0.15)),
  vpdBbox: null, lpdObb: null, occupyRange: null,
  pan: null, tilt: null, zoom: null, centered: 0, img1: null, slot3dFrontCenter: null, updatedAt: 'T', ...over,
});

let dirs: string[] = [];
let app: FastifyInstance | undefined;
let store: SqliteStore | undefined;
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  if (store) { store.close(); store = undefined; }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function makeServer() {
  const dir = mkdtempSync(join(tmpdir(), 'setupresult-'));
  dirs.push(dir);
  const saveDir = join(dir, 'save');
  const s = new SqliteStore(':memory:');
  const saveStore = new SaveStore(saveDir);
  const queue: Array<() => void> = [];
  const job = new CaptureJob({
    camera: fakeCamera(), vpd: fakeVpd(), cfg: captureCfg, lpdEnabled: false,
    setTimer: (fn) => { queue.push(fn); return queue as unknown as NodeJS.Timeout; },
    clearTimer: () => {}, sleep: async () => {}, now: () => 'T',
  });
  const repo = fakeRepo();
  const finalizer = new Finalizer({ store: s, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
  const orchestrator = new SetupOrchestrator({ camera: fakeCamera(), vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
  const server = buildServer({
    orchestrator, repo, camera: fakeCamera(), vpd: fakeVpd(),
    captureJob: job, finalizer, sqlite: s, capture: captureCfg, saveStore,
  });
  // 2슬롯 시드: 1번은 점유·PTZ 완비, 2번은 미센터라이징(centering=null 기대).
  s.upsertPlaceInfo([placeRow()]);
  s.upsertCameraInfo([cameraRow()]);
  s.upsertPresetPos([presetRow()]);
  s.replaceSlotSetup([
    slotRow(1, {
      occupyRange: JSON.stringify(rectPoly(0.12, 0.34, 0.1, 0.08)),
      pan: 7.68045, tilt: 10.74063, zoom: 8.99252, centered: 1,
    }),
    slotRow(2),
  ]);
  return { app: server, store: s, saveStore, saveDir };
}

describe('POST /capture/setup-result (result 파일 생성 — DB → 파일 2벌)', () => {
  it('DB 정본으로 고정본·이력본을 생성하고 두 파일 내용이 동일하다', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await app.inject({ method: 'POST', url: '/capture/setup-result', payload: {} });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(true);
    expect(body.slots).toBe(2);
    expect(body.fixed).toBe(SETUP_RESULT_NAME);
    expect(body.archive).toMatch(/^Setup_\d{8}_\d{6}$/);

    const fixedPath = join(s.saveDir, `${body.fixed}.json`);
    const archivePath = join(s.saveDir, `${body.archive}.json`);
    expect(existsSync(fixedPath)).toBe(true);
    expect(existsSync(archivePath)).toBe(true);
    expect(readFileSync(archivePath, 'utf-8')).toBe(readFileSync(fixedPath, 'utf-8')); // 동일 내용 2벌.

    // 내용 = buildSetupResult(현재 DB) 그대로(미센터라이징 슬롯은 centering=null — 0 위장 금지).
    const payload = JSON.parse(readFileSync(fixedPath, 'utf-8'));
    // 파일은 stringify5(round5) 직렬화 계약 — 같은 계약으로 비교.
    expect(payload).toEqual(JSON.parse(stringify5(buildSetupResult(s.store.getSlotSetup()))));
    expect(payload.slots[0].centering).toEqual({ pan: 7.68045, tilt: 10.74063, zoom: 8.99252 });
    expect(payload.slots[0].occupy_roi).toHaveLength(4);
    expect(payload.slots[1].centering).toBeNull();
    expect(payload.slots[1].occupy_roi).toBeNull();
  });

  it('재실행: 고정본은 덮어쓰기(1개 유지) · 이력본은 누적된다', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const a = JSON.parse((await app.inject({ method: 'POST', url: '/capture/setup-result', payload: {} })).body);
    // 이력본 이름은 초 단위 — 같은 초에 두 번 눌리면 같은 파일이므로 이름을 직접 달리해 누적을 검증한다.
    writeSetupResultFiles(s.store.getSlotSetup(), s.saveStore, new Date(2026, 6, 21, 1, 2, 3));
    const files = readdirSync(s.saveDir).sort();
    expect(files.filter((f) => f === `${SETUP_RESULT_NAME}.json`)).toHaveLength(1); // 고정본 1개(덮어쓰기).
    expect(files.filter((f) => f.startsWith('Setup_')).length).toBeGreaterThanOrEqual(2); // 이력본 누적.
    expect(a.fixed).toBe(SETUP_RESULT_NAME);
  });

  it('DB 가 비면 slots 0 으로 파일은 생성된다(빈 결과를 숨기지 않음)', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    s.store.replaceSlotSetup([]);
    const r = await app.inject({ method: 'POST', url: '/capture/setup-result', payload: {} });
    expect(JSON.parse(r.body)).toMatchObject({ ok: true, slots: 0 });
    expect(JSON.parse(readFileSync(join(s.saveDir, `${SETUP_RESULT_NAME}.json`), 'utf-8'))).toEqual({ slots: [] });
  });
});

describe('writeSetupResultFiles (공통 진입점 — 잡 done 경로와 공유)', () => {
  const view = (over: Partial<SlotSetupView> = {}): SlotSetupView => ({
    slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1, presetKey: '1:1',
    roi: rectPoly(0.1, 0.3, 0.15, 0.15), vpd: null, lpd: null, occupyRange: null,
    pan: null, tilt: null, zoom: null, centered: false, img1: null, slot3dFrontCenter: null, updatedAt: null, ...over,
  });

  it('한쪽 저장이 실패해도 다른 쪽은 기록되고, 실패는 null 로 보고된다(위장 성공 금지)', () => {
    const calls: string[] = [];
    const flaky = {
      saveSnapshot: (name: string) => {
        calls.push(name);
        if (name.startsWith('Setup_')) throw new Error('disk full');
        return name;
      },
    } as unknown as SaveStore;
    const out = writeSetupResultFiles([view()], flaky, new Date(2026, 6, 21, 1, 2, 3));
    expect(out.archive).toBeNull();
    expect(out.fixed).toBe(SETUP_RESULT_NAME);
    expect(calls).toEqual(['Setup_20260721_010203', SETUP_RESULT_NAME]);
    expect(out.result.slots).toHaveLength(1);
  });
});

describe('뷰어 — result 파일 생성 버튼 제거(자동 저장이 유일 경로)', () => {
  const appJs = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf-8');
  const html = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf-8');

  it('버튼과 핸들러가 존재하지 않는다', () => {
    expect(html).not.toContain('cal-result-file');
    expect(appJs).not.toContain('makeSetupResultFile');
  });
});
