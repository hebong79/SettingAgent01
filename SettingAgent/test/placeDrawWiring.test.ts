import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Stage 4 — 결선 회귀 가드(DOM/캔버스 계층은 순수함수로 못 잡아 **소스 텍스트**로 봉인.
 * 선례: test/groundGridPanelUi.test.ts · test/dbViewSourceSwitch.test.ts).
 *
 * ⚠️ 이 테스트가 증명하는 것은 "코드가 그 자리에 있다" 까지다. **화면에 보이는가는 증명하지 않는다**(육안 확인 필요).
 */
const app = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf-8');
const html = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf-8');
const css = readFileSync(fileURLToPath(new URL('../web/app.css', import.meta.url)), 'utf-8');

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

/** overlay mousedown 핸들러 본문(첫 번째 등록분). */
function mousedownBody(): string {
  const at = app.indexOf("overlay.addEventListener('mousedown'");
  expect(at, 'overlay mousedown 핸들러 존재').toBeGreaterThan(-1);
  const braceOpen = app.indexOf('{', app.indexOf('=>', at));
  let depth = 0;
  for (let i = braceOpen; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}') { depth--; if (depth === 0) return app.slice(braceOpen + 1, i); }
  }
  throw new Error('mousedown 본문 파싱 실패');
}

/** window mousemove(드래그 진행) 핸들러 본문. */
function mousemoveBody(): string {
  // 패널 리사이즈용 mousemove(핸들러 참조 전달)와 구분해 **드래그 진행** 핸들러(인라인 화살표)를 집는다.
  const at = app.indexOf("window.addEventListener('mousemove', (e) => {");
  expect(at, 'window mousemove(드래그) 핸들러 존재').toBeGreaterThan(-1);
  const braceOpen = app.indexOf('{', app.indexOf('=>', at));
  let depth = 0;
  for (let i = braceOpen; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}') { depth--; if (depth === 0) return app.slice(braceOpen + 1, i); }
  }
  throw new Error('mousemove 본문 파싱 실패');
}

describe('회귀 0 구조 봉인', () => {
  it('T1 mousedown 핸들러의 첫 문장이 placeDraw 분기다(off 면 기존 코드가 원문 그대로 실행)', () => {
    const body = mousedownBody();
    const firstStmt = body.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'))[0];
    expect(firstStmt).toBe('if (state.placeDraw) { placeDrawClick(e); return; }');
    // 기존 최우선 소비였던 개별 센터라이징 분기는 그 **뒤**에 그대로 있다.
    expect(body.indexOf('state.placeDraw')).toBeLessThan(body.indexOf("$('cal-click-mode')"));
  });

  it('T2 placeVertex 분기가 `if (state.roiHidden || !state.mapping) return;` 이전에 있다', () => {
    const body = mousedownBody();
    const pv = body.indexOf('hitTestPlaceVertex');
    const guard = body.indexOf('if (state.roiHidden || !state.mapping) return;');
    expect(pv).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    expect(pv).toBeLessThan(guard);
  });

  it('T3 mousemove 의 placeVertex 처리가 state.mapping.slots 접근 이전에 return 한다(TypeError 방어)', () => {
    const body = mousemoveBody();
    const pv = body.indexOf("dragState.kind === 'placeVertex'");
    const slots = body.indexOf('(state.mapping.slots ?? [])'); // 주석 언급이 아닌 **실제 접근**.
    expect(pv).toBeGreaterThan(-1);
    expect(slots).toBeGreaterThan(-1);
    expect(pv).toBeLessThan(slots);
    // 그 블록이 return 으로 끝난다.
    expect(body.slice(pv, slots)).toMatch(/return;/);
  });

  it('T3-b hitTestPlaceVertex 는 #place-edit-vertex 가 꺼져 있으면 첫 줄에서 null 이다', () => {
    const body = functionBody(app, 'hitTestPlaceVertex');
    const first = body.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'))[0];
    expect(first).toContain("place-edit-vertex");
    expect(first).toContain('return null');
  });
});

