import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import type { ICameraClient } from '../clients/CameraClient.js';
import { CameraSourceClient } from '../clients/CameraSourceClient.js';
import type { CameraSource } from '../viewer/CameraSource.js';
import type { ToolsConfig } from '../config/toolsConfig.js';

/**
 * 라우트 계층 공용 헬퍼(리팩토링 설계서 §5.1·§5.2 — 1단계 순수 추가).
 *
 * 목적: captureRoutes/calibrateRoutes/viewer.routes 에 반복되는 스캐폴드
 * (Zod 검증→400, 파일에러→404/500, cam/preset 정수검증, JPEG 헤더, 소스카메라 해석)를
 * 한 곳에 모은다. **동작 불변** — 각 헬퍼는 기존 다수 호출부의 응답(상태코드·JSON 필드·
 * 에러 메시지 문자열)을 바이트 단위로 재현한다. 소수 예외 형태는 §각주로 명시하며 2단계에서
 * 헬퍼를 적용하지 않는다.
 *
 * 실패 응답을 보내는 헬퍼는 기존 `reply.code(n); return {...}` 대신 `reply.code(n).send({...})`
 * 로 즉시 전송하고 `undefined` 를 반환한다. 호출부 관용구:
 *   `const p = parseOr400(reply, Schema, input); if (!p) return;`
 * (Fastify 에서 reply.send() 이후 핸들러가 undefined 를 반환하는 것은 이중 전송이 아니다.)
 */

/**
 * Zod safeParse 실패 시 400 응답을 전송하고 undefined 반환. 성공 시 파싱값 반환.
 *
 * 재현 대상(다수 공통 형태): `reply.code(400); return { error: <msg>, detail: parsed.error.flatten() }`.
 * - captureRoutes: 192,269,378,666,849,870,906 (msg='invalid body')
 * - viewer/routes: 114,133,156,191,270,290,324,363,395 (msg='invalid query' 또는 'invalid body')
 *
 * `errorMsg` 는 호출부의 기존 문자열('invalid body'|'invalid query')을 그대로 전달한다.
 *
 * 미적용(소수 예외 — detail 없음/`ok:false` 포함): captureRoutes 489·519(`{ ok:false, error:'invalid body' }`),
 * 562(`{ ok:false, error:'invalid body (heightM 0.5~3.0)' }`). 2단계에서 헬퍼를 적용하지 않는다.
 */
export function parseOr400<S extends z.ZodTypeAny>(
  reply: FastifyReply,
  schema: S,
  input: unknown,
  errorMsg = 'invalid body',
): z.infer<S> | undefined {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    reply.code(400).send({ error: errorMsg, detail: parsed.error.flatten() });
    return undefined;
  }
  return parsed.data;
}

/**
 * 파일 에러 분기: ENOENT→404(notFoundMsg), 그 외→500(failMsg). detail 필드에 err.message 보존.
 *
 * 재현 대상(다수 공통 형태): `reply.code(ENOENT?404:500); return { error: <msg>, detail: e.message }`.
 * - captureRoutes: 653(GET place-roi), 676(PUT place-roi), 714(ground-model).
 *
 * 미적용(소수 예외 — `ok:false` 포함): captureRoutes 585(slots/cuboid,
 * `{ ok:false, error, detail }`). 2단계에서 헬퍼를 적용하지 않는다.
 */
export function fileErrorReply(
  reply: FastifyReply,
  err: unknown,
  notFoundMsg: string,
  failMsg: string,
): void {
  const e = err as NodeJS.ErrnoException;
  reply.code(e.code === 'ENOENT' ? 404 : 500).send({
    error: e.code === 'ENOENT' ? notFoundMsg : failMsg,
    detail: e.message,
  });
}

