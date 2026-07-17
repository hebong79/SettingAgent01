# 02a. DB 코어 구현 (P0 SqliteStore+types 재작성 / P1 마이그레이션) — 변경 요약

> 범위: **P0(SqliteStore + types 재작성) + P1(마이그레이션 스크립트)** 만.
> CaptureJob/Finalizer/REST/뷰어/LLM/PtzCalibrator 는 미변경(다른 개발자 담당). 하위호환 파괴점은 §5 에 명시.
> 설계서 `_workspace/01_architect_plan.md` §1(DDL)·§2.5(SqliteStore 표면)·§5(마이그레이션) 준수.

---

## 1. 수정/신규 파일

| 파일 | 조치 |
|---|---|
| `src/capture/SqliteStore.ts` | **전면 재작성**. 구 10테이블 DDL·`addColumnsIfMissing` 마이그레이션·구 메서드 24종 전량 삭제. 신 6테이블 DDL + 신 메서드 7종. |
| `src/capture/types.ts` | 삭제 테이블 전용 타입 제거, 신 스키마 Row/View 추가(§3). |
| `src/tools/migrateToSettingDb.ts` | **신규**. 파일 정본 → 신 DB 1회성 이관 CLI. |

---

## 2. 신 6테이블 (설계서 §1 DDL 그대로)

`place_info` / `camera_info` / `preset_pos` / `slot_setup` / `parking_evnt` / `parking_slot`.

- 생성자에서 `PRAGMA journal_mode = WAL` **다음 줄**에 `PRAGMA foreign_keys = ON` 명시(연결마다 — SQLite 기본 OFF).
- DDL 순서 = FK 부모 우선(place→camera→preset→slot→evnt→slot 포인터).
- 좌표계: 가변정점(`slot_roi`/`vpd_bbox`/`lpd_obb`/`occupy_range`)은 **정규화 0~1** JSON TEXT. `pan/tilt/zoom` REAL. `img1` 상대경로 TEXT. 컬럼 주석에 규약 명시.
- 명명: `cam_id`/`preset_id`(md 기준. camIdx/presetIdx 아님).
- `parking_evnt`/`parking_slot` 은 **스키마만**(writer/reader 미작성 — ActionAgent 단계).
- CHECK: `cam_type IN ('ptz','static')`, `centered IN (0,1)`, `is_occupy IN (0,1)`.
- 인덱스: `idx_slot_setup_campreset(cam_id,preset_id)`, `idx_evnt_slot_time(slot_id, update_time DESC)`.
- `slot_setup` UNIQUE `(cam_id, preset_id, preset_slotidx)`, FK `(cam_id,preset_id)→preset_pos`.

### slot_roi JSON 포맷 결정(설계 DDL 주석과의 차이 — 명시)
설계 DDL 주석은 `[[x,y],...]` 이나, **구현은 `[{x,y}×4]`(NormalizedPoint[])** 를 저장한다.
근거: 현행 정본 경로(`Finalizer.roiJson = JSON.stringify(sp.points)`, `placeRoi.ts`의 `{x,y}`)와 뷰어 소비 형태가 객체형이라, 배열형 채택 시 뷰어/파서 전면 개편이 유발된다. 외과적 변경 원칙상 **기존 객체형 유지**. `SlotSetupView.roi` 도 `NormalizedPoint[]`.

---

## 3. types.ts 변경

**삭제**(삭제 테이블 전용): `CaptureRunRow`, `ObservationRow`, `CheckpointRow`, `ParkingSlotRow`, `ParkingSlotView`, `CenteringSlotRow`, `CenteringSlotView`.
**유지**(캡처 파이프라인 인메모리): `DetectionRow`, `AggregatedSlot`, `CaptureState`, `CaptureStatus`.
**신규**: `PlaceInfoRow`, `CameraInfoRow`, `PresetPosRow`, `SlotSetupRow`, `SlotSetupView`, `SlotCenteringRow`.

- `SlotSetupRow`: `slotId, camId, presetId, presetSlotIdx(null 가능), slotRoi(JSON), vpdBbox/lpdObb/occupyRange(null 가능 JSON), pan/tilt/zoom(null 가능), centered(0/1), img1(null 가능), updatedAt`.
- `SlotSetupView`: 파싱형 — `roi: NormalizedPoint[]`, `vpd/lpd/occupyRange` 객체 or null, pan/tilt/zoom null 가능, `centered: boolean`, **`presetKey: \`${camId}:${presetId}\`` 파생필드 포함**.
- `SlotCenteringRow`: 부분 캘리브레이션 UPDATE 입력(`slotId, pan, tilt, zoom, centered, img1, updatedAt`).

