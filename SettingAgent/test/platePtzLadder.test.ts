import { describe, it, expect } from 'vitest';
import { PlatePtz, type PlatePtzDeps, type PlatePtzOpts } from '../src/calibrate/platePtz.js';
import type { ICameraClient } from '../src/clients/CameraClient.js';
import type { LpdClient, PlateBox } from '../src/clients/LpdClient.js';
import { rectToQuad, quadBoundingRect } from '../src/domain/geometry.js';
import type { Ptz } from '../src/calibrate/types.js';

/**
 * 검증자(qa-tester): Requirement 1(반경 게이트) · 2(줌 사다리) · 3(명시 사유 실패) 유닛.
 * 계약: `_workspace/00_goal.md` · 설계 §8 T1~T5 · 구현자 인계 §7.
 *
 * 모델 규약은 platePtz.test.ts 와 동일(명령 PTZ 추적 · 응답 echo 불신 · 게인 음수 실측값).
 * 다만 사다리는 **카메라가 상태를 갖는다**(네이티브 setcenter 가 pan/tilt 를 직접 바꾼다) →
 * 스텁 카메라가 마지막 명령 PTZ 를 자기 상태로 들고, centerOnPoint 는 그 상태에서 기하적으로
 * 정확한 pan/tilt 를 계산해 반환한다(= "펌웨어가 자기 FOV 테이블로 정확히 변환"의 이상적 재현).
 */

// ── 실측 물리 상수(platePtz.test.ts 와 동일 출처: diagSweep) ────────────────────
const GAIN_PAN_REF1 = -62;
const GAIN_TILT_REF1 = -35.5;

interface WorldCfg {
  /** 각 판의 각(°) 오프셋과 기준폭(zoom=1 에서의 정규화 폭). conf 는 신원 태그. */
  plates: Array<{ ax: number; ay: number; w1: number; conf: number }>;
}

/** 각 오프셋 ↔ 화면좌표 변환(zoom z, 현재 pan/tilt 기준). cx = 0.5 + (ax+pan)·z/gainPanRef1 */
const kx = (z: number): number => z / GAIN_PAN_REF1;
const ky = (z: number): number => z / GAIN_TILT_REF1;

function plateAt(cx: number, cy: number, w: number, conf: number, h = 0.03): PlateBox {
  return { quad: rectToQuad({ x: cx - w / 2, y: cy - h / 2, w, h }), confidence: conf, cls: 'plate' };
}

/**
 * 상태 있는 스텁 카메라 + LPD.
 * - requestImage(ptz): 명령 PTZ 를 자기 상태로 삼고 기록. 응답 echo 는 0/0/1(신뢰 불가 재현).
 * - centerOnPoint(p): **정확한** 네이티브 센터링 — 현재 상태 기준 p 가 중앙에 오는 pan/tilt 반환+상태 갱신.
 *   `native` 옵션이 false 면 이 메서드를 아예 정의하지 않는다(미지원 소스 = 시뮬).
 * - getPtz: 현재 상태.
 * - move: 상태 갱신(기하 폴백 경로 관측용).
 */
function makeLadderMock(cfg: {
  world: WorldCfg;
  native: boolean;
  start: Ptz;
  zoomMax?: number;
  /** 프레임별 검출 목록을 가로채는 훅(대상 소실·이웃 등장 시나리오용). */
  override?: (ptz: Ptz, rung: number, base: PlateBox[]) => PlateBox[];
  /** 네이티브 setcenter 를 일부러 실패시킨다(aim_failed 경로). */
  nativeThrows?: boolean;
  /** getPtz 를 지원하지 않는 소스(강등 경로). */
  noGetPtz?: boolean;
  /** move 가 거절하는 소스(기하 aim_failed 경로). */
  moveFails?: boolean;
}) {
  const zoomMax = cfg.zoomMax ?? 36;
  let state: Ptz = { ...cfg.start };
  const captures: Ptz[] = [];
  const centerCalls: Array<{ cam: number; point: { x: number; y: number } }> = [];
  const moves: Ptz[] = [];
  let detectCalls = 0;

  const clampZoom = (z: number): number => Math.min(zoomMax, Math.max(1, z));

  const camera: Record<string, unknown> = {
    clampZoom,
    requestImage: async (_c: number, _p: number, ptz?: { pan?: number; tilt?: number; zoom?: number }) => {
      state = { pan: ptz?.pan ?? state.pan, tilt: ptz?.tilt ?? state.tilt, zoom: clampZoom(ptz?.zoom ?? state.zoom) };
      captures.push({ ...state });
      return { camIdx: 1, presetIdx: 1, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('img') };
    },
    getPtz: async (): Promise<Ptz> => {
      if (cfg.noGetPtz) throw new Error('소스는 PTZ 조회를 지원하지 않습니다');
      return { ...state };
    },
    move: async (_c: number, pan: number, tilt: number, zoom: number): Promise<boolean> => {
      moves.push({ pan, tilt, zoom });
      if (cfg.moveFails) return false;
      state = { pan, tilt, zoom: clampZoom(zoom) };
      return true;
    },
  };
  if (cfg.native) {
    camera.centerOnPoint = async (cam: number, point: { x: number; y: number }): Promise<Ptz> => {
      centerCalls.push({ cam, point });
      if (cfg.nativeThrows) throw new Error('setcenter 거절');
      // 화면 점 p 의 각 = (p−0.5)/k − pan → 그것을 0 으로 만드는 절대 pan/tilt.
      const pan = state.pan - (point.x - 0.5) / kx(state.zoom);
      const tilt = state.tilt - (point.y - 0.5) / ky(state.zoom);
      state = { ...state, pan, tilt };
      return { ...state };
    };
  }

  const lpd = {
    detect: async (): Promise<PlateBox[]> => {
      const ptz = captures[captures.length - 1]!;
      const base: PlateBox[] = [];
      for (const p of cfg.world.plates) {
        const cx = 0.5 + (p.ax + ptz.pan) * kx(ptz.zoom);
        const cy = 0.5 + (p.ay + ptz.tilt) * ky(ptz.zoom);
        const w = Math.min(0.9, p.w1 * ptz.zoom);
        if (cx >= 0 && cx <= 1 && cy >= 0 && cy <= 1) base.push(plateAt(cx, cy, w, p.conf));
      }
      const out = cfg.override ? cfg.override(ptz, detectCalls, base) : base;
      detectCalls += 1;
      return out;
    },
  } as unknown as LpdClient;

  return {
    camera: camera as unknown as ICameraClient,
    lpd,
    captures,
    centerCalls,
    moves,
    state: () => ({ ...state }),
  };
}

function makePtz(m: { camera: ICameraClient; lpd: LpdClient }, opts: PlatePtzOpts = {}): PlatePtz {
  const deps: PlatePtzDeps = { camera: m.camera, lpd: m.lpd, sleep: async () => {} };
  return new PlatePtz(deps, { settleMs: 0, nativeAimSettleMs: 0, ...opts });
}

/** 화면좌표(zoom z, pan/tilt=0 프레임 기준) → 각 오프셋. */
const axOf = (cx: number, z: number): number => (cx - 0.5) / kx(z);
const ayOf = (cy: number, z: number): number => (cy - 0.5) / ky(z);

const START: Ptz = { pan: 0, tilt: 0, zoom: 1 };

