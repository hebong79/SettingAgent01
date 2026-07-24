# 04 영향도 분석 — 3fps 폴링 폴백 제거 + 스트림 자동 재시도

작성: 2026-07-24 22:54 / 문서화·영향도 분석가(documenter) / 근거: 00~03 산출물 + 실제 코드(`web/core.js`,`web/core.d.ts`,`web/app.js`,`web/index.html`,`web/app.css`,`src/viewer/routes.ts`)

최종 문서: `SettingAgent/docs/20260724_225404_라이브스트림_폴링폴백제거_자동재시도.md`

---

## 1. web/ 자산 간 의존 파급

```
web/core.js (순수 로직, DOM/타이머 미참조)
   ├─ export nextStreamRetryDelay, streamRetryLabel   (신규)
   ├─ export createSnapshotFetcher  ← 개명(구 createStreamLoop, start/setTimer/clearTimer 삭제)
   └─ export moveRenderDirective    (본문 무변경, 인자 union만 축소)
        │  타입 재수출
        ▼
web/core.d.ts
   ├─ SnapshotFetcherDeps ← StreamLoopDeps (setTimer?/clearTimer? 삭제)
   ├─ SnapshotFetcher{tick,abort} ← StreamLoop{start,stop,tick}
   ├─ createSnapshotFetcher 선언 ← createStreamLoop
   ├─ nextStreamRetryDelay/streamRetryLabel 신규 선언
   └─ moveRenderDirective 인자 'off'|'stream' (구 +'poll' 제거)
        │  import
        ▼
web/app.js
   ├─ import 교체: createStreamLoop→createSnapshotFetcher, +nextStreamRetryDelay/streamRetryLabel
   ├─ const snapshot = createSnapshotFetcher({...})  (구 loop)
   ├─ liveMode 'off'|'stream'(구 +'poll'), fallbackToPolling() 삭제
   ├─ 신규: cancelStreamRetry/onStreamLoad/onStreamError/connectStream
   ├─ startLive/stopLive/reconnectLiveIfActive 재구현(connectStream 경유)
   ├─ move() else 분기: loop.tick() → snapshot.tick()
   └─ DOM 참조: $('fps') 삭제, $('live-status') 신규
        │  DOM 결선 대상
        ▼
web/index.html
   ├─ 삭제: <input id="fps">
   └─ 신규: <span id="live-status" aria-live="polite">
        │  스타일
        ▼
web/app.css
   └─ 신규: #live-status 규칙 3줄 (#ptz-control-status 패턴 차용, 기존 .field.compact input 등 무변경)
```

**개명(`createStreamLoop → createSnapshotFetcher`)의 파급 범위는 4개 지점으로 닫혀 있다**: `core.js`(정의) · `core.d.ts`(타입) · `app.js`(호출 4곳: 생성/두 stop 지점/tick 지점) · `test/viewerCore.test.ts`(describe 제목·it 이름 갱신, 신규 `test/liveStreamRetry.test.ts`는 새 이름으로 작성). `grep -rn "createStreamLoop|fpsToInterval|StreamLoop"` 를 `test/ src/ web/` 전체에 돌려 잔존 참조 0건을 확인했다(구현자 §2 로그). **`src/`(서버) 는 이 개명·삭제와 무관** — `CameraSource`/`SimulatorSource`/`RealPtzSource`의 `streamMjpeg`는 서버측 별도 심볼로 이름이 겹치지 않는다.

---

## 2. 서버측(`src/`) 영향 — 무변경 확인

### 2.1 `/viewer/api/stream`, `/viewer/api/snapshot`
`src/viewer/routes.ts`는 이번 작업에서 **한 줄도 수정되지 않았다**(구현자 §1, grep 결과로 확증). `handleStream`(라우트 242~313행)·`handleSnapshot`·`StreamQuery`/`SnapshotQuery`(zod) 전부 그대로.

### 2.2 `StreamQuery`의 `_r` strip
```ts
const StreamQuery = z.object({
  source: z.string().optional(),
  cam: z.coerce.number().int().positive(),
  preset: z.coerce.number().int().positive(),
  pan: z.coerce.number().optional(),
  tilt: z.coerce.number().optional(),
  zoom: z.coerce.number().optional(),
});
```
`z.object(...)`는 기본이 **strip 모드**(strict/passthrough 미지정)라, 재시도 URL에 붙는 미지의 키 `_r=<timestamp>`는 파싱 시 조용히 제거된다. 스키마 변경이 전혀 필요 없었다는 설계·구현 판단을 코드로 직접 확인했다.

