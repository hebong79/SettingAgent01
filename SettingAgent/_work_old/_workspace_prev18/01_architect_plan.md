# 01 설계서 — 정밀수집 우측 패널: 프리셋 리스트 제거 + 전체 주차면 리스트(PtzCamRoi 전역 인덱스)

작성: 설계자(architect) / 대상: developer, qa-tester, documenter
근거: 모든 인용은 실제 소스 확인(파일:라인). 추측 없음.

---

## 1. 현황 실측

### 1-1. `applyPlaceRoiUpdate` 매칭 방식 — **결정적 확인 (R4 저장의 핵심 리스크 해소)**

`src/capture/placeRoi.ts:107~115`

```ts
const nextPresets = presets.map((presetRaw) => {
  const preset = presetRaw as { preset_idx?: unknown; [k: string]: unknown };
  if (preset?.preset_idx !== update.presetIdx) return presetRaw;
  const parking_spaces = (update.spaces ?? []).map((sp) => ({
    idx: sp.idx,
    points: (sp.points ?? []).map((p) => [p.x * W, p.y * H]),
  }));
  return { ...preset, parking_spaces };
});
```

- **idx 매칭이 아니다.** 대상 프리셋의 `parking_spaces` **배열 전체를 payload 로 통째 교체**하고, `idx` 는 payload 값을 **그대로 기록**한다.
- ⇒ **전역번호로 idx 를 바꿔도 매칭 실패 위험이 없다.** payload 에 실어 보내면 그대로 파일에 쓰인다. R4 가 우려한 "idx 매칭이면 전역번호 변경 시 매칭 실패" 시나리오는 **발생하지 않는다.** 서버 수정 불필요.
- 카메라 매칭은 `cam.cam_id !== update.camId`(L102), 프리셋 매칭은 `preset_idx !== presetIdx`(L109) — 둘 다 **엄격 비교(타입 민감)**. 실데이터가 `cam_id:1`(number), `preset_idx:1`(number)이고 `PlaceRoiPutSchema`(`captureRoutes.ts:61~70`)가 `z.number().int().positive()` 로 강제하므로 타입 불일치 없음.
- **보존 범위**: `{...root}`(L118), `{...entry}`(L116), `{...preset}`(L114) 스프레드 → 타 카메라·타 프리셋·카메라 메타(`fov` 등) 모두 보존.
- **주의(데이터 손실 가능성) → 실측 결과 해당 없음**: 위 map 은 space 를 `{idx, points}` 로만 재구성하므로 space 에 다른 필드가 있으면 **소실**된다. 실데이터 `data/Place01/PtzCamRoi.json` 의 space 키를 전수 확인한 결과 **모든 space 가 정확히 `["idx","points"]` 뿐** → 소실 필드 없음. (단, Unity 가 향후 space 에 필드를 추가하면 저장 시 소실된다 → §5 위험에 기재.)

### 1-2. 실데이터 구조 (`data/Place01/PtzCamRoi.json`, node 로 직접 파싱 확인)

| 항목 | 값 |
|---|---|
| top keys | `["cameras"]` |
| camera 메타 | `cam_id:1, name, position, eulerAngles, fov:24.01697, imageWidth:1920, imageHeight:1080` |
| preset keys | `["preset_idx","parking_spaces"]` — `preset_idx` = 1,2,3 (number, 1-based) |
| space keys | `["idx","points"]` **전부** |
| idx 값 | preset1 = `[0,1,2,3,4,5,6]` / preset2 = `[0,1,2,3,4,5]` / preset3 = `[0,1,2,3]` |
| 총 주차면 | 7+6+4 = **17** |

⇒ 리더 확인대로 **idx 는 프리셋별 0-based, 프리셋 간 중복**. 전역 재부여 대상 = 1..17.

### 1-3. `slot_ptz.json` 은 `placeRoi.idx` 를 쓰지 않는다 — **정합 깨짐 없음 (R5 핵심 확인)**

