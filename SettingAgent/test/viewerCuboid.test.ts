// 뷰어 육면체 투영(core.js projectCuboid) — 순수 로직. 뷰어는 추정하지 않고 투영만 한다(이중구현 회피).
// 서버 지면모델을 그대로 받아 쓰므로, 여기서 검증할 것은 '투영이 기하학적으로 옳은가' 하나다.

import { describe, it, expect } from 'vitest';
import { projectCuboid, formatGroundBadge, groundModelsByKey } from '../web/core.js';
import type { ViewerGroundModel } from '../web/core.js';
import { buildGroundInputs } from '../src/ground/groundInputs.js';
import { estimateGroundModels } from '../src/ground/groundModel.js';
import { parseCameraViews } from '../src/setup/mapTargets.js';
import { normalizePtzCamRoi } from '../src/capture/placeRoi.js';
import { readFileSync } from 'node:fs';

const DEG = Math.PI / 180;

/** tilt 만 있는 합성 지면모델(카메라고 5m, f 2900px, 1920×1080). */
function model(tiltDeg: number, over: Partial<ViewerGroundModel> = {}): ViewerGroundModel {
  const th = tiltDeg * DEG;
  return {
    camIdx: 1,
    presetIdx: 1,
    imgW: 1920,
    imgH: 1080,
    f: 2900,
    n: [0, Math.cos(th), Math.sin(th)],
    d: 5,
    tiltDeg,
    conf: 0.9,
    source: 'file',
    issues: [],
    ...over,
  };
}

/** 이미지 하단 부근의 바닥 quad(정규화). */
const FLOOR = [
  { x: 0.35, y: 0.78 },
  { x: 0.38, y: 0.67 },
  { x: 0.52, y: 0.67 },
  { x: 0.5, y: 0.78 },
];

describe('projectCuboid — 육면체 8점·12모서리 투영', () => {
  it('h=0 → 상면이 바닥과 정확히 일치', () => {
    const c = projectCuboid(FLOOR, model(18.8), 0)!;
    expect(c).not.toBeNull();
    expect(c.corners).toHaveLength(8);
    expect(c.edges).toHaveLength(12);
    for (let i = 0; i < 4; i++) {
      expect(c.corners[i + 4].x).toBeCloseTo(c.corners[i].x, 10);
      expect(c.corners[i + 4].y).toBeCloseTo(c.corners[i].y, 10);
    }
  });

  it('바닥 4점은 입력 quad 그대로(기존 2D ROI 와 정합)', () => {
    const c = projectCuboid(FLOOR, model(18.8), 1.5)!;
    FLOOR.forEach((p, i) => {
      expect(c.corners[i].x).toBe(p.x);
      expect(c.corners[i].y).toBe(p.y);
    });
  });

  it('h 증가 → 상면이 화면 위로(수직소실점 반대방향) 단조 이동', () => {
    const heights = [0, 0.5, 1.0, 1.5, 2.0, 3.0];
    const ys = heights.map((h) => projectCuboid(FLOOR, model(18.8), h)!.corners[4].y);
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]).toBeLessThan(ys[i - 1]); // y 감소 = 화면 위쪽(카메라가 지면 위에 있으므로).
    }
  });

  it('12 모서리 = 바닥4 + 상면4 + 수직4', () => {
    const c = projectCuboid(FLOOR, model(7), 1.5)!;
    expect(c.edges.slice(0, 4)).toEqual([[0, 1], [1, 2], [2, 3], [3, 0]]);
    expect(c.edges.slice(4, 8)).toEqual([[4, 5], [5, 6], [6, 7], [7, 4]]);
    expect(c.edges.slice(8)).toEqual([[0, 4], [1, 5], [2, 6], [3, 7]]);
  });

  it('수직 모서리가 서로 (거의) 평행하지 않고 하나의 수직소실점으로 수렴한다', () => {
    // 각 수직 모서리를 연장한 직선들의 교점 = 수직소실점. 4개 모서리가 한 점에서 만나야 한다.
    const c = projectCuboid(FLOOR, model(18.8), 2)!;
    const lines = [0, 1, 2, 3].map((i) => {
      const b = c.corners[i];
      const t = c.corners[i + 4];
      return [b.y - t.y, t.x - b.x, b.x * t.y - t.x * b.y]; // 동차 직선.
    });
    const meet = (l1: number[], l2: number[]) => {
      const p = [
        l1[1] * l2[2] - l1[2] * l2[1],
        l1[2] * l2[0] - l1[0] * l2[2],
        l1[0] * l2[1] - l1[1] * l2[0],
      ];
      return { x: p[0] / p[2], y: p[1] / p[2] };
    };
    const v01 = meet(lines[0], lines[1]);
    const v23 = meet(lines[2], lines[3]);
    expect(v01.x).toBeCloseTo(v23.x, 4);
    expect(v01.y).toBeCloseTo(v23.y, 4);
    expect(v01.y).toBeGreaterThan(1); // 하향 카메라 → 수직소실점은 이미지 아래(정규화 y>1).
  });

  it('실측 크기 검증: 지면모델 d=5m·tilt=18.8° 에서 h=1.5m 육면체의 수직 모서리 길이가 물리적으로 타당', () => {
    // 바닥점의 지면 깊이가 커질수록(원거리) 같은 1.5m 가 더 짧게 보여야 한다(원근).
    const g = model(18.8);
    const c = projectCuboid(FLOOR, g, 1.5)!;
    const vlen = (i: number) =>
      Math.hypot(
        (c.corners[i + 4].x - c.corners[i].x) * g.imgW,
        (c.corners[i + 4].y - c.corners[i].y) * g.imgH,
      );
    // FLOOR 의 0,3 은 근변(y=0.78), 1,2 는 원변(y=0.67) → 근변의 수직모서리가 더 길다.
    expect(vlen(0)).toBeGreaterThan(vlen(1));
    expect(vlen(3)).toBeGreaterThan(vlen(2));
  });

  it('퇴화 → null(throw 없음): 모델 없음 / 4점 아님 / 지평선 위 / f·d 비정상 / h 음수', () => {
    expect(projectCuboid(FLOOR, null, 1.5)).toBeNull();
    expect(projectCuboid(FLOOR, undefined, 1.5)).toBeNull();
    expect(projectCuboid([{ x: 0.1, y: 0.1 }], model(18.8), 1.5)).toBeNull();
    expect(projectCuboid(FLOOR, model(18.8, { f: 0 }), 1.5)).toBeNull();
    expect(projectCuboid(FLOOR, model(18.8, { d: 0 }), 1.5)).toBeNull();
    expect(projectCuboid(FLOOR, model(18.8), -1)).toBeNull();
    expect(projectCuboid(FLOOR, model(18.8), NaN)).toBeNull();
    expect(projectCuboid([...FLOOR.slice(0, 3), { x: NaN, y: 0.5 }], model(18.8), 1.5)).toBeNull();
    // 지평선 위(화면 상단, tilt 가 얕아 지면이 아닌 영역) → null.
    const sky = [
      { x: 0.4, y: 0.02 },
      { x: 0.42, y: 0.01 },
      { x: 0.5, y: 0.01 },
      { x: 0.48, y: 0.02 },
    ];
    expect(projectCuboid(sky, model(3), 1.5)).toBeNull();
  });

  it('NaN/Infinity 를 절대 내보내지 않는다', () => {
    for (const tilt of [3, 7, 18.8, 45]) {
      for (const h of [0, 0.5, 1.5, 3]) {
        const c = projectCuboid(FLOOR, model(tilt), h);
        if (!c) continue;
        for (const p of c.corners) {
          expect(Number.isFinite(p.x)).toBe(true);
          expect(Number.isFinite(p.y)).toBe(true);
        }
      }
    }
  });
});

