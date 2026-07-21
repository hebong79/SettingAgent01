# 04. 문서화·영향도 분석 요약 — DB 스키마 전면 개편 + LLM 보조 최소화

> documenter. 입력: 01(설계)·02a/02b/02c(구현)·03(QA) + 실제 변경 코드 대조.
> 최종 문서: `SettingAgent/docs/20260718_012723_DB스키마전면개편_LLM최소화.md`

## 1. 변경 파일 전량 목록 (`git status` 직접 확인, SettingAgent 기준)

### 소스 (수정)
`src/api/captureRoutes.ts`, `src/api/dbRoutes.ts`, `src/brain/AgentRuntime.ts`, `src/brain/SetupBrain.ts`,
`src/calibrate/PtzCalibrator.ts`, `src/calibrate/types.ts`, `src/capture/CaptureJob.ts`,
`src/capture/CheckpointReviewer.ts`, `src/capture/Finalizer.ts`, `src/capture/FloorRoiReviewer.ts`,
`src/capture/OccupancyReviewer.ts`, `src/capture/SqliteStore.ts`, `src/capture/types.ts`,
`src/config/llmConfig.ts`, `src/config/toolsConfig.ts`, `src/index.ts`, `src/setup/GlobalIndexer.ts`

### 소스 (신규)
`src/tools/migrateToSettingDb.ts`

### 설정/프롬프트
`config/llm.config.json`(수정), `config/tools.config.json`(수정), `config/prompts/occupancy.yaml`(수정)
`config/prompts/{stage1_preset_judge.system/user, stage2_dedupe_label.system/user, stage3_final_report.system/user, floor_roi.yaml, floor_roi_origin_01/02.yaml, floor_roi.en_box.draft.yaml, ptz_centering.yaml}` → `config/prompts/_archive/`(git rename 11건)

### 뷰어
`web/app.js`(수정), `web/core.js`(수정), `web/core.d.ts`(수정 — QA가 스테일 타입 선언 정정)

### 테스트 (수정 다수 — 전체 목록은 `git status` 참조, 핵심만)
수정 다수(약 40파일: captureJob*, finalizer*, occupancyReviewer, floorRoiReviewer, captureRoutes, centeringSlot, centeringBoundary, config, placeGlobalIdx, sqliteStore 등)
삭제: `test/parkingSlotsStore.test.ts`, `test/occupancyStore.test.ts`, `test/floorRoiStore.test.ts`, `test/floorRoiStoreCompat.test.ts`, `test/agentRuntimeCentering.test.ts`
신규: `test/boundaryCrossCheck.test.ts`, `test/dbRoutesMasking.test.ts`, `test/migrateToSettingDb.test.ts`

### 데이터
`data/setting.sqlite`(신규, 정본), `data/observations.BACKUP_20260718.sqlite(+wal/shm)`(신규, 백업), `data/observations.sqlite`(무접촉 원본 — 롤백 지점), `data/Place01/`·`data/refframes/`·`data/slot_ptz.json`(신규, untracked 입력 자료)

---

## 2. 어셈블리 · 의존성 영향 그래프

```
SqliteStore(신 6테이블/신 메서드)
  ├─ CaptureJob        : DB 중간기록 제거 → 인메모리 dets/roundsByPreset/aggregated/occByPreset 누적
  │    ├─ CheckpointReviewer : 배선 제거(호출 안 됨). 클래스/메서드는 잔존(死코드 미삭제 원칙)
  │    ├─ FloorRoiReviewer   : 배선 제거(호출 안 됨). 클래스/메서드는 잔존
  │    └─ OccupancyReviewer  : insertOccupancy(DB) → occByPreset.set(인메모리) 로 축소
  ├─ Finalizer         : finalize(runId)→finalize(snapshot). replaceSlotSetup 단일 트랜잭션 교체
  ├─ PtzCalibrator      : upsertCenteringSlots(문자열slotId+PTZ JSON) → upsertSlotCentering(정수slot_id+분해 PTZ)
  ├─ captureRoutes      : /capture/runs* 4종 제거 → /capture/aggregate·occupancy·slots 신설
  ├─ dbRoutes           : SENSITIVE 맵 기반 password 마스킹 + 검색 제외
  ├─ index.ts           : reviewer 배선 조립부 갱신(Checkpoint/Floor 주입 제거)
  └─ web/app.js, web/core.js, web/core.d.ts : 응답 shape(slotIdx→slotId, presetKey 파생) 정합

AgentRuntime/SetupBrain/calibrate/types.ts/llmConfig.ts
  └─ adviseCentering·CenteringAdvice·CenteringSchema 死코드 계열 삭제(호출자 0 확인)

config/llm.config.json
  └─ stage1/2/3·floorRoi off, occupancy만 on, centering 블록 제거 → AgentRuntime 프롬프트 로드 경로 영향(재시작 필요, config/는 watch 밖)

config/tools.config.json, toolsConfig.ts:274
  └─ capture.dbFile: data/setting.sqlite (구 observations.sqlite 대체)
```

