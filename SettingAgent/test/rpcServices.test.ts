import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import { RpcCode } from '../src/rpc/errors.js';
import { normalizePtzCamRoi } from '../src/capture/placeRoi.js';
import { rectToQuad } from '../src/domain/geometry.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { LpdClient, PlateBox } from '../src/clients/LpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { SlotSetupView } from '../src/capture/types.js';
import type { CapturedImage, SetupArtifact } from '../src/domain/types.js';

/**
 * 검증자(qa-tester): RPC 승격 서비스(REST 에 대응 라우트가 **없는** 기능) 통합 검증.
 *   place.space.* / place.preset.clear / place.align.apply / place.backups / place.revert
 *   cam.preset.* / setup.mapping.autoNumber / plate.pickAt
 *
 * ★ 가장 중요한 계약: **가드 거부 시 파일이 1바이트도 바뀌지 않는다**(설계서 §9 / 다이어그램 §8).
 *   이 저장소의 실사고(8면→7면 소실, 센터링 23→0)가 전부 "쓰기 전 검사 부재" 에서 나왔다.
 */

const setupCfg = {
  presetSettleMs: 0, betweenPresetMs: 0, minConfidence: 0.5, roiPadding: 0, yBandTolerance: 0.1,
  accumFrames: 1, accumIntervalMs: 0, clusterDist: 0.06, clusterMinSupport: 1, lpdEnabled: false,
};

const PLACE_FIXTURE = {
  cameras: [
    {
      camera: { cam_id: 1, imageWidth: 1000, imageHeight: 1000 },
      presets: [
        {
          preset_idx: 1,
          pan: 10, tilt: -5, zoom: 2,
          parking_spaces: [
            { idx: 1, points: [[100, 100], [200, 100], [200, 200], [100, 200]] },
            { idx: 2, points: [[200, 100], [300, 100], [300, 200], [200, 200]] },
          ],
        },
        {
          preset_idx: 2,
          pan: 40, tilt: -5, zoom: 2,
          parking_spaces: [{ idx: 3, points: [[400, 100], [500, 100], [500, 200], [400, 200]] }],
        },
      ],
    },
  ],
};

const fakeCamera = () => ({
  health: async () => true,
  clampZoom: (z: number) => z,
  requestImage: async (c: number, p: number): Promise<CapturedImage> =>
    ({ camIdx: c, presetIdx: p, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('f') }),
} as unknown as CameraClient);
const fakeVpd = () => ({ health: async () => true, detect: async () => [] } as unknown as VpdClient);
const fakeRepo = () => {
  const saved: SetupArtifact[] = [];
  return { saveArtifact: (a: SetupArtifact) => saved.push(a), loadArtifact: () => saved.at(-1) ?? null, path: 'mem' } as unknown as Repository;
};
const fakeLpd = (plates: PlateBox[]) => ({ detect: async () => plates } as unknown as LpdClient);

interface Ctx {
  app: FastifyInstance;
  dir: string;
  placeFile: string;
  cameraposFile: string;
  store: SqliteStore;
}

