# 02 구현 변경: 정밀수집 종료 후 박스 유지 + DB 소스 상시 렌더

설계서 `01_architect_plan.md` 그대로 구현. 전부 `web/app.js` (순수 상태/렌더, 추가 카메라 패킷 0). 서버측 변경 없음.

## 변경 파일
- `web/app.js` (유일)

## A. 직전 종료 리셋 되돌리기(외과적 원복)
1. **state 리터럴** (구 L88): `finalizeOccSnapshot: {}` 필드 제거.
2. **capPoll 종료 분기** (`wasActive && (done|stopped|error)`): 직전 추가한 두 줄
   `state.finalizeOccSnapshot = state.occComputeByKey;` + `resetOverlayDisplay();` **제거**. `startLive()`는 **유지**(라이브 배경 복귀). 주석을 "데이터 보존 → 박스가 라이브 배경 위 오버레이로 남음"으로 갱신.
   → `detectByKey`/`occComputeByKey`/`vcuboidByKey` 보존 → 종료 후 박스 유지.
3. **capStart**: `state.finalizeOccSnapshot = {};` 초기화 줄 제거.
4. **buildFinalizeOccupancy**: 스냅샷 폴백 제거 → 원래대로 `Object.entries(state.occComputeByKey).map(...)` 직접 참조.
- `resetOverlayDisplay()` 함수 자체는 "표시 초기화 버튼"이 여전히 사용 → 유지(고아 아님).
- 센터라이징(calFrameTick/calFrameTimer/startCalFramePolling/stopCalFramePolling) 및 서버측 전부 미변경.

## B. DB(parkingSlotsByKey) 소스 오버레이 상시 렌더 (라이브 없을 때 폴백)
1. **drawDetectOverlay**: 함수 시작에서 `const key=currentFrameKey(); const d=state.detectByKey[key];`. `if(!d)`이면 신설 헬퍼 `drawDbDetect(ctx, rows, showVehicle, showPlate)` 호출 후 return.
   - **drawDbDetect(신설)**: `rows` 순회하며 `#roi-vehicle` 시 `row.vpd`(있으면) `toPixel` → 청록(#00e5ff) strokeRect, `#roi-plate` 시 `row.lpd`(있으면) `drawPlateQuad(ctx, row.lpd, false)`(노랑). null 필드 skip. 읽기표시 전용(선택 하이라이트·핸들 없음).
2. **drawOccupancyOverlay**: `const key=currentFrameKey(); const occ=state.occComputeByKey[key]; const hasLive=(occ?.spaces??[]).length>0;`. `!hasLive`이면 DB 폴백 — `state.parkingSlotsByKey?.[key]` 행의 `row.occupyRange`(있으면) `toPixelQuad` → 빨강 반투명 면(fill `rgba(255,77,77,0.18)` + stroke `rgba(255,77,77,0.9)`, 기존 점유영역과 동일 스타일) 후 return. 게이트 `#roi-occupancy`. 라이브 있으면 기존 경로 그대로.
3. **precise 탭 진입**: 기존 `if(tab==='precise'){ capPoll(); calPoll(); loadPlaceRoi(); loadGroundModel(); }`에 `void loadParkingSlots().then(()=>drawRoiOverlay());` 추가(로드 후 1회 재렌더). loadParkingSlots는 기존 함수(실패 시 조용히 미표시).

## 이중 렌더 회피
프리셋 키 단위 — 라이브(detectByKey/occComputeByKey) 있으면 라이브 경로, 없으면 DB 폴백. 같은 프리셋에서 동시 렌더 없음(각 draw 함수가 라이브 유무로 분기 후 폴백만 실행).

## 데이터 shape (검증 완료)
- 서버 `SqliteStore.getSlotSetup()` → `SlotSetupView`: `vpd:{x,y,w,h}|null`, `lpd:NormalizedQuad|null`, `occupyRange:NormalizedPoint[]|null`, `presetKey:"${camId}:${presetId}"`. web `loadParkingSlots`가 `presetKey`로 그룹핑 → `state.parkingSlotsByKey[key]=행배열`. 키 = `currentFrameKey()`와 정합.

## 설계 대비 편차
- 없음. 설계서 A/B 항목 그대로. `drawOccupancyOverlay`에서 `currentFrameKey()`를 `key` 지역변수로 1회 캐시(라이브·폴백 공용) — 순수 정리, 동작 동일.

## 검증
- `npm run typecheck` (tsc --noEmit): **통과** (에러 0). app.js는 순수 JS라 tsc 대상 아님 — 서버측 회귀 0 확인.
- 잔여 `finalizeOccSnapshot` 참조 0(grep 확인).
- 유닛/경험적 검증은 qa/리더 단계(웹 렌더 DOM 결합 → sharp 스샷 육안). 순수 분리 로직은 라이브/DB 폴백 판정뿐(단순 조건) — core.js 추출 무리하지 않음(설계서 위임).
