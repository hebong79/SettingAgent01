import { describe, it, expect } from 'vitest';
import { PlatePtz, type PlatePtzDeps, type PlatePtzOpts } from '../src/calibrate/platePtz.js';
import { scaleGainForZoom, predictPlateCenter, predictCenterAfterZoom } from '../src/calibrate/controlMath.js';
import type { ICameraClient } from '../src/clients/CameraClient.js';
import { LpdApiError, type LpdClient, type PlateBox } from '../src/clients/LpdClient.js';
import { rectToQuad, quadBoundingRect } from '../src/domain/geometry.js';
import type { Ptz } from '../src/calibrate/types.js';

/**
 * 구현자(developer): PlatePtz 유닛(설계 §6 — 1~12 + 13~20). camera/lpd 모킹, sleep 0ms 주입 — HTTP 없음.
 * ★ 명령 PTZ 추적 재현: 모킹 LPD 가 응답 PTZ 가 아닌 "명령한 PTZ"(requestImage ptz override)로
 *   번호판 위치/폭을 만들고, requestImage 응답은 시뮬과 같은 echo 0/0/1 을 돌려준다.
 *
 * ★ r2: 공통 모킹 모델을 **실측 물리로 고정**한다(설계 §6). r1 모델은 게인 부호가 물리와 반대(+50)라
 *   유닛이 green 인 채 라이브가 터졌다 — 모델이 물리를 재현하지 못하면 green 은 무의미하다.
 *   참값 출처: `_workspace/_live/diagSweep.mts`(추적 휴리스틱 없이 전체 검출 목록의 공통 변위 측정)
 *     zoom 1.69341 고정 · pan 22→23 dx=−0.0273 / 22→24 dx=−0.0546(완전 선형) → gainPan ≈ −36.6
 *     zoom 1.69341 고정 · tilt 6.8→7.8 dy=−0.0477 / →8.8 dy=−0.0948      → gainTilt ≈ −21.0
 *     zoomRef=1 환산 −62.0 / −35.5. 번호판 6개 간격 ≈0.15. LPD 결정적(동일 PTZ 5회 → 동일 목록).
 */

const START: Ptz = { pan: 0, tilt: 0, zoom: 1 };
/** 테스트 기본 opts — settleMs 0, 나머지는 케이스별 지정. */
const BASE: PlatePtzOpts = { settleMs: 0 };

/** 명령 PTZ → 번호판 목록 모델을 주입받는 camera+lpd 스텁. moves = 명령 PTZ 궤적. */
function makeMock(model: (ptz: Ptz, callIdx: number) => PlateBox[]) {
  const moves: Ptz[] = [];
  let calls = 0;
  const camera = {
    clampZoom: (z: number) => Math.min(36, Math.max(1, z)),
    requestImage: async (_c: number, _p: number, ptz?: { pan?: number; tilt?: number; zoom?: number }) => {
      moves.push({ pan: ptz?.pan ?? 0, tilt: ptz?.tilt ?? 0, zoom: ptz?.zoom ?? 1 });
      // 응답 echo 는 0/0/1 고정 — 신뢰 불가 가정 재현(★).
      return { camIdx: 1, presetIdx: 1, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('img') };
    },
  } as unknown as ICameraClient;

  const lpd = {
    detect: async (): Promise<PlateBox[]> => model(moves[moves.length - 1], calls++),
  } as unknown as LpdClient;

  return { camera, lpd, moves, callCount: () => moves.length };
}

/** 중심(cx,cy)·폭 w 의 축정렬 번호판 1개. conf 로 신원 태깅. */
function plateAt(cx: number, cy: number, w: number, h = 0.03, conf = 0.9): PlateBox {
  return { quad: rectToQuad({ x: cx - w / 2, y: cy - h / 2, w, h }), confidence: conf, cls: 'plate' };
}

function makePtz(m: ReturnType<typeof makeMock>, opts: PlatePtzOpts = {}): PlatePtz {
  const deps: PlatePtzDeps = { camera: m.camera, lpd: m.lpd, sleep: async () => {} };
  return new PlatePtz(deps, { ...BASE, ...opts });
}

/**
 * 실측 물리 모델(설계 §6 r2 공통 모델).
 *   게인 ∝ 1/zoom 이고 **음수**: gain(z) = gainRef1/z  (gainRef1 = zoomRef 1 기준 게인)
 *   변위    cx′ = cx + dPan·z/gainPanRef1     (z=1.69341 · 1° → −0.0273 = 실측)
 *   방사확대 zoom 변경 시 화면 중심 기준 ×zNew/zOld,  폭 ∝ zoom
 * → 카메라가 움직이면 **모든 번호판이 함께 이동**한다(신원 전환의 원인 재현).
 *   cx_i = 0.5 + (ax_i + pan)·z/gainPanRef1,  cy = 0.5 + (aY + tilt)·z/gainTiltRef1,  w = w0·z/z0
 * 화면(0~1) 밖으로 나간 번호판은 미검출. confidence 가 신원 태그.
 */
