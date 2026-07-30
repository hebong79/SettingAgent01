// ★ 21회차 Phase 0-b 신규 — **분리선 감사**. 정련된 분리선이 **참 주차면 경계**를 얼마나 맞히는가.
//
// ══════════════════════════════════════════════════════════════════════════
// 왜 이 도구인가(설계서 §9-1): A안(면별 독립 닫힘)은 면의 위치를 **두 분리선**이 정한다.
//   따라서 「참 경계 중 몇 %가 ±허용치 안에 정련 분리선을 갖는가」가 A안 재현율의 **원리적 상한**이다.
//   `floorPaint.ts:757-761` 의 "2.6~31px" 는 `scanSeparators` **씨앗** 값이며 `refineSeparators`
//   **정련 후** 값이 아니다 — 그 값을 A안 근거로 쓸 수 없다. 이 도구가 정련 후를 잰다.
//
// ★ 측정 방식(모델 f 오차에 오염되지 않게):
//   분리선과 참 경계를 **같은 전방선 위의 교점**으로 만들어 비교한다.
//     · 분리선 a = widthCoordOf(fr, model, meetLines(sep.line, front.line))   ← A안이 실제로 쓸 값 그대로
//     · 참 경계 a = widthCoordOf(fr, model, meetLines(참 면의 측변선, front.line))
//   두 점 모두 **픽셀 공간에서** 정해지므로 픽셀 오차는 모델과 무관하고, m 환산만 모델 스케일
//   (지상고 4.950m, F6)을 탄다(0.25m 허용치에 대해 1% = 2.5mm — 무해). px·m 양쪽을 다 낸다.
//
// ★ 채점 도구이므로 씬 정답(`sceneTruth`) 참조를 허용한다. 검출 모듈 봉인 규약은 그대로다
//   (이 파일은 `src/tools/**` 이며 `roi.auto` 서비스 경로에 없다).
// ★ 검출 알고리즘 0줄 변경 — `detectPaintLines`/`scanSeparators`/`refineSeparators`/`rowFrameFromLine`/
//   `widthCoordOf`/`lineThrough`/`meetLines` 를 **그대로** 호출한다(재구현 0줄 = U11 방지).
// ★ 문턱을 스스로 정하지 않는다. `AUDIT_TOL_M`(=0.25m)은 **분포를 보여주기 위한 격자**이며
//   "A안 진행/B안 전환" 판정 문턱은 리더가 분포를 보고 정한다(리더 판정 3번).
// ══════════════════════════════════════════════════════════════════════════
//
// 정본·DB 무접촉(읽기만). Unity 는 프레임 캐시가 없을 때만, 그때도 읽기/표시 메서드만
// (`cam.getPTZ`·`roi.show2d{visible:false}`·`cam.captureJPG`).
//
// 사용: npx tsx src/tools/sepAudit.ts [target] [outDir]
//   target  v1(기본) | v2 | 캐시 디렉터리 | A(임의 뷰 프레임 캐시 reports/overlay_r20/frames/A_cam1.jpg)

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import {
  DEFAULT_PAINT_OPTIONS,
  detectPaintLines,
  lineThrough,
  meetLines,
  refineSeparators,
  scanSeparators,
  type FrameGray,
  type RefinedLine,
} from '../ground/floorPaint.js';
import { rowFrameFromLine, widthCoordOf, type RowFrame } from '../ground/bayGrid.js';
import { DEFAULT_BAY_OPTS, quadPaintSupport, type BayDetectOpts } from '../ground/bayGeometry.js';
import { paintEvidenceOf, type PaintEvidence } from '../ground/floorPaint.js';
import { projectToPixel } from '../ground/project.js';
import { canonicalizeQuad } from '../ground/groundGrid.js';
import { groundModelFromIntrinsics, type PresetIntrinsics } from '../ground/cameraIntrinsics.js';
import { baseFocalPxOf, placeMetaProvider, readPlaceMeta } from '../ground/placeMetaIntrinsics.js';
import { facesOfRow, projectTruth, visibleTruth, type ScenePresetSpec, type TruthFace } from '../ground/sceneTruth.js';
import type { GroundModel, PixelQuad } from '../ground/types.js';

/** 참 경계 적중으로 인정하는 폭좌표 오차 상한(m). **판정 문턱이 아니라 분포 표시용 격자**다. */
export const AUDIT_TOL_M = 0.25;
/** 인접 면이 공유하는 경계를 같은 경계로 접는 허용치(m). 참 피치 2.5m 이므로 오접합이 불가능하다. */
export const AUDIT_DEDUP_M = 0.05;

// ── 순수 로직(유닛테스트 대상) ────────────────────────────────────────────────

/** 폭좌표 묶음 1건 — 같은 물리 경계로 접힌 원 인덱스들. */
export interface DedupGroup {
  /** 묶음 대표 폭좌표(m) = 구성원 평균. */
  aM: number;
  /** 입력 배열에서의 원 인덱스(오름차순). */
  members: number[];
}

/** 정렬 후 인접 값을 `tolM` 안에서 접는다. 결정론(값 오름차순 → 인덱스 오름차순). */
export function dedupeCoords(values: readonly number[], tolM: number): DedupGroup[] {
  const order = values
    .map((v, i) => i)
    .filter((i) => Number.isFinite(values[i]))
    .sort((a, b) => values[a] - values[b] || a - b);
  const out: DedupGroup[] = [];
  for (const i of order) {
    const cur = out[out.length - 1];
    if (cur && Math.abs(values[i] - cur.aM) <= tolM) {
      cur.members.push(i);
      cur.aM = cur.members.reduce((s, m) => s + values[m], 0) / cur.members.length;
    } else {
      out.push({ aM: values[i], members: [i] });
    }
  }
  return out;
}

/** 폭좌표 `aM` 에 가장 가까운 분리선. 부호 있는 오차(분리선 − 참 경계)를 낸다. 후보 0개 → null. */
export function nearestSep(aM: number, sepAM: readonly number[]): { sepIdx: number; errM: number } | null {
  let bi = -1;
  let bd = Infinity;
  for (let i = 0; i < sepAM.length; i++) {
    if (!Number.isFinite(sepAM[i])) continue;
    const d = Math.abs(sepAM[i] - aM);
    if (d < bd) {
      bd = d;
      bi = i;
    }
  }
  return bi < 0 ? null : { sepIdx: bi, errM: sepAM[bi] - aM };
}

/** 어떤 참 경계에도 `tolM` 안에 붙지 않은 분리선의 인덱스(= 오검출 분리선). */
export function falseSepIndices(sepAM: readonly number[], truthAM: readonly number[], tolM: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < sepAM.length; i++) {
    if (!Number.isFinite(sepAM[i])) continue;
    if (!truthAM.some((t) => Math.abs(sepAM[i] - t) <= tolM)) out.push(i);
  }
  return out;
}

/**
 * ★ **우연 적중률**(귀무 기준선) — 분리선이 촘촘하면 적중률은 정확도가 아니라 **밀도**를 재게 된다.
 *
 * `[loM, hiM]` 구간에서 임의의 한 점이 어떤 분리선의 ±`tolM` 안에 들어갈 확률
 * (= ±tol 구간들의 합집합 측도 / 구간 길이). 이 값이 1 에 가까우면 같은 tol 의 적중률은
 * **정보가 없다**. 적중률 숫자를 이것과 반드시 함께 읽어야 한다.
 */
