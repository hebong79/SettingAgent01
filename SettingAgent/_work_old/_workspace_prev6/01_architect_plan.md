# LPD rect → quad(OBB 4점) 전체 파이프라인 설계서

작성: 설계자 / 대상: lpd_api(Python) + SettingAgent(TS). 사용자 확정 결정 4항 반영.

## 0. 확정 사실(코드 실측)
- 가중치: `Sub/lpd_api/weights/yolov11l_obb_lpd.pt` = **OBB 모델**. 그러나 `routers/yolo.py:30` 은 `task="detect"` 로 로드 → **`task="obb"` 로 수정 필요**(현재 OBB 미활성 버그).
- ultralytics **8.3.99**: `results.obb.xyxyxyxy` → 텐서 `(N,4,2)` 픽셀 4점. `.xyxyxyxyn` = 정규화. 점 순서 규약 = **top-left 시작, 시계방향(TL→TR→BR→BL)**(results.py:1774 docstring 확인).
- supervision **0.25.1** `from_ultralytics`: `results.obb` 존재 시 `detections.data["xyxyxyxy"]`(=`ORIENTED_BOX_COORDINATES`) 에 `(N,4,2)` 저장. 단, **직접 `results.obb.xyxyxyxy` 접근이 더 명확** → 그 경로 채택.
- ActionAgent/DMAgent 는 **TS 코드 미존재**(설계서 md만). SettingAgent 만 plate rect 를 저장·소비. 영향도 §9 참조.
- 기존 저장 데이터: `data/setup_artifact.json`(plateRoiByPreset: rect), SQLite `detection`/`aggregated_slot`(plate rect 컬럼) 존재 → **하위호환 필수**.

## 1. polygons 응답 형식(확정)
`ImageAnalysisResponse` 신형:
```
{ success: bool, id: int,
  polygons: List[List[List[float]]],   # 검출별 4×[x,y] 픽셀점. 예: [[[x0,y0],[x1,y1],[x2,y2],[x3,y3]], ...]
  confidences: List[float],
  classes: List[str] }
```
- `bboxes` **완전 제거**(결정2). 점 순서 = ultralytics 규약 TL→TR→BR→BL 그대로 전달(변환 안 함, TS 측이 규약을 안다).
- 픽셀 좌표(정규화 아님) — TS 가 `readJpegSize` 로 정규화(기존 VPD 패턴과 일관).

## 2. 정규화 quad / quadBoundingRect 알고리즘(순수·테스트 대상)
TS `domain/geometry.ts` 에 신규 순수함수 2개:
```ts
// 픽셀 4점 → 정규화 NormalizedQuad(0~1 클램프). 점 순서 보존.
export function normalizeQuad(pts: [number,number][], imgW: number, imgH: number): NormalizedQuad
//   각 점 { x: clamp01(px/imgW), y: clamp01(py/imgH) }. 길이!=4 방어(throw).

// quad → 축정렬 bounding rect(min/max). 캘리브레이션·집계용.
export function quadBoundingRect(q: NormalizedQuad): NormalizedRect
//   x=min(xi), y=min(yi), w=max(xi)-x, h=max(yi)-y.

// rect → 축정렬 quad(하위호환 승격). TL,TR,BR,BL.
export function rectToQuad(r: NormalizedRect): NormalizedQuad
//   [{x,y},{x+w,y},{x+w,y+h},{x,y+h}]
```
- **plateWidth 정의**: `quadBoundingRect(quad).w`(bounding box 폭). 결정4 = quad→rect 유도해 기존 zoom/centering math 재사용.

## 3. quad 보존 정책 + 하위호환(개정 — OBB 방향 유지)
> **리더 개정**: 집계 단계에서 실제 OBB quad 방향을 소실하면 안 됨(뷰어에 회전 폴리곤을 그려야 함). clustering/calibration 은 rect 유지하되, **실 quad(4점)를 집계~setup_artifact 까지 함께 보존**한다. rectToQuad 승격은 quad 부재(구데이터/폴백) 시에만.

