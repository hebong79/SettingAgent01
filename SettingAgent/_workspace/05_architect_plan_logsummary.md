# 05 설계 — 통신 패킷 로그 "반복분 5분 요약"

작성: 2026-07-24 / 설계자(architect) / 실행 모드 A(선형 파이프라인 — vitest 로 성공 확정 가능)

리더 정책(첫 발생 즉시기록 / 실패 무집계 / rate 복원 가능 / 순수모듈+주입시각 / 잔여 플러시 결정)을 만족하는 최소 변경 계획.

---

## 0. 현행 사실 확인 (코드 실측)

| 항목 | 실측 |
|------|------|
| 패킷 로그 발생지 | `src/util/http.ts:15,18`(`fetchWithTimeout`), `src/clients/hucoms/HucomsClient.ts:218,227`(`fetchResponse`) — **2곳뿐** |
| 그 외 `cat:'packet'` | `src/capture/CaptureJob.ts:366` — 통신 로그가 아니라 "캡처 전 이동 실패(흡수)" 1회성 warn. **본 작업 대상 아님** |
| `fetchWithTimeout` 호출자 | `CRpcClient`(2), `CameraClient`(5), `VpdClient`(3), `LpdClient`(2), `AgentRuntime`(2), `presetProvider`(1) |
| `/rpc` 로그의 method | HTTP `POST` 고정. **RPC 메서드명은 body 안**(`payload.method`) → 현재 로그로 `cam.list`/`cam.setPTZ`/`cam.captureJPG` 구분 **불가** (리더가 `ms` 패턴으로 추정한 이유) |
| Hucoms url | `buildUrl` 이 `id/passwd/action/좌표…`를 **쿼리로** 붙임. `safeUrl` 로 passwd만 마스킹 → **URL 전체를 키로 쓰면 매 호출 고유 → 집계 불가 + Map 무한증식** |
| 로그 소비 코드 | `test/hucomsClient.test.ts:65~72` **단 1건**(`logger.info` 스파이 + `call[1]==='Hucoms 통신 패킷'` → `url` 마스킹 확인) |
| 종료 훅 | `src/` 에 `process.on('SIGINT'|'beforeExit')` **0건** (플러시를 걸 기존 지점 없음) |
| 테스트 | vitest 236 파일 / 2758 케이스. `logger.ts` 는 `VITEST` 시 파일스트림 미생성(선례) |

---

## 1. 결정 사항

### 1.1 적용 지점 — 공통 순수모듈 1개 + 얇은 결선 1개, 두 발생지 모두 적용

신규 2파일:

- **`src/util/packetAggregator.ts`** — **순수**. `logger`/`pino` **import 금지**. 시각(`now`)·방출(`emit`) 주입. vitest 직접 대상.
- **`src/util/packetLog.ts`** — 얇은 결선. `logger` + `PacketAggregator` 싱글턴, `logPacket(entry)` / `flushPacketLog()` / `configurePacketLog(opts)`(테스트 전용) export.

변경 2파일:

- `src/util/http.ts` — `logger` import → `logPacket` import 로 교체. 로그 2줄을 `logPacket(...)` 호출로. **4번째 선택 인자 `op?: string` 추가**(기존 호출자 무영향).
- `src/clients/hucoms/HucomsClient.ts` — `fetchResponse` 의 `logger.info/warn` 2줄을 `logPacket(...)` 으로 교체. `op` 는 `params.action` 에서 **내부 계산**(공개 시그니처 무변경).

> **결선 주의(테스트 호환)**: `emit` 은 모듈 초기화 시 `logger.info` 를 바인딩해 보관하지 말고 **호출 시점에 `logger.info(...)` 를 직접 호출**해야 한다. `test/hucomsClient.test.ts` 의 `vi.spyOn(logger,'info')` 가 계속 잡히려면 필수.

**적용 범위는 위 2곳 전부(uniform)**, 클라이언트별 opt-out 플래그 없음(CLAUDE.md §2). LLM(`AgentRuntime`)·VPD/LPD 호출도 동일 규칙을 탄다 — 근거: 실패/타임아웃은 항상 즉시기록이라 튜닝에 필요한 신호는 보존되고, 성공 반복의 소요시간은 요약의 `msAvg/msMax` 로 남는다.

### 1.2 집계 키 — `HTTP메서드 + 쿼리제거 URL + op`

```
key = `${method} ${url.split('?')[0]}${op ? '#' + op : ''}`
```

