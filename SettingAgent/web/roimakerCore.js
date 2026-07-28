// ROIMaker 순수 로직 모듈 (환경 비의존, vitest 직접 import).
// DOM/fetch/브라우저 전역 미참조 — roimaker.js 가 실제 의존성을 주입한다(core.js 규약 동일).
//
// 설계서: docs/20260728_113743_ROIMaker_수동ROI드로잉_페이지_설계.md
//
// 좌표 규약: 전부 정규화 0~1(원점 좌상단). 픽셀 변환은 호출측(toPixelQuad).
// 버퍼 규약: 그리기·드래그·삭제는 **메모리 버퍼만** 바꾼다. 파일·DB 는 저장 버튼에서만 변한다.

import { hitTestQuadVertex, moveQuadVertex, pointInQuad, presetKey } from './core.js';

/** 폴리곤 최소 정점 수(폐합 조건). 3점 미만은 면이 아니다. */
export const MIN_POINTS = 3;
/** 권장 정점 수. 이것과 다르면 지면모델·육면체·점유영역에서 제외된다(설계서 §8 위험 4). */
export const PREFERRED_POINTS = 4;

/** 보기 범위(마스터 지시 #14). */
export const VIEW_SCOPES = ['preset', 'slot', 'all'];

/**
 * 빈 편집 상태. spaces = { "cam:preset": [{ idx, points, origin }] }.
 * baseCounts = 로드 시점의 프리셋별 주차면 수(무결성 가드 기준선 — buildSavePayload 참조).
 */
export function createRoiMakerState() {
  return { mode: 'idle', draft: null, spaces: {}, selected: null, dirtyKeys: [], baseCounts: {} };
}

/** (cam asc → preset asc) 키 정렬 — 전역 idx 규약과 동일 순서. */
function sortedKeys(spaces) {
  return Object.keys(spaces ?? {}).sort((a, b) => {
    const [ca, pa] = a.split(':').map(Number);
    const [cb, pb] = b.split(':').map(Number);
    return ca - cb || pa - pb;
  });
}

/** 전체 주차면 수(빈 폴리곤 포함 — 엔트리 수다). */
export function countSpaces(spaces) {
  return sortedKeys(spaces).reduce((n, k) => n + (spaces[k]?.length ?? 0), 0);
}

/** 현재 최대 전역 idx(없으면 0). */
function maxIdx(spaces) {
  let m = 0;
  for (const k of sortedKeys(spaces)) {
    for (const sp of spaces[k] ?? []) if (Number.isFinite(sp.idx) && sp.idx > m) m = sp.idx;
  }
  return m;
}

/** dirtyKeys 에 key 추가(중복 없이, 정렬 유지). */
function markDirty(dirtyKeys, key) {
  return dirtyKeys.includes(key) ? dirtyKeys : [...dirtyKeys, key].sort();
}

/**
 * placeRoi({ "cam:preset": [{idx,points}] }) → 편집 버퍼(origin:'file' 태깅).
 * 기존 편집 상태(draft/선택/dirty)는 전부 버린다 — 서버 재조회 후 재렌더 규약(설계서 §3 D-8).
 */
export function loadSpaces(state, placeRoi) {
  const spaces = {};
  const baseCounts = {};
  for (const key of sortedKeys(placeRoi)) {
    spaces[key] = (placeRoi[key] ?? []).map((sp) => ({
      idx: sp.idx,
      points: (sp.points ?? []).map((p) => ({ x: p.x, y: p.y })),
      origin: 'file',
    }));
    baseCounts[key] = spaces[key].length; // 무결성 가드 기준선(로드 시점 개수).
  }
  return { ...state, spaces, baseCounts, draft: null, selected: null, dirtyKeys: [], mode: 'idle' };
}

/**
 * 전 프리셋을 저장 대상(dirty)으로 표시.
 *
 * ★ 언제 필요한가(실측으로 발견): 정본 `PtzCamRoi.json` 은 **프리셋별 1-based idx** 를 쓰는 경우가 있다
 *   (실 파일 확인: cam1:preset2 의 idx 가 다시 1 부터 시작). 이때 `normalizeGlobalIdx` 가 로드 시점에
 *   전역 1..N 을 재부여하므로 **메모리 버퍼가 파일과 전 프리셋에서 다르다**.
 *   변경 프리셋만 저장하면 파일이 "일부는 전역번호·일부는 프리셋번호" 인 혼합 상태가 되고,
 *   다음 로드에서 전역번호가 또 밀려 DB slot_id 와 어긋난다(라이브에서 16건 불일치로 관측).
 *   → 재부여가 일어났으면 **첫 저장에서 전 프리셋을 함께 기록해 파일을 전역번호로 수렴**시킨다.
 */
export function markAllDirty(state) {
  return { ...state, dirtyKeys: sortedKeys(state.spaces) };
}

