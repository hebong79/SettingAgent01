# SettingAgent 뷰어 — 프리셋/카메라 드롭다운 선택 시 Unity 카메라 물리 이동 결선

- 작성일시: 2026-07-01 18:08:12
- 대상 파일: `SettingAgent/web/app.js` (1개 파일, 2줄 추가)
- 설계: `_workspace/01_architect_plan.md` / 구현: `_workspace/02_developer_changes.md`

---

## 1. 문제 증상

웹 뷰어에서 **프리셋 드롭다운(`sel-preset`) 또는 카메라 드롭다운(`sel-cam`)을 바꾸면**, 화면 하단 PTZ 표시값과 슬롯/ROI 오버레이 등 **UI는 새 프리셋 기준으로 갱신되는데, Unity 시뮬레이터 화면(스트림)은 이전 위치 그대로** 머물렀다. 사용자 관점에서 "선택은 바뀌었는데 실제 카메라가 안 움직이는" 불일치가 발생했다.

반면 **방향 버튼 / 절대이동 버튼 / 프리셋 "이동"(`btn-goto`) 버튼**은 정상적으로 Unity가 물리 이동했다. 즉 이동 경로 자체는 살아 있고, **드롭다운 선택만 이동을 유발하지 못하는** 국소적 gap이었다.

## 2. 근본 원인

뷰어에는 두 종류의 카메라 경로가 있다.

| 경로 | 서버 엔드포인트 | Unity 동작 |
|------|----------------|-----------|
| 스트리밍(매 프레임) | `/req_img` (SimulatorSource) | **가상 렌더만** 반환, 물리 이동 없음 |
| 물리 이동 | `/move` → `/viewer/api/move` → `/req_move` | Unity 카메라 **실제 이동** |

- 스트리밍은 `/req_img`로 프레임 이미지만 받아오므로, 아무리 `state.ptz`를 바꿔도 그것만으로는 Unity가 움직이지 않는다. 물리 이동은 오직 `/move`(→`/req_move`) 호출로만 일어난다.
- 드롭다운 change 핸들러는 **표시 동기화 함수만** 호출했다.
  - `sel-preset` change → `syncPtzFromPreset()` (표시값만 갱신)
  - `sel-cam` change → `renderPresetSelect()` (내부에서 `syncPtzFromPreset()` 호출, 역시 표시만)
- 결과적으로 `state.ptz` 표시는 갱신되지만 `/move` 호출이 없어 **물리 이동이 누락**되었다. 이것이 "UI는 갱신, Unity는 정지" 증상의 원인이다.

## 3. 진단 근거 (연결은 정상)

이동 경로 자체가 끊긴 것이 아니라 **결선만 빠졌음**을 다음으로 확인했다.

- `btn-goto`("이동" 버튼)는 동일한 `gotoPreset()`을 호출하며 정상적으로 Unity를 이동시킴 → `gotoPreset`→`move`→`/move` 경로 정상.
- `/req_move` 응답 `success:true`, 웹 프록시 `/viewer/api/move` 응답 `ok:true` → 웹↔서버↔Unity 물리 이동 연결이 살아 있음.
- 서버 라우팅 실측: 웹 `move()`가 `api('/move')`(=`/viewer/api/move`, `routes.ts:112`)로 POST → `SimulatorSource`가 `/req_move`로 전달(`SimulatorSource.ts:6`). 이동 채널 정상.

즉 문제는 서버/네트워크가 아니라 **프런트엔드에서 드롭다운 change 이벤트가 이동 함수를 호출하지 않은 것** 뿐이다.

## 4. 변경 상세 (2줄)

두 change 핸들러 **끝에** `gotoPreset();` 한 줄씩 추가했다. `gotoPreset`은 함수 선언문(`app.js:452`)이라 호이스팅되어 정상 참조된다. 재사용이므로 신규 함수·헬퍼는 없다.

### 4-1. `sel-cam` change 핸들러 (app.js:1135~1142)

```js
$('sel-cam').addEventListener('change', (e) => {
  state.cam = Number(e.target.value);
  state.selectedSlotId = null;
  renderPresetSelect(); // state.preset 을 새 카메라 첫 프리셋으로 확정
  drawRoiOverlay();
  renderSelectionInfo();
  gotoPreset(); // ★추가: 새 카메라 선택 프리셋으로 Unity 물리 이동(비대기)
});
```

- 순서 근거: `renderPresetSelect()`가 먼저 `state.preset`을 새 카메라의 첫 프리셋으로 확정(`renderPresetSelect` 123행)한 **뒤** `gotoPreset()`이 호출되므로, 올바른 프리셋 PTZ로 이동한다.

### 4-2. `sel-preset` change 핸들러 (app.js:1143~1151)