function makeWorld(cfg: {
  z0: number;
  gainPanRef1: number;
  gainTiltRef1: number;
  aX: number[];
  aY: number;
  w0: number;
  /** aliasing 미끼(선택): base 프레임엔 없다가 카메라가 pan 하면 공백 위치에 등장하는 검출. */
  decoyAx?: number;
}) {
  return (ptz: Ptz): PlateBox[] => {
    const kx = ptz.zoom / cfg.gainPanRef1;
    const ky = ptz.zoom / cfg.gainTiltRef1;
    const w = Math.min(0.9, cfg.w0 * (ptz.zoom / cfg.z0));
    const cy = 0.5 + (cfg.aY + ptz.tilt) * ky;
    if (cy < 0 || cy > 1) return [];
    const out: PlateBox[] = [];
    cfg.aX.forEach((ax, i) => {
      const cx = 0.5 + (ax + ptz.pan) * kx;
      if (cx >= 0 && cx <= 1) out.push(plateAt(cx, cy, w, 0.03, 0.9 + i * 0.01));
    });
    // 미끼: base 목록(pan22)엔 없던 검출이 pan 이동 후 공백(0.427~0.702)에 등장한다.
    // 실측 재현 — pan23 프레임의 0.540, pan25 프레임의 0.488. r1 은 이 미끼를 대상으로 오매칭해
    // 허상 게인 +49 를 자기확증했다(§2.7).
    if (cfg.decoyAx !== undefined && ptz.pan !== 0) {
      const cx = 0.5 + (cfg.decoyAx + ptz.pan) * kx;
      if (cx >= 0 && cx <= 1) out.push(plateAt(cx, cy, w, 0.03, DECOY_CONF));
    }
    return out;
  };
}

// ── 라이브 실측 상수(diagSweep 참값) ────────────────────────────────────────────
/** zoomRef=1 기준 게인(둘 다 음수) + base zoom·폭. */
const LIVE = { z0: 1.69341, gainPanRef1: -62, gainTiltRef1: -35.5, w0: 0.0274 };
/** base(pan22 / tilt6.8 / z1.69341) 실측 번호판 cx 6개 — 간격 ≈0.15. 대상 = index 2(cx 0.427 = 중심 최근접). */
const LIVE_CX6 = [0.116, 0.274, 0.427, 0.702, 0.812, 0.928];
/** base cy — errY = +0.171. */
const LIVE_CY = 0.671;
/** 미끼의 base 환산 cx(실측 pan23 의 0.540 / pan25 의 0.488 에서 역산). base 프레임엔 미검출. */
const LIVE_DECOY_CX = 0.569;
const TARGET_CONF = 0.92; // LIVE_CX6 index 2
const DECOY_CONF = 0.85;

/** 화면 좌표(base 프레임) → 모델의 각 오프셋(°). */
const axOf = (cx: number) => (cx - 0.5) * (LIVE.gainPanRef1 / LIVE.z0); // ×(−36.6114)
const ayOf = (cy: number) => (cy - 0.5) * (LIVE.gainTiltRef1 / LIVE.z0); // ×(−20.9639)

/** base 프레임에서의 실효 게인(= @z1.69341). 실측 −36.6 / −21.0. */
const GAIN_PAN_Z0 = LIVE.gainPanRef1 / LIVE.z0;
const GAIN_TILT_Z0 = LIVE.gainTiltRef1 / LIVE.z0;
const LIVE_START: Ptz = { pan: 0, tilt: 0, zoom: LIVE.z0 };

/**
 * ★ 공통 실측 모델 — 센터링·줌 케이스 전반의 표준 픽스처(r1 의 +50/−25 모델을 대체).
 * 번호판 6개 동반 이동 + 공백을 메우는 미끼 검출.
 */
const centerModel = makeWorld({
  z0: LIVE.z0,
  gainPanRef1: LIVE.gainPanRef1,
  gainTiltRef1: LIVE.gainTiltRef1,
  aX: LIVE_CX6.map(axOf),
  aY: ayOf(LIVE_CY),
  w0: LIVE.w0,
  decoyAx: axOf(LIVE_DECOY_CX),
});

/** 표준 줌 모델: 중심 고정(0.5,0.5), w=0.05*zoom → 목표폭 0.2 는 zoom≈4. */
const zoomModel = (ptz: Ptz): PlateBox[] => [plateAt(0.5, 0.5, Math.min(0.9, 0.05 * ptz.zoom))];