/**
 * 미저장 신규 space 의 전역 idx 재부여(파일 space 수 뒤에 1..k 로 연속 배치).
 * ★ 필수 이유: 신규를 지우면 idx 집합이 1..N 순열에서 깨지고, 그러면 다음 로드에서
 *   normalizeGlobalIdx 가 **전체를 재부여**해 DB slot_id 와 조용히 어긋난다(설계서 §8 위험 2).
 */
function renumberNewSpaces(spaces) {
  const keys = sortedKeys(spaces);
  let fileCount = 0;
  for (const key of keys) for (const sp of spaces[key]) if (sp.origin === 'file') fileCount++;
  let next = fileCount + 1;
  const out = {};
  for (const key of keys) {
    out[key] = spaces[key].map((sp) => (sp.origin === 'new' ? { ...sp, idx: next++ } : sp));
  }
  return out;
}

// --- 그리기 모드 --------------------------------------------------------

/** 시작↔정지 토글(요구 8~10). 정지로 갈 때 진행 중 draft 는 폐기한다. */
export function toggleDrawMode(state) {
  return state.mode === 'drawing'
    ? { ...state, mode: 'idle', draft: null }
    : { ...state, mode: 'drawing', draft: null };
}

/** 좌클릭 = 정점 추가(그리기 모드에서만 — 정지 모드에선 무시해 편집과 배타). */
export function addDraftPoint(state, nx, ny) {
  if (state.mode !== 'drawing') return state;
  const pts = state.draft?.points ?? [];
  return { ...state, draft: { points: [...pts, { x: clamp01(nx), y: clamp01(ny) }] } };
}

/** Backspace = 마지막 정점 취소. 0개가 되면 draft 자체를 없앤다. */
export function undoDraftPoint(state) {
  const pts = state.draft?.points ?? [];
  if (!pts.length) return { ...state, draft: null };
  const next = pts.slice(0, -1);
  return { ...state, draft: next.length ? { points: next } : null };
}

/** Esc = 진행 중 폴리곤 폐기(모드는 유지). */
export function cancelDraft(state) {
  return { ...state, draft: null };
}

/** 다음 전역 idx(= slot_id). 기존 idx 를 하나도 건드리지 않는 값. */
function nextIdx(spaces) {
  return Math.max(maxIdx(spaces), countSpaces(spaces)) + 1;
}

/**
 * '추가' 버튼 — **주차면 id 만** 만들어 현재 프리셋 배열 끝에 넣는다(폴리곤은 비어 있다).
 * 그린 뒤 번호를 받는 게 아니라, 번호를 먼저 만들고 거기에 그려 넣는 순서를 쓰고 싶을 때의 경로다.
 * 만든 슬롯을 곧바로 선택 상태로 둬서 '시작 → 그리기 → 우클릭' 이 그 슬롯을 채우게 한다(closeDraft).
 * → { state, idx }
 */
export function addEmptySpace(state, key) {
  const idx = nextIdx(state.spaces);
  const list = state.spaces[key] ?? [];
  return {
    state: {
      ...state,
      spaces: { ...state.spaces, [key]: [...list, { idx, points: [], origin: 'new' }] },
      selected: { key, idx },
      dirtyKeys: markDirty(state.dirtyKeys, key),
    },
    idx,
  };
}

/**
 * 우클릭 = 폐합(요구 4). N≥3 이어야 한다.
 *
 * 두 갈래(마스터 지시 2026-07-28):
 *   (a) **ROI 가 비어 있는 슬롯이 선택돼 있으면 그 슬롯을 채운다** — '추가' 로 만든 빈 번호,
 *       또는 'ROI 삭제' 로 비운 슬롯에 다시 그리는 경로. 새 번호를 만들지 않는다.
 *   (b) 선택이 없거나 선택 슬롯에 이미 ROI 가 있으면 **새 주차면으로 append**(자동 추가).
 * 신규 idx = max(현재 최대 idx, 엔트리 수) + 1 → 기존 idx 불변 → DB 는 INSERT 1행(설계서 §5).
 * 폐합 후에도 그리기 모드를 유지한다(연속 드로잉).
 * → { state, error?, warning?, filled? }
 */
