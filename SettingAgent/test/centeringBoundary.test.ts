import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { PtzCalibrator } from '../src/calibrate/PtzCalibrator.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { LpdClient, PlateBox } from '../src/clients/LpdClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { SetupArtifact } from '../src/domain/types.js';
import { rectToQuad } from '../src/domain/geometry.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

/**
 * 검증자(qa-tester): 센터라이징 **경계면 교차 비교**(ParkAgent 하네스 필수 항목).
 *
 *   REST `/calibrate/result`(slot_ptz.json items · 문자열 slotId + ptz JSON)
 *     ↔  DB `slot_setup` 행(정수 slot_id=globalIdx + pan/tilt/zoom REAL 컬럼)  ↔  `/db/table/slot_setup`
 *
 * ★ DB 개편: 구 `centering_slot`(문자열 slotId + pos JSON) 폐기 → `slot_setup` 부분 UPDATE(정수 slot_id).
 *   upsertSlotCentering 은 **기존 slot_setup 행만** UPDATE 하므로 사전 시드(FK 부모 + slot_setup) 필수.
 * 모킹이 아니라 **실 파일 DB + 실 writer + 실 라우트**로 왕복시켜 shape 불일치를 찾는다.
 * 1-based 규약(cam_id/preset_id/preset_slotidx)을 각 경계에서 재확인한다.
 */

const setupCfg = {
  presetSettleMs: 0, betweenPresetMs: 0, minConfidence: 0.5, roiPadding: 0, yBandTolerance: 0.1,
  accumFrames: 1, accumIntervalMs: 0, clusterDist: 0.06, clusterMinSupport: 1, lpdEnabled: false,
};

function calCfg(outFile: string): ToolsConfig['calibrate'] {
  return {
    targetPlateWidth: 0.2, centerTol: 0.03, widthTol: 0.02, maxIterations: 30,
    probeStepDeg: 1.0, maxStepDeg: 5.0, fallbackGainPanDeg: -62, fallbackGainTiltDeg: -35.5,
    settleMs: 0, outFile,
  };
}

/** 2슬롯 · coveredSlotIds 로 presetSlotIdx(1-based) 가 도출되는 fixture. */
function artifact(): SetupArtifact {
  return {
    createdAt: 'T',
    presets: [{ camIdx: 1, presetIdx: 1, label: 'p1', coveredSlotIds: ['c1p1s1', 'c1p1s2'] }],
    globalIndex: [
      { globalIdx: 1, slotId: 'c1p1s1', camIdx: 1, presetIdx: 1 },
      { globalIdx: 2, slotId: 'c1p1s2', camIdx: 1, presetIdx: 1 },
    ],
    slots: [
      { slotId: 'c1p1s1', zone: 'z', roiByPreset: { '1:1': { x: 0.6, y: 0.6, w: 0.1, h: 0.05 } }, plateRoiByPreset: { '1:1': rectToQuad({ x: 0.62, y: 0.62, w: 0.05, h: 0.03 }) } },
      { slotId: 'c1p1s2', zone: 'z', roiByPreset: { '1:1': { x: 0.6, y: 0.6, w: 0.1, h: 0.05 } }, plateRoiByPreset: { '1:1': rectToQuad({ x: 0.62, y: 0.62, w: 0.05, h: 0.03 }) } },
    ],
  };
}

const repoWith = (a: SetupArtifact): Repository => ({ loadArtifact: () => a } as unknown as Repository);

function fakeCamera(): CameraClient {
  return {
    health: async () => true,
    clampZoom: (z: number) => Math.min(36, Math.max(1, z)),
    requestImage: async (_c: number, _p: number, ptz?: { pan?: number; tilt?: number; zoom?: number }) => {
      const pan = ptz?.pan ?? 0, tilt = ptz?.tilt ?? 0, zoom = ptz?.zoom ?? 1;
      return { camIdx: 1, presetIdx: 1, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from(JSON.stringify({ pan, tilt, zoom })) };
    },
  } as unknown as CameraClient;
}
function fakeLpd(): LpdClient {
  return {
    detect: async (jpg: Buffer): Promise<PlateBox[]> => {
      const { pan, tilt, zoom } = JSON.parse(jpg.toString());
      const cx = 0.7 - pan * 0.02, cy = 0.8 - tilt * 0.02, w = Math.min(0.9, 0.05 * zoom), h = 0.03;
      return [{ quad: rectToQuad({ x: cx - w / 2, y: cy - h / 2, w, h }), confidence: 0.9, cls: 'plate' }];
    },
  } as unknown as LpdClient;
}
const fakeVpd = () => ({ health: async () => true, detect: async () => [] } as unknown as VpdClient);