export function chanceHitRate(sepAM: readonly number[], loM: number, hiM: number, tolM: number): number {
  if (!(hiM > loM)) return NaN;
  const iv = sepAM
    .filter((s) => Number.isFinite(s))
    .map((s) => [Math.max(loM, s - tolM), Math.min(hiM, s + tolM)] as const)
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let covered = 0;
  let curA = NaN;
  let curB = NaN;
  for (const [a, b] of iv) {
    if (Number.isNaN(curA)) {
      curA = a;
      curB = b;
      continue;
    }
    if (a <= curB) curB = Math.max(curB, b);
    else {
      covered += curB - curA;
      curA = a;
      curB = b;
    }
  }
  if (!Number.isNaN(curA)) covered += curB - curA;
  return covered / (hiM - loM);
}

/**
 * ★ 게이트① 통과 쌍 열거 — **A안이 이 행에서 만들 면 후보의 수**를 센다(오검출 비용의 직접 지표).
 *
 * 설계서 §3-1 그대로: 모든 쌍 (i<j) 에서 `|Δ − w| ≤ w·wtol` 이면 면 1개 후보이고 그 왼쪽 경계는
 * `aLo = (a_i + (a_j − w))/2` 다. **quad 를 만들지 않는다**(Phase 1 의 일이다) — 폭좌표만 센다.
 */
export function gate1Pairs(sepAM: readonly number[], slotWidthM: number, wtol: number): Array<{ i: number; j: number; aLoM: number }> {
  const out: Array<{ i: number; j: number; aLoM: number }> = [];
  for (let i = 0; i < sepAM.length; i++) {
    if (!Number.isFinite(sepAM[i])) continue;
    for (let j = i + 1; j < sepAM.length; j++) {
      if (!Number.isFinite(sepAM[j])) continue;
      const lo = Math.min(sepAM[i], sepAM[j]);
      const hi = Math.max(sepAM[i], sepAM[j]);
      if (Math.abs(hi - lo - slotWidthM) <= slotWidthM * wtol) out.push({ i, j, aLoM: (lo + (hi - slotWidthM)) / 2 });
    }
  }
  return out;
}

/**
 * 폭좌표 목록을 `minSepM` 이상 떨어진 묶음으로 세운 개수(그리디 · 오름차순).
 *
 * ★ 왜 이 값인가: 폭 `w` 인 두 면이 `δ` 만큼 어긋나면 `IoU = (w−δ)/(w+δ)` 다. 배타성 문턱
 * `rowMergeIoU = r` 을 대입하면 **`δ = w(1−r)/(1+r)` 보다 더 어긋난 두 면은 서로를 접지 못한다**
 * (2.5m·0.5 → 0.8333m). 즉 이 개수는 배타성 해소 뒤에도 남는 면 후보 수의 **하한**이다.
 * quad·IoU 를 새로 구현하지 않고(R4) 같은 문턱을 1차원에서 해석적으로 환산한 것이다.
 */
export function clusterCount(aLoM: readonly number[], minSepM: number): number {
  const s = [...aLoM].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return 0;
  let n = 1;
  let last = s[0];
  for (const v of s) {
    if (v - last > minSepM) {
      n++;
      last = v;
    }
  }
  return n;
}

/**
 * 감사용 면 quad 조립 — 설계서 §3-1 5) 의 식을 **측정을 위해** 따라 쓴다.
 *
 * ★ 고지: 이것은 `bayGrid.buildAtPhase` 의 quad 조립을 도구 안에서 다시 쓴 것이다(U11 재구현 위험).
 *   Phase 1 의 정본이 아니며 **게이트② 통과율을 재기 위한 계측용**이다. 좌표식은 설계서 그대로:
 *   `(aLo,0) (aLo,depth) (aLo+w,depth) (aLo+w,0)`. 투영·캐노니컬화는 기존 함수를 그대로 쓴다.
 */
export function auditQuadAt(
  fr: RowFrame,
  model: GroundModel,
  aLoM: number,
  wM: number,
  depthM: number,
  flipV: boolean,
): PixelQuad | null {
  const s = flipV ? -1 : 1;
  const at = (a: number, b: number) =>
    projectToPixel(
      [
        fr.origin[0] + fr.u[0] * a + s * fr.v[0] * b,
        fr.origin[1] + fr.u[1] * a + s * fr.v[1] * b,
        fr.origin[2] + fr.u[2] * a + s * fr.v[2] * b,
      ],
      model,
    );
  const n0 = at(aLoM, 0);
  const f0 = at(aLoM, depthM);
  const f1 = at(aLoM + wM, depthM);
  const n1 = at(aLoM + wM, 0);
  if (!n0 || !f0 || !f1 || !n1) return null;
  return canonicalizeQuad([n0, f0, f1, n1]);
}

/**
 * 분포 요약. p90 은 **nearest-rank**(`sorted[ceil(0.9·n)−1]`) — 보간하지 않는다
 * (표본이 수십 개 규모라 보간값은 있지도 않은 정밀도를 시사한다).
 */
export function quantiles(xs: readonly number[]): { median: number; p90: number; max: number; n: number } | null {
  const s = [...xs].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const median = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return { median, p90: s[Math.ceil(0.9 * s.length) - 1], max: s[s.length - 1], n: s.length };
}

/** 한 행의 감사 프레임(전방선 후보) 선택 — 적중 수 desc → 적중 오차합 asc → 인덱스 asc. 난수 0. */
export function pickAuditFrame(stats: ReadonlyArray<{ hits: number; sumAbsErrM: number }>): number {
  let bi = -1;
  for (let i = 0; i < stats.length; i++) {
    const s = stats[i];
    const b = bi < 0 ? null : stats[bi];
    if (!b || s.hits > b.hits || (s.hits === b.hits && s.sumAbsErrM < b.sumAbsErrM - 1e-12)) bi = i;
  }
  return bi;
}

/** 참 경계 1건의 감사 결과. */
export interface BoundaryAudit {
  /** 행 좌표계 폭좌표(m). */
  aM: number;
  /** 이 경계를 공유하는 면(1-based)과 그 면에서의 쪽. */
  faceRefs: Array<{ faceIdx: number; side: 'lo' | 'hi' }>;
  /** 전방선과의 교점(px) — 오버레이·px 오차의 기준점. */
  px: { x: number; y: number };
  /** 참 경계 선분(면의 측변) — 오버레이 작도용. */
  seg: [{ x: number; y: number }, { x: number; y: number }];
  sepIdx: number | null;
  /** 부호 있는 오차(분리선 − 참 경계, m). 분리선 0개 → null. */
  errM: number | null;
  /** 같은 두 점의 픽셀 거리. */
  errPx: number | null;
  hit: boolean;
}

