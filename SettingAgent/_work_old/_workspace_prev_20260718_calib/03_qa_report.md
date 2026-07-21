# 03. 센터라이징 소스 전환(setup_artifact → slot_setup) 검증 리포트

작성: 검증자(qa-tester)
근거: `_workspace/01_architect_plan.md`, `_workspace/02_developer_changes.md`, 변경 소스(`slotPtzWriter.ts`/`PtzCalibrator.ts`), 설계서 §5 + developer §3 이관 항목.
검증 도구: `npx tsc --noEmit`(exit 0) + `npx vitest run`(전체).

---

## 1. 전체 vitest 결과 (있는 그대로)

| 구분 | 착수 전 | 검증 후 |
|---|---|---|
| Test Files | 151 passed / **2 failed** (153) | **153 passed** (153) |
| Tests | 1682 passed / **18 failed** (1700) | **1707 passed** (1707) |
| tsc --noEmit | — | **exit 0** (에러 0) |

- 착수 전 실패 2파일 = `test/centeringSlot.test.ts`(17건) + `test/centeringBoundary.test.ts`(1건) = **18건**. 모두 developer 가 "컴파일만 맞춰둠(런타임 red)" 으로 이관한 파일. 원인은 신 소스(`store.getSlotSetup()`)가 `lpd=null` 시드 → `total 0` 로 강등되어 `items[0]` 이 undefined 가 되는 것(빈 소스 → 대상 0).
- 검증 후 **전량 그린**. 순증 테스트 7건(신설 slotPtzWriter 5 + ptzCalibrator saveCenteringSlots 2). 1700 + 7 = 1707 정합.

착수 시점 재현 로그(대표):
```
FAIL test/centeringSlot.test.ts > T14 ... expected [] to have a length of 2 but got +0
FAIL test/centeringSlot.test.ts > T13 ... Cannot read properties of undefined (reading 'converged')
FAIL test/centeringBoundary.test.ts > ... expected total 2 (lpd_obb=null → getSlotSetup lpd=null → total 0)
```

---

## 2. 신설·수정 테스트 목록

### (A) 신설 로직 — `test/slotPtzWriter.test.ts` (기존 파일에 describe 추가, 병합)
기존 `expandPlateTargets`(@deprecated)·`writeSlotPtz` 회귀는 **존치**하고, 신 함수용 describe `expandPlateTargetsFromSlotSetup (신 소스 · 설계서 §5-A)` 5건 추가:
- (a) lpd 보유 행만 대상 — `[view(1), view(2,{lpd:null}), view(3)]` → length 2, `globalIdx=[1,3]`(빈 주차면 제외).
- (b) 매핑 정확성 — `camIdx=v.camId`, `presetIdx=v.presetId`, `slotId=String(v.slotId)`(타입 string 단언), `globalIdx=v.slotId`(정수), `plateRoi=quadBoundingRect(v.lpd)`, `presetSlotIdx=v.presetSlotIdx`(그대로).
- (b) `presetSlotIdx=null` → 그대로 null(0/−1 발명 금지).
- (c) 빈 입력 → `[]`, lpd 전부 null → `[]`.

### (B) `test/ptzCalibrator.test.ts` — saveCenteringSlots 경계 검증 추가 (developer §3-A 이관 요망분)
`storeWithSink()` 헬퍼(upsertSlotCentering rows 캡처) 추가 + describe 2건:
- 수렴 성공 → `upsertSlotCentering` **1회** 호출, `row.slotId===7`(정수, typeof number), `centered===1`, `SlotCenteringRow` 키 완전성(`centered/img1/pan/slotId/tilt/updatedAt/zoom`), `{pan,tilt,zoom}===item.ptz`, `row.slotId===item.globalIdx`.
- 빈 소스(lpd 슬롯 0) → `upsertSlotCentering` **미호출**(빈 rows 스킵).
- 기존 5시나리오(수렴·순서·no_plate·maxIter·다수번호판·중복시작·빈소스 total 0)는 불변 그린.

### (C) `test/centeringSlot.test.ts` — 런타임 로직 개편 (developer §3-D 이관, red→green)
- 시드에 lpd 주입: `slotRow(...).lpdObb: JSON.stringify(rectToQuad({0.62,0.62,0.05,0.03}))` (구 `null`).
- 소스 시임 재구성: `emptyStore()`/`repoWith`/`artifact2()` (신 소스에서 고아) **제거** → `viewRow()`/`storeWith()` 도입. `makeCalibrator` 기본 store = `storeWith([viewRow(7,1)])`(globalIdx=7 유지).
- **문자열 slotId 단언 조정**: T10 부분 재실행 필터 `cal2.start(['c1p1s1'])` → `cal2.start(['1'])`(신 소스 `slotId=String(정수)`). ★ 이 미조정 시 필터가 0건 매칭되어 조용히 오통과할 위험이 있었음 — 교정.
- T13(DB 예외 격리): 스텁 `getSlotSetup: () => [viewRow(7,1)]`(대상 1건 소싱해 converged=true 재현) + upsert throw.
- T8: "store 미주입" → store 필수화로 무의미해져 "기본 store 소스 잡 완료(1건)" 로 의미 갱신.
- 물리·경계 단언(T1 gain 체이닝·prior 갱신, T7 멱등, T10 부분 UPDATE 범위, T11 실패 미갱신, T14 밀림 없음) 모두 **불변 유지**. 결과 19건 그린.

