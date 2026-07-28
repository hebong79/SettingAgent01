import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify, { type FastifyInstance } from 'fastify';
import { registerGroundGridRoutes } from '../src/api/groundGridRoutes.js';
import { normalizePtzCamRoi } from '../src/capture/placeRoi.js';
import { assertAutoPromoteSafe } from '../src/ground/autoRoiPlan.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

/**
 * L3 후속 Loop 2/3 — 승인(apply) 의 **쓰기 순서 `_auto` → `.bak` → 정본** 과 파괴 방지 게이트를 봉인한다.
 * 쓰기 순서 근거: 정본을 마지막에 쓰므로 앞 단계가 실패하면 **정본은 손상되지 않는다**(설계 §5 롤백표).
 */

const ground: NonNullable<ToolsConfig['ground']> = {
  enabled: true, minDepthEdgePx: 250, slotWidthM: 2.5, slotDepthM: 5.0,
};
/** 동결 픽스처(groundGridRoutes.test.ts 와 동일 — 런타임 정본을 읽으면 self-invalidating). */
const ROI_FILE = 'test/fixtures/groundGrid.PtzCamRoi.json';

let tmp: string | undefined;
let app: FastifyInstance | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await app?.close();
  app = undefined;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function setup() {
  tmp = mkdtempSync(join(tmpdir(), 'gg-promote-'));
  const placeRoiFile = join(tmp, 'PtzCamRoi.json');
  writeFileSync(placeRoiFile, readFileSync(ROI_FILE, 'utf8'));
  const groundGridFile = join(tmp, 'ground_grid.json');
  app = fastify();
  registerGroundGridRoutes(app, { placeRoiFile, groundGridFile, ground });
  return { dir: tmp, placeRoiFile, autoFile: join(tmp, 'PtzCamRoi_auto.json'), groundGridFile, app: app! };
}

function refQuad(placeRoiFile: string) {
  const j = JSON.parse(readFileSync(placeRoiFile, 'utf8'));
  const cam = j.cameras[0];
  const W = cam.camera.imageWidth;
  const H = cam.camera.imageHeight;
  return (cam.presets[0].parking_spaces[0].points as number[][]).map((p) => ({ x: p[0] / W, y: p[1] / H }));
}

const applyBody = (quad: unknown, extra: Record<string, unknown> = {}) => ({
  camId: 1, presetIdx: 1, quad, cols: 7, rows: 1, confirm: true, presets: [1], ...extra,
});

const doApply = (a: FastifyInstance, payload: unknown) =>
  a.inject({ method: 'POST', url: '/capture/ground-grid/apply', payload: payload as object });

const bakFiles = (dir: string) => readdirSync(dir).filter((f) => f.includes('.bak.')).sort();

