# 23회차 이터레이션 1 설계 — 개별 독립 검출 엔진 프로토타입

- 작성: 2026-07-30 / 설계자 · 워크트리 `round22-rows-threshold`(브랜치 `worktree-round22-rows-threshold`)
- 근거 문서: `docs/20260730_221143_22회차_인계서_다음세션용.md` · `docs/20260730_180519_..._설계.md` 【개정 R2】(§329~611) · `_workspace/02aa_developer_anchor_upper_round22.md` · `_workspace/02ad_developer_caranchor_upper_round22.md`
- 성격: **B 모드(goal/loop) 이터레이션 1 설계.** 검출 소스(`src/ground/*`·`src/rpc/services/*`·`web/*`) **0줄 변경** 유지.

---

## 0. 결론 요약 (맨 앞 — 리더가 이것만 읽어도 착수 가능)

| 질문 | 답 |
|---|---|
| **안 1을 어떤 역할로?** | **(ㄷ) 이번 이터레이션은 안 2 단독.** 안 1은 이터레이션 2 이후로 미룬다. 근거 §2 |
| **상한 → 엔진 사이에 빠진 것** | **이미지에서 차량을 검출하는 부분 전체.** 이터레이션 1은 `degradeCar` 강등본을 유지하므로 **산출 수치 자체는 상한 재측정과 같아야 정상**이다. 새로 생기는 것은 **게이트·배타성·교체가능 관측소스** 3개뿐. §3에 정직하게 적었다 |
| **게이트** | 경성 3층(면적/절단 · 물리 타당성 · 관측품질). **도색지지는 경성 게이트로 넣지 않는다** — 안 2의 표적이 「도색이 한 줄도 안 보이는 가림면」이라 자살이다. 측정만 한다. §4 |
| **판정선** | `precision ≥ 0.7` **AND** `recall > 0.5853658536585366` **AND** 게이트 전 산출이 22회차 seg 상한과 비트 동일 **AND** rows 골든 무회귀. §6 |
| **신규 파일** | `src/tools/individualEngine.ts` 1개 + `test/individualEngine.test.ts` 1개. 기존 파일은 **`export` 키워드 추가만** (`carAnchorUpper.ts` 10곳) |

---

## 1. 모듈 경계 — `src/tools/individualEngine.ts`

### 1-1. 파이프라인 4단 + 채점

```
ObservationSource.observe(t, view)   →  VehicleObservation[]      ← 교체 지점(실카 seg/VPD 로 갈아끼울 자리)
proposeFromObservation(o, t, ev)     →  BayProposal | null        ← 관측 1건 → 면 0 또는 1개 (G1)
gateBay(p, params)                   →  GateVerdict               ← 면 1개가 단독으로 통과/탈락 (G5 무위반)
resolveBays(props, mergeIoU)         →  BayProposal[]             ← quadIoU 배타성
scoreBays(kept, t)                   →  Score                     ← ★ 오라클은 여기서만
```

**G1 준수 구조**: `proposeFromObservation` 의 반환 타입이 **배열이 아니라 `BayProposal | null`** 이다. 한 번의 결정으로 면 2개를 못 낸다 — 타입이 막는다. `k`·`phase`·`latticeIndex`·`filledIndices` 어느 것도 등장하지 않는다(G2·G3). 행 단위 창·점수 없음(G4·G5). `expectedBays` 를 시그니처에 두지 않음(G6). 근변선 재적합 없음(G7). 면간 정렬 가점 없음(G8).

### 1-2. 시그니처 (구현자는 이대로 쓴다)

