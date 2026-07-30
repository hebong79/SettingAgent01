# 02b 구현 변경 내역 — W2(투어링 서버 정본화: 순수함수 포팅 + 잡·라우트·RPC + 웹 껍데기화)

작성: 2026-07-28 · 워크트리 `.claude/worktrees/feat-server-promote-4/SettingAgent`
입력: `_workspace/00_leader_decisions.md`(우선) · `_workspace/01_architect_plan.md` §0·§2·§5(단계 4·5·6)·§5.2(T1~T4)·§6(R5·R6·R13) · `_workspace/02_developer_changes.md`(W1 규약 — `mutFetch`)
범위: **W2 만**. 점유판정(W3)·슬롯편집(W4)은 한 줄도 건드리지 않았다. W1 산출물(`controlGate.ts`·`token.js`)도 수정하지 않았다.

---

## 1. 변경 파일 목록

### 신규(5)

| 파일 | 내용 |
|---|---|
| `src/setup/touringPlan.ts` | `web/core.js:1689 buildTouringPlan` 자구 포팅(순수·I/O 0). `TourStep`/`TourPlan` 타입 + 함수 1개 |
| `src/capture/TourJob.ts` | 순회 잡 상태머신(PlateDiscoveryJob 미러). 계획 산출은 위 순수함수에 위임, 이동·대기·정지만 소유. **DB·파일 쓰기 0** |
| `src/api/tourRoutes.ts` | `POST /capture/tour/start` · `POST /capture/tour/stop` · `GET /capture/tour/status` (discoverRoutes 패턴) |
| `test/touringPlanParity.test.ts` | T1 — web↔src `toEqual` 깊은 비교 17테스트(fixture + 퇴화 + 역순 + 부동소수) |
| `test/tourJob.test.ts` | T2 — 잡 상태머신 17테스트 |
| `test/tourRoutes.test.ts` | T3 — 라우트 16 + RPC 위임 6 = 22테스트 |

(신규 파일은 소스 3 + 테스트 3.)

### 수정(5)

| 파일 | 무엇을 | 왜 |
|---|---|---|
| `src/api/server.ts` | import 2줄 + `ApiDeps.tourJob?` 1줄 + `if (deps.tourJob) registerTourRoutes(...)` 블록 | 가산 등록 — 미주입이면 미등록(RPC `-32004 UNAVAILABLE`) |
| `src/index.ts` | import 2줄 + `const tourJob = new TourJob({...})` + **`jobBusy` 배열에 `['투어링', …]` 1줄** + `buildServer({… tourJob})` | R5 — 렌즈 캘리브레이션 시작 거부와 RPC `requiresCamera` 게이트가 **동시에** 투어링을 인지(판정처 단일 유지) |
| `src/rpc/methods.ts` | `capture.*` 섹션에 `capture.tour.start/stop/status` 3개(전부 `http` 위임, **handler 0줄**) | 카탈로그 70 → **73** |
| `test/rpcParity.test.ts` | ①`known` 에 tour 3경로 추가 ②**T4 동적 등록검사 it 신규**(+ 완전 배선 `makeFullCtx`) ③afterEach 의 `rmSync` 를 try/catch 로 감쌈 | R13 — 정적 목록 편집을 **더 강한 동적 보증**으로 상쇄. ③은 dbRoutes 의 read-only 연결이 파일 핸들을 붙들어 Windows EPERM 이 나는 것(임시 디렉터리라 무해) |
| `test/viewerPtzSyncCoverage.test.ts` | ①`MOVES_CAMERA['/capture/tour/start']` · `NO_MOVE['/capture/tour/status']` · `SYNC_OWNER['/capture/tour/start']='runTouringTest'` 3줄 ②**수집 정규식 `fetch\(` → `[Ff]etch\(`**(+사유 주석 4줄) | ①이 테스트는 **새 라우트에 분류를 강제**하도록 설계돼 있다. 분류를 넣으면서 `runTouringTest` 가 `syncPtzAfterJob` 을 호출한다는 것까지 봉인된다(§4-2). ②W1 이 남긴 사각 — 설계자 재판정(R15)·단계 6↔7 게이트. 봉인 대상의 100% 가 수집에서 빠져 있었다(§4-3) |
| `web/app.js` | ①`buildTouringPlan` import 제거 ②`runTouringTest` 본문 교체(서버 잡 시작 + 1초 폴링) ③`updatePtzControlEnabled` 에 `!state.touringActive` 추가 | 단계 6 껍데기화 + R6 |