```js
$('sel-preset').addEventListener('change', (e) => {
  state.preset = Number(e.target.value);
  state.selectedSlotId = null;
  syncPtzFromPreset();  // 표시 즉시 갱신(UX, 유지)
  renderSlotList();
  drawRoiOverlay();
  renderSelectionInfo();
  gotoPreset(); // ★추가: 선택 프리셋으로 Unity 물리 이동(비대기, fire-and-forget)
});
```

- `syncPtzFromPreset()`를 남긴 이유: 물리 이동 응답 전에 표시를 즉시 갱신(UX). `gotoPreset()`은 `await`하지 않아(fire-and-forget) 핸들러가 블로킹되지 않고, 이동 성공 시 `move()`가 `state.ptz`를 최종 확정한다.

### 4-3. 무변경 유지 항목

- `renderPresetSelect()` / `syncPtzFromPreset()` : **무변경**. 두 함수는 초기 로드·렌더 동기화 공용이라 물리 이동을 주입하면 초기화 자동 이동/레이스가 발생하므로 순수 표시 함수로 유지.
- `btn-goto`("이동" 버튼, app.js:1155) : **무변경 유지**. 드롭다운 자동 이동과 기능이 겹치지만, 동일 프리셋 재적용/명시적 재이동 수단으로 의도된 중복(무해). 제거하지 않음.
- 스트리밍 `makeUrl` : **무변경**. `move()` 성공 시 `state.ptz` 갱신 후 `loop.tick()`이 호출되어 스트림이 새 PTZ를 따라감(의도된 동작).

### 4-4. 초기 로드 시 물리 이동 정책 (명시적 결정)

- **초기 페이지 로드 시 물리 이동하지 않는다.** 근거: (a) 사용자 상호작용이 아니므로 요구 범위 밖, (b) `loadCameras`→`renderPresetSelect`는 페이지 로드 시 자동 실행되므로 여기에 이동을 넣으면 페이지를 열자마자 Unity가 움직이는 부작용 + `loadSources`/`loadCameras` 비동기 초기화와의 레이스가 생긴다.
- 따라서 물리 이동은 오직 `sel-preset`/`sel-cam`의 **change 핸들러(사용자 상호작용)** 에만 결선한다.

## 5. 동작 흐름 (드롭다운 선택 시)

```
사용자가 드롭다운 선택
  → state.cam / state.preset 갱신
  → syncPtzFromPreset()(또는 renderPresetSelect) : 표시값 즉시 동기화
  → 슬롯/ROI/선택정보 렌더
  → gotoPreset()                       ← ★신규 결선
      → findPresetPtz()로 프리셋 PTZ 조회
      → (PTZ 있음) move(ptz)
            → POST /move (=/viewer/api/move)
            → 서버 → /req_move → Unity 카메라 물리 이동
            → res.ok 시 state.ptz 확정 + loop.tick()(스트림 새 위치 반영)
      → (PTZ 없음: 일부 실카메라) preset 모드 스냅샷 폴백(gotoPreset 내부 기존 로직)
```

`gotoPreset()`은 비대기 호출이라 이동 실패(타임아웃/무응답) 시에도 핸들러의 표시 렌더는 완료되며, 표시는 `syncPtzFromPreset()`가 세팅한 프리셋 값을 유지한다. 프리셋 PTZ가 없는 소스는 `gotoPreset` 내부 폴백(preset 모드 스냅샷)이 처리하므로 추가 코드가 없다.

## 6. 검증 결과 (사실 그대로)

| 항목 | 방법 | 결과 |
|------|------|------|
| 문법 | `node --check web/app.js` | 통과(SYNTAX_OK) |
| 회귀 | 전체 vitest 스위트 | **426/426 통과** (회귀 없음) |
| 신규 유닛 테스트 | — | **없음.** 변경은 DOM 이벤트 결선(`gotoPreset`/`move`는 DOM·fetch 의존)이라 신규 순수 로직이 없어 유닛 대상 아님 |
| 결선 확인 | 서빙 `app.js` 내 `gotoPreset` 참조 수 | **3회** = 버튼 1(1155) + 신규 2(1141·1150) |

- 위 자동 검증은 **회귀 없음**과 **결선 존재**를 확인한 것이며, **실제 Unity 물리 이동은 자동 검증 대상이 아니다(수동 확인 항목).**

## 7. 수동 동작확인 체크리스트 (실 Unity 필요)

- [ ] 카메라 A·프리셋 P1 상태에서 `sel-preset`을 P2로 변경 → **Unity 카메라가 P2 위치로 물리 이동**, 스트림이 P2 뷰로 갱신.
- [ ] `sel-cam`을 B로 변경 → **B의 첫 프리셋 위치로 Unity 물리 이동**.
- [ ] 페이지 **최초 로드 시 Unity가 자동 이동하지 않음**(정책 4-4 확인).
- [ ] "이동" 버튼(`btn-goto`) 여전히 정상 동작(중복이지만 정상).
- [ ] 방향/절대이동 버튼 무변경 정상 동작.
- [ ] (프리셋 PTZ 부재 소스가 있으면) preset 모드 스냅샷 폴백 정상.
