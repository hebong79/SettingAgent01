// V9 — 파괴 방지 정적 봉인(설계 §6, R5).
//
// R5 를 "직접 호출"이 아니라 **"호출하지 않음"** 으로 만족시킨다 — 더 강하다.
// `roi.auto.apply` 는 정본 파일만 쓰고 DB 반영은 기존 `slot.roi.sync`(유일한 `updateSlotRoiGeometry` 호출자)에 위임한다.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROI_AUTO = 'src/rpc/services/roiAuto.ts';

/** src 전역의 .ts 파일. */
function allSources(dir = 'src'): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...allSources(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('roi.auto 파괴 방지 봉인', () => {
  it('roiAuto 는 DB 쓰기 경로를 신설하지 않는다', () => {
    const src = readFileSync(ROI_AUTO, 'utf8');
    for (const sym of ['replaceSlotSetup', 'SqliteStore', 'updateSlotRoiGeometry']) {
      expect(src.includes(sym), `${ROI_AUTO} 가 "${sym}" 를 참조한다 — DB 쓰기 경로 신설(R5 위반)`).toBe(false);
    }
  });

  it('roiAuto 는 store deps 를 쓰지 않는다', () => {
    const src = readFileSync(ROI_AUTO, 'utf8');
    expect(src).not.toContain('ctx.deps.store');
  });

  /**
   * 실제 호출부(`.name(` — 스토어 인스턴스에 대한 메서드 호출)만 센다.
   * 주석의 언급(`Finalizer.replaceSlotSetup 미호출` · `replaceSlotSetup(DELETE+INSERT)`)은 호출이 아니다.
   * 정의처 SqliteStore.ts 는 제외.
   */
  function callSitesOf(name: string): string[] {
    return allSources()
      .filter((f) => !f.endsWith('SqliteStore.ts'))
      .filter((f) => readFileSync(f, 'utf8').includes(`.${name}(`))
      .map((f) => f.replace(/\\/g, '/'))
      .sort();
  }

  it('replaceSlotSetup 호출자는 여전히 3곳이다', () => {
    expect(callSitesOf('replaceSlotSetup')).toEqual([
      'src/capture/Finalizer.ts',
      'src/capture/roiDbLoad.ts',
      'src/tools/migrateToSettingDb.ts',
    ]);
  });

  it('updateSlotRoiGeometry 호출자는 roiSlotSync.ts 하나뿐이다', () => {
    expect(callSitesOf('updateSlotRoiGeometry')).toEqual(['src/capture/roiSlotSync.ts']);
  });

  it('apply 는 정본 쓰기 전에 assertAutoPromoteSafe 와 백업을 거친다', () => {
    const src = readFileSync(ROI_AUTO, 'utf8');
    expect(src).toContain('assertAutoPromoteSafe');
    expect(src).toContain('backupPlaceRoiPathOf');
    // R7 — 영속화는 stringify5 경로만.
    expect(src).toContain('stringify5(json, 2)');
    const gateAt = src.indexOf('assertAutoPromoteSafe(json');
    const writeAt = src.indexOf('stringify5(json, 2)');
    expect(gateAt).toBeGreaterThan(0);
    expect(writeAt).toBeGreaterThan(gateAt);
  });

  it('기존 grid.* 웹 흐름은 무접촉이다(R6)', () => {
    const methods = readFileSync('src/rpc/methods.ts', 'utf8');
    for (const name of ['grid.bootstrap', 'grid.apply', 'grid.get']) {
      expect(methods).toContain(`name: '${name}'`);
    }
    // grid.* 는 여전히 http 위임이며 handler 로 바뀌지 않았다.
    expect(methods).toContain("url: '/capture/ground-grid/bootstrap'");
    expect(methods).toContain("url: '/capture/ground-grid/apply'");
  });
});