/**
 * cam/preset 쿼리 정수 검증(1-based). 0·음수·비정수·미지정을 거부한다.
 * 실패 시 400 전송 후 undefined, 성공 시 `{ cam, preset }`.
 *
 * 재현 대상(동일 두 곳): `reply.code(400); return { error: 'invalid cam/preset (1-based 정수)' }`.
 * - captureRoutes: 749~752(vehicle-cuboids), 830~833(job-cuboids).
 *
 * `Number(q.cam)`/`Number(q.preset)` 강제변환 후 `Number.isInteger && > 0` 검사 —
 * 기존 호출부의 판정식(`!Number.isInteger(x) || x <= 0`)을 그대로 재현한다.
 */
export function parseCamPreset(
  reply: FastifyReply,
  q: unknown,
): { cam: number; preset: number } | undefined {
  const query = (q ?? {}) as { cam?: unknown; preset?: unknown };
  const cam = Number(query.cam);
  const preset = Number(query.preset);
  if (!Number.isInteger(cam) || cam <= 0 || !Number.isInteger(preset) || preset <= 0) {
    reply.code(400).send({ error: 'invalid cam/preset (1-based 정수)' });
    return undefined;
  }
  return { cam, preset };
}

/**
 * JPEG 프레임 응답. Content-Type: image/jpeg + Cache-Control: no-store + 전달된 X-* 헤더를
 * 순서대로 세팅한 뒤 jpeg 를 전송한다.
 *
 * 재현 대상(다수 공통 형태): `reply.header('Content-Type','image/jpeg').header('Cache-Control','no-store')
 *   .header(<X-*>...); return reply.send(jpeg)`.
 * - captureRoutes: 356~364(/capture/frame, X-Cap-*)
 * - calibrateRoutes: 101~106(/calibrate/frame, X-Cal-*)
 * - viewer/routes: 178~184(/viewer/api/snapshot, X-PTZ-*)
 *
 * X-* 헤더는 `headers` 레코드로 전달한다(값은 이미 String 화된 상태). 헬퍼가 send 하므로
 * 호출부는 이후 `return reply;` 로 응답 위임을 마친다.
 */
export function sendJpeg(
  reply: FastifyReply,
  jpeg: Buffer,
  headers?: Record<string, string>,
): void {
  reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'no-store');
  if (headers) {
    for (const [k, v] of Object.entries(headers)) reply.header(k, v);
  }
  reply.send(jpeg);
}

/** resolveSourceCamera 성공 결과. source 미지정 시 둘 다 undefined(에러 아님, 호출부 계속 진행). */
export interface ResolvedSourceCamera {
  camera: ICameraClient | undefined;
  src: CameraSource | undefined;
}

/**
 * 소스카메라 해석 — calibrateRoutes(66~74) ≈ captureRoutes(280~287) 공통 관용구.
 *
 * 반환 규칙(세 갈래를 구분):
 * - sourceId 미지정 → `{ camera: undefined, src: undefined }`(에러 없음, 파이프라인 카메라 사용).
 * - sourceId 지정·미해석 → 400 `{ error: 'source not found' }` 전송 후 `undefined`(호출부 중단).
 * - sourceId 지정·해석 → `{ camera: new CameraSourceClient(src, cameraCfg), src }`.
 *
 * `deps.cameraCfg ? deps.sources?.get(sourceId) : undefined` — cameraCfg 미주입 시 src=undefined→400.
 * calibrateRoutes 는 `camera` 만, captureRoutes 는 `camera`+`src`(이후 listCameras 검사) 를 쓰므로 둘 다 반환한다.
 * deps 는 두 라우트 deps 의 공통 최소 인터페이스(sources·cameraCfg)만 받는다.
 */
export function resolveSourceCamera(
  deps: { sources?: Map<string, CameraSource>; cameraCfg?: ToolsConfig['camera'] },
  sourceId: string | undefined,
  reply: FastifyReply,
): ResolvedSourceCamera | undefined {
  if (!sourceId) return { camera: undefined, src: undefined };
  const src = deps.cameraCfg ? deps.sources?.get(sourceId) : undefined;
  if (!src) {
    reply.code(400).send({ error: 'source not found' });
    return undefined;
  }
  return { camera: new CameraSourceClient(src, deps.cameraCfg!), src };
}
