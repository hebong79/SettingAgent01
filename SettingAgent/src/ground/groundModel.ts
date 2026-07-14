// 지면모델 추정(1단계 — 파일 경로 육면체). 순수·IO 비의존. 외부 의존은 detectMath.fovV / polygon.polygonSignedArea 뿐.
//
// 입력: 이미지 위의 점(주차면 4점) + 알려진 metric 길이(주차면 폭·깊이) + zoom.
//   → Unity `camera` 블록(position/eulerAngles/fov)에 **의존하지 않는다**(실카메라가 못 주는 값 — 설계 C3).
//     그 블록은 test/groundModelRealData.test.ts 에서 ground truth 대조용으로만 쓴다.
//
// 핵심 결정(설계 §4-4, 실측): **f 는 프리셋별로 독립 추정하지 않는다.**
//   같은 프리셋 안의 면을 아무리 늘려도 연속 스트립은 같은 두 소실점을 공유해 독립 정보가 0이다.
//   얕은 tilt 프리셋(깊이변 199px)은 σ=2px 노이즈에서 f 오차 35% 로 무너진다.
//   → 카메라당 fovBaseV **하나**를 전 프리셋에서 공동추정하고, 프리셋 f 는 fovV(zoom) 로 유도한다(20배 개선).
//
// 강등 철학: 퇴화(비볼록·선분·f²≤0·지평선 위)는 throw 금지 — null 반환 + issues advisory.

import { fovV } from '../calibrate/detectMath.js';
import { polygonSignedArea } from '../domain/polygon.js';
import type {
  GroundCameraInput,
  GroundModel,
  GroundOptions,
  Hom2,
  PixelQuad,
} from './types.js';

const DEG = Math.PI / 180;
/** fovBaseV 정의 기준 zoom(detectMath.FovOpts.zoomRef 와 동일 규약). */
const ZOOM_REF = 1;
/** quad 최소 변 길이(px). 이보다 짧으면 '거의 선분' → 추정 표본 제외. */
const MIN_EDGE_PX = 8;
/** quad 최소 면적(px²). 조건수 붕괴 방어. */
const MIN_AREA_PX = 400;
/** 소실점 무한원 판정: |w| / hypot(x,y) < 이 값이면 무한원(≈1e6px 밖) → 동차 유지, 정규화 금지. */
const VP_INF_EPS = 1e-6;
/** 지면 법선·시선 내적 하한. 이보다 작으면 지평선 위(지면점 아님) → 기각. */
const HORIZON_EPS = 1e-4;
/** metricErr 가 이 값 이상이면 적합도 0(경사·비평면·스케일 오배정 의심). */
const METRIC_ERR_MAX = 0.1;
/**
 * ★ **이미지 평행이동** 검출 임계(metricErr). ROI 를 이미지에서 통째로 밀면 이 값이 오른다.
 *
 * 왜 필요한가 — **f/tilt 는 ROI 정합을 보장하지 않는다.** 소실점은 직선의 *방향*에서 나오므로
 * 폴리곤을 통째로 평행이동해도 방향은 불변이다. 실측(preset 1 ROI 를 강제 이동, 공동추정 f 기준):
 *     ±200px 이동 → f 변화 0.6% / tilt 변화 0.08% / 카메라고 변화 0.6%  ← **정합 오류를 못 잡는다.**
 *     ±200px 이동 → metricErr 0.2% → 2.7%  (기울기 ≈ 0.0125 %/px)
 * 원리: 주점=이미지중심 가정 하에서 이미지 평행이동은 주점 이동과 등가라, 평행이동된 ROI 는 **어떤 카메라로도**
 * 2.5×5.0m 직사각형 스트립의 상(像)이 될 수 없다 → metric 재구성 잔차가 오른다.
 *
 * 임계 0.8% 근거(실측): 정상 ROI(Unity 원형) 0.0~0.3% / 실제로 벌어진 +105px 자동보정 이동 1.5%.
 *
 * ⚠️⚠️ **이 임계는 "≳60px 어긋남을 잡는다"고 말할 수 없다 — 순수 *이미지 평행이동* 에 대해서만 그렇다.**
 *   반례(실측): **이미지 회전 10° = 평균변위 77px 인데 metricErr 0.57% 로 임계 미달 → 놓친다.**
 *   더 중요하게, **지면 위 닮음변환(평행이동·수직축회전·균일스케일)은 metricErr 를 전혀 움직이지 않는다**
 *   (지면 3m/3m 평행이동 = 이미지 360px 인데 metricErr 0.19% 불변). §GROUND-SIMILARITY 참조.
 */
