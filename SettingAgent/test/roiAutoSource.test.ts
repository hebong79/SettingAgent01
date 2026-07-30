// 17회차 — `roi.auto.*` 의 **검출 소스 일치**와 **제원 미상 명시적 거부**.
//
// 배경(마스터 실측 사고): 뷰어가 `real-camera-2` 를 보고 있는데 서버는 기동 시 고정된 기본 카메라
// (`simulator-1`)에서 프레임을 가져왔다 — **시뮬 프레임으로 계산한 사각형을 실카 화면 위에 그렸다.**
// 이 파일이 검증하는 것은 알고리즘이 아니라 **배선과 정직성**이다:
//   ⓐ source 미지정 = 기존 경로  ⓑ 지정 = 그 소스  ⓒ 없는 소스 = 에러
//   ⓓ 제원 없는 실카 = 거부(시뮬 폴백 안 함)  ⓔ usedSource 응답 포함

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { PRESETS } from '@parkagent/lens-calib';
import { focalPxOf, interpolateHfov } from '../src/ground/cameraIntrinsics.js';
import { readGroundSpec, roiAutoDetect, roiAutoScore } from '../src/rpc/services/roiAuto.js';
import { RpcMethodError } from '../src/rpc/errors.js';
import type { RpcContext } from '../src/rpc/types.js';
import type { CameraSource } from '../src/viewer/CameraSource.js';
import type { ICameraClient } from '../src/clients/CameraClient.js';

/** cam1:p1 1면. 검출은 프레임 취득 뒤 어차피 실패하지만, 이 테스트는 **어느 카메라를 불렀는가**만 본다. */
const PLACE = {
  cameras: [
    {
      camera: { cam_id: 1, imageWidth: 1920, imageHeight: 1080, position: [0, 4.95, 0], fov: 20.86546, eulerAngles: [17, 0, 0] },
      presets: [
        {
          preset_idx: 1,
          fov: 20.86546,
          eulerAngles: [17, 0, 0],
          parking_spaces: [{ idx: 1, points: [[100, 900], [120, 700], [400, 700], [420, 900]] }],
        },
      ],
    },
  ],
};

/** 어느 카메라가 불렸는지 기록만 하고 프레임은 주지 않는 시임(프레임 취득 실패 = UPSTREAM). */
function recordingCamera(tag: string, calls: string[]): ICameraClient {
  return {
    clampZoom: (z: number) => z,
    health: async () => true,
    requestImage: async () => {
      calls.push(tag);
      throw new Error('프레임 없음(테스트)');
    },
  } as unknown as ICameraClient;
}

/** `kind` 만 다른 최소 CameraSource 시임. snapshot 이 불리면 tag 를 기록한다. */
function fakeSource(kind: CameraSource['kind'], tag: string, calls: string[]): CameraSource {
  return {
    kind,
    listCameras: async () => ({ cameras: [] }),
    snapshot: async () => {
      calls.push(tag);
      throw new Error('프레임 없음(테스트)');
    },
    move: async () => true,
    toNativePtz: (p) => p,
    fromNativePtz: (n) => n as { pan: number; tilt: number; zoom: number },
  } as CameraSource;
}

const CAM_CFG = { zoomMin: 1, zoomMax: 36 } as NonNullable<RpcContext['deps']['cameraCfg']>;

