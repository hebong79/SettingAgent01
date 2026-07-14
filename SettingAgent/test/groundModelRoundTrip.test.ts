// 지면모델 왕복(round-trip) 검증 — "그럴듯하게 틀린" 구현을 잡는 유일한 방법(설계 §8).
// 알려진 K/R/t 로 합성 카메라를 만들어 정답 이미지점을 생성 → 이미지점만으로 추정 → K/R/t 복원 여부를 본다.
// 추정 경로는 Unity camera 블록(position/eulerAngles/fov)을 일절 쓰지 않는다(실카메라 호환, 설계 C3).

import { describe, it, expect } from 'vitest';
import {
  estimateGroundVPs,
  focalFromVPs,
  focalFromZoom,
  poolFovBaseV,
  buildGroundPlane,
  estimateGroundModels,
  isUsableQuad,
} from '../src/ground/groundModel.js';
import { fovV } from '../src/calibrate/detectMath.js';
import type { GroundCameraInput, GroundOptions, PixelQuad } from '../src/ground/types.js';

const DEG = Math.PI / 180;
const IMG_W = 1920;
const IMG_H = 1080;
const OPTS: GroundOptions = { minDepthEdgePx: 250, slotWidthM: 2.5, slotDepthM: 5.0 };

type Vec3 = [number, number, number];

/** 합성 카메라 사양(실데이터 Place01 과 같은 배치: 카메라고 5m, 망원, 얕은~중간 tilt). */
interface CamSpec {
  fovBaseV: number;
  zoom: number;
  tiltDeg: number;
  camHeightM: number;
  /**
   * 카메라 광축과 주차면 스트립이 이루는 수평각(도). 0 이면 폭변이 이미지에서 평행해져
   * 폭 소실점이 무한원이 되고 f 를 유도할 수 없다 — 실카메라(pan 20~57°)는 항상 0 이 아니다.
   */
  yawDeg: number;
  /** 주차면 스트립의 근변이 놓일 이미지 v 좌표(원근 배율 = 실제 데이터 재현). */
  anchorV: number;
  slots: number;
  widthM: number;
  depthM: number;
}

const BASE: CamSpec = {
  fovBaseV: 33.1666, // Unity GT(설계 §1-4): camera.fov=24.01697 @ zoom=1.4 에서 역산.
  zoom: 1.6,
  tiltDeg: 6.8,
  camHeightM: 5,
  yawDeg: 25,
  anchorV: 842,
  slots: 7,
  widthM: 2.5,
  depthM: 5.0,
};

function focalOf(spec: CamSpec): number {
  const deg = fovV(spec.zoom, { fovBaseV: spec.fovBaseV, zoomRef: 1, aspect: IMG_W / IMG_H });
  return IMG_H / 2 / Math.tan((deg * DEG) / 2);
}

/** 합성 카메라 → 정답 이미지 4점(quad) 배열. 점 규약: p0=근좌, p1=원좌, p2=원우, p3=근우. */
function synthQuads(spec: CamSpec): { quads: PixelQuad[]; f: number; n: Vec3 } {
  const f = focalOf(spec);
  const cx = IMG_W / 2;
  const cy = IMG_H / 2;
  const th = spec.tiltDeg * DEG;
  const n: Vec3 = [0, Math.cos(th), Math.sin(th)]; // 월드 '아래' 를 카메라 좌표로 표현(=지면 하향법선).
  const w0: Vec3 = [1, 0, 0]; // yaw=0 기준 지면 폭 방향(면 진행).
  const d0: Vec3 = [0, -Math.sin(th), Math.cos(th)]; // yaw=0 기준 지면 깊이 방향(근→원). 둘 다 n 에 직교.
  // 수직축 n 둘레 yaw 회전(면내 회전 — 두 방향 모두 지면에 남는다). n×w0=−d0, n×d0=w0.
  const cy0 = Math.cos(spec.yawDeg * DEG);
  const sy0 = Math.sin(spec.yawDeg * DEG);
  const eW: Vec3 = [w0[0] * cy0 - d0[0] * sy0, w0[1] * cy0 - d0[1] * sy0, w0[2] * cy0 - d0[2] * sy0];
  const eD: Vec3 = [d0[0] * cy0 + w0[0] * sy0, d0[1] * cy0 + w0[1] * sy0, d0[2] * cy0 + w0[2] * sy0];

  // 이미지 (cx, anchorV) 가 보는 지면점 = 스트립 근변의 기준점(원근 배율을 실데이터와 맞춘다).
  const m: Vec3 = [(cx - cx) / f, (spec.anchorV - cy) / f, 1];
  const nm = n[0] * m[0] + n[1] * m[1] + n[2] * m[2];
  const A: Vec3 = [
    (spec.camHeightM * m[0]) / nm,
    (spec.camHeightM * m[1]) / nm,
    (spec.camHeightM * m[2]) / nm,
  ];
  const add = (a: Vec3, b: Vec3, k: number): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
  const proj = (X: Vec3) => {
    expect(X[2]).toBeGreaterThan(0); // 카메라 앞이어야 함(합성 전제).
    return { x: (f * X[0]) / X[2] + cx, y: (f * X[1]) / X[2] + cy };
  };

  const quads: PixelQuad[] = [];
  for (let i = 0; i < spec.slots; i++) {
    const p0 = add(A, eW, (i - spec.slots / 2) * spec.widthM);
    const p1 = add(p0, eD, spec.depthM);
    const p2 = add(p1, eW, spec.widthM);
    const p3 = add(p0, eW, spec.widthM);
    quads.push([proj(p0), proj(p1), proj(p2), proj(p3)]);
  }
  return { quads, f, n };
}

