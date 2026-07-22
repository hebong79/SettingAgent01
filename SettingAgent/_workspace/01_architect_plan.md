# 01 설계 — "ROI 파일 로딩" 버튼 (PtzCamRoi.json → DB slot_setup 재구성)

리더(현자 라) 직접 작성. Phase 0 조사 사실에 근거한 확정 설계.

## 목표(성공 기준)

정밀수집 페이지 상단 액션 바에 **"ROI 파일 로딩"** 버튼을 추가한다. 클릭하면
`data/Place01/PtzCamRoi.json`(= `store.dataDir + store.placeRoiFile`)을 읽어
**DB `slot_setup` 테이블을 전량 초기화하고 파일 내용으로 재구성**한다.
채워지는 값: `slot_id`(전역 idx) · `cam_id` · `preset_id` · `preset_slotidx` · `slot_roi`(정규화 4점),
검출/센터링 컬럼(`vpd_bbox`/`lpd_obb`/`occupy_range`/`pan`/`tilt`/`zoom`/`centered`/`img1`/`slot3d_front_center`)은 **초기값(NULL/0)**.

## Phase 0 조사 사실 (재조사 금지 — 이걸 근거로 구현)

1. **동일 로직이 이미 존재한다**: `src/tools/migrateToSettingDb.ts` 의
   `buildCameras()` / `buildPresets()` / `buildSlots()` 가 정확히 이 매핑을 수행한다.
   `buildSlots` = `normalizePtzCamRoi` → `normalizeGlobalIdx` → `slot_id=sp.idx`,
   `preset_slotidx=배열순 1-based`, `slot_roi=stringify5(정규화 4점)`.
   → **이중구현 절대 금지.** 공용 모듈로 승격해 CLI와 신규 라우트가 **같은 함수**를 쓴다.
2. **FK 제약이 실재한다**: `SqliteStore` 는 연결마다 `pragma foreign_keys = ON`.
   `slot_setup` 은 `FOREIGN KEY (cam_id, preset_id) REFERENCES preset_pos(cam_id, preset_id)`,
   `preset_pos.cam_id → camera_info(cam_id)`, `camera_info.place_id → place_info(place_id)`.
   → 부모(place → camera → preset)가 없으면 INSERT 가 **FK 오류로 전량 실패**한다.
   `preset_pos` 의 PTZ 출처는 `camerapos.json`(`tools.map.cameraposFile`).
3. **현재 DB 상태**(`data/setting.sqlite`): place 1 / camera 1 / preset_pos 3 / slot_setup 17행.
   ROI 파일은 cam1 · preset 1·2·3 · 전역 idx 1..17 (issues 0건, `normalizeGlobalIdx` 멱등).
4. **선례 라우트/버튼**: `POST /capture/slots/reset` ↔ 버튼 `#cap-reset-db`(app.js `resetSlotSetupDb`).
   같은 툴바 `div.cap-actions.toolbar`(index.html) 안에 시작/정지/최종화/검출·센터링 초기화가 있다.
5. **`replaceSlotSetup` 취약성**(memory: finalize-slotsetup-wipe-fragility):
   `DELETE FROM slot_setup` 후 INSERT 전량. 단일 트랜잭션이라 **예외 시 롤백**은 되지만,
   **행이 0건인 정상 입력**(파일이 비었거나 파싱만 성공)에는 롤백이 걸리지 않아 **테이블이 통째로 비워진다**.

## 구현 계획

### A. 공용 모듈 신설 — `src/capture/roiDbLoad.ts`

`migrateToSettingDb.ts` 의 `buildCameras` / `buildPresets` / `buildSlots` 를 **이동**(복사 아님)해 export.
추가로 조립 함수 하나:

```ts
export interface RoiDbLoadResult {
  ok: boolean;
  slots: number;        // 실제 INSERT 된 slot_setup 행수
  cameras: number;
  presets: number;
  skipped: Array<{ camId: number; presetId: number; count: number; reason: string }>;
  issues: string[];     // normalizePtzCamRoi report 의 issues 평탄화 + 경고
  error?: string;       // 실패 시 사유(이때 DB 는 무변경)
}

/** PtzCamRoi(+camerapos) → place/camera/preset upsert → slot_setup 전량 교체. 순수 조립은 build*, I/O 는 여기서. */
export function loadRoiIntoDb(store, opts: { placeRoiFile: string; cameraposFile?: string; now: string }): RoiDbLoadResult
```

**안전 규약(필수)** — memory 취약성 대응:
- 파일 없음 / JSON 파싱 실패 / `normalizePtzCamRoi` 결과 `byPreset` 비어있음 / `slots.length === 0`
  → **`replaceSlotSetup` 을 호출하지 않고** `{ ok:false, error }` 반환. **기존 DB 무변경.**