- `src/calibrate/slotPtzWriter.ts:14~38` `expandPlateTargets(artifact: SetupArtifact)` — 입력이 **setup_artifact**다. 키는 `slot.slotId`, 전역번호는 `artifact.globalIndex` 역참조(`globalBySlot.get(slot.slotId) ?? null`, L17/L31).
- `src/calibrate/PtzCalibrator.ts:215, 304` 는 `t.globalIdx`(위 PlateTarget) 를 그대로 싣는다.
- `artifact.globalIndex` 는 `src/setup/GlobalIndexer.ts:25` 에서 `globalIdx: i + 1` 로 **artifact 슬롯 기준** 생성 — **PtzCamRoi.idx 와 무관한 별개 체계**.
- ⇒ **`slot_ptz.json` 은 PtzCamRoi.idx 를 키로 쓰지 않으므로, idx 의미 변경이 기존 캘리브레이션 데이터를 깨뜨리지 않는다.** (단 "전역 인덱스"라는 **동음이의 체계가 2개** 존재하게 됨 → §5 에 기재.)

### 1-4. `placeRoi.idx` 소비자 전수 조사 (grep 기반, `_work_old` 제외)

| # | 소비 지점 | 파일:라인 | idx 사용 방식 | 전역 고유 idx 로 바뀌면? |
|---|---|---|---|---|
| C1 | `normalizePtzCamRoi` (web) | `web/core.js:387, 405` | 파일 idx 를 그대로 통과 | **영향 없음**(pass-through) |
| C2 | `normalizePtzCamRoi` (server) | `src/capture/placeRoi.ts:59~73` | 동일 | **영향 없음** |
| C3 | `selectFloorRoi` | `web/core.js:428~430` | `label: String(sp.idx)` — 오버레이 라벨 | **표시만 바뀜**(0..6 → 1..17). 의도된 개선 |
| C4 | `computeOccupancy` | `web/core.js:454~463` | `idx` pass-through(키 아님) | **영향 없음** |
| C5 | `buildSlotListGroups`(file 분기) | `web/core.js:499~507` | `occById` Map 키로 idx 사용 — **프리셋 그룹 내부 한정** | 전역 고유는 프리셋내 고유를 함의 → **영향 없음** (오히려 안전해짐: 현재는 프리셋 간 중복이지만 그룹별로 Map 을 새로 만들어 우연히 안전했음) |
| C6 | `drawFileFloorRoi` | `web/app.js:364~386` | `poly.label`(=idx) 를 캔버스에 그림 | **표시만 바뀜** |
| C7 | `updateLogicOccupancy` | `web/app.js:321~340` | `spaces: computeOccupancy(...).map((o) => ({ id: o.idx, ... }))` → 점유 스냅샷 | **id 값 의미 변경**(표시/집계용, 키 아님) → 기능 영향 없음 |
| C8 | `transformPlaceRoiPreset` | `web/core.js:1242` | 좌표만 변환, **idx 보존** | **영향 없음** |
| C9 | `alignApply`(자동보정 저장) | `web/app.js:1220~1244` | `state.placeRoi[key]` 를 그대로 PUT | **영향 없음** — idx 를 보존해 PUT 하므로 전역번호가 유지된다 |
| C10 | 서버 `applyPlaceRoiUpdate` | `src/capture/placeRoi.ts:89~119` | payload idx 를 그대로 기록(§1-1) | **영향 없음 = 오히려 우리가 의존할 성질** |
| C11 | **`Finalizer`** | `src/capture/Finalizer.ts:214~253` | `loadNormalizedPlaceRoi` → `rows.push({ ..., slotIdx: sp.idx, ... })` → `replaceParkingSlots` | **DB `parking_slots.slot_idx` 값 의미가 바뀐다** (아래 C12) |
| C12 | DB 스키마 | `src/capture/SqliteStore.ts:91~101` | `PRIMARY KEY (run_id, preset_key, slot_idx)` | **PK 여전히 유효** — 전역 고유 ⊃ 프리셋내 고유. 제약 위반 없음. 단 **과거 run 의 행은 옛 0-based 번호를 보존**(§5-3) |
| C13 | `loadParkingSlots`→`buildSlotListGroups`(DB 분기) | `web/app.js:1498~`, `web/core.js:490` | `r.slotIdx` 표시 | 표시 값이 run 시점 파일 idx 를 따름 |
| C14 | `loadDetectCfg` | `src/capture/detectPipeline.ts:70~75` | PtzCamRoi 에서 **fov 만** 읽음 | **idx 미사용 → 영향 없음** |

**결론: idx 의미 변경으로 "깨지는" 코드는 없다.** 전역 고유 idx 는 프리셋내 고유의 상위집합이므로, idx 를 프리셋 스코프 키로 쓰는 유일한 두 곳(C5 Map, C12 DB PK)이 모두 안전하다. 나머지는 pass-through 또는 표시용. **수정이 필요한 곳은 0곳**(선택적 개선은 §3-5 의 `selectFloorRoi` 에 `idx` 추가 — 선택 하이라이트용).

