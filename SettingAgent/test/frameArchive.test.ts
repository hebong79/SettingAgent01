// 27-B — 검출 프레임 아카이브. **저장·보존·재현 계약**과 "검출을 절대 실패시키지 않는다"를 못 박는다.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_FRAME_ARCHIVE_DIR,
  archiveDetectFrame,
  archiveStamp,
  frameArchiveDir,
  frameArchiveEnabled,
  frameHashOf,
  pruneFrameArchive,
  type FrameArchiveMeta,
} from '../src/capture/frameArchive.js';

let dir: string;
const saved = { on: process.env.ROI_FRAME_ARCHIVE, dir: process.env.ROI_FRAME_ARCHIVE_DIR };

/** 최소 메타 — 필드 하나하나가 재현 계약이라 임의로 줄이지 않는다. */
function metaOf(hash: string, capturedAt: string): FrameArchiveMeta {
  return {
    frameHash: hash,
    capturedAt,
    timing: { ptzQueriedAt: null, frameRequestedAt: capturedAt, frameReceivedAt: capturedAt, ptzToFrameMs: null, note: 'test' },
    source: { id: 'simulator-1', kind: 'rpc', requested: null },
    target: { key: '1:current', camId: 1, presetIdx: 1, view: 'current', dPanDeg: 0, dTiltDeg: 0 },
    ptz: { viewer: { pan: 19.8, tilt: 8.7, zoom: 1.6934098 }, requested: null, native: { zoom: 4956, tilt: 1668 } },
    intrinsics: {
      source: 'test',
      fovDeg: 58.00001516331988,
      fovAxis: 'horizontal',
      fovAtZoom: 'zoom1',
      tiltDeg: 8.7,
      heightM: 5,
      imgW: 1920,
      imgH: 1080,
      focalPx: 2932.791547272291,
      hfovDegEffective: 36.249978149775934,
    },
    groundModel: { f: 2932.791547272291, n: [0, 0.9884938868086836, 0.1512608202472192], d: 5, tiltDeg: 8.7, issues: [] },
    options: { slotWidthM: 2.5, slotDepthM: 5, cameraHeightM: 5, expectedBays: 0, coverageDenom: 'phaseInvariant', consensus: false },
    detect: { graded: true, greenRatio: 0, paintLines: 60, bays: 7, rows: 2, quadsNorm: [], issues: [] },
    files: { jpg: '' },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'framearch-test-'));
  process.env.ROI_FRAME_ARCHIVE_DIR = dir;
  delete process.env.ROI_FRAME_ARCHIVE; // 기본(ON) 을 이 스위트에서 실제로 확인한다.
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (saved.on === undefined) delete process.env.ROI_FRAME_ARCHIVE;
  else process.env.ROI_FRAME_ARCHIVE = saved.on;
  if (saved.dir === undefined) delete process.env.ROI_FRAME_ARCHIVE_DIR;
  else process.env.ROI_FRAME_ARCHIVE_DIR = saved.dir;
});

describe('frameArchive — 스위치·경로', () => {
  it('기본은 ON 이고 ROI_FRAME_ARCHIVE=0 으로만 꺼진다', () => {
    expect(frameArchiveEnabled()).toBe(true);
    process.env.ROI_FRAME_ARCHIVE = '0';
    expect(frameArchiveEnabled()).toBe(false);
    process.env.ROI_FRAME_ARCHIVE = '1';
    expect(frameArchiveEnabled()).toBe(true);
  });

  it('저장 위치는 호출 시점에 읽는다(테스트가 갈아끼울 수 있어야 한다)', () => {
    expect(frameArchiveDir()).toBe(dir);
    delete process.env.ROI_FRAME_ARCHIVE_DIR;
    expect(frameArchiveDir()).toBe(DEFAULT_FRAME_ARCHIVE_DIR);
  });

  it('파일명 스탬프는 콜론이 없고 사전순 = 시간순이다', () => {
    const a = archiveStamp(new Date('2026-07-31T03:45:22.489Z'));
    const b = archiveStamp(new Date('2026-07-31T03:45:22.490Z'));
    expect(a).toBe('20260731T034522489Z');
    expect(a).not.toMatch(/[:]/);
    expect(a < b).toBe(true);
  });

  it('frameHashOf 는 검출 경로와 같은 식(sha256 앞 12자리)이다', () => {
    const jpg = Buffer.from('hello frame');
    expect(frameHashOf(jpg)).toBe(createHash('sha256').update(jpg).digest('hex').slice(0, 12));
    expect(frameHashOf(jpg)).toHaveLength(12);
  });
});

