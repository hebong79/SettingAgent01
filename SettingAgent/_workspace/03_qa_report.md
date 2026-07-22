# 03 검증(qa) — "ROI 파일 로딩"(PtzCamRoi.json → DB slot_setup 재구성)

검증자(qa-tester). 설계서 `01_architect_plan.md` "검증(qa)" 1~5번 전부 수행.
실행: `cd SettingAgent && npx vitest run` (전체 스위트).

## 1. 신규/수정 테스트 파일

| 파일 | 구분 | 케이스 수 |
|------|------|----------|
| `test/roiDbLoad.test.ts` | 신규 | 12 |
| `test/captureLoadRoiRoutes.test.ts` | 신규 | 5 |
| `test/viewerPtzSyncCoverage.test.ts` | 수정(1줄, 라우트 분류 등록) | 기존 유지 |

임시 DB 는 전부 `new SqliteStore(':memory:')`, 임시 입력 파일은 `os.tmpdir()` 아래 `mkdtempSync`.
**실제 `data/setting.sqlite` 는 열지 않았다**(수정시각 Jul 18 그대로). 읽기 전용 참조는 `data/Place01/PtzCamRoi.json`·`config/camerapos.json` 뿐이다.

### 1-1. `test/roiDbLoad.test.ts` (설계 qa 1~3)

정상 로딩(실제 `data/Place01/PtzCamRoi.json`, 전 프리셋 커버 camerapos 픽스처 사용):
1. 파일의 전 주차면이 slot_setup 으로 재구성 — `slot_id` 1..N **고유·연속**, `res.slots` = `buildSlots()` 산출 행수와 일치.
2. `preset_slotidx` 프리셋별 1-based 연속, `slot_roi` 4점 정규화(아래 §3-1 주의).
3. 합성 픽스처(전 점 프레임 내) → `slot_roi` 4점이 정확히 `0.1/0.3` 등 0~1 값(정규화 스케일 정합).
4. 검출/센터링 컬럼 초기값 — `vpd/lpd/occupyRange/pan/tilt/zoom/img1 = null`, `centered = false(0)`.
5. 기존 검출·센터링이 있는 DB 에 로딩 시 전량 교체(centered 전부 해제, 행수 = `res.slots`).
6. [현황 기록] 실제 `config/camerapos.json` 사용 시 FK 부모 없는 (cam,preset) 은 `skipped[]` 로 빠지고 나머지는 정상 INSERT.

★ wipe 금지 회귀 가드(최우선) — 기존 3행 시드 후:
7. ROI 파일 없음 → `ok:false`, `slots:0`, **3행 그대로**.
8. `{"cameras":[]}` → `ok:false`, **3행 그대로**.
9. JSON 파싱 실패 → `ok:false`, `error` 에 '파싱 실패', **3행 그대로**.
10. 실패 경로에서 기존 슬롯의 `centered/pan/vpd` 값도 무손상.

FK 스킵:
11. 부모 있는 cam1:preset1(2면) + 부모 없는 cam9:preset9(1면) → `ok:true`, `slots:2`,
    `skipped = [{camId:9, presetId:9, count:1, reason:'preset_pos 부모 없음(FK)'}]`, camerapos 미지정 경고가 `issues` 에 노출.
12. 부모 없는 슬롯만 있는 ROI → `ok:false`(error 에 '무변경'), `skipped` 1건, **기존 3행 보존**.

### 1-2. `test/captureLoadRoiRoutes.test.ts` (설계 qa 5)

`captureResetRoutes.test.ts` 의 `buildServer` + `app.inject` 패턴 재사용.
1. **404** — `placeRoiFile` 미설정 → `{ok:false, error:'placeRoiFile 미설정'}`.
2. **200** — `{ok:true, slots:2, cameras:1, presets:1, skipped:[], issues:[]}`, `error` 부재.
   왕복으로 `GET /capture/slots` → 2행, `slotId [1,2]`, `centered:false`, `vpd/pan:null`, `roi` 4점.
3. **409** — 파일 없음 → `ok:false`, `error` 문자열, `slots:0`, `skipped/issues` 배열, 기존 3행 무손실(`centered:true` 유지).
4. **409** — 빈 `cameras` → 기존 2행 무손실.
5. 회귀 — `POST /capture/slots/reset` 은 영향 없음(`{ok:true, cleared:2}`, 행 보존).

### 1-3. `test/viewerPtzSyncCoverage.test.ts` 1줄 수정 (사소 — 명시)

기존 가드 테스트가 "app.js 가 호출하는 모든 라우트는 MOVES_CAMERA/NO_MOVE 로 분류되어야 한다"를 강제한다.
신규 `/capture/slots/load-roi` 가 미분류라 **실패**했다. 이 라우트는 카메라를 움직이지 않으므로
`NO_MOVE` 에 `'/capture/slots/load-roi': 'DB'` 로 등록했다(구현 코드 변경 없음, 테스트 분류 등록만).

## 2. 실행 결과(있는 그대로)

신규 2파일 단독: **17 passed / 0 failed**.

전체 스위트(`npx vitest run`):

```
Test Files  1 failed | 199 passed (200)
     Tests  1 failed | 2343 passed (2344)
```

유일한 실패: `test/slot3dFrontCenter.test.ts > [후속] 실데이터 스모크 — PtzCamRoi.json 프리셋2 근접면 검증`.

