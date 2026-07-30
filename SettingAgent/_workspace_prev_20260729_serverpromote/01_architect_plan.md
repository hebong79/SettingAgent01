# 01 설계 계획 — 서버 정본화 4건(인증토큰 / 투어링 / 점유판정 / 슬롯편집)

작성: 2026-07-28 · 워크트리 `.claude/worktrees/feat-server-promote-4/SettingAgent`
입력: `메모/memo.md` 2026-07-28 「서버 RPC화」 재개 지점 표(우선 1~4) · `docs/20260728_183010_..._RPC화_설계서.md` · `docs/20260728_191516_RPC제어평면_구현_영향도분석.md`
근거: 아래 모든 사실은 **워크트리 실코드를 직접 읽어** 확인했다. 추측 없음. 파일:라인 명시.
(이전 라운드 산출물은 `_workspace_prev_20260728_placedrawfix/` 로 보존했다.)

---

## ★ 먼저 보고 — 과제 설명과 다른 사실 3건

리더 지시문에 사실과 다른 전제가 3개 있다. 설계가 여기서 갈리므로 착수 전에 확정한다.

| # | 지시문 전제 | 실제 | 영향 |
|---|---|---|---|
| A | "서버에 이미 `buildTouringPlan`(+`test/buildTouringPlan.test.ts`)이 있다" | **서버에 없다.** `buildTouringPlan` 은 `web/core.js:1689` 에만 있고, `test/buildTouringPlan.test.ts:3` 이 `../web/core.js` 를 직접 import 한다. `grep -rn buildTouringPlan src` → **0건** | 투어링은 "잡만 신설"이 아니라 **순회계획 순수함수 포팅 + 파리티**까지 포함한다 |
| B | 슬롯편집이 "`save/Setup_*.json` 과 DB(slot_setup) 양쪽을 건드린다" | **둘 다 안 건드린다.** `addSlot`(app.js:1455)/`deleteSelectedSlot`(app.js:1477)은 `state.mapping`(메모리 SetupArtifact)만 고치고, 영속화는 `saveMapping`(app.js:1526)의 `PUT /mapping` → `saveMappingHandler`(server.ts:81) → `repo.saveArtifact` → **`data/setup_artifact.json` 단 하나**다 | 파일↔DB 문제는 "쓰기 충돌"이 아니라 **"쓴 것이 다음 renumber 에 덮여 사라지는 순서 문제"**로 성격이 다르다(§4.1 Q2) |
| C | 사전 존재 실패 2건 | 워크트리에서는 **3건**이다. `roiDbLoad`·`placeRoiRuntimeInvariants`(지시대로 무접촉) + **`test/buildTouringPlan.test.ts` 가 collect 단계에서 ENOENT 로 죽는다** — `:7` 이 `save/setup_result.json` 을 읽는데 `save/` 는 `.gitignore:21` 로 무시돼 워크트리에 없다 | 투어링의 **첫 단계가 이 테스트를 살리는 것**이다(§5 단계 1). "건드리지 마라" 대상이 아니라 이번 범위 안의 문제 |

실행 결과(실측):
```
npx vitest run test/rpcParity.test.ts test/buildTouringPlan.test.ts
  ✓ test/rpcParity.test.ts (13 tests)
  ❯ test/buildTouringPlan.test.ts (0 test)  ← ENOENT: save/setup_result.json
```

---

## 0. 공통 규약(4건 전부에 적용 — 구현자 필독)

1. **RPC 는 로직 0줄.** 신규 메서드는 전부 `MethodDef.http`(브리지 위임)로 만든다. `handler` 는 이번 4건에서 **하나도 쓰지 않는다**(승격 서비스가 필요 없도록 설계했다).
2. **`test/rpcParity.test.ts:192-207` 의 `known` 경로집합을 최소로 건드린다.** 판정식은 `url === k || url.startsWith(k + '/')`(216행)이므로:
   - `/capture/slots/*` → `'/capture/slots'` 가 이미 있어 **무편집 통과** → 점유판정 라우트를 여기에 둔다.
   - `/mapping/*` → `'/mapping'` 이 이미 있어 **무편집 통과** → 슬롯편집 라우트를 여기에 둔다.
   - `/capture/tour/*` → 미커버. **투어링만 `known` 에 3줄 추가**한다(이 테스트가 막으려는 건 "오타·발명된 경로"이지 "의도적 신규 라우트"가 아니다). 추가와 동시에 §5-T4 의 동적 교차검사를 붙여 정적 목록보다 강한 보증으로 바꾼다.
3. **오류코드**: 라우트가 내는 HTTP 를 `mapHttpStatus`(errors.ts:94)가 자동 변환한다. 신규 라우트는 상태코드만 정확히 내면 된다.

   | 상황 | HTTP | 라우트 응답 | RPC 코드 |
   |---|---|---|---|
   | 잡 중복 시작·카메라 점유 | 409 | `already running` / `busy` 문자열 **포함** | `-32001 BUSY`(classify409, errors.ts:86) |
   | 가드 거부(파일·DB **무변경**) | 409 | 위 단어 **미포함** | `-32005 CONFLICT` |
   | 값 없음(결과 파일·슬롯 부재) | 404 | `{ error: '...' }` | `-32002 NOT_FOUND` |
   | 기능 off(라우트 미등록) | — | Fastify 기본 404 | `-32004 UNAVAILABLE`(자동) |
   | zod 실패 | 400 | `{ error:'invalid body', detail }` | `-32602 INVALID_PARAMS` |
   | 토큰 불일치 | 403 | `{ error: 'invalid token' }` | `-32006 FORBIDDEN` |

   판정 불가 시 **CONFLICT**(안전측). 새 문자열 규약을 만들지 말 것.
4. **`src` → `web` import 금지.** 반대 방향만. 웹 순수모듈이 서버에 필요하면 **포팅 + 파리티 테스트**가 유일한 수단이다(선례: `occupancyRegionParity`·`quadCentroidParity`·`occupancyGeometryParity`).
5. **수치 영속화는 `stringify5`/`round5`.** TEXT writer 는 `stringify5` 필수. 이번 4건 중 DB TEXT 를 쓰는 것은 **없다**(설계상 회피 — §4.1 Q3).
6. **1-based**: cam/preset/presetSlotIdx/globalIdx 전부 1-based. `slotId` 는 artifact 에선 **문자열**(`c1p1s1`), DB 에선 **정수** — 혼동 금지(§4.1 Q2).
7. **비파괴 저장**: `replaceSlotSetup`(DELETE+INSERT) 계열을 **호출하지 않는다**. 07-28 `roiSlotSync.ts:109` 의 차등 UPDATE 가 정본 패턴. 이번 4건은 아예 DB 쓰기를 하지 않도록 설계했다.
8. **결정형 도구 vs LLM 두뇌 경계**: 4건 **전부 결정형 도구**다. 순회 PTZ 이동·점유 기하판정·인덱스 재부여·토큰 비교는 수치반복/규칙연산이라 LLM 관여 지점이 0이다. `AgentRuntime.judgeOccupancy`(brain/AgentRuntime.ts:292)는 **점유"율" 요약 자문**이지 슬롯 점유 판정이 아니다 — 이번 `slot.occupancy.evaluate` 와 혼동해 배선하지 말 것.
9. **★ 기능을 서버로 옮기면 "PTZ 동기화 책임"도 함께 옮긴다** (W2 구현에서 발견 — 초판 설계 누락). 기존 웹 기능이 `move()` 로 카메라를 움직이면 `state.ptz` 가 함께 갱신됐다. 같은 일을 서버 잡이 하면 **카메라만 움직이고 브라우저 기준 PTZ 는 옛 값에 남아**, 직후 방향/절대 이동이 "이전 위치로 되돌아갔다가 한 스텝" 움직인다(`test/viewerPtzSyncCoverage.test.ts` 머리말의 마스터 실측 증상). → 서버 승격 기능은 **완료 감지 지점에서 `await syncPtzAfterJob(null)`** 을 부르고, 그 라우트를 `viewerPtzSyncCoverage.test.ts` 의 `MOVES_CAMERA`+`SYNC_OWNER` 또는 `NO_MOVE` 표에 **반드시 등록**한다. 등록은 선택이 아니다 — 표에 없으면 첫 번째 it 이 실패하도록 설계된 봉인이다.
   - W2 `/capture/tour/start` → `MOVES_CAMERA` + `SYNC_OWNER['/capture/tour/start']='runTouringTest'` (완료).
   - **W3 `/capture/slots/judge-occupancy` → `NO_MOVE`**(stateless 판정·카메라 무접촉 — §3.2 설계가 그렇게 잡은 이유가 여기서도 값을 한다).
   - **W4 `/mapping/slot`·`/mapping/slot/delete` → `NO_MOVE`**(파일 IO만).

---

# 1. 인증 토큰

## 1.1 현황 정밀 조사

