# 07 검증 리포트 — "3D육면체 ROI생성" (slot3d_front_center 산출·저장·표시)

검증자(qa-tester). 근거: `05_architect_plan_cuboid.md` §검증(qa) 1~4 + `06_developer_changes_cuboid.md`.
실행 환경: `SettingAgent/`, vitest 2.1.9, node/better-sqlite3. **모든 DB 는 `:memory:`, 모든 임시 파일은 `os.tmpdir()` 아래**
(실 `data/setting.sqlite` · `data/Place01/*` 미접촉 — 픽스처는 동결본 `test/fixtures/PtzCamRoi.unity.json`,
`test/fixtures/camerapos.sample.json` 만 읽음).

## 1. 작성한 테스트 파일

| 파일 | 케이스 | 결과 |
|---|---|---|
| `test/slotFrontCenter.test.ts` (신규) | 19 | 19 통과 |
| `test/slotCuboidRoutes.test.ts` (신규) | 21 | 21 통과 |

기존 테스트는 **한 줄도 수정하지 않았다**(승격 파리티의 1차 근거이므로 무수정 통과가 의미를 가진다).

### 1-1. `test/slotFrontCenter.test.ts` — 19 케이스

**A. `SqliteStore.upsertSlotFrontCenter` 부분 UPDATE 계약 (설계 §B / qa 1) — 5건**
- 검출·센터링 컬럼이 **전부 채워진** 슬롯 2건을 시드한 뒤 slot 1 만 갱신 →
  `slot_setup` **원시 행 전 컬럼**(`SELECT *`)을 갱신 전후로 비교. `slot3d_front_center`·`updated_at` 외
  `slot_roi/vpd_bbox/lpd_obb/occupy_range/pan/tilt/zoom/centered/img1/cam_id/preset_id/preset_slotidx`
  **전부 문자 단위 동일**, slot 2 는 `updated_at` 포함 완전 불변.
- 미존재 slot_id(999·1000) 혼합 → throw 없음, 반환 = 1(실제 갱신 행수), 행 수 불변.
- 빈 배열 → 0 반환, 행 수 불변(전량 DELETE 없음).
- `null` 명시 갱신 + `getSlotSetup()` 왕복 파싱({x,y} ↔ null).
- 소스 계약: `upsertSlotFrontCenter` 본문에 `DELETE FROM` / `REPLACE INTO` 가 **없음**을 정적 검사
  (memory: finalize-slotsetup-wipe-fragility 재발 방지).

**B. 승격 파리티 (설계 §A / qa 3) — 8건**
- `src/capture/Finalizer.ts` 가 `../ground/slotFrontCenter.js` 를 import 만 하고
  `function slotFrontCenter(` · `const H_CONST =` 를 **자체 정의하지 않음**(이중구현 금지) 정적 검사.
- `H_CONST === 1.5` (뷰어 슬라이더 기본값과 동일).
- tilt 8/15/22°, h 0.0/1.5/2.4 4조합에서 승격 함수 결과 ==
  `backprojectToGround → projectCuboidPixels → frontFaceCenterPx → /imgW,/imgH` 직접 조합(1e-12) + 0~1 정규화 규약.
- 4점 아님 / 빈 배열 / 지평선 위 quad → `null` 강등(throw 없음).

**C. `buildGroundInputs` PTZ 소스 우선순위 (리더 변경분 / qa 4) — 7건**
- 중첩 `ptz{pan,tilt,zoom}` 형태 → camerapos 뷰(100/200/300)보다 **우선**.
- 평면 `pan/tilt/zoom` 형태 → 동일하게 우선.
- ROI 에 PTZ 없음 → camerapos 폴백.
- **필드 단위 폴백**: `ptz:{zoom:3}` 만 있으면 zoom=3(ROI), pan/tilt 는 camerapos.
- 둘 다 없음 → `pan/tilt/zoom = null`(undefined 아님).
- 비수치(`'x'`/`null`/`NaN`) PTZ 는 무시하고 camerapos 폴백.
- 동결 픽스처(프리셋 PTZ 미보유) → camerapos 값 그대로(회귀 보호).

### 1-2. `test/slotCuboidRoutes.test.ts` — 21 케이스

