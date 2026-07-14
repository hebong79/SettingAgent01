// ROI 정합(평행이동) 민감도 — 리더 검증에서 드러난 빈틈을 CI 로 봉인한다.
//
// 근거가 된 사건: 자동보정이 data/Place01 의 preset 1 ROI 를 +105px 이동시켰는데
// f/tilt 수치는 만점이었고, 렌더에서만 ROI 가 흰 주차선과 어긋나 보였다.
//
// 실측 결론 — **정합 지표는 두 개가 필요하다. 축마다 다른 지표가 민감하다.**
//
//   | ROI 어긋남 | f      | tilt(추정)     | metricErr        | tiltErrDeg(=추정−PTZ) |
//   |-----------|--------|---------------|------------------|----------------------|
//   | 가로 ±200px| 0.7% ✗ | 0.05° ✗       | 0.2→2.7% **✓**   | 0.05° ✗              |
//   | 세로 ±200px| ~0   ✗ | 6.84→2.94° (!)| 0.19→0.38% **✗** | 3.9° **✓**           |
//
//   - 가로 어긋남 → **metricErr** 만 잡는다(주점=중심 가정상 평행이동된 ROI 는 어떤 카메라로도 직사각형의 상이 될 수 없다).
//   - 세로 어긋남 → 오차가 **tilt 로 흡수**되어 metricErr 는 눈이 먼다. **카메라 PTZ tilt 와 대조**해야만 드러난다.
//   - f 는 두 축 모두에 둔감하다 → **f 오차 0.5% 는 ROI 정합에 대해 아무것도 말해주지 않는다.**
//
// 이 파일은 위 표를 전부 테스트로 봉인한다(한계도, 검출력도).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { estimateGroundModels } from '../src/ground/groundModel.js';
import { buildGroundInputs } from '../src/ground/groundInputs.js';
import { parseCameraViews } from '../src/setup/mapTargets.js';
import type { GroundCameraInput, GroundOptions, PixelQuad } from '../src/ground/types.js';

const OPTS: GroundOptions = { minDepthEdgePx: 250, slotWidthM: 2.5, slotDepthM: 5.0 };

const placeRoi = JSON.parse(readFileSync('test/fixtures/PtzCamRoi.unity.json', 'utf8'));
const views = parseCameraViews(JSON.parse(readFileSync('test/fixtures/camerapos.sample.json', 'utf8')));
const baseCam = buildGroundInputs(placeRoi, views)[0];

/** preset 1 의 ROI 만 (dx,dy) 평행이동한 입력(런타임 파일에서 실제로 일어난 일의 재현). */
function shiftPreset1(dx: number, dy = 0): GroundCameraInput {
  return {
    ...baseCam,
    presets: baseCam.presets.map((p) =>
      p.presetIdx === 1
        ? { ...p, quads: p.quads.map((q) => q.map((pt) => ({ x: pt.x + dx, y: pt.y + dy })) as PixelQuad) }
        : p,
    ),
  };
}
const model1 = (dx: number, dy = 0) =>
  estimateGroundModels(shiftPreset1(dx, dy), OPTS).models.find((m) => m.presetIdx === 1)!;

describe('★ 한계 봉인 — f/tilt 는 ROI 정합을 보장하지 않는다', () => {
  it('ROI 를 ±200px 평행이동해도 f·tilt·카메라고는 거의 변하지 않는다(= 정합 오류를 못 잡는다)', () => {
    const base = model1(0);
    const rows: string[] = [];
    for (const dx of [-200, -105, -50, 50, 105, 200]) {
      const m = model1(dx);
      const fPct = (Math.abs(m.f - base.f) / base.f) * 100;
      const tiltDeg = Math.abs(m.tiltDeg - base.tiltDeg);
      const dPct = (Math.abs(m.d - base.d) / base.d) * 100;
      rows.push(
        `dx=${String(dx).padStart(5)}px | Δf ${fPct.toFixed(2)}% | Δtilt ${tiltDeg.toFixed(3)}° | Δd ${dPct.toFixed(2)}% | metricErr ${(m.metricErr * 100).toFixed(2)}%`,
      );
      // ↓ 이 단언들이 '통과'한다는 것은 f/tilt/d 가 정합 오류에 **눈이 멀었다**는 뜻이다(의도된 봉인).
      expect(fPct).toBeLessThan(1.0);
      expect(tiltDeg).toBeLessThan(0.1);
      expect(dPct).toBeLessThan(1.0);
    }
    console.log('\n[ROI 평행이동 민감도 — f/tilt 는 둔감, metricErr 만 민감]\n' + rows.join('\n'));
  });
});

