# 01. 설계서 — 정밀수집 뷰어를 "라이브 Unity 동기화"로 전환

## 배경·요구 (사용자 확정)
- 현재 `capFrameTick`이 `capPresetKeys`(X-Cap-Presets)를 700ms마다 순환하며 **캡처된 모든 프리셋 프레임을 번갈아 표시**한다.
- Unity는 라운드 캡처 순간에만 물리 이동하고 라운드 사이(intervalMs)엔 정지 → 웹만 옛 프레임을 계속 순환해 "Unity 정지인데 웹만 반복 갱신"으로 혼란.
- 요구: (a) 캡처가 각 타깃을 찍을 때마다 **그 최신 프레임**을 따라가고(카메라 이동을 웹이 반영), (b) 라운드 사이 대기 중엔 **순환 금지·마지막 프레임 고정**. 700ms 다중 프리셋 순환 제거.

## 대안 비교 (A 채택)
- **A. 최신 캡처 프레임 추종 (권장, 서버 무변경)**: `capFrameTick`이 `/capture/frame`을 **파라미터 없이** 호출 → 서버 `getLastFrame()`(가장 최근 캡처)만 반환(captureRoutes.ts:117-121). 잡이 타깃을 찍을 때마다 `lastFrame`이 갱신(CaptureJob.ts:230)되므로 웹이 캡처 진행=Unity 이동을 그대로 추종. 라운드 사이엔 `lastFrame` 불변 → 같은 프레임 반환 → 사실상 정지.
- **B. 라이브 스트림(loop) 수집 중 유지**: loop는 `/snapshot`을 `state.ptz`(현재 PTZ) override로 요청(app.js:410-416). 잡은 `/req_move`로 프리셋을 물리 이동하는데 loop의 `state.ptz`는 그와 무관 → 카메라를 두고 다투고 동기도 안 됨. **기각.**
- 결론: **A 채택**. 서버·라우트 무변경, `web/app.js`만 외과적 수정.

## 수정 지점 (web/app.js — DOM 로직, 순수 함수 없음)

### 1) `capFrameTick` (533-558): 순환 제거 → 최신 프레임만
- `capPresetKeys`/`capCycleIdx` 기반 `?cam=&preset=` 쿼리 제거. `fetch('/capture/frame', {cache:'no-store'})`(파라미터 없음)로 최신 프레임만 요청.
- **깜빡임/재디코드 방지**: 응답 헤더 `X-Cap-Round` + `X-Cap-Cam` + `X-Cap-Preset` 조합이 **직전과 동일하면** blob 생성·`frame.src` 교체·cap-msg 갱신을 **스킵**하고 조기 return. (라운드 사이 동일 프레임 반복 fetch가 무해하도록.) 직전 값은 모듈 스코프 변수(예: `lastCapFrameKey`)로 보관.
  - 근거: `img_name`은 헤더에 없음. `cam:preset:round`가 캡처 1건을 유일 식별(같은 라운드에서 프리셋 순회하므로 cam·preset 포함 필요). 새 캡처가 없으면 키 동일 → 스킵.
- cap-msg는 기존대로 `X-Cap-Cam/Preset/Round`로 구성하되, "대상 카메라 목록"(capPresetKeys 파생) 문구는 순환 제거로 근거가 사라지므로 **제거 또는 단순화**(예: `수집 중 — cam{c} 프리셋{p} (라운드 {r})`).

### 2) `startCapFramePolling` (560-567): 순환 상태·주기
- `capPresetKeys=[]`, `capCycleIdx=0` 초기화 라인 제거(변수 자체 미사용화). `lastCapFrameKey=null`로 초기화 추가.
- `loop.stop()` **유지**(라이브와 카메라 다툼 방지 — A에서도 loop `/snapshot`은 프리셋과 무관하므로 켜두면 안 됨).
- **폴링 주기: 700ms → 500ms**. 근거: 캡처 타깃 간 이동 간격이 약 0.6s이므로 500ms면 각 타깃 프레임을 놓치지 않고 1~2회 내로 따라잡고(추종성), 대기 중엔 동일키 스킵으로 재디코트 비용이 없어 과부하 없음. (400ms도 가능하나 500ms가 fetch 빈도/추종 균형.)

### 3) `capPresetKeys`/`capCycleIdx` (530-531): 미사용 변수 제거
- 두 선언 및 관련 주석 삭제. `capFrameUrl`은 유지(revoke 대상).