| 항목 | 서버에 있는 것 | 웹에만 있는 것 | 비고 |
|---|---|---|---|
| 토큰 값 | `config/tools.config.json` `viewer.controlToken = ""`(실측) / 스키마 `toolsConfig.ts:230` | — | 빈 문자열 = 게이트 전면 무효 |
| 게이트 코드 | **4곳뿐**: `viewer/routes.ts:321`(POST /viewer/api/move) · `:368`(POST /viewer/api/rpc) · `:402`(POST /viewer/api/llm/select) · `:431`(PUT /viewer/api/camerapos) | — | 전부 동일 식 → 403 `{error:'invalid token'}` |
| RPC 게이트 | `dispatch.ts:117-120` + `tokenGate`(:143) — `MethodDef.mutating` 기준. 브리지가 하류로 토큰 전달(`bridge.ts:43`) | — | **여기만 제대로 돼 있다**(카탈로그가 단일 출처) |
| 무인증 노출 | `/capture/*`(captureRoutes 전부) · `/calibrate/*` · `/discover/*` · `/mapping*` · `PUT /settings` · `/setup/*` — 게이트 **0** | — | 토큰을 켜도 그대로 뚫려 있다 |
| 웹 토큰 전송 | — | `tokenHeaders()` app.js:4464. 사용처 **4곳뿐**: `:1808` `:1968` `:4475` `:4555` | 웹 변이 fetch 는 **총 35곳**(app.js 32 + roimaker.js 3) → **31곳이 토큰 미전송** |
| 토큰 영속화 | — | `#viewer-token` 입력칸(index.html:608). `localStorage` 사용처는 패널폭(app.js:4682)·육면체높이(:5047)뿐 — **토큰은 없다** | 새로고침 시 소실 |
| MCP | `src/mcp/server.ts:34` 가 `cfg.viewer.controlToken` 을 `x-viewer-token` 으로 자동 주입 | — | **MCP 는 이미 안전** |

### ★ 결정적 사실
토큰을 켜는 순간 **웹 UI 버튼 31개가 403 으로 죽는다**(저장·수집시작·센터라이징·탐색·ROI저장·재번호 전부). "게이트를 넓히는 일"과 "웹이 전 경로에 토큰을 붙이는 일"은 **같은 커밋 묶음**이어야 한다. 하나만 하면 회귀다.

## 1.2 설계

### 신규 `src/api/controlGate.ts`
```ts
/** 변이 게이트에서 **면제**되는 비-GET 경로(읽기 전용 POST). methods.ts 의 mutating:false 와 1:1. */
export const READONLY_POST_PATHS: ReadonlySet<string>;
// = { '/capture/detect', '/capture/place-roi/validate', '/capture/ground-grid/bootstrap', '/capture/autocorrect' }

/** RPC 평면 — 메서드별로 dispatch 가 자체 게이트한다(통째로 막으면 읽기 메서드가 죽는다). */
export const SELF_GATED_PATHS: ReadonlySet<string>;   // = { '/rpc' }

/** 이 요청이 토큰 게이트 대상인가(순수 판정 — 단위 테스트 대상). */
export function needsControlToken(method: string, url: string): boolean;

/** 전역 훅 등록. controlToken 이 빈 값이면 훅 자체를 달지 않는다(현행 동작 완전 보존). */
export function registerControlTokenGate(app: FastifyInstance, viewer?: ToolsConfig['viewer']): void;
```
- 판정: `GET`/`HEAD`/`OPTIONS` 면제 → `SELF_GATED_PATHS` 면제 → `READONLY_POST_PATHS` 면제 → **그 외 전부 게이트**(deny-by-default). URL 은 `url.split('?')[0]` 로 비교.
- 실패 응답은 기존과 **바이트 동일**: `reply.code(403).send({ error: 'invalid token' })` → `mapHttpStatus`(errors.ts:96)가 FORBIDDEN 으로 접는다.
- 훅: `app.addHook('onRequest', ...)` — body 파싱 전에 끊는다.

### 수정
- `src/api/server.ts` — `buildServer` 최상단(`/health` 등록 **직전**)에 `registerControlTokenGate(app, deps.viewer)` **1줄**. 훅은 인스턴스 전역이라 이후 등록되는 capture/calibrate/discover/rpc/뷰어 캡슐(`app.register`)에 전부 적용된다.
- `src/viewer/routes.ts` — **인라인 게이트 4곳은 존치**(제거하지 않는다). 이유 ①동일 판정·동일 응답이라 이중 검사해도 결과 불변 ②`/move` 는 `allowMove === false` 검사(routes.ts:317)가 토큰 검사보다 먼저여야 `{error:'move disabled'}` 가 유지된다. 전역 훅이 통과시킨 뒤 인라인이 `allowMove` 를 보므로 **토큰이 맞는 요청에서는 기존 메시지가 그대로** 나온다 → `test/viewerRoutes.test.ts:222` 무회귀.

### 웹 껍데기화(토큰 배선)
- 신규 `web/token.js`:
  ```js
  export const TOKEN_KEY = 'pa.viewerToken';
  export function getControlToken();          // localStorage → string
  export function setControlToken(v);         // '' 이면 removeItem
  export function authHeaders(base = {});     // 토큰 있으면 x-viewer-token 부착
  ```
- `web/app.js`
  - `tokenHeaders`(:4464)를 `authHeaders` 위임으로 교체(입력칸 값 → 저장소로 일원화).
  - 초기화 시 `#viewer-token.value = getControlToken()`, `input` 이벤트에서 `setControlToken(...)` (2줄).
  - **변이 fetch 31곳** → 지역 헬퍼 `mutFetch` 경유:
    ```js
    function mutFetch(url, init = {}) {
      return fetch(url, { ...init, method: init.method ?? 'POST',
        headers: authHeaders(init.headers ?? {}) });
    }
    ```
    치환 대상 라인(실측 32곳): 1234·1531·1807·1967·2133·2202·2536·2589·2607·2724·2746·2792·3180·3262·3275·3346·3367·3395·3429·3447·3509·3543·3683·3808·3822·3907·4273·4285·4438·4474·4554·5181
- `web/roimaker.js` — 202·566·595 3곳 동일 치환(`web/token.js` import).
- **UX 불변**: 버튼·문구·흐름 동일. 헤더 1개가 더 붙을 뿐.

### RPC 노출
신규 메서드 **없음**. 토큰은 전송 계층 관심사다. 설정 쓰기(`PUT /settings`)를 RPC 에 노출하지 않는 기존 결정(methods.ts:594)을 유지한다.

## 1.3 검증
- `test/controlGate.test.ts`(신규)
  1. `needsControlToken` 판정표: GET 면제 / `/rpc` 면제 / `/capture/detect` 면제 / `/capture/start` 게이트 / `PUT /mapping` 게이트 / 쿼리스트링 무시.
  2. `controlToken:''` → 훅 미등록 → 기존 라우트 전부 200(회귀 0).
  3. `controlToken:'SECRET'` → `POST /capture/slots/reset` 토큰 없이 403 `{error:'invalid token'}`, 토큰 동봉 200.
  4. `controlToken:'SECRET'` + RPC: `slot.list`(GET 위임) 무토큰 통과 / `slot.reset` 무토큰 FORBIDDEN / 토큰 동봉 통과 → `test/rpcDispatch.test.ts:193-208` 의 결론이 훅 도입 후에도 유지됨을 재확인.
  5. **드리프트 방지(핵심)**: `METHODS` 중 `http` 보유 항목을 순회해 `mapping.method !== 'GET'` 이면 `m.mutating === !READONLY_POST_PATHS.has(url)` 단정 → 게이트 목록과 카탈로그 `mutating` 이 갈리면 즉시 실패.
- `test/webTokenWiring.test.ts`(신규·정적): `web/app.js` 문자열에서 생 `method: 'POST'|'PUT'|'DELETE'` 가 **0건**(전부 `mutFetch` 경유)임을 단정 + `TOKEN_KEY`/`localStorage` 존재 단정. (선례: `test/buildTouringPlan.test.ts:313` 의 index.html 문자열 검사)
- 회귀: `viewerRoutes` · `viewerCameraposRoutes` · `viewerLlmRoutes` · `rpcDispatch` · `rpcParity` green.

---

# 2. 투어링 — `capture.tour.*`

## 2.1 현황 정밀 조사

| 요소 | 서버 | 웹 | 판정 |
|---|---|---|---|
| 순회계획 산출 | **없음** | `web/core.js:1689 buildTouringPlan(setupResult) → {steps,skipped}` | **웹 전용** — 포팅 필요 |
| setup_result 로딩 | `GET /capture/saves/:name`(captureRoutes.ts:699) + `SaveStore.load` + `SETUP_RESULT_NAME='setup_result'`(setupResult.ts:10) | `fetch('/capture/saves/setup_result')` app.js:1884 | **양쪽**(웹은 서버 라우트를 부를 뿐) |
| 프리셋 PTZ 해석 | `resolvePresetPtz` detectPipeline.ts:214 | `findPresetPtz` core.js:322 | **양쪽·동일 알고리즘**(둘 다 pan/tilt/zoom 셋 다 있을 때만 반환) → 서버 것 그대로 쓴다 |
| PTZ 이동 | `ICameraClient.move(camIdx,pan,tilt,zoom)` CameraClient.ts:47 | `move(ptz)` → `POST /viewer/api/move` app.js:1799 | **양쪽** |
| 프리셋 폴백 이동 | `camera.requestImage(cam,preset)`(preset 모드 = 물리 이동) | `gotoPreset()` snapshot preset 모드 app.js:1850 | **양쪽·동형** |
| 순회 루프·1초 대기·재진입 방지·진행표시·완료모달 | **없음** | app.js:1876-1932(`state.touringActive`:147, 버튼 라벨, `#touring-done-modal`) | **웹 전용** — 잡으로 승격 |
| 잡 패턴 | `PlateDiscoveryJob`(PlateDiscoveryJob.ts:58) · `LensCalibrationJob` · `PtzCalibrator` · `CaptureJob` | — | 미러 대상 |
| 점유 판정처 | `jobBusy`(index.ts:116-123, 3잡) → `rpcBusy`(:134, +렌즈) | — | TourJob 을 여기에 추가해야 한다 |
| 테스트 | `test/buildTouringPlan.test.ts` — `web/core.js` import, **gitignore 파일 의존으로 collect 실패** | | §5 단계 1 에서 먼저 고친다 |