### 의도적 무변경(확인함)

`web/core.js:buildTouringPlan` **존치**(파리티 기준변 + `test/buildTouringPlan.test.ts` 기준변 — 삭제 금지) · `web/app.js:5069` 클릭 결선 문자열 · `web/index.html` 버튼 위치 · `src/api/controlGate.ts`(신규 변이 라우트는 deny-by-default 로 **자동 보호**, 목록 편집 불요) · `web/token.js` · `test/roiDbLoad.test.ts` · `test/placeRoiRuntimeInvariants.test.ts`(사전 실패 2건, 무접촉) · DB 쓰기 API 호출 **0건**(`replaceSlotSetup` 계열 미호출 — TourJob 은 store 를 아예 주입받지 않는다).

---

## 2. 핵심 구현 노트

### 2.1 `src/setup/touringPlan.ts` (단계 4)
- 정렬키·그룹 경계·centering 3값 게이트·`presetSlotIdx ?? null`·graceful 퇴화까지 **웹과 자구 동일**. 새 알고리즘 0.
- preset 스텝은 `{kind,camId,presetId}` **3키만**(옵셔널 필드를 넣지 않는다) — `toEqual` 은 키 존재까지 보므로 이 부분이 곧 계약이다.
- 파리티 테스트는 fixture 23슬롯 + 퇴화(null/undefined/`{}`/비배열 slots 2종/centering 결손 4종) + 단일그룹 + 뒤섞임 + **fixture 역순** + 부동소수. 전부 `toEqual`.
- 파리티가 "둘 다 빈 결과"로 무력화되지 않도록 fixture 케이스에 절대값(steps 28·skipped 0)을 함께 단정했다.

### 2.2 `src/capture/TourJob.ts` (단계 5)
- 상태: `idle → running → (stopping) → done|aborted|error`. 중복 시작은 `running`·`stopping` 둘 다에서 거부.
- 실패를 **throw 문자열로 구분**해 라우트가 상태코드로 번역한다: `tour already running`(409) / `no setup_result`(404) / `순회할 슬롯/프리셋이 없습니다`(409·BUSY 단어 없음 → CONFLICT).
- preset 스텝: `resolvePresetPtz` 성공 → `move`, `null` → `requestImage(cam,preset)` 폴백. **스킵하지 않는다**(웹 `gotoPreset()` 폴백 계승). `listCameras` 예외도 `resolvePresetPtz` 가 흡수해 폴백으로 간다(테스트로 고정).
- 개별 스텝 실패는 `logger.warn` 후 계속, `done` 은 증가(정직한 진행률). 잡 전체는 `done` 으로 끝난다.
- 정지 확인은 **스텝 사이**에서만 한다 — 진행 중인 이동을 중간에 끊지 않는다(카메라를 슬루 중간에 버리지 않기 위해).
- `sleep`/`now` 주입으로 테스트가 실시간 대기 없이 전 경로를 훑는다.

### 2.3 `src/api/tourRoutes.ts`
- **★ `isBusy` 확인이 zod 다음, `job.start` 이전**에 있다. RPC 는 `requiresCamera` 게이트로 막히지만 REST 직접 호출은 dispatch 를 안 탄다 — 라우트가 최종 방어선(R5). 문구는 lensCalib 과 동일한 `busy — 다른 잡이 …` 로 맞춰 `classify409` 가 BUSY 로 접게 했다(새 규약 0).
- `source` 는 `resolveSourceCamera`(`/calibrate/point` 와 동일 관용구) → 미해석 시 400 `source not found`, 잡은 시작되지 않음.
- `stop` 은 멱등(idle 이어도 200). `status` 는 `Cache-Control: no-store`.

### 2.4 RPC (로직 0줄)
- 3개 전부 `http` 위임. `capture.tour.stop` 은 payload 를 넘기지 않아 브리지가 content-type 을 붙이지 않는다(빈 본문 POST 결함 재발 방지 — 테스트로 고정).
- 오류코드 실측: 없음 404→`-32002` / isBusy→`-32001` / 대상 0→`-32005` / 미주입→`-32004`. 전부 `test/tourRoutes.test.ts` 의 RPC describe 에서 단정.

