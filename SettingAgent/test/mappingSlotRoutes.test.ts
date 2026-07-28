import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { Repository } from '../src/store/Repository.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import { validateCoverage } from '../src/setup/GlobalIndexer.js';
import { RpcCode } from '../src/rpc/errors.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { CameraSource, Ptz } from '../src/viewer/CameraSource.js';
import type { SetupArtifact } from '../src/domain/types.js';

/**
 * S2·S4 — `POST /mapping/slot/add` · `POST /mapping/slot/delete`(설계 §4.2 / 리더 결정 Q3, 단계 11).
 *
 * ★ 이 파일이 고정하는 것
 *   1. **검증 → 저장 순서**(R11): 거부되는 요청은 `data/setup_artifact.json` 을 **한 바이트도** 바꾸지 않는다.
 *      (md5 로 증명한다 — "200 이 아니었다"만 보면 부분기록을 놓친다.)
 *   2. **`dryRun:true` 는 절대 쓰지 않는다**(웹의 "추가 → 배치 → 저장" 2단계 UX 를 보존하는 계약).
 *   3. **REST ↔ RPC 바이트 동일**(S4): RPC 가 자기 로직을 갖지 않는다.
 *   4. **DB 쓰기 0**: `sqlite` 는 `getSlotSetup()` 읽기에만 쓰인다(개수 불일치 warnings 용).
 */

const setupCfg = {
  presetSettleMs: 0, betweenPresetMs: 0, minConfidence: 0.5, roiPadding: 0, yBandTolerance: 0.1,
  accumFrames: 1, accumIntervalMs: 0, clusterDist: 0.06, clusterMinSupport: 1, lpdEnabled: false,
};

const fakeCamera = () => ({
  health: async () => true,
  clampZoom: (z: number) => z,
  requestImage: async () => ({ camIdx: 1, presetIdx: 1, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('f') }),
} as unknown as CameraClient);
const fakeVpd = () => ({ health: async () => true, detect: async () => [] } as unknown as VpdClient);

function fakeSource(): CameraSource {
  return {
    kind: 'sim',
    listCameras: async () => ({ cameras: [] }),
    snapshot: async () => ({ jpeg: Buffer.from([0xff, 0xd8]), ptz: { pan: 0, tilt: 0, zoom: 1 } }),
    move: async () => true,
    getPtz: async () => ({ pan: 0, tilt: 0, zoom: 1 }),
    toNativePtz: (p: Ptz) => p,
    fromNativePtz: (n: unknown) => n as Ptz,
  } as unknown as CameraSource;
}

/** test/slotInsertEdit.test.ts:16 과 동일한 2프리셋·3슬롯 산출물. */
function sampleArtifact(): SetupArtifact {
  return {
    createdAt: 'T',
    presets: [
      { camIdx: 1, presetIdx: 1, label: '1:1', coveredSlotIds: ['c1p1s1', 'c1p1s2'] },
      { camIdx: 1, presetIdx: 2, label: '1:2', coveredSlotIds: ['c1p2s1'] },
    ],
    slots: [
      { slotId: 'c1p1s1', zone: 'cam1', roiByPreset: { '1:1': { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } } },
      { slotId: 'c1p1s2', zone: 'cam1', roiByPreset: { '1:1': { x: 0.5, y: 0.5, w: 0.2, h: 0.2 } } },
      { slotId: 'c1p2s1', zone: 'cam1', roiByPreset: { '1:2': { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } } },
    ],
    globalIndex: [
      { globalIdx: 1, slotId: 'c1p1s1', camIdx: 1, presetIdx: 1 },
      { globalIdx: 2, slotId: 'c1p1s2', camIdx: 1, presetIdx: 1 },
      { globalIdx: 3, slotId: 'c1p2s1', camIdx: 1, presetIdx: 2 },
    ],
  };
}

interface Ctx { app: FastifyInstance; dir: string; repo: Repository; store?: SqliteStore }

