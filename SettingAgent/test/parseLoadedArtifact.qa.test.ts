import { describe, it, expect } from 'vitest';
// QA 보강 — 구현자 7케이스가 못 덮는 경계면(최상위 null/개별키 누락/비배열 객체키/공백/제로패딩) 검증.
import { parseLoadedArtifact, defaultResultFilename } from '../web/core.js';

const validArt = {
  presets: [{ camIdx: 1, presetIdx: 1 }],
  slots: [{ slotId: 'c1p1s1', zone: 'A' }],
  globalIndex: [{ globalIdx: 1, slotId: 'c1p1s1', camIdx: 1, presetIdx: 1 }],
};

describe('parseLoadedArtifact — QA 경계면 보강', () => {
  it("최상위 null('null') → ok:false (구현자 케이스 누락분)", () => {
    const r = parseLoadedArtifact('null');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('최상위가 객체가 아닙니다');
  });

  it("최상위 배열('[]') → ok:false, 객체아님 error (Array.isArray 가드)", () => {
    const r = parseLoadedArtifact('[]');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('최상위가 객체가 아닙니다');
  });

  it('presets 누락(slots/globalIndex만) → ok:false', () => {
    const r = parseLoadedArtifact(JSON.stringify({ slots: [], globalIndex: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('presets/slots/globalIndex');
  });

  it('slots 누락(presets/globalIndex만) → ok:false', () => {
    const r = parseLoadedArtifact(JSON.stringify({ presets: [], globalIndex: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('presets/slots/globalIndex');
  });

  it('globalIndex 가 객체(비배열) → ok:false (과도한 관용 차단)', () => {
    const r = parseLoadedArtifact(JSON.stringify({ presets: [], slots: [], globalIndex: {} }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('presets/slots/globalIndex');
  });

  it('presets 가 객체(비배열) → ok:false', () => {
    const r = parseLoadedArtifact(JSON.stringify({ presets: {}, slots: [], globalIndex: [] }));
    expect(r.ok).toBe(false);
  });

  it('slots 가 null → ok:false (null 은 배열 아님)', () => {
    const r = parseLoadedArtifact(JSON.stringify({ presets: [], slots: null, globalIndex: [] }));
    expect(r.ok).toBe(false);
  });

  it('공백만("   ", "\\n\\t") → ok:false (JSON.parse 실패)', () => {
    expect(parseLoadedArtifact('   ').ok).toBe(false);
    expect(parseLoadedArtifact('\n\t').ok).toBe(false);
  });

  it('빈 배열 3키(최소형태) → ok:true (핵심 3배열만 강제·과엄격 아님)', () => {
    const r = parseLoadedArtifact(JSON.stringify({ presets: [], slots: [], globalIndex: [] }));
    expect(r.ok).toBe(true);
  });

  it('정상 artifact → 원형(참조 동일 객체) 보존', () => {
    const r = parseLoadedArtifact(JSON.stringify(validArt));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.artifact).toEqual(validArt);
      // 추가 필드도 보존(관용) — createdAt 등 통과.
    }
  });

  it('추가 최상위 필드(createdAt/warnings) 있어도 통과·보존', () => {
    const withExtra = { ...validArt, createdAt: '2026-07-03T00:00:00Z', warnings: [] };
    const r = parseLoadedArtifact(JSON.stringify(withExtra));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.artifact.createdAt).toBe('2026-07-03T00:00:00Z');
  });
});

describe('defaultResultFilename — QA 제로패딩·결정성 보강', () => {
  it('제로패딩: 한 자리 월/일/시/분/초 → 각 2자리', () => {
    // 2026-01-05 04:03:09 (month 0-based: 0 = 1월)
    expect(defaultResultFilename(new Date(2026, 0, 5, 4, 3, 9))).toBe('setup_20260105_040309.json');
  });

  it('제로패딩: 자정·초 0 → 00', () => {
    expect(defaultResultFilename(new Date(2025, 11, 1, 0, 0, 0))).toBe('setup_20251201_000000.json');
  });

  it('두 자리 경계(12월/31일/23시/59분/59초) 그대로', () => {
    expect(defaultResultFilename(new Date(2024, 11, 31, 23, 59, 59))).toBe('setup_20241231_235959.json');
  });

  it('주입 date 결정성: 동일 입력 → 동일 출력', () => {
    const d = new Date(2026, 6, 3, 18, 30, 52);
    expect(defaultResultFilename(d)).toBe(defaultResultFilename(d));
    expect(defaultResultFilename(d)).toBe('setup_20260703_183052.json');
  });

  it('무인자 결과가 형식 정규식 준수', () => {
    expect(defaultResultFilename()).toMatch(/^setup_\d{8}_\d{6}\.json$/);
  });
});