```ts
// ── 관측 소스 ────────────────────────────────────────────────────────────
export type ObservationKind = 'sim-degraded' | 'sim-degraded-noisy' | 'real-seg' | 'real-vpd' | 'real-lpd';

export interface ObservationSource {
  readonly kind: ObservationKind;
  /** 이 프리셋 프레임에서 얻은 차량 관측 전부. 오라클 필드는 반환값에 없다(타입이 막는다). */
  observe(t: Target, view: TruthView): VehicleObservation[];
}

/** 이터레이션 1의 유일한 구현체 — 22회차 강등본. σ/그림자 0 이면 상한 재현. */
export function simDegradedSource(
  cars: readonly RawCar[],
  opts?: { sigmaPx?: number; shadowPx?: number; seed?: number },
): ObservationSource;

// ── 면 제안 ──────────────────────────────────────────────────────────────
export interface BayProposal {
  obsId: string;
  kind: ObservationKind;
  quad: PixelQuad;
  centerGround: Vec3;
  headGround: Vec3;
  /** 게이트③ 측정량 — quad 중심 역투영 거리(m). 식은 `anchorCloseUpper.ts:296-301` 과 동일. */
  depthM: number | null;
  /** 게이트① 측정량 — 관측 접지사각형의 화면 면적(px²). */
  footprintAreaPx: number;
  /** 게이트① 측정량 — 닫은 면 4점 중 프레임 밖 점 개수(0 이면 완전 가시). */
  outOfFramePts: number;
  /** ★ 측정 전용(이번 이터레이션에서 게이트로 쓰지 않는다 — §4-3). 4변 각각의 `edgePaintSupport.hitRatio`. */
  edgeHit: { near: number; far: number; sideA: number; sideB: number };
}
export function proposeFromObservation(o: VehicleObservation, t: Target, ev: PaintEvidence | null): BayProposal | null;

// ── 게이트 ───────────────────────────────────────────────────────────────
export interface GateParams {
  minFootprintAreaPx: number;      // ★ 신규 파라미터 1 — 값은 Phase 0 분포에서
  maxOutOfFramePts: number;        // ★ 신규 파라미터 2 — 값은 Phase 0 분포에서
  depthLoM: number | null;         // 기존 축(anchorCloseUpper 의 depthM) 재사용. null 이면 미적용
  depthHiM: number | null;
}
export interface GateVerdict { pass: boolean; failed: string[] }
export function gateBay(p: BayProposal, g: GateParams): GateVerdict;

// ── 배타성 ───────────────────────────────────────────────────────────────
/** 서열: footprintAreaPx desc → outOfFramePts asc → obsId. `quadIoU` 재사용(신규 IoU 0줄 · R4). */
export function resolveBays(props: readonly BayProposal[], mergeIoU: number): BayProposal[];

// ── 채점(오라클 유일 접점) ────────────────────────────────────────────────
export function scoreBays(kept: readonly BayProposal[], t: Target): Score;   // carAnchorUpper.scoreClosed 재사용

// ── 실행 ─────────────────────────────────────────────────────────────────
export interface EngineRun {
  proposals: BayProposal[];
  gated: BayProposal[];          // 게이트 통과분
  kept: BayProposal[];           // 배타성 해소 후
  scoreUngated: Score;           // ★ 게이트 0 — 22회차 seg 상한과 비트 동일해야 한다
  scoreGated: Score;
}
export function runEngine(t: Target, view: TruthView, src: ObservationSource, g: GateParams, ev: PaintEvidence | null): EngineRun;
```

### 1-3. 재사용할 기존 export (구체 함수명 — 재발명 0줄)

| 모듈 | 함수/상수 | 위치 | 용도 |
|---|---|---|---|
| `tools/carAnchorUpper.ts` | `degradeCar` | :148 | 관측 강등(오염 격리 경계) |
| | `closeBayAt` | :240 | 지면 중심+방위 → 규격 2.5×5.0 면 1개 |
| | `groundAxisOf` | :254 | 접지 4점 → 중심·장축 |
| | `scoreClosed` · `Score` · `ClosedBay` | :384/:374/:263 | 채점 |
| | `RawCar` · `VehicleObservation` · `OracleTag` | :84/:98/:113 | 타입 경계 |
| `tools/sepAudit.ts` | `goldenTargets` · `GOLDEN_DIRS` · `Target` · `PLANE_Y_M` · `MIN_AREA_PX` · `quantiles` | :462/:405/:410/:401/:402/:227 | 골든 프레임·프레임해시·분포 |
| | `frontCandidatesOf` | :429 | 도색 마스크(§4-3 측정 전용) |
| `ground/floorPaint.ts` | `paintEvidenceOf` · `edgePaintSupport` · `DEFAULT_PAINT_OPTIONS` | :901/:921/:157 | 변 도색지지 **측정** |
| `ground/autoRoiPlan.ts` | `quadIoU` · `MATCH_MIN_IOU` | — | 매칭·배타성. **신규 IoU 0줄** |
| `ground/project.ts` | `backprojectToGround` · `projectToPixel` | — | 기하 왕복 |
| `ground/bayGeometry.ts` | `DEFAULT_BAY_OPTS.slotWidthM/slotDepthM` | — | 2.5m·5.0m **허용 상수 2개뿐** |

### 1-4. ★ 추가해야 할 export (`carAnchorUpper.ts` — **`export` 키워드만 추가, 로직 0줄 변경**)

현재 파일 내부에만 있어 신규 엔진이 못 쓰는 것들이다. `sepAudit.ts` 가 22회차에 `export` 8줄만 추가했던 것과 **같은 규약**을 따른다.

| # | 대상 | 줄 | 신규 엔진에서의 쓰임 |
|---|---|---|---|
| 1 | `footprintToGround` | :215 | 접지 px quad → 지면 4점 |
| 2 | `inFrame` | :316 | 가시 판정(`visible` 미사용 규약 유지) |
| 3 | `bestIoUOf` | :302 | 채점(프리셋 접두 키) |
| 4 | `worldFaces` | :333 | ★ 채점 배정을 **월드 기하로 재구성**(밟지말것 (E)) |
| 5 | `assignFaceByGeometry` | :363 | 〃 |
| 6 | `viewsOf` | :461 | 프리셋별 `TruthView` |
| 7 | `carList` | :449 | `unity.car.list` 읽기 1회 |
| 8 | `perturbFootprint` | :292 | σ/그림자 관측소스 |
| 9 | `rng` | :277 | 결정론 시드 |
| 10 | `CAR_BODY` · `PLATE` | :68/:74 | 가정값 참조(재선언 금지) |