/** 결정형 PRNG(mulberry32) — 노이즈 테스트를 재현 가능하게 고정. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** 박스-뮐러 가우시안 노이즈 주입(σ px). */
function jitter(quads: PixelQuad[], sigma: number, r: () => number): PixelQuad[] {
  const g = () => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r()) * sigma;
  return quads.map((q) => q.map((p) => ({ x: p.x + g(), y: p.y + g() })) as PixelQuad);
}

describe('지면모델 — 합성 카메라 왕복(K/R/t 복원)', () => {
  it('무노이즈: f·tilt·카메라고·주차면 metric 을 정확히 복원한다', () => {
    const { quads, f: fTrue } = synthQuads(BASE);
    const vps = estimateGroundVPs(quads);
    expect(vps).not.toBeNull();
    const f = focalFromVPs(vps!.v1, vps!.v2, IMG_W / 2, IMG_H / 2);
    expect(f).not.toBeNull();
    expect(Math.abs(f! - fTrue) / fTrue).toBeLessThan(0.01); // f ±1%

    const plane = buildGroundPlane(quads, f!, vps!.v1, vps!.v2, IMG_W / 2, IMG_H / 2, OPTS);
    expect(plane).not.toBeNull();
    const tilt = (Math.asin(plane!.n[2]) / DEG);
    expect(Math.abs(tilt - BASE.tiltDeg)).toBeLessThan(0.5); // tilt ±0.5°
    expect(Math.abs(plane!.d - BASE.camHeightM) / BASE.camHeightM).toBeLessThan(0.02); // 카메라고 ±2%
    expect(plane!.metricErr).toBeLessThan(0.02); // 주차면 2.5×5.0m 재구성 ±2%
  });

  it('가파른 tilt(18.8°)에서도 복원한다', () => {
    const spec: CamSpec = { ...BASE, zoom: 1.4, tiltDeg: 18.8, slots: 4 };
    const { quads, f: fTrue } = synthQuads(spec);
    const vps = estimateGroundVPs(quads)!;
    const f = focalFromVPs(vps.v1, vps.v2, IMG_W / 2, IMG_H / 2)!;
    expect(Math.abs(f - fTrue) / fTrue).toBeLessThan(0.01);
    const plane = buildGroundPlane(quads, f, vps.v1, vps.v2, IMG_W / 2, IMG_H / 2, OPTS)!;
    expect(Math.abs(Math.asin(plane.n[2]) / DEG - spec.tiltDeg)).toBeLessThan(0.5);
    expect(Math.abs(plane.d - spec.camHeightM) / spec.camHeightM).toBeLessThan(0.02);
  });

  it('점 순서가 한 칸 회전해도(폭↔깊이 대응 뒤집힘) 카메라고를 올바로 복원한다 — §4-6 실제 함정', () => {
    const { quads } = synthQuads(BASE);
    // [p0,p1,p2,p3] → [p1,p2,p3,p0]: 변군 A 가 '폭', 변군 B 가 '깊이' 가 된다(픽셀 길이로 판정하면 틀림).
    const rotated = quads.map((q) => [q[1], q[2], q[3], q[0]] as PixelQuad);
    const vps = estimateGroundVPs(rotated)!;
    const f = focalFromVPs(vps.v1, vps.v2, IMG_W / 2, IMG_H / 2)!;
    const plane = buildGroundPlane(rotated, f, vps.v1, vps.v2, IMG_W / 2, IMG_H / 2, OPTS)!;
    // 뒤집힘을 못 잡으면 d 가 2배(또는 1/2배)로 조용히 틀린다.
    expect(Math.abs(plane.d - BASE.camHeightM) / BASE.camHeightM).toBeLessThan(0.02);
    expect(plane.metricErr).toBeLessThan(0.02);
  });
});

