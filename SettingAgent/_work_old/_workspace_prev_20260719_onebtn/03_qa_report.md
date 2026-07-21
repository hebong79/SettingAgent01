# 03. 검증 리포트 — 원버튼 셋업 파이프라인 (수집→최종화→센터라이징 자동 연쇄)

**검증자(qa-tester)**: 설계서 §6a T1~T9 + 라우트 케이스 전건 vitest 커버. 상태머신·가드·라우트는 완전 커버, 실 VPD 미가동 전체 체인 실동작은 한계로 명시(아래 §6).
**정본 설계서**: `docs/20260719_130352_원버튼셋업파이프라인_설계서.md` / **구현 노트**: `_workspace/02_developer_changes.md`

---

## 1. 작성·가산 테스트 목록

| 파일 | 신규/가산 | 케이스 수 | 대상 |
|------|-----------|-----------|------|
| `test/setupPipeline.test.ts` | **신규** | 15 | SetupPipeline 순수 상태머신·가드 3종·coverage·isBusy·콜백가드 (T1~T8, F6/F10) |
| `test/captureRoutes.test.ts` | 가산(기존 무수정) | +7 | autoChain 스키마 · onCaptureStart 배선 · GET /capture/pipeline shape · isBusy 409 · 미주입 404 |
| `test/captureJob.test.ts` | 가산 | +2 | T9 — onFinished 콜백 throw 흡수(done/stopped 경로) |
| `test/ptzCalibrator.test.ts` | 가산 | +1 | T9 — onFinished 콜백 throw 흡수(done 경로) |

합계 **+25 테스트**. 전부 fake deps/스텁(camera/vpd/lpd/finalizer/calibrator/job 모킹) — 외부 REST 미접촉.

### 1a. setupPipeline.test.ts 케이스 의도 (설계서 §6a T1~T9)

- **T1 정상 체인**: `capturing→finalizing→calibrating→done`. finalize→start **호출 순서**(`invocationCallOrder`), stage 전이, `coverage{1,1,0}`, `finalize{slots:3,globalCount:5}`, onCalibrateFinished('done')→done+endedAt.
- **T2 비무장**(`onCaptureStart(false)`): 이후 콜백 전부 no-op → finalize/start **미호출**, `{armed:false,stage:'idle'}` 유지. 수동 흐름 회귀 0의 구조적 보장.
- **T3 stopped/error**: `failed{capture}`, finalize 미호출(2케이스).
- **T4 dets 0 (F10)**: `failed{finalize,'검출 0건 — finalize 미실행(DB 보호)'}`, **finalizer.finalize 스파이 0회** — replaceSlotSetup DELETE+INSERT 데이터 파괴 차단 봉인.
- **T5 finalize throw**: `failed{finalize, err.message}`, **calibrator.start 미호출**(센터라이징 미발화).
- **T6 LPD 타깃 0 (F6)**: 전 슬롯 lpd=null → `done`+note, **calibrator.start 미호출**(빈 slot_ptz.json 덮어쓰기 방지), `coverage{targets:0,totalSlots:2,uncovered:2}`.
- **T7 센터라이징 실패**: `calibrator.start` throw('already running') → `failed{calibrate}` / `onCalibrateFinished('error')` → `failed{calibrate,'calibrate error'}`(2케이스).
- **T8 재무장·disarm**: failed 종단 후 `onCaptureStart(true)` → failure/coverage/note/endedAt 클리어 + capturing / done 종단 후 `onCaptureStart(false)` → idle·armed=false.
- **coverage 정확성**: 혼합 lpd(3행 중 2행 보유) → `{targets:2,totalSlots:3,uncovered:1}`.
- **isBusy**: idle/capturing=false, **finalizing**(수동 게이트로 관측)·calibrating=true, done=false — /capture/start 409 가드 소스 검증.
- **콜백 가드**: capturing 중 onCalibrateFinished no-op / done 종단 후 onCaptureFinished 재호출 no-op(finalize 재실행 0).

---

## 2. 실행 결과 (그대로)

### 2a. 신규/가산 파일 단독

```
npx vitest run test/setupPipeline.test.ts test/captureRoutes.test.ts test/captureJob.test.ts test/ptzCalibrator.test.ts
 ✓ test/captureJob.test.ts   (28 tests)
 ✓ test/ptzCalibrator.test.ts (통과)
 ✓ test/setupPipeline.test.ts (15 tests)
 ✓ test/captureRoutes.test.ts (56 tests)
 Test Files  4 passed (4)
      Tests  109 passed (109)
```

### 2b. 전체 회귀

```
npx vitest run
 Test Files  164 passed (164)
      Tests  1833 passed (1833)
```

- 구현자 확인치 **1808 통과 + 신규 25 = 1833** → **회귀 0**. 기존 테스트 무수정 통과(콜백·플래그·라우트 전부 옵셔널·가산).

### 2c. 타입체크

```
npx tsc --noEmit   →  EXIT 0 (에러 0)
```

`tsconfig.include` 가 `test/**/*.ts` 포함 — 신규 테스트 전부 타입 통과.

---

## 3. 경계면 교차 결과 (qa 핵심 — 스텁이 실제 시그니처와 정합)

파이프라인이 부르는 메서드의 인자/반환 shape 을 실제 소스와 교차 확인. **불일치 없음.**

