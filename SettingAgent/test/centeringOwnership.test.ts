import { describe, it, expect } from 'vitest';
import { PlatePtz, type PlatePtzDeps, type PlatePtzOpts } from '../src/calibrate/platePtz.js';
import { PtzCalibrator, type PtzCalibratorDeps } from '../src/calibrate/PtzCalibrator.js';
import type { ICameraClient } from '../src/clients/CameraClient.js';
import type { LpdClient, PlateBox } from '../src/clients/LpdClient.js';
import type { SqliteStore } from '../src/capture/SqliteStore.js';
import type { SlotSetupView } from '../src/capture/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import { rectToQuad } from '../src/domain/geometry.js';
import type { Ptz, PlateTarget } from '../src/calibrate/types.js';
import type { NormalizedPoint } from '../src/domain/types.js';

/**
 * 검증자(qa-tester): 센터라이징 이터2 — 소유권 배타성 게이트(설계 §A-1/§A-2, B절).
 *
 * ★ 핵심 결론(은닉 금지): 이 설계에서 peer 앵커는 selfRef(prior/aim)에 **상대오프셋으로 고정**된다.
 *   센터링은 zoom 고정이라 pan/tilt=강체평행이동이고, 강체평행이동 하에서
 *   "자기 판이 존재·선정되는 프레임"에서는 소유권(pickOwnedPlate)과 최근접(pickNearestPlate)이
 *   **수학적으로 동일**하다(peer 앵커가 selfRef 와 함께 평행이동하기 때문). 따라서
 *   "자기 판이 있는데 레거시만 이웃으로 갈아타고 소유권이 그걸 막는" 시나리오는 이 설계에서 존재하지 않는다.
 *   소유권의 **입증 가능한 고유 효과 = 자기 판 부재/이탈 시 "이웃 절도(latch)"를 "정직한 미검(no_plate)"으로 전환**.
 *   → 아래 T1 이 그 대조(레거시=절도 vs 소유권=미검)를 결정형으로 증명한다.
 */

const START1: Ptz = { pan: 0, tilt: 0, zoom: 1 };
const BASE: PlatePtzOpts = { settleMs: 0 };

/** 중심(cx,cy)·폭 w 축정렬 번호판 1개. conf = 신원 태그. */
function plateAt(cx: number, cy: number, w: number, h = 0.03, conf = 0.9): PlateBox {
  return { quad: rectToQuad({ x: cx - w / 2, y: cy - h / 2, w, h }), confidence: conf, cls: 'plate' };
}

/**
 * 강체 world: 명령 pan/tilt 로 모든 번호판이 함께 평행이동(zoom 고정). 실측 게인 −62/−35.5(@zoomRef=1).
 *   base(pan0,tilt0) 프레임 중심 = spec.cx0/cy0 (= slot_setup.lpd 유래 원본좌표에 상당).
 *   cx = cx0 + pan·(z/gp),  cy = cy0 + tilt·(z/gt).  화면 밖은 미검출. conf 로 신원 태깅.
 * probe(fallback −62/−35.5)가 이 게인의 참값이라 예측추적이 정확 → 레거시도 "정직 추적" 경로를 탄다
 * (즉 레거시 절도는 '추적 실패'가 아니라 '자기 판 부재 시 최근접의 무조건 선정'에서 온다).
 */
