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
  moveRenderDirective, // 이동 시 렌더 경로 결정(순수). 루프3: stream=재연결 / poll·off=tick.
  captureProgress,
  captureElapsedMs,
  formatElapsed,
  captureResultSummary,
  mapAdvisory,
  pollPlan,
  captureUiState, // 상태→버튼/안내 UI 의도(순수, 백엔드 거부조건 대칭).
  capFrameKey,
  clampPanelWidth,
  analyzeArtifact,
  findPresetPtz,
  diffArtifactVsCameras,
  hitTestSlots,
  removeSlot,
  resizeRect, // 차량 rect Ctrl+드래그 리사이즈(요구 A).
  updateSlotRoi, // 차량 rect 편집 결과 불변 교체(요구 A).
  moveRect, // 차량 rect Ctrl+드래그 평행이동(요구 A).
  hitTestRectHandle, // 차량 rect 8핸들/내부 히트(요구 A, 순수).
  nextSlotId, // 결번 충돌회피 slotId 생성(요구 B).
  insertSlotAt, // 전역 인덱스 중간삽입(요구 B).
  hitTestQuadVertex,
  moveQuadVertex,
  updateSlotFloorRoi,
  buildMappingRows,
  applyManualGlobalIds,
  slotMapModel,
  parseLoadedArtifact, // 로컬 결과 파일 파싱·최소형태검증(순수)
  defaultResultFilename, // 저장 대화상자 제안 파일명(순수)
  occupancyByKey, // 점유율 rows[] → cam:preset 맵(spacesJson 파싱, 순수)
  occupancyRows, // 점유율 맵 → 표 rows(정렬·포맷, 순수)
  formatRatePct, // 점유율 0~1 → 'NN%'(순수)
  occupancyAverage, // 전체 평균 점유율(순수)
  normalizePtzCamRoi, // PtzCamRoi.json raw → 프리셋별 정규화 폴리곤 + 검수(순수)
  selectFloorRoi, // 바닥 ROI 소스 선택(LLM/파일 토글, 순수)
  computeOccupancy, // 로직 점유 판정(파일 바닥ROI × LPD 번호판 중심, 순수, R4/R5)
  buildFlatSlotRows, // 전체 주차면 평면 목록(전역 인덱스 오름차순, 순수, R2)
  normalizeGlobalIdx, // 전역 인덱스 정규화·재부여(순수, R3)
  reindexPlaceSpace, // 전역 인덱스 재지정(밀어내기, 순수, R4)
  removePlaceSpace, // 주차면 삭제 + 1..N 재압축(순수, R4)
  settingsFormErrors, // 옵션 폼 클라이언트 검증(순수, URL/detPath 형식)
  buildDbTableModel, // DB 뷰어 표 모델(columns/rows → headers/cells, 순수, §08 F6)
  pickSelected, // 목록 갱신 후 이전 cam/preset 선택 유지(순수)
  camerasChanged, // 카메라/프리셋 집합 변경 감지 → 변경 시에만 재렌더(순수)
  upsertPreset, // 카메라 PTZ 프리셋 upsert(camerapos.json 편집, 순수)
  removePreset, // 카메라 PTZ 프리셋 삭제(순수)
  nextPresetId, // 해당 카메라의 다음 presetIdx(순수)
  hitTestDetections, // [기능2] 검출 박스 히트테스트(순수)
  removeDetection, // [기능2] 검출 박스 삭제(순수, 불변)
  transformPlaceRoiPreset, // [기능3] 프리셋 주차면 폴리곤 변환(순수, applyTranslateScale 내부 사용)
  projectCuboid, // 바닥 quad + 지면모델 + 높이 → 육면체 8점·12모서리(순수, 투영만)
  formatGroundBadge, // 지면모델 소스 배지 문자열(순수)
  groundModelsByKey, // ground-model 응답 models[] → cam:preset 맵(순수)
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
  occByKey: {}, // cam:preset → 점유율({occupiedCount,total,rate,spaces[]}). occupancyByKey 결과(백엔드 LLM 판정, 요약모달 소스).
  occComputeByKey: {}, // cam:preset → 로직 점유({spaces:[{id,occupied,center?}]}). computeOccupancy 결과(오버레이/목록 뱃지 소스, R4/R5).
  // occByKey 와 분리한 이유(§6 설계 가정 충돌 회피): occByKey 는 occupancyRows/occupancyAverage(occupiedCount/total/rate)가
  // 참조하는 백엔드 요약 소스라 로직 점유로 덮으면 최종 결과 모달이 깨진다 → 로직 점유 전용 별도 필드 채택.
  capFrameKey2: null, // 정밀수집 중 현재 표시 프레임의 {cam,preset}(X-Cap-* 헤더 추종, 오버레이 프리셋 판별).
  lastRunId: null, // 최근 정밀수집 runId(occupancy 조회 근거).
  placeRoi: null, // PtzCamRoi.json 정규화 byPreset 맵(cam:preset → [{idx,points}]). idx=전역 인덱스(1..N). loadPlaceRoi 결과.
  placeRoiLoaded: false, // 파일 ROI 1회 로드 가드(실패해도 세션 1회).
  placeRoiReport: {}, // 프리셋키 → issues[] (파일 모드 렌더 시 검수 advisory 재사용, R5).
  selectedPlaceIdx: null, // 선택된 주차면 전역 인덱스(PtzCamRoi, 없으면 null).
  placeRoiDirty: false, // 주차면 전역번호/삭제 편집 미저장 여부('저장'으로 확정).
  detectByKey: {}, // cam:preset → 라이브 VPD/LPD 검출({vehicles,plates}). 프리셋별 보존(전환 시 유지, POST /capture/detect). drawDetectOverlay 근거.
  selectedDetect: null, // [기능2] 선택된 검출 박스 { kind:'vehicle'|'plate', index } | null(임시 편집·메모리만).
  placeRoiBackup: null, // [기능3] 자동보정 직전 스냅샷 { key, spaces }(되돌리기용).
  parkingSlotsByKey: null, // 최종화 후 DB parking_slots(cam:preset → 행배열, GET /capture/runs/:id/slots). renderSlotList 소스(§06 H7).
  dbTablesLoaded: false, // DB 탭 콤보 1회 채움 가드.
  dbTable: '', // 현재 선택된 DB 테이블명.
  dbSearch: '', // DB 뷰어 검색어(전 컬럼 LIKE).
  dbOffset: 0, // DB 뷰어 페이지 오프셋.
  dbTotal: 0, // 최근 조회 total(prev/next 활성화 판정).
  groundByKey: {}, // cam:preset → 지면모델(GET /capture/ground-model). 육면체 투영의 유일한 근거(추정은 서버 소유).
  groundLoaded: false, // 지면모델 1회 로드 가드(실패해도 세션 1회).
  vcuboidByKey: {}, // cam:preset → 차량 육면체 응답(GET /capture/vehicle-cuboids). 토글 켤 때만 로드(카메라 1회 촬영).
  vcuboidLoading: new Set(), // 중복 요청 가드(프리셋 키 단위).
};

const DB_LIMIT = 200; // DB 뷰어 페이지 크기(서버 clamp 상한 1000 내).

// floor quad 정점 드래그 상태(캔버스 좌표 변환은 환경 의존 — 여기에서만 사용).
const HANDLE_PX = 8; // 핸들 사각형 반경(px).
// { kind:'floorVertex', index, ... } | { kind:'vpdResize', handle, ... } | { kind:'vpdMove', ... } | null
let dragState = null;

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
// loadCameras 성공 = Unity(13110) 연결(별도 ping 불필요). 주기 폴이 이 반환값으로 연결 상태를 추적한다.
async function loadCameras() {
  // no-store: 시뮬레이터 카메라/프리셋이 바뀌어도 항상 최신 목록을 받도록(브라우저 캐시 방지).
  let data;
  try {
    const res = await fetch(api(`/cameras${state.source ? `?source=${encodeURIComponent(state.source)}` : ''}`), { cache: 'no-store' });
    if (!res.ok) return false;
    data = await res.json();
  } catch {
    return false; // 네트워크 실패 → 목록 미변경·연결 false(뱃지 off).
  }
  const next = data.cameras ?? [];
  // 카메라/프리셋 집합이 실제로 바뀐 경우에만 재렌더(선택 튐·깜빡임 방지). 선택은 renderCamSelect 가 유지.
  const changed = camerasChanged(state.cameras, next);
  state.cameras = next;
  if (changed) renderCamSelect();
  return true;
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
  // badge-backend 만 13020 health 를 반영. badge-camera 는 connectionTick(loadCameras 성공)이 관장한다.
  try {
    const res = await fetch(api('/health'), { cache: 'no-store' });
    $('badge-backend').classList.toggle('ok', res.ok);
  } catch {
    /* ignore */
  }
}

// --- 시뮬레이터(Unity) 연결 주기 폴 ------------------------------------
// 4초마다 loadCameras() 재수신 → 성공=연결(badge-camera on). 카메라/프리셋 변경 시에만 재렌더(선택 유지).
// 연결 전이(끊김→연결)는 loadCameras 재수신에 자연 포함. 정밀수집 중엔 폴 억제(카메라/RPC 경합 방지).
const CONN_POLL_MS = 4000;
let simConnected = null; // null=미상 | true | false
let connInflight = false; // 폴 중복 방지 가드

/** 정밀수집(캡처 프레임 폴) 진행 중이면 연결 폴을 건너뛴다(뱃지는 마지막 상태 유지). */
function captureActive() {
  return capFrameTimer !== null;
}

async function connectionTick() {
  if (connInflight) return;
  if (captureActive()) return;
  connInflight = true;
  let ok = false;
  try {
    ok = await loadCameras();
  } finally {
    connInflight = false;
  }
  simConnected = ok;
  $('badge-camera').classList.toggle('ok', ok);
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
    state.cam = pickSelected(state.cam, state.cameras, 'camIdx'); // 자동 갱신 시 선택 유지(없으면 첫 항목).
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
    state.preset = pickSelected(state.preset, presets, 'presetIdx'); // 선택 유지(없으면 첫 프리셋).
    sel.value = state.preset;
  }
  // 프리셋 이름 입력을 현재 선택 프리셋 라벨로 동기화(편집 UI 기본값).
  const labelInput = $('preset-label');
  if (labelInput) labelInput.value = presets.find((p) => p.presetIdx === state.preset)?.label ?? '';
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
  updateLogicOccupancy(); // 로직 점유(파일 바닥ROI × LPD 번호판 중심) 재계산 → state.occByKey[현재프리셋](R4/R5).
  drawOccupancyOverlay(ctx); // 점유율 오버레이 — mapping 미최종화(수집 중)에도 유효 → mapping 가드 이전.
  drawFileFloorRoi(ctx); // 파일 기반 바닥 ROI(PtzCamRoi.json) — 파일 모드 바닥 레이어 → mapping 가드 이전.
  drawDetectOverlay(ctx); // 라이브 VPD/LPD 검출 오버레이(§04) — 수집 중/미최종화에도 표시 → mapping 가드 이전.
  drawCuboidOverlay(ctx); // 3D 육면체(가산 레이어) — 산출물 없이도(수집 중/파일 모드) 그린다 → mapping 가드 이전.
  drawVehicleCuboidOverlay(ctx); // 차량 3D 육면체(VPD seg 접지선) — 토글 기본 off → 끄면 기존 렌더와 픽셀 동일.
  updateGroundBadge(); // 어느 지면모델이 표시 중인지 항상 안다(소스 배지).
  updateAnchorBadge(); // 2 DOF 앵커 지표(차량 접지선 vs 슬롯 격자).
  if (state.roiHidden || !state.mapping) return; // 초기화/수집 중엔 ROI(차량/번호판/바닥) 표시 안 함.
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
      // 선택 슬롯은 8핸들 표시(요구 A: Ctrl+드래그로 리사이즈/이동).
      if (selected) drawHandles(ctx, px, py, pw, ph);
    }
    const pquad = slot.plateRoiByPreset?.[key];
    if (pquad && showPlate) {
      // 번호판 OBB quad → 폴리곤 렌더(floor quad 패턴 재사용, 채움 없이 가늘게).
      const pts = toPixelQuad(pquad, overlay.width, overlay.height);
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.px, p.py) : ctx.moveTo(p.px, p.py)));
      ctx.closePath();
      ctx.strokeStyle = '#ffd60a';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    const fquad = slot.floorRoiByPreset?.[key];
    if (fquad && showFloor && $('cap-floor-llm').checked) { // LLM 모드에서만 슬롯별 floor(파일 모드는 drawFileFloorRoi 가 렌더).
      const pts = toPixelQuad(fquad, overlay.width, overlay.height);
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.px, p.py) : ctx.moveTo(p.px, p.py)));
      ctx.closePath();
      ctx.fillStyle = 'rgba(57, 255, 20, 0.22)'; // 바닥 점유 영역 — 반투명 채움(영역으로 또렷)
      ctx.fill();
      ctx.strokeStyle = '#39ff14';
      ctx.lineWidth = 2;
      ctx.stroke();
      if (selected) drawQuadHandles(ctx, pts); // 선택 슬롯 floor quad 4정점 핸들.
    }
  }
}

