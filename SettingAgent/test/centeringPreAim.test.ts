import { describe, it, expect } from 'vitest';
import { PtzCalibrator, type PtzCalibratorDeps } from '../src/calibrate/PtzCalibrator.js';
import { expandPlateTargetsFromSlotSetup } from '../src/calibrate/slotPtzWriter.js';
import { scaleGainForZoom, panTiltCorrection } from '../src/calibrate/controlMath.js';
import { rectToQuad, quadBoundingRect, center } from '../src/domain/geometry.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { LpdClient } from '../src/clients/LpdClient.js';
import type { SqliteStore } from '../src/capture/SqliteStore.js';
import type { SlotSetupView, SlotCenteringRow } from '../src/capture/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { NormalizedRect } from '../src/domain/types.js';
import type { PlatePtz, PlatePtzOpts, PlatePtzResult } from '../src/calibrate/platePtz.js';
import type { Ptz, SlotPtzArtifact, SlotPtzItem } from '../src/calibrate/types.js';

/**
 * 검증자(qa-tester): 정밀수집 센터라이징 pre-aim(anti-latch)·anti-duplication·순서·R2 게이트·R3 스냅샷.
 * 설계 01_architect_plan §B-1(결정형, sim 불요) 대상. PlatePtz 폐루프는 makePlatePtz 스텁으로 시임화하여
 * centerOnPlate 에 전달된 startPtz(=preAim)·plateRoi(미전달) 를 캡처해 경계에서 검증한다.
 *
 * ★ 라이브 한계(은닉 금지): 실 PTZ 물리 수렴·pre-aim 이 실카메라에서 정판을 중앙에 두는지·비-cam1 게인
 *   정확도는 sim 13100 DOWN 으로 검증 불가(설계 §B-3). 여기서는 결정형(선조준 산출·인자 전달·저장 게이트·
 *   스냅샷 호출)만 확정한다.
 */

const cfg: ToolsConfig['calibrate'] = {
  targetPlateWidth: 0.2, centerTol: 0.03, widthTol: 0.02, maxIterations: 30,
  probeStepDeg: 1.0, maxStepDeg: 5.0, fallbackGainPanDeg: -62, fallbackGainTiltDeg: -35.5,
  settleMs: 0, outFile: 'data/slot_ptz.json',
};

/** lpd 보유 slot_setup 뷰 1건. lpdRect(축정렬)→rectToQuad 로 OBB 시드, globalIdx=slotId. */
function view(slotId: number, lpdRect: NormalizedRect, over: Partial<SlotSetupView> = {}): SlotSetupView {
  return {
    slotId, camId: 1, presetId: 1, presetSlotIdx: 1, presetKey: '1:1',
    roi: [], vpd: null, lpd: rectToQuad(lpdRect), occupyRange: null,
    pan: null, tilt: null, zoom: null, centered: false, img1: null, slot3dFrontCenter: null, updatedAt: null,
    ...over,
  };
}

/** getSlotSetup 소스 + upsertSlotCentering rows 캡처 store 시임. */
function storeWith(v: SlotSetupView[], sink?: SlotCenteringRow[][]): Pick<SqliteStore, 'upsertSlotCentering' | 'getSlotSetup'> {
  return {
    getSlotSetup: () => v,
    upsertSlotCentering: (rows: SlotCenteringRow[]) => { sink?.push(rows); },
  } as unknown as Pick<SqliteStore, 'upsertSlotCentering' | 'getSlotSetup'>;
}

/** listCameras 로 프리셋 base PTZ 를 공급하는 카메라 시임(resolvePresetPtz 소스). makePlatePtz 스텁이라 requestImage 미사용. */
function cameraWithPreset(base: Ptz | null): CameraClient {
  return {
    clampZoom: (z: number) => Math.min(36, Math.max(1, z)),
    requestImage: async () => ({ camIdx: 1, presetIdx: 1, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('i') }),
    listCameras: async () => ({
      cameras: base
        ? [{ camIdx: 1, presets: [{ presetIdx: 1, pan: base.pan, tilt: base.tilt, zoom: base.zoom }] }]
        : [{ camIdx: 1, presets: [{ presetIdx: 1 }] }], // pan/tilt/zoom 부재 → resolvePresetPtz null → 0/0/1 폴백.
    }),
  } as unknown as CameraClient;
}