- **데이터 흐름(확정)**: LPD OBB 4점 → LpdClient 정규화 quad → 집계(rect 산출 **+ 대표 quad 보존**) → DB(quad 컬럼 추가) → Finalizer(**실 대표 quad** 기록) → setup_artifact(quad) → 뷰어(폴리곤). calibration 은 `quadBoundingRect(quad)` 로 rect 유도해 기존 math 재사용.
- **SQLite 스키마 확장**(핵심):
  - `detection`: 기존 `x,y,w,h`(rect=boundingRect) **유지**(clustering·calibration 입력). 여기에 plate 행용 quad 8값 컬럼 추가 `px0,py0,px1,py1,px2,py2,px3,py3`(REAL, nullable — vehicle 행은 NULL). rect·quad 동시 저장.
  - `aggregated_slot`: 기존 `plate_x/y/w/h`(rect 대표) **유지** + 대표 quad 8값 컬럼 `plate_px0..plate_py3`(REAL, nullable — plate 없으면 NULL).
  - **마이그레이션**: `CREATE TABLE IF NOT EXISTS` 는 기존 파일 DB 에 신컬럼을 못 붙임. `ensureSchema` 에서 `pragma table_info(...)` 로 컬럼 존재 확인 후 없으면 `ALTER TABLE ADD COLUMN`(better-sqlite3 는 `ADD COLUMN IF NOT EXISTS` 미지원 → 존재검사 방식). 구 DB 는 quad 컬럼 NULL → 읽기 시 `rectToQuad(rect)` 폴백.
- **setup_artifact.json**: `plateRoiByPreset` 타입 `Record<string,NormalizedQuad>`. **Repository.loadArtifact() 읽기 시 rect 형태 감지→rectToQuad 승격**(구데이터 폴백). 감지: 값이 `{x,y,w,h}`(w키 존재)면 rect, 4원소 배열이면 quad. server.ts zod 스키마 **union(rect|quad) 허용** 후 로드 시 정규화. 저장(PUT/mapping)은 항상 quad.
- **경계**: quad 는 (a)lpd_api (b)LpdClient (c)detection/aggregated_slot 의 quad 컬럼 (d)setup_artifact (e)뷰어 에 흐른다. clustering·calibration **내부 계산**만 rect(boundingRect). rect-only 구데이터·plate 부재는 어디서든 rectToQuad 폴백.

## 4. 단계(phase) 분할 + 검증 지점

### Phase 1 — Python lpd_api (polygons 반환)
- `routers/yolo.py:30` `task="detect"`→`task="obb"`. 예제 docstring bboxes→polygons.
- `routers/yolo.py:82-99` `frame, bboxes,... = await dt()` → `frame, polygons, confidences, classes`. 응답 `bboxes=`→`polygons=`. `if polygons:` 성공.
- `schemas/yolo.py` `bboxes: List[List[float]]` → `polygons: List[List[List[float]]]`.
- `detectors/yolov8.py:53-71 plot_boxes`: `detections.xyxy.tolist()` 제거 → `results.obb.xyxyxyxy` 사용.
  ```py
  obb = getattr(results, "obb", None)
  if obb is None or obb.xyxyxyxy is None or len(obb.xyxyxyxy) == 0:
      return frame, [], [], []        # 0건/비OBB 방어
  polygons = obb.xyxyxyxy.cpu().numpy().tolist()   # (N,4,2)→중첩 리스트
  confidences = obb.conf.cpu().numpy().tolist()
  classes = [self.classes[int(c)] for c in obb.cls.cpu().numpy()]
  ```
  annotate 는 supervision `from_ultralytics(results)`(OBB 지원) 유지하거나 생략 가능(주석이미지 부차). `plot_boxes` 반환 시그니처는 동일 4-튜플.
- **검증**: (a) OBB 모델에 실이미지 POST → `polygons` 4점 N개·`bboxes` 키 부재. (b) 검출0 이미지 → `polygons: []`, `success:false`. (수동 curl + pytest 있으면 스키마 assert)

