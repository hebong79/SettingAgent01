// ★ 22회차 Phase 0 신규 — **「경계앵커 닫기」(설계서 §R2-2 안 1) 착수 전 상한 측정**.
//
// ══════════════════════════════════════════════════════════════════════════
// 재는 것 3가지 (검출 알고리즘 배선 0줄 · `src/ground/**` 무접촉):
//   ⓔ   「분리선 1개 + 규격 폭으로 닫기」의 **재현율·정밀도 상한**
//   ⓔ-2 **예측변 도색지지** 게이트의 판별력 — 안 1 의 생사(설계서 F1)
//   ⓐ′  **면 단위**(k=1) `side` 가 「정답 칸 vs 반칸 밀린 칸」을 가르는가
//
// ★ 왜 예측변인가(설계서 §R2-2-1): 면의 좌우 두 변 중 **한 변은 관측된 분리선**(자기충족)이고
//   **다른 한 변은 규격 폭으로 예측한 변**이다. 예측변만 채점해야 순수 검증량이 된다.
//   `edgePaintSupport` 는 변을 따라 `supportSamples(21)` 개를 훑으므로 **점이 아니라 5m 선 전체**를
//   본다 — 30~120px 스텁은 통과할 수 없다(19회차 게이트①이 밀도에 포화됐던 것과 다른 종류의 지표).
//
// ★ 재사용 규약(재발명 금지 · U11 방지): 후보 좌표·quad 조립·행 좌표계·분리선 정련·도색지지는
//   전부 기존 함수다. `sepAudit.ts`(21회차 997줄) 의 `frontCandidatesOf`/`goldenTargets`/
//   `auditRowFrame`/`pickAuditFrame`/`auditQuadAt`/`quantiles` 를 그대로 호출한다.
//   IoU 는 `autoRoiPlan.quadIoU`(R4 — 신규 IoU 0줄), 매칭 임계는 `MATCH_MIN_IOU`.
//
// ★ 정직 고지 — 이 측정이 **어느 방향으로 관대한가**(상한이므로 관대해야 맞다):
//   (1) 행별 **감사 전방선**은 `pickAuditFrame` 이 **참 경계 적중 수**로 고른다 = 오라클 유리.
//       실검출기는 전방선을 도색 증거만으로 골라야 하므로 실제 후보 수는 이보다 **많고**
//       (전방선 8개 전부 스윕 시의 후보 수도 함께 낸다) 정밀도는 이보다 **낮다**.
//   (2) 라벨(IoU≥0.5)은 **채점 전용**이다 — 후보 생성·게이트 어디에도 들어가지 않는다(R1).
//   (3) 게이트③(물리 타당성 — 깊이·지면 방위)은 재지 않았다. **한계로 명시**한다(추정 금지).
//
// 정본 `PtzCamRoi.json` · DB · `config/` 무접촉(읽기만). Unity RPC 0회. 카메라 이동 0.
//
// 사용: npx tsx src/tools/anchorCloseUpper.ts [v1|v2|캐시디렉터리] [outDir]
// ══════════════════════════════════════════════════════════════════════════

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import {
  DEFAULT_PAINT_OPTIONS,
  edgePaintSupport,
  paintEvidenceOf,
  type PaintEvidence,
} from '../ground/floorPaint.js';
import { type RowFrame } from '../ground/bayGrid.js';
import { DEFAULT_BAY_OPTS, quadPaintSupport, type BayDetectOpts } from '../ground/bayGeometry.js';
import { backprojectToGround, projectToPixel } from '../ground/project.js';
import { MATCH_MIN_IOU, quadIoU } from '../ground/autoRoiPlan.js';
import type { GroundModel, PixelQuad } from '../ground/types.js';
import {
  auditQuadAt,
  auditRowFrame,
  frontCandidatesOf,
  goldenTargets,
  pickAuditFrame,
  quantiles,
  AUDIT_DEDUP_M,
  AUDIT_TOL_M,
  GOLDEN_DIRS,
  type FrontCand,
  type Target,
} from './sepAudit.js';

/** `quadPaintSupport` 는 `expectedBays` 를 보지 않는다 — `sepAudit` 과 같은 값(1)으로 형만 맞춘다. */
const GATE_OPTS: BayDetectOpts = { ...DEFAULT_BAY_OPTS, expectedBays: 1 };
const W_M = DEFAULT_BAY_OPTS.slotWidthM; // 2.5 — 시설 사양(F7). 격자가 아니다.
const D_M = DEFAULT_BAY_OPTS.slotDepthM; // 5.0
/** 설계자 산정 — 정밀도 0.70 이려면 후보 1536 → 산출 ≤58 = 생존율 3.8%. */
const TARGET_SURVIVAL = 58 / 1536;
const TARGET_PRECISION = 0.7;