const dummyLpd = { detect: async () => [] } as unknown as LpdClient;

/**
 * makePlatePtz 시임: centerOnPlate/zoomToPlateWidth 호출 인자(startPtz)·생성 opts 를 캡처.
 * 모델: centerOnPlate 는 넘겨받은 startPtz 를 그대로 수렴점으로 반환(ptz:startPtz) → 최종 item.ptz 가
 *       슬롯별 preAim 을 반영. centered/converged 는 인자로 제어(R2 게이트 시나리오).
 */
function captureStub(opt: { centerOk?: boolean; zoomOk?: boolean } = {}) {
  const centerOk = opt.centerOk ?? true;
  const zoomOk = opt.zoomOk ?? true;
  const centerCalls: Array<{ camIdx: number; presetIdx: number; startPtz: Ptz; opts: PlatePtzOpts }> = [];
  const zoomCalls: Array<{ startPtz: Ptz; opts: PlatePtzOpts }> = [];
  const gain = { gainPan: -62, gainTilt: -35.5, zoomRef: 1 };
  const plate = { quad: rectToQuad({ x: 0.48, y: 0.485, w: 0.05, h: 0.03 }), confidence: 0.9, cls: 'plate' as const };
  const make = (opts: PlatePtzOpts): Pick<PlatePtz, 'centerOnPlate' | 'zoomToPlateWidth'> => ({
    centerOnPlate: async (camIdx: number, presetIdx: number, startPtz: Ptz): Promise<PlatePtzResult> => {
      centerCalls.push({ camIdx, presetIdx, startPtz, opts });
      return centerOk
        ? { ok: true, ptz: startPtz, plate, err: { errX: 0, errY: 0 }, plateWidth: 0.1, gain, iterations: 1 }
        : { ok: false, ptz: startPtz, plate: null, err: null, plateWidth: null, gain, iterations: 30, reason: 'max_iterations' };
    },
    zoomToPlateWidth: async (_c: number, _p: number, startPtz: Ptz): Promise<PlatePtzResult> => {
      zoomCalls.push({ startPtz, opts });
      return zoomOk
        ? { ok: true, ptz: startPtz, plate, err: { errX: 0, errY: 0 }, plateWidth: 0.2, gain, iterations: 1 }
        : { ok: false, ptz: startPtz, plate, err: { errX: 0, errY: 0 }, plateWidth: 0.5, gain, iterations: 30, reason: 'zoom_saturated' };
    },
  });
  return { make, centerCalls, zoomCalls };
}

function makeCal(over: Partial<PtzCalibratorDeps>, v: SlotSetupView[]) {
  let saved: SlotPtzArtifact | undefined;
  const deps: PtzCalibratorDeps = {
    camera: cameraWithPreset({ pan: 10, tilt: 5, zoom: 2 }), lpd: dummyLpd, store: storeWith(v), cfg,
    writer: (art) => { saved = art; }, sleep: async () => {}, now: () => 'T',
    ...over,
  };
  return { cal: new PtzCalibrator(deps), getSaved: () => saved };
}

async function waitDone(cal: PtzCalibrator): Promise<void> {
  for (let i = 0; i < 20000 && cal.getStatus().state === 'running'; i++) await Promise.resolve();
}

/** 구현(PtzCalibrator.preAimPtz)과 동일한 선조준 계산 미러. */
function preAimOf(base: Ptz, lpdRect: NormalizedRect): Ptz {
  const g = scaleGainForZoom({ gainPan: cfg.fallbackGainPanDeg, gainTilt: cfg.fallbackGainTiltDeg, zoomRef: 1 }, base.zoom);
  const c = center(quadBoundingRect(rectToQuad(lpdRect)));
  const pt = panTiltCorrection({ errX: c.cx - 0.5, errY: c.cy - 0.5 }, g, base.pan, base.tilt, 90);
  return { pan: pt.pan, tilt: pt.tilt, zoom: base.zoom };
}