function makeRigidMock(specs: { cx0: number; cy0: number; conf: number }[], z0 = 1, gp = -62, gt = -35.5) {
  const moves: Ptz[] = [];
  const camera = {
    clampZoom: (z: number) => Math.min(36, Math.max(1, z)),
    requestImage: async (_c: number, _p: number, ptz?: { pan?: number; tilt?: number; zoom?: number }) => {
      moves.push({ pan: ptz?.pan ?? 0, tilt: ptz?.tilt ?? 0, zoom: ptz?.zoom ?? z0 });
      return { camIdx: 1, presetIdx: 1, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('img') };
    },
  } as unknown as ICameraClient;
  const lpd = {
    detect: async (): Promise<PlateBox[]> => {
      const mv = moves[moves.length - 1];
      const kx = mv.zoom / gp;
      const ky = mv.zoom / gt;
      const out: PlateBox[] = [];
      for (const s of specs) {
        const cx = s.cx0 + mv.pan * kx;
        const cy = s.cy0 + mv.tilt * ky;
        if (cx >= 0 && cx <= 1 && cy >= 0 && cy <= 1) out.push(plateAt(cx, cy, 0.05, 0.03, s.conf));
      }
      return out;
    },
  } as unknown as LpdClient;
  return { camera, lpd, moves };
}

function makePtz(m: ReturnType<typeof makeRigidMock>, opts: PlatePtzOpts = {}): PlatePtz {
  const deps: PlatePtzDeps = { camera: m.camera, lpd: m.lpd, sleep: async () => {} };
  return new PlatePtz(deps, { ...BASE, ...opts });
}

// ── T1. anti-latch 핵심 증명: 자기 판 부재 → 레거시=이웃 절도 vs 소유권=정직 미검 ──────────
describe('T1. 소유권 배타성 = 이웃 latch(절도) → 정직 미검 전환', () => {
  // 자기 슬롯(기대 중심 0.5,0.5)의 번호판이 실제로는 미검출(가려짐/서비스 한계).
  // 화면엔 좌·우 이웃 슬롯 번호판만 존재(각자 자기 Voronoi 셀 = 자기 peer 앵커 위).
  const NEIGH_L = 0.71; // 좌 이웃 신원 태그
  const NEIGH_R = 0.73; // 우 이웃 신원 태그
  const neighborsOnly = [
    { cx0: 0.34, cy0: 0.5, conf: NEIGH_L }, // 자기 기대(0.5)에서 −0.16
    { cx0: 0.68, cy0: 0.5, conf: NEIGH_R }, // +0.18
  ];
  // 같은 프리셋 타 슬롯(=두 이웃)의 판중심 − 자기 판중심(원본 프레임 상대오프셋).
  const peerOffsets: NormalizedPoint[] = [
    { x: -0.16, y: 0 },
    { x: 0.18, y: 0 },
  ];

  it('소유권(peerOffsets 주입): 이웃 판을 소유하지 않으므로 선정 null → no_plate(절도 안 함)', async () => {
    const m = makeRigidMock(neighborsOnly);
    const r = await makePtz(m, { peerOffsets }).centerOnPlate(1, 1, START1);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_plate'); // 이웃으로 갈아타지 않고 정직하게 미검
    expect(r.plate).toBeNull();
    expect(r.iterations).toBe(0);
    expect(m.moves.length).toBe(1); // 초기 캡처 1회뿐(probe 미발생 = 이웃을 자기로 착각하지 않음)
  });

  it('★대조군 — 레거시(peerOffsets 미전달): 이웃 판으로 latch(절도) → 이웃 신원으로 수렴', async () => {
    const m = makeRigidMock(neighborsOnly);
    const r = await makePtz(m).centerOnPlate(1, 1, START1); // 소유권 게이트 없음(현행 버그 경로)
    expect(r.ok).toBe(true); // 이웃을 자기 대상으로 착각해 "성공" 위장
    // 화면중앙 최근접(0.34 = dist 0.16 < 0.68 의 0.18)인 좌 이웃을 절도해 수렴.
    expect(r.plate!.confidence).toBeCloseTo(NEIGH_L, 6);
    expect(Math.abs(r.err!.errX)).toBeLessThanOrEqual(0.03);
  });
});

