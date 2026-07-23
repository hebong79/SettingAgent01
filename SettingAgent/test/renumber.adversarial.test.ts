import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { SaveStore } from '../src/store/SaveStore.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type {
  CameraInfoRow,
  PlaceInfoRow,
  PresetPosRow,
  SlotSetupRow,
} from '../src/capture/types.js';
import type { CapturedImage, SetupArtifact } from '../src/domain/types.js';
import type { SlotPtzArtifact } from '../src/calibrate/types.js';

/**
 * 검증자(qa) — 적대적 검증(구멍 파기). 개발자 테스트가 놓친 경계·데이터파괴·원자성 케이스를 메운다.
 *  A. 원시 바이트 보존(round5 무재적용·updated_at 불변·TEXT 컬럼 그대로) — 직접 INSERT 로 비-round5 값 주입.
 *  B. 항등 매핑·완전역순·3-사이클 순열(PK 충돌 없이 정확 이동).
 *  C. parking_slot 참조행 FK 가드(개발자는 parking_evnt 만 검증).
 *  D. 라우트 원자성 — 여러 비순열 케이스 각각 400 & DB/slot_ptz 파일/setup_result 전부 무변경.
 *  E. 경계면 3파일 교차 정합 — DB↔setup_result↔setup_artifact↔slot_ptz 물리슬롯 조인.
 *  F. slot_ptz remap 방어 — items 비배열 JSON → skipped.
 */

// ────────────────────────── 공통 픽스처 ──────────────────────────
const placeRow: PlaceInfoRow = { placeId: 1, placeName: 'Place01' };
const cameraRow: CameraInfoRow = {
  camId: 1, camName: null, camUuid: null, url: null, userId: null, password: null, rtspUrl: null,
  camType: 'ptz', camCompany: null, placeId: 1, imgW: 1920, imgH: 1080, updatedAt: 'T',
};
const presetRow = (over: Partial<PresetPosRow> = {}): PresetPosRow => ({
  camId: 1, presetId: 1, sname: 'P', pan: 10, tilt: 5, zoom: 2, updatedAt: 'T', ...over,
});
const roi = [{ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.2 }, { x: 0.55, y: 0.5 }, { x: 0.2, y: 0.48 }];
const slot = (over: Partial<SlotSetupRow> = {}): SlotSetupRow => ({
  slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1,
  slotRoi: JSON.stringify(roi), vpdBbox: null, lpdObb: null, occupyRange: null,
  pan: 10, tilt: 5, zoom: 3, centered: 1, img1: 'a.jpg', slot3dFrontCenter: null, updatedAt: 'T', ...over,
});

function seededStore(presets: PresetPosRow[] = [presetRow()]): SqliteStore {
  const s = new SqliteStore(':memory:');
  s.upsertPlaceInfo([placeRow]);
  s.upsertCameraInfo([cameraRow]);
  s.upsertPresetPos(presets);
  return s;
}
const rawDb = (s: SqliteStore) => (s as unknown as { db: Database.Database }).db;

let store: SqliteStore | undefined;
let app: FastifyInstance | undefined;
let dir: string | undefined;
afterEach(async () => {
  await app?.close();
  store?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  app = undefined; store = undefined; dir = undefined;
});

