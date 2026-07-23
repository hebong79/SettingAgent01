// SettingViewer 순수 로직 모듈 (환경 비의존, vitest 직접 import).
// DOM/fetch/브라우저 전역 미참조. app.js 가 실제 의존성을 주입한다.

const ZOOM_MIN = 1;
const ZOOM_MAX = 36;

/**
 * 정규화 ROI(0~1) → 표시 픽셀 좌표(설계서 §5.2).
 * imgW/imgH = img.clientWidth/clientHeight(표시 크기, naturalWidth 아님).
 */
export function toPixel(rect, imgW, imgH) {
  return { px: rect.x * imgW, py: rect.y * imgH, pw: rect.w * imgW, ph: rect.h * imgH };
}

/**
 * 정규화 4점 사변형(quad: 4×{x,y}) → 표시 픽셀 점 배열(toPixel 의 폴리곤판).
 * floor ROI(바닥 점유 영역) 오버레이용. imgW/imgH = 표시 크기.
 */
export function toPixelQuad(quad, imgW, imgH) {
  return quad.map((p) => ({ px: p.x * imgW, py: p.y * imgH }));
}

/** 결합 키 `${camIdx}:${presetIdx}` (ROI/프리셋 매칭). */
export function presetKey(camIdx, presetIdx) {
  return `${camIdx}:${presetIdx}`;
}

/**
 * slot 라벨: globalIndex 에서 slotId 매칭 시 globalIdx, 없으면 slotId 폴백(G3-4).
 * globalIndex: Array<{ globalIdx, slotId, ... }>.
 */
export function slotLabel(slotId, globalIndex) {
  const hit = (globalIndex ?? []).find((g) => g.slotId === slotId);
  return hit ? String(hit.globalIdx) : slotId;
}

/** fps → setInterval 간격(ms). fps=3 → 333. */
export function fpsToInterval(fps) {
  return Math.round(1000 / fps);
}

/** zoom 클램프(1~36). */
export function clampZoom(z, min = ZOOM_MIN, max = ZOOM_MAX) {
  return Math.min(max, Math.max(min, z));
}

/**
 * 방향/스텝 → 절대 PTZ 환산. dir ∈ {'up','down','left','right','zoomIn','zoomOut'}.
 * pan/tilt·zoom 모두 ±step(zoom 은 clampZoom 1~36). step 입력값이 배율 증분을 결정한다.
 */
export function stepPtz(cur, dir, step) {
  const next = { pan: cur.pan, tilt: cur.tilt, zoom: cur.zoom };
  switch (dir) {
    case 'left':
      next.pan = cur.pan - step;
      break;
    case 'right':
      next.pan = cur.pan + step;
      break;
    case 'up':
      next.tilt = cur.tilt + step;
      break;
    case 'down':
      next.tilt = cur.tilt - step;
      break;
    case 'zoomIn':
      next.zoom = clampZoom(cur.zoom + step);
      break;
    case 'zoomOut':
      next.zoom = clampZoom(cur.zoom - step);
      break;
    default:
      break;
  }
  return next;
}

/**
 * 절대 이동 입력값(문자열) → PTZ. 빈 칸/비수치는 현재 PTZ 를 유지한다(0/1 로 리셋하지 않음).
 * 버그 수정: 기존 인라인 핸들러는 `Number('')||0`, `...||1` 로 빈 칸을 pan/tilt=0·zoom=1 로 강제 리셋해,
 * zoom 만 채우면 pan/tilt 가 0 으로 튀고 zoom 만 비우면 배율이 1(최광각)로 돌아갔다.
 * raw = { pan, tilt, zoom } 입력창 문자열. zoom 은 clampZoom(1~36) 적용.
 */
export function resolveAbsPtz(cur, raw) {
  const pick = (s, fallback) => {
    const t = (s ?? '').trim();
    if (t === '') return fallback;
    const n = Number(t);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    pan: pick(raw.pan, cur.pan),
    tilt: pick(raw.tilt, cur.tilt),
    zoom: clampZoom(pick(raw.zoom, cur.zoom)),
  };
}

/**
 * 정밀 수집 진행률(설계서 §7.2). done/planned → { percent, label }. 0 division 방어.
 * status: { state, round, done, planned, runId? }.
 */
export function captureProgress(status) {
  const planned = Number(status?.planned ?? 0);
  const done = Number(status?.done ?? 0);
  const percent = planned > 0 ? Math.min(100, Math.round((done / planned) * 100)) : 0;
  const state = status?.state ?? 'idle';
  const label = `${state} ${done}/${planned} (${percent}%)`;
  return { percent, label };
}

/**
 * 체크포인트 자문 매핑(표시 문자열 배열). status.latestAdvisory(서버 산출) 우선,
 * 없으면 빈 배열. (서버 advisoryLines 결과를 그대로 표시 — UI 는 얇게 유지.)
 */
export function mapAdvisory(status) {
  const adv = status?.latestAdvisory;
  return Array.isArray(adv) ? adv.slice() : [];
}

/**
 * 폴링 계획(설계서 §7.2). running/stopping 중에만 폴링 계속(간격 ms).
 * → { poll: boolean, intervalMs }.
 */
export function pollPlan(state, intervalMs = 2000) {
  const poll = state === 'running' || state === 'stopping' || state === 'finalizing';
  return { poll, intervalMs };
}

/**
 * 정밀수집 상태 → 버튼/안내 UI 의도(순수). 백엔드 라우트 거부 조건과 대칭:
 *   - stop 은 running 에서만 허용(그 외 stopDisabled=true — 400 `not running` 대칭).
 *   - start/finalize 는 active(running/stopping/finalizing) 중 금지(중복 start·409 finalize 대칭).
 * suppressFrameMsg: stopping 중 프레임틱이 cap-msg 를 덮지 않게. stoppingNote: '정지 중…' 안내 표시.
 * state ∈ idle/running/stopping/finalizing/done/stopped/error.
 */
export function captureUiState(state) {
  const active = state === 'running' || state === 'stopping' || state === 'finalizing';
  return {
    startDisabled: active,
    stopDisabled: state !== 'running',
    finalizeDisabled: active,
    suppressFrameMsg: state === 'stopping',
    stoppingNote: state === 'stopping',
  };
}

/**
 * 앞면중심 LOOP discovery 상태(/discover/status) → UI 뷰(순수). 진행바 percent·라벨·실행버튼 disable·프레임폴 여부.
 * calPoll 의 인라인 계산(percent/label/폴게이트)을 순수화해 vitest 로 커버. status: { state, done, total, found }.
 * running 에서만 실행버튼 disable·프레임폴(pollPlan 과 정합). total 0 → percent 0(0나눗셈 방어).
 */
export function discoverView(status) {
  const st = status?.state ?? 'idle';
  const done = status?.done ?? 0;
  const total = status?.total ?? 0;
  const found = status?.found ?? 0;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const running = st === 'running';
  return {
    percent,
    label: `${st} ${done}/${total} (found ${found})`,
    runDisabled: running,
    polling: running,
  };
}

/**
 * 옵션(설정) 폼 클라이언트 검증(순수). 백엔드 zod(VpdSchema/LpdSchema/LlmSchema)와 동일 규칙의 사전 검증 —
 * 저장 전에 형식 오류를 즉시 안내한다(권위 검증은 서버). form={ llm:{provider,model,baseUrl}, vpd:{endpoint,detPath}, lpd:{endpoint,detPath} }.
 * → 오류 메시지 문자열 배열(빈 배열이면 통과). URL 은 http/https 만 허용(zod .url() 근사).
 */
export function settingsFormErrors(form) {
  const errors = [];
  const hasProtocol = (s, protocols) => {
    try {
      const u = new URL(String(s));
      return protocols.includes(u.protocol);
    } catch {
      return false;
    }
  };
  const isHttpUrl = (s) => hasProtocol(s, ['http:', 'https:']);
  if (!String(form?.llm?.model ?? '').trim()) errors.push('LLM model 필수');
  if (!isHttpUrl(form?.llm?.baseUrl)) errors.push('LLM Base URL 형식 오류(http/https)');
  if (!isHttpUrl(form?.vpd?.endpoint)) errors.push('VPD endpoint 형식 오류(http/https)');
  if (!isHttpUrl(form?.lpd?.endpoint)) errors.push('LPD endpoint 형식 오류(http/https)');
  if (!String(form?.vpd?.detPath ?? '').startsWith('/')) errors.push('VPD detPath 는 / 로 시작');
  if (!String(form?.lpd?.detPath ?? '').startsWith('/')) errors.push('LPD detPath 는 / 로 시작');
  if (form?.camera) {
    if (form.camera.executionMode !== 'typescript-native') errors.push('카메라 실행 모드는 TypeScript Native만 지원');
    if (!String(form.camera.selectedCameraId ?? '').trim()) errors.push('사용 카메라 선택 필수');
    const source = form.camera.source;
    if (!source || source.id !== form.camera.selectedCameraId) errors.push('선택 카메라 정보 불일치');
    if (!String(source?.label ?? '').trim()) errors.push('카메라 표시 이름 필수');
    if (!isHttpUrl(source?.baseUrl)) errors.push('카메라 제어 URL 형식 오류(http/https)');
    const rtsp = String(source?.rtspUrl ?? '').trim();
    if (source?.kind === 'hucoms' && !rtsp) errors.push('실카메라 RTSP URL 필수');
    if (source?.kind === 'hucoms' && rtsp && !hasProtocol(rtsp, ['rtsp:', 'rtsps:'])) {
      errors.push('실카메라 RTSP URL 형식 오류(rtsp/rtsps)');
    } else if (rtsp && !hasProtocol(rtsp, ['rtsp:', 'rtsps:', 'http:', 'https:'])) {
      errors.push('RTSP URL 형식 오류(rtsp/rtsps/http/https)');
    }
    if (rtsp) {
      try {
        const url = new URL(rtsp);
        if (url.username || url.password) errors.push('RTSP URL 계정은 관리자 ID/Password 입력란에 분리');
      } catch {
        /* 형식 오류는 위에서 보고 */
      }
    }
  }
  return errors;
}

