import { describe, it, expect } from 'vitest';
import { PlateDiscoveryJob } from '../src/calibrate/PlateDiscoveryJob.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { LpdClient } from '../src/clients/LpdClient.js';
import type { SqliteStore } from '../src/capture/SqliteStore.js';
import type { SlotSetupView } from '../src/capture/types.js';
import type { DiscoveryTarget, PlateDiscoveryItem } from '../src/calibrate/types.js';
import { rectToQuad } from '../src/domain/geometry.js';

/**
 * 검증자(qa-tester): W3 대기시간 배선 (설계서 §11.1 U4 — 요구1 슬롯당 0.5s · 요구2 점유 0.3s).
 *
 * ★ 이 유닛이 **유일한 증거**다: 구현자는 잡 상태 폴링(2s 주기)으로 슬롯 경계를 실측하지 못했다고 보고했다
 *   (02_developer_changes.md §6 "확인 못 한 항목" 1). fake sleep 으로 호출 인자·횟수를 직접 센다.
 *
 * 대기 미지정(수동 `/discover/ptz`) 시 sleep **0회**(회귀 0)도 같은 하네스로 봉인한다.
 * discoverSlot 은 시임 — LPD/카메라 왕복 0. sleep 은 deps 시임이라 실시간 대기도 0(결정적).
 */

const fakeCamera = (): CameraClient =>
  ({
    health: async () => true,
    listCameras: async () => ({ cameras: [] }),
    requestImage: async () => ({ camIdx: 1, presetIdx: 1, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('x') }),
  }) as unknown as CameraClient;
const fakeLpd = (): LpdClient => ({ detect: async () => [] }) as unknown as LpdClient;

const base = {
  roi: [], vpd: null, lpd: null, occupyRange: null, pan: null, tilt: null, zoom: null,
  centered: false, img1: null, updatedAt: null,
};

/** presetCount 프리셋 × slotsPerPreset 슬롯. 전부 slot3dFrontCenter 보유 → 전량 탐색 대상. */
function viewsGrid(presetCount: number, slotsPerPreset: number): SlotSetupView[] {
  const v: SlotSetupView[] = [];
  let slotId = 1;
  for (let p = 1; p <= presetCount; p++) {
    for (let i = 0; i < slotsPerPreset; i++) {
      v.push({
        slotId: slotId++, camId: 1, presetId: p, presetSlotIdx: i + 1, presetKey: `1:${p}`,
        slot3dFrontCenter: { x: 0.3 + i * 0.15, y: 0.5 }, ...base,
      });
    }
  }
  return v;
}

function makeJob(views: SlotSetupView[], found = true) {
  const sleeps: number[] = [];
  const job = new PlateDiscoveryJob({
    camera: fakeCamera(),
    lpd: fakeLpd(),
    store: { getSlotSetup: () => views, upsertSlotLpd: () => {} } as unknown as Pick<SqliteStore, 'getSlotSetup' | 'upsertSlotLpd'>,
    outFile: 'unused.json',
    makeDiscovery: () => ({
      discoverSlot: async (t: DiscoveryTarget): Promise<PlateDiscoveryItem> => ({
        camIdx: t.camIdx, presetIdx: t.presetIdx, slotId: t.slotId, globalIdx: t.globalIdx,
        found, lpdOrig: found ? rectToQuad({ x: 0.4 + (t.presetSlotIdx ?? 1) * 0.1, y: 0.5, w: 0.05, h: 0.03 }) : null,
        tier: 'crop', step: 1, confidence: found ? 0.9 : 0,
        ...(found ? {} : { reason: 'no_plate' as const }),
      }),
    }),
    writer: () => {},
    now: () => 'T',
    sleep: async (ms: number) => { sleeps.push(ms); },
  });
  return { job, sleeps };
}

async function waitDone(job: PlateDiscoveryJob): Promise<void> {
  for (let i = 0; i < 20000 && job.getStatus().state === 'running'; i++) await Promise.resolve();
}

