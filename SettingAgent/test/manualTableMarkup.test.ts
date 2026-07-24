import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 전역 인덱스 수동 매핑 표의 **편집 UI 구조 봉인**(소스 정적 검사 — app.js 는 브라우저 전역 의존이라 실행하지 않는다).
 *
 * 봉인 대상은 회귀하면 조용히 틀리는 두 가지다:
 *  ① 전역ID 수집이 배치 입력까지 긁어오면(선택자에서 data-field 필터가 빠지면) 재번호 매핑이 통째로 망가진다.
 *  ② zone 열 부활(DB 미보유·항상 `cam{N}` = 카메라 열 중복).
 */

const APP = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8');
const HTML = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8');

describe('수동 매핑 표 편집 UI(정적 봉인)', () => {
  it('표 헤더 = 전역ID·카메라·프리셋·프리셋내 위치·slotId(현재), zone 없음', () => {
    const header = APP.match(/<thead><tr><th>전역 ID<\/th>.*?<\/tr><\/thead>/)?.[0] ?? '';
    expect(header).toContain('<th>카메라</th>');
    expect(header).toContain('<th>프리셋</th>');
    expect(header).toContain('<th>프리셋내 위치</th>');
    expect(header).toContain('<th>slotId (현재)</th>');
    expect(header).not.toContain('zone');
  });

  it('행마다 전역ID + 배치 3필드가 입력 셀로 생성된다', () => {
    for (const field of ['gid', 'cam', 'preset', 'pos']) {
      expect(APP).toContain(`manualCell(r.slotId, '${field}'`);
    }
  });

  it('전역ID 수집·자동번호는 data-field="gid" 로만 한정한다(배치 입력 혼입 금지)', () => {
    const gidOnly = /\.an-manual-input\[data-field="gid"\]/g;
    expect(APP.match(gidOnly)?.length).toBeGreaterThanOrEqual(2); // collectManualIds + autoNumberManual
    expect(APP).toContain('.an-manual-place'); // 배치 전용 수집 선택자
  });

  it('저장은 배치(placement) → 재번호(renumber) 순서로 호출한다', () => {
    const placeAt = APP.indexOf("api('/mapping/placement')");
    const renumAt = APP.indexOf("api('/mapping/renumber')");
    expect(placeAt).toBeGreaterThan(0);
    expect(renumAt).toBeGreaterThan(placeAt); // 배치는 현재 slot_id 키 — 재번호보다 먼저여야 한다
  });

  it('안내문에 slotId=전역ID 규칙과 ROI·PTZ 미변환 경고가 있다', () => {
    const help = HTML.match(/<p class="an-manual-help">[^<]*(?:<[^>]+>[^<]*)*?<\/p>/)?.[0] ?? '';
    expect(help).toContain('slotId 는 전역 ID 를 따라갑니다');
    expect(help).toContain('재수집');
  });
});