function makeCtx(opts: { plates?: PlateBox[]; slots?: SlotSetupView[] } = {}): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'rpcsvc-'));
  const placeFile = join(dir, 'PtzCamRoi.json');
  const cameraposFile = join(dir, 'camerapos.json');
  writeFileSync(placeFile, JSON.stringify(PLACE_FIXTURE, null, 2), 'utf8');
  const store = new SqliteStore(':memory:');
  const storeView = opts.slots
    ? ({ getSlotSetup: () => opts.slots!, getPresetKeys: () => new Set<string>() } as unknown as SqliteStore)
    : store;
  const repo = fakeRepo();
  const app = buildServer({
    orchestrator: new SetupOrchestrator({ camera: fakeCamera(), vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' }),
    repo,
    camera: fakeCamera(),
    vpd: fakeVpd(),
    ...(opts.plates ? { lpd: fakeLpd(opts.plates) } : {}),
    sqlite: storeView,
    placeRoiFile: placeFile,
    mapFiles: { cameraposFile },
  });
  return { app, dir, placeFile, cameraposFile, store };
}

async function rpc(app: FastifyInstance, method: string, params?: Record<string, unknown>) {
  const r = await app.inject({
    method: 'POST',
    url: '/rpc',
    payload: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
  });
  return r.json() as { result?: Record<string, unknown>; error?: { code: number; message: string; data?: unknown } };
}

/** 현재 정본의 정규화 상태(검증 편의). */
function spacesOf(file: string, key: string) {
  return normalizePtzCamRoi(JSON.parse(readFileSync(file, 'utf8'))).byPreset.get(key) ?? [];
}
function backupsOf(dir: string) {
  return readdirSync(dir).filter((f) => f.includes('.bak.'));
}

let ctx: Ctx | undefined;
afterEach(async () => {
  if (ctx) {
    await ctx.app.close();
    ctx.store.close();
    rmSync(ctx.dir, { recursive: true, force: true });
    ctx = undefined;
  }
});

describe('place.spaces.list — 정규화 좌표를 서버가 준다', () => {
  it('픽셀이 아니라 0~1 정규화로 나온다(클라 재구현 불필요)', async () => {
    ctx = makeCtx();
    const r = await rpc(ctx.app, 'place.spaces.list', { camId: 1, presetIdx: 1 });
    const presets = r.result!.presets as Array<{ key: string; spaces: Array<{ idx: number; points: Array<{ x: number }> }> }>;
    expect(presets).toHaveLength(1);
    expect(presets[0].key).toBe('1:1');
    expect(presets[0].spaces[0].points[0].x).toBeCloseTo(0.1, 5);
    expect(r.result!.total).toBe(3);
  });
});

describe('place.space.add', () => {
  it('추가되고 idx 는 서버가 부여(전체 수+1) · 백업이 남는다', async () => {
    ctx = makeCtx();
    const r = await rpc(ctx.app, 'place.space.add', {
      camId: 1, presetIdx: 1,
      points: [{ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.5 }, { x: 0.6, y: 0.6 }, { x: 0.5, y: 0.6 }],
    });
    expect(r.result!.ok).toBe(true);
    expect(r.result!.idx).toBe(4);
    expect(spacesOf(ctx.placeFile, '1:1')).toHaveLength(3);
    expect(backupsOf(ctx.dir)).toHaveLength(1);
    // 다른 프리셋은 무접촉.
    expect(spacesOf(ctx.placeFile, '1:2').map((s) => s.idx)).toEqual([3]);
  });

  it('점 3개 미만은 INVALID_PARAMS(파일 무변경)', async () => {
    ctx = makeCtx();
    const before = readFileSync(ctx.placeFile, 'utf8');
    const r = await rpc(ctx.app, 'place.space.add', { camId: 1, presetIdx: 1, points: [{ x: 0.1, y: 0.1 }] });
    expect(r.error?.code).toBe(RpcCode.INVALID_PARAMS);
    expect(readFileSync(ctx.placeFile, 'utf8')).toBe(before);
  });
});

describe('place.space.update', () => {
  it('좌표만 교체된다', async () => {
    ctx = makeCtx();
    const r = await rpc(ctx.app, 'place.space.update', {
      camId: 1, presetIdx: 1, idx: 2,
      points: [{ x: 0.7, y: 0.7 }, { x: 0.8, y: 0.7 }, { x: 0.8, y: 0.8 }, { x: 0.7, y: 0.8 }],
    });
    expect(r.result!.ok).toBe(true);
    const after = spacesOf(ctx.placeFile, '1:1');
    expect(after.map((s) => s.idx)).toEqual([1, 2]);
    expect(after[1].points[0].x).toBeCloseTo(0.7, 5);
  });

  it('없는 idx → NOT_FOUND(파일 무변경)', async () => {
    ctx = makeCtx();
    const before = readFileSync(ctx.placeFile, 'utf8');
    const r = await rpc(ctx.app, 'place.space.update', { camId: 1, presetIdx: 1, idx: 99, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] });
    expect(r.error?.code).toBe(RpcCode.NOT_FOUND);
    expect(readFileSync(ctx.placeFile, 'utf8')).toBe(before);
  });
});

describe('place.space.delete', () => {
  it('mode=clear(기본) — 기하만 비우고 전역번호 보존', async () => {
    ctx = makeCtx();
    const r = await rpc(ctx.app, 'place.space.delete', { camId: 1, presetIdx: 1, idx: 1 });
    expect(r.result!.mode).toBe('clear');
    const after = spacesOf(ctx.placeFile, '1:1');
    expect(after.map((s) => s.idx)).toEqual([1, 2]);
    expect(after[0].points).toEqual([]);
    expect(spacesOf(ctx.placeFile, '1:2').map((s) => s.idx)).toEqual([3]); // 다른 프리셋 번호 불변
  });

  it('mode=remove — 재압축되고 경고가 붙는다(다른 프리셋 번호도 당겨진다)', async () => {
    ctx = makeCtx();
    const r = await rpc(ctx.app, 'place.space.delete', { camId: 1, presetIdx: 1, idx: 1, mode: 'remove' });
    expect(r.result!.mode).toBe('remove');
    expect(spacesOf(ctx.placeFile, '1:1').map((s) => s.idx)).toEqual([1]);
    expect(spacesOf(ctx.placeFile, '1:2').map((s) => s.idx)).toEqual([2]); // 3 → 2 로 당겨짐
    expect((r.result!.issues as string[]).join(' ')).toContain('slot.roi.load');
  });
});