## 2.2 설계 — 신규/수정 파일

**신규 `src/setup/touringPlan.ts`**(순수·I/O 0)
```ts
export interface TourStep {
  kind: 'preset' | 'slot';
  camId: number; presetId: number;
  presetSlotIdx?: number | null; slotId?: number;
  ptz?: { pan: number; tilt: number; zoom: number };
}
export interface TourPlan { steps: TourStep[]; skipped: number }
export function buildTouringPlan(setupResult: unknown): TourPlan;
```
`web/core.js:1689-1722` 를 **자구 그대로** TS 로 옮긴다: 정렬키 `camId → presetId → (presetSlotIdx ?? 0) → slotId`, 그룹 최초 진입 시 preset 스텝 1개, `centering` 3값 전부 non-null 일 때만 slot 스텝(아니면 `skipped++`), graceful(`null`/`undefined`/`{}` → `{steps:[],skipped:0}`). **새 알고리즘 발명 금지.**

**신규 `src/capture/TourJob.ts`** — `PlateDiscoveryJob` 상태머신 미러
```ts
export type TourState = 'idle' | 'running' | 'stopping' | 'done' | 'aborted' | 'error';
export interface TourStatus {
  state: TourState; done: number; total: number;
  presets: number; slots: number; skipped: number;
  current?: { kind: 'preset'|'slot'; camId: number; presetId: number; slotId?: number };
  startedAt?: string; endedAt?: string; error?: string;
}
export interface TourJobDeps {
  camera: ICameraClient;
  /** setup_result 정본 로더. 기본 = () => saveStore.load(SETUP_RESULT_NAME) */
  loadSetupResult: () => unknown | null;
  dwellMs?: number;                    // 기본 1000(웹과 동일)
  sleep?: (ms: number) => Promise<void>;
  now?: () => string;
  onFinished?: (state: 'done'|'aborted'|'error') => void;   // 미주입 시 no-op
}
export class TourJob {
  getStatus(): TourStatus;
  /** 중복 시작 시 throw new Error('tour already running') → 라우트 409 → BUSY */
  start(opts?: { dwellMs?: number; camera?: ICameraClient }):
    { total: number; presets: number; slots: number; skipped: number };
  stop(): void;    // stopRequested = true → state = 'stopping'
}
```
실행 규칙(app.js:1909-1921 과 1:1):
- **preset 스텝**: `resolvePresetPtz(camera, camId, presetId)` → 있으면 `camera.move(...)`, `null` 이면 `camera.requestImage(camId, presetId)` 폴백(**스킵하지 않는다** — app.js:1916 과 동일).
- **slot 스텝**: `camera.move(camId, ptz.pan, ptz.tilt, ptz.zoom)`.
- 각 스텝 후 `sleep(dwellMs)`.
- 개별 스텝 실패는 **흡수**(`logger.warn` + 계속) — PlateDiscoveryJob:177-192 와 동일 철학.
- 스텝 사이마다 `stopRequested` 확인 → `state='aborted'` + `endedAt` 기록 후 종료.
- **DB·파일에 아무것도 쓰지 않는다**(app.js:1875 주석 계승) → `destructive:false`.

**신규 `src/api/tourRoutes.ts`**(discoverRoutes.ts 패턴, 얇은 진입점)

| 메서드 | 경로 | 요청 | 응답(200) | 실패 |
|---|---|---|---|---|
| POST | `/capture/tour/start` | `{ dwellMs?: 0..10000, source?: string }` | `{ ok:true, started:true, total, presets, slots, skipped }` | zod 400 `invalid body` / 중복 409 `tour already running` / setup_result 없음 **404** `{error:'no setup_result'}` / 스텝 0 **409** `{error:'순회할 슬롯/프리셋이 없습니다'}` |
| POST | `/capture/tour/stop` | 없음 | `{ ok:true, state }` | — (idle 이어도 200·멱등) |
| GET | `/capture/tour/status` | — | `TourStatus` | — |

- `source` 는 `resolveSourceCamera(deps, source, reply)`(routeHelpers.ts:138) — `/calibrate/point`(calibrateRoutes.ts:65)와 **동일 관용구**. 미지정이면 파이프라인 카메라.
- **★ 라우트 자체에서도 `deps.isBusy?.()` 를 확인해 409 를 낸다.** RPC 는 `requiresCamera` 게이트로 막히지만 **REST 직접 호출은 dispatch 를 안 탄다** — 최종 방어선이 라우트에 있어야 한다(R5).

**수정 `src/api/server.ts`**
- `ApiDeps` 에 `tourJob?: TourJob` 추가.
- `if (deps.tourJob) registerTourRoutes(app, { job: deps.tourJob, sources: deps.sources, cameraCfg: deps.cameraCfg, isBusy: deps.isBusy });` (가산·graceful — 미주입이면 미등록 → RPC 는 `-32004 UNAVAILABLE`).

**수정 `src/index.ts`**
- `const tourJob = new TourJob({ camera, loadSetupResult: () => saveStore.load(SETUP_RESULT_NAME) });` — finalizer 조립 이후, `jobBusy` **이전**.
- `jobBusy`(:116-123) 배열에 `['투어링', tourJob.getStatus().state]` 한 줄 추가 → 렌즈 캘리브레이션 시작 거부와 RPC `requiresCamera` 게이트가 **동시에** 투어링을 인지한다(판정처 단일 유지).
- `buildServer({ ..., tourJob })`.

**수정 `src/rpc/methods.ts`** — `capture.*` 섹션에 3개(전부 `http` 위임)
```ts
{ name:'capture.tour.start', title:'셋업 결과 순회 이동 시작', mutating:true, requiresCamera:true,
  preconditions:['setup_result 존재(setup.result.write 또는 정밀수집 완료)'],
  note:'DB·파일을 쓰지 않는다(읽기 순회). 각 위치 dwellMs(기본 1000ms) 정지.',
  http:(p)=>({ method:'POST', url:'/capture/tour/start', payload:p }) },
{ name:'capture.tour.stop', title:'순회 중단', mutating:true,
  http:()=>({ method:'POST', url:'/capture/tour/stop' }) },   // 본문 없음 → bridge.ts:37-44 가 content-type 미부착(기존 결함 재발 금지)
{ name:'capture.tour.status', title:'순회 진행 상태', mutating:false,
  http:()=>({ method:'GET', url:'/capture/tour/status' }) },
```

## 2.3 웹 껍데기화 diff 계획

| 대상 | 조치 |
|---|---|
| `web/app.js:1876-1932 runTouringTest` | **본문 교체**. **유지**: 버튼 disable/라벨(1878-1879,1906,1911,1924), `#cap-msg` 문구, `#touring-done-modal`(1928-1931). **제거**: `fetch('/capture/saves/setup_result')`(1884), `buildTouringPlan` 호출(1896), for 루프 전체(1909-1921), `move`/`gotoPreset` 호출(1915-1918), `setTimeout` 1초 대기(1920) |
| 새 흐름 | `mutFetch('/capture/tour/start', {body})` → `{total,presets,slots,skipped}` → **1초 폴링** `GET /capture/tour/status` → `done/total` 로 버튼 라벨 갱신 → `state ∈ {done,aborted,error}` 면 폴링 종료 + 완료 모달(문구 동일) |
| `web/app.js:1935 syncTouringPreset` | **유지**. 폴링에서 `status.current.camId/presetId` 변경 시 호출해 화면이 순회를 따라가게 한다(기존 UX 보존 — 원래 동작이 그랬다) |
| `web/app.js:147 state.touringActive` | 유지(폴링 재진입 방지) |
| `web/core.js:1689 buildTouringPlan` | **삭제하지 않는다** — `test/buildTouringPlan.test.ts` 기준변 + 파리티 기준변. `web/app.js:72` 의 import 만 제거(고아 방지) |
| `web/app.js:5074` 결선 | 유지(`test/buildTouringPlan.test.ts:322` 가 이 문자열을 단정한다) |

## 2.4 오류코드 매핑
| 상황 | HTTP | RPC |
|---|---|---|
| 이미 순회 중 | 409 `tour already running` | BUSY(-32001) — 백오프 재시도 |
| 다른 잡이 카메라 점유 | 409(라우트) / dispatch 선차단 | BUSY(-32001) + `who` |
| setup_result 없음 | 404 | NOT_FOUND(-32002) — 정밀수집 먼저 |
| 순회 대상 0(centering 전무) | 409(BUSY 단어 없음) | CONFLICT(-32005) — 사람 개입 |
| `tourJob` 미주입 | Fastify 404 | UNAVAILABLE(-32004) |

---

# 3. 점유판정 — `slot.occupancy.evaluate`

## 3.1 현황 정밀 조사

