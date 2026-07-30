// ★ 21회차 Phase 2 — **실카 제원 입력의 함정 3건**을 못 박는다(D1·D2·D3).
//
// 배경(마스터 실제 사례 · 리더 라이브 확정):
//   D1 「예상 주차면 수」 칸에 `0` → 서버 스키마 `int().min(1)` 이 invalid params 로 거부 → 검출 자체가 안 됨.
//   D2 「틸트」 칸에 **뷰어 PTZ 패널의 표시값**(−29.9781818)을 옮겨 적음 → 하향이 음수 → 지면 법선 반전 → f=null.
//      그 값은 각도가 아니라 네이티브 tiltpos 를 [-90,90] 에 선형 range-fit 한 **위치**다
//      (실측 real-camera-1: 뷰어 −29.9781818 ↔ tiltpos 1668 = 하향 **16.68°**).
//   D3 「수평화각(유효)」 칸에 광각단 사양값 58 → 실측표 자동값 34.931° 대비 f 가 0.5676배로 어긋남.
//
// ★ 부호를 자동으로 뒤집지 않는다(R3). "표시값을 옮겨 적었다"가 **왕복 검산으로 확인된 경우에만** 강등한다.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { roiAutoDetect } from '../src/rpc/services/roiAuto.js';
import type { CameraSource } from '../src/viewer/CameraSource.js';
import type { RpcContext } from '../src/rpc/types.js';

/** 실기와 같은 range-fit: 뷰어 [-90,90] ↔ 네이티브 tiltpos [-2000,9000] (사양서 §8.1). */
const VIEWER_TILT: readonly [number, number] = [-90, 90];
const NATIVE_TILT: readonly [number, number] = [-2000, 9000];
const VIEWER_ZOOM: readonly [number, number] = [1, 36];
const NATIVE_ZOOM: readonly [number, number] = [0, 16384];
const mapRange = (v: number, from: readonly [number, number], to: readonly [number, number]): number =>
  to[0] + ((v - from[0]) / (from[1] - from[0])) * (to[1] - to[0]);

/** 실측값: 뷰어 tilt −29.9781818 → tiltpos 1668 → 하향 16.68°. */
const VIEWER_TILT_READOUT = -29.978181818181817;
const NATIVE_TILTPOS = 1668;
const AUTO_TILT_DEG = 16.68;

const PLACE = {
  place_id: 'Place01',
  cameras: [
    {
      camera: { cam_id: 1, position: [0, 5, 0], height_m: 5, rotation: [0, 0, 0] },
      presets: [{ preset_idx: 1, pan: 0, tilt: 10, zoom: 1, fov: 30 }],
    },
  ],
};

function realStub(calls: string[], jpeg: Buffer): CameraSource {
  const ptz = { pan: 0, tilt: VIEWER_TILT_READOUT, zoom: 11.587158203125 };
  return {
    kind: 'hucoms',
    listCameras: async () => ({ cameras: [] }),
    getPtz: async () => {
      calls.push('getPtz');
      return ptz;
    },
    snapshot: async (_cam: number, opt: { mode: string; ptz?: typeof ptz }) => {
      calls.push(`snapshot:${opt.mode}`);
      return { jpeg, ptz: opt.ptz ?? ptz };
    },
    move: async () => true,
    // ★ 항등이 아닌 **실기와 같은 range-fit**. 이것이 없으면 "표시값인가" 판정이 성립하지 않는다.
    toNativePtz: (p: { pan: number; tilt: number; zoom: number }) => ({
      pan: p.pan,
      tilt: mapRange(p.tilt, VIEWER_TILT, NATIVE_TILT),
      zoom: mapRange(p.zoom, VIEWER_ZOOM, NATIVE_ZOOM),
    }),
    fromNativePtz: (n: unknown) => n as typeof ptz,
  } as unknown as CameraSource;
}

