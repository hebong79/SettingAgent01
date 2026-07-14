# 02 구현 변경 요약 — LPD rect → quad(OBB 4점) 전체 파이프라인

구현자 산출물. 설계서(`01_architect_plan.md`)의 Phase 1~5 순서대로 구현. 검증자·문서화 전달용.

## 개요

LPD 번호판을 축정렬 rect 에서 실제 OBB 회전 4점(quad)으로 바꾸는 양쪽 코드베이스(Python lpd_api + TS SettingAgent) 파이프라인.
핵심 원칙: **실 OBB quad 방향을 집계~setup_artifact 까지 보존**. clustering/calibration 내부는 `quadBoundingRect` 로 rect 유도해 기존 math 재사용. `rectToQuad` 는 quad 부재(구데이터/폴백) 전용.

## Phase 1 — Python lpd_api (polygons 반환)

| 파일 | 변경 |
|---|---|
| `Sub/lpd_api/routers/yolo.py` | L30 `task="detect"` → `task="obb"`(OBB 활성 버그 수정). `dt()` 언팩 `bboxes`→`polygons`, 응답 필드 `bboxes=`→`polygons=`, 성공 판정 `if polygons:`. 예제 docstring 갱신(polygons 4점, 점순서 규약 명기). |
| `Sub/lpd_api/schemas/yolo.py` | `bboxes: List[List[float]]` 제거 → `polygons: List[List[List[float]]]` 추가. |
| `Sub/lpd_api/detectors/yolov8.py` | `__call__`·`plot_boxes` 반환 `bboxes`→`polygons`. `plot_boxes`: `results.obb.xyxyxyxy`((N,4,2) 픽셀)→`.cpu().numpy().tolist()`. **검출 0/비-OBB 방어**: `obb is None or obb.xyxyxyxy is None or len==0` → `(frame, [], [], [])`. conf/cls 는 `obb.conf`/`obb.cls`. annotate 는 `sv.OrientedBoxAnnotator`(supervision 0.25.1 존재 확인). |
| `Sub/lpd_api/README.md` | 빈 파일 → LPD polygons 응답 계약·예시(검출0 포함)·점순서 규약 문서화. |

- 검증: `python -c "ast.parse"` 3파일 구문 OK. `sv.OrientedBoxAnnotator` export 확인. YOLO 실행 불가라 로직은 코드 리뷰로. (수동 curl 은 qa/문서 단계.)
- **설계 대비 편차**: 없음. 단, `API_RESPONSE_EXAMPLES.md` 는 실제로 **VPD** 문서(lpd 무관)라 미변경, 대신 near-empty 였던 `README.md` 에 LPD 계약을 신규 작성(설계 의도 = LPD 응답 예시 갱신 충족).

## Phase 2 — TS 파싱/타입

| 파일 | 변경 |
|---|---|
| `src/domain/geometry.ts` | 순수함수 3개 신규 export: `normalizeQuad(pts,imgW,imgH)`(길이≠4 throw, clamp01, 점순서 보존), `quadBoundingRect(q)`(min/max rect), `rectToQuad(r)`(TL,TR,BR,BL). `NormalizedQuad` import 추가. |
| `src/clients/LpdClient.ts` | `LpdResponse.bboxes`→`polygons: number[][][]`. `PlateBox` 재정의: `VehicleBox` 별칭 폐기 → `{ quad: NormalizedQuad; confidence; cls }`. `detectOnce` 가 `body.polygons.map(poly → normalizeQuad(poly,...))`. `normalizeBox` import 제거, `normalizeQuad` import. |

- 검증: 순수함수 런타임 스모크(정규화·클램프·boundingRect·roundtrip·throw) 통과.

## Phase 3 — 집계/저장/스키마(quad 보존)