### 1-5. 삭제 대상 박스(R1)의 고아 함수 판정

| 심볼 | 정의 | 소비자 | 판정 |
|---|---|---|---|
| `cameraposListRows` | `web/core.js:1135` | `web/app.js:55(import), 1079` + `test/preciseCore.test.ts` + `web/core.d.ts:389` | **고아 → 제거** |
| `parseLoadedCamerapos` | `web/core.js:1146` | `web/app.js:56(import), 1105` + `test/preciseCore.test.ts` + `web/core.d.ts:390` | **고아 → 제거** |
| `pickAndReadJsonFile` | `web/app.js:772` | `openCamerapos:1103` **+ `openResult:823`** | **소비자 존재 → 유지**(신규 '열기'도 재사용) |
| `upsertPreset`/`removePreset`/`persistCamerapos`/`savePreset`/`deletePreset` | `web/app.js:1005~1052` | `wire()` `#preset-save/#preset-new/#preset-delete` (`app.js:2458~2460`) | **유지**(R1 명시) |
| `savePreset` 의 `labelOverride` 인자 | `web/app.js:1021, 1026` | **오직** `#cpreset-add/#cpreset-update`(`app.js:2492~2493`)에서만 전달. 제어패널(2458/2459)은 미전달 → `$('preset-label')` 사용 | 내 변경으로 **고아 파라미터화** → 시그니처를 `savePreset(asNew)` 로 정리(선택, 권장) |
| `#cpreset-name` | `index.html:180` | `app.js:1094, 2492, 2493` — **전부 삭제 대상 박스 내부** | **함께 제거 안전** |

⇒ **제어패널 프리셋 편집(`#preset-label`/`#preset-save`/`#preset-new`/`#preset-delete`, `index.html:82~90`)은 독립적이며 무손상.**

### 1-6. 기존 `renderSlotList` 구조 (`web/app.js:470~535`)

- `finalized`(DB 행 존재) **또는** `fileMode`(`!#cap-floor-llm.checked && (roiHidden || !mapping)`) → `buildSlotListGroups` 로 **프리셋 그룹 헤더 + 슬롯** 렌더. **행에 click 핸들러 없음** → 파일 모드에선 선택 불가(= R4 '선택'이 메꿀 공백).
- 그 외(LLM·미최종화) → `state.mapping.slots` 기반 렌더 + `selectSlot` 클릭.

---

## 2. R5 경계 정리 — **결정 + 근거 (리더 승인 요망)**

### 문제
한 박스에 **두 소스**가 섞인다.
- **setup_artifact 소스**: `추가`(`#slot-add`, `insertSlotAt`), `저장`(`#map-save`, PUT `/mapping`), `결과 저장`/`결과 열기`(로컬 artifact JSON), `#sel-slot-info`, `#roi-delete`(artifact 슬롯 삭제).
- **PtzCamRoi 소스(신규)**: 마스터 확정 5종(선택·수정·삭제·저장·열기).

### 결정 (권장안 A) — **두 소스를 같은 섹션 내 별도 서브툴바로 물리 분리, 기존 artifact 도구는 존치**

```
주차면 목록 · 편집
 ├ [산출물(setup_artifact)] sel-slot-info | slot-insert-idx | 추가 | 슬롯 삭제 | 산출물 저장 | 결과 저장 | 결과 열기   ← 기존 유지(라벨만 명확화)
 ├ [주차면(PtzCamRoi.json)] place-sel-info | place-gidx | 수정 | 삭제 | 저장 | 열기                              ← 신규 5종
 └ #slot-list = 전역 인덱스 오름차순 평면 목록(placeRoi 소스)
```

