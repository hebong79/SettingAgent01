// 주차면 ROI **단건 편집** 순수 로직 — `web/placeDraw.js` + `web/core.js` 의 편집 규약 서버 포팅.
// 순수·불변·throw 금지(원본 미변형). 파일 I/O 는 호출측(rpc/services/placeSpaces.ts) 소유.
//
// ★ 왜 서버로 올리는가(설계서 §7-1): 현행 `PUT /capture/place-roi` 는 프리셋을 **통째 교체**한다.
//   클라이언트가 전체 배열을 정확히 재구성해야 하고, 하나라도 빠지면 주차면이 조용히 사라진다
//   (2026-07-28 실사고: 8면 → 7면). 외부 제어자에게 그 책임을 넘기면 같은 사고가 반복된다.
//   → read-modify-write 를 **서버가 소유**하고, 클라는 "무엇을 바꿀지"만 말한다.
//
// ★ 두 삭제 규약이 공존하는 이유(실제 UI 두 곳이 서로 다르다 — 어느 쪽도 임의로 바꾸지 않는다):
//   - `clearSpaceGeometry`(ROI 편집 탭 규약): points 만 비우고 **전역번호를 보존**한다.
//     → DB slot_id 재매핑 위험이 원천적으로 없다. **RPC 기본값**.
//   - `removeSpace`(제어 탭 규약): 배열에서 제거하고 남은 전부를 1..N **재압축**한다.
//     → 저장 후 `slot.roi.load` 로 DB 재구성이 필요하다(경고 동반).

import { round5 } from '../util/round.js';
import type { PlaceRoiSpace } from './placeRoi.js';
import type { NormalizedPoint } from '../domain/types.js';

/** `${camId}:${presetIdx}` → 정규화 주차면들. normalizePtzCamRoi().byPreset 과 같은 shape. */
export type PresetSpaceMap = Map<string, PlaceRoiSpace[]>;

/** 좌표 5자리 반올림(영속화 규약 — 편집 시점에 맞춰 두면 저장 전후로 값이 흔들리지 않는다). */
function r5pt(p: NormalizedPoint): NormalizedPoint {
  return { x: round5(p.x), y: round5(p.y) };
}

/** 얕은 복사(값 수준 불변 보장). */
function cloneMap(map: PresetSpaceMap): PresetSpaceMap {
  return new Map([...map].map(([k, v]) => [k, v.map((sp) => ({ ...sp, points: [...sp.points] }))]));
}

/** 전체 면 수(전 카메라·전 프리셋). */
export function totalSpaces(map: PresetSpaceMap): number {
  let n = 0;
  for (const spaces of map.values()) n += spaces.length;
  return n;
}

/**
 * 다음 전역 idx = **전체 면 수 + 1**(`web/placeDraw.js:nextPlaceIdx` 동등).
 * 기존 번호를 하나도 흔들지 않는 "끝 append" 규칙이다 — max+1 이 아니라 count+1 인 점이 규약의 핵심
 * (정본이 1..N 순열을 유지하므로 둘은 정상 상태에서 같은 값이 된다).
 */
export function nextSpaceIdx(map: PresetSpaceMap): number {
  return totalSpaces(map) + 1;
}

/** 프리셋 키 정렬(cam asc → preset asc) — 전역 재부여 순서의 단일 기준. */
function sortedKeys(map: PresetSpaceMap): string[] {
  return [...map.keys()].sort((a, b) => {
    const [ca, pa] = a.split(':').map(Number);
    const [cb, pb] = b.split(':').map(Number);
    return ca - cb || pa - pb;
  });
}

/**
 * 주차면 추가 — 해당 프리셋 **끝에 append**. idx 는 항상 여기서 계산해 붙인다
 * (호출자가 idx 를 누락시킬 방법을 없앤다 — idx 없는 면은 normalizePtzCamRoi 에서 조용히 탈락한다).
 */
export function appendSpace(
  map: PresetSpaceMap,
  key: string,
  points: NormalizedPoint[],
): { map: PresetSpaceMap; idx: number } {
  const next = cloneMap(map);
  const idx = nextSpaceIdx(next);
  const cur = next.get(key) ?? [];
  next.set(key, [...cur, { idx, points: points.map(r5pt) }]);
  return { map: next, idx };
}