/** 중심 (cx,cy) 둘레로 θ(rad) 회전한 OBB. 장변 L · 단변 h — 실제 기울어진 번호판 재현. */
function rotatedPlateAt(cx: number, cy: number, L: number, h: number, rad: number, conf = 0.9): PlateBox {
  const co = Math.cos(rad);
  const si = Math.sin(rad);
  const corners: [number, number][] = [
    [-L / 2, -h / 2],
    [L / 2, -h / 2],
    [L / 2, h / 2],
    [-L / 2, h / 2],
  ];
  const quad = corners.map(([x, y]) => ({ x: cx + x * co - y * si, y: cy + x * si + y * co }));
  return { quad: quad as PlateBox['quad'], confidence: conf, cls: 'plate' };
}

/** 기울어진 번호판(12°) 줌 모델: 중심 고정, 장변 L=0.05·z · 단변 h=0.012·z. */
const TILTED_RAD = (12 * Math.PI) / 180;
const TILTED_L0 = 0.05;
const TILTED_H0 = 0.012;
const tiltedZoomModel = (ptz: Ptz): PlateBox[] => [
  rotatedPlateAt(0.5, 0.5, TILTED_L0 * ptz.zoom, TILTED_H0 * ptz.zoom, TILTED_RAD),
];

describe('1. centerOnPlate 수렴', () => {
  it('중심 수렴 + 모든 명령의 zoom 이 startPtz.zoom 고정(pan/tilt 만 변경)', async () => {
    const m = makeMock(centerModel);
    const r = await makePtz(m).centerOnPlate(1, 1, LIVE_START);
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(Math.abs(r.err!.errX)).toBeLessThanOrEqual(0.03);
    expect(Math.abs(r.err!.errY)).toBeLessThanOrEqual(0.03);
    // zoom 불변 계약: 명령 PTZ 전량이 startPtz.zoom.
    expect(m.moves.every((mv) => mv.zoom === LIVE_START.zoom)).toBe(true);
    expect(r.ptz.zoom).toBe(LIVE_START.zoom);
    expect(r.iterations).toBeGreaterThan(0);
    // ★ 자기보고 게인의 부호가 실측(음수)과 일치 — r1 은 여기서 +를 보고했다.
    expect(r.gain.gainPan).toBeLessThan(0);
    expect(r.gain.gainTilt).toBeLessThan(0);
    expect(r.gain.gainPan).toBeCloseTo(GAIN_PAN_Z0, 3); // ≈ −36.61
    expect(r.gain.gainTilt).toBeCloseTo(GAIN_TILT_Z0, 3); // ≈ −20.96
    expect(r.gain.zoomRef).toBe(LIVE_START.zoom);
  });
});

describe('2. centerOnPlate 시작 무검출', () => {
  it('detect=[] → no_plate, iterations=0', async () => {
    const m = makeMock(() => []);
    const r = await makePtz(m).centerOnPlate(1, 1, LIVE_START);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_plate');
    expect(r.iterations).toBe(0);
    expect(r.plate).toBeNull();
    expect(m.callCount()).toBe(1); // probe 미발생
  });
});

describe('3. centerOnPlate 도중 소실', () => {
  it('N회째부터 [] → plate_lost, ptz=마지막 명령값', async () => {
    // 0:초기 1:probe → 2회째(iter1)부터 소실.
    const m = makeMock((ptz, i) => (i >= 2 ? [] : centerModel(ptz)));
    const r = await makePtz(m).centerOnPlate(1, 1, LIVE_START);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('plate_lost');
    expect(r.ptz).toEqual(m.moves[m.moves.length - 1]); // 마지막 명령 PTZ = 복구 재료
    expect(r.iterations).toBe(1);
  });
});

describe('4. centerOnPlate probe 실패 → fallback 게인', () => {
  it('probe 프레임 미검출 → fallback 게인(−62/−35.5 @zoomRef=1)으로도 수렴', async () => {
    // probe 프레임만 미검출(i===1) → estimateGain 이전 단계에서 fallback 확정.
    // r2 fallback 은 실측 참값 그 자체 → 실측 물리 모델에서 fallback 만으로 수렴한다.
    const m = makeMock((ptz, i) => (i === 1 ? [] : centerModel(ptz)));
    const r = await makePtz(m).centerOnPlate(1, 1, LIVE_START);
    expect(r.ok).toBe(true);
    // 시작 zoom 으로 스케일된 fallback 이 그대로 쓰였다.
    expect(r.gain.gainPan).toBeCloseTo(GAIN_PAN_Z0, 6);
    expect(r.gain.gainTilt).toBeCloseTo(GAIN_TILT_Z0, 6);
    expect(r.gain.zoomRef).toBe(LIVE.z0);
    expect(Math.abs(r.err!.errX)).toBeLessThanOrEqual(0.03);
    expect(Math.abs(r.err!.errY)).toBeLessThanOrEqual(0.03);
  });
});

