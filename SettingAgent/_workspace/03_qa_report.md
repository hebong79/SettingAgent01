# 03 검증 리포트 — 3fps 폴링 폴백 제거 + 스트림 자동 재시도

작성: 2026-07-24 / 검증자(qa-tester) / 근거: `_workspace/01_architect_plan.md` §5(A1~E20) · `_workspace/02_developer_changes.md`

## 0. 결론

**전 항목 통과. 발견된 기능 결함 0건.** 계획 §5 의 A~E 케이스를 전부 구현했고, 여기에 더해
app.js 라이브 섹션을 **실제 배포 바이트 그대로 실행**하는 결선 동작 검증 9케이스를 추가했다.
관찰형 항목(F21~23 라이브 스모크)은 **미수행 — 한계로 명시**(§4).

| 실행 | 명령 | 결과 |
|------|------|------|
| 신규 테스트 | `npx vitest run test/liveStreamRetry.test.ts` | 최초 **33 passed** → 보정 검증 추가 후 **40 passed** |
| 관련 기존 | `npx vitest run test/viewerCore.test.ts` | **67 passed** |
| 전체 | `npx vitest run` | 최초 **2751 passed** → 보정 후 **235 files / 2758 tests 전부 passed** (16.5s) |
| 타입 | `npx tsc -p tsconfig.json --noEmit` | **exit 0 (오류 0)** — 최초·보정 후 모두 |

신규 파일: `SettingAgent/test/liveStreamRetry.test.ts` (40 케이스 — 보정 검증 §1-B 포함)
기존 파일 수정: 없음(`test/viewerCore.test.ts` 는 구현자 정리분 그대로 통과).

---

## 1. 케이스별 결과

### A. `nextStreamRetryDelay` — 백오프 수열 (계획 A1~A4)

| ID | 내용 | 결과 |
|----|------|------|
| A1 | `0`/`undefined`/`null`/`NaN`/`-5000`/`±Infinity`/`'abc'`/`{}` → `1000` | 통과 |
| A2 | `1000→2000`, `2000→4000`, `4000→8000`, `8000→16000` | 통과 |
| A3 | `16000→30000`(32000 아님), `30000` 5회 반복 멱등, `999999→30000` | 통과 |
| A4 | 8회 누적 = `[1000,2000,4000,8000,16000,30000,30000,30000]` | 통과 |
| A5(추가) | 수치형 문자열 `'1000'` → `2000` (Number 강제변환 계약) | 통과 |

`+Infinity` 입력이 초기값 `1000` 으로 떨어지는 것은 `Number.isFinite` 가드의 의도된 결과로 확인(무한 지연 방지).

### B. `streamRetryLabel` — 상한 문구 분기 (계획 B5~B6)

| ID | 내용 | 결과 |
|----|------|------|
| B5 | `(1,1000)` → `'1초'`·`'1회째'`·`'스트림 끊김'` 포함, 상한 안내 **미포함** | 통과 |
| B6 | `(6,30000)` → `'30초'`·`'6회째'` + `'서버/카메라 상태를 확인하세요'` 포함 | 통과 |
| B7(추가) | 경계: `16000` 안내 없음 / `30000`·`45000` 안내 있음 | 통과 |
| B8(추가) | 초 표기 반올림(`1500ms` → `'2초'`) | 통과 |

### C. `moveRenderDirective` — 계약 축소 (계획 C7~C9)

| ID | 내용 | 결과 |
|----|------|------|
| C7 | `'stream'` → `'stream-reconnect'` | 통과 |
| C8 | `'off'` → `'tick'` | 통과 |
| C9 | `core.d.ts` 선언의 인자 union 에 `'poll'` 없음 | 통과 |

### D. `createSnapshotFetcher` (계획 D10~D14)

| ID | 내용 | 결과 |
|----|------|------|
| D10 | 백프레셔 — inflight 중 겹친 `tick()` 스킵(fetch 1회), 해소 후 재개(2회) | 통과 |
| D11 | 새 프레임 시 이전 Blob URL revoke(`blob:0`), 첫 프레임은 revoke 0건 | 통과 |
| D12 | `onPtz` 가 응답 헤더 인자로 1회 호출 | 통과 |
| D13 | `abort()` → 진행 중 요청의 `signal.aborted === true` | 통과 |
| D14-a | 반환 키가 정확히 `['abort','tick']` — `start`/`stop` 부재(타이머 API 소멸 회귀) | 통과 |
| D14-b | **자발 폴링 부재** — fake timer 60초 진행 시 fetch 0건, `tick()` 1회 후 60초 더 진행해도 여전히 1건 | 통과 |

