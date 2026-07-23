import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remapSlotPtz, renumberSlotPtzFile } from '../src/calibrate/slotPtzRenumber.js';
import type { SlotPtzArtifact } from '../src/calibrate/types.js';

/**
 * 검증자(qa): slot_ptz.json 재번호 리맵(설계서 §3).
 * remapSlotPtz(순수): slotId/globalIdx 리맵·plateWidth/converged/ptz 보존·new asc 정렬·미커버 무변.
 * renumberSlotPtzFile: 파일 왕복 반영·부재 skip 무예외.
 */

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const artifact = (): SlotPtzArtifact => ({
  createdAt: '2026-07-23T00:00:00.000Z',
  items: [
    { camIdx: 1, presetIdx: 1, slotId: '1', globalIdx: 1, ptz: { pan: 10, tilt: 5, zoom: 3 }, plateWidth: 0.12, centered: true, converged: true },
    { camIdx: 1, presetIdx: 2, slotId: '2', globalIdx: 2, ptz: { pan: 20, tilt: 6, zoom: 4 }, plateWidth: 0.15, centered: false, converged: true, reason: 'x' },
  ],
});

describe('remapSlotPtz', () => {
  it('순열 리맵 후 slotId/globalIdx new & plateWidth/converged/ptz 보존 & new asc 정렬', () => {
    const out = remapSlotPtz(artifact(), new Map([[1, 2], [2, 1]]));
    expect(out.createdAt).toBe('2026-07-23T00:00:00.000Z');
    // new asc 정렬 → globalIdx 1 이 먼저.
    expect(out.items.map((i) => i.globalIdx)).toEqual([1, 2]);
    const first = out.items[0]; // new id 1 = 원래 slot 2
    expect(first.slotId).toBe('1');
    expect(first.globalIdx).toBe(1);
    expect(first.plateWidth).toBe(0.15);
    expect(first.converged).toBe(true);
    expect(first.centered).toBe(false);
    expect(first.ptz).toEqual({ pan: 20, tilt: 6, zoom: 4 });
    expect(first.reason).toBe('x');
    const second = out.items[1]; // new id 2 = 원래 slot 1
    expect(second.slotId).toBe('2');
    expect(second.plateWidth).toBe(0.12);
    expect(second.ptz).toEqual({ pan: 10, tilt: 5, zoom: 3 });
  });

  it('idMap 미포함 항목은 변경 없이 유지', () => {
    const out = remapSlotPtz(artifact(), new Map([[1, 3]]));
    const kept = out.items.find((i) => i.slotId === '2')!;
    expect(kept.globalIdx).toBe(2); // 미커버 → 원본 유지
    const moved = out.items.find((i) => i.slotId === '3')!;
    expect(moved.globalIdx).toBe(3);
  });
});

describe('renumberSlotPtzFile', () => {
  it('파일 왕복 후 내용에 new 반영', () => {
    dir = mkdtempSync(join(tmpdir(), 'slotptz-'));
    const outFile = join(dir, 'slot_ptz.json');
    writeFileSync(outFile, JSON.stringify(artifact()), 'utf-8');

    const res = renumberSlotPtzFile(outFile, new Map([[1, 2], [2, 1]]));
    expect(res).toBe('written');

    const parsed = JSON.parse(readFileSync(outFile, 'utf-8')) as SlotPtzArtifact;
    expect(parsed.items.map((i) => i.globalIdx)).toEqual([1, 2]);
    expect(parsed.items[0].slotId).toBe('1');
    expect(parsed.items[0].plateWidth).toBe(0.15); // 보존
  });

  it('파일 부재 → skipped(무예외)', () => {
    dir = mkdtempSync(join(tmpdir(), 'slotptz-'));
    const outFile = join(dir, 'nope.json');
    let res: 'written' | 'skipped' = 'written';
    expect(() => { res = renumberSlotPtzFile(outFile, new Map([[1, 1]])); }).not.toThrow();
    expect(res).toBe('skipped');
  });

  it('파싱 실패 → skipped(무예외)', () => {
    dir = mkdtempSync(join(tmpdir(), 'slotptz-'));
    const outFile = join(dir, 'bad.json');
    writeFileSync(outFile, '{ not json', 'utf-8');
    let res: 'written' | 'skipped' = 'written';
    expect(() => { res = renumberSlotPtzFile(outFile, new Map([[1, 1]])); }).not.toThrow();
    expect(res).toBe('skipped');
  });
});
