import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Finalizer } from '../src/capture/Finalizer.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { aggregate } from '../src/capture/Aggregator.js';
import { toPixel, toPixelQuad } from '../web/core.js';
import type { CaptureSnapshot } from '../src/capture/CaptureJob.js';
import type { DetectionRow } from '../src/capture/types.js';
import type { Repository } from '../src/store/Repository.js';
import type { SetupArtifact, NormalizedQuad } from '../src/domain/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

/**
 * 검증자(qa-tester): DB 소스 오버레이 렌더 shape parity.
 *
 * 이번 변경(web/app.js): 라이브 검출/점유가 없는 프리셋에서 DB(slot_setup=SlotSetupView[]) 를
 * 오버레이 폴백 소스로 렌더한다. app.js 의 소비 계약:
 *   - drawDbVpd:              toPixel(row.vpd, W, H)          → { px, py, pw, ph } → strokeRect
 *   - drawPlateQuad(row.lpd): toPixelQuad(row.lpd, W, H)      → [{ px, py } × 4]  → path
 *   - drawOccupancyOverlay:  toPixelQuad(row.occupyRange,W,H) → [{ px, py } …]    → path(fill)
 *
 * 이 테스트는 **실제 finalize → DB → getSlotSetup → core.js 렌더헬퍼** 전 경로로
 * vpd/lpd/occupyRange 가 유효 픽셀을 내는지(= 라이브 렌더와 동일 헬퍼·동일 shape) 를 증명한다.
 * (라이브 경로도 toPixel/drawPlateQuad(→toPixelQuad)/toPixelQuad 를 쓰므로 parity 근거.)
 */

const captureCfg: ToolsConfig['capture'] = {
  defaultCount: 50, intervalMs: 1000, moveIntervalMs: 1000, checkpointEvery: 10,
  checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, dbFile: ':memory:',
  clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5, slotAssignGate: 0.12, moveBeforeCapture: true,
};

const fakeRepo = (): Repository => {
  const saved: SetupArtifact[] = [];
  return { saveArtifact: (a: SetupArtifact) => saved.push(a), loadArtifact: () => saved.at(-1) ?? null, path: 'mem' } as unknown as Repository;
};

