// ★ 22회차 Phase 0 신규 — **「차량앵커 닫기」(설계서 §R2-2 안 2) 착수 전 상한 측정**.
//
// ══════════════════════════════════════════════════════════════════════════
// 재는 것 (검출 알고리즘 배선 0줄 · `src/ground/**` · `src/rpc/services/**` · `web/**` 무접촉):
//   ⓑ-0  **번호판 px 크기** — LPD 경로가 원리적으로 가능한가(설계서 F9 · ⓑ-2 의 전제)
//   ⓑ-1  **오라클 상한**(도달 불가 천장 · 대조군일 뿐 목표선이 아니다)
//   ★ⓑ-2 **전이 가능 상한** — 이미지 관측만으로 차량 1대 → 면 1개를 닫았을 때
//   ⓑ-3  21회차가 「도색으로 못 찾는다」고 분류한 **가림 13면 중 회수량**
//   ⓑ-4  사전 반증 F6(반칸 어긋남)·F7(빈 면 0 회수)·F8(차량 자신의 가림)
//
// ══════════════════════════════════════════════════════════════════════════
// ★★ 오염 격리 — 이 파일의 존재 이유 (18회차 `expectedBays` 오염의 재발 방지) ★★
//
//   `unity.car.list` 응답 필드별 취급:
//     · `faceSlot` · `presetId` — **검출 경로 금지.** 「이 차는 몇 번 면에 있다」는 정답지다.
//        (실측으로 **오라클로서도 신뢰 불가**임이 드러났다 — §CAR_LABEL_STALE 주석 참조)
//     · `visible`               — **전면 금지.** Unity 가 준 가림 판정이다. 쓰면 재현율 천장 측정이 무의미해진다.
//     · `pos`(월드 3D)          — **직접 사용 금지.** 실카엔 없다.
//     · `rotY` · `prefabId` 치수 — **강등 후에만 사용.** 현재 프리셋 카메라로 **투영**해
//                                  **이미지 관측**(접지 사각형 / 축정렬 박스 / 번호판 quad)을 만든 뒤
//                                  **그 이미지 관측만** 하류로 넘긴다.
//
//   구조적 보증: `degradeCar()` 가 유일한 경계다. 그 함수의 **반환 타입 `VehicleObservation` 에는
//   월드 좌표도 면 라벨도 없다**(px 뿐). ⓑ-2 파이프라인은 `VehicleObservation` 과 `GroundModel` 만 받는다.
//   오라클은 별도 채널 `OracleTag` 로만 흐르고 **채점에서만** 쓴다(R1).
// ══════════════════════════════════════════════════════════════════════════
//
// ★ 재사용 규약(재발명 금지):
//   · 월드→픽셀 투영: `sceneTruth.projectTruth`(마스터 지시 — `projectTruth` 와 동형이니 재사용).
//     4점 월드 사각형이면 정답 면이든 차량 접지면이든 같은 함수가 처리한다 → **투영 코드 0줄 신규**.
//   · 이미지→지면·지면→이미지: `project.backprojectToGround` / `projectToPixel`(검출기가 쓰는 바로 그 경로).
//   · IoU·매칭 임계: `autoRoiPlan.quadIoU` / `MATCH_MIN_IOU`(신규 IoU 0줄 · R4).
//   · 골든 프레임·씬 정답·프레임해시: `sepAudit.goldenTargets`(21회차 자산).
//   · 규격 치수: `DEFAULT_BAY_OPTS.slotWidthM/slotDepthM`(2.5m·5.0m) — **면 하나를 닫는 데만** 쓴다.
//     격자 복제 없음(`phase + k·w` 없음 · `filledIndices` 없음 · 행 단위 창·점수 없음 = G1~G8).
//
// ★ 가정(추정으로 채운 값이 아니라 **명시된 가정**이며, 골든 프레임 육안 정합으로 검증한다 — §스샷):
//   차량 외형 치수는 Unity RPC 가 노출하지 않는다(`car.get` 도 pos/rotY/prefabId 만 준다).
//   → 아래 `CAR_BODY` 를 가정으로 두고, 투영 박스가 골든 프레임의 실제 차량과 겹치는지 **눈으로 확인**한다.
//
// 사용: npx tsx src/tools/carAnchorUpper.ts [v1|v2|캐시디렉터리] [outDir]
// 정본 `PtzCamRoi.json` · DB · `config/` 무접촉(읽기만). Unity RPC 는 **읽기 1회**(`car.list`). 카메라 이동 0.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { DEFAULT_BAY_OPTS } from '../ground/bayGeometry.js';
import { backprojectToGround, projectToPixel } from '../ground/project.js';
import { canonicalizeQuad } from '../ground/groundGrid.js';
import { MATCH_MIN_IOU, quadIoU } from '../ground/autoRoiPlan.js';
import { projectTruth, quadAreaPx, type TruthFace, type TruthView } from '../ground/sceneTruth.js';
import type { GroundModel, PixelQuad } from '../ground/types.js';
import type { Vec3 } from '../ground/contactTypes.js';
import { goldenTargets, GOLDEN_DIRS, MIN_AREA_PX, PLANE_Y_M, quantiles, type Target } from './sepAudit.js';

// ── 상수 ─────────────────────────────────────────────────────────────────────

const W_M = DEFAULT_BAY_OPTS.slotWidthM; // 2.5 — 시설 규격. 면 하나를 닫는 데만 쓴다.
const D_M = DEFAULT_BAY_OPTS.slotDepthM; // 5.0
const TARGET_PRECISION = 0.7;

/**
 * ★ 가정 — 차량 외형(m). Unity 가 치수를 노출하지 않으므로 승용 세단 표준값을 둔다.
 * `prefabId` 4종(1·2·3·7)이 실측되었으나 종별 치수를 얻을 방법이 없어 **단일 치수**로 간다.
 * → **한계로 명시**한다. 정합은 스샷 육안으로 검증한다.
 */
export const CAR_BODY = { lengthM: 4.7, widthM: 1.85, heightM: 1.45 };

/**
 * ★ 가정 — 번호판(m). 한국 승용 표준 번호판 520×110mm, 장착 높이(판 중심) 0.55m.
 * ⓑ-0 은 이 값에 **선형**이므로 다른 규격은 비례 환산으로 읽으면 된다.
 */
export const PLATE = { widthM: 0.52, heightM: 0.11, mountHM: 0.55 };

/** 이 뷰에서 LPD 가 「원리적으로」 가능하다고 볼 판 폭(px) 하한 — 판정선이 아니라 **읽기 눈금**이다. */
const PLATE_PX_MARKS = [8, 16, 30, 60, 100];

const DEG = Math.PI / 180;

// ── ★ 경계: 강등 어댑터 ──────────────────────────────────────────────────────

/** `unity.car.list` 원시 1행. **이 타입은 어댑터 안에서만 산다.** */
export interface RawCar {
  carNameId: string;
  presetId: number;
  faceSlot: number;
  visible: boolean;
  pos: { x: number; y: number; z: number };
  rotY: number;
  prefabId: number;
}

/**
 * ★ 실카에서 실제로 얻는 형태 — **이미지 공간뿐**. 월드 좌표도 면 라벨도 여기에 없다.
 * 설계서 §R2-3 의 `VehicleObservation` 을 실측용으로 구체화한 것.
 */
export interface VehicleObservation {
  /** 관측 식별자(채점 대조용 — 좌표 정보 없음). */
  obsId: string;
  /** 세그멘테이션이 주는 것 — 이미지 공간 **접지 사각형**(방위 포함). */
  footprintPx: PixelQuad | null;
  /** VPD 가 주는 것 — 차체 전체의 **축정렬 박스**(방위 없음). */
  bboxPx: { x0: number; y0: number; x1: number; y1: number } | null;
  /** LPD 가 주는 것 — 번호판 quad. ⓑ-0 이 「보인다」고 할 때만 의미가 있다. */
  plateQuad: PixelQuad | null;
  /** ⓑ-0 측정량 — 판의 화면상 최대 변 길이(px). */
  platePx: number;
  /** 24회차 추가(타입만) — 검출기가 **주는** 신뢰도. 강등본에는 없다(=undefined → 게이트에서 1 취급). */
  confidence?: number;
  source: 'sim-projected' | 'real-vpd-seg' | 'real-lpd';
}

