// ★ 24회차 신규 — **관측원을 이미지 유래로 교체**(설계 `_workspace/21_architect_plan_round24_observation_source.md`).
//
// ══════════════════════════════════════════════════════════════════════════
// 이 파일이 하는 일 — `ObservationSource.observe()` 구현체 2개를 **검출 응답 캐시**에서 만든다.
//   vpdSegSource  : VPD seg 마스크 → bottomContour(재사용) → 근변 2점 → 지면 역투영 → 원변 2점 → footprintPx
//   lpdPlateSource: LPD 판 quad → plateAxes/buildTrapezoid(재사용) → footprintPx
//
// ★★ 오라클 격리 ★★
//   이 파일의 입력은 **JPEG 바이트 + GroundModel + 검출 응답 JSON** 뿐이다.
//   차량 월드 좌표·면 라벨·가시성은 읽지 않는다(`t.vis` 미접촉 — 채점은 individualEngine 이 한다).
//
// ★★ 설계 §1-3 결정을 코드로 고정 ★★
//   `SlotAxes` 를 만들지 않는다. `fitContactLine`/`buildFootprint`/`buildFrameCuboids` 를 부르지 않는다.
//   (슬롯 폴리곤 유래 축 = 오라클 주입이므로.) 축은 `groundAxisOf`(비-오라클)가 하류에서 잇는다.
//
// ★ 카메라 물리 이동 0 — 골든 JPEG **파일**만 읽는다. `camera_req_img`/`requestImage` 호출 없음.
// ★ 캐시가 정본 — `reports/detcache_r24/{frameHash}_{seg|lpd}.json` 이 있으면 네트워크를 안 탄다(결정성).
//
// 사용:
//   npx tsx src/tools/imageObservation.ts --fetch v1 --cache reports/detcache_r24
//   npx tsx src/tools/imageObservation.ts --rawmask v1 --cache reports/detcache_r24 --out reports/overlay_r24a

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { bottomContour } from '../ground/contact.js';
import { backprojectToGround, projectToPixel } from '../ground/project.js';
import { buildTrapezoid, plateAxes, REGION_DEFAULTS } from '../domain/occupancyRegion.js';
import { loadToolsConfig } from '../config/toolsConfig.js';
import { VpdClient } from '../clients/VpdClient.js';
import { LpdClient } from '../clients/LpdClient.js';
import type { GroundModel, PixelQuad } from '../ground/types.js';
import type { Vec3 } from '../ground/contactTypes.js';
import type { NormalizedQuad } from '../domain/types.js';
import { CAR_BODY, type VehicleObservation } from './carAnchorUpper.js';
import { frontEdgeOf } from './contactOrient.js';
import { goldenTargets, GOLDEN_DIRS, type Target } from './sepAudit.js';
import type { ObservationSource } from './individualEngine.js';

// ── 캐시 스키마 ───────────────────────────────────────────────────────────────

export interface SegCache {
  frameHash: string;
  key: string;
  W: number;
  H: number;
  /** 정규화(0..1) 마스크 폴리곤 + 신뢰도. `VpdClient.segment` 산출 그대로. */
  /** rect 는 `VpdClient` 규약 그대로 정규화 {x,y,w,h}. */
  boxes: Array<{ vpdIdx: number; confidence: number; cls: string; rect: { x: number; y: number; w: number; h: number }; mask: Array<{ x: number; y: number }> }>;
  segDegraded: boolean;
  maskMismatch: number;
}

export interface LpdCache {
  frameHash: string;
  key: string;
  W: number;
  H: number;
  plates: Array<{ quad: Array<{ x: number; y: number }>; confidence: number; cls: string }>;
}

const cachePath = (dir: string, frameHash: string, kind: 'seg' | 'lpd') => join(dir, `${frameHash}_${kind}.json`);

export function readSegCache(dir: string, frameHash: string): SegCache | null {
  const p = cachePath(dir, frameHash, 'seg');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as SegCache) : null;
}
export function readLpdCache(dir: string, frameHash: string): LpdCache | null {
  const p = cachePath(dir, frameHash, 'lpd');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as LpdCache) : null;
}

// ── 벡터 소품(지역 · 3줄짜리 산술) ────────────────────────────────────────────

const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit3 = (a: Vec3): Vec3 | null => {
  const n = Math.hypot(a[0], a[1], a[2]);
  return n > 1e-9 ? [a[0] / n, a[1] / n, a[2] / n] : null;
};

// ── ★ 신규 기하는 아래 두 함수뿐이다(설계 §8 단계1: 밴드 선택 ≤20줄) ─────────

/**
 * 접지 콘투어(열별 최하단 점) → **근변 2점**.
 * 좌/우 사분위 구간의 **중앙값 y**(로버스트) 를 쓴다 — 양 끝 단일 열의 튐(가림·마스크 뿔)을 흡수한다.
 */
