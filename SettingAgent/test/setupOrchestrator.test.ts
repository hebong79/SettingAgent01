import { describe, it, expect } from 'vitest';
import { SetupOrchestrator, type SetupTarget } from '../src/setup/SetupOrchestrator.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { LpdClient, PlateBox } from '../src/clients/LpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { CapturedImage, SetupArtifact, VehicleBox } from '../src/domain/types.js';
import { rectToQuad } from '../src/domain/geometry.js';

const vb = (x: number, y: number): VehicleBox => ({ rect: { x, y, w: 0.1, h: 0.1 }, confidence: 0.9, cls: 'car' });

function fakeCamera(): CameraClient {
  return {
    requestImage: async (camIdx: number, presetIdx: number): Promise<CapturedImage> => ({
      camIdx,
      presetIdx,
      pan: 10,
      tilt: 5,
      zoom: 2,
      imgName: `c${camIdx}p${presetIdx}.jpg`,
      jpg: Buffer.from('fake'),
    }),
  } as unknown as CameraClient;
}

/** 프리셋별 검출 결과를 큐로 반환하는 가짜 VPD. */
function fakeVpd(perCall: VehicleBox[][]): VpdClient {
  let i = 0;
  return { detect: async () => perCall[i++] ?? [] } as unknown as VpdClient;
}

function fakeRepo(): { repo: Repository; saved: SetupArtifact[] } {
  const saved: SetupArtifact[] = [];
  const repo = {
    saveArtifact: (a: SetupArtifact) => saved.push(a),
    loadArtifact: () => saved[saved.length - 1] ?? null,
    path: 'mem',
  } as unknown as Repository;
  return { repo, saved };
}

const setupCfg = {
  presetSettleMs: 0,
  betweenPresetMs: 0,
  minConfidence: 0.5,
  roiPadding: 0,
  yBandTolerance: 0.1,
  accumFrames: 1,
  accumIntervalMs: 0,
  clusterDist: 0.06,
  clusterMinSupport: 1,
  lpdEnabled: false,
};