/** 면 1건의 닫힘 가능성. */
export interface FaceAudit {
  faceIdx: number;
  /** 좌·우 경계의 `boundaries` 인덱스. −1 이면 측정 불가(전방선과 평행 등). */
  loB: number;
  hiB: number;
  /** 두 경계가 **같은 전방선 프레임에서** 모두 적중 = 위치 증거가 갖춰졌다. */
  closable: boolean;
  /** 좌·우 경계의 부호 있는 오차(m). */
  loErrM: number | null;
  hiErrM: number | null;
  /**
   * 참 경계 두 개의 이 프레임에서의 간격(m).
   *
   * ★ 전방선의 u 축이 그 행의 폭축과 어긋나면(다른 행의 전방선·사선) 이 값이 규격 폭(2.5m,
   * 관측계에서는 F6 스케일로 ≈2.525m)에서 크게 벗어난다. 그런 프레임에서는 **A안 게이트①이
   * 그 쌍을 기각**하므로, 경계를 둘 다 맞혔어도 면은 닫히지 않는다.
   */
  truthSpanM: number | null;
  /** 두 경계에 각각 가장 가까운 분리선의 간격(m) — A안 게이트①이 실제로 보는 값. */
  sepSpanM: number | null;
}

export interface RowFrameAudit {
  fr: RowFrame;
  /** `sepPx` 와 같은 순서·같은 길이. 역투영 실패는 NaN. */
  sepAM: number[];
  boundaries: BoundaryAudit[];
  faces: FaceAudit[];
  /** 측정 불가 면(측변선이 전방선과 평행하거나 교점이 프레임에서 지나치게 멀다). */
  unmeasured: number[];
  hits: number;
  sumAbsErrM: number;
}

/**
 * 한 전방선 후보 프레임에서 참 경계 vs 분리선을 잰다.
 *
 * 교점이 프레임에서 멀면 버린다(전방선과 측변선이 거의 평행한 퇴화). 기준은 프레임 1장 여유 —
 * 참 면의 중심은 정의상 프레임 안(`visibleTruth`)이므로 그 측변의 교점이 이 범위를 벗어나면 퇴화다.
 */
export function auditRowFrame(
  model: GroundModel,
  frontLine: readonly [number, number, number],
  faces: ReadonlyArray<{ faceIdx: number; quad: PixelQuad }>,
  sepPx: ReadonlyArray<{ x: number; y: number }>,
  tolM: number,
  dedupM: number,
): RowFrameAudit | null {
  const fr = rowFrameFromLine(model, frontLine);
  if (!fr) return null;
  const sepAM = sepPx.map((p) => {
    const a = widthCoordOf(fr, model, p);
    return a == null || !Number.isFinite(a) ? NaN : a;
  });

  const raw: Array<{ aM: number; px: { x: number; y: number }; seg: BoundaryAudit['seg']; faceIdx: number; side: 'lo' | 'hi' }> = [];
  const unmeasured: number[] = [];
  const inRange = (p: { x: number; y: number }): boolean =>
    p.x >= -model.imgW && p.x <= 2 * model.imgW && p.y >= -model.imgH && p.y <= 2 * model.imgH;
  for (const f of faces) {
    // 측변 = (q0,q1) 과 (q3,q2). `canonicalizeQuad` 가 근변을 (p3→p0) 에 놓으므로 이 두 쌍이 좌우 변이다
    // (`roiAutoScore.ts:113-116` 과 같은 규약).
    const sides = ([[f.quad[0], f.quad[1]], [f.quad[3], f.quad[2]]] as const).map((pair) => {
      const l = lineThrough(pair[0], pair[1]);
      if (!l) return null;
      const pt = meetLines(l, frontLine);
      if (!pt || !inRange(pt)) return null;
      const a = widthCoordOf(fr, model, pt);
      if (a == null || !Number.isFinite(a)) return null;
      return { aM: a, px: pt, seg: [pair[0], pair[1]] as BoundaryAudit['seg'] };
    });
    if (!sides[0] || !sides[1]) {
      unmeasured.push(f.faceIdx);
      continue;
    }
    const [lo, hi] = sides[0].aM <= sides[1].aM ? [sides[0], sides[1]] : [sides[1], sides[0]];
    raw.push({ ...lo, faceIdx: f.faceIdx, side: 'lo' });
    raw.push({ ...hi, faceIdx: f.faceIdx, side: 'hi' });
  }

  const groups = dedupeCoords(raw.map((r) => r.aM), dedupM);
  const boundaries: BoundaryAudit[] = groups.map((g) => {
    const first = raw[g.members[0]];
    const near = nearestSep(g.aM, sepAM);
    const hit = near != null && Math.abs(near.errM) <= tolM;
    return {
      aM: g.aM,
      faceRefs: g.members.map((m) => ({ faceIdx: raw[m].faceIdx, side: raw[m].side })),
      px: first.px,
      seg: first.seg,
      sepIdx: near?.sepIdx ?? null,
      errM: near?.errM ?? null,
      errPx: near ? Math.hypot(sepPx[near.sepIdx].x - first.px.x, sepPx[near.sepIdx].y - first.px.y) : null,
      hit,
    };
  });

  const bOf = (faceIdx: number, side: 'lo' | 'hi'): number =>
    boundaries.findIndex((b) => b.faceRefs.some((r) => r.faceIdx === faceIdx && r.side === side));
  const facesOut: FaceAudit[] = faces
    .filter((f) => !unmeasured.includes(f.faceIdx))
    .map((f) => {
      const loB = bOf(f.faceIdx, 'lo');
      const hiB = bOf(f.faceIdx, 'hi');
      const ok = loB >= 0 && hiB >= 0;
      const lo = ok ? boundaries[loB] : null;
      const hi = ok ? boundaries[hiB] : null;
      const sepSpanM =
        lo?.sepIdx != null && hi?.sepIdx != null && Number.isFinite(sepAM[lo.sepIdx]) && Number.isFinite(sepAM[hi.sepIdx])
          ? sepAM[hi.sepIdx] - sepAM[lo.sepIdx]
          : null;
      return {
        faceIdx: f.faceIdx,
        loB,
        hiB,
        closable: !!(lo?.hit && hi?.hit),
        loErrM: lo?.errM ?? null,
        hiErrM: hi?.errM ?? null,
        truthSpanM: lo && hi ? hi.aM - lo.aM : null,
        sepSpanM,
      };
    });

  const hitB = boundaries.filter((b) => b.hit);
  return {
    fr,
    sepAM,
    boundaries,
    faces: facesOut,
    unmeasured,
    hits: hitB.length,
    sumAbsErrM: hitB.reduce((s, b) => s + Math.abs(b.errM ?? 0), 0),
  };
}

// ── 실행부(도구) ─────────────────────────────────────────────────────────────

const PLANE_Y_M = 0.05;
const MIN_AREA_PX = 200;
const DEG = Math.PI / 180;
const VIEW_CACHE_DIR = 'reports/overlay_r20/frames';
const GOLDEN_DIRS: Record<string, string> = {
  v1: 'test/fixtures/roiAutoGolden',
  v2: 'test/fixtures/roiAutoGolden_v2',
};

interface Target {
  key: string;
  jpg: Buffer;
  frameHash: string;
  W: number;
  H: number;
  frame: FrameGray;
  model: GroundModel;
  vis: Array<{ face: TruthFace; quad: PixelQuad }>;
  note: string;
}

