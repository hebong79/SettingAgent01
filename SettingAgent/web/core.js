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
 * zoom 은 ±1 단계(클램프), pan/tilt 는 ±step.
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
      next.zoom = clampZoom(cur.zoom + 1);
      break;
    case 'zoomOut':
      next.zoom = clampZoom(cur.zoom - 1);
      break;
    default:
      break;
  }
  return next;
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
