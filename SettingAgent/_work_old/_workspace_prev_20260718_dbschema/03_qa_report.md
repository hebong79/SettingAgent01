# 03. QA 검증 리포트 — SettingAgent DB 개편 후 test/** 전면 재검증

> 검증자(qa-tester). 입력: `01_architect_plan.md` + `02a/02b/02c_developer_*.md` + 신 소스.
> 신 계약(6테이블/인메모리 스냅샷/REST 재편/LLM 최소화)에 맞춰 27개 깨진 테스트 처리 + 신규 테스트 작성.

## 0. 최종 결과 (숫자 그대로)

| 게이트 | 결과 |
|---|---|
| `npx tsc --noEmit` (src+test 전체) | **error 0** (착수 시 472, 27파일) |
| `npx vitest run` (전량) | **Test Files 153 passed / Tests 1700 passed / 0 failed** |
| 외부 서비스(VPD/LPD/LLM/카메라/시뮬레이터) | 전부 모킹(유닛). 실연동 스모크는 미수행(§6 한계) |

착수 시 27파일 472 tsc 에러 → 0. 전 스위트 그린.

## 1. 처리한 파일

### (A) 삭제 테이블·구 스토어 전용 → **삭제**(신 계약에 기능 자체 소멸)
| 파일 | 사유 |
|---|---|
| `test/parkingSlotsStore.test.ts` | `parking_slots` 테이블 + `replaceParkingSlots/getParkingSlots` 폐기. slot_setup 이 대체 → 신 `sqliteStore.test.ts` 로 흡수. |
| `test/occupancyStore.test.ts` | `occupancy` 테이블 + `insertOccupancy/getLatestOccupancy` 폐기(인메모리 occByPreset 로 이동). |
| `test/floorRoiStore.test.ts` | `floor_roi` 테이블 + `upsertFloorRoi/getFloorRois` 폐기(폴리곤 미영속 — Finalizer 결정형). |
| `test/floorRoiStoreCompat.test.ts` | 구 floor_roi 마이그레이션 하위호환 — 테이블 자체 소멸로 무의미. |

(`test/agentRuntimeCentering.test.ts` 는 devB 가 adviseCentering 死코드 삭제와 함께 `git rm` — QA 범위 밖.)

### (A) 재작성 (구 스토어 전용 → 신 6테이블 계약)
- `test/sqliteStore.test.ts` — **전면 재작성**. 신 6테이블 계약 검증(§2 신규 목록).
- `test/centeringSlot.test.ts` — 비-DB 계약(T1~T6·T9)은 유지, DB 미러(T7·T10·T11·T13·T14)를 `upsertSlotCentering`(정수 slot_id 부분 UPDATE, 사전 slot_setup 시드)로 재작성. 구 T12(`upsertCenteringSlots` 단위)는 `sqliteStore.test.ts` 로 이관(중복 제거).

### (B) 시그니처/계약 추종 (재작성·갱신)
| 파일 | 변경 |
|---|---|
| `captureJob.test.ts`(+cuboid/onPlace/occupancyGate/liveRefresh) | CaptureJobDeps 에서 `store`/`reviewer`/`floorReviewer` 제거, DB 조회 → `getSnapshot()/getAggregated()/getOccupancy()` 인메모리 게터. 상태는 `getStatus().state/done`. |
| `captureCheckpointTrigger.test.ts` | `floorReviewer` → `occupancyReviewer`(신 시그니처 `review(atRound, frames, occByPreset, shouldStop?, expected?)`). |
| `finalizerParkingSlots/checkpointFinalizer/finalizerOccupancy/finalizerFloor.test.ts` | `finalize(runId)` → `finalize(snapshot)`, `getParkingSlots`→`getSlotSetup`(SlotSetupView), 필드 `slotIdx→slotId`, `occupied`→`vpd!=null` 파생. |
| `occupancyReviewer.test.ts` | 신 시그니처 + `occByPreset` Map 어서션(구 `insertOccupancy` 캡처 폐기). |
| `floorRoiReviewer.test.ts` | 미영속 — 반환값 `{llmUnavailable}` + brain 호출만 검증(구 `getFloorRois` 폐기). |
| `floorRoiUseLlmWiring.test.ts` | 유지 — 제거된 `floorReviewer` 게이트 → 잔존 `floorRoiUseLlm` 플래그가 `occupancyReviewer` 게이트하는 것으로 재작성. |
| `captureRoutes.test.ts`/`parkingSlotsRoutes.test.ts` | 신 경로 `/capture/aggregate·occupancy·slots`, finalize 바디 runId 제거. `/capture/slots` = `getSlotSetup()`. |
| `floorRoiNormalizeEdge.test.ts` | 구 store 왕복 → 순수 `resolveFloorPolygon`/`FloorRoiReviewer.review` 경로. |
| `estimatePlateNeighborsIntegration.test.ts` | snapshot 기반 finalize 로 이관. |

