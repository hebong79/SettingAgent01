# 03 검증 — 정밀수집 "시작" → discovery LPD + 점유영역 전환 (이터레이션 1·2)

> 대상: `01_architect_plan.md`(§D·§I) + `02_developer_changes.md`. VPD off 자동연쇄에서
> LPD 채우기를 앞면중심 앵커 loop(discovery)로 수행하고, 발견된 판 quad 로 점유영역을 결정형 생성하는 변경.
> 검증자 규칙: 실제 vitest 실행 + 경계면 교차 비교. 프로덕션 소스 무접촉(테스트 파일만).

## 1. 스위트 결과(정직 카운트)

| 항목 | 기준선(개발자 보고) | 검증 실측 | 판정 |
|------|------|------|------|
| `npx tsc --noEmit` | exit 0 | **exit 0** | ✅ |
| `npx vitest run --no-file-parallelism` (강화 전 기준선 재현) | 176파일 / 2019테스트, exit 0 | **176파일 / 2019테스트 PASS, exit 0** | ✅ |
| 신규 테스트 추가 후 전체 | — | **176파일 / 2036테스트 PASS, exit 0** | ✅ (+17) |

- 기준선(2019) 그대로 재현 → 개발자 보고 정직 확인. 신규 강화 테스트 17건 추가 후에도 전량 그린, 회귀 0.
- 신규 실패 0, skip 없음. 외부 REST(카메라/LPD/DB/파일)는 전부 스텁 — 실 서비스 호출 0(유닛 모킹).

## 2. 추가·강화한 단위 테스트

### 2-1. `test/setupPipeline.test.ts` (18 → 25 tests, +7)
공유 픽스처 `makePipeline` 에 `discoverStartImpl` 옵션 추가(기본 동작=진입 즉시 `onDiscoverFinished('done')` 자동통지 — 기존 테스트 무수정 통과). 신규 describe:
- **D-1 전체 전이 시퀀스**: `idle→capturing→finalizing→discovering→calibrating→done` 각 단계 관측.
  - `onCaptureFinished('done')` 직후 동기적으로 `finalizing`(finalize 미해결) → discovery 미발화 단언.
  - flush 후 `discovering` 진입 + `discovery.start` 1회 + **calibrator.start 아직 미호출** 단언.
  - **경계면 순서 단언**: `finalize.invocationCallOrder < discoverStart.invocationCallOrder < calibrator.start.invocationCallOrder`.
  - `onDiscoverFinished('done')` → `calibrating` + start 1회 → `onCalibrateFinished('done')` → `done`.
- **D-2 discovery 실패 정직 처리**:
  - `onDiscoverFinished('error')` → `failed{stage:'discover', reason:'discover error'}` + **calibrator.start 미호출**(F6 위장 성공 금지).
  - `discovery.start` throw(수동 경합) → `failed{stage:'discover', reason:'discover already running'}` + start 미호출.
- **D-3 discovery done + 커버리지 0**: 전 슬롯 lpd=null → `done` + `note='센터라이징 스킵 — LPD 보유 슬롯 0'` + `coverage{0,2,2}` + calibrator.start 미호출(F6). 추가로 **커버리지 산출 시점**이 discovery 완료 시점임을 `getSlotSetup` 스파이 호출횟수로 봉인(discovering 중 0회 → onDiscoverFinished 시 1회).
- **D-4 isBusy**: `discovering` 중 `isBusy()===true`(신규 `/capture/start` 409 가드 소스).
- **D-5 콜백 가드**: 비-discovering stage(capturing)·비무장 시 `onDiscoverFinished` no-op(stage 불변, calibrator 미발화).

