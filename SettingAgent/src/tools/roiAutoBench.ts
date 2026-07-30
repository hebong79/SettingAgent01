// roi.auto.* 실측 벤치 — 저장된 프레임(초록 제거 완료)으로 검출·채점을 돌려 **실제 수치**를 낸다.
//
// 3회차 경로: 지면모델을 **제원에서 주입**하고(f·소실점 추정 없음) 격자 위상만 탐색한다.
// 정본·DB 를 쓰지 않는다(읽기만). 사용:
//   npx tsx src/tools/roiAutoBench.ts <frameDir> [placeRoiFile]

import { readFileSync, readdirSync } from 'node:fs';
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
import { DEFAULT_BAY_OPTS } from '../ground/bayGeometry.js';
import { detectBaysWithModel, type RowCandidate } from '../ground/bayGrid.js';
import { groundModelFromIntrinsics } from '../ground/cameraIntrinsics.js';
import { placeMetaProvider, readPlaceMeta } from '../ground/placeMetaIntrinsics.js';
import { resolveManualAssignment, scorePreset, summarize } from '../ground/roiAutoScore.js';
import { normalizePtzCamRoi } from '../capture/placeRoi.js';
import { greenPixelRatio } from '../rpc/services/roiAuto.js';

const dir = process.argv[2];
const placeFile = process.argv[3] ?? 'data/Place01/PtzCamRoi.json';
if (!dir) {
  console.error('사용: npx tsx src/tools/roiAutoBench.ts <frameDir> [placeRoiFile]');
  process.exit(2);
}

const placeJson = JSON.parse(readFileSync(placeFile, 'utf8'));
/** 채점 전용(수동 정본). */
const { byPreset } = normalizePtzCamRoi(placeJson);
/** ★ 제원 전용 — 카메라·프리셋 메타만 읽는 뷰(주차면을 담을 필드 자체가 없다). */
const intrinsics = placeMetaProvider(readPlaceMeta(placeJson));

const files = readdirSync(dir).filter((f) => /^frame_\d+_\d+\.json$/.test(f)).sort();
const scores = [];

