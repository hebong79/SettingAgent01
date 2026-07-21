// 하네스(프로덕션 아님 — `_qa_live_roi_overlay.mjs` 전례). 설계 §5 정합 품질 실측.
//
// ★ 규약: **프로덕션 `associateDetSeg` 를 import 해서 호출한다.** 재구현 금지(D-1 함정 — 테스트가
//   검증 대상을 재구현하면 "테스트 전량 통과인데 실데이터에서 틀림"이 된다).
// ★ 규약: **"정합이 잘 됐다"의 판정자로 IoU 를 쓰지 않는다**(자기참조). 독립 3종만 쓴다:
//     J1 육안 합성(리더) / J2 셔플 음성대조 / J3 cls 일치율.
//
// 실행: npx tsx _qa_assoc_iou.ts   (라이브 VPD 192.168.0.125:9081 · data/refframes/cam1_p{1,2,3}.jpg)
// 산출: docs/assets/assoc/assoc_p{1,2,3}.png (J1 육안) · test/fixtures/assoc/cam1_p{N}.json (응답 원문 녹화)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import sharp from 'sharp';
import { associateDetSeg } from './src/ground/segAssoc.js';
import { VpdClient } from './src/clients/VpdClient.js';
import { readJpegSize } from './src/util/jpeg.js';
import { iou as iouOf } from './src/domain/geometry.js'; // 하네스도 **같은 IoU** 를 쓴다(재구현 금지).
import type { NormalizedRect } from './src/domain/types.js';

const cfg = JSON.parse(readFileSync('config/tools.config.json', 'utf8')).vpd;
const FRAMES = [1, 2, 3];
const BIN = 0.05;

/** 라이브 호출 1회 + 응답 원문 반환(녹화용) + 지연 실측. */
async function post(path: string, jpg: Buffer): Promise<{ body: unknown; ms: number }> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(jpg)], { type: 'image/jpeg' }), 'capture.jpg');
  const t0 = Date.now();
  const res = await fetch(`${cfg.endpoint}${path}`, { method: 'POST', body: form });
  const ms = Date.now() - t0;
  if (res.status === 500) return { body: { success: false, bboxes: [], confidences: [], classes: [] }, ms }; // S-1 강등.
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return { body: await res.json(), ms };
}

