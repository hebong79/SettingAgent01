import { describe, it, expect } from 'vitest';
import { PlateDiscoveryJob } from '../src/calibrate/PlateDiscoveryJob.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { LpdClient } from '../src/clients/LpdClient.js';
import type { SqliteStore } from '../src/capture/SqliteStore.js';
import type { SlotLpdRow, SlotSetupView } from '../src/capture/types.js';
import type { DiscoveryTarget, PlateDiscoveryItem, PlateDiscoveryArtifact } from '../src/calibrate/types.js';
import type { NormalizedPoint } from '../src/domain/types.js';
import { quadBoundingRect, rectToQuad } from '../src/domain/geometry.js';
import { buildPlateAnchoredQuad } from '../src/capture/floorRoi.js';
import { stringify5 } from '../src/util/round.js';

/**
 * 검증자(qa-tester): PlateDiscoveryJob.run 프리셋별 peer 그룹핑(설계 §9-2). discoverSlot 시임이 받은
 * peerAnchors 를 기록해, 각 슬롯이 **자기 프리셋·자기 제외** 하향앵커만 수신하는지 교차검증(V-13).
 * 외부(카메라/LPD/DB/파일) 전부 스텁 — 실 서비스 호출 0.
 */

const fakeCamera = (): CameraClient =>
  ({
    health: async () => true,
    listCameras: async () => ({ cameras: [] }), // resolvePresetPtz → null(폴백, throw 아님)
    requestImage: async () => ({ camIdx: 1, presetIdx: 1, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('x') }),
  }) as unknown as CameraClient;
const fakeLpd = (): LpdClient => ({ detect: async () => [] }) as unknown as LpdClient;

/** roi:[] → lowerFrontAnchor 폴백 → anchor = slot3dFrontCenter. frontCenter 를 슬롯별 고유 지정. */
function storeMixed(): Pick<SqliteStore, 'getSlotSetup' | 'upsertSlotLpd'> {
  const base = {
    roi: [], vpd: null, lpd: null, occupyRange: null, pan: null, tilt: null, zoom: null,
    centered: false, img1: null, updatedAt: null,
  };
  const v: SlotSetupView[] = [
    { slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1, presetKey: '1:1', slot3dFrontCenter: { x: 0.3, y: 0.5 }, ...base },
    { slotId: 2, camId: 1, presetId: 1, presetSlotIdx: 2, presetKey: '1:1', slot3dFrontCenter: { x: 0.5, y: 0.5 }, ...base },
    { slotId: 3, camId: 1, presetId: 2, presetSlotIdx: 1, presetKey: '1:2', slot3dFrontCenter: { x: 0.7, y: 0.5 }, ...base },
  ];
  return { getSlotSetup: () => v, upsertSlotLpd: () => {} } as unknown as Pick<SqliteStore, 'getSlotSetup' | 'upsertSlotLpd'>;
}

const foundItem = (t: DiscoveryTarget): PlateDiscoveryItem => ({
  camIdx: t.camIdx, presetIdx: t.presetIdx, slotId: t.slotId, globalIdx: t.globalIdx,
  found: true, lpdOrig: rectToQuad({ x: 0.5, y: 0.5, w: 0.05, h: 0.03 }), tier: 'crop', step: 1, confidence: 0.9,
});

async function waitDone(job: PlateDiscoveryJob): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (job.getStatus().state !== 'running') return;
    await Promise.resolve();
  }
}

