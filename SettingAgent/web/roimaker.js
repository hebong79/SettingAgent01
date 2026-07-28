// ROIMaker(ROI 편집 탭) DOM 결선·이벤트(환경 의존). 순수 로직은 roimakerCore.js.
//
// 설계서: docs/20260728_113743_ROIMaker_수동ROI드로잉_페이지_설계.md
//
// ★ 격리 규약(회귀 방지의 핵심):
//   - 이 모듈은 **#rm-* 요소에만** 리스너를 건다. 제어탭 오버레이(#overlay)를 절대 건드리지 않는다.
//   - app.js 와 직접 import 관계가 없다. 탭 전환은 document 의 'sv:tab' 커스텀 이벤트로만 받는다.
//   - 미저장 편집 버퍼는 이 페이지 안에만 존재한다(마스터 지시 #15).

import { toPixelQuad, normalizePtzCamRoi, normalizeGlobalIdx, findPresetPtz } from './core.js';
import { mutFetch } from './token.js'; // 변이 요청 토큰 부착(서버 변이 게이트 대응).
import {
  createRoiMakerState,
  loadSpaces,
  toggleDrawMode,
  addEmptySpace,
  addDraftPoint,
  undoDraftPoint,
  cancelDraft,
  closeDraft,
  selectSpace,
  hitTest,
  moveVertex,
  deleteRoi,
  markAllDirty,
  visiblePolygons,
  buildRoiMakerList,
  validateForSave,
  buildSavePayload,
  presetKey,
  MIN_POINTS,
} from './roimakerCore.js';

const $ = (id) => document.getElementById(id);
const api = (path) => `/viewer/api${path}`;
/** 정점 핸들 히트 반경(px). app.js HANDLE_PX 와 같은 감각. */
const HANDLE_PX = 8;

const rm = {
  state: createRoiMakerState(),
  source: '',
  sourceDetails: {},
  cameras: [],
  cam: null,
  preset: null,
  scope: 'preset',
  active: false, // ROI 편집 탭이 보이는 중인가
  frozen: false, // 그리기용으로 프레임을 고정했는가
  drag: null, // { idx, vertex, last:{nx,ny} }
  cursor: null, // 고무줄 미리보기용 커서 위치(정규화)
};

let frame = null;
let overlay = null;

// --- 유틸 ---------------------------------------------------------------

function key() {
  return presetKey(rm.cam, rm.preset);
}

function setMsg(text, kind = '') {
  const el = $('rm-msg');
  if (!el) return;
  el.textContent = text;
  el.className = `map-msg${kind ? ` ${kind}` : ''}`;
}

/** 캔버스 마우스 이벤트 → 정규화 좌표(app.js eventToNorm 과 같은 식·같은 분모). */
function eventToNorm(e) {
  const r = overlay.getBoundingClientRect();
  return { nx: (e.clientX - r.left) / r.width, ny: (e.clientY - r.top) / r.height };
}

// --- 데이터 로드 --------------------------------------------------------

async function loadSources() {
  try {
    const res = await fetch(api('/health'), { cache: 'no-store' });
    const data = res.ok ? await res.json() : { sources: [] };
    rm.sourceDetails = Object.fromEntries((data.sourceDetails ?? []).map((d) => [d.id, d]));
    const sel = $('rm-source');
    sel.innerHTML = '';
    for (const id of data.sources ?? []) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = id;
      sel.appendChild(o);
    }
    if ((data.sources ?? []).length) {
      rm.source = data.sources[0];
      sel.value = rm.source;
    }
  } catch {
    /* 네트워크 실패 → 목록 비움(조용히) */
  }
}

async function loadCameras() {
  try {
    const q = rm.source ? `?source=${encodeURIComponent(rm.source)}` : '';
    const res = await fetch(api(`/cameras${q}`), { cache: 'no-store' });
    rm.cameras = res.ok ? (await res.json()).cameras ?? [] : [];
  } catch {
    rm.cameras = [];
  }
  renderCamSelect();
}