> ⚠ **밟지말것 (h) 대응**: `carAnchorUpper.ts` 는 22회차 신규이고 **커밋 0건**(인계서 §7)이라 **미추적일 수 있다**. `git diff` 만으로 무해성을 주장하면 조용히 통과한다. → **3중 증거 필수**: ① `git status --porcelain -- src/tools/carAnchorUpper.ts` 로 추적 여부를 먼저 확인 ② 코드 직독으로 `export` 외 변경 0 확인 ③ **산출 재현** — `npx tsx src/tools/carAnchorUpper.ts v1 reports/_r23_recheck` 가 재현율 `0.9512195121951219` · 정밀도 `0.9285714285714286` 를 그대로 낼 것.

### 1-5. 재사용 **불가**로 판단한 것 (중복을 정직하게 고지)

- `anchorCloseUpper.resolveExclusivity`(:130) — **못 쓴다.** 서열 키가 `predHit`·`sepSpanPx` 로 `AnchorCand` 에 박혀 있는데(:135-137) 안 2 제안에는 그 두 값이 **존재하지 않는다**. 제네릭화는 **로직 변경**이므로 금지 규약 위반. → `resolveBays` 를 **8줄 새로 쓴다**(알고리즘은 동일: 서열 정렬 후 `quadIoU ≥ mergeIoU` 면 접기. `quadIoU` 는 재사용). **중복 8줄이 발생한다는 사실을 명시한다.**
- `anchorCloseUpper.gateSweep`(:164) — `predHit` 단일 축 스윕 전용. 안 2 게이트는 축이 3개라 형이 안 맞는다. 재사용하지 않는다.

---

## 2. ★ 사전 반증(F1) 정면 대응 — 안 1은 어떤 역할인가

### 권고: **(ㄷ) 이번 이터레이션은 안 2 단독. 안 1은 이터레이션 2 이후.**

**근거 1 — 안 2 단독이 목표선을 이미 넘는다.**
`02ad` §4: 재현율 `0.9512195121951219`(39/41) · 정밀도 `0.9285714285714286`(39/42). 목표선은 정밀도 ≥0.70 · 재현율 > `0.5853658536585366`. **두 항 모두 큰 여유로 초과**한다. 안 1을 넣을 재현율상의 **필요가 없다**.

**근거 2 — 안 1을 산출에 넣으면 정밀도가 확실히 내려가고, 재현율 증분은 최대 2면이다.**
- 안 1이 정밀도 0.70 을 처음 넘는 지점은 τ=0.82 이고 그때 **산출 11개 · 회수 8면**(`02aa` §4-2).
- 안 2가 못 얻는 면은 **2면뿐**(41−39). 그중 1면은 `1:3 r5f2`(빈 면 — 차가 없어 안 2가 **원리적으로** 못 만든다, `02ad` §6). 나머지 1면은 1:2 의 13/14 결손(**면 ID 미특정 — 미측정**).
- **즉 안 1이 기여할 수 있는 상한은 재현율 +2면**이고, 안 1 τ=0.82 의 8면이 그 2면을 포함하는지는 **미측정**이다. 반면 산출은 42 → 최대 53개로 늘어난다. 겹침이 전부여도 정밀도는 39/53 = `0.7358490566037735`, 겹침이 없으면 41/53 = `0.7735849056603774` — **어느 쪽이든 `0.9285714285714286` 에서 내려간다.**
- 게다가 `02aa` §5-3 이 확정한 안 1의 생존 편향은 **「전경의, 차량에 가려지지 않은 도색」**이다. 이것은 **안 2가 이미 잘하는 구역**(차가 있는 면)과 겹치고, 안 2가 못 하는 구역(빈 면)과는 **겹치지 않는다**. 상보라는 설계서 §R2-2 의 기대와 **실측이 어긋난 지점**이다.

**근거 3 — (ㄴ)「안 2가 못 덮는 빈 면에만」은 이번 데이터로 검증 불가능하다.**
골든 41 가시면 중 빈 면은 **1개**(`1:3 r5f2`, `02ad` §7 F7). **표본 1개로는 판별력을 잴 수 없다.** 「빈 면에서만 돌린다」를 성립시키려면 차량을 뺀 골든 v3 가 필요하고, 그건 `random.toggleCars`(**쓰기** 메서드) 승인 사안이다(`02ad` §12-5). 이터레이션 1 범위 밖.

**근거 4 — (ㄱ)은 F1 을 정면으로 되밟는다.** R2-2-2 의 예측(생존율 3.8% → 정밀도 0.70)은 `02aa` §4-2 에서 **끊어진 것으로 실측 확정**됐다(생존율 0.041322 지점의 정밀도 `0.39285714285714285`). 그 지점을 다시 지나갈 이유가 없다.