describe('PlateDiscoveryJob.run · V-13 프리셋별 peer 그룹핑', () => {
  it('2 프리셋(1:1 슬롯1,2 / 1:2 슬롯3) 혼합 → 각 discoverSlot 이 자기 프리셋·자기 제외 앵커만 수신', async () => {
    const seen: { slotId: string; presetIdx: number; peers: NormalizedPoint[] }[] = [];
    const job = new PlateDiscoveryJob({
      camera: fakeCamera(),
      lpd: fakeLpd(),
      store: storeMixed(),
      outFile: 'unused.json',
      makeDiscovery: () => ({
        discoverSlot: async (t: DiscoveryTarget, _ptz?: unknown, peerAnchors: NormalizedPoint[] = []) => {
          seen.push({ slotId: t.slotId, presetIdx: t.presetIdx, peers: peerAnchors });
          return foundItem(t);
        },
      }),
      writer: (_a: PlateDiscoveryArtifact) => {}, // 파일 IO 차단
      now: () => 'T',
    });

    expect(job.start({}).total).toBe(3);
    await waitDone(job);
    expect(job.getStatus().state).toBe('done');
    expect(seen).toHaveLength(3);

    const bySlot = Object.fromEntries(seen.map((s) => [s.slotId, s]));

    // 슬롯1(1:1): peer = 같은 프리셋 자기 제외 = 슬롯2 앵커(0.5,0.5) 1개.
    expect(bySlot['1'].peers).toEqual([{ x: 0.5, y: 0.5 }]);
    // 슬롯2(1:1): peer = 슬롯1 앵커(0.3,0.5) 1개.
    expect(bySlot['2'].peers).toEqual([{ x: 0.3, y: 0.5 }]);
    // 슬롯3(1:2): 프리셋 단독 → peer 없음(빈 배열) = 소유권 무조건 통과(하위호환).
    expect(bySlot['3'].peers).toEqual([]);

    // 자기 앵커는 peer 에 절대 포함 안 됨(자기 제외 규약).
    expect(bySlot['1'].peers).not.toContainEqual({ x: 0.3, y: 0.5 });
    expect(bySlot['2'].peers).not.toContainEqual({ x: 0.5, y: 0.5 });
  });
});

// ── onFinished 완료 콜백(신규, 이터레이션 1) ──────────────────────────────
/** 단일 슬롯 store(slot3dFrontCenter 보유 → 대상 1). upsertSlotLpd 캡처 스파이 첨부. */
function storeOne(captured?: SlotLpdRow[][]): Pick<SqliteStore, 'getSlotSetup' | 'upsertSlotLpd'> {
  const base = {
    roi: [], vpd: null, lpd: null, occupyRange: null, pan: null, tilt: null, zoom: null,
    centered: false, img1: null, updatedAt: null,
  };
  const v: SlotSetupView[] = [
    { slotId: 7, camId: 1, presetId: 1, presetSlotIdx: 1, presetKey: '1:1', slot3dFrontCenter: { x: 0.5, y: 0.5 }, ...base },
  ];
  return {
    getSlotSetup: () => v,
    upsertSlotLpd: (rows: SlotLpdRow[]) => { captured?.push(rows); },
  } as unknown as Pick<SqliteStore, 'getSlotSetup' | 'upsertSlotLpd'>;
}

/** discoverSlot 시임 팩토리(found 여부 고정). */
function makeDiscoveryFactory(found: boolean, lpdOrig = rectToQuad({ x: 0.5, y: 0.5, w: 0.05, h: 0.03 })) {
  return () => ({
    discoverSlot: async (t: DiscoveryTarget): Promise<PlateDiscoveryItem> => ({
      camIdx: t.camIdx, presetIdx: t.presetIdx, slotId: t.slotId, globalIdx: t.globalIdx,
      found, lpdOrig: found ? lpdOrig : null, tier: 'crop', step: 1, confidence: found ? 0.9 : 0,
      ...(found ? {} : { reason: 'no_plate' as const }),
    }),
  });
}

