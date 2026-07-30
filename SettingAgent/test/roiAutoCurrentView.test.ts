// ★ 20회차 — 「현재 화면 그대로 검출」(`roi.auto.detect{view:"current"}`).
//
// 이 파일이 지키는 것은 세 가지다:
//   ⓐ **카메라가 움직이지 않는다** — 현재 PTZ 를 읽어 그 값을 그대로 되쓰는 manual 경로여야 한다.
//      (ptz 를 안 넘기면 `mode:'preset'` 이 되고 그쪽은 프리셋으로 **실제로 이동한다** — 이 함정이 T8 의 이유다.)
//   ⓑ **모자란 값을 지어내지 않는다** — 현재 PTZ 불가·제원 미상·`expectedBays` 결측은 전부 명시적 거부.
//   ⓒ **preset 모드는 한 바이트도 안 바뀐다** — 새 키(`view`·`ptzUsed`·`rows`)가 붙으면 안 된다.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { focalPxAtZoom, focalPxOf, groundModelFromIntrinsics, type PresetIntrinsics } from '../src/ground/cameraIntrinsics.js';
import { baseFocalPxOf, readPlaceMeta } from '../src/ground/placeMetaIntrinsics.js';
import { roiAutoDetect, roiAutoScore } from '../src/rpc/services/roiAuto.js';
import { RpcMethodError } from '../src/rpc/errors.js';
import type { RpcContext } from '../src/rpc/types.js';
import type { CameraSource, Ptz, SnapshotOpts } from '../src/viewer/CameraSource.js';
import type { ICameraClient } from '../src/clients/CameraClient.js';

const SIM: PresetIntrinsics = {
  camIdx: 1,
  presetIdx: 1,
  fovDeg: 58,
  fovAxis: 'horizontal',
  tiltDeg: 8.7,
  heightM: 4.95,
  imgW: 1920,
  imgH: 1080,
  source: 'test',
};

describe('T1~T3 focalPxAtZoom — 줌을 곱할지 말지는 값 자신이 안다', () => {
  it('T1 `fovAtZoom` 미설정이면 focalPxOf 와 **완전 동일**하다(회귀 봉인)', () => {
    for (const z of [1, 1.5, 1.69341, 4, 36]) {
      expect(focalPxAtZoom(SIM, z)).toBe(focalPxOf(SIM));
    }
    // 유효 화각 규약에서는 zoom 이 비정상이어도 f 는 그대로다(종전 경로가 zoom 을 안 봤으므로).
    expect(focalPxAtZoom(SIM, 0)).toBe(focalPxOf(SIM));
    expect(focalPxAtZoom(SIM, NaN)).toBe(focalPxOf(SIM));
  });

  it('T2 `zoom1` 기준 58° · imgW 1920 → 인계서 5행 표를 ±0.2px 로 재현한다', () => {
    const base: PresetIntrinsics = { ...SIM, fovAtZoom: 'zoom1' };
    expect(focalPxAtZoom(base, 1)!).toBeCloseTo(1731.9, 1);
    expect(focalPxAtZoom(base, 1.69341)!).toBeCloseTo(2932.8, 1);
    expect(focalPxAtZoom(base, 1.57991)!).toBeCloseTo(2736.2, 1);
    expect(focalPxAtZoom(base, 1.80643)!).toBeCloseTo(3128.5, 1);
    // 규칙 자체가 선형이라는 것도 못 박는다.
    expect(focalPxAtZoom(base, 2)! / focalPxAtZoom(base, 1)!).toBeCloseTo(2, 12);
  });

  it('T3 zoom 이 유한 양수가 아니면 **null** — 1 로 대체하지 않는다', () => {
    const base: PresetIntrinsics = { ...SIM, fovAtZoom: 'zoom1' };
    for (const z of [0, -1, NaN, Infinity, -Infinity]) expect(focalPxAtZoom(base, z)).toBeNull();
  });
});