/**
 * 현재 화면에 표시 중인 프레임의 프리셋 key. 정밀수집 프레임 폴링 중이면 X-Cap-* 헤더로 추종한
 * capFrameKey2(순환 표시되는 실제 프레임 프리셋), 아니면 라이브 선택 프리셋(state.cam/preset).
 */
function currentFrameKey() {
  if (capFrameTimer && state.capFrameKey2) return presetKey(state.capFrameKey2.cam, state.capFrameKey2.preset);
  return presetKey(state.cam, state.preset);
}

/**
 * 현재 프리셋의 로직 점유(R4/R5) 재계산 → state.occComputeByKey[key] 갱신.
 * 소스: 파일 바닥ROI(state.placeRoi, useLlm:false 고정 — 등록 기준은 항상 파일) ×
 *       현재 프리셋 LPD 번호판(state.detectByKey[key] — 키 조회로 항상 그 프리셋 검출).
 * 파일 바닥ROI 가 없으면(파일 미로드/해당 프리셋 없음) 계산 skip(이전 값 보존, graceful).
 */
function updateLogicOccupancy() {
  const key = currentFrameKey();
  const floorPolys = selectFloorRoi({ useLlm: false, placeRoi: state.placeRoi, key }).polygons.map((p) => ({
    idx: Number(p.label),
    quad: p.quad,
  }));
  if (!floorPolys.length) return;
  const detect = state.detectByKey[key]; // 프리셋 키로 조회 → 항상 그 프리셋 검출(일치 판정 불요).
  const plates = [...(detect?.plates ?? []), ...(detect?.vehicles ?? []).map((v) => v.plate).filter(Boolean)];
  state.occComputeByKey[key] = {
    spaces: computeOccupancy(floorPolys, plates).map((o) => ({ id: o.idx, occupied: o.occupied, center: o.center })),
  };
}

/**
 * 점유율 오버레이(R5: LPD 번호판 중심 = 점유 판정 근거, 작은 원으로 표시). 로직 점유(state.occComputeByKey)
 * 가 소스 — mapping 미최종화(수집 중)에도 유효하므로 drawRoiOverlay 의 mapping 가드와 무관하게 별도 호출된다.
 * 점유+중심 보유분만 그림(공차/중심없음 skip). #roi-occupancy 토글만 가드
 * (roiHidden 무관 — 수집 중 라이브 표시 위해. 끄려면 #roi-occupancy 체크 해제).
 */
function drawOccupancyOverlay(ctx) {
  if (!$('roi-occupancy').checked) return;
  const occ = state.occComputeByKey[currentFrameKey()];
  for (const sp of occ?.spaces ?? []) {
    if (!sp.occupied || !sp.center) continue; // 점유+중심 보유분만 원 표시(R5).
    const px = sp.center.x * overlay.width;
    const py = sp.center.y * overlay.height;
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#ff4d4d'; // 점유=빨강 소원(LPD 번호판 중심).
    ctx.fill();
    ctx.fillText(String(sp.id), px + 7, py + 4);
  }
}

const floorRoiFileWarned = new Set(); // 파일 모드 프리셋별 issue advisory 1회 가드(렌더 스팸 방지, R5).

/**
 * 파일 기반 바닥(floor) ROI(PtzCamRoi.json) 오버레이 — 파일 모드 전용 바닥 레이어(§03 승격).
 * 파일 ROI 를 바닥 실데이터로 취급 → LLM 슬롯 floor 와 동일한 초록(#39ff14) 스타일로 프리셋 단위 렌더.
 * 가드: #roi-floor(바닥 표시 토글)가 관장 + LLM 모드(#cap-floor-llm)에선 숨김(그때는 mapping 루프가 슬롯 floor 를 그림).
 * roiHidden 무관(수집 중 라이브 표시). 현재 프리셋에 검수 issue 가 있으면 프리셋당 1회 console.warn(R5).
 */
function drawFileFloorRoi(ctx) {
  if (!$('roi-floor').checked) return; // 바닥 표시 토글이 파일/LLM 공통 관장.
  if ($('cap-floor-llm').checked) return; // LLM 모드 → 파일 바닥 숨김(슬롯 floor 는 mapping 루프가 렌더).
  const key = currentFrameKey();
  const { polygons } = selectFloorRoi({ useLlm: false, placeRoi: state.placeRoi, key });
  const issues = state.placeRoiReport?.[key];
  if (issues?.length && !floorRoiFileWarned.has(key)) {
    floorRoiFileWarned.add(key);
    console.warn(`[FloorRoi:file] ${key}:`, issues);
  }
  for (const poly of polygons) {
    const selected = poly.idx === state.selectedPlaceIdx; // 목록에서 선택한 전역 인덱스 하이라이트(R4 선택).
    const pts = toPixelQuad(poly.quad, overlay.width, overlay.height);
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.px, p.py) : ctx.moveTo(p.px, p.py)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(57, 255, 20, 0.22)'; // 바닥 실데이터 — 초록 반투명 채움(LLM floor 와 동일).
    ctx.fill();
    ctx.strokeStyle = selected ? '#ff4d4d' : '#39ff14'; // 선택=굵은 대비색.
    ctx.lineWidth = selected ? 4 : 2;
    ctx.stroke();
    ctx.fillStyle = selected ? '#ff4d4d' : '#39ff14';
    ctx.fillText(poly.label, pts[0].px + 2, pts[0].py + 12);
  }
}

// --- 3D 육면체 오버레이(지면모델) -----------------------------------------
const CUBOID_H_KEY = 'sv.cuboidH';
const cuboidWarned = new Set(); // 프리셋별 퇴화 advisory 1회 가드(렌더 스팸 방지).

/** 현재 높이 슬라이더 값(m). 파싱 실패 시 기본 1.5m. */
function cuboidHeight() {
  const h = Number($('cuboid-h').value);
  return Number.isFinite(h) ? h : 1.5;
}

/**
 * 3D 육면체 오버레이 — 주차면(바닥 quad)을 높이 h 만큼 세운 부피를 12모서리로 그린다.
 * 가산 레이어: 기존 2D 바닥 ROI 를 **대체하지 않는다**(#roi-cuboid off 면 기존 렌더와 픽셀 동일).
 * 근거는 서버 지면모델(state.groundByKey) 하나뿐 — 뷰어는 추정하지 않고 projectCuboid 로 투영만 한다.
 * 지면모델 없음/퇴화(projectCuboid null) → 그 면만 조용히 skip + 프리셋당 1회 advisory(강등 철학).
 */
function drawCuboidOverlay(ctx) {
  if (!$('roi-cuboid').checked) return;
  const key = currentFrameKey();
  const ground = state.groundByKey[key];
  if (!ground) return; // 지면모델 없음 → 육면체 미표시(기존 2D ROI 는 그대로).
  const h = cuboidHeight();
  const { polygons } = selectFloorRoi({ useLlm: false, placeRoi: state.placeRoi, key });
  let skipped = 0;
  ctx.save();
  for (const poly of polygons) {
    const cub = projectCuboid(poly.quad, ground, h);
    if (!cub) {
      skipped += 1;
      continue; // 퇴화(지평선 위 등) → 이 면만 미표시.
    }
    const selected = poly.idx === state.selectedPlaceIdx;
    const pts = toPixelQuad(cub.corners, overlay.width, overlay.height); // 기존 좌표 규약 그대로.
    ctx.strokeStyle = selected ? '#ff4d4d' : '#b47cff'; // 육면체=보라(바닥 초록·검출 노랑과 구분).
    ctx.lineWidth = selected ? 3 : 1.5;
    ctx.beginPath();
    for (const [a, b] of cub.edges) {
      ctx.moveTo(pts[a].px, pts[a].py);
      ctx.lineTo(pts[b].px, pts[b].py);
    }
    ctx.stroke();
  }
  ctx.restore();
  if (skipped && !cuboidWarned.has(key)) {
    cuboidWarned.add(key);
    console.warn(`[Cuboid] ${key}: ${skipped}개 면이 퇴화(지평선 위/모델 부적합) — 육면체 미표시`);
  }
}

// --- 차량 3D 육면체(VPD seg 접지선) + 2 DOF 앵커 --------------------------
/**
 * 차량 육면체 오버레이 — **가산 레이어**(#roi-vcuboid off 면 기존 렌더와 픽셀 동일).
 * 바닥 quad·높이는 **서버**(GET /capture/vehicle-cuboids)가 산출한다. 뷰어는 기존 projectCuboid 로 **투영만** 한다
 * (뷰어 수학 신규 0줄 — 주차면 육면체와 같은 함수).
 * 데이터는 토글을 켤 때 1회 로드한다(라우트가 카메라를 1회 촬영하므로 자동 재호출하지 않는다).
 */
