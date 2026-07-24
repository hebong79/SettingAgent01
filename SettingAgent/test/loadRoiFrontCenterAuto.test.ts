import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { CaptureJob } from '../src/capture/CaptureJob.js';
import { Finalizer } from '../src/capture/Finalizer.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import { buildSlotFrontCenters } from '../src/ground/frontCenterBuild.js';
import { H_CONST } from '../src/ground/slotFrontCenter.js';
import { rectToQuad } from '../src/domain/geometry.js';
import { stringify5 } from '../src/util/round.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { CapturedImage, SetupArtifact } from '../src/domain/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { SlotSetupRow, SlotSetupView } from '../src/capture/types.js';

/**
 * 검증자(qa-tester): W6 `buildSlotFrontCenters` 자동 호출 (설계서 §11.1 U11·U12·U13·U14).
 *
 *   U11 ROI 파일 로딩이 slot3d_front_center 를 **자동으로** 채운다(LPD 탐색 대상 조건 = 이 컬럼).
 *   U12 지면모델 미주입/비활성이어도 로딩은 **200·ok:true** 로 살아있고 issues[] 로만 강등된다.
 *   U13 자동 W6 경로의 부작용은 slot3d_front_center **단일 컬럼**에 갇힌다(전 컬럼 비교로 봉인).
 *   U14 자동 경로 결과 == 수동 `3D육면체 ROI생성` 버튼(heightM 미지정) 결과 — 같은 W6·같은 H_CONST.
 *
 * 실데이터 파일 미접촉: DB 는 :memory:, ROI·camerapos 는 동결 픽스처를 os.tmpdir() 로 복사해 쓴다.
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
const groundCfg: ToolsConfig['ground'] = { enabled: true, minDepthEdgePx: 250, slotWidthM: 2.5, slotDepthM: 5.0 };

const fakeCamera = () => ({
  health: async () => true,
  requestImage: async (c: number, p: number): Promise<CapturedImage> => ({ camIdx: c, presetIdx: p, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('f') }),
} as unknown as CameraClient);
const fakeVpd = () => ({ health: async () => true, detect: async () => [] } as unknown as VpdClient);
const fakeRepo = (): Repository => {
  const saved: SetupArtifact[] = [];
  return { saveArtifact: (a: SetupArtifact) => saved.push(a), loadArtifact: () => saved.at(-1) ?? null, path: 'mem' } as unknown as Repository;
};

const REAL_PLACE_ROI = readFileSync(fileURLToPath(new URL('./fixtures/PtzCamRoi.unity.json', import.meta.url)), 'utf8');
const REAL_CAMERAPOS = readFileSync(fileURLToPath(new URL('./fixtures/camerapos.sample.json', import.meta.url)), 'utf8');

const dirs: string[] = [];
function fixture(): { placeRoiFile: string; cameraposFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'loadroi-fc-'));
  dirs.push(dir);
  const placeRoiFile = join(dir, 'PtzCamRoi.json');
  const cameraposFile = join(dir, 'camerapos.json');
  writeFileSync(placeRoiFile, REAL_PLACE_ROI, 'utf8');
  writeFileSync(cameraposFile, REAL_CAMERAPOS, 'utf8');
  return { placeRoiFile, cameraposFile };
}

const apps: FastifyInstance[] = [];
const stores: SqliteStore[] = [];

function makeServer(opts: { placeRoiFile: string; cameraposFile?: string; ground?: ToolsConfig['ground']; store?: SqliteStore }) {
  const store = opts.store ?? new SqliteStore(':memory:');
  if (!opts.store) stores.push(store);
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
    placeRoiFile: opts.placeRoiFile,
    mapFiles: opts.cameraposFile ? { cameraposFile: opts.cameraposFile } : undefined,
    ground: opts.ground,
  });
  apps.push(app);
  return { app, store };
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
  while (stores.length) stores.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** slotId → slot3dFrontCenter(정규화 좌표) 맵. */
function frontCenters(store: SqliteStore): Map<number, { x: number; y: number } | null> {
  return new Map(store.getSlotSetup().map((v) => [v.slotId, v.slot3dFrontCenter]));
}
/** 슬롯 신원(카메라·프리셋·프리셋내 순번) 기준 키 — 서버가 달라도 대조 가능. */
function frontCentersByIdentity(store: SqliteStore): Map<string, { x: number; y: number } | null> {
  return new Map(store.getSlotSetup().map((v) => [`${v.camId}:${v.presetId}:${v.presetSlotIdx}`, v.slot3dFrontCenter]));
}