/**
 * 카메라 타입(kind) 전환 시 protocol 을 kind 계열에 맞춰 정합한다(순수).
 * 런타임 소스 선택(sourceRegistry): sim+unity-rpc→RPC, sim+그외→REST, hucoms→RealPtz(protocol 무시).
 * - hucoms → 'hucoms-v1.22'(유일 옵션).
 * - sim → 기존이 unity 계열('unity-rpc'|'unity-rest')이면 유지(RPC/REST 선택 보존), 아니면 'unity-rpc'(기본 RPC 경로).
 * sim 이면서 이미 unity 계열이면 무변경 → 실제 kind 전환(hucoms↔sim) 때만 바뀐다. 멱등.
 */
export function alignProtocolToKind(kind, protocol) {
  if (kind === 'hucoms') return 'hucoms-v1.22';
  return protocol === 'unity-rpc' || protocol === 'unity-rest' ? protocol : 'unity-rpc';
}

/**
 * 정밀수집 라이브 프레임의 유일 키(cam:preset:round). 최신 캡처 1건을 식별.
 * 직전 키와 같으면(라운드 사이 대기 중 동일 프레임) 재디코드를 스킵하는 데 쓴다.
 * 인자가 모두 null/undefined 면 null(식별 불가 → 스킵하지 않음).
 */
export function capFrameKey(cam, preset, round) {
  if (cam == null && preset == null && round == null) return null;
  return `${cam ?? ''}:${preset ?? ''}:${round ?? ''}`;
}

/** 컨트롤 패널 드래그 리사이즈 폭 클램프(px → [min,max] 정수). */
export function clampPanelWidth(px, min = 260, max = 720) {
  return Math.min(max, Math.max(min, Math.round(px)));
}

/**
 * 정밀 수집 경과 시간(ms). startedAt~(endedAt 또는 now). 없으면 null.
 * 종료(endedAt) 후엔 총 소요로 고정.
 */
export function captureElapsedMs(status, nowMs) {
  if (!status || !status.startedAt) return null;
  const start = Date.parse(status.startedAt);
  if (Number.isNaN(start)) return null;
  const endParsed = status.endedAt ? Date.parse(status.endedAt) : nowMs;
  const end = Number.isNaN(endParsed) ? nowMs : endParsed;
  return Math.max(0, end - start);
}

/** ms → 경과 표기. 1시간 미만 "M:SS", 이상 "H:MM:SS". */
export function formatElapsed(ms) {
  const s = Math.floor((ms ?? 0) / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return hh > 0 ? `${hh}:${p(mm)}:${p(ss)}` : `${mm}:${p(ss)}`;
}

/**
 * 정밀 수집 종료 결과 요약(메시지 박스용). state 별 제목 + 결과 라인 배열.
 * status: { state, runId?, done, planned, startedAt?, endedAt? }.
 */
export function captureResultSummary(status, nowMs) {
  const st = status?.state ?? 'idle';
  const title =
    st === 'done' ? '정밀 수집 완료' :
    st === 'stopped' ? '정밀 수집 정지됨' :
    st === 'error' ? '정밀 수집 오류' : '정밀 수집 종료';
  const lines = [];
  if (status?.runId != null) lines.push(`수집 #${status.runId}`);
  lines.push(`완료 라운드: ${status?.done ?? 0} / ${status?.planned ?? 0}`);
  const ms = captureElapsedMs(status, nowMs);
  if (ms != null) lines.push(`소요 시간: ${formatElapsed(ms)}`);
  lines.push("'최종화'를 누르면 누적 결과로 주차면(ROI)이 그려집니다.");
  return { title, lines };
}

/**
 * 카메라 목록에서 (camIdx, presetIdx) 프리셋의 PTZ 조회.
 * pan/tilt/zoom 이 모두 있으면 { pan, tilt, zoom }, 아니면 null(→ 호출측 폴백).
 * '프리셋 이동' 이 현재 모드와 무관하게 프리셋 위치로 가게 하는 근거값.
 */
export function findPresetPtz(cameras, camIdx, presetIdx) {
  const cam = (cameras ?? []).find((c) => c.camIdx === camIdx);
  const preset = (cam?.presets ?? []).find((p) => p.presetIdx === presetIdx);
  if (preset && preset.pan != null && preset.tilt != null && preset.zoom != null) {
    return { pan: preset.pan, tilt: preset.tilt, zoom: preset.zoom };
  }
  return null;
}

/**
 * 최종 셋업 산출물(SetupArtifact) 분석 요약(순수). '분석' 탭 렌더용.
 * artifact: { presets, slots, globalIndex, createdAt?, warnings?, report? } | null.
 * slots 는 globalIdx 오름차순 정렬, presetKey/roi/번호판 보유 여부를 평탄화한다.
 */
export function analyzeArtifact(artifact) {
  const empty = { cameras: 0, presets: 0, slots: 0, globalSlots: 0, withPlate: 0, withFloor: 0, warnings: 0, zones: 0 };
  if (!artifact || typeof artifact !== 'object') {
    return { ok: false, createdAt: null, totals: empty, perPreset: [], slots: [], warnings: [], report: '' };
  }
  const presets = Array.isArray(artifact.presets) ? artifact.presets : [];
  const rawSlots = Array.isArray(artifact.slots) ? artifact.slots : [];
  const globalIndex = Array.isArray(artifact.globalIndex) ? artifact.globalIndex : [];
  const warnings = Array.isArray(artifact.warnings) ? artifact.warnings : [];

  const gidBySlot = new Map(globalIndex.map((g) => [g.slotId, g.globalIdx]));
  const zones = new Set();
  let withPlate = 0;
  let withFloor = 0;

  const slots = rawSlots.map((s) => {
    const presetKey = Object.keys(s.roiByPreset ?? {})[0] ?? '';
    const roi = (s.roiByPreset ?? {})[presetKey] ?? null;
    const hasPlate = !!(s.plateRoiByPreset && Object.keys(s.plateRoiByPreset).length);
    const hasFloor = !!(s.floorRoiByPreset && Object.keys(s.floorRoiByPreset).length);
    if (hasPlate) withPlate += 1;
    if (hasFloor) withFloor += 1;
    if (s.zone) zones.add(s.zone);
    return {
      globalIdx: gidBySlot.has(s.slotId) ? gidBySlot.get(s.slotId) : null,
      slotId: s.slotId,
      zone: s.zone ?? '',
      presetKey,
      roi,
      hasPlate,
      hasFloor,
    };
  });
  slots.sort((a, b) => (a.globalIdx ?? Infinity) - (b.globalIdx ?? Infinity));

  const cameras = new Set(presets.map((p) => p.camIdx));
  const perPreset = presets.map((p) => ({
    key: `${p.camIdx}:${p.presetIdx}`,
    camIdx: p.camIdx,
    presetIdx: p.presetIdx,
    label: p.label ?? `${p.camIdx}:${p.presetIdx}`,
    slotCount: Array.isArray(p.coveredSlotIds) ? p.coveredSlotIds.length : 0,
  }));

  return {
    ok: true,
    createdAt: artifact.createdAt ?? null,
    totals: {
      cameras: cameras.size,
      presets: presets.length,
      slots: rawSlots.length,
      globalSlots: globalIndex.length,
      withPlate,
      withFloor,
      warnings: warnings.length,
      zones: zones.size,
    },
    perPreset,
    slots,
    warnings,
    report: artifact.report ?? '',
  };
}

// ===== 정밀수집 차량 점유율(occupancy) 표시용 순수 로직 =====

/**
 * 점유율(0~1) → 'NN%'. null/NaN/비수치 → '0%'.
 */
export function formatRatePct(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n)) return '0%';
  return `${Math.round(n * 100)}%`;
}

/**
 * `GET /capture/occupancy` 결과 rows[] → cam:preset 키 맵.
 * rows 원소: { camIdx, presetIdx, occupiedCount, total, rate, spacesJson(string|null), ... }.
 * spacesJson 은 문자열 → JSON.parse(실패/null → 빈 배열로 graceful 강등, throw 안 함).
 * spaces 요소: { id, occupied, polygon? }(polygon optional — 미보유 요소도 그대로 통과, 오버레이가 skip).
 */
export function occupancyByKey(rows) {
  const out = {};
  for (const r of rows ?? []) {
    let spaces = [];
    if (typeof r.spacesJson === 'string') {
      try {
        const parsed = JSON.parse(r.spacesJson);
        if (Array.isArray(parsed)) spaces = parsed;
      } catch {
        spaces = []; // 파싱 실패 → 빈 spaces(백엔드 UNKNOWN 강등 철학과 정합).
      }
    }
    out[presetKey(r.camIdx, r.presetIdx)] = {
      camIdx: r.camIdx,
      presetIdx: r.presetIdx,
      occupiedCount: r.occupiedCount,
      total: r.total,
      rate: r.rate,
      spaces,
    };
  }
  return out;
}

/**
 * 점유율 맵 → 표 rows. cam→preset ASC 정렬. 각 행 [key, camIdx, presetIdx, occupiedCount, total, 'NN%'].
 */
export function occupancyRows(occByKey) {
  return Object.entries(occByKey ?? {})
    .map(([key, o]) => [key, o.camIdx, o.presetIdx, o.occupiedCount, o.total, formatRatePct(o.rate)])
    .sort((a, b) => a[1] - b[1] || a[2] - b[2]);
}

/**
 * 전체 평균 점유율. ΣoccupiedCount / Σtotal. 빈 입력·0분모 → { occupied:0, total:0, rate:0 }.
 */
export function occupancyAverage(occByKey) {
  let occupied = 0;
  let total = 0;
  for (const o of Object.values(occByKey ?? {})) {
    occupied += Number(o.occupiedCount) || 0;
    total += Number(o.total) || 0;
  }
  return { occupied, total, rate: total > 0 ? occupied / total : 0 };
}