### E. 소스텍스트 회귀 (계획 E15~E20)

| ID | 내용 | 결과 |
|----|------|------|
| E15 | `web/`(app.js·core.js·core.d.ts·index.html)에 `fallbackToPolling`/`loop.start(`/`fpsToInterval`/`createStreamLoop` 문자열 0건 | 통과 |
| E16 | `'poll'` 리터럴 0건 | 통과 |
| E17 | `core.js` 에 `setInterval` 0건 · `setTimeout(` 호출 0건, 라이브 섹션에도 `setInterval` 0건 | 통과 |
| E18 | `index.html` 에 `id="fps"` 없음 / `id="live-status"` 있음 | 통과 |
| E19 | `cancelStreamRetry` 가 `clearTimeout(`+`streamRetryTimer = null`, `stopLive`·`connectStream` 이 `cancelStreamRetry()` 호출, `startLive`·`reconnectLiveIfActive` 는 `connectStream()` 경유 | 통과 |
| E20 | 재시도 `setTimeout` 콜백에 `liveMode !== 'stream'` 조기 반환, `onStreamError` 에 `if (streamRetryTimer) return;` 중복예약 가드 + `nextStreamRetryDelay(`·`streamRetryLabel(` 사용 | 통과 |

> E17 주의: `core.js:1180` **주석**에 'setTimeout' 단어가 있어(설명 문구) 문자열 단순 부재 단언은 성립하지 않는다.
> 타이머 **참조** 여부가 계약이므로 호출형(`setTimeout(`)으로 단언했다. `setInterval` 은 주석 포함 0건이라 원안 그대로 유지.
> — 계약을 느슨히 한 것이 아니라 계획 문구(“core 는 타이머 미참조 모듈이어야 함”)에 정확히 맞춘 것.

### E′. app.js 라이브 결선 **동작** 검증 (계획 외 추가 — 텍스트 단언 보강)

`readFileSync` 로 읽은 `web/app.js` 에서 상태 선언 4줄(`liveMode`/`streamRetryTimer`/`streamRetryDelay`/`streamRetryAttempt`)과
`cancelStreamRetry`/`onStreamLoad`/`onStreamError`/`connectStream`/`startLive`/`stopLive`/`reconnectLiveIfActive` 7함수의
**선언 전문을 중괄호 균형 파서로 추출해 `new Function` 으로 실행**한다(테스트가 코드를 복사하지 않음 — 실제 배포 바이트가 검증 대상).
의존성(`$`/`frame`/`snapshot`/`streamUrl`/`drawRoiOverlay`)만 스텁 주입하고, `nextStreamRetryDelay`/`streamRetryLabel` 은 진짜 `core.js` 를 넣었다.

| ID | 내용 | 결과 |
|----|------|------|
| E′1 | `startLive()` → `liveMode='stream'`, `onerror`/`onload` 결선, `src=streamUrl()` 1회, `snapshot.abort()`·`drawRoiOverlay()` 호출 | 통과 |
| E′2 | **자발 폴링 부재(핵심)** — 정상 스트림에서 60초 진행해도 `frame.src` 재대입 0건·`snapshot.tick()` 0건 | 통과 |
| E′3 | 실패 반복 → 1s/2s/4s 시점에만 재연결, 재시도 URL에 `_r=` 캐시버스터. **6초 동안 재연결 3회**(3fps=18회 아님) | 통과 |
| E′4 | 대기 중 `onStreamError` 3연타 → attempt 1·delay 1000 유지, 재연결 1회만(중복 예약 없음) | 통과 |
| E′5 | 대기 중 `stopLive()` → `liveMode='off'`, 타이머 null, 문구 비움, `removeAttribute('src')`, 이후 60초 진행해도 유령 재연결 0건 | 통과 |
| E′6 | `onStreamLoad()` → delay/attempt 0 리셋·문구 소멸, 이후 재실패는 다시 1000ms 부터 | 통과 |
| E′7 | `liveMode='off'` 상태의 잔여 `onStreamError` 무시(타이머 미생성, `#live-status` 미변경) | 통과 |
| E′8 | `reconnectLiveIfActive` — off 면 무동작 / stream 이면 재연결 + 대기 예약 취소(되살아나지 않음) | 통과 |
| E′9 | 8회 연속 실패 지연 = `[1000,2000,4000,8000,16000,30000,30000,30000]` + 상한 안내 문구 표시 | 통과 |

