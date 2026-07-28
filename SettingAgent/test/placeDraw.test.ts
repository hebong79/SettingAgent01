import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// 순수 ESM(브라우저 API 미참조) 직접 import — 주차면 신규 그리기 상태머신·idx 부여.
import {
  beginPlaceDraw,
  addPlaceDrawPoint,
  undoPlaceDrawPoint,
  nextPlaceIdx,
  appendPlaceSpace,
  placeQuadOf,
  movePlaceVertex,
  clearPresetSpaces,
  type PlaceRoiMap,
} from '../web/placeDraw.js';
import { normalizeGlobalIdx, normalizePtzCamRoi } from '../web/core.js';

/**
 * Stage 3 — `web/placeDraw.js` 순수 로직.
 * 핵심 봉인: (a) idx 없는 주차면이 **만들어질 수 없다**, (b) 기존 면의 idx·순서·좌표가 **하나도 안 변한다**.
 */

const P = (x: number, y: number) => ({ x, y });
const QUAD = [P(0.1, 0.8), P(0.12, 0.6), P(0.3, 0.62), P(0.28, 0.82)];

describe('그리기 상태머신', () => {
  it('T1 3점까지 full:false, 4점째 full:true, 5번째 클릭은 무시', () => {
    let draw = beginPlaceDraw('1:1');
    expect(draw.points).toEqual([]);
    for (let i = 0; i < 3; i++) {
      const r = addPlaceDrawPoint(draw, QUAD[i]);
      expect(r.full).toBe(false);
      draw = r.draw!;
      expect(draw.points.length).toBe(i + 1);
    }
    const r4 = addPlaceDrawPoint(draw, QUAD[3]);
    expect(r4.full).toBe(true);
    expect(r4.draw!.points.length).toBe(4);
    // 5번째 클릭 — 점이 늘지 않는다(면이 망가지지 않게).
    const r5 = addPlaceDrawPoint(r4.draw, P(0.5, 0.5));
    expect(r5.full).toBe(true);
    expect(r5.draw!.points.length).toBe(4);
  });

  it('T2 undo 로 0개까지 되감기, 빈 상태·null 에서 호출해도 throw 없음', () => {
    let draw = beginPlaceDraw('1:1');
    for (const p of QUAD.slice(0, 2)) draw = addPlaceDrawPoint(draw, p).draw!;
    draw = undoPlaceDrawPoint(draw)!;
    expect(draw.points.length).toBe(1);
    draw = undoPlaceDrawPoint(draw)!;
    expect(draw.points.length).toBe(0);
    expect(() => undoPlaceDrawPoint(draw)).not.toThrow();
    expect(undoPlaceDrawPoint(draw)!.points.length).toBe(0);
    expect(() => undoPlaceDrawPoint(null)).not.toThrow();
    expect(undoPlaceDrawPoint(null)).toBeNull();
  });
});

