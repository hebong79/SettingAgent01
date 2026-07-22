# 04 문서화·영향도 분석 — "ROI 파일 로딩" 버튼

문서화 담당(documenter) 작성. 01/02/03 산출물 + 실제 코드 대조 기반.
최종 문서: `SettingAgent/docs/20260722_152421_ROI파일로딩_slot_setup재구성.md`

## 1. `migrateToSettingDb` CLI 와의 공용화 — 동작 불변 근거

`src/tools/migrateToSettingDb.ts`의 `buildCameras`/`buildPresets`/`buildSlots` 3함수는 **삭제 후
`src/capture/roiDbLoad.ts`에서 import**로 전환됐다(로직 자체는 이동일 뿐 한 줄도 수정되지 않음 —
02_developer_changes.md 확인). `buildCentering`·`main`·콘솔 출력은 CLI 전용으로 그대로 남았다.

동작 불변 근거:
- `test/migrateToSettingDb.test.ts` 7/7 **무수정 통과**(03_qa_report.md §2) — CLI가 산출하는
  `place_info`/`camera_info`/`preset_pos`/`slot_setup` 행이 리팩터 전후 동일함을 회귀로 증명.
- `PLACE_ID`/`PLACE_NAME` 상수도 `roiDbLoad.ts`로 이동·export해 CLI가 import — 값 자체는 `1`/`'Place01'`로
  불변, 이중 출처만 제거.
- **결론**: CLI 산출물에는 영향 없음. 신규 라우트(`POST /capture/slots/load-roi`)가 CLI와 완전히 동일한
  `build*` 함수를 호출하므로, "웹 버튼으로 트리거되는 재구성"과 "CLI 마이그레이션"은 이제 단일 소스에서
  파생되는 동일 로직이다(이중구현 제거가 곧 설계 목표였음 — 01_architect_plan.md §Phase0-1).

## 2. `slot_setup` 소비처에 미치는 영향

### 2-1. 데이터 소실 범위 (가장 중요)

버튼이 정상 실행되면(=파일 존재·파싱 성공·유효 슬롯 1건 이상) `replaceSlotSetup`이 `DELETE FROM
slot_setup` 후 전량 INSERT한다. 신규 INSERT되는 행은 `slot_roi`(바닥 ROI 4점)·`slot_id`·`cam_id`·
`preset_id`·`preset_slotidx`만 채워지고, 다음 컬럼은 **전부 초기값으로 소실**된다:
`vpd_bbox`/`lpd_obb`/`occupy_range`/`pan`/`tilt`/`zoom`/`centered`(0)/`img1`/`slot3d_front_center`
(모두 NULL, 단 `centered`는 0).

이는 `POST /capture/slots/reset`(`#cap-reset-db`, "검출·센터링 초기화")이 위 컬럼만 비우고 `slot_roi`·행
자체는 보존하는 것과 **범위가 다르다** — reset은 "슬롯 틀은 유지, 내용만 비움", load-roi는 "슬롯 틀 자체를
파일 기준으로 재구성"이다. 두 버튼은 별개 목적이며 이번 변경으로 `reset` 라우트/동작은 건드리지 않았다
(03_qa_report.md: `captureResetRoutes.test.ts` 3/3 회귀 통과로 확인).

**소비처별 영향:**

