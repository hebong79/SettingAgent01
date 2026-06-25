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
  const res = await fetch(api(`/cameras${state.source ? `?source=${encodeURIComponent(state.source)}` : ''}`));
  if (!res.ok) return;
  const data = await res.json();
  state.cameras = data.cameras ?? [];
  renderCamSelect();
}

async function loadMapping() {
  try {
    const res = await fetch(api('/mapping'));
    state.mapping = res.ok ? await res.json() : null;
  } catch {
    state.mapping = null;
  }
}

async function loadHealth() {
  try {
    const res = await fetch(api('/health'));
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
  renderSlotList();
}

async function loadSources() {
  // health 응답의 sources 목록으로 소스 셀렉트 구성.
  try {
    const res = await fetch(api('/health'));
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
  onPtz: (headers) => {
    const pan = headers.get('X-PTZ-Pan');
    const tilt = headers.get('X-PTZ-Tilt');
    const zoom = headers.get('X-PTZ-Zoom');
    if (pan != null) state.ptz.pan = Number(pan);
    if (tilt != null) state.ptz.tilt = Number(tilt);
    if (zoom != null) state.ptz.zoom = Number(zoom);
    updatePtzDisplay();
  },
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

// --- 정밀 수집(장기 관측·반복 수집) ------------------------------------
let capPollTimer = null;

async function capFetchStatus() {
  try {
    const res = await fetch(api('/capture/status'));
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
  const res = await fetch(api('/capture/start'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  $('cap-msg').textContent = res.ok ? `시작됨 (run #${data.runId})` : `시작 실패: ${data.error ?? res.status}`;
  capPoll();
}

async function capStop() {
  const res = await fetch(api('/capture/stop'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const data = await res.json().catch(() => ({}));
  $('cap-msg').textContent = res.ok ? '정지 요청됨' : `정지 실패: ${data.error ?? res.status}`;
  capPoll();
}

async function capFinalize() {
  const res = await fetch(api('/capture/finalize'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
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

// --- 이벤트 결선 ---------------------------------------------------------
function wire() {
  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      const isPrecise = t.dataset.tab === 'precise';
      $('precise-box').hidden = !isPrecise;
      if (isPrecise) capPoll();
    }),
  );

  $('cap-start').addEventListener('click', capStart);
  $('cap-stop').addEventListener('click', capStop);
  $('cap-finalize').addEventListener('click', capFinalize);

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
    renderSlotList();
  });
  document.querySelectorAll('input[name="mode"]').forEach((r) =>
    r.addEventListener('change', (e) => {
      state.mode = e.target.value;
    }),
  );

  $('btn-start').addEventListener('click', () => loop.start(Number($('fps').value) || 3));
  $('btn-stop').addEventListener('click', () => loop.stop());
  $('btn-goto').addEventListener('click', () => loop.tick());
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
  await loadSources();
  await Promise.all([loadCameras(), loadMapping(), loadHealth()]);
  drawRoiOverlay();
}

init();
