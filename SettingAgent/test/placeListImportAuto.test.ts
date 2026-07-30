import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// 순수 ESM 모듈(브라우저 API 미참조) 직접 import — 규칙을 값으로 검증한다.
import { importAutoQuads, appendPlaceSpace, hitTestPlaceSpace, clearPresetSpaces } from '../web/placeDraw.js';
import { buildFlatSlotRows } from '../web/core.js';

/**
 * 주차면 목록 — **자동 생성분 가져오기**와 **프리셋별 보기**(마스터 요청 2026-07-30).
 *
 * 배경: 도색선 자동검출 결과는 시안 오버레이로만 그려져 **선택도 편집도 삭제도 되지 않았다**
 * (`roi.auto.apply` 는 정본 보호로 UI 미노출). 목록(placeRoi)으로 옮기면 기존 편집 경로
 * (선택 → 4정점 드래그 → 삭제 → 저장)가 그대로 열린다. 파일·DB 는 이 단계에서 건드리지 않는다.
 */

const HTML = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8');
const APP = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8');

const quad = (x: number, y: number) => [
  { x, y },
  { x: x + 0.1, y },
  { x: x + 0.1, y: y + 0.1 },
  { x, y: y + 0.1 },
];

describe('importAutoQuads — 자동검출 quad → 주차면 목록', () => {
  it('빈 목록에 넣으면 전역 번호 1부터 순서대로 붙는다', () => {
    const r = importAutoQuads(null, '1:2', [quad(0.1, 0.1), quad(0.3, 0.1)]);
    expect(r.added).toBe(2);
    expect(r.skipped).toBe(0);
    expect(r.firstIdx).toBe(1);
    expect(r.placeRoi['1:2'].map((s: { idx: number }) => s.idx)).toEqual([1, 2]);
    expect(r.placeRoi['1:2'][0].points).toHaveLength(4);
  });

  it('기존 면 뒤에 append 한다 — 기존 번호를 흔들지 않는다', () => {
    const base = appendPlaceSpace(null, '1:1', quad(0.5, 0.5)).placeRoi;
    const r = importAutoQuads(base, '1:1', [quad(0.1, 0.1)]);
    expect(r.firstIdx).toBe(2);
    expect(r.placeRoi['1:1'].map((s: { idx: number }) => s.idx)).toEqual([1, 2]);
  });

  it('★ 같은 4점이 이미 있으면 건너뛴다 — 두 번 눌러도 목록이 두 배가 되지 않는다', () => {
    const first = importAutoQuads(null, '1:1', [quad(0.1, 0.1), quad(0.3, 0.1)]);
    const second = importAutoQuads(first.placeRoi, '1:1', [quad(0.1, 0.1), quad(0.3, 0.1)]);
    expect(second.added).toBe(0);
    expect(second.skipped).toBe(2);
    expect(second.firstIdx).toBeNull();
    expect(second.placeRoi['1:1']).toHaveLength(2);
  });

  it('중복과 신규가 섞이면 신규만 들어간다', () => {
    const first = importAutoQuads(null, '1:1', [quad(0.1, 0.1)]);
    const second = importAutoQuads(first.placeRoi, '1:1', [quad(0.1, 0.1), quad(0.6, 0.6)]);
    expect(second.added).toBe(1);
    expect(second.skipped).toBe(1);
    expect(second.firstIdx).toBe(2);
  });

  it('다른 프리셋의 같은 좌표는 중복이 아니다(프리셋마다 화면이 다르다)', () => {
    const first = importAutoQuads(null, '1:1', [quad(0.1, 0.1)]);
    const second = importAutoQuads(first.placeRoi, '1:2', [quad(0.1, 0.1)]);
    expect(second.added).toBe(1);
    expect(second.placeRoi['1:2']).toHaveLength(1);
  });

  it('4점이 아닌 입력은 무시한다(넣지 않고 skipped 로 센다)', () => {
    const r = importAutoQuads(null, '1:1', [[{ x: 0, y: 0 }], quad(0.2, 0.2), null] as never);
    expect(r.added).toBe(1);
    expect(r.skipped).toBe(2);
  });

  it('빈 입력은 원본을 그대로 돌려준다(불변)', () => {
    const base = appendPlaceSpace(null, '1:1', quad(0.5, 0.5)).placeRoi;
    const r = importAutoQuads(base, '1:1', []);
    expect(r.added).toBe(0);
    expect(r.placeRoi).toBe(base);
  });

  it('좌표는 소수 5자리로 저장한다(영속화 규약)', () => {
    const r = importAutoQuads(null, '1:1', [[
      { x: 0.123456789, y: 0.987654321 },
      { x: 0.2, y: 0.9 },
      { x: 0.2, y: 0.95 },
      { x: 0.12, y: 0.95 },
    ]]);
    expect(r.placeRoi['1:1'][0].points[0]).toEqual({ x: 0.12346, y: 0.98765 });
  });
});

