// ★ 14회차 — **0.95 기준 면별 집계(P1)** + **합의 좌표 융합(P2)** 실측 도구.
//
// 목표가 0.98 → 0.95 로 내려왔다. 7~13회차 보고가 전부 ≥0.98 기준이라 **≥0.95 통과 면수를 아무도 세지 않았다.**
// 이 도구는 같은 디더 캡처 한 벌로 아래 4가지를 **동시에** 내서 서로 비교 가능하게 한다:
//
//   ① 단일(기저 시점)            — 합의 OFF 에 해당
//   ② 합의-선별, tilt 미보정      — **현행 서비스**(`roiAuto.ts:detectOne` 이 디더 프레임에 기저 tilt 를 쓴다)
//   ③ 합의-선별, tilt 보정        — 12회차 도구(`roiAutoConsensus.ts:90`)와 같은 처리
//   ④ 합의-융합, tilt 보정        — P2. 승리 군집 멤버 quad 를 코너별 **중앙값**으로 융합
//
// ②↔③ 의 차이가 곧 tilt 미보정 결함의 크기이고, ③↔④ 의 차이가 곧 좌표 융합의 효과다.
//
// ★ 프레임은 **골든 세트**(`test/fixtures/roiAutoGolden/`)에서 읽는 것이 기본이다.
//
//   같은 PTZ 라도 잡히는 프레임이 달라지고(14회차 실측: 캡처 이력·씬 상태에 따라 통과면수 ±6면),
//   그러면 **회차 간 비교가 성립하지 않는다.** 7~13회차의 라운드 간 수치 향상이 알고리즘 개선인지
//   프레임 운인지 구분되지 않는 것이 이 때문이다. 알고리즘 비교는 고정 세트 위에서만 한다.
//   라이브 캡처는 "실환경에서도 도는가" 확인용이며 회차 간 비교에 쓰지 않는다.
//
// 정본·DB 무접촉(읽기만). 라이브 캡처 시 프레임 취득 전 `roi.show2d{visible:false}`(D-5).
//
// 사용: npx tsx src/tools/roiAutoFuse.ts [frames] [modes] [rowExtentMode]
//   frames 생략 → 골든 v1. `v1`/`v2` 는 골든 세트 별칭, 그 밖은 캐시 디렉터리로 보고 없는 프레임만 라이브로 채운다.
//   modes  생략 → `A`(현행). CSV 로 여러 모드를 한 실행에 낼 수 있다(예 `A,A0,B,C`).
//
// ★ 15회차 — **자가보정 증폭기 통제**(P2). 지상고 정책만 4가지로 갈라 같은 프레임 위에서 잰다:
//
//   A  = 현행           시점별 자유 자가보정(`calibrateHeight:true`) + 근변선 재적합 ON
//   A0 = 통제군         자가보정 ON + **재적합 OFF**(`refitFrontLine:false`)
//   B  = 보정 OFF       지상고 F6 상수 4.950m 고정 + `calibrateHeight:false`
//   C  = 시점 공유      6시점 자가보정 지상고의 중앙값(낮은 쪽)을 전 시점에 고정 + `calibrateHeight:false`
//
// ★★ A0 가 왜 필요한가(15회차 설계자 발견) — `bayGrid.ts:508` 이 `calib === null` 이면 **조기 반환**한다.
//   즉 `calibrateHeight:false` 는 지상고 정책만 끄는 것이 아니라 8회차 근변선 2자유도 재적합까지 함께 끈다.
//   그래서 B·C 는 구조상 재적합이 없다. A 와 직접 비교하면 "지상고 정책 + 재적합 유무"를 섞어 재게 되므로,
//   재적합만 끈 A0 를 통제군으로 세워야 지상고 정책이 단독으로 비교된다(A↔A0 차이 = 재적합 기여분).
//
// ★★★ B 는 `calibrateHeight:false` 만으로 성립하지 않는다. 정본 `camera.position[1]` 이 5.0 이라
//   플래그만 끄면 5.0m 가 쓰인다. F6 상수 4.950m 를 쓰려면 `heightM` 오버라이드가 **함께** 필요하다.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  DEFAULT_PAINT_OPTIONS,
  detectPaintLines,
  meetLines,
  paintEvidenceOf,
  refineSeparators,
  scanSeparators,
  stripeCenter,
  type FrameGray,
} from '../ground/floorPaint.js';
import { DEFAULT_BAY_OPTS, type BayDetectOpts, type BayQuad } from '../ground/bayGeometry.js';
import { detectBaysWithModel, type RowCandidate } from '../ground/bayGrid.js';
import { groundModelFromIntrinsics, type PresetIntrinsics } from '../ground/cameraIntrinsics.js';
import { placeMetaProvider, readPlaceMeta } from '../ground/placeMetaIntrinsics.js';
import { scorePreset } from '../ground/roiAutoScore.js';
import { backprojectToGround, projectToPixel } from '../ground/project.js';
import { canonicalizeQuad } from '../ground/groundGrid.js';
import { normalizePtzCamRoi } from '../capture/placeRoi.js';
import type { GroundModel, PixelQuad } from '../ground/types.js';
import type { Px, Vec3 } from '../ground/contactTypes.js';

