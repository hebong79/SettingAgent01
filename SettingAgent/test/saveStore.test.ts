import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SaveStore, defaultSaveName, setupSaveName } from '../src/store/SaveStore.js';
import { logger } from '../src/util/logger.js';
import type { SetupArtifact } from '../src/domain/types.js';

/**
 * 검증자(qa-tester): SaveStore 파일 IO + 파일명 안전화.
 * sanitizeName(traversal/한글/빈값/확장자), save→load 왕복, list 정렬, 없는 이름 load=null, 덮어쓰기.
 */

function artifact(seed = 'a'): SetupArtifact {
  return {
    createdAt: 'T',
    presets: [{ camIdx: 1, presetIdx: 1, label: '1:1', coveredSlotIds: [seed] }],
    slots: [{ slotId: seed, zone: 'z', roiByPreset: { '1:1': { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } } }],
    globalIndex: [{ globalIdx: 1, slotId: seed, camIdx: 1, presetIdx: 1 }],
  };
}

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'savestore-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('SaveStore.sanitizeName', () => {
  const store = new SaveStore('unused');

  it('traversal·경로구분자·빈값·점 → null(차단)', () => {
    expect(store.sanitizeName('../etc/passwd')).toBeNull();
    expect(store.sanitizeName('/abs')).toBeNull();
    expect(store.sanitizeName('a\\b')).toBeNull();
    expect(store.sanitizeName('')).toBeNull();
    expect(store.sanitizeName('   ')).toBeNull();
    expect(store.sanitizeName('..')).toBeNull();
    expect(store.sanitizeName('.')).toBeNull();
    expect(store.sanitizeName(123)).toBeNull();
  });

  it('공백 → 밑줄, 한글 허용', () => {
    expect(store.sanitizeName('내 결과 1')).toBe('내_결과_1');
  });

  it('.json 확장자 제거(중복 방지)', () => {
    expect(store.sanitizeName('x.json')).toBe('x');
    expect(store.sanitizeName('result.JSON')).toBe('result');
  });

  it('허용 외 문자 제거', () => {
    expect(store.sanitizeName('a!@#b$-c_1')).toBe('ab-c_1');
  });
});

describe('SaveStore 파일 IO', () => {
  it('save → load 왕복(동일 객체)', () => {
    const store = new SaveStore(tmp());
    const safe = store.save('내 결과', artifact('s1'));
    expect(safe).toBe('내_결과');
    const loaded = store.load('내 결과');
    expect(loaded).toEqual(artifact('s1'));
  });

  it('save 는 save/{name}.json 파일을 만든다(디렉터리 자동 생성)', () => {
    const dir = tmp();
    const store = new SaveStore(join(dir, 'save'));
    store.save('foo', artifact());
    expect(existsSync(join(dir, 'save', 'foo.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'save', 'foo.json'), 'utf-8')).createdAt).toBe('T');
  });

  it('없는 이름 load → null', () => {
    const store = new SaveStore(tmp());
    expect(store.load('nope')).toBeNull();
  });

  it('잘못된 이름 load → null', () => {
    const store = new SaveStore(tmp());
    expect(store.load('../secret')).toBeNull();
  });

  it('save 안전화 실패 → throw', () => {
    const store = new SaveStore(tmp());
    expect(() => store.save('../x', artifact())).toThrow();
  });

  it('동명 재저장 → 덮어쓰기', () => {
    const store = new SaveStore(tmp());
    store.save('dup', artifact('first'));
    store.save('dup', artifact('second'));
    expect(store.load('dup')?.slots[0].slotId).toBe('second');
    expect(store.list().filter((s) => s.name === 'dup')).toHaveLength(1);
  });

  it('list → 이름·savedAt(mtime 내림차순)', () => {
    const store = new SaveStore(tmp());
    store.save('old', artifact());
    store.save('new', artifact());
    const list = store.list();
    const names = list.map((s) => s.name);
    expect(names).toContain('old');
    expect(names).toContain('new');
    for (const s of list) expect(typeof s.savedAt).toBe('string');
    // mtime 내림차순: 인접 항목이 비오름차순.
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].savedAt >= list[i].savedAt).toBe(true);
    }
  });

  it('폴더 없으면 list → []', () => {
    const store = new SaveStore(join(tmp(), 'nonexistent'));
    expect(store.list()).toEqual([]);
  });
});

