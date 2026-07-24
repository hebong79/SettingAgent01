# 06 구현 — 통신 패킷 로그 "반복분 5분 요약"

작성: 2026-07-24 / 구현자(developer) / 근거: `05_architect_plan_logsummary.md`(리더 승인) 전량 준수

---

## 1. 변경 파일 요약

| 구분 | 파일 | 내용 |
|------|------|------|
| 신규 | `src/util/packetAggregator.ts` | 순수 집계기(logger/pino import 0). 시각·방출 주입. `PACKET_WINDOW_MS = 5*60_000` |
| 신규 | `src/util/packetLog.ts` | 결선(logger + 싱글턴). `logPacket` / `flushPacketLog` / `configurePacketLog` |
| 수정 | `src/util/http.ts` | `logger` import → `logPacket`. 로그 2줄을 `logPacket(...)` 으로. **선택 인자 `op?: string` 추가**(4번째) |
| 수정 | `src/clients/CRpcClient.ts` | 2줄 — `callRpc` 는 `op = method`(RPC명), `getCatalog` 는 `op = 'catalog'` |
| 수정 | `src/clients/hucoms/HucomsClient.ts` | import 1줄 + `fetchResponse` 로그 2곳을 `logPacket` 으로. `op` 는 `params.action` 에서 내부 계산(공개 시그니처 무변경) |
| 신규 | `test/packetAggregator.test.ts` | 계획 §4 케이스 1~12 + 창 상수 확인 = 13 케이스 |
| 신규 | `test/packetLogWiring.test.ts` | 계획 §4 케이스 13~18(16-2 포함) = 7 케이스 |

**무변경(확인)**: `src/util/logger.ts`(회전 1d/20M·`isTest` 정책 그대로), `src/capture/CaptureJob.ts`,
나머지 12개 `fetchWithTimeout` 호출자(선택 인자라 무영향), `web/app.js`(리더가 이번 세션에 직접 바꾼
`CONN_POLL_MS 4000 → 30000` 은 손대지 않았고 전체 테스트 green 으로 확인).

---

## 2. 신규 함수·타입 계약

### `src/util/packetAggregator.ts` (순수)

```ts
export const PACKET_WINDOW_MS = 5 * 60_000;   // env/config 노출 없음

export interface PacketEntry {
  method: string; url: string; op?: string;
  status?: number; err?: string; ms: number;
  msgBase: string;                // '통신 패킷' | 'Hucoms 통신 패킷'
}
export interface PacketSummary {
  method: string; url: string /* 쿼리 제거 */; op?: string; msgBase: string;
  win: number; n: number; ok: number; err: number; msAvg: number; msMax: number;
}
export type PacketEmit = (event:
  | { kind: 'packet';  entry: PacketEntry; failed: boolean }
  | { kind: 'summary'; sum: PacketSummary }) => void;

export class PacketAggregator {
  constructor(opts: { windowMs: number; now: () => number; emit: PacketEmit });
  record(entry: PacketEntry): void;   // 즉시기록/집계 판정 + 만료창 sweep
  flushAll(): void;                   // 미방출 창 전부 요약 후 map 비움(재호출 시 무방출)
}
```

- **집계 키**: `` `${method} ${url.split('?')[0]}${op ? '#'+op : ''}` `` — 쿼리 제거(자격증명 유입·키 무한증식 차단).
- **실패 판정**: `err !== undefined || (status !== undefined && (status < 200 || status >= 300))`.
- **record 순서**: `t=now()` → **sweep(전 키, `t - windowStart >= windowMs` 면 요약 방출 후 삭제)** →
  키 없음이면 즉시기록 후 창 개설 / 키 있고 실패면 즉시기록(창 리셋 없음) / 키 있고 성공이면 무음 →
  `n++`, `ok|err++`, `msSum+=ms`, `msMax=max`.
- **`windowMs <= 0`** 이면 sweep·집계를 건너뛰고 **항상 즉시기록**(집계 완전 비활성).
- **타이머 0개**(지연 sweep). 요약의 `win = flushAt - windowStart`, `n` 은 즉시기록된 첫 줄 포함 →
  **초당 건수 = `n / win * 1000`** 로 정확히 복원(계획 §1.4 가정 A).

### `src/util/packetLog.ts` (결선)

```ts
export function logPacket(entry: PacketEntry): void;
export function flushPacketLog(): void;                                   // export 만, 미등록
export function configurePacketLog(opts?: { windowMs?: number; now?: () => number }): void;  // 테스트 전용
```

