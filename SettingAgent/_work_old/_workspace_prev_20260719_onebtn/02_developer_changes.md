# 02. 구현 변경 노트 — 원버튼 셋업 파이프라인 (수집→최종화→센터라이징 자동 연쇄)

**정본 설계서**: `SettingAgent/docs/20260719_130352_원버튼셋업파이프라인_설계서.md`
**계획**: `_workspace/01_architect_plan.md`
**구현자(developer)**: 설계서 §2~§6 그대로 실행. 오케스트레이션 계층만 신설, 기존 로직 무수정(콜백 훅만 가산).

---

## 1. 변경 파일·요지 표

| # | 파일 | 신규/수정 | 요지 | 라인(대략) |
|---|------|-----------|------|-----------|
| 1 | `src/pipeline/SetupPipeline.ts` | **신규** | 3단계 전용 인메모리 상태머신(idle→capturing→finalizing→calibrating→done\|failed). 가드 3종·커버리지 리포트. | 176줄 |
| 2 | `src/capture/CaptureJob.ts` | 수정 | `CaptureJobDeps.onFinished?` 옵셔널 콜백 가산 + `finishRun()` 말미 try/catch 흡수 호출. | +11 |
| 3 | `src/calibrate/PtzCalibrator.ts` | 수정 | `PtzCalibratorDeps.onFinished?` 옵셔널 + private 필드 + `run()` done/error 경로에서 `notifyFinished()`(흡수). | +18 |
| 4 | `src/api/captureRoutes.ts` | 수정 | `StartBodySchema.autoChain?` 스키마 · start 핸들러 `isBusy()` 409 가드 · `onCaptureStart()` 배선 · `CaptureRouteDeps.pipeline?` · `GET /capture/pipeline` 등록. | +25 |
| 5 | `src/api/server.ts` | 수정 | `ApiDeps.pipeline?` + `registerCaptureRoutes` 로 전달. | +4 |
| 6 | `src/index.ts` | 수정 | 클로저 전방참조 조립: `let pipeline` 선언 → CaptureJob/PtzCalibrator `onFinished` 클로저 → dep 완비 후 `pipeline = new SetupPipeline({...})` → buildServer 전달. | +12 |
| 7 | `web/index.html` | 수정 | 정밀수집 패널에 체크박스 `#cap-autochain`(기본 unchecked). | +1 |
| 8 | `web/app.js` | 수정 | capStart 바디 `autoChain` + `prevPipelineStage` 리셋 · `prevPipelineStage` 변수 · `pollPipeline()` 함수 · capPoll 병행조회+체인 폴 유지. | +50 |

> 세션 시작 시점 git status 에 이미 M 으로 있던 파일(`calibrateRoutes.ts`, `platePtz.ts`, `slotPtzWriter.ts`, `Finalizer.ts`, `SqliteStore.ts`, `types.ts`, `ground/project.ts`, `cameraposWriter.ts`, `Repository.ts`, `SaveStore.ts`, `migrateToSettingDb.ts`, `core.js`, `core.d.ts`, `util/round.ts`)은 **브랜치 선행 변경**으로 이번 작업과 무관 — 손대지 않음.

---

## 2. 상태전이·가드 구현 방식 (SetupPipeline)

상태머신은 설계서 §3.2 전이도를 그대로 하드코딩. 콜백 3개 + 조회 2개 공개 API.

- **`onCaptureStart(armed)`**: 종단·idle 어디서든 호출 시 status 전부 리셋(failure/finalize/coverage/note/endedAt 클리어). armed=true → `stage='capturing'`+startedAt, false → `stage='idle'`. **비무장이면 이후 콜백 전부 no-op**(수동 흐름 구조적 회귀 0).
- **`onCaptureFinished(status)`**: `!armed || stage!=='capturing'` → no-op. `stopped`→failed{capture,'stopped(수동 정지)'}, `error`→failed{capture,'capture error'}, `done`→ **snapshot.dets.length 검사**.
  - **가드1 (F10)**: `dets===0` → `failed{finalize,'검출 0건 — finalize 미실행(DB 보호)'}` — **finalizer.finalize 를 아예 부르지 않는다**(replaceSlotSetup DELETE+INSERT 데이터 파괴 차단).
  - dets>0 → `stage='finalizing'` + `void runFinalizeThenCalibrate(snapshot)`(비동기 발화).