### (B) 계약 파급(구 테이블 아닌데 신 계약으로 깨진 것) — 신규로 잡음
| 파일 | 변경 | 비고 |
|---|---|---|
| `config.test.ts` | `floorRoi.enabled` 실제 config = **false**(LLM 최소화, 구 테스트는 true 기대) + occupancy 잔존/stage off 검증 추가 | tsc 통과했으나 **동작 실패**였음 |
| `placeGlobalIdx.test.ts` | `buildFlatSlotRows` 소비 shape `slotIdx→slotId`, occupied=`!!vpd` 파생 정합(9개 픽스처) | 0-based 기각 테스트가 이제 slot_id 값 기준으로 **진짜** 검증됨 |
| `centeringBoundary.test.ts` | 구 `centering_slot`(문자열 slotId+pos JSON) → `slot_setup`(정수 slot_id+분해 PTZ) 경계 재작성, 사전 시드 | 아래 §3 경계 결과 |

### (C) 공유 픽스처 파급 → 신 스키마
`vehicleCuboidRoutes/placeRoiRoutes/jobCuboidRoutes/groundModelRoutes/assocQaFindings.test.ts` — `new CaptureJob({...})` 리터럴에서 `store` 키 제거(1줄). SqliteStore 인스턴스는 Finalizer/서버 배선에 잔존.

## 2. 신규 테스트 (신 계약 커버리지)

| 파일 | 검증 항목 |
|---|---|
| `sqliteStore.test.ts`(재작성, 14) | 신 6테이블 생성·구 테이블 부재 / `foreign_keys=ON` 실효(FK 위반 INSERT 거부·PRAGMA=1) / `replaceSlotSetup` 트랜잭션 원자성(중간 throw 롤백→이전 확정본 보존) / `slot_setup` UNIQUE(cam,preset,preset_slotidx) / `getSlotSetup` presetKey 파생·roi/vpd/lpd/occupyRange JSON 파싱·centered boolean·ORDER BY / `upsertSlotCentering` 부분 UPDATE(타 슬롯 불변·미존재 slot_id 무시) / upsert 멱등 |
| `migrateToSettingDb.test.ts`(신규, 7) | 실 CLI(tsx child process) × 소형 fixture 트리 종단. 행수(place1/camera1/preset2/slot3) / slot_id 1..N 유일·연속(0-based 재부여) / FK 무결(`foreign_key_check`=[]) / img_w·img_h 보존·자동탐색 NULL / preset_slotidx 1-based·slot_roi 정규화 / 센터라이징 UPDATE(globalIdx→slot_id) / **멱등 재실행** |
| `dbRoutesMasking.test.ts`(신규, 3) | `camera_info.password` → `****`(NULL 유지) / 검색에서 민감 컬럼 제외(password 값 검색 시 행 비노출) / 타 테이블(place_info) 무영향. (devB 는 미작성 — 기존 dbRoutes.test.ts 16개는 마스킹 무관, 본 파일이 신규.) |
| `boundaryCrossCheck.test.ts`(신규, 4) | §3 경계면 교차. |

## 3. 경계면 교차 검증 결과 (핵심)

1. **slot_id(정수) ↔ setup_artifact.globalIndex.globalIdx** — `boundaryCrossCheck.test.ts`: 파일 전 주차면이 검출로 점유되는 통제 시나리오에서 `getSlotSetup().slotId` 집합 == `artifact.globalIndex.globalIdx` 집합 == `[1,2]`(1-based 단일 정수 넘버링). 문자열 `c{c}p{p}s{n}` 미저장(정수형) 확인.
2. **PtzCalibrator `SlotCenteringRow`(정수 slot_id + 분해 PTZ) ↔ slot_setup 행** — `centeringSlot.test.ts` T7 + `centeringBoundary.test.ts`: `it.globalIdx`(정수) → `slot_setup.slot_id`, `it.ptz{pan,tilt,zoom}` == `slot_setup{pan,tilt,zoom}`. REST `/calibrate/result` item.slotId 는 문자열, item.globalIdx 는 정수 = DB slot_id. 1-based(cam_id/preset_id/preset_slotidx) 재확인. 실패 슬롯은 slot_setup 미갱신(centered 행수 == 성공 항목수).
3. **`/capture/slots`(SlotSetupView) ↔ 뷰어 소비(web/core.js `buildFlatSlotRows`)** — `boundaryCrossCheck.test.ts` + `placeGlobalIdx.test.ts`: 응답 필드 `slotId`(정수)·`presetKey`(파생)·`vpd`(객체|null)·`lpd`(quad|null)·`roi`(4점). 뷰어는 `occupied = !!db.vpd`(slot_setup 은 점유상태 미저장 → 배정 차량 bbox 유무로 표시), `vpd/lpd` boolean 파생. globalIdx 1-based 오름차순. 구 필드 `slotIdx`/`occupied` 부재 확인.