describe('S3 PtzCamRoi_auto.json — 감사 기록', () => {
  it('승인 전에는 존재하지 않는다(정상 부재 — 경고 없음)', () => {
    const { autoFile } = setup();
    expect(existsSync(autoFile)).toBe(false);
  });

  it('승인 시 생성되고 cameras 는 정본과 동일 · _auto 메타를 담는다', async () => {
    const { placeRoiFile, autoFile, app } = setup();
    const res = await doApply(app, applyBody(refQuad(placeRoiFile), { refSpaceIdx: 1 }));
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().autoFile).toBe('PtzCamRoi_auto.json');

    const auto = JSON.parse(readFileSync(autoFile, 'utf8'));
    const manual = JSON.parse(readFileSync(placeRoiFile, 'utf8'));
    expect(auto.cameras).toEqual(manual.cameras); // cameras 구조 무손상.
    expect(auto._auto.version).toBe(1);
    expect(auto._auto.meta.camIdx).toBe(1);
    expect(auto._auto.meta.refSpaceIdx).toBe(1);
    expect(auto._auto.meta.appliedPresets).toEqual([1]);
    expect(auto._auto.meta.source).toBe('ground-grid/apply');
    expect(auto._auto.meta.backupFile).toBe(res.json().backupFile);
    expect(auto._auto.meta.constants.d).toBeGreaterThan(3);
    expect(auto._auto.meta.grid.colPitchM).toBe(2.5);
    expect(auto._auto.history).toHaveLength(1);
  });

  it('★ normalizePtzCamRoi(_auto 포함) === normalizePtzCamRoi(_auto 제거) — 최상위 키가 파이프라인에 무해', async () => {
    const { placeRoiFile, autoFile, app } = setup();
    await doApply(app, applyBody(refQuad(placeRoiFile)));
    const auto = JSON.parse(readFileSync(autoFile, 'utf8'));
    const stripped = { ...auto };
    delete stripped._auto;
    const a = normalizePtzCamRoi(auto);
    const b = normalizePtzCamRoi(stripped);
    expect([...a.byPreset.entries()]).toEqual([...b.byPreset.entries()]);
    expect(a.report).toEqual(b.report);
  });

  it('★ promote 된 정본에는 _auto 키가 없다(정본 스키마 불변)', async () => {
    const { placeRoiFile, app } = setup();
    await doApply(app, applyBody(refQuad(placeRoiFile)));
    const manual = JSON.parse(readFileSync(placeRoiFile, 'utf8'));
    expect(Object.keys(manual)).not.toContain('_auto');
    expect(readFileSync(placeRoiFile, 'utf8')).not.toContain('_auto');
  });

  it('history 는 승인마다 누적된다(여러 주차열을 나눠 승인하는 실사용)', async () => {
    const { placeRoiFile, autoFile, app } = setup();
    const quad = refQuad(placeRoiFile);
    await doApply(app, applyBody(quad));
    await doApply(app, applyBody(quad));
    expect(JSON.parse(readFileSync(autoFile, 'utf8'))._auto.history).toHaveLength(2);
  });

  it('_auto.json 이 손상돼도 승인은 계속된다(history 만 새로 시작 + issues 1건)', async () => {
    const { placeRoiFile, autoFile, app } = setup();
    writeFileSync(autoFile, '{ 이건 JSON 이 아니다');
    const res = await doApply(app, applyBody(refQuad(placeRoiFile)));
    expect(res.json().ok).toBe(true);
    expect(res.json().issues.join(' ')).toContain('이력(history)을 새로 시작한다');
    expect(JSON.parse(readFileSync(autoFile, 'utf8'))._auto.history).toHaveLength(1);
  });

  it('★ S3 실패(경로가 디렉터리) → 500 · 정본 바이트 무변경 · .bak 미생성', async () => {
    const { dir, placeRoiFile, autoFile, app } = setup();
    mkdirSync(autoFile); // writeFile → EISDIR.
    const before = readFileSync(placeRoiFile, 'utf8');
    const res = await doApply(app, applyBody(refQuad(placeRoiFile)));
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain('정본 무변경');
    expect(readFileSync(placeRoiFile, 'utf8')).toBe(before);
    expect(bakFiles(dir)).toEqual([]);
  });
});