/** 골든 세트 별칭 → 디렉터리. v1=14회차(이동 직후), v2=15회차(정착 프레임). */
const GOLDEN_DIRS: Record<string, string> = {
  v1: 'test/fixtures/roiAutoGolden',
  v2: 'test/fixtures/roiAutoGolden_v2',
};
const framesArg = process.argv[2] ?? 'v1';
const cacheDir = GOLDEN_DIRS[framesArg] ?? framesArg;
const golden = Object.values(GOLDEN_DIRS).includes(cacheDir);
mkdirSync(cacheDir, { recursive: true });

/** 실행할 지상고 정책 모드. 인자 생략 시 `A` 뿐이라 14회차와 출력이 동일하다(하위호환). */
type ModeTag = 'A' | 'A0' | 'B' | 'C';
const MODE_TAGS: readonly ModeTag[] = ['A', 'A0', 'B', 'C'];
const modes = (process.argv[3] ?? 'A')
  .split(',')
  .map((s) => s.trim())
  .filter((s): s is ModeTag => (MODE_TAGS as readonly string[]).includes(s));
if (!modes.length) throw new Error(`모드 인자가 비었다: ${process.argv[3]} (허용 ${MODE_TAGS.join(',')})`);
/** 모드가 1개면 접두를 붙이지 않는다 — 14회차 출력과 바이트 동일하게 유지하기 위함. */
const multi = modes.length > 1;

/**
 * ★ 18회차 — 행 범위 결정 방식 override(4번째 인자, 생략 시 `DEFAULT_BAY_OPTS` 기본값).
 * `expected` 를 주면 17회차까지의 N-창 동작이 그대로 재생돼 **무회귀 게이트**로 쓸 수 있다.
 */
const rowExtentArg = process.argv[4];
if (rowExtentArg != null && rowExtentArg !== 'evidence' && rowExtentArg !== 'expected') {
  throw new Error(`rowExtentMode 인자가 잘못됐다: ${rowExtentArg} (허용 evidence,expected)`);
}
const rowExtentOverride: Partial<BayDetectOpts> = rowExtentArg ? { rowExtentMode: rowExtentArg } : {};

/** ★ `roiAuto.ts` 의 `DITHER` 와 **같은 집합·같은 순서**여야 한다(기저가 첫째). */
const DITHER: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [-1.5, 0],
  [1.5, 0],
  [0, -0.8],
  [0, 0.8],
  [1.0, 0.6],
];

