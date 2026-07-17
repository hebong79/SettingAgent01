# 01. SettingAgent DB 스키마 전면 개편 + LLM 보조 최소화 — 설계(계획)

> 본 문서는 **설계(계획)만**이다. 코드 수정 금지. 근거는 `파일:줄`로 명시한다.
> 마스터 확정 결정(배경 A/B)은 변경 금지 전제로 두고, 그 위에서 검증 가능한 구현 계획을 수립한다.

---

## 0. 요약 · 확정 결론 먼저

| 항목 | 결론 | 근거 |
|---|---|---|
| 최종 테이블 | 6개: `place_info` / `camera_info` / `preset_pos` / `slot_setup` / `parking_evnt` / `parking_slot` | 배경 A.2 |
| 기존 테이블 | 10개 전부 폐기(신 DB 파일로 clean-cut) | 배경 A.1 |
| run_id | DB에서 완전 제거. `CaptureJob` 인메모리 런 식별자로만 잔존 | 배경 A.3 |
| 확정본 보호 | finalize 시 `slot_setup` 전량 **단일 트랜잭션 교체(실패 롤백)** | 배경 A.3 |
| slot_setup.slot_roi 좌표계 | **정규화 0~1** (픽셀 아님). 원본 픽셀 역변환용 `img_w/img_h`를 `camera_info`에 보관 | §1.3 |
| slot_id 체계 | **전역 정수 1..N** (`normalizeGlobalIdx` 결과). 문자열 `c{c}p{p}s{n}`은 미저장(파생) | §1.4 |
| PTZ 저장 | `pan/tilt/zoom` REAL 3컬럼(JSON TEXT 금지) | 배경 설계요구 1 |
| 가변정점 | `slot_roi/vpd_bbox/lpd_obb/occupy_range` 는 JSON TEXT | 배경 설계요구 1 |
| LLM | 캡처 루프 LLM 전면 off(floor/checkpoint off). `judgeOccupancy`만 **축소된 보조**로 잔존(인메모리, 미영속) | 배경 B |
| 캡처 중간테이블 | observation/detection/aggregated/floor_roi/occupancy/checkpoint **DB 미기록 → 인메모리 누적** | 배경 A.3 + §2 |

**신 DB 파일명 제안:** `data/setting.sqlite` (기존 `data/observations.sqlite`는 건드리지 않는다 → 롤백 지점). `tools.config.json`의 `capture.dbFile`을 이 값으로 교체. (기본값 `toolsConfig.ts:274`는 `data/observations.sqlite`.)

---

## 1. 최종 6테이블 DDL 초안 (better-sqlite3 `exec` 투입 수준)

> 규약
> - **PRAGMA foreign_keys = ON** 은 SQLite 기본 OFF다. `SqliteStore` 생성자에서 연결마다 명시적으로 켠다: `this.db.pragma('foreign_keys = ON')` (현재 `SqliteStore.ts:29`는 `journal_mode=WAL`만 설정 — FK 미설정).
> - 좌표계: **정규화 0~1**(원점 좌상단)을 표준으로 한다. `types.ts:3` "좌표는 모두 정규화(0~1), cam/preset/round 인덱스는 1-based" 규약 계승. 픽셀 저장 컬럼 없음.
> - PTZ는 REAL 3컬럼. 가변정점 폴리곤/사각형은 JSON TEXT.
> - 이미지: BLOB 금지, 상대경로 TEXT.

```sql
PRAGMA foreign_keys = ON;

-- 1) 주차장(장소) — 현재 place_id=1 고정 (my_db_table §4)
CREATE TABLE IF NOT EXISTS place_info (
  place_id    INTEGER PRIMARY KEY,           -- 현재 항상 1
  place_name  TEXT NOT NULL
);

-- 2) 카메라 (my_db_table §3 + 정규화 역변환 기준 img_w/img_h)
CREATE TABLE IF NOT EXISTS camera_info (
  cam_id       INTEGER PRIMARY KEY,          -- 1-based
  cam_name     TEXT,
  cam_uuid     TEXT,
  url          TEXT,
  user_id      TEXT,
  password     TEXT,                         -- 평문. 노출 마스킹은 조회계층(§4)이 담당
  rtsp_url     TEXT,
  cam_type     TEXT NOT NULL DEFAULT 'ptz'
                 CHECK (cam_type IN ('ptz','static')),
  cam_company  TEXT,
  place_id     INTEGER NOT NULL DEFAULT 1
                 REFERENCES place_info(place_id),
  img_w        INTEGER,                       -- PtzCamRoi 픽셀→정규화 역변환 기준(현재 1920)
  img_h        INTEGER,                       -- (현재 1080). PtzCamRoi.json export 재생성에 필수
  updated_at   TEXT
);

-- 3) 프리셋 위치 PTZ = P1 존 (my_db_table §2). PTZ는 REAL 3컬럼
CREATE TABLE IF NOT EXISTS preset_pos (
  cam_id      INTEGER NOT NULL
                REFERENCES camera_info(cam_id),
  preset_id   INTEGER NOT NULL,              -- 1-based
  sname       TEXT,                          -- camerapos.json 의 sname("Preset 1")
  pan         REAL NOT NULL,
  tilt        REAL NOT NULL,
  zoom        REAL NOT NULL,
  updated_at  TEXT,
  PRIMARY KEY (cam_id, preset_id)
);

-- 4) 슬롯 셋업 = floor_ROI + centering 병합 (my_db_table §1 + §5)
--    "전체 주차면 개수만큼, 슬롯당 1행" 이 불변식(run_id 없음)
CREATE TABLE IF NOT EXISTS slot_setup (
  slot_id        INTEGER PRIMARY KEY,        -- 전역 슬롯번호 1..N (normalizeGlobalIdx 결과)
  cam_id         INTEGER NOT NULL,
  preset_id      INTEGER NOT NULL,
  preset_slotidx INTEGER,                    -- 프리셋 내 순서(1-based). 미도출 시 NULL
  slot_roi       TEXT NOT NULL,              -- 정규화 4점 폴리곤 JSON: [[x,y],...] (painted slot)
  vpd_bbox       TEXT,                       -- 정규화 차량 bbox JSON: {"x","y","w","h"}. 미점유 NULL
  lpd_obb        TEXT,                       -- 정규화 번호판 OBB JSON: [[x,y]×4]. 부재 NULL
  occupy_range   TEXT,                       -- 정규화 점유영역(발자국) 폴리곤 JSON. 부재 NULL
  pan            REAL,                        -- 번호판중심 센터라이징 PTZ(=my_db_table 의 pos/ptz). 미센터라이징 NULL
  tilt           REAL,
  zoom           REAL,
  centered       INTEGER NOT NULL DEFAULT 0
                   CHECK (centered IN (0,1)),
  img1           TEXT,                        -- 센터라이징 후 차량 스샷 상대경로. 부재 NULL
  updated_at     TEXT,
  FOREIGN KEY (cam_id, preset_id)
    REFERENCES preset_pos(cam_id, preset_id),
  UNIQUE (cam_id, preset_id, preset_slotidx)
);
CREATE INDEX IF NOT EXISTS idx_slot_setup_campreset
  ON slot_setup(cam_id, preset_id);

-- 5) 주차 이벤트 이력 (my_db_table §6) — ActionAgent 소비, 지금은 스키마만
CREATE TABLE IF NOT EXISTS parking_evnt (
  evnt_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id      INTEGER NOT NULL
                 REFERENCES slot_setup(slot_id),
  is_occupy    INTEGER NOT NULL
                 CHECK (is_occupy IN (0,1)),
  update_time  TEXT NOT NULL,
  plate_num    TEXT,
  img1         TEXT,                          -- 차량 이미지 상대경로
  img2         TEXT                           -- 번호판 크롭 상대경로
);
CREATE INDEX IF NOT EXISTS idx_evnt_slot_time
  ON parking_evnt(slot_id, update_time DESC);

-- 6) 현재 주차면 상태 (my_db_table §7) — parking_evnt 와 컬럼 중복 금지
--    현재상태 = 최신 이벤트 포인터. 상세는 JOIN 으로 조회
CREATE TABLE IF NOT EXISTS parking_slot (
  slot_id       INTEGER PRIMARY KEY
                  REFERENCES slot_setup(slot_id),
  last_evnt_id  INTEGER
                  REFERENCES parking_evnt(evnt_id)
);
```