function renderCamSelect() {
  const sel = $('rm-cam');
  sel.innerHTML = '';
  for (const c of rm.cameras) {
    const o = document.createElement('option');
    o.value = c.camIdx;
    o.textContent = `${c.name} (cam ${c.camIdx})`;
    sel.appendChild(o);
  }
  if (rm.cameras.length) {
    if (!rm.cameras.some((c) => c.camIdx === rm.cam)) rm.cam = rm.cameras[0].camIdx;
    sel.value = rm.cam;
  }
  renderPresetSelect();
}

function renderPresetSelect() {
  const sel = $('rm-preset');
  sel.innerHTML = '';
  const cam = rm.cameras.find((c) => c.camIdx === rm.cam);
  const presets = cam?.presets ?? [];
  for (const p of presets) {
    const o = document.createElement('option');
    o.value = p.presetIdx;
    o.textContent = `${p.label} (#${p.presetIdx})`;
    sel.appendChild(o);
  }
  if (presets.length) {
    if (!presets.some((p) => p.presetIdx === rm.preset)) rm.preset = presets[0].presetIdx;
    sel.value = rm.preset;
  }
}

/**
 * 정본(PtzCamRoi.json) 재조회 → 편집 버퍼 재구성. 미저장 편집은 버려진다.
 * 전역번호가 재부여되면(다른 화면에서 주차면을 지운 경우 등) 저장 전에 경고한다 — 저장하면
 * DB slot_id 와 어긋날 수 있고, 그 상태는 sync-roi 가 409 로 막는다(설계서 §8 위험 2).
 */
async function loadRoi() {
  try {
    const res = await fetch('/capture/place-roi', { cache: 'no-store' });
    if (!res.ok) {
      setMsg('PtzCamRoi.json 을 읽지 못했습니다(서버 미설정이거나 파일 없음)', 'warn');
      return;
    }
    const { byPreset } = normalizePtzCamRoi(await res.json());
    const norm = normalizeGlobalIdx(byPreset);
    rm.state = loadSpaces(rm.state, norm.placeRoi);
    // 파일이 프리셋별 번호를 쓰고 있었다면 버퍼가 파일과 **전 프리셋에서** 다르다 → 전부 저장 대상.
    // (일부만 저장하면 파일이 혼합 번호 상태가 되어 다음 로드에서 전역번호가 밀린다 — 라이브 실측 결함.)
    if (norm.changed) rm.state = markAllDirty(rm.state);
    setMsg(
      norm.changed
        ? '전역번호를 재부여했습니다(파일이 프리셋별 번호 사용) — 저장하면 전 프리셋이 함께 기록됩니다'
        : `불러옴: ${Object.keys(rm.state.spaces).length}개 프리셋`,
      norm.changed ? 'warn' : '',
    );
  } catch (e) {
    setMsg(`불러오기 실패: ${e}`, 'warn');
  }
  render();
}

// --- 라이브 프레임 -------------------------------------------------------

function streamUrl() {
  const p = new URLSearchParams({ cam: rm.cam, preset: rm.preset });
  if (rm.source) p.set('source', rm.source);
  // ptz 파라미터를 주지 않는다 → 서버가 프리셋 기준으로 렌더한다(실카 RTSP 도 이동 명령이 되지 않는다).
  return api(`/stream?${p.toString()}`);
}

function startStream() {
  if (rm.cam == null || rm.preset == null) return;
  rm.frozen = false;
  frame.src = streamUrl();
}

/**
 * 카메라/프리셋 선택 → **실제로 그 프리셋으로 이동**시킨 뒤 스트림을 다시 연다(마스터 요청).
 * 스트림 URL 의 preset 파라미터만 바꾸면 시뮬레이터가 현재 물리 위치를 계속 렌더해 화면이 그대로다.
 * 제어탭 '이동' 버튼과 같은 경로(POST /viewer/api/move + 프리셋 PTZ).
 * 프리셋 PTZ 를 모르면(일부 실카) 이동을 건너뛰고 스트림만 다시 연다 — 조용히 틀린 위치로 움직이지 않는다.
 */
