import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * ROIMaker UI **정적 봉인**(설계서 §9.3).
 *
 * 이 저장소엔 브라우저 DOM 자동화가 없다(메모 반복 기록: web/* 는 육안 검증만 가능).
 * 그래서 순수 로직은 roimakerCore.test.ts 가 덮고, **DOM id·배선·호출 순서·격리 규약**은
 * 여기서 소스 텍스트로 고정한다(cameraKindSelect.test.ts 선례).
 *
 * ★ 가장 중요한 봉인: ROIMaker 는 **파괴 경로(replaceSlotSetup / load-roi)를 절대 부르지 않는다.**
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf-8');
const html = read('../web/index.html');
const app = read('../web/app.js');
const rm = read('../web/roimaker.js');
const rmCore = read('../web/roimakerCore.js');

/** 요구사항이 요구하는 DOM id 전량. */
const IDS = [
  'roimaker-view',
  'rm-frame',
  'rm-overlay',
  'rm-source',
  'rm-cam',
  'rm-preset',
  'rm-view-scope',
  'rm-draw-toggle',
  'rm-add',
  'rm-delete',
  'rm-save',
  'rm-reload',
  'rm-list',
  'rm-msg',
  'rm-hint',
];

describe('ROIMaker — DOM 계약', () => {
  it('index.html 에 ROI 편집 탭 버튼과 전용 뷰가 있다', () => {
    expect(html).toContain('data-tab="roimaker"');
    expect(html).toContain('id="roimaker-view"');
    expect(html).toContain('<script type="module" src="./roimaker.js">');
  });

  it('요구 id 전량이 index.html 에 존재한다', () => {
    for (const id of IDS) {
      expect(html.includes(`id="${id}"`), `index.html 에 #${id} 가 없다`).toBe(true);
    }
  });

  it('roimaker.js 가 참조하는 id 는 전부 index.html 에 존재한다(오타·유령 참조 차단)', () => {
    const referenced = [...rm.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((m) => m[1]!);
    expect(referenced.length).toBeGreaterThan(5);
    for (const id of new Set(referenced)) {
      expect(html.includes(`id="${id}"`), `roimaker.js 가 참조하는 #${id} 가 index.html 에 없다`).toBe(true);
    }
  });

  it('보기 범위 콤보에 3종(현재 프리셋/현재 슬롯/전체)이 있다 — 마스터 지시 #14', () => {
    const box = html.slice(html.indexOf('id="rm-view-scope"'), html.indexOf('id="rm-view-scope"') + 400);
    expect(box).toContain('value="preset"');
    expect(box).toContain('value="slot"');
    expect(box).toContain('value="all"');
  });
});

describe('ROIMaker — 파괴 경로 차단 봉인', () => {
  it('roimaker.js 는 load-roi / replaceSlotSetup 을 호출하지 않는다', () => {
    // load-roi 는 replaceSlotSetup(DELETE+INSERT 전량)으로 검출·점유·센터링을 파괴한다.
    expect(rm).not.toContain('/capture/slots/load-roi');
    expect(rm).not.toContain('replaceSlotSetup');
  });

  it('roimaker.js 의 DB 반영 경로는 sync-roi 뿐이다', () => {
    const dbCalls = [...rm.matchAll(/fetch\('(\/capture\/[a-z/-]+)'/g)].map((m) => m[1]!);
    expect(new Set(dbCalls)).toEqual(new Set(['/capture/place-roi', '/capture/slots/sync-roi']));
  });

  it('저장은 PUT place-roi → POST sync-roi → 재조회(loadRoi) 순서다', () => {
    const body = rm.slice(rm.indexOf('async function onSave('));
    const put = body.indexOf("'/capture/place-roi'");
    const sync = body.indexOf("'/capture/slots/sync-roi'");
    const reload = body.lastIndexOf('await loadRoi()');
    expect(put).toBeGreaterThan(-1);
    expect(sync).toBeGreaterThan(put); // 파일 먼저, DB 나중.
    expect(reload).toBeGreaterThan(sync); // 재조회는 맨 끝.
  });

  it('저장 요청에 무결성 가드(expectRawCount)가 동봉된다', () => {
    expect(rm).toContain('expectRawCount');
    expect(rmCore).toContain('expectRawCount');
  });
});

describe('ROIMaker — 제어탭 격리 봉인', () => {
  it('roimaker.js 는 제어탭 오버레이(#overlay)·프레임(#frame)에 리스너를 걸지 않는다', () => {
    expect(rm).not.toMatch(/\$\('overlay'\)/);
    expect(rm).not.toMatch(/\$\('frame'\)/);
    expect(rm).not.toMatch(/getElementById\('overlay'\)/);
  });

  it('app.js 의 기존 오버레이 편집은 #rm-overlay 를 모른다', () => {
    expect(app).not.toContain('rm-overlay');
    expect(app).not.toContain('rm-frame');
  });

  it('app.js ↔ roimaker.js 는 서로 import 하지 않는다(이벤트로만 결합)', () => {
    expect(app).not.toContain("from './roimaker");
    expect(rm).not.toContain("from './app.js'");
    expect(rm).toContain("document.addEventListener('sv:tab'");
    expect(app).toContain("new CustomEvent('sv:tab'");
  });

  it('setTab 이 roimaker 탭에서 전체폭 전환 + 제어탭 스트림 정지를 한다(카메라 이중 점유 방지)', () => {
    const i = app.indexOf('function setTab(');
    const body = app.slice(i, app.indexOf('\n}', i));
    expect(body).toContain("const roimaker = tab === 'roimaker'");
    expect(body).toContain("$('roimaker-view').hidden = !roimaker");
    expect(body).toContain('if (roimaker) stopLive()');
    expect(body).toMatch(/const full = analyze \|\| options \|\| db \|\| roimaker/);
  });
});

describe('ROIMaker — 상호작용 계약', () => {
  it('좌클릭=정점 추가 / 우클릭=폐합 / mouseup=드래그 확정 이 #rm-overlay 에 결선돼 있다', () => {
    expect(rm).toContain("overlay.addEventListener('mousedown', onMouseDown)");
    expect(rm).toContain("overlay.addEventListener('contextmenu', onContextMenu)");
    expect(rm).toContain("window.addEventListener('mouseup', onMouseUp)");
  });

  it('우클릭은 브라우저 기본 메뉴를 막는다', () => {
    const body = rm.slice(rm.indexOf('function onContextMenu('));
    expect(body.slice(0, 200)).toContain('e.preventDefault()');
  });

  it('그리기 시작 시 프레임을 고정한다(마스터 지시 #16)', () => {
    const body = rm.slice(rm.indexOf('function onToggleDraw('), rm.indexOf('function onDelete('));
    expect(body).toContain('freezeFrame()');
    expect(body).toContain('startStream()'); // 정지로 돌아가면 라이브 재개.
  });

  it('삭제 버튼은 코어의 deleteRoi 만 호출한다(행 제거가 아니라 기하 비우기 — 지시 #13)', () => {
    const body = rm.slice(rm.indexOf('function onDelete('), rm.indexOf('async function onSave('));
    expect(body).toContain('deleteRoi(');
    expect(body).not.toContain('splice');
  });

  it('추가 버튼이 addEmptySpace 에 결선돼 있다(주차면 id 만 생성)', () => {
    expect(rm).toContain("$('rm-add').addEventListener('click', onAdd)");
    const body = rm.slice(rm.indexOf('function onAdd('), rm.indexOf('function onDelete('));
    expect(body).toContain('addEmptySpace(');
  });

  it('삭제 버튼은 미저장 신규(빈 번호 포함)에도 활성화된다 — 추가 오조작을 되돌릴 수 있어야 한다', () => {
    const body = rm.slice(rm.indexOf('function renderToolbar('), rm.indexOf('function drawOverlay('));
    expect(body).toContain("target.origin !== 'new'");
  });
});

describe('ROIMaker ↔ 정밀수집 — 정본 양방향 갱신(마스터 실측 버그 2026-07-28)', () => {
  // 증상: 한쪽 페이지에서 주차면을 추가해도 다른 쪽에 안 보인다.
  // 원인: 두 페이지가 각자 메모리 버퍼를 들고 **세션 1회만** 로드했다.
  // 해법: 탭에 들어올 때마다 서버 정본을 다시 읽는다. 단 미저장 편집이 있으면 덮어쓰지 않는다.

  it('ROIMaker 진입 시 정본을 다시 읽는다(1회 로드 가드 제거)', () => {
    const body = rm.slice(rm.indexOf('async function enter('), rm.indexOf('function leave('));
    expect(body).toContain('await loadRoi()');
    expect(body).not.toContain('rm.loaded'); // 1회 로드 가드가 남아 있으면 갱신이 또 막힌다.
  });

  it('ROIMaker 는 미저장 편집이 있으면 새로고침하지 않고 안내한다(작업 보호)', () => {
    const body = rm.slice(rm.indexOf('async function enter('), rm.indexOf('function leave('));
    expect(body).toContain('rm.state.dirtyKeys.length');
    expect(body).toContain('미저장 편집');
  });

  it('rm.loaded 상태가 코드에서 완전히 사라졌다(고아 상태 잔존 금지)', () => {
    expect(rm).not.toContain('rm.loaded');
  });

  it('정밀수집 탭 진입은 loadPlaceRoi(true) 로 정본을 다시 읽는다', () => {
    const i = app.indexOf("if (tab === 'precise')");
    expect(i).toBeGreaterThan(-1);
    expect(app.slice(i, i + 260)).toContain('loadPlaceRoi(true)');
  });

  it('loadPlaceRoi 는 refresh 여도 미저장 편집(placeRoiDirty)이면 덮어쓰지 않는다', () => {
    const i = app.indexOf('async function loadPlaceRoi(');
    const body = app.slice(i, app.indexOf('\n}', i));
    expect(body).toContain('refresh = false');
    expect(body).toContain('state.placeRoiLoaded && !refresh');
    expect(body).toContain('state.placeRoiDirty');
  });
});

describe('ROIMaker — 카메라/프리셋 선택 시 실제 이동(마스터 요청 2026-07-28)', () => {
  it('소스·카메라·프리셋 change 가 전부 retarget() 을 탄다', () => {
    for (const id of ['rm-source', 'rm-cam', 'rm-preset']) {
      const i = rm.indexOf(`$('${id}').addEventListener('change'`);
      expect(i, `${id} change 핸들러가 없다`).toBeGreaterThan(-1);
      expect(rm.slice(i, i + 260)).toContain('retarget()');
    }
  });

  it('retarget/gotoPreset 이 POST /move 로 프리셋 PTZ 를 보낸다(스트림 URL 만 바꾸지 않는다)', () => {
    const body = rm.slice(rm.indexOf('async function gotoPreset('), rm.indexOf('async function retarget('));
    expect(body).toContain('findPresetPtz(');
    expect(body).toContain("api('/move')");
    expect(body).toContain("method: 'POST'");
    expect(body).toContain('startStream()'); // 이동 후 스트림 재연결.
  });

  it('대상이 바뀌면 그리던 draft 를 버리고 정지로 돌아간다(이전 프레임 좌표 혼입 차단)', () => {
    const body = rm.slice(rm.indexOf('async function retarget('), rm.indexOf('// --- 렌더'));
    expect(body).toContain('cancelDraft(');
    expect(body).toContain('toggleDrawMode(');
  });

  it('목록에서 다른 프리셋 행을 클릭해도 카메라가 이동한다', () => {
    const body = rm.slice(rm.indexOf('async function onListClick('), rm.indexOf('// --- 마우스'));
    expect(body).toContain('await gotoPreset()');
  });
});
