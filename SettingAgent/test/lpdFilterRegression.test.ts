import { describe, it, expect, vi } from 'vitest';
import { runDetect, type DetectDeps, type DetectCfg, type DetectResult, type DetectPlate } from '../src/capture/detectPipeline.js';
import { aggregate, type AggregateOptions } from '../src/capture/Aggregator.js';
import { filterPlatesOnPlace } from '../src/capture/onPlaceFilter.js';
import { center, quadBoundingRect } from '../src/domain/geometry.js';
import { pointInPolygon } from '../src/domain/polygon.js';
import type { DetectionRow } from '../src/capture/types.js';
import type { CapturedImage, VehicleBox, NormalizedQuad, NormalizedPoint } from '../src/domain/types.js';
import type { PlateBox } from '../src/clients/LpdClient.js';
import type { CameraList } from '../src/viewer/CameraSource.js';
// 프론트 소비처 **그 코드 그대로**(이중구현 금지) — web/core.js 는 순수 ESM.
import { computeOccupancy, quadCentroid } from '../web/core.js';

/**
 * 검증자(qa-tester, 독립 2차): LPD 주차면 필터의 **무회귀 반증 시도**.
 * 근거: 06_architect_plan_lpd.md §1(★ 증명 가능한 무회귀 성질) / §2(Aggregator 회귀 없음).
 *
 * 설계서는 두 가지를 "증명했다"고 주장한다. 이 파일은 그 주장을 **반증하려 시도**한다:
 *   주장1 «점유 불변»   — computeOccupancy 결과가 모드A/모드B 에서 동일하다.
 *   주장2 «집계 불변»   — 상류 필터가 버리는 번호판은 Aggregator 도 버렸을 것이라 aggregate() 산출이 동일하다.
 *
 * **결과(당시)**: 둘 다 반례 발견 → D-1 / D-2 (`08_qa_report_lpd.md`).
 * **갱신(D-1 수정 후)**: 주장1 의 반례(중심 정의 불일치)는 **해소**되었다 — (B) 항이 소비처와 동일한
 *   `quadCentroid`(4점 평균)를 쓰도록 고쳤다(`10_developer_fix_d1.md`). 이 파일의 ★★ 케이스는
 *   **반례가 해소되었음을 단언하는 방향**으로 갱신했고, 성질 자체를 무작위 300 quad 로 일반화해 봉인한다.
 * **D-2 는 그대로 유효하다**(집계 대표 좌표 이동 — 손실 0·개선 방향, 코드 수정 대상 아님).
 *
 * 소비처 union 은 web/app.js:335 · web/core.js:585 와 **동일 식**을 쓴다:
 *   plates = [...detect.plates, ...detect.vehicles.map(v => v.plate).filter(Boolean)]
 */

const VALID_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x00, 0xc8, 0, 0, 0, 0, 0, 0, 0, 0,
]);
const cfg: DetectCfg = { fovBaseV: 33.1, aspect: 16 / 9, frontBias: 0.62, zoomFactors: [2, 3, 4, 5], zoomRef: 1 };

function makeDeps(vehicles: VehicleBox[], platesBase: PlateBox[]): DetectDeps {
  let lpdCall = 0;
  return {
    camera: {
      requestImage: vi.fn(async (camIdx: number, presetIdx: number): Promise<CapturedImage> => ({
        camIdx, presetIdx, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: VALID_JPEG,
      })),
      listCameras: vi.fn(async (): Promise<CameraList> => ({
        cameras: [{ camIdx: 1, name: 'C1', enabled: true, presets: [{ presetIdx: 1, label: 'p1', pan: 50, tilt: 7, zoom: 1.4 }] }],
      })),
      clampZoom: vi.fn((z: number) => Math.min(10, Math.max(1, z))),
    },
    // base 프레임(1회차)만 번호판을 준다. zoom 재시도 뷰는 빈 배열 → recovered 없음(점유 비교를 base 필터에 격리).
    vpd: { detect: vi.fn(async () => vehicles) },
    lpd: { detect: vi.fn(async () => (lpdCall++ === 0 ? platesBase : [])) },
  };
}

