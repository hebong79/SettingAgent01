import { describe, expect, it } from 'vitest';
import { CalibrationRunner } from '../src/runner.js';
import { CalibrationSolver } from '../src/solver.js';
import { FrameMatcher } from '../src/frameMatch.js';
import { CameraCalibration } from '../src/calibration.js';
import { ClickCentering } from '../src/centering.js';
import { MockHucomsCamera, TRUE_DISTORTION, TRUE_GAIN, TRUE_HFOV } from '../mock/mockCamera.js';

// ★ 이것이 **진짜** end-to-end 다.
//   목 카메라는 모델을 **역방향으로** 쓴다(픽셀 → 펴서 → 광선 → 텍스처). 솔버는 정방향으로
//   쓴다(픽셀 → 펴서 → 회전 → 눌러서 → 픽셀). 그 사이에 ZNCC 매칭이라는 완전히 다른 종류의
//   연산이 끼어 있다. 그래서 여기서 정답이 복원되면 "같은 식을 두 번 쓴 것"이 아니다.

const RENDER = { width: 384, height: 216 };

/** 렌더가 384x216 이므로 매칭 파라미터도 그 스케일로 줄인다(실제 이미지 픽셀 기준이다). */
function smallMatcher(): FrameMatcher {
  return new FrameMatcher({ frameWidth: 1920, frameHeight: 1080, half: 20, search: 40, step: 2, pad: 10 });
}

function makeRunner(camera: MockHucomsCamera, calibration: unknown): CalibrationRunner {
  return new CalibrationRunner({
    camera,
    calibration: calibration as never,
    matcher: smallMatcher(),
    solver: new CalibrationSolver(),
    sleep: async () => {},
  });
}

describe('runDistortion — 광류 격자로 곡면율 복원 (end-to-end)', () => {
  it(
    '★주입한 정답 k1 을 되찾고, 부호는 배럴(k1<0)이다',
    async () => {
      const camera = new MockHucomsCamera({ ...RENDER });
      // 실제 절차와 같은 순서: 화각·게인을 먼저 알고(클릭 스윕) 그 다음 곡면율을 잰다.
      const runner = makeRunner(camera, { zoomHfov: TRUE_HFOV, centeringGain: TRUE_GAIN });

      const r = await runner.runDistortion({ zooms: [0] });

      expect(r.of).toBeGreaterThanOrEqual(24);
      expect(r.usable / r.of).toBeGreaterThan(0.8); // 장면이 협조했다
      const p = r.points.find((x) => x.z === 0)!;
      expect(p).toBeDefined();
      expect(p.adopted).toBe(true);
      expect(p.k1).toBeLessThan(0); // ★ 배럴 — 설계서 §3 의 1차 게이트
      const truthK1 = TRUE_DISTORTION[0]!.k1;
      expect(Math.abs(p.k1 - truthK1) / Math.abs(truthK1)).toBeLessThan(0.2);
      expect(p.rms1Px!).toBeLessThan(p.rms0Px!);
    },
    { timeout: 60_000 },
  );

  it(
    '★스윕이 끝나면 카메라를 찾았던 자리에 돌려놓는다',
    async () => {
      const home = { panpos: 4500, tiltpos: 1200, zoompos: 0 };
      const camera = new MockHucomsCamera({ ...RENDER, ptz: { ...home } });
      const runner = makeRunner(camera, { zoomHfov: TRUE_HFOV });
      await runner.runDistortion({ zooms: [0] });
      expect(await camera.getPtz()).toEqual(home);
    },
    { timeout: 60_000 },
  );

  it(
    '★중단해도 카메라를 돌려놓는다',
    async () => {
      const home = { panpos: 4500, tiltpos: 1200, zoompos: 0 };
      const camera = new MockHucomsCamera({ ...RENDER, ptz: { ...home } });
      const runner = makeRunner(camera, { zoomHfov: TRUE_HFOV });
      const ac = new AbortController();
      ac.abort();
      await expect(runner.runDistortion({ zooms: [0], signal: ac.signal })).rejects.toThrow(/중지/);
      expect(await camera.getPtz()).toEqual(home);
    },
    { timeout: 30_000 },
  );

  it(
    '★왜곡이 없는 렌즈에서는 표를 만들지 않는다 (없는 것을 발명하지 않는다)',
    async () => {
      const camera = new MockHucomsCamera({ ...RENDER, trueDistortion: null });
      const runner = makeRunner(camera, { zoomHfov: TRUE_HFOV, centeringGain: TRUE_GAIN });
      const r = await runner.runDistortion({ zooms: [0] });
      const p = r.points.find((x) => x.z === 0)!;
      expect(p.adopted).toBe(false);
      expect(p.k1).toBe(0);
    },
    { timeout: 60_000 },
  );
});

