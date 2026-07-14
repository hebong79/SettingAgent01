# 02 구현 보고 — 정밀수집 우측 패널: 프리셋 리스트 제거 + 전체 주차면 리스트(PtzCamRoi 전역 인덱스)

작성: 구현자(developer) / 수신: 검증자(qa-tester), 문서화(documenter)
근거: `_workspace/01_architect_plan.md` + **마스터 승인 변경(R5 → 대안 B 확정)**

---

## 0. 요약

- 계획서 §3·§4 대로 구현. **서버(TypeScript) 코드 변경 0줄** — `PUT /capture/place-roi` 를 전 프리셋 **순차(직렬) PUT** 으로 재사용.
- **R5는 대안 B로 확정 반영**: 주차면 패널은 **PtzCamRoi 전용 5종(선택·수정·삭제·저장·열기)**, 기존 setup_artifact 도구(추가/저장/결과 저장/결과 열기 + 선택정보·슬롯삭제)는 **분석 탭 '전역 인덱스 수동 매핑' 섹션으로 이관**(id·핸들러 동일 → 기능 회귀 0).
- `npx vitest run` → **120 파일 / 1280 테스트 전량 통과**(회귀 0). `npm run typecheck`(tsc --noEmit) **통과**.

---

## 1. 변경 파일별 요약

### `web/core.js` (순수 로직 — DOM/fetch 미참조)

| 구분 | 내용 |
|---|---|
| **신규** | `normalizeGlobalIdx` / `reindexPlaceSpace` / `removePlaceSpace` / `buildFlatSlotRows` (+ 내부 헬퍼 `flattenPlaceRoi`·`assemblePlaceRoi`·`orderedByIdx`, 미export) |
| **확장** | `selectFloorRoi` 파일 모드 폴리곤에 `idx` 1필드 가산(`{quad, label, idx}`) — 선택 하이라이트용. `quad`/`label`·LLM 분기 무변경 |
| **삭제** | `buildSlotListGroups`(§3-6 고아 — `buildFlatSlotRows` 로 대체), `cameraposListRows`, `parseLoadedCamerapos`(R1 고아) |

### `web/core.d.ts`
- `buildSlotListGroups`/`SlotListGroup*`, `cameraposListRows`, `parseLoadedCamerapos` 선언 제거.
- `PlaceRoiMap`, `FlatSlotRow`, 신규 4함수 선언 추가. `FloorRoiPolygon.idx?: number` 추가.

### `web/index.html`
- `#cpreset-box` 블록 **전체 삭제**(cpreset-name/add/update/delete/open/save/list/msg) — R1.
- `주차면 목록 · 편집` 패널 → **PtzCamRoi 전용 툴바**로 교체: `#place-sel-info`, `#place-gidx`(number), `#place-edit`(수정), `#place-delete`(삭제), `#place-save`(저장), `#place-open`(열기), `#place-msg`, `#slot-list`(유지). **삭제 버튼은 1개**(PtzCamRoi 주차면 삭제).
- 분석 탭 `전역 인덱스 수동 매핑` 섹션 하단에 **이관된 산출물 도구**: `#sel-slot-info`, `#slot-insert-idx`, `#slot-add`(추가), `#roi-delete`(삭제), `#map-save`(저장), `#result-save`(결과 저장), `#result-open`(결과 열기), `#map-msg` — **id·라벨·기능 전부 동일**(이동만).
- 신규 CSS 0줄(`.roi-edit-bar`/`.toolbar`/`.sel-slot-info`/`.slot-insert-idx`/`.map-msg`/`.slot-list .slot.selected` 재사용).

