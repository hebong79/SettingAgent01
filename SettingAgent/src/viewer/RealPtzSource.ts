import { HucomsClient } from '../clients/hucoms/HucomsClient.js';
import type { CameraSourceConfig } from '../config/toolsConfig.js';
import { logger } from '../util/logger.js';
import { SimulatorMjpegAdapter } from '../stream/SimulatorMjpegAdapter.js';
import type { StreamAdapter } from '../stream/StreamAdapter.js';
import type { CameraList, CameraSource, Ptz, SnapshotOpts, SnapshotResult } from './CameraSource.js';

/** HTTP API Hucoms V1.22 원시 PTZ 범위. */
const HUCOMS_DEFAULT_PAN_RANGE: [number, number] = [0, 35999];
const HUCOMS_DEFAULT_TILT_RANGE: [number, number] = [-2000, 9000];
/**
 * ★ 이 기본값은 **사양서상 최대 폭**이지 개별 장비의 실제 상한이 아니다 — 장비별로 config 로 지정해야 한다.
 *   실측(2026-07-21 마스터 실카 세션, `logs/setting_20260721_*.log`): 192.168.0.153 은 zoom raw 가
 *   **16384(=2^14)에서 포화**한다. 명령을 65535 까지 올려도 getptzfpos 보고값이 16384 를 **단 한 번도** 넘지 않았고
 *   (pan/tilt 는 목표에 정확 도달), 그 위 명령은 매번 정착 타임아웃만 태웠다.
 *   → 그 장비들은 `cameraSources[].ptz.zoomRange: [0, 16384]` 로 지정되어 있다(config/tools.config.json).
 * ★ 기본 상수는 **의도적으로 바꾸지 않는다**: 여기서 16384 로 낮추면 실제로 65535 를 쓰는 다른 모델에서
 *   가용 배율의 3/4 을 조용히 잃는다. 신규 장비는 반드시 config 로 상한을 실측·지정할 것.
 */
const HUCOMS_DEFAULT_ZOOM_RANGE: [number, number] = [0, 65535];

/** SettingViewer의 기존 공통 좌표계. */
const VIEWER_PAN_RANGE: [number, number] = [-180, 180];
const VIEWER_TILT_RANGE: [number, number] = [-90, 90];
const VIEWER_ZOOM_RANGE: [number, number] = [1, 36];

/**
 * ptz_centering setcenter 의 좌표 기준 해상도(HTTP API Hucoms V1.22: 0~1920 / 0~1080 고정).
 * 스트림 해상도가 다르더라도 장비는 이 기준으로 해석하므로 정규화 좌표를 여기에 매핑한다.
 */
const CENTERING_BASE_WIDTH = 1920;
const CENTERING_BASE_HEIGHT = 1080;

/**
 * 실기 슬루 정착(settle) 폴링 상수.
 *
 * 시뮬(Unity)은 setPTZ 가 즉시 반영돼 move() 가 바로 반환해도 무방하지만, 실기(Hucoms)는
 * goptzfpos 204 를 받은 직후에도 팬/틸트/줌이 수 초에 걸쳐 슬루한다. 이동 완료를 확인하지 않고
 * 반환하면 폐루프(plate-zoom)가 "아직 움직이지 않은 프레임"을 측정해 오차가 그대로라 판단하고
 * 스텝을 계속 키운다(실측: 750ms 간격 연속 발사, zoompos 12007→16171→21584→28621 진동, x36 포화).
 */
