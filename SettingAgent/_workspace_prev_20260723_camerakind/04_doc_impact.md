# 04 — 영향도 분석 (표시 초기화 전체박스삭제 + DB 재체크 시 재표시)

작성: 2026-07-23 00:21:20

**주의**: 이 워크스페이스의 `01_*`(설계) 산출물은 없고, `02_developer_changes.md`·`03_qa_report.md`는 **이번 건이 아니라 직전 작업("정밀수집 시작 파이프라인")의 잔여 산출물**이다. 이번 표시 초기화/DB 재표시 건은 리더가 계획·구현·검증을 직접 수행했으며, 본 문서는 실제 diff(`git diff`)와 현재 코드를 근거로 documenter 가 사후 재구성했다.

최종 문서: `SettingAgent/docs/20260723_002120_표시초기화_전체박스삭제_DB재표시.md`

---

## 1. 변경 파일

| 파일 | 변경 |
|------|------|
| `SettingAgent/web/app.js` | `resetOverlayDisplay()`에 `state.discoverByKey = {}` 및 `$('roi-db').checked = false` 추가(+JSDoc 예외 명시). `#roi-db` change 핸들러를 "미로드 시 1회 로드" → "체크할 때마다 재조회"로 단순화 |
| `SettingAgent/web/index.html` | `#roi-db`·`#roi-clear` 툴팁을 실제 동작에 맞게 갱신 |
| `SettingAgent/test/viewerDisplayReset.test.ts` | `discoverByKey` 삭제 가드, `#roi-db` 해제+`parkingSlotsByKey` 보존 가드 신설. "`.checked = false` 전면 금지" 단언을 표시 토글 id 목록 기반으로 정밀화 |
| `SettingAgent/test/dbViewSourceSwitch.test.ts` | "항상 재조회" 규약 가드로 갱신, discovery quad 초기화 가드 추가 |

서버·DB·REST 계약·ActionAgent/DMAgent·`@parkagent/types`에는 변경 없음(순수 프런트엔드 상태·이벤트 핸들러 수정).

---

## 2. 기존 호출처별 회귀 검토

### 2.1 `resetSlotSetupDb()` (`app.js:2485~2495`) — DB 검출·점유·PTZ 초기화 버튼

```js
async function resetSlotSetupDb() {
  ...
  resetOverlayDisplay();           // ← 이번 변경으로 #roi-db 를 강제 unchecked 로 만듦
  await loadParkingSlots();        // DB 재조회 → null 반영(parkingSlotsByKey 갱신)
  drawRoiOverlay();
  renderSlotList();
  ...
}
```

`resetOverlayDisplay()`가 먼저 실행되어 `#roi-db.checked = false`가 된다. 이어서 `loadParkingSlots()`가 호출돼 `state.parkingSlotsByKey`는 최신(대부분 null) 값으로 갱신되지만, `drawRoiOverlay()` 시점엔 `#roi-db`가 이미 꺼져 있으므로 DB 소스 렌더 분기 자체를 타지 않는다.

- **적절성 판단**: `resetSlotSetupDb`는 DB 값을 실제로 null 로 되돌리는 파괴적 작업이라, 초기화 직후 `#roi-db`가 켜진 채 남아 있어도 어차피 그릴 데이터가 없다(`row.vpd`/`row.lpd`/`row.occupyRange` 전부 null → 각 draw 함수가 skip). 따라서 표시 결과 차이는 사실상 없다.
- **부수효과**: 사용자가 초기화 실행 **전**에 `#roi-db`를 켜 두었다면, 초기화 **후** 체크박스가 화면에서 꺼진 채로 남는다(데이터 없음과는 별개로 UI 상태가 바뀜). 이전에는 `resetOverlayDisplay`가 `#roi-db`를 건드리지 않았으므로 체크 상태가 유지됐다 — 이번 변경으로 새로 생긴 부수효과이며, 결함이라기보다 "표시 초기화가 DB 게이트도 끈다"는 이번 요구의 자연스러운 파급으로 판단된다. 확인 필요: 마스터가 이 부수효과(초기화 버튼 두 개가 `#roi-db` 체크 상태에 서로 다르게 개입)를 의도로 받아들이는지는 명시적으로 확인되지 않았다.

### 2.2 `loadRoiToDb()` (`app.js:2498~2519`) — ROI 파일 → DB 전량 재구성 버튼

