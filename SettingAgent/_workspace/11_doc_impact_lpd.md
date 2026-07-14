# 11. 영향도 분석 — LPD 번호판 주차면 필터 (2차)

**최종 문서**: `SettingAgent/docs/20260714_160739_LPD번호판_주차면필터_점유무회귀.md`
**분석 기준시각**: 2026-07-14 16:07:39
**1차 영향도**: `_workspace/04_doc_impact.md` — **그 문서 §6「LPD 미필터 결정의 파급」은 이 변경으로 무효다.**

---

## 0. 1차 결정의 번복 (상호 링크)

| | 1차 (2026-07-14 14:43) | **2차 (이 문서)** |
|---|---|---|
| 문서 | `docs/20260714_144345_VPD주차면필터_2모드_정밀수집체크박스.md` **§6 「번호판(LPD)은 필터하지 않는다 — 의도된 결정」** | `docs/20260714_160739_LPD번호판_주차면필터_점유무회귀.md` |
| 설계 | `_workspace/01_architect_plan.md` §2 | `_workspace/06_architect_plan_lpd.md` |
| 영향도 | `_workspace/04_doc_impact.md` §6 | **이 문서** |
| `DetectResult.plates` | 모드 A 에서도 **필터하지 않음** | 모드 A 에서 **주차면 위 차량 것만** |

**1차가 LPD 필터를 기각한 유일한 기술적 근거**는 *"plates 를 필터하면 VPD 가 놓친 주차차의 번호판까지 사라져 `computeOccupancy` 의 점유가 뒤집힐 위험"* 이었다. 2차는 그 위험을 **OR 규칙의 (B)항**(번호판 중심 ∈ 주차면 폴리곤)으로 해소했기 때문에 번복이 가능했다. **1차의 우려는 옳았고, 근거 없이 뒤집은 것이 아니다.**

---

## 1. 동작 변경 (반드시 읽어야 할 항목)

### 1.1 뷰어 오버레이 — 의도한 변경

모드 A 에서 `DetectResult.plates` 가 **주차면 위 차량 것만** 담는다. 마스터가 보고한 **뒷줄 노란 번호판 quad 증상이 사라진다**(리더 라이브: preset3 **12장 → 4장**, `lpdFilteredOut=8`).

### 1.2 ★ DB 저장분 감소 → **집계 대표값이 이동한다** (D-2 — 설계서가 "불변"이라고 주장했으나 **거짓**)

```
lpd.detect()  →  [NEW] filterPlatesOnPlace  →  insertDetections(kind:'plate')   ← **행 수가 줄어든다**
                                                      ↓
                                                 aggregate()  ← plate 클러스터 구성이 바뀐다
                                                      ↓
                                                 Finalizer → parking_slots.lpdJson  ← **값이 이동한다**
```

**입도 불일치**가 원인이다:
- 상류 `matchPlatesToSlots`: **검출 1건 단위** 경쟁 → 패자를 **드롭**
- 하류 `Aggregator`: **클러스터 대표 단위** 매칭 → 패자를 버리지 않고 **승자 클러스터에 병합** → robust median 을 끌어당김

**실측**(검증자 봉인 테스트): `plateY` **0.3005**(모드B, 근접 오검출에 오염) vs **0.323**(모드A, 진짜 번호판 실좌표) — 차이 0.0225 정규화 ≈ **1080p 기준 24px**.

| | 판정 |
|---|---|
| **손실** | **0** — 슬롯 소실 0, 차량 대표 rect·support·occupancyRate·status **전부 동일** |
| **방향** | **개선** — 모드 A 값이 정답, 모드 B 값이 오염된 값 |
| **코드 조치** | **`Aggregator.ts`/`Finalizer.ts` 무변경이 옳다.** 틀린 것은 설계서 문장뿐 |