### `web/app.js`
| 구분 | 내용 |
|---|---|
| import | `buildSlotListGroups`/`cameraposListRows`/`parseLoadedCamerapos` 제거, `buildFlatSlotRows`/`normalizeGlobalIdx`/`reindexPlaceSpace`/`removePlaceSpace` 추가 |
| state | `cameraposEdit` 제거 / `selectedPlaceIdx`(선택 전역번호), `placeRoiDirty`(미저장) 추가 |
| `renderSlotList` | `finalized \|\| fileMode` 분기를 **평면 목록**으로 교체: 행 `#{전역인덱스} cam{c}:{p} (점유\|공차)[ — VPD/LPD]`, 클릭 → `selectPlaceSpace`, 선택 행 `.selected`. **mapping(LLM) 분기 무변경** |
| `loadPlaceRoi` | `normalizePtzCamRoi` 직후 `normalizeGlobalIdx` 적용(R3 진입점). `changed` 면 dirty + `'전역번호 재부여됨(미저장) — 저장 필요'` 고지 + `renderSlotList()` |
| `drawFileFloorRoi` | `poly.idx === state.selectedPlaceIdx` → 굵은 대비색(#ff4d4d, lineWidth 4) 하이라이트 |
| 신규 | `setPlaceMsg` / `markPlaceDirty` / `renderPlaceSelectionInfo` / `placeSpaceCount` / `selectPlaceSpace` / `editPlaceIdx` / `deletePlaceSpace` / `savePlaceRoi` / `openPlaceRoi` |
| 삭제 | `setCpresetMsg` / `renderCameraposList` / `selectCameraposItem` / `openCamerapos` / `saveCamerapos` / `cpresetAction` + `#cpreset-*` 리스너 6개 + `setTab` 의 `renderCameraposList()` 호출 |
| 정리 | `savePreset(asNew, labelOverride)` → **`savePreset(asNew)`**(labelOverride 소비자가 cpreset 뿐이었음 → 고아 파라미터 제거, `$('preset-label')` 고정) |
| 유지 | `upsertPreset`/`removePreset`/`persistCamerapos`/`savePreset`/`deletePreset` + 제어패널 프리셋 콤보·편집 UI, `pickAndReadJsonFile`(openResult·openPlaceRoi 공용) |

### `web/app.css`
- `.slot-list .slot-group` / `:first-child` / `.current` 3규칙 제거(프리셋 그룹 헤더 소멸로 **내 변경이 만든 고아 CSS**).

### `test/`
- `test/buildSlotListGroups.test.ts` **삭제**(대상 함수 제거 — 정보량은 `buildFlatSlotRows` 테스트가 승계해야 함 → **qa-tester 인계**).
- `test/preciseCore.test.ts`: `cameraposListRows`·`parseLoadedCamerapos` import + 2개 describe 제거(그 외 기능2/3 테스트 **전부 유지**).

---

## 2. 신규 순수함수 시그니처 (`web/core.js`)

```js
// R3 마이그레이션. idx 집합이 정확히 1..N 순열이면 무변경(사용자 재지정 번호 보존).
// 아니면(중복·0-based·누락·비정수) (cam asc → preset asc → 배열순) 기준 1..N 재부여.
normalizeGlobalIdx(placeRoi) → { placeRoi, changed: boolean, issues: string[] }

// R4 '수정'. 전역 시퀀스에서 fromIdx 를 뽑아 toIdx 위치에 삽입 후 1..N 재부여(밀어내기).
// 프리셋 소속·좌표·프리셋내 배열순서 불변 — idx 값만 갱신. toIdx 는 1..N clamp.
// fromIdx 부재 / toIdx 비수치 / from===to → 원본 그대로. 불변(새 객체).
reindexPlaceSpace(placeRoi, fromIdx, toIdx) → placeRoi

// R4 '삭제'. 제거 후 상대순서 유지한 채 1..N 재압축. 빈 프리셋도 키를 [] 로 유지
// (저장 시 그 프리셋을 spaces:[] 로 PUT 해야 하므로 키 삭제 금지). 없는 idx → 원본. 불변.
removePlaceSpace(placeRoi, idx) → placeRoi

// R2 평면 목록. globalIdx 오름차순. 점유는 computeOccupancy 재사용(파일 바닥ROI × LPD 중심).
// parkingSlotsByKey(DB)에 slotIdx===globalIdx 행이 있으면 그 행의 occupied/vpd/lpd 우선.
// 단 그 프리셋 DB 행 **전체**가 파일 전역번호 집합에 속할 때만 채택(부분 겹침 → 통째 기각).
buildFlatSlotRows({ placeRoi, detectByKey, parkingSlotsByKey })
  → [{ globalIdx, cam, preset, key, occupied, vpd, lpd }]
```

`placeRoi` = `{ "cam:preset": [{ idx, points }] }`. **PtzCamRoi.json 스키마 무변경** — `parking_spaces[].idx` 가 전역 인덱스, 프리셋내 인덱스는 **배열 위치**로만 표현. 4함수 모두 **불변·throw 금지**(기존 강등 철학).

---

## 3. '저장'(R4) 구현 — 서버 0줄

```js
for (const key of Object.keys(state.placeRoi)) {   // ★ 반드시 직렬 await
  const [cam, preset] = key.split(':').map(Number);
  await fetch('/capture/place-roi', { method:'PUT', body: JSON.stringify({ camId: cam, presetIdx: preset, spaces: state.placeRoi[key] }) });
  // 실패 시 즉시 중단 + 실패 프리셋 명시(부분 저장을 숨기지 않음), placeRoiDirty 유지
}
```
- 라우트가 매 요청 `readFile → applyPlaceRoiUpdate → writeFile` 이므로 **병렬 PUT 은 read-modify-write 경합으로 갱신 유실** → `for...of + await` 직렬 고정(계획 §4-3 4번).
- `applyPlaceRoiUpdate` 가 **payload idx 를 그대로 기록**하므로 전역번호 저장에 서버 확장 불필요(계획 §1-1).

---

## 4. 이관한 artifact UI 위치(마스터 승인 대안 B)

`web/index.html` → `#analyze-view` → `<section>` **전역 인덱스 수동 매핑** 내부, `#an-manual-split` 바로 아래:

```
전역 인덱스 수동 매핑
 ├ [자동 번호][저장] + 상태            (기존 #an-manual-auto / #an-manual-save)
 ├ 표(#an-manual) | 슬롯 맵(#an-slotmap) (기존)
 └ 산출물 도구(이관): #sel-slot-info | #slot-insert-idx | 추가 | 삭제 | 저장 | 결과 저장 | 결과 열기 | #map-msg
```
- 핸들러(`addSlot`/`deleteSelectedSlot`/`saveMapping`/`saveResult`/`openResult`)·id·라벨 **전부 그대로**. `wire()` 배선도 동일(`$('slot-add')` 등은 DOM 어디에 있든 동작).
- `renderSelectionInfo()`(=`#sel-slot-info`/`#roi-delete` 갱신)와 `markDirty()`(=`#map-msg`)는 **그대로 동작** — 요소가 숨겨진 탭에 있어도 DOM 에 존재하므로 예외 없음. 오버레이 Ctrl+드래그 편집 → 분석 탭 '저장'으로 영속화하는 흐름 유지.
- 주차면 패널의 `삭제`는 **PtzCamRoi 주차면 삭제 하나뿐**(중복 삭제 버튼 없음).

---

## 5. 삭제한 코드 목록

| 파일 | 심볼/블록 |
|---|---|
| `web/index.html` | `#cpreset-box` 섹션 전체(`cpreset-name/add/update/delete/open/save/list/msg`) |
| `web/app.js` | `setCpresetMsg`, `renderCameraposList`, `selectCameraposItem`, `openCamerapos`, `saveCamerapos`, `cpresetAction`, `state.cameraposEdit`, `#cpreset-*` 리스너 6개, `setTab` 내 `renderCameraposList()`, `savePreset` 의 `labelOverride` 파라미터 |
| `web/core.js` | `cameraposListRows`, `parseLoadedCamerapos`, `buildSlotListGroups` |
| `web/core.d.ts` | 위 3함수 선언 + `SlotListGroupSlot`/`SlotListGroup` 인터페이스 |
| `web/app.css` | `.slot-list .slot-group`(+`:first-child`, `.current`) |
| `test/` | `buildSlotListGroups.test.ts`(파일), `preciseCore.test.ts` 의 camerapos 2 describe |

**데드코드 언급만(삭제 안 함)**: 없음(발견된 무관 데드코드 없음).

---

## 6. 검증

### 유닛 (`npx vitest run`)
```
Test Files  120 passed (120)
Tests      1280 passed (1280)
```
+ `npx tsc -p tsconfig.json --noEmit` → **exit 0**.

### 경험적 동작 확인 (실데이터 `data/Place01/PtzCamRoi.json` + **서버 실함수** `applyPlaceRoiUpdate` 교차검증)
| 확인 | 결과 |
|---|---|
| 원본 idx(0-based 중복) `1:1=[0..6] 1:2=[0..5] 1:3=[0..3]` → 정규화 | `1:1=1..7`, `1:2=8..13`, `1:3=14..17` (`changed:true`, issues 11) |
| 재정규화(멱등) | `changed:false` — 커스텀 번호 보존 |
| 평면 목록 | **17행**, `#1 cam1:1` … `#17 cam1:3` (globalIdx 오름차순) |
| 수정 `14 → 1` | `1:3=[1,15,16,17]`, `1:1=[2..8]`, `1:2=[9..14]` / **소속 cam1:3 유지·좌표 동일**, idx 집합 = 1..17 |
| **왕복**: 전 프리셋 순차 `applyPlaceRoiUpdate` → 재파싱 | 파일 idx **그대로 보존**(재정규화 `changed:false`), **스키마 키 불변** (`cameras`/`camera,presets` → `preset_idx,parking_spaces` → `idx,points`) |
| 삭제 `8` | N=16, idx 집합 = 1..16 (재압축) |
| 불변성 | 원본 `placeRoi` 미변형 확인 |

> 브라우저 라이브(행 클릭 → 프리셋 물리 전환·오버레이 하이라이트, 저장 후 GET 재조회)는 **qa-tester 인계**.

---

## 6-A. 추가 변경 — Finalizer 전역번호 정합 (마스터 승인, 2차)

> QA 지적(DB 태그 오귀속) 수정 후 드러난 잔여 이슈. **계획서 §4-3 "서버 0줄" 제약을 마스터 승인으로 해제**하고 이번 범위에 포함.

### 문제
`src/capture/Finalizer.ts` 가 `slotIdx: sp.idx` 로 **PtzCamRoi 파일의 raw idx** 를 DB 에 기록 → 뷰어에서 '저장'을 누르기 전(Unity 생성 0-based 파일)에 최종화하면 **DB 는 0-based, 뷰어 목록은 전역번호(1..N)** 로 체계가 갈라져 DB 태그(VPD/LPD)가 표시되지 않는다(최초 사용 시의 기본 경로).

### 변경 파일
| 파일 | 내용 |
|---|---|
| `src/capture/placeRoi.ts` | **신규 순수함수** `normalizeGlobalIdx(byPreset: Map<string, PlaceRoiSpace[]>) → Map<...>` — `web/core.js:normalizeGlobalIdx` **동등 포팅**. 파일 전체가 1..N 순열이면 **그대로 반환(멱등)**, 아니면 `(cam asc → preset asc → 배열순)` 1..N 재부여. 불변·throw 금지 |
| `src/capture/Finalizer.ts` | import 1줄 + `const byPresetPlace = normalizeGlobalIdx(place.byPreset);` → 기존 루프가 이 맵을 순회(2줄). **그 외 로직·점유 배정·PTZ 캐시 무변경** |
| `test/globalIdxParity.test.ts` | **신규** — 서버 ≡ 뷰어 **규칙 파리티 고정**(9 케이스: 0-based 중복 / 이미 1..N 뒤섞임 멱등 / 누락 / 0 포함 / 비정수 / 파일 프리셋 역순 / 빈 파일 / **실데이터 PtzCamRoi.json** / 멱등). 같은 raw JSON → **동일 전역번호**를 assert → 두 구현이 갈라지면 즉시 실패 |
| `test/finalizerParkingSlots.test.ts` | 기존 하네스 재사용 + describe 3케이스 추가: ① 0-based 파일 → `slot_idx` 1..N 재부여(프리셋 간 중복 해소) ② **성공기준**: 0-based 파일로 최종화 → 뷰어 경로(core 정규화 + `buildFlatSlotRows`)에서 **DB 태그 정상 부착**(`vpd/lpd:true`, 오귀속 없음) ③ 이미 1..N 고유(사용자 재지정) → **번호 보존(멱등)** |

### 규칙 중복 방지
순수 규칙은 **서버 `placeRoi.ts` / 뷰어 `core.js` 두 런타임에 각 1개**(브라우저는 TS 서버 모듈을 import 할 수 없어 물리적 공유 불가). 대신 **`globalIdxParity.test.ts` 가 동일 입력 → 동일 출력임을 못 박아** 분기(divergence)를 CI 에서 즉시 검출한다.

### 검증
- **뮤테이션 검사**: Finalizer 를 원래(`place.byPreset`)로 되돌리면 신규 2케이스(`slot_idx 1..N`, `성공기준 DB 태그 부착`)가 **즉시 실패** → 검출력 실증. 원복 후 전량 통과.
- `npx vitest run` → **122 files / 1328 tests 전량 통과**(회귀 0). `npx tsc --noEmit` → **exit 0**.
- 기존 run(0-based `slot_idx`) **마이그레이션 없음** — `buildFlatSlotRows` 의 "집합 전체 포함 시에만 태그 채택, 아니면 통째 기각" 폴백이 계속 graceful 하게 동작(태그 미부착, 오귀속 없음). qa-slotlist 4케이스로 고정됨.
- PtzCamRoi.json **스키마 무변경** 유지.

---

## 7. 남은 위험

1. **Unity 재생성 시 커스텀 전역번호 소실**(계획 §5-1) — 스키마 무변경 제약의 필연. `normalizeGlobalIdx` 가 중복 감지 → graceful 재부여(크래시 없음)하지만 **사용자가 지정한 번호는 복구 불가**. 문서 경고 필요.
2. **finalized(최종화 후) 목록의 소스가 `state.placeRoi` 로 바뀜** — DB(`parkingSlotsByKey`)는 이제 **태그(occupied/vpd/lpd) 소스**로만 쓰인다. PtzCamRoi 가 없으면(파일 미설정) 최종화 후에도 목록이 비어 `'표시할 주차면 없음 — PtzCamRoi.json 확인'` 이 뜬다(기존엔 DB 행으로 표시됐음). 실운영은 Finalizer 가 PtzCamRoi 를 소스로 하므로 정상 경로에선 발생하지 않음.
3. **구 run·미저장 파일 기준 run 의 DB `slot_idx` 는 프리셋별 0-based** → 신 전역번호(1..N)와 **부분만 겹쳐** 태그가 한 칸 시프트되어 **틀린 주차면에 오귀속**되는 결함이 있었음(qa-tester 지적). **수정 완료**: `buildFlatSlotRows` 가 프리셋 단위로 **DB 행 집합이 파일 전역번호 집합에 전부 속할 때만** 태그를 채택하고, 아니면 통째 기각 → 파일 계산 점유로 폴백(태그 미부착, graceful).
   - **[해소됨 — §6-A]** Finalizer 가 파일 raw idx 를 그대로 쓰던 문제는 서버 `normalizeGlobalIdx` 포팅으로 해결. **이제 '저장' 전(0-based 파일)에 최종화해도 DB `slot_idx` 가 전역번호(1..N)로 기록**되어 태그가 정상 표시된다. 운영상 사전 '저장' 강제 불필요.
   - 여전한 잔여: **구 run(이번 변경 이전에 기록된 0-based 행)** 은 마이그레이션하지 않았다 → 그 run 을 다시 열면 태그 미부착(graceful, 오귀속 없음). 재최종화하면 정합.
4. **"전역 인덱스" 동음이의 2체계**: `artifact.globalIndex`(GlobalIndexer, slotId 기준 — `slot_ptz.json`/캘리브레이션이 사용) vs `PtzCamRoi.idx`(신규). **서로 무관**하여 캘리브레이션 정합은 깨지지 않음(계획 §1-3). 분석 탭에 두 체계 UI 가 공존하므로 문서에 구분 명시 필요.
5. **저장 부분 실패**: 순차 PUT 중단 시 앞 프리셋만 파일 반영. `#place-msg` 에 실패 프리셋 명시 + `placeRoiDirty` 유지로 고지(자동 롤백 없음).
6. **Unity 가 space 에 새 필드 추가 시** `applyPlaceRoiUpdate` 가 `{idx,points}` 로만 재구성 → 필드 소실(현재는 해당 없음, 계획 §5-2).
7. **`buildSlotListGroups` 테스트 파일 삭제** — 동등 커버리지를 `buildFlatSlotRows` 테스트로 **qa-tester 가 복원**해야 함(점유 재계산·DB 태그·빈 입력 강등).