// ── B-1.1: preAimPtz(anti-latch 핵심) — 서로 다른 박스중심→서로 다른 pre-aim, zoom 불변, 부호 ──
describe('B-1.1 preAimPtz 선조준(anti-latch)', () => {
  const base: Ptz = { pan: 10, tilt: 5, zoom: 2 };
  const rightBox: NormalizedRect = { x: 0.62, y: 0.62, w: 0.05, h: 0.03 }; // 중심 (0.645, 0.635) 우하단
  const leftBox: NormalizedRect = { x: 0.10, y: 0.30, w: 0.05, h: 0.03 };  // 중심 (0.125, 0.315) 좌상단

  it('centerOnPlate 에 전달된 startPtz 의 pan/tilt == preAim(구현 미러), zoom == acquireZoom(줌인), plateRoi 미전달', async () => {
    const s = captureStub();
    const { cal } = makeCal({ camera: cameraWithPreset(base), makePlatePtz: s.make }, [view(7, rightBox)]);
    cal.start();
    await waitDone(cal);
    expect(s.centerCalls).toHaveLength(1);
    // 인자 캡처: pan/tilt 는 base 가 아니라 선조준된 값(구현과 동일 계산 — anti-latch 유지).
    const pre = preAimOf(base, rightBox);
    expect(s.centerCalls[0].startPtz.pan).toBeCloseTo(pre.pan, 6);
    expect(s.centerCalls[0].startPtz.tilt).toBeCloseTo(pre.tilt, 6);
    // ★ 방안2(줌인 acquire): zoom 은 base(2) 가 아니라 acquireZoom(=2×0.12/0.05=4.8) 으로 줌인해 검출.
    expect(s.centerCalls[0].startPtz.zoom).toBeCloseTo(4.8, 4);
    expect(s.centerCalls[0].startPtz.pan).not.toBe(base.pan); // ★ base 그대로가 아님(공유 시작점 latch 차단).
    // 센터링 단계 opts.plateRoi 미전달(= 화면중앙 최근접).
    expect(s.centerCalls[0].opts.plateRoi).toBeUndefined();
  });

  it('zoom == acquireZoom(방안2: 줌인 우선, base.zoom 아님)', async () => {
    const s = captureStub();
    const { cal } = makeCal({ camera: cameraWithPreset(base), makePlatePtz: s.make }, [view(7, rightBox)]);
    cal.start();
    await waitDone(cal);
    // 구 계약(넓은시야 base.zoom 고정 센터)이 방안2로 반전 — acquireZoom 으로 먼저 줌인해 큰 판을 검출·센터.
    expect(s.centerCalls[0].startPtz.zoom).toBeCloseTo(4.8, 4); // 2×0.12/0.05.
    expect(s.centerCalls[0].startPtz.zoom).toBeGreaterThan(base.zoom);
  });

  it('부호: 우측 박스(cx>0.5)→errX>0→pan↑(우향, pan>base.pan)', async () => {
    const s = captureStub();
    const { cal } = makeCal({ camera: cameraWithPreset(base), makePlatePtz: s.make }, [view(7, rightBox)]);
    cal.start();
    await waitDone(cal);
    expect(s.centerCalls[0].startPtz.pan).toBeGreaterThan(base.pan);  // 우측 → pan 증가
    expect(s.centerCalls[0].startPtz.tilt).toBeGreaterThan(base.tilt); // 하단(cy>0.5) → tilt 증가
  });

  it('좌측 박스(cx<0.5)→errX<0→pan↓(pan<base.pan) — 방향 반전 확인', async () => {
    const s = captureStub();
    const { cal } = makeCal({ camera: cameraWithPreset(base), makePlatePtz: s.make }, [view(7, leftBox)]);
    cal.start();
    await waitDone(cal);
    expect(s.centerCalls[0].startPtz.pan).toBeLessThan(base.pan);
    expect(s.centerCalls[0].startPtz.tilt).toBeLessThan(base.tilt); // 상단(cy<0.5) → tilt 감소
  });

  it('서로 다른 박스중심 → 서로 다른 pre-aim(anti-latch 속성)', async () => {
    const s = captureStub();
    // 공유 base·동일 cam/preset 두 슬롯, LPD 중심만 다름 → 선조준 startPtz 가 갈려야 함.
    const { cal } = makeCal({ camera: cameraWithPreset(base), makePlatePtz: s.make }, [view(8, rightBox), view(9, leftBox)]);
    cal.start();
    await waitDone(cal);
    expect(s.centerCalls).toHaveLength(2);
    const [a, b] = s.centerCalls;
    expect(a.startPtz).not.toEqual(b.startPtz); // ★ 공유 시작점 아님(핵심).
    expect(a.startPtz.pan).not.toBeCloseTo(b.startPtz.pan, 3);
  });
});