export function nearEdgeOf(cols: readonly { x: number; y: number }[]): [{ x: number; y: number }, { x: number; y: number }] | null {
  if (cols.length < 4) return null;
  const s = [...cols].sort((a, b) => a.x - b.x);
  const k = Math.max(1, Math.round(s.length / 4));
  const med = (ys: number[]): number => {
    const z = [...ys].sort((a, b) => a - b);
    return z[Math.floor(z.length / 2)];
  };
  const L = s.slice(0, k);
  const R = s.slice(s.length - k);
  const p0 = { x: L[0].x, y: med(L.map((c) => c.y)) };
  const p1 = { x: R[R.length - 1].x, y: med(R.map((c) => c.y)) };
  return p1.x - p0.x > 4 ? [p0, p1] : null;
}

/**
 * 근변 2점 → 지면 역투영 → **카메라에서 멀어지는 방향**으로 차량 prior 길이(4.7m) 만큼 밀어 원변 2점 → 재투영.
 * 반환 순서 [근좌, 원좌, 원우, 근우] — 순환이며 장축(깊이 4.7m)이 `groundAxisOf` 의 head 로 잡힌다.
 */
export function footprintFromContact(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  g: GroundModel,
): PixelQuad | null {
  const A = backprojectToGround(p0, g);
  const B = backprojectToGround(p1, g);
  if (!A || !B) return null;
  const side = unit3(sub3(B, A));
  if (!side) return null;
  let dir = unit3(cross3(g.n as Vec3, side));
  if (!dir) return null;
  const mid = mul3(add3(A, B), 0.5);
  if (dot3(dir, mid) < 0) dir = mul3(dir, -1); // |X| 가 커지는 쪽 = 카메라에서 먼 쪽.
  const push = (X: Vec3): Vec3 => add3(X, mul3(dir as Vec3, CAR_BODY.lengthM));
  const pts = [A, push(A), push(B), B].map((X) => projectToPixel(X, g));
  if (pts.some((p) => !p)) return null;
  return pts as PixelQuad;
}

// ── 소스 ① VPD seg 마스크 ────────────────────────────────────────────────────

/** 단계별 사망 원인 집계(설계 §8 단계1 검증 요구 — 「몇 건이 어디서 죽었는가」). */
export interface SourceDrops {
  total: number;
  noContour: number;
  noNearEdge: number;
  noFootprint: number;
  ok: number;
}

export const CONTOUR_STEP_PX = 4;

/**
 * 캐시 seg 마스크 → 관측. 마스크 없는 프레임(캐시 부재/강등)은 빈 배열.
 * `edge` 는 앞변 추정 방식 — **기본값 `'chord'` 로 24회차 산출을 비트 그대로 보존**한다(26회차 §4-5).
 *   `'chord'` = 현행 `nearEdgeOf`(콘투어 좌우 끝을 잇는 현) · `'kink'` = `frontEdgeOf`(L 분해 후 앞변)
 *   · `'kink2'` = 27-A **F4 꺾임점 고정** 앞변(`frontEdgeOf` + `pinKink` — 설계 §3 F4).
 */
export function vpdSegSource(cacheDir: string, drops?: Map<string, SourceDrops>, edge: 'chord' | 'kink' | 'kink2' = 'chord'): ObservationSource {
  return {
    kind: 'real-seg',
    observe(t: Target): VehicleObservation[] {
      const c = readSegCache(cacheDir, t.frameHash);
      const d: SourceDrops = { total: 0, noContour: 0, noNearEdge: 0, noFootprint: 0, ok: 0 };
      const out: VehicleObservation[] = [];
      if (c) {
        for (const b of c.boxes) {
          d.total += 1;
          const maskPx = b.mask.map((p) => ({ x: p.x * t.W, y: p.y * t.H }));
          const cols = bottomContour(maskPx, CONTOUR_STEP_PX); // ← `src/ground/contact.ts:85` 재사용
          if (cols.length < 4) {
            d.noContour += 1;
            continue;
          }
          const chord = nearEdgeOf(cols);
          const fit = edge === 'chord' ? null : frontEdgeOf(cols, t.model, chord, { pinKink: edge === 'kink2' });
          const e2: readonly [{ x: number; y: number }, { x: number; y: number }] | null = edge === 'chord' ? chord : fit ? [fit.p0, fit.p1] : null;
          if (!e2) {
            d.noNearEdge += 1;
            continue;
          }
          const fp = footprintFromContact(e2[0], e2[1], t.model);
          if (!fp) {
            d.noFootprint += 1;
            continue;
          }
          d.ok += 1;
          out.push({
            obsId: `seg#${b.vpdIdx}`,
            footprintPx: fp,
            bboxPx: { x0: b.rect.x * t.W, y0: b.rect.y * t.H, x1: (b.rect.x + b.rect.w) * t.W, y1: (b.rect.y + b.rect.h) * t.H },
            plateQuad: null,
            platePx: 0,
            confidence: b.confidence,
            source: 'real-vpd-seg',
          });
        }
      }
      drops?.set(t.key, d);
      return out;
    },
  };
}

