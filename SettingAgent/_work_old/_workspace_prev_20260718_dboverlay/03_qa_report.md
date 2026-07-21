# 03 검증 리포트: 정밀수집 종료 후 VPD/LPD/점유영역 유지 + DB 소스 상시 렌더

검증자(qa-tester) — CLAUDE.md 규칙 2(유닛테스트)·3(동작확인). 대상: `web/app.js` 단일 파일 변경(서버측 무변경).

## 1. 전체 회귀 (최우선) — 통과

`npx vitest run` 전체 실행.

| 항목 | 결과 |
|------|------|
| 테스트 파일 | **156 passed / 156** (신규 1 포함) |
| 테스트 케이스 | **1730 passed / 1730** |
| 실패 | **0** |
| exit code | 0 |

- 신규 테스트 추가 전 기준선: 155 파일 / 1728 케이스 전부 그린 → 신규 `dbOverlayParity.test.ts`(2케이스) 추가로 156/1730.
- 서버측 코드 무변경이므로 회귀 0 이 기대치였고, 그대로 확인됨.
- 직전 작업(센터라이징 프레임갱신) 회귀 가드 `test/calibrateFrame.test.ts` 명시 재확인 통과. `parkingSlotsRoutes`·`finalizerParkingSlots` 포함 3개 핵심 파일 개별 재실행 = 21/21 그린.

## 2. DB 소스 shape parity — 통과 (교차 검증)

이번 변경의 핵심 리스크: 라이브 검출이 없는 프리셋에서 **DB(slot_setup) → 오버레이 폴백 렌더**. app.js 소비 계약과 서버 `getSlotSetup()` 반환 shape 이 일치해야 한다.

교차 검증한 경계면:

| 서버 `SlotSetupView` 필드 | 실제 shape | app.js 폴백 소비 | core.js 헬퍼 입력계약 | 정합 |
|---|---|---|---|---|
| `vpd` | `{x,y,w,h}` | `drawDbDetect`: `toPixel(row.vpd)` → `{px,py,pw,ph}` strokeRect | `toPixel(rect{x,y,w,h})` | O |
| `lpd` | `NormalizedQuad = [{x,y}×4]` | `drawPlateQuad(row.lpd)` → 내부 `toPixelQuad` | `toPixelQuad(quad[{x,y}])` | O |
| `occupyRange` | `NormalizedPoint[]` | `drawOccupancyOverlay` 폴백: `toPixelQuad(row.occupyRange)` → 폴리곤 fill | `toPixelQuad(pts[{x,y}])` | O |
| `presetKey` | `` `${camId}:${presetId}` `` | 폴백 조회 키 = `currentFrameKey()` | (동일 규약) | O |

- **소스 근거**: 서버 `SqliteStore.getSlotSetup()`(src/capture/SqliteStore.ts:211) 이 `vpd_bbox`/`lpd_obb`/`occupy_range`(TEXT JSON)을 `{x,y,w,h}`/`quad`/`point[]` 로 파싱. `Finalizer`(src/capture/Finalizer.ts:217-219) 가 동일 shape 으로 직렬화 저장. web `core.js`(toPixel/toPixelQuad)와 필드명·타입 완전 일치.
- **라이브 렌더 parity**: 라이브 경로도 동일 `toPixel`(vpd rect)·`drawPlateQuad`(→`toPixelQuad`)·`toPixelQuad`(occupy)를 쓴다 → "라이브 렌더와 DB 폴백 렌더가 같은 헬퍼·같은 shape". 이중 렌더 회피(프리셋 키 단위 라이브 우선)도 각 draw 함수의 `if(!live)` 분기로 확인.

### 신규 테스트: `test/dbOverlayParity.test.ts` (2케이스, 통과)

**실제 finalize → DB → getSlotSetup → core.js 렌더헬퍼** 전 경로로 검증(모킹 없이 실 SqliteStore :memory: + 실 Finalizer):
1. 차량+번호판 관측 스냅샷 finalize → `getSlotSetup()` 의 `vpd`/`lpd`/`occupyRange` 3필드 모두 non-null 확인.
2. `toPixel(vpd)` → `{px,py,pw,ph}` 키 정확 일치 + 유한값 + 캔버스(1280×720) 범위 내 + 양수 w/h.
3. `toPixelQuad(lpd)` → 4점 `{px,py}` 유한·범위 내.
4. `toPixelQuad(occupyRange)` → ≥3점 폴리곤 유한·범위 내.
5. `parkingSlotsByKey` 그룹핑 키 = `1:1`(= currentFrameKey 규약) 정합.

기존 `test/boundaryCrossCheck.test.ts` (경계면 #2)가 SlotSetupView 필드 계약·presetKey 파생을 이미 커버 → 신규 테스트는 그 위에 **실 값을 실제 렌더헬퍼에 통과**시키는 parity 근거를 추가(기존엔 없던 커버리지).

## 3. Finalizer 저장 계약 (회귀 없음) — 통과

- `test/finalizerParkingSlots.test.ts` 통과: hit 있을 때 `vpdBbox`/`lpdObb`/`occupyRange` 저장, hit 없을 때 null(단 `slotRoi` 는 항상 저장) — 기존 동작 그대로. 이번 변경(app.js)이 서버 저장 경로를 건드리지 않았음을 확인.
- **실 DB 상태 명시**: `data/setting.sqlite` slot_setup 17행 — `slot_roi` 17/17 존재, `vpd_bbox`/`lpd_obb`/`occupy_range` **0/17(전부 null)**. 이는 "마지막 finalize 에 매칭 차량 없음"이라는 **데이터 상태**이지 버그가 아니다(Finalizer 는 hit 없으면 정상적으로 null 저장). 매칭 차량이 있는 finalize 를 재현한 신규 parity 테스트에서는 3필드 모두 정상 채워짐이 확인됨 → 저장·렌더 경로 자체는 건전.

## 4. 한계 (리더 sharp 스샷 경험적 검증에 위임)

- `web/app.js` 의 `drawDbDetect`/`drawOccupancyOverlay`/`drawDetectOverlay` 는 DOM 결합(`overlay`/`ctx`/`$()`/체크박스 게이트)이라 vitest 직접 불가. 실제 캔버스 픽셀 렌더·`#roi-vehicle`/`#roi-plate`/`#roi-occupancy` show/hide 대칭·정밀수집 종료 후 박스 잔존(startLive 배경 위 오버레이)·reload/탭재진입 표시는 **리더의 sharp 스샷 육안 검증**으로 확인 필요(설계서 §테스트/§경험적 검증 위임).
- 순수 헬퍼 레벨의 shape parity(목표2)는 위 신규 테스트로 커버 완료 → 리더 검증은 "메커니즘 동일 헬퍼" 전제 위에서 픽셀 정합만 확인하면 됨.
- 서버 라이브 라우트 스모크(`curl /capture/slots`)는 서버 미구동 시 생략 — 유닛(실 store finalize)으로 동일 shape 을 이미 증명. 스모크는 누락으로 명시(통과 위장 아님).

## 결론

- 전체 vitest **156 파일 / 1730 케이스 전부 통과, 회귀 0**.
- DB 소스 오버레이 폴백의 shape parity(vpd→toPixel / lpd·occupyRange→toPixelQuad) 실 파이프라인으로 교차 검증 완료 — 라이브와 동일 헬퍼·동일 shape.
- Finalizer 저장 계약 무변경 확인. 실 DB 의 vpd/lpd/occupy null 은 데이터 상태(버그 아님).
- 웹 캔버스 렌더 육안(박스 잔존·show/hide·reload)만 리더 sharp 스샷에 위임.
