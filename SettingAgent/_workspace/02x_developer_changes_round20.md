# 20회차 구현 보고 — 「현재 화면 그대로 검출」

- 작성: 2026-07-30 / 구현자
- 설계 정본: `_workspace/01e_architect_plan_round20.md` (§11 구현 순서 그대로)
- 리더 결정 5건(§12) 전부 채택 상태로 구현

---

## 0. 한 줄 결론

**V1 통과.** 「검출」이 카메라를 움직이지 않는다(PTZ 정착 후 **원시 배정도 완전 동일** · 대조군 preset 모드는 움직인다).
회귀 0(`tsc` exit 0 · vitest 288파일 **3675** green · 골든 v1 수치·프레임해시 전부 동일 · preset 응답 키 집합 동일 · 정본/DB md5 무변경).

---

## 1. 변경 파일

### 신규
| 파일 | 줄수 | 내용 |
|---|---|---|
| `src/tools/roiAutoCurrentView.ts` | 137 | 라이브 13020 에 `roi.auto.detect{view:"current"}` 를 쏘고 `ptzUsed` 로 씬 정답을 투영해 재현율·정밀도·IoU 산출. Unity 는 `cam.list`·`preset.list` **읽기만** |
| `test/roiAutoCurrentView.test.ts` | 18 tests | T1~T12 + expectedBays/camId 필수 + 기준화각 우선순위 + holdout |

### 수정
| 파일 | 내용 |
|---|---|
| `src/ground/cameraIntrinsics.ts` | `PresetIntrinsics.fovAtZoom?: 'zoom1'` · `focalPxAtZoom()` 신설 · `groundModelFromIntrinsics` 1줄 배선 + issues 문구 분기 |
| `src/ground/placeMetaIntrinsics.ts` | `baseFocalPxOf()` + `BaseFocalPx` 신설(줌1 초점거리 파생 · 프리셋 간 산포 보고) |
| `src/rpc/services/roiAuto.ts` | `view` 파라미터 · `cameraSpec.baseHfovDeg` · `currentViewResolver` · `currentTargetOf` · `rowsView`/`currentDetectView` · consensus 강제 OFF · score/apply 의 `view:'current'` 명시 거부 · 실카 `baseHfovDeg` 거부 |
| `web/index.html` | 「현재 화면 그대로」 체크박스(기본 **checked**) · 화각 라벨/placeholder/tooltip 재정의 · 예상 면수 tooltip |
| `web/app.js` | `view` 항상 명시 전송 · `apCameraSpec` 화각 필드 분기(시뮬 `baseHfovDeg` / 실카 `hfovDeg`) · `updateApSpecLabels()` · ETA 문구 · 현재뷰 `expectedBays` 선행 가드 |
| `web/autoPaint.js` + `.d.ts` | `view`·`ptzUsed`·`rows` 접기 · `autoQuadItems` 합집합 · `autoPaintViewFor` 현재뷰 폴백 |
| `test/autoPaint.test.ts` | T13 + UI 결선 6 tests 추가 |

### 무접촉 (확인)
`sceneTruth.ts` · `bayGrid.ts` · `bayGeometry.ts` · `floorPaint.ts` · `roiAutoScore.ts` · `roiAutoRecall.ts` · `project.ts` · `autoRoiPlan.ts` · `src/viewer/**` · `src/clients/**` · `packages/lens-calib/**` · `data/**`(정본·DB) · `config/**` — **검출 알고리즘의 파라미터·점수·기하 로직 0줄 변경**(반증목록 20건 재시도 0건).

`groundModelFromIntrinsics` 호출자 20곳 · `focalPxOf` 6곳 전수 grep 재확인 — 설계서 §2-4 표와 **일치**, 누락 호출자 없음. `fovAtZoom` 을 세우는 곳은 `currentViewResolver` 단 하나다.

---

## 2. ★ V1 — 카메라가 움직이지 않는가 (이 라운드의 게이트)

```
before: {"pan": 41.5, "tilt": 20.1000042, "zoom": 1.57991}
after : {"pan": 41.5, "tilt": 20.1000042, "zoom": 1.57991}   → V1 PASS (원시 배정도 완전 동일)
```
대조군 `view:"preset"`: `{41.5, 20.1000042, 1.57991}` → `{90.1000061, 35.8000031, 1.0}` — **움직인다**(전제 성립).

### ★ 정직하게 남기는 단서 — 첫 1회에 한해 1 ULP 가 움직인다