// ===== 미리 정의된 주차면 폴리곤(PtzCamRoi.json) 정규화 순수 로직 =====

/**
 * `GET /capture/place-roi` raw JSON(PtzCamRoi.json) → 프리셋별 정규화 폴리곤 + 검수 리포트.
 * 입력 shape: { cameras:[{ camera:{ cam_id, imageWidth, imageHeight }, presets:[{ preset_idx, parking_spaces:[{ idx, points:[[x,y]...] }] }] }] }.
 * 반환:
 *   byPreset: { "<camId>:<presetIdx>": [ { idx, points:[{x,y}...] } ] }  // points 는 이미지 크기로 정규화(0..1)
 *   report:   [ { camId, presetIdx, spaceCount, issues:[문자열] } ]       // 프리셋별 검수
 * throw 금지(방어적) — malformed 입력도 부분 결과 + issues 로 강등. cam_id↔camIdx, preset_idx↔presetIdx 동일 1-based.
 */
export function normalizePtzCamRoi(json) {
  const byPreset = {};
  const report = [];
  if (!json || typeof json !== 'object') return { byPreset, report };
  const cameras = Array.isArray(json.cameras) ? json.cameras : [];
  for (const camEntry of cameras) {
    const cam = camEntry?.camera;
    const camId = cam?.cam_id;
    const W = Number(cam?.imageWidth);
    const H = Number(cam?.imageHeight);
    const sizeOk = !!cam && Number.isFinite(W) && Number.isFinite(H) && W > 0 && H > 0;
    const presets = Array.isArray(camEntry?.presets) ? camEntry.presets : [];
    for (const preset of presets) {
      const presetIdx = preset?.preset_idx;
      const rawSpaces = Array.isArray(preset?.parking_spaces) ? preset.parking_spaces : [];
      const issues = [];
      if (camId == null) issues.push('cam_id 누락');
      if (presetIdx == null) issues.push('preset_idx 누락');
      if (!sizeOk) issues.push('이미지 크기 누락/오류');
      if (!Array.isArray(preset?.parking_spaces) || rawSpaces.length === 0) issues.push('주차면 없음');

      const normSpaces = [];
      for (const sp of rawSpaces) {
        const idx = sp?.idx;
        if (idx == null) { issues.push('idx 누락'); continue; }
        const rawPts = sp?.points;
        if (!Array.isArray(rawPts)) { issues.push(`idx ${idx}: points 누락`); continue; }
        if (rawPts.length !== 4) issues.push(`idx ${idx}: 점 4개 아님(${rawPts.length}개)`);
        const pts = rawPts.map((p) => ({
          x: Array.isArray(p) ? Number(p[0]) : Number(p?.x),
          y: Array.isArray(p) ? Number(p[1]) : Number(p?.y),
        }));
        if (!sizeOk) continue; // 정규화 불가 → 이미 '이미지 크기 누락/오류' 기록, byPreset 미기록.
        const outOfRange = pts.some(
          (p) => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > W || p.y < 0 || p.y > H,
        );
        if (outOfRange) issues.push(`idx ${idx}: 좌표 범위 이탈`);
        normSpaces.push({ idx, points: pts.map((p) => ({ x: p.x / W, y: p.y / H })) });
      }

      report.push({ camId, presetIdx, spaceCount: rawSpaces.length, issues });
      if (sizeOk && normSpaces.length) byPreset[presetKey(camId, presetIdx)] = normSpaces;
    }
  }
  return { byPreset, report };
}

/**
 * 정밀수집 바닥(floor) ROI 소스 선택(순수). 토글(useLlm)에 따라 현재 프리셋(key)의 바닥 폴리곤을 반환.
 *   - useLlm===false(파일 모드): placeRoi[key] 의 각 면({idx,points})을 { quad:points, label:String(idx) } 로.
 *     프리셋 단위(슬롯/클러스터 없음) — 파일 ROI 를 바닥 실데이터로 승격(R1/R4).
 *   - useLlm===true(LLM 모드): slots[].floorRoiByPreset[key] 보유분을 { quad, label:'', slotId } 로(기존 슬롯별 floor).
 * throw 금지 — placeRoi/slots 누락 시 { source, polygons:[] }(graceful).
 * args: { useLlm, slots, placeRoi, key }.
 */
export function selectFloorRoi({ useLlm, slots, placeRoi, key }) {
  if (useLlm) {
    const polygons = [];
    for (const slot of slots ?? []) {
      const quad = slot?.floorRoiByPreset?.[key];
      if (quad) polygons.push({ quad, label: '', slotId: slot.slotId });
    }
    return { source: 'llm', polygons };
  }
  const spaces = placeRoi?.[key] ?? [];
  const polygons = spaces.map((sp) => ({ quad: sp.points, label: String(sp.idx), idx: sp.idx })); // idx: 선택 하이라이트용(R4).
  return { source: 'file', polygons };
}

/** 4점 quad 의 산술 평균 중심(면적가중 아님 — 번호판 근사 중심으로 충분, R4). quad 미보유/4점 아니면 null. */
export function quadCentroid(quad) {
  if (!Array.isArray(quad) || quad.length !== 4) return null;
  let sx = 0;
  let sy = 0;
  for (const p of quad) {
    if (typeof p?.x !== 'number' || typeof p?.y !== 'number') return null;
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / 4, y: sy / 4 };
}

/**
 * 로직 점유 판정(순수, R4/R5). 각 바닥 폴리곤(floorPolygons)에 대해 어떤 번호판(plates) 중심이
 * 그 폴리곤 내부(pointInQuad 재사용)면 occupied=true, center=그 번호판 중심(첫 매칭).
 * floorPolygons: [{ idx, quad:[{x,y}×4] }] — 현재 프리셋 파일 바닥ROI.
 * plates: [{ quad:[{x,y}×4] }] — LPD 번호판 OBB(여러 소스 합집합, 호출측이 구성).
 * 반환: [{ idx, occupied, center?, plateQuad? }] (center/plateQuad 는 occupied 일 때만).
 * throw 금지 — floorPolygons/plates 누락·비배열 시 []( graceful, 강등 철학).
 */
export function computeOccupancy(floorPolygons, plates) {
  if (!Array.isArray(floorPolygons)) return [];
  const cands = (Array.isArray(plates) ? plates : [])
    .map((p) => ({ center: quadCentroid(p?.quad), quad: p?.quad }))
    .filter((c) => c.center !== null);
  return floorPolygons.map((f) => {
    const hit = cands.find((c) => pointInQuad(c.center.x, c.center.y, f.quad));
    return hit
      ? { idx: f.idx, occupied: true, center: hit.center, plateQuad: hit.quad }
      : { idx: f.idx, occupied: false };
  });
}

// ===== 전체 주차면 목록 · 전역 인덱스(PtzCamRoi.idx) 순수 로직(R2/R3/R4) =====
// placeRoi = { "cam:preset": [{ idx, points }] }. idx = 파일 전체에서 고유한 '전역 인덱스'(1..N).
// 프리셋내 인덱스는 배열 위치로만 표현(PtzCamRoi.json 스키마 무변경).

/** placeRoi 를 (cam asc → preset asc → 배열순)으로 나열: [{ key, cam, preset, pos, space }]. 내부 헬퍼. */
function flattenPlaceRoi(placeRoi) {
  const items = [];
  if (!placeRoi || typeof placeRoi !== 'object') return items;
  const keys = Object.keys(placeRoi).sort((a, b) => {
    const [ca, pa] = a.split(':').map(Number);
    const [cb, pb] = b.split(':').map(Number);
    return ca - cb || pa - pb;
  });
  for (const key of keys) {
    const [cam, preset] = key.split(':').map(Number);
    const spaces = Array.isArray(placeRoi[key]) ? placeRoi[key] : [];
    spaces.forEach((space, pos) => items.push({ key, cam, preset, pos, space }));
  }
  return items;
}

/**
 * 전역 순서(items 배열 순)대로 idx 를 1..N 재부여해 placeRoi 재조립(불변). 내부 헬퍼.
 * 프리셋내 배열 순서는 원래 파일 순서(pos)를 유지하고 idx 값만 갱신 → 프리셋 소속·좌표 불변.
 * 원본의 모든 키를 보존(빈 프리셋도 [] 로 유지 — 저장 시 빈 배열 PUT 이 필요).
 */
function assemblePlaceRoi(keys, items) {
  const buckets = {};
  for (const key of keys) buckets[key] = [];
  items.forEach((it, i) => buckets[it.key]?.push({ pos: it.pos, space: it.space, idx: i + 1 }));
  const out = {};
  for (const key of keys) {
    out[key] = buckets[key]
      .sort((a, b) => a.pos - b.pos)
      .map((e) => ({ ...e.space, idx: e.idx }));
  }
  return out;
}

/** 현재 idx 오름차순으로 정렬한 전역 시퀀스(idx 는 1..N 고유 전제 — normalizeGlobalIdx 통과분). 내부 헬퍼. */
function orderedByIdx(placeRoi) {
  return flattenPlaceRoi(placeRoi).sort((a, b) => a.space.idx - b.space.idx);
}

/**
 * 전역 인덱스 정규화(R3 마이그레이션). idx 집합이 정확히 1..N 의 순열이면 **손대지 않는다**
 * (사용자가 재지정한 번호 보존). 중복·누락·0 이하·비정수가 있으면 (cam asc → preset asc → 배열순)
 * 기준으로 1..N 재부여. Unity 재생성으로 프리셋별 0-based 로 리셋돼도 graceful 재부여.
 * 반환: { placeRoi, changed, issues[] }. throw 금지 — null/빈 입력 → { placeRoi:{}, changed:false, issues:[] }.
 */