const ROI_MISALIGN_ERR = 0.008;
/**
 * ★ 지면 **균일스케일** 검출 임계(카메라고 d 의 프리셋 간 상대편차).
 * 카메라는 프리셋 사이에 움직이지 않으므로 d 는 **프리셋 불변량**이어야 한다.
 * 실측: 정상 스프레드 0.9%(4.963/4.986/4.941) / preset1 만 지면 ×2 스케일 → d 4.96→2.48 (편차 ~50%).
 * 지면 균일스케일은 metricErr·tiltErr 를 **전혀** 건드리지 않으므로(둘 다 불변) 이 검사만이 잡는다.
 */
const D_DEV_REL = 0.1;
/**
 * ★ 지면 **수직축 회전** 검출 임계(슬롯 방위의 프리셋 간 편차, 도).
 * 같은 주차장이면 스트립 방위는 프리셋 불변량이다(방위 = PTZ pan + 카메라 지면전방 기준 슬롯 azimuth).
 * 실측: 정상 스프레드 ~2.3° / 지면 30° 회전 → 방위가 정확히 30° 이동. metricErr·tiltErr 는 불변.
 * mod 90 로 다룬다(직교 두 변군 대칭 + 폭/깊이 배정 뒤집힘 무관).
 *
 * ⚠️ **tiltErrDeg 와 성질이 다르다 — 혼동 금지(다음 사람을 위한 경고).**
 *   `tiltErrDeg` 는 **절대** 검사다: '수평 지면' 이라는 세계 기준이 있어 추정 tilt 를 PTZ tilt 와 **직접** 대조할 수 있다.
 *   방위각에는 그런 기준이 **없다** — 슬롯의 실제 세계 방위를 우리는 모른다. 따라서 **PTZ pan 과 직접 대조하는 검사는 성립하지 않는다.**
 *   여기서 pan 은 **각 프리셋을 공통 좌표계로 정규화**하는 데만 쓰이고, 판정은 **프리셋 간 상대 일치**로만 한다.
 *   → 프리셋이 1개면 검사 불가. 전 프리셋이 똑같이 회전돼 있으면 침묵한다(원리적).
 */
const BEARING_DEV_DEG = 8;
/**
 * ★ 세로 정합 경보 임계(도). metricErr 는 **가로** 어긋남만 잡는다 — ROI 를 세로로 밀면 그 오차가
 * **tilt 로 흡수**되어 metricErr 는 낮게 유지된다. 실측(preset 1, dy 스윕):
 *     dy=  0px → tilt 6.84°, metricErr 0.19%
 *     dy=+200px → tilt 2.94°(−3.9°!), metricErr 0.38%   ← metricErr 는 눈이 멀었고 tilt 만 무너진다.
 * → 카메라가 보고한 PTZ tilt(camerapos)와 대조하면 세로 어긋남이 드러난다.
 *   PTZ tilt 는 **실카메라도 주는 값**이므로 프로덕션에서 써도 C3(실카메라 호환) 위반이 아니다.
 * 임계 1.0° 근거(실측): 정상 0.04~0.15° / 세로 50px 어긋남 ≈ 1.0° / 200px ≈ 3.9°.
 */
const TILT_MISALIGN_DEG = 1.0;

type Vec3 = [number, number, number];

const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm3 = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
function unit3(a: Vec3): Vec3 | null {
  const n = norm3(a);
  if (!Number.isFinite(n) || n < 1e-12) return null;
  return [a[0] / n, a[1] / n, a[2] / n];
}
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** 픽셀 동차점/소실점 → 카메라 좌표 방향(K⁻¹v). 무한원 소실점(w=0)도 그대로 통과한다. */
function kInv(v: Hom2, f: number, cx: number, cy: number): Vec3 {
  return [(v[0] - cx * v[2]) / f, (v[1] - cy * v[2]) / f, v[2]];
}

/** 대칭 3×3 의 최소 고유값 고유벡터(Jacobi 회전). 소실점 최소제곱(‖Av‖ 최소, ‖v‖=1)용. */
function eigenSmallest3(m: number[][]): Vec3 {
  const a = m.map((row) => row.slice());
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2;
    if (off < 1e-24) break;
    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < 3; i++) if (a[i][i] < a[best][best]) best = i;
  return [v[0][best], v[1][best], v[2][best]];
}

