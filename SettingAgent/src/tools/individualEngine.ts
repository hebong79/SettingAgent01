// ★ 23회차 이터레이션 1 신규 — **개별 독립 검출 엔진 프로토타입**(설계 `_workspace/11_architect_plan_round23_individual_engine.md`).
//
// ══════════════════════════════════════════════════════════════════════════
// 이 파일이 하는 일 (검출 소스 무접촉: `src/ground/**` · `src/rpc/services/**` · `web/**` 0줄 변경)
//
//   ObservationSource.observe(t, view)   →  VehicleObservation[]   ← 교체 지점(실카 seg/VPD 로 갈아끼울 자리)
//   proposeFromObservation(o, t, ev)     →  BayProposal | null      ← 관측 1건 → 면 0 또는 1개 (G1)
//   gateBay(p, params)                   →  GateVerdict             ← 면 1개가 **단독으로** 통과/탈락 (G5 무위반)
//   resolveBays(props, mergeIoU)         →  BayProposal[]           ← quadIoU 배타성
//   scoreBays(kept, t)                   →  Score                   ← ★ 오라클은 여기서만
//
// ══════════════════════════════════════════════════════════════════════════
// ★★ 금지 규약(G1~G8) — 구조로 막는다 ★★
//   G1  `proposeFromObservation` 의 반환 타입이 **배열이 아니라 `BayProposal | null`** 이다.
//       한 번의 결정이 면 2개를 못 낸다 — 타입이 막는다.
//   G2  격자 복제(`phase + k*w`) 없음. 보간 없음.
//   G3  격자 인덱스 개념 없음.
//   G4  행 단위 창 없음.
//   G5  ★ **행 단위 점수 없음** — 게이트는 면 1개의 자기 속성만 본다. 다른 면의 값을 참조하는
//       분모·비율·상대점수가 이 파일에 **존재하지 않는다**. 문턱은 전부 후보 집합과 무관한 절대값이다.
//   G6  면 개수를 미리 아는 인자가 어느 시그니처에도 없다.
//   G7  근변선 재적합 없음.
//   G8  면간 정렬 가점 없음. 면끼리의 상호작용은 **배타성 해소(겹치면 하나만)** 뿐이다.
//
// ★★ 오염 격리 ★★
//   `faceSlot`·`presetId`·`visible` 은 검출 경로가 **읽지 않는다**(`degradeCar` 가 유일한 경계).
//   `pos`·`rotY` 는 강등 어댑터의 투영 입력으로만 쓰이고 하류로는 px 관측만 흐른다.
//   정답(`t.vis`)은 `scoreBays` 에서만 접촉한다.
//
// ★ 재사용 규약(재발명 금지 · 신규 IoU 0줄):
//   `carAnchorUpper` 의 degradeCar/closeBayAt/groundAxisOf/footprintToGround/inFrame/bestIoUOf/
//   scoreClosed/perturbFootprint/rng/viewsOf/carList/worldFaces/assignFaceByGeometry 를 그대로 쓴다.
//   `autoRoiPlan.quadIoU`·`MATCH_MIN_IOU` · `sepAudit.goldenTargets/quantiles/frontCandidatesOf` ·
//   `floorPaint.paintEvidenceOf/edgePaintSupport` · `sceneTruth.quadAreaPx` 재사용.
//
// 사용:
//   npx tsx src/tools/individualEngine.ts v1 --dist
//   npx tsx src/tools/individualEngine.ts v1 --gate --out reports/overlay_r23a
//   npx tsx src/tools/individualEngine.ts v1 --gate --sigma 10 --shadow 15 --out reports/overlay_r23a
// 정본 `PtzCamRoi.json` · DB · `config/` 무접촉(읽기만). Unity RPC 는 **읽기 1회**(`car.list`). 카메라 이동 0.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { backprojectToGround } from '../ground/project.js';
import { MATCH_MIN_IOU, quadIoU } from '../ground/autoRoiPlan.js';
import { DEFAULT_PAINT_OPTIONS, edgePaintSupport, paintEvidenceOf, type PaintEvidence } from '../ground/floorPaint.js';
import { quadAreaPx, type TruthView } from '../ground/sceneTruth.js';
import type { PixelQuad } from '../ground/types.js';
import type { Vec3 } from '../ground/contactTypes.js';
import { frontCandidatesOf, goldenTargets, GOLDEN_DIRS, quantiles, type Target } from './sepAudit.js';
import {
  assignFaceByGeometry,
  bestIoUOf,
  carList,
  closeBayAt,
  degradeCar,
  footprintToGround,
  groundAxisOf,
  inFrame,
  perturbFootprint,
  rng,
  scoreClosed,
  viewsOf,
  worldFaces,
  type ClosedBay,
  type RawCar,
  type Score,
  type VehicleObservation,
} from './carAnchorUpper.js';
// ★ 24회차 — 이미지 유래 관측원(검출 응답 캐시 기반). 검출 소스(`src/ground/*`)는 import 만 한다.
import { lpdPlateSource, vpdSegSource, type SourceDrops } from './imageObservation.js';