**ParkAgent 최상위(다른 에이전트) 영향**: 이번 변경은 SettingAgent 내부에 한정된다. `@parkagent/types`(공유 패키지) 변경 없음 — grep 결과 이번 diff에 `@parkagent/types` 파일 수정 없음. ActionAgent/DMAgent는 `parking_evnt`/`parking_slot`을 아직 소비하지 않으므로(스키마만 생성, writer/reader 미작성) **직접 영향 없음**. 단, 향후 ActionAgent가 이 두 테이블을 읽기 시작하면 `slot_id`(정수 전역)·FK 관계를 그대로 계승해야 한다.

---

## 3. REST 계약 변경의 클라이언트·테스트 파급

- 삭제: `GET /capture/runs`, `GET /capture/runs/:id/{aggregate,occupancy,slots}` — 이 URL을 참조하는 외부 클라이언트가 있다면 즉시 404. 이번 범위 내 유일한 소비자는 `web/app.js`이며 이미 신 경로로 갱신됨.
- 신설: `GET /capture/aggregate`, `GET /capture/occupancy`, `GET /capture/slots` — `POST /capture/finalize` 바디에서 `runId` 제거.
- `test/captureRoutes.test.ts`, `test/parkingSlotsRoutes.test.ts`가 신 경로/신 바디로 재작성됨(QA).
- `/capture/slots` 응답 필드 `slotIdx→slotId`, `presetKey`(`"{cam_id}:{preset_id}"`) 파생 추가 — 뷰어(web/core.js `buildFlatSlotRows`)가 이를 소비하도록 갱신됨. 외부에 이 응답 shape에 의존하는 다른 소비자가 있다면(현재 코드베이스 내에는 web뿐) 갱신 필요.

---

## 4. 공유 도메인 타입 영향

- `src/capture/types.ts`: `CaptureRunRow/ObservationRow/CheckpointRow/ParkingSlotRow/ParkingSlotView/CenteringSlotRow/CenteringSlotView` 삭제, `PlaceInfoRow/CameraInfoRow/PresetPosRow/SlotSetupRow/SlotSetupView/SlotCenteringRow` 신설. 이 파일을 import하는 모든 곳(위 어셈블리 그래프의 소스 전량)이 신 타입으로 갱신됨(개발자 확인).
- `NormalizedPoint`/`NormalizedQuad`(`src/domain/types.ts`)는 **미변경** — `SlotSetupView.roi`가 이를 그대로 재사용(신규 타입 정의 없이 기존 도메인 타입 재사용, CLAUDE.md 규칙2 부합).
- SettingAgent 밖(ActionAgent/DMAgent/`@parkagent/types`)에 이 타입을 참조하는 코드는 발견되지 않음(이번 세션 범위에서 재확인 안 함 — 확인 필요 항목으로 명시).

---

## 5. 검증 결과 인용 (QA 실제 결과 그대로 — 실패/스킵 은닉 없음)