// ── 순수 로직 ────────────────────────────────────────────────────────────────

/** 행 좌표계 (a=폭, b=깊이) → 픽셀. `auditQuadAt` 과 **같은 식**(flipV 부호 포함). */
export function rowPointPx(
  fr: RowFrame,
  model: GroundModel,
  aM: number,
  bM: number,
  flipV: boolean,
): { x: number; y: number } | null {
  const s = flipV ? -1 : 1;
  return projectToPixel(
    [
      fr.origin[0] + fr.u[0] * aM + s * fr.v[0] * bM,
      fr.origin[1] + fr.u[1] * aM + s * fr.v[1] * bM,
      fr.origin[2] + fr.u[2] * aM + s * fr.v[2] * bM,
    ],
    model,
  );
}

/** 면 후보 1건 — 분리선 **1개**에서 태어난다(이웃 참조 0 · 인덱스 0 · 위상 0 = G1~G4). */
export interface AnchorCand {
  key: string;
  rowIdx: number;
  /** 앵커가 된 분리선의 인덱스(감사 전방선 기준). */
  sepIdx: number;
  /** 규격 폭으로 어느 쪽을 닫았는가. 'right' = [a, a+w] · 'left' = [a−w, a]. */
  dir: 'left' | 'right';
  flipV: boolean;
  aAnchorM: number;
  aLoM: number;
  /** ★ 예측변의 폭좌표 — **관측되지 않은 쪽**. */
  aPredM: number;
  quad: PixelQuad;
  /** ★ ⓔ-2 의 측정량 — 예측변 5m 전 구간 도색지지. */
  predHit: number;
  predChamferPx: number;
  /** 앵커변(관측된 분리선 쪽)의 같은 지표 — 자기충족 대조군. */
  anchorHit: number;
  /** 면 단위(k=1) 도색지지 — ⓐ′ 및 게이트② 대조. */
  near: number;
  far: number;
  side: number;
  score: number;
  /** 앵커 분리선의 화면상 길이(px) — 서열 2순위. */
  sepSpanPx: number;
  /**
   * ★ 게이트③(설계서 R2-2-1 경성③ — 물리 타당성)의 측정량. quad 중심을 역투영한 카메라-지면 거리(m).
   * 식은 `bayGrid.ts:473-482`(`medianDepthM`) 를 k=1 로 쓴 것과 같다 — 재발명 아님.
   * 리더 발견 4: 진짜 행 27~32m vs 물리 불가 후보 99.31m.
   */
  depthM: number | null;
  /** 채점 전용 — 정답 면과의 최대 IoU 및 그 면 키. 후보 생성·게이트에 **들어가지 않는다**. */
  bestIoU: number;
  matchedFaceKey: string | null;
}

/**
 * 배타성 해소 — 설계서 §R2-2-1 서열(예측변 지지 desc → 앵커 분리선 spanPx desc → 결정론 인덱스).
 * `quadIoU ≥ rowMergeIoU` 면 접는다(신규 IoU 0줄 · R4).
 */
export function resolveExclusivity(cands: readonly AnchorCand[], mergeIoU: number): AnchorCand[] {
  const order = cands
    .map((_, i) => i)
    .sort(
      (a, b) =>
        cands[b].predHit - cands[a].predHit ||
        cands[b].sepSpanPx - cands[a].sepSpanPx ||
        a - b,
    );
  const kept: AnchorCand[] = [];
  for (const i of order) {
    if (kept.some((k) => quadIoU(k.quad, cands[i].quad) >= mergeIoU)) continue;
    kept.push(cands[i]);
  }
  return kept;
}

/** 문턱 τ 에서의 성적 1행. 분모 `truthTotal` 은 **씬 정답 면 수**(41). */
export interface GateRow {
  tau: number;
  survivors: number;
  /** 생존 후보 중 정답 매칭 / 비매칭 — **참이 잡음과 같은 비율로 죽는가**를 보는 값. */
  survTrue: number;
  survNoise: number;
  survivalRate: number;
  kept: number;
  /** 게이트 통과 후보 집합 안에서 매칭된 정답 면 수(배타성 **전** — 순수 재현율 상한). */
  recallFacesRaw: number;
  /** 배타성 해소 후 남은 산출 중 매칭된 정답 면 수. */
  recallFaces: number;
  recall: number;
  precision: number;
}

