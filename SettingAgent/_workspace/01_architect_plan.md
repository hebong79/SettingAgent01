# 01. 설계 — 점유영역 사다리꼴 표시(번호판 앵커) + 겹침 회피 자동 폭 스케일

> 설계자(architect) 산출물. 2026-07-16.
> 직전 세션 산출물은 `_workspace_prev_20260716/` 으로 이관(00_HANDOFF 포함, vpd-seg-cuboid·OccupancyJudge 세션).
> 실행 모드: **B. goal/loop** (성공 기준이 시각 관찰형 — 사다리꼴 모양·겹침·수평 정합).

---

## 0. 마스터 요구사항(원문)과 해석

> "점유판단후 점유 영역을 표시 할때 번호판 중심으로 상하좌우로 사다리꼴 모양의 4점을 만들어줘.
>  단, 1. 점유영역이 서로 겹치면 안된다. 2. 번호판중심으로 위가 좀 길어야 한다.
>  3. 가로/세로 모두 번호판영역의 가로 세로의 수평을 유지해야 한다. 4. 가로크기는 3.5~4배 정도 - 서로 겹치면 안됨.
>  가로크기 잡을때는 loop를 계속 돌아 크기를 자동으로 설정가능하게 만들어줘."

| # | 요구 | 해석(확정) | 근거 |
|---|------|-----------|------|
| R1 | 점유영역 서로 겹침 금지 | **하드 제약**. 겹침 판정 = `convexIntersectionArea > AREA_EPS(1e-6)` | 1e-6 정규화 면적 ≈ FHD(1920×1080) 기준 약 2px² — "선이 스치는" 수준 이하만 허용. EPS(1e-9)는 부동소수 잡음과 구분 불가 |
| R2 | 번호판 중심으로 위가 좀 길다 | **(a) 세로 방향 비대칭**: 중심→위 변 거리 > 중심→아래 변 거리 (`upRatio > downRatio`) 를 기본 채택. (b) "위 변의 폭" 해석은 `topWidthRatio` 파라미터로 별도 표현(아래 §2) | "길다"는 국어상 연장(extent)을 지칭. 주차 카메라는 위에서 내려다보고 번호판은 차량 전면(가까운 쪽)에 붙으므로 차체는 화면 위쪽으로 뻗음 → 위로 길어야 차량을 덮음. 두 해석 모두 파라미터로 존재하므로 goal/loop 관찰 중 즉시 전환 가능 |
| R3 | 가로/세로 모두 번호판의 수평 유지 | 사다리꼴 **위/아래 변 ∥ 번호판 가로축(û)**, **중심축(위변중심↔아래변중심) ∥ 번호판 세로축(v̂)**. 좌우 빗변 자체는 사다리꼴 정의상 v̂ 와 평행 불가(위/아래 폭이 다르므로) — 중심축 평행이 "세로 수평"의 성립 가능한 유일 해석 | 기하적으로 위폭≠아래폭 + 좌우변∥v̂ 는 모순. `topWidthRatio=1.0`(평행사변형)일 때만 좌우변도 v̂ 평행 |
| R4 | 가로크기 3.5~4배, loop 로 자동 | 배율 기준 = **번호판 폭 W**(평균 엣지). 런타임 **결정형 자동 탐색 루프**(§3)가 [3.5, 4.0] 에서 겹침 없는 최대 배율을 찾음 | "3.5~4배"는 실측 근거 있음: 한국 번호판 폭 ≈ 0.52m, 승용차 폭 ≈ 1.8~2.0m → 비 3.5~3.9 |

**두 개의 "loop" 구분(혼동 금지):**
- **(A) 런타임 자동 탐색 루프** — 코드 내부. 매 프레임 순수 함수로 실행되는 배율 이진탐색+축소 루프(§3).
- **(B) 개발 goal/loop** — 하네스 B모드. 구현→스샷 관찰→파라미터 보정 반복(§7).

**MCP 경계 판단**: 본 기능은 수치 반복·기하 계산(고빈도 프레임 루프) → 전부 **결정형 코드**. LLM 두뇌 개입 없음.