function drawVehicleCuboidOverlay(ctx) {
  if (!$('roi-vcuboid').checked) return;
  const key = currentFrameKey();
  const ground = state.groundByKey[key];
  const data = state.vcuboidByKey[key];
  if (!ground || !data) return; // 모델/데이터 없음 → 미표시.
  ctx.save();
  for (const c of data.cuboids ?? []) {
    const cub = projectCuboid(c.floorQuad, ground, c.heightM);
    if (!cub) continue; // 퇴화 → 이 차량만 skip.
    const pts = toPixelQuad(cub.corners, overlay.width, overlay.height);
    // 폭(W) prior 강등분은 점선으로 구분 — "무엇이 관측이고 무엇이 prior 인지" 화면에서 보이게.
    // ⚠️ H 는 **항상 prior** 이므로(차 ≠ 직육면체, 관측 불가) 구분 기준이 될 수 없다 — W 만 본다.
    const degraded = c.source?.W === 'prior';
    ctx.setLineDash(degraded ? [5, 4] : []);
    ctx.strokeStyle = '#ff9f0a'; // 차량 육면체=주황(주차면 육면체 보라·바닥 초록과 구분).
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [a, b] of cub.edges) {
      ctx.moveTo(pts[a].px, pts[a].py);
      ctx.lineTo(pts[b].px, pts[b].py);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** 2 DOF 앵커 배지. 토글 off 면 숨김. 지표 3종 + 알려진 한계(정수배 침묵)를 tooltip 에 남긴다. */
function updateAnchorBadge() {
  const badge = $('anchor-badge');
  const on = $('roi-vcuboid').checked;
  badge.hidden = !on;
  if (!on) return;
  const data = state.vcuboidByKey[currentFrameKey()];
  const a = data?.anchor;
  if (!a) {
    badge.textContent = '앵커: —';
    badge.classList.add('warn');
    badge.title = ANCHOR_LIMIT;
    return;
  }
  const fmt = (v) => (v == null ? '—' : `${v.toFixed(2)}m`);
  badge.textContent = `앵커 n=${a.n} 깊이 ${fmt(a.depthDevM)} / 위상 ${fmt(a.phaseDevM)}`;
  const warn =
    a.depthDevM == null ||
    Math.abs(a.depthDevM) > ANCHOR_DEPTH_DEV_M ||
    Math.abs(a.phaseDevM ?? 0) > ANCHOR_PHASE_DEV_M;
  badge.classList.toggle('warn', warn);
  const lines = [
    `표본 ${a.n}대 / 미배정 ${a.unmatchedRate == null ? '—' : `${Math.round(a.unmatchedRate * 100)}%`}`,
    ...(a.issues ?? []),
    ...(data.issues ?? []),
    `강등 ${data.summary?.rejectedCount ?? 0}대 / seg500 ${data.summary?.segDegraded ? 'Y' : 'N'}`,
  ];
  badge.title = `${lines.join('\n')}\n\n${ANCHOR_LIMIT}`;
}

/** 앵커 임계(서버 contactTypes.ts 와 같은 값 — 표시 전용). */
const ANCHOR_DEPTH_DEV_M = 0.5;
const ANCHOR_PHASE_DEV_M = 0.4;

/** ★ 앵커 지표의 알려진 한계 — 은닉 금지(설계 §6-3). */
const ANCHOR_LIMIT =
  '[2 DOF 앵커 — 1.5 DOF 만 닫힌다]\n' +
  '깊이축(비주기): 모든 밀림에 반응 ✅\n' +
  '폭축 위상(주기 2.5m): 비정수배 밀림에만 반응 ✅ / **정확히 k×2.5m 밀림은 원리적으로 침묵** ❌\n' +
  '(밀린 슬롯 격자가 자기 자신과 겹쳐 차량이 옆 칸 정중앙에 딱 맞게 앉는다.\n' +
  ' ⚠️ 이때 미배정 비율도 0 이 될 수 있다 — 실측 확인. 폭축 정수배는 **3지표 전부 침묵 가능**하다)';

/**
 * 차량 육면체 1회 로드(GET /capture/vehicle-cuboids). **토글을 켤 때만** 호출한다 —
 * 라우트가 카메라를 1회 촬영(requestImage)하므로 렌더 루프에서 자동 재호출하면 안 된다.
 * 실패(404=seg/ground 미배선, 502)는 조용히 미표시 + console.warn(기존 렌더 무영향).
 */
async function loadVehicleCuboids() {
  const key = currentFrameKey();
  if (state.vcuboidLoading.has(key)) return;
  state.vcuboidLoading.add(key);
  try {
    const [cam, preset] = key.split(':');
    const res = await fetch(`/capture/vehicle-cuboids?cam=${cam}&preset=${preset}`, { cache: 'no-store' });
    if (!res.ok) {
      console.warn(`[VehicleCuboid] ${key}: HTTP ${res.status} — 미표시`);
      return;
    }
    const data = await res.json();
    state.vcuboidByKey[key] = data;
    if ((data.issues ?? []).length) console.warn(`[VehicleCuboid] ${key}:`, data.issues);
    for (const r of data.rejected ?? []) console.warn(`[VehicleCuboid] ${key} 차량#${r.boxIdx} 강등:`, r.issues);
    drawRoiOverlay();
  } catch (err) {
    console.warn('[VehicleCuboid] 로드 실패:', err);
  } finally {
    state.vcuboidLoading.delete(key);
  }
}

/**
 * 지면모델 정합 지표의 **한계**. tooltip 에 항상 남긴다 — "경보 없음 = ROI 정합"이 아니기 때문이다.
 * 지면 위 평행이동(주차면 한 칸 = 2.5m)은 모든 지표가 원리적으로 침묵한다.
 */
const GROUND_ALIGN_LIMIT =
  '[정합 지표의 한계 — 경보가 없어도 ROI 정합이 보장되지는 않는다]\n' +
  '검출됨: 이미지 평행이동(metric 잔차) / 세로 어긋남(PTZ tilt 대조) /\n' +
  '        지면 균일스케일(프리셋 간 카메라고) / 수직축 회전(프리셋 간 슬롯 방위)\n' +
  '검출 불가(원리적): 지면 위 평행이동 — ROI 가 옆 칸으로 통째로 밀려도 모든 지표가 침묵한다.\n' +
  '(노면 도색과의 직접 대조가 필요하며, 차량이 선을 가리므로 빈 배경 합성이 선행되어야 한다)';

/** 지면모델 소스 배지 갱신(§5-2). 어느 소스·신뢰도로 그리고 있는지 + 정합 지표의 한계를 항상 보이게 한다. */
function updateGroundBadge() {
  const g = state.groundByKey[currentFrameKey()] ?? null;
  const badge = $('ground-badge');
  badge.textContent = formatGroundBadge(g);
  badge.title = (g?.issues?.length ? `${g.issues.join('\n')}\n\n` : '') + GROUND_ALIGN_LIMIT;
  badge.classList.toggle('warn', !!g?.issues?.length || !g);
}

/**
 * 프리셋별 지면모델 1회 로드(GET /capture/ground-model). precise 탭 진입 시 호출(중복 로드 가드).
 * 실패(404=ground 비활성/파일 없음, 네트워크)는 조용히 미표시 — 기존 렌더는 영향 없음.
 */
async function loadGroundModel() {
  if (state.groundLoaded) return;
  state.groundLoaded = true; // 재시도 폭주 방지(실패해도 세션 1회).
  try {
    const res = await fetch('/capture/ground-model', { cache: 'no-store' });
    if (!res.ok) return; // 404 → 육면체 기능 비활성(토글은 남지만 그릴 모델이 없다).
    const data = await res.json();
    state.groundByKey = groundModelsByKey(data.models);
    for (const [key, g] of Object.entries(state.groundByKey)) {
      if (g.issues?.length) console.warn(`[GroundModel] ${key}:`, g.issues);
    }
    if ((data.issues ?? []).length) console.warn('[GroundModel] 카메라 단위:', data.issues);
    drawRoiOverlay(); // 로딩 완료 즉시 1회 재렌더(배지 포함).
  } catch { /* 네트워크 실패 → 미표시 */ }
}

/**
 * 파일 기반 바닥 ROI(PtzCamRoi.json) 1회 로드. precise 탭 진입 시 호출(중복 로드 가드).
 * GET /capture/place-roi → normalizePtzCamRoi → state.placeRoi. 실패(404/네트워크)는 조용히 미표시.
 */
async function loadPlaceRoi() {
  if (state.placeRoiLoaded) return; // 1회 로드 가드.
  state.placeRoiLoaded = true; // 재시도 폭주 방지(실패해도 세션 1회).
  try {
    const res = await fetch('/capture/place-roi', { cache: 'no-store' });
    if (!res.ok) return; // 404 등 → 조용히 미표시(advisory).
    const { byPreset, report } = normalizePtzCamRoi(await res.json());
    // R3: 파일 idx 를 전역 인덱스(1..N)로 정규화. 이미 1..N 고유면 무변경(사용자 재지정 번호 보존),
    // 중복·0-based·누락이면 (cam→preset→배열순) 재부여 → '저장' 전까지 미저장 버퍼.
    const norm = normalizeGlobalIdx(byPreset);
    state.placeRoi = norm.placeRoi;
    state.placeRoiReport = {}; // 프리셋별 issues 맵 재구성(파일 모드 렌더 advisory 재사용, R5).
    for (const r of report) {
      state.placeRoiReport[presetKey(r.camId, r.presetIdx)] = r.issues;
      if (r.issues.length) console.warn(`[PlaceRoi] cam${r.camId} preset${r.presetIdx}:`, r.issues);
    }
    if (norm.changed) {
      state.placeRoiDirty = true;
      setPlaceMsg('전역번호 재부여됨(미저장) — 저장 필요');
      console.warn('[PlaceRoi] 전역 인덱스 재부여:', norm.issues);
    }
    renderSlotList(); // 전역번호 확정 후 목록 렌더.
    drawRoiOverlay(); // 로딩 완료 즉시 1회 재렌더.
  } catch { /* 네트워크 실패 → 미표시 */ }
}

/**
 * 번호판 OBB quad 렌더. recovered=zoom 재시도 복원(주황 점선), 아니면 실선 노랑(§04-D2).
 * toPixelQuad 재사용(정규화 4점 → 표시 픽셀).
 */
function drawPlateQuad(ctx, quad, recovered) {
  const pts = toPixelQuad(quad, overlay.width, overlay.height);
  ctx.save();
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.px, p.py) : ctx.moveTo(p.px, p.py)));
  ctx.closePath();
  ctx.strokeStyle = recovered ? '#ff9500' : '#ffd60a'; // 복원=주황 / base 검출=노랑.
  ctx.lineWidth = 2;
  if (recovered) ctx.setLineDash([6, 4]); // 복원 번호판은 점선(역산 근사 위치 표시, R4).
  ctx.stroke();
  ctx.restore();
}

/**
 * 라이브 검출 오버레이(§04-D2). VPD rect=청록(#00e5ff) + 귀속/복원 번호판 quad, 매칭 안 된 base LPD 도 표시(R1).
 * 현재 프리셋(currentFrameKey) 결과만. #roi-detect 토글. roiHidden/mapping 무관(수집 중 라이브).
 */
function drawDetectOverlay(ctx) {
  const d = state.detectByKey[currentFrameKey()]; // 프리셋 키로 조회 → 현재 프레임 프리셋 검출(보존분).
  if (!$('roi-detect').checked || !d) return;
  const sel = state.selectedDetect; // [기능2] 선택 박스 하이라이트·핸들.
  (d.vehicles ?? []).forEach((v, i) => {
    const { px, py, pw, ph } = toPixel(v.rect, overlay.width, overlay.height);
    const selected = sel?.kind === 'vehicle' && sel.index === i;
    ctx.strokeStyle = selected ? '#ff4d4d' : '#00e5ff'; // 선택=굵은 대비색 / VPD 차량 bbox=청록.
    ctx.lineWidth = selected ? 4 : 2;
    ctx.strokeRect(px, py, pw, ph);
    if (v.plate) drawPlateQuad(ctx, v.plate.quad, v.plate.recovered);
    if (selected) drawHandles(ctx, px, py, pw, ph); // 8핸들(리사이즈 어포던스).
  });
  (d.plates ?? []).forEach((p, i) => {
    drawPlateQuad(ctx, p.quad, false); // base LPD 전체(R1: LPD 모두).
    if (sel?.kind === 'plate' && sel.index === i) drawQuadHandles(ctx, toPixelQuad(p.quad, overlay.width, overlay.height));
  });
}

/**
 * 현재 프리셋 1회 라이브 검출(POST /capture/detect). 결과를 state.detectByKey[key] 에 보관 후 재렌더.
 * R2 반복(프리셋 순회·10회)은 리더/프론트 재호출 소유 — 이 액션은 현재 프리셋 1회만.
 */
async function runLiveDetect() {
  const cam = state.capFrameKey2?.cam ?? state.cam;
  const preset = state.capFrameKey2?.preset ?? state.preset;
  const res = await fetch('/capture/detect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // 주차면 필터 모드(ON=주차면 위 차량만). 정밀수집 체크박스와 공용 — 진행 중 run 은 시작 시 모드를 유지한다.
    body: JSON.stringify({ cam, preset, vpdOnParkingOnly: $('cap-vpd-onplace').checked }),
  });
  if (!res.ok) return; // 실패는 조용히 미표시(기존 검출 결과 유지).
  const detect = await res.json();
  state.detectByKey[presetKey(cam, preset)] = detect; // 프리셋 키별 보존(덮어쓰기 아님).
  const s = detect.summary;
  if (s) {
    $('cap-msg').textContent =
      `검출 ${s.vpdCount - s.filteredOut}/${s.vpdCount}대 · 번호판 ${s.lpdCount - s.lpdFilteredOut}/${s.lpdCount} · 주차면필터 ${s.onPlaceOnly ? 'ON' : 'OFF'}` +
      (s.onPlaceDegraded ? ` — 강등: ${s.onPlaceDegraded}` : '');
  }
  state.selectedDetect = null; // [기능2] 새 검출 도착 → 인덱스 무효화(임시 편집분 사라짐).
  renderDetectSelection();
  drawRoiOverlay();
  renderSlotList(); // 검출 도착 시 목록의 프리셋별 요약(검출 count)·점유 갱신.
}