describe('UI 결선', () => {
  it('T4 #place-draw · #place-edit-vertex 가 index.html 에 있고 wire() 에서 결선된다', () => {
    expect(html).toMatch(/<button id="place-draw"/);
    expect(html).toMatch(/<input id="place-edit-vertex"/);
    const w = functionBody(app, 'wire');
    expect(w).toContain("$('place-draw').addEventListener('click', togglePlaceDraw)");
    expect(w).toContain("$('place-edit-vertex').addEventListener('change'");
  });

  it('T5 #place-edit-vertex 의 기본값이 unchecked 다(기본 OFF)', () => {
    const tag = html.match(/<input id="place-edit-vertex"[^>]*>/)?.[0];
    expect(tag).toBeTruthy();
    expect(tag).not.toContain('checked');
  });

  it('T5-b 그리기 커서 클래스가 CSS 에 있다', () => {
    expect(css).toMatch(/#overlay\.place-drawing\s*\{[^}]*crosshair/);
  });

  it('T5-c Esc 취소 · Ctrl+Z 되돌리기가 결선되고, 소비 시 기존 keydown 으로 새지 않는다', () => {
    const w = functionBody(app, 'wire');
    const at = w.indexOf('state.placeDraw');
    expect(at).toBeGreaterThan(-1);
    const seg = w.slice(at, at + 1200);
    expect(seg).toContain("e.key === 'Escape'");
    expect(seg).toContain('undoPlaceDrawPoint');
    expect(seg).toContain('stopImmediatePropagation');
    // 신규 keydown 이 기존 검출편집 keydown(!state.selectedDetect 가드) 보다 **먼저** 등록된다.
    expect(w.indexOf('state.placeDraw')).toBeLessThan(w.indexOf('if (!state.selectedDetect) return;'));
  });
});

describe('저장 규약 봉인', () => {
  it('T6 그리기 커밋 경로에 저장(PUT) 이 없다 — 실수로 그린 면이 파일에 박히지 않는다', () => {
    const body = functionBody(app, 'placeDrawClick');
    expect(body).not.toContain('savePlaceRoi');
    expect(body).not.toContain("'PUT'");
    expect(body).toContain('markPlaceDirty'); // 미저장 버퍼 표시로만 끝난다.
  });

  it('T7 savePlaceRoi 에 idx 가드 · create 첨부 · 이미지크기 거부 · applied 확인이 있다', () => {
    const body = functionBody(app, 'savePlaceRoi');
    expect(body).toContain('Number.isInteger(sp?.idx)');
    expect(body).toContain('needsPlaceSkeleton(key)'); // 골격 필요 판정(파일 부재 + 파일에 없는 키).
    expect(body).toContain('buildPlaceSkeleton(cam, preset)');
    const skel = functionBody(app, 'buildPlaceSkeleton');
    expect(skel).toContain('frame.naturalWidth'); // F-2: 실측 크기가 유일한 출처.
    expect(skel).toContain('findPresetPtz'); // F-1: 골격에 PTZ 를 넣는다(L3 부트스트랩 전제).
    expect(body).toContain('data.applied === false');
    expect(body).toContain('await loadPlaceRoi()'); // 저장 후 파일 왕복 재로딩.
  });

  it('T8 그리기 커밋이 선택(selectedPlaceIdx)을 새 idx 로 세팅한다(지면격자 기준 면 성립)', () => {
    const body = functionBody(app, 'placeDrawClick');
    expect(body).toContain('state.selectedPlaceIdx = idx');
    expect(body).toContain('appendPlaceSpace');
  });

  it('QA D-1 골격 첨부 조건이 404 하나가 아니다 — 파일에 없는 키에도 붙고, applied:false 면 1회 재시도한다', () => {
    const needs = functionBody(app, 'needsPlaceSkeleton');
    expect(needs).toContain('state.placeRoiFileMissing');
    expect(needs).toContain('!state.placeRoiFileKeys.has(key)'); // ← 파일 존재 + 대상 부재 커버.
    const save = functionBody(app, 'savePlaceRoi');
    expect(save).toContain('needsPlaceSkeleton(key)');
    expect(save).toContain('data.applied === false && !body.create'); // 안전망: 골격 없이 실패하면 만들어 재시도.
    // 재시도는 1회뿐이다(루프 없음) — 재시도 후 applied 가 여전히 false 면 사유를 띄우고 끝낸다.
    expect(save).not.toMatch(/while\s*\(/);
    // 파일에서 로드된 키에는 골격을 안 붙인다 → 기존 저장 경로에 naturalWidth 실패 조건이 새로 생기지 않는다.
    const load = functionBody(app, 'loadPlaceRoi');
    expect(load).toContain('state.placeRoiFileKeys = new Set(Object.keys(norm.placeRoi))');
  });

  it('QA D-5 골격의 zoom 은 양수일 때만 넣는다(스키마 400 회피) · pan/tilt 도 유한할 때만', () => {
    const body = functionBody(app, 'buildPlaceSkeleton');
    expect(body).toContain('Number.isFinite(ptz?.zoom) && ptz.zoom > 0');
    expect(body).toContain('if (!(w > 0 && h > 0)) return null;'); // F-2: 크기 미상이면 골격 자체를 못 만든다.
  });

  it('QA D-2 artifact 슬롯 목록이 파일 목록에 밀려나지 않는다(병기)', () => {
    const body = functionBody(app, 'renderSlotList');
    expect(body).toContain('renderArtifactSlotRows(box, true)'); // 파일 목록 뒤에 이어 그린다.
    expect(body).toContain('renderArtifactSlotRows(box, false)'); // 기존 분기도 같은 함수를 쓴다(이중구현 0).
    expect(functionBody(app, 'renderArtifactSlotRows')).toContain('selectSlot(slot.slotId)'); // 선택 동작 보존.
  });

  it('T9 loadPlaceRoi 가 404 를 placeRoiFileMissing 으로 기록한다(신규 주차장 신호)', () => {
    const body = functionBody(app, 'loadPlaceRoi');
    expect(body).toContain('state.placeRoiFileMissing = res.status === 404');
  });

  it('T10 renderSlotList 가 파일 ROI 가 있으면 평면 목록을 쓴다(새로 그린 면이 목록에 보인다)', () => {
    const body = functionBody(app, 'renderSlotList');
    expect(body).toContain('placeSpaceCount() > 0');
  });
});

describe('S1 닫힘 렌더 + 커밋 연속성', () => {
  it('S1-T1 drawPlaceDrawOverlay 가 pts.length === 4 에서 closePath + 채움을 한다', () => {
    const body = functionBody(app, 'drawPlaceDrawOverlay');
    const at = body.indexOf('pts.length === 4');
    expect(at).toBeGreaterThan(-1);
    const seg = body.slice(at, at + 500);
    expect(seg).toContain('ctx.closePath()');
    expect(seg).toContain('ctx.fill()');
  });

  it('S1-T2 3점 단계에 p3→p1 점선 닫힘 예고가 있다(실제로 화면이 바뀌는 유일한 경로)', () => {
    const body = functionBody(app, 'drawPlaceDrawOverlay');
    const at = body.indexOf('pts.length === 3');
    expect(at).toBeGreaterThan(-1);
    const seg = body.slice(at, at + 400);
    expect(seg).toContain('setLineDash');
    expect(seg).toContain('pts[2]');
    expect(seg).toContain('pts[0]'); // 첫 점으로 되돌아간다 = 닫힘 예고.
  });

  it('S1-T3 커밋 순서 계약: state.placeRoi 대입 < ensureFloorVisible < endPlaceDraw', () => {
    const body = functionBody(app, 'placeDrawClick');
    const assign = body.indexOf('state.placeRoi = placeRoi');
    const ensure = body.indexOf('ensureFloorVisible()');
    // endPlaceDraw() 는 상단 '프리셋 바뀜' 취소 가드에도 있다 → 커밋 분기의 것(마지막)을 집는다.
    const end = body.lastIndexOf('endPlaceDraw()');
    expect(assign).toBeGreaterThan(-1);
    expect(ensure).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(-1);
    expect(assign).toBeLessThan(ensure); // 초록 소스 확보가 먼저.
    expect(ensure).toBeLessThan(end); // 뒤로 가면 노랑도 초록도 없는 빈 프레임이 생긴다.
  });

  it('S1-T4 1~2점 경로(폴리라인·고무줄선·점 원)가 그대로 남아 있다', () => {
    const body = functionBody(app, 'drawPlaceDrawOverlay');
    expect(body).toContain('if (pts.length > 1) {');
    expect(body).toContain('placeDrawCursor'); // 고무줄선.
    expect(body).toContain('ctx.arc('); // 확정 점 원.
    expect(body).toContain("ctx.fillText(String(i + 1)"); // 순번 라벨.
  });

  it('S5-T3 그리기 off 면 조기 return 이다(캔버스 경로 변화 0)', () => {
    const body = functionBody(app, 'drawPlaceDrawOverlay');
    expect(body).toContain('if (!draw || draw.key !== key) return;');
  });
});

describe('S2 #roi-floor 강제 ON', () => {
  it('S2-T1 네 진입점 전부에서 ensureFloorVisible 을 호출한다(F-3: 목록 행 클릭 포함)', () => {
    expect(functionBody(app, 'togglePlaceDraw')).toContain('ensureFloorVisible()');
    expect(functionBody(app, 'placeDrawClick')).toContain('ensureFloorVisible()');
    expect(functionBody(app, 'selectPlaceSpace')).toContain('ensureFloorVisible()');
    const w = functionBody(app, 'wire');
    const at = w.indexOf("$('place-edit-vertex').addEventListener('change'");
    expect(at).toBeGreaterThan(-1);
    expect(w.slice(at, at + 400)).toContain('ensureFloorVisible()');
  });

  it('F-3 목록 행 클릭의 강제 ON 이 렌더보다 **먼저**다(1프레임 지연 없음)', () => {
    const body = functionBody(app, 'selectPlaceSpace');
    expect(body.indexOf('ensureFloorVisible()')).toBeLessThan(body.indexOf('drawRoiOverlay()'));
  });

  it('S2-T2 자동 경로(drawRoiOverlay·drawFileFloorRoi·loadPlaceRoi)에는 없다 — 폴링·렌더가 토글을 켜지 않는다', () => {
    for (const fn of ['drawRoiOverlay', 'drawFileFloorRoi', 'loadPlaceRoi']) {
      expect(functionBody(app, fn), `${fn} 에 강제 ON 없음`).not.toContain('ensureFloorVisible');
    }
  });

  it('S2-T3 표시(drawPlaceDrawOverlay)·히트테스트(hitTestPlaceVertex)의 roi-floor 조건이 그대로다(대칭 유지)', () => {
    expect(functionBody(app, 'drawPlaceDrawOverlay')).toContain("$('roi-floor').checked");
    expect(functionBody(app, 'hitTestPlaceVertex')).toContain("roi-floor");
    expect(functionBody(app, 'drawFileFloorRoi')).toContain("if (!$('roi-floor').checked) return;");
  });
});

describe('S3 초기화(#place-clear)', () => {
  it('S3-T1 첫 분기가 state.placeDraw 다(비파괴 우선)', () => {
    const body = functionBody(app, 'clearPlaceDrawing');
    const first = body.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'))[0];
    expect(first).toBe('if (state.placeDraw) {');
    expect(body.indexOf('state.placeDraw')).toBeLessThan(body.indexOf('state.selectedPlaceIdx'));
  });

  it('S3-T2 그리는 중 분기는 placeRoi 를 건드리지 않고 모드를 유지한다(endPlaceDraw 호출 없음)', () => {
    const body = functionBody(app, 'clearPlaceDrawing');
    expect(body).not.toContain('state.placeRoi =');
    expect(body).not.toContain('endPlaceDraw');
    expect(body).toContain('beginPlaceDraw(state.placeDraw.key)'); // 같은 프리셋에서 0점부터 재개.
  });

  it('S3-T3 면 삭제는 deletePlaceSpace 위임(중복 구현 0) · S3-T4 fetch 없음', () => {
    const body = functionBody(app, 'clearPlaceDrawing');
    expect(body).toContain('deletePlaceSpace()');
    expect(body).not.toContain('removePlaceSpace');
    expect(body).not.toContain('fetch');
  });

  it('#place-clear 가 index.html 에 있고 wire() 에서 결선된다', () => {
    expect(html).toMatch(/<button id="place-clear"/);
    expect(functionBody(app, 'wire')).toContain("$('place-clear').addEventListener('click', clearPlaceDrawing)");
  });
});

describe('S4 전체삭제 + 되돌리기', () => {
  it('S4-T4 확인 단계가 있고 확인문이 범위·저장·되돌리기를 명시한다 · fetch 없음', () => {
    const body = functionBody(app, 'clearCurrentPresetSpaces');
    expect(body).toContain('confirm(');
    expect(body).toContain('프리셋');
    expect(body).toContain('저장');
    expect(body).toContain('되돌리기');
    expect(body).toContain('currentFrameKey()'); // 범위 = 화면에 보이는 프레임(drawFileFloorRoi 와 동일 기준).
    expect(body).not.toContain('fetch');
    expect(body).toContain('if (!ok) return;'); // 취소하면 아무 일도 없다.
  });

  it('S4-T5 스냅샷이 삭제보다 앞이고 placeRoiUndo 를 쓴다 · placeRoiBackup 은 건드리지 않는다', () => {
    const body = functionBody(app, 'clearCurrentPresetSpaces');
    const snap = body.indexOf('snapshotPlaceRoi(');
    const clear = body.indexOf('clearPresetSpaces(');
    const seal = body.indexOf('sealPlaceRoiUndo()');
    expect(snap).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(-1);
    expect(snap).toBeLessThan(clear); // 파괴 앞에서 떠야 복구된다.
    expect(seal).toBeGreaterThan(clear); // 봉인은 파괴 뒤(결과 지문).
    expect(body).not.toContain('placeRoiBackup');
    // 스냅샷 본체는 전체 맵 깊은 복사다(프리셋 단위로는 전역 재번호를 복구할 수 없다).
    expect(functionBody(app, 'snapshotPlaceRoi')).toContain('JSON.parse(JSON.stringify(state.placeRoi ?? {}))');
    expect(functionBody(app, 'snapshotPlaceRoi')).toContain('state.placeRoiUndo =');
  });

  it('F-1 초기화의 면 삭제 분기도 복구 가능하다 — 스냅샷이 deletePlaceSpace 앞에 있다(되돌리기 일원화)', () => {
    const body = functionBody(app, 'clearPlaceDrawing');
    const snap = body.indexOf('snapshotPlaceRoi(');
    const del = body.indexOf('deletePlaceSpace()');
    const seal = body.indexOf('sealPlaceRoiUndo()');
    expect(snap).toBeGreaterThan(-1);
    expect(snap).toBeLessThan(del); // 파괴 앞.
    expect(seal).toBeGreaterThan(del); // 파괴 뒤.
    expect(body).toContain("'되돌리기' 로 복구할 수 있습니다"); // 복구 가능 사실을 사용자에게 알린다.
    // 전체삭제와 **같은** 스냅샷 필드를 쓴다(두 벌 관리 금지).
    expect(functionBody(app, 'clearCurrentPresetSpaces')).toContain('snapshotPlaceRoi(');
  });

  it('F-1b 기존 삭제 버튼(deletePlaceSpace)은 무변경이다 — 회귀 0', () => {
    const body = functionBody(app, 'deletePlaceSpace');
    expect(body).not.toContain('placeRoiUndo'); // 스냅샷은 호출자(초기화)가 뜬다.
    expect(body).toContain('removePlaceSpace(state.placeRoi, state.selectedPlaceIdx)');
  });

  it('F-2 되돌리기가 이후 편집을 조용히 되감지 않는다 — 지문이 다르면 확인을 묻는다', () => {
    const body = functionBody(app, 'undoPlaceRoi');
    const guard = body.indexOf('snap.after');
    const restore = body.indexOf('state.placeRoi = snap.placeRoi');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(restore); // 복원 전에 묻는다.
    expect(body).toContain('confirm(');
    expect(body).toContain('함께 사라집니다');
    expect(body).toContain('if (!ok) return;');
    expect(functionBody(app, 'sealPlaceRoiUndo')).toContain('JSON.stringify(state.placeRoi ?? {})');
  });

  it('S4-T6 저장 성공 시 스냅샷을 소진한다', () => {
    expect(functionBody(app, 'savePlaceRoi')).toContain('state.placeRoiUndo = null');
  });

  it('undoPlaceRoi 가 스냅샷 복원 후 소진하고 선택을 해제한다', () => {
    const body = functionBody(app, 'undoPlaceRoi');
    expect(body).toContain('state.placeRoi = snap.placeRoi');
    expect(body).toContain('state.placeRoiUndo = null');
    expect(body).toContain('state.selectedPlaceIdx = null');
    expect(body).toContain('markPlaceDirty'); // 되돌려도 여전히 미저장이다.
    expect(body).not.toContain('fetch');
  });

  it('버튼 문구·title 이 범위(현재 프리셋)를 명시하고 wire() 에서 결선된다', () => {
    const tag = html.match(/<button id="place-clear-preset"[^>]*>[^<]*</)?.[0];
    expect(tag).toBeTruthy();
    expect(tag).toContain('이 프리셋 전체삭제');
    expect(tag).toContain('다른 프리셋·다른 카메라는 그대로');
    expect(html).toMatch(/<button id="place-undo" disabled/); // 스냅샷 없으면 잠김(초기 상태).
    const w = functionBody(app, 'wire');
    expect(w).toContain("$('place-clear-preset').addEventListener('click', clearCurrentPresetSpaces)");
    expect(w).toContain("$('place-undo').addEventListener('click', undoPlaceRoi)");
  });

  it("'되돌리기' disabled 동기화가 renderPlaceSelectionInfo 의 조기 return **위**에 있다", () => {
    const body = functionBody(app, 'renderPlaceSelectionInfo');
    const undo = body.indexOf("$('place-undo')");
    const early = body.indexOf('if (state.selectedPlaceIdx == null)');
    expect(undo).toBeGreaterThan(-1);
    expect(early).toBeGreaterThan(-1);
    expect(undo).toBeLessThan(early); // 선택이 없어도 되돌리기 상태는 갱신돼야 한다.
  });

  it("'이 프리셋 전체삭제' 는 disabled 로 잠기지 않는다(카메라 전환 시 잘못 굳는 무반응 방지)", () => {
    // 렌더 경로가 이 버튼의 disabled 를 건드리지 않는다 — 빈 프리셋 방어는 클릭 시점 안내 문구.
    expect(functionBody(app, 'renderPlaceSelectionInfo')).not.toContain("$('place-clear-preset')");
    expect(html.match(/<button id="place-clear-preset"[^>]*>/)?.[0]).not.toContain('disabled');
    expect(functionBody(app, 'clearCurrentPresetSpaces')).toContain('지울 주차면이 없습니다');
  });
});

describe('거짓 서술 정정(F-6)', () => {
  it('"수동 드로잉 경로는 그대로 유지된다" 는 문장이 더는 없다', () => {
    expect(app).not.toContain('수동 드로잉 경로는 그대로 유지된다');
    expect(html).not.toContain('수동 드로잉을 쓴다');
  });
});