describe('place.preset.clear', () => {
  it('confirm 없으면 INVALID_PARAMS(파일 무변경)', async () => {
    ctx = makeCtx();
    const before = readFileSync(ctx.placeFile, 'utf8');
    const r = await rpc(ctx.app, 'place.preset.clear', { camId: 1, presetIdx: 1 });
    expect(r.error?.code).toBe(RpcCode.INVALID_PARAMS);
    expect(readFileSync(ctx.placeFile, 'utf8')).toBe(before);
  });

  it('confirm + clear — 프리셋 전 주차면의 기하만 비운다', async () => {
    ctx = makeCtx();
    const r = await rpc(ctx.app, 'place.preset.clear', { camId: 1, presetIdx: 1, confirm: true });
    expect(r.result!.cleared).toBe(2);
    expect(spacesOf(ctx.placeFile, '1:1').every((s) => s.points.length === 0)).toBe(true);
    expect(spacesOf(ctx.placeFile, '1:2')).toHaveLength(1);
  });

  it('confirm + remove — 엔트리가 사라지고 나머지가 1..N 으로 재압축', async () => {
    ctx = makeCtx();
    const r = await rpc(ctx.app, 'place.preset.clear', { camId: 1, presetIdx: 1, confirm: true, mode: 'remove' });
    expect(r.result!.cleared).toBe(2);
    expect(spacesOf(ctx.placeFile, '1:1')).toHaveLength(0);
    expect(spacesOf(ctx.placeFile, '1:2').map((s) => s.idx)).toEqual([1]);
  });
});

describe('동시 편집 가드(expectTotal)', () => {
  it('불일치 → CONFLICT + 파일 1바이트도 안 바뀐다', async () => {
    ctx = makeCtx();
    const before = readFileSync(ctx.placeFile, 'utf8');
    const r = await rpc(ctx.app, 'place.space.add', {
      camId: 1, presetIdx: 1, expectTotal: 99,
      points: [{ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.5 }, { x: 0.6, y: 0.6 }],
    });
    expect(r.error?.code).toBe(RpcCode.CONFLICT);
    expect((r.error?.data as { expected: number; actual: number })).toEqual({ expected: 99, actual: 3 });
    expect(readFileSync(ctx.placeFile, 'utf8')).toBe(before);
    expect(backupsOf(ctx.dir)).toHaveLength(0); // 백업조차 만들지 않는다
  });

  it('일치하면 통과', async () => {
    ctx = makeCtx();
    const r = await rpc(ctx.app, 'place.space.add', {
      camId: 1, presetIdx: 1, expectTotal: 3,
      points: [{ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.5 }, { x: 0.6, y: 0.6 }],
    });
    expect(r.result!.ok).toBe(true);
  });
});

describe('place.align.apply — 자동보정 적용(웹에만 있던 계산)', () => {
  it('좌표가 이동·스케일되고 idx·개수는 보존된다', async () => {
    ctx = makeCtx();
    const before = spacesOf(ctx.placeFile, '1:1');
    const r = await rpc(ctx.app, 'place.align.apply', { cam: 1, preset: 1, dx: 0.05, dy: -0.02, scale: 1.1 });
    expect(r.result!.ok).toBe(true);
    const after = spacesOf(ctx.placeFile, '1:1');
    expect(after.map((s) => s.idx)).toEqual(before.map((s) => s.idx));
    // 중심 기준 1.1배 + dx 0.05: 0.1 → 0.5 + 1.1*(0.1-0.5) + 0.05 = 0.11
    expect(after[0].points[0].x).toBeCloseTo(0.11, 4);
    expect(spacesOf(ctx.placeFile, '1:2')[0].points[0].x).toBeCloseTo(0.4, 4); // 다른 프리셋 무접촉
  });

  it('주차면 없는 프리셋 → NOT_FOUND', async () => {
    ctx = makeCtx();
    const r = await rpc(ctx.app, 'place.align.apply', { cam: 9, preset: 9, dx: 0, dy: 0, scale: 1 });
    expect(r.error?.code).toBe(RpcCode.NOT_FOUND);
  });
});

