# 02 구현 변경 내역 — W1(fixture 이관 + 인증 토큰 서버/웹)

작성: 2026-07-28 · 워크트리 `.claude/worktrees/feat-server-promote-4/SettingAgent`
입력: `_workspace/00_leader_decisions.md`(우선) · `_workspace/01_architect_plan.md` §0·§1·§5(단계1~3)·§6(R1·R2·R4)
범위: **W1 만**. 투어링(W2)·점유판정(W3)·슬롯편집(W4)은 **한 줄도 건드리지 않았다.**
(이전 라운드 산출물은 `_workspace_prev_20260728_placedrawfix/02_developer_changes.md` 로 보존돼 있다 — 이 파일은 W1 내용으로 대체.)

---

## 1. 변경 파일 목록

### 신규(5)
| 파일 | 내용 |
|---|---|
| `test/fixtures/setupResult.23slots.json` | 실데이터 23슬롯 고정입력(원본 `메인폴더/save/setup_result.json` 사본, 18,608B). 원본은 **읽기만** 했다 |
| `src/api/controlGate.ts` | 전역 변이 게이트(면제목록 + 순수판정 + onRequest 훅 등록) |
| `test/controlGate.test.ts` | 게이트 19테스트(판정표·무동작·403/200·RPC·드리프트) |
| `web/token.js` | 토큰 localStorage 보관 + `authHeaders` + `mutFetch` |
| `test/webTokenWiring.test.ts` | 웹 변이 fetch 정적 봉인 8테스트 |

### 수정(6)
| 파일 | 무엇을 | 왜 |
|---|---|---|
| `test/buildTouringPlan.test.ts` | 읽기 경로 `save/setup_result.json` → `test/fixtures/setupResult.23slots.json`(+사유 주석 2줄) | `save/` 는 `.gitignore` 런타임 산출물 → 워크트리·CI 에서 collect 단계 ENOENT |
| `src/api/server.ts` | import 1줄 + `buildServer` 최상단 `registerControlTokenGate(app, deps.viewer)` 1줄(주석 2줄) | 훅은 인스턴스 전역 → 이후 등록되는 capture/calibrate/discover/rpc/뷰어 캡슐 전부에 적용 |
| `web/app.js` | ①`token.js` import ②변이 fetch **32곳** → `mutFetch` ③`tokenHeaders(...)` 4곳 → 평범한 헤더(토큰은 mutFetch 가 붙임) ④지역 `tokenHeaders` 정의 **삭제**(내 변경으로 고아) ⑤`wireControlToken()` 신설 + `init()` 결선 | 게이트를 켠 순간 죽는 31개 버튼을 살린다(R1) |
| `web/roimaker.js` | import 1줄 + 변이 fetch **3곳** → `mutFetch` | 동일 |
| `test/roimakerUi.test.ts` | DB 호출 수집 정규식 `fetch\('` → `[Ff]etch\('` (1줄) | `mutFetch` 는 대문자 F — 내 치환이 깨뜨린 정적 단정을 같은 의미로 복구 |
| `test/slotCuboidRoutes.test.ts` | `fetch('/capture/slots/cuboid'` → `mutFetch('/capture/slots/cuboid'` (1줄) | 동일. 이제 "변이는 토큰 헬퍼 경유"까지 함께 단정한다 |

### 의도적 무변경(확인함)
`config/tools.config.json`(**`controlToken:""` 그대로** — 값 무편집) · `src/viewer/routes.ts`(인라인 게이트 4곳 존치) · `src/rpc/methods.ts`(신규 메서드 0 — 토큰은 전송계층 관심사) · `test/roiDbLoad.test.ts` · `test/placeRoiRuntimeInvariants.test.ts`(사전 실패 2건, 무접촉) · `src/mcp/server.ts`(R4 — 이미 `x-viewer-token` 자동 주입).

---

## 2. 핵심 구현 노트

### 2.1 `src/api/controlGate.ts`
- `READONLY_POST_PATHS` = `/capture/detect` · `/capture/place-roi/validate` · `/capture/ground-grid/bootstrap` · `/capture/autocorrect` (4개). 설계서 예측과 실제 카탈로그가 정확히 일치함을 드리프트 테스트로 확인했다.
- `SELF_GATED_PATHS` = `/rpc`. 통째로 막으면 `slot.list` 같은 **읽기 RPC 가 토큰을 요구**하게 되어 `rpcDispatch` 계약이 바뀐다.
- 판정 순서: `GET/HEAD/OPTIONS` 면제 → `/rpc` 면제 → 읽기전용 POST 면제 → **그 외 전부 게이트**(deny-by-default). URL 은 `split('?')[0]`, 메서드는 `toUpperCase()`.
- `controlToken` 이 빈 문자열이면 `addHook` 자체를 **호출하지 않는다** → 현행 배포에서 코드 경로가 늘지 않는다(회귀 가능성 구조적 0).
- 403 응답은 기존 인라인 게이트와 **바이트 동일**(`{error:'invalid token'}`) → `mapHttpStatus` 가 RPC `-32006 FORBIDDEN` 으로 접는 경로 불변.
- **리더 결정 Q1(a) 주석 삽입 완료**: `/capture/detect` 는 "읽기 선언이지만 카메라를 물리 이동시킨다 — 알려진 한계, 별건"을 면제목록 주석에 명시.