- 기본 창: `process.env.VITEST ? 0 : PACKET_WINDOW_MS` → **VITEST 기본 집계 OFF**(기존 동작·기존 테스트 100% 보존).
- **`emit` 은 방출 시점에 `logger.info` / `logger.warn` 을 직접 호출**한다(모듈 로드 시 바인딩 금지 —
  `test/hucomsClient.test.ts:66` 의 `vi.spyOn(logger,'info')` 가 깨진다). 계획 §5 준수, 회귀 테스트로 확인함.
- `configurePacketLog()` 를 인자 없이 부르면 기본값으로 복원(테스트 afterEach 용).

---

## 3. 로그 줄 형태

즉시기록(기존 스키마 유지 + `op` 만 추가):

```jsonc
{"level":30,"cat":"packet","method":"POST","url":".../rpc","op":"cam.list","status":200,"ms":42,"msg":"통신 패킷"}
{"level":40,"cat":"packet","method":"POST","url":".../rpc","op":"cam.list","err":"fetch failed","ms":8,"msg":"통신 패킷 실패"}
```

요약(`win` 필드 존재 + msg 접미 `요약` 의 2중 판별):

```jsonc
{"level":30,"cat":"packet","win":300412,"n":10,"ok":10,"err":0,
 "method":"POST","url":".../rpc","op":"cam.list","msAvg":42,"msMax":76,"msg":"통신 패킷 요약"}
```

**비-2xx 처리(계획 §5 명시 항목)**: 레벨만 30 → **40(warn) 으로 승격**하고 **메시지 문자열은 그대로**
(`'통신 패킷'` / `'Hucoms 통신 패킷'`) 둔다. `'… 실패'` 는 예외(transport error) 전용으로 유지해
`err` 필드가 있는 줄과 `status` 만 있는 줄을 계속 구분할 수 있게 했다(계획 §3-3 "필드·메시지 문자열 유지, 비-2xx 는 warn 승격").

**정상 케이던스**(30초 폴 기준): `즉시 1줄 → (9건 무음) → 요약 1줄 → 즉시 1줄 …` = **5분당 2줄**.

---

## 4. 검증 결과

```
$ npx tsc -p tsconfig.json --noEmit
(출력 없음 — 에러 0)

$ npx vitest run
Test Files  237 passed (237)
     Tests  2778 passed (2778)
  Duration  15.26s
```

계획 기준선 2758 케이스 + 신규 20 케이스(13 + 7) = 2778 로 **기존 케이스 손실 0**.
관련 회귀 개별 확인: `hucomsClient`(8) / `cRpcClient`(13) / `warmupTimeout`(2) 전부 green.
`logs/` 에 테스트 산출물 미생성(로거 `isTest` 정책 무변경).

---

## 5. 문서화·검증자 전달 노트

- `cat:'packet'` 줄은 이제 **3종**: 즉시기록 / 요약(`win` 보유) / `CaptureJob.ts:366`(캡처 전 이동 실패 warn, 본 변경 무관).
- **로그 줄 수로 트래픽을 세면 과소평가**된다. 요약 줄의 `n / win * 1000` 으로 초당 건수를 환산해야 한다.
- `flushPacketLog()` 는 **어디에도 등록하지 않았다**(현재 프로세스 종료 훅이 0건 — 계획 §1.3 결정).
  따라서 모든 트래픽이 멈춘 뒤의 **마지막 창 통계만** 유실될 수 있고, 그 창의 첫 상세 줄은 이미 기록돼 있다.
- 장애 폭주(실패 연속) 시 실패 줄은 정책상 집계하지 않으므로 그대로 출력된다(의도된 동작).
- 미해결/후속: 종료 훅(SIGINT)에서 `flushPacketLog()` 호출 여부는 후속 작업으로 남김.

---

## 6. 보정 (QA 지적 L2·L1 — 리더 수정 승인분)

근거: `07_qa_report_logsummary.md` §5. **L2·L1 은 수정, L4(`/ptz?cam_idx=N` 카메라별 미분리)는 수정하지 않고 한계로만 남긴다.**

### 6.1 L2 — rate 희석 → 요약에 `span` 필드 추가

지연 sweep 때문에 `win = flushAt - windowStart` 에 침묵 구간이 섞여, 30초 폴 10건 뒤 45분 침묵이면
`win=3,000,000` → 0.00333/s(실제의 1/10)로 **오도**된다. 요약 1줄로 케이던스를 복원하는 것이 이 기능의
핵심 수용기준이므로 보정했다.

- `WindowState.lastAt` 1필드 추가(레코드마다 갱신) → `PacketSummary.span = lastAt - windowStart`.
- `win` 은 **그대로**(창 총 길이) 두고 `span`(실측 활성 구간)을 **추가**만 했다.
- `packetAggregator.ts` 상단 JSDoc 에 두 산식을 명시:
  - 창 평균 = `n / win * 1000` (침묵이 섞이면 과소평가)
  - **활성 rate = `(n - 1) / span * 1000`** (n >= 2 에서만 유효, 버스트의 실제 케이던스)
  - 침묵량 = `win - span`