/** 채점 전용 오라클 태그 — **별도 채널**. 검출 파이프라인 함수는 이 타입을 받지 않는다. */
export interface OracleTag {
  obsId: string;
  /** 월드 좌표에서 기하로 구한 「이 차가 서 있는 면」. `faceSlot` 을 쓰지 않는다(§CAR_LABEL_STALE). */
  faceId: string | null;
  /** 월드 중심(오라클) — ⓑ-1·F6 에서만 쓴다. */
  posWorld: Vec3;
  rotY: number;
}

/** 월드 y=`planeY` 평면 위, 중심 (cx,cz)·방위 rotY(도)·크기 lx×lz 인 사각형의 월드 4점. */
function rectWorld(cx: number, cz: number, rotYDeg: number, lx: number, lz: number, planeY: number): [Vec3, Vec3, Vec3, Vec3] {
  const c = Math.cos(rotYDeg * DEG);
  const s = Math.sin(rotYDeg * DEG);
  // Unity 왼손 좌표: y축 회전 rotY 는 (x,z) 를 (x·c + z·s, −x·s + z·c) 의 역으로 보낸다.
  // 로컬 (u,v) → 월드: x = cx + u·c + v·s , z = cz − u·s + v·c
  const P = (u: number, v: number): Vec3 => [cx + u * c + v * s, planeY, cz - u * s + v * c];
  const hx = lx / 2;
  const hz = lz / 2;
  return [P(-hx, -hz), P(-hx, hz), P(hx, hz), P(hx, -hz)];
}

/** 월드 4점 사각형 → 픽셀 quad. **`projectTruth` 재사용**(투영식 신규 0줄). */
function projectRect(corners: [Vec3, Vec3, Vec3, Vec3], view: TruthView): PixelQuad | null {
  const fake: TruthFace = { rowIdx: 0, faceIdx: 0, cornersWorld: corners };
  const out = projectTruth([fake], view);
  return out.length ? out[0].quad : null;
}

/**
 * ★★ 강등 어댑터 — **오염 격리의 유일한 경계**.
 *
 * 입력: 원시 `car.list` 1행 + 현재 프리셋 카메라.
 * 출력: **이미지 관측만**(px). `faceSlot`·`presetId`·`visible` 은 읽지도 않는다.
 *       `pos`·`rotY`·치수는 **투영에만** 쓰이고 결과에는 남지 않는다.
 */
export function degradeCar(car: RawCar, view: TruthView): VehicleObservation {
  const y = view.planeYM;
  // (1) 접지 사각형 — 세그멘테이션이 주는 것.
  const foot = rectWorld(car.pos.x, car.pos.z, car.rotY, CAR_BODY.widthM, CAR_BODY.lengthM, y);
  const footprintPx = projectRect(foot, view);

  // (2) 차체 상면까지 포함한 축정렬 박스 — VPD 가 주는 것.
  const top = rectWorld(car.pos.x, car.pos.z, car.rotY, CAR_BODY.widthM, CAR_BODY.lengthM, y + CAR_BODY.heightM);
  const topPx = projectRect(top, view);
  let bboxPx: VehicleObservation['bboxPx'] = null;
  if (footprintPx && topPx) {
    const pts = [...footprintPx, ...topPx];
    bboxPx = {
      x0: Math.min(...pts.map((p) => p.x)),
      y0: Math.min(...pts.map((p) => p.y)),
      x1: Math.max(...pts.map((p) => p.x)),
      y1: Math.max(...pts.map((p) => p.y)),
    };
  }

  // (3) 번호판 — 앞/뒤 두 면 각각. 카메라를 향하는 쪽이 더 크게 보인다 → 큰 쪽을 관측으로 삼는다.
  let plateQuad: PixelQuad | null = null;
  let platePx = 0;
  for (const sgn of [1, -1]) {
    const c = Math.cos(car.rotY * DEG);
    const s = Math.sin(car.rotY * DEG);
    // 차 로컬 v축(길이축) 방향 ± 절반 지점에 판이 붙는다. 판은 그 면 위에서 폭축(u)으로 눕는다.
    const v = (sgn * CAR_BODY.lengthM) / 2;
    const px0 = car.pos.x + v * s;
    const pz0 = car.pos.z + v * c;
    const uHat: Vec3 = [c, 0, -s]; // 로컬 u축의 월드 방향
    const hw = PLATE.widthM / 2;
    const hh = PLATE.heightM / 2;
    const yc = y + PLATE.mountHM;
    const corners: [Vec3, Vec3, Vec3, Vec3] = [
      [px0 - uHat[0] * hw, yc - hh, pz0 - uHat[2] * hw],
      [px0 - uHat[0] * hw, yc + hh, pz0 - uHat[2] * hw],
      [px0 + uHat[0] * hw, yc + hh, pz0 + uHat[2] * hw],
      [px0 + uHat[0] * hw, yc - hh, pz0 + uHat[2] * hw],
    ];
    const q = projectRect(corners, view);
    if (!q) continue;
    // 판의 화면상 「폭」 = 가장 긴 변(투영 후 사각형이 기울어도 폭축이 최장변이다 — 실측 확인용으로 둘 다 낸다).
    let maxEdge = 0;
    for (let i = 0; i < 4; i++) maxEdge = Math.max(maxEdge, Math.hypot(q[i].x - q[(i + 1) % 4].x, q[i].y - q[(i + 1) % 4].y));
    if (maxEdge > platePx) {
      platePx = maxEdge;
      plateQuad = q;
    }
  }

  return { obsId: car.carNameId, footprintPx, bboxPx, plateQuad, platePx, source: 'sim-projected' };
}

// ── ★ ⓑ-2 : 전이 가능 경로 (이미지 관측 + GroundModel 만) ────────────────────

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const norm3 = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 | null => {
  const n = norm3(a);
  return n > 1e-9 ? [a[0] / n, a[1] / n, a[2] / n] : null;
};
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** 이미지 접지 사각형 → 지면(카메라 좌표) 4점. 한 점이라도 실패하면 null(부분 사용 금지 — 검출 경로 규약). */
export function footprintToGround(q: PixelQuad, g: GroundModel): [Vec3, Vec3, Vec3, Vec3] | null {
  const out: Vec3[] = [];
  for (const p of q) {
    const X = backprojectToGround(p, g);
    if (!X) return null;
    out.push(X);
  }
  return out as [Vec3, Vec3, Vec3, Vec3];
}

/**
 * 픽셀 → **지면에서 높이 h 인 평행 평면** 위의 점. LPD 경로 전용(판은 지면에 있지 않다).
 * `backprojectToGround` 는 `n·X = d` 를 풀고, 높이 h 평면은 `n·X = d − h` 다 — 같은 식의 상수만 다르다.
 * 정합은 `projectPointAtHeight`(기존 함수) 왕복으로 실행 중 검사한다.
 */
function backprojectToHeightPlane(px: { x: number; y: number }, g: GroundModel, hM: number): Vec3 | null {
  const X0 = backprojectToGround(px, g);
  if (!X0) return null;
  const denom = g.d;
  if (!(denom > 1e-9)) return null;
  const k = (g.d - hM) / g.d;
  return [X0[0] * k, X0[1] * k, X0[2] * k];
}

