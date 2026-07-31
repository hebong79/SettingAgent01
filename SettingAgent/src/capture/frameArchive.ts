// 검출 프레임 아카이브 — **검출이 실제로 쓴 프레임**을 그 자리에서 디스크에 남긴다(27-B).
//
// ★ 왜 있는가(연구를 세 번 막았다):
//   · 25회차 — 마스터가 준 스샷 7장의 frameHash 를 저장소 전역에서 찾을 수 없어(0건) 수치 판정에서 제외했다.
//   · 26-1  — `reports/detcache_r24/` 가 main 에 없어 워크트리에서 복사해야 했다.
//   · 26-2  — 마스터 프레임 `24f2d7f77704` 의 픽셀이 어디에도 없어 리더 가설 근거 1건이 **영구 검증 불가**가 됐다.
//   14회차 실측이 이유를 못 박는다: **같은 PTZ·같은 코드인데 프레임에 따라 통과 면수 ±6면.**
//   frameHash 가 다른 두 관측은 애초에 비교 대상이 아니므로, 프레임이 없으면 「육안 → 가설 → 측정」이
//   첫 단계에서 끊긴다.
//
// ★ 이것은 **아카이브지 정본이 아니다.** 정본(`PtzCamRoi.json`)·DB 에 한 바이트도 쓰지 않는다.
//   쓰기 실패는 검출을 절대 실패시키지 않는다 — 진단 산출물이 기능을 인질로 잡으면 안 된다.
//
// ★ 반올림하지 않는다(`round5`/`stringify5` 를 쓰지 않는 유일한 쓰기 경로).
//   이 파일의 목적은 **그 프레임 하나로 검출을 그대로 재현**하는 것이고, 재현 입력인 fovDeg·tiltDeg·f 를
//   5자리로 자르면 quad 좌표가 8자리째부터 갈라져 "재현"이 성립하지 않는다. 5자리 규약은 좌표 **정본**의
//   규약이며 이 파일은 정본이 아니다(`_precision:"raw"` 로 그 사실을 파일 자신이 들고 다닌다).

import { createHash } from 'node:crypto';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../util/logger.js';

/** 기본 저장 위치. `reports/` 는 이미 "런타임 누적·커밋 제외"로 확립된 자리다(루트 .gitignore). */
export const DEFAULT_FRAME_ARCHIVE_DIR = 'reports/detect_frames';

/**
 * 보존 상한 — **개수와 용량 둘 다**. 실측 근거:
 *   실카 1920×1080 JPEG 1장 ≈ 0.2~0.4MB · 시뮬 ≈ 0.1~0.2MB · 사이드카 JSON ≈ 4~30KB.
 *   400장이면 최악(0.4MB) 기준 160MB 로 용량 상한 안이고, 다시점 합의(1검출 = 6프레임)로
 *   `roi.auto.score` 5프리셋을 돌려도 30장이라 **연속 13회분**이 남는다.
 * 둘 중 먼저 걸리는 쪽이 이긴다(오래된 것부터 삭제).
 */
export const FRAME_ARCHIVE_MAX_ENTRIES = 400;
export const FRAME_ARCHIVE_MAX_BYTES = 400 * 1024 * 1024;

/** 저장 위치. 테스트가 임시 디렉터리로 갈아끼울 수 있도록 **호출 시점에** 읽는다. */
export function frameArchiveDir(): string {
  return process.env.ROI_FRAME_ARCHIVE_DIR ?? DEFAULT_FRAME_ARCHIVE_DIR;
}

/**
 * 기본 **ON**. 끄려면 `ROI_FRAME_ARCHIVE=0`.
 * ON 이 기본인 근거: 저장 비용이 검출 1회(9~14초) 대비 **0.1% 미만**이고(구현자 실측),
 * 저장하지 않아 잃은 관측이 이미 3건 확인됐다. 사후에 되살릴 방법이 없는 자료다.
 */
export function frameArchiveEnabled(): boolean {
  return process.env.ROI_FRAME_ARCHIVE !== '0';
}

/** 파일명에 쓰는 시각 — 콜론 없는 압축 ISO(윈도 파일명 제약). 사전순 = 시간순. */
export function archiveStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.(\d{3})Z$/, '$1Z');
}

