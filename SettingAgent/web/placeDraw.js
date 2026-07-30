// 주차면(파일 ROI) **신규 그리기** 순수 로직. DOM 접근 0 · throw 금지 · 불변(원본 미변형).
// app.js 는 이 모듈의 반환값을 state 에 대입만 한다(상태머신·idx 부여는 전부 여기).
//
// ★ idx 보장: `appendPlaceSpace` 는 idx 를 **인자로 받지 않는다**. 호출자가 idx 를 누락시킬 방법이 없다.
//   (idx 없는 주차면은 normalizePtzCamRoi 에서 조용히 탈락하고 통째 교체 저장 시 파일에서 사라진다.)

import { moveQuadVertex, pointInQuad, removePlaceSpace } from './core.js';

/** 영속화 규약과 동일한 소수 5자리 반올림(round5 동등 — 그린 좌표가 저장 전후로 흔들리지 않게). */
function r5(n) {
  return Number.isFinite(n) ? Math.round(n * 1e5) / 1e5 : n;
}

/** 그리기 시작 — `${cam}:${preset}` 키의 빈 점 배열. */
export function beginPlaceDraw(key) {
  return { key, points: [] };
}

/**
 * 점 추가(정규화 좌표 {x,y}). 4점을 넘으면 **무시**한다(5번째 클릭이 면을 망가뜨리지 않게).
 * → { draw, full } — full=true 면 4점 완성(호출자가 커밋한다).
 */
export function addPlaceDrawPoint(draw, pt) {
  if (!draw) return { draw, full: false };
  const points = draw.points ?? [];
  if (points.length >= 4) return { draw, full: true };
  const next = [...points, { x: r5(pt?.x), y: r5(pt?.y) }];
  return { draw: { ...draw, points: next }, full: next.length === 4 };
}

/** 마지막 점 되돌리기. 0개면 그대로(throw 없음). */
export function undoPlaceDrawPoint(draw) {
  if (!draw) return draw;
  const points = draw.points ?? [];
  if (!points.length) return draw;
  return { ...draw, points: points.slice(0, -1) };
}

/** 다음 전역 인덱스 = 전체 면 수 + 1(빈 상태·null 이면 1). 기존 번호를 하나도 흔들지 않는 끝 append 규칙. */
export function nextPlaceIdx(placeRoi) {
  const map = placeRoi ?? {};
  let n = 0;
  for (const key of Object.keys(map)) n += Array.isArray(map[key]) ? map[key].length : 0;
  return n + 1;
}

/**
 * 그린 4점을 해당 프리셋 키 **끝에 추가**(불변). idx 는 항상 여기서 계산해 붙인다.
 * → { placeRoi, idx }. 키가 없으면 새로 만든다(빈 주차장의 첫 면).
 */
export function appendPlaceSpace(placeRoi, key, points) {
  const map = placeRoi ?? {};
  const idx = nextPlaceIdx(map);
  const space = { idx, points: (points ?? []).map((p) => ({ x: r5(p.x), y: r5(p.y) })) };
  const cur = Array.isArray(map[key]) ? map[key] : [];
  return { placeRoi: { ...map, [key]: [...cur, space] }, idx };
}

/**
 * 한 프리셋(key)의 주차면을 전부 제거(불변). 전역 1..N 재압축은 core.js `removePlaceSpace` 에 **전량 위임**한다
 * (재번호 로직을 새로 쓰지 않는다 — 전체삭제 = 기존 '삭제' 를 n회 한 것과 동일하다).
 * 큰 idx 부터 지운다: `removePlaceSpace` 는 지운 idx **보다 큰** 것만 당기므로 남은 대상 idx 가 흔들리지 않는다.
 * 대상 키가 없거나 비어 있으면 원본 그대로(throw 금지). 비운 키는 `[]` 로 남는다(빈 배열 PUT 이 필요).
 */
export function clearPresetSpaces(placeRoi, key) {
  const idxs = ((placeRoi ?? {})[key] ?? [])
    .map((sp) => sp?.idx)
    .filter((idx) => Number.isInteger(idx))
    .sort((a, b) => b - a);
  return idxs.reduce((map, idx) => removePlaceSpace(map, idx), placeRoi ?? {});
}

/** 해당 프리셋 키에서 전역 idx 의 4점 조회(없으면 null). 히트테스트·검증 조회용. */
export function placeQuadOf(placeRoi, key, idx) {
  const spaces = (placeRoi ?? {})[key];
  if (!Array.isArray(spaces)) return null;
  const sp = spaces.find((s) => s?.idx === idx);
  return sp?.points ?? null;
}