export function normalizeGlobalIdx(placeRoi) {
  const items = flattenPlaceRoi(placeRoi);
  const keys = Object.keys(placeRoi ?? {});
  const n = items.length;
  const issues = [];
  const seen = new Set();
  for (const it of items) {
    const idx = it.space?.idx;
    if (!Number.isInteger(idx) || idx < 1 || idx > n) {
      issues.push(`cam${it.cam}:${it.preset} idx ${idx} — 1..${n} 범위의 정수 아님`);
    } else if (seen.has(idx)) {
      issues.push(`idx ${idx} 중복(cam${it.cam}:${it.preset})`);
    } else {
      seen.add(idx);
    }
  }
  if (!issues.length && seen.size === n) return { placeRoi: placeRoi ?? {}, changed: false, issues };
  return { placeRoi: assemblePlaceRoi(keys, items), changed: n > 0, issues };
}

/**
 * 전역 인덱스 재지정(R4 '수정'). 전역 시퀀스(1..N)에서 fromIdx 를 뽑아 toIdx 위치에 삽입 후 1..N 재부여
 * (충돌 시 나머지를 밀어 연속 유지). 프리셋 소속·좌표 불변. 불변(새 객체).
 * fromIdx 부재 / toIdx 비수치 / from===to → 원본 그대로. toIdx 는 1..N 으로 clamp.
 */
export function reindexPlaceSpace(placeRoi, fromIdx, toIdx) {
  const ordered = orderedByIdx(placeRoi);
  const n = ordered.length;
  const at = ordered.findIndex((it) => it.space?.idx === fromIdx);
  const target = Number(toIdx);
  if (at < 0 || !Number.isFinite(target)) return placeRoi ?? {};
  const to = Math.min(Math.max(Math.round(target), 1), n);
  if (to === fromIdx) return placeRoi ?? {};
  const [moved] = ordered.splice(at, 1);
  ordered.splice(to - 1, 0, moved);
  return assemblePlaceRoi(Object.keys(placeRoi ?? {}), ordered);
}

/**
 * 주차면 삭제(R4 '삭제'). 해당 전역 인덱스를 제거하고 남은 전부를 상대순서 유지한 채 1..N 재압축.
 * 없는 idx → 원본 그대로. 프리셋이 비어도 키는 [] 로 유지. 불변(새 객체).
 */
export function removePlaceSpace(placeRoi, idx) {
  const ordered = orderedByIdx(placeRoi);
  const at = ordered.findIndex((it) => it.space?.idx === idx);
  if (at < 0) return placeRoi ?? {};
  ordered.splice(at, 1);
  return assemblePlaceRoi(Object.keys(placeRoi ?? {}), ordered);
}

/**
 * 전체 주차면 평면 목록(R2). 전 카메라·전 프리셋을 하나의 목록으로 전역 인덱스 오름차순 산출.
 * - 점유: judge(OccupancyJudge) 주입 시 그 판정기로 산출 — 실소비처(app.js)는 주입해 오버레이와
 *   같은 기준(차량 접지 귀속)을 쓴다. 미전달 시 computeOccupancy(번호판 중심) 기본 경로(하위호환).
 *   occupancy.js→core.js 단방향 의존을 지키려 import 대신 주입으로 받는다.
 * - parkingSlotsByKey(최종화 후 DB parking_slots)에 slotIdx===globalIdx 행이 있으면 그 행의
 *   occupied/vpd/lpd 를 우선 사용(DB 태그 보존). 단 그 프리셋의 DB 행 전체가 파일 전역번호 체계와
 *   일치할 때만 채택 — 구 run(프리셋별 0-based) 처럼 다른 체계면 통째 기각(부분 겹침 오귀속 방지).
 * 반환: [{ globalIdx, cam, preset, key, occupied, vpd, lpd }] — globalIdx 오름차순.
 * throw 금지 — placeRoi null/빈 → [](graceful).
 */
export function buildFlatSlotRows({ placeRoi, detectByKey, parkingSlotsByKey, judge }) {
  if (!placeRoi || typeof placeRoi !== 'object') return [];
  const rows = [];
  for (const key of Object.keys(placeRoi)) {
    const [cam, preset] = key.split(':').map(Number);
    const spaces = Array.isArray(placeRoi[key]) ? placeRoi[key] : [];
    const detect = detectByKey?.[key];
    const floorPolys = spaces.map((sp) => ({ idx: sp.idx, quad: sp.points }));
    const occRows = judge
      ? judge.judge(floorPolys, detect)
      : computeOccupancy(floorPolys, [
          ...(detect?.plates ?? []),
          ...(detect?.vehicles ?? []).map((v) => v.plate).filter(Boolean),
        ]);
    const occById = new Map(occRows.map((o) => [o.idx, o.occupied]));
    const dbRows = parkingSlotsByKey?.[key] ?? [];
    // slot_setup 정본(SlotSetupView): slotId=전역번호, vpd/lpd=객체|null(구 slotIdx/occupied 대체, 설계서 §3).
    // DB 행 집합이 파일 전역번호 체계와 완전히 일치할 때만 태그 채택(구 0-based run 혼입 시 통째 기각 → 파일 계산 폴백).
    const fileIdx = new Set(spaces.map((sp) => sp.idx));
    const usable = dbRows.length > 0 && dbRows.every((r) => fileIdx.has(r.slotId)) ? dbRows : [];
    for (const sp of spaces) {
      const db = usable.find((r) => r.slotId === sp.idx);
      rows.push({
        globalIdx: sp.idx,
        cam,
        preset,
        key,
        // slot_setup 은 점유상태(occupied)를 저장하지 않는다(→ parking_evnt/ActionAgent). 배정 차량 bbox(vpd) 유무로 점유 표시.
        occupied: db ? !!db.vpd : occById.get(sp.idx) ?? false,
        vpd: !!db?.vpd,
        lpd: !!db?.lpd,
      });
    }
  }
  return rows.sort((a, b) => a.globalIdx - b.globalIdx);
}

// ===== 주차면(ROI) 편집 + 전역 인덱스 수동 매핑 순수 로직(#1~#4, #7) =====

/**
 * #4 진단: 산출물(artifact)의 presetKey 집합과 카메라 드롭다운(cameras)의 presetKey 집합을 비교.
 * → { artifactOnly, camerasOnly }. artifactOnly = 산출물엔 있으나 드롭다운에 없어 선택 불가(=미표시 원인).
 * cameras: Array<{ camIdx, presets: Array<{ presetIdx }> }>. artifact: { presets: [{ camIdx, presetIdx }] }.
 */
export function diffArtifactVsCameras(artifact, cameras) {
  const artKeys = new Set(
    (artifact?.presets ?? []).map((p) => presetKey(p.camIdx, p.presetIdx)),
  );
  const camKeys = new Set();
  for (const c of cameras ?? []) {
    for (const p of c?.presets ?? []) camKeys.add(presetKey(c.camIdx, p.presetIdx));
  }
  const artifactOnly = [...artKeys].filter((k) => !camKeys.has(k));
  const camerasOnly = [...camKeys].filter((k) => !artKeys.has(k));
  return { artifactOnly, camerasOnly };
}

/** #1 히트테스트: 정규화 점(nx,ny)이 사각형 rect{x,y,w,h} 내부인지(경계 포함). */
export function pointInRect(nx, ny, rect) {
  if (!rect) return false;
  return nx >= rect.x && nx <= rect.x + rect.w && ny >= rect.y && ny <= rect.y + rect.h;
}