const RPC = 'http://localhost:13110/rpc';
let rpcId = 0;
async function rpc(method: string, params: Record<string, unknown>): Promise<any> {
  // 유니티 HTTP 서버가 keep-alive 소켓을 끊어 ECONNRESET/ECONNABORTED 가 간헐 발생한다 —
  // 재시도로 흡수한다(같은 PTZ 재캡처는 바이트 동일이므로 재시도가 결과를 바꾸지 않는다).
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Connection: 'close' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      });
      const j = (await r.json()) as any;
      if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
      return j.result;
    } catch (err) {
      last = err;
      await new Promise((res) => setTimeout(res, 300 * (attempt + 1)));
    }
  }
  throw last;
}

const placeJson = JSON.parse(readFileSync('data/Place01/PtzCamRoi.json', 'utf8'));
const { byPreset } = normalizePtzCamRoi(placeJson);
const intrinsics = placeMetaProvider(readPlaceMeta(placeJson));
const targets: Array<{ key: string; cam: number; preset: number; pan: number; tilt: number; zoom: number }> = [];
for (const c of placeJson.cameras) {
  for (const p of c.presets) {
    targets.push({ key: `${c.camera.cam_id}:${p.preset_idx}`, cam: c.camera.cam_id, preset: p.preset_idx, pan: p.pan, tilt: p.tilt, zoom: p.zoom });
  }
}

/** 변주 시점 지면좌표 → 기저 시점 지면좌표(`roiAuto.ts:toBaseFrame` 과 동일 식). */
function toBaseFrame(X: Vec3, n0: Vec3, dPanDeg: number, dTiltDeg: number): Vec3 {
  const dt = -(dTiltDeg * Math.PI) / 180;
  const ct = Math.cos(dt);
  const st = Math.sin(dt);
  const X1: Vec3 = [X[0], X[1] * ct - X[2] * st, X[1] * st + X[2] * ct];
  const dp = (dPanDeg * Math.PI) / 180;
  const cp = Math.cos(dp);
  const sp = Math.sin(dp);
  const dot = n0[0] * X1[0] + n0[1] * X1[1] + n0[2] * X1[2];
  const cr: Vec3 = [n0[1] * X1[2] - n0[2] * X1[1], n0[2] * X1[0] - n0[0] * X1[2], n0[0] * X1[1] - n0[1] * X1[0]];
  return [
    X1[0] * cp + cr[0] * sp + n0[0] * dot * (1 - cp),
    X1[1] * cp + cr[1] * sp + n0[1] * dot * (1 - cp),
    X1[2] * cp + cr[2] * sp + n0[2] * dot * (1 - cp),
  ];
}

/** 이 실행이 실제로 쓴 프레임의 지문 — 표 제목에 붙인다(해시 없는 IoU 수치는 해석할 수 없다). */
const frameHashes = new Map<string, string>();

/** 골든 세트(JPEG) 또는 캐시된(없으면 새로 찍는) 디더 프레임. */
async function frameOf(t: (typeof targets)[number], i: number): Promise<FrameGray> {
  const [dp, dt] = DITHER[i];
  if (golden) {
    const jpg = readFileSync(join(cacheDir, `frame_${t.cam}_${t.preset}_d${i}.jpg`));
    frameHashes.set(`${t.key}#${i}`, createHash('sha256').update(jpg).digest('hex').slice(0, 12));
    const meta = await sharp(jpg).metadata();
    const gb = await sharp(jpg).greyscale().raw().toBuffer();
    return { data: new Uint8Array(gb.buffer, gb.byteOffset, gb.byteLength), width: meta.width ?? 0, height: meta.height ?? 0 };
  }
  const f = join(cacheDir, `fuse_${t.cam}_${t.preset}_${i}.json`);
  let img: string;
  let W: number;
  let H: number;
  if (existsSync(f)) {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    img = j.img_bytes;
    W = j.width;
    H = j.height;
  } else {
    await rpc('cam.setPTZ', { camId: t.cam, pan: t.pan + dp, tilt: t.tilt + dt, zoom: t.zoom });
    const cap = await rpc('cam.captureJPG', { camId: t.cam });
    img = cap.img_bytes;
    W = cap.width;
    H = cap.height;
    writeFileSync(f, JSON.stringify({ img_bytes: img, width: W, height: H, dither: [dp, dt] }));
  }
  frameHashes.set(`${t.key}#${i}`, createHash('sha256').update(Buffer.from(img, 'base64')).digest('hex').slice(0, 12));
  const gb = await sharp(Buffer.from(img, 'base64')).greyscale().raw().toBuffer();
  return { data: new Uint8Array(gb.buffer, gb.byteOffset, gb.byteLength), width: W, height: H };
}

