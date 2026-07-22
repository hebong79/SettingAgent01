// 검증자(qa-tester): 주차면 3D 육면체 앞면 중심점(slot3d_front_center) 신규 기능.
// 근거: 01_architect_plan.md §6 + 02_developer_changes.md.
//
// 검증 대상:
//   1) frontFaceCenter(web/core.js)         — 앞면 인덱스 [0,3,7,4] 평균 / h=0 퇴화 등가 / null 가드
//   2) frontFaceCenterPx(src/ground/project.ts) — 동일 인덱스·null 가드(픽셀)
//   3) 파리티(★핵심) — 동일 GroundModel+floorQuad+h 에서 표시(core.js 정규화) == 저장(project.ts 픽셀→정규화)
//   4) slotFrontCenter — Finalizer 내부 헬퍼(비export) → Finalizer 경로로 종단 검증(정상 0~1 / 퇴화 null)
//   5) SqliteStore 마이그레이션 — 컬럼 없는 기존 DB → ALTER 컬럼 생성·행 보존 + {x,y}/null 왕복
//   6) Finalizer — ground 미주입→전부 null(강등, 나머지 저장 정상) / ground 주입(모킹)→값 채워짐
//
// 경계면 교차검증(리포트 대상): core.js FRONT_FACE_IDX 와 project.ts FRONT_FACE_IDX 동일([0,3,7,4]),
//   저장점 정규화 0~1 규약, 파리티 수치 일치(1e-6).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { projectCuboid, frontFaceCenter } from '../web/core.js';
import type { ViewerGroundModel } from '../web/core.js';
import {
  frontFaceCenterPx,
  projectCuboidPixels,
  backprojectToGround,
} from '../src/ground/project.js';
import type { Px, Vec3 } from '../src/ground/contactTypes.js';
import type { GroundModel } from '../src/ground/types.js';
import type { NormalizedPoint } from '../src/domain/types.js';

import { Finalizer } from '../src/capture/Finalizer.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { aggregate } from '../src/capture/Aggregator.js';
import type { Repository } from '../src/store/Repository.js';
import type { SetupArtifact } from '../src/domain/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { CaptureSnapshot } from '../src/capture/CaptureJob.js';
import type { DetectionRow } from '../src/capture/types.js';
import { round5 } from '../src/util/round.js';
import { buildGroundInputs } from '../src/ground/groundInputs.js';
import { estimateGroundModels } from '../src/ground/groundModel.js';
import { loadToolsConfig } from '../src/config/toolsConfig.js';

const DEG = Math.PI / 180;

/** tilt 만 있는 합성 지면모델(하향 법선 n=[0,cos t,sin t]). core.js/project.ts 양쪽에서 쓰는 필드 완비. */
function makeGround(tiltDeg: number, imgW = 1000, imgH = 1000, f = 900): GroundModel {
  const t = tiltDeg * DEG;
  return {
    camIdx: 1, presetIdx: 1, imgW, imgH, zoom: 1, f,
    n: [0, Math.cos(t), Math.sin(t)], d: 5.0, tiltDeg, ptzTiltDeg: null, tiltErrDeg: null,
    slotBearingDeg: null, bearingDevDeg: null, dDevRel: null, depthEdgePx: 400,
    metricErr: 0, conf: 1, source: 'file', issues: [],
  };
}

/** PixelQuad 규약: p0=근좌, p1=원좌, p2=원우, p3=근우. near=이미지 하단(y 큼). 지면 유효 영역. */
const FLOOR_QUAD: NormalizedPoint[] = [
  { x: 0.40, y: 0.72 }, // p0 근좌
  { x: 0.42, y: 0.60 }, // p1 원좌
  { x: 0.58, y: 0.60 }, // p2 원우
  { x: 0.60, y: 0.72 }, // p3 근우
];

/** 앞면 = 근접면 = corners[0,3,7,4] 산술평균(테스트 독립 재계산 — 구현 상수 미참조). */
function meanFront(corners: Array<{ x: number; y: number }>): { x: number; y: number } {
  const idx = [0, 3, 7, 4];
  let sx = 0, sy = 0;
  for (const i of idx) { sx += corners[i].x; sy += corners[i].y; }
  return { x: sx / 4, y: sy / 4 };
}