// ── B-1.2: anti-duplication — 인접 두 슬롯(구분 prior)이 서로 다른 최종 PTZ ──
describe('B-1.2 anti-duplication(인접 슬롯 중복 PTZ 소멸)', () => {
  it('구분되는 prior 두 슬롯 → 서로 다른 최종 item.ptz, 둘 다 plateRoi 미전달(화면중앙)', async () => {
    const base: Ptz = { pan: 30, tilt: 9, zoom: 1.7 };
    // slot_ptz.json 증거의 이웃 수렴(동일 55.44) 재현 방지: 구분되는 LPD 중심 두 슬롯.
    const box8: NormalizedRect = { x: 0.40, y: 0.60, w: 0.05, h: 0.03 };
    const box9: NormalizedRect = { x: 0.72, y: 0.60, w: 0.05, h: 0.03 };
    const s = captureStub();
    const { cal, getSaved } = makeCal(
      { camera: cameraWithPreset(base), makePlatePtz: s.make },
      [view(8, box8), view(9, box9)],
    );
    cal.start();
    await waitDone(cal);

    const items = getSaved()!.items;
    expect(items).toHaveLength(2);
    // 최종 PTZ 는 스텁이 startPtz(=preAim)를 수렴점으로 반환 → 슬롯별로 갈린다(중복 아님).
    expect(items[0].ptz).not.toEqual(items[1].ptz);
    expect(items[0].ptz.pan).not.toBeCloseTo(items[1].ptz.pan, 3);
    // startPtz.pan/tilt == preAim(구현 미러), plateRoi 미전달(센터링 단계 opts 없음) — 둘 다.
    // ★ 방안2: zoom 은 acquireZoom(줌인)이라 base.zoom 과 다름 — pan/tilt(anti-duplication 축)만 비교.
    expect(s.centerCalls[0].startPtz.pan).toBeCloseTo(preAimOf(base, box8).pan, 6);
    expect(s.centerCalls[0].startPtz.tilt).toBeCloseTo(preAimOf(base, box8).tilt, 6);
    expect(s.centerCalls[1].startPtz.pan).toBeCloseTo(preAimOf(base, box9).pan, 6);
    expect(s.centerCalls[1].startPtz.tilt).toBeCloseTo(preAimOf(base, box9).tilt, 6);
    for (const c of s.centerCalls) expect(c.opts.plateRoi).toBeUndefined();
  });
});

// ── B-1.3: 순서 — preset_slotidx NULL·역순 섞은 views → targets (camIdx,presetIdx,globalIdx) asc ──
describe('B-1.3 expandPlateTargetsFromSlotSetup 정렬(주차면 asc)', () => {
  it('camIdx/presetIdx/globalIdx 역순·NULL presetSlotIdx 섞어도 asc 로 귀결', () => {
    const box: NormalizedRect = { x: 0.5, y: 0.5, w: 0.05, h: 0.03 };
    // 의도적으로 뒤섞고 presetSlotIdx=null 을 섞음(정렬 키는 globalIdx=slotId, NULL tie-break 불요).
    const views: SlotSetupView[] = [
      view(30, box, { camId: 2, presetId: 1, presetSlotIdx: null }),
      view(20, box, { camId: 1, presetId: 2, presetSlotIdx: null }),
      view(12, box, { camId: 1, presetId: 1, presetSlotIdx: 4 }),
      view(8, box, { camId: 1, presetId: 1, presetSlotIdx: 1 }),
      view(19, box, { camId: 1, presetId: 2, presetSlotIdx: 3 }),
    ];
    const targets = expandPlateTargetsFromSlotSetup(views);
    // (camIdx, presetIdx, globalIdx) asc: c1p1s8, c1p1s12, c1p2s19, c1p2s20, c2p1s30.
    expect(targets.map((t) => `${t.camIdx}:${t.presetIdx}:${t.globalIdx}`)).toEqual([
      '1:1:8', '1:1:12', '1:2:19', '1:2:20', '2:1:30',
    ]);
    expect(targets.map((t) => t.globalIdx)).toEqual([8, 12, 19, 20, 30]);
    // 단조 비감소(연속쌍 검증).
    for (let i = 1; i < targets.length; i++) {
      const p = targets[i - 1], q = targets[i];
      const key = (t: typeof p) => t.camIdx * 1e6 + t.presetIdx * 1e3 + (t.globalIdx ?? 0);
      expect(key(q)).toBeGreaterThanOrEqual(key(p));
    }
  });
});

