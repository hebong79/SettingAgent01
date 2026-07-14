# 01 · 설계 계획 — LPD 실패 슬롯의 "이웃 번호판" 기반 예상 quad → floor ROI

작성: architect / 대상: SettingAgent / 전제 문서: `docs/20260703_200500_주차면점유영역_번호판LPD기준_재정의.md`

---

## 0. 요청 요약 / 목표

- **현상**: VPD(차량)는 검출됐으나 LPD(번호판)가 **완전 실패**한 슬롯은 `plateQuad=null` → `buildPlateAnchoredQuad(vehicle, undefined)` 로 **각도 0(축정렬)** + `predictPlateRect` 상수 위치로 floor ROI 가 생성된다. 한 줄 주차에서 이웃 차량들은 번호판이 기울어 있는데 이 슬롯만 수평 사변형이 되어 정합이 깨진다.
- **목표**: 같은 프리셋 그룹에서 **번호판을 가진 이웃 슬롯**의 (a) 각도, (b) 차량 bbox 대비 번호판 상대오프셋·상대크기를 산출해, target 차량 bbox 에 적용한 **예상 번호판 quad** 를 만들고 그것을 기준으로 floor ROI 를 생성한다.
- **참조 시각**: `etc/주차면점유영역_01~03.jpg` — 한 줄 주차, 번호판 각도가 이웃끼리 유사하며 행 양끝으로 갈수록 원근에 따라 점진 변화.

핵심 통찰: **예상 quad 를 미리 만들어 기존 `plateQuad` 인자로 넘기면 `buildPlateAnchoredQuad`/`resolveFloorPolygon` 시그니처가 무변경**된다(전제 문서 §2-3 알고리즘이 넘겨받은 plateQuad 를 그대로 권위로 사용). 신규 코드는 **순수 헬퍼 1개 + 두 호출부 배선**으로 국한된다.

---

## 1. 계층 결정 — 예상 추정을 어디에 두나

### 결정: 신규 **순수 헬퍼** `estimatePlateQuadFromNeighbors()` 를 `src/capture/floorRoi.ts` 에 두고 **두 호출부에서 호출**한다.

근거:
- **두 경로 모두 예상 quad 가 필요**하다.
  - `FloorRoiReviewer.review()` — 슬롯 순회. `slots` 인자가 **런 전체 집계 슬롯**을 보유 → 같은 `presetKey` 이웃 접근 가능. LLM 힌트(`plateQuad` 템플릿)와 `resolveFloorPolygon` **양쪽**에 예상 quad 를 넘기려면 여기서 계산해야 함.
  - `Finalizer.assemble()` — `presetKey` 그룹 `members`(이웃 포함)를 한 번에 보유. **결정형 폴백 경로**(`floorByRef` 미스 = LLM 이 해당 클러스터 floor ROI 를 못 만든 경우)에서 `buildPlateAnchoredQuad` 에 예상 quad 를 넘기려면 여기서 계산해야 함.
- 두 경로가 **동일 결과**를 내려면 로직을 한 곳에 둬야 한다(중복·표류 방지) → 순수 헬퍼 공유.
- 배치 위치는 `floorRoi.ts` — `predictPlateRect`(유사한 "번호판 예측" 결정형)와 같은 모듈이고 두 호출부가 이미 `floorRoi.js` 를 import. `geometry.ts` 는 도메인 무관 기하 원시함수 계층이라 "이웃 통계" 개념을 넣지 않는다(관심사 분리). 헬퍼는 `geometry.ts` 의 `plateAngleRad`/`projectedSpan`/`clamp01` 를 재사용.

---

## 2. 추정 알고리즘 (결정형)

### 2-1. 시그니처
```ts
export interface PlateNeighbor { vehicle: NormalizedRect; plateQuad: NormalizedQuad; }

/**
 * 이웃(같은 프리셋 그룹·번호판 보유) 슬롯의 번호판 각도·상대오프셋·상대크기를
 * target 차량 bbox 에 적용해 예상 번호판 quad(규약 TL,TR,BR,BL)를 구성한다.
 * 이웃 0개면 undefined(호출측이 predictPlateRect 상수 폴백).
 */
export function estimatePlateQuadFromNeighbors(
  vehicle: NormalizedRect,
  neighbors: readonly PlateNeighbor[],
): NormalizedQuad | undefined
```