describe("buildFlatSlotRows — '이 프리셋만' 보기", () => {
  const placeRoi = {
    '1:1': [{ idx: 1, points: quad(0.1, 0.1) }, { idx: 2, points: quad(0.3, 0.1) }],
    '1:2': [{ idx: 3, points: quad(0.5, 0.1) }],
  };

  it('onlyKey 미지정이면 전 프리셋 평면 목록(종전 동작 그대로)', () => {
    const rows = buildFlatSlotRows({ placeRoi });
    expect(rows.map((r) => r.globalIdx)).toEqual([1, 2, 3]);
  });

  it('onlyKey 지정이면 그 프리셋만 남는다', () => {
    const rows = buildFlatSlotRows({ placeRoi, onlyKey: '1:2' });
    expect(rows.map((r) => r.globalIdx)).toEqual([3]);
    expect(rows[0].key).toBe('1:2');
  });

  it('★ 걸러도 전역 번호는 그대로다 — 번호가 바뀌면 목록의 번호와 수정(번호 변경)이 어긋난다', () => {
    const rows = buildFlatSlotRows({ placeRoi, onlyKey: '1:2' });
    expect(rows[0].globalIdx).toBe(3); // 1 로 다시 매기지 않는다.
  });

  it('해당 프리셋에 면이 없으면 빈 목록(오류 아님)', () => {
    expect(buildFlatSlotRows({ placeRoi, onlyKey: '2:9' })).toEqual([]);
  });
});

describe('뷰어 결선 봉인 — 목록 UI', () => {
  it.each([
    ['id="place-import-auto"', '검출결과 가져오기 버튼'],
    ['id="place-only-preset"', '이 프리셋만 필터'],
    ['id="place-edit-vertex"', '정점 편집 토글'],
    ['id="place-delete"', '삭제 버튼'],
    ['id="slot-list"', '목록 박스'],
  ])('%s (%s)', (needle) => {
    expect(HTML).toContain(needle);
  });

  it("'이 프리셋만' 은 기본 켜짐(마스터 요청 = 프리셋별 목록)", () => {
    expect(HTML).toMatch(/id="place-only-preset" type="checkbox" checked/);
  });

  it('버튼·토글이 함수에 결선돼 있다', () => {
    expect(APP).toContain("$('place-import-auto').addEventListener('click', () => replaceListWithAutoDetect())");
    expect(APP).toContain("$('place-only-preset').addEventListener('change', renderSlotList)");
  });

  it('★ [검출] 은 목록을 교체한다 — [검출 + 채점] 은 하지 않는다(수동 정본이 비교 기준이다)', () => {
    expect(APP).toContain("if (mode === 'detect') replaceListWithAutoDetect({ auto: true })");
  });

  it('교체는 파일·DB 를 쓰지 않고, 되돌리기 스냅샷을 남긴다', () => {
    const body = APP.slice(APP.indexOf('function replaceListWithAutoDetect('), APP.indexOf("/** '수정'"));
    expect(body).toContain('snapshotPlaceRoi(');            // 파괴 직전 스냅샷
    expect(body).toContain('clearPresetSpaces(state.placeRoi, key)'); // 이 프리셋만 비운다
    expect(body).toContain('sealPlaceRoiUndo()');
    expect(body).toContain('markPlaceDirty');
    expect(body).not.toContain('mutFetch'); // 저장·동기화 호출이 섞이면 여기서 걸린다.
  });

  it('★ 검출 결과가 0면이면 기존 목록을 지우지 않는다(검출 실패로 데이터를 잃지 않게)', () => {
    const body = APP.slice(APP.indexOf('function replaceListWithAutoDetect('), APP.indexOf("/** '수정'"));
    const guard = body.indexOf('if (!quads.length)');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf('snapshotPlaceRoi(')); // 빈 결과는 스냅샷·삭제 앞에서 끊긴다.
  });

  it('캔버스 클릭 선택이 정점 히트테스트 **뒤**에 온다(순서가 뒤집히면 핸들을 못 잡는다)', () => {
    // ★ 끝 앵커는 **시작 뒤에서** 찾는다 — 같은 문자열이 앞쪽에도 있어 slice 가 빈 문자열이 되면
    //   아래 단정이 -1 < -1 로 조용히 무의미해진다(실제로 한 번 그렇게 통과할 뻔했다).
    const from = APP.indexOf('const pv = hitTestPlaceVertex(nx, ny)');
    expect(from).toBeGreaterThan(-1);
    const down = APP.slice(from, APP.indexOf('if (state.roiHidden || !state.mapping) return;', from));
    expect(down.indexOf('hitTestPlaceVertex')).toBeLessThan(down.indexOf('hitTestPlaceSpace'));
    expect(down).toContain('!state.placeDraw'); // 그리는 중엔 점 찍기가 우선.
    expect(down).toContain("$('roi-floor').checked"); // 안 보이는 것은 못 고른다.
    expect(down).toContain('selectPlaceSpace({ globalIdx: pHit');
  });

  it('선택하면 정점 편집이 켜진다 — 선택이 곧 크기 조절의 시작(마스터 요청)', () => {
    const body = APP.slice(APP.indexOf('function selectPlaceSpace('), APP.indexOf("/** '수정'"));
    expect(body).toContain("$('place-edit-vertex')");
    expect(body).toContain('vtx.checked = true');
    expect(body).toContain('ensureFloorVisible()'); // 바닥이 꺼져 있으면 핸들이 안 보인다.
  });

  it('교체 직후에도 첫 면이 선택되고 정점 편집이 열린다', () => {
    const body = APP.slice(APP.indexOf('function replaceListWithAutoDetect('), APP.indexOf("/** '수정'"));
    expect(body).toContain('state.selectedPlaceIdx = r.firstIdx');
    expect(body).toContain('vtx.checked = true');
    expect(body).toContain('ensureFloorVisible()');
  });
});