/**
 * 프레임 1장 검출. `model` 은 호출자가 정한다(tilt 보정 유무가 여기서 갈린다).
 * `optOverride` 는 지상고 정책 모드가 `DEFAULT_BAY_OPTS` 위에 얹는 유일한 주입 지점이다(`src/ground/*` 무변경).
 */
function detect(frame: FrameGray, model: GroundModel, expectedBays: number, optOverride: Partial<BayDetectOpts>) {
  const { lines, mask } = detectPaintLines(frame, DEFAULT_PAINT_OPTIONS);
  const ev = paintEvidenceOf(mask, frame.width, frame.height);
  const cands: RowCandidate[] = [];
  for (const front of lines.slice(0, DEFAULT_PAINT_OPTIONS.frontCandidates)) {
    const pk = scanSeparators(frame, mask, front, DEFAULT_PAINT_OPTIONS);
    const seps = pk.length ? refineSeparators(frame, pk, DEFAULT_PAINT_OPTIONS) : [];
    const pts: Array<{ x: number; y: number }> = [];
    for (const sp of seps) {
      const q = meetLines(sp.line, front.line);
      if (q) pts.push(q);
    }
    cands.push({ front, cornersPx: pts });
  }
  return detectBaysWithModel(cands, model, ev, DEFAULT_PAINT_OPTIONS, { ...DEFAULT_BAY_OPTS, expectedBays: Math.max(1, expectedBays), ...rowExtentOverride, ...optOverride }, frame);
}

/**
 * 부수 산출(리더 지시) — 이 시점의 **도색 스트라이프 중심 드리프트**(px).
 * 채택 근변선 위 여러 지점에서 법선 프로파일을 떠 `stripeCenter` 의 t 를 median 으로 낸다.
 * 시점에 따라 변하면 광학 원인, 불변이면 씬 원인. **이번 라운드에 원인을 좇지 않는다 — 기록만.**
 */
function stripeDriftPx(frame: FrameGray, L: readonly [number, number, number], corners: ReadonlyArray<{ x: number; y: number }>): number | null {
  const at = (x: number, y: number): number | null => {
    if (x < 0 || y < 0 || x > frame.width - 1 || y > frame.height - 1) return null;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(frame.width - 1, x0 + 1);
    const y1 = Math.min(frame.height - 1, y0 + 1);
    const tx = x - x0;
    const ty = y - y0;
    const g = frame.data;
    return (
      (g[y0 * frame.width + x0] * (1 - tx) + g[y0 * frame.width + x1] * tx) * (1 - ty) +
      (g[y1 * frame.width + x0] * (1 - tx) + g[y1 * frame.width + x1] * tx) * ty
    );
  };
  const ts: number[] = [];
  for (const c of corners) {
    const s = L[0] * c.x + L[1] * c.y + L[2];
    const fx = c.x - L[0] * s;
    const fy = c.y - L[1] * s;
    const prof: Array<{ t: number; v: number | null }> = [];
    for (let u = -22; u <= 22; u += 0.25) prof.push({ t: u, v: at(fx + L[0] * u, fy + L[1] * u) });
    const sc = stripeCenter(prof, DEFAULT_PAINT_OPTIONS);
    if (sc) ts.push(sc.t);
  }
  if (!ts.length) return null;
  const s = [...ts].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

/** 짝수 개면 **낮은 쪽 중앙값**(결정론 — R2). */
const medianLow = (a: readonly number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor((s.length - 1) / 2)];
};

