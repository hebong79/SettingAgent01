import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../src/store/Repository.js';
import { rectToQuad } from '../src/domain/geometry.js';
import type { SetupArtifact } from '../src/domain/types.js';

/**
 * 검증자(qa-tester): Repository 하위호환 — 구데이터 plateRoiByPreset(rect) → quad 승격 (설계 케이스 11).
 * 구 setup_artifact.json(plateRoiByPreset=rect)을 로드하면 크래시 없이 축정렬 quad 로 승격돼야 한다.
 */

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function repoWith(json: unknown): Repository {
  dir = mkdtempSync(join(tmpdir(), 'repo-'));
  writeFileSync(join(dir, 'setup_artifact.json'), JSON.stringify(json), 'utf-8');
  return new Repository(dir);
}

describe('Repository.loadArtifact 구데이터 rect→quad 승격', () => {
  it('구 rect plateRoiByPreset → 축정렬 quad(4점) 로 승격(크래시 없음)', () => {
    // 구데이터: plateRoiByPreset 값이 {x,y,w,h} rect.
    const legacy = {
      createdAt: 'T',
      presets: [],
      globalIndex: [],
      slots: [
        { slotId: 'c1p1s1', zone: 'z', roiByPreset: { '1:1': { x: 0.6, y: 0.6, w: 0.1, h: 0.05 } }, plateRoiByPreset: { '1:1': { x: 0.11, y: 0.7, w: 0.03, h: 0.02 } } },
      ],
    };
    const repo = repoWith(legacy);
    const art = repo.loadArtifact()!;
    const val = art.slots[0].plateRoiByPreset!['1:1'];
    // 로드 후 축정렬 quad(배열 4점). rect 였던 값이 rectToQuad 로 승격.
    expect(Array.isArray(val)).toBe(true);
    expect(val).toEqual(rectToQuad({ x: 0.11, y: 0.7, w: 0.03, h: 0.02 }));
  });

  it('신 quad plateRoiByPreset → 무변경(이미 4점 배열)', () => {
    const quad = rectToQuad({ x: 0.11, y: 0.7, w: 0.03, h: 0.02 });
    const modern: SetupArtifact = {
      createdAt: 'T',
      presets: [],
      globalIndex: [],
      slots: [
        { slotId: 'c1p1s1', zone: 'z', roiByPreset: { '1:1': { x: 0.6, y: 0.6, w: 0.1, h: 0.05 } }, plateRoiByPreset: { '1:1': quad } },
      ],
    };
    const repo = repoWith(modern);
    const art = repo.loadArtifact()!;
    expect(art.slots[0].plateRoiByPreset!['1:1']).toEqual(quad);
  });

  it('plateRoiByPreset 부재 슬롯 → 크래시 없음', () => {
    const repo = repoWith({
      createdAt: 'T', presets: [], globalIndex: [],
      slots: [{ slotId: 'c1p1s1', zone: 'z', roiByPreset: { '1:1': { x: 0.6, y: 0.6, w: 0.1, h: 0.05 } } }],
    });
    expect(() => repo.loadArtifact()).not.toThrow();
    expect(repo.loadArtifact()!.slots[0].plateRoiByPreset).toBeUndefined();
  });

  it('파일 없음 → null', () => {
    dir = mkdtempSync(join(tmpdir(), 'repo-'));
    const repo = new Repository(dir);
    expect(repo.loadArtifact()).toBeNull();
  });
});