/** 지면 위 중심 + 길이축 방향 → 규격 2.5×5.0 면 1개(픽셀 quad). **격자 아님 — 차 1대당 1개.** */
export function closeBayAt(center: Vec3, headUnit: Vec3, g: GroundModel): PixelQuad | null {
  const side = unit(cross(g.n as Vec3, headUnit));
  if (!side) return null;
  const pts = [
    add(add(center, mul(side, -W_M / 2)), mul(headUnit, -D_M / 2)),
    add(add(center, mul(side, -W_M / 2)), mul(headUnit, D_M / 2)),
    add(add(center, mul(side, W_M / 2)), mul(headUnit, D_M / 2)),
    add(add(center, mul(side, W_M / 2)), mul(headUnit, -D_M / 2)),
  ].map((X) => projectToPixel(X, g));
  if (pts.some((p) => !p)) return null;
  return canonicalizeQuad(pts as Array<{ x: number; y: number }>);
}

/** 접지 사각형(지면 4점)의 **장축 단위벡터**와 중심. 방위는 여기서만 나온다(오라클 rotY 미사용). */
export function groundAxisOf(G: readonly [Vec3, Vec3, Vec3, Vec3]): { center: Vec3; head: Vec3 } | null {
  const center = mul(G.reduce((s, p) => add(s, p), [0, 0, 0] as Vec3), 1 / 4);
  const eA = mul(add(sub(G[1], G[0]), sub(G[2], G[3])), 0.5);
  const eB = mul(add(sub(G[2], G[1]), sub(G[3], G[0])), 0.5);
  const head = unit(norm3(eA) >= norm3(eB) ? eA : eB);
  return head ? { center, head } : null;
}

/** 산출 1건 — **차량 1대 → 면 1개**. */
export interface ClosedBay {
  obsId: string;
  path: 'seg' | 'vpd' | 'lpd' | 'oracle-world';
  quad: PixelQuad;
  /** 채점 전용. */
  bestIoU: number;
  matchedFaceKey: string | null;
}

/**
 * 정답 면 최대 IoU. **면 키에 프리셋을 접두**한다 — `r1f1` 은 여러 프리셋에 동시에 존재하므로
 * 전역 집계에서 접두 없이 Set 에 넣으면 프리셋 간 충돌로 회수면이 과소 계상된다(실행 1회차에 실제로 발생).
 */
/** 결정론 난수(xorshift32) — 시드 고정. 같은 명령이 같은 값을 낸다(무회귀 규율). */
export function rng(seed: number): () => number {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1; // −1..1 균등
  };
}

/**
 * ★ 관측 오차 주입 — **이 측정의 정직성이 걸린 지점**.
 * 강등 접지사각형은 오라클 제원에서 만든 **완벽한** 사각형이다. 실카의 세그/VPD 는 그렇지 않다.
 * 코너를 σ px 흔들고, 그림자 편의를 흉내내 접지선을 카메라쪽으로 δ px 민다.
 */
export function perturbFootprint(q: PixelQuad, sigmaPx: number, shadowPx: number, r: () => number): PixelQuad | null {
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  const pts = q.map((p) => ({
    x: p.x + r() * sigmaPx,
    // 그림자 편의는 **아래쪽(카메라쪽) 코너만** 더 아래로 민다 — 그림자를 차체로 오인한 형태.
    y: p.y + r() * sigmaPx + (p.y > cy ? shadowPx : 0),
  }));
  return canonicalizeQuad(pts);
}

export function bestIoUOf(quad: PixelQuad, vis: Target['vis'], presetKey: string): { iou: number; key: string | null } {
  let best = 0;
  let key: string | null = null;
  for (const v of vis) {
    const i = quadIoU(quad, v.quad);
    if (i > best) {
      best = i;
      key = `${presetKey}|r${v.face.rowIdx}f${v.face.faceIdx}`;
    }
  }
  return { iou: best, key };
}

/** 화면 안에 실질적으로 있는가 — `visibleTruth` 와 **같은 규칙**(중심 프레임 내부 + 면적 하한). 오라클 `visible` 미사용. */
export function inFrame(q: PixelQuad, W: number, H: number): boolean {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  if (!(cx >= 0 && cy >= 0 && cx < W && cy < H)) return false;
  return quadAreaPx(q) >= MIN_AREA_PX;
}

// ── 씬 정답 면(월드) — ⓑ-1 오라클 배정·F6·F7 전용 ────────────────────────────

export interface WorldFace {
  id: string;
  cx: number;
  cz: number;
  /** 폭축(2.5m)이 x축인가. */
  widthIsX: boolean;
}

export function worldFaces(): WorldFace[] {
  const specs = JSON.parse(readFileSync('_workspace/18_scene_spec.json', 'utf8')) as Array<{
    idx: number;
    faceCount: number;
    offsetPos: [number, number, number];
    xSize: number;
    zSize: number;
  }>;
  const out: WorldFace[] = [];
  for (const s of specs) {
    const rowIsX = s.xSize < s.zSize; // `sceneTruth.facesOfRow` 와 같은 규칙.
    const pitch = rowIsX ? s.xSize : s.zSize;
    for (let i = 0; i < s.faceCount; i++) {
      out.push({
        id: `r${s.idx}f${i + 1}`,
        cx: s.offsetPos[0] + (rowIsX ? pitch * i : 0),
        cz: s.offsetPos[2] + (rowIsX ? 0 : pitch * i),
        widthIsX: rowIsX,
      });
    }
  }
  return out;
}

/**
 * ★ §CAR_LABEL_STALE — `car.list` 의 `presetId`/`faceSlot` 은 **오라클로서도 못 쓴다**.
 * 실측: 23대 중 8대의 라벨이 기하 위치와 불일치(예: `17-15.38.09` 라벨 r1f2 · 실제 r4f1),
 * 4개 면에 라벨 중복, 존재하지 않는 `r2f9` 라벨 1건. 배치 후 이동(`random.*`)에 라벨이 따라오지 않은 것으로 보인다.
 * → 오라클 배정도 **월드 좌표 기하**로 만든다. (그래도 오라클이므로 ⓑ-1 에서만 쓴다.)
 */
export function assignFaceByGeometry(pos: { x: number; z: number }, faces: readonly WorldFace[]): string | null {
  for (const f of faces) {
    const hx = f.widthIsX ? W_M / 2 : D_M / 2;
    const hz = f.widthIsX ? D_M / 2 : W_M / 2;
    if (Math.abs(pos.x - f.cx) <= hx && Math.abs(pos.z - f.cz) <= hz) return f.id;
  }
  return null;
}

// ── 성적 ─────────────────────────────────────────────────────────────────────

export interface Score {
  outputs: number;
  matched: number;
  faces: number;
  truthTotal: number;
  recall: number;
  precision: number;
  ious: number[];
}

export function scoreClosed(closed: readonly ClosedBay[], truthTotal: number): Score {
  const faces = new Set(closed.map((c) => c.matchedFaceKey).filter((v): v is string => v != null));
  const matched = closed.filter((c) => c.matchedFaceKey != null).length;
  return {
    outputs: closed.length,
    matched,
    faces: faces.size,
    truthTotal,
    recall: truthTotal ? faces.size / truthTotal : 0,
    precision: closed.length ? faces.size / closed.length : 0,
    ious: closed.filter((c) => c.matchedFaceKey != null).map((c) => c.bestIoU),
  };
}

// ── 오버레이 ─────────────────────────────────────────────────────────────────