describe('5. centerOnPlate 이미 중심', () => {
  it('cx=cy=0.5 → 즉시 ok, iterations=0, probe 캡처 미발생', async () => {
    const m = makeMock(() => [plateAt(0.5, 0.5, 0.05)]);
    const r = await makePtz(m).centerOnPlate(1, 1, START);
    expect(r.ok).toBe(true);
    expect(r.iterations).toBe(0);
    expect(m.callCount()).toBe(1); // 최초 캡처 1회뿐 = probe 생략
    expect(r.ptz).toEqual(START);
  });
});

describe('6. zoomToPlateWidth 단독 수렴', () => {
  it('폭 0.2±0.02 수렴, pan/tilt 불변(가드 미발동)', async () => {
    const m = makeMock(zoomModel);
    const r = await makePtz(m).zoomToPlateWidth(1, 1, START);
    expect(r.ok).toBe(true);
    expect(r.plateWidth!).toBeGreaterThanOrEqual(0.18);
    expect(r.plateWidth!).toBeLessThanOrEqual(0.22);
    expect(r.ptz.zoom).toBeGreaterThan(3);
    expect(r.ptz.zoom).toBeLessThan(5);
    // 드리프트 없음 → pan/tilt 명령 전량 startPtz 유지.
    expect(m.moves.every((mv) => mv.pan === START.pan && mv.tilt === START.tilt)).toBe(true);
  });
});

describe('7. zoom 드리프트 가드', () => {
  it('zoom↑ 로 중심 오차가 tol 밖이 되면 그 반복은 줌 보류·재중심 후 수렴, opts.gain 사용', async () => {
    // 축에서 0.5° 벗어난 번호판: errX = 0.5·z/(−50) → zoom 이 오를수록 방사 확대(z≈3.5 에서 tol 0.03 돌파).
    const world = makeWorld({ z0: 1, gainPanRef1: -50, gainTiltRef1: -25, aX: [0.5], aY: 0, w0: 0.05 });
    const m = makeMock(world);
    const gain = { gainPan: -50, gainTilt: -25, zoomRef: 1 };
    const r = await makePtz(m, { gain }).zoomToPlateWidth(1, 1, START);
    expect(r.ok).toBe(true);
    expect(r.plateWidth!).toBeGreaterThanOrEqual(0.18);
    expect(r.plateWidth!).toBeLessThanOrEqual(0.22);
    expect(r.gain).toEqual(gain);
    // 가드 발동: 전달 게인을 현재 zoom 으로 스케일한 1스텝 재중심(각 오프셋 0.5° 상쇄).
    expect(m.moves.some((mv) => mv.pan !== 0)).toBe(true);
    expect(r.ptz.pan).toBeCloseTo(-0.5, 2);
    expect(Math.abs(r.err!.errX)).toBeLessThanOrEqual(0.03);
  });
});

describe('8. zoom 포화', () => {
  it('zoom 상한(36)인데 폭 미달 → zoom_saturated', async () => {
    const m = makeMock((ptz) => [plateAt(0.5, 0.5, 0.004 * ptz.zoom)]);
    const r = await makePtz(m).zoomToPlateWidth(1, 1, START);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('zoom_saturated');
    expect(r.ptz.zoom).toBe(36);
    expect(r.plateWidth!).toBeCloseTo(0.144, 3);
  });
});

describe('9. 반복 상한', () => {
  it('보정 반응이 극히 둔한 모델 → max_iterations, iterations=maxIterations', async () => {
    // 실게인 −1000(1° 당 변위 0.001) → maxStepDeg 5° 로도 반복당 0.005 개선 → 5회 내 미수렴.
    // fallback 을 모델 게인에 맞춰 두어 예측 prior 가 정확 → 매칭 유지(소실이 아닌 "미수렴" 경로를 태운다).
    const m = makeMock((ptz) => [plateAt(0.8 + ptz.pan / -1000, 0.8 + ptz.tilt / -1000, 0.05)]);
    const r = await makePtz(m, { maxIterations: 5, fallbackGainPanDeg: -1000, fallbackGainTiltDeg: -1000 }).centerOnPlate(1, 1, START);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('max_iterations');
    expect(r.iterations).toBe(5);
  });
});

