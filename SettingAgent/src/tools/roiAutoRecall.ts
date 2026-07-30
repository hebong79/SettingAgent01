// ★ 18회차 신규 — **재현율 · 정밀도 · 매칭 면 IoU 3분리** 실측 도구.
//
// ══════════════════════════════════════════════════════════════════════════
// ★ 한계 고지(로그 첫 줄에도 박는다): 이 채점기는 **시뮬 전용**이다.
//   분모(씬 진값)를 Unity `preset.list` 에서 얻는데 **실카에는 그런 것이 없다.**
//   실카의 정답은 사람이 그린 정본뿐이고 그것도 "보이는 모든 면"이 아니다.
//   → 실카에서 재현율은 **측정할 수 없다**(미측정이며, 추정으로 채우지 않는다).
// ══════════════════════════════════════════════════════════════════════════
//
// 정본·DB 무접촉(읽기만). Unity 는 **읽기 메서드만** 쓴다(`preset.list`·`cam.list`).
//   ★ `roi.create2d` 를 부르지 마라 — 이름과 달리 **쓰기 메서드**이며 빌드 출력에 손상본을 기록한다(F17).
//
// 사용: npx tsx src/tools/roiAutoRecall.ts [frames] [rowExtentMode] [rowMode] [--raw]
//   frames        v1(기본) | v2 | 캐시 디렉터리
//   rowExtentMode evidence(기본) | expected
//   rowMode       best(기본) | rows   — rows 는 다중 행 합집합
//   --raw         ★ 21회차 Phase 0-a — IoU 를 **반올림 없이**(원시 배정도) 덤프한다.
//                 기존 출력은 `toFixed(5)` 라 5e-6 미만 변화를 못 잡는다(QA 지적) — 「무회귀는 원시
//                 배정도로」 규율의 구멍이었다. 재현율·정밀도는 정수비(24/41·24/28)라 안전하다.
//
// ★ 21회차 Phase 0-a2 — **면별 재현율 표**(마스터 요구 "각각 주차면 재현율도 표시해줘").
//   씬 정답 가시 면 전수를 한 줄씩 낸다: 면ID·프리셋·검출 O/X·매칭 IoU(raw)·매칭 quad·면적·프레임해시.
// ★ 21회차 Phase 0-c — **보간 기여 실측**: `filledIndices` 유래 quad 가 정답과 매칭된 수.
//
// 씬 제원은 `_workspace/18_scene_spec.json` 에 캐시한다(없으면 Unity 에서 1회 조회).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  DEFAULT_PAINT_OPTIONS,
  detectPaintLines,
  meetLines,
  paintEvidenceOf,
  refineSeparators,
  scanSeparators,
  type FrameGray,
} from '../ground/floorPaint.js';
import { DEFAULT_BAY_OPTS, quadPaintSupport, type BayDetectOpts } from '../ground/bayGeometry.js';
import { detectBaysWithModel, type RowCandidate } from '../ground/bayGrid.js';
import { groundModelFromIntrinsics } from '../ground/cameraIntrinsics.js';
import { placeMetaProvider, readPlaceMeta } from '../ground/placeMetaIntrinsics.js';
import { facesOfRow, projectTruth, visibleTruth, type ScenePresetSpec } from '../ground/sceneTruth.js';
import { scoreDetection, sumScores, type DetectionScore, type TruthEntry } from '../ground/roiAutoRecall.js';
import { MATCH_MIN_IOU } from '../ground/autoRoiPlan.js';
import { normalizePtzCamRoi } from '../capture/placeRoi.js';
import { scorePreset } from '../ground/roiAutoScore.js';
import { quadAreaPx } from '../ground/sceneTruth.js';
import type { PixelQuad } from '../ground/types.js';

const GOLDEN_DIRS: Record<string, string> = {
  v1: 'test/fixtures/roiAutoGolden',
  v2: 'test/fixtures/roiAutoGolden_v2',
};
// 위치 인자와 플래그를 분리한다(플래그는 어느 자리에 와도 된다).
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));
/** ★ Phase 0-a — 원시 배정도 덤프. `toFixed` 로 무회귀를 판정하지 않기 위한 스위치. */
const RAW = flags.has('--raw');
/**
 * ★ 21회차 ② — 커버리지를 **위상 불변**(면수 미사용) 척도로 돌린다 = 뷰어에서 「예상 주차면 수」를
 * 비운 경로와 같은 식. 기본(플래그 없음)은 종전 식이며 골든 기준선이 그쪽에서 나온다.
 */
