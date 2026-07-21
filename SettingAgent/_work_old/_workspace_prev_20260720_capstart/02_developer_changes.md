# 02 구현 — 정밀수집 "시작" 자동연쇄에 discovering 단계 삽입 (후보 C)

> 설계 `01_architect_plan.md` §C/§D 후보 C 구현. autoChain 파이프라인에 `discovering` 단계를
> finalize 와 calibrating 사이에 1개 삽입. 탐색/기하/스토어 코어는 무접촉, 배선만 추가.

## 신규 실행 순서

```
capturing(VPD off)
  → finalizing(점유+기하 front_center 부트스트랩 + artifact/파일 저장)
  → discovering(앞면중심 앵커 loop → slot_setup.lpd 부분 UPDATE)   ← 신규
  → calibrating(discovery 가 채운 lpd 소비 → slot_ptz.json + centering_slot)
  → done
```

핵심 이동: **커버리지 산출 위치를 finalize 직후 → discovery 완료 직후로 이월**했다. 최종 `slot_setup.lpd` 는
이제 finalize(전체프레임)가 아니라 discovery 앵커 loop 가 채우므로, 커버리지(`expandPlateTargetsFromSlotSetup`)를
discovery 반영본 위에서 계산해야 정확하다.

## 변경 파일

### 1. `src/calibrate/PlateDiscoveryJob.ts` — 완료 콜백 추가(PtzCalibrator 미러)
- `PlateDiscoveryJobDeps` 에 `onFinished?: (state: 'done' | 'error') => void` 옵셔널 추가(L47~48).
- private 필드 `onFinished` 추가 + 생성자 대입(L74, L90).
- `run()` 종단부: `state='done'` 뒤 `this.notifyFinished('done')`, `state='error'` 뒤 `this.notifyFinished('error')`.
- 신규 private `notifyFinished(state)` — try/catch 로 콜백 throw 흡수(콜백이 잡을 죽이지 않음, PtzCalibrator L151-158 미러).
- **수동 `/discover/ptz` 회귀 0:** 콜백은 옵셔널이며 `discoverRoutes` 가 생성하는 인스턴스에는 미주입 → `onFinished?.()` no-op.
  start/getStatus/getLastFrame 시그니처·상태머신·저장(upsertSlotLpd/writePlateDiscovery) 전부 불변.

### 2. `src/pipeline/SetupPipeline.ts` — discovering 단계 삽입
- `PipelineStage` 유니온에 `'discovering'` 추가.
- `PipelineStatus.failure.stage`·private `failure`·`fail()` 시그니처에 `'discover'` 추가(정직 실패 대상).
- `SetupPipelineDeps` 에 `discovery: Pick<PlateDiscoveryJob, 'start' | 'getStatus'>` 추가.
- `runFinalizeThenCalibrate` 분해: finalize 성공 후 커버리지·센터라이징 발화 대신
  `stage='discovering'` → `discovery.start({})`(전 프리셋). start throw(경합) 시 `fail('discover', ...)`.
- 신규 `onDiscoverFinished(state: 'done'|'error')`:
  - 비무장/비-discovering → no-op(가드).
  - `error` → `fail('discover', 'discover error')`(위장 성공 금지, F6).
  - `done` → `expandPlateTargetsFromSlotSetup(store.getSlotSetup())` 로 커버리지 재계산(discovery 반영본) →
    targets 0 이면 `note='센터라이징 스킵 — LPD 보유 슬롯 0'` + `finish('done')`(빈 slot_ptz.json 덮어쓰기 방지 가드 유지) /
    아니면 `stage='calibrating'` → `calibrator.start()`.
- `isBusy()` 에 `'discovering'` 포함 → discovery 진행 중 신규 `/capture/start` 409.
- 클래스 doc 주석 stage 시퀀스에 `discovering` 반영(1줄).

### 3. `src/index.ts` — 배선(생성순서 조정)
- `plateDiscovery` 생성을 `pipeline` 생성 **앞으로 이동**(pipeline 이 discovery 를 dep 로 필요). plateDiscovery 는
  camera/lpd/sqlite/outFile 만 의존하므로 앞당김 안전(중간 배선 무영향).