describe('PlateDiscoveryJob onFinished 완료 콜백 (파이프라인 배선)', () => {
  it('성공 종단 → onFinished("done") 1회 발화', async () => {
    const states: ('done' | 'error')[] = [];
    const job = new PlateDiscoveryJob({
      camera: fakeCamera(), lpd: fakeLpd(), store: storeOne(), outFile: 'unused.json',
      makeDiscovery: makeDiscoveryFactory(true),
      writer: () => {}, now: () => 'T',
      onFinished: (s) => states.push(s),
    });
    job.start({});
    await waitDone(job);
    expect(job.getStatus().state).toBe('done');
    expect(states).toEqual(['done']);
  });

  it('run 내부 throw(writer 예외) → 상태 error + onFinished("error")', async () => {
    const states: ('done' | 'error')[] = [];
    const job = new PlateDiscoveryJob({
      camera: fakeCamera(), lpd: fakeLpd(), store: storeOne(), outFile: 'unused.json',
      makeDiscovery: makeDiscoveryFactory(true),
      writer: () => { throw new Error('writer boom'); }, // 슬롯 루프 밖 throw → 외부 catch → error
      now: () => 'T',
      onFinished: (s) => states.push(s),
    });
    job.start({});
    await waitDone(job);
    expect(job.getStatus().state).toBe('error');
    expect(states).toEqual(['error']);
  });

  it('콜백 throw 는 흡수 — 잡은 그대로 terminal(done) 도달', async () => {
    const job = new PlateDiscoveryJob({
      camera: fakeCamera(), lpd: fakeLpd(), store: storeOne(), outFile: 'unused.json',
      makeDiscovery: makeDiscoveryFactory(true),
      writer: () => {}, now: () => 'T',
      onFinished: () => { throw new Error('callback boom'); }, // notifyFinished try/catch 흡수
    });
    expect(() => job.start({})).not.toThrow();
    await waitDone(job);
    expect(job.getStatus().state).toBe('done'); // ★ 콜백 예외가 잡을 죽이지 않음
  });

  it('콜백 미주입(수동 /discover/ptz 경로) → no-op, crash 없음', async () => {
    const job = new PlateDiscoveryJob({
      camera: fakeCamera(), lpd: fakeLpd(), store: storeOne(), outFile: 'unused.json',
      makeDiscovery: makeDiscoveryFactory(true),
      writer: () => {}, now: () => 'T',
      // onFinished 미주입
    });
    expect(() => job.start({})).not.toThrow();
    await waitDone(job);
    expect(job.getStatus().state).toBe('done');
  });
});

describe('PlateDiscoveryJob.saveSlotLpd 점유영역(occupy_range) 동봉 (이터레이션 2)', () => {
  it('found 슬롯 → upsertSlotLpd 행에 판 quad 로 유도한 occupyRange 동봉', async () => {
    const captured: SlotLpdRow[][] = [];
    const lpdOrig = rectToQuad({ x: 0.5, y: 0.5, w: 0.05, h: 0.03 });
    const job = new PlateDiscoveryJob({
      camera: fakeCamera(), lpd: fakeLpd(), store: storeOne(captured), outFile: 'unused.json',
      makeDiscovery: makeDiscoveryFactory(true, lpdOrig),
      writer: () => {}, now: () => 'T',
    });
    job.start({});
    await waitDone(job);

    expect(captured).toHaveLength(1); // upsertSlotLpd 1회
    const rows = captured[0];
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.slotId).toBe(7); // globalIdx = slot_id
    expect(row.lpdObb).toBe(stringify5(lpdOrig));
    // ★ 경계면: occupyRange = Finalizer 판-only 경로와 동일 재사용 산출과 일치.
    const expectedOccupy = stringify5(buildPlateAnchoredQuad(quadBoundingRect(lpdOrig), lpdOrig));
    expect(row.occupyRange).toBe(expectedOccupy);
    expect(row.occupyRange).not.toBeUndefined(); // found → 반드시 제공(occupy_range 갱신)
  });

  it('미검출 슬롯 → 행 미생성(upsertSlotLpd 미호출, 위장 저장 없음)', async () => {
    const captured: SlotLpdRow[][] = [];
    const job = new PlateDiscoveryJob({
      camera: fakeCamera(), lpd: fakeLpd(), store: storeOne(captured), outFile: 'unused.json',
      makeDiscovery: makeDiscoveryFactory(false), // found:false
      writer: () => {}, now: () => 'T',
    });
    job.start({});
    await waitDone(job);
    expect(job.getStatus().state).toBe('done');
    expect(job.getStatus().found).toBe(0);
    expect(captured).toHaveLength(0); // ★ 미검출은 저장 스킵(occupy_range wipe 없음)
  });
});
