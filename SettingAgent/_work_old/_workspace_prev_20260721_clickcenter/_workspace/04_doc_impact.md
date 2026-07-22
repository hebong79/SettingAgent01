# 04_doc_impact — 영향도 분석 요약 (LPD 미검 디더 재포착 + P1 위장 성공 제거)

작성: 2026-07-22 · 문서화(documenter) · 대상: 최종 문서 `docs/20260722_101500_클릭센터줌_LPD미검_디더재포착.md`

## 변경 파일

| 파일 | 변경 종류 | 핵심 |
|---|---|---|
| `src/calibrate/platePtz.ts` | 옵션 3키(`plateRecaptureDitherNorm`/`plateRecaptureRetries`/`plateRecaptureZoomStep`) 추가, `PlatePtzResult.recaptureDithers?` 추가, private `captureTrack()`·`captureTrackZoom()` 신규, 모듈 로컬 `ditherMultipliers()` 신규, 호출측 3곳(A=centerOnPlate 추적루프 / B=zoomToPlateWidth 가드 재중심 / C=줌 후 캡처) 치환 | 신규 기능 + 내부 리팩터. **성공 조건·게이트·latch 판정은 무변경** |
| `src/calibrate/PtzCalibrator.ts` | 상수 3개, private `recaptureOpts()` 신규, `centerOnPoint`의 `makePlatePtz` 2곳에만 스프레드, **P1**: 줌 실패 시 무조건 반환(기존 `if (z.ok) return z;` → 항상 `{ok:z.ok,...}` 반환) | 신규 기능 + **버그 수정(거짓 성공 제거)** |
| `src/config/toolsConfig.ts` | `CalibrateSchema`에 옵셔널 키 3개 추가 | 스키마 확장(옵셔널·하위호환) |
| `test/platePtzRecapture.test.ts`(신규) | 21건 | QA 신규 |
| `test/ptzCalibratorRecaptureWiring.test.ts`(신규) | 10건 | QA 신규 |
| `test/ptzCalibrator.point.test.ts` | 1건 의미 반전(위장 성공을 고정하던 케이스 → 정직 반환 단언) + 회귀 가드 1건 추가 | 구현자, P1 대응 |
| `config/tools.config.json` | **무변경** | 코드 기본값으로 동작 |
| `src/api/calibrateRoutes.ts` | **무변경**(passthrough) | §2 참조 |
| `web/app.js` | **무변경** | §2 참조 |

## 전파 경로 분석

### 1) `@parkagent/types`(공유 패키지) — 전파 없음
`packages/types` 전체를 `plate_lost`/`no_plate_near_click`/`centerOnPoint`/`recaptureDithers` 키워드로 검색 → **매치 0건**. 신규 필드(`recaptureDithers`)와 신규 옵션 키는 전부 `SettingAgent` 내부 로컬 타입(`PlatePtzResult`/`PlatePtzOpts`)이며 공유 패키지에 노출되지 않는다.

### 2) ActionAgent / DMAgent — 전파 없음
두 에이전트 트리를 `centerOnPoint`/`calibrate/point` 키워드로 검색 → **매치 0건**. `/calibrate/point` 엔드포인트를 소비하는 클라이언트는 SettingAgent 자신의 `web/app.js`뿐이다.

### 3) REST 계약(`POST /calibrate/point`) — shape 불변, 관찰값 변화
- `src/api/calibrateRoutes.ts:83-84`는 `{ok, ptz, plateWidth, reason?}`를 그대로 통과시키는 코드이며 **무변경**.
- 그러나 P1로 인해 **같은 호출이 이전과 다른 응답을 낸다**: 줌 실패 시 과거 `{ok:true}`(reason 없음) → 이제 `{ok:false, reason:'plate_lost'|'zoom_saturated'|'max_iterations'}`. 이는 REST 계약의 "형(shape)"이 아니라 "값"이 바뀐 것이며, 이 값 변화가 관찰 가능한 유일한 하류는 `web/app.js`다.

