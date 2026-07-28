# 04 영향도 분석 — 그리기 렌더 결함 수정 + ROI 초기화/전체삭제

작성: 2026-07-28 14:08 / 문서화(documenter)
최종 문서: `SettingAgent/docs/20260728_140851_그리기렌더수정_ROI초기화_전체삭제.md`

---

## 1. 변경/신규 파일과 파급

| 파일 | 구분 | 파급 대상 |
|---|---|---|
| `web/app.js` | 수정(범위 큼) | 렌더 결함 수정(3점 닫힘 예고) · `ensureFloorVisible` 신규+4곳 배선 · 초기화/전체삭제/되돌리기 함수 신규 · `state.placeRoiUndo` 필드 · `renderPlaceSelectionInfo` disabled 동기화 · `savePlaceRoi` 스냅샷 소진 1줄 · `wire()` 결선. 아래 §2 참조 |
| `web/index.html` | 수정(가산) | `.roi-edit-bar` 2행 분리 + 버튼 3개(`place-clear`·`place-clear-preset`·`place-undo`) 추가. 기존 id·속성·순서 무변경 → 기존 결선·CSS 셀렉터 영향 없음 |
| `web/placeDraw.js` | 수정 | `clearPresetSpaces` 신규(순수함수). `core.js`의 `removePlaceSpace`를 **호출만** 함 — `core.js` 자체는 무수정 |
| `web/placeDraw.d.ts` | 수정 | `clearPresetSpaces` 타입 선언 추가. `tsc --noEmit` 0에러 유지 확인됨 |
| `test/placeDraw.test.ts` | 수정 | `clearPresetSpaces` 순수 테스트(랜덤 500케이스 포함) 추가 — 테스트 전용, 런타임 영향 없음 |
| `test/placeDrawWiring.test.ts` | 수정 | S1~S4 렌더/순서/결선 소스텍스트 봉인 describe 추가(+19건) — 테스트 전용 |

### 무변경 확인(보호 파일) — `git diff --numstat` 재확인 결과
```
groundModel.ts · project.ts · ground/types.ts · floorRoi.ts · web/core.js ·
Finalizer.ts · SqliteStore.ts · roiDbLoad.ts
```
문서화 시점 재확인 결과, `web/core.js`·`project.ts`·`ground/types.ts`·`floorRoi.ts`·`Finalizer.ts`·`SqliteStore.ts`·`roiDbLoad.ts` **7개는 이번 라운드 완전 무변경**이다. `groundModel.ts`는 `git status`상 diff가 있으나 리더·검증자가 mtime(11:36, 이번 라운드 편집창 13:35~13:44보다 이전)으로 **이전 라운드(지면격자) 산물임을 이미 확인**한 것을 재인용한다 — 이번 라운드가 만든 변경이 아니다. `web/app.css`도 이번 라운드 무변경(diff는 직전 그리기 도구 라운드 누적분).

서버(`src/**`)는 이번 라운드 **완전 무변경**이다.

---

## 2. 기존 기능 영향

### 2-1. 캔버스 렌더/편집 (그리기 오프 상태)
- 검증자가 배포 원문 `drawPlaceDrawOverlay`를 직접 실행해 그리기 off 3케이스(정점편집 on/off, 선택 유무 조합) 전부 **발행 캔버스 명령 0건**을 확인 — 회귀 0이 구조가 아니라 실행으로 증명됐다.
- 1점·2점·2점+커서 렌더 시퀀스는 baseline과 **바이트 단위 동일**(추가된 것은 3점 단계 점선 하나뿐).

### 2-2. `#roi-floor` 토글 — 부수효과 고지
`ensureFloorVisible()`은 사용자 명시 조작(그리기 시작/커밋/정점편집 ON/목록 선택) 직후에만 호출되며, 자동 폴링·렌더 루프(`drawRoiOverlay`·`drawFileFloorRoi`·`loadPlaceRoi`)에는 존재하지 않음을 테스트로 봉인했다. 이 토글을 켜면 **artifact 슬롯의 floor 히트테스트(`layers.floor`)도 함께 켜지는 부수효과**가 있으나, 이는 `#roi-floor` 기본값(checked, `index.html` 초기 상태)과 동일한 동작으로 되돌리는 것뿐이라 신규 동작이 아니다.

### 2-3. `#slot-list` 목록 UI
`renderSlotList` 자체는 이번 라운드 변경 0(직전 라운드 D-2 병기 분기 유지, 봉인 테스트 green). 다만 `#place-clear-preset` disabled 동기화를 카메라 전환(`sel-cam`) 경로에는 넣지 않았다 — 이유는 그 경로가 기존부터 `renderSlotList()`를 호출하지 않아, 넣었다면 카메라 전환 후 버튼이 "잘못 잠긴 채 굳는" 새 무반응 결함이 생기기 때문(검증자가 코드로 확인·승인). 대신 버튼은 항상 활성으로 두고 클릭 시점에 빈 프리셋 안내로 방어한다 — 파괴는 `confirm` 이후에만 일어나 안전성 손실은 없다.

