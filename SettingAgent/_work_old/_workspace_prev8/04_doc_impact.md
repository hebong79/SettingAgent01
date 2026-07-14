# 04. 영향도 분석 — 정밀수집 뷰어 "라이브 Unity 동기화(최신 캡처 프레임 추종)"

- 작성일시: 2026-07-01 23:11:12
- 최종 문서: `SettingAgent/docs/20260701_231112_라이브Unity동기화_최신캡처프레임추종.md`
- 변경 표면: `web/core.js`, `web/core.d.ts`, `web/app.js` 3개(모두 뷰어 클라이언트). 서버·라우트·잡 무변경.

## 1. 직접 변경 파일

| 파일 | 변경 | 성격 |
|---|---|---|
| `web/core.js` | `capFrameKey(cam,preset,round)` 순수 헬퍼 export 추가(`:109-117`) | 신규(부작용 없음) |
| `web/core.d.ts` | `capFrameKey` 타입 선언 추가(`:65`) | 신규 |
| `web/app.js` | `capFrameTick`/`startCapFramePolling` 재작성, `capPresetKeys`/`capCycleIdx` 제거, import 추가 | 외과적 수정 |

## 2. 서버 무변경 확인 (방안 A 전제)

- `src/api/captureRoutes.ts` **무변경**. `GET /capture/frame`은 파라미터 없을 때 `latest`(getLastFrame) 반환 분기(`:117-121`)를 **기존부터** 가지고 있어, 뷰어가 파라미터 없이 호출해도 계약이 성립한다. 응답 헤더 `X-Cap-Cam/Preset/Round`(`:129-131`) 방출 로직도 그대로.
- `src/capture/CaptureJob.ts` **무변경**. `lastFrame` 갱신 로직(잡이 타깃을 찍을 때마다 갱신)이 그대로여서 웹이 캡처 진행을 추종하는 근거가 유지된다.
- 라우트 계약(REST) 자체 불변 → **서버·다른 REST 클라이언트에 파급 없음**.

## 3. `/capture/frame` 소비 패턴 변화 (계약 불변, 사용법만 변경)

- 변경 전: 뷰어가 `?cam=&preset=`으로 특정 프리셋을 지정 + `X-Cap-Presets` 헤더로 프리셋 목록을 받아 700ms 순환.
- 변경 후: **파라미터 없이 최신 프레임만** 요청. `X-Cap-Presets` 헤더는 **미소비**.
- 영향: 서버 응답 shape은 동일하나, 소비 측이 "특정 프리셋 순환"에서 "최신 1건 추종"으로 바뀜. 서버는 이를 인지할 필요 없음(무상태 계약).

## 4. capPoll 상태전이·결과 모달·floor 경고 — 무영향

- `capPoll` 상태전이(`app.js:595-624`): `active` 판정, `startCapFramePolling`/`stopCapFramePolling` 호출 구조 **무변경**(내부 tick 로직만 교체).
- 결과 모달 `showCaptureResult`(`:614-616`, `wasActive && done/stopped/error`): **무변경**. 1회 표시 가드 그대로.
- floor ROI LLM 경고(`:600-602`, `llmFloorUnavailable` 런당 1회): **무변경**.
- `pollPlan` 재예약(`:619-624`): **무변경**.
- 결론: 변경은 `capFrameTick`/`startCapFramePolling` 내부에 국한 → 수집 상태머신 흐름에 파급 없음.

## 5. loop(라이브 스트림) 생명주기 영향 (실질 영향 지점)

- **수집 중**: `startCapFramePolling`이 `loop.stop()`을 **유지** → 라이브 스트림은 수집 내내 정지. 카메라 경합(방안 B의 문제) 회피.
- **수집 종료 후**: `stopCapFramePolling`은 타이머만 끄고 `loop.start`를 호출하지 않음(리더 #1, 자동 복귀 없음). → 라이브가 꺼진 채로 마지막 캡처 프레임이 화면에 남는다.
- **재개**: 사용자가 수동 ▶(loop.start)를 눌러야 라이브 복귀(기존 경로, 무변경).
- 영향: 다른 화면(수동 스트리밍·매핑·ROI 편집)의 loop/move 경로는 무변경 → 이들 화면 무영향. 단 "수집 종료 후 라이브가 자동으로 안 돌아온다"는 **동작 변화**가 사용자에게 노출됨(운영 주의로 문서화, 정상 동작).

## 6. 고아·미사용화

- **제거(내 변경으로 미사용화)**: `capPresetKeys`, `capCycleIdx` — app.js 내 잔여 참조 0건(grep 확인).
- **미사용화(데드 아님, 무변경)**: 서버 `X-Cap-Presets` 헤더, `CaptureJob.getFrameByPreset`/`getFramePresets` — 뷰어 미소비이나 라우트 계약이라 잔존. 삭제는 요청 범위 밖.

## 7. 공유 타입·테스트 파급

- `@parkagent/types`·도메인 타입(SlotState/ParkingEvent 등) **미변경** → 타 에이전트(ActionAgent/DMAgent) 파급 없음.
- 테스트: `test/viewerCore.test.ts`에 `capFrameKey` describe 추가(7 케이스). 기존 20 + 신규 7 = 27 passed. 전체 471/471 passed(회귀 0). 다른 테스트 파일 무영향.

## 8. 회귀 위험 및 확인 필요 항목

- **자동 검증으로 커버됨**: `capFrameKey` 순수 로직(키 생성·null 규약·부분 null 구분). 경계면 shape 대조(헤더명·타입·인자 순서) 일치 확인.
- **자동 검증 불가(수동 실확인 필요 — 현재 미검증)**: 다음은 DOM/타이머/실 Unity·잡 의존으로 vitest 미커버. 회귀 위험이 남는 지점:
  1. 수집 중 프레임이 실제로 캡처 진행을 추종하는지(폴 주기 500ms vs 타깃 간격 ~0.6s).
  2. 대기 중 동일 키 스킵으로 깜빡임/재디코드가 실제로 없는지.
  3. 종료 후 마지막 프레임 유지 및 결과 모달 1회·floor 경고 정상.
  4. 종료 후 수동 ▶로 라이브가 정상 재개되는지(loop.start 경로).
- **확인 필요**: 위 4개 항목은 브라우저 실행 없이는 단정 불가. 정밀수집 실행 중 육안 확인 요망(문서 §7 체크리스트).

## 9. 종합

- 파급 범위: 뷰어 클라이언트 3파일에 국한. 서버·REST 계약·공유 타입·타 에이전트·타 화면 무영향.
- 실질적 사용자 노출 변화: (a) 수집 중 화면이 캡처를 추종·대기 중 고정(순환 제거), (b) 수집 종료 후 라이브 자동 복귀 없음(수동 ▶ 필요).
- 잔여 리스크: 수동 동작확인 5개 항목 미수행 — 자동 회귀는 0이나 실브라우저 동기화·고정·깜빡임·종료후 유지·수동 재개는 실확인 전까지 "미검증"으로 유지.
