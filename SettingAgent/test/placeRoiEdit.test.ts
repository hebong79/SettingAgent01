import { describe, it, expect } from 'vitest';
// 브라우저 API 미참조 순수 ESM — 기존 관례대로 web 모듈을 직접 import 해 **파리티**를 고정한다.
import { appendPlaceSpace, clearPresetSpaces as clearPresetSpacesWeb, nextPlaceIdx } from '../web/placeDraw.js';
import { removePlaceSpace } from '../web/core.js';
import {
  appendSpace,
  clearPresetSpaces,
  clearSpaceGeometry,
  nextSpaceIdx,
  removeSpace,
  totalSpaces,
  transformPresetSpaces,
  updateSpace,
  applyTranslateScale,
  type PresetSpaceMap,
} from '../src/capture/placeRoiEdit.js';
import type { PlaceRoiSpace } from '../src/capture/placeRoi.js';

/**
 * 검증자(qa-tester): 주차면 단건 편집 순수 로직(`src/capture/placeRoiEdit.ts`).
 *
 * ★ 이 파일의 핵심은 **웹 클라이언트와의 파리티**다. 편집 규약이 서버로 올라오면서 두 벌이 되면
 *   "웹에서 지운 것과 RPC 로 지운 것이 다른 결과" 가 된다 — 그 순간 정본이 갈린다.
 *   그래서 같은 입력에 대해 `web/placeDraw.js`·`web/core.js` 와 **동일 출력**임을 못박는다.
 */

const quad = (n: number) => [
  { x: 0.1 * n, y: 0.1 },
  { x: 0.1 * n + 0.05, y: 0.1 },
  { x: 0.1 * n + 0.05, y: 0.2 },
  { x: 0.1 * n, y: 0.2 },
];

/** 서버 Map ↔ 웹 객체 변환(동일 데이터의 두 표현). */
function toObj(map: PresetSpaceMap): Record<string, PlaceRoiSpace[]> {
  return Object.fromEntries([...map.entries()]);
}
function toMap(obj: Record<string, PlaceRoiSpace[]>): PresetSpaceMap {
  return new Map(Object.entries(obj));
}

function fixture(): PresetSpaceMap {
  return new Map<string, PlaceRoiSpace[]>([
    ['1:1', [{ idx: 1, points: quad(1) }, { idx: 2, points: quad(2) }, { idx: 3, points: quad(3) }]],
    ['1:2', [{ idx: 4, points: quad(4) }, { idx: 5, points: quad(5) }]],
  ]);
}

describe('idx 부여', () => {
  it('nextSpaceIdx = 전체 면 수 + 1 (웹 nextPlaceIdx 와 동일)', () => {
    const map = fixture();
    expect(nextSpaceIdx(map)).toBe(6);
    expect(nextPlaceIdx(toObj(map))).toBe(6);
  });

  it('빈 상태에서 첫 면은 idx=1', () => {
    expect(nextSpaceIdx(new Map())).toBe(1);
  });
});

describe('appendSpace — 웹 appendPlaceSpace 파리티', () => {
  it('같은 입력 → 같은 출력(좌표 5자리 반올림 포함)', () => {
    const map = fixture();
    const srv = appendSpace(map, '1:2', [{ x: 0.123456789, y: 0.5 }, { x: 0.2, y: 0.5 }, { x: 0.2, y: 0.6 }]);
    const web = appendPlaceSpace(toObj(map), '1:2', [{ x: 0.123456789, y: 0.5 }, { x: 0.2, y: 0.5 }, { x: 0.2, y: 0.6 }]);
    expect(srv.idx).toBe(web.idx);
    expect(toObj(srv.map)).toEqual(web.placeRoi);
    expect(srv.map.get('1:2')![2].points[0].x).toBe(0.12346); // r5
  });

  it('없는 키에 추가하면 키가 생긴다', () => {
    const { map, idx } = appendSpace(new Map(), '2:1', quad(1));
    expect(idx).toBe(1);
    expect(map.get('2:1')).toHaveLength(1);
  });

  it('원본을 변형하지 않는다(불변)', () => {
    const map = fixture();
    appendSpace(map, '1:1', quad(9));
    expect(map.get('1:1')).toHaveLength(3);
  });
});

describe('updateSpace', () => {
  it('좌표만 바꾸고 idx·순서는 보존', () => {
    const { map, hit } = updateSpace(fixture(), '1:1', 2, quad(7));
    expect(hit).toBe(true);
    expect(map.get('1:1')!.map((s) => s.idx)).toEqual([1, 2, 3]);
    expect(map.get('1:1')![1].points[0].x).toBeCloseTo(0.7, 5);
  });

  it('없는 idx → hit:false, 원본 그대로', () => {
    const map = fixture();
    const r = updateSpace(map, '1:1', 99, quad(1));
    expect(r.hit).toBe(false);
    expect(r.map).toBe(map);
  });
});