describe('S4 백업(.bak)', () => {
  it('승인 직전 정본과 **바이트 완전 동일**', async () => {
    const { dir, placeRoiFile, app } = setup();
    const before = readFileSync(placeRoiFile, 'utf8');
    const res = await doApply(app, applyBody(refQuad(placeRoiFile)));
    const name = res.json().backupFile as string;
    expect(name).toMatch(/^PtzCamRoi\.[0-9A-Za-z]+\.bak\.json$/);
    expect(readFileSync(join(dir, name), 'utf8')).toBe(before);
    expect(readFileSync(placeRoiFile, 'utf8')).not.toBe(before); // 정본은 갱신됐다.
  });

  it('★ S4 실패(백업 경로가 디렉터리) → 500 · 정본 바이트 무변경 · _auto 는 기록됨', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-28T10:15:30.000Z'));
    const { dir, placeRoiFile, autoFile, app } = setup();
    mkdirSync(join(dir, 'PtzCamRoi.20260728T101530Z.bak.json'));
    const before = readFileSync(placeRoiFile, 'utf8');
    const res = await doApply(app, applyBody(refQuad(placeRoiFile)));
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('백업 실패 — 정본 무변경');
    expect(readFileSync(placeRoiFile, 'utf8')).toBe(before);
    expect(existsSync(autoFile)).toBe(true); // S3 는 이미 끝났다(쓰기 순서 _auto → .bak → 정본).
  });

  it('되돌리기: .bak 을 정본에 복사하면 승인 전 상태가 바이트 단위로 복원된다', async () => {
    const { dir, placeRoiFile, app } = setup();
    const before = readFileSync(placeRoiFile, 'utf8');
    const res = await doApply(app, applyBody(refQuad(placeRoiFile)));
    writeFileSync(placeRoiFile, readFileSync(join(dir, res.json().backupFile), 'utf8'));
    expect(readFileSync(placeRoiFile, 'utf8')).toBe(before);
  });
});

describe('S5 정본 갱신 + 결정론 + 5자리', () => {
  it('_auto.json 과 정본 모두 소수점 5자리 이하', async () => {
    const { placeRoiFile, autoFile, app } = setup();
    await doApply(app, applyBody(refQuad(placeRoiFile)));
    for (const f of [placeRoiFile, autoFile]) {
      expect(readFileSync(f, 'utf8')).not.toMatch(/-?\d+\.\d{6,}/);
    }
  });

  it('결정론: 같은 입력으로 서로 다른 작업공간에서 승인 → cameras 부분 바이트 동일', async () => {
    const run = async () => {
      const s = setup();
      await doApply(s.app, applyBody(refQuad(s.placeRoiFile)));
      const text = readFileSync(s.placeRoiFile, 'utf8');
      await s.app.close();
      app = undefined;
      rmSync(s.dir, { recursive: true, force: true });
      tmp = undefined;
      return JSON.stringify(JSON.parse(text).cameras);
    };
    expect(await run()).toBe(await run());
  });

  it('누적: 2회 승인해도 슬롯 수·idx 가 유지된다(기저가 항상 정본이므로 직전 승인분이 남는다)', async () => {
    const { placeRoiFile, app } = setup();
    const quad = refQuad(placeRoiFile);
    await doApply(app, applyBody(quad));
    const first = readFileSync(placeRoiFile, 'utf8');
    const res = await doApply(app, applyBody(quad));
    expect(res.json().ok).toBe(true);
    const after = JSON.parse(readFileSync(placeRoiFile, 'utf8'));
    const idx = after.cameras[0].presets[0].parking_spaces.map((s: { idx: number }) => s.idx);
    expect(idx).toEqual(JSON.parse(first).cameras[0].presets[0].parking_spaces.map((s: { idx: number }) => s.idx));
    expect(idx).toHaveLength(7);
  });
});

