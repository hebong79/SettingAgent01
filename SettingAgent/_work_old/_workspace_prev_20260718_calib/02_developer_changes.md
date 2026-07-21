# 02. 센터라이징 소스 전환 구현 변경요약 (setup_artifact → slot_setup)

작성: 구현자(developer) / 근거: `_workspace/01_architect_plan.md`
검증 상태: `npx tsc --noEmit` **통과(exit 0)**. 명명된 테스트 2종(ptzCalibrator, calibrateRoutes) **런타임 통과(15/15)**.

---

## 1. 프로덕션 소스 변경 (파일별 diff 요지)

### `src/calibrate/slotPtzWriter.ts`
- **신설** `expandPlateTargetsFromSlotSetup(views: SlotSetupView[]): PlateTarget[]`.
  - `v.lpd == null` 행 제외. 매핑: `camIdx=v.camId`, `presetIdx=v.presetId`, `slotId=String(v.slotId)`, `globalIdx=v.slotId`(정수, 항상 존재), `plateRoi=quadBoundingRect(v.lpd)`, `presetSlotIdx=v.presetSlotIdx`(DB 값 그대로, 재계산 없음).
- `import type { SlotSetupView } from '../capture/types.js'` 추가.
- 기존 `expandPlateTargets(artifact)` 는 **존치** + `@deprecated` JSDoc 부착(설계 §3). 삭제 안 함 → `SetupArtifact`/`logger` import 그대로 사용 중(고아 아님).

### `src/calibrate/PtzCalibrator.ts`
- `PtzCalibratorDeps.store` 타입 확대+**필수화**: `store: Pick<SqliteStore, 'upsertSlotCentering' | 'getSlotSetup'>` (옵셔널 `?` 제거). 필드도 동일하게 non-optional.
- `PtzCalibratorDeps.repo` / `private readonly repo` / `this.repo = deps.repo` **제거**.
- import 정리: `import type { Repository }` 제거, `expandPlateTargets` → `expandPlateTargetsFromSlotSetup` 로 교체(`writeSlotPtz` 유지).
- `start()` 본문 교체:
  - 제거: `this.repo.loadArtifact()` + `if (!artifact) throw new Error('no setup artifact')` + `expandPlateTargets(artifact)`.
  - 추가: `let targets = expandPlateTargetsFromSlotSetup(this.store.getSlotSetup());`
  - `slotIds`(문자열) 필터·상태 세팅·`void this.run(targets)`·리턴 shape **불변**.
- `calibrateSlot` / `saveCenteringSlots` / `startPtzFor` / PlatePtz 위임·순서(center→zoom) **불변**.

### `src/index.ts` (73행)
- `new PtzCalibrator({ camera, lpd, repo, cfg, store })` → `repo` 인자 제거: `new PtzCalibrator({ camera, lpd, cfg: tools.calibrate, store: sqlite })`.
- `repo` 지역변수는 orchestrator/finalizer/buildServer 등에서 계속 사용 → 그대로 유지(전역 영향 없음).

---

## 2. tsc 결과
```
cd SettingAgent && npx tsc --noEmit  →  exit 0 (에러 0)
```
`src/**` 프로덕션 컴파일 클린. `Repository` 전역 사용처(server/orchestrator/Finalizer) 무변.

---

## 3. 테스트 변경 (컴파일/시그니처 정합 최소 수정) — qa 개편 포인트

설계서는 `ptzCalibrator.test.ts` / `calibrateRoutes.test.ts` 2종만 지목했으나,
`repo`→`store` 시그니처 전환으로 **추가 2종**(`centeringBoundary.test.ts`, `centeringSlot.test.ts`)도 컴파일이 깨졌다(설계서 under-scope). 4종 모두 tsc 통과하도록 조치했고, 런타임 로직 재작성은 아래대로 qa 로 이관한다.