describe('clearSpaceGeometry — 기하만 비움(전역번호 보존)', () => {
  it('points 만 [] 가 되고 개수·번호는 그대로', () => {
    const { map, hit } = clearSpaceGeometry(fixture(), '1:1', 2);
    expect(hit).toBe(true);
    expect(totalSpaces(map)).toBe(5);
    expect(map.get('1:1')!.map((s) => s.idx)).toEqual([1, 2, 3]);
    expect(map.get('1:1')![1].points).toEqual([]);
    // ★ DB slot_id 재매핑 위험이 없다는 것이 이 규약의 존재 이유다.
    expect(map.get('1:2')!.map((s) => s.idx)).toEqual([4, 5]);
  });
});

describe('removeSpace — 재압축(웹 core.removePlaceSpace 파리티)', () => {
  it('지운 뒤 남은 전부가 1..N 으로 재부여된다', () => {
    const { map, hit } = removeSpace(fixture(), 2);
    expect(hit).toBe(true);
    expect(totalSpaces(map)).toBe(4);
    expect(map.get('1:1')!.map((s) => s.idx)).toEqual([1, 2]);
    expect(map.get('1:2')!.map((s) => s.idx)).toEqual([3, 4]);
  });

  it('웹 구현과 동일 결과', () => {
    const map = fixture();
    const srv = removeSpace(map, 4);
    const web = removePlaceSpace(toObj(map), 4);
    expect(toObj(srv.map)).toEqual(web);
  });

  it('없는 idx → hit:false, 원본 그대로', () => {
    const map = fixture();
    const r = removeSpace(map, 42);
    expect(r.hit).toBe(false);
    expect(r.map).toBe(map);
  });
});

describe('clearPresetSpaces — 웹 파리티', () => {
  it('한 프리셋만 비우고 나머지는 1..N 재압축', () => {
    const { map, removed } = clearPresetSpaces(fixture(), '1:1');
    expect(removed).toBe(3);
    expect(map.get('1:1')).toEqual([]);
    expect(map.get('1:2')!.map((s) => s.idx)).toEqual([1, 2]);
  });

  it('웹 clearPresetSpaces 와 동일 결과', () => {
    const map = fixture();
    expect(toObj(clearPresetSpaces(map, '1:1').map)).toEqual(clearPresetSpacesWeb(toObj(map), '1:1'));
    expect(toObj(clearPresetSpaces(map, '1:2').map)).toEqual(clearPresetSpacesWeb(toObj(map), '1:2'));
  });

  it('빈 키 → removed 0', () => {
    expect(clearPresetSpaces(fixture(), '9:9').removed).toBe(0);
  });
});

describe('자동보정 변환 — 웹 applyTranslateScale/transformPlaceRoiPreset 파리티', () => {
  it('중심(0.5,0.5) 기준 스케일 + 평행이동', () => {
    expect(applyTranslateScale({ x: 0.5, y: 0.5 }, { scale: 2 })).toEqual({ x: 0.5, y: 0.5 }); // 중심은 불변
    expect(applyTranslateScale({ x: 0.6, y: 0.5 }, { scale: 2 })).toEqual({ x: 0.7, y: 0.5 }); // 중심에서 2배
    const t = applyTranslateScale({ x: 0.5, y: 0.5 }, { dx: 0.1, dy: -0.2 });
    expect(t.x).toBeCloseTo(0.6, 10);
    expect(t.y).toBeCloseTo(0.3, 10);
  });

  it('scale=1·dx=dy=0 이면 좌표가 유지된다(5자리 정규화 오차 이내)', () => {
    // ★ 웹(core.js)과 달리 서버는 편집 시점에 r5 를 적용한다 — 저장(stringify5) 전후로 값이 흔들리지 않게 하려는 것.
    //   따라서 "완전 항등" 이 아니라 "5자리에서 동일" 이 정확한 계약이다(최종 파일은 어느 쪽이든 같다).
    const spaces = fixture().get('1:1')!;
    const out = transformPresetSpaces(spaces, { dx: 0, dy: 0, scale: 1 });
    out.forEach((sp, i) => {
      sp.points.forEach((p, j) => {
        expect(p.x).toBeCloseTo(spaces[i].points[j].x, 5);
        expect(p.y).toBeCloseTo(spaces[i].points[j].y, 5);
      });
    });
  });

  it('idx·개수·순서는 보존하고 좌표만 바뀐다', () => {
    const spaces = fixture().get('1:1')!;
    const out = transformPresetSpaces(spaces, { dx: 0.01, dy: 0.02, scale: 1.1 });
    expect(out.map((s) => s.idx)).toEqual([1, 2, 3]);
    expect(out[0].points).toHaveLength(4);
    expect(out[0].points[0].x).not.toBe(spaces[0].points[0].x);
  });

  it('빈 배열·null 안전(throw 금지)', () => {
    expect(transformPresetSpaces([], { dx: 1 })).toEqual([]);
    expect(transformPresetSpaces(undefined as unknown as PlaceRoiSpace[], {})).toEqual([]);
  });
});

describe('Map ↔ 객체 왕복', () => {
  it('toMap(toObj(x)) === x', () => {
    const map = fixture();
    expect(toObj(toMap(toObj(map)))).toEqual(toObj(map));
  });
});
