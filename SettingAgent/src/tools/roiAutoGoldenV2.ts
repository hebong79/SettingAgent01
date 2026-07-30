// ★ 15회차 — **정착 프레임 골든 세트 v2** 캡처 도구(P1).
//
// v1(`test/fixtures/roiAutoGolden/`)은 `cam.setPTZ` **직후 1장**을 잡은 세트다. 실카는 정착본을 찍으므로
// 평가 기준을 지금 정착본으로 옮겨 둔다(14회차 T1: 정착 프레임으로 바꾸면 `2:1` 0.966→0.854, `1:2` 0.954→0.759).
//
// 정착 판정: **sha256 이 연속 2회 동일**해질 때까지 재캡처(간격 ~2초, 상한 30초).
// 상한 내 미수렴이면 **최후 프레임을 채택하고 `settled:false` 로 기록한다 — 은닉하지 않는다.**
// (씬이 간헐 변동한다는 실측이 있다: 3분 동안 9종.)
//
// 파일명은 v1 규약(`frame_{cam}_{preset}_d{i}.jpg`)을 그대로 지킨다 → `roiAutoFuse.ts` 가 별칭 `v2` 로 바로 읽는다.
// 매니페스트는 v1 스키마 + `settled`/`attempts`/`settleMs` 3필드.
//
// **v1 은 읽기 전용이다.** outDir 가 v1 경로면 캡처 0회로 거부한다(하드 가드).
// 정본·DB 무접촉(읽기만). 캡처 전 `roi.show2d{visible:false}`(D-5) — 초록 박스가 도색선을 덮는다.
//
// 사용: npx tsx src/tools/roiAutoGoldenV2.ts [outDir]
//   outDir 기본 test/fixtures/roiAutoGolden_v2

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const V1_DIR = 'test/fixtures/roiAutoGolden';
const outDir = process.argv[2] ?? 'test/fixtures/roiAutoGolden_v2';
if (resolve(outDir) === resolve(V1_DIR)) {
  console.error(`거부: outDir 가 v1 골든 세트다(${resolve(outDir)}). v1 은 G2 측정의 반쪽이라 덮어쓸 수 없다. 캡처 0회로 종료한다.`);
  process.exit(2);
}

/** ★ `roiAutoFuse.ts` 의 `DITHER` 와 **같은 집합·같은 순서**여야 한다(v1 manifest `ditherSet` 과 일치). */
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
  // 유니티 HTTP 서버가 keep-alive 소켓을 끊어 ECONNRESET/ECONNABORTED 가 간헐 발생한다 — 재시도로 흡수한다.
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

/** 정착 판정 결과 1건. */
interface SettleResult {
  jpg: Buffer;
  width: number;
  height: number;
  sha256_12: string;
  /** 해시 연속 2회 동일로 채택했는가. 상한 초과 시 false(최후 프레임 채택). */
  settled: boolean;
  /** 총 캡처 시도 횟수. */
  attempts: number;
  /** 첫 캡처 ~ 채택까지 경과(ms, 정수). */
  settleMs: number;
}