/** #1 히트테스트: 정규화 점이 4점 다각형(quad) 내부인지(ray casting, 짝수-홀수). */
export function pointInQuad(nx, ny, quad) {
  if (!Array.isArray(quad) || quad.length < 3) return false;
  let inside = false;
  for (let i = 0, j = quad.length - 1; i < quad.length; j = i++) {
    const xi = quad[i].x, yi = quad[i].y;
    const xj = quad[j].x, yj = quad[j].y;
    const intersect = yi > ny !== yj > ny && nx < ((xj - xi) * (ny - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * #1 슬롯 히트테스트. 현재 프리셋 key 의 차량 ROI(rect) 우선, 그 다음 floor quad(차선).
 * 그려지는 순서(slots 배열 순)에서 마지막(=상단)에 그려진 것을 우선 선택.
 * layers: { vehicle, floor } — 끔 처리된 레이어는 히트 제외(현재 그리는 것과 정합).
 * → 매칭 slotId | null.
 */
export function hitTestSlots({ nx, ny, slots, key, layers }) {
  const showVehicle = layers?.vehicle !== false;
  const showFloor = layers?.floor !== false;
  let hit = null;
  for (const slot of slots ?? []) {
    if (showVehicle && pointInRect(nx, ny, slot.roiByPreset?.[key])) {
      hit = slot.slotId;
      continue;
    }
    if (showFloor && pointInQuad(nx, ny, slot.floorRoiByPreset?.[key])) {
      hit = slot.slotId;
    }
  }
  return hit;
}

/**
 * #2/#3 공용: coveredSlotIds 순서를 position 진실로 globalIndex 재생성(설계 §positionIdx).
 * slotId 의 sN 파싱 금지 — preset.coveredSlotIds 배열 순서가 프리셋 내 위치(position).
 * 정렬: camIdx ASC → presetIdx ASC → coveredSlotIds 내 위치 ASC. globalIdx=i+1.
 * coveredSlotIds 에 없는 slot 은 뒤로(안전망). → GlobalSlotIndex[].
 */
export function rebuildGlobalIndex(slots, presets) {
  const slotSet = new Set((slots ?? []).map((s) => s.slotId));
  const ordered = [];
  const sortedPresets = [...(presets ?? [])].sort(
    (a, b) => a.camIdx - b.camIdx || a.presetIdx - b.presetIdx,
  );
  const placed = new Set();
  for (const p of sortedPresets) {
    for (const id of p.coveredSlotIds ?? []) {
      if (slotSet.has(id) && !placed.has(id)) {
        placed.add(id);
        ordered.push({ slotId: id, camIdx: p.camIdx, presetIdx: p.presetIdx });
      }
    }
  }
  // coveredSlotIds 에 없는 slot(안전망): slotId 순으로 뒤에 부여. camIdx/presetIdx 는 미상→0.
  for (const s of slots ?? []) {
    if (!placed.has(s.slotId)) {
      placed.add(s.slotId);
      ordered.push({ slotId: s.slotId, camIdx: 0, presetIdx: 0 });
    }
  }
  return ordered.map((o, i) => ({
    globalIdx: i + 1,
    slotId: o.slotId,
    camIdx: o.camIdx,
    presetIdx: o.presetIdx,
  }));
}

/**
 * #2 삭제: slotId 슬롯을 slots·각 preset.coveredSlotIds 에서 제거 후 globalIndex 재구성.
 * createdAt 등 나머지 필드 보존. 불변(새 artifact 반환).
 */
export function removeSlot(artifact, slotId) {
  const slots = (artifact.slots ?? []).filter((s) => s.slotId !== slotId);
  const presets = (artifact.presets ?? []).map((p) => ({
    ...p,
    coveredSlotIds: (p.coveredSlotIds ?? []).filter((id) => id !== slotId),
  }));
  const globalIndex = rebuildGlobalIndex(slots, presets);
  return { ...artifact, slots, presets, globalIndex };
}

/**
 * 결번 충돌회피 slotId 생성. (camIdx,presetIdx) 의 기존 sN 최대치+1 부터 시작,
 * 전체 slotId 집합과 충돌 없을 때까지 증가시켜 반환. 형식 `c{cam}p{preset}s{N}`.
 * 근거: 삭제로 s2 결번 시 length+1 은 기존 s3 와 충돌 → 최대 sN 파싱 후 +1, 이후 집합 검사로 bump.
 */
export function nextSlotId(artifact, camIdx, presetIdx) {
  const all = new Set((artifact?.slots ?? []).map((s) => s.slotId));
  const prefix = `c${camIdx}p${presetIdx}s`;
  let max = 0;
  for (const id of all) {
    if (typeof id === 'string' && id.startsWith(prefix)) {
      const n = Number(id.slice(prefix.length));
      if (Number.isInteger(n) && n > max) max = n;
    }
  }
  let n = max + 1;
  while (all.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

/**
 * 전역 인덱스 기준 슬롯 중간삽입. newSlot 을 atGlobalIdx(1-based) 위치에 꽂고 이후 globalIdx +1.
 * 대상 preset(camIdx,presetIdx: newSlot.roiByPreset 첫 key 파싱)의 coveredSlotIds 말미 append,
 * preset 부재 시 신규 preset push. globalIndex 는 명시적 splice(수동 전역위치 보존) — rebuildGlobalIndex
 * 는 coveredSlotIds 정규정렬로 수동 위치를 무시하므로 재사용하지 않는다. 이미 존재하는 slotId 면 no-op.
 * 불변(새 artifact 반환).
 */
export function insertSlotAt(artifact, atGlobalIdx, newSlot) {
  const slots = artifact.slots ?? [];
  if (slots.some((s) => s.slotId === newSlot.slotId)) return artifact; // 중복 방어(no-op).
  const key = Object.keys(newSlot.roiByPreset ?? {})[0] ?? '';
  const [kc, kp] = key.split(':').map(Number);
  const camIdx = Number.isFinite(kc) ? kc : 0;
  const presetIdx = Number.isFinite(kp) ? kp : 0;

  const nextSlots = [...slots, newSlot]; // slots 배열 순서는 전역순서를 결정하지 않음.

  let found = false;
  const nextPresets = (artifact.presets ?? []).map((p) => {
    if (p.camIdx === camIdx && p.presetIdx === presetIdx) {
      found = true;
      return { ...p, coveredSlotIds: [...(p.coveredSlotIds ?? []), newSlot.slotId] };
    }
    return p;
  });
  if (!found) {
    nextPresets.push({ camIdx, presetIdx, label: `${camIdx}:${presetIdx}`, coveredSlotIds: [newSlot.slotId] });
  }

  const base = [...(artifact.globalIndex ?? [])].sort((a, b) => a.globalIdx - b.globalIdx);
  const pos = Math.min(Math.max(1, atGlobalIdx), base.length + 1) - 1;
  base.splice(pos, 0, { globalIdx: 0, slotId: newSlot.slotId, camIdx, presetIdx });
  const nextGlobal = base.map((g, i) => ({ ...g, globalIdx: i + 1 }));

  return { ...artifact, slots: nextSlots, presets: nextPresets, globalIndex: nextGlobal };
}

/** #3 사각형 정규화 클램프: x,y∈[0,1], w,h>0, x+w≤1, y+h≤1. */
export function clamp01Rect(rect) {
  const MIN = 0.001; // 최소 폭/높이(붕괴 방지)
  let x = Math.min(1, Math.max(0, rect.x));
  let y = Math.min(1, Math.max(0, rect.y));
  let w = Math.max(MIN, rect.w);
  let h = Math.max(MIN, rect.h);
  if (x + w > 1) w = 1 - x;
  if (y + h > 1) h = 1 - y;
  w = Math.max(MIN, w);
  h = Math.max(MIN, h);
  return { x, y, w, h };
}

/**
 * #3 크기 조정: 모서리 핸들(nw/ne/sw/se) 드래그 델타(ndx,ndy) 적용 후 clamp01Rect.
 * 좌상(x,y)·우하(x+w,y+h) 를 핸들별로 이동시켜 사각형 갱신.
 */
export function resizeRect(rect, handle, ndx, ndy) {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.w;
  let bottom = rect.y + rect.h;
  switch (handle) {
    case 'n': top += ndy; break;
    case 's': bottom += ndy; break;
    case 'w': left += ndx; break;
    case 'e': right += ndx; break;
    case 'nw': left += ndx; top += ndy; break;
    case 'ne': right += ndx; top += ndy; break;
    case 'sw': left += ndx; bottom += ndy; break;
    case 'se': right += ndx; bottom += ndy; break;
    default: break;
  }
  // 좌/우, 상/하 뒤집힘 방지(정규화 후).
  const x = Math.min(left, right);
  const y = Math.min(top, bottom);
  const w = Math.abs(right - left);
  const h = Math.abs(bottom - top);
  return clamp01Rect({ x, y, w, h });
}

/**
 * #3 갱신: slotId 슬롯의 roiByPreset[key] 만 rect 로 교체(불변). slot 집합 불변 → globalIndex 불변.
 */
export function updateSlotRoi(artifact, slotId, key, rect) {
  const slots = (artifact.slots ?? []).map((s) =>
    s.slotId === slotId ? { ...s, roiByPreset: { ...s.roiByPreset, [key]: rect } } : s,
  );
  return { ...artifact, slots };
}

/**
 * 사각형 평행이동(w,h 유지). x∈[0,1−w], y∈[0,1−h] 로 클램프.
 * clamp01Rect 는 경계에서 w/h 를 축소하므로 이동엔 부적합 → 별도(VPD Ctrl+드래그 이동용).
 */
export function moveRect(rect, ndx, ndy) {
  const w = rect.w;
  const h = rect.h;
  const x = Math.max(0, Math.min(rect.x + ndx, 1 - w));
  const y = Math.max(0, Math.min(rect.y + ndy, 1 - h));
  return { x, y, w, h };
}

/**
 * 사각형의 8핸들(4코너+4변)/내부 히트테스트(순수, DOM 미참조). 우선순위: 코너>변>내부>외부(null).
 * tolX/tolY 는 호출측(app.js)에서 HANDLE_PX/overlay.width|height 로 주입(hitTestQuadVertex 패턴).
 * 반환 핸들 문자열은 resizeRect handle 인자와 1:1('nw/ne/sw/se/n/s/e/w'), 내부는 'in'.
 */
export function hitTestRectHandle(rect, nx, ny, tolX, tolY) {
  if (!rect) return null;
  const left = rect.x;
  const right = rect.x + rect.w;
  const top = rect.y;
  const bottom = rect.y + rect.h;
  // 코너(최우선): |dx|<=tolX && |dy|<=tolY.
  if (Math.abs(nx - left) <= tolX && Math.abs(ny - top) <= tolY) return 'nw';
  if (Math.abs(nx - right) <= tolX && Math.abs(ny - top) <= tolY) return 'ne';
  if (Math.abs(nx - left) <= tolX && Math.abs(ny - bottom) <= tolY) return 'sw';
  if (Math.abs(nx - right) <= tolX && Math.abs(ny - bottom) <= tolY) return 'se';
  // 변(코너 구간 제외): 변 선분 근접 + 변 범위 안.
  const inX = nx >= left + tolX && nx <= right - tolX;
  const inY = ny >= top + tolY && ny <= bottom - tolY;
  if (Math.abs(ny - top) <= tolY && inX) return 'n';
  if (Math.abs(ny - bottom) <= tolY && inX) return 's';
  if (Math.abs(nx - left) <= tolX && inY) return 'w';
  if (Math.abs(nx - right) <= tolX && inY) return 'e';
  // 내부.
  if (nx >= left && nx <= right && ny >= top && ny <= bottom) return 'in';
  return null;
}

// ===== floor ROI(가변 다각형 4~10점) 정점 개별 드래그 편집 순수 로직 =====
// quad 는 N×{x,y} 정규화(0..1) 배열(N≥3), 인덱스 0..N-1.

/**
 * floor 다각형 정점 히트테스트: 각 정점과 |dx|<=tolX && |dy|<=tolY 인 첫 번째 index(0..N-1) 반환, 없으면 null.
 * tolX/tolY 는 호출측(app.js)에서 HANDLE_PX/overlay.width, HANDLE_PX/overlay.height 로 주입(core 는 DOM 미참조).
 */
export function hitTestQuadVertex(quad, nx, ny, tolX, tolY) {
  if (!Array.isArray(quad) || quad.length < 3) return null;
  for (let i = 0; i < quad.length; i++) {
    if (Math.abs(nx - quad[i].x) <= tolX && Math.abs(ny - quad[i].y) <= tolY) return i;
  }
  return null;
}

/**
 * floor 다각형의 index 정점만 (x+ndx, y+ndy) 로 이동 후 각 좌표 0..1 clamp. 나머지 정점 불변.
 * 새 배열 반환(불변) — 다각형은 정점 자유 이동이므로 rect 처럼 역전/최소폭 보정 없음.
 * index 가 0..N-1 밖이거나 다각형 부적합이면 원본 얕은복사 반환(변형 없음).
 */
export function moveQuadVertex(quad, index, ndx, ndy) {
  if (!Array.isArray(quad) || quad.length < 3 || index < 0 || index >= quad.length) {
    return Array.isArray(quad) ? quad.slice() : quad;
  }
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  return quad.map((p, i) =>
    i === index ? { x: clamp01(p.x + ndx), y: clamp01(p.y + ndy) } : p,
  );
}

/**
 * slotId 슬롯의 floorRoiByPreset[key] 만 quad 로 교체(불변). slot 집합·globalIndex 불변.
 * updateSlotRoi 미러.
 */
export function updateSlotFloorRoi(artifact, slotId, key, quad) {
  const slots = (artifact.slots ?? []).map((s) =>
    s.slotId === slotId ? { ...s, floorRoiByPreset: { ...s.floorRoiByPreset, [key]: quad } } : s,
  );
  return { ...artifact, slots };
}

/**
 * #7 수동 매핑 검증: globalIndex 의 globalIdx 가 1..N 연속·중복 없는지.
 * → { ok, duplicates, gaps }. duplicates=2회 이상 등장한 globalIdx, gaps=1..N 중 빠진 번호.
 */
export function validateManualIndex(globalIndex) {
  const idxs = (globalIndex ?? []).map((g) => g.globalIdx);
  const n = idxs.length;
  const seen = new Map();
  for (const v of idxs) seen.set(v, (seen.get(v) ?? 0) + 1);
  const duplicates = [...seen.entries()].filter(([, c]) => c > 1).map(([v]) => v).sort((a, b) => a - b);
  const present = new Set(idxs);
  const gaps = [];
  for (let i = 1; i <= n; i++) if (!present.has(i)) gaps.push(i);
  return { ok: duplicates.length === 0 && gaps.length === 0, duplicates, gaps };
}

/**
 * #7 재정렬: orderedSlotIds 순서대로 globalIdx 1..N 재부여(불변 artifact 반환).
 * slots 집합과 1:1(누락/초과 없음) 검증. 불일치 시 null. camIdx/presetIdx 는 기존 globalIndex 보존.
 */
export function reorderGlobalIndex(artifact, orderedSlotIds) {
  const slotIds = new Set((artifact.slots ?? []).map((s) => s.slotId));
  const ordered = orderedSlotIds ?? [];
  if (ordered.length !== slotIds.size) return null;
  const orderedSet = new Set(ordered);
  if (orderedSet.size !== ordered.length) return null; // 중복 입력
  for (const id of ordered) if (!slotIds.has(id)) return null; // 미존재 slotId
  const metaById = new Map((artifact.globalIndex ?? []).map((g) => [g.slotId, g]));
  const globalIndex = ordered.map((id, i) => {
    const meta = metaById.get(id);
    return {
      globalIdx: i + 1,
      slotId: id,
      camIdx: meta?.camIdx ?? 0,
      presetIdx: meta?.presetIdx ?? 0,
    };
  });
  return { ...artifact, globalIndex };
}

/** slotId 의 (camIdx, presetIdx, 프리셋내 위치) 를 산출물에서 도출. globalIndex·roiByPreset·coveredSlotIds 사용. */
function slotContext(artifact, slot, giBySlot) {
  const g = giBySlot.get(slot.slotId);
  const key = Object.keys(slot.roiByPreset ?? {})[0] ?? '';
  const [kc, kp] = key.split(':').map(Number);
  const camIdx = g?.camIdx ?? (Number.isFinite(kc) ? kc : 0);
  const presetIdx = g?.presetIdx ?? (Number.isFinite(kp) ? kp : 0);
  const preset = (artifact.presets ?? []).find((p) => p.camIdx === camIdx && p.presetIdx === presetIdx);
  const pos = preset && Array.isArray(preset.coveredSlotIds) ? preset.coveredSlotIds.indexOf(slot.slotId) : -1;
  return { camIdx, presetIdx, positionIdx: pos >= 0 ? pos + 1 : null };
}

/**
 * 전역 인덱스 매핑 표 행 산출(순수). 슬롯별 카메라/프리셋/프리셋내 위치/zone/현재 전역ID.
 * 카메라→프리셋→위치 순 정렬. UI 가 전역ID 직접 입력으로 매핑하게 한다.
 */
export function buildMappingRows(artifact) {
  if (!artifact || !Array.isArray(artifact.slots)) return [];
  const giBySlot = new Map((artifact.globalIndex ?? []).map((g) => [g.slotId, g]));
  const rows = artifact.slots.map((s) => {
    const ctx = slotContext(artifact, s, giBySlot);
    return {
      slotId: s.slotId,
      camIdx: ctx.camIdx,
      presetIdx: ctx.presetIdx,
      positionIdx: ctx.positionIdx,
      zone: s.zone ?? '',
      globalIdx: giBySlot.get(s.slotId)?.globalIdx ?? null,
    };
  });
  rows.sort(
    (a, b) =>
      a.camIdx - b.camIdx ||
      a.presetIdx - b.presetIdx ||
      (a.positionIdx ?? Infinity) - (b.positionIdx ?? Infinity),
  );
  return rows;
}

/**
 * 사용자가 입력한 slotId→전역ID 맵을 적용해 새 globalIndex 를 만든다(순수).
 * 모든 슬롯에 1..N 고유 전역ID 가 있어야 함(validateManualIndex). 위반 시 { ok:false, error }.
 */
export function applyManualGlobalIds(artifact, idBySlot) {
  if (!artifact || !Array.isArray(artifact.slots)) return { ok: false, error: '산출물 없음' };
  const giBySlot = new Map((artifact.globalIndex ?? []).map((g) => [g.slotId, g]));
  const entries = [];
  for (const s of artifact.slots) {
    const n = Number(idBySlot?.[s.slotId]);
    if (!Number.isInteger(n) || n < 1) {
      return { ok: false, error: `전역ID 누락/오류: ${s.slotId}` };
    }
    const ctx = slotContext(artifact, s, giBySlot);
    entries.push({ globalIdx: n, slotId: s.slotId, camIdx: ctx.camIdx, presetIdx: ctx.presetIdx });
  }
  const v = validateManualIndex(entries);
  if (!v.ok) {
    return { ok: false, error: `정합 오류 — 중복:${v.duplicates.join(',') || '-'} 누락:${v.gaps.join(',') || '-'}`, validation: v };
  }
  entries.sort((a, b) => a.globalIdx - b.globalIdx);
  return { ok: true, artifact: { ...artifact, globalIndex: entries } };
}

/**
 * 슬롯 맵(사각 박스) 모델(순수). 매핑 표 행 + 현재 입력 전역ID + 선택 slotId →
 * 박스 descriptor 배열. label=전역ID(없으면 '?'), group=프리셋키, bad/selected 플래그.
 */
export function slotMapModel(rows, idBySlot, selectedSlotId) {
  return (rows ?? []).map((r) => {
    const gid = idBySlot?.[r.slotId];
    const has = gid !== undefined && gid !== null && String(gid) !== '';
    return {
      slotId: r.slotId,
      label: has ? String(gid) : '?',
      group: `${r.camIdx}:${r.presetIdx}`,
      bad: !has,
      selected: r.slotId === selectedSlotId,
    };
  });
}

/**
 * 스냅샷 폴링 루프(백프레셔·Blob revoke·정지). DOM/브라우저 전역 미참조 → 의존성 주입.
 * deps:
 *   - fetchFn(url, { signal }) → Response(blob() 보유)
 *   - makeUrl(seq) → 요청 URL(매 프레임 t 증가)
 *   - createObjectURL(blob) → string
 *   - revokeObjectURL(url)
 *   - setImage(url) → Promise|void (img.src 교체 + decode)
 *   - onPtz(headers) (선택) 응답 헤더로 현재 PTZ 갱신
 *   - setTimer(fn, ms) → handle / clearTimer(handle) (기본: setInterval/clearInterval)
 */
export function createStreamLoop(deps) {
  const setTimer = deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearInterval(h));

  let seq = 0;
  let inflight = null; // AbortController
  let timer = null;
  let lastUrl = null;

  async function tick() {
    if (inflight) return; // 백프레셔: 이전 요청 진행 중이면 스킵
    const ac = new AbortController();
    inflight = ac;
    try {
      const url = deps.makeUrl(seq++);
      const res = await deps.fetchFn(url, { signal: ac.signal });
      const blob = await res.blob();
      const nextUrl = deps.createObjectURL(blob);
      await deps.setImage(nextUrl);
      if (lastUrl) deps.revokeObjectURL(lastUrl); // 이전 Blob URL 해제(누수 방지, G3-4)
      lastUrl = nextUrl;
      if (deps.onPtz) deps.onPtz(res.headers);
    } catch {
      // abort/timeout/decode 실패 무시
    } finally {
      inflight = null;
    }
  }

  function start(fps) {
    if (timer) return;
    timer = setTimer(tick, fpsToInterval(fps));
  }

  function stop() {
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
    if (inflight) {
      inflight.abort();
      inflight = null;
    }
  }

  return { start, stop, tick };
}

/**
 * 이동(수동 PTZ·프리셋) 시 렌더 경로 결정(순수, DOM 무관). liveMode ∈ {'off','stream','poll'}.
 * 루프3: Unity /stream 이 pan/tilt/zoom override 를 지원 → 스트림 모드면 새 PTZ 로 stream 재연결('stream-reconnect'),
 * 그 외(poll 폴백/off)는 폴링 tick('tick', poll 지속갱신 / off 1회 스냅샷 override). origin 무관(스트림이 수동·프리셋 PTZ 를 모두 렌더).
 * → 'stream-reconnect' | 'tick'.
 */
export function moveRenderDirective(liveMode) {
  return liveMode === 'stream' ? 'stream-reconnect' : 'tick';
}

// --- 결과 저장/열기(로컬 파일) 순수 로직 --------------------------------

/**
 * 로컬에서 읽은 JSON 텍스트를 파싱·최소형태검증. SetupArtifact 최소 형태
 * (presets/slots/globalIndex 배열 존재)만 확인한다(analyzeArtifact 관용도와 정합).
 * → { ok:true, artifact } | { ok:false, error }.
 */
export function parseLoadedArtifact(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return { ok: false, error: '올바른 JSON 파일이 아닙니다(파싱 실패)' };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: '형식 오류: 최상위가 객체가 아닙니다' };
  }
  if (!Array.isArray(obj.presets) || !Array.isArray(obj.slots) || !Array.isArray(obj.globalIndex)) {
    return { ok: false, error: '형식 오류: presets/slots/globalIndex 배열이 필요합니다' };
  }
  return { ok: true, artifact: obj };
}

// --- DB 뷰어 표 모델(순수) ----------------------------------------------

/** DB 셀 값 문자열화: null/undefined→'', 객체/Buffer→JSON 또는 [blob], 그 외 String(v). */
function formatCell(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    // Buffer/Uint8Array(BLOB)는 JSON 직렬화가 무의미 → [blob] 표기.
    if (typeof v.byteLength === 'number' && !Array.isArray(v)) return '[blob]';
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/**
 * GET /db/table/:name 응답의 {columns, rows} → 표 모델 { headers, cells }.
 * headers=columns, cells=rows.map(r => columns.map(c => formatCell(r[c]))). 누락 키→''.
 * throw 금지: columns/rows 가 배열이 아니면 빈 모델 반환(graceful).
 */
export function buildDbTableModel({ columns, rows } = {}) {
  const headers = Array.isArray(columns) ? columns : [];
  const list = Array.isArray(rows) ? rows : [];
  const cells = list.map((r) => headers.map((c) => formatCell(r == null ? undefined : r[c])));
  return { headers, cells };
}

// --- 시뮬레이터(Unity) 연결·카메라 자동 갱신 순수 로직 ------------------

/**
 * 목록 갱신 후 이전 선택을 유지한다(순수). prevId 를 가진 항목이 list 에 있으면 prevId 그대로,
 * 없으면 첫 항목의 key 값, 빈 목록이면 null. 자동 갱신 시 사용자의 cam/preset 선택 튐을 막는다.
 * @param {number|string|null} prevId 이전에 선택된 키 값
 * @param {Array<Object>} list 갱신된 목록(cameras 또는 presets)
 * @param {string} key 비교 키('camIdx' | 'presetIdx')
 * @returns {number|string|null}
 */
export function pickSelected(prevId, list, key = 'camIdx') {
  const arr = list ?? [];
  if (arr.some((item) => item[key] === prevId)) return prevId;
  return arr[0]?.[key] ?? null;
}

/**
 * 카메라/프리셋 집합이 실제로 바뀌었는지(순수). camIdx + 각 카메라 presetIdx 목록만 비교(라벨/PTZ 무시).
 * 변경됐을 때만 드롭다운을 재렌더해 선택 튐·깜빡임을 막는다.
 * @param {Array<Object>|null|undefined} prev 이전 cameras
 * @param {Array<Object>|null|undefined} next 새 cameras
 * @returns {boolean}
 */
export function camerasChanged(prev, next) {
  const sig = (list) =>
    (list ?? [])
      .map(
        (c) =>
          `${c.camIdx}:${(c.presets ?? [])
            .map((p) => p.presetIdx)
            .sort((a, b) => a - b)
            .join(',')}`,
      )
      .sort()
      .join('|');
  return sig(prev) !== sig(next);
}

// ===== 카메라 PTZ 프리셋(camerapos.json) 편집 순수 로직 =====
// views 원소: { camIdx, presetIdx, label, pan, tilt, zoom }(정규화 CameraView). 불변(새 배열 반환).

/**
 * 프리셋 upsert: 같은 (camIdx, presetIdx) 가 있으면 갱신, 없으면 추가.
 * entry = { camIdx, presetIdx, label, pan, tilt, zoom }. 불변(새 배열 반환).
 */
export function upsertPreset(views, entry) {
  const next = (views ?? []).map((v) => ({ ...v }));
  const i = next.findIndex((v) => v.camIdx === entry.camIdx && v.presetIdx === entry.presetIdx);
  const e = {
    camIdx: entry.camIdx,
    presetIdx: entry.presetIdx,
    label: entry.label,
    pan: entry.pan,
    tilt: entry.tilt,
    zoom: entry.zoom,
  };
  if (i >= 0) next[i] = e;
  else next.push(e);
  return next;
}

/** 프리셋 삭제: (camIdx, presetIdx) 항목 제거. 불변(새 배열 반환). */
export function removePreset(views, camIdx, presetIdx) {
  return (views ?? []).filter((v) => !(v.camIdx === camIdx && v.presetIdx === presetIdx));
}

/** 해당 카메라의 다음 presetIdx(기존 max+1, 없으면 1). 1-based. */
export function nextPresetId(views, camIdx) {
  let max = 0;
  for (const v of views ?? []) {
    if (v.camIdx === camIdx && v.presetIdx > max) max = v.presetIdx;
  }
  return max + 1;
}

// ===== VPD 차량 검출 중복 제거(dedup) 순수 로직 =====
// 같은 차량에 겹친 VPD 박스(NMS 없는 모델 응답)를 IoU 연결요소(union-find)로 병합 — 차량당 1개(마지막 검지)만 남긴다.

/** 두 NormalizedRect(정규화 0..1)의 IoU(교집합/합집합). 겹침 없음/퇴화 → 0. */
export function rectIoU(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni <= 0 ? 0 : inter / uni;
}

/**
 * VPD 차량 배열 중복 제거(차량당 1개). IoU≥iouThresh 간선으로 **연결요소(union-find) 그룹핑** 후
 * 각 그룹의 원배열 최대 index(=마지막 검지)만 생존시킨다. 같은 차량의 동심 다중스케일 박스는
 * 연속 겹침으로 transitive 하게 1그룹으로 묶여(체인 양 끝이 서로 IoU<th 여도) 확실히 1개로 병합되고,
 * 인접 별개 차량은 IoU 가 낮아 별도 그룹으로 유지(과잉병합 없음).
 * 마지막에 생존 index 를 원배열 순서로 정렬(렌더/선택 index 안정). 원객체 참조 반환 → plate/confidence/cls 보존.
 * rect 없는 malformed 요소는 스킵(원순서 유지). iouThresh 기본 0.5(설정 플럼빙 없음).
 * (그리디 방식은 체인 양 끝이 서로 안 겹치면 둘 다 생존해 "차량당 1개"를 위반 — 연결요소로 교정.)
 */
export function dedupeVehicles(vehicles, iouThresh = 0.5) {
  const vs = (vehicles ?? []).filter((v) => v?.rect); // malformed 스킵(원순서 유지).
  const n = vs.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (rectIoU(vs[i].rect, vs[j].rect) >= iouThresh) parent[find(i)] = find(j);
    }
  }
  const lastOf = new Map(); // 그룹 대표 → 그 그룹의 최대 index(마지막 검지).
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!lastOf.has(r) || i > lastOf.get(r)) lastOf.set(r, i);
  }
  return [...lastOf.values()].sort((a, b) => a - b).map((i) => vs[i]); // 원순서 복원, 그룹당 마지막.
}