| 파일 | 변경 |
|---|---|
| `src/capture/types.ts` | `NormalizedQuad` import. `DetectionRow.quad?`(plate 만), `AggregatedSlot.plateQuad: NormalizedQuad \| null` 추가. |
| `src/capture/CaptureJob.ts` | plate 적재 시 `br=quadBoundingRect(p.quad)` 로 rect(집계용) + `quad`(보존) 동시 push. dets 배열 타입에 `quad?` 추가. `quadBoundingRect`·`NormalizedQuad` import. |
| `src/capture/SqliteStore.ts` | `detection`에 `px0..py3`, `aggregated_slot`에 `plate_px0..plate_py3` 8컬럼 추가(CREATE 문 + **기존 파일 DB 마이그레이션** `addColumnsIfMissing`: `PRAGMA table_info`→없으면 `ALTER TABLE ADD COLUMN`). `insertDetections`·`replaceAggregatedSlots` quad 바인딩(부재 NULL), `getDetectionsForRun`·`getAggregatedSlots` quad 복원(`quadFromCols` 헬퍼, 하나라도 NULL→undefined→구DB 폴백). |
| `src/capture/Aggregator.ts` | `Cluster.members`를 `Member{rect,quad?}` 로 보강. `clusterRect`·`representativeQuad`(대표 rect 중심 최근접 멤버 quad) 신규. plate 클러스터 참조 유지 후 매칭 성공 시 `plateQuad`, 실패/quad 부재 시 `null`. `medianRect` 는 rect 배열 유지(호출측이 `.map(m=>m.rect)`). |
| `src/capture/Finalizer.ts` | plate 기록을 `m.plateQuad ?? rectToQuad(rect)` → `plateRoiByPreset={[key]:quad}`. `rectToQuad` import 추가. |

- 검증: SQLite 마이그레이션+왕복 런타임 스모크 통과(구DB 크래시 없음·quad NULL→undefined, 신규 quad 8값 왕복, agg plateQuad null 처리).
- **마이그레이션 주의**: 기존 파일 DB 는 최초 `new SqliteStore(path)` 시 자동 ALTER. `:memory:` 는 CREATE 문에 컬럼 포함. `PRAGMA table_info(${table})` 는 테이블명 하드코딩(주입 아님)이라 SQL 인젝션 무관.

## Phase 4 — 캘리브레이션 유도(rect 재사용)

| 파일 | 변경 |
|---|---|
| `src/calibrate/types.ts` | **무변경**(`PlateTarget.plateRoi: NormalizedRect` 유지 — 설계대로 writer 가 quad→rect 유도해 채움). |
| `src/calibrate/slotPtzWriter.ts` | `expandPlateTargets`: value 가 quad → `plateRoi: quadBoundingRect(quad)`. `quadBoundingRect` import. |
| `src/calibrate/controlMath.ts` | `pickNearestPlate`: `p.rect` → `quadBoundingRect(p.quad)` 로 중심 계산. `quadBoundingRect` import. |
| `src/calibrate/PtzCalibrator.ts` | `plate.rect.*`/`plateCenterError(plate.rect)` 접점을 `pr=quadBoundingRect(plate.quad)` 1회 유도 후 재사용(centering·zoom·probe 3구간). zoom/centering math **무변경**. `quadBoundingRect` import. |

- 검증: typecheck(src) 클린. 캘리브레이션 math 자체는 무변경이라 회귀 없음.

## Phase 5 — 뷰어 렌더(quad 폴리곤)

| 파일 | 변경 |
|---|---|
| `web/app.js` | `drawRoiOverlay` plate 섹션: `toPixel`+`strokeRect` → `toPixelQuad`+beginPath/lineTo/closePath/stroke(floor quad 패턴 재사용, 색 `#ffd60a`, 채움 없음). `toPixelQuad` 이미 import 됨. |
| `web/core.d.ts` | `SlotLike.plateRoiByPreset` 를 `Record<string, NormalizedPoint[] \| NormalizedQuad>` 로(floor 와 동일 관용 — 편집 순수함수 입력 부담 완화). |

- 검증: `node --check web/app.js`·`web/core.js` 통과. `core.js` 순수함수 무변경(`hasPlate` 는 키 존재 판정이라 quad 무관).

## Phase 6 — @parkagent/types

| 파일 | 변경 |
|---|---|
| `packages/types/src/index.ts` | `ParkingSlot.plateRoiByPreset?: Record<string, NormalizedRect>` → `Record<string, NormalizedQuad>`(주석 갱신: OBB 4점·점순서·구데이터 승격). |

- **재빌드 불요**: 패키지 `exports` 가 `./src/index.ts` 를 직접 가리켜(빌드 스텝 없음) SettingAgent 가 즉시 참조. ActionAgent/DMAgent 는 TS 코드 부재라 즉시 영향 없음(설계서만).

