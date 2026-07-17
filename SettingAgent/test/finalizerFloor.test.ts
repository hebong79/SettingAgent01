import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Finalizer } from '../src/capture/Finalizer.js';
import { buildPlateAnchoredQuad } from '../src/capture/floorRoi.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { aggregate } from '../src/capture/Aggregator.js';
import { plateAngleRad, rectToQuad } from '../src/domain/geometry.js';
import type { Repository } from '../src/store/Repository.js';
import type { SetupArtifact, NormalizedQuad } from '../src/domain/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { CaptureSnapshot } from '../src/capture/CaptureJob.js';
import type { DetectionRow } from '../src/capture/types.js';

/**
 * 검증자(qa-tester): Finalizer floor ROI 가산 (설계서 §7).
 * ★ 설계서 §2.3/§6.5: 구 floor_roi 테이블(store.upsertFloorRoi — LLM 산출 주입) 폐기.
 *   assemble() 이 buildPlateAnchoredQuad 로 **항상 결정형** 산출(실측 plateQuad > 이웃추정 > predictPlateRect 상수 폴백).
 *   floor_roi 있음/없음 분기 자체가 사라졌으므로 "있으면 X/없으면 Y" 구식 테스트는 결정형 단일 경로로 통합.
 * slot_setup(placeRoiFile 배정) 의 occupyRange 도 동일 결정형 산식(buildPlateAnchoredQuad) 으로 영속화됨을 별도 확인.
 * 기존 roiByPreset/plateRoiByPreset 불변.
 */

const captureCfg: ToolsConfig['capture'] = {
  defaultCount: 50, intervalMs: 1000, moveIntervalMs: 1000, checkpointEvery: 10,
  checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, dbFile: ':memory:',
  clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5, moveBeforeCapture: true,
};

const fakeRepo = (): { repo: Repository; saved: SetupArtifact[] } => {
  const saved: SetupArtifact[] = [];
  return { saved, repo: { saveArtifact: (a: SetupArtifact) => saved.push(a), loadArtifact: () => saved.at(-1) ?? null, path: 'mem' } as unknown as Repository };
};

let stores: SqliteStore[] = [];
afterEach(() => { for (const s of stores) { try { s.close(); } catch { /* noop */ } } stores = []; });
function mem(): SqliteStore { const s = new SqliteStore(':memory:'); stores.push(s); return s; }

/** dets/presetRounds → CaptureSnapshot(aggregated 는 finalize 가 fresh 재계산하므로 빈 배열로 충분). */
function snapshotFromDets(dets: DetectionRow[], presetRounds: Map<string, number>): CaptureSnapshot {
  const aggregated = aggregate(dets, presetRounds, {
    clusterDist: captureCfg.clusterDist, clusterMinSupport: captureCfg.clusterMinSupport, minConfidence: captureCfg.minConfidence,
  });
  return { dets, presetRounds, aggregated, occByPreset: new Map() };
}

/** 안정 클러스터(support>=3) 1개. 집계 후 clusterId 는 1, presetKey '1:1', slotId c1p1s1. */
function detsStable(): { dets: DetectionRow[]; presetRounds: Map<string, number> } {
  const dets: DetectionRow[] = [1, 2, 3].map((round) => ({
    observationId: round, roundIdx: round, camIdx: 1, presetIdx: 1, kind: 'vehicle', x: 0.3, y: 0.3, w: 0.1, h: 0.1, conf: 0.9,
  }));
  return { dets, presetRounds: new Map([['1:1', 3]]) };
}

const quad: NormalizedQuad = [
  { x: 0.3, y: 0.42 },
  { x: 0.4, y: 0.42 },
  { x: 0.38, y: 0.3 },
  { x: 0.32, y: 0.3 },
];