// ===== [기능2] VPD/LPD 검출 박스 선택·편집 순수 로직 =====
// detect = { vehicles:[{ rect:{x,y,w,h}, plate? }], plates:[{ quad:[{x,y}×4] }] }(정규화). 임시(메모리) 편집.

/**
 * 검출 박스 히트테스트. 우선순위: 선택 대상(selected)의 rect 핸들/quad 정점 > vehicle rect 내부 > plate quad 내부.
 * 같은 종류가 겹치면 마지막(=위) 항목을 우선(drawDetectOverlay 그리는 순서와 정합).
 * args: { nx, ny, detect, tolX, tolY, selected }. selected = { kind:'vehicle'|'plate', index } | null.
 * → vehicle: { kind:'vehicle', index, handle }('nw'..'se'|'in') / plate: { kind:'plate', index, vertex? } | null.
 */
export function hitTestDetections({ nx, ny, detect, tolX, tolY, selected }) {
  const vehicles = detect?.vehicles ?? [];
  const plates = detect?.plates ?? [];
  // 1) 선택 항목의 핸들/정점 우선(리사이즈·정점 드래그 어포던스).
  if (selected) {
    if (selected.kind === 'vehicle') {
      const rect = vehicles[selected.index]?.rect;
      if (rect) {
        const h = hitTestRectHandle(rect, nx, ny, tolX, tolY);
        if (h && h !== 'in') return { kind: 'vehicle', index: selected.index, handle: h };
      }
    } else if (selected.kind === 'plate') {
      const quad = plates[selected.index]?.quad;
      if (quad) {
        const vi = hitTestQuadVertex(quad, nx, ny, tolX, tolY);
        if (vi != null) return { kind: 'plate', index: selected.index, vertex: vi };
      }
    }
  }
  // 2) vehicle rect 내부(위→아래).
  for (let i = vehicles.length - 1; i >= 0; i--) {
    if (pointInRect(nx, ny, vehicles[i]?.rect)) return { kind: 'vehicle', index: i, handle: 'in' };
  }
  // 3) plate quad 내부.
  for (let i = plates.length - 1; i >= 0; i--) {
    if (pointInQuad(nx, ny, plates[i]?.quad)) return { kind: 'plate', index: i };
  }
  return null;
}