const SETTLE_POLL_MS = 150;      // 실측 폐루프 재촬영 간격(~750ms)보다 촘촘해야 정지 판정이 늦지 않다.
/**
 * 정착 대기 상한(ms). **5000 → 15000 상향**(실측 근거).
 *
 * 근거: 5초로는 긴 줌 이동이 끝나지 않는다는 것이 라이브 로그에 반복 관측됐다.
 *   최악 관측(`logs/setting_20260721_163311.log`): 줌아웃 raw 16384 → 목표 2478(Δ13906) 명령에서
 *   5.03초 경과 시점의 실측이 10095 = **Δ6289 밖에 못 갔다**(≈1250 raw/s). 같은 로그의 다른 줌아웃 6건도
 *   전부 동일 양상. 이 속도면 전 구간(16384) 이동에 **약 13초**가 필요하다 → 15초는 약 15% 여유.
 *   pan/tilt 는 관측된 전 사례에서 5초 안에 목표 도달했으므로 지배 요인은 줌이다.
 *
 * ★ 트레이드오프(은닉 금지): 장비가 **실제로 응답 불능**이거나 도달 불가 목표를 받은 경우, 이제
 *   이동 1회가 최대 15초 UI 를 멈춘다(기존 5초). 미정착 반환이 곧 오조준(센터링 부분 취소)이라
 *   "빨리 틀리는 것"보다 "늦게 맞는 것"을 택한 것이다. 사다리는 rung 마다 이 대기를 물 수 있으므로
 *   도달 불가 구간을 조기에 끊는 장치가 함께 필요하다(→ platePtz 의 zoomAct 정체 판정).
 */
const SETTLE_TIMEOUT_MS = 15000;
/**
 * 목표를 모르는 이동(ptz_centering setcenter)의 **슬루 시작 유예**(폴링 횟수).
 *
 * setcenter 는 목표 좌표를 응답하지 않아 `isNearTarget` 을 쓸 수 없고 "정지"만으로 판정해야 하는데,
 * 명령 직후 아직 슬루를 시작하지 않은 구간도 "연속 동일"로 보인다(waitUntilSettled 주석의 그 함정).
 * 그래서 **한 번이라도 움직인 것을 본 뒤에만** 정지 판정을 받아들이고, 이 시간 안에 전혀 움직이지 않으면
 * "이미 그 지점이 중앙이라 이동이 없었다"(no-op)로 보고 즉시 반환한다.
 *
 * 7회 근거: 기본 폴링 150ms × 7 ≈ 1050ms 로, 사다리가 지금까지 setcenter 뒤에 **무조건** 물던
 * 고정 대기값(1000ms)과 같은 크기다. 이보다 짧으면 슬루 시작 전에 no-op 으로 오판해 조기 반환하게 되어
 * 이번에 고치는 버그가 되살아난다. 틀렸을 때의 대가는 비대칭이다 — 길면 진짜 no-op 이 1초 기다릴 뿐이고
 * (현행과 동일), 짧으면 오조준이다. ★ ms 가 아니라 폴링 횟수로 표현해 폴링 주기를 주입(테스트)해도 정합한다.
 */
const SETTLE_START_GRACE_POLLS = 7;

/**
 * **정지했으나 목표 미달** 판정에 필요한 연속 동일 샘플 수(수정 15).
 *
 * 배경: `waitUntilSettled` 는 "정지 AND 목표 근접"을 모두 요구해서, 장비가 **더 갈 의사가 없는데**
 * 목표에 못 닿은 상태(물리 상한·기계적 한계)에서 매번 타임아웃 전체를 태웠다. 수정 12 로 5→15초가 되며 악화됐고,
 * 느린 장비에서는 rung 마다 15초 → 최악 수 분. 장비가 멈췄는데 기다리는 것은 무의미하다.
 *
 * 3회 근거: 기본 폴링 150ms × 3 = 450ms 무변화. 실측 줌 속도 ≈1250 raw/s 이면 150ms 마다 약 187 raw 가 변하므로
 * **실제로 움직이는 중에는 연속 3회가 동일할 수 없다**(인코더 양자화는 그보다 훨씬 작다). 즉 오탐 여지가 거의 없고,
 * 2회로 낮추면 폴링 지터 한 번에 정상 이동이 잘릴 수 있다.
 *
 * ★ 허용오차(EPS)가 원인이 아님을 실측으로 확인했다: 라이브 타임아웃 41건 중 **40건에서 pan/tilt 는
 *   이미 SETTLE_PAN_TILT_EPS(10) 이내에 도달**해 있었고 zoom 만 미달이었다(중앙값 4865 raw). 즉 문제는
 *   "허용오차가 빡빡해서"가 아니라 "장비가 도달할 수 없는 목표를 받아서"다 → EPS 는 건드리지 않는다.
 */