// ── B-1.4: R2 게이트 — saveCenteringSlots 포함/제외 규칙 ──
describe('B-1.4 saveCenteringSlots 게이트(centered-only)', () => {
  it('{centered:true,converged:false} 포함(zoom 미수렴도 pan/tilt 유효) — rows 1건, centered:1', async () => {
    const sink: SlotCenteringRow[][] = [];
    const s = captureStub({ centerOk: true, zoomOk: false }); // 중심 O, 폭 X → centered:true, converged:false
    const { cal, getSaved } = makeCal({ makePlatePtz: s.make, store: storeWith([view(7, { x: 0.62, y: 0.62, w: 0.05, h: 0.03 })], sink) }, [view(7, { x: 0.62, y: 0.62, w: 0.05, h: 0.03 })]);
    cal.start();
    await waitDone(cal);
    const item = getSaved()!.items[0];
    expect(item.centered).toBe(true);
    expect(item.converged).toBe(false); // ★ zoom 미수렴
    expect(sink).toHaveLength(1);
    expect(sink[0]).toHaveLength(1);
    expect(sink[0][0].slotId).toBe(7);
    expect(sink[0][0].centered).toBe(1); // ★ 게이트 통과 → DB 반영
  });

  it('{centered:false} 제외(번호판 미검) — upsert 미호출', async () => {
    const sink: SlotCenteringRow[][] = [];
    const s = captureStub({ centerOk: false }); // 중심 실패 → centered:false
    const { cal, getSaved } = makeCal({ makePlatePtz: s.make, store: storeWith([view(7, { x: 0.62, y: 0.62, w: 0.05, h: 0.03 })], sink) }, [view(7, { x: 0.62, y: 0.62, w: 0.05, h: 0.03 })]);
    cal.start();
    await waitDone(cal);
    expect(getSaved()!.items[0].centered).toBe(false);
    expect(sink).toHaveLength(0); // ★ 빈 rows → upsert 미호출(오염 방지)
  });

  it('{globalIdx:null} 제외(방어 경로) — 매핑 불가 슬롯 스킵', async () => {
    const sink: SlotCenteringRow[][] = [];
    const s = captureStub({ centerOk: true, zoomOk: true });
    // slot_setup 소스는 정상적으로 globalIdx=slotId(정수)를 주지만, 방어 코드 검증 위해 slotId=null 뷰를 캐스팅 주입.
    const nullView = view(0, { x: 0.62, y: 0.62, w: 0.05, h: 0.03 }, { slotId: null as unknown as number });
    const { cal, getSaved } = makeCal({ makePlatePtz: s.make, store: storeWith([nullView], sink) }, [nullView]);
    cal.start();
    await waitDone(cal);
    expect(getSaved()!.items[0].globalIdx).toBeNull();
    expect(getSaved()!.items[0].centered).toBe(true); // 센터링 자체는 성공
    expect(sink).toHaveLength(0); // ★ globalIdx 부재 → 매핑 불가 스킵(rows 비어 upsert 미호출)
  });
});