### 4) 수집 종료 후 라이브 복귀 (capPoll 611 / stopCapFramePolling)
- 현재 `stopCapFramePolling`은 타이머만 끈다 → `frame`은 마지막 캡처 프레임에 **얼어붙음**(loop는 startCapFramePolling에서 stop된 상태). 사용자가 이후 "화면이 멈춤"으로 오인 가능.
- **처리(최소)**: 활성→비활성 전환 시(capPoll 606 else 분기, `wasActive && !active`) `loop.stop()`으로 꺼진 라이브를 **자동 재개하지 않는다**(자동 이동/카메라 재명령 회피 = 안전). 대신 종료 프레임을 유지하되, 마지막 캡처 프레임이 그대로 남는 것이 정상 동작임을 문서화. **단, 회귀 확인 필요**: 종료 후 사용자가 수동으로 라이브(▶) 버튼을 누르면 정상 재개되는지(loop.start) — 이는 기존 경로라 무변경.
  - 리더 확인 포인트 #1: 종료 후 자동 라이브 복귀를 원하는가? (원하면 else 분기에 `loop.start(fps)` 1줄 추가 가능. 기본안은 **자동 복귀 안 함** — 자동 카메라 이동 유발 안 하려는 보수적 선택.)

## 회귀 주의 (무변경 확인 항목)
- `stopCapFramePolling`/`capPoll` 상태전이(603-624), 결과 모달(`showCaptureResult` 613-616), floor LLM 경고(599-602), pollPlan 재예약 — 모두 **무변경**. capFrameTick 내부만 수정.
- `capFrameUrl` revoke 로직 유지(누수 방지). 스킵 시엔 새 blob을 만들지 않으므로 revoke도 하지 않음(직전 url 유지).

## 검증

### 자동(vitest) — 제한적
- 대상 로직이 거의 순수하지 않음(DOM+fetch). 유일하게 순수화 가능한 조각: **"동일 프레임 키면 스킵" 판정**. 필요 시 `sameCapFrame(prevKey, headers)` 소형 헬퍼로 분리해 단위 테스트(같은 cam:preset:round → true, 다르면 false). 없으면 이 항목은 수동확인으로 이관.

### 수동 확인 (주)
1. 수집 시작 → 라이브 스트림 꺼지고 캡처 프레임 표시.
2. **수집 중 추종**: 라운드 내 타깃 순회 시 웹 프레임이 캡처(=Unity 카메라 이동)를 따라 바뀐다.
3. **대기 중 고정**: 라운드 사이(intervalMs) 웹 프레임이 **바뀌지 않고 고정**(순환 없음). cap-msg 라운드 번호도 그대로.
4. **종료 후**: done/stopped 시 얼어붙지 않고 마지막 캡처 프레임 유지, 결과 모달 1회 표시, floor 경고 정상.
5. 깜빡임: 대기 중 동일 프레임 반복 fetch에도 이미지가 깜빡이지 않음(스킵 동작).

## 영향도
- **직접 수정**: `web/app.js`(capFrameTick / startCapFramePolling / capPresetKeys·capCycleIdx 제거 / cap-msg 문구). 약 20~30줄 내 외과적.
- **무변경**: 서버 `captureRoutes.ts`(/capture/frame는 파라미터 없이도 최신 프레임 반환 — 기존 지원), `CaptureJob.ts`(lastFrame 갱신 로직 그대로). `getFrameByPreset`/`getFramePresets`/`X-Cap-Presets`는 **잔존하나 뷰어 미사용**이 됨 → 데드는 아님(라우트 계약), 제거는 요청 범위 밖이므로 **건드리지 않음**(문서화에 "미사용화" 언급만).
- 다른 화면(수동 스트리밍·매핑·ROI 편집): loop/move 경로 무변경 → 영향 없음.

## 리더 확인 포인트
- #1 (재확인): 수집 종료 후 **자동 라이브 복귀** 여부 — 기본안은 "복귀 안 함(수동 ▶로 재개)". 자동 복귀 원하면 1줄 추가.
- #2: 폴링 주기 **500ms** 채택안 승인(요구 400~700ms 범위 내, 근거는 §2). 다른 값 선호 시 지정.
- #3: `sameCapFrame` 헬퍼 분리(테스트 가능화) vs capFrameTick 인라인 — 기본안은 **소형 헬퍼 분리**로 최소 유닛테스트 확보(CLAUDE.md 규칙2).