describe('10. 독립성(상호 호출 없음)', () => {
  it('zoomToPlateWidth 를 centerOnPlate 없이 단독 실행 → green', async () => {
    const m = makeMock(zoomModel);
    const r = await makePtz(m).zoomToPlateWidth(1, 1, START);
    expect(r.ok).toBe(true);
  });

  it('centerOnPlate 를 zoom 없이 단독 실행 → green, zoom 명령 0건', async () => {
    const m = makeMock(centerModel);
    const r = await makePtz(m).centerOnPlate(1, 1, { pan: 0, tilt: 0, zoom: 2 });
    expect(r.ok).toBe(true);
    expect(m.moves.every((mv) => mv.zoom === 2)).toBe(true);
  });

  it('센터링 → 줌 체이닝(호출측 조합)도 동작', async () => {
    const m = makeMock(centerModel);
    const p = makePtz(m);
    const c = await p.centerOnPlate(1, 1, LIVE_START);
    expect(c.ok).toBe(true);
    const z = await makePtz(m, { gain: c.gain }).zoomToPlateWidth(1, 1, c.ptz);
    expect(z.ok).toBe(true);
    expect(z.plateWidth!).toBeGreaterThanOrEqual(0.18);
    expect(z.plateWidth!).toBeLessThanOrEqual(0.22);
  });
});

describe('11. 다수 번호판 prior', () => {
  it('plateRoi 최근접(pickNearestPlate) 으로 지정측만 초기 선정', async () => {
    // 번호판 6개 중 화면 중심 최근접(0.427)이 아니라 plateRoi 가 가리키는 0.702(index 3)를 잡아야 한다.
    const m = makeMock(centerModel);
    const plateRoi = { x: 0.702 - 0.05, y: LIVE_CY - 0.05, w: 0.1, h: 0.1 };
    const r = await makePtz(m, { plateRoi }).centerOnPlate(1, 1, LIVE_START);
    expect(r.ok).toBe(true);
    expect(r.plate!.confidence).toBeCloseTo(0.93, 6); // index 3 = 지정측
    expect(Math.abs(r.err!.errX)).toBeLessThanOrEqual(0.03);
    expect(Math.abs(r.err!.errY)).toBeLessThanOrEqual(0.03);
  });
});

describe('12. 전송 오류 전파', () => {
  it('LpdApiError → reason 강등 아닌 reject 전파', async () => {
    const m = makeMock(centerModel);
    const lpd = {
      detect: async () => {
        throw new LpdApiError('LPD 검출 오류: HTTP 500', 500);
      },
    } as unknown as LpdClient;
    const p = new PlatePtz({ camera: m.camera, lpd, sleep: async () => {} }, BASE);
    await expect(p.centerOnPlate(1, 1, LIVE_START)).rejects.toThrow(LpdApiError);
    await expect(p.zoomToPlateWidth(1, 1, LIVE_START)).rejects.toThrow(LpdApiError);
  });
});

// ── 라이브 실패 모드를 실측 물리 모킹으로 재현(설계 §6 의 13~20) ────────────────────

describe('13. 신원 전환 재현·차단(실측 A)', () => {
  it('번호판 6개(간격 0.15) 동반 이동 상황에서 초기 선정 번호판을 끝까지 추적해 수렴', async () => {
    const m = makeMock(centerModel);
    const r = await makePtz(m).centerOnPlate(1, 1, LIVE_START);
    expect(r.ok).toBe(true);
    // 화면 중심 최근접(errX=−0.073)으로 초기 선정된 대상의 신원이 끝까지 유지되어야 한다.
    expect(r.plate!.confidence).toBeCloseTo(TARGET_CONF, 6);
    expect(r.iterations).toBeLessThan(8);
    expect(Math.abs(r.err!.errX)).toBeLessThanOrEqual(0.03);
    expect(Math.abs(r.err!.errY)).toBeLessThanOrEqual(0.03);
    // 게인 붕괴·부호 반전 부재: 실측 −36.6/−21.0 정합.
    expect(r.gain.gainPan).toBeCloseTo(GAIN_PAN_Z0, 3);
    expect(r.gain.gainTilt).toBeCloseTo(GAIN_TILT_Z0, 3);
    expect(r.gain.zoomRef).toBe(LIVE.z0);
  });
});

describe('14. damp 죽음의 나선 차단(실측 A 근본원인)', () => {
  it('개선이 계속 정체해도 감쇠는 3회까지 — 최종 게인 ≥ 초기의 1/8', async () => {
    // 실게인 −20000(5° 명령에도 변위 2.5e-4) → 매 반복 improvement < 1e-3 → damp 조건 상시 성립.
    const m = makeMock((ptz) => [plateAt(0.8 + ptz.pan / -20000, 0.8 + ptz.tilt / -20000, 0.05)]);
    const r = await makePtz(m, { fallbackGainPanDeg: -20000, fallbackGainTiltDeg: -20000 }).centerOnPlate(1, 1, START);
    expect(r.reason).toBe('max_iterations');
    expect(r.iterations).toBe(15);
    // 상한 없으면 20000·0.5^15 ≈ 0.61 로 게인 소멸(실측 A). 상한 3회 → 20000/8 = 2500.
    expect(Math.abs(r.gain.gainPan)).toBeGreaterThanOrEqual(20000 / 8 - 1);
    expect(r.gain.gainPan).toBeCloseTo(-2500, 0);
    expect(r.gain.gainTilt).toBeCloseTo(-2500, 0);
  });
});