let app: FastifyInstance | undefined;
let dir: string | undefined;
let store: SqliteStore | undefined;
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  if (store) { store.close(); store = undefined; }
  // tmp 정리는 best-effort: dbRoutes 의 read-only 커넥션은 외부에서 닫을 수단이 없어
  // (dbRoutes.ts 에 onClose 훅 없음 — 기존 코드, 이번 변경 범위 밖) Windows 에서 EPERM 이 날 수 있다.
  // 정리 실패가 검증 결과를 뒤집어선 안 된다(tmpdir 는 OS 가 회수).
  if (dir && existsSync(dir)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* OS 회수에 위임 */ }
  }
  dir = undefined;
});

function makeServer() {
  dir = mkdtempSync(join(tmpdir(), 'centering-'));
  const outFile = join(dir, 'slot_ptz.json');
  const dbFile = join(dir, 'test.db');
  store = new SqliteStore(dbFile); // 실 파일 DB — 신 6테이블 DDL 생성
  // upsertSlotCentering 은 기존 slot_setup 행만 UPDATE → globalIdx(1,2) 에 대응하는 slot_setup 을 사전 시드.
  store.upsertPlaceInfo([{ placeId: 1, placeName: 'P' }]);
  store.upsertCameraInfo([{ camId: 1, camName: null, camUuid: null, url: null, userId: null, password: null, rtspUrl: null, camType: 'ptz', camCompany: null, placeId: 1, imgW: 1000, imgH: 1000, updatedAt: 'seed' }]);
  store.upsertPresetPos([{ camId: 1, presetId: 1, sname: null, pan: 0, tilt: 0, zoom: 1, updatedAt: 'seed' }]);
  const roi = JSON.stringify([{ x: 0.6, y: 0.6 }, { x: 0.7, y: 0.6 }, { x: 0.7, y: 0.65 }, { x: 0.6, y: 0.65 }]);
  store.replaceSlotSetup([
    { slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1, slotRoi: roi, vpdBbox: null, lpdObb: JSON.stringify(rectToQuad({ x: 0.62, y: 0.62, w: 0.05, h: 0.03 })), occupyRange: null, pan: null, tilt: null, zoom: null, centered: 0, img1: null, slot3dFrontCenter: null, updatedAt: 'seed' },
    { slotId: 2, camId: 1, presetId: 1, presetSlotIdx: 2, slotRoi: roi, vpdBbox: null, lpdObb: JSON.stringify(rectToQuad({ x: 0.62, y: 0.62, w: 0.05, h: 0.03 })), occupyRange: null, pan: null, tilt: null, zoom: null, centered: 0, img1: null, slot3dFrontCenter: null, updatedAt: 'seed' },
  ]);
  const repo = repoWith(artifact());
  const camera = fakeCamera();
  const cfg = calCfg(outFile);
  // ★ writer 미주입 = 실 writeSlotPtz 로 실제 파일 기록(경계면 왕복의 핵심)
  const calibrator = new PtzCalibrator({ camera, lpd: fakeLpd(), cfg, store, sleep: async () => {}, now: () => '2026-07-16T00:00:00Z' });
  const orchestrator = new SetupOrchestrator({ camera, vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
  app = buildServer({ orchestrator, repo, camera, vpd: fakeVpd(), calibrator, calibrate: cfg, dbFile });
  return { app, outFile, dbFile };
}

async function waitDone(a: FastifyInstance): Promise<void> {
  for (let i = 0; i < 5000; i++) {
    const r = await a.inject({ method: 'GET', url: '/calibrate/status' });
    if (JSON.parse(r.body).state !== 'running') return;
    await Promise.resolve();
  }
}

describe('경계면: /calibrate/result ↔ slot_ptz.json ↔ centering_slot', () => {
  it('REST 응답 · JSON 파일 · DB 행의 shape 과 값이 정합한다(1-based 규약 포함)', async () => {
    const { app: a } = makeServer();

    const start = await a.inject({ method: 'POST', url: '/calibrate/ptz', payload: {} });
    expect(start.statusCode).toBe(200);
    expect(JSON.parse(start.body).total).toBe(2);
    await waitDone(a);

    // ── 경계 1: REST /calibrate/result = slot_ptz.json 원문 그대로 ──
    const res = await a.inject({ method: 'GET', url: '/calibrate/result' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Object.keys(body).sort()).toEqual(['createdAt', 'items']); // SlotPtzArtifact 계약
    expect(body.items).toHaveLength(2);

    // 신 소스: slotId = String(정수 slot_id) → '1'(구 'c1p1s1' 아님).
    const item = body.items.find((i: { slotId: string }) => i.slotId === '1');
    // SlotPtzItem 계약(성공 항목엔 reason 키 자체가 없음)
    expect(Object.keys(item).sort()).toEqual(['camIdx', 'centered', 'converged', 'globalIdx', 'plateWidth', 'presetIdx', 'ptz', 'slotId']);
    expect(item.centered).toBe(true);
    expect(item.converged).toBe(true);
    expect(Object.keys(item.ptz).sort()).toEqual(['pan', 'tilt', 'zoom']);
    expect(item.camIdx).toBe(1);    // 1-based
    expect(item.presetIdx).toBe(1); // 1-based

    // ── 경계 2: DB 뷰어 라우트(sqlite_master 동적 화이트리스트 → 신 테이블 자동 반영) ──
    const tables = await a.inject({ method: 'GET', url: '/db/tables' });
    expect(JSON.parse(tables.body).tables).toContain('slot_setup'); // 구 centering_slot → slot_setup

    const db = await a.inject({ method: 'GET', url: '/db/table/slot_setup' });
    expect(db.statusCode).toBe(200);
    const dbBody = JSON.parse(db.body);
    expect(dbBody.total).toBe(2); // 사전 시드한 2 슬롯

    // 신 스키마 컬럼(스네이크) — 센터라이징 분해 PTZ(pan/tilt/zoom) + centered.
    for (const c of ['slot_id', 'cam_id', 'preset_id', 'preset_slotidx', 'pan', 'tilt', 'zoom', 'centered', 'updated_at']) {
      expect(dbBody.columns).toContain(c);
    }
    // 구 centering_slot 의 pos(JSON) 컬럼은 존재하지 않는다(분해 REAL 로 대체).
    expect(dbBody.columns).not.toContain('pos');

    // ── 경계 3: DB 행(정수 slot_id) ↔ JSON item 값 교차 비교 ──
    // slot_setup.slot_id 는 정수(=item.globalIdx). REST item.slotId 는 문자열 'c1p1s1'.
    const row = dbBody.rows.find((r: { slot_id: number }) => r.slot_id === item.globalIdx);
    expect(item.globalIdx).toBe(1); // 정수 전역 slot_id
    expect(row.cam_id).toBe(1);         // 1-based
    expect(row.preset_id).toBe(1);      // 1-based
    expect(row.preset_slotidx).toBe(1); // ★ 1-based(0 아님)
    expect(row.centered).toBe(1);       // 센터라이징 성공 반영
    // 분해 PTZ ↔ item.ptz 완전 일치(구 pos JSON 왕복 대체).
    expect({ pan: row.pan, tilt: row.tilt, zoom: row.zoom }).toEqual(item.ptz);
    expect(row.updated_at).toBe('2026-07-16T00:00:00Z');

    // 2번째 슬롯(globalIdx=2)은 preset_slotidx=2 (1-based 순서 규약)
    const item2 = body.items.find((i: { slotId: string }) => i.slotId === '2');
    const row2 = dbBody.rows.find((r: { slot_id: number }) => r.slot_id === item2.globalIdx);
    expect(row2.preset_slotidx).toBe(2);

    // zoom 은 카메라 유효범위 [1,36]
    expect(row.zoom).toBeGreaterThanOrEqual(1);
    expect(row.zoom).toBeLessThanOrEqual(36);

    // ── 경계 4: 성공 항목 수 == centered=1 행 수(실패는 slot_setup 미갱신 — 설계서 §2.5) ──
    const okCount = body.items.filter((i: { centered: boolean; converged: boolean }) => i.centered && i.converged).length;
    const centeredRows = dbBody.rows.filter((r: { centered: number }) => r.centered === 1).length;
    expect(centeredRows).toBe(okCount);
  });
});
