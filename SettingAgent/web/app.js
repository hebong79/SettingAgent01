// SettingViewer DOM 결선·이벤트·스트림 오케스트레이션(환경 의존).
// 순수 로직은 core.js 에서 import.
import {
  toPixel,
  presetKey,
  slotLabel,
  clampZoom,
  stepPtz,
  createStreamLoop,
  captureProgress,
  mapAdvisory,
  pollPlan,
  clampPanelWidth,
  analyzeArtifact,
  findPresetPtz,
} from './core.js';

const $ = (id) => document.getElementById(id);
const api = (path) => `/viewer/api${path}`;

const state = {
  source: '',
  cam: 1,
  preset: 1,
  mode: 'preset',
  ptz: { pan: 0, tilt: 0, zoom: 1 },
  cameras: [], // CameraList.cameras
  mapping: null, // SetupArtifact
  isHucoms: false,
};

const frame = $('frame');
const overlay = $('overlay');

// --- 데이터 로드 ---------------------------------------------------------
async function loadCameras() {
  // no-store: 시뮬레이터 카메라/프리셋이 바뀌어도 항상 최신 목록을 받도록(브라우저 캐시 방지).
  const res = await fetch(api(`/cameras${state.source ? `?source=${encodeURIComponent(state.source)}` : ''}`), { cache: 'no-store' });
  if (!res.ok) return;
  const data = await res.json();
  state.cameras = data.cameras ?? [];
  renderCamSelect();
}

async function loadMapping() {
  try {
    const res = await fetch(api('/mapping'), { cache: 'no-store' });
    state.mapping = res.ok ? await res.json() : null;
  } catch {
    state.mapping = null;
  }
}

async function loadHealth() {
  try {
    const res = await fetch(api('/health'), { cache: 'no-store' });
    const ok = res.ok;
    $('badge-backend').classList.toggle('ok', ok);
    $('badge-camera').classList.toggle('ok', ok);
  } catch {
    /* ignore */
  }
}

// --- 셀렉트 렌더 ---------------------------------------------------------
function renderCamSelect() {
  const sel = $('sel-cam');
  sel.innerHTML = '';
  for (const c of state.cameras) {
    const o = document.createElement('option');
    o.value = c.camIdx;
    o.textContent = `${c.name} (cam ${c.camIdx})${c.enabled ? '' : ' [off]'}`;
    sel.appendChild(o);
  }
  if (state.cameras.length) {
    state.cam = state.cameras[0].camIdx;
    sel.value = state.cam;
  }
  renderPresetSelect();
}

function renderPresetSelect() {
  const sel = $('sel-preset');
  sel.innerHTML = '';
  const cam = state.cameras.find((c) => c.camIdx === state.cam);
  for (const p of cam?.presets ?? []) {
    const o = document.createElement('option');
    o.value = p.presetIdx;
    o.textContent = `${p.label} (#${p.presetIdx})`;
    sel.appendChild(o);
  }
  const presets = cam?.presets ?? [];
  if (presets.length) {
    state.preset = presets[0].presetIdx;
    sel.value = state.preset;
  }
  syncPtzFromPreset();
  renderSlotList();
}

/** '현재 PTZ' 표시를 선택 프리셋의 PTZ(/cameras 제공)로 동기화. 카메라 위치의 신뢰 원천(명령 기준). */
function syncPtzFromPreset() {
  const ptz = findPresetPtz(state.cameras, state.cam, state.preset);
  if (ptz) {
    state.ptz = { ...ptz };
    updatePtzDisplay();
  }
}

async function loadSources() {
  // health 응답의 sources 목록으로 소스 셀렉트 구성.
  try {
    const res = await fetch(api('/health'), { cache: 'no-store' });
    const data = res.ok ? await res.json() : { sources: [] };
    const sel = $('sel-source');
    sel.innerHTML = '';
    for (const id of data.sources ?? []) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = id;
      sel.appendChild(o);
    }
    if ((data.sources ?? []).length) {
      state.source = data.sources[0];
      sel.value = state.source;
    }
  } catch {
    /* ignore */
  }
}