const PHASE_INVARIANT = flags.has('--phase-invariant');
const framesArg = positional[0] ?? 'v1';
const cacheDir = GOLDEN_DIRS[framesArg] ?? framesArg;
const rowExtentMode = (positional[1] ?? 'evidence') as 'evidence' | 'expected';
const rowMode = (positional[2] ?? 'best') as 'best' | 'rows';
if (rowExtentMode !== 'evidence' && rowExtentMode !== 'expected') throw new Error(`rowExtentMode: ${rowExtentMode}`);
if (rowMode !== 'best' && rowMode !== 'rows') throw new Error(`rowMode: ${rowMode}`);
for (const f of flags) if (f !== '--raw' && f !== '--phase-invariant') throw new Error(`알 수 없는 플래그: ${f}`);

/** ★ 광학중심↔주차면 평면 거리 4.950m 의 표현(F6). `cam.list` 의 pos.y=5.0 은 트랜스폼 원점이다. */
const PLANE_Y_M = 0.05;
/** 가시 판정 면적 하한(px²). 지평선 근처의 극세·거대 quad 를 자른다. 값의 근거는 §산출 분포 참조. */
const MIN_AREA_PX = 200;

const RPC = 'http://localhost:13110/rpc';
let rpcId = 0;
async function rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const j = (await r.json()) as any;
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

const SPEC_CACHE = '_workspace/18_scene_spec.json';
async function sceneSpecs(): Promise<ScenePresetSpec[]> {
  if (existsSync(SPEC_CACHE)) return JSON.parse(readFileSync(SPEC_CACHE, 'utf8')) as ScenePresetSpec[];
  const raw = (await rpc('preset.list')) as Array<{
    idx: number;
    faceCount: number;
    offsetPos: { x: number; y: number; z: number };
    xSize: number;
    zSize: number;
    faceRot: number;
    groupRot: number;
  }>;
  const specs: ScenePresetSpec[] = raw.map((r) => ({
    idx: r.idx,
    faceCount: r.faceCount,
    offsetPos: [r.offsetPos.x, r.offsetPos.y, r.offsetPos.z],
    xSize: r.xSize,
    zSize: r.zSize,
    faceRot: r.faceRot,
    groupRot: r.groupRot,
  }));
  writeFileSync(SPEC_CACHE, JSON.stringify(specs, null, 2));
  return specs;
}

const specs = await sceneSpecs();
const faces = specs.flatMap((s) => facesOfRow(s, PLANE_Y_M) ?? []);
const unsupported = specs.filter((s) => facesOfRow(s, PLANE_Y_M) == null);

const placeJson = JSON.parse(readFileSync('data/Place01/PtzCamRoi.json', 'utf8'));
const { byPreset } = normalizePtzCamRoi(placeJson);
const intrinsics = placeMetaProvider(readPlaceMeta(placeJson));

console.log(
  '18회차 채점 3분리 — 재현율 / 정밀도 / 매칭 면 IoU\n' +
    '★ 시뮬 전용: 분모는 Unity 씬 진값이다. 실카에는 preset.list 가 없어 재현율을 측정할 수 없다.\n' +
    `프레임: ${cacheDir} · rowExtentMode=${rowExtentMode} · rowMode=${rowMode} · ` +
    `coverageDenom=${PHASE_INVARIANT ? 'phaseInvariant(면수 미사용)' : 'expectedBays(종전·골든 기준선)'}\n` +
    `씬 복원: ${specs.length}행 ${faces.length}면 (미지원 행 ${unsupported.length}건${unsupported.length ? ': ' + unsupported.map((s) => `idx${s.idx}`).join(',') : ''})\n` +
    `가시 기준: quad 중심 프레임 내부 + 면적 ≥ ${MIN_AREA_PX}px² · 매칭 임계 IoU ≥ ${MATCH_MIN_IOU} · 평면 y=${PLANE_Y_M}m\n`,
);

const scores: DetectionScore[] = [];
const manualRows: string[] = [];

/** ★ Phase 0-a2 — 면별 재현율 표의 한 줄. */
interface FaceRow {
  key: string;
  frameHash: string;
  faceId: string;
  detected: boolean;
  /** 원시 배정도 IoU(반올림 금지). 미검출 → null. */
  iou: number | null;
  /** 매칭된 산출 quad 의 식별자(행·격자칸). */
  detId: string | null;
  /** 그 quad 가 **보간 유래**인가(Phase 0-c). */
  fromInterp: boolean;
  areaPx: number;
  /** 근변 도색 지지가 있는가(가림 보정 분모) — X 의 사유를 가른다. */
  detectable: boolean;
}
const faceRows: FaceRow[] = [];
/** ★ Phase 0-c — 프리셋별 [보간 quad 수, 그중 정답과 매칭된 수]. */
const interpStat: Array<{ key: string; produced: number; matched: number }> = [];

