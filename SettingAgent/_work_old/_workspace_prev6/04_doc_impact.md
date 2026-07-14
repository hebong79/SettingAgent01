# 04 영향도 분석 — LPD 번호판 rect → quad(OBB 4점) 전체 파이프라인

- 작성일시: 2026-07-01 20:21:13
- 작성자: 문서화·영향도 분석가 (documenter)
- 근거: 01~03 산출물 + 실제 변경 코드 실측(git status, grep, 소스 대조)
- 최종 문서: `SettingAgent/docs/20260701_202113_LPD번호판_rect→quad_OBB전체파이프라인.md`

---

## 1. plate quad 소비처 전수 (변경 전파 경로)

quad 는 다음 사슬을 관통한다. **각 접점의 shape·필드·좌표계는 검증자(03 §4)가 소스 동시 대조로 불일치 없음 확인.**

| # | 소비처(파일) | 입력 | 출력/저장 | 방향 |
|---|---|---|---|---|
| 1 | `src/clients/LpdClient.ts` `detectOnce` | HTTP `polygons`(픽셀 4점) | `PlateBox.quad`(정규화 NormalizedQuad) | 픽셀→정규화 1회 |
| 2 | `src/capture/CaptureJob.ts` | `PlateBox.quad` | `detection` 행: rect(=quadBoundingRect) **+ quad 동시** | rect+quad 병존 |
| 3 | `src/capture/SqliteStore.ts` | quad(8값) | `detection.px0..py3` / `aggregated_slot.plate_px0..plate_py3` | plate만, vehicle NULL |
| 4 | `src/capture/Aggregator.ts` | `Member{rect,quad?}` | `AggregatedSlot.plateQuad`(중심 최근접 멤버 quad, 부재 null) | 방향 보존 |
| 5 | `src/capture/Finalizer.ts` | `plateQuad` | `plateRoiByPreset[key] = plateQuad ?? rectToQuad(rect)` | 실 quad 우선 |
| 6 | `src/store/Repository.ts` | artifact(rect|quad) | 로드 시 rect→quad 승격 / 저장 | 구데이터 폴백 |
| 7 | `src/api/server.ts` | PUT(quad|rect) | zod union 허용 → 저장 전 quad 정규화 | 저장은 항상 quad |
| 8 | `src/calibrate/slotPtzWriter.ts` | quad | `plateRoi: quadBoundingRect(quad)` (rect) | quad→rect 유도 |
| 9 | `src/calibrate/controlMath.ts` `pickNearestPlate` | `PlateBox.quad` | `quadBoundingRect` 중심 최근접 | quad→rect 유도 |
| 10 | `src/calibrate/PtzCalibrator.ts` | `plate.quad` | `pr=quadBoundingRect` 1회 → centering/zoom/probe | quad→rect 유도, math 무변경 |
| 11 | `src/setup/plateMatch.ts` `matchPlatesToSlots` | `PlateBox.quad` | `Map<number, NormalizedQuad>` | 매칭=rect 유도, 저장=실 quad |
| 12 | `src/setup/SetupOrchestrator.ts` `detectPlates` | quad | `plateRoiByPreset[key]=plate`(quad) | 단발 셋업 경로 |
| 13 | `web/app.js` `drawRoiOverlay` | `plateRoiByPreset` quad | `toPixelQuad` → 폴리곤 stroke | 정규화→픽셀, 회전 렌더 |

- **rect 유도 접점(내부 계산 전용)**: #8~#11. 이 경로들의 zoom/centering/probe 수치 로직은 **무변경** — 관련 테스트(controlMath/ptzCalibrator/slotPtzWriter/plateMatch) 전부 통과. 회귀 없음.
- **방향 보존 접점**: #1~#7, #12, #13. 실 quad 를 저장·표시.

---

## 2. `@parkagent/types` 변경 재빌드 대상