// --- ROI 오버레이 --------------------------------------------------------
function drawRoiOverlay() {
  overlay.width = frame.clientWidth;
  overlay.height = frame.clientHeight;
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!state.mapping) return;
  const key = presetKey(state.cam, state.preset);
  const showVehicle = $('roi-vehicle').checked;
  const showPlate = $('roi-plate').checked;
  const globalIndex = state.mapping.globalIndex ?? [];
  for (const slot of state.mapping.slots ?? []) {
    const vrect = slot.roiByPreset?.[key];
    if (vrect && showVehicle) {
      const { px, py, pw, ph } = toPixel(vrect, overlay.width, overlay.height);
      ctx.strokeStyle = '#00e5ff';
      ctx.lineWidth = 2;
      ctx.strokeRect(px, py, pw, ph);
      ctx.fillStyle = '#00e5ff';
      ctx.fillText(slotLabel(slot.slotId, globalIndex), px + 2, py + 12);
    }
    const prect = slot.plateRoiByPreset?.[key];
    if (prect && showPlate) {
      const { px, py, pw, ph } = toPixel(prect, overlay.width, overlay.height);
      ctx.strokeStyle = '#ffd60a';
      ctx.lineWidth = 2;
      ctx.strokeRect(px, py, pw, ph);
    }
  }
}

function renderSlotList() {
  const box = $('slot-list');
  box.innerHTML = '';
  if (!state.mapping) return;
  const key = presetKey(state.cam, state.preset);
  const globalIndex = state.mapping.globalIndex ?? [];
  for (const slot of state.mapping.slots ?? []) {
    if (!slot.roiByPreset?.[key]) continue;
    const div = document.createElement('div');
    div.className = 'slot';
    div.textContent = `#${slotLabel(slot.slotId, globalIndex)} ${slot.slotId} (${slot.zone})`;
    box.appendChild(div);
  }
}

// --- 스트림 루프 ---------------------------------------------------------
const loop = createStreamLoop({
  makeUrl: (seq) => {
    const p = new URLSearchParams({ cam: state.cam, preset: state.preset, mode: state.mode, t: seq });
    if (state.source) p.set('source', state.source);
    if (state.mode === 'manual') {
      p.set('pan', state.ptz.pan);
      p.set('tilt', state.ptz.tilt);
      p.set('zoom', state.ptz.zoom);
    }
    return api(`/snapshot?${p.toString()}`);
  },
  fetchFn: (url, opt) => fetch(url, { ...opt, cache: 'no-store' }),
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  setImage: async (url) => {
    frame.src = url;
    if (frame.decode) await frame.decode().catch(() => {});
    drawRoiOverlay();
  },
  // onPtz 제거: 시뮬레이터 /req_img 응답 PTZ 가 항상 0/0/1 이라 '현재 PTZ' 를 덮어쓰면 표시가 깨지고
  // 수동 스트리밍 시 0/0/1 로 드리프트한다. 카메라 위치는 명령(프리셋/이동/PTZ버튼) 기준으로 추적한다.
});

function updatePtzDisplay() {
  $('ptz-pan').textContent = state.ptz.pan;
  $('ptz-tilt').textContent = state.ptz.tilt;
  $('ptz-zoom').textContent = state.ptz.zoom;
}

// --- 제어 ---------------------------------------------------------------
async function move(ptz) {
  const res = await fetch(api('/move'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: state.source || undefined, cam: state.cam, ...ptz }),
  });
  if (res.ok) {
    state.ptz = ptz;
    updatePtzDisplay();
    await loop.tick();
  }
  return res.ok;
}

