import { describe, it, expect, vi } from 'vitest';
import { logger } from '../src/util/logger.js';
import { PtzCalibrator, type PtzCalibratorDeps } from '../src/calibrate/PtzCalibrator.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { expandPlateTargets } from '../src/calibrate/slotPtzWriter.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { LpdClient, PlateBox } from '../src/clients/LpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { SetupArtifact } from '../src/domain/types.js';
import { rectToQuad, quadBoundingRect } from '../src/domain/geometry.js';
import type { SlotPtzArtifact, Ptz } from '../src/calibrate/types.js';
import type { PlatePtzOpts, PlatePtzResult } from '../src/calibrate/platePtz.js';

/**
 * 검증자(qa-tester): 센터라이징(PtzCalibrator→PlatePtz 위임 + centering_slot 이중 저장).
 * 설계서 `_workspace/centering/01_architect_plan.md` §9 테스트 명세 T1~T13.
 *
 * 기존 `ptzCalibrator.test.ts`(수렴·순서·미검출·다수판·중복시작)는 회귀 스위트로 별도 유지 —
 * 이 파일은 **이번 변경분 고유 계약**(체이닝·prior 갱신·시작PTZ·reason 매핑·DB 미러)만 다룬다.
 */

const cfg: ToolsConfig['calibrate'] = {
  targetPlateWidth: 0.2, centerTol: 0.03, widthTol: 0.02, maxIterations: 30,
  probeStepDeg: 1.0, maxStepDeg: 5.0, fallbackGainPanDeg: -62, fallbackGainTiltDeg: -35.5,
  settleMs: 0, outFile: 'data/slot_ptz.json',
};

/** plateRoiByPreset 1슬롯 fixture(prior 0.62/0.62 — T1 의 "센터링 前 prior" 대조군). */
function artifact(): SetupArtifact {
  return {
    createdAt: 'T', presets: [],
    globalIndex: [{ globalIdx: 7, slotId: 'c1p1s1', camIdx: 1, presetIdx: 1 }],
    slots: [{
      slotId: 'c1p1s1', zone: 'z',
      roiByPreset: { '1:1': { x: 0.6, y: 0.6, w: 0.1, h: 0.05 } },
      plateRoiByPreset: { '1:1': rectToQuad({ x: 0.62, y: 0.62, w: 0.05, h: 0.03 }) },
    }],
  };
}

/** 2슬롯 fixture(T10 부분 캘리브레이션용). */
function artifact2(): SetupArtifact {
  return {
    createdAt: 'T',
    presets: [{ camIdx: 1, presetIdx: 1, label: 'p1', coveredSlotIds: ['c1p1s1', 'c1p1s2'] }],
    globalIndex: [
      { globalIdx: 1, slotId: 'c1p1s1', camIdx: 1, presetIdx: 1 },
      { globalIdx: 2, slotId: 'c1p1s2', camIdx: 1, presetIdx: 1 },
    ],
    slots: [
      { slotId: 'c1p1s1', zone: 'z', roiByPreset: { '1:1': { x: 0.6, y: 0.6, w: 0.1, h: 0.05 } }, plateRoiByPreset: { '1:1': rectToQuad({ x: 0.62, y: 0.62, w: 0.05, h: 0.03 }) } },
      { slotId: 'c1p1s2', zone: 'z', roiByPreset: { '1:1': { x: 0.6, y: 0.6, w: 0.1, h: 0.05 } }, plateRoiByPreset: { '1:1': rectToQuad({ x: 0.62, y: 0.62, w: 0.05, h: 0.03 }) } },
    ],
  };
}

function repoWith(a: SetupArtifact | null): Repository {
  return { loadArtifact: () => a } as unknown as Repository;
}

