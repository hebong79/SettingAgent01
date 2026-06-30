import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandPlateTargets, writeSlotPtz } from '../src/calibrate/slotPtzWriter.js';
import { buildSlotPtzJson } from '../src/calibrate/controlMath.js';
import type { SetupArtifact } from '../src/domain/types.js';
import type { SlotPtzItem } from '../src/calibrate/types.js';

/**
 * 검증자(qa-tester): expandPlateTargets(펼침·globalIdx 역참조) + writeSlotPtz(파일 I/O, Repository 비오염).
 */

const rect = (x: number) => ({ x, y: 0.7, w: 0.03, h: 0.02 });

function artifact(): SetupArtifact {
  return {
    createdAt: 'T',
    presets: [],
    globalIndex: [
      { globalIdx: 1, slotId: 'c1p1s1', camIdx: 1, presetIdx: 1 },
      { globalIdx: 2, slotId: 'c1p2s1', camIdx: 1, presetIdx: 2 },
      // c1p1s2 는 globalIndex 에 없음 → null 검증
    ],
    slots: [
      { slotId: 'c1p1s1', zone: 'z', roiByPreset: { '1:1': rect(0.1) }, plateRoiByPreset: { '1:1': rect(0.11) } },
      // 다중 프리셋 키 슬롯 → 키마다 1 항목
      { slotId: 'c1p2s1', zone: 'z', roiByPreset: { '1:2': rect(0.2) }, plateRoiByPreset: { '1:2': rect(0.21), '1:3': rect(0.31) } },
      // plateRoi 없는 슬롯 → 제외
      { slotId: 'c1p1s9', zone: 'z', roiByPreset: { '1:1': rect(0.5) } },
      // globalIndex 미보유 슬롯 → globalIdx null
      { slotId: 'c1p1s2', zone: 'z', roiByPreset: { '1:1': rect(0.3) }, plateRoiByPreset: { '1:1': rect(0.32) } },
    ],
  };
}

describe('expandPlateTargets', () => {
  it('plateRoiByPreset 보유 슬롯·키마다 1 항목, 미보유 제외', () => {
    const t = expandPlateTargets(artifact());
    expect(t).toHaveLength(4); // c1p1s1(1) + c1p2s1(2) + c1p1s2(1)
    const ids = t.map((x) => `${x.slotId}@${x.camIdx}:${x.presetIdx}`);
    expect(ids).toContain('c1p2s1@1:2');
    expect(ids).toContain('c1p2s1@1:3');
    expect(ids).not.toContain('c1p1s9@1:1');
  });

  it('globalIdx 역참조(없으면 null)', () => {
    const t = expandPlateTargets(artifact());
    expect(t.find((x) => x.slotId === 'c1p1s1')!.globalIdx).toBe(1);
    expect(t.find((x) => x.slotId === 'c1p1s2')!.globalIdx).toBeNull();
  });

  it('실 setup_artifact.json → 26 항목(plateRoiByPreset 보유 슬롯 전부)', () => {
    const real = JSON.parse(readFileSync('data/setup_artifact.json', 'utf-8')) as SetupArtifact;
    expect(expandPlateTargets(real)).toHaveLength(26);
  });
});

describe('writeSlotPtz', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('임시 경로에 쓰고 재로드 일치', () => {
    dir = mkdtempSync(join(tmpdir(), 'slotptz-'));
    const out = join(dir, 'sub', 'slot_ptz.json'); // 하위 디렉터리 자동 생성
    const items: SlotPtzItem[] = [
      { camIdx: 1, presetIdx: 1, slotId: 'c1p1s1', globalIdx: 1, ptz: { pan: 1, tilt: 2, zoom: 3 }, plateWidth: 0.2, centered: true, converged: true },
    ];
    writeSlotPtz(buildSlotPtzJson(items, 'NOW'), out);
    const back = JSON.parse(readFileSync(out, 'utf-8'));
    expect(back.createdAt).toBe('NOW');
    expect(back.items).toHaveLength(1);
    expect(back.items[0].ptz.zoom).toBe(3);
  });
});