---

## 1. 현재 코드 사실(설계 근거, 직접 확인분)

| 항목 | 위치 | 사실 |
|------|------|------|
| 점유 판정 | `web/occupancy.js:138 OccupancyJudge.judge` | 1단계 plate(`computeOccupancy` 위임) → 2단계 bbox 폴백. plate 행 = `{idx, occupied:true, source:'plate', center}` — **plate quad 자체는 유실됨** |
| plate 매칭 원본 | `web/core.js:474 computeOccupancy` | `plates.map(quadCentroid).filter(...)` 로 **중심만 남기고 quad 를 버림** → 여기서 quad 를 보존해야 함 |
| plate 점 순서 규약 | ultralytics OBB | `NormalizedQuad = [TL, TR, BR, BL]`, 0~1 정규화 |
| 오버레이 | `web/app.js:381 drawOccupancyOverlay` | `state.occComputeByKey[key].spaces` 를 소스로 plate=빨강 원, bbox=주황 원+'번호미인식'. `#roi-occupancy` 토글 가드 |
| 판정→state 배선 | `web/app.js:359 updateLogicOccupancy` | judge 결과를 명시적 필드 매핑으로 `spaces` 에 저장 |
| 기하 유틸(브라우저) | `web/occupancy.js` | `polygonArea/polygonCentroid/clipByHalfPlane/convexIntersectionArea` **이미 export 됨**(파리티 테스트 봉인) — 재사용, 신규 발명 금지 |
| 최종화 스냅샷 | `web/app.js:1929` | `occComputeByKey → [{key, spaces:[{idx, occupied}]}]` 만 추출 — region 추가와 무관 |
| 기존 테스트 강한 단언 | `test/occupancyJudge.test.ts:54` | T1이 judge 행 투영과 `computeOccupancy` 원본을 `toEqual` 비교 — computeOccupancy 반환 확장 시 **이 한 줄만** 투영 보정 필요(§6) |

---

## 2. 수학 모델

### 2-1. 번호판 축 정의 (논점 1 결정)

quad `[TL, TR, BR, BL]` 에서 **대변 평균 엣지 방향**:

```
u_raw = ((TR−TL) + (BR−BL)) / 2      // 가로(위+아래 엣지 평균)
v_raw = ((BL−TL) + (BR−TR)) / 2      // 세로(좌+우 엣지 평균)
û = u_raw / |u_raw| ,  v̂ = v_raw / |v_raw|
W = (|TR−TL| + |BR−BL|) / 2          // 번호판 폭(배율 기준)
```

**결정 근거**: 원근 왜곡 quad 를 bilinear 곡면으로 볼 때 대변 평균은 파라미터 중심(0.5, 0.5)에서의 접선 방향과 일치 — "번호판 중심에서의 가로/세로 방향"이라는 R3 요구에 정확히 부합. 단일 엣지 채택 대비 OBB 정점 잡음이 절반으로 평균화됨. 대안(단일 엣지, 최소외접사각형 등)은 잡음 민감·과설계로 기각.

**방향 정규화(안전장치)**: OBB 가 180° 뒤집혀 검출되면 v̂ 가 화면 위(−y)를 향한다. `v_raw.y < 0` 이면 `û ← −û, v̂ ← −v̂` 동시 반전(핸디드니스 보존). 화면상 "위"는 항상 `−v̂` 로 일관.

**퇴화 가드**: `|u_raw| < 1e-9` 또는 `|v_raw| < 1e-9` 또는 quad 비4점 → 해당 인스턴스 region 생성 skip(null, throw 금지 — 강등 철학).

### 2-2. 사다리꼴 4점 생성 (논점 2 통합 모델)

번호판 중심 `C = quadCentroid(quad)`(기존 judge center 와 동일 정의), 배율 `s`:

