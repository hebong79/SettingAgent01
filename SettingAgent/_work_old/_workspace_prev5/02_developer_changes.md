# 02 구현 변경 요약 — 드롭다운 선택 시 Unity 카메라 물리 이동

## 변경 파일
- `SettingAgent/web/app.js` (1개 파일, 2개 change 핸들러에 각 1줄 추가 + 인접 주석 보강)

## 정확한 변경 위치

### 1) `sel-cam` change 핸들러 (현행 1135~1141 → 수정 후 1135~1142)
- 핸들러 **끝**에 `gotoPreset();` 추가.
- 순서: `renderPresetSelect()`(1138) 실행으로 `state.preset`이 새 카메라 첫 프리셋(#renderPresetSelect 123행: `state.preset = presets[0].presetIdx`)으로 확정된 **뒤** `gotoPreset()` 호출 → 올바른 프리셋으로 이동. 설계 2-2와 일치.
- `renderPresetSelect()` 줄 끝 주석에 "state.preset 을 새 카메라 첫 프리셋으로 확정" 명시(순서 근거 표기).

```js
$('sel-cam').addEventListener('change', (e) => {
  state.cam = Number(e.target.value);
  state.selectedSlotId = null;
  renderPresetSelect(); // state.preset 을 새 카메라 첫 프리셋으로 확정
  drawRoiOverlay();
  renderSelectionInfo();
  gotoPreset(); // 카메라 전환 시 새 카메라 선택 프리셋으로 Unity 물리 이동(비대기)
});
```

### 2) `sel-preset` change 핸들러 (현행 1142~1149 → 수정 후 1143~1151)
- 핸들러 **끝**에 `gotoPreset();` 추가.
- 순서: `syncPtzFromPreset()`가 표시를 즉시 갱신(UX)한 뒤 `gotoPreset()`이 물리 이동. `gotoPreset`은 비대기(fire-and-forget)이므로 핸들러 블로킹 없음. 설계 2-1과 일치.

```js
$('sel-preset').addEventListener('change', (e) => {
  state.preset = Number(e.target.value);
  state.selectedSlotId = null;
  syncPtzFromPreset();
  renderSlotList();
  drawRoiOverlay();
  renderSelectionInfo();
  gotoPreset(); // 선택 프리셋으로 Unity 물리 이동(비대기, fire-and-forget)
});
```

## 핸들러 순서 확인 결과
- `gotoPreset`은 **함수 선언문**(app.js:452 `async function gotoPreset()`)으로 호이스팅되어, 두 change 핸들러(1135·1142)에서 정상 참조 가능. 참조 오류 없음.
- `sel-cam` 경로: `renderPresetSelect()`(111) → 내부 123행에서 `state.preset` 확정 → 그 뒤 `gotoPreset()` 호출. 확정→이동 순서 보장 확인.
- `renderPresetSelect()`(111) / `syncPtzFromPreset()`(131) **무변경**. 초기 로드(`loadCameras` 108→`renderPresetSelect` 호출) 경로에는 물리 이동 미주입 → 페이지 로드 시 자동 이동/레이스 없음(설계 정책 3 준수).

## 설계 대비 편차
- **없음(로직).** 설계 2-1/2-2에 명시된 2줄(`gotoPreset();`) 그대로 추가.
- 인접 주석 보강 2건: (a) `sel-cam`의 `renderPresetSelect()` 줄에 순서 근거 주석, (b) 각 `gotoPreset()` 줄에 의도 주석. 로직 무변경, 설계 코드 블록의 인라인 주석과 동일 취지.
- `btn-goto`(1153) 무변경 유지 — 설계 5의 "의도된 중복" 정책 준수.

## 검증
- `node --check web/app.js` → **SYNTAX_OK** (통과).
- 신규 순수 로직 없음(설계 6-1) → 유닛 테스트 신규 대상 아님. 기존 core 테스트 회귀 확인은 qa-tester 담당.

## 영향도(요약)
- `core.js`/`core.d.ts`/서버 라우트/스트리밍 `makeUrl`/기존 버튼(방향·절대·goto) **무변경**.
- 물리 이동은 change 핸들러(사용자 상호작용)에만 결선. 초기 자동 로드 시 물리 이동 없음.
