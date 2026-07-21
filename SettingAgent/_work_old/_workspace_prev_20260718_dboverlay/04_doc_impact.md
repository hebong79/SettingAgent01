# 04 문서화·영향도 요약: VPD/LPD/점유영역 종료 후 유지 + DB 소스 상시 렌더

작성: documenter · 최종 문서: `docs/20260718_153003_VPDLPD점유영역_종료후유지_DB소스렌더.md`

## 변경 요약
- `web/app.js` 단일 파일. (A) 정밀수집 종료 시 `resetOverlayDisplay()` 자동 호출(직전 작업의 과교정)을 제거해 VPD/LPD/점유영역 박스가 종료 후에도 라이브 배경 위에 유지되도록 원복. `startLive()`만 유지. 고아 코드(`finalizeOccSnapshot` 필드·초기화·폴백) 함께 원복. (B) DB(`slot_setup` → `parkingSlotsByKey`)를 라이브 없을 때의 오버레이 폴백 소스로 신설(`drawDbDetect` 신설, `drawDetectOverlay`/`drawOccupancyOverlay` 분기 가산, precise 탭 진입 시 `loadParkingSlots()` 호출 가산). 프리셋 키 단위 라이브 우선/DB 폴백으로 이중 렌더 회피. 서버측(`Finalizer`/`SqliteStore`/`captureRoutes`)은 읽기만 하고 무변경.

## 영향 모듈
- `web/app.js`: `drawDetectOverlay`/`drawOccupancyOverlay`/`drawDbDetect`(신설)/`capPoll`/`setTab('precise')`.
- 서버측 무변경: `src/capture/Finalizer.ts`, `src/capture/SqliteStore.ts`(`getSlotSetup`), `src/api/captureRoutes.ts` — 기존 `GET /capture/slots` 계약 그대로, 웹 소비 방식만 확장.

## 기존 기능 영향
- 라이브 검출/점유 렌더: 회귀 0 — DB 폴백은 라이브 없을 때만 가산 실행, 라이브 있을 때 기존 경로 완전 동일.
- 직전 작업(센터라이징 화면갱신·정밀수집 프레임폴): 미변경, 회귀 없음.
- `renderSlotList`의 `finalized` 분기가 탭 진입 시(DB 로드 시점 확대로) 더 자주 켜짐 — "DB 있으면 상시 표시" 요구와 정합하는 의도된 동작.

## 잠재 리스크
- 라이브/DB 폴백 경계는 프리셋 키 단위(슬롯 단위 아님) — 부분 라이브 상태에서는 DB가 섞이지 않고 라이브만 표시.
- `drawDbDetect`는 읽기표시 전용(핸들 없음) — 라이브 검출 결과와 달리 클릭 편집 불가(UI 동작 차이, 확인 필요).
- DB null 필드는 skip 렌더(부분 표시) — 매칭 차량 없는 finalize 결과는 빈 자리로 보임(데이터 상태, 버그 아님).

## 테스트 결과 인용
- 전체 vitest 156파일/1730케이스 전부 통과, 실패 0(신규 `test/dbOverlayParity.test.ts` 2케이스 포함).
- 신규 테스트: 실 SqliteStore+Finalizer로 finalize→DB→getSlotSetup→core.js(toPixel/toPixelQuad) 전 경로 parity 검증 통과.
- 한계: 웹 캔버스 DOM 렌더(박스 잔존·show/hide·reload)는 vitest 대상 밖 — 리더 sharp 스샷 위임. 서버 라이브 스모크(curl) 미수행(유닛으로 동일 shape 증명, 스모크는 누락으로 명시). 실 DB 17행 현재 vpd/lpd/occupy 전부 null(마지막 finalize 매칭 차량 없음) — 매칭 차량 있는 finalize 이후 재확인 필요.

## 확인 필요 항목
- `drawDbDetect` 읽기전용(핸들 없음)이 UI 상 사용자 체감에 미치는 영향은 마스터 확인 대상.
- 실 DB에 매칭 차량 데이터가 채워진 이후의 sharp 스샷 재확인.