async function gotoPreset() {
  const ptz = findPresetPtz(rm.cameras, rm.cam, rm.preset);
  if (!ptz) {
    setMsg('이 프리셋의 PTZ 값이 없어 이동을 건너뜁니다(스트림만 갱신)', 'warn');
    startStream();
    return;
  }
  try {
    const res = await mutFetch(api('/move'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: rm.source || undefined, cam: rm.cam, ...ptz }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) setMsg(`프리셋 이동 실패: ${data.error ?? res.status}`, 'warn');
  } catch (e) {
    setMsg(`프리셋 이동 실패(네트워크): ${e}`, 'warn');
  }
  startStream();
}

/**
 * 대상(소스/카메라/프리셋)이 바뀔 때의 공통 처리.
 * 그리는 중이었다면 draft 를 버리고 정지로 돌아간다 — 찍어둔 점은 **이전 프레임 좌표계**의 것이라
 * 새 화면에서 의미가 없다(조용히 엉뚱한 좌표로 저장되는 것을 막는다).
 */
async function retarget() {
  if (rm.state.mode === 'drawing') rm.state = toggleDrawMode(cancelDraft(rm.state));
  rm.cursor = null;
  rm.state = selectSpace(rm.state, null, null);
  await gotoPreset();
  render();
}

function stopStream() {
  frame.removeAttribute('src');
}

/**
 * 그리기 시작 시 현재 프레임을 정지 화면으로 고정한다(마스터 지시 #16).
 * 흔들리는 영상 위에서는 정점을 맞출 수 없고, 그리는 도중 PTZ 가 움직이면 이미 찍은 점이 무의미해진다.
 * 프레임이 아직 안 들어왔으면(naturalWidth 0) 고정하지 않고 라이브 상태로 진행한다(강등).
 */
function freezeFrame() {
  if (!frame.naturalWidth) return false;
  const c = document.createElement('canvas');
  c.width = frame.naturalWidth;
  c.height = frame.naturalHeight;
  c.getContext('2d').drawImage(frame, 0, 0);
  try {
    frame.src = c.toDataURL('image/jpeg', 0.92);
    rm.frozen = true;
    return true;
  } catch {
    return false; // 캔버스 오염 등 — 라이브 상태로 계속.
  }
}

// --- 렌더 ---------------------------------------------------------------

function render() {
  drawOverlay();
  renderList();
  renderToolbar();
}

function renderToolbar() {
  const drawing = rm.state.mode === 'drawing';
  const btn = $('rm-draw-toggle');
  btn.textContent = drawing ? '정지' : '시작';
  btn.classList.toggle('active', drawing);
  overlay.classList.toggle('drawing', drawing); // 조준 커서.
  const sel = rm.state.selected;
  const target = sel ? (rm.state.spaces[sel.key] ?? []).find((sp) => sp.idx === sel.idx) : null;
  // 미저장 신규(빈 번호 포함)는 목록에서 제거할 수 있어야 한다 — '추가' 오조작을 되돌릴 방법이 필요하다.
  $('rm-delete').disabled = !target || (!target.points.length && target.origin !== 'new');
  $('rm-add').disabled = drawing; // 그리는 중에는 번호만 만들 수 없다(모드 혼선 방지).
  $('rm-hint').textContent = drawing
    ? `좌클릭 = 점 추가 · 우클릭 = 마무리(${MIN_POINTS}점 이상) · Backspace = 마지막 점 취소 · Esc = 취소`
    : '정지 상태 — 폴리곤 정점을 드래그해 수정하거나, 목록/화면에서 주차면을 선택합니다';
}

