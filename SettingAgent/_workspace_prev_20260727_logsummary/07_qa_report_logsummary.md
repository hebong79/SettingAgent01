# 07 검증 — 통신 패킷 로그 "반복분 5분 요약" (독립 QA)

작성: 2026-07-24 / 검증자(qa-tester) / 대상: `05_architect_plan_logsummary.md` §4 21건 + 구현자 테스트의 커버리지 구멍 보강

**판정: 기능 결함 0건 / 설계상 한계·잔여위험 4건(1건은 설계서 서술 오류) / 구현자 테스트 커버리지 구멍 8건 → QA 테스트 17건 신규 작성으로 보강, 전부 green.**

---

## 1. 실행 결과 (원문)

```
$ npx tsc -p tsconfig.json --noEmit
(출력 없음)  TSC_EXIT=0

$ npx vitest run
 Test Files  238 passed (238)
      Tests  2795 passed (2795)
   Duration  14.46s
```

- 구현자 보고 기준선 237 파일 / 2778 케이스 → QA 신규 `test/packetLogAudit.test.ts`(17 케이스) 추가로 **238 / 2795**. 기존 케이스 손실 0.
- 개별 회귀 재확인: `hucomsClient(8)` / `cRpcClient(13)` / `warmupTimeout(2)` / `packetAggregator(13)` / `packetLogWiring(7)` = 43 passed.
- 테스트 실행 중 `SettingAgent/logs/` 신규 파일 생성 없음(logger `isTest` 가드 유효) — 계획 케이스 21 충족.

## 2. 운영 기본값(비-VITEST) 실동 확인 — CLAUDE.md 규칙 3

vitest 환경은 `windowMs=0`(집계 OFF)이라 **운영 기본값 경로는 유닛테스트로 도달할 수 없다.** 그래서 `tsx` 로 비-VITEST 프로세스를 띄워 실제 `logger` 파일 스트림에 쓰인 줄을 읽어 검증했다(`configurePacketLog({ now })` 로 **시각만** 주입, `windowMs` 는 기본값 그대로 사용).

30초 폴 11건 → `SettingAgent/logs/setting_20260724_233446.log` 실제 기록:

```jsonc
{"level":30,"cat":"packet","method":"GET","url":"http://127.0.0.1:13110/rpc?seq=0","op":"cam.list","status":200,"ms":40,"msg":"통신 패킷"}
{"level":30,"cat":"packet","win":300000,"n":10,"ok":10,"err":0,"method":"GET","url":"http://127.0.0.1:13110/rpc","op":"cam.list","msAvg":45,"msMax":49,"msg":"통신 패킷 요약"}
{"level":30,"cat":"packet","method":"GET","url":"http://127.0.0.1:13110/rpc?seq=final","op":"cam.list","status":200,"ms":50,"msg":"통신 패킷"}
```

- 패킷 11건 → 로그 **3줄**(즉시 → 요약 → 즉시). 기본 창이 실제로 `PACKET_WINDOW_MS=300000` 으로 바인딩됨을 확인.
- **rate 복원 = `n/win*1000` = 10/300000*1000 = 0.033333/s** (= 30초 폴). 요약 1줄만으로 정확히 복원됨 — 수용기준 충족.
- 요약 줄의 `url` 에 쿼리 없음(자격증명 유입 불가), 즉시 줄은 기존 스키마 유지.

## 3. 계획 §4 21건 대조

| # | 케이스 | 결과 | 비고 |
|---|--------|------|------|
| 1 | 첫 record 즉시기록 1회 | PASS | |
| 2 | 창 내 성공 9회 무음 | PASS | |
| 3 | 창 만료 → 요약+즉시, 순서·n/ok/err | PASS | |
| 4 | op 별 키 분리 | PASS | |
| 5 | 쿼리 무시(무한증식 가드) | **PASS(약함)** | 구현자 테스트가 요약 **개수**를 단언하지 않아 카디널리티가 실제로 1인지 미고정 → QA A1 로 보강 |
| 6 | 실패 즉시기록 + 요약 반영 | PASS | |
| 7 | 비-2xx 즉시기록·ok 미증가 | PASS | |
| 8 | 타 키 sweep | PASS | |
| 9 | flushAll 후 무방출 | PASS | |
| 10 | windowMs<=0 비활성 | PASS | |
| 11 | msAvg/msMax/win 수치 | PASS | |
| 12 | rate 복원(0.0333/s) | PASS | §2 실동에서도 재확인 |
| 13 | fetchWithTimeout 성공 필드 | PASS | |
| 14 | 실패 warn + 예외 재던짐 | PASS | |
| 15 | 즉시→무음→요약→즉시 | PASS | |
| 16 | CRpc op 분리 / catalog | PASS | |
| 17 | Hucoms op·마스킹 | **PASS(공백)** | 이 테스트는 **집계 OFF 상태**로 돌아서, 계획이 지목한 핵심 위험(Hucoms 쿼리로 인한 Map 무한증식)을 **결선 경로에서 한 번도 실행하지 않았다** → QA B1 로 보강 |
| 18 | VITEST 기본 집계 OFF | PASS | |
| 19 | 기존 소비처 회귀 | PASS | `test/hucomsClient.test.ts:66` 의 `vi.spyOn(logger,'info')` 유효 — `packetLog.ts:23-24` 가 방출 시점에 `logger.info/warn` 을 직접 호출(모듈 로드 시 바인딩 아님)함을 코드·실행 양쪽에서 확인 |
| 20 | 전체 green / typecheck 0 | PASS | 238 files / 2795 tests / tsc 0 |
| 21 | 테스트 로그 산출물 없음 | PASS | |