/** ptzCalibrator.test.ts 와 동일한 모킹 물리(명령 PTZ → 번호판 위치/폭). */
function makeMockModel() {
  const moves: Ptz[] = [];
  const camera = {
    clampZoom: (z: number) => Math.min(36, Math.max(1, z)),
    requestImage: async (_c: number, _p: number, ptz?: Partial<Ptz>) => {
      const pan = ptz?.pan ?? 0, tilt = ptz?.tilt ?? 0, zoom = ptz?.zoom ?? 1;
      moves.push({ pan, tilt, zoom });
      return { camIdx: 1, presetIdx: 1, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('img') };
    },
  } as unknown as CameraClient;
  const lpd = {
    detect: async (): Promise<PlateBox[]> => {
      const last = moves[moves.length - 1];
      const cx = 0.7 - last.pan * 0.02;
      const cy = 0.8 - last.tilt * 0.02;
      const w = Math.min(0.9, 0.05 * last.zoom);
      return [{ quad: rectToQuad({ x: cx - w / 2, y: cy - 0.015, w, h: 0.03 }), confidence: 0.9, cls: 'plate' }];
    },
  } as unknown as LpdClient;
  return { camera, lpd, moves };
}

function makeCalibrator(over: Partial<PtzCalibratorDeps> = {}, a: SetupArtifact | null = artifact()) {
  const m = makeMockModel();
  let saved: SlotPtzArtifact | undefined;
  let nowCount = 0;
  const deps: PtzCalibratorDeps = {
    camera: m.camera, lpd: m.lpd, repo: repoWith(a), cfg,
    writer: (art) => { saved = art; },
    sleep: async () => {},
    now: () => `T${nowCount++}`,
    ...over,
  };
  return { cal: new PtzCalibrator(deps), getSaved: () => saved, moves: m.moves };
}

async function waitDone(cal: PtzCalibrator): Promise<void> {
  for (let i = 0; i < 20000 && cal.getStatus().state === 'running'; i++) await Promise.resolve();
}

/** PlatePtz 팩토리 시임: 생성 opts 와 zoom 호출 인자를 캡처한다. */
function stubFactory(center: PlatePtzResult, zoom?: PlatePtzResult) {
  const opts: PlatePtzOpts[] = [];
  const zoomCalls: Array<{ camIdx: number; presetIdx: number; startPtz: Ptz }> = [];
  const make = (o: PlatePtzOpts) => {
    opts.push(o);
    return {
      centerOnPlate: async (): Promise<PlatePtzResult> => center,
      zoomToPlateWidth: async (c: number, p: number, s: Ptz): Promise<PlatePtzResult> => {
        zoomCalls.push({ camIdx: c, presetIdx: p, startPtz: s });
        return zoom ?? center;
      },
    };
  };
  return { make, opts, zoomCalls };
}

const GAIN = { gainPan: -37.7, gainTilt: -21.4, zoomRef: 1.69341 };
const CENTER_PTZ: Ptz = { pan: 20.5, tilt: 5.5, zoom: 1.69341 };
/** 센터링 後 관측 위치(≈0.47/0.48) — 센터링 前 prior 0.62/0.62 와 명확히 구분되는 값. */
const CENTERED_PLATE = { quad: rectToQuad({ x: 0.47, y: 0.48, w: 0.06, h: 0.03 }), confidence: 0.9, cls: 'plate' as const };

const okCenter: PlatePtzResult = {
  ok: true, ptz: CENTER_PTZ, plate: CENTERED_PLATE, err: { errX: 0.0, errY: 0.0 },
  plateWidth: 0.06, gain: GAIN, iterations: 3,
};
const okZoom: PlatePtzResult = {
  ok: true, ptz: { pan: 20.5, tilt: 5.5, zoom: 6.2 }, plate: CENTERED_PLATE, err: { errX: 0.01, errY: 0.01 },
  plateWidth: 0.2, gain: GAIN, iterations: 4,
};

