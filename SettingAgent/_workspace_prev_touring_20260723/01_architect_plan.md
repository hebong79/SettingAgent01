# 설계: 카메라 타입 콤보박스(시뮬레이터/리얼카메라)

## 목표(관찰 가능)
카메라 실행 설정의 "카메라 타입" 필드를 readonly 텍스트에서 **콤보박스**로 바꿔, 사용자가 카메라를 **시뮬레이터 / 리얼카메라** 2분류로 선택·저장할 수 있다. 선택 시 RTSP 입력 활성/비활성·안내문(note)이 즉시 반영된다.

## 근거(기존 구조)
- 데이터 모델 `kind: 'sim' | 'hucoms'` (SettingAgent/src/config/settingsStore.ts:94).
- 백엔드는 이미 kind 편집을 완전 지원: `SettingsPatchSchema` 화이트리스트에 `kind` 포함·`required`, superRefine 은 hucoms+rtspUrl 만 검증(settingsStore.ts:32-79). writeEditableSettings 병합 키에 kind 포함(:212).
- 프론트는 kind 를 **표시만** 하고 편집 경로가 없었음: renderCameraSource(app.js:3283)가 텍스트로 표시, cameraSettingsPatch(:3326)는 로드된 kind 를 그대로 되돌려보냄.
- 프론트 사전검증 settingsFormErrors(core.js:197-206)는 이미 kind='hucoms' 분기 처리.

## 매핑
- 시뮬레이터 → `kind: 'sim'`
- 리얼카메라 → `kind: 'hucoms'`

## 변경 범위(외과적)
1. **index.html**: `<input id="opt-camera-kind" readonly>` → `<select id="opt-camera-kind">` (option sim=시뮬레이터, hucoms=리얼카메라).
2. **app.js renderCameraSource**: `select.value = source.kind`('hucoms' 아니면 'sim').
3. **app.js captureCameraSourceEdits**: `source.kind = select.value`.
4. **app.js 이벤트 결선**: `#opt-camera-kind` change → capture 후 재렌더(RTSP 활성·note 동기화).

## 비목표(범위 밖)
- protocol 자동 전환: kind 변경 시 protocol(`unity-*`/`hucoms-v1.22`)은 그대로 둔다(백엔드 optional·미검증, 추측성 로직 금지). 영향도 문서에 한계로 명시.
- 백엔드/스키마 변경 없음(이미 지원).

## 성공 확인
- vitest(정적 소스 단언 규약): select·옵션·렌더·capture·change 결선·patch 포함.
- 인접 설정 테스트 회귀 없음.