const poly = (q: PixelQuad, stroke: string, width: number, dash = '') =>
  `<polygon points="${q.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="none" stroke="${stroke}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
const rectSvg = (b: { x0: number; y0: number; x1: number; y1: number }, stroke: string, w: number) =>
  `<rect x="${b.x0.toFixed(1)}" y="${b.y0.toFixed(1)}" width="${(b.x1 - b.x0).toFixed(1)}" height="${(b.y1 - b.y0).toFixed(1)}" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-dasharray="6 4"/>`;
const label = (x: number, y: number, t: string, fill: string, size = 18) =>
  `<text x="${x.toFixed(0)}" y="${y.toFixed(0)}" fill="${fill}" font-size="${size}" font-weight="bold" stroke="#000" stroke-width="0.6" paint-order="stroke">${t}</text>`;

interface OverlayIn {
  obs: VehicleObservation[];
  closed: ClosedBay[];
  showBox: boolean;
  showPlate: boolean;
}

async function drawOverlay(t: Target, o: OverlayIn, title: string, subLine: string, outPath: string): Promise<void> {
  const parts: string[] = [];
  // 씬 정답(채점 전용).
  for (const v of t.vis) {
    parts.push(poly(v.quad, '#00e676', 3));
    const cx = (v.quad[0].x + v.quad[1].x + v.quad[2].x + v.quad[3].x) / 4;
    const cy = (v.quad[0].y + v.quad[1].y + v.quad[2].y + v.quad[3].y) / 4;
    parts.push(label(cx - 26, cy, `r${v.face.rowIdx}f${v.face.faceIdx}`, '#00e676', 17));
  }
  // 강등 차량 관측.
  for (const ob of o.obs) {
    if (ob.footprintPx) parts.push(poly(ob.footprintPx, '#ffd54f', 2, '5 3'));
    if (o.showBox && ob.bboxPx) parts.push(rectSvg(ob.bboxPx, '#ff9800', 1.6));
    if (o.showPlate && ob.plateQuad) parts.push(poly(ob.plateQuad, '#e040fb', 2));
  }
  // 닫은 면.
  for (const c of o.closed) parts.push(poly(c.quad, c.matchedFaceKey ? '#00e5ff' : '#ff1744', 2.8));
  parts.push(`<rect x="14" y="14" width="1420" height="150" fill="#000000cc" rx="8"/>`);
  parts.push(label(30, 50, `${title} · ${t.key} · 프레임 ${t.frameHash} · ${t.note}`, '#fff', 23));
  parts.push(label(30, 84, subLine, '#ddd', 19));
  parts.push(
    `<text x="30" y="118" font-size="17" font-weight="bold"><tspan fill="#00e676">━ 씬 정답(채점 전용)</tspan>  <tspan fill="#ffd54f">┄ 강등 접지사각형(seg)</tspan>  <tspan fill="#ff9800">┄ 강등 축정렬박스(vpd)</tspan>  <tspan fill="#e040fb">━ 번호판(lpd)</tspan></text>`,
  );
  parts.push(
    `<text x="30" y="146" font-size="17" font-weight="bold"><tspan fill="#00e5ff">━ 닫은 면 · 정답 매칭(IoU≥${MATCH_MIN_IOU})</tspan>  <tspan fill="#ff1744">━ 닫은 면 · 비매칭</tspan></text>`,
  );
  const svg = `<svg width="${t.W}" height="${t.H}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
  writeFileSync(outPath, await sharp(t.jpg).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer());
}

// ── main ─────────────────────────────────────────────────────────────────────

const f6 = (v: number | undefined | null): string => (v == null || !Number.isFinite(v) ? '--' : v.toFixed(6));
const UNITY_RPC = 'http://localhost:13020/rpc';

export async function carList(): Promise<RawCar[]> {
  const r = await fetch(UNITY_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'unity.car.list', params: {} }),
  });
  const j = (await r.json()) as { result?: { cars?: RawCar[] }; error?: unknown };
  if (j.error || !j.result?.cars) throw new Error(`car.list 실패: ${JSON.stringify(j.error)}`);
  return j.result.cars;
}

/** 프리셋별 `TruthView` — `goldenTargets` 와 **같은 규칙**으로 만든다(정본 읽기만). */
export function viewsOf(targets: readonly Target[]): Map<string, TruthView> {
  const placeJson = JSON.parse(readFileSync('data/Place01/PtzCamRoi.json', 'utf8'));
  const m = new Map<string, TruthView>();
  for (const c of placeJson.cameras) {
    for (const p of c.presets) {
      const key = `${c.camera.cam_id}:${p.preset_idx}`;
      const t = targets.find((x) => x.key === key);
      if (!t) continue;
      m.set(key, {
        camPos: c.camera.position,
        panDeg: p.pan,
        tiltDeg: p.tilt,
        fovDeg: p.fov,
        fovAxis: 'vertical',
        imgW: t.W,
        imgH: t.H,
        planeYM: PLANE_Y_M,
      });
    }
  }
  return m;
}