/** 직선군(끝점쌍)의 최소제곱 소실점. Hartley 정규화 → 단위직선 → AᵀA 최소고유벡터. 동차 반환(무한원 가능). */
function vanishingPoint(lines: Array<[{ x: number; y: number }, { x: number; y: number }]>): Hom2 | null {
  if (lines.length < 2) return null;
  const pts = lines.flat();
  const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const meanDist = pts.reduce((s, p) => s + Math.hypot(p.x - mx, p.y - my), 0) / pts.length;
  if (!Number.isFinite(meanDist) || meanDist < 1e-9) return null;
  const s = Math.SQRT2 / meanDist; // T: 중심이동 + 평균거리 √2 스케일(수치안정).
  const m = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const [p, q] of lines) {
    const ph: Vec3 = [s * (p.x - mx), s * (p.y - my), 1];
    const qh: Vec3 = [s * (q.x - mx), s * (q.y - my), 1];
    const l = unit3(cross3(ph, qh)); // 동차 직선 l = p×q, 단위화(각 직선 동등 가중).
    if (!l) return null;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] += l[i] * l[j];
  }
  const vn = eigenSmallest3(m);
  // T⁻¹ 로 원 픽셀 좌표계 복귀: v = T⁻¹ v̂.
  return [vn[0] / s + mx * vn[2], vn[1] / s + my * vn[2], vn[2]];
}

/** quad 가 추정 표본으로 쓸 수 있는가(4점·유한·최소변·최소면적·볼록·비자기교차). 퇴화는 기각(설계 §4-6). */
export function isUsableQuad(quad: PixelQuad): boolean {
  if (!Array.isArray(quad) || quad.length !== 4) return false;
  if (quad.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    if (Math.hypot(b.x - a.x, b.y - a.y) < MIN_EDGE_PX) return false;
  }
  if (Math.abs(polygonSignedArea(quad)) < MIN_AREA_PX) return false;
  // 볼록·비자기교차: 연속 외적의 부호가 4개 모두 같아야 한다(bowtie 는 부호가 섞인다 — convexHull 로는 못 잡음).
  let pos = 0;
  let neg = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const c = quad[(i + 2) % 4];
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (z > 0) pos += 1;
    else if (z < 0) neg += 1;
    else return false; // 연속 3점 공선 → 퇴화.
  }
  return pos === 4 || neg === 4;
}

