// 캘리브레이션 엔진용 카메라 포트 조립 — `realLensVerify.ts`(실카 실측으로 검증된 CLI)의 조립을
// 서버 모듈로 이식한 것. 새로 설계하지 않고 **동작이 확인된 코드를 옮긴다**.
//
// ★ 왜 RealPtzSource 를 재사용하지 않는가:
//   RealPtzSource 는 **뷰어 좌표계**(정규화 0~1 · 도 · 배율)로 말하고, 클릭에 **이미 렌즈 보정을
//   적용**한다. 캘리브레이션이 재려는 것은 바로 그 보정 이전의 장비 원오차이므로, 뷰어 소스를 통해
//   재면 "재려는 대상을 보정 너머로" 재게 된다(lens-calib runner.ts §1 rawAim 규칙).
//   엔진은 Hucoms 네이티브 단위(px 0~1920 · centidegree · zoompos)를 요구한다 → HucomsClient 직결.

import sharp from 'sharp';
import type { GrayFrame, HucomsCameraPort, Ptz } from '@parkagent/lens-calib';
import { HucomsClient } from '../clients/hucoms/HucomsClient.js';
import type { CameraSourceConfig } from '../config/toolsConfig.js';

/** 실카는 슬루 중 간헐적 fetch 실패를 낸다(네트워크·장비 부하). 일시 오류만 짧게 재시도한다. */
async function withRetry<T>(fn: () => Promise<T>, label: string, attempts: number, sleep: (ms: number) => Promise<void>): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await sleep(300 * (i + 1));
    }
  }
  throw new Error(`${label} ${attempts}회 실패: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

const num = (v: string | undefined, d = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export interface HucomsPortOptions {
  timeoutMs?: number;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** 소스 설정 → 접속 정보. baseUrl 우선, 없으면 host/port(레거시). */
export function resolveHucomsBaseUrl(src: Pick<CameraSourceConfig, 'baseUrl' | 'host' | 'port'>): string {
  if (src.baseUrl) return src.baseUrl;
  if (!src.host) throw new Error('Hucoms 카메라 접속 주소(baseUrl 또는 host)가 없습니다');
  return `http://${src.host}:${src.port ?? 80}`;
}

/**
 * cameraSources 항목 하나로 엔진용 포트를 만든다. `kind:'hucoms'` 만 허용한다 —
 * 시뮬레이터는 자기가 렌더하는 표로 조준하므로 이미 정확하고, 재는 것 자체가 무의미하다.
 */
export function makeHucomsCameraPort(src: CameraSourceConfig, options: HucomsPortOptions = {}): HucomsCameraPort {
  if (src.kind !== 'hucoms') throw new Error(`소스 "${src.id}" 는 실카(hucoms)가 아닙니다 — 렌즈 캘리브레이션 대상이 아닙니다`);
  const { timeoutMs = 8000, attempts = 4, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = options;
  const client = new HucomsClient({
    baseUrl: resolveHucomsBaseUrl(src),
    username: src.username ?? 'admin',
    password: src.password ?? '',
    timeoutMs,
  });
  const retry = <T>(fn: () => Promise<T>, label: string): Promise<T> => withRetry(fn, label, attempts, sleep);

  const getPtz = async (): Promise<Ptz> => {
    const r = await retry(() => client.getPtzfPosition(), 'getptzfpos');
    return { panpos: num(r.values.panpos), tiltpos: num(r.values.tiltpos), zoompos: num(r.values.zoompos) };
  };

  return {
    getPtz,
    setCenter: async ({ x, y, speed }) => {
      await retry(() => client.centerPtz({ type: 'point', pointX: Math.round(x), pointY: Math.round(y), speed: speed ?? 50 }), 'setcenter');
    },
    goPtz: async ({ panpos, tiltpos, zoompos, speed }) => {
      await retry(
        () =>
          client.goPtzfPosition({
            ...(panpos !== undefined ? { pan: Math.round(panpos) } : {}),
            ...(tiltpos !== undefined ? { tilt: Math.round(tiltpos) } : {}),
            ...(zoompos !== undefined ? { zoom: Math.round(zoompos) } : {}),
            panSpeed: speed ?? 50,
            tiltSpeed: speed ?? 50,
            zoomSpeed: speed ?? 50,
          }),
        'goptzfpos',
      );
    },
    snapshotGray: async (): Promise<GrayFrame> => {
      const jpeg = await retry(() => client.getJpeg(), 'jpeg');
      const { data, info } = await sharp(jpeg).greyscale().raw().toBuffer({ resolveWithObject: true });
      return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
    },
  };
}