// ── 관측 소스 ────────────────────────────────────────────────────────────────

export type ObservationKind = 'sim-degraded' | 'sim-degraded-noisy' | 'real-seg' | 'real-vpd' | 'real-lpd';

export interface ObservationSource {
  readonly kind: ObservationKind;
  /** 이 프리셋 프레임에서 얻은 차량 관측 전부. 오라클 필드는 반환값에 없다(타입이 막는다). */
  observe(t: Target, view: TruthView): VehicleObservation[];
}

/**
 * 이터레이션 1의 유일한 구현체 — 22회차 강등본.
 * σ·그림자 0 이면 22회차 seg 상한을 **그대로** 재현한다(P3 이식 정합 판정의 근거).
 * ★ 난수는 소스 1개당 1스트림이다(22회차 스윕과 같은 소비 순서 — 프리셋 루프를 가로질러 이어진다).
 */
export function simDegradedSource(
  cars: readonly RawCar[],
  opts?: { sigmaPx?: number; shadowPx?: number; seed?: number },
): ObservationSource {
  const sigmaPx = opts?.sigmaPx ?? 0;
  const shadowPx = opts?.shadowPx ?? 0;
  const noisy = sigmaPx > 0 || shadowPx > 0;
  const r = rng(opts?.seed ?? 1);
  return {
    kind: noisy ? 'sim-degraded-noisy' : 'sim-degraded',
    observe(t: Target, view: TruthView): VehicleObservation[] {
      const out: VehicleObservation[] = [];
      for (const c of cars) {
        const o = degradeCar(c, view); // ← 오염 격리 경계
        if (!o.footprintPx) continue;
        if (!inFrame(o.footprintPx, t.W, t.H)) continue; // `visible` 미사용 — 기하 가시성만.
        if (!noisy) {
          out.push(o);
          continue;
        }
        const fp = perturbFootprint(o.footprintPx, sigmaPx, shadowPx, r);
        if (!fp) continue;
        out.push({ ...o, footprintPx: fp });
      }
      return out;
    },
  };
}

// ── 면 제안 ──────────────────────────────────────────────────────────────────

export interface BayProposal {
  obsId: string;
  kind: ObservationKind;
  quad: PixelQuad;
  centerGround: Vec3;
  headGround: Vec3;
  /** 게이트③ 측정량 — quad 중심 역투영 거리(m). 식은 `anchorCloseUpper.ts:296-301` 과 동일. */
  depthM: number | null;
  /** 게이트① 측정량 — 관측 접지사각형의 화면 면적(px²). */
  footprintAreaPx: number;
  /** 게이트① 측정량 — 닫은 면 4점 중 프레임 밖 점 개수(0 이면 완전 가시). */
  outOfFramePts: number;
  /** ★ 측정 전용(이번 이터레이션에서 게이트로 쓰지 않는다 — 설계 §4-3). 4변 각각의 `edgePaintSupport.hitRatio`. */
  edgeHit: { near: number; far: number; sideA: number; sideB: number };
  /**
   * 24회차 게이트 신규 축 — 검출기가 **주는** 신뢰도(우리가 만든 점수가 아니다).
   * `proposeFromObservation` 은 이 값을 모른다(한 줄도 안 고쳤다) — `runEngine` 이 관측에서 실어준다.
   * 강등본은 undefined → 게이트에서 1 취급(축 무력화 → Q3 비트 동일 보장).
   */
  confidence?: number;
}

const midOf = (q: PixelQuad, i: number) => ({ x: (q[i].x + q[(i + 1) % 4].x) / 2, y: (q[i].y + q[(i + 1) % 4].y) / 2 });