### 2.5 T4 동적 등록검사(설계 §5.2 / R13) — **실제로 결함을 잡았다**
`known` 목록에 3줄을 추가하는 대신, **의존성을 전부 주입한 `buildServer` 인스턴스**(`makeFullCtx`)에 모든 `m.http` URL 을 `app.inject` 로 두드려 Fastify 기본 404 가 아님을 단정하는 it 을 신설했다.
첫 실행에서 곧바로 2건을 검출했다:

```
+ "capture.startPrecise → POST /capture/start-precise",
+ "capture.pipeline → GET /capture/pipeline",
```

두 라우트는 `deps.pipeline` 주입 시에만 등록된다 — **정적 목록으로는 영원히 못 잡는 종류의 사실**이다(목록에는 있었고 오타도 아니었다). `makeFullCtx` 에 `SetupPipeline` 을 주입해 해소했다. 이것이 `known` 편집을 정당화하는 근거다.
부작용 관리: 완전 배선 ctx 의 `tourJob` 은 `loadSetupResult: () => null` 로 두어 **순회를 실제로 시작하지 않는다**(404 본문으로 끝난다 — 검사 목적인 "라우트 존재"는 그대로 확인된다).

### 2.6 웹 껍데기화(단계 6)
- `runTouringTest` = ①`mutFetch('/capture/tour/start', {source})` ②1초 폴링 `GET /capture/tour/status` ③`st.current` 그룹 변경 시 `syncTouringPreset` ④종료.
- **웹에서 사라진 것**: `fetch('/capture/saves/setup_result')`, `buildTouringPlan` 호출·import, for 루프, `move()/gotoPreset()` 호출, `setTimeout` 1초 대기. 즉 순회 로직 전부.
- **그대로 유지된 것**: 버튼 위치·라벨 복원·`순회 중… (n/N)` 진행 표시·`#cap-msg` 실패 문구 형식·`#touring-done-modal` 완료 문구·`state.touringActive` 재진입 방지·`syncTouringPreset`.
- 순회 중 `#ptz-*` 컨트롤 disable 은 기존 `updatePtzControlEnabled` 에 `!state.touringActive` 한 조건을 더해 구현(R6). 서버는 막지 않는다(마지막 명령이 이긴다 — 기존 카메라 규약).
- 새 변이 요청은 **`mutFetch`** 를 썼다(W1 규약). 상태 폴링은 GET 이라 생 `fetch` — `webTokenWiring` 무회귀 확인.

---

## 3. 실행한 명령과 실제 출력

### 3.1 타입
```
$ npx tsc --noEmit
tsc exit=0
```
(중간에 2건 실패했고 둘 다 고쳤다 — ①파리티 테스트가 `unknown` 을 web 함수(JSDoc 타입)에 넘긴 건 → `WebInput` 캐스팅 ②`tourJob.test.ts` 의 preset 픽스처 타입이 기본값에서 추론돼 부분 프리셋을 거부한 건 → `PresetFixture` 명시. **숨기지 않고 기록한다.**)

### 3.2 신규 테스트
```
$ npx vitest run test/touringPlanParity
 ✓ test/touringPlanParity.test.ts (17 tests) 5ms
      Tests  17 passed (17)

$ npx vitest run test/tourJob
 ✓ test/tourJob.test.ts (17 tests) 12ms
      Tests  17 passed (17)

$ npx vitest run test/tourRoutes
 ✓ test/tourRoutes.test.ts (22 tests) 132ms
      Tests  22 passed (22)

$ npx vitest run test/rpcParity
 ✓ test/rpcParity.test.ts (14 tests) 256ms
      Tests  14 passed (14)
```

### 3.3 UX 불변 증거 + 무회귀
```
$ npx vitest run test/tourJob test/viewerPtzSyncCoverage test/buildTouringPlan test/webTokenWiring
 ✓ test/buildTouringPlan.test.ts (18 tests) 8ms      ← **무수정 green** (버튼 위치·결선 단정 포함)
 ✓ test/tourJob.test.ts (17 tests) 12ms
 Test Files  4 passed (4)
      Tests  56 passed (56)
```