### 2.3 `MAX_STREAMS=4` 와 재시도의 상호작용 (위험 평가)
`routes.ts:38` `const MAX_STREAMS = 4;`, 카운터는 `handleStream`의 `streamState.active`(등록기 지역, 전체 소스 공유 — 소스별이 아님). 증가 시점은 **"실제 연결 성립 후"**(292행 `streamState.active++`)로, 첫 프레임 `await it.next()`가 실패(501/502/503)하면 카운터는 **증가하지 않는다**. 감소는 `finally`에서 무조건 실행(310행).

- **재시도가 슬롯을 고갈시킬 위험: 낮음.** 실패한 연결 시도는 카운터를 건드리지 않으므로, 스트림이 죽어 있는 소스에 대해 여러 탭이 반복 재시도해도 `streamState.active`는 0에 머문다 — "좀비 슬롯 점유"가 발생할 수 없는 구조다.
- 정상 시나리오(스트림이 살아있고 탭 4개 이상 동시 시청)에서의 상한 초과는 **이번 변경과 무관하게 기존에도 존재하던 제약**이다(5번째 연결 503). 재시도 로직은 이 한계를 새로 만들지도, 완화하지도 않는다.
- **오히려 개선된 지점**: 구 폴백은 실패 시 `/viewer/api/snapshot`(스트림 카운터 밖의 경로)으로 333ms마다 계속 요청했다. 신 설계는 `/viewer/api/stream` 재시도이지만 지수 백오프(최대 30초 간격)로 요청 자체가 200배 줄어, 실패 상태에서의 서버 부하는 구 폴백보다 크게 감소했다.
- **확인 필요(미검증)**: 다수 탭이 동시에 같은 실패 소스에 재시도를 걸 때 재시도 타이머가 우연히 동기화(thundering herd)될 가능성은 이론상 존재하나, 지수 백오프 상한(30s)과 탭별 독립 상태(모듈 전역이 탭=페이지 단위)로 완화되며 이번 범위의 검증 대상은 아니었다.

---

## 3. 비범위 경로 — 영향받지 않음 근거

| 경로 | 근거 |
|------|------|
| 정밀수집 500ms 프레임 폴(`capFrameTimer`, `startCapFramePolling`) | 이 함수는 기존부터 `stopLive()`를 호출해 라이브 스트림/재시도를 정지시킨 뒤 자신의 별도 타이머로 진행 표시를 갱신한다. `stopLive()`가 `cancelStreamRetry()`를 포함하도록 확장됐을 뿐 **호출부 코드는 0줄 변경**(설계 §2.3 표, 구현 §1.3 "해당 3곳 코드 변경 0"). |
| 센터라이징 500ms 프레임 폴(`calFrameTimer`, `startCalFramePolling`) | 상동 — `stopLive()` 상속. |
| 번호판 탐색 500ms 프레임 폴(`discFrameTimer`, `startDiscFramePolling`) | 상동 — `stopLive()` 상속. |
| `CaptureJob`(`src/capture/CaptureJob.ts`) | 서버측 정밀수집 잡 파이프라인. `web/` 변경과 레이어가 다르고 이번 diff에 포함되지 않음(파일 미수정). |
| `CameraSourceClient.pollSnapshots`(서버측, 스트림 미지원 소스 폴백) | `src/`(서버) 무변경 확인(§2.1)에 포함 — RealPtzSource(Hucoms) 등 `streamMjpeg` 미구현 소스에 대한 **서버측** 폴백 경로로, 이번에 제거된 것은 **프론트(`web/app.js`)의 폴링 폴백**과는 다른 계층. 명칭 유사성으로 혼동하기 쉬우나 코드 경로가 분리되어 있어 무영향. |
| `/viewer/api/snapshot` 라우트 자체 | §2.1에서 무변경 확인. `mode=manual`(수동 PTZ 오버라이드 1회 스냅샷), `gotoPreset()`의 프리셋 스냅샷 폴백 등 소비처는 계속 이 라우트를 쓴다 — `snapshot.tick()`(구 `loop.tick()`)이 여전히 호출. |