**근거**
1. **`추가`를 placeRoi 로 전환하면 쓸모없는 기능이 된다.** placeRoi 폴리곤은 **드래그 편집 경로가 없다** — `wireOverlayEditing`(`app.js:2222~`)/`hitTestFloorVertex`(`app.js:578`)/`drawQuadHandles`(`app.js:539`)는 전부 `state.mapping.slots` 의 `floorRoiByPreset`/`roiByPreset` 대상이고, `drawFileFloorRoi`(`app.js:364`)는 **핸들을 그리지 않는다**. placeRoi 에 새 4점 폴리곤을 추가해도 **사용자가 위치를 잡을 수단이 없다.** placeRoi 편집기를 새로 만드는 것은 마스터 요구 5종 밖의 대형 스코프 → **CLAUDE.md 규칙 2(추측성 코드 금지) 위반**. ⇒ `추가`는 artifact 기반으로 **그대로 둔다**.
2. **artifact 편집 도구를 삭제하면 연쇄 파괴**: `insertSlotAt`/`removeSlot`/`nextSlotId`/`parseLoadedArtifact`/`wireOverlayEditing`/PUT `/mapping` + 기존 테스트(`test/slotInsertEdit.test.ts`, `test/slotInsertEditQa.test.ts`, `test/roiEdit.test.ts`)까지 동반 사망. 마스터는 이들 제거를 **요청하지 않았다** → **CLAUDE.md 규칙 3(외과적 변경)** 상 건드리지 않는다.
3. **두 소스는 이미 모드로 분리되어 충돌하지 않는다**: 파일 모드에선 `#slot-list` 에 artifact 클릭 핸들러가 없어 `state.selectedSlotId` 가 `null` 로 유지 → `#roi-delete` 는 `renderSelectionInfo`(`app.js:614~626`)에 의해 **자동 비활성**. 즉 artifact 삭제 버튼이 placeRoi 삭제와 오작동으로 얽힐 여지가 없다.
4. `결과 저장`/`결과 열기`(artifact 스냅샷)는 **PtzCamRoi 와 완전히 다른 산출물**이고 정밀수집 결과 회수 경로다 → **존치**. 신규 '저장/열기'는 PtzCamRoi 전용으로 **별도 버튼**을 둔다(이름 충돌 방지: `저장` vs `산출물 저장`, `열기` vs `결과 열기`).
5. `map-save`(PUT `/mapping`)는 artifact 영속화 → **존치**(라벨 `저장`→`산출물 저장`으로 변경해 신규 `저장`(PtzCamRoi)과 구분).

**UX 부채(정직한 고지)**: `삭제` 버튼이 2개(`슬롯 삭제`=artifact / `삭제`=PtzCamRoi)가 된다. 라벨·그룹 헤더로 구분하되, 근본 해소는 아래 대안 B.

### 대안 B (미채택, 리더가 원하면 전환 가능)
artifact 편집 4~5종을 **'매핑' 탭으로 이관**(그 탭엔 이미 `renderManualIndex`/`renderSlotMap` 라는 artifact 전역인덱스 편집 UI 가 있다 — `app.js:1769~1854`). 우측 패널은 PtzCamRoi 전용이 되어 가장 깨끗하다.
- **미채택 사유**: 마스터가 요청하지 않은 레이아웃 이동 + 매핑 탭 회귀 위험. 요구 범위를 넘는다. **승인 시 즉시 전환 가능**(추가 공수 소).

> **승인 요청 항목**: 권장안 A 로 진행 가능한지. (기본값 = A)

---

## 3. 신규/변경 순수함수 (`web/core.js`)

모두 **불변(새 객체 반환)·throw 금지**(기존 강등 철학, `core.js:452` 주석 준용). `placeRoi` 는 `{ "cam:preset": [{idx, points}] }` 평범한 객체(`core.js:365, 405`).

### 3-1. `normalizeGlobalIdx(placeRoi) → { placeRoi, changed, issues }`  **[신규]**
R3 마이그레이션. **유효할 때는 건드리지 않는 것이 핵심.**
- 전 주차면을 `(cam asc → preset asc → 배열순)` 으로 나열해 기준 순서를 만든다.
- 현재 idx 집합이 **정확히 1..N 의 순열**(정수·중복없음·누락없음)이면 → **재부여하지 않는다**(`changed:false`). 사용자가 재지정한 번호를 보존해야 하므로 필수.
- 아니면(중복/0-based/누락/비정수) → 기준 순서대로 **1..N 재부여**(`changed:true`), `issues` 에 사유 기록.
- 실데이터(0,1,…6 / 0,…5 / 0,…3) → 중복 감지 → cam1:p1 = 1..7, cam1:p2 = 8..13, cam1:p3 = 14..17.

### 3-2. `reindexPlaceSpace(placeRoi, fromIdx, toIdx) → placeRoi`  **[신규]**
R4 '수정'. 전역 시퀀스(1..N)에서 대상을 뽑아 목표 위치에 삽입 후 **1..N 재부여**(밀어내기).
- **프리셋 소속·좌표 불변** — 각 space 는 자기 프리셋 배열에 남고 `idx` 만 갱신.
- 경계: `fromIdx` 부재 → 원본 그대로. `toIdx` 를 `1..N` 으로 clamp. `from===to` → 원본 그대로.
- 불변식(사후조건): 결과 idx 집합 = `{1..N}`, 중복 0.