### 2-2. 이웃 선택: **위치 최근접 1개** (중앙값 아님) — 근거 명시
- **선택**: `vehicle` 중심과 `neighbor.vehicle` 중심의 유클리드 거리(정규화) 최소 이웃 1개를 채택.
- **근거(최근접 > 중앙값)**:
  1. 참조 이미지에서 번호판 각도는 행을 따라 **원근 그래디언트**로 점진 변화(좌측 차 ≈ 수평, 우측 차 ≈ 기움). 중앙값은 이 그래디언트를 뭉개 **행 양끝 target 에 체계적 편향**을 준다(정작 추정이 가장 필요한 위치).
  2. 각 슬롯 `plateQuad` 는 이미 라운드 다수 검출의 **집계 대표(중앙값)**라 슬롯 단위로 탈노이즈되어 있음 → 단일 이웃이라도 개별 노이즈 위험 낮음.
  3. "한 줄 주차의 번호판은 서로 유사"(전제) → 최근접≈중앙값이지만, 최근접은 추가로 **행 끝 그래디언트를 추종**. best-of-both.
  4. 단순함(CLAUDE.md §2): 통계 없이 거리 argmin 1개.
- 각도·상대오프셋·상대크기 **모두 그 최근접 이웃 1개**에서 산출(소스 일관, 혼합 없음).
- (대안으로 검토했다 기각: 각도만 중앙값 / offset·size 는 중앙값 — 소스 혼합으로 복잡도↑, 그래디언트 손실. 리더가 "행 전체 평활"을 원하면 각도 median 으로 교체 가능 — §12 게이트.)

### 2-3. 산출 (모두 결정형, 좌표계 정규화 0~1 일관)
최근접 이웃 `n`(vehicle `nv`, plateQuad `qN`)에서:
1. `θ = plateAngleRad(qN)` (하단변 평균 방향, TL,TR,BR,BL 규약).
2. 번호판 중심 `pcN = centroid(qN)`. **상대오프셋**(bbox 내 분수 위치): `rx=(pcN.x−nv.x)/nv.w`, `ry=(pcN.y−nv.y)/nv.h` (`nv.w,nv.h < 1e-6` 이면 이 이웃 스킵/다음 최근접). 참조: `predictPlateRect` 기본 `rx≈0.5, ry≈0.72` 와 동일 개념.
3. 로컬 단위축: `right=(cosθ, sinθ)`(하단변=TL→TR 방향), `down=(−sinθ, cosθ)`(이미지 아래). **상대크기**: `wpN=projectedSpan(qN, right)`, `hpN=projectedSpan(qN, down)`, `rw=wpN/nv.w`, `rh=hpN/nv.h`.
4. target 적용: `pcT={vehicle.x+rx·vehicle.w, vehicle.y+ry·vehicle.h}`, `wpT=rw·vehicle.w`, `hpT=rh·vehicle.h`.
5. **예상 quad 구성**(TL,TR,BR,BL, 각 점 `clamp01`):
   - `TL = pcT − (wpT/2)·right − (hpT/2)·down`
   - `TR = pcT + (wpT/2)·right − (hpT/2)·down`
   - `BR = pcT + (wpT/2)·right + (hpT/2)·down`
   - `BL = pcT − (wpT/2)·right + (hpT/2)·down`

### 2-4. 이웃 수 처리
- **0개** → `undefined` 반환(호출측이 `undefined` 전달 → 기존 동작 100% 보존).
- **1개** → 그 이웃 그대로 사용.
- **다수** → 최근접 1개(§2-2).

### 2-5. quad 규약 라운드트립 검증(설계 정합)
합성 quad 를 `buildPlateAnchoredQuad` 에 넘기면 내부가 θ·wp·hp·pc 를 **정확히 복원**한다(수식 확인):
- `plateAngleRad(합성) = atan2(4·(wpT/2)·sinθ, 4·(wpT/2)·cosθ) = θ` (번호판은 |θ|≪π/2 라 정확).
- 빌더의 `u=(cosθ,sinθ)=right` → `projectedSpan(합성,u)=wpT`; `nb`(±down) → `projectedSpan=hpT`; `centroid=pcT`.
- ∴ 합성 quad 는 "실측 번호판이 그 각도·위치·크기로 존재하는 것과 동일"하게 다뤄지며, **빌더/리졸버는 무변경으로 각도를 추종**한다.

