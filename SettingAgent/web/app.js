// SettingViewer DOM 결선·이벤트·스트림 오케스트레이션(환경 의존).
// 순수 로직은 core.js 에서 import.
import {
  toPixel,
  toPixelQuad,
  presetKey,
  slotLabel,
  clampZoom,
  stepPtz,
  createStreamLoop,
  captureProgress,
  captureElapsedMs,
  formatElapsed,
  captureResultSummary,
  mapAdvisory,
  pollPlan,
  clampPanelWidth,
  analyzeArtifact,
  findPresetPtz,
  diffArtifactVsCameras,
  hitTestSlots,
  removeSlot,
  resizeRect,
  updateSlotRoi,
  buildMappingRows,
  applyManualGlobalIds,
  slotMapModel,
} from './core.js';

const $ = (id) => document.getElementById(id);
const api = (path) => `/viewer/api${path}`;

const state = {
  source: '',
  cam: 1,
  preset: 1,
  ptz: { pan: 0, tilt: 0, zoom: 1 }, // 현재 카메라 위치(명령 기준: 프리셋 이동·PTZ 제어로 갱신)
  cameras: [], // CameraList.cameras
  mapping: null, // SetupArtifact
  roiHidden: false, // true 면 ROI/선택 오버레이를 그리지 않음(초기화·수집 시작 시).
  isHucoms: false,
  selectedSlotId: null, // #1 선택된 주차면 slotId(없으면 null).
  selectedMapSlot: null, // 슬롯 맵↔표 동기화 선택 slotId.
};

// #3 크기 조정 핸들 드래그 상태(캔버스 좌표 변환은 환경 의존 — 여기에서만 사용).
const HANDLE_PX = 8; // 핸들 사각형 반경(px).
let dragState = null; // { handle, slotId, key, startRect } | null

/** 화면에 그려진 주차면 ROI·선택 표시를 초기화(데이터는 보존 — 표시만 끔). */
function clearRoiDisplay() {
  state.roiHidden = true;
  state.selectedSlotId = null;
  drawRoiOverlay();
  renderSelectionInfo();
}

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
  if (state.roiHidden || !state.mapping) return; // 초기화/수집 중엔 표시 안 함.
  const key = presetKey(state.cam, state.preset);
  const showVehicle = $('roi-vehicle').checked;
  const showPlate = $('roi-plate').checked;
  const showFloor = $('roi-floor').checked;
  const globalIndex = state.mapping.globalIndex ?? [];
  for (const slot of state.mapping.slots ?? []) {
    const selected = slot.slotId === state.selectedSlotId;
    const vrect = slot.roiByPreset?.[key];
    if (vrect && showVehicle) {
      const { px, py, pw, ph } = toPixel(vrect, overlay.width, overlay.height);
      ctx.strokeStyle = selected ? '#ff4d4d' : '#00e5ff'; // 선택 슬롯은 굵은 대비색.
      ctx.lineWidth = selected ? 4 : 2;
      ctx.strokeRect(px, py, pw, ph);
      ctx.fillStyle = selected ? '#ff4d4d' : '#00e5ff';
      ctx.fillText(slotLabel(slot.slotId, globalIndex), px + 2, py + 12);
      if (selected) drawHandles(ctx, px, py, pw, ph); // #3 크기 조정 핸들.
    }
    const prect = slot.plateRoiByPreset?.[key];
    if (prect && showPlate) {
      const { px, py, pw, ph } = toPixel(prect, overlay.width, overlay.height);
      ctx.strokeStyle = '#ffd60a';
      ctx.lineWidth = 2;
      ctx.strokeRect(px, py, pw, ph);
    }
    const fquad = slot.floorRoiByPreset?.[key];
    if (fquad && showFloor) {
      const pts = toPixelQuad(fquad, overlay.width, overlay.height);
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.px, p.py) : ctx.moveTo(p.px, p.py)));
      ctx.closePath();
      ctx.fillStyle = 'rgba(57, 255, 20, 0.22)'; // 바닥 점유 영역 — 반투명 채움(영역으로 또렷)
      ctx.fill();
      ctx.strokeStyle = '#39ff14';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}