### 3-3. `removePlaceSpace(placeRoi, idx) → placeRoi`  **[신규]**
R4 '삭제'. 해당 space 제거 후 남은 전부를 기존 상대순서 유지한 채 **1..N 재압축**.
- 없는 idx → 원본 그대로. 프리셋 배열이 비면 **빈 배열로 키 유지**(§4-3 저장이 그 프리셋을 `spaces:[]` 로 PUT 해야 하므로 키를 지우면 안 된다).

### 3-4. `buildFlatSlotRows({ placeRoi, detectByKey, parkingSlotsByKey }) → rows`  **[신규]**
R2 평면 목록. 반환 `[{ globalIdx, cam, preset, key, occupied, vpd, lpd }]`, **globalIdx 오름차순**.
- 점유: 프리셋별로 기존 `computeOccupancy(floorPolys, plates)` **재사용**(R2 명시). plates = `detectByKey[key].plates ∪ vehicles[].plate` (`core.js:495~498` 동일 로직).
- `parkingSlotsByKey[key]` 에 `slotIdx===globalIdx` 행이 있으면 그 행의 `occupied/vpd/lpd` 를 **우선 사용**(최종화 후 DB 태그 보존 — 기존 `buildSlotListGroups` finalized 분기의 정보량을 잃지 않기 위함).
- 빈/누락 입력 → `[]`.

### 3-5. `selectFloorRoi` — **1줄 확장(가산)**
`core.js:429` 파일 모드 폴리곤에 `idx` 를 함께 반환: `{ quad: sp.points, label: String(sp.idx), idx: sp.idx }`.
- 목적: `drawFileFloorRoi` 가 **선택된 전역번호를 하이라이트**(R4 선택). LLM 분기·기존 필드 무변경 → 회귀 0.

### 3-6. `buildSlotListGroups` — **호출부 소멸 → 제거 판단**
유일 소비자가 `app.js:480` 이며 §3-4 로 대체된다. R2("프리셋 그룹 헤더 제거")로 존재 이유가 사라짐 → **내 변경이 만든 고아** → 제거 + `core.d.ts` 선언 + 관련 테스트 이관(정보량은 §3-4 가 흡수). **단 finalized 태그 표시 능력을 §3-4 가 반드시 승계해야 함**(위 3-4 3번째 불릿).

---

## 4. 변경 지점 (라인 단위)

### 4-1. `web/index.html`
| 라인 | 변경 |
|---|---|
| `173~189` | **`#cpreset-box` 블록 전체 삭제** (`cpreset-name/add/update/delete/open/save/list/msg`) — R1 |
| `126~137` | `주차면 목록 · 편집` 섹션 재구성: 기존 툴바(`127~135`)를 **[산출물] 서브툴바**로 라벨링(`#map-save` 라벨 `저장`→`산출물 저장`, `#roi-delete` 라벨 `삭제`→`슬롯 삭제`), 그 아래 **[주차면(PtzCamRoi)] 서브툴바 신규**: `#place-sel-info`, `#place-gidx`(number), `#place-edit`(수정), `#place-delete`(삭제), `#place-save`(저장), `#place-open`(열기), `#place-msg`. `#slot-list`(137) 유지 |
| — | `id` 는 전부 신규(`place-*`) → 기존 셀렉터 충돌 없음. `.slot-list`/`.toolbar` CSS 재사용(신규 CSS 최소) |