describe('place.backups / place.revert — 브라우저 undo 스택의 대체물', () => {
  it('편집 → 백업 목록 → 복원으로 원상복구된다', async () => {
    ctx = makeCtx();
    const original = readFileSync(ctx.placeFile, 'utf8');
    await rpc(ctx.app, 'place.space.delete', { camId: 1, presetIdx: 1, idx: 1, mode: 'remove' });
    expect(spacesOf(ctx.placeFile, '1:1')).toHaveLength(1);

    const list = await rpc(ctx.app, 'place.backups');
    const backups = list.result!.backups as string[];
    expect(backups).toHaveLength(1);

    const rev = await rpc(ctx.app, 'place.revert', { backupFile: backups[0] });
    expect(rev.result!.ok).toBe(true);
    expect(readFileSync(ctx.placeFile, 'utf8')).toBe(original);
    // 되돌리기 직전 상태도 새 백업으로 남는다(되돌리기를 되돌릴 수 있다).
    expect(rev.result!.preRevertBackup).toBeTruthy();
  });

  it('경로 주입 시도는 INVALID_PARAMS', async () => {
    ctx = makeCtx();
    const r = await rpc(ctx.app, 'place.revert', { backupFile: '../../etc/passwd' });
    expect(r.error?.code).toBe(RpcCode.INVALID_PARAMS);
  });

  it('없는 백업 → NOT_FOUND', async () => {
    ctx = makeCtx();
    const r = await rpc(ctx.app, 'place.revert', { backupFile: 'PtzCamRoi.20200101T000000Z.bak.json' });
    expect(r.error?.code).toBe(RpcCode.NOT_FOUND);
  });
});

describe('cam.preset.* — camerapos 단건 CRUD', () => {
  it('upsert → 파일 생성 → list 로 왕복', async () => {
    ctx = makeCtx();
    const a = await rpc(ctx.app, 'cam.preset.upsert', { camIdx: 1, presetIdx: 1, label: '입구', pan: 10, tilt: -5, zoom: 2 });
    expect(a.result!.action).toBe('created');
    const b = await rpc(ctx.app, 'cam.preset.upsert', { camIdx: 1, presetIdx: 2, label: '중앙', pan: 40, tilt: -5, zoom: 2 });
    expect(b.result!.count).toBe(2);

    const list = await rpc(ctx.app, 'cam.preset.list');
    const views = list.result!.views as Array<{ camIdx: number; presetIdx: number; label: string; pan: number }>;
    expect(views).toHaveLength(2);
    expect(views[1].label).toBe('중앙');
  });

  it('같은 (cam,preset) 재호출은 교체(중복 생성 아님)', async () => {
    ctx = makeCtx();
    await rpc(ctx.app, 'cam.preset.upsert', { camIdx: 1, presetIdx: 1, label: 'A', pan: 1, tilt: 1, zoom: 1 });
    const r = await rpc(ctx.app, 'cam.preset.upsert', { camIdx: 1, presetIdx: 1, pan: 9, tilt: 9, zoom: 9 });
    expect(r.result!.action).toBe('updated');
    expect(r.result!.count).toBe(1);
    const list = await rpc(ctx.app, 'cam.preset.list');
    const views = list.result!.views as Array<{ pan: number; label: string }>;
    expect(views[0].pan).toBe(9);
    expect(views[0].label).toBe('A'); // label 미지정 시 기존 유지
  });

  it('delete — 대상 없으면 NOT_FOUND, 있으면 제거', async () => {
    ctx = makeCtx();
    await rpc(ctx.app, 'cam.preset.upsert', { camIdx: 1, presetIdx: 1, pan: 1, tilt: 1, zoom: 1 });
    expect((await rpc(ctx.app, 'cam.preset.delete', { camIdx: 9, presetIdx: 9 })).error?.code).toBe(RpcCode.NOT_FOUND);
    const r = await rpc(ctx.app, 'cam.preset.delete', { camIdx: 1, presetIdx: 1 });
    expect(r.result!.count).toBe(0);
  });
});

