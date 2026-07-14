// ★ 통합 경로 봉인 — estimateGroundModels 가 **실제로 f 공동추정을 사용하는가**.
//
// 왜 이 파일이 필요한가(검증자 뮤테이션 검사에서 드러난 빈틈):
//   groundModelRoundTrip.test.ts 의 공동추정 테스트는 poolFovBaseV/focalFromVPs/focalFromZoom 을
//   **직접** 호출한다 — 즉 *함수가 동작함* 은 증명하지만 *프로덕션 진입점이 그것을 쓴다* 는 증명하지 않는다.
//   유일하게 estimateGroundModels 를 부르는 테스트는 **σ=0(무노이즈)** 이라 단독 f ≈ 공동추정 f 로 구별되지 않는다.
//
//   실제로 estimateGroundModels 의 `f = focalFromZoom(preset.zoom, pooled.fovBaseV, ...)` 를
//   `f = fSolo`(프리셋 단독 추정)로 바꾸는 뮤테이션을 가했더니 **전 테스트가 그대로 통과**했다.
//   → 설계 §4-4 의 핵심 결정(R1: 얕은 tilt 프리셋에서 f 가 조용히 20~35% 틀림)이 무방비로 되돌아갈 수 있었다.
//
// 이 파일은 두 각도에서 못 박는다:
//   (a) 구조적: 모든 프리셋의 f 가 **하나의 fovBaseV** 에서 fovV(zoom) 로 유도된 값과 일치하는가(무노이즈·결정적).
//   (b) 통계적: σ=2px 노이즈에서 **최악 조건수 프리셋의 f 오차**가 단독추정 대비 실질 개선되는가.
//       실측(통합 경로, 200시행): preset1 단독 20.2% → 공동추정 3.8% (약 5배 개선).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { estimateGroundVPs, focalFromVPs, focalFromZoom, estimateGroundModels } from '../src/ground/groundModel.js';
import { buildGroundInputs } from '../src/ground/groundInputs.js';
import { parseCameraViews } from '../src/setup/mapTargets.js';
import { fovV } from '../src/calibrate/detectMath.js';
import type { GroundCameraInput, GroundOptions, PixelQuad } from '../src/ground/types.js';

const DEG = Math.PI / 180;
const IMG_W = 1920;
const IMG_H = 1080;
const OPTS: GroundOptions = { minDepthEdgePx: 250, slotWidthM: 2.5, slotDepthM: 5.0 };
type V3 = [number, number, number];

interface CamSpec {
  fovBaseV: number;
  zoom: number;
  tiltDeg: number;
  camHeightM: number;
  yawDeg: number;
  anchorV: number;
  slots: number;
}
const BASE: CamSpec = {
  fovBaseV: 33.1666,
  zoom: 1.6,
  tiltDeg: 6.8,
  camHeightM: 5,
  yawDeg: 25,
  anchorV: 842,
  slots: 7,
};
/** 실데이터 Place01 3프리셋 모사(zoom/tilt/면수). preset 1 이 조건수 최악(얕은 tilt). */
const SPECS: CamSpec[] = [
  { ...BASE, zoom: 1.6, tiltDeg: 6.8, yawDeg: 25, slots: 7 },
  { ...BASE, zoom: 1.9, tiltDeg: 7.4, yawDeg: 40, slots: 6 },
  { ...BASE, zoom: 1.4, tiltDeg: 18.8, yawDeg: 30, slots: 4 },
];

const focalOf = (s: CamSpec) =>
  IMG_H / 2 / Math.tan((fovV(s.zoom, { fovBaseV: s.fovBaseV, zoomRef: 1, aspect: IMG_W / IMG_H }) * DEG) / 2);

/** 합성 카메라 → 정답 이미지 4점. 점 규약 p0=근좌, p1=원좌, p2=원우, p3=근우. */
function synthQuads(spec: CamSpec): PixelQuad[] {
  const f = focalOf(spec);
  const cx = IMG_W / 2;
  const cy = IMG_H / 2;
  const th = spec.tiltDeg * DEG;
  const n: V3 = [0, Math.cos(th), Math.sin(th)];
  const w0: V3 = [1, 0, 0];
  const d0: V3 = [0, -Math.sin(th), Math.cos(th)];
  const c = Math.cos(spec.yawDeg * DEG);
  const s = Math.sin(spec.yawDeg * DEG);
  const eW: V3 = [w0[0] * c - d0[0] * s, w0[1] * c - d0[1] * s, w0[2] * c - d0[2] * s];
  const eD: V3 = [d0[0] * c + w0[0] * s, d0[1] * c + w0[1] * s, d0[2] * c + w0[2] * s];
  const m: V3 = [0, (spec.anchorV - cy) / f, 1];
  const nm = n[0] * m[0] + n[1] * m[1] + n[2] * m[2];
  const A: V3 = [
    (spec.camHeightM * m[0]) / nm,
    (spec.camHeightM * m[1]) / nm,
    (spec.camHeightM * m[2]) / nm,
  ];
  const add = (a: V3, b: V3, k: number): V3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
  const proj = (X: V3) => ({ x: (f * X[0]) / X[2] + cx, y: (f * X[1]) / X[2] + cy });
  const quads: PixelQuad[] = [];
  for (let i = 0; i < spec.slots; i++) {
    const p0 = add(A, eW, (i - spec.slots / 2) * 2.5);
    const p1 = add(p0, eD, 5.0);
    const p2 = add(p1, eW, 2.5);
    const p3 = add(p0, eW, 2.5);
    quads.push([proj(p0), proj(p1), proj(p2), proj(p3)]);
  }
  return quads;
}