### 안 1을 언제 꺼내는가 (이터레이션 2 이후의 조건)

1. 안 2 단독 엔진이 **성립한 뒤**, 안 2 미회수 2면의 **면 ID 를 특정**하고,
2. 안 1 τ=0.82 생존 8면과 안 2 39면의 **겹침을 측정**한 뒤,
3. 겹치지 않는 면이 **실재할 때만** 합류시킨다. 그때도 합류는 **배타성 해소에서만**(G8 — 정렬 가점 금지).

---

## 3. ★ 상한 → 실제 엔진 사이에 무엇이 빠져 있는가 (정직 고지)

### 3-1. 22회차 안 2 상한 측정이 **실제로 쓰지 않은 것**

| # | 안 쓴 것 | 코드 증거 |
|---|---|---|
| **①** | **골든 프레임의 픽셀을 한 바이트도 읽지 않는다.** `degradeCar` 는 `car.list` 의 월드 `pos`/`rotY` 와 정본 `PtzCamRoi.json` 의 pan/tilt/fov 로 **투영**만 한다 | `carAnchorUpper.ts:151-152` `rectWorld(car.pos.x, car.pos.z, car.rotY, …)` → `projectRect(…, view)`. `t.frame`(FrameGray) 미사용 · `paintEvidenceOf` 미호출 |
| **②** | **게이트가 0개다.** 산출 = 관측 전부. 유일한 필터는 `inFrame`(중심 프레임 내부 + 면적 ≥200px²) | `carAnchorUpper.ts:576` `if (!q \|\| !inFrame(q, t.W, t.H)) continue;` — 그 뒤 곧바로 `seg.push` |
| **③** | **배타성 해소가 없다.** `resolveExclusivity` 를 호출하지 않는다(F8 접지 겹침 0/42 라 필요가 없었다) | `carAnchorUpper.ts:568-579` seg 루프 전문에 배타성 코드 없음 |
| **④** | **투영 경로가 2개**다 — 강등은 `TruthView`(`viewsOf`, :461-482, 정본 PtzCamRoi.json 직독), 닫기는 `GroundModel`(`t.model`, sepAudit 제공). 실엔진은 `GroundModel` **하나**만 있어야 한다 | `degradeCar(c, view)` vs `closeBayAt(…, t.model)` |
| **⑤** | **차량 치수 단일 가정** 4.7×1.85×1.45m — 종별 치수 미측정. seg 경로는 중심 불변이라 둔감하나 vpd/lpd 는 `+L/2` 를 써서 민감 | `carAnchorUpper.ts:68` · `02ad` §10-1 |
| **⑥** | **F10 정밀도 결손 3건이 게이트로 걸러지는지** 미측정 | `02ad` §7 F10 |

### 3-2. 이터레이션 1은 그 검출을 무엇으로 대신하는가

**`degradeCar` 강등본을 그대로 유지한다.** 실카 세그/VPD 도입은 이터레이션 1 범위 밖이다(모델 의존성·추론 비용 미검토 — 설계서 §R2-8-2).

### 3-3. ★ 그러면 이터레이션 1은 상한 재측정에 불과한가 — **부분적으로 그렇다. 그렇게 적는다.**

> **게이트를 끈 상태의 산출 수치는 22회차 상한과 비트 동일해야 한다.** 그것이 오히려 **이식 정합성의 검증**이다(§6 판정 조건 3). 다르게 나오면 파이프라인 이식 중 무언가 깨진 것이다.

상한 재측정과 **다른 것은 정확히 3가지**이고, 그것이 이터레이션 1의 진짜 산출물이다:

| 새로 생기는 것 | 왜 상한 측정에 없었나 | 이번에 새로 측정되는 값 |
|---|---|---|
| **(a) 교체 가능한 `ObservationSource` 경계** | 상한 도구는 `main()` 안 인라인 루프(:568-579)라 관측 소스를 갈아끼울 자리가 없다 | 없음(구조 산출물). 실카 전환의 **유일한 접점**이 1개 함수로 좁혀진다 |
| **(b) 게이트 3층이 실재하고 그 효과가 측정된다** | 게이트 0개(§3-1 ②) | **F10 결손 3건이 죽는가 / 참 39면 중 몇이 함께 죽는가** — 22회차가 못 잰 값 |
| **(c) 배타성 해소가 파이프라인에 들어간다** | 미호출(§3-1 ③) | 게이트 후 겹침 발생 여부. σ 주입 시 겹침이 생기는지 |
| (보너스) **σ 관측소스 승격** | `perturbFootprint` 가 별도 스윕 루프에만 있었다 | **게이트가 오차 하에서 어떻게 작동하는가** — 22회차 σ 표는 게이트 없는 값이다 |

### 3-4. 진짜 엔진이 되려면 무엇을 더해야 하는가 (이터레이션 2·3 예고)