const SETTLE_STALL_SAMPLES = 3;

/** 정착 대기 종료 사유(로그·진단용). 호출측 제어 판정은 상위 계층(platePtz 의 zoomAct 정체)이 담당한다. */
type SettleOutcome = 'settled' | 'stopped_short' | 'no_motion' | 'timeout' | 'unavailable';
const SETTLE_PAN_TILT_EPS = 10;  // raw(팬 0~35999 / 틸트 -2000~9000) — 0.1° 수준의 도달 판정 여유.
const SETTLE_ZOOM_EPS = 300;     // raw(줌 0~65535) — 약 0.16x 에 해당하는 도달 판정 여유.

/** 정착 폴링 타이밍 주입구(테스트에서 0 으로 낮춰 실시간 대기를 없앤다). */
export interface RealPtzSettleOptions {
  pollMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

interface NativePtz {
  pan: number;
  tilt: number;
  zoom: number;
}

function mapRange(value: number, from: [number, number], to: [number, number]): number {
  const [a, b] = from;
  const [c, d] = to;
  if (b === a) return c;
  const ratio = Math.min(1, Math.max(0, (value - a) / (b - a)));
  return c + ratio * (d - c);
}

function finiteValue(values: Record<string, string>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = Number(values[key]);
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

/** 연속 두 폴링의 raw 값이 완전히 동일하면 정지로 본다. */
function isStopped(a: NativePtz, b: NativePtz): boolean {
  return a.pan === b.pan && a.tilt === b.tilt && a.zoom === b.zoom;
}

/** 목표 raw 값에 허용 오차 이내로 도달했는가. */
function isNearTarget(target: NativePtz, current: NativePtz): boolean {
  return (
    Math.abs(target.pan - current.pan) <= SETTLE_PAN_TILT_EPS &&
    Math.abs(target.tilt - current.tilt) <= SETTLE_PAN_TILT_EPS &&
    Math.abs(target.zoom - current.zoom) <= SETTLE_ZOOM_EPS
  );
}

/**
 * Hucoms 실물 카메라 어댑터.
 *
 * Agent 쪽 CameraSource 계약과 Hucoms HTTP API V1.22의 query 인증·JPEG·PTZF·MJPEG를 연결한다.
 * 자격증명은 HucomsClient 메모리에만 유지하고, Client 통신 로그에서는 passwd를 마스킹한다.
 */
export class RealPtzSource implements CameraSource {
  readonly kind = 'hucoms' as const;
  readonly streamTransport: StreamAdapter['transport'];
  private readonly client: HucomsClient;
  private readonly panRange: [number, number];
  private readonly tiltRange: [number, number];
  private readonly zoomRange: [number, number];
  private readonly streamAdapter: StreamAdapter;
  private lastPtz: Ptz = { pan: 0, tilt: 0, zoom: 1 };
  private readonly settlePollMs: number;
  private readonly settleTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private cfg: CameraSourceConfig,
    timeoutMs = 7000,
    streamAdapter?: StreamAdapter,
    settle: RealPtzSettleOptions = {},
  ) {
    const host = cfg.host ?? '127.0.0.1';
    const port = cfg.port ?? 80;
    this.client = new HucomsClient({
      baseUrl: cfg.baseUrl ?? `http://${host}:${port}`,
      username: cfg.username,
      password: cfg.password,
      timeoutMs,
    });
    this.panRange = cfg.ptz?.panRange ?? HUCOMS_DEFAULT_PAN_RANGE;
    this.tiltRange = cfg.ptz?.tiltRange ?? HUCOMS_DEFAULT_TILT_RANGE;
    this.zoomRange = cfg.ptz?.zoomRange ?? HUCOMS_DEFAULT_ZOOM_RANGE;
    this.settlePollMs = settle.pollMs ?? SETTLE_POLL_MS;
    this.settleTimeoutMs = settle.timeoutMs ?? SETTLE_TIMEOUT_MS;
    this.sleep = settle.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    // 직접 생성한 레거시 소비자는 Hucoms MJPEG를 유지한다. sourceRegistry의 실카메라는 RTSP adapter를 명시 주입한다.
    this.streamAdapter = streamAdapter ?? new SimulatorMjpegAdapter((_cam, _preset, signal) => this.client.iterMjpeg({ signal }));
    this.streamTransport = this.streamAdapter.transport;
  }

  /**
   * Hucoms V1.22에는 별도 login CGI가 없으므로 자격증명을 설정한 뒤 getservername으로 검증한다.
   * 실패하면 자격증명을 즉시 제거한다.
   */
  async login(user: string, pass: string): Promise<boolean> {
    this.client.setCredentials(user, pass);
    try {
      await this.client.getServerName();
      return true;
    } catch {
      this.client.clearCredentials();
      return false;
    }
  }

  async health(): Promise<boolean> {
    try {
      await this.client.getServerName();
      return true;
    } catch {
      return false;
    }
  }

  async listCameras(): Promise<CameraList> {
    return {
      // 물리 카메라는 camerapos preset을 장비에서 보유하지 않는다. UI 선택 안정성을 위해 현재 위치 항목 하나를 제공한다.
      cameras: [{ camIdx: 1, name: this.cfg.id, enabled: true, presets: [{ presetIdx: 1, label: '현재 위치' }] }],
    };
  }

  /** Hucoms 장비가 보고하는 현재 PTZF를 Viewer 좌표계로 변환해 반환한다. */
  async getPtz(_camera: number): Promise<Ptz> {
    // UI의 '현재 PTZ 불러오기'는 장비 응답이 필수다. 실패를 마지막 명령값으로 위장하지 않는다.
    return this.currentPtz(true);
  }

  async snapshot(camera: number, options: SnapshotOpts): Promise<SnapshotResult> {
    if (options.mode === 'manual' && options.ptz) await this.move(camera, options.ptz);
    const jpeg = await this.client.getJpeg();
    const ptz = await this.currentPtz();
    return { jpeg, ptz };
  }

  async move(_camera: number, ptz: Ptz): Promise<boolean> {
    const native = this.toNativePtz(ptz);
    const target: NativePtz = {
      pan: Math.round(native.pan),
      tilt: Math.round(native.tilt),
      zoom: Math.round(native.zoom),
    };
    await this.client.goPtzfPosition({
      ...target,
      panSpeed: 100,
      tiltSpeed: 100,
      zoomSpeed: 100,
    });
    // goptzfpos 204 는 "명령 수신"일 뿐 "이동 완료"가 아니다. 실제 정지를 확인한 뒤 반환한다.
    const outcome = await this.waitUntilSettled(target);
    this.lastPtz = ptz;
    // ★ 반환 계약(boolean)은 바꾸지 않는다: 'stopped_short' 는 **통신 실패가 아니라 장비의 물리 한계**이고,
    //   여기서 false 를 돌리면 수동 이동 UI 가 "PTZ 이동 실패"로 보이고 기하 폴백 경로가 aim_failed 로 죽는다.
    //   제어 판정은 상위 계층이 실측(zoomAct 연속 정체)으로 하며(platePtz), 이 계층은 **사실을 로그로 남기고**
    //   더 기다리지 않는 것까지가 책임이다. 위 warn 이 target/last/차이를 이미 기록한다.
    void outcome;
    return true;
  }

  /**
   * goptzfpos 이후 getptzfpos 를 폴링해 이동 완료를 확인한다.
   * 종료: (연속 2회 raw 값이 동일 = 정지) AND (목표 근접) → 반환.
   *   정지만으로 끊지 않는 이유: 명령 직후 아직 슬루를 시작하지 않은 구간도 "연속 동일"로 보이므로
   *   목표 근접을 함께 요구해야 조기 반환(= 이번 버그의 원인)을 막는다.
   * 상한 초과: warn 로그(목표·최종 raw·경과 ms)를 남기고 반환 — 폐루프를 죽이지 않는다(예외 미전파).
   * 폴링 실패/불완전 응답: 흡수하고 즉시 반환(위치 조회를 지원하지 않는 모델에 대한 currentPtz 강등 정책과 동일).
   */
  private async waitUntilSettled(target: NativePtz): Promise<SettleOutcome> {
    const startedAt = Date.now();
    let previous: NativePtz | undefined;
    let last: NativePtz | undefined;
    let moved = false;
    let still = 0;   // 연속 동일 샘플 수
    let polls = 0;
    while (Date.now() - startedAt < this.settleTimeoutMs) {
      await this.sleep(this.settlePollMs);
      let current: NativePtz | undefined;
      try {
        current = await this.readNativePtz();
      } catch {
        return 'unavailable';
      }
      if (!current) return 'unavailable';
      polls += 1;
      last = current;
      if (previous) {
        if (isStopped(previous, current)) {
          still += 1;
          if (isNearTarget(target, current)) return 'settled';       // 정상 정착.
          // [수정 15] 목표에 못 닿았지만 **장비가 더 갈 의사가 없다** → 기다림은 무의미하다.
          //   ① 움직였다가 멈춤(연속 SETTLE_STALL_SAMPLES) ② 애초에 출발조차 안 함(유예 소진)
          const stoppedShort = moved && still >= SETTLE_STALL_SAMPLES;
          const noMotion = !moved && polls >= SETTLE_START_GRACE_POLLS;
          if (stoppedShort || noMotion) {
            logger.warn(
              {
                cat: 'centering', target, last, elapsedMs: Date.now() - startedAt,
                d: { pan: target.pan - current.pan, tilt: target.tilt - current.tilt, zoom: target.zoom - current.zoom },
              },
              stoppedShort
                ? 'PTZ 가 정지했으나 목표 미달 — 조기 반환(장비 도달 한계로 판단)'
                : 'PTZ 가 명령 후 전혀 움직이지 않음 — 조기 반환(도달 불가 목표로 판단)',
            );
            return stoppedShort ? 'stopped_short' : 'no_motion';
          }
        } else {
          moved = true;
          still = 0;
        }
      }
      previous = current;
    }
    logger.warn(
      { cat: 'centering', target, last, elapsedMs: Date.now() - startedAt, timeoutMs: this.settleTimeoutMs },
      'PTZ 이동 정착 대기 상한 초과 — 미정착 상태로 반환',
    );
    return 'timeout';
  }

  /**
   * **목표를 모르는 이동**(setcenter)의 정착 대기 — "정지할 때까지"만 기다린다.
   * `waitUntilSettled` 와 달리 목표 근접을 요구할 수 없으므로, 조기 반환을 막기 위해
   * **움직임을 한 번 관측한 뒤의 정지**만 정착으로 인정한다(SETTLE_START_GRACE_MS 주석 참조).
   *
   * @returns true = 정지 확인(또는 애초에 이동 없음) / false = 상한 초과로 **미정착**.
   *          false 를 조용히 삼키면 슬루 중 PTZ 가 다음 명령의 기준이 되어 센터링이 부분 취소된다.
   */
  private async waitUntilStopped(): Promise<boolean> {
    const startedAt = Date.now();
    let previous: NativePtz | undefined;
    let last: NativePtz | undefined;
    let moved = false;
    let polls = 0;
    while (Date.now() - startedAt < this.settleTimeoutMs) {
      await this.sleep(this.settlePollMs);
      let current: NativePtz | undefined;
      try {
        current = await this.readNativePtz();
      } catch {
        return true; // 조회 미지원/실패 — currentPtz 강등 정책과 동일하게 흡수(대기할 근거가 없다).
      }
      if (!current) return true;
      polls += 1;
      last = current;
      if (previous) {
        if (!isStopped(previous, current)) moved = true;
        else if (moved) return true;                              // 움직였다가 멈췄다 = 정착.
        else if (polls >= SETTLE_START_GRACE_POLLS) return true;   // 끝내 안 움직였다 = no-op(이동 불요).
      }
      previous = current;
    }
    logger.warn(
      { cat: 'centering', last, elapsedMs: Date.now() - startedAt, timeoutMs: this.settleTimeoutMs },
      'setcenter 정착 대기 상한 초과 — 미정착으로 보고(호출측이 조준 실패 처리)',
    );
    return false;
  }

  /** 장비 raw PTZF 조회. 필드가 불완전하면 undefined(호출자가 정책을 정한다). */
  private async readNativePtz(): Promise<NativePtz | undefined> {
    const response = await this.client.getPtzfPosition();
    const pan = finiteValue(response.values, 'panpos', 'pan');
    const tilt = finiteValue(response.values, 'tiltpos', 'tilt');
    const zoom = finiteValue(response.values, 'zoompos', 'zoom');
    if (pan === undefined || tilt === undefined || zoom === undefined) return undefined;
    return { pan, tilt, zoom };
  }

  /**
   * 네이티브 지점 센터링(ptz_centering setcenter, type=point) — 지정 지점을 화면 중앙으로. pan/tilt 만 움직인다.
   * setcenter 응답에는 PTZ echo 가 없으므로 이동 후 장비 조회로 현재 PTZ 를 확정해 반환한다.
   *
   * ★ 정착 대기 필수(라이브 실패 반영): setcenter 204 는 "명령 수신"일 뿐이라 직후 조회는 **슬루 중 값**이다.
   *   그 값을 호출측이 다음 명령의 기준으로 쓰면 goptzfpos 가 카메라를 **슬루 중간 지점으로 실제로 되돌려**
   *   센터링을 부분 취소한다(슬루가 길수록 심함 = 먼 차량일수록 실패). 목표를 모르므로 "정지까지" 대기한다.
   *   미정착(타임아웃)은 삼키지 않고 settled:false 로 올린다 — 호출측이 조준 실패로 처리해야 한다.
   */
  async centerOnPoint(_camera: number, point: { x: number; y: number }): Promise<Ptz & { settled: boolean }> {
    await this.client.centerPtz({
      type: 'point',
      pointX: Math.round(clamp01(point.x) * CENTERING_BASE_WIDTH),
      pointY: Math.round(clamp01(point.y) * CENTERING_BASE_HEIGHT),
      speed: 50,
    });
    const settled = await this.waitUntilStopped();
    return { ...(await this.currentPtz()), settled };
  }

  async *streamMjpeg(
    camera: number,
    _presetIdx: number,
    signal: AbortSignal,
    ptz?: Ptz,
  ): AsyncGenerator<Buffer> {
    if (ptz) await this.move(camera, ptz);
    yield* this.streamAdapter.stream({ cam: camera, presetIdx: _presetIdx, signal, ptz });
  }

  toNativePtz(viewerPtz: Ptz): NativePtz {
    return {
      pan: mapRange(viewerPtz.pan, VIEWER_PAN_RANGE, this.panRange),
      tilt: mapRange(viewerPtz.tilt, VIEWER_TILT_RANGE, this.tiltRange),
      zoom: mapRange(viewerPtz.zoom, VIEWER_ZOOM_RANGE, this.zoomRange),
    };
  }

  fromNativePtz(native: unknown): Ptz {
    const value = native as NativePtz;
    return {
      pan: mapRange(value.pan, this.panRange, VIEWER_PAN_RANGE),
      tilt: mapRange(value.tilt, this.tiltRange, VIEWER_TILT_RANGE),
      zoom: mapRange(value.zoom, this.zoomRange, VIEWER_ZOOM_RANGE),
    };
  }

  private async currentPtz(requireDeviceResponse = false): Promise<Ptz> {
    try {
      const native = await this.readNativePtz();
      if (!native) {
        if (requireDeviceResponse) throw new Error('카메라 PTZF 위치 응답이 완전하지 않습니다');
        return this.lastPtz;
      }
      this.lastPtz = this.fromNativePtz(native);
    } catch (cause) {
      if (requireDeviceResponse) throw cause;
      // 일부 모델은 위치 조회를 지원하지 않으므로 마지막 성공 명령값으로 강등한다.
    }
    return this.lastPtz;
  }
}