- `new PlateDiscoveryJob({..., onFinished: (s) => pipeline?.onDiscoverFinished(s)})` — captureJob/calibrator 와 동일한
  **클로저 전방참조** 패턴(`let pipeline` 미할당 시점엔 `pipeline?.` 로 안전).
- `new SetupPipeline({ job, finalizer, discovery: plateDiscovery, calibrator, store: sqlite })`.
- 주석 갱신: discovery 가 "파이프라인 자동연쇄엔 미포함(수동 실행)" → "discovering 단계로 포함, 수동 /discover/ptz 도 동일 인스턴스".

### 4. `web/app.js` — UI 라벨(경미)
- `pollPipeline`: `chainBusy` 조건에 `pl.stage === 'discovering'` 추가(폴 유지).
- stage 메시지 분기에 `else if (stage === 'discovering') → '번호판 탐색 중…'` 추가.
- 바디·엔드포인트 변경 없음.

## 불변(무접촉 확인)
- `CaptureJob.captureTarget` 전체프레임 LPD 블록(점유영역 앵커 소스) 유지.
- `Finalizer` 점유/front_center 로직, `PlateDiscovery`/`cropZoom`/`plateDiscoveryWriter` 탐색 코어,
  `upsertSlotLpd`/`replaceSlotSetup` 스토어 — 전부 무수정.

## 정책 준수(§2 R1~R6)
- R1 VPD off 유지(vpdEnabled=false 게이트 무변경) · R2 결정론(LLM 미개입) · R3 부분 UPDATE(upsertSlotLpd, 탐색 코어) ·
  R4 소수5자리(stringify5, 기존 writer) · R5 하향앵커 0.15 게이트(discovery 내장) ·
  R6 정직 실패(discovery error → pipeline `fail('discover')`, 가짜 성공 없음).

## 테스트 회귀 수정(내가 유발한 것)
`discovery` 를 필수 dep 로 만들며 기존 테스트 2곳에서 tsc 에러 발생 → 최소 수정:
- `test/captureRoutes.test.ts`: `makePipelineServer` 에 discovery no-op 스텁 + 타입 import 추가.
- `test/setupPipeline.test.ts`: 공유 픽스처 `makePipeline` 에 discovery 스텁 추가. 스텁 `start()` 가 곧바로
  `pipeline.onDiscoverFinished('done')` 를 통지(전방참조) → 기존 finalize→calibrating 전이 단언이 discovery 를
  투명 통과해 그대로 성립(개별 테스트 본문 무수정). `discoverStart`/`discoverStatus` 를 반환에 노출 —
  qa-tester 가 pending/error 분기 테스트를 여기에 얹을 수 있음.

## 검증 결과(정직 카운트)
- `npx tsc --noEmit` → **exit 0**.
- `npx vitest run --no-file-parallelism` → **176 파일 / 2019 테스트 전부 PASS, exit 0**(기준선 유지, 신규 실패 0).

## qa-tester 인계
- `setupPipeline.test.ts`: `capturing→finalizing→discovering→calibrating→done` 명시 전이 + discovery `error` →
  `fail('discover')` + discovery `done` 후 targets-0 → note+done 분기 + upsertSlotLpd 타 컬럼 불변 단언.
- `plateDiscoveryJob.test.ts`: `onFinished('done'/'error')` 통지 + 미주입 시 no-op(수동 경로 회귀).

---

# 이터레이션 2 — 점유영역(occupy_range)을 discovery LPD 로 결정형 생성 (plan §I)

> 리더 라이브(count=1) 재검증: 전이·discovery found 17/17·최종 lpd·센터라이징 전부 정상이나
> `occupancy accepted:0 → occupy_range=null`(마스터 순서 2번 미산출). 근본원인: Finalizer occupy_range 는
> capture 전체프레임 LPD hit 에서만 나오는데 VPD off + 전체프레임 LPD 희소로 hit 0. 이제 discovery 가
> 슬롯별 판을 신뢰성 있게 채우므로, 그 판 quad 로 점유영역을 결정형 생성한다.