### 2-2. `test/plateDiscoveryJob.test.ts` (1 → 7 tests, +6)
- **onFinished('done')**: 성공 종단 → 콜백 1회 `['done']`.
- **onFinished('error')**: 슬롯 루프 밖(writer) throw → 상태 `error` + 콜백 `['error']`(외부 catch 경로 실증).
- **콜백 throw 흡수**: `onFinished` 가 throw 해도 `job.start` 무-throw + 잡이 terminal `done` 도달(`notifyFinished` try/catch 봉인).
- **콜백 미주입(수동 `/discover/ptz`)**: no-op, crash 없음, `done` 도달(회귀 0).
- **saveSlotLpd 점유영역 동봉**: found 슬롯 → `upsertSlotLpd` 행에 `occupyRange` = `stringify5(buildPlateAnchoredQuad(quadBoundingRect(lpdOrig), lpdOrig))` 와 **정확 일치**(실제 프로덕션 함수 import 로 기대값 산출 — 경계면 교차). `lpdObb===stringify5(lpdOrig)`, `slotId===globalIdx`.
- **미검출 스킵**: found:false → 행 미생성 → `upsertSlotLpd` 미호출(`found===0`, 위장 저장 없음).

### 2-3. `test/sqliteStore.test.ts` (19 → 22 tests, +3)
기존 wipe-safety 봉인(289~322행: lpd-only upsert 시 occupy 보존) **무수정 통과 확인**. 신규:
- **occupyRange 제공 → occupy_range 갱신**: `occupyRange` 있는 행 → occupy_range·lpd_obb·updated_at 만 갱신, **vpd/pan/tilt/zoom/centered/img1/slot3d_front_center/slot_roi 전부 불변**.
- **occupyRange 미제공(undefined) → occupy_range 보존**: 수동 `/capture/slots/lpd` 경로 시맨틱 — 기존 점유영역 파괴 없음(wipe 없음), lpd 만 갱신.
- **occupyRange=null 명시 → 클리어**: `null`(제공됨) 과 `undefined`(무접촉) 를 SQL 분기가 구분함을 봉인.

## 3. 경계면 교차 비교(harness 규칙)

| 경계 | 생산측 | 소비측 | 판정 |
|------|--------|--------|------|
| `SlotLpdRow` shape | `PlateDiscoveryJob.saveSlotLpd`: `{slotId, lpdObb, occupyRange?, updatedAt}` | `SqliteStore.upsertSlotLpd` | ✅ 정합. found+occupy 계산성공→string, 계산실패(catch)→property 존재+`undefined`→보존분기, |
| `SlotLpdRow` 2번째 호출자 | `captureRoutes.ts:340` 수동 `/capture/slots/lpd`: `{slotId, lpdObb, updatedAt}` (occupyRange **키 부재**) | 동상 | ✅ `r.occupyRange===undefined`→**occupy_range 무접촉**. wipe-safety 불변 유지(핵심 회귀 지점, 단위 봉인됨). |
| 조건부 UPDATE 분기 | `upsertSlotLpd` 2-statement(`undefined`→lpd만 / else→lpd+occupy) | — | ✅ plan §I 리터럴 SQL(단일 statement `?? null`)이 **2번째 호출자 wipe** 유발함을 개발자가 정확히 포착·조정. 조정이 옳음(§4 참조). |
| `PipelineStage` enum | `SetupPipeline.getStatus().stage` = `idle/capturing/finalizing/discovering/calibrating/done/failed` | `web/app.js:2103 chainBusy` + `2142 stage==='discovering'` 메시지 분기 | ✅ 'discovering' 이 chainBusy 폴 조건·메시지("번호판 탐색 중…") 양쪽에 반영. 값 집합 일치. |
| `failure.stage` | `{stage:'discover'}` 추가 | `web/app.js:2147 f.stage` 제네릭 렌더 | ✅ 'discover' 표시 정상(하드코딩 화이트리스트 없음). |

## 4. 설계 편차 검토(plan §I 리터럴 SQL vs 개발자 조정)