for (const f of files) {
  const m = /^frame_(\d+)_(\d+)\.json$/.exec(f);
  if (!m) continue;
  const camId = Number(m[1]);
  const presetIdx = Number(m[2]);
  const key = `${camId}:${presetIdx}`;
  const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
    result: { img_bytes: string; width: number; height: number };
    preset?: { zoom?: number };
  };
  const jpg = Buffer.from(j.result.img_bytes, 'base64');
  const W = j.result.width;
  const H = j.result.height;
  const rgb = await sharp(jpg).removeAlpha().raw().toBuffer();
  const green = greenPixelRatio(new Uint8Array(rgb.buffer, rgb.byteOffset, rgb.byteLength));
  const grayBuf = await sharp(jpg).greyscale().raw().toBuffer();
  const frame: FrameGray = { data: new Uint8Array(grayBuf.buffer, grayBuf.byteOffset, grayBuf.byteLength), width: W, height: H };

  const manual = byPreset.get(key) ?? [];
  const bays = manual.filter((s) => Array.isArray(s.points) && s.points.length === 4).length;
  const bayOpts = {
    ...DEFAULT_BAY_OPTS,
    expectedBays: Math.max(1, bays),
    calibrateHeight: process.env.CALIB !== '0',
    phaseFitWeight: Number(process.env.PHASEW ?? DEFAULT_BAY_OPTS.phaseFitWeight),
    farWeight: Number(process.env.FARW ?? DEFAULT_BAY_OPTS.farWeight),
    aimCenterWeight: Number(process.env.AIMW ?? DEFAULT_BAY_OPTS.aimCenterWeight),
    extendMinNearSupport: Number(process.env.EXTMIN ?? DEFAULT_BAY_OPTS.extendMinNearSupport),
    maxHeightCorrection: Number(process.env.MAXHC ?? DEFAULT_BAY_OPTS.maxHeightCorrection),
    coverageExponent: Number(process.env.COVEXP ?? DEFAULT_BAY_OPTS.coverageExponent),
    maxRowDistanceRatio: Number(process.env.DISTR ?? DEFAULT_BAY_OPTS.maxRowDistanceRatio),
    rowRefitTrimK: Number(process.env.TRIMK ?? DEFAULT_BAY_OPTS.rowRefitTrimK),
    rowRefitSamples: Number(process.env.RSAMP ?? DEFAULT_BAY_OPTS.rowRefitSamples),
    rowRefitUniformBins: Number(process.env.UBINS ?? DEFAULT_BAY_OPTS.rowRefitUniformBins),
    rowRefitPasses: Number(process.env.RPASS ?? DEFAULT_BAY_OPTS.rowRefitPasses),
    rowRefitDamping: Number(process.env.DAMP ?? DEFAULT_BAY_OPTS.rowRefitDamping),
  };

  const t0 = Date.now();
  const { lines, mask } = detectPaintLines(frame, DEFAULT_PAINT_OPTIONS);
  const ev = paintEvidenceOf(mask, W, H);
  const intr = intrinsics.get(camId, presetIdx);
  const model = intr ? groundModelFromIntrinsics(intr, j.preset?.zoom ?? 1) : null;

  const cands: RowCandidate[] = [];
  if (model) {
    for (const front of lines.slice(0, DEFAULT_PAINT_OPTIONS.frontCandidates)) {
      const pk = scanSeparators(frame, mask, front, DEFAULT_PAINT_OPTIONS);
      const refined = pk.length ? refineSeparators(frame, pk, DEFAULT_PAINT_OPTIONS) : [];
      const pts: Array<{ x: number; y: number }> = [];
      for (const sep of refined) {
        const p = meetLines(sep.line, front.line);
        if (p) pts.push(p);
      }
      cands.push({ front, cornersPx: pts });
    }
  }
  const grid = model ? detectBaysWithModel(cands, model, ev, DEFAULT_PAINT_OPTIONS, bayOpts, frame) : null;
  const ms = Date.now() - t0;

  const quads = grid?.best?.quads ?? [];
  const cornersPx = grid?.best?.cornersPx ?? [];
  const sc = scorePreset(quads, cornersPx, manual, W, H, key, camId, presetIdx);
  const asg = resolveManualAssignment(manual, W, H);
  scores.push(sc);

  const pv = grid?.best?.paint ?? null;
  console.log(`\n=== ${key} (수동 ${bays}면, 초록 ${(green * 100).toFixed(3)}%, ${ms}ms)`);
  console.log(`  직선 ${lines.length} · 근변선후보 ${grid?.tried.length ?? 0} · quad ${quads.length}`);
  console.log(
    `  제원 주입: ${intr && model ? `${intr.source} fov=${intr.fovDeg.toFixed(3)}°(${intr.fovAxis}) tilt=${intr.tiltDeg.toFixed(2)}° h=${intr.heightM}m → f=${model.f.toFixed(1)}px` : '공급 실패'}`,
  );
  console.log(
    `  도색지지(P1): near=${pv ? pv.near.toFixed(3) : '--'} far=${pv ? pv.far.toFixed(3) : '--'} side=${pv ? pv.side.toFixed(3) : '--'} ` +
      `score=${pv ? pv.score.toFixed(3) : '--'} · 위상적합=${grid?.best?.phaseFitM != null ? `${grid.best.phaseFitM.toFixed(3)}m` : '--'}`,
  );
  const cal = grid?.best?.calibration ?? null;
  console.log(
    `  지상고 자가보정: ${cal ? `${cal.nominalM.toFixed(3)}m → ${cal.correctedM.toFixed(3)}m (관측폭 ${cal.measuredWidthM.toFixed(4)}m, 계수 ${cal.factor.toFixed(5)}, 표본 ${cal.samples})` : '적용 안 됨'}`,
  );
  console.log(
    `  배정(이미지일관성): ${asg ? `rot=${asg.rot} dir=${asg.dir > 0 ? '+' : '-'} rowResid=${asg.rowResidPx.toFixed(2)}px sideResid=${asg.sideResidPx.toFixed(2)}px` : '판별 실패'}`,
  );
  console.log(`  IoU: ${sc.slots.map((s) => `s${s.slotIdx}=${s.iouVsManual.toFixed(4)}${s.degrade ? `(${s.degrade})` : ''}`).join(' ')}`);
  console.log(
    `  >=0.98 ${sc.pass98}/${sc.manualSlots}  평균 ${sc.meanIoU?.toFixed(5) ?? '--'}  최소 ${sc.minIoU?.toFixed(5) ?? '--'}  graded=${sc.graded}${sc.gradeReason ? ` (${sc.gradeReason})` : ''}`,
  );
  for (const i of grid?.issues ?? []) console.log(`  ! ${i}`);
}

console.log('\n=== 요약 ===');
console.log(JSON.stringify(summarize(scores), null, 2));