describe('projectCuboid — 픽스처 종단(서버 추정 → 뷰어 투영)', () => {
  const placeRoiJson = JSON.parse(readFileSync('test/fixtures/PtzCamRoi.unity.json', 'utf8'));
  const views = parseCameraViews(JSON.parse(readFileSync('test/fixtures/camerapos.sample.json', 'utf8')));
  const { models } = estimateGroundModels(buildGroundInputs(placeRoiJson, views)[0], {
    minDepthEdgePx: 250,
    slotWidthM: 2.5,
    slotDepthM: 5.0,
  });
  const byKey = groundModelsByKey(models as unknown as ViewerGroundModel[]);
  const { byPreset } = normalizePtzCamRoi(placeRoiJson);

  it('17개 주차면 전부에서 h=1.5m 육면체가 산출된다(퇴화 0)', () => {
    let total = 0;
    for (const [key, spaces] of byPreset) {
      const g = byKey[key];
      expect(g, `지면모델 없음: ${key}`).toBeTruthy();
      for (const sp of spaces) {
        const c = projectCuboid(sp.points, g, 1.5);
        expect(c, `육면체 실패: ${key} idx${sp.idx}`).not.toBeNull();
        // 상면은 바닥보다 화면 위(정규화 y 가 작다).
        for (let i = 0; i < 4; i++) expect(c!.corners[i + 4].y).toBeLessThan(c!.corners[i].y);
        total += 1;
      }
    }
    expect(total).toBe(17); // 파일의 전 주차면.
  });

  it('h=1.5m 승용차 높이가 이미지에서 타당한 픽셀 크기로 나온다(preset 별)', () => {
    const rows: string[] = [];
    for (const [key, spaces] of byPreset) {
      const g = byKey[key];
      const lens = spaces.map((sp) => {
        const c = projectCuboid(sp.points, g, 1.5)!;
        return Math.hypot((c.corners[4].x - c.corners[0].x) * g.imgW, (c.corners[4].y - c.corners[0].y) * g.imgH);
      });
      const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
      rows.push(`${key}: 수직모서리(h=1.5m) 평균 ${avg.toFixed(0)}px  (면 ${spaces.length}개)`);
      expect(avg).toBeGreaterThan(20); // 너무 납작하면 지면모델이 틀린 것.
      expect(avg).toBeLessThan(600); // 너무 크면 스케일(d) 이 틀린 것.
    }
    console.log('\n[육면체 실측]\n' + rows.join('\n'));
  });
});

describe('formatGroundBadge / groundModelsByKey', () => {
  it('모델 없음 → 없음 배지', () => {
    expect(formatGroundBadge(null)).toBe('지면모델: 없음');
  });

  it('파일 소스 배지에 f·tilt·신뢰도가 담긴다', () => {
    const s = formatGroundBadge(model(7.07, { f: 2819, conf: 0.72 }));
    expect(s).toContain('파일(PtzCamRoi)');
    expect(s).toContain('f=2819px');
    expect(s).toContain('tilt=7.1°');
    expect(s).toContain('●●●○'); // conf 0.72 → 3/4.
  });

  it('groundModelsByKey: cam:preset 키 맵 / 비배열 → 빈 객체', () => {
    const m = model(7, { camIdx: 1, presetIdx: 2 });
    expect(groundModelsByKey([m])['1:2']).toBe(m);
    expect(groundModelsByKey(null)).toEqual({});
  });
});
