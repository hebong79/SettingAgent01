import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandPlateTargets, writeSlotPtz } from '../src/calibrate/slotPtzWriter.js';
import { buildSlotPtzJson } from '../src/calibrate/controlMath.js';
import { Repository } from '../src/store/Repository.js';
import type { SetupArtifact } from '../src/domain/types.js';
import { rectToQuad, quadBoundingRect } from '../src/domain/geometry.js';
import type { SlotPtzItem } from '../src/calibrate/types.js';

/**
 * 검증자(qa-tester): expandPlateTargets(펼침·globalIdx 역참조) + writeSlotPtz(파일 I/O, Repository 비오염).
 */

const rect = (x: number) => ({ x, y: 0.7, w: 0.03, h: 0.02 });
/** plateRoiByPreset 는 신 계약상 quad(OBB 4점). 축정렬 fixture 는 rectToQuad 로 생성. */
const pquad = (x: number) => rectToQuad(rect(x));

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
      { slotId: 'c1p1s1', zone: 'z', roiByPreset: { '1:1': rect(0.1) }, plateRoiByPreset: { '1:1': pquad(0.11) } },
      // 다중 프리셋 키 슬롯 → 키마다 1 항목
      { slotId: 'c1p2s1', zone: 'z', roiByPreset: { '1:2': rect(0.2) }, plateRoiByPreset: { '1:2': pquad(0.21), '1:3': pquad(0.31) } },
      // plateRoi 없는 슬롯 → 제외
      { slotId: 'c1p1s9', zone: 'z', roiByPreset: { '1:1': rect(0.5) } },
      // globalIndex 미보유 슬롯 → globalIdx null
      { slotId: 'c1p1s2', zone: 'z', roiByPreset: { '1:1': rect(0.3) }, plateRoiByPreset: { '1:1': pquad(0.32) } },
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

  it('quad plateRoiByPreset → plateRoi(축정렬 rect) 유도(설계 케이스 12)', () => {
    // plateRoi 는 캘리브레이션 내부 math 용 축정렬 rect. quad(pquad(0.11)) → quadBoundingRect 와 동일해야 함.
    const t = expandPlateTargets(artifact());
    const tgt = t.find((x) => x.slotId === 'c1p1s1')!;
    expect(tgt.plateRoi).toEqual(quadBoundingRect(pquad(0.11)));
    // 축정렬 fixture → 원 rect 로 왕복(부동소수 오차 허용).
    const r = rect(0.11);
    expect(tgt.plateRoi.x).toBeCloseTo(r.x);
    expect(tgt.plateRoi.y).toBeCloseTo(r.y);
    expect(tgt.plateRoi.w).toBeCloseTo(r.w);
    expect(tgt.plateRoi.h).toBeCloseTo(r.h);
  });

  it('실 setup_artifact.json → plateRoiByPreset 키 수와 정확히 일치(보유 슬롯·키 전부 펼침)', () => {
    // 실 산출물은 정밀수집 재최종화마다 슬롯 수가 바뀌고 빈 산출물(0 슬롯)일 수도 있는 런타임 파일이다.
    // 따라서 고정 개수/최소량을 단언하지 않고, expandPlateTargets 가 "plate 키마다 1 항목"이라는
    // 계약만 산출물 자체에서 도출해 검증한다(데이터량 비의존 — 0이면 0).
    // ★ 경계면(하위호환): 프로덕션 경로(PtzCalibrator)는 Repository.loadArtifact() 로 로드 → 구데이터
    //   rect plateRoiByPreset 를 quad 로 승격한 뒤 expandPlateTargets 에 넘긴다. 실 파일이 구 rect
    //   형태여도 크래시 없이 quadBoundingRect 유도가 가능해야 하므로 동일 경로(Repository)로 로드한다.
    const real = new Repository('data').loadArtifact();
    if (!real) return; // 파일 없으면 스킵(런타임 산출물).
    const expected = (real.slots ?? []).reduce((n, s) => n + Object.keys(s.plateRoiByPreset ?? {}).length, 0);
    expect(expandPlateTargets(real)).toHaveLength(expected);
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