### 3.4 전체
```
$ npx vitest run
 FAIL  test/placeRoiRuntimeInvariants.test.ts > … > 모든 주차면: 4점 + 유한 좌표
 FAIL  test/roiDbLoad.test.ts > loadRoiIntoDb — 정상 로딩(…) > preset_slotidx 는 …
 Test Files  2 failed | 268 passed (270)
      Tests  2 failed | 3349 passed (3351)
   Duration  18.23s
```
실패 2건 = **사전 실패 그대로**(무접촉). 통과 수 3291 → **3349**(+58 = 신규 56 + rpcParity T4 1 + viewerPtzSyncCoverage `it.each` 1). **회귀 0.**

중간에 내 변경으로 실패한 것은 `viewerPtzSyncCoverage` 1건(신규 라우트 미분류)뿐이며, 그건 그 테스트의 **설계된 동작**이다 — 분류를 넣으면서 §4-2 의 실제 결함을 발견했다.

### 3.5 완료기준 4 — 카탈로그 개수
임시 테스트(`test/_tmpCatalogCount.test.ts`)로 실제 `buildServer` 인스턴스에 `GET /rpc/catalog` 를 inject 해 확인하고 **삭제**했다.
```
stdout | test/_tmpCatalogCount.test.ts > catalog count
CATALOG COUNT = 73
 ✓ (1 test) 74ms
```
70 → **73** ✔ (tour 3개).

---

## 4. 설계와 달라진 점 / 설계가 예측 못 한 것

| # | 설계서 | 실제 구현 | 이유 |
|---|---|---|---|
| 1 | `TourJobDeps.onFinished?: (state) => void` | **넣지 않았다** | 호출자가 하나도 없다(투어링은 파이프라인 자동연쇄에 참여하지 않는다). 태어날 때부터 데드코드인 훅은 CLAUDE.md §2 위반. 필요해지면 그때 추가한다 |
| 2 | 종료 시 항상 완료 모달(문구 동일) | `done` → 모달(문구 동일) / `aborted`·`error` → `#cap-msg` 에 사유 | 중단·오류에 "순회 완료" 모달을 띄우는 것은 **위장 보고**다. 정상 경로의 문구·모달은 바이트 그대로 유지했다 |
| 3 | — (설계에 없음) | `runTouringTest` 종료 시 **`syncPtzAfterJob(null)` 호출** | §4-2 참조. 넣지 않으면 실제 버그다 |
| 4 | — | `test/rpcParity.test.ts` afterEach 의 `rmSync` 를 try/catch | dbRoutes 의 read-only 연결(close 훅 없음)이 Windows 에서 파일 핸들을 붙들어 EPERM. 임시 디렉터리라 무해 |

### 4.1 라우트 `isBusy` 의 자기 포함(보고 사항, 동작상 문제 없음)
`index.ts` 에서 `jobBusy` 에 투어링을 넣었고 라우트에는 `rpcBusy`(=jobBusy+렌즈)가 주입된다 → **순회 중 재시작 시 라우트가 "already running" 이 아니라 "busy (투어링)" 로 거절**한다. 둘 다 409·`classify409`→BUSY 로 같은 결론이라 외부 계약은 동일하다. `lensCalib` 이 자기 자신을 isBusy 에서 제외한 것과 달리 투어링은 자기 상태로 시작이 막혀도 무해(어차피 중복 시작은 거부 대상)하므로 설계대로 두었다.

### 4.2 ★ 설계가 놓친 실제 결함 — 순회 후 `state.ptz` 부패
기존 웹 순회는 `move()` 로 이동했고 `move()` 가 `state.ptz` 를 갱신했다. 서버 잡으로 옮기면 **카메라는 움직이는데 브라우저의 기준 PTZ 는 옛 값에 머문다** → 순회 직후 방향/절대 이동이 "그전 위치로 되돌아갔다가 한 스텝" 움직인다(`test/viewerPtzSyncCoverage.test.ts` 머리말에 기록된 마스터 실측 증상과 **같은 부류**).
`runTouringTest` 의 `finally` 에서 `await syncPtzAfterJob(null)` 을 호출하고(capPoll·discPoll 미러), 같은 테스트의 `SYNC_OWNER` 표에 `'/capture/tour/start': 'runTouringTest'` 를 등록해 **앞으로 이 호출이 사라지면 실패하도록** 봉인했다.
→ 설계자에게 공유할 항목: 서버 승격 3건(투어링·점유판정·슬롯편집) 중 **카메라를 움직이는 것**은 전부 이 동기화 책임을 함께 옮겨야 한다.