function drawOverlay() {
  overlay.width = frame.clientWidth;
  overlay.height = frame.clientHeight;
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!overlay.width || !overlay.height) return;

  const polys = visiblePolygons({
    spaces: rm.state.spaces,
    key: key(),
    scope: rm.scope,
    selected: rm.state.selected,
  });
  for (const p of polys) {
    if (p.empty) continue; // ROI 가 지워진 주차면은 그릴 것이 없다(목록에는 남는다).
    drawPolygon(ctx, p);
  }
  if (rm.state.draft?.points?.length) drawDraft(ctx, rm.state.draft.points);
}

function drawPolygon(ctx, p) {
  const pts = toPixelQuad(p.points, overlay.width, overlay.height);
  ctx.save();
  // 타 프리셋(전체 보기)은 좌표계가 달라 위치가 맞지 않는다 → 흐린 점선 + 편집 불가 표시.
  if (!p.editable) {
    ctx.globalAlpha = 0.35;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#94a3b8';
  } else if (p.selected) {
    ctx.strokeStyle = '#22d3ee';
    ctx.fillStyle = 'rgba(34, 211, 238, 0.18)';
  } else {
    ctx.strokeStyle = p.dirty ? '#facc15' : '#4ade80';
    ctx.fillStyle = p.dirty ? 'rgba(250, 204, 21, 0.12)' : 'rgba(74, 222, 128, 0.10)';
  }
  if (p.dirty && p.editable) ctx.setLineDash([6, 3]); // 미저장 = 점선.
  ctx.lineWidth = p.selected ? 3 : 2;

  ctx.beginPath();
  ctx.moveTo(pts[0].px, pts[0].py);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].px, pts[i].py);
  ctx.closePath();
  if (p.editable) ctx.fill();
  ctx.stroke();

  // 선택 폴리곤은 정점 핸들을 보여준다(드래그 가능함을 드러낸다).
  if (p.selected && p.editable) {
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#0ea5e9';
    ctx.lineWidth = 2;
    for (const q of pts) {
      ctx.fillRect(q.px - 4, q.py - 4, 8, 8);
      ctx.strokeRect(q.px - 4, q.py - 4, 8, 8);
    }
  }

  // 라벨(전역번호 + 4점 아님 경고).
  const cx = pts.reduce((s, q) => s + q.px, 0) / pts.length;
  const cy = pts.reduce((s, q) => s + q.py, 0) / pts.length;
  ctx.setLineDash([]);
  ctx.globalAlpha = p.editable ? 1 : 0.5;
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#0f172a';
  ctx.strokeStyle = '#f8fafc';
  ctx.lineWidth = 3;
  const label = `#${p.idx}${p.warn ? ' ⚠4점아님' : ''}${p.editable ? '' : ' (타 프리셋)'}`;
  ctx.strokeText(label, cx, cy);
  ctx.fillText(label, cx, cy);
  ctx.restore();
}