// ── T2. 자기 판 존재 시 소유권이 자기 판을 유지(회귀 0) + 이웃 기각 ─────────────────────
describe('T2. 자기 판 존재: 소유권=자기 판 수렴(레거시와 동일 — 회귀 0), 이웃 미선정', () => {
  const SELF = 0.9;
  const NEIGH_L = 0.71;
  const NEIGH_R = 0.73;
  // 자기 판(0.55)은 화면중앙(0.5) 근방, 이웃은 멀리. 자기 판이 자기 Voronoi 셀 소유.
  const withSelf = [
    { cx0: 0.55, cy0: 0.5, conf: SELF },
    { cx0: 0.3, cy0: 0.5, conf: NEIGH_L },
    { cx0: 0.8, cy0: 0.5, conf: NEIGH_R },
  ];
  const peerOffsets: NormalizedPoint[] = [
    { x: -0.2, y: 0 }, // → 앵커 0.30 (좌 이웃 위)
    { x: 0.3, y: 0 }, // → 앵커 0.80 (우 이웃 위)
  ];

  it('소유권 주입 → 자기 판(SELF) 신원 유지·수렴, 이웃 태그로 한 번도 갈아타지 않음', async () => {
    const m = makeRigidMock(withSelf);
    const r = await makePtz(m, { peerOffsets }).centerOnPlate(1, 1, START1);
    expect(r.ok).toBe(true);
    expect(r.plate!.confidence).toBeCloseTo(SELF, 6); // 자기 신원 유지
    expect(Math.abs(r.err!.errX)).toBeLessThanOrEqual(0.03);
    expect(Math.abs(r.err!.errY)).toBeLessThanOrEqual(0.03);
  });

  it('하위호환: 동일 world 를 peerOffsets 없이(레거시) 실행해도 자기 판 수렴 — 결과 동일(회귀 0)', async () => {
    const m = makeRigidMock(withSelf);
    const r = await makePtz(m).centerOnPlate(1, 1, START1);
    expect(r.ok).toBe(true);
    expect(r.plate!.confidence).toBeCloseTo(SELF, 6); // 자기 판이 최근접이라 레거시도 동일 결과
  });
});