- **쿼리 제거가 필수**: Hucoms 는 좌표·action 이 쿼리에 실려 URL 이 매번 달라진다. 제거하지 않으면 집계가 영원히 발동하지 않고 Map 이 무한증식한다. 부수효과로 키에 자격증명이 절대 담기지 않는다(안전).
- **`op` 도입 근거**: 키를 `method+url` 로만 두면 `/rpc` 하나에 `cam.list`/`cam.setPTZ`/`cam.captureJPG` 가 합쳐진다. 그러면 정책 1의 "첫 발생 즉시기록"이 **세 메서드 중 하나에만** 적용되어 나머지 두 개의 최초 발생 시각이 로그에서 사라진다 → 이번 3fps 근본원인 추적과 동일한 진단이 불가능해진다. 따라서 `op` 를 넣는다.
- **호출측 변경 최소**: `op` 를 채우는 곳은 **`CRpcClient.callRpc`/`getCatalog` 2줄**과 **`HucomsClient.fetchResponse` 내부 1줄**뿐. 나머지 12개 호출자는 **무변경**(`op` 미지정 → 키는 `method+경로`).
- 대안 기각: `fetchWithTimeout` 이 `init.body` 를 JSON 파싱해 `method` 를 추출하는 방식 — 암묵적이고 요청마다 파싱 비용. 명시 인자가 더 싸고 명확.
- Map 크기는 (엔드포인트 × op) 유한집합으로 자연 상한. 별도 키 상한 캡은 두지 않는다(과설계 회피). **대신 "키에 쿼리 금지"를 유닛테스트로 못박는다.**

### 1.3 잔여분 플러시 — **레코드 시 전역 sweep(지연 플러시)** 권고

| 방식 | 유실 | 프로세스 생존 영향 | 테스트 용이성 | 판정 |
|------|------|------------------|--------------|------|
| A. 같은 키 도착 시에만 플러시 | 큼 — 그 키가 조용해지면 영원히 미방출 | 없음 | 최상 | 부족 |
| **B. 임의 패킷 도착 시 전 키 sweep(권고)** | 작음 — **모든** 트래픽이 멈춘 뒤의 마지막 창만 | 없음(타이머 0개) | 최상(주입 시각만으로 결정적) | **채택** |
| C. 창마다 `setTimeout().unref()` | 없음 | unref 라 event loop 는 안 잡지만 타이머 N개 상주 | vitest fake timers 필요, 비결정성 증가 | 기각 |
| D. `process.on('beforeExit'/SIGINT')` 훅 | 없음(정상종료만) | 신규 전역 훅 도입 | 테스트 어려움 | 기각(현재 종료훅 0건) |

**권고 = B.** 근거: (1) 대상 트래픽은 주기 폴·캡처 루프로 **연속적**이라, 어떤 키가 조용해져도 다른 키의 패킷이 곧 sweep 을 돌려 요약을 창 종료 직후에 내보낸다. (2) 타이머 0개 → CLAUDE.md §2 부합, 프로세스 수명·테스트 결정성 무영향. (3) **유실 상한이 "반복 건수"뿐**이다 — 그 창의 첫 줄(상세)은 이미 로그에 있으므로 "무슨 통신이 있었는지"가 사라지는 일은 없고, 마지막 창의 n/ms 통계만 못 본다. 비용은 레코드당 O(활성키 수)(수십) 순회.

보완: `flushPacketLog()` 를 **export 만** 해 둔다(D 를 나중에 붙일 수 있는 고리). **이번엔 어디에도 등록하지 않는다** — 없는 종료 경로를 새로 만드는 것이 더 큰 변경이므로.

### 1.4 요약 줄 스키마 — `cat:'packet'` 유지 + `win` 필드 + 전용 msg

```jsonc
// 요약 (level 30)
{ "cat":"packet", "win":300412, "n":10, "ok":10, "err":0,
  "method":"POST", "url":"http://127.0.0.1:13110/rpc", "op":"cam.list",
  "msAvg":42, "msMax":76 }   // msg: "통신 패킷 요약" / Hucoms: "Hucoms 통신 패킷 요약"
```

- **구분 방법**: `cat:'packet'` 유지(기존 필터 불변) + **`win` 존재 여부**로 요약 판별. msg 도 `… 요약` 로 구분 가능(2중 안전).
- **rate 복원**: `win` = 창 실측 경과(ms, `flushAt - windowStart`), `n` = **그 창 안의 총 시도 건수(즉시기록된 첫 줄 포함)**. 따라서 **초당 건수 = `n / win * 1000`** 로 **정확히** 계산된다(펜스포스트 없음). 첫 줄이 n 에 포함되므로 요약과 상세가 1건 중복되지만, 그 대가로 산술이 애매해지지 않는다 — 의도적 선택.
- `ok` = 2xx, `err` = (예외 또는 비-2xx). `err>0` 이어도 그 건들은 **개별 warn 으로도 이미 남아 있다**(정책 2). 요약의 `err` 는 "이 창에 실패가 몇 건 섞였나"를 한 줄에서 보게 하는 용도.
- `msAvg` 는 정수 반올림, `msMax` 는 정수. (`msMin` 은 넣지 않음 — 진단 가치 대비 필드 증가.)
- 즉시기록 줄은 **기존 스키마 그대로**(`cat,method,url,status|err,ms`) + `op` 가 있으면 추가. `win` 없음.

