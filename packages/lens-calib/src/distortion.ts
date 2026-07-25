// 렌즈 방사왜곡(곡면율) — 이 라이브러리의 **세 번째 표**. ★신규 축.
//
// 앞의 두 표(zoomHfov · centeringGain)는 "렌즈도 펌웨어도 tan 핀홀이고 초점거리 상수 하나만
// 어긋난다"는 가정 위에 서 있다. 실기 105샘플이 그 가정을 뒷받침했고(팬·틸트 독립 역산 0.1% 일치),
// 참조본은 스스로 §7-5에 이렇게 남겼다:
//
//   "방사왜곡(곡면율)은 여전히 미모델링. … 더 넓은 렌즈나 더 엄격한 요구가 생기면 그때 별도 항으로."
//
// 두 표가 **원리적으로** 잡을 수 없는 것이 여기 들어간다:
//
//   centeringGain k  — 편심의 **1승**  "가장자리로 갈수록 비례해서 덜 온다"
//   lensDistortion k1— 편심의 **3승**부터 "가장자리에서만, 그것도 급격히"
//
// 한쪽으로 다른 쪽을 대신할 수 없다. 그래서 표가 하나 더 필요하다.
//
// ── 모델 ───────────────────────────────────────────────────────────────────
// Brown-Conrady 방사 성분만. 정규화 반경은 **교과서 규약** r = r_px / f (주변축 초점거리 기준):
//
//   r_d = r_u · (1 + k1·r_u² + k2·r_u⁴)        distort   : 이상(핀홀) → 실제 이미지
//   r_u = newton(r_d)                          undistort : 실제 이미지 → 이상
//
// 배럴이면 k1 < 0 (가장자리가 안으로 수축). 핀쿠션이면 k1 > 0.
// 점 변환은 **반경만** 바꾸고 방향을 보존한다: p' = c + (p − c)·(r_out/r_in).
//
// **접선왜곡·주점오프셋을 넣지 않는 이유**: 우리가 가진 측정은 "회전 전후에 무늬가 어디로 갔나"
// 뿐이다. 주점 오프셋은 회전과 **축퇴**하고(팬 오프셋과 구별되지 않는다), 접선왜곡은 방사보다
// 한 자릿수 작아 노이즈에 묻힌다. 못 재는 항을 표에 넣으면 그 항은 다른 항의 오차를 흡수하는
// 쓰레기통이 된다.
//
// ── 방향을 헷갈리지 말 것 ────────────────────────────────────────────────────
//   distort()   이상 → 실제 이미지.  **그릴 때**(월드 투영·역투영·prior ROI)
//   undistort() 실제 이미지 → 이상.  **조준할 때**(클릭 → 광선), 검출 결과 → 기하
//
// 클릭은 실제 이미지 위에서 일어나므로 조준 경로는 반드시 undistort 로 시작한다.

import { ZoomCurve } from './curve.js';
import type { DistortionPoint } from './types.js';

export interface Coeffs {
  k1: number;
  k2: number;
}

const IDENTITY: Coeffs = { k1: 0, k2: 0 };

// ── 자유 함수 ────────────────────────────────────────────────────────────────
// 솔버는 **계수를 바꿔가며** 비용을 재기 때문에 표에 묶인 인스턴스를 쓸 수 없다.
// 그래서 반경 변환은 자유 함수로 두고, 클래스는 그것을 표로 감싸기만 한다.

/** 이상 반경 → 실제 반경. 닫힌형. */
export function distortRadius(ru: number, { k1 = 0, k2 = 0 }: Partial<Coeffs> = IDENTITY): number {
  const r2 = ru * ru;
  return ru * (1 + k1 * r2 + k2 * r2 * r2);
}

/**
 * 실제 반경 → 이상 반경. 닫힌 해가 없어 뉴턴으로 푼다.
 *
 * 도함수가 0 이하로 내려가면 그 반경에서 모델이 **접혀 있다**(물리적 렌즈가 아니다) → 반복을
 * 멈추고 마지막 값을 돌려준다. **발산해서 조용히 엉뚱한 곳을 조준하느니 보정을 덜 하는 게 낫다.**
 */