---

## 4. 신 SqliteStore 메서드 시그니처 (다른 개발자 계약)

```ts
class SqliteStore {
  constructor(dbPath: string);           // WAL + foreign_keys=ON + ensureSchema(신 6테이블)
  close(): void;

  // 마이그레이션·export 역경로 upsert (ON CONFLICT DO UPDATE, 배열 단위 트랜잭션)
  upsertPlaceInfo(rows: PlaceInfoRow[]): void;        // PK place_id
  upsertCameraInfo(rows: CameraInfoRow[]): void;      // PK cam_id (전 컬럼 갱신)
  upsertPresetPos(rows: PresetPosRow[]): void;        // PK (cam_id, preset_id)

  // 확정본 정본
  replaceSlotSetup(rows: SlotSetupRow[]): void;       // DELETE 전량 + INSERT 전량, 단일 트랜잭션(실패 자동 롤백)
  getSlotSetup(): SlotSetupView[];                    // ORDER BY cam_id, preset_id, preset_slotidx. *_json 파싱 + presetKey 파생
  upsertSlotCentering(rows: SlotCenteringRow[]): void;// slot_id 키 부분 UPDATE(pan/tilt/zoom/centered/img1/updated_at 만)
}
```

- **`replaceSlotSetup` 원자성**: DELETE→INSERT 를 하나의 `db.transaction` 으로. 중간 throw 시 DELETE 포함 전체 롤백 → 이전 확정본 보존(설계 배경 A.3). 스모크로 검증(§6).
- **`upsertSlotCentering`**: slot_id 미존재 행은 UPDATE 0건(조용히 무시 — slot_setup 이 먼저 채워져야 함). 전량 delete 금지 — 부분 캘리브레이션이 타 슬롯 기하/센터링을 지우지 않음(현행 철학 계승).
- `getParkingSlots`/`getCenteringSlots`/`getRun`/`listRuns`/`getAggregatedSlots`/`getLatestOccupancy` 등 **구 메서드는 존재하지 않음** → 다른 개발자는 신 메서드로 대체 필요(§5).

---

## 5. 하위호환 파괴점 (다른 개발자에게 넘김 — 이번 범위 밖, 수정 안 함)

`npx tsc --noEmit` 결과 **내 3개 파일(SqliteStore/types/migrate)은 에러 0**. 아래는 구 메서드/타입 삭제로 발생한 다운스트림 에러(P2~P5 에서 각 담당이 해소):

| 파일 | 깨진 참조 | 대체(설계서) |
|---|---|---|
| `src/capture/CaptureJob.ts` | createRun/endRun/updateRunProgress/insertObservation/insertDetections/getDetectionsForRun/getPresetRounds/replaceAggregatedSlots/getAggregatedSlots | 인메모리 누적(§2.2) |
| `src/capture/Finalizer.ts` | `ParkingSlotRow` import, getDetectionsForRun/getPresetRounds/getAggregatedSlots/replaceAggregatedSlots/getCheckpoints/getLatestOccupancy/getFloorRois/insertArtifactSnapshot/replaceParkingSlots | snapshot 입력 + `replaceSlotSetup(rows)`(§2.3). `ParkingSlotRow`→`SlotSetupRow` |
| `src/capture/CheckpointReviewer.ts` | updateAggregatedStatus/insertCheckpoint | 캡처 루프서 제거(§6.5) |
| `src/capture/FloorRoiReviewer.ts` | upsertFloorRoi | 캡처 루프서 제거(§6.5) |
| `src/capture/OccupancyReviewer.ts` | insertOccupancy | 인메모리 occByPreset(§6.5) |
| `src/api/captureRoutes.ts` | listRuns/getRun/getAggregatedSlots/getLatestOccupancy/getParkingSlots | 라우트 재편(§3) — `getParkingSlots`→`getSlotSetup` |
| `src/calibrate/PtzCalibrator.ts` | `CenteringSlotRow` import, `upsertCenteringSlots` | `SlotCenteringRow` + `upsertSlotCentering`(slot_id 키). ★ centering_slot 문자열 slotId→**정수 slot_id** 매핑 필요 |
| `src/index.ts` | `Pick<SqliteStore,'upsertCenteringSlots'>` | `'upsertSlotCentering'` 로 교체 |
| `test/*` (18개) | 구 메서드/테이블 | 각 기능 재작성 시 동반 갱신 |

