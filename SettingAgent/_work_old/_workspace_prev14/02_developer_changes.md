# 02 · 구현 변경 노트 — LPD 실패 슬롯의 "이웃 번호판" 기반 예상 quad → floor ROI

작성: developer / 대상: SettingAgent / 입력: `_workspace/01_architect_plan.md`(리더가 3개 게이트 기본값 전부 승인)

승인된 게이트:
- 게이트1: 이웃 선택 = **위치 최근접 1개**(median 아님).
- 게이트2: 예상 추정 트리거 = **번호판 완전 부재**(plateQuad·plate rect 둘 다 없음). rect-only 구데이터는 제외(기존 rectToQuad 경로 유지).
- 게이트3: 예상 quad 는 **floor ROI 생성에만** 사용. `plateRoiByPreset` 저장·`deconflictPolygons` 의 plate 인자에는 미주입.

---

## 1. 변경 파일 목록

| 파일 | 변경 유형 | 요지 |
|------|-----------|------|
| `src/capture/floorRoi.ts` | 신규 export(추가만) | `PlateNeighbor` 인터페이스 + `estimatePlateQuadFromNeighbors` 순수 헬퍼 |
| `src/capture/FloorRoiReviewer.ts` | 호출부 배선 | 이웃 수집 + 트리거 + `effQuad` 를 recognize/resolve 양쪽에 전달 |
| `src/capture/Finalizer.ts` | 호출부 배선 | 폴백 `buildPlateAnchoredQuad(rect, m.plateQuad ?? estimated ?? undefined)` |
| `config/prompts/floor_roi.yaml` | 프롬프트 보강 1문장 | system 규칙 7(이웃 미검출 시 주변 참고) 추가 |
| `test/estimatePlateFromNeighbors.test.ts` | 신규 유닛 | §9 불변식 8종 |

시그니처 무변경: `buildPlateAnchoredQuad`/`resolveFloorPolygon`/`recognizeFloorRoi` 계약 그대로. 저장 스키마(`AggregatedSlot`/`ParkingSlot`/DB) 무변경.

---

## 2. 신규 헬퍼 시그니처·알고리즘 (`floorRoi.ts`)

```ts
export interface PlateNeighbor { vehicle: NormalizedRect; plateQuad: NormalizedQuad; }

export function estimatePlateQuadFromNeighbors(
  vehicle: NormalizedRect,
  neighbors: readonly PlateNeighbor[],
): NormalizedQuad | undefined
```

배치: `predictPlateRect` 바로 아래(계획 §1 지정 위치). 기존 import 재사용(`plateAngleRad`, `projectedSpan`, 로컬 `clamp01`) — 신규 import 없음.

알고리즘(전부 결정형, 정규화 0~1 일관):
1. **최근접 이웃 선택**: `vehicle` 중심과 각 이웃 중심의 정규화 유클리드 거리 제곱 argmin 1개. `n.vehicle.w < 1e-6 || n.vehicle.h < 1e-6` 인 degenerate 이웃은 스킵. 유효 이웃 0개면 `undefined` 반환.
2. **이웃에서 산출**: `θ = plateAngleRad(qN)`; 번호판 중심 `pcN`(4점 평균); 상대오프셋 `rx=(pcN.x−nv.x)/nv.w`, `ry=(pcN.y−nv.y)/nv.h`; 로컬축 `right=(cosθ,sinθ)`, `down=(−sinθ,cosθ)`; 상대크기 `rw=projectedSpan(qN,right)/nv.w`, `rh=projectedSpan(qN,down)/nv.h`.
3. **target 적용**: `pcT={vehicle.x+rx·w, vehicle.y+ry·h}`, 반폭 `hw=rw·w/2`, 반높이 `hh=rh·h/2`.
4. **quad 합성**(각 점 `clamp01`): `TL=corner(−1,−1)`, `TR=corner(+1,−1)`, `BR=corner(+1,+1)`, `BL=corner(−1,+1)` (부호=right,down 축 계수). → TL,TR,BR,BL 규약.

라운드트립(계획 §2-5): 합성 quad 를 `buildPlateAnchoredQuad`/`resolveFloorPolygon` 에 넘기면 내부 `plateAngleRad`·`projectedSpan`·centroid 가 θ·wp·hp·pc 를 정확 복원 → 빌더/리졸버 무변경으로 각도 추종. 유닛테스트로 `plateAngleRad(estimate) ≈ θ`(6자리) 확인.

---

## 3. 두 호출부 배선

### 3-1. `FloorRoiReviewer.review()`
- import 에 `estimatePlateQuadFromNeighbors, PlateNeighbor`(+ 타입 `NormalizedQuad`) 추가.
- 슬롯 루프 내: `plate === undefined && plateQuad === undefined` 일 때만 `candidates` 에서 같은 `presetKey`·self 제외·`plateQuad` 보유 이웃을 `PlateNeighbor[]` 로 모아 `estimated` 계산.
- `const effQuad = plateQuad ?? estimated;` → `recognizeFloorRoi` 의 `plateQuad` 인자(`...(effQuad?{plateQuad:effQuad}:{})`)와 `resolveFloorPolygon(polyRaw, vehicle, effQuad, plate)` **양쪽 동일 전달**.
- `plate`(rect) 인자는 그대로 **실측만**(예상은 rect 로 위조 안 함). 리졸버 containTarget 은 `plate ?? quadBoundingRect(effQuad)` 로 예상 quad 를 포함강제(기존 로직).

