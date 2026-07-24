# 01 설계 계획 — 라이브 3fps 스냅샷 폴링 고착 제거(폴백 삭제 + 스트림 자동 재시도)

작성: 2026-07-24 / 설계자(architect) / 근거: `_workspace/00_leader_context.md`(리더 확정 범위 그대로 따름)

## 0. 한 줄 요약

`fallbackToPolling()`(MJPEG→3fps 스냅샷 폴링 편도 폴백)을 **삭제**하고, `liveMode`를 `'off' | 'stream'` 2상태로 축소한 뒤
**스트림 지수 백오프 자동 재시도**(순수 함수 `nextStreamRetryDelay` / `streamRetryLabel` + app.js 얇은 DOM 결선)로 대체한다.
라이브 off 상태의 **1회 스냅샷 tick 은 존치**(move/gotoPreset 화면 갱신). 서버(`src/`) 무변경.

---

## 1. 삭제 목록 (파일·심볼 단위) / 존치 목록

### 1.1 삭제

| 파일 | 심볼·위치 | 조치 | 사유 |
|------|-----------|------|------|
| `web/app.js` | `fallbackToPolling()` (1560~1566) | **함수 전체 삭제** | 3fps 폴링을 켜는 유일 경로(근본 원인) |
| `web/app.js` | `liveMode` 의 `'poll'` 상태 (1528 선언 주석 포함) | 도메인 축소 `'off' \| 'stream'` | 고착 상태 자체 제거 |
| `web/app.js` | `reconnectLiveIfActive()` 의 `if (liveMode === 'poll') loop.stop();` (1574) | 삭제 | poll 상태 소멸로 고아 |
| `web/app.js` | `frame.onerror = () => fallbackToPolling();` (1547, 1576) | `onStreamError` 결선으로 교체 | 폴백 → 재시도 |
| `web/app.js` | `$('fps')` 참조 (1565) | 삭제(입력 자체 제거) | 유일 소비처 소멸 |
| `web/app.js` | 4057 주석 `// poll 상태에서 이동 시 스트림 복귀.` | 문구 갱신(동작은 유지) | 사라진 상태 언급 금지 |
| `web/core.js` | `fpsToInterval()` (37~40) | **삭제** | 유일 소비처 `createStreamLoop.start` 소멸 |
| `web/core.js` | `createStreamLoop` 의 `start(fps)`, 지역 `timer`, `deps.setTimer`, `deps.clearTimer` (1197~1198, 1202, 1225~1234) | **삭제** | 타이머 = 폴링 그 자체 |
| `web/core.d.ts` | `fpsToInterval` 선언 (111) | 삭제 | 상동 |
| `web/core.d.ts` | `StreamLoopDeps.setTimer/clearTimer`, `StreamLoop.start` (399~400, 404) | 삭제 | 상동 |
| `web/index.html` | `<label class="field compact">fps <input id="fps" …></label>` (75) | **삭제** | 폴링 fps 조절 UI — 폴링 소멸로 무의미 |
| `test/viewerCore.test.ts` | `fpsToInterval` import(8) + `describe('fpsToInterval')`(71~78) | 삭제 | 대상 함수 삭제 |
| `test/viewerCore.test.ts` | `it('start: 주입 setTimer 로 …')`(525~534), `it('fake timers: start 후 간격마다 tick 발화 …')`(550~573) | 삭제 | 타이머 API 소멸 |
| `test/viewerCore.test.ts` | `it('(poll) → tick …')`(191~193) + 183~185 describe 주석의 poll 서술 | 삭제/갱신 | `'poll'` 도메인 소멸 |

### 1.2 존치(건드리지 않음) — 명시적 비범위

- **`loop.tick()` 1회 스냅샷 경로 전체**: `createStreamLoop` 의 `tick`(백프레셔 `inflight` 가드 · Blob URL revoke · `onPtz` 옵션)과 `stop`(inflight abort).
  `move()`(1611) 의 `'tick'` 분기, `gotoPreset()` 의 preset 모드 스냅샷 폴백은 **무변경 동작**.