// ── T1: gain 체이닝 + zoom prior 갱신 (이 작업의 핵심 계약) ──
describe('T1 gain 체이닝 · zoom 단계 prior 갱신', () => {
  it('zoom 인스턴스 opts.gain === center 결과 gain(동일 참조), startPtz === c.ptz, plateRoi = center 결과 boundingRect', async () => {
    const f = stubFactory(okCenter, okZoom);
    const { cal } = makeCalibrator({ makePlatePtz: f.make });
    cal.start();
    await waitDone(cal);

    expect(f.opts).toHaveLength(2);
    // 1번째(center) 인스턴스: prior = 타깃의 plateRoi(센터링 前 0.62/0.62)
    // (quad 왕복 부동소수 오차가 있어 값 근사 비교 — 요점은 "센터링 前 위치"라는 것)
    expect(f.opts[0].plateRoi!.x).toBeCloseTo(0.62, 6);
    expect(f.opts[0].plateRoi!.y).toBeCloseTo(0.62, 6);
    expect(f.opts[0].gain).toBeUndefined(); // center 는 probe 로 자가 측정 — gain 주입 없음

    // ★ 2번째(zoom) 인스턴스: 실측 게인 체이닝(동일 참조)
    expect(f.opts[1].gain).toBe(okCenter.gain);
    // ★ 설계서 §7 함정: prior 는 center 결과 boundingRect(0.47/0.48) — t.plateRoi(0.62/0.62) 아님
    expect(f.opts[1].plateRoi).toEqual(quadBoundingRect(CENTERED_PLATE.quad));
    expect(f.opts[1].plateRoi!.x).toBeCloseTo(0.47, 3);
    expect(f.opts[1].plateRoi!.y).toBeCloseTo(0.48, 3);
    // 두 prior 가 실제로 다른 위치여야 함(갱신되지 않으면 이 단언이 깨진다)
    expect(f.opts[1].plateRoi!.x).not.toBeCloseTo(f.opts[0].plateRoi!.x, 3);

    // zoom 시작 PTZ = center 결과 ptz(동일 참조 — 명령 PTZ 연속성)
    expect(f.zoomCalls).toHaveLength(1);
    expect(f.zoomCalls[0].startPtz).toBe(okCenter.ptz);
    expect(f.zoomCalls[0].camIdx).toBe(1);
    expect(f.zoomCalls[0].presetIdx).toBe(1);
  });
});

// ── T2: 위임 후 수렴 회귀(실 PlatePtz) ──
describe('T2 위임 후 수렴 회귀', () => {
  it('기존 모킹 물리로 centered·converged true, plateWidth≈0.2, globalIdx=7', async () => {
    const { cal, getSaved } = makeCalibrator();
    cal.start();
    await waitDone(cal);
    expect(cal.getStatus().state).toBe('done');
    const it0 = getSaved()!.items[0];
    expect(it0.centered).toBe(true);
    expect(it0.converged).toBe(true);
    expect(it0.plateWidth).toBeCloseTo(0.2, 1);
    expect(it0.globalIdx).toBe(7);
    expect(it0.reason).toBeUndefined();
  });
});

// ── T3/T4: 시작 PTZ 정본(resolvePresetPtz) · 폴백 ──
describe('T3 시작 PTZ = 프리셋 정본(resolvePresetPtz)', () => {
  it('listCameras 보유 → 첫 캡처 명령이 프리셋 PTZ', async () => {
    const m = makeMockModel();
    const camera = {
      ...m.camera,
      clampZoom: (z: number) => Math.min(36, Math.max(1, z)),
      listCameras: async () => ({ cameras: [{ camIdx: 1, presets: [{ presetIdx: 1, pan: 22, tilt: 6.8, zoom: 1.69341 }] }] }),
      requestImage: m.camera.requestImage.bind(m.camera),
    } as unknown as CameraClient;
    const { cal, moves } = makeCalibrator({ camera, lpd: m.lpd });
    // moves 는 m.moves 를 공유해야 하므로 직접 참조
    cal.start();
    await waitDone(cal);
    expect(m.moves[0]).toEqual({ pan: 22, tilt: 6.8, zoom: 1.69341 });
    void moves;
  });
});

