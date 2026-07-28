// 자동 바닥 ROI 계획 — 기준 주차면 1개 → 카메라 상수 + 격자 + 전 프리셋 미리보기(순수, IO 0).
// 라우트(`api/groundGridRoutes.ts`)는 이 모듈을 부르는 얇은 진입점이다(저장소 관례).
//
// 정본 흐름(리더 D-1): 격자 → **PtzCamRoi.json** → slot_setup(파생). 여기서 DB 는 만지지 않는다.
// 강등 철학: throw 금지 → null/issues. **조용히 틀린 ROI 보다 안 그리는 게 낫다**.

import { convexIntersectionArea, polygonArea } from '../domain/polygon.js';
import { normalizePtzCamRoi, type PlaceRoiSpace } from '../capture/placeRoi.js';
import { buildGroundInputs } from './groundInputs.js';
import { estimateGroundModels } from './groundModel.js';
import { bootstrapCameraConstants, buildAutoGroundModel, type CameraGroundConstants } from './groundBootstrap.js';
import {
  cellKey,
  fitGridFromQuads,
  gridToPixelQuads,
  quadToGroundM,
  type GridQuad,
  type GroundGrid,
} from './groundGrid.js';
import { groundFrameOf } from './groundFrame.js';
import type { GroundModel, GroundOptions, PixelQuad } from './types.js';
import type { NormalizedPoint } from '../domain/types.js';

const DEG = Math.PI / 180;
/**
 * 기존 파일 슬롯과 자동 quad 를 같은 슬롯으로 인정하는 최소 IoU. 이 미만이면 '매칭 실패'(적용 거부 사유).
 *
 * ★ 0.3 → 0.5 상향(QA 재수정 라운드에서 **실측으로 드러난 오매칭** 때문):
 *   격자를 크게 펼치면(cols=60,rows=20) 방위가 90° 다른 **다른 주차열**의 슬롯에 격자 칸이 우연히 겹쳐
 *   `slot12 IoU=0.3995 / slot13 IoU=0.3769` 로 매칭되고 `applicable=true` 가 됐다.
 *   → 올바른 ROI 를 40% 만 겹치는 엉뚱한 quad 로 **덮어쓸 수 있었다**("조용히 틀린 ROI" 금지 위반).
 *   같은 슬롯이면 IoU 는 0.99 이상 나온다(실측). 0.5 는 실카 부정확성을 감안한 여유이자 오매칭 차단선이다.
 *   ※ 1차 방어선은 아래 on-lattice 게이트다. IoU 는 2차 방어선이다.
 */
export const MATCH_MIN_IOU = 0.5;

/** 두 볼록 quad 의 IoU(픽셀). 합집합 0 → 0. */
export function quadIoU(a: PixelQuad, b: PixelQuad): number {
  const inter = convexIntersectionArea(a, b);
  const uni = polygonArea(a) + polygonArea(b) - inter;
  return uni > 0 ? inter / uni : 0;
}

/** 프리셋 1개 미리보기. */
export interface PresetPlan {
  presetIdx: number;
  /** 격자가 이 프리셋 이미지에 생성한 quad 수. */
  generated: number;
  /** PtzCamRoi.json 이 이 프리셋에 가진 기존 슬롯 수. */
  fileCount: number;
  /** 기존 슬롯 ↔ 자동 quad 1:1 매칭 성사 수. */
  matched: number;
  /** 매칭된 쌍의 평균 IoU(매칭 0건이면 null). */
  avgIoU: number | null;
  minIoU: number | null;
  /** 매칭 결과. `slotIdx` = 파일 전역 idx. `quadNorm` = 자동 산출 4점(0..1). */
  pairs: Array<{ slotIdx: number; iou: number; quadNorm: NormalizedPoint[] }>;
  /** 기존 슬롯과 매칭되지 않은 자동 quad(신규 후보). 기본 경로에서는 **적용하지 않는다**. */
  unmatchedAuto: Array<{ cell: string; quadNorm: NormalizedPoint[] }>;
  /** 자동 quad 와 매칭되지 않은 기존 슬롯 idx. 하나라도 있으면 이 프리셋은 적용 거부(R-4). */
  unmatchedFile: number[];
  /**
   * ★ 격자 정합 진단 — 이 프리셋의 파일 슬롯 중 기준 격자 lattice 위에 있는 개수(이탈 ≤ ON_LATTICE_MAX_M).
   * `matched` 와 다르다: `matched` 는 **잘라낸 창 안**에서의 결과이고, 이 값은 **무한 격자 기준**이다.
   * `onLattice > 0 && matched === 0` 이면 창(colStart/rowStart) 문제 → 자동 선택이 고친다.
   * `onLattice === 0` 이면 **다른 주차열** → 어떤 창으로도 매칭 불가(별도 기준면 필요).
   */
  onLattice: number;
  /** lattice 위에 없는 기존 슬롯 idx(= 다른 주차열). */
  offLattice: number[];
  /** 파일 슬롯의 lattice 이탈 거리 중앙값(m). 슬롯 0개면 null. */
  medianResidM: number | null;
  /** 적용 가능 여부(R-4/R-5 게이트). */
  applicable: boolean;
  issues: string[];
}