- **`/viewer/api/snapshot` 라우트 · `SnapshotQuery` · `CaptureJob` · `CameraSourceClient.pollSnapshots`**: 서버측 무변경.
- **정밀수집/센터라이징/탐색 500ms 프레임 폴**(`capFrameTimer`/`calFrameTimer`/`discFrameTimer`): 잡 진행 표시용 별도 경로 — 무변경.
- **`web/app.css` 의 `.field.compact input`**: `abs-pan/abs-tilt/abs-zoom` 등 다른 입력이 사용 → 삭제 금지.
- **`moveRenderDirective` 함수 자체**: `move()` 가 계속 사용 → 유지(계약만 축소, §4).
- **`docs/20260709_141227_*.md`**: 과거 시점 기록물 → 수정하지 않는다(신규 문서에서 폐지 사실을 기술 — documenter 판단).

---

## 2. 대체 설계 — 스트림 지수 백오프 자동 재시도

### 2.1 순수 함수(`web/core.js`, vitest 직접 검증 대상)

`createStreamLoop` 정의부 근처(파일 하단 스트림 섹션)에 추가한다. **DOM/타이머 미참조**.

```js
// 스트림 재연결 백오프 상수(초기 1s → ×2 → 상한 30s). app.js 가 지연을 들고 setTimeout 만 담당.
const STREAM_RETRY_BASE_MS = 1000;
const STREAM_RETRY_FACTOR = 2;
const STREAM_RETRY_MAX_MS = 30000;

/**
 * 다음 재시도 지연(ms). prevMs 미지정/0/비수치(=첫 실패) → 초기값, 그 외 ×2(상한 클램프).
 * 수열: 1000 → 2000 → 4000 → 8000 → 16000 → 30000 → 30000 …
 */
export function nextStreamRetryDelay(prevMs) {
  const prev = Number(prevMs);
  if (!Number.isFinite(prev) || prev <= 0) return STREAM_RETRY_BASE_MS;
  return Math.min(STREAM_RETRY_MAX_MS, prev * STREAM_RETRY_FACTOR);
}

/**
 * 재시도 상태 표시 문구(순수). delayMs 가 상한(30s)에 도달하면 "연속 실패" 안내를 덧붙인다.
 * attempt = 연속 실패 횟수(1-based).
 */
export function streamRetryLabel(attempt, delayMs) {
  const sec = Math.round(delayMs / 1000);
  const base = `스트림 끊김 — ${sec}초 후 재연결 (${attempt}회째)`;
  return delayMs >= STREAM_RETRY_MAX_MS
    ? `${base} · 연결 실패가 계속됩니다 — 서버/카메라 상태를 확인하세요`
    : base;
}
```

- 상수는 **모듈 내부 고정**(설정 UI 추가 금지 — CLAUDE.md §2). 상한 도달 판정은 `streamRetryLabel` 내부에서만 필요하므로 export 하지 않는다.

### 2.2 DOM 결선(`web/app.js`, 얇게)

`// --- 라이브 MJPEG 스트림 ---` 섹션(1525~1579)을 아래 형태로 교체한다.