/** 녹화된 응답 원문을 **프로덕션 VpdClient 파서**에 그대로 태운다(픽스처 ↔ 프로덕션 파리티). */
async function parseWithProduction(detBody: unknown, segBody: unknown, jpg: Buffer) {
  const vpd = new VpdClient({ ...cfg, maxRetries: 0 } as never);
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = (async (url: string) =>
      new Response(JSON.stringify(String(url).includes('/seg/') ? segBody : detBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    return { det: await vpd.detect(jpg), seg: await vpd.segment(jpg) };
  } finally {
    globalThis.fetch = orig;
  }
}

const pct = (a: number, b: number) => (b === 0 ? '—' : `${((100 * a) / b).toFixed(0)}%`);

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 J2 음성대조 — **설계서의 "seg 목록 무작위 순열"은 유효한 대조가 아니다**(구현자 발견).
//   `associateDetSeg` 는 **기하로만** 짝을 찾는다(인덱스를 보지 않는다) → 목록 순서를 섞어도 **같은 물리 쌍**을
//   다시 찾아낸다. 순열 불변성은 알고리즘의 **성질**이지 결함이 아니다. 실제로 돌려보니 27 → 27 (붕괴 0).
//   그것을 "IoU 변별력 0" 으로 읽으면 **거짓 경보**다.
//   → 대응을 **실제로 파괴하는** 두 대조로 교체한다. 둘 다 IoU 로 정답을 재는 게 아니라 **변별력**을 잰다.
//     J2a 교차프레임: 다른 프레임의 seg 로 정합 → 같은 장면이 아니므로 matched 가 붕괴해야 한다.
//     J2b 강제 오배정(derangement): 각 det 을 **자기 최적이 아닌** seg 에 강제로 짝지어 IoU 분포를 본다
//                                  → 참 쌍과 구별이 안 되면 IoU 는 변별력이 없다.
// ─────────────────────────────────────────────────────────────────────────────

/** 결정형 순열(시드 고정, flaky 0). */
function shuffled<T>(arr: readonly T[], seed: number): T[] {
  const a = [...arr];
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 완전탐색 최적 배정(최대 IoU 합) — **그리디가 최적인지 실측**하기 위한 하네스 전용 계산(프로덕션 아님). */
function optimalAssign(m: number[][], n: number, k: number, tau: number): Array<[number, number]> {
  const best = { score: -1, pick: [] as Array<[number, number]> };
  const cur: Array<[number, number]> = [];
  const usedSeg = new Array<boolean>(k).fill(false);
  const rec = (i: number, score: number): void => {
    if (i === n) {
      if (score > best.score) {
        best.score = score;
        best.pick = [...cur];
      }
      return;
    }
    rec(i + 1, score); // det i 미배정.
    for (let j = 0; j < k; j++) {
      if (usedSeg[j] || m[i][j] < tau) continue;
      usedSeg[j] = true;
      cur.push([i, j]);
      rec(i + 1, score + m[i][j]);
      cur.pop();
      usedSeg[j] = false;
    }
  };
  rec(0, 0);
  return best.pick;
}

/** J1 합성: det bbox(실선) + 정합된 seg 마스크를 **같은 색**으로 / 미정합 det=빨강 점선 / seg-only=회색. */
async function composite(
  jpg: Buffer,
  W: number,
  H: number,
  det: NormalizedRect[],
  segMasks: Array<{ x: number; y: number }[]>,
  segRects: NormalizedRect[],
  pairs: Array<{ detIdx: number; segIdx: number; iou: number }>,
  unmatchedDet: number[],
  unmatchedSeg: number[],
  out: string,
): Promise<void> {
  const COLORS = ['#ff3b30', '#34c759', '#0a84ff', '#ffd60a', '#ff9f0a', '#bf5af2', '#00e5ff', '#ff6482', '#30d158', '#5e5ce6'];
  const parts: string[] = [];
  pairs.forEach((p, k) => {
    const c = COLORS[k % COLORS.length];
    const r = det[p.detIdx];
    parts.push(
      `<rect x="${r.x * W}" y="${r.y * H}" width="${r.w * W}" height="${r.h * H}" fill="none" stroke="${c}" stroke-width="4"/>`,
      `<polygon points="${segMasks[p.segIdx].map((q) => `${q.x * W},${q.y * H}`).join(' ')}" fill="${c}" fill-opacity="0.35" stroke="${c}" stroke-width="2"/>`,
      `<text x="${r.x * W + 6}" y="${r.y * H + 26}" font-size="26" fill="${c}" stroke="black" stroke-width="0.7">d${p.detIdx}~s${p.segIdx} ${p.iou.toFixed(2)}</text>`,
    );
  });
  for (const i of unmatchedDet) {
    const r = det[i];
    parts.push(
      `<rect x="${r.x * W}" y="${r.y * H}" width="${r.w * W}" height="${r.h * H}" fill="none" stroke="#ff0000" stroke-width="4" stroke-dasharray="10 6"/>`,
      `<text x="${r.x * W + 6}" y="${r.y * H - 6}" font-size="26" fill="#ff0000" stroke="black" stroke-width="0.7">d${i} 미정합</text>`,
    );
  }
  for (const j of unmatchedSeg) {
    parts.push(
      `<polygon points="${segMasks[j].map((q) => `${q.x * W},${q.y * H}`).join(' ')}" fill="#999999" fill-opacity="0.3" stroke="#999999" stroke-width="2" stroke-dasharray="6 4"/>`,
      `<text x="${segRects[j].x * W + 6}" y="${(segRects[j].y + segRects[j].h) * H - 6}" font-size="24" fill="#cccccc" stroke="black" stroke-width="0.7">s${j} seg-only</text>`,
    );
  }
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
  await sharp(jpg).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(out);
}

/** 프레임 1장의 실측 원자료(라이브 1회 호출분). */
interface FrameData {
  p: number;
  W: number;
  H: number;
  detRects: NormalizedRect[];
  segRects: NormalizedRect[];
  detCls: string[];
  segCls: string[];
  detConf: number[];
  masksPx: Array<{ x: number; y: number }[]>;
  maskDrop: number;
  detMs: number;
  segMs: number;
}

const TAU = 0.4; // 잠정 — 아래 밸리 실측으로 확정.

async function main(): Promise<void> {
  mkdirSync('docs/assets/assoc', { recursive: true });
  mkdirSync('test/fixtures/assoc', { recursive: true });

  // ── 라이브 호출은 프레임당 det 1 + seg 1 회뿐. 이후 분석은 전부 이 원자료 위에서 돈다. ──
  const frames: FrameData[] = [];
  for (const p of FRAMES) {
    const jpg = readFileSync(`data/refframes/cam1_p${p}.jpg`);
    const { width: W, height: H } = readJpegSize(jpg);
    const d = await post(cfg.detPath, jpg);
    const s = await post(cfg.segPath, jpg);
    writeFileSync(
      `test/fixtures/assoc/cam1_p${p}.json`,
      JSON.stringify({ frame: `cam1_p${p}.jpg`, imgW: W, imgH: H, det: d.body, seg: s.body }, null, 1),
    );
    const { det, seg } = await parseWithProduction(d.body, s.body, jpg);
    frames.push({
      p, W, H,
      detRects: det.map((b) => b.rect),
      segRects: seg.boxes.map((b) => b.rect),
      detCls: det.map((b) => b.cls),
      segCls: seg.boxes.map((b) => b.cls),
      detConf: det.map((b) => b.confidence),
      masksPx: seg.boxes.map((b) => b.mask!),
      maskDrop: seg.maskMismatch,
      detMs: d.ms,
      segMs: s.ms,
    });
  }

  const detTotal = frames.reduce((a, f) => a + f.detRects.length, 0);
  const segTotal = frames.reduce((a, f) => a + f.segRects.length, 0);
  const allBest: number[] = [];
  const allGap: Array<{ frame: number; detIdx: number; best: number; second: number }> = [];
  const acceptedIou: number[] = []; // τ=0 그리디가 채택한 쌍의 IoU(밸리의 직접 증거).
  const rows: string[] = [];
  const sweepTau = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  const sweepAgg = sweepTau.map(() => ({ matched: 0, unDet: 0, segOnly: 0 }));
  let clsHit = 0;
  let clsTot = 0;
  let realMatched = 0;
  let greedyNeOptimal = 0;
  const unmatchedNotes: string[] = [];

  for (const f of frames) {
    // ★ 프로덕션 함수 호출(재구현 0). 진단은 임계와 무관하므로 τ=0 으로 원자료를 얻는다.
    const diag = associateDetSeg(f.detRects, f.segRects, { minIou: 0 });
    allBest.push(...diag.bestIouByDet);
    acceptedIou.push(...diag.pairs.map((x) => x.iou));
    diag.bestIouByDet.forEach((b, i) => allGap.push({ frame: f.p, detIdx: i, best: b, second: diag.secondIouByDet[i] }));

    sweepTau.forEach((t, k) => {
      const r = associateDetSeg(f.detRects, f.segRects, { minIou: t });
      sweepAgg[k].matched += r.pairs.length;
      sweepAgg[k].unDet += r.unmatchedDet.length;
      sweepAgg[k].segOnly += r.unmatchedSeg.length;
    });

    const r = associateDetSeg(f.detRects, f.segRects, { minIou: TAU });
    realMatched += r.pairs.length;
    for (const pr of r.pairs) {
      clsTot += 1;
      if (f.detCls[pr.detIdx] === f.segCls[pr.segIdx]) clsHit += 1;
    }

    // ④' **그리디 vs 전역최적 직접 대조**(모호 쌍이 나왔으므로 자명성 논증에 기대지 않고 실측한다).
    const m = f.detRects.map((dr) => f.segRects.map((sr) => iouOf(dr, sr)));
    const opt = optimalAssign(m, f.detRects.length, f.segRects.length, TAU);
    const key = (ps: Array<[number, number]>) => ps.map(([a, b]) => `${a}-${b}`).sort().join(',');
    const same = key(opt) === key(r.pairs.map((x) => [x.detIdx, x.segIdx] as [number, number]));
    if (!same) greedyNeOptimal += 1;
    console.log(`  [p${f.p}] 그리디 ${r.pairs.length}쌍 vs 전역최적 ${opt.length}쌍 → ${same ? '**동일 배정**' : '⚠️ 배정 다름'}`);

    for (const i of r.unmatchedDet) {
      const b = diag.bestIouByDet[i];
      const why = b === 0 ? '(a) 후보 0 — seg 가 그 차를 못 봄' : b < TAU ? `(b) 부분중첩 bestIoU=${b.toFixed(3)} — 파편화/병합 의심` : '(c) 1:1 경합 패배';
      unmatchedNotes.push(`  [p${f.p}] 미정합 det#${i}: ${why} (conf=${f.detConf[i].toFixed(2)}, cls=${f.detCls[i]})`);
    }

    await composite(jpg2(f), f.W, f.H, f.detRects, f.masksPx, f.segRects, r.pairs, r.unmatchedDet, r.unmatchedSeg, `docs/assets/assoc/assoc_p${f.p}.png`);
    rows.push(
      `| p${f.p} | ${f.W}×${f.H} | ${f.detRects.length} | ${f.segRects.length} | ${f.maskDrop} | ${r.pairs.length} | ${r.unmatchedDet.length} | ${r.unmatchedSeg.length} | ${f.detMs} | ${f.segMs} |`,
    );
  }

  console.log('\n=== ① 프레임별 (detN vs segN) + ⑦ 지연 ===');
  console.log('| 프레임 | 크기 | detN | segN | maskDrop | matched | unmatchedDet | segOnly | detMs | segMs |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  rows.forEach((r) => console.log(r));
  console.log('\n=== ⑥ 미정합 사유 ===');
  unmatchedNotes.forEach((n) => console.log(n));

  // ③ bestIoU 히스토그램(bin 0.05) — **밸리가 임계다.** (bin 키는 반드시 반올림 — 부동소수 키 누락 방지)
  const hist = new Map<string, number>();
  for (const b of allBest) hist.set((Math.min(0.95, Math.floor(b / BIN) * BIN)).toFixed(2), (hist.get((Math.min(0.95, Math.floor(b / BIN) * BIN)).toFixed(2)) ?? 0) + 1);
  console.log(`\n=== ③ det 별 bestIoU 히스토그램(bin 0.05, det 총 ${detTotal}, 합계 ${[...hist.values()].reduce((a, b) => a + b, 0)}) ===`);
  for (let i = 0; i < 20; i++) {
    const k = (i * BIN).toFixed(2);
    const c = hist.get(k) ?? 0;
    console.log(`  ${k}~${((i + 1) * BIN).toFixed(2)} | ${'█'.repeat(c)} ${c}`);
  }

  // ★ 밸리의 직접 증거 — 채택된 쌍의 **최소 IoU** vs 미정합 det 의 **최대 bestIoU**.
  const accSorted = [...acceptedIou].sort((a, b) => a - b);
  const rejBest = allGap.filter((g) => !accSorted.length || true).map((g) => g.best);
  console.log(`\n=== ★ 밸리(τ=0 그리디 채택쌍 ${accSorted.length}개의 IoU 오름차순) ===`);
  console.log(`  ${accSorted.map((v) => v.toFixed(3)).join(' ')}`);
  console.log(`  채택쌍 최소 IoU = ${accSorted[0]?.toFixed(3)} / 미채택 det 의 bestIoU 최대 = ${Math.max(...allGap.filter((g) => g.best < (accSorted[0] ?? 1)).map((g) => g.best), 0).toFixed(3)}`);
  void rejBest;

  console.log('\n=== ④ best − second 갭 (모호 쌍 = 갭 < 0.10 && second > 0) ===');
  const ambiguous = allGap.filter((g) => g.second > 0 && g.best - g.second < 0.1);
  console.log(`  second > 0 인 det: ${allGap.filter((g) => g.second > 0).length}건 / 모호 쌍: **${ambiguous.length}건**`);
  ambiguous.forEach((g) => console.log(`   ⚠️ p${g.frame} det#${g.detIdx}: best=${g.best.toFixed(3)} second=${g.second.toFixed(3)} (갭 ${(g.best - g.second).toFixed(3)})`));
  console.log(`  ★ 그리디 ≠ 전역최적 인 프레임: **${greedyNeOptimal} / ${frames.length}** (모호 쌍이 있어도 배정이 갈리는지는 별개 — 실측으로 답한다)`);

  console.log(`\n=== ⑤ 임계 스윕 (det 총 ${detTotal} / seg 총 ${segTotal}) ===`);
  console.log('| τ | matched | matched% (of det) | unmatchedDet | segOnly |');
  console.log('|---|---|---|---|---|');
  sweepTau.forEach((t, k) => {
    const a = sweepAgg[k];
    console.log(`| ${t.toFixed(1)} | ${a.matched} | ${pct(a.matched, detTotal)} | ${a.unDet} | ${a.segOnly} |`);
  });

  // ── 🔴 독립 판정자 ───────────────────────────────────────────────────────────
  console.log('\n=== 🔴 독립 판정자(IoU 로 정답을 재지 않는다) ===');
  console.log('  J1 육안: docs/assets/assoc/assoc_p{1,2,3}.png — 리더가 det bbox ↔ 같은 색 마스크의 1:1 대응 확인');

  // J2a 교차프레임 음성대조: det(pA) × seg(pB), A≠B. 같은 장면이 아니므로 **붕괴해야** 한다.
  let crossMatched = 0;
  let crossPairs = 0;
  for (const a of frames) {
    for (const b of frames) {
      if (a.p === b.p) continue;
      crossMatched += associateDetSeg(a.detRects, b.segRects, { minIou: TAU }).pairs.length;
      crossPairs += 1;
    }
  }
  console.log(`  J2a 교차프레임(det pA × seg pB, A≠B, ${crossPairs}조합): 동일프레임 matched ${realMatched}/${detTotal} → 교차 matched **${crossMatched}** (붕괴해야 정상)`);

  // J2b 강제 오배정(derangement): 각 det 을 자기 최적이 **아닌** seg 에 강제로 짝짓고 IoU 를 본다.
  const trueIou: number[] = [];
  const derangedIou: number[] = [];
  for (const f of frames) {
    const r = associateDetSeg(f.detRects, f.segRects, { minIou: TAU });
    const partner = new Map(r.pairs.map((x) => [x.detIdx, x.segIdx]));
    const segIdx = f.segRects.map((_, j) => j);
    for (const [dI, sJ] of partner) {
      trueIou.push(iouOf(f.detRects[dI], f.segRects[sJ]));
      const others = shuffled(segIdx.filter((j) => j !== sJ), 999 + dI);
      if (others.length) derangedIou.push(iouOf(f.detRects[dI], f.segRects[others[0]]));
    }
  }
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const overTau = (a: number[]) => a.filter((v) => v >= TAU).length;
  console.log(
    `  J2b 강제 오배정: 참 쌍 IoU 평균 ${mean(trueIou).toFixed(3)} (τ 이상 ${overTau(trueIou)}/${trueIou.length}) → ` +
      `오배정 IoU 평균 **${mean(derangedIou).toFixed(3)}** (τ 이상 **${overTau(derangedIou)}/${derangedIou.length}**) ` +
      `— 오배정이 τ 를 넘으면 IoU 변별력 없음`,
  );
  console.log(`  J3 cls 일치율: ${clsHit}/${clsTot} = ${pct(clsHit, clsTot)} (기하와 독립 신호)`);
}

/** 합성용 원본 JPEG 재로드(원자료 구조에 버퍼를 들고 다니지 않기 위해). */
function jpg2(f: FrameData): Buffer {
  return readFileSync(`data/refframes/cam1_p${f.p}.jpg`);
}

main().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
