// 하네스(프로덕션 아님). **프로덕션 전 경로를 실데이터로 1회 관통시킨다** — 유닛테스트가 못 하는 것(동작 확인).
//
// 부르는 것: 프로덕션 `makeCuboidContextResolver`(실 PtzCamRoi.json + camerapos.json 지면모델)
//            + 프로덕션 `VpdClient.detect/segment`(라이브 192.168.0.125:9081)
//            + 프로덕션 `filterVehiclesOnPlace`(주차면 필터)
//            + 프로덕션 `buildFrameCuboids`(det 권위 + 정합 + 육면체)
// **재구현 0** — 라우트가 하는 것과 정확히 같은 호출 순서다.
//
// 산출: docs/assets/assoc/cuboid_p{N}.png — 리더 육안(G4: 바닥면이 바퀴에 닿는가 / G3: 정합).
// 실행: npx tsx _qa_frame_cuboids.ts

import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { loadToolsConfig } from './src/config/toolsConfig.js';
import { VpdClient } from './src/clients/VpdClient.js';
import { makeCuboidContextResolver } from './src/ground/cuboidContext.js';
import { buildFrameCuboids } from './src/ground/frameCuboids.js';
import { filterVehiclesOnPlace } from './src/capture/onPlaceFilter.js';
import { projectCuboidPixels } from './src/ground/project.js';

// ⚠️ **반드시 `loadToolsConfig()`** — 원시 JSON 을 직접 읽으면 안 된다.
//    `tools.config.json` 에는 `ground` 키가 **아예 없고**, 기본값(enabled:true …)은 이 로더가 채운다.
//    원시 JSON 을 읽었더니 `ground=undefined` → 리졸버가 전 프리셋 null → "지면모델 없음" 오진이 났다(하네스 버그).
//    index.ts 도 같은 로더를 쓰므로 이것이 **프로덕션과 동일한 설정**이다.
const tools = loadToolsConfig();
const vpd = new VpdClient(tools.vpd);
const resolve = makeCuboidContextResolver({
  placeRoiFile: join(tools.store.dataDir, tools.store.placeRoiFile), // ⚠️ 런타임 데이터 — 하네스는 읽기만 한다.
  cameraposFile: tools.map.cameraposFile,
  ground: tools.ground,
});

const EDGES: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 0], // 바닥
  [4, 5], [5, 6], [6, 7], [7, 4], // 지붕
  [0, 4], [1, 5], [2, 6], [3, 7], // 기둥
];

async function main(): Promise<void> {
  mkdirSync('docs/assets/assoc', { recursive: true });
  console.log('| 프리셋 | det | seg | kept | matched | 육면체 | 강등 | 미정합 | segMs | buildMs | depthDev | phaseDev |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');

  for (const p of [1, 2, 3]) {
    const jpg = readFileSync(`data/refframes/cam1_p${p}.jpg`);
    const ctx = await resolve(1, p);
    if (!ctx) {
      console.log(`| p${p} | — | — | — | — | — | — | — | — | — | 지면모델 없음 | |`);
      continue;
    }
    // ── 라우트와 **동일한 호출 순서** ──────────────────────────────────────────
    const det = await vpd.detect(jpg); // ★ 권위.
    const polysNorm = ctx.slotPolysPx.map((poly) => poly.map((q) => ({ x: q.x / ctx.model.imgW, y: q.y / ctx.model.imgH })));
    const filt = filterVehiclesOnPlace(det.map((b, i) => ({ rect: b.rect, i })), polysNorm);
    const fc = await buildFrameCuboids({
      jpeg: jpg,
      detBoxes: det,
      keptDetIdx: filt.kept.map((k) => k.i),
      vpd,
      ctx,
    });

    const a = fc.anchor;
    console.log(
      `| p${p} | ${fc.summary.detCount} | ${fc.summary.segCount} | ${fc.summary.kept} | ${fc.summary.matched} | ` +
        `${fc.summary.cuboidCount} | ${fc.summary.rejectedCount} | ${fc.summary.unmatchedDet} | ${fc.summary.segMs} | ${fc.summary.buildMs} | ` +
        `${a.depthDevM?.toFixed(2) ?? '—'} | ${a.phaseDevM?.toFixed(2) ?? '—'} |`,
    );
    for (const r of fc.rejected) console.log(`   · 강등 det#${r.vpdIdx}: ${r.issues.join(' / ')}`);
    for (const u of fc.unmatched) console.log(`   · 미정합 det#${u.detIdx}: ${u.reason}`);
    for (const i of fc.issues) console.log(`   · issue: ${i}`);

    // ── 육안 합성(G3/G4) — 슬롯(청록) + det bbox(회색) + 차량 육면체(주황, W prior 강등은 점선) ──
    const parts: string[] = [];
    for (const poly of ctx.slotPolysPx) {
      parts.push(`<polygon points="${poly.map((q) => `${q.x},${q.y}`).join(' ')}" fill="none" stroke="#00e5ff" stroke-width="2"/>`);
    }
    for (const b of det) {
      const r = b.rect;
      parts.push(
        `<rect x="${r.x * fc.imgW}" y="${r.y * fc.imgH}" width="${r.w * fc.imgW}" height="${r.h * fc.imgH}" fill="none" stroke="#888" stroke-width="1.5"/>`,
      );
    }
    for (const c of fc.cuboids) {
      const px = projectCuboidPixels(c.floorGround, c.heightM, ctx.model);
      if (!px) continue;
      const dash = c.source.W === 'prior' ? ' stroke-dasharray="6 4"' : '';
      for (const [i, j] of EDGES) {
        parts.push(`<line x1="${px[i].x}" y1="${px[i].y}" x2="${px[j].x}" y2="${px[j].y}" stroke="#ff9f0a" stroke-width="3"${dash}/>`);
      }
      // 바닥면을 반투명으로 채운다 — **G4: 이 면이 바퀴에 닿는가**(배치의 유일한 근거이자 오판 가능한 근거).
      parts.push(`<polygon points="${px.slice(0, 4).map((q) => `${q.x},${q.y}`).join(' ')}" fill="#ff9f0a" fill-opacity="0.25"/>`);
      parts.push(
        `<text x="${px[0].x}" y="${px[0].y - 6}" font-size="24" fill="#ff9f0a" stroke="black" stroke-width="0.7">det#${c.vpdIdx} W=${c.widthM.toFixed(2)}${c.source.W === 'prior' ? '(prior)' : ''}</text>`,
      );
    }
    const svg = `<svg width="${fc.imgW}" height="${fc.imgH}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
    await sharp(jpg).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(`docs/assets/assoc/cuboid_p${p}.png`);
  }
  console.log('\n육안 합성 저장: docs/assets/assoc/cuboid_p{1,2,3}.png (청록=슬롯 / 회색=det bbox / 주황=육면체, 점선=W prior 강등)');
}

main().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
