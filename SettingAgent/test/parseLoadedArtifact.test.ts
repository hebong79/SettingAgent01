import { describe, it, expect } from 'vitest';
// 순수 ESM 모듈(브라우저 API 미참조) 직접 import.
import { parseLoadedArtifact, defaultResultFilename } from '../web/core.js';

describe('parseLoadedArtifact (로컬 결과 파일 파싱·최소형태검증)', () => {
  it('정상 SetupArtifact → ok:true, artifact 보존', () => {
    const art = {
      presets: [{ camIdx: 1, presetIdx: 1 }],
      slots: [{ slotId: 'c1p1s1', zone: 'A' }],
      globalIndex: [{ globalIdx: 1, slotId: 'c1p1s1', camIdx: 1, presetIdx: 1 }],
    };
    const r = parseLoadedArtifact(JSON.stringify(art));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.artifact.slots).toEqual(art.slots);
      expect(r.artifact.globalIndex).toEqual(art.globalIndex);
    }
  });

  it("깨진 JSON('{', 'not json') → ok:false", () => {
    expect(parseLoadedArtifact('{').ok).toBe(false);
    expect(parseLoadedArtifact('not json').ok).toBe(false);
  });

  it('최상위가 객체 아님(배열/숫자/문자열) → ok:false', () => {
    expect(parseLoadedArtifact('[]').ok).toBe(false);
    expect(parseLoadedArtifact('42').ok).toBe(false);
    expect(parseLoadedArtifact('"x"').ok).toBe(false);
  });

  it('배열 필드 누락(globalIndex 없음) → ok:false', () => {
    const r = parseLoadedArtifact(JSON.stringify({ presets: [], slots: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('presets/slots/globalIndex');
  });

  it('빈 문자열 → ok:false', () => {
    expect(parseLoadedArtifact('').ok).toBe(false);
  });
});

describe('defaultResultFilename (저장 대화상자 제안 파일명)', () => {
  it('고정 Date 주입 → setup_YYYYMMDD_HHmmss.json', () => {
    // month 는 0-based: 6 = 7월.
    expect(defaultResultFilename(new Date(2026, 6, 3, 18, 30, 52))).toBe('setup_20260703_183052.json');
  });

  it('무인자 → 정규식 매칭', () => {
    expect(defaultResultFilename()).toMatch(/^setup_\d{8}_\d{6}\.json$/);
  });
});
