import { describe, it, expect } from 'vitest';
import { PlatePtz, type PlatePtzDeps, type PlatePtzOpts, type PlatePtzResult } from '../src/calibrate/platePtz.js';
import type { ICameraClient } from '../src/clients/CameraClient.js';
import type { LpdClient, PlateBox } from '../src/clients/LpdClient.js';
import { rectToQuad } from '../src/domain/geometry.js';
import type { Ptz } from '../src/calibrate/types.js';

/**
 * 검증자(qa-tester): **재포착(recapture) 계약 고정** — 이터1~3(tilt 디더 사다리 · zoom 승법 디더 · 금지선 · 무회귀).
 * 계약 출처: `_workspace/00_goal.md`(리더 라이브 실측) · `_workspace/01_architect_plan.md` §3~§9 ·
 *          `_workspace/02_developer_changes.md` §2/§6/§10.
 *
 * 스텁 관례는 `platePtz.test.ts` / `platePtzLadder.test.ts` 와 동일:
 *  - 카메라는 **명령 PTZ** 를 기록하고 응답 echo 는 0/0/1(신뢰 불가 재현).
 *  - LPD 모델은 (명령 PTZ, 캡처 순번)의 함수 = "프레임 내 결정적, 프레이밍이 바뀌면 결과가 바뀐다"(리더 실측).
 *  - 게인은 실측 물리 상수(zoomRef=1 기준 −62 / −35.5).
 *
 * ★ 라이브(실카메라·시뮬 LPD)는 리더가 이미 수행했다 — 이 파일은 카메라 API 를 호출하지 않는다.
 */

// ── 실측 물리 상수(platePtz.test.ts 와 동일 출처: diagSweep) ──────────────────
const GAIN_PAN_REF1 = -62;
const GAIN_TILT_REF1 = -35.5;
/** 리더 base PTZ 의 zoom(개별 클릭 시작점). */
const Z_BASE = 1.6934098;
/** 재포착 1배수 화면 변위(정규화) 기본값 = 1080p ≈1.5px. */
const U = 0.0014;
/** 신원 태그(confidence). */
const TARGET_CONF = 0.92;
const NEIGHBOR_CONF = 0.85;

function plateAt(cx: number, cy: number, w: number, conf: number, h = 0.03): PlateBox {
  return { quad: rectToQuad({ x: cx - w / 2, y: cy - h / 2, w, h }), confidence: conf, cls: 'plate' };
}

/** 명령 PTZ → 번호판 목록 모델을 주입받는 camera+lpd 스텁. moves = 명령 PTZ 궤적. */
function makeMock(model: (ptz: Ptz, callIdx: number) => PlateBox[], zoomMax = 36) {
  const moves: Ptz[] = [];
  let calls = 0;
  const camera = {
    clampZoom: (z: number) => Math.min(zoomMax, Math.max(1, z)),
    requestImage: async (_c: number, _p: number, ptz?: { pan?: number; tilt?: number; zoom?: number }) => {
      moves.push({ pan: ptz?.pan ?? 0, tilt: ptz?.tilt ?? 0, zoom: ptz?.zoom ?? 1 });
      return { camIdx: 1, presetIdx: 1, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('img') };
    },
  } as unknown as ICameraClient;
  const lpd = {
    detect: async (): Promise<PlateBox[]> => model(moves[moves.length - 1]!, calls++),
  } as unknown as LpdClient;
  return { camera, lpd, moves };
}

function makePtz(m: { camera: ICameraClient; lpd: LpdClient }, opts: PlatePtzOpts = {}): PlatePtz {
  const deps: PlatePtzDeps = { camera: m.camera, lpd: m.lpd, sleep: async () => {} };
  return new PlatePtz(deps, { settleMs: 0, ...opts });
}

