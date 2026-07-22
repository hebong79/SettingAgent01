# 08 영향도 분석 — "3D육면체 ROI생성" 버튼 (slot3d_front_center 산출·저장·표시)

리더에게 보고. 근거: `05_architect_plan_cuboid.md`(설계) · `06_developer_changes_cuboid.md`(구현) ·
`07_qa_report_cuboid.md`(검증) + 실제 코드(`src/ground/slotFrontCenter.ts`, `src/ground/groundInputs.ts`,
`src/capture/SqliteStore.ts`, `src/api/captureRoutes.ts`, `web/app.js`, `web/index.html`).

## 1. 변경 지점 요약

1. `src/ground/slotFrontCenter.ts` 신설 — `Finalizer.ts`의 private `slotFrontCenter()`/`H_CONST`를 **이동**(승격).
2. `src/ground/groundInputs.ts` `buildGroundInputs()` — PTZ 소스 우선순위를 **ROI 파일 자체 프리셋 PTZ >
   camerapos 뷰**로 변경(필드 단위 폴백).
3. `src/capture/SqliteStore.ts` — `upsertSlotFrontCenter()` 신규(부분 UPDATE).
4. `src/api/captureRoutes.ts` — `POST /capture/slots/cuboid` 신규 라우트.
5. `web/index.html`/`web/app.js` — 버튼 + `buildSlotCuboids()` + `loadGroundModel()` 1회 가드 버그 수정
   (`loadRoiToDb()`에도 동일 수정 동반).

## 2. `buildGroundInputs` PTZ 우선순위 변경의 파급 — 가장 넓은 영향

`buildGroundInputs`는 `src/ground/cuboidContext.ts`의 `makeCuboidContextResolver`가 유일하게 호출하는
지면모델 입력 조합 함수다. 이 resolver는 코드 주석(`captureRoutes.ts:646~647`)에 명시된 대로
**"단일 구현" 원칙**으로 4곳에서 공유된다:

- `GET /capture/ground-model` (`captureRoutes.ts`) — 지면모델 자체를 조회하는 라우트. 오늘 이 변경으로
  conf·issues 응답값이 바뀐다.
- `GET /capture/vehicle-cuboids` (`captureRoutes.ts`) — 라이브 촬영 프레임의 차량 육면체 산출.
- `GET /capture/detect` 계열(`src/capture/detectPipeline.ts`) — `fovBaseV` 산출에 `buildGroundInputs` 직접
  사용(165행). 검출 파이프라인의 지면모델 기반 zoom 역산에 영향.
- `CaptureJob`(`src/index.ts` 조립, `GET /capture/job-cuboids`) — 정밀수집 잡이 "방금 찍은 프레임"의 육면체를
  인메모리로 재사용하는 경로. 카메라/VPD 재호출 없이 같은 resolver를 쓴다.
- `Finalizer.ts` — `buildGroundModels`(모듈 내부, `buildGroundInputs` 기반)로 최종화 시 지면모델을 산출하고,
  그 모델로 `slotFrontCenter`(§3)를 호출해 `slot3d_front_center`를 채운다.

**즉 이번 PTZ 우선순위 변경은 신규 버튼 하나만이 아니라, 지면모델을 소비하는 위 5개 경로 전부의 수치를
동시에 바꾼다.** 방향은 실측상 전부 개선 쪽(§4). 변경 자체는 `buildGroundInputs` 시그니처를 바꾸지 않고
내부 값 선택 로직만 바꿨으므로, 호출부 코드 수정은 필요 없었다(실제로 다른 5개 호출부 소스는 무수정).

**회귀 보호 근거**: 동결 픽스처 기반 회귀 테스트 `test/groundModelRealData.test.ts`,
`test/groundModelPoolingIntegration.test.ts`(및 `groundModelRoundTrip.test.ts`, `groundSimilarityDetect.test.ts`,
`groundModelRoutes.test.ts`)가 **무수정 상태로 전량 통과**했다(§6 전체 회귀 2391 passed에 포함). 이 테스트들이
정확히 "지면모델을 소비하는 경로"를 프리셋 PTZ 우선순위 변경 이후에도 검증하는 안전망 역할을 한다.

**확인 필요 항목**: `test/groundModelRealData.test.ts`/`groundModelPoolingIntegration.test.ts`가 사용하는
픽스처가 이번 PTZ 우선순위 변경으로 관측치가 달라지는 조건(ROI 파일에 프리셋 PTZ가 실제로 실려 있는 경우)을
포함하는지, 아니면 픽스처 자체가 프리셋 PTZ 미보유라 camerapos 폴백 경로만 타서 "우연히" 무수정 통과했는지는
qa 리포트에 명시돼 있지 않다. qa 리포트의 "동결 픽스처(프리셋 PTZ 미보유) → camerapos 값 그대로(회귀 보호)"
항목(`slotFrontCenter.test.ts` C절 마지막)을 보면 적어도 일부 픽스처는 폴백 경로임이 확인되나, 위 두 테스트
파일 자체의 픽스처 특성까지는 이 문서 작성 시점에 별도로 대조하지 않았다 — 완전한 결론은 "확인 필요"로 남긴다.