```js
async function loadRoiToDb() {
  ...
  resetOverlayDisplay();           // ← #roi-db 강제 unchecked
  await loadCameras();
  ...
  await loadParkingSlots();        // DB 재조회 → 새 slot_setup 반영(parkingSlotsByKey 갱신)
  drawRoiOverlay();
  renderSlotList();
  ...
}
```

2.1과 동일 구조이나 차이점 하나: `loadRoiToDb`는 새 `slot_setup`(바닥 ROI 기반 재구성 결과)을 만든다. "검출·점유·센터링은 초기값"(주석)이므로 이 시점의 `vpd`/`lpd`/`occupyRange`도 대부분 null 일 가능성이 높지만, **바닥 ROI 자체가 바뀌는 재구성**이라는 점에서 2.1보다 "사용자가 결과를 즉시 보고 싶어할 개연성"이 크다. `#roi-db`가 꺼진 채 남으므로, 로딩 완료 메시지(슬롯/카메라/프리셋 건수)는 뜨지만 DB 오버레이는 사용자가 `#roi-db`를 다시 체크해야 보인다. 확인 필요: 이 버튼의 완료 흐름에서 DB 오버레이 자동 표시가 기대되는지(과거엔 `#roi-db`가 이미 켜져 있었을 경우에만 그대로 보였음 — 이번 변경으로 그 경로도 사라짐).

### 2.3 `capFinalize()` (`app.js:2470~2482`) — 정밀수집 결과 표시 버튼

```js
async function capFinalize() {
  $('roi-db').checked = true; // 프로그래밍 방식 대입 — change 이벤트 미발화
  state.roiHidden = false;
  await loadParkingSlots();   // 명시적으로 별도 호출
  ...
}
```

`capFinalize`는 `resetOverlayDisplay()`를 호출하지 않는다. `$('roi-db').checked = true`는 DOM 프로퍼티 직접 대입이며, `dispatchEvent`를 쓰지 않으므로 `change` 리스너(§ app.js:3902~3905, "켤 때마다 재조회")가 발화하지 않는다. 따라서 `loadParkingSlots()`는 `capFinalize` 함수 본문의 명시적 호출 한 번만 실행되고, change 핸들러발 추가 호출은 없다 — **이중 조회 없음**. 이번 변경(§3.2 재조회 단순화)이 `capFinalize` 경로에 새로운 부담을 주지 않음을 확인했다.

### 2.4 `renderSlotList()` 의 `finalized` 판정 (`app.js:1127`)

```js
const finalized = !!(state.parkingSlotsByKey && Object.keys(state.parkingSlotsByKey).length);
```

`resetOverlayDisplay()`는 `state.parkingSlotsByKey`를 대입/삭제하지 않는다(이번 변경도 이 필드는 손대지 않음 — `#roi-db.checked`만 끔). 따라서 `표시 초기화` 버튼을 눌러도 `finalized` 판정과 좌측 주차면 목록 패널은 그대로 유지된다. 이는 설계 의도대로다(메모리 `finalize slot_setup wipe fragility` — `parkingSlotsByKey` 삭제는 금지 사항).

### 2.5 `#roi-db`를 켤 때마다 재조회 — 비용

```js
$('roi-db').addEventListener('change', async (e) => {
  if (e.target.checked) await loadParkingSlots();
  drawRoiOverlay();
});
```

종전에는 `state.parkingSlotsByKey`가 이미 있으면 재조회를 생략했다. 이번 변경으로 체크할 때마다(캐시 유무 무관) `GET /capture/slots` 왕복이 1회 발생한다. 슬롯 수십 건 규모의 SQLite 조회이므로 개별 비용은 경미하나, 사용자가 `#roi-db`를 반복 토글하면(예: 켰다 끄고 다시 켜는 습관) 그때마다 서버 요청이 늘어난다. 성능 문제로 보고된 바는 없으며, "최신 DB 반영"이라는 이번 요구(요구2)를 만족하기 위한 의도된 트레이드오프다.

---

## 3. 남은 확인 필요 항목

1. §2.1·§2.2에서 지적한 부수효과 — `resetSlotSetupDb`/`loadRoiToDb` 실행 후 `#roi-db`가 항상 꺼지는 것이 두 버튼 모두에 걸쳐 마스터의 기대와 일치하는지 명시적으로 확인되지 않았다.
2. 육안(브라우저 클릭) 검증이 수행되지 않아, "버튼을 눌렀을 때 실제 화면에서 박스가 전부 사라지는지"는 소스 텍스트 회귀 가드(유닛테스트)로만 담보된 상태다 — 최종 문서 §6.1 참조.
