# 03 QA 검증 보고 — LPD rect→quad(OBB 4점) 전체 파이프라인

검증자(qa-tester). 대상: 설계서 `01_architect_plan.md` §7 유닛테스트 케이스 1~12, 구현 인계 `02_developer_changes.md`.
결론: **전체 통과. src typecheck 0. 구현 버그 없음(구현이 설계 계약에 부합) — 테스트를 신 quad 계약에 맞춰 갱신·추가함.**

## 1. 실행 명령 / 결과

| 명령 | 결과 |
|---|---|
| `npm run typecheck` (tsc --noEmit, src+test) | **오류 0** (갱신 전 test/* 22건 오류 → 갱신 후 0) |
| `npx vitest run` (전체) | **Test Files 58 passed (58) / Tests 453 passed (453)** — 실패 0 |
| `node --check web/app.js`·`web/core.js` | OK |

- 시작 상태: test/* 22개 타입오류(PlateBox.rect→quad, plateRoiByPreset rect→quad, AggregatedSlot.plateQuad 누락). src 는 이미 0.
- 최종: 갱신+신규 케이스 반영 후 typecheck 0, vitest 453/453.

## 2. 갱신한 기존 테스트(mock shape 신 quad 계약으로)

| 파일 | 갱신 내용 |
|---|---|
| `test/geometry.test.ts` | (아래 신규 케이스 참조. 기존 median/normalizeBox 등은 무변경) |
| `test/sqliteStore.test.ts` | `aggSlot` 헬퍼에 `plateQuad: null` 추가. 왕복 `toEqual(slot)` 은 plateQuad:null 포함 정상. |
| `test/aggregator.test.ts` | `NormalizedQuad` import. (기존 plate 귀속/클러스터 케이스 무변경) |
| `test/controlMath.test.ts` | `plate()` mock `rect`→`quad: rectToQuad(rect)`. `pickNearestPlate` 결과를 `quadBoundingRect(got.quad)` 로 위치 검증. |
| `test/ptzCalibrator.test.ts` | artifact plateRoiByPreset rect→`rectToQuad`, 3개 PlateBox mock `rect`→`quad`. |
| `test/calibrateRoutes.test.ts` | artifact plateRoiByPreset rect→`rectToQuad`, fakeLpd PlateBox `rect`→`quad`. |
| `test/plateMatch.test.ts` | `plate()` mock `rect`→`quad`. 반환 타입 `Map<number,NormalizedQuad>` 에 맞춰 `.get(k)` 검증을 quad 동등 + `quadBoundingRect` 유도로 변경. |
| `test/slotPtzWriter.test.ts` | plateRoiByPreset fixture `rect`→`pquad(=rectToQuad)`. 실 파일 테스트를 **Repository.loadArtifact() 경로**로 로드(하위호환 승격 — §3 참조). |
| `test/setupOrchestrator.test.ts` | PlateBox mock `rect`→`quad`, 저장 검증 `plateRoiByPreset` 을 `rectToQuad(...)` 로. |
| `test/captureRoutes.test.ts` | 인라인 AggregatedSlot 에 `plateQuad: null` 추가. |
| `test/checkpointFinalizer.test.ts` | `slot()` 헬퍼에 `plateQuad: null` 추가. |
| `test/floorRoiReviewer.test.ts` | `slot()` 헬퍼에 `plateQuad: null` 추가. |
| `test/captureJob.test.ts` | LPD mock `rect`→회전 `quad`. plate 행에 **rect(boundingRect)+quad 동시 저장** 강화 검증(케이스 7). |

## 3. 추가한 신규 케이스(설계 §7 케이스 1~12)

| 케이스 | 파일 | 검증 요지 |
|---|---|---|
| 1 normalizeQuad | `geometry.test.ts` | 1920×1080 픽셀 4점 → 0~1 정규화·**점순서(TL→TR→BR→BL) 보존**, 회전 quad 축정렬로 안 뭉개짐, 경계초과 클램프, 길이≠4 throw. |
| 2 quadBoundingRect | `geometry.test.ts` | 회전 quad → min/max 축정렬 rect; 축정렬 quad → 동일 rect(정보 손실 없음). |
| 3 rectToQuad | `geometry.test.ts` | rect→TL,TR,BR,BL; `quadBoundingRect(rectToQuad(r))==r` 왕복 항등. |
| 4 LpdClient.detect | `lpdClient.test.ts`(신규) | polygons mock(fetch 스텁) → PlateBox.quad N개·정규화(축정렬·회전 둘 다), `polygons:[]`→[], confidences/classes 폴백, polygon 점≠4 → throw. |
| 5 pickNearestPlate | `controlMath.test.ts` | quad PlateBox 최근접 선택(boundingRect 중심), 빈→null. |
| 6 plateCenterError | `controlMath.test.ts` | (기존 유지 — boundingRect 입력) |
| 7 CaptureJob detect | `captureJob.test.ts` | LPD 회전 quad → detection 에 **rect=quad boundingRect + quad 동시** 저장 검증. |
| 8 Aggregator 대표 quad | `aggregator.test.ts` | 회전 quad 멤버→대표 quad **방향 보존(축정렬 아님)**; **중심 최근접 멤버** 채택(이상치 무시); plate 없음→null; quad 부재 멤버만(구DB)→rect 매칭돼도 plateQuad=null. |
| 9 SqliteStore quad 왕복 | `sqliteStore.test.ts` | detection/aggregated_slot quad 8값 insert→get 일치; vehicle quad undefined; **구스키마(quad 컬럼 없는 파일 DB) 최초 오픈 ALTER 마이그레이션**→구행 quad undefined·크래시 없음·신규 insert 왕복. |
| 10 Finalizer | `finalizerFloor.test.ts` | plateRoiByPreset=**실 대표 quad**(방향 보존); quad 부재→`rectToQuad(rect)` 폴백; plate 부재→미부여. |
| 11 Repository 승격 | `repository.test.ts`(신규) | 구데이터 rect plateRoiByPreset JSON → loadArtifact 후 축정렬 quad(크래시 없음); 신 quad 무변경; 부재 슬롯/파일 없음 방어. |
| 12 slotPtzWriter.expand | `slotPtzWriter.test.ts` | quad plateRoiByPreset → plateRoi(축정렬 rect) 유도(quadBoundingRect). |

신규 파일 2개: `test/lpdClient.test.ts`, `test/repository.test.ts`.

## 4. 경계면 교차 비교(shape·좌표계·필드명 정합)

전 파이프라인을 소스 동시 대조로 확인 — **불일치 없음**:

```
LpdClient.PlateBox.quad (NormalizedQuad=[{x,y}×4], 정규화, TL→TR→BR→BL)
  → CaptureJob: quadBoundingRect(p.quad)→rect(x,y,w,h) + quad 동시 → insertDetections
  → SqliteStore.detection: px0,py0..px3,py3 (REAL, plate만; vehicle NULL)
       getDetectionsForRun → DetectionRow.quad (하나라도 NULL→undefined)
  → Aggregator: 대표 rect 중심 최근접 멤버 quad → AggregatedSlot.plateQuad (부재 null)
  → SqliteStore.aggregated_slot: plate_px0..plate_py3
  → Finalizer: m.plateQuad ?? rectToQuad(rect) → ParkingSlot.plateRoiByPreset[key]=quad
  → Repository.saveArtifact/loadArtifact(구 rect 감지→rectToQuad 승격)
  → web/app.js drawRoiOverlay: toPixelQuad(pquad)= quad.map(p=>({px:p.x*W,py:p.y*H}))
```

- 필드명: DB 컬럼 `px0..py3`/`plate_px0..plate_py3` ↔ `quadFromCols` 복원 ↔ `NormalizedQuad` 인덱스 [0..3] 일치.
- 좌표계: 전 구간 정규화(0~1). 픽셀→정규화는 LpdClient(readJpegSize) 1회만. 뷰어에서 다시 ×W/×H.
- 점 순서: ultralytics 규약 재정렬 없음(정규화만). min/max·폴리곤 렌더 모두 순서 불변 — 저위험 확인.
- calibration 내부(pickNearestPlate/PtzCalibrator/slotPtzWriter): 전부 `quadBoundingRect(quad)` 유도 rect 사용 → 기존 zoom/centering math 무변경(회귀 없음, 관련 테스트 전부 통과).

## 5. 발견 이슈 / 판단

- **테스트가 프로덕션 경로를 우회하던 문제(수정함, 구현 버그 아님)**: `slotPtzWriter.test.ts` 의 "실 setup_artifact.json" 케이스가 raw JSON 을 직접 읽어 `expandPlateTargets` 에 넘겼는데, 실 파일(`data/setup_artifact.json`)의 plateRoiByPreset 은 아직 **구 rect 형태**라 `quadBoundingRect(quad)` 가 `q.map is not a function` 으로 크래시했다. 프로덕션 경로(`PtzCalibrator`)는 `Repository.loadArtifact()`(rect→quad 승격) 후 expand 하므로 안전. 테스트를 동일 경로(Repository 로드)로 교정 → 하위호환 승격의 실 파일 회귀까지 겸함. **구현 결함 아님(설계 §3 의도대로 승격 지점은 Repository).**
- 그 외 실패는 모두 부동소수 오차(`0.05→0.05000000000000002`)로 인한 `toEqual` 엄격비교 → `toBeCloseTo`/근사 비교로 교정. 구현 수치 정확.
- **developer5 보고/수정요청 없음** — 구현이 설계 계약에 부합.

## 6. 수동 확인 항목(유닛 대상 아님 — 통과 위장 금지, 미수행으로 명시)

Python `Sub/lpd_api` 는 pytest 부재·YOLO 실행 환경 필요로 vitest 범위 밖. 아래는 **미검증**이며 수동 확인 필요:

1. **OBB 응답 polygons 형식**: OBB 모델(`yolov11l_obb_lpd.pt`)에 실이미지 POST → 응답에 `polygons`(검출별 4×[x,y] 픽셀) 존재·`bboxes` 키 부재. 검출0 이미지 → `polygons:[]`, `success:false`. (curl + 스키마 육안)
2. **routers task 버그 수정 실효**: `task="detect"`→`"obb"` 미적용 시 `results.obb` None → 항상 빈 polygons. 실호출로 4점 반환 확인 필요.
3. **뷰어 폴리곤 렌더**: 브라우저에서 plate 오버레이(`#ffd60a`)가 **회전 폴리곤**으로 그려지는지(축정렬 사각형이 아님). Play 상응 육안.
4. **실 회전 표시 정합**: 실 캘리브레이션 후 `plateRoiByPreset` quad 가 실제 번호판 기울기와 시각적으로 일치하는지.
5. **실 연동 스모크**(LPD REST 실가동): 유닛은 fetch 모킹만 수행 — 실 da_lpd_api 왕복 스모크는 미수행.

## 7. 산출물

- 신규 테스트: `test/lpdClient.test.ts`, `test/repository.test.ts`.
- 갱신 테스트: geometry, sqliteStore, aggregator, controlMath, ptzCalibrator, calibrateRoutes, plateMatch, slotPtzWriter, setupOrchestrator, captureRoutes, checkpointFinalizer, floorRoiReviewer, captureJob (13개).
- 본 보고서: `SettingAgent/_workspace/03_qa_report.md`.
