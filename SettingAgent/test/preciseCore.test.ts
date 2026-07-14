import { describe, it, expect } from 'vitest';
// 순수 ESM(브라우저 API 미참조) 직접 import — 정밀수집 3기능 신규 순수 함수.
import {
  hitTestDetections,
  removeDetection,
  applyTranslateScale,
  transformPlaceRoiPreset,
} from '../web/core.js';

/**
 * 검증자(qa-tester): 정밀수집 페이지 신규 순수 함수(web/core.js).
 * 근거: 01_architect_plan.md §2/§3/§4 + 02_developer_changes.md 기능2/3 순수 함수 시그니처.
 * 기능2(검출 히트/삭제)·기능3(아핀 이동+스케일).
 * (기능1 카메라 프리셋 리스트는 제거 — cameraposListRows/parseLoadedCamerapos 고아화되어 삭제.)
 * DOM 오버레이 편집·단축키·물리이동은 리더 라이브/브라우저 수동(한계).
 */

// ===== 기능2 — hitTestDetections / removeDetection =====

describe('hitTestDetections — 검출 박스 히트테스트(우선순위)', () => {
  const detect = {
    vehicles: [
      { rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }, // index 0
      { rect: { x: 0.6, y: 0.6, w: 0.2, h: 0.2 } }, // index 1
    ],
    plates: [
      { quad: [{ x: 0.4, y: 0.4 }, { x: 0.5, y: 0.4 }, { x: 0.5, y: 0.5 }, { x: 0.4, y: 0.5 }] }, // index 0
    ],
  };
  const tol = 0.02;

  it('vehicle rect 내부 → {kind:vehicle, handle:in}', () => {
    const r = hitTestDetections({ nx: 0.2, ny: 0.2, detect, tolX: tol, tolY: tol, selected: null });
    expect(r).toEqual({ kind: 'vehicle', index: 0, handle: 'in' });
  });

  it('선택된 vehicle 코너 핸들 우선 → handle:nw', () => {
    const r = hitTestDetections({
      nx: 0.1, ny: 0.1, detect, tolX: tol, tolY: tol,
      selected: { kind: 'vehicle', index: 0 },
    });
    expect(r).toEqual({ kind: 'vehicle', index: 0, handle: 'nw' });
  });

  it('plate quad 내부 → {kind:plate}', () => {
    const r = hitTestDetections({ nx: 0.45, ny: 0.45, detect, tolX: tol, tolY: tol, selected: null });
    expect(r).toEqual({ kind: 'plate', index: 0 });
  });

  it('선택된 plate 정점 우선 → {kind:plate, vertex}', () => {
    const r = hitTestDetections({
      nx: 0.4, ny: 0.4, detect, tolX: tol, tolY: tol,
      selected: { kind: 'plate', index: 0 },
    });
    expect(r).toEqual({ kind: 'plate', index: 0, vertex: 0 });
  });

  it('빈 곳 → null', () => {
    const r = hitTestDetections({ nx: 0.95, ny: 0.05, detect, tolX: tol, tolY: tol, selected: null });
    expect(r).toBeNull();
  });

  it('vehicle rect 가 plate quad 보다 우선(겹침)', () => {
    // vehicle[0] 안이자 plate quad 밖의 점은 vehicle. 겹치는 점 구성:
    const overlap = {
      vehicles: [{ rect: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } }],
      plates: [{ quad: [{ x: 0.4, y: 0.4 }, { x: 0.6, y: 0.4 }, { x: 0.6, y: 0.6 }, { x: 0.4, y: 0.6 }] }],
    };
    const r = hitTestDetections({ nx: 0.5, ny: 0.5, detect: overlap, tolX: tol, tolY: tol, selected: null });
    expect(r?.kind).toBe('vehicle');
  });
});