/** quad 의 두 변군. A=깊이변군(p0-p1, p3-p2), B=폭변군(p0-p3, p1-p2) — 점 규약 §4-2. */
function edgesOf(quad: PixelQuad) {
  return {
    a: [
      [quad[0], quad[1]],
      [quad[3], quad[2]],
    ] as Array<[{ x: number; y: number }, { x: number; y: number }]>,
    b: [
      [quad[0], quad[3]],
      [quad[1], quad[2]],
    ] as Array<[{ x: number; y: number }, { x: number; y: number }]>,
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((p, q) => p - q);
  const n = s.length;
  if (n === 0) return 0;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/**
 * 이미지 4점 사각형들 → 두 직교 소실점 + 변군별 픽셀길이 중앙값.
 * v1 = 변군 A(p0-p1, p3-p2), v2 = 변군 B(p0-p3, p1-p2) 의 최소제곱 소실점. 무한원은 동차로 유지(w≈0).
 * edgePxA/edgePxB = 각 변군의 변 길이 중앙값. **어느 쪽이 깊이변(5m)인지는 여기서 판정하지 않는다** —
 *   투영단축 때문에 픽셀 길이로 폭/깊이를 판정하면 틀린다(§4-6). 판정은 buildGroundPlane 의 metric 적합도가 한다.
 */
export function estimateGroundVPs(
  quads: PixelQuad[],
): { v1: Hom2; v2: Hom2; edgePxA: number; edgePxB: number } | null {
  const usable = quads.filter(isUsableQuad);
  if (usable.length === 0) return null;
  const linesA: Array<[{ x: number; y: number }, { x: number; y: number }]> = [];
  const linesB: Array<[{ x: number; y: number }, { x: number; y: number }]> = [];
  const lenA: number[] = [];
  const lenB: number[] = [];
  for (const q of usable) {
    const { a, b } = edgesOf(q);
    linesA.push(...a);
    linesB.push(...b);
    for (const [p, r] of a) lenA.push(Math.hypot(r.x - p.x, r.y - p.y));
    for (const [p, r] of b) lenB.push(Math.hypot(r.x - p.x, r.y - p.y));
  }
  const v1 = vanishingPoint(linesA);
  const v2 = vanishingPoint(linesB);
  if (!v1 || !v2) return null;
  return { v1, v2, edgePxA: median(lenA), edgePxB: median(lenB) };
}

/**
 * 직교 소실점 제약으로 f 추정: (v1−c)·(v2−c) + f² = 0  (주점=중심, 정사각픽셀, 무왜곡).
 * 무한원 소실점(w≈0) 또는 f²≤0(제약 위반) → **null**. NaN/Infinity 를 절대 전파하지 않는다(§4-6).
 */
export function focalFromVPs(v1: Hom2, v2: Hom2, cx: number, cy: number): number | null {
  const inhom = (v: Hom2): { x: number; y: number } | null => {
    const w = v[2];
    if (!Number.isFinite(w)) return null;
    if (Math.abs(w) < VP_INF_EPS * Math.hypot(v[0], v[1])) return null; // 무한원 → 유한 f 유도 불가.
    return { x: v[0] / w, y: v[1] / w };
  };
  const p1 = inhom(v1);
  const p2 = inhom(v2);
  if (!p1 || !p2) return null;
  const f2 = -((p1.x - cx) * (p2.x - cx) + (p1.y - cy) * (p2.y - cy));
  if (!Number.isFinite(f2) || f2 <= 0) return null;
  const f = Math.sqrt(f2);
  return Number.isFinite(f) && f > 0 ? f : null;
}

/** zoom → 초점거리(px). detectMath.fovV(카메라 모델과 소수 5자리 일치 — §1-4) 재사용. 자체 FOV 공식 금지. */
export function focalFromZoom(zoom: number, fovBaseV: number, imgW: number, imgH: number): number | null {
  if (!(zoom > 0) || !(fovBaseV > 0) || !(imgH > 0)) return null;
  const deg = fovV(zoom, { fovBaseV, zoomRef: ZOOM_REF, aspect: imgW / imgH });
  const t = Math.tan((deg * DEG) / 2);
  if (!Number.isFinite(t) || t <= 0) return null;
  return imgH / 2 / t;
}

/**
 * ★ 카메라당 fovBaseV 공동 추정(설계 §4-4 — 이 설계의 핵심 결정).
 *
 * PTZ 카메라의 f 는 zoom 만의 함수다. 프리셋별로 f 를 독립 추정하면 얕은 tilt 프리셋에서 조용히 30%+ 틀린다(R1).
 * → 프리셋별 f 후보를 tan(fovBaseV/2) 공간으로 환산해 **깊이변 픽셀길이²** 가중 합의한다.
 *   가중 근거(실측): f 오차 35.4 / 15.8 / 1.7 % @ 깊이변 199 / 271 / 620px — 정밀도가 baseline 에 초선형 의존.
 *   b² 는 최악 프리셋을 최선 대비 ~8배 낮추면서도 표본 하나로 붕괴하지 않는 보수적 선택이다.
 *   **하드 게이트를 두지 않는다**: 조건수 나쁜 프리셋도 표본으로 남겨야 프리셋 간 교차검증(spread)이 가능하다.
 *   조건수는 가중치와 conf/advisory 로만 반영한다(설계 §4-6 의 게이트 역할과 동일).
 * 표본 0개(전 프리셋 f²≤0/무한원/zoom 미상) → null.
 */
export function poolFovBaseV(
  samples: Array<{ zoom: number | null; f: number | null; depthEdgePx: number }>,
  imgH: number,
): { fovBaseV: number; conf: number; issues: string[] } | null {
  const issues: string[] = [];
  const used = samples.filter(
    (s) => s.f != null && s.f > 0 && Number.isFinite(s.f) && s.zoom != null && s.zoom > 0 && s.depthEdgePx > 0,
  ) as Array<{ zoom: number; f: number; depthEdgePx: number }>;
  if (used.length === 0 || !(imgH > 0)) return null;

  // tan(fovV_i/2) = imgH/(2 f_i) 이므로 tan(fovBaseV/2) 후보 = imgH/(2 f_i) · zoom_i / zoomRef.
  const cands = used.map((s) => ((imgH / (2 * s.f)) * s.zoom) / ZOOM_REF);
  const weights = used.map((s) => s.depthEdgePx ** 2);
  const wsum = weights.reduce((a, b) => a + b, 0);
  if (!(wsum > 0)) return null;
  const tanHalf = cands.reduce((acc, c, i) => acc + c * weights[i], 0) / wsum;
  if (!Number.isFinite(tanHalf) || tanHalf <= 0) return null;
  const fovBaseV = (2 * Math.atan(tanHalf)) / DEG;

  const spread = Math.max(...cands.map((c) => Math.abs(c - tanHalf))) / tanHalf;
  const conf = clamp01(1 - spread);
  if (used.length === 1) issues.push('f 공동추정 표본 1개 — 프리셋 간 교차검증 불가');
  else if (conf < 0.9) issues.push(`프리셋 간 f 후보 불일치 ${(spread * 100).toFixed(1)}% — 소실점 품질 확인 필요`);
  return { fovBaseV, conf, issues };
}

/**
 * f + 두 소실점 + 알려진 주차면 metric 규격 → 지면 평면 (n, d).
 *   n = 지면 하향 단위법선(카메라 좌표), d = 카메라 지상고(m).
 * 폭/깊이 대응 뒤집힘(§4-6 의 실제 함정 — 투영단축 때문에 픽셀 길이로 판정하면 틀린다)은
 * **두 배정을 모두 풀고 metric 재구성 오차가 작은 쪽을 채택**해 해소한다. 채택 결과는 depthFamily 로 알린다
 * (조건수 지표를 '진짜 깊이변' 에서 재게 하는 근거 — §4-4 의 가중치).
 * 지평선 위/법선 퇴화/스케일 산출 불가 → null.
 */
export function buildGroundPlane(
  quads: PixelQuad[],
  f: number,
  v1: Hom2,
  v2: Hom2,
  cx: number,
  cy: number,
  opts: Pick<GroundOptions, 'slotWidthM' | 'slotDepthM'>,
): {
  n: [number, number, number];
  d: number;
  metricErr: number;
  depthFamily: 'a' | 'b';
  /** 변군 A 의 지면 방향(카메라 좌표 단위벡터). 슬롯 방위(수직축 회전 검출)의 근거. */
  dirA: [number, number, number];
} | null {
  const usable = quads.filter(isUsableQuad);
  if (usable.length === 0 || !(f > 0)) return null;

  const d1 = unit3(kInv(v1, f, cx, cy)); // 변군 A 의 지면 방향(카메라 좌표).
  const d2raw = unit3(kInv(v2, f, cx, cy)); // 변군 B 의 지면 방향.
  if (!d1 || !d2raw) return null;
  const cosang = dot3(d1, d2raw);
  if (Math.abs(cosang) > 0.5) return null; // 두 방향이 직교와 60° 이상 어긋남 → 지면 가정 붕괴.
  // f 는 공동추정값이라 직교가 정확히 성립하지 않는다 → d2 를 d1 에 직교 투영(최소 보정).
  const d2 = unit3([
    d2raw[0] - cosang * d1[0],
    d2raw[1] - cosang * d1[1],
    d2raw[2] - cosang * d1[2],
  ]);
  if (!d2) return null;
  const n0 = unit3(cross3(d1, d2));
  if (!n0) return null;

  // 부호: 지면점은 카메라 앞·아래에 있으므로 모든 지면점 시선 m 에 대해 n·m > 0 이어야 한다.
  const rays = usable.flatMap((q) => q.map((p) => kInv([p.x, p.y, 1], f, cx, cy)));
  const meanDot = rays.reduce((s, m) => s + dot3(n0, m), 0) / rays.length;
  const n: Vec3 = meanDot < 0 ? [-n0[0], -n0[1], -n0[2]] : n0;
  if (rays.some((m) => dot3(n, m) < HORIZON_EPS)) return null; // 지평선 위/무한대 → 기각.

  // 단위스케일(d=1) 에서의 선분 길이. 실제 길이 = d × 이 값.
  const unitLen = (p: { x: number; y: number }, q: { x: number; y: number }): number => {
    const mp = kInv([p.x, p.y, 1], f, cx, cy);
    const mq = kInv([q.x, q.y, 1], f, cx, cy);
    const sp = dot3(n, mp);
    const sq = dot3(n, mq);
    if (sp < HORIZON_EPS || sq < HORIZON_EPS) return NaN;
    return norm3([mp[0] / sp - mq[0] / sq, mp[1] / sp - mq[1] / sq, mp[2] / sp - mq[2] / sq]);
  };

  // 배정 A: 변군 A=깊이(slotDepthM), 변군 B=폭(slotWidthM). 배정 B: 뒤집힘.
  const solve = (lenOfA: number, lenOfB: number): { d: number; metricErr: number } | null => {
    const ds: number[] = [];
    const pairs: Array<{ L: number; expect: number }> = [];
    for (const q of usable) {
      const { a, b } = edgesOf(q);
      for (const [p, r] of a) {
        const L = unitLen(p, r);
        if (!Number.isFinite(L) || L <= 0) return null;
        pairs.push({ L, expect: lenOfA });
        ds.push(lenOfA / L);
      }
      for (const [p, r] of b) {
        const L = unitLen(p, r);
        if (!Number.isFinite(L) || L <= 0) return null;
        pairs.push({ L, expect: lenOfB });
        ds.push(lenOfB / L);
      }
    }
    if (!ds.length) return null;
    const d = median(ds); // 로버스트(이상 변 1개가 스케일을 끌지 않게).
    if (!Number.isFinite(d) || d <= 0) return null;
    const metricErr = pairs.reduce((s, e) => s + Math.abs(d * e.L - e.expect) / e.expect, 0) / pairs.length;
    return { d, metricErr };
  };

  // 배정 A: 변군 A=깊이(5m). 배정 B: 변군 B=깊이(뒤집힘). metric 재구성 오차가 작은 쪽 채택.
  const asA = solve(opts.slotDepthM, opts.slotWidthM);
  const asB = solve(opts.slotWidthM, opts.slotDepthM);
  if (!asA && !asB) return null;
  const takeA = !asB || (!!asA && asA.metricErr <= asB.metricErr);
  const best = (takeA ? asA : asB)!;
  return { n, d: best.d, metricErr: best.metricErr, depthFamily: takeA ? 'a' : 'b', dirA: d1 };
}

/**
 * 슬롯 스트립의 방위각(도, mod 90). = PTZ pan + (카메라의 지면전방 기준 슬롯방향 azimuth).
 * 카메라가 pan 만큼 돌면 azimuth 가 그만큼 반대로 줄어 **합은 불변** → 프리셋 불변량이 된다.
 * mod 90: 직교 두 변군(폭/깊이)이 90° 차이이므로 배정이 뒤집혀도 같은 값으로 접힌다.
 */
export function slotBearingDeg(
  n: [number, number, number],
  dirA: [number, number, number],
  panDeg: number,
): number | null {
  const z: Vec3 = [0, 0, 1];
  const fwd = unit3([z[0] - dot3(z, n) * n[0], z[1] - dot3(z, n) * n[1], z[2] - dot3(z, n) * n[2]]);
  if (!fwd) return null; // 광축이 지면 법선과 평행(수직 하방) → 방위 정의 불가.
  const right = unit3(cross3(n, fwd));
  if (!right) return null;
  const az = Math.atan2(dot3(dirA, right), dot3(dirA, fwd)) / DEG;
  return (((panDeg + az) % 90) + 90) % 90;
}

/** mod 90 원형 평균(도). 4배각으로 펴서 벡터평균 → 다시 접는다. */
function circMeanMod90(bs: number[]): number {
  let sx = 0;
  let sy = 0;
  for (const b of bs) {
    sx += Math.cos(b * 4 * DEG);
    sy += Math.sin(b * 4 * DEG);
  }
  return ((Math.atan2(sy, sx) / DEG / 4) % 90 + 90) % 90;
}

/** mod 90 원형 편차(도), [-45, 45] 로 감는다. */
function circDevMod90(b: number, mean: number): number {
  const d = (((b - mean) % 90) + 90) % 90;
  return d > 45 ? d - 90 : d;
}

/**
 * 카메라 1대의 전 프리셋 지면모델 산출(순수). fovBaseV 공동추정 → 프리셋별 f 유도 → 평면 (n,d).
 * 추정 실패 프리셋은 **모델을 내지 않는다**(육면체 미표시 — 조용히 틀린 육면체보다 안 그리는 게 낫다).
 */
export function estimateGroundModels(
  cam: GroundCameraInput,
  opts: GroundOptions,
): { models: GroundModel[]; fovBaseV: number | null; issues: string[] } {
  const issues: string[] = [];
  const { imgW, imgH } = cam;
  if (!(imgW > 0) || !(imgH > 0)) {
    return { models: [], fovBaseV: null, issues: [`cam${cam.camIdx}: 이미지 크기 오류`] };
  }
  const cx = imgW / 2;
  const cy = imgH / 2;

  // 1차: 프리셋 단독 f 로 임시 평면을 풀어 **어느 변군이 깊이(5m)인지** 확정한다.
  //   깊이변 픽셀길이가 f 공동추정의 가중치이므로, 폭/깊이를 뒤집어 재면 가중치가 조용히 틀린다(R1).
  //   임시 평면이 안 나오면 점 규약(변군 A=깊이)으로 폴백.
  const stage = cam.presets.map((p) => {
    const vps = estimateGroundVPs(p.quads);
    const fSolo = vps ? focalFromVPs(vps.v1, vps.v2, cx, cy) : null;
    const probe = vps && fSolo ? buildGroundPlane(p.quads, fSolo, vps.v1, vps.v2, cx, cy, opts) : null;
    const depthEdgePx = !vps ? 0 : (probe?.depthFamily ?? 'a') === 'a' ? vps.edgePxA : vps.edgePxB;
    return { preset: p, vps, fSolo, depthEdgePx };
  });

  // 2차: fovBaseV 공동추정(카메라 1개당 하나) → 프리셋 f 는 fovV(zoom) 로 유도.
  const pooled = poolFovBaseV(
    stage.map((s) => ({ zoom: s.preset.zoom, f: s.fSolo, depthEdgePx: s.depthEdgePx })),
    imgH,
  );
  if (pooled) issues.push(...pooled.issues);
  else issues.push(`cam${cam.camIdx}: f 공동추정 표본 없음 — 프리셋 단독 추정으로 강등`);

  const models: GroundModel[] = [];
  for (const s of stage) {
    const { preset, vps, fSolo } = s;
    const mIssues: string[] = [];
    if (!vps) continue; // 쓸 수 있는 주차면 0 → 모델 없음(육면체 미표시).

    // f: 공동추정 fovBaseV + zoom 으로 유도(원칙). 불가 시에만 프리셋 단독 f 로 강등.
    let f: number | null = null;
    if (pooled && preset.zoom != null && preset.zoom > 0) {
      f = focalFromZoom(preset.zoom, pooled.fovBaseV, imgW, imgH);
    }
    if (f == null) {
      f = fSolo;
      if (f != null) mIssues.push('zoom/공동추정 불가 — 프리셋 단독 f 채택(얕은 tilt 에서 최대 35% 오차 위험)');
    }
    if (f == null || !(f > 0)) continue; // f²≤0 / 무한원 소실점 → 모델 없음.

    const plane = buildGroundPlane(preset.quads, f, vps.v1, vps.v2, cx, cy, opts);
    if (!plane) continue; // 지평선 위/법선 퇴화/스케일 불가 → 모델 없음.
    const depthEdgePx = plane.depthFamily === 'a' ? vps.edgePxA : vps.edgePxB;

    if (depthEdgePx < opts.minDepthEdgePx) {
      mIssues.push(
        `깊이변 ${depthEdgePx.toFixed(0)}px < ${opts.minDepthEdgePx}px — 조건수 낮음(f 는 프리셋 공동추정으로 보정)`,
      );
    }
    // ★ 가로 정합 경보(metricErr). f/tilt 가 만점이어도 ROI 가 가로로 밀려 있으면 여기서만 잡힌다.
    if (plane.metricErr > 0.05) {
      mIssues.push(`주차면 metric 잔차 ${(plane.metricErr * 100).toFixed(1)}% — 경사/비평면 의심`);
    } else if (plane.metricErr > ROI_MISALIGN_ERR) {
      mIssues.push(
        `주차면 metric 잔차 ${(plane.metricErr * 100).toFixed(2)}% — ROI 가로 정합 의심(실제 주차면 대비 평행이동/왜곡). ` +
          `f·tilt 는 평행이동에 둔감하므로 이 지표로만 판별된다`,
      );
    }

    // ★ 세로 정합 경보(tiltErrDeg). 세로 어긋남은 tilt 로 흡수돼 metricErr 가 못 잡는다 → PTZ tilt 와 대조.
    const tiltDeg = Math.asin(Math.min(1, Math.max(-1, plane.n[2]))) / DEG;
    const ptzTiltDeg = preset.tilt ?? null;
    const tiltErrDeg = ptzTiltDeg == null ? null : tiltDeg - ptzTiltDeg;
    if (ptzTiltDeg != null && tiltErrDeg != null && Math.abs(tiltErrDeg) > TILT_MISALIGN_DEG) {
      mIssues.push(
        `추정 tilt ${tiltDeg.toFixed(2)}° vs 카메라 PTZ tilt ${ptzTiltDeg.toFixed(2)}° (${tiltErrDeg.toFixed(2)}°) — ` +
          `ROI 세로 정합 의심(세로 어긋남은 tilt 로 흡수되어 metric 잔차로는 안 잡힌다)`,
      );
    }

    const condPart = clamp01(depthEdgePx / opts.minDepthEdgePx);
    const fitPart = clamp01(1 - plane.metricErr / METRIC_ERR_MAX);
    models.push({
      camIdx: cam.camIdx,
      presetIdx: preset.presetIdx,
      imgW,
      imgH,
      zoom: preset.zoom ?? 0,
      f,
      n: plane.n,
      d: plane.d,
      tiltDeg,
      ptzTiltDeg,
      tiltErrDeg,
      slotBearingDeg: preset.pan == null ? null : slotBearingDeg(plane.n, plane.dirA, preset.pan),
      bearingDevDeg: null, // 프리셋 간 합의가 필요 → 아래 카메라 단위 검사에서 채운다.
      dDevRel: null,
      depthEdgePx,
      metricErr: plane.metricErr,
      conf: clamp01(condPart * fitPart),
      source: 'file',
      issues: mIssues,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // §GROUND-SIMILARITY — 지면 위 닮음변환 검출(프리셋 간 불변량 대조).
  //
  // metricErr(이미지 평행이동) 과 tiltErrDeg(세로) 만으로는 **지면 위 닮음변환을 전혀 못 잡는다.**
  // ROI 를 지면에서 평행이동/회전/스케일해도 그것은 여전히 '어떤 카메라로 본 2.5×5.0m 직사각형 스트립의 상'
  // 이기 때문이다(실측: 지면 3m/3m 이동 = 이미지 360px 인데 metricErr·tiltErr 둘 다 불변).
  //
  // 그중 2 자유도는 **카메라가 프리셋 사이에 움직이지 않는다**는 사실로 닫힌다(신규 입력 0):
  //   · 균일스케일 → 카메라고 d 는 프리셋 불변량이어야 한다.
  //   · 수직축회전 → 슬롯 방위(pan 보정)는 프리셋 불변량이어야 한다.
  // 남는 2 자유도(지면 평행이동)는 **이미지 증거(노면 도색) 없이는 원리적으로 검출 불가** — 한계로 명시한다.
  //
  // ⚠️ 이 검사들은 **상대(프리셋 간) 불일치**만 잡는다. 전 프리셋이 똑같이 틀리면(예: 전역 균일스케일)
  //    불변량이 여전히 일치하므로 침묵한다.  ⚠️ 프리셋이 1개면 대조 불가.
  // ─────────────────────────────────────────────────────────────────────────────
  if (models.length >= 2) {
    // (1) 균일스케일: 카메라고 d 의 프리셋 간 일관성.
    const dMed = median(models.map((m) => m.d));
    if (dMed > 0) {
      for (const m of models) {
        m.dDevRel = (m.d - dMed) / dMed;
        if (Math.abs(m.dDevRel) > D_DEV_REL) {
          m.issues.push(
            `카메라고 ${m.d.toFixed(2)}m 가 프리셋 합의 ${dMed.toFixed(2)}m 대비 ${(m.dDevRel * 100).toFixed(0)}% 벗어남 — ` +
              `지면 균일스케일 오류 의심(ROI 가 실제보다 크거나 작다). metric 잔차·tilt 로는 안 잡힌다`,
          );
        }
      }
    }
    // (2) 수직축회전: 슬롯 방위(mod 90)의 프리셋 간 일관성.
    const withBearing = models.filter((m) => m.slotBearingDeg != null);
    if (withBearing.length >= 2) {
      const mean = circMeanMod90(withBearing.map((m) => m.slotBearingDeg as number));
      for (const m of withBearing) {
        m.bearingDevDeg = circDevMod90(m.slotBearingDeg as number, mean);
        if (Math.abs(m.bearingDevDeg) > BEARING_DEV_DEG) {
          m.issues.push(
            `슬롯 방위 ${(m.slotBearingDeg as number).toFixed(1)}° 가 프리셋 합의 ${mean.toFixed(1)}° 대비 ` +
              `${m.bearingDevDeg.toFixed(1)}° 벗어남 — ROI 수직축 회전 의심. metric 잔차·tilt 로는 안 잡힌다`,
          );
        }
      }
    } else {
      issues.push('PTZ pan 미상 — 수직축 회전 검출 불가(camerapos 확인 필요)');
    }
  } else if (models.length === 1) {
    issues.push('프리셋 1개 — 지면 닮음변환(균일스케일·수직축회전) 교차검증 불가');
  }

  return { models, fovBaseV: pooled?.fovBaseV ?? null, issues };
}