| 요소 | 서버 | 웹 | 판정 |
|---|---|---|---|
| 점유 **판정** 1단계(차량 접지밴드 argmax) | **없음** | `web/occupancy.js:152 OccupancyJudge.judge`(:158-203) | **웹 전용** — 포팅 대상 |
| 점유 **판정** 2단계(번호판 중심 폴백) | **없음** | `web/core.js:577 computeOccupancy` | **웹 전용** — 포팅 대상 |
| 점유 **영역** 생성(사다리꼴) | `src/domain/occupancyRegion.ts:166` / `:238 buildOccupyRegionsBySlot` | `web/occupancyRegion.js:138` | **양쪽·파리티 봉인됨**(`test/occupancyRegionParity.test.ts`) — **재작업 불필요** |
| 기하 프리미티브 | `geometry.ts:9 area` `:120 quadCentroid` / `polygon.ts:95 pointInPolygon` `:108 rectCorners` `:137 convexIntersectionArea` / `onPlaceFilter.ts groundBand·GROUND_BAND_RATIO·ON_PLACE_MIN_OVERLAP` | `web/occupancy.js:31-123`(src 자구 포팅) | **양쪽·파리티 봉인됨**(`occupancyGeometryParity`·`quadCentroidParity`) — **재작업 불필요** |
| 기존 테스트 | `computeOccupancy.test.ts`(→web/core.js) · `occupancyJudge.test.ts`(→web/occupancy.js) · `occupancyRegionParity`(web↔src) · `occupancyGeometryParity`(web↔src) | | **웹 구현이 이미 봉인돼 있다** → 포팅본은 파리티만 추가 |
| LLM 점유 | `AgentRuntime.judgeOccupancy`(:292) = 점유"율" 요약 자문 | — | **무관** — 배선 금지 |
| 웹 소비처 | — | `updateLogicOccupancy()`(app.js:518) ← `drawRoiOverlay()`(**:445 — 매 리드로**) + `renderSlotList()`(**:1306**). 결과 `state.occComputeByKey`(:113) → `drawOccupancyOverlay`(:557) / `buildFlatSlotRows({judge})`(core.js:701,:709-714) | 호출 빈도가 설계의 핵심 제약 |

### ★ 결정적 사실
`updateLogicOccupancy` 는 **`drawRoiOverlay()` 안에서 매 리드로 호출된다**(app.js:445). 이걸 그대로 서버 왕복으로 바꾸면 캔버스 리사이즈·선택 변경·마우스 조작마다 HTTP 가 나간다 — **불가**. 껍데기화의 본체는 "함수 안을 fetch 로 바꾸기"가 아니라 **호출 시점을 데이터 변경점으로 옮기는 것**이다(§3.3).

## 3.2 설계 — 신규/수정 파일

**신규 `src/domain/occupancyJudge.ts`**(순수·결정형·I/O 0)
```ts
export interface FloorPolygon { idx: number; quad: readonly NormalizedPoint[] }
export interface PlateDet   { quad: NormalizedQuad }
export interface VehicleDet { rect: NormalizedRect; plate?: PlateDet | null }
export interface DetectInput { plates?: PlateDet[] | null; vehicles?: VehicleDet[] | null }
export interface OccupancyRow {
  idx: number; occupied: boolean; source: 'plate' | 'bbox' | null;
  center?: NormalizedPoint; plateQuad?: NormalizedQuad; vehicleRect?: NormalizedRect;
}
export interface JudgeConfig { groundBandRatio: number; minBandOverlap: number }

/** = web/core.js:577 computeOccupancy 자구 포팅. 번호판 중심 ∈ 폴리곤. */
export function computeOccupancy(floorPolygons: unknown, plates: unknown): OccupancyRow[];

/** = web/occupancy.js:152 judge 자구 포팅. 1단계 접지밴드 argmax → 2단계 번호판 폴백. */
export function judgeOccupancy(floorPolygons: unknown, detect: unknown, cfg?: Partial<JudgeConfig>): OccupancyRow[];
```
포팅 규칙(**신규 알고리즘 발명 금지**):
- `quadCentroid`: **웹 판은 4점·수치가 아니면 `null`**(core.js:558-565), 서버 `geometry.ts:120` 은 항상 값을 반환한다. → `occupancyRegion.ts:74 quadCentroid4` 와 **같은 가드**를 로컬로 두고 통과 시에만 `geometry.quadCentroid` 를 호출한다. 가드를 빼면 퇴화 입력에서 판정이 조용히 뒤집힌다.
- `pointInQuad`(core.js:765) ↔ `pointInPolygon`(polygon.ts:95): 식이 동일함을 확인했다(ray casting·동일 tie-break). 단 웹 판은 `length < 3` 선행 가드가 있으므로 포팅본도 같은 가드를 둔다.
- 상수·`groundBand` 는 `../capture/onPlaceFilter.js` 에서 **import**(값 복제 금지 — 복제하면 `occupancyGeometryParity` 가 못 잡는 3번째 정의가 생긴다). `domain → capture` import 가 새로 생기지만 순환은 없다(onPlaceFilter 는 domain 만 참조). → §7 Q2.
- `quadKey`(occupancy.js:129)·`placedPlateKeys`/`placedVehicles` 중복차단·strict `>` tie-break(:173)·퇴화 rect 스킵(:166) 전부 그대로.

**신규 라우트**(`src/api/captureRoutes.ts` 내 `/capture/slots/*` 가족 자리 — :451-490)

| 메서드 | 경로 | 요청 | 응답 |
|---|---|---|---|
| POST | `/capture/slots/judge-occupancy` | `{ frames: [{ key: string, floorPolygons: [{idx, quad}], detect: {plates?, vehicles?} }], cfg?: {groundBandRatio?, minBandOverlap?}, regions?: boolean }` | `{ byKey: { [key]: { rows: OccupancyRow[], regions?: [{idx,scale,polygon}], overlapPairs?: [[n,n]] } } }` |

- 경로 근거: `'/capture/slots'` 가 `rpcParity` `known` 에 이미 있어 **무편집 통과**. `occupy`(영역 생성, :485)와 헷갈리지 않게 `judge-occupancy` 로 명명(`load-roi`/`sync-roi` 와 같은 동사형 스타일).
- **stateless**: cam/preset 을 받아 서버가 검출을 다시 돌리지 **않는다**. `POST /capture/detect` 는 카메라를 실제로 움직이므로(app.js:1238) 여기에 끌어들이면 읽기 메서드가 카메라를 점유하게 된다 → `mutating:false`, `requiresCamera:false`, **부작용 0**.
- **배치(`frames[]`)인 이유**: `buildFlatSlotRows`(core.js:701)가 **전 프리셋**을 한 번에 판정한다. 프레임마다 왕복하면 프리셋 수만큼 요청이 난다.
- `regions:true` 면 `buildOccupyRegionsBySlot`(occupancyRegion.ts:238)을 `source==='plate' && plateQuad` 행에만 적용 — app.js:529-531 과 **동일 모집단**.
- zod 실패 → 400. `frames` 빈 배열 → 200 `{byKey:{}}`(graceful, throw 금지 철학).

**수정 `src/rpc/methods.ts`** — `slot.*` 섹션
```ts
{ name:'slot.occupancy.evaluate', title:'슬롯 점유 판정(차량 접지 우선·번호판 폴백)', mutating:false,
  note:'순수 판정 — 카메라·DB·파일 무접촉. 검출값은 호출자가 준다(plate.detect 로 얻어 넘겨라).',
  http:(p)=>({ method:'POST', url:'/capture/slots/judge-occupancy', payload:p }) },
```

## 3.3 웹 껍데기화 diff 계획

| 위치 | 현재 | 변경 |
|---|---|---|
| `web/app.js:86` | `const occupancyJudge = new OccupancyJudge()` | **삭제** |
| `web/app.js:518-547 updateLogicOccupancy()` | 동기 판정 + 영역 생성 | `async function refreshOccupancy()` 로 교체. 현재 프리셋 + `state.detectByKey` 의 **모든 키**로 `frames[]` 조립 → `POST /capture/slots/judge-occupancy {frames, regions:true}` → `state.occComputeByKey[key] = { spaces: rows.map(...) }` 로 적재. **적재 형식은 현행과 동일**(`{id,occupied,source,center,vehicleRect,region}`) |
| `web/app.js:445`(`drawRoiOverlay` 안) | `updateLogicOccupancy()` | **삭제**(리드로가 네트워크를 타지 않게) |
| `web/app.js:1306`(`renderSlotList` 안) | `updateLogicOccupancy()` | **삭제** |
| 새 호출 지점 | — | ①`runLiveDetect`(app.js:1248 직후, `drawRoiOverlay()` 앞) ②placeRoi 로드/편집 커밋 직후 ③프리셋 전환 시 캐시 없으면 1회 — **데이터가 바뀌는 3곳뿐** |
| `web/core.js:701 buildFlatSlotRows({placeRoi,detectByKey,parkingSlotsByKey,judge})` | `judge` 주입 → 내부 판정(:709-714) | 시그니처를 `{placeRoi, parkingSlotsByKey, occByKey}` 로 변경. `judge ? ... : computeOccupancy(...)` 분기를 **`occByKey[key]?.spaces` 조회**로 대체. `detectByKey`·`judge` 인자 제거 |
| `web/occupancy.js` | `OccupancyJudge` + 기하 포팅 | **삭제하지 않는다** — `occupancyJudge.test.ts`·`occupancyGeometryParity.test.ts` 기준변 + 신규 서버 포팅본의 **파리티 기준변**. app.js 의 import 만 제거 |
| `web/core.js:577 computeOccupancy` | 판정 | 동일 사유로 **유지**(`computeOccupancy.test.ts` 기준변). `occupancy.js:222` 의 내부 호출도 그대로 |
| `drawOccupancyOverlay`(:557) / 슬롯목록 뱃지(:1318) | `state.occComputeByKey` 소비 | **무변경** — 소스 shape 을 그대로 맞췄기 때문 |

**UX 불변 확인**: 오버레이 원·사다리꼴·`(점유)/(공차)` 뱃지·`#roi-db` 소스 전환(:563) 전부 동일. 바뀌는 건 "언제 계산되는가"뿐이며, 사용자 관점에선 검출 도착 시 갱신되는 현행 체감과 같다(현행도 검출 도착 → `drawRoiOverlay()`(:1262) → 계산 순서였다).