**이 실패는 본 기능과 무관한 선행 실패(데이터 기인)임을 실험으로 확인했다:**
- `SettingAgent/src`·`web` 변경을 통째로 stash 해도 동일하게 실패.
- `data/Place01/PtzCamRoi.json`(작업트리에서 시뮬레이터가 재생성돼 수정됨) 만 stash 하면 **22/22 통과**.
→ 원인은 코드가 아니라 **재생성된 ROI 정본 데이터**(cam2 추가·프리셋2 winding 변화). 본 변경의 결함이 아니다.
설계서 qa 4번(기존 회귀 무손상): `test/migrateToSettingDb.test.ts` **7/7 무수정 통과**, `test/captureResetRoutes.test.ts` 3/3 통과.

## 3. 발견 사항

### 3-1. 설계서 성공기준 vs 실데이터 불일치(구현 결함 아님 — 설계서 기준이 낡음)

- 설계서/지시서는 "slot_setup **17행**, slot_id 1..17, cam1 preset 1·2·3" 을 전제한다.
  **현재 작업트리의 `data/Place01/PtzCamRoi.json` 은 cam1(7+4+2=13면) + cam2(6+4=10면) = 총 23면**이다(Phase 0 조사 이후 파일이 재생성됨).
  그래서 테스트는 17을 하드코딩하지 않고 **파일에서 산출한 기대값**과 대조한다.
- "slot_roi 4점 **모두 0~1**" 도 실데이터에서 성립하지 않는다. 실제 파일에 프레임 밖 좌표가 4곳 있다
  (cam1:preset2 idx1, cam1:preset3 idx1(2점), cam2:preset2 idx1/idx4 → 정규화 시 `-0.0348`, `>1` 등).
  `src/capture/placeRoi.ts` 는 이를 **의도적으로 클램프·드롭하지 않고 보존**하며 `issues` 로만 보고한다(주석에 명시된 정본 규약).
  → 테스트는 "4점·유한·(-0.2,1.2) 이내 + 프레임 밖이면 `issues` 에 보고" 로 검증하고, 엄격한 0~1 은 합성 픽스처로 별도 검증했다.

### 3-2. 운영 주의(결함 아님, 설계된 동작): 실제 config/camerapos.json 으로는 cam2 슬롯 10건이 통째로 스킵된다

`config/camerapos.json` 에는 `cam1:preset1/2/3` 만 있다. 현재 ROI 파일에는 cam2 가 있으므로
버튼을 실제로 누르면 **cam2 의 10면은 `skipped[]` 로 빠지고 13면만 INSERT** 된다(FK 전량실패 방지 규약대로).
UI 는 이를 숨기지 않고 `#cap-msg` 에 노출하므로 은폐는 없다. 다만 cam2 를 DB 에 넣으려면
`camerapos.json` 에 cam2 프리셋이 선행 등록되어야 한다는 **운영 선행조건**이다.

### 3-3. 경계면 교차 비교 — 불일치 없음

`web/app.js:2330 loadRoiToDb` ↔ 라우트 반환 `RoiDbLoadResult` 필드 대조:

| app.js 소비 | 라우트/타입 | 판정 |
|---|---|---|
| `data.ok` | `ok: boolean` | 일치 |
| `data.error ?? res.status` | `error?: string`(404/409 시 채움) | 일치(성공 시 undefined 는 미사용 경로) |
| `data.slots`, `data.cameras`, `data.presets` | `number` 3개 | 일치 |
| `data.skipped[].camId/presetId/count/reason` | `Array<{camId,presetId,count,reason}>` | **필드명·타입 전부 일치** |
| `data.issues[]` (`.join(' | ')`) | `string[]` | 일치 |

- 방어적 `?? []` 가 있어 배열 누락에도 안전. `res.ok || data.ok` 이중 체크로 409/404 모두 실패 처리됨.
- 버튼 배선: `web/index.html:190` `#cap-load-roi` 존재, `web/app.js:3715` `$('cap-load-roi').addEventListener('click', loadRoiToDb)` 등록 확인.
  성공 후 갱신 경로 `resetOverlayDisplay → loadParkingSlots → drawRoiOverlay → renderSlotList` 4함수 모두 app.js 에 정의돼 있음.
- 인덱스 규약: `preset_slotidx` 1-based, `slot_id` 전역 1-based 를 테스트로 직접 확인(off-by-one 없음).

### 3-4. 구현 결함

**없음.** 설계서 A~D 요건(공용 모듈 단일 출처, wipe 금지 4가드, FK 스킵, 404/409/200 계약, UI 배선)이
모두 테스트로 재현·확인됐다. 구현 코드는 한 줄도 수정하지 않았다.

## 4. 미검증 한계(위장 없음 — 명시)

- **라이브 스모크 미수행**: 서버(13020) 기동 후 `curl -XPOST /capture/slots/load-roi` → `GET /capture/slots` 실왕복,
  및 브라우저에서 버튼 클릭 → `confirm()` → 오버레이·슬롯목록 갱신은 **수행하지 않았다**(유닛/inject 레벨까지만).
  단, 라우트 왕복은 `app.inject` 로, 실데이터 매핑은 실제 `PtzCamRoi.json` 으로 대체 검증했다.
- `web/app.js` 는 브라우저 전용(모듈 미분리)이라 `loadRoiToDb` 자체의 유닛테스트는 없다 — 정적 대조(§3-3)로 갈음.
- `slot3dFrontCenter` 실패는 데이터 기인으로 특정만 했고 **수정하지 않았다**(본 작업 범위 밖. ROI 정본 재생성 이슈로 별도 처리 필요).