describe('T4 groundModelFromIntrinsics — 기준 표기를 issues 에 밝힌다', () => {
  it('`zoom1` 이면 f 에 zoom 이 반영되고 issues 가 그 사실을 말한다', () => {
    const m = groundModelFromIntrinsics({ ...SIM, fovAtZoom: 'zoom1' }, 1.69341)!;
    expect(m.f).toBeCloseTo(2932.8, 1);
    expect(m.issues.join('\n')).toMatch(/기준화각 58\.000° horizontal @zoom1 × zoom 1\.69341/);
  });

  it('미설정이면 f 도 issues 문구도 종전 그대로다(preset 모드 무회귀)', () => {
    const m = groundModelFromIntrinsics(SIM, 1.69341)!;
    expect(m.f).toBe(focalPxOf(SIM));
    expect(m.issues.join('\n')).toMatch(/fov 58\.000° horizontal/);
    expect(m.issues.join('\n')).not.toMatch(/@zoom1/);
  });
});

describe('T5~T6 baseFocalPxOf — 줌1 초점거리를 프리셋 메타에서 파생', () => {
  const meta = readPlaceMeta(JSON.parse(readFileSync('data/Place01/PtzCamRoi.json', 'utf8')));

  it('T5 실제 정본으로 cam1·cam2 모두 f@zoom1 ≈ 1731.9px, 산포 ≤ 1px', () => {
    for (const camIdx of [1, 2]) {
      const b = baseFocalPxOf(meta, camIdx)!;
      expect(b).not.toBeNull();
      expect(b.fBasePx).toBeCloseTo(1731.9, 0);
      expect(b.spreadPx).toBeLessThanOrEqual(1);
      // 대표값은 평균·중앙값이 아니라 **최소 presetIdx 표본**이다(이상 표본이 통계로 뭉개지지 않게).
      const minIdx = Math.min(...b.samples.map((s) => s.presetIdx));
      expect(b.fBasePx).toBe(b.samples.find((s) => s.presetIdx === minIdx)!.fBasePx);
      expect(b.from).toContain(`preset${minIdx}`);
    }
  });

  it('T6 프리셋 0개 / zoom 결측 / fov 결측 → null(0 이나 기본값 금지)', () => {
    const cam = { cam_id: 9, imageWidth: 1920, imageHeight: 1080, position: [0, 5, 0], fov: null, eulerAngles: [10, 0, 0] };
    const of = (presets: unknown[]) => baseFocalPxOf(readPlaceMeta({ cameras: [{ camera: cam, presets }] }), 9);
    expect(of([])).toBeNull();
    expect(of([{ preset_idx: 1, fov: 20.8 }])).toBeNull(); // zoom 결측
    expect(of([{ preset_idx: 1, zoom: 1.5 }])).toBeNull(); // fov 결측(카메라 기본 fov 도 null)
    expect(of([{ preset_idx: 1, fov: 20.8, zoom: 0 }])).toBeNull(); // zoom 0
    expect(baseFocalPxOf(readPlaceMeta({ cameras: [] }), 9)).toBeNull();
  });
});

// ── 라이브 서비스 경로 ─────────────────────────────────────────────────────

/** cam1 프리셋 3건 — 정본 `PtzCamRoi.json` 의 cam1 메타와 같은 모양(주차면 1면). */
const PLACE = {
  cameras: [
    {
      camera: { cam_id: 1, imageWidth: 1920, imageHeight: 1080, position: [-9.5, 5, -7.1], fov: 34.63484, eulerAngles: [35.8, 90.1, 0] },
      presets: [
        { preset_idx: 1, fov: 20.86546, zoom: 1.69341, eulerAngles: [8.7, 19.8, 0], parking_spaces: [{ idx: 1, points: [[100, 900], [120, 700], [400, 700], [420, 900]] }] },
        { preset_idx: 2, fov: 22.32798, zoom: 1.57991, eulerAngles: [20.1, 41.5, 0], parking_spaces: [] },
        { preset_idx: 3, fov: 34.63484, zoom: 1, eulerAngles: [35.8, 90.1, 0], parking_spaces: [] },
      ],
    },
  ],
};