/** 전방선 후보 + 그 위 분리선. `pts` 와 `seps` 는 **같은 순서·같은 길이**(meetLines 성공 시에만 동시 push). */
interface FrontCand {
  front: RefinedLine;
  seps: RefinedLine[];
  pts: Array<{ x: number; y: number }>;
}

function frontCandidatesOf(frame: FrameGray): { cands: FrontCand[]; mask: Uint8Array } {
  const { lines, mask } = detectPaintLines(frame, DEFAULT_PAINT_OPTIONS);
  const out: FrontCand[] = [];
  for (const front of lines.slice(0, DEFAULT_PAINT_OPTIONS.frontCandidates)) {
    const pk = scanSeparators(frame, mask, front, DEFAULT_PAINT_OPTIONS);
    const refined = pk.length ? refineSeparators(frame, pk, DEFAULT_PAINT_OPTIONS) : [];
    const seps: RefinedLine[] = [];
    const pts: Array<{ x: number; y: number }> = [];
    for (const sp of refined) {
      const q = meetLines(sp.line, front.line);
      if (q) {
        seps.push(sp);
        pts.push(q);
      }
    }
    out.push({ front, seps, pts });
  }
  return { cands: out, mask };
}

async function grayOf(jpg: Buffer): Promise<{ W: number; H: number; frame: FrameGray }> {
  const meta = await sharp(jpg).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const gb = await sharp(jpg).greyscale().raw().toBuffer();
  return { W, H, frame: { data: new Uint8Array(gb.buffer, gb.byteOffset, gb.byteLength), width: W, height: H } };
}

function sceneFaces(): TruthFace[] {
  const specs = JSON.parse(readFileSync('_workspace/18_scene_spec.json', 'utf8')) as ScenePresetSpec[];
  return specs.flatMap((s) => facesOfRow(s, PLANE_Y_M) ?? []);
}

async function goldenTargets(cacheDir: string): Promise<Target[]> {
  const placeJson = JSON.parse(readFileSync('data/Place01/PtzCamRoi.json', 'utf8'));
  const intrinsics = placeMetaProvider(readPlaceMeta(placeJson));
  const faces = sceneFaces();
  const out: Target[] = [];
  for (const c of placeJson.cameras) {
    for (const p of c.presets) {
      const jpgPath = join(cacheDir, `frame_${c.camera.cam_id}_${p.preset_idx}_d0.jpg`);
      const baseIntr = intrinsics.get(c.camera.cam_id, p.preset_idx);
      if (!existsSync(jpgPath) || !baseIntr) continue;
      const jpg = readFileSync(jpgPath);
      const { W, H, frame } = await grayOf(jpg);
      const model = groundModelFromIntrinsics(baseIntr, p.zoom);
      if (!model) continue;
      const vis = visibleTruth(
        projectTruth(faces, {
          camPos: c.camera.position,
          panDeg: p.pan,
          tiltDeg: p.tilt,
          fovDeg: p.fov,
          fovAxis: 'vertical',
          imgW: W,
          imgH: H,
          planeYM: PLANE_Y_M,
        }),
        W,
        H,
        MIN_AREA_PX,
      );
      out.push({
        key: `${c.camera.cam_id}:${p.preset_idx}`,
        jpg,
        frameHash: createHash('sha256').update(jpg).digest('hex').slice(0, 12),
        W,
        H,
        frame,
        model,
        vis,
        note: `pan ${p.pan} tilt ${p.tilt} zoom ${p.zoom} f ${model.f.toFixed(4)}px`,
      });
    }
  }
  return out;
}