describe('removeDetection — 항목 splice(불변)', () => {
  const detect = {
    vehicles: [{ rect: { x: 0, y: 0, w: 1, h: 1 } }, { rect: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 } }],
    plates: [{ quad: [] }, { quad: [] }],
    meta: 'keep',
  };

  it('vehicle index 제거', () => {
    const r = removeDetection(detect, { kind: 'vehicle', index: 0 });
    expect(r.vehicles).toHaveLength(1);
    expect(r.vehicles![0].rect.x).toBe(0.5);
    expect(r.plates).toHaveLength(2);
  });

  it('plate index 제거', () => {
    const r = removeDetection(detect, { kind: 'plate', index: 1 });
    expect(r.plates).toHaveLength(1);
    expect(r.vehicles).toHaveLength(2);
  });

  it('여타 필드 보존', () => {
    const r = removeDetection(detect, { kind: 'vehicle', index: 0 });
    expect((r as { meta?: string }).meta).toBe('keep');
  });

  it('원본 불변(splice 는 복사본에)', () => {
    const before = JSON.stringify(detect);
    removeDetection(detect, { kind: 'vehicle', index: 0 });
    expect(JSON.stringify(detect)).toBe(before);
  });

  it('인덱스 범위 밖 → 변형 없음', () => {
    const r = removeDetection(detect, { kind: 'vehicle', index: 9 });
    expect(r.vehicles).toHaveLength(2);
    expect(r.plates).toHaveLength(2);
  });

  it('sel 없음 → 얕은복사(길이 유지)', () => {
    const r = removeDetection(detect, null);
    expect(r.vehicles).toHaveLength(2);
    expect(r.vehicles).not.toBe(detect.vehicles);
  });
});

// ===== 기능3 — applyTranslateScale / transformPlaceRoiPreset =====

describe('applyTranslateScale — 중심 기준 이동+스케일 아핀', () => {
  it('항등(dx=dy=0, scale=1) → 불변(부동소수점 근사)', () => {
    const p = { x: 0.3, y: 0.7 };
    const r = applyTranslateScale(p, {});
    expect(r.x).toBeCloseTo(0.3, 10);
    expect(r.y).toBeCloseTo(0.7, 10);
  });

  it('순수 이동', () => {
    const r = applyTranslateScale({ x: 0.3, y: 0.4 }, { dx: 0.1, dy: -0.2 });
    expect(r.x).toBeCloseTo(0.4, 10);
    expect(r.y).toBeCloseTo(0.2, 10);
  });

  it('중심(0.5,0.5) 기준 2배 스케일: 중심점은 불변', () => {
    const r = applyTranslateScale({ x: 0.5, y: 0.5 }, { scale: 2 });
    expect(r.x).toBeCloseTo(0.5, 10);
    expect(r.y).toBeCloseTo(0.5, 10);
  });

  it('중심 기준 2배 스케일: 코너는 중심에서 2배 멀어짐', () => {
    // (0.6,0.6) → 0.5 + 2*(0.1) = 0.7
    const r = applyTranslateScale({ x: 0.6, y: 0.6 }, { scale: 2 });
    expect(r.x).toBeCloseTo(0.7, 10);
    expect(r.y).toBeCloseTo(0.7, 10);
  });

  it('커스텀 중심(cx,cy)', () => {
    const r = applyTranslateScale({ x: 0.2, y: 0.2 }, { scale: 2, cx: 0, cy: 0 });
    expect(r.x).toBeCloseTo(0.4, 10);
    expect(r.y).toBeCloseTo(0.4, 10);
  });
});

describe('transformPlaceRoiPreset — 프리셋 주차면 아핀(불변·idx 보존)', () => {
  const spaces = [
    { idx: 1, points: [{ x: 0.4, y: 0.4 }, { x: 0.6, y: 0.4 }, { x: 0.6, y: 0.6 }, { x: 0.4, y: 0.6 }] },
    { idx: 2, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }] },
  ];

  it('항등변환 → 좌표 불변(부동소수점 근사), idx 보존', () => {
    // 중심 감산·가산으로 비트 정확은 아니나 수치 동등(예: 0.5-0.4=0.0999…).
    const r = transformPlaceRoiPreset(spaces, {});
    expect(r.map((s) => s.idx)).toEqual([1, 2]);
    for (let s = 0; s < spaces.length; s++) {
      for (let p = 0; p < spaces[s].points.length; p++) {
        expect(r[s].points[p].x).toBeCloseTo(spaces[s].points[p].x, 10);
        expect(r[s].points[p].y).toBeCloseTo(spaces[s].points[p].y, 10);
      }
    }
  });

  it('순수 이동: 모든 점에 (dx,dy) 가산', () => {
    const r = transformPlaceRoiPreset(spaces, { dx: 0.1, dy: 0 });
    expect(r[0].points[0].x).toBeCloseTo(0.5, 10);
    expect(r[0].idx).toBe(1);
    expect(r[1].idx).toBe(2);
  });

  it('원본 불변(새 배열/객체)', () => {
    const before = JSON.stringify(spaces);
    const r = transformPlaceRoiPreset(spaces, { scale: 1.5 });
    expect(r).not.toBe(spaces);
    expect(JSON.stringify(spaces)).toBe(before);
  });

  it('null 방어 → []', () => {
    expect(transformPlaceRoiPreset(undefined, {})).toEqual([]);
  });
});