describe('15. zoom 단독 성공 계약(실측 C 재현)', () => {
  it('base 오차(−0.073, 0.171)에서 zoomToPlateWidth 단독 호출 → 폭 수렴, plate_lost 없음', async () => {
    const m = makeMock(centerModel);
    const r = await makePtz(m).zoomToPlateWidth(1, 1, LIVE_START);
    expect(r.reason).toBeUndefined(); // ★ r0 는 여기서 plate_lost 였다
    expect(r.ok).toBe(true);
    expect(r.plateWidth!).toBeGreaterThanOrEqual(0.18);
    expect(r.plateWidth!).toBeLessThanOrEqual(0.22);
    expect(r.plate!.confidence).toBeCloseTo(TARGET_CONF, 6); // 신원 유지(미끼·이웃에 갈아타지 않음)
    // 가드 선행: 확대 전에 중심이 tol 안으로 들어왔다.
    expect(Math.abs(r.err!.errX)).toBeLessThanOrEqual(0.03);
    expect(Math.abs(r.err!.errY)).toBeLessThanOrEqual(0.03);
    expect(r.ptz.zoom).toBeGreaterThan(7);
  });
});

describe('16. 게인 zoom 스케일 체이닝(실측 B 재현)', () => {
  it('zoom 10 에서 가드 명령 크기·방향이 scaleGainForZoom(≈×1.69/10, 음수 유지) 결과와 일치', async () => {
    const aX = axOf(0.427); // 대상 번호판의 각 오프셋
    const aY = -0.2;
    const world = makeWorld({ z0: LIVE.z0, gainPanRef1: LIVE.gainPanRef1, gainTiltRef1: LIVE.gainTiltRef1, aX: [aX], aY, w0: LIVE.w0 });
    const m = makeMock(world);
    // 체이닝 게인 = centerOnPlate 실측 상당(−36.6/−21.0 @z1.69341).
    const gain = { gainPan: -36.6, gainTilt: -21.0, zoomRef: LIVE.z0 };
    const start: Ptz = { pan: 0, tilt: 0, zoom: 10 };
    const r = await makePtz(m, { gain }).zoomToPlateWidth(1, 1, start);

    const eff = scaleGainForZoom(gain, 10); // ≈ {−6.198, −3.556} — ★음수 보존
    expect(eff.gainPan).toBeLessThan(0);
    const err0 = { errX: (aX * 10) / LIVE.gainPanRef1, errY: (aY * 10) / LIVE.gainTiltRef1 };
    // moves[0] = 초기 캡처, moves[1] = 첫 가드 명령.
    expect(m.moves[1]!.pan).toBeCloseTo(-err0.errX * eff.gainPan, 6); // ≈ −2.67 (스케일 미적용이면 clamp 로 −5.0)
    expect(m.moves[1]!.tilt).toBeCloseTo(-err0.errY * eff.gainTilt, 6);
    expect(Math.abs(m.moves[1]!.pan)).toBeLessThan(5); // ★ 무스케일 게인이면 maxStepDeg 로 포화
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
  });
});

describe('17. 매칭 기각 반경', () => {
  it('대상이 1프레임 누락되면 이웃(거리 0.15)·미끼로 갈아타지 않고 plate_lost', async () => {
    // 0:초기 1:probe → 2(iter1)에서 대상(index 2)만 검출 누락, 이웃·미끼는 그대로.
    const m = makeMock((ptz, i) => {
      const ps = centerModel(ptz);
      return i === 2 ? ps.filter((p) => Math.abs(p.confidence - TARGET_CONF) > 1e-9) : ps;
    });
    const r = await makePtz(m).centerOnPlate(1, 1, LIVE_START);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('plate_lost'); // 이웃 갈아타기(신원 절도) 차단
    expect(r.plate!.confidence).toBeCloseTo(TARGET_CONF, 6); // 마지막으로 본 대상은 여전히 원래 신원
  });
});