describe('실카 제원 입력 — D2 틸트 부호·D3 화각 불일치', () => {
  let dir: string;
  let file: string;
  let calls: string[];
  const jpeg = readFileSync('test/fixtures/roiAutoGolden/frame_1_1_d0.jpg');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'roiauto-real-'));
    file = join(dir, 'PtzCamRoi.json');
    writeFileSync(file, JSON.stringify(PLACE, null, 2), 'utf8');
    calls = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const ctxOf = (src: CameraSource, id = 'real-x'): RpcContext =>
    ({
      app: {} as never,
      deps: {
        placeRoiFile: file,
        camera: { requestImage: async () => ({ imageBase64: '', width: 0, height: 0 }) } as never,
        cameraCfg: { zoomMin: 1, zoomMax: 36 },
        sources: { get: (k: string) => (k === id ? src : undefined), defaultId: id, list: () => [{ id, kind: 'hucoms' }] },
      },
    }) as unknown as RpcContext;

  /** 응답에서 issues 를 모아 한 문자열로. */
  const issuesOf = (out: unknown): string =>
    ((out as { presets?: Array<{ issues?: string[] }> }).presets ?? []).flatMap((p) => p.issues ?? []).join('\n');

  it('D2 뷰어 표시값을 그대로 적으면 **왕복 검산으로 알아보고** 장비 tiltpos 를 쓴다 + ⚠ 를 남긴다', async () => {
    const src = realStub(calls, jpeg);
    const out = await roiAutoDetect(
      {
        source: 'real-x',
        camId: 1,
        view: 'current',
        consensus: false,
        cameraSpec: { heightM: 13, tiltDeg: VIEWER_TILT_READOUT, hfovDeg: 58 },
      },
      ctxOf(src),
    );
    const iss = issuesOf(out);
    expect(iss).toMatch(/뷰어 PTZ 패널의 표시값/);
    expect(iss).toContain(`tiltpos ${NATIVE_TILTPOS}`);
    expect(iss).toContain(`= ${AUTO_TILT_DEG}°`);
    // 실제로 그 각도로 계산했는가(제원 출처 문자열이 증거).
    const src0 = (out as { presets: Array<{ intrinsics?: { source?: string } }> }).presets[0].intrinsics?.source ?? '';
    expect(src0).toContain(`tilt ${AUTO_TILT_DEG}°`);
    expect(src0).toContain('입력값이 뷰어 표시값과 같아 미지정 처리');
  }, 60_000);

  it('★ R3 — 표시값이 **아닌** 음수 틸트는 손대지 않는다(상향 시선을 조용히 하향으로 바꾸지 않는다)', async () => {
    const src = realStub(calls, jpeg);
    const out = await roiAutoDetect(
      {
        source: 'real-x',
        camId: 1,
        view: 'current',
        consensus: false,
        // 표시값(−29.9781818)이 아니라 사용자가 적은 **진짜 음수 각도**.
        cameraSpec: { heightM: 13, tiltDeg: -29, hfovDeg: 58 },
      },
      ctxOf(src),
    );
    const iss = issuesOf(out);
    expect(iss).toMatch(/0 이하다 = \*\*상향 시선\*\*/);
    expect(iss).toMatch(/부호를 자동으로 뒤집지 않는다/);
    expect(iss).not.toMatch(/뷰어 PTZ 패널의 표시값/);
    // 상향이므로 지면모델이 서지 않는다 — 조용히 성공하지 않는다.
    const p = (out as { presets: Array<{ intrinsics?: { focalPx?: number | null }; quads?: unknown[] }> }).presets[0];
    expect(p.intrinsics?.focalPx ?? null).toBeNull();
    expect(p.quads ?? []).toHaveLength(0);
  }, 60_000);

  it('D2 양수 틸트가 자동값과 크게 다르면 **경고만** 하고 입력값으로 계산한다(조용한 재해석 금지)', async () => {
    const src = realStub(calls, jpeg);
    const out = await roiAutoDetect(
      { source: 'real-x', camId: 1, view: 'current', consensus: false, cameraSpec: { heightM: 13, tiltDeg: 30, hfovDeg: 58 } },
      ctxOf(src),
    );
    const iss = issuesOf(out);
    expect(iss).toMatch(/틸트 수동 입력 30° 가 장비 피드백 자동값 16\.68°/);
    expect((out as { presets: Array<{ intrinsics?: { source?: string } }> }).presets[0].intrinsics?.source).toContain('tilt 30° 수동지정');
  }, 60_000);

  it('D3 화각 수동 입력이 실측표 자동값과 15% 이상 다르면 f 배율과 함께 경고한다', async () => {
    // 이 소스 id 로 zoomHfov 표를 주는 임시 캘리브 파일을 쓴다(정본 파일 무접촉).
    const calib = join(dir, 'lens.json');
    writeFileSync(
      calib,
      JSON.stringify({
        cameras: [{ id: 'real-x', zoomHfov: [{ z: 3000, h: 43.54 }, { z: 5129, h: 34.17 }], cameraSpec: { heightM: 13 } }],
      }),
      'utf8',
    );
    const prev = process.env.LENS_CALIB_FILE;
    process.env.LENS_CALIB_FILE = calib;
    try {
      const out = await roiAutoDetect(
        { source: 'real-x', camId: 1, view: 'current', consensus: false, cameraSpec: { hfovDeg: 58 } },
        ctxOf(realStub(calls, jpeg)),
      );
      const iss = issuesOf(out);
      expect(iss).toMatch(/수평화각 수동 입력 58° 가 이 카메라의 실측표 자동값/);
      expect(iss).toMatch(/배\*\*로 어긋나/);
      expect(iss).toMatch(/입력값으로 계산했다/);
    } finally {
      if (prev == null) delete process.env.LENS_CALIB_FILE;
      else process.env.LENS_CALIB_FILE = prev;
    }
  }, 60_000);
});

describe('D1 뷰어는 1 미만·비정수 예상 주차면 수를 보내지 않는다', () => {
  const app = readFileSync('web/app.js', 'utf8');

  it('정수·1 이상만 보내고, 버린 값은 화면에 적는다(조용한 무시 금지)', () => {
    expect(app).toMatch(/Number\.isInteger\(baysRaw\)\s*&&\s*baysRaw\s*>=\s*1\s*\?\s*baysRaw\s*:\s*undefined/);
    expect(app).toMatch(/baysDropped/);
    expect(app).toMatch(/미지정으로 처리했다/);
  });

  it('예상 주차면 수 필수 경고가 남아 있지 않다(21회차에 선택으로 바뀌었다)', () => {
    expect(app).not.toMatch(/예상 주차면 수가 \*\*필수\*\*/);
  });

  it('실카에서 틸트·화각 칸은 "비워라"를 안내한다(값을 유도하지 않는다)', () => {
    expect(app).toMatch(/비워라\(장비 tiltpos 자동\)/);
    expect(app).toMatch(/비워라\(실측표 자동\)/);
  });
});