## 4. QA 신규 테스트 — `test/packetLogAudit.test.ts` (17건, 전부 green)

구멍을 메운 항목만 적는다.

| ID | 무엇을 메웠나 |
|----|--------------|
| A1 | 쿼리 500종 → **요약 1건**으로 Map 카디널리티를 직접 고정(케이스 5 보강) |
| A2 | `op` 없음 vs 있음 키 분리(미검증이었음) |
| A3 | 창 경계 정확성 — `windowMs-1` 미만료 / 정확히 `windowMs` 만료(`>=`) |
| A4 | **첫 record 가 실패**인 경우에도 즉시기록 + 창 개설, 이후 성공 무음 |
| A5 | 창 안 실패 20건 전부 즉시기록(집계로 숨기지 않음) |
| A6 | 만료 창이 여러 개일 때 record 1회가 전부 sweep |
| A7 | 지연 sweep 시 rate 희석(§5-L2 한계 고정) |
| A8 | 저빈도 키의 `n=1` 요약으로 인한 줄 수 증가(§5-L1 회귀 고정) |
| A9 | URL 프래그먼트와 `op` 키의 형식적 충돌(경미) |
| B1 | **Hucoms 좌표 50회를 집계 ON 으로 실제 호출** → 즉시 1 + 요약 1, 요약 url `http://camera.local/cgi-bin/control/ptzf_status.cgi`(쿼리 없음), 모든 logger 인자 전체 문자열에 `plain-secret` 부재 |
| B2 | Hucoms transport 실패의 **err 메시지 마스킹**이 신규 경로에서도 유지(`***`) |
| B3 | 비-2xx 4연속 → `logger.warn` 4회(집계로 숨기지 않음), msg 는 `'통신 패킷'`, `err` 필드 없음, info 0회 |
| B4 | `flushPacketLog()` 결선 — 요약 방출 후 재호출 무방출(기존 테스트 전무) |
| B5 | 다른 키 트래픽이 정체 창을 방출(결선 경로) |
| B6 | 2초 폴 150건 → 요약 1줄에서 rate=0.5/s 정확 복원 |
| B7 | 같은 RPC 메서드의 params 가 달라도 1키(캡처 루프 회귀) |
| B8 | 요약/즉시 줄의 **필드 집합 계약** 고정 — 즉시 `{cat,method,ms,op,status,url}`, 요약 `{cat,err,method,msAvg,msMax,n,ok,op,url,win}` |

## 5. 결함·한계 (전부 기능 결함 아님. 심각도 순)

### L1 (경미·회귀) 저빈도 키는 로그 줄이 오히려 2배가 된다
창당 1건뿐인 키도 만료 시 `n=1` 요약이 무조건 나간다(`packetAggregator.ts:142-149` sweep 무조건 방출). 호출 간격이 5분보다 긴 엔드포인트(각 클라이언트 `/health`, LLM chat, catalog, 수동 조작 계열)는 **호출당 즉시 1줄 + 요약 1줄 = 2줄**이 된다(A8: 호출 3회 → 5줄). `n=1` 요약은 `win` 말고는 즉시 줄과 정보가 동일하다.
→ 권고(선택): `emitSummary` 에서 `state.n <= 1` 이면 방출 생략. 1줄 수정, rate 복원성 무손실(그 창의 정보는 이미 즉시 줄에 있다).

### L2 (중간·설계 한계, 신규 발견) 지연 sweep 이 rate 를 희석한다 — 버스트 워크로드에서 오해 유발
`win = flushAt - windowStart` 이고 `flushAt` 은 "다음 패킷이 도착한 시각"이라 트래픽이 끊겼다 재개되면 창이 부풀어 rate 가 낮게 나온다. A7 실측: 30초 폴 10건(실제 0.0333/s) 뒤 45분 침묵 → 요약 `n=10, win=3,000,000` → **0.00333/s (실제의 1/10)**.
캡처 루프처럼 **버스트+침묵** 패턴이면 오차가 더 커진다(10초에 300건 후 20분 침묵 → 요약은 0.25/s, 실제 버스트는 30/s → 100배 과소평가). 계획 §1.3 은 "유실 상한은 마지막 창의 통계뿐"이라고만 적었고 **이 왜곡은 문서화되지 않았다.** 이번 3fps 진단과 같은 케이던스 추적을 다음에도 하려면 이 왜곡을 알고 읽어야 한다.
→ 권고(선택): `WindowState.lastAt` 1필드 추가 → 요약에 `span = lastAt - windowStart` 를 함께 실으면 `n/span` 으로 실제 버스트 케이던스가 복원된다(누적 3줄). 채택하지 않으면 문서에 "요약의 rate 는 창 종료 지연만큼 과소평가될 수 있다"를 반드시 명시할 것.

