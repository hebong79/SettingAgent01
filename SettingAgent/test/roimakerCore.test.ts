import { describe, it, expect } from 'vitest';
import {
  createRoiMakerState,
  loadSpaces,
  toggleDrawMode,
  addEmptySpace,
  addDraftPoint,
  undoDraftPoint,
  cancelDraft,
  closeDraft,
  selectSpace,
  hitTest,
  moveVertex,
  deleteRoi,
  markAllDirty,
  visiblePolygons,
  buildRoiMakerList,
  validateForSave,
  buildSavePayload,
  countSpaces,
} from '../web/roimakerCore.js';
import { pointInQuad, hitTestQuadVertex } from '../web/core.js';

// ROIMaker 순수 상태기계 검증(설계서 §9.1).
// 좌표는 전부 정규화 0~1. DOM 미개입.

const K1 = '1:1';
const K2 = '1:2';

/** 사각형 헬퍼(정규화). */
function rect(x: number, y: number, w: number, h: number) {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

/** 파일에서 온 것처럼 로드된 상태. */
function loaded(placeRoi: Record<string, Array<{ idx: number; points: Array<{ x: number; y: number }> }>>) {
  return loadSpaces(createRoiMakerState(), placeRoi);
}

const BASE = {
  '1:1': [
    { idx: 1, points: rect(0.1, 0.1, 0.2, 0.2) },
    { idx: 2, points: rect(0.5, 0.1, 0.2, 0.2) },
  ],
  '1:2': [{ idx: 3, points: rect(0.1, 0.6, 0.2, 0.2) }],
};

describe('ROIMaker 드로잉 상태기계', () => {
  it('1. 시작 → 점 3개 → 폐합: space 1건 추가, draft 해제, 그리기 모드 유지(연속 드로잉)', () => {
    let s = toggleDrawMode(loaded(BASE));
    expect(s.mode).toBe('drawing');
    s = addDraftPoint(s, 0.2, 0.2);
    s = addDraftPoint(s, 0.4, 0.2);
    s = addDraftPoint(s, 0.4, 0.4);
    expect(s.draft?.points).toHaveLength(3);

    const r = closeDraft(s, K1);
    expect(r.error).toBeUndefined();
    expect(r.state.draft).toBeNull();
    expect(r.state.mode).toBe('drawing'); // 폐합해도 계속 그릴 수 있다.
    expect(r.state.spaces[K1]).toHaveLength(3);
    expect(r.state.dirtyKeys).toEqual([K1]);
  });

  it('2. 점 2개에서 폐합 시도 → 거부 + draft 보존 + 사유', () => {
    let s = toggleDrawMode(loaded(BASE));
    s = addDraftPoint(s, 0.2, 0.2);
    s = addDraftPoint(s, 0.4, 0.2);
    const r = closeDraft(s, K1);
    expect(r.error).toMatch(/3개 이상/);
    expect(r.state.draft?.points).toHaveLength(2); // 폐기하지 않는다.
    expect(r.state.spaces[K1]).toHaveLength(2); // 추가 없음.
  });

  it('3. 5점 폐합 → 저장은 되지만 4점 아님 경고', () => {
    let s = toggleDrawMode(loaded(BASE));
    for (const [x, y] of [[0.2, 0.2], [0.4, 0.2], [0.5, 0.3], [0.4, 0.4], [0.2, 0.4]]) {
      s = addDraftPoint(s, x, y);
    }
    const r = closeDraft(s, K1);
    expect(r.error).toBeUndefined();
    expect(r.warning).toMatch(/5점/);
    expect(r.state.spaces[K1].at(-1)?.points).toHaveLength(5);
    expect(validateForSave(r.state).ok).toBe(true); // 경고이지 오류가 아니다.
  });

  it('4. Backspace 는 마지막 정점만, Esc 는 draft 전체 폐기', () => {
    let s = toggleDrawMode(loaded(BASE));
    s = addDraftPoint(s, 0.2, 0.2);
    s = addDraftPoint(s, 0.4, 0.2);
    s = undoDraftPoint(s);
    expect(s.draft?.points).toHaveLength(1);
    s = undoDraftPoint(s);
    expect(s.draft).toBeNull(); // 0개면 draft 자체 소멸.

    s = addDraftPoint(s, 0.3, 0.3);
    s = cancelDraft(s);
    expect(s.draft).toBeNull();
    expect(s.mode).toBe('drawing'); // 모드는 유지.
  });

  it('5. 신규 idx = N+1 이고 기존 idx 는 하나도 바뀌지 않는다(DB slot_id 불변 근거)', () => {
    const before = loaded(BASE);
    expect(countSpaces(before.spaces)).toBe(3);

    let s = toggleDrawMode(before);
    for (const [x, y] of [[0.2, 0.2], [0.4, 0.2], [0.4, 0.4]]) s = addDraftPoint(s, x, y);
    const first = closeDraft(s, K1).state;
    expect(first.spaces[K1].at(-1)?.idx).toBe(4);

    let s2 = first;
    for (const [x, y] of [[0.6, 0.6], [0.8, 0.6], [0.8, 0.8]]) s2 = addDraftPoint(s2, x, y);
    const second = closeDraft(s2, K2).state;
    expect(second.spaces[K2].at(-1)?.idx).toBe(5);

    // 기존 1·2·3 은 그대로.
    expect(second.spaces[K1].map((sp) => sp.idx).slice(0, 2)).toEqual([1, 2]);
    expect(second.spaces[K2][0].idx).toBe(3);
  });

  it('7. 정지 모드에서는 좌클릭이 정점을 추가하지 않는다(모드 배타성 — 요구 7 과 충돌 방지)', () => {
    const s = addDraftPoint(loaded(BASE), 0.2, 0.2);
    expect(s.draft).toBeNull();
  });

  it('토글로 정지하면 진행 중 draft 는 폐기된다', () => {
    let s = toggleDrawMode(loaded(BASE));
    s = addDraftPoint(s, 0.2, 0.2);
    s = toggleDrawMode(s);
    expect(s.mode).toBe('idle');
    expect(s.draft).toBeNull();
  });
});

describe('ROIMaker 편집(요구 7) · 히트테스트', () => {
  it('6. 정점 드래그는 그 정점만 옮기고 0~1 로 clamp 된다', () => {
    const s0 = loaded(BASE);
    const s = moveVertex(s0, K1, 1, 0, 0.05, 0.05);
    const pts = s.spaces[K1][0].points;
    expect(pts[0]).toEqual({ x: 0.15000000000000002, y: 0.15000000000000002 });
    expect(pts[1]).toEqual({ x: 0.30000000000000004, y: 0.1 }); // 나머지 불변.
    expect(s.dirtyKeys).toEqual([K1]);

    const clamped = moveVertex(s0, K1, 1, 0, -5, -5);
    expect(clamped.spaces[K1][0].points[0]).toEqual({ x: 0, y: 0 });
  });

  it('없는 슬롯/빈 폴리곤 드래그는 무변경(dirty 도 찍지 않는다)', () => {
    const s0 = loaded(BASE);
    expect(moveVertex(s0, K1, 999, 0, 0.1, 0.1)).toBe(s0);
    const emptied = deleteRoi(s0, K1, 1).state;
    const after = moveVertex(emptied, K1, 1, 0, 0.1, 0.1);
    expect(after.spaces[K1][0].points).toEqual([]);
  });

  it('히트테스트: 정점 우선 → 내부 → null. 타 프리셋(all)은 잡히지 않는다', () => {
    const s = loaded(BASE);
    const args = { spaces: s.spaces, key: K1, scope: 'all' as const, selected: null };
    const onVertex = hitTest({ ...args, nx: 0.1, ny: 0.1, tolX: 0.01, tolY: 0.01 });
    expect(onVertex).toEqual({ idx: 1, vertex: 0 });

    const inside = hitTest({ ...args, nx: 0.2, ny: 0.2, tolX: 0.01, tolY: 0.01 });
    expect(inside).toEqual({ idx: 1, vertex: null });

    // 1:2 의 폴리곤 내부지만 현재 프리셋이 아니라 editable=false → 히트 없음.
    const other = hitTest({ ...args, nx: 0.2, ny: 0.7, tolX: 0.01, tolY: 0.01 });
    expect(other).toBeNull();

    expect(hitTest({ ...args, nx: 0.9, ny: 0.9, tolX: 0.01, tolY: 0.01 })).toBeNull();
  });

  it('scope=slot 이면 선택된 슬롯만 편집 대상이다', () => {
    const s = selectSpace(loaded(BASE), K1, 2);
    const args = { spaces: s.spaces, key: K1, scope: 'slot' as const, selected: s.selected };
    expect(hitTest({ ...args, nx: 0.2, ny: 0.2, tolX: 0.01, tolY: 0.01 })).toBeNull(); // #1 숨김.
    expect(hitTest({ ...args, nx: 0.6, ny: 0.2, tolX: 0.01, tolY: 0.01 })).toEqual({ idx: 2, vertex: null });
  });
});

describe("ROIMaker '추가' 버튼 — 주차면 id 만 먼저 만든다(마스터 요청 2026-07-28)", () => {
  it('빈 슬롯(points:[])이 다음 전역 idx 로 생기고 곧바로 선택된다', () => {
    const s0 = loaded(BASE);
    const r = addEmptySpace(s0, K1);
    expect(r.idx).toBe(4); // 기존 3개 → 다음 번호.
    expect(r.state.spaces[K1]).toHaveLength(3);
    expect(r.state.spaces[K1].at(-1)).toEqual({ idx: 4, points: [], origin: 'new' });
    expect(r.state.selected).toEqual({ key: K1, idx: 4 });
    expect(r.state.dirtyKeys).toEqual([K1]);
    // 기존 번호는 하나도 안 바뀐다(DB slot_id 불변).
    expect(r.state.spaces[K1].slice(0, 2).map((sp) => sp.idx)).toEqual([1, 2]);
  });

  it('연속 추가는 번호가 이어진다', () => {
    let s = addEmptySpace(loaded(BASE), K1).state;
    const second = addEmptySpace(s, K2);
    expect(second.idx).toBe(5);
    expect(second.state.spaces[K2].at(-1)?.idx).toBe(5);
  });

  it("추가 → 시작 → 그리기 → 우클릭: **그 번호에 채워지고** 새 번호가 생기지 않는다", () => {
    let s = addEmptySpace(loaded(BASE), K1).state; // #4 (빈 번호, 선택됨)
    s = toggleDrawMode(s);
    for (const [x, y] of [[0.2, 0.2], [0.4, 0.2], [0.4, 0.4], [0.2, 0.4]]) s = addDraftPoint(s, x, y);
    const r = closeDraft(s, K1);

    expect(r.error).toBeUndefined();
    expect(r.filled).toBe(4); // 새로 만든 게 아니라 채운 것.
    expect(r.state.spaces[K1]).toHaveLength(3); // 개수 그대로 — 번호가 늘지 않았다.
    expect(r.state.spaces[K1].at(-1)).toMatchObject({ idx: 4, origin: 'new' });
    expect(r.state.spaces[K1].at(-1)?.points).toHaveLength(4);
  });

  it('ROI 를 지운 기존 슬롯을 선택하고 그리면 그 번호에 다시 채워진다', () => {
    let s = deleteRoi(loaded(BASE), K1, 1).state; // #1 의 ROI 를 비운다.
    s = selectSpace(s, K1, 1);
    s = toggleDrawMode(s);
    for (const [x, y] of [[0.5, 0.5], [0.6, 0.5], [0.6, 0.6]]) s = addDraftPoint(s, x, y);
    const r = closeDraft(s, K1);

    expect(r.filled).toBe(1);
    expect(countSpaces(r.state.spaces)).toBe(3); // 엔트리 수 불변.
    expect(r.state.spaces[K1][0].points).toHaveLength(3);
    expect(r.state.spaces[K1][0].origin).toBe('file'); // 기원은 그대로(저장 시 UPDATE 경로).
  });

  it('선택 슬롯에 이미 ROI 가 있으면 채우지 않고 새 주차면을 만든다(자동 추가 — 기존 동작 보존)', () => {
    let s = selectSpace(loaded(BASE), K1, 1); // #1 은 폴리곤 보유.
    s = toggleDrawMode(s);
    for (const [x, y] of [[0.5, 0.5], [0.6, 0.5], [0.6, 0.6]]) s = addDraftPoint(s, x, y);
    const r = closeDraft(s, K1);

    expect(r.filled).toBeUndefined();
    expect(r.state.spaces[K1]).toHaveLength(3);
    expect(r.state.spaces[K1].at(-1)?.idx).toBe(4);
    expect(r.state.spaces[K1][0].points).toHaveLength(4); // #1 은 그대로.
  });

  it('다른 프리셋의 빈 슬롯이 선택돼 있어도 현재 프리셋에 그리면 새로 만든다(교차 오염 방지)', () => {
    let s = addEmptySpace(loaded(BASE), K2).state; // K2 의 빈 번호가 선택된 상태.
    s = toggleDrawMode(s);
    for (const [x, y] of [[0.2, 0.2], [0.4, 0.2], [0.4, 0.4]]) s = addDraftPoint(s, x, y);
    const r = closeDraft(s, K1); // 그리는 곳은 K1.

    expect(r.filled).toBeUndefined();
    expect(r.state.spaces[K2].at(-1)?.points).toEqual([]); // K2 의 빈 번호는 건드리지 않았다.
    expect(r.state.spaces[K1].at(-1)?.idx).toBe(5);
  });

  it("'추가'로 만든 빈 번호는 삭제로 되돌릴 수 있다(오조작 회수)", () => {
    const added = addEmptySpace(loaded(BASE), K1);
    const r = deleteRoi(added.state, K1, added.idx);
    expect(r.error).toBeUndefined();
    expect(r.state.spaces[K1]).toHaveLength(2);
    expect(countSpaces(r.state.spaces)).toBe(3); // 원상 복귀.
  });
});

describe('ROIMaker 삭제(마스터 지시 #13) — 기하만 지우고 슬롯 엔트리는 남긴다', () => {
  it('파일 기원 ROI 삭제 = points 비우기. idx·엔트리 수 불변(재압축 없음)', () => {
    const s0 = loaded(BASE);
    const r = deleteRoi(s0, K1, 1);
    expect(r.error).toBeUndefined();
    expect(r.state.spaces[K1]).toHaveLength(2); // 엔트리 유지.
    expect(r.state.spaces[K1][0]).toMatchObject({ idx: 1, points: [] });
    expect(countSpaces(r.state.spaces)).toBe(3); // 전체 수 불변 → 전역 idx 순열 유지.
    expect(r.state.dirtyKeys).toEqual([K1]);
  });

  it('이미 비어 있는 ROI 재삭제는 거부', () => {
    const once = deleteRoi(loaded(BASE), K1, 1).state;
    expect(deleteRoi(once, K1, 1).error).toMatch(/이미/);
  });

  it('미저장 신규 ROI 삭제 = 버퍼에서 제거 + 남은 신규 idx 재부여(순열 유지)', () => {
    let s = toggleDrawMode(loaded(BASE));
    for (const [x, y] of [[0.2, 0.2], [0.4, 0.2], [0.4, 0.4]]) s = addDraftPoint(s, x, y);
    s = closeDraft(s, K1).state; // idx 4 (신규)
    for (const [x, y] of [[0.6, 0.6], [0.8, 0.6], [0.8, 0.8]]) s = addDraftPoint(s, x, y);
    s = closeDraft(s, K2).state; // idx 5 (신규)

    const r = deleteRoi(s, K1, 4); // 앞 신규를 지운다.
    expect(r.error).toBeUndefined();
    expect(r.state.spaces[K1]).toHaveLength(2); // 신규 제거.
    // 남은 신규가 4 로 당겨져야 한다 — 아니면 idx 집합이 {1,2,3,5} 가 되어 다음 로드에서 전체 재부여된다.
    expect(r.state.spaces[K2].at(-1)?.idx).toBe(4);
    const all = Object.values(r.state.spaces).flat().map((sp) => sp.idx).sort((a, b) => a - b);
    expect(all).toEqual([1, 2, 3, 4]);
    // 재부여로 idx 가 바뀐 프리셋도 dirty 여야 저장에서 누락되지 않는다.
    expect(r.state.dirtyKeys).toEqual([K1, K2]);
  });

  it('없는 슬롯 삭제는 사유 반환 + 무변경', () => {
    const s0 = loaded(BASE);
    const r = deleteRoi(s0, K1, 999);
    expect(r.error).toMatch(/선택된/);
    expect(r.state).toBe(s0);
  });
});

describe('ROIMaker 보기 범위(마스터 지시 #14) · 목록', () => {
  it('preset=현재 프리셋만 / slot=선택만 / all=전체(타 프리셋은 editable:false)', () => {
    const s = selectSpace(loaded(BASE), K1, 2);
    const base = { spaces: s.spaces, key: K1, selected: s.selected };

    expect(visiblePolygons({ ...base, scope: 'preset' }).map((p) => p.idx)).toEqual([1, 2]);
    expect(visiblePolygons({ ...base, scope: 'slot' }).map((p) => p.idx)).toEqual([2]);

    const all = visiblePolygons({ ...base, scope: 'all' });
    expect(all.map((p) => p.idx)).toEqual([1, 2, 3]);
    expect(all.find((p) => p.idx === 3)).toMatchObject({ current: false, editable: false });
  });

  it('알 수 없는 scope 는 preset 으로 강등(throw 금지)', () => {
    const s = loaded(BASE);
    const rows = visiblePolygons({ spaces: s.spaces, key: K1, scope: 'nonsense', selected: null });
    expect(rows.map((p) => p.idx)).toEqual([1, 2]);
  });

  it('8. 목록 행: 정렬(cam→preset→배열순) + 점개수 + dirty/warn/empty 배지', () => {
    let s = toggleDrawMode(loaded(BASE));
    for (const [x, y] of [[0.2, 0.2], [0.4, 0.2], [0.5, 0.3], [0.4, 0.4], [0.2, 0.4]]) s = addDraftPoint(s, x, y);
    s = closeDraft(s, K1).state; // 5점 신규
    s = deleteRoi(s, K1, 1).state; // #1 은 ROI 없음

    const rows = buildRoiMakerList({ spaces: s.spaces, key: K1, scope: 'all', selected: s.selected });
    expect(rows.map((r) => r.idx)).toEqual([1, 2, 4, 3]); // 1:1 배열순(1,2,신규4) → 1:2(3)
    expect(rows.find((r) => r.idx === 1)).toMatchObject({ empty: true, pointCount: 0 });
    expect(rows.find((r) => r.idx === 4)).toMatchObject({ dirty: true, warn: true, pointCount: 5 });
    expect(rows.find((r) => r.idx === 3)).toMatchObject({ current: false, cam: 1, preset: 2 });
  });
});

describe('ROIMaker 저장 payload · 검증', () => {
  it('9. 변경된 프리셋만, 각 프리셋은 전체 space, expectRawCount 동봉, origin 제거', () => {
    const s = moveVertex(loaded(BASE), K1, 1, 0, 0.01, 0.01);
    const payload = buildSavePayload(s);
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({ key: K1, camId: 1, presetIdx: 1, expectRawCount: 2 });
    expect(payload[0].spaces).toHaveLength(2); // 건드리지 않은 #2 도 포함(통째 교체라 필수).
    expect(Object.keys(payload[0].spaces[0])).toEqual(['idx', 'points']); // origin 미포함.
  });

  it('그리는 중이면 저장 거부', () => {
    let s = toggleDrawMode(moveVertex(loaded(BASE), K1, 1, 0, 0.01, 0.01));
    s = addDraftPoint(s, 0.5, 0.5);
    const v = validateForSave(s);
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toMatch(/그리는 중/);
  });

  it('변경 없음이면 저장 거부', () => {
    expect(validateForSave(loaded(BASE)).ok).toBe(false);
  });

  it('빈 ROI(삭제된 슬롯)는 오류가 아니라 정상 저장 대상', () => {
    const s = deleteRoi(loaded(BASE), K1, 1).state;
    const v = validateForSave(s);
    expect(v.ok).toBe(true);
    expect(buildSavePayload(s)[0].spaces[0]).toEqual({ idx: 1, points: [] });
  });

  it('markAllDirty: 전 프리셋이 저장 대상이 된다 — 파일이 프리셋별 번호일 때의 수렴 저장', () => {
    // 라이브 실측 결함(2026-07-28): 실 PtzCamRoi.json 은 프리셋마다 idx 가 1 부터 다시 시작한다.
    // 로드 시 normalizeGlobalIdx 가 전역 1..N 을 재부여하므로 버퍼가 파일과 전 프리셋에서 다르고,
    // 변경분만 저장하면 파일이 혼합 번호가 되어 다음 로드에서 전역번호가 밀린다(DB slot_id 불일치 16건).
    const s = markAllDirty(loaded(BASE));
    expect(s.dirtyKeys).toEqual([K1, K2]);
    const payload = buildSavePayload(s);
    expect(payload.map((p) => p.key)).toEqual([K1, K2]);
    expect(payload.map((p) => p.expectRawCount)).toEqual([2, 1]);
    expect(validateForSave(s).ok).toBe(true); // 편집이 없어도 저장은 정당하다(번호 수렴 쓰기).
  });

  it('expectRawCount 는 **로드 시점** 개수다 — 방금 추가한 주차면이 자기 저장을 막으면 안 된다', () => {
    // 라이브 실측 결함(2026-07-28): 현재 버퍼 길이를 보내면 신규 1건 추가 직후 8 vs 파일 7 로 409 가 났다.
    let s = toggleDrawMode(loaded(BASE));
    for (const [x, y] of [[0.2, 0.2], [0.4, 0.2], [0.4, 0.4]]) s = addDraftPoint(s, x, y);
    s = closeDraft(s, K1).state;
    expect(s.spaces[K1]).toHaveLength(3);
    expect(buildSavePayload(s)[0].expectRawCount).toBe(2); // 파일에 있던 개수.
    expect(buildSavePayload(s)[0].spaces).toHaveLength(3); // 보내는 내용은 신규 포함 전체.
  });

  it('저장 payload 는 cam→preset 오름차순', () => {
    let s = moveVertex(loaded(BASE), K2, 3, 0, 0.01, 0.01);
    s = moveVertex(s, K1, 1, 0, 0.01, 0.01);
    expect(buildSavePayload(s).map((p) => p.key)).toEqual([K1, K2]);
  });
});

describe('빈 폴리곤(points:[]) 다운스트림 안전성 — 삭제가 만드는 상태', () => {
  it('9-2. pointInQuad·hitTestQuadVertex 는 빈 배열에서 throw 하지 않는다', () => {
    expect(pointInQuad(0.5, 0.5, [])).toBe(false);
    expect(hitTestQuadVertex([], 0.5, 0.5, 0.01, 0.01)).toBeNull();
  });
});