### (D) `test/centeringBoundary.test.ts` — 경계면 왕복 개편 (developer §3-C 이관, red→green)
- `replaceSlotSetup` 2행 `lpdObb: null` → lpd OBB(JSON quad) 시드 → `POST /calibrate/ptz` `total=2` 복원.
- 문자열 slotId 단언 `'c1p1s1'/'c1p1s2'` → `'1'/'2'`(신 소스). `item.globalIdx`(1,2)·`row.preset_slotidx`(1,2, 1-based)·`{pan,tilt,zoom}===item.ptz` 교차 비교는 유지. 1건 그린.

### (E) 회귀 — `test/calibrateRoutes.test.ts` (developer 가 전환 완료분)
- 8건 전량 그린. `items[0].slotId==='1'`(신 소스), start 200 / 409 / zod 400 / status / result 404·200 계약 불변 확인.

---

## 3. 경계면 교차 검증 결과 (핵심)

검증 축: **slot_setup.slot_id(정수) ↔ upsertSlotCentering slot_id(정수) ↔ SlotCenteringRow shape ↔ REST item.slotId(문자열)**

| 경계 | 소스 | 소비 | 결과 |
|---|---|---|---|
| slot_id 타입 | `slot_setup.slot_id`(INTEGER PK) → `getSlotSetup().slotId`(number) | `expandPlateTargetsFromSlotSetup.globalIdx = v.slotId`(number) | ✅ 정수 보존 |
| PlateTarget.slotId | `String(v.slotId)`(문자열) | REST `item.slotId`, `slotIds` 필터 | ✅ 전부 문자열 계약(`'1'`,`'7'`). T10 필터·centeringBoundary 단언 정합 |
| DB 쓰기 키 | `saveCenteringSlots`: `rows[].slotId = it.globalIdx`(정수) | `upsertSlotCentering(rows)` → `slot_setup` slot_id UPDATE | ✅ 정수 slot_id 로 부분 UPDATE(타 슬롯 기하 불변, T10 확인) |
| SlotCenteringRow shape | `{slotId,pan,tilt,zoom,centered,img1,updatedAt}` | `capture/types.ts` 인터페이스 | ✅ 키 7종 완전 일치(ptzCalibrator 신설 테스트가 `Object.keys` 단언) |
| PTZ 왕복 | `item.ptz{pan,tilt,zoom}`(JSON) | `slot_setup` REAL 3컬럼 pan/tilt/zoom | ✅ `{pan:row.pan,tilt:row.tilt,zoom:row.zoom}===item.ptz`(centeringBoundary 경계3, centeringSlot T7) |
| plateRoi 유도 | `v.lpd`(NormalizedQuad) | `quadBoundingRect(v.lpd)`(NormalizedRect) | ✅ quad→축정렬 rect. `getSlotSetup` 이 `lpd_obb` JSON → `NormalizedQuad` 파싱(SqliteStore:244) |
| 1-based 규약 | `cam_id/preset_id/preset_slotidx` | REST item·DB row | ✅ camIdx=1, presetIdx=1, preset_slotidx=1/2(0 아님) |
| lpd 필터 | `v.lpd == null` 행 | 대상 펼침 제외 | ✅ 빈 주차면 제외(slotPtzWriter (a)), 전부 null → total 0(빈 소스 정상 완료) |

**불일치 발견: 0건.** 소스 전환의 유일한 의미 변화(`item.slotId`: 구 `'c1p1s1'` → 신 `String(정수)`)는 모든 소비 지점(REST 단언·slotIds 필터·DB 매핑)에서 일관되게 반영됨을 실 파일 DB+실 writer+실 라우트 왕복(centeringBoundary)으로 확인.

---

## 4. 남은 한계 / 미결

- **라이브 스모크(POST /calibrate/ptz 실 장비) 누락**: 리더가 직접 수행하기로 분담. 본 검증은 vitest(카메라/LPD 모킹)·경계면 교차에 한정. 실 VPD/LPD/카메라 REST 연동 스모크는 **미수행**(위장·삭제 아님, 명시적 누락).
- **`PtzCalibrator.saveCenteringSlots` 의 `if (!this.store) return;`**: store 필수화로 사실상 dead 코드. 설계서가 saveCenteringSlots 를 불변으로 지정해 developer 가 그대로 둠 — 런타임 무해(항상 false). 리뷰어 판단 시 제거 가능(검증 결과에 영향 없음).
- **`expandPlateTargets`(@deprecated) 존치**: 런타임 소비처 0(PtzCalibrator 는 신 함수 사용). exported 표면·회귀 테스트(slotPtzWriter/centeringSlot T9)만 참조. 삭제는 별도 정리 작업 범위.
- **회귀 커버리지**: 전체 153파일/1707건 그린으로 platePtz·SqliteStore·집계 등 인접 모듈 무영향 확인.

---

## 5. 결론

설계서 §0 성공 기준(`getSlotSetup()` 의 lpd!=null 슬롯 N개 → `total=N`, 성공 슬롯 `slot_setup` 행 pan/tilt/zoom/centered=1 부분 UPDATE + `slot_ptz.json` 병행 저장)을 유닛·경계면 수준에서 **전량 충족**. tsc 0 에러, vitest 1707 전건 통과. 경계면 불일치 0건. developer 재수정 요청 없음(전 항목 그린).
