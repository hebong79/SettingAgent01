# 02 구현 변경 내역 — 3fps 스냅샷 폴링 폴백 제거 + 스트림 자동 재시도

작성: 2026-07-24 / 구현자(developer) / 근거: `_workspace/01_architect_plan.md`(승인된 계획 그대로) · `_workspace/00_leader_context.md`

## 0. 한 줄 요약

`fallbackToPolling()`(MJPEG→3fps 스냅샷 폴링 편도 폴백)을 삭제하고 `liveMode` 를 `'off' | 'stream'` 2상태로 축소했다.
대체로 **스트림 지수 백오프 자동 재시도**(순수 함수 `nextStreamRetryDelay`/`streamRetryLabel` + app.js 얇은 DOM 결선)를 도입하고,
타이머가 사라진 `createStreamLoop` 을 `createSnapshotFetcher` 로 개명했다. 서버 `src/` 무변경.

---

## 1. 파일별 변경

### 1.1 `web/core.js`

| 구분 | 심볼 | 내용 |
|------|------|------|
| 삭제 | `fpsToInterval(fps)` (구 37~40) | 유일 소비처(`createStreamLoop.start`) 소멸 |
| 삭제 | `createStreamLoop` 의 `start(fps)` · 지역 `timer` · `deps.setTimer` · `deps.clearTimer` | 타이머 = 폴링 그 자체 |
| 개명 | `createStreamLoop(deps)` → `createSnapshotFetcher(deps)` | 반환 `{ tick, abort }`. 구 `stop()` 에서 타이머 정리부를 뺀 것이 `abort()` |
| 신규 | 모듈 상수 `STREAM_RETRY_BASE_MS=1000` / `STREAM_RETRY_FACTOR=2` / `STREAM_RETRY_MAX_MS=30000` | 비-export(설정 UI 미추가) |
| 신규 | `nextStreamRetryDelay(prevMs)` | 계약: 비수치·`null`·`0`·음수 → `1000`, 그 외 `min(30000, prev*2)`. 수열 `1000→2000→4000→8000→16000→30000→30000…` |
| 신규 | `streamRetryLabel(attempt, delayMs)` | `스트림 끊김 — {sec}초 후 재연결 ({attempt}회째)`, `delayMs >= 30000` 이면 ` · 연결 실패가 계속됩니다 — 서버/카메라 상태를 확인하세요` 접미 |
| 주석 | `moveRenderDirective` JSDoc | `liveMode ∈ {'off','stream'}` 로 축소, poll/폴백 서술 제거. **본문 코드 무변경** |

- `tick()` 본문(백프레셔 `inflight` 가드 · 이전 Blob URL revoke · `onPtz` · try/catch 무시)은 **한 줄도 바꾸지 않았다**.
- `core.js` 는 여전히 DOM/타이머 미참조 순수 모듈(`setInterval` 참조 0건).

### 1.2 `web/core.d.ts`

- 삭제: `fpsToInterval` 선언.
- `StreamLoopDeps` → `SnapshotFetcherDeps` (`setTimer?`/`clearTimer?` 제거).
- `StreamLoop { start, stop, tick }` → `SnapshotFetcher { tick(): Promise<void>; abort(): void }`.
- `createStreamLoop` → `createSnapshotFetcher` 선언.
- 신규 선언: `nextStreamRetryDelay(prevMs?: number | null): number;` · `streamRetryLabel(attempt: number, delayMs: number): string;`
- `moveRenderDirective` 인자 union: `'off' | 'stream' | 'poll'` → `'off' | 'stream'`.

### 1.3 `web/app.js`

| 구분 | 위치 | 내용 |
|------|------|------|
| import | 3~14 | `createStreamLoop` → `createSnapshotFetcher`, `nextStreamRetryDelay`/`streamRetryLabel` 추가. `moveRenderDirective` 주석에서 poll 제거 |
| 개명 | 구 1482 | `const loop = createStreamLoop({…})` → `const snapshot = createSnapshotFetcher({…})`, 섹션 제목 `// --- 1회 스냅샷 취득 ---`. 주입 deps 본문 무변경 |
| 삭제 | 구 1560~1566 | **`fallbackToPolling()` 전체** — 3fps 폴링을 켜던 유일 경로 |
| 삭제 | 구 1565 | `$('fps')` 참조(입력 자체도 index.html 에서 제거) |
| 삭제 | 구 1574 | `reconnectLiveIfActive()` 의 `if (liveMode === 'poll') loop.stop();` |
| 축소 | 구 1528 | `let liveMode = 'off'; // 'off' | 'stream'`. `'poll'` 리터럴 코드베이스 0건 |
| 신규 | 스트림 섹션 | 모듈 상태 `streamRetryTimer` / `streamRetryDelay` / `streamRetryAttempt` |
| 신규 | 〃 | `cancelStreamRetry()` · `onStreamLoad()` · `onStreamError()` · `connectStream()` |
| 교체 | 〃 | `startLive()` = `connectStream()`, `reconnectLiveIfActive()` = off 가드 + `connectStream()` |
| 갱신 | 〃 | `stopLive()`: `liveMode='off'` → `onerror/onload=null` → `cancelStreamRetry()` → `removeAttribute('src')` → `snapshot.abort()` |
| 갱신 | `move()` else 분기 | `await loop.tick()` → `await snapshot.tick(); // 라이브 off — 1회 스냅샷 override.` |
| 갱신 | `btn-goto` 리스너 주석 | `poll 상태에서 이동 시 스트림 복귀.` → `프리셋 이동 후 새 PTZ 로 스트림 재연결.` |

