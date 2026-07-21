# 01 설계: 정밀수집 종료 후 VPD/LPD/점유영역 유지 + DB 소스 상시 렌더(체크박스 show/hide)

작성: 리더(현자 라) — B(goal/loop) 모드. 직전 "센터라이징 화면갱신" 작업의 **후속 수정**.

## 배경 / 마스터 요구
1. 정밀수집이 끝난 후 **VPD·LPD·점유영역 박스가 유지**되어야 한다. 지금은 사라진다.
   - 원인: 직전 수정이 종료(done/stopped/error) 시 `resetOverlayDisplay()`로 `detectByKey`/`occComputeByKey`를 **삭제**해 박스가 사라짐(과교정).
2. **DB 테이블에 존재하면 항상 출력** 가능해야 한다 — **체크박스 플래그로 show/hide**.
   - 발견: DB `slot_setup`에 `vpd_bbox`/`lpd_obb`/`occupy_range` 컬럼이 이미 있고 finalize가 저장. `GET /capture/slots`(getSlotSetup)가 `SlotSetupView.vpd{x,y,w,h}`/`lpd`(quad)/`occupyRange`(polygon)로 파싱 반환. 웹은 이를 `state.parkingSlotsByKey`로 받지만 **목록에만 쓰고 오버레이로 안 그림**. `loadParkingSlots`는 finalize에서만 호출 → reload 시 미표시.

## 목표(관찰형 성공기준)
- 정밀수집 종료 후에도 차량(VPD)·번호판(LPD)·점유영역 박스가 화면에 **남는다**.
- 페이지 reload/탭 재진입 후에도 **DB에 데이터가 있으면** 박스가 그려진다.
- `#roi-vehicle`/`#roi-plate`/`#roi-occupancy` 체크박스로 각각 show/hide 된다.
- 추가 카메라 패킷 0(순수 상태/렌더 변경). 센터라이징 화면갱신·정밀수집 프레임폴 회귀 0.

## 변경 설계 (web/app.js 중심 — 순수 렌더·상태)

### A. 종료 리셋 되돌리기(요구1)
- `capPoll` 종료 분기([app.js #L1907 부근](../web/app.js#L1907)): 직전 추가한 `state.finalizeOccSnapshot = ...` + `resetOverlayDisplay()` **제거**. → `detectByKey`/`occComputeByKey`/`vcuboidByKey` 보존(박스 유지).
- `startLive()`는 **유지**(요구1의 원 취지 = 얼어붙은 프레임을 라이브 배경으로 교체). 박스는 캔버스 오버레이 레이어라 라이브 배경 위에 남는다(프리셋 정합: 종료 후 `capFrameKey2=null` → currentFrameKey = 선택 프리셋).
- 되살린 dead code 정리: `finalizeOccSnapshot`(state 필드·capStart 초기화·buildFinalizeOccupancy 폴백)은 이제 불필요 → **되돌려 제거**(occComputeByKey를 더는 안 지우므로 buildFinalizeOccupancy가 직접 참조). 외과적 원복.

### B. DB 소스 오버레이 상시 렌더(요구2)
DB(`parkingSlotsByKey`)를 **라이브 없을 때의 폴백 소스**로 오버레이에 추가. 이중 렌더 회피 규칙: **프리셋 키별로 라이브(detectByKey/occComputeByKey) 있으면 라이브, 없으면 DB.**
1. `drawDetectOverlay`([#L828](../web/app.js#L828)): `const key=currentFrameKey(); const d=state.detectByKey[key];` 가 없으면 `state.parkingSlotsByKey?.[key]` 행들에서 `vpd`(→ `toPixel`로 차량 rect, 청록) / `lpd`(→ `drawPlateQuad`로 번호판 quad, 노랑)를 그린다. 게이트는 동일 `#roi-vehicle`/`#roi-plate`. DB 폴백 렌더 헬퍼(`drawDbDetect(ctx, rows, showVehicle, showPlate)`) 신설해 라이브 경로와 분기.
2. `drawOccupancyOverlay`([#L399](../web/app.js#L399)): `occComputeByKey[key]` 없으면 `parkingSlotsByKey[key]` 행의 `occupyRange`(polygon → `toPixelQuad`로 빨강 반투명 면). 게이트 `#roi-occupancy`.
3. **탭 진입/reload 시 DB 로드**: precise 탭 진입([#L2635 부근](../web/app.js#L2635) `if(tab==='precise'){...}`)에 `loadParkingSlots()` 추가(중복 로드 방지 가드 검토 — 매 진입 갱신 허용, 저비용 단일 쿼리). 로드 후 `drawRoiOverlay()`.
   - ⚠️ 부작용 검토: parkingSlotsByKey 채워지면 `renderSlotList`의 `finalized` 분기(#L892)가 켜져 목록이 DB 평면목록으로 전환됨 — 이는 "DB 있으면 상시 표시"와 정합(의도된 동작). 회귀 아님을 qa/리더가 확인.

### C. 렌더 데이터 shape(참조)
- `SlotSetupView.vpd = {x,y,w,h}`(정규화) → `toPixel(v, W, H)`.
- `SlotSetupView.lpd = NormalizedQuad([{x,y}×4])` → `drawPlateQuad(ctx, lpd, false)`.
- `SlotSetupView.occupyRange = NormalizedPoint[]` → `toPixelQuad` 폴리곤.
- 키 정합: `presetKey = ${camId}:${presetId}` = currentFrameKey().

## 불변식 / 회귀 가드
- 추가 카메라 패킷 0: 전부 상태/렌더. `/capture/slots`는 기존 라우트 재사용(카메라 미호출).
- 센터라이징(calFrameTick·/calibrate/frame)·정밀수집 프레임폴 미변경.
- 이중 렌더 회피: 라이브 우선, DB 폴백(프리셋 키 단위).
- CLAUDE.md: 외과적. finalizeOccSnapshot 원복은 직전 내 변경분 정리(고아 코드 제거)라 규약 부합.

## 테스트(vitest)
- 웹 렌더는 DOM 결합 → 리더 경험적 검증(sharp 스샷: SlotSetupView 표본을 drawDbDetect/occupancy 경로로 렌더해 라이브 렌더와 픽셀 parity 확인). 순수 분리 가능한 폴백-선택 로직(라이브 우선/ DB 폴백 판정)이 있으면 core.js 순수함수로 떼어 vitest. 무리한 app.js 직접 테스트 금지.
- 서버측 변경 없음(기존 getSlotSetup/`/capture/slots` 회귀 확인만) → 전체 vitest 회귀 0 확인.

## 경험적 검증(리더)
- 라이브 라우트: 서버 13020 구동 시 `curl /capture/slots`로 vpd/lpd/occupyRange 포함 shape 확인.
- sharp 스샷: parkingSlotsByKey 표본으로 DB 폴백 오버레이 렌더 육안 확인(체크박스 on/off 대칭).
- 한계: 실 시뮬레이터 위 라이브 배경 + 박스 정합 육안은 마스터 확인 위임 가능(메커니즘은 기존 라이브 렌더와 동일 헬퍼).