// ── 소스 ② LPD 판 ────────────────────────────────────────────────────────────

/** 캐시 LPD quad → `occupancyRegion` 사다리꼴(수치 무변경) → footprintPx. */
export function lpdPlateSource(cacheDir: string, drops?: Map<string, SourceDrops>): ObservationSource {
  return {
    kind: 'real-lpd',
    observe(t: Target): VehicleObservation[] {
      const c = readLpdCache(cacheDir, t.frameHash);
      const d: SourceDrops = { total: 0, noContour: 0, noNearEdge: 0, noFootprint: 0, ok: 0 };
      const out: VehicleObservation[] = [];
      if (c) {
        for (let i = 0; i < c.plates.length; i++) {
          d.total += 1;
          const pl = c.plates[i];
          const ax = plateAxes(pl.quad as NormalizedQuad);
          if (!ax) {
            d.noNearEdge += 1;
            continue;
          }
          const trap = buildTrapezoid(ax, REGION_DEFAULTS.widthScaleMin, REGION_DEFAULTS);
          const fp = trap.map((p) => ({ x: p.x * t.W, y: p.y * t.H })) as PixelQuad;
          if (fp.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
            d.noFootprint += 1;
            continue;
          }
          const q = pl.quad.map((p) => ({ x: p.x * t.W, y: p.y * t.H })) as PixelQuad;
          let maxEdge = 0;
          for (let e = 0; e < 4; e++) maxEdge = Math.max(maxEdge, Math.hypot(q[e].x - q[(e + 1) % 4].x, q[e].y - q[(e + 1) % 4].y));
          d.ok += 1;
          out.push({ obsId: `lpd#${i}`, footprintPx: fp, bboxPx: null, plateQuad: q, platePx: maxEdge, confidence: pl.confidence, source: 'real-lpd' });
        }
      }
      drops?.set(t.key, d);
      return out;
    },
  };
}

// ── 캐시 채움(네트워크) ───────────────────────────────────────────────────────

/** 골든 프레임 → 검출 서버 POST → 캐시 저장. 이미 있으면 건너뛴다. */
export async function fillCache(targets: readonly Target[], cacheDir: string): Promise<void> {
  mkdirSync(cacheDir, { recursive: true });
  const cfg = loadToolsConfig();
  const vpd = new VpdClient(cfg.vpd);
  const lpd = new LpdClient(cfg.lpd);
  for (const t of targets) {
    if (!readSegCache(cacheDir, t.frameHash)) {
      const r = await vpd.segment(t.jpg);
      const payload: SegCache = {
        frameHash: t.frameHash,
        key: t.key,
        W: t.W,
        H: t.H,
        boxes: r.boxes.map((b) => ({ vpdIdx: b.vpdIdx, confidence: b.confidence, cls: b.cls, rect: b.rect, mask: (b.mask ?? []) as Array<{ x: number; y: number }> })),
        segDegraded: r.segDegraded,
        maskMismatch: r.maskMismatch,
      };
      writeFileSync(cachePath(cacheDir, t.frameHash, 'seg'), JSON.stringify(payload));
      console.log(`  seg  ${t.key} ${t.frameHash} → 마스크 ${payload.boxes.length}개 (강등=${r.segDegraded} 불일치=${r.maskMismatch})`);
    } else {
      console.log(`  seg  ${t.key} ${t.frameHash} → 캐시 사용 ${readSegCache(cacheDir, t.frameHash)!.boxes.length}개`);
    }
    if (!readLpdCache(cacheDir, t.frameHash)) {
      const plates = await lpd.detect(t.jpg);
      const payload: LpdCache = { frameHash: t.frameHash, key: t.key, W: t.W, H: t.H, plates: plates.map((p) => ({ quad: p.quad as Array<{ x: number; y: number }>, confidence: p.confidence, cls: p.cls })) };
      writeFileSync(cachePath(cacheDir, t.frameHash, 'lpd'), JSON.stringify(payload));
      console.log(`  lpd  ${t.key} ${t.frameHash} → 판 ${payload.plates.length}개`);
    } else {
      console.log(`  lpd  ${t.key} ${t.frameHash} → 캐시 사용 ${readLpdCache(cacheDir, t.frameHash)!.plates.length}개`);
    }
  }
}

// ── 원 마스크 + 접지선 오버레이(설계 §5 `r24_rawmask_*` — 이번 회차의 핵심 그림) ──

const fmt = (v: number) => v.toFixed(1);