**신규 함수 계약**

- `cancelStreamRetry()` — 재연결 타이머 `clearTimeout` + `streamRetryTimer=null` + 백오프 상태 0 리셋 + `#live-status` 문구 비움. **타이머 소유 단일 지점.**
- `onStreamLoad()` — `liveMode!=='stream'` 이면 무동작. 재시도 이력이 없으면(정상 지속 프레임) 무동작, 있으면 `cancelStreamRetry()` 로 백오프 리셋.
- `onStreamError()` — `liveMode!=='stream'` 또는 이미 대기 중이면 무동작(중복 예약 금지). 아니면 `streamRetryDelay = nextStreamRetryDelay(streamRetryDelay)`, `attempt+1`, `#live-status` 에 `streamRetryLabel(...)` 표시, `setTimeout` 예약. 콜백은 `streamRetryTimer=null` → `liveMode!=='stream'` 조기반환(2중 가드) → `frame.src = ${streamUrl()}&_r=${Date.now()}`(캐시버스터는 **재시도 경로에만**).
- `connectStream()` — 실패상태 기록(`retrying`) → `cancelStreamRetry()` → `snapshot.abort()` → `liveMode='stream'` → `onerror/onload` 결선 → `frame.src`(실패 직후면 캐시버스터 부착, §3 보정) → `drawRoiOverlay()` 1회.

**재시도 타이머 취소 경로(전수 확인)**

| 경로 | 취소 |
|------|------|
| `btn-start` → `startLive → connectStream` | `cancelStreamRetry()` |
| `btn-stop` → `stopLive` | `cancelStreamRetry()` + `liveMode='off'` |
| cam/preset/source 변경 · `btn-goto` · 슬롯/주차면 행 클릭 → `reconnectLiveIfActive → connectStream` | `cancelStreamRetry()` |
| 정밀수집(`startCapFramePolling`) / 센터라이징(`startCalFramePolling`) / 탐색(`startDiscFramePolling`) | 각 함수가 이미 `stopLive()` 호출 → 상속(**해당 3곳 코드 변경 0**) |
| 타이머 발화 시점 | 콜백 선두 `liveMode !== 'stream'` 조기 반환 |

### 1.4 `web/index.html`

- 삭제: `<label class="field compact">fps <input id="fps" …></label>` (75).
- 신규: 같은 자리에 `<span id="live-status" aria-live="polite"></span>`.

### 1.5 `web/app.css`

- `.stream-controls` 규칙 바로 뒤에 `#live-status { color: var(--muted); font-size: 12px; line-height: 1.35; }` 3줄 추가(`#ptz-control-status` 패턴 차용).
- `.field.compact input` 등 기존 규칙 **무변경**(abs-pan/tilt/zoom 이 계속 사용).

### 1.6 `test/viewerCore.test.ts` (계획 §1.1 범위 — 삭제 API 참조 정리·개명 반영만)

- import: `fpsToInterval` 제거, `createStreamLoop` → `createSnapshotFetcher`.
- 삭제: `describe('fpsToInterval')` 2케이스.
- 삭제: `it('(poll) → tick …')`, `moveRenderDirective` describe 주석의 poll 서술 갱신.
- 삭제: `it('start: 주입 setTimer 로 …')`, `it('fake timers: start 후 간격마다 tick 발화 …')`.
- 개명/축소: describe 제목 `createStreamLoop — 백프레셔/revoke/stop` → `createSnapshotFetcher — 백프레셔/revoke/abort`,
  `it('stop: timer clear + inflight abort')` → `it('abort: inflight abort')`(`clearTimer` 단언 제거, signal.aborted 단언 유지).