### 4) `web/app.js`(UI) — 코드 무변경, 표시 문구 관찰상 변화
`app.js:2474-2487`의 분기(`data.ok` true→완료 문구, false→`종료(${reason})`)는 코드를 건드리지 않았다. 그러나 P1로 `ok:false`가 새로 나가는 슬롯이 생겨, 그 슬롯에 대해 **운영자가 보는 화면 문구가 "개별 센터라이징 완료"에서 "종료(plate_lost)" 등으로 바뀐다**. 이는 결함 수정의 의도된 결과이나, 화면 육안 확인은 이번 범위에서 수행되지 않았다(한계로 문서에 명시).

### 5) 배치 경로(`calibrateSlot`) — 구조적 무회귀
- 신규 옵션 3키의 기본값이 각각 0/기존 상수라 `retries=0`이면 재시도 루프가 0바퀴 → 캡처 횟수·반환 PTZ·reason이 수정 전과 바이트 단위로 동일.
- `recaptureOpts()`는 `PtzCalibrator.centerOnPoint`의 `makePlatePtz` 2곳(클릭 경로)에만 스프레드되고 배치가 쓰는 `baseOpts()`/`ladderOpts()`에는 넣지 않아, 배치 코드가 신규 키를 담은 opts를 만들 방법이 구조적으로 없다.
- QA가 `start()` 종단 실행 중 생성된 모든 PlatePtz opts에 재포착 키가 없음을 실측 단언, 사다리 경로의 캡처 궤적·결과가 `retries 0`과 `6`에서 완전 동일함도 확인.

### 6) `config/` 디렉터리 — nodemon 감시 밖
`config/tools.config.json`은 이번 변경에서 건드리지 않았으나, 신규 키(`pointRecaptureDitherNorm`/`pointRecaptureRetries`/`pointRecaptureZoomStep`)를 그 파일에 추가해 라이브 튜닝할 경우 **서버 재시작이 필요**하다(전편 문서와 동일한 운영 주의사항 재확인).

## 거짓 성공 금지선 재확인(요약)

- 재시도 게이트는 헬퍼 시그니처상 `radius` 인자가 1개뿐이라 완화 개념이 존재할 수 없음.
- 최대 디더 변위(정규화 0.0056)가 게이트(0.08)의 7%·이웃 간격(0.15)의 3.7%로 zoom과 무관하게 고정.
- QA가 게이트 경계(0.0805/0.083/0.085)를 직접 두드려도 채택 0건.
- zoom 승법 디더도 항상 "그 프레임에서 실측한 폭"으로만 수렴 판정 — 위장 경로 없음.

## 검증 상태(사실 기반, 인용)

- `npx tsc --noEmit`: 에러 0.
- `npx vitest run`: **198파일/2327테스트 전건 통과**(QA 실행).
- 라이브 실측(리더 직접, 유닛과 별개): 슬롯1~7×3라운드 = 21/21 성공 + 사후 확인 7/7, 금지선 3지점 전부 정직 실패.
- QA의 독립 반증 시도 결과: 위장 성공 경로 없음, `recaptureDithers` 정의는 계약을 깨지 않음(단 `zoom_saturated` 출구 누락 1건 발견).

## 확인 필요(불확실 — 단정하지 않음)

- 실카(real-camera)에서 동일 디더 크기가 유효한지는 **확인 필요**(`fallbackGainTiltDeg`가 cam1 시뮬 실측치에 100% 의존).
- 사다리(D 지점)·A·B 지점의 zoom 데드존 대응 필요성은 **확인 필요**(이번 라이브 21/21로 당장 문제는 없으나 원리적 위험 잔존).
- UI 문구 변화의 실제 화면 확인은 **미실행 — 확인 필요**.

## 산출물 경로

- 최종 문서: `d:\Work\Parking3D\AgentVLA\ParkAgent\SettingAgent\docs\20260722_101500_클릭센터줌_LPD미검_디더재포착.md`
- 이 요약: `d:\Work\Parking3D\AgentVLA\ParkAgent\SettingAgent\_workspace\04_doc_impact.md`