export interface AutoRoiPlan {
  constants: CameraGroundConstants;
  /** 부트스트랩 프리셋의 (이미지 증거 있는) 모델. */
  bootstrapModel: GroundModel;
  grid: GroundGrid;
  presets: PresetPlan[];
  issues: string[];
}

export interface AutoRoiPlanInput {
  /** PtzCamRoi.json raw JSON. */
  placeRoiJson: unknown;
  camIdx: number;
  /** 기준 주차면을 그린 프리셋. */
  presetIdx: number;
  /** 기준 주차면 4점(정규화 0..1). */
  quadNorm: readonly NormalizedPoint[];
  /** 열(폭 방향, 피치 2.5m) 칸 수. */
  cols: number;
  /** 행(깊이 방향, 피치 5.0m) 칸 수. 기본 1 — 행 확장은 **맞물린 배치에서만** 옳다(주차통로 있으면 틀린다). */
  rows: number;
  /**
   * 기준 주차면을 (0,0) 으로 볼 때의 시작 열/행. 음수로 반대 방향 확장.
   * `autoOffset !== false` 면 **선호값(tie-break 기준)** 으로만 쓰이고 실제 값은 자동 선택된다.
   */
  colStart?: number;
  rowStart?: number;
  /**
   * 창(colStart/rowStart) 자동 선택. 기본 **true**.
   * false 면 colStart/rowStart 를 그대로 쓴다(수동 오버라이드).
   * 자동 선택은 난수·스윕이 아니라 파일 슬롯의 lattice 지수를 닫힌 형태로 계산해 결정한다(`chooseStart`).
   */
  autoOffset?: boolean;
  opts: GroundOptions;
}

/** 정규화 4점 → 픽셀 PixelQuad. 4점 아님/비유한 → null. */
function toPixelQuad(pts: readonly NormalizedPoint[], imgW: number, imgH: number): PixelQuad | null {
  if (pts.length !== 4) return null;
  const px = pts.map((p) => ({ x: p.x * imgW, y: p.y * imgH }));
  if (px.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
  return px as PixelQuad;
}

const toNorm = (q: PixelQuad, imgW: number, imgH: number): NormalizedPoint[] =>
  q.map((p) => ({ x: p.x / imgW, y: p.y / imgH }));

/**
 * 기준 셀 1개 격자 → cols×rows 로 확장. 셀 번호는 **격자 로컬 순번**(row asc → col asc)이며
 * 파일 전역 idx 와 무관하다(전역 idx 는 적용 단계에서 기존 슬롯 매칭으로 얻는다).
 */
export function expandGrid(
  base: GroundGrid,
  cols: number,
  rows: number,
  colStart: number,
  rowStart: number,
): GroundGrid {
  const c = Math.cos(base.thetaDeg * DEG);
  const s = Math.sin(base.thetaDeg * DEG);
  const originM = {
    a: base.originM.a + colStart * base.colPitchM * c + rowStart * base.rowPitchM * -s,
    b: base.originM.b + colStart * base.colPitchM * s + rowStart * base.rowPitchM * c,
  };
  const slotIdByCell: Record<string, number> = {};
  let next = 1;
  for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) slotIdByCell[cellKey(r, k)] = next++;
  return { ...base, originM, cols, rows, slotIdByCell, issues: [...base.issues] };
}