```
bw = s · W                              // 아래 변 전체 폭 (배율 기준변)
tw = topWidthRatio · bw                 // 위 변 전체 폭
Ct = C − (upRatio · bw) · v̂            // 위 변 중심 (−v̂ = 화면 위)
Cb = C + (downRatio · bw) · v̂          // 아래 변 중심

TL' = Ct − (tw/2)·û      TR' = Ct + (tw/2)·û
BL' = Cb − (bw/2)·û      BR' = Cb + (bw/2)·û
반환 순서: [TL', TR', BR', BL']         // 기존 quad 규약 유지
```

성질: 위/아래 변 ∥ û (R3 가로), Ct·Cb 모두 직선 `C + t·v̂` 위 → 중심축 ∥ v̂ (R3 세로), `upRatio > downRatio` → 위로 김 (R2), 볼록(사다리꼴) — `convexIntersectionArea` 전제 충족.

### 2-3. 파라미터 표

| 파라미터 | 기본값 | 의미 | 근거 |
|----------|--------|------|------|
| `widthScaleMax` | 4.0 | 배율 탐색 상한 | 마스터 명시 "3.5~4배" |
| `widthScaleMin` | 3.5 | 배율 탐색 하한(전역 단계) | 동상 |
| `topWidthRatio` | 1.0 | 위 변 폭 / 아래 변 폭 | (갱신 2026-07-16) 마스터 지시로 평행사변형 확정(0.85→1.0), 구 원근 논거는 번호판이 수직면이라 미성립. 구 근거였던 "카메라가 내려다볼 때 먼 쪽(위)이 원근상 좁음"은 번호판이 수직면이고 사다리꼴의 '위'(−v̂)가 더 먼 곳이 아니라 더 높은 곳이라 성립하지 않았음. `topWidthRatio` 는 여전히 `RegionConfig` 파라미터로 남아 있어 필요 시 사다리꼴(<1.0)로 복귀 가능 |
| `upRatio` | 0.90 | 중심→위 변 거리 / bw | 차체가 위로 뻗는 몫. **goal/loop 3차 스윕 육안 판정으로 확정(0.55→0.90)** — 0.55 는 앞코만 덮어(덮음률 p1 30.8%/p3 12.6%) "위가 좀 길어야 한다"가 시각적으로 약함. 0.90 은 p1 덮음률 43.8%, 사선뷰 p3 에서도 이웃침범률 14.6% < 자기 차 덮음률 18.9% 로 우위 유지. 1.30↑ 는 p1 상단이 지붕을 넘어 배경으로 뻗고 1.70 은 p3 이웃침범(33.6%)이 자기 차 덮음(33.3%)을 추월 → 오인 유발. R1·R4 무제약 확인(스윕 전 8수준 `globalScale=4.0`, `overlapPairs=[]`, 최대 교차면적 0.000e+0 — 사다리꼴은 v̂ 방향으로만 자라 좌우 평행 띠끼리 만나지 않음) |
| `downRatio` | **0.60**(갱신 2026-07-16, 구값 0.30) | 중심→아래 변 거리 / bw | 마스터 지시로 2배 확정(0.30→0.60). upRatio(0.90) > downRatio(0.60) 로 R2 충족(비 3.00→1.50) — 상세 `_workspace/15_developer_changes_downratio.md`·`16_qa_report_downratio.md` |
| `scaleQuantum` | 0.05 | 전역 배율 그리드 스냅(내림) | 프레임간 검출 떨림 → 배율 미세 요동 억제(무상태 결정성 유지). §3-4 |
| `areaEps` | 1e-6 | 겹침 판정 면적 임계 | R1 표 참조 |
| `shrinkFactor` | 0.9 | 인스턴스별 축소율(폴백 단계) | 기하급수 축소 → 종료 보장. §3-3 |
| `maxShrinkIters` | 20 | 폴백 축소 반복 상한 | 0.9²⁰ ≈ 0.12 — 그 아래로 줄여도 안 풀리면 중심 자체가 밀착(비정상 검출) → 보고로 강등 |
| `minScale` | 1.0 | 인스턴스 배율 하한 | 번호판 폭 미만 축소는 무의미(중심 원이 이미 있음) |