// ══════════════════════════ A. 원시 바이트 보존 ══════════════════════════
describe('adversarial A — 원시 바이트 보존(round5 무재적용·updated_at·TEXT 불변)', () => {
  it('직접 INSERT 한 비-round5 pan(7소수)·TEXT 컬럼·updated_at 이 재번호 후 바이트 그대로', () => {
    store = seededStore();
    const db = rawDb(store);
    // replaceSlotSetup 을 우회해 round5 를 절대 거치지 않은 값 주입(재번호가 round5 를 재적용하면 실패한다).
    const rawPan = 12.3456789;      // 7소수 — round5 시 12.34568 로 바뀜
    const rawTilt = -3.1415926;
    const vpd = JSON.stringify({ x: 0.31, y: 0.32, w: 0.11, h: 0.12 });
    const lpd = JSON.stringify([{ x: 0.33, y: 0.34 }, { x: 0.36, y: 0.35 }, { x: 0.34, y: 0.36 }, { x: 0.32, y: 0.35 }]);
    const occ = JSON.stringify(roi);
    const front = JSON.stringify({ x: 0.5, y: 0.9 });
    db.prepare(
      `INSERT INTO slot_setup (slot_id, cam_id, preset_id, preset_slotidx, slot_roi, vpd_bbox, lpd_obb, occupy_range, pan, tilt, zoom, centered, img1, slot3d_front_center, updated_at)
       VALUES (7, 1, 1, 1, ?, ?, ?, ?, ?, ?, ?, 1, 'shot/x.jpg', ?, 'ORIG-TS')`,
    ).run(JSON.stringify(roi), vpd, lpd, occ, rawPan, rawTilt, 99.9999999, front);

    const { changed } = store.renumberSlotIds(new Map([[7, 3]]));
    expect(changed).toBe(1);

    const r = db.prepare(`SELECT * FROM slot_setup`).get() as Record<string, unknown>;
    expect(r.slot_id).toBe(3);                 // 라벨만 이동
    expect(r.pan).toBe(rawPan);                // ★ round5 재적용 안 됨(12.3456789 그대로)
    expect(r.tilt).toBe(rawTilt);
    expect(r.zoom).toBe(99.9999999);
    expect(r.vpd_bbox).toBe(vpd);              // TEXT 바이트 동일
    expect(r.lpd_obb).toBe(lpd);
    expect(r.occupy_range).toBe(occ);
    expect(r.slot3d_front_center).toBe(front);
    expect(r.slot_roi).toBe(JSON.stringify(roi));
    expect(r.img1).toBe('shot/x.jpg');
    expect(r.centered).toBe(1);
    expect(r.updated_at).toBe('ORIG-TS');      // ★ updated_at 덮어쓰기 안 됨
    expect(r.cam_id).toBe(1);
    expect(r.preset_id).toBe(1);
    expect(r.preset_slotidx).toBe(1);
  });
});

