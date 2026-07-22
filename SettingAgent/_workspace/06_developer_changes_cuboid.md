# 06 구현 보고 — "3D육면체 ROI생성" 버튼 (slot3d_front_center 산출·저장·표시)

설계서 `05_architect_plan_cuboid.md` A~D 를 순서대로 구현. 설계 이탈 없음(아래 "설계와 다른 점" 참조).

## 변경 파일

### 1. `src/ground/slotFrontCenter.ts` (신설) — A
- `Finalizer.ts` 의 module-private `slotFrontCenter()` 와 상수 `H_CONST(=1.5)` 를 **이동**(복사 아님)해 export.
- 본문·주석 무변경(문자 단위 그대로) → finalize 결과 불변. import 경로만 `../ground/project.js` → `./project.js`,
  `../domain/types.js` 로 조정.

### 2. `src/capture/Finalizer.ts` — A
- `import { H_CONST, slotFrontCenter } from '../ground/slotFrontCenter.js'` 로 전환.
- 이동으로 고아가 된 import 제거: `backprojectToGround/projectCuboidPixels/frontFaceCenterPx`(project.js),
  `type Vec3`(contactTypes.js), `type NormalizedPoint`(domain/types.js).
- finalize 로직·출력은 한 줄도 건드리지 않음.

### 3. `src/capture/SqliteStore.ts` — B
- `upsertSlotFrontCenter(rows: Array<{slotId; slot3dFrontCenter: string|null; updatedAt}>): number` 추가.
  - `UPDATE slot_setup SET slot3d_front_center = ?, updated_at = ? WHERE slot_id = ?` 를 단일 트랜잭션으로.
  - `upsertSlotLpd` 와 동일 형태(키 단위 부분 UPDATE). `replaceSlotSetup` 미사용 — 전량 DELETE 없음.
  - 미존재 slot_id 는 조용히 무시, 반환값 = `stmt.run().changes` 누적(실제 갱신 행수).
  - 인자 TEXT 는 호출측이 `stringify5` 직렬화(소수점 5자리 규약).

### 4. `src/api/captureRoutes.ts` — C
- `SlotCuboidBuildSchema` 추가: `{ heightM?: number }`, `min(0.5).max(3.0)`, `.default({})` (빈 바디 허용).
- `import { H_CONST, slotFrontCenter } from '../ground/slotFrontCenter.js'`.
- `POST /capture/slots/cuboid` 신설(`/capture/slots/occupy` 바로 뒤, saveStore 블록 앞).
  - **400**: heightM 범위 밖/타입 오류. **404**: `placeRoiFile` 미설정 또는 `ground.enabled !== true`,
    그리고 PtzCamRoi.json ENOENT. **409**: `getSlotSetup()` 0건. 그 외 산출 예외 500.
  - 지면모델 조합은 `GET /capture/ground-model` 라우트와 **동일**:
    `readFile(placeRoiFile)` → (있으면) `parseCameraViews(camerapos)` → `buildGroundInputs` → `estimateGroundModels`
    → `${camIdx}:${presetIdx}` 맵. 새 조합·새 수학 없음.
  - 슬롯별: 모델 없음 → `skipped{reason:'지면모델 없음(cam:preset)'}`, `slotFrontCenter` null →
    `skipped{reason:'육면체 퇴화(지평선 위/quad 이상)'}`. **두 경우 모두 저장하지 않음**(기존 값 미파괴, null 미기록).
  - 응답: `{ ok, updated, skipped[], models:[{key,conf,issues}], issues[], heightM }`.

### 5. `web/index.html` — D
- `#cap-load-roi` **바로 뒤**에 `<button id="cap-build-cuboid" title="...">3D육면체 ROI생성</button>` 추가(설계 문구 그대로).

### 6. `web/app.js` — D
- `buildSlotCuboids()` 신설(`loadRoiToDb` 아래). body `{ heightM: cuboidHeight() }` 로 화면 슬라이더 높이 전송.
  성공 후 `state.groundLoaded=false` → `loadGroundModel()` → `$('roi-cuboid').checked=true` →
  `state.roiHidden=false` → `loadParkingSlots()` → `drawRoiOverlay()` / `renderSlotList()`.
  메시지에 `updated`/`skipped`(사유 포함)/모델 conf/`issues`(라우트 issues + 모델별 issues) 전부 노출.
  파괴적이지 않으므로 `confirm()` 없음.
- `$('cap-build-cuboid')` click 등록(`cap-load-roi` 등록부 바로 아래).
- **1회 가드 버그 수정**: `loadRoiToDb()` 에 `state.groundLoaded = false; await loadGroundModel();` 추가
  (`loadPlaceRoi()` 뒤, `loadParkingSlots()` 앞) — ROI 정본 변경 시 지면모델 재산출.
- `drawCuboidOverlay` 등 렌더 로직은 무변경(버튼은 데이터 산출·저장 + 토글 ON 만 담당).

## 검증

- `npx tsc --noEmit` → **0 에러**.
- `npx vitest run test/finalizerParkingSlots.test.ts test/slot3dFrontCenter.test.ts test/captureRoutes.test.ts`
  → 92 테스트 중 **91 통과 / 1 실패**. 실패는 사전 고지된 선행 실패
  (`slot3dFrontCenter.test.ts > 프리셋2 근접면 검증`, 재생성된 ROI 데이터 기인) 1건뿐 — 신규 실패 없음.
  `finalizerParkingSlots`(10) · `captureRoutes`(60) 전부 통과 = 승격 파리티 1차 근거.

## 설계와 다른 점 / 미구현

- **설계 이탈 없음.**
- 라우트 내부에서 지면모델 맵을 만들 때 `Finalizer.buildGroundModelMap` 은 `private` 이라 재사용할 수 없어,
  `/capture/ground-model` 라우트와 **같은 조합 코드**(buildGroundInputs + estimateGroundModels)를 라우트에서 호출했다.
  수학은 전부 기존 모듈 소유 — 새 수학·새 조합은 없다(설계 §C 문구 준수).
- 신규 테스트(`test/slotCuboidRoutes.test.ts`, `test/slotFrontCenter.test.ts`)는 검증자(qa) 담당 — 미작성.
- 리더 실측 동작확인(실 DB 사본 · sharp 렌더 육안 확인)은 이 단계 범위 밖.