> ⚠️ **하류에서 "모드 A run 과 모드 B run 의 `lpdJson` 이 같다"고 가정하는 코드가 있으면 틀린다.**
> 현재 저장소에서 그런 가정을 하는 코드는 **발견되지 않았다**(`lpdJson` 소비처는 `Finalizer` 기록 경로와 뷰어 표시뿐). 다만 **run 간 `lpdJson` 대조를 하려는 사람은 모드가 같은지 먼저 확인해야 한다.**

### 1.3 점유 판정(`computeOccupancy`) — **무회귀 (라이브 확인)**

같은 원본 데이터에 필터 적용/미적용 + **뷰어가 실제로 쓰는 `web/core.js:computeOccupancy`**:

| 프리셋 | 점유(필터 전) | 점유(필터 후) |
|---|---|---|
| preset1 | `[1,2,3,4,5,6,7]` | `[1,2,3,4,5,6,7]` |
| preset2 | `[8,10,11,12,13]` | `[8,10,11,12,13]` |
| preset3 | `[14,15,16,17]` | `[14,15,16,17]` |

**전부 동일. D-1 수정 후 재확인도 동일.** 검증자도 별도 3회 반복해 같은 결과.

---

## 2. 영향 모듈 (의존성 그래프)

```
[수정] src/domain/geometry.ts  +quadCentroid          ← D-1 수정의 핵심. web/core.js:quadCentroid 와 동일 정의
   └──▶ src/capture/onPlaceFilter.ts  +filterPlatesOnPlace
           │   (import: setup/plateMatch.ts matchPlatesToSlots, domain/polygon.ts pointInPolygon — 전부 기존, 무변경)
           ├──▶ src/capture/CaptureJob.ts       (정밀수집 → DB detection)
           └──▶ src/capture/detectPipeline.ts   (라이브검출 → DetectResult.plates)
                   └── src/api/captureRoutes.ts  (무변경 — 이미 polys·onlyOnPlace 전달 중)
                           └── web/app.js ← web/index.html  (#cap-vpd-onplace, 라벨만 변경)

[타입]  src/capture/types.ts  CaptureStatus +lpdFilteredOut?
[봉인]  test/quadCentroidParity.test.ts   서버 quadCentroid ≡ web/core.js quadCentroid
```

| 모듈 | 영향 | 성격 |
|---|---|---|
| `src/domain/geometry.ts` | 수정 | `quadCentroid` **가산 1개**(순수). 기존 export 무변경 → **기존 소비처 회귀 0** |
| `src/capture/onPlaceFilter.ts` | 수정 | `filterPlatesOnPlace` 가산(+38줄, 순수). 기존 3함수 무변경 |
| `src/capture/detectPipeline.ts` | 수정 | `summary.lpdFilteredOut` 가산, 반환 `plates` 를 필터본으로, 모드A 게이트 블록 |
| `src/capture/CaptureJob.ts` | 수정 | `lpdFilteredOut` 카운터, `presetPlace()` 추출(두 필터 공유), `applyPlateFilter()` |
| `src/capture/types.ts` | 수정 | `CaptureStatus` **옵셔널 1필드** |
| `web/app.js`, `web/index.html` | 수정 | 표시 2곳 + 라벨 1곳 |

### 2.1 무변경 확인 (파일 mtime 으로 검증 — 2차 작업 시각대는 15:27~16:04)

| 파일 | mtime | 판정 |
|---|---|---|
| `src/capture/Aggregator.ts` | **2026-07-05 12:49:50** | 2차 편집 없음. **D-2 에도 불구하고 무변경이 옳다**(§1.2) |
| `src/setup/plateMatch.ts` | **2026-07-05 12:49:50** | 2차 편집 없음. `matchPlatesToSlots` 를 **재사용만** 했다 |
| `src/capture/Finalizer.ts` | **2026-07-13 19:37:40** | 2차 편집 없음. 배정 규칙 그대로 |
| `web/core.js` | **2026-07-14 01:10:14** | **2차 편집 없음** — 서버를 소비처에 맞췄다(이중구현 금지, HANDOFF §2-5) |
| `src/api/captureRoutes.ts` | **2026-07-14 14:28:03** | **1차** 시각. 2차 편집 없음(zod·핸들러 변경 0) |
| `src/index.ts` | **2026-07-14 14:28:09** | **1차** 시각. 2차 편집 없음(`placeRoiFile` 이미 주입) |