- `preset_pos` 부모가 없는 `(cam,preset)` 슬롯은 **INSERT 대상에서 제외**하고 `skipped[]` 에 사유와 함께 기록
  (전량 FK 실패 방지). 제외 후에도 남은 행이 0이면 위 규약대로 **wipe 금지 + 실패 반환**.
- 부모 upsert 순서 고정: `place_info` → `camera_info` → `preset_pos` → `replaceSlotSetup`.
  `camerapos.json` 부재 시 preset upsert 는 건너뛰고, 기존 `preset_pos` 행만으로 FK 판정한다(issues 에 명시).

### B. CLI 리팩터 — `src/tools/migrateToSettingDb.ts`

`build*` 3함수를 삭제하고 `roiDbLoad.ts` 에서 import. **동작·콘솔 출력은 기존 그대로 유지**
(`buildCentering` 과 slot_ptz 이관은 CLI 전용이므로 CLI 에 남긴다). 기존 테스트(`test/migrateToSettingDb.test.ts`)가 그대로 통과해야 한다.

### C. 라우트 — `src/api/captureRoutes.ts`

```
POST /capture/slots/load-roi   →  RoiDbLoadResult
```
- `deps.placeRoiFile` 미설정 → 404 `{ ok:false, error:'placeRoiFile 미설정' }`.
- `loadRoiIntoDb` 결과 `ok:false` → **409** + `error` 그대로(DB 무변경임을 메시지에 명시).
- 성공 → 200. `deps.job` 등 인메모리 캐시는 건드리지 않는다(슬롯 소스는 DB 조회 `/capture/slots`).
- `cameraposFile` 은 `CaptureRoutesDeps` 에 **선택 필드로 추가**하고 `src/index.ts` 에서 `tools.map.cameraposFile` 주입.
  (`server.ts` 도 통과 배선 필요 — `placeRoiFile` 과 동일 패턴.)

### D. 웹 UI — `web/index.html` + `web/app.js`

- `index.html`: `div.cap-actions.toolbar` **맨 앞**에 버튼 추가
  ```html
  <button id="cap-load-roi" title="PtzCamRoi.json(바닥 ROI 정본)을 읽어 DB slot_setup 을 전량 재구성. 기존 검출(VPD/LPD)·점유영역·센터라이징은 모두 사라진다. 되돌릴 수 없음">ROI 파일 로딩</button>
  ```
- `app.js`: `loadRoiToDb()` 핸들러 신설 + `$('cap-load-roi').addEventListener('click', loadRoiToDb)`
  (등록 위치는 기존 `$('cap-reset-db')` 라인 근처).
  - 실행 전 `confirm()` 로 파괴성 경고(문구: 검출·점유·센터링 전량 소실).
  - 성공 시 `setCapMsg` 계열 기존 메시지 함수로 `슬롯 N건 / 스킵 M건 / 이슈…` 표시,
    이어서 **기존 슬롯 목록·오버레이 갱신 경로 재사용**(`resetSlotSetupDb` 가 성공 후 호출하는 갱신 함수와 동일한 것을 쓸 것).
  - `skipped`/`issues` 가 비어있지 않으면 **숨기지 말고** 메시지에 그대로 노출.

## 검증(qa)

vitest 신규 `test/roiDbLoad.test.ts` 최소 케이스:
1. 정상: 임시 DB + 실제 `data/Place01/PtzCamRoi.json` → slot_setup 17행, slot_id 1..17,
   preset_slotidx 프리셋별 1-based, slot_roi 4점·0~1 범위, 검출컬럼 전부 NULL·centered=0.
2. **wipe 금지 가드**: 존재하지 않는 파일 / `{"cameras":[]}` / 파싱 실패 →
   `ok:false` 이고 **기존 slot_setup 행수가 그대로**(핵심 회귀 가드).
3. FK 스킵: `preset_pos` 에 없는 preset 의 슬롯이 `skipped[]` 로 빠지고 나머지는 INSERT.
4. CLI 파리티: 기존 `test/migrateToSettingDb.test.ts` 무수정 통과.
5. 라우트: 기존 `test/captureRoutes.test.ts` 패턴으로 200/404/409 shape.

리더 동작확인: 서버(13020) 가동 시 `curl -XPOST /capture/slots/load-roi` → 응답 shape + `GET /capture/slots` 17행 확인.

## 하지 말 것

- `normalizePtzCamRoi`/`normalizeGlobalIdx` 로직 변경 금지(정본).
- `replaceSlotSetup` 시그니처 변경 금지 — 가드는 **호출부(roiDbLoad)** 에 둔다.
- 기존 `POST /capture/slots/reset`(검출·센터링만 비움) 동작 변경 금지 — 별개 버튼이다.
- 요청 범위 밖 리팩터·주변 코드 정리 금지.