1. **이미지에서 차량 접지 사각형을 실제로 검출하는 `ObservationSource` 구현** — 세그(SAM 등) 또는 VPD. 이것 없이는 이번 산출은 **「원리적으로 되는가」에만** 답한다(밟지말것 (G) 준수).
2. **실카 EV1~EV5 에서 σ 실측** — `02ad` §5 는 「얼마나 정확해야 하는가」의 **사양**이지 「실제로 그만큼 정확하다」의 증거가 아니다. 계통 편의(그림자 오인) ≤30px 이 1급 요구사항.
3. **빈 면 성분** — 안 2 로 원리적으로 안 된다(F7). 별도 표적. 골든 v3(차량 제거) 필요.

---

## 4. 게이트 설계 — 행 단위 점수 없이 면 하나가 통과/탈락한다

### 4-1. 원칙

- **면 1개의 자기 속성만 본다.** 다른 면의 값을 참조하지 않는다 → `coverage`·`denom`·`refScore`·`rowMinScoreRatio`·`effectiveScore` **전부 부재**(G5).
- **★ 상대 문턱을 다시 만들지 않는다**(밟지말것 (A)). 모든 문턱은 **후보 집합에 의존하지 않는 절대값**이다. 22회차 ⓐ′ 가 확인한 「절대 문턱의 스케일 이동」(정답칸 min `0.071429` < 반칸 max `0.714286`, `02aa` §6) 위험은 **도색 축에서만** 발생했고, 아래 게이트 축(면적 px²·프레임 밖 점 수·거리 m)은 **물리 단위**라 프레임 간 스케일 이동이 없다.
- **새 가중식 발명 금지.** 가중합·점수화를 하지 않는다. **AND 로 묶인 경성 조건 3개**뿐이다.

### 4-2. 게이트 3층 (전부 기존 값/식 재사용)

| 층 | 조건 | 근거·출처 | 표적 |
|---|---|---|---|
| **G-①  관측 품질** | `footprintAreaPx ≥ minFootprintAreaPx` **AND** `outOfFramePts ≤ maxOutOfFramePts` | 면적 하한 개념은 `sepAudit.MIN_AREA_PX = 200`(:402) 재사용. 프레임 밖 점 수는 **`inFrame`(:316-321)이 중심만 보던 것을 4점으로 확장** — 새 축이 아니라 같은 규칙의 강화 | **F10 결손 3건 중 1:2 좌단 절단 차**(`02ad` §7 F10) |
| **G-②  물리 타당성(거리)** | `depthLoM ≤ depthM ≤ depthHiM` | 식은 `anchorCloseUpper.ts:296-301`(quad 중심 역투영 거리) 그대로. 리더 발견 4의 축 | 지평선 근처 퇴화 quad |
| **G-③  물리 타당성(지면 방위)** | `headGround` 가 지면 접평면 위 단위벡터이고 `closeBayAt` 의 `cross(g.n, head)` 가 퇴화하지 않는다 | `carAnchorUpper.ts:241` 이 이미 `unit(cross(...))` 실패 시 `null` 을 낸다 — **게이트가 아니라 이미 존재하는 방어**다. 별도 파라미터 없음 | 방위 퇴화 |

**신규 파라미터는 2개뿐**: `minFootprintAreaPx` · `maxOutOfFramePts`. `depthLoM/depthHiM` 은 기존 축이며 **null(미적용)로 시작**한다.

> **★ 값은 지금 확정하지 않는다.** 세 값 전부 **Phase 0 분포에서 도출**한다 — 참(매칭) 제안 39건 vs 잡음(비매칭) 제안 3건의 `footprintAreaPx` · `outOfFramePts` · `depthM` 분포를 `quantiles`(sepAudit:227)로 먼저 낸 뒤 정한다(19회차 「문턱 전에 분포」 규약).

### 4-3. ★ 예측변 도색지지(`edgePaintSupport`)를 **경성 게이트로 넣지 않는다** — 이 결정이 §4의 핵심

설계자 지시에 「예측변 도색지지」가 게이트 구성요소로 들어 있으나, **넣으면 안 2가 자기 표적을 죽인다.** 근거 3건:

1. **안 2의 존재 이유가 「도색이 안 보이는 면」이다.** `02ad` §6: `car_close_seg_2_2.png` — *「차가 밀집해 칸 사이 도색이 화면에서 단 한 줄도 보이지 않는다. 그런데 시안 8개가 초록 정답 8면에 포개진다」*. 도색지지를 경성 게이트로 걸면 **회수 12면 중 이 4면(`2:2 r3f2·r3f3·r3f4·r4f1`)이 먼저 죽는다.**
2. **F11(22회차 신규 반증)**: 「5m 변 전 구간 도색지지」는 **참 면조차 median `0.333333`** 밖에 못 채운다(`02aa` §4-1, 앵커변 기준). 문턱을 올리는 순간 참이 먼저 죽는 **구조적** 지표다.
3. **교환비가 명백히 진다.** 걸러야 할 잡음은 **3건**(정밀도 `0.9285714285714286` 의 결손 전부), 위험에 놓이는 참은 **12면**. 게다가 결손 3건 중 2건은 「칸 밖에 주차된 실차」인데 **통로에는 칸 도색이 없으므로** 도색 게이트가 이론상 잡을 수 있는 유일한 성분이다 — 그러나 위 ①②가 그 대가를 지불 불가로 만든다.