// ─────────────────────────────────────────────────────────────
// 1) frontFaceCenter (web/core.js) — 정규화
// ─────────────────────────────────────────────────────────────
describe('frontFaceCenter (web/core.js) — 앞면 [0,3,7,4] 평균 / 퇴화 / null', () => {
  const g = makeGround(15) as unknown as ViewerGroundModel;

  it('정상 8corner → [0,3,7,4] 산술평균과 일치', () => {
    const cub = projectCuboid(FLOOR_QUAD, g, 1.5);
    expect(cub).not.toBeNull();
    const fc = frontFaceCenter(cub);
    expect(fc).not.toBeNull();
    const want = meanFront(cub!.corners);
    expect(fc!.x).toBeCloseTo(want.x, 12);
    expect(fc!.y).toBeCloseTo(want.y, 12);
  });

  it('h=0 퇴화(상면==바닥) → avg(p0,p3)(정규화 바닥 근접 edge 중점)와 등가(대안 B 봉인)', () => {
    const cub = projectCuboid(FLOOR_QUAD, g, 0);
    expect(cub).not.toBeNull();
    // h=0 → 상면 corner 4..7 ≈ 바닥 0..3
    expect(cub!.corners[4].x).toBeCloseTo(cub!.corners[0].x, 9);
    expect(cub!.corners[4].y).toBeCloseTo(cub!.corners[0].y, 9);
    expect(cub!.corners[7].x).toBeCloseTo(cub!.corners[3].x, 9);
    expect(cub!.corners[7].y).toBeCloseTo(cub!.corners[3].y, 9);
    const fc = frontFaceCenter(cub);
    const p0 = FLOOR_QUAD[0], p3 = FLOOR_QUAD[3];
    expect(fc!.x).toBeCloseTo((p0.x + p3.x) / 2, 12);
    expect(fc!.y).toBeCloseTo((p0.y + p3.y) / 2, 12);
  });

  it('corners<8 → null', () => {
    expect(frontFaceCenter({ corners: [{ x: 0, y: 0 }], edges: [] } as never)).toBeNull();
  });

  it('비유한 corner → null', () => {
    const cub = projectCuboid(FLOOR_QUAD, g, 1.5)!;
    const bad = { corners: cub.corners.map((c, i) => (i === 3 ? { x: NaN, y: c.y } : c)), edges: cub.edges };
    expect(frontFaceCenter(bad as never)).toBeNull();
  });

  it('null/undefined cuboid → null', () => {
    expect(frontFaceCenter(null)).toBeNull();
    expect(frontFaceCenter(undefined)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// 2) frontFaceCenterPx (src/ground/project.ts) — 픽셀
// ─────────────────────────────────────────────────────────────
describe('frontFaceCenterPx (src/ground/project.ts) — 동일 인덱스·null 가드', () => {
  const eight: Px[] = [
    { x: 10, y: 40 }, { x: 12, y: 10 }, { x: 30, y: 10 }, { x: 32, y: 40 }, // 바닥 0..3
    { x: 11, y: 34 }, { x: 13, y: 6 }, { x: 29, y: 6 }, { x: 31, y: 34 },   // 상면 4..7
  ];

  it('정상 8corner → [0,3,7,4] 평균', () => {
    const fc = frontFaceCenterPx(eight);
    const want = meanFront(eight);
    expect(fc).toEqual(want);
  });

  it('corners 길이≠8 → null', () => {
    expect(frontFaceCenterPx(eight.slice(0, 7))).toBeNull();
    expect(frontFaceCenterPx([...eight, { x: 1, y: 1 }])).toBeNull();
  });

  it('비유한 corner → null', () => {
    const bad = eight.map((c, i) => (i === 7 ? { x: c.x, y: Infinity } : c));
    expect(frontFaceCenterPx(bad)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// 3) 파리티(★핵심) — 표시(core.js) == 저장(project.ts)
// ─────────────────────────────────────────────────────────────
describe('파리티 — 동일 입력에서 표시점(정규화)과 저장점(픽셀→정규화) 수치 일치(1e-6)', () => {
  /** slotFrontCenter 와 동일 파이프라인: 정규화 quad → 픽셀 → 지면 → 육면체 픽셀 → 앞면중심 픽셀 → /imgW,/imgH. */
  function serverNormFront(quad: NormalizedPoint[], g: GroundModel, h: number): { x: number; y: number } | null {
    const floorGround: Vec3[] = [];
    for (const p of quad) {
      const X = backprojectToGround({ x: p.x * g.imgW, y: p.y * g.imgH }, g);
      if (!X) return null;
      floorGround.push(X);
    }
    const corners = projectCuboidPixels(floorGround, h, g);
    if (!corners) return null;
    const c = frontFaceCenterPx(corners);
    if (!c) return null;
    return { x: c.x / g.imgW, y: c.y / g.imgH };
  }

  it.each([
    { tiltDeg: 8, h: 1.5 },
    { tiltDeg: 15, h: 1.5 },
    { tiltDeg: 22, h: 2.4 },
    { tiltDeg: 15, h: 0.0 },
  ])('tilt=$tiltDeg h=$h — core.js frontFaceCenter == project.ts frontFaceCenterPx(/img)', ({ tiltDeg, h }) => {
    const g = makeGround(tiltDeg);
    const cub = projectCuboid(FLOOR_QUAD, g as unknown as ViewerGroundModel, h);
    expect(cub).not.toBeNull();
    const disp = frontFaceCenter(cub);
    expect(disp).not.toBeNull();

    const stored = serverNormFront(FLOOR_QUAD, g, h);
    expect(stored).not.toBeNull();

    expect(disp!.x).toBeCloseTo(stored!.x, 6);
    expect(disp!.y).toBeCloseTo(stored!.y, 6);
    // 저장점 정규화 규약(0~1) — 픽셀 누수 금지.
    expect(stored!.x).toBeGreaterThanOrEqual(0);
    expect(stored!.x).toBeLessThanOrEqual(1);
    expect(stored!.y).toBeGreaterThanOrEqual(0);
    expect(stored!.y).toBeLessThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────
// 5) SqliteStore 마이그레이션 + 왕복
// ─────────────────────────────────────────────────────────────
describe('SqliteStore — slot3d_front_center 마이그레이션 + 왕복', () => {
  let dir: string | undefined;
  let store: SqliteStore | undefined;
  afterEach(() => {
    store?.close(); store = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('컬럼 없는 기존 스키마 DB → ALTER 로 컬럼 생성 + 기존 행 보존(null)', () => {
    dir = mkdtempSync(join(tmpdir(), 'migr-'));
    const dbPath = join(dir, 'legacy.sqlite');
    // 레거시 slot_setup(신 컬럼 부재) 직접 생성 + 1행 삽입(FK OFF 기본 — 부모 불요).
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE slot_setup (
        slot_id INTEGER PRIMARY KEY, cam_id INTEGER NOT NULL, preset_id INTEGER NOT NULL,
        preset_slotidx INTEGER, slot_roi TEXT NOT NULL, vpd_bbox TEXT, lpd_obb TEXT,
        occupy_range TEXT, pan REAL, tilt REAL, zoom REAL,
        centered INTEGER NOT NULL DEFAULT 0, img1 TEXT, updated_at TEXT
      );
      CREATE TABLE preset_pos (cam_id INTEGER, preset_id INTEGER, sname TEXT, pan REAL, tilt REAL, zoom REAL, updated_at TEXT, PRIMARY KEY(cam_id,preset_id));
      INSERT INTO preset_pos VALUES (1,1,'P',0,0,1,'T');
      INSERT INTO slot_setup (slot_id,cam_id,preset_id,preset_slotidx,slot_roi,centered,updated_at)
        VALUES (7,1,1,1,'[{"x":0.2,"y":0.2}]',0,'T0');
    `);
    // 마이그레이션 전: 컬럼 부재 확인.
    const before = raw.prepare(`PRAGMA table_info(slot_setup)`).all() as { name: string }[];
    expect(before.some((c) => c.name === 'slot3d_front_center')).toBe(false);
    raw.close();

    // SqliteStore 오픈 → ensureSchema 가 ALTER 수행.
    store = new SqliteStore(dbPath);
    const cols = (store as unknown as { db: Database.Database }).db
      .prepare(`PRAGMA table_info(slot_setup)`).all() as { name: string }[];
    expect(cols.some((c) => c.name === 'slot3d_front_center')).toBe(true);

    // 기존 행 보존 + 신 필드 null 복원.
    const rows = store.getSlotSetup();
    expect(rows).toHaveLength(1);
    expect(rows[0].slotId).toBe(7);
    expect(rows[0].slot3dFrontCenter).toBeNull();
  });

  it('replaceSlotSetup → getSlotSetup 왕복: {x,y} 복원 + null 왕복', () => {
    store = new SqliteStore(':memory:');
    store.upsertPlaceInfo([{ placeId: 1, placeName: 'P' }]);
    store.upsertCameraInfo([{
      camId: 1, camName: null, camUuid: null, url: null, userId: null, password: null, rtspUrl: null,
      camType: 'ptz', camCompany: null, placeId: 1, imgW: 1000, imgH: 1000, updatedAt: 'T',
    }]);
    store.upsertPresetPos([{ camId: 1, presetId: 1, sname: null, pan: 0, tilt: 0, zoom: 1, updatedAt: 'T' }]);

    const roi = JSON.stringify([{ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.5 }, { x: 0.2, y: 0.5 }]);
    const base = {
      camId: 1, presetId: 1, slotRoi: roi, vpdBbox: null, lpdObb: null, occupyRange: null,
      pan: null, tilt: null, zoom: null, centered: 0, img1: null, updatedAt: 'T',
    } as const;
    store.replaceSlotSetup([
      { slotId: 1, presetSlotIdx: 1, ...base, slot3dFrontCenter: JSON.stringify({ x: 0.512345, y: 0.678901 }) },
      { slotId: 2, presetSlotIdx: 2, ...base, slot3dFrontCenter: null },
    ]);
    const rows = store.getSlotSetup();
    const s1 = rows.find((r) => r.slotId === 1)!;
    const s2 = rows.find((r) => r.slotId === 2)!;
    expect(s1.slot3dFrontCenter).toEqual({ x: 0.512345, y: 0.678901 });
    expect(s2.slot3dFrontCenter).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// 4)+6) Finalizer — slotFrontCenter 종단 검증(비export 헬퍼는 Finalizer 경로로)
// ─────────────────────────────────────────────────────────────
describe('Finalizer — slot3d_front_center 채움/강등', () => {
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
  function mem(): SqliteStore { const s = new SqliteStore(':memory:'); stores.push(s); return s; }
  function seedFk(store: SqliteStore): void {
    store.upsertPlaceInfo([{ placeId: 1, placeName: 'P' }]);
    store.upsertCameraInfo([{
      camId: 1, camName: null, camUuid: null, url: null, userId: null, password: null, rtspUrl: null,
      camType: 'ptz', camCompany: null, placeId: 1, imgW: 1000, imgH: 1000, updatedAt: 'T',
    }]);
    store.upsertPresetPos([{ camId: 1, presetId: 1, sname: null, pan: 0, tilt: 0, zoom: 1, updatedAt: 'T' }]);
  }
  /** 슬롯 폴리곤(픽셀, imageWidth/Height=1000 → /1000 정규화). 지면 유효 영역(하단). */
  const POLY: number[][] = [[400, 720], [420, 600], [580, 600], [600, 720]];
  const POLY_NORM: NormalizedPoint[] = POLY.map(([x, y]) => ({ x: x / 1000, y: y / 1000 }));

  function writePlaceRoi(): string {
    const dir = mkdtempSync(join(tmpdir(), 'front-placeroi-'));
    dirs.push(dir);
    const file = join(dir, 'PtzCamRoi.json');
    writeFileSync(file, JSON.stringify({
      cameras: [{ camera: { cam_id: 1, imageWidth: 1000, imageHeight: 1000 },
        presets: [{ preset_idx: 1, parking_spaces: [{ idx: 1, points: POLY }] }] }],
    }));
    return file;
  }
  function snapshot(dets: DetectionRow[], presetRounds: Map<string, number>): CaptureSnapshot {
    const aggregated = aggregate(dets, presetRounds, {
      clusterDist: captureCfg.clusterDist, clusterMinSupport: captureCfg.clusterMinSupport, minConfidence: captureCfg.minConfidence,
    });
    return { dets, presetRounds, aggregated, occByPreset: new Map() };
  }
  /** 폴리곤 내부(0.5,0.66 근방) 안정 차량 클러스터. */
  function dets(): { dets: DetectionRow[]; presetRounds: Map<string, number> } {
    const d: DetectionRow[] = [];
    for (const round of [1, 2, 3]) {
      d.push({ observationId: round, roundIdx: round, camIdx: 1, presetIdx: 1, kind: 'vehicle', x: 0.46, y: 0.62, w: 0.08, h: 0.06, conf: 0.9 });
    }
    return { dets: d, presetRounds: new Map([['1:1', 3]]) };
  }

  it('ground 미주입 → 모든 row slot3dFrontCenter=null(강등, 나머지 저장 정상)', async () => {
    const store = mem();
    seedFk(store);
    const { dets: d, presetRounds } = dets();
    const fin = new Finalizer({ store, repo: fakeRepo(), cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T', placeRoiFile: writePlaceRoi() });
    await fin.finalize(snapshot(d, presetRounds));

    const rows = store.getSlotSetup();
    expect(rows).toHaveLength(1);
    expect(rows[0].slot3dFrontCenter).toBeNull(); // ground 미주입 → 강등
    expect(rows[0].roi).toHaveLength(4);           // 나머지 저장은 정상
  });

  it('ground 주입(모킹 지면모델) → slot3dFrontCenter 채워짐(0~1) + 저장점 == 파리티 계산값', async () => {
    const store = mem();
    seedFk(store);
    const { dets: d, presetRounds } = dets();
    const g = makeGround(15);
    const fin = new Finalizer({ store, repo: fakeRepo(), cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T', placeRoiFile: writePlaceRoi() });
    // 비export private buildGroundModelMap 를 모킹 지면모델 맵으로 대체(추정 파이프라인 격리).
    vi.spyOn(fin as unknown as { buildGroundModelMap: () => Promise<Map<string, GroundModel>> }, 'buildGroundModelMap')
      .mockResolvedValue(new Map([['1:1', g]]));
    await fin.finalize(snapshot(d, presetRounds));

    const rows = store.getSlotSetup();
    expect(rows).toHaveLength(1);
    const fc = rows[0].slot3dFrontCenter;
    expect(fc).not.toBeNull();
    expect(fc!.x).toBeGreaterThan(0); expect(fc!.x).toBeLessThan(1);
    expect(fc!.y).toBeGreaterThan(0); expect(fc!.y).toBeLessThan(1);

    // 저장점이 독립 재계산(H_CONST=1.5)과 일치 — Finalizer 배선(quad→모델→앞면중심) 정합.
    const floorGround: Vec3[] = POLY_NORM.map((p) => backprojectToGround({ x: p.x * g.imgW, y: p.y * g.imgH }, g)!);
    const corners = projectCuboidPixels(floorGround, 1.5, g)!;
    const cpx = frontFaceCenterPx(corners)!;
    // ★ 영속화 5자리: slot3d_front_center TEXT 는 Finalizer 가 stringify5 로 기록 → 저장점 fc 는 5자리.
    //   파리티 계산값(cpx/img 롱플로트)을 저장 정밀도(round5)로 맞춰 정확 비교 — 배선 정합 검증 의도 유지
    //   (원래 9자리 근사비교 → 5자리 저장 규약에선 round5 후 정확 일치가 더 강한 검증).
    expect(fc!.x).toBe(round5(cpx.x / g.imgW));
    expect(fc!.y).toBe(round5(cpx.y / g.imgH));
  });

  it('ground 주입이어도 슬롯 quad 가 지평선 위(퇴화) → slotFrontCenter null 강등', async () => {
    const store = mem();
    seedFk(store);
    // 상단(y 작음) 폴리곤 → 급 tilt 지면모델에서 backproject 지평선 위 → null.
    const dir = mkdtempSync(join(tmpdir(), 'front-degen-'));
    dirs.push(dir);
    const file = join(dir, 'PtzCamRoi.json');
    writeFileSync(file, JSON.stringify({
      cameras: [{ camera: { cam_id: 1, imageWidth: 1000, imageHeight: 1000 },
        presets: [{ preset_idx: 1, parking_spaces: [{ idx: 1, points: [[400, 20], [420, 10], [580, 10], [600, 20]] }] }] }],
    }));
    const d: DetectionRow[] = [];
    const g = makeGround(2); // 거의 수평 → 상단(y≈0.01) 폴리곤이 지평선 위 → backproject null
    const fin = new Finalizer({ store, repo: fakeRepo(), cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T', placeRoiFile: file });
    vi.spyOn(fin as unknown as { buildGroundModelMap: () => Promise<Map<string, GroundModel>> }, 'buildGroundModelMap')
      .mockResolvedValue(new Map([['1:1', g]]));
    await fin.finalize(snapshot(d, new Map([['1:1', 0]])));

    const rows = store.getSlotSetup();
    expect(rows).toHaveLength(1);
    expect(rows[0].slot3dFrontCenter).toBeNull(); // 퇴화 → null(강등)
  });
});

// ═════════════════════════════════════════════════════════════
// [후속] 앞면 기하 자동판정(감김순서-불변) — 잠복 버그 봉인
// 근거: 02_developer_changes.md "[후속] 앞면 기하 자동판정 수정".
// 기존 상수 [0,3,7,4] 는 프리셋1 winding 에만 정답이었고, 회전된 winding(프리셋2형)에서
// 앞면이 우측 측면으로 밀렸다. 아래 테스트가 그 반례를 재현하고 새 로직으로 봉인한다.
// ═════════════════════════════════════════════════════════════
describe('[후속] frontFaceCenter — 감김순서(winding)-불변 판정', () => {
  const g15 = makeGround(15) as unknown as ViewerGroundModel;

  // 물리적으로 동일한 바닥 사각형(프리셋1 순서: 근좌,원좌,원우,근우). near=y 큼.
  const PHYS: NormalizedPoint[] = [
    { x: 0.40, y: 0.72 }, // A 근좌
    { x: 0.42, y: 0.60 }, // B 원좌
    { x: 0.58, y: 0.60 }, // C 원우
    { x: 0.60, y: 0.72 }, // D 근우
  ];
  /** 왼쪽 순환 회전 k칸: rotate(a,1)=[B,C,D,A]. rotate(a,3)=[D,A,B,C](프리셋2형 "한 칸 회전"). */
  const rotate = (a: NormalizedPoint[], k: number): NormalizedPoint[] =>
    a.map((_, i) => a[(i + k) % a.length]);

  /** 옛 고정 로직 재현: 앞면 = corners[0,3,7,4] 산술평균(구현 미참조, 테스트 독립). */
  const meanOld = (corners: Array<{ x: number; y: number }>) => meanFront(corners);

  it('1) 네 회전(0·1·2·3칸) 모두 frontFaceCenter 가 동일 점(1e-9) — 시작 corner 선택에 불변', () => {
    const centers = [0, 1, 2, 3].map((k) => {
      const cub = projectCuboid(rotate(PHYS, k), g15, 1.5);
      expect(cub).not.toBeNull();
      const fc = frontFaceCenter(cub);
      expect(fc).not.toBeNull();
      return fc!;
    });
    for (let k = 1; k < centers.length; k++) {
      expect(centers[k].x).toBeCloseTo(centers[0].x, 9);
      expect(centers[k].y).toBeCloseTo(centers[0].y, 9);
    }
    // 근접면 중심 x=0.5(대칭 quad). y 는 상면 corner 포함으로 바닥 near-y(0.72)보다 위(작음).
    expect(centers[0].x).toBeCloseTo(0.5, 9);
  });

  it('2) 회전 winding(프리셋2형 [D,A,B,C])에서 새 로직=근접면 vs 옛 [0,3,7,4]=우측 측면(반례)', () => {
    // k=3 → [근우,근좌,원좌,원우] = 프리셋2형 한 칸 회전.
    const cubRot = projectCuboid(rotate(PHYS, 3), g15, 1.5)!;
    const fnew = frontFaceCenter(cubRot)!;
    const fold = meanOld(cubRot.corners); // 고정 [0,3,7,4]

    // 새 로직: 근접면 중심(x=0.5). 옛 로직: 우측 측면으로 밀려 x>0.5.
    expect(fnew.x).toBeCloseTo(0.5, 9);
    expect(fold.x).toBeGreaterThan(fnew.x + 0.05); // 옛 로직이 우측으로 밀림(반례 명시)
    // 앞면 4점이 '이미지 y 큰(근접) 바닥 edge' 에서 나오는지: 선택 바닥 두 corner 의 평균 y 가 최대 edge.
    const b = cubRot.corners.slice(0, 4).map((c) => c.y);
    const EDGES: Array<[number, number]> = [[0, 1], [1, 2], [2, 3], [3, 0]];
    const avgs = EDGES.map(([i, j]) => (b[i] + b[j]) / 2);
    const nearEdge = avgs.indexOf(Math.max(...avgs));
    expect(nearEdge).toBe(0); // [D,A,B,C] 의 근접 edge = [0,1](=D-A). 옛 로직의 [3,0] 아님.
  });

  it('3) 파리티(회전 포함): 각 회전에서 frontFaceCenter(정규화) ≡ frontFaceCenterPx(픽셀→정규화) 1e-6', () => {
    const g = makeGround(15);
    for (const k of [0, 1, 2, 3]) {
      const quad = rotate(PHYS, k);
      const disp = frontFaceCenter(projectCuboid(quad, g as unknown as ViewerGroundModel, 1.5));
      expect(disp).not.toBeNull();
      // 서버 픽셀 경로(slotFrontCenter 와 동일 파이프라인).
      const floorGround: Vec3[] = quad.map((p) => backprojectToGround({ x: p.x * g.imgW, y: p.y * g.imgH }, g)!);
      const corners = projectCuboidPixels(floorGround, 1.5, g)!;
      const cpx = frontFaceCenterPx(corners)!;
      const stored = { x: cpx.x / g.imgW, y: cpx.y / g.imgH };
      expect(disp!.x).toBeCloseTo(stored.x, 6);
      expect(disp!.y).toBeCloseTo(stored.y, 6);
    }
  });

  it('4) 프리셋1 등가(회귀): 프리셋1 winding 에서 새 로직 == 옛 [0,3,7,4] 결과(불변 봉인)', () => {
    const cub = projectCuboid(PHYS, g15, 1.5)!; // 프리셋1 순서(회전 0)
    const fnew = frontFaceCenter(cub)!;
    const fold = meanOld(cub.corners);
    expect(fnew.x).toBeCloseTo(fold.x, 12);
    expect(fnew.y).toBeCloseTo(fold.y, 12);
  });
});

// ─────────────────────────────────────────────────────────────
// 5) 실데이터 스모크 — data/Place01/PtzCamRoi.json **전 카메라·전 프리셋**
//
//    ★ 재정박 이력(2026-07-22): 이 블록은 원래 "cam1 프리셋2(idx 8–13, 6면)" 에 하드코딩돼 있었고
//      지면모델도 옛 라이브 응답을 상수로 동결했었다. 시뮬레이터가 ROI 파일을 재생성하면서
//      (프리셋 구성·면 개수·winding·PTZ 전부 변경) 세 전제가 모두 만료돼 실패했다.
//      → 특정 프리셋/개수/winding 에 기대지 않도록 **데이터 주도**로 재작성한다:
//        · 지면모델은 상수 대신 **실제 파이프라인**(buildGroundInputs→estimateGroundModels)으로 산출
//        · 대상은 파일이 담은 전 프리셋, 개수는 파일에서 유도
//        · winding 불변 자체는 위 1~4(합성·4회전 전수)가 결정적으로 봉인한다. 여기서는 실데이터에서
//          **새 로직이 자기 슬롯을 이탈하지 않는다**는 불변만 본다(옛 로직 이탈 건수는 참고 출력).
// ─────────────────────────────────────────────────────────────
describe('[후속] 실데이터 스모크 — PtzCamRoi.json 앞면중심 근접면 검증', () => {
  const ROI_PATH = join(process.cwd(), 'data', 'Place01', 'PtzCamRoi.json');
  const hasFile = existsSync(ROI_PATH);

  (hasFile ? it : it.skip)('전 프리셋의 앞면중심이 자기 슬롯 x범위 안(이웃 넘어가지 않음)·화면 안', () => {
    const raw = JSON.parse(readFileSync(ROI_PATH, 'utf8'));
    const tools = loadToolsConfig();

    // 지면모델을 실제 산출 경로로 구한다(옛 동결 상수 폐기 — 데이터가 바뀌면 모델도 같이 따라간다).
    const modelByKey = new Map<string, GroundModel>();
    for (const camInput of buildGroundInputs(raw, [])) {
      for (const m of estimateGroundModels(camInput, tools.ground).models) {
        modelByKey.set(`${m.camIdx}:${m.presetIdx}`, m);
      }
    }
    expect(modelByKey.size, '실데이터에서 지면모델이 하나도 안 나왔다').toBeGreaterThan(0);

    let evaluated = 0;
    let oldWouldEscape = 0; // 옛 고정 [0,3,7,4] 였다면 자기 슬롯을 벗어났을 건수(버그 교정 증거, 참고).
    let totalSpaces = 0;
    for (const camEntry of raw.cameras as Array<{
      camera: { cam_id: number; imageWidth: number; imageHeight: number };
      presets: Array<{ preset_idx: number; parking_spaces: Array<{ idx: number; points: number[][] }> }>;
    }>) {
      const W = camEntry.camera.imageWidth, H = camEntry.camera.imageHeight;
      for (const preset of camEntry.presets) {
        totalSpaces += preset.parking_spaces.length;
        const key = `${camEntry.camera.cam_id}:${preset.preset_idx}`;
        const g = modelByKey.get(key);
        if (!g) continue; // 그 프리셋 추정 실패 → 육면체 미산출(강등 철학). 평가 대상에서 제외.
        for (const sp of preset.parking_spaces) {
          const quad: NormalizedPoint[] = sp.points.map(([x, y]) => ({ x: x / W, y: y / H }));
          const xs = quad.map((p) => p.x);
          const minX = Math.min(...xs), maxX = Math.max(...xs);
          const cub = projectCuboid(quad, g as unknown as ViewerGroundModel, 1.5);
          if (!cub) continue; // 퇴화(지평선 위 등) → 그 면만 skip(렌더와 동일 강등).
          const fnew = frontFaceCenter(cub)!;

          // ★ 불변: 새 로직 앞면중심은 자기 슬롯 x범위 안이고 화면 안이다.
          expect(fnew.x, `${key} idx ${sp.idx}: new.x ${fnew.x} 가 자기 범위 [${minX},${maxX}] 이탈`)
            .toBeGreaterThanOrEqual(minX);
          expect(fnew.x, `${key} idx ${sp.idx}: new.x ${fnew.x} 가 자기 범위 [${minX},${maxX}] 이탈`)
            .toBeLessThanOrEqual(maxX);
          expect(fnew.y).toBeGreaterThan(0);
          expect(fnew.y).toBeLessThan(1);

          const fold = meanFront(cub.corners); // 옛 고정 [0,3,7,4]
          if (fold.x < minX || fold.x > maxX) oldWouldEscape++;
          evaluated++;
        }
      }
    }
    // 파일이 담은 면 수는 데이터에서 유도(하드코딩 금지). 최소 1건은 실제로 평가돼야 스모크 의미가 있다.
    expect(totalSpaces).toBeGreaterThan(0);
    expect(evaluated, '평가된 슬롯이 0건 — 지면모델·투영이 전부 강등됐다').toBeGreaterThan(0);
    console.log(
      `[실데이터 스모크] 파일 ${totalSpaces}면 중 ${evaluated}면 평가 · 옛 고정인덱스였다면 이탈했을 건수 ${oldWouldEscape}`,
    );
  });
});