### 4.3 W1 이 남긴 사각 — **★최상, 이번에 함께 닫았다**(설계자 재판정 R15)
`test/viewerPtzSyncCoverage.test.ts` 의 라우트 수집 정규식이 `/fetch\(/`(소문자)라서 **`mutFetch(` 로 나가는 라우트가 분류 검사에서 전부 빠져 있었다**. 처음엔 "별건"으로 올렸으나, 설계자가 심각도를 재판정(단계 6↔7 게이트)했고 **내가 실측으로 재현·확인**했다.

측정(실행한 스크립트 출력 그대로):
```
현재 정규식 수집: 29
수정 정규식 수집: 57
놓치던 라우트 28 개:
/calibrate/lens/start · /calibrate/point · /calibrate/ptz · /capture/detect ·
/capture/start · /capture/start-precise · /capture/tour/start · /discover/ptz · /move · …
```
→ **봉인이 지키려던 "카메라를 움직이는 라우트"가 100% 빠져 있었다.** 게다가 첫 단정은 *수집된 것 중* 미분류를 보므로 **덜 수집할수록 통과가 쉬워진다** — green 인데 봉인은 없는 상태였다.

내가 처음에 우려했던 "다수 라우트가 한꺼번에 미분류로 뜬다"는 **사실이 아니었다**(실행으로 확인):
```
$ npx vitest run test/viewerPtzSyncCoverage   # 정규식 수정 후
 ✓ test/viewerPtzSyncCoverage.test.ts (13 tests) 5ms
```
놓치던 28개는 W1 이전 평범한 `fetch(` 시절 이미 분류돼 있던 것들이라 부작용이 0이다.

**탐지력 실증(green 이 무력화가 아님을 증명)**: 정규식 수정 후 `mutFetch` 로만 호출되는 `/capture/slots/reset` 분류 1줄을 일부러 지우고 돌렸더니
```
FAIL … 미분류 라우트 발견 — MOVES_CAMERA/NO_MOVE 중 하나로 분류할 것: /capture/slots/reset
```
로 **실패했다**(수정 전이었다면 통과했을 케이스). 확인 후 백업본으로 원복했다.

조치: 정규식 1글자 + 사유 주석 4줄. `_workspace/01_architect_plan.md` 의 단계 6↔7 게이트를 **W2 안에서 통과**시켰다 — 이로써 W3/W4 신규 라우트가 §0-9 표 등록 강제를 실제로 받는다.

---

## 5. 검증하지 못한 항목(정직 보고)

1. **라이브 순회 육안 확인 미수행.** 13021 서버를 띄워 실제 카메라/시뮬레이터가 프리셋→슬롯 순으로 움직이는 것을 보지 못했다. 대체 검증: ①순수함수 web 파리티(값 동일) ②잡 단위테스트에서 `move` 호출 인자·순서를 배열로 단정 ③라우트·RPC 상태코드. **"실제로 카메라가 그 위치로 갔는가"는 라이브에서만 확정**된다(검증자 인계).
2. **폴링 UX 육안 확인 미수행** — 버튼 라벨이 `순회 중… (n/N)` 로 갱신되는 것, 완료 모달, 순회 중 PTZ 버튼 비활성은 코드·정적 테스트로만 확인했다. 브라우저 확인 필요.
3. **통신 두절 시나리오**: 폴링 fetch 가 실패하면 웹은 버튼만 복구하고 서버 잡은 계속 돈다(주석에 명시). 이 상태에서 다시 누르면 409 BUSY 문구가 뜬다 — 의도된 동작이지만 사용자 관점 확인은 못 했다. **정지 컨트롤은 기존 UX 에 없었으므로 추가하지 않았다**(RPC `capture.tour.stop` 으로는 중단 가능).
4. 워크트리 루트의 정체불명 `x.json`(untracked)은 W1 보고 그대로 **건드리지 않았다**.

---

## 5.1 ★ 리더 라이브 검증 후속 조사(2026-07-28, W4 완료 후)

리더가 13021 에서 라이브 순회를 실행해 **"28스텝인데 이동 명령 1건, warn 0건, done 28/28"** 불일치를 보고했다. 조사 결과 **원인은 둘로 분리**된다 — 하나는 관측 착시(코드 정상), 하나는 진짜 결함(수정함).