전부 `RegionConfig` 생성자/인자 기본값 — **UI 노출 없음**(요구 없음, 규칙 2).

### 2-4. 경계 클램프 (논점 4 결정)

생성된 사다리꼴을 단위 정사각형 4개 내향 반평면(`x≥0, x≤1, y≥0, y≤1`)으로 `clipByHalfPlane` 4회 클립. 결과는 볼록 3~8각형(오버레이는 다각형 그대로 렌더). 전부 잘리면(정점 0) region=null.
**겹침 판정도 클램프 후 다각형으로 수행** — 화면에 보이는 영역이 판정 대상이며, 클립은 부분집합 연산이라 §3 단조성을 깨지 않음.

### 2-5. bbox 폴백 (논점 5 결정)

`source==='bbox'`(번호판 없음)는 **사다리꼴 미생성** — 기존 주황 원 + '번호미인식' 유지.
근거: 요구 원문이 "번호판 중심으로"이며 축(û, v̂)의 정의 자체가 plate quad 를 요구. bbox 에서 유사 사다리꼴을 발명하는 것은 추측성 코드(규칙 2). bbox region 은 겹침 판정 모집단에도 미포함.

---

## 3. 런타임 겹침 회피 자동 배율 탐색 (논점 3 결정)

### 3-1. 전역 단일 배율 + 인스턴스별 폴백(2단계)

- **1단계(주)**: 전역 단일 `s` — 모든 사다리꼴이 같은 배율 → 균일한 시각, "3.5~4배"라는 전역 스펙에 부합, 탐색 공간 1차원.
- **2단계(폴백)**: 하한 3.5 에서도 겹치는 **쌍만** 개별 축소 — R1(하드 제약)을 지키기 위한 최소 개입. 겹치지 않는 인스턴스는 3.5 유지.

### 3-2. 단조성 논거(이진탐색 정당성)

