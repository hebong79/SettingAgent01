# 02. 구현 — VPD 검출 모드 2종(주차면 위 차량만 / 모든 차량)

계획서 `01_architect_plan.md` §10 실행 순서 그대로 구현. 리더 확정사항(Q1 범위 밖 / Q2 체크박스 공용) 준수.

---

## 1. 변경/신규 파일 목록

| 파일 | 신규/수정 | 한 일 |
|---|---|---|
| `src/capture/onPlaceFilter.ts` | **신규(50줄)** | 순수 필터. `GROUND_BAND_RATIO=0.25`, `ON_PLACE_MIN_OVERLAP=0.15` (모듈 named const — tools.config 미승격). `groundBand()` / `isVehicleOnPlace()` / `filterVehiclesOnPlace<T extends {rect}>()`. 기하는 **전부 재사용**(`polygon.ts` 의 `rectCorners`·`convexIntersectionArea`, `geometry.ts` 의 `area`) — 신규 기하 0줄. |
| `src/capture/types.ts` | 수정 | `CaptureStatus` 에 `vpdOnParkingOnly?` / `vpdFilteredOut?` / `vpdOnPlaceDegraded?` 3필드 가산(전부 옵셔널 → 기존 응답 회귀 0). |
| `src/capture/CaptureJob.ts` | 수정 | `CaptureJobDeps.placeRoiFile?`, `CaptureStartParams.vpdOnParkingOnly?` 추가. 필드 5개(`vpdOnParkingOnly`/`placePromise`/`vpdFilteredOut`/`onPlaceDegraded`/`degradeWarned`). `start()` 에서 모드 고정(`?? true`) + 카운터 초기화 + `loadNormalizedPlaceRoi()` **run 시작 시 1회 로드**(뷰어에서 편집·저장한 최신 ROI 반영). `captureTarget()` 에서 `vpd.detect()` 직후 필터(private `applyOnPlaceFilter()`). `getStatus()` 조건부 스프레드 3건. **LPD 경로 무변경.** |
| `src/capture/detectPipeline.ts` | 수정 | `OnPlaceOpts` 신설 + `runDetect(deps, args, cfg, onPlace?)` 4번째 옵셔널 인자. 필터를 **zoom 재시도 루프 진입 전**에 적용 → 통행차에 대한 카메라 호출 0회. `matchPlatesToSlots` 는 필터된 vehicles 로 호출(인덱스 정합). `DetectResult.summary` 에 `onPlaceOnly`/`filteredOut`/`onPlaceDegraded?` 가산(`vpdCount` 는 **필터 전** 원 검출 수 — 의미 불변). `plates` 배열 무변경. |
| `src/api/captureRoutes.ts` | 수정 | `StartBodySchema`·`DetectBodySchema` 에 `vpdOnParkingOnly: z.boolean().optional()`. `/capture/start` → `job.start({..., vpdOnParkingOnly})`. `/capture/detect` → `loadNormalizedPlaceRoi(deps.placeRoiFile)` 로 프리셋 폴리곤 조회 후 `runDetect(..., { onlyOnPlace: ?? true, polys, degradeReason })`. **`runDetect(..., parsed.data, ...)` → `{ cam, preset }` 명시 전달로 교체**(새 body 키 누출 방지). |
| `src/index.ts` | 수정 | `CaptureJob` 에 `placeRoiFile: join(tools.store.dataDir, tools.store.placeRoiFile)` 주입(Finalizer/server 와 동일 표현). |
| `web/index.html` | 수정 | `.capture-grid` 내 `#cap-floor-llm` 바로 뒤에 `<input id="cap-vpd-onplace" type="checkbox" checked>` **주차면 위 차량만 검출**(기본 ON = 모드 A). |
| `web/app.js` | 수정 | ① `capStart()` body 에 `vpdOnParkingOnly` ② `runLiveDetect()` payload 에 `vpdOnParkingOnly` + 응답 `summary` 로 `cap-msg` 표시(`검출 N/M대 · 주차면필터 ON/OFF[ — 강등: 사유]`) ③ `renderCaptureStatus()` 에 서버 status 기반 advisory 라인(모드/제외 대수/강등 사유). |
| `web/core.js` | **무변경** | 서버가 필터된 결과를 준다(이중구현 금지). |
| `test/detectPipeline.test.ts:118` | 기대값 갱신 | `summary` 에 `onPlaceOnly:false, filteredOut:0` 추가(3인자 호출 = 필터 미적용). |
| `test/captureRoutes.test.ts:500` | 기대값 갱신 | `placeRoiFile` 미주입 → 강등 경로 → `onPlaceOnly:false, filteredOut:0, onPlaceDegraded:'주차면 파일 없음/로드 실패'` 추가. |