describe('T4 시작 PTZ 폴백', () => {
  it('listCameras 부재 → 0/0/1 시작 + 잡 정상 완료', async () => {
    const { cal, moves } = makeCalibrator();
    cal.start();
    await waitDone(cal);
    expect(moves[0]).toEqual({ pan: 0, tilt: 0, zoom: 1 });
    expect(cal.getStatus().state).toBe('done');
  });

  it('폴백은 warn 을 남긴다(조용한 강등 금지 — 설계서 §2)', async () => {
    const spy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    try {
      const { cal } = makeCalibrator();
      cal.start();
      await waitDone(cal);
      const warned = spy.mock.calls.some(([, msg]) => typeof msg === 'string' && msg.includes('프리셋 PTZ 미해결'));
      expect(warned).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

// ── T5: reason 매핑 4종(실 PlatePtz 시나리오 구동) ──
describe('T5 reason 매핑 4종', () => {
  it('no_plate — 시작부터 미검출', async () => {
    const lpd = { detect: async () => [] } as unknown as LpdClient;
    const { cal, getSaved } = makeCalibrator({ lpd });
    cal.start();
    await waitDone(cal);
    const it0 = getSaved()!.items[0];
    expect(it0.reason).toBe('no_plate');
    expect(it0.centered).toBe(false);
    expect(it0.converged).toBe(false);
  });

  it('plate_lost — 초기 검출 후 소실', async () => {
    const m = makeMockModel();
    let n = 0;
    const lpd = {
      detect: async (jpg: Buffer): Promise<PlateBox[]> => (n++ === 0 ? m.lpd.detect(jpg) : []),
    } as unknown as LpdClient;
    const { cal, getSaved } = makeCalibrator({ camera: m.camera, lpd });
    cal.start();
    await waitDone(cal);
    const it0 = getSaved()!.items[0];
    expect(it0.reason).toBe('plate_lost');
    expect(it0.centered).toBe(false);
    expect(it0.converged).toBe(false);
  });

  it('zoom_saturated — 중심은 맞았으나 zoom 상한에서 폭 미달', async () => {
    // 항상 화면 중앙·극소폭 → center 즉시 성공(iterations 0), zoom 은 clamp 상한(=1)이라 상승 불가.
    const camera = {
      clampZoom: () => 1,
      requestImage: async () => ({ camIdx: 1, presetIdx: 1, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('i') }),
    } as unknown as CameraClient;
    const lpd = {
      detect: async (): Promise<PlateBox[]> => [{ quad: rectToQuad({ x: 0.498, y: 0.4985, w: 0.004, h: 0.003 }), confidence: 0.9, cls: 'plate' }],
    } as unknown as LpdClient;
    const { cal, getSaved } = makeCalibrator({ camera, lpd });
    cal.start();
    await waitDone(cal);
    const it0 = getSaved()!.items[0];
    expect(it0.reason).toBe('zoom_saturated');
    expect(it0.centered).toBe(true);   // §5-4: centered = c.ok
    expect(it0.converged).toBe(false); // zoom 실패
  });

  it('max_iterations — center 가 상한 소진(보정 무반응)', async () => {
    // 명령에 무반응하고 항상 같은 위치를 반환하면 예측 prior 가 어긋나 plate_lost 로 빠질 수 있으므로,
    // "게인은 맞으나 절대 수렴하지 않는" 물리 대신 maxIterations 를 1 로 조여 상한 소진을 강제한다.
    const tightCfg = { ...cfg, maxIterations: 1 };
    const { cal, getSaved } = makeCalibrator({ cfg: tightCfg });
    cal.start();
    await waitDone(cal);
    const it0 = getSaved()!.items[0];
    expect(it0.reason).toBe('max_iterations');
    expect(it0.centered).toBe(false);
    expect(it0.converged).toBe(false);
  });
});

// ── T6: center 실패 시 zoom 미시도(설계서 §3 의미 변화) ──
describe('T6 center 실패 → zoom 미시도', () => {
  it('centerOnPlate ok:false 면 zoomToPlateWidth 호출 0회', async () => {
    // ★ plate 는 **non-null** 이어야 한다 — 실제 PlatePtz 의 max_iterations/plate_lost 반환은
    //   마지막 관측 plate 를 싣는다(platePtz.ts:228·250). plate:null 로 두면 가드의 `!c.plate`
    //   절만 타서 `!c.ok`(설계서 §3 의 의미 변화 본체)가 검증되지 않는다 — 뮤테이션 M3 로 실증됨.
    const failCenter: PlatePtzResult = {
      ok: false, ptz: { pan: 1, tilt: 2, zoom: 3 }, plate: CENTERED_PLATE, err: { errX: 0.2, errY: 0.2 },
      plateWidth: null, gain: GAIN, iterations: 15, reason: 'max_iterations',
    };
    const f = stubFactory(failCenter, okZoom);
    const { cal, getSaved } = makeCalibrator({ makePlatePtz: f.make });
    cal.start();
    await waitDone(cal);
    expect(f.zoomCalls).toHaveLength(0);   // ★ zoom 미시도
    expect(f.opts).toHaveLength(1);        // zoom 인스턴스 자체가 생성되지 않음
    const it0 = getSaved()!.items[0];
    expect(it0.converged).toBe(false);
    expect(it0.centered).toBe(false);
    expect(it0.reason).toBe('max_iterations');
    expect(it0.ptz).toEqual({ pan: 1, tilt: 2, zoom: 3 }); // 실패 지점의 명령 PTZ(복구 재료)
    expect(it0.plateWidth).toBe(0);        // §5-4: null → 0
  });

  it('no_plate(plate:null) 도 zoom 미시도', async () => {
    const noPlate: PlatePtzResult = {
      ok: false, ptz: { pan: 0, tilt: 0, zoom: 1 }, plate: null, err: null,
      plateWidth: null, gain: GAIN, iterations: 0, reason: 'no_plate',
    };
    const f = stubFactory(noPlate, okZoom);
    const { cal, getSaved } = makeCalibrator({ makePlatePtz: f.make });
    cal.start();
    await waitDone(cal);
    expect(f.zoomCalls).toHaveLength(0);
    expect(getSaved()!.items[0].reason).toBe('no_plate');
  });
});

// ── T7: DB 멱등(2회 실행) ──
describe('T7 DB 멱등', () => {
  it('동일 잡 2회 실행 → 행수 불변, pos JSON 이 item.ptz 와 일치', async () => {
    const store = new SqliteStore(':memory:');
    const { cal, getSaved } = makeCalibrator({ store }, artifact2());
    cal.start();
    await waitDone(cal);
    const first = store.getCenteringSlots();
    expect(first).toHaveLength(2);

    const { cal: cal2 } = makeCalibrator({ store }, artifact2());
    cal2.start();
    await waitDone(cal2);
    const second = store.getCenteringSlots();
    expect(second).toHaveLength(2); // 중복 0

    // 경계면: DB pos ↔ JSON item.ptz shape 교차 비교
    const item = getSaved()!.items.find((i) => i.slotId === 'c1p1s1')!;
    const row = second.find((r) => r.slotId === 'c1p1s1')!;
    expect(JSON.parse(row.pos)).toEqual(item.ptz);
    expect(Object.keys(JSON.parse(row.pos)).sort()).toEqual(['pan', 'tilt', 'zoom']);
    // 1-based 규약
    expect(row.camIdx).toBe(1);
    expect(row.presetIdx).toBe(1);
    expect(row.presetSlotIdx).toBe(1);
  });
});

// ── T8: DB 미주입 정상 동작 ──
describe('T8 DB 미주입', () => {
  it('store 생략 → 잡 done + JSON 저장, 예외 없음', async () => {
    const { cal, getSaved } = makeCalibrator(); // store 없음
    cal.start();
    await waitDone(cal);
    expect(cal.getStatus().state).toBe('done');
    expect(getSaved()!.items).toHaveLength(1);
  });
});

// ── T9: preset_slotidx 도출(1-based) ──
describe('T9 presetSlotIdx 도출', () => {
  it('coveredSlotIds 순서 1-based, 미포함 시 null', () => {
    const a: SetupArtifact = {
      createdAt: 'T',
      presets: [{ camIdx: 1, presetIdx: 1, label: 'p', coveredSlotIds: ['a', 'b', 'c'] }],
      globalIndex: [],
      slots: [
        { slotId: 'b', zone: 'z', roiByPreset: {}, plateRoiByPreset: { '1:1': rectToQuad({ x: 0.1, y: 0.1, w: 0.05, h: 0.03 }) } },
        { slotId: 'zz', zone: 'z', roiByPreset: {}, plateRoiByPreset: { '1:1': rectToQuad({ x: 0.2, y: 0.2, w: 0.05, h: 0.03 }) } },
      ],
    };
    const targets = expandPlateTargets(a);
    expect(targets.find((t) => t.slotId === 'b')!.presetSlotIdx).toBe(2); // 1-based
    expect(targets.find((t) => t.slotId === 'zz')!.presetSlotIdx).toBeNull();
  });

  it('프리셋 자체가 없으면 null(0/−1 발명 금지)', () => {
    const targets = expandPlateTargets(artifact()); // presets: []
    expect(targets[0].presetSlotIdx).toBeNull();
  });
});

// ── T10: 부분 캘리브레이션 — 타깃 외 행 보존 ──
describe('T10 부분 캘리브레이션 delete 범위', () => {
  it('2슬롯 전량 → 2행. 슬롯1만 재실행 → 여전히 2행, 타 행 updated_at 불변', async () => {
    const store = new SqliteStore(':memory:');
    const { cal } = makeCalibrator({ store, now: () => 'T-first' }, artifact2());
    cal.start();
    await waitDone(cal);
    const before = store.getCenteringSlots();
    expect(before).toHaveLength(2);
    expect(before.every((r) => r.updatedAt === 'T-first')).toBe(true);

    // 슬롯1만 부분 재실행(now 를 바꿔 갱신 여부 식별)
    const { cal: cal2 } = makeCalibrator({ store, now: () => 'T-second' }, artifact2());
    cal2.start(['c1p1s1']);
    await waitDone(cal2);

    const after = store.getCenteringSlots();
    expect(after).toHaveLength(2); // ★ 타깃 외 행 전멸 금지
    expect(after.find((r) => r.slotId === 'c1p1s1')!.updatedAt).toBe('T-second'); // 대상만 갱신
    expect(after.find((r) => r.slotId === 'c1p1s2')!.updatedAt).toBe('T-first');  // ★ 타 행 불변
  });
});

// ── T11: 실패 슬롯 DB 미저장 + last-known-good 보존 ──
describe('T11 실패 슬롯 DB 미저장', () => {
  it('1회차 성공 → 2회차 no_plate: JSON 엔 reason, DB 는 1회차 pos 유지', async () => {
    const store = new SqliteStore(':memory:');
    const { cal } = makeCalibrator({ store, now: () => 'T-ok' });
    cal.start();
    await waitDone(cal);
    const good = store.getCenteringSlots();
    expect(good).toHaveLength(1);
    const goodPos = good[0].pos;

    // 2회차: 같은 슬롯이 no_plate
    const lpd = { detect: async () => [] } as unknown as LpdClient;
    const { cal: cal2, getSaved } = makeCalibrator({ store, lpd, now: () => 'T-fail' });
    cal2.start();
    await waitDone(cal2);

    expect(getSaved()!.items[0].reason).toBe('no_plate'); // JSON 은 실패를 정직하게 기록
    const after = store.getCenteringSlots();
    expect(after).toHaveLength(1);
    expect(after[0].pos).toBe(goodPos);          // ★ 덮어쓰기 없음(last-known-good)
    expect(after[0].updatedAt).toBe('T-ok');     // ★ 실패가 updated_at 도 건드리지 않음
  });
});

// ── T12: upsertCenteringSlots 단위 ──
describe('T12 upsertCenteringSlots 단위', () => {
  it('insert / 동일 PK 갱신 / AS 매핑 / NULL presetSlotIdx 왕복', () => {
    const store = new SqliteStore(':memory:');
    store.upsertCenteringSlots([
      { slotId: 'c1p1s1', camIdx: 1, presetIdx: 1, presetSlotIdx: 1, pos: '{"pan":1,"tilt":2,"zoom":3}', updatedAt: 'T1' },
      { slotId: 'c1p1s2', camIdx: 1, presetIdx: 1, presetSlotIdx: null, pos: '{"pan":4,"tilt":5,"zoom":6}', updatedAt: 'T1' },
    ]);
    let rows = store.getCenteringSlots();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.slotId === 'c1p1s2')!.presetSlotIdx).toBeNull(); // NULL 왕복

    // 동일 PK 재-upsert → 갱신(행 증가 없음)
    store.upsertCenteringSlots([
      { slotId: 'c1p1s1', camIdx: 1, presetIdx: 1, presetSlotIdx: 9, pos: '{"pan":9,"tilt":9,"zoom":9}', updatedAt: 'T2' },
    ]);
    rows = store.getCenteringSlots();
    expect(rows).toHaveLength(2);
    const r1 = rows.find((r) => r.slotId === 'c1p1s1')!;
    expect(r1.pos).toBe('{"pan":9,"tilt":9,"zoom":9}');
    expect(r1.presetSlotIdx).toBe(9);
    expect(r1.updatedAt).toBe('T2');

    // 같은 slot_id 라도 preset 이 다르면 별도 행(PK 3키) — 복수 프리셋 관측
    store.upsertCenteringSlots([
      { slotId: 'c1p1s1', camIdx: 1, presetIdx: 2, presetSlotIdx: 1, pos: '{"pan":0,"tilt":0,"zoom":1}', updatedAt: 'T3' },
    ]);
    expect(store.getCenteringSlots()).toHaveLength(3);

    // AS 매핑 shape(스네이크 → 카멜)
    expect(Object.keys(r1).sort()).toEqual(['camIdx', 'pos', 'presetIdx', 'presetSlotIdx', 'slotId', 'updatedAt']);
  });
});

// ── T14(가산): items↔targets zip 정렬 — 슬롯 예외로 어긋나지 않는가 ──
describe('T14 items↔targets 인덱스 정렬(슬롯 예외 혼재)', () => {
  it('앞 슬롯이 예외로 실패해도 뒤 슬롯의 presetSlotIdx 가 밀리지 않는다', async () => {
    const store = new SqliteStore(':memory:');
    const m = makeMockModel();
    // 슬롯1(c1p1s1) 처리 중 예외 → items[0]=error, 슬롯2(c1p1s2)는 정상 성공.
    // saveCenteringSlots 가 targets[i] 로 zip 하므로, 정렬이 깨지면 slotIdx 가 1(슬롯1 값)로 오염된다.
    let calls = 0;
    const camera = {
      clampZoom: (z: number) => Math.min(36, Math.max(1, z)),
      requestImage: async (c: number, p: number, ptz?: Partial<Ptz>) => {
        if (calls++ === 0) throw new Error('transport boom'); // 첫 슬롯 첫 캡처에서 폭발
        return m.camera.requestImage(c, p, ptz);
      },
    } as unknown as CameraClient;

    const { cal, getSaved } = makeCalibrator({ store, camera, lpd: m.lpd }, artifact2());
    cal.start();
    await waitDone(cal);
    expect(cal.getStatus().state).toBe('done');

    const items = getSaved()!.items;
    expect(items).toHaveLength(2);
    expect(items[0].reason).toBe('error');   // 예외 흡수
    expect(items[1].converged).toBe(true);

    // DB 엔 성공한 슬롯2 만, 그리고 presetSlotIdx 는 **2**(자기 순서)여야 한다.
    const rows = store.getCenteringSlots();
    expect(rows).toHaveLength(1);
    expect(rows[0].slotId).toBe('c1p1s2');
    expect(rows[0].presetSlotIdx).toBe(2); // ★ 1 이면 zip 이 밀린 것
  });
});

// ── T13: DB 예외 격리(best-effort) ──
describe('T13 DB 예외 격리', () => {
  it('upsertCenteringSlots throw → 잡 done 유지 + JSON 정상', async () => {
    const store = {
      upsertCenteringSlots: () => { throw new Error('db down'); },
    } as unknown as Pick<SqliteStore, 'upsertCenteringSlots'>;
    const { cal, getSaved } = makeCalibrator({ store });
    cal.start();
    await waitDone(cal);
    expect(cal.getStatus().state).toBe('done'); // ★ DB 실패가 잡을 죽이지 않는다
    expect(getSaved()!.items[0].converged).toBe(true);
  });
});