// ══════════════════════════════════════════════════════════════════
// U11 — 자동 산출
// ══════════════════════════════════════════════════════════════════
describe('U11. load-roi 자동 W6 — slot3d_front_center 가 채워진다', () => {
  it('200 ok:true + issues 에 산출 요약(h=1.5m) + 유효 슬롯 front_center non-null', async () => {
    const f = fixture();
    const s = makeServer({ ...f, ground: groundCfg });
    const r = await s.app.inject({ method: 'POST', url: '/capture/slots/load-roi' });

    expect(r.statusCode).toBe(200);
    const b = JSON.parse(r.body);
    expect(b.ok).toBe(true);
    expect(b.slots).toBeGreaterThan(0);
    const summary = (b.issues as string[]).find((i) => i.startsWith('앞면 중심 산출'));
    expect(summary, `issues=${JSON.stringify(b.issues)}`).toBeDefined();
    expect(summary).toContain(`h=${H_CONST}m`);

    const fc = frontCenters(s.store);
    const nonNull = [...fc.values()].filter((v) => v != null);
    expect(nonNull.length).toBeGreaterThan(0); // ★ 탐색 대상 조건(expandDiscoveryTargets)이 성립한다.
    expect(summary).toContain(`앞면 중심 산출 ${nonNull.length}건`); // 보고 수치 = DB 실적.
    for (const v of nonNull) {
      expect(Number.isFinite(v!.x)).toBe(true);
      expect(Number.isFinite(v!.y)).toBe(true);
    }
  });

  it('산출값은 소수점 5자리 규약(stringify5)을 지킨다', async () => {
    const f = fixture();
    const s = makeServer({ ...f, ground: groundCfg });
    await s.app.inject({ method: 'POST', url: '/capture/slots/load-roi' });
    for (const [, v] of frontCenters(s.store)) {
      if (!v) continue;
      for (const n of [v.x, v.y]) {
        const dec = String(n).split('.')[1] ?? '';
        expect(dec.length, `${n} 은 소수점 5자리 이하여야 함`).toBeLessThanOrEqual(5);
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// U12 — 강등(로딩을 죽이지 않는다)
// ══════════════════════════════════════════════════════════════════
describe('U12. 지면모델 미주입/비활성 → 로딩은 살아있고 issues 로만 강등', () => {
  it.each([
    ['ground 미주입', undefined],
    ['ground.enabled=false', { ...groundCfg, enabled: false } as ToolsConfig['ground']],
  ])('%s → 200 + ok:true + issues 에 "앞면 중심 미산출" + front_center 전부 null', async (_name, ground) => {
    const f = fixture();
    const s = makeServer({ ...f, ground });
    const r = await s.app.inject({ method: 'POST', url: '/capture/slots/load-roi' });

    expect(r.statusCode).toBe(200); // ★ 강등이 로딩을 죽이지 않는다.
    const b = JSON.parse(r.body);
    expect(b.ok).toBe(true);
    expect(b.slots).toBeGreaterThan(0); // 슬롯 적재는 정상 수행.
    const msg = (b.issues as string[]).find((i) => i.includes('앞면 중심 미산출'));
    expect(msg, `issues=${JSON.stringify(b.issues)}`).toBeDefined();
    expect(msg).toContain('ground.enabled=false'); // 사유를 드러낸다(조용한 스킵 아님).

    for (const [slotId, v] of frontCenters(s.store)) {
      expect(v, `slot ${slotId}`).toBeNull(); // 위장 저장 없음.
    }
  });

  it('강등 상태에서도 /capture/slots 응답 shape 은 그대로(프론트 회귀 0)', async () => {
    const f = fixture();
    const s = makeServer({ ...f }); // ground 미주입.
    await s.app.inject({ method: 'POST', url: '/capture/slots/load-roi' });
    const r = await s.app.inject({ method: 'GET', url: '/capture/slots' });
    expect(r.statusCode).toBe(200);
    const rows = JSON.parse(r.body) as SlotSetupView[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toHaveProperty('slot3dFrontCenter');
      expect(row.slot3dFrontCenter).toBeNull();
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// U13 — 부작용 격리(전 컬럼 비교)
// ══════════════════════════════════════════════════════════════════
/** slot3dFrontCenter·updatedAt 을 뺀 전 컬럼(비교 대상). */
function withoutFrontCenter(v: SlotSetupView): Record<string, unknown> {
  const { slot3dFrontCenter: _f, updatedAt: _u, ...rest } = v;
  return rest;
}

describe('U13. W6 부작용 격리 — slot3d_front_center 외 전 컬럼 불변', () => {
  it('★ 전 컬럼 비교: lpd/occupyRange/vpd/pan/tilt/zoom/centered/roi 가 실행 전후 동일', async () => {
    const f = fixture();
    const s = makeServer({ ...f, ground: groundCfg });
    // 1) 먼저 로딩으로 슬롯을 깐다(여기까지가 준비).
    await s.app.inject({ method: 'POST', url: '/capture/slots/load-roi' });
    // 2) 모든 컬럼을 실데이터처럼 채운다 — W6 이 건드리면 바로 드러나도록.
    const seeded = s.store.getSlotSetup();
    expect(seeded.length).toBeGreaterThan(0);
    const now = 'SEED';
    s.store.upsertSlotLpd(seeded.map((v) => ({
      slotId: v.slotId,
      lpdObb: stringify5(rectToQuad({ x: 0.4, y: 0.6, w: 0.05, h: 0.03 })),
      occupyRange: stringify5([{ x: 0.3, y: 0.5 }, { x: 0.6, y: 0.5 }, { x: 0.6, y: 0.8 }, { x: 0.3, y: 0.8 }]),
      updatedAt: now,
    })));
    s.store.upsertSlotCentering(seeded.map((v) => ({
      slotId: v.slotId, pan: 12.5, tilt: -3.25, zoom: 8.125, centered: 1, img1: `s${v.slotId}.jpg`, updatedAt: now,
    })));

    const before = s.store.getSlotSetup();
    // 3) 라우트가 부르는 것과 **동일 인자**로 자동 W6 경로를 실행.
    const res = await buildSlotFrontCenters(s.store, {
      placeRoiFile: f.placeRoiFile,
      cameraposFile: f.cameraposFile,
      ground: groundCfg,
    });
    expect(res.updated).toBeGreaterThan(0); // 실제로 쓰기가 일어난 상태에서의 비교(무동작 통과 방지).
    const after = s.store.getSlotSetup();

    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i++) {
      expect(withoutFrontCenter(after[i]), `slot ${before[i].slotId}`).toEqual(withoutFrontCenter(before[i]));
    }
    // 개별 필드 명시 단언(설계서 U13 열거 그대로).
    for (let i = 0; i < before.length; i++) {
      for (const k of ['lpd', 'occupyRange', 'vpd', 'pan', 'tilt', 'zoom', 'centered', 'roi'] as const) {
        expect(after[i][k], `slot ${before[i].slotId}.${k}`).toEqual(before[i][k]);
      }
    }
  });

  it('산출 실패 슬롯의 기존 front_center 는 null 로 지워지지 않는다(skipped = 무접촉)', async () => {
    const f = fixture();
    const s = makeServer({ ...f, ground: groundCfg });
    await s.app.inject({ method: 'POST', url: '/capture/slots/load-roi' });
    // 지면모델이 없는 프리셋 슬롯을 기존 값과 함께 추가.
    const rows = s.store.getSlotSetup();
    const orphanId = Math.max(...rows.map((v) => v.slotId)) + 1;
    const camId = rows[0].camId;
    s.store.upsertPresetInfo([{ camId, presetId: 99, presetName: 'orphan', placeId: 1, pan: 0, tilt: 0, zoom: 1, updatedAt: 'T' }]);
    const keep: SlotSetupRow[] = rows.map((v) => ({
      slotId: v.slotId, camId: v.camId, presetId: v.presetId, presetSlotIdx: v.presetSlotIdx,
      slotRoi: JSON.stringify(v.roi), vpdBbox: null, lpdObb: null, occupyRange: null,
      pan: null, tilt: null, zoom: null, centered: 0, img1: null,
      slot3dFrontCenter: v.slot3dFrontCenter ? JSON.stringify(v.slot3dFrontCenter) : null, updatedAt: 'T',
    }));
    keep.push({
      slotId: orphanId, camId, presetId: 99, presetSlotIdx: 1,
      slotRoi: JSON.stringify([{ x: 0.4, y: 0.72 }, { x: 0.42, y: 0.6 }, { x: 0.58, y: 0.6 }, { x: 0.6, y: 0.72 }]),
      vpdBbox: null, lpdObb: null, occupyRange: null,
      pan: null, tilt: null, zoom: null, centered: 0, img1: null,
      slot3dFrontCenter: JSON.stringify({ x: 0.11111, y: 0.22222 }), updatedAt: 'T',
    });
    s.store.replaceSlotSetup(keep);

    const res = await buildSlotFrontCenters(s.store, {
      placeRoiFile: f.placeRoiFile, cameraposFile: f.cameraposFile, ground: groundCfg,
    });
    expect(res.skipped.some((x) => x.slotId === orphanId)).toBe(true);
    const orphan = s.store.getSlotSetup().find((v) => v.slotId === orphanId)!;
    expect(orphan.slot3dFrontCenter).toEqual({ x: 0.11111, y: 0.22222 }); // ★ 기존 값 보존.
  });

  it('라우트 경로의 쓰기 호출 추적 — 슬롯 재구성 이후의 DB 쓰기는 upsertSlotFrontCenter 뿐', async () => {
    const f = fixture();
    const real = new SqliteStore(':memory:');
    stores.push(real);
    const calls: string[] = [];
    const spy = new Proxy(real, {
      get(t, p, r) {
        const v = Reflect.get(t, p, r);
        if (typeof v === 'function') {
          return (...a: unknown[]) => { calls.push(String(p)); return (v as (...x: unknown[]) => unknown).apply(t, a); };
        }
        return v;
      },
    }) as SqliteStore;
    const s = makeServer({ ...f, ground: groundCfg, store: spy });

    const r = await s.app.inject({ method: 'POST', url: '/capture/slots/load-roi' });
    expect(r.statusCode).toBe(200);

    const isWrite = (n: string) => /^(upsert|replace|clear|delete|remove)/.test(n);
    const lastReplace = calls.lastIndexOf('replaceSlotSetup');
    expect(lastReplace).toBeGreaterThanOrEqual(0);
    const writesAfter = calls.slice(lastReplace + 1).filter(isWrite);
    expect(writesAfter).toEqual(['upsertSlotFrontCenter']); // ★ W6 은 단일 컬럼 UPDATE 하나뿐.
  });
});

// ══════════════════════════════════════════════════════════════════
// U14 — 자동 경로 ↔ 버튼 경로 동등성
// ══════════════════════════════════════════════════════════════════
describe('U14. 자동(load-roi) 결과 == 수동(3D육면체 ROI생성 버튼, heightM 미지정) 결과', () => {
  it('같은 서버에서 버튼을 눌러도 값이 한 톨도 바뀌지 않는다(같은 W6·같은 H_CONST)', async () => {
    const f = fixture();
    const s = makeServer({ ...f, ground: groundCfg });
    await s.app.inject({ method: 'POST', url: '/capture/slots/load-roi' });
    const auto = frontCenters(s.store);
    expect([...auto.values()].filter((v) => v != null).length).toBeGreaterThan(0);

    const r = await s.app.inject({ method: 'POST', url: '/capture/slots/cuboid', payload: {} });
    expect(r.statusCode).toBe(200);
    const b = JSON.parse(r.body);
    expect(b.heightM).toBe(H_CONST);
    expect(b.updated).toBe([...auto.values()].filter((v) => v != null).length); // 산출 대상 집합 동일.

    const manual = frontCenters(s.store);
    expect(manual).toEqual(auto); // ★ 전 슬롯 완전 일치.
  });

  it('독립 서버 대조: A=자동만 / B=자동+버튼 → 슬롯 신원 기준 값 완전 일치', async () => {
    const fa = fixture();
    const a = makeServer({ ...fa, ground: groundCfg });
    await a.app.inject({ method: 'POST', url: '/capture/slots/load-roi' });
    const autoOnly = frontCentersByIdentity(a.store);

    const fb = fixture();
    const b = makeServer({ ...fb, ground: groundCfg });
    await b.app.inject({ method: 'POST', url: '/capture/slots/load-roi' });
    await b.app.inject({ method: 'POST', url: '/capture/slots/cuboid', payload: {} });
    const afterButton = frontCentersByIdentity(b.store);

    expect(afterButton).toEqual(autoOnly);
    expect([...autoOnly.values()].filter((v) => v != null).length).toBeGreaterThan(0);
  });

  it('버튼에 heightM 을 명시하면 값이 달라진다 — 위 일치가 "항상 같다"의 자명한 결과가 아님을 보인다', async () => {
    const f = fixture();
    const s = makeServer({ ...f, ground: groundCfg });
    await s.app.inject({ method: 'POST', url: '/capture/slots/load-roi' });
    const auto = frontCenters(s.store);

    const r = await s.app.inject({ method: 'POST', url: '/capture/slots/cuboid', payload: { heightM: 2.5 } });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).heightM).toBe(2.5);
    expect(frontCenters(s.store)).not.toEqual(auto);
  });
});