모든 정점이 `C + s·(상수벡터)` 꼴(§2-2: bw, tw, up, down 모두 s 에 비례) → `s' < s` 이면 region(s') 는 region(s) 의 **C 중심 스타형 부분집합**. 단위사각 클립도 부분집합 보존. 따라서 임의 쌍의 교차 면적은 s 에 대해 단조 비감소 → "겹침 없음" 술어는 s 에 대해 단조 → 이진탐색 유효.

### 3-3. 의사코드

```
computeOccupancyRegions(items, cfg):            // items = [{idx, quad}] plate 점유분, idx 오름차순 정렬
  axes[i] ← plateAxes(items[i].quad)            // null(퇴화)은 모집단 제외
  regionAt(i, s) ≔ clampToUnit(buildTrapezoid(axes[i], s))
  anyOverlap(s) ≔ ∃ i<j: convexIntersectionArea(regionAt(i,s), regionAt(j,s)) > areaEps

  // ── 1단계: 전역 이진탐색 [3.5, 4.0], 12회 고정 ──
  if !anyOverlap(4.0): s* ← 4.0
  else if anyOverlap(3.5): goto 2단계
  else:
    lo ← 3.5; hi ← 4.0                          // 불변식: lo 비겹침, hi 겹침
    repeat 12: mid ← (lo+hi)/2; anyOverlap(mid) ? hi←mid : lo←mid
    s* ← floor(lo / scaleQuantum) · scaleQuantum // 0.05 그리드 내림(축소 방향 → 비겹침 유지)
    s* ← max(s*, 3.5)
  return { regions: [regionAt(i, s*)…], globalScale: s*, overlapPairs: [] }

  // ── 2단계: 인스턴스별 shrink-to-fit (전역 3.5 에서도 겹침일 때만) ──
  scale[i] ← 3.5 ∀i
  repeat ≤ maxShrinkIters(20):
    pairs ← 겹치는 (i,j) 전부 (i<j, idx 순 결정적 순회)
    if pairs = ∅: break
    for (i,j) in pairs: scale[i] ← max(minScale, scale[i]·0.9); scale[j] ← max(...)
  return { regions: [regionAt(i, scale[i])…], globalScale: null,
           overlapPairs: 잔존 겹침 쌍 }          // 잔존 시에도 표시는 함 + 호출측 console.warn 1회
```

- **복잡도**: 1단계 O(12 · N² · k²), 2단계 O(20 · N²) — N(프리셋당 점유면) ≤ ~30, k(클립 후 정점) ≤ 8 → 프레임당 마이크로초 대. 성능 무풍.
- **종료 보장**: 두 단계 모두 고정 반복 상한. 2단계는 기하급수 축소 + minScale 클램프로 무한루프 불가.
- **결정성**: 순수 함수(입력 quads + cfg → 출력), 난수·시각·상태 없음, 쌍 순회는 idx 정렬 고정 → 같은 입력이면 항상 같은 출력.
- **프레임 떨림(hysteresis 판단)**: 상태 보유 hysteresis 는 도입하지 않음 — 순수성·테스트 용이성 훼손 대비 이득 불확실. 대신 무상태인 `scaleQuantum` 스냅(0.05)으로 배율 요동을 흡수. goal/loop 관찰에서 떨림이 실재하면 후속 과제로 명시(§9 리스크).

---

## 4. 모듈 구조 · 공개 API (논점 6 결정)

**신규 `web/occupancyRegion.js` (+ `occupancyRegion.d.ts`) — 브라우저 순수 ESM 단일 소스.**
근거: 소비처가 뷰어 오버레이뿐(서버 미사용) → `src/domain` 원본+파리티 포트는 이중 소스 유지비만 발생(규칙 2·3). `OccupancyJudge`(web 단일 소스 + .d.ts 짝) 선례를 따름. 기하 프리미티브는 **재사용**: `./occupancy.js` 의 `clipByHalfPlane/convexIntersectionArea/polygonArea`(export 확인됨), `./core.js` 의 `quadCentroid`. 서버가 쓰게 되는 시점에 src 이관+파리티 테스트로 승격(그때 결정).

```ts
// web/occupancyRegion.d.ts (신규)
import type { NormalizedPoint } from './core.js';

export interface RegionConfig {
  widthScaleMin?: number;   // 3.5
  widthScaleMax?: number;   // 4.0
  topWidthRatio?: number;   // 0.85
  upRatio?: number;         // 0.55
  downRatio?: number;       // 0.30
  scaleQuantum?: number;    // 0.05
  areaEps?: number;         // 1e-6
  shrinkFactor?: number;    // 0.9
  maxShrinkIters?: number;  // 20
  minScale?: number;        // 1.0
}

export interface PlateAxes {
  c: NormalizedPoint;   // 번호판 중심(quadCentroid)
  u: NormalizedPoint;   // û 단위 가로축
  v: NormalizedPoint;   // v̂ 단위 세로축(화면 아래 방향 보장)
  width: number;        // W (대변 평균 폭)
}

export interface OccupancyRegion {
  idx: number;                      // 입력 items[i].idx 그대로
  scale: number;                    // 적용 배율(전역 or 개별)
  polygon: NormalizedPoint[];       // 클램프 후 볼록 3~8각형(퇴화 시 미포함)
}

export interface RegionResult {
  regions: OccupancyRegion[];       // 퇴화/전부클립 인스턴스는 제외
  globalScale: number | null;       // 1단계 성공 시 값, 2단계 진입 시 null
  overlapPairs: Array<[number, number]>; // 최종 잔존 겹침(idx 쌍) — 정상 시 []
}

export function plateAxes(quad: NormalizedPoint[] | null | undefined): PlateAxes | null;
export function buildTrapezoid(axes: PlateAxes, scale: number, cfg?: RegionConfig): NormalizedPoint[]; // [TL,TR,BR,BL] 미클램프
export function clampToUnit(poly: NormalizedPoint[]): NormalizedPoint[];
export function computeOccupancyRegions(
  items: Array<{ idx: number; quad: NormalizedPoint[] }>,
  cfg?: RegionConfig,
): RegionResult;
```

### 데이터 흐름(배선)

```
judge(floorPolys, detect)                        // plate 행에 plateQuad 신규 탑재(§5)
  → app.js updateLogicOccupancy:
      plateItems = rows.filter(r => r.source==='plate' && r.plateQuad)
                       .map(r => ({ idx: r.idx, quad: r.plateQuad }))
      result = computeOccupancyRegions(plateItems)
      spaces[i].region = result.regions.find(g => g.idx === …)?.polygon   // 없으면 undefined
      result.overlapPairs.length → 프리셋당 1회 console.warn (floorRoiFileWarned 패턴)
  → drawOccupancyOverlay: sp.region 있으면 다각형(반투명 채움 + 윤곽) 먼저 → 기존 원/라벨 그 위에 유지
```

---

## 5. 변경 파일 목록

| 파일 | 변경 요지 |
|------|-----------|
| `web/occupancyRegion.js` **신규** | §2~§3 전체(plateAxes/buildTrapezoid/clampToUnit/computeOccupancyRegions). 기하는 occupancy.js·core.js 재사용 |
| `web/occupancyRegion.d.ts` **신규** | 상기 타입 선언(occupancy.d.ts 짝 관례) |
| `web/core.js` | `computeOccupancy` 내부 `centers` → `{center, quad}` 레코드 유지, occupied 행에 `plateQuad` 필드 **추가**(기존 필드 불변, additive) |
| `web/core.d.ts` | `computeOccupancy` 반환 행에 `plateQuad?: NormalizedPoint[]` 추가 |
| `web/occupancy.js` | `judge` 1단계 매핑에 `plateQuad: r.plateQuad` 한 줄 추가(plate 행만) |
| `web/occupancy.d.ts` | `OccupancyJudgement.plateQuad?: NormalizedPoint[]` 추가 |
| `web/app.js` | `updateLogicOccupancy` region 계산·저장(+overlapPairs 경고 1회 가드), `drawOccupancyOverlay` region 다각형 렌더(기존 원·배지 유지, `#roi-occupancy` 토글 하위 — **신규 UI 없음**) |
| `test/occupancyJudge.test.ts` | **:53-54 한 곳**: T1 동치 비교에서 base 도 `{idx,occupied,center}` 로 투영(plateQuad additive 로 인한 toEqual 보정). 그 외 무변경 |
| `test/occupancyRegion.test.ts` **신규** | §6 T1~T14 |

서버(src/)·DB·라우트·UI(html) 변경 없음.

---

## 6. 유닛테스트 설계 (`test/occupancyRegion.test.ts`, vitest — web/*.js 직접 import 관례)

| # | 케이스 | 입력 | 기대 | 의도 |
|---|--------|------|------|------|
| T1 | 축: 축정렬 plate | 정렬 quad(폭 0.04, 높이 0.02) | `u≈(1,0)`, `v≈(0,1)`, `width≈0.04`, `c`=quadCentroid | 축 정의 기본 |
| T2 | 축: 회전 plate | T1 을 30° 회전 | û·v̂ 도 30° 회전, 사다리꼴 위/아래 변 방향과 û 의 외적 ≈ 0 | R3 가로 수평 |
| T3 | 위가 길다 | 기본 cfg | \|Ct−C\| / \|Cb−C\| = upRatio/downRatio (0.55/0.30) | R2 |
| T4 | 사다리꼴 폭비 | 기본 cfg | \|TR'−TL'\| = 0.85 × \|BR'−BL'\|, 반환 순서 [TL,TR,BR,BL] 볼록 | topWidthRatio·규약 |
| T5 | 중심축 세로 평행 | 회전 plate | (Ct−Cb) ∥ v̂ (외적 ≈ 0) | R3 세로 수평 |
| T6 | 단독 1개 | 이미지 중앙 plate 1개 | `globalScale=4.0`, regions 1개, overlapPairs=[] | 상한 채택 |
| T7 | 이격 2개 | 4.0 에서도 비겹침 배치 | `globalScale=4.0`, 전 쌍 교차면적 ≤ areaEps | 탐색 조기 종료 |
| T8 | 근접 2개(중간) | 4.0 겹침·3.5 비겹침 배치 | `3.5 ≤ globalScale < 4.0`, `globalScale`이 0.05 그리드 위, 결과 비겹침 | 이진탐색+스냅 |
| T9 | 극근접 2개 | 3.5 에서도 겹침 배치 | `globalScale=null`, 해당 쌍 scale < 3.5, 최종 비겹침(또는 20회 후 overlapPairs 보고) | 2단계 폴백 |
| T10 | 결정성 | T9 입력 2회 호출 | 결과 딥이퀄 | 결정성 |
| T11 | 경계 클램프 | plate 를 이미지 모서리(0.02, 0.02) 근처 | polygon 전 정점 ∈ [0,1]², 면적 > 0, 정점수 3~8 | 논점 4 |
| T12 | 퇴화 | 비4점 quad / 0-길이 엣지 quad 혼입 | 해당 인스턴스만 regions 제외, throw 없음, 나머지 정상 | 강등 철학 |
| T13 | computeOccupancy 확장 | 기존 plateAt 픽스처 | occupied 행에 `plateQuad`=입력 quad(참조 or 딥이퀄), 비점유 행 무변화(`{idx,occupied:false}` 그대로) | §5 하위호환 |
| T14 | judge 전달 | plate 점유 + bbox 점유 혼합 | plate 행만 `plateQuad` 보유, bbox 행 미보유, 기존 필드 전부 회귀 무 | 논점 7 |
| T15 | v̂ 방향 정규화 | 점 순서 180° 반전 quad | v̂.y > 0 로 보정, '위'(−v̂) 일관 → T3 성립 | §2-1 안전장치 |

성공 게이트: `npx tsc -p tsconfig.json --noEmit` exit 0 + `npx vitest run` 전량 통과(기존 ~150 파일 포함).

---

## 7. 경험적 검증 계획 (개발 goal/loop — B모드)

**Goal(명문화)**: 실프레임(`data/refframes` 또는 라이브 뷰어)에서 plate 점유 슬롯마다 사다리꼴이 그려지고, ① 어떤 두 사다리꼴도 겹치지 않으며(`overlapPairs=[]` 로그 확인), ② 각 사다리꼴 위/아래 변이 해당 번호판 가로 기울기와 평행하게 보이고, ③ 중심 기준 위쪽이 길며, ④ 폭이 차량 폭을 근사(≈3.5~4×번호판)한다 — 를 스샷 육안 + 수치 로그로 동시 만족.

**이터레이션 절차**:
1. 구현 → 유닛테스트 통과(§6 게이트).
2. 오프라인 스샷: `data/refframes` 프레임 + 저장된 detect(있으면)로 `computeOccupancyRegions` 실행 → **sharp SVG→PNG 합성**(사다리꼴+번호판 quad+중심 오버레이) — `_workspace/_qa_*` 스크립트 관례(`_qa_live_roi_overlay.mjs` 참조) 재사용.
3. 라이브 확인: `SettingAgent> npm start` → `http://localhost:13020/viewer/` 프리셋 순회, `#roi-occupancy` 토글 상태에서 관찰.
4. 관찰 판정: 겹침(콘솔 overlapPairs)·수평·위길이·폭. 틀어지면 `topWidthRatio → upRatio/downRatio` 순으로 보정(§2-3 튜닝 대상 표기) 후 2로 복귀.
5. 프레임 떨림 관찰: 라이브 3fps 에서 사다리꼴 크기 요동 여부 — 요동 시 scaleQuantum 0.05→0.1 상향 검토.

**성공 판정 기준**: 전 프리셋 스샷에서 겹침 0건 + 시각 항목 3개 충족 + 유닛테스트 전량 통과 → qa/documenter 단계로 이관. 시각 판단이 애매한 프레임은 스샷을 증거로 마스터 보고.

---

## 8. 영향도 분석

| 영역 | 영향 | 판단 |
|------|------|------|
| `test/computeOccupancy.test.ts` | occupied 행 단언은 `toMatchObject`+`toBeCloseTo`, 비점유 행 `toEqual` 은 무변화 → **수정 불요, 통과 유지** | 확인됨(파일 직접 검토) |
| `test/occupancyJudge.test.ts` | **T1(:53-54)만** base 투영 보정 필요(§5). T2~T9·config 는 bbox/비점유 행 단언 → plateQuad 미부착이라 무영향 | 확인됨 |
| `test/lpdFilterRegression.test.ts` 등 | `computeOccupancy` 결과를 `{idx, occupied}` 로 투영해 사용 → 무영향 | 확인됨(:79-80, :236) |
| `web/core.js buildFlatSlotRows(:606)` | `occupied` 만 소비 → 무영향 | 확인됨 |
| `web/app.js` 최종화 스냅샷(:1929) | `{idx, occupied}` 만 추출 → 서버/DB 계약 무변경 | 확인됨 |
| `state.occComputeByKey` 소비처 | `spaces[i].region` 은 additive — 기존 렌더·뱃지 로직 무영향 | updateLogicOccupancy/draw 만 접점 |
| 성능 | 프레임당 O(N²·12) 미세 기하 연산(N≤~30) — 3fps 렌더 루프에서 무시 가능 | §3-3 |
| 서버(src/)·DB·라우트 | 변경 없음 | — |

---

## 9. 리스크와 대응

| 리스크 | 대응 |
|--------|------|
| OBB 점 순서 반전(180°) 입력 → 사다리꼴이 아래로 김 | §2-1 v̂.y 부호 정규화(T15 로 봉인) |
| 번호판이 ~90° 회전 검출(v̂.y≈0) | 드묾. 정규화 미적용(있는 그대로) — goal/loop 관찰에서 문제 시 후속 |
| topWidthRatio 방향(위가 좁음)이 마스터 의도와 다를 가능성 | 파라미터 1개 전환(1.0 초과도 허용되는 통합 모델) — goal/loop 스샷으로 마스터 확인, 기본 0.85 의 근거는 원근(§0 R2) |
| 프레임간 배율 떨림 | scaleQuantum 스냅(무상태). 잔존 시 후속: quantum 상향 → 그래도면 hysteresis(상태 도입) 별도 과제 |
| 2단계 폴백 20회 후에도 겹침(중심 밀착 오검출) | 표시는 유지 + `overlapPairs` 보고·console.warn 1회 — R1 위반을 숨기지 않고 드러냄 |
| 밀집 주차장에서 이웃 slot 차량과 시각적 침범(비겹침이어도 남의 차 위) | 사다리꼴은 "점유 표시"이지 정밀 세그먼트가 아님 — 요구 범위. 정밀화는 VPD seg 마스크(기존 기능)와의 결합 후속 |

---

## 10. 미해결/가정 사항 (마스터 확인 항목 — 권장 기본값으로 진행)

1. **"위가 길다"** = 세로 연장(해석 a) 채택, 위 변 폭은 원근상 좁게(0.85). 두 값 모두 파라미터라 스샷 확인 후 즉시 반영 가능. → **권장 기본값으로 진행, goal/loop 스샷에서 확정.**
2. **bbox 폴백은 사다리꼴 미표시**(번호판 없음 = 축 없음). → 필요 시 후속 요구로.
3. **UI 파라미터 노출 없음**(코드 기본값만). → 요구 시 후속.

---

## 다음 단계(구현자 인계)

```
1. web/occupancyRegion.js/.d.ts 작성(§2~§4)            → 검증: T1~T12, T15
2. core.js/occupancy.js plateQuad additive 확장(§5)    → 검증: T13~T14 + 기존 테스트 전량(occupancyJudge T1 투영 보정 포함)
3. app.js 배선(updateLogicOccupancy/drawOccupancyOverlay) → 검증: tsc+vitest 게이트 → §7 goal/loop 스샷 이터레이션
```