export function gateSweep(
  cands: readonly AnchorCand[],
  taus: readonly number[],
  truthTotal: number,
  mergeIoU: number,
): GateRow[] {
  return taus.map((tau) => {
    const surv = cands.filter((c) => c.predHit >= tau);
    const kept = resolveExclusivity(surv, mergeIoU);
    const rawFaces = new Set(surv.map((c) => c.matchedFaceKey).filter((v): v is string => v != null)).size;
    const keptFaces = new Set(kept.map((c) => c.matchedFaceKey).filter((v): v is string => v != null)).size;
    return {
      tau,
      survivors: surv.length,
      survTrue: surv.filter((c) => c.matchedFaceKey != null).length,
      survNoise: surv.filter((c) => c.matchedFaceKey == null).length,
      survivalRate: cands.length ? surv.length / cands.length : 0,
      kept: kept.length,
      recallFacesRaw: rawFaces,
      recallFaces: keptFaces,
      recall: truthTotal ? keptFaces / truthTotal : 0,
      precision: kept.length ? keptFaces / kept.length : 0,
    };
  });
}

// ── 실행부 ───────────────────────────────────────────────────────────────────

/** ⓐ′ 표본 1쌍 — 같은 행 좌표계·같은 폭·같은 v방향에서 **위상만** 반칸 다르다. */
interface PhasePair {
  key: string;
  rowIdx: number;
  faceIdx: number;
  spanM: number;
  aligned: { near: number; far: number; side: number; score: number; iou: number };
  shifted: { near: number; far: number; side: number; score: number; iou: number };
}

function supOf(quad: PixelQuad, ev: PaintEvidence) {
  return quadPaintSupport([{ latticeIndex: 0, quad }], ev, DEFAULT_PAINT_OPTIONS, GATE_OPTS);
}

function bestIoUOf(quad: PixelQuad, vis: Target['vis']): { iou: number; key: string | null } {
  let best = 0;
  let key: string | null = null;
  for (const v of vis) {
    const i = quadIoU(quad, v.quad);
    if (i > best) {
      best = i;
      key = `r${v.face.rowIdx}f${v.face.faceIdx}`;
    }
  }
  return { iou: best, key };
}

interface RowPick {
  rowIdx: number;
  candIdx: number;
  fr: RowFrame;
  sepAM: number[];
  cand: FrontCand;
  /** 참 경계 폭좌표(면별 lo/hi) — ⓐ′ 전용(채점 경로). */
  facePairs: Array<{ faceIdx: number; aLoM: number; aHiM: number }>;
}