### 2.2 파급되지 **않는** 것

- **`@parkagent/types` 무변경** — 이번 변경은 `SettingAgent` 로컬 타입(`src/capture/types.ts`, `src/capture/detectPipeline.ts`, `src/domain/geometry.ts`)만 건드린다. **공유 도메인 타입(SlotState/ParkingEvent 등) 변경 0건 → ActionAgent·DMAgent 전파 없음.**
- **DB 스키마 무변경** — `detections`/`observation`/`parking_slots` 테이블 정의 그대로. 바뀌는 것은 **`kind:'plate'` 행의 개수**와 그로 인한 **`lpdJson` 대표값**뿐(§1.2).
- **`PtzCamRoi.json` 스키마 무변경** — 필터는 **읽기 전용 소비자**(`loadNormalizedPlaceRoi`).
- **MCP 도구 계약 무변경** — 필터는 결정형 기하 도구다. **LLM 은 이 경로에 개입하지 않는다**(좌표 불변식 유지). `floorReviewer`/`occupancyReviewer` 는 필터된 검출을 **입력으로 받을 뿐** 규칙을 모른다.
- **`domain/polygon.ts` 무변경** — `pointInPolygon` 재사용만.
- **차량(VPD) 필터 경로 무변경** — 1차 동작 그대로. `filteredOut`/`vpdFilteredOut` 의미 불변.

---

## 3. REST 계약 변경 — 가산만 → 하위호환

| 엔드포인트 | 변경 | 하위호환 |
|---|---|---|
| `POST /capture/detect` 응답 `DetectResult.summary` | **`+ lpdFilteredOut: number`** (**required**) | ✅ 가산. `lpdCount` 의미 **불변 = 필터 전 원 검출 수** |
| `GET /capture/status` 응답 `CaptureStatus` | **`+ lpdFilteredOut?: number`** (**옵셔널** — `> 0` 일 때만 노출, 조건부 스프레드) | ✅ 값 없으면 **키 자체가 없다** |
| `POST /capture/detect` 응답 `plates` **의미** | 모드 A 에서 **주차면 위 차량 것만** | ⚠️ **shape 이 아니라 내용이 바뀐다** — 이것이 이번 변경의 본체 |
| `POST /capture/start`·`/detect` **body** | **무변경** | `vpdOnParkingOnly` 를 그대로 재사용(zod 변경 0) |

**계약 불변식**: `plates.length === summary.lpdCount − summary.lpdFilteredOut` — 라우트·파이프라인·**라이브** 3곳에서 확인(12−8=4 ✓). 경계면 테스트(`test/captureRoutes.test.ts` R2)가 봉인.

**옵셔널 키 falsy 가드 정합**(조용한 `undefined`/`NaN` 표시 방지):
- `summary.lpdFilteredOut` 은 **항상 존재**(required) ↔ `app.js:577` `${s.lpdCount - s.lpdFilteredOut}` → **NaN 위험 없음**.
- `status.lpdFilteredOut` 은 조건부 노출 ↔ `app.js:1444` `status.lpdFilteredOut ?? 0` → 정합.
- ⚠️ **배지 falsy 가드가 확장돼야 했다**: `status.vpdFilteredOut ? … : ''` → `status.vpdFilteredOut || status.lpdFilteredOut ? … : ''`. **차량 제외 0 · 번호판 제외 >0** 인 상태가 **실제로 도달 가능**하며(검증자 C4 로 실증), 구 가드였다면 괄호가 통째로 사라져 `lpdFilteredOut` 이 **관측 불가**해졌다.

---

## 4. 기존 테스트 영향

