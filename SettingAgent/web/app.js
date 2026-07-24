// SettingViewer DOM 결선·이벤트·스트림 오케스트레이션(환경 의존).
// 순수 로직은 core.js 에서 import.
import {
  toPixel,
  toPixelQuad,
  presetKey,
  slotLabel,
  clampZoom,
  stepPtz,
  resolveAbsPtz, // 절대이동 입력 → PTZ(빈 칸=현재값 유지, 순수).
  createStreamLoop,
  moveRenderDirective, // 이동 시 렌더 경로 결정(순수). 루프3: stream=재연결 / poll·off=tick.
  captureProgress,
  captureElapsedMs,
  formatElapsed,
  captureResultSummary,
  mapAdvisory,
  pollPlan,
  captureUiState, // 상태→버튼/안내 UI 의도(순수, 백엔드 거부조건 대칭).
  discoverView, // /discover/status → 진행바·라벨·버튼disable·프레임폴 여부(순수, calPoll 미러).
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
  applyManualPlacement, // 배치(카메라/프리셋/프리셋내 위치) 직접 입력 검증(순수)
  slotMapModel,
  parseLoadedArtifact, // 로컬 결과 파일 파싱·최소형태검증(순수)
  defaultResultFilename, // 저장 대화상자 제안 파일명(순수)
  occupancyByKey, // 점유율 rows[] → cam:preset 맵(spacesJson 파싱, 순수)
  occupancyRows, // 점유율 맵 → 표 rows(정렬·포맷, 순수)
  formatRatePct, // 점유율 0~1 → 'NN%'(순수)
  occupancyAverage, // 전체 평균 점유율(순수)
  normalizePtzCamRoi, // PtzCamRoi.json raw → 프리셋별 정규화 폴리곤 + 검수(순수)
  selectFloorRoi, // 바닥 ROI 소스 선택(LLM/파일 토글, 순수)
  buildFlatSlotRows, // 전체 주차면 평면 목록(전역 인덱스 오름차순, 순수, R2)
  normalizeGlobalIdx, // 전역 인덱스 정규화·재부여(순수, R3)
  reindexPlaceSpace, // 전역 인덱스 재지정(밀어내기, 순수, R4)
  removePlaceSpace, // 주차면 삭제 + 1..N 재압축(순수, R4)
  settingsFormErrors, // 옵션 폼 클라이언트 검증(순수, URL/detPath 형식)
  alignProtocolToKind, // 카메라 타입(kind) 전환 시 protocol 계열 정합(순수)
  buildDbTableModel, // DB 뷰어 표 모델(columns/rows → headers/cells, 순수, §08 F6)
  pickSelected, // 목록 갱신 후 이전 cam/preset 선택 유지(순수)
  camerasChanged, // 카메라/프리셋 집합 변경 감지 → 변경 시에만 재렌더(순수)
  upsertPreset, // 카메라 PTZ 프리셋 upsert(camerapos.json 편집, 순수)
  removePreset, // 카메라 PTZ 프리셋 삭제(순수)
  nextPresetId, // 해당 카메라의 다음 presetIdx(순수)
  hitTestDetections, // [기능2] 검출 박스 히트테스트(순수)
  removeDetection, // [기능2] 검출 박스 삭제(순수, 불변)
  dedupeVehicles, // VPD 차량 중복 제거(IoU 연결요소, 차량당 1개=마지막 검지, 순수)
  transformPlaceRoiPreset, // [기능3] 프리셋 주차면 폴리곤 변환(순수, applyTranslateScale 내부 사용)
  projectCuboid, // 바닥 quad + 지면모델 + 높이 → 육면체 8점·12모서리(순수, 투영만)
  frontFaceCenter, // 육면체 앞면(근접면) 중심점(정규화, 순수) — 2D 위치표시 원
  formatGroundBadge, // 지면모델 소스 배지 문자열(순수)
  groundModelsByKey, // ground-model 응답 models[] → cam:preset 맵(순수)
  buildTouringPlan, // setup_result → Touring 순회 스텝 배열(카메라→프리셋→슬롯, 순수)
} from './core.js';
import { OccupancyJudge } from './occupancy.js'; // 번호판 우선·bbox 폴백 점유 판정(순수 컴포넌트).
import { computeOccupancyRegions } from './occupancyRegion.js'; // 번호판 기준 점유영역 사다리꼴(겹침 회피 자동 배율, 순수).

const occupancyJudge = new OccupancyJudge(); // 임계값 기본(groundBandRatio=0.25, minBandOverlap=0.15). 매 프레임 재사용.

const $ = (id) => document.getElementById(id);
const api = (path) => `/viewer/api${path}`;

/**
 * 바닥 ROI 소스 모드 — **파일 고정**(요건12). 구 `#cap-floor-llm` 체크박스가 제거되면서 상수로 접었다.
 * 값은 그 체크박스의 기본값(unchecked=false)과 동일하므로 화면 거동 변화는 0이다.
 * (백엔드 `floorRoiUseLlm` 스키마·게이트는 보존 — UI 요구이지 API 파괴 요구가 아니다.)
 */
const FLOOR_ROI_USE_LLM = false;

const state = {
  source: '',
  sourceDetails: {}, // source id → { kind, streamTransport }. 실카메라 RTSP 재생과 시뮬레이터 PTZ 렌더 분기 근거.
  ptzBusy: false, // 실카메라를 포함한 PTZ 명령 직렬화. 연속 클릭으로 장비에 명령이 누적되지 않게 한다.
  ptzStateReady: true, // 실카메라는 장비에서 현재 PTZ를 읽은 뒤에만 상대 이동을 허용한다.
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
  discoverByKey: {}, // cam:preset → discovery(앞면중심 LOOP) 결과 LPD OBB quad[](GET /discover/result found 분). 매 완료 시 대체. drawDetectOverlay 근거.
  selectedDetect: null, // [기능2] 선택된 검출 박스 { kind:'vehicle'|'plate', index } | null(임시 편집·메모리만).
  placeRoiBackup: null, // [기능3] 자동보정 직전 스냅샷 { key, spaces }(되돌리기용).
  parkingSlotsByKey: null, // 최종화 후 slot_setup(cam:preset → 행배열, GET /capture/slots). renderSlotList 소스(§06 H7).
  dbTablesLoaded: false, // DB 탭 콤보 1회 채움 가드.
  dbTable: '', // 현재 선택된 DB 테이블명.
  dbSearch: '', // DB 뷰어 검색어(전 컬럼 LIKE).
  dbOffset: 0, // DB 뷰어 페이지 오프셋.
  dbTotal: 0, // 최근 조회 total(prev/next 활성화 판정).
  groundByKey: {}, // cam:preset → 지면모델(GET /capture/ground-model). 육면체 투영의 유일한 근거(추정은 서버 소유).
  groundLoaded: false, // 지면모델 1회 로드 가드(실패해도 세션 1회).
  vcuboidByKey: {}, // cam:preset → 차량 육면체(정밀수집 job-cuboids / 검출 응답 인라인 / 수동 라이브 촬영).
  vcuboidLoading: new Set(), // 중복 요청 가드(프리셋 키 단위).
  vcuboidRound: {}, // cam:preset → 마지막으로 받아온 잡 라운드. status 인덱스가 바뀔 때만 전문을 재요청(폴링 비용 0).
  touringActive: false, // Touring Test 순회 진행 중(재진입 방지).
};

const DB_LIMIT = 200; // DB 뷰어 페이지 크기(서버 clamp 상한 1000 내).

// floor quad 정점 드래그 상태(캔버스 좌표 변환은 환경 의존 — 여기에서만 사용).
const HANDLE_PX = 8; // 핸들 사각형 반경(px).
// { kind:'floorVertex', index, ... } | { kind:'vpdResize', handle, ... } | { kind:'vpdMove', ... } | null
let dragState = null;

/** 슬롯 ROI·선택 표시만 숨김(데이터 보존). 수집 시작(capCaptureStart) 전용 — 검출/점유/육면체 등 라이브 레이어는 유지한다. */
function clearRoiDisplay() {
  state.roiHidden = true;
  state.selectedSlotId = null;
  drawRoiOverlay();
  renderSelectionInfo();
}

/**
 * [표시 초기화 버튼] 바닥 ROI(파일 기반 state.placeRoi)만 남기고 나머지 오버레이 **데이터를 삭제**한다.
 * Hide(토글 off)가 아니라 실제 삭제 — 재토글로도 복원되지 않는다(다음 검출/수집 때 새로 채워짐).
 * 바닥은 파일 소스(placeRoi)와 #roi-floor 토글을 건드리지 않아 그대로 표시된다.
 * 예외 1건: #roi-db 는 **DB 소스 게이트**라 데이터 삭제로 끌 수 없다(state.parkingSlotsByKey 는
 * renderSlotList 의 최종화 판정 소스라 지우면 회귀) → 체크만 해제해 DB 박스를 화면에서 내린다.
 * 다시 체크하면 loadParkingSlots 로 DB 를 재조회해 VPD/LPD/점유/센터라이징이 되살아난다(마스터 요청 2026-07-23).
 */