/** 프레임 취득 실패로 즉시 끝나는 기본 카메라(이 블록은 **어느 경로를 탔는가**만 본다). */
const deadCamera = (calls: string[]): ICameraClient =>
  ({
    clampZoom: (z: number) => z,
    health: async () => true,
    requestImage: async () => {
      calls.push('requestImage(default)');
      throw new Error('프레임 없음(테스트)');
    },
  }) as unknown as ICameraClient;

interface StubOpts {
  kind?: CameraSource['kind'];
  ptz?: Ptz;
  /** getPtz 가 던진다(현재 PTZ 조회 불가 경로). */
  ptzThrows?: boolean;
  jpeg?: Buffer;
  /** 2회차 이후 getPtz 가 돌려줄 값(장비 float32 왕복 양자화 재현). */
  ptzAfter?: Ptz;
}

/** 호출을 전부 기록하는 소스 시임. `snapshot` 인자를 그대로 남겨 **manual 인지 preset 인지** 검사한다. */
function stubSource(calls: string[], snaps: SnapshotOpts[], o: StubOpts = {}): CameraSource {
  const ptz = o.ptz ?? { pan: 19.8, tilt: 8.7, zoom: 1.69341 };
  return {
    kind: o.kind ?? 'rpc',
    listCameras: async () => ({ cameras: [] }),
    getPtz: async () => {
      calls.push('getPtz');
      if (o.ptzThrows) throw new Error('Unity PTZ 응답이 완전하지 않습니다');
      return calls.filter((c) => c === 'getPtz').length > 1 && o.ptzAfter ? o.ptzAfter : ptz;
    },
    snapshot: async (_cam: number, opt: SnapshotOpts) => {
      calls.push(`snapshot:${opt.mode}`);
      snaps.push(opt);
      if (!o.jpeg) throw new Error('프레임 없음(테스트)');
      return { jpeg: o.jpeg, ptz: opt.ptz ?? ptz };
    },
    move: async () => true,
    toNativePtz: (p: Ptz) => p,
    fromNativePtz: (n: unknown) => n as Ptz,
  } as unknown as CameraSource;
}

const CAM_CFG = { zoomMin: 1, zoomMax: 36 } as NonNullable<RpcContext['deps']['cameraCfg']>;

