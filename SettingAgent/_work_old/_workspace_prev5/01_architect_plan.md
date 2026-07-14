# 01 설계서 — 웹 조작 시 Unity 시뮬레이터 카메라 물리 이동 결선

## 0. 목표(검증 가능)
웹 뷰어에서 **프리셋 드롭다운 변경 / 카메라 드롭다운 변경** 시, 선택된 프리셋 PTZ 로 Unity 카메라가 **물리적으로 이동**(`/move`→`/req_move`)한다. 기존 방향/절대/이동 버튼의 동작은 무변경.

## 1. 문제 요약(확정)
- `/req_img`(스트리밍 매 프레임)는 가상 렌더만 반환, 물리 이동 안 함. 물리 이동은 `/move`(→`/req_move`) 뿐.
- 물리 이동 O 경로: 방향버튼(app.js:1163), 절대이동(btn-abs:1170), 프리셋 "이동"(btn-goto→`gotoPreset`:1153).
- **gap**: `sel-preset` change(1142)와 카메라 전환은 `syncPtzFromPreset()`(131)만 호출 → `state.ptz` 표시만 갱신, 물리 이동 없음.
- 카메라 전환 경로 실측: `sel-cam` change(1135)는 `renderPresetSelect()`(111) 호출 → 내부에서 `syncPtzFromPreset()`(126) 호출. `renderPresetSelect`는 **초기 로드**(`loadCameras`:108)에서도 호출됨. → 카메라/초기화 모두 이 함수를 공유하므로, 이 함수에 물리이동을 넣으면 초기화 레이스 발생. **넣지 않는다.**

## 2. 수정 지점(핸들러별) — 표시 동기화와 물리 이동 분리

### 2-1. `sel-preset` change 핸들러 (app.js:1142~1149)
- 현행: `state.preset` 갱신 → `syncPtzFromPreset()`(표시) → 슬롯/ROI/선택정보 렌더.
- 수정: 표시 동기화는 유지하고, 끝에 **물리 이동 호출 추가**. `gotoPreset()` 재사용(이미 `state.preset` 기준으로 프리셋 PTZ 물리 이동 + 폴백 보유).
  ```js
  $('sel-preset').addEventListener('change', (e) => {
    state.preset = Number(e.target.value);
    state.selectedSlotId = null;
    syncPtzFromPreset();      // 표시 즉시 동기화(레이스 무관, 유지)
    renderSlotList();
    drawRoiOverlay();
    renderSelectionInfo();
    gotoPreset();             // 추가: 선택 프리셋으로 Unity 물리 이동(비대기, fire-and-forget)
  });
  ```
- `syncPtzFromPreset()`를 남겨두는 이유: 물리 이동 응답 전에 표시를 즉시 갱신(UX). `gotoPreset`은 `await` 하지 않음(핸들러 블로킹 회피). 이동 성공 시 `move()`가 `state.ptz`를 재확정.

### 2-2. `sel-cam` change 핸들러 (app.js:1135~1141)
- 현행: `state.cam` 갱신 → `renderPresetSelect()`(내부 `syncPtzFromPreset` 포함) → ROI/선택정보 렌더.
- 수정: 핸들러 **끝에** `gotoPreset()` 추가. `renderPresetSelect()`가 먼저 `state.preset`을 새 카메라의 첫 프리셋으로 확정(123)하므로, 그 뒤 `gotoPreset()`은 올바른 프리셋으로 이동.
  ```js
  $('sel-cam').addEventListener('change', (e) => {
    state.cam = Number(e.target.value);
    state.selectedSlotId = null;
    renderPresetSelect();     // state.preset 을 새 카메라 첫 프리셋으로 확정
    drawRoiOverlay();
    renderSelectionInfo();
    gotoPreset();             // 추가: 새 카메라의 선택 프리셋으로 물리 이동
  });
  ```

### 2-3. `renderPresetSelect()` / `syncPtzFromPreset()` — **무변경**
- 두 함수는 초기 로드·렌더 동기화 공용. 물리 이동을 넣지 않는다(초기화 자동 이동/레이스 방지). 순수 표시 동기화로 유지.

## 3. 초기 자동 로드 시 물리 이동 정책 (명시적 결정)
- **정책: 초기 로드 시 물리 이동하지 않는다.**
  - 근거: (a) 사용자 상호작용이 아님 → 요구사항("웹에서 조작할 때")의 범위 밖. (b) `loadCameras`→`renderPresetSelect`는 페이지 로드 시 자동 실행 → 여기에 이동을 넣으면 페이지 열자마자 Unity가 움직이는 부작용 + 여러 비동기 초기화(loadSources/loadCameras)와의 레이스.
  - 결과: 물리 이동은 오직 `sel-preset`/`sel-cam`의 **change 핸들러**(사용자 상호작용)에만 결선. 초기 상태의 실제 Unity 위치가 필요하면 사용자가 프리셋을 (재)선택하거나 "이동" 버튼을 누르면 됨.

