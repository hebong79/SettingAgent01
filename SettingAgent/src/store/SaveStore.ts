import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupArtifact } from '../domain/types.js';
import { logger } from '../util/logger.js';
import { stringify5 } from '../util/round.js';

/**
 * 정밀수집 결과 스냅샷(save/ 폴더)의 파일 IO 담당(Repository 미러).
 * 파일명 안전화(경로 traversal 차단·`.json` 강제)의 권위 소유. 라우트는 위임만.
 */
export class SaveStore {
  constructor(private saveDir: string, private reportsDir?: string) {}

  /**
   * 파일명 안전화. 허용 `[A-Za-z0-9가-힣_-]`(+공백→`_`). 그 외 문자 제거.
   * 빈 문자열·`.`·`..`·경로 구분자(`/ \`)는 차단(null). 반환은 확장자 없는 안전 base 이름.
   * 입력에 `.json` 이 있으면 제거해 중복 확장자를 방지한다.
   */
  sanitizeName(input: unknown): string | null {
    if (typeof input !== 'string') return null;
    let s = input.trim();
    if (!s) return null;
    s = s.replace(/\.json$/i, ''); // 중복 확장자 방지.
    if (s === '.' || s === '..' || /[/\\]/.test(s)) return null; // traversal·경로구분자 차단.
    s = s.replace(/\s+/g, '_'); // 공백 → 밑줄.
    s = s.replace(/[^A-Za-z0-9가-힣_-]/g, ''); // 허용 외 문자 제거.
    if (!s || s === '.' || s === '..') return null;
    return s;
  }

  /**
   * artifact 를 `save/{name}.json` 으로 저장(디렉터리 자동 생성, 동명 덮어쓰기). 안전화 실패 시 throw.
   * reportsDir 주입 시 동일 JSON 을 `reports/{name}.json` 에 best-effort 미러(실패는 격리·로그만).
   */
  save(name: string, artifact: SetupArtifact): string {
    const safe = this.sanitizeName(name);
    if (!safe) throw new Error(`invalid save name: ${name}`);
    const json = stringify5(artifact, 2);
    mkdirSync(this.saveDir, { recursive: true });
    writeFileSync(join(this.saveDir, `${safe}.json`), json, 'utf-8'); // 정본(권위) — 실패 시 throw.
    if (this.reportsDir) {
      try { // 보조 미러 — 실패는 격리(정본 save/ 는 이미 성공).
        mkdirSync(this.reportsDir, { recursive: true });
        writeFileSync(join(this.reportsDir, `${safe}.json`), json, 'utf-8');
      } catch (err) {
        logger.warn({ err, name: safe }, 'reports 미러 저장 실패(정본 save/ 는 정상)');
      }
    }
    return safe;
  }

  /**
   * 임의 스냅샷(SetupArtifact 아님)을 `save/{name}.json` 으로 저장. `save()` 미러이되 타입 제약 없음.
   * 센터라이징 최종 셋업 스냅샷(기하+PTZ 병합 뷰)처럼 SetupArtifact 형이 아닌 payload 용. stringify5 직렬화.
   * 안전화 실패 시 throw. reportsDir 주입 시 best-effort 미러(실패 격리·로그).
   */
  saveSnapshot(name: string, data: unknown): string {
    const safe = this.sanitizeName(name);
    if (!safe) throw new Error(`invalid save name: ${name}`);
    const json = stringify5(data, 2);
    mkdirSync(this.saveDir, { recursive: true });
    writeFileSync(join(this.saveDir, `${safe}.json`), json, 'utf-8'); // 정본(권위) — 실패 시 throw.
    if (this.reportsDir) {
      try { // 보조 미러 — 실패는 격리(정본 save/ 는 이미 성공).
        mkdirSync(this.reportsDir, { recursive: true });
        writeFileSync(join(this.reportsDir, `${safe}.json`), json, 'utf-8');
      } catch (err) {
        logger.warn({ err, name: safe }, 'reports 미러 저장 실패(정본 save/ 는 정상)');
      }
    }
    return safe;
  }

  /** 저장 목록(mtime 내림차순). name=확장자 없는 base, savedAt=파일 mtime(ISO). 폴더 없으면 []. */
  list(): Array<{ name: string; savedAt: string }> {
    if (!existsSync(this.saveDir)) return [];
    const rows: Array<{ name: string; savedAt: string; mtimeMs: number }> = [];
    for (const f of readdirSync(this.saveDir)) {
      if (!f.toLowerCase().endsWith('.json')) continue;
      const st = statSync(join(this.saveDir, f));
      rows.push({ name: f.slice(0, -5), savedAt: st.mtime.toISOString(), mtimeMs: st.mtimeMs });
    }
    rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return rows.map(({ name, savedAt }) => ({ name, savedAt }));
  }

  /** 저장 결과 로드. 안전화 실패·파일 없음이면 null. */
  load(name: string): SetupArtifact | null {
    const safe = this.sanitizeName(name);
    if (!safe) return null;
    const full = join(this.saveDir, `${safe}.json`);
    if (!existsSync(full)) return null;
    return JSON.parse(readFileSync(full, 'utf-8')) as SetupArtifact;
  }
}

/** finalize 자동 스냅샷 기본 이름: `result_YYYYMMDD_HHMMSS`(로컬 시각). */
export function defaultSaveName(date: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `result_${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** 센터라이징 최종 셋업 스냅샷 기본 이름: `Setup_YYYYMMDD_HHMMSS`(로컬 시각, defaultSaveName 미러). */
export function setupSaveName(date: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `Setup_${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}