### Phase 2 — TS 파싱/타입 (LpdClient)
- `LpdResponse`: `bboxes`→`polygons: number[][][]`.
- `PlateBox` 재정의: `VehicleBox` 별칭 폐기 → `export interface PlateBox { quad: NormalizedQuad; confidence: number; cls: string }`.
- `detectOnce`: `body.polygons.map((poly,i)=>({ quad: normalizeQuad(poly, imgW, imgH), confidence: confs[i]??1, cls: ... }))`. `normalizeBox` import 제거, `normalizeQuad` import.
- **검증**: `lpdClient.test.ts`(신규) — polygons mock fetch → PlateBox.quad 정규화·개수. 4점≠길이 방어.

### Phase 3 — 집계/저장/스키마(quad 보존)
- `capture/types.ts`:
  - `DetectionRow` 에 `quad?: NormalizedQuad`(plate 만) 추가. `insertDetections` 입력 shape 에 `quad?` 추가.
  - `AggregatedSlot` 에 `plateQuad: NormalizedQuad | null` 추가(기존 plateX/Y/W/H 유지).
- `CaptureJob.ts:253-255`: `const br = quadBoundingRect(p.quad); dets.push({kind:'plate', x:br.x,y:br.y,w:br.w,h:br.h, conf:p.confidence, quad:p.quad})`. rect(집계용)+quad(보존) 동시.
- `SqliteStore.ts`:
  - `ensureSchema`: detection 에 `px0..py3` 8컬럼, aggregated_slot 에 `plate_px0..plate_py3` 8컬럼 추가 + **기존 DB 마이그레이션(pragma table_info→ADD COLUMN)**.
  - `insertDetections`: plate 행이면 quad 8값 바인딩(vehicle NULL).
  - `getDetectionsForRun`: quad 8컬럼 SELECT → `quad`(NULL 이면 undefined). Aggregator 입력.
  - `replaceAggregatedSlots`/`getAggregatedSlots`: `plate_px0..py3` 바인딩·복원(`plateQuad` NULL 처리).
- `Aggregator.ts`: plate 클러스터 대표 rect(기존 `medianRect`) **유지**. + **대표 quad 선정**: 매칭된 plate 클러스터에서 **대표 rect 중심에 가장 가까운 멤버 검출의 quad**를 대표로 채택(회전 보존·이상치 강건. 4점 평균은 대각선 뒤틀림 위험이라 배제). 매칭 성공 시 `plateQuad`, 실패/quad 부재 시 `null`. `Cluster.members` 를 rect 뿐 아니라 `{rect, quad?}` 로 보강 필요.
- `Finalizer.ts:185-186`: `m.plateQuad ?? (rect 있으면 rectToQuad(rect))` → `plateRoiByPreset = { [key]: quad }`. **실 대표 quad 우선**, 부재 시 rectToQuad 폴백.
- **검증**: Aggregator 테스트 — 회전 quad 입력 시 대표 quad 방향 보존(축정렬 아님); plate 없으면 plateQuad=null. SqliteStore 왕복(quad 저장·복원, 구스키마 마이그레이션). Finalizer plateRoiByPreset=실 quad. CaptureJob detect rect+quad 동시 저장.

### Phase 4 — 캘리브레이션 유도(rect 재사용, 결정4)
- `calibrate/types.ts`: `PlateTarget.plateRoi: NormalizedRect` **유지**(prior 는 rect). slotPtzWriter 가 quad→rect 유도해 채움.
- `slotPtzWriter.ts:21` `for (const [key, rect] of Object.entries(slot.plateRoiByPreset))` → 값이 quad → `plateRoi: quadBoundingRect(quad)`.
- `controlMath.pickNearestPlate(plates: PlateBox[], target)`: PlateBox.quad → 내부에서 `quadBoundingRect(p.quad)` 로 중심 계산. 반환은 PlateBox(quad 보유).
- `PtzCalibrator.calibrateSlot`: `plate.rect.w`→`quadBoundingRect(plate.quad).w`(plateWidth), `plateCenterError(plate.rect)`→`plateCenterError(quadBoundingRect(plate.quad))`. 헬퍼로 `const pr = quadBoundingRect(plate.quad)` 1회 계산 후 재사용(중복 유도 최소화).
- `SlotPtzItem.plateWidth`(bounding box 폭) 정의 유지. zoom/centering math **무변경**.
- **검증**: `controlMath.test.ts`/`ptzCalibrator.test.ts` — PlateBox mock 을 quad 로. pickNearestPlate 최근접·plateCenterError 값 boundingRect 기준 일치.