**대신 `edgeHit` 4변을 `BayProposal` 에 담아 「측정만」 한다.** 참 39건 vs 잡음 3건의 분포를 내고, **완전분리가 나오면**(잡음 max < 참 min) 이터레이션 2에서 게이트 승격을 검토한다. 표본 3건이라 이번 이터레이션에서는 **판정하지 않는다**고 미리 적는다.

### 4-4. 「차량 존재표」에 대하여

안 2는 **정의상 차량 1대 = 면 1개**이므로 「차량 존재」는 게이트가 아니라 **전제**다. 별도 조건을 만들지 않는다. (`car.list` 의 `visible` 은 금지 — 가시 판정은 `inFrame` 의 기하 규칙으로만.)

---

## 5. 스샷 계획 — `reports/overlay_r23a/`

**전부 22회차 `reports/overlay_r22h/` 와 같은 골든 프레임 · 같은 frameHash 위**(F13). 생성 후 **`Read` 로 전수 육안 확인**하고 본 것을 수치와 함께 기록한다.

| 파일 | 내용 | 대조 대상 |
|---|---|---|
| `eng_out_{1_1,1_2,1_3,2_1,2_2}.png` | 최종 산출(게이트+배타성 후). 초록=정답 · 시안=매칭 · 빨강=비매칭 · **회색 점선=게이트 탈락분** | `overlay_r22h/car_close_seg_*.png` 와 1:1 |
| `eng_gatefail_{1_2,1_3,2_2}.png` | 탈락분만 확대 라벨(탈락 사유 문자열 병기) | 새 그림 |
| `eng_noisy_s10d15_{2_2,1_3}.png` | σ=10px·그림자=15px 관측소스에서의 산출 | `02ad` §5 의 `0.9170731707317075/0.9084785133565623` 행 |

**프레임해시(반드시 헤더에 박고 대조)**: `1:1=6006a034bfe2` · `1:2=ceaaed722663` · `1:3=3c0db12efe75` · `2:1=e33628e921c2` · `2:2=0cf4fda4d3aa`

**★ 육안으로 반드시 답해야 할 3문**(수치만으로 판정 금지):
1. **`eng_out_2_2.png`** — 가림 표적 8면이 **전부 시안으로 유지**되는가? 하나라도 회색(게이트 탈락)이면 **게이트가 표적을 죽인 것**이며 즉시 게이트를 되돌린다.
2. **`eng_out_1_3.png`** — 위쪽 통로에 선 검은 차(`22-15.39.28`)가 만들던 **빨강 유령 면이 사라졌는가**? 그대로면 G-①②로는 F10 을 못 잡는다는 뜻(예측: **못 잡는다** — §4-3 참조).
3. **`eng_out_1_2.png`** — 좌단 **절단 차**의 빨강 면이 `outOfFramePts` 게이트로 죽었는가?

**★ 오버레이 렌더러는 재사용한다** — `carAnchorUpper.drawOverlay`(:414-442) 의 SVG 조립 패턴을 따르되, 그 함수는 미export 이고 시그니처가 `OverlayIn` 에 묶여 있으므로 **individualEngine 안에 자체 렌더러를 둔다**(회색 점선 레이어가 추가로 필요). `sharp` composite 방식은 동일.

---

## 6. 판정 기준 — 이터레이션 1의 성공/실패 (원시 배정도 · `toFixed` 금지)

### 성공 = 아래 **5항 전부** 충족

| # | 조건 | 값 |
|---|---|---|
| **P1** | 목표선 | `scoreGated.precision ≥ 0.7` **AND** `scoreGated.recall > 0.5853658536585366` |
| **P2** | **rows 골든 무회귀** | `npx tsx src/tools/roiAutoRecall.ts v1 evidence rows --raw` 가 `recall 0.5853658536585366` · `precision 0.8571428571428571` · `meanIoU 0.8886003068644802` · `minIoU 0.6130202566182261` · `pass95 8` · `pass98 1` · 프레임해시 5개 **비트 동일** |
| **P3** | **이식 정합** | `scoreUngated`(게이트 0) 가 22회차 seg 상한과 **비트 동일** — `recall 0.9512195121951219` · `precision 0.9285714285714286` · `outputs 42` · `faces 39`. 다르면 이식 실패이며 **게이트 성적은 읽지 않는다** |
| **P4** | **게이트가 표적을 죽이지 않았다** | `scoreGated.recall ≥ 0.9268292682926831`(= 38/41). 즉 게이트로 인한 참 손실 **≤1면**. 이보다 떨어지면 게이트 실패 |
| **P5** | **오염 격리 유지** | `test/individualEngine.test.ts` 의 봉인 테스트 green — `faceSlot`·`presetId`·`visible` 을 바꿔도 `runEngine` 의 산출 quad 가 **JSON 비트 동일**. 채점 배정은 `worldFaces`/`assignFaceByGeometry`(월드 기하)로만 |