### 1.5 창 길이 — 상수, config/env 노출 안 함

`packetAggregator.ts` 에 `export const PACKET_WINDOW_MS = 5 * 60_000;`. 테스트는 **자체 인스턴스에 `windowMs` 를 주입**하므로 env 가 필요 없다(CLAUDE.md §2 — 요청 없는 설정화 금지).
싱글턴만 예외적으로 `windowMs <= 0 → 집계 비활성(항상 즉시기록)` 규칙을 갖고, **`VITEST` 환경에서는 기본 0**(= 현행 동작 100% 보존, `logger.ts` 의 `isTest` 선례와 동일). 결선 경로 자체를 검증할 때만 `configurePacketLog({windowMs, now})` 로 켠다.

---

## 2. 알고리즘 (순수 모듈)

```ts
interface PacketEntry {
  method: string; url: string; op?: string;
  status?: number; err?: string; ms: number;
  msgBase: string;            // '통신 패킷' | 'Hucoms 통신 패킷'
}
type Emit =
  | (e: { kind:'packet'; entry: PacketEntry; failed: boolean }) => void
  | (e: { kind:'summary'; sum: Summary }) => void;   // 실제로는 단일 유니온 콜백
class PacketAggregator {
  constructor(opts: { windowMs: number; now: () => number; emit: Emit });
  record(entry: PacketEntry): void;
  flushAll(): void;
}
```

`record(e)`:
1. `t = now()`.
2. **sweep(t)** — 전 키 순회, `t - windowStart >= windowMs` 인 창을 **요약 방출 후 삭제**(정책 5 / §1.3-B).
3. `failed = e.err !== undefined || (e.status !== undefined && (e.status < 200 || e.status >= 300))`.
4. `st = map.get(key)`
   - `st` 없음 → **즉시기록**(정책 1) 후 `map.set(key, {windowStart:t, n:0, ok:0, err:0, msSum:0, msMax:0, sample:{method,url,op,msgBase}})`.
   - `st` 있음 && `failed` → **즉시기록**(정책 2). (창은 리셋하지 않음.)
   - `st` 있음 && 성공 → 방출 없음.
5. **누적**: `n++`, `failed ? err++ : ok++`, `msSum += ms`, `msMax = max`.
6. `windowMs <= 0` 이면 2·4·5 를 건너뛰고 **항상 즉시기록**(집계 비활성 모드).

요약 방출 시 `win = flushAt - windowStart`, `msAvg = Math.round(msSum / n)`. `flushAll()` 은 `now()` 기준으로 전 창 방출 후 map 을 비운다(재호출 시 무방출).

**의도된 정상 패턴**(30초 폴 기준): `즉시 1줄 → (9건 무음) → 요약 1줄 → 즉시 1줄 → …` = **5분당 2줄**. 상세 샘플이 5분마다 계속 나오므로 status/ms 실측 관측력이 유지된다.

**남는 리스크(정책 2에서 파생, 명시적 수용)**: 장애 폭주(Unity down + 고빈도 호출) 시 실패 줄은 집계되지 않아 그대로 쏟아진다. 정책상 의도된 동작이며, 이번 도배 사건은 성공 응답 반복이 원인이었으므로 범위 밖.

---

## 3. 구현 단계 (각 단계 = 검증 가능)

1. **`src/util/packetAggregator.ts` 신설** (순수, 외부 import 0).
   → 검증: `test/packetAggregator.test.ts` §4 의 케이스 1~12 green. `logger`/`pino` import 가 없음을 grep 으로 확인.
2. **`src/util/packetLog.ts` 신설** (싱글턴 + `logPacket`/`flushPacketLog`/`configurePacketLog`). `emit` 은 호출 시점에 `logger.info|warn` 직접 호출. 기본 `windowMs = process.env.VITEST ? 0 : PACKET_WINDOW_MS`.
   → 검증: `logPacket({...})` 1회에 `vi.spyOn(logger,'info')` 가 기존과 **동일한 필드/메시지**로 1회 호출됨.