- 변경: `packages/types/src/index.ts` — `ParkingSlot.plateRoiByPreset?: Record<string, NormalizedRect>` → `Record<string, NormalizedQuad>` (실측 L56 확인).
- **재빌드 불요**: 패키지 `exports` 가 `./src/index.ts` 를 직접 가리켜(빌드 스텝 없음) 소비자가 TypeScript 소스를 즉시 참조.
- **재컴파일/타입체크 영향 대상**:
  - **SettingAgent** — 직접 소비. typecheck 0 확인(03).
  - **ActionAgent / DMAgent** — 실측 결과 **TS/Python 코드 파일 0개**(빈 디렉토리, 설계서 md 만 존재). 따라서 **즉시 영향 없음**. `plateRoiByPreset` 을 소비하는 코드가 아직 없다.
- **주의**: 향후 ActionAgent/DMAgent 가 `ParkingSlot.plateRoiByPreset` 를 읽는 코드를 작성하면 quad(4점 배열) 타입으로 다뤄야 한다. rect 로 가정하면 컴파일 오류. 설계서 갱신 권고(이번 범위 밖).

---

## 3. 저장 스키마 마이그레이션 리스크 (구DB / 구 artifact)

### 3.1 SQLite (구DB)
- `detection` +8컬럼(`px0..py3`), `aggregated_slot` +8컬럼(`plate_px0..plate_py3`).
- **리스크**: 기존 파일 DB 는 CREATE 문으로 컬럼이 안 붙음 → `addColumnsIfMissing`(PRAGMA table_info → ALTER TABLE ADD COLUMN)이 최초 오픈 시 자동 실행. 누락 시 insert 바인딩 개수 불일치 런타임 오류.
- **완화**: 03 §3 케이스9 — 구스키마 파일 DB 최초 오픈 ALTER 마이그레이션 후 구행 quad `undefined`·크래시 없음·신규 왕복 검증됨. 테이블명 하드코딩(주입 무관).
- **롤백 관점**: ADD COLUMN 은 파괴적이지 않음(기존 컬럼 보존). 코드만 되돌리면 신 컬럼은 무시됨 → 하위호환.

### 3.2 setup_artifact.json (구 artifact) — **실제 파일이 아직 rect**
- **실측**: 현재 `SettingAgent/data/setup_artifact.json` 의 `plateRoiByPreset` 은 **rect 형태**(`{"x":..,"y":..,"w":..,"h":..}`). 즉 승격 경로는 가설이 아니라 **실 파일 최초 로드 시 반드시 실행**된다.
- **완화**: `Repository.loadArtifact()` 의 `promotePlateRois`(`'w' in v` 감지 → `rectToQuad`)가 유일 승격 지점. 03 §5·케이스11 로 검증. `server.ts` zod union 으로 PUT 도 하위호환.
- **리스크 잔존(확인 필요)**: artifact 를 `Repository.loadArtifact()` 를 **거치지 않고** raw JSON 으로 직접 읽어 `quadBoundingRect` 등에 넘기는 경로가 새로 생기면 `q.map is not a function` 크래시. 검증자가 `slotPtzWriter.test.ts` 에서 정확히 이 문제를 발견·교정(Repository 경로로 통일). **향후 신규 코드도 반드시 Repository 로드 경로를 경유해야 함** — 문서화 규약으로 명시.

---

## 4. Python 응답 계약 변경의 다른 소비자 영향 (grep 확인)

- 변경: `bboxes` 필드 **완전 제거** → `polygons` 신규. 이는 파괴적 계약 변경(구 클라이언트가 `bboxes` 를 읽으면 KeyError/undefined).
- **소비자 전수 조사(grep 실측)**:
  - `lpd/api/v1` / `imgupload` 를 호출하는 코드: `SettingAgent/src/config/toolsConfig.ts`(엔드포인트 설정), `SettingAgent/src/clients/LpdClient.ts`, 관련 테스트뿐. **SettingAgent 만이 유일 소비자.**
  - **ActionAgent / DMAgent**: `lpd|polygons|imgupload|bboxes|plate` grep 결과 **매칭 0**(코드 파일 자체가 없음). → 영향 없음.
  - `Sub/vpd_api` 는 별도 서비스(VPD)로 이번 LPD 계약과 무관.
- **결론**: LPD polygons 계약 변경의 실 소비자는 SettingAgent 단일. 이미 이번 변경에서 `polygons` 파싱으로 정합. **외부 파손 소비자 없음.**
- **주의**: da_lpd_api 를 다른 도구(Postman/외부 스크립트 등)로 직접 호출하던 운영 관행이 있다면 `bboxes` 제거로 파손 — **확인 필요**(코드 레포 밖 사용처는 grep 범위 밖).