describe('SetupOrchestrator', () => {
  it('프리셋 순회→ROI→전역인덱스→저장', async () => {
    const { repo, saved } = fakeRepo();
    const orch = new SetupOrchestrator({
      camera: fakeCamera(),
      // 프리셋1: 2대(윗줄 좌우), 프리셋2: 1대
      vpd: fakeVpd([[vb(0.6, 0.1), vb(0.2, 0.1)], [vb(0.4, 0.5)]]),
      repo,
      cfg: setupCfg,
      sleep: async () => {},
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const targets: SetupTarget[] = [
      { camIdx: 1, presetIdx: 1 },
      { camIdx: 1, presetIdx: 2 },
    ];
    const artifact = await orch.run(targets);

    expect(orch.getStatus().state).toBe('DONE');
    expect(artifact.presets).toHaveLength(2);
    expect(artifact.slots).toHaveLength(3);
    expect(artifact.globalIndex).toHaveLength(3);
    // 전역 순서: c1p1s1, c1p1s2, c1p2s1
    expect(artifact.globalIndex.map((g) => g.slotId)).toEqual(['c1p1s1', 'c1p1s2', 'c1p2s1']);
    // 프리셋1 첫 슬롯 ROI 는 좌측(x=0.2)
    const p1s1 = artifact.slots.find((s) => s.slotId === 'c1p1s1')!;
    expect(p1s1.roiByPreset['1:1'].x).toBeCloseTo(0.2);
    // 프리셋 PTZ 보관
    expect(artifact.presets[0].pan).toBe(10);
    // 저장 1회
    expect(saved).toHaveLength(1);
  });

  it('검출 0대 프리셋도 안전(슬롯 없음)', async () => {
    const { repo } = fakeRepo();
    const orch = new SetupOrchestrator({
      camera: fakeCamera(),
      vpd: fakeVpd([[]]),
      repo,
      cfg: setupCfg,
      sleep: async () => {},
      now: () => 'T',
    });
    const artifact = await orch.run([{ camIdx: 3, presetIdx: 1 }]);
    expect(artifact.slots).toHaveLength(0);
    expect(artifact.presets[0].coveredSlotIds).toEqual([]);
    expect(orch.getStatus().state).toBe('DONE');
  });

  it('accumFrames>1 누적 모드: 다프레임 캡처+클러스터링', async () => {
    const { repo } = fakeRepo();
    let imgCalls = 0;
    const camera = {
      requestImage: async (c: number, p: number) => {
        imgCalls++;
        return { camIdx: c, presetIdx: p, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('f') };
      },
    } as unknown as CameraClient;
    // 3프레임 모두 같은 1대(약간 흔들림) → 1슬롯
    const orch = new SetupOrchestrator({
      camera,
      vpd: fakeVpd([[vb(0.3, 0.3)], [vb(0.31, 0.29)], [vb(0.305, 0.3)]]),
      repo,
      cfg: { ...setupCfg, accumFrames: 3, clusterMinSupport: 2 },
      sleep: async () => {},
      now: () => 'T',
    });
    const artifact = await orch.run([{ camIdx: 1, presetIdx: 1 }]);
    // 초기 1 + 누적 2 = 3회 캡처
    expect(imgCalls).toBe(3);
    expect(artifact.slots).toHaveLength(1);
    expect(orch.getStatus().state).toBe('DONE');
  });

  it('expectedFaces 교차검증: 기대≠검출 이면 경고 기록', async () => {
    const { repo } = fakeRepo();
    const orch = new SetupOrchestrator({
      camera: fakeCamera(),
      vpd: fakeVpd([[vb(0.2, 0.1), vb(0.6, 0.1)]]), // 2대 검출
      repo,
      cfg: setupCfg,
      sleep: async () => {},
      now: () => 'T',
    });
    // 기대 3, 검출 2 → 경고
    const artifact = await orch.run([{ camIdx: 1, presetIdx: 1 }], { '1:1': 3 });
    expect(artifact.warnings).toBeDefined();
    expect(artifact.warnings![0]).toContain('1:1');
  });

  it('expectedFaces 일치 시 경고 없음', async () => {
    const { repo } = fakeRepo();
    const orch = new SetupOrchestrator({
      camera: fakeCamera(),
      vpd: fakeVpd([[vb(0.2, 0.1), vb(0.6, 0.1)]]),
      repo,
      cfg: setupCfg,
      sleep: async () => {},
      now: () => 'T',
    });
    const artifact = await orch.run([{ camIdx: 1, presetIdx: 1 }], { '1:1': 2 });
    expect(artifact.warnings).toBeUndefined();
  });

  it('lpdEnabled: 번호판 ROI 를 슬롯에 저장(plateRoiByPreset)', async () => {
    const { repo } = fakeRepo();
    const plate: PlateBox = { quad: rectToQuad({ x: 0.22, y: 0.12, w: 0.04, h: 0.02 }), confidence: 0.95, cls: 'car_license_plate' };
    const lpd = { detect: async () => [plate] } as unknown as LpdClient;
    const orch = new SetupOrchestrator({
      camera: fakeCamera(),
      vpd: fakeVpd([[vb(0.2, 0.1)]]), // 차량 ROI(0.2~0.3,0.1~0.2) 안에 번호판 중심(0.24,0.13)
      lpd,
      repo,
      cfg: { ...setupCfg, lpdEnabled: true },
      sleep: async () => {},
      now: () => 'T',
    });
    const artifact = await orch.run([{ camIdx: 1, presetIdx: 1 }]);
    const slot = artifact.slots.find((s) => s.slotId === 'c1p1s1')!;
    // 저장은 실 OBB quad(방향 보존). 축정렬 fixture → rectToQuad 와 동일.
    expect(slot.plateRoiByPreset?.['1:1']).toEqual(rectToQuad({ x: 0.22, y: 0.12, w: 0.04, h: 0.02 }));
  });

  it('lpdEnabled=false 면 번호판 ROI 미저장', async () => {
    const { repo } = fakeRepo();
    const lpd = { detect: async () => [] } as unknown as LpdClient;
    const orch = new SetupOrchestrator({
      camera: fakeCamera(),
      vpd: fakeVpd([[vb(0.2, 0.1)]]),
      lpd,
      repo,
      cfg: setupCfg, // lpdEnabled:false
      sleep: async () => {},
      now: () => 'T',
    });
    const artifact = await orch.run([{ camIdx: 1, presetIdx: 1 }]);
    expect(artifact.slots[0].plateRoiByPreset).toBeUndefined();
  });

  it('카메라 오류 시 FAILED 로 전이하고 throw', async () => {
    const { repo } = fakeRepo();
    const badCamera = { requestImage: async () => { throw new Error('cam down'); } } as unknown as CameraClient;
    const orch = new SetupOrchestrator({
      camera: badCamera,
      vpd: fakeVpd([]),
      repo,
      cfg: setupCfg,
      sleep: async () => {},
      now: () => 'T',
    });
    await expect(orch.run([{ camIdx: 1, presetIdx: 1 }])).rejects.toThrow('cam down');
    expect(orch.getStatus().state).toBe('FAILED');
    expect(orch.getStatus().error).toContain('cam down');
  });
});