/**
 * 프리셋 이동: 선택 프리셋으로 카메라를 실제 이동(현재 모드 무관).
 * 버그 수정 — 기존엔 loop.tick()만 호출해 수동 모드에선 PTZ override 가 가서 프리셋이 적용되지 않았음.
 * 프리셋 PTZ 가 있으면 /move(검증된 /req_move 경로)로 물리 이동, 없으면 preset 모드 스냅샷으로 강제 적용.
 */
async function gotoPreset() {
  const ptz = findPresetPtz(state.cameras, state.cam, state.preset);
  if (ptz) {
    await move(ptz); // /req_move + 갱신. state.ptz 도 프리셋 값으로 갱신됨.
    return;
  }
  // 폴백: 프리셋 PTZ 미제공(예: 일부 실카메라) → 현재 모드 무시하고 preset 모드 스냅샷.
  const p = new URLSearchParams({ cam: state.cam, preset: state.preset, mode: 'preset', t: Date.now() });
  if (state.source) p.set('source', state.source);
  try {
    const res = await fetch(api(`/snapshot?${p.toString()}`), { cache: 'no-store' });
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    frame.src = url;
    if (frame.decode) await frame.decode().catch(() => {});
    URL.revokeObjectURL(url);
    const pan = res.headers.get('X-PTZ-Pan');
    const tilt = res.headers.get('X-PTZ-Tilt');
    const zoom = res.headers.get('X-PTZ-Zoom');
    if (pan != null) state.ptz.pan = Number(pan);
    if (tilt != null) state.ptz.tilt = Number(tilt);
    if (zoom != null) state.ptz.zoom = Number(zoom);
    updatePtzDisplay();
    drawRoiOverlay();
  } catch {
    /* ignore */
  }
}

// --- 정밀 수집(장기 관측·반복 수집) ------------------------------------
let capPollTimer = null;