하네스는 `test/groundModelRoutes.test.ts` 복제(`fastify.inject`). 시드: 동결 ROI 픽스처의 cam1 프리셋 1·2·3
주차면을 `slot_setup` 으로 적재 + **ROI 파일에 없는 프리셋 9** 슬롯 1건(기존 `slot3d_front_center` 보유).

**200 정상 — 3건**
- 응답 키 집합이 정확히 `{ok,updated,skipped,models,issues,heightM}`; `heightM` 미지정 → `H_CONST(1.5)`;
  `updated + skipped.length == 전체 슬롯 수`; `updated > 0`; `models[]` 원소는 `{key:"cam:preset", conf:number, issues:[]}`;
  `skipped[]` 원소는 `{slotId:number, reason:string}`. DB 저장값은 0~1 유한값이며 **소수점 5자리 이하**(round5 규약).
- `heightM` 0.5 / 3.0 요청 → 응답 에코 + 저장값 y 가 실제로 달라짐(높이가 반영됨).
- 라우트 실행 전후 `getSlotSetup()` 비교 → `slot3dFrontCenter`·`updatedAt` 외 **전 필드 동일**, 행 수 불변.

**skipped + 기존 값 미파괴 — 1건**
- 프리셋 9 슬롯이 `skipped[]` 에 `reason='지면모델 없음(1:9)'` 로 기록되고,
  그 슬롯의 기존 `slot3d_front_center` 는 **그대로**(null 로 지워지지 않음), `updated_at` 도 무접촉.

**오류 코드 — 9건**
- `heightM` = 0.4 / 3.5 / -1 / `'abc'` → **400**(4건, `it.each`) + 400 시 DB 무변경 확인.
- 경계값 0.5 · 3.0 → 200(허용).
- `placeRoiFile` 미설정 → **404**; `ground.enabled=false` → **404**; ROI 파일 ENOENT → **404**(`error` 에 'PtzCamRoi.json').
- `slot_setup` 0건 → **409**(`error` 에 'ROI 파일 로딩').
- camerapos 파일 없음 → **200 강등**(throw 없음).

**경계면 교차(qa 5) — 8건**
- 버튼 `#cap-build-cuboid` 가 `index.html` 에서 `#cap-load-roi` **뒤**에 존재 + `app.js` 에 click 핸들러 등록.
- 요청 계약 일치: `fetch('/capture/slots/cuboid')` · `method:'POST'` · `body {heightM: cuboidHeight()}`.
- **소비 필드 ↔ 실제 응답 대조**: `app.js` 가 읽는 `data.ok/updated/skipped/models/issues/heightM/error`,
  `s.slotId`·`s.reason`, `m.key`·`m.conf`·`m.issues` 가 실제 200 응답 키 집합과 **정확히 일치**
  (`Object.keys(body).sort()`, `Object.keys(skipped[0]).sort()`, `Object.keys(models[0]).sort()` 로 대조).
  `m.conf` 는 `Number(m.conf).toFixed(3)` 로 소비되므로 number 타입임을 확인. 400 응답의 `error` 는 string.
- 성공 후 배선: `state.groundLoaded = false` 가 `await loadGroundModel()` **앞**에 있음(순서 검증 — 뒤에 있으면 가드가 안 풀린다),
  `$('roi-cuboid').checked = true`, `state.roiHidden=false`, `loadParkingSlots()`, `drawRoiOverlay()`, `renderSlotList()`,
  실패 시 조기 return(오버레이 상태 무접촉).
- `loadRoiToDb()` 에도 동일한 1회 가드 해제(`groundLoaded=false` + `loadGroundModel()`) 추가됨.
- `drawCuboidOverlay` 렌더 경로 존재 + 버튼 핸들러가 렌더를 직접 호출하지 않음(데이터·토글만 담당).
- **표시==저장 종단 파리티(추가 작성)**: 라우트로 h=1.5 저장 후, 뷰어와 같은 소스
  (`GET /capture/ground-model` 모델 + `web/core.js projectCuboid → frontFaceCenter`)로 재계산한 좌표가
  DB 저장값과 **1e-5 이내 일치**(픽스처 전 슬롯, checked>0 가드).

## 2. 실행 결과 (있는 그대로)

```
$ npx tsc --noEmit
(0 에러)

$ npx vitest run          # 전체
 Test Files  1 failed | 201 passed (202)
      Tests  1 failed | 2391 passed (2392)
   Duration  12.41s
```