## 변경 파일 (이터레이션 2)

### 1. `src/capture/types.ts` — `SlotLpdRow` 확장
- `occupyRange?: string | null` 추가(L162~163). 옵셔널 = "미제공 시 occupy_range 무접촉"(부분 UPDATE 의미론).

### 2. `src/capture/SqliteStore.ts` — `upsertSlotLpd` occupy_range 부분 UPDATE(조건부)
- prepared statement 2개로 분기: `occupyRange === undefined` → `SET lpd_obb=?, updated_at=?`(occupy_range 무접촉),
  제공 시 → `SET lpd_obb=?, occupy_range=?, updated_at=?`. 트랜잭션·slot_id 키 UPDATE·wipe 금지 불변.

### 3. `src/calibrate/PlateDiscoveryJob.ts` — `saveSlotLpd` 점유영역 동봉
- import `buildPlateAnchoredQuad`(`../capture/floorRoi.js`), `quadBoundingRect`(`../domain/geometry.js`).
- found 슬롯: `occupyRange = stringify5(buildPlateAnchoredQuad(quadBoundingRect(it.lpdOrig), it.lpdOrig))`
  (Finalizer 판-only 경로 `Finalizer.ts:254` 와 동일 재사용). try/catch 로 계산 실패 시 occupyRange **생략**
  (undefined → occupy_range 무접촉 = 기존 값 보존, lpd 는 저장). 행에 `occupyRange` 동봉.

## ★ 설계 편차 + 근거(조율 필요 — 조율 결과 반영)
- **plan §I·코디 지시 #2 는 단일 statement `SET lpd_obb=?, occupy_range=?, updated_at=? WHERE slot_id=?`
  + 파라미터 `r.occupyRange ?? null` 을 지시**했으나, `upsertSlotLpd` 에 **두 번째 프로덕션 호출자**가 존재한다:
  `src/api/captureRoutes.ts:341` 수동 `/capture/slots/lpd`("현재화면 LPD DB추가") 버튼. 이 경로는 rows 에
  `occupyRange` 를 넣지 않는다.
- 단일 statement + `?? null` 을 그대로 적용하면 이 수동 경로가 **finalize·discovery 가 채운 occupy_range 를 null 로 wipe**
  하는 회귀가 발생하고, 기존 wipe-safety 봉인 테스트(`sqliteStore.test.ts:301` — lpd-only upsert 시 occupy 보존)도 깨진다.
- plan §237 의 **명시 의도는 "미검출은 스킵(기존 값 보존 — wipe 없음)"** 이다. 이를 충족하려면 리터럴 SQL 이 아니라
  **occupyRange 제공 여부 조건부 UPDATE** 가 옳다. → 조건부(2-statement)로 구현. 결과:
  수동 lpd 경로 occupy 보존(회귀 0) · discovery 만 occupy 갱신 · 기존 봉인 테스트 **무수정 통과** · plan 의도 100% 충족.
- 요컨대 **plan 의 리터럴 SQL 이 두 번째 호출자를 간과**했고, 나는 plan 의 상위 의도(wipe 없음)를 지키는 방향으로 조정했다.

## 검증 결과(이터레이션 2, 정직 카운트)
- `npx tsc --noEmit` → **exit 0**.
- `npx vitest run --no-file-parallelism` → **176 파일 / 2019 테스트 전부 PASS, exit 0**.
  조건부 설계 덕분에 **테스트 수정 0건**(코디가 우려한 upsertSlotLpd 테스트 깨짐이 발생하지 않음 — occupy 보존 봉인 유지).

## qa-tester 인계(이터레이션 2 추가)
- `sqliteStore.test.ts`: `upsertSlotLpd` 에 `occupyRange` 제공 행 → occupy_range 갱신 단언 추가 +
  기존 lpd-only 행 → occupy_range 보존 단언 유지(현행 봉인 그대로).
- `plateDiscoveryJob.test.ts`: found 슬롯 rows 에 `occupyRange`(판 quad anchored) 동봉 단언 + 미검출 슬롯 미포함.

