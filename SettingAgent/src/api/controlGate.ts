// 변이 게이트(설계서 §1.2) — `viewer.controlToken` 이 설정돼 있으면 **모든 변이 요청**에
// `x-viewer-token` 일치를 요구한다.
//
// ★ 왜 전역 훅인가: 기존 토큰 검사는 `src/viewer/routes.ts` 4곳(move·rpc·llm/select·camerapos)에만
//   있었다. `/capture/*`·`/calibrate/*`·`/discover/*`·`/mapping*`·`PUT /settings` 는 토큰을 켜도
//   그대로 뚫려 있었다 — 게이트가 "일부 라우트의 관심사"였기 때문이다. 전송 계층 관심사이므로
//   인스턴스 전역 훅으로 올리고, **면제 목록만 열거**한다(deny-by-default).
//
// ★ 무동작 보장: `controlToken` 이 빈 문자열이면 훅 자체를 달지 않는다 → 현행 배포(빈 값)의
//   동작은 100% 그대로다. 게이트 도입으로 인한 회귀 가능성이 구조적으로 0이다.

import type { FastifyInstance } from 'fastify';
import type { ToolsConfig } from '../config/toolsConfig.js';

/**
 * 변이 게이트에서 **면제**되는 비-GET 경로(읽기 전용 POST).
 * `src/rpc/methods.ts` 의 `mutating:false` + 비-GET `http` 위임과 **1:1** 이어야 한다
 * (`test/controlGate.test.ts` 의 드리프트 테스트가 양방향으로 봉인한다).
 *
 * ⚠ `/capture/detect` 는 읽기 선언이지만 **카메라를 물리적으로 이동시킨다**
 *   (detectPipeline 이 미귀속 차량마다 확대 PTZ 로 requestImage 하고 원위치 복귀를 하지 않는다).
 *   즉 "무인증으로 카메라를 돌릴 수 있다"는 모순이 남아 있다 — **알려진 한계이며 별건**이다.
 *   해소하려면 `plate.detect`·`detect.vehicles` 를 `mutating:true` 로 승격해야 하는데,
 *   그것은 카탈로그 계약 변경(리더 결정 Q1(a): 현행 유지)이라 이번 범위를 넘는다.
 */
export const READONLY_POST_PATHS: ReadonlySet<string> = new Set([
  '/capture/detect',
  '/capture/place-roi/validate',
  '/capture/ground-grid/bootstrap',
  '/capture/autocorrect',
  // 점유 **판정**(slot.occupancy.evaluate) — 검출값을 본문으로 받아 계산만 한다.
  // 카메라·DB·파일 무접촉이라 POST 지만 읽기다(`mutating:false`).
  '/capture/slots/judge-occupancy',
]);

/**
 * RPC 평면 — `dispatch.ts` 가 **메서드별로** 자체 게이트한다(`MethodDef.mutating` 기준).
 * 통째로 막으면 읽기 메서드(`slot.list` 등)까지 토큰을 요구하게 되어 기존 계약이 바뀐다.
 */
export const SELF_GATED_PATHS: ReadonlySet<string> = new Set(['/rpc']);

/** 이 요청이 토큰 게이트 대상인가(순수 판정). 쿼리스트링은 무시한다. */
export function needsControlToken(method: string, url: string): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return false;
  const path = url.split('?')[0];
  if (SELF_GATED_PATHS.has(path)) return false;
  if (READONLY_POST_PATHS.has(path)) return false;
  return true; // deny-by-default — 새 변이 라우트는 선언 없이도 보호된다.
}

/**
 * 전역 변이 게이트 등록. `controlToken` 이 빈 값이면 **훅을 달지 않는다**(현행 동작 완전 보존).
 * 실패 응답은 기존 인라인 게이트와 바이트 동일(`403 {error:'invalid token'}`)이라
 * `mapHttpStatus` 가 RPC `-32006 FORBIDDEN` 으로 접는 경로도 그대로다.
 */
export function registerControlTokenGate(app: FastifyInstance, viewer?: ToolsConfig['viewer']): void {
  const required = viewer?.controlToken;
  if (!required) return;
  app.addHook('onRequest', async (req, reply) => {
    if (!needsControlToken(req.method, req.url)) return;
    if (req.headers['x-viewer-token'] === required) return;
    // onRequest 단계에서 끊는다 — 본문 파싱·핸들러 진입 전이라 부작용이 발생할 여지가 없다.
    return reply.code(403).send({ error: 'invalid token' });
  });
}