### 4-2. `web/app.js`
| 라인 | 변경 |
|---|---|
| `55~56` | `cameraposListRows`, `parseLoadedCamerapos` **import 제거** |
| `1054~1139` | `setCpresetMsg`/`renderCameraposList`/`selectCameraposItem`/`openCamerapos`/`saveCamerapos`/`cpresetAction` **전체 삭제** |
| `2491~2496` | `#cpreset-*` **리스너 6개 삭제** |
| `2175` | `setTab`: `renderCameraposList()` 호출 **제거** (`capPoll(); calPoll(); loadPlaceRoi();` 는 유지) |
| `82~88`(state) | `cameraposEdit` **제거**. `selectedPlaceIdx: null`(선택 전역번호), `placeRoiDirty: false` **추가** |
| `1021, 1026` | `savePreset(asNew, labelOverride)` → `savePreset(asNew)` + `$('preset-label')` 고정(고아 파라미터 정리, 규칙 3) |
| `470~535` `renderSlotList` | `finalized || fileMode` 분기(`478~513`)를 **`buildFlatSlotRows` 평면 렌더로 교체**: 행 = `#{globalIdx} cam{c}:{p} (점유|공차) [— VPD/LPD]`, `click → selectPlaceSpace(row)`, `selected` 클래스. `514~534` mapping 분기는 **무변경**(LLM 모드 회귀 0) |
| 신규 | `selectPlaceSpace(row)` — `state.selectedPlaceIdx = row.globalIdx`; 행의 `cam/preset` 이 현재와 다르면 `state.cam/state.preset` 갱신 → `renderCamSelect()` → `gotoPreset()` → `reconnectLiveIfActive()` (기존 `selectCameraposItem`(1090~1098) 패턴 **그대로 재사용**) → `drawRoiOverlay()`+`renderSlotList()` |
| 신규 | `editPlaceIdx()` — `#place-gidx` 값 → `reindexPlaceSpace(state.placeRoi, state.selectedPlaceIdx, to)`; `selectedPlaceIdx = to`; `markPlaceDirty()` |
| 신규 | `deletePlaceSpace()` — `removePlaceSpace(...)`; `selectedPlaceIdx = null`; `markPlaceDirty()` |
| 신규 | `savePlaceRoi()` — §4-3 |
| 신규 | `openPlaceRoi()` — `pickAndReadJsonFile()`(772, 재사용) → `normalizePtzCamRoi(JSON.parse(text))` → `byPreset` 비었으면 명시적 에러 → `normalizeGlobalIdx` → `state.placeRoi` 버퍼 반영(**미저장**) + `placeRoiReport` 갱신 → `markPlaceDirty()` |
| `393~410` `loadPlaceRoi` | `normalizePtzCamRoi` 직후 **`normalizeGlobalIdx` 적용**(R3 마이그레이션 진입점). `changed` 면 `#place-msg` 에 "전역번호 재부여됨(미저장) — 저장 필요" 고지 |
| `364~386` `drawFileFloorRoi` | `poly.idx === state.selectedPlaceIdx` 면 굵은 대비색(선택 하이라이트). 그 외 무변경 |
| `2469~2473` | 기존 리스너 유지. 신규 `#place-edit/#place-delete/#place-save/#place-open` 4개 배선 추가 |

### 4-3. `src/api/captureRoutes.ts` — **변경 없음 (0줄)**

**R4 '저장' 결정: 기존 `PUT /capture/place-roi` 를 전 프리셋 순차 PUT 으로 재사용. 라우트 확장 안 함.**

근거:
1. §1-1 대로 `applyPlaceRoiUpdate` 가 **payload idx 를 그대로 기록**하므로 전역번호 저장에 서버 변경이 **원리적으로 불필요**하다.
2. 프리셋 수가 **3개**(실데이터) — 순차 PUT 3회면 끝. 다중 프리셋 스키마 확장은 zod 스키마 + 신규 apply 함수 + 신규 테스트를 낳는 **순증 복잡도**(규칙 2 위반).
3. `alignApply`(`app.js:1229~1233`)가 이미 검증된 동일 호출 패턴 → 재사용.
4. **반드시 순차(await 직렬)** 로 보낼 것: 라우트가 매 요청마다 `readFile → apply → writeFile`(`captureRoutes.ts:368~370`)를 수행하므로 **병렬 PUT 은 read-modify-write 경합으로 갱신이 유실**된다. `for (const key of Object.keys(state.placeRoi)) { await fetch(...) }`.
5. 실패 처리: 하나라도 실패하면 즉시 중단 + `#place-msg` 에 실패 프리셋 명시(부분 저장 상태를 숨기지 않는다). 성공 시 `placeRoiDirty=false`.

### 4-4. `web/core.js` / `web/core.d.ts`
- 신규 4함수(§3-1~3-4) + `selectFloorRoi` 1줄 확장 + `buildSlotListGroups`·`cameraposListRows`·`parseLoadedCamerapos` 제거. `core.d.ts` 선언 동기화(`:389~390` 제거, 신규 추가).

---

## 5. 파괴적 변경 · 위험 · 완화