```js
let liveMode = 'off';        // 'off' | 'stream'(MJPEG). 폴링 폴백은 폐지(3fps 고착 원인).
let streamRetryTimer = null; // 재연결 대기 setTimeout 핸들(대기 중일 때만 non-null)
let streamRetryDelay = 0;    // 직전 재시도 지연(ms). 0 = 실패 이력 없음
let streamRetryAttempt = 0;  // 연속 실패 횟수

function streamUrl() { /* 무변경 */ }

/** 대기 중 재연결 타이머·백오프 상태·표시 문구를 모두 초기화(누수·유령 재연결 방지 단일 지점). */
function cancelStreamRetry() {
  if (streamRetryTimer) { clearTimeout(streamRetryTimer); streamRetryTimer = null; }
  streamRetryDelay = 0;
  streamRetryAttempt = 0;
  const el = $('live-status');
  if (el) el.textContent = '';
}

/** 프레임 도착(MJPEG 는 프레임마다 onload) → 백오프 리셋 + 상태 표시 해제. */
function onStreamLoad() {
  if (liveMode !== 'stream') return;
  if (!streamRetryAttempt && !streamRetryTimer) return; // 정상 지속 프레임 — 무동작.
  cancelStreamRetry();
}

/** 스트림 실패(501/502/503/네트워크 절단) → 지수 백오프 재시도 예약. */
function onStreamError() {
  if (liveMode !== 'stream') return;   // off/잡 진행 중 잔여 이벤트 무시.
  if (streamRetryTimer) return;        // 이미 대기 중 → 중복 예약 금지.
  streamRetryDelay = nextStreamRetryDelay(streamRetryDelay);
  streamRetryAttempt += 1;
  const el = $('live-status');
  if (el) el.textContent = streamRetryLabel(streamRetryAttempt, streamRetryDelay);
  streamRetryTimer = setTimeout(() => {
    streamRetryTimer = null;
    if (liveMode !== 'stream') return; // 대기 중 정지/잡 진입 → 유령 재연결 차단(2중 가드).
    // 동일 URL 재대입은 브라우저가 재요청을 생략할 수 있어 재시도에만 캐시버스터를 붙인다.
    frame.src = `${streamUrl()}&_r=${Date.now()}`;
  }, streamRetryDelay);
}

/** 스트림 (재)연결 공통부 — startLive/reconnectLiveIfActive 가 공유. */
function connectStream() {
  cancelStreamRetry();          // 대기 타이머·백오프 초기화(경로 불문).
  snapshot.abort();             // 진행 중 1회 스냅샷 중단(blob 이 스트림을 덮지 않게).
  liveMode = 'stream';
  frame.onerror = onStreamError;
  frame.onload = onStreamLoad;
  frame.src = streamUrl();
  drawRoiOverlay();             // 스트림은 per-frame 재그리기 없음 → 연결 시 1회.
}

function startLive() { connectStream(); }

function stopLive() {
  liveMode = 'off';
  frame.onerror = null;
  frame.onload = null;          // 핸들러 해제 후 src 제거(순서 유지).
  cancelStreamRetry();
  frame.removeAttribute('src'); // 연결 종료 → reply.raw close → 상류 abort.
  snapshot.abort();
}

function reconnectLiveIfActive() {
  if (liveMode === 'off') return; // 라이브 꺼짐 → 무동작(기존 계약 유지).
  connectStream();
}
```

- `streamUrl()` 본체는 **무변경** — `move()`/`reconnectLiveIfActive()` 가 같은 URL 을 내는 성질(재로드 없이 무해한 race, docs 20260709 §race)을 보존한다. 캐시버스터 `_r` 은 **재시도 경로에만** 붙인다.
- 서버 `StreamQuery` 는 비-strict `z.object` 라 미지의 키 `_r` 을 **stript** 한다 → **서버 무변경으로 안전**(routes.ts:40~48 확인).

### 2.3 타이머 취소 경로 점검(누수·유령 재연결)

| 경로 | 진입 함수 | 취소 보장 |
|------|-----------|-----------|
| 라이브 시작 버튼 `btn-start` | `startLive → connectStream` | `cancelStreamRetry()` |
| 라이브 정지 버튼 `btn-stop` | `stopLive` | `cancelStreamRetry()` + `liveMode='off'` |
| cam/preset/source 변경, `btn-goto`, 슬롯·주차면 행 클릭 | `reconnectLiveIfActive → connectStream` | `cancelStreamRetry()` |
| 정밀수집 시작 | `startCapFramePolling`(2176) → `stopLive()` | 상속(무변경) |
| 센터라이징 시작 | `startCalFramePolling`(2729) → `stopLive()` | 상속(무변경) |
| 번호판 탐색 시작 | `startDiscFramePolling`(2901) → `stopLive()` | 상속(무변경) |
| 잡 종료 후 라이브 복귀(2334/2806/2842/2967) | `startLive()` | `cancelStreamRetry()` 후 재연결 |
| 타이머 발화 시점 | `setTimeout` 콜백 | `liveMode !== 'stream'` 조기 반환(2중 가드) |