// ══════════════════════════ B. 순열 다양성 ══════════════════════════
describe('adversarial B — 항등·완전역순·3사이클 순열', () => {
  const seed3 = (): SqliteStore => {
    const s = seededStore([presetRow({ presetId: 1 }), presetRow({ presetId: 2 }), presetRow({ presetId: 3 })]);
    s.replaceSlotSetup([
      slot({ slotId: 1, presetId: 1, presetSlotIdx: 1, img1: 'p1.jpg' }),
      slot({ slotId: 2, presetId: 2, presetSlotIdx: 1, img1: 'p2.jpg' }),
      slot({ slotId: 3, presetId: 3, presetSlotIdx: 1, img1: 'p3.jpg' }),
    ]);
    return s;
  };
  // presetKey('1:P') → 재번호 후 slotId 를 조회하는 헬퍼
  const idAtPreset = (s: SqliteStore, presetId: number) =>
    s.getSlotSetup().find((r) => r.presetKey === `1:${presetId}`)!.slotId;

  it('항등 매핑(변화 없음) → changed=N, 물리 배치·id 그대로', () => {
    store = seed3();
    const { changed } = store.renumberSlotIds(new Map([[1, 1], [2, 2], [3, 3]]));
    expect(changed).toBe(3);
    expect([idAtPreset(store, 1), idAtPreset(store, 2), idAtPreset(store, 3)]).toEqual([1, 2, 3]);
  });

  it('완전 역순 {1→3,2→2,3→1} → PK 충돌 없이 정확 이동', () => {
    store = seed3();
    store.renumberSlotIds(new Map([[1, 3], [2, 2], [3, 1]]));
    expect(idAtPreset(store, 1)).toBe(3); // 물리 preset1 은 new id 3
    expect(idAtPreset(store, 2)).toBe(2);
    expect(idAtPreset(store, 3)).toBe(1);
    // preset1 의 img1 은 여전히 p1.jpg(데이터는 물리슬롯에 고정, 라벨만 이동)
    expect(store.getSlotSetup().find((r) => r.presetKey === '1:1')!.img1).toBe('p1.jpg');
  });

  it('3-사이클 {1→2,2→3,3→1} → PK 충돌 없이 정확 이동', () => {
    store = seed3();
    store.renumberSlotIds(new Map([[1, 2], [2, 3], [3, 1]]));
    expect(idAtPreset(store, 1)).toBe(2);
    expect(idAtPreset(store, 2)).toBe(3);
    expect(idAtPreset(store, 3)).toBe(1);
    expect(store.getSlotSetup().map((r) => r.slotId).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });
});

// ══════════════════════════ C. parking_slot FK 가드 ══════════════════════════
describe('adversarial C — parking_slot 참조행 FK 가드(개발자는 parking_evnt 만 검증)', () => {
  it('parking_slot 1행 존재 → throw & DB 무변경', () => {
    store = seededStore();
    store.replaceSlotSetup([slot({ slotId: 1, presetSlotIdx: 1 })]);
    rawDb(store).prepare(`INSERT INTO parking_slot (slot_id, last_evnt_id) VALUES (1, NULL)`).run();
    expect(() => store!.renumberSlotIds(new Map([[1, 1]]))).toThrow(/not empty/);
    expect(store.getSlotSetup().map((r) => r.slotId)).toEqual([1]); // 무변경
  });
});

// ══════════════════════════ F. slot_ptz remap 방어 ══════════════════════════
describe('adversarial F — slot_ptz items 비배열 JSON → skipped(무예외)', () => {
  it('유효 JSON 이나 items 가 배열이 아니면 skipped, 파일 원본 불변', () => {
    dir = mkdtempSync(join(tmpdir(), 'ptz-noitems-'));
    const f = join(dir, 'slot_ptz.json');
    const orig = JSON.stringify({ createdAt: 'x', items: { not: 'array' } });
    writeFileSync(f, orig, 'utf-8');
    // renumberSlotPtzFile 은 slotPtzRenumber 모듈에서 직접 import 하는 대신 라우트로도 검증되지만
    // 여기선 순수 경로만 재확인(중복 import 회피 위해 require 형태 대신 동적 import).
    return import('../src/calibrate/slotPtzRenumber.js').then(({ renumberSlotPtzFile }) => {
      const res = renumberSlotPtzFile(f, new Map([[1, 1]]));
      expect(res).toBe('skipped');
      expect(readFileSync(f, 'utf-8')).toBe(orig); // 원본 불변
    });
  });
});

// ══════════════════════════ D·E. 라우트 원자성 + 경계면 교차정합 ══════════════════════════
const fakeCamera = () => ({
  health: async () => true,
  requestImage: async (c: number, p: number): Promise<CapturedImage> => ({ camIdx: c, presetIdx: p, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('f') }),
} as unknown as CameraClient);
const fakeVpd = () => ({ health: async () => true, detect: async () => [] } as unknown as VpdClient);
const fakeRepo = (): { repo: Repository; saved: SetupArtifact[] } => {
  const saved: SetupArtifact[] = [];
  return { saved, repo: { saveArtifact: (a: SetupArtifact) => saved.push(a), loadArtifact: () => saved.at(-1) ?? null, path: 'mem' } as unknown as Repository };
};
const slotPtzArtifact: SlotPtzArtifact = {
  createdAt: '2026-07-23T00:00:00.000Z',
  items: [
    { camIdx: 1, presetIdx: 1, slotId: '1', globalIdx: 1, ptz: { pan: 10, tilt: 5, zoom: 3 }, plateWidth: 0.12, centered: true, converged: true },
    { camIdx: 1, presetIdx: 2, slotId: '2', globalIdx: 2, ptz: { pan: 20, tilt: 6, zoom: 4 }, plateWidth: 0.15, centered: true, converged: true },
    { camIdx: 1, presetIdx: 3, slotId: '3', globalIdx: 3, ptz: { pan: 30, tilt: 7, zoom: 5 }, plateWidth: 0.18, centered: true, converged: true },
  ],
};
interface Built { app: FastifyInstance; store: SqliteStore; saved: SetupArtifact[]; saveDir: string; slotPtzFile: string; }
function build(): Built {
  dir = mkdtempSync(join(tmpdir(), 'renum-adv-'));
  const saveDir = join(dir, 'save');
  const slotPtzFile = join(dir, 'slot_ptz.json');
  writeFileSync(slotPtzFile, JSON.stringify(slotPtzArtifact), 'utf-8');
  store = new SqliteStore(':memory:');
  store.upsertPlaceInfo([placeRow]);
  store.upsertCameraInfo([cameraRow]);
  store.upsertPresetPos([presetRow({ presetId: 1 }), presetRow({ presetId: 2 }), presetRow({ presetId: 3 })]);
  store.replaceSlotSetup([
    slot({ slotId: 1, presetId: 1, presetSlotIdx: 1 }),
    slot({ slotId: 2, presetId: 2, presetSlotIdx: 1 }),
    slot({ slotId: 3, presetId: 3, presetSlotIdx: 1 }),
  ]);
  const { repo, saved } = fakeRepo();
  const orchestrator = new SetupOrchestrator({ camera: fakeCamera(), vpd: fakeVpd(), repo, cfg: {
    presetSettleMs: 0, betweenPresetMs: 0, minConfidence: 0.5, roiPadding: 0, yBandTolerance: 0.1,
    accumFrames: 1, accumIntervalMs: 0, clusterDist: 0.06, clusterMinSupport: 1, lpdEnabled: false,
  } as ToolsConfig['setup'], sleep: async () => {}, now: () => 'T' });
  app = buildServer({
    orchestrator, repo, camera: fakeCamera(), vpd: fakeVpd(),
    sqlite: store, saveStore: new SaveStore(saveDir),
    calibrate: { outFile: slotPtzFile } as ToolsConfig['calibrate'],
  });
  return { app, store, saved, saveDir, slotPtzFile };
}

describe('adversarial D — 비순열 원자성(400 & DB/slot_ptz파일/setup_result 전부 무변경)', () => {
  const cases: Array<{ name: string; mapping: Array<{ oldSlotId: number; newSlotId: number }> }> = [
    { name: 'new 범위밖(1..N 초과)', mapping: [{ oldSlotId: 1, newSlotId: 1 }, { oldSlotId: 2, newSlotId: 2 }, { oldSlotId: 3, newSlotId: 9 }] },
    { name: 'new 중복', mapping: [{ oldSlotId: 1, newSlotId: 2 }, { oldSlotId: 2, newSlotId: 2 }, { oldSlotId: 3, newSlotId: 3 }] },
    { name: 'old 중복(3 누락)', mapping: [{ oldSlotId: 1, newSlotId: 1 }, { oldSlotId: 1, newSlotId: 2 }, { oldSlotId: 2, newSlotId: 3 }] },
    { name: 'old 범위밖(존재하지 않는 슬롯)', mapping: [{ oldSlotId: 1, newSlotId: 1 }, { oldSlotId: 2, newSlotId: 2 }, { oldSlotId: 99, newSlotId: 3 }] },
    { name: '개수 불일치(2개만)', mapping: [{ oldSlotId: 1, newSlotId: 1 }, { oldSlotId: 2, newSlotId: 2 }] },
  ];
  for (const c of cases) {
    it(`${c.name} → 400 & 무변경`, async () => {
      const b = build();
      const origPtz = readFileSync(b.slotPtzFile, 'utf-8');
      const res = await b.app.inject({ method: 'POST', url: '/mapping/renumber', payload: { mapping: c.mapping } });
      expect(res.statusCode).toBe(400);
      // DB slot_id 불변
      expect(b.store.getSlotSetup().map((r) => r.slotId).sort((a, d) => a - d)).toEqual([1, 2, 3]);
      // slot_ptz.json 바이트 불변(검증 전 단계라 파일 전파 자체가 없어야 함)
      expect(readFileSync(b.slotPtzFile, 'utf-8')).toBe(origPtz);
      // setup_result.json 미생성(검증 실패 → 파일 전파 없음)
      expect(existsSync(join(b.saveDir, 'setup_result.json'))).toBe(false);
      // setup_artifact 저장 안 됨
      expect(b.saved.length).toBe(0);
    });
  }
});

describe('adversarial E — 경계면 3파일 교차정합(DB↔setup_result↔setup_artifact↔slot_ptz)', () => {
  it('순열 {1→3,2→1,3→2} 후 물리슬롯별 4소스 전역ID 일치 & globalIdx==Number(slotId)', async () => {
    const b = build();
    const res = await b.app.inject({
      method: 'POST', url: '/mapping/renumber',
      payload: { mapping: [{ oldSlotId: 1, newSlotId: 3 }, { oldSlotId: 2, newSlotId: 1 }, { oldSlotId: 3, newSlotId: 2 }] },
    });
    expect(res.statusCode).toBe(200);

    // DB: 물리 preset p → new id
    const dbRows = b.store.getSlotSetup();
    const dbIdByPreset = new Map(dbRows.map((r) => [r.presetId, r.slotId]));
    expect(dbIdByPreset.get(1)).toBe(3);
    expect(dbIdByPreset.get(2)).toBe(1);
    expect(dbIdByPreset.get(3)).toBe(2);

    // setup_artifact: globalIndex 각 항목 globalIdx===Number(slotId) & presetIdx 로 조인 시 DB 와 일치
    const artifact = b.saved.at(-1)!;
    for (const g of artifact.globalIndex) {
      expect(g.globalIdx).toBe(Number(g.slotId));           // ★ globalIdx==slotId 불변식
      expect(dbIdByPreset.get(g.presetIdx)).toBe(g.globalIdx); // presetIdx 조인으로 DB 와 정합
    }

    // setup_result.json: slotId(=DB slot_id) 가 presetId 조인으로 DB 와 일치
    const sr = JSON.parse(readFileSync(join(b.saveDir, 'setup_result.json'), 'utf-8')) as {
      slots: Array<{ slotId: number; presetId: number }>;
    };
    for (const s of sr.slots) expect(dbIdByPreset.get(s.presetId)).toBe(s.slotId);

    // slot_ptz.json: presetIdx 조인으로 slotId/globalIdx 가 DB new id 와 일치 & new asc 정렬
    const ptz = JSON.parse(readFileSync(b.slotPtzFile, 'utf-8')) as SlotPtzArtifact;
    expect(ptz.items.map((i) => i.globalIdx)).toEqual([1, 2, 3]); // new asc
    for (const it of ptz.items) {
      expect(it.globalIdx).toBe(Number(it.slotId));            // ★ slotId(str)==globalIdx(num)
      expect(dbIdByPreset.get(it.presetIdx)).toBe(it.globalIdx); // presetIdx 조인 정합
    }
    // plateWidth 는 물리슬롯(presetIdx)에 고정 — preset1 은 원래 0.12 그대로(라벨만 3 으로)
    expect(ptz.items.find((i) => i.presetIdx === 1)!.plateWidth).toBe(0.12);
    expect(ptz.items.find((i) => i.presetIdx === 1)!.globalIdx).toBe(3);
  });
});