function resetOverlayDisplay() {
  state.detectByKey = {};        // 검출 차량/번호판 삭제.
  state.discoverByKey = {};      // discovery(앞면중심 LOOP) LPD quad 삭제 — 없으면 LPD 실행 잔여 박스가 남는다.
  state.occComputeByKey = {};    // 로직 점유(원) 삭제.
  state.occByKey = {};           // 점유율 요약 삭제.
  state.vcuboidByKey = {};       // 차량 육면체 + seg 마스크 삭제.
  $('roi-db').checked = false;   // DB 소스 오버레이 게이트 off — DB 박스도 화면에서 사라진다(데이터는 DB에 보존).
  state.selectedSlotId = null;   // 슬롯 선택 해제.
  state.selectedPlaceIdx = null; // 바닥 선택 하이라이트 해제.
  state.selectedDetect = null;   // [기능2] 검출 박스 선택 해제.
  renderDetectSelection();       // #det-delete 버튼 비활성 동기화.
  drawRoiOverlay();
  renderSelectionInfo();
  renderSlotList();              // 목록(검출 count·점유) 삭제 반영.
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

/** 정밀수집·센터라이징(프레임 폴) 진행 중이면 연결 폴을 건너뛴다(뱃지는 마지막 상태 유지). */
function captureActive() {
  return capFrameTimer !== null || calFrameTimer !== null;
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

function selectedSourceIsReal() {
  return state.sourceDetails[state.source]?.kind === 'hucoms';
}

/** 선택 소스별 PTZ 제어 대상·로그인·상태 조회 UI를 동기화한다. */
function updatePtzControlUi() {
  const real = selectedSourceIsReal();
  state.ptzStateReady = !real;
  $('ptz-control-mode').textContent = real ? '실카메라 · Hucoms PTZF' : '시뮬레이터 · Unity PTZ';
  $('ptz-control-mode').classList.toggle('real', real);
  $('ptz-control-note').textContent = real
    ? 'RTSP 영상과 별개로 Hucoms HTTP PTZF 명령으로 Pan·Tilt·Zoom을 제어합니다.'
    : 'Unity cam.getPTZ로 현재 위치를 읽고 Unity PTZ를 제어합니다.';
  $('btn-ptz-refresh').hidden = false;
  $('login-box').hidden = !real;
  $('ptz-control-status').textContent = real ? '실카메라 현재 PTZ를 불러오거나 로그인해 주세요.' : '';
  updatePtzControlEnabled();
}

function updatePtzControlEnabled() {
  const canMove = !state.ptzBusy && (!selectedSourceIsReal() || state.ptzStateReady);
  document.querySelectorAll('[data-dir], #btn-abs').forEach((button) => { button.disabled = !canMove; });
  $('btn-ptz-refresh').disabled = state.ptzBusy;
}

function setPtzBusy(busy) {
  state.ptzBusy = busy;
  updatePtzControlEnabled();
}

/** 선택한 실카메라·시뮬레이터가 보고하는 현재 PTZ를 UI에 동기화한다. */
async function refreshCurrentPtz({ quiet = false } = {}) {
  const real = selectedSourceIsReal();
  const sourceName = real ? '실카메라' : '시뮬레이터';
  try {
    const p = new URLSearchParams({ source: state.source, cam: state.cam });
    const res = await fetch(api(`/ptz?${p.toString()}`), { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ptz) throw new Error(data.error ?? `HTTP ${res.status}`);
    state.ptz = data.ptz;
    state.ptzStateReady = true;
    updatePtzControlEnabled();
    updatePtzDisplay();
    if (!quiet) $('ptz-control-status').textContent = `${sourceName} 현재 PTZ를 불러왔습니다.`;
    return true;
  } catch (err) {
    // 실카메라는 이전 시뮬레이터 상태로 움직이면 안 되므로 조회 실패 시 이동을 잠근다. 시뮬레이터는 기존 제어를 유지한다.
    state.ptzStateReady = !real;
    updatePtzControlEnabled();
    $('ptz-control-status').textContent = `${sourceName} PTZ 조회 실패: ${err instanceof Error ? err.message : err}`;
    return false;
  }
}

/**
 * 카메라를 움직인 **서버 잡이 끝난 뒤** state.ptz 를 실제 위치로 재동기화한다.
 *
 * 방향 버튼(stepPtz)·절대이동(resolveAbsPtz)은 **state.ptz 를 기준으로 절대 목표를 계산**하는데,
 * 서버 잡(개별/배치 센터라이징·discovery·수집)이 카메라를 움직여도 여기서 갱신하지 않으면
 * state.ptz 가 낡은 채로 남아 **다음 UI 조작이 그전 위치로 되돌아갔다가 한 스텝 움직인다**(마스터 실측 증상).
 *
 * 실카는 응답의 명령값을 믿지 않고 장비 실측을 읽는다 — 명령값은 슬루 중간에 잘리거나(정착 미보장)
 * 광학 한계에서 클램프될 수 있어 실제 위치와 다르다. 시뮬은 응답 ptz 로 충분하다(즉시 반영).
 */
async function syncPtzAfterJob(responsePtz) {
  if (selectedSourceIsReal()) {
    await refreshCurrentPtz({ quiet: true });
    return;
  }
  if (responsePtz && Number.isFinite(responsePtz.pan) && Number.isFinite(responsePtz.tilt) && Number.isFinite(responsePtz.zoom)) {
    state.ptz = { pan: responsePtz.pan, tilt: responsePtz.tilt, zoom: responsePtz.zoom };
    updatePtzDisplay();
    return;
  }
  // 응답이 PTZ 를 주지 않는 잡(배치 센터라이징·discovery·수집)은 서버에 물어본다.
  await refreshCurrentPtz({ quiet: true });
}

/**
 * (수정 19) **이동 기준 PTZ 를 장비에서 직접 읽는다.**
 *
 * 방향 버튼·절대이동의 "빈 칸 유지"는 본질적으로 **상대 명령**("왼쪽으로 2도")인데, 지금까지는 브라우저가 든
 * **절대 좌표 캐시(state.ptz)** 를 기준으로 절대 목표를 계산했다. 캐시가 낡는 경로는 계속 생긴다 —
 * 다른 클라이언트, 장비 자체 컨트롤러, 동기화 실패, **캐시된 옛 스크립트**(라이브에서 실제로 이 형태로 재현됐다:
 * 센터링이 끝난 3512/1184 대신 그 이전 값 4721/1116 이 명령으로 나갔다).
 * → 실카는 **이동 직전에 장비 현재 PTZ 를 읽어** 그것을 기준으로 삼는다. 그러면 캐시가 낡을 수가 없다.
 *
 * 조회 실패 시 **낡은 값으로 조용히 이동하지 않는다** — null 을 돌려 호출측이 이동을 취소하게 한다
 * (조용한 장비 점프가 바로 이번 증상이다).
 *
 * 시뮬은 기존 경로 유지: 명령이 곧 상태이고(응답 즉시 반영) 라이브뷰도 state.ptz override 로 렌더돼
 * 캐시가 낡을 구조적 경로가 없다. 왕복 1회를 추가할 근거가 없다.
 */
async function moveBasePtz() {
  if (!selectedSourceIsReal()) return state.ptz;
  const ok = await refreshCurrentPtz({ quiet: true });
  if (!ok) {
    $('ptz-control-status').textContent = '현재 PTZ 조회 실패 — 낡은 좌표로 이동하지 않습니다. 다시 시도하세요.';
    return null;
  }
  return state.ptz;
}

async function loadSources() {
  // health 응답의 sources/sourceDetails로 소스 셀렉트와 스트림 전송방식을 함께 구성.
  try {
    const res = await fetch(api('/health'), { cache: 'no-store' });
    const data = res.ok ? await res.json() : { sources: [] };
    state.sourceDetails = Object.fromEntries(
      (data.sourceDetails ?? []).map((detail) => [detail.id, detail]),
    );
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
      state.isHucoms = state.sourceDetails[state.source]?.kind === 'hucoms';
      sel.value = state.source;
      updatePtzControlUi();
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
  drawVehicleCuboidOverlay(ctx); // 차량 3D 육면체(det 권위 + seg 마스크 접지선) — 토글 off 면 기존 렌더와 픽셀 동일.
  drawMaskOverlay(ctx); // VPD seg 마스크 반투명 오버레이(#roi-mask, 기본 off) — 지면 가드 이전(수집 중에도 표시).
  updateGroundBadge(); // 어느 지면모델이 표시 중인지 항상 안다(소스 배지).
  updateAnchorBadge(); // 2 DOF 앵커 지표(차량 접지선 vs 슬롯 격자).
  updateVehicleCuboidBadge(); // ⚠️ 화면이 거짓말하지 않게 — "미검증 추정" + 정합 요약을 **항상** 드러낸다.
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
    if (fquad && showFloor && FLOOR_ROI_USE_LLM) { // LLM 모드에서만 슬롯별 floor(파일 모드는 drawFileFloorRoi 가 렌더).
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
  // OccupancyJudge: 1단계 차량 접지밴드 argmax 귀속 → 2단계 비점유 슬롯 번호판 폴백. 후보 조립은 judge 내부.
  const rows = occupancyJudge.judge(floorPolys, detect);
  // 점유영역 사다리꼴: plate 점유분만 모집단(bbox 폴백은 축 소스가 없어 미생성 — 기존 주황 원 유지).
  const region = computeOccupancyRegions(
    rows.filter((o) => o.source === 'plate' && o.plateQuad).map((o) => ({ idx: o.idx, quad: o.plateQuad })),
  );
  if (region.overlapPairs.length && !occRegionOverlapWarned.has(key)) {
    occRegionOverlapWarned.add(key);
    console.warn(`[OccupancyRegion] ${key} 겹침 잔존:`, region.overlapPairs);
  }
  const polyByIdx = new Map(region.regions.map((g) => [g.idx, g.polygon]));
  state.occComputeByKey[key] = {
    spaces: rows.map((o) => ({
      id: o.idx,
      occupied: o.occupied,
      source: o.source,
      center: o.center,
      vehicleRect: o.vehicleRect,
      region: polyByIdx.get(o.idx),
    })),
  };
}

const occRegionOverlapWarned = new Set(); // 점유영역 겹침 잔존 프리셋별 console.warn 1회 가드(렌더 스팸 방지).

/**
 * 점유율 오버레이(R5: LPD 번호판 중심 = 점유 판정 근거, 작은 원으로 표시). 로직 점유(state.occComputeByKey)
 * 가 소스 — mapping 미최종화(수집 중)에도 유효하므로 drawRoiOverlay 의 mapping 가드와 무관하게 별도 호출된다.
 * 점유+중심 보유분만 그림(공차/중심없음 skip). #roi-occupancy 토글만 가드
 * (roiHidden 무관 — 수집 중 라이브 표시 위해. 끄려면 #roi-occupancy 체크 해제).
 */
function drawOccupancyOverlay(ctx) {
  if (!$('roi-occupancy').checked) return;
  const key = currentFrameKey();
  const occ = state.occComputeByKey[key];
  // 'DB 보기'(#roi-db) 체크 → 점유영역 소스를 DB(slot_setup) occupyRange 로 **전환**(라이브 대체, 이중 렌더 회피).
  // VPD/LPD 와 같은 규약 — 폴백이 아니라 소스 전환이라 라이브 점유가 있어도 DB 를 그린다.
  if ($('roi-db').checked) {
    drawDbOccupancy(ctx, state.parkingSlotsByKey?.[key] ?? []);
    return;
  }
  if ((occ?.spaces ?? []).length === 0) return; // 라이브 점유 없음 → 그릴 것 없음.
  // 점유영역 사다리꼴 먼저(면 레이어) → 아래 원/라벨이 그 위에 남는다.
  for (const sp of occ?.spaces ?? []) {
    if (!sp.occupied || !sp.region) continue;
    const pts = toPixelQuad(sp.region, overlay.width, overlay.height); // 클램프 후 3~8각형.
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.px, p.py) : ctx.moveTo(p.px, p.py)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 77, 77, 0.18)'; // 점유=빨강 계열 반투명 채움(중심 원과 동색).
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 77, 77, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  for (const sp of occ?.spaces ?? []) {
    if (!sp.occupied) continue;
    if (sp.source === 'bbox' && sp.vehicleRect) {
      // 점유·번호 미인식(bbox 폴백): 차량 bbox 하단 중심(접지 근사)에 주황 원 + '번호미인식' 배지.
      const r = sp.vehicleRect;
      const bx = (r.x + r.w / 2) * overlay.width;
      const by = (r.y + r.h) * overlay.height;
      ctx.beginPath();
      ctx.arc(bx, by, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#ff9f1a'; // 점유·번호미인식=주황 소원(bbox 근거).
      ctx.fill();
      ctx.fillText(`${sp.id} 번호미인식`, bx + 7, by + 4);
      continue;
    }
    if (!sp.center) continue; // 번호판 점유+중심 보유분만 원 표시(R5, 기존과 동일).
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
  if (FLOOR_ROI_USE_LLM) return; // LLM 모드 → 파일 바닥 숨김(슬롯 floor 는 mapping 루프가 렌더).
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
    // 앞면 중심점(위치표시 원). 라이브 슬라이더 높이(cuboidHeight)로 그려진 육면체와 함께 이동.
    const fc = frontFaceCenter(cub);
    if (fc && Number.isFinite(fc.x) && Number.isFinite(fc.y)) {
      const cxp = fc.x * overlay.width;
      const cyp = fc.y * overlay.height;
      ctx.beginPath();
      ctx.arc(cxp, cyp, 4, 0, Math.PI * 2);
      ctx.fillStyle = selected ? '#ff4d4d' : '#b47cff'; // 육면체 보라 채움.
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#ffffff'; // 흰 테두리로 보라 모서리선과 구분.
      ctx.stroke();
    }
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
 * 바닥 quad·높이는 **서버**가 산출한다(`buildFrameCuboids` — det 권위 + seg 마스크 정합).
 * 뷰어는 기존 projectCuboid 로 **투영만** 한다(뷰어 수학 신규 0줄 — 주차면 육면체와 같은 함수).
 *
 * 데이터 출처 3종(전부 **같은 서버 함수**의 산출물 — "두 개의 진실" 없음):
 *   · 정밀수집 중 → `GET /capture/job-cuboids`(status 인덱스의 round 가 바뀔 때만. 카메라 호출 0)
 *   · 검출 실행   → `POST /capture/detect` 응답 **인라인**(추가 왕복 0)
 *   · 수동 토글   → `GET /capture/vehicle-cuboids`(라이브 촬영 1회 — 잡이 안 돌 때만 쓴다)
 *
 * ⚠️ 그려지는 상자는 **미검증 추정**이다 — `#vcuboid-badge` tooltip 참조. 미정합 차량은 **안 그린다**(빈 자리).
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

// 마스크 인스턴스별 구분색(팔레트 순환). 인접 차량 마스크가 겹쳐도 색으로 분리되게(같은 보라 뭉침 방지).
const MASK_PALETTE = [
  [175, 82, 222], [255, 159, 10], [48, 209, 88], [10, 132, 255],
  [255, 55, 95], [90, 200, 250], [255, 214, 10], [191, 90, 242],
];

/**
 * VPD seg 마스크 반투명 오버레이(#roi-mask, 기본 off). 육면체와 동일 소스(state.vcuboidByKey)에서 masks 를 읽는다.
 * "seg 가 무엇을 봤나" 육안 검증용 — 정합/필터 무관, seg 마스크 유효분 전량 표시. 지면모델 미배선/강등 → masks 부재 → 조용히 skip.
 * 마스크마다 팔레트 색을 순환 적용 — 인접 인스턴스가 겹쳐도 색으로 구분된다.
 */
function drawMaskOverlay(ctx) {
  if (!$('roi-mask').checked) return;
  const data = state.vcuboidByKey[currentFrameKey()]; // 육면체와 동일 소스(masks 동승).
  const masks = data?.masks;
  if (!masks || !masks.length) return; // 지면모델 미배선/강등 → 미표시(사유는 issues 에).
  ctx.save();
  masks.forEach((poly, i) => {
    if (!poly || poly.length < 3) return;
    const pts = toPixelQuad(poly, overlay.width, overlay.height); // N 점 정규화 폴리곤 → 픽셀.
    const [r, g, b] = MASK_PALETTE[i % MASK_PALETTE.length]; // 인스턴스별 순환색.
    ctx.beginPath();
    pts.forEach((p, j) => (j ? ctx.lineTo(p.px, p.py) : ctx.moveTo(p.px, p.py)));
    ctx.closePath();
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.30)`; // 반투명 채움.
    ctx.fill();
    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.95)`; // 같은 색 진한 외곽선 — 인스턴스 경계 또렷.
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });
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

/**
 * ⚠️ **미검증 추정 배지 — 화면이 거짓말하면 안 된다**(마스터 §7 · 정본 §9-1).
 * 육면체를 "측정값"으로 오인하면 안 된다: 배치(X,Y)의 정확도를 재는 **정량 지표가 없고**(자기참조 잔차뿐),
 * L·H 는 **항상 차종 prior** 다. 이 tooltip 이 운영자가 그 사실을 읽는 **유일한 표면**이다(D-2 의 교훈 —
 * 소스 주석만 고치면 화면은 계속 거짓말한다).
 */
const VCUBOID_UNVERIFIED =
  '[⚠️ 미검증 추정 — 측정값이 아니다]\n' +
  '· 위치(X,Y): 앞범퍼 접지선 역투영에서 나온 값이나, **그 정확도를 재는 지표가 없다**(자기참조 잔차만 존재).\n' +
  '            유일한 근거는 육안이며 육안은 오판한 전례가 있다.\n' +
  '· 길이(L)·높이(H): **항상 차종 prior**(세단 4.7m / 1.45m) — 원리적으로 관측 불가.\n' +
  '            SUV·트럭이면 육면체가 틀린다.\n' +
  '· 방향(yaw): 슬롯 폴리곤 prior.\n' +
  '· 폭(W): 관측(점선 = prior 강등분).\n' +
  '· 미정합 차량은 **아무것도 그리지 않는다**(빈 자리로 남는다) — 아래 카운트로 드러난다.';

/** 차량 육면체 배지 — 토글이 켜지면 **항상** "추정(미검증)" + 정합 요약을 보인다. */
function updateVehicleCuboidBadge() {
  const badge = $('vcuboid-badge');
  if (!badge) return;
  const on = $('roi-vcuboid').checked;
  badge.hidden = !on;
  if (!on) return;
  const data = state.vcuboidByKey[currentFrameKey()];
  const s = data?.summary;
  if (!s) {
    badge.textContent = '추정(미검증) · 육면체 —';
    badge.title = VCUBOID_UNVERIFIED;
    badge.classList.add('warn');
    return;
  }
  // 정합 요약을 **항상** 드러낸다 — 미정합 차량이 조용히 사라지지 않게(설계 §6-7).
  badge.textContent =
    `추정(미검증) · 육면체 ${s.cuboidCount} · 정합 ${s.matched}/${s.kept}` +
    (s.unmatchedDet ? ` · 미정합 ${s.unmatchedDet}` : '');
  const detail = [
    `det ${s.detCount}대(권위) → 주차면필터 통과 ${s.kept} · 제외 ${s.filteredOut}`,
    `seg ${s.segCount}대 → 정합 ${s.matched} · 미정합 det ${s.unmatchedDet} · seg-only ${s.segOnly}(가림자로만 사용)`,
    `육면체 ${s.cuboidCount} · 강등 ${s.rejectedCount}${s.segDegraded ? ' · seg 500(검출 0대)' : ''}`,
    ...(data.segError ? [`⚠️ seg 호출 실패: ${data.segError}`] : []),
    ...(data.unmatched ?? []).map((u) => `· 미정합 det#${u.detIdx}: ${u.reason}`),
    ...(data.issues ?? []),
  ];
  badge.title = `${VCUBOID_UNVERIFIED}\n\n[이 프레임]\n${detail.join('\n')}`;
  badge.classList.toggle('warn', s.unmatchedDet > 0 || s.rejectedCount > 0 || !!data.segError);
}

/**
 * 정밀수집 잡의 육면체를 가져온다(GET /capture/job-cuboids — **카메라 촬영 0 · VPD 호출 0**).
 * status 의 경량 인덱스(`cuboid[key].round`)가 **바뀔 때만** 부른다 → 폴링마다 수십 KB 를 끌지 않는다.
 * ⚠️ 라이브 촬영 라우트(/capture/vehicle-cuboids)를 수집 중에 부르면 **잡에게서 카메라를 뺏는다** — 쓰지 않는다.
 */
async function syncJobCuboids(status) {
  const idx = status?.cuboid;
  if (!idx) return;
  for (const [key, meta] of Object.entries(idx)) {
    if (state.vcuboidRound[key] === meta.round) continue; // 같은 라운드 → 재요청 안 함.
    state.vcuboidRound[key] = meta.round;
    try {
      const [cam, preset] = key.split(':');
      const res = await fetch(`/capture/job-cuboids?cam=${cam}&preset=${preset}`, { cache: 'no-store' });
      if (!res.ok) continue;
      state.vcuboidByKey[key] = await res.json();
      drawRoiOverlay();
    } catch {
      /* 네트워크 실패 → 이전 육면체 유지(수집은 계속된다) */
    }
  }
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
 * 현재 프리셋(currentFrameKey) 결과만. roiHidden/mapping 무관(수집 중 라이브).
 * 차량(#roi-vehicle)=차량 박스, 번호판(#roi-plate)=번호판 quad 를 각각 독립 가드(검출 마스터 토글 없음).
 */
function drawDetectOverlay(ctx) {
  const key = currentFrameKey(); // 프리셋 키.
  const d = state.detectByKey[key]; // 프리셋 키로 조회 → 현재 프레임 프리셋 검출(보존분, 이미 dedup).
  // 차량/번호판 토글이 각각 차량 박스·번호판 quad 를 독립 제어(검출 마스터 토글 없음).
  const showVehicle = $('roi-vehicle').checked;
  const showPlate = $('roi-plate').checked;
  const dbOn = $('roi-db').checked; // 'DB 보기' → VPD 소스를 DB(slot_setup) vpd 로 전환(라이브 대체).
  const rows = state.parkingSlotsByKey?.[key] ?? [];
  const sel = state.selectedDetect; // [기능2] 선택 박스 하이라이트·핸들.

  // ── VPD: #roi-db 체크 → DB 저장 vpd(읽기표시), 아니면 라이브(dedup 저장분) ──
  if (showVehicle) {
    if (dbOn) {
      drawDbVpd(ctx, rows); // DB vpd 만(청록). 선택·핸들 없음.
    } else if (d) {
      (d.vehicles ?? []).forEach((v, i) => {
        const { px, py, pw, ph } = toPixel(v.rect, overlay.width, overlay.height);
        const selected = sel?.kind === 'vehicle' && sel.index === i;
        ctx.strokeStyle = selected ? '#ff4d4d' : '#00e5ff'; // 선택=굵은 대비색 / VPD 차량 bbox=청록.
        ctx.lineWidth = selected ? 4 : 2;
        ctx.strokeRect(px, py, pw, ph);
        if (selected) drawHandles(ctx, px, py, pw, ph); // 8핸들(리사이즈 어포던스).
      });
    }
  }

  // ── LPD: #roi-db 체크 → DB 저장 lpd(읽기표시), 아니면 라이브(VPD 와 동일 규약 — 소스 전환) ──
  if (showPlate) {
    if (dbOn) {
      for (const row of rows) { if (row.lpd) drawPlateQuad(ctx, row.lpd, false); } // DB 번호판 OBB quad(노랑). 선택·핸들 없음.
      drawDbCentering(ctx, rows); // 센터라이징 완료 지점(작은 파란 원) — 요건9.
    } else if (d) {
      (d.vehicles ?? []).forEach((v) => { if (v.plate) drawPlateQuad(ctx, v.plate.quad, v.plate.recovered); }); // 차량 부속 번호판.
      (d.plates ?? []).forEach((p, i) => {
        drawPlateQuad(ctx, p.quad, false); // base LPD 전체(R1: LPD 모두).
        if (sel?.kind === 'plate' && sel.index === i) drawQuadHandles(ctx, toPixelQuad(p.quad, overlay.width, overlay.height));
      });
    }
    // discovery(앞면중심 LOOP) 결과 박스 — #roi-plate 게이트 공유, 현재 프리셋 키만(전환 시 자동 은닉).
    const disc = state.discoverByKey?.[key];
    if (disc) for (const q of disc) drawPlateQuad(ctx, q, false);
  }
}

/**
 * DB(slot_setup) 소스 VPD 오버레이 — #roi-db 체크 시 라이브 대신 표시(GET /capture/slots → parkingSlotsByKey 행배열).
 * 차량 bbox(vpd)=청록 rect. 읽기표시 전용(선택 하이라이트·핸들 없음). null 필드는 skip.
 */
function drawDbVpd(ctx, rows) {
  for (const row of rows) {
    if (!row.vpd) continue;
    const { px, py, pw, ph } = toPixel(row.vpd, overlay.width, overlay.height);
    ctx.strokeStyle = '#00e5ff'; // VPD 차량 bbox=청록(라이브와 동색).
    ctx.lineWidth = 2;
    ctx.strokeRect(px, py, pw, ph);
  }
}

/**
 * DB(slot_setup) 소스 센터라이징 위치 오버레이(W7) — #roi-db 체크 시 LPD quad 직후에 그린다.
 * 표시점 = `slot_setup.lpd` OBB 중심. 센터링 산출물은 PTZ(pan/tilt/zoom)라 프리셋 프레임 좌표가 아니고,
 * 프리셋 프레임에서 "그 슬롯이 센터라이징된 지점"의 유일한 기존 좌표가 센터링 표적이었던 lpd 이기 때문이다
 * (PTZ 역투영은 게인 역함수를 새로 써야 해서 기존 함수만 쓰기 규약 위반).
 * centered 가 거짓이거나 lpd 가 없으면 스킵(위장 표시 금지). 읽기표시 전용.
 */
function drawDbCentering(ctx, rows) {
  for (const row of rows) {
    if (!row.centered || !row.lpd) continue;
    const pts = toPixelQuad(row.lpd, overlay.width, overlay.height);
    const xs = pts.map((p) => p.px);
    const ys = pts.map((p) => p.py);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2; // quad bounding rect 중심.
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.strokeStyle = '#0a84ff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

/**
 * DB(slot_setup) 소스 점유영역 오버레이 — #roi-db 체크 시 라이브 점유 대신 표시.
 * occupyRange(정규화 다각형)를 라이브와 동색(빨강 반투명)으로 채운다. null 필드는 skip.
 */
function drawDbOccupancy(ctx, rows) {
  for (const row of rows) {
    if (!row.occupyRange) continue;
    const pts = toPixelQuad(row.occupyRange, overlay.width, overlay.height);
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.px, p.py) : ctx.moveTo(p.px, p.py)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 77, 77, 0.18)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 77, 77, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

/**
 * 현재 프리셋 1회 라이브 검출(POST /capture/detect). 결과를 state.detectByKey[key] 에 보관 후 재렌더.
 * R2 반복(프리셋 순회·10회)은 리더/프론트 재호출 소유 — 이 액션은 현재 프리셋 1회만.
 */
async function runLiveDetect(vpdEnabled = false, ptz) {
  const cam = state.capFrameKey2?.cam ?? state.cam;
  const preset = state.capFrameKey2?.preset ?? state.preset;
  // 주차면 필터 모드(ON=주차면 위 차량만). 정밀수집 체크박스와 공용 — 진행 중 run 은 시작 시 모드를 유지한다.
  // vpdEnabled: '검출 실행'=false(LPD 전용) · 'VPD 검출(테스트)'=true(차량+육면체). 자동 경로 VPD 정지(제품 정책).
  const body = { cam, preset, vpdOnParkingOnly: $('cap-vpd-onplace').checked, vpdEnabled };
  // ptz 제공(lpd-live) 시에만 오버라이드 전송 — 미제공이면 기존 경로(프리셋 PTZ) 그대로. state.ptz 값이 문자열일 수 있어 Number() 방어.
  if (ptz) body.ptz = { pan: Number(ptz.pan), tilt: Number(ptz.tilt), zoom: Number(ptz.zoom) };
  const res = await fetch('/capture/detect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  // ★ 이 라우트는 카메라를 **실제로 움직인다**: detectPipeline 이 미귀속 차량마다 확대 PTZ 로 requestImage 하고
  //   루프 종료 후 원위치로 복귀하지 않는다 → state.ptz 가 낡는다. 실패 경로에서도 이미 움직였을 수 있으므로
  //   **반환 전에 반드시** 동기화한다(성공 분기에만 걸면 실패 시 같은 버그가 남는다).
  if (!res.ok) {
    await syncPtzAfterJob(null);
    return; // 실패는 조용히 미표시(기존 검출 결과 유지).
  }
  const detect = await res.json();
  await syncPtzAfterJob(null);
  // 수집 시점 dedup: VPD 겹침 박스를 차량당 1개(마지막 검지)로 정제해 저장 — 렌더·선택·목록·점유 소비처를 자동 정합.
  state.detectByKey[presetKey(cam, preset)] = { ...detect, vehicles: dedupeVehicles(detect.vehicles ?? []) }; // 프리셋 키별 보존(덮어쓰기 아님).
  // 차량 육면체는 **검출 응답에 인라인**으로 온다(서버가 base 프레임에서 산출 — 추가 왕복 0).
  // 육면체 기능 off/강등이면 키가 없다 → 이전 값을 지우지 않는다(조용한 소실 방지).
  if (detect.cuboids) state.vcuboidByKey[presetKey(cam, preset)] = detect.cuboids;
  const s = detect.summary;
  if (s) {
    // VPD off(제품 정책)면 '차량 0/0' 오해를 막고 'VPD 미실행(번호판 전용)'으로 정직 표기.
    const vpdPart = s.vpdEnabled === false ? 'VPD 미실행' : `검출 ${s.vpdCount - s.filteredOut}/${s.vpdCount}대`;
    $('cap-msg').textContent =
      `${vpdPart} · 번호판 ${s.lpdCount - s.lpdFilteredOut}/${s.lpdCount} · 주차면필터 ${s.onPlaceOnly ? 'ON' : 'OFF'}` +
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
  const fileMode = !FLOOR_ROI_USE_LLM && (state.roiHidden || !state.mapping);
  if (finalized || fileMode) {
    updateLogicOccupancy(); // 현재 프리셋 점유 뱃지 최신화(오버레이 원 소스 occComputeByKey 유지).
    const rows = buildFlatSlotRows({
      placeRoi: state.placeRoi,
      detectByKey: state.detectByKey,
      parkingSlotsByKey: state.parkingSlotsByKey,
      judge: occupancyJudge, // 목록 뱃지를 오버레이와 같은 판정기로 정합(주입 — core.js→occupancy.js 순환 회피).
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
  if (!state.selectedSlotId || !state.mapping || !$('roi-floor').checked || !FLOOR_ROI_USE_LLM) return null;
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
    // 시뮬레이터는 현재 PTZ를 프레임 렌더에 사용한다. 실카메라는 단순 폴백 캡처가 이동 명령이 되지 않게 preset 모드로 읽기만 한다.
    const realStream = state.sourceDetails[state.source]?.streamTransport === 'rtsp-ffmpeg';
    const p = new URLSearchParams({
      cam: state.cam,
      preset: state.preset,
      mode: realStream ? 'preset' : 'manual',
      t: seq,
    });
    if (state.source) p.set('source', state.source);
    if (!realStream) {
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
  // 화면 표시는 읽기 쉽게 소수점 이하 최대 7자리로만 제한한다. 내부 제어값은 원본 정밀도를 유지한다.
  const formatPtz = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '-';
    const rounded = Number(numeric.toFixed(7));
    return String(Object.is(rounded, -0) ? 0 : rounded);
  };
  $('ptz-pan').textContent = formatPtz(state.ptz.pan);
  $('ptz-tilt').textContent = formatPtz(state.ptz.tilt);
  $('ptz-zoom').textContent = formatPtz(state.ptz.zoom);
}

// --- 라이브 MJPEG 스트림 -------------------------------------------------
// 라이브 뷰를 <img src="/viewer/api/stream"> 로 연결한다.
// 백엔드는 시뮬레이터 HTTP MJPEG 또는 실카메라 RTSP→FFmpeg MJPEG를 같은 경로로 제공하고, 오류 시 폴링으로 폴백한다.
let liveMode = 'off'; // 'off' | 'stream'(MJPEG) | 'poll'(폴백 폴링)

/** 현재 cam/preset/source로 스트림 URL 조립. 시뮬레이터만 렌더용 PTZ override를 전달한다. */
function streamUrl() {
  const p = new URLSearchParams({ cam: state.cam, preset: state.preset });
  if (state.source) p.set('source', state.source);
  // 실카메라는 RTSP 재생 자체가 PTZ 이동을 일으키면 안 된다. 이동은 /move와 프리셋 동작에서만 수행한다.
  if (state.sourceDetails[state.source]?.streamTransport !== 'rtsp-ffmpeg') {
    p.set('pan', state.ptz.pan);
    p.set('tilt', state.ptz.tilt);
    p.set('zoom', state.ptz.zoom);
  }
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
  if (state.ptzBusy || (selectedSourceIsReal() && !state.ptzStateReady)) {
    if (selectedSourceIsReal()) $('ptz-control-status').textContent = '실카메라 현재 PTZ를 먼저 불러오거나 로그인해 주세요.';
    return false;
  }
  setPtzBusy(true);
  try {
    const res = await fetch(api('/move'), {
      method: 'POST',
      headers: tokenHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ source: state.source || undefined, cam: state.cam, ...ptz }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      $('ptz-control-status').textContent = `PTZ 이동 실패: ${data.error ?? res.status}`;
      return false;
    }
    state.ptz = ptz;
    updatePtzDisplay();
    if (selectedSourceIsReal()) {
      $('ptz-control-status').textContent = '실카메라 PTZ 이동 완료. 현재 위치를 확인합니다…';
      await refreshCurrentPtz({ quiet: true });
    } else {
      $('ptz-control-status').textContent = '';
    }
    if (moveRenderDirective(liveMode) === 'stream-reconnect') {
      // 시뮬레이터는 PTZ override로 재렌더하고, 실카메라는 물리 이동 후 RTSP를 다시 연결한다.
      frame.src = streamUrl();
    } else {
      await loop.tick(); // poll 폴백 지속갱신 / off 1회 스냅샷 override.
    }
    return true;
  } catch (err) {
    $('ptz-control-status').textContent = `PTZ 이동 실패: ${err instanceof Error ? err.message : err}`;
    return false;
  } finally {
    setPtzBusy(false);
  }
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

// --- Touring Test (독립 순회) -------------------------------------------
// setup_result.json(읽기전용)을 카메라→프리셋→슬롯 순으로 순회하며 각 위치로 물리 이동(각 1초).
// DB·discover/detect·오버레이 데이터는 읽지도 쓰지도 않는다. move()/gotoPreset()/UI동기화/모달만 사용.
async function runTouringTest() {
  if (state.touringActive) return; // 재진입 방지.
  const btn = $('cap-touring');
  const origLabel = btn?.textContent;

  // 1) 로딩 — 루트 경로(/capture/*), api() 미사용, no-store.
  let data;
  try {
    const res = await fetch('/capture/saves/setup_result', { cache: 'no-store' });
    if (!res.ok) {
      $('cap-msg').textContent = `Touring: setup_result 로딩 실패(${res.status}) — 정밀수집 결과가 없습니다.`;
      return;
    }
    data = await res.json();
  } catch (err) {
    $('cap-msg').textContent = `Touring: 로딩 오류 — ${err instanceof Error ? err.message : err}`;
    return;
  }

  // 2) 스텝 산출.
  const { steps, skipped } = buildTouringPlan(data);
  const presetCount = steps.filter((s) => s.kind === 'preset').length;
  const slotCount = steps.filter((s) => s.kind === 'slot').length;
  if (!steps.length) {
    $('cap-msg').textContent = 'Touring: 순회할 슬롯/프리셋이 없습니다(빈 setup_result).';
    return;
  }

  // 3) 순회.
  state.touringActive = true;
  if (btn) btn.disabled = true;
  let done = 0;
  try {
    for (const step of steps) {
      done += 1;
      if (btn) btn.textContent = `순회 중… (${done}/${steps.length})`;
      if (step.kind === 'preset') {
        syncTouringPreset(step.camId, step.presetId); // state.cam/preset + UI 동기화.
        const home = findPresetPtz(state.cameras, step.camId, step.presetId);
        if (home) await move(home);
        else await gotoPreset(); // PTZ 미제공(일부 실카메라) → snapshot 폴백으로 프리셋 이동(스킵 안 함).
      } else {
        await move(step.ptz);
      }
      await new Promise((r) => setTimeout(r, 1000)); // 각 위치 1초 대기.
    }
  } finally {
    state.touringActive = false;
    if (btn) { btn.disabled = false; btn.textContent = origLabel; }
  }

  // 4) 완료 모달.
  $('touring-done-body').textContent =
    `프리셋 ${presetCount}곳, 주차면 ${slotCount}곳 순회 완료.` +
    (skipped ? ` (센터링 없는 ${skipped}개 슬롯 건너뜀)` : '');
  $('touring-done-modal').hidden = false;
}

/** cam/preset 전환 UI 동기화(수동 sel-cam/sel-preset 핸들러와 동일 절차, gotoPreset 물리이동은 호출측이 담당). */
function syncTouringPreset(camId, presetId) {
  state.cam = camId;
  state.preset = presetId;
  state.selectedSlotId = null;
  state.selectedDetect = null;
  renderDetectSelection();
  renderCamSelect();      // → renderPresetSelect → syncPtzFromPreset + renderSlotList (sel-cam/sel-preset value 세팅)
  drawRoiOverlay();
  renderSelectionInfo();
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
  // 정밀수집 run 중에는 진행바를 renderPreciseProgress 가 소유한다(수집 status 는 idle 0/0 이라 덮으면 0 으로 튄다).
  if (!preciseActive) {
    const { percent, label } = captureProgress(status ?? {});
    $('cap-bar').value = percent;
    $('cap-label').textContent = label;
  }
  renderElapsed();
  const adv = mapAdvisory(status ?? {});
  $('cap-advisory').innerHTML = '';
  for (const line of adv) {
    const div = document.createElement('div');
    div.className = 'adv-line';
    div.textContent = line;
    $('cap-advisory').appendChild(div);
  }
  // 이번 run 의 VPD 게이트(제품 정책 — 자동 경로 VPD 정지). 강등 위장 금지: 서버 status 가 진실.
  if (status?.vpdEnabled === false) {
    const div = document.createElement('div');
    div.className = 'adv-line';
    div.textContent = 'VPD 미실행(번호판 전용) — 차량 검출은 [VPD 검출(테스트)] 버튼으로만';
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
  $('cap-capture-start').disabled = ui.startDisabled;
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
  stopCalFramePolling(); // 상호배타(불변식3): 센터라이징 폴 잔여 타이머 제거.
  stopDiscFramePolling(); // 상호배타(불변식3): discovery 프레임폴 잔여 타이머 제거.
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
// 원버튼 셋업 파이프라인 전이 추적(finalizing→calibrating/done 전환 감지 · calibrate 폴 재기동 게이트).
let prevPipelineStage = 'idle';
/**
 * 이번 run 이 정밀수집('시작')인가 — 진행바(cap-bar) 소유권 플래그.
 * 정밀수집은 CaptureJob 을 발화하지 않아 `/capture/status` 가 idle 0/0 이다. 그대로 두면 진행바가 0 에 머무르므로
 * 탐색/센터라이징 잡의 실적(기존 `/discover/status`·`/calibrate/status` 폴)을 진행바에 **미러링**한다.
 * 켜져 있는 동안 renderCaptureStatus 는 진행바를 건드리지 않는다(두 소스가 서로 덮어쓰는 깜빡임 방지).
 *
 * **종료(done/failed) 시 반드시 반납한다.** 쥔 채로 두면 이후 수동 'LPD 실행'·'센터라이징' 버튼의 진행이
 * 상단 진행바로 새어 나온다(실측 결함 — 마스터 지적). 반납해도 최종 실적은 남는다: 완료를 감지한 그 폴에서
 * renderCaptureStatus 는 이미 소유권 상태로 지나갔고, 그 뒤 capPoll 은 재예약되지 않기 때문이다.
 */
let preciseActive = false;

/**
 * 정밀수집 진행바 미러(단계별 0~100%). 신규 집계 없음 — 잡 상태의 done/total 을 그대로 쓴다.
 * `found`(탐색 발견수)가 있으면 라벨에 함께 싣는다 — 하위 패널 진행바를 비우는 대신 그 정보를 여기로 올린다.
 */
function renderPreciseProgress(phase, status) {
  const done = Number(status?.done ?? 0);
  const total = Number(status?.total ?? 0);
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  $('cap-bar').value = percent;
  const found = status?.found == null ? '' : ` · 발견 ${status.found}`;
  $('cap-label').textContent = `${phase} ${done}/${total} (${percent}%)${found}`;
}

/**
 * 정밀수집 중 하위 패널(LPD 검지 / 센터라이징) 진행바를 중립화한다.
 * 같은 잡을 두 진행바가 동시에 그리면 어느 쪽을 봐야 하는지 모호하다 — 정밀수집의 정본은 상단 진행바 하나다.
 * 값을 지우되 **어디를 보라는지** 라벨로 남긴다(멈춘 것처럼 보이는 오독 방지).
 */
function neutralizeSubProgress(barId, labelId) {
  $(barId).value = 0;
  $(labelId).textContent = '정밀수집 진행 중 — 위 진행바 참조';
}
// floor ROI LLM 경고 메시지박스 런당 1회 가드(매 폴링 반복 팝업 방지).
let floorLlmWarnShown = false;
// 점유율 LLM 경고 메시지박스 런당 1회 가드(floor 대칭).
let occLlmWarnShown = false;
// 점유율 fetch 과호출 회피: status.round 변화 게이트(직전 라운드).
let prevCapRound = null;

/** 점유율 조회 → state.occByKey 갱신 → 오버레이 재그림. run_id 폐기(설계서 §3) — 현재 잡 인메모리 축소 occupancy. LLM off 시 []. */
async function fetchOccupancy() {
  try {
    const res = await fetch('/capture/occupancy', { cache: 'no-store' });
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

/**
 * 정밀수집 완료 팝업(요건8). 수집 결과 모달(cap-result-modal)의 제목·본문만 갈아끼워 재사용한다 —
 * 신규 모달 없음. 본문은 이미 산출된 완료 메시지 + 커버리지(있을 때)이며 새 집계를 하지 않는다.
 * '센터라이징 분리' run 은 제목으로 먼저 구분해 사용자가 다음 할 일(센터라이징)을 놓치지 않게 한다.
 */
function showPreciseResult(pl, msg) {
  const separated = typeof pl?.note === 'string' && pl.note.startsWith('센터라이징 분리');
  $('cap-result-title').textContent = separated ? '탐색·점유영역 완료 — 센터라이징 미실행' : '정밀수집 완료';
  const body = $('cap-result-body');
  body.innerHTML = '';
  const c = pl?.coverage;
  const lines = [msg];
  if (c) lines.push(`센터라이징 대상 ${c.targets} / 전체 ${c.totalSlots} · 미대상 ${c.uncovered}`);
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
  void syncJobCuboids(status); // 잡 육면체: round 가 바뀐 프리셋만 전문을 가져온다(카메라·VPD 호출 0).
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
      fetchOccupancy();
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
    await fetchOccupancy();
    showCaptureResult(status);
    await syncPtzAfterJob(null); // 수집이 프리셋을 돌며 카메라를 움직였다 → UI 기준 PTZ 재동기화.
    // 얼어붙은 마지막 프레임을 라이브 배경으로 되돌린다. 검출/점유/육면체 데이터는 보존 —
    // 종료 후에도 VPD/LPD/점유영역 박스가 오버레이 레이어로 라이브 배경 위에 남는다.
    startLive();                                       // 라이브 MJPEG 재연결(얼어붙은 마지막 프레임 대체).
  }
  prevCapState = st;
  // 원버튼 셋업 파이프라인 병행 조회(무장 시에만 렌더). capture 가 done 이어도 체인이 진행 중이면 폴을 유지한다.
  const pl = await pollPipeline();
  const chainBusy = pl && pl.armed && (pl.stage === 'capturing' || pl.stage === 'finalizing' || pl.stage === 'discovering' || pl.stage === 'calibrating');
  const plan = pollPlan(st);
  if (capPollTimer) {
    clearTimeout(capPollTimer);
    capPollTimer = null;
  }
  if (plan.poll || chainBusy) capPollTimer = setTimeout(capPoll, plan.intervalMs);
}

/**
 * 원버튼 셋업 파이프라인 상태 조회·렌더(GET /capture/pipeline). 비무장/미지원 시 cap-msg 무간섭(수동 흐름 회귀 0).
 * finalize 완료(finalizing→calibrating|done) 전환에서 주차면 오버레이를 자동 반영(capFinalize 성공 분기와 동일),
 * 백엔드가 센터라이징을 발화(→calibrating)하면 프론트 calibrate 폴을 재기동한다(프레임 추종·결과 요약은 기존 calPoll 경로).
 */
async function pollPipeline() {
  let pl = null;
  try {
    const res = await fetch('/capture/pipeline', { cache: 'no-store' });
    pl = res.ok ? await res.json() : null;
  } catch {
    pl = null;
  }
  if (!pl || !pl.armed || pl.stage === 'idle') {
    prevPipelineStage = pl?.stage ?? 'idle';
    return pl;
  }
  const stage = pl.stage;
  // finalize 완료(→ calibrating|done): 방금 새로 써진 slot_setup 을 주차면 오버레이에 반영.
  if (prevPipelineStage === 'finalizing' && (stage === 'calibrating' || stage === 'done')) {
    await loadParkingSlots();
    await loadMapping();
    drawRoiOverlay();
    renderSlotList();
  }
  // 백엔드가 센터라이징을 발화 → calibrate 폴 재기동(idle 에서 멈춰 있던 calPoll 을 running 추종 상태로).
  if (prevPipelineStage !== 'calibrating' && stage === 'calibrating') calPoll();
  // 탐색 단계도 카메라를 돌린다(SetupPipeline 의 전 프리셋 앵커 loop LPD) → discovery 폴도 같이 재기동해야
  // discPoll 의 running→done 전이가 성립하고 그 안의 PTZ 동기화가 발화한다.
  if (prevPipelineStage !== 'discovering' && stage === 'discovering') discPoll();
  // 체인이 discovering 에서 곧바로 끝나는 두 종결(탐색 실패 / LPD 타깃 0 → 센터라이징 스킵)은
  // calibrating 을 거치지 않아 위 폴 전이만으로는 동기화를 보장할 수 없다 → 체인 종단에서 한 번 더 맞춘다.
  if (prevPipelineStage !== stage && (stage === 'done' || stage === 'failed')) await syncPtzAfterJob(null);
  // 상태 메시지(무장 중 cap-msg 는 파이프라인이 소유).
  if (stage === 'finalizing') {
    $('cap-msg').textContent = '자동 최종화 중…';
  } else if (stage === 'discovering') {
    $('cap-msg').textContent = '번호판 탐색 중…';
  } else if (stage === 'calibrating') {
    $('cap-msg').textContent = '자동 센터라이징 중…';
  } else if (stage === 'failed') {
    const f = pl.failure || {};
    preciseActive = false; // 소유권 반납(중단 시점 값 유지 — 100% 로 위장하지 않는다).
    $('cap-msg').textContent = `${pl.precise ? '정밀수집' : '자동 체인'} 중단(${f.stage ?? '?'}): ${f.reason ?? ''}`;
  } else if (stage === 'done') {
    preciseActive = false; // 소유권 반납 — 이후 수동 버튼 진행이 상단 진행바로 새지 않게.
    if (pl.precise) {
      const msg = await preciseDoneMessage(pl);
      $('cap-msg').textContent = msg;
      // 완료 팝업 — 수집 경로의 결과 모달(cap-result-modal)을 그대로 재사용한다. 진행바·메시지만으로는
      // 다른 패널을 보고 있던 사용자가 종료를 놓친다(수집은 이미 showCaptureResult 로 팝업을 띄운다).
      if (prevPipelineStage !== 'done') {
        showPreciseResult(pl, msg);
        // 정밀수집 종료 → DB 조립 매핑을 분석 탭이 즉시 반영(그 탭을 보고 있을 때만 1회).
        if (!$('analyze-view').hidden) await renderAnalysis();
      }
    } else {
      const c = pl.coverage;
      let msg = c ? `자동 셋업 완료 — 센터링 대상 ${c.targets} / 전체 ${c.totalSlots} · 미대상 ${c.uncovered}` : '자동 셋업 완료';
      if (pl.note) msg += ` · ${pl.note}`;
      $('cap-msg').textContent = msg;
    }
  }
  prevPipelineStage = stage;
  return pl;
}

/**
 * ★ 정밀수집 '시작'(W5) — 반복 관측 수집을 발화하지 않는다. 백엔드 `POST /capture/start-precise` 1회 호출로
 * **LPD 탐색(앞면중심 앵커 loop) → 점유영역 → 센터라이징 → setup_result.json** 이 규정 대기시간과 함께 진행된다.
 * 대기·단계전이는 전부 백엔드 소유(브라우저 탭 백그라운드화·폴링 지터로 카메라 동작 간격이 흔들리면 안 된다) —
 * 프론트는 기존 폴러(capPoll→pollPipeline / discPoll / calPoll)만 기동한다.
 * 명령 대상 소스는 뷰어가 보고 있는 소스(state.source) — /calibrate/point 와 같은 규약.
 */
async function startPrecise() {
  $('cap-msg').textContent = '';
  prevPipelineStage = 'idle'; // 새 런 시작 → 파이프라인 전이 추적 재설정.
  const res = await fetch('/capture/start-precise', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source: state.source || undefined,
      // 센터라이징 분리(체크 시) — 탐색·점유영역까지만 돌고 센터라이징 전에 멈춘다.
      skipCentering: $('cap-skip-centering').checked || undefined,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    $('cap-msg').textContent = `정밀수집 시작 실패: ${data.error ?? res.status}`;
    return;
  }
  if (data.stage === 'failed') {
    // preflight 정직 실패(앞면중심 0 등) — 조용히 넘어가지 않는다.
    $('cap-msg').textContent = `정밀수집 시작 불가(${data.failure?.stage ?? '?'}): ${data.failure?.reason ?? ''}`;
    return;
  }
  preciseActive = true; // 이제 진행바는 탐색/센터라이징 잡 실적을 미러링한다(수집 status 무시).
  $('cap-bar').value = 0;
  $('cap-label').textContent = '번호판 탐색 준비…';
  $('cap-msg').textContent = '번호판 탐색 중…';
  capPoll();
  discPoll();
}

/**
 * 정밀수집 완료 메시지(요건8). 잡 두 개의 기존 상태 라우트에서 실적을 그대로 읽어 붙인다(신규 집계 없음).
 * 조회 실패는 카운트 생략으로 강등한다(완료 사실 자체는 파이프라인 stage 가 정본).
 */
async function preciseDoneMessage(pl) {
  const get = async (url) => {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  };
  const [disc, cal] = await Promise.all([get('/discover/status'), get('/calibrate/status')]);
  const d = disc ? `탐색 ${disc.found ?? 0}/${disc.total ?? 0}` : '탐색 -';
  // '센터라이징 분리' run 은 calibrator 를 발화하지 않았으므로 센터링 실적·setup_result 를 주장하지 않는다
  // (직전 run 의 /calibrate/status 잔여를 이번 실적으로 오독하면 위장 성공이 된다).
  const separated = typeof pl.note === 'string' && pl.note.startsWith('센터라이징 분리');
  if (separated) {
    const t = pl.coverage?.targets ?? 0;
    return (
      `탐색·점유영역 완료 — ${d} · 여기서 종료되었습니다(센터라이징 미실행). ` +
      `'센터라이징 분리' 체크를 해제하고 '시작'을 다시 눌러 센터라이징을 진행하세요 — 대상 ${t}슬롯`
    );
  }
  const c = cal ? `센터링 ${cal.done ?? 0}/${cal.total ?? 0}` : '센터링 -';
  let msg = `정밀수집 완료 — ${d} · ${c} · setup_result.json 저장`;
  if (pl.note) msg += ` · ${pl.note}`;
  return msg;
}

async function capCaptureStart() {
  preciseActive = false; // 진행바 소유권을 수집(CaptureJob) 실적으로 되돌린다.
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
    floorRoiUseLlm: FLOOR_ROI_USE_LLM, // 바닥 ROI 소스 모드(파일 고정, 요건12). 백엔드 floorReviewer 게이트.
    vpdOnParkingOnly: $('cap-vpd-onplace').checked, // VPD 검출 모드(ON=주차면 위 차량만, OFF=모든 차량).
    vpdEnabled: false, // 제품 정책: 정밀수집 자동 경로 VPD(차량) 정지 — 체크박스 없이 고정 OFF. VPD 는 테스트 버튼만.
    // autoChain 미전송(요건12: '완료 후 자동 최종화' UI 제거) → 백엔드 기본 false. 스키마·연쇄 코드는 보존.
  };
  prevPipelineStage = 'idle'; // 새 런 시작 → 파이프라인 전이 추적 재설정.
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

/** 최종화 후 slot_setup 조회 → state.parkingSlotsByKey(cam:preset → 행배열) 구성(§06 H7). 실패 시 조용히 미표시. */
async function loadParkingSlots() {
  try {
    // run_id 폐기(설계서 §3) — slot_setup 정본 직접 조회. 응답은 presetKey 파생 포함(SlotSetupView).
    const res = await fetch('/capture/slots', { cache: 'no-store' });
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

const HOME_CAM = 1;    // 기준 뷰 카메라(1-based) — 최종화 마감 시 복귀 대상.
const HOME_PRESET = 1; // 기준 뷰 프리셋(1-based).

/**
 * 기준 뷰(1번 카메라·1번 프리셋)로 드롭다운 선택 전환 + 카메라 물리 이동(마스터 요청 2026-07-23).
 * 수동 드롭다운 전환(#sel-cam/#sel-preset change)과 동일한 절차를 그대로 재사용한다 — 선택 해제·재렌더·gotoPreset·스트림 재연결.
 * /cameras 목록에 1:1 이 없으면(카메라 구성이 다른 현장) 조용히 skip 하고 false 반환 — 없는 프리셋으로 이동을 위장하지 않는다.
 */
async function gotoHomePreset() {
  const cam = state.cameras.find((c) => c.camIdx === HOME_CAM);
  if (!cam || !(cam.presets ?? []).some((p) => p.presetIdx === HOME_PRESET)) return false;
  state.cam = HOME_CAM;
  state.preset = HOME_PRESET;
  state.selectedSlotId = null;  // 프리셋 컨텍스트 전환 → 선택 해제(수동 전환과 동일).
  state.selectedDetect = null;
  renderDetectSelection();
  renderCamSelect();            // 드롭다운 값 동기화(프리셋 셀렉트·PTZ 표시·목록 갱신 동반).
  renderSelectionInfo();
  await gotoPreset();           // 프리셋 PTZ 로 물리 이동(/move → /req_move).
  reconnectLiveIfActive();      // 라이브 중이면 새 cam:preset 으로 스트림 재연결.
  return true;
}

/**
 * ★ 최종화 = **표시 전용**(요건9). `POST /capture/finalize` 를 부르지 않는다 —
 *   Finalizer 의 `replaceSlotSetup` 은 모든 슬롯의 pan/tilt/zoom 을 null, centered 를 0 으로 되돌리므로
 *   요구 순서(센터라이징 완료 → 최종화 → 표시)대로 누르면 **방금 만든 센터라이징이 즉시 파괴된다**.
 *   따라서 DB(`GET /capture/slots`)를 소스로 LPD·점유영역·센터라이징 위치를 화면에 그리기만 한다.
 *   (`/capture/finalize` 라우트·`Finalizer` 는 수집 경로·테스트용으로 그대로 보존 — 이 버튼에서만 도달 불가.)
 */
async function capFinalize() {
  $('roi-db').checked = true; // DB 소스 오버레이 ON — LPD/점유/센터링 전부 이 게이트를 통과한다.
  state.roiHidden = false; // 결과를 다시 표시.
  await gotoHomePreset(); // 마스터 요청 2026-07-23: 마감 후 기준 뷰(1번 카메라·1번 프리셋)로 물리 복귀.
  await loadParkingSlots(); // slot_setup 정본 조회 → state.parkingSlotsByKey.
  await loadMapping(); // 정밀 결과를 검수 탭에 반영.
  drawRoiOverlay();
  renderSlotList();
  const rows = Object.values(state.parkingSlotsByKey ?? {}).flat();
  const lpd = rows.filter((r) => r.lpd).length;
  const occ = rows.filter((r) => r.occupyRange).length;
  const cen = rows.filter((r) => r.centered && r.lpd).length;
  $('cap-msg').textContent = `표시: 번호판 ${lpd} · 점유영역 ${occ} · 센터라이징 ${cen} (전체 ${rows.length})`;
}

// 검출·센터링 초기화(수동): slot_setup 의 vpd/lpd/occupy/ptz/centered/img1 만 비움(바닥 ROI/슬롯 보존).
async function resetSlotSetupDb() {
  if (!confirm('DB의 검출(VPD/LPD)·점유영역·센터라이징(PTZ)을 모두 초기화합니다. 되돌릴 수 없습니다. 진행할까요?')) return;
  const res = await fetch('/capture/slots/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { $('cap-msg').textContent = `초기화 실패: ${data.error ?? res.status}`; return; }
  resetOverlayDisplay();           // 클라 라이브 오버레이(detect/occ/vcuboid) 정리.
  await loadParkingSlots();        // DB 재조회 → null 반영(parkingSlotsByKey 갱신).
  drawRoiOverlay();
  renderSlotList();
  $('cap-msg').textContent = `초기화 완료: ${data.cleared ?? 0}개 슬롯`;
}

// ROI 파일 로딩: PtzCamRoi.json(바닥 ROI 정본) → DB slot_setup 전량 재구성(검출·점유·센터링은 초기값).
async function loadRoiToDb() {
  if (!confirm('PtzCamRoi.json 으로 DB slot_setup 을 전량 재구성합니다. 기존 검출(VPD/LPD)·점유영역·센터라이징(PTZ)은 모두 사라집니다. 되돌릴 수 없습니다. 진행할까요?')) return;
  const res = await fetch('/capture/slots/load-roi', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) { $('cap-msg').textContent = `ROI 로딩 실패: ${data.error ?? res.status}`; return; }
  resetOverlayDisplay();           // 클라 라이브 오버레이(detect/occ/vcuboid) 정리.
  // 카메라·프리셋 드롭다운 재수신 — 서버가 camerapos.json 을 ROI 정본으로 갱신했으므로 목록·PTZ 가 바뀐다.
  // 이걸 빼면 화면은 옛 PTZ 로 이동하는데 오버레이는 새 ROI 기준이라 육면체가 어긋난 위치에 그려진다.
  await loadCameras();
  state.roiHidden = false;         // 로딩 결과를 즉시 표시(이전 수집·초기화로 숨김 상태였을 수 있음).
  state.placeRoiLoaded = false;    // 1회 로드 가드 해제 — 파일 ROI 정본이 바뀌었으므로 반드시 재로딩.
  state.placeRoiDirty = false;     // 이전 세션의 미저장 편집 버퍼는 폐기(파일이 새 정본).
  await loadPlaceRoi();            // 파일 소스 재조회 → state.placeRoi(주차면 목록·오버레이·검출 필터 기준) 갱신.
  state.groundLoaded = false;      // 1회 로드 가드 해제 — ROI 정본이 바뀌었으므로 지면모델도 재산출해야 한다.
  await loadGroundModel();
  await loadParkingSlots();        // DB 재조회 → 새 slot_setup 반영(parkingSlotsByKey 갱신).
  drawRoiOverlay();
  renderSlotList();
  const skipped = (data.skipped ?? []).map((s) => `cam${s.camId}:preset${s.presetId} ${s.count}건(${s.reason})`);
  const parts = [`ROI 로딩 완료: 슬롯 ${data.slots}건 / 카메라 ${data.cameras} / 프리셋 ${data.presets}`];
  if (skipped.length) parts.push(`스킵 ${skipped.join(', ')}`);
  if ((data.issues ?? []).length) parts.push(`이슈 ${data.issues.join(' | ')}`);
  $('cap-msg').textContent = parts.join(' — ');
}

// 3D육면체 ROI생성: 지면모델로 슬롯별 육면체 앞면 중심(slot3d_front_center)을 산출해 DB 저장 + 즉시 표시.
// 파괴적이지 않다(검출·점유·센터링 무접촉) → confirm 없음. 산출 실패 슬롯은 기존 값 보존(skipped 로 드러남).
async function buildSlotCuboids() {
  const res = await fetch('/capture/slots/cuboid', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ heightM: cuboidHeight() }), // 화면 슬라이더 높이 = 저장 높이(표시=저장 정합).
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) { $('cap-msg').textContent = `3D육면체 생성 실패: ${data.error ?? res.status}`; return; }
  state.groundLoaded = false;      // 1회 로드 가드 해제 — 지면모델 재산출(렌더 근거 갱신).
  await loadGroundModel();
  $('roi-cuboid').checked = true;  // 육면체 오버레이 자동 ON(결과가 보이게).
  state.roiHidden = false;
  await loadParkingSlots();        // DB 갱신분(slot3dFrontCenter) 반영.
  drawRoiOverlay();
  renderSlotList();
  const parts = [`3D육면체 생성: 산출 ${data.updated}건 / 스킵 ${(data.skipped ?? []).length}건 (h=${data.heightM}m)`];
  const skipped = (data.skipped ?? []).map((s) => `#${s.slotId}(${s.reason})`);
  if (skipped.length) parts.push(`스킵 ${skipped.join(', ')}`);
  const models = (data.models ?? []).map((m) => `${m.key} conf=${Number(m.conf).toFixed(3)}`);
  if (models.length) parts.push(`모델 ${models.join(' / ')}`);
  const modelIssues = (data.models ?? []).flatMap((m) => (m.issues ?? []).map((i) => `${m.key}: ${i}`));
  const allIssues = [...(data.issues ?? []), ...modelIssues];
  if (allIssues.length) parts.push(`이슈 ${allIssues.join(' | ')}`);
  $('cap-msg').textContent = parts.join(' — ');
}

// 현재 프리셋의 라이브 LPD 검출(state.detectByKey)을 슬롯 공간배정 → slot_setup.lpd 에 저장("DB에 추가").
async function saveLpdToDb() {
  const cam = state.capFrameKey2?.cam ?? state.cam;
  const preset = state.capFrameKey2?.preset ?? state.preset;
  const plates = state.detectByKey[presetKey(cam, preset)]?.plates ?? [];
  if (plates.length === 0) {
    $('disc-msg').textContent = '검출된 번호판 없음 — 먼저 LPD 실행';
    return;
  }
  const res = await fetch('/capture/slots/lpd', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cam, preset, plates }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) { $('disc-msg').textContent = `DB 추가 실패: ${data.error ?? res.status}`; return; }
  $('disc-msg').textContent = `DB 추가: ${data.updated} 슬롯 (미배정 ${data.unassigned})`;
  await loadParkingSlots(); // #roi-db(slot_setup 소스) 오버레이 정합 갱신.
  drawRoiOverlay();
  renderSlotList();
}

// 현재 프리셋의 DB 번호판(slot_setup.lpd)으로 점유영역(occupy_range)을 재생성해 DB에 저장("점유영역 생성").
// 생성식은 서버가 discovery 와 공유(buildOccupyRangeFromPlate) — 프런트는 트리거·표시 갱신만 한다.
async function buildOccupyRange() {
  const cam = state.capFrameKey2?.cam ?? state.cam;
  const preset = state.capFrameKey2?.preset ?? state.preset;
  const res = await fetch('/capture/slots/occupy', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cam: Number(cam), preset: Number(preset) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) { $('disc-msg').textContent = `점유영역 생성 실패: ${data.error ?? res.status}`; return; }
  $('disc-msg').textContent = `점유영역 생성: ${data.updated} 슬롯 (번호판 없음 ${data.skipped}${data.failed ? `, 실패 ${data.failed}` : ''})`;
  await loadParkingSlots(); // #roi-db(slot_setup 소스) 오버레이 정합 갱신.
  drawRoiOverlay();
  renderSlotList();
}

// --- 센터라이징(주차면별 번호판 중심정렬·줌 → slot_ptz.json · DB centering_slot) ------
// capPoll 패턴 차용(pollPlan 재사용). 절대경로 /calibrate/* 직접 폴링.
let calPollTimer = null;
let prevCalState = 'idle';

// 센터라이징 중 Live View 에 '최근 센터라이징 프레임'을 표시(카메라 재명령 없이 잡이 찍은 프레임 추종).
// /calibrate/frame 은 PlatePtz 가 매 캡처 직후 흘려보낸 최신 JPEG 을 버퍼에서 반환할 뿐 새 촬영을 하지 않는다.
// capFrameTick 패턴 복제 — 다만 라운드 개념이 없어 매 폴 갱신(500ms, 저비용). 오버레이는 쌓지 않고 순수 프레임만.
let calFrameTimer = null;
let calFrameUrl = null;

async function calFrameTick() {
  try {
    const res = await fetch('/calibrate/frame', { cache: 'no-store' });
    if (!res.ok) return; // 404(버퍼 없음) 등 → 갱신 스킵.
    const url = URL.createObjectURL(await res.blob());
    frame.src = url;
    if (frame.decode) await frame.decode().catch(() => {});
    if (calFrameUrl) URL.revokeObjectURL(calFrameUrl);
    calFrameUrl = url;
    const c = res.headers.get('X-Cal-Cam');
    if (c != null) {
      $('cal-msg').textContent = `센터라이징 중 — cam${c} 프리셋${res.headers.get('X-Cal-Preset')}`;
    }
  } catch {
    /* ignore */
  }
}

function startCalFramePolling() {
  if (calFrameTimer) return;
  stopCapFramePolling(); // 상호배타(불변식3): 정밀수집 폴 잔여 타이머 제거.
  stopDiscFramePolling(); // 상호배타(불변식3): discovery 프레임폴 잔여 타이머 제거.
  stopLive();            // 라이브 MJPEG 스트림 중지 — 카메라를 캡처와 다투지 않게.
  calFrameTimer = setInterval(calFrameTick, 500);
  calFrameTick();
}

function stopCalFramePolling() {
  if (calFrameTimer) {
    clearInterval(calFrameTimer);
    calFrameTimer = null;
  }
}

async function calStart() {
  preciseActive = false; // 수동 센터라이징 — 상단 진행바 소유권 반납(discStart 미러).
  $('cal-msg').textContent = '';
  $('cal-summary').innerHTML = '';
  const res = await fetch('/calibrate/ptz', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const data = await res.json().catch(() => ({}));
  // total=0 은 코드 실패가 아니라 입력 부재(setup_artifact 에 번호판 ROI 슬롯 0) — 원인을 알려준다.
  const okMsg = data.total === 0
    ? '대상 0 — 셋업 산출물에 번호판 ROI 슬롯이 없습니다(최종화 필요)'
    : `시작됨 (대상 ${data.total} 슬롯)`;
  $('cal-msg').textContent = res.ok ? okMsg : `시작 실패: ${data.error ?? res.status}`;
  calPoll();
}

// 동시 클릭 방지 락(개별 센터라이징 진행 중 중복 발화 차단).
let calPointBusy = false;
// mousedown 으로 조준을 예약하고 mouseup 에서 발화하기 위한 대기 표식(마스터 요청 — 버튼을 뗄 때 동작).
let calClickPending = false;

// 개별(클릭) 센터라이징 발화(설계서 §3.4) — calStart 축소판. 저장 없음(POST /calibrate/point).
// mode='point'=클릭 지점을 화면중앙으로(검출없음·zoom 불변) / 'plate-zoom'=번호판 center+zoom.
// 진행 프레임은 startCalFramePolling 재사용 — 단 point 는 캡처를 하지 않으므로 폴링 없이 라이브 유지.
async function calPointCenter(nx, ny, mode) {
  if (calPointBusy) return;
  calPointBusy = true;
  const cam = state.capFrameKey2?.cam ?? state.cam;
  const preset = state.capFrameKey2?.preset ?? state.preset;
  $('cal-msg').textContent = mode === 'point' ? '클릭 지점을 화면 중앙으로 이동 중…' : '번호판 센터+줌 중…';
  $('cal-summary').innerHTML = '';
  // point 는 프레임 캡처가 없어 /calibrate/frame 이 갱신되지 않는다 → 폴링 생략하고 라이브 스트림 유지.
  if (mode !== 'point') startCalFramePolling(); // 진행 프레임 실시간 표시(라이브 중지·상호배타).
  let data = null;
  let res = null;
  try {
    res = await fetch('/calibrate/point', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // source 동봉: 뷰어에서 보고 있는 소스 = 명령 대상(미동봉이면 서버 기동 시 고정된 파이프라인 카메라로 간다).
      body: JSON.stringify({ cam, preset, point: { x: nx, y: ny }, mode, source: state.source || undefined }),
    });
    data = await res.json().catch(() => ({}));
  } catch (err) {
    data = { error: String(err) };
  }
  stopCalFramePolling();
  if (res && res.status === 409) {
    $('cal-msg').textContent = '센터라이징(전체) 진행 중 — 잠시 후 다시 시도하세요';
  } else if (res && res.ok && data && data.ok) {
    // ok:true + reason 은 "장비가 할 수 있는 일을 전부 했으나 목표 폭엔 미달"(장비 최대 배율) 케이스다.
    // 완료로 보이되 사유를 숨기지 않는다 — 마스터가 더 확대되지 않는 이유를 알 수 있어야 한다.
    // 사유는 zoom_saturated(장비 배율 상한) / zoom_resolution_limit(줌 해상도 한계) 등으로 갈린다 →
    // 특정 원인을 단정하지 말고 "목표 폭 미달"이라는 사실 + 사유 문자열을 그대로 보여준다.
    $('cal-msg').textContent = data.reason
      ? `개별 센터라이징 완료 — 목표 폭 미달(${data.reason})`
      : '개별 센터라이징 완료';
  } else {
    const why = (data && (data.reason || data.error)) ?? (res ? res.status : 'error');
    $('cal-msg').textContent = `종료(${why})`;
  }
  // 개별 센터라이징(point/plate/plate-zoom 전부)은 카메라를 움직인다 → UI 기준 PTZ 재동기화.
  await syncPtzAfterJob(data && data.ptz);
  if (mode !== 'point') startLive(); // 얼어붙은 마지막 프레임을 라이브 스트림으로 대체(point 는 라이브를 끊은 적 없음).
  calPointBusy = false;
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
  if (preciseActive) {
    renderPreciseProgress('센터라이징', status); // 정밀수집 진행바 미러(2단계).
  }
  // 중복 이동 제거 — 정본은 상단 진행바. **진행 중일 때만** 비운다(끝나면 평소대로 최종 실적을 남긴다).
  if (preciseActive && st === 'running') {
    neutralizeSubProgress('cal-bar', 'cal-label');
  } else {
    $('cal-bar').value = percent;
    $('cal-label').textContent = `${st} ${done}/${total}` + (status?.current ? ` — ${status.current.slotId}` : '');
  }

  // 진행 중이면 프레임 폴로 화면 실시간 갱신, 아니면 폴 중지.
  if (st === 'running') startCalFramePolling();
  else stopCalFramePolling();

  // 활성 → 완료 전환 시 결과 요약 1회 렌더 + 라이브뷰 복귀(센터라이징은 오버레이를 쌓지 않아 리셋 불요).
  if (prevCalState === 'running' && st !== 'running') {
    if (st === 'done') await renderCalResult();
    else $('cal-msg').textContent = `종료(${st})`;
    await syncPtzAfterJob(null); // 배치 센터라이징이 카메라를 움직였다 → UI 기준 PTZ 재동기화.
    startLive(); // 얼어붙은 마지막 센터라이징 프레임을 라이브 스트림으로 대체.
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

// --- 앞면중심 LOOP discovery(모드 b) — calStart/calPoll/calFrameTick 미러 -----
// 백엔드(/discover/*, PlateDiscoveryJob) 완성분에 UI 만 배선. 상태변수는 disc 접두(cal 대칭).
let discPollTimer = null;
let prevDiscState = 'idle';
let discFrameTimer = null;
let discFrameUrl = null;

async function discFrameTick() {
  // calFrameTick 미러: /discover/frame(잡이 방금 찍은 최신 JPEG, 카메라 재명령 없음). 오버레이 미적재·순수 프레임.
  try {
    const res = await fetch('/discover/frame', { cache: 'no-store' });
    if (!res.ok) return; // 404(버퍼 없음) 등 → 갱신 스킵.
    const url = URL.createObjectURL(await res.blob());
    frame.src = url;
    if (frame.decode) await frame.decode().catch(() => {});
    if (discFrameUrl) URL.revokeObjectURL(discFrameUrl);
    discFrameUrl = url;
  } catch {
    /* ignore */
  }
}

function startDiscFramePolling() {
  if (discFrameTimer) return;
  stopCapFramePolling(); // 상호배타(불변식3): 정밀수집 폴 잔여 타이머 제거.
  stopCalFramePolling(); // 상호배타(불변식3): 센터라이징 폴 잔여 타이머 제거.
  stopLive();            // 라이브 MJPEG 스트림 중지 — 카메라를 잡과 다투지 않게.
  discFrameTimer = setInterval(discFrameTick, 500);
  discFrameTick();
}

function stopDiscFramePolling() {
  if (discFrameTimer) {
    clearInterval(discFrameTimer);
    discFrameTimer = null;
  }
}

async function discStart() {
  preciseActive = false; // 수동 LPD 실행 — 정밀수집이 갖고 있던 상단 진행바 소유권을 반납한다.
  $('disc-msg').textContent = '';
  // 현재 표시 프리셋 한정(runLiveDetect 미러) — 정밀수집 폴 중이면 표시 프레임, 아니면 라이브 선택 프리셋.
  const cam = state.capFrameKey2?.cam ?? state.cam;
  const preset = state.capFrameKey2?.preset ?? state.preset;
  const res = await fetch('/discover/ptz', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cam, preset }), // 전체 배치 → 현재 프리셋 한정.
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    $('disc-msg').textContent = `시작 실패: ${data.error ?? res.status}`; // 409(이미 실행 중) 포함.
    return;
  }
  // total=0 은 코드 실패가 아니라 입력 부재(현재 프리셋에 앞면중심 보유 슬롯 0) — 원인을 알려준다(calStart 미러).
  $('disc-msg').textContent = data.total === 0
    ? '대상 0 — 현재 프리셋에 앞면중심 보유 슬롯 없음(최종화 필요)'
    : `시작됨 (대상 ${data.total} 슬롯)`;
  discPoll();
}

async function discPoll() {
  let status = null;
  try {
    const res = await fetch('/discover/status', { cache: 'no-store' });
    status = res.ok ? await res.json() : null;
  } catch {
    status = null;
  }
  const view = discoverView(status ?? {}); // 순수 헬퍼(core.js) — vitest 대상.
  if (preciseActive) {
    renderPreciseProgress('번호판 탐색', status); // 정밀수집 진행바 미러(요건: 시작 후 진행상황 표시).
  }
  // 중복 이동 제거 — 정본은 상단 진행바. **진행 중일 때만** 비운다(끝나면 평소대로 최종 실적을 남긴다).
  if (preciseActive && view.polling) {
    neutralizeSubProgress('disc-bar', 'disc-label');
  } else {
    $('disc-bar').value = view.percent;
    $('disc-label').textContent = view.label;
  }
  $('lpd-run').disabled = view.runDisabled;

  // 진행 중이면 프레임 폴로 화면 실시간 갱신, 아니면 폴 중지(startCalFramePolling 미러).
  if (view.polling) startDiscFramePolling();
  else stopDiscFramePolling();

  const st = status?.state ?? 'idle';
  // 활성 → 완료 전환 시 결과 요약 1회 렌더 + 라이브뷰 복귀(discovery 는 오버레이를 쌓지 않아 리셋 불요).
  if (prevDiscState === 'running' && st !== 'running') {
    if (st === 'done') await renderDiscResult();
    else $('disc-msg').textContent = `종료(${st})`;
    await syncPtzAfterJob(null); // discovery 가 카메라를 움직였다 → UI 기준 PTZ 재동기화.
    startLive(); // 얼어붙은 마지막 탐색 프레임을 라이브 스트림으로 대체.
  }
  prevDiscState = st;

  const plan = pollPlan(st); // 'running' 에서만 poll(discovery 엔 stopping/finalizing 없음 → 부작용 없음).
  if (discPollTimer) {
    clearTimeout(discPollTimer);
    discPollTimer = null;
  }
  if (plan.poll) discPollTimer = setTimeout(discPoll, plan.intervalMs);
}

async function renderDiscResult() {
  try {
    const res = await fetch('/discover/status', { cache: 'no-store' }); // 최종 카운트(found/total).
    const s = res.ok ? await res.json() : {};
    $('disc-msg').textContent = `완료 — 발견 ${s.found ?? 0}/${s.total ?? 0} 슬롯 (slot_setup.lpd 갱신)`;
  } catch {
    /* ignore */
  }
  // 검지 박스 표시: result 의 found+lpdOrig 를 프리셋키별 저장(현재 프리셋 한정이라 단일 키). 뒤이은 startLive→drawRoiOverlay 가 렌더.
  try {
    const res = await fetch('/discover/result', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const byKey = {};
    for (const it of data.items ?? []) {
      if (!it.found || !it.lpdOrig) continue;
      (byKey[presetKey(it.camIdx, it.presetIdx)] ??= []).push(it.lpdOrig);
    }
    state.discoverByKey = byKey; // 새 결과로 대체(누적 아님 — 이전 프리셋 잔여 정리).
  } catch {
    /* ignore */
  }
}

// 모드 (a): 순수 LPD 진단(기존 cap-detect-run 본문 이사). 비-LPD 오버레이 off + LPD 전용 검출.
function runModeLpd() {
  // 바닥ROI·슬롯 육면체는 검출이 아닌 슬롯 기준 지오메트리라 유지(문맥 참조).
  $('roi-vehicle').checked = false;   // 차량(VPD) 박스 숨김.
  $('roi-occupancy').checked = false; // 점유영역 숨김.
  $('roi-vcuboid').checked = false;   // 차량 육면체(VPD seg) 숨김.
  $('roi-mask').checked = false;      // VPD seg 마스크 숨김.
  $('roi-plate').checked = true;      // 번호판(LPD) quad 만 표시.
  runLiveDetect(false);               // LPD 전용 검출 — VPD 미실행.
}

// 모드 (d): 현재화면 순수 LPD. runModeLpd 와 동일 오버레이 + 현재 뷰어 PTZ(state.ptz) 로 base 재렌더(프리셋 스냅 없음).
function runModeLpdLive() {
  $('roi-vehicle').checked = false;
  $('roi-occupancy').checked = false;
  $('roi-vcuboid').checked = false;
  $('roi-mask').checked = false;
  $('roi-plate').checked = true;
  runLiveDetect(false, state.ptz);    // LPD 전용 + 현재 PTZ 오버라이드.
}

// 모드 (c): VPD→LPD(기존 cap-vpd-test 본문 이사). LPD 진단이 껐던 차량·점유 오버레이 복원 + 검출.
function runModeVpd() {
  $('roi-vehicle').checked = true;    // vehicles+육면체 표시.
  $('roi-occupancy').checked = true;  // 점유영역 복원.
  runLiveDetect(true);
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

function fmtPtz(ptz) {
  if (!ptz) return '-';
  const f = (n) => Number(n).toFixed(3);
  return `${f(ptz.pan)}, ${f(ptz.tilt)}, ${f(ptz.zoom)}`;
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
      ['순서', '카메라', '프리셋', '라벨', '주차면 수', 'PTZ (pan, tilt, zoom)'],
      // 순서 = 표 행 번호(1부터). 산출물 presets[] 순서(카메라·프리셋 오름차순)를 그대로 따른다.
      // PTZ 는 산출물 보관값 우선, 없으면 라이브 카메라 목록(GET /cameras — '프리셋 이동' 과 같은 정본)으로 폴백.
      a.perPreset.map((p, i) => [
        i + 1, p.camIdx, p.presetIdx, p.label, p.slotCount,
        fmtPtz(p.ptz ?? findPresetPtz(state.cameras, p.camIdx, p.presetIdx)),
      ]),
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
 * 분석 탭 점유율 표(#an-occupancy) 렌더. run_id 폐기(설계서 §3) — 현재 잡 인메모리 축소 occupancy 직접 조회.
 * 데이터 없으면 안내 문구. showAvgCard=true 면 an-summary 에 평균 점유율 카드 1장 append.
 */
async function renderOccupancyAnalysis(showAvgCard) {
  const box = $('an-occupancy');
  if (!box) return;
  box.innerHTML = '';
  try {
    const res = await fetch('/capture/occupancy', { cache: 'no-store' });
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
    '<thead><tr><th>전역 ID</th><th>카메라</th><th>프리셋</th><th>프리셋내 위치</th><th>slotId (현재)</th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.dataset.slotId = r.slotId;
    tr.addEventListener('click', () => selectMapSlot(r.slotId)); // 표 행 ↔ 슬롯맵 동기화.
    // 전역 ID(저장 시 slot_id 재번호) + 배치 3열(카메라/프리셋/프리셋내 위치) 모두 직접 입력.
    tr.appendChild(manualCell(r.slotId, 'gid', r.globalIdx));
    tr.appendChild(manualCell(r.slotId, 'cam', r.camIdx));
    tr.appendChild(manualCell(r.slotId, 'preset', r.presetIdx));
    tr.appendChild(manualCell(r.slotId, 'pos', r.positionIdx));
    const sidTd = document.createElement('td');
    sidTd.textContent = String(r.slotId);
    sidTd.title = 'DB slot_id(현재). 저장하면 왼쪽 전역 ID 값으로 재번호됩니다 — slotId = 전역 ID.';
    tr.appendChild(sidTd);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  box.appendChild(table);
  validateManualTable();
  renderSlotMap();
}

/**
 * 매핑 표의 편집 셀 1개(number input). field='gid'|'cam'|'preset'|'pos'.
 * 입력 즉시 정합 재검증 + 슬롯맵 번호 갱신(전역ID 변경이 박스 라벨에 바로 보이게).
 */
function manualCell(slotId, field, value) {
  const td = document.createElement('td');
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '1';
  input.className = field === 'gid' ? 'an-manual-input' : 'an-manual-input an-manual-place';
  input.dataset.slotId = slotId;
  input.dataset.field = field;
  input.value = value ?? '';
  input.addEventListener('input', () => {
    validateManualTable();
    renderSlotMap();
  });
  td.appendChild(input);
  return td;
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
  for (const input of document.querySelectorAll('.an-manual-input[data-field="gid"]')) {
    map[input.dataset.slotId] = input.value;
  }
  return map;
}

/** 표의 배치 입력값을 {slotId: {camIdx, presetIdx, positionIdx}} 로 수집. */
function collectManualPlacement() {
  const map = {};
  const fields = { cam: 'camIdx', preset: 'presetIdx', pos: 'positionIdx' };
  for (const input of document.querySelectorAll('.an-manual-place')) {
    const slotId = input.dataset.slotId;
    if (!map[slotId]) map[slotId] = {};
    map[slotId][fields[input.dataset.field]] = input.value;
  }
  return map;
}

/** 현재 입력값 정합(전역ID 1..N 고유 + 배치 삼중키·위치 연속) 표시. */
function validateManualTable() {
  const status = $('an-manual-status');
  if (!status || !lastArtifact) return;
  const gid = applyManualGlobalIds(lastArtifact, collectManualIds());
  const place = applyManualPlacement(lastArtifact, collectManualPlacement());
  const ok = gid.ok && place.ok;
  status.textContent = ok ? '정합 OK (전역ID 1..N 고유 · 배치 충돌 없음)' : (gid.ok ? place.error : gid.error);
  status.className = ok ? 'an-manual-ok' : 'an-manual-bad';
}

/** 자동 번호: 표 순서(카메라→프리셋→위치)대로 전역ID 1..N 채움(배치 열은 손대지 않음). */
function autoNumberManual() {
  [...document.querySelectorAll('.an-manual-input[data-field="gid"]')].forEach(
    (input, i) => (input.value = String(i + 1)),
  );
  validateManualTable();
}

/**
 * #7 저장: ① 배치 변경분 → POST /mapping/placement(DB cam/preset/위치)
 *          ② 전역ID 순열 → POST /mapping/renumber(DB slot_id 재번호 + json 전파).
 * 순서 고정 — 배치는 현재 slot_id 를 키로 쓰므로 재번호보다 **먼저** 반영해야 한다.
 * 배치가 그대로면 ①은 건너뛴다(불필요한 updated_at 갱신 방지).
 */
async function saveManualIndex() {
  if (!lastArtifact) return;
  const msg = $('an-manual-msg');
  const res = applyManualGlobalIds(lastArtifact, collectManualIds()); // 클라 검증 게이트 유지(빠른 피드백)
  if (!res.ok) {
    if (msg) msg.textContent = `저장 불가: ${res.error}`;
    return;
  }
  const place = applyManualPlacement(lastArtifact, collectManualPlacement());
  if (!place.ok) {
    if (msg) msg.textContent = `저장 불가: ${place.error}`;
    return;
  }
  // 현재 slotId=old, 입력 전역ID=new 순열을 매핑 배열로 파생(백엔드가 재검증).
  const mapping = res.artifact.globalIndex.map((g) => ({ oldSlotId: Number(g.slotId), newSlotId: g.globalIdx }));
  try {
    let placed = '';
    if (place.changed) {
      const rp = await fetch(api('/mapping/placement'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ placements: place.placements }),
      });
      const dp = await rp.json().catch(() => ({}));
      if (!rp.ok) {
        if (msg) msg.textContent = `배치 저장 실패: ${dp.error ?? rp.status}`;
        return; // 재번호는 진행하지 않는다(DB 무변경 유지).
      }
      placed = `배치 ${dp.updated}면 · `;
    }
    const r = await fetch(api('/mapping/renumber'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mapping }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      if (msg) msg.textContent = `${placed}재번호 저장됨: ${data.renumbered}면 (slot_ptz:${data.slotPtz})`;
      await loadMapping(); // 검수 탭·state.mapping 재동기화.
      await renderAnalysis(); // 분석 탭 재렌더(재번호 반영).
      renderSlotList(); // 주차면 목록 재렌더.
    } else {
      if (msg) msg.textContent = `${placed}재번호 실패: ${data.error ?? r.status}`;
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

let editableCameraSources = [];
let renderedCameraSourceId = '';

function captureCameraSourceEdits() {
  const source = editableCameraSources.find((item) => item.id === renderedCameraSourceId);
  if (!source) return;
  source.label = $('opt-camera-label').value.trim();
  source.kind = $('opt-camera-kind').value === 'hucoms' ? 'hucoms' : 'sim'; // 콤보 선택을 데이터 모델(kind)로 확정.
  source.protocol = alignProtocolToKind(source.kind, source.protocol); // kind 계열에 맞춰 protocol 정합(hucoms↔sim 전환 시).
  source.baseUrl = $('opt-camera-baseurl').value.trim();
  source.username = $('opt-camera-username').value.trim();
  source.rtspUrl = $('opt-camera-rtsp').value.trim();
  const password = $('opt-camera-password').value;
  if (password) source.pendingPassword = password;
}

function renderCameraSource(id) {
  const source = editableCameraSources.find((item) => item.id === id);
  renderedCameraSourceId = source?.id ?? '';
  $('opt-camera-label').value = source?.label ?? '';
  $('opt-camera-kind').value = source?.kind === 'hucoms' ? 'hucoms' : 'sim'; // 콤보: 시뮬레이터(sim)/리얼카메라(hucoms).
  $('opt-camera-baseurl').value = source?.baseUrl ?? '';
  $('opt-camera-username').value = source?.username ?? '';
  $('opt-camera-password').value = source?.pendingPassword ?? '';
  $('opt-camera-rtsp').value = source?.rtspUrl ?? '';
  $('opt-camera-rtsp').disabled = source?.kind !== 'hucoms';
  const stored = source?.passwordSet ? '저장된 비밀번호 있음 · 새 값을 입력하지 않으면 유지됩니다.' : '저장된 비밀번호 없음';
  const streaming = source?.kind === 'hucoms'
    ? '스트리밍: RTSP → FFmpeg → 브라우저 MJPEG'
    : '스트리밍: 시뮬레이터 URL → HTTP MJPEG';
  $('opt-camera-note').textContent = source
    ? `${source.protocol ?? '기본 프로토콜'} · ${streaming} · ${stored} 비밀번호는 GET API와 화면에 노출되지 않습니다.`
    : 'config에 등록된 카메라가 없습니다.';
}

function loadCameraSettings(camera) {
  editableCameraSources = (camera?.sources ?? []).map((source) => ({ ...source }));
  $('opt-camera-execution').value = camera?.executionMode ?? 'typescript-native';
  const select = $('opt-camera-selected');
  select.innerHTML = '';
  for (const source of editableCameraSources) {
    const option = document.createElement('option');
    option.value = source.id;
    option.textContent = source.label || source.id;
    select.appendChild(option);
  }
  const selected = editableCameraSources.some((source) => source.id === camera?.selectedCameraId)
    ? camera.selectedCameraId
    : editableCameraSources[0]?.id ?? '';
  select.value = selected;
  renderCameraSource(selected);
}

function cameraSettingsPatch() {
  captureCameraSourceEdits();
  const selectedCameraId = $('opt-camera-selected').value;
  const source = editableCameraSources.find((item) => item.id === selectedCameraId);
  if (!source) {
    return { executionMode: $('opt-camera-execution').value, selectedCameraId, source: undefined };
  }
  const patch = {
    id: source.id,
    label: source.label,
    kind: source.kind,
    protocol: source.protocol,
    baseUrl: source.baseUrl,
    username: source.username,
    rtspUrl: source.rtspUrl,
  };
  if (source.pendingPassword) patch.password = source.pendingPassword;
  return { executionMode: $('opt-camera-execution').value, selectedCameraId, source: patch };
}

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
    loadCameraSettings(s.camera);
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
    camera: cameraSettingsPatch(),
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
      const selected = editableCameraSources.find((source) => source.id === form.camera.selectedCameraId);
      if (selected?.pendingPassword) {
        selected.passwordSet = true;
        delete selected.pendingPassword;
        $('opt-camera-password').value = '';
        renderCameraSource(selected.id);
      }
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
  if (tab === 'precise') { capPoll(); calPoll(); loadPlaceRoi(); loadGroundModel(); void loadParkingSlots().then(() => drawRoiOverlay()); }
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
    // [개별 센터라이징] 콤보 선택 시 클릭을 최우선 소비 → 클릭 지점 최근접 번호판으로 센터라이징(저장 안 함).
    // 미선택(off)이면 이 분기를 건너뛰어 기존 편집 동작 100% 보존. Ctrl 은 기존 편집 제스처라 제외.
    const clickMode = $('cal-click-mode')?.value;
    if (clickMode && clickMode !== 'off' && !e.ctrlKey) {
      // 발화는 mouseup 에서 한다(마스터 요청) — down 은 기존 편집으로 새지 않게 소비만 하고 대기 표식을 남긴다.
      e.preventDefault();
      calClickPending = true;
      return;
    }
    const { nx, ny } = eventToNorm(e);
    // [기능2] 검출 박스 편집(임시): 차량/번호판 레이어 중 하나라도 표시 중 + Ctrl 아님(슬롯 편집과 물리 배타). mapping/roiHidden 가드 이전.
    if (($('roi-vehicle').checked || $('roi-plate').checked) && !e.ctrlKey) {
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

  // mouseup: 개별 센터라이징 발화(down 에서 예약된 경우) → 뗀 지점을 화면중앙으로.
  // window 로 받아 오버레이 밖에서 뗀 경우에도 예약을 반드시 해제한다(유령 발화 방지).
  window.addEventListener('mouseup', (e) => {
    if (!calClickPending) return;
    calClickPending = false;
    if (!overlay.contains(e.target)) return; // 밖에서 뗌 = 취소.
    const clickMode = $('cal-click-mode')?.value;
    if (!clickMode || clickMode === 'off') return; // 누른 뒤 콤보를 끈 경우.
    const { nx, ny } = eventToNorm(e);
    // center(개별 center)=뗀 지점 자체를 화면중앙으로('point'), center-zoom=번호판 center+zoom('plate-zoom').
    void calPointCenter(nx, ny, clickMode === 'center-zoom' ? 'plate-zoom' : 'point');
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

  $('cap-start').addEventListener('click', startPrecise); // 정밀수집(LPD탐색→점유→센터라이징→setup_result).
  $('cap-capture-start').addEventListener('click', capCaptureStart); // 반복 관측 수집(CaptureJob) — 별도 경로.
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
  // 개별 센터라이징 콤보: 활성(off 아님) 시 오버레이 커서를 crosshair 로 전환(클릭 조준 피드백).
  $('cal-click-mode').addEventListener('change', (e) => {
    overlay.classList.toggle('click-centering', e.target.value !== 'off');
  });
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
  $('opt-camera-selected').addEventListener('change', (event) => {
    captureCameraSourceEdits();
    renderCameraSource(event.target.value);
  });
  // 카메라 타입(시뮬레이터/리얼카메라) 전환 → 편집 확정 후 재렌더(RTSP 활성·note 갱신).
  $('opt-camera-kind').addEventListener('change', () => {
    captureCameraSourceEdits();
    renderCameraSource(renderedCameraSourceId);
  });

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
    state.isHucoms = state.sourceDetails[state.source]?.kind === 'hucoms';
    updatePtzControlUi();
    await loadCameras();
    await refreshCurrentPtz({ quiet: true });
    reconnectLiveIfActive();
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
  // DB(slot_setup) 소스 오버레이 토글(vpd/lpd/occupy 를 DB 소스로 전환).
  // 켤 때마다 DB 재조회 — 어느 탭에서 켜도(소스 미로드) 표시되고, '표시 초기화' 후 재체크 시에도 최신 DB 가 보인다.
  $('roi-db').addEventListener('change', async (e) => {
    if (e.target.checked) await loadParkingSlots();
    drawRoiOverlay();
  });
  $('roi-cuboid').addEventListener('change', drawRoiOverlay); // 3D 육면체 레이어 토글(기본 off → 회귀 0).
  $('roi-mask').addEventListener('change', drawRoiOverlay); // VPD seg 마스크 오버레이 토글(순수 렌더 — masks 는 detect 응답에 동승, 별도 로드 불필요).
  // 차량 육면체 토글(**기본 off** — 마스터 요청 2026-07-15: 시작 시 체크 해제).
  // 렌더 토글일 뿐 점유 판정과 무관하다(회귀 0). 정밀수집·검출이 돌면 데이터는 자동으로 온다;
  // 켤 때 해당 프리셋 캐시가 없으면 그때만 라이브 촬영 1회(캐시 있으면 재사용).
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
  // LPD 검지 3모드: 콤보 선택값으로 디스패치(2버튼 대체). (a)순수LPD (b)앞면중심LOOP discovery (c)VPD→LPD.
  $('lpd-run').addEventListener('click', () => {
    const mode = $('lpd-mode').value;
    if (mode === 'lpd') runModeLpd();
    else if (mode === 'discover') discStart();
    else if (mode === 'vpd') runModeVpd();
    else if (mode === 'lpd-live') runModeLpdLive();
  });
  $('lpd-db-add').addEventListener('click', saveLpdToDb); // 라이브 LPD 검출 → slot_setup.lpd 저장.
  $('occupy-build').addEventListener('click', buildOccupyRange); // DB lpd → occupy_range 결정형 재생성.
  $('roi-clear').addEventListener('click', resetOverlayDisplay); // #5: 표시 초기화 — 모든 오버레이 토글 off(데이터 보존).
  $('cap-reset-db').addEventListener('click', resetSlotSetupDb); // 검출·센터링 DB 초기화(slot_setup vpd/lpd/occupy/ptz 비움).
  $('cap-touring').addEventListener('click', runTouringTest); // Touring Test — setup_result 순회 이동(독립, DB 미변경).
  $('touring-done-close').addEventListener('click', () => {
    $('touring-done-modal').hidden = true;
  });
  $('cap-load-roi').addEventListener('click', loadRoiToDb); // PtzCamRoi.json → slot_setup 전량 재구성.
  $('cap-build-cuboid').addEventListener('click', buildSlotCuboids); // 지면모델 → slot3d_front_center 산출·저장·표시.
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
    b.addEventListener('click', async () => {
      const step = Number($('step').value) || 2;
      // 실카는 캐시가 아니라 **장비 실측**을 기준으로 스텝을 계산한다(수정 19). 조회 실패 시 이동하지 않는다.
      const base = await moveBasePtz();
      if (!base) return;
      move(stepPtz(base, b.dataset.dir, step));
    }),
  );

  $('btn-abs').addEventListener('click', async () => {
    // 빈 칸은 현재 PTZ 유지(0/1 리셋 금지) — zoom 만 채워 이동해도 pan/tilt 프레이밍 보존.
    // 그 "현재 PTZ"도 실카에서는 장비 실측이어야 한다(수정 19) — 캐시면 빈 칸이 낡은 값으로 굳는다.
    const base = await moveBasePtz();
    if (!base) return;
    move(
      resolveAbsPtz(base, {
        pan: $('abs-pan').value,
        tilt: $('abs-tilt').value,
        zoom: $('abs-zoom').value,
      }),
    );
  });

  $('btn-ptz-refresh').addEventListener('click', () => refreshCurrentPtz());

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
    if (data.ok) await refreshCurrentPtz({ quiet: true });
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
  await refreshCurrentPtz({ quiet: true });
  simConnected = camOk; // 초기 연결 상태 확정.
  $('badge-camera').classList.toggle('ok', !!camOk); // badge-camera = Unity 연결(loadCameras 성공).
  drawRoiOverlay();
  renderSelectionInfo();
  setInterval(connectionTick, CONN_POLL_MS); // 주기 폴 시작(연결/변경 자동 반영).
}

init();
