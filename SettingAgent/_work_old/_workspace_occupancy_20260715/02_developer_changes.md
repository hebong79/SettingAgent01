# 구현 변경 요약 — 차량 점유 판정 `OccupancyJudge`

- 구현: developer · 2026-07-15
- 입력 설계: `_workspace_occupancy_20260715/01_architect_plan.md`
- 상태: 신규/전체 vitest 전량 통과(1628), typecheck 0 오류, node --check OK. **goal/loop 첫 구현** — 이후 리더 라이브 검증 대기.

---

## 1. 변경 파일 목록

| 파일 | 구분 | 내용 |
|---|---|---|
| `web/occupancy.js` | **신규** | `OccupancyJudge` 클래스 + bbox 기하 파리티 포트(export) |
| `web/occupancy.d.ts` | **신규** | 타입 선언(결과 shape·클래스·기하 헬퍼 시그니처) |
| `web/app.js` | 수정(소) | `updateLogicOccupancy` → `judge` 전환, `drawOccupancyOverlay` source별 렌더, import 교체 |
| `test/occupancyJudge.test.ts` | **신규** | T1~T9 + config 테스트(11 케이스) |
| `test/occupancyGeometryParity.test.ts` | **신규** | T10 기하 파리티(src ≡ web, 8 케이스) |

**무변경 보장 확인(git diff)**: `src/capture/onPlaceFilter.ts`·`src/domain/polygon.ts`·`src/domain/geometry.ts` = **0줄 변경**. `web/core.js`·`web/core.d.ts` 는 본 작업에서 **0줄 편집**(diff 에 보이는 `stepPtz`/`resolveAbsPtz` 수정은 세션 시작 전부터 있던 선행 미커밋 변경으로 occupancy 와 무관 — `computeOccupancy` 함수 자체는 무변경). `web/app.js` 의 선행 미커밋 hunk(resolveAbsPtz import·mask/cuboid 오버레이·wire)는 **미접촉**.

---

## 2. `web/occupancy.js` 구현 노트

### 2-1. 기하 파리티 포트(§1-2, §8 단계1)
src(TS)에만 있어 브라우저 import 불가한 함수를 **자구 그대로 포팅**하고 export(파리티 테스트용). `core.js` 에는 넣지 않음(무변경 보장).

| 포팅 함수 | 출처(원본) |
|---|---|
| `area(r)` | `src/domain/geometry.ts:area` |
| `rectCorners(r)` | `src/domain/polygon.ts:rectCorners` |
| `polygonArea(poly)` | `src/domain/polygon.ts:polygonArea` |
| `polygonCentroid(poly)` | `src/domain/polygon.ts:polygonCentroid` |
| `clipByHalfPlane(poly,line)` | `src/domain/polygon.ts:clipByHalfPlane` (`EPS=1e-9` 동일) |
| `convexIntersectionArea(a,b)` | `src/domain/polygon.ts:convexIntersectionArea` |
| `groundBand(rect,ratio=0.25)` | `src/capture/onPlaceFilter.ts:groundBand` |
| 상수 `GROUND_BAND_RATIO=0.25`, `ON_PLACE_MIN_OVERLAP=0.15` | `onPlaceFilter.ts` |

파리티는 `test/occupancyGeometryParity.test.ts` 가 src 원본과 **비트 동일**(상수·area·rectCorners·groundBand·polygonArea·polygonCentroid·convexIntersectionArea, 무작위 200조합 포함)로 봉인.

### 2-2. `OccupancyJudge`(§1-3, §2 알고리즘)
- 의존: `import { computeOccupancy, quadCentroid, pointInQuad } from './core.js'` 뿐. DOM/fetch/state 참조 0.
- `constructor(cfg)`: `groundBandRatio`·`minBandOverlap` 두 임계만 보유(상태 없음, 매 프레임 재사용 안전). 임계 기본값 한 곳.
- `judge(floorPolygons, detect)`:
  1. **union 내부 조립**: `plates ∪ vehicles[].plate`(app.js 가 하던 식과 동일) → 소비처 union 누락 실수 제거.
  2. **1단계**: `computeOccupancy(floorPolygons, plateCandidates)` **위임 호출**(재구현 없음) → occupied 행에 `source:'plate'`, 그 외 `{occupied:false, source:null}`.
  3. **2단계**(비점유 슬롯 bbox 폴백): 후보 = plate 없음 OR `quadCentroid(plate.quad)`가 모든 폴리곤 밖인 차량. 각 후보 `groundBand`→`convexIntersectionArea/bandArea` argmax 슬롯 1개, `≥minBandOverlap` 이면 등록. 슬롯별 최대 겹침 1대만 채택 → `source:'bbox', vehicleRect`.