→ **근본 원인(3fps 고착)의 소멸을 동작으로 확인**: 실패가 계속돼도 트래픽은 최악 30초당 1요청, 정상 시 0요청.

---

## 1-B. 보정 검증 — `connectStream()` 재연결 캐시버스터 (2026-07-24 추가)

QA 관찰사항 #1(§2-1)에 대해 developer 가 리더 승인 하에 `web/app.js` `connectStream()` **한 함수만** 보정했다.

```js
const retrying = !!streamRetryTimer || streamRetryAttempt > 0; // cancelStreamRetry() 이전에 캡처
cancelStreamRetry();
...
frame.src = retrying ? `${streamUrl()}&_r=${Date.now()}` : streamUrl();
```

동일한 E′ 결선 하네스(app.js 실바이트 추출 실행)로 회귀 케이스 **7건**(E′10 + E″1~6)을 추가했다. **전부 통과.**

| ID | 내용 | 결과 |
|----|------|------|
| E′10 | 첫 연결 URL 은 `_r` 없는 종전 형태(`streamUrl()` 그대로) | 통과 |
| E″1 | **실패 후 재시도 대기 중 `시작` 재클릭** → `src[1] !== src[0]`, `_r=` 포함, `${STREAM_URL}&_r=` 접두(기존 쿼리 보존). 재클릭이 대기 예약을 취소하므로 이후 60초 진행해도 추가 요청 0건 | 통과 |
| E″2 | 재시도 발화 후(타이머 null·`attempt=1` 잔존) 재클릭도 `_r` 유지, 직전 src 와 상이 | 통과 |
| E″3 | **정상 경로 URL 형태 불변** — 첫 연결 + 정상 중 `reconnectLiveIfActive` 2회 = `[U, U, U]`, 전부 `_r` 없음 | 통과 |
| E″4 | 프레임 도착(`onStreamLoad`)으로 리셋된 뒤의 재연결은 다시 `_r` 없음(재시도 이력 소멸 반영) | 통과 |
| E″5 | `stopLive()` 후 재시작은 `_r` 없음(정지가 이력을 지움) | 통과 |
| E″6 | **순서 의존성 변이 테스트** — 아래 별도 서술 | 통과 |

### E″6 — `retrying` 캡처가 `cancelStreamRetry()` **이전**임에 의존하는가

app.js 에서 추출한 `connectStream` 소스를 줄 단위로 조작해 **캡처 라인을 `cancelStreamRetry();` 뒤로 이동시킨 변이본**을 만들고,
원본 하네스와 변이본 하네스를 같은 시나리오(실패 → `시작` 재클릭)로 돌려 비교했다.

- 원본: `src[1]` 에 `_r=` **있음**(보정 동작).
- 변이본: `_r=` **없음**, 그리고 `src[1] === src[0]`(동일 URL 재대입 = 보정 이전 결함이 그대로 재현).

→ **순서가 바뀌면 실패하는 케이스임이 실증**됐다(`cancelStreamRetry()` 가 `streamRetryTimer=null`·`streamRetryAttempt=0` 으로
지운 뒤 캡처하면 `retrying` 이 항상 false). 즉 보정의 정확성은 **줄 순서에 실제로 의존**하며, 본 테스트가 그 순서를 지킨다.
변이 조작 시 `expect(ci).toBeLessThan(ki)` 로 "원본에서 캡처가 앞"임도 함께 단언한다 — 구현이 순서를 잃으면 이 케이스가 깨진다.

### 보정 후 재실행 결과(그대로)

```
$ npx vitest run test/liveStreamRetry.test.ts
 ✓ test/liveStreamRetry.test.ts (40 tests) 25ms
 Test Files  1 passed (1)
      Tests  40 passed (40)

$ npx vitest run
 Test Files  235 passed (235)
      Tests  2758 passed (2758)
   Duration  16.47s

$ npx tsc -p tsconfig.json --noEmit
tsc exit=0
```