function renderSlotList() {
  const box = $('slot-list');
  box.innerHTML = '';
  if (!state.mapping) return;
  const key = presetKey(state.cam, state.preset);
  const globalIndex = state.mapping.globalIndex ?? [];
  let count = 0;
  for (const slot of state.mapping.slots ?? []) {
    if (!slot.roiByPreset?.[key]) continue;
    count += 1;
    const div = document.createElement('div');
    div.className = 'slot';
    if (slot.slotId === state.selectedSlotId) div.classList.add('selected');
    div.textContent = `#${slotLabel(slot.slotId, globalIndex)} ${slot.slotId} (${slot.zone})`;
    div.addEventListener('click', () => selectSlot(slot.slotId)); // 목록 클릭으로도 선택.
    box.appendChild(div);
  }
  if (count === 0) {
    // #4: 빈 상태 안내 — 데이터 0 vs 네비게이션 불가 구분 힌트.
    const div = document.createElement('div');
    div.className = 'slot-empty';
    div.textContent = '이 프리셋에 주차면 없음 — 다른 프리셋 선택 또는 분석 탭 확인';
    box.appendChild(div);
  }
}

// --- 주차면 선택·삭제·크기조정(#1~#3) -----------------------------------
/** 4모서리 크기조정 핸들 렌더(선택 슬롯). */
function drawHandles(ctx, px, py, pw, ph) {
  const r = HANDLE_PX;
  const pts = [
    [px, py], [px + pw, py], [px, py + ph], [px + pw, py + ph],
  ];
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ff4d4d';
  ctx.lineWidth = 2;
  for (const [cx, cy] of pts) {
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.strokeRect(cx - r, cy - r, r * 2, r * 2);
  }
}

/** 캔버스 마우스 이벤트 → 정규화 좌표(오버레이 표시크기 기준, 히트테스트와 동일 분모). */
function eventToNorm(e) {
  const rect = overlay.getBoundingClientRect();
  const nx = (e.clientX - rect.left) / rect.width;
  const ny = (e.clientY - rect.top) / rect.height;
  return { nx, ny };
}

/** 선택 슬롯의 차량 ROI 모서리 핸들 히트(핸들 px 반경). → 'nw'|'ne'|'sw'|'se'|null */
function hitTestHandle(nx, ny) {
  if (!state.selectedSlotId || !state.mapping) return null;
  const key = presetKey(state.cam, state.preset);
  const slot = (state.mapping.slots ?? []).find((s) => s.slotId === state.selectedSlotId);
  const vrect = slot?.roiByPreset?.[key];
  if (!vrect) return null;
  const w = overlay.width || frame.clientWidth || 1;
  const h = overlay.height || frame.clientHeight || 1;
  const tol = HANDLE_PX / w; // x 허용오차(정규화)
  const tolY = HANDLE_PX / h;
  const corners = {
    nw: [vrect.x, vrect.y],
    ne: [vrect.x + vrect.w, vrect.y],
    sw: [vrect.x, vrect.y + vrect.h],
    se: [vrect.x + vrect.w, vrect.y + vrect.h],
  };
  for (const [name, [cx, cy]] of Object.entries(corners)) {
    if (Math.abs(nx - cx) <= tol && Math.abs(ny - cy) <= tolY) return name;
  }
  return null;
}

function selectSlot(slotId) {
  state.selectedSlotId = slotId;
  drawRoiOverlay();
  renderSlotList();
  renderSelectionInfo();
}

/** 선택 슬롯 정보·삭제 버튼 활성 상태 갱신. */
function renderSelectionInfo() {
  const info = $('sel-slot-info');
  const delBtn = $('roi-delete');
  if (!info || !delBtn) return;
  if (!state.selectedSlotId) {
    info.textContent = '선택된 주차면 없음';
    delBtn.disabled = true;
    return;
  }
  const gi = state.mapping?.globalIndex ?? [];
  info.textContent = `선택: #${slotLabel(state.selectedSlotId, gi)} ${state.selectedSlotId}`;
  delBtn.disabled = false;
}

/** 선택 슬롯 삭제(메모리만 — '저장'으로 영속화). */
function deleteSelectedSlot() {
  if (!state.selectedSlotId || !state.mapping) return;
  state.mapping = removeSlot(state.mapping, state.selectedSlotId);
  state.selectedSlotId = null;
  markDirty();
  drawRoiOverlay();
  renderSlotList();
  renderSelectionInfo();
}