function drawDraft(ctx, points) {
  const pts = toPixelQuad(points, overlay.width, overlay.height);
  ctx.save();
  ctx.strokeStyle = '#f472b6';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pts[0].px, pts[0].py);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].px, pts[i].py);
  ctx.stroke();
  // 마지막 정점 → 커서 고무줄(아직 확정되지 않은 변).
  if (rm.cursor) {
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(pts[pts.length - 1].px, pts[pts.length - 1].py);
    ctx.lineTo(rm.cursor.nx * overlay.width, rm.cursor.ny * overlay.height);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.fillStyle = '#f472b6';
  for (const q of pts) {
    ctx.beginPath();
    ctx.arc(q.px, q.py, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function renderList() {
  const box = $('rm-list');
  box.innerHTML = '';
  const rows = buildRoiMakerList({
    spaces: rm.state.spaces,
    key: key(),
    scope: rm.scope,
    selected: rm.state.selected,
  });
  if (!rows.length) {
    box.textContent = '표시할 주차면이 없습니다';
    return;
  }
  for (const r of rows) {
    const div = document.createElement('div');
    div.className = 'rm-row';
    if (r.selected) div.classList.add('selected');
    if (!r.current) div.classList.add('other');
    const badges = [
      r.empty ? '<span class="rm-badge empty">ROI 없음</span>' : '',
      r.dirty ? '<span class="rm-badge dirty">미저장</span>' : '',
      r.warn ? '<span class="rm-badge warn">4점 아님</span>' : '',
    ].join('');
    div.innerHTML =
      `<b>#${r.idx}</b> <span class="rm-dim">cam${r.cam}-preset${r.preset}</span> ` +
      `<span class="rm-dim">${r.pointCount}점</span> ${badges}`;
    div.addEventListener('click', () => onListClick(r));
    box.appendChild(div);
  }
}

async function onListClick(row) {
  // 다른 프리셋 행을 고르면 그 프리셋으로 **카메라를 이동**시킨다(선택이 화면과 어긋나지 않게).
  if (row.key !== key()) {
    if (rm.state.mode === 'drawing') rm.state = toggleDrawMode(cancelDraft(rm.state));
    rm.cam = row.cam;
    rm.preset = row.preset;
    $('rm-cam').value = rm.cam;
    renderPresetSelect();
    $('rm-preset').value = rm.preset;
    await gotoPreset();
  }
  rm.state = selectSpace(rm.state, row.key, row.idx);
  render();
}

// --- 마우스 · 키보드 ------------------------------------------------------

function onMouseDown(e) {
  if (e.button !== 0) return; // 좌클릭만(우클릭은 contextmenu 에서 처리).
  const { nx, ny } = eventToNorm(e);
  if (rm.state.mode === 'drawing') {
    rm.state = addDraftPoint(rm.state, nx, ny);
    render();
    return;
  }
  // 정지 모드 = 편집(요구 7). 정점이면 드래그 시작, 내부면 선택, 빈 곳이면 해제.
  const tolX = HANDLE_PX / (overlay.width || 1);
  const tolY = HANDLE_PX / (overlay.height || 1);
  const hit = hitTest({
    spaces: rm.state.spaces,
    key: key(),
    scope: rm.scope,
    selected: rm.state.selected,
    nx, ny, tolX, tolY,
  });
  if (!hit) {
    rm.state = selectSpace(rm.state, null, null);
    render();
    return;
  }
  rm.state = selectSpace(rm.state, key(), hit.idx);
  if (hit.vertex != null) {
    rm.drag = { idx: hit.idx, vertex: hit.vertex, last: { nx, ny } };
    e.preventDefault();
  }
  render();
}

function onMouseMove(e) {
  if (rm.state.mode === 'drawing' && rm.state.draft?.points?.length) {
    rm.cursor = eventToNorm(e);
    drawOverlay(); // 고무줄만 갱신(목록·툴바는 그대로).
    return;
  }
  if (!rm.drag) return;
  const { nx, ny } = eventToNorm(e);
  rm.state = moveVertex(rm.state, key(), rm.drag.idx, rm.drag.vertex, nx - rm.drag.last.nx, ny - rm.drag.last.ny);
  rm.drag.last = { nx, ny };
  drawOverlay();
}

function onMouseUp() {
  if (!rm.drag) return;
  rm.drag = null;
  render(); // 목록의 '미저장' 배지 갱신.
}

function onContextMenu(e) {
  e.preventDefault(); // 그리기 중이 아니어도 캔버스 위 기본 메뉴는 막는다(우클릭=마무리 규약 일관).
  if (rm.state.mode !== 'drawing') return;
  const r = closeDraft(rm.state, key());
  rm.state = r.state;
  rm.cursor = null;
  if (r.error) {
    setMsg(r.error, 'warn');
  } else {
    // filled = 비어 있던 슬롯(‘추가’로 만든 번호 또는 ROI 를 지운 슬롯)에 채워 넣은 경우.
    const head = r.filled != null ? `#${r.filled} 에 ROI 를 그렸습니다(미저장)` : '주차면이 추가되었습니다(미저장)';
    setMsg(r.warning ? `${head} — ${r.warning}` : head, r.warning ? 'warn' : '');
  }
  render();
}

function onKeyDown(e) {
  if (!rm.active) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (rm.state.mode !== 'drawing') return;
  if (e.key === 'Escape') {
    rm.state = cancelDraft(rm.state);
    rm.cursor = null;
    render();
  } else if (e.key === 'Backspace') {
    e.preventDefault();
    rm.state = undoDraftPoint(rm.state);
    render();
  }
}

// --- 버튼 ---------------------------------------------------------------

function onToggleDraw() {
  const next = toggleDrawMode(rm.state);
  rm.state = next;
  rm.cursor = null;
  if (next.mode === 'drawing') {
    const ok = freezeFrame();
    setMsg(ok ? '그리기 시작 — 화면을 정지 프레임으로 고정했습니다' : '그리기 시작(프레임 고정 실패 — 라이브 상태)');
  } else {
    startStream(); // 라이브 재개.
    setMsg('그리기 정지 — 정점을 드래그해 수정할 수 있습니다');
  }
  render();
}

/** '추가' — 주차면 번호(id)만 만들고 선택 상태로 둔다. 곧바로 '시작' 하면 그 번호에 그려진다. */
function onAdd() {
  const r = addEmptySpace(rm.state, key());
  rm.state = r.state;
  setMsg(`#${r.idx} 번호를 만들었습니다(ROI 없음 · 미저장) — '시작' 후 그리면 이 번호에 채워집니다`);
  render();
}

function onDelete() {
  const sel = rm.state.selected;
  if (!sel) {
    setMsg('삭제할 주차면을 먼저 선택하세요', 'warn');
    return;
  }
  const target = (rm.state.spaces[sel.key] ?? []).find((sp) => sp.idx === sel.idx);
  const wasNew = target?.origin === 'new';
  const r = deleteRoi(rm.state, sel.key, sel.idx);
  rm.state = r.state;
  setMsg(
    r.error ??
      (wasNew
        ? `#${sel.idx} 주차면을 목록에서 제거했습니다(아직 저장 전이라 번호까지 회수 · 미저장)`
        : `#${sel.idx} 의 ROI 를 지웠습니다(주차면과 전역번호는 유지 · 미저장)`),
    r.error ? 'warn' : '',
  );
  render();
}

/**
 * 저장(요구 12): ① 변경된 프리셋을 **직렬로** PUT(정본 파일) → ② DB 차등 동기 → ③ 서버 재조회.
 * 직렬 필수: 서버가 요청마다 readFile→apply→writeFile 하므로 병렬이면 갱신이 유실된다.
 * 부분 실패는 숨기지 않는다 — 어디까지 저장됐는지 그대로 표시한다.
 */
async function onSave() {
  const v = validateForSave(rm.state);
  if (!v.ok) {
    setMsg(`저장할 수 없습니다: ${v.errors.join(' / ')}`, 'warn');
    return;
  }
  const payload = buildSavePayload(rm.state);
  setMsg(`저장 중… (${payload.length}개 프리셋)`);
  let saved = 0;
  for (const item of payload) {
    try {
      const res = await mutFetch('/capture/place-roi', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          camId: item.camId,
          presetIdx: item.presetIdx,
          spaces: item.spaces,
          expectRawCount: item.expectRawCount,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setMsg(
          `저장 실패(cam${item.camId}:${item.presetIdx}): ${data.error ?? res.status}` +
            (saved ? ` — 앞의 ${saved}개 프리셋은 이미 저장됨` : ' — 파일 무변경'),
          'warn',
        );
        return;
      }
      saved++;
    } catch (e) {
      setMsg(`저장 실패(cam${item.camId}:${item.presetIdx}, 네트워크): ${e}`, 'warn');
      return;
    }
  }

  // DB 차등 반영(검출·점유·센터링 보존). 실패해도 파일은 이미 저장됐다는 사실을 숨기지 않는다.
  let dbNote = '';
  try {
    const res = await mutFetch('/capture/slots/sync-roi', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      setMsg(`파일은 저장됐지만 DB 반영 실패: ${data.error ?? res.status}`, 'warn');
      await loadRoi();
      return;
    }
    dbNote = ` · DB 갱신 ${data.updates}건 · 추가 ${data.inserts}건`;
    if (data.orphans?.length) dbNote += ` · DB 전용 잔여 ${data.orphans.length}건(삭제 안 함)`;
  } catch (e) {
    setMsg(`파일은 저장됐지만 DB 반영 실패(네트워크): ${e}`, 'warn');
    await loadRoi();
    return;
  }

  await loadRoi(); // 서버 정본 재조회 → 화면·목록 갱신(요구 12 후반).
  setMsg(`저장 완료: ${saved}개 프리셋${dbNote}${v.warnings.length ? ` · 경고 ${v.warnings.length}건` : ''}`);
}

// --- 탭 진입/이탈 --------------------------------------------------------

async function enter() {
  rm.active = true;
  if (!rm.cameras.length) {
    await loadSources();
    await loadCameras();
  }
  // 탭에 들어올 때마다 정본을 **다시 읽는다** — 정밀수집 탭·지면격자 등이 그 사이 파일을 바꿨을 수 있다
  // (마스터 실측 버그 2026-07-28: 한쪽에서 주차면을 추가해도 다른 쪽에 안 보인다).
  // ★ 미저장 편집이 있으면 덮어쓰지 않는다 — 그리던 작업을 조용히 버리지 않는다.
  if (rm.state.dirtyKeys.length) {
    setMsg("미저장 편집이 있어 새로고침하지 않았습니다 — '저장' 또는 '되돌리기' 후 최신 정본을 읽습니다", 'warn');
  } else {
    await loadRoi();
  }
  await gotoPreset(); // 탭 진입 시점에도 화면이 선택 프리셋과 일치해야 한다(스트림만 열면 물리 위치가 나온다).
  render();
}

function leave() {
  rm.active = false;
  stopStream();
}

// --- 결선 ---------------------------------------------------------------

function wire() {
  frame = $('rm-frame');
  overlay = $('rm-overlay');
  if (!frame || !overlay) return; // ROI 편집 뷰가 없는 페이지 — 무동작.

  overlay.addEventListener('mousedown', onMouseDown);
  overlay.addEventListener('mousemove', onMouseMove);
  overlay.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', () => { if (rm.active) drawOverlay(); });
  frame.addEventListener('load', () => { if (rm.active) drawOverlay(); });

  $('rm-draw-toggle').addEventListener('click', onToggleDraw);
  $('rm-add').addEventListener('click', onAdd);
  $('rm-delete').addEventListener('click', onDelete);
  $('rm-save').addEventListener('click', onSave);
  $('rm-reload').addEventListener('click', () => { void loadRoi(); }); // 미저장 편집을 버리고 정본 재조회.

  // 소스·카메라·프리셋 선택은 전부 retarget() 으로 모은다 → 카메라를 실제로 그 프리셋으로 이동시킨다.
  $('rm-source').addEventListener('change', async (e) => {
    rm.source = e.target.value;
    await loadCameras();
    await retarget();
  });
  $('rm-cam').addEventListener('change', async (e) => {
    rm.cam = Number(e.target.value);
    renderPresetSelect();
    await retarget();
  });
  $('rm-preset').addEventListener('change', async (e) => {
    rm.preset = Number(e.target.value);
    await retarget();
  });
  $('rm-view-scope').addEventListener('change', (e) => {
    rm.scope = e.target.value;
    render();
  });

  document.addEventListener('sv:tab', (e) => {
    if (e.detail?.tab === 'roimaker') void enter();
    else if (rm.active) leave();
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
else wire();