| 항목 | 결과 | 출처 |
|---|---|---|
| `npx tsc --noEmit`(전체) | error 0 (착수 시 472, 27파일) | `03_qa_report.md` §0 |
| `npx vitest run`(전체) | Test Files 153 passed / Tests 1700 passed / 0 failed | `03_qa_report.md` §0 |
| 외부 서비스(VPD/LPD/LLM/카메라/시뮬레이터) 실연동 스모크 | **미수행**(전부 모킹) | `03_qa_report.md` §6 |
| 마이그레이션 실 데이터 | `place=1/camera=1/preset=3/slot=17`, FK 무결, slot_id 1..17 유일 — 리더 직접 라이브 실행 | 리더 보고(본문 §8.2) |
| 서버 라이브(13020) REST 확인 | `/capture/status`·`/capture/slots`·`/capture/occupancy`·구`/capture/runs`(404)·`/db/tables` 전부 리더 직접 확인 | 리더 보고 |
| password 마스킹 라이브 | 마스킹·검색 차단·원복 리더 직접 확인 | 리더 보고 |
| centering 실 UPDATE 경로 | **미검증**(`slot_ptz.json.items` 공백 — 코드/타입만 vitest 통과) | `02a_developer_dbcore.md` §8, `03_qa_report.md` §6 |

---

## 6. 미해결 · 후속 과제 (은닉 금지)

1. **ground-model 카메라 기하 DB 이관 미완**: `PtzCamRoi.json`의 `position/eulerAngles/fov`는 여전히 파일 정본(ground-model 읽기 경로 이관은 후속 과제, 설계서 §1.7).
2. **cam2 데이터 부재로 제외**: `preset.json`이 cam2를 기대하나 `camerapos.json`/`PtzCamRoi.json`엔 cam1만 존재 — 마이그레이션은 cam1만 채움(설계서 §8-1, 리더 확정 범위).
3. **parking_evnt/parking_slot은 스키마만**: writer/reader 미작성(ActionAgent 소비 대기).
4. **centering 이관 실검증 미완**: `slot_ptz.json`이 비어 있어 실 UPDATE 경로는 코드/타입 검증만 통과, 실 캘리브레이션 산출물로는 재검 필요.
5. **체크포인트 정지 게이트 거동 변화**: 구 CheckpointReviewer/FloorRoiReviewer의 "정지 중 review 스킵" 외곽 게이트가, 신 구조에서는 `occupancyReviewer.review`에 주입된 `shouldStop` 콜백(프리셋별 조기 break)으로 내부 위임됐다. QA는 버그가 아닌 의도된 설계 변화로 판정했으나(구현 결함 아님), **설계자 1회 확인을 권장**한다(`03_qa_report.md` §5-1).
6. **web/core.d.ts 앰비언트 선언 정정**: QA가 스테일 타입 선언(구 `ParkingSlotView` 참조)을 실제 구현(`SlotSetupView`)에 맞게 정정했다. 런타임 거동 변화는 없으나 `src/**` 외 유일한 비-테스트 수정이라 별도 명시(`03_qa_report.md` §5-2).
7. **slot_id(normalizeGlobalIdx) vs globalIdx(buildGlobalIndex) 정렬 컨벤션 일치는 "전제"이지 "보장"은 아님**: 두 넘버링이 각각 검출 클러스터/파일 공간이라는 독립 소스를 사용하므로, `PtzCamRoi.json`의 `parking_spaces` 배열 순서가 실제 공간 순서와 어긋나는 데이터가 생기면 재정합이 필요하다(`02c_developer_capture.md` §5 P2-5).
8. **`img1` 실경로 정책 미정**: `slot_setup.img1`/`parking_evnt.img1/img2`의 저장 루트·명명 규칙은 컬럼만 존재하고 writer는 후속 과제.

## 7. 외부 서비스 스모크 한계 (명시)

VPD/LPD/LLM(vLLM)/시뮬레이터에 대한 실연동 스모크 테스트는 이번 QA·문서화 단계에서 수행되지 않았다(전부 모킹). 리더가 직접 확인한 것은 SettingAgent 서버(13020)의 REST 응답과 DB 상태뿐이며, 외부 비전/LLM 서비스가 실제로 호출되는 캡처 1런을 라이브로 돌려 LLM 미호출을 로그로 확인하는 절차는 이번 산출물에 포함되지 않았다.