// ── B-1.5: R3 스냅샷 — done 시 아카이브+최종결과물 2회, error 미호출, 미주입 no-op ──
describe('B-1.5 saveSetupSnapshot(R3)', () => {
  const box: NormalizedRect = { x: 0.62, y: 0.62, w: 0.05, h: 0.03 };

  it('done 경로: saveSnapshot 2회 — Setup_ 아카이브 + setup_result 최종결과물', async () => {
    const snap: Array<{ name: string; data: unknown }> = [];
    const saveStore = { saveSnapshot: (name: string, data: unknown) => { snap.push({ name, data }); return name; } };
    const s = captureStub();
    const views = [view(7, box)];
    const { cal, getSaved } = makeCal({ makePlatePtz: s.make, saveStore, store: storeWith(views) }, views);
    cal.start();
    await waitDone(cal);
    expect(cal.getStatus().state).toBe('done');
    expect(snap).toHaveLength(2); // ★ 아카이브 1 + 최종결과물 1(잡당 각 1회)
    expect(snap[0].name).toMatch(/^Setup_\d{8}_\d{6}$/); // Setup_YYYYMMDD_HHMMSS
    const payload = snap[0].data as { createdAt: string; slots: SlotSetupView[]; centering: SlotPtzItem[] };
    expect(payload.createdAt).toBe('T'); // now() 주입값
    expect(payload.slots).toBe(views); // getSlotSetup() 재조회 결과(PTZ 반영 뷰)
    expect(payload.centering).toBe(getSaved()!.items); // 센터링 상세(items) 그대로

    // 최종결과물: 고정 이름 setup_result + 샘플 스키마(slots[])
    expect(snap[1].name).toBe('setup_result');
    const result = snap[1].data as { slots: Array<{ slotId: number; floor_roi: unknown; occupy_roi: unknown; centering: unknown }> };
    expect(result.slots).toHaveLength(1);
    expect(result.slots[0].slotId).toBe(7);
  });

  it('아카이브 저장이 실패해도 setup_result 는 기록(각자 best-effort·독립)', async () => {
    const names: string[] = [];
    const saveStore = {
      saveSnapshot: (name: string) => {
        names.push(name);
        if (name.startsWith('Setup_')) throw new Error('archive io fail');
        return name;
      },
    };
    const s = captureStub();
    const views = [view(7, box)];
    const { cal } = makeCal({ makePlatePtz: s.make, saveStore, store: storeWith(views) }, views);
    cal.start();
    await waitDone(cal);
    expect(cal.getStatus().state).toBe('done');
    expect(names).toContain('setup_result'); // ★ 아카이브 실패에 물리지 않는다
  });

  it('error 경로: writer throw → state error → saveSnapshot 미호출(부분·불신 미기록)', async () => {
    const snap: unknown[] = [];
    const saveStore = { saveSnapshot: (name: string) => { snap.push(name); return name; } };
    const s = captureStub();
    const views = [view(7, box)];
    const { cal } = makeCal({
      makePlatePtz: s.make, saveStore, store: storeWith(views),
      writer: () => { throw new Error('writer boom'); }, // saveSetupSnapshot 이전 단계에서 폭발.
    }, views);
    cal.start();
    await waitDone(cal);
    expect(cal.getStatus().state).toBe('error');
    expect(snap).toHaveLength(0); // ★ error 경로 미호출
  });

  it('saveStore 미주입 → no-op(회귀 0, 잡 정상 done)', async () => {
    const s = captureStub();
    const views = [view(7, box)];
    const { cal, getSaved } = makeCal({ makePlatePtz: s.make, store: storeWith(views) }, views); // saveStore 없음
    cal.start();
    await waitDone(cal);
    expect(cal.getStatus().state).toBe('done'); // 스냅샷 없어도 정상 완료
    expect(getSaved()!.items).toHaveLength(1);
  });

  it('스냅샷 기록 실패는 격리 — saveSnapshot throw 해도 잡 done(정본 JSON·DB 무영향)', async () => {
    const saveStore = { saveSnapshot: () => { throw new Error('snapshot io fail'); } };
    const s = captureStub();
    const views = [view(7, box)];
    const { cal, getSaved } = makeCal({ makePlatePtz: s.make, saveStore, store: storeWith(views) }, views);
    cal.start();
    await waitDone(cal);
    expect(cal.getStatus().state).toBe('done'); // ★ best-effort 격리
    expect(getSaved()!.items).toHaveLength(1);
  });
});