/**
 * 파일 슬롯이 기준 격자 **무한 격자(lattice)** 의 어느 칸에 놓이는가 + 그 칸 중심에서의 잔차(m).
 *
 * 왜 스윕이 아니라 이 방법인가(QA 우선순위1 지시에 대한 답):
 *   `colStart` 는 **무한 격자에서 잘라낼 창(window)의 위치**일 뿐이고, 어떤 파일 슬롯이 격자와 맞는지는
 *   `colStart` 와 **무관**하다. 따라서 후보를 스윕해 매칭을 세는 대신 **닫힌 형태로 지수를 직접 계산**한다
 *   (O(슬롯수), 결정론, 난수·해시순회 0). 스윕은 같은 답을 더 느리게 얻을 뿐이다.
 *   덤으로 `residM`(격자점 이탈 거리)이 나와 **"이 슬롯이 애초에 이 격자 위에 있는가"** 를 판정할 수 있다.
 */
function latticeIndexOf(
  quadPx: PixelQuad,
  model: GroundModel,
  panDeg: number | null,
  grid: GroundGrid,
): { row: number; col: number; residM: number } | null {
  const fr = groundFrameOf(model, panDeg);
  if (!fr) return null;
  const pts = quadToGroundM(quadPx, model, fr);
  if (!pts) return null;
  const a = pts.reduce((s, p) => s + p.a, 0) / 4;
  const b = pts.reduce((s, p) => s + p.b, 0) / 4;
  const c = Math.cos(grid.thetaDeg * DEG);
  const s = Math.sin(grid.thetaDeg * DEG);
  const u = { a: c, b: s };
  const v = { a: -s, b: c };
  const ou = grid.originM.a * u.a + grid.originM.b * u.b;
  const ov = grid.originM.a * v.a + grid.originM.b * v.b;
  const colF = (a * u.a + b * u.b - ou) / grid.colPitchM - 0.5;
  const rowF = (a * v.a + b * v.b - ov) / grid.rowPitchM - 0.5;
  const col = Math.round(colF);
  const row = Math.round(rowF);
  if (!Number.isFinite(col) || !Number.isFinite(row)) return null;
  const residM = Math.hypot((colF - col) * grid.colPitchM, (rowF - row) * grid.rowPitchM);
  return { row, col, residM };
}

/** 파일 슬롯이 '이 격자 위에 있다'고 볼 최대 이탈(m). 열 피치 2.5m 의 10% — 설계 Loop 3-1 의 위상 허용치와 동일. */
export const ON_LATTICE_MAX_M = 0.25;

/**
 * 격자 창(window) 시작 지수를 **결정론적으로** 고른다.
 * 후보는 관측된 지수 범위에서만 나오며(무의미한 스윕 없음), 정렬된 순서로 순회한다.
 * 목적함수 우선순위: ① 창이 덮는 on-lattice 슬롯 수 최대 ② `pref`(사용자 지정/기본 0)에 가까움
 * ③ 값이 큰 쪽(=기준면이 창 앞쪽) — 동점을 남기지 않는다.
 */
function chooseStart(indices: readonly number[], span: number, pref: number): number {
  if (!indices.length) return pref;
  const lo = Math.min(...indices) - (span - 1);
  const hi = Math.max(...indices);
  const cands: number[] = [];
  for (let s = lo; s <= hi; s++) cands.push(s);
  cands.push(pref);
  cands.sort((p, q) => p - q);
  let best = pref;
  let bestCover = -1;
  for (const s of cands) {
    const cover = indices.filter((i) => i >= s && i <= s + span - 1).length;
    if (
      cover > bestCover ||
      (cover === bestCover &&
        (Math.abs(s - pref) < Math.abs(best - pref) ||
          (Math.abs(s - pref) === Math.abs(best - pref) && s > best)))
    ) {
      best = s;
      bestCover = cover;
    }
  }
  return best;
}

/** 기존 슬롯 ↔ 자동 quad 결정론적 1:1 매칭. IoU 내림차순 그리디(동률은 인덱스로 고정). */
function matchByIoU(
  fileQuads: Array<{ idx: number; quad: PixelQuad }>,
  autoQuads: readonly GridQuad[],
): Array<{ fileI: number; autoI: number; iou: number }> {
  const cands: Array<{ fileI: number; autoI: number; iou: number }> = [];
  fileQuads.forEach((f, fi) => {
    autoQuads.forEach((a, ai) => {
      const iou = quadIoU(f.quad, a.quad);
      if (iou >= MATCH_MIN_IOU) cands.push({ fileI: fi, autoI: ai, iou });
    });
  });
  cands.sort((p, q) => q.iou - p.iou || p.fileI - q.fileI || p.autoI - q.autoI);
  const usedF = new Set<number>();
  const usedA = new Set<number>();
  const out: Array<{ fileI: number; autoI: number; iou: number }> = [];
  for (const c of cands) {
    if (usedF.has(c.fileI) || usedA.has(c.autoI)) continue;
    usedF.add(c.fileI);
    usedA.add(c.autoI);
    out.push(c);
  }
  out.sort((p, q) => p.fileI - q.fileI); // 파일 순서 보존(R-4).
  return out;
}