Unity 가 스스로 쓴 적 없는 상태에서 **첫** 현재뷰 검출을 하면 `tilt 20.1000023 → 20.1000042` 로 바뀐다.
- 크기 = **1.907e-6°** = float32 20.1 근방의 **정확히 1 ULP**(python `struct` 로 검산).
- 원인 = Unity 의 quaternion↔euler 왕복 양자화. 우리는 **읽은 값을 그대로** 되쓴다(T8 이 이를 검사).
- **두 번째 호출부터는 고정점**이다(같은 값 반복 setPTZ → 불변, 무동작 8초 관측에서도 드리프트 0).
- 광학적 의미: f 2736px 에서 **9.1e-5 px**. 물리적 이동이 아니다.

> 설계서 §7 V1 스크립트 결함: `curl` 의 `id` 를 1/3 으로 다르게 주고 **응답 전문을 diff** 한다 → `id` 때문에 항상 불일치가 난다. `result` 만 비교해야 한다(이 보고의 수치는 `result` 비교).

---

## 3. M1~M9 실측 결과 (추정 0건)

| # | 항목 | 실측 결과 |
|---|---|---|
| **M1** | 현재뷰 `expectedBays` 기본값 | §3-1 표. **평탄역 = [6, 16]**(그 구간 산출이 서로 **완전 동일**). 권고값 **8**. 단 파라미터는 **필수 유지**(사유 §3-1) |
| **M2** | 뷰어 `tilt` 의 절대 의미 | **일치 확인.** 5프리셋 전수 `ptzUsed.tilt` = 8.7 / 20.1 / 35.8 / 10 / 17 = 인계서 표 = `PtzCamRoi.eulerAngles[0]`. **현재뷰 유효** |
| **M3** | 뷰어 `zoom` 의 절대 의미 | **일치 확인.** `ptzUsed.zoom` = 1.69341 / 1.57991 / 1 / 1.80643 / 1.80643 = 정본 프리셋 `zoom`. `clampZoom`(1~36) 은 **한 번도 물지 않았다**(전 값이 구간 내부) |
| **M4** | 검산 구간 밖 | 경고 배선 완료. **구현 중 오탐 1건 발견·수정**(§5-④) |
| **M5** | 채점의 f 상관오차 | 한계로 **도구 헤더 첫 화면에 상시 출력**(정답 투영 f = 검출 f) |
| **M6** | `RealPtzSource.snapshot({mode:'preset'})` | **안 움직인다**(`RealPtzSource.ts:233` — `mode==='manual' && ptz` 일 때만 `move`). `roiAuto.ts:474` 주석은 **참**. ★ 그러나 **시뮬은 정반대**다(§5-①) |
| **M7** | `spreadPx` 경고 임계 5px | **실측으로 대체.** cam1 **0.001px**(표본 3) · cam2 **0.000px**(표본 2). 5px 는 근거 없고 리더 검산 0.2px 도 200배 보수적이었다 → **1px** 로 재조정(측정치의 1000배 여유) |
| **M8** | 시뮬 씬이 정지하지 않는다 | **강하게 재확인.** 스윕 30회 중 `2:1` 은 **매 실행 프레임이 달랐고**, `2:2` 는 프레임이 바뀌자 재현율이 0.3750→0.0000 으로 뒤집혔다. 모든 수치에 frameHash 병기 |
| **M9** | `rows` 응답 크기 | **정밀도 필터 이후다**(`bayGrid.ts:641-644` — dedup → `rowMinScoreRatio`/`rowMinNearSupport`). 라이브 실측 **0~3행 / 0~16 quad**. **상한 불필요** |

### 3-1. M1 스윕 — 프리셋 5곳 현재뷰 × `{4,6,8,10,12,16}` (30회 라이브)

전체 합계(씬 가시 정답 41면 고정):

| expectedBays | 재현율 | 정밀도 | 산출 quad |
|---|---|---|---|
| 4  | 0.5854 (24/41) | 0.3934 (24/61) | 61 |
| **6** | 0.5122 (21/41) | 0.3750 (21/56) | 56 |
| **8** | 0.5122 (21/41) | **0.4038** (21/52) | 52 |
| **10** | 0.5122 | 0.4038 | 52 |
| **12** | 0.5122 | 0.4038 | 52 |
| **16** | 0.5122 | 0.4038 | 52 |

**해석 — 합계표를 그대로 믿으면 안 된다.** 라이브 프레임이 실행마다 달라(M8) `4 vs 6` 비교가 `1:3`·`2:1`·`2:2` 에서 **프레임 변화와 교락**돼 있다. **프레임이 고정된 두 뷰만이 깨끗한 신호**다:

- `1:1` (전 6회 프레임 `00d16f55a28b` 동일): 재현율·정밀도·IoU 가 **4~16 전부 동일**. `expectedBays` 효과 **0**.
- `1:2` (전 6회 프레임 `61405af70181` 동일): 재현율·정밀도는 4~16 전부 동일(0.5714/0.6154)이나 **매칭 IoU 는 4 → 0.91814, 6~16 → 0.76370(6개 값이 서로 동일)**.