async function main(): Promise<void> {
  const targetArg = process.argv[2] ?? 'v1';
  const outDir = process.argv[3] ?? 'reports/overlay_r22h';
  mkdirSync(outDir, { recursive: true });

  const cars = await carList();
  const targets = await goldenTargets(GOLDEN_DIRS[targetArg] ?? targetArg);
  const views = viewsOf(targets);
  const wf = worldFaces();

  console.log(
    `22회차 Phase 0 — 「차량앵커 닫기」(안 2) 착수 전 상한 측정\n` +
      `★ 검출 알고리즘 배선 0줄 · src/ground · src/rpc/services · web 무접촉 · Unity RPC 읽기 1회(car.list)\n` +
      `★ 오염 격리: faceSlot·presetId·visible 은 강등 어댑터가 **읽지 않는다**. pos·rotY·치수는 투영에만 쓰이고\n` +
      `   하류로는 **이미지 관측(px)** 만 흐른다. 오라클은 별도 채널이며 ⓑ-1·F6·라벨에서만 쓴다.\n` +
      `★ 가정(명시): 차량 ${CAR_BODY.lengthM}×${CAR_BODY.widthM}×${CAR_BODY.heightM}m · 번호판 ${PLATE.widthM}×${PLATE.heightM}m @${PLATE.mountHM}m\n` +
      `   — Unity 가 치수를 노출하지 않는다(car.get 도 pos/rotY/prefabId 뿐). 정합은 스샷 육안으로 검증.\n` +
      `대상: ${targetArg} · 차량 ${cars.length}대 · 씬 면 ${wf.length}개 · 오버레이: ${outDir}\n`,
  );

  // ── 오라클 배정(채점 전용) + F7 ────────────────────────────────────────────
  const tags = new Map<string, OracleTag>();
  for (const c of cars) {
    tags.set(c.carNameId, {
      obsId: c.carNameId,
      faceId: assignFaceByGeometry(c.pos, wf),
      posWorld: [c.pos.x, c.pos.y, c.pos.z],
      rotY: c.rotY,
    });
  }
  const occupiedFaces = new Set([...tags.values()].map((t) => t.faceId).filter((v): v is string => v != null));
  const labelMismatch = cars.filter((c) => tags.get(c.carNameId)!.faceId !== `r${c.presetId}f${c.faceSlot}`);
  console.log(
    `── 오라클 배정(월드 기하 · faceSlot 미사용) ─────────────────────────\n` +
      `  차량 ${cars.length}대 → 점유 면 ${occupiedFaces.size}개 / 씬 전체 ${wf.length}면\n` +
      `  면 밖에 선 차량 ${cars.filter((c) => tags.get(c.carNameId)!.faceId == null).length}대\n` +
      `  ★ car.list 라벨(presetId·faceSlot)이 기하와 어긋난 차량 ${labelMismatch.length}/${cars.length}대\n` +
      `     → 라벨은 오라클로도 못 쓴다. 예: ${labelMismatch.slice(0, 3).map((c) => `${c.carNameId} 라벨 r${c.presetId}f${c.faceSlot} vs 기하 ${tags.get(c.carNameId)!.faceId ?? '(밖)'}`).join(' · ')}\n` +
      `  씬 전체 빈 면: ${wf.filter((f) => !occupiedFaces.has(f.id)).map((f) => f.id).join(' ') || '없음'}`,
  );

  // ── 프리셋 루프 ────────────────────────────────────────────────────────────
  interface PerTarget {
    t: Target;
    obs: VehicleObservation[];
    tagOf: Map<string, OracleTag>;
    seg: ClosedBay[];
    vpd: ClosedBay[];
    lpd: ClosedBay[];
    ora: ClosedBay[];
    emptyVisible: string[];
    occVisible: string[];
  }
  const per: PerTarget[] = [];
  /** ⓑ-0 원시값 — (프리셋, 차량, 판 px, 거리 m). */
  const plateRows: Array<{ key: string; obsId: string; platePx: number; distM: number }> = [];
  /** F6 원시값 — 닫은 면 중심의 어긋남(m). */
  const f6Rows: Array<{ key: string; obsId: string; faceId: string; dWidthM: number; dDepthM: number; headErrDeg: number }> = [];

  for (const t of targets) {
    const view = views.get(t.key);
    if (!view) continue;
    const visIds = new Set(t.vis.map((v) => `r${v.face.rowIdx}f${v.face.faceIdx}`));

    const obs: VehicleObservation[] = [];
    const tagOf = new Map<string, OracleTag>();
    for (const c of cars) {
      const o = degradeCar(c, view); // ← 오염 격리 경계
      if (!o.footprintPx) continue;
      if (!inFrame(o.footprintPx, t.W, t.H)) continue; // `visible` 미사용 — 기하 가시성만.
      obs.push(o);
      tagOf.set(o.obsId, tags.get(o.obsId)!);
      plateRows.push({
        key: t.key,
        obsId: o.obsId,
        platePx: o.platePx,
        distM: (() => {
          const g = tags.get(o.obsId)!.posWorld;
          return Math.hypot(g[0] - view.camPos[0], g[1] - view.camPos[1], g[2] - view.camPos[2]);
        })(),
      });
    }

    // ★ ⓑ-2 seg 경로 — 이미지 접지사각형만 쓴다.
    const seg: ClosedBay[] = [];
    for (const o of obs) {
      if (!o.footprintPx) continue;
      const G = footprintToGround(o.footprintPx, t.model);
      if (!G) continue;
      const ax = groundAxisOf(G);
      if (!ax) continue;
      const q = closeBayAt(ax.center, ax.head, t.model);
      if (!q || !inFrame(q, t.W, t.H)) continue;
      const m = bestIoUOf(q, t.vis, t.key);
      seg.push({ obsId: o.obsId, path: 'seg', quad: q, bestIoU: m.iou, matchedFaceKey: m.iou >= MATCH_MIN_IOU ? m.key : null });
    }

    // ⓑ-2 vpd 경로 — 축정렬 박스만. **방위가 없다** → 시선의 지면 투영을 길이축으로 가정한다(이미지 유래·오라클 아님).
    const vpd: ClosedBay[] = [];
    for (const o of obs) {
      if (!o.bboxPx) continue;
      const bottom = { x: (o.bboxPx.x0 + o.bboxPx.x1) / 2, y: o.bboxPx.y1 };
      const Xb = backprojectToGround(bottom, t.model);
      if (!Xb) continue;
      // 박스는 방위를 주지 않는다(설계서 §R2-3). 이미지에서 얻을 수 있는 유일한 방위 대용은
      // **시선의 지면 성분** — 카메라 직하점(d·n)에서 접지점으로 멀어지는 방향이다.
      const nn = t.model.n as Vec3;
      const nadir = mul(nn, t.model.d);
      const h = unit(sub(Xb, nadir));
      if (!h) continue;
      // 접지선 중점은 차체의 **카메라쪽 끝**에 가깝다 → 길이축으로 반 대 만큼 밀어 중심을 만든다.
      const center = add(Xb, mul(h, CAR_BODY.lengthM / 2));
      const q = closeBayAt(center, h, t.model);
      if (!q || !inFrame(q, t.W, t.H)) continue;
      const m = bestIoUOf(q, t.vis, t.key);
      vpd.push({ obsId: o.obsId, path: 'vpd', quad: q, bestIoU: m.iou, matchedFaceKey: m.iou >= MATCH_MIN_IOU ? m.key : null });
    }

    // ⓑ-2 lpd 경로 — **번호판 quad 하나만** 쓴다(ⓑ-0 이 「보인다」고 했을 때만 의미가 있다).
    //   판은 지면에 없다 → 장착 높이(PLATE.mountHM) 평행 평면으로 역투영한다. 방위는 vpd 와 같은 시선 성분.
    const lpd: ClosedBay[] = [];
    for (const o of obs) {
      if (!o.plateQuad) continue;
      const pc = {
        x: (o.plateQuad[0].x + o.plateQuad[1].x + o.plateQuad[2].x + o.plateQuad[3].x) / 4,
        y: (o.plateQuad[0].y + o.plateQuad[1].y + o.plateQuad[2].y + o.plateQuad[3].y) / 4,
      };
      const Xp = backprojectToHeightPlane(pc, t.model, PLATE.mountHM);
      if (!Xp) continue;
      // 판 위치를 지면으로 내린 점 = 차체의 판이 붙은 면(앞 또는 뒤).
      const nn = t.model.n as Vec3;
      const Xg = add(Xp, mul(nn, PLATE.mountHM));
      // ★ 방위는 **판 자신에서** 나온다(설계서 §R2-3 「LPD 는 판 quad + 방위를 준다」).
      //   판은 차 폭축으로 가로눕는다 → 판 좌우 끝을 같은 높이 평면으로 역투영하면 그 차이가 폭축이고,
      //   길이축 = n × 폭축. 부호는 **카메라에서 멀어지는 쪽**으로 잡는다(판은 차체 바깥면에 있다).
      //   ★ 코너를 그대로 쓰면 안 된다 — 판 상·하단은 높이가 PLATE.heightM 만큼 다르고, 그 오차는
      //     시선이 완만해 **along-ray 로 크게 증폭**된다(1:1 스샷에서 닫은 면이 30~45° 돌아간 원인).
      //     좌·우 **짧은 변의 중점**을 쓰면 두 점이 같은 높이(장착 높이)라 이 증폭이 사라진다.
      const byX = [...o.plateQuad].sort((a, b) => a.x - b.x);
      const midL = { x: (byX[0].x + byX[1].x) / 2, y: (byX[0].y + byX[1].y) / 2 };
      const midR = { x: (byX[2].x + byX[3].x) / 2, y: (byX[2].y + byX[3].y) / 2 };
      const eL = backprojectToHeightPlane(midL, t.model, PLATE.mountHM);
      const eR = backprojectToHeightPlane(midR, t.model, PLATE.mountHM);
      const wAxis = eL && eR ? unit(sub(eR, eL)) : null;
      const radial = unit(sub(Xg, mul(nn, t.model.d)));
      let h = wAxis ? unit(cross(nn, wAxis)) : radial;
      if (h && radial && h[0] * radial[0] + h[1] * radial[1] + h[2] * radial[2] < 0) h = mul(h, -1);
      if (!h) continue;
      const center = add(Xg, mul(h, CAR_BODY.lengthM / 2));
      const q = closeBayAt(center, h, t.model);
      if (!q || !inFrame(q, t.W, t.H)) continue;
      const m = bestIoUOf(q, t.vis, t.key);
      lpd.push({ obsId: o.obsId, path: 'lpd', quad: q, bestIoU: m.iou, matchedFaceKey: m.iou >= MATCH_MIN_IOU ? m.key : null });
    }

    // ⓑ-1b 오라클(월드) 경로 — 월드 pos·rotY 로 바로 닫는다. 이미지·GroundModel 을 거치지 않는다.
    const ora: ClosedBay[] = [];
    for (const o of obs) {
      const tag = tagOf.get(o.obsId)!;
      const q = projectRect(rectWorld(tag.posWorld[0], tag.posWorld[2], tag.rotY, W_M, D_M, view.planeYM), view);
      if (!q || !inFrame(q, t.W, t.H)) continue;
      const m = bestIoUOf(q, t.vis, t.key);
      ora.push({ obsId: o.obsId, path: 'oracle-world', quad: q, bestIoU: m.iou, matchedFaceKey: m.iou >= MATCH_MIN_IOU ? m.key : null });
      // F6 — 닫은 면 중심이 정답 면 중심에서 얼마나 밀렸는가(월드 m).
      const fid = tag.faceId;
      const face = fid ? wf.find((f) => f.id === fid) : undefined;
      if (face && visIds.has(face.id)) {
        const dx = tag.posWorld[0] - face.cx;
        const dz = tag.posWorld[2] - face.cz;
        // 정답 면의 방위: widthIsX 면 폭축=x·깊이축=z. 차량 rotY 기준 정면 방위와의 차이도 낸다.
        const expectRot = face.widthIsX ? 0 : 90;
        let dRot = ((tag.rotY - expectRot) % 180 + 180) % 180;
        if (dRot > 90) dRot -= 180;
        f6Rows.push({
          key: t.key,
          obsId: o.obsId,
          faceId: face.id,
          dWidthM: face.widthIsX ? dx : dz,
          dDepthM: face.widthIsX ? dz : dx,
          headErrDeg: dRot,
        });
      }
    }

    const occVisible = [...visIds].filter((id) => occupiedFaces.has(id)).sort();
    const emptyVisible = [...visIds].filter((id) => !occupiedFaces.has(id)).sort();
    per.push({ t, obs, tagOf, seg, vpd, lpd, ora, emptyVisible, occVisible });

    console.log(
      `\n=== ${t.key}  프레임 ${t.frameHash}  ${t.note}\n` +
        `    씬가시 ${t.vis.length}면 (차량 있음 ${occVisible.length} · 빈 면 ${emptyVisible.length}${emptyVisible.length ? ' [' + emptyVisible.join(' ') + ']' : ''})\n` +
        `    화면 안 차량 관측 ${obs.length}대 (visible 필드 미사용 · 접지사각형 중심 프레임 내부 + 면적≥${MIN_AREA_PX}px²)\n` +
        `    seg 닫기 ${seg.length}개 → 회수면 ${new Set(seg.map((c) => c.matchedFaceKey).filter(Boolean)).size} · ` +
        `vpd ${vpd.length}개 → ${new Set(vpd.map((c) => c.matchedFaceKey).filter(Boolean)).size} · ` +
        `lpd ${lpd.length}개 → ${new Set(lpd.map((c) => c.matchedFaceKey).filter(Boolean)).size} · ` +
        `oracle-world ${ora.length}개 → ${new Set(ora.map((c) => c.matchedFaceKey).filter(Boolean)).size}`,
    );
  }

  const truthTotal = per.reduce((s, p) => s + p.t.vis.length, 0);

  // ═══ ⓑ-0 ═════════════════════════════════════════════════════════════════
  console.log(`\n═══ ⓑ-0 번호판 px 크기 — LPD 경로의 전제(설계서 F9) ═══`);
  console.log(`  판 규격 ${PLATE.widthM}×${PLATE.heightM}m · 장착 높이 ${PLATE.mountHM}m · 값은 **화면상 최장변(px)**`);
  console.log(`   프리셋  n   min       median    p90       max       거리 median(m)`);
  for (const p of per) {
    const rows = plateRows.filter((r) => r.key === p.t.key);
    const v = rows.map((r) => r.platePx).sort((a, b) => a - b);
    const q = quantiles(v);
    const d = quantiles(rows.map((r) => r.distM).sort((a, b) => a - b));
    console.log(
      `   ${p.t.key.padEnd(6)} ${String(v.length).padStart(2)}  ${f6(v[0])}  ${f6(q?.median)}  ${f6(q?.p90)}  ${f6(q?.max)}  ${f6(d?.median)}`,
    );
  }
  const allPlate = plateRows.map((r) => r.platePx).sort((a, b) => a - b);
  const qp = quantiles(allPlate);
  console.log(
    `   전체   ${String(allPlate.length).padStart(2)}  ${f6(allPlate[0])}  ${f6(qp?.median)}  ${f6(qp?.p90)}  ${f6(qp?.max)}\n` +
      `  분포 눈금: ${PLATE_PX_MARKS.map((m) => `≥${m}px ${allPlate.filter((v) => v >= m).length}/${allPlate.length}`).join(' · ')}`,
  );

  // ═══ ⓑ-1 / ⓑ-2 ═══════════════════════════════════════════════════════════
  const segAll = per.flatMap((p) => p.seg);
  const vpdAll = per.flatMap((p) => p.vpd);
  const lpdAll = per.flatMap((p) => p.lpd);
  const oraAll = per.flatMap((p) => p.ora);

  // ⓑ-1a — 오라클 배정 그 자체(면 라벨을 그대로 산출로 삼는다). 도달 불가 천장.
  const oraAssignFaces = new Set<string>();
  let oraAssignOutputs = 0;
  for (const p of per) {
    const visIds = new Set(p.t.vis.map((v) => `r${v.face.rowIdx}f${v.face.faceIdx}`));
    const hit = new Set<string>();
    for (const o of p.obs) {
      const fid = p.tagOf.get(o.obsId)?.faceId;
      oraAssignOutputs++;
      if (fid && visIds.has(fid)) hit.add(`${p.t.key}|${fid}`);
    }
    for (const h of hit) oraAssignFaces.add(h);
  }
  console.log(
    `\n═══ ⓑ-1 오라클 상한 (도달 불가 천장 — **목표선이 아니다**) ═══\n` +
      `  ⓑ-1a 면 라벨 직접 배정(faceSlot 대신 월드 기하): 산출 ${oraAssignOutputs} · 회수면 ${oraAssignFaces.size}/${truthTotal}\n` +
      `        재현율 ${oraAssignFaces.size / truthTotal} · 정밀도 ${oraAssignFaces.size / oraAssignOutputs}`,
  );
  const sOra = scoreClosed(oraAll, truthTotal);
  console.log(
    `  ⓑ-1b 월드 pos·rotY 로 규격 닫기(이미지·GroundModel 미경유):\n` +
      `        산출 ${sOra.outputs} · 회수면 ${sOra.faces}/${truthTotal} · 재현율 ${sOra.recall} · 정밀도 ${sOra.precision}\n` +
      `        매칭 IoU 평균 ${sOra.ious.length ? sOra.ious.reduce((a, b) => a + b, 0) / sOra.ious.length : '--'}`,
  );

  const sSeg = scoreClosed(segAll, truthTotal);
  const sVpd = scoreClosed(vpdAll, truthTotal);
  const sLpd = scoreClosed(lpdAll, truthTotal);
  console.log(
    `\n═══ ★ ⓑ-2 전이 가능 상한 (이미지 관측 + GroundModel 만) ═══\n` +
      `  ★ seg 경로(접지 사각형 — 방위 포함): 산출 ${sSeg.outputs} · 회수면 ${sSeg.faces}/${truthTotal}\n` +
      `        재현율 ${sSeg.recall} · 정밀도 ${sSeg.precision}\n` +
      `        매칭 IoU 평균 ${sSeg.ious.length ? sSeg.ious.reduce((a, b) => a + b, 0) / sSeg.ious.length : '--'} · 최소 ${sSeg.ious.length ? Math.min(...sSeg.ious) : '--'}\n` +
      `    vpd 경로(축정렬 박스 — 방위 없음): 산출 ${sVpd.outputs} · 회수면 ${sVpd.faces}/${truthTotal}\n` +
      `        재현율 ${sVpd.recall} · 정밀도 ${sVpd.precision}\n` +
      `    lpd 경로(번호판 quad 1개만 — ⓑ-0 이 「보인다」고 했을 때만 의미): 산출 ${sLpd.outputs} · 회수면 ${sLpd.faces}/${truthTotal}\n` +
      `        재현율 ${sLpd.recall} · 정밀도 ${sLpd.precision}`,
  );
  console.log(`\n  프리셋별(프레임해시 병기 — F13):`);
  console.log(`   대상  프레임해시    가시면 관측 seg산출 seg회수 재현율                정밀도                oracle회수`);
  for (const p of per) {
    const s = scoreClosed(p.seg, p.t.vis.length);
    const o = scoreClosed(p.ora, p.t.vis.length);
    console.log(
      `   ${p.t.key.padEnd(5)} ${p.t.frameHash} ${String(p.t.vis.length).padStart(6)} ${String(p.obs.length).padStart(4)} ` +
        `${String(s.outputs).padStart(7)} ${String(s.faces).padStart(7)} ${String(s.recall).padEnd(21)} ${String(s.precision).padEnd(21)} ${o.faces}`,
    );
  }

  // ═══ ★ ⓑ-2b 관측 오차 민감도 ═════════════════════════════════════════════
  // ★ 위의 ⓑ-2 는 **완벽한 접지 사각형**을 가정한 값이다. 실카 세그/VPD 는 코너 오차와
  //   그림자 편의를 갖는다. 「전이 가능한가」의 진짜 답은 **오차 내성**에 있다.
  console.log(
    `\n═══ ★ ⓑ-2b 관측 오차 민감도 (전이 가능성의 실제 시험) ═══\n` +
      `  σ = 접지사각형 코너 좌표 오차(px, 균등 ±σ) · 그림자 = 아래쪽 코너를 카메라쪽으로 미는 양(px)\n` +
      `  시드 5개 결정론(xorshift32) · 분모 ${truthTotal}면 · 원시 배정도(평균)\n` +
      `    σpx  그림자px   재현율(평균)          정밀도(평균)          재현율 min~max`,
  );
  const NOISE_CASES: Array<[number, number]> = [
    [0, 0], [2, 0], [5, 0], [10, 0], [20, 0], [40, 0],
    [0, 5], [0, 15], [0, 30], [0, 60],
    [10, 15], [20, 30],
  ];
  for (const [sig, shadow] of NOISE_CASES) {
    const recalls: number[] = [];
    const precs: number[] = [];
    for (let seed = 1; seed <= 5; seed++) {
      const r = rng(seed * 7919 + sig * 31 + shadow);
      const closed: ClosedBay[] = [];
      for (const p of per) {
        for (const o of p.obs) {
          if (!o.footprintPx) continue;
          const fp = sig === 0 && shadow === 0 ? o.footprintPx : perturbFootprint(o.footprintPx, sig, shadow, r);
          if (!fp) continue;
          const G = footprintToGround(fp, p.t.model);
          if (!G) continue;
          const ax = groundAxisOf(G);
          if (!ax) continue;
          const q = closeBayAt(ax.center, ax.head, p.t.model);
          if (!q || !inFrame(q, p.t.W, p.t.H)) continue;
          const m = bestIoUOf(q, p.t.vis, p.t.key);
          closed.push({ obsId: o.obsId, path: 'seg', quad: q, bestIoU: m.iou, matchedFaceKey: m.iou >= MATCH_MIN_IOU ? m.key : null });
        }
      }
      const s = scoreClosed(closed, truthTotal);
      recalls.push(s.recall);
      precs.push(s.precision);
    }
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    console.log(
      `   ${String(sig).padStart(5)} ${String(shadow).padStart(8)}   ${String(mean(recalls)).padEnd(21)} ${String(mean(precs)).padEnd(21)} ${Math.min(...recalls)}~${Math.max(...recalls)}`,
    );
  }

  // ── lpd 오차 민감도 — 판은 작다(median 61px). 코너 오차가 방위로 증폭되는 정도를 잰다.
  console.log(
    `\n  ── lpd 경로 오차 민감도 (판 quad 코너 σ px · 시드 5개)\n` +
      `     ★ 위 1:1 스샷이 알려준 것: 판 좌우 끝의 **높이 오차**가 along-ray 로 증폭돼 방위를 30~45° 돌린다.\n` +
      `       아래는 그 증폭이 σ 몇 px 에서 시작되는가다.\n` +
      `     σpx    재현율(평균)          정밀도(평균)          재현율 min~max`,
  );
  for (const sig of [0, 0.5, 1, 2, 4, 8]) {
    const recalls: number[] = [];
    const precs: number[] = [];
    for (let seed = 1; seed <= 5; seed++) {
      const r = rng(seed * 104729 + Math.round(sig * 100));
      const closed: ClosedBay[] = [];
      for (const p of per) {
        for (const o of p.obs) {
          if (!o.plateQuad) continue;
          const pq = sig === 0 ? o.plateQuad : canonicalizeQuad(o.plateQuad.map((q) => ({ x: q.x + r() * sig, y: q.y + r() * sig })));
          if (!pq) continue;
          const pc = { x: (pq[0].x + pq[1].x + pq[2].x + pq[3].x) / 4, y: (pq[0].y + pq[1].y + pq[2].y + pq[3].y) / 4 };
          const Xp = backprojectToHeightPlane(pc, p.t.model, PLATE.mountHM);
          if (!Xp) continue;
          const nn = p.t.model.n as Vec3;
          const Xg = add(Xp, mul(nn, PLATE.mountHM));
          const byX = [...pq].sort((a, b) => a.x - b.x);
          const eL = backprojectToHeightPlane({ x: (byX[0].x + byX[1].x) / 2, y: (byX[0].y + byX[1].y) / 2 }, p.t.model, PLATE.mountHM);
          const eR = backprojectToHeightPlane({ x: (byX[2].x + byX[3].x) / 2, y: (byX[2].y + byX[3].y) / 2 }, p.t.model, PLATE.mountHM);
          const wAxis = eL && eR ? unit(sub(eR, eL)) : null;
          const radial = unit(sub(Xg, mul(nn, p.t.model.d)));
          let h = wAxis ? unit(cross(nn, wAxis)) : radial;
          if (h && radial && h[0] * radial[0] + h[1] * radial[1] + h[2] * radial[2] < 0) h = mul(h, -1);
          if (!h) continue;
          const q = closeBayAt(add(Xg, mul(h, CAR_BODY.lengthM / 2)), h, p.t.model);
          if (!q || !inFrame(q, p.t.W, p.t.H)) continue;
          const m = bestIoUOf(q, p.t.vis, p.t.key);
          closed.push({ obsId: o.obsId, path: 'lpd', quad: q, bestIoU: m.iou, matchedFaceKey: m.iou >= MATCH_MIN_IOU ? m.key : null });
        }
      }
      const s = scoreClosed(closed, truthTotal);
      recalls.push(s.recall);
      precs.push(s.precision);
    }
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    console.log(
      `     ${String(sig).padStart(4)}   ${String(mean(recalls)).padEnd(21)} ${String(mean(precs)).padEnd(21)} ${Math.min(...recalls)}~${Math.max(...recalls)}`,
    );
  }

  // ═══ ⓑ-3 ═════════════════════════════════════════════════════════════════
  // 21회차 면별 표에서 「미검출 + 도색지지 없음」으로 분류된 13면(가림면). 하드코딩이 아니라
  // `roiAutoRecall` 산출과 **면 id 로 직접 대조**할 수 있게 목록을 값으로 둔다(재현 명령은 문서에).
  const OCCLUDED_13: Array<[string, string]> = [
    ['1:1', 'r4f1'], ['1:1', 'r4f2'], ['1:1', 'r4f3'],
    ['1:2', 'r4f2'], ['1:2', 'r4f3'], ['1:2', 'r4f4'],
    ['1:3', 'r5f1'], ['1:3', 'r5f2'],
    ['2:1', 'r4f4'],
    ['2:2', 'r3f2'], ['2:2', 'r3f3'], ['2:2', 'r3f4'], ['2:2', 'r4f1'],
  ];
  const recoveredSeg = new Set<string>();
  for (const p of per) for (const c of p.seg) if (c.matchedFaceKey) recoveredSeg.add(c.matchedFaceKey);
  const recoveredOra = new Set<string>();
  for (const p of per) for (const c of p.ora) if (c.matchedFaceKey) recoveredOra.add(c.matchedFaceKey);

  console.log(
    `\n═══ ★ ⓑ-3 가림 13면 회수량 (21회차 「미검출 + 도색지지 없음」 면과 면 id 직접 대조) ═══\n` +
      `   프리셋 면ID   차량있음  seg회수  oracle회수`,
  );
  let recSeg13 = 0;
  let recOra13 = 0;
  for (const [key, fid] of OCCLUDED_13) {
    const hasCar = occupiedFaces.has(fid);
    const s = recoveredSeg.has(`${key}|${fid}`);
    const o = recoveredOra.has(`${key}|${fid}`);
    if (s) recSeg13++;
    if (o) recOra13++;
    console.log(`   ${key.padEnd(6)} ${fid.padEnd(6)} ${hasCar ? '   O   ' : '   X   '}  ${s ? '   O   ' : '   X   '}  ${o ? '   O   ' : '   X   '}`);
  }
  console.log(
    `  ★ 가림 13면 중 seg 회수 ${recSeg13}/13 = ${recSeg13 / 13} · oracle 회수 ${recOra13}/13 = ${recOra13 / 13}\n` +
      `  ★ 이 회수량이 21회차 도색 천장 28/41 = ${28 / 41} 을 넘는 양이다 → 도색+차량 합집합 상한 ${(28 + recSeg13) / 41} (28+${recSeg13})/41`,
  );

  // ═══ ⓑ-4 ═════════════════════════════════════════════════════════════════
  console.log(`\n═══ ⓑ-4 사전 반증 (F6·F7·F8) ═══`);
  const dw = f6Rows.map((r) => Math.abs(r.dWidthM)).sort((a, b) => a - b);
  const dd = f6Rows.map((r) => Math.abs(r.dDepthM)).sort((a, b) => a - b);
  const dh = f6Rows.map((r) => Math.abs(r.headErrDeg)).sort((a, b) => a - b);
  const qw = quantiles(dw);
  const qd = quantiles(dd);
  const qh = quantiles(dh);
  console.log(
    `  ★ F6 반칸 어긋남 — 차량 중심이 정답 면 중심에서 얼마나 밀렸는가(월드 m · 표본 ${f6Rows.length})\n` +
      `     폭축 |Δ|   median ${f6(qw?.median)} · p90 ${f6(qw?.p90)} · max ${f6(qw?.max)}   (반칸 = ${W_M / 2}m)\n` +
      `     깊이축|Δ|  median ${f6(qd?.median)} · p90 ${f6(qd?.p90)} · max ${f6(qd?.max)}   (반칸 = ${D_M / 2}m)\n` +
      `     방위 오차  median ${f6(qh?.median)}° · p90 ${f6(qh?.p90)}° · max ${f6(qh?.max)}°\n` +
      `     폭축 |Δ| ≥ 반칸(${W_M / 2}m) 인 표본 ${dw.filter((v) => v >= W_M / 2).length}/${dw.length} · ≥ 1/4칸(${W_M / 4}m) ${dw.filter((v) => v >= W_M / 4).length}/${dw.length}`,
  );
  const emptyAll = per.flatMap((p) => p.emptyVisible.map((f) => `${p.t.key}|${f}`));
  console.log(
    `  ★ F7 빈 면 — 골든 가시 ${truthTotal}면 중 차량이 없는 면 ${emptyAll.length}개 [${emptyAll.join(' ') || '없음'}]\n` +
      `     → 안 2 단독의 **재현율 원리적 상한** = ${(truthTotal - emptyAll.length) / truthTotal} (${truthTotal - emptyAll.length}/${truthTotal})`,
  );
  // F8 — 차량 자신이 다른 차량에 가려지는가. 강등 박스끼리의 깊이 정렬 겹침으로만 잰다(오라클 visible 미사용).
  console.log(`  ★ F8 차량 자신의 가림 — 강등 접지사각형끼리의 겹침(오라클 visible 미사용)`);
  for (const p of per) {
    let occl = 0;
    for (const a of p.obs) {
      if (!a.footprintPx) continue;
      for (const b of p.obs) {
        if (a.obsId === b.obsId || !b.footprintPx) continue;
        if (quadIoU(a.footprintPx, b.footprintPx) > 0.1) {
          occl++;
          break;
        }
      }
    }
    console.log(`     ${p.t.key.padEnd(5)} 관측 ${p.obs.length}대 중 다른 차와 접지영역 IoU>0.1 인 대수 ${occl}`);
  }

  // ═══ 스샷 ════════════════════════════════════════════════════════════════
  console.log(`\n═══ 오버레이 (같은 골든 프레임 · 같은 frameHash 위 — F13) ═══`);
  for (const p of per) {
    const a = join(outDir, `car_obs_${p.t.key.replace(':', '_')}.png`);
    await drawOverlay(
      p.t,
      { obs: p.obs, closed: [], showBox: true, showPlate: true },
      '강등 차량 관측(정합 검증)',
      `관측 ${p.obs.length}대 · 접지사각형/축정렬박스/번호판 · 판 최장변 median ${f6(quantiles(plateRows.filter((r) => r.key === p.t.key).map((r) => r.platePx).sort((x, y) => x - y))?.median)}px`,
      a,
    );
    const b = join(outDir, `car_close_seg_${p.t.key.replace(':', '_')}.png`);
    const sS = scoreClosed(p.seg, p.t.vis.length);
    await drawOverlay(
      p.t,
      { obs: p.obs, closed: p.seg, showBox: false, showPlate: false },
      '★ ⓑ-2 seg 닫기',
      `산출 ${sS.outputs} · 회수 ${sS.faces}/${p.t.vis.length} · 재현율 ${f6(sS.recall)} · 정밀도 ${f6(sS.precision)}`,
      b,
    );
    const c = join(outDir, `car_close_vpd_${p.t.key.replace(':', '_')}.png`);
    const sV = scoreClosed(p.vpd, p.t.vis.length);
    await drawOverlay(
      p.t,
      { obs: p.obs, closed: p.vpd, showBox: true, showPlate: false },
      'ⓑ-2 vpd 닫기(방위 없음)',
      `산출 ${sV.outputs} · 회수 ${sV.faces}/${p.t.vis.length} · 재현율 ${f6(sV.recall)} · 정밀도 ${f6(sV.precision)}`,
      c,
    );
    const dpath = join(outDir, `car_close_lpd_${p.t.key.replace(':', '_')}.png`);
    const sL = scoreClosed(p.lpd, p.t.vis.length);
    await drawOverlay(
      p.t,
      { obs: p.obs, closed: p.lpd, showBox: false, showPlate: true },
      'ⓑ-2 lpd 닫기(번호판만)',
      `산출 ${sL.outputs} · 회수 ${sL.faces}/${p.t.vis.length} · 재현율 ${f6(sL.recall)} · 정밀도 ${f6(sL.precision)}`,
      dpath,
    );
    console.log(`   ${p.t.key} → ${a} , ${b} , ${c} , ${dpath}`);
  }

  console.log(
    `\n※ 한계(추정으로 채우지 않는다):\n` +
      `  · 차량 외형·번호판 치수는 **가정**이다(Unity 미노출). prefabId 4종의 종별 치수는 미측정.\n` +
      `  · 실카 3장(etc/test)에서는 재현율 분모를 만들 수 없다(preset.list 부재) — 미측정 이월.\n` +
      `  · 세그멘테이션 실제 성능(그림자 분리·오검출)은 재지 않았다. seg 경로는 **완전한 접지 사각형**을 가정한 천장이다.\n` +
      `  · 목표 정밀도 ${TARGET_PRECISION} 은 안 2 단독 기준으로 판정한다(합집합 기준은 설계자 R2-8-3 미결).\n` +
      `  · 라벨(IoU≥${MATCH_MIN_IOU})·오라클은 채점 전용 — 관측 생성·닫기 어디에도 들어가지 않는다(R1).`,
  );
}

if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) await main();
