import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildApplySpaces,
  ON_LATTICE_MAX_M,
  planAutoRoi,
  type PresetPlan,
} from '../src/ground/autoRoiPlan.js';
import { buildGroundInputs } from '../src/ground/groundInputs.js';
import { gridKeyOf, emptyGroundGridFile, upsertCameraGrids } from '../src/ground/gridStore.js';
import type { GroundOptions } from '../src/ground/types.js';

/**
 * QA 재수정 라운드 — 우선순위 1/3/5 회귀 봉인.
 *
 * 핵심 결론(실측):
 *   ① `colStart` 자동 선택으로 **자기 열 성공률 4/5 → 5/5**.
 *   ② 그럼에도 **교차 프리셋 이식은 0건**이고, 그것은 창(colStart) 문제가 **아니라** 정보 한계다
 *      — 다른 열의 슬롯은 격자 lattice 에서 1.321m / 1.791m 벗어나 있고, 이 이탈은
 *        **격자 평행이동(colStart)에 불변**이다(최근접 격자점까지의 거리이므로).
 */

const OPTS: GroundOptions = { minDepthEdgePx: 250, slotWidthM: 2.5, slotDepthM: 5.0 };
const ROI_FILE = 'test/fixtures/groundGrid.PtzCamRoi.json';
const RAW = JSON.parse(readFileSync(ROI_FILE, 'utf8'));
const CAMS = buildGroundInputs(RAW, []);

/** (cam,preset) 의 첫 주차면을 기준면(정규화 4점)으로. */
function refQuadNorm(camIdx: number, presetIdx: number) {
  const cam = CAMS.find((c) => c.camIdx === camIdx)!;
  const p = cam.presets.find((q) => q.presetIdx === presetIdx)!;
  return p.quads[0].map((pt) => ({ x: pt.x / cam.imgW, y: pt.y / cam.imgH }));
}
function fileCountOf(camIdx: number, presetIdx: number) {
  return CAMS.find((c) => c.camIdx === camIdx)!.presets.find((q) => q.presetIdx === presetIdx)!.quads.length;
}

describe('★ 우선순위1-a — colStart 자동 선택(결정론)', () => {
  it('cam2 preset1: 지정 없이도 6/6 매칭된다(QA 결함 5 — 예전엔 colStart=-5 수동 필요)', () => {
    const { plan, issues } = planAutoRoi({
      placeRoiJson: RAW, camIdx: 2, presetIdx: 1, quadNorm: refQuadNorm(2, 1),
      cols: 6, rows: 1, opts: OPTS,
    });
    const p = plan!.presets.find((x) => x.presetIdx === 1)!;
    expect(p.matched).toBe(6);
    expect(p.applicable).toBe(true);
    expect(p.avgIoU!).toBeGreaterThan(0.99);
    expect(issues.join(' ')).toContain('격자 창 자동 선택');
  });

  it('autoOffset:false 면 지정값을 그대로 쓴다(수동 오버라이드 보존)', () => {
    const { plan } = planAutoRoi({
      placeRoiJson: RAW, camIdx: 2, presetIdx: 1, quadNorm: refQuadNorm(2, 1),
      cols: 6, rows: 1, colStart: 0, autoOffset: false, opts: OPTS,
    });
    expect(plan!.presets.find((x) => x.presetIdx === 1)!.matched).toBeLessThan(6);
  });

  it('결정론: 자동 선택 2회 실행 결과 동일', () => {
    const run = () =>
      JSON.stringify(
        planAutoRoi({ placeRoiJson: RAW, camIdx: 2, presetIdx: 1, quadNorm: refQuadNorm(2, 1), cols: 6, rows: 1, opts: OPTS })
          .plan!.grid,
      );
    expect(run()).toBe(run());
  });

  it('★ 자기 열 자동생성 성공률 = 5/5 (QA 측정 4/5 에서 개선)', () => {
    const cases: Array<[number, number, number, number]> = [
      // cam, preset, cols, rows  ← 그 열의 형상(폭방향 반복 / 깊이방향 반복)
      [1, 1, 7, 1], [1, 2, 4, 1], [1, 3, 1, 2], [2, 1, 6, 1], [2, 2, 4, 1],
    ];
    for (const [camIdx, presetIdx, cols, rows] of cases) {
      const { plan } = planAutoRoi({
        placeRoiJson: RAW, camIdx, presetIdx, quadNorm: refQuadNorm(camIdx, presetIdx), cols, rows, opts: OPTS,
      });
      expect(plan, `cam${camIdx} preset${presetIdx} 부트스트랩`).toBeTruthy();
      const p = plan!.presets.find((x) => x.presetIdx === presetIdx)!;
      expect(p.matched, `cam${camIdx} preset${presetIdx}`).toBe(fileCountOf(camIdx, presetIdx));
      expect(p.applicable, `cam${camIdx} preset${presetIdx}`).toBe(true);
      expect(p.avgIoU!, `cam${camIdx} preset${presetIdx}`).toBeGreaterThan(0.99);
    }
  });
});