/** 4변 도색지지 — **측정 전용**. `near` = 화면상 가장 아래(카메라쪽) 변, `far` = 그 맞은편. */
function edgeHitOf(q: PixelQuad, ev: PaintEvidence | null): BayProposal['edgeHit'] {
  if (!ev) return { near: 0, far: 0, sideA: 0, sideB: 0 };
  let nearIdx = 0;
  for (let i = 1; i < 4; i++) if (midOf(q, i).y > midOf(q, nearIdx).y) nearIdx = i;
  const hit = (i: number) => edgePaintSupport(ev, q[i % 4], q[(i + 1) % 4], DEFAULT_PAINT_OPTIONS).hitRatio;
  return {
    near: hit(nearIdx),
    far: hit(nearIdx + 2),
    sideA: hit(nearIdx + 1),
    sideB: hit(nearIdx + 3),
  };
}

/**
 * ★ 관측 1건 → 면 **0 또는 1개**. 반환 타입이 배열이 아니다(G1).
 * 22회차 seg 경로(`carAnchorUpper.ts:568-579`)와 **같은 4단계**다 — 그래서 게이트 전 산출이 상한과 비트 동일해야 한다.
 */
export function proposeFromObservation(o: VehicleObservation, t: Target, ev: PaintEvidence | null): BayProposal | null {
  if (!o.footprintPx) return null;
  const G = footprintToGround(o.footprintPx, t.model);
  if (!G) return null;
  const ax = groundAxisOf(G);
  if (!ax) return null;
  const quad = closeBayAt(ax.center, ax.head, t.model);
  if (!quad || !inFrame(quad, t.W, t.H)) return null;

  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
  const X = backprojectToGround({ x: cx, y: cy }, t.model);
  return {
    obsId: o.obsId,
    kind: 'sim-degraded',
    quad,
    centerGround: ax.center,
    headGround: ax.head,
    depthM: X ? Math.hypot(X[0], X[1], X[2]) : null,
    footprintAreaPx: quadAreaPx(o.footprintPx),
    outOfFramePts: quad.filter((p) => !(p.x >= 0 && p.y >= 0 && p.x < t.W && p.y < t.H)).length,
    edgeHit: edgeHitOf(quad, ev),
  };
}

// ── 게이트 ───────────────────────────────────────────────────────────────────

/**
 * ★ 전부 **절대 문턱**이다 — 후보 집합에 의존하는 값이 하나도 없다(G5 · 밟지말것 (A)).
 * 물리 단위(px²·점 개수·m)라 프레임 간 스케일 이동이 없다.
 */
export interface GateParams {
  minFootprintAreaPx: number;
  maxOutOfFramePts: number;
  /** 기존 축 재사용. null 이면 미적용. */
  depthLoM: number | null;
  depthHiM: number | null;
  /** 24회차 신규 축(설계 §4-2) — 절대 문턱 1줄. 강등본은 confidence 없음(=1) 이라 무력. */
  minConfidence: number;
}
export interface GateVerdict {
  pass: boolean;
  failed: string[];
}

/** 면 1개가 **단독으로** 통과/탈락한다. 다른 면의 값을 보지 않는다. */
export function gateBay(p: BayProposal, g: GateParams): GateVerdict {
  const failed: string[] = [];
  if (!(p.footprintAreaPx >= g.minFootprintAreaPx)) failed.push('area');
  if (!(p.outOfFramePts <= g.maxOutOfFramePts)) failed.push('outOfFrame');
  if (g.depthLoM != null && !(p.depthM != null && p.depthM >= g.depthLoM)) failed.push('depthLo');
  if (g.depthHiM != null && !(p.depthM != null && p.depthM <= g.depthHiM)) failed.push('depthHi');
  if (!((p.confidence ?? 1) >= g.minConfidence)) failed.push('conf');
  return { pass: failed.length === 0, failed };
}

export const GATE_OFF: GateParams = { minFootprintAreaPx: 0, maxOutOfFramePts: 4, depthLoM: null, depthHiM: null, minConfidence: 0 };

// ── 배타성 ───────────────────────────────────────────────────────────────────

/**
 * 서열: `footprintAreaPx` desc → `outOfFramePts` asc → `obsId`.
 * ★ 중복 고지: `anchorCloseUpper.resolveExclusivity`(:130) 는 서열 키가 `predHit`·`sepSpanPx` 로 박혀 있어
 *   재사용 불가다(제네릭화 = 로직 변경 = 금지 규약 위반). 알고리즘은 동일하고 `quadIoU` 는 재사용한다.
 */