/**
 * 기준 주차면 1개 → 카메라 상수 + 격자 + 전 프리셋 미리보기.
 * 실패(카메라 부재·quad 퇴화·부트스트랩 불가) → `{ plan: null, issues }`.
 */
export function planAutoRoi(input: AutoRoiPlanInput): { plan: AutoRoiPlan | null; issues: string[] } {
  const issues: string[] = [];
  const cams = buildGroundInputs(input.placeRoiJson, []);
  const cam = cams.find((c) => c.camIdx === input.camIdx);
  if (!cam) {
    issues.push(`cam${input.camIdx}: PtzCamRoi.json 에 해당 카메라 없음`);
    return { plan: null, issues };
  }
  const ref = cam.presets.find((p) => p.presetIdx === input.presetIdx);
  if (!ref) {
    issues.push(`cam${input.camIdx} preset${input.presetIdx}: PtzCamRoi.json 에 해당 프리셋 없음`);
    return { plan: null, issues };
  }
  if (ref.zoom == null || ref.tilt == null || ref.pan == null) {
    issues.push(`cam${input.camIdx} preset${input.presetIdx}: PTZ(pan/tilt/zoom) 미상 — 부트스트랩 불가`);
    return { plan: null, issues };
  }
  const quadPx = toPixelQuad(input.quadNorm, cam.imgW, cam.imgH);
  if (!quadPx) {
    issues.push('기준 주차면 4점이 아니거나 좌표가 비유한 — 부트스트랩 불가');
    return { plan: null, issues };
  }
  if (!(input.cols >= 1) || !(input.rows >= 1)) {
    issues.push('cols/rows 는 1 이상이어야 한다');
    return { plan: null, issues };
  }

  const bootInput = {
    camIdx: cam.camIdx,
    imgW: cam.imgW,
    imgH: cam.imgH,
    presetIdx: ref.presetIdx,
    zoom: ref.zoom,
    tilt: ref.tilt,
    pan: ref.pan,
    quad: quadPx,
  };
  let boot = bootstrapCameraConstants(bootInput, input.opts);
  if (!boot) {
    // ★ 폴백(QA 결함 4): 단일 quad 의 두 소실점이 직교 제약을 못 만족하면(f²≤0) f 를 못 낸다.
    //   그때는 **같은 카메라의 다른 프리셋들**로 공동추정한 fovBaseV 를 빌려 f 를 유도한다.
    //   fovBaseV 는 zoom 만의 함수인 카메라 상수이므로 이는 근거 있는 대체이지 위장이 아니다
    //   (production 의 `poolFovBaseV` 가 하는 일과 같다). 신규 수학 0줄 — 기존 함수만 호출.
    const pooled = estimateGroundModels(cam, input.opts).fovBaseV;
    if (pooled != null && pooled > 0) {
      boot = bootstrapCameraConstants(bootInput, input.opts, pooled);
      if (boot) {
        issues.push(
          `preset${ref.presetIdx}: 기준면 단독으로는 f 를 낼 수 없어(직교 소실점 제약 f²≤0) ` +
            `같은 카메라의 다른 프리셋에서 공동추정한 fovBaseV ${pooled.toFixed(3)}° 를 빌려 부트스트랩했다 — ` +
            '이 카메라에 다른 프리셋 주차면이 없으면 이 경로는 쓸 수 없다',
        );
      }
    }
  }
  if (!boot) {
    issues.push(
      '부트스트랩 실패(퇴화 quad / 직교 소실점 제약 위반 f²≤0 / 지평선 위). ' +
        '같은 카메라의 다른 프리셋 주차면으로 fovBaseV 를 빌리는 폴백도 실패했다 — 이 프리셋은 수동 드로잉을 쓴다',
    );
    return { plan: null, issues };
  }
  issues.push(...boot.issues);

  const fit = fitGridFromQuads([quadPx], boot.model, ref.pan, input.opts);
  issues.push(...fit.issues);
  if (!fit.grid) {
    issues.push('격자 적합 실패 — 자동 ROI 미생성');
    return { plan: null, issues };
  }
  const baseGrid = fit.grid;

  const { byPreset } = normalizePtzCamRoi(input.placeRoiJson);

  // ── 프리셋별 모델 + 파일 quad 를 한 번만 조립(창 선택과 생성이 같은 값을 쓴다).
  const stage = cam.presets.map((p) => {
    const model =
      p.presetIdx === ref.presetIdx
        ? boot!.model
        : p.zoom != null && p.tilt != null && p.pan != null
          ? buildAutoGroundModel(boot!.constants, {
              presetIdx: p.presetIdx,
              zoom: p.zoom,
              tilt: p.tilt,
              pan: p.pan,
            })
          : null;
    const fileSpaces: PlaceRoiSpace[] = byPreset.get(`${cam.camIdx}:${p.presetIdx}`) ?? [];
    const fileQuads: Array<{ idx: number; quad: PixelQuad }> = [];
    const badIdx: number[] = [];
    for (const sp of fileSpaces) {
      const q = toPixelQuad(sp.points, cam.imgW, cam.imgH);
      if (q) fileQuads.push({ idx: sp.idx, quad: q });
      else badIdx.push(sp.idx);
    }
    // 파일 슬롯이 기준 격자 lattice 의 어느 칸인가 + 이탈 거리. 창(colStart/rowStart) 선택의 유일한 근거.
    const lattice = model
      ? fileQuads.map((f) => ({ idx: f.idx, at: latticeIndexOf(f.quad, model, p.pan, baseGrid) }))
      : [];
    return { p, model, fileSpaces, fileQuads, badIdx, lattice };
  });

  // ── ★ 창 위치 결정론적 선택(QA 우선순위1). on-lattice 슬롯을 가장 많이 덮는 창을 고른다.
  //     명시 지정(autoOffset:false)이면 사용자 값을 그대로 쓴다.
  const onLattice = stage.flatMap((s) =>
    s.lattice.filter((e) => e.at != null && e.at.residM <= ON_LATTICE_MAX_M).map((e) => e.at!),
  );
  const prefCol = input.colStart ?? 0;
  const prefRow = input.rowStart ?? 0;
  const colStart =
    input.autoOffset === false ? prefCol : chooseStart(onLattice.map((e) => e.col), input.cols, prefCol);
  const rowStart =
    input.autoOffset === false ? prefRow : chooseStart(onLattice.map((e) => e.row), input.rows, prefRow);
  if (input.autoOffset !== false && (colStart !== prefCol || rowStart !== prefRow)) {
    issues.push(`격자 창 자동 선택: colStart=${colStart}, rowStart=${rowStart}(지정값 ${prefCol}/${prefRow} 대신)`);
  }
  const grid = expandGrid(baseGrid, input.cols, input.rows, colStart, rowStart);

  const presets: PresetPlan[] = [];
  for (const { p, model, fileSpaces, fileQuads, badIdx, lattice } of stage) {
    const pIssues: string[] = [];
    for (const bad of badIdx) pIssues.push(`slot${bad}: 파일 폴리곤이 4점이 아님 — 대조 제외`);
    if (!model) {
      pIssues.push(`preset${p.presetIdx}: PTZ 미상 또는 f 유도 불가 — 자동 모델 없음`);
      presets.push({
        presetIdx: p.presetIdx,
        generated: 0,
        fileCount: fileSpaces.length,
        matched: 0,
        avgIoU: null,
        minIoU: null,
        pairs: [],
        unmatchedAuto: [],
        unmatchedFile: fileSpaces.map((s) => s.idx),
        onLattice: 0,
        offLattice: fileSpaces.map((s) => s.idx),
        medianResidM: null,
        applicable: false,
        issues: pIssues,
      });
      continue;
    }
    pIssues.push(...model.issues);
    const gen = gridToPixelQuads(grid, model, p.pan);
    pIssues.push(...gen.issues);

    // ★ 격자 정합 진단 — 이 프리셋의 파일 슬롯이 **애초에 이 격자 위에 있는가**.
    //   off-lattice 면 창(colStart)을 아무리 움직여도 매칭될 수 없다(다른 주차열이라는 뜻).
    const onIdx = lattice.filter((e) => e.at != null && e.at.residM <= ON_LATTICE_MAX_M);
    const offIdx = lattice.filter((e) => !(e.at != null && e.at.residM <= ON_LATTICE_MAX_M));
    const resids = lattice.filter((e) => e.at != null).map((e) => e.at!.residM).sort((x, y) => x - y);
    const medianResidM = resids.length ? resids[Math.floor((resids.length - 1) / 2)] : null;
    if (offIdx.length) {
      pIssues.push(
        `기존 슬롯 ${offIdx.map((e) => e.idx).join(',')} 이(가) 이 격자의 lattice 위에 없다` +
          `(중앙 이탈 ${medianResidM == null ? '?' : medianResidM.toFixed(3)}m > ${ON_LATTICE_MAX_M}m) — ` +
          '다른 주차열이다. colStart/rowStart 를 어떻게 잡아도 매칭되지 않는다(별도 기준면 필요)',
      );
    }

    // ★ 1차 방어선: **on-lattice 슬롯만 매칭 후보**로 삼는다(QA 재수정 라운드).
    //   off-lattice 슬롯은 다른 주차열이므로, 격자 칸이 우연히 겹쳐도 같은 슬롯이 **아니다**.
    //   IoU 만으로 거르면 90° 뒤집힌 열에서 0.38~0.40 짜리 오매칭이 통과한다(실측).
    const onSet = new Set(onIdx.map((e) => e.idx));
    const eligible = fileQuads.filter((f) => onSet.has(f.idx));
    const pairsRaw = matchByIoU(eligible, gen.quads);
    const matchedAuto = new Set(pairsRaw.map((m) => m.autoI));
    const matchedFile = new Set(pairsRaw.map((m) => m.fileI));
    const pairs = pairsRaw.map((m) => ({
      slotIdx: eligible[m.fileI].idx,
      iou: m.iou,
      quadNorm: toNorm(gen.quads[m.autoI].quad, cam.imgW, cam.imgH),
    }));
    const matchedIdx = new Set(pairs.map((x) => x.slotIdx));
    const unmatchedFile = fileQuads.filter((f) => !matchedIdx.has(f.idx)).map((f) => f.idx);
    const unmatchedAuto = gen.quads
      .map((q, i) => ({ q, i }))
      .filter((e) => !matchedAuto.has(e.i))
      .map((e) => ({ cell: cellKey(e.q.row, e.q.col), quadNorm: toNorm(e.q.quad, cam.imgW, cam.imgH) }));
    if (unmatchedFile.length) {
      pIssues.push(
        `기존 슬롯 ${unmatchedFile.join(',')} 이(가) 자동 quad 와 매칭되지 않음(IoU<${MATCH_MIN_IOU}) — 이 프리셋은 적용 거부(R-4)`,
      );
    }
    if (unmatchedAuto.length) {
      pIssues.push(
        `자동 quad ${unmatchedAuto.length}개가 기존 슬롯과 대응 없음(신규 후보 ${unmatchedAuto
          .map((u) => u.cell)
          .join(' ')}) — allowNew 없이는 적용하지 않는다`,
      );
    }
    const ious = pairs.map((x) => x.iou);
    presets.push({
      presetIdx: p.presetIdx,
      generated: gen.quads.length,
      fileCount: fileSpaces.length,
      matched: pairs.length,
      avgIoU: ious.length ? ious.reduce((s, x) => s + x, 0) / ious.length : null,
      minIoU: ious.length ? Math.min(...ious) : null,
      pairs,
      unmatchedAuto,
      unmatchedFile,
      onLattice: onIdx.length,
      offLattice: offIdx.map((e) => e.idx),
      medianResidM,
      applicable: pairs.length > 0 && unmatchedFile.length === 0,
      issues: pIssues,
    });
  }

  return {
    plan: { constants: boot.constants, bootstrapModel: boot.model, grid, presets, issues: [...issues] },
    issues,
  };
}