### 1.1 컬럼 병합 근거 (floor_ROI + centering → slot_setup)
- my_db_table 의 `floor_ROI`(§1: slot_id/cam_id/preset_id/preset_slotidx/slot_roi/**pos**)와 `centering`(§5: slot_id/cam_id/preset_id/vpd_bbox/lpd_obb/occupy_range/**ptz**/img1)은 **키·카디널리티 동일**("전체 슬롯 개수만큼")이고 `pos`(floor_ROI)와 `ptz`(centering)는 **둘 다 번호판중심 센터라이징 PTZ로 동일값**이다 → 마스터 지정대로 `pan/tilt/zoom` 단일 3컬럼으로 병합. 중복 저장 제거.
- 이 병합값은 코드상으로도 일치한다: `Finalizer.ts:242-253`가 한 슬롯의 roi/vpd/lpd/occupied/pan·tilt·zoom을 **한 행**으로 이미 조립하고, 센터라이징 PTZ는 `PtzCalibrator`→`slot_ptz.json`/`centering_slot`로 산출된다(`PtzCalibrator.ts:201-222`).

### 1.2 각 컬럼의 원천 매핑
| slot_setup 컬럼 | 원천 | 코드 근거 |
|---|---|---|
| slot_id | `normalizeGlobalIdx(place.byPreset)` 전역 1..N | `placeRoi.ts:92-112`, `Finalizer.ts:225` |
| cam_id/preset_id | PtzCamRoi cameras[].camera.cam_id / presets[].preset_idx | `placeRoi.ts:41-47` |
| preset_slotidx | 프리셋 내 위치(orderByPosition 순서, 1-based) | `Finalizer.ts:329` positionIdx, `slotPtzWriter.ts:33` |
| slot_roi | PtzCamRoi parking_spaces[].points → 정규화 | `placeRoi.ts:75`, `Finalizer.ts:244` `roiJson` |
| vpd_bbox | 공간배정된 차량 대표 bbox | `Finalizer.ts:245` `vpdJson` |
| lpd_obb | 배정 차량의 plateQuad | `Finalizer.ts:246` `lpdJson` |
| occupy_range | floor 발자국 폴리곤(결정형 `buildPlateAnchoredQuad`) | `Finalizer.ts:320,344` `floorRoiByPreset`/deconflicted |
| pan/tilt/zoom | 센터라이징 성공 PTZ(`slot_ptz.json`/`centering_slot.pos`) | `PtzCalibrator.ts:207-213` |
| centered | 센터라이징 성공 여부(1) | `PtzCalibrator.ts:206` `it.centered && it.converged` |

### 1.3 slot_roi 좌표계 결정: **정규화 0~1** (확정)
- **근거 1(코드 사실):** 현행 `parking_slots.roi_json`이 이미 정규화다 — `Finalizer.ts:244` `roiJson: JSON.stringify(sp.points)`이고 `sp.points`는 `placeRoi.ts:75`에서 `p.x / W, p.y / H`로 정규화된 값.
- **근거 2(해상도 비종속):** VPD/LPD 검출·집계 전 파이프라인이 정규화(`types.ts:3`, `CaptureJob.ts:348-355`의 `v.rect.x` 등). 픽셀로 저장하면 파이프라인 전체와 좌표계 불일치 → 재변환 산재.
- **근거 3(뷰어 정합):** 뷰어는 정규화 폴리곤을 오버레이한다(`core.js` normalize 경로). DB 정본이 정규화면 뷰어 무변경.
- **트레이드오프/보완:** PtzCamRoi.json 원본은 픽셀(1920×1080, `PtzCamRoi.json:18-19`)이고 `PUT /capture/place-roi`의 역변환(`placeRoi.ts:141-144` `p.x * W`)은 W/H가 필요하다. 그래서 **`camera_info.img_w/img_h`를 추가**해 export(PtzCamRoi.json 재생성)와 역변환의 기준을 DB가 보유하게 한다. (컬럼 주석에 명시.)