/**
 * 선택 항목(sel.kind/index) 제거 후 새 detect 반환(불변). 나머지 필드(있으면) 보존.
 * sel 없음/인덱스 밖이면 vehicles/plates 얕은복사만 반환(변형 없음).
 */
export function removeDetection(detect, sel) {
  const vehicles = (detect?.vehicles ?? []).slice();
  const plates = (detect?.plates ?? []).slice();
  if (sel && sel.kind === 'vehicle' && sel.index >= 0 && sel.index < vehicles.length) {
    vehicles.splice(sel.index, 1);
  } else if (sel && sel.kind === 'plate' && sel.index >= 0 && sel.index < plates.length) {
    plates.splice(sel.index, 1);
  }
  return { ...detect, vehicles, plates };
}

// ===== [기능3] 주차면 자동보정 아핀(이동+스케일) 순수 로직 =====
// 정규화 좌표(0..1). 중심(cx,cy) 기준 스케일 후 (dx,dy) 이동. 회전·원근 미보정.

/** 점에 이동+스케일 적용: new = center + scale*(old-center) + (dx,dy). */
export function applyTranslateScale(point, { dx = 0, dy = 0, scale = 1, cx = 0.5, cy = 0.5 }) {
  return {
    x: cx + scale * (point.x - cx) + dx,
    y: cy + scale * (point.y - cy) + dy,
  };
}

