import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 정밀수집 진행바 미러(`renderPreciseProgress`)와 '센터라이징 분리' 완료 메시지(`preciseDoneMessage`).
 * 마스터 지시(2026-07-22): (1) 시작 후 진행바에 진행상황 표시 (2) 분리 run 도 종료 메시지를 내고
 * 센터라이징을 하라고 안내.
 *
 * 두 함수 모두 `web/app.js` 안의 DOM/fetch 함수라 import 할 수 없다 → dbCenteringOverlay.test.ts 의
 * functionSource 관용구로 **실제 배포 바이트**를 떼어 `new Function` 으로 실행한다(복사본 아님).
 */

const appSrc = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf-8');

function functionSource(src: string, name: string): string {
  let start = src.indexOf(`function ${name}(`);
  // `async` 접두가 있으면 함께 떼어낸다 — 빠뜨리면 본문의 await 가 SyntaxError 로 터진다.
  if (start > 6 && src.slice(start - 6, start) === 'async ') start -= 6;
  expect(start, `${name} 함수가 app.js 에 존재해야 함`).toBeGreaterThan(-1);
  const braceOpen = src.indexOf("{", start);
  let depth = 0;
  for (let i = braceOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name} 본문 파싱 실패`);
}

// ══════════════════════════════════════════════════════════════════
// 진행바 미러
// ══════════════════════════════════════════════════════════════════
const PROGRESS_SRC = functionSource(appSrc, 'renderPreciseProgress');

function runProgress(phase: string, status: unknown): { value: number; label: string } {
  const els: Record<string, { value: number; textContent: string }> = {
    'cap-bar': { value: -1, textContent: '' },
    'cap-label': { value: -1, textContent: '' },
  };
  const $ = (id: string) => els[id];
  new Function('$', 'phase', 'status', `${PROGRESS_SRC}\nreturn renderPreciseProgress(phase, status);`)(
    $, phase, status,
  );
  return { value: els['cap-bar'].value, label: els['cap-label'].textContent };
}

describe('정밀수집 진행바 미러 — renderPreciseProgress', () => {
  it('탐색 12/23 → 52% + 단계명 라벨', () => {
    const r = runProgress('번호판 탐색', { state: 'running', done: 12, total: 23 });
    expect(r.value).toBe(52);
    expect(r.label).toBe('번호판 탐색 12/23 (52%)');
  });

  it('센터라이징 단계도 같은 규칙(단계명만 다름)', () => {
    const r = runProgress('센터라이징', { done: 23, total: 23 });
    expect(r.value).toBe(100);
    expect(r.label).toBe('센터라이징 23/23 (100%)');
  });

  it('★ total 0 → 0% (NaN·Infinity 로 새지 않는다)', () => {
    expect(runProgress('번호판 탐색', { done: 0, total: 0 }).value).toBe(0);
    expect(runProgress('번호판 탐색', null).value).toBe(0);
    expect(runProgress('번호판 탐색', {}).label).toBe('번호판 탐색 0/0 (0%)');
  });
});

// ══════════════════════════════════════════════════════════════════
// 진행바 소유권 — 정밀수집 run 중엔 수집 status 가 진행바를 덮지 않는다
// ══════════════════════════════════════════════════════════════════
describe('진행바 소유권 배선', () => {
  it('renderCaptureStatus 가 preciseActive 일 때 cap-bar 를 건드리지 않는다', () => {
    const body = functionSource(appSrc, 'renderCaptureStatus');
    expect(body).toMatch(/if \(!preciseActive\)/);
  });

  it('startPrecise 는 소유권을 잡고 진행바를 0 으로 리셋한다', () => {
    const body = functionSource(appSrc, 'startPrecise');
    expect(body).toMatch(/preciseActive = true/);
    expect(body).toMatch(/\$\('cap-bar'\)\.value = 0/);
  });

  it("★ '수집 시작'은 소유권을 되가져간다(정밀수집 잔여로 수집 진행바가 얼지 않게)", () => {
    expect(functionSource(appSrc, 'capCaptureStart')).toMatch(/preciseActive = false/);
  });

  it('탐색·센터라이징 폴이 각각 미러를 호출한다', () => {
    expect(functionSource(appSrc, 'discPoll')).toMatch(/renderPreciseProgress\('번호판 탐색', status\)/);
    expect(functionSource(appSrc, 'calPoll')).toMatch(/renderPreciseProgress\('센터라이징', status\)/);
  });
});

// ══════════════════════════════════════════════════════════════════
// '센터라이징 분리' 완료 메시지
// ══════════════════════════════════════════════════════════════════
const MSG_SRC = functionSource(appSrc, 'preciseDoneMessage');

async function runMsg(pl: unknown, statuses: Record<string, unknown>): Promise<string> {
  const fetchStub = async (url: string) => ({ ok: true, json: async () => statuses[url] ?? {} });
  return (await new Function(
    'fetch', 'pl', `${MSG_SRC}\nreturn preciseDoneMessage(pl);`,
  )(fetchStub, pl)) as string;
}

const DISC = { '/discover/status': { found: 23, total: 23 } };

describe("'센터라이징 분리' 완료 메시지", () => {
  const note = '센터라이징 분리 — 탐색·점유영역까지 완료(센터라이징 대상 23슬롯 대기)';

  it('종료 사실 + 센터라이징 안내 + 대상 슬롯수를 담는다', async () => {
    const msg = await runMsg({ precise: true, note, coverage: { targets: 23, totalSlots: 23, uncovered: 0 } }, DISC);
    expect(msg).toContain('종료되었습니다');
    expect(msg).toContain('센터라이징');
    expect(msg).toContain('23슬롯');
    expect(msg).toContain('탐색 23/23');
  });

  it('★ 센터링 실적·setup_result 를 주장하지 않는다 — 직전 run 잔여를 이번 실적으로 위장 금지', async () => {
    const msg = await runMsg(
      { precise: true, note, coverage: { targets: 23, totalSlots: 23, uncovered: 0 } },
      { ...DISC, '/calibrate/status': { done: 99, total: 99 } }, // 직전 run 잔여.
    );
    expect(msg).not.toContain('setup_result.json');
    expect(msg).not.toContain('99');
  });

  it('★ 분리하지 않은 정상 완료는 기존 메시지 유지(회귀 0)', async () => {
    const msg = await runMsg({ precise: true }, { ...DISC, '/calibrate/status': { done: 22, total: 23 } });
    expect(msg).toBe('정밀수집 완료 — 탐색 23/23 · 센터링 22/23 · setup_result.json 저장');
  });
});
