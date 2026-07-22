# 02 구현 — "ROI 파일 로딩" 버튼 (PtzCamRoi.json → DB slot_setup 재구성)

설계서 `01_architect_plan.md` A~D 구현 완료. `npx tsc --noEmit` 0에러.

## 변경 파일

| 파일 | 구분 | 요약 |
|------|------|------|
| `src/capture/roiDbLoad.ts` | 신설 | `buildCameras`/`buildPresets`/`buildSlots`(CLI 에서 **이동**) + `PLACE_ID`/`PLACE_NAME` + `loadRoiIntoDb` + `RoiDbLoadResult`/`RoiDbLoadOptions` |
| `src/capture/SqliteStore.ts` | 수정(1메서드 추가) | `getPresetKeys(): Set<string>` — `preset_pos` 의 `cam:preset` 키 집합(FK 부모 판정 read-only) |
| `src/tools/migrateToSettingDb.ts` | 수정 | build* 3함수 삭제 → `roiDbLoad.js` import 전환. `buildCentering`·`main`·콘솔 출력 불변 |
| `src/api/captureRoutes.ts` | 수정 | `POST /capture/slots/load-roi` 추가(+ `loadRoiIntoDb` import) |
| `web/index.html` | 수정 | `div.cap-actions.toolbar` 맨 앞 `#cap-load-roi` 버튼(파괴성 title) |
| `web/app.js` | 수정 | `loadRoiToDb()` 핸들러 + `#cap-load-roi` click 등록 |

## 핵심 구현 노트

### 안전 규약(wipe 금지 가드) — `loadRoiIntoDb`
아래 4경우는 **`replaceSlotSetup` 미호출** → 기존 `slot_setup` 무변경, `{ ok:false, error }` 반환.
1. ROI 파일 없음 (`ROI 파일 없음: … — DB 무변경`)
2. JSON 파싱 실패 (`ROI 파일 파싱 실패: … — DB 무변경`)
3. `normalizePtzCamRoi().byPreset` 비었음 / `buildSlots()` 0건
4. FK 부모(`preset_pos`) 없는 슬롯 제외 후 잔여 0건 (`FK 부모(preset_pos) 있는 슬롯 0건 — slot_setup 무변경`)

추가로 store 쓰기 구간 전체를 `try/catch` — 예외 시 better-sqlite3 트랜잭션 롤백 + `ok:false` 반환.

### FK 처리
- upsert 순서 고정: `place_info` → `camera_info` → `preset_pos` → `replaceSlotSetup`.
- `cameraposFile` 미지정/부재/파싱실패 → preset upsert 생략, `issues[]` 에 명시 후 **기존 `preset_pos` 행만으로** FK 판정.
- 부모 없는 `(cam,preset)` 슬롯은 INSERT 대상에서 제외하고 `skipped[{camId,presetId,count,reason}]` 로 보고(전량 FK 실패 방지).

### 정본 재사용
`normalizePtzCamRoi`/`normalizeGlobalIdx`/`stringify5` 그대로 사용(로직 무변경). `slot_roi` 는 `stringify5` 로 소수 5자리 규약 유지. 검출/센터링 컬럼은 전부 NULL, `centered=0`.

### 라우트 계약
- `placeRoiFile` 미설정 → **404** `{ ok:false, error:'placeRoiFile 미설정' }`
- `loadRoiIntoDb` 실패 → **409** + `RoiDbLoadResult`(error 포함)
- 성공 → **200** `{ ok:true, slots, cameras, presets, skipped[], issues[] }`
- `deps.job` 등 인메모리 캐시 미접촉. 슬롯 소스는 `GET /capture/slots`(DB).

### 웹 UI
`confirm()` 파괴성 경고 → 성공 시 `resetSlotSetupDb` 와 **동일한 갱신 경로**(`resetOverlayDisplay` → `loadParkingSlots` → `drawRoiOverlay` → `renderSlotList`) 재사용. `skipped`/`issues` 는 숨기지 않고 `#cap-msg` 에 그대로 노출.

## 설계 이탈 사항

1. **`CaptureRouteDeps` 에 `cameraposFile` 선택 필드를 추가하지 않았다.**
   조사 결과 `CaptureRouteDeps.mapFiles: MapFiles` 가 이미 `cameraposFile` 을 보유하고 있고,
   `server.ts` 는 `mapFiles: deps.mapFiles`, `index.ts` 는 `mapFiles: tools.map` 으로 **이미 배선되어 있다**.
   중복 필드 신설은 이중 출처가 되므로 `deps.mapFiles?.cameraposFile` 을 그대로 사용했다.
   → **`server.ts`/`index.ts` 변경 없음**(설계서 C의 "통과 배선" 은 기존 배선으로 이미 충족).
2. **`SqliteStore.getPresetKeys()` 신규 추가**(설계서 미기재).
   "camerapos 부재 시 기존 `preset_pos` 행만으로 FK 판정" 요건을 만족하려면 `preset_pos` 를 읽어야 하는데
   기존 read 메서드가 없고 `db` 필드가 private 이라 read-only 게터를 추가했다.
   `replaceSlotSetup` 등 기존 시그니처는 무변경.
3. `PLACE_ID`/`PLACE_NAME` 상수도 `roiDbLoad.ts` 로 이동·export(CLI 는 import). `buildCameras` 가 이 상수를 쓰므로 단일 출처 유지 목적.

## 미구현 항목

- 유닛테스트(`test/roiDbLoad.test.ts`, 라우트 200/404/409 테스트)는 **검증자(qa-tester) 담당** — 본 구현 범위에서 작성하지 않음.
- 기존 회귀만 확인: `test/migrateToSettingDb.test.ts`(7) · `test/captureResetRoutes.test.ts`(3) 전부 통과.