`src/capture/Finalizer.ts` — **건드리지 않음**(리더 확정 Q1).

---

## 2. 핵심 구현 노트

### 판정 규칙(계획 §1 채택안 그대로)
```
band(rect) = bbox 하단 25%
keep(rect) = polys.some(P => convexIntersectionArea(rectCorners(band), P) / area(band) >= 0.15)
```
전 폴리곤 **OR** — *배정*이 아니라 *필터*이므로 옆 칸에 걸쳐도 `keep` 이 정답이고, 드롭되는 것은 어느 주차면과도 겹치지 않는 통로/진출입로 차량뿐이다.

### 강등(조용한 폴백 금지 — HANDOFF §2-3)
폴리곤 부재 시 **전량 통과 + `logger.warn(reason) + status/summary 노출`**. 강등 입도는 **프리셋 단위**(`byPreset` 키 부재 = 그 프리셋만 강등).
- CaptureJob: `onPlaceDegraded` 는 최초 사유 1건 보존, `warn` 은 프리셋 키당 1회(`degradeWarned` 가드 — 라운드마다 로그 폭주 방지).
- 사유 문자열: 파일 없음/로드 실패 → `주차면 파일 없음/로드 실패`, 프리셋 주차면 0개 → `프리셋 {cam}:{preset} 주차면 0개`.

### 필터 미적용(모드 B) 경로는 필터 함수 자체를 건너뛴다
`this.vpdOnParkingOnly ? await this.applyOnPlaceFilter(...) : raw` — 이전 동작 100% 복원.

---

## 3. 계획과 달라진 점

**1건.** `OnPlaceOpts` 에 옵셔널 필드 `degradeReason?: string` 을 추가했다(계획은 `{onlyOnPlace, polys}` 2필드).

- **사유**: `runDetect` 는 `polys=null` 하나만 보고는 **"파일이 없다"**와 **"이 프리셋에 주차면이 0개다"**를 구분할 수 없다. 구분 가능한 지식은 호출측(라우트가 가진 `place` 객체)에만 있다. 계획대로 하면 프리셋에 주차면이 0개인 정상 파일에서도 UI 에 "주차면 파일 없음/로드 실패"라는 **거짓 사유**가 뜬다(강등을 드러내라는 §3 원칙의 취지에 반함).
- **영향**: 미지정 시 `'주차면 폴리곤 없음'` 으로 폴백하므로 계약은 그대로. 라우트는 CaptureJob 과 **동일한 2분기 문자열**을 넘긴다 → 계획 §5 가 예측한 `captureRoutes.test.ts:500` 기대값(`'주차면 파일 없음/로드 실패'`)도 그대로 성립한다.

---

## 4. 게이트 실행 결과(있는 그대로)

```
npx tsc -p tsconfig.json --noEmit   → TSC_EXIT=0
npx vitest run                      → Test Files 131 passed (131)
                                      Tests      1412 passed (1412)
```
계획이 예측한 **깨지는 기존 테스트 2건**(`detectPipeline.test.ts:118`, `captureRoutes.test.ts:500`)만 기대값을 갱신했다(응답 shape 가산 — 동작 변경 아님). **그 외 테스트는 1줄도 고치지 않았고 전량 통과**한다. 계획 §5 의 예측(=`placeRoiFile` 미주입 테스트는 강등으로 수렴 → 무변경 통과)이 실측으로 확인됐다: `captureJob*.test.ts` 4건 무변경 통과.

### 구현 중 자기검증(임시 테스트 — 실행 후 삭제, qa-tester 와 중복 방지)
`onPlaceFilter` 5케이스 중 4건 즉시 통과: ① 주차차 keep ② **통행차 drop**(중심은 뒷줄 폴리곤 안, 접지밴드는 통로 — 중심규칙이었다면 통과했을 케이스. **규칙 선택의 근거가 실제로 성립함을 확인**) ③ `polys=null` → 전량 통과 + `degraded` ④ 퇴화 rect(h=0) → `false`.