/** 모드A(필터 ON) / 모드B(필터 OFF) 를 **같은 입력**으로 각각 돌린다. */
async function bothModes(vehicles: VehicleBox[], plates: PlateBox[], polys: NormalizedPoint[][]) {
  const modeA = await runDetect(makeDeps(vehicles, plates), { cam: 1, preset: 1 }, cfg, { onlyOnPlace: true, polys });
  const modeB = await runDetect(makeDeps(vehicles, plates), { cam: 1, preset: 1 }, cfg, { onlyOnPlace: false, polys });
  return { modeA, modeB };
}

/**
 * ★ 프론트 소비처와 **동일한 union**(web/app.js:335, web/core.js:585):
 *   `[...detect.plates, ...detect.vehicles.map(v => v.plate).filter(Boolean)]`
 * (TS 는 filter(Boolean) 로 좁혀지지 않으므로 타입가드로 같은 의미를 쓴다.)
 */
const frontPlates = (d: DetectResult): { quad: NormalizedQuad }[] => [
  ...d.plates,
  ...d.vehicles.map((v) => v.plate).filter((p): p is DetectPlate => p != null),
];

/** floorPolygons = 파일 바닥ROI(= 필터가 쓰는 바로 그 폴리곤). selectFloorRoi(useLlm:false) 산출 형태. */
const floorOf = (polys: NormalizedPoint[][]) => polys.map((quad, i) => ({ idx: i + 1, quad }));

/** 모드A/모드B 의 프론트 점유 판정을 각각 계산. */
function occupancyBoth(modeA: DetectResult, modeB: DetectResult, polys: NormalizedPoint[][]) {
  const floor = floorOf(polys);
  return {
    occA: computeOccupancy(floor, frontPlates(modeA)).map((o: any) => ({ idx: o.idx, occupied: o.occupied })),
    occB: computeOccupancy(floor, frontPlates(modeB)).map((o: any) => ({ idx: o.idx, occupied: o.occupied })),
  };
}

/** 뒷줄 주차면(원근으로 아래 변이 약간 넓다). 통로는 y > 0.45. */
const BACK_ROW: NormalizedPoint[] = [
  { x: 0.30, y: 0.30 },
  { x: 0.56, y: 0.30 },
  { x: 0.58, y: 0.45 },
  { x: 0.28, y: 0.45 },
];
const POLYS = [BACK_ROW];

/** 축대칭 번호판 quad(4점 평균 == bbox 중심 — 두 정의가 일치하는 정상 케이스). */
const plateQuad = (cx: number, cy: number): NormalizedQuad => [
  { x: cx - 0.025, y: cy - 0.012 },
  { x: cx + 0.025, y: cy - 0.012 },
  { x: cx + 0.025, y: cy + 0.012 },
  { x: cx - 0.025, y: cy + 0.012 },
];
const plate = (cx: number, cy: number): PlateBox => ({ quad: plateQuad(cx, cy), confidence: 0.9, cls: 'car_license_plate' });
const vehicle = (x: number, y: number, w: number, h: number, confidence = 0.8): VehicleBox => ({ rect: { x, y, w, h }, confidence, cls: 'vehicle' });

/** 주차차(접지 밴드가 BACK_ROW 안). 번호판은 rect 안·폴리곤 안(0.43,0.38). */
const PARKED = vehicle(0.33, 0.18, 0.20, 0.26);
/** 통로 통행차(접지선이 통로). 번호판은 rect 안·폴리곤 밖. */
const PASSING = vehicle(0.32, 0.55, 0.20, 0.32);

// ────────────────────────────────────────────────────────────────────────────
// 주장1 «점유 불변» — 반증 시도
// ────────────────────────────────────────────────────────────────────────────