describe('★ 우선순위1-b — 교차 프리셋 이식 0건은 창 문제가 아니라 정보 한계', () => {
  it('다른 열의 슬롯은 lattice 이탈이 임계를 크게 넘는다(1.3m / 1.8m ≫ 0.25m)', () => {
    const { plan } = planAutoRoi({
      placeRoiJson: RAW, camIdx: 1, presetIdx: 1, quadNorm: refQuadNorm(1, 1), cols: 7, rows: 1, opts: OPTS,
    });
    const p2 = plan!.presets.find((x) => x.presetIdx === 2)!;
    const p3 = plan!.presets.find((x) => x.presetIdx === 3)!;
    expect(p2.onLattice).toBe(0);
    expect(p3.onLattice).toBe(0);
    expect(p2.medianResidM!).toBeGreaterThan(ON_LATTICE_MAX_M);
    expect(p2.medianResidM!).toBeCloseTo(1.321, 2);
    expect(p3.medianResidM!).toBeCloseTo(1.791, 2);
  });

  it('★ 결정적 반증: 격자를 10000칸으로 펼쳐도(창 위치 무의미) 다른 열은 여전히 matched=0', () => {
    const { plan } = planAutoRoi({
      placeRoiJson: RAW, camIdx: 1, presetIdx: 1, quadNorm: refQuadNorm(1, 1),
      cols: 200, rows: 50, colStart: -100, rowStart: -25, autoOffset: false, opts: OPTS,
    });
    const p1 = plan!.presets.find((x) => x.presetIdx === 1)!;
    expect(p1.matched).toBe(7); // 자기 열은 여전히 전부 잡힌다.
    for (const idx of [2, 3]) {
      const p = plan!.presets.find((x) => x.presetIdx === idx)!;
      expect(p.matched, `preset${idx}`).toBe(0);
      expect(p.applicable, `preset${idx}`).toBe(false);
    }
  });

  it('lattice 이탈은 창 평행이동에 불변이다(= 스윕해도 답이 같다는 근거)', () => {
    const resid = (colStart: number, rowStart: number) =>
      planAutoRoi({
        placeRoiJson: RAW, camIdx: 1, presetIdx: 1, quadNorm: refQuadNorm(1, 1),
        cols: 7, rows: 3, colStart, rowStart, autoOffset: false, opts: OPTS,
      }).plan!.presets.find((x) => x.presetIdx === 2)!.medianResidM;
    const base = resid(0, 0);
    for (const [c, r] of [[-9, -2], [5, 1], [17, 3]]) expect(resid(c, r)).toBeCloseTo(base!, 10);
  });
});

describe('★ 오매칭 차단 (재수정 라운드에서 실측으로 발견)', () => {
  it('90° 뒤집힌 다른 열에 격자가 우연히 겹쳐도 적용되지 않는다(예전 IoU 0.3995/0.3769 통과했음)', () => {
    const { plan } = planAutoRoi({
      placeRoiJson: RAW, camIdx: 1, presetIdx: 1, quadNorm: refQuadNorm(1, 1),
      cols: 60, rows: 20, colStart: -30, rowStart: -10, autoOffset: false, opts: OPTS,
    });
    const p3 = plan!.presets.find((x) => x.presetIdx === 3)!;
    expect(p3.matched).toBe(0); // on-lattice 게이트가 후보에서 제외한다.
    expect(p3.applicable).toBe(false);
    expect(p3.offLattice).toEqual([12, 13]);
  });
});

describe('★ 우선순위4 — fovBaseV 차용 폴백(QA 결함 4)', () => {
  it('cam1 preset3 은 단독 f²≤0 이지만 다른 프리셋의 fovBaseV 를 빌려 부트스트랩된다', () => {
    const { plan, issues } = planAutoRoi({
      placeRoiJson: RAW, camIdx: 1, presetIdx: 3, quadNorm: refQuadNorm(1, 3), cols: 1, rows: 2, opts: OPTS,
    });
    expect(plan, 'preset3 부트스트랩').toBeTruthy();
    expect(issues.join(' ')).toContain('fovBaseV');
    const p3 = plan!.presets.find((x) => x.presetIdx === 3)!;
    expect(p3.matched).toBe(2);
    expect(p3.applicable).toBe(true);
    expect(p3.avgIoU!).toBeGreaterThan(0.99);
  });

  it('폴백 근거가 없으면(그 카메라에 다른 주차면 0) 여전히 실패 — 위장하지 않는다', () => {
    // preset3 만 남기고 나머지 프리셋의 주차면을 비운 입력.
    const only3 = JSON.parse(JSON.stringify(RAW));
    for (const p of only3.cameras[0].presets) if (p.preset_idx !== 3) p.parking_spaces = [];
    const { plan, issues } = planAutoRoi({
      placeRoiJson: only3, camIdx: 1, presetIdx: 3, quadNorm: refQuadNorm(1, 3), cols: 1, rows: 2, opts: OPTS,
    });
    expect(plan).toBeNull();
    expect(issues.join(' ')).toContain('수동 드로잉');
  });
});