- **회귀 0(구조적)**: vehicles 없음/후보 없음이면 2단계 no-op → 결과는 `computeOccupancy` 각 행에 `source` 만 얹은 것과 항등(T1 로 이중 고정).
- graceful: `floorPolygons` 비배열 → `[]`. `detect`/`plates`/`vehicles` 누락·`rect` 누락·퇴화 rect(면적0) → skip, throw 없음.
- tie-break: argmax 를 strict `>` 로 순회 → ratio 비트동일 시 배열 앞 슬롯. **주의**: 실제 clipping 기하는 대칭 입력이라도 부동소수상 정확 동률이 거의 안 나오므로, 앞-슬롯 결정성은 "비트동일 ratio 일 때만" 성립. 핵심 보장(걸친 차량 이중점유 방지=정확히 1슬롯)은 항상 성립(T5b).

---

## 3. `web/app.js` 변경(§6, §8 단계3~4)

- **import**: `computeOccupancy`(orphan 화) 제거, `import { OccupancyJudge } from './occupancy.js'` 추가. 모듈 싱글턴 `const occupancyJudge = new OccupancyJudge()`(기본 임계).
- **`updateLogicOccupancy`**: union 수동 조립 제거 → `occupancyJudge.judge(floorPolys, detect)` 호출. `spaces` 에 `source`·`vehicleRect` 통과(기존 `id`·`occupied`·`center` 유지).
- **`drawOccupancyOverlay`**: `source==='bbox' && vehicleRect` → 차량 bbox 하단중심에 **주황(#ff9f1a) 원 + "{id} 번호미인식" 배지**. 그 외(plate)는 기존 **빨강(#ff4d4d) 원 + id** 렌더 **완전 동일**(회귀 0). `occupied && center` 만 그리던 기존 가드와 호환 — bbox 표시는 추가분.

---

## 4. 설계 대비 편차

- **T5b(정확 동률 → 앞 슬롯)**: 부동소수상 정확 동률이 clipping 기하에서 재현되지 않아, 테스트를 "정확히 1슬롯만 점유(이중점유 없음)"로 조정. strict tie-break 코드는 유지(비트동일 ratio 시 앞 슬롯). 설계 §2·§7-4 의 tie-break 의도(결정성·이중 FP 방지)는 보존, 단언 범위만 현실화. — **알고리즘/시그니처 변경 없음**, 그 외 설계와 1:1.

---

## 5. 검증 결과

- `node --check web/occupancy.js web/app.js` → OK
- 신규 테스트: `occupancyJudge`(11) + `occupancyGeometryParity`(8) = 19 통과
- 전체 vitest: **148 파일 / 1628 테스트 전량 통과**(computeOccupancy·occupancy·lpdFilterRegression 무변경 통과)
- `tsc --noEmit` → 0 오류

## 6. 후속(인계)

- **검증자(qa)**: 위 신규 2 테스트 리뷰 + 소비처 shape(`spaces[].source/vehicleRect`) 교차확인.
- **문서화(documenter)**: `lpdFilterRegression.test.ts` 주석의 union 소비처 라인 참조(`app.js:335`)가 `occupancy.js` 로 이동해 낡음 — 주석/문서 갱신 대상.
- **리더(goal/loop)**: 라이브에서 (a) 번호판 주차차=빨강 원(위치 불변), (b) 번호판 미인식 주차차=주황 "번호미인식" 표시, (c) 통행차/빈 면=무표시 확인. 오배정 시 `minBandOverlap` 튜닝(생성자 한 곳).