/**
 * 적용용 spaces 조립(순수). 기존 파일 순서·idx 를 **보존**하고 좌표만 교체한다(R-4).
 * `allowNew` 가 true 면 미매칭 자동 quad 를 신규 전역 idx(`nextGlobalIdx` 부터)로 **append** 한다
 * — 기존 idx 를 건드리지 않으므로 `normalizeGlobalIdx` 의 1..N 순열 조건이 유지된다(재부여 없음).
 * 적용 불가(R-4 위반·매칭 0건) → null.
 */
export function buildApplySpaces(
  plan: PresetPlan,
  fileSpaces: readonly PlaceRoiSpace[],
  opts?: { allowNew?: boolean; nextGlobalIdx?: number },
): PlaceRoiSpace[] | null {
  if (!plan.applicable) return null;
  const byIdx = new Map(plan.pairs.map((p) => [p.slotIdx, p.quadNorm]));
  const out: PlaceRoiSpace[] = fileSpaces.map((sp) => {
    const pts = byIdx.get(sp.idx);
    return pts ? { idx: sp.idx, points: pts } : sp;
  });
  if (opts?.allowNew && plan.unmatchedAuto.length) {
    let next = opts.nextGlobalIdx ?? 0;
    if (!(next > 0)) return out; // 신규 번호 산출 불가 → 추가하지 않는다(조용한 재번호 금지).
    for (const u of plan.unmatchedAuto) out.push({ idx: next++, points: u.quadNorm });
  }
  // ★ R-5(wipe 가드)를 **순수함수 자체**에도 둔다(QA 결함 3). 지금은 라우트가 막고 있어 실위험이 없지만,
  //   다른 호출자가 생기면 빈 배열이 `PtzCamRoi.json` 의 해당 프리셋을 통째로 비운다.
  return out.length ? out : null;
}

