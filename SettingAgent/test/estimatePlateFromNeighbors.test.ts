import { describe, it, expect } from 'vitest';
import { estimatePlateQuadFromNeighbors, type PlateNeighbor } from '../src/capture/floorRoi.js';
import { plateAngleRad, projectedSpan } from '../src/domain/geometry.js';
import type { NormalizedRect, NormalizedQuad, NormalizedPoint } from '../src/domain/types.js';

/**
 * 검증자(qa-tester): estimatePlateQuadFromNeighbors — LPD 실패 슬롯의 이웃 기반 예상 quad(설계서 §9).
 * 불변식: 각도추종·상대오프셋 반영·상대크기 반영·위치최근접 선택·이웃0개 undefined·quad 유효성·degenerate 방어.
 * quad 규약 = TL,TR,BR,BL(= plateAngleRad 규약과 동일).
 */

const inRange = (v: number) => v >= -1e-9 && v <= 1 + 1e-9;
const allIn = (q: NormalizedQuad) => q.every((p) => inRange(p.x) && inRange(p.y));

/** 중심 (cx,cy), 반폭 hw, 반높이 hh 의 사각형을 phi(rad) 회전한 OBB quad(TL,TR,BR,BL, y-down). */
function rotatedPlateQuad(cx: number, cy: number, hw: number, hh: number, phi: number): NormalizedQuad {
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  const rot = (x: number, y: number): NormalizedPoint => ({ x: cx + x * c - y * s, y: cy + x * s + y * c });
  return [rot(-hw, -hh), rot(hw, -hh), rot(hw, hh), rot(-hw, hh)];
}

const quadCenter = (q: NormalizedQuad): NormalizedPoint => ({
  x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4,
  y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4,
});

/** 이웃 1개 구성(차량 bbox 중심에 반폭/반높이 지정, 번호판은 bbox 내 분수위치·회전). */
function neighbor(
  vehicle: NormalizedRect,
  frac: { rx: number; ry: number },
  plate: { hw: number; hh: number; deg: number },
): PlateNeighbor {
  const pc = { x: vehicle.x + frac.rx * vehicle.w, y: vehicle.y + frac.ry * vehicle.h };
  return { vehicle, plateQuad: rotatedPlateQuad(pc.x, pc.y, plate.hw, plate.hh, (plate.deg * Math.PI) / 180) };
}

