// 검출 프레임 아카이브 재현기(27-B) — 저장된 프레임 1장으로 **그때 그 검출을 다시 돌린다**.
//
// 사용:
//   npx tsx src/tools/roiAutoReplay.ts <사이드카.json | frameHash>
//   npx tsx src/tools/roiAutoReplay.ts --all            # 아카이브 전량 재현
//
// 이 도구의 존재 이유가 곧 아카이브의 존재 이유다: **재현되지 않으면 저장할 가치가 없다.**
// 검출 코어는 서비스와 **같은 함수**(`detectGridFromFrame`)를 부른다 — 두 벌로 두면 "재현"이 거짓말이 된다.
//
// ★ 정본·DB 무접촉. 읽기만 한다.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { groundModelFromIntrinsics, type PresetIntrinsics } from '../ground/cameraIntrinsics.js';
import { detectGridFromFrame } from '../rpc/services/roiAuto.js';
import { frameArchiveDir, type FrameArchiveMeta } from '../capture/frameArchive.js';
import { quadToNormalized } from '../ground/bayGeometry.js';

/** 사이드카 경로 해석 — 파일 경로 그대로이거나, frameHash 로 아카이브에서 찾는다. */
function resolveMetaFiles(arg: string): string[] {
  const dir = frameArchiveDir();
  if (arg === '--all') {
    return readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .sort()
      .map((n) => join(dir, n));
  }
  if (arg.endsWith('.json')) return [arg];
  const hits = readdirSync(dir).filter((n) => n.endsWith('.json') && n.includes(arg));
  if (!hits.length) throw new Error(`frameHash "${arg}" 에 해당하는 사이드카가 ${dir} 에 없다`);
  return hits.sort().map((n) => join(dir, n));
}

async function replayOne(metaFile: string): Promise<boolean> {
  const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as FrameArchiveMeta;
  const jpgFile = join(metaFile.replace(/[^\\/]+$/, ''), meta.files.jpg);
  const i = meta.intrinsics;
  console.log(`\n=== ${metaFile}`);
  console.log(
    `  frame ${meta.frameHash} · ${meta.capturedAt} · ${meta.source.id}(${meta.source.kind}) · ` +
      `cam${meta.target.camId}/p${meta.target.presetIdx} view=${meta.target.view}`,
  );
  if (!meta.groundModel || i.fovDeg == null || i.tiltDeg == null || i.heightM == null || i.fovAxis == null) {
    console.log(`  ⏭ 재현 생략 — 그때 지면모델이 없었다(강등 프레임). detect.graded=${meta.detect.graded}`);
    return true;
  }

  const jpg = readFileSync(jpgFile);
  const buf = await sharp(jpg).greyscale().raw().toBuffer();
  const frame = { data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), width: i.imgW, height: i.imgH };

  const intr: PresetIntrinsics = {
    camIdx: meta.target.camId,
    presetIdx: meta.target.presetIdx,
    fovDeg: i.fovDeg,
    fovAxis: i.fovAxis,
    tiltDeg: i.tiltDeg,
    heightM: i.heightM,
    imgW: i.imgW,
    imgH: i.imgH,
    source: i.source ?? 'archive',
    ...(i.fovAtZoom ? { fovAtZoom: i.fovAtZoom as 'zoom1' } : {}),
  };
  const model = groundModelFromIntrinsics(intr, meta.ptz.viewer.zoom);
  if (!model) {
    console.log('  ✗ 지면모델 재구성 실패 — 사이드카의 제원이 모자라다');
    return false;
  }
  const fOk = model.f === meta.groundModel.f;
  const { grid, lines } = detectGridFromFrame(frame, model, meta.options);
  const quads = (grid.best?.quads ?? []).map((q) => ({
    latticeIndex: q.latticeIndex,
    quad: quadToNormalized(q.quad, i.imgW, i.imgH),
  }));

  // 비트 동일 비교 — toFixed 판정을 쓰지 않는다(무회귀는 원시 배정도).
  const expect = JSON.stringify(meta.detect.quadsNorm);
  const actual = JSON.stringify(quads);
  const same = expect === actual;
  console.log(`  f  기록 ${meta.groundModel.f} · 재현 ${model.f} → ${fOk ? '동일' : '★불일치'}`);
  console.log(`  도색선 기록 ${meta.detect.paintLines} · 재현 ${lines} · 면 기록 ${meta.detect.bays} · 재현 ${quads.length}`);
  console.log(`  quad 정규화 좌표 비트 비교: ${same ? '전부 동일 ✔' : '★불일치'}`);
  if (!same) {
    console.log(`    기록: ${expect.slice(0, 400)}`);
    console.log(`    재현: ${actual.slice(0, 400)}`);
  }
  return fOk && same && lines === meta.detect.paintLines;
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error('사용: npx tsx src/tools/roiAutoReplay.ts <사이드카.json | frameHash | --all>');
    process.exit(2);
  }
  const files = resolveMetaFiles(arg);
  let ok = 0;
  for (const f of files) if (await replayOne(f)) ok += 1;
  console.log(`\n★ 재현 ${ok}/${files.length} 일치`);
  process.exit(ok === files.length ? 0 : 1);
}

void main();