/** 프리셋 주차면(spaces=[{idx,points:[{x,y}×4]}])의 각 점에 applyTranslateScale 적용(불변). idx 보존. */
export function transformPlaceRoiPreset(spaces, transform) {
  return (spaces ?? []).map((sp) => ({
    ...sp,
    points: (sp.points ?? []).map((p) => applyTranslateScale(p, transform)),
  }));
}

// ===== 3D 육면체(주차면 부피) 투영 순수 로직 =====
// 뷰어는 **추정하지 않는다** — 서버 GET /capture/ground-model 이 준 지면모델로 투영만 한다(이중구현 회피).
// groundModel: { imgW, imgH, f, n:[nx,ny,nz], d, tiltDeg, conf, source, issues }
//   지면 = { X ∈ 카메라좌표 | n·X = d }.  n=하향 단위법선, d=카메라 지상고(m), f=초점거리(px).
//   픽셀 p 의 지면점 X = d·m/(n·m), m = K⁻¹p.  높이 h 점의 상: p_h ≃ p − h·((n·m)/d)·(K·n).
//   → 상면 4점은 p 에서 수직소실점 반대방향으로 밀려난다. 카메라가 지면 위에 있으므로 화면 위쪽으로 간다.

const CUBOID_EPS = 1e-9;

/**
 * 바닥 quad(정규화 0..1, 4점) + 지면모델 + 높이 h(m) → 육면체 8점·12모서리(정규화 0..1).
 * corners[0..3]=바닥(입력 quad 그대로), corners[4..7]=상면(같은 순서). edges=바닥4+상면4+수직4.
 * h=0 이면 상면=바닥(동일 좌표). 지면모델 없음/퇴화(지평선 위·f≤0·d≤0·비유한) → **null**(호출측이 렌더 skip).
 * throw 금지 — 기존 2D 바닥 ROI 렌더는 영향받지 않는다(가산 레이어).
 */
export function projectCuboid(floorQuad, groundModel, heightM) {
  const g = groundModel;
  if (!Array.isArray(floorQuad) || floorQuad.length !== 4) return null;
  if (!g || !Array.isArray(g.n) || g.n.length !== 3) return null;
  if (!(g.f > 0) || !(g.d > 0) || !(g.imgW > 0) || !(g.imgH > 0)) return null;
  const h = Number(heightM);
  if (!Number.isFinite(h) || h < 0) return null;
  const [nx, ny, nz] = g.n;
  if (![nx, ny, nz].every(Number.isFinite)) return null;
  const cx = g.imgW / 2;
  const cy = g.imgH / 2;
  const kn = [g.f * nx + cx * nz, g.f * ny + cy * nz, nz]; // K·n (수직 방향의 동차 이미지 벡터).

  const top = [];
  for (const p of floorQuad) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    const u = p.x * g.imgW;
    const v = p.y * g.imgH;
    const s = ((u - cx) * nx + (v - cy) * ny + g.f * nz) / (g.f * g.d); // (n·K⁻¹p)/d.
    if (!(s > CUBOID_EPS)) return null; // 지평선 위/카메라 뒤 → 육면체 미표시(강등, advisory 는 호출측).
    const w = 1 - h * s * kn[2];
    if (Math.abs(w) < CUBOID_EPS) return null;
    const tx = (u - h * s * kn[0]) / w;
    const ty = (v - h * s * kn[1]) / w;
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) return null;
    top.push({ x: tx / g.imgW, y: ty / g.imgH });
  }
  return {
    corners: [...floorQuad.map((p) => ({ x: p.x, y: p.y })), ...top],
    edges: [
      [0, 1], [1, 2], [2, 3], [3, 0], // 바닥
      [4, 5], [5, 6], [6, 7], [7, 4], // 상면
      [0, 4], [1, 5], [2, 6], [3, 7], // 수직
    ],
  };
}

/** 바닥 4모서리 edge(코너 순서 규약). 앞면은 이 중 카메라 최근접 edge. 서버 project.ts BOTTOM_EDGES 와 동일. */
const CUBOID_BOTTOM_EDGES = [[0, 1], [1, 2], [2, 3], [3, 0]];

/**
 * 육면체 앞면(근접면) 4 corner 인덱스 — **감김순서 불변**. 서버 src/ground/project.ts frontFaceCornerIdx 와
 * **동일 정의**(단일 진실 — 표시=DB 파리티). projectCuboid.corners 규약: [바닥 0..3, 상면 4..7(같은 순서)].
 * 바닥 corner 감김순서는 프리셋마다 회전될 수 있으므로(프리셋1=[근좌,원좌,원우,근우], 프리셋2=한 칸 회전)
 * 고정 인덱스([0,3,7,4]) 대신 기하로 판정한다: 바닥 4 edge 중 두 끝점의 이미지 y 평균이 최대(하향 틸트
 * 카메라에서 y 클수록 최근접=화면 아래=앞) 인 edge 의 두 바닥 corner a,b → 앞면 = [a, b, a+4, b+4].
 * 상면은 위로 올라가 y 가 작아지므로 판정엔 바닥 y 만 쓴다. bottomY = 바닥 corner 0..3 의 이미지 y.
 */
function frontFaceCornerIdx(bottomY) {
  let best = CUBOID_BOTTOM_EDGES[0];
  let bestVal = -Infinity;
  for (const [a, b] of CUBOID_BOTTOM_EDGES) {
    const avg = (bottomY[a] + bottomY[b]) / 2;
    if (avg > bestVal) {
      bestVal = avg;
      best = [a, b];
    }
  }
  const [a, b] = best;
  return [a, b, a + 4, b + 4];
}

/**
 * 육면체 앞면 중심 = 근접면 4 corner 산술평균(정규화 0..1). cuboid=projectCuboid 반환 {corners,edges}.
 * 앞면 corner 는 frontFaceCornerIdx 로 감김순서-불변 판정(프리셋2형 회전 quad 에서도 우측면 오선택 방지).
 * corners 8점 미만/비유한 → null(호출측이 원 렌더 skip). 높이 의존 — 상면 corner 포함(H 정책은 호출측).
 */
export function frontFaceCenter(cuboid) {
  const corners = cuboid?.corners;
  if (!Array.isArray(corners) || corners.length < 8) return null;
  const bottomY = [];
  for (let i = 0; i < 4; i++) {
    const c = corners[i];
    if (!c || !Number.isFinite(c.y)) return null;
    bottomY.push(c.y);
  }
  const idx = frontFaceCornerIdx(bottomY);
  let sx = 0;
  let sy = 0;
  for (const i of idx) {
    const c = corners[i];
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return null;
    sx += c.x;
    sy += c.y;
  }
  return { x: sx / idx.length, y: sy / idx.length };
}

/**
 * 지면모델 소스 배지 문자열(§5-2). 어느 소스가 표시 중인지 항상 안다. 모델 없음 → '지면모델: 없음'.
 * ★ 정합 지표를 함께 보여준다 — f/tilt 가 정확해도 ROI 는 어긋나 있을 수 있기 때문이다:
 *   metricErr(가로 정합) / tiltErrDeg(세로 정합, PTZ tilt 대조). 둘 중 하나라도 임계 초과면 '정합?' 경고.
 */
export function formatGroundBadge(model) {
  if (!model) return '지면모델: 없음';
  const src = model.source === 'auto' ? '자동(관측)' : '파일(PtzCamRoi)';
  const lv = Math.min(4, Math.max(0, Math.round((Number(model.conf) || 0) * 4)));
  const dots = '●'.repeat(lv) + '○'.repeat(4 - lv);
  const bad =
    Number(model.metricErr) > 0.008 ||
    (model.tiltErrDeg != null && Math.abs(Number(model.tiltErrDeg)) > 1.0);
  const align = `정합 ${(Number(model.metricErr) * 100).toFixed(1)}%` +
    (model.tiltErrDeg != null ? `/${Number(model.tiltErrDeg).toFixed(1)}°` : '') +
    (bad ? ' ⚠ROI 어긋남?' : '');
  return (
    `지면모델: ${src}  f=${Math.round(model.f)}px  tilt=${Number(model.tiltDeg).toFixed(1)}°` +
    `  카메라고 ${Number(model.d).toFixed(1)}m  신뢰도 ${dots}  ${align}`
  );
}

/** ground-model 응답의 models[] → cam:preset 키 맵. 없거나 비배열이면 빈 객체(graceful). */
export function groundModelsByKey(models) {
  const out = {};
  for (const m of Array.isArray(models) ? models : []) {
    out[presetKey(m.camIdx, m.presetIdx)] = m;
  }
  return out;
}

/** 저장 대화상자 제안 파일명. setup_YYYYMMDD_HHmmss.json (로컬시각). date 주입으로 테스트. */
export function defaultResultFilename(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `setup_${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.json`
  );
}