describe('roi.auto.* 검출 소스 배선(17회차 P0)', () => {
  let dir: string;
  let file: string;
  let calls: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'roiauto-src-'));
    file = join(dir, 'PtzCamRoi.json');
    writeFileSync(file, JSON.stringify(PLACE, null, 2), 'utf8');
    calls = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const ctxOf = (extra: Partial<RpcContext['deps']> = {}): RpcContext =>
    ({
      app: {} as never,
      deps: {
        placeRoiFile: file,
        camera: recordingCamera('default', calls),
        cameraCfg: CAM_CFG,
        ...extra,
      },
    } as RpcContext);

  it('ⓐ source 미지정이면 기존 경로(deps.camera)를 그대로 쓴다', async () => {
    await expect(roiAutoDetect({ consensus: false }, ctxOf())).rejects.toThrow(/프레임 취득 실패/);
    expect(calls).toEqual(['default']);
  });

  it('ⓑ source 지정이면 그 소스로 찍는다 — 기본 카메라는 부르지 않는다', async () => {
    const sources = new Map<string, CameraSource>([['simulator-2', fakeSource('sim', 'sim2', calls)]]);
    await expect(roiAutoDetect({ consensus: false, source: 'simulator-2' }, ctxOf({ sources }))).rejects.toThrow(
      /프레임 취득 실패/,
    );
    expect(calls).toEqual(['sim2']);
    expect(calls).not.toContain('default');
  });

  it('ⓒ 없는 소스 id 는 INVALID_PARAMS 이고 아무 카메라도 부르지 않는다', async () => {
    const sources = new Map<string, CameraSource>([['simulator-2', fakeSource('sim', 'sim2', calls)]]);
    const err = await roiAutoDetect({ source: 'no-such-cam' }, ctxOf({ sources })).catch((e) => e);
    expect(err).toBeInstanceOf(RpcMethodError);
    expect((err as RpcMethodError).code).toBe(-32602);
    expect((err as RpcMethodError).message).toMatch(/source not found/);
    expect(calls).toEqual([]);
  });

  it('ⓔ 응답(및 거부 응답)에 실제로 사용한 소스가 실린다', async () => {
    // 제원 없는 실카 id(렌즈 실측표에 없는 이름) → 거부 응답에도 usedSource 가 실린다.
    const sources = new Map<string, CameraSource>([['real-camera-none', fakeSource('hucoms', 'realX', calls)]]);
    const out = (await roiAutoDetect({ source: 'real-camera-none' }, ctxOf({ sources }))) as {
      usedSource: { id: string; kind: string; requested: string | null };
    };
    expect(out.usedSource).toEqual({ id: 'real-camera-none', kind: 'hucoms', requested: 'real-camera-none' });
  });

  it('소스 미지정이어도 selectedCameraId 로 어느 카메라였는지 밝힌다', async () => {
    const sources = new Map<string, CameraSource>([['simulator-1', fakeSource('sim', 'sim1', calls)]]);
    // 기본 경로는 deps.camera 를 쓰고(회귀 0) id·kind 만 레지스트리에서 읽는다.
    await expect(
      roiAutoDetect({ consensus: false }, ctxOf({ sources, selectedCameraId: 'simulator-1' })),
    ).rejects.toThrow(/프레임 취득 실패/);
    expect(calls).toEqual(['default']);
  });
});

describe('실카 제원 미상 → 명시적 거부(17회차 P1) — 시뮬 값으로 대체하지 않는다', () => {
  let dir: string;
  let file: string;
  let calls: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'roiauto-real-'));
    file = join(dir, 'PtzCamRoi.json');
    writeFileSync(file, JSON.stringify(PLACE, null, 2), 'utf8');
    calls = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const realCtx = (): RpcContext =>
    ({
      app: {} as never,
      deps: {
        placeRoiFile: file,
        camera: recordingCamera('default', calls),
        cameraCfg: CAM_CFG,
        // ★ 렌즈 실측표에 **없는** id — 제원이 하나도 갖춰지지 않은 실카다.
        sources: new Map<string, CameraSource>([['real-camera-none', fakeSource('hucoms', 'realX', calls)]]),
      },
    } as RpcContext);

  it('ⓓ detect — 제원이 없으면 거부하고 **프레임조차 찍지 않는다**', async () => {
    const out = (await roiAutoDetect({ source: 'real-camera-none' }, realCtx())) as {
      rejected: boolean;
      graded: boolean;
      missing: string[];
      presets: unknown[];
    };
    expect(out.rejected).toBe(true);
    expect(out.graded).toBe(false);
    expect(out.presets).toEqual([]);
    expect(calls).toEqual([]); // 카메라를 부르지 않았다 = 실카를 건드리지 않았다.
    // 무엇이 없는지 말한다. 틸트는 여기 없다 — 프레임의 PTZ 피드백에서 오므로 촬영 전에는 알 수 없다.
    expect(out.missing.some((m) => m.includes('설치고'))).toBe(true);
    expect(out.missing.some((m) => m.includes('수평화각'))).toBe(true);
  });

  it('ⓓ score 도 같은 거부를 낸다(채점 수치를 지어내지 않는다)', async () => {
    const out = (await roiAutoScore({ source: 'real-camera-none' }, realCtx())) as { rejected: boolean; summary: null };
    expect(out.rejected).toBe(true);
    expect(out.summary).toBeNull();
    expect(calls).toEqual([]);
  });

  it('거부 사유에 시뮬 정본 폴백 금지가 명시된다', async () => {
    const out = (await roiAutoDetect({ source: 'real-camera-none' }, realCtx())) as { note: string };
    expect(out.note).toMatch(/PtzCamRoi\.json/);
    expect(out.note).toMatch(/대체하지 않는다/);
  });

  it('제원 3종을 모두 채우면 거부하지 않고 검출로 진행한다(프레임 취득까지 간다)', async () => {
    await expect(
      roiAutoDetect(
        { source: 'real-camera-none', consensus: false, cameraSpec: { heightM: 6.2, tiltDeg: 21, hfovDeg: 34.17 } },
        realCtx(),
      ),
    ).rejects.toThrow(/프레임 취득 실패/);
    expect(calls).toEqual(['realX']);
  });

  it('시뮬 소스는 종전대로 정본 메타로 검출을 진행한다(거부 없음)', async () => {
    const sources = new Map<string, CameraSource>([['simulator-2', fakeSource('sim', 'sim2', calls)]]);
    await expect(
      roiAutoDetect({ source: 'simulator-2', consensus: false }, {
        app: {} as never,
        deps: { placeRoiFile: file, camera: recordingCamera('default', calls), cameraCfg: CAM_CFG, sources },
      } as RpcContext),
    ).rejects.toThrow(/프레임 취득 실패/);
    expect(calls).toEqual(['sim2']);
  });
});