describe('18. 줌 스텝비 클램프', () => {
  it('7.3배 증배가 필요해도 인접 zoom 비 ≤ 1.5 로 나눠 올리며 수렴', async () => {
    const world = makeWorld({ z0: LIVE.z0, gainPanRef1: LIVE.gainPanRef1, gainTiltRef1: LIVE.gainTiltRef1, aX: [0], aY: 0, w0: LIVE.w0 });
    const m = makeMock(world);
    const r = await makePtz(m).zoomToPlateWidth(1, 1, LIVE_START);
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(r.plateWidth!).toBeGreaterThanOrEqual(0.18);
    expect(r.plateWidth!).toBeLessThanOrEqual(0.22);
    // 목표까지 sqrt 해가 요구하는 증배는 0.2/0.0274 ≈ 7.3배(=1스텝 점프 시 중심오차도 7.3배 확대).
    // 첫 줌 명령이 그 해가 아니라 스텝비 상한(z0·1.5)으로 잘려 나갔음을 본다.
    expect(m.moves[1]!.zoom).toBeCloseTo(LIVE.z0 * 1.5, 6);
    expect(r.ptz.zoom / LIVE.z0).toBeGreaterThan(6); // 여러 스텝에 나눠 6배 이상 증배해 tol 안에 안착
    for (let i = 1; i < m.moves.length; i++) {
      const ratio = m.moves[i]!.zoom / m.moves[i - 1]!.zoom;
      expect(ratio).toBeLessThanOrEqual(1.5 + 1e-9);
      expect(ratio).toBeGreaterThanOrEqual(1 / 1.5 - 1e-9);
    }
  });
});

describe('19. 신규 순수 함수 3종(controlMath)', () => {
  it('scaleGainForZoom: gain(z) = gain(zRef)·zRef/z — 부호 보존', () => {
    const g = { gainPan: GAIN_PAN_Z0, gainTilt: GAIN_TILT_Z0, zoomRef: LIVE.z0 }; // 실측 −36.61/−20.96 @z1.69341
    const at20 = scaleGainForZoom(g, 20);
    expect(at20.gainPan).toBeCloseTo(LIVE.gainPanRef1 / 20, 6); // = −62/20 = −3.1
    expect(at20.gainTilt).toBeCloseTo(LIVE.gainTiltRef1 / 20, 6); // = −35.5/20 = −1.775
    expect(at20.gainPan).toBeLessThan(0);
    // 기준 zoom 에서는 항등.
    const atRef = scaleGainForZoom(g, LIVE.z0);
    expect(atRef.gainPan).toBeCloseTo(GAIN_PAN_Z0, 6);
    expect(atRef.gainTilt).toBeCloseTo(GAIN_TILT_Z0, 6);
    // fallback(zoomRef=1, −62/−35.5) → base zoom 환산이 실측 게인(−36.6/−21.0)과 정합.
    const fb = scaleGainForZoom({ gainPan: -62, gainTilt: -35.5, zoomRef: 1 }, LIVE.z0);
    expect(fb.gainPan).toBeCloseTo(-36.61, 2);
    expect(fb.gainTilt).toBeCloseTo(-20.96, 2);
  });

  it('predictPlateCenter: c′ = c + dDeg/gain (estimateGain 역산), |gain|<eps 방어', () => {
    // 실측: z1.69341 에서 pan +1° → dx = −0.0273, tilt +1° → dy = −0.0477.
    const c = predictPlateCenter({ cx: 0.5, cy: 0.5 }, { dPan: 1, dTilt: 1 }, { gainPan: GAIN_PAN_Z0, gainTilt: GAIN_TILT_Z0 });
    expect(c.cx).toBeCloseTo(0.5 - 0.0273, 4);
    expect(c.cy).toBeCloseTo(0.5 - 0.0477, 4);
    // 게인 0 → 예측 불가 → 직전 중심 유지(발산 방지).
    expect(predictPlateCenter({ cx: 0.4, cy: 0.6 }, { dPan: 5, dTilt: 5 }, { gainPan: 0, gainTilt: 0 })).toEqual({ cx: 0.4, cy: 0.6 });
  });

  it('predictCenterAfterZoom: c′ = 0.5 + (c−0.5)·zNew/zOld, zoomFrom≈0 방어', () => {
    const c = predictCenterAfterZoom({ cx: 0.6, cy: 0.4 }, 1.69, 3.38);
    expect(c.cx).toBeCloseTo(0.7, 6);
    expect(c.cy).toBeCloseTo(0.3, 6);
    // 화면 중심은 zoom 에 불변.
    expect(predictCenterAfterZoom({ cx: 0.5, cy: 0.5 }, 1.69, 20)).toEqual({ cx: 0.5, cy: 0.5 });
    expect(predictCenterAfterZoom({ cx: 0.6, cy: 0.4 }, 0, 10)).toEqual({ cx: 0.6, cy: 0.4 });
  });
});