for (const c of placeJson.cameras) {
  for (const p of c.presets) {
    const key = `${c.camera.cam_id}:${p.preset_idx}`;
    const manual = (byPreset.get(key) ?? []).filter((s: { points?: unknown[] }) => Array.isArray(s.points) && s.points.length === 4);
    const baseIntr = intrinsics.get(c.camera.cam_id, p.preset_idx);
    if (!baseIntr) continue;
    const jpgPath = join(cacheDir, `frame_${c.camera.cam_id}_${p.preset_idx}_d0.jpg`);
    if (!existsSync(jpgPath)) continue;
    const jpg = readFileSync(jpgPath);
    const frameHash = createHash('sha256').update(jpg).digest('hex').slice(0, 12); // ★ F13 — 해시 없는 IoU 는 해석 불가.
    const meta = await sharp(jpg).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    const gb = await sharp(jpg).greyscale().raw().toBuffer();
    const frame: FrameGray = { data: new Uint8Array(gb.buffer, gb.byteOffset, gb.byteLength), width: W, height: H };

    // ── 정답 구성
    const proj = projectTruth(faces, {
      camPos: c.camera.position,
      panDeg: p.pan,
      tiltDeg: p.tilt,
      fovDeg: p.fov,
      fovAxis: 'vertical',
      imgW: W,
      imgH: H,
      planeYM: PLANE_Y_M,
    });
    const vis = visibleTruth(proj, W, H, MIN_AREA_PX);

    // ── 검출
    const { lines, mask } = detectPaintLines(frame, DEFAULT_PAINT_OPTIONS);
    const ev = paintEvidenceOf(mask, W, H);
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
    const model = groundModelFromIntrinsics(baseIntr, p.zoom);
    if (!model) continue;
    const opts: BayDetectOpts = {
      ...DEFAULT_BAY_OPTS,
      expectedBays: Math.max(1, manual.length),
      rowExtentMode,
      ...(PHASE_INVARIANT ? { coverageDenom: 'phaseInvariant' as const } : {}),
    };
    const g = detectBaysWithModel(cands, model, ev, DEFAULT_PAINT_OPTIONS, opts, frame);

    // `detectable` — 정답 quad 자체에 근변 도색 지지가 있는가(가림 보정 분모).
    const truth: TruthEntry[] = vis.map((t) => ({
      face: t.face,
      quad: t.quad,
      detectable: quadPaintSupport([{ latticeIndex: 0, quad: t.quad }], ev, DEFAULT_PAINT_OPTIONS, opts).near >= opts.extendMinNearSupport,
    }));

    const detQuads: PixelQuad[] =
      rowMode === 'rows' ? g.rows.flatMap((r) => r.quads.map((q) => q.quad)) : (g.best?.quads ?? []).map((q) => q.quad);
    // ★ Phase 0-c — `detQuads` 와 **같은 순서**로 출처를 만든다(어느 행·어느 칸이며 보간 유래인가).
    const detMeta: Array<{ id: string; filled: boolean }> = [];
    if (rowMode === 'rows') {
      g.rows.forEach((r, ri) => {
        for (const q of r.quads) detMeta.push({ id: `#${ri}.${q.latticeIndex}`, filled: r.filledIndices.includes(q.latticeIndex) });
      });
    } else if (g.best) {
      for (const q of g.best.quads) detMeta.push({ id: `best.${q.latticeIndex}`, filled: g.best.filledIndices.includes(q.latticeIndex) });
    }
    const sc = scoreDetection(detQuads, truth, MATCH_MIN_IOU);
    scores.push(sc);

    // ★ Phase 0-a2 — 면별 한 줄. 가시 면 전수(검출 여부 무관).
    vis.forEach((t, ti) => {
      const pair = sc.pairs.find((p) => p.rowIdx === t.face.rowIdx && p.faceIdx === t.face.faceIdx);
      const meta = pair ? detMeta[pair.detIdx] : undefined;
      faceRows.push({
        key,
        frameHash,
        faceId: `r${t.face.rowIdx}f${t.face.faceIdx}`,
        detected: !!pair,
        iou: pair?.iou ?? null,
        detId: meta?.id ?? null,
        fromInterp: !!meta?.filled,
        areaPx: quadAreaPx(t.quad),
        detectable: truth[ti].detectable,
      });
    });
    interpStat.push({
      key,
      produced: detMeta.filter((m) => m.filled).length,
      matched: sc.pairs.filter((p) => detMeta[p.detIdx]?.filled).length,
    });

    // ── 회귀 감시: 기존 "수동 정본 대비" 지표 병기
    const manualSc = scorePreset(
      (g.best?.quads ?? []).map((q, i) => ({ latticeIndex: i, quad: q.quad })),
      [],
      byPreset.get(key) ?? [],
      W,
      H,
      key,
      c.camera.cam_id,
      p.preset_idx,
    );
    manualRows.push(
      `  ${key.padEnd(4)} 정본 ${String(manual.length).padStart(2)}면 · 평균 ${manualSc.meanIoU?.toFixed(5) ?? '--'} · ≥0.95 ${manualSc.slots.filter((s) => s.iouVsManual >= 0.95).length}/${manual.length} · ≥0.98 ${manualSc.pass98}/${manual.length}`,
    );

    const rowsInfo = g.rows
      .map((r, i) => `#${i}(q${r.quads.length},p${r.paint.score.toFixed(3)}${r.extentEndedBy ? `,${r.extentEndedBy.lo[0]}${r.extentEndedBy.hi[0]}` : ''}${r.filledIndices.length ? `,보간${r.filledIndices.length}` : ''})`)
      .join(' ');
    console.log(
      `=== ${key}  프레임 ${frameHash}  씬가시 ${truth.length}면(검출가능 ${sc.truthDetectable}) · 산출 ${sc.detected}quad · 행후보 ${g.rows.length}\n` +
        `    재현율 ${sc.recall.toFixed(4)} (${sc.matched}/${sc.truthTotal}) · 가림보정 재현율 ${sc.recallDetectable.toFixed(4)} · 정밀도 ${sc.precision.toFixed(4)}\n` +
        `    매칭 IoU 평균 ${sc.meanIoU?.toFixed(5) ?? '--'} · 최소 ${sc.minIoU?.toFixed(5) ?? '--'} · ≥0.95 ${sc.pass95}/${sc.matched} · ≥0.98 ${sc.pass98}/${sc.matched}\n` +
        `    매칭: ${sc.pairs.map((q) => `r${q.rowIdx}f${q.faceIdx}=${q.iou.toFixed(4)}`).join(' ') || '없음'}\n` +
        `    미검출: ${sc.missed.map((m) => `r${m.rowIdx}f${m.faceIdx}${m.detectable ? '' : '(도색없음)'}`).join(' ') || '없음'}\n` +
        `    오검출 quad 인덱스: ${sc.spurious.join(',') || '없음'}\n` +
        `    rows: ${rowsInfo || '없음'}`,
    );
    // ★ Phase 0-c — 이 프리셋의 보간 기여.
    const st = interpStat[interpStat.length - 1];
    console.log(`    보간 유래 quad ${st.produced}개 · 그중 정답과 매칭 ${st.matched}개  ← Phase 0-c(가림 트레이드오프 실측)`);
    if (RAW) {
      console.log(
        `    [raw] meanIoU=${sc.meanIoU} minIoU=${sc.minIoU} recall=${sc.recall} precision=${sc.precision} recallDetectable=${sc.recallDetectable}\n` +
          `    [raw] 쌍별: ${sc.pairs.map((q) => `r${q.rowIdx}f${q.faceIdx}=${q.iou}`).join(' ') || '없음'}`,
      );
    }
    for (const iss of g.issues.filter((s) => s.startsWith('행 조각'))) console.log(`    ${iss}`);
  }
}