### 실패 시 분기

- **P3 실패** → 이식 버그. 게이트를 다 끄고 `carAnchorUpper` 와 중간값(관측 수·`closeBayAt` 입력 center/head)을 대조해 어긋난 단계를 특정한다.
- **P4 실패** → 게이트를 **되돌린다**. 「정밀도가 이미 `0.9285714285714286` 로 목표선을 넘으므로 **게이트 불필요**」가 유효한 결론이다 — 그렇게 적는다(「살아났다」 금지의 반대편: **안 넣는 것도 결론**).
- **P1 만 실패** → 실질적으로 불가능(P3 성립 시 게이트 전 정밀도가 이미 0.9286). 발생하면 게이트가 참을 대량 죽인 것이며 P4 와 동시 실패한다.

### 부가 기록(판정선은 아니지만 반드시 남길 것)

- σ=10/그림자=15 관측소스에서의 `scoreGated` — `02ad` §5 의 게이트 없는 값 `0.9170731707317075/0.9084785133565623` 과 **게이트 유무 차이**를 낸다.
- 참 39건 vs 잡음 3건의 `footprintAreaPx`·`outOfFramePts`·`depthM`·`edgeHit` 4변 **분포**(`quantiles` 사용).
- 안 2 미회수 2면의 **면 ID 특정**(이터레이션 2 착수 조건 — §2).

---

## 7. 미해결 · 가정 (추정으로 채우지 않는다)

| # | 항목 | 상태 |
|---|---|---|
| 1 | 안 2 미회수 2면 중 `1:3 r5f2`(빈 면) 외 나머지 1면의 ID | **미측정** — 이터레이션 1에서 특정한다 |
| 2 | 안 1 τ=0.82 생존 8면과 안 2 39면의 겹침 | **미측정** — 이터레이션 2 착수 조건 |
| 3 | 골든 빈 면 표본 1개 → F7 실제 비용 | **측정 불가**(골든 22/23 면 점유). 골든 v3 필요(`random.toggleCars` = 쓰기 승인 사안) |
| 4 | 실카 세그/VPD 의 실제 σ | **미측정**. `02ad` §5 는 사양이지 증거가 아니다 |
| 5 | 차량 치수 단일 가정 4.7×1.85×1.45m | **가정**(`carAnchorUpper.ts:68`). seg 경로는 중심 불변이라 둔감 |
| 6 | 도색지지의 게이트 승격 여부 | 잡음 표본 3건이라 **이번 이터레이션에서 판정 불가**. 분포만 낸다 |
| 7 | `resolveBays` 8줄 중복 | §1-5 — 로직 변경 금지 규약과 DRY 의 충돌. **중복을 택했다** |

**리더에게 올리는 질문 1건**: §4-3 의 결정(도색지지를 경성 게이트에서 뺀다)은 설계자 지시문의 게이트 구성과 **어긋난다**. 근거는 「안 2의 표적이 도색이 없는 면」이라는 `02ad` §6 실측이다. 진행 전 이견이 있으면 알려달라 — 이견이 없으면 §4-2 3층으로 착수한다.

---

## 8. 구현자 실행 지시 (그대로 따라 하면 된다)

### 단계 0 — 기준선 고정 (코드 작성 **전**)

```bash
cd d:/Work/Parking3D/AgentVLA/ParkAgent/.claude/worktrees/round22-rows-threshold/SettingAgent
npx tsx src/tools/roiAutoRecall.ts v1 evidence rows --raw   | tee _workspace/_r23_baseline_rows.txt
npx tsx src/tools/carAnchorUpper.ts v1 reports/_r23_recheck | tee _workspace/_r23_baseline_car.txt
git status --porcelain -- src/tools/carAnchorUpper.ts
```
**검증**: rows 가 `0.5853658536585366`/`0.8571428571428571`/`0.8886003068644802` · 프레임해시 5개 일치. car 가 seg `0.9512195121951219`/`0.9285714285714286`. 세 번째 명령의 출력으로 **추적/미추적을 기록**(§1-4 경고).

### 단계 1 — `carAnchorUpper.ts` 에 `export` 키워드 10곳 추가

§1-4 표의 :215 `footprintToGround` · :316 `inFrame` · :302 `bestIoUOf` · :333 `worldFaces` · :363 `assignFaceByGeometry` · :461 `viewsOf` · :449 `carList` · :292 `perturbFootprint` · :277 `rng` · :68 `CAR_BODY` · :74 `PLATE`.
**`export` 키워드 외에는 한 글자도 바꾸지 마라.**