- **`runFinalizeThenCalibrate`(private async)**:
  - `finalizer.finalize(snapshot, {})` — **logicOccupancy 미전달**(헤드리스 체인엔 프론트 점유 스냅샷 없음, §3.5·A-3).
  - **가드2**: finalize throw → `failed{finalize, err.message}` — **calibrator.start 미발화**(센터라이징으로 안 넘어감).
  - 성공 → `finalize={slots,globalCount}` 기록 → `store.getSlotSetup()` → `expandPlateTargetsFromSlotSetup(views)`(slotPtzWriter 기존 export 재사용, lpd 판정 중복 구현 금지) → `coverage={targets,totalSlots,uncovered}`.
  - **가드3 (F6)**: `targets.length===0` → `note='센터라이징 스킵 — LPD 보유 슬롯 0'` + `finish('done')` — **calibrator.start 미호출**(빈 slot_ptz.json 덮어쓰기 방지).
  - targets>0 → `stage='calibrating'`(start 호출 **전**에 전이 — 빠른 완료 콜백이 stage 를 놓치지 않도록) → `calibrator.start()`(try/catch: 수동 경합 'already running' 등 → `failed{calibrate}`, §5.3 정직 실패).
- **`onCalibrateFinished(state)`**: `!armed || stage!=='calibrating'` → no-op. `done`→finish('done'), `error`→failed{calibrate,'calibrate error'}.
- **`isBusy()`**: `stage∈{finalizing,calibrating}` — /capture/start 409 가드 소스.
- **`getStatus()`**: PipelineStatus. 조건부 스프레드로 undefined 필드 생략(CaptureStatus 패턴). 카운트·문자열만 — round5 비대상(§3.4).

콜백 흡수: CaptureJob.finishRun / PtzCalibrator.notifyFinished 가 각자 try/catch 로 콜백 throw 를 흡수 — **잡을 절대 죽이지 않는다**(설계서 §4 표, T9).

---

## 3. 배선 (index.ts 클로저 전방참조)

생성 순서 역전 해소: `captureJob`·`calibrator` 는 `pipeline` 을 완료콜백으로 필요로 하고, `pipeline` 은 그 둘 + finalizer + sqlite 를 dep 로 필요로 한다.

```ts
let pipeline: SetupPipeline | undefined;                         // 전방 선언
const captureJob = new CaptureJob({ ..., onFinished: (s) => pipeline?.onCaptureFinished(s) });
// ... finalizer 생성 ...
const calibrator = new PtzCalibrator({ ..., onFinished: (s) => pipeline?.onCalibrateFinished(s) });
pipeline = new SetupPipeline({ job: captureJob, finalizer, calibrator, store: sqlite });  // dep 완비 후 할당
// buildServer({ ..., pipeline })
```

클로저는 `pipeline?.` 로 undefined-safe. 콜백은 런타임(잡 종단)에만 발화 → 그 시점엔 이미 할당 완료. server.ts 는 `deps.pipeline` 을 registerCaptureRoutes 로 그대로 전달(주입 시에만 라우트·배선 활성 — 가산).

---

## 4. 프론트(web/app.js) 연쇄 처리 — F7/F8 한계 보정

설계서는 "F7·F8 덕에 프론트 연쇄 대부분 공짜"라 했으나, **실측 확인 결과 `pollPlan(state)` 은 capture 가 `done` 이면 poll 을 멈추고, `calPoll` 도 `idle` 이면 자기 스케줄을 멈춘다**(둘 다 pollPlan 기반). 즉 capture done 후 백엔드가 finalize→calibrate 를 돌려도 프론트 폴이 죽어 추종 불가. 이를 최소 보정:

- **capPoll 체인-폴 유지**: capPoll 말미에서 `await pollPipeline()` 병행 조회 후, `chainBusy = pl.armed && stage∈{capturing,finalizing,calibrating}` 이면 capture 가 done 이어도 폴을 재예약(`plan.poll || chainBusy`). 파이프라인 종단(done/failed) 시 자연 종료.
- **calibrate 폴 재기동**: `pollPipeline` 이 `prevPipelineStage!=='calibrating' && stage==='calibrating'` 전이를 감지하면 `calPoll()` 를 1회 직접 호출 → idle 에서 멈춰 있던 calPoll 이 running 을 잡아 프레임 폴·결과 요약(renderCalResult) 기존 경로 재사용.
- **오버레이 자동 반영**: `prevPipelineStage==='finalizing' && stage∈{calibrating,done}` 전이(=finalize 완료, slot_setup 방금 써짐)에서 `loadParkingSlots()+loadMapping()+drawRoiOverlay()+renderSlotList()` — capFinalize 성공 분기와 **동일** 갱신.
- **cap-msg 소유**: 무장 중에만 pollPipeline 이 cap-msg 를 씀(finalizing='자동 최종화 중…', calibrating='자동 센터라이징 중…', failed='자동 체인 중단(단계): 사유', done='자동 셋업 완료 — 센터링 대상 N / 전체 M · 미대상 M−N [· note]'). **비무장/미지원 시 `!pl.armed||stage==='idle'` 조기 반환** → cap-msg 무간섭(수동 흐름 회귀 0).
- capStart: 바디에 `autoChain: $('cap-autochain').checked` 추가 + `prevPipelineStage='idle'` 리셋.

> 이 보정은 설계 §4 app.js 항목②③("capPoll 병행 조회 / finalizing→calibrating 전환 시 오버레이 갱신")의 **실행에 필수**인 최소 코드다. 설계 의도 내 보완(신규 폴 루프 발명 없이 기존 capPoll/calPoll 재사용). 아래 §6 발견이슈에 명시.

---

## 5. 자체 검증 결과

- **`npx tsc --noEmit`**: 통과(에러 0).
- **`node --check web/app.js`**: 통과.
- **상태머신 스모크**(임시 `test/_smokePipeline.test.ts`, 11케이스 — 실행 후 삭제): **전건 통과**.
  - T1 armed+done+dets>0 → finalize→start 호출순서·stage 전이·coverage`{1,1,0}`·finalize`{3,5}` → onCalibrateFinished('done')→done ✓
  - T2 비무장 → finalize/start 미호출·idle 유지 ✓
  - T3 stopped/error → failed{capture}·finalize 미호출 ✓
  - **T4 dets0 → failed{finalize,'검출 0건…'}·finalize 미호출**(F10) ✓
  - **T5 finalize throw → failed{finalize}·start 미호출**(가드2) ✓
  - **T6 LPD 타깃0 → done+note·start 미호출·coverage`{0,2,2}`**(F6) ✓
  - T7 start throw('already running')→failed{calibrate} / T7b onCalibrateFinished('error')→failed{calibrate} ✓
  - T8 종단→재무장(리셋)·disarm ✓
  - isBusy: capturing=false, calibrating=true, done=false ✓
  - **T9 CaptureJob 콜백 throw 흡수 → state='done' 완결**(로그 '잡 완료 콜백 예외(흡수)' 확인) ✓
- **`npx vitest run`(전체)**: **163 파일 / 1808 테스트 전건 통과** — 기존 테스트 **무수정** 통과 = **회귀 0 증명**(콜백·플래그·라우트 전부 옵셔널·가산).

---

## 6. 발견 이슈 (설계 결함·보완)

