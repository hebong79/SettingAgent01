import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { CaptureJob } from '../src/capture/CaptureJob.js';
import { Finalizer } from '../src/capture/Finalizer.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import { buildOccupyRegionsBySlot } from '../src/domain/occupancyRegion.js';
import { rectToQuad } from '../src/domain/geometry.js';
import { stringify5 } from '../src/util/round.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { CapturedImage, NormalizedPoint, NormalizedQuad, SetupArtifact } from '../src/domain/types.js';
import type { Repository } from '../src/store/Repository.js';
import type { CameraInfoRow, PlaceInfoRow, PresetInfoRow, SlotSetupRow } from '../src/capture/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

/**
 * 검증자(qa-tester): LPD 검지 패널 "점유영역 생성" — DB slot_setup.lpd → occupy_range 결정형 재생성.
 * 대상: `buildOccupyRangeFromPlate`(floorRoi.ts 공통 진입점) + `POST /capture/slots/occupy`(captureRoutes.ts)
 *       + 뷰어 결선(#occupy-build).
 *
 * 핵심 불변식(회귀 위험 지점):
 *  - lpd 없는 슬롯은 **무접촉**(기존 occupy_range 보존 — 위장 생성·wipe 금지, 메모리 노트 "finalize wipe fragility").
 *  - cam/preset 지정 시 그 프리셋만. 타 프리셋·타 컬럼(vpd/roi/센터링) 불변.
 *  - 생성식은 discovery(PlateDiscoveryJob)와 **같은 함수** → 두 경로 결과 동일(테스트가 상수를 재현하지 않는다).
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

function makeServer() {
  const store = new SqliteStore(':memory:');
  const queue: Array<() => void> = [];
  const job = new CaptureJob({
    camera: fakeCamera(), vpd: fakeVpd(), cfg: captureCfg, lpdEnabled: false,
    setTimer: (fn) => { queue.push(fn); return queue as unknown as NodeJS.Timeout; },
    clearTimer: () => {}, sleep: async () => {}, now: () => 'T',
  });
  const repo = fakeRepo();
  const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
  const orchestrator = new SetupOrchestrator({ camera: fakeCamera(), vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
  const app = buildServer({
    orchestrator, repo, camera: fakeCamera(), vpd: fakeVpd(),
    captureJob: job, finalizer, sqlite: store, capture: captureCfg,
  });
  return { app, store };
}

let app: FastifyInstance | undefined;
let store: SqliteStore | undefined;
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  if (store) { store.close(); store = undefined; }
});

const rectPoly = (x: number, y: number, w: number, h: number): NormalizedPoint[] => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];
const plateAt = (cx: number, cy: number, w = 0.03, h = 0.012): NormalizedQuad =>
  rectToQuad({ x: cx - w / 2, y: cy - h / 2, w, h });

const placeRow = (): PlaceInfoRow => ({ placeId: 1, placeName: 'Place01' });
const cameraRow = (): CameraInfoRow => ({
  camId: 1, camName: null, camUuid: null, url: null, userId: null, password: null, rtspUrl: null,
  camType: 'ptz', camCompany: null, placeId: 1, imgW: 1920, imgH: 1080, updatedAt: 'T',
});
const presetRow = (presetId = 1): PresetInfoRow => ({ camId: 1, presetId, presetName: null, placeId: 1, pan: 0, tilt: 0, zoom: 1, updatedAt: 'T' });
const slotRow = (slotId: number, presetId: number, over: Partial<SlotSetupRow> = {}): SlotSetupRow => ({
  slotId, camId: 1, presetId, presetSlotIdx: slotId,
  slotRoi: JSON.stringify(rectPoly(0.1 * slotId, 0.3, 0.15, 0.15)),
  vpdBbox: null, lpdObb: null, occupyRange: null,
  pan: null, tilt: null, zoom: null, centered: 0, img1: null, slot3dFrontCenter: null, updatedAt: 'T-orig', ...over,
});

/** slot1=lpd만 · slot2=lpd+기존occupy · slot3=lpd없음+기존occupy · slot4=타 프리셋(lpd 보유). */
const OLD_OCCUPY = JSON.stringify(rectPoly(0.8, 0.8, 0.05, 0.05));
function seed(s: SqliteStore) {
  s.upsertPlaceInfo([placeRow()]);
  s.upsertCameraInfo([cameraRow()]);
  s.upsertPresetInfo([presetRow(1)]);
  s.upsertPresetInfo([presetRow(2)]);
  s.replaceSlotSetup([
    slotRow(1, 1, { lpdObb: stringify5(plateAt(0.20, 0.50)) }),
    slotRow(2, 1, { lpdObb: stringify5(plateAt(0.40, 0.52)), occupyRange: OLD_OCCUPY, vpdBbox: JSON.stringify({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 }) }),
    slotRow(3, 1, { occupyRange: OLD_OCCUPY }),
    slotRow(4, 2, { lpdObb: stringify5(plateAt(0.60, 0.54)) }),
  ]);
}