- 유일한 실패: `test/slot3dFrontCenter.test.ts > [후속] 실데이터 스모크 — PtzCamRoi.json 프리셋2 근접면 검증 >
  프리셋2 각 슬롯 앞면중심 x 가 자기 x범위 내 근접면(우측 이웃 넘어가지 않음)`
  → `AssertionError: expected 0.3669202596001984 to be greater than 0.46692025960019845` (`test:504`).
  **사전 고지된 선행 실패**(재생성된 ROI 데이터로 전제 만료)로, 본 변경과 무관하며 **고치지 않았다**.
- 그 1건 외 **신규 실패 0건**. 신규 테스트 40건(19+21) 전부 통과.
- 승격 파리티 1차 근거: `test/finalizerParkingSlots.test.ts`, `test/captureRoutes.test.ts`, `test/slot3dFrontCenter.test.ts`
  (위 1건 제외) 등 기존 테스트 **무수정 전량 통과**.

## 3. 발견 결함

**기능 결함: 없음.** 설계 §A~§D 계약 위반, 경계면 필드명·타입 불일치, 데이터 파괴 경로는 발견되지 않았다.
구현 코드는 수정하지 않았다(오타 수정도 없음).

### 지적 사항(결함 아님 — 설계 범위 안이나 기록이 필요한 특성)

1. **"화면에 표시"는 DB 값을 그리는 것이 아니다.**
   `drawCuboidOverlay`(`web/app.js:613`)는 `state.placeRoi` 폴리곤 + 클라이언트 `projectCuboid` +
   **라이브 슬라이더 높이**로 앞면 중심을 매번 **재계산**한다. `slot3d_front_center` 를 읽는 코드는 없다
   (`grep slot3dFrontCenter web/app.js` → 주석 1건뿐). 설계가 그렇게 못박았으므로 계약 위반은 아니지만,
   그 결과 **저장값은 화면으로 검증되지 않는다**. 본 리포트는 이를 수치 파리티 테스트(1e-5)로 대신 보증했다.
   다음 두 경우 표시와 저장은 조용히 어긋난다:
   (a) 버튼을 누른 뒤 `#cuboid-h` 슬라이더를 움직이면 화면만 바뀐다(저장값은 누른 시점 높이).
   (b) 오버레이는 **ROI 파일**(`state.placeRoi`) 기준, 저장은 **DB `slot_setup.slot_roi`** 기준이라
       둘이 갈라지면(수동 DB 편집 등) 다른 도형을 보게 된다.
2. **`updated` 는 DB 실제 변경 행수**이므로, 산출은 됐는데 그 사이 행이 사라진 경우
   `updated + skipped.length < 전체 슬롯` 이 될 수 있다(정상 경로에선 발생 안 함, 메시지 표기만 미세하게 어긋남).
3. `heightM` 스키마(0.5~3.0)와 슬라이더 `#cuboid-h`(min 0.5 / max 3.0 / step 0.05) 범위가 **정확히 일치**해
   UI 조작만으로는 400 이 날 수 없다 — 정합 확인됨(문제 없음).
4. 라우트는 `/capture/ground-model` 과 동일 조합(`buildGroundInputs`+`estimateGroundModels`)을 쓰지만
   `fovBaseV` 는 응답에 싣지 않는다. `app.js` 가 쓰지 않으므로 무해.

## 4. 미검증 한계 (누락으로 명시 — 통과로 위장하지 않음)

- **실 DB(`data/setting.sqlite`) 실측 미수행.** 지시대로 실 DB 를 열지 않았으므로 "실 23슬롯 중 몇 건 산출" 수치는
  본 리포트에 없다(설계서상 리더 동작확인 항목).
- **육안/시각 검증(sharp 렌더) 미수행.** 브라우저 실행·오버레이 스크린샷은 qa 범위 밖으로 두었다.
  버튼 클릭 → 화면 변화의 실제 관찰은 이루어지지 않았고, DOM 배선은 **소스 정적 검사**로만 확인했다
  (`web/app.js`/`index.html` 문자열 대조 — jsdom 실행 테스트 아님).
- **라이브 시뮬레이터/실카메라 스모크 미수행**(외부 서비스 미가동). 지면모델은 동결 픽스처 기준이다.
- `test/slot3dFrontCenter.test.ts` 의 선행 실패 1건은 **미해결 상태 그대로** 남아 있다(본 변경 무관).