---

## 3. 시그니처 영향 / 호출부 변경 (권장: 시그니처 무변경)

`buildPlateAnchoredQuad`/`resolveFloorPolygon` **시그니처 무변경**. 예상 quad 를 미리 만들어 기존 `plateQuad` 인자로 주입한다.

### 3-1. `FloorRoiReviewer.review()` (`src/capture/FloorRoiReviewer.ts`)
- 루프 진입 전 1회: `const neighbors = candidates.filter(n => n !== s && n.presetKey === s.presetKey && n.plateQuad).map(n => ({ vehicle:{x:n.x,y:n.y,w:n.w,h:n.h}, plateQuad:n.plateQuad! }))` — 슬롯별로 `presetKey`·self 필터.
- **트리거 조건**: `plate === undefined && plateQuad === undefined`(= LPD 완전 실패). 이때 `const estimated = estimatePlateQuadFromNeighbors(vehicle, neighbors)`.
- `const effQuad = plateQuad ?? estimated;` → `recognizeFloorRoi({..., ...(effQuad?{plateQuad:effQuad}:{}) })` **와** `resolveFloorPolygon(polyRaw, vehicle, effQuad, plate)` **양쪽에 동일 effQuad** 전달.
- `plate`(rect)는 그대로 실측만(예상은 rect 로 위조하지 않음). `resolveFloorPolygon` 의 containTarget 은 `plate ?? quadBoundingRect(effQuad)` 로 예상 quad 를 포함강제.

### 3-2. `Finalizer.assemble()` (`src/capture/Finalizer.ts`)
- `positioned` 구성 시, `members` 에서 이웃 수집: `plateQuad` 보유 멤버(self 제외)를 `PlateNeighbor[]` 로.
- **트리거 조건**: `m.plateQuad == null && plateRect === undefined`. 이때 `estimated = estimatePlateQuadFromNeighbors(rect, neighbors)`.
- L194 변경: `... ?? buildPlateAnchoredQuad(rect, m.plateQuad ?? estimated ?? undefined)`.
- **저장 불변**: `plateRoiByPreset` 은 **실측 plateRect 존재 시에만**(현행 그대로) — 예상 quad 를 번호판 ROI 로 저장하지 않는다(아티팩트에 번호판 데이터 위조 금지).
- **deconflict 불변**: 예상 quad 를 `deconflictPolygons` 의 `plate` 보호 인자로 넘기지 않는다(현행처럼 실측 plateRect 만). plateless 슬롯의 분리선 동작 현행 보존(외과적 변경).

> 두 호출부 모두 트리거 조건을 "번호판 완전 부재"로 좁힌다: rect-only(구DB) 슬롯은 LPD 실패가 아니라 "번호판 rect 검출됨"이므로 추정 대상에서 제외(현행 유지). 조건은 실질 `plate 부재`(= `plateX===null` ⇒ `plateQuad===null`) 단일.

---

## 4. 폴백 우선순위 (명확화)

두 호출부 공통:
```
effectivePlateQuad = 실측 plateQuad            // 1순위(있으면 즉시)
                  ?? 이웃추정 plateQuad         // 2순위(번호판 완전 부재 + 이웃≥1)
                  ?? undefined                  // 3순위(이웃 0)
// 빌더 내부: plateQuad ?? rectToQuad(predictPlateRect(vehicle)), θ = plateQuad ? angle : 0
```
- **실측 > 이웃추정 > predictPlateRect(vehicle) 상수**. 이웃 0개면 `undefined` → 빌더가 predictPlateRect + θ=0 으로 **현행과 바이트 동일** 폴백.

---

## 5. 프롬프트 수정 (`config/prompts/floor_roi.yaml`) — 보강, 전면 재작성 아님