**검증**: `npx tsc --noEmit` exit 0 · `npx vitest run test/carAnchorUpper.test.ts` 12 green · `npx tsx src/tools/carAnchorUpper.ts v1 reports/_r23_recheck2` 산출이 단계 0의 `_r23_baseline_car.txt` 와 **비트 동일**(diff 로 확인).

### 단계 2 — `src/tools/individualEngine.ts` 신규 (§1-2 시그니처 그대로)

Phase 0 모드부터 만든다: **게이트 전 분포만** 출력.
```bash
npx tsx src/tools/individualEngine.ts v1 --dist
```
**검증**: `scoreUngated` 가 `recall 0.9512195121951219` · `precision 0.9285714285714286` · `outputs 42` · `faces 39` (= **P3**). 참 39 / 잡음 3 의 `footprintAreaPx`·`outOfFramePts`·`depthM`·`edgeHit` 4변 분포가 `quantiles` 로 출력될 것.

### 단계 3 — 분포에서 게이트 값을 정하고 게이트 켠다

단계 2 분포에서 `minFootprintAreaPx`·`maxOutOfFramePts` 를 도출(**참 39건을 하나도 안 죽이는 최대값**을 고른다 — P4 가 손실 ≤1면을 요구). `depthLoM/HiM` 은 분포가 분리를 보이지 않으면 **null 유지**.
```bash
npx tsx src/tools/individualEngine.ts v1 --gate --out reports/overlay_r23a
```
**검증**: **P1 · P4** 충족. 실패 시 §6 분기.

### 단계 4 — σ 관측소스

```bash
npx tsx src/tools/individualEngine.ts v1 --gate --sigma 10 --shadow 15 --out reports/overlay_r23a
```
**검증**: 게이트 유무 두 값을 나란히 기록. 판정선 아님(부가 기록).

### 단계 5 — 스샷 육안 (§5)

`reports/overlay_r23a/` 전 파일을 **`Read` 로 열어** §5의 3문에 답한다. **본 것을 수치와 함께** 문서에 적는다. 그림이 수치와 어긋나면 **그림을 믿고 재분석**한다(22회차 §8-1 선례 2건).

### 단계 6 — 유닛테스트 `test/individualEngine.test.ts`

최소 8테스트:
1. `proposeFromObservation` 는 관측 1건에 면 **0 또는 1개**만 낸다(반환 타입 · G1)
2. 소스 코드 문자열에 `filledIndices`·`latticeIndex`·`expectedBays`·`coverage`·`refScore`·`rowMinScoreRatio`·`effectiveScore` 가 **없다**(G2·G3·G5·G6 정적 봉인 — `roiAutoSeal` 패턴)
3. **봉인**: `faceSlot`/`presetId`/`visible` 을 바꿔도 `runEngine` 의 산출 quad JSON **비트 동일**(P5)
4. `pos` 를 바꾸면 산출이 달라진다(대조군)
5. `gateBay` 는 각 조건이 독립으로 작동한다(`failed` 배열 검사)
6. `resolveBays` 는 `quadIoU ≥ mergeIoU` 인 쌍에서 서열 상위만 남긴다
7. `resolveBays` 는 겹치지 않는 제안을 하나도 안 죽인다
8. `scoreBays` 는 프리셋 접두 키로 면을 센다(`carAnchorUpper.test.ts:179` 회귀 방지 승계)

**검증**: `npx vitest run` **전체 green**(22회차 기준선 294파일 3742 + 신규분) · `npx tsc --noEmit` exit 0.

### 단계 7 — 최종 무회귀 재확인

```bash
npx tsx src/tools/roiAutoRecall.ts v1 evidence rows --raw
git status --porcelain -- src/ground src/rpc web    # ★ 출력이 없어야 한다
```
**검증**: 단계 0과 **비트 동일** · 검출 소스 무접촉 확인. `roi.auto.apply` 0회 · `roi.create2d` 0회 · 카메라 이동 0회 · Unity RPC 는 `car.list` **읽기만**.

---

## 9. 영향 받는 파일 (문서화 담당에게)

| 파일 | 종류 | 비고 |
|---|---|---|
| `src/tools/individualEngine.ts` | **신규** | 어느 모듈도 import 하지 않는 단방향 |
| `test/individualEngine.test.ts` | **신규** | 8테스트 |
| `src/tools/carAnchorUpper.ts` | **수정 — `export` 키워드 10곳만** | 로직 0줄. 3중 증거로 무해성 증명(§1-4) |
| `reports/overlay_r23a/` | 신규 산출 | git 제외 대상 |
| `src/ground/*` · `src/rpc/services/*` · `web/*` | **무접촉 0줄** | 단계 7에서 `git status` 로 증명 |
| `data/Place01/PtzCamRoi.json` · `data/setting.sqlite` · `config/` · `data/lens_calibration.json` | **무접촉(읽기만)** | `lens_calibration.json` 은 **옆 세션 자산** |
