# 영향도 분석: 카메라 타입 콤보박스(시뮬레이터/리얼카메라)

## 변경 요약
`#opt-camera-kind`를 readonly 텍스트 → select(sim/hucoms)로 전환. 프론트 편집 경로만 신규 추가, 백엔드 무변경(기존 스키마가 이미 `kind` 편집을 화이트리스트·필수로 지원 — `settingsStore.ts:32-79`, 병합 키 `:212`).

## 직접 영향 파일
- `SettingAgent/web/index.html` (~380행): input readonly → select 2 option.
- `SettingAgent/web/app.js`: `renderCameraSource`(~3280), `captureCameraSourceEdits`(~3268), `cameraSettingsPatch`(~3317, 기존 로직 그대로 `kind: source.kind` 사용 — 변경 없음, 편집 가능해진 값이 흘러들어감), change 리스너 신규 추가(~3852).
- `SettingAgent/test/cameraKindSelect.test.ts` (신규 6 테스트).

## 연쇄 영향(같은 렌더 함수 안에서 kind 에 연동되는 기존 로직)
- **RTSP 입력 활성/비활성**: `$('opt-camera-rtsp').disabled = source?.kind !== 'hucoms'` (app.js:3289). 콤보 전환으로 `kind`가 실제로 바뀔 수 있게 되면서, 이 disabled 토글이 처음으로 "같은 화면 세션 안에서" 실질 발동한다. change 리스너가 `captureCameraSourceEdits()` 후 `renderCameraSource()`를 재호출하므로 즉시 반영됨(재확인: app.js:3852-3855).
- **스트리밍 안내문(note)**: `kind === 'hucoms'` 분기로 "RTSP→FFmpeg→MJPEG" vs "시뮬레이터 URL→HTTP MJPEG" 문구가 갈린다(app.js:3291-3296). 위와 동일하게 콤보 change 시 즉시 갱신.
- **프론트 사전검증 `settingsFormErrors`** (`web/core.js:189-202`): `kind === 'hucoms'`일 때 RTSP URL 필수·형식(rtsp/rtsps) 검사. 이번 변경 이전에도 존재했으나 `kind`가 편집 불가였으므로 사실상 죽은 분기였다 — 콤보 도입으로 처음 실질적으로 저장을 막을 수 있게 됨. 로직 자체는 미변경.
- **백엔드 `SettingsPatchSchema.superRefine`** (`src/config/settingsStore.ts:51-79`): 동일 규칙(hucoms+rtspUrl 필수·프로토콜·계정정보 분리)을 서버측에서 재검증. 미변경, 그러나 이제 실제로 `kind='hucoms'`이고 RTSP가 비어있는 patch가 프론트에서 넘어올 수 있는 경로가 열렸으므로, 이 가드가 실전에서 처음으로 방어 역할을 하게 됨.

## 저장·반영 경로
- `PUT /settings` → `writeEditableSettings`가 `config/tools.config.json`의 `cameraSources[]`를 부분 병합(화이트리스트, 배열 전체 미교체 → `ptz` 등 비편집 필드 보존).
- `config/`는 nodemon watch 범위 밖 → 저장 성공 시 서버가 `{ ok: true, restartRequired: true }` 반환, 프론트 `opt-restart-banner` 노출(`app.js:3392`, `src/api/settingsRoutes.ts:26`). **이번 변경으로 새로 생긴 동작 아님** — 기존 배너 메커니즘이 `kind` 편집에도 동일 적용될 뿐. 즉 `kind`를 sim↔hucoms로 바꿔 저장해도 실행 중인 서버는 재시작 전까지 이전 `kind`로 계속 동작한다.

