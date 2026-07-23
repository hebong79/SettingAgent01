import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 회귀 가드: "표시 초기화" 버튼(#roi-clear)은 **바닥 ROI 만 남기고 나머지 오버레이 데이터를 삭제**한다.
// Hide(토글 off)가 아니라 실제 데이터 삭제 — 재토글로도 복원되지 않아야 한다(마스터 요청 2026-07-16).
// 근본 버그: clearRoiDisplay 는 state.roiHidden 만 세팅 → 슬롯 ROI 만 숨기고 검출/점유/육면체/마스크가 남았다.
// DOM/렌더 계층이라 순수함수 테스트로 못 잡아 소스 텍스트로 가드한다(viewerOverlayInteractive 선례).
const appPath = fileURLToPath(new URL('../web/app.js', import.meta.url));
const htmlPath = fileURLToPath(new URL('../web/index.html', import.meta.url));
const app = readFileSync(appPath, 'utf-8');
const html = readFileSync(htmlPath, 'utf-8');

/** app.js 에서 함수 본문(중괄호 균형)을 추출. */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `${name} 함수가 app.js 에 존재해야 함`).toBeGreaterThan(-1);
  const braceOpen = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(braceOpen + 1, i);
    }
  }
  throw new Error(`${name} 본문 파싱 실패`);
}

describe('표시 초기화(#roi-clear) — 바닥 제외 오버레이 데이터 삭제(Hide 아님)', () => {
  it('#roi-clear 는 resetOverlayDisplay 에 결선된다(clearRoiDisplay 재유입 차단)', () => {
    expect(app).toMatch(/\$\(['"]roi-clear['"]\)\.addEventListener\(\s*['"]click['"]\s*,\s*resetOverlayDisplay\s*\)/);
  });

  it('resetOverlayDisplay 는 검출/LPD탐색/점유/차량육면체·마스크 데이터를 삭제한다', () => {
    const body = functionBody(app, 'resetOverlayDisplay');
    expect(body).toMatch(/state\.detectByKey\s*=\s*\{\}/);      // 검출 차량/번호판.
    expect(body).toMatch(/state\.discoverByKey\s*=\s*\{\}/);    // discovery(앞면중심 LOOP) LPD quad — 미삭제 시 잔여 박스.
    expect(body).toMatch(/state\.occComputeByKey\s*=\s*\{\}/);  // 로직 점유(원).
    expect(body).toMatch(/state\.occByKey\s*=\s*\{\}/);         // 점유율 요약.
    expect(body).toMatch(/state\.vcuboidByKey\s*=\s*\{\}/);     // 차량 육면체 + seg 마스크.
  });

  // DB 소스만 예외: state.parkingSlotsByKey 는 renderSlotList 의 최종화 판정 소스라 삭제 금지 →
  // 게이트(#roi-db)를 내려 화면에서만 내리고, 재체크 시 loadParkingSlots 로 되살린다(마스터 요청 2026-07-23).
  it('resetOverlayDisplay 는 #roi-db 를 해제하되 DB 소스(parkingSlotsByKey)는 삭제하지 않는다', () => {
    const body = functionBody(app, 'resetOverlayDisplay');
    expect(body).toMatch(/\$\(['"]roi-db['"]\)\.checked\s*=\s*false/);
    expect(body).not.toMatch(/state\.parkingSlotsByKey\s*=/); // 목록 최종화 판정 보존.
  });

  it('resetOverlayDisplay 는 바닥 ROI(placeRoi)와 표시 토글을 삭제/변경하지 않는다', () => {
    const body = functionBody(app, 'resetOverlayDisplay');
    expect(body).not.toMatch(/state\.placeRoi\s*=/);   // 바닥 파일 ROI 보존.
    expect(body).not.toContain("'roi-floor'");         // 바닥 토글 미변경.
    // Hide(토글 off) 방식 금지 — 검출/점유/육면체는 삭제여야 한다(#roi-db 는 위 예외).
    for (const id of ['roi-vehicle', 'roi-plate', 'roi-occupancy', 'roi-cuboid', 'roi-vcuboid', 'roi-mask']) {
      expect(body).not.toContain(`'${id}'`);
    }
  });

  it('resetOverlayDisplay 는 선택 해제 + 재렌더 + 목록 갱신한다', () => {
    const body = functionBody(app, 'resetOverlayDisplay');
    expect(body).toContain('state.selectedSlotId = null');
    expect(body).toContain('state.selectedDetect = null');
    expect(body).toContain('renderDetectSelection()'); // #det-delete 버튼 동기화.
    expect(body).toContain('drawRoiOverlay()');
    expect(body).toContain('renderSlotList()');        // 검출 count·점유 삭제 반영.
  });

  it('수집 시작(capCaptureStart)은 여전히 clearRoiDisplay 를 쓴다(라이브 검출/점유 표시 보존)', () => {
    const body = functionBody(app, 'capCaptureStart');
    expect(body).toContain('clearRoiDisplay()');
    expect(body).not.toContain('resetOverlayDisplay()');
  });

  it('clearRoiDisplay 는 데이터를 삭제하지 않는다(capStart 라이브 레이어 보존)', () => {
    const body = functionBody(app, 'clearRoiDisplay');
    expect(body).not.toMatch(/state\.detectByKey\s*=\s*\{\}/);
    expect(body).toContain('state.roiHidden = true');
  });

  it('#roi-clear 버튼은 index.html 에 존재한다', () => {
    expect(html).toContain('id="roi-clear"');
  });
});