describe('hitTestPlaceSpace — 캔버스에서 면 직접 선택', () => {
  const placeRoi = {
    '1:1': [
      { idx: 1, points: quad(0.1, 0.1) },
      { idx: 2, points: quad(0.5, 0.5) },
    ],
  };

  it('면 안을 찍으면 그 면의 전역 idx', () => {
    expect(hitTestPlaceSpace(placeRoi, '1:1', { x: 0.15, y: 0.15 })).toBe(1);
    expect(hitTestPlaceSpace(placeRoi, '1:1', { x: 0.55, y: 0.55 })).toBe(2);
  });

  it('빈 곳·다른 프리셋·잘못된 입력은 null(선택 해제 경로로 흐른다)', () => {
    expect(hitTestPlaceSpace(placeRoi, '1:1', { x: 0.9, y: 0.9 })).toBeNull();
    expect(hitTestPlaceSpace(placeRoi, '1:2', { x: 0.15, y: 0.15 })).toBeNull();
    expect(hitTestPlaceSpace(null, '1:1', { x: 0.15, y: 0.15 })).toBeNull();
    expect(hitTestPlaceSpace(placeRoi, '1:1', { x: NaN, y: 0.1 })).toBeNull();
  });

  it('겹치면 나중(위에 보이는) 것을 고른다', () => {
    const overlapped = { '1:1': [{ idx: 1, points: quad(0.1, 0.1) }, { idx: 2, points: quad(0.12, 0.12) }] };
    expect(hitTestPlaceSpace(overlapped, '1:1', { x: 0.15, y: 0.15 })).toBe(2);
  });
});

describe('교체 조합 — clearPresetSpaces + importAutoQuads (검출 1회 = 새것만 남는다)', () => {
  it('기존 3면이 사라지고 검출 2면만 남는다(다른 프리셋은 불변)', () => {
    let map = appendPlaceSpace(null, '1:1', quad(0.1, 0.1)).placeRoi;
    map = appendPlaceSpace(map, '1:1', quad(0.3, 0.1)).placeRoi;
    map = appendPlaceSpace(map, '1:1', quad(0.5, 0.1)).placeRoi;
    map = appendPlaceSpace(map, '1:2', quad(0.7, 0.7)).placeRoi; // 다른 프리셋 수작업.
    const r = importAutoQuads(clearPresetSpaces(map, '1:1'), '1:1', [quad(0.2, 0.4), quad(0.4, 0.4)]);
    expect(r.added).toBe(2);
    expect(r.placeRoi['1:1']).toHaveLength(2);
    expect(r.placeRoi['1:2']).toHaveLength(1); // ★ 다른 프리셋은 건드리지 않는다.
    // 전역 번호는 1..N 연속(재압축 후 append).
    const all = Object.values(r.placeRoi).flat().map((s: { idx: number }) => s.idx).sort((a, b) => a - b);
    expect(all).toEqual([1, 2, 3]);
  });
});
