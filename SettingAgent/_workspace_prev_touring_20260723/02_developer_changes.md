# 구현: 카메라 타입 콤보박스

## 변경 파일
### SettingAgent/web/index.html (line ~380)
readonly 텍스트 input → select 콤보박스.
```html
<label class="settings-field">카메라 타입
  <select id="opt-camera-kind">
    <option value="sim">시뮬레이터</option>
    <option value="hucoms">리얼카메라</option>
  </select>
</label>
```

### SettingAgent/web/app.js
- `renderCameraSource` (~3283): 표시 텍스트 대입 제거, kind 값을 select value 로 세팅.
  ```js
  $('opt-camera-kind').value = source?.kind === 'hucoms' ? 'hucoms' : 'sim';
  ```
- `captureCameraSourceEdits` (~3272): 콤보 선택을 source.kind 로 확정.
  ```js
  source.kind = $('opt-camera-kind').value === 'hucoms' ? 'hucoms' : 'sim';
  ```
- setupEventListeners 내 (~3850): change 리스너 추가.
  ```js
  $('opt-camera-kind').addEventListener('change', () => {
    captureCameraSourceEdits();
    renderCameraSource(renderedCameraSourceId);
  });
  ```

## 흐름
로드(loadCameraSettings→renderCameraSource) 시 kind→콤보 반영 → 사용자 전환 시 capture(source.kind 갱신)+재렌더(RTSP disabled·note) → 저장 시 cameraSettingsPatch 가 `kind: source.kind` 를 PUT /settings 로 전송 → settingsStore 가 tools.config.json cameraSources[].kind 병합.

## 백엔드 무변경
SettingsPatchSchema·writeEditableSettings 가 이미 kind 편집 지원(설계 근거 참조). 서버 코드 변경 없음.

## 후속 반영: protocol 자동 정합(2026-07-23 마스터 "진행해줘")
초기 한계 #1(kind↔protocol 불일치)을 해소. 근거: sourceRegistry.ts:47-59 — 런타임 소스 선택이 sim+unity-rpc→RPC, sim+그외→REST, hucoms→RealPtz(protocol 무시)라 hucoms→sim 전환 시 protocol='hucoms-v1.22'가 남으면 REST 경로로 잘못 빠진다.

- **core.js 신규 순수함수** `alignProtocolToKind(kind, protocol)`:
  - hucoms → 'hucoms-v1.22'(유일)
  - sim → unity 계열이면 유지(RPC/REST 보존), 아니면 'unity-rpc'
  - 멱등: sim+unity 계열은 무변경 → 실제 kind 전환 때만 바뀐다.
- **app.js**: core.js import 에 `alignProtocolToKind` 추가, captureCameraSourceEdits 에서 `source.kind` 확정 직후 `source.protocol = alignProtocolToKind(source.kind, source.protocol)`.
- cameraSettingsPatch 는 이미 `protocol: source.protocol` 전송 → 정합 결과가 tools.config.json 에 반영.
- 백엔드 무변경(protocol enum·병합 키 기존 지원).