describe('cam.gotoPreset', () => {
  it('camerapos 에 없으면 NOT_FOUND', async () => {
    ctx = makeCtx();
    const r = await rpc(ctx.app, 'cam.gotoPreset', { cam: 1, preset: 1 });
    expect(r.error?.code).toBe(RpcCode.NOT_FOUND);
  });

  it('PTZ 없는 프리셋이면 CONFLICT(엉뚱한 곳으로 보내지 않는다)', async () => {
    ctx = makeCtx();
    writeFileSync(ctx.cameraposFile, JSON.stringify({ datas: [{ cam_id: 1, preset_id: 1, sname: 'x' }] }), 'utf8');
    const r = await rpc(ctx.app, 'cam.gotoPreset', { cam: 1, preset: 1 });
    expect(r.error?.code).toBe(RpcCode.CONFLICT);
  });
});

describe('setup.mapping.autoNumber', () => {
  const slots = (ids: number[]): SlotSetupView[] =>
    ids.map((id, i) => ({
      slotId: id, camId: 1, presetId: 1, presetSlotIdx: i + 1, presetKey: '1:1',
      roi: [], vpd: null, lpd: null, occupyRange: null, pan: null, tilt: null, zoom: null,
      centered: false, img1: null, slot3dFrontCenter: null, updatedAt: null,
    }));

  it('기본은 dryRun — 매핑만 돌려주고 쓰지 않는다', async () => {
    ctx = makeCtx({ slots: slots([5, 7, 9]) });
    const r = await rpc(ctx.app, 'setup.mapping.autoNumber');
    expect(r.result!.dryRun).toBe(true);
    expect(r.result!.applied).toBe(false);
    expect(r.result!.changed).toBe(3);
    expect(r.result!.mapping).toEqual([
      { oldSlotId: 5, newSlotId: 1 },
      { oldSlotId: 7, newSlotId: 2 },
      { oldSlotId: 9, newSlotId: 3 },
    ]);
  });

  it('이미 1..N 이면 changed 0 + applied false(updated_at 을 흔들지 않는다)', async () => {
    ctx = makeCtx({ slots: slots([1, 2, 3]) });
    const r = await rpc(ctx.app, 'setup.mapping.autoNumber', { dryRun: false });
    expect(r.result!.changed).toBe(0);
    expect(r.result!.applied).toBe(false);
  });

  it('slot_setup 이 비면 CONFLICT', async () => {
    ctx = makeCtx({ slots: [] });
    const r = await rpc(ctx.app, 'setup.mapping.autoNumber');
    expect(r.error?.code).toBe(RpcCode.CONFLICT);
  });
});

describe('plate.pickAt — 선택한 차량 번호판 위치', () => {
  const plateAt = (x: number, y: number, conf = 0.9): PlateBox => ({
    quad: rectToQuad({ x, y, w: 0.04, h: 0.02 }),
    confidence: conf,
    cls: 'car_license_plate',
  });

  it('클릭 지점 최근접 번호판을 고른다(카메라·DB 를 건드리지 않는다)', async () => {
    ctx = makeCtx({ plates: [plateAt(0.1, 0.1), plateAt(0.5, 0.5), plateAt(0.8, 0.8)] });
    const r = await rpc(ctx.app, 'plate.pickAt', { cam: 1, preset: 1, point: { x: 0.52, y: 0.51 } });
    expect(r.result!.ok).toBe(true);
    expect((r.result!.center as { x: number }).x).toBeCloseTo(0.52, 2);
    expect(r.result!.plateCount).toBe(3);
    expect(r.result!.confidence).toBe(0.9);
  });

  it('반경 밖이면 채택하지 않는다(거짓 성공 금지) — 거리는 알려준다', async () => {
    ctx = makeCtx({ plates: [plateAt(0.1, 0.1)] });
    const r = await rpc(ctx.app, 'plate.pickAt', { cam: 1, preset: 1, point: { x: 0.9, y: 0.9 }, radius: 0.05 });
    expect(r.result!.ok).toBe(false);
    expect(r.result!.reason).toBe('no_plate_within_radius');
    expect(r.result!.nearestDistance as number).toBeGreaterThan(0.05);
  });

  it('검출 0건 → no_plate_detected', async () => {
    ctx = makeCtx({ plates: [] });
    const r = await rpc(ctx.app, 'plate.pickAt', { cam: 1, preset: 1, point: { x: 0.5, y: 0.5 } });
    expect(r.result!.ok).toBe(false);
    expect(r.result!.reason).toBe('no_plate_detected');
  });

  it('LPD 미배선이면 UNAVAILABLE', async () => {
    ctx = makeCtx();
    const r = await rpc(ctx.app, 'plate.pickAt', { cam: 1, preset: 1, point: { x: 0.5, y: 0.5 } });
    expect(r.error?.code).toBe(RpcCode.UNAVAILABLE);
  });
});