async function capFetchStatus() {
  try {
    const res = await fetch('/capture/status');
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

function renderCaptureStatus(status) {
  const { percent, label } = captureProgress(status ?? {});
  $('cap-bar').value = percent;
  $('cap-label').textContent = label;
  const adv = mapAdvisory(status ?? {});
  $('cap-advisory').innerHTML = '';
  for (const line of adv) {
    const div = document.createElement('div');
    div.className = 'adv-line';
    div.textContent = line;
    $('cap-advisory').appendChild(div);
  }
}

async function capPoll() {
  const status = await capFetchStatus();
  renderCaptureStatus(status);
  const plan = pollPlan(status?.state ?? 'idle');
  if (capPollTimer) {
    clearTimeout(capPollTimer);
    capPollTimer = null;
  }
  if (plan.poll) capPollTimer = setTimeout(capPoll, plan.intervalMs);
}

async function capStart() {
  $('cap-msg').textContent = '';
  const body = {
    count: Number($('cap-count').value) || 50,
    intervalMs: (Number($('cap-interval').value) || 30) * 1000,
    checkpointEvery: Number($('cap-checkpoint').value) || 10,
  };
  const res = await fetch('/capture/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  $('cap-msg').textContent = res.ok ? `시작됨 (run #${data.runId})` : `시작 실패: ${data.error ?? res.status}`;
  capPoll();
}

async function capStop() {
  const res = await fetch('/capture/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const data = await res.json().catch(() => ({}));
  $('cap-msg').textContent = res.ok ? '정지 요청됨' : `정지 실패: ${data.error ?? res.status}`;
  capPoll();
}

async function capFinalize() {
  const res = await fetch('/capture/finalize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    $('cap-msg').textContent = `최종화 완료: 슬롯 ${data.slots}, 전역 ${data.globalCount}`;
    await loadMapping(); // 정밀 결과를 검수 탭에 반영.
    drawRoiOverlay();
    renderSlotList();
  } else {
    $('cap-msg').textContent = `최종화 실패: ${data.error ?? res.status}`;
  }
}

// --- 분석(최종 셋업 산출물) --------------------------------------------
let lastArtifact = null;

async function fetchArtifact() {
  try {
    const res = await fetch(api('/mapping'), { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

function fmtRoi(roi) {
  if (!roi) return '-';
  const f = (n) => Number(n).toFixed(3);
  return `${f(roi.x)}, ${f(roi.y)}, ${f(roi.w)}, ${f(roi.h)}`;
}

function summaryCard(label, value) {
  const div = document.createElement('div');
  div.className = 'an-card';
  const v = document.createElement('div');
  v.className = 'an-card-v';
  v.textContent = String(value);
  const l = document.createElement('div');
  l.className = 'an-card-l';
  l.textContent = label;
  div.append(v, l);
  return div;
}

function buildTable(headers, rows) {
  const table = document.createElement('table');
  table.className = 'an-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const h of headers) {
    const th = document.createElement('th');
    th.textContent = h;
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    for (const c of r) {
      const td = document.createElement('td');
      td.textContent = String(c);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

async function renderAnalysis() {
  lastArtifact = await fetchArtifact();
  const a = analyzeArtifact(lastArtifact);
  const sum = $('an-summary');
  sum.innerHTML = '';

  if (!a.ok) {
    sum.textContent = '저장된 산출물이 없습니다. (셋업 또는 정밀 수집 최종화 후 생성됩니다)';
    ['an-presets', 'an-slots', 'an-warnings', 'an-report', 'an-raw'].forEach((id) => ($(id).innerHTML = ''));
    $('an-source').innerHTML = 'SettingAgent <code>data/setup_artifact.json</code> · 산출물 없음';
    return;
  }

  const t = a.totals;
  for (const [l, v] of [
    ['카메라', t.cameras], ['프리셋', t.presets], ['주차면', t.slots],
    ['전역 인덱스', t.globalSlots], ['번호판 ROI', t.withPlate], ['존', t.zones], ['경고', t.warnings],
  ]) {
    sum.appendChild(summaryCard(l, v));
  }
  $('an-source').innerHTML = `SettingAgent <code>data/setup_artifact.json</code> · 생성 ${a.createdAt ?? '-'}`;

  $('an-presets').innerHTML = '';
  $('an-presets').appendChild(
    buildTable(
      ['프리셋 키', '카메라', '프리셋', '라벨', '주차면 수'],
      a.perPreset.map((p) => [p.key, p.camIdx, p.presetIdx, p.label, p.slotCount]),
    ),
  );

  $('an-slots').innerHTML = '';
  $('an-slots').appendChild(
    buildTable(
      ['#', 'slotId', '존', '프리셋', 'ROI(x,y,w,h)', '번호판'],
      a.slots.map((s) => [s.globalIdx ?? '-', s.slotId, s.zone, s.presetKey, fmtRoi(s.roi), s.hasPlate ? '✓' : '-']),
    ),
  );

  const wbox = $('an-warnings');
  wbox.innerHTML = '';
  if (!a.warnings.length) {
    wbox.textContent = '경고 없음';
  } else {
    for (const w of a.warnings) {
      const div = document.createElement('div');
      div.className = 'an-warn';
      div.textContent = w;
      wbox.appendChild(div);
    }
  }

  $('an-report').textContent = a.report || '(LLM 리포트 없음)';
  $('an-raw').textContent = JSON.stringify(lastArtifact, null, 2);
}

function downloadArtifact() {
  const blob = new Blob([JSON.stringify(lastArtifact ?? {}, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'setup_artifact.json';
  a.click();
  URL.revokeObjectURL(url);
}

// --- 탭 전환 ------------------------------------------------------------
function setTab(tab) {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  const analyze = tab === 'analyze';
  document.querySelector('.viewport-wrap').hidden = analyze;
  $('panel-resizer').hidden = analyze;
  $('panel').hidden = analyze;
  $('analyze-view').hidden = !analyze;
  $('precise-box').hidden = tab !== 'precise';
  if (tab === 'precise') capPoll();
  if (analyze) renderAnalysis();
}

// --- 패널 너비 리사이즈(드래그 + localStorage 보존) ----------------------
const PANEL_W_KEY = 'sv.panelWidth';

function applyPanelWidth(px) {
  const w = clampPanelWidth(px);
  $('panel').style.width = `${w}px`;
  drawRoiOverlay(); // 뷰포트 폭 변동 → ROI 재배치
  return w;
}

function wirePanelResize() {
  const panel = $('panel');
  const handle = $('panel-resizer');
  // 저장된 너비 복원.
  const saved = Number(localStorage.getItem(PANEL_W_KEY));
  if (saved) applyPanelWidth(saved);

  let dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    // 패널 오른쪽 모서리는 고정 → 새 너비 = 오른쪽모서리 - 커서X (왼쪽 모서리가 커서를 따라옴).
    applyPanelWidth(panel.getBoundingClientRect().right - e.clientX);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing');
    localStorage.setItem(PANEL_W_KEY, String(parseInt(panel.style.width, 10) || 320));
  };
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    handle.classList.add('dragging');
    document.body.classList.add('resizing');
  });
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// --- 이벤트 결선 ---------------------------------------------------------
function wire() {
  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => setTab(t.dataset.tab)),
  );

  $('cap-start').addEventListener('click', capStart);
  $('cap-stop').addEventListener('click', capStop);
  $('cap-finalize').addEventListener('click', capFinalize);
  $('an-refresh').addEventListener('click', renderAnalysis);
  $('an-download').addEventListener('click', downloadArtifact);
  $('an-raw-toggle').addEventListener('click', () => {
    $('an-raw-box').hidden = !$('an-raw-box').hidden;
  });

  $('sel-source').addEventListener('change', async (e) => {
    state.source = e.target.value;
    state.isHucoms = false; // 소스 kind 는 서버만 앎 → login 박스는 시도 후 표시
    $('login-box').hidden = false;
    await loadCameras();
  });
  $('sel-cam').addEventListener('change', (e) => {
    state.cam = Number(e.target.value);
    renderPresetSelect();
  });
  $('sel-preset').addEventListener('change', (e) => {
    state.preset = Number(e.target.value);
    syncPtzFromPreset();
    renderSlotList();
  });
  document.querySelectorAll('input[name="mode"]').forEach((r) =>
    r.addEventListener('change', (e) => {
      state.mode = e.target.value;
    }),
  );

  $('btn-start').addEventListener('click', () => loop.start(Number($('fps').value) || 3));
  $('btn-stop').addEventListener('click', () => loop.stop());
  $('btn-goto').addEventListener('click', gotoPreset);
  $('roi-vehicle').addEventListener('change', drawRoiOverlay);
  $('roi-plate').addEventListener('change', drawRoiOverlay);

  document.querySelectorAll('[data-dir]').forEach((b) =>
    b.addEventListener('click', () => {
      const step = Number($('step').value) || 500;
      move(stepPtz(state.ptz, b.dataset.dir, step));
    }),
  );

  $('btn-abs').addEventListener('click', () => {
    move({
      pan: Number($('abs-pan').value) || 0,
      tilt: Number($('abs-tilt').value) || 0,
      zoom: clampZoom(Number($('abs-zoom').value) || 1),
    });
  });

  $('btn-login').addEventListener('click', async () => {
    const res = await fetch(api('/camera/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: state.source,
        user: $('login-user').value,
        pass: $('login-pass').value,
      }),
    });
    const data = res.ok ? await res.json() : { ok: false };
    $('login-status').textContent = data.ok ? '로그인 OK' : '로그인 실패';
    $('login-pass').value = '';
  });

  if (window.ResizeObserver) {
    new ResizeObserver(() => drawRoiOverlay()).observe(frame);
  }
}

async function init() {
  wire();
  wirePanelResize();
  await loadSources();
  await Promise.all([loadCameras(), loadMapping(), loadHealth()]);
  drawRoiOverlay();
}

init();