/** `assertAutoPromoteSafe` 판정 결과. 거부 사유는 **숫자로 보이게** detail 에 담는다. */
export interface AutoPromoteGate {
  ok: boolean;
  /** ok=false 일 때만. */
  error?: string;
  detail?: {
    nextSlots: number;
    currentSlots: number;
    missingIdx: number[];
    /** G5 전용 — raw `parking_spaces` 개수가 줄어드는 프리셋(정규화 이전 기준). */
    droppedRaw?: Array<{ key: string; from: number; to: number }>;
  };
}

/** 파일 JSON → 전역 idx 오름차순 배열(중복 제거). `Map` 순회 순서에 의존하지 않는다(결정론). */
function sortedGlobalIdx(json: unknown): number[] {
  const { byPreset } = normalizePtzCamRoi(json);
  const set = new Set<number>();
  for (const spaces of byPreset.values()) for (const sp of spaces) set.add(sp.idx);
  return [...set].sort((a, b) => a - b);
}

/**
 * ★ **정규화 이전** raw `parking_spaces` 개수를 프리셋별로 센다(`${cam_id}:${preset_idx}` → 개수).
 *
 * 왜 `normalizePtzCamRoi` 를 쓰면 안 되는가(QA 결함 1 의 핵심):
 *   정규화는 `idx` 누락 / `points` 비배열 / 이미지 크기 오류 인 주차면을 **조용히 탈락**시킨다(`placeRoi.ts:59-68`).
 *   그런데 `applyPlaceRoiUpdate` 는 대상 프리셋의 `parking_spaces` 를 **통째로 교체**하므로,
 *   탈락분은 정본에서 **삭제**된다. 정규화된 idx 집합만 비교하면 그 삭제가 보이지 않는다
 *   (애초에 idx 가 없으니 `missingIdx` 에도 안 잡힌다) → 8면 → 7면 소실이 `ok:true` 로 통과했다(QA 실측).
 *   따라서 이 게이트만은 **raw 배열 길이**를 센다.
 */
