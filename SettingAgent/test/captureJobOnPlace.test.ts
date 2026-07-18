import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CaptureJob, type CaptureJobDeps } from '../src/capture/CaptureJob.js';
import { normalizePtzCamRoi } from '../src/capture/placeRoi.js';
import { polygonCentroid, pointInPolygon } from '../src/domain/polygon.js';
import { isVehicleOnPlace } from '../src/capture/onPlaceFilter.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { LpdClient } from '../src/clients/LpdClient.js';
import type { CapturedImage, VehicleBox, NormalizedPoint, NormalizedQuad } from '../src/domain/types.js';
import type { PlateBox } from '../src/clients/LpdClient.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { SetupTarget } from '../src/setup/SetupOrchestrator.js';

/**
 * 검증자(qa-tester): CaptureJob ↔ 주차면 필터(모드A) 배선 — 01_architect_plan.md §6 항목 8~11.
 *
 * ⚠️ 픽스처 규약(HANDOFF §2-2): **동결 픽스처 `test/fixtures/PtzCamRoi.unity.json`** 만 쓴다.
 *    런타임 `data/Place01/PtzCamRoi.json` 은 사용자가 뷰어에서 편집하면 바뀌므로 테스트 입력으로 절대 쓰지 않는다.
 * 좌표는 픽스처에서 **파생**한다(하드코딩 금지 → 픽스처가 바뀌면 테스트도 함께 따라간다).
 */

const FIXTURE = 'test/fixtures/PtzCamRoi.unity.json';
const CAM = 1;
const PRESET = 1;

/** 동결 픽스처의 cam1:preset1 주차면 폴리곤(정규화). */
const POLYS: NormalizedPoint[][] = (() => {
  const place = normalizePtzCamRoi(JSON.parse(readFileSync(FIXTURE, 'utf8')));
  const spaces = place.byPreset.get(`${CAM}:${PRESET}`);
  if (!spaces?.length) throw new Error('픽스처에 cam1:preset1 주차면이 없다 — 테스트 전제 붕괴');
  return spaces.map((s) => s.points);
})();

/**
 * 주차차: 접지 밴드를 주차면 폴리곤 무게중심에 얹는다(밴드 = bbox 하단 25%).
 * rect.y = cy − h·0.875 → 밴드 중심 y = cy.
 */
function parkedOn(poly: NormalizedPoint[], w = 0.06, h = 0.24): VehicleBox {
  const c = polygonCentroid(poly);
  return { rect: { x: c.x - w / 2, y: c.y - h * 0.875, w, h }, confidence: 0.9, cls: 'car' };
}

/** 통행차: 접지 밴드가 어떤 주차면과도 겹치지 않는 이미지 하단(통로). */
const PASSING: VehicleBox = { rect: { x: 0.40, y: 0.80, w: 0.10, h: 0.18 }, confidence: 0.9, cls: 'car' };
const PARKED: VehicleBox = parkedOn(POLYS[0]);

const captureCfg: ToolsConfig['capture'] = {
  defaultCount: 50, intervalMs: 1000, moveIntervalMs: 0, checkpointEvery: 10,
  checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, dbFile: ':memory:',
  clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5, slotAssignGate: 0.12, moveBeforeCapture: false,
};

const targets: SetupTarget[] = [{ camIdx: CAM, presetIdx: PRESET }];

const fakeCamera = (): CameraClient => ({
  requestImage: async (camIdx: number, presetIdx: number): Promise<CapturedImage> => ({
    camIdx, presetIdx, pan: 1, tilt: 2, zoom: 3, imgName: 'i', jpg: Buffer.from('img'),
  }),
} as unknown as CameraClient);

const fakeVpd = (boxes: VehicleBox[]): VpdClient => ({ detect: async () => boxes } as unknown as VpdClient);

const quad = (cx: number, cy: number): NormalizedQuad => [
  { x: cx - 0.01, y: cy - 0.005 }, { x: cx + 0.01, y: cy - 0.005 },
  { x: cx + 0.01, y: cy + 0.005 }, { x: cx - 0.01, y: cy + 0.005 },
];
const fakeLpd = (plates: PlateBox[]): LpdClient => ({ detect: async () => plates } as unknown as LpdClient);

