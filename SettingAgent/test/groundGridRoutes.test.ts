import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify, { type FastifyInstance } from 'fastify';
import { registerGroundGridRoutes } from '../src/api/groundGridRoutes.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

/**
 * L3 Loop 5 — 라우트. 설계 §7 Loop 5-1/5-2 의 완료 조건을 봉인한다.
 *   · bootstrap 은 **파일을 절대 쓰지 않는다**
 *   · apply 는 confirm:true 없으면 400
 *   · 개수 불일치(R-4)·빈 결과(R-5) 면 파일 무변경
 *   · apply 후 diff 가 **대상 프리셋에만** 국한(다른 프리셋 바이트 동일)
 */

const ground: NonNullable<ToolsConfig['ground']> = {
  enabled: true, minDepthEdgePx: 250, slotWidthM: 2.5, slotDepthM: 5.0,
};
/**
 * 동결 픽스처. 런타임 정본(data/Place01 아래 PtzCamRoi.json)을 읽으면 **이 기능의 apply 라우트가 그 파일을
 * 덮어쓰는 순간** 이 테스트가 깨진다(self-invalidating). 픽스처를 임시 디렉터리에 복사해 쓴다.
 */
const ROI_FILE = 'test/fixtures/groundGrid.PtzCamRoi.json';

let tmp: string | undefined;
let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

/** 실데이터(정본) 사본을 임시 디렉터리에 만든다 — 원본은 절대 건드리지 않는다. */
function setup() {
  tmp = mkdtempSync(join(tmpdir(), 'ground-grid-'));
  const placeRoiFile = join(tmp, 'PtzCamRoi.json');
  writeFileSync(placeRoiFile, readFileSync(ROI_FILE, 'utf8'));
  const groundGridFile = join(tmp, 'ground_grid.json');
  app = fastify();
  registerGroundGridRoutes(app, { placeRoiFile, groundGridFile, ground });
  return { placeRoiFile, groundGridFile, app: app! };
}

/** cam1 preset1 의 첫 주차면(정규화 4점) — 기준 드로잉 대용. */
function refQuad(placeRoiFile: string) {
  const j = JSON.parse(readFileSync(placeRoiFile, 'utf8'));
  const cam = j.cameras[0];
  const W = cam.camera.imageWidth;
  const H = cam.camera.imageHeight;
  const pts = cam.presets[0].parking_spaces[0].points as number[][];
  return pts.map((p) => ({ x: p[0] / W, y: p[1] / H }));
}

const body = (quad: unknown, extra: Record<string, unknown> = {}) => ({
  camId: 1, presetIdx: 1, quad, cols: 7, rows: 1, ...extra,
});

describe('POST /capture/ground-grid/bootstrap', () => {
  it('미리보기 — 파일을 쓰지 않는다(바이트 동일 + ground_grid.json 미생성)', async () => {
    const { placeRoiFile, groundGridFile, app } = setup();
    const before = readFileSync(placeRoiFile, 'utf8');
    const res = await app.inject({ method: 'POST', url: '/capture/ground-grid/bootstrap', payload: body(refQuad(placeRoiFile)) });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.ok).toBe(true);
    expect(j.constants.d).toBeGreaterThan(3);
    expect(j.grid.colPitchM).toBe(2.5);
    expect(j.grid.rowPitchM).toBe(5);
    const p1 = j.presets.find((p: { presetIdx: number }) => p.presetIdx === 1);
    expect(p1.fileCount).toBe(7);
    expect(p1.matched).toBe(7);
    expect(p1.avgIoU).toBeGreaterThanOrEqual(0.9);
    expect(p1.applicable).toBe(true);
    expect(readFileSync(placeRoiFile, 'utf8')).toBe(before); // 부작용 0.
    expect(existsSync(groundGridFile)).toBe(false);
  });

  it('4점 아님 → 400', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/capture/ground-grid/bootstrap', payload: body([{ x: 0, y: 0 }]) });
    expect(res.statusCode).toBe(400);
  });

  it('★ 손상 JSON → 500 throw 가 아니라 표준 파일에러(QA 결함 2)', async () => {
    const { placeRoiFile, app } = setup();
    writeFileSync(placeRoiFile, '{ 이건 JSON 이 아니다');
    for (const url of ['/capture/ground-grid/bootstrap', '/capture/ground-grid/apply']) {
      const payload =
        url.endsWith('apply')
          ? { ...body([{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }, { x: 0.2, y: 0.2 }, { x: 0.1, y: 0.2 }]), confirm: true, presets: [1] }
          : body([{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }, { x: 0.2, y: 0.2 }, { x: 0.1, y: 0.2 }]);
      const res = await app.inject({ method: 'POST', url, payload });
      expect(res.statusCode, url).toBe(500);
      // 기존 관례(fileErrorReply)의 shape — Fastify 기본 500 throw 페이지가 아니다.
      expect(res.json().error, url).toBe('place-roi 읽기/파싱 실패');
      expect(res.json().detail, url).toBeTruthy();
    }
  });

  it('없는 카메라 → ok:false + issues (throw 금지)', async () => {
    const { placeRoiFile, app } = setup();
    const res = await app.inject({
      method: 'POST', url: '/capture/ground-grid/bootstrap',
      payload: body(refQuad(placeRoiFile), { camId: 99 }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
    expect(res.json().issues.join(' ')).toContain('해당 카메라 없음');
  });
});

describe('GET /capture/ground-grid', () => {
  it('저장 전 404', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'GET', url: '/capture/ground-grid' })).statusCode).toBe(404);
  });
});