## 3.4 오류코드 매핑
| 상황 | HTTP | RPC |
|---|---|---|
| body zod 실패(quad 3점 미만 등) | 400 | INVALID_PARAMS |
| frames 빈 배열 | 200 `{byKey:{}}` | 정상(graceful) |
| 폴리곤 전부 퇴화 → 판정 불가 | 200 + 해당 행 `occupied:false, source:null` | 정상. **CONFLICT 로 올리지 않는다** — 부작용이 없어 "사람 개입" 대상이 아니고, 위장 점유 생성 금지 원칙과도 일치 |

---

# 4. 슬롯편집 — `setup.slot.add` / `setup.slot.delete`

## 4.1 현황 정밀 조사

| 요소 | 서버 | 웹 | 판정 |
|---|---|---|---|
| slotId 생성 | **없음** | `web/core.js:854 nextSlotId(artifact,cam,preset)` — `c{cam}p{preset}s{N}`, 결번 충돌회피 | 웹 전용 |
| 중간삽입 | **없음** | `web/core.js:876 insertSlotAt(artifact,atGlobalIdx,newSlot)` — globalIndex **명시적 splice**(수동 위치 보존, rebuild 미사용:872 주석) | 웹 전용 |
| 삭제 | **없음** | `web/core.js:839 removeSlot(artifact,slotId)` → `rebuildGlobalIndex`(:805) | 웹 전용 |
| coverage 검증 | `src/setup/GlobalIndexer.ts:44 validateCoverage(global, slots)` — `slotId` 집합 **양방향 일치만** 본다(globalIdx 연속성·중복은 **안 본다**) | — | 서버 |
| 본문 검증·영속화 | `src/api/artifactSchema.ts:66 validateArtifactBody`(zod → plateRoi rect→quad 승격 → validateCoverage) → `repo.saveArtifact`(server.ts:81-89, `PUT /mapping` :304) | `saveMapping()` app.js:1526(**토큰 미전송** :1532) | 서버가 검증·저장 소유 |
| 저장 대상 | `Repository`(store/Repository.ts:13) → **`data/setup_artifact.json` 단 1개**, `stringify5` 경유(:20) | — | **`save/Setup_*.json` 도 DB slot_setup 도 아니다**(전제 B 정정) |
| renumber | `POST /mapping/renumber`(server.ts:365) → DB slot_id(정수) 재번호 → slot_ptz → setup_result → **`repo.saveArtifact(buildArtifactFromSlotSetup(DB))`**(:356) | — | ★ **setup_artifact.json 을 DB 로부터 통째 재생성한다** |
| placement | `POST /mapping/placement`(server.ts:429) | — | :420 에서 동일하게 artifact 재생성 |
| 매핑 읽기 | `resolveMapping()`(server.ts:169) — **파일 우선**, 파일 비면 DB 조립 | — | 파일이 있으면 DB 와 갈릴 수 있다 |
| 기존 테스트 | `test/slotInsertEdit.test.ts` — `web/core.js` 함수들 + `src/setup/GlobalIndexer.validateCoverage` 를 **함께** import 해 이미 교차검증 중 | | 파리티 기준변 확보됨 |

### ★ 선행 설계가 필요했던 3가지 질문의 답

**Q1. coverage 검증과 충돌하는가?** → **안 한다.**
`validateCoverage`(GlobalIndexer.ts:49-53)는 `globalIndex[].slotId` 집합 == `slots[].slotId` 집합만 본다. `insertSlotAt`(core.js:884,900)은 slots·globalIndex 에 **동시에** 넣고, `removeSlot`(core.js:840,845)은 양쪽에서 **동시에** 뺀다 → 구성상 항상 통과.
단 `insertSlotAt` 은 `coveredSlotIds` 에도 append 하는데(:890) `validateCoverage` 는 이걸 **검사하지 않는다** → preset 부재 시 `label:"c:p"`·PTZ 없는 preset 을 조용히 push 한다(:894-896). → 라우트가 그 상황을 **`warnings[]` 로 보고**한다(숨기지 않는다).

**Q2. `slot.renumber` 와의 관계는?** → **네임스페이스가 다르고, renumber 가 상위다.**
- artifact `slotId` = 문자열 `c1p1s1`; DB `slot_id` = 정수. `renumberSlotIds` 는 DB 정수만 다룬다.
- **위험**: artifact 에 슬롯을 넣은 뒤 `slot.renumber` 또는 `slot.placement.update` 를 부르면 server.ts:356/:420 이 `buildArtifactFromSlotSetup(DB)` 로 artifact 를 **통째 덮어써서 추가분이 사라진다**(DB 에는 그 슬롯이 없다).
- **대응**: 응답에 `dbSlotCount`/`artifactSlotCount` + 경고를 싣고, 카탈로그 `note` 에 "renumber/placement 호출 시 이 편집은 DB 기준으로 되돌아간다"를 명시한다. **코드로 막지 않는다**(막으면 renumber 가 못 돈다).

**Q3. 파일↔DB 정합은 어떻게 하나?** → **DB 를 아예 건드리지 않는다.**
- DB `slot_setup` 의 정본 소스는 **ROI 파일(PtzCamRoi.json)** 이다(`roiSlotSync.ts:10` "정본은 파일 하나다"). artifact 는 그 파생물이다.
- artifact 에 슬롯을 추가한다고 주차면이 생기지 않는다. **실제 주차면 추가 경로는 이미 승격돼 있다**: `place.space.add`(read-modify-write) → `slot.roi.sync`(차등 UPDATE·비파괴).
- 따라서 `setup.slot.add/delete` 는 **artifact 편집 전용**이며 `replaceSlotSetup` 도 `writeSetupResultFiles` 도 **호출하지 않는다**. 이것이 07-28 wipe 교훈(검출·센터링 23→0)에 대한 이번 설계의 답이다 — **파괴 경로에 아예 진입하지 않는다.**

## 4.2 설계 — 신규/수정 파일

**신규 `src/setup/artifactSlotEdit.ts`**(순수·I/O 0) — `web/core.js` 4함수 자구 포팅
```ts
export function nextSlotId(artifact: SetupArtifact, camIdx: number, presetIdx: number): string;          // = core.js:854
export function insertSlotAt(a: SetupArtifact, atGlobalIdx: number, newSlot: ParkingSlot): SetupArtifact; // = core.js:876
export function removeSlot(a: SetupArtifact, slotId: string): SetupArtifact;                              // = core.js:839
export function rebuildGlobalIndex(slots: ParkingSlot[], presets: Preset[]): GlobalSlotIndex[];           // = core.js:805
```
불변 규칙 그대로: `insertSlotAt` 은 **명시적 splice**(rebuild 재사용 금지 — core.js:872 주석의 이유가 유효), `at` 은 `[1, N+1]` clamp(:899), 중복 slotId → no-op(:878), `removeSlot` 은 rebuild 사용, `coveredSlotIds` 에 없는 슬롯은 `camIdx/presetIdx = 0` 으로 뒤에 붙음(:820-825).

**수정 `src/api/server.ts`** — `/mapping/*` 가족에 2라우트(`renumberHandler`/`placementHandler` 와 같은 자리·같은 클로저 방식)

| 메서드 | 경로 | 요청 | 응답(200) |
|---|---|---|---|
| POST | `/mapping/slot` | `{ camIdx:int≥1, presetIdx:int≥1, at?:int≥1, rect?:{x,y,w,h}, zone?:string }` | `{ ok:true, slotId, globalIdx, slots, globalCount, warnings:[], dbSlotCount }` |
| POST | `/mapping/slot/delete` | `{ slotId:string, confirm:true }` | `{ ok:true, slotId, slots, globalCount, warnings:[], dbSlotCount }` |

핸들러 흐름(공통):
1. `deps.repo.loadArtifact()` → `null` 이면 **404** `{error:'no setup artifact'}`. *`resolveMapping()` 을 쓰지 않는다* — DB 폴백 결과를 파일로 쓰면 DB 를 파일로 승격시켜 버린다.
2. 편집(`insertSlotAt` / `removeSlot`). **delete 대상 slotId 부재 → 409** `{error:'slotId 없음: X — 파일 무변경'}`(→CONFLICT). `removeSlot` 은 없는 id 에도 조용히 통과하므로 **사전 존재 확인이 필수**.
3. `validateArtifactBody(edited)` 재사용(artifactSchema.ts:66). 실패 → 그 응답(400 `invalid artifact` / 400 `coverage mismatch`) 그대로 반환 — **파일 무변경**.
4. `deps.repo.saveArtifact(v.artifact)`.
5. `warnings[]`: ①신규 preset 생성 시 "`cam:preset` preset 을 새로 만들었다(PTZ 없음)" ②`deps.sqlite` 가 있고 `getSlotSetup().length !== artifact.slots.length` 면 "DB slot_setup 과 개수가 다르다 — slot.renumber/slot.placement.update 호출 시 이 편집은 DB 기준으로 되돌아간다".
6. 기본값은 **웹과 같은 값을 서버가 소유**: `rect = {x:0.45,y:0.45,w:0.1,h:0.1}`(app.js:1463), `zone = 'cam'+camIdx`(app.js:1464).

`deps.sqlite` 는 **읽기(`getSlotSetup`)만** 쓴다. 쓰기 API 호출 금지.