/** 한 대상(프리셋)의 후보 전집합 + ⓐ′ 쌍. */
async function measureTarget(
  t: Target,
): Promise<{ cands: AnchorCand[]; pairs: PhasePair[]; rows: RowPick[]; ev: PaintEvidence; allFrontCandCount: number; mismatchQuads: number }> {
  const { cands: fronts, mask } = frontCandidatesOf(t.frame);
  const ev = paintEvidenceOf(mask, t.W, t.H);
  const rowIdxs = [...new Set(t.vis.map((v) => v.face.rowIdx))].sort((a, b) => a - b);

  const out: AnchorCand[] = [];
  const pairs: PhasePair[] = [];
  const rows: RowPick[] = [];
  let mismatchQuads = 0;

  for (const rowIdx of rowIdxs) {
    const faces = t.vis.filter((v) => v.face.rowIdx === rowIdx).map((v) => ({ faceIdx: v.face.faceIdx, quad: v.quad }));
    const audits = fronts.map((c) => auditRowFrame(t.model, c.front.line, faces, c.pts, AUDIT_TOL_M, AUDIT_DEDUP_M));
    const ci = pickAuditFrame(audits.map((a) => ({ hits: a?.hits ?? -1, sumAbsErrM: a?.sumAbsErrM ?? Infinity })));
    const audit = ci >= 0 ? audits[ci] : null;
    if (!audit) continue;
    const fr = audit.fr;

    // ── ⓔ / ⓔ-2 : 분리선 1개 → 면 후보 4개(닫는 방향 2 × v방향 2)
    audit.sepAM.forEach((aM, sepIdx) => {
      if (!Number.isFinite(aM)) return;
      for (const dir of ['left', 'right'] as const) {
        const aLo = dir === 'right' ? aM : aM - W_M;
        const aPred = dir === 'right' ? aM + W_M : aM;
        for (const flipV of [false, true]) {
          const quad = auditQuadAt(fr, t.model, aLo, W_M, D_M, flipV);
          if (!quad) continue;
          const pN = rowPointPx(fr, t.model, aPred, 0, flipV);
          const pF = rowPointPx(fr, t.model, aPred, D_M, flipV);
          const aN = rowPointPx(fr, t.model, aM, 0, flipV);
          const aF = rowPointPx(fr, t.model, aM, D_M, flipV);
          if (!pN || !pF || !aN || !aF) continue;
          // 재사용 정합 검사 — 내 `rowPointPx` 로 만든 4코너가 `auditQuadAt` 결과와 같은 점집합인가.
          const mine = [
            rowPointPx(fr, t.model, aLo, 0, flipV),
            rowPointPx(fr, t.model, aLo, D_M, flipV),
            rowPointPx(fr, t.model, aLo + W_M, D_M, flipV),
            rowPointPx(fr, t.model, aLo + W_M, 0, flipV),
          ];
          if (mine.some((p) => !p) || quad.some((q) => !mine.some((p) => p && Math.abs(p.x - q.x) < 1e-9 && Math.abs(p.y - q.y) < 1e-9)))
            mismatchQuads++;

          const pe = edgePaintSupport(ev, pN, pF, DEFAULT_PAINT_OPTIONS);
          const ae = edgePaintSupport(ev, aN, aF, DEFAULT_PAINT_OPTIONS);
          const sup = supOf(quad, ev);
          const m = bestIoUOf(quad, t.vis);
          out.push({
            key: t.key,
            rowIdx,
            sepIdx,
            dir,
            flipV,
            aAnchorM: aM,
            aLoM: aLo,
            aPredM: aPred,
            quad,
            predHit: pe.hitRatio,
            predChamferPx: pe.chamferPx,
            anchorHit: ae.hitRatio,
            near: sup.near,
            far: sup.far,
            side: sup.side,
            score: sup.score,
            sepSpanPx: fronts[ci].seps[sepIdx]?.spanPx ?? 0,
            depthM: (() => {
              const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
              const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
              const X = backprojectToGround({ x: cx, y: cy }, t.model);
              return X ? Math.hypot(X[0], X[1], X[2]) : null;
            })(),
            bestIoU: m.iou,
            matchedFaceKey: m.iou >= MATCH_MIN_IOU ? m.key : null,
          });
        }
      }
    });

    // ── ⓐ′ : 정답 칸 vs 반칸 밀린 칸 (같은 폭·같은 v방향 — 위상만 다르다)
    const facePairs: RowPick['facePairs'] = [];
    for (const fa of audit.faces) {
      if (fa.loB < 0 || fa.hiB < 0) continue;
      const aLo = audit.boundaries[fa.loB].aM;
      const aHi = audit.boundaries[fa.hiB].aM;
      const span = aHi - aLo;
      if (!(span > 0.5 * W_M && span < 2 * W_M)) continue; // 폭축이 어긋난 감사 프레임 배제(F5)
      facePairs.push({ faceIdx: fa.faceIdx, aLoM: aLo, aHiM: aHi });
      // v방향은 정답 quad 와 IoU 가 큰 쪽으로 고정한다(오라클 — 채점 경로. 쌍의 두 원소가 **같은** 값을 쓴다).
      const truthQuad = faces.find((f) => f.faceIdx === fa.faceIdx)?.quad;
      if (!truthQuad) continue;
      let bestFlip = false;
      let bestI = -1;
      for (const flipV of [false, true]) {
        const q = auditQuadAt(fr, t.model, aLo, span, D_M, flipV);
        const i = q ? quadIoU(q, truthQuad) : -1;
        if (i > bestI) {
          bestI = i;
          bestFlip = flipV;
        }
      }
      const qA = auditQuadAt(fr, t.model, aLo, span, D_M, bestFlip);
      const qS = auditQuadAt(fr, t.model, aLo + span / 2, span, D_M, bestFlip);
      if (!qA || !qS) continue;
      const sA = supOf(qA, ev);
      const sS = supOf(qS, ev);
      pairs.push({
        key: t.key,
        rowIdx,
        faceIdx: fa.faceIdx,
        spanM: span,
        aligned: { near: sA.near, far: sA.far, side: sA.side, score: sA.score, iou: quadIoU(qA, truthQuad) },
        shifted: { near: sS.near, far: sS.far, side: sS.side, score: sS.score, iou: quadIoU(qS, truthQuad) },
      });
    }
    rows.push({ rowIdx, candIdx: ci, fr, sepAM: audit.sepAM, cand: fronts[ci], facePairs });
  }

  // 전방선 8개 전부를 앵커원으로 쓸 때의 후보 수(오라클 없는 현실 규모의 지표).
  const allFrontCandCount = fronts.reduce((s, c) => s + c.seps.length, 0) * 4;
  return { cands: out, pairs, rows, ev, allFrontCandCount, mismatchQuads };
}

// ── 오버레이 ─────────────────────────────────────────────────────────────────