describe('S2 파괴 방지 게이트 assertAutoPromoteSafe (순수)', () => {
  const roi = (spacesByPreset: Record<number, number[]>) => ({
    cameras: [
      {
        camera: { cam_id: 1, imageWidth: 1920, imageHeight: 1080 },
        presets: Object.entries(spacesByPreset).map(([p, idxs]) => ({
          preset_idx: Number(p),
          parking_spaces: idxs.map((i) => ({ idx: i, points: [[0, 0], [10, 0], [10, 10], [0, 10]] })),
        })),
      },
    ],
  });

  it('정상(좌표만 교체) → 통과', () => {
    expect(assertAutoPromoteSafe(roi({ 1: [1, 2, 3] }), roi({ 1: [1, 2, 3] }))).toEqual({ ok: true });
  });

  it('정상(allowNew append = 상위집합) → 통과', () => {
    expect(assertAutoPromoteSafe(roi({ 1: [1, 2, 3, 4] }), roi({ 1: [1, 2, 3] })).ok).toBe(true);
  });

  it('G1 유효 프리셋 0개 → 거부', () => {
    const g = assertAutoPromoteSafe({ cameras: [] }, roi({ 1: [1, 2] }));
    expect(g.ok).toBe(false);
    expect(g.error).toContain('G1');
  });

  it('G2 idx 집합 ⊉ → 거부 + missingIdx 가 실제 사라진 idx', () => {
    const g = assertAutoPromoteSafe(roi({ 1: [1, 3], 2: [4, 5] }), roi({ 1: [1, 2, 3], 2: [4, 5] }));
    expect(g.ok).toBe(false);
    expect(g.error).toContain('G2');
    expect(g.detail).toEqual({ nextSlots: 4, currentSlots: 5, missingIdx: [2] });
  });

  it('G3 프리셋 단위 누락(개수 감소) → 거부', () => {
    // idx 집합은 상위집합이지만(G2 통과) 총수가 줄어드는 경우는 만들 수 없으므로
    // G3 는 idx 중복이 없는 한 G2 에 함의된다 — 독립 방어선으로 남긴다.
    const g = assertAutoPromoteSafe(roi({ 1: [1, 2] }), roi({ 1: [1, 2, 3] }));
    expect(g.ok).toBe(false);
    expect(g.detail?.nextSlots).toBe(2);
    expect(g.detail?.currentSlots).toBe(3);
  });

  it('대상 0건 → 거부(실측: G4 가 아니라 G1 이 먼저 잡는다 — byPreset 에 빈 프리셋이 등재되지 않기 때문)', () => {
    const g = assertAutoPromoteSafe(roi({ 1: [] }), roi({ 1: [] }));
    expect(g.ok).toBe(false);
    expect(g.detail?.nextSlots).toBe(0);
    // G4 는 G1 에 함의된다(도달 불가). 게이트 자체는 설계대로 남기되, 여기서는 **거부된다는 사실**만 봉인한다.
    expect(g.error).toContain('적용 거부');
  });

  it('순회 순서에 의존하지 않는다(프리셋 선언 순서를 바꿔도 같은 판정)', () => {
    const a = assertAutoPromoteSafe(roi({ 1: [1, 2], 2: [3] }), roi({ 2: [3], 1: [1, 2] }));
    expect(a).toEqual({ ok: true });
  });

  // ── G5(QA 결함 1): 정규화에서 탈락하는 주차면은 idx 집합에 나타나지 않으므로 **raw 개수**로만 잡힌다.
  describe('G5 raw parking_spaces 개수 감소', () => {
    /** raw 파일 조립 — 정규화 탈락분(idx 없음 등)을 섞을 수 있다. */
    const rawRoi = (spaces: unknown[]) => ({
      cameras: [
        {
          camera: { cam_id: 1, imageWidth: 1920, imageHeight: 1080 },
          presets: [{ preset_idx: 1, parking_spaces: spaces }],
        },
      ],
    });
    const ok = (i: number) => ({ idx: i, points: [[0, 0], [10, 0], [10, 10], [0, 10]] });

    it('idx 없는 주차면이 사라지는 promote → 거부 + 어느 프리셋에서 몇 면인지 보고', () => {
      const current = rawRoi([ok(1), ok(2), { points: [[10, 10], [20, 10], [20, 20], [10, 20]] }]);
      const next = rawRoi([ok(1), ok(2)]); // 정규화 통과분만 남은 결과 = 탈락분 삭제됨.
      const g = assertAutoPromoteSafe(next, current);
      expect(g.ok).toBe(false);
      expect(g.error).toContain('G5');
      expect(g.error).toContain('cam1 preset1 3면→2면');
      expect(g.error).toContain('idx 를 넣어');
      expect(g.detail?.droppedRaw).toEqual([{ key: '1:1', from: 3, to: 2 }]);
      // ★ 정규화 idx 집합만 보면 아무 문제가 없다 — G2 가 못 잡는 이유를 함께 봉인한다.
      expect(g.detail?.missingIdx).toEqual([]);
      expect(g.detail?.nextSlots).toBe(g.detail?.currentSlots);
    });

    it('points 누락으로 탈락하는 주차면도 잡는다', () => {
      const g = assertAutoPromoteSafe(rawRoi([ok(1)]), rawRoi([ok(1), { idx: 9 }]));
      expect(g.ok).toBe(false);
      expect(g.error).toContain('G5');
    });

    it('개수가 같거나 늘면 통과(정상 좌표 교체 · allowNew append)', () => {
      expect(assertAutoPromoteSafe(rawRoi([ok(1), ok(2)]), rawRoi([ok(1), ok(2)])).ok).toBe(true);
      expect(assertAutoPromoteSafe(rawRoi([ok(1), ok(2), ok(3)]), rawRoi([ok(1), ok(2)])).ok).toBe(true);
    });
  });
});