**수정 `src/rpc/methods.ts`** — `setup.*` 섹션
```ts
{ name:'setup.slot.add', title:'셋업 산출물에 슬롯 1개 추가', mutating:true,
  note:'setup_artifact.json 만 바꾼다. 실제 주차면 추가는 place.space.add + slot.roi.sync 다. ' +
       'slot.renumber·slot.placement.update 를 부르면 이 편집은 DB 기준으로 되돌아간다.',
  http:(p)=>{ requireFields(p,['camIdx','presetIdx'],'setup.slot.add');
              return { method:'POST', url:'/mapping/slot', payload:p }; } },
{ name:'setup.slot.delete', title:'셋업 산출물에서 슬롯 1개 삭제', mutating:true, destructive:true,
  note:'위와 동일 — artifact 전용. DB·ROI 정본은 불변.',
  http:(p)=>{ requireConfirm(p,'setup.slot.delete','setup_artifact.json 에서 슬롯을 제거한다');
              requireFields(p,['slotId'],'setup.slot.delete');
              return { method:'POST', url:'/mapping/slot/delete', payload:p }; } },
```
경로 `/mapping/slot*` 은 `known` 의 `'/mapping'` 접두어에 걸려 **`rpcParity` 무편집 통과**.

## 4.3 웹 껍데기화 diff 계획

| 위치 | 변경 |
|---|---|
| `web/app.js:1455-1474 addSlot()` | `async` 화. **유지**: `#map-msg` 가드(1456-1460), `#slot-insert-idx` 읽기(1466), 성공 후 `state.selectedSlotId = data.slotId` · `drawRoiOverlay()` · `renderSlotList()` · `renderSelectionInfo()`(1471-1473). **제거**: `presetKey`(1461)·`nextSlotId`(1462)·rect 리터럴(1463)·newSlot 조립(1464)·`N` 계산(1465)·clamp(1467)·`insertSlotAt`(1468)·`markDirty()`(1470). **추가**: `mutFetch('/mapping/slot', {body:{camIdx:state.cam, presetIdx:state.preset, at}})` → `await loadMapping()`(서버 정본 재동기화 — `saveMapping`:1539 와 동일 관용구), `warnings[]` 를 `#map-msg` 에 표시 |
| `web/app.js:1477-1485 deleteSelectedSlot()` | `async` 화. **제거**: `removeSlot`(1479)·`markDirty()`(1481). **추가**: `mutFetch('/mapping/slot/delete', {body:{slotId:state.selectedSlotId, confirm:true}})` → `await loadMapping()` |
| **★ 동작 변화(의도적)** | 기존 "메모리 편집 → 저장 버튼"(2단계) → **서버 즉시 반영**(1단계). `#map-msg` 를 "추가됨(서버 반영)"으로 바꾸고 `markDirty()` 를 부르지 않는다. 저장 버튼(`saveMapping`)은 ROI 드래그 편집용으로 **그대로 남는다**(그쪽은 여전히 메모리 편집이다). → §7 Q3 |
| `web/app.js:36` import | `insertSlotAt` import 제거(고아 방지). `removeSlot` 은 타 사용처 grep 후 판단 |
| `web/core.js` 4함수 | **유지**(`test/slotInsertEdit.test.ts` 기준변 + 파리티 기준변) |

## 4.4 오류코드 매핑
| 상황 | HTTP | RPC | 파일 |
|---|---|---|---|
| artifact 파일 없음 | 404 | NOT_FOUND | 무변경 |
| 삭제 대상 slotId 부재 | 409 | CONFLICT | **무변경** |
| coverage mismatch(방어) | 400 | INVALID_PARAMS | **무변경** |
| zod 실패 | 400 | INVALID_PARAMS | 무변경 |
| `confirm` 누락(delete) | RPC 단계 차단 | INVALID_PARAMS | 라우트 미도달 |

---

# 5. 구현 순서와 각 단계의 검증

각 단계는 **독립 커밋 가능**하며, 끝날 때마다 `npx tsc --noEmit` 0 + `npx vitest run`(사전 실패 제외) green 이어야 한다.

| # | 단계 | 산출 | 검증(무엇을 고정하는가) |
|---|---|---|---|
| 1 | **fixture 이관(선행)** | `test/fixtures/setupResult.23slots.json` + `test/buildTouringPlan.test.ts` import 변경 | `npx vitest run test/buildTouringPlan` → **collect 실패 → 33 pass**. 사전 실패 3→2건. 원본은 `d:\Work\Parking3D\AgentVLA\ParkAgent\SettingAgent\save\setup_result.json`. 근거: `save/` 는 `.gitignore:21` 런타임 산출물이라 테스트 고정입력이 될 수 없다 |
| 2 | **인증 토큰(서버)** | `src/api/controlGate.ts` + server.ts 1줄 | `test/controlGate.test.ts` 5블록 + `viewerRoutes`/`rpcDispatch`/`rpcParity` 무회귀. **드리프트 테스트가 게이트↔카탈로그 일치를 봉인** |
| 3 | **인증 토큰(웹)** | `web/token.js` + app.js/roimaker.js 35곳 치환 + localStorage | `test/webTokenWiring.test.ts` 정적 단정(생 `method:'POST'` 0건). **라이브**: 13021 에 `controlToken:'T'` 설정 후 웹에서 저장·수집시작이 403 없이 동작 |
| 4 | **투어링 순수함수** | `src/setup/touringPlan.ts` | `test/touringPlanParity.test.ts` — web↔src `toEqual` 완전 일치 |
| 5 | **투어링 잡·라우트·RPC** | `TourJob.ts` · `tourRoutes.ts` · server.ts · index.ts(jobBusy) · methods.ts | `test/tourJob.test.ts`(스텝순서·PTZ null 폴백·중복시작·stop·실패흡수) + `test/tourRoutes.test.ts`(상태코드·isBusy 409·미주입 404) + `rpcParity` known 3줄 + **T4 동적 라우트 검사 신규** |
| 6 | **투어링 웹 껍데기화** | app.js `runTouringTest` 폴링화 | `test/buildTouringPlan.test.ts:313-322`(버튼 위치·결선) **무수정 green** = UX 불변 증거. 라이브 순회 육안 확인 |
| 7 | **점유판정 포팅** | `src/domain/occupancyJudge.ts` | `test/occupancyJudgeParity.test.ts` — T1~T9 + 퇴화 전 케이스 web↔src 일치. 기존 점유 테스트 4종 **무수정 green** |
| 8 | **점유판정 라우트·RPC** | captureRoutes 1라우트 + methods.ts 1줄 | `test/occupancyRoutes.test.ts` + `regions:true` 결과가 `buildOccupyRegionsBySlot` 직접 호출과 동일 |
| 9 | **점유판정 웹 껍데기화** | app.js 호출점 이동 + core.js `buildFlatSlotRows` 시그니처 | 소비 테스트 4개(`boundaryCrossCheck`·`finalizerParkingSlots`·`occupancyAnchor.regression`·`placeGlobalIdx`) **호출부만 수정·단정값 불변**. 라이브: 검출 실행 → 오버레이 원/사다리꼴/뱃지 동일 |
| 10 | **슬롯편집 포팅** | `src/setup/artifactSlotEdit.ts` | `test/artifactSlotEditParity.test.ts` |
| 11 | **슬롯편집 라우트·RPC** | server.ts 2라우트 + methods.ts 2줄 | `test/mappingSlotRoutes.test.ts`(특히 **409 시 파일 md5 불변**) + REST↔RPC 파일 md5 동일 |
| 12 | **슬롯편집 웹 껍데기화** | app.js addSlot/deleteSelectedSlot | 라이브: 추가 → ROI 드래그 → 저장, 삭제 UX 확인 |
| 13 | **마감** | 카탈로그 확인 | `GET /rpc/catalog` count 70 → **76**(tour 3 + occupancy 1 + slot 2). 전체 `vitest` green(사전 실패 2건 제외) |

> **★ 단계 6 ↔ 7 사이 게이트 — ✅ 통과(W2 가 닫음, 2026-07-28)**: `test/viewerPtzSyncCoverage.test.ts` 수집 정규식 `fetch\(` → `[Ff]etch\(`(R15). **설계자 독립 검증 완료** — diff 9+/1−(정규식 1줄 + 사유 주석 4줄 + tour 분류 3줄), 미분류 0건, `viewerPtzSyncCoverage` 13 passed, 전체 `vitest` 2 failed(사전실패)/3349 passed.
>
> **→ W3 는 이 게이트를 통과한 상태에서 착수한다.** §0-9 의 표 등록 강제(`judge-occupancy`·`mapping/slot*` → `NO_MOVE`)가 이제 **실제로 작동한다** — 등록을 빠뜨리면 첫 번째 it 이 실패한다.

## 5.1 파리티 테스트 설계 원칙(3건 공통)
1. **기준변은 항상 `web/*`** — 실운영에서 검증된 쪽이다. 서버 포팅본이 웹을 따라간다.
2. 입력은 **기존 테스트 케이스를 재사용**한다. 새 케이스를 발명하면 두 구현이 아니라 새 기대값을 검증하게 된다.
3. `toEqual` 깊은 비교 — `toBeCloseTo` 로 풀지 않는다. 자구 포팅이므로 부동소수까지 동일해야 하며, 차이가 나면 그건 포팅 오류다.
4. 퇴화 입력(null·비배열·비4점·`w=0`·`plates:null`)을 반드시 포함 — 실제 사고는 항상 거기서 났다.

## 5.2 상세 테스트 항목
- **T1 `touringPlanParity`**: fixture 23슬롯 + 합성(빈/무효/centering=null/단일그룹/역순입력) → web↔src `toEqual`.
- **T2 `tourJob`**: fake camera(`move` 호출 기록) + `sleep: async()=>{}`.
  스텝 순서·횟수가 plan 과 일치(preset 스텝은 그룹 최초 1회) / `resolvePresetPtz` null → `requestImage` 폴백 1회(스킵 아님) / 중복 `start()` → `throw /already running/` / `stop()` → 다음 스텝 전 `aborted`, 이후 `move` 증가 없음 / 개별 `move` reject → 흡수 후 최종 `done` / setup_result null → 라우트에서 404.