- 요약 줄 필드 순서: `{cat, win, span, n, ok, err, method, url, op?, msAvg, msMax}`.

### 6.2 L1 — `n = 1` 요약 미방출

5분보다 드물게 호출되는 키(health/LLM chat/catalog/수동 조작)는 즉시 1줄 + `n=1` 요약 1줄로 **로그가 2배**였다.
`n=1` 요약은 `win` 말고는 즉시 줄과 정보가 같다.

- `PacketAggregator.emitSummary` 진입부에 `if (state.n <= 1) return;` 1줄. sweep·`flushAll()` 양쪽에 동시 적용.
- 창 삭제·재무장은 그대로(방출만 생략) → rate 복원성 무손실, 저빈도 키는 호출당 1줄을 유지한다.

### 6.3 테스트 변경

신규 케이스(`test/packetAggregator.test.ts`, 13 → 18건):

| # | 내용 |
|---|------|
| 13 | `span` 수치 정확성 — 30초 폴 10건 + 45분 침묵 → `span=270,000` / `win=2,970,000` / `win-span=2,700,000`, 활성 rate 0.0333/s 복원 |
| 13-2 | 침묵 없이 창이 만료되면 `span`(270s)이 `win`(300s)에 수렴 |
| 14 | `n=1` 창 미방출 — 호출 3회 → 로그 3줄(도입 전과 동일) |
| 14-2 | 경계: `n=2` 부터 요약 방출(`span` 동반 확인) |
| 14-3 | `flushAll()` 도 `n=1` 창은 건너뛰고 `n>=2` 창만 방출 |

기존 케이스 보정(동작 변경에 따른 기대값 갱신 — 단언 약화 없음):

- 구현자 `packetAggregator.test.ts` (8)·(9): 요약 대상이 되도록 키당 record 2회로 조정.
- 구현자 `packetLogWiring.test.ts` (15): 요약 줄의 `span=10_000` 단언 추가.
- QA `packetLogAudit.test.ts`
  - **A7**: "한계 고정" → "**L2 보정**"으로 갱신. `win` 희석(0.00333/s) 단언은 유지하고 `span=270,000` ·
    활성 rate 0.0333/s · 침묵량 `win-span=2,730,000` 단언을 추가.
  - **A8**: "n=1 요약으로 2배" → "**요약 없음 → 호출당 1줄 유지**"로 갱신(`summaries()` 0건, `out` 3줄).
  - **A3 / A6 / B5**: `n=1` 창이던 시나리오를 record 2회로 조정(창 경계·다중 sweep·정체 창 방출의 검증 의도는 동일).
  - **B8**(필드 집합 계약): 요약 키 목록에 `span` 추가 → `['cat','err','method','msAvg','msMax','n','ok','op','span','url','win']`.

### 6.4 보정 후 검증

```
$ npx tsc -p tsconfig.json --noEmit
(출력 없음)  TSC_EXIT=0

$ npx vitest run
Test Files  238 passed (238)
     Tests  2800 passed (2800)
  Duration  15.02s
```

QA 기준선 2795 + 신규 5케이스 = 2800, 기존 케이스 손실 0.

### 6.5 문서화 전달(변경분)

- 요약 줄은 이제 `win`(창 총 길이)과 `span`(활성 구간)을 **모두** 싣는다. **케이던스는 `(n-1)/span*1000` 으로 읽고**,
  `win-span` 으로 그 요약이 얼마나 늦게 방출됐는지(침묵 길이)를 본다. `n/win*1000` 은 창 평균이라 침묵이 섞이면 낮게 나온다.
- **`n=1` 창은 요약이 없다.** 저빈도 엔드포인트는 즉시 줄만 남으며, 이는 결함이 아니라 의도된 동작이다.
- L4 한계(문서에 남길 것): `CameraClient.getPtz` 의 `/ptz?cam_idx=N` 은 쿼리 제거로 **카메라별로 키가 갈라지지 않는다**
  (창 안 최초 1대만 상세로 남고 `msAvg/msMax` 는 혼합값). 필요해지면 호출부에서 `op` 로 cam 을 구분하면 된다.
- L3(설계서 §1.2 "키 유한집합" 서술 오류) 정정은 문서화 단계 몫 — `op` 는 `POST /viewer/api/rpc` · MCP `unity_rpc` 를
  통해 자유 문자열이 들어올 수 있고, sweep 이 만료분을 지우므로 상한은 "최근 5분 내 서로 다른 method 수"다.