### 2.2 드리프트 테스트(이번 단계의 안전장치)
`test/controlGate.test.ts` 마지막 describe 2개가 **양방향**으로 봉인한다.
1. `METHODS` 중 `http` 위임이면서 `method !== 'GET'` 인 전부에 대해 `m.mutating === !READONLY_POST_PATHS.has(url)`.
2. 역방향 — 면제목록의 모든 경로가 실제로 어떤 `mutating:false` 메서드가 쓰는 경로다(고아 면제 금지). `toEqual` 집합 비교.

→ 새 변이 라우트를 카탈로그에 넣으면서 면제목록을 잘못 건드리면 **즉시 실패**한다.

### 2.3 웹 배선
- `mutFetch(url, init)` 는 `web/token.js` 에 두고 app.js·roimaker.js 가 **공유**한다(설계는 각 파일 지역 헬퍼였으나 정의처를 둘로 만들 이유가 없다 — §4 참조).
- 치환은 **`fetch(` → `mutFetch(` 토큰 1개 교체**로 끝냈다. `method:`·`headers:`·`body:` 는 손대지 않았다(외과적). 헤더는 `authHeaders(init.headers ?? {})` 로 mutFetch 가 토큰만 얹는다.
- 기존에 토큰을 붙이던 4곳(`/move`·`/camerapos`·`/rpc`·`/llm/select`)은 `tokenHeaders({...})` → `{...}` 로 바꿨다. mutFetch 가 같은 헤더를 붙이므로 **전송 바이트 동일**이고, 그 결과 지역 `tokenHeaders` 가 고아가 되어 삭제했다(정의처를 `token.js` 하나로).
- 토큰 소스가 `#viewer-token.value` → `localStorage['pa.viewerToken']` 으로 바뀌었다. `wireControlToken()` 이 ①로드 시 입력칸에 복원 ②`input` 이벤트마다 저장 → **새로고침해도 유지**되고, app.js 와 roimaker.js 가 DOM 결합 없이 같은 토큰을 쓴다(기존에 roimaker 는 토큰을 아예 못 붙였다).

### 2.4 정적 봉인(`test/webTokenWiring.test.ts`)
"생 `fetch(` 호출 구간 안에 `method:'POST'|'PUT'|'DELETE'|'PATCH'` 가 있으면 실패". 구간 경계는 `[Ff]etch\(` — 대문자 F 를 빠뜨리면 mutFetch 의 method 가 직전 읽기 fetch 구간으로 새어 **거짓 실패**가 난다(실제로 처음 그렇게 짜서 14건 오탐 → 수정).
**탐지력 실증**: 같은 판정기를 `git show HEAD:web/app.js`(변경 전)에 돌려 **32건 전부 검출**, 변경 후 **0건**. 즉 "0건"이 판정기 무력화가 아님을 확인했다.

---

## 3. 실행한 명령과 실제 출력

### 3.1 단계 1 검증
```
$ npx vitest run test/buildTouringPlan
 ✓ test/buildTouringPlan.test.ts (18 tests) 7ms
 Test Files  1 passed (1)
      Tests  18 passed (18)
```
(collect 단계 ENOENT 소멸. 설계서는 33 pass 로 적었으나 파일의 실제 `it` 개수는 **18** 이다.)

### 3.2 신규 테스트
```
$ npx vitest run test/controlGate
 ✓ test/controlGate.test.ts (19 tests) 151ms
      Tests  19 passed (19)

$ npx vitest run test/webTokenWiring
 ✓ test/webTokenWiring.test.ts (8 tests) 5ms
      Tests  8 passed (8)
```

### 3.3 타입
```
$ npx tsc --noEmit
(출력 없음 · exit 0 = 에러 0)
```

### 3.4 전체
```
$ npx vitest run
 Test Files  2 failed | 265 passed (267)
      Tests  2 failed | 3291 passed (3293)
   Duration  17.74s
```
실패 2건 = **사전 실패 그대로**(지시대로 무접촉):
- `test/placeRoiRuntimeInvariants.test.ts > 런타임 PtzCamRoi.json — 구조 불변식(값 불단정) > 모든 주차면: 4점 + 유한 좌표`
- `test/roiDbLoad.test.ts > loadRoiIntoDb — 정상 로딩(실제 data/Place01/PtzCamRoi.json) > preset_slotidx 는 프리셋별 1-based 연속, slot_roi 는 4점 정규화(프레임 밖 점은 보존·issues 보고)`

중간에 **내 치환이 깨뜨린 실패 2건**이 있었다(`roimakerUi` 의 `fetch\('` 정규식, `slotCuboidRoutes` 의 `fetch('/capture/slots/cuboid'` 문자열 단정). §1 표대로 1줄씩 고쳐 green 으로 되돌렸다. **숨기지 않고 기록한다.**