### L3 (경미·잔여위험, 설계서 서술 오류) `op` 는 외부 입력이라 "키 유한집합" 전제가 성립하지 않는다
계획 §1.2 는 "Map 크기는 (엔드포인트 × op) 유한집합으로 자연 상한"이라 단정했으나, `op` 를 만드는 `callRpc(method,…)` 의 method 는 두 곳에서 **자유 문자열**이다.
- `src/viewer/routes.ts:76-78, 375` — `POST /viewer/api/rpc`, `RpcBody.method = z.string().min(1)`(controlToken 미설정 시 게이트도 없음)
- `src/mcp/server.ts:97, 103` — MCP `unity_rpc` 도구, `method: z.string().min(1)` (LLM 이 채움)

즉 임의 문자열마다 키가 하나씩 생긴다. sweep 이 만료분을 지우므로 **영구 누수는 아니고 "최근 5분 내 서로 다른 method 수"로 상한**되지만, sweep 은 record 당 O(활성 키)라 키가 많아지면 패킷마다 비용이 커진다. 실사용 위험은 낮다(로컬 뷰어·자체 LLM). 조치 필요 없음 — 다만 **설계서의 "자연 상한" 서술은 사실이 아니므로 문서화 단계에서 정정할 것.**

### L4 (경미·관측력 저하) 쿼리 제거로 `cam_idx` 단위 가시성이 사라진다
`CameraClient.getPtz` 는 `${baseUrl}/ptz?cam_idx=N`(`CameraClient.ts:146`)이라 쿼리 제거 후 **모든 카메라가 한 키**로 합쳐진다. 창 안에서는 최초 1대의 URL만 상세로 남고 나머지 카메라 호출은 무음, `msAvg/msMax` 도 카메라 혼합값이 된다("어느 카메라가 느린가"를 packet 로그만으로는 못 본다). 설계 의도(쿼리 제거)의 자연스러운 대가이며 `op` 미지정 호출자라 회피 수단이 있다(필요해지면 호출부에서 `op` 로 cam 을 구분).

### 확인했으나 문제 없음
- **마스킹 회귀 없음**: `passwd` 는 즉시 줄에서 `***`(safeUrl 유지), 요약 줄은 쿼리 자체가 제거됨, 집계 키에도 쿼리가 들어가지 않는다. err 메시지 마스킹(`safeMessage`)도 유지(B1·B2, 전체 logger 인자 문자열 스캔으로 확인).
- **실패 무집계 정책 준수**: 예외·비-2xx 는 창 중에도 항상 즉시기록(A5·B3).
- **키 설계**: `/rpc` 는 `op` 로 `cam.list`/`cam.setPTZ`/`cam.captureJPG`/`catalog` 가 분리되고, 같은 op 의 params 차이는 1키로 합쳐진다(B7).
- **sweep 플러시**: 타 키 트래픽으로 정체 창이 방출됨(A6·B5). 트래픽 전면 정지 시 마지막 창 통계만 미방출이며 그 창의 첫 상세 줄은 이미 남아 있다 = 계획대로. `flushPacketLog()` 는 정상 동작하나 **어디에도 등록돼 있지 않다**(B4 로 동작만 보증).
- **`fetchWithTimeout` 순수 유틸 계약**: 4번째 인자 `op?` 는 선택이라 기존 12개 호출자 무영향(tsc 0, 전체 green).
- **`packetAggregator.ts` 는 import 0**(순수 모듈 — grep 확인).

## 6. 검증하지 못한 항목(한계)

1. **계획 §3-7 의 11분 라이브 관측(서버+뷰어 탭)** — 미실시. 대신 §2 에서 **운영 기본 창(300s)·실제 logger 파일 출력·rate 복원**을 비-VITEST 프로세스로 직접 확인했다. 미확인으로 남는 것은 "실제 뷰어 폴링 트래픽이 섞였을 때의 5분 구간 줄 수(폴 키당 ≤3줄)"뿐이며, 이는 키 분리·sweep 동작이 검증된 이상 산술적으로 따라온다.
2. **실서비스(Unity/VPD/LPD/Hucoms 카메라) 연동 스모크** — 미가동으로 불가. 전부 모킹(`vi.stubGlobal('fetch')` / `fetchImpl` 주입)으로만 검증했다.
3. **동시성** — 집계기는 단일 스레드 가정. 워커 스레드·다중 프로세스에서 창이 프로세스별로 분리된다는 점은 미검증(현 구조상 SettingAgent 단일 프로세스라 범위 밖).

## 7. 구현자에게 되돌릴 항목

**필수 수정 없음**(기능 결함 0). 다음 2건은 리더 판단 사항이다.
- L1: `n<=1` 요약 생략(1줄) — 저빈도 키 로그 2배 증가 회피.
- L2: `span` 필드 추가(3줄) 또는 문서에 rate 희석 명시 — 케이던스 진단의 신뢰도 문제.
- L3: 문서화 단계에서 설계서 §1.2 "자연 상한" 서술 정정.
