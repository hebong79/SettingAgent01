import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 렌즈 캘리브레이션 뷰어 UI **소스 봉인**.
 *
 * 이 저장소에는 브라우저 DOM 자동화(playwright/jsdom)가 없다 — 뷰어 검증은 기존 선례
 * (cameraKindSelect.test.ts · buildTouringPlan.test.ts)대로 마크업·결선 정적 검사로 한다.
 * 목적은 동작 증명이 아니라 **요소나 결선이 사라지면 반드시 알아차리는 것**이다.
 */

const HTML = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8');
const APP = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8');
const CSS = readFileSync(fileURLToPath(new URL('../web/app.css', import.meta.url)), 'utf8');

describe('마크업 — 요청된 UI 구성요소가 전부 있다', () => {
  it.each([
    ['id="lens-box"', '카드 컨테이너'],
    ['id="lens-mode"', '종류 선택'],
    ['id="lens-start"', '시작 버튼'],
    ['id="lens-stop"', '정지 버튼'],
    ['id="lens-apply"', '적용 버튼'],
    ['id="lens-bar"', '진행바'],
    ['id="lens-label"', '진행 라벨'],
    ['id="lens-msg"', '진행 메시지'],
    ['id="lens-log"', '진행 LOG'],
    ['id="lens-summary"', '완료 요약'],
    ['id="lens-target"', '대상 카메라 배지'],
  ])('%s (%s)', (needle) => {
    expect(HTML).toContain(needle);
  });

  it('3개 모드가 콤보에 있다(초기 캘리브레이션이 기본 선택)', () => {
    expect(HTML).toContain('value="full" selected');
    expect(HTML).toContain('value="verify"');
    expect(HTML).toContain('value="distortion"');
  });

  it('정밀수집 탭 안, LPD 검지 카드 뒤에 놓인다(센터라이징 맥락)', () => {
    const lpd = HTML.indexOf('id="lpd-stage-title"');
    const lens = HTML.indexOf('id="lens-box"');
    const align = HTML.indexOf('id="align-box"');
    expect(lpd).toBeGreaterThan(-1);
    expect(lens).toBeGreaterThan(lpd);
    expect(align).toBeGreaterThan(lens);
  });

  it('카드는 기존 클래스를 재사용한다(CSS 분기 최소화)', () => {
    expect(HTML).toContain('class="precise-stage precise-operation-card lens-calib-stage"');
  });

  it('로그 박스 CSS 가 스크롤을 자체 소유한다(패널이 무한히 늘어나지 않게)', () => {
    const block = CSS.slice(CSS.indexOf('.op-log {'));
    expect(block).toContain('max-height');
    expect(block).toContain('overflow: auto');
  });
});

describe('결선 — 버튼이 실제 핸들러에 붙어 있다', () => {
  it.each([
    ["$('lens-start').addEventListener('click', lensStart)", '시작'],
    ["$('lens-stop').addEventListener('click', lensStop)", '정지'],
    ["$('lens-apply').addEventListener('click', lensApply)", '적용'],
  ])('%s', (needle) => {
    expect(APP).toContain(needle);
  });

  it('순수 뷰 헬퍼를 core.js 에서 import 해서 쓴다(판단 로직을 DOM 에 묻지 않는다)', () => {
    expect(APP).toContain('lensCalibView,');
    expect(APP).toContain('lensCalibView(status ?? {})');
  });

  it('폴러는 단일 타이머 변수를 소유한다(중복 폴 방지 — 2026-07-24 규칙)', () => {
    expect(APP).toContain('let lensPollTimer = null;');
    // setTimeout 재무장 직전에 항상 clear 한다.
    const body = APP.slice(APP.indexOf('async function lensPoll('), APP.indexOf('/** 완료 요약'));
    expect(body).toContain('clearTimeout(lensPollTimer)');
    expect(body.indexOf('clearTimeout(lensPollTimer)')).toBeLessThan(body.indexOf('lensPollTimer = setTimeout(lensPoll'));
  });

  it('로그는 서버 증분(sinceSeq)으로 받아 이어붙인다', () => {
    expect(APP).toContain('/calibrate/lens/status?sinceSeq=');
    expect(APP).toContain('lensLastSeq = status.lastSeq');
  });

  it('새로고침 복구 — 결선 시점에 상태를 1회 폴한다', () => {
    expect(APP).toContain('lensPoll(); // 새로고침 복구');
  });
});

describe('안전 문구·가드 — 조용히 틀리지 않게', () => {
  it('시뮬레이터 소스면 클라에서 먼저 시작을 막는다(서버 400 을 기다리지 않는다)', () => {
    const body = APP.slice(APP.indexOf('function updateLensTarget('), APP.indexOf('async function lensStart('));
    expect(body).toContain("kind === 'hucoms'");
    expect(body).toContain("$('lens-start').disabled = true");
    expect(body).toContain('시뮬레이터는');
  });

  it('긴 점유 모드는 확인창을 띄운다(verify 는 짧으므로 없음)', () => {
    expect(APP).toContain('full: { label: \'초기 캘리브레이션(표 생성)\', mins: \'약 25~40분\', confirm: true }');
    expect(APP).toContain('verify: { label: \'검증\', mins: \'약 3분\', confirm: false }');
  });

  it('적용 후 서버 재시작이 필요하다는 사실을 반드시 말한다', () => {
    expect(APP).toContain('서버를 재시작하세요');
    expect(APP).toContain('서버를 재시작**해야 조준에 반영');
  });

  it('저장 안 된 결과에는 적용 버튼을 띄우지 않는다(applyVisible 게이트 사용)', () => {
    expect(APP).toContain("$('lens-apply').hidden = !view.applyVisible");
  });

  it('로그 버퍼 유실을 화면에 알린다(조용한 truncate 금지)', () => {
    expect(APP).toContain('logsTruncated');
    expect(APP).toContain('버퍼에서 밀려났습니다');
  });
});