- **T3 `tourRoutes`**: start/stop/status shape·상태코드, `dwellMs:-1` → 400, `isBusy` true → 409(BUSY 문자열 포함), `tourJob` 미주입 앱 → 404.
- **T4 `rpcParity` 강화(신규 it)**: 실제 `buildServer` 인스턴스에 대해 모든 `m.http` URL 을 `app.inject` 로 두드려 **Fastify 기본 404("Route ... not found")가 아님**을 단정(`isRouteNotRegistered` 재사용). 정적 목록보다 강하게 "목록에만 있고 등록은 안 된 경로"를 잡는다.
- **O1 `occupancyJudgeParity`**: `test/occupancyJudge.test.ts` T1~T9 시나리오 재사용 + 퇴화 + 동률 tie-break + `cfg` 오버라이드 → web↔src `toEqual`.
- **O2 `occupancyRoutes`**: 단일/다중 frames, `regions:true` 동등성, zod 400, 빈 frames 200.
- **S1 `artifactSlotEditParity`**: `test/slotInsertEdit.test.ts:16 sampleArtifact()` 재사용 + 결번(s2 삭제 후 추가) + `at=1`/`at=N+1`/`at=999` clamp + 중복 slotId no-op + preset 부재 신규 생성.
- **S2 `mappingSlotRoutes`**: add 200(파일 +1, `globalIdx` 가 요청 `at` 위치, coverage 통과) / add 2회 slotId 충돌 없음 / delete 200(−1) / **delete 부재 409 + 파일 md5 불변**(`rpcParity.test.ts:155` 방식) / artifact 없음 404 / `sqlite` 개수 불일치 시 warnings 포함.
- **S4 REST↔RPC md5 동일**(`place.save` 선례 :140-156): 같은 add 를 REST 로 한 뒤 파일 원복, RPC 로 반복 → `setup_artifact.json` 바이트 동일.

---

# 6. 위험·트레이드오프

| # | 위험 | 심각도 | 완화 |
|---|---|---|---|
| R1 | **토큰 활성화 = 웹 버튼 31개 즉사** | ★최상 | 서버 게이트(단계 2)와 웹 배선(단계 3)을 **연속 착수**. 단계 3 완료 전에는 `controlToken` 을 프로덕션에 넣지 않는다. `webTokenWiring` 테스트가 누락 사이트를 정적으로 잡는다 |
| R2 | 게이트 목록(`READONLY_POST_PATHS`)과 `methods.ts:mutating` 이 시간이 지나며 갈림 | 상 | §1.3-5 드리프트 테스트가 **양방향** 단정. 새 라우트 추가 시 반드시 실패한다 |
| R3 | `/capture/detect` 는 카메라를 실제로 움직이는데(app.js:1238) `plate.detect` 는 `mutating:false` → 면제 목록에 들어가 무인증 카메라 조작 가능 | 중 | 현행 카탈로그 결정을 임의로 뒤집지 않는다. **§7 Q1 마스터 판단 요청**. 뒤집으면 `rpcDispatch.test.ts` 의 "읽기 메서드 무게이트" 의미가 바뀐다 |
| R4 | MCP 호출자 회귀 | **없음** | `src/mcp/server.ts:34` 가 config 의 controlToken 을 이미 자동 주입. 단 **MCP 프로세스와 서버가 같은 config 를 읽어야** 한다(값이 다르면 전부 403) |
| R5 | **투어링 잡의 카메라 점유 경합** | 상 | ①`jobBusy` 에 TourJob 추가 → 렌즈 캘리브레이션이 투어링 중 시작 거부 ②RPC `requiresCamera:true` 로 다른 잡 진행 중 BUSY ③**REST 직접 호출은 dispatch 를 안 타므로 라우트에서도 `isBusy` 확인 409**(필수). 웹 라이브 스트림(`/viewer/api/stream`)은 별개 경로라 순회 중에도 화면은 보인다 |
| R6 | 순회 중 수동 PTZ 조작 충돌 | 중 | 순회 중 `#ptz-*` 컨트롤 disable(웹 `state.touringActive` 재사용). 서버는 막지 않는다(마지막 명령이 이긴다 — 기존 카메라 규약) |
| R7 | **점유판정 서버화로 왕복 지연** | 상 | 호출점을 리드로(초당 수십)에서 데이터 변경점(검출당 1회)으로 줄인다(§3.3). 배치 `frames[]` 로 프리셋 수만큼의 요청을 1회로 접는다. 그래도 느리면 `regions` 만 클라 계산(`web/occupancyRegion.js` 잔존)으로 되돌릴 여지를 남긴다 |
| R8 | 점유판정 shape 오차로 오버레이가 조용히 달라짐 | 상 | 서버 응답을 `state.occComputeByKey` 의 **현행 shape 그대로** 적재해 소비처를 무변경으로 둔다. 파리티 테스트가 값 동일을 봉인 |
| R9 | `src/domain → src/capture` import 신설(상수 재사용) | 하 | 순환 없음 확인(onPlaceFilter 는 domain 만 참조). 값 복제보다 안전 — 복제하면 파리티가 못 잡는 3번째 정의가 생긴다 |
| R10 | **슬롯편집이 renumber/placement 로 소실** | 상 | 코드로 막지 않고 **`warnings[]` + 카탈로그 `note`** 로 알린다(§4.1 Q2). 막으면 renumber 가 못 돈다 |
| R11 | 슬롯편집 실패 시 파일 부분기록 | 중 | 검증(3) → 저장(4) 순서. 검증 실패 시 `saveArtifact` 미도달 = **파일 무변경**. S2 가 md5 로 증명 |
| R12 | `DELETE+INSERT` wipe 재발 | **없음(구조적)** | 이번 4건은 DB 쓰기 API 를 **하나도** 호출하지 않는다. `sqlite` 는 `getSlotSetup()` 읽기만 |
| R13 | `known` 목록에 tour 3줄 추가 = 파리티 테스트 편집 | 하 | 편집과 **동시에** T4 동적 등록검사를 추가해 정적 목록보다 강한 보증으로 교체 |
| R14 | 사전 실패 2건(`roiDbLoad`·`placeRoiRuntimeInvariants`) | — | **손대지 않는다.** 런타임 `PtzCamRoi.json` 의 `points:[]` 주차면 vs "모든 주차면 4점" 단정 모순 — 마스터 판단 대기 항목(memo 기록). 이번 작업과 무관하며 상태 변화 없음 |
| ~~R15~~ | ~~W1 의 `mutFetch` 전환이 PTZ 동기화 봉인을 무력화~~ **→ 해소(W2 가 닫음, 설계자 독립 검증 완료)** | ~~★최상~~ | 원인: `test/viewerPtzSyncCoverage.test.ts` 수집 정규식이 소문자 `fetch\(` 라 `mutFetch(` 를 **하나도 못 잡았다**(수집 **57 → 29**, 놓친 28개가 **카메라 이동 라우트 9개 중 8개** — GET 인 `/capture/pipeline` 만 생존). 첫 it 이 "수집된 것 중 미분류"를 보므로 덜 수집할수록 통과가 쉬워져 **green 인 채 봉인만 사라진** 상태였다. **조치 완료**: 정규식 `[Ff]etch\(` + 사유 주석 4줄 + tour 분류 3줄(diff 9+/1−). **검증(설계자 재현)**: 미분류 0건 · `viewerPtzSyncCoverage` 13 passed · 전체 `vitest` **2 failed(사전실패 그대로) / 3349 passed** = 회귀 0. 탐지력도 실증됨(§9.2) |
| **R16** | 정적 `known` 목록만으로는 "가산 등록(deps 주입 시에만 등록)" 라우트의 미등록을 못 잡는다 | 중 | **R13 의 T4 동적 등록검사가 실증했다** — W2 구현 중 `capture.startPrecise`·`capture.pipeline` 두 메서드가 완전 배선 앱에서 Fastify 기본 404 로 드러났다(`deps.pipeline` 미주입 ctx). 테스트 ctx 에 `SetupPipeline` 주입으로 해소. T4 를 W3/W4 에서도 유지할 것 |

---

# 7. 결정이 필요한 열린 질문 (리더 판단 요청)

**Q1 — `plate.detect`(POST /capture/detect)를 토큰 게이트 면제로 둘 것인가?**
카탈로그는 `mutating:false`(읽기)로 선언했지만 이 라우트는 **카메라를 실제로 움직인다**(detectPipeline 이 확대 PTZ 로 `requestImage` 하고 원위치 복귀 안 함 — app.js:1238 주석). 면제하면 무인증으로 카메라를 돌릴 수 있고, 게이트하면 `mutating` 을 `true` 로 바꿔야 해 `test/rpcDispatch.test.ts` 의 "읽기 메서드 무게이트" 의미와 기존 웹 흐름이 영향을 받는다.
→ **(a) 현행 유지(면제)** / (b) `plate.detect`·`detect.vehicles` 를 `mutating:true` 로 승격 후 게이트. **추천 (a)** — 이번 범위를 넘는 계약 변경이므로 별건으로 다룬다.

**Q2 — `GROUND_BAND_RATIO`/`ON_PLACE_MIN_OVERLAP`/`groundBand` 의 위치.**
(a) `src/domain/occupancyJudge.ts` 가 `src/capture/onPlaceFilter.ts` 에서 import(레이어 역방향이지만 기존 파일 무변경) / (b) domain 으로 옮기고 `onPlaceFilter` 에서 재export(레이어 정합, 기존 파일 2개 수정).
→ **추천 (a)** — 외과적 변경 원칙. 레이어 정합을 우선한다면 (b).