const poly = (q: PixelQuad, stroke: string, width: number, dash = '') =>
  `<polygon points="${q.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="none" stroke="${stroke}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
const label = (x: number, y: number, t: string, fill: string, size = 18) =>
  `<text x="${x.toFixed(0)}" y="${y.toFixed(0)}" fill="${fill}" font-size="${size}" font-weight="bold" stroke="#000" stroke-width="0.6" paint-order="stroke">${t}</text>`;

async function drawOverlay(
  t: Target,
  cands: readonly AnchorCand[],
  title: string,
  sub: string,
  outPath: string,
  colorOf: (c: AnchorCand) => string,
  strokeW: number,
): Promise<void> {
  const parts: string[] = [];
  for (const c of cands) parts.push(poly(c.quad, colorOf(c), strokeW));
  for (const v of t.vis) {
    parts.push(poly(v.quad, '#00e676', 3));
    const cx = (v.quad[0].x + v.quad[1].x + v.quad[2].x + v.quad[3].x) / 4;
    const cy = (v.quad[0].y + v.quad[1].y + v.quad[2].y + v.quad[3].y) / 4;
    parts.push(label(cx - 24, cy, `r${v.face.rowIdx}f${v.face.faceIdx}`, '#00e676', 17));
  }
  parts.push(`<rect x="14" y="14" width="1360" height="132" fill="#000000cc" rx="8"/>`);
  parts.push(label(30, 50, `${title} · ${t.key} · 프레임 ${t.frameHash} · ${t.note}`, '#fff', 24));
  parts.push(label(30, 84, sub, '#ddd', 20));
  parts.push(
    `<text x="30" y="118" font-size="18" font-weight="bold"><tspan fill="#00e676">━ 씬 정답(채점 전용)</tspan>  <tspan fill="#00e5ff">━ 정답 매칭(IoU≥${MATCH_MIN_IOU})</tspan>  <tspan fill="#ff1744">━ 비매칭 후보</tspan></text>`,
  );
  const svg = `<svg width="${t.W}" height="${t.H}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
  const composed = await sharp(t.jpg).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer();
  writeFileSync(outPath, composed);
}

// ── main ─────────────────────────────────────────────────────────────────────

const f6 = (v: number | undefined): string => (v == null || !Number.isFinite(v) ? '--' : v.toFixed(6));