export function resolveBays(props: readonly BayProposal[], mergeIoU: number): BayProposal[] {
  const ranked = [...props].sort(
    (a, b) => b.footprintAreaPx - a.footprintAreaPx || a.outOfFramePts - b.outOfFramePts || (a.obsId < b.obsId ? -1 : a.obsId > b.obsId ? 1 : 0),
  );
  const kept: BayProposal[] = [];
  for (const p of ranked) {
    if (kept.some((k) => quadIoU(k.quad, p.quad) >= mergeIoU)) continue;
    kept.push(p);
  }
  return kept;
}

// ── 채점(오라클 유일 접점) ────────────────────────────────────────────────────

/** 면 제안 → 채점용 `ClosedBay`. **여기서만** 정답(`t.vis`)에 접촉한다. */
export function closedOf(kept: readonly BayProposal[], t: Target): ClosedBay[] {
  return kept.map((p) => {
    const m = bestIoUOf(p.quad, t.vis, t.key);
    return { obsId: p.obsId, path: 'seg' as const, quad: p.quad, bestIoU: m.iou, matchedFaceKey: m.iou >= MATCH_MIN_IOU ? m.key : null };
  });
}

export function scoreBays(kept: readonly BayProposal[], t: Target): Score {
  return scoreClosed(closedOf(kept, t), t.vis.length);
}

// ── 실행 ─────────────────────────────────────────────────────────────────────

export interface EngineRun {
  proposals: BayProposal[];
  gated: BayProposal[];
  kept: BayProposal[];
  /** ★ 게이트 0 — 22회차 seg 상한과 비트 동일해야 한다(P3). */
  scoreUngated: Score;
  scoreGated: Score;
  /** 전역 집계용(프리셋 합산 분모). */
  closedUngated: ClosedBay[];
  closedGated: ClosedBay[];
  /** 탈락 사유(스샷 라벨용). */
  verdicts: Map<string, GateVerdict>;
}

export function runEngine(t: Target, view: TruthView, src: ObservationSource, g: GateParams, ev: PaintEvidence | null): EngineRun {
  const proposals: BayProposal[] = [];
  for (const o of src.observe(t, view)) {
    const p = proposeFromObservation(o, t, ev);
    if (p) proposals.push({ ...p, kind: src.kind, confidence: o.confidence });
  }
  const verdicts = new Map<string, GateVerdict>();
  const gated: BayProposal[] = [];
  for (const p of proposals) {
    const v = gateBay(p, g);
    verdicts.set(p.obsId, v);
    if (v.pass) gated.push(p);
  }
  const kept = resolveBays(gated, MATCH_MIN_IOU);
  const closedUngated = closedOf(proposals, t);
  const closedGated = closedOf(kept, t);
  return {
    proposals,
    gated,
    kept,
    scoreUngated: scoreClosed(closedUngated, t.vis.length),
    scoreGated: scoreClosed(closedGated, t.vis.length),
    closedUngated,
    closedGated,
    verdicts,
  };
}

// ── 오버레이 ─────────────────────────────────────────────────────────────────