export function closeDraft(state, key) {
  const pts = state.draft?.points ?? [];
  if (state.mode !== 'drawing') return { state, error: '그리기 모드가 아닙니다' };
  if (pts.length < MIN_POINTS) {
    return { state, error: `점이 ${pts.length}개입니다 — ${MIN_POINTS}개 이상이어야 면이 됩니다` };
  }
  const warning =
    pts.length === PREFERRED_POINTS
      ? undefined
      : `${pts.length}점 폴리곤 — 지면모델·육면체·점유영역에서 제외됩니다`;

  const list = state.spaces[key] ?? [];
  const sel = state.selected;
  const target = sel && sel.key === key ? list.find((sp) => sp.idx === sel.idx) : null;

  // (a) 빈 슬롯 채우기 — 번호를 새로 만들지 않는다.
  if (target && target.points.length === 0) {
    const spaces = {
      ...state.spaces,
      [key]: list.map((sp) => (sp.idx === target.idx ? { ...sp, points: pts } : sp)),
    };
    return {
      state: { ...state, spaces, draft: null, dirtyKeys: markDirty(state.dirtyKeys, key) },
      warning,
      filled: target.idx,
    };
  }

  // (b) 새 주차면 추가.
  const idx = nextIdx(state.spaces);
  const spaces = { ...state.spaces, [key]: [...list, { idx, points: pts, origin: 'new' }] };
  return {
    state: {
      ...state,
      spaces,
      draft: null,
      selected: { key, idx },
      dirtyKeys: markDirty(state.dirtyKeys, key),
    },
    warning,
  };
}

// --- 선택 · 편집 --------------------------------------------------------

/** 목록/캔버스 선택. null 이면 해제. */
export function selectSpace(state, key, idx) {
  return key == null || idx == null ? { ...state, selected: null } : { ...state, selected: { key, idx } };
}

/**
 * 정지 모드 좌클릭 히트테스트. 정점이 우선이고, 없으면 폴리곤 내부.
 * editable(현재 프리셋 + 보기 범위상 표시) 폴리곤만 대상 — 타 프리셋은 읽기전용(설계서 §6.1.1).
 * → { idx, vertex } | { idx, vertex: null } | null
 */
export function hitTest({ spaces, key, scope, selected, nx, ny, tolX, tolY }) {
  const list = visiblePolygons({ spaces, key, scope, selected }).filter((p) => p.editable && p.points.length);
  // 나중에 그려진 것(배열 뒤)이 위 → 역순 탐색.
  for (let i = list.length - 1; i >= 0; i--) {
    const v = hitTestQuadVertex(list[i].points, nx, ny, tolX, tolY);
    if (v != null) return { idx: list[i].idx, vertex: v };
  }
  for (let i = list.length - 1; i >= 0; i--) {
    if (pointInQuad(nx, ny, list[i].points)) return { idx: list[i].idx, vertex: null };
  }
  return null;
}

/** 정점 드래그(요구 7). moveQuadVertex 위임(0~1 clamp 포함). 대상 없으면 무변경. */
export function moveVertex(state, key, idx, vertexIndex, ndx, ndy) {
  const list = state.spaces[key];
  if (!Array.isArray(list)) return state;
  let touched = false;
  const next = list.map((sp) => {
    if (sp.idx !== idx || !sp.points.length) return sp;
    touched = true;
    return { ...sp, points: moveQuadVertex(sp.points, vertexIndex, ndx, ndy) };
  });
  if (!touched) return state;
  return { ...state, spaces: { ...state.spaces, [key]: next }, dirtyKeys: markDirty(state.dirtyKeys, key) };
}

/**
 * 삭제(마스터 지시 #13) — **선택 슬롯의 그려진 ROI 기하만** 지운다.
 *   origin 'file' : points 를 [] 로 비운다(엔트리·전역 idx 유지 → 재압축·DB 재매핑 없음).
 *   origin 'new'  : 아직 파일·DB 에 없으므로 버퍼에서 제거 + 신규분 idx 재부여.
 * → { state, error? }
 */
export function deleteRoi(state, key, idx) {
  const list = state.spaces[key];
  const target = (list ?? []).find((sp) => sp.idx === idx);
  if (!target) return { state, error: '선택된 주차면이 없습니다' };
  if (target.origin === 'new') {
    const spaces = renumberNewSpaces({ ...state.spaces, [key]: list.filter((sp) => sp.idx !== idx) });
    // 재부여는 **다른 프리셋의 신규 space idx 도** 바꿀 수 있다 → 신규를 가진 프리셋을 전부 dirty 로.
    let dirtyKeys = markDirty(state.dirtyKeys, key);
    for (const k of sortedKeys(spaces)) {
      if (spaces[k].some((sp) => sp.origin === 'new')) dirtyKeys = markDirty(dirtyKeys, k);
    }
    return { state: { ...state, spaces, selected: null, dirtyKeys } };
  }
  if (!target.points.length) return { state, error: '이미 ROI 가 없는 주차면입니다' };
  const spaces = {
    ...state.spaces,
    [key]: list.map((sp) => (sp.idx === idx ? { ...sp, points: [] } : sp)),
  };
  return { state: { ...state, spaces, dirtyKeys: markDirty(state.dirtyKeys, key) } };
}

// --- 표시 모델 ----------------------------------------------------------