| # | 위험 | 영향 | 완화 |
|---|---|---|---|
| 5-1 | **Unity 재생성 시 idx 리셋** (`CParkingSpace3DTo2D.cs` 가 프리셋별 0-based 로 재기록) | 사용자가 지정한 전역번호 **소실** | `normalizeGlobalIdx` 가 로드 시 중복을 감지해 **graceful 재부여**(1..N). 데이터 손상/크래시 없음. **단 사용자 커스텀 번호는 복구 불가** → 문서에 명시. (스키마 무변경 제약 하에선 회피 불가 — 마스터 확정 사항) |
| 5-2 | Unity 가 space 에 **새 필드 추가** 시 | 저장(`applyPlaceRoiUpdate`)이 `{idx,points}` 로만 재구성 → **필드 소실** | 현재는 해당 없음(§1-2 실측). Unity 스키마 변경 시 `applyPlaceRoiUpdate` 를 `{...sp, idx, points}` 로 고쳐야 함 → 문서 경고 |
| 5-3 | **DB `parking_slots.slot_idx` 의미 변경** (C11/C12) | PK `(run_id,preset_key,slot_idx)` 는 **유효**(전역고유 ⊃ 프리셋내고유). 다만 **마이그레이션 이전 run 의 행은 옛 0-based 값**을 보존 | 신규 run 부터 전역번호로 기록됨(정상). 구 run 과 신 파일 idx 를 **§3-4 에서 `slotIdx===globalIdx` 로 매칭**하므로 구 run 은 태그가 안 붙을 뿐(graceful, 크래시 없음). 재최종화하면 정합 |
| 5-4 | **"전역 인덱스" 동음이의 2체계** | `artifact.globalIndex`(GlobalIndexer, slotId 기준) vs `PtzCamRoi.idx`(신규 전역번호) — **서로 무관** | `slot_ptz.json`/캘리브레이션은 전자만 사용(§1-3) → **정합 깨짐 없음**. 문서에 두 체계 구분 명시(혼동 방지) |
| 5-5 | 저장 중 **부분 실패** | 일부 프리셋만 파일에 반영 | 순차 PUT + 실패 즉시 중단 + 실패 프리셋 표시. dirty 플래그 유지 |
| 5-6 | 자동보정(`alignApply`)과 신규 저장의 **동시 미저장 버퍼** | 둘 다 `state.placeRoi` 를 편집 | 동일 버퍼를 공유하므로 **어느 쪽 저장이든 전역번호+좌표가 함께 반영**됨(모순 없음). `alignApply` 는 단일 프리셋만 PUT → 타 프리셋의 미저장 번호변경은 남음 → `#place-msg` dirty 표시 유지로 고지 |
| 5-7 | 기존 테스트 영향 | `test/preciseCore.test.ts` 의 `cameraposListRows`(L21~52)·`parseLoadedCamerapos`(L55~103) describe **제거 필요**. `buildSlotListGroups` 테스트가 있으면 §3-4 로 이관 | `hitTestDetections`/`removeDetection`/`applyTranslateScale`/`transformPlaceRoiPreset` 테스트(L207~277)는 **유지**. `placeRoiUpdate`/`roiEdit`/`slotInsertEdit*` **전부 무손상** |

---

## 6. 유닛테스트 목록 (vitest, `test/placeGlobalIdx.test.ts` 신규)

**`normalizeGlobalIdx`**
1. 실데이터형(0-based 중복: p1=0..6, p2=0..5, p3=0..3) → cam→preset→배열순으로 **1..17 재부여**, `changed:true`
2. 이미 1..N 고유(사용자 재지정, 순서 뒤섞임) → **무변경**(`changed:false`) ← 커스텀 번호 보존 회귀 방지
3. 누락(1,2,4) / 비정수 / 0 이하 → 재부여 `changed:true` + `issues` 기록
4. 빈 placeRoi / null / undefined → `[]`·무크래시(강등)
5. **불변성**: 원본 객체 미변형
6. 좌표(points) 보존

**`reindexPlaceSpace`**
7. from<to (3→7): 4..7 이 -1 씩 당겨지고 대상이 7 (밀어내기)
8. from>to (7→3): 3..6 이 +1 씩 밀리고 대상이 3
9. from===to → 원본 동등(no-op)
10. **경계**: `to<1` → 1 로 clamp / `to>N` → N 으로 clamp / 존재하지 않는 `from` → 원본
11. **사후조건 불변식**: 결과 idx 집합 = `{1..N}`, 중복 0 (모든 케이스 공통 assert)
12. **프리셋 소속·좌표 불변**: 대상이 원래 프리셋 배열에 그대로 남고 points 동일
13. 불변성(원본 미변형)