3. **`src/util/http.ts` 결선** — `fetchWithTimeout(url, init, timeoutMs, op?)`. 성공/실패 로그를 `logPacket` 으로 교체(필드·메시지 문자열 유지, 비-2xx 는 warn 승격).
   → 검증: 케이스 13·14. 기존 `test/warmupTimeout.test.ts`(http.js 모킹) 무영향 green.
4. **`src/clients/CRpcClient.ts`** — `callRpc` 는 `op = method`(RPC명), `getCatalog` 는 `op = 'catalog'` 전달. 그 외 무변경.
   → 검증: 케이스 16. `test/cRpcClient.test.ts` green.
5. **`src/clients/hucoms/HucomsClient.ts` 결선** — `fetchResponse` 의 2줄을 `logPacket({..., op: typeof params.action === 'string' ? params.action : undefined, msgBase:'Hucoms 통신 패킷'})` 로 교체. `safeUrl` 마스킹 유지.
   → 검증: 케이스 17 + 기존 `test/hucomsClient.test.ts:65` green(마스킹·메시지 문자열 불변).
6. **전체 회귀** — `npm test`(2758+ green), `npm run typecheck`(0 error).
   → 검증: 실패 0. 신규 테스트 파일 2개 추가분만 케이스 수 증가.
7. **라이브 관측(동작 확인, CLAUDE.md 규칙 3)** — 서버 기동 + 뷰어 탭 1개를 **11분 이상** 열어두고 `logs/setting_*.log` 확인.
   → 검증: 동일 `op` 에 대해 `win` 필드 있는 줄이 **2회 이상** 나타나고, 5분 구간의 `cat:'packet'` 총 줄 수가 폴 키당 **≤3줄**. `n/win*1000 ≈ 0.033/s`(30초 폴)로 케이던스가 복원됨을 수치로 확인.

---

## 4. QA 테스트 케이스 목록

### `test/packetAggregator.test.ts` (순수, `now` 주입)
1. 새 키 첫 record → 즉시기록 1회(`win` 없음, 기존 필드 그대로).
2. 창 내 성공 반복 9회 → 추가 방출 0회.
3. 창 만료 후 record → **요약 1줄 + 즉시기록 1줄**(순서: 요약 → 즉시), 요약 `n=10, ok=10, err=0, win>=windowMs`.
4. 키 분리: 같은 URL·다른 `op`(`cam.list`/`cam.captureJPG`) → **각각** 즉시기록, 창도 독립.
5. **쿼리 무시**: `...?panpos=1` 과 `...?panpos=2` 는 동일 키(2번째는 집계, 즉시기록 없음) — Map 무한증식 방지 회귀 가드.
6. 실패(`err`)는 창 중에도 즉시기록(warn) + 요약 `err` 증가 + `n` 포함.
7. 비-2xx(status 500)는 즉시기록(warn), `ok` 미증가.
8. **타 키 sweep**: 키A 창 만료 후 키B 를 record → A 요약이 방출된다(정체 방지).
9. `flushAll()` → 미방출 창 전부 요약 + map 비움, 재호출 시 무방출.
10. `windowMs <= 0` → 매 record 즉시기록(집계 완전 비활성).
11. 수치 정확성: `msAvg` 정수 반올림, `msMax` 최대값, `win === flushAt - windowStart`.
12. **rate 복원**: 30초 간격 10건 시나리오 → 요약 1줄만으로 `n/win*1000 ≈ 0.0333/s` 산출(정책 3 수용기준).

### `test/packetLogWiring.test.ts` (결선)
13. `fetchWithTimeout` 성공 → `logger.info('통신 패킷')` 1회, 필드 `method/url/status/ms` 기존과 동일.
14. `fetchWithTimeout` 실패(fetch reject) → `logger.warn('통신 패킷 실패')` + **예외 재던짐 유지**.
15. `configurePacketLog({windowMs:60000, now:fake})` 후 동일 URL 3회(2번째는 창 내, 3번째는 창 만료) → 로그 순서 `즉시 → (무음) → 요약 → 즉시`.
16. `CRpcClient.callRpc('cam.list')` / `('cam.captureJPG')` → 로그에 `op` 포함, 두 메서드가 **각각** 즉시기록(키 분리 확인).
17. `HucomsClient` → `op` 에 action 이 실리고 `url` 의 `passwd=***` 마스킹 유지.
18. **테스트 기본 모드 성질**: `configurePacketLog` 를 부르지 않으면(VITEST 기본 `windowMs=0`) 같은 URL 반복 호출이 **매번** 로그된다 → 기존 테스트 호환 보증.