## 4. 이동 실패 / 프리셋 PTZ 부재 폴백
- **프리셋 PTZ 존재 시**: `gotoPreset()`→`move(ptz)`. `move()`는 `res.ok`일 때만 `state.ptz` 갱신 → 실패(타임아웃/카메라 무응답) 시 표시는 `syncPtzFromPreset()`가 이미 세팅한 프리셋 값 유지(치명적 UX 저하 없음). 별도 처리 불필요.
- **프리셋 PTZ 부재 시**(실카메라 등 pan/tilt/zoom null): `gotoPreset()` 내부 폴백이 이미 `mode:'preset'` 스냅샷으로 강등 처리(452~479). 재사용으로 충족 → **추가 코드 없음.**
- fire-and-forget(`gotoPreset()` 비대기)이므로 실패해도 핸들러의 표시 렌더는 완료됨. 실패 토스트 등 추가 UX는 요구 범위 밖 → 넣지 않음(단순함 우선).

## 5. btn-goto("이동") 관계 (제거 금지 — 명시)
- `btn-goto`(1153)는 `gotoPreset`을 그대로 호출. 이번 결선으로 **드롭다운 선택 시 자동 이동**이 추가되면 "이동" 버튼과 기능 중복.
- **의도된 중복이며 무해**: (a) 자동 이동은 사용자가 선택 즉시 원하는 동작, (b) "이동" 버튼은 동일 프리셋 재적용/명시적 재이동 수단으로 유지. **제거하지 않는다.**

## 6. 검증 항목

### 6-1. 유닛(vitest) — 순수 로직만
- 신규 순수 로직 **없음**. `gotoPreset`/`move`는 DOM·fetch 의존 → 유닛 대상 아님.
- `findPresetPtz`(core.js:161)는 이미 테스트 존재 여부 확인 후, 미보유면 최소 케이스만 보강 검토(선택→이동 대상 PTZ 산출의 근거값). **신규 헬퍼 도입 불필요**(기존 `gotoPreset`/`findPresetPtz` 재사용으로 충분 → core.js 변경 없음이 1차안).
- 결론: **app.js DOM 결선 위주 → 유닛 신규 거의 없음.** qa-tester는 기존 core 테스트 회귀만 확인.

### 6-2. 수동 확인 (실 Unity)
1. 카메라 A, 프리셋 P1 선택 상태에서 `sel-preset`을 P2로 변경 → Unity 카메라가 P2 위치로 물리 이동, 스트림이 P2 뷰로 갱신.
2. `sel-cam`을 B로 변경 → B의 첫 프리셋 위치로 Unity 물리 이동.
3. 페이지 최초 로드 시 Unity가 **자동 이동하지 않음**(정책 3 확인).
4. "이동" 버튼(btn-goto) 여전히 동작(중복이지만 정상).
5. 방향/절대이동 버튼 무변경 동작.
6. (실카메라·프리셋 PTZ 부재 소스가 있으면) 폴백 스냅샷 경로 확인.

## 7. 영향도
- **파일**: `SettingAgent/web/app.js`만 수정(2개 change 핸들러 각 1줄 `gotoPreset();` 추가). `core.js`/`core.d.ts`/서버 라우트/`ParkSimMgr`/캡처 파이프라인 **무변경**.
- **스트리밍(makeUrl 405)**: 무변경. `move()`가 성공 시 `state.ptz`를 갱신하고 `loop.tick()` 호출 → 스트림은 기존대로 `state.ptz` 기준. 자동 이동 후 스트림이 새 PTZ로 따라감(부작용 아닌 의도).
- **기존 버튼(방향/절대/goto)**: 코드 무변경, 동작 동일.
- **MCP 경계**: 해당 없음. 순수 프런트엔드 DOM 결선(웹→기존 `/move` REST 재사용). 결정형 도구/LLM 두뇌 신설 없음.
- **레이스**: 초기화 경로(`renderPresetSelect`)에 이동 미주입 → 페이지 로드 레이스 없음. change 핸들러는 사용자 이벤트라 순차적.

## 8. 미해결/가정
- 가정: `gotoPreset()` fire-and-forget 채택(핸들러 UI 블로킹 회피). 만약 "이동 완료까지 드롭다운 잠금" UX를 원하면 `await`+비활성화 필요 → 요구 범위 밖으로 판단, 미적용. **다르게 원하면 리더 확인 요청.**
- 가정: 초기 로드 시 물리 이동 안 함(정책 3). 만약 "페이지 로드 시 실제 카메라를 첫 프리셋에 맞춰야 한다"면 별도 요구로 재설계 필요 → 확인 요청.