interface View {
  i: number;
  quadsBase: PixelQuad[];
  centre: Vec3 | null;
  drift: number | null;
  heightM: number | null;
}

/** 지상고 정책 1건. 모드는 이 구조체 하나로 표현된다(검출 경로에 분기를 추가하지 않는다). */
interface HeightPolicy {
  tag: ModeTag;
  /** 검출 모델의 설치고(m). null 이면 정본 메타 공칭값(5.0)을 그대로 쓴다. */
  heightM: number | null;
  /** `DEFAULT_BAY_OPTS` 위에 얹을 오버라이드. */
  optOverride: Partial<BayDetectOpts>;
}

/** F6 상수 — 4회차 자가보정이 수렴한 설치고. 공칭 5.0 대비 −1.0% 라 플래그만 꺼서는 재현되지 않는다. */
const F6_HEIGHT_M = 4.95;

/** 한 변주 시점을 검출해 quad 를 **기저 시점 픽셀**로 되돌린다. */
function viewOf(
  i: number,
  frame: FrameGray,
  baseIntr: PresetIntrinsics,
  t: (typeof targets)[number],
  bays: number,
  compensateTilt: boolean,
  policy: HeightPolicy,
): View | null {
  const [dp, dt] = DITHER[i];
  // ★ 기저 모델 m0 는 **전 모드 공칭 5.0 고정**이다. 역투영은 d 를 균일 배율로만 타고 핀홀 투영은 방향에만
  //   의존하므로 `modelUsed.d ≠ m0.d` 여도 재투영 픽셀은 같다 — 기저 좌표계를 모드 간 통일해 둔다.
  const m0 = groundModelFromIntrinsics(baseIntr, t.zoom);
  const intrH: PresetIntrinsics = policy.heightM == null ? baseIntr : { ...baseIntr, heightM: policy.heightM };
  const intrV: PresetIntrinsics = compensateTilt ? { ...intrH, tiltDeg: intrH.tiltDeg + dt } : intrH;
  const mv = groundModelFromIntrinsics(intrV, t.zoom);
  if (!m0 || !mv) return null;
  const g = detect(frame, mv, bays, policy.optOverride);
  const best = g.best;
  if (!best || !best.quads.length) return { i, quadsBase: [], centre: null, drift: null, heightM: null };
  const n0 = m0.n as unknown as Vec3;
  const qb: PixelQuad[] = [];
  let cx = 0;
  let cy = 0;
  let cz = 0;
  let cn = 0;
  for (const q of best.quads) {
    const px: Array<{ x: number; y: number }> = [];
    let ok = true;
    for (const p of q.quad) {
      const X = backprojectToGround(p as Px, best.modelUsed);
      if (!X) {
        ok = false;
        break;
      }
      const Xb = toBaseFrame(X as unknown as Vec3, n0, dp, dt);
      cx += Xb[0];
      cy += Xb[1];
      cz += Xb[2];
      cn++;
      const u = projectToPixel(Xb, m0);
      if (!u) {
        ok = false;
        break;
      }
      px.push(u);
    }
    if (!ok || px.length !== 4) continue;
    const cq = canonicalizeQuad(px as PixelQuad);
    if (cq) qb.push(cq);
  }
  return {
    i,
    quadsBase: qb,
    centre: cn > 0 ? [cx / cn, cy / cn, cz / cn] : null,
    drift: stripeDriftPx(frame, best.frontLine, best.cornersPx),
    heightM: best.calibration?.correctedM ?? null,
  };
}