function renderSlotList() {
  const box = $('slot-list');
  box.innerHTML = '';
  // 파일 모드(바닥 LLM 미사용·미최종화) 또는 최종화 후(DB) → 전 카메라·전 프리셋 주차면을
  // 전역 인덱스 오름차순 '하나의 평면 목록'으로 렌더(R2, 프리셋 그룹 헤더 없음). 소스=state.placeRoi.
  // 둘 다 아니면(LLM·미최종화) 아래 mapping.slots 분기 유지(회귀 0).
  const finalized = !!(state.parkingSlotsByKey && Object.keys(state.parkingSlotsByKey).length);
  const fileMode = !$('cap-floor-llm').checked && (state.roiHidden || !state.mapping);
  if (finalized || fileMode) {
    updateLogicOccupancy(); // 현재 프리셋 점유 뱃지 최신화(오버레이 원 소스 occComputeByKey 유지).
    const rows = buildFlatSlotRows({
      placeRoi: state.placeRoi,
      detectByKey: state.detectByKey,
      parkingSlotsByKey: state.parkingSlotsByKey,
    });
    for (const r of rows) {
      const div = document.createElement('div');
      div.className = 'slot';
      if (r.globalIdx === state.selectedPlaceIdx) div.classList.add('selected');
      const tags = [r.vpd ? 'VPD' : null, r.lpd ? 'LPD' : null].filter(Boolean).join('/');
      div.textContent = `#${r.globalIdx} cam${r.cam}:${r.preset} (${r.occupied ? '점유' : '공차'})` + (tags ? ` — ${tags}` : '');
      div.addEventListener('click', () => selectPlaceSpace(r)); // 행 클릭 = 선택(다른 프리셋이면 전환).
      box.appendChild(div);
    }
    if (!rows.length) {
      const div = document.createElement('div');
      div.className = 'slot-empty';
      div.textContent = '표시할 주차면 없음 — PtzCamRoi.json 확인';
      box.appendChild(div);
    }
    renderPlaceSelectionInfo();
    return;
  }
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
/** floor quad 4정점 핸들 렌더(pts=toPixelQuad 결과, 4×{px,py}). */
function drawQuadHandles(ctx, pts) {
  const r = HANDLE_PX;
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#39ff14';
  ctx.lineWidth = 2;
  for (const p of pts) {
    ctx.fillRect(p.px - r, p.py - r, r * 2, r * 2);
    ctx.strokeRect(p.px - r, p.py - r, r * 2, r * 2);
  }
}

/** 차량 rect 8핸들(4코너+4변중점) 렌더(선택 슬롯, 요구 A Ctrl+드래그 편집 어포던스). */
function drawHandles(ctx, px, py, pw, ph) {
  const r = HANDLE_PX;
  const mx = px + pw / 2;
  const my = py + ph / 2;
  const pts = [
    [px, py], [mx, py], [px + pw, py], // 상: nw, n, ne
    [px, my], [px + pw, my], // 중: w, e
    [px, py + ph], [mx, py + ph], [px + pw, py + ph], // 하: sw, s, se
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

/** 선택 슬롯의 floor quad 정점 히트. floor 레이어 표시 중 + 현재 preset quad 有 일 때만. → 0|1|2|3|null */
function hitTestFloorVertex(nx, ny) {
  // 파일 모드에선 LLM 슬롯 floor 가 안 보이므로 편집 정점 히트 제외(파일 ROI 는 읽기전용).
  if (!state.selectedSlotId || !state.mapping || !$('roi-floor').checked || !$('cap-floor-llm').checked) return null;
  const key = presetKey(state.cam, state.preset);
  const slot = (state.mapping.slots ?? []).find((s) => s.slotId === state.selectedSlotId);
  const quad = slot?.floorRoiByPreset?.[key];
  if (!quad) return null;
  const tolX = HANDLE_PX / (overlay.width || frame.clientWidth || 1);
  const tolY = HANDLE_PX / (overlay.height || frame.clientHeight || 1);
  return hitTestQuadVertex(quad, nx, ny, tolX, tolY);
}

/**
 * 선택 슬롯의 차량 rect 8핸들/내부 히트(요구 A Ctrl+드래그 편집). HANDLE_PX 를 오버레이 치수로
 * 정규화해 tol 로 주입하고 순수 hitTestRectHandle 에 위임(DOM/state 결합은 여기에만).
 * → 'nw'|'ne'|'sw'|'se'|'n'|'s'|'e'|'w'|'in'|null.
 */
function hitTestVpd(nx, ny) {
  if (!state.selectedSlotId || !state.mapping) return null;
  const key = presetKey(state.cam, state.preset);
  const slot = (state.mapping.slots ?? []).find((s) => s.slotId === state.selectedSlotId);
  const vrect = slot?.roiByPreset?.[key];
  if (!vrect) return null;
  const tolX = HANDLE_PX / (overlay.width || frame.clientWidth || 1);
  const tolY = HANDLE_PX / (overlay.height || frame.clientHeight || 1);
  return hitTestRectHandle(vrect, nx, ny, tolX, tolY);
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

/**
 * 현재 프리셋에 주차면 추가(요구 B: 전역 인덱스 중간삽입). 기본 rect(중앙 소형)·zone`cam{cam}`,
 * 삽입 위치는 #slot-insert-idx(1..N+1, 비우면 맨 끝). 추가 후 선택 → Ctrl+드래그로 배치 → '저장'.
 */
function addSlot() {
  const msg = $('map-msg');
  if (!state.mapping) {
    if (msg) msg.textContent = '표시된 산출물 없음';
    return;
  }
  const key = presetKey(state.cam, state.preset);
  const id = nextSlotId(state.mapping, state.cam, state.preset);
  const rect = { x: 0.45, y: 0.45, w: 0.1, h: 0.1 };
  const newSlot = { slotId: id, zone: `cam${state.cam}`, roiByPreset: { [key]: rect } };
  const N = (state.mapping.globalIndex ?? []).length;
  const raw = Number($('slot-insert-idx').value);
  const at = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.round(raw), N + 1) : N + 1;
  state.mapping = insertSlotAt(state.mapping, at, newSlot);
  state.selectedSlotId = id;
  markDirty();
  drawRoiOverlay();
  renderSlotList();
  renderSelectionInfo();
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

// --- [기능2] VPD/LPD 검출 박스 선택·크기조절·삭제(임시·메모리만) --------
// state.detectByKey[key] 를 메모리에서만 편집. runLiveDetect/프레임 순환이 재검출하면 편집분은 사라진다(임시).

/** 검출 박스 히트테스트용 tol(오버레이 치수 정규화, hitTestVpd 패턴). */
function detectTol() {
  return {
    tolX: HANDLE_PX / (overlay.width || frame.clientWidth || 1),
    tolY: HANDLE_PX / (overlay.height || frame.clientHeight || 1),
  };
}

/** 선택 검출 박스 정보 → #det-delete 버튼 활성 상태 갱신. */
function renderDetectSelection() {
  const btn = $('det-delete');
  if (btn) btn.disabled = !state.selectedDetect;
}

/** 선택한 검출 박스 삭제(메모리만). 다음 재검출/프레임 갱신 전까지 유효. */
function deleteSelectedDetect() {
  if (!state.selectedDetect) return;
  const key = currentFrameKey();
  const d = state.detectByKey[key];
  if (!d) return;
  state.detectByKey[key] = removeDetection(d, state.selectedDetect);
  state.selectedDetect = null;
  renderDetectSelection();
  drawRoiOverlay();
  renderSlotList(); // 검출 count·점유 갱신.
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

// --- 정밀수집 결과 저장/열기(로컬 파일) --------------------------------
// 저장: 현재 화면에 반영된 state.mapping(편집 반영본)을 OS 네이티브 저장 대화상자로 로컬 JSON 파일에 write.
// 열기: OS 네이티브 열기 대화상자로 로컬 JSON 선택 → state.mapping 주입 → 기존 3종 ROI 렌더 재사용.
// File System Access API(Chromium/보안컨텍스트) 우선, 미지원 시 Blob 다운로드·input[type=file] 폴백.

/**
 * 텍스트를 로컬 JSON 파일로 저장. showSaveFilePicker 지원 시 네이티브 대화상자,
 * 미지원 시 Blob+<a download> 폴백. → 저장된 파일명 | null(사용자 취소).
 */
async function saveJsonToFile(suggestedName, text) {
  if (typeof window.showSaveFilePicker === 'function') {
    let handle;
    try {
      handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
      });
    } catch (e) {
      if (e && e.name === 'AbortError') return null; // 사용자 취소.
      throw e;
    }
    const w = await handle.createWritable();
    await w.write(text);
    await w.close();
    return handle.name;
  }
  // 폴백: 다운로드 폴더로 내려받기(취소 개념 없음).
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  a.click();
  URL.revokeObjectURL(url);
  return suggestedName;
}

/**
 * OS 네이티브 열기 대화상자로 로컬 JSON 파일을 골라 텍스트로 읽는다.
 * 리더 확정(Q1): input[type=file] accept=".json,application/json" 단일 사용(모든 브라우저 호환·최소).
 * → 파일 텍스트 | null(취소=변경 이벤트 없음 → resolve 안 됨).
 */
function pickAndReadJsonFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) {
        resolve(null);
        return;
      }
      file.text().then(resolve, reject);
    });
    input.click();
  });
}

/** 로드한 artifact 를 state.mapping 에 주입하고 기존 3종 ROI 렌더 재사용. */
function applyLoadedMapping(artifact, label) {
  state.mapping = artifact;
  state.roiHidden = false;
  state.selectedSlotId = null;
  drawRoiOverlay();
  renderSlotList();
  renderSelectionInfo();
  const msg = $('map-msg');
  if (msg) msg.textContent = `열림: ${label}`;
}

/** '결과 저장' — 현재 state.mapping 을 로컬 JSON 파일로 저장(네이티브 대화상자/폴백). */
async function saveResult() {
  const msg = $('map-msg');
  if (!state.mapping) {
    if (msg) msg.textContent = '표시된 결과 없음 — 최종화 또는 결과 열기 후 저장하세요';
    return;
  }
  const name = defaultResultFilename();
  const text = JSON.stringify(state.mapping, null, 2);
  try {
    const saved = await saveJsonToFile(name, text);
    if (saved == null) return; // 사용자 취소 — 조용히 무동작.
    if (msg) msg.textContent = `저장됨: ${saved}`;
  } catch (err) {
    if (msg) msg.textContent = `저장 실패: ${err}`;
  }
}

/** '결과 열기' — 로컬 JSON 파일을 골라 파싱·검증 후 화면 반영. */
async function openResult() {
  const msg = $('map-msg');
  try {
    const text = await pickAndReadJsonFile();
    if (text == null) return; // 파일 미선택(취소) — 조용히 무동작.
    const r = parseLoadedArtifact(text);
    if (!r.ok) {
      if (msg) msg.textContent = `열기 실패: ${r.error}`;
      return;
    }
    applyLoadedMapping(r.artifact, '로컬 파일');
  } catch (err) {
    if (msg) msg.textContent = `열기 실패: ${err}`;
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

// --- 라이브 MJPEG 스트림 -------------------------------------------------
// 라이브 뷰를 <img src="/viewer/api/stream"> 로 연결(백엔드가 Unity /stream 을 SOI/EOI 로 재송신).
// 스트림 미지원 소스(RealPtzSource)·오류 시 기존 폴링(loop)으로 폴백한다.
let liveMode = 'off'; // 'off' | 'stream'(MJPEG) | 'poll'(폴백 폴링)

/** 현재 cam/preset/source + 현재 PTZ(state.ptz) 로 스트림 URL 조립(1-based, 루프3). */
function streamUrl() {
  const p = new URLSearchParams({ cam: state.cam, preset: state.preset });
  if (state.source) p.set('source', state.source);
  // pan/tilt/zoom 을 항상 부가 → Unity /stream 이 수동 PTZ·프리셋 PTZ 를 그대로 렌더(폴링 makeUrl 과 동일 값 정책).
  p.set('pan', state.ptz.pan);
  p.set('tilt', state.ptz.tilt);
  p.set('zoom', state.ptz.zoom);
  return api(`/stream?${p.toString()}`);
}

/** 라이브 시작: MJPEG 스트림 연결. 실패(501/네트워크/503) 시 폴링 폴백. */
function startLive() {
  liveMode = 'stream';
  loop.stop(); // 폴백 폴링이 돌던 경우 중지(카메라 공존 방지).
  frame.onerror = () => fallbackToPolling();
  frame.src = streamUrl();
  drawRoiOverlay(); // 시작 1회(스트림은 표시 크기 불변이라 per-frame 재그리기 불필요).
}

/** 라이브 정지: 스트림 연결 종료(→ reply.raw close → 상류 abort) + 폴백 폴링도 중지. */
function stopLive() {
  liveMode = 'off';
  frame.onerror = null;
  frame.removeAttribute('src'); // 연결 종료.
  loop.stop();
}

/** 스트림 실패 시 기존 폴링 경로로 폴백(미지원 소스·네트워크 오류). */
function fallbackToPolling() {
  frame.onerror = null; // 폴백 후 재진입 방지.
  if (liveMode === 'off') return;
  liveMode = 'poll';
  loop.start(Number($('fps').value) || 3);
}

/**
 * cam/preset 변경 시 라이브 중이면 스트림 모드로 (재)연결. 폴링(수동 override) 중이었으면
 * 폴링을 멈추고 스트림으로 복귀한다(프리셋/cam 은 /stream 이 존중하므로 MJPEG 뷰가 올바름).
 */
function reconnectLiveIfActive() {
  if (liveMode === 'off') return; // 라이브 꺼짐 → 무동작.
  if (liveMode === 'poll') loop.stop(); // 수동 폴링 중이었으면 중지 후 스트림 복귀.
  liveMode = 'stream';
  frame.onerror = () => fallbackToPolling();
  frame.src = streamUrl(); // 새 cam/preset 으로 (재)연결 → /stream 이 preset 존중.
  drawRoiOverlay(); // 스트림은 per-frame 재그리기 없음 → 재연결 시 1회.
}

// --- 제어 ---------------------------------------------------------------
async function move(ptz) {
  const res = await fetch(api('/move'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: state.source || undefined, cam: state.cam, ...ptz }),
  });
  if (!res.ok) return false;
  state.ptz = ptz;
  updatePtzDisplay();
  if (moveRenderDirective(liveMode) === 'stream-reconnect') {
    // 루프3: 물리 이동(/req_move)은 완료. 새 pan/tilt/zoom 이 실린 streamUrl 로 재연결하면
    // Unity /stream 이 그 각도를 프레임마다 렌더 → 수동 PTZ 가 라이브에 반영된다(폴링 전환 불필요).
    frame.src = streamUrl();
  } else {
    await loop.tick(); // poll 폴백 지속갱신 / off 1회 스냅샷 override.
  }
  return true;
}

/**
 * 프리셋 이동: 선택 프리셋으로 카메라를 실제 이동(현재 모드 무관).
 * 버그 수정 — 기존엔 loop.tick()만 호출해 수동 모드에선 PTZ override 가 가서 프리셋이 적용되지 않았음.
 * 프리셋 PTZ 가 있으면 /move(검증된 /req_move 경로)로 물리 이동, 없으면 preset 모드 스냅샷으로 강제 적용.
 */
async function gotoPreset() {
  const ptz = findPresetPtz(state.cameras, state.cam, state.preset);
  if (ptz) {
    await move(ptz); // 물리 이동+state 동기화. 스트림 모드면 move 가 새 PTZ 로 재연결(루프3, reconnect 와 동일 URL → 무해).
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

// --- 카메라 PTZ 프리셋 편집(camerapos.json) -----------------------------
// 뷰어 드롭다운의 프리셋은 camerapos.json(카메라 PTZ 프리셋). 여기서 생성/수정/삭제 후 전체 파일 저장.

function setPresetMsg(text, ok) {
  const el = $('preset-msg');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('error', ok === false);
}

/** GET /viewer/api/camerapos → 정규화 views[]. 실패 시 throw. */
async function loadCameraposViews() {
  const res = await fetch(api('/camerapos'), { cache: 'no-store' });
  if (!res.ok) throw new Error(`camerapos 로드 실패: ${res.status}`);
  const data = await res.json();
  return data.views ?? [];
}

/** PUT /viewer/api/camerapos(controlToken 준용) → Response. */
async function saveCameraposViews(views) {
  return fetch(api('/camerapos'), {
    method: 'PUT',
    headers: tokenHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ views }),
  });
}