- **system 규칙에 1문장 보강**(규칙 6 아래 또는 별항): "번호판이 주어지지 않으면(`(없음)`), **주변 차량들의 번호판 각도·위치를 시각적으로 참고**해 이 차량의 예상 번호판 위치를 잡고, 그 각도·좌우중앙 기준으로 점유영역을 그려라."
- **user 템플릿에 이웃 정보(neighborPlates) 주입 불필요** — 근거:
  - 결정형이 예상 quad 를 합성해 **기존 `{{plateQuad}}` 변수로 주입**하므로, 이웃≥1 인 경우 LLM 은 이미 구체 quad(각도·위치 앵커)를 받는다. 별도 이웃 요약 주입은 중복.
  - 게다가 `resolveFloorPolygon` 은 각도·배치를 **빌더가 권위**로 강제하고 LLM 사변형은 깊이(D)만 보조(전제 문서 §4) → LLM 이 이웃을 직접 볼 실익이 각도·배치엔 없음.
  - 보강 1문장은 **이웃 0개(quad 도 `(없음)`)** 인 잔여 케이스에서 LLM 이 비전으로 주변을 참고하도록 하는 소프트 가드레일 → 결정형이 못 채우는 유일한 빈틈만 커버. 최소 변경.
- 출력 스키마·좌표규약·4점 규칙 **무변경**.

---

## 6. 하위호환

- **저장 타입/스키마 무변경**: `AggregatedSlot`(types.ts), `SetupArtifact`/`ParkingSlot`(plateRoiByPreset/floorRoiByPreset shape), DB(`floor_rois`) 전부 그대로.
- **이웃 0개 = 기존 동작 100% 보존**: `undefined` 전달로 현행 코드 경로와 동일(신규 분기 무진입).
- `FloorRoiInput.plateQuad` 는 이미 옵셔널 → 합성 quad 주입이 계약 변화 아님.
- 구DB(rect-only plate) 슬롯: 추정 트리거 제외 → 현행 유지.

---

## 7. 결정형 vs LLM 경계

| 항목 | 담당 | 근거 |
|------|------|------|
| 이웃 각도·상대오프셋·상대크기 산출 | **결정형** | 순수 기하(argmin 거리 + plateAngleRad/projectedSpan) |
| 예상 quad 합성 | **결정형** | `estimatePlateQuadFromNeighbors` |
| 예상 quad 기준 floor ROI 각도·중앙·포함 | **결정형** | 기존 빌더/리졸버(무변경) |
| 이웃 0개 시 비전 참고 | LLM(가드레일) | 프롬프트 1문장, 결정형 빈틈만 |
| 깊이(D) 힌트 | LLM(보조) | 현행 유지 |

→ 실시간·수치반복 아님, 그룹 통계 1회성 → **결정형이 정확·재현·테스트 용이**. LLM 은 잔여 빈틈만.

---

## 8. 단계별 실행 계획 → 검증

1. **헬퍼 신규** `estimatePlateQuadFromNeighbors`(+`PlateNeighbor`) in `floorRoi.ts`.
   → 검증: 이웃 각도 θ 입력 시 `plateAngleRad(반환)≈θ`(±1°); 상대오프셋/크기가 target bbox 스케일로 반영; 이웃 0개면 `undefined`.
2. **FloorRoiReviewer 배선**: 이웃 수집 + 트리거 조건 + `effQuad` 를 recognize/resolve 양쪽 전달.
   → 검증: plate 부재 + 이웃 有 슬롯의 저장 floor ROI 각도 ≈ 최근접 이웃 θ; 이웃 無면 현행(θ=0) 폴리곤과 동일.
3. **Finalizer 배선**: L194 폴백에 `?? estimated`; plateRoiByPreset/deconflict 불변.
   → 검증: LLM 미산출(floorByRef 미스) + plate 부재 + 이웃 有 시 floor ROI 각도 ≈ 이웃 θ; plateRoiByPreset 은 예상분 미저장; 이웃 無면 현행과 동일.
4. **프롬프트 보강** 1문장(system).
   → 검증: `promptsYaml` 로드 회귀 그린 + system 에 보강 문구 존재.
5. **유닛테스트** 신규 `test/estimatePlateFromNeighbors.test.ts` + 기존 회귀.
   → 검증: `tsc --noEmit` EXIT 0, 전체 vitest 그린(회귀 0).

---

## 9. 검증 불변식 (QA용)