**검증 근거**: qa 03 §4-4 "정밀수집/센터라이징/탐색의 500ms 프레임 폴 3경로는 무변경 비범위로, 전용 신규 케이스는 작성하지 않았고 전체 스위트 2751 통과로만 회귀 확인을 갈음했다" — 즉 이 3경로에 대한 **전용 회귀 테스트는 없다**(확인 필요 항목으로 남김. 전체 스위트 통과가 간접 증거이나, 라이브 브라우저 상에서 잡 시작 시 스트림이 실제로 멈추는지는 §5 "라이브 스모크 미수행"과 동일하게 실측 필요).

---

## 4. 공유 도메인 타입(SlotState/ParkingEvent 등) 영향

**해당 없음.** 이번 변경은 SettingAgent 웹 뷰어의 라이브 스트림 UI 상태(`liveMode` 등 로컬 변수)와 `web/core.js`의 순수 함수에 국한되며, `@parkagent/types`의 공유 도메인 타입이나 `SlotState`/`ParkingEvent` 류 스키마를 전혀 건드리지 않았다. ActionAgent/DMAgent로의 전파도 없다.

---

## 5. 20260709 문서와의 관계

`docs/20260709_141227_SettingAgent_MJPEG연속스트리밍_전환.md`가 도입한 "MJPEG 실패 시 폴링(`fallbackToPolling`/`loop.start(fps)`)으로 폴백"(동 문서 §5 다이어그램 최하단, §7 루프2 L2-3, §9 변경 파일 표)은 이번 작업으로 **폐지되어 더 이상 코드와 일치하지 않는다**. 해당 문서는 과거 시점 기록물이므로 **수정하지 않았다** — 이 사실의 갱신은 본 세션이 새로 작성한 문서(`docs/20260724_225404_*.md` §1.2 "존치" 각주 및 본 파일)에서만 기록한다.

부수 확인 필요 항목(설계자 §6 언급, 미해결): `docs/20260625_182819_SettingViewer_구현문서.md`가 `core.js` 함수 목록에 `fpsToInterval`을 언급하고 있을 수 있다 — 이번 세션에서는 열람·정정하지 않았다(리더 판단 대상으로 남김, **확인 필요**).

---

## 6. 테스트 근거 (사실 인용, 위장 없음)

- `npx vitest run` 전체 — **235 files / 2751 tests 전부 통과**(qa 03 §0).
- 신규 `test/liveStreamRetry.test.ts` — **33 tests 통과**(A~E + E′ 9케이스 포함).
- `npx tsc -p tsconfig.json --noEmit` — **exit 0**.
- **미수행**: 계획 §5 F21~23 라이브 스모크(Unity 기동/정지 상태의 실브라우저 관찰) — qa 03 §4-1에 한계로 명시, 리더/사용자 실측 필요.
- **미검증**: 브라우저 `multipart/x-mixed-replace` onload semantics, 동일 URL 재대입 시 재요청 생략 여부(§3.3 보정의 전제) — node 유닛 재현 불가로 qa 03 §4-3에 한계로 명시.

---

## 7. 요약

| 항목 | 결론 |
|------|------|
| web/ 자산 파급 | core.js→core.d.ts→app.js→index.html/app.css 4단 연쇄, 개명 참조 4개 지점으로 닫힘. grep 전수 확인 0건 잔존 |
| 서버(`src/`) | 무변경. `StreamQuery`가 `_r` strip, 스키마 변경 불필요 |
| MAX_STREAMS=4 상호작용 | 낮은 위험 — 카운터가 연결 성립 후에만 증가해 실패 재시도가 슬롯을 점유하지 않음. 트래픽은 오히려 최대 200배 감소 |
| 비범위 경로(정밀수집/센터라이징/탐색, CaptureJob, CameraSourceClient.pollSnapshots) | 코드 변경 0, `stopLive()` 상속으로 무영향. 단 이 3경로 전용 회귀 테스트는 없어(전체 스위트로 갈음) 라이브 실측 확인 필요 항목으로 남김 |
| 20260709 문서 | 폴백 기술이 구식화됨을 본 문서에서 기록, 원문은 미수정 |
| 공유 도메인 타입 | 영향 없음(웹 뷰어 로컬 상태·순수함수 국한) |