export async function drawRawMaskOverlay(t: Target, cacheDir: string, outPath: string): Promise<{ masks: number; edges: number }> {
  const c = readSegCache(cacheDir, t.frameHash);
  const parts: string[] = [];
  let edges = 0;
  for (const b of c?.boxes ?? []) {
    const maskPx = b.mask.map((p) => ({ x: p.x * t.W, y: p.y * t.H }));
    parts.push(`<polygon points="${maskPx.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(' ')}" fill="#ffb30022" stroke="#ffb300" stroke-width="2"/>`);
    const cols = bottomContour(maskPx, CONTOUR_STEP_PX);
    if (cols.length) parts.push(`<polyline points="${cols.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(' ')}" fill="none" stroke="#00e5ff" stroke-width="2.4"/>`);
    const e = nearEdgeOf(cols);
    if (e) {
      edges += 1;
      parts.push(`<line x1="${fmt(e[0].x)}" y1="${fmt(e[0].y)}" x2="${fmt(e[1].x)}" y2="${fmt(e[1].y)}" stroke="#ff1744" stroke-width="3.4"/>`);
    }
  }
  parts.push(`<rect x="14" y="14" width="1420" height="120" fill="#000000cc" rx="8"/>`);
  const txt = (x: number, y: number, s: string, fill: string, size: number) =>
    `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-weight="bold" stroke="#000" stroke-width="0.6" paint-order="stroke">${s}</text>`;
  parts.push(txt(30, 50, `원 마스크 + 접지 콘투어 (기하 없음) · ${t.key} · 프레임해시 ${t.frameHash}`, '#fff', 23));
  parts.push(txt(30, 84, `마스크 ${c?.boxes.length ?? 0}개 · 근변 성립 ${edges}개 · stepPx=${CONTOUR_STEP_PX}`, '#ddd', 19));
  parts.push(
    `<text x="30" y="116" font-size="17" font-weight="bold"><tspan fill="#ffb300">━ VPD seg 마스크</tspan>  <tspan fill="#00e5ff">━ bottomContour(열별 최하단)</tspan>  <tspan fill="#ff1744">━ 근변 2점(로버스트)</tspan></text>`,
  );
  const svg = `<svg width="${t.W}" height="${t.H}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
  writeFileSync(outPath, await sharp(t.jpg).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer());
  return { masks: c?.boxes.length ?? 0, edges };
}

// ── main ─────────────────────────────────────────────────────────────────────

const argOf = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : dflt;
};

async function main(): Promise<void> {
  const cacheDir = argOf('--cache', 'reports/detcache_r24');
  const fetchArg = argOf('--fetch', '');
  const rawArg = argOf('--rawmask', '');
  const targetArg = fetchArg || rawArg || 'v1';
  const targets = await goldenTargets(GOLDEN_DIRS[targetArg] ?? targetArg);
  console.log(`24회차 검출 응답 캐시 — 대상 ${targetArg} · 프레임 ${targets.length}장 · 캐시 ${cacheDir}\n★ 카메라 물리 이동 0(골든 JPEG 파일만 읽는다)\n`);
  if (fetchArg) await fillCache(targets, cacheDir);
  if (rawArg) {
    const outDir = argOf('--out', 'reports/overlay_r24a');
    mkdirSync(outDir, { recursive: true });
    for (const t of targets) {
      const p = join(outDir, `r24_rawmask_${t.key.replace(':', '_')}_${t.frameHash}.png`);
      const r = await drawRawMaskOverlay(t, cacheDir, p);
      console.log(`   rawmask ${t.key} 마스크 ${r.masks} 근변 ${r.edges} → ${p}`);
    }
  }
  // 관측 산출 요약(캐시만 사용 · 네트워크 0).
  const dSeg = new Map<string, SourceDrops>();
  const dLpd = new Map<string, SourceDrops>();
  const seg = vpdSegSource(cacheDir, dSeg);
  const lpd = lpdPlateSource(cacheDir, dLpd);
  let sTot = 0;
  let lTot = 0;
  console.log(`\n   대상  프레임해시     seg마스크 seg관측 (콘투어실패/근변실패/역투영실패)  lpd판 lpd관측`);
  for (const t of targets) {
    const so = seg.observe(t, null as never).length;
    const lo = lpd.observe(t, null as never).length;
    sTot += so;
    lTot += lo;
    const a = dSeg.get(t.key)!;
    const b = dLpd.get(t.key)!;
    console.log(`   ${t.key.padEnd(5)} ${t.frameHash} ${String(a.total).padStart(9)} ${String(so).padStart(7)}  (${a.noContour}/${a.noNearEdge}/${a.noFootprint})  ${String(b.total).padStart(5)} ${String(lo).padStart(7)}`);
  }
  console.log(`   ★ 합계 seg 관측 ${sTot} · lpd 관측 ${lTot}`);
}

if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) await main();