/** 행 중심 2.0m 이내 = 같은 행. 최다 득표 → 동점 시 기저(낮은 인덱스) 우선 — `roiAuto.ts` 와 동일 규칙. */
function vote(views: readonly View[]): { members: number[]; votes: string } | null {
  const clusters: Array<{ members: number[]; c: Vec3 }> = [];
  for (const v of views) {
    if (!v.centre) continue;
    const hit = clusters.find((cl) => Math.hypot(cl.c[0] - v.centre![0], cl.c[1] - v.centre![1], cl.c[2] - v.centre![2]) < 2.0);
    if (hit) hit.members.push(v.i);
    else clusters.push({ members: [v.i], c: v.centre });
  }
  if (!clusters.length) return null;
  clusters.sort((a, b) => b.members.length - a.members.length || Math.min(...a.members) - Math.min(...b.members));
  return { members: clusters[0].members, votes: clusters.map((c) => c.members.length).join('/') };
}

/**
 * ★ P2 — 승리 군집 멤버의 quad 를 **베이별로 대응시켜 코너별 중앙값**으로 융합한다.
 *
 * 대응은 대표 시점(가장 이른 멤버)의 quad 를 기준으로 **중심 최근접**으로 잡는다.
 * 격자 인덱스는 시점마다 위상 원점이 달라 그대로 쓸 수 없다.
 */
function fuse(views: readonly View[], members: readonly number[]): PixelQuad[] {
  const byIdx = new Map(views.map((v) => [v.i, v]));
  const repI = Math.min(...members);
  const rep = byIdx.get(repI);
  if (!rep) return [];
  const centreOf = (q: PixelQuad) => ({ x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4, y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4 });
  const out: PixelQuad[] = [];
  for (const anchor of rep.quadsBase) {
    const ac = centreOf(anchor);
    // 베이 폭의 절반 안에 든 것만 같은 베이로 본다(대각 길이의 1/4 을 척도로).
    const scale = Math.hypot(anchor[0].x - anchor[2].x, anchor[0].y - anchor[2].y) / 4;
    const group: PixelQuad[] = [];
    for (const i of [...members].sort((a, b) => a - b)) {
      const v = byIdx.get(i);
      if (!v) continue;
      let best: { d: number; q: PixelQuad } | null = null;
      for (const q of v.quadsBase) {
        const c = centreOf(q);
        const d = Math.hypot(c.x - ac.x, c.y - ac.y);
        if (d <= scale && (!best || d < best.d)) best = { d, q };
      }
      if (best) group.push(best.q);
    }
    if (!group.length) {
      out.push(anchor);
      continue;
    }
    const merged = [0, 1, 2, 3].map((k) => ({
      x: medianLow(group.map((q) => q[k].x)),
      y: medianLow(group.map((q) => q[k].y)),
    })) as PixelQuad;
    out.push(merged);
  }
  return out;
}

const asBayQuads = (qs: readonly PixelQuad[]): BayQuad[] => qs.map((q, i) => ({ latticeIndex: i, quad: q }));

if (!golden) await rpc('roi.show2d', { visible: false }); // ★ D-5 (골든 세트는 이미 적용된 프레임이다)
console.log(
  '0.95 기준 면별 집계 + 합의 좌표 융합 — 디더 6시점, 정본·DB 무접촉\n' +
    `프레임 출처: ${golden ? `골든 세트 ${cacheDir}` : `라이브/캐시 ${cacheDir}`}\n` +
    (multi ? `지상고 정책 모드: ${modes.join(' · ')}\n` : ''),
);

const VARIANTS = ['single', 'selRaw', 'selTilt', 'fuseTilt'] as const;
const VARIANT_LABEL: Record<(typeof VARIANTS)[number], string> = {
  single: '① 단일(기저)      ',
  selRaw: '② 선별 tilt미보정 ',
  selTilt: '③ 선별 tilt보정   ',
  fuseTilt: '④ 융합 tilt보정   ',
};
/** 집계 키 — 모드 1개면 14회차와 같은 변형명 그대로다. */
const keyOf = (m: ModeTag, v: string) => (multi ? `${m.padEnd(2)}|${v}` : v);
const totals: Record<string, [number, number]> = {};
const means: Record<string, number[]> = {};
for (const m of modes) for (const v of VARIANTS) ((totals[keyOf(m, v)] = [0, 0]), (means[keyOf(m, v)] = []));