describe('U4. PlateDiscoveryJob 대기 배선 — 지정 시', () => {
  it('betweenSlotMs:500 → 슬롯 N(=6)개에 대해 sleep(500) 정확히 N회', async () => {
    const { job, sleeps } = makeJob(viewsGrid(2, 3));
    expect(job.start({}, { betweenSlotMs: 500 }).total).toBe(6);
    await waitDone(job);
    expect(job.getStatus().state).toBe('done');
    expect(sleeps.filter((ms) => ms === 500)).toHaveLength(6);
    expect(sleeps).toEqual([500, 500, 500, 500, 500, 500]); // occupySettleMs 미지정 → 그 외 sleep 0회.
  });

  it('occupySettleMs:300 → 프리셋 그룹당 1회(2 프리셋 → 2회). 슬롯 수와 무관(Q3)', async () => {
    const { job, sleeps } = makeJob(viewsGrid(2, 3));
    job.start({}, { occupySettleMs: 300 });
    await waitDone(job);
    expect(sleeps).toEqual([300, 300]); // ★ 슬롯 6개지만 300 은 2회뿐 = 프리셋 그룹 단위.
  });

  it('정밀수집 실제 조합(500+300) → 500 이 슬롯수만큼, 300 이 프리셋수만큼, 순서는 전부-500 후 300', async () => {
    const { job, sleeps } = makeJob(viewsGrid(3, 2));
    job.start({}, { betweenSlotMs: 500, occupySettleMs: 300 });
    await waitDone(job);
    expect(sleeps).toEqual([500, 500, 500, 500, 500, 500, 300, 300, 300]);
    // 슬롯 루프(6회 500)가 전부 끝난 뒤 saveSlotLpd 의 프리셋 그룹 대기(3회 300)가 온다.
    expect(sleeps.indexOf(300)).toBe(6);
  });

  it('미검출(found=false) 프리셋은 점유 그룹이 없어 300 대기도 없다(위장 대기 없음)', async () => {
    const { job, sleeps } = makeJob(viewsGrid(2, 3), false);
    job.start({}, { betweenSlotMs: 500, occupySettleMs: 300 });
    await waitDone(job);
    expect(sleeps).toEqual([500, 500, 500, 500, 500, 500]); // 300 은 0회 — found 0 → byPreset 빈 맵.
  });

  it('필터로 대상이 줄면 500 호출도 같이 준다(대상수 = 대기수 동치)', async () => {
    const { job, sleeps } = makeJob(viewsGrid(2, 3));
    expect(job.start({ cam: 1, preset: 2 }, { betweenSlotMs: 500 }).total).toBe(3);
    await waitDone(job);
    expect(sleeps).toEqual([500, 500, 500]);
  });
});

describe('U4. PlateDiscoveryJob 대기 배선 — 미지정 시 회귀 0', () => {
  it('start({}) (수동 /discover/ptz 경로) → sleep 0회', async () => {
    const { job, sleeps } = makeJob(viewsGrid(2, 3));
    job.start({});
    await waitDone(job);
    expect(job.getStatus().state).toBe('done');
    expect(sleeps).toEqual([]); // ★ sleep 코드에 도달조차 하지 않는다.
  });

  it('start({}, {}) 빈 opts 도 0회', async () => {
    const { job, sleeps } = makeJob(viewsGrid(1, 4));
    job.start({}, {});
    await waitDone(job);
    expect(sleeps).toEqual([]);
  });

  it('0 은 falsy → 대기 없음(0ms 스케줄링 오버헤드도 만들지 않는다)', async () => {
    const { job, sleeps } = makeJob(viewsGrid(1, 4));
    job.start({}, { betweenSlotMs: 0, occupySettleMs: 0 });
    await waitDone(job);
    expect(sleeps).toEqual([]);
  });
});
