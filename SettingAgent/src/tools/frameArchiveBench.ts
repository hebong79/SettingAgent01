// 검출 프레임 아카이브 **저장 비용 실측**(27-B 요구 ③ — 기본 ON 판단의 근거).
//
// 사용: npx tsx src/tools/frameArchiveBench.ts [건수=60]
//
// 재는 것: `archiveDetectFrame` 1회 = mkdir + JPEG 쓰기 + 사이드카 쓰기 + 보존정책 집행(prune).
// prune 은 아카이브가 **찰수록 비싸진다**(readdir + 쌍마다 stat) — 상한 근처에서의 비용이 관심사라
// 상한을 채워 가며 잰다. 임시 디렉터리에서만 돌며 실제 아카이브·정본·DB 를 건드리지 않는다.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveDetectFrame, frameHashOf, type FrameArchiveMeta } from '../capture/frameArchive.js';

/** 실측 프레임 크기대(실카 1920×1080 JPEG ≈ 0.2~0.4MB)를 그대로 쓴다 — 압축률이 아니라 IO 량이 관심사다. */
const JPEG_BYTES = 350_000;

function metaOf(hash: string, i: number): FrameArchiveMeta {
  return {
    frameHash: hash,
    capturedAt: new Date(Date.UTC(2026, 6, 31, 0, 0, i % 60, i % 1000)).toISOString(),
    timing: { ptzQueriedAt: null, frameRequestedAt: '', frameReceivedAt: '', ptzToFrameMs: null, note: 'bench' },
    source: { id: 'bench', kind: 'rpc', requested: null },
    target: { key: `1:${i}`, camId: 1, presetIdx: 1, view: 'current', dPanDeg: 0, dTiltDeg: 0 },
    ptz: { viewer: { pan: 1, tilt: 2, zoom: 3 }, requested: null, native: { zoom: null, tilt: null } },
    intrinsics: {
      source: 'bench',
      fovDeg: 58,
      fovAxis: 'horizontal',
      fovAtZoom: 'zoom1',
      tiltDeg: 8.7,
      heightM: 5,
      imgW: 1920,
      imgH: 1080,
      focalPx: 2932.7,
      hfovDegEffective: 36.2,
    },
    groundModel: { f: 2932.7, n: [0, 0.98, 0.15], d: 5, tiltDeg: 8.7, issues: [] },
    options: { slotWidthM: 2.5, slotDepthM: 5, cameraHeightM: 5, expectedBays: 0, coverageDenom: 'phaseInvariant', consensus: false },
    // 실제 사이드카와 같은 부피가 되도록 quad 7면을 채운다(사이드카 6.5KB 실측).
    detect: {
      graded: true,
      greenRatio: 0,
      paintLines: 60,
      bays: 7,
      rows: 2,
      quadsNorm: Array.from({ length: 7 }, (_, k) => ({
        latticeIndex: k,
        quad: Array.from({ length: 4 }, (_, m) => ({ x: 0.1234567890123 + m / 10, y: 0.5678901234567 + m / 10 })),
      })),
      issues: ['지면모델 주입: bench', '근변선 재적합 pass1: 표본 60/61'],
    },
    files: { jpg: '' },
  };
}

async function main(): Promise<void> {
  const n = Number(process.argv[2] ?? 60);
  const dir = mkdtempSync(join(tmpdir(), 'framearch-'));
  process.env.ROI_FRAME_ARCHIVE_DIR = dir;
  delete process.env.ROI_FRAME_ARCHIVE;
  const jpg = Buffer.alloc(JPEG_BYTES, 7);

  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    // 매 회 다른 지문 = 매 회 다른 파일(실사용과 같다).
    const hash = frameHashOf(Buffer.concat([jpg.subarray(0, 16), Buffer.from(String(i))]));
    const t0 = process.hrtime.bigint();
    const r = await archiveDetectFrame(jpg, metaOf(hash, i));
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (!r) throw new Error('아카이브가 꺼져 있다 — ROI_FRAME_ARCHIVE 확인');
    samples.push(ms);
  }
  rmSync(dir, { recursive: true, force: true });

  const sorted = [...samples].sort((a, b) => a - b);
  const sum = samples.reduce((s, v) => s + v, 0);
  const pct = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  console.log(`아카이브 저장 ${n}회 (JPEG ${JPEG_BYTES}B + 사이드카)`);
  console.log(`  평균 ${(sum / n).toFixed(3)}ms · 중앙 ${pct(0.5).toFixed(3)}ms · p95 ${pct(0.95).toFixed(3)}ms · 최대 ${sorted[sorted.length - 1].toFixed(3)}ms`);
  console.log(`  첫 10회 평균 ${(samples.slice(0, 10).reduce((s, v) => s + v, 0) / 10).toFixed(3)}ms · 마지막 10회 평균 ${(samples.slice(-10).reduce((s, v) => s + v, 0) / 10).toFixed(3)}ms (prune 부하 증가분)`);
  for (const detectMs of [9000, 14000]) {
    console.log(`  검출 1회 ${detectMs}ms 대비 평균 비중 ${(((sum / n) / detectMs) * 100).toFixed(4)}%`);
  }
}

void main();