/** 각 오프셋 정의로부터 프레임 검출목록 생성(카메라가 움직이면 모든 판이 함께 이동 — 실측 물리). */
interface PlateDef { ax: number; ay: number; w1: number; conf: number }
function worldPlates(ptz: Ptz, defs: PlateDef[]): PlateBox[] {
  const kx = ptz.zoom / GAIN_PAN_REF1;
  const ky = ptz.zoom / GAIN_TILT_REF1;
  const out: PlateBox[] = [];
  for (const d of defs) {
    const cx = 0.5 + (d.ax + ptz.pan) * kx;
    const cy = 0.5 + (d.ay + ptz.tilt) * ky;
    if (cx >= 0 && cx <= 1 && cy >= 0 && cy <= 1) out.push(plateAt(cx, cy, Math.min(0.9, d.w1 * ptz.zoom), d.conf));
  }
  return out;
}

/** 재포착 6회(클릭 경로 주입값)를 켠 opts. */
const RECAPTURE_ON: PlatePtzOpts = { plateRecaptureRetries: 6, plateRecaptureDitherNorm: U, plateRecaptureZoomStep: 0.01 };

// ══════════════════════════════════════════════════════════════════════════════
// R1. tilt 디더 사다리 — 배수 순서 [+1,−1,+2,−2,+4,−4] 와 변위→각 환산(픽셀 등가)
// ══════════════════════════════════════════════════════════════════════════════
describe('R1. tilt 디더 사다리(배수 순서·각도 환산)', () => {
  /** 초기 1회만 검출, 이후(probe·추적) 전부 미검 → 사다리 전체가 소진된다. */
  const firstOnly = (_ptz: Ptz, i: number): PlateBox[] => (i === 0 ? [plateAt(0.5, 0.62, 0.03, TARGET_CONF)] : []);

  /** 캡처 순번: 0=초기 선정, 1=probe, 2..8=추적 7회(원 캡처 + 디더 6회). */
  async function run(zoom: number): Promise<{ moves: Ptz[]; res: PlatePtzResult }> {
    const m = makeMock(firstOnly);
    const res = await makePtz(m, RECAPTURE_ON).centerOnPlate(1, 1, { pan: 0, tilt: 0, zoom });
    return { moves: m.moves, res };
  }

  it('추적 캡처는 7회(원 1 + 디더 6)이고 tilt 델타 배수가 정확히 [0,+1,−1,+2,−2,+4,−4]', async () => {
    const { moves, res } = await run(Z_BASE);
    const track = moves.slice(2);
    expect(track).toHaveLength(7);
    const d = (U * Math.abs(GAIN_TILT_REF1)) / Z_BASE; // 1배수 각도(°)
    const expected = [0, 1, -1, 2, -2, 4, -4].map((k) => k * d);
    track.forEach((p, i) => {
      expect(p.tilt - track[0]!.tilt).toBeCloseTo(expected[i]!, 9);
      expect(p.pan).toBeCloseTo(track[0]!.pan, 12);   // 디더 축은 tilt 단독(pan 불변)
      expect(p.zoom).toBeCloseTo(Z_BASE, 12);         // zoom 불변
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('plate_lost');
    expect(res.recaptureDithers).toBe(6);
    // 실패 시 반환 ptz = 마지막으로 **명령한** PTZ(카메라의 실제 위치 — 지어내지 않는다).
    expect(res.ptz.tilt).toBeCloseTo(track[6]!.tilt, 12);
  });

  it('1배수 각 = U×|fallbackGainTiltDeg|/zoom — base zoom 1.6934 에서 ±4배수 ≈ 0.117°', async () => {
    const { moves } = await run(Z_BASE);
    const track = moves.slice(2);
    expect(track[5]!.tilt - track[0]!.tilt).toBeCloseTo(0.1174, 4);   // +4배수
    expect(track[6]!.tilt - track[0]!.tilt).toBeCloseTo(-0.1174, 4);  // −4배수
  });

  it('zoom 36 에서 ±4배수 ≈ 0.0055° — 각도는 36배 작지만 **화면 변위(픽셀)는 동일** 0.0056', async () => {
    const { moves } = await run(36);
    const track = moves.slice(2);
    const dDeg = track[5]!.tilt - track[0]!.tilt;
    expect(dDeg).toBeCloseTo(0.00552, 5);
    // 변위 = 각 × zoom / |gainTiltRef1| — zoom 1.6934 과 36 에서 같은 값이어야 한다(픽셀 공간 고정).
    const normAt36 = (dDeg * 36) / Math.abs(GAIN_TILT_REF1);
    const base = await run(Z_BASE);
    const bt = base.moves.slice(2);
    const normAtBase = ((bt[5]!.tilt - bt[0]!.tilt) * Z_BASE) / Math.abs(GAIN_TILT_REF1);
    expect(normAt36).toBeCloseTo(4 * U, 12);
    expect(normAtBase).toBeCloseTo(4 * U, 12);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// R2. tilt 디더 회복 — 첫 캡처 미검이지만 디더된 프레임에서 검출 → ok:true
// ══════════════════════════════════════════════════════════════════════════════
describe('R2. tilt 디더 재포착 회복', () => {
  // 대상: (0.5, 0.62) 에서 시작(errY=+0.12) · 이웃: 우측 0.15.
  const TARGET: PlateDef = { ax: 0, ay: 0.12 * GAIN_TILT_REF1, w1: 0.03, conf: TARGET_CONF };
  const NEIGHBOR: PlateDef = { ax: 0.15 * GAIN_PAN_REF1, ay: 0.12 * GAIN_TILT_REF1, w1: 0.03, conf: NEIGHBOR_CONF };

  it('추적 캡처 3회(원+±1배수)가 미검이고 +2배수에서 검출 → ok:true / recaptureDithers=3 / 디더된 PTZ 채택', async () => {
    // 캡처 0=초기, 1=probe, 2·3·4=추적 미검(원·+1·−1), 5=+2배수 검출.
    const blackout = new Set([2, 3, 4]);
    const m = makeMock((ptz, i) => (blackout.has(i) ? [] : worldPlates(ptz, [TARGET, NEIGHBOR])));
    const res = await makePtz(m, RECAPTURE_ON).centerOnPlate(1, 1, { pan: 0, tilt: 0, zoom: 1 });

    expect(res.ok).toBe(true);
    expect(res.recaptureDithers).toBe(3);
    expect(res.plate?.confidence).toBe(TARGET_CONF); // 이웃이 아니라 대상 판
    // 채택된 PTZ = +2배수 디더가 실린 값(원복하지 않는다 — 설계 §5).
    const d = U * Math.abs(GAIN_TILT_REF1); // zoom 1 에서의 1배수 각
    const track = m.moves.slice(2);
    expect(track).toHaveLength(4);
    expect(res.ptz.tilt).toBeCloseTo(track[0]!.tilt + 2 * d, 12);
    expect(res.ptz.tilt).toBeCloseTo(track[3]!.tilt, 12);
  });

  it('recaptureDithers 는 호출 단위 **누계** — 반복마다 디더가 발생하면 합산된다', async () => {
    // 큰 오차(errY=0.3)라 maxStepDeg(5°) 클램프로 2반복이 필요하다. 각 반복의 첫 추적 캡처를 미검으로 만든다.
    const far: PlateDef = { ax: 0, ay: 0.3 * GAIN_TILT_REF1, w1: 0.03, conf: TARGET_CONF };
    const blackout = new Set([2, 4]); // 0=초기 1=probe 2=iter0 원캡처 3=iter0 +1배수 4=iter1 원캡처 5=iter1 +1배수
    const m = makeMock((ptz, i) => (blackout.has(i) ? [] : worldPlates(ptz, [far])));
    const res = await makePtz(m, RECAPTURE_ON).centerOnPlate(1, 1, { pan: 0, tilt: 0, zoom: 1 });
    expect(res.ok).toBe(true);
    expect(res.iterations).toBe(2);
    expect(res.recaptureDithers).toBe(2); // 반복당 1회씩 누계
  });

  it('디더 재시도의 prior 는 디더분을 포함해 재계산된다 — 예측이 실제 위치와 일치해 게이트를 통과', async () => {
    // prior 보정이 없으면 디더분만큼 예측이 어긋난다. 여기서는 회복 성공 자체가 보정의 증거이므로,
    // 보정 없이는 통과 불가능한 좁은 게이트(0.004 = 최대 디더 변위 0.0056 보다 작다)로 고정한다.
    const blackout = new Set([2, 3, 4]);
    const m = makeMock((ptz, i) => (blackout.has(i) ? [] : worldPlates(ptz, [TARGET, NEIGHBOR])));
    const res = await makePtz(m, { ...RECAPTURE_ON, matchRadiusNorm: 0.004 }).centerOnPlate(1, 1, { pan: 0, tilt: 0, zoom: 1 });
    expect(res.ok).toBe(true);
    expect(res.recaptureDithers).toBe(3);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// R3. ★ 금지선(거짓 성공 0)
// ══════════════════════════════════════════════════════════════════════════════
describe('R3. 금지선 — 디더는 반경 게이트를 한 치도 넓히지 않는다', () => {
  const TARGET: PlateDef = { ax: 0, ay: 0.12 * GAIN_TILT_REF1, w1: 0.03, conf: TARGET_CONF };
  const NEIGHBOR: PlateDef = { ax: 0.15 * GAIN_PAN_REF1, ay: 0.12 * GAIN_TILT_REF1, w1: 0.03, conf: NEIGHBOR_CONF };

  it('추적 중 대상이 사라지고 이웃만 남으면 → 디더를 다 써도 plate_lost, 이웃을 대신 채택하지 않는다', async () => {
    const m = makeMock((ptz, i) => (i < 2 ? worldPlates(ptz, [TARGET, NEIGHBOR]) : worldPlates(ptz, [NEIGHBOR])));
    const res = await makePtz(m, RECAPTURE_ON).centerOnPlate(1, 1, { pan: 0, tilt: 0, zoom: 1 });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('plate_lost');
    expect(res.recaptureDithers).toBe(6);
    // 반환 plate 는 **마지막으로 확인된 대상**이며 이웃으로 갈아타지 않았다.
    expect(res.plate?.confidence).toBe(TARGET_CONF);
    expect(res.plate?.confidence).not.toBe(NEIGHBOR_CONF);
    expect(m.moves.slice(2)).toHaveLength(7); // 원 1 + 디더 6 전부 소진
  });

  // 최대 디더 변위 0.0056(=4×U) 이므로 "이론적 최악의 게이트 확장"은 0.08+0.0056=0.0856 이다.
  // 그 창 안(0.0805·0.083·0.085) 어디에도 채택이 발생하지 않음을 고정한다 — prior 를 디더분만큼 함께
  // 옮기기 때문에 상대거리가 불변이고, 실제 이웃 간격 0.15 는 이 창보다 26배 멀다.
  it.each([0.0805, 0.083, 0.085])('게이트 바로 밖(+%s > radius 0.08)의 유령 판은 최대 디더에도 채택되지 않는다', async (gap) => {
    // 추적 프레임에는 "대상 위치 + gap" 에 있는 판만 존재한다. 반경이 완화되면(예: 실측 기각거리 0.126)
    // 이 판이 채택돼 거짓 성공이 된다 → 완화가 없음을 이 단언이 증명한다.
    const m = makeMock((ptz, i) => {
      const real = worldPlates(ptz, [TARGET]);
      if (i < 2) return real;
      const t = real[0];
      if (!t) return [];
      const cx = (t.quad[0]!.x + t.quad[1]!.x) / 2;
      const cy = (t.quad[0]!.y + t.quad[2]!.y) / 2;
      return [plateAt(cx + gap, cy, 0.03, NEIGHBOR_CONF)];
    });
    const res = await makePtz(m, RECAPTURE_ON).centerOnPlate(1, 1, { pan: 0, tilt: 0, zoom: 1 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('plate_lost');
    expect(res.recaptureDithers).toBe(6);
    expect(res.plate?.confidence).toBe(TARGET_CONF);
  });

  it('전 시도 미검(화면에 아무것도 없음) → plate_lost 확정(위장 성공 0)', async () => {
    const m = makeMock((ptz, i) => (i < 2 ? worldPlates(ptz, [TARGET]) : []));
    const res = await makePtz(m, RECAPTURE_ON).centerOnPlate(1, 1, { pan: 0, tilt: 0, zoom: 1 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('plate_lost');
    expect(res.recaptureDithers).toBe(6);
  });

  it('최초 대상 선정(클릭 반경 게이트)은 디더하지 않는다 → no_plate_near_click · plate=null · 캡처 정확히 1회', async () => {
    // 클릭점(0.5,0.5) 반경 0.10 밖에만 판이 있다(0.5,0.75) → 대신 채택 금지.
    const m = makeMock(() => [plateAt(0.5, 0.75, 0.03, NEIGHBOR_CONF)]);
    const res = await makePtz(m, { ...RECAPTURE_ON, initialRadiusNorm: 0.10 }).centerOnPlate(1, 1, { pan: 0, tilt: 0, zoom: 1 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no_plate_near_click');
    expect(res.plate).toBeNull();
    expect(m.moves).toHaveLength(1);              // 첫 캡처는 재시도 대상이 아니다(설계 §3.5)
    expect(res.recaptureDithers).toBeUndefined(); // 디더 0 → 필드 자체가 없다
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// R4. zoom 승법 디더(C 지점) — 리더 실측 데드존 재현
// ══════════════════════════════════════════════════════════════════════════════
describe('R4. zoom 승법 디더(줌 스텝 직후 캡처)', () => {
  const W0 = 0.012; // 폭 = W0 × zoom
  const START: Ptz = { pan: 0, tilt: 0, zoom: 5.4492 }; // ×1.5 = 8.1738(리더 실측 데드존 지점)
  const ZOPTS: PlatePtzOpts = {
    ...RECAPTURE_ON, targetPlateWidth: 0.2, widthTol: 0.02, maxZoomStepRatio: 1.5, maxIterations: 15,
  };
  const centerPlate = (ptz: Ptz): PlateBox[] => [plateAt(0.5, 0.5, Math.min(0.9, W0 * ptz.zoom), TARGET_CONF)];

  it('실측 표 그대로의 데드존(7.8/8.0/8.1738 ✗, 8.25 ✓) → ×1.01 한 칸으로 회복(dithers=1)', async () => {
    const dead = (z: number) => z > 7.7 && z <= 8.2;
    const m = makeMock((ptz) => (dead(ptz.zoom) ? [] : centerPlate(ptz)));
    const res = await makePtz(m, ZOPTS).zoomToPlateWidth(1, 1, START);
    expect(res.ok).toBe(true);
    expect(res.recaptureDithers).toBe(1);
    expect(m.moves[1]!.zoom).toBeCloseTo(8.1738, 6);          // 원 줌 스텝(미검)
    expect(m.moves[2]!.zoom).toBeCloseTo(8.1738 * 1.01, 6);   // ×1.01 회복
  });

  it('라이브 실측(이터3)처럼 데드존이 더 넓으면 ×1.02 에서 회복 — 배수 사다리는 [×1.01,×0.99,×1.02]', async () => {
    const dead = (z: number) => z > 7.7 && z <= 8.30;
    const m = makeMock((ptz) => (dead(ptz.zoom) ? [] : centerPlate(ptz)));
    const res = await makePtz(m, ZOPTS).zoomToPlateWidth(1, 1, START);
    expect(res.ok).toBe(true);
    expect(res.recaptureDithers).toBe(3);
    const zs = m.moves.slice(1, 5).map((p) => p.zoom);
    expect(zs[0]).toBeCloseTo(8.1738, 6);
    expect(zs[1]! / zs[0]!).toBeCloseTo(1.01, 9);
    expect(zs[2]! / zs[0]!).toBeCloseTo(0.99, 9);
    expect(zs[3]! / zs[0]!).toBeCloseTo(1.02, 9);
    // ★ 폭 판정은 항상 **그 프레임에서 실측한 폭**이다(디더 전 폭을 재사용하는 경로가 없다).
    expect(res.plateWidth).toBeCloseTo(W0 * res.ptz.zoom, 12);
  });

  it('★ 폭 판정은 디더된 그 프레임의 실측값 — 반환 (zoom, plateWidth) 쌍이 서로 정합한다', async () => {
    // 수렴이 오직 디더된 프레임에서 일어나게 만든다(원 줌 스텝은 데드존이라 폭을 잴 기회조차 없다).
    const step = 16 * Math.sqrt(0.2 / (W0 * 16)); // 16.3299 — 이 지점이 데드존이다
    const dead = (z: number) => z > 16.1 && z <= 16.5;
    const m = makeMock((ptz) => (dead(ptz.zoom) ? [] : centerPlate(ptz)));
    const res = await makePtz(m, { ...ZOPTS, widthTol: 0.005 }).zoomToPlateWidth(1, 1, { pan: 0, tilt: 0, zoom: 16 });
    expect(res.ok).toBe(true);
    expect(res.recaptureDithers).toBe(3);                     // ×1.01·×0.99 미검 → ×1.02 에서 회복+수렴
    expect(res.ptz.zoom).toBeCloseTo(step * 1.02, 6);         // 디더된 zoom 이 그대로 상태
    expect(res.plateWidth).toBeCloseTo(W0 * step * 1.02, 12); // 그 배율에서 실제로 잰 폭(±4% 왜곡 없음)
  });

  it('clampZoom 포화 시도는 캡처 없이 건너뛴다(왕복 0) — dithers 에도 세지 않는다', async () => {
    // zoomMax=10 · cmd.zoom=10 → ×1.01 은 clamp 로 같은 배율 = 스킵, ×0.99(9.9)에서 회복.
    const dead = (z: number) => z >= 9.95 && z <= 10.05;
    const m = makeMock((ptz) => (dead(ptz.zoom) ? [] : [plateAt(0.5, 0.5, 0.02 * ptz.zoom, TARGET_CONF)]), 10);
    const res = await makePtz(m, {
      ...RECAPTURE_ON, targetPlateWidth: 0.25, widthTol: 0.001, maxZoomStepRatio: 1.5, maxIterations: 1,
    }).zoomToPlateWidth(1, 1, { pan: 0, tilt: 0, zoom: 9.9 });

    expect(m.moves.map((p) => p.zoom)).toHaveLength(3); // 초기 9.9 · 원 캡처 10 · ×0.99 9.9 (×1.01 은 캡처 없음)
    expect(m.moves[1]!.zoom).toBeCloseTo(10, 9);
    expect(m.moves[2]!.zoom).toBeCloseTo(9.9, 9);
    expect(res.recaptureDithers).toBe(1);            // 스킵은 세지 않는다
    expect(res.plateWidth).toBeCloseTo(0.02 * 9.9, 9); // 디더된 그 프레임의 실측 폭
  });

  it('zoom 축에서도 금지선 유지 — 전 배율 미검이면 plate_lost(이웃 대체 채택 없음)', async () => {
    const m = makeMock((ptz, i) => (i === 0 ? centerPlate(ptz) : [plateAt(0.5 + 0.12, 0.5, 0.03, NEIGHBOR_CONF)]));
    const res = await makePtz(m, ZOPTS).zoomToPlateWidth(1, 1, START);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('plate_lost');
    expect(res.recaptureDithers).toBe(6);
    expect(res.plate?.confidence).toBe(TARGET_CONF);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// R5. ★ 무회귀 — 기본값(재시도 0)에서 기존 동작과 완전 동형
// ══════════════════════════════════════════════════════════════════════════════
describe('R5. 무회귀(기본 재시도 0 = 기존 동작)', () => {
  const TARGET: PlateDef = { ax: 0, ay: 0.12 * GAIN_TILT_REF1, w1: 0.03, conf: TARGET_CONF };

  it('centerOnPlate: 미검 1회 → 즉시 plate_lost, 추적 캡처 정확히 1회, ptz=원 명령값, recaptureDithers 필드 없음', async () => {
    const m = makeMock((ptz, i) => (i < 2 ? worldPlates(ptz, [TARGET]) : []));
    const res = await makePtz(m, {}).centerOnPlate(1, 1, { pan: 0, tilt: 0, zoom: 1 });
    expect(res.reason).toBe('plate_lost');
    expect(m.moves.slice(2)).toHaveLength(1);
    expect(res.ptz.tilt).toBe(m.moves[2]!.tilt); // 디더가 실리지 않은 원 명령값
    expect('recaptureDithers' in res).toBe(false);
  });

  it('옵션 미주입과 "retries:0 + 디더 상수 명시"가 캡처 궤적·결과까지 완전히 동일', async () => {
    const model = (ptz: Ptz, i: number): PlateBox[] => (i < 2 ? worldPlates(ptz, [TARGET]) : []);
    const a = makeMock(model);
    const ra = await makePtz(a, {}).centerOnPlate(1, 1, { pan: 0, tilt: 0, zoom: 1 });
    const b = makeMock(model);
    const rb = await makePtz(b, { plateRecaptureRetries: 0, plateRecaptureDitherNorm: U, plateRecaptureZoomStep: 0.01 })
      .centerOnPlate(1, 1, { pan: 0, tilt: 0, zoom: 1 });
    expect(b.moves).toEqual(a.moves);
    expect(rb).toEqual(ra);
  });

  it('zoomToPlateWidth: 줌 직후 미검 1회 → 즉시 plate_lost, 캡처 정확히 2회', async () => {
    const m = makeMock((ptz, i) => (i === 0 ? [plateAt(0.5, 0.5, 0.012 * ptz.zoom, TARGET_CONF)] : []));
    const res = await makePtz(m, { targetPlateWidth: 0.2, widthTol: 0.02, maxZoomStepRatio: 1.5 })
      .zoomToPlateWidth(1, 1, { pan: 0, tilt: 0, zoom: 5.4492 });
    expect(res.reason).toBe('plate_lost');
    expect(m.moves).toHaveLength(2);
    expect('recaptureDithers' in res).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// R6. 사다리(centerAndZoomByLadder) 는 디더를 타지 않는다(설계 §7 D 미적용)
// ══════════════════════════════════════════════════════════════════════════════
describe('R6. 사다리 무회귀(D 지점 미적용 고정)', () => {
  /** 상태 있는 스텁(사다리는 네이티브 setcenter/move 로 pan/tilt 를 바꾼다). */
  function makeLadderMock(model: (ptz: Ptz, callIdx: number) => PlateBox[], start: Ptz) {
    let state: Ptz = { ...start };
    const captures: Ptz[] = [];
    let calls = 0;
    const clampZoom = (z: number) => Math.min(36, Math.max(1, z));
    const camera = {
      clampZoom,
      requestImage: async (_c: number, _p: number, ptz?: { pan?: number; tilt?: number; zoom?: number }) => {
        state = { pan: ptz?.pan ?? state.pan, tilt: ptz?.tilt ?? state.tilt, zoom: clampZoom(ptz?.zoom ?? state.zoom) };
        captures.push({ ...state });
        return { camIdx: 1, presetIdx: 1, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('img') };
      },
      getPtz: async (): Promise<Ptz> => ({ ...state }),
      move: async (_c: number, pan: number, tilt: number, zoom: number): Promise<boolean> => {
        state = { pan, tilt, zoom: clampZoom(zoom) };
        return true;
      },
    } as unknown as ICameraClient;
    const lpd = { detect: async (): Promise<PlateBox[]> => model(captures[captures.length - 1]!, calls++) } as unknown as LpdClient;
    return { camera, lpd, captures };
  }

  it('중간 rung 미검이 있어도 retries 0/6 의 캡처 궤적·결과가 완전히 동일', async () => {
    const model = (ptz: Ptz, i: number): PlateBox[] =>
      i === 2 ? [] : [plateAt(0.5, 0.5, Math.min(0.9, 0.02 * ptz.zoom), TARGET_CONF)];
    const start: Ptz = { pan: 0, tilt: 0, zoom: 1 };
    const base: PlatePtzOpts = {
      settleMs: 0, nativeAimSettleMs: 0, targetPlateWidth: 0.2, widthTol: 0.02,
      maxZoomStepRatio: 1.5, initialRadiusNorm: 0.10,
    };
    const a = makeLadderMock(model, start);
    const ra = await new PlatePtz({ camera: a.camera, lpd: a.lpd, sleep: async () => {} }, base)
      .centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, start);
    const b = makeLadderMock(model, start);
    const rb = await new PlatePtz({ camera: b.camera, lpd: b.lpd, sleep: async () => {} }, { ...base, ...RECAPTURE_ON })
      .centerAndZoomByLadder(1, 1, { x: 0.5, y: 0.5 }, start);

    expect(b.captures).toEqual(a.captures);
    expect(rb).toEqual(ra);
    expect('recaptureDithers' in rb).toBe(false);
  });
});