**`removePlaceSpace`**
14. 중간 삭제(8 삭제) → 9..17 이 8..16 으로 재압축, 총 N-1
15. 첫/마지막 삭제
16. 프리셋의 마지막 1개 삭제 → **해당 키는 `[]` 로 유지**(키 삭제 금지 — 저장 시 빈 배열 PUT 필요)
17. 없는 idx → 원본 동등
18. 불변성

**`buildFlatSlotRows`**
19. 다중 프리셋 → **globalIdx 오름차순 평면 정렬**(프리셋 경계 무시)
20. 점유: 번호판 중심이 폴리곤 내부 → `occupied:true` (computeOccupancy 재사용 확인)
21. 검출 태그(VPD/LPD) 부착
22. `parkingSlotsByKey` 존재 시 DB 행의 occupied/vpd/lpd **우선 사용**
23. 빈/누락 입력 → `[]`

**경계면·회귀**
24. **왕복(라운드트립)**: `normalizeGlobalIdx` → 전 프리셋 `applyPlaceRoiUpdate` 순차 적용 → `normalizePtzCamRoi` 재파싱 → **전역번호 1..N 이 파일에 그대로 보존**됨을 assert (서버 `src/capture/placeRoi.ts` 실함수로 교차검증 — 기존 `placeRoiUpdate.test.ts:102~127` 패턴 재사용)
25. `selectFloorRoi` 파일 모드가 `idx` 를 추가 반환하되 `quad`/`label` **기존 필드 불변**(회귀 0), LLM 모드 무변경
26. **기존 테스트 회귀 0**: `placeRoiUpdate` / `roiEdit` / `slotInsertEdit` / `slotInsertEditQa` / `preciseCore`(camerapos 2 describe 제거 후) 전량 통과

**동작 확인(경험적)**
27. 서버 기동 → `GET /capture/place-roi` → 뷰어에서 17행 평면 목록(1..17) 스크린샷
28. 수정(예: 14 → 1) → 목록 재정렬 확인 → **저장** → `GET` 재조회로 파일 반영 확인 → Unity 파일 스키마(키 집합) 불변 확인

---

## 7. 단순화 검토 (CLAUDE.md 규칙 2)

- **서버 라우트 확장 기각**: §4-3 대로 `applyPlaceRoiUpdate` 가 payload idx 를 그대로 쓰므로 **서버 0줄 변경**. 다중 프리셋 스키마는 순증 복잡도일 뿐 → 채택 안 함.
- **`추가` 버튼 placeRoi 전환 기각**: placeRoi 는 드래그 편집기가 없어(§2 근거 1) 추가해도 배치 불가 → 편집기까지 만들면 요구 범위를 크게 초과. **기존 artifact 기반 유지**가 최소 변경.
- **마이그레이션을 "항상 재부여"로 하지 않음**: 이미 1..N 고유면 **손대지 않는다**(§3-1). "항상 재부여"가 코드는 더 짧지만 **사용자가 지정한 번호를 매 로드마다 파괴**한다 — 정확성 우선.
- **DB/캘리브레이션 마이그레이션 코드 불필요**: §1-3/§1-4 실측 결과 `slot_ptz.json` 은 PtzCamRoi.idx 를 쓰지 않고 DB PK 도 안전 → **마이그레이션 스크립트 0개**. (사전 우려였던 최대 리스크가 실측으로 해소됨)
- 신규 코드 총량 추정: `core.js` 순수함수 4개 ≈ 90줄, `app.js` 핸들러 5개 ≈ 90줄, `index.html` ≈ 10줄, **삭제** ≈ 130줄(cpreset 박스+핸들러+고아함수) → **순증 ≈ +60줄**.

---

## 8. 미해결 / 승인 요청

1. **[승인 필요] §2 권장안 A**(artifact 도구 존치 + 서브툴바 분리) vs 대안 B(artifact 도구를 매핑 탭 이관). 기본값 A 로 진행.
2. **[확인]** `삭제` 버튼 2개(`슬롯 삭제`=artifact / `삭제`=PtzCamRoi) 병존 — A안의 UX 부채. 수용 가능한지.
3. **[고지]** Unity 재생성 시 사용자 커스텀 전역번호는 **복구 불가**(스키마 무변경 제약의 필연적 귀결, §5-1). 마스터 확정 사항이므로 그대로 진행하되 문서에 경고 기재.