function makeCtx(opts: { seed?: boolean; sqlite?: boolean; viewer?: boolean } = {}): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'mapslot-'));
  const repo = new Repository(dir);
  if (opts.seed !== false) repo.saveArtifact(sampleArtifact());
  const store = opts.sqlite ? new SqliteStore(':memory:') : undefined;
  const app = buildServer({
    orchestrator: new SetupOrchestrator({ camera: fakeCamera(), vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' }),
    repo, camera: fakeCamera(), vpd: fakeVpd(),
    ...(store ? { sqlite: store } : {}),
    ...(opts.viewer
      ? {
          viewer: { enabled: true, allowMove: true, defaultFps: 3, staticDir: 'web', controlToken: '' },
          sources: new Map<string, CameraSource>([['s', fakeSource()]]),
        }
      : {}),
  });
  return { app, dir, repo, store };
}

/** 산출물 파일의 md5(존재하지 않으면 'none'). "파일 무변경"의 증거. */
function md5(ctx: Ctx): string {
  if (!existsSync(ctx.repo.path)) return 'none';
  return createHash('md5').update(readFileSync(ctx.repo.path)).digest('hex');
}
function fileArtifact(ctx: Ctx): SetupArtifact {
  return JSON.parse(readFileSync(ctx.repo.path, 'utf8')) as SetupArtifact;
}

async function rpc(app: FastifyInstance, method: string, params?: Record<string, unknown>) {
  const r = await app.inject({
    method: 'POST', url: '/rpc',
    payload: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
  });
  return r.json() as { result?: Record<string, unknown>; error?: { code: number; message: string } };
}

let ctx: Ctx | undefined;
afterEach(async () => {
  if (ctx) {
    await ctx.app.close();
    ctx.store?.close();
    try {
      rmSync(ctx.dir, { recursive: true, force: true });
    } catch {
      /* 임시 디렉터리 잔존 — 테스트 결과에 영향 없음 */
    }
    ctx = undefined;
  }
});

describe('POST /mapping/slot/add — 성공 경로', () => {
  it('200: 파일 슬롯 +1, globalIdx 가 요청 at 위치, coverage 통과', async () => {
    ctx = makeCtx();
    const res = await ctx.app.inject({ method: 'POST', url: '/mapping/slot/add', payload: { camIdx: 1, presetIdx: 1, at: 2 } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.slotId).toBe('c1p1s3');
    expect(body.globalIdx).toBe(2); // 요청한 at 위치에 꽂혔다
    expect(body.saved).toBe(true);

    const file = fileArtifact(ctx);
    expect(file.slots.length).toBe(4); // 3 → 4
    expect(file.globalIndex.find((g) => g.slotId === 'c1p1s3')!.globalIdx).toBe(2);
    expect(file.globalIndex.map((g) => g.globalIdx)).toEqual([1, 2, 3, 4]);
    expect(validateCoverage(file.globalIndex, file.slots).ok).toBe(true);
  });

  it('기본 rect·zone 을 **서버가 소유**한다(web/app.js:addSlot 이 갖고 있던 값)', async () => {
    ctx = makeCtx();
    await ctx.app.inject({ method: 'POST', url: '/mapping/slot/add', payload: { camIdx: 1, presetIdx: 1 } });
    const slot = fileArtifact(ctx).slots.find((s) => s.slotId === 'c1p1s3')!;
    expect(slot.zone).toBe('cam1');
    expect(slot.roiByPreset['1:1']).toEqual({ x: 0.45, y: 0.45, w: 0.1, h: 0.1 });
  });

  it('at 미지정 → 맨 끝(N+1)', async () => {
    ctx = makeCtx();
    const res = await ctx.app.inject({ method: 'POST', url: '/mapping/slot/add', payload: { camIdx: 1, presetIdx: 1 } });
    expect(res.json().globalIdx).toBe(4);
  });

  it('연속 2회 add — slotId 충돌 없음(결번 회피)', async () => {
    ctx = makeCtx();
    const a = await ctx.app.inject({ method: 'POST', url: '/mapping/slot/add', payload: { camIdx: 1, presetIdx: 1 } });
    const b = await ctx.app.inject({ method: 'POST', url: '/mapping/slot/add', payload: { camIdx: 1, presetIdx: 1 } });
    expect(a.json().slotId).toBe('c1p1s3');
    expect(b.json().slotId).toBe('c1p1s4');
    const file = fileArtifact(ctx);
    expect(file.slots.length).toBe(5);
    expect(new Set(file.slots.map((s) => s.slotId)).size).toBe(5);
    expect(validateCoverage(file.globalIndex, file.slots).ok).toBe(true);
  });

  it('preset 부재 → 신규 preset 생성 + warnings 로 알린다(숨기지 않는다)', async () => {
    ctx = makeCtx();
    const res = await ctx.app.inject({ method: 'POST', url: '/mapping/slot/add', payload: { camIdx: 3, presetIdx: 9 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().warnings.join(' ')).toContain('preset 3:9');
    const p = fileArtifact(ctx).presets.find((x) => x.camIdx === 3 && x.presetIdx === 9)!;
    expect(p.coveredSlotIds).toEqual(['c3p9s1']);
    expect(p.pan).toBeUndefined(); // PTZ 없는 preset — warnings 의 근거
  });
});

describe('호출자 버퍼(artifact) + dryRun — 리더 결정 Q3', () => {
  it('dryRun:true → 200 + 편집된 artifact 반환, **파일 md5 불변**', async () => {
    ctx = makeCtx();
    const before = md5(ctx);
    const res = await ctx.app.inject({
      method: 'POST', url: '/mapping/slot/add',
      payload: { camIdx: 1, presetIdx: 1, at: 1, dryRun: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.saved).toBe(false);
    expect(body.artifact.slots.length).toBe(4); // 계산 결과는 돌려준다
    expect(body.artifact.globalIndex.find((g: { slotId: string }) => g.slotId === 'c1p1s3').globalIdx).toBe(1);
    expect(md5(ctx)).toBe(before); // ★ 파일은 한 바이트도 안 바뀐다
    expect(fileArtifact(ctx).slots.length).toBe(3);
  });

  it('delete 도 dryRun:true 면 파일 md5 불변', async () => {
    ctx = makeCtx();
    const before = md5(ctx);
    const res = await ctx.app.inject({
      method: 'POST', url: '/mapping/slot/delete',
      payload: { slotId: 'c1p1s2', dryRun: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().artifact.slots.length).toBe(2);
    expect(md5(ctx)).toBe(before);
  });

  it('artifact(호출자 버퍼) 제공 시 **파일이 아니라 버퍼**를 편집한다(웹 경로)', async () => {
    ctx = makeCtx();
    // 버퍼에는 슬롯이 1개뿐 — 파일(3개)과 다르다. 결과가 버퍼 기준이어야 한다.
    const buffer: SetupArtifact = {
      createdAt: 'B',
      presets: [{ camIdx: 1, presetIdx: 1, label: '1:1', coveredSlotIds: ['c1p1s1'] }],
      slots: [{ slotId: 'c1p1s1', zone: 'cam1', roiByPreset: { '1:1': { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } } }],
      globalIndex: [{ globalIdx: 1, slotId: 'c1p1s1', camIdx: 1, presetIdx: 1 }],
    };
    const res = await ctx.app.inject({
      method: 'POST', url: '/mapping/slot/add',
      payload: { camIdx: 1, presetIdx: 1, artifact: buffer, dryRun: true },
    });
    const body = res.json();
    expect(body.slotId).toBe('c1p1s2'); // 파일 기준이면 c1p1s3 이 나왔을 것이다
    expect(body.artifact.createdAt).toBe('B');
    expect(body.artifact.slots.length).toBe(2);
  });

  /**
   * ★ D-1 회귀 — 독립 QA 재현 케이스를 그대로 편입(리더 지시, 2026-07-28).
   *
   * 결함: 버퍼를 받아 **저장까지** 하면 "슬롯 1개 추가"의 실제 사정거리가 **파일 전체 교체**였다.
   *   디스크의 다른 슬롯이 조용히 사라지고, 호출자가 준 임의 필드(createdAt 등)가 그대로 안착했다.
   * 조치: `artifact` + 커밋 조합을 409 로 거부한다(`artifact` 는 항상 계산 전용).
   */
  describe('D-1 회귀 — artifact 버퍼는 커밋할 수 없다', () => {
    /** QA 재현: 파일 2슬롯(c1p1s1·c1p1s2) 상태에서 1슬롯짜리 버퍼로 커밋 시도. */
    function twoSlotFile(): SetupArtifact {
      return {
        createdAt: 'DISK',
        presets: [{ camIdx: 1, presetIdx: 1, label: '1:1', coveredSlotIds: ['c1p1s1', 'c1p1s2'] }],
        slots: [
          { slotId: 'c1p1s1', zone: 'cam1', roiByPreset: { '1:1': { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } } },
          { slotId: 'c1p1s2', zone: 'cam1', roiByPreset: { '1:1': { x: 0.5, y: 0.5, w: 0.2, h: 0.2 } } },
        ],
        globalIndex: [
          { globalIdx: 1, slotId: 'c1p1s1', camIdx: 1, presetIdx: 1 },
          { globalIdx: 2, slotId: 'c1p1s2', camIdx: 1, presetIdx: 1 },
        ],
      };
    }
    const oneSlotBuffer: SetupArtifact = {
      createdAt: 'TAMPERED',
      presets: [{ camIdx: 1, presetIdx: 1, label: '1:1', coveredSlotIds: ['c1p1s1'] }],
      slots: [{ slotId: 'c1p1s1', zone: 'cam1', roiByPreset: { '1:1': { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } } }],
      globalIndex: [{ globalIdx: 1, slotId: 'c1p1s1', camIdx: 1, presetIdx: 1 }],
    };

    it('add: 파일 2슬롯 + 1슬롯 버퍼 커밋 → 409 · 파일 md5 불변 · c1p1s2 생존', async () => {
      ctx = makeCtx();
      ctx.repo.saveArtifact(twoSlotFile());
      const before = md5(ctx);
      const res = await ctx.app.inject({
        method: 'POST', url: '/mapping/slot/add',
        payload: { camIdx: 1, presetIdx: 1, artifact: oneSlotBuffer }, // dryRun 없음 = 커밋 시도
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain('dryRun:true');
      expect(md5(ctx)).toBe(before); // ★ 한 바이트도 안 바뀐다
      const file = fileArtifact(ctx);
      expect(file.slots.map((s) => s.slotId)).toEqual(['c1p1s1', 'c1p1s2']); // 소실 없음
      expect(file.createdAt).toBe('DISK'); // 버퍼의 'TAMPERED' 가 안착하지 않았다
    });

    it('delete 도 같은 규약으로 거부된다', async () => {
      ctx = makeCtx();
      ctx.repo.saveArtifact(twoSlotFile());
      const before = md5(ctx);
      const res = await ctx.app.inject({
        method: 'POST', url: '/mapping/slot/delete',
        payload: { slotId: 'c1p1s1', artifact: oneSlotBuffer },
      });
      expect(res.statusCode).toBe(409);
      expect(md5(ctx)).toBe(before);
      expect(fileArtifact(ctx).slots.length).toBe(2);
    });

    it('RPC 에서도 CONFLICT(-32005) — BUSY 가 아니다(재시도 대상이 아니라 호출 방식이 틀렸다)', async () => {
      ctx = makeCtx();
      ctx.repo.saveArtifact(twoSlotFile());
      const before = md5(ctx);
      const r = await rpc(ctx.app, 'setup.slot.add', { camIdx: 1, presetIdx: 1, artifact: oneSlotBuffer });
      expect(r.error?.code).toBe(RpcCode.CONFLICT);
      expect(r.error?.message).toContain('artifact');
      expect(md5(ctx)).toBe(before);
    });

    it('dryRun:false 를 **명시**해도 거부된다(기본값 회피 우회 차단)', async () => {
      ctx = makeCtx();
      const before = md5(ctx);
      const res = await ctx.app.inject({
        method: 'POST', url: '/mapping/slot/add',
        payload: { camIdx: 1, presetIdx: 1, artifact: oneSlotBuffer, dryRun: false },
      });
      expect(res.statusCode).toBe(409);
      expect(md5(ctx)).toBe(before);
    });

    it('허용 조합 2가지는 그대로 동작한다(기능 손실 0)', async () => {
      ctx = makeCtx();
      // ① 버퍼 + dryRun:true = 계산(웹 경로) → 200, 파일 무변경
      const before = md5(ctx);
      const calc = await ctx.app.inject({
        method: 'POST', url: '/mapping/slot/add',
        payload: { camIdx: 1, presetIdx: 1, artifact: oneSlotBuffer, dryRun: true },
      });
      expect(calc.statusCode).toBe(200);
      expect(md5(ctx)).toBe(before);
      // ② 버퍼 없음 + 커밋 = 디스크 정본 편집(외부 RPC 경로) → 200, 파일 변경
      const commit = await ctx.app.inject({ method: 'POST', url: '/mapping/slot/add', payload: { camIdx: 1, presetIdx: 1 } });
      expect(commit.statusCode).toBe(200);
      expect(md5(ctx)).not.toBe(before);
    });

    it('뷰어 컨텍스트 라우트에도 같은 가드가 적용된다(같은 closure 공유)', async () => {
      ctx = makeCtx({ viewer: true });
      const before = md5(ctx);
      const add = await ctx.app.inject({
        method: 'POST', url: '/viewer/api/mapping/slot/add',
        payload: { camIdx: 1, presetIdx: 1, artifact: oneSlotBuffer },
      });
      const del = await ctx.app.inject({
        method: 'POST', url: '/viewer/api/mapping/slot/delete',
        payload: { slotId: 'c1p1s1', artifact: oneSlotBuffer },
      });
      expect(add.statusCode).toBe(409);
      expect(del.statusCode).toBe(409);
      expect(md5(ctx)).toBe(before);
    });
  });

  it('dryRun 미지정(기본) → 커밋된다(외부 RPC 호출자는 한 방에 반영)', async () => {
    ctx = makeCtx();
    const before = md5(ctx);
    await ctx.app.inject({ method: 'POST', url: '/mapping/slot/add', payload: { camIdx: 1, presetIdx: 1 } });
    expect(md5(ctx)).not.toBe(before);
  });
});

describe('POST /mapping/slot/delete', () => {
  it('200: 파일 슬롯 −1 + coveredSlotIds·globalIndex 재구성', async () => {
    ctx = makeCtx();
    const res = await ctx.app.inject({ method: 'POST', url: '/mapping/slot/delete', payload: { slotId: 'c1p1s1' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().slots).toBe(2);
    const file = fileArtifact(ctx);
    expect(file.slots.map((s) => s.slotId)).toEqual(['c1p1s2', 'c1p2s1']);
    expect(file.presets[0]!.coveredSlotIds).toEqual(['c1p1s2']);
    expect(file.globalIndex.map((g) => g.globalIdx)).toEqual([1, 2]);
    expect(validateCoverage(file.globalIndex, file.slots).ok).toBe(true);
  });

  it('★ 부재 slotId → 409 + **파일 md5 불변**(removeSlot 은 조용히 통과하므로 사전 확인이 필수)', async () => {
    ctx = makeCtx();
    const before = md5(ctx);
    const res = await ctx.app.inject({ method: 'POST', url: '/mapping/slot/delete', payload: { slotId: 'nope' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('nope');
    expect(md5(ctx)).toBe(before);
  });

  it('부재 slotId 는 RPC 에서 CONFLICT(-32005) — BUSY 가 아니다(재시도 대상이 아님)', async () => {
    ctx = makeCtx();
    const before = md5(ctx);
    const r = await rpc(ctx.app, 'setup.slot.delete', { slotId: 'nope', confirm: true });
    expect(r.error?.code).toBe(RpcCode.CONFLICT);
    expect(md5(ctx)).toBe(before);
  });
});

describe('오류 경로 — 전부 파일 무변경', () => {
  it('artifact 파일 없음 + 버퍼 미제공 → 404 / RPC NOT_FOUND', async () => {
    ctx = makeCtx({ seed: false });
    const res = await ctx.app.inject({ method: 'POST', url: '/mapping/slot/add', payload: { camIdx: 1, presetIdx: 1 } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('no setup artifact');
    const r = await rpc(ctx.app, 'setup.slot.add', { camIdx: 1, presetIdx: 1 });
    expect(r.error?.code).toBe(RpcCode.NOT_FOUND);
    expect(existsSync(ctx.repo.path)).toBe(false); // 저장이 일어나지 않았다
  });

  it('zod 실패(camIdx 누락 / slotId 누락) → 400, 파일 md5 불변', async () => {
    ctx = makeCtx();
    const before = md5(ctx);
    const a = await ctx.app.inject({ method: 'POST', url: '/mapping/slot/add', payload: { presetIdx: 1 } });
    const b = await ctx.app.inject({ method: 'POST', url: '/mapping/slot/delete', payload: {} });
    expect(a.statusCode).toBe(400);
    expect(b.statusCode).toBe(400);
    expect(a.json().error).toBe('invalid body');
    expect(md5(ctx)).toBe(before);
  });

  it('버퍼가 깨진 artifact → validateArtifactBody 가 400 으로 막고 파일 무변경(R11)', async () => {
    ctx = makeCtx();
    const before = md5(ctx);
    // slots 원소에 zone 이 없다 → zod shape 실패. 편집은 됐지만 저장에 도달하지 못해야 한다.
    // (버퍼는 D-1 가드 때문에 dryRun:true 로만 들어올 수 있다 — 그 경로에서도 검증이 먼저 돈다.)
    const broken = { createdAt: 'X', presets: [], slots: [{ slotId: 'a' }], globalIndex: [] };
    const res = await ctx.app.inject({
      method: 'POST', url: '/mapping/slot/add',
      payload: { camIdx: 1, presetIdx: 1, artifact: broken, dryRun: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid artifact');
    expect(md5(ctx)).toBe(before);
  });

  it('RPC setup.slot.delete 는 confirm 없이는 라우트에 도달조차 못 한다', async () => {
    ctx = makeCtx();
    const before = md5(ctx);
    const r = await rpc(ctx.app, 'setup.slot.delete', { slotId: 'c1p1s1' });
    expect(r.error?.code).toBe(RpcCode.INVALID_PARAMS);
    expect(md5(ctx)).toBe(before);
  });
});

describe('warnings — R10(renumber 로 되돌아갈 수 있음)을 코드로 막지 않고 알린다', () => {
  it('sqlite slot_setup 개수와 artifact 슬롯 수가 다르면 경고한다', async () => {
    ctx = makeCtx({ sqlite: true }); // 빈 DB(0개) vs artifact 4개
    const res = await ctx.app.inject({ method: 'POST', url: '/mapping/slot/add', payload: { camIdx: 1, presetIdx: 1 } });
    const w = (res.json().warnings as string[]).join(' ');
    expect(res.json().dbSlotCount).toBe(0);
    expect(w).toContain('slot.renumber');
    expect(w).toContain('되돌아간다');
  });

  it('sqlite 미주입이면 dbSlotCount=null · 개수 경고 없음', async () => {
    ctx = makeCtx();
    const res = await ctx.app.inject({ method: 'POST', url: '/mapping/slot/add', payload: { camIdx: 1, presetIdx: 1 } });
    expect(res.json().dbSlotCount).toBeNull();
    expect(res.json().warnings).toEqual([]);
  });
});

describe('S4 — REST ↔ RPC 가 같은 파일을 만든다(바이트 동일)', () => {
  it('setup.slot.add == POST /mapping/slot/add', async () => {
    ctx = makeCtx();
    const body = { camIdx: 1, presetIdx: 1, at: 2 };
    const restRes = await ctx.app.inject({ method: 'POST', url: '/mapping/slot/add', payload: body });
    const afterRest = readFileSync(ctx.repo.path, 'utf8');

    // 같은 파일을 원상복구한 뒤 RPC 로 동일 작업(rpcParity.test.ts:246 의 place.save 선례).
    ctx.repo.saveArtifact(sampleArtifact());
    const rpcRes = await rpc(ctx.app, 'setup.slot.add', body);
    const afterRpc = readFileSync(ctx.repo.path, 'utf8');

    expect(rpcRes.result).toEqual(restRes.json());
    expect(afterRpc).toBe(afterRest); // ★ 바이트 동일
  });

  it('setup.slot.delete == POST /mapping/slot/delete', async () => {
    ctx = makeCtx();
    const restRes = await ctx.app.inject({ method: 'POST', url: '/mapping/slot/delete', payload: { slotId: 'c1p1s2' } });
    const afterRest = readFileSync(ctx.repo.path, 'utf8');

    ctx.repo.saveArtifact(sampleArtifact());
    const rpcRes = await rpc(ctx.app, 'setup.slot.delete', { slotId: 'c1p1s2', confirm: true });
    const afterRpc = readFileSync(ctx.repo.path, 'utf8');

    expect(rpcRes.result).toEqual(restRes.json());
    expect(afterRpc).toBe(afterRest);
  });
});

describe('뷰어 컨텍스트 라우트(웹이 실제로 부르는 경로)', () => {
  it('/viewer/api/mapping/slot/add·delete 가 등록돼 있고 헤드리스와 같은 핸들러를 쓴다', async () => {
    ctx = makeCtx({ viewer: true });
    const add = await ctx.app.inject({
      method: 'POST', url: '/viewer/api/mapping/slot/add',
      payload: { camIdx: 1, presetIdx: 1, at: 2, dryRun: true },
    });
    expect(add.statusCode).toBe(200);
    expect(add.json().slotId).toBe('c1p1s3');
    const del = await ctx.app.inject({
      method: 'POST', url: '/viewer/api/mapping/slot/delete',
      payload: { slotId: 'nope', dryRun: true },
    });
    expect(del.statusCode).toBe(409); // 같은 가드가 살아 있다
  });
});