export function undistortRadius(rd: number, { k1 = 0, k2 = 0 }: Partial<Coeffs> = IDENTITY, maxIterations = 8, tolerance = 1e-9): number {
  if ((!k1 && !k2) || !Number.isFinite(rd) || rd === 0) return rd;
  let ru = rd;
  for (let i = 0; i < maxIterations; i++) {
    const r2 = ru * ru;
    const g = ru * (1 + k1 * r2 + k2 * r2 * r2) - rd;
    const dg = 1 + 3 * k1 * r2 + 5 * k2 * r2 * r2;
    if (!(dg > 1e-6)) break; // 모델이 접혔다 — 더 밀면 발산한다
    const next = ru - g / dg;
    if (!Number.isFinite(next) || next <= 0) break;
    const moved = Math.abs(next - ru);
    ru = next;
    if (moved < tolerance) break;
  }
  return ru;
}

/** 픽셀 점의 방사 변환. 반경만 바꾸고 방향은 보존한다. */
export function mapRadialPx(
  x: number,
  y: number,
  cx: number,
  cy: number,
  focal: number,
  c: Partial<Coeffs>,
  forward: boolean,
  maxIterations = 8,
  tolerance = 1e-9,
): MappedPoint {
  if ((!c.k1 && !c.k2) || !(focal > 0)) return { x, y, scale: 1 };
  const dx = Number(x) - cx;
  const dy = Number(y) - cy;
  const rpx = Math.hypot(dx, dy);
  if (rpx < 1e-9) return { x, y, scale: 1 };
  const rIn = rpx / focal;
  const rOut = forward ? distortRadius(rIn, c) : undistortRadius(rIn, c, maxIterations, tolerance);
  const scale = rOut / rIn;
  return { x: cx + dx * scale, y: cy + dy * scale, scale };
}

export interface DistortionOptions {
  name?: string;
  /** 역산 뉴턴 반복 상한. */
  maxIterations?: number;
  /** 역산 수렴 판정(정규화 반경 기준). */
  tolerance?: number;
}

/** 점 변환 결과. scale = r_out/r_in (1 이면 변환 없음 — 디버깅에 유용하다). */
export interface MappedPoint {
  x: number;
  y: number;
  scale: number;
}

export interface MapArgs {
  x: number;
  y: number;
  /** 주변축 초점거리(px). 정규화 반경 r = r_px/f 의 분모. */
  focal: number;
  zoom: number;
  cx: number;
  cy: number;
  /** 표를 무시하고 계수를 직접 지정(솔버가 후보 계수를 시험할 때 쓴다). */
  k1?: number;
  k2?: number;
}

export class LensDistortion {
  private readonly k1Curve: ZoomCurve;
  private readonly k2Curve: ZoomCurve;
  /** 메타데이터(adopted·rms·n)를 잃지 않기 위해 원본 앵커를 보관한다. */
  private readonly points: DistortionPoint[];

  readonly name: string;
  readonly maxIterations: number;
  readonly tolerance: number;

  constructor(points: readonly DistortionPoint[], { name = 'lensDistortion', maxIterations = 8, tolerance = 1e-9 }: DistortionOptions = {}) {
    if (!Array.isArray(points) || points.length === 0) {
      throw new TypeError(`${name}: [{ z, k1, k2 }] 형태의 비어있지 않은 배열이어야 합니다.`);
    }
    // k1 은 배럴에서 음수이고 k2 는 0 일 수 있다 — 두 곡선 다 부호 제약을 걸지 않는다.
    this.k1Curve = new ZoomCurve(points, 'k1', { name: `${name}.k1`, positive: false });
    this.k2Curve = new ZoomCurve(
      points.map((p) => ({ z: p.z, k2: p.k2 ?? 0 })),
      'k2',
      { name: `${name}.k2`, positive: false },
    );
    this.points = points.map((p) => ({ ...p, k2: p.k2 ?? 0 }));
    this.name = name;
    this.maxIterations = maxIterations;
    this.tolerance = tolerance;
  }

  get length(): number {
    return this.k1Curve.length;
  }

  get domain(): [number, number] {
    return this.k1Curve.domain;
  }