/** 수동 발화 타이머(captureJob.test.ts 패턴 재사용). */
function makeManualTimers() {
  const queue: Array<{ fn: () => void; ms: number }> = [];
  const setTimer = (fn: () => void, ms: number): NodeJS.Timeout => {
    const h = { fn, ms };
    queue.push(h);
    return h as unknown as NodeJS.Timeout;
  };
  const clearTimer = (h: NodeJS.Timeout): void => {
    const i = queue.indexOf(h as unknown as { fn: () => void; ms: number });
    if (i >= 0) queue.splice(i, 1);
  };
  const fireNext = (): boolean => {
    const h = queue.shift();
    if (!h) return false;
    h.fn(); // runRound 는 async — 완료는 waitDone() 으로 기다린다(아래).
    return true;
  };
  return { setTimer, clearTimer, fireNext };
}

/**
 * 라운드 완료까지 대기. **microtask flush 로는 부족하다** — 모드A 는 `loadNormalizedPlaceRoi` 로
 * 실제 파일 I/O(macrotask)를 하므로 `await Promise.resolve()` 루프는 적재 전에 반환한다.
 * (이 함정 때문에 파일을 읽는 케이스만 검출 0건으로 오탐했다.) 실 타이머로 종료 상태를 폴링한다.
 */
async function waitDone(job: CaptureJob, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = job.getStatus().state;
    if (s === 'done' || s === 'stopped' || s === 'error') return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`라운드가 ${timeoutMs}ms 내 종료되지 않음(state=${job.getStatus().state})`);
}

/** 1라운드 수집 실행 → 적재된 검출 행 반환. */
async function runOneRound(over: Partial<CaptureJobDeps>, vpdOnParkingOnly?: boolean) {
  const timers = makeManualTimers();
  const deps: CaptureJobDeps = {
    camera: fakeCamera(),
    vpd: fakeVpd([PARKED, PASSING]),
    cfg: captureCfg,
    lpdEnabled: false,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    sleep: async () => {},
    now: () => 'T',
    ...over,
  };
  const job = new CaptureJob(deps);
  job.start({
    count: 1, intervalMs: 1000, checkpointEvery: 99, checkpointTriggerMode: 'rounds',
    checkpointIntervalMs: 60000, targets,
    ...(vpdOnParkingOnly !== undefined ? { vpdOnParkingOnly } : {}),
  });
  timers.fireNext();
  await waitDone(job);
  const dets = job.getSnapshot().dets;
  return { job, dets, vehicles: dets.filter((d) => d.kind === 'vehicle'), plates: dets.filter((d) => d.kind === 'plate') };
}

describe('전제 확인 — 픽스처 파생 좌표가 의도한 성질을 갖는다', () => {
  it('PARKED 는 주차면 위, PASSING 은 어떤 주차면과도 겹치지 않는다', () => {
    expect(isVehicleOnPlace(PARKED.rect, POLYS)).toBe(true);
    expect(isVehicleOnPlace(PASSING.rect, POLYS)).toBe(false);
  });
});

describe('CaptureJob §6-8 — 모드A(기본): 주차면 위 차량만 적재', () => {
  it('placeRoiFile(동결 픽스처) + VPD[주차차, 통행차] → vehicle 검출 **1건**만 DB 적재', async () => {
    const { job, vehicles } = await runOneRound({ placeRoiFile: FIXTURE });
    expect(vehicles).toHaveLength(1);
    expect(vehicles[0].x).toBeCloseTo(PARKED.rect.x, 9); // 남은 것은 주차차.
    const st = job.getStatus();
    expect(st.vpdOnParkingOnly).toBe(true); // 기본값 = 모드A.
    expect(st.vpdFilteredOut).toBe(1); // 통행차 1대 제외(관측 가능).
    expect(st.vpdOnPlaceDegraded).toBeUndefined(); // 강등 아님.
  });
});

describe('CaptureJob §6-9 — 모드B(vpdOnParkingOnly:false): 모든 차량(회귀 0)', () => {
  it('명시적 false → vehicle 검출 **2건** 전량 적재, 필터 카운터 미노출', async () => {
    const { job, vehicles } = await runOneRound({ placeRoiFile: FIXTURE }, false);
    expect(vehicles).toHaveLength(2);
    const st = job.getStatus();
    expect(st.vpdOnParkingOnly).toBe(false);
    expect(st.vpdFilteredOut).toBeUndefined(); // 제외 0 → 노출 안 함.
    expect(st.vpdOnPlaceDegraded).toBeUndefined(); // 모드B 는 강등이 아니다(사용자 선택).
  });
});

