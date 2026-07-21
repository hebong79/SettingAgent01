# 영향도 분석 — `OccupancyJudge`(번호판 우선 · bbox 폴백 점유 판정)

- 작성: documenter · 2026-07-15 22:29
- 근거: `01_architect_plan.md`·`02_developer_changes.md` + 실제 소스 확인 + documenter 실측(전체 vitest 148/1628 통과 재확인)
- 최종 문서: `SettingAgent/docs/20260715_222920_점유판정컴포넌트.md`

---

## 1. 변경 표면 (신규 / 수정 / 무변경 보장)

| 대상 | 구분 | 내용 |
|---|---|---|
| `web/occupancy.js` | **신규** | `OccupancyJudge` 클래스 + bbox 기하 파리티 포트(export) |
| `web/occupancy.d.ts` | **신규** | 결과 shape·클래스·기하 헬퍼 타입 선언 |
| `web/app.js` | **수정(소)** | ① import: `computeOccupancy` 제거 → `OccupancyJudge` 추가 + 모듈 싱글턴 `occupancyJudge` ② `updateLogicOccupancy`: union 조립 제거, `judge()` 호출, `source`·`vehicleRect` 통과 ③ `drawOccupancyOverlay`: source='bbox' 주황 배지 추가(plate 경로 무변경) |
| `test/occupancyJudge.test.ts` | **신규** | 11 케이스 |
| `test/occupancyGeometryParity.test.ts` | **신규** | 8 케이스(src ≡ web 파리티) |
| `web/core.js` · `web/core.d.ts` | **무변경 보장** | `computeOccupancy`·`quadCentroid`·`pointInQuad` = 위임 대상. 본 작업 0줄 편집 |
| `src/capture/onPlaceFilter.ts` · `src/domain/polygon.ts` · `src/domain/geometry.ts` | **무변경 보장** | 검출·필터·기하 원본. git diff 0줄. 파리티 테스트의 비교 대상 |
| `src/capture/detectPipeline.ts` | **무변경 보장** | 검출 데이터 shape(`DetectVehicle`·`DetectResult.plates`) 소비만, 편집 없음 |
| `onPlaceFilter`(모드A 필터 경로) · domain 타입 | **0줄** | 아래 §3 논증 |

> 주의(구현자 인계 확인): `web/core.js`·`web/app.js` 의 git diff 에 보이는 `stepPtz`/`resolveAbsPtz`/mask·cuboid 오버레이 hunk 는 **본 작업 이전의 선행 미커밋 변경**으로 occupancy 와 무관하다. `computeOccupancy` 함수 자체는 무변경이다.

---

## 2. 파리티 포트의 이중 정의 리스크와 방어

`web/occupancy.js` 는 src(TS)에만 있던 기하 함수(`area`·`rectCorners`·`polygonArea`·`polygonCentroid`·`clipByHalfPlane`·`convexIntersectionArea`·`groundBand`)와 상수(`GROUND_BAND_RATIO`·`ON_PLACE_MIN_OVERLAP`)를 **자구 그대로 복제**한다. 브라우저 ESM 이 `src/*.ts` 를 import 할 수 없기 때문이다(web → src 역방향 불가).

**리스크**: 동일 개념이 web/src 두 곳에 존재 → 한쪽만 수정되면 점유가 **조용히** 뒤집힌다(가장 위험한 종류의 회귀 — 무증상).

**방어**: `test/occupancyGeometryParity.test.ts` 가 src 원본과 web 포트의 출력을 **비트 동일**로 봉인한다:
- 상수 2종, `area`·`rectCorners`·`groundBand`·`polygonArea`·`polygonCentroid`·`convexIntersectionArea` 고정 케이스
- 무작위 rect×poly **200 조합** 겹침 면적 일치
- 향후 어느 쪽 정의가 갈리면 이 테스트가 즉시 실패 → CI 게이트에서 차단.

이는 코드베이스의 확립된 관례(`quadCentroidParity`·`globalIdxParity` 전례)와 동일한 D-1 봉인 패턴이다.

**후속 유지보수 주의**: `onPlaceFilter.ts` 의 `groundBand`/임계나 `polygon.ts` 의 겹침 기하를 수정하는 향후 작업은 반드시 `web/occupancy.js` 를 동반 수정해야 한다(파리티 테스트가 알려주지만, 인지 자체가 유지보수 비용).

---

## 3. 점유 경로 변경이 검출 · 마스크 · 필터에 무영향임을 논증