function rawSpaceCounts(json: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!json || typeof json !== 'object') return out;
  const cameras = Array.isArray((json as { cameras?: unknown }).cameras)
    ? ((json as { cameras: unknown[] }).cameras)
    : [];
  cameras.forEach((camEntry, ci) => {
    const entry = camEntry as { camera?: { cam_id?: unknown }; presets?: unknown };
    // cam_id/preset_idx 가 없어도 짝을 잃지 않도록 배열 위치를 대체 키로 쓴다(양쪽 파일에 같은 규칙 적용).
    const camKey = entry?.camera?.cam_id ?? `#${ci}`;
    const presets = Array.isArray(entry?.presets) ? entry.presets : [];
    presets.forEach((presetRaw, pi) => {
      const preset = presetRaw as { preset_idx?: unknown; parking_spaces?: unknown };
      const key = `${String(camKey)}:${String(preset?.preset_idx ?? `#${pi}`)}`;
      const n = Array.isArray(preset?.parking_spaces) ? preset.parking_spaces.length : 0;
      out.set(key, (out.get(key) ?? 0) + n);
    });
  });
  return out;
}

/**
 * 정본 덮어쓰기(promote) 직전의 **파괴 방지 게이트**(순수 · IO 0 · DB 접근 0).
 * 입력은 메모리 JSON 2개뿐이므로 라우트에 store 의존이 생기지 않는다(설계 §4-2).
 *
 * - **G1** 대상의 유효 프리셋이 0개 → 거부(유효 주차면 0 = 정본 파괴)
 * - **G2** 현재 정본의 전역 idx 집합을 대상이 **포함하지 않음**(⊉) → 거부(슬롯이 사라졌다는 뜻)
 * - **G3** 대상 슬롯 총수 < 현재 슬롯 총수 → 거부(프리셋 단위 누락을 독립으로 잡는다)
 * - **G4** 대상 슬롯 총수 0 → 거부(G1 과 중복이나 명시적으로 남긴다)
 * - **G5** **raw** `parking_spaces` 개수가 줄어드는 프리셋이 있으면 → 거부(정규화 탈락분 소실 방어)
 *
 * ★ G1~G4 는 **정규화된 idx 집합**을 보므로 현재 apply 경로로는 도달하지 않는다(미래 방어선).
 *   **G5 는 실제로 도달한다** — `idx` 없는 주차면이 있는 파일을 승인하면 여기서 거부된다(라우트 테스트로 봉인).
 */