/** 한 시점의 정착 프레임 취득. `cam.setPTZ` 는 호출자가 먼저 한다. */
async function captureSettled(camId: number, intervalMs: number, budgetMs: number): Promise<SettleResult> {
  const t0 = Date.now();
  let prev: string | null = null;
  let attempts = 0;
  for (;;) {
    const cap = await rpc('cam.captureJPG', { camId });
    const jpg = Buffer.from(cap.img_bytes, 'base64');
    const h = createHash('sha256').update(jpg).digest('hex').slice(0, 12);
    attempts++;
    const cur: SettleResult = { jpg, width: cap.width, height: cap.height, sha256_12: h, settled: h === prev, attempts, settleMs: Date.now() - t0 };
    if (cur.settled) return cur;
    prev = h;
    if (Date.now() - t0 >= budgetMs) return cur; // 미수렴 — 최후 프레임을 그대로 쓴다(settled:false).
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}

/** v1 과 동일 스키마 + `settled`/`attempts`/`settleMs`. */
interface FrameEntryV2 {
  file: string;
  camId: number;
  presetIdx: number;
  ditherIdx: number;
  dither: [number, number];
  ptz: { pan: number; tilt: number; zoom: number };
  presetPtz: { pan: number; tilt: number; zoom: number };
  width: number;
  height: number;
  sha256_12: string;
  bytes: number;
  capturedAtApprox: string;
  settled: boolean;
  attempts: number;
  settleMs: number;
}

const placeJson = JSON.parse(readFileSync('data/Place01/PtzCamRoi.json', 'utf8'));
const targets: Array<{ key: string; cam: number; preset: number; pan: number; tilt: number; zoom: number }> = [];
for (const c of placeJson.cameras) {
  for (const p of c.presets) {
    targets.push({ key: `${c.camera.cam_id}:${p.preset_idx}`, cam: c.camera.cam_id, preset: p.preset_idx, pan: p.pan, tilt: p.tilt, zoom: p.zoom });
  }
}

mkdirSync(outDir, { recursive: true });
await rpc('roi.show2d', { visible: false }); // ★ D-5 — 실패하면 rpc 가 throw 해 여기서 중단된다.
console.log(`골든 세트 v2(정착 프레임) 캡처 — ${targets.length}프리셋 × ${DITHER.length}시점 = ${targets.length * DITHER.length}장\n출력: ${outDir}\n`);

const frames: FrameEntryV2[] = [];
for (const t of targets) {
  for (let i = 0; i < DITHER.length; i++) {
    const [dp, dt] = DITHER[i];
    await rpc('cam.setPTZ', { camId: t.cam, pan: t.pan + dp, tilt: t.tilt + dt, zoom: t.zoom });
    const r = await captureSettled(t.cam, 2000, 30000);
    const file = `frame_${t.cam}_${t.preset}_d${i}.jpg`;
    writeFileSync(join(outDir, file), r.jpg);
    frames.push({
      file,
      camId: t.cam,
      presetIdx: t.preset,
      ditherIdx: i,
      dither: [dp, dt],
      ptz: { pan: t.pan + dp, tilt: t.tilt + dt, zoom: t.zoom },
      presetPtz: { pan: t.pan, tilt: t.tilt, zoom: t.zoom },
      width: r.width,
      height: r.height,
      sha256_12: r.sha256_12,
      bytes: r.jpg.length,
      capturedAtApprox: new Date().toISOString(),
      settled: r.settled,
      attempts: r.attempts,
      settleMs: r.settleMs,
    });
    console.log(`  ${t.key}#${i} [${dp},${dt}]  ${r.sha256_12}  settled=${r.settled}  attempts=${r.attempts}  ${r.settleMs}ms  ${r.jpg.length}B`);
  }
}

writeFileSync(
  join(outDir, 'manifest.json'),
  JSON.stringify(
    {
      note:
        '골든 프레임 세트 v2 — **정착 프레임**(sha256 연속 2회 동일, 간격 2초·상한 30초). ' +
        'v1 은 cam.setPTZ 직후 1장이라 실카(정착본)와 프로토콜이 다르다. roi.show2d{visible:false} 적용 후 취득. ' +
        'settled:false 는 상한 내 미수렴이라 최후 프레임을 채택한 것이며 은닉하지 않는다.',
      source: 'Unity 시뮬레이터 13110 · cam.setPTZ → cam.captureJPG(정착 판정 루프)',
      ditherSet: DITHER,
      createdBy: '15회차 구현자 · src/tools/roiAutoGoldenV2.ts',
      frames,
    },
    null,
    2,
  ),
);

const unsettled = frames.filter((f) => !f.settled);
console.log(`\n완료 — ${frames.length}장 · settled:false ${unsettled.length}건${unsettled.length ? ` (${unsettled.map((f) => `${f.camId}:${f.presetIdx}#${f.ditherIdx}`).join(' ')})` : ''}`);