/** 주차면 좌표 교체(idx 보존). 대상 없으면 `hit:false` + 원본 그대로. */
export function updateSpace(
  map: PresetSpaceMap,
  key: string,
  idx: number,
  points: NormalizedPoint[],
): { map: PresetSpaceMap; hit: boolean } {
  const spaces = map.get(key);
  if (!spaces?.some((sp) => sp.idx === idx)) return { map, hit: false };
  const next = cloneMap(map);
  next.set(
    key,
    (next.get(key) ?? []).map((sp) => (sp.idx === idx ? { ...sp, points: points.map(r5pt) } : sp)),
  );
  return { map: next, hit: true };
}

/**
 * 삭제(안전) — **기하만 비운다**(`points: []`). 엔트리·전역번호는 그대로 남는다.
 * 전역번호 재압축이 없으므로 DB slot_id 와의 대응이 흔들리지 않는다(ROI 편집 탭 규약).
 */
export function clearSpaceGeometry(
  map: PresetSpaceMap,
  key: string,
  idx: number,
): { map: PresetSpaceMap; hit: boolean } {
  return updateSpace(map, key, idx, []);
}

/**
 * 삭제(재압축) — 엔트리를 제거하고 남은 전부를 상대순서 유지한 채 **1..N 재부여**
 * (`web/core.js:removePlaceSpace` 동등). 없는 idx 면 `hit:false` + 원본 그대로.
 *
 * ⚠️ 전역번호가 바뀌므로 저장 후 DB(slot_setup) 재구성이 필요하다. 호출측이 경고를 실어야 한다.
 */
export function removeSpace(map: PresetSpaceMap, idx: number): { map: PresetSpaceMap; hit: boolean } {
  const keys = sortedKeys(map);
  const flat: Array<{ key: string; space: PlaceRoiSpace }> = [];
  for (const key of keys) for (const space of map.get(key) ?? []) flat.push({ key, space });
  flat.sort((a, b) => a.space.idx - b.space.idx);
  const at = flat.findIndex((it) => it.space.idx === idx);
  if (at < 0) return { map, hit: false };
  flat.splice(at, 1);
  const next: PresetSpaceMap = new Map(keys.map((k) => [k, [] as PlaceRoiSpace[]]));
  flat.forEach((it, i) => {
    next.get(it.key)!.push({ ...it.space, points: [...it.space.points], idx: i + 1 });
  });
  return { map: next, hit: true };
}

/**
 * 프리셋 전체 삭제 — `removeSpace` 를 **큰 idx 부터** 반복한다(`web/placeDraw.js:clearPresetSpaces` 동등).
 * 큰 것부터 지우면 남은 대상 idx 가 재압축으로 흔들리지 않는다. 비운 키는 `[]` 로 남긴다(빈 배열 저장 필요).
 */
export function clearPresetSpaces(map: PresetSpaceMap, key: string): { map: PresetSpaceMap; removed: number } {
  const idxs = (map.get(key) ?? []).map((sp) => sp.idx).sort((a, b) => b - a);
  let cur = map;
  for (const idx of idxs) cur = removeSpace(cur, idx).map;
  return { map: cur, removed: idxs.length };
}

/** 자동보정 변환 파라미터(정규화 좌표계, 중심 기준 스케일 + 평행이동). */
export interface AlignTransform {
  dx?: number;
  dy?: number;
  scale?: number;
  cx?: number;
  cy?: number;
}

/** 점 1개 변환(`web/core.js:applyTranslateScale` 동등). */
export function applyTranslateScale(
  point: NormalizedPoint,
  { dx = 0, dy = 0, scale = 1, cx = 0.5, cy = 0.5 }: AlignTransform,
): NormalizedPoint {
  return { x: cx + scale * (point.x - cx) + dx, y: cy + scale * (point.y - cy) + dy };
}

/**
 * 프리셋 주차면 전체에 변환 적용(`web/core.js:transformPlaceRoiPreset` 동등). idx·순서 보존.
 * 자동보정(`place.align.estimate` → `apply`)의 **적용부**가 서버로 올라온 것이다
 * — 지금까지 이 계산은 브라우저에만 있었다(설계서 §7-3).
 */
export function transformPresetSpaces(spaces: PlaceRoiSpace[], t: AlignTransform): PlaceRoiSpace[] {
  return (spaces ?? []).map((sp) => ({
    ...sp,
    points: (sp.points ?? []).map((p) => r5pt(applyTranslateScale(p, t))),
  }));
}