| 소비처 | 파일 | 영향 |
|---|---|---|
| `GET /capture/slots` | `src/api/captureRoutes.ts:326` | 버튼 실행 직후 조회하면 새 ROI 기준 행만 반환. 검출·센터링 값은 전부 null/false로 보임(뷰어·주차면 목록이 즉시 "미검출" 상태로 표시됨) |
| `Finalizer.replaceSlotSetup` (`src/capture/Finalizer.ts:227,276`) | 최종화 단계에서도 같은 메서드를 호출해 확정본을 교체함 | load-roi 직후 최종화(finalize)를 실행하면, load-roi가 만든 "빈 껍데기" slot_setup을 Finalizer가 다시 검출 결과로 채워 넣는 정상 흐름이 된다(운영 순서: **load-roi → 재수집(start) → finalize** 권장) |
| `writeSetupResultFiles` (`src/store/setupResult.ts`, `captureRoutes.ts:445`) | "결과 파일 생성" 버튼이 `getSlotSetup()`을 그대로 파일화 | load-roi 직후 바로 누르면 검출값이 빈 result 파일이 생성된다 — 순서상 재수집·센터라이징 이후에 눌러야 의미 있는 산출물이 됨 |
| 뷰어 오버레이(`web/app.js`: `drawRoiOverlay`/`renderSlotList`) | `loadRoiToDb()`가 성공 후 직접 호출 | ROI 폴리곤은 새로 그려지고, VPD/LPD/점유영역 오버레이는 데이터가 없으므로 자동으로 사라짐(별도 삭제 로직 불필요 — 소스 데이터 자체가 null이기 때문) |
| `upsertSlotLpd` (`PlateDiscoveryJob.ts`, `captureRoutes.ts:369,417`) | slot_id 키 UPDATE(부분 갱신, DELETE 없음) | load-roi가 slot_id 체계를 재배정(전역 idx 재계산)하므로, load-roi **이후에** 실행되는 LPD 검출·저장은 새 slot_id 기준으로 정상 동작. load-roi **이전** 시점에 진행 중이던 LPD 잡이 있다면 slot_id 불일치로 갱신 대상이 어긋날 수 있음(동시 실행 비권장) |
| `clearSlotSetupEnrichment` (`#cap-reset-db`) | `slot_roi`는 보존, 검출 컬럼만 재초기화 | load-roi 이후 reset을 눌러도 추가로 잃을 데이터 없음(이미 초기값) — 상호 영향 없음 |
| `PtzCalibrator`/`SetupPipeline`/`PlateDiscoveryJob`의 `getSlotSetup()` 조회 | 커버리지 요약, 타겟 확장 등 | load-roi 직후 즉시 실행하면 `pan/tilt/zoom=null`, `centered=false`인 슬롯 전체가 "미센터링" 대상으로 잡힘 — 정상 흐름(재수집 필요)이지 버그 아님 |

### 2-2. finalize와의 관계·실행 순서 권고

- `Finalizer.replaceSlotSetup` 호출부(`Finalizer.ts:276`)는 **검출 파이프라인 완료 후** 확정본을 쓰는
  용도이고, load-roi는 **바닥 ROI 정본 자체가 바뀌었을 때** 슬롯 틀을 재설정하는 용도다. 목적이 다르므로
  같은 메서드(`replaceSlotSetup`)를 공유하지만 호출 시점은 겹치지 않는 것이 정상 운영이다.
- 권고 순서: **① ROI 파일 로딩(슬롯 틀 재구성) → ② 정밀수집 시작(검출) → ③ 최종화(finalize, 확정본
  기록) → ④ 센터라이징 → ⑤ 결과 파일 생성.** load-roi를 ②~⑤ 사이에 끼워 넣으면 직전까지의 검출·
  센터링 결과가 전부 소실되므로, UI `confirm()` 경고와 버튼 `title`이 이를 명시하고 있다(코드 확인,
  §4 인용).

## 3. FK 의존 구조와 운영 선행조건

FK 체인: `place_info(place_id)` ← `camera_info(place_id)` ← `preset_pos(cam_id)` ← `slot_setup(cam_id,
preset_id)`. `SqliteStore`는 연결마다 `pragma foreign_keys = ON`이라 부모가 없는 자식 INSERT는 실패한다.

`loadRoiIntoDb`는 이를 다음과 같이 처리한다:
1. `place_info`/`camera_info`는 ROI 파일에서 파생해 항상 upsert(부모 문제 없음).
2. `preset_pos`는 **`camerapos.json`이 정본** — 지정·존재하면 upsert, 없으면 upsert를 생략하고
   기존 `preset_pos` 행만으로 FK 판정(`getPresetKeys()` 신규 read-only 메서드로 조회).
3. `preset_pos`에 없는 `(cam,preset)` 슬롯은 INSERT 대상에서 **제외**되고 `skipped[]`로 보고된다(전량
   FK 실패를 막기 위한 부분 성공 전략).