### (A) "이동 명령 1건" = **패킷 로그 집계에 의한 관측 착시**. 코드는 정상이고 카메라는 실제로 움직였다

근거(코드 + 실행 양쪽):
1. `src/clients/hucoms/HucomsClient.ts:fetchResponse` 는 **모든 시도를 성공·실패 무관하게 `logPacket` 으로 남기고 실패 시 throw** 한다. 서킷 브레이커·무언의 no-op 경로가 **없다**.
2. `src/util/packetAggregator.ts:record()` — 창(`PACKET_WINDOW_MS = 5분`)이 열려 있으면 **성공 패킷은 개별 방출하지 않고 집계만** 하고, **실패는 항상 즉시 방출**한다. 키는 `METHOD + 쿼리제거 URL + op` 라 **모든 `goptzfpos` 가 한 키**다.
   → 19.7초 순회(≪5분)에서는 **첫 goptzfpos 1건 + 첫 jpeg 1건만 기록**되고 나머지 성공은 요약 대기열로 들어간다. 기존 테스트가 이 동작을 이미 고정하고 있다: `test/packetAggregator.test.ts` `(2) 창 안의 성공 반복 9회는 추가 방출 0회` · `(5) 쿼리스트링은 키에서 제거된다`.
3. **축소 라이브 재현**(내가 13021 에서 5스텝으로 실행, 완전 캡처):
```
{"ok":true,"started":true,"total":5,"presets":2,"slots":3,"skipped":0}
jpeg.cgi status=200 / getptzfpos status=200 / goptzfpos status=204 / getptzfpos ERR ×2 / 순회 잡 완료
```
   리더 관측과 동일 패턴이 5스텝에서도 재현됐다(성공 1건만 기록). 즉 스텝 수와 무관한 **로그 정책**이다.
4. **수정 후 라이브 재실행**에서 상태가 사실을 직접 증명한다:
```
{"state":"done","done":5,"total":5,"succeeded":5,"failed":0,...}
```
   → 5스텝 전부 카메라 명령이 정상 반환했다. "이동이 1번만 일어났다"는 사실이 아니다.

부수 답변:
- **Q2(warn 0건)**: 맞다. 스텝이 실패하지 않았다는 뜻이다(goptzfpos 204 = 명령 수신). 흡수된 예외가 있었다면 `'순회 스텝 실패(흡수)'` 가 반드시 찍힌다 — 도달 불가 호스트로 만든 재현에서 **28스텝 전부 warn 이 찍히는 것**을 확인했다.
- **Q3(스텝당 ~703ms, dwellMs=60)**: 지배 요인은 `dwell` 이 아니라 **실기 정착 확인**이다. 슬롯 스텝마다 `RealPtzSource.waitUntilSettled` 가 `SETTLE_POLL_MS(150ms)` 대기 후 `getptzfpos` 를 1회 시도하고, 이 환경에서는 그 조회가 실패(`fetch failed`)해 `'unavailable'` 로 즉시 반환한다. 프리셋 스텝은 `resolvePresetPtz → null → requestImage` 폴백이라 jpeg 왕복이 더해진다.
- **Q4(skipped=0 의 의미)**: `skipped` 는 **계획 단계에서 제외된 슬롯 수**(centering 결손)이고 fixture 23슬롯은 전부 centering 을 갖고 있으므로 0 이 맞다. 관측과 어긋나지 않는다 — 다만 **실행 실패를 나타내는 수가 없었던 것**이 (B)의 결함이다.
- 참고: 이 환경에서 `resolvePresetPtz` 는 **항상 null** 이다. `RealPtzSource.listCameras()` 가 `camIdx:1 / presetIdx:1(label '현재 위치')` **하나만**, 그것도 pan/tilt/zoom 없이 반환하기 때문이다. 따라서 5개 프리셋 스텝은 전부 `requestImage` 폴백을 탄다(설계된 폴백 — 스킵 아님).

### (B) 진짜 결함 — **흡수한 실패를 성공으로 보고**했다(수정함)

리더의 우려가 정확했다. 도달 불가 호스트(TEST-NET-1 `192.0.2.1`)에 붙인 실카 스택으로 재현하니 **28스텝 전부 실패했는데도** status 는 `state:'done', done:28/28, skipped:0` 이었다. 헤드리스 셋업 검증이라는 존재 이유가 무너진다.