→ **결론: 6~16 은 산출이 서로 완전히 같은 평탄역이다. 4 는 평탄역 밖이며 뷰마다 유불리가 갈린다**(`1:2` 는 IoU 가 좋아지고, `2:1` 은 행이 1→3개로 늘어 정밀도가 0.50→0.30 으로 나빠진다).

**조치: 파라미터는 필수로 유지한다.** 평탄역이 넓어 기본값을 둘 근거는 생겼지만, ⓐ 값이 산출에 실제로 영향을 주는 구간(≤4)이 존재하고 ⓑ 같은 입력칸을 preset 모드가 공유하므로 UI 프리필은 preset 모드 회귀가 된다. 대신 **거부 메시지에 실측 평탄역과 권고값 8 을 명시**했고 tooltip 에도 "필수"를 적었다.

### 3-2. V2 — `f = f@zoom1 × zoom` 앵커 검산 (5프리셋 전수)

| 프리셋 | `focalPx`(preset) | `focalPx`(current) | 차이 | `1731.8853 × zoom` 대비 |
|---|---|---|---|---|
| 1:1 | 2932.792 | 2932.792 | **−0.000px** | −0.0003px |
| 1:2 | 2736.224 | 2736.223 | **−0.001px** | +0.0000px |
| 1:3 | 1731.886 | 1731.885 | **−0.000px** | +0.0000px |
| 2:1 | 3128.531 | 3128.531 | **+0.000px** | +0.0013px |
| 2:2 | 3128.531 | 3128.531 | **+0.000px** | +0.0013px |

성공 기준 ±0.5px 대비 **500배 여유로 통과**. `f@zoom1` = cam1 **1731.8853px** / cam2 **1731.88594px** ↔ HFOV **58.00002° / 58.00000°**.

### 3-3. V3 — 임의 뷰 채점 성립 확인

`npx tsx src/tools/roiAutoCurrentView.ts <camId> <expectedBays> [rows|best]` 가 프레임해시·ptzUsed·씬 가시 N면·재현율·정밀도·매칭 IoU·줌 외삽 여부를 낸다(위 30회가 전부 이 도구 출력). **19회차 수치와 직접 비교하지 않는다** — 분모가 프리셋 종속에서 임의뷰로 바뀌었다.

---

## 4. V4 · V5 회귀 (원문 숫자)

```
npx tsc --noEmit                 → exit 0
npx vitest run                   → Test Files 288 passed (288) / Tests 3675 passed (3675)
```
- **기준선 288/3675 vs 실측 baseline 287/3651 = 신규 24 tests 정확히 일치**(roiAutoCurrentView 18 + autoPaint 6).
- ⚠ **리더 지시서의 "287파일 3661 green" 중 테스트 수가 실제와 다르다.** 이 세션에서 잰 변경 전 baseline 은 **3651**(287파일)이었다. 3661 이 아니라 3651 을 기준으로 삼아 계산했다.

골든 v1 · d0 · rows (`npx tsx src/tools/roiAutoRecall.ts v1 evidence rows`):
```
재현율 0.5854 (24/41) · 가림보정 0.8571 · 정밀도 0.8571 (24/28) · 매칭 IoU 평균 0.88860 · 최소 0.61302
프레임: 1:1 6006a034bfe2 / 1:2 ceaaed722663 / 1:3 3c0db12efe75 / 2:1 e33628e921c2 / 2:2 0cf4fda4d3aa
```
→ 기준선과 **전 항목·전 해시 동일**(픽스처 무오염).

라이브 preset 모드 응답 키 집합: 종전 17키와 **완전 동일**, `view`·`ptzUsed`·`rows` **미부착** 확인.

V5 — 전 실험 전후 md5 **동일**:
```
493a6e451b5caa1694c0289e1fe78da8  data/Place01/PtzCamRoi.json
3ab9c8363d7a8c4ff584c7a2df4b0a5c  data/setting.sqlite
```
`roi.create2d` 0회 · `roi.auto.apply` 0회 · `config/` 무변경(재기동 불필요, `web/` 정적자산은 라이브 반영 확인).

---

## 5. 발견한 설계 결함 · 설계와 다르게 구현한 것

### ① ★ 시뮬의 preset 모드는 `preset.select` 가 아니라 **camerapos PTZ 로 이동**한다 (설계서 §3-C 보강)
설계서는 `RpcCameraSource.snapshot` 의 `preset.select` 를 함정으로 지목했는데, `simulator-1` 은 실제로는 **`CameraposSource`**(kind `'rpc'`)이고 그 `snapshot(preset)`(`CameraposSource.ts:53-58`)은 camerapos 프리셋 PTZ 를 찾아 **`inner.snapshot(manual)`** 로 이동한다. `preset.select` 는 camerapos 에 항목이 없을 때의 폴백이다.
→ **결론은 같다**(ptz 를 안 넘기면 움직인다). 다만 "왜 움직이는가"의 실제 경로가 다르므로 주석에 두 경로를 다 적었다.