for (const t of targets) {
  const manual = byPreset.get(t.key) ?? [];
  const bays = manual.filter((s) => Array.isArray(s.points) && s.points.length === 4).length;
  const baseIntr = intrinsics.get(t.cam, t.preset);
  if (!baseIntr || bays < 1) continue;
  const frames: FrameGray[] = [];
  for (let i = 0; i < DITHER.length; i++) frames.push(await frameOf(t, i));

  const W = frames[0].width;
  const H = frames[0].height;

  /** 두 분기(tilt 미보정/보정)를 각자의 정책으로 검출한다 — C 는 분기별 중앙값이 달라 정책도 분기별이다. */
  const viewsFor = (pRaw: HeightPolicy, pTilt: HeightPolicy) => {
    const viewsRaw: View[] = [];
    const viewsTilt: View[] = [];
    for (let i = 0; i < DITHER.length; i++) {
      const a = viewOf(i, frames[i], baseIntr, t, bays, false, pRaw);
      const b = viewOf(i, frames[i], baseIntr, t, bays, true, pTilt);
      if (a) viewsRaw.push(a);
      if (b) viewsTilt.push(b);
    }
    return { viewsRaw, viewsTilt };
  };

  // C 의 1pass 는 A 결과 재사용이다(추가 검출 0회). A 를 출력하지 않더라도 C 가 있으면 계산은 필요하다.
  const needA = modes.includes('A') || modes.includes('C');
  const aViews = needA ? viewsFor({ tag: 'A', heightM: null, optOverride: {} }, { tag: 'A', heightM: null, optOverride: {} }) : null;
  const medianOf = (vs: readonly View[]): number | null => {
    const hs = vs.map((v) => v.heightM).filter((h): h is number => h != null);
    return hs.length ? medianLow(hs) : null;
  };
  const hCRaw = aViews ? medianOf(aViews.viewsRaw) : null;
  const hCTilt = aViews ? medianOf(aViews.viewsTilt) : null;

  const frameLine = `    프레임 ${DITHER.map((_, i) => frameHashes.get(`${t.key}#${i}`) ?? '-').join('/')}`;
  if (multi) console.log(`=== ${t.key} (수동 ${bays}면)\n${frameLine}`);

  for (const mode of modes) {
    const pfx = multi ? `[${mode.padEnd(2)}] ` : '';
    // ★ 표본 0건이면 C 를 지어내지 않는다 — 미산출로 남긴다.
    if (mode === 'C' && (hCRaw == null || hCTilt == null)) {
      if (!multi) console.log(`=== ${t.key} (수동 ${bays}면)\n${frameLine}`);
      console.log(`  ${pfx}미산출(자가보정 표본 0/6 — 미보정 ${hCRaw == null ? '0' : '≥1'} · 보정 ${hCTilt == null ? '0' : '≥1'})\n`);
      continue;
    }
    let vs: { viewsRaw: View[]; viewsTilt: View[] };
    let heightNote: string;
    if (mode === 'A') {
      vs = aViews!;
      heightNote = `시점별 자가보정 지상고(m): ${vs.viewsTilt.map((v) => (v.heightM == null ? '--' : v.heightM.toFixed(3))).join(' ')}`;
    } else if (mode === 'A0') {
      const p: HeightPolicy = { tag: 'A0', heightM: null, optOverride: { refitFrontLine: false } };
      vs = viewsFor(p, p);
      heightNote = `시점별 자가보정 지상고(m): ${vs.viewsTilt.map((v) => (v.heightM == null ? '--' : v.heightM.toFixed(3))).join(' ')}`;
    } else if (mode === 'B') {
      const p: HeightPolicy = { tag: 'B', heightM: F6_HEIGHT_M, optOverride: { calibrateHeight: false } };
      vs = viewsFor(p, p);
      heightNote = `지상고(m): 고정 ${F6_HEIGHT_M.toFixed(3)} (F6 상수, 보정 OFF)`;
    } else {
      vs = viewsFor(
        { tag: 'C', heightM: hCRaw, optOverride: { calibrateHeight: false } },
        { tag: 'C', heightM: hCTilt, optOverride: { calibrateHeight: false } },
      );
      heightNote = `지상고(m): 고정 미보정 ${hCRaw!.toFixed(3)} · 보정 ${hCTilt!.toFixed(3)} (A 6시점 중앙값, 보정 OFF)`;
    }

    const vRaw = vote(vs.viewsRaw);
    const vTilt = vote(vs.viewsTilt);
    const repRaw = vRaw ? vs.viewsRaw.find((v) => v.i === Math.min(...vRaw.members)) : null;
    const repTilt = vTilt ? vs.viewsTilt.find((v) => v.i === Math.min(...vTilt.members)) : null;
    const quadsOf: Record<(typeof VARIANTS)[number], PixelQuad[]> = {
      single: vs.viewsTilt[0]?.quadsBase ?? [],
      selRaw: repRaw?.quadsBase ?? [],
      selTilt: repTilt?.quadsBase ?? [],
      fuseTilt: vTilt ? fuse(vs.viewsTilt, vTilt.members) : [],
    };

    if (multi) console.log(`  ${pfx}득표 미보정 ${vRaw?.votes ?? '-'} · 보정 ${vTilt?.votes ?? '-'}`);
    else console.log(`=== ${t.key} (수동 ${bays}면)  득표 미보정 ${vRaw?.votes ?? '-'} · 보정 ${vTilt?.votes ?? '-'}\n${frameLine}`);
    for (const tag of VARIANTS) {
      const sc = scorePreset(asBayQuads(quadsOf[tag]), [], manual, W, H, t.key, t.cam, t.preset);
      const ious = sc.slots.map((s) => s.iouVsManual);
      const p95 = ious.filter((v) => v >= 0.95).length;
      const p98 = ious.filter((v) => v >= 0.98).length;
      const k = keyOf(mode, tag);
      totals[k][0] += p95;
      totals[k][1] += p98;
      if (sc.meanIoU != null) means[k].push(sc.meanIoU);
      console.log(
        `  ${pfx}${VARIANT_LABEL[tag]} ${sc.slots.map((s) => `s${s.slotIdx}=${s.iouVsManual.toFixed(4)}`).join(' ')}` +
          `  | ≥0.95 ${p95}/${bays} · ≥0.98 ${p98}/${bays} · 평균 ${sc.meanIoU?.toFixed(5) ?? '--'}`,
      );
    }
    console.log(
      `  ${pfx}시점별 tC 드리프트(px): ${vs.viewsTilt.map((v) => `[${DITHER[v.i][0]},${DITHER[v.i][1]}]=${v.drift == null ? '--' : v.drift.toFixed(2)}`).join(' ')}`,
    );
    console.log(`  ${pfx}${heightNote}\n`);
  }
}

console.log('=== 전체(21면 기준, 1:3 포함 집계는 별도 판단) ===');
for (const [k, v] of Object.entries(totals)) {
  const m = means[k];
  console.log(`  ${k.padEnd(multi ? 12 : 9)} ≥0.95 ${String(v[0]).padStart(2)}면 · ≥0.98 ${String(v[1]).padStart(2)}면 · 프리셋평균의평균 ${(m.reduce((s, x) => s + x, 0) / (m.length || 1)).toFixed(5)}`);
}
