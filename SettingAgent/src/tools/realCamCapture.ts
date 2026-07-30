// 실카 낮 프레임 **예약 캡처**(18회차) — 사람 개입 없이 낮 프레임을 쌓기 위한 도구.
//
// 왜 별도 도구인가: 낮 프레임은 **그 시간에만 얻을 수 있는 희소 자원**이고, 검출·오버레이는 저장된
// 프레임 위에서 나중에 몇 번이든 재실행할 수 있다(골든 세트와 같은 논리). 캡처와 판정을 분리한다.
//
// ★ 실카에 **이동 명령을 보내지 않는다**. 리더가 실측 검증한 경로만 쓴다:
//   ① GET /viewer/api/ptz            → 현재 PTZ 를 읽고
//   ② GET /viewer/api/snapshot(mode=manual, pan/tilt/zoom = ①의 값) → 같은 자리를 그대로 캡처
//   ③ GET /viewer/api/ptz            → 전후 PTZ 가 그대로인지 확인(달라졌으면 경고 기록)
//   mode 는 필수 파라미터다(빠뜨리면 400). mode=preset 은 쓰지 않는다.
//
// ★ 정본(PtzCamRoi.json)·DB 무접촉. roi.auto.apply 호출 없음.
// ★ 실패해도 조용히 죽지 않는다 — 모든 실패를 reports/realcam_capture.log 에 남기고 exit≠0.
//
// 사용: npx tsx src/tools/realCamCapture.ts   (cwd = SettingAgent)

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { loadToolsConfig } from '../config/toolsConfig.js';
import { buildSourceRegistry } from '../viewer/sourceRegistry.js';

const VIEWER_BASE = 'http://localhost:13020';
const SOURCE_ID = 'real-camera-2';
const CAM_IDX = 1;      // 실카 소스는 카메라 1개(1-based).
const PRESET_IDX = 1;   // snapshot 의 preset 은 필수 숫자 — mode=manual 이라 이동에는 쓰이지 않는다.
const EXPECTED_BAYS = 10;

const OUT_DIR = 'test/fixtures/realCamDaylight';
const MANIFEST = join(OUT_DIR, 'manifest.json');
const LOG_FILE = 'reports/realcam_capture.log';
const OVERLAY_DIR = 'reports/overlay_daylight';

/** ①/③ PTZ 조회 타임아웃(ms). 실측 응답은 1초 미만이다. */
const PTZ_TIMEOUT_MS = 20_000;
/** ② 스냅샷 타임아웃(ms). 실측 0.89초지만 mode=manual 은 장비 정착 대기(상한 15초)를 거칠 수 있다. */
const SNAPSHOT_TIMEOUT_MS = 60_000;
/** roi.auto.detect 타임아웃(ms). Unity 미기동 시 roi.show2d 가 ~11초 타임아웃나는 알려진 현상을 흡수한다. */
const DETECT_TIMEOUT_MS = 120_000;
/** 오버레이 자식 프로세스 상한(ms). */
const OVERLAY_TIMEOUT_MS = 180_000;

export interface ViewerPtz {
  pan: number;
  tilt: number;
  zoom: number;
}

export interface NativePtz {
  panpos: number;
  tiltpos: number;
  zoompos: number;
}

/**
 * PTZ 전후 동일 판정 허용오차.
 *
 * 뷰어 값은 네이티브 raw 를 선형 사상한 것이라 raw 가 같으면 부동소수까지 같다. 다만 인코더가 1 스텝
 * 흔들리는 것까지 "누군가 조작 중"으로 오인하지 않도록 스텝 크기의 수 배를 허용한다.
 * (real-camera-2 기준 1 스텝 ≈ pan 0.01° / tilt 0.0164° / zoom 0.0021x — 사람이 만드는 변화는 도 단위다.)
 */
const PTZ_EPS_DEG = 0.05;
const PTZ_EPS_ZOOM = 0.05;