→ **타이머 소유자는 `cancelStreamRetry()` 단 하나**. 잡 진입 3곳은 이미 `stopLive()` 를 부르므로 추가 변경 0.

### 2.4 UI 표시(재시도 상태)

- 위치: `web/index.html` `.stream-controls`(72~76) — **삭제되는 fps 입력 자리를 그대로 사용**.
  ```html
  <div class="stream-controls toolbar">
    <button id="btn-start" class="primary">시작</button>
    <button id="btn-stop">정지</button>
    <span id="live-status" aria-live="polite"></span>
  </div>
  ```
- `web/app.css`: `#ptz-control-status`(702~708) 패턴을 따른 최소 규칙 3줄 추가.
  ```css
  #live-status { color: var(--muted); font-size: 12px; line-height: 1.35; }
  ```
- 문구는 전부 `streamRetryLabel()`(순수) 산출 → app.js 는 `textContent` 대입만 한다.

---

## 3. `createStreamLoop` 잔여 형태

타이머 제거 후 남는 것은 **1회성 fetch + abort** 뿐이므로 이름이 사실과 어긋난다(“loop” 아님). 자기 변경으로 생긴 오해를 정리한다(CLAUDE.md §3).

- `web/core.js`: `createStreamLoop(deps)` → **`createSnapshotFetcher(deps)`**, 반환 `{ tick, abort }`.
  - `tick()`: 현행 본문 그대로(백프레셔·revoke·onPtz·try/catch 무시) — **동작 무변경**.
  - `abort()`: 현행 `stop()` 에서 타이머 정리부를 뺀 나머지(`inflight.abort()`).
  - `deps`: `fetchFn / makeUrl / createObjectURL / revokeObjectURL / setImage / onPtz?` (setTimer/clearTimer 제거).
  - JSDoc 첫 줄을 "스냅샷 1회 취득기(백프레셔·Blob revoke·abort)"로 갱신.
- `web/app.js` 호출부(총 4곳): `const loop = createStreamLoop({…})`(1482) → `const snapshot = createSnapshotFetcher({…})`,
  `loop.stop()`(1546·1557) → `snapshot.abort()`, `await loop.tick()`(1611) → `await snapshot.tick()`.
- `web/core.d.ts` 동기화(389~409): `StreamLoopDeps` → `SnapshotFetcherDeps`(setTimer/clearTimer 제거),
  `StreamLoop` → `SnapshotFetcher { tick(): Promise<void>; abort(): void }`, `export function createSnapshotFetcher(deps: SnapshotFetcherDeps): SnapshotFetcher;`
  추가 선언: `export function nextStreamRetryDelay(prevMs?: number | null): number;`,
  `export function streamRetryLabel(attempt: number, delayMs: number): string;`
- 검증: `npm run typecheck`(tsc --noEmit)로 d.ts↔테스트 정합 확인 — vitest 는 타입을 보지 않으므로 **둘 다 필수**.

> 대안(채택 안 함): 이름 유지 + 주석만 수정. 호출부 churn 은 4줄로 동일 수준인데 이름이 계속 거짓말을 하므로 기각.

---

## 4. `moveRenderDirective` 계약

- 계약: `moveRenderDirective(liveMode: 'off' | 'stream') → 'stream-reconnect' | 'tick'`
  - `'stream'` → `'stream-reconnect'`(새 PTZ 가 실린 `frame.src = streamUrl()` 재연결)
  - `'off'` → `'tick'`(1회 스냅샷 override — **존치**)