describe('append + idx 부여', () => {
  it('T3 결과의 모든 space 가 정수 idx 를 갖는다(idx 누락 불가 봉인)', () => {
    let map: PlaceRoiMap | null = null;
    for (let i = 0; i < 3; i++) map = appendPlaceSpace(map, '1:1', QUAD).placeRoi;
    map = appendPlaceSpace(map, '2:1', QUAD).placeRoi;
    const all = Object.values(map!).flat();
    expect(all.length).toBe(4);
    for (const sp of all) expect(Number.isInteger(sp.idx)).toBe(true);
    expect(all.map((s) => s.idx).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it('T5 빈 주차장(null) → 첫 면 idx = 1, 키가 새로 생긴다', () => {
    expect(nextPlaceIdx(null)).toBe(1);
    expect(nextPlaceIdx({})).toBe(1);
    const { placeRoi, idx } = appendPlaceSpace(null, '7:3', QUAD);
    expect(idx).toBe(1);
    expect(Object.keys(placeRoi)).toEqual(['7:3']);
    expect(placeRoi['7:3'][0].idx).toBe(1);
    expect(placeRoi['7:3'][0].points).toEqual(QUAD);
  });

  it('T6 normalizeGlobalIdx(append 결과).changed === false (저장 시 재부여가 안 일어난다)', () => {
    let map: PlaceRoiMap | null = null;
    for (let i = 0; i < 5; i++) map = appendPlaceSpace(map, i < 3 ? '1:1' : '1:2', QUAD).placeRoi;
    const norm = normalizeGlobalIdx(map);
    expect(norm.changed).toBe(false);
  });
});

describe('T4 실데이터 — 기존 면 불변(전역 1..23 에 1면 추가)', () => {
  const raw = JSON.parse(
    readFileSync(fileURLToPath(new URL('../data/Place01/PtzCamRoi.json', import.meta.url)), 'utf-8'),
  );
  // ★ 저장소의 PtzCamRoi.json 은 **프리셋별 idx**(1..7 / 1..4 / 1..2 …)로 커밋돼 있다.
  //   전역 1..N 은 **로드 시 normalizeGlobalIdx 를 거친 뒤**의 상태이고, 앱도 항상 그 경로로 읽는다.
  //   원본 byPreset 을 그대로 쓰면 이 테스트는 "전역번호로 재작성된 미커밋 로컬 파일"에서만 통과한다
  //   (self-invalidating — 클린 체크아웃에서 실패). 그래서 앱과 같은 정규화를 먼저 거친다.
  //   (2026-07-28 병합 시 클린 체크아웃 실패로 발견 · 실데이터 idx 분포로 확인)
  const byPreset = normalizeGlobalIdx(normalizePtzCamRoi(raw).byPreset).placeRoi as PlaceRoiMap;
  const before: PlaceRoiMap = JSON.parse(JSON.stringify(byPreset));
  const total = Object.values(before).flat().length;

  it('정규화 후 실데이터가 전역 1..N 이다(전제 확인)', () => {
    expect(total).toBeGreaterThan(0);
    const idxs = (Object.values(before).flat() as Array<{ idx: number }>).map((s) => s.idx).sort((a, b) => a - b);
    expect(idxs).toEqual(Array.from({ length: total }, (_, i) => i + 1));
  });

  it('1면 추가 후 기존 면의 idx·순서·좌표가 단 하나도 변하지 않는다 · 신규 = N+1', () => {
    const key = Object.keys(byPreset)[0];
    const { placeRoi, idx } = appendPlaceSpace(byPreset, key, QUAD);
    expect(idx).toBe(total + 1);
    for (const k of Object.keys(before)) {
      const prev = before[k];
      const next = placeRoi[k].slice(0, prev.length); // 신규는 끝 append 라 앞쪽은 그대로여야 한다.
      expect(next).toEqual(prev);
    }
    expect(byPreset).toEqual(before); // 원본 미변형(불변).
  });
});

describe('T8 clearPresetSpaces — 프리셋 전량 삭제 + 전역 1..N 재압축', () => {
  /** '1:1' 3면 · '1:2' 2면 · '2:1' 1면 = 전역 1..6. */
  function build(): PlaceRoiMap {
    let map: PlaceRoiMap | null = null;
    for (const key of ['1:1', '1:1', '1:1', '1:2', '1:2', '2:1']) {
      map = appendPlaceSpace(map, key, QUAD).placeRoi;
    }
    return map!;
  }

  it('S4-T1 대상 프리셋만 비고(키는 [] 로 남음) · 다른 프리셋 좌표 불변 · 남은 전역 idx 가 1..N 연속', () => {
    const base = build();
    const out = clearPresetSpaces(base, '1:1');
    expect(out['1:1']).toEqual([]); // 키 보존 — savePlaceRoi 순회에서 빠지면 파일이 안 지워진다.
    expect(out['1:2'].length).toBe(2);
    expect(out['2:1'].length).toBe(1);
    for (const sp of [...out['1:2'], ...out['2:1']]) expect(sp.points).toEqual(QUAD);
    const idxs = Object.values(out).flat().map((s) => s.idx).sort((a, b) => a - b);
    expect(idxs).toEqual([1, 2, 3]);
  });

  it('S4-T2 없는 키·빈 맵·null·idx 없는 원소에서 throw 0 · 원본 미변형', () => {
    const base = build();
    const snap = JSON.parse(JSON.stringify(base));
    expect(clearPresetSpaces(base, '9:9')).toBe(base); // 대상 없음 → 원본 그대로.
    expect(base).toEqual(snap);
    expect(() => clearPresetSpaces(null, '1:1')).not.toThrow();
    expect(clearPresetSpaces(null, '1:1')).toEqual({});
    expect(clearPresetSpaces({}, '1:1')).toEqual({});
    // idx 없는 원소 혼입 — 남은 정상 면만 지우고 죽지 않는다.
    const dirty = { '1:1': [{ points: QUAD } as never, { idx: 1, points: QUAD }] } as unknown as PlaceRoiMap;
    expect(() => clearPresetSpaces(dirty, '1:1')).not.toThrow();
  });

  it('S4-T3 결과가 normalizeGlobalIdx().changed === false (재부여가 더 필요 없는 정합 상태)', () => {
    expect(normalizeGlobalIdx(clearPresetSpaces(build(), '1:1')).changed).toBe(false);
    expect(normalizeGlobalIdx(clearPresetSpaces(build(), '1:2')).changed).toBe(false);
    expect(normalizeGlobalIdx(clearPresetSpaces(build(), '2:1')).changed).toBe(false);
  });

  it('모든 프리셋을 차례로 비우면 전부 [] 이고 키는 그대로다(결정론)', () => {
    let map = build();
    for (const key of ['1:1', '1:2', '2:1']) map = clearPresetSpaces(map, key);
    expect(Object.keys(map).sort()).toEqual(['1:1', '1:2', '2:1']);
    expect(Object.values(map).flat()).toEqual([]);
  });
});

describe('T7 정점 이동 — 불변성·결정론', () => {
  const base = appendPlaceSpace(null, '1:1', QUAD).placeRoi;
  const snapshot = JSON.parse(JSON.stringify(base));

  it('원본 객체가 변형되지 않는다', () => {
    movePlaceVertex(base, '1:1', 1, 2, 0.01, -0.02);
    expect(base).toEqual(snapshot);
  });

  it('같은 입력 → 같은 출력(5자리 반올림 후 결정론)', () => {
    const a = movePlaceVertex(base, '1:1', 1, 2, 0.0123456789, -0.0987654321);
    const b = movePlaceVertex(base, '1:1', 1, 2, 0.0123456789, -0.0987654321);
    expect(a).toEqual(b);
    for (const p of a['1:1'][0].points) {
      expect(Math.round(p.x * 1e5) / 1e5).toBe(p.x);
      expect(Math.round(p.y * 1e5) / 1e5).toBe(p.y);
    }
    // 이동 대상 정점만 바뀐다.
    expect(a['1:1'][0].points[0]).toEqual(QUAD[0]);
    expect(a['1:1'][0].points[2]).not.toEqual(QUAD[2]);
  });

  it('대상 키/idx 가 없으면 원본을 그대로 반환(throw 없음)', () => {
    expect(movePlaceVertex(base, '9:9', 1, 0, 0.1, 0.1)).toBe(base);
    expect(movePlaceVertex(base, '1:1', 99, 0, 0.1, 0.1)).toBe(base);
    expect(() => movePlaceVertex(null, '1:1', 1, 0, 0.1, 0.1)).not.toThrow();
  });

  it('placeQuadOf: 있으면 4점, 없으면 null', () => {
    expect(placeQuadOf(base, '1:1', 1)).toEqual(QUAD);
    expect(placeQuadOf(base, '1:1', 2)).toBeNull();
    expect(placeQuadOf(null, '1:1', 1)).toBeNull();
  });
});
