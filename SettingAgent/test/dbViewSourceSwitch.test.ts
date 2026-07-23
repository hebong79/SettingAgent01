import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 회귀 가드(DOM/렌더 계층 — 순수함수로 못 잡아 소스 텍스트로 가드. viewerToggleGating.test.ts 선례).
 *
 * 'DB 보기'(#roi-db) 는 **폴백이 아니라 소스 전환**이다(마스터 요청 2026-07-21):
 *   체크 시 차량(vpd)·번호판(lpd)·점유영역(occupyRange) 을 라이브 검출 유무와 무관하게 DB(slot_setup) 로 그린다.
 *   또한 어느 탭에서 켜도 동작해야 하므로 소스(state.parkingSlotsByKey)가 없으면 토글 핸들러가 1회 로드한다.
 * 데이터 계약(getSlotSetup → toPixel/toPixelQuad) parity 는 dbOverlayParity.test.ts 가 담당한다.
 */
const app = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf-8');
const html = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf-8');

function functionBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `${name} 함수 존재`).toBeGreaterThan(-1);
  const braceOpen = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(braceOpen + 1, i); }
  }
  throw new Error(`${name} 본문 파싱 실패`);
}

describe("'DB 보기' = slot_setup 소스 전환(폴백 아님)", () => {
  const detect = functionBody(app, 'drawDetectOverlay');
  const occupancy = functionBody(app, 'drawOccupancyOverlay');

  it('VPD/LPD 모두 dbOn 을 먼저 분기해 DB 소스를 그린다(라이브는 else)', () => {
    expect(detect).toContain('drawDbVpd(ctx, rows)');
    expect(detect).toMatch(/if \(dbOn\)[\s\S]*row\.lpd/); // LPD 도 dbOn 우선 분기.
    // 구 규약(라이브 있으면 DB 스킵)이 남아있지 않을 것.
    expect(detect).not.toMatch(/else if \(dbOn\)/);
  });

  it('점유영역도 dbOn 이면 라이브 점유 유무와 무관하게 DB occupyRange 를 그린다', () => {
    expect(occupancy).toMatch(/\$\(['"]roi-db['"]\)\.checked/);
    expect(occupancy).toContain('drawDbOccupancy(ctx,');
    // 라이브 점유 존재 여부가 DB 분기의 조건이 되어선 안 된다(구 hasLive 게이트 제거).
    expect(occupancy).not.toContain('hasLive');
  });

  it('drawDbOccupancy 는 occupyRange 를 폴리곤으로 렌더한다', () => {
    const body = functionBody(app, 'drawDbOccupancy');
    expect(body).toContain('row.occupyRange');
    expect(body).toContain('toPixelQuad');
    expect(body).toContain('fill()');
  });

  // 켤 때마다 재조회 — '표시 초기화'(#roi-clear)가 #roi-db 를 해제하므로, 재체크 시 캐시가 아니라
  // 최신 DB 를 다시 그려야 "다시 DB 내용 보여주기"가 성립한다(마스터 요청 2026-07-23).
  it('#roi-db 토글은 체크 시 loadParkingSlots 를 await 한 뒤 재렌더한다', () => {
    const wire = app.slice(app.indexOf("$('roi-db').addEventListener"));
    const handler = wire.slice(0, wire.indexOf('drawRoiOverlay();') + 'drawRoiOverlay();'.length);
    expect(handler).toContain('async');
    expect(handler).toMatch(/e\.target\.checked.*await loadParkingSlots\(\)/s);
    expect(handler).not.toContain('!state.parkingSlotsByKey'); // 캐시 있으면 skip 하던 구 규약 제거.
  });

  // LPD 검지(discover) 잔여 quad 는 #roi-plate 게이트만 통과하므로, 초기화 대상에 반드시 포함돼야 한다.
  it('discovery LPD quad 는 표시 초기화(resetOverlayDisplay)에서 삭제된다', () => {
    expect(detect).toContain('state.discoverByKey');
    expect(functionBody(app, 'resetOverlayDisplay')).toMatch(/state\.discoverByKey\s*=\s*\{\}/);
  });

  it("index.html 툴팁이 실제 동작(소스 전환·null 미표시)을 설명한다", () => {
    const tag = html.match(/<label[^>]*>\s*<input id="roi-db"[^>]*>/);
    const label = html.match(/<label title="([^"]*)"><input id="roi-db"/);
    expect(tag ?? label, '#roi-db 라벨 존재').toBeTruthy();
    expect(label?.[1]).toContain('전환');
    expect(label?.[1]).not.toContain('폴백');
  });
});
