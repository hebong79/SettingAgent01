import { describe, it, expect } from 'vitest';
import * as web from '../web/occupancyRegion.js';
import * as srv from '../src/domain/occupancyRegion.js';
import type { NormalizedQuad } from '../src/domain/types.js';

/**
 * 검증자(qa-tester): 점유영역 사다리꼴 **브라우저 구현(web/occupancyRegion.js) ↔ 서버 구현
 * (src/domain/occupancyRegion.ts) 출력 동일성**.
 *
 * 배경: 뷰어 라이브 오버레이는 브라우저 순수 ESM 을, 저장 경로(POST /capture/slots/occupy · discovery)는
 *   서버 TS 를 쓴다. 정적 배포 경계 때문에 한쪽을 import 할 수 없어 알고리즘이 두 벌 존재하므로,
 *   **이 테스트가 두 구현의 정의 갈림을 막는 단일 안전장치**다. 상수(배율·비율)도 여기서 함께 고정한다.
 */

/** 각도 θ 로 회전한 번호판 quad(중심 cx,cy · 가로 w · 세로 h). */
function plate(cx: number, cy: number, w: number, h: number, theta = 0): NormalizedQuad {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const pt = (dx: number, dy: number) => ({ x: cx + dx * c - dy * s, y: cy + dx * s + dy * c });
  return [pt(-w / 2, -h / 2), pt(w / 2, -h / 2), pt(w / 2, h / 2), pt(-w / 2, h / 2)];
}

/** 실측에 가까운 케이스 모음(단독·다중·회전·경계·겹침 유발·퇴화). */
const CASES: Array<{ name: string; items: Array<{ idx: number; quad: NormalizedQuad }> }> = [
  { name: '단독 판(중앙)', items: [{ idx: 1, quad: plate(0.5, 0.5, 0.04, 0.012) }] },
  { name: '회전 판(+12°)', items: [{ idx: 1, quad: plate(0.5, 0.5, 0.04, 0.012, 0.21) }] },
  { name: '회전 판(−20°)', items: [{ idx: 1, quad: plate(0.35, 0.6, 0.035, 0.011, -0.35) }] },
  {
    name: '한 줄 7면(실측 유사·겹침 유발)',
    items: [0, 1, 2, 3, 4, 5, 6].map((i) => ({
      idx: i + 1,
      quad: plate(0.11 + i * 0.13, 0.72 - i * 0.017, 0.033, 0.016, -0.12),
    })),
  },
  {
    name: '경계 근접(화면 밖 클립 유발)',
    items: [
      { idx: 1, quad: plate(0.03, 0.05, 0.04, 0.012) },
      { idx: 2, quad: plate(0.97, 0.95, 0.04, 0.012) },
    ],
  },
  {
    name: '밀집(전역 하한에서도 겹침 → 개별 축소 경로)',
    items: [0, 1, 2].map((i) => ({ idx: i + 1, quad: plate(0.45 + i * 0.03, 0.5, 0.03, 0.01) })),
  },
  { name: '퇴화(0-길이 엣지) 포함', items: [{ idx: 1, quad: plate(0.5, 0.5, 0, 0) }, { idx: 2, quad: plate(0.2, 0.3, 0.04, 0.012) }] },
];

describe('점유영역 구현 parity — web/occupancyRegion.js ↔ src/domain/occupancyRegion.ts', () => {
  for (const c of CASES) {
    it(`${c.name}: computeOccupancyRegions 출력이 완전히 동일하다`, () => {
      const a = web.computeOccupancyRegions(c.items);
      const b = srv.computeOccupancyRegions(c.items);
      expect(b).toEqual(a);
    });
  }

  it('plateAxes(축·폭)도 동일하다 — 축 정의가 갈리면 형상이 통째로 어긋난다', () => {
    for (const c of CASES) {
      for (const it of c.items) {
        expect(srv.plateAxes(it.quad)).toEqual(web.plateAxes(it.quad));
      }
    }
  });

  it('형상 상수(배율 3.5~4.0 · 위 0.90 · 아래 0.60 · 평행사변형)를 고정한다', () => {
    expect(srv.REGION_DEFAULTS).toMatchObject({
      widthScaleMin: 3.5,
      widthScaleMax: 4.0,
      topWidthRatio: 1.0,
      upRatio: 0.9,
      downRatio: 0.6,
    });
  });

  it('buildOccupyRegionsBySlot 은 computeOccupancyRegions 결과를 slotId 키로 재포장할 뿐이다', () => {
    const items = CASES[3].items;
    const map = srv.buildOccupyRegionsBySlot(items.map((i) => ({ slotId: i.idx, quad: i.quad })));
    const ref = srv.computeOccupancyRegions(items);
    expect([...map.keys()].sort((x, y) => x - y)).toEqual(ref.regions.map((r) => r.idx).sort((x, y) => x - y));
    for (const r of ref.regions) expect(map.get(r.idx)).toEqual(r.polygon);
  });
});