describe('verifyDistortion — A/B 자가 판정', () => {
  it(
    '★맞는 표는 adopt, 틀린 표는 스스로 reject 한다',
    async () => {
      const camera = new MockHucomsCamera({ ...RENDER });
      const runner = makeRunner(camera, { zoomHfov: TRUE_HFOV, centeringGain: TRUE_GAIN });
      const r = await runner.runDistortion({ zooms: [0] });

      const good = runner.verifyDistortion(r.samples, r.points);
      expect(good.verdict).toBe('pass');
      expect(good.recommendation).toBe('adopt');
      expect(good.perZoom[0]!.rmsOnPx).toBeLessThan(good.perZoom[0]!.rmsOffPx);

      // 부호를 뒤집은(핀쿠션) 표 — 2026-07-21 이 손으로 걸러낸 바로 그 실패 양상.
      const wrong = r.points.map((p) => ({ ...p, k1: -p.k1, k2: -(p.k2 ?? 0) }));
      const bad = runner.verifyDistortion(r.samples, wrong);
      expect(bad.recommendation).toBe('reject');
      expect(bad.reason).toMatch(/나빠졌습니다/);
    },
    { timeout: 60_000 },
  );
});

describe('클릭 스윕 (참조본 계승 경로)', () => {
  it(
    '★화각·게인을 되찾는다',
    async () => {
      const camera = new MockHucomsCamera({ ...RENDER });
      const runner = new CalibrationRunner({
        camera,
        calibration: null,
        matcher: smallMatcher(),
        sleep: async () => {},
        grid: { zooms: [0, 5129, 8000], dx: [-480, 480], dy: [-300, 300] },
      });
      const r = (await runner.run({ mode: 'full' })) as Awaited<ReturnType<CalibrationRunner['run']>> & { calibration: CameraCalibration };

      for (const truth of TRUE_HFOV) {
        expect(r.calibration.hfovAt(truth.z)).toBeCloseTo(truth.h, 0);
      }
      for (const truth of TRUE_GAIN) {
        expect(Math.abs(r.calibration.gainAt(truth.z) - truth.k)).toBeLessThan(0.04);
      }
    },
    { timeout: 120_000 },
  );
});

describe('ClickCentering — 보정이 실제로 조준을 개선한다', () => {
  it('★무보정 → 게인 → 게인+곡면율 순으로 잔차가 줄어든다', async () => {
    const truthSpec = { zoomHfov: TRUE_HFOV, centeringGain: TRUE_GAIN, lensDistortion: TRUE_DISTORTION };
    const click = { x: 1700, y: 900 };
    // ★ z5129 에서 잰다. z0 는 정답 게인이 정확히 1.0 이라 "게인 보정"이 항등이 되어
    //   무보정과 구별되지 않는다 — 세 단계를 비교하려면 게인이 1 에서 떨어진 줌이어야 한다.
    const zoompos = 5129;

    const residualWith = async (calibration: unknown, rawAim = false): Promise<number> => {
      const camera = new MockHucomsCamera({ width: 32, height: 18, ptz: { panpos: 4500, tiltpos: 1200, zoompos } }); // 렌더 불필요(기하만 쓴다)
      const before = await camera.getPtz();
      const cc = new ClickCentering({ camera, calibration: calibration as never });
      await cc.click({ ...click, rawAim });
      return camera.residualOf({ clickX: click.x, clickY: click.y, before }).distance;
    };

    const none = await residualWith(null, true); // 보정 완전 우회
    const gainOnly = await residualWith({ zoomHfov: TRUE_HFOV, centeringGain: TRUE_GAIN });
    const full = await residualWith(truthSpec);

    // 게인이 지배적인 오차(편심 비례)를 걷어낸다 — 수십 px 규모.
    expect(none).toBeGreaterThan(30);
    expect(gainOnly).toBeLessThan(none / 10);
    // 남은 것이 곡면율(편심 3승). 작지만 실재하고, 게인으로는 원리적으로 못 잡는다.
    expect(full).toBeLessThan(gainOnly);
    expect(gainOnly - full).toBeGreaterThan(0.4);
    expect(full).toBeLessThan(1); // 정답 표를 다 알면 사실상 정확히 맞는다
  });

  it('표가 없으면 클릭 좌표를 그대로 보낸다 (회귀 고정)', async () => {
    const camera = new MockHucomsCamera({ width: 32, height: 18 });
    const sent: Array<{ x: number; y: number }> = [];
    const spy = {
      getPtz: () => camera.getPtz(),
      setCenter: async (p: { x: number; y: number }) => {
        sent.push({ x: p.x, y: p.y });
      },
    };
    const cc = new ClickCentering({ camera: spy, calibration: null });
    await cc.click({ x: 1700, y: 900 });
    expect(sent[0]).toEqual({ x: 1700, y: 900 });
  });
});