### PtzCalibrator 계약 주의(★ 다른 개발자 필독)
구 `CenteringSlotRow.slotId` 는 문자열 `c1p2s1`, `pos` 는 PTZ JSON 문자열이었다.
신 `SlotCenteringRow.slotId` 는 **정수 slot_id**(전역 1..N), `pan/tilt/zoom` 는 **분해된 REAL**.
→ PtzCalibrator 는 `it.ptz`(pan/tilt/zoom)를 분해하고, `it.globalIdx`(또는 slotId 문자열→slot_id 역매핑)로 정수 slot_id 를 확보해야 한다. 설계 §8.2(globalIdx vs slot_id 정렬 단일화 리스크) 참조.

---

## 6. 검증 결과 (self-check)

**tsc**: `SqliteStore.ts`/`types.ts`/`migrateToSettingDb.ts` 에러 0. 다운스트림 에러는 §5(예상된 파괴 — 미수정).

**마이그레이션 스모크**(실데이터 → scratchpad 임시 DB):
```
[migrate] 완료: place=1 camera=1 preset=3 slot=17 centered=0
foreign_key_check: []  OK(empty)
count place_info=1 camera_info=1 preset_pos=3 slot_setup=17 parking_evnt=0 parking_slot=0
slot_id min/max/unique: 1 17 unique (n=17)
sample slot_id=8: cam_id=1 preset_id=2 preset_slotidx=6 slot_roi=정규화 0~1
camera: cam_type='ptz' img_w=1920 img_h=1080 place_id=1 (name/url/pw 등 NULL)
```
- slot 17 = Σ parking_spaces(preset1:7 + preset2:6 + preset3:4). slot_id 1..17 유일.
- **cam2 자연 제외**(데이터에 cam1만 존재 — 억지 생성 안 함, 리더 확정).
- centered=0 (현행 `slot_ptz.json.items`=[] → 스킵. 파일 우선 로직은 구현되어 있음).
- **멱등 재실행**: 재실행 후에도 slot=17, FK empty(place/camera/preset upsert, slot replace).

**트랜잭션 원자성**(:memory: 인라인):
- `replaceSlotSetup([good])` → 1행. 이어 PK 충돌 유발 `replaceSlotSetup([dup1, dup2])` → throw + **전체 롤백**, 이전 확정본 `[slotId 1]` 보존 확인.
- `upsertSlotCentering` → centered=true, pan/img1 갱신, `presetKey='1:1'` 파생 확인.

구 `data/observations.sqlite` **무접촉**(롤백 지점 보존). 스모크는 scratchpad 임시 DB 사용, 삭제됨.

---

## 7. 재사용/준수

- `normalizePtzCamRoi`+`normalizeGlobalIdx`(`src/capture/placeRoi.ts`) **재사용**(직접 재구현 안 함). slot_id = normalizeGlobalIdx 결과 정본.
- preset_slotidx = 프리셋 내 배열순 1-based(normalizeGlobalIdx 와 동일 cam→preset 정렬).
- ESM `.js` 확장자 import 준수. node_modules 는 ParkAgent 루트 호이스팅.

## 8. 알려진 미완/차단(리더·다른 개발자 확인)
- **P1 리더 경험적 검증 대기**: 실 `data/setting.sqlite` 생성은 미실행(스모크만 scratchpad). 리더가 `capture.dbFile` 전환 시점에 실행 필요. 실행 명령: `npx tsx src/tools/migrateToSettingDb.ts data/setting.sqlite`.
- **centering 이관 실검증 불가**: 현재 slot_ptz.json items 공백 → 실 UPDATE 경로 미검증(코드/타입은 통과, :memory: 로 로직 검증). 실 캘리브레이션 산출 후 재검 필요.
- `config/tools.config.json` `capture.dbFile` 전환은 **내 범위 밖**(index/config — 다른 개발자/리더).