describe('20. probe 부호 자기확증 차단 — r1 라이브 실패의 유닛 재현', () => {
  // maxIterations:0 → 본 루프(P 제어·damp)를 태우지 않고 **probe 의 estimateGain 산출만** 격리 관측한다
  // (반환 gain 은 본 루프의 damp 로 감쇠되므로 부호·크기 관측에는 격리가 필요).
  const PROBE_ONLY: PlatePtzOpts = { maxIterations: 0 };

  it('r2 기본값(probe 1° · fallback −62/−35.5) → estimateGain 부호 음수, 크기 −36.6±15%', async () => {
    const m = makeMock(centerModel);
    const r = await makePtz(m, PROBE_ONLY).centerOnPlate(1, 1, LIVE_START);
    // ★ 허상 +49 가 나오면 red. probe 1° 변위 0.027 은 미끼(거리 0.14)를 사정권 밖에 둔다.
    expect(r.gain.gainPan).toBeLessThan(0);
    expect(r.gain.gainPan).toBeGreaterThanOrEqual(-36.6 * 1.15);
    expect(r.gain.gainPan).toBeLessThanOrEqual(-36.6 * 0.85);
    expect(r.gain.gainTilt).toBeLessThan(0);
    expect(r.gain.gainTilt).toBeGreaterThanOrEqual(-21.0 * 1.15);
    expect(r.gain.gainTilt).toBeLessThanOrEqual(-21.0 * 0.85);
  });

  it('★회귀 감시: r1 상수(probe 3° + fallback +75)를 되돌리면 같은 모델에서 허상 게인 +49 가 재현된다', async () => {
    // r1 라이브 실패의 정확한 메커니즘: 틀린 부호의 fallback 이 만든 예측(cx 0.495)에서
    // 3° 변위(0.082 > 간격 절반 0.075)로 등장한 미끼(0.487)가 참 위치(0.345)보다 가까워
    // 반경 0.08 안에서 매칭 성공 → dX=+0.060 → gain=+50 자기확증(라이브 보고 +49.77).
    // 이 모델이 라이브 실패를 재현한다는 증거 = 위 케이스의 green 이 의미를 갖는 근거.
    const m = makeMock(centerModel);
    const r = await makePtz(m, { ...PROBE_ONLY, probeStepDeg: 3, fallbackGainPanDeg: 75, fallbackGainTiltDeg: -35 }).centerOnPlate(1, 1, LIVE_START);
    expect(r.gain.gainPan).toBeGreaterThan(40); // ★부호 반전 허상(라이브 보고 +49.77)
    expect(r.gain.gainPan).toBeLessThan(60);
    // 축 분리 확인: tilt 는 r1 에서도 부호가 맞았고(−35), 미끼가 같은 행이라 tilt 게인은 오염되지 않는다.
    expect(r.gain.gainTilt).toBeCloseTo(GAIN_TILT_Z0, 1);
  });
});

// ── 검증자(qa-tester) 추가 ────────────────────────────────────────────────────

describe('21. "화면 가로 20%" 정의 = quadBoundingRect(quad).w (설계 §4) — 기울어진 OBB', () => {
  // 기존 모킹 번호판은 전부 축정렬(rectToQuad)이라 §4 의 정의 결정(축정렬 boundingRect 폭 vs
  // OBB 장변)이 모듈을 통해 한 번도 구분되지 않았다. 실제 번호판은 기울어져 있고, 두 정의는
  // cosθ 만큼 갈린다 — 어느 쪽으로 수렴하는지가 마스터 요구 ②의 의미 자체다.
  it('기울어진 번호판도 boundingRect 폭 기준으로 0.2±0.02 수렴 — 장변 기준이 아님', async () => {
    const m = makeMock(tiltedZoomModel);
    const r = await makePtz(m).zoomToPlateWidth(1, 1, START);
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();

    // ① 보고된 폭은 축정렬 boundingRect 의 폭이다(quad 장변·중심 정의가 아니라).
    expect(quadBoundingRect(r.plate!.quad).w).toBeCloseTo(r.plateWidth!, 12);
    // ② 그 정의로 목표 수렴.
    expect(r.plateWidth!).toBeGreaterThanOrEqual(0.18);
    expect(r.plateWidth!).toBeLessThanOrEqual(0.22);

    // ③ 두 정의가 실제로 갈린다(= ①이 유의미한 구분): OBB 장변 L = 0.05·zoom.
    const obbLongEdge = TILTED_L0 * r.ptz.zoom;
    expect(Math.abs(obbLongEdge - r.plateWidth!)).toBeGreaterThan(1e-4);
    // ④ 설계 §4 의 근거 주장 검증 — 소각(<15°)에서 두 정의 차는 3.5% 이내(widthTol 0.02 = 10% 안).
    expect(Math.abs(obbLongEdge - r.plateWidth!) / r.plateWidth!).toBeLessThan(0.035);
  });
});