### (A) `test/ptzCalibrator.test.ts` — **전환 완료·런타임 그린**
- `artifact()`+`repoWith()` → `views()`(SlotSetupView, slot_id=7)+`storeWith(v)` 로 교체. import: `Repository`/`SetupArtifact` 제거, `SqliteStore`/`SlotSetupView` 추가.
- `makeCalibrator(over, v: SlotSetupView[] = views())` 로 시그니처 변경, `store: storeWith(v)` 주입.
- "setup_artifact 없음 → throw" 테스트 → **"lpd 슬롯 0(빈 배열) → total 0, state done"** 로 교체(더 이상 throw 아님, 설계 5-B).
- **qa 확인**: 시나리오 5종(수렴·순서·no_plate·maxIter·다수번호판) 단언 불변으로 그린 확인. saveCenteringSlots→upsertSlotCentering(slot_id=7,centered=1) 호출 검증 **미추가**(설계 5-B 지목) → qa 추가 요망.

### (B) `test/calibrateRoutes.test.ts` — **전환 완료·런타임 그린**
- `storeWith()`(SlotSetupView, slot_id=1) 헬퍼 추가. `PtzCalibrator` 생성 2곳(`makeServer`, 409 테스트)에서 `repo` 제거·`store: storeWith()` 주입. orchestrator/buildServer 의 `repo` 는 유지.
- **단언 1건 변경**: `items[0].slotId` 기대값 `'c1p1s1'` → **`'1'`**(신 소스는 `slotId=String(정수 slot_id)`). 이 의미변화는 소스 전환의 직접 귀결 — qa 재확인 요망.

### (C) `test/centeringBoundary.test.ts` — **컴파일만 수정, 런타임 qa 이관**
- `PtzCalibrator` 생성에서 `repo,` 만 제거(`store` 는 이미 실 SqliteStore 주입 상태).
- **qa 필수 개편(런타임 red)**:
  1. `replaceSlotSetup` 시드 2행의 `lpdObb: null` → **lpd OBB(JSON quad) 시드**(예: `JSON.stringify(rectToQuad({x:0.62,y:0.62,w:0.05,h:0.03}))`). 안 하면 `getSlotSetup` lpd=null → `total 0`(테스트는 2 기대).
  2. slotId 키 단언 `'c1p1s1'`/`'c1p1s2'` → `'1'`/`'2'`(신 소스 String(int)). globalIdx(1,2)·preset_slotidx(1,2) 경계 비교는 유지 가능.

### (D) `test/centeringSlot.test.ts` — **컴파일만 수정, 런타임 qa 이관**
- `emptyStore()` 헬퍼 추가. `makeCalibrator` 기본 주입을 `repo: repoWith(a)` → `store: emptyStore()` 로 교체(2번째 인자 `a`는 잔존하나 신 소스에서 미사용 — qa 가 views/seededStore 로 대체).
- T13(DB 예외 격리) store 스텁: 타입 `Pick<SqliteStore,'upsertSlotCentering'>` → `|'getSlotSetup'` 확대 + `getSlotSetup: () => []` 추가.
- **qa 필수 개편(런타임 red)**: `seededStore` 의 `slotRow(...).lpdObb: null` → lpd OBB 시드, `makeCalibrator` 기본/override 를 store 소스로 재구성, T13 은 view 1건 주입해 converged=true 재현. 명령 PTZ 물리(T1~T9) 자체는 불변.

### (E) **신설 요망** `test/slotPtzWriter.test.ts` (설계 5-A) — qa 담당
- `expandPlateTargetsFromSlotSetup` 매핑/필터 유닛테스트(lpd!=null 2 + lpd==null 1 → length 2, 각 필드, 빈 입력 → []).

---

## 4. 주의/미결
- **`PtzCalibrator.saveCenteringSlots` 의 `if (!this.store) return;`**: `store` 필수화로 이제 항상 false(사실상 dead). 설계서가 saveCenteringSlots 를 **불변**으로 명시하여 그대로 두었다(외과적 변경 원칙). 리뷰어/qa 판단 시 제거 가능.
- 설계서 §2 표는 테스트 영향으로 2파일만 명시했으나 실제 4파일 영향 — 위 (C)(D) 를 문서화·qa 에 반영 요망.
- 프로덕션 런타임 계약(`/calibrate/ptz|status|result` shape·상태코드) 불변. `total` 의미만 "artifact 펼침 수" → "lpd 보유 slot_setup 수".