// 검증자(qa-tester): Finalizer plateRoiByPreset = 실 대표 quad 우선, 부재 시 rectToQuad 폴백 (설계 케이스 10).
describe('Finalizer plateRoiByPreset(실 quad·폴백) (설계 케이스 10)', () => {
  /** 안정 차량 클러스터 + 그 ROI 내부의 번호판(quad 유무 선택). */
  function seedWithPlate(plateQuad?: NormalizedQuad): { dets: DetectionRow[]; presetRounds: Map<string, number> } {
    // 번호판 rect(집계용) = quad boundingRect 또는 축정렬. 차량 ROI(0.3~0.4,0.3~0.4) 내부 중심.
    const pr = { x: 0.32, y: 0.34, w: 0.04, h: 0.02 };
    const dets: DetectionRow[] = [];
    for (const round of [1, 2, 3]) {
      dets.push({ observationId: round, roundIdx: round, camIdx: 1, presetIdx: 1, kind: 'vehicle', x: 0.3, y: 0.3, w: 0.1, h: 0.1, conf: 0.9 });
      dets.push({ observationId: round, roundIdx: round, camIdx: 1, presetIdx: 1, kind: 'plate', x: pr.x, y: pr.y, w: pr.w, h: pr.h, conf: 0.9, ...(plateQuad ? { quad: plateQuad } : {}) });
    }
    return { dets, presetRounds: new Map([['1:1', 3]]) };
  }

  it('실 대표 quad 보존 → plateRoiByPreset 값이 합성 quad(방향 보존·축정렬 아님)', async () => {
    const store = mem();
    // 회전 번호판 quad(축정렬 아님).
    const rot: NormalizedQuad = [
      { x: 0.33, y: 0.34 },
      { x: 0.36, y: 0.35 },
      { x: 0.34, y: 0.36 },
      { x: 0.32, y: 0.35 },
    ];
    const { dets, presetRounds } = seedWithPlate(rot);
    const { repo } = fakeRepo();
    const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
    const r = await finalizer.finalize(snapshotFromDets(dets, presetRounds));
    const slot = r.artifact.slots[0];
    expect(slot.plateRoiByPreset).toBeDefined();
    // 강건 합성 대표 quad: 원본 방향(각도) 보존, 축정렬 아님(회전 유지). (representativeQuad → 순환 median 합성으로 대체)
    const got = slot.plateRoiByPreset!['1:1'];
    expect(plateAngleRad(got)).toBeCloseTo(plateAngleRad(rot), 5);
    expect(got[0].y).not.toBeCloseTo(got[1].y);
  });

  it('quad 부재(구데이터·polygon 미보존) → rectToQuad(rect) 폴백', async () => {
    const store = mem();
    const { dets, presetRounds } = seedWithPlate(); // plate 에 quad 없음
    const { repo } = fakeRepo();
    const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
    const r = await finalizer.finalize(snapshotFromDets(dets, presetRounds));
    const slot = r.artifact.slots[0];
    expect(slot.plateRoiByPreset).toBeDefined();
    // 집계 대표 plate rect(중앙값 = 0.32,0.34,0.04,0.02) 를 rectToQuad 로 승격.
    expect(slot.plateRoiByPreset!['1:1']).toEqual(rectToQuad({ x: 0.32, y: 0.34, w: 0.04, h: 0.02 }));
  });

  it('plate 부재 → plateRoiByPreset 미부여', async () => {
    const store = mem();
    const { dets, presetRounds } = detsStable(); // 번호판 없음
    const { repo } = fakeRepo();
    const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
    const r = await finalizer.finalize(snapshotFromDets(dets, presetRounds));
    expect(r.artifact.slots[0].plateRoiByPreset).toBeUndefined();
  });
});

