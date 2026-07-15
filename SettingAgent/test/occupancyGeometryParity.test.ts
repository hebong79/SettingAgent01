import { describe, it, expect } from 'vitest';
import {
  area as webArea,
  rectCorners as webRectCorners,
  convexIntersectionArea as webConvexIntersectionArea,
  polygonArea as webPolygonArea,
  polygonCentroid as webPolygonCentroid,
  groundBand as webGroundBand,
  GROUND_BAND_RATIO as WEB_GBR,
  ON_PLACE_MIN_OVERLAP as WEB_OMO,
} from '../web/occupancy.js';
import { area as srvArea } from '../src/domain/geometry.js';
import {
  rectCorners as srvRectCorners,
  convexIntersectionArea as srvConvexIntersectionArea,
  polygonArea as srvPolygonArea,
  polygonCentroid as srvPolygonCentroid,
} from '../src/domain/polygon.js';
import {
  groundBand as srvGroundBand,
  GROUND_BAND_RATIO as SRV_GBR,
  ON_PLACE_MIN_OVERLAP as SRV_OMO,
} from '../src/capture/onPlaceFilter.js';
import type { NormalizedPoint, NormalizedRect } from '../src/domain/types.js';

/**
 * **bbox 폴백 기하 정의의 서버(TypeScript) ↔ 뷰어(web/occupancy.js) 파리티** — D-1 봉인.
 * 선례: test/quadCentroidParity.test.ts. web/occupancy.js 는 src 원본을 자구 그대로 포팅했으므로
 * 동일 입력에 동일(비트 동일) 출력이어야 한다. 정의가 갈리면 점유가 조용히 뒤집힌다.
 */

const RECTS: NormalizedRect[] = [
  { x: 0.10, y: 0.20, w: 0.30, h: 0.25 },
  { x: 0.0, y: 0.0, w: 1.0, h: 1.0 },
  { x: 0.55, y: 0.60, w: 0.12, h: 0.40 },
  { x: 0.30, y: 0.30, w: 0.0, h: 0.20 }, // 퇴화(w=0)
  { x: 0.30, y: 0.30, w: 0.20, h: 0.0 }, // 퇴화(h=0)
];

const POLYS: NormalizedPoint[][] = [
  [
    { x: 0.10, y: 0.10 },
    { x: 0.50, y: 0.12 },
    { x: 0.48, y: 0.45 },
    { x: 0.08, y: 0.42 },
  ],
  [
    { x: 0.20, y: 0.55 },
    { x: 0.70, y: 0.55 },
    { x: 0.72, y: 0.95 },
    { x: 0.18, y: 0.98 },
  ],
];

describe('occupancy 기하 파리티 — 서버(src) ≡ 뷰어(web/occupancy.js)', () => {
  it('상수 파리티: GROUND_BAND_RATIO · ON_PLACE_MIN_OVERLAP', () => {
    expect(WEB_GBR).toBe(SRV_GBR);
    expect(WEB_OMO).toBe(SRV_OMO);
    expect(WEB_GBR).toBe(0.25);
    expect(WEB_OMO).toBe(0.15);
  });

  it('area ≡ src', () => {
    for (const r of RECTS) expect(webArea(r)).toBe(srvArea(r));
  });

  it('rectCorners ≡ src', () => {
    for (const r of RECTS) expect(webRectCorners(r)).toEqual(srvRectCorners(r));
  });

  it('groundBand(기본 ratio) ≡ src', () => {
    for (const r of RECTS) expect(webGroundBand(r)).toEqual(srvGroundBand(r));
  });

  it('polygonArea ≡ src', () => {
    for (const p of POLYS) expect(webPolygonArea(p)).toBe(srvPolygonArea(p));
  });

  it('polygonCentroid ≡ src', () => {
    for (const p of POLYS) expect(webPolygonCentroid(p)).toEqual(srvPolygonCentroid(p));
  });

  it('convexIntersectionArea ≡ src (밴드 × 폴리곤 전 조합)', () => {
    for (const r of RECTS) {
      const band = webGroundBand(r);
      const corners = webRectCorners(band);
      const srvCorners = srvRectCorners(band);
      for (const p of POLYS) {
        expect(webConvexIntersectionArea(corners, p)).toBe(srvConvexIntersectionArea(srvCorners, p));
      }
    }
  });

  it('무작위 rect×poly 200조합 → 전량 서버 ≡ 뷰어(겹침 면적)', () => {
    let seed = 20260715;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 200; i++) {
      const r: NormalizedRect = { x: rnd() * 0.6, y: rnd() * 0.6, w: rnd() * 0.4, h: rnd() * 0.4 };
      const poly: NormalizedPoint[] = [
        { x: rnd(), y: rnd() },
        { x: rnd(), y: rnd() },
        { x: rnd(), y: rnd() },
        { x: rnd(), y: rnd() },
      ];
      const band = webGroundBand(r);
      expect(webArea(band)).toBe(srvArea(band));
      const web = webConvexIntersectionArea(webRectCorners(band), poly);
      const srv = srvConvexIntersectionArea(srvRectCorners(band), poly);
      expect(web).toBe(srv);
    }
  });
});