describe('지면모델 — fovBaseV 프리셋 공동추정(설계 §4-4)', () => {
  /** 실데이터 Place01 3프리셋을 모사(zoom/tilt/면수). preset1 이 조건수 최악. */
  const specs: CamSpec[] = [
    { ...BASE, zoom: 1.6, tiltDeg: 6.8, yawDeg: 25, slots: 7 },
    { ...BASE, zoom: 1.9, tiltDeg: 7.4, yawDeg: 40, slots: 6 },
    { ...BASE, zoom: 1.4, tiltDeg: 18.8, yawDeg: 30, slots: 4 },
  ];

  it('조건수 지표(깊이변 = 변군 A)가 tilt 순서와 일치한다', () => {
    const px = specs.map((s) => estimateGroundVPs(synthQuads(s).quads)!.edgePxA);
    expect(px[0]).toBeLessThan(px[2]); // 얕은 tilt = 짧은 baseline = 나쁜 조건수.
    expect(px[1]).toBeLessThan(px[2]);
  });

  it('σ=1px 노이즈: 공동추정 f 가 프리셋 단독 f 보다 정확하다(최악 프리셋에서 특히)', () => {
    const TRIALS = 100;
    const soloErr = [0, 0, 0];
    const poolErr = [0, 0, 0];
    const r = rng(20260714);
    for (let t = 0; t < TRIALS; t++) {
      const per = specs.map((s) => {
        const { quads, f: fTrue } = synthQuads(s);
        const vps = estimateGroundVPs(jitter(quads, 1, r))!;
        return { spec: s, fTrue, vps, fSolo: focalFromVPs(vps.v1, vps.v2, IMG_W / 2, IMG_H / 2) };
      });
      const pooled = poolFovBaseV(
        per.map((p) => ({ zoom: p.spec.zoom, f: p.fSolo, depthEdgePx: p.vps.edgePxA })),
        IMG_H,
      );
      expect(pooled).not.toBeNull();
      per.forEach((p, i) => {
        const fp = focalFromZoom(p.spec.zoom, pooled!.fovBaseV, IMG_W, IMG_H)!;
        poolErr[i] += ((fp - p.fTrue) / p.fTrue) ** 2;
        const solo = p.fSolo ?? 0;
        soloErr[i] += ((solo - p.fTrue) / p.fTrue) ** 2;
      });
    }
    const rms = (s: number) => Math.sqrt(s / TRIALS);
    for (let i = 0; i < 3; i++) {
      expect(rms(poolErr[i])).toBeLessThan(0.03); // 공동추정 f 오차 RMS < 3%(설계 목표).
    }
    // 최악 프리셋(0)에서 단독추정 대비 실질 개선이 있어야 한다 — 이것이 R1 의 유일한 해법.
    expect(rms(poolErr[0])).toBeLessThan(rms(soloErr[0]) / 2);
  });

  it('estimateGroundModels: 전 프리셋 모델 산출 + tilt/카메라고 복원(σ=0)', () => {
    const cam: GroundCameraInput = {
      camIdx: 1,
      imgW: IMG_W,
      imgH: IMG_H,
      presets: specs.map((s, i) => ({
        camIdx: 1,
        presetIdx: i + 1,
        zoom: s.zoom,
        tilt: s.tiltDeg,
        pan: null, // 합성 기하 — 슬롯 방위(수직축 회전) 검사 대상 아님.
        quads: synthQuads(s).quads,
      })),
    };
    const { models, fovBaseV } = estimateGroundModels(cam, OPTS);
    expect(models).toHaveLength(3);
    expect(Math.abs(fovBaseV! - BASE.fovBaseV) / BASE.fovBaseV).toBeLessThan(0.01);
    models.forEach((m, i) => {
      expect(Math.abs(m.tiltDeg - specs[i].tiltDeg)).toBeLessThan(1.0);
      expect(Math.abs(m.d - BASE.camHeightM) / BASE.camHeightM).toBeLessThan(0.03);
      expect(Math.abs(m.f - focalOf(specs[i])) / focalOf(specs[i])).toBeLessThan(0.02);
      expect(m.source).toBe('file');
      expect(Number.isFinite(m.conf)).toBe(true);
    });
  });
});