/** 검출 1회가 남기는 사이드카 본문. 필드 이름이 곧 재현 계약이다. */
export interface FrameArchiveMeta {
  frameHash: string;
  /** 프레임을 실제로 받은 시각(ISO). */
  capturedAt: string;
  timing: {
    /** 현재뷰 모드에서 `cam.getPTZ` 가 돌아온 시각. preset 모드는 null(그 경로는 PTZ 를 미리 읽지 않는다). */
    ptzQueriedAt: string | null;
    frameRequestedAt: string;
    frameReceivedAt: string;
    /** PTZ 를 읽은 시각 → 프레임을 받은 시각 간격(ms). null 이면 미측정. */
    ptzToFrameMs: number | null;
    note: string;
  };
  source: { id: string; kind: string; requested: string | null };
  target: {
    key: string;
    camId: number;
    presetIdx: number;
    view: 'preset' | 'current';
    /** 다시점 합의의 디더 시점 오프셋(도). 단일 시점이면 0/0. */
    dPanDeg: number;
    dTiltDeg: number;
  };
  ptz: {
    /** 캡처가 보고한 뷰어 단위 PTZ. */
    viewer: { pan: number; tilt: number; zoom: number };
    /** `requestImage` 에 넘긴 값. 실카는 넘기지 않으므로 null(= 무이동). */
    requested: { pan: number; tilt: number; zoom: number } | null;
    /** 장비 원시값(렌즈 실측표 조회 키 zoompos · tiltpos centidegree). 환산기 없으면 null. */
    native: { zoom: number | null; tilt: number | null };
  };
  /** 재현 입력. 이 블록 + jpg 만으로 `groundModelFromIntrinsics` 를 그대로 재구성한다. */
  intrinsics: {
    source: string | null;
    fovDeg: number | null;
    fovAxis: 'horizontal' | 'vertical' | null;
    fovAtZoom: 'zoom1' | null;
    tiltDeg: number | null;
    heightM: number | null;
    imgW: number;
    imgH: number;
    /** 이 프레임의 **유효** 초점거리(px) = 지면모델의 f. */
    focalPx: number | null;
    /** 이 프레임의 **유효** 수평화각(도). fovAxis·fovAtZoom·zoom 을 모두 반영한 값. */
    hfovDegEffective: number | null;
  };
  groundModel: { f: number; n: [number, number, number]; d: number; tiltDeg: number; issues: string[] } | null;
  /** 검출 옵션 전량 — 재현 시 그대로 넣는다. */
  options: {
    slotWidthM: number;
    slotDepthM: number;
    cameraHeightM: number | null;
    expectedBays: number;
    coverageDenom: 'expectedBays' | 'phaseInvariant';
    consensus: boolean;
  };
  /** 그 실행의 결과 요약. 재현 판정의 기대값이기도 하다. */
  detect: {
    graded: boolean;
    greenRatio: number;
    paintLines: number;
    /** `best` 행의 면 수. */
    bays: number;
    /** 문턱을 통과한 행 수. */
    rows: number;
    /** `best` quad 의 정규화 좌표(반올림 없음) — 재현 대조의 기준값. */
    quadsNorm: Array<{ latticeIndex: number; quad: Array<{ x: number; y: number }> }>;
    issues: string[];
  };
  files: { jpg: string };
}

/** 저장 결과(성능 실측·응답 노출용). */
export interface FrameArchiveResult {
  jpgFile: string;
  metaFile: string;
  bytes: number;
  writeMs: number;
  pruned: number;
}

/** 프레임 지문 — 검출 경로와 **같은 식**(sha256 앞 12자리). 두 곳이 갈라지면 조회가 조용히 실패한다. */
export function frameHashOf(jpg: Buffer): string {
  return createHash('sha256').update(jpg).digest('hex').slice(0, 12);
}

/**
 * 프레임 1장 + 메타를 남긴다. **절대 throw 하지 않는다** — 실패는 null 과 warn 로그로만 말한다.
 * 반환 null = 껐거나 실패했다는 뜻이며 호출자는 그대로 진행한다.
 */
export async function archiveDetectFrame(jpg: Buffer, meta: FrameArchiveMeta): Promise<FrameArchiveResult | null> {
  if (!frameArchiveEnabled()) return null;
  const dir = frameArchiveDir();
  const base = `${archiveStamp(new Date(meta.capturedAt))}_${meta.frameHash}`;
  const jpgFile = join(dir, `${base}.jpg`);
  const metaFile = join(dir, `${base}.json`);
  const t0 = Date.now();
  try {
    await mkdir(dir, { recursive: true });
    const body = JSON.stringify({ _schema: 'parkagent.detectFrame/1', _precision: 'raw', ...meta, files: { jpg: `${base}.jpg` } }, null, 2);
    await writeFile(jpgFile, jpg);
    await writeFile(metaFile, body, 'utf8');
    const writeMs = Date.now() - t0;
    const pruned = await pruneFrameArchive(dir);
    return { jpgFile, metaFile, bytes: jpg.byteLength + Buffer.byteLength(body), writeMs, pruned };
  } catch (err) {
    logger.warn({ cat: 'roiAuto', dir, frameHash: meta.frameHash, err: (err as Error).message }, '검출 프레임 아카이브 실패 — 검출은 계속한다');
    return null;
  }
}

/**
 * 보존 정책 집행 — 개수·용량 상한을 넘으면 **오래된 쌍부터** 지운다.
 * 짝(.jpg/.json)을 단위로 다루므로 사이드카만 남거나 그림만 남는 반쪽 상태가 생기지 않는다.
 * @returns 삭제한 쌍 수.
 */
export async function pruneFrameArchive(
  dir: string,
  limits: { maxEntries?: number; maxBytes?: number } = {},
): Promise<number> {
  const maxEntries = limits.maxEntries ?? FRAME_ARCHIVE_MAX_ENTRIES;
  const maxBytes = limits.maxBytes ?? FRAME_ARCHIVE_MAX_BYTES;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  const groups = new Map<string, string[]>();
  for (const n of names) {
    const m = /^(\d{8}T\d{9}Z_[0-9a-f]{12})\.(jpg|json)$/.exec(n);
    if (!m) continue;
    const g = groups.get(m[1]) ?? [];
    g.push(n);
    groups.set(m[1], g);
  }
  const entries: Array<{ base: string; files: string[]; bytes: number }> = [];
  for (const [base, files] of groups) {
    let bytes = 0;
    for (const f of files) {
      try {
        bytes += (await stat(join(dir, f))).size;
      } catch {
        /* 경합으로 사라진 파일은 0 으로 센다. */
      }
    }
    entries.push({ base, files, bytes });
  }
  entries.sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : 0)); // 사전순 = 오래된 것 먼저.
  let total = entries.reduce((s, e) => s + e.bytes, 0);
  let count = entries.length;
  let removed = 0;
  for (const e of entries) {
    if (count <= maxEntries && total <= maxBytes) break;
    for (const f of e.files) {
      try {
        await unlink(join(dir, f));
      } catch {
        /* 이미 없으면 목적 달성. */
      }
    }
    total -= e.bytes;
    count -= 1;
    removed += 1;
  }
  return removed;
}