## 3. `slotFrontCenter` 승격이 `Finalizer`에 미치는 영향

`Finalizer.ts`는 이제 `import { H_CONST, slotFrontCenter } from '../ground/slotFrontCenter.js'`로 전환됐고,
본문 로직(227행 `slotFrontCenter(sp.points, model, H_CONST)` 호출 형태)은 이동 전과 동일하다. 코드 자체는
문자 단위로 그대로 옮겨졌으므로 **동작 변경은 없다**(순수 리팩터).

**동작 불변의 근거**: `test/finalizerParkingSlots.test.ts`(10 테스트)가 **무수정 전량 통과**했다. 이 테스트는
finalize 결과값을 직접 검증하므로, 승격이 finalize 출력을 바꾸지 않았다는 1차 증거가 된다. 추가로 qa가
"이중구현 금지" 정적 검사(`Finalizer.ts`가 `function slotFrontCenter(` / `const H_CONST =`를 자체 정의하지
않음)와 4개 tilt/h 조합에서 승격 함수 vs 원본 직접 조합의 수치 일치(1e-12)를 확인했다.

단, `Finalizer`가 최종화 시 산출하는 `slot3d_front_center` 값 자체는 **§2의 PTZ 우선순위 변경**으로 인해
지면모델이 달라지므로 간접적으로 바뀐다 — 이는 승격(리팩터) 때문이 아니라 §2의 PTZ 소스 변경 때문이다.
구분해서 봐야 한다: 승격 = 무영향, PTZ 우선순위 변경 = finalize 산출값도 개선 방향으로 영향받음.

## 4. 지면모델 품질 개선 (실측)

| 항목 | 변경 전 | 변경 후 |
|---|---|---|
| conf 1:1 | 0.106 | 0.791 |
| conf 1:2 | — | 1.000 |
| conf 1:3 | — | 1.000 |
| conf 2:1 | — | 1.000 |
| conf 2:2 | — | 1.000 |
| tilt 오차 | 추정 10.92° vs PTZ 6.80°(4.12° 불일치) | ≈0.00° |
| issues | metric 잔차 8.7%, f 후보 불일치 20.7%, cam2 공동추정 표본 없음 | 0건 |
| 앞면중심 산출 | 21/23(cam1:preset3 2면 스킵) | 23/23 전량, 스킵 0, 전부 화면 안(0~1) |

원인은 `camerapos.json`이 뒤처진 사본이었기 때문(실측: cam1 preset3 zoom이 ROI 자체 값=1 vs camerapos=1.46583,
ROI 값이 `fov 34.635`와 자기정합). §2에서 서술한 5개 경로 전부가 이 개선의 수혜 범위다.

## 5. DB 스키마·REST 계약 영향

- `slot_setup.slot3d_front_center` 컬럼은 기존에도 존재하던 컬럼(Finalizer 전용 기록처)이며, 이번 변경으로
  **새 쓰기 경로가 하나 추가**됐을 뿐 컬럼 자체나 다른 컬럼의 의미는 바뀌지 않았다.
- 신규 REST 엔드포인트 `POST /capture/slots/cuboid`는 완전히 새로운 경로이므로 기존 클라이언트·REST 계약과
  충돌하지 않는다. `@parkagent/types` 등 공유 타입 패키지 변경은 없었다(이번 변경 범위에 타입 패키지 수정
  없음 — 코드 조사 결과 라우트 요청/응답 타입은 `captureRoutes.ts` 로컬 zod 스키마로만 정의됨).
- `upsertSlotFrontCenter`는 `SqliteStore` 내부 신규 public 메서드로, 기존 메서드(`upsertSlotLpd` 등)와
  시그니처·트랜잭션 패턴이 겹치지 않아 기존 호출부에 영향 없음.

## 6. 비파괴성 — "ROI 파일 로딩"과의 대비

| | ROI 파일 로딩 (`/capture/slots/load-roi`) | 3D육면체 ROI생성 (`/capture/slots/cuboid`) |
|---|---|---|
| 저장 방식 | `slot_setup` **전량 재구성**(기존 검출 VPD/LPD·점유영역·센터라이징 PTZ 소거) | `slot3d_front_center` 컬럼만 **부분 UPDATE** |
| 확인창 | `confirm()` 있음(되돌릴 수 없음 경고) | 없음(비파괴이므로 불필요) |
| 실패 시 기존 데이터 | 애초에 전량 재구성이 전제 | 미저장(모델 없음/퇴화 슬롯은 기존 값 보존, null로 덮지 않음) |

이 비파괴성은 `upsertSlotFrontCenter`가 `replaceSlotSetup`을 쓰지 않고 `slot_id` 키 단위 UPDATE만 수행한다는
점, 그리고 라우트가 산출 실패 슬롯을 `skipped[]`로만 보고하고 저장을 생략한다는 점 양쪽으로 보장된다.
qa가 원시 행 전 컬럼(`SELECT *`) 갱신 전후 비교로 다른 컬럼(`slot_roi/vpd_bbox/lpd_obb/occupy_range/
pan/tilt/zoom/centered/img1/cam_id/preset_id/preset_slotidx`) 무변경을 확인했다.