---

## 5. 캘리브레이션 정확도 (유도 rect) 주의

- `plateRoi` 는 quad→`quadBoundingRect` 유도 rect. 회전 번호판의 boundingRect 는 실 번호판보다 폭이 넓다 → `targetPlateWidth` 수렴점 미세 편차(설계 §8 수용).
- zoom/centering math 자체는 무변경 → 기능 회귀는 없음. 다만 **회전이 큰 번호판일수록 유도 rect 폭 과대 → zoom 이 약간 넓게 수렴**할 수 있음(정성적). 실 캘리브 정합은 §수동확인 4로 육안 확인 권고.

---

## 6. 롤백 시 고려사항

| 항목 | 롤백 영향 |
|---|---|
| Python `polygons`→`bboxes` 되돌림 | SettingAgent LpdClient 도 함께 되돌려야 계약 정합(둘은 한 쌍). 부분 롤백 금지. |
| SQLite quad 컬럼 | ADD COLUMN 은 비파괴적. 코드 롤백 시 신 컬럼 무시됨(데이터 잔존 무해). 스키마 다운마이그레이션 불필요. |
| setup_artifact quad→rect | **주의**: 신 코드가 quad 로 저장한 artifact 를 구 코드가 로드하면 rect 를 기대 → 배열(quad) 만나 파손 가능. 롤백 전 artifact 백업/변환 필요. |
| `@parkagent/types` | 소스 직접 참조라 즉시 반영. 롤백도 즉시. |
| 뷰어 `app.js` | quad artifact 를 구 `strokeRect` 로 그리면 폴리곤 미표시(무해하나 시각 회귀). |

- **핵심**: Python 계약 ↔ LpdClient, setup_artifact quad ↔ Repository/뷰어 는 **쌍으로 롤백**해야 안전. SQLite 는 단독 롤백 무해.

---

## 7. 무변경(의도적) 및 확인 필요 항목

### 무변경(의도)
- `calibrate/types.ts`(`plateRoi: NormalizedRect` 유지 — writer 가 유도), `core.js`(toPixelQuad 재사용), zoom/centering/probe 수치 math.

### 확인 필요 (단정 회피)
- **[확인 필요]** Python OBB 실런타임 — `results.obb.xyxyxyxy` 가 실제 4점을 채우는지(YOLO 실행 미수행, 03 §6-1·2 수동).
- **[확인 필요]** 뷰어 회전 폴리곤 실렌더·실 번호판 기울기 정합(03 §6-3·4 수동).
- **[확인 필요]** 실 da_lpd_api REST 왕복 스모크(03 §6-5, fetch 모킹만 수행).
- **[확인 필요]** 코드 레포 밖에서 da_lpd_api `bboxes` 를 직접 소비하던 운영 관행 유무(grep 범위 밖).
- **[확인 필요]** artifact 를 Repository 로드 경로 우회하여 직접 읽는 신규 코드가 추가되지 않도록 규약 유지(승격 지점 단일화).

---

## 8. 영향 파일 요약 (실측)

- **Python(4)**: `Sub/lpd_api/routers/yolo.py`, `detectors/yolov8.py`, `schemas/yolo.py`, `README.md`.
- **TS 프로덕션(14)**: `clients/LpdClient.ts`, `domain/geometry.ts`(+3함수), `capture/{types,CaptureJob,Aggregator,SqliteStore,Finalizer}.ts`, `store/Repository.ts`, `api/server.ts`, `calibrate/{slotPtzWriter,controlMath,PtzCalibrator}.ts`, `setup/{plateMatch,SetupOrchestrator}.ts`.
- **공유 타입(1)**: `packages/types/src/index.ts`.
- **뷰어(2)**: `web/app.js`, `web/core.d.ts`.
- **테스트**: 신규 2(`lpdClient`, `repository`), 갱신 13.
- **즉시 영향 없음**: ActionAgent/DMAgent(코드 파일 0), `Sub/vpd_api`(무관), `calibrate/types.ts`/`core.js`(무변경).