(중간 실패 2건 있었고 모두 **테스트 자체의 결함**이라 테스트를 고쳤다. 구현은 손대지 않았다.
 ① E″4 의 `srcs` 인덱스 오산(3 → 실제 길이 3, 마지막 인덱스 2). ② E″6 변이 조작이 **CRLF 줄바꿈**에서
 라인 제거에 실패해 `retrying` 이 중복 선언(`SyntaxError`) — 정규식 문자열 치환을 줄 배열 splice 로 교체.
 두 건 모두 단언 자체를 느슨하게 하지 않았다.)

### 보정 후 남는 한계

- `_r` 파라미터를 서버 `StreamQuery`(비-strict zod)가 strip 한다는 전제는 **정적 확인**일 뿐, 라이브 요청으로 검증하지 않았다(§4-1 F 항목과 동일 성격).
- "동일 URL 재대입 시 브라우저가 재요청을 생략하는가" 자체는 여전히 node 에서 재현 불가. 보정은 **동일 문자열이 되지 않게 만드는** 방어이며,
  그 방어가 성립함(문자열이 실제로 달라짐)을 검증한 것이지 브라우저 semantics 를 검증한 것이 아니다.
- `Date.now()` 해상도(ms) 상 **같은 밀리초 내** 재클릭이면 이론상 동일 문자열이 될 수 있다. E″2 는 이를 인지해 5ms 진행 후 재클릭으로 모사했다.
  실사용(사람의 클릭)에서 발생 불가능한 시나리오라 결함으로 보지 않는다.

---

## 2. 발견 결함

**차단성 결함 0건.** 아래 #1 은 최초 검증 시의 관찰 사항이며 **§1-B 보정으로 해소**됐다(기록 보존).
#2·#3 은 설계 단계에서 이미 수용된 트레이드오프다.

1. **(해소됨 — §1-B) 첫 실패 직후 1초 내 `시작` 재클릭 시 재요청 생략 가능성.**
   `connectStream()` 은 `frame.src = streamUrl()`(캐시버스터 없음)을 대입한다. 최초 연결이 실패하고 **첫 재시도 타이머가 발화하기 전**에
   사용자가 `시작` 을 누르면 현재 `src` 와 대입값이 **완전히 동일한 문자열**이 되어, 브라우저가 재요청을 생략하면
   `onerror` 도 다시 뜨지 않고(그 사이 `cancelStreamRetry()` 로 기존 예약은 취소됨) 재시도가 걸리지 않는 정지 상태가 될 수 있다.
   구현자 주석("동일 URL 재대입은 브라우저가 재요청을 생략할 수 있어")이 같은 성질을 인정하고 있어 실재 가능성이 있다.
   창(window)은 **최초 실패 후 1초 이내**로 좁고, 한 번이라도 재시도가 발화한 뒤에는 `src` 가 `…&_r=<ts>` 라 문제가 사라진다.
   node 유닛으로는 브라우저의 동일 URL 재대입 semantics 를 재현할 수 없어 **검증 불가 — 관찰 사항으로만 보고**했다.
   → **조치 완료**: developer 가 `connectStream()` 에 `retrying` 조건부 캐시버스터를 도입(리더 승인).
   정상 경로 URL 형태는 불변이라 `move()`/`reconnectLiveIfActive()` 의 “동일 URL race 무해” 성질도 보존된다. 검증은 §1-B.

2. **(설계 기수용) 무음 정지(silent stall)** — 200 응답 후 상류가 조용히 멈추면 `onerror` 미발화 → 자동 재시도 없음.
   계획 §7-2 / 구현 §3-3 이 이미 범위 밖으로 명시. 유닛으로 확인할 성질이 아니며, 워치독 도입은 별건.

3. **(설계 기수용) 스트림 미지원 소스(501)** — `img.onerror` 가 HTTP 상태를 못 봐 일시 장애와 구분 불가 → 30초 간격 재시도로 수렴.
   리더가 트레이드오프로 수용한 사항.

---

## 3. 경계면 교차 비교

