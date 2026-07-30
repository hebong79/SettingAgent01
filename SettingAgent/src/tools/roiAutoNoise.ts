// ★ 14회차 P0 — **잡음 바닥 측정**. 같은 PTZ 로 반복 캡처해 프레임·추정값의 회차간 변동을 잰다.
//
// 13회차는 "같은 PTZ 두 캡처에서 드리프트가 1.24→1.49px 로 변한다"를 **캡처 잡음**으로 보고했다.
// 그러나 그 두 값은 JPEG 캡처와 PNG 캡처를 비교한 것이라 **인코딩 차이와 분리되지 않는다.**
// 이 도구는 같은 인코딩·같은 PTZ 로 R회 반복해 그 혼입 없이 변동을 잰다.
//
// 측정 대상:
//   ① 프레임 바이트 동일성(SHA-256)  ② 지상고 자가보정 값  ③ 면별 IoU
// 캡처 프로토콜을 두 가지로 나눈다 — 이동 직후 첫 프레임(k=1)과 정착 후 프레임(k=settle).
// **시뮬레이터 렌더가 이동 직후 몇 프레임 동안 확정되지 않기 때문이다**(14회차 실측).
//
// 정본·DB 무접촉(읽기만). 프레임 취득 전 `roi.show2d{visible:false}` 필수(D-5).
// 사용: npx tsx src/tools/roiAutoNoise.ts [reps] [settle]

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
import { scorePreset } from '../ground/roiAutoScore.js';
import { normalizePtzCamRoi } from '../capture/placeRoi.js';
import { greenPixelRatio } from '../rpc/services/roiAuto.js';

const REPS = Number(process.argv[2] ?? 6);
/** 이동 후 몇 번째 캡처를 "정착본"으로 볼 것인가. */
const SETTLE = Number(process.argv[3] ?? 3);
const RPC = 'http://localhost:13110/rpc';
let rpcId = 0;
async function rpc(method: string, params: Record<string, unknown>): Promise<any> {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const j = (await r.json()) as any;
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

const placeJson = JSON.parse(readFileSync('data/Place01/PtzCamRoi.json', 'utf8'));
const { byPreset } = normalizePtzCamRoi(placeJson);
const intrinsics = placeMetaProvider(readPlaceMeta(placeJson));
/** 프리셋 PTZ 는 정본 메타에서 읽는다(주차면 무참조). */
const targets: Array<{ key: string; cam: number; preset: number; pan: number; tilt: number; zoom: number }> = [];
for (const c of placeJson.cameras) {
  for (const p of c.presets) {
    targets.push({ key: `${c.camera.cam_id}:${p.preset_idx}`, cam: c.camera.cam_id, preset: p.preset_idx, pan: p.pan, tilt: p.tilt, zoom: p.zoom });
  }
}
/** 매 반복 시작 시 들르는 지점 — "다른 프리셋에서 이동해 온다"를 재현한다. */
const AWAY: Record<number, { pan: number; tilt: number }> = { 1: { pan: 0, tilt: 30 }, 2: { pan: 60, tilt: 30 } };

interface Obs {
  hash: string;
  heightM: number | null;
  ious: number[];
  meanIoU: number | null;
}

async function analyse(t: (typeof targets)[number], jpg: Buffer, W: number, H: number): Promise<Obs> {
  const rgb = await sharp(jpg).removeAlpha().raw().toBuffer();
  const green = greenPixelRatio(new Uint8Array(rgb.buffer, rgb.byteOffset, rgb.byteLength));
  if (green > 0.001) throw new Error(`${t.key}: 초록 오염 ${(green * 100).toFixed(3)}% — roi.show2d 확인`);
  const gb = await sharp(jpg).greyscale().raw().toBuffer();
  const frame: FrameGray = { data: new Uint8Array(gb.buffer, gb.byteOffset, gb.byteLength), width: W, height: H };
  const manual = byPreset.get(t.key) ?? [];
  const bays = manual.filter((s) => Array.isArray(s.points) && s.points.length === 4).length;
  const intr = intrinsics.get(t.cam, t.preset);
  const model = intr ? groundModelFromIntrinsics(intr, t.zoom) : null;
  const { lines, mask } = detectPaintLines(frame, DEFAULT_PAINT_OPTIONS);
  const ev = paintEvidenceOf(mask, W, H);
  const cands: RowCandidate[] = [];
  if (model) {
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
  }
  const grid = model
    ? detectBaysWithModel(cands, model, ev, DEFAULT_PAINT_OPTIONS, { ...DEFAULT_BAY_OPTS, expectedBays: Math.max(1, bays) }, frame)
    : null;
  const sc = scorePreset(grid?.best?.quads ?? [], grid?.best?.cornersPx ?? [], manual, W, H, t.key, t.cam, t.preset);
  return {
    hash: createHash('sha256').update(jpg).digest('hex').slice(0, 12),
    heightM: grid?.best?.calibration?.correctedM ?? null,
    ious: sc.slots.map((s) => s.iouVsManual),
    meanIoU: sc.meanIoU,
  };
}

const sd = (a: readonly number[]): number => {
  if (a.length < 2) return 0;
  const m = a.reduce((s, v) => s + v, 0) / a.length;
  return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1));
};
const fmt = (v: number): string => (v === 0 ? '0' : v.toExponential(2));