let stores: SqliteStore[] = [];
let dirs: string[] = [];
afterEach(() => {
  for (const s of stores) { try { s.close(); } catch { /* noop */ } }
  stores = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function seededStore(presetId: number): SqliteStore {
  const s = new SqliteStore(':memory:');
  stores.push(s);
  s.upsertPlaceInfo([{ placeId: 1, placeName: 'Place01' }]);
  s.upsertCameraInfo([{ camId: 1, camName: null, camUuid: null, url: null, userId: null, password: null, rtspUrl: null, camType: 'ptz', camCompany: null, placeId: 1, imgW: 1000, imgH: 1000, updatedAt: 'T' }]);
  s.upsertPresetPos([{ camId: 1, presetId, sname: null, pan: 0, tilt: 0, zoom: 1, updatedAt: 'T' }]);
  return s;
}

// 번호판 quad(정규화 4점) — 차량 중심 근처. lpd(NormalizedQuad) + occupyRange(발자국) 유발.
const plateQuad: NormalizedQuad = [
  { x: 0.30, y: 0.36 }, { x: 0.34, y: 0.36 }, { x: 0.34, y: 0.38 }, { x: 0.30, y: 0.38 },
];

function snapshot(): CaptureSnapshot {
  const dets: DetectionRow[] = [];
  const presetRounds = new Map<string, number>([['1:1', 3]]);
  for (const round of [1, 2, 3]) {
    // 차량 클러스터 bbox 0.3,0.3,0.1,0.1 (center 0.35,0.35) — 폴리곤 내부.
    dets.push({ observationId: round * 10 + 1, roundIdx: round, camIdx: 1, presetIdx: 1, kind: 'vehicle', x: 0.3, y: 0.3, w: 0.1, h: 0.1, conf: 0.9 });
    dets.push({ observationId: round * 10 + 2, roundIdx: round, camIdx: 1, presetIdx: 1, kind: 'plate', x: 0.32, y: 0.36, w: 0.04, h: 0.02, conf: 0.9, quad: plateQuad });
  }
  const aggregated = aggregate(dets, presetRounds, { clusterDist: captureCfg.clusterDist, clusterMinSupport: captureCfg.clusterMinSupport, minConfidence: captureCfg.minConfidence });
  return { dets, presetRounds, aggregated, occByPreset: new Map() };
}

function writePlaceRoi(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dbparity-'));
  dirs.push(dir);
  const file = join(dir, 'PtzCamRoi.json');
  const poly = [[200, 200], [500, 200], [500, 500], [200, 500]];
  writeFileSync(file, JSON.stringify({ cameras: [{ camera: { cam_id: 1, imageWidth: 1000, imageHeight: 1000 }, presets: [{ preset_idx: 1, parking_spaces: [{ idx: 5, points: poly }] }] }] }));
  return file;
}

function makeFinalizer(store: SqliteStore, placeRoiFile: string) {
  return new Finalizer({ store, repo: fakeRepo(), cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T', placeRoiFile });
}

/** 렌더 캔버스 크기(app.js overlay.width/height 대응). */
const W = 1280;
const H = 720;
const finite = (n: number) => Number.isFinite(n);

describe('DB 오버레이 렌더 parity: getSlotSetup(SlotSetupView) → core.js toPixel/toPixelQuad', () => {
  it('실 finalize → DB → getSlotSetup: vpd/lpd/occupyRange 모두 채워지고 렌더헬퍼 입력계약과 정합', async () => {
    const store = seededStore(1);
    await makeFinalizer(store, writePlaceRoi()).finalize(snapshot());

    const rows = store.getSlotSetup();
    expect(rows.length).toBe(1);
    const [row] = rows;

    // 전제: 폴백 렌더가 그릴 세 필드가 실제로 DB 에 존재(라이브 없이도 표시 가능).
    expect(row.presetKey).toBe('1:1'); // = app.js currentFrameKey() 정합.
    expect(row.vpd).not.toBeNull();
    expect(row.lpd).not.toBeNull();
    expect(row.occupyRange).not.toBeNull();

    // (A) drawDbVpd: toPixel(row.vpd) → { px, py, pw, ph }. app.js 가 구조분해하는 필드명 그대로.
    const v = toPixel(row.vpd!, W, H);
    expect(Object.keys(v).sort()).toEqual(['ph', 'pw', 'px', 'py']);
    for (const n of [v.px, v.py, v.pw, v.ph]) expect(finite(n)).toBe(true);
    // 정규화 0~1 입력 → 픽셀은 캔버스 범위 내(strokeRect 유효).
    expect(v.px).toBeGreaterThanOrEqual(0);
    expect(v.py).toBeGreaterThanOrEqual(0);
    expect(v.px + v.pw).toBeLessThanOrEqual(W);
    expect(v.py + v.ph).toBeLessThanOrEqual(H);
    expect(v.pw).toBeGreaterThan(0);
    expect(v.ph).toBeGreaterThan(0);

    // (B) drawPlateQuad(row.lpd) 내부: toPixelQuad(row.lpd) → [{ px, py } × 4].
    const lq = toPixelQuad(row.lpd!, W, H);
    expect(lq).toHaveLength(4);
    for (const p of lq) {
      expect(Object.keys(p).sort()).toEqual(['px', 'py']);
      expect(finite(p.px) && finite(p.py)).toBe(true);
      expect(p.px).toBeGreaterThanOrEqual(0);
      expect(p.px).toBeLessThanOrEqual(W);
      expect(p.py).toBeGreaterThanOrEqual(0);
      expect(p.py).toBeLessThanOrEqual(H);
    }

    // (C) drawOccupancyOverlay 폴백: toPixelQuad(row.occupyRange) → [{ px, py } …] (폴리곤 fill).
    // occupyRange 는 N점 폴리곤(NormalizedPoint[])이며 toPixelQuad 는 런타임에 N점을 매핑한다.
    // 선언 타입만 4-tuple(NormalizedQuad)로 좁아 캐스트로 해소(런타임 동작 불변).
    const oq = toPixelQuad(row.occupyRange! as unknown as NormalizedQuad, W, H);
    expect(oq.length).toBeGreaterThanOrEqual(3); // 면을 이루려면 ≥3점.
    for (const p of oq) {
      expect(finite(p.px) && finite(p.py)).toBe(true);
      expect(p.px).toBeGreaterThanOrEqual(0);
      expect(p.px).toBeLessThanOrEqual(W);
      expect(p.py).toBeGreaterThanOrEqual(0);
      expect(p.py).toBeLessThanOrEqual(H);
    }
  });

  it('parkingSlotsByKey 그룹핑(app.js loadParkingSlots) 키 = currentFrameKey 정합', async () => {
    const store = seededStore(1);
    await makeFinalizer(store, writePlaceRoi()).finalize(snapshot());
    // app.js loadParkingSlots 재현: presetKey 로 그룹핑.
    const byKey: Record<string, ReturnType<typeof store.getSlotSetup>> = {};
    for (const r of store.getSlotSetup()) (byKey[r.presetKey] ??= []).push(r);
    // 폴백 렌더가 조회하는 키(`${camId}:${presetId}`)에 행이 담긴다.
    expect(byKey['1:1']).toBeDefined();
    expect(byKey['1:1'].length).toBe(1);
  });
});
