import pino from 'pino';
import { createStream } from 'rotating-file-stream';
import { mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 로거: 콘솔 + 회전 파일(UTF-8) 이중 출력.
 * - 콘솔 한글 깨짐 방지: (1) Windows 에서 시작 시 콘솔 출력 코드페이지를 UTF-8(65001)로 설정,
 *   (2) process.stdout 스트림으로 출력. chcp 는 프로세스가 붙은 "공유 콘솔"의 코드페이지를 바꾸므로
 *   nodemon 처럼 stdout 이 파이프되는 경우에도 UTF-8 바이트가 콘솔에서 올바르게 렌더된다.
 *   (기본 pino 의 sonic-boom fd 직접 쓰기 + cp949 콘솔 조합이 깨짐의 원인이었다.)
 * - 파일: logs/setting_<yyyyMMdd_HHmmss>.log (기동 시각 기준). 날짜 단위(1일) 회전 +
 *   20MB 초과 시 회전(아카이브는 회전 시각 기준 파일명, 동일 시각 내 size 회전은 _N 부가).
 * - 카테고리: { cat: 'packet' | 'centering' | 'occupancy', ... } 로 통신패킷·센터라이징·주차면점유 구분.
 * 테스트(VITEST)에서는 파일 스트림을 만들지 않는다(산출물 오염 방지).
 */
const isTest = !!process.env.VITEST;

const pad2 = (n: number): string => String(n).padStart(2, '0');
/** Date → yyyyMMdd_HHmmss. */
const stamp = (d: Date): string =>
  `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
const startStamp = stamp(new Date());

/** rfs 파일명 생성기. time=null → 현재(활성) 파일(기동 시각), time=Date → 회전 아카이브(회전 시각). */
function logFileName(time: number | Date | null, index?: number): string {
  if (!time) return `setting_${startStamp}.log`;
  const d = time instanceof Date ? time : new Date(time);
  const base = `setting_${stamp(d)}`;
  return index && index > 1 ? `${base}_${index}.log` : `${base}.log`;
}

if (process.platform === 'win32' && !isTest) {
  try {
    execSync('chcp 65001', { stdio: 'ignore' });
  } catch {
    /* 콘솔이 없거나 chcp 실패 — 무시(파일 로그는 UTF-8 로 정상). */
  }
}

/**
 * 로그 폴더를 결정한다. 후보를 순서대로 시도해 처음으로 생성 가능한 곳을 쓴다.
 * MCP 클라이언트(Claude Desktop 등)는 서버를 cwd=C:\WINDOWS\system32 로 실행하는데,
 * cwd 상대 'logs' 는 권한 없어 EPERM 크래시한다. 따라서 LOG_DIR → cwd/logs → tmpdir 순으로
 * 폴백하고, 모두 실패하면 파일 로그를 끄고 콘솔(stdout)만 사용해 절대 크래시하지 않는다.
 */
function resolveLogDir(): string | null {
  const candidates = [
    process.env.LOG_DIR,
    'logs',
    join(tmpdir(), 'parkagent-setting', 'logs'),
  ].filter((d): d is string => !!d);
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      /* 다음 후보 시도 */
    }
  }
  return null;
}

const streams: pino.StreamEntry[] = [{ stream: process.stdout }];

if (!isTest) {
  const logDir = resolveLogDir();
  if (logDir) {
    const fileStream = createStream(logFileName, { size: '20M', interval: '1d', path: logDir, encoding: 'utf-8' });
    streams.push({ stream: fileStream as unknown as NodeJS.WritableStream });
  }
  /* logDir === null 이면 파일 로그 비활성(콘솔만) — 쓰기 가능한 경로가 없어도 크래시 방지. */
}

export const logger = pino(
  { level: process.env.LOG_LEVEL ?? 'info', base: undefined },
  pino.multistream(streams),
);

export type Logger = typeof logger;