### 3.5 완료기준 4 — 토큰 켠 상태 시뮬레이션(테스트로 실행함)
`test/controlGate.test.ts` 의 `controlToken:'SECRET'` 앱 인스턴스 기준:

| 호출 | 결과 |
|---|---|
| `POST /capture/slots/reset` 토큰 없음 | **403** `{error:'invalid token'}` |
| 같은 호출 + 틀린 토큰 | **403** |
| 같은 호출 + `x-viewer-token: SECRET` | **200** |
| `PUT /mapping` 토큰 없음 | **403**(기존에 무인증이던 경로) |
| `GET /health`·`/capture/slots`·`/capture/status` 토큰 없음 | **200** |
| RPC `slot.list` 무토큰 | 통과(에러 없음) |
| RPC `slot.reset` 무토큰 | `-32006 FORBIDDEN` |
| RPC `slot.reset` + 토큰 | 통과 |
| RPC `plate.detect` 무토큰 | FORBIDDEN **아님**(면제 확인) |
| `controlToken:''` 인스턴스 | 위 전부 토큰 없이 200/통과 — **현행 무회귀** |

---

## 4. 설계와 달라진 점(3건)

| # | 설계서 | 실제 구현 | 이유 |
|---|---|---|---|
| 1 | `mutFetch` 를 app.js **지역 헬퍼**로 두고 roimaker 는 별도 | `web/token.js` 에서 **export 해 공유** | 같은 함수를 두 파일에 복제할 이유가 없다("정의처는 하나"). roimaker 도 동일 규약을 자동으로 따르게 된다 |
| 2 | 정적 테스트는 "생 `method:'POST'` 0건" | **"생 `fetch(` 호출 구간 내 변이 method 0건"** | 원안대로면 `mutFetch(url,{method:'PUT'})` 같은 정상 코드까지 실패한다. 실제로 잡아야 하는 건 "토큰 없이 나가는 변이"이므로 호출 구간 단위로 판정 |
| 3 | 기존 4곳은 `tokenHeaders` 를 `authHeaders` 위임으로 교체 | `tokenHeaders` **삭제**, 호출부는 평범한 헤더 | 4곳 전부 mutFetch 를 타므로 위임 함수가 이중 부착만 하는 고아가 된다(CLAUDE.md §3 "내 변경으로 고아가 된 코드는 제거") |

설계 결함으로 판단해 설계자에게 문의할 사항은 **없었다** — §1 조사 수치가 실코드와 전부 일치했다(변이 fetch 32+3=35곳, 토큰 전송 4곳, 면제 대상 4경로).

---

## 5. 검증하지 못한 항목(정직 보고)

1. **라이브 브라우저 확인 미수행.** 13021 서버를 `controlToken:'T'` 로 띄워 실제 버튼을 눌러보지는 않았다(마스터 config 실값 파일을 바꿔야 해서 손대지 않음 — 지시). 대신 ①정적 봉인(생 변이 fetch 0건 + 탐지력 실증) ②서버측 403/200 시뮬레이션으로 대체했다. **localStorage 실제 영속·`#viewer-token` 입력 반응은 브라우저 육안 확인이 최종 확정**이다(검증자 인계 항목).
2. **뷰어 라우트를 켠 인스턴스에서의 전역 게이트 동작**을 직접 403 으로 확인하지 않았다(테스트는 `viewer.enabled:false`). 전역 훅이 `app.register` 캡슐보다 상위인 것은 Fastify 계약이며, `viewerRoutes`·`viewerCameraposRoutes`·`viewerLlmRoutes` 테스트는 전부 green(= 토큰 미설정 시 무회귀는 확인).
3. **알려진 한계(리더 결정 Q1(a) 유지)**: `POST /capture/detect` 는 게이트 면제인데 카메라를 물리적으로 움직인다. 무인증 카메라 조작 경로가 남아 있다 — 코드 주석에 명시했고 **문서화 단계에서 별건으로 올려야 한다.**
4. 워크트리 루트에 정체불명 파일 `x.json`(untracked)이 있다. 내가 만든 것이 아니며 **건드리지 않았다**(보고만 한다).

---

## 6. 다음 웨이브 인계

- 게이트는 **경로 목록이 아니라 규칙**이다. W2~W4 에서 신규 변이 라우트(`/capture/tour/start` 등)를 추가하면 **자동으로 보호된다**(deny-by-default). 반대로 읽기전용 POST(`slot.occupancy.evaluate` → `POST /capture/slots/judge-occupancy`, `mutating:false`)를 추가하면 **`READONLY_POST_PATHS` 에 반드시 추가**해야 한다 — 안 하면 드리프트 테스트가 먼저 실패해서 알려준다(그게 설계 의도다).
- W2~W4 에서 웹에 변이 fetch 를 새로 추가할 때는 **반드시 `mutFetch`** 를 써라. 생 `fetch` 로 쓰면 `webTokenWiring` 이 실패한다.
- `test/fixtures/setupResult.23slots.json` 은 W2 투어링 파리티 테스트(T1)의 입력으로 그대로 재사용하면 된다.