## 4. FK 부모 선행성 (경계 발견 — devC §7-1 확인)

`slot_setup.(cam_id,preset_id) → preset_pos` FK(`foreign_keys=ON`)가 **실효**함을 양방향 검증:
- 부모(place/camera/preset_pos) 시드 시 `replaceSlotSetup`/`getSlotSetup` 정상.
- 부모 미시드 시 `replaceSlotSetup` INSERT 가 FK 위반 → 트랜잭션 롤백. Finalizer 는 이를 warn 후 흡수(artifact 는 정상 반환, slot_setup 만 빈 채로). → **finalize/센터라이징 전에 마이그레이션(preset_pos 채움) 선행 필수**. 이 신 불변식에 맞춰 Finalizer/PtzCalibrator/경계 테스트 모두 부모 시드 후 검증하도록 작성.

## 5. 발견 사항 (구현 버그 아님 — 아키텍처 관찰, 리더/devC 참고)

버그로 판정된 **구현 결함은 없음**. 아래는 리팩토링에 따른 정당한 거동 변화(테스트 재작성으로 반영):

1. **체크포인트 정지 게이트 이동**(qa-capturejob 관찰): 구 `CheckpointReviewer`/`FloorRoiReviewer` 는 "정지 중이면 review 호출 자체 스킵"의 외곽 게이트가 있었다. 신 `occupancyReviewer.review` 는 checkpoint 진입 시 항상 호출되고, 정지 반응성은 주입된 `shouldStop` 콜백(프리셋별 조기 break)로 **내부 위임**된다. 구 B1 테스트("정지 중 review 미호출") 2건은 더 이상 존재하지 않는 거동이라 삭제(사유 주석). 잔존 불변식(집계 수행·정지 반응)은 유지·검증됨. → 의도된 설계로 보이나 아키텍트 1회 확인 권장.
2. **`web/core.d.ts` 스테일 선언 정정**(qa-finalizer): `buildFlatSlotRows` 앰비언트 타입이 구 `ParkingSlotView`(slotIdx/occupied) 를 참조했으나 실제 `web/core.js` 는 이미 신 `SlotSetupView`(slotId/vpd) 로 마이그레이션됨. `.d.ts` 만 스테일 → 실제 구현에 맞게 선언 갱신(런타임 거동 변화 0, `src/**` 아님). **테스트 외 유일한 비-소스 파일 수정** — 별도 리뷰 대상으로 명시.

## 6. 미검증 한계 (은닉 금지)

- **실 외부 서비스 스모크 미수행**: VPD/LPD/LLM(Ollama)/실카메라/시뮬레이터 전부 모킹. 실연동(`npm run dev` → 실 REST 라운드트립, 캡처 1런 중 LLM 미호출 로그 확인, 뷰어 DB탭/최종화 표시)은 **리더 경험적 검증 몫**(설계서 §7 P3/P5).
- **마이그레이션 실 데이터**: `migrateToSettingDb.test.ts` 는 소형 fixture(cam1/preset2/slot3) 종단. 실 `data/Place01/PtzCamRoi.json`(cam1/preset3/slot17) → `data/setting.sqlite` 생성은 devA 스모크(place1/camera1/preset3/slot17) 기확인, 리더 최종 실행 권장.
- **센터라이징 실 산출 UPDATE**: `slot_ptz.json.items` 실공백 상태 → 실 캘리브레이션 산출본으로 slot_setup UPDATE 는 미검(코드/타입·모킹 검증 완료). devA §8 한계와 동일.
- **cam2**: 데이터 부재로 cam1 만 검증(설계 §8-1 확정 범위).

## 7. 산출물

- 재작성/갱신: §1 (B)(C) + `config.test.ts`/`placeGlobalIdx.test.ts`/`centeringBoundary.test.ts`.
- 신규: `sqliteStore.test.ts`(재작성)·`migrateToSettingDb.test.ts`·`dbRoutesMasking.test.ts`·`boundaryCrossCheck.test.ts`.
- 삭제: `parkingSlotsStore`/`occupancyStore`/`floorRoiStore`/`floorRoiStoreCompat`.test.ts (사유 §1-A).
- 비-테스트: `web/core.d.ts`(스테일 선언 정정, §5-2).