점유 판정은 파이프라인의 **소비단(consumer) 말단**이다. 데이터 흐름:

```
detectPipeline(검출·신뢰도컷·모드A필터) → state.detectByKey → [updateLogicOccupancy] → occComputeByKey → [drawOccupancyOverlay]
                                                                  ▲ 여기만 변경
```

- **검출(detectPipeline)**: `OccupancyJudge` 는 `detect`(vehicles·plates)를 **읽기만** 한다. 검출 로직·shape·신뢰도 컷은 상류이며 편집 0줄. `judge` 는 신뢰도 하한을 자체 적용하지 않음(이중 필터 배제) → 검출 결과를 변형하지 않는다.
- **마스크/육면체**: 설계 제약대로 seg 마스크·3D 육면체를 **불사용**. `web/app.js` 의 mask/cuboid 오버레이 코드는 미접촉(별개 선행 변경). 점유 경로는 마스크 산출과 독립.
- **모드A 필터(onPlaceFilter)**: `onPlaceFilter.ts` 0줄 변경. 그 파일의 "(B) 점유 회귀 0" 논증은 **plate 1단계가 `computeOccupancy` 그대로**이므로 계속 유효하다. bbox 2단계는 **번호판을 소비하지 않으므로**(plate union 은 1단계만 사용) 필터 회귀 논증과 무관.
- **`onPlaceFilter`·domain 타입 0줄**: bbox 폴백에 필요한 기하는 src 를 건드리지 않고 web 으로 포팅(파리티)해서 확보 → 원본 모듈 불가침.

**결론**: 변경은 `updateLogicOccupancy`/`drawOccupancyOverlay` 두 함수와 신규 2파일에 **국소화**되며, 상류(검출·필터·마스크)로의 파급 경로가 구조적으로 존재하지 않는다.

---

## 4. 기존 테스트 · 계약에 대한 영향

- **회귀 0 실증**(documenter 재실행): 전체 vitest **148 파일 / 1628 테스트 전량 통과**. `computeOccupancy.test`·`occupancy.test`·`lpdFilterRegression.test` 무변경 통과.
- **`core.d.ts` 계약**: `computeOccupancy` 반환 shape(`{idx, occupied, center?}`) 무변경 → 계약 소비자 영향 0.
- **낡은 참조(정합성 갱신 필요)**: `test/lpdFilterRegression.test.ts` 주석이 union 소비처를 `web/app.js:335` 로 지목하나, union 이 `web/occupancy.js:judge` 내부로 이동해 라인이 낡음. **동작 영향 없음**(주석일 뿐, 테스트는 통과) — 후속 주석 갱신 대상.

---

## 5. 소비처 데이터 shape 교차 확인

`updateLogicOccupancy` → `state.occComputeByKey[key].spaces[]` 항목:

| 필드 | 출처(`OccupancyJudgement`) | 소비처(`drawOccupancyOverlay`) |
|---|---|---|
| `id` | `idx` | 배지 텍스트 |
| `occupied` | `occupied` | 렌더 여부 가드 |
| `source` | `source` | plate/bbox 분기 |
| `center` | `center`(plate 전용) | 빨강 원 위치 |
| `vehicleRect` | `vehicleRect`(bbox 전용) | 주황 원 위치(하단 중심) |

`source`·`vehicleRect` 는 신규 추가 필드. 기존 필드(`id`·`occupied`·`center`) 의미·타입 불변 → 다른 소비처(있다면)는 신규 필드를 무시하면 기존과 동일 동작.

---

## 6. 후속 · 확인 필요 항목

1. **라이브 브라우저 육안 관찰**: source 별 렌더(plate=빨강 / bbox=주황 "번호미인식")를 실 프레임에서 확인. 리더 실측(cam1/preset1: 정상 7/7 plate, 번호판 제거 시 6/6 bbox 폴백)은 완료 — 브라우저 육안 상시 관찰은 계속.
2. **번호판 실제 미검출 케이스**: LPD 가 실제로 놓친 주차 차량에서 bbox 폴백이 옆 칸 오배정 없이 점유를 잡는지 관찰. 오배정 시 `minBandOverlap` 튜닝(생성자 한 곳).
3. **주석 정합**: `lpdFilterRegression.test.ts` 의 `app.js:335` union 참조 갱신(동작 무영향).
4. **파리티 유지보수 규약**: 향후 `onPlaceFilter`/`polygon.ts` 기하 수정 시 `web/occupancy.js` 동반 수정 필수(파리티 테스트가 게이트).