describe('metricErr — 유일한 평행이동 민감 지표', () => {
  it('평행이동량에 단조 증가한다(양방향)', () => {
    const at = (dx: number) => model1(dx).metricErr;
    expect(at(0)).toBeLessThan(at(50));
    expect(at(50)).toBeLessThan(at(105));
    expect(at(105)).toBeLessThan(at(200));
    expect(at(0)).toBeLessThan(at(-50));
    expect(at(-50)).toBeLessThan(at(-105));
    expect(at(-105)).toBeLessThan(at(-200));
  });

  it('정합된 ROI(Unity 원형) → 잔차 < 0.8% 임계, 정합 advisory 없음', () => {
    for (const m of estimateGroundModels(baseCam, OPTS).models) {
      expect(m.metricErr).toBeLessThan(0.008);
      expect(m.issues.join()).not.toContain('가로 정합 의심');
    }
  });

  it('★ 실제로 벌어진 +105px 자동보정 이동 → 잔차 급증 + ROI 정합 advisory 발화', () => {
    const m = model1(105);
    expect(m.metricErr).toBeGreaterThan(0.008); // 임계 초과.
    expect(m.metricErr).toBeGreaterThan(model1(0).metricErr * 5); // 정상 대비 5배 이상.
    expect(m.issues.join()).toContain('가로 정합 의심');
    // 같은 상황에서 f/tilt 는 여전히 GT 와 일치한다 — 그래서 이 지표가 필요하다.
    expect(Math.abs(m.f - model1(0).f) / model1(0).f).toBeLessThan(0.01);
  });

  it('★ 한계: metricErr 는 **세로** 어긋남에 눈이 멀었다(세로 오차는 tilt 로 흡수된다)', () => {
    // dy=+200px 을 줘도 metricErr 는 0.4% 미만 — 가로 임계(0.8%)에도 못 미친다. 이것이 metricErr 의 사각지대다.
    const m = model1(0, 200);
    expect(m.metricErr).toBeLessThan(0.008); // ← metricErr 만으로는 못 잡는다(의도된 봉인).
  });
});

describe('tiltErrDeg — 세로 평행이동 검출(PTZ tilt 대조)', () => {
  it('세로 어긋남은 tilt 로 흡수된다 — 추정 tilt 가 PTZ tilt 에서 크게 벗어난다', () => {
    const rows: string[] = [];
    for (const dy of [-200, -100, 0, 100, 200]) {
      const m = model1(0, dy);
      rows.push(
        `dy=${String(dy).padStart(5)}px | tilt ${m.tiltDeg.toFixed(2)}° (PTZ ${m.ptzTiltDeg}°, 오차 ${m.tiltErrDeg!.toFixed(2)}°)` +
          ` | metricErr ${(m.metricErr * 100).toFixed(2)}%  ← metricErr 는 눈이 멀었다`,
      );
    }
    console.log('\n[세로 정합 — tiltErrDeg 만 민감]\n' + rows.join('\n'));
    expect(Math.abs(model1(0, 200).tiltErrDeg!)).toBeGreaterThan(3); // 200px → 3° 이상.
    expect(Math.abs(model1(0, -200).tiltErrDeg!)).toBeGreaterThan(3);
  });

  it('정합된 ROI → |tiltErrDeg| < 1° 임계, 세로 advisory 없음', () => {
    for (const m of estimateGroundModels(baseCam, OPTS).models) {
      expect(m.ptzTiltDeg).not.toBeNull();
      expect(Math.abs(m.tiltErrDeg!)).toBeLessThan(1.0);
      expect(m.issues.join()).not.toContain('세로 정합 의심');
    }
  });

  it('★ 세로 +150px 어긋남 → 세로 정합 advisory 발화(가로 지표는 침묵)', () => {
    const m = model1(0, 150);
    expect(Math.abs(m.tiltErrDeg!)).toBeGreaterThan(1.0);
    expect(m.issues.join()).toContain('세로 정합 의심');
    expect(m.issues.join()).not.toContain('가로 정합 의심'); // 상보성 확인.
  });

  it('PTZ tilt 미상(camerapos 없음) → tiltErrDeg=null, advisory 없음(강등, throw 없음)', () => {
    const noPtz: GroundCameraInput = {
      ...baseCam,
      presets: baseCam.presets.map((p) => ({ ...p, tilt: null })),
    };
    for (const m of estimateGroundModels(noPtz, OPTS).models) {
      expect(m.ptzTiltDeg).toBeNull();
      expect(m.tiltErrDeg).toBeNull();
      expect(m.issues.join()).not.toContain('세로 정합');
    }
  });
});