/**
 * 편집된 views 를 저장(PUT)하고 목록을 강제 재렌더한다.
 * PTZ-only 수정은 camerasChanged 가 감지 못하므로 저장 경로는 loadCameras 후 명시적 renderCamSelect().
 * keepPreset 지정 시 재렌더 전 state.preset 을 그 값으로 고정(신규 프리셋 선택 유지).
 */
async function persistCamerapos(views, keepPreset) {
  const res = await saveCameraposViews(views);
  if (!res.ok) {
    setPresetMsg(`저장 실패: ${res.status}`, false);
    return false;
  }
  await loadCameras();
  if (keepPreset != null) state.preset = keepPreset;
  renderCamSelect();
  return true;
}

/**
 * 현재 state.ptz 로 프리셋 저장. asNew=true 면 새 preset_id 로 추가, 아니면 선택 프리셋 갱신.
 * 이름은 제어패널 #preset-label.
 */
async function savePreset(asNew) {
  try {
    let views = await loadCameraposViews();
    const camIdx = state.cam;
    const presetIdx = asNew ? nextPresetId(views, camIdx) : state.preset;
    const label = ($('preset-label')?.value ?? '').trim() || `Preset ${presetIdx}`;
    views = upsertPreset(views, {
      camIdx,
      presetIdx,
      label,
      pan: Number(state.ptz.pan),
      tilt: Number(state.ptz.tilt),
      zoom: clampZoom(Number(state.ptz.zoom)),
    });
    if (await persistCamerapos(views, presetIdx)) {
      setPresetMsg(`저장됨: cam ${camIdx} · preset ${presetIdx}`, true);
    }
  } catch (e) {
    setPresetMsg(`저장 오류: ${e}`, false);
  }
}

/** 선택 프리셋 삭제 후 저장. */
async function deletePreset() {
  try {
    let views = await loadCameraposViews();
    views = removePreset(views, state.cam, state.preset);
    if (await persistCamerapos(views)) setPresetMsg('삭제됨', true);
  } catch (e) {
    setPresetMsg(`삭제 오류: ${e}`, false);
  }
}

// --- 주차면 목록 편집(PtzCamRoi.json 전역 인덱스) — 선택·수정·삭제·저장·열기(R4) ---
// 소스는 state.placeRoi(전역 인덱스 1..N). 편집은 메모리 버퍼 → '저장'(전 프리셋 순차 PUT)으로 확정.

function setPlaceMsg(text) {
  const el = $('place-msg');
  if (el) el.textContent = text;
}

/** 편집 후 미저장 표시(기본 문구 또는 지정 문구). */
function markPlaceDirty(text) {
  state.placeRoiDirty = true;
  setPlaceMsg(text ?? '편집됨(미저장) — 저장을 눌러 PtzCamRoi.json 에 반영');
}

/** 선택된 주차면 정보·삭제 버튼 활성 상태 갱신. */
function renderPlaceSelectionInfo() {
  const info = $('place-sel-info');
  const delBtn = $('place-delete');
  if (!info || !delBtn) return;
  if (state.selectedPlaceIdx == null) {
    info.textContent = '선택된 주차면 없음';
    delBtn.disabled = true;
    return;
  }
  info.textContent = `선택: #${state.selectedPlaceIdx}`;
  delBtn.disabled = false;
}

/** 총 주차면 수(전역 인덱스 N). */
function placeSpaceCount() {
  return Object.values(state.placeRoi ?? {}).reduce((n, spaces) => n + spaces.length, 0);
}

/** '선택'(행 클릭): 하이라이트 + 다른 프리셋이면 cam/preset 전환 → 물리 이동 → 라이브 재연결 → 오버레이 노출. */
function selectPlaceSpace(row) {
  state.selectedPlaceIdx = row.globalIdx;
  $('place-gidx').value = String(row.globalIdx);
  if (row.cam !== state.cam || row.preset !== state.preset) {
    state.cam = row.cam;
    state.preset = row.preset;
    renderCamSelect(); // 제어패널 셀렉트 동기화(cam/preset).
    gotoPreset(); // 선택 프리셋으로 Unity 물리 이동(cam.setPTZ 경로).
    reconnectLiveIfActive(); // 라이브 중이면 새 프리셋으로 스트림 재연결.
  }
  drawRoiOverlay();
  renderSlotList();
}

/** '수정': 선택 주차면의 전역 인덱스를 #place-gidx 값으로 변경(나머지는 밀어 1..N 연속 유지). */
function editPlaceIdx() {
  if (state.selectedPlaceIdx == null) {
    setPlaceMsg('선택된 주차면이 없습니다');
    return;
  }
  const to = Number($('place-gidx').value);
  if (!Number.isFinite(to) || to < 1) {
    setPlaceMsg('변경할 전역 인덱스를 입력하세요(1 이상)');
    return;
  }
  state.placeRoi = reindexPlaceSpace(state.placeRoi, state.selectedPlaceIdx, to);
  state.selectedPlaceIdx = Math.min(Math.round(to), placeSpaceCount()); // 1..N clamp 결과와 동기화.
  markPlaceDirty();
  drawRoiOverlay();
  renderSlotList();
}

/** '삭제': 선택 주차면 제거 후 1..N 재압축(메모리만 — '저장'으로 확정). */
function deletePlaceSpace() {
  if (state.selectedPlaceIdx == null) return;
  state.placeRoi = removePlaceSpace(state.placeRoi, state.selectedPlaceIdx);
  state.selectedPlaceIdx = null;
  markPlaceDirty();
  drawRoiOverlay();
  renderSlotList();
}

/**
 * '저장': state.placeRoi 전 프리셋을 PUT /capture/place-roi 로 순차 저장(PtzCamRoi.json).
 * 서버가 요청마다 readFile→apply→writeFile 하므로 반드시 직렬 await(병렬 시 갱신 유실).
 * 하나라도 실패하면 즉시 중단 + 실패 프리셋 명시(부분 저장 상태를 숨기지 않는다).
 */
async function savePlaceRoi() {
  const keys = Object.keys(state.placeRoi ?? {});
  if (!keys.length) {
    setPlaceMsg('저장할 주차면이 없습니다');
    return;
  }
  for (const key of keys) {
    const [cam, preset] = key.split(':').map(Number);
    try {
      const res = await fetch('/capture/place-roi', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ camId: cam, presetIdx: preset, spaces: state.placeRoi[key] }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setPlaceMsg(`저장 실패(cam${cam}:${preset}): ${data.error ?? res.status} — 이후 프리셋은 저장되지 않음`);
        return;
      }
    } catch (e) {
      setPlaceMsg(`저장 실패(cam${cam}:${preset}, 네트워크): ${e}`);
      return;
    }
  }
  state.placeRoiDirty = false;
  setPlaceMsg(`저장됨: ${keys.length}개 프리셋 · ${placeSpaceCount()}개 주차면(PtzCamRoi.json)`);
}

/** '열기': 로컬 PtzCamRoi.json → 정규화 + 전역번호 정규화 → 미저장 버퍼(저장으로 확정). */
async function openPlaceRoi() {
  try {
    const text = await pickAndReadJsonFile();
    if (text == null) return; // 취소 — 조용히 무동작.
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      setPlaceMsg('열기 실패: 올바른 JSON 파일이 아닙니다(파싱 실패)');
      return;
    }
    const { byPreset, report } = normalizePtzCamRoi(json);
    if (!Object.keys(byPreset).length) {
      setPlaceMsg('열기 실패: PtzCamRoi 형식이 아니거나 주차면이 없습니다');
      return;
    }
    const norm = normalizeGlobalIdx(byPreset);
    state.placeRoi = norm.placeRoi;
    state.placeRoiReport = {};
    for (const r of report) state.placeRoiReport[presetKey(r.camId, r.presetIdx)] = r.issues;
    state.selectedPlaceIdx = null;
    markPlaceDirty(`열림(미저장): ${Object.keys(state.placeRoi).length}개 프리셋 · ${placeSpaceCount()}개 주차면 — '저장'으로 확정`);
    drawRoiOverlay();
    renderSlotList();
  } catch (e) {
    setPlaceMsg(`열기 실패: ${e}`);
  }
}

// --- [기능3] 주차면 자동보정(이동+스케일, sharp 상호상관) ---------------
// 기준 프레임 대비 현재 프레임 정합 → state.placeRoi 폴리곤 이동/스케일 → 검토 후 PtzCamRoi.json 저장.

function setAlignMsg(text) {
  const el = $('align-msg');
  if (el) el.textContent = text;
}

/** 자동보정 대상 프리셋(수집 중이면 순환 프레임, 아니면 라이브 선택). */
function alignTarget() {
  return {
    cam: state.capFrameKey2?.cam ?? state.cam,
    preset: state.capFrameKey2?.preset ?? state.preset,
  };
}

/** '기준 저장': 현재 프리셋 프레임을 자동보정 기준으로 저장(POST /capture/refframe). */
async function alignSaveRef() {
  const { cam, preset } = alignTarget();
  try {
    const res = await fetch('/capture/refframe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cam, preset }),
    });
    const data = await res.json().catch(() => ({}));
    setAlignMsg(res.ok ? `기준 저장됨: cam${cam} 프리셋${preset}` : `기준 저장 실패: ${data.error ?? res.status}`);
  } catch (e) {
    setAlignMsg(`기준 저장 실패(네트워크): ${e}`);
  }
}

/** '주차면 자동보정': 기준 대비 현재 프레임 정합 → placeRoi 폴리곤 이동/스케일 → 오버레이 반영. */
async function alignRun() {
  const { cam, preset } = alignTarget();
  const key = presetKey(cam, preset);
  const spaces = state.placeRoi?.[key];
  if (!spaces || !spaces.length) {
    setAlignMsg('이 프리셋의 파일 주차면(PtzCamRoi.json)이 없습니다');
    return;
  }
  try {
    const res = await fetch('/capture/autocorrect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cam, preset }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setAlignMsg(`자동보정 실패: ${data.error ?? res.status}`);
      return;
    }
    const { dx, dy, scale, peak } = data;
    // 되돌리기 스냅샷(직전 상태 깊은 복사).
    state.placeRoiBackup = { key, spaces: JSON.parse(JSON.stringify(spaces)) };
    state.placeRoi[key] = transformPlaceRoiPreset(spaces, { dx, dy, scale });
    drawRoiOverlay();
    setAlignMsg(
      `신뢰도(peak) ${Number(peak).toFixed(3)} · 이동(${dx.toFixed(3)}, ${dy.toFixed(3)}) 스케일 ${Number(scale).toFixed(3)} — 이동/스케일만(회전·원근 미보정)`,
    );
  } catch (e) {
    setAlignMsg(`자동보정 실패(네트워크): ${e}`);
  }
}

/** '되돌리기': 자동보정 직전 스냅샷 복원. */
function alignUndo() {
  const b = state.placeRoiBackup;
  if (!b || !state.placeRoi) {
    setAlignMsg('되돌릴 자동보정 내역이 없습니다');
    return;
  }
  state.placeRoi[b.key] = b.spaces;
  state.placeRoiBackup = null;
  drawRoiOverlay();
  setAlignMsg('되돌렸습니다');
}

/** '저장': 보정된 주차면을 PtzCamRoi.json 에 저장(PUT /capture/place-roi, 무토큰). */
async function alignApply() {
  const { cam, preset } = alignTarget();
  const key = presetKey(cam, preset);
  const spaces = state.placeRoi?.[key];
  if (!spaces || !spaces.length) {
    setAlignMsg('저장할 주차면이 없습니다');
    return;
  }
  try {
    const res = await fetch('/capture/place-roi', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ camId: cam, presetIdx: preset, spaces }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      state.placeRoiBackup = null; // 저장 확정 → 되돌리기 소진.
      setAlignMsg(`저장됨: ${data.spaceCount ?? spaces.length}개 주차면(PtzCamRoi.json)`);
    } else {
      setAlignMsg(`저장 실패: ${data.error ?? res.status}`);
    }
  } catch (e) {
    setAlignMsg(`저장 실패(네트워크): ${e}`);
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
  // 이번 run 에 실제 적용된 VPD 필터 모드(체크박스가 아니라 서버 status 가 진실 — 진행 중 토글과 혼동 방지).
  if (status?.vpdOnParkingOnly !== undefined) {
    const div = document.createElement('div');
    div.className = 'adv-line';
    div.textContent = status.vpdOnPlaceDegraded
      ? `주차면필터 강등(모든 차량 검출) — ${status.vpdOnPlaceDegraded}`
      : `주차면필터 ${status.vpdOnParkingOnly ? 'ON' : 'OFF'}${
          status.vpdFilteredOut || status.lpdFilteredOut
            ? `(차량 제외 ${status.vpdFilteredOut ?? 0}대 · 번호판 제외 ${status.lpdFilteredOut ?? 0})`
            : ''
        }`;
    $('cap-advisory').appendChild(div);
  }
  // 서버 state 에 버튼·정지안내를 일관 정합(어느 경로로 진입하든 재클릭 400/409 원천 차단).
  const ui = captureUiState(status?.state ?? 'idle');
  $('cap-start').disabled = ui.startDisabled;
  $('cap-stop').disabled = ui.stopDisabled;
  $('cap-finalize').disabled = ui.finalizeDisabled;
  if (ui.stoppingNote) $('cap-msg').textContent = '정지 중… (현재 라운드 마무리 후 종료)';
}