/**
 * 캔버스에 그릴 폴리곤 목록(보기 범위 적용, 마스터 지시 #14).
 * current=현재 프리셋 / editable=현재 프리셋이면서 표시 중 / warn=4점 아님 / empty=ROI 없음.
 * ★ 타 프리셋(all)은 좌표계가 달라 위치가 맞지 않는다 → editable:false 로 내려 호출측이 흐리게 그린다.
 */
export function visiblePolygons({ spaces, key, scope, selected }) {
  const mode = VIEW_SCOPES.includes(scope) ? scope : 'preset';
  const out = [];
  for (const k of sortedKeys(spaces)) {
    const current = k === key;
    if (mode !== 'all' && !current) continue;
    for (const sp of spaces[k]) {
      if (mode === 'slot' && !(selected && selected.key === k && selected.idx === sp.idx)) continue;
      out.push({
        key: k,
        idx: sp.idx,
        points: sp.points,
        current,
        editable: current,
        dirty: sp.origin === 'new',
        warn: sp.points.length > 0 && sp.points.length !== PREFERRED_POINTS,
        empty: sp.points.length === 0,
        selected: !!(selected && selected.key === k && selected.idx === sp.idx),
      });
    }
  }
  return out;
}

/**
 * 슬롯 리스트 행 모델(요구 5). 보기 범위를 목록에도 적용한다.
 * → [{ key, idx, cam, preset, pointCount, current, selected, dirty, warn, empty }]
 */
export function buildRoiMakerList({ spaces, key, scope, selected }) {
  return visiblePolygons({ spaces, key, scope, selected }).map((p) => {
    const [cam, preset] = p.key.split(':').map(Number);
    return {
      key: p.key,
      idx: p.idx,
      cam,
      preset,
      pointCount: p.points.length,
      current: p.current,
      selected: p.selected,
      dirty: p.dirty,
      warn: p.warn,
      empty: p.empty,
    };
  });
}

// --- 저장 --------------------------------------------------------------

/** 저장 전 검증. 그리는 중이거나 1~2점 폴리곤이 있으면 막는다. */
export function validateForSave(state) {
  const errors = [];
  const warnings = [];
  if (state.draft?.points?.length) errors.push('그리는 중입니다 — 우클릭으로 폐합하거나 Esc 로 취소하세요');
  for (const key of sortedKeys(state.spaces)) {
    for (const sp of state.spaces[key]) {
      const n = sp.points.length;
      if (n > 0 && n < MIN_POINTS) errors.push(`#${sp.idx}: 점 ${n}개 — ${MIN_POINTS}개 이상 필요`);
      else if (n > 0 && n !== PREFERRED_POINTS) {
        warnings.push(`#${sp.idx}: ${n}점 — 지면모델·육면체·점유영역 제외`);
      }
    }
  }
  if (!state.dirtyKeys.length) errors.push('변경된 내용이 없습니다');
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * 저장 요청 payload(설계서 §7.2). **변경된 프리셋만**, 각 프리셋은 **전체 space** 를 담는다.
 * ★ 전체를 담아야 하는 이유: 서버 applyPlaceRoiUpdate 가 그 프리셋 parking_spaces 를 통째 교체한다.
 * expectRawCount = **로드 시점** 그 프리셋의 주차면 수(현재 버퍼 길이가 아니다).
 *   서버는 이 값을 파일의 **원시** parking_spaces 개수와 대조한다. 두 값이 다르면
 *   (a) 로드 후 다른 곳에서 파일이 바뀌었거나 (b) 정규화에서 조용히 탈락한 주차면이 있다는 뜻이다
 *   — 어느 쪽이든 통째 교체를 하면 안 된다(2026-07-28 8면→7면 소실 사고, D-4).
 *   ★ 현재 버퍼 길이를 쓰면 **내가 방금 추가한 주차면 때문에 내 저장이 막힌다**(라이브에서 실제로 겪음).
 * origin 은 서버 스키마에 없으므로 제거한다.
 */
export function buildSavePayload(state) {
  return state.dirtyKeys
    .filter((key) => Array.isArray(state.spaces[key]))
    .sort((a, b) => {
      const [ca, pa] = a.split(':').map(Number);
      const [cb, pb] = b.split(':').map(Number);
      return ca - cb || pa - pb;
    })
    .map((key) => {
      const [camId, presetIdx] = key.split(':').map(Number);
      const list = state.spaces[key];
      return {
        key,
        camId,
        presetIdx,
        spaces: list.map((sp) => ({ idx: sp.idx, points: sp.points })),
        expectRawCount: state.baseCounts?.[key] ?? list.length,
      };
    });
}

/** 정규화 0~1 클램프(정점은 화면 밖으로 못 나간다 — 드로잉 입력 한정). */
function clamp01(v) {
  return Math.min(1, Math.max(0, Number(v) || 0));
}

/** presetKey 재수출(roimaker.js 가 core.js 를 따로 import 하지 않도록). */
export { presetKey };