describe('★ 우선순위3 — buildApplySpaces 빈 결과 가드(QA 결함 3)', () => {
  const plan: PresetPlan = {
    presetIdx: 1, generated: 0, fileCount: 0, matched: 1, avgIoU: 1, minIoU: 1,
    pairs: [{ slotIdx: 1, iou: 1, quadNorm: [] }],
    unmatchedAuto: [], unmatchedFile: [], onLattice: 1, offLattice: [], medianResidM: 0,
    applicable: true, issues: [],
  };
  it('fileSpaces 가 비면 빈 배열이 아니라 null (파일을 비우지 않는다)', () => {
    expect(buildApplySpaces(plan, [])).toBeNull();
  });
  it('applicable=false 면 null', () => {
    expect(buildApplySpaces({ ...plan, applicable: false }, [{ idx: 1, points: [] }])).toBeNull();
  });
});

describe('★ 우선순위5 — 격자를 주차열 단위로 누적(QA B-4)', () => {
  const mk = (thetaDeg: number, a: number, b: number) => ({
    grid: {
      camIdx: 1, originM: { a, b }, thetaDeg, colPitchM: 2.5, rowPitchM: 5,
      cols: 1, rows: 1, slotIdByCell: { '0:0': 1 }, issues: [],
    },
    appliedPresets: [1],
    updatedAt: 'T',
  });
  const consts = { camIdx: 1, imgW: 1920, imgH: 1080, d: 5, fovBaseV: 34, rollDeg: 0, fromPresetIdx: 1, bootstrapConf: 0.5, issues: [] };

  it('다른 주차열(방위 90° 차)은 교체가 아니라 추가된다', () => {
    let f = emptyGroundGridFile();
    f = upsertCameraGrids(f, { camIdx: 1, constants: consts, grids: [mk(90, 28.776, 0.883)] });
    f = upsertCameraGrids(f, { camIdx: 1, constants: consts, grids: [mk(0, 1.236, 13.375)] });
    expect(f.cameras).toHaveLength(1);
    expect(f.cameras[0].grids).toHaveLength(2); // ★ 이전 구현은 1 이었다(통째 교체).
  });

  it('같은 주차열 재부트스트랩은 갱신(중복 추가 없음)', () => {
    let f = emptyGroundGridFile();
    f = upsertCameraGrids(f, { camIdx: 1, constants: consts, grids: [mk(90, 28.776, 0.883)] });
    // 같은 열을 다른 창(cols)으로 다시 → 위상·방위가 같으므로 같은 키.
    const again = mk(90, 28.776, 0.883);
    again.grid.cols = 7;
    f = upsertCameraGrids(f, { camIdx: 1, constants: consts, grids: [again] });
    expect(f.cameras[0].grids).toHaveLength(1);
    expect(f.cameras[0].grids[0].grid.cols).toBe(7); // 최신으로 갱신.
  });

  it('격자 원점이 lattice 정수배만큼 다르면 같은 열로 본다(위상 기준 키)', () => {
    expect(gridKeyOf(mk(90, 28.776, 0.883).grid)).toBe(gridKeyOf(mk(90, 28.776, 0.883 + 2.5 * 4).grid));
  });

  it('파일 바이트 결정론: 삽입 순서가 달라도 같은 결과', () => {
    const a = mk(90, 28.776, 0.883);
    const b = mk(0, 1.236, 13.375);
    let f1 = emptyGroundGridFile();
    f1 = upsertCameraGrids(f1, { camIdx: 1, constants: consts, grids: [a] });
    f1 = upsertCameraGrids(f1, { camIdx: 1, constants: consts, grids: [b] });
    let f2 = emptyGroundGridFile();
    f2 = upsertCameraGrids(f2, { camIdx: 1, constants: consts, grids: [b] });
    f2 = upsertCameraGrids(f2, { camIdx: 1, constants: consts, grids: [a] });
    expect(JSON.stringify(f1)).toBe(JSON.stringify(f2));
  });
});