// 편집 후 미저장 표시.
let mappingDirty = false;
function markDirty() {
  mappingDirty = true;
  const m = $('map-msg');
  if (m) m.textContent = '편집됨(미저장) — 저장을 눌러 반영';
}

/** 편집된 state.mapping 을 PUT 으로 영속화. 성공 시 재로드, 실패 시 명시적 에러. */
async function saveMapping() {
  if (!state.mapping) return;
  const msg = $('map-msg');
  try {
    const res = await fetch(api('/mapping'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(state.mapping),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      mappingDirty = false;
      if (msg) msg.textContent = `저장됨: 슬롯 ${data.slots}, 전역 ${data.globalCount}`;
      await loadMapping(); // 서버 정본으로 재동기화.
      state.selectedSlotId = null;
      drawRoiOverlay();
      renderSlotList();
      renderSelectionInfo();
    } else if (data.error === 'coverage mismatch') {
      if (msg) msg.textContent = `저장 실패(정합 불일치): 누락 ${(data.missing ?? []).join(',') || '-'} / 초과 ${(data.extra ?? []).join(',') || '-'}`;
    } else {
      if (msg) msg.textContent = `저장 실패: ${data.error ?? res.status}`;
    }
  } catch (err) {
    if (msg) msg.textContent = `저장 실패(네트워크): ${err}`;
  }
}

// --- 스트림 루프 ---------------------------------------------------------
const loop = createStreamLoop({
  makeUrl: (seq) => {
    // 항상 '현재 PTZ'(state.ptz) 기준으로 캡처. 프리셋은 '이동' 이 state.ptz 를 프리셋 PTZ 로 맞춘다.
    const p = new URLSearchParams({ cam: state.cam, preset: state.preset, mode: 'manual', t: seq });
    if (state.source) p.set('source', state.source);
    p.set('pan', state.ptz.pan);
    p.set('tilt', state.ptz.tilt);
    p.set('zoom', state.ptz.zoom);
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
let lastCapStatus = null; // 경과 시간 1초 틱 갱신용

async function capFetchStatus() {
  try {
    const res = await fetch('/capture/status');
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** 경과 시간 표시(서버 startedAt~endedAt 기준, 진행 중엔 now 까지). */
function renderElapsed() {
  const ms = captureElapsedMs(lastCapStatus, Date.now());
  $('cap-elapsed').textContent = ms == null ? '' : `경과 ${formatElapsed(ms)}`;
}

function renderCaptureStatus(status) {
  lastCapStatus = status;
  const { percent, label } = captureProgress(status ?? {});
  $('cap-bar').value = percent;
  $('cap-label').textContent = label;
  renderElapsed();
  const adv = mapAdvisory(status ?? {});
  $('cap-advisory').innerHTML = '';
  for (const line of adv) {
    const div = document.createElement('div');
    div.className = 'adv-line';
    div.textContent = line;
    $('cap-advisory').appendChild(div);
  }
}

// 1초 틱: 진행 중이면 경과 시간을 부드럽게 갱신(폴링은 2초라 그 사이도 갱신).
setInterval(() => {
  const st = lastCapStatus?.state;
  if (st === 'running' || st === 'stopping' || st === 'finalizing') renderElapsed();
}, 1000);

// 캡처 중 Live View 에 '최근 캡처 프레임'을 표시(카메라 재명령 없이 잡이 찍은 프레임을 관찰).
let capFrameTimer = null;
let capFrameUrl = null;

async function capFrameTick() {
  try {
    const res = await fetch('/capture/frame', { cache: 'no-store' });
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    frame.src = url;
    if (frame.decode) await frame.decode().catch(() => {});
    if (capFrameUrl) URL.revokeObjectURL(capFrameUrl);
    capFrameUrl = url;
    const c = res.headers.get('X-Cap-Cam');
    if (c != null) {
      $('cap-msg').textContent = `수집 중 — cam${c} 프리셋${res.headers.get('X-Cap-Preset')} (라운드 ${res.headers.get('X-Cap-Round')})`;
    }
  } catch {
    /* ignore */
  }
}

function startCapFramePolling() {
  if (capFrameTimer) return;
  loop.stop(); // 라이브 스트림 중지 — 카메라를 캡처와 다투지 않게.
  capFrameTimer = setInterval(capFrameTick, 700);
  capFrameTick();
}

function stopCapFramePolling() {
  if (capFrameTimer) {
    clearInterval(capFrameTimer);
    capFrameTimer = null;
  }
}

let prevCapState = 'idle';

/** 정밀 수집 종료 결과 메시지 박스 표시. */
function showCaptureResult(status) {
  const { title, lines } = captureResultSummary(status ?? {}, Date.now());
  $('cap-result-title').textContent = title;
  const body = $('cap-result-body');
  body.innerHTML = '';
  for (const l of lines) {
    const d = document.createElement('div');
    d.textContent = l;
    body.appendChild(d);
  }
  $('cap-result-modal').hidden = false;
}

async function capPoll() {
  const status = await capFetchStatus();
  renderCaptureStatus(status);
  const st = status?.state ?? 'idle';
  const active = st === 'running' || st === 'stopping' || st === 'finalizing';
  if (active) {
    startCapFramePolling();
  } else {
    stopCapFramePolling();
    if (st === 'done') {
      $('cap-msg').textContent = `수집 완료 (${status.done}/${status.planned} 라운드) — '최종화'를 누르면 주차면이 그려집니다`;
    }
  }
  // 활성 → 종료 전환 시 결과 메시지 박스를 1회 띄운다.
  const wasActive = prevCapState === 'running' || prevCapState === 'stopping' || prevCapState === 'finalizing';
  if (wasActive && (st === 'done' || st === 'stopped' || st === 'error')) {
    showCaptureResult(status);
  }
  prevCapState = st;
  const plan = pollPlan(st);
  if (capPollTimer) {
    clearTimeout(capPollTimer);
    capPollTimer = null;
  }
  if (plan.poll) capPollTimer = setTimeout(capPoll, plan.intervalMs);
}

async function capStart() {
  $('cap-msg').textContent = '';
  clearRoiDisplay(); // #6: 수집 시작 시 화면에 그려진 주차면을 깨끗이 정리.
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
    state.roiHidden = false; // 최종화 결과를 다시 표시.
    await loadMapping(); // 정밀 결과를 검수 탭에 반영.
    drawRoiOverlay();
    renderSlotList();
  } else {
    $('cap-msg').textContent = `최종화 실패: ${data.error ?? res.status}`;
  }
}

// --- PTZ 캘리브레이션(주차면별 번호판 중심정렬·줌 → slot_ptz.json) ------
// capPoll 패턴 차용(pollPlan 재사용). 절대경로 /calibrate/* 직접 폴링.
let calPollTimer = null;
let prevCalState = 'idle';

async function calStart() {
  $('cal-msg').textContent = '';
  $('cal-summary').innerHTML = '';
  const res = await fetch('/calibrate/ptz', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const data = await res.json().catch(() => ({}));
  $('cal-msg').textContent = res.ok ? `시작됨 (대상 ${data.total} 슬롯)` : `시작 실패: ${data.error ?? res.status}`;
  calPoll();
}

async function calPoll() {
  let status = null;
  try {
    const res = await fetch('/calibrate/status', { cache: 'no-store' });
    status = res.ok ? await res.json() : null;
  } catch {
    status = null;
  }
  const st = status?.state ?? 'idle';
  const done = status?.done ?? 0;
  const total = status?.total ?? 0;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  $('cal-bar').value = percent;
  $('cal-label').textContent = `${st} ${done}/${total}` + (status?.current ? ` — ${status.current.slotId}` : '');

  // 활성 → 완료 전환 시 결과 요약 1회 렌더.
  if (prevCalState === 'running' && st !== 'running') {
    if (st === 'done') await renderCalResult();
    else $('cal-msg').textContent = `종료(${st})`;
  }
  prevCalState = st;

  const plan = pollPlan(st);
  if (calPollTimer) {
    clearTimeout(calPollTimer);
    calPollTimer = null;
  }
  if (plan.poll) calPollTimer = setTimeout(calPoll, plan.intervalMs);
}

async function renderCalResult() {
  try {
    const res = await fetch('/calibrate/result', { cache: 'no-store' });
    if (!res.ok) return;
    const art = await res.json();
    const items = art.items ?? [];
    const conv = items.filter((i) => i.centered && i.converged).length;
    const unconv = items.filter((i) => !(i.centered && i.converged));
    $('cal-msg').textContent = `완료 — 수렴 ${conv}/${items.length}`;
    $('cal-summary').innerHTML = '';
    for (const i of unconv.slice(0, 20)) {
      const div = document.createElement('div');
      div.className = 'adv-line';
      div.textContent = `미수렴: ${i.slotId} (${i.camIdx}:${i.presetIdx})${i.reason ? ' — ' + i.reason : ''}`;
      $('cal-summary').appendChild(div);
    }
  } catch {
    /* ignore */
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
    ['전역 인덱스', t.globalSlots], ['번호판 ROI', t.withPlate], ['바닥 ROI', t.withFloor], ['존', t.zones], ['경고', t.warnings],
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
  // #4: 산출물엔 있으나 카메라 드롭다운에 없는 프리셋 키 → 선택 불가(미표시 원인) 경고.
  const diff = diffArtifactVsCameras(lastArtifact, state.cameras);
  for (const k of diff.artifactOnly) {
    const div = document.createElement('div');
    div.className = 'an-warn';
    div.textContent = `프리셋 키 ${k}: 산출물에는 있으나 카메라 드롭다운에 없음 → 검수 탭에서 선택 불가(미표시)`;
    wbox.appendChild(div);
  }
  if (!a.warnings.length && !diff.artifactOnly.length) {
    wbox.textContent = '경고 없음';
  } else {
    for (const w of a.warnings) {
      const div = document.createElement('div');
      div.className = 'an-warn';
      div.textContent = w;
      wbox.appendChild(div);
    }
  }

  renderManualIndex(); // #7 전역 인덱스 수동 매핑 UI.
  $('an-report').textContent = a.report || '(LLM 리포트 없음)';
  $('an-raw').textContent = JSON.stringify(lastArtifact, null, 2);
}

// --- #7 전역 인덱스 수동 매핑(표 + 전역ID 직접 입력) ----------------------
// 분석 탭에 가산. 슬롯마다 카메라/프리셋/위치를 표기하고 전역 ID 를 직접 입력해 매핑한다.

function renderManualIndex() {
  const box = $('an-manual');
  if (!box) return;
  box.innerHTML = '';
  if ($('an-manual-msg')) $('an-manual-msg').textContent = '';
  if (!lastArtifact || !Array.isArray(lastArtifact.slots) || lastArtifact.slots.length === 0) {
    box.textContent = '최종화된 주차면이 없습니다 — 정밀수집 → 최종화 후 표시됩니다.';
    if ($('an-manual-status')) $('an-manual-status').textContent = '';
    return;
  }
  const rows = buildMappingRows(lastArtifact);
  const table = document.createElement('table');
  table.className = 'an-table';
  table.innerHTML =
    '<thead><tr><th>전역 ID</th><th>카메라</th><th>프리셋</th><th>프리셋내 위치</th><th>slotId</th><th>zone</th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.dataset.slotId = r.slotId;
    tr.addEventListener('click', () => selectMapSlot(r.slotId)); // 표 행 ↔ 슬롯맵 동기화.
    const idTd = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.className = 'an-manual-input';
    input.dataset.slotId = r.slotId;
    input.value = r.globalIdx ?? '';
    input.addEventListener('input', () => {
      validateManualTable();
      renderSlotMap(); // 입력 즉시 박스 번호 갱신.
    });
    idTd.appendChild(input);
    tr.appendChild(idTd);
    for (const c of [r.camIdx, r.presetIdx, r.positionIdx ?? '-', r.slotId, r.zone]) {
      const td = document.createElement('td');
      td.textContent = String(c);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  box.appendChild(table);
  validateManualTable();
  renderSlotMap();
}

/** 슬롯 박스 맵 렌더(우측). 박스=주차면, 내부=전역ID. 클릭 시 표와 동기화. */
function renderSlotMap() {
  const box = $('an-slotmap');
  if (!box) return;
  box.innerHTML = '';
  if (!lastArtifact || !Array.isArray(lastArtifact.slots) || lastArtifact.slots.length === 0) return;
  const boxes = slotMapModel(buildMappingRows(lastArtifact), collectManualIds(), state.selectedMapSlot);
  for (const b of boxes) {
    const el = document.createElement('div');
    el.className = 'slot-box' + (b.selected ? ' selected' : '') + (b.bad ? ' bad' : '');
    el.dataset.slotId = b.slotId;
    const gid = document.createElement('div');
    gid.className = 'gid';
    gid.textContent = b.label;
    const sid = document.createElement('div');
    sid.className = 'sid';
    sid.textContent = `c${b.group.replace(':', 'p')}`;
    el.append(gid, sid);
    el.addEventListener('click', () => selectMapSlot(b.slotId));
    box.appendChild(el);
  }
}

/** 슬롯 선택을 슬롯맵·표 양쪽에 반영(동기화). */
function selectMapSlot(slotId) {
  state.selectedMapSlot = slotId;
  document.querySelectorAll('#an-slotmap .slot-box').forEach((b) =>
    b.classList.toggle('selected', b.dataset.slotId === slotId),
  );
  document.querySelectorAll('#an-manual tr[data-slot-id]').forEach((tr) =>
    tr.classList.toggle('row-selected', tr.dataset.slotId === slotId),
  );
  const input = document.querySelector(`.an-manual-input[data-slot-id="${CSS.escape(slotId)}"]`);
  if (input) {
    input.scrollIntoView({ block: 'nearest' });
    input.focus();
  }
}

/** 표의 전역ID 입력값을 {slotId: 값} 으로 수집. */
function collectManualIds() {
  const map = {};
  for (const input of document.querySelectorAll('.an-manual-input')) {
    map[input.dataset.slotId] = input.value;
  }
  return map;
}

/** 현재 입력값 정합(1..N 고유) 표시. */
function validateManualTable() {
  const status = $('an-manual-status');
  if (!status || !lastArtifact) return;
  const res = applyManualGlobalIds(lastArtifact, collectManualIds());
  status.textContent = res.ok ? '정합 OK (1..N 고유)' : res.error;
  status.className = res.ok ? 'an-manual-ok' : 'an-manual-bad';
}

/** 자동 번호: 표 순서(카메라→프리셋→위치)대로 1..N 채움. */
function autoNumberManual() {
  [...document.querySelectorAll('.an-manual-input')].forEach((input, i) => (input.value = String(i + 1)));
  validateManualTable();
}

/** #7 저장: 전역ID 매핑 적용 → PUT(공유 saveMapping 경로). */
async function saveManualIndex() {
  if (!lastArtifact) return;
  const msg = $('an-manual-msg');
  const res = applyManualGlobalIds(lastArtifact, collectManualIds());
  if (!res.ok) {
    if (msg) msg.textContent = `저장 불가: ${res.error}`;
    return;
  }
  try {
    const r = await fetch(api('/mapping'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(res.artifact),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      if (msg) msg.textContent = `저장됨: 전역 ${data.globalCount}`;
      await loadMapping(); // 검수 탭 동기화.
      await renderAnalysis(); // 분석 탭 재렌더(저장값 반영).
    } else {
      if (msg) msg.textContent = `저장 실패: ${data.error ?? r.status}`;
    }
  } catch (err) {
    if (msg) msg.textContent = `저장 실패(네트워크): ${err}`;
  }
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
  if (tab === 'precise') { capPoll(); calPoll(); }
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

// --- 오버레이 편집(선택·핸들 드래그) 결선 -------------------------------
function wireOverlayEditing() {
  // mousedown: 핸들 위면 리사이즈 시작, 아니면 슬롯 선택/해제.
  overlay.addEventListener('mousedown', (e) => {
    if (state.roiHidden || !state.mapping) return;
    const { nx, ny } = eventToNorm(e);
    const key = presetKey(state.cam, state.preset);
    const handle = hitTestHandle(nx, ny);
    if (handle && state.selectedSlotId) {
      const slot = (state.mapping.slots ?? []).find((s) => s.slotId === state.selectedSlotId);
      const startRect = slot?.roiByPreset?.[key];
      if (startRect) {
        dragState = { handle, slotId: state.selectedSlotId, key, startRect: { ...startRect }, last: { nx, ny } };
        e.preventDefault();
        return;
      }
    }
    // 선택/해제: 차량 ROI(레이어 토글 반영) 히트테스트.
    const layers = { vehicle: $('roi-vehicle').checked, floor: $('roi-floor').checked };
    const hit = hitTestSlots({ nx, ny, slots: state.mapping.slots ?? [], key, layers });
    state.selectedSlotId = hit; // 빈 곳 → null(해제).
    drawRoiOverlay();
    renderSlotList();
    renderSelectionInfo();
  });

  // mousemove: 리사이즈 진행 중이면 실시간 미리보기.
  window.addEventListener('mousemove', (e) => {
    if (!dragState) return;
    const { nx, ny } = eventToNorm(e);
    const ndx = nx - dragState.last.nx;
    const ndy = ny - dragState.last.ny;
    const slot = (state.mapping.slots ?? []).find((s) => s.slotId === dragState.slotId);
    const cur = slot?.roiByPreset?.[dragState.key];
    if (!cur) return;
    const next = resizeRect(cur, dragState.handle, ndx, ndy);
    state.mapping = updateSlotRoi(state.mapping, dragState.slotId, dragState.key, next);
    dragState.last = { nx, ny };
    drawRoiOverlay();
  });

  // mouseup: 리사이즈 확정.
  window.addEventListener('mouseup', () => {
    if (!dragState) return;
    dragState = null;
    markDirty();
    drawRoiOverlay();
  });
}

// --- 이벤트 결선 ---------------------------------------------------------
function wire() {
  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => setTab(t.dataset.tab)),
  );

  $('cap-start').addEventListener('click', capStart);
  $('cap-stop').addEventListener('click', capStop);
  $('cap-finalize').addEventListener('click', capFinalize);
  $('cal-start').addEventListener('click', calStart);
  $('cap-result-close').addEventListener('click', () => {
    $('cap-result-modal').hidden = true;
  });
  $('cap-result-finalize').addEventListener('click', () => {
    $('cap-result-modal').hidden = true;
    capFinalize();
  });
  $('an-refresh').addEventListener('click', renderAnalysis);
  $('an-download').addEventListener('click', downloadArtifact);
  $('an-raw-toggle').addEventListener('click', () => {
    $('an-raw-box').hidden = !$('an-raw-box').hidden;
  });
  $('an-manual-save').addEventListener('click', saveManualIndex); // #7
  $('an-manual-auto').addEventListener('click', autoNumberManual); // #7 자동 번호

  $('sel-source').addEventListener('change', async (e) => {
    state.source = e.target.value;
    state.isHucoms = false; // 소스 kind 는 서버만 앎 → login 박스는 시도 후 표시
    $('login-box').hidden = false;
    await loadCameras();
  });
  $('sel-cam').addEventListener('change', (e) => {
    state.cam = Number(e.target.value);
    state.selectedSlotId = null; // 프리셋 컨텍스트 전환 시 선택 해제.
    renderPresetSelect();
    drawRoiOverlay(); // #4: 카메라 전환 시 해당 ROI 즉시 재그리기.
    renderSelectionInfo();
  });
  $('sel-preset').addEventListener('change', (e) => {
    state.preset = Number(e.target.value);
    state.selectedSlotId = null; // 프리셋 전환 시 선택 해제.
    syncPtzFromPreset();
    renderSlotList();
    drawRoiOverlay(); // #4: 프리셋 전환 시 해당 프리셋 ROI 즉시 재그리기(미호출 버그 수정).
    renderSelectionInfo();
  });

  $('btn-start').addEventListener('click', () => loop.start(Number($('fps').value) || 3));
  $('btn-stop').addEventListener('click', () => loop.stop());
  $('btn-goto').addEventListener('click', gotoPreset);
  $('roi-vehicle').addEventListener('change', drawRoiOverlay);
  $('roi-plate').addEventListener('change', drawRoiOverlay);
  $('roi-floor').addEventListener('change', drawRoiOverlay);
  $('roi-clear').addEventListener('click', clearRoiDisplay); // #5: 표시 초기화
  $('roi-delete').addEventListener('click', deleteSelectedSlot); // #2
  $('map-save').addEventListener('click', saveMapping); // #2/#3/#7 영속화

  wireOverlayEditing();

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
  renderSelectionInfo();
}

init();