- 신규 케이스(백오프 수열·라벨·타이머 부재 회귀·소스텍스트 회귀)는 **qa-tester 담당** — 여기서는 작성하지 않음.

---

## 2. 검증 결과

```
npx tsc -p tsconfig.json --noEmit      → 오류 0 (exit 0)
npx vitest run test/viewerCore.test.ts → 67 passed (1 file)
npx vitest run (전체)                  → 234 files / 2718 tests 전부 passed
grep -n "fallbackToPolling|fpsToInterval|loop.start(|'poll'|id=\"fps\"" web/ -r → 매치 0건
grep -rn "createStreamLoop|fpsToInterval|StreamLoop" test/ src/ web/ → 매치 0건
```

---

## 3. 보정 (qa 관찰 → 리더 승인, 2026-07-24 2차)

### 3.1 문제 (qa 관찰 사항)

`connectStream()` 이 캐시버스터 없이 `frame.src = streamUrl()` 을 대입하므로, **최초 연결 실패 후 첫 재시도(1초) 발화 전에
사용자가 `시작` 을 다시 누르면** 대입값이 현재 `src` 와 완전히 동일해져 브라우저가 재요청을 생략할 수 있다.
동시에 `cancelStreamRetry()` 가 기존 예약을 취소하므로 **재시도도 재발화도 없는 정지 상태**가 된다
(이번 작업이 없애려는 "고착" 과 같은 부류 → 남기지 않는다).

### 3.2 수정 (`web/app.js` `connectStream()`, 최소 변경 3줄)

```js
function connectStream() {
  // 직전 연결이 실패 상태였는지(대기 중이거나 실패 이력) 를 초기화 전에 기록한다.
  const retrying = !!streamRetryTimer || streamRetryAttempt > 0;
  cancelStreamRetry();
  …
  // 실패 직후 재연결은 동일 URL 재대입이 되어 브라우저가 재요청을 생략할 수 있다(예약도 취소된 정지 상태).
  // 그 경우에만 캐시버스터를 붙이고, 정상 경로의 URL 형태는 그대로 둔다.
  frame.src = retrying ? `${streamUrl()}&_r=${Date.now()}` : streamUrl();
}
```

- 판정값 `retrying` 은 **`cancelStreamRetry()` 가 상태를 0으로 밀기 전에** 캡처해야 하므로 함수 선두에서 읽는다.
- **정상 경로(성공 중 cam/preset 변경 등) URL 형태 무변경** → 불필요한 재요청 유발 없음, 기존 "동일 URL 재대입은 무해한 race"
  성질(docs 20260709 §race) 보존.
- 서버 영향 없음: `_r` 은 비-strict `StreamQuery`(zod)가 strip.

### 3.3 재검증

```
npx tsc -p tsconfig.json --noEmit → 오류 0 (exit 0)
npx vitest run (전체)             → 235 files / 2751 tests 전부 passed
```

---

## 4. 미해결 / 판단 사항 (qa·documenter 확인 요망)

1. **`gotoPreset()` JSDoc 의 `loop.tick()` 문구**(app.js 구 1624): "기존엔 loop.tick()만 호출해…" 는 **과거 코드에 대한 서술**이라
   개명 반영이 오히려 사실을 왜곡한다고 판단해 **그대로 두었다**. 계획 §1.1 삭제 목록에도 없음. 리더가 원하면 1단어 수정 가능.
2. **`img.onload` 반복 발화 가정**(계획 §7-1): Chrome `multipart/x-mixed-replace` 는 프레임마다 `load` 발화로 보되,
   1회만 발화해도 백오프 리셋은 성립하도록 구현했다(설계 그대로).
3. **무음 정지(silent stall)**: 200 이후 상류가 조용히 멈추면 `onerror` 미발화 → 자동 재시도 없음(사용자 `시작` 재클릭으로 회복).
   워치독은 범위 밖(폴링 재도입 성격).
4. **스트림 미지원 소스(501)**: `img.onerror` 가 HTTP 상태를 볼 수 없어 일시 장애와 구분 불가 → 30초 간격 재시도 + 안내 문구로 종료(리더 수용 트레이드오프).
5. **정적 자산은 nodemon 감시 밖**: `web/*.js|html|css` 변경은 서버 재기동으로 반영되지 않는다.
   이미 `liveMode='poll'` 로 고착된 기존 탭은 **하드리로드(Ctrl+Shift+R) 전까지 3fps 폴링을 계속**한다 — 라이브 확인 전 필수.
6. **사용자 가시 변경**: 뷰포트 하단 `fps` 입력 소멸(프레임레이트는 서버 스트림이 결정), 같은 자리에 재시도 상태 표시.