**Q3 — 슬롯편집 UX: 즉시 반영 vs 저장 버튼 유지.**
서버 정본화하면 "추가 즉시 파일 반영"이 자연스럽다. 그러나 현행은 "추가 → Ctrl+드래그 배치 → 저장"(app.js:1453 주석) 2단계이고, 추가 직후 rect 는 화면 중앙 임시값이다. 즉시 반영하면 **배치 전 상태가 파일에 남는다**.
→ (a) 즉시 반영(설계안 — 서버가 정본 소유, `warnings` 안내) / (b) 라우트에 `dryRun` 을 두고 웹은 저장 버튼에서 최종 커밋. **추천 (a)** — (b)는 서버가 "계산만 하는" 반쪽 승격이라 껍데기화 취지에 어긋난다. 다만 **UX 변화**이므로 마스터 확인 필요.

**Q4 — `setup.slot.add` 의 의미가 요구와 맞는가?**
조사 결과 이 기능은 **artifact 편집**이지 "주차면 추가"가 아니다(§4.1 Q3). 실제 주차면 추가는 이미 `place.space.add` + `slot.roi.sync` 로 승격돼 있다.
→ (a) 설계안대로 artifact 편집 승격 / (b) `setup.slot.add` 를 **복합 메서드**로 정의(place.space.add → slot.roi.sync → artifact 재빌드). **추천 (a)** — (b)는 RPC 가 오케스트레이션 로직을 갖게 되어 "RPC 는 로직을 갖지 않는다" 원칙과 충돌한다. 필요하면 오케스트레이션을 **REST 라우트**에 두고 RPC 는 그걸 위임해야 한다(범위 확대).

---

# 8. 영향 받는 파일 요약 (구현자·문서화 인계)

**신규(7 + 테스트 10 + fixture 1)**
`src/api/controlGate.ts` · `src/setup/touringPlan.ts` · `src/capture/TourJob.ts` · `src/api/tourRoutes.ts` · `src/domain/occupancyJudge.ts` · `src/setup/artifactSlotEdit.ts` · `web/token.js`
테스트: `controlGate` · `webTokenWiring` · `touringPlanParity` · `tourJob` · `tourRoutes` · `occupancyJudgeParity` · `occupancyRoutes` · `artifactSlotEditParity` · `mappingSlotRoutes` (+`rpcParity` 내 신규 it)
fixture: `test/fixtures/setupResult.23slots.json`

**수정(8)**
`src/api/server.ts`(게이트 1줄 + tourRoutes 등록 + `/mapping/slot` 2라우트 + `ApiDeps.tourJob`) · `src/index.ts`(TourJob 조립 + jobBusy 1줄 + buildServer 1인자) · `src/api/captureRoutes.ts`(judge-occupancy 1라우트) · `src/rpc/methods.ts`(+6 메서드) · `web/app.js`(토큰 32곳·투어링·점유·슬롯편집) · `web/roimaker.js`(토큰 3곳) · `web/core.js`(`buildFlatSlotRows` 시그니처) · `test/rpcParity.test.ts`(known +3, it +1)
+ 소비 테스트 4종 호출부(`boundaryCrossCheck`·`finalizerParkingSlots`·`occupancyAnchor.regression`·`placeGlobalIdx`) · `test/buildTouringPlan.test.ts`(import 경로)

**의도적 무변경(중요)**
`src/viewer/routes.ts`(인라인 게이트 4곳 존치) · `src/capture/roiSlotSync.ts` · `src/capture/roiDbLoad.ts` · `src/capture/SqliteStore.ts`(**DB 쓰기 0**) · `src/domain/occupancyRegion.ts` · `web/occupancy.js` · `web/core.js` 의 `computeOccupancy`/`buildTouringPlan`/`nextSlotId`/`insertSlotAt`/`removeSlot`/`rebuildGlobalIndex`(전부 파리티 기준변) · `test/roiDbLoad.test.ts` · `test/placeRoiRuntimeInvariants.test.ts`(사전 실패 2건 — 지시대로 무접촉) · `src/mcp/server.ts`(카탈로그 프록시라 수정 0)

---

# 9. 구현 피드백 반영 이력

## 9.1 W2(투어링) — `dev-w2-tour`, 2026-07-28

| 보고 | 판정 | 반영 |
|---|---|---|
| 서버 승격 시 웹 `state.ptz` 부패 — `runTouringTest` finally 에서 `syncPtzAfterJob(null)` + `SYNC_OWNER` 등록 | **정당·설계 누락 인정.** app.js:1934 · 테스트 표 등록 확인함. 초판 §2.3 이 "제거할 로직"만 보고 "함께 옮겨야 할 책임"을 못 봤다 | **§0-9 공통 규약으로 승격** — W3/W4 의 표 등록 대상까지 미리 지정 |
| T4 동적 등록검사가 `capture.startPrecise`·`capture.pipeline` 미등록 2건을 잡음 | **R13 판단 실증.** 가산 등록 라우트는 정적 목록이 원리적으로 못 잡는다 | **R16 신설** — T4 를 W3/W4 에서도 유지 |
| `TourJobDeps.onFinished` 미구현(호출자 0 = 태생 데드코드) | **승인.** TourJob 은 `SetupPipeline` 자동연쇄에 참여하지 않으므로 `PlateDiscoveryJob:51` 의 콜백 패턴을 그대로 베낄 이유가 없다. CLAUDE.md 규칙 2(추측성 코드 금지)에 부합 | 설계에서 해당 필드 삭제 취급 |
| `viewerPtzSyncCoverage.test.ts:102` 정규식이 `mutFetch(` 를 놓침 — "별건으로 남김" | **부분 동의 → 별건 반대.** 발견은 정확하나 심각도가 과소평가됐고, 우려는 실측으로 반증됐다(아래) | **R15 신설(★최상) + 단계 6↔7 게이트로 승격** |

### W2 의 마지막 항목에 대한 재판정(실측 근거)
- 놓치는 범위가 "일부"가 아니다: 수집 **57 → 29**, 누락 28개가 **카메라 이동 라우트 전부**(`/capture/start`·`/capture/detect`·`/calibrate/ptz`·`/calibrate/point`·`/discover/ptz`·`/calibrate/lens/start`·`/capture/tour/start`·`/move`). 즉 **봉인이 지키려던 대상이 100% 빠졌다.**
- 테스트는 green 이다 — 첫 it 이 "수집된 것 중 미분류"를 보므로 **덜 수집할수록 통과가 쉬워진다**. 정확히 이 저장소가 반복해 겪은 "조용한 유실" 유형이며, W2 가 방금 고친 부패를 **다음 번에는 아무도 못 잡는 상태**다.
- "다수 라우트가 한꺼번에 미분류로 뜰 수 있다"는 우려는 **재현 결과 사실이 아니다** — 표 키 61개가 수정 후 수집 57개를 전부 덮어 **미분류 0건**. 한 글자 수정에 부작용이 없다.
- 원인 제공은 W2 가 아니라 **W1(토큰 배선)이며 설계상 내 책임**이다(§1.2 `mutFetch` 도입). W2 에 떠넘기지 않고 설계서에 게이트로 못 박았다.

## 9.2 게이트 해소 — W2 가 자기 자리에서 닫음(설계자 독립 검증 완료)

W2 가 재판정을 수용하고 리더 배정을 기다리지 않은 채 **단계 6 자리에서 게이트를 닫았다**. 판단이 옳다 — 게이트가 6↔7 이고 자기가 6 을 막 끝낸 자리였으므로, 대기는 순수 손실이었다.

| 항목 | W2 보고 | **설계자 독립 재현** | 판정 |
|---|---|---|---|
| 수집 수 | 29 → 57 | `node -e` 재현 **일치** | ✅ |
| 미분류 | 0건 | 표 키 61 vs 수집 57 → **0건** | ✅ |
| diff 범위 | 정규식 1 + 주석 4 + tour 분류 3 | `git diff` **9 insertions / 1 deletion** — 정확히 그것뿐 | ✅ |
| 봉인 테스트 | 13 passed | `npx vitest run test/viewerPtzSyncCoverage` → **13 passed** | ✅ |
| 전체 회귀 | 2 failed / 3349 passed | `npx vitest run` → **2 failed(placeRoiRuntimeInvariants·roiDbLoad) / 268 파일 · 3349 passed** | ✅ 회귀 0 |

**★ 탐지력 실증(W2 가 추가한 검증 — 설계서에 없던 좋은 절차)**: 수정 후 `mutFetch` 전용 경로인 `/capture/slots/reset` 분류를 일부러 1줄 지우자 `미분류 라우트 발견 — /capture/slots/reset` 으로 **실패**했다(수정 전이면 통과했을 케이스). "green 이 곧 봉인 작동"이 아님을 아는 방식으로, **음성 대조(negative control)** 를 세운 것이다. 앞으로 정적 커버리지 봉인을 만들 때는 이 절차를 기본으로 삼는다 — 봉인을 추가할 때 **"이 봉인이 실제로 실패하는 입력"을 한 번 보여주고 원복**한다.

**사전 실패 건수 정정**: 3건 → **2건**(§ 먼저보고 C 의 `buildTouringPlan` ENOENT 는 단계 1 fixture 이관으로 해소). 남은 2건은 지시대로 무접촉.

---

**타 에이전트 영향**
`GET /rpc/catalog` 메서드 수 **70 → 76**. MCP `setting_rpc_catalog` 는 카탈로그를 그대로 노출하므로 **MCP 파일 수정 0**(설계 의도대로). ActionAgent/DMAgent 가 읽는 `data/setup_artifact.json`·`save/setup_result.json` 의 **스키마는 불변** — 다만 슬롯편집이 내용(슬롯 수)을 바꿀 수 있으므로 문서화 단계에서 명시할 것.