// 1초 틱: 진행 중이면 경과 시간을 부드럽게 갱신(폴링은 2초라 그 사이도 갱신).
setInterval(() => {
  const st = lastCapStatus?.state;
  if (st === 'running' || st === 'stopping' || st === 'finalizing') renderElapsed();
}, 1000);

// 캡처 중 Live View 에 '최근 캡처 프레임'을 표시(카메라 재명령 없이 잡이 찍은 프레임을 추종).
// 파라미터 없이 /capture/frame 을 요청 → 서버는 가장 최근 캡처 프레임만 반환.
// 잡이 타깃을 찍을 때마다 최신 프레임이 갱신되므로 웹이 캡처 진행(=Unity 이동)을 추종하고,
// 라운드 사이 대기 중엔 동일 프레임이 반환되어 사실상 정지(순환 없음).
let capFrameTimer = null;
let capFrameUrl = null;
let lastCapFrameKey = null; // 직전 프레임 키(cam:preset:round). 동일하면 재디코드 스킵.
let lastDetectKey = null; // 직전 자동검출 프리셋 키(cam:preset). 동일 프리셋 재검출 폭주 방지(R1).

async function capFrameTick() {
  try {
    const res = await fetch('/capture/frame', { cache: 'no-store' });
    if (!res.ok) return;
    const key = capFrameKey(
      res.headers.get('X-Cap-Cam'),
      res.headers.get('X-Cap-Preset'),
      res.headers.get('X-Cap-Round'),
    );
    // 직전과 같은 캡처(대기 중 동일 프레임)면 blob 생성·src 교체·cap-msg 갱신을 스킵(깜빡임/재디코드 방지).
    if (key != null && key === lastCapFrameKey) return;
    lastCapFrameKey = key;
    const url = URL.createObjectURL(await res.blob());
    frame.src = url;
    if (frame.decode) await frame.decode().catch(() => {});
    if (capFrameUrl) URL.revokeObjectURL(capFrameUrl);
    capFrameUrl = url;
    const c = res.headers.get('X-Cap-Cam');
    if (c != null) {
      const cp = res.headers.get('X-Cap-Preset');
      const nextKey = presetKey(Number(c), Number(cp));
      state.capFrameKey2 = { cam: Number(c), preset: Number(cp) }; // 점유율 오버레이 현재 프리셋 판별 근거.
      // 정지 중엔 '정지 중…' 안내를 프레임틱이 덮지 않도록 가드(프레임 이미지 갱신은 유지).
      if (!captureUiState(lastCapStatus?.state ?? 'idle').suppressFrameMsg) {
        $('cap-msg').textContent =
          `수집 중 — cam${c} 프리셋${cp} (라운드 ${res.headers.get('X-Cap-Round')})`;
      }
      drawRoiOverlay(); // 프레임(프리셋) 갱신 시 현재 프리셋 점유 오버레이 재그림(수집 중 라이브).
      if (nextKey !== lastDetectKey) {
        lastDetectKey = nextKey; // 프리셋당 1회 자동 검출(R1) — 동일 프리셋 순환/대기 프레임엔 재검출 안 함.
        runLiveDetect();
      }
    }
  } catch {
    /* ignore */
  }
}

function startCapFramePolling() {
  if (capFrameTimer) return;
  stopLive(); // 라이브 MJPEG 스트림 중지 — 카메라를 캡처와 다투지 않게(폴백 폴링 포함).
  lastCapFrameKey = null; // 프레임 키 초기화(이전 run 잔여 제거).
  lastDetectKey = null; // 자동검출 가드 초기화(이전 run 잔여 제거, R1).
  capFrameTimer = setInterval(capFrameTick, 500);
  capFrameTick();
}

function stopCapFramePolling() {
  if (capFrameTimer) {
    clearInterval(capFrameTimer);
    capFrameTimer = null;
  }
  state.capFrameKey2 = null; // 잔여 프리셋 오지정 방지(수집 종료 후 라이브 선택 프리셋으로 복귀).
}

let prevCapState = 'idle';
// floor ROI LLM 경고 메시지박스 런당 1회 가드(매 폴링 반복 팝업 방지).
let floorLlmWarnShown = false;
// 점유율 LLM 경고 메시지박스 런당 1회 가드(floor 대칭).
let occLlmWarnShown = false;
// 점유율 fetch 과호출 회피: status.round 변화 게이트(직전 라운드).
let prevCapRound = null;

/** 점유율 조회 → state.occByKey 갱신 → 오버레이 재그림. runId 없으면 no-op. */
async function fetchOccupancy(runId) {
  if (runId == null) return;
  try {
    const res = await fetch(`/capture/runs/${runId}/occupancy`, { cache: 'no-store' });
    if (!res.ok) return;
    const rows = await res.json();
    state.occByKey = occupancyByKey(rows);
    drawRoiOverlay();
  } catch {
    /* ignore */
  }
}

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
  // 종료 결과에 프리셋별 차량 점유율 요약 라인 append(occupancy 있을 때만).
  const occRows = occupancyRows(state.occByKey);
  if (occRows.length) {
    const head = document.createElement('div');
    head.textContent = '프리셋별 차량 점유율:';
    body.appendChild(head);
    for (const r of occRows) {
      const d = document.createElement('div');
      d.textContent = `프리셋 ${r[0]}: ${r[3]}/${r[4]} (${r[5]})`;
      body.appendChild(d);
    }
  }
  $('cap-result-modal').hidden = false;
}