| 파일 | 현상 | 조치 |
|---|---|---|
| **★ `test/captureJobOnPlace.test.ts` §6-11** `'LPD(번호판)는 필터 대상이 아니다'` | **이 단언이 이제 틀렸다** — 1차 §6 결정을 봉인하던 테스트다 | **describe 재작성**(§6-11′) + C4 신규 |
| **★ `test/onPlaceFilter.test.ts` P7** `'비대칭 quad 는 quadBoundingRect+center 로 판정'` | **D-1(구 버그)을 사양으로 못 박고 있었다** — 그대로 두면 수정이 테스트 실패로 거부된다 | **삭제하지 않고 방향 전환**(구 사양이 왜 틀렸는지가 테스트에 남는다) |
| `test/detectPipeline.test.ts` `toEqual` 2건 | `lpdFilteredOut` 가산으로 완전일치 실패 | 기대값 갱신 |
| `test/captureRoutes.test.ts` `toEqual` 2건 | 동일 | 기대값 갱신 + 경계면 계약 확장 |
| `test/aggregator*.test.ts`, `test/finalizer*.test.ts` | `Aggregator`/`Finalizer` 무변경 | **영향 없음**(D-2 는 *입력 데이터*가 바뀌는 것이지 함수가 바뀌는 게 아니다) |
| 기존 `captureJob*.test.ts` (모드A 무관) | `placeRoiFile` 미주입 → 강등 → 전량 통과 | **무변경 통과** |
| `src/domain/geometry.ts` 기존 소비처 | `quadCentroid` 는 **가산** | **회귀 0** |

**게이트 실측**: `tsc --noEmit` **exit 0** / `vitest run` **135 files · 1491 tests 전량 통과**(실패 0 · 스킵 0).

---

## 5. 확인 필요 (단정하지 않음)

1. **정밀수집 잡(DB 경로)의 LPD 필터 라이브 미재현** — 유닛테스트(C1~C3)로만 확인했다. 실제 run 에서 `detection` 의 `kind:'plate'` 행이 줄고 `parking_slots.lpdJson` 이 §1.2 대로 이동하는지는 **관측하지 않았다**(추가 run 이 DB 데이터를 늘리므로 보류).
2. **브라우저 실제 클릭** — DOM 자동화 없음. `#cap-vpd-onplace` rename 시 **테스트는 안 깨지고 프론트만 조용히 죽는다.**
3. **`lpdJson` 을 run 간 대조하는 외부 소비자 유무** — 저장소 내에서는 발견되지 않았으나, 외부 스크립트·분석이 있다면 §1.2 를 적용해야 한다.
4. **다른 프리셋/장면으로의 일반화** — 라이브는 cam1·preset1~3·이 장면 기준.
5. **(A)·(B) 동시 실패** — VPD 미검출 + 번호판 중심이 폴리곤 밖 → 드롭, **경고 없음**. 실데이터에서 발생하지 않았으나 원리적으로 가능하고 **관측 수단이 없다.**

---

## 6. 등록한 후속 과제

| ID | 내용 | 상태 |
|---|---|---|
| **P-1** | `web/core.js:quadCentroid` ↔ 서버 중심 정의 통일 | ✅ **해소**(D-1 수정 + 파리티 테스트) |
| **★ P-2** | **`quadCentroid` private 사본 2개 잔존** — `Aggregator.ts:118`·`Finalizer.ts:35`(정의는 `domain/geometry.ts` 와 동일). **D-1 을 낳은 바로 그 패턴.** `domain/geometry.ts` import 로 교체하는 **no-op 리팩토링** | 신규 |
| **★ Q-1** | `matchPlatesToSlots` tie-break **배열 순서 의존**(겹침 동률 시 strict `>` → 첫 번째 승). 거대 병합 박스에서 *어떤* 번호판 1개가 살아남을지가 **LPD 응답 순서에 좌우**된다. 사양 위반은 아니나 **비결정적**·미봉인 | 신규 |
| V-1 / F-2a / #0 | 기등록 (변동 없음) | — |