  /** 줌 → 계수. 구간선형 + 양끝 클램프(★외삽 금지) — 앞의 두 표와 같은 규약. */
  coeffsAt(zoom: number): Coeffs {
    return { k1: this.k1Curve.at(zoom), k2: this.k2Curve.at(zoom) };
  }

  /** 이 줌에서 왜곡이 사실상 없는가. */
  isIdentityAt(zoom: number): boolean {
    const c = this.coeffsAt(zoom);
    return c.k1 === 0 && c.k2 === 0;
  }

  /** 채택된 앵커가 하나라도 있는가 = 이 표가 실제로 무언가를 보정하는가. */
  get hasAnyDistortion(): boolean {
    return this.points.some((p) => p.k1 !== 0 || (p.k2 ?? 0) !== 0);
  }

  // ── 반경 변환 (정규화) ────────────────────────────────────────────────────

  /** 이상 반경 → 실제 반경. 자유 함수 distortRadius 위임. */
  static distortRadius(ru: number, coeffs: Partial<Coeffs> = IDENTITY): number {
    return distortRadius(ru, coeffs);
  }

  /** 실제 반경 → 이상 반경. 이 인스턴스의 뉴턴 설정으로 자유 함수 위임. */
  undistortRadius(rd: number, coeffs: Partial<Coeffs> = IDENTITY): number {
    return undistortRadius(rd, coeffs, this.maxIterations, this.tolerance);
  }

  // ── 점 변환 ───────────────────────────────────────────────────────────────

  /** 이상(핀홀) 픽셀 → 실제 이미지 픽셀. **그릴 때**. */
  distort(args: MapArgs): MappedPoint {
    return this.map(args, true);
  }

  /** 실제 이미지 픽셀 → 이상(핀홀) 픽셀. **조준할 때**. */
  undistort(args: MapArgs): MappedPoint {
    return this.map(args, false);
  }

  private map({ x, y, focal, zoom, cx, cy, k1, k2 }: MapArgs, forward: boolean): MappedPoint {
    const c: Coeffs = k1 === undefined && k2 === undefined ? this.coeffsAt(zoom) : { k1: k1 ?? 0, k2: k2 ?? 0 };
    return mapRadialPx(x, y, cx, cy, focal, c, forward, this.maxIterations, this.tolerance);
  }

  /**
   * 진단: 이 줌에서 프레임 코너가 왜곡 때문에 몇 픽셀 밀리나.
   * **채택 게이트가 읽는 숫자다** — 측정된 왜곡이 눈에 보이는 크기인지 판단하는 단 하나의 값.
   */
  maxShiftPx({ zoom, focal, cx, cy }: { zoom: number; focal: number; cx: number; cy: number }): number {
    const c = this.coeffsAt(zoom);
    if ((!c.k1 && !c.k2) || !(focal > 0)) return 0;
    const ru = Math.hypot(cx, cy) / focal;
    return Math.abs(LensDistortion.distortRadius(ru, c) - ru) * focal;
  }

  /** 저장 가능한 원래 모양으로(메타데이터 보존). */
  toJSON(digits = 5): DistortionPoint[] {
    const round = (v: number): number => Number(v.toFixed(digits));
    return this.points.map((p) => ({
      ...p,
      k1: round(p.k1),
      k2: round(p.k2 ?? 0),
    }));
  }

  /** 사람이 읽을 요약 한 줄. */
  describe(): string {
    const [z0, z1] = this.domain;
    const adopted = this.points.filter((p) => p.adopted !== false).length;
    return `곡면율 ${this.length}점(채택 ${adopted}) · k1 ${this.coeffsAt(z0).k1.toFixed(4)}(z${z0})→${this.coeffsAt(z1).k1.toFixed(4)}(z${z1})`;
  }

  /** null 이면 null(=곡면율 모델 없음 → 조준 경로에서 항등). */
  static from(points: readonly DistortionPoint[] | LensDistortion | null | undefined, options?: DistortionOptions): LensDistortion | null {
    if (!points) return null;
    if (points instanceof LensDistortion) return points;
    if (!points.length) return null;
    return new LensDistortion(points, options);
  }
}