const all = sumScores(scores);
console.log(
  `\n=== 전체(면 수 기준) ===\n` +
    `  씬 가시 정답 ${all.truthTotal}면 (검출가능 ${all.truthDetectable}면) · 산출 ${all.detected}quad\n` +
    `  재현율   ${all.recall.toFixed(4)} (${all.matched}/${all.truthTotal})\n` +
    `  가림보정 재현율 ${all.recallDetectable.toFixed(4)}\n` +
    `  정밀도   ${all.precision.toFixed(4)} (${all.matched}/${all.detected})\n` +
    `  매칭 IoU 평균 ${all.meanIoU?.toFixed(5) ?? '--'} · 최소 ${all.minIoU?.toFixed(5) ?? '--'} · ≥0.95 ${all.pass95}면 · ≥0.98 ${all.pass98}면\n` +
    `  미검출 ${all.missed.length}면 (그중 도색지지 없음 ${all.missed.filter((m) => !m.detectable).length}면)\n` +
    `\n=== 회귀 감시: 기존 수동 정본 대비 지표(best, 단일 시점 d0) ===\n${manualRows.join('\n')}`,
);

// ── ★ Phase 0-a2: 면별 재현율 표 (씬 정답 가시 면 **전수**) ────────────────────
console.log(
  `\n=== ★ 면별 재현율 표 — 씬 정답 가시 면 전수 (${faceRows.length}면) ===\n` +
    `  검출 O/X 는 매칭 임계 IoU ≥ ${MATCH_MIN_IOU} 기준. IoU 는 **원시 배정도**(반올림 없음).\n` +
    `  도색 = 근변 도색 지지(≥${DEFAULT_BAY_OPTS.extendMinNearSupport}) 유무 — X 가 "가림 때문"인지 "알고리즘 때문"인지 가른다.\n` +
    `  보간 = 매칭된 산출 quad 가 filledIndices 유래(증거 없이 채운 칸)인가.\n` +
    `  프리셋 면ID    검출 도색 보간  매칭 IoU(raw)               매칭quad     면적(px²)   프레임해시`,
);
for (const key of [...new Set(faceRows.map((f) => f.key))]) {
  const rowsOf = faceRows.filter((f) => f.key === key);
  for (const f of rowsOf) {
    console.log(
      `  ${f.key.padEnd(5)}  ${f.faceId.padEnd(7)} ${f.detected ? ' O ' : ' X '}  ${f.detectable ? ' O ' : ' X '}  ` +
        `${f.fromInterp ? ' O ' : ' - '}  ${(f.iou == null ? '--' : String(f.iou)).padEnd(24)}  ${(f.detId ?? '--').padEnd(10)}  ` +
        `${f.areaPx.toFixed(0).padStart(9)}   ${f.frameHash}`,
    );
  }
  const det = rowsOf.filter((f) => f.detected);
  const ious = det.map((f) => f.iou as number);
  console.log(
    `  └ ${key} 소계: 재현율 ${det.length / rowsOf.length} (${det.length}/${rowsOf.length}) · ` +
      `도색있는 면 ${rowsOf.filter((f) => f.detectable).length} · 보간 매칭 ${det.filter((f) => f.fromInterp).length} · ` +
      `평균 IoU ${ious.length ? ious.reduce((s, v) => s + v, 0) / ious.length : '--'}\n`,
  );
}
const detAll = faceRows.filter((f) => f.detected);
console.log(
  `  ★ 프리셋별 소계 한눈에: ${[...new Set(faceRows.map((f) => f.key))]
    .map((k) => {
      const r = faceRows.filter((f) => f.key === k);
      return `${k} ${r.filter((f) => f.detected).length}/${r.length}`;
    })
    .join(' · ')}\n` +
    `  ★ 전체 면별 재현율 ${detAll.length / faceRows.length} (${detAll.length}/${faceRows.length})`,
);