/** 결정형 PRNG — 노이즈 시행을 재현 가능하게 고정(flaky 금지). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const jitter = (quads: PixelQuad[], sigma: number, r: () => number): PixelQuad[] => {
  const g = () => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r()) * sigma;
  return quads.map((q) => q.map((p) => ({ x: p.x + g(), y: p.y + g() })) as PixelQuad);
};

const camOf = (quadsPerPreset: PixelQuad[][]): GroundCameraInput => ({
  camIdx: 1,
  imgW: IMG_W,
  imgH: IMG_H,
  presets: SPECS.map((s, i) => ({
    camIdx: 1,
    presetIdx: i + 1,
    zoom: s.zoom,
    tilt: s.tiltDeg,
    pan: null, // 합성 기하 — 슬롯 방위(수직축 회전) 검사 대상 아님. GroundPresetInput 신규 필수 필드(developer).
    quads: quadsPerPreset[i],
  })),
});

// 구조적 봉인은 **실데이터 픽스처**로 한다.
//   무노이즈 합성데이터는 단일 fovBaseV 에서 생성되므로 단독 f 와 공동추정 f 가 **완전히 일치**한다
//   (검증자가 실제로 확인: 합성 σ=0 에서 두 경로 차이 < 1e-6). 그래서 합성 σ=0 으로는 이 봉인이 공허해진다
//   — 기존 estimateGroundModels 테스트가 M6 뮤테이션을 놓친 이유가 정확히 이것이다.
//   실데이터는 소실점이 서로 완벽히 정합하지 않아 단독 f 와 공동추정 f 가 벌어진다(preset1 기준 ~3%).
describe('★ estimateGroundModels 는 f 공동추정을 실제로 사용한다(구조적 봉인 · 실데이터)', () => {
  const placeRoi = JSON.parse(readFileSync('test/fixtures/PtzCamRoi.unity.json', 'utf8'));
  const views = parseCameraViews(JSON.parse(readFileSync('test/fixtures/camerapos.sample.json', 'utf8')));
  const cam = buildGroundInputs(placeRoi, views)[0];

  it('프리셋 단독 f 와 공동추정 f 는 실제로 다르다(아래 봉인이 공허하지 않음을 보장)', () => {
    const { models } = estimateGroundModels(cam, OPTS);
    let differs = 0;
    for (const p of cam.presets) {
      const vps = estimateGroundVPs(p.quads);
      const fSolo = vps ? focalFromVPs(vps.v1, vps.v2, cam.imgW / 2, cam.imgH / 2) : null;
      const m = models.find((mm) => mm.presetIdx === p.presetIdx);
      if (!m || fSolo == null) continue;
      if (Math.abs(fSolo - m.f) / m.f > 1e-3) differs += 1;
    }
    expect(differs).toBeGreaterThan(0); // 두 경로가 구별 가능해야 봉인이 의미를 가진다.
  });

  it('모든 프리셋의 f 가 **단일 fovBaseV** 에서 fovV(zoom) 로 유도된 값과 일치한다', () => {
    const { models, fovBaseV } = estimateGroundModels(cam, OPTS);
    expect(models.length).toBeGreaterThan(0);
    expect(fovBaseV).not.toBeNull();

    for (const m of models) {
      const derived = focalFromZoom(m.zoom, fovBaseV!, cam.imgW, cam.imgH)!;
      // f 는 프리셋별 독립 추정치가 아니라 **공동추정 fovBaseV 의 유도값**이어야 한다.
      // (프리셋 단독 f 로 바꾸는 뮤테이션을 가하면 이 단언이 깨진다 — 그것이 이 테스트의 존재 이유.)
      expect(Math.abs(m.f - derived) / derived).toBeLessThan(1e-9);
    }
  });
});

describe('★ 공동추정의 실효 — 노이즈 하에서 최악 조건수 프리셋을 구제한다(설계 §4-4 / R1)', () => {
  it('σ=2px: preset 1(얕은 tilt) f 오차가 단독추정 대비 절반 이하이며 8% 미만이다', () => {
    const TRIALS = 100;
    const SIGMA = 2;
    const r = rng(20260714);
    let soloSq = 0;
    let poolSq = 0;

    for (let t = 0; t < TRIALS; t++) {
      const noisy = SPECS.map((s) => jitter(synthQuads(s), SIGMA, r));

      // 단독추정(= 공동추정을 제거했을 때의 상태).
      const vps = estimateGroundVPs(noisy[0]);
      const fSolo = vps ? focalFromVPs(vps.v1, vps.v2, IMG_W / 2, IMG_H / 2) : null;
      const fTrue = focalOf(SPECS[0]);
      const eSolo = fSolo == null ? 1 : (fSolo - fTrue) / fTrue;
      soloSq += eSolo * eSolo;

      // 프로덕션 경로.
      const m = estimateGroundModels(camOf(noisy), OPTS).models.find((mm) => mm.presetIdx === 1);
      const ePool = !m ? 1 : (m.f - fTrue) / fTrue;
      poolSq += ePool * ePool;
    }
    const soloRms = Math.sqrt(soloSq / TRIALS);
    const poolRms = Math.sqrt(poolSq / TRIALS);
    console.log(
      `\n[통합 경로 σ=2px · ${TRIALS}시행] preset1 f 오차 RMS: 단독 ${(soloRms * 100).toFixed(1)}% → 공동추정 ${(poolRms * 100).toFixed(1)}%`,
    );

    expect(poolRms).toBeLessThan(0.08); // 공동추정 실측 ~3.8%. 단독(~20%)이면 반드시 실패한다.
    expect(poolRms).toBeLessThan(soloRms / 2); // 최악 프리셋에서 2배 이상 개선.
  });
});