describe('★ 주장1 «점유 불변» — computeOccupancy 가 모드A/모드B 에서 동일한가 (반증 시도)', () => {
  it('S1 주차차+통행차+각자의 번호판 → 번호판은 필터되지만 점유 판정은 동일', async () => {
    const plates = [plate(0.43, 0.38), plate(0.42, 0.70)]; // 주차차 것(폴리곤 안) / 통행차 것(폴리곤 밖)
    const { modeA, modeB } = await bothModes([PARKED, PASSING], plates, POLYS);

    expect(modeA.plates).toHaveLength(1); // 통행차 번호판 드롭(마스터 증상 해소)
    expect(modeB.plates).toHaveLength(2);
    expect(modeA.summary.lpdFilteredOut).toBe(1);

    const { occA, occB } = occupancyBoth(modeA, modeB, POLYS);
    expect(occA).toEqual(occB); // ← 필터가 지운 번호판은 점유를 참으로 만들 수 없었다
    expect(occA).toEqual([{ idx: 1, occupied: true }]);
  });

  it('S2 (B항) VPD 가 주차차를 **놓친** 프레임 → 폴리곤 안 번호판이 살아 점유가 뒤집히지 않는다', async () => {
    // (B) 항이 없으면 modeA 의 점유가 false 로 뒤집힌다 — OR 규칙의 존재 이유.
    const { modeA, modeB } = await bothModes([], [plate(0.43, 0.38)], POLYS);
    expect(modeA.summary.vpdCount).toBe(0);
    expect(modeA.plates).toHaveLength(1);

    const { occA, occB } = occupancyBoth(modeA, modeB, POLYS);
    expect(occA).toEqual([{ idx: 1, occupied: true }]); // 점유 유지
    expect(occA).toEqual(occB);
  });

  it('S3 (A항) 번호판이 kept 차량 안·폴리곤 밖 → 유지되지만 점유에는 기여하지 않는다(양쪽 동일)', async () => {
    const { modeA, modeB } = await bothModes([PARKED], [plate(0.43, 0.22)], POLYS); // rect 안 / 폴리곤 밖
    expect(modeA.plates).toHaveLength(1);
    expect(modeA.summary.lpdFilteredOut).toBe(0);

    const { occA, occB } = occupancyBoth(modeA, modeB, POLYS);
    expect(occA).toEqual([{ idx: 1, occupied: false }]);
    expect(occA).toEqual(occB);
  });

  it('S4 (V-1) 거대 병합 박스 + 배경 번호판 5개 → 1개만 통과하지만 점유는 양쪽 동일', async () => {
    const GIANT = vehicle(0.040, 0.0, 0.679, 0.663, 0.39); // 리더 실측 (77,0)-(1380,716)
    const bg = [0.10, 0.20, 0.30, 0.40, 0.50].map((x) => plate(x, 0.10)); // 전부 GIANT 안 · 폴리곤 밖
    const { modeA, modeB } = await bothModes([GIANT], bg, POLYS);

    const { occA, occB } = occupancyBoth(modeA, modeB, POLYS);
    expect(occA).toEqual(occB);
    expect(occA).toEqual([{ idx: 1, occupied: false }]);
  });

  /**
   * ★★ 구 반례 (COUNTEREXAMPLE) — **D-1. 수정으로 해소되었다.** (반례를 지우지 않고 방향을 뒤집어 봉인한다.)
   *
   * 수정 전:
   *   서버 필터 (B) 항의 중심 = `center(quadBoundingRect(quad))` (bbox 중심)
   *   프론트 점유 판정의 중심 = `web/core.js:quadCentroid` (4점 산술평균)   ← **정의가 갈렸다**
   *   → 4점평균이 폴리곤 **안**이고 bbox중심이 **밖**인 quad 를 서버가 드롭 → 점유가 true → **false 로 뒤집혔다**.
   *
   * 수정 후(리더 확정 방침): (B) 항이 **소비처와 동일한 `quadCentroid`(4점 평균)** 를 쓴다
   * (`src/domain/geometry.ts:quadCentroid`, 파리티 `test/quadCentroidParity.test.ts`).
   * → 아래 quad 는 이제 **살아남고**, 점유가 보존된다. 설계서 §7-1 의 "ε 예외"는 **소멸**했다.
   * ((A) 귀속 항은 무변경 — 그건 차량 귀속이지 점유가 아니다.)
   */
  it('★★ D-1 해소: 4점평균 ∈ 폴리곤 · bbox중심 ∉ 폴리곤 인 비아핀 quad → 이제 점유가 **뒤집히지 않는다**', async () => {
    // 검증자가 반례로 봉인했던 **바로 그 스파이크 quad**: 세 점이 폴리곤 안(y=0.31), 한 점이 통로 아래로 길게(y=0.80).
    const spike: NormalizedQuad = [
      { x: 0.40, y: 0.31 },
      { x: 0.44, y: 0.31 },
      { x: 0.42, y: 0.31 },
      { x: 0.42, y: 0.80 },
    ];
    const mean = quadCentroid(spike)!;                    // y = (0.31*3 + 0.80)/4 = 0.4325
    const bc = center(quadBoundingRect(spike));           // y = (0.31 + 0.80)/2   = 0.555

    // 전제는 **그대로 유효**하다 — 두 중심 정의는 여전히 폴리곤 안팎으로 갈리는 quad 다.
    // 달라진 것은 "서버가 어느 정의를 쓰는가" 뿐이다.
    expect(pointInPolygon(BACK_ROW, mean)).toBe(true);                     // 소비처 정의(4점평균) → 폴리곤 안
    expect(pointInPolygon(BACK_ROW, { x: bc.cx, y: bc.cy })).toBe(false);  // 구 서버 정의(bbox중심) → 폴리곤 밖

    const p: PlateBox = { quad: spike, confidence: 0.9, cls: 'car_license_plate' };
    // 귀속(A) 으로 살아남는 경로를 차단(VPD 미검출 프레임) → 오직 (B) 항만이 이 번호판을 살릴 수 있다.
    const { modeA, modeB } = await bothModes([], [p], POLYS);

    // ★ 구 동작이었다면 modeA.plates 는 0 이었다(서버 드롭). 이제 (B)가 소비처 정의를 쓰므로 **생존**한다.
    expect(modeA.plates).toHaveLength(1);
    expect(modeA.summary.lpdFilteredOut).toBe(0);
    expect(modeB.plates).toHaveLength(1);

    const { occA, occB } = occupancyBoth(modeA, modeB, POLYS);
    // ★ 점유가 보존된다 — 구 반례 해소. 모드A/모드B 동일.
    expect(occA).toEqual([{ idx: 1, occupied: true }]);
    expect(occB).toEqual([{ idx: 1, occupied: true }]);
    expect(occA).toEqual(occB);
  });

  /**
   * ★ D-1 해소의 **일반 명제**(반례 1건이 아니라 성질 자체를 봉인한다):
   * 필터가 드롭한 번호판은 **소비처 기준으로도** 폴리곤 밖이다 → 점유를 참으로 만들 수 없다.
   * (B)가 소비처와 같은 중심 정의를 쓰므로 이것은 **정의상 참**이며, ε 예외가 없다.
   */
  it('★ 일반 명제: 무작위 quad 300개 — 드롭된 번호판은 **단 하나도** 소비처 점유를 참으로 만들지 못한다', () => {
    let seed = 4242;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    // 폴리곤 경계 근방(구 ε 위험대)에 집중적으로 quad 를 뿌린다 — 구 구현이면 반드시 반례가 나오는 분포.
    const plates: PlateBox[] = [];
    for (let i = 0; i < 300; i++) {
      const cx = 0.28 + rnd() * 0.32;
      const cy = 0.26 + rnd() * 0.24; // BACK_ROW y 0.30~0.45 의 경계를 걸치도록
      const q: NormalizedQuad = [
        { x: cx + (rnd() - 0.5) * 0.10, y: cy + (rnd() - 0.5) * 0.10 },
        { x: cx + (rnd() - 0.5) * 0.10, y: cy + (rnd() - 0.5) * 0.10 },
        { x: cx + (rnd() - 0.5) * 0.10, y: cy + (rnd() - 0.5) * 0.10 },
        { x: cx + (rnd() - 0.5) * 0.10, y: cy + (rnd() - 0.5) * 0.10 },
      ];
      plates.push({ quad: q, confidence: 0.9, cls: 'car_license_plate' });
    }
    // kept 차량 없음 → (A) 귀속 경로 차단, (B) 항만으로 판정(점유 관련 항을 격리).
    const r = filterPlatesOnPlace(plates, [], POLYS);
    expect(r.filteredOut).toBeGreaterThan(0); // 분포가 실제로 드롭을 만든다(공허참 방지).
    expect(r.kept.length).toBeGreaterThan(0); // 그리고 실제로 살리기도 한다(공허참 방지).

    const keptSet = new Set(r.kept.map((p) => p.quad));
    const dropped = plates.filter((p) => !keptSet.has(p.quad));

    // ★ 핵심 단언: 드롭된 것 중 소비처(computeOccupancy) 기준 폴리곤 안인 번호판은 **0 건**이다.
    const droppedButWouldOccupy = dropped.filter((p) => {
      const occ = computeOccupancy(floorOf(POLYS), [{ quad: p.quad }]);
      return occ.some((o: any) => o.occupied);
    });
    expect(droppedButWouldOccupy).toHaveLength(0);
  });

  /**
   * 두 중심 정의의 **이격 자체는 여전히 존재한다**(수학적 사실 — quadCentroid ≠ bbox중심).
   * 달라진 것은 서버가 더 이상 bbox 중심으로 **점유 관련 판정을 하지 않는다**는 것이다.
   * 이 lemma 는 왜 D-1 이 실데이터(회전 OBB)에서 잠복했는지를 설명한다.
   */
  it('lemma: 회전사각형(아핀 OBB) quad 는 4점평균 == bbox중심 (오차 0) → 실 LPD OBB 에서 D-1 이 잠복한 이유', () => {
    for (let i = 0; i < 24; i++) {
      const th = (i / 24) * Math.PI;
      const [cx, cy, hw, hh] = [0.43, 0.38, 0.03, 0.012];
      const rot = (dx: number, dy: number) => ({
        x: cx + dx * Math.cos(th) - dy * Math.sin(th),
        y: cy + dx * Math.sin(th) + dy * Math.cos(th),
      });
      const q: NormalizedQuad = [rot(-hw, -hh), rot(hw, -hh), rot(hw, hh), rot(-hw, hh)];
      const m = quadCentroid(q)!;
      const b = center(quadBoundingRect(q));
      expect(m.x).toBeCloseTo(b.cx, 12); // 중심대칭 → 두 정의 동일
      expect(m.y).toBeCloseTo(b.cy, 12);
    }
  });

  it('quantify: 원근(키스톤) 왜곡 번호판의 두 정의 간 이격 — 0 이 아니다(= D-1 이 원리적 구멍이었던 이유)', () => {
    // 수정 전에는 이 이격이 곧 "폴리곤 경계 ±이격 안에서 점유가 뒤집히는" 위험 반경이었다.
    // 수정 후에는 (B)가 소비처 정의를 쓰므로 이격이 있어도 **점유는 뒤집히지 않는다**(위 일반 명제).
    // 실측형 키스톤 번호판(가까운 변이 넓고 살짝 기운다). 1080p 기준 이격 픽셀도 함께 본다.
    const keystone: NormalizedQuad = [
      { x: 0.408, y: 0.4405 },
      { x: 0.452, y: 0.4420 },
      { x: 0.456, y: 0.4700 },
      { x: 0.404, y: 0.4660 },
    ];
    const m = quadCentroid(keystone)!;
    const b = center(quadBoundingRect(keystone));
    const dy = Math.abs(m.y - b.cy);
    const dx = Math.abs(m.x - b.cx);
    // 이격은 0 이 아니다(반례가 실재하는 이유) — 그러나 정규화 1e-3 규모(1080p 에서 수 px).
    expect(dy).toBeGreaterThan(0);
    expect(Math.hypot(dx, dy)).toBeLessThan(0.005); // ← 실무 위험 반경(경계 ±0.005 이내에서만 뒤집힘)
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 주장2 «집계 불변» — 반증 시도 (설계서 §2 / 질문6)
// ────────────────────────────────────────────────────────────────────────────

const AGG: AggregateOptions = { clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5 };

function row(kind: 'vehicle' | 'plate', round: number, r: { x: number; y: number; w: number; h: number }, quad?: NormalizedQuad): DetectionRow {
  return { observationId: round, roundIdx: round, camIdx: 1, presetIdx: 1, kind, ...r, conf: 0.9, ...(quad ? { quad } : {}) };
}
/** 번호판 검출행(quad + 그 boundingRect) — CaptureJob.captureTarget 의 적재 형태와 동일. */
function plateRow(round: number, cx: number, cy: number): DetectionRow {
  const q = plateQuad(cx, cy);
  const br = quadBoundingRect(q);
  return row('plate', round, br, q);
}
const ROUNDS = new Map([['1:1', 3]]);

describe('★ 주장2 «집계 불변» — 필터된 plates 를 넣은 aggregate() vs 안 넣은 것 (반증 시도)', () => {
  /** 주차차 차량행 3라운드(대표 rect = PARKED). */
  const vehRows = [1, 2, 3].map((r) => row('vehicle', r, PARKED.rect));

  it('A1 상류가 버리는 번호판이 kept 차량 rect **밖** → aggregate() 산출 완전 동일(손실 0)', () => {
    // 통행차 번호판(폴리곤 밖 · PARKED rect 밖) — 상류 모드A 가 드롭한다.
    const parkedPlates = [1, 2, 3].map((r) => plateRow(r, 0.43, 0.38)); // 주차차 번호판(rect 안)
    const strayPlates = [1, 2, 3].map((r) => plateRow(r, 0.42, 0.72)); // 통로 번호판

    // 전제: 상류 필터가 실제로 stray 만 버린다.
    const kept = filterPlatesOnPlace(
      [plate(0.43, 0.38), plate(0.42, 0.72)],
      [{ rect: PARKED.rect, confidence: 0.8 }],
      POLYS,
    );
    expect(kept.filteredOut).toBe(1);

    const withStray = aggregate([...vehRows, ...parkedPlates, ...strayPlates], ROUNDS, AGG);
    const filtered = aggregate([...vehRows, ...parkedPlates], ROUNDS, AGG);
    expect(filtered).toEqual(withStray); // ← 설계서 §2 주장대로 손실 0 · 산출 불변
  });

  /**
   * ★★ 반례 후보 (COUNTEREXAMPLE) — 설계서 §2 의 "상류가 버리는 것 = 하류도 버렸을 것" 은
   * **granularity 가 다르다**:
   *   상류 matchPlatesToSlots : **검출 1건 단위** 경쟁 → 진 번호판은 **드롭**된다.
   *   하류 Aggregator         : **클러스터 대표 단위** 매칭 → 진 번호판은 드롭되지 않고
   *                              승자와 **같은 클러스터에 병합**되어 robustRect/robustPlatePose 의
   *                              **중앙값을 이동시킨다**.
   * → 한 kept 차량 rect 안에 번호판 2개가 있고 서로 clusterDist 안이면,
   *   상류에서 진 쪽을 지우는 순간 **하류 대표 좌표(plateX/Y/W/H/plateQuad)가 달라진다**.
   */
  it('★★ 반례 시도: 같은 kept 차량 안 번호판 2개(clusterDist 내) → 상류 드롭이 aggregate() 대표를 이동시키는가', () => {
    // 진짜 번호판(차량 rect 안 · 폴리곤 안) + 근접 오검출(차량 rect 안 · 폴리곤 **밖**(y<0.30) · (A) 경쟁 탈락).
    // 두 중심거리 0.045 < clusterDist(0.06) → 하류에서 **같은 plate 클러스터로 병합**된다.
    const TRUE_C = { cx: 0.43, cy: 0.335 }; // BACK_ROW(y 0.30~0.45) 안 · PARKED rect(y 0.18~0.44) 안
    const NOISE_C = { cx: 0.43, cy: 0.29 }; // BACK_ROW 밖(위) · PARKED rect 안 → (B) 로도 못 산다

    const truePlate = plate(TRUE_C.cx, TRUE_C.cy);
    const noisePlate = plate(NOISE_C.cx, NOISE_C.cy);

    // 상류 필터 결과(전제): 둘 다 kept 차량 안이지만 (A)는 차량당 1개 → 겹침 큰 쪽만.
    const r = filterPlatesOnPlace([truePlate, noisePlate], [{ rect: PARKED.rect, confidence: 0.8 }], POLYS);
    const keptQuads = new Set(r.kept.map((p) => p.quad));

    // 모드B(미필터): 두 번호판이 3라운드 내내 적재된다.
    const allRows = [
      ...vehRows,
      ...[1, 2, 3].map((rd) => plateRow(rd, TRUE_C.cx, TRUE_C.cy)),
      ...[1, 2, 3].map((rd) => plateRow(rd, NOISE_C.cx, NOISE_C.cy)),
    ];
    // 모드A(상류 필터 후): kept 번호판만 DB 에 적재된다(CaptureJob.captureTarget 경로).
    const keptCenters = r.kept.map((p) => center(quadBoundingRect(p.quad)));
    const filteredRows = [
      ...vehRows,
      ...[1, 2, 3].flatMap((rd) => keptCenters.map((c) => plateRow(rd, c.cx, c.cy))),
    ];
    void keptQuads;

    const before = aggregate(allRows, ROUNDS, AGG); // 모드B(미필터)
    const after = aggregate(filteredRows, ROUNDS, AGG); // 모드A(필터)

    // 전제: 상류가 2건 중 1건(진짜 번호판)만 남겼다.
    expect(r.kept).toHaveLength(1);
    expect(r.filteredOut).toBe(1);
    expect(center(quadBoundingRect(r.kept[0].quad)).cy).toBeCloseTo(TRUE_C.cy, 10);

    // 슬롯 자체는 양쪽 모두 1개 — **손실은 없다**(설계서 §2 의 "손실 0" 은 참).
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
    const b = before[0];
    const a = after[0];

    // 차량 대표·지지·점유율은 **완전 동일**(번호판 필터가 차량 집계에 영향 없음).
    expect([a.x, a.y, a.w, a.h, a.support, a.occupancyRate, a.status]).toEqual([b.x, b.y, b.w, b.h, b.support, b.occupancyRate, b.status]);

    // ★★ 그러나 **번호판 대표 좌표는 달라진다** — 설계서 §2 의 «산출 불변» 은 거짓이다.
    //   상류(matchPlatesToSlots)는 검출 1건 단위로 진 번호판을 **드롭**하지만,
    //   하류(Aggregator)는 그 번호판을 승자와 **같은 클러스터에 병합**해 robust median 을 끌어당긴다.
    //   → 상류에서 지우면 하류 대표가 **이동**한다(같은 것을 버리지 않는다).
    expect(a.plateY).not.toBeCloseTo(b.plateY!, 6);
    expect(b.plateY!).toBeCloseTo(0.3005, 6); // 모드B: 오검출에 오염된 중앙값
    expect(a.plateY!).toBeCloseTo(0.323, 6); // 모드A: 진짜 번호판만(= TRUE_C.cy − h/2 = 0.335 − 0.012)

    // 이동 방향은 **개선**이다(모드A 값이 진짜 번호판의 실좌표와 일치) — 손실이 아니라 잡음 제거.
    const truthY = quadBoundingRect(truePlate.quad).y;
    expect(a.plateY!).toBeCloseTo(truthY, 10); // 모드A = 정답
    expect(Math.abs(b.plateY! - truthY)).toBeGreaterThan(0.02); // 모드B = 정답에서 0.02+(1080p 기준 20px+) 이탈

    void noisePlate;
  });
});