describe('POST /capture/ground-grid/apply', () => {
  it('confirm 없으면 400 — 파일 무변경', async () => {
    const { placeRoiFile, app } = setup();
    const before = readFileSync(placeRoiFile, 'utf8');
    const res = await app.inject({
      method: 'POST', url: '/capture/ground-grid/apply',
      payload: body(refQuad(placeRoiFile), { presets: [1] }),
    });
    expect(res.statusCode).toBe(400);
    expect(readFileSync(placeRoiFile, 'utf8')).toBe(before);
  });

  it('★ R-4: 기존 슬롯이 자동 quad 와 매칭되지 않으면 적용 거부 + 파일 무변경', async () => {
    const { placeRoiFile, app } = setup();
    const before = readFileSync(placeRoiFile, 'utf8');
    // cols=1 → 자동 quad 1개뿐인데 preset1 파일 슬롯은 7개 → 6개 미매칭.
    const res = await app.inject({
      method: 'POST', url: '/capture/ground-grid/apply',
      payload: body(refQuad(placeRoiFile), { confirm: true, presets: [1], cols: 1 }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
    expect(res.json().error).toContain('R-4');
    expect(readFileSync(placeRoiFile, 'utf8')).toBe(before);
  });

  it('대상 프리셋이 파일에 없으면 거부 + 파일 무변경', async () => {
    const { placeRoiFile, app } = setup();
    const before = readFileSync(placeRoiFile, 'utf8');
    const res = await app.inject({
      method: 'POST', url: '/capture/ground-grid/apply',
      payload: body(refQuad(placeRoiFile), { confirm: true, presets: [9] }),
    });
    expect(res.json().ok).toBe(false);
    expect(readFileSync(placeRoiFile, 'utf8')).toBe(before);
  });

  it('★ 성공: 대상 프리셋만 갱신되고 idx·순서가 보존된다(다른 프리셋 불변)', async () => {
    const { placeRoiFile, groundGridFile, app } = setup();
    const before = JSON.parse(readFileSync(placeRoiFile, 'utf8'));
    const res = await app.inject({
      method: 'POST', url: '/capture/ground-grid/apply',
      payload: body(refQuad(placeRoiFile), { confirm: true, presets: [1] }),
    });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.ok).toBe(true);
    expect(j.applied).toEqual([{ presetIdx: 1, spaceCount: 7, avgIoU: expect.any(Number) }]);
    expect(j.appended).toBe(0);

    const after = JSON.parse(readFileSync(placeRoiFile, 'utf8'));
    // 대상 프리셋: idx 순서 보존 + 좌표는 자동 산출로 교체(원본과 근사 일치).
    const bs = before.cameras[0].presets[0].parking_spaces;
    const as = after.cameras[0].presets[0].parking_spaces;
    expect(as.map((s: { idx: number }) => s.idx)).toEqual(bs.map((s: { idx: number }) => s.idx));
    for (let i = 0; i < bs.length; i++) {
      for (let k = 0; k < 4; k++) {
        expect(Math.abs(as[i].points[k][0] - bs[i].points[k][0])).toBeLessThan(2); // px
        expect(Math.abs(as[i].points[k][1] - bs[i].points[k][1])).toBeLessThan(2);
      }
    }
    // 다른 프리셋·다른 카메라는 완전 동일.
    expect(after.cameras[0].presets[1]).toEqual(before.cameras[0].presets[1]);
    expect(after.cameras[0].presets[2]).toEqual(before.cameras[0].presets[2]);
    expect(after.cameras[1]).toEqual(before.cameras[1]);

    // ground_grid.json 저장 + GET 으로 조회 가능.
    const store = JSON.parse(readFileSync(groundGridFile, 'utf8'));
    expect(store.version).toBe(1);
    expect(store.cameras[0].camIdx).toBe(1);
    expect(store.cameras[0].grids[0].appliedPresets).toEqual([1]);
    expect((await app.inject({ method: 'GET', url: '/capture/ground-grid' })).statusCode).toBe(200);
  });

  it('영속화 수치는 소수점 5자리 이내(stringify5 규약)', async () => {
    const { placeRoiFile, groundGridFile, app } = setup();
    await app.inject({
      method: 'POST', url: '/capture/ground-grid/apply',
      payload: body(refQuad(placeRoiFile), { confirm: true, presets: [1] }),
    });
    for (const f of [placeRoiFile, groundGridFile]) {
      for (const m of readFileSync(f, 'utf8').matchAll(/-?\d+\.(\d+)/g)) {
        expect(m[1].length, `${f}: ${m[0]}`).toBeLessThanOrEqual(5);
      }
    }
  });
});