- **본문 코드 무변경**(`liveMode === 'stream' ? … : …`). JSDoc(1244~1249)에서 `'poll'`/폴백 서술만 제거.
- `web/core.d.ts:411~413`: 인자 union 을 `'off' | 'stream'` 으로 축소.
- 테스트: `'poll' → tick` 케이스 삭제, `'stream'`/`'off'` 2 케이스 유지. describe 제목·주석에서 폴백 서술 제거.
- `move()`(1607~1612) 의 else 분기 주석을 `// 라이브 off — 1회 스냅샷 override.` 로 갱신(‘poll 폴백 지속갱신’ 문구 제거).

---

## 5. 검증 계획 (qa-tester 가 쓸 vitest 케이스)

실행: `npm run test`(= `vitest run`) + `npm run typecheck`. 대상 파일: `test/viewerCore.test.ts`(기존) + 소스텍스트 회귀는 동 파일 말미 또는 신규 `test/liveStreamRetry.test.ts`(기존 `dbCenteringOverlay.test.ts` / `cameraKindSelect.test.ts` 의 `readFileSync` 패턴 재사용).

**A. `nextStreamRetryDelay`(백오프 수열·리셋)**
1. `nextStreamRetryDelay(0) === 1000`, `undefined`/`null`/`NaN`/음수 → `1000`(첫 실패 초기값).
2. `1000→2000`, `2000→4000`, `4000→8000`, `8000→16000`.
3. `16000→30000`(상한 클램프, 32000 아님), `30000→30000`(멱등 — 상한 유지).
4. 수열 누적 검증: 8회 반복 시 `[1000,2000,4000,8000,16000,30000,30000,30000]`.

**B. `streamRetryLabel`(상한 도달 UI 문구)**
5. `streamRetryLabel(1, 1000)` → `'1초'`·`'1회째'` 포함, 상한 안내 문구 **미포함**.
6. `streamRetryLabel(6, 30000)` → `'30초'`·`'6회째'` + `'서버/카메라 상태를 확인하세요'` 포함.

**C. `moveRenderDirective` 계약**
7. `moveRenderDirective('stream') === 'stream-reconnect'`.
8. `moveRenderDirective('off') === 'tick'`.
9. (회귀) `'poll'` 케이스가 테스트에 남아 있지 않을 것 — 삭제로 충족.

**D. `createSnapshotFetcher`(1회 스냅샷 tick 백프레셔 유지)**
10. 백프레셔: inflight 중 `tick()` 겹침은 스킵 → `fetchFn` 1회(기존 486~500 이관).
11. 새 프레임 시 이전 Blob URL revoke, 첫 프레임은 revoke 없음(기존 502~514 이관).
12. `onPtz` 가 응답 헤더로 1회 호출(기존 516~523 이관).
13. `abort()`: 진행 중 요청의 `signal.aborted === true`(기존 536~548 에서 `clearTimer` 단언 제거).
14. **타이머 부재 회귀**: `createSnapshotFetcher(deps)` 반환 객체에 `start` 가 없다 — `expect((f as any).start).toBeUndefined()`, 그리고 fake timers 로 1초 진행해도 `fetchFn` 추가 호출 0(자발적 폴링 없음).

**E. 소스텍스트 회귀(DOM 결선은 유닛테스트 불가 → 텍스트 단언으로 갈음)**
15. `web/app.js` 에 `fallbackToPolling` / `loop.start(` / `$('fps')` 문자열이 **없다**.
16. `web/app.js` 에 `liveMode = 'poll'` / `'poll'` 리터럴이 **없다**.
17. `web/core.js` 에 `fpsToInterval` / `setInterval` 문자열이 **없다**(core 는 타이머 미참조 모듈이어야 함).
18. `web/index.html` 에 `id="fps"` 가 **없고** `id="live-status"` 가 **있다**.
19. `stopLive` / `connectStream` 본문에 `cancelStreamRetry()` 호출이 있고, `cancelStreamRetry` 가 `clearTimeout` 을 호출한다(타이머 취소 보장).
20. 재시도 `setTimeout` 콜백에 `liveMode !== 'stream'` 조기 반환 가드가 있다(유령 재연결 방지).