// ── 17b/17c회차 — 실카 제원(cam-001 실측표 상속 · 13m · PTZ 틸트)을 배선해 **검출이 돌게** 한다 ─────
//
// 17c 정정: 17b 는 화각을 광각단 사양값 58.5° **1점**으로 넣었는데, 실카는 zoompos 10677 로 줌인
// 상태라 초점거리가 4.6배 작았다. `real-camera-2` 는 `model:"cam-001"` 이고 그 프리셋의 13점 실측표를
// 상속하면 줌이 실제로 반영된다(근거: data/lens_calib_result_real-camera-2.json verdict:"pass").
describe('실카 제원 해석 배선(17b/17c회차)', () => {
  /** 마스터 실측: 설치고 약 13m. */
  const HEIGHT_M = 13;
  /** 네이티브 tiltpos(centidegree). 786 = 7.86° 하향 — 실장비 real-camera-2 의 현재 값 자리. */
  const TILT_POS = 786;
  /** 실장비 real-camera-2 의 현재 네이티브 zoompos. */
  const ZOOM_POS = 10677;
  /** cam-001 프리셋 13점 표를 zoompos 10677 로 선형보간한 값. §계산은 아래 ⓐ 테스트가 고정한다. */
  const HFOV_AT_ZOOM = 13.766950082281953;

  let dir: string;
  let file: string;
  let lensFile: string;
  let prevLens: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'roiauto-17b-'));
    file = join(dir, 'PtzCamRoi.json');
    writeFileSync(file, JSON.stringify(PLACE, null, 2), 'utf8');
    lensFile = join(dir, 'lens_calibration.json');
    // 정본 data/lens_calibration.json 의 real-camera-2 항목과 같은 모양 — 자체 화각표 없이 model 상속.
    writeFileSync(
      lensFile,
      JSON.stringify({
        cameras: [{ id: 'real-camera-2', model: 'cam-001', enabled: true, cameraSpec: { heightM: HEIGHT_M } }],
      }),
      'utf8',
    );
    prevLens = process.env.LENS_CALIB_FILE;
    process.env.LENS_CALIB_FILE = lensFile;
  });
  afterEach(() => {
    if (prevLens === undefined) delete process.env.LENS_CALIB_FILE;
    else process.env.LENS_CALIB_FILE = prevLens;
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * 회색 프레임 1장을 주는 실카 시임. 도색선이 없어 quad 는 나오지 않지만, 이 블록이 보는 것은
   * **어떤 제원으로 지면을 세웠는가**(focalPx·intrinsics.source·issues)라 그것으로 충분하다.
   *
   * `toNativePtz` 를 항등으로 두어 snapshot 이 돌려준 tilt/zoom 이 **그대로 네이티브 값**이 되게 한다
   * (실기 RealPtzSource 는 mapRange 왕복이며, 여기서는 원하는 tiltpos 를 직접 주입하는 것이 목적이다).
   */
  async function grayRealSource(imgW: number, imgH: number, zoomPos = ZOOM_POS): Promise<CameraSource> {
    const jpeg = await sharp({ create: { width: imgW, height: imgH, channels: 3, background: { r: 90, g: 90, b: 90 } } })
      .jpeg()
      .toBuffer();
    return {
      kind: 'hucoms',
      listCameras: async () => ({ cameras: [] }),
      snapshot: async () => ({ jpeg, ptz: { pan: 0, tilt: TILT_POS, zoom: zoomPos } }),
      move: async () => true,
      toNativePtz: (p) => p,
      fromNativePtz: (n) => n as { pan: number; tilt: number; zoom: number },
    } as CameraSource;
  }

  const ctxWith = async (imgW: number, imgH: number, zoomPos = ZOOM_POS): Promise<RpcContext> =>
    ({
      app: {} as never,
      deps: {
        placeRoiFile: file,
        camera: recordingCamera('default', []),
        cameraCfg: CAM_CFG,
        sources: new Map<string, CameraSource>([['real-camera-2', await grayRealSource(imgW, imgH, zoomPos)]]),
      },
    } as RpcContext);

  type DetectOut = {
    rejected?: boolean;
    presets: Array<{ imgW: number; intrinsics: { source: string | null; focalPx: number | null }; issues: string[] }>;
  };

  it('ⓐ model:cam-001 상속 화각표를 zoompos 10677 로 보간하면 13.77°', () => {
    const table = readGroundSpec(lensFile, 'real-camera-2').zoomHfov;
    expect(table).not.toBeNull();
    // 상속받은 표는 내장 프리셋 **그 객체의 내용**이다(복제본이 아니다).
    expect(table).toEqual(PRESETS['cam-001'].zoomHfov);
    // z10338(14.68°) ~ z12161(9.77°) 구간 선형보간.
    expect(interpolateHfov(table!, ZOOM_POS)!).toBeCloseTo(13.77, 2);
    expect(interpolateHfov(table!, ZOOM_POS)!).toBeCloseTo(HFOV_AT_ZOOM, 6);
  });

  it('ⓑ 광각단 z=0 은 57.14° — 마스터의 사양값 58.5° 와 같은 자리다(줌을 반영하지 않았을 뿐)', () => {
    const table = readGroundSpec(lensFile, 'real-camera-2').zoomHfov!;
    expect(interpolateHfov(table, 0)).toBe(57.14);
  });

  it('ⓒ 표 밖은 양 끝으로 클램프된다(z<0 · z>16384)', () => {
    const table = readGroundSpec(lensFile, 'real-camera-2').zoomHfov!;
    expect(interpolateHfov(table, -1)).toBe(57.14);
    expect(interpolateHfov(table, 65535)).toBe(2.39);
  });

  it('ⓓ 수평 13.77° · 1920px → f ≈ 7952px (17b 의 1714px 대비 4.64배)', () => {
    const f = focalPxOf({
      camIdx: 1, presetIdx: 1, fovDeg: HFOV_AT_ZOOM, fovAxis: 'horizontal', tiltDeg: 7.86, heightM: HEIGHT_M,
      imgW: 1920, imgH: 1080, source: 'test',
    });
    expect(f).not.toBeNull();
    expect(f!).toBeCloseTo(7952, 0);
    expect(f! / 1714.20335).toBeCloseTo(4.64, 2);
  });

  it('model 상속 화각표 + PTZ 틸트로 거부 없이 검출까지 간다', async () => {
    const out = (await roiAutoDetect({ source: 'real-camera-2', consensus: false }, await ctxWith(1920, 1080))) as DetectOut;
    expect(out.rejected).toBeUndefined();
    const p = out.presets[0];
    expect(p.intrinsics.focalPx).toBeCloseTo(7952, 0);
    // 제원의 출처가 응답에 그대로 실린다 — 표가 어디서 왔고 어느 줌으로 보간했는지.
    expect(p.intrinsics.source).toMatch(/zoomHfov@z=10677→13\.767°←model:cam-001 내장 실측표/);
    expect(p.intrinsics.source).toMatch(/PTZ tiltpos 786\/100/);
    expect(p.intrinsics.source).toMatch(/lens_calibration\.cameraSpec/);
    // tiltpos 786 → 7.86° 하향, 설치고 13m 이 지면모델 issue 에 찍힌다.
    expect(p.issues.join('\n')).toMatch(/tilt 7\.86°, 설치고 13m/);
  });

  it('★ 줌이 다르면 화각·초점거리가 실제로 달라진다(단일점 고정이 아니다)', async () => {
    const at = async (zoomPos: number) => {
      const out = (await roiAutoDetect({ source: 'real-camera-2', consensus: false }, await ctxWith(1920, 1080, zoomPos))) as DetectOut;
      return out.presets[0].intrinsics.focalPx!;
    };
    const wide = await at(0); // 57.14° → f 1755px 대
    const tele = await at(ZOOM_POS); // 13.77° → f 7952px 대
    expect(wide).toBeCloseTo(960 / Math.tan((57.14 * Math.PI) / 360), 3);
    expect(tele).toBeCloseTo(7952, 0);
    expect(tele / wide).toBeGreaterThan(4);
  });

  it('★ 표 안이면 경고 없음 · 표 밖이면 클램프 경고를 낸다', async () => {
    const inRange = (await roiAutoDetect({ source: 'real-camera-2', consensus: false }, await ctxWith(1920, 1080))) as DetectOut;
    const inIssues = inRange.presets[0].issues.join('\n');
    expect(inIssues).not.toMatch(/⚠/);
    // 틸트 규약은 확정 사실이라 ⚠ 가 아니지만, 쓴 값의 출처는 계속 노출한다.
    expect(inIssues).toMatch(/하향 틸트 7\.86° = 네이티브 tiltpos 786 ÷ 100/);
    expect(inIssues).toMatch(/실기 cam-001 실측으로 확정된 규약/);

    const out = (await roiAutoDetect({ source: 'real-camera-2', consensus: false }, await ctxWith(1920, 1080, 20000))) as DetectOut;
    const issues = out.presets[0].issues.join('\n');
    expect(issues).toMatch(/⚠ 네이티브 줌 20000 이 .* 실측표 범위 \[0, 16384\] 밖이라/);
    expect(issues).toMatch(/클램프.*2\.390°/);
  });

  it('ⓔ UI 입력(cameraSpec)이 파일·PTZ 자동해석보다 우선한다', async () => {
    const out = (await roiAutoDetect(
      { source: 'real-camera-2', consensus: false, cameraSpec: { hfovDeg: 30, tiltDeg: 21, heightM: 6.2 } },
      await ctxWith(1920, 1080),
    )) as DetectOut;
    const p = out.presets[0];
    // f = 960 / tan(15°) = 3582.77 — 상속표의 13.77° 였다면 7952 였다.
    expect(p.intrinsics.focalPx).toBeCloseTo(3582.77, 1);
    expect(p.intrinsics.source).toMatch(/hfov 30° 수동지정/);
    expect(p.intrinsics.source).toMatch(/tilt 21° 수동지정/);
    expect(p.intrinsics.source).toMatch(/설치고 6\.2m 수동지정/);
    const issues = p.issues.join('\n');
    // 자동값을 쓰지 않았으므로 **클램프 경고·틸트 출처 안내는 걸리지 않는다**.
    expect(issues).not.toMatch(/실측표 범위 .* 밖이라/);
    expect(issues).not.toMatch(/centidegree 단위와/);
    /**
     * ★ 21회차 D3 — 계약 변경: **수동 입력이 자동 해석값과 크게 다르면 경고한다**
     * (16-19회차 인계서 §0-1 미착수 항목. 마스터가 실카에서 정확히 이 함정을 밟았다 —
     *  「수평화각(유효)」에 광각단 58° 를 넣어 f 가 0.5676배로 어긋났고, 화면에는 아무 말도 없었다).
     * 규약은 그대로다(입력값이 이긴다 = 조용한 재해석 금지). **차이를 알리는 것**만 추가됐다.
     */
    expect(issues).toMatch(/⚠ 수평화각 수동 입력 30° 가 이 카메라의 실측표 자동값 13\.767°/);
    expect(issues).toMatch(/0\.4505배/);
    expect(issues).toMatch(/⚠ 틸트 수동 입력 21° 가 장비 피드백 자동값 7\.86°/);
    expect(issues).toMatch(/13\.1400° 다르다/);
    // 입력값이 이겼다는 사실은 두 경고 모두에 적혀 있어야 한다(사용자가 무엇이 쓰였는지 알아야 한다).
    expect(issues.match(/입력값으로 계산했다/g) ?? []).toHaveLength(2);
  });

  it('ⓕ 설치고가 없으면 제원 갖춰진 화각이 있어도 거부를 유지한다', async () => {
    writeFileSync(lensFile, JSON.stringify({ cameras: [{ id: 'real-camera-2', model: 'cam-001' }] }), 'utf8');
    const out = (await roiAutoDetect({ source: 'real-camera-2', consensus: false }, await ctxWith(1920, 1080))) as {
      rejected: boolean;
      missing: string[];
    };
    expect(out.rejected).toBe(true);
    expect(out.missing.some((m) => m.includes('설치고'))).toBe(true);
    expect(out.missing.some((m) => m.includes('수평화각'))).toBe(false);
  });

  it('expectedBays 를 주면 그 값이 정본 면수(실카는 0)를 대신한다', async () => {
    // 실카에는 수동 정본이 없어 서버 기본값이 0 → max(1,0)=1 면. 입력이 그 자리를 채운다.
    const out = (await roiAutoDetect(
      { source: 'real-camera-2', consensus: false, camId: 1, presetIdx: 1, expectedBays: 10 },
      await ctxWith(1920, 1080),
    )) as DetectOut;
    expect(out.rejected).toBeUndefined();
    expect(out.presets).toHaveLength(1);
  });
});