describe('★ CaptureJob §6-10 — 강등(placeRoiFile 미주입): 전량 통과 + 사유 노출(드롭 금지)', () => {
  it('placeRoiFile 없음 + 모드A 요청 → **2건 전량** 적재 + vpdOnPlaceDegraded 존재 + vpdFilteredOut 미노출', async () => {
    const { job, vehicles } = await runOneRound({}); // placeRoiFile 미주입
    expect(vehicles).toHaveLength(2); // 기준 부재로 데이터를 조용히 지우지 않는다.
    const st = job.getStatus();
    expect(st.vpdOnParkingOnly).toBe(true); // 요청된 모드는 A 그대로 보고(사용자 의도 보존).
    expect(st.vpdOnPlaceDegraded).toBe('주차면 파일 없음/로드 실패');
    expect(st.vpdFilteredOut).toBeUndefined(); // 강등 중엔 제외 0.
  });

  it('존재하지 않는 경로 → 동일 강등(파싱 실패 흡수, throw 없음)', async () => {
    const { job, vehicles } = await runOneRound({ placeRoiFile: '/no/such/PtzCamRoi.json' });
    expect(vehicles).toHaveLength(2);
    expect(job.getStatus().vpdOnPlaceDegraded).toBe('주차면 파일 없음/로드 실패');
  });

  it('파일은 있으나 **해당 프리셋** 주차면 0개 → 그 프리셋만 강등(사유가 프리셋을 지목)', async () => {
    // 픽스처에 preset 9 는 없다 → byPreset 키 부재 = "이 프리셋엔 ROI 없음"(파일 부재와 구별).
    const timers = makeManualTimers();
    const job = new CaptureJob({
      camera: fakeCamera(), vpd: fakeVpd([PARKED, PASSING]), cfg: captureCfg, lpdEnabled: false,
      setTimer: timers.setTimer, clearTimer: timers.clearTimer, sleep: async () => {}, now: () => 'T',
      placeRoiFile: FIXTURE,
    });
    job.start({
      count: 1, intervalMs: 1000, checkpointEvery: 99, checkpointTriggerMode: 'rounds',
      checkpointIntervalMs: 60000, targets: [{ camIdx: CAM, presetIdx: 9 }],
    });
    timers.fireNext();
    await waitDone(job);
    const vehicles = job.getSnapshot().dets.filter((d) => d.kind === 'vehicle');
    expect(vehicles).toHaveLength(2); // 전량 통과(강등).
    expect(job.getStatus().vpdOnPlaceDegraded).toBe(`프리셋 ${CAM}:9 주차면 0개`); // 파일 부재와 **다른** 사유.
  });
});

/**
 * §6-11′ — **LPD(번호판)도 주차면 위 차량 것만** (06_architect_plan_lpd.md 로 1차 §2 결정 번복).
 * 이전 판(§6-11)은 "plate 건수 불변(2건)"을 단언했다. 그 단언은 이제 **틀렸다** — 마스터 요구가 바뀌었다.
 * 규칙: keepPlate = (유지된 차량에 귀속) OR (번호판 중심 ∈ 주차면 폴리곤).
 */