### 회귀
19. `test/hucomsClient.test.ts`, `test/cRpcClient.test.ts`, `test/warmupTimeout.test.ts` green.
20. `npm test` 전체 green(기존 2758 유지 + 신규), `npm run typecheck` 0 error.
21. 파일 스트림 미생성 성질 유지(`logs/` 에 테스트 산출물 없음).

---

## 5. 깨질 수 있는 기존 소비처

| 소비처 | 영향 | 조치 |
|--------|------|------|
| `test/hucomsClient.test.ts:65~72` (`logger.info` 스파이 + `'Hucoms 통신 패킷'`) | **유일한 코드 소비자.** msg 문자열·`url` 필드 유지 + VITEST 기본 집계 OFF → **통과 예상**. 단 `emit` 이 `logger.info` 를 모듈 로드 시 바인딩하면 스파이가 안 잡혀 깨진다 | 결선 규칙(호출 시점 직접 호출) 준수 + 케이스 19 |
| **비-2xx → warn 승격** | `status:404/500` 응답이 level 30→40 으로 이동. 현재 이를 단언하는 테스트는 없음(스파이 사용 테스트는 200 경로) | 케이스 7·19 로 확인. 문서에 명시 |
| `src/capture/CaptureJob.ts:366` (`cat:'packet'` warn) | 이 유틸을 경유하지 않음 → **무변경**. 다만 `cat:'packet'` 필터에는 계속 섞여 나온다 | 문서에 "packet 카테고리 = 통신 즉시 + 요약(win) + CaptureJob 이동실패" 3종임을 기재 |
| 로그를 사람이 grep 해 "패킷/10초"를 세는 관행(00_leader_context.md 의 근본원인 추적 방식) | 요약 도입 후 **단순 줄 수 세기가 실제 트래픽을 과소평가**한다 | `win`/`n` 으로 환산하는 방법을 문서에 명시(documenter 필수 항목) |
| `docs/20260719_Hucoms_TypeScript_Native_Client.md:131,133` (packet 로그 마스킹 서술) | `url` 마스킹은 유지되므로 서술 유효. 요약 줄 설명이 없음 | documenter 가 요약 줄·`op` 필드 추가 서술 |
| 외부 파서/스크립트 | 저장소 전체 grep 결과 `cat:'packet'` 을 파싱하는 스크립트·툴 **0건** | 조치 없음 |
| `docs/20260625_195152_SettingViewer_독립서비스_분리.md`(http.ts 복제 계획) | SettingViewer 패키지는 **미구현**(디렉터리 없음) → 실동 영향 없음 | 문서에 "복제 시 packetLog 동반 필요" 한 줄만 |

---

## 6. 영향 파일 목록 (구현자·문서화 전달)

**신규**: `src/util/packetAggregator.ts`, `src/util/packetLog.ts`, `test/packetAggregator.test.ts`, `test/packetLogWiring.test.ts`
**수정**: `src/util/http.ts`(로그 2줄 + `op` 인자), `src/clients/CRpcClient.ts`(2줄), `src/clients/hucoms/HucomsClient.ts`(로그 2줄 + op 1줄)
**무변경(명시)**: `src/util/logger.ts`(회전 1d/20M·`isTest` 정책 그대로), `src/capture/CaptureJob.ts`, 나머지 12개 `fetchWithTimeout` 호출자, `web/app.js`

## 7. MCP 도구 vs LLM 두뇌 경계

본 변경은 **양쪽 어디에도 속하지 않는 결정형 인프라(로깅 유틸)** 이다. LLM 개입 0, 판단 분기 0, 순수 카운팅·시각 산술. MCP 도구 표면(`src/mcp/*`)·REST 라우트 계약 변경 없음.

## 8. 가정·미해결

- **가정 A**: 즉시기록 첫 줄을 요약의 `n` 에 포함(§1.4). rate 산술의 명확성을 1건 중복보다 우선했다. 리더가 "요약 n = 억제된 건수"를 원하면 케이스 3·12 의 기대값만 바꾸면 된다.
- **가정 B**: 창 만료 시 상태를 삭제해 **재무장**(다음 패킷이 다시 즉시기록). 5분당 2줄이 되지만 상세 샘플이 주기적으로 남는다. "5분당 1줄"을 원하면 재무장 대신 창만 리셋하면 되나, 진단력(주기적 status/ms 실측)이 줄어든다 → 현 안 권고.
- **미해결**: `flushPacketLog()` 를 서버 종료 시 호출할지. 현재 종료 훅이 전무하여 **이번 범위에서는 미등록** 권고. 필요해지면 `src/index.ts` 에 SIGINT 훅 1개 추가로 흡수 가능(후속 작업).