/**
 * 주차면 1개의 정점 1개만 이동(불변). 이동 자체는 core.js `moveQuadVertex` 에 위임한다(0..1 clamp 포함).
 * 대상이 없으면 원본을 그대로 반환한다.
 */
export function movePlaceVertex(placeRoi, key, idx, vertexIndex, dx, dy) {
  const map = placeRoi ?? {};
  const spaces = map[key];
  if (!Array.isArray(spaces)) return placeRoi;
  let hit = false;
  const next = spaces.map((sp) => {
    if (sp?.idx !== idx) return sp;
    hit = true;
    const moved = moveQuadVertex(sp.points ?? [], vertexIndex, dx, dy);
    return { ...sp, points: moved.map((p) => ({ x: r5(p.x), y: r5(p.y) })) };
  });
  if (!hit) return placeRoi;
  return { ...map, [key]: next };
}

/**
 * 자동 생성된 주차면(도색선 자동검출 결과 quad)을 **주차면 목록에 넣는다**(불변).
 *
 * 자동검출 패널은 결과를 오버레이로만 그린다 — 목록·편집 대상이 아니었다. 이 함수가 그 결과를
 * 편집 가능한 주차면(placeRoi)으로 옮긴다. 파일은 건드리지 않는다(메모리 편집 → 기존 '저장'이 확정).
 *
 * 규약:
 * - **끝 append**(`appendPlaceSpace` 위임) — 기존 면 번호를 하나도 흔들지 않는다.
 * - **중복은 건너뛴다**: 같은 프리셋에 이미 있는 면과 4점이 소수 5자리까지 같으면 넣지 않는다.
 *   (검출 버튼을 두 번 눌러도 목록이 두 배가 되지 않게 — 되돌리기 부담을 만들지 않는다.)
 * - 4점이 아닌 quad 는 무시한다(입력 방어. 자동검출은 사각형만 낸다).
 *
 * @param {Object|null} placeRoi cam:preset → [{idx, points}]
 * @param {string} key `cam:preset`
 * @param {Array<Array<{x:number,y:number}>>} quads 정규화(0~1) 4점 배열들
 * @returns {{placeRoi: Object, added: number, skipped: number, firstIdx: number|null}}
 */
export function importAutoQuads(placeRoi, key, quads) {
  const sig = (pts) => (pts ?? []).map((p) => `${r5(p.x)},${r5(p.y)}`).join('|');
  let map = placeRoi ?? {};
  const seen = new Set(((map[key] ?? [])).map((sp) => sig(sp?.points)));
  let added = 0;
  let skipped = 0;
  let firstIdx = null;
  for (const quad of quads ?? []) {
    if (!Array.isArray(quad) || quad.length !== 4) {
      skipped += 1;
      continue;
    }
    const s = sig(quad);
    if (seen.has(s)) {
      skipped += 1;
      continue;
    }
    seen.add(s);
    const r = appendPlaceSpace(map, key, quad);
    map = r.placeRoi;
    if (firstIdx === null) firstIdx = r.idx;
    added += 1;
  }
  return { placeRoi: map, added, skipped, firstIdx };
}

/**
 * 캔버스 클릭 지점이 들어있는 주차면의 **전역 idx**(없으면 null).
 *
 * 목록 행 클릭 말고 **화면의 면을 직접 눌러 고르기** 위한 히트테스트다(마스터 요청).
 * 겹쳐 있으면 **배열 뒤쪽(=나중에 그려진, 위에 보이는) 것**을 고른다 — 화면에서 위에 보이는 것을
 * 집는 것이 사용자의 기대이기 때문이다. 판정은 core.pointInQuad 에 위임한다(구현 중복 0).
 *
 * @param {Object|null} placeRoi cam:preset → [{idx, points}]
 * @param {string} key `cam:preset`
 * @param {{x:number,y:number}} pt 정규화(0~1) 좌표
 * @returns {number|null}
 */
export function hitTestPlaceSpace(placeRoi, key, pt) {
  const spaces = (placeRoi ?? {})[key];
  if (!Array.isArray(spaces) || !pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return null;
  for (let i = spaces.length - 1; i >= 0; i--) {
    const sp = spaces[i];
    if (Number.isInteger(sp?.idx) && pointInQuad(pt.x, pt.y, sp.points ?? [])) return sp.idx;
  }
  return null;
}