describe('SaveStore reports/ 미러 저장', () => {
  // 6.1 미러 저장(핵심): reportsDir 주입 시 save/ 와 reports/ 에 동일 JSON 생성, safe 이름 공유.
  it('reportsDir 주입 → save/{name}.json 과 reports/{name}.json 동일 내용 생성', () => {
    const dir = tmp();
    const saveDir = join(dir, 'save');
    const reportsDir = join(dir, 'reports');
    const store = new SaveStore(saveDir, reportsDir);

    const safe = store.save('foo', artifact('m1'));
    expect(safe).toBe('foo');

    const savePath = join(saveDir, 'foo.json');
    const reportPath = join(reportsDir, 'foo.json');
    expect(existsSync(savePath)).toBe(true);
    expect(existsSync(reportPath)).toBe(true);

    // 파싱 내용 동일.
    const saveJson = JSON.parse(readFileSync(savePath, 'utf-8'));
    const reportJson = JSON.parse(readFileSync(reportPath, 'utf-8'));
    expect(reportJson).toEqual(saveJson);
    expect(reportJson).toEqual(artifact('m1'));
    // 바이트(직렬화 문자열)까지 동일 — 동일 json 을 공유하므로.
    expect(readFileSync(reportPath, 'utf-8')).toBe(readFileSync(savePath, 'utf-8'));
  });

  // 6.5 sanitize 이름 공유: 미러도 안전화된 동일 이름 사용(한글/공백 케이스).
  it('안전화된 동일 이름을 두 경로에 공유(한글/공백)', () => {
    const dir = tmp();
    const saveDir = join(dir, 'save');
    const reportsDir = join(dir, 'reports');
    const store = new SaveStore(saveDir, reportsDir);

    const safe = store.save('내 결과', artifact('m2'));
    expect(safe).toBe('내_결과');
    expect(existsSync(join(saveDir, '내_결과.json'))).toBe(true);
    expect(existsSync(join(reportsDir, '내_결과.json'))).toBe(true);
  });

  // 6.2 하위호환: reportsDir 미주입(생성자 1인자) → save/ 만, reports 미생성.
  it('reportsDir 미주입 → save/ 만 생성, reports 없음(하위호환)', () => {
    const dir = tmp();
    const saveDir = join(dir, 'save');
    const reportsDir = join(dir, 'reports');
    const store = new SaveStore(saveDir); // 1인자 — 미러 생략.

    store.save('foo', artifact());
    expect(existsSync(join(saveDir, 'foo.json'))).toBe(true);
    expect(existsSync(reportsDir)).toBe(false);
  });

  // 6.3 best-effort 실패 무해: reports 쓰기 실패여도 save/ 성공·throw 안 함·logger.warn 호출.
  it('reports 미러 실패 → save() throw 안 함, save/ 정상, logger.warn 1회', () => {
    const dir = tmp();
    const saveDir = join(dir, 'save');
    // reportsDir 의 부모(blocker)를 파일로 만들어 mkdirSync(recursive) 를 결정적으로 실패시킨다(OS 비의존, ENOTDIR).
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x', 'utf-8');
    const reportsDir = join(blocker, 'reports');

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    try {
      const store = new SaveStore(saveDir, reportsDir);
      let safe: string | undefined;
      expect(() => {
        safe = store.save('foo', artifact('best'));
      }).not.toThrow();

      // 정본(save/) 은 정상, safe 반환. reports 는 미생성.
      expect(safe).toBe('foo');
      expect(existsSync(join(saveDir, 'foo.json'))).toBe(true);
      expect(JSON.parse(readFileSync(join(saveDir, 'foo.json'), 'utf-8'))).toEqual(artifact('best'));
      expect(existsSync(reportsDir)).toBe(false);

      // best-effort 관측: logger.warn 정확히 1회.
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ── B-1.7 / R3: saveSnapshot(임의 payload · stringify5 · reports 미러 · sanitize) ──
describe('SaveStore.saveSnapshot(센터라이징 최종 셋업 스냅샷)', () => {
  it('save/{name}.json 에 stringify5 직렬화(수치 소수점 5자리) 기록', () => {
    const dir = tmp();
    const saveDir = join(dir, 'save');
    const store = new SaveStore(saveDir);
    // SetupArtifact 아닌 임의 payload(센터링 병합 뷰 형태) — 6자리 이상 수치는 round5 로 절삭돼야 함.
    const safe = store.saveSnapshot('Setup_20260720_130507', { createdAt: 'T', v: 1.123456789, slots: [{ pan: 9.999999999999995 }] });
    expect(safe).toBe('Setup_20260720_130507');
    const path = join(saveDir, 'Setup_20260720_130507.json');
    expect(existsSync(path)).toBe(true);
    const back = JSON.parse(readFileSync(path, 'utf-8'));
    expect(back.v).toBe(1.12346);      // ★ 5자리 반올림(stringify5)
    expect(back.slots[0].pan).toBe(10); // 9.999999999999995 → round5 → 10
    expect(back.createdAt).toBe('T');
  });

  it('reportsDir 주입 → save/ 와 reports/ 에 동일 바이트 미러', () => {
    const dir = tmp();
    const saveDir = join(dir, 'save');
    const reportsDir = join(dir, 'reports');
    const store = new SaveStore(saveDir, reportsDir);
    store.saveSnapshot('Setup_x', { a: 1, b: [1, 2, 3] });
    const sp = join(saveDir, 'Setup_x.json');
    const rp = join(reportsDir, 'Setup_x.json');
    expect(existsSync(sp)).toBe(true);
    expect(existsSync(rp)).toBe(true);
    expect(readFileSync(rp, 'utf-8')).toBe(readFileSync(sp, 'utf-8')); // 동일 바이트
  });

  it('reportsDir 미주입 → save/ 만(하위호환)', () => {
    const dir = tmp();
    const saveDir = join(dir, 'save');
    const reportsDir = join(dir, 'reports');
    const store = new SaveStore(saveDir); // 1인자
    store.saveSnapshot('Setup_y', { ok: true });
    expect(existsSync(join(saveDir, 'Setup_y.json'))).toBe(true);
    expect(existsSync(reportsDir)).toBe(false);
  });

  it('reports 미러 실패 → throw 안 함, save/ 정상, logger.warn 1회', () => {
    const dir = tmp();
    const saveDir = join(dir, 'save');
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x', 'utf-8'); // 부모를 파일로 → mkdirSync(recursive) ENOTDIR 결정적 실패.
    const reportsDir = join(blocker, 'reports');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    try {
      const store = new SaveStore(saveDir, reportsDir);
      let safe: string | undefined;
      expect(() => { safe = store.saveSnapshot('Setup_z', { n: 3.141592653 }); }).not.toThrow();
      expect(safe).toBe('Setup_z');
      expect(existsSync(join(saveDir, 'Setup_z.json'))).toBe(true);
      expect(JSON.parse(readFileSync(join(saveDir, 'Setup_z.json'), 'utf-8')).n).toBe(3.14159); // round5
      expect(existsSync(reportsDir)).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('sanitize: traversal·경로구분자 이름 → throw(파일 미생성)', () => {
    const store = new SaveStore(tmp());
    expect(() => store.saveSnapshot('../evil', { x: 1 })).toThrow();
    expect(() => store.saveSnapshot('a/b', { x: 1 })).toThrow();
    expect(() => store.saveSnapshot('..', { x: 1 })).toThrow();
  });
});

describe('setupSaveName', () => {
  it('Setup_YYYYMMDD_HHMMSS 포맷(고정 Date)', () => {
    const name = setupSaveName(new Date(2026, 6, 20, 13, 5, 7)); // 2026-07-20 13:05:07 (월 0-based)
    expect(name).toBe('Setup_20260720_130507');
  });

  it('안전화 통과(파일명으로 유효)', () => {
    const store = new SaveStore('unused');
    expect(store.sanitizeName(setupSaveName())).not.toBeNull();
  });
});

describe('defaultSaveName', () => {
  it('result_YYYYMMDD_HHMMSS 포맷', () => {
    const name = defaultSaveName(new Date(2026, 6, 3, 9, 5, 7)); // 2026-07-03 09:05:07 (월 0-based)
    expect(name).toBe('result_20260703_090507');
  });

  it('안전화 통과(파일명으로 유효)', () => {
    const store = new SaveStore('unused');
    expect(store.sanitizeName(defaultSaveName())).not.toBeNull();
  });
});
