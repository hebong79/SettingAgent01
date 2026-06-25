import { describe, it, expect } from 'vitest';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { CapturedImage, SetupArtifact, VehicleBox } from '../src/domain/types.js';
import type { SetupBrain, Stage1Result, Stage2Result, Stage3Result } from '../src/brain/SetupBrain.js';

const vb = (x: number, y: number): VehicleBox => ({ rect: { x, y, w: 0.1, h: 0.1 }, confidence: 0.9, cls: 'car' });

function fakeCamera(): CameraClient {
  return {
    requestImage: async (camIdx: number, presetIdx: number): Promise<CapturedImage> => ({
      camIdx, presetIdx, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('img'),
    }),
  } as unknown as CameraClient;
}
function fakeVpd(perCall: VehicleBox[][]): VpdClient {
  let i = 0;
  return { detect: async () => perCall[i++] ?? [] } as unknown as VpdClient;
}
function fakeRepo(): { repo: Repository; saved: SetupArtifact[] } {
  const saved: SetupArtifact[] = [];
  return { saved, repo: { saveArtifact: (a: SetupArtifact) => saved.push(a), loadArtifact: () => saved.at(-1) ?? null, path: 'mem' } as unknown as Repository };
}

const setupCfg = {
  presetSettleMs: 0, betweenPresetMs: 0, minConfidence: 0.5, roiPadding: 0, yBandTolerance: 0.1,
  accumFrames: 1, accumIntervalMs: 0, clusterDist: 0.06, clusterMinSupport: 1, lpdEnabled: false,
};

/** 게이트 동작을 캔드 결과로 시뮬레이션하는 가짜 두뇌. */
function fakeBrain(): SetupBrain {
  return {
    enabled: true,
    // preset1: 3박스 중 3번 제외 → 2슬롯. preset2: 1박스 유지.
    async judgePreset(input): Promise<Stage1Result> {
      if (input.presetIdx === 1) {
        return { validBoxes: [1, 2], excluded: [{ box: 3, reason: '잘림' }], orderOk: true, rescan: { needed: false, reason: '' }, confidence: 0.9 };
      }
      return { validBoxes: [1], excluded: [], orderOk: true, rescan: { needed: false, reason: '' }, confidence: 0.9 };
    },
    // c1p2s1 을 c1p1s2 와 동일 물리면으로 병합, c1p1s1 라벨.
    async dedupeAndLabel(): Promise<Stage2Result> {
      return { duplicates: [['c1p1s2', 'c1p2s1']], zoneLabels: { c1p1s1: 'A-01' }, notes: '' };
    },
    async finalReport(): Promise<Stage3Result> {
      return { approved: true, totalSlots: 2, globalCount: 2, mismatches: [], report_ko: '설치 리포트 본문', confidence: 0.95 };
    },
  };
}

describe('SetupOrchestrator + 전략C 게이트(fake brain)', () => {
  it('게이트1 제외 → 게이트2 병합/라벨 → 게이트3 리포트', async () => {
    const { repo, saved } = fakeRepo();
    const orch = new SetupOrchestrator({
      camera: fakeCamera(),
      vpd: fakeVpd([[vb(0.2, 0.1), vb(0.5, 0.1), vb(0.9, 0.1)], [vb(0.3, 0.5)]]),
      repo,
      cfg: setupCfg,
      brain: fakeBrain(),
      sleep: async () => {},
      now: () => 'T',
    });

    const artifact = await orch.run([{ camIdx: 1, presetIdx: 1 }, { camIdx: 1, presetIdx: 2 }]);

    // 게이트1: preset1 3→2박스. preset2 1박스. = c1p1s1,c1p1s2,c1p2s1
    // 게이트2: c1p2s1 병합 제거 → 슬롯 2개 남음
    expect(artifact.slots.map((s) => s.slotId).sort()).toEqual(['c1p1s1', 'c1p1s2']);
    // 존 라벨 적용
    expect(artifact.slots.find((s) => s.slotId === 'c1p1s1')!.zone).toBe('A-01');
    // 전역 인덱스도 병합 반영(2개)
    expect(artifact.globalIndex).toHaveLength(2);
    // 게이트3 리포트
    expect(artifact.report).toBe('설치 리포트 본문');
    // 경고: 제외 + 병합 기록
    expect(artifact.warnings?.some((w) => w.includes('제외'))).toBe(true);
    expect(artifact.warnings?.some((w) => w.includes('병합'))).toBe(true);
    expect(saved).toHaveLength(1);
  });

  it('brain 미주입 시 결정형 경로 그대로(게이트 없음)', async () => {
    const { repo } = fakeRepo();
    const orch = new SetupOrchestrator({
      camera: fakeCamera(),
      vpd: fakeVpd([[vb(0.2, 0.1), vb(0.5, 0.1), vb(0.9, 0.1)]]),
      repo,
      cfg: setupCfg,
      sleep: async () => {},
      now: () => 'T',
    });
    const artifact = await orch.run([{ camIdx: 1, presetIdx: 1 }]);
    expect(artifact.slots).toHaveLength(3); // 제외 없음
    expect(artifact.report).toBeUndefined();
  });
});