// ── ★ Phase 0-c: 보간 기여 실측 (진단 1행) ────────────────────────────────────
const interpProduced = interpStat.reduce((s, x) => s + x.produced, 0);
const interpMatched = interpStat.reduce((s, x) => s + x.matched, 0);
console.log(
  `\n★ Phase 0-c 보간 기여: 산출 quad 중 보간(filledIndices) 유래 ${interpProduced}개 · ` +
    `그중 정답과 매칭 ${interpMatched}개 / 전체 매칭 ${all.matched}개 ` +
    `(프리셋별 ${interpStat.map((x) => `${x.key}=${x.matched}/${x.produced}`).join(' ')})\n` +
    `  → 보간을 기본 OFF 로 두면 재현율에서 잃는 면 수의 상한이 ${interpMatched}면이다(설계서 §4-1 미측정 해소).`,
);

if (RAW) {
  console.log(
    `\n=== ★ [raw] 원시 배정도 덤프 (toFixed 없음 — 무회귀 판정용) ===\n` +
      `  recall            ${all.recall}   (${all.matched}/${all.truthTotal})\n` +
      `  recallDetectable  ${all.recallDetectable}\n` +
      `  precision         ${all.precision}   (${all.matched}/${all.detected})\n` +
      `  meanIoU           ${all.meanIoU}\n` +
      `  minIoU            ${all.minIoU}\n` +
      `  pass95 ${all.pass95} · pass98 ${all.pass98}\n` +
      `  매칭 쌍 전체(원시): ${all.pairs.map((p) => `r${p.rowIdx}f${p.faceIdx}=${p.iou}`).join(' ')}\n` +
      `  프레임해시: ${[...new Set(faceRows.map((f) => `${f.key}=${f.frameHash}`))].join(' ')}`,
  );
}