describe('T7~T12 현재뷰 서비스 경로', () => {
  let dir: string;
  let file: string;
  let calls: string[];
  let snaps: SnapshotOpts[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'roiauto-cur-'));
    file = join(dir, 'PtzCamRoi.json');
    writeFileSync(file, JSON.stringify(PLACE, null, 2), 'utf8');
    calls = [];
    snaps = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const ctxOf = (src: CameraSource, id = 'simulator-1'): RpcContext =>
    ({
      app: {} as never,
      deps: {
        placeRoiFile: file,
        camera: deadCamera(calls),
        cameraCfg: CAM_CFG,
        sources: new Map<string, CameraSource>([[id, src]]),
      },
    }) as RpcContext;

  it('T7 `view` 미지정은 preset 이다 — 응답에 view·ptzUsed·rows 가 **붙지 않는다**', async () => {
    const src = stubSource(calls, snaps, { jpeg: readFileSync('test/fixtures/roiAutoGolden/frame_1_1_d0.jpg') });
    const out = (await roiAutoDetect({ source: 'simulator-1', camId: 1, presetIdx: 1, consensus: false }, ctxOf(src))) as {
      presets: Array<Record<string, unknown>>;
    };
    const p = out.presets[0];
    expect(p).not.toHaveProperty('view');
    expect(p).not.toHaveProperty('ptzUsed');
    expect(p).not.toHaveProperty('rows');
    // 현재 PTZ 를 읽지도 않는다(preset 경로는 종전 그대로).
    expect(calls).not.toContain('getPtz');
  }, 60_000);

  it('T7 roi.auto.score 는 현재뷰를 거부한다 — 수동 정본은 프리셋 종속이다', async () => {
    const err = await roiAutoScore({ source: 'simulator-1', camId: 1, view: 'current' }, ctxOf(stubSource(calls, snaps))).catch((e) => e);
    expect(err).toBeInstanceOf(RpcMethodError);
    expect((err as RpcMethodError).code).toBe(-32602);
    expect(calls).toEqual([]);
  });

  it('T8 ★ 현재 PTZ 를 1회 읽고 **그 값 그대로** manual 캡처한다(preset 경로 0회 = 카메라 무이동)', async () => {
    const ptz = { pan: 41.5, tilt: 20.1000042, zoom: 1.57991 };
    const src = stubSource(calls, snaps, { ptz });
    await expect(
      roiAutoDetect({ source: 'simulator-1', camId: 1, view: 'current', expectedBays: 8 }, ctxOf(src)),
    ).rejects.toThrow(/프레임 취득 실패/);
    expect(calls.filter((c) => c === 'getPtz')).toHaveLength(1);
    expect(calls).toContain('snapshot:manual');
    expect(calls).not.toContain('snapshot:preset'); // preset 분기는 preset.select / 프리셋 PTZ 로 **실제로 이동한다**.
    expect(snaps).toHaveLength(1);
    expect(snaps[0].mode).toBe('manual');
    expect(snaps[0].ptz).toEqual(ptz); // 읽은 값을 그대로 되쓴다 — 되쓰기 값이 다르면 그것이 곧 이동이다.
  });

  it('T9 현재 PTZ 를 못 읽으면 CURRENT_PTZ_UNAVAILABLE — **프레임도 찍지 않는다**', async () => {
    const src = stubSource(calls, snaps, { ptzThrows: true });
    const out = (await roiAutoDetect({ source: 'simulator-1', camId: 1, view: 'current', expectedBays: 8 }, ctxOf(src))) as {
      rejected: boolean;
      graded: boolean;
      gradeReason: string;
      presets: unknown[];
    };
    expect(out.rejected).toBe(true);
    expect(out.graded).toBe(false);
    expect(out.gradeReason).toBe('CURRENT_PTZ_UNAVAILABLE');
    expect(out.presets).toEqual([]);
    expect(calls).toEqual(['getPtz']); // snapshot 이 없다.
  });

  it('T10 consensus:true 라도 현재뷰는 디더를 찍지 않는다 — 무시한 사실을 issues 에 남긴다', async () => {
    const src = stubSource(calls, snaps, { jpeg: readFileSync('test/fixtures/roiAutoGolden/frame_1_1_d0.jpg') });
    const out = (await roiAutoDetect(
      { source: 'simulator-1', camId: 1, view: 'current', expectedBays: 7, consensus: true },
      ctxOf(src),
    )) as { presets: Array<{ issues: string[] }> };
    expect(snaps).toHaveLength(1); // 디더 6시점이면 6장이다.
    expect(out.presets[0].issues.join('\n')).toMatch(/다시점 합의를 \*\*무시\*\*했다/);
  }, 60_000);

  it('T11 `baseHfovDeg` 를 실카에 보내면 명시적으로 거부한다(조용한 재해석 없음)', async () => {
    const src = stubSource(calls, snaps, { kind: 'hucoms' });
    const out = (await roiAutoDetect(
      { source: 'real-x', camId: 1, view: 'current', expectedBays: 8, cameraSpec: { heightM: 13, tiltDeg: 8, baseHfovDeg: 58 } },
      ctxOf(src, 'real-x'),
    )) as { rejected: boolean; missing: string[] };
    expect(out.rejected).toBe(true);
    expect(out.missing.some((m) => m.includes('baseHfovDeg'))).toBe(true);
    expect(calls).toEqual(['getPtz']); // 거부이므로 프레임을 찍지 않았다.
  });

  /**
   * ★ 21회차 — **계약이 바뀌었다**: `expectedBays` 는 현재뷰에서 **선택**이다.
   *
   * 종전 테스트는 "없으면 거부한다"를 못 박고 있었다. 그 거부의 근거는 "비우면 `max(1,0)` 으로 조용히
   * 1면으로 잘린다"였는데, ②(`coverageDenom:'phaseInvariant'`)가 `expectedBays` 를 evidence 경로의
   * 어느 식에서도 읽지 않게 만들어 그 전제가 사라졌다(`test/bayCoverageDenom.test.ts` 가 bays 7값
   * 산출 좌표 비트 동일로 못 박는다). 그래서 이 테스트는 **거부하지 않고 진행한다**로 뒤집는다.
   * 마스터 요구("칸을 비우고 검출")가 이 계약이다.
   */
  it('★ expectedBays 없이도 현재뷰를 돌린다 — 개수를 쓰지 않으므로 잘릴 것이 없다', async () => {
    const src = stubSource(calls, snaps, { jpeg: readFileSync('test/fixtures/roiAutoGolden/frame_1_1_d0.jpg') });
    const out = (await roiAutoDetect({ source: 'simulator-1', camId: 1, view: 'current' }, ctxOf(src))) as {
      rejected?: boolean;
      presets: Array<{ issues: string[]; grid?: unknown }>;
    };
    expect(out.rejected).not.toBe(true);
    expect(out.presets).toHaveLength(1);
    // 개수 없이 돌렸다는 사실을 숨기지 않는다(응답 issues 에 남는다).
    expect(out.presets[0].issues.join('\n')).toMatch(/예상 주차면 수 없이 검출했다/);
    expect(calls).toContain('getPtz');
  }, 60_000);

  it('★ expectedBays 를 주면 종전(면수 기반) 경로다 — 그 사실을 issues 에 적지 않는다', async () => {
    const src = stubSource(calls, snaps, { jpeg: readFileSync('test/fixtures/roiAutoGolden/frame_1_1_d0.jpg') });
    const out = (await roiAutoDetect({ source: 'simulator-1', camId: 1, view: 'current', expectedBays: 7 }, ctxOf(src))) as {
      presets: Array<{ issues: string[] }>;
    };
    expect(out.presets[0].issues.join('\n')).not.toMatch(/예상 주차면 수 없이 검출했다/);
  }, 60_000);

  it('★ camId 없이도 돌리지 않는다(어느 카메라의 현재 화면인지 모른다)', async () => {
    const err = await roiAutoDetect({ source: 'simulator-1', view: 'current', expectedBays: 8 }, ctxOf(stubSource(calls, snaps))).catch((e) => e);
    expect(err).toBeInstanceOf(RpcMethodError);
    expect((err as RpcMethodError).message).toMatch(/camId/);
  });

  it('T12 현재뷰 응답 — ptzUsed·기준 초점거리·rows·candidateId(형식·유일)', async () => {
    const src = stubSource(calls, snaps, {
      ptz: { pan: 19.8, tilt: 8.7, zoom: 1.69341 },
      jpeg: readFileSync('test/fixtures/roiAutoGolden/frame_1_1_d0.jpg'),
    });
    const out = (await roiAutoDetect(
      { source: 'simulator-1', camId: 1, view: 'current', expectedBays: 7, consensus: false },
      ctxOf(src),
    )) as {
      presets: Array<{
        key: string;
        view: string;
        ptzUsed: { pan: number; tilt: number; zoom: number };
        frameHash: string;
        intrinsics: { focalPx: number; fBasePx: number; fovAtZoom: string };
        rows: Array<{ rowIndex: number; paintScore: number; quads: Array<{ candidateId: string; latticeIndex: number }> }>;
      }>;
    };
    const p = out.presets[0];
    expect(p.key).toBe('1:current'); // 프리셋에 속하지 않는다.
    expect(p.view).toBe('current');
    expect(p.ptzUsed).toEqual({ pan: 19.8, tilt: 8.7, zoom: 1.69341 });
    // 기준 f 1731.89px × zoom 1.69341 = 2932.8px — 정본 프리셋 fov 로 낸 값과 같은 자리다.
    expect(p.intrinsics.fBasePx).toBeCloseTo(1731.9, 0);
    expect(p.intrinsics.fovAtZoom).toBe('zoom1');
    expect(p.intrinsics.focalPx).toBeCloseTo(2932.8, 0);
    expect(p.rows.length).toBeGreaterThan(0);
    const ids = p.rows.flatMap((r) => r.quads.map((q) => q.candidateId));
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length); // 유일.
    for (const r of p.rows) {
      for (const q of r.quads) expect(q.candidateId).toBe(`${p.frameHash}#${r.rowIndex}.${q.latticeIndex}`);
    }
  }, 60_000);

  // ── 20b회차 — "안 움직인다"를 주장하는 모드는 **미세 이동도 삼키지 않는다** ──
  it('되쓰기 전후 PTZ 가 1 ULP 라도 다르면 issues 에 크기와 함께 남긴다', async () => {
    const src = stubSource(calls, snaps, {
      ptz: { pan: 41.5, tilt: 20.1000023, zoom: 1.57991 },
      ptzAfter: { pan: 41.5, tilt: 20.1000042, zoom: 1.57991 }, // 실측된 float32 1 ULP.
      jpeg: readFileSync('test/fixtures/roiAutoGolden/frame_1_1_d0.jpg'),
    });
    const out = (await roiAutoDetect(
      { source: 'simulator-1', camId: 1, view: 'current', expectedBays: 7, consensus: false },
      ctxOf(src),
    )) as { presets: Array<{ issues: string[]; ptzUsed: { tilt: number } }> };
    const issues = out.presets[0].issues.join('\n');
    expect(issues).toMatch(/현재 PTZ 되쓰기 전후 차이/);
    expect(issues).toMatch(/tilt 1\.9\d+e-6°/); // 크기를 숨기지 않는다.
    expect(issues).toMatch(/이동 명령 아님/);
    // 응답의 ptzUsed 는 **검출에 실제로 쓴** 값(되쓰기 전 값)이다.
    expect(out.presets[0].ptzUsed.tilt).toBe(20.1);
  }, 60_000);

  it('되쓰기 전후가 같으면 아무것도 남기지 않는다(잡음 금지)', async () => {
    const src = stubSource(calls, snaps, { jpeg: readFileSync('test/fixtures/roiAutoGolden/frame_1_1_d0.jpg') });
    const out = (await roiAutoDetect(
      { source: 'simulator-1', camId: 1, view: 'current', expectedBays: 7, consensus: false },
      ctxOf(src),
    )) as { presets: Array<{ issues: string[] }> };
    expect(calls.filter((c) => c === 'getPtz')).toHaveLength(2); // 사후 확인은 했다.
    expect(out.presets[0].issues.join('\n')).not.toMatch(/되쓰기 전후/);
  }, 60_000);

  it('★ 기준 화각을 UI 로 주면 그것이 이긴다(파생값보다 우선)', async () => {
    const src = stubSource(calls, snaps, { ptz: { pan: 0, tilt: 10, zoom: 2 } });
    // f = (1920/2/tan(15°)) × 2 = 7165.5px. 파생값(1731.89×2=3463.8)과 확실히 다르다.
    await expect(
      roiAutoDetect(
        { source: 'simulator-1', camId: 1, view: 'current', expectedBays: 8, cameraSpec: { baseHfovDeg: 30 } },
        ctxOf(src),
      ),
    ).rejects.toThrow(/프레임 취득 실패/);
    expect(snaps[0].ptz).toEqual({ pan: 0, tilt: 10, zoom: 2 });
  });

  it('★ 현재뷰는 정본의 주차면을 읽지 않는다 — holdout 문구가 그것을 말한다', async () => {
    const src = stubSource(calls, snaps, { jpeg: await sharp({ create: { width: 1920, height: 1080, channels: 3, background: { r: 90, g: 90, b: 90 } } }).jpeg().toBuffer() });
    const out = (await roiAutoDetect(
      { source: 'simulator-1', camId: 1, view: 'current', expectedBays: 8, consensus: false },
      ctxOf(src),
    )) as { holdout: string };
    expect(out.holdout).toMatch(/정본의 주차면을 읽지 않는다/);
  }, 60_000);
});