| 경계 | 확인 |
|------|------|
| `core.js` export ↔ `core.d.ts` 선언 | `nextStreamRetryDelay(prevMs?: number\|null)`, `streamRetryLabel(attempt, delayMs)`, `createSnapshotFetcher → { tick, abort }` 일치. `tsc --noEmit` exit 0 로 확증. `SnapshotFetcher` 에 인덱스 시그니처가 없어 `f.start` 접근이 타입 오류가 되는 것까지 확인(테스트에서 `as unknown as Record` 로 명시 우회) |
| `core.js` ↔ `app.js` 소비 | `app.js` import 3개(`createSnapshotFetcher`/`nextStreamRetryDelay`/`streamRetryLabel`)가 실제 export 와 일치. E′ 하네스가 **진짜 core 함수를 주입**해 실행 → 인자 순서(`attempt, delayMs`) 불일치 시 문구 단언이 깨지도록 설계 |
| `app.js` ↔ `index.html` | `$('live-status')` ↔ `<span id="live-status" aria-live="polite">` 존재 확인. 삭제된 `id="fps"` 를 참조하는 코드 0건 |
| `app.js` ↔ 서버 라우트 | 재시도 URL 의 `_r` 파라미터는 `StreamQuery`(비-strict zod)가 strip — 서버 무변경 전제 유지(구현 변경 없음 확인) |

---

## 4. 검증 한계 (위장 없이 명시)

1. **라이브 스모크(계획 F21~23) 미수행.** Unity(Parking3D)·SettingAgent 서버·브라우저 탭이 필요한 관찰형 항목으로,
   본 검증에서는 **실행하지 않았다.** 다음은 리더/사용자 실측이 필요하다.
   - F21: Unity 정지 상태에서 `시작` → `#live-status` 가 1s→2s→4s… 증가 표시, `/viewer/api/snapshot` 요청 **0건**.
   - F22: Unity 기동 → 첫 프레임 도착 시 문구 자동 소멸(백오프 리셋).
   - F23: 재시도 대기 중 `정지`/정밀수집 시작 → 이후 `/viewer/api/stream` 재요청 0건.
   - **필수 선행**: `web/*` 는 nodemon 감시 밖 → 브라우저 **하드리로드(Ctrl+Shift+R)**. 기존 탭은 리로드 전까지 3fps 폴링을 계속한다.
2. **실제 DOM 이벤트 결선 미검증.** `btn-start`/`btn-stop`/`sel-cam`/`sel-preset`/`btn-goto` 리스너 등록, `<img>` 요소에 대한
   `onerror`/`onload` 실제 발화, `app.css` `#live-status` 스타일 적용은 node 환경(jsdom 미사용)에서 확인 불가.
   E′ 하네스는 **함수 본문 실행**까지만 보장하며, "그 함수가 실제 버튼/요소에 연결돼 있는가"는 텍스트 존재(E19)로 갈음했다.
3. **브라우저 MJPEG semantics 가정 미검증.** `multipart/x-mixed-replace` 의 프레임별 `load` 발화(계획 §7-1)와
   동일 URL 재대입 시 재요청 여부(§2-1)는 실브라우저에서만 확인 가능.
4. **정밀수집/센터라이징/탐색의 500ms 프레임 폴** 3경로는 무변경 비범위로, 본 검증에서 회귀 확인은
   **전체 스위트 2751 통과**로만 갈음했다(해당 경로 전용 신규 케이스는 작성하지 않음).

---

## 5. 실행 로그(그대로)

```
$ npx vitest run test/liveStreamRetry.test.ts
 ✓ test/liveStreamRetry.test.ts (33 tests) 18ms
 Test Files  1 passed (1)
      Tests  33 passed (33)

$ npx vitest run test/liveStreamRetry.test.ts test/viewerCore.test.ts
 ✓ test/viewerCore.test.ts (67 tests)
 ✓ test/liveStreamRetry.test.ts (33 tests)
 Test Files  2 passed (2)
      Tests  100 passed (100)

$ npx vitest run
 Test Files  235 passed (235)
      Tests  2751 passed (2751)
   Duration  15.10s

$ npx tsc -p tsconfig.json --noEmit
tsc exit=0
```

(중간 실패 1건 있었고 원인 규명 후 해소: E17 초안이 `core.js` 의 **주석 문구** 'setTimeout' 에 걸렸다 →
계약이 "타이머 미참조"이므로 호출형 `setTimeout(` 로 정정. 구현 코드는 손대지 않았다.)