| 경계 | 실제 시그니처(소스) | 파이프라인 호출·소비 | 정합 |
|------|--------------------|--------------------|------|
| `Finalizer.finalize` | `finalize(snapshot: CaptureSnapshot, opts?: {logicOccupancy?}): Promise<FinalizeResult{artifact,slots,globalCount,occupancyAgreement?}>` | `finalize(snapshot, {})` 호출, `result.slots`·`result.globalCount` 만 읽음 | ✓ 테스트가 `calls[0]=[snapshot,{}]`·dets 전달·slots/globalCount 반영 확인 |
| `PtzCalibrator.start` | `start(slotIds?: string[]): {total}` | `calibrator.start()` **인자 없이** 호출(전 대상 펼침 위임) | ✓ 테스트가 `start.mock.calls[0].length===0` 확인 |
| `SqliteStore.getSlotSetup` | `getSlotSetup(): SlotSetupView[]` (lpd: NormalizedQuad\|null 포함) | `store.getSlotSetup()` → `expandPlateTargetsFromSlotSetup(views)` (lpd!=null 카운트) | ✓ 스텁이 실제 SlotSetupView 전 필드(rectToQuad 로 유효 lpd) 제공 — 다른 테스트(calibrateRoutes/ptzCalibrator)와 동일 픽스처 패턴 |
| 라우트↔파이프라인 | 라우트: `pipeline.isBusy()`·`pipeline.getStatus().stage`·`pipeline.onCaptureStart(autoChain ?? false)`; GET `/capture/pipeline`→`getStatus()` | captureRoutes 테스트는 **실제 SetupPipeline** 주입(calibrator 만 스텁) → 라우트 실동작으로 배선 확인 | ✓ autoChain:true 후 GET pipeline `{armed:true,stage:'capturing',startedAt:'T'}` 관측 |

`getStatus()` 응답 shape(`{armed,stage,startedAt?,endedAt?,failure?,finalize?,coverage?,note?}`)은 조건부 스프레드로 undefined 필드 생략 — 테스트가 idle 시 정확히 `{armed:false,stage:'idle'}` 임을 `toEqual` 로 봉인(GET /capture/pipeline 소비 계약).

---

## 4. 가드 3종 봉인 확인 (데이터 파괴 방지 핵심)

- **F10 (dets 0)**: `finalizer.finalize` 스파이 **0회** 단언 — DB(slot_setup) DELETE+INSERT 파괴 차단이 코드로 봉인됨.
- **가드2 (finalize throw)**: `calibrator.start` 스파이 **0회** — 최종화 실패 시 센터라이징으로 넘어가지 않음.
- **F6 (LPD 타깃 0)**: `calibrator.start` 스파이 **0회** + done+note — 빈 slot_ptz.json 덮어쓰기 방지.

세 가드 모두 "미호출" 을 스파이 호출 횟수로 직접 증명(위장 성공 불가).

---

## 5. 발견 이슈

- **소스 결함: 없음.** SetupPipeline 상태전이·가드·라우트 배선이 설계서 §3/§6a 와 정합. 경계면 불일치 없음.
- **테스트 자체 버그: 없음**(신규 작성분 전건 통과, tsc 0).
- 구현 노트 §6 의 프론트(app.js) pollPlan 보정 항목은 **DOM/브라우저 영역**이라 vitest 유닛 범위 밖 — 아래 §6 한계로 이관.

---

## 6. 검증 한계 (은닉 금지 — 못 한 검증 명시)

1. **실 VPD/LPD/카메라 미가동 전체 체인 실동작 미관찰**: 순수 상태머신·가드·라우트는 vitest 로 **완전 커버**했으나, 실제 VPD 검출→finalize→PlatePtz 센터라이징이 물리 카메라와 도는 **엔드투엔드 실동작**은 서비스 미가동으로 미실행. 리더가 라우트 라이브(`GET /capture/pipeline` 응답 전이)로 배선은 확인했고, 실 체인 실동작은 미관찰(설계서 §6b L1~L6 은 실서버·DOM 필요).
2. **프론트 연쇄(web/app.js) 미검증**: `pollPipeline`/`capPoll` 체인-폴 유지·`calPoll` 재기동·오버레이 자동 갱신(구현 노트 §4)은 브라우저 DOM 의존 → vitest 유닛 범위 밖. `node --check web/app.js`(구문)만 구현자가 확인, 런타임 동작은 라이브(13020) 수동 확인 영역.
3. **스텁 경계**: SetupPipeline 테스트는 finalizer/calibrator/job/store 를 스텁으로 대체 → 각 실객체 내부 로직(finalize 집계·PlatePtz 폐루프)은 **각자의 기존 테스트**(finalizer*/ptzCalibrator*/captureJob* 다수)가 별도 커버. 본 검증은 **오케스트레이션 계층(상태·가드·배선)** 에 한정.

---

## 7. 결론

- 설계서 §6a **T1~T9 + 라우트 3케이스 전건 통과**, 가드 3종(F6/F10/finalize-throw) 데이터 파괴 방지 스파이로 봉인.
- **회귀 0**(1808→1833, 기존 무수정), **tsc 0**, 경계면 불일치 0.
- 실 서비스 엔드투엔드·프론트 DOM 연쇄는 유닛 범위 밖 한계(§6) — 리더 라이브 확인 영역으로 이관. 순수 상태머신·가드·라우트는 완전 커버.