### Phase 5 — 뷰어 렌더(quad 폴리곤)
- `core.d.ts:118`: `plateRoiByPreset?: Record<string, NormalizedRect>` → `NormalizedQuad`.
- `app.js:185-190 drawRoiOverlay` plate 섹션: `toPixel`+`strokeRect` → **floor 패턴 재사용**(app.js:192-202): `toPixelQuad(pquad,...)` → beginPath/lineTo/closePath/stroke. 색 `#ffd60a` 유지, 채움 없음(가늘게).
- `core.js`: 신규 순수함수 불요(toPixelQuad 재사용). `buildMappingSummary`(core.js:193) `hasPlate` 판정 무변경(키 존재 여부).
- **검증**: 수동 뷰어 표시(Play 상응) — plate 오버레이가 회전 폴리곤으로 렌더. core 순수함수 회귀(기존 core 테스트 통과).

## 5. quad→rect 유도 접점(정리)
| 위치 | 기존 | 신규 |
|---|---|---|
| LpdClient.detectOnce | rect 파싱 | quad 파싱 |
| CaptureJob detect | p.rect → DB | **rect(=boundingRect) + quad 동시** → DB |
| Aggregator plate | rect 대표만 | rect 대표 **+ 대표 quad(중심최근접 멤버)** |
| slotPtzWriter expand | plateRoiByPreset[key](rect) | quadBoundingRect(quad) → plateRoi(rect) |
| controlMath pickNearestPlate/centerError | p.rect | quadBoundingRect(p.quad) |
| Finalizer 산출 | rect → plateRoiByPreset | **실 대표 quad** 우선, 부재 시 rectToQuad 폴백 |
| Repository.loadArtifact | - | rect 값 감지 시 rectToQuad 승격(구데이터) |

## 6. @parkagent/types 변경
- `NormalizedRect`/`NormalizedQuad`/`NormalizedPoint` **기존 정의 재사용**(추가 타입 불요).
- `ParkingSlot.plateRoiByPreset?: Record<string, NormalizedRect>` → `Record<string, NormalizedQuad>` (index.ts:55, 주석 갱신).
- 재컴파일 대상: `@parkagent/types` → SettingAgent(참조). ActionAgent/DMAgent TS 미존재라 즉시 영향 없음(설계서만).

## 7. 유닛테스트 케이스 목록(검증 가능)
1. `normalizeQuad`: 픽셀 4점(1920×1080) → 0~1 정규화·점순서 보존; 경계초과 클램프; 길이≠4 throw.
2. `quadBoundingRect`: 회전 quad → min/max rect; 축정렬 quad → 동일 rect.
3. `rectToQuad`: rect → TL,TR,BR,BL 4점; quadBoundingRect(rectToQuad(r))==r(왕복).
4. `LpdClient.detect`: polygons mock → PlateBox.quad N개·정규화; polygons:[] → [].
5. `pickNearestPlate`(quad PlateBox): target rect 최근접 quad 선택; 빈 → null.
6. `plateCenterError`(boundingRect): quad 중심 오차값.
7. `CaptureJob` detect: LPD quad → detection 에 rect(boundingRect) **+ quad 동시** 저장.
8. **Aggregator 대표 quad 보존/방향 유지**: 회전 quad 멤버 입력 → 대표 quad 가 축정렬 아님(방향 보존), 중심 최근접 멤버 채택; plate 없으면 plateQuad=null.
9. **SqliteStore quad 왕복**: insert→get quad 8값 일치; **구스키마(quad 컬럼 없는 DB) 마이그레이션** 후 read 시 quad NULL→정상.
10. `Finalizer`: plateRoiByPreset 값이 **실 대표 quad**(방향 보존); plateQuad 부재 시 rectToQuad 폴백 quad.
11. **구데이터 rect→quad 폴백**: `Repository.loadArtifact` 가 rect plateRoiByPreset JSON → 로드 후 축정렬 quad(크래시 없음).
12. `slotPtzWriter.expandPlateTargets`: quad plateRoiByPreset → plateRoi(rect) 유도.
13. (Python, 있으면) 스키마 assert: 응답에 `polygons` 존재·`bboxes` 부재.