**실측된 운영 선행조건 (검증자 03_qa_report.md §3-2 인용):**
현재 `config/camerapos.json`에는 `cam1:preset1/2/3`만 등록되어 있다. 반면 작업트리의
`data/Place01/PtzCamRoi.json`은 시뮬레이터 재생성으로 `cam1`(13면) + `cam2`(10면) = 총 23면을 포함한다.
따라서 **실제로 버튼을 누르면 cam2의 주차면 10건이 `preset_pos` 부모 없음으로 `skipped[]`에 빠지고,
cam1의 13면만 INSERT된다.** UI는 이를 숨기지 않고 `#cap-msg`에 `skipped`/`issues`를 그대로 노출하므로
은폐는 없으나, cam2 데이터를 실제로 DB에 반영하려면 **선행 작업**이 필요하다:

- 해결책 A: `config/camerapos.json`에 `cam2`의 프리셋(pan/tilt/zoom)을 추가 등록한 뒤 버튼 실행.
- 해결책 B: 시뮬레이터에서 `camerapos.json`을 cam2 포함으로 재export한 뒤 버튼 실행.

이 선행조건은 **버그가 아니라 FK 스킵 규약이 설계대로 동작한 결과**이며, load-roi 버튼 자체의 결함이
아니다(01_architect_plan.md "FK 스킵" 규약과 일치, 03_qa_report.md에서 재현·확인됨).

## 4. 알려진 선행 실패 — `test/slot3dFrontCenter.test.ts` (본 변경과 무관)

전체 스위트 실행 결과 유일한 실패는 `test/slot3dFrontCenter.test.ts`의 "[후속] 실데이터 스모크 —
PtzCamRoi.json 프리셋2 근접면 검증" 1건이다. 검증자가 실험으로 원인을 격리했다(03_qa_report.md §2):

- `SettingAgent/src`·`web` 변경분을 통째로 stash해도 **동일하게 실패**.
- `data/Place01/PtzCamRoi.json`(작업트리에서 이미 재생성돼 수정된 상태)만 stash하면 **22/22 통과**.

→ 원인은 코드가 아니라 **작업트리에 이미 반영되어 있던 재생성 ROI 정본 데이터**(cam2 추가, 프리셋2
winding 변화)이며, 본 기능(ROI 파일 로딩 버튼) 구현의 결함이 아니다. 수정은 이번 작업 범위 밖으로
남겨두었다 — ROI 정본 재생성에 따른 별도 이슈로 처리 필요.

## 5. 확인 필요 (미검증 영역)

- **라이브 스모크 미수행**: 서버(13020) 기동 후 실제 `curl -XPOST /capture/slots/load-roi` →
  `GET /capture/slots` 왕복, 브라우저 실기동 후 버튼 클릭 → `confirm()` → 오버레이/슬롯 목록 실제
  갱신은 수행되지 않았다. 라우트 계약(200/404/409 shape)은 `app.inject` 레벨까지, 실데이터 매핑은
  실제 `PtzCamRoi.json` 파일 기반 유닛테스트로 검증됐다.
- `web/app.js`의 `loadRoiToDb()`는 브라우저 전용 모듈이라 자체 유닛테스트가 없다 — 응답 필드 대조
  (정적 코드 비교, 03_qa_report.md §3-3)로 갈음했으며 실제 DOM 이벤트 동작은 미확인.
- cam2를 실제로 DB에 반영했을 때 뷰어·센터라이징·LPD 탐색이 cam2 프리셋에 대해 끝까지 정상 동작하는지는
  `camerapos.json` 갱신(§3 해결책 A/B) 이후에나 확인 가능하며, 이번 작업 범위에서는 검증되지 않았다.

## 리더 보고용 요약

- 최종 문서: `SettingAgent/docs/20260722_152421_ROI파일로딩_slot_setup재구성.md`
- 영향도 핵심 3줄:
  1. `migrateToSettingDb` CLI와 `build*` 로직을 완전 공유(이동, 이중구현 제거) — CLI 회귀 7/7 통과로 동작 불변 확인.
  2. 버튼 정상 실행 시 기존 VPD/LPD/점유영역/센터라이징이 전량 소실되는 것은 설계된 동작이며, 운영 순서는 "ROI 로딩 → 재수집 → 최종화"를 권고.
  3. 현재 `camerapos.json`이 cam1 프리셋 1~3만 보유해 재생성된 ROI의 cam2 10면이 FK 스킵으로 제외됨(실측) — cam2를 반영하려면 `camerapos.json` 선행 갱신 필요. 선행 실패 `slot3dFrontCenter.test.ts` 1건은 재생성 ROI 데이터 기인으로 본 변경과 무관.