**F. 라이브(리더 경험적 확인 — vitest 밖)**
21. Unity 정지 상태에서 `시작` → `#live-status` 가 1s→2s→4s… 로 증가하며 표시, `/viewer/api/snapshot` 요청은 **0건**(3fps 패킷 부활 없음).
22. Unity 기동 → 첫 프레임 도착 시 상태 문구 자동 소멸(백오프 리셋), 이후 스트림 유지.
23. 재시도 대기 중 `정지`/정밀수집 시작 → 대기 타이머가 끊겨 이후 `/viewer/api/stream` 재요청 0건.

---

## 6. 영향도 / 운영 주의점

- **정적 자산은 nodemon 감시 밖**: `nodemon.json` 은 `watch: ["src"], ext: "ts,json"` → `web/*.js|html|css` 변경은 서버 재기동으로 반영되지 않고, **브라우저 하드리로드(Ctrl+Shift+R)** 가 필요하다. 이미 `liveMode='poll'` 로 고착된 기존 탭은 **리로드 전까지 3fps 폴링을 계속**한다(수정 확인 전 반드시 하드리로드).
- **사용자 가시 UI 변경**: 뷰포트 하단 `fps` 입력 사라짐 → 라이브 프레임레이트는 서버 스트림이 결정(사용자 조절 불가). 같은 자리에 재시도 상태 표시가 생긴다.
- **스트림 미지원 소스(501 STREAM_UNSUPPORTED)**: 폴백이 없어 30초 간격 재시도 + 안내 문구로 종료(리더가 수용한 트레이드오프 — 현재 등록 소스 4종 전부 스트림 지원). `img.onerror` 는 HTTP 상태를 볼 수 없어 501 과 일시 장애를 구분하지 못한다.
- **서버(`src/`) 무변경**: `/viewer/api/snapshot` 라우트와 `CameraSourceClient.pollSnapshots`(서버측 스트림 미지원 폴백)는 그대로 — 정밀수집/센터라이징/탐색이 계속 사용한다. 재시도 캐시버스터 `_r` 은 `StreamQuery`(비-strict zod)가 무시하므로 스키마 변경 불필요.
- **트래픽**: 최악(스트림 영구 실패) 기준 30초당 1요청 — 기존 3.3~6.3 req/s 대비 **약 200배 감소**.
- **문서(documenter)**: 신규 `yyyyMMdd_hhmmss_*.md` 에 (1) 폴링 폴백 폐지·재시도 도입, (2) `createStreamLoop → createSnapshotFetcher` 개명, (3) fps UI 제거를 기록. `docs/20260709_141227_*.md` 는 과거 기록물이라 수정하지 않고, `docs/20260625_182819_SettingViewer_구현문서.md` 의 core.js 함수 목록(`fpsToInterval` 언급)만 각주 수준으로 정정 여부를 판단.

---

## 7. 가정 / 미해결 (developer·qa 확인 요망)

1. **`img.onload` 반복 발화 가정**: Chrome 의 `multipart/x-mixed-replace` 이미지는 프레임마다 `load` 를 발화한다고 보되, **최소 보장은 “첫 프레임 도착 시 1회”** 다. 설계는 1회만 발화해도 백오프 리셋이 성립하므로 두 경우 모두 안전하다.
2. **무음 정지(silent stall)**: 200 응답 후 상류가 조용히 멈추면 `onerror` 가 안 뜰 수 있어 자동 재시도가 걸리지 않는다(사용자가 `시작` 재클릭으로 회복). 워치독 타이머 도입은 **범위 밖**(폴링 재도입 성격 — 필요시 별건).
3. **개명 승인**: `createStreamLoop → createSnapshotFetcher` 는 설계자 판단(이름이 사실과 불일치). 리더가 최소 변경을 더 원하면 이름 유지 + JSDoc 정정으로 축소 가능(§3 대안).
4. **백오프 상수**(1s / ×2 / 30s cap)는 리더 컨텍스트의 “예: 30s cap” 를 따랐다. 값 조정이 필요하면 core.js 상수 3개만 바꾸면 된다(테스트 A 수열도 동반 수정).