plan §I·코디 지시는 단일 statement `SET lpd_obb=?, occupy_range=?, ... WHERE slot_id=?` + `r.occupyRange ?? null` 을 지시했으나, 개발자는 **두 번째 프로덕션 호출자(`captureRoutes.ts:340` 수동 LPD 추가)** 가 occupyRange 를 전달하지 않는 점을 근거로 **조건부 2-statement** 로 조정. 검증 결과 이 조정이 **옳다**:
- 리터럴 SQL 을 그대로 적용했다면 수동 경로가 discovery 가 채운 occupy_range 를 매번 null 로 wipe → plan §237 의 명시 의도("미검출은 스킵 — 기존 값 보존") 위배 + 기존 봉인 테스트 파괴.
- 조정본은 plan 상위 의도(wipe 없음) 100% 충족. **결함 아님 — 정당한 상향 의도 준수.** 단위로 3-case(undefined 보존 / string 갱신 / null 클리어) 전부 봉인함.

## 5. 발견된 결함 / 관찰

- **결함: 없음.** 프로덕션 소스 무접촉, 전 시나리오 그린.
- **경미 관찰(결함 아님)**: `SetupPipelineDeps.discovery` 는 `Pick<..., 'start'|'getStatus'>` 로 `getStatus` 를 계약에 포함하나 `SetupPipeline` 내부는 `discovery.start` 만 호출(`getStatus` 미사용, SetupPipeline.ts:181). 향후 파이프라인이 discovery 진행률을 status 로 노출할 여지를 위한 잉여 표면. 무해.

## 6. 수용 기준 커버리지(plan §E + §I)

| 기준 | 커버 방식 |
|------|-----------|
| §E1 연쇄 완주 전이 `capturing→finalizing→discovering→calibrating→done` | **단위 커버**(setupPipeline D-1, 각 단계·순서 봉인) |
| §E6 회귀 0(autoChain off·수동 경로·2019 기준선) | **단위 커버**(T2 비무장 no-op, plateDiscoveryJob 콜백 미주입 no-op, 기준선 재현) |
| F5 수동 `/discover/ptz` 회귀 0 | **단위 커버**(콜백 미주입 no-op) |
| F6 discovery error → centering 오발화 금지 | **단위 커버**(D-2) |
| F1 occupy/기타 컬럼 wipe 금지(부분 UPDATE) | **단위 커버**(sqliteStore 조건부 3-case + 봉인) |
| §I 검증기준: found 슬롯 occupyRange 판 quad, 미검출 null | **단위 커버**(plateDiscoveryJob saveSlotLpd occupy 동봉·미검출 스킵) |
| §E2 LPD 출처가 discovery `lpdOrig` 와 좌표 일치 | **리더 라이브 커버(§I 관찰 found 17/17)** — 실 카메라/plate_discovery.json 좌표 대조는 라이브 전용 |
| §E3 discovery found 수 ≥ 전체프레임(cam1:preset2 5/6 재현) | **리더 라이브 전용**(실 LPD 서비스 필요, 모킹 불가) |
| §E4 setup_artifact.json·save 스냅샷 갱신 | **리더 라이브 전용**(파일 I/O 실연동) |
| §E5 slot_ptz.json·centering_slot DB 갱신 | **리더 라이브 전용** |

- 스모크(실 카메라/LPD/파일 실연동)는 이번 유닛 범위 밖 — **누락 명시**(삭제·통과 위장 아님). §E2~E5 는 §I 리더 라이브(count=1 auto-chain)에서 이미 실증됨(전이 정상·found 17/17·occupy 재산출).

## 7. 결론

tsc/vitest 그린(176/2036, exit 0). 이터레이션 1·2 핵심 계약(discovering 단계 삽입·순서·정직 실패·isBusy·조건부 occupy UPDATE·판 quad 점유영역)이 단위로 봉인됨. 경계면 5종 정합 확인, wipe-safety 불변 재봉인. 결함 없음.
</content>
</invoke>