// ── T3. PtzCalibrator.peerOffsetsFor 산출·프리셋 격리(설계 §A-2) ─────────────────────────
describe('T3. peerOffsetsFor: 같은 프리셋 자기제외 상대오프셋, 다른 프리셋 격리, 단일슬롯 → []', () => {
  const cfg: ToolsConfig['calibrate'] = {
    targetPlateWidth: 0.2, centerTol: 0.03, widthTol: 0.02, maxIterations: 30,
    probeStepDeg: 1.0, maxStepDeg: 5.0, fallbackGainPanDeg: -62, fallbackGainTiltDeg: -35.5,
    settleMs: 0, outFile: 'data/slot_ptz.json',
    // ★ 이 테스트는 peerOffsetsFor 산출(자기제외·프리셋격리·단일→[])만 검증한다.
    //   방안2 acquire 는 peerOffsets 를 rungZoom/presetZoom 배로 사전스케일하므로, acquire 줌 스케일 교란을
    //   제거하려 acquirePlateWidth=lpd폭(0.05)로 둔다 → acquireZoom≈presetZoom → 스케일계수≈1 → 원본 오프셋 보존.
    //   또 lpd폭 부동소수(0.0499…)로 acquireZoom 이 presetZoom 을 미세 초과해 사다리가 1rung 더 도는 것을
    //   막으려 사다리를 끈다(maxSteps=0) → 슬롯당 centerOnPlate 정확히 1회(captured 1:1 매핑).
    acquirePlateWidth: 0.05,
    acquireLadderMaxSteps: 0,
  };

  /** lpd 중심 cx(cy=0.5, w=0.05) 슬롯 뷰. slot_id=globalIdx. */
  function view(slotId: number, presetId: number, cx: number): SlotSetupView {
    return {
      slotId, camId: 1, presetId, presetSlotIdx: 1, presetKey: `1:${presetId}`,
      roi: [], vpd: null, lpd: rectToQuad({ x: cx - 0.025, y: 0.5 - 0.015, w: 0.05, h: 0.03 }),
      occupyRange: null, pan: null, tilt: null, zoom: null, centered: false, img1: null,
      slot3dFrontCenter: null, updatedAt: null,
    };
  }

  async function waitDone(cal: PtzCalibrator): Promise<void> {
    for (let i = 0; i < 5000 && cal.getStatus().state === 'running'; i++) await Promise.resolve();
  }

  it('프리셋 1:1 3슬롯(cx 0.325/0.464/0.62) + 프리셋 1:2 단일슬롯 → 각 슬롯 peerOffsets 정확', async () => {
    const views: SlotSetupView[] = [
      view(1, 1, 0.325),
      view(2, 1, 0.464),
      view(3, 1, 0.62),
      view(4, 2, 0.4), // 다른 프리셋 — 위 3슬롯의 peer 에서 제외되어야
    ];
    const store = {
      getSlotSetup: () => views,
      upsertSlotCentering: () => {},
    } as unknown as Pick<SqliteStore, 'upsertSlotCentering' | 'getSlotSetup'>;

    // makePlatePtz 시임: 슬롯별 주입된 peerOffsets 를 순서대로 캡처.
    // centerOnPlate 를 no_plate 로 반환 → zoom 미호출 → 슬롯당 makePlatePtz 정확히 1회(1:1 매핑).
    const captured: Array<NormalizedPoint[] | undefined> = [];
    const makePlatePtz = (opts: PlatePtzOpts) => {
      captured.push(opts.peerOffsets);
      return {
        centerOnPlate: async () => ({
          ok: false as const, ptz: { pan: 0, tilt: 0, zoom: 1 }, plate: null, err: null,
          plateWidth: null, gain: { gainPan: -62, gainTilt: -35.5, zoomRef: 1 }, iterations: 0,
          reason: 'no_plate' as const,
        }),
        zoomToPlateWidth: async () => {
          throw new Error('zoom 은 호출되면 안 됨(centerOnPlate no_plate)');
        },
      };
    };

    const deps: PtzCalibratorDeps = {
      // computeAcquirePlan 이 camera.clampZoom 을 쓰므로 실제 clamp 제공(구 경로는 camera 미사용이라 {} 였음).
      camera: { clampZoom: (z: number) => Math.min(36, Math.max(1, z)) } as unknown as ICameraClient,
      lpd: {} as unknown as LpdClient,
      store, cfg, makePlatePtz,
      writer: () => {}, sleep: async () => {}, now: () => 'T',
    };
    const cal = new PtzCalibrator(deps);
    cal.start();
    await waitDone(cal);
    expect(cal.getStatus().state).toBe('done');

    // 정렬 순서: cam1 preset1 slot1(0.325),slot2(0.464),slot3(0.62) → cam1 preset2 slot4(0.4).
    expect(captured).toHaveLength(4);

    // slot2(0.464): 자기제외 같은 프리셋 = 0.325, 0.62 → 오프셋 −0.139 / +0.156.
    const o2 = captured[1]!;
    expect(o2).toHaveLength(2);
    expect(o2[0].x).toBeCloseTo(0.325 - 0.464, 6); // −0.139
    expect(o2[0].y).toBeCloseTo(0, 6);
    expect(o2[1].x).toBeCloseTo(0.62 - 0.464, 6); // +0.156
    expect(o2[1].y).toBeCloseTo(0, 6);

    // slot1(0.325): peers 0.464, 0.62 → +0.139 / +0.295.
    const o1 = captured[0]!;
    expect(o1.map((o) => Number(o.x.toFixed(3)))).toEqual([0.139, 0.295]);

    // slot4(다른 프리셋 단일슬롯): peer 없음 → 스케일 결과 빈 배열 → opts 에서 조건부 생략(설계 §A-2)
    //   → opts.peerOffsets undefined(= PlatePtz 최근접 경로, [] 전달과 기능 동일).
    expect(captured[3]).toBeUndefined();
  });
});