async function main(): Promise<void> {
  const targetArg = process.argv[2] ?? 'v1';
  const outDir = process.argv[3] ?? 'reports/overlay_r22e';
  mkdirSync(outDir, { recursive: true });

  console.log(
    `22회차 Phase 0 — 「경계앵커 닫기」(안 1) 착수 전 상한 측정\n` +
      `★ 검출 알고리즘 배선 0줄 · src/ground 무접촉 · 씬 정답은 채점 전용(R1)\n` +
      `★ 후보 = 정련 분리선 1개 × 닫는방향 2(좌/우) × v방향 2 · 규격 ${W_M}m × ${D_M}m\n` +
      `대상: ${targetArg} · 오버레이: ${outDir}\n`,
  );

  const targets = await goldenTargets(GOLDEN_DIRS[targetArg] ?? targetArg);
  const all: Array<{ t: Target; cands: AnchorCand[]; pairs: PhasePair[]; ev: PaintEvidence; allFrontCandCount: number }> = [];
  let mismatchTotal = 0;

  for (const t of targets) {
    const r = await measureTarget(t);
    mismatchTotal += r.mismatchQuads;
    all.push({ t, cands: r.cands, pairs: r.pairs, ev: r.ev, allFrontCandCount: r.allFrontCandCount });
    const matched = new Set(r.cands.map((c) => c.matchedFaceKey).filter((v): v is string => v != null));
    console.log(
      `=== ${t.key}  프레임 ${t.frameHash}  ${t.note}\n` +
        `    씬가시 ${t.vis.length}면 · 감사행 ${r.rows.length}개(전방선#${r.rows.map((x) => x.candIdx).join(',')})` +
        ` · 앵커 분리선 ${r.rows.reduce((s, x) => s + x.sepAM.filter(Number.isFinite).length, 0)}개` +
        ` → 후보 ${r.cands.length}개 (전방선 8개 전부 쓰면 ${r.allFrontCandCount}개)\n` +
        `    후보 중 정답 매칭 ${r.cands.filter((c) => c.matchedFaceKey).length}개 · 회수된 정답 면 ${matched.size}/${t.vis.length}` +
        `  [${[...matched].sort().join(' ')}]`,
    );
  }

  const cands = all.flatMap((a) => a.cands);
  const truthTotal = all.reduce((s, a) => s + a.t.vis.length, 0);
  const recovered = all.reduce(
    (s, a) => s + new Set(a.cands.map((c) => c.matchedFaceKey).filter((v): v is string => v != null)).size,
    0,
  );

  // ═══ ⓔ ═══════════════════════════════════════════════════════════════════
  console.log(
    `\n═══ ⓔ 「경계 1개 + 규격 폭」 닫기의 상한 (원시 배정도) ═══\n` +
      `  씬 정답 면(분모)             ${truthTotal}\n` +
      `  후보 총수(감사 전방선 기준)   ${cands.length}\n` +
      `  후보 총수(전방선 8개 전부)    ${all.reduce((s, a) => s + a.allFrontCandCount, 0)}   ← 오라클 없는 현실 규모\n` +
      `  ★ 재현율 상한(게이트 0)      ${recovered / truthTotal}   (${recovered}/${truthTotal})\n` +
      `  ★ 정밀도(후보 총수 대비)     ${recovered / cands.length}   (${recovered}/${cands.length})\n` +
      `  quad 재사용 정합 불일치      ${mismatchTotal}건 (0 이어야 정상)`,
  );
  const keptAll = resolveExclusivity(cands, DEFAULT_BAY_OPTS.rowMergeIoU);
  const keptFaces = new Set(keptAll.map((c) => c.matchedFaceKey).filter((v): v is string => v != null)).size;
  console.log(
    `  ★ 배타성 해소(quadIoU≥${DEFAULT_BAY_OPTS.rowMergeIoU}) 후 산출 ${keptAll.length}개 → 재현율 ${keptFaces / truthTotal} (${keptFaces}/${truthTotal})` +
      ` · 정밀도 ${keptFaces / keptAll.length}\n` +
      `  ※ 배타성은 게이트가 아니다 — 겹치지 않는 오검출은 서로를 밀어내지 못한다(21회차 규약).`,
  );
  console.log(`\n  프리셋별:`);
  console.log(`   대상  프레임해시    가시면  후보수  회수면  재현율                정밀도(후보대비)`);
  for (const a of all) {
    const rec = new Set(a.cands.map((c) => c.matchedFaceKey).filter((v): v is string => v != null)).size;
    console.log(
      `   ${a.t.key.padEnd(5)} ${a.t.frameHash}  ${String(a.t.vis.length).padStart(6)}  ${String(a.cands.length).padStart(6)}  ` +
        `${String(rec).padStart(6)}  ${String(rec / a.t.vis.length).padEnd(20)}  ${rec / Math.max(1, a.cands.length)}`,
    );
  }

  // ═══ ⓔ-2 ═════════════════════════════════════════════════════════════════
  const truthC = cands.filter((c) => c.matchedFaceKey != null);
  const noiseC = cands.filter((c) => c.matchedFaceKey == null);
  const q = (xs: number[]) => quantiles(xs);
  const dist = (name: string, sel: (c: AnchorCand) => number) => {
    const a = [...truthC].map(sel).sort((x, y) => x - y);
    const b = [...noiseC].map(sel).sort((x, y) => x - y);
    const p10 = (s: number[]) => (s.length ? s[Math.max(0, Math.ceil(0.1 * s.length) - 1)] : NaN);
    const qa = q(a);
    const qb = q(b);
    console.log(
      `  ${name.padEnd(14)} 참 n=${String(a.length).padStart(4)} min ${f6(a[0])} p10 ${f6(p10(a))} median ${f6(qa?.median)} p90 ${f6(qa?.p90)} max ${f6(qa?.max)}\n` +
        `  ${' '.repeat(14)} 잡음 n=${String(b.length).padStart(4)} min ${f6(b[0])} p10 ${f6(p10(b))} median ${f6(qb?.median)} p90 ${f6(qb?.p90)} max ${f6(qb?.max)}`,
    );
  };
  console.log(
    `\n═══ ⓔ-2 예측변 도색지지의 판별력 (라벨 = 정답 IoU≥${MATCH_MIN_IOU} · 문턱 미확정 · 분포 먼저) ═══\n` +
      `  참 후보 ${truthC.length}개 / 잡음 후보 ${noiseC.length}개 (총 ${cands.length})`,
  );
  dist('예측변 hitRatio', (c) => c.predHit);
  dist('앵커변 hitRatio', (c) => c.anchorHit);
  dist('면 near', (c) => c.near);
  dist('면 side', (c) => c.side);
  dist('면 score', (c) => c.score);
  dist('깊이(m)', (c) => c.depthM ?? Number.NaN);

  // 0.70~0.90 을 촘촘히 — 정밀도가 목표선 0.70 을 **처음 넘는 지점**과 그때의 재현율을 특정하기 위해.
  const TAUS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.82, 0.85, 0.87, 0.9, 0.95, 1.0];
  console.log(
    `\n  ── τ_pred 스윕 (분모 ${truthTotal}면 · 배타성 quadIoU≥${DEFAULT_BAY_OPTS.rowMergeIoU})\n` +
      `   τ_pred  생존(참/잡음)      생존율    참생존율  잡음생존율  산출  회수면  재현율                정밀도\n` +
      `   설계자 목표선: 생존율 ≤ ${TARGET_SURVIVAL} (=58/1536) 이면서 정밀도 ≥ ${TARGET_PRECISION}\n` +
      `   ★ 실측 분모로 다시 세운 목표선: 회수 가능 면이 ${recovered}개뿐이므로 정밀도 ${TARGET_PRECISION} 이려면 산출 ≤ ${Math.floor(recovered / TARGET_PRECISION)}개`,
  );
  for (const r of gateSweep(cands, TAUS, truthTotal, DEFAULT_BAY_OPTS.rowMergeIoU)) {
    console.log(
      `   ${r.tau.toFixed(2).padStart(6)}  ${String(r.survivors).padStart(5)}(${String(r.survTrue).padStart(3)}/${String(r.survNoise).padStart(4)})  ` +
        `${r.survivalRate.toFixed(6)}  ${(r.survTrue / truthC.length).toFixed(6)}  ${(r.survNoise / noiseC.length).toFixed(6)}  ` +
        `${String(r.kept).padStart(4)}  ${String(r.recallFaces).padStart(6)}  ${String(r.recall).padEnd(20)}  ${r.precision}`,
    );
  }

  // 예측변 + 근변(게이트②) 병용 — near 는 위상맹으로 확정돼 있으나 「함께 걸면」을 값으로 확인한다.
  console.log(`\n  ── 예측변 τ + 근변 게이트②(near ≥ ${DEFAULT_BAY_OPTS.extendMinNearSupport}) 병용`);
  console.log(`   τ_pred  생존후보  생존율      배타성후산출  회수면  재현율                정밀도`);
  const withG2 = cands.filter((c) => c.near >= DEFAULT_BAY_OPTS.extendMinNearSupport);
  for (const r of gateSweep(withG2, TAUS, truthTotal, DEFAULT_BAY_OPTS.rowMergeIoU)) {
    const sr = cands.length ? r.survivors / cands.length : 0;
    console.log(
      `   ${r.tau.toFixed(2).padStart(6)}  ${String(r.survivors).padStart(8)}  ${sr.toFixed(6)}  ` +
        `${String(r.kept).padStart(12)}  ${String(r.recallFaces).padStart(6)}  ${String(r.recall).padEnd(20)}  ${r.precision}`,
    );
  }

  // ★ 게이트③(물리 타당성 — 깊이)까지 더한 **낙관적** 상한.
  //   깊이 대역을 **참 라벨의 분포**에서 뽑았으므로 오라클 유래다 — 실검출기가 이만큼 잘 고를 수 없다.
  //   따라서 아래 값은 「게이트③을 최선으로 썼을 때의 천장」이며 달성치가 아니다.
  const truthDepths = truthC.map((c) => c.depthM).filter((v): v is number => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  const dLo = truthDepths[0];
  const dHi = truthDepths[Math.ceil(0.95 * truthDepths.length) - 1];
  const withG3 = cands.filter((c) => c.depthM != null && c.depthM >= dLo && c.depthM <= dHi);
  console.log(
    `\n  ── 예측변 τ + 게이트③(깊이 ∈ [${f6(dLo)}, ${f6(dHi)}]m — **참 라벨 분포에서 뽑은 오라클 대역**) 병용\n` +
      `     대역 통과: 참 ${withG3.filter((c) => c.matchedFaceKey).length}/${truthC.length} · 잡음 ${withG3.filter((c) => !c.matchedFaceKey).length}/${noiseC.length}\n` +
      `   τ_pred  생존후보  생존율      배타성후산출  회수면  재현율                정밀도`,
  );
  for (const r of gateSweep(withG3, TAUS, truthTotal, DEFAULT_BAY_OPTS.rowMergeIoU)) {
    const sr = cands.length ? r.survivors / cands.length : 0;
    console.log(
      `   ${r.tau.toFixed(2).padStart(6)}  ${String(r.survivors).padStart(8)}  ${sr.toFixed(6)}  ` +
        `${String(r.kept).padStart(12)}  ${String(r.recallFaces).padStart(6)}  ${String(r.recall).padEnd(20)}  ${r.precision}`,
    );
  }

  // ═══ ⓐ′ ══════════════════════════════════════════════════════════════════
  const pairs = all.flatMap((a) => a.pairs);
  console.log(
    `\n═══ ⓐ′ 면 단위(k=1) 위상 판별력 — 정답 칸 vs 반칸 밀린 칸 ═══\n` +
      `  같은 행 좌표계 · 같은 폭(참 경계 실측 span) · 같은 v방향. **위상만** 반칸 다르다.\n` +
      `  표본 ${pairs.length}쌍`,
  );
  const comp = (name: string, sel: (p: PhasePair['aligned']) => number) => {
    const A = pairs.map((p) => sel(p.aligned));
    const S = pairs.map((p) => sel(p.shifted));
    const d = pairs.map((p, i) => A[i] - S[i]);
    const qa = q(A);
    const qs = q(S);
    const qd = q(d);
    const win = d.filter((v) => v > 0).length;
    const tie = d.filter((v) => v === 0).length;
    console.log(
      `  ${name.padEnd(6)} 정답칸 median ${f6(qa?.median)} · 반칸 median ${f6(qs?.median)} · Δ median ${f6(qd?.median)} · Δ min ${f6(qd ? Math.min(...d) : undefined)}\n` +
        `  ${' '.repeat(6)} 정답칸이 이긴 쌍 ${win}/${pairs.length} · 동점 ${tie} · 진 쌍 ${pairs.length - win - tie}`,
    );
  };
  comp('side', (x) => x.side);
  comp('near', (x) => x.near);
  comp('far', (x) => x.far);
  comp('score', (x) => x.score);
  console.log(
    `  ── 완전분리 판정: 두 라벨의 구간이 겹치는가\n` +
      (['side', 'near', 'far', 'score'] as const)
        .map((k) => {
          const A = pairs.map((p) => p.aligned[k]);
          const S = pairs.map((p) => p.shifted[k]);
          const loA = Math.min(...A);
          const hiS = Math.max(...S);
          return `     ${k.padEnd(6)} 정답칸 min ${f6(loA)} vs 반칸 max ${f6(hiS)} → ${loA > hiS ? '★ 완전분리' : `겹침(폭 ${f6(hiS - loA)})`}`;
        })
        .join('\n'),
  );
  console.log(`\n  쌍별 원시값(key row face span side정답 side반칸 Δ):`);
  for (const p of pairs)
    console.log(
      `   ${p.key} r${p.rowIdx}f${p.faceIdx} span=${f6(p.spanM)} side ${f6(p.aligned.side)} vs ${f6(p.shifted.side)} Δ=${f6(p.aligned.side - p.shifted.side)}` +
        ` · near ${f6(p.aligned.near)} vs ${f6(p.shifted.near)} · IoU ${f6(p.aligned.iou)} vs ${f6(p.shifted.iou)}`,
    );

  // ═══ 오버레이 ═════════════════════════════════════════════════════════════
  // 스샷 문턱 2개는 **스윕 표가 지목한 지점**이다(임의 선택 아님):
  //   τ=0.70 — 생존율이 설계자 목표 3.8% 에 처음 닿는 지점 · τ=0.90 — 정밀도가 0.70 을 처음 넘는 지점.
  const SHOT_TAUS = [0.7, 0.9];
  console.log(`\n═══ 오버레이 (같은 frameHash 위 · F13) — 게이트 스샷 τ_pred=${SHOT_TAUS.join(', ')} ═══`);
  for (const a of all) {
    const before = join(outDir, `cand_all_${a.t.key.replace(':', '_')}.png`);
    await drawOverlay(
      a.t,
      a.cands,
      '후보 전집합(게이트 전)',
      `후보 ${a.cands.length}개 · 정답 ${a.t.vis.length}면 · 회수 ${new Set(a.cands.map((c) => c.matchedFaceKey).filter(Boolean)).size}면`,
      before,
      (c) => (c.matchedFaceKey ? '#00e5ff55' : '#ff174433'),
      1.2,
    );
    const outs = [before];
    for (const tau of SHOT_TAUS) {
      const surv = a.cands.filter((c) => c.predHit >= tau);
      const kept = resolveExclusivity(surv, DEFAULT_BAY_OPTS.rowMergeIoU);
      const after = join(outDir, `cand_gate${String(Math.round(tau * 100))}_${a.t.key.replace(':', '_')}.png`);
      await drawOverlay(
        a.t,
        kept,
        `예측변 게이트 τ=${tau} + 배타성`,
        `생존 ${surv.length} → 산출 ${kept.length}개 · 정답 ${a.t.vis.length}면 · 회수 ${new Set(kept.map((c) => c.matchedFaceKey).filter(Boolean)).size}면`,
        after,
        (c) => (c.matchedFaceKey ? '#00e5ff' : '#ff1744'),
        2.5,
      );
      outs.push(after);
    }
    console.log(`   ${a.t.key} → ${outs.join(' , ')}`);
  }

  console.log(
    `\n※ 한계(추정으로 채우지 않는다):\n` +
      `  · 행별 감사 전방선을 참 경계 적중 수로 골랐다(오라클 유리) — 실검출기의 후보 수는 더 많다.\n` +
      `  · 게이트③(물리 타당성 — medianDepth·지면 방위)은 이 측정에 넣지 않았다. 미측정.\n` +
      `  · 라벨(IoU≥${MATCH_MIN_IOU})은 채점 전용이며 후보 생성·게이트 어디에도 쓰지 않았다.`,
  );
}

if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) await main();