수정(`src/capture/TourJob.ts`, 최소 범위):
- `succeeded` / `failed` 카운터 추가 → `TourStatus` 에 **항상 노출**.
- 종료 시 `failed > 0` 이면 **`state: 'partial'`**(신규 종료 상태 — `done` 과 구분). 완료 로그도 `'순회 잡 완료(일부 스텝 실패)'` 로 갈린다.
- **`skipped` 의미는 그대로 두고** 주석으로 `failed` 와의 차이를 못 박았다(혼동 증가 금지 — 리더 지시).
- `web/app.js`: `partial` 이면 완료 모달 대신 `#cap-msg` 에 `N개 위치 이동 실패(성공 M/T)` 를 띄운다. 실패를 성공 모달로 덮지 않는다.

### (C) 음성 대조(§9.2) — 이 테스트가 수정 전 코드에서 실패함을 실증

신규 3테스트(`test/tourJob.test.ts` → `TourJob — 실패는 보고에 드러난다(음성 대조)`)를 넣고, `TourJob.ts` 를 **수정 전 상태로 되돌려**(카운터 제거 + 항상 `finish('done')`) 실행했다:
```
× 전 스텝 실패 → state 는 done 이 아니라 partial, failed===total, succeeded===0
× 일부만 실패 → partial + 성공/실패 수가 정확히 나뉜다
× 전 스텝 성공 → done + failed 0(정상 경로가 partial 로 오염되지 않는다)
× move 가 reject 해도 순회를 계속한다(중단 없음) — 종료 상태는 partial
Test Files  1 failed
```
수정본 복원 후 전부 green. **"green 이 곧 봉인 작동"이 아님을 확인한 뒤에 통과를 주장한다.**

### (D) 검증 결과
```
$ npx tsc --noEmit          → exit 0
$ npx vitest run            → 2 failed | 3439 passed (3441)
```
사전 실패 2건 그대로, 기준선 3436 → 3439(+3 = 음성 대조 3건). **회귀 0.**

### (E) 환경 원복(리더 지시)
- `config/tools.config.json`: port 13021 → **13020**, controlToken `LIVETEST` → **`""`**. `git diff --numstat` **빈 출력** = HEAD 내용과 바이트 동일(남은 `M` 은 세션 시작 시점부터 있던 개행 아티팩트).
- `save/setup_result.json`(리더가 복사한 fixture) 및 내 백업본 **삭제 완료**. `save/` 에 잔여물 없음.
- 13021 서버 **종료**(LISTENING 없음). 임시 진단 스크립트 삭제.

### (F) 이번 조사에서 검증하지 못한 것
- **`partial` 의 라이브 관측은 못 했다.** 실장비(.153)가 `goptzfpos` 는 204 로 받아들여 라이브에서는 `failed:0` 만 재현된다. `partial` 경로는 유닛테스트 + 도달 불가 호스트 재현으로만 확인했다.
- 패킷 요약(`… 요약`) 라인이 5분 창 만료 후 실제로 방출되는 것은 **기존 테스트로만** 확인했고 라이브에서 5분을 기다려 보지는 않았다.

---

## 6. 다음 웨이브(W3 점유판정) 인계

- 신규 라우트는 `controlGate` 가 **deny-by-default 로 자동 보호**한다. 단 W3 의 `POST /capture/slots/judge-occupancy` 는 **읽기전용 POST(`mutating:false`)** 이므로 `READONLY_POST_PATHS` 에 **반드시 추가**해야 한다 — 안 하면 W1 의 드리프트 테스트가 먼저 실패해 알려준다.
- `test/rpcParity.test.ts` 의 T4 는 이제 **모든** 위임 URL 의 실제 등록을 검사한다. W3·W4 에서 라우트를 추가하면 `makeFullCtx` 에 그 의존성이 이미 주입돼 있는지 확인할 것(없으면 T4 가 UNAVAILABLE 로 잡는다).
- 웹에 새 변이 fetch 를 넣을 때는 **`mutFetch`**(W1) + **카메라를 움직이는 라우트면 `syncPtzAfterJob`**(§4-2) 두 규약을 함께 지킬 것.
- `src/setup/touringPlan.ts` ↔ `web/core.js` 파리티가 선례다. W3 점유판정 포팅도 **기준변은 web**, 입력은 기존 테스트 케이스 재사용, `toEqual` 깊은 비교.