describe('지면모델 — 퇴화 방어(throw 금지·NaN 전파 0)', () => {
  it('focalFromVPs: f²≤0(직교 제약 위반) → null', () => {
    // 두 소실점이 주점 기준 같은 쪽 → 내적>0 → f²<0.
    expect(focalFromVPs([1500, 600, 1], [1600, 700, 1], 960, 540)).toBeNull();
  });

  it('focalFromVPs: 무한원 소실점(w≈0) → null (Infinity/NaN 전파 없음)', () => {
    const f = focalFromVPs([1, 0, 0], [960, 2000, 1], 960, 540);
    expect(f).toBeNull();
  });

  it('focalFromVPs: 직교 제약 만족 → 해석적 f 와 일치', () => {
    // (v1−c)=(1000,0), (v2−c)=(−1000,1000) → 내적 = −1e6 → f = 1000.
    const f = focalFromVPs([960 + 1000, 540, 1], [960 - 1000, 540 + 1000, 1], 960, 540);
    expect(f).toBeCloseTo(1000, 6);
  });

  it('isUsableQuad: 비볼록/자기교차(bowtie)·선분·미소면적 → 기각', () => {
    const ok: PixelQuad = [
      { x: 100, y: 500 },
      { x: 120, y: 300 },
      { x: 320, y: 300 },
      { x: 300, y: 500 },
    ];
    expect(isUsableQuad(ok)).toBe(true);
    const bowtie: PixelQuad = [ok[0], ok[2], ok[1], ok[3]]; // 자기교차.
    expect(isUsableQuad(bowtie)).toBe(false);
    const nearLine: PixelQuad = [
      { x: 100, y: 500 },
      { x: 100.5, y: 500 },
      { x: 300, y: 501 },
      { x: 300, y: 500 },
    ];
    expect(isUsableQuad(nearLine)).toBe(false);
    const tiny: PixelQuad = [
      { x: 0, y: 0 },
      { x: 0, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 0 },
    ];
    expect(isUsableQuad(tiny)).toBe(false); // 면적 100px² < 400px².
    const nan: PixelQuad = [ok[0], ok[1], ok[2], { x: NaN, y: 500 }];
    expect(isUsableQuad(nan)).toBe(false);
  });

  it('estimateGroundVPs: 쓸 수 있는 면 0 → null', () => {
    const bad: PixelQuad = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ];
    expect(estimateGroundVPs([bad])).toBeNull();
    expect(estimateGroundVPs([])).toBeNull();
  });

  it('poolFovBaseV: 유효 표본 0(f null / zoom 미상) → null', () => {
    expect(poolFovBaseV([{ zoom: 1.5, f: null, depthEdgePx: 300 }], IMG_H)).toBeNull();
    expect(poolFovBaseV([{ zoom: null, f: 2900, depthEdgePx: 300 }], IMG_H)).toBeNull();
    expect(poolFovBaseV([], IMG_H)).toBeNull();
  });

  it('poolFovBaseV: 표본 1개 → 교차검증 불가 advisory / 후보 불일치 → advisory', () => {
    const one = poolFovBaseV([{ zoom: 1.6, f: 2900, depthEdgePx: 120 }], IMG_H)!;
    expect(one.issues.join()).toContain('표본 1개');
    // 조건수 나쁜 표본(100px)이 30% 틀려도, 좋은 표본(600px)이 b² 가중으로 결과를 지배해야 한다.
    const mixed = poolFovBaseV(
      [
        { zoom: 1.4, f: 2539 * 1.3, depthEdgePx: 100 }, // 나쁜 프리셋: f 30% 과대.
        { zoom: 1.4, f: 2539, depthEdgePx: 600 }, // 좋은 프리셋: 정답.
      ],
      IMG_H,
    )!;
    const fPooled = focalFromZoom(1.4, mixed.fovBaseV, IMG_W, IMG_H)!;
    expect(Math.abs(fPooled - 2539) / 2539).toBeLessThan(0.02); // 나쁜 표본의 오염 < 2%.
    expect(mixed.issues.join()).toContain('불일치');
  });

  it('estimateGroundModels: 전 프리셋 퇴화 → models 빈 배열(throw 없음)', () => {
    const cam: GroundCameraInput = {
      camIdx: 1,
      imgW: IMG_W,
      imgH: IMG_H,
      presets: [{ camIdx: 1, presetIdx: 1, zoom: 1.6, tilt: 6.8, pan: null, quads: [] }],
    };
    const r = estimateGroundModels(cam, OPTS);
    expect(r.models).toEqual([]);
    expect(r.fovBaseV).toBeNull();
  });

  it('estimateGroundModels: 이미지 크기 오류 → 빈 결과 + issue', () => {
    const r = estimateGroundModels({ camIdx: 1, imgW: 0, imgH: 0, presets: [] }, OPTS);
    expect(r.models).toEqual([]);
    expect(r.issues.length).toBeGreaterThan(0);
  });
});