describe('frameArchive — 저장', () => {
  it('frameHash 를 파일명에 넣어 그림과 사이드카를 짝으로 남긴다', async () => {
    const jpg = Buffer.from('JPEGBYTES');
    const hash = frameHashOf(jpg);
    const r = await archiveDetectFrame(jpg, metaOf(hash, '2026-07-31T03:45:22.489Z'));
    expect(r).not.toBeNull();
    const names = readdirSync(dir).sort();
    expect(names).toEqual([`20260731T034522489Z_${hash}.jpg`, `20260731T034522489Z_${hash}.json`]);
    // ★ 이 기능의 목적 — 해시만으로 프레임을 찾을 수 있어야 한다.
    expect(names.filter((n) => n.includes(hash))).toHaveLength(2);
    expect(readFileSync(join(dir, names[0]))).toEqual(jpg);
  });

  it('사이드카는 재현 입력을 **반올림 없이** 담고 jpg 파일명을 가리킨다', async () => {
    const jpg = Buffer.from('JPEGBYTES');
    const hash = frameHashOf(jpg);
    const r = await archiveDetectFrame(jpg, metaOf(hash, '2026-07-31T03:45:22.489Z'));
    const m = JSON.parse(readFileSync(r!.metaFile, 'utf8'));
    expect(m._schema).toBe('parkagent.detectFrame/1');
    expect(m._precision).toBe('raw');
    expect(m.files.jpg).toBe(`20260731T034522489Z_${hash}.jpg`);
    // round5 였다면 58.00002 가 됐을 값. 재현이 목적이므로 잘리면 안 된다.
    expect(m.intrinsics.fovDeg).toBe(58.00001516331988);
    expect(m.groundModel.f).toBe(2932.791547272291);
    expect(m.ptz.native).toEqual({ zoom: 4956, tilt: 1668 });
    expect(m.options.coverageDenom).toBe('phaseInvariant');
  });

  it('꺼져 있으면 아무 파일도 만들지 않고 null 을 돌려준다', async () => {
    process.env.ROI_FRAME_ARCHIVE = '0';
    expect(await archiveDetectFrame(Buffer.from('x'), metaOf('a'.repeat(12), '2026-07-31T00:00:00.000Z'))).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('쓰기 실패는 throw 하지 않는다 — 진단 산출물이 검출을 인질로 잡지 않는다', async () => {
    // 디렉터리 자리에 **파일**을 둬서 mkdir 를 실패시킨다.
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, 'not a directory');
    process.env.ROI_FRAME_ARCHIVE_DIR = join(blocked, 'sub');
    await expect(archiveDetectFrame(Buffer.from('x'), metaOf('b'.repeat(12), '2026-07-31T00:00:00.000Z'))).resolves.toBeNull();
  });
});

describe('frameArchive — 보존정책', () => {
  /** 스탬프가 다른 쌍 n 개를 만든다(사전순 = 오래된 것 먼저). */
  async function seed(n: number, bytes = 100): Promise<string[]> {
    const hashes: string[] = [];
    for (let i = 0; i < n; i++) {
      const jpg = Buffer.alloc(bytes, i);
      const hash = frameHashOf(jpg);
      hashes.push(hash);
      await archiveDetectFrame(jpg, metaOf(hash, new Date(Date.UTC(2026, 6, 31, 0, 0, i)).toISOString()));
    }
    return hashes;
  }

  it('개수 상한을 넘으면 오래된 쌍부터 지운다(짝 단위)', async () => {
    const hashes = await seed(6);
    const removed = await pruneFrameArchive(dir, { maxEntries: 4, maxBytes: 1e12 });
    expect(removed).toBe(2);
    const names = readdirSync(dir);
    expect(names).toHaveLength(8); // 4쌍
    for (const h of hashes.slice(0, 2)) expect(names.some((n) => n.includes(h))).toBe(false);
    for (const h of hashes.slice(2)) expect(names.filter((n) => n.includes(h))).toHaveLength(2);
  });

  it('용량 상한도 집행한다', async () => {
    await seed(5, 10_000);
    const removed = await pruneFrameArchive(dir, { maxEntries: 1000, maxBytes: 25_000 });
    expect(removed).toBeGreaterThanOrEqual(3);
    const kept = readdirSync(dir).filter((n) => n.endsWith('.jpg'));
    expect(kept.length).toBeLessThanOrEqual(2);
  });

  it('아카이브 규약에 맞지 않는 파일은 건드리지 않는다', async () => {
    await seed(3);
    writeFileSync(join(dir, 'README.md'), '손대지 마라');
    await pruneFrameArchive(dir, { maxEntries: 0, maxBytes: 0 });
    expect(readdirSync(dir)).toEqual(['README.md']);
  });

  it('없는 디렉터리에서도 조용히 0 을 돌려준다', async () => {
    expect(await pruneFrameArchive(join(dir, 'nope'))).toBe(0);
  });
});

describe('frameArchive — 배선 봉인', () => {
  it('roiAuto 의 검출 경로가 아카이브를 부른다', () => {
    const src = readFileSync('src/rpc/services/roiAuto.ts', 'utf8');
    expect(src).toContain('archiveDetectFrame');
    // 강등 경로(오염·제원미상)도 남겨야 한다 — 그 프레임이야말로 나중에 봐야 할 것이다.
    expect(src.match(/return archive\(/g)?.length).toBe(3);
  });

  it('재현 도구는 서비스와 **같은 검출 코어**를 쓴다(두 벌 금지)', () => {
    const replay = readFileSync('src/tools/roiAutoReplay.ts', 'utf8');
    expect(replay).toContain("import { detectGridFromFrame } from '../rpc/services/roiAuto.js'");
    expect(replay).not.toContain('detectBaysWithModel'); // 코어를 다시 짜지 않았다.
  });

  it('아카이브는 정본·DB 를 건드리지 않는다', () => {
    // 주석의 언급("정본 PtzCamRoi.json 에 쓰지 않는다")은 참조가 아니다 — **import 줄만** 본다.
    const imports = readFileSync('src/capture/frameArchive.ts', 'utf8')
      .split('\n')
      .filter((l) => /^\s*import\b/.test(l))
      .join('\n');
    for (const sym of ['SqliteStore', 'placeRoi', 'PtzCamRoi', 'Finalizer', 'sqlite']) {
      expect(imports.includes(sym), `frameArchive 가 "${sym}" 를 import 한다 — 아카이브는 정본이 아니다`).toBe(false);
    }
    expect(imports).toContain("from 'node:fs/promises'");
  });
});