1. **[보완·최소수정] pollPlan 이 done/idle 에서 폴 종료** — 설계서 F7/F8 은 "프론트 자동 추종 공짜"라 기술하나, 실제 `pollPlan(state).poll` 은 `running/stopping/finalizing` 만 true. capture done 후 capPoll·idle 상태의 calPoll 이 모두 멈춰 백엔드 체인을 추종할 수 없다. → §4 처럼 capPoll 에 `chainBusy` 폴 유지 + calibrating 전이 시 calPoll 재기동으로 보정(설계 의도 내, 신규 루프 발명 없음). **임의 변경 아님 — 최소 보완**.
2. **[정보] 종료 전환 결과 모달 중복 가능** — capPoll 의 wasActive→done 전환에서 `showCaptureResult()`+`startLive()` 가 여전히 발화(수집 결과 박스). autoChain 시 직후 finalize→calibrate 로 이어져 약간 중복 인상이나, 설계가 억제를 요구하지 않았고 기능상 무해 → **외과적 원칙상 손대지 않음**(수동 흐름 보존).
3. **[설계대로·미해결 후속]** LPD 홀(F5) 근본해결(A2), 수동경로 stale slot_setup 가드, centering 컬럼 wipe 취약 — 전부 이번 범위 밖(설계서 §5.2·§7).

---

## 7. qa-tester 전달 — 테스트 포인트 (T1~T9 + 라우트)

### 7a. `test/setupPipeline.test.ts` (신규, fake deps — 위 스모크가 참조 뼈대)

| # | 케이스 | 검증 포인트 |
|---|--------|------------|
| T1 | armed + done + dets>0 | finalize(snapshot 전달) → calibrator.start 호출, stage 전이 capturing→finalizing→calibrating→done(onCalibrateFinished), coverage 계산값·finalize 요약 |
| T2 | **비무장**(onCaptureStart(false)) + done | finalize/start **미호출**, stage idle 유지 |
| T3 | armed + stopped / error | failed{capture}, finalize 미호출 |
| T4 | armed + done + **dets 0** | failed{finalize,'검출 0건…'}, **finalizer.finalize 미호출**(spy 0회 — F10 DB 보호) |
| T5 | finalize throw | failed{finalize, err.message}, **calibrator.start 미호출** |
| T6 | LPD 타깃 0(전 슬롯 lpd=null) | done + note, **calibrator.start 미호출**(F6), coverage{targets:0,...} |
| T7 | calibrator.start throw / onCalibrateFinished('error') | failed{calibrate} |
| T8 | 종단 상태에서 onCaptureStart 재호출 | 리셋·재무장(failure/coverage/note 클리어) |
| T9 | onFinished 콜백 내부 throw | **CaptureJob·PtzCalibrator 가 죽지 않음**(각 기존 테스트 파일 `captureJob.test.ts`/`ptzCalibrator.test.ts` 에 1케이스씩 — 상태전이 완결 확인) |

- 비동기 주의: onCaptureFinished('done') 후 finalize 는 `void` 비동기 발화 → 단언 전 microtask flush 필요(`for(5) await Promise.resolve()` 패턴).
- deps Pick 계약: `calibrator` fake 는 `start`+`getStatus` 둘 다 스텁(설계 §3.1 Pick 명세 준수 — getStatus 는 현재 미사용이나 계약 유지).

### 7b. `test/captureRoutes.test.ts` 가산(기존 무수정)

- `POST /capture/start {autoChain:true}` → `pipeline.onCaptureStart(true)` 호출됨(스파이/후속 `GET /capture/pipeline` stage='capturing' 확인).
- `GET /capture/pipeline` shape(armed/stage/…) — pipeline 미주입 시 라우트 미등록(404).
- `pipeline.isBusy()===true` 상황에서 `POST /capture/start` → **409 {error:'pipeline busy', stage}**.
- **회귀 0**: autoChain 미지정 start → 기존과 동일(pipeline 주입 없으면 배선 no-op).

### 7c. 리더 라이브(13020) — 설계서 §6b L1~L6

L1 체크박스 ON+수집 → done→'자동 최종화 중…'→오버레이 갱신→'자동 센터라이징 중…'→완료 요약 / L2 `GET /capture/pipeline` stage 전이 로그 / L3 검출0(빈 씬) → finalize 미실행·failed·**slot_setup DB 원본 보존**(/db 뷰어) / L4 finalize throw(커버리지 불일치) → calibrate 미발화·정지 / L5 체크박스 OFF 수동 3버튼 회귀0·pipeline stage idle / L6 수집 중 수동 정지 → failed{capture,stopped}.