## 8. 리스크
- **OBB 점 순서/좌표계**: ultralytics TL→시계방향. 정규화만 하고 재정렬 안 함 → 뷰어·bounding 계산 순서 무관(min/max, 폴리곤 렌더 모두 순서 불변). 저위험.
- **캘리브레이션 정확도(유도 rect)**: 회전 번호판의 boundingRect 는 실제보다 폭이 큼 → targetPlateWidth 수렴점 미세 편차. 결정4 채택(안전 우선)이므로 수용. 필요 시 후속에서 quad 실폭(변 길이) 도입 여지 — 이번 범위 밖(단순함 우선).
- **스키마 마이그레이션(신규 quad 컬럼)**: 기존 파일 DB 에 8+8 컬럼 ADD COLUMN 필요 → pragma table_info 존재검사 후 ADD. 누락 시 insert 바인딩 개수 불일치로 런타임 오류 → **테스트9(구스키마 마이그레이션) 필수**. setup_artifact zod union 누락 시 기존 rect JSON 로드 실패 → **테스트11 필수**.
- **대표 quad 선정**: 4점 평균은 대각 뒤틀림 위험 → 중심 최근접 멤버 quad 채택(방향 보존·강건). 클러스터에 quad 부재 멤버 섞이면 rect 매칭은 되나 quad 없을 수 있음 → plateQuad=null → Finalizer 폴백.
- **routers task 버그**: `task="detect"` 미수정 시 `results.obb` None → 항상 빈 polygons. Phase1 최우선.

## 9. 영향도
- 수정 파일: [Py] routers/yolo.py, schemas/yolo.py, detectors/yolov8.py, API_RESPONSE_EXAMPLES.md. [TS] clients/LpdClient.ts, domain/geometry.ts(+3함수), capture/types.ts(DetectionRow.quad·AggregatedSlot.plateQuad), capture/CaptureJob.ts, capture/Aggregator.ts(대표 quad 선정), capture/SqliteStore.ts(quad 컬럼+마이그레이션), capture/Finalizer.ts, store/Repository.ts(승격), calibrate/slotPtzWriter.ts, calibrate/controlMath.ts, calibrate/PtzCalibrator.ts, api/server.ts(zod union), web/app.js, web/core.d.ts, packages/types/src/index.ts.
- 무변경(의도적): calibrate/types.ts(plateRoi rect 유지 — quadBoundingRect 유도), core.js(toPixelQuad 재사용).
- ActionAgent: 향후 LPD 실시간 호출부 구현 시 polygons 파싱 필요(설계서 갱신 권고 — 이번 범위 밖, 코드 없음).

## 10. 리더 확인 결과(반영 완료)
1. **[개정 완료]** quad 를 집계~setup_artifact 까지 **실좌표 보존**(DB quad 컬럼 추가, Aggregator 대표 quad, Finalizer 실 quad 기록). rectToQuad 는 구데이터/폴백 전용. §3·Phase3 반영.
2. **[승인]** OBB 점 순서 재정렬 안 함(ultralytics TL-시계 그대로). plate 는 자체 규약, 문서 명기.
3. **[승인]** routers `task="detect"`→`"obb"` 수정 포함.
4. **[승인]** Python Phase1 검증은 수동 curl + 스키마 육안(TS 는 vitest 필수).

### 남은 경미 판단(구현자 재량, 차단 아님)
- 대표 quad 선정 = **중심 최근접 멤버 quad**(4점 평균 배제). 이견 시 리더 통지.