### 1.4 slot_id 전역 체계 도출 방법
- PtzCamRoi.json 의 `parking_spaces[].idx`를 `normalizeGlobalIdx`가 **파일 전체 고유 1..N**으로 정규화한다(`placeRoi.ts:87-112`): 이미 1..N 순열이면 그대로, 아니면 `(cam asc → preset asc → 배열순)`으로 재부여.
- 이 전역 1..N이 곧 `slot_setup.slot_id`. `setup_artifact.globalIndex[].globalIdx`와 **동일 정수**가 되도록 정합해야 한다(§8 리스크 참조 — 정렬 규칙 차이 주의).
- 문자열 `c{cam}p{preset}s{pos}`(`Finalizer.ts:30-32`, `centering_slot.slot_id`=`c1p2s1`)는 `(cam_id, preset_id, preset_slotidx)`에서 파생 가능하므로 **slot_setup에 저장하지 않는다**(단순화). 캘리브레이션/artifact 경로는 여전히 문자열을 쓰므로 매핑 레이어 필요(§1.5).

### 1.5 명명 통일 + 매핑 레이어 영향 범위(표)
최종 스키마는 md 기준 **`cam_id` / `preset_id`**로 통일한다. 기존 코드 전반은 `camIdx/presetIdx`(TS 필드)·`cam_idx/preset_idx`(구 DB 컬럼)를 쓴다. 매핑 필요 지점:

| 도메인 개념 | 기존 TS 필드 | 구 DB 컬럼 | 최종 DB 컬럼 | 매핑 영향 파일 |
|---|---|---|---|---|
| 카메라 | `camIdx` | `cam_idx`(대부분) / `cam_id`(centering_slot) | `cam_id` | SqliteStore(전량 재작성), Finalizer, CaptureJob, PtzCalibrator, captureRoutes, dbRoutes |
| 프리셋 | `presetIdx` | `preset_idx` / `preset_id`(centering_slot) | `preset_id` | 위와 동일 |
| 프리셋내 순서 | `positionIdx` / `presetSlotIdx` | `slot_idx`(0/1-based 혼재) / `preset_slotidx` | `preset_slotidx` | Finalizer.assemble, slotPtzWriter, PtzCalibrator |
| 전역 슬롯번호 | `globalIdx` | `parking_slots.slot_idx`(정규화 후) | `slot_id` | Finalizer, GlobalIndexer |
| 슬롯 문자열 | `slotId`(`c…p…s…`) | `centering_slot.slot_id` | (미저장·파생) | Finalizer, calibrate/* |

> **주의(구 DB 실측):** 현행 `parking_slots.slot_idx`는 `0..17` 0-based 값이 남아 있다(백업/현행 DB 동일, `data/observations.sqlite` 조회 결과). 즉 코드 주석(`Finalizer.ts:223` "전역번호 1..N")과 저장 데이터가 불일치하는 레거시 행이 존재 → 신 스키마에선 `slot_id`를 항상 `normalizeGlobalIdx` 결과로 재부여해 통일한다. 구 행은 마이그레이션하지 않는다(§5).

### 1.6 인덱스 · CHECK (요구사항 반영)
- `idx_evnt_slot_time ON parking_evnt(slot_id, update_time DESC)` — 슬롯 최신 이벤트 조회.
- `idx_slot_setup_campreset ON slot_setup(cam_id, preset_id)` — 프리셋 단위 조회(뷰어 오버레이).
- CHECK: `is_occupy IN (0,1)`, `cam_type IN ('ptz','static')`, `centered IN (0,1)`.
- (요구사항의 `slot_setup(cam_id, preset_id)` 인덱스는 위 `idx_slot_setup_campreset`로 충족. PK가 `slot_id` 단일이라 별도 인덱스가 유효.)

### 1.7 이번 범위에서 **제외**하는 것(명시)
- PtzCamRoi.json 의 카메라 외/내부 파라미터 `position/eulerAngles/fov`(`PtzCamRoi.json:7-18`)는 **지면모델(ground-model) 전용 입력**이다(`captureRoutes.ts:399-431`, `buildGroundInputs`). 이 기하는 `slot_setup`/`camera_info`의 대상이 아니며, ground-model 읽기 경로의 DB 이관은 **후속 과제**로 남긴다. → PtzCamRoi.json은 (a) 지면모델 입력, (b) slot_roi export의 이중 역할로 잔존하되, **slot ROI/preset PTZ의 정본은 DB**로 전환한다(부분 정본화, §8 리스크에 명시).

---

## 2. CaptureJob 메모리 누적 전환 설계

### 2.1 현재 구조(제거 대상)
현재 캡처 루프는 관측·검출·집계·floor·occupancy·checkpoint를 **전부 run_id 키로 DB에 기록**한다:
- `insertObservation`/`insertDetections` (`CaptureJob.ts:333,372`)
- `getDetectionsForRun`/`getPresetRounds`→`aggregate`→`replaceAggregatedSlots` (`CaptureJob.ts:484-487`)
- `CheckpointReviewer.updateAggregatedStatus` (`CheckpointReviewer.ts:89,94`)
- `FloorRoiReviewer.upsertFloorRoi` (`FloorRoiReviewer.ts:94`)
- `OccupancyReviewer.insertOccupancy` (`OccupancyReviewer.ts:63`)
- `Finalizer`가 finalize 시 위 DB를 재조회(`Finalizer.ts:96-101,138,178`).

### 2.2 목표 구조(인메모리 누적)
`CaptureJob`이 런 상태를 **필드로 보유**하고 finalize에서만 `slot_setup`을 트랜잭션 교체:
- `private dets: DetectionRow[] = []` — `insertDetections` 대체(메모리 push).
- `private roundsByPreset = new Map<string, Set<number>>()` — `getPresetRounds` 대체(distinct round 카운트).
- 집계는 매 체크포인트 `aggregate(this.dets, presetRoundsMap, opts)` 호출(Aggregator 시그니처 **불변** — `CaptureJob.ts:486`가 이미 배열+맵을 받음). 결과는 `private aggregated: AggregatedSlot[]`.
- floor 발자국은 finalize 조립 시 결정형(`buildPlateAnchoredQuad`)으로 계산(§2.3) → floor 전용 인메모리 저장 불필요.
- occupancy(축소 보조)는 `private occByPreset = new Map<string, OccupancySpace[]>()` (인메모리, §6).
- observation 원본(pan/tilt/zoom/imgName)은 finalize에서 불필요하므로 **미보유**(진행률·프레임은 기존 `lastFrameByPreset`로 충분, `CaptureJob.ts:99`).

`start()`에서 전부 clear(`CaptureJob.ts:220-221` 패턴 재사용). run_id는 `createRun/endRun` 호출 제거 후 **인메모리 카운터**(`this.runSeq++`)로만 표시(로그·status용, DB 무접촉).

### 2.3 Finalizer 전환
- 입력을 `finalize(runId)`(`Finalizer.ts:94`) → `finalize(snapshot)`로 변경. `snapshot`은 `CaptureJob`이 노출하는 `{ dets, roundsByPreset, aggregated, occByPreset }`.
- `getDetectionsForRun/getPresetRounds/getAggregatedSlots`(DB) 호출 3곳(`Finalizer.ts:96-101`) → snapshot 필드 참조로 대체.
- `getCheckpoints`(`Finalizer.ts:116`)는 LLM finalize 보조용 — LLM 최소화로 **삭제**(§6).
- `getLatestOccupancy`(`Finalizer.ts:138`)는 snapshot.occByPreset 참조로 대체(occupancyAgreement 비교 로직은 **유지**, 소스만 인메모리 — 마스터 "응답 소비 로직 최소 변경" 충족).
- `replaceParkingSlots`(`Finalizer.ts:256`) → `replaceSlotSetup(rows)`(§2.5). `insertArtifactSnapshot`(`Finalizer.ts:209`)은 artifact_snapshot 폐기로 **삭제**(setup_artifact.json 저장은 `repo.saveArtifact` `Finalizer.ts:208`로 유지).

### 2.4 재시작 복구 · 동시성 검증
- **동시성:** `CaptureJob`은 이미 단일 인메모리 잡·중복 시작 거부(`CaptureJob.ts:202-204`). `PtzCalibrator`도 단일(`PtzCalibrator.ts:93`). → 인메모리 단일 소유자 전제 **성립**. 병렬 런 없음.
- **재시작 복구:** 크래시 시 진행 중 런의 인메모리 누적은 소실된다. **이는 수용 가능**하다 — 마스터 결정 A.3: "이전 확정본 보호는 finalize 성공 시 slot_setup 전량 교체(실패 롤백)". 즉 **확정본(slot_setup)은 항상 온전**하고, 진행 중(미확정) 수집은 애초에 휘발성으로 설계한다. 크래시 = 재수집. 규모도 문제없다(단일 런 검출 수는 수백~수천, 과거 117런 누적 17072건 `detection` 기준 런당 ≈150건).
- **성립 조건 불성립 시 대안(불필요 판정):** 만약 "런 중 크래시에도 부분 복구"가 요구되면 append-only WAL 스냅샷이 필요하나, 마스터 결정이 명시적으로 이를 배제하므로 **대안 미채택**. (이 판단을 리더에게 확인 요청 — §8.)

### 2.5 신규 SqliteStore 표면(메서드 재설계)
**삭제**(구 10테이블 전용): createRun/updateRunProgress/endRun/getRun/listRuns/insertObservation/insertDetections/getDetectionsForRun/getPresetRounds/replaceAggregatedSlots/getAggregatedSlots/updateAggregatedStatus/insertCheckpoint/getLatestCheckpoint/getCheckpoints/insertArtifactSnapshot/upsertFloorRoi/getFloorRois/insertOccupancy/getLatestOccupancy/replaceParkingSlots/getParkingSlots/upsertCenteringSlots/getCenteringSlots (`SqliteStore.ts:145-521` 전량).

**신규:**
- `replaceSlotSetup(rows: SlotSetupRow[]): void` — `DELETE FROM slot_setup; INSERT …` 를 **단일 `this.db.transaction`**으로(현행 `replaceParkingSlots` `SqliteStore.ts:472-490` 패턴 재사용, run_id 제거). 예외 시 better-sqlite3 transaction이 자동 롤백 → 이전 확정본 보존.
- `getSlotSetup(): SlotSetupView[]` — 뷰어/`/capture/slots` 소스(`ORDER BY cam_id, preset_id, preset_slotidx`).
- `upsertCameraInfo/upsertPresetPos/upsertPlaceInfo` — 마이그레이션·export 역경로.
- `upsertSlotCentering(rows)` — `PtzCalibrator`가 pan/tilt/zoom/centered/img1만 갱신(slot_id 키 UPDATE. 부분 캘리브레이션이 타 슬롯 전멸 안 하도록 키 단위 — 현행 `upsertCenteringSlots` `SqliteStore.ts:497-510` 철학 계승).
- (parking_evnt/parking_slot 소비 코드는 ActionAgent 단계 — 이번엔 스키마 생성만, writer/reader 미작성.)

---

## 3. REST 계약 파괴 대응

run_id 소멸로 다음 라우트가 깨진다(`captureRoutes.ts`). 대체안:

| 기존 라우트 | 파괴 원인 | 대체안 | 응답 shape 변화 |
|---|---|---|---|
| `GET /capture/runs` (`:270`, `listRuns`) | capture_run 폐기 | **삭제** 또는 `GET /capture/status` 단일화. 뷰어 폴백(app.js:2213 `runs[0].id`) 제거 | 배열 → (라우트 제거) |
| `GET /capture/runs/:id/aggregate` (`:272`) | run_id·aggregated_slot 폐기 | `GET /capture/aggregate` (id 없음) → `job.getAggregated()`(인메모리 현재/최근 런) | 동일 `AggregatedSlot[]`, URL만 변경 |
| `GET /capture/runs/:id/occupancy` (`:287`) | occupancy 테이블 폐기 | `GET /capture/occupancy` → `job.getOccupancy()`(인메모리, 축소 보조). LLM off 시 `[]` | rows shape 유지(camIdx/presetIdx/spaces), URL 변경 |
| `GET /capture/runs/:id/slots` (`:301`) | parking_slots 폐기 | `GET /capture/slots` → `store.getSlotSetup()`(정본 직접) | 필드명 `slotIdx→slotId`, `roi/vpd/lpd` 유지 |
| `POST /capture/finalize` (`:240`) | `runId` 인자 | 바디 `runId` 제거, 현재 잡 snapshot으로 finalize | `{ok,slots,globalCount}` 유지 |

### 3.1 진행률
진행률은 이미 `GET /capture/status`(`captureRoutes.ts:183` → `CaptureJob.getStatus()` `CaptureJob.ts:163`)가 인메모리 상태를 준다. run_id 필드만 제거(또는 인메모리 seq 유지). **추가 라우트 불필요**.

### 3.2 결과 조회
finalize 후 결과는 `slot_setup` 직접 조회(`GET /capture/slots`). 뷰어의 "최종화 후 표시"(app.js:1969 `loadParkingSlots`)는 새 라우트로 fetch, 키는 `presetKey`(`cam:preset`) 유지하려면 응답 행에 `presetKey`를 계산해 포함하거나, 뷰어가 `${cam_id}:${preset_id}`로 조립(app.js:1979 `r.presetKey` 의존 → 응답에 `presetKey` 파생필드 포함 권장).

### 3.3 뷰어(web) 변경 목록(응답 shape 변화)
| 파일:줄 | 현재 | 변경 |
|---|---|---|
| `app.js:1839,2225` `fetchOccupancy` | `GET /capture/runs/${runId}/occupancy` | `GET /capture/occupancy`(id 제거). LLM off면 빈 배열 → 프론트 `occupancy.js` 결정형 판정으로 폴백(이미 순수 컴포넌트 `occupancy.js:14`) |
| `app.js:1974` `loadParkingSlots` | `GET /capture/runs/${runId}/slots`, `r.presetKey` | `GET /capture/slots`. 응답에 `presetKey`(`cam_id:preset_id`) 파생 포함, `slotIdx→slotId` |
| `app.js:2213` 분석탭 폴백 | `GET /capture/runs`→`runs[0].id` | runId 개념 제거, 폴백 삭제 |
| `app.js:2568-2610` DB탭 | `GET /db/tables`, `/db/table/:name` | 테이블 목록이 신 6테이블로 자동 변경(화이트리스트 sqlite_master 기반이라 코드 무변경, §4 마스킹만 추가) |
| `state.lastRunId` 사용부 | 여러 곳 | 인메모리 단일 런 전제로 제거 또는 상수화 |

---

## 4. dbRoutes 보안 (password 평문 노출 차단)

- **문제:** `GET /db/table/camera_info`가 `SELECT *`(`dbRoutes.ts:111`)로 `camera_info.password` 평문을 그대로 반환한다.
- **설계(컬럼 마스킹):** `registerDbRoutes`에 민감 컬럼 맵을 둔다.
  ```
  const SENSITIVE: Record<string, Set<string>> = {
    camera_info: new Set(['password']),   // 필요 시 rtsp_url/user_id 추가 검토
  };
  ```
  조회 후 rows 후처리(`dbRoutes.ts:110-114` 사이): `name`이 키면 해당 컬럼값을 `row[col] != null ? '****' : null`로 치환.
- **검색 정합:** 검색(`dbRoutes.ts:100-105`)이 `password` 컬럼에 매칭되면 값은 마스킹되나 매칭은 발생 → 정보 유출(존재 여부). **민감 컬럼을 검색 대상에서 제외**(clauses 생성 시 `SENSITIVE[name]`에 든 컬럼 skip).
- **범위 최소:** read-only 뷰어 전용이므로 마스킹은 응답 계층 1곳. write 라우트 없음(`dbRoutes.ts:38` "write 라우트 없음").
- **검증:** vitest — `camera_info`에 password 있는 fixture DB → `/db/table/camera_info` 응답 rows[].password === '****', 다른 테이블 무영향, 검색어가 password 값과 일치해도 행 비노출.

---

## 5. 마이그레이션 설계 (1회성 이관 스크립트)

**스크립트 위치 제안:** `src/tools/migrateToSettingDb.ts` (기존 `src/tools/exportCamerapos.ts` 패턴). 입력 파일 → 신 DB(`data/setting.sqlite`).

### 5.1 이관 소스 → 테이블
| 소스 | → 테이블 | 매핑 | 근거 |
|---|---|---|---|
| (상수) | place_info | `{place_id:1, place_name:'Place01'}` | my_db_table §4 "현재 무조건 1" |
| PtzCamRoi.json `cameras[].camera` | camera_info | cam_id, img_w=imageWidth, img_h=imageHeight. name/url/user/pw/rtsp/company=NULL(자동탐색 미보유), cam_type='ptz', place_id=1 | `PtzCamRoi.json:5-19` |
| camerapos.json `datas[].datas[]` | preset_pos | cam_id, preset_id, sname, pan, tilt, zoom | `camerapos.json:8-30` |
| PtzCamRoi.json `presets[].parking_spaces[]` | slot_setup | slot_id=`normalizeGlobalIdx`, cam_id, preset_id, preset_slotidx=배열순 1-based, slot_roi=정규화 4점 | `placeRoi.ts:75,92` |
| slot_ptz.json(`data/slot_ptz.json`) + `centering_slot`(구 DB 1행) | slot_setup(UPDATE) | 매칭키 `(cam_id,preset_id,preset_slotidx)` 또는 slotId 문자열 → pan/tilt/zoom/centered=1/img1 | `slotPtzWriter.ts`, `PtzCalibrator.ts:207` |

### 5.2 구 DB(observations.BACKUP_20260718.sqlite) 재활용 검토 — 실측 결과
- **parking_slots 561행:** 33개 서로 다른 run_id에 걸친 스냅샷(런당 ≈17행), `slot_idx`는 **0-based per-preset**(0..17), `pan/tilt/zoom`은 **전부 NULL**, `occupied`는 런별 관측값. → **정본 기하로 부적합**. 이유: (a) run 스코프라 "슬롯당 1행" 불변식 위반, (b) slot_idx가 전역번호가 아님, (c) occupied는 셋업 기하가 아니라 시점 점유(→ parking_evnt 도메인, ActionAgent). **slot_setup으로 이관하지 않는다.** slot_roi 기하는 PtzCamRoi.json이 정본이므로 손실 없음.
- **centering_slot 1행(`c1p2s1`, cam1/preset2/slot1, pan≈51.54/tilt≈9.37/zoom≈14.40):** 유효한 센터라이징 PTZ → **slot_setup으로 살린다**. 매칭: cam_id=1, preset_id=2, preset_slotidx=1 → 해당 slot_setup 행 UPDATE(pan/tilt/zoom, centered=1). (`data/slot_ptz.json`이 있으면 그쪽이 더 풍부하니 우선, 없으면 이 1행.)

### 5.3 slot_id 전역 체계 도출 (재확인)
- `normalizeGlobalIdx(normalizePtzCamRoi(PtzCamRoi.json).byPreset)` → cam→preset→배열순 1..N. 현재 PtzCamRoi.json은 **cam1만** 존재하므로 slot_setup은 cam1 프리셋들의 슬롯만 채워진다(§8 불일치 참조).

### 5.4 검증
- vitest: 소형 PtzCamRoi/camerapos fixture → 마이그레이션 → slot_setup 행수 = Σ parking_spaces, slot_id 1..N 유일, preset_pos 행수 = camerapos 프리셋 수, FK 무결성(PRAGMA foreign_key_check 빈 결과).
- 리더 경험적: 실제 파일로 스크립트 실행 → `SELECT COUNT(*)` 및 `PRAGMA foreign_key_check` 무결.

---

## 6. LLM 정리 설계

### 6.1 occupancy.yaml 축소 (points_2d 제거, occupied bool만)
- **코드 사실:** 파싱은 이미 좌표 optional이다 — `OccupancyRawSpaceSchema`(`SetupBrain.ts:133-138`)의 `points_2d/bbox_2d`가 `.optional()`, `AgentRuntime.judgeOccupancy`(`AgentRuntime.ts:310-316`)가 폴리곤 부재를 graceful 처리. → **스키마·파싱 코드 변경 0**, 프롬프트만 축소하면 된다.
- **Finalizer 소비:** `occupancyAgreement`는 `id/occupied`만 대조(`Finalizer.ts:156-160`) → occupied만 있어도 동작. 소스만 인메모리(§2.3).
- **축소 프롬프트 초안(`config/prompts/occupancy.yaml` 교체):**
  ```yaml
  # 점유 여부만 판정(좌표 미요구). judgeOccupancy 가 system+user 로 사용.
  # {{camIdx}} {{presetIdx}} {{imgW}} {{imgH}} {{expected}} 치환.
  system: |
    You judge parking occupancy in a downward-tilted CCTV view ({{imgW}}x{{imgH}}).
    For EACH visible painted parking slot, decide ONLY whether a vehicle occupies it.
    Do NOT output coordinates. Do NOT compute percentages. occupied flag only.
    Number slots left->right, top row first, 1-based id. If none visible, spaces=[].
    Output STRICT JSON only (no prose/fence):
    {"spaces":[{"id":1,"occupied":true}],"confidence":0.0}
  user: |
    camera={{camIdx}} preset={{presetIdx}} image={{imgW}}x{{imgH}}px expected(hint)={{expected}}
    Return every visible slot's id and occupied flag per the JSON schema. No coordinates.
  ```

### 6.2 프롬프트 아카이브 이동 (`config/prompts/_archive/`, 물리 삭제 아님)
| 파일 | 사유 |
|---|---|
| `stage1_preset_judge.system.md` / `.user.md` | stage1 off |
| `stage2_dedupe_label.system.md` / `.user.md` | stage2 off |
| `stage3_final_report.system.md` / `.user.md` | stage3 off |
| `floor_roi.yaml` | floorRoi off(결정형 폴백만) |
| `floor_roi_origin_01.yaml` / `floor_roi_origin_02.yaml` / `floor_roi.en_box.draft.yaml` | floor_roi 실험본(미사용) |
| `ptz_centering.yaml` | adviseCentering 死코드 |
| **유지:** `occupancy.yaml`(축소본) | 보조 점유(잔존) |

### 6.3 llm.config.json 토글 변경
| 키 | 현재(`llm.config.json`) | 변경 |
|---|---|---|
| `setupPrompts.stage1Enabled` | true(`:88`) | **false** |
| `setupPrompts.stage2Enabled` | true(`:89`) | **false** |
| `setupPrompts.stage3Enabled` | true(`:90`) | **false** |
| `floorRoi.enabled` | true(`:96`) | **false** |
| `occupancy.enabled` | true(`:102`) | **true 유지**(축소 보조) |
| `centering` 블록 | 존재(`:106-108`) | **제거**(adviseCentering 死코드 삭제와 동반) |
| (경로) stage1/2/3·floorRoi.prompt | 활성 경로 | `_archive/` 경로로 갱신(또는 enabled=false라 무해하지만 정합 위해 갱신) |

### 6.4 死코드 처리 (adviseCentering)
- **확인:** `adviseCentering`는 `AgentRuntime.ts:331`에만 구현, `SetupBrain.ts:214`에 optional 선언, **호출자 0**(grep: PtzCalibrator/platePtz는 미참조 — 센터라이징은 `platePtz.ts:188` 순수 P제어, LLM import 0). → 死코드 확정.
- **처리:** `AgentRuntime.adviseCentering`(`:331-343`), `SetupBrain.ts`의 `CenteringAdviceInput/CenteringAdviceSchema/CenteringAdvice/adviseCentering?`(`:178-214`), `calibrate/types.ts:54` `CenteringAdvice`, `llmConfig.ts:91-95` `CenteringSchema` + `LlmConfigSchema.centering`(`:123`) 삭제. `ptz_centering.yaml` 아카이브.
- **주의:** 삭제 전 `import` 고아 정리(`AgentRuntime.ts:19,25,26`의 CenteringAdvice* import). CLAUDE.md 규칙 3(고아 import 제거) 적용.

### 6.5 캡처 루프 LLM 제거에 따른 컴포넌트 정리
- `CheckpointReviewer`(status merged/rejected): LLM off면 전부 candidate 유지(무효과) → 캡처 루프에서 **제거**(`CaptureJob.ts:489-499`, index.ts:52,65). `judgePreset/dedupeAndLabel/finalReport/reviewCheckpoint/finalizeCapture`는 AgentRuntime에 남기되(공유 계약 오염 회피) 캡처 배선에서 분리 — 삭제 여부는 리더 판단(§8). **최소안: 배선만 제거, 메서드 잔존**(단순함 vs 死코드 트레이드오프 명시).
- `FloorRoiReviewer`: floor 발자국은 Finalizer가 `buildPlateAnchoredQuad` 결정형으로 항상 생성(`Finalizer.ts:320,344`) → 캡처 루프 floor 계산 **제거**(`CaptureJob.ts:502-511`, index.ts:53-55,65).
- `OccupancyReviewer`: 축소 보조로 **인메모리 저장 버전으로 축소**(insertOccupancy→occByPreset.set). LLM off면 no-op. finalize agreement 소스로만 사용(§2.3).

---

## 7. 작업 순서와 검증 게이트 (파괴적 — 단계별 롤백 지점)

> 롤백 안전판: 신 DB 파일(`data/setting.sqlite`)을 쓰므로 구 `data/observations.sqlite`는 마지막까지 무손상. `capture.dbFile` 한 줄 원복으로 전체 롤백.

| 단계 | 작업 | 검증(게이트) | 롤백 지점 |
|---|---|---|---|
| P0 | 신 6테이블 DDL + `SqliteStore` 전면 재작성(구 메서드 삭제, 신 메서드) | **vitest**: 스키마 생성, `foreign_keys=ON` 확인, FK 위반 INSERT 거부, `replaceSlotSetup` 트랜잭션 원자성(중간 throw 시 이전 행 보존) | 신 파일 미사용 시 무영향 |
| P1 | 마이그레이션 스크립트 | **vitest**(fixture) + **리더 경험적**: 실파일 실행 → 행수·`foreign_key_check` 무결 | 스크립트 재실행(멱등: DELETE후 INSERT) |
| P2 | `CaptureJob` 인메모리 누적 + `Finalizer` snapshot 입력 + reviewer 배선 정리 | **vitest**: 인메모리 aggregate 결과가 구 DB경로와 동일(파리티), finalize가 `slot_setup` 전량 교체·실패 롤백 | P2 코드 revert |
| P3 | REST 라우트 재편(runs/occupancy/slots/aggregate/finalize) + 뷰어 fetch 경로 | **vitest**(라우트) + **리더 경험적**: `npm run dev`→ `curl /capture/status`,`/capture/slots`,`/db/tables`; 뷰어 DB탭·최종화 표시 확인 | 라우트 파일 revert |
| P4 | dbRoutes password 마스킹 | **vitest**: camera_info password '****', 검색 제외 | 독립 — revert 용이 |
| P5 | LLM 정리(occupancy.yaml 축소, 프롬프트 아카이브, 토글, adviseCentering 삭제) | **vitest**: 축소 프롬프트로 judgeOccupancy 파싱 성공, config 로드 OK, adviseCentering 참조 0(grep) + **리더**: 캡처 1런에 LLM 호출 로그 없음 | config·프롬프트 원복 |

**리더 경험적 검증이 필수인 지점:** P1(실데이터 이관), P3(서버 기동·curl·뷰어), P5(캡처 중 LLM 미호출 확인). 나머지는 vitest로 성공 확정.

---

## 8. 미해결 · 리스크 (은닉 금지 — 리더 확인 요청)

1. **cam2 데이터 부재(정합 불가):** `preset.json`은 `{camIdx:2, idx:1, faceCount:1}`(`preset.json:6`)로 cam2를 기대하나, `camerapos.json`엔 cam1 preset1~3만(`camerapos.json:8-30`), `PtzCamRoi.json`엔 cam1만 존재. → cam2는 preset_pos·slot_setup을 **채울 수 없다**. 마이그레이션은 cam1만 생성. **질문:** cam2를 이번 범위에서 제외(권장)할지, 별도 데이터 확보 후 진행할지?
2. **slot_id 전역 정렬 규칙 불일치 가능성:** `setup_artifact.globalIndex.globalIdx`는 `buildGlobalIndex`(cam→preset→**orderByPosition 위치**→slotId, `GlobalIndexer.ts:17-23`)로, `slot_setup.slot_id`는 `normalizeGlobalIdx`(cam→preset→**parking_spaces 배열순**, `placeRoi.ts:92`)로 부여된다. 두 순서가 다르면 **동일 슬롯의 globalIdx ≠ slot_id**가 될 수 있다. 현재 `setup_artifact.json`은 비어 있어(presets/slots/globalIndex 전부 `[]`) 즉시 충돌은 없으나, 재-finalize 시 두 체계가 어긋날 위험. **설계 제안:** 정본을 `normalizeGlobalIdx`(PtzCamRoi 배열순)로 단일화하고 `buildGlobalIndex`도 동일 순서를 쓰도록 정렬키를 맞춘다. **질문:** 이 단일화를 이번 범위에 포함할지?
3. **PtzCamRoi.json 부분 정본화:** slot ROI/preset PTZ의 정본은 DB로 전환하되, ground-model이 읽는 카메라 기하(position/euler/fov)는 PtzCamRoi.json에 잔존(§1.7). "DB 정본" 완결은 ground-model 읽기 경로 이관까지 필요 → **후속 과제**로 분리 제안.
4. **occupancy 축소 보조의 존치 가치:** 캡처 루프 LLM을 전부 끄면 occupancy도 사실상 유일 잔존 LLM인데, finalize의 `occupancyAgreement`는 best-effort 지표일 뿐이다(`Finalizer.ts:133`). **질문:** occupancy도 완전 off(occupancy.yaml까지 아카이브)할지, 축소 보조로 남길지? 마스터 배경 B.1은 "보조로 남김"으로 읽었으나 확인 요망.
5. **reviewer 메서드 잔존 vs 삭제:** §6.5에서 AgentRuntime의 stage/checkpoint/finalizeCapture/recognizeFloorRoi 메서드는 배선만 끊고 코드는 남기는 최소안을 제안했다. CLAUDE.md 규칙 2(단순함)·3(死코드 미삭제 원칙 — 요청 없으면 남김)이 상충 → **배선 제거만 하고 메서드는 유지**(요청 범위 밖 삭제 금지)를 기본안으로 함. 전면 삭제 원하면 지시 요망.
6. **뷰어 runId 의존 잔재:** `state.lastRunId`가 app.js 다수 지점에서 쓰인다. run_id 제거 시 뷰어 상태모델을 "단일 현재 셋업"으로 축소해야 하며, 회귀 위험(오버레이/분석탭). P3에서 리더 경험적 검증 필수.
7. **parking_evnt/parking_slot 무소비:** 스키마만 생성(배경 A.5). FK가 slot_setup에 걸리므로 slot_setup이 먼저 채워져야 이후 ActionAgent가 이벤트를 넣을 수 있다(생성 순서는 DDL 순서로 보장).
8. **`img1` 실경로 정책 미정:** slot_setup.img1(센터라이징 스샷)·parking_evnt.img1/img2의 저장 루트·명명 규칙 미정의. 이번엔 컬럼만 두고 writer는 후속(스키마 생성만).

---

## 부록 A. 영향 받는 파일/모듈 (구현자·문서화 전달용)

**핵심 재작성:**
- `src/capture/SqliteStore.ts` — 전면 재작성(구 10테이블·메서드 삭제, 신 6테이블·메서드).
- `src/capture/types.ts` — Run/Observation/Detection/AggregatedSlot(유지)·ParkingSlotRow/CenteringSlotRow → SlotSetupRow/SlotSetupView 로 교체.
- `src/capture/CaptureJob.ts` — 인메모리 누적, DB 중간기록 제거, reviewer 배선 정리.
- `src/capture/Finalizer.ts` — snapshot 입력, `replaceSlotSetup`, artifact_snapshot·checkpoints 제거.
- `src/index.ts` — 조립부(reviewer 3종 배선, dbFile) 갱신(`index.ts:50-93`).

**REST/뷰어:**
- `src/api/captureRoutes.ts` — runs/aggregate/occupancy/slots/finalize 재편.
- `src/api/dbRoutes.ts` — password 마스킹 + 검색 제외.
- `web/app.js`, `web/core.js` — fetch 경로·응답 shape 정합(§3.3).

**캘리브레이션:**
- `src/calibrate/PtzCalibrator.ts` — `upsertCenteringSlots`→`upsertSlotCentering`(slot_id 키), cam_id/preset_id 명명.

**LLM:**
- `config/llm.config.json` — 토글·centering 블록.
- `config/prompts/occupancy.yaml`(축소) + `config/prompts/_archive/`(이동 8종).
- `src/brain/AgentRuntime.ts`, `src/brain/SetupBrain.ts`, `src/calibrate/types.ts`, `src/config/llmConfig.ts` — adviseCentering/CenteringAdvice 삭제.

**마이그레이션(신규):**
- `src/tools/migrateToSettingDb.ts` — 1회성 이관.

**설정:**
- `config/tools.config.json`(또는 기본값 `toolsConfig.ts:274`) — `capture.dbFile = data/setting.sqlite`.

## 부록 B. MCP 도구 vs LLM 두뇌 경계 판단
- **결정형(도구):** DDL/CRUD, 마이그레이션, `slot_setup` 트랜잭션 교체, 집계(`aggregate`), floor 발자국(`buildPlateAnchoredQuad`), 센터라이징(`platePtz.centerOnPlate` 순수 P제어), 점유 기하판정(`pointInPolygon`, `Finalizer.ts:237`). → **전부 결정형 유지·강화**.
- **LLM 두뇌:** occupancy occupied 판정만 축소 보조로 잔존(모호·시각 맥락). floor/checkpoint/stage/centering 자문은 **결정형이 정본이므로 LLM 불필요** → off/아카이브.
- 본 개편의 방향성은 "경계를 LLM에서 결정형으로 이동"으로, MCP 경계 규약(실시간·수치반복 루프=도구)에 부합.