### 2-4. `PUT /capture/place-roi` 및 파일(`PtzCamRoi.json`)
- 초기화·전체삭제·되돌리기 세 함수 모두 `fetch` 0줄 — **파일 접촉 없음**을 코드 확인 + `PtzCamRoi.json` mtime(변경 전 상태 유지)으로 재확인했다.
- 전체삭제가 저장 시 만드는 "빈 배열 PUT"은 **기존 서버 스키마가 이미 허용**하는 입력이라 서버측 계약 변경이 없다(`PlaceRoiPutSchema.spaces`는 min 없는 배열). `applyPlaceRoiUpdateEx`가 대상 프리셋을 통째 교체하는 기존 동작 그대로다.
- 전체삭제는 **다른 프리셋의 전역 idx도 이동시킨다**(`removePlaceSpace` 전역 재압축 특성 — 기존 '삭제' 버튼과 동일 성질, 새 위험 등급이 아님). 저장 후 `slot_ptz.json`·DB(`slot_setup`)·artifact `globalIndex`와의 정합은 기존 'ROI 파일 로딩'(runLoadRoiToDb) 재구성 절차로 수렴해야 한다 — 확인문에 명시했고, 신규 절차를 만들지는 않았다.
- 전체삭제로 어느 프리셋이 파일상 면 0개가 되면, 다음 로드 시 `placeRoiFileKeys`에서 빠져 `needsPlaceSkeleton=true`가 된다 — 그 프리셋에 다시 그려 저장하려면 **라이브 프레임이 먼저 필요**하다(기존 신규 주차장 경로와 동일 조건, 실패 메시지도 기존 것 재사용).

### 2-5. 전역 idx 의존 (`slot_ptz.json`·센터링·artifact `globalIndex`)
`clearPresetSpaces`는 기존 `removePlaceSpace`(전역 재압축)를 그대로 위임하므로 idx 계약을 새로 만들지 않는다. 랜덤 500케이스 검증으로 결과가 항상 1..N 순열임을 확인했다. 다만 전체삭제 후 idx가 이동한 신규 상태에 대해 센터링·`slot_ptz.json` 갱신은 **이번 작업 범위 밖**(기존 절차로 별도 필요) — §2-4와 동일한 한계다.

### 2-6. `state.placeRoiBackup`(자동보정 전용)
신규 `state.placeRoiUndo`와 **완전히 분리**되어 있다(교차 참조 0, 버튼 id 별개 `#place-undo`/`#align-undo`, 소진 지점도 각각 `savePlaceRoi`/`alignApply`). 자동보정(`alignApply`/`alignUndo`) 흐름에는 영향 없음.

---

## 3. 테스트

- 신규/수정 테스트: `test/placeDraw.test.ts`(`clearPresetSpaces` 순수 테스트, 랜덤 500케이스 포함) · `test/placeDrawWiring.test.ts`(S1~S4 렌더/순서/결선 봉인 +19건).
- 전량 회귀: `tsc --noEmit` **0에러**, `vitest run` **256파일 / 3079테스트 green**(구현자·검증자 실행 수치 일치), L3 골든 해시(`test/groundGrid.test.ts`) green.
- 검증자가 추가로 수행한 것은 vitest가 아니라 **배포 소스 원문을 직접 잘라 실행하는 별도 하네스**(`qa_render.mjs`·`qa_clear.mjs`·`qa_off.mjs`, scratchpad에서 실행 후 저장소 무오염 확인)였다 — "테스트 통과"와 "실제 발행되는 캔버스 명령"을 구분하기 위함.

---

## 4. 운영 유의

- **되돌리기는 1단계 한정**이다. 초기화·전체삭제 각각 1회분만 복구 가능하며, 그 이후 다른 편집(새 면 추가·번호 수정 등)이 있으면 되돌리기 시 그 편집까지 함께 사라진다 — 이 경우에만(지문 불일치 시에만) 추가 확인이 뜬다.
- **저장 전에는 파일이 절대 바뀌지 않는다** — 초기화/전체삭제/되돌리기는 메모리 조작뿐이고, 반영은 기존 '저장' 버튼 클릭 시 1회 PUT으로만 일어난다.
- **`place-delete`(기존 개별 삭제 버튼)로 지운 면은 이번 라운드로도 복구되지 않는다** — 되돌리기는 초기화·전체삭제 경로에만 연결되어 있다.
- 전체삭제로 어떤 프리셋이 파일상 0면이 되면, 다음에 그 프리셋에 다시 그려 저장하려면 **라이브 프레임을 먼저 시작**해야 한다(§2-4).
- **브라우저 실렌더는 여전히 미확인**이다 — 아래 후속 권고 참조.

---

## 5. 후속 권고 (우선순위)

1. **[최상위] 마스터 브라우저 육안 확인** — `#roi-floor`가 꺼진 상태에서 그리기를 시작/커밋했을 때 초록 파일 ROI가 실제로 보이는지, 3점 단계 점선 닫힘 예고가 시인성 있게 보이는지, `confirm()` 모달과 2행 레이아웃이 정상 렌더되는지. 이번 라운드는 전부 "코드 경로 확인"까지이며 실제 픽셀은 누구도 보지 못했다.
2. 전체삭제 → 저장 → `ROI 파일 로딩`(DB 재구성) 종단 흐름을 실서버로 1회 재현 — 현재는 코드 직접 실행(`applyPlaceRoiUpdateEx`/`normalizePtzCamRoi`)까지만 확인됨, HTTP 계층·파일 I/O는 미검증.
3. F-1 잔여 갭 처리 방침 결정 — 기존 `place-delete`(개별 삭제) 경로도 되돌리기로 복구할지 여부(리더 요구는 "초기화·전체삭제 양쪽"이었고 이번 범위는 그 둘까지만).
4. F-5(되돌리기 버튼 문구 중복 `#place-undo`/`#align-undo`) 문구 구분 — 정보 등급, 다음 라운드 판단.
5. 별건: 실카 자동ROI 격자 스케일 의심(`auto cam1 p01 8/10`) — 이번 라운드는 지시대로 손대지 않음, 그리기 정상화 확인 후 별도 확인 필요.
6. 이월 항목(변경 없음): R2(단일 quad `focalFromVPs` f²≤0) 근본 해결 · `normalizePtzCamRoi` 조용한 탈락 · `allowNew` UI 미노출 · Unity 튜닝값.