## kind='hucoms' 의존 런타임 분기(저장·재시작 후에만 반영)
설정 저장은 `config/tools.config.json`을 갱신할 뿐이며, 아래 런타임 상태는 서버가 재시작되어 새 설정을 다시 로드한 뒤에야 바뀐 `kind`를 반영한다.
- `selectedSourceIsReal()` (`app.js:280-281`): `state.sourceDetails[state.source]?.kind === 'hucoms'`로 실카메라 여부 판정. PTZ 제어 가능 여부(`canMove`, :300), PTZ 상태 로드 필요 여부(:374, :1579-1580, :1597) 등 다수 분기가 이 함수에 의존.
- `state.isHucoms` 대입(`app.js:401`, `:3889`): 소스 상세 로드 시 `kind`로 세팅, 여러 UI 상태에 사용.
- **주의**: 이 분기들은 `/settings` 저장이 아니라 카메라 소스 목록/상세 조회(GET, 서버가 `tools.config.json`을 다시 읽는 시점)를 통해 갱신된다. 따라서 콤보로 `kind`를 바꿔 저장한 직후에는 restartRequired 배너대로 서버 재시작이 필요하며, 재시작 전에는 화면상 카메라 목록·PTZ 제어 등이 이전 `kind` 기준으로 계속 동작한다.

## 한계 / 주의(은닉 없이 명시)
- **protocol 자동 전환 없음(범위 밖)**: `kind`를 sim↔hucoms로 바꿔도 `protocol`(`unity-rpc`/`unity-rest`/`hucoms-v1.22`) 필드는 그대로 유지된다(추측성 자동 전환 로직 미도입 — 설계 단계 의도적 비목표). 예를 들어 사용자가 시뮬레이터 소스를 "리얼카메라"로 전환해 저장하면, `protocol`이 여전히 `unity-*`로 남을 수 있어 `tools.config.json` 상 `kind`와 `protocol`이 불일치하는 상태가 만들어질 수 있다. 이 조합이 실제 카메라 서비스 계층(캡처/스트리밍 라우팅)에서 어떻게 처리되는지는 이번 변경·검증 범위 밖이며, **확인 필요** 항목으로 남긴다.
- **rtspUrl 유지**: 시뮬레이터로 되돌려도 기존에 입력했던 `rtspUrl` 값은 폼·데이터에서 지워지지 않고 유지된다(콤보 change 핸들러가 rtspUrl 필드를 초기화하지 않음). 다만 백엔드는 `kind !== 'hucoms'`이면 이 값을 검증·사용하지 않으므로(§ `settingsFormErrors`/`superRefine` 모두 hucoms 분기에서만 rtspUrl 검사) 저장은 막히지 않는다 — 단지 화면에 남아있는 값이 실제로는 무시된다는 점을 사용자가 인지하기 어려울 수 있다.
- **DOM 상호작용 미검증**: 신규 테스트는 소스 텍스트 정적 단언(저장소 규약, jsdom 미구성)이며, 실제 브라우저에서 select 클릭·키보드 선택 등 상호작용은 검증 대상이 아니다.

## 영향 없음(확인함)
- 백엔드 스키마/라우트(`settingsStore.ts`, `settingsRoutes.ts`) 무변경 — 재실행한 `settingsStore.test.ts`(17)·`settingsRoutes.test.ts`(7)가 그대로 통과해 기존 계약 불변 확인.
- `dbViewSourceSwitch.test.ts`(6)·`viewerDisplayReset.test.ts`(8)·`cameraMode.test.ts`(16) 등 인접 뷰어/설정 테스트 회귀 없음(재실행 확인).

## 테스트 결과(문서화 단계 재실행)
```
✓ test/dbViewSourceSwitch.test.ts  (6 tests)
✓ test/viewerDisplayReset.test.ts  (8 tests)
✓ test/cameraKindSelect.test.ts    (6 tests)  ← 신규
✓ test/settingsFormErrors.test.ts  (12 tests)
✓ test/settingsStore.test.ts       (17 tests)
✓ test/cameraMode.test.ts          (16 tests)
✓ test/settingsRoutes.test.ts      (7 tests)

Test Files  7 passed (7)
     Tests  72 passed (72)
```
QA 보고서(`03_qa_report.md`) 수치(신규6+인접66=72)와 일치.

## 문서 산출물
- 최종 한글 문서: `SettingAgent/docs/20260723_103942_카메라타입_콤보박스_시뮬리얼구분.md`