/** 캡처 전(①)·후(③) PTZ 가 실질적으로 같은가. 다르면 호출측이 경고를 기록한다. */
export function ptzUnchanged(before: ViewerPtz, after: ViewerPtz): boolean {
  return (
    Math.abs(before.pan - after.pan) <= PTZ_EPS_DEG &&
    Math.abs(before.tilt - after.tilt) <= PTZ_EPS_DEG &&
    Math.abs(before.zoom - after.zoom) <= PTZ_EPS_ZOOM
  );
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** 로컬 시각 → `YYYYMMDD_HHmmss`. 파일명·매니페스트 키의 단일 출처다. */
export function stampOf(d: Date): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

export function frameFileNameOf(stamp: string): string {
  return `frame_${stamp}.jpg`;
}

export function overlayFileNameOf(stamp: string): string {
  return `overlay_${stamp}.png`;
}

/** 로컬 시각 문자열(오프셋 포함) — UTC 만 남기면 "몇 시 조도인가"를 잃는다. */
export function localIsoOf(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    ` ${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export interface DaylightFrameEntry {
  file: string;
  capturedAtLocal: string;
  capturedAtUtc: string;
  /** ① 에서 읽은 PTZ = ② 스냅샷에 그대로 되돌려준 값. */
  viewerPtz: ViewerPtz;
  /** ③ 재조회 값. */
  viewerPtzAfter: ViewerPtz;
  /** 네이티브 환산(panpos/tiltpos/zoompos). 환산 경로를 못 얻으면 null 이고 사유를 nativePtzNote 에 적는다. */
  nativePtz: NativePtz | null;
  nativePtzNote?: string;
  /** ② 응답 헤더 X-PTZ-* (장비가 캡처 시점에 보고한 값). */
  snapshotPtz: ViewerPtz | null;
  sha256_12: string;
  bytes: number;
  imgW: number;
  imgH: number;
  /** ①③ 일치 여부. false = 캡처 중 누군가 카메라를 조작했을 수 있다. */
  ptzUnchanged: boolean;
}

export interface DaylightManifest {
  note: string;
  source: string;
  createdBy: string;
  frames: DaylightFrameEntry[];
}

const MANIFEST_HEAD = {
  note:
    '실카 낮 프레임 예약 캡처 세트. ① /viewer/api/ptz 로 현재 PTZ 를 읽고 ② mode=manual 로 같은 값을 되돌려 캡처 ' +
    '③ 다시 조회해 전후 일치를 기록한다(이동 명령 없음). ptzUnchanged:false 는 캡처 중 외부 조작 가능성이며 은닉하지 않는다.',
  source: `SettingAgent 13020 뷰어 프록시 · ${SOURCE_ID}(cam ${CAM_IDX})`,
  createdBy: '18회차 구현자 · src/tools/realCamCapture.ts',
} as const;

/**
 * 기존 매니페스트에 항목 1건을 **누적** 병합한다(기존 항목 보존).
 *
 * 기존 내용이 JSON 으로 읽히지 않으면 **던진다** — 여기서 새 파일로 갈아엎으면 그동안 쌓은 희소 자원의
 * 목록을 조용히 파괴한다. 캡처 자체는 이미 파일로 남아 있으므로 사람이 복구할 여지를 남기는 편이 낫다.
 */
export function mergeManifest(previous: string | null, entry: DaylightFrameEntry): DaylightManifest {
  let frames: DaylightFrameEntry[] = [];
  if (previous !== null && previous.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(previous);
    } catch (err) {
      throw new Error(`기존 manifest.json 파싱 실패 — 덮어쓰지 않는다: ${(err as Error).message}`);
    }
    const prevFrames = (parsed as { frames?: unknown }).frames;
    if (!Array.isArray(prevFrames)) throw new Error('기존 manifest.json 에 frames 배열이 없다 — 덮어쓰지 않는다');
    frames = prevFrames as DaylightFrameEntry[];
  }
  return { ...MANIFEST_HEAD, frames: [...frames, entry] };
}

/** 로그 1줄(파일 append 형식). 시각 없는 로그는 예약 실행에서 쓸모가 없다. */
export function logLine(now: Date, level: 'INFO' | 'WARN' | 'ERROR', message: string): string {
  return `[${localIsoOf(now)}] ${level} ${message}`;
}

/**
 * 로그 1줄을 **로그 파일과 표준출력 양쪽으로** 내보낸다.
 *
 * ★ 파일 append 는 실패할 수 있고, 실패해도 던지지 않는다: 래퍼(.cmd)로 예약 실행될 때는 cmd 가
 *   같은 파일을 배타 핸들로 열어 리다이렉트 중이라 여기서 여는 것이 EBUSY 로 막힌다(실측). 그 경우
 *   아래 console.log 가 그 리다이렉트를 타고 **같은 줄을 같은 파일에** 남기므로 기록은 유실되지 않는다.
 *   반대로 수동 실행(리다이렉트 없음)에서는 append 가 성공해 로그가 남는다. 즉 두 경로 중 항상 하나가 산다.
 */
function log(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
  const line = logLine(new Date(), level, message);
  try {
    mkdirSync('reports', { recursive: true });
    appendFileSync(LOG_FILE, `${line}\n`, 'utf8');
  } catch {
    // 위 주석 참조 — 표준출력이 같은 파일로 리다이렉트된 상태다.
  }
  console.log(line);
}

/**
 * GET 1회. 연결 실패(서버 미기동)는 fetch 가 `TypeError: fetch failed` 만 던져 **어느 단계에서 죽었는지**
 * 알 수 없다 — URL 을 붙여 되던진다(예약 실행에서는 로그가 유일한 증거다).
 */
async function get(url: string, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(`GET ${url} 실패: ${(err as Error).name}: ${(err as Error).message}`);
  }
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const res = await get(url, timeoutMs);
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function ptzOf(payload: unknown): ViewerPtz {
  const p = (payload as { ptz?: ViewerPtz }).ptz;
  if (!p || ![p.pan, p.tilt, p.zoom].every((v) => Number.isFinite(v))) {
    throw new Error(`PTZ 응답이 불완전하다: ${JSON.stringify(payload).slice(0, 200)}`);
  }
  return { pan: p.pan, tilt: p.tilt, zoom: p.zoom };
}

/** 헤더 X-PTZ-* → 뷰어 PTZ. 누락(구버전 프록시)이면 null 로 강등한다. */
function snapshotPtzOf(headers: Headers): ViewerPtz | null {
  const nums = ['X-PTZ-Pan', 'X-PTZ-Tilt', 'X-PTZ-Zoom'].map((k) => Number(headers.get(k)));
  return nums.every((v) => Number.isFinite(v)) ? { pan: nums[0], tilt: nums[1], zoom: nums[2] } : null;
}

/**
 * 뷰어 PTZ → 네이티브(panpos/tiltpos/zoompos). 17b/17c 가 쓴 경로(sourceRegistry 의 `toNativePtz`)를 그대로 재사용한다.
 * 순수 범위 사상이라 장비를 호출하지 않는다. 설정을 못 읽으면 지어내지 않고 사유와 함께 null 을 돌린다.
 */
export function toNativeOrNote(viewer: ViewerPtz): { native: NativePtz | null; note?: string } {
  try {
    const src = buildSourceRegistry(loadToolsConfig()).get(SOURCE_ID);
    if (!src) return { native: null, note: `sourceRegistry 에 ${SOURCE_ID} 없음 — 뷰어 PTZ 만 기록` };
    const n = src.toNativePtz(viewer) as { pan: number; tilt: number; zoom: number };
    return { native: { panpos: n.pan, tiltpos: n.tilt, zoompos: n.zoom } };
  } catch (err) {
    return { native: null, note: `네이티브 환산 실패 — 뷰어 PTZ 만 기록: ${(err as Error).message}` };
  }
}

/** 검출·오버레이(best-effort). 실패는 로그만 남기고 전체 실패로 만들지 않는다. */
async function detectAndOverlay(stamp: string): Promise<void> {
  try {
    const res = await fetch(`${VIEWER_BASE}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'roi.auto.detect',
        params: { source: SOURCE_ID, consensus: false, expectedBays: EXPECTED_BAYS },
      }),
      signal: AbortSignal.timeout(DETECT_TIMEOUT_MS),
    });
    const body = (await res.json()) as { error?: unknown; result?: { presets?: unknown[] } };
    if (body.error) log('WARN', `roi.auto.detect 오류(캡처는 성공): ${JSON.stringify(body.error).slice(0, 300)}`);
    else log('INFO', `roi.auto.detect 완료 — presets ${body.result?.presets?.length ?? 0}건`);
  } catch (err) {
    log('WARN', `roi.auto.detect 실패(캡처는 성공): ${(err as Error).message}`);
  }

  const outPng = join(OVERLAY_DIR, overlayFileNameOf(stamp));
  try {
    mkdirSync(OVERLAY_DIR, { recursive: true });
    // 17b 신규·17c 수정된 오버레이 도구를 그대로 재사용한다(알고리즘·인자 무변경).
    const r = spawnSync(
      'npx',
      ['tsx', 'src/tools/realFrameOverlay.ts', SOURCE_ID, outPng, String(EXPECTED_BAYS)],
      { shell: true, encoding: 'utf8', timeout: OVERLAY_TIMEOUT_MS },
    );
    if (r.status === 0) log('INFO', `오버레이 저장 — ${outPng}`);
    else log('WARN', `오버레이 실패(캡처는 성공) status=${r.status} ${String(r.stderr ?? r.error).slice(0, 300)}`);
  } catch (err) {
    log('WARN', `오버레이 실행 실패(캡처는 성공): ${(err as Error).message}`);
  }
}