const poly = (q: PixelQuad, stroke: string, width: number, dash = '') =>
  `<polygon points="${q.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="none" stroke="${stroke}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
const label = (x: number, y: number, tx: string, fill: string, size = 18) =>
  `<text x="${x.toFixed(0)}" y="${y.toFixed(0)}" fill="${fill}" font-size="${size}" font-weight="bold" stroke="#000" stroke-width="0.6" paint-order="stroke">${tx}</text>`;
const midQ = (q: PixelQuad) => ({ x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4, y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4 });

/** 회색 점선 레이어(게이트 탈락분)가 추가로 필요해 자체 렌더러를 둔다. `sharp` composite 방식은 22회차와 동일. */
async function drawEngineOverlay(t: Target, run: EngineRun, title: string, subLine: string, outPath: string): Promise<void> {
  const parts: string[] = [];
  for (const v of t.vis) {
    parts.push(poly(v.quad, '#00e676', 3));
    const c = midQ(v.quad);
    parts.push(label(c.x - 26, c.y, `r${v.face.rowIdx}f${v.face.faceIdx}`, '#00e676', 17));
  }
  // 게이트 탈락분 — 회색 점선 + 사유.
  const keptIds = new Set(run.kept.map((p) => p.obsId));
  for (const p of run.proposals) {
    if (keptIds.has(p.obsId)) continue;
    const v = run.verdicts.get(p.obsId);
    const why = v && v.failed.length ? v.failed.join(',') : 'exclusivity';
    parts.push(poly(p.quad, '#9e9e9e', 2.4, '8 5'));
    const c = midQ(p.quad);
    parts.push(label(c.x - 40, c.y + 22, `✕ ${why}`, '#bdbdbd', 16));
  }
  const closed = closedOf(run.kept, t);
  for (const c of closed) parts.push(poly(c.quad, c.matchedFaceKey ? '#00e5ff' : '#ff1744', 2.8));
  parts.push(`<rect x="14" y="14" width="1420" height="150" fill="#000000cc" rx="8"/>`);
  parts.push(label(30, 50, `${title} · ${t.key} · 프레임해시 ${t.frameHash} · ${t.note}`, '#fff', 23));
  parts.push(label(30, 84, subLine, '#ddd', 19));
  parts.push(
    `<text x="30" y="118" font-size="17" font-weight="bold"><tspan fill="#00e676">━ 정답 면(채점 전용)</tspan>  <tspan fill="#00e5ff">━ 산출 · 정답 매칭(IoU≥${MATCH_MIN_IOU})</tspan>  <tspan fill="#ff1744">━ 산출 · 비매칭</tspan></text>`,
  );
  parts.push(`<text x="30" y="146" font-size="17" font-weight="bold"><tspan fill="#9e9e9e">┄ 게이트/배타성 탈락(사유 병기)</tspan></text>`);
  const svg = `<svg width="${t.W}" height="${t.H}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
  writeFileSync(outPath, await sharp(t.jpg).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer());
}

// ── main ─────────────────────────────────────────────────────────────────────

const argOf = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : dflt;
};
const has = (name: string): boolean => process.argv.includes(name);

const dist = (xs: number[]): string => {
  const s = [...xs].sort((a, b) => a - b);
  const q = quantiles(s);
  return `n=${String(s.length).padStart(2)} min=${String(s[0] ?? NaN).padEnd(22)} median=${String(q?.median ?? NaN).padEnd(22)} p90=${String(q?.p90 ?? NaN).padEnd(22)} max=${String(q?.max ?? NaN)}`;
};

