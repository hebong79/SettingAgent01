# 설계서 — 차량 점유 판정 컴포넌트 `OccupancyJudge` (plate 우선 · bbox 폴백)

- 작성: 설계자(architect) · 2026-07-15
- 대상: SettingAgent. 이 문서만으로 구현자가 goal/loop 를 시작할 수 있어야 한다.
- 요구: (1) 번호판 우선·bbox 폴백 점유 판정, (2) IO·DOM 무의존 독립 클래스, (3) 번호판 경로 기존 동작 보존(회귀 0).
- 제약: seg 마스크/3D 육면체 불사용(실측상 밀착 차량 불안정 확정). 신규 기하 알고리즘 발명 금지 — 기존 정의 재사용. 점유 판정 외 경로 무영향.

---

## 0. 검증된 코드 앵커 (설계 근거)

| 앵커 | 위치 | 확인 내용 |
|---|---|---|
| 현재 점유 판정 | `web/core.js:474 computeOccupancy(floorPolygons, plates)` | 번호판 quad 중심(`quadCentroid`, 4점 산술평균)이 바닥 폴리곤 내부(`pointInQuad`)면 occupied. 첫 매칭 center 채택. null/비배열 → `[]`(throw 금지). 반환 `[{idx, occupied, center?}]` |
| 뷰어 소비처 | `web/app.js:338 updateLogicOccupancy` | 소스 union = `[...detect.plates, ...detect.vehicles.map(v=>v.plate).filter(Boolean)]` → `computeOccupancy` → `state.occComputeByKey[key].spaces = [{id, occupied, center}]` |
| 오버레이 | `web/app.js:358 drawOccupancyOverlay` | `occupied && center` 인 행만 빨간 원(#ff4d4d) + id 텍스트. center 없으면 skip |
| bbox 접지 기준 | `src/capture/onPlaceFilter.ts` | `groundBand`(bbox 하단 25%, `GROUND_BAND_RATIO=0.25`) ∩ 폴리곤 면적비 ≥ `ON_PLACE_MIN_OVERLAP=0.15`. **중심 규칙은 원근 이탈로 FP 확정**(파일 상단 주석) — bbox 중심 규칙 금지 근거 |
| bbox 기하 | `src/domain/polygon.ts` | `rectCorners`·`convexIntersectionArea`(+내부 의존 `clipByHalfPlane`·`polygonArea`·`polygonCentroid`), `src/domain/geometry.ts:area` — **src(TS) 에만 존재, 브라우저에서 import 불가** |
| 데이터 shape | `src/capture/detectPipeline.ts:42~89` | `DetectVehicle = {rect, confidence, cls, plate?:{quad, confidence,…}}`, `DetectResult.plates = [{quad, confidence}]`. plate 는 이미 파이프라인에서 차량당 1개 귀속(`matchPlatesToSlots`) |
| 모듈 경계 | `web/` 5파일, `package.json`(빌드 없음, fastify-static 서빙) | `web/core.js` 는 순수 ESM — 브라우저 `app.js`·vitest(`test/*.test.ts`)·src(Node ESM + `core.d.ts` 타입) 모두에서 import 가능. **역방향(web→src)은 불가** |
| 파리티 관례 | `test/quadCentroidParity.test.ts`, `test/globalIdxParity.test.ts`, `src/ground/project.ts:3` | 같은 개념이 web/src 양쪽에 필요하면 **동일 정의 포팅 + 파리티 테스트로 고정**(D-1 교훈) |

---

## 1. 클래스 설계

### 1-1. 이름·배치

- **클래스명**: `OccupancyJudge`
- **파일**: 신규 `web/occupancy.js`(구현) + 신규 `web/occupancy.d.ts`(타입 선언, `core.d.ts` 관례와 동일 짝 구조)
- **배치 근거**:
  - 1차 소비처는 뷰어(`web/app.js`)이고, 뷰어는 빌드 없이 브라우저가 ESM 을 직접 로드한다 → 컴포넌트는 **plain JS ESM 이어야** 브라우저에서 쓸 수 있다. `src/*.ts` 배치는 뷰어에서 물리적으로 import 불가(탈락).
  - `web/` 배치 시 재사용성이 최대: 브라우저(o), vitest(o — 기존 테스트들이 `../web/core.js` 를 직접 import 하는 관례), src/Node(o — `.d.ts` 로 타입 확보). 즉 "잠재적 다른 소비처(백엔드 점유 산출 등)"도 `import { OccupancyJudge } from '../web/occupancy.js'` 로 소비 가능.
  - **`web/core.js` 안에 넣지 않고 별도 파일**로 두는 이유: (a) 요구 2 의 "독립 컴포넌트 — 단독 import" 를 파일 단위로 충족, (b) `core.js`/`core.d.ts` 를 **무변경 보장 대상**으로 유지해 회귀 표면을 0 으로.
- **의존**: `import { computeOccupancy, quadCentroid, pointInQuad } from './core.js'` 하나뿐. DOM·fetch·state 참조 0.

### 1-2. bbox 기하의 확보 — 파리티 포트 (충돌 사항, §7-1 에 명시)

bbox 폴백에 필요한 `groundBand`·`rectCorners`·`convexIntersectionArea`(+ `clipByHalfPlane`·`polygonArea`·`polygonCentroid`)·`area` 는 src(TS)에만 있고 브라우저는 이를 import 할 수 없다. 해결:

- `web/occupancy.js` 안에 **src 원본을 자구 그대로(동일 식) 포팅**하고 파리티 테스트로 고정한다(§5-2). 이 코드베이스의 확립된 관례(quadCentroid·normalizeGlobalIdx·projectCuboid 전례)이며, "신규 기하 금지"의 취지(새 기하 알고리즘 발명 금지)를 지키는 유일한 실행 가능 경로다.
- 포팅 함수는 `occupancy.js` 에서 **export** 한다(파리티 테스트용) — 단 `core.js` 에는 넣지 않는다(무변경 보장).
- 상수도 동일 값 재사용: `GROUND_BAND_RATIO=0.25`, `ON_PLACE_MIN_OVERLAP=0.15`(출처: `onPlaceFilter.ts` — 모드A 필터에서 실측 검증된 값).
- 기각한 대안: ① web 빌드 도입(과설계), ② `src/domain/polygon.ts` 를 web 재수출로 리팩토링(검증된 육면체 파이프라인 의존 모듈을 건드림 — 외과적 변경 원칙 위반), ③ bbox 하단중심 점 규칙(포팅 0줄이지만 onPlaceFilter 주석이 문서화한 원근 이탈 FP 재도입 + 필터(밴드 기준 통과)와 판정(점 기준 탈락)의 비일관 → 기각).

### 1-3. 생성자·공개 시그니처 (`web/occupancy.d.ts` 에 선언)

```ts
export interface OccupancyJudgeConfig {
  /** bbox 접지 근사 밴드 비율(하단 스트립). 기본 0.25 = src GROUND_BAND_RATIO. */
  groundBandRatio?: number;
  /** 밴드 면적 대비 슬롯 겹침 하한(이 미만이면 배정 안 함). 기본 0.15 = src ON_PLACE_MIN_OVERLAP. */
  minBandOverlap?: number;
}

export interface OccupancyJudgement {
  idx: number;                    // 바닥 폴리곤 전역 인덱스(입력 그대로)
  occupied: boolean;
  source: 'plate' | 'bbox' | null; // 판정 근거. null = 빈 면
  center?: NormalizedPoint;        // source==='plate' 일 때만: 번호판 중심(기존 computeOccupancy center 그대로)
  vehicleRect?: NormalizedRect;    // source==='bbox' 일 때만: 판정 근거 차량 bbox(정규화)
}

export class OccupancyJudge {
  constructor(cfg?: OccupancyJudgeConfig);   // 임계값은 여기 한 곳
  judge(
    floorPolygons: Array<{ idx: number; quad: NormalizedPoint[] }> | null | undefined,
    detect: {
      plates?: Array<{ quad: NormalizedPoint[] }> | null;
      vehicles?: Array<{ rect: NormalizedRect; plate?: { quad: NormalizedPoint[] } | null }> | null;
    } | null | undefined,
  ): OccupancyJudgement[];
}
```

- 메서드는 `judge` 하나. 상태 없음(생성자 config 만 보유) — 인스턴스 재사용/매 프레임 호출 안전.
- **union 을 클래스 내부로 이동**: 현재 `app.js:346` 이 조립하는 `plates ∪ vehicles[].plate` union 을 `judge` 가 내부에서 수행한다(`test/lpdFilterRegression.test.ts` 가 규정한 소비처 union 과 동일 식). 소비처는 `detect` 를 그대로 넘기면 된다 — union 누락 실수 여지 제거.
- graceful: `floorPolygons` null/비배열 → `[]`. `detect`/`plates`/`vehicles` 누락 → 각각 빈 배열 취급. throw 금지(기존 `computeOccupancy` 강등 철학 동일).
- 필드명 `center` 유지(마스터 예시의 `plateCenter` 대신): 기존 소비처(`occComputeByKey.spaces[].center`, `drawOccupancyOverlay`)가 `center` 를 그대로 읽으므로 마이그레이션 diff 최소 + plate 경로 무변경이 자명해진다. 의미는 동일(번호판 중심, plate 전용).

---

## 2. 판정 알고리즘 (슬롯별 plate > bbox 우선순위)

```
judge(floorPolygons, detect):
  vehicles ← detect.vehicles ?? []
  plateCandidates ← [...(detect.plates ?? []), ...vehicles.map(v=>v.plate).filter(Boolean)]   // 기존 union 그대로

  // ── 1단계: 번호판 (기존 경로 그대로 — 위임) ──
  base ← computeOccupancy(floorPolygons, plateCandidates)          // web/core.js 함수를 호출(재구현 금지)
  rows ← base.map(r => r.occupied ? {…r, source:'plate'} : {idx:r.idx, occupied:false, source:null})

  // ── 2단계: bbox 폴백 (1단계에서 비점유로 남은 슬롯만) ──
  candidates ← vehicles 중 [ plate 없음 ] OR [ quadCentroid(plate.quad)가 모든 floorPolygons 밖 ]
               // 후자 포함 이유: plate 중심이 기하적으로 폴리곤을 빗나간 차량도 점유는 사실 — bbox 로 구제.
               // plate 중심이 어떤 폴리곤 안에 든 차량은 1단계가 이미 소비 → 같은 차량의 이중 마킹 차단.
  for v in candidates:
    band ← groundBand(v.rect, groundBandRatio);  bandArea ← area(band)
    if bandArea ≤ 0: skip                         // 퇴화 rect — onPlaceFilter 와 동일 처리
    ratio_j ← convexIntersectionArea(rectCorners(band), floorPolygons[j].quad) / bandArea  (모든 j)
    j* ← argmax_j ratio_j                          // ★ 배정 = 최대 겹침 슬롯 단 1개
    if ratio_{j*} ≥ minBandOverlap: v 를 슬롯 j* 후보로 등록 (ratio 기록)

  for 슬롯 j (rows[j].occupied === false) with 후보 존재:
    best ← 후보 중 ratio 최대 차량                  // 한 슬롯 여러 후보 → 최대 겹침 1대를 근거로
    rows[j] ← { idx, occupied:true, source:'bbox', vehicleRect: best.rect }

  return rows
```

**결정 규칙 요약**:

| 규칙 | 내용 | 근거 |
|---|---|---|
| 우선순위 | 슬롯 단위 plate > bbox. 1단계 occupied 슬롯은 2단계가 절대 건드리지 않음 | 요구 1(a): 번호판이 보이면 번호판 기준 |
| bbox→슬롯 배정 | 접지 밴드(하단 25%) ∩ 슬롯 면적비 **argmax 1슬롯**, 하한 0.15 | onPlaceFilter 의 실측 검증 기준과 동일 식 — "필터 통과 차량은 반드시 어떤 슬롯에 ≥0.15" 이므로 필터↔판정 일관. argmax 이므로 2슬롯 걸침 차량이 2면을 점유시키지 않음 |
| 2슬롯 경계 | 걸친 차량은 겹침 최대 슬롯 하나만 점유. ratio 동률 → `floorPolygons` 배열 앞 슬롯(결정적) | 이중 점유(FP) 방지. 동률은 실질 발생 확률 0 이나 결정성 보장 |
| 한 슬롯 여러 bbox | occupied 1회, `vehicleRect` = 겹침비 최대 차량 | 표시 근거 1개면 충분 — 과설계 배제 |
| plate 보유 차량의 plate 가 폴리곤 밖 | 그 차량은 2단계 후보로 포함(bbox 구제) | 점유 놓침(FN) 방지 우선. §7-6 트레이드오프 명시 |
| 임계값 | `groundBandRatio=0.25`, `minBandOverlap=0.15` — 생성자 한 곳. goal/loop 에서 실측 튜닝 가능 | 검증된 기존 값에서 출발 |
| det 신뢰도 하한 | 컴포넌트에서 **미적용** | detectPipeline 이 이미 신뢰도 컷·모드A 필터를 수행 — 이중 필터는 추측성 기능(§7-2) |

---

## 3. 결과 shape 와 소비처 표현

`OccupancyJudgement[]`(§1-3). 세 상태가 구분 표현된다:

| 상태 | occupied | source | 부가 필드 | 오버레이 권고(goal/loop 에서) |
|---|---|---|---|---|
| 번호판 점유 | true | `'plate'` | `center` | 기존 그대로: 빨간 원(#ff4d4d) + id — **무변경** |
| 점유·번호 미인식 | true | `'bbox'` | `vehicleRect` | 신규: 주황 원(예: #ff9f1a) at `vehicleRect` 하단 중심 + id — 소비처가 rect 로 자유 표현 |
| 빈 면 | false | `null` | — | 표시 없음(기존과 동일) |

- 마이그레이션 안전장치: `drawOccupancyOverlay` 는 `occupied && center` 만 그리므로, 오버레이를 아직 안 고쳐도 plate 행은 기존과 픽셀 단위 동일하게 그려지고 bbox 행은 그냥 안 보인다(깨짐 없음). source 별 표시는 goal/loop 루프에서 추가·실측 확인.

## 4. 기존 `computeOccupancy` 와의 관계 — **래핑(위임)** 채택

- **대체(삭제)** 기각: `test/computeOccupancy.test.ts`·`test/lpdFilterRegression.test.ts`·`test/occupancy.test.ts` 와 `core.d.ts` 계약이 걸려 있음 — 회귀 표면만 늘린다.
- **마이그레이션(소비처별 점진 이행)** 기각: 소비처가 `updateLogicOccupancy` 하나뿐이라 점진 이행이 무의미.
- **래핑 채택**: `OccupancyJudge.judge` 1단계가 `computeOccupancy` 를 **그대로 호출**한다(재구현·복사 금지).

**회귀 0 의 구조적 논증**: bbox 후보가 없거나 vehicles 가 비어 있으면 2단계는 no-op 이고, 결과는 `computeOccupancy(floorPolygons, plateCandidates)` 의 각 행에 `source` 필드만 얹은 것과 **항등**이다 — plate 경로는 별도 구현이 아니라 기존 함수 그 자체이므로, "번호판만 있을 때 기존과 동일"은 테스트로 확인하는 성질이 아니라 코드 구조가 보장하는 성질이다(그래도 §5 T1 파리티 테스트로 이중 고정). 1단계 union 식 또한 `app.js:346`/`lpdFilterRegression` 의 규정 식과 동일.

## 5. 독립성·테스트 전략

### 5-1. 순수성 논증
- 입력(폴리곤·검출) → 출력(판정 배열)만 존재. DOM·fetch·전역 state·Date·랜덤 참조 0. import 는 `./core.js` 의 순수 함수 3개뿐(core.js 자체가 브라우저 API 미참조 순수 ESM — 기존 테스트 관례로 입증).
- 따라서 vitest 에서 `import { OccupancyJudge } from '../web/occupancy.js'` 단독 import·모킹 0 으로 테스트 가능. src(Node)에서도 동일하게 소비 가능.

### 5-2. vitest 항목 (신규 `test/occupancyJudge.test.ts` + `test/occupancyGeometryParity.test.ts`)

| # | 테스트 | 검증 기준 |
|---|---|---|
| T1 | **번호판만**(vehicles 빈/미보유) | 결과가 `computeOccupancy` 직접 호출과 idx·occupied·center 전부 동치 + occupied 행 source='plate' — 회귀 0 |
| T2 | **bbox만**(plate 전무) | 밴드 겹침 argmax 슬롯만 occupied·source='bbox'·vehicleRect 일치, 겹침 <0.15 차량은 미점유 |
| T3 | **둘 다**: 슬롯 A 에 plate + 같은 차량 bbox | A 는 source='plate'(우선순위), 그 차량이 다른 슬롯을 추가 점유하지 않음 |
| T4 | **둘 다 없음** | 전 슬롯 `{occupied:false, source:null}` |
| T5 | **bbox 2슬롯 경계**: 밴드가 두 슬롯에 걸침 | argmax 한 슬롯만 occupied. 정확 동률 입력 → 배열 앞 슬롯(결정성) |
| T6 | **우선순위 혼합**: standalone plate 가 슬롯 X, 무번호판 차량 bbox 가 슬롯 Y | X=plate·Y=bbox 로 병존 |
| T7 | plate 중심이 모든 폴리곤 밖인 plate 보유 차량 | 2단계로 넘어가 bbox 판정됨(§2 candidates 규칙) |
| T8 | 한 슬롯 bbox 후보 2대 | occupied 1회, vehicleRect=겹침 최대 차량 |
| T9 | graceful: null/비배열/퇴화 rect(h=0) | `[]` 또는 해당 차량 skip, throw 없음 |
| T10 | **기하 파리티**: 포팅된 `groundBand`·`rectCorners`·`convexIntersectionArea`·`area` ≡ src 원본 | 고정 케이스 + 다수 좌표 조합에서 수치 일치(기존 `quadCentroidParity` 패턴) |

### 5-3. goal/loop 경험적 검증(구현 단계 안내)
Goal: 라이브 프레임에서 (a) 번호판 보유 주차차 = 빨간 원(기존과 동일 위치), (b) 번호판 미인식 주차차 = bbox 근거 점유 표시, (c) 통로 통행차·빈 면 = 무표시. Loop: 검출 → 오버레이 스샷 → 오배정(옆 칸 점유/통행차 FP) 발견 시 `minBandOverlap` 튜닝 또는 배정 규칙 재분석.

## 6. 영향도

| 대상 | 영향 | 내용 |
|---|---|---|
| `web/occupancy.js` · `web/occupancy.d.ts` | **신규** | 클래스 + 포팅 기하(export) |
| `web/app.js` | 수정(소) | `updateLogicOccupancy`: union 조립 제거, `judge(floorPolys, detect)` 호출로 교체, spaces 에 source·vehicleRect 통과. `drawOccupancyOverlay`: plate 경로 무변경, source='bbox' 표시 추가(goal/loop) |
| `web/core.js` / `web/core.d.ts` | **무변경 보장** | `computeOccupancy`·`quadCentroid`·`pointInQuad` 존치(위임 대상) |
| `src/capture/detectPipeline.ts`·`onPlaceFilter.ts`·`src/domain/*` | **무변경 보장** | 검출·필터 경로 불가침(제약). onPlaceFilter 의 "(B) 점유 회귀 0" 논증은 plate 1단계가 `computeOccupancy` 그대로이므로 계속 유효 — bbox 2단계는 번호판을 소비하지 않으므로 무관 |
| 기존 테스트(`computeOccupancy`·`occupancy`·`lpdFilterRegression`) | **무변경 통과** | 대상 함수 존치 |
| 문서 참조(정합성) | documenter 갱신 | `lpdFilterRegression.test.ts` 주석의 union 소비처 라인 참조(`app.js:335`)가 occupancy.js 로 이동 후 낡음 — 주석/문서 갱신 대상으로 인계 |
| MCP 경계 | 판정 완료 | 본 컴포넌트는 수치 반복·결정형 로직 → **결정형 도구 측**(LLM 두뇌 아님). LLM 관여 지점 없음 |

## 7. 미해결 / 가정 (조용히 선택하지 않음 — 리더 확인 요망)

1. **[충돌] "신규 기하 금지" vs 브라우저 경계**: bbox 기하는 src(TS)에만 있어 뷰어에서 직접 재사용이 물리적으로 불가. → **동일 정의 파리티 포트**(T10 으로 고정)로 해석했다. 이 해석(코드베이스 확립 관례)이 마스터 의도와 다르면(예: web 빌드 도입 허용) 배치 재설계 필요.
2. **det 신뢰도 하한**: 컴포넌트 미적용(파이프라인이 이미 컷). 라이브에서 저신뢰 거대 병합 박스가 bbox 점유 FP 를 만들면 goal/loop 에서 `minConfidence` 옵션 추가를 재논의(지금 넣는 것은 추측성 기능).
3. **접지 기준**: `groundBand`(하단 25%) 채택 — onPlaceFilter 실측 검증 기준과 동일 식이라는 일관성이 근거. 점유 판정에서 다른 비율이 나을 수 있음 → 생성자 config 로 goal/loop 튜닝.
4. **동률 tie-break** = `floorPolygons` 배열 앞 슬롯. 실측상 무의미하나 결정성 명문화.
5. **바닥 폴리곤 0개**: `[]` 반환 — 현 소비처(`updateLogicOccupancy`)가 폴리곤 없으면 호출 자체를 skip 하므로 동작 동일. onPlaceFilter 식 "강등 플래그"는 소비처가 없어 미도입.
6. **plate 보유 차량의 plate 중심이 폴리곤 밖**: bbox 로 구제(점유 FN 방지 우선). 이때 source='bbox' 라 UI 상 "번호 미인식"으로 보이지만 실제로는 번호판이 인식된 차량일 수 있음 — 표시 의미론 트레이드오프. 엄격 해석(plate 보유 차량은 2단계 제외)을 원하면 candidates 규칙 한 줄 변경으로 대응 가능.

## 8. 구현 단계 (구현자 인계)

```
1. web/occupancy.js: 기하 파리티 포트(groundBand·rectCorners·convexIntersectionArea 계열·area, export)
   → 검증: test/occupancyGeometryParity.test.ts (T10) 통과
2. web/occupancy.js: OccupancyJudge 클래스(§1-3 시그니처, §2 알고리즘 — 1단계는 computeOccupancy 호출)
   + web/occupancy.d.ts
   → 검증: test/occupancyJudge.test.ts T1~T9 통과 + `npm run typecheck`
3. web/app.js: updateLogicOccupancy 교체(§6) — drawOccupancyOverlay 는 이 시점 무수정
   → 검증: 기존 전체 vitest 무변경 통과(특히 computeOccupancy·lpdFilterRegression) + 라이브 뷰어에서 번호판 점유 원이 기존과 동일 위치(스샷 비교)
4. drawOccupancyOverlay 에 source='bbox' 표시 추가 → goal/loop: 라이브 스샷으로 §5-3 Goal 충족까지 반복
   → 검증: 번호판 미인식 주차차 표시·통행차 무표시 실측 확인
```