describe('buildOccupyRegionsBySlot (외부 사용 진입점 — 번호판 기준 사다리꼴)', () => {
  it('번호판보다 훨씬 크고(폭 ≥3.5배) 판을 품는 영역을 결정형 생성(같은 입력 → 같은 출력)', () => {
    const q = plateAt(0.4, 0.5);
    const a = buildOccupyRegionsBySlot([{ slotId: 1, quad: q }]);
    const b = buildOccupyRegionsBySlot([{ slotId: 1, quad: q }]);
    const poly = a.get(1)!;
    expect(poly.length).toBeGreaterThanOrEqual(4);
    expect([...a]).toEqual([...b]);
    // 판 폭(0.03) 대비 영역 폭이 3.5배 이상 — '판 크기 박스' 회귀 방지(마스터 지적 2026-07-21).
    const xs = poly.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.03 * 3.4);
    for (const p of poly) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
    }
  });
});

describe('POST /capture/slots/occupy (점유영역 생성 — 실DB 왕복)', () => {
  it('cam/preset 지정: lpd 보유 슬롯만 갱신 · lpd 없는 슬롯·타 프리셋·타 컬럼 무접촉', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    seed(s.store);

    const r = await app.inject({ method: 'POST', url: '/capture/slots/occupy', payload: { cam: 1, preset: 1 } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body).toMatchObject({ ok: true, updated: 2, skipped: 1, failed: 0 });

    const rows = s.store.getSlotSetup();
    const v = (id: number) => rows.find((x) => x.slotId === id)!;
    // (a)(b) 생성값 = 외부 진입점 결과(프리셋 단위 집합 연산 + round5 영속화 계약).
    const expected = buildOccupyRegionsBySlot([1, 2].map((id) => ({ slotId: id, quad: v(id).lpd! })));
    expect(v(1).occupyRange).toEqual(JSON.parse(stringify5(expected.get(1)!)));
    expect(v(2).occupyRange).toEqual(JSON.parse(stringify5(expected.get(2)!)));
    expect(v(2).occupyRange).not.toEqual(JSON.parse(OLD_OCCUPY)); // 기존 occupy 는 새 값으로 재생성.
    // (c) lpd 없는 슬롯 → 기존 occupy_range 보존(위장 생성·wipe 금지).
    expect(v(3).occupyRange).toEqual(JSON.parse(OLD_OCCUPY));
    expect(v(3).updatedAt).toBe('T-orig');
    // (d) 타 프리셋 슬롯 불변.
    expect(v(4).occupyRange).toBeNull();
    expect(v(4).updatedAt).toBe('T-orig');
    // (e) lpd·vpd·roi 등 타 컬럼 불변.
    expect(v(2).vpd).toEqual({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 });
    expect(v(1).lpd).toEqual(JSON.parse(stringify5(plateAt(0.20, 0.50))));
    expect(v(1).roi).toHaveLength(4);
  });

  it('cam/preset 미지정(빈 body): 전 프리셋의 lpd 보유 슬롯 갱신', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    seed(s.store);
    const r = await app.inject({ method: 'POST', url: '/capture/slots/occupy', payload: {} });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ ok: true, updated: 3, skipped: 1 });
    expect(s.store.getSlotSetup().find((x) => x.slotId === 4)!.occupyRange).not.toBeNull();
  });

  it('lpd 가 하나도 없으면 updated 0 (DB 무변경)', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    s.store.upsertPlaceInfo([placeRow()]);
    s.store.upsertCameraInfo([cameraRow()]);
    s.store.upsertPresetInfo([presetRow(1)]);
    s.store.replaceSlotSetup([slotRow(1, 1, { occupyRange: OLD_OCCUPY })]);
    const r = await app.inject({ method: 'POST', url: '/capture/slots/occupy', payload: { cam: 1, preset: 1 } });
    expect(JSON.parse(r.body)).toMatchObject({ ok: true, updated: 0, skipped: 1 });
    expect(s.store.getSlotSetup()[0].occupyRange).toEqual(JSON.parse(OLD_OCCUPY));
  });

  it('잘못된 body → 400 (cam 비양수 / preset 소수)', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    for (const payload of [{ cam: 0, preset: 1 }, { cam: 1, preset: 1.5 }]) {
      const r = await app.inject({ method: 'POST', url: '/capture/slots/occupy', payload });
      expect(r.statusCode).toBe(400);
      expect(JSON.parse(r.body).ok).toBe(false);
    }
  });

  it('GET /capture/slots(뷰어 소비 경로)로도 생성 결과가 노출된다', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    seed(s.store);
    await app.inject({ method: 'POST', url: '/capture/slots/occupy', payload: { cam: 1, preset: 1 } });
    const r = await app.inject({ method: 'GET', url: '/capture/slots' });
    const view = JSON.parse(r.body).find((x: { slotId: number }) => x.slotId === 1);
    expect(view.occupyRange).toHaveLength(4);
  });
});

describe('뷰어 결선(#occupy-build)', () => {
  const appJs = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf-8');
  const html = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf-8');

  it('LPD 검지 패널에 "점유영역 생성" 버튼이 있고 핸들러가 결선돼 있다', () => {
    expect(html).toMatch(/<button id="occupy-build"[^>]*>점유영역 생성<\/button>/);
    expect(appJs).toContain("$('occupy-build').addEventListener('click', buildOccupyRange)");
  });

  it('핸들러는 /capture/slots/occupy 로 현재 cam/preset 을 보내고 오버레이를 갱신한다', () => {
    const fn = appJs.slice(appJs.indexOf('async function buildOccupyRange('));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain("'/capture/slots/occupy'");
    expect(body).toMatch(/cam: Number\(cam\), preset: Number\(preset\)/);
    expect(body).toContain('await loadParkingSlots()');
    expect(body).toContain('drawRoiOverlay()');
  });
});