## 하위호환(구데이터 폴백)

| 파일 | 변경 |
|---|---|
| `src/store/Repository.ts` | `loadArtifact` 가 `promotePlateRois` 로 구데이터 감지(`{x,y,w,h}` w키 존재=rect)→`rectToQuad` 승격(제자리). 배열(quad)이면 무변경. `rectToQuad` import. |
| `src/api/server.ts` | zod `plateRoiByPreset` 를 `union(NormalizedQuad, NormalizedRect)` 허용(구데이터 PUT 하위호환). `saveMappingHandler` 가 저장 전 rect→quad 정규화(저장은 항상 quad). `rectToQuad` import. |

## 설계서 §9 미기재였으나 PlateBox 변경으로 연쇄 수정된 production 파일 (편차 보고)

설계 §9 파일 목록에 없던 두 파일이 `PlateBox.rect`→`PlateBox.quad` 변경으로 컴파일 파손 → **설계 핵심 원칙(실 quad 보존·매칭은 boundingRect 유도)에 부합하게** 외과적 수정:

- `src/setup/plateMatch.ts` — `matchPlatesToSlots` 반환 `Map<number, NormalizedRect>` → `Map<number, NormalizedQuad>`. 매칭 math 는 `quadBoundingRect(plate.quad)` 로 수행, 저장은 실 `plate.quad`(방향 보존). (단발 셋업 경로도 quad 를 `plateRoiByPreset` 에 기록 → 신 타입 일관.)
- `src/setup/SetupOrchestrator.ts` — `detectPlates` 반환·`NormalizedRect` import → `NormalizedQuad`. L146 `slot.plateRoiByPreset={[key]:plate}` 의 `plate` 가 이제 quad.

> 사유: 이 경로도 `plateRoiByPreset`(신 quad 타입)를 채우므로 타입 정합상 필수. 캘리브레이션 경로와 동일하게 "매칭=boundingRect, 저장=실 quad". 설계 결함이라기보다 §9 파일 누락 → 리더/설계자 확인 권고(차단은 아님, 원칙 준수).

## 컴파일/구문 결과

- **Python**: `ast.parse` 3파일 OK. `sv.OrientedBoxAnnotator` export 확인.
- **TypeScript(src)**: `npm run typecheck` — **src/ 오류 0**. 남은 오류는 전부 `test/*.test.ts`(qa-tester 담당, PlateBox/AggregatedSlot mock shape 갱신 필요: `rect`→`quad`, `plateQuad` 필드 추가, plateRoiByPreset mock 을 quad 로).
- **web JS**: `node --check web/app.js`·`web/core.js` OK.
- **런타임 스모크**: geometry 순수함수(정규화·클램프·boundingRect·roundtrip·throw), SqliteStore(구DB 마이그레이션·quad 왕복·null) 모두 통과.

## qa-tester 인계 사항(테스트 수정 필요 지점)

테스트 파일은 생성 금지(qa 담당)라 미수정. 아래 mock shape 갱신 필요:
- `PlateBox` mock: `{rect:{...}}` → `{quad:[{x,y}×4]}`.
- `AggregatedSlot` mock: `plateQuad` 필드 추가(null 또는 quad).
- `plateRoiByPreset` mock: rect → quad(4점 배열).
- 신규 순수함수 테스트: `normalizeQuad`(정규화·클램프·throw), `quadBoundingRect`, `rectToQuad`(왕복), Aggregator 대표 quad 방향 보존, SqliteStore quad 왕복+구스키마 마이그레이션, Finalizer 실 quad·폴백, Repository 구데이터 rect→quad 승격, `slotPtzWriter.expandPlateTargets` quad→rect 유도, `pickNearestPlate` quad.

## 영향도 요약

- SettingAgent 캡처→집계→저장→최종화→캘리브레이션→뷰어 전 파이프라인 quad 관통. clustering/calibration 수치 로직 무변경(rect 유도 재사용).
- 회전 번호판 boundingRect 는 실폭보다 넓음 → `targetPlateWidth` 수렴 미세 편차(설계 §8 수용, 이번 범위 밖).
- ActionAgent 실시간 LPD 호출 구현 시 polygons 파싱 필요(설계서 갱신 권고, 코드 없음).