async function main(): Promise<void> {
  const targetArg = process.argv[2] ?? 'v1';
  const outDir = argOf('--out', 'reports/overlay_r23a');
  const sigmaPx = Number(argOf('--sigma', '0'));
  const shadowPx = Number(argOf('--shadow', '0'));
  const gateOn = has('--gate');
  const showDist = has('--dist');
  const GATE_ON: GateParams = {
    minFootprintAreaPx: Number(argOf('--minArea', '0')),
    maxOutOfFramePts: Number(argOf('--maxOut', '4')),
    depthLoM: argOf('--depthLo', '') === '' ? null : Number(argOf('--depthLo', '')),
    depthHiM: argOf('--depthHi', '') === '' ? null : Number(argOf('--depthHi', '')),
    minConfidence: Number(argOf('--minConf', '0')),
  };
  const g = gateOn ? GATE_ON : GATE_OFF;

  const cars = await carList();
  const targets = await goldenTargets(GOLDEN_DIRS[targetArg] ?? targetArg);
  const views = viewsOf(targets);
  const wf = worldFaces();

  console.log(
    `23회차 이터레이션 1 — 개별 독립 검출 엔진(안 2 단독)\n` +
      `★ 검출 소스 무접촉(src/ground · src/rpc/services · web 0줄) · Unity RPC 읽기 1회(car.list) · 카메라 이동 0\n` +
      `★ 게이트: ${gateOn ? JSON.stringify(GATE_ON) : '전부 OFF (= 22회차 상한 재현 · P3)'}\n` +
      `★ 관측소스: sigma=${sigmaPx}px shadow=${shadowPx}px · 배타성 mergeIoU=${MATCH_MIN_IOU}\n` +
      `대상: ${targetArg} · 차량 ${cars.length}대 · 씬 면 ${wf.length}개\n`,
  );

  // 도색 증거 — **측정 전용**(게이트에 쓰지 않는다).
  const evs = new Map<string, PaintEvidence>();
  for (const t of targets) {
    const { mask } = frontCandidatesOf(t.frame);
    evs.set(t.key, paintEvidenceOf(mask, t.W, t.H));
  }

  // ★ 24회차 — 관측원 선택. `--source all` 이 정본(프레임을 한 번만 읽으므로 frameHash 가 물리적으로 동일).
  const sourceArg = argOf('--source', 'degraded');
  const cacheDir = argOf('--cache', 'reports/detcache_r24');
  const names = sourceArg === 'all' ? ['degraded', 'vpdseg', 'lpd'] : [sourceArg];
  const dropsOf = new Map<string, Map<string, SourceDrops>>();
  for (const name of names) {
    const dm = new Map<string, SourceDrops>();
    dropsOf.set(name, dm);
    const src: ObservationSource =
      name === 'vpdseg' ? vpdSegSource(cacheDir, dm) : name === 'lpd' ? lpdPlateSource(cacheDir, dm) : simDegradedSource(cars, { sigmaPx, shadowPx, seed: 1 });
    console.log(`\n████ 관측원 = ${name} (kind=${src.kind}) ████`);
    await runOneSource(name, src, targets, views, evs, g, gateOn, sigmaPx, shadowPx, showDist, outDir, cars, wf);
  }
  console.log(
    `\n※ 한계(추정으로 채우지 않는다):\n` +
      `  · VPD seg 소스는 **24회차 계측 전용**이다 — 실카 셋업 경로에 배선하지 않는다(VPD 자동검출 금지 규약).\n` +
      `  · \`SlotAxes\` 를 요구하는 로버스트 적합(fitContactLine/buildFootprint)은 오라클 주입 위험으로 **미사용**(설계 §1-3, 자각한 손실).\n` +
      `  · 실카 세그/VPD 의 실제 σ 는 여전히 미측정이다(시뮬 골든 실측만).`,
  );
}