async function capPoll() {
  const status = await capFetchStatus();
  renderCaptureStatus(status);
  const st = status?.state ?? 'idle';
  state.lastRunId = status?.runId ?? state.lastRunId; // 점유율 조회 근거(런 유지).
  // floor ROI LLM 동작불가 → 경고 메시지박스 1회 표시(런당 가드).
  if (status?.llmFloorUnavailable && !floorLlmWarnShown) {
    floorLlmWarnShown = true;
    $('floor-llm-warn-modal').hidden = false;
  }
  // 차량 점유율 LLM 동작불가 → 경고 메시지박스 1회 표시(floor 대칭).
  if (status?.llmOccupancyUnavailable && !occLlmWarnShown) {
    occLlmWarnShown = true;
    $('occ-llm-warn-modal').hidden = false;
  }
  const active = st === 'running' || st === 'stopping' || st === 'finalizing';
  if (active) {
    startCapFramePolling();
    // 체크포인트 갱신(round 변화) 게이트에서만 occupancy fetch(500ms 프레임폴에는 얹지 않음).
    const round = status?.round ?? null;
    if (round != null && round !== prevCapRound) {
      prevCapRound = round;
      fetchOccupancy(state.lastRunId);
    }
  } else {
    stopCapFramePolling();
    if (st === 'done') {
      $('cap-msg').textContent = `수집 완료 (${status.done}/${status.planned} 라운드) — '최종화'를 누르면 주차면이 그려집니다`;
    }
  }
  // 활성 → 종료 전환 시 결과 메시지 박스를 1회 띄운다(최신 점유율 확보 후 → 요약 라인 포함).
  const wasActive = prevCapState === 'running' || prevCapState === 'stopping' || prevCapState === 'finalizing';
  if (wasActive && (st === 'done' || st === 'stopped' || st === 'error')) {
    await fetchOccupancy(state.lastRunId);
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
  floorLlmWarnShown = false; // 새 런 시작 → floor ROI 경고 가드 재설정.
  occLlmWarnShown = false; // 새 런 시작 → 점유율 경고 가드 재설정.
  prevCapRound = null; // 점유율 fetch 라운드 게이트 재설정.
  state.occByKey = {}; // 이전 런 점유율 잔여 제거.
  state.occComputeByKey = {}; // 이전 런 로직 점유 잔여 제거(R4/R5).
  clearRoiDisplay(); // #6: 수집 시작 시 화면에 그려진 주차면을 깨끗이 정리.
  // 트리거 모드 상호배타: rounds → checkpointEvery, time → checkpointIntervalMs(초→ms).
  const mode = document.querySelector('input[name="cap-trigmode"]:checked')?.value || 'rounds';
  const body = {
    count: Number($('cap-count').value) || 50,
    intervalMs: (Number($('cap-interval').value) || 30) * 1000,
    checkpointTriggerMode: mode,
    ...(mode === 'time'
      ? { checkpointIntervalMs: (Number($('cap-ckint').value) || 60) * 1000 }
      : { checkpointEvery: Number($('cap-checkpoint').value) || 10 }),
    floorRoiUseLlm: $('cap-floor-llm').checked, // 바닥 ROI 소스 모드(ON=LLM 생성, OFF=파일). 백엔드 floorReviewer 게이트.
    vpdOnParkingOnly: $('cap-vpd-onplace').checked, // VPD 검출 모드(ON=주차면 위 차량만, OFF=모든 차량).
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
  // 낙관적 즉시 피드백: 폴링 도착 전 재클릭 방지 + '정지 중…' 표시(실패 시 아래에서 복원).
  $('cap-stop').disabled = true;
  $('cap-msg').textContent = '정지 중… (현재 라운드 마무리 후 종료)';
  const res = await fetch('/capture/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) $('cap-msg').textContent = `정지 실패: ${data.error ?? res.status}`;
  capPoll(); // 이후 renderCaptureStatus 가 실제 state 로 버튼·안내 재정합.
}

/** 최종화 바디 전달용 로직 점유 스냅샷(R4) — state.occComputeByKey → [{key, spaces:[{idx,occupied}]}]. */
function buildFinalizeOccupancy() {
  return Object.entries(state.occComputeByKey).map(([key, occ]) => ({
    key,
    spaces: (occ.spaces ?? []).map((s) => ({ idx: s.id, occupied: !!s.occupied })),
  }));
}

/** 최종화 후 DB parking_slots 조회 → state.parkingSlotsByKey(cam:preset → 행배열) 구성(§06 H7). 실패 시 조용히 미표시. */
async function loadParkingSlots() {
  const runId = state.lastRunId;
  if (!runId) return;
  try {
    const res = await fetch(`/capture/runs/${runId}/slots`, { cache: 'no-store' });
    if (!res.ok) return;
    const rows = await res.json();
    const byKey = {};
    for (const r of Array.isArray(rows) ? rows : []) {
      (byKey[r.presetKey] ??= []).push(r);
    }
    state.parkingSlotsByKey = byKey;
  } catch {
    /* 네트워크 실패 → 기존 리스트 유지(graceful). */
  }
}

async function capFinalize() {
  const res = await fetch('/capture/finalize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ occupancy: buildFinalizeOccupancy() }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    $('cap-msg').textContent = `최종화 완료: 슬롯 ${data.slots}, 전역 ${data.globalCount}`;
    state.roiHidden = false; // 최종화 결과를 다시 표시.
    await loadParkingSlots(); // 파일 바닥ROI 기준 주차면(DB parking_slots) 리스트 소스 로드(§06 H7).
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
    await renderOccupancyAnalysis(false); // 산출물 없어도 점유율은 독립(수집 후 최종화 전에도 표시).
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
  await renderOccupancyAnalysis(true); // 프리셋별 점유율 표 + 평균 요약카드.
}

/**
 * 분석 탭 점유율 표(#an-occupancy) 렌더. runId 는 state.lastRunId 우선, 없으면 GET /capture/runs[0].id 폴백.
 * 데이터 없으면 안내 문구. showAvgCard=true 면 an-summary 에 평균 점유율 카드 1장 append.
 */
async function renderOccupancyAnalysis(showAvgCard) {
  const box = $('an-occupancy');
  if (!box) return;
  box.innerHTML = '';
  let runId = state.lastRunId;
  if (runId == null) {
    try {
      const res = await fetch('/capture/runs', { cache: 'no-store' });
      const runs = res.ok ? await res.json() : [];
      runId = runs[0]?.id ?? null;
    } catch {
      runId = null;
    }
  }
  if (runId == null) {
    box.textContent = '점유율 데이터 없음 (정밀 수집 후 생성)';
    return;
  }
  try {
    const res = await fetch(`/capture/runs/${runId}/occupancy`, { cache: 'no-store' });
    const rows = res.ok ? await res.json() : [];
    state.occByKey = occupancyByKey(rows);
  } catch {
    /* ignore */
  }
  const orows = occupancyRows(state.occByKey);
  if (!orows.length) {
    box.textContent = '점유율 데이터 없음 (정밀 수집 후 생성)';
    return;
  }
  box.appendChild(buildTable(['프리셋 키', '카메라', '프리셋', '점유', '전체', '점유율%'], orows));
  if (showAvgCard) {
    $('an-summary').appendChild(summaryCard('평균 점유율', formatRatePct(occupancyAverage(state.occByKey).rate)));
  }
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

// --- 옵션(설정) 페이지 --------------------------------------------------
// GET /settings 로 폼을 채우고, PUT /settings 로 저장(부분 병합). apiKeyEnv(키 이름)만 표시, 키 값은 서버 env 유지.
// 저장 성공 시 restartRequired 배너 노출(config 는 nodemon watch 밖 → 런타임 반영 안 됨).

async function loadSettings() {
  const msg = $('opt-msg');
  $('opt-restart-banner').hidden = true;
  try {
    const res = await fetch('/settings', { cache: 'no-store' });
    if (!res.ok) {
      if (msg) msg.textContent = `설정 로드 실패: ${res.status}`;
      return;
    }
    const s = await res.json();
    $('opt-llm-provider').value = s.llm?.provider ?? '';
    $('opt-llm-model').value = s.llm?.model ?? '';
    $('opt-llm-baseurl').value = s.llm?.baseUrl ?? '';
    $('opt-vpd-endpoint').value = s.vpd?.endpoint ?? '';
    $('opt-vpd-detpath').value = s.vpd?.detPath ?? '';
    $('opt-lpd-endpoint').value = s.lpd?.endpoint ?? '';
    $('opt-lpd-detpath').value = s.lpd?.detPath ?? '';
    const keyLabel = (name) => (name ? `API 키 환경변수: ${name} (값은 서버 env 로만 주입 · 편집·표시 안 함)` : '');
    $('opt-llm-keyname').textContent = keyLabel(s.llm?.apiKeyEnv);
    $('opt-vpd-keyname').textContent = keyLabel(s.vpd?.apiKeyEnv);
    $('opt-lpd-keyname').textContent = keyLabel(s.lpd?.apiKeyEnv);
    if (msg) msg.textContent = '';
  } catch (err) {
    if (msg) msg.textContent = `설정 로드 실패(네트워크): ${err}`;
  }
}

async function saveSettings() {
  const msg = $('opt-msg');
  $('opt-restart-banner').hidden = true;
  const form = {
    llm: {
      provider: $('opt-llm-provider').value,
      model: $('opt-llm-model').value.trim(),
      baseUrl: $('opt-llm-baseurl').value.trim(),
    },
    vpd: { endpoint: $('opt-vpd-endpoint').value.trim(), detPath: $('opt-vpd-detpath').value.trim() },
    lpd: { endpoint: $('opt-lpd-endpoint').value.trim(), detPath: $('opt-lpd-detpath').value.trim() },
  };
  const errs = settingsFormErrors(form);
  if (errs.length) {
    if (msg) msg.textContent = `저장 불가: ${errs.join(' · ')}`;
    return;
  }
  try {
    const res = await fetch('/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(form),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      if (msg) msg.textContent = '저장됨';
      $('opt-restart-banner').hidden = !data.restartRequired;
    } else {
      if (msg) msg.textContent = `저장 실패: ${data.error ?? res.status}`;
    }
  } catch (err) {
    if (msg) msg.textContent = `저장 실패(네트워크): ${err}`;
  }
}

// --- Unity RPC 콘솔 + LLM 모델 전환(옵션 탭) -----------------------------

/** controlToken 입력값이 있으면 x-viewer-token 헤더를 붙인 headers 반환. */
function tokenHeaders(base = {}) {
  const t = $('viewer-token')?.value.trim();
  return t ? { ...base, 'x-viewer-token': t } : base;
}

/** POST /viewer/api/rpc — method/params 를 Unity 로 프록시(controlToken 게이트 준용). */
async function callRpc(method, params) {
  const body = { method };
  if (params !== undefined) body.params = params;
  const res = await fetch(api('/rpc'), {
    method: 'POST',
    headers: tokenHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

/** GET /viewer/api/rpc/catalog → #rpc-method 드롭다운 채움. */
async function loadRpcCatalog() {
  const sel = $('rpc-method');
  const out = $('rpc-result');
  try {
    const res = await fetch(api('/rpc/catalog'), { cache: 'no-store' });
    if (!res.ok) {
      if (out) out.textContent = `카탈로그 로드 실패: ${res.status}`;
      return;
    }
    const data = await res.json();
    const methods = data.methods ?? [];
    sel.innerHTML = methods.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
    if (out && !methods.length) out.textContent = '카탈로그 비어 있음(Unity 미가동?)';
  } catch (err) {
    if (out) out.textContent = `카탈로그 로드 실패(네트워크): ${err}`;
  }
}

/** [호출] 클릭 → params JSON 파싱 후 callRpc → 결과 표시. */
async function runRpcCall() {
  const out = $('rpc-result');
  const method = $('rpc-method')?.value;
  if (!method) {
    if (out) out.textContent = 'method 를 선택하세요';
    return;
  }
  const raw = $('rpc-params')?.value.trim();
  let params;
  if (raw) {
    try {
      params = JSON.parse(raw);
    } catch {
      if (out) out.textContent = 'params JSON 파싱 실패';
      return;
    }
  }
  if (out) out.textContent = '호출 중…';
  try {
    const { status, data } = await callRpc(method, params);
    if (out) out.textContent = `HTTP ${status}\n${JSON.stringify(data, null, 2)}`;
  } catch (err) {
    if (out) out.textContent = `호출 실패(네트워크): ${err}`;
  }
}

/** GET /viewer/api/llm/models → #opt-llm-active 드롭다운(활성 selected). */
async function loadLlmModels() {
  const sel = $('opt-llm-active');
  const msg = $('opt-llm-active-msg');
  if (!sel) return;
  try {
    const res = await fetch(api('/llm/models'), { cache: 'no-store' });
    if (!res.ok) {
      if (msg) msg.textContent = `모델 목록 실패: ${res.status}`;
      return;
    }
    const data = await res.json();
    const models = data.models ?? [];
    sel.innerHTML = models
      .map((m) => `<option value="${escapeHtml(m.id)}"${m.active ? ' selected' : ''}>${escapeHtml(m.name)} · ${escapeHtml(m.provider)}/${escapeHtml(m.model)}</option>`)
      .join('');
    if (msg) msg.textContent = models.length ? '' : '등록된 모델 없음';
  } catch (err) {
    if (msg) msg.textContent = `모델 목록 실패(네트워크): ${err}`;
  }
}

/** POST /viewer/api/llm/select {id} → 활성 전환(메모리, controlToken 준용). */
async function selectLlmModel(id) {
  const msg = $('opt-llm-active-msg');
  try {
    const res = await fetch(api('/llm/select'), {
      method: 'POST',
      headers: tokenHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ id }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      if (msg) msg.textContent = `활성 모델: ${data.active}`;
    } else if (msg) {
      msg.textContent = `전환 실패: ${data.error ?? res.status}`;
    }
  } catch (err) {
    if (msg) msg.textContent = `전환 실패(네트워크): ${err}`;
  }
}

// --- DB 뷰어(읽기 전용) --------------------------------------------------

/** DB 탭 진입 시 콤보 채움(1회) → 첫 테이블 자동 로드. GET /db/tables. */
async function loadDbTables() {
  if (state.dbTablesLoaded) return; // 이미 채움 → 재조회 skip.
  const sel = $('db-table-select');
  try {
    const res = await fetch('/db/tables', { cache: 'no-store' });
    if (!res.ok) {
      $('db-meta').textContent = `테이블 목록 실패: ${res.status}`;
      return;
    }
    const data = await res.json();
    const tables = data.tables ?? [];
    sel.innerHTML = tables.map((t) => `<option value="${t}">${t}</option>`).join('');
    state.dbTablesLoaded = true;
    if (tables.length) {
      state.dbTable = tables[0];
      state.dbOffset = 0;
      await loadDbRows();
    } else {
      $('db-meta').textContent = '테이블 없음';
    }
  } catch (err) {
    $('db-meta').textContent = `테이블 목록 실패(네트워크): ${err}`;
  }
}

/** 선택 테이블 + 검색 + 페이지 → 표 렌더. GET /db/table/:name. */
async function loadDbRows() {
  if (!state.dbTable) return;
  const params = new URLSearchParams({ limit: String(DB_LIMIT), offset: String(state.dbOffset) });
  if (state.dbSearch) params.set('search', state.dbSearch);
  try {
    const res = await fetch(`/db/table/${encodeURIComponent(state.dbTable)}?${params}`, { cache: 'no-store' });
    if (!res.ok) {
      $('db-table').innerHTML = '';
      $('db-meta').textContent = `조회 실패: ${res.status}`;
      return;
    }
    const data = await res.json();
    state.dbTotal = data.total ?? 0;
    renderDbTable(data);
  } catch (err) {
    $('db-meta').textContent = `조회 실패(네트워크): ${err}`;
  }
}

/** {columns, rows, total, offset} → <table> DOM + 메타·페이지 버튼 갱신(표 구성은 순수 buildDbTableModel). */
function renderDbTable(data) {
  const { headers, cells } = buildDbTableModel(data);
  const thead = `<thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${cells
    .map((row) => `<tr>${row.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody>`;
  $('db-table').innerHTML = `<table class="db-table">${thead}${tbody}</table>`;

  const shown = cells.length;
  const from = shown ? state.dbOffset + 1 : 0;
  $('db-meta').textContent = `${from}–${state.dbOffset + shown} / ${state.dbTotal}`;
  $('db-prev').disabled = state.dbOffset <= 0;
  $('db-next').disabled = state.dbOffset + DB_LIMIT >= state.dbTotal;
}

/** 표 셀·헤더 텍스트 이스케이프(XSS 방지 — 사용자 데이터가 셀로 들어옴). */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

// --- 탭 전환 ------------------------------------------------------------
function setTab(tab) {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  const analyze = tab === 'analyze';
  const options = tab === 'options';
  const db = tab === 'db';
  const full = analyze || options || db; // 전체폭 뷰(뷰포트·패널 숨김).
  document.querySelector('.viewport-wrap').hidden = full;
  $('panel-resizer').hidden = full;
  $('panel').hidden = full;
  $('analyze-view').hidden = !analyze;
  $('options-view').hidden = !options;
  $('db-view').hidden = !db;
  $('precise-box').hidden = tab !== 'precise';
  if (tab === 'precise') { capPoll(); calPoll(); loadPlaceRoi(); loadGroundModel(); }
  if (analyze) renderAnalysis();
  if (options) { loadSettings(); loadRpcCatalog(); loadLlmModels(); }
  if (db) loadDbTables();
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
  // mousedown: floor 정점 위면 정점 드래그 시작, 아니면 슬롯 선택/해제.
  overlay.addEventListener('mousedown', (e) => {
    const { nx, ny } = eventToNorm(e);
    // [기능2] 검출 박스 편집(임시): roi-detect ON + Ctrl 아님(슬롯 편집과 물리 배타). mapping/roiHidden 가드 이전.
    if ($('roi-detect').checked && !e.ctrlKey) {
      const dkey = currentFrameKey();
      const detect = state.detectByKey[dkey];
      if (detect) {
        const { tolX, tolY } = detectTol();
        const hit = hitTestDetections({ nx, ny, detect, tolX, tolY, selected: state.selectedDetect });
        if (hit) {
          state.selectedDetect = { kind: hit.kind, index: hit.index };
          renderDetectSelection();
          if (hit.kind === 'vehicle' && hit.handle && hit.handle !== 'in') {
            dragState = { kind: 'detResize', handle: hit.handle, key: dkey, last: { nx, ny } };
          } else if (hit.kind === 'vehicle') {
            dragState = { kind: 'detMove', key: dkey, last: { nx, ny } };
          } else if (hit.kind === 'plate' && hit.vertex != null) {
            dragState = { kind: 'detVertex', index: hit.vertex, key: dkey, last: { nx, ny } };
          } else {
            dragState = null; // plate 내부 선택(정점 아님) → 선택만.
          }
          drawRoiOverlay();
          e.preventDefault();
          return;
        }
        // 검출 편집 모드에서 빈 곳 클릭 → 검출 선택 해제 후 아래 슬롯 편집으로 낙하.
        if (state.selectedDetect) {
          state.selectedDetect = null;
          renderDetectSelection();
          drawRoiOverlay();
        }
      }
    }
    if (state.roiHidden || !state.mapping) return;
    const key = presetKey(state.cam, state.preset);
    // [요구 A] Ctrl+드래그 = 차량 rect 편집(기존 floor 정점/선택 분기보다 우선 — 물리 배타).
    if (e.ctrlKey && $('roi-vehicle').checked) {
      const h = hitTestVpd(nx, ny); // 선택 슬롯 vrect 의 핸들/내부.
      if (h && h !== 'in') {
        dragState = { kind: 'vpdResize', handle: h, slotId: state.selectedSlotId, key, last: { nx, ny } };
        e.preventDefault();
        return;
      }
      if (h === 'in') {
        dragState = { kind: 'vpdMove', slotId: state.selectedSlotId, key, last: { nx, ny } };
        e.preventDefault();
        return;
      }
      // 선택 슬롯 vrect 밖/미선택 → 커서 아래 차량박스 탐색 후 이동 시작.
      const hit = hitTestSlots({ nx, ny, slots: state.mapping.slots ?? [], key, layers: { vehicle: true, floor: false } });
      if (hit) {
        state.selectedSlotId = hit;
        drawRoiOverlay();
        renderSlotList();
        renderSelectionInfo();
        dragState = { kind: 'vpdMove', slotId: hit, key, last: { nx, ny } };
        e.preventDefault();
        return;
      }
      // Ctrl 인데 빈 곳 → 아래 기존 분기로 낙하(=선택 해제).
    }
    const vi = hitTestFloorVertex(nx, ny);
    if (vi != null && state.selectedSlotId) {
      dragState = { kind: 'floorVertex', index: vi, slotId: state.selectedSlotId, key, last: { nx, ny } };
      e.preventDefault();
      return;
    }
    // 선택/해제: 차량 ROI(레이어 토글 반영) 히트테스트.
    const layers = { vehicle: $('roi-vehicle').checked, floor: $('roi-floor').checked };
    const hit = hitTestSlots({ nx, ny, slots: state.mapping.slots ?? [], key, layers });
    state.selectedSlotId = hit; // 빈 곳 → null(해제).
    drawRoiOverlay();
    renderSlotList();
    renderSelectionInfo();
  });

  // mousemove: 드래그 진행 중이면 kind 별 실시간 미리보기.
  window.addEventListener('mousemove', (e) => {
    if (!dragState) return;
    const { nx, ny } = eventToNorm(e);
    const ndx = nx - dragState.last.nx;
    const ndy = ny - dragState.last.ny;
    // [기능2] 검출 박스 편집(임시·메모리만): detResize/detMove(vehicle rect) / detVertex(plate quad).
    if (dragState.kind === 'detResize' || dragState.kind === 'detMove' || dragState.kind === 'detVertex') {
      const d = state.detectByKey[dragState.key];
      const sel = state.selectedDetect;
      if (!d || !sel) return;
      if (sel.kind === 'vehicle') {
        const v = d.vehicles?.[sel.index];
        if (!v?.rect) return;
        v.rect = dragState.kind === 'detResize' ? resizeRect(v.rect, dragState.handle, ndx, ndy) : moveRect(v.rect, ndx, ndy);
      } else {
        const p = d.plates?.[sel.index];
        if (!p?.quad) return;
        p.quad = moveQuadVertex(p.quad, dragState.index, ndx, ndy);
      }
      dragState.last = { nx, ny };
      drawRoiOverlay();
      return;
    }
    const slot = (state.mapping.slots ?? []).find((s) => s.slotId === dragState.slotId);
    if (dragState.kind === 'floorVertex') {
      const cur = slot?.floorRoiByPreset?.[dragState.key];
      if (!cur) return;
      const next = moveQuadVertex(cur, dragState.index, ndx, ndy);
      state.mapping = updateSlotFloorRoi(state.mapping, dragState.slotId, dragState.key, next);
    } else {
      // vpdResize / vpdMove: 차량 rect 편집.
      const cur = slot?.roiByPreset?.[dragState.key];
      if (!cur) return;
      const next = dragState.kind === 'vpdResize'
        ? resizeRect(cur, dragState.handle, ndx, ndy)
        : moveRect(cur, ndx, ndy);
      state.mapping = updateSlotRoi(state.mapping, dragState.slotId, dragState.key, next);
    }
    dragState.last = { nx, ny };
    drawRoiOverlay();
  });

  // mouseup: 이동 확정. 검출 편집(det*)은 임시라 markDirty(mapping 미저장 표시) 생략.
  window.addEventListener('mouseup', () => {
    if (!dragState) return;
    const wasDetect = dragState.kind === 'detResize' || dragState.kind === 'detMove' || dragState.kind === 'detVertex';
    dragState = null;
    if (!wasDetect) markDirty();
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
  // 트리거 모드 라디오 → 해당 입력 필드만 표시(rounds: 체크포인트 라운드, time: 간격 초).
  for (const r of document.querySelectorAll('input[name="cap-trigmode"]')) {
    r.addEventListener('change', () => {
      const isTime = document.querySelector('input[name="cap-trigmode"]:checked')?.value === 'time';
      $('cap-checkpoint-field').hidden = isTime;
      $('cap-ckint-field').hidden = !isTime;
    });
  }
  $('cap-finalize').addEventListener('click', capFinalize);
  $('cal-start').addEventListener('click', calStart);
  $('cap-result-close').addEventListener('click', () => {
    $('cap-result-modal').hidden = true;
  });
  $('cap-result-finalize').addEventListener('click', () => {
    $('cap-result-modal').hidden = true;
    capFinalize();
  });
  $('floor-llm-warn-close').addEventListener('click', () => {
    $('floor-llm-warn-modal').hidden = true;
  });
  $('occ-llm-warn-close').addEventListener('click', () => {
    $('occ-llm-warn-modal').hidden = true;
  });
  $('an-refresh').addEventListener('click', renderAnalysis);
  $('an-download').addEventListener('click', downloadArtifact);
  $('an-raw-toggle').addEventListener('click', () => {
    $('an-raw-box').hidden = !$('an-raw-box').hidden;
  });
  $('an-manual-save').addEventListener('click', saveManualIndex); // #7
  $('an-manual-auto').addEventListener('click', autoNumberManual); // #7 자동 번호
  $('opt-save').addEventListener('click', saveSettings); // ④ 옵션 저장(PUT /settings)
  $('opt-reload').addEventListener('click', loadSettings); // ④ 옵션 새로고침(GET /settings)

  // Unity RPC 콘솔 + LLM 런타임 모델 전환.
  $('rpc-reload').addEventListener('click', loadRpcCatalog);
  $('rpc-call').addEventListener('click', runRpcCall);
  $('opt-llm-active').addEventListener('change', (e) => selectLlmModel(e.target.value));

  // DB 뷰어(§08): 콤보 선택·검색(디바운스)·페이지 이동.
  $('db-table-select').addEventListener('change', (e) => {
    state.dbTable = e.target.value;
    state.dbOffset = 0;
    loadDbRows();
  });
  let dbSearchTimer = null;
  $('db-search').addEventListener('input', (e) => {
    const v = e.target.value;
    if (dbSearchTimer) clearTimeout(dbSearchTimer);
    dbSearchTimer = setTimeout(() => {
      state.dbSearch = v;
      state.dbOffset = 0;
      loadDbRows();
    }, 250);
  });
  $('db-prev').addEventListener('click', () => {
    state.dbOffset = Math.max(0, state.dbOffset - DB_LIMIT);
    loadDbRows();
  });
  $('db-next').addEventListener('click', () => {
    state.dbOffset += DB_LIMIT;
    loadDbRows();
  });

  $('sel-source').addEventListener('change', async (e) => {
    state.source = e.target.value;
    state.isHucoms = false; // 소스 kind 는 서버만 앎 → login 박스는 시도 후 표시
    $('login-box').hidden = false;
    await loadCameras();
  });
  $('sel-cam').addEventListener('change', (e) => {
    state.cam = Number(e.target.value);
    state.preset = null; // 수동 카메라 변경은 새 카메라 첫 프리셋으로(pickSelected 폴백). 자동 갱신 경로만 선택 유지.
    state.selectedSlotId = null; // 프리셋 컨텍스트 전환 시 선택 해제.
    state.selectedDetect = null; // [기능2] 프리셋 전환 시 검출 선택 해제(교차 프리셋 오선택 방지).
    renderDetectSelection();
    renderPresetSelect(); // state.preset 을 새 카메라 첫 프리셋으로 확정
    drawRoiOverlay(); // #4: 카메라 전환 시 해당 ROI 즉시 재그리기.
    renderSelectionInfo();
    gotoPreset(); // 카메라 전환 시 새 카메라 선택 프리셋으로 Unity 물리 이동(비대기)
    reconnectLiveIfActive(); // 라이브 중이면 새 cam 으로 스트림 재연결.
  });
  $('sel-preset').addEventListener('change', (e) => {
    state.preset = Number(e.target.value);
    state.selectedSlotId = null; // 프리셋 전환 시 선택 해제.
    state.selectedDetect = null; // [기능2] 프리셋 전환 시 검출 선택 해제(교차 프리셋 오선택 방지).
    renderDetectSelection();
    syncPtzFromPreset();
    renderSlotList();
    drawRoiOverlay(); // #4: 프리셋 전환 시 해당 프리셋 ROI 즉시 재그리기(미호출 버그 수정).
    renderSelectionInfo();
    gotoPreset(); // 선택 프리셋으로 Unity 물리 이동(비대기, fire-and-forget)
    reconnectLiveIfActive(); // 라이브 중이면 새 preset 으로 스트림 재연결.
  });

  $('btn-start').addEventListener('click', () => startLive());
  $('btn-stop').addEventListener('click', () => stopLive());
  $('btn-goto').addEventListener('click', () => { gotoPreset(); reconnectLiveIfActive(); }); // poll 상태에서 이동 시 스트림 복귀.
  $('preset-save').addEventListener('click', () => savePreset(false)); // 선택 프리셋을 현재 PTZ로 갱신
  $('preset-new').addEventListener('click', () => savePreset(true)); // 현재 PTZ를 새 프리셋으로 추가
  $('preset-delete').addEventListener('click', deletePreset); // 선택 프리셋 삭제
  $('roi-vehicle').addEventListener('change', drawRoiOverlay);
  $('roi-plate').addEventListener('change', drawRoiOverlay);
  $('roi-floor').addEventListener('change', drawRoiOverlay);
  $('roi-occupancy').addEventListener('change', drawRoiOverlay); // 점유 오버레이 토글.
  $('cap-floor-llm').addEventListener('change', drawRoiOverlay); // 바닥 ROI 소스(LLM/파일) 모드 전환 → 즉시 재렌더.
  $('roi-detect').addEventListener('change', drawRoiOverlay); // 라이브 검출 오버레이 토글(§04).
  $('roi-cuboid').addEventListener('change', drawRoiOverlay); // 3D 육면체 레이어 토글(기본 off → 회귀 0).
  // 차량 육면체 토글(기본 off → 회귀 0). 켤 때만 서버 왕복(라우트가 카메라를 1회 촬영) — 캐시 있으면 재사용.
  $('roi-vcuboid').addEventListener('change', (e) => {
    drawRoiOverlay();
    if (e.target.checked && !state.vcuboidByKey[currentFrameKey()]) loadVehicleCuboids();
  });
  // 높이 슬라이더: 드래그 틱마다 즉시 재그리기(wirePanelResize 의 연속 재렌더 선례) + localStorage 영속.
  const cuboidH = $('cuboid-h');
  const savedH = Number(localStorage.getItem(CUBOID_H_KEY));
  if (savedH >= 0.5 && savedH <= 3.0) cuboidH.value = String(savedH);
  const syncCuboidH = () => { $('cuboid-h-val').textContent = `${cuboidHeight().toFixed(2)}m`; };
  syncCuboidH();
  cuboidH.addEventListener('input', () => {
    syncCuboidH();
    drawRoiOverlay(); // 서버 왕복 0(뷰어 순수 투영) → 드래그 중에도 매끄럽다.
  });
  cuboidH.addEventListener('change', () => localStorage.setItem(CUBOID_H_KEY, String(cuboidHeight())));
  $('cap-detect-run').addEventListener('click', runLiveDetect); // 현재 프리셋 1회 검출 실행(§04).
  $('roi-clear').addEventListener('click', clearRoiDisplay); // #5: 표시 초기화
  // 산출물(setup_artifact) 편집·결과 파일 도구(분석 탭으로 이관 — 핸들러·id 는 동일).
  $('slot-add').addEventListener('click', addSlot); // 요구 B: 전역 인덱스 중간삽입
  $('roi-delete').addEventListener('click', deleteSelectedSlot); // #2
  $('map-save').addEventListener('click', saveMapping); // #2/#3/#7 영속화
  $('result-save').addEventListener('click', saveResult); // 정밀수집 결과 저장(로컬 파일)
  $('result-open').addEventListener('click', openResult); // 정밀수집 결과 열기(로컬 파일)

  // 주차면 목록·편집(PtzCamRoi 전역 인덱스): 수정·삭제·저장·열기(선택은 목록 행 클릭).
  $('place-edit').addEventListener('click', editPlaceIdx);
  $('place-delete').addEventListener('click', deletePlaceSpace);
  $('place-save').addEventListener('click', savePlaceRoi);
  $('place-open').addEventListener('click', openPlaceRoi);

  // [기능2] 검출 박스 편집(임시): 삭제 버튼 + 단축키(Delete/Backspace=삭제, Esc=해제).
  $('det-delete').addEventListener('click', deleteSelectedDetect);
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return; // 입력 포커스 시 무시.
    if (!state.selectedDetect) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteSelectedDetect();
    } else if (e.key === 'Escape') {
      state.selectedDetect = null;
      renderDetectSelection();
      drawRoiOverlay();
    }
  });

  // [기능3] 주차면 자동보정.
  $('align-save-ref').addEventListener('click', alignSaveRef);
  $('align-run').addEventListener('click', alignRun);
  $('align-undo').addEventListener('click', alignUndo);
  $('align-apply').addEventListener('click', alignApply);

  wireOverlayEditing();

  document.querySelectorAll('[data-dir]').forEach((b) =>
    b.addEventListener('click', () => {
      const step = Number($('step').value) || 2;
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
  // 요구사항 5: 페이지 로드 시 기존 결과(ROI 3종)를 자동 표시하지 않는다.
  // → loadMapping() 자동 호출 제거. '결과 열기' 또는 finalize 로만 state.mapping 이 채워진다.
  const [camOk] = await Promise.all([loadCameras(), loadHealth()]);
  simConnected = camOk; // 초기 연결 상태 확정.
  $('badge-camera').classList.toggle('ok', !!camOk); // badge-camera = Unity 연결(loadCameras 성공).
  drawRoiOverlay();
  renderSelectionInfo();
  setInterval(connectionTick, CONN_POLL_MS); // 주기 폴 시작(연결/변경 자동 반영).
}

init();