await rpc('roi.show2d', { visible: false }); // ★ D-5
console.log(`잡음 바닥 측정 — ${REPS}회 반복 · 정착본 k=${SETTLE} · 프레임 취득 전 roi.show2d(false)\n`);

const obs = new Map<string, Obs[]>();
for (let r = 1; r <= REPS; r++) {
  for (const t of targets) {
    const a = AWAY[t.cam] ?? { pan: 0, tilt: 30 };
    await rpc('cam.setPTZ', { camId: t.cam, pan: a.pan, tilt: a.tilt, zoom: 1 });
    await rpc('cam.captureJPG', { camId: t.cam });
    for (let k = 1; k <= SETTLE; k++) {
      await rpc('cam.setPTZ', { camId: t.cam, pan: t.pan, tilt: t.tilt, zoom: t.zoom });
      const cap = await rpc('cam.captureJPG', { camId: t.cam });
      if (k !== 1 && k !== SETTLE) continue;
      const o = await analyse(t, Buffer.from(cap.img_bytes, 'base64'), cap.width, cap.height);
      const bucket = `${t.key}|k${k}`;
      (obs.get(bucket) ?? obs.set(bucket, []).get(bucket)!).push(o);
    }
  }
  process.stderr.write(`\r반복 ${r}/${REPS} 완료   `);
}
process.stderr.write('\n');

console.log('키      프로토콜  프레임고유  지상고 mean±sd(m)      면별 IoU 표준편차(최대)  평균IoU mean±sd');
for (const [bucket, list] of [...obs.entries()].sort()) {
  const [key, k] = bucket.split('|');
  const uniq = new Set(list.map((o) => o.hash)).size;
  const hs = list.map((o) => o.heightM).filter((v): v is number => v != null);
  const n = Math.max(...list.map((o) => o.ious.length));
  let worstSd = 0;
  for (let i = 0; i < n; i++) worstSd = Math.max(worstSd, sd(list.map((o) => o.ious[i] ?? 0)));
  const ms = list.map((o) => o.meanIoU ?? 0);
  const mean = (a: readonly number[]): number => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
  console.log(
    `${key.padEnd(6)}  ${k.padEnd(8)}  ${String(uniq).padStart(2)}/${list.length}       ` +
      `${hs.length ? `${mean(hs).toFixed(4)}±${fmt(sd(hs))}` : '--'.padEnd(16)}   ` +
      `${fmt(worstSd).padStart(10)}              ${mean(ms).toFixed(5)}±${fmt(sd(ms))}`,
  );
}
console.log(
  '\n★ 프레임 고유수가 1/N 이고 표준편차가 0 이면 **확률적 잡음 바닥은 0** 이다 —\n' +
    '  IoU ≥0.98 미달은 잡음이 아니라 계통 원인이다. k=1 과 k=settle 이 다르면 그것은\n' +
    '  잡음이 아니라 **캡처 프로토콜에 따른 결정론적 편향**이다(둘을 구분해 읽어라).',
);