### ② 설계에 없던 필수 배선 — 뷰어 프레임 키 게이트
`autoPaintViewFor(result, 'cam:preset')` 가 키 완전일치를 요구한다. 현재뷰 응답의 키는 `1:current` 라 **그대로면 오버레이가 한 개도 안 그려진다**(설계서 §1 의 `web/autoPaint.js` 변경 목록에 없음). 같은 카메라면 그리도록 폴백을 넣었다(게이트의 취지는 "다른 프레임을 그리지 않기"이고 현재뷰는 그 카메라가 지금 보는 화면이다).

### ③ `rows` 는 `best` 를 항상 포함하지 않는다 → **대체가 아니라 합집합**
라이브 실측: `1:3`·`2:2` 에서 `rows=0행`인데 `best` 는 4~8 quad 다(19회차 진입 문턱이 전부 걸러냄). 설계서 문구("rows 를 뷰에 실어 그린다")대로 rows 만 그리면 **그 두 뷰에서 검출이 화면에서 사라진다**. `autoQuadItems` 를 좌표 서명 dedupe 합집합으로 구현했고, `rows` 가 없는 preset 응답은 목록·순서·라벨이 **종전과 완전히 동일**하다(T13 이 봉인).

### ④ 줌 외삽 경고 상한 오탐 (실측으로 수정)
설계서 검산 구간 상한 `1.80643` 은 정본 값이지만 `cam.getPTZ` 는 float32 왕복 뒤 **`1.8064301`** 을 준다 → **앵커 프리셋 바로 그 자리에서 "외삽" 오경고**가 떴다(2:2 첫 실행에서 실제 발생). 상한을 `1.80644` 로 올리고 사유를 주석에 남겼다.

### ⑤ `grabFrame` 에 `ptzOverride` 인자를 추가하지 않았다 (더 작은 구현)
설계서 §3-B ⑤ 는 `grabFrame(..., ptzOverride)` 를 제안했으나, `Target.ptz` 에 현재 PTZ 를 담으면 **`grabFrame`·`detectOne` 을 한 줄도 안 고치고** 같은 결과가 된다(`currentTargetOf` 8줄). 실카 분기(`kind==='hucoms' → ptz 미전달`)도 종전 그대로 살아 있어 실카에는 여전히 이동 명령이 안 나간다.

### ⑥ 설계에 없던 안전장치 — `roi.auto.score` / `roi.auto.apply` 의 `view:'current'` 거부
`view` 를 `BaseSchema` 에 넣으면 score·apply 도 그 필드를 받는데, 설계서에는 처리가 없어 **조용히 무시**된다. 이 저장소 규율상 조용한 무시는 금지이므로 둘 다 `INVALID_PARAMS` 로 명시 거부했다(score: 수동 정본은 프리셋 종속 / apply: 정본은 프리셋 단위).

### ⑦ `ptzUsed` 의 `round5` 는 재현 입력으로 미세 손실이 있다 (설계대로 두되 기록)
`ptzUsed.tilt` = `round5(20.1000042)` = `20.1`. 손실 4.2e-6° ≈ 0.0002px 라 무해하지만, `ptzUsed` 가 "재현의 유일한 입력"이라는 §4 문구와 엄밀히는 어긋난다. R7(5자리) 규약을 우선해 설계대로 두었다.

---

## 6. 남는 한계 (숨기지 않는다)

- **뷰어 육안 확인(§11 5단계 sharp 스샷)은 수행하지 못했다.** 이 에이전트에 브라우저 자동화 수단이 없다. 대신 ⓐ 라이브 RPC 로 무이동을 실측(V1) ⓑ 정적파일이 서버에서 갱신 반영됨을 확인 ⓒ 체크박스 기본 checked·`view` 명시 전송·화각 분기를 DOM/소스 문자열 테스트로 봉인했다. **마스터의 최종 육안 확인이 남아 있다.**
- **실카 현재뷰는 미검증**(R10). 코드상 실카는 `getPtz` 로 PTZ 만 읽고 캡처는 종전 무이동 경로(`ptz` 미전달)를 그대로 타며, `baseHfovDeg` 는 거부한다 — 그러나 **실기 실행 0회**다.
- **`2:2`·`1:3` 은 현재뷰에서도 재현율 0** 이다(U13·U12 의 기존 한계 그대로, 이 라운드의 회귀가 아니다). 프레임에 따라 `2:2` 가 0.375 로 살아나기도 한다 = U13 「임계」 진단 재확인.
- ③ 선택(번호 배정) 단계는 **코드 0줄**(리더 결정 5). `candidateId = frameHash#row.lattice` 계약만 확정했고 유일성을 T12 가 봉인한다.