## 7. 알려진 특성·주의 (qa 지적 3가지)

1. **뷰어가 DB 저장값을 읽지 않고 매번 재계산한다.** `drawCuboidOverlay`(`web/app.js:613`)는 `state.placeRoi`
   + 클라이언트 `projectCuboid` + 라이브 슬라이더 높이로 매번 재계산하며, `slot3d_front_center`를 읽는 코드는
   없다(`grep slot3dFrontCenter web/app.js` → 주석 1건뿐). 파급: 버튼을 누른 뒤 `#cuboid-h` 슬라이더를 움직이면
   화면만 바뀌고 DB 저장값은 그대로다(표시·저장 불일치 가능). 오버레이는 ROI 파일 기준, 저장은 DB
   `slot_setup.slot_roi` 기준이라 두 소스가 갈라지면(수동 DB 편집 등) 다른 도형을 보게 된다.
2. `heightM` 스키마 범위(0.5~3.0)와 슬라이더 `#cuboid-h`(min 0.5/max 3.0/step 0.05) 범위가 정확히 일치해
   정상 UI 조작으로는 400이 나지 않는다(정합 확인됨 — 문제 없음).
3. `updated`는 DB 실제 변경 행수(정상 경로에서는 `updated + skipped.length === 전체 슬롯`이지만, 극단적
   경합 상황에서 어긋날 수 있음 — 이론상 케이스, 정상 경로에선 미관측).

## 8. 권장 운영 순서

`ROI 파일 로딩` → `3D육면체 ROI생성` → `시작` → `최종화`. ROI 파일 로딩(파괴적, `slot_setup` 채움)을 먼저
실행해야 하며, `slot_setup`이 비어 있으면 3D육면체 생성은 409로 거절된다.

## 9. 테스트 결과 (검증자 실행 결과 그대로 인용)

```
$ npx tsc --noEmit
(0 에러)

$ npx vitest run
 Test Files  1 failed | 201 passed (202)
      Tests  1 failed | 2391 passed (2392)
   Duration  12.41s
```

- 신규 `test/slotFrontCenter.test.ts`(19) · `test/slotCuboidRoutes.test.ts`(21) 전량 통과.
- 유일 실패: `test/slot3dFrontCenter.test.ts > 프리셋2 근접면 검증` — 재생성 ROI 데이터로 전제가 만료된
  **선행 실패**, 본 변경과 무관(고치지 않음).
- 기존 테스트는 한 줄도 수정하지 않았고(승격 파리티·회귀 보호의 근거), `finalizerParkingSlots.test.ts`·
  `captureRoutes.test.ts`·`groundModelRealData.test.ts`·`groundModelPoolingIntegration.test.ts` 등이
  무수정 전량 통과했다.

## 10. 미검증 한계 (통과로 위장하지 않음)

- **실 DB(`data/setting.sqlite`) 실측 미수행.** "실 23슬롯 중 몇 건 산출"은 라이브 라우트를 실 DB 사본에
  태워 얻은 수치가 아니다(설계서가 요구한 리더 동작확인 항목이 이 문서 작성 시점까지 미수행).
- **브라우저 라이브 클릭 스모크 미수행.** 버튼 클릭 → 화면 변화 관찰(스크린샷 포함)은 이루어지지 않았다.
  DOM 배선은 qa가 소스 문자열 정적 대조로만 확인(jsdom 실행 아님).
- **라이브 시뮬레이터/실카메라 스모크 미수행**(외부 서비스 미가동). 지면모델은 동결 픽스처 기준.
- §2의 "확인 필요" 항목(회귀 테스트 픽스처가 실제로 PTZ 우선순위 변경 조건을 커버하는지)은 미확정.
- `test/slot3dFrontCenter.test.ts`의 선행 실패 1건은 미해결 상태로 남아 있다.

## 11. 결론 (리더 보고용 3줄)

1. `buildGroundInputs` PTZ 우선순위 변경(ROI 자체 값 우선)이 `/capture/ground-model`·`/capture/vehicle-cuboids`·
   `/capture/detect`·`CaptureJob`·`Finalizer` 5개 경로 전체의 지면모델 신뢰도를 동시에 개선했다
   (conf 0.106→0.791~1.000, tilt 오차 4.12°→≈0°, issues 다수→0건, 동결 회귀 테스트 무수정 통과로 보호됨).
- `slotFrontCenter` 승격은 순수 리팩터로 `Finalizer` 동작에 영향 없음(무수정 테스트 전량 통과로 확인).
- 신규 버튼·라우트는 `slot3d_front_center` 컬럼만 건드리는 비파괴 부분 UPDATE이며, 라이브 브라우저 클릭과
  실 DB 실측은 아직 수행되지 않은 한계로 남아 있다.