1. **각도 추종**: 이웃 quad 각도 θ → `plateAngleRad(estimate)≈θ`(±1e-2 rad); 그 estimate 로 만든 floor ROI 앞변 각도 ≈ θ(전제 문서 §7 `frontEdgeAngle` 방식).
2. **상대오프셋 반영**: estimate 중심의 bbox 내 분수위치 `(rx,ry)` ≈ 이웃의 `(rx,ry)`(다른 bbox 위치/크기여도).
3. **상대크기 반영**: estimate 로컬 `wp,hp` = 이웃 비율 × target bbox.
4. **최근접 선택**: 서로 다른 각도의 이웃 2개일 때, target 은 **더 가까운** 이웃 각도를 채택.
5. **이웃 0개 = 현행 동일**: `resolveFloorPolygon(null, v, undefined)` 결과 = `estimate=undefined` 전달 결과와 바이트 동일(predictPlateRect·θ=0 폴백).
6. **quad 유효성**: 반환 quad 4점·전부 0~1·TL,TR,BR,BL 순서로 각도 라운드트립.
7. **회귀**: 기존 `plateAnchoredQuadInvariants`·`floorRoi`·`deconflict`·Reviewer·Finalizer·`agentRuntimeFloor`·`promptsYaml` 전부 그린. 각도/좌우중앙(|Δu|≤W·10%)/번호판 포함 불변식 유지.
8. **degenerate 방어**: 이웃 `nv.w/h≈0` 이면 스킵/다음 최근접; 전부 degenerate 면 `undefined`.

---

## 10. 영향 받는 파일 / 모듈 (구현자·문서화 전달)

| 파일 | 변경 | 계약 영향 |
|------|------|-----------|
| `src/capture/floorRoi.ts` | 신규 `estimatePlateQuadFromNeighbors` + `PlateNeighbor` (추가만) | 없음(신규 export) |
| `src/capture/FloorRoiReviewer.ts` | 이웃 수집 + effQuad 를 recognize/resolve 전달(호출부만) | 없음 |
| `src/capture/Finalizer.ts` | L194 폴백 `?? estimated`; plateRoiByPreset/deconflict 불변 | 없음 |
| `config/prompts/floor_roi.yaml` | system 1문장 보강 | LLM 계약 소폭(가산) |
| `test/estimatePlateFromNeighbors.test.ts` | 신규 | — |
| `src/domain/geometry.ts`, `src/brain/*`, types, DB, web/@parkagent | **무변경** | — |

문서화(documenter)에게: 신규 헬퍼 1개 + 배선 2곳 + 프롬프트 1문장. 저장 스키마 무변경, 이웃 0개 하위호환 100%. 결정형/LLM 경계는 §7 표.

---

## 11. 변경 파일 체크리스트

- [ ] `src/capture/floorRoi.ts` — `PlateNeighbor`, `estimatePlateQuadFromNeighbors` 신규
- [ ] `src/capture/FloorRoiReviewer.ts` — 이웃 수집·트리거·effQuad 양방향 전달
- [ ] `src/capture/Finalizer.ts` — 폴백에 `?? estimated`(plateRoiByPreset/deconflict 불변)
- [ ] `config/prompts/floor_roi.yaml` — system 보강 1문장
- [ ] `test/estimatePlateFromNeighbors.test.ts` — 신규 유닛
- [ ] 회귀: `test/floorRoi.test.ts`·`plateAnchoredQuadInvariants`·Reviewer·Finalizer·`promptsYaml` 그린 확인

---

## 12. 미해결 / 가정 / 리더 확인 게이트

- **[결정·게이트 가능]** 이웃 선택 = **위치 최근접 1개**(§2-2). 리더가 "행 전체 평활 우선"을 원하면 각도 median 으로 교체 가능(그래디언트 손실 트레이드오프 명시). 기본은 최근접으로 진행.
- **[가정]** 추정 트리거 = **번호판 완전 부재**(`plate 부재`)만. rect-only(구DB) 슬롯은 실측 rect 보유로 간주해 제외(현행 유지). — 요청의 "LPD 검출 실패" 정의에 부합. 이견 시 확인.
- **[가정]** 예상 quad 는 **floor ROI 기하 산출용에 한정**; `plateRoiByPreset`(아티팩트 번호판 ROI)·`deconflict` 번호판 보호에는 **미사용**(실측만). 번호판 데이터 위조 방지·외과적 변경 원칙.
- **[가정]** 이웃 범위 = **같은 `presetKey` 그룹**(요청 명시). 프리셋 경계 넘는 참조 없음.
- 명백한 나머지(시그니처 무변경 방향, 헬퍼 배치, 프롬프트 보강 범위)는 스스로 결정 — 위 3가정만 리더 확인 대상(진행에는 지장 없음, 기본값으로 착수 가능).