describe('estimatePlateQuadFromNeighbors — 이웃 기반 예상 quad(§9)', () => {
  const target: NormalizedRect = { x: 0.6, y: 0.4, w: 0.2, h: 0.2 };

  it('이웃 0개 → undefined(§9-5)', () => {
    expect(estimatePlateQuadFromNeighbors(target, [])).toBeUndefined();
  });

  it('반환 quad 4점·전부 0~1·TL,TR,BR,BL 각도 라운드트립(§9-6)', () => {
    for (const deg of [0, 12, 25, -18]) {
      const nb: PlateNeighbor = neighbor(
        { x: 0.2, y: 0.4, w: 0.2, h: 0.2 },
        { rx: 0.5, ry: 0.72 },
        { hw: 0.05, hh: 0.02, deg },
      );
      const est = estimatePlateQuadFromNeighbors(target, [nb])!;
      expect(est).toHaveLength(4);
      expect(allIn(est)).toBe(true);
      expect(plateAngleRad(est)).toBeCloseTo((deg * Math.PI) / 180, 6);
    }
  });

  it('각도 추종: plateAngleRad(estimate) ≈ 이웃 θ ±1e-2 rad(§9-1)', () => {
    const nb = neighbor({ x: 0.2, y: 0.4, w: 0.25, h: 0.2 }, { rx: 0.5, ry: 0.7 }, { hw: 0.06, hh: 0.02, deg: 22 });
    const est = estimatePlateQuadFromNeighbors(target, [nb])!;
    expect(Math.abs(plateAngleRad(est) - (22 * Math.PI) / 180)).toBeLessThanOrEqual(1e-2);
  });

  it('상대오프셋 반영: estimate 중심 분수위치 ≈ 이웃 (rx,ry)(다른 bbox 위치·크기)(§9-2)', () => {
    // 이웃과 target 은 위치·크기 모두 다르다 → 분수위치가 스케일 불변으로 보존되는지.
    const nvRect: NormalizedRect = { x: 0.1, y: 0.3, w: 0.3, h: 0.25 };
    const rx = 0.55;
    const ry = 0.68;
    const nb = neighbor(nvRect, { rx, ry }, { hw: 0.05, hh: 0.02, deg: 10 });
    const est = estimatePlateQuadFromNeighbors(target, [nb])!;
    const c = quadCenter(est);
    expect((c.x - target.x) / target.w).toBeCloseTo(rx, 4);
    expect((c.y - target.y) / target.h).toBeCloseTo(ry, 4);
  });

  it('상대크기 반영: estimate 로컬 wp,hp = 이웃 비율 × target bbox(§9-3)', () => {
    const nvRect: NormalizedRect = { x: 0.1, y: 0.3, w: 0.3, h: 0.25 };
    const hw = 0.06;
    const hh = 0.02;
    const deg = 15;
    const nb = neighbor(nvRect, { rx: 0.5, ry: 0.7 }, { hw, hh, deg });
    const est = estimatePlateQuadFromNeighbors(target, [nb])!;
    const theta = (deg * Math.PI) / 180;
    // 이웃 로컬 크기(회전 span) = 2*hw, 2*hh → 비율 × target bbox.
    const rw = (2 * hw) / nvRect.w;
    const rh = (2 * hh) / nvRect.h;
    const wpEst = projectedSpan(est, Math.cos(theta), Math.sin(theta));
    const hpEst = projectedSpan(est, -Math.sin(theta), Math.cos(theta));
    expect(wpEst).toBeCloseTo(rw * target.w, 4);
    expect(hpEst).toBeCloseTo(rh * target.h, 4);
  });

  it('위치 최근접 선택: 서로 다른 각도 이웃 2개 → 더 가까운 이웃 각도 채택(§9-4)', () => {
    // target 중심 (0.7,0.5). near 는 왼쪽 근접(각도 5°), far 는 멀리(각도 40°).
    const near = neighbor({ x: 0.45, y: 0.4, w: 0.2, h: 0.2 }, { rx: 0.5, ry: 0.7 }, { hw: 0.05, hh: 0.02, deg: 5 });
    const far = neighbor({ x: 0.0, y: 0.0, w: 0.2, h: 0.2 }, { rx: 0.5, ry: 0.7 }, { hw: 0.05, hh: 0.02, deg: 40 });
    const est = estimatePlateQuadFromNeighbors(target, [far, near])!;
    expect(plateAngleRad(est)).toBeCloseTo((5 * Math.PI) / 180, 4);
  });

  it('degenerate 방어: 유일 이웃 bbox w≈0 → undefined(§9-8)', () => {
    const deg: PlateNeighbor = {
      vehicle: { x: 0.2, y: 0.4, w: 0, h: 0.2 },
      plateQuad: rotatedPlateQuad(0.25, 0.55, 0.05, 0.02, 0.2),
    };
    expect(estimatePlateQuadFromNeighbors(target, [deg])).toBeUndefined();
  });

  it('degenerate 스킵: degenerate + 정상 이웃 혼재 → 정상 이웃 채택(§9-8)', () => {
    const badNear: PlateNeighbor = {
      vehicle: { x: 0.55, y: 0.4, w: 0, h: 0.2 }, // 최근접이지만 degenerate → 스킵
      plateQuad: rotatedPlateQuad(0.6, 0.55, 0.05, 0.02, (30 * Math.PI) / 180),
    };
    const good = neighbor({ x: 0.3, y: 0.4, w: 0.2, h: 0.2 }, { rx: 0.5, ry: 0.7 }, { hw: 0.05, hh: 0.02, deg: 8 });
    const est = estimatePlateQuadFromNeighbors(target, [badNear, good])!;
    expect(plateAngleRad(est)).toBeCloseTo((8 * Math.PI) / 180, 4);
  });
});