describe('Finalizer floor ROI(결정형 발자국) 가산', () => {
  it('floorRoiByPreset 은 buildPlateAnchoredQuad 로 항상 결정형 산출(bbox 유도 폴백), roi 불변(단일 슬롯=비겹침 무영향)', async () => {
    const store = mem();
    const { dets, presetRounds } = detsStable();
    const { repo } = fakeRepo();
    const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
    const r = await finalizer.finalize(snapshotFromDets(dets, presetRounds));
    const slot = r.artifact.slots[0];
    expect(slot.floorRoiByPreset).toBeDefined();
    // 구 LLM/floor_roi 테이블 주입 경로 폐기 — 차량 bbox(0.3,0.3,0.1,0.1) 유도 폴백 다각형과 항상 일치(단일 슬롯=비겹침 무영향).
    expect(slot.floorRoiByPreset!['1:1']).toEqual(buildPlateAnchoredQuad({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 }));
    // roiByPreset 불변(집계 대표 bbox).
    expect(slot.roiByPreset['1:1']).toEqual({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 });
  });
});

describe('Finalizer slot_setup(§06) occupyRange — 결정형 발자국 영속화', () => {
  it('placeRoiFile 배정 슬롯 → getSlotSetup().occupyRange = buildPlateAnchoredQuad(vpd bbox, lpd quad)', async () => {
    const store = mem();
    // FK 부모(place_info/camera_info/preset_pos) 시드 — slot_setup FK(cam_id,preset_id)→preset_pos 전제.
    store.upsertPlaceInfo([{ placeId: 1, placeName: 'P' }]);
    store.upsertCameraInfo([{
      camId: 1, camName: null, camUuid: null, url: null, userId: null, password: null, rtspUrl: null,
      camType: 'ptz', camCompany: null, placeId: 1, imgW: 1000, imgH: 1000, updatedAt: 'T',
    }]);
    store.upsertPresetPos([{ camId: 1, presetId: 1, sname: null, pan: 0, tilt: 0, zoom: 1, updatedAt: 'T' }]);

    const rot: NormalizedQuad = [
      { x: 0.33, y: 0.34 }, { x: 0.36, y: 0.35 }, { x: 0.34, y: 0.36 }, { x: 0.32, y: 0.35 },
    ];
    const dets: DetectionRow[] = [];
    for (const round of [1, 2, 3]) {
      dets.push({ observationId: round, roundIdx: round, camIdx: 1, presetIdx: 1, kind: 'vehicle', x: 0.3, y: 0.3, w: 0.1, h: 0.1, conf: 0.9 });
      dets.push({ observationId: round, roundIdx: round, camIdx: 1, presetIdx: 1, kind: 'plate', x: 0.32, y: 0.34, w: 0.04, h: 0.02, conf: 0.9, quad: rot });
    }
    const presetRounds = new Map([['1:1', 3]]);

    const dir = mkdtempSync(join(tmpdir(), 'finalizer-floor-placeroi-'));
    const file = join(dir, 'PtzCamRoi.json');
    // 폴리곤(0.2~0.5): 차량/번호판 중심 포함 → 배정.
    writeFileSync(file, JSON.stringify({
      cameras: [{ camera: { cam_id: 1, imageWidth: 1000, imageHeight: 1000 }, presets: [
        { preset_idx: 1, parking_spaces: [{ idx: 1, points: [[200, 200], [500, 200], [500, 500], [200, 500]] }] },
      ] }],
    }));

    try {
      const { repo } = fakeRepo();
      const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T', placeRoiFile: file });
      await finalizer.finalize(snapshotFromDets(dets, presetRounds));

      const rows = store.getSlotSetup();
      expect(rows).toHaveLength(1);
      // 기대값은 Finalizer 와 동일 경로(aggregate → 강건 합성 plateQuad)로 재계산 — robustPlatePose 가 원본 rot 을
      // 삼각함수 재합성하므로 리터럴 rot 대비 float 오차(~1e-16)가 있어 원본을 직접 넣으면 오검출된다.
      const cluster = aggregate(dets, presetRounds, {
        clusterDist: captureCfg.clusterDist, clusterMinSupport: captureCfg.clusterMinSupport, minConfidence: captureCfg.minConfidence,
      })[0];
      expect(rows[0].occupyRange).toEqual(
        buildPlateAnchoredQuad({ x: cluster.x, y: cluster.y, w: cluster.w, h: cluster.h }, cluster.plateQuad ?? undefined),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