---

## 5. qa-tester 에게(계획 §6 작성 시 주의)

- **항목 7(`groundBand` 좌표 단언)은 `toEqual` 로 쓰면 실패한다.** 부동소수 오차 — `y = 0.2 + 0.4 − 0.1 = 0.5000000000000001`. **`toBeCloseTo` 를 쓸 것.** (자기검증에서 실제로 이 이유로 1건 실패 → 구현이 아니라 테스트 기대값 문제임을 확인)
- 항목 8·10 의 픽스처는 **`test/fixtures/PtzCamRoi.unity.json`**(동결). 런타임 `data/Place01/PtzCamRoi.json` 사용 금지(HANDOFF §2-2).
- 항목 14(`{onlyOnPlace:true, polys:null}`) 의 `summary.onPlaceDegraded` 기대값은 **호출측이 넘긴 `degradeReason`**(미지정 시 `'주차면 폴리곤 없음'`).

---

## 6. 후속 과제 (F-2 계열)

- **[F-2a] Finalizer 차량중심 폴백 통일(리더 확정 — 이번 범위 밖)**: `Finalizer.ts:237-241` 의 주차면 *배정*은 번호판 중심 우선 + **차량 bbox 중심 폴백**이다. 모드 B(모든 차량)에서는 이 폴백이 여전히 **통로 통행차를 뒷줄 주차면에 배정**할 수 있다(VPD rect 는 지붕 포함 → 중심이 원근으로 ~한 칸 먼 쪽 이탈). `isVehicleOnPlace` 로 통일할지는 **점유 배정 동작 변경 + 기존 테스트(`finalizerParkingSlots.test.ts`) 단언 대상**이므로 라이브 검증을 동반한 별도 과제로 등록한다. 모드 A 에서는 상류 필터가 통행차를 이미 제거하므로 이 FP 는 발생하지 않는다.

---

## 7. 구현 중 발견한 문제·한계

1. **임계값(0.25 / 0.15)은 해석적 유도값이 아니다.** 유닛테스트는 규칙의 *논리*만 봉인하고 임계값의 *적절성*은 봉인하지 못한다 → **라이브 검증이 성공 판정의 본체**(계획 §10-8): 모드 A 수집 1라운드 → `filteredOut > 0` 이면서 **주차차가 빠지지 않았음**을 육안 대조.
2. **사후 모드 전환 불가**: 검출 시점 필터라 원 검출이 DB 에 남지 않는다. 모드를 바꾸려면 재수집해야 한다(계획 §2 트레이드오프 — 의도된 설계).
3. **모드 A 에서 통행차 위에 번호판 quad 만 표시될 수 있다**(차량 박스 없이). `plates` 는 필터하지 않는다 — 필터하면 VPD 가 놓친 주차차의 번호판까지 사라져 `core.js:computeOccupancy`(번호판 중심 기반)의 점유가 **뒤집힐** 위험이 있다. 의도된 동작.
4. **가림(occlusion)**: 앞줄 차가 뒷줄 차의 하단을 가리면 bbox 하단이 실제 접지선보다 위로 잡혀 접지 근사가 틀어진다. 전 폴리곤 OR 로 상당 부분 흡수되나 완전 해결은 SAM 접지선(HANDOFF §6)뿐이다.
5. **ROI 정합 사각지대 상속**: 주차면 ROI 자체가 한 칸 평행이동돼 있으면 필터도 똑같이 틀린다(경고 없음). 필터는 ROI 를 검증하지 않는다.
6. **오목 폴리곤**: `convexIntersectionArea` 는 볼록 전제 — 사용자가 정점을 끌어 오목 quad 를 만들면 겹침이 과대추정된다(FN 감소 방향이라 안전측이지만 부정확).
7. **프로덕션 기본 동작이 바뀐다**: `index.ts` 가 `placeRoiFile` 을 주입하므로 정밀수집·라이브검출 **기본이 모드 A**. 이전 run 대비 검출 수 감소는 정상이며 감소분은 `status.vpdFilteredOut` 으로 관측된다. 체크 해제 시 이전 동작 100% 복원.