/** 소스 1개를 끝까지 돌리고 출력한다. 본문은 23회차 그대로 — 소스만 인자로 받는다. */
async function runOneSource(
  name: string,
  src: ObservationSource,
  targets: readonly Target[],
  views: Map<string, TruthView>,
  evs: Map<string, PaintEvidence>,
  g: GateParams,
  gateOn: boolean,
  sigmaPx: number,
  shadowPx: number,
  showDist: boolean,
  outDir: string,
  cars: readonly RawCar[],
  wf: ReturnType<typeof worldFaces>,
): Promise<void> {
  const runs: Array<{ t: Target; run: EngineRun }> = [];
  for (const t of targets) {
    const view = views.get(t.key);
    if (!view) continue;
    runs.push({ t, run: runEngine(t, view, src, g, evs.get(t.key) ?? null) });
  }

  const truthTotal = runs.reduce((s, r) => s + r.t.vis.length, 0);
  const sUn = scoreClosed(runs.flatMap((r) => r.run.closedUngated), truthTotal);
  const sGa = scoreClosed(runs.flatMap((r) => r.run.closedGated), truthTotal);

  console.log(
    `═══ 전역 성적 (분모 ${truthTotal}면 · 원시 배정도) ═══\n` +
      `  게이트 전(scoreUngated): 산출 ${sUn.outputs} · 회수면 ${sUn.faces} · 재현율 ${sUn.recall} · 정밀도 ${sUn.precision}\n` +
      `  게이트 후(scoreGated)  : 산출 ${sGa.outputs} · 회수면 ${sGa.faces} · 재현율 ${sGa.recall} · 정밀도 ${sGa.precision}\n` +
      `  ★ P3/Q3 기준(강등본 23회차): outputs 42 · faces 39 · recall 0.9512195121951219 · precision 0.9285714285714286\n` +
      `  ★ P3/Q3 판정(강등본에만 적용): ${sUn.outputs === 42 && sUn.faces === 39 && sUn.recall === 0.9512195121951219 && sUn.precision === 0.9285714285714286 ? 'PASS (비트 동일)' : name === 'degraded' ? 'FAIL' : '해당없음(이미지 유래 소스)'}`,
  );
  // ── Q4 상한 정합 — 넘으면 오라클 누출 의심(설계 §6) ────────────────────────
  const CAP: Record<string, number> = { vpdseg: 0.8780487804878049, lpd: 0.8048780487804879 };
  if (CAP[name] != null) {
    const over = sUn.recall > CAP[name] || sGa.recall > CAP[name];
    console.log(`  ★ Q4 상한 정합(${name}): 상한 ${CAP[name]} · 실측(전) ${sUn.recall} · 실측(후) ${sGa.recall} → ${over ? '★★ 초과 — 오라클 누출 의심(중단 규약)' : 'PASS'}`);
  }

  console.log(`\n  프리셋별(프레임해시 병기 — F13):`);
  console.log(`   대상  프레임해시    가시면 제안 게이트통과 배타성후 회수면(전) 회수면(후)`);
  for (const { t, run } of runs) {
    console.log(
      `   ${t.key.padEnd(5)} ${t.frameHash} ${String(t.vis.length).padStart(6)} ${String(run.proposals.length).padStart(4)} ` +
        `${String(run.gated.length).padStart(9)} ${String(run.kept.length).padStart(8)} ${String(run.scoreUngated.faces).padStart(10)} ${String(run.scoreGated.faces).padStart(10)}`,
    );
  }

  // ── 배타성이 몇 개를 접었는가 ───────────────────────────────────────────────
  const foldedTotal = runs.reduce((s, r) => s + (r.run.gated.length - r.run.kept.length), 0);
  const gateKilled = runs.reduce((s, r) => s + (r.run.proposals.length - r.run.gated.length), 0);
  console.log(
    `\n  ★ 게이트 탈락 ${gateKilled}건 · 배타성 접힘 ${foldedTotal}건 (제안 ${runs.reduce((s, r) => s + r.run.proposals.length, 0)} → 게이트 후 ${runs.reduce((s, r) => s + r.run.gated.length, 0)} → 배타성 후 ${runs.reduce((s, r) => s + r.run.kept.length, 0)})`,
  );
  for (const { t, run } of runs) {
    const keptIds = new Set(run.kept.map((p) => p.obsId));
    const uc = closedOf(run.proposals, t);
    for (const p of run.proposals) {
      if (keptIds.has(p.obsId)) continue;
      const v = run.verdicts.get(p.obsId)!;
      const c = uc.find((x) => x.obsId === p.obsId)!;
      console.log(
        `     탈락 ${t.key} ${p.obsId} 사유=${v.failed.length ? v.failed.join(',') : 'exclusivity'} ` +
          `area=${p.footprintAreaPx} out=${p.outOfFramePts} depth=${p.depthM} 게이트전매칭=${c.matchedFaceKey ?? '(비매칭)'} IoU=${c.bestIoU}`,
      );
    }
  }

  // ── 미회수 면 ID 특정 ──────────────────────────────────────────────────────
  const recovered = new Set(runs.flatMap((r) => r.run.closedUngated).map((c) => c.matchedFaceKey).filter((v): v is string => v != null));
  const allFaceKeys = runs.flatMap((r) => r.t.vis.map((v) => `${r.t.key}|r${v.face.rowIdx}f${v.face.faceIdx}`));
  const tagsFace = new Map(cars.map((c) => [c.carNameId, assignFaceByGeometry(c.pos, wf)] as const));
  const occupied = new Set([...tagsFace.values()].filter((v): v is string => v != null));
  console.log(
    `\n  ★ 게이트 전 미회수 면(안 2 원리 한계 특정): ${allFaceKeys.filter((k) => !recovered.has(k)).map((k) => `${k}${occupied.has(k.split('|')[1]) ? '(차량있음)' : '(빈 면)'}`).join(' · ') || '없음'}`,
  );

  // ── ★ 24회차 산출물 — 미회수 면을 「검출 미탐」 대 「기하 결손」으로 분해 ──────
  //    기준: 그 면 위에 **관측 접지사각형이 조금이라도 겹쳤는가**(quadIoU > 0). 겹쳤는데 못 닫았으면 기하 결손,
  //    아예 안 겹쳤으면 그 면에는 검출 자체가 없었다(미탐). 오라클은 이 채점 구획 안에서만 만진다.
  let missDet = 0;
  let missGeo = 0;
  const missLines: string[] = [];
  for (const { t, run } of runs) {
    const rec = new Set(run.closedUngated.map((c) => c.matchedFaceKey).filter((v): v is string => v != null));
    for (const v of t.vis) {
      const key = `${t.key}|r${v.face.rowIdx}f${v.face.faceIdx}`;
      if (rec.has(key)) continue;
      let best = 0;
      for (const p of run.proposals) best = Math.max(best, quadIoU(v.quad, p.quad));
      if (best > 0) {
        missGeo += 1;
        missLines.push(`${key} 기하결손(최대IoU ${best})`);
      } else {
        missDet += 1;
        missLines.push(`${key} 검출미탐(겹친 제안 없음)`);
      }
    }
  }
  console.log(`  ★ 미회수 원인 분해(${name}): 검출 미탐 ${missDet}면 · 기하 결손 ${missGeo}면 (합 ${missDet + missGeo})`);
  for (const l of missLines) console.log(`     · ${l}`);

  // ── 분포 ───────────────────────────────────────────────────────────────────
  if (showDist) {
    const rows = runs.flatMap(({ t, run }) => {
      const uc = closedOf(run.proposals, t);
      return run.proposals.map((p) => ({ p, matched: uc.find((x) => x.obsId === p.obsId)!.matchedFaceKey != null }));
    });
    const T = rows.filter((r) => r.matched).map((r) => r.p);
    const N = rows.filter((r) => !r.matched).map((r) => r.p);
    console.log(`\n═══ Phase 0 분포 — 참(매칭) ${T.length}건 vs 잡음(비매칭) ${N.length}건 · 원시 배정도 ═══`);
    const axes: Array<[string, (p: BayProposal) => number]> = [
      ['footprintAreaPx', (p) => p.footprintAreaPx],
      ['outOfFramePts  ', (p) => p.outOfFramePts],
      ['depthM         ', (p) => p.depthM ?? NaN],
      ['edgeHit.near   ', (p) => p.edgeHit.near],
      ['edgeHit.far    ', (p) => p.edgeHit.far],
      ['edgeHit.sideA  ', (p) => p.edgeHit.sideA],
      ['edgeHit.sideB  ', (p) => p.edgeHit.sideB],
      ['confidence     ', (p) => p.confidence ?? 1],
    ];
    for (const [axName, f] of axes) {
      console.log(`  ${axName}  참   ${dist(T.map(f))}`);
      console.log(`  ${axName}  잡음 ${dist(N.map(f))}`);
    }
    console.log(`\n  잡음 제안 원시 목록:`);
    for (const { t, run } of runs) {
      const uc = closedOf(run.proposals, t);
      for (const p of run.proposals) {
        if (uc.find((x) => x.obsId === p.obsId)!.matchedFaceKey != null) continue;
        console.log(
          `    ${t.key} ${p.obsId} area=${p.footprintAreaPx} out=${p.outOfFramePts} depth=${p.depthM} ` +
            `edgeHit near=${p.edgeHit.near} far=${p.edgeHit.far} sideA=${p.edgeHit.sideA} sideB=${p.edgeHit.sideB}`,
        );
      }
    }
    console.log(
      `\n  ★ 도색지지(edgeHit)는 **게이트에 쓰지 않는다**(설계 §4-3: 안 2 표적이 「도색 한 줄 없는 가림면」).\n` +
        `    잡음 표본 ${N.length}건이라 이번 이터레이션에서 승격 판정을 하지 않는다.`,
    );
  }

  // ── 스샷 ───────────────────────────────────────────────────────────────────
  if (has('--out')) {
    mkdirSync(outDir, { recursive: true });
    const tag = sigmaPx > 0 || shadowPx > 0 ? `${name}_noisy_s${sigmaPx}d${shadowPx}` : name;
    for (const { t, run } of runs) {
      const s = gateOn ? run.scoreGated : run.scoreUngated;
      const path = join(outDir, `r24_${tag}_${t.key.replace(':', '_')}_${t.frameHash}.png`);
      await drawEngineOverlay(
        t,
        run,
        `관측원=${name}(${gateOn ? '게이트 ON' : '게이트 OFF'}${sigmaPx || shadowPx ? ` · σ${sigmaPx}/그림자${shadowPx}` : ''})`,
        `제안 ${run.proposals.length} · 게이트통과 ${run.gated.length} · 배타성후 ${run.kept.length} · 회수 ${s.faces}/${t.vis.length} · 재현율 ${s.recall} · 정밀도 ${s.precision}`,
        path,
      );
      console.log(`   스샷 ${t.key} → ${path}`);
    }
  }

}

if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) await main();