### 3-2. `Finalizer.assemble()`
- import 에 `estimatePlateQuadFromNeighbors, PlateNeighbor`(+ 타입 `NormalizedQuad`) 추가.
- `positioned` map 내: `m.plateQuad == null && plateRect === undefined` 일 때만 같은 프리셋 그룹 `members`(byPreset 그룹이라 presetKey 필터 불필요)에서 self 제외·`plateQuad` 보유 이웃으로 `estimated` 계산.
- 폴백: `floorByRef.get(clusterRef(m)) ?? buildPlateAnchoredQuad(rect, m.plateQuad ?? estimated ?? undefined)`.
- **불변 유지**: `plateRoiByPreset` 은 `p.plateRect` 존재 시에만 저장(실측만) — 예상 quad 미저장. `deconflictPolygons` 의 `plate` 인자는 `p.plateRect`(실측만) 그대로 — 예상 quad 미주입. → 게이트3 준수(번호판 데이터 위조 방지).

---

## 4. 폴백 우선순위 (코드로 보장)

```
effectivePlateQuad = 실측 plateQuad          // 1순위(있으면 즉시, 추정 미실행)
                  ?? 이웃추정 plateQuad        // 2순위(번호판 완전 부재 + 유효 이웃 ≥1)
                  ?? undefined                 // 3순위(이웃 0 또는 전부 degenerate)
// 빌더 내부: plateQuad ?? rectToQuad(predictPlateRect), θ = plateQuad ? angle : 0
```
- 트리거 조건이 `plate 부재 && plateQuad 부재` 이므로 실측 plateQuad 존재 시 추정 자체를 실행하지 않음(1순위 자동).
- Reviewer: `plateQuad ?? estimated`. Finalizer: `m.plateQuad ?? estimated ?? undefined`.
- 이웃 0개 → `estimated=undefined` → 기존 코드 경로와 **바이트 동일**(predictPlateRect + θ=0). 신규 분기 무진입.

---

## 5. 프롬프트 (`config/prompts/floor_roi.yaml`)

system 규칙 6 아래에 규칙 7 한 문장만 추가(전면 재작성 아님, 출력 스키마·좌표규약·4점 규칙 무변경):
> 7. 번호판이 주어지지 않으면(`(없음)`), 주변 차량들의 번호판 각도·위치를 시각적으로 참고해 이 차량의 예상 번호판 위치를 잡고, 그 각도·좌우중앙 기준으로 점유영역을 그린다.

계획 §5 결론대로 user 템플릿에 neighborPlates 주입 안 함(결정형이 `{{plateQuad}}` 로 이미 구체 quad 를 주입하므로 중복; 규칙 7 은 이웃 0개 잔여 케이스 소프트 가드레일).

---

## 6. 계획 대비 편차

없음. 계획을 그대로 구현. `PlateNeighbor` 필터에서 `n.plateQuad!` non-null 단언은 filter 술어(`n.plateQuad` truthy) 뒤라 안전(TS narrowing 이 map 콜백까지 이어지지 않아 명시).

발견한 설계 결함: 없음.

---

## 7. QA 검증 포인트

- **각도 추종**: 이웃 quad 각도 θ → `plateAngleRad(estimate) ≈ θ`(±1e-2 rad); estimate 로 만든 floor ROI 앞변 각도 ≈ θ(`plateAnchoredQuadInvariants` frontEdgeAngle 방식).
- **상대오프셋 반영**: estimate 중심 bbox 내 분수위치 `(rx,ry)` ≈ 이웃 `(rx,ry)`(bbox 위치·크기 달라도 스케일 불변).
- **상대크기 반영**: estimate 로컬 `wp,hp` = 이웃 비율 × target bbox.
- **위치 최근접**: 서로 다른 각도 이웃 2개일 때 더 가까운 이웃 각도 채택.
- **이웃 0개 = 현행 동일**: `estimated=undefined` → `resolveFloorPolygon(..., undefined)`/`buildPlateAnchoredQuad(rect, undefined)` = 현행과 바이트 동일(회귀 그린으로 확인).
- **게이트3 미오염**: `plateRoiByPreset` 은 실측 plateRect 있는 슬롯만 저장(예상 quad 미저장); `deconflictPolygons` plate 인자 실측만.
- **degenerate 방어**: 이웃 `nv.w/h ≈ 0` 스킵; 전부 degenerate → undefined.
- **quad 유효성**: 반환 4점·전부 0~1·TL,TR,BR,BL 각도 라운드트립.

---

## 8. 검증 결과

- `npx tsc -p tsconfig.json --noEmit` → **EXIT 0**.
- `npx vitest run` → **71 files / 619 tests 전부 green**(신규 `estimatePlateFromNeighbors` 8 tests 포함, 회귀 0). `plateAnchoredQuadInvariants`·`floorRoi`·`promptsYaml` 등 기존 회귀 전원 그린.