describe('★ S2 게이트 라우트 레벨 도달 — G5 는 죽은 코드가 아니다', () => {
  /** 픽스처 사본의 cam1 preset1 에 **idx 없는 주차면** 1건을 끼워 넣는다(사람이 그리다 만 것·구버전 파일). */
  function injectIdxlessSpace(placeRoiFile: string, camI: number, presetI: number): number {
    const j = JSON.parse(readFileSync(placeRoiFile, 'utf8'));
    const spaces = j.cameras[camI].presets[presetI].parking_spaces as unknown[];
    spaces.push({ points: [[10, 10], [20, 10], [20, 20], [10, 20]] });
    writeFileSync(placeRoiFile, JSON.stringify(j, null, 2));
    return spaces.length;
  }

  it('idx 없는 주차면이 대상 프리셋에 있으면 **409** + 정본·_auto·.bak 전부 무변경', async () => {
    const { dir, placeRoiFile, autoFile, app } = setup();
    const quad = refQuad(placeRoiFile); // 주입 전 좌표(정상 슬롯 기준).
    const before = readFileSync(placeRoiFile, 'utf8');
    const rawCount = injectIdxlessSpace(placeRoiFile, 0, 0);
    const beforeInjected = readFileSync(placeRoiFile, 'utf8');
    expect(rawCount).toBe(8); // 7면 + idx 없는 1면.
    expect(before).not.toBe(beforeInjected);

    const res = await doApply(app, applyBody(quad));
    expect(res.statusCode).toBe(409);
    const j = res.json();
    expect(j.ok).toBe(false);
    expect(j.error).toContain('G5');
    expect(j.error).toContain('8면→7면');
    expect(j.detail.droppedRaw).toEqual([{ key: '1:1', from: 8, to: 7 }]);
    // 거부는 DB 접근 전 파일 계층에서 끝난다 — 아무 파일도 만들지 않는다.
    expect(readFileSync(placeRoiFile, 'utf8')).toBe(beforeInjected);
    expect(existsSync(autoFile)).toBe(false);
    expect(bakFiles(dir)).toEqual([]);
  });

  it('탈락분이 **대상 아닌** 프리셋에 있으면 통과한다(오탐 없음 — 그 프리셋은 교체되지 않으므로)', async () => {
    const { placeRoiFile, app } = setup();
    const quad = refQuad(placeRoiFile);
    injectIdxlessSpace(placeRoiFile, 0, 1); // cam1 preset2 에 주입, 승인 대상은 preset1.
    const res = await doApply(app, applyBody(quad));
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    // 대상 아닌 프리셋의 raw 개수는 그대로 유지된다(삭제되지 않았음을 실물로 확인).
    const after = JSON.parse(readFileSync(placeRoiFile, 'utf8'));
    expect(after.cameras[0].presets[1].parking_spaces).toHaveLength(5);
  });
});