/** 임의 뷰 — 프레임 캐시 우선(있으면 카메라를 아예 건드리지 않는다). 제원 규칙은 `roiAutoPhaseTable` 과 동일. */
async function viewTarget(tag: string, camId: number): Promise<Target | null> {
  mkdirSync(VIEW_CACHE_DIR, { recursive: true });
  const jpgPath = join(VIEW_CACHE_DIR, `${tag}_cam${camId}.jpg`);
  const ptzPath = join(VIEW_CACHE_DIR, `${tag}_cam${camId}.ptz.json`);
  let jpg: Buffer;
  let ptz: { pan: number; tilt: number; zoom: number };
  if (existsSync(jpgPath) && existsSync(ptzPath)) {
    jpg = readFileSync(jpgPath);
    ptz = JSON.parse(readFileSync(ptzPath, 'utf8'));
    console.log(`프레임 캐시 사용: ${jpgPath} (카메라 미접촉)`);
  } else {
    let rpcId = 0;
    const unity = async (method: string, params: Record<string, unknown> = {}): Promise<any> => {
      const r = await fetch('http://localhost:13110/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Connection: 'close' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      });
      const j = (await r.json()) as any;
      if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
      return j.result;
    };
    ptz = (await unity('cam.getPTZ', { camId })) as typeof ptz;
    await unity('roi.show2d', { visible: false }); // F2 — 합성 초록 박스 제거.
    const cap = (await unity('cam.captureJPG', { camId })) as { img_bytes?: string };
    jpg = Buffer.from(cap.img_bytes ?? '', 'base64');
    writeFileSync(jpgPath, jpg);
    writeFileSync(ptzPath, JSON.stringify(ptz));
    console.log(`프레임 신규 캡처 → ${jpgPath} (무이동: getPTZ/captureJPG 읽기만)`);
  }
  const { W, H, frame } = await grayOf(jpg);
  const placeJson = JSON.parse(readFileSync('data/Place01/PtzCamRoi.json', 'utf8'));
  const meta = readPlaceMeta(placeJson);
  const camMeta = meta.cameras.find((c) => c.camera.camIdx === camId)?.camera;
  const base = baseFocalPxOf(meta, camId);
  if (!camMeta || !base) return null;
  const intr: PresetIntrinsics = {
    camIdx: camId,
    presetIdx: 1,
    fovDeg: (2 * Math.atan(W / 2 / base.fBasePx)) / DEG,
    fovAxis: 'horizontal',
    fovAtZoom: 'zoom1',
    tiltDeg: ptz.tilt,
    heightM: camMeta.heightM,
    imgW: W,
    imgH: H,
    source: 'sep-audit',
  };
  const model = groundModelFromIntrinsics(intr, ptz.zoom);
  if (!model) return null;
  const camPosRaw = (placeJson.cameras.find((c: any) => c.camera.cam_id === camId) as any).camera.position as number[];
  const vis = visibleTruth(
    projectTruth(sceneFaces(), {
      camPos: [camPosRaw[0], camPosRaw[1], camPosRaw[2]],
      panDeg: ptz.pan,
      tiltDeg: ptz.tilt,
      fovDeg: (2 * Math.atan(W / 2 / model.f)) / DEG,
      fovAxis: 'horizontal',
      imgW: W,
      imgH: H,
      planeYM: PLANE_Y_M,
    }),
    W,
    H,
    MIN_AREA_PX,
  );
  return {
    key: `${tag}_cam${camId}`,
    jpg,
    frameHash: createHash('sha256').update(jpg).digest('hex').slice(0, 12),
    W,
    H,
    frame,
    model,
    vis,
    note: `pan ${ptz.pan} tilt ${ptz.tilt} zoom ${ptz.zoom} f ${model.f.toFixed(4)}px`,
  };
}

/** 한 행의 감사 결과(감사 프레임 확정 후). */
interface RowResult {
  rowIdx: number;
  candIdx: number;
  audit: RowFrameAudit;
  cand: FrontCand;
  faceCount: number;
  falseVsRow: number[];
  falseVsAll: number[];
  /** 전 전방선 후보 중 **어느 하나에서라도** 닫힐 수 있었던 면 수(관대한 상한). */
  closableAny: number;
  /** 감사 프레임의 우연 적중률(귀무 기준선) — 참 경계 스팬 구간에서. */
  chance: number;
  /** 감사 프레임의 분리선 평균 간격(m) — 밀도. */
  sepPitchM: number;
  /** 게이트① 통과 쌍 수와 배타성 후 남는 위치 수(면 후보 규모 = 오검출 비용). */
  gate1: Array<{ wtol: number; pairs: number; positions: number; gate2Pairs: number; gate2Positions: number }>;
}

/** 면 1건을 전 전방선 후보에서 본 결과(게이트 조합 스윕용). */
interface FaceOption {
  key: string;
  rowIdx: number;
  faceIdx: number;
  /** 근변 도색 지지(게이트②) — 참 quad 에 `quadPaintSupport` 적용. `roiAutoRecall` 의 `detectable` 과 같은 식. */
  detectable: boolean;
  /** 프레임별 {위치오차 max(|좌|,|우|), 게이트① 편차 |Δsep − 규격폭|}. 측정 가능한 프레임만. */
  opts: Array<{ closeErrM: number; widthDevM: number; candIdx: number }>;
}

const seg = (a: { x: number; y: number }, b: { x: number; y: number }, stroke: string, width: number, dash = '') =>
  `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${stroke}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
const poly = (q: PixelQuad, stroke: string, width: number, dash = '') =>
  `<polygon points="${q.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="none" stroke="${stroke}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
const label = (x: number, y: number, t: string, fill: string, size = 18) =>
  `<text x="${x.toFixed(0)}" y="${y.toFixed(0)}" fill="${fill}" font-size="${size}" font-weight="bold" stroke="#000" stroke-width="0.6" paint-order="stroke">${t}</text>`;

async function drawOverlay(t: Target, rows: RowResult[], outDir: string): Promise<string[]> {
  const parts: string[] = [];
  // 참 면 윤곽(옅은 초록) — 맥락.
  for (const v of t.vis) {
    parts.push(poly(v.quad, '#00e67655', 2));
    const cx = (v.quad[0].x + v.quad[1].x + v.quad[2].x + v.quad[3].x) / 4;
    const cy = (v.quad[0].y + v.quad[1].y + v.quad[2].y + v.quad[3].y) / 4;
    parts.push(label(cx - 22, cy, `r${v.face.rowIdx}f${v.face.faceIdx}`, '#00e676', 17));
  }
  // ★ 작도 순서가 판독성을 정한다: 오검출(가늘게·라벨 없음) → 전방선 → 적중 분리선(굵게) → 참 경계 → 라벨.
  //   오검출 분리선이 수십 개라 전부 라벨을 붙이면 화면이 글자로 덮인다(1차 시도에서 실제로 그랬다).
  for (const r of rows) {
    const falseSet = new Set(r.falseVsRow);
    const hitSep = new Set(r.audit.boundaries.filter((b) => b.hit && b.sepIdx != null).map((b) => b.sepIdx as number));
    r.cand.seps.forEach((s, i) => {
      if (hitSep.has(i)) return;
      parts.push(seg(s.endA, s.endB, falseSet.has(i) ? '#ff174499' : '#ff8a8066', 2));
    });
  }
  for (const r of rows) {
    const sp = [r.audit.boundaries[0]?.px, r.audit.boundaries[r.audit.boundaries.length - 1]?.px].filter(Boolean) as Array<{ x: number; y: number }>;
    if (sp.length === 2) parts.push(seg(sp[0], sp[1], '#ffffffaa', 1.5, '4,6'));
    const hitSep = [...new Set(r.audit.boundaries.filter((b) => b.hit && b.sepIdx != null).map((b) => b.sepIdx as number))];
    for (const i of hitSep) parts.push(seg(r.cand.seps[i].endA, r.cand.seps[i].endB, '#ffea00', 5));
    // 참 경계 — 적중 초록 실선 / 누락 자홍 굵은 점선.
    for (const b of r.audit.boundaries) {
      parts.push(seg(b.seg[0], b.seg[1], b.hit ? '#00e676' : '#e040fb', b.hit ? 2.5 : 5, b.hit ? '' : '9,7'));
      parts.push(`<circle cx="${b.px.x.toFixed(1)}" cy="${b.px.y.toFixed(1)}" r="5" fill="${b.hit ? '#00e676' : '#e040fb'}" stroke="#000" stroke-width="1"/>`);
    }
    // 라벨은 참 경계에만(폭좌표 a + 오차). 오검출 분리선에는 붙이지 않는다.
    for (const b of r.audit.boundaries) {
      parts.push(
        label(
          b.px.x + 6,
          b.px.y - 10,
          `a${b.aM.toFixed(2)} ${b.hit ? `Δ${((b.errM ?? 0) * 100).toFixed(1)}cm` : `누락(최근접 ${((b.errM ?? 0) * 100).toFixed(0)}cm)`}`,
          b.hit ? '#00e676' : '#e040fb',
          b.hit ? 17 : 20,
        ),
      );
    }
  }
  const hits = rows.reduce((s, r) => s + r.audit.hits, 0);
  const tot = rows.reduce((s, r) => s + r.audit.boundaries.length, 0);
  const closable = rows.reduce((s, r) => s + r.audit.faces.filter((f) => f.closable).length, 0);
  parts.push(`<rect x="14" y="14" width="1210" height="176" fill="#000000cc" rx="8"/>`);
  parts.push(label(30, 50, `분리선 감사 ${t.key} · 프레임 ${t.frameHash} · ${t.note}`, '#fff', 25));
  const falseN = rows.reduce((s, r) => s + r.falseVsRow.length, 0);
  parts.push(
    label(
      30,
      84,
      `참 경계 적중 ${hits}/${tot} · 면 닫힘가능 ${closable}/${t.vis.length} · 오검출 분리선 ${falseN}개(라벨 생략) · 허용 ±${AUDIT_TOL_M}m`,
      '#ddd',
      21,
    ),
  );
  parts.push(
    `<text x="30" y="120" font-size="19" font-weight="bold"><tspan fill="#00e676">━ 참 경계(적중)</tspan>  <tspan fill="#ffea00">━ 정련 분리선(적중)</tspan>  <tspan fill="#ff1744">━ 오검출 분리선</tspan>  <tspan fill="#e040fb">┄ 누락된 참 경계</tspan>  <tspan fill="#ffffff99">┄ 전방선</tspan></text>`,
  );
  parts.push(label(30, 152, `행별 감사 프레임: ${rows.map((r) => `r${r.rowIdx}=전방선#${r.candIdx}(분리선 ${r.cand.seps.length})`).join(' · ')}`, '#aaa', 18));
  parts.push(label(30, 180, `검출 알고리즘 0줄 변경 · 씬 정답은 채점 전용 · 정본·DB 무접촉`, '#888', 16));

  const svg = `<svg width="${t.W}" height="${t.H}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
  const outs: string[] = [];
  // ★ `composite` 뒤에 `extract` 를 이어 붙이면 sharp 가 extract 를 **먼저** 적용해 합성이 터진다.
  //   합성 결과를 버퍼로 확정한 뒤 크롭한다.
  const composed = await sharp(t.jpg).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer();
  const full = join(outDir, `sep_${t.key.replace(':', '_')}.png`);
  writeFileSync(full, composed);
  outs.push(full);
  // 크롭 — 참 면 전체를 감싸는 상자에 여유 80px. 판독성용.
  const xs = t.vis.flatMap((v) => v.quad.map((p) => p.x));
  const ys = t.vis.flatMap((v) => v.quad.map((p) => p.y));
  if (xs.length) {
    const left = Math.max(0, Math.floor(Math.min(...xs) - 80));
    const top = Math.max(0, Math.floor(Math.min(...ys) - 80));
    const width = Math.min(t.W - left, Math.ceil(Math.max(...xs) - left + 80));
    const height = Math.min(t.H - top, Math.ceil(Math.max(...ys) - top + 80));
    if (width > 20 && height > 20) {
      const crop = join(outDir, `sep_${t.key.replace(':', '_')}_crop.png`);
      await sharp(composed).extract({ left, top, width, height }).png().toFile(crop);
      outs.push(crop);
    }
  }
  return outs;
}

async function auditTarget(t: Target, outDir: string): Promise<{ rows: RowResult[]; faces: FaceOption[] }> {
  const { cands, mask } = frontCandidatesOf(t.frame);
  const ev = paintEvidenceOf(mask, t.W, t.H);
  const gateOpts: BayDetectOpts = { ...DEFAULT_BAY_OPTS, expectedBays: 1 };
  const rowIdxs = [...new Set(t.vis.map((v) => v.face.rowIdx))].sort((a, b) => a - b);
  // 프레임 전체의 참 경계(오검출 판정의 관대한 분모) — 각 전방선 후보 프레임에서 따로 잰다.
  const allAudits = cands.map((c) =>
    auditRowFrame(t.model, c.front.line, t.vis.map((v) => ({ faceIdx: v.face.rowIdx * 1000 + v.face.faceIdx, quad: v.quad })), c.pts, AUDIT_TOL_M, AUDIT_DEDUP_M),
  );
  const rows: RowResult[] = [];
  const faceOpts: FaceOption[] = [];
  for (const rowIdx of rowIdxs) {
    const faces = t.vis.filter((v) => v.face.rowIdx === rowIdx).map((v) => ({ faceIdx: v.face.faceIdx, quad: v.quad }));
    const audits = cands.map((c) => auditRowFrame(t.model, c.front.line, faces, c.pts, AUDIT_TOL_M, AUDIT_DEDUP_M));
    const stats = audits.map((a) => ({ hits: a?.hits ?? -1, sumAbsErrM: a?.sumAbsErrM ?? Infinity }));
    const ci = pickAuditFrame(stats);
    const audit = ci >= 0 ? audits[ci] : null;
    if (!audit || ci < 0) continue;
    const closableAny = faces.filter((f) => audits.some((a) => a?.faces.some((x) => x.faceIdx === f.faceIdx && x.closable))).length;
    const truthRowAM = audit.boundaries.map((b) => b.aM);
    const truthAllAM = allAudits[ci]?.boundaries.map((b) => b.aM) ?? truthRowAM;
    const lo = Math.min(...truthRowAM);
    const hi = Math.max(...truthRowAM);
    const finiteSep = audit.sepAM.filter((s) => Number.isFinite(s));
    rows.push({
      rowIdx,
      candIdx: ci,
      audit,
      cand: cands[ci],
      faceCount: faces.length,
      falseVsRow: falseSepIndices(audit.sepAM, truthRowAM, AUDIT_TOL_M),
      falseVsAll: falseSepIndices(audit.sepAM, truthAllAM, AUDIT_TOL_M),
      closableAny,
      chance: chanceHitRate(audit.sepAM, lo, hi, AUDIT_TOL_M),
      sepPitchM: finiteSep.length > 1 ? (Math.max(...finiteSep) - Math.min(...finiteSep)) / (finiteSep.length - 1) : NaN,
      gate1: [0.05, 0.1].map((wtol) => {
        const p = gate1Pairs(audit.sepAM, gateOpts.slotWidthM, wtol);
        const mergeDeltaM = (gateOpts.slotWidthM * (1 - gateOpts.rowMergeIoU)) / (1 + gateOpts.rowMergeIoU);
        // 게이트②(근변 도색 지지) 를 면 후보 하나하나에 적용한다. v 방향 2개는 설계서 §3-2 대로 **각각** 후보다.
        let g2 = 0;
        const g2Lo: Array<number[]> = [[], []];
        for (const pr of p) {
          for (const flip of [0, 1]) {
            const q = auditQuadAt(audit.fr, t.model, pr.aLoM, gateOpts.slotWidthM, gateOpts.slotDepthM, flip === 1);
            if (!q) continue;
            if (quadPaintSupport([{ latticeIndex: 0, quad: q }], ev, DEFAULT_PAINT_OPTIONS, gateOpts).near >= gateOpts.extendMinNearSupport) {
              g2++;
              g2Lo[flip].push(pr.aLoM);
            }
          }
        }
        return {
          wtol,
          pairs: p.length,
          positions: clusterCount(p.map((x) => x.aLoM), mergeDeltaM),
          gate2Pairs: g2,
          gate2Positions: g2Lo.reduce((s, arr) => s + clusterCount(arr, mergeDeltaM), 0),
        };
      }),
    });
    // 게이트 조합 스윕용 — 면 하나를 전 전방선 후보에서 본다.
    for (const f of faces) {
      const opts: FaceOption['opts'] = [];
      audits.forEach((a, i) => {
        const fa = a?.faces.find((x) => x.faceIdx === f.faceIdx);
        if (!fa || fa.loErrM == null || fa.hiErrM == null || fa.sepSpanM == null) return;
        opts.push({
          candIdx: i,
          closeErrM: Math.max(Math.abs(fa.loErrM), Math.abs(fa.hiErrM)),
          widthDevM: Math.abs(Math.abs(fa.sepSpanM) - gateOpts.slotWidthM),
        });
      });
      faceOpts.push({
        key: t.key,
        rowIdx,
        faceIdx: f.faceIdx,
        detectable: quadPaintSupport([{ latticeIndex: 0, quad: f.quad }], ev, DEFAULT_PAINT_OPTIONS, gateOpts).near >= gateOpts.extendMinNearSupport,
        opts,
      });
    }
  }

  // ── 출력
  console.log(
    `\n=== ${t.key}  프레임 ${t.frameHash}  ${t.note}\n` +
      `    씬가시 ${t.vis.length}면(행 ${rowIdxs.join(',')}) · 전방선 후보 ${cands.length} · 후보별 분리선 수 [${cands.map((c) => c.seps.length).join(',')}]` +
      ` · 분리선 2개 미만 후보 ${cands.filter((c) => c.seps.length < 2).length}/${cands.length}`,
  );
  for (const r of rows) {
    console.log(
      `  ── 행 r${r.rowIdx} (가시 ${r.faceCount}면) → 감사 프레임 전방선#${r.candIdx} (분리선 ${r.cand.seps.length}개)` +
        `${r.audit.unmeasured.length ? ` · 측정불가 면 ${r.audit.unmeasured.join(',')}` : ''}`,
    );
    console.log(`     경계  참a(m)        분리선a(m)     오차(m)        오차(px)   판정   공유면`);
    for (const b of r.audit.boundaries) {
      const sa = b.sepIdx == null ? NaN : r.audit.sepAM[b.sepIdx];
      console.log(
        `     ${String(r.audit.boundaries.indexOf(b)).padStart(3)}  ${b.aM.toFixed(6).padStart(12)}  ` +
          `${(Number.isFinite(sa) ? sa.toFixed(6) : '--').padStart(13)}  ${(b.errM == null ? '--' : b.errM.toFixed(6)).padStart(13)}  ` +
          `${(b.errPx == null ? '--' : b.errPx.toFixed(2)).padStart(8)}   ${b.hit ? '적중' : '누락'}   ` +
          `${b.faceRefs.map((f) => `f${f.faceIdx}${f.side === 'lo' ? '좌' : '우'}`).join(',')}`,
      );
    }
    const closable = r.audit.faces.filter((f) => f.closable).length;
    console.log(
      `     적중 ${r.audit.hits}/${r.audit.boundaries.length} · 누락 ${r.audit.boundaries.length - r.audit.hits} · ` +
        `오검출 분리선 ${r.falseVsRow.length}(행 기준) / ${r.falseVsAll.length}(프레임 전체 기준) · ` +
        `면 닫힘가능 ${closable}/${r.faceCount} (전 후보 최선 ${r.closableAny}/${r.faceCount})`,
    );
    console.log(
      `     ★ 귀무 기준선: 분리선 평균간격 ${r.sepPitchM.toFixed(3)}m · ±${AUDIT_TOL_M}m 우연 적중률 ${r.chance.toFixed(5)}` +
        `  ← 적중률을 이 값과 함께 읽어라(1 에 가까우면 적중률은 정확도가 아니라 밀도를 잰다)`,
    );
    const mergeDeltaM = (gateOpts.slotWidthM * (1 - gateOpts.rowMergeIoU)) / (1 + gateOpts.rowMergeIoU);
    console.log(
      `     ★ 면 후보 규모: ` +
        r.gate1
          .map(
            (g) =>
              `wtol±${(g.wtol * 100).toFixed(0)}% → 게이트① ${g.pairs}쌍 → 게이트② ${g.gate2Pairs}쌍(v방향2 포함) → ` +
              `배타성(δ>${mergeDeltaM.toFixed(3)}m) 후 위치 ${g.gate2Positions}개`,
          )
          .join(' · ') +
        `  (참 면 ${r.faceCount}개)`,
    );
    console.log(
      `     면별 O/X · 참경계간격(m) · 분리선간격(m) · |Δ−${gateOpts.slotWidthM}|: ` +
        r.audit.faces
          .map(
            (f) =>
              `f${f.faceIdx}=${f.closable ? 'O' : 'X'}(${f.truthSpanM?.toFixed(3) ?? '--'}/${f.sepSpanM?.toFixed(3) ?? '--'}/${
                f.sepSpanM == null ? '--' : Math.abs(Math.abs(f.sepSpanM) - gateOpts.slotWidthM).toFixed(3)
              })`,
          )
          .join(' '),
    );
  }
  const outs = await drawOverlay(t, rows, outDir);
  console.log(`     오버레이 → ${outs.join(' , ')}`);
  return { rows, faces: faceOpts };
}

async function main(): Promise<void> {
  const targetArg = process.argv[2] ?? 'v1';
  const outDir = process.argv[3] ?? 'reports/overlay_r21';
  mkdirSync(outDir, { recursive: true });

  console.log(
    `21회차 Phase 0-b — 분리선 감사(정련 후 참 경계 적중률·오차 분포)\n` +
      `★ 검출 알고리즘 0줄 변경. 정련은 refineSeparators 그대로. 씬 정답은 채점 전용.\n` +
      `★ 허용치 ±${AUDIT_TOL_M}m 는 **분포 표시용 격자**이며 A/B 전환 판정 문턱이 아니다(리더가 분포를 보고 정한다).\n` +
      `대상: ${targetArg} · 오버레이: ${outDir}`,
  );

  const targets: Target[] = targetArg === 'A' ? ([await viewTarget('A', 1)].filter(Boolean) as Target[]) : await goldenTargets(GOLDEN_DIRS[targetArg] ?? targetArg);
  const all: Array<{ key: string; frameHash: string; rows: RowResult[]; visCount: number }> = [];
  const faceOpts: FaceOption[] = [];
  for (const t of targets) {
    const r = await auditTarget(t, outDir);
    all.push({ key: t.key, frameHash: t.frameHash, rows: r.rows, visCount: t.vis.length });
    faceOpts.push(...r.faces);
  }

  // ── 전체 집계
  const errM: number[] = [];
  const errPx: number[] = [];
  const hitErrM: number[] = [];
  let bTot = 0;
  let bHit = 0;
  let fTot = 0;
  let fClosable = 0;
  let fClosableAny = 0;
  let falseRow = 0;
  let falseAll = 0;
  let rowCount = 0;
  const chances: number[] = [];
  const pitches: number[] = [];
  console.log(`\n=== 프레임별 요약 (프레임해시 병기 — F13) ===`);
  console.log(`  대상   프레임해시    참경계  적중  적중률    누락  오검출(행/전체)  닫힘가능/가시면   최선닫힘  우연적중률`);
  for (const a of all) {
    let b = 0;
    let h = 0;
    let fr = 0;
    let fa = 0;
    let cl = 0;
    let ca = 0;
    for (const r of a.rows) {
      b += r.audit.boundaries.length;
      h += r.audit.hits;
      fr += r.falseVsRow.length;
      fa += r.falseVsAll.length;
      cl += r.audit.faces.filter((f) => f.closable).length;
      ca += r.closableAny;
      rowCount++;
      if (Number.isFinite(r.chance)) chances.push(r.chance);
      if (Number.isFinite(r.sepPitchM)) pitches.push(r.sepPitchM);
      for (const bb of r.audit.boundaries) {
        if (bb.errM != null) errM.push(Math.abs(bb.errM));
        if (bb.errPx != null) errPx.push(bb.errPx);
        if (bb.hit && bb.errM != null) hitErrM.push(Math.abs(bb.errM));
      }
    }
    bTot += b;
    bHit += h;
    fTot += a.visCount;
    fClosable += cl;
    fClosableAny += ca;
    falseRow += fr;
    falseAll += fa;
    const rowChance = a.rows.map((r) => r.chance).filter((v) => Number.isFinite(v));
    console.log(
      `  ${a.key.padEnd(6)} ${a.frameHash}  ${String(b).padStart(6)} ${String(h).padStart(5)}  ${(b ? h / b : 0).toFixed(5)}  ` +
        `${String(b - h).padStart(5)}  ${String(fr).padStart(6)}/${String(fa).padEnd(6)}  ${String(cl).padStart(6)}/${String(a.visCount).padEnd(6)}  ${String(ca).padStart(6)}` +
        `   ${rowChance.length ? (rowChance.reduce((s, v) => s + v, 0) / rowChance.length).toFixed(5) : '--'}`,
    );
  }
  const qAll = quantiles(errM);
  const qHit = quantiles(hitErrM);
  const qPx = quantiles(errPx);
  const qCh = quantiles(chances);
  const qPitch = quantiles(pitches);
  console.log(
    `\n=== 전체 ===\n` +
      `  참 경계 적중률(±${AUDIT_TOL_M}m)   ${bTot ? bHit / bTot : 0}  (${bHit}/${bTot})\n` +
      `  누락 경계                  ${bTot - bHit}\n` +
      `  면 닫힘가능(감사 프레임)   ${fTot ? fClosable / fTot : 0}  (${fClosable}/${fTot})   ← 위치 증거만 본 상한\n` +
      `  면 닫힘가능(전 후보 최선)  ${fTot ? fClosableAny / fTot : 0}  (${fClosableAny}/${fTot})   ← 관대한 상한\n` +
      `  오검출 분리선  행기준 ${falseRow}건 · 프레임전체기준 ${falseAll}건 · 행 ${rowCount}개 → 행당 ${rowCount ? falseRow / rowCount : 0} / ${rowCount ? falseAll / rowCount : 0}\n` +
      `  오차 분포(전 경계, |m|)    median ${qAll?.median} · p90 ${qAll?.p90} · max ${qAll?.max} · n ${qAll?.n}\n` +
      `  오차 분포(적중만, |m|)     median ${qHit?.median} · p90 ${qHit?.p90} · max ${qHit?.max} · n ${qHit?.n}\n` +
      `  오차 분포(전 경계, px)     median ${qPx?.median} · p90 ${qPx?.p90} · max ${qPx?.max} · n ${qPx?.n}\n` +
      `  ★ 귀무 기준선 — 분리선 평균간격(m) median ${qPitch?.median} · min ${qPitch ? Math.min(...pitches) : '--'}\n` +
      `                  ±${AUDIT_TOL_M}m 우연 적중률 median ${qCh?.median} · min ${qCh ? Math.min(...chances) : '--'} · max ${qCh?.max}\n` +
      `                  → 우연 적중률이 1 에 가까우면 위 적중률은 **정확도가 아니라 분리선 밀도**를 잰 것이다.`,
  );

  // ── ★ 게이트 조합 스윕 — A안 재현율 상한이 두 문턱의 함수로 어떻게 변하는가.
  //    "어느 전방선 후보에서라도 ① 두 경계가 tol 안에 분리선을 갖고 ② 그 분리선 쌍 간격이 규격폭 ±wtol 이며
  //     ③ 근변 도색지지(게이트②)가 있는" 면 수. 문턱을 정하지 않고 **표로 낸다**(리더 판정 3번).
  const TOLS = [0.05, 0.1, 0.15, 0.2, 0.25];
  const WTOLS = [0.02, 0.05, 0.1, 0.2, 1e9];
  const nFace = faceOpts.length;
  const nDet = faceOpts.filter((f) => f.detectable).length;
  console.log(
    `\n=== ★ A안 재현율 상한 — 문턱 조합 스윕 (면 ${nFace}개 중, 게이트②(근변도색 ≥${DEFAULT_BAY_OPTS.extendMinNearSupport}) 통과 ${nDet}개) ===\n` +
      `  값 = (위치 tol ∧ 게이트① ∧ 게이트②) 를 만족하는 면 수 / ${nFace}   · 괄호는 게이트② 무시 시\n` +
      `  widthTol\\tol` +
      TOLS.map((t) => `   ±${t.toFixed(2)}m`).join(''),
  );
  for (const w of WTOLS) {
    const cells = TOLS.map((tol) => {
      const okBoth = faceOpts.filter((f) => f.opts.some((o) => o.closeErrM <= tol && o.widthDevM <= DEFAULT_BAY_OPTS.slotWidthM * w));
      const withGate2 = okBoth.filter((f) => f.detectable).length;
      return `  ${String(withGate2).padStart(3)}(${String(okBoth.length).padStart(2)})`;
    });
    console.log(`  ${(w >= 1e9 ? '무제한' : `±${(w * 100).toFixed(0)}%`).padEnd(11)}` + cells.join(''));
  }
  console.log(
    `  ※ 위 표의 분자는 **위치·간격·도색 세 조건만** 본 상한이다. 배타성 해소·근변선 배치 오차(U10)·\n` +
      `     보간 여부는 반영하지 않았다 — 실제 재현율은 이 값 이하다.`,
  );

  // ── ★ 면 후보 규모(정밀도 비용) 집계.
  const rowsAll = all.flatMap((a) => a.rows);
  const truthFaces = rowsAll.reduce((s, r) => s + r.faceCount, 0);
  console.log(`\n=== ★ 면 후보 규모 = 정밀도 비용 (감사 프레임 기준, 행 ${rowsAll.length}개 · 참 면 ${truthFaces}개) ===`);
  for (const w of [0.05, 0.1]) {
    const g = (k: 'pairs' | 'positions' | 'gate2Pairs' | 'gate2Positions') =>
      rowsAll.reduce((s, r) => s + (r.gate1.find((x) => x.wtol === w)?.[k] ?? 0), 0);
    const pos2 = g('gate2Positions');
    console.log(
      `  widthTol ±${(w * 100).toFixed(0)}%: 게이트① ${g('pairs')}쌍(행당 ${(g('pairs') / rowsAll.length).toFixed(1)}) → ` +
        `게이트② ${g('gate2Pairs')}쌍 → 배타성 후 위치 ${pos2}개(행당 ${(pos2 / rowsAll.length).toFixed(1)})\n` +
        `                 참 면 ${truthFaces}개 → **상한 정밀도 ≈ ${(truthFaces / Math.max(1, pos2)).toFixed(4)}** ` +
        `(게이트② 미적용 시 ${(truthFaces / Math.max(1, g('positions'))).toFixed(4)})`,
    );
  }
  console.log(
    `  ※ "상한 정밀도"는 배타성 후 남는 위치가 전부 산출된다고 볼 때의 값이며, 클러스터 수가 배타성 생존 수의\n` +
      `     **하한**이므로 실제 정밀도는 이보다 낮다. 서열 상위 채택은 배타성 안에서 하나를 고르는 것이므로\n` +
      `     위치 수를 더 줄이지 못한다(겹치지 않는 후보는 서로를 밀어내지 못한다).\n` +
      `  ※ quad 조립은 이 도구가 다시 쓴 것이다(auditQuadAt) — Phase 1 정본이 아니라 계측용.`,
  );
}

if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) await main();