async function main(): Promise<number> {
  const now = new Date();
  const stamp = stampOf(now);
  const file = frameFileNameOf(stamp);
  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = join(OUT_DIR, file);
  if (existsSync(outPath)) {
    // 같은 초에 이미 찍혔다 — 덮어쓰면 매니페스트와 파일이 어긋난다.
    log('INFO', `스킵 — 같은 초의 프레임이 이미 있다: ${outPath}`);
    return 0;
  }

  // ① 현재 PTZ
  const before = ptzOf(await fetchJson(`${VIEWER_BASE}/viewer/api/ptz?source=${SOURCE_ID}&cam=${CAM_IDX}`, PTZ_TIMEOUT_MS));

  // ② 같은 자리를 그대로 캡처(mode=manual — 이동 없음)
  const q =
    `source=${SOURCE_ID}&cam=${CAM_IDX}&preset=${PRESET_IDX}&mode=manual` +
    `&pan=${before.pan}&tilt=${before.tilt}&zoom=${before.zoom}`;
  const snap = await get(`${VIEWER_BASE}/viewer/api/snapshot?${q}`, SNAPSHOT_TIMEOUT_MS);
  if (!snap.ok) throw new Error(`snapshot → HTTP ${snap.status} ${(await snap.text()).slice(0, 200)}`);
  const jpg = Buffer.from(await snap.arrayBuffer());
  const snapshotPtz = snapshotPtzOf(snap.headers);

  // ③ 전후 PTZ 확인
  const after = ptzOf(await fetchJson(`${VIEWER_BASE}/viewer/api/ptz?source=${SOURCE_ID}&cam=${CAM_IDX}`, PTZ_TIMEOUT_MS));
  const unchanged = ptzUnchanged(before, after);
  if (!unchanged) {
    log(
      'WARN',
      `PTZ 가 캡처 전후로 달라졌다(누군가 조작 중일 수 있다) — 전 ${JSON.stringify(before)} 후 ${JSON.stringify(after)}`,
    );
  }

  const meta = await sharp(jpg).metadata();
  const nat = toNativeOrNote(before);
  if (nat.note) log('WARN', nat.note);

  const entry: DaylightFrameEntry = {
    file,
    capturedAtLocal: localIsoOf(now),
    capturedAtUtc: now.toISOString(),
    viewerPtz: before,
    viewerPtzAfter: after,
    nativePtz: nat.native,
    ...(nat.note ? { nativePtzNote: nat.note } : {}),
    snapshotPtz,
    sha256_12: createHash('sha256').update(jpg).digest('hex').slice(0, 12),
    bytes: jpg.length,
    imgW: meta.width ?? 0,
    imgH: meta.height ?? 0,
    ptzUnchanged: unchanged,
  };

  writeFileSync(outPath, jpg);
  const previous = existsSync(MANIFEST) ? readFileSync(MANIFEST, 'utf8') : null;
  writeFileSync(MANIFEST, `${JSON.stringify(mergeManifest(previous, entry), null, 2)}\n`, 'utf8');
  log(
    'INFO',
    `캡처 성공 — ${outPath} ${entry.bytes}B ${entry.imgW}×${entry.imgH} sha=${entry.sha256_12} ` +
      `ptz(${before.pan.toFixed(3)}, ${before.tilt.toFixed(3)}, ${before.zoom.toFixed(3)}) ` +
      `native(pan ${nat.native?.panpos ?? '?'} tilt ${nat.native?.tiltpos ?? '?'} zoom ${nat.native?.zoompos ?? '?'}) ` +
      `ptzUnchanged=${unchanged}`,
  );

  await detectAndOverlay(stamp);
  return 0;
}

if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      log('ERROR', `캡처 실패 — ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
      process.exit(1);
    });
}