describe("CaptureJob §6-11′ — LPD 도 주차면 위 차량 것만 적재", () => {
  /** 주차차 번호판(PARKED rect 하단 = 귀속 항으로 유지). */
  const PARKED_PLATE: PlateBox = {
    quad: quad(PARKED.rect.x + PARKED.rect.w / 2, PARKED.rect.y + PARKED.rect.h),
    confidence: 0.9,
    cls: 'car_license_plate',
  };
  /** 통행차 번호판(통로 바닥) — kept 차량 밖 + 어떤 주차면 폴리곤 밖. */
  const PASSING_PLATE: PlateBox = { quad: quad(0.45, 0.97), confidence: 0.9, cls: 'car_license_plate' };
  const plates = [PARKED_PLATE, PASSING_PLATE];

  it('전제: 통행차 번호판 중심은 **어떤 주차면 폴리곤에도** 들어가지 않는다(픽스처 검증)', () => {
    expect(POLYS.some((p) => pointInPolygon(p, { x: 0.45, y: 0.97 }))).toBe(false);
  });

  it('C1 모드A → plate **1건**(주차차 것)만 적재 + status.lpdFilteredOut=1 / 모드B → 2건 전량, 미노출', async () => {
    const modeA = await runOneRound({ placeRoiFile: FIXTURE, lpdEnabled: true, lpd: fakeLpd(plates) });
    const modeB = await runOneRound({ placeRoiFile: FIXTURE, lpdEnabled: true, lpd: fakeLpd(plates) }, false);

    expect(modeA.plates).toHaveLength(1); // 통행차 번호판 제외(마스터 증상 해소).
    expect(modeA.job.getStatus().lpdFilteredOut).toBe(1);
    expect(modeA.vehicles).toHaveLength(1);

    expect(modeB.plates).toHaveLength(2); // 모드B 회귀 0.
    expect(modeB.job.getStatus().lpdFilteredOut).toBeUndefined(); // 제외 0 → 키 없음.
    expect(modeB.vehicles).toHaveLength(2);
  });

  it('★ C2 (점유 뒤집힘 방지) — VPD 가 주차차를 놓쳐도(vehicle 0건) 폴리곤 안 번호판은 적재된다', async () => {
    // (B) 항이 DB 경로에서도 작동함을 봉인. 없으면 computeOccupancy 가 그 면을 occupied:false 로 뒤집는다.
    const c = polygonCentroid(POLYS[0]);
    const onPlacePlate: PlateBox = { quad: quad(c.x, c.y), confidence: 0.9, cls: 'car_license_plate' };
    const r = await runOneRound({
      placeRoiFile: FIXTURE,
      vpd: fakeVpd([]), // VPD 미검출.
      lpdEnabled: true,
      lpd: fakeLpd([onPlacePlate]),
    });
    expect(r.vehicles).toHaveLength(0);
    expect(r.plates).toHaveLength(1); // 귀속될 차량이 없어도 (B) 로 살아남는다.
    expect(r.job.getStatus().lpdFilteredOut).toBeUndefined(); // 제외 0.
  });

  it('C3 (강등) — placeRoiFile 미주입 → plate **2건 전량** + lpdFilteredOut 미노출 + vpdOnPlaceDegraded 존재', async () => {
    const r = await runOneRound({ lpdEnabled: true, lpd: fakeLpd(plates) }); // placeRoiFile 없음.
    expect(r.plates).toHaveLength(2); // 기준 부재로 데이터를 조용히 지우지 않는다.
    const st = r.job.getStatus();
    expect(st.lpdFilteredOut).toBeUndefined();
    expect(st.vpdOnPlaceDegraded).toBe('주차면 파일 없음/로드 실패'); // 강등 사유는 차량 필터와 공유(1개).
  });

  /**
   * ★ C4 (경계면 — 배지 falsy 가드의 존재 이유). 구현자가 `web/app.js` 배지 가드를
   * `vpdFilteredOut ? …` → `vpdFilteredOut || lpdFilteredOut ? …` 로 확장했다(07 §3).
   * 그 확장이 **필요한 상태가 실제로 도달 가능한지**를 서버 끝단에서 봉인한다:
   *   VPD 는 주차차만 검출(→ 제외 0건 → `vpdFilteredOut` **미노출**) + LPD 는 통로 번호판까지 검출(→ 제외 1건).
   * 이 상태에서 구 가드였다면 `undefined ? …` = falsy → 괄호가 통째로 사라져
   * `lpdFilteredOut` 이 **관측 불가**해진다(조용한 정보 손실).
   */
  it('★ C4 (배지 가드) — vpdFilteredOut 미노출 + lpdFilteredOut>0 상태가 도달 가능하다', async () => {
    const r = await runOneRound({
      placeRoiFile: FIXTURE,
      vpd: fakeVpd([PARKED]), // 주차차만 → 차량 제외 0건.
      lpdEnabled: true,
      lpd: fakeLpd(plates), // 주차차 번호판 + 통로 번호판 → 번호판 제외 1건.
    });
    const st = r.job.getStatus();
    expect(r.vehicles).toHaveLength(1);
    expect(r.plates).toHaveLength(1); // 통로 번호판 제외.
    expect(st.vpdFilteredOut).toBeUndefined(); // ← 구 가드가 falsy 로 읽던 값.
    expect(st.lpdFilteredOut).toBe(1); // ← 그런데 이 값은 드러나야 한다.

    // 가드 의미론: 구 가드는 숨기고, 신 가드(OR)는 드러낸다.
    expect(Boolean(st.vpdFilteredOut)).toBe(false); // 구 가드 → 괄호 생략(정보 손실)
    expect(Boolean(st.vpdFilteredOut || st.lpdFilteredOut)).toBe(true); // 신 가드 → 표시(정상)
  });
});