export function assertAutoPromoteSafe(nextJson: unknown, currentJson: unknown): AutoPromoteGate {
  const nextIdx = sortedGlobalIdx(nextJson);
  const currentIdx = sortedGlobalIdx(currentJson);
  const nextSet = new Set(nextIdx);
  const missingIdx = currentIdx.filter((i) => !nextSet.has(i));
  const detail = { nextSlots: nextIdx.length, currentSlots: currentIdx.length, missingIdx };
  const nextPresets = normalizePtzCamRoi(nextJson).byPreset.size;
  if (nextPresets === 0) return { ok: false, error: '적용 거부(G1): 대상 ROI 에 유효 프리셋이 0개 — 정본 무변경', detail };
  if (missingIdx.length) {
    return {
      ok: false,
      error: `적용 거부(G2): 기존 주차면 ${missingIdx.join(',')} 이(가) 대상 ROI 에 없다 — 정본 무변경`,
      detail,
    };
  }
  if (nextIdx.length < currentIdx.length) {
    return {
      ok: false,
      error: `적용 거부(G3): 주차면 수 감소(${currentIdx.length} → ${nextIdx.length}) — 정본 무변경`,
      detail,
    };
  }
  if (nextIdx.length === 0) return { ok: false, error: '적용 거부(G4): 대상 주차면 0건 — 정본 무변경', detail };

  // ── G5: raw 개수 감소 = 정규화에서 탈락한 주차면이 통째 교체로 **파일에서 삭제**된다는 뜻.
  const nextRaw = rawSpaceCounts(nextJson);
  const currentRaw = rawSpaceCounts(currentJson);
  const droppedRaw = [...currentRaw.entries()]
    .map(([key, from]) => ({ key, from, to: nextRaw.get(key) ?? 0 }))
    .filter((e) => e.to < e.from)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)); // Map 삽입순서 비의존(결정론).
  if (droppedRaw.length) {
    return {
      ok: false,
      error:
        `적용 거부(G5): 주차면이 파일에서 사라진다 — ` +
        `${droppedRaw.map((e) => `cam${e.key.split(':')[0]} preset${e.key.split(':')[1]} ${e.from}면→${e.to}면`).join(', ')}. ` +
        `원인: idx 누락 · points 누락 · 이미지 크기 오류로 정규화에서 탈락한 주차면은 좌표 교체 시 삭제된다. ` +
        `해당 주차면에 idx 를 넣어 저장한 뒤 다시 승인하세요 — 정본·DB 무변경`,
      detail: { ...detail, droppedRaw },
    };
  }
  return { ok: true };
}

/** 파일 전체에서 다음으로 쓸 전역 idx(= max + 1). 기존 idx 를 절대 재부여하지 않기 위한 값. */
export function nextGlobalIdxOf(placeRoiJson: unknown): number {
  const { byPreset } = normalizePtzCamRoi(placeRoiJson);
  let max = 0;
  for (const spaces of byPreset.values()) for (const sp of spaces) if (sp.idx > max) max = sp.idx;
  return max + 1;
}