// ══════════════════════════════════════════════════════════════════════════════
// T1 — Requirement 1: 반경 밖 판만 있을 때 다른 판을 대신 채택하지 않는다(거짓 성공 제거)
// ══════════════════════════════════════════════════════════════════════════════
describe('T1. centerOnPlate 최초 선정 반경 게이트(거짓 성공 제거 — 1순위 목적)', () => {
  /**
   * ★ 마스터 실측 시나리오 재현: 클릭점 = 화면 좌측 끝(0.05, 0.5),
   *   검출된 판은 중앙 근처(0.48/0.55)에만 존재 → 반드시 실패해야 하고,
   *   반환 plate 가 중앙 판이어서는 안 된다.
   */
  const CENTER_PLATES: PlateBox[] = [plateAt(0.6, 0.5, 0.03, 0.91), plateAt(0.68, 0.52, 0.03, 0.92)];
  const CLICK = { x: 0.05, y: 0.5 };
  const clickRoi = { x: CLICK.x, y: CLICK.y, w: 0, h: 0 };

  function staticMock(plates: PlateBox[]) {
    const captures: Ptz[] = [];
    const camera = {
      clampZoom: (z: number) => Math.min(36, Math.max(1, z)),
      requestImage: async (_c: number, _p: number, ptz?: { pan?: number; tilt?: number; zoom?: number }) => {
        captures.push({ pan: ptz?.pan ?? 0, tilt: ptz?.tilt ?? 0, zoom: ptz?.zoom ?? 1 });
        return { camIdx: 1, presetIdx: 1, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('img') };
      },
    } as unknown as ICameraClient;
    const lpd = { detect: async (): Promise<PlateBox[]> => plates } as unknown as LpdClient;
    return { camera, lpd, captures };
  }

  it('★클릭점 좌측 끝 · 판은 중앙에만 → no_plate_near_click 이고 중앙 판을 채택하지 않는다', async () => {
    const m = staticMock(CENTER_PLATES);
    const r = await makePtz(m, { plateRoi: clickRoi, initialRadiusNorm: 0.1 }).centerOnPlate(1, 1, START);

    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_plate_near_click');
    // ★ 핵심: 다른 판을 대신 잡지 않았다.
    expect(r.plate).toBeNull();
    expect(r.plateWidth).toBeNull();
    expect(r.iterations).toBe(0);
    // 폐루프 진입 자체가 없다 = 캡처 1회(probe 없음) → 카메라가 엉뚱한 차로 움직이지 않았다.
    expect(m.captures).toHaveLength(1);
    expect(m.captures[0]).toEqual(START);
  });

  it('★게이트 없음(기존 동작)에서는 같은 프레임이 중앙 판을 조용히 채택한다 = 이 버그의 존재 증명', async () => {
    const m = staticMock(CENTER_PLATES);
    const r = await makePtz(m, { plateRoi: clickRoi, maxIterations: 2 }).centerOnPlate(1, 1, START);
    // initialRadiusNorm 미주입 = 기존 코드 그대로 → 클릭점에서 0.55 떨어진 판을 대상으로 삼는다.
    expect(r.plate).not.toBeNull();
    expect(r.plate!.confidence).toBeCloseTo(0.91, 6); // 클릭점 최근접 = 중앙 왼쪽 판(마스터 목격 그대로)
    expect(m.captures.length).toBeGreaterThan(1); // 폐루프 진입 = 그 차로 카메라가 움직였다
  });

  it('반경 안(0.06)에 판이 있으면 게이트가 정상 케이스를 죽이지 않는다', async () => {
    const near = plateAt(0.05 + 0.06, 0.5, 0.03, 0.93);
    const m = staticMock([near, ...CENTER_PLATES]);
    const r = await makePtz(m, { plateRoi: clickRoi, initialRadiusNorm: 0.1, maxIterations: 0 }).centerOnPlate(1, 1, START);
    // maxIterations:0 → 선정만 관측(수렴 여부는 이 케이스의 관심사가 아니다).
    expect(r.reason).not.toBe('no_plate_near_click');
    expect(r.plate).not.toBeNull();
    expect(r.plate!.confidence).toBeCloseTo(0.93, 6);
  });

  it('검출 0건은 no_plate — no_plate_near_click 과 구분된다(마스터의 다음 행동이 정반대)', async () => {
    const m = staticMock([]);
    const r = await makePtz(m, { plateRoi: clickRoi, initialRadiusNorm: 0.1 }).centerOnPlate(1, 1, START);
    expect(r.reason).toBe('no_plate');
  });

  it('배치 회귀 가드: initialRadiusNorm 미주입 시 zoomToPlateWidth 도 무게이트(기존 동작)', async () => {
    // 배치는 plateRoi 를 주지 않아 prior 가 화면중앙 — 멀리 있는 판도 잡혀야 대량 미검이 안 난다.
    const far = plateAt(0.9, 0.5, 0.2, 0.94);
    const m = staticMock([far]);
    const r = await makePtz(m, { initialRadiusNorm: 0.1, maxIterations: 0 }).zoomToPlateWidth(1, 1, START);
    // zoomToPlateWidth 는 설계대로 게이트를 적용하지 않는다(체이닝 시 판 박스가 prior).
    expect(r.reason).not.toBe('no_plate_near_click');
    expect(r.plate).not.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// T2 — Requirement 2: 네이티브 유무 분기 + 줌 사다리 수렴
// ══════════════════════════════════════════════════════════════════════════════
describe('T2. 줌 사다리 — 네이티브(setcenter) 경로', () => {
  /** 먼 차량 재현: 클릭점(0.15,0.45)에 있는 판 1개, zoom1 폭 0.01(광각에서 아주 작다). */
  const FAR = { ax: axOf(0.15, 1), ay: ayOf(0.45, 1), w1: 0.01, conf: 0.9 };

  it('클릭점 조준 → ×1.5 사다리 → 폭 0.20±0.02 수렴, setcenter 사용·move 0회', async () => {
    const m = makeLadderMock({ world: { plates: [FAR] }, native: true, start: START });
    const r = await makePtz(m, { initialRadiusNorm: 0.1 }).centerAndZoomByLadder(1, 1, { x: 0.15, y: 0.45 }, START);

    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(r.plateWidth!).toBeGreaterThanOrEqual(0.18);
    expect(r.plateWidth!).toBeLessThanOrEqual(0.22);
    // ① 네이티브 분기: setcenter 가 최소 1회(조준) 쓰였고 기하 move 는 0회.
    expect(m.centerCalls.length).toBeGreaterThanOrEqual(1);
    expect(m.centerCalls[0]!.point).toEqual({ x: 0.15, y: 0.45 });
    expect(m.moves).toHaveLength(0);
    // ② 사다리: 캡처 zoom 이 단조 증가하며 인접비가 1.5 를 넘지 않는다.
    for (let i = 1; i < m.captures.length; i++) {
      const ratio = m.captures[i]!.zoom / m.captures[i - 1]!.zoom;
      expect(ratio).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(ratio).toBeLessThanOrEqual(1.5 + 1e-9);
    }
    expect(m.captures[m.captures.length - 1]!.zoom).toBeGreaterThan(START.zoom);
  });

  it('★조준이 검출보다 먼저다 — 광각 미검출(첫 2 rung) 상태에서도 시작해 수렴한다', async () => {
    // 먼 판은 zoom 이 낮을 때 LPD 가 못 잡는다(화소 부족) — zoom<2 에서 검출 0 으로 모델링.
    const m = makeLadderMock({
      world: { plates: [FAR] },
      native: true,
      start: START,
      override: (ptz, _i, base) => (ptz.zoom < 2 ? [] : base),
    });
    const r = await makePtz(m, { initialRadiusNorm: 0.1 }).centerAndZoomByLadder(1, 1, { x: 0.15, y: 0.45 }, START);
    expect(r.ok).toBe(true);
    // 기존 경로(centerOnPlate 먼저)는 여기서 no_plate 로 시작조차 못 한다 — 대조.
    const m2 = makeLadderMock({
      world: { plates: [FAR] },
      native: true,
      start: START,
      override: (ptz, _i, base) => (ptz.zoom < 2 ? [] : base),
    });
    const legacy = await makePtz(m2, { plateRoi: { x: 0.15, y: 0.45, w: 0, h: 0 }, initialRadiusNorm: 0.1 })
      .centerOnPlate(1, 1, START);
    expect(legacy.ok).toBe(false);
    expect(legacy.reason).toBe('no_plate');
  });

  it('네이티브 조준 후에도 zoom 명령은 move 가 아닌 requestImage override 로 나간다(§3-3)', async () => {
    const m = makeLadderMock({ world: { plates: [FAR] }, native: true, start: START });
    await makePtz(m, { initialRadiusNorm: 0.1 }).centerAndZoomByLadder(1, 1, { x: 0.15, y: 0.45 }, START);
    expect(m.moves).toHaveLength(0);
    expect(m.captures.length).toBeGreaterThan(1);
  });

  it('getPtz 미지원 소스 → setcenter 반환값으로 강등하되 zoom 은 명령값 유지(§5-2)', async () => {
    // 시작 zoom 3 프레임에서 (0.15,0.45)에 보이는 판(각 오프셋을 zoom 3 기준으로 잡는다).
    const FAR3 = { ax: axOf(0.15, 3), ay: ayOf(0.45, 3), w1: 0.01, conf: 0.9 };
    const m = makeLadderMock({ world: { plates: [FAR3] }, native: true, start: { pan: 0, tilt: 0, zoom: 3 }, noGetPtz: true });
    const r = await makePtz(m, { initialRadiusNorm: 0.1 }).centerAndZoomByLadder(1, 1, { x: 0.15, y: 0.45 }, { pan: 0, tilt: 0, zoom: 3 });
    // 첫 캡처의 zoom 이 시작 zoom(3) 그대로 = setcenter 응답 zoom 으로 덮이지 않았다.
    expect(m.captures[0]!.zoom).toBe(3);
    expect(r.ok).toBe(true);
  });

  it('setcenter 예외 → 삼키지 않고 전파(조용한 성공 금지)', async () => {
    const m = makeLadderMock({ world: { plates: [FAR] }, native: true, start: START, nativeThrows: true });
    await expect(
      makePtz(m, { initialRadiusNorm: 0.1 }).centerAndZoomByLadder(1, 1, { x: 0.15, y: 0.45 }, START),
    ).rejects.toThrow(/setcenter/);
  });
});

describe('T5. 줌 사다리 — 네이티브 없는(기하 게인) 경로', () => {
  const FAR = { ax: axOf(0.15, 1), ay: ayOf(0.45, 1), w1: 0.01, conf: 0.9 };

  it('centerOnPoint 미지원 → move(기하 1샷)로 재중심하고 setcenter 는 쓰지 않는다', async () => {
    const m = makeLadderMock({ world: { plates: [FAR] }, native: false, start: START });
    const r = await makePtz(m, { initialRadiusNorm: 0.1 }).centerAndZoomByLadder(1, 1, { x: 0.15, y: 0.45 }, START);
    expect(m.centerCalls).toHaveLength(0);
    expect(m.moves.length).toBeGreaterThanOrEqual(1);
    // 조준 1샷의 pan 은 게인 기하 해(−(0.15−0.5)·(−62)/1 ≈ −21.7°)와 일치 — maxStepDeg(5)로 잘리지 않았다(§5-1).
    expect(m.moves[0]!.pan).toBeCloseTo(-(0.15 - 0.5) * GAIN_PAN_REF1, 6);
    expect(Math.abs(m.moves[0]!.pan)).toBeGreaterThan(5);
    expect(r.ok).toBe(true);
    expect(r.plateWidth!).toBeGreaterThanOrEqual(0.18);
    expect(r.plateWidth!).toBeLessThanOrEqual(0.22);
  });

  it('★LADDER_AIM_MAX_STEP 반증 검토: maxStepDeg(5) 였다면 조준이 6분의 1만 이뤄진다', async () => {
    // 구현자 §5-1 의 주장(설계 결함 보고)이 실제로 성립하는지 수치로 확인한다.
    const need = Math.abs(-(0.15 - 0.5) * GAIN_PAN_REF1); // ≈ 21.7°
    expect(need / 5).toBeGreaterThan(4); // 5° 클램프면 4배 이상 모자란다 = 조준 미성립
  });

  it('move 가 거절하면 aim_failed(조용한 ok 금지)', async () => {
    const m = makeLadderMock({ world: { plates: [FAR] }, native: false, start: START, moveFails: true });
    const r = await makePtz(m, { initialRadiusNorm: 0.1 }).centerAndZoomByLadder(1, 1, { x: 0.15, y: 0.45 }, START);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('aim_failed');
    expect(r.iterations).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// T3 — Requirement 3: 최대 줌 미검출 시 명시 사유 실패(위장 성공 0)
// ══════════════════════════════════════════════════════════════════════════════
describe('T3. 최대 줌 미검출 → 명시 사유 실패', () => {
  it('전 구간 LPD 빈 배열 → plate_not_found_at_max_zoom, zoom 은 zoomMax 에서 정지', async () => {
    const m = makeLadderMock({ world: { plates: [] }, native: true, start: START });
    const r = await makePtz(m, { initialRadiusNorm: 0.1, ladderMaxRungs: 12 }).centerAndZoomByLadder(1, 1, { x: 0.3, y: 0.5 }, START);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('plate_not_found_at_max_zoom');
    expect(r.plate).toBeNull();
    expect(r.plateWidth).toBeNull();
    expect(r.ptz.zoom).toBe(36);
    expect(m.captures[m.captures.length - 1]!.zoom).toBe(36);
  });

  it('rung 상한(기본 8) 소진도 검출 이력이 없으면 같은 사유', async () => {
    const m = makeLadderMock({ world: { plates: [] }, native: true, start: START });
    const r = await makePtz(m, { initialRadiusNorm: 0.1 }).centerAndZoomByLadder(1, 1, { x: 0.3, y: 0.5 }, START);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('plate_not_found_at_max_zoom');
  });

  it('★§5-3 분기: 최대 줌까지 계속 반경 밖 판만 검출 → no_plate_near_click(LPD 한계가 아니라 클릭 위치 문제)', async () => {
    // 조준 프레임에서 화면 (0.85,0.5) = 중앙에서 0.35 떨어진 판 하나(게이트 0.10 밖).
    // ★ 판은 **월드에 두어** zoom 에 따라 오프셋이 k 배로 자라게 한다(0.35·k) — 화면 위치를 zoom 과 무관하게
    //   고정하면 사다리의 줌 모델(등방 확대)을 위반하는 비물리적 프레임이 되어, 게이트가 원본기준으로
    //   스케일된 뒤에는 "원본 0.10 인 정당한 대상"과 구별되지 않는다. 물리적으로 두면 판정은 그대로다.
    // 클릭은 화면중앙 — 조준이 no-op 이라 "조준 프레임 = 시작 프레임"이 명확해진다.
    const m = makeLadderMock({
      world: { plates: [{ ax: axOf(0.85, 1), ay: 0, w1: 0.02, conf: 0.9 }] },
      native: true, start: START,
    });
    const r = await makePtz(m, { initialRadiusNorm: 0.1, ladderMaxRungs: 12 }).centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, START);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_plate_near_click');
    expect(r.plate).toBeNull(); // ★ 반경 밖 판을 대신 채택하지 않았다
    expect(r.ptz.zoom).toBe(36);
  });

  it('확대 불가(장비 한계)여도 **latch + 중앙정렬**이면 완료로 보고하되 폭 미달을 남긴다 [수정 13 으로 정책 변경]', async () => {
    // 판이 zoomMax 에서도 목표 폭에 못 미친다(먼 차 물리 한계).
    // ★ 구 정책은 ok:false 였다. 실카 실측(x36 최대에서도 폭 0.169)에서 이 상태는
    //   "클릭한 그 판을 잡고 중앙에 놓고 장비 최대까지 확대한" **장비가 할 수 있는 일을 전부 한 상태**라
    //   실패로 보고하면 마스터가 취할 다음 행동이 없다. 성공/실패 경계는 L6 이 금지선까지 고정한다.
    const tiny = { ax: 0, ay: 0, w1: 0.001, conf: 0.9 };
    const m = makeLadderMock({ world: { plates: [tiny] }, native: true, start: START });
    const r = await makePtz(m, { initialRadiusNorm: 0.1, ladderMaxRungs: 20 }).centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, START);
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('zoom_saturated'); // 사유는 그대로 남는다
    expect(r.widthShortfall).toBe(true);     // ★ 폭 미달 사실을 지우지 않는다
    expect(r.ptz.zoom).toBe(36);
    expect(r.plateWidth).toBeCloseTo(0.036, 6);
  });

  it('★latch 후 이웃 갈아타기 차단 — 대상 소실 시 plate_lost(이웃을 대신 잡지 않는다)', async () => {
    const target = { ax: 0, ay: 0, w1: 0.02, conf: 0.9 };
    let seen = 0;
    const m = makeLadderMock({
      world: { plates: [target] },
      native: true,
      start: START,
      override: (_ptz, _i, base) => {
        seen += 1;
        // 2번째 프레임부터 대상은 사라지고 이웃(중앙에서 0.2)만 남는다.
        return seen >= 2 ? [plateAt(0.7, 0.5, 0.05, 0.85)] : base;
      },
    });
    const r = await makePtz(m, { initialRadiusNorm: 0.1 }).centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, START);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('plate_lost');
    expect(r.plate!.confidence).toBeCloseTo(0.9, 6); // 마지막으로 본 신원은 여전히 원래 대상
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// L0. 실사용 config(maxZoomStepRatio=1.3) 에서도 사다리가 clampZoom 상한을 **끝까지** 소진하는가.
//     구 고정상한 8 은 1.3^9≈10.6 에서 포기하고 "최대 줌에서 못 찾음"을 오보했다(QA §5-① 결함 → 수정됨).
//     현행: rung 예산은 시작 zoom·ratio·zoomMax 에서 자동 산출된다.
// ══════════════════════════════════════════════════════════════════════════════
describe('L0. rung 예산 자동 산출 → 설정된 ratio 가 무엇이든 zoomMax 도달 보장', () => {
  it('config ratio 1.3 에서 zoom 이 zoomMax(36) 까지 오른 뒤에야 plate_not_found_at_max_zoom 을 보고한다', async () => {
    const m = makeLadderMock({ world: { plates: [] }, native: true, start: START });
    // config/tools.config.json 의 실제 값: maxZoomStepRatio 1.3 · targetPlateWidth 0.215 · widthTol 0.015.
    const r = await makePtz(m, { initialRadiusNorm: 0.1, maxZoomStepRatio: 1.3, targetPlateWidth: 0.215, widthTol: 0.015 })
      .centerAndZoomByLadder(1, 1, { x: 0.3, y: 0.5 }, START);

    expect(r.ok).toBe(false);
    expect(r.reason).toBe('plate_not_found_at_max_zoom');
    expect(r.ptz.zoom).toBe(36); // ★ 구 상한 8 에서는 10.60 에서 잘렸다(이번 작업의 표적인 먼 차량이 여기서 죽었다)
    expect(m.camera.clampZoom(1e9)).toBe(36);
  });

  it('더 작은 ratio(1.1) 에서도 상한을 소진한다(고정 상수라면 불가능)', async () => {
    const m = makeLadderMock({ world: { plates: [] }, native: true, start: START });
    const r = await makePtz(m, { initialRadiusNorm: 0.1, maxZoomStepRatio: 1.1 })
      .centerAndZoomByLadder(1, 1, { x: 0.3, y: 0.5 }, START);
    expect(r.reason).toBe('plate_not_found_at_max_zoom');
    expect(r.ptz.zoom).toBe(36);
  });

  it('ladderMaxRungs 를 명시 주입하면 그 값이 우선한다(하위호환·의도적 조기 종료)', async () => {
    const m = makeLadderMock({ world: { plates: [] }, native: true, start: START });
    // 두 배율을 모두 1.3 으로 고정해 예산 상한만 관측한다(latch 전 기본 2.0 을 배제).
    const r = await makePtz(m, { initialRadiusNorm: 0.1, maxZoomStepRatio: 1.3, preLatchZoomStepRatio: 1.3, ladderMaxRungs: 8 })
      .centerAndZoomByLadder(1, 1, { x: 0.3, y: 0.5 }, START);
    expect(r.ptz.zoom).toBeCloseTo(1.3 ** 9, 6);
    expect(r.ptz.zoom).toBeLessThan(36);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// L2. latch 인지형 배율 — latch 전 2.0(칸수↓) / latch 후 maxZoomStepRatio(1.3) 보존.
//     근거: 누적 드리프트는 칸수가 아니라 **총 배율**이 결정한다(predictCenterAfterZoom 이 곱셈 합성).
// ══════════════════════════════════════════════════════════════════════════════
describe('L2. latch 인지형 사다리 배율', () => {
  /** 캡처 기록에서 인접 zoom 비(사다리가 실제로 쓴 배율)를 뽑는다. */
  const ratios = (caps: Ptz[]): number[] => caps.slice(1).map((c, i) => c.zoom / caps[i]!.zoom);

  it('검출 0 구간은 2.0 으로 오른다(1.3 이 아니다)', async () => {
    const m = makeLadderMock({ world: { plates: [] }, native: true, start: START });
    await makePtz(m, { initialRadiusNorm: 0.1, maxZoomStepRatio: 1.3 })
      .centerAndZoomByLadder(1, 1, { x: 0.3, y: 0.5 }, START);
    // zoomMax 도달 직전까지는 전부 2.0(마지막 칸만 clampZoom 으로 잘린다).
    const rs = ratios(m.captures);
    expect(rs.slice(0, -1).every((r) => Math.abs(r - 2.0) < 1e-9)).toBe(true);
  });

  it('ratio 1.3 config 에서도 여전히 zoomMax(36) 에 도달한다', async () => {
    const m = makeLadderMock({ world: { plates: [] }, native: true, start: START });
    const r = await makePtz(m, { initialRadiusNorm: 0.1, maxZoomStepRatio: 1.3 })
      .centerAndZoomByLadder(1, 1, { x: 0.3, y: 0.5 }, START);
    expect(r.ptz.zoom).toBe(36);
    expect(r.reason).toBe('plate_not_found_at_max_zoom');
  });

  /**
   * 이번 작업의 표적 재현: **광각에서는 화소 부족으로 미검출**이고 줌인해야 비로소 잡히는 먼 판.
   * 스텁 LPD 는 크기를 보지 않으므로 override 로 최소 검출폭을 건다(w1 0.01 → zoom 6 부터 검출, 목표 0.2 는 zoom 20).
   */
  const MIN_DETECT_W = 0.06;
  const farMock = () =>
    makeLadderMock({
      world: { plates: [{ ax: 0, ay: 0, w1: 0.01, conf: 0.9 }] },
      native: true,
      start: START,
      override: (_ptz, _rung, base) => base.filter((p) => quadBoundingRect(p.quad).w >= MIN_DETECT_W),
    });

  it('성긴 배율로 latch 까지의 칸수가 줄어든다(동일 시나리오 대조)', async () => {
    const mFast = farMock();
    const fast = await makePtz(mFast, { initialRadiusNorm: 0.1, maxZoomStepRatio: 1.3 })
      .centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, START);
    const mSlow = farMock();
    const slow = await makePtz(mSlow, { initialRadiusNorm: 0.1, maxZoomStepRatio: 1.3, preLatchZoomStepRatio: 1.3 })
      .centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, START);
    // 둘 다 성공하되(같은 결과) 캡처(=rung, 각 rung 이 정착 대기를 문다) 수가 확연히 적다.
    expect(fast.ok).toBe(true);
    expect(slow.ok).toBe(true);
    expect(mFast.captures.length).toBeLessThan(mSlow.captures.length);
  });

  it('latch 이후에는 maxZoomStepRatio(1.3) 를 넘지 않는다(안전 마진 보존)', async () => {
    const m = farMock();
    const r = await makePtz(m, { initialRadiusNorm: 0.1, maxZoomStepRatio: 1.3 })
      .centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, START);
    expect(r.ok).toBe(true);
    // latch 시점 = 처음으로 목표 폭 방향 미세조정이 시작되는 지점. 그 이후 인접비는 [1/1.3, 1.3] 안.
    const rs = ratios(m.captures);
    const firstFine = rs.findIndex((x) => x < 1.9);
    expect(firstFine).toBeGreaterThan(0);
    for (const x of rs.slice(firstFine)) {
      expect(x).toBeLessThanOrEqual(1.3 + 1e-9);
      expect(x).toBeGreaterThanOrEqual(1 / 1.3 - 1e-9);
    }
  });

  it('LPD 가 후보를 내기 시작하면(기각이더라도) 즉시 정밀 배율로 되돌린다', async () => {
    // 클릭점에서 먼 판만 존재 → 계속 반경 기각되지만 count>0 이므로 성긴 배율을 쓰지 않는다.
    const m = makeLadderMock({ world: { plates: [{ ax: 0, ay: 0, w1: 0.02, conf: 0.9 }] }, native: true, start: START });
    await makePtz(m, { initialRadiusNorm: 0.1, maxZoomStepRatio: 1.3 })
      .centerAndZoomByLadder(1, 1, { x: 0.05, y: 0.5 }, START);
    const rs = ratios(m.captures);
    expect(rs.every((x) => x <= 1.3 + 1e-9)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// L5. zoom 실측(zoomAct) 정체 판정 — 물리 상한을 성공으로 믿지 않는다 (수정 11)
// ══════════════════════════════════════════════════════════════════════════════
describe('L5. zoomAct 정체 판정', () => {
  /**
   * requestImage 응답의 zoom(=장비 실측)을 주입 가능한 mock.
   * @param actOf 명령 zoom → 장비가 실제로 도달한 zoom(물리 상한·모터 지연 재현)
   */
  function actMock(actOf: (cmdZoom: number) => number) {
    const m = makeLadderMock({ world: { plates: [{ ax: 0, ay: 0, w1: 0.02, conf: 0.9 }] }, native: true, start: START });
    const cam = m.camera as unknown as Record<string, unknown>;
    const inner = cam.requestImage as (c: number, p: number, z?: { pan?: number; tilt?: number; zoom?: number }) => Promise<Record<string, unknown>>;
    cam.requestImage = async (c: number, p: number, z?: { pan?: number; tilt?: number; zoom?: number }) => {
      const cap = await inner(c, p, z);
      const act = actOf(z?.zoom ?? 1);
      // ★ 물리 일관성: 장비가 실제로 도달한 zoom 이 곧 **찍힌 이미지**다 → LPD 가 읽는 캡처 기록도 실측으로 덮는다.
      //   (보고 zoom 만 캡하고 이미지는 명령대로 확대되는 mock 은 실카에서 불가능한 상태다.)
      const last = m.captures[m.captures.length - 1];
      if (last) last.zoom = act;
      return { ...cap, zoom: act };
    };
    return m;
  }

  it('장비가 상한(9.75)에서 포화하면 연속 정체 2회 만에 zoom_saturated 로 끝낸다', async () => {
    const m = actMock((cmd) => Math.min(cmd, 9.75)); // 구 zoomRange 오설정 재현: raw 16384 = 뷰어 9.75
    // 실사용 config 폭 파라미터 — 기본 0.2/0.02 면 상한 폭 0.195 가 '수렴'으로 잡혀 정체 판정을 관측할 수 없다.
    const r = await makePtz(m, { initialRadiusNorm: 0.1, maxZoomStepRatio: 1.3, targetPlateWidth: 0.215, widthTol: 0.015 })
      .centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, START);
    expect(r.reason).toBe('zoom_saturated');
    expect(r.widthShortfall).toBe(true);
    // 상한 도달 후 2 rung 만에 끊는다 — 자동 예산(ratio 1.3 → 18칸 + 1)을 끝까지 태우지 않는다.
    expect(m.captures.length).toBeLessThanOrEqual(13);
    expect(m.captures[m.captures.length - 1]!.zoom).toBeLessThan(36);
  });

  it('★오탐 가드: 모터가 느려 목표에 못 닿아도 **움직이고 있으면** 정체가 아니다', async () => {
    // 명령의 60% 만 따라오는 느린 장비(실측: 목표 8894 명령에 5초 후 9968 — 이동 중 미도달).
    // ★ 판은 상한 안에서 수렴 가능한 크기(w1 0.02 → 목표 폭에 zoom 10.75)로 둔다 —
    //   그래야 '정체 오탐' 만 분리 검증된다(수렴 불가 판이면 정상 clampZoom 포화와 구별되지 않는다).
    const m = actMock((cmd) => 1 + (cmd - 1) * 0.6);
    const r = await makePtz(m, { initialRadiusNorm: 0.1, maxZoomStepRatio: 1.3 })
      .centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, START);
    expect(r.ok).toBe(true); // 느릴 뿐 움직이고 있으므로 조기 종료하지 않고 수렴한다
  });

  it('★회귀 가드: 실측이 살아있지 않은 소스(시뮬 echo 0/0/1)에서는 판정이 발동하지 않는다', async () => {
    // 기본 mock 은 응답 echo 가 zoom:1 고정 = "신뢰 불가" 재현. 여기서 정체로 오판하면 시뮬이 전부 죽는다.
    const far = { ax: 0, ay: 0, w1: 0.01, conf: 0.9 };
    const m = makeLadderMock({
      world: { plates: [far] }, native: true, start: START,
      override: (_p, _r, base) => base.filter((b) => quadBoundingRect(b.quad).w >= 0.06),
    });
    const r = await makePtz(m, { initialRadiusNorm: 0.1, maxZoomStepRatio: 1.3 })
      .centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, START);
    expect(r.ok).toBe(true); // echo 고정이어도 정상 수렴
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// L6. 장비 상한 도달 시 성공/실패 경계 (수정 13) — 위장 성공 금지선을 코드로 고정한다
// ══════════════════════════════════════════════════════════════════════════════
describe('L6. 장비 zoom 상한 도달 판정', () => {
  // 시작 zoom = zoomMax → 첫 rung 에서 clampZoom 포화가 확정된다(상한 도달을 "사실 확인"한 자리).
  const CAP = 4;
  const capStart: Ptz = { pan: 0, tilt: 0, zoom: CAP };
  /** 네이티브 센터링을 **무효화**해 판이 중앙에서 벗어난 채로 남게 한다(미정렬 케이스 재현). */
  const disableCentering = (m: ReturnType<typeof makeLadderMock>) => {
    (m.camera as unknown as Record<string, unknown>).centerOnPoint = async () => ({ ...m.state() });
  };

  it('latch + 중앙정렬 + 상한도달 → ok:true 이되 폭 미달 사실을 보존한다', async () => {
    // 판이 화면 중앙(ax 0), 최대 zoom 4 에서도 폭 0.08 < 목표 0.215 → 물리적으로 도달 불가.
    const m = makeLadderMock({ world: { plates: [{ ax: 0, ay: 0, w1: 0.02, conf: 0.9 }] }, native: true, start: capStart, zoomMax: CAP });
    const r = await makePtz(m, { initialRadiusNorm: 0.1, targetPlateWidth: 0.215, widthTol: 0.015 })
      .centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, capStart);
    expect(r.ok).toBe(true);                 // 장비가 할 수 있는 일을 전부 했다
    expect(r.widthShortfall).toBe(true);     // ★ 폭 미달 사실을 지우지 않는다
    expect(r.reason).toBe('zoom_saturated'); // 종료 사유도 남는다(UI 가 구분 표시 가능)
    expect(r.plate).not.toBeNull();          // 잡은 판을 결과에 싣는다
    expect(r.plateWidth).toBeCloseTo(0.08, 3);
  });

  it('★금지선 1: 판을 latch 하지 못하면 포화여도 실패를 유지한다', async () => {
    const m = makeLadderMock({ world: { plates: [] }, native: true, start: capStart, zoomMax: CAP });
    const r = await makePtz(m, { initialRadiusNorm: 0.1 }).centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, capStart);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('plate_not_found_at_max_zoom');
    expect(r.plate).toBeNull();
  });

  it('★금지선 2: 반경 밖 판만 있으면 포화여도 실패를 유지한다(다른 판 대체 금지)', async () => {
    const m = makeLadderMock({
      world: { plates: [{ ax: axOf(0.85, CAP), ay: 0, w1: 0.02, conf: 0.9 }] },
      native: true, start: capStart, zoomMax: CAP,
    });
    disableCentering(m);
    const r = await makePtz(m, { initialRadiusNorm: 0.1 }).centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, capStart);
    expect(r.ok).toBe(false);
    expect(r.plate).toBeNull();
    expect(r.reason).toBe('no_plate_near_click');
  });

  it('★금지선 3: 게이트 안이지만 중앙 tol 밖이면 포화여도 실패를 유지한다', async () => {
    // 중앙에서 0.06(게이트 0.10 안 · centerTol 0.03 밖) — 센터링을 무효화해 정렬되지 않은 채로 둔다.
    const m = makeLadderMock({
      world: { plates: [{ ax: axOf(0.56, CAP), ay: 0, w1: 0.02, conf: 0.9 }] },
      native: true, start: capStart, zoomMax: CAP,
    });
    disableCentering(m);
    const r = await makePtz(m, { initialRadiusNorm: 0.1, centerTol: 0.03, targetPlateWidth: 0.215, widthTol: 0.015 })
      .centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, capStart);
    expect(r.ok).toBe(false);                // 정렬 미검증 → 성공 아님
    expect(r.reason).toBe('zoom_saturated');
    expect(r.widthShortfall).toBe(true);     // 실패여도 정보는 남는다
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// L7. 장비 상한에서 마지막 재중심(수정 17) · 최선 지점 복귀(수정 18)
//     ★ 성공 판정을 넓히는 변경이므로 **금지선 재점검을 함께 고정**한다.
// ══════════════════════════════════════════════════════════════════════════════
describe('L7. 상한 최종 확정 · 최선 복귀', () => {
  const CAP = 4;
  const capStart: Ptz = { pan: 0, tilt: 0, zoom: CAP };

  /** 네이티브 센터링이 n 번째 호출부터 동작(그 전엔 무효) — "마지막 재중심으로 정렬이 만들어지는" 상황 재현. */
  function lateCentering(m: ReturnType<typeof makeLadderMock>, worksFromCall: number) {
    const cam = m.camera as unknown as Record<string, unknown>;
    const real = cam.centerOnPoint as (c: number, p: { x: number; y: number }) => Promise<Ptz>;
    let calls = 0;
    cam.centerOnPoint = async (c: number, p: { x: number; y: number }) => {
      calls += 1;
      return calls >= worksFromCall ? real(c, p) : { ...m.state() };
    };
  }

  it('★마스터 요구: 상한에서 폭 미달 + 정렬 어긋남 → 마지막 재중심으로 그 자리를 최종 위치로 확정한다', async () => {
    // 판이 중앙에서 0.06(게이트 안 · centerTol 0.03 밖). 조준 단계 센터링은 무효화하고 **마지막 재중심만** 동작시킨다.
    const m = makeLadderMock({
      world: { plates: [{ ax: axOf(0.56, CAP), ay: 0, w1: 0.02, conf: 0.9 }] },
      native: true, start: capStart, zoomMax: CAP,
    });
    // 호출 순서: 1=클릭 조준 · 2=rung 내 재중심 · 3=**상한에서의 마지막 재중심**.
    // 3회차부터 동작시켜 "앞선 재중심들이 실패했는데 마지막 재중심이 정렬을 만든" 경로만 정확히 겨눈다.
    lateCentering(m, 3);
    const r = await makePtz(m, { initialRadiusNorm: 0.1, centerTol: 0.03, targetPlateWidth: 0.215, widthTol: 0.015 })
      .centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, capStart);
    expect(r.ok).toBe(true);              // 장비가 할 수 있는 일을 전부 했다 → 그 자리가 최종
    expect(r.recenterAttempts).toBe(1);   // 몇 번 시도했는지 결과에 남는다
    expect(r.widthShortfall).toBe(true);  // 폭 미달 사실은 계속 보존
    expect(Math.abs(r.err!.errX)).toBeLessThanOrEqual(0.03); // ★추정이 아니라 실측으로 확인된 정렬
  });

  it('★금지선 유지: 마지막 재중심 후에도 tol 밖이면 실패다(시도 횟수는 남긴다)', async () => {
    const m = makeLadderMock({
      world: { plates: [{ ax: axOf(0.56, CAP), ay: 0, w1: 0.02, conf: 0.9 }] },
      native: true, start: capStart, zoomMax: CAP,
    });
    lateCentering(m, 99); // 끝내 정렬을 만들지 못한다
    const r = await makePtz(m, { initialRadiusNorm: 0.1, centerTol: 0.03, targetPlateWidth: 0.215, widthTol: 0.015 })
      .centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, capStart);
    expect(r.ok).toBe(false);
    expect(r.recenterAttempts).toBe(1);
  });

  it('★금지선 유지: latch 실패면 재중심을 시도조차 하지 않고 실패다', async () => {
    const m = makeLadderMock({ world: { plates: [] }, native: true, start: capStart, zoomMax: CAP });
    const r = await makePtz(m, { initialRadiusNorm: 0.1 }).centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, capStart);
    expect(r.ok).toBe(false);
    expect(r.plate).toBeNull();
    expect(r.reason).toBe('plate_not_found_at_max_zoom');
  });

  it('★수정 18: 최선보다 나쁜 상태로 끝나게 되면(대상 소실) 최선 폭 지점으로 복귀해 끝낸다', async () => {
    // 목표에 근접했던 rung 이후 대상이 사라지는 프레임 — 그 자리에 멈추지 말고 최선 지점으로 되돌아가야 한다.
    // (구 진동 픽스처는 수정 20 의 이분 탐색이 진동 자체를 없애 더 이상 이 경로를 만들지 못한다.)
    const start: Ptz = { pan: 0, tilt: 0, zoom: 8 };
    let frames = 0;
    const m = makeLadderMock({
      world: { plates: [{ ax: 0, ay: 0, w1: 0.02, conf: 0.9 }] }, native: true, start,
      override: (_p, _r, base) => (frames++ >= 1 ? [] : base), // 2번째 프레임부터 검출 0 → 수렴 전에 plate_lost
    });
    const r = await makePtz(m, { initialRadiusNorm: 0.1, targetPlateWidth: 0.215, widthTol: 0.015 })
      .centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, start);
    expect(r.reason).toBe('plate_lost');
    expect(r.restoredToBest).toBe(true);      // 최선 지점으로 복귀했다
    expect(r.ptz.zoom).toBeCloseTo(8, 3);     // 복귀 위치 = 최선 rung(rung 0) 의 zoom
    // 복귀 지점(rung 0)에서 실제로 쟀던 폭을 보고한다 — 소실 지점의 값이 아니다(값을 지어내지도 않는다).
    expect(r.plateWidth!).toBeCloseTo(0.16, 3);
  });

  it('정상 수렴 케이스는 복귀 로직이 개입하지 않는다(회귀 가드)', async () => {
    const m = makeLadderMock({ world: { plates: [{ ax: 0, ay: 0, w1: 0.02, conf: 0.9 }] }, native: true, start: START });
    const r = await makePtz(m, { initialRadiusNorm: 0.1 }).centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, START);
    expect(r.ok).toBe(true);
    expect(r.restoredToBest).toBeUndefined();
    expect(r.reason).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// L8. 괄호 이분 탐색(수정 20) — 선형 외삽이 만든 극한 순환을 제거한다.
//     ★ 선형 스텁만 쓰면 이 버그를 다시 못 잡는다 → **비선형 광학 곡선**으로 고정한다.
// ══════════════════════════════════════════════════════════════════════════════
describe('L8. 괄호 이분 탐색', () => {
  const CFG = { initialRadiusNorm: 0.1, targetPlateWidth: 0.215, widthTol: 0.015, maxZoomStepRatio: 1.3 };

  /**
   * 광학 곡선을 임의 함수로 주입한다(폭 = curve(zoom)). 판은 항상 화면 중앙.
   * 스텁 LPD 는 캡처 기록의 zoom 을 읽으므로, 기록 zoom 을 "그 폭을 내는 등가 zoom"으로 덮어 곡선을 구현한다.
   */
  function opticalMock(curve: (z: number) => number, start: Ptz, zoomMax = 36) {
    const W1 = 0.02; // 스텁 폭 = W1 × 기록 zoom
    const m = makeLadderMock({ world: { plates: [{ ax: 0, ay: 0, w1: W1, conf: 0.9 }] }, native: true, start, zoomMax });
    const cmdZooms: number[] = []; // 명령 zoom(캡처 기록은 등가 zoom 으로 덮이므로 따로 남긴다)
    const cam = m.camera as unknown as Record<string, unknown>;
    const inner = cam.requestImage as (c: number, p: number, z?: { pan?: number; tilt?: number; zoom?: number }) => Promise<Record<string, unknown>>;
    cam.requestImage = async (c: number, p: number, z?: { pan?: number; tilt?: number; zoom?: number }) => {
      const cap = await inner(c, p, z);
      const cmd = z?.zoom ?? start.zoom;
      cmdZooms.push(cmd);
      const last = m.captures[m.captures.length - 1];
      if (last) last.zoom = curve(cmd) / W1; // 폭이 curve(cmd) 가 되도록 등가 zoom 주입
      return { ...cap, zoom: cmd };          // zoomAct 는 명령대로(장비는 정상 작동)
    };
    return Object.assign(m, { cmdZooms });
  }

  /**
   * ★라이브 실측 곡선(logs/setting_20260721_183256.log) 재현.
   * (16.0,0.021) (20.8,0.029) (27.0,0.056) (35.2,0.157) (36,0.238) — 상단에서 급격히 꺾인다.
   * 이 곡선에서 선형 외삽은 36(0.238) → 32.5 로 튀고 거기서 0.102 가 나와 다시 36 으로 되돌아온다(극한 순환).
   */
  const liveCurve = (z: number): number => {
    const pts: Array<[number, number]> = [[1, 0.001], [16.001, 0.021], [20.801, 0.029], [27.041, 0.056], [32.4, 0.102], [35.153, 0.157], [36, 0.238]];
    if (z <= pts[0]![0]) return pts[0]![1];
    for (let i = 1; i < pts.length; i++) {
      const [z0, w0] = pts[i - 1]!;
      const [z1, w1] = pts[i]!;
      if (z <= z1) return w0 + ((w1 - w0) * (z - z0)) / (z1 - z0); // 구간 선형 보간 = 전체적으로 비선형
    }
    return pts[pts.length - 1]![1];
  };

  it('★라이브 진동 프레임: 36↔32.5 순환이 사라지고 목표 폭으로 수렴한다', async () => {
    const start: Ptz = { pan: 0, tilt: 0, zoom: 16.001 };
    const m = opticalMock(liveCurve, start);
    const r = await makePtz(m, CFG).centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, start);

    expect(r.ok).toBe(true);
    expect(r.plateWidth!).toBeGreaterThanOrEqual(CFG.targetPlateWidth - CFG.widthTol);
    expect(r.plateWidth!).toBeLessThanOrEqual(CFG.targetPlateWidth + CFG.widthTol);

    // ★진동 부재의 직접 증거: 목표를 처음 넘어선 뒤로는 zoom 이 괄호 안에만 머문다(36↔32.5 왕복 없음).
    const zooms = m.cmdZooms;
    const firstOver = zooms.findIndex((z) => liveCurve(z) > CFG.targetPlateWidth);
    expect(firstOver).toBeGreaterThan(-1);
    const after = zooms.slice(firstOver);
    const lo = Math.min(...after);
    const hi = Math.max(...after);
    expect(hi - lo).toBeLessThan(1.5); // 구 동작은 36−32.2 ≈ 3.8 을 3회 왕복했다
    // 같은 zoom 을 3번 이상 다시 밟지 않는다(순환 부재).
    const counts = new Map<string, number>();
    for (const z of zooms) counts.set(z.toFixed(2), (counts.get(z.toFixed(2)) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThan(3);
  });

  it('★비선형 곡선(제곱/포화형)에서도 수렴한다 — 모델을 가정하지 않는다는 성질 고정', async () => {
    const start: Ptz = { pan: 0, tilt: 0, zoom: 4 };
    for (const curve of [
      (z: number) => 0.0002 * z * z,                    // 볼록(제곱)
      (z: number) => 0.36 * (1 - Math.exp(-z / 14)),    // 오목(포화형)
      (z: number) => 0.00001 * z * z * z,               // 3차(더 급격)
    ]) {
      const m = opticalMock(curve, start);
      const r = await makePtz(m, CFG).centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, start);
      expect(r.ok).toBe(true);
      expect(Math.abs(r.plateWidth! - CFG.targetPlateWidth)).toBeLessThanOrEqual(CFG.widthTol);
    }
  });

  it('괄호가 없으면(전부 목표 미달) 기존 상승 탐색 그대로 — latch 전 동작 무변경', async () => {
    // 최대 zoom 에서도 목표에 못 미치는 먼 판 → 괄호가 생기지 않는다 → 상한까지 오른 뒤 상한 지점 확정(수정 17).
    const start: Ptz = { pan: 0, tilt: 0, zoom: 4 };
    const m = opticalMock((z) => 0.004 * z, start); // z=36 에서도 0.144 < 0.215
    const r = await makePtz(m, CFG).centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, start);
    expect(r.reason).toBe('zoom_saturated');   // 해상도 한계가 아니라 **배율 상한**
    expect(r.widthShortfall).toBe(true);
    expect(r.ptz.zoom).toBe(36);
    expect(r.ok).toBe(true);                    // latch + 정렬 → 그 자리가 최종(수정 17)
  });

  it('★금지선: 이분 구간에서도 반경 밖 판을 대신 채택하지 않는다(신원 보존)', async () => {
    // 클릭점 근처에 판이 없고 먼 곳에만 있는 프레임 → 괄호 로직과 무관하게 대체 채택은 없어야 한다.
    const start: Ptz = { pan: 0, tilt: 0, zoom: 16.001 };
    const m = makeLadderMock({
      world: { plates: [{ ax: axOf(0.85, 16.001), ay: 0, w1: 0.02, conf: 0.9 }] },
      native: true, start, zoomMax: 36,
    });
    (m.camera as unknown as Record<string, unknown>).centerOnPoint = async () => ({ ...m.state() });
    const r = await makePtz(m, CFG).centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, start);
    expect(r.ok).toBe(false);
    expect(r.plate).toBeNull();
    expect(r.reason).toBe('no_plate_near_click');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// L9. 폭 수렴 출구의 정렬 확인(수정 21) — ★무회귀가 제1 제약이다.
//     "성공 = latch + 실측 정렬" 원칙을 주 경로에도 적용하되, **성공을 좁히지 않는다**.
// ══════════════════════════════════════════════════════════════════════════════
describe('L9. 폭 수렴 출구 정렬 확인', () => {
  const CFG = { initialRadiusNorm: 0.1, targetPlateWidth: 0.215, widthTol: 0.015, centerTol: 0.03 };
  // 시작 zoom 10.75 · w1 0.02 → rung 0 에서 폭 0.215 로 **즉시 폭 수렴**한다(정렬만 따로 관측 가능).
  const START0: Ptz = { pan: 0, tilt: 0, zoom: 10.75 };
  /** 중앙에서 offset 만큼 벗어난 판 하나(게이트 0.10 안). */
  const offsetMock = (offset: number, opts: { centering: boolean; loseAfter?: number } = { centering: true }) => {
    let frames = 0;
    const m = makeLadderMock({
      world: { plates: [{ ax: axOf(0.5 + offset, START0.zoom), ay: 0, w1: 0.02, conf: 0.9 }] },
      native: true, start: START0,
      ...(opts.loseAfter !== undefined
        ? { override: (_p: Ptz, _r: number, base: PlateBox[]) => (frames++ >= opts.loseAfter! ? [] : base) }
        : {}),
    });
    if (!opts.centering) {
      (m.camera as unknown as Record<string, unknown>).centerOnPoint = async () => ({ ...m.state() });
    }
    return m;
  };

  it('정렬이 이미 tol 안이면 **추가 카메라 왕복 0회**로 즉시 완료(체감 시간 회귀 방지)', async () => {
    const m = offsetMock(0); // 판이 정확히 중앙
    const capturesBefore = m.captures.length;
    const r = await makePtz(m, CFG).centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, START0);
    expect(r.ok).toBe(true);
    expect(r.recenterAttempts).toBeUndefined();  // ★재중심 시도 자체가 없다 = 추가 왕복 0
    expect(r.centerShortfall).toBeUndefined();
    // rung 0 캡처 1회 + 조준 1회가 전부 — 정렬 확인이 프레임을 더 먹지 않았다.
    expect(m.captures.length - capturesBefore).toBe(1);
  });

  it('정렬이 tol 밖이면 재중심 1회로 정렬을 만들고 완료한다', async () => {
    const m = offsetMock(0.05); // centerTol 0.03 밖 · 게이트 0.10 안
    const r = await makePtz(m, CFG).centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, START0);
    expect(r.ok).toBe(true);
    expect(r.recenterAttempts).toBe(1);
    expect(r.centerShortfall).toBeUndefined();          // 정렬을 만들었다
    expect(Math.abs(r.err!.errX)).toBeLessThanOrEqual(CFG.centerTol); // ★추정이 아니라 실측 확인
  });

  it('★무회귀 1: 정렬 tol 밖 + 재중심이 듣지 않아도 **ok:true 를 유지**하고 잔차를 보고한다', async () => {
    const m = offsetMock(0.05, { centering: false }); // setcenter 가 무효인 소스
    const r = await makePtz(m, CFG).centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, START0);
    expect(r.ok).toBe(true);                 // ★오늘 성공하는 케이스가 내일 실패하면 안 된다
    expect(r.centerShortfall).toBe(true);    // 감추지 않는다
    expect(r.recenterAttempts).toBe(1);
    expect(Math.abs(r.err!.errX)).toBeGreaterThan(CFG.centerTol); // 남은 잔차가 결과에 실린다
    expect(r.plateWidth!).toBeCloseTo(0.215, 3);
  });

  it('★무회귀 2: 재확인에서 대상을 놓쳐도 ok:true 를 유지하고 마지막 실측을 보고한다', async () => {
    const m = offsetMock(0.05, { centering: true, loseAfter: 1 }); // 재확인 프레임부터 검출 0
    const r = await makePtz(m, CFG).centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, START0);
    expect(r.ok).toBe(true);
    expect(r.centerShortfall).toBe(true);
    expect(r.plate).not.toBeNull();                 // 마지막 실측을 유지(지어내지 않는다)
    expect(r.plateWidth!).toBeCloseTo(0.215, 3);
  });

  it('★금지선: 성공을 넓히지 않는다 — 반경 밖 판만 있으면 여전히 실패다', async () => {
    const m = makeLadderMock({
      world: { plates: [{ ax: axOf(0.85, START0.zoom), ay: 0, w1: 0.02, conf: 0.9 }] },
      native: true, start: START0,
    });
    (m.camera as unknown as Record<string, unknown>).centerOnPoint = async () => ({ ...m.state() });
    const r = await makePtz(m, CFG).centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, START0);
    expect(r.ok).toBe(false);
    expect(r.plate).toBeNull();
    expect(r.reason).toBe('no_plate_near_click');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// L4. 네이티브 조준 정착 미확인(settled:false) → 조용히 진행하지 않는다 (수정 8)
// ══════════════════════════════════════════════════════════════════════════════
describe('L4. 조준 정착 미확인 처리', () => {
  /** centerOnPoint 가 settled 플래그를 실어 보내는 소스. */
  function settleMock(settled: boolean | undefined) {
    const m = makeLadderMock({ world: { plates: [{ ax: 0, ay: 0, w1: 0.02, conf: 0.9 }] }, native: true, start: START });
    const inner = (m.camera as unknown as { centerOnPoint: (c: number, p: { x: number; y: number }) => Promise<Ptz> }).centerOnPoint;
    (m.camera as unknown as Record<string, unknown>).centerOnPoint = async (c: number, p: { x: number; y: number }) => {
      const ptz = await inner(c, p);
      return settled === undefined ? ptz : { ...ptz, settled };
    };
    return m;
  }

  it('settled:false → aim_failed 로 실패한다(미정착 PTZ 로 다음 rung 을 명령하지 않는다)', async () => {
    const m = settleMock(false);
    const r = await makePtz(m, { initialRadiusNorm: 0.1 }).centerAndZoomByLadder(1, 1, { x: 0.4, y: 0.5 }, START);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('aim_failed');
    expect(m.captures).toHaveLength(0); // ★ 미정착 상태로 캡처(=이동 명령)를 내보내지 않았다
  });

  it('settled:true → 고정 sleep 없이 정상 진행한다', async () => {
    const m = settleMock(true);
    const r = await makePtz(m, { initialRadiusNorm: 0.1 }).centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, START);
    expect(r.ok).toBe(true);
  });

  it('settled 미제공 소스(구 동작)는 기존 고정 대기 폴백으로 그대로 진행한다', async () => {
    const m = settleMock(undefined);
    const r = await makePtz(m, { initialRadiusNorm: 0.1 }).centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, START);
    expect(r.ok).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// L3. 게이트 반경의 zoom 스케일링 + 양방향 rung 예산 (QA 재검증 R6-①/R6-②/R7 대응)
//     실사용 config 값으로 돌린다: targetPlateWidth 0.215 · widthTol 0.015 · maxZoomStepRatio 1.3.
// ══════════════════════════════════════════════════════════════════════════════
describe('L3. 게이트 zoom 스케일링 · 양방향 예산', () => {
  const CFG = { targetPlateWidth: 0.215, widthTol: 0.015, centerTol: 0.03, maxZoomStepRatio: 1.3, initialRadiusNorm: 0.1 };
  /** LPD 최소 검출폭 — 광각에서 먼 판이 안 잡히는 현실 재현(QA 재현 파라미터와 동일). */
  const MIN_W = 0.06;
  const detectFloor = (_p: Ptz, _r: number, base: PlateBox[]): PlateBox[] =>
    base.filter((p) => quadBoundingRect(p.quad).w >= MIN_W);

  it('① QA 스윕 반례: 창 [3,4.65] · 시작 zoom 21점 → preLatch 2.0 에서 0/21 실패', async () => {
    // 판 각오프셋 1.333°(zoom1 에서 e1=0.0215) · w1 0.02 → 검출 시작 zoom 3, 고정 게이트라면 창 상단 4.65.
    const fails: number[] = [];
    for (let i = 0; i <= 20; i++) {
      const z0 = Number((1 + i * 0.05).toFixed(2));
      const start: Ptz = { pan: 0, tilt: 0, zoom: z0 };
      const m = makeLadderMock({
        world: { plates: [{ ax: 1.333, ay: 0, w1: 0.02, conf: 0.9 }] },
        native: true, start, override: detectFloor,
      });
      const r = await makePtz(m, CFG).centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, start);
      if (!r.ok) fails.push(z0);
    }
    // 고정 게이트 시절에는 2.0 이 창을 건너뛰어 6/21 실패했다. 스케일링 후에는 창이 닫히지 않는다.
    expect(fails).toEqual([]);
  });

  it('① -b 성긴 배율을 유지해도(2.0 기본) 1.3 과 동일하게 전건 성공한다 = 속도 이득 보존', async () => {
    const run = async (pre: number): Promise<boolean> => {
      const start: Ptz = { pan: 0, tilt: 0, zoom: 1.2 }; // QA 가 지목한 대표 실패점
      const m = makeLadderMock({
        world: { plates: [{ ax: 1.333, ay: 0, w1: 0.02, conf: 0.9 }] },
        native: true, start, override: detectFloor,
      });
      const r = await makePtz(m, { ...CFG, preLatchZoomStepRatio: pre }).centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, start);
      return r.ok;
    };
    expect(await run(2.0)).toBe(true);
    expect(await run(1.3)).toBe(true);
  });

  it('② 이웃 판 거짓 latch 는 **모든 zoom 에서** 여전히 차단된다(판별력 보존 — 1순위 목적)', async () => {
    // 조준 프레임에서 0.15 떨어진 이웃만 존재(원본기준 0.15 > 게이트 0.10) → 어떤 시작 zoom 에서도 채택 금지.
    for (const z0 of [1, 2, 5, 12, 30]) {
      const start: Ptz = { pan: 0, tilt: 0, zoom: z0 };
      const ax = axOf(0.65, z0); // 그 zoom 화면에서 중앙으로부터 0.15
      const m = makeLadderMock({ world: { plates: [{ ax, ay: 0, w1: 0.02, conf: 0.9 }] }, native: true, start });
      const r = await makePtz(m, CFG).centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, start);
      expect(r.ok).toBe(false);
      expect(r.plate).toBeNull(); // ★ 이웃을 대신 채택하지 않는다
      expect(r.reason).toBe('no_plate_near_click');
    }
  });

  it('② -b 스케일링이 정상 대상은 살린다(원본기준 0.05 = 게이트 안) — 정상 케이스 미살상', async () => {
    const start: Ptz = { pan: 0, tilt: 0, zoom: 1 };
    const ax = axOf(0.55, 1); // 조준 프레임에서 0.05
    const m = makeLadderMock({
      world: { plates: [{ ax, ay: 0, w1: 0.02, conf: 0.9 }] },
      native: true, start, override: detectFloor,
    });
    const r = await makePtz(m, CFG).centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, start);
    expect(r.ok).toBe(true);
  });

  it('③ 줌아웃 예산: start zoom 36 · 큰 판 → 자동 예산으로 수렴한다(양방향 산출)', async () => {
    const start: Ptz = { pan: 0, tilt: 0, zoom: 36 };
    const m = makeLadderMock({ world: { plates: [{ ax: 0, ay: 0, w1: 0.02, conf: 0.9 }] }, native: true, start });
    const r = await makePtz(m, CFG).centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, start);
    expect(r.ok).toBe(true);
    expect(r.ptz.zoom).toBeLessThan(36); // 줌아웃으로 갔다
    expect(r.plateWidth!).toBeGreaterThanOrEqual(CFG.targetPlateWidth - CFG.widthTol);
    expect(r.plateWidth!).toBeLessThanOrEqual(CFG.targetPlateWidth + CFG.widthTol);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// L1. 근거리 클릭(목표보다 큰 판) — 사다리가 줌아웃으로도 수렴하는가.
//     구현 초판은 상승 전용이라 zoom_saturated 로 실패했다(QA §5-② 회귀 → 수정됨).
// ══════════════════════════════════════════════════════════════════════════════
describe('L1. 사다리는 양방향(대칭 클램프) — 근거리 클릭도 수렴한다', () => {
  it('클릭 판이 목표보다 크면(폭 0.30) 줌아웃해 목표 폭으로 수렴한다', async () => {
    const big = { ax: 0, ay: 0, w1: 0.075, conf: 0.9 }; // zoom4 에서 폭 0.30
    const m = makeLadderMock({ world: { plates: [big] }, native: true, start: { pan: 0, tilt: 0, zoom: 4 } });
    const r = await makePtz(m, { initialRadiusNorm: 0.1 }).centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, { pan: 0, tilt: 0, zoom: 4 });
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(r.ptz.zoom).toBeLessThan(4); // 줌아웃 방향으로 갔다
    expect(r.plateWidth!).toBeGreaterThanOrEqual(0.18);
    expect(r.plateWidth!).toBeLessThanOrEqual(0.22);

    // 대조: 기존 경로(zoomToPlateWidth)와 동일하게 수렴한다 = 경로 비대칭 해소.
    const m2 = makeLadderMock({ world: { plates: [big] }, native: true, start: { pan: 0, tilt: 0, zoom: 4 } });
    const z = await makePtz(m2).zoomToPlateWidth(1, 1, { pan: 0, tilt: 0, zoom: 4 });
    expect(z.ok).toBe(true);
    expect(z.ptz.zoom).toBeLessThan(4);
  });
});
