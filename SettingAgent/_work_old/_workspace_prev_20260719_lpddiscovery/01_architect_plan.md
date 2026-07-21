# 설계서: LPD discovery 검지율 개선 — 앵커 하향(A) + 2D 격자 크롭 탐색(B)

- 작성: architect (Fable) / 2026-07-19
- 모드: goal/loop B (성공기준 = 시뮬 6슬롯 검지율 관찰형)
- 범위: discovery 코어 국한 — `plateDiscovery.ts` · `cropZoom.ts` · `plateDiscoveryWriter.ts`. 라우트·DB 스키마·types 계약 변경 없음.

---

## 1. 근본원인 요약 (코드 근거 재확인)

**원인 1 — 앵커 수직 오프셋.**
discovery 앵커 = `DiscoveryTarget.anchor` = `v.slot3dFrontCenter`
([plateDiscoveryWriter.ts:24] `anchor: v.slot3dFrontCenter`).
이 값은 Finalizer가 기하 산출한 **육면체 앞면 4모서리 평균**
([Finalizer.ts:252] `slotFrontCenter(sp.points, model, H_CONST)`, [Finalizer.ts:41] `H_CONST = 1.5`,
[project.ts:112] `frontFaceCenterPx` = 앞면 바닥 2코너 + 상면 2코너 평균).
→ 앞면 중심의 실효 높이는 지상 **H_CONST/2 = 0.75m**. 실제 번호판은 지상 ≈0.3~0.5m.
하향 틸트 카메라에서 높이가 낮을수록 화면 y가 커지므로 번호판은 앵커보다 항상 **아래**에 맺힌다.

**원인 2 — 크롭이 아래로 안 내려감.**
Tier1 루프([plateDiscovery.ts:122-140])는 매 스텝
`computeCropWindow(anchor, frac, aspect)` — **동일 앵커 중심 고정**, frac만 `frac0·shrink^(k-1)`로 축소.
창이 줄수록 앵커 아래쪽 번호판이 창 밖으로 탈락(확대가 역효과). 하향/사방 이동 탐색이 없다.

---

## 2. A — 앵커 하향 방식 결정

### 2-1. 두 안의 트레이드오프

| | ① 정규화-보간안 (저렴안) | ② 지면모델 재투영안 (정밀안) |
|---|---|---|
| 방법 | slot_setup의 `roi`(바닥 quad)에서 앞 edge 중점(h=0)을 구하고, `slot3dFrontCenter`(h=0.75)와 **선형보간**으로 번호판 높이 점 산출 | discovery 경로에서 GroundModel을 다시 로드해 `projectPointAtHeight(ground, 0.4, g)` 재투영 |
| 정확도 | **수학적으로 정밀안과 동일**(아래 증명) | 기준 정밀 |
| 비용 | 순수함수 몇 줄, 입력은 이미 `SlotSetupView`에 있음 | `buildGroundModelMap` 재현( PtzCamRoi/camerapos 파일 IO ) 또는 DB 컬럼 추가 — 무거움 |
| 실패모드 | roi 부재/퇴화 → 기존 앵커 폴백 | 지면모델 부재 프리셋 전체 앵커 상실(강등 경로 추가 필요) |

**핵심: ①은 근사가 아니라 항등이다.** [project.ts:7-8]의 파리티 증명대로 높이 h 점의 픽셀은
`p(h) = p(0) − h·(s₀/d)·kn` — **픽셀 좌표가 h에 대해 선형**이다. 따라서
- 앞 edge 바닥 중점 픽셀 `B` = h=0 점,
- `slot3dFrontCenter` `F` = (바닥 edge 중점 + 상면 edge 중점)/2 = **B를 h=H/2=0.75로 올린 점**(선형성),
- 번호판 높이 `hp` 점 = `B + (F − B) · (hp / 0.75)` — 재투영 결과와 **정확히 일치**(정규화도 선형이라 그대로 성립).

### 2-2. 결정 (추천 = ①)

- **산출 위치: `expandDiscoveryTargets`(expand 단계)**. 근거: discovery 입력 계약은 `DiscoveryTarget.anchor` 점 하나 — 여기서 하향하면 `PlateDiscovery.discoverSlot`·types·DB·라우트 전부 무변경. `slot3d_front_center` DB 값 자체는 **불변**(센터라이징 등 타 소비자 보호), discovery 전용으로만 국한된다.
- 신규 순수함수 (`plateDiscoveryWriter.ts` 내부, export하여 테스트):

```ts
/** 앞 edge = roi 4 edge 중 두 끝점 y평균 최대(frontFaceCornerIdx와 동일 판정, 정규화 좌표). */
export function lowerFrontAnchor(
  roi: NormalizedPoint[],            // v.roi (바닥 quad, 정규화)
  frontCenter: NormalizedPoint,      // v.slot3dFrontCenter (h=0.75 등가점)
  plateH = PLATE_H,                  // 0.4
): NormalizedPoint
```
  - 내부: 앞 edge 중점 `B` → `t = plateH / (H_CONST/2)` = 0.4/0.75 ≈ 0.5333 → `{ x: B.x + (F.x−B.x)·t, y: B.y + (F.y−B.y)·t }`.
  - 모듈 상수: `PLATE_H = 0.4` (0.3~0.5 중앙값, QA 튜닝 대상), `H_CONST = 1.5` (**Finalizer.ts:41과 동일값 — 주석으로 상호참조 명기**. Finalizer 것은 private이라 import 불가, 값 변경 시 양쪽 동기 필요를 주석으로 봉인).
  - 폴백: `roi` 길이≠4 또는 비유한 좌표 → `frontCenter` 그대로 반환(기존 동작, throw 금지).
- `expandDiscoveryTargets` 변경 1줄: `anchor: lowerFrontAnchor(v.roi, v.slot3dFrontCenter)`.

부수효과: Tier0 full의 `matchRadiusNorm` 게이트 중심도 하향점 기준이 됨 — 번호판 실위치에 더 가까워지므로 **개선 방향**(회귀 아님).

---

## 3. B — 2D 격자 탐색 상태전이 (loop 상한 30 — 마스터 요건)

### 3-0. 30칸 구성 트레이드오프 (결정: b안)

| | (a) 6줌레벨 × 5오프셋 | (b) 5줌레벨 × 6오프셋 — **추천** |
|---|---|---|
| level 말단 frac | 0.40·0.6⁵ ≈ **0.0311 < minFrac 0.05** → `frac<minFrac` 가드에 걸려 minFrac 하향(0.03) 필요 | 0.40·0.6⁴ ≈ **0.0518 ≥ 0.05** → minFrac·가드 무변경 |
| 검지율 관점 | 원본 폭 3% 초미세 크롭 — 업스케일 블러·주변 컨텍스트 소실로 LPD 검지 저하 우려 | 공간 커버리지(오프셋 6방) 확대 — 미검지의 잔여 원인(측방 산포)에 직접 대응 |
| 규약 변경 | minFrac 기본값 변경(추가 노브 이동) | 격자 배열·maxSteps만 조정(최소변경) |

**(b) 채택 근거**: A(앵커 하향)가 수직 오프셋을 항등 보정하므로, 잔여 미검지는 줌 심도보다 **측방/근방 커버리지** 부족일 가능성이 높다. 줌을 더 파는 (a)보다 오프셋을 넓히는 (b)가 100% 검지 목표에 부합하고 minFrac 규약도 건드리지 않는다.

### 3-1. 격자 정의 (줌 5레벨 × 오프셋 6방 = 정확히 30회)

- 오프셋 단위 = **창 크기 배수**(dx는 창폭 w배, dy는 창높이 h배) — 줌이 깊어질수록 이동량이 자동 축소되어 별도 스케일 관리 불요.
- `plateDiscovery.ts` 모듈 상수(하향 우선 순서 유지 — 원인1 보정 방향, 6번째부터 순수 좌/우):

```ts
const GRID_OFFSETS = [
  { dx: 0,    dy: 0   },  // 1. 중심(하향된 앵커)
  { dx: 0,    dy: 0.5 },  // 2. 하
  { dx: -0.5, dy: 0.5 },  // 3. 하좌(대각)
  { dx: 0.5,  dy: 0.5 },  // 4. 하우(대각)
  { dx: -0.5, dy: 0   },  // 5. 좌(순수)
  { dx: 0.5,  dy: 0   },  // 6. 우(순수)
] as const;
```
  (0.5배 이동 = 인접 창과 50% 겹침 → 경계 걸친 번호판 누락 방지. 구 5방안의 `(0, 1.0)`은 하향앵커 적용 후 과이동이라 제거하고 순수 좌/우 쌍으로 대체 — 측방 산포 커버.)
- 줌 레벨: `level = floor((k−1)/6)+1`, `frac = frac0·shrink^(level−1)` — 기본값 유지 시 0.40 / 0.24 / 0.144 / 0.0864 / 0.05184 (5레벨 모두 minFrac 0.05 이상 → 30회 전부 유효, **minFrac 조정 불요**).

### 3-2. 상태전이 (discoverSlot Tier1 교체)

```
Tier0 full: 기존 그대로 (원본 전체 LPD → 하향앵커 최근접 → matchRadius 통과 시 즉시 반환, step=0)
Tier1 grid: for k = 1 .. maxSteps(30):
  level = floor((k−1)/6)+1 ; frac = frac0·shrink^(level−1)
  if frac < minFrac → break                       // 안전 가드(기본값에선 미발동)
  off = GRID_OFFSETS[(k−1) % 6]
  c  = gridCenter(anchor, frac, aspect, off)      // 신규 순수함수 §4
  W  = computeCropWindow(c, frac, aspect)         // 기존 그대로(클램프 포함)
  if W가 직전까지와 동일(x,y,w,h) → LPD 스킵, continue   // 클램프 중복창 예산 절약(k는 계속 증가)
  crop → LPD → pickNearestPlate(prior = toCropPoint(anchor, W))
  검출 → 즉시 반환 { found:true, lpdOrig: backmapQuad(pick.quad, W), tier:'crop', step:k, cropWindow:W }
loop 소진(30회) → { found:false, reason:'no_plate', step:maxSteps } → 실패 확정, 잡은 다음 슬롯 진행(기존 흐름)
```

- **첫 검지 즉시 반환·역계산 기존 유지.** `backmapQuad`는 `orig = W.xy + q·W.wh` — 창의 offset/size만 사용하므로 창 중심이 어디로 이동했든(오프셋·클램프 무관) **정확 불변**. 기존 T-1 왕복 파리티 테스트가 이 불변을 이미 봉인하며, 오프셋 창에 대한 케이스만 추가한다.
- `pickNearestPlate` prior = `toCropPoint(anchor, W)` 기존식 유지 — 오프셋 창에서 앵커가 크롭좌표 [0,1] 밖일 수 있으나 toCropPoint는 클램프하지 않으므로(기존 규약) 최근접 판정은 그대로 유효.
- 중복창 스킵: 프레임 모서리 슬롯에서 클램프로 동일 창이 반복될 때 LPD 호출만 아낀다(결정형 3줄 가드 — `${x},${y},${w},${h}` 키 Set). k(step) 소비는 그대로 진행해 상태전이 단순 유지.

### 3-3. 예산 상한

- `maxSteps` 기본값 **5 → 30** (마스터 loop 상수 요건 — 30회 소진 시 실패 확정 후 다음 슬롯). Tier0 포함 슬롯당 최악 LPD 호출 31회 — 미검지 슬롯의 소요시간 증가는 수용(잡은 백그라운드·순차, 기존 구조 그대로). `minFrac` 기본 0.05 **무변경**(b안 채택으로 전 레벨 통과).

---

## 4. 변경 파일·시그니처 (최소안)

| 파일 | 변경 | 시그니처 |
|---|---|---|
| `src/calibrate/cropZoom.ts` | 신규 순수함수 1개 **추가만** | `export function gridCenter(anchor: NormalizedPoint, frac: number, aspect: number, off: {dx:number; dy:number}): NormalizedPoint` — `{ x: anchor.x + off.dx·min(1,frac), y: anchor.y + off.dy·min(1,frac·aspect) }`. 기존 4함수 무변경 |
| `src/calibrate/plateDiscovery.ts` | Tier1 루프 교체(§3-2), `GRID_OFFSETS` 모듈 상수(6방), `maxSteps` 기본 30, 중복창 가드 | `discoverSlot` 시그니처 불변 |
| `src/calibrate/plateDiscoveryWriter.ts` | 신규 순수함수 `lowerFrontAnchor`(export) + `expandDiscoveryTargets` 앵커 산출 1줄 교체, 모듈 상수 `PLATE_H=0.4`/`H_CONST=1.5` | §2-2 |
| `src/calibrate/types.ts` | **코드 무변경** — `PlateDiscoveryItem.step` 주석만 `crop=1..maxSteps(격자 인덱스)`로 갱신 | — |
| `PlateDiscoveryJob.ts` / `discoverRoutes.ts` / DB / config | **무변경** | — |

## 5. PlateDiscoveryOpts 확장

**신규 필드 추가 없음**이 기본안. 기존 `frac0/shrink/minFrac/maxSteps`가 격자 줌축을 그대로 표현하고, 오프셋 6방·`PLATE_H`는 단일용도 상수라 모듈 const로 고정(설정 가능성 발명 금지 — CLAUDE.md §2). config 스키마 확장 없음. 기본값만 `maxSteps: 5 → 30`으로 변경(주석에 "= 격자 30칸(5줌×6방)" 명기). `minFrac` 기본 0.05 무변경.

## 6. 검증 계획

### 6-1. vitest (qa-tester)

| ID | 파일 | 항목 |
|---|---|---|
| V-1 | cropZoom.test.ts | `gridCenter`: off(0,0)→앵커 그대로 / dy=0.5→y가 창높이 절반만큼 증가 / frac·aspect>1 클램프 시 min(1,·) 반영 |
| V-2 | cropZoom.test.ts | **오프셋·클램프 창 왕복 파리티**: gridCenter→computeCropWindow로 만든 창(모서리 클램프 케이스 포함)에서 `backmapQuad ∘ toCropPoint == id` 오차 < 1e-9 (역계산 오차 0 요건) |
| V-3 | plateDiscovery.test.ts | 격자 순서: k=1..6 창 중심이 GRID_OFFSETS 순서(중심→하→하좌→하우→좌→우), k=7에서 frac이 shrink 1회 축소 확인(스텁 crop이 받은 W 기록 검증 — 기존 테스트 패턴). k=25..30(level5) frac≈0.05184 ≥ minFrac로 실행됨 확인 |
| V-4 | plateDiscovery.test.ts | **30회 캡**: 전 스텝 미검출 시 crop 호출 ≤ 30회, `step=30`, `reason:'no_plate'`(실패 확정) |
| V-5 | plateDiscovery.test.ts | 하향 오프셋 창에서만 검출되는 스텁(예: k=2 창에만 번호판) → `found:true, step=2`, `lpdOrig`가 backmap 기대값과 일치 |
| V-6 | plateDiscovery.test.ts | 중복창 스킵: 앵커가 프레임 모서리라 클램프 동일창 반복 → LPD 호출 수 < 30 확인 |
| V-7 | plateDiscoveryWriter.test | `lowerFrontAnchor`: 합성 사다리꼴 roi + frontCenter → 결과 y가 frontCenter.y보다 크고(아래) 바닥 edge 중점 y보다 작음, t=0.5333 보간값 수치 일치. roi 퇴화 → frontCenter 폴백 |
| V-8 | plateDiscoveryWriter.test | (파리티) 합성 GroundModel로 `projectPointAtHeight(B_ground, 0.4)` 직접 재투영 결과와 `lowerFrontAnchor` 결과 오차 < 1e-6 — §2-1 항등 주장 수치 봉인 |
| V-9 | 기존 전체 | Tier0/no_anchor/전파 규약 기존 테스트 회귀 통과(maxSteps 기본 변경 반영 수정 포함 — 기존 "crop 5회" 테스트는 30으로 갱신) |

### 6-2. 리더 경험적 검증 (goal/loop)

- 시뮬 기동 → `POST /discover/ptz` → `/discover/status`·`/discover/result`로 **프리셋 주차면 found 수 확인(목표 100% = 6/6, 최소 기존 2 초과)**.
- `/discover/frame` + `plate_discovery.json`의 `cropWindow`·`step`으로 검지 슬롯별 격자 위치 관찰(하향/측방 오프셋에서 잡히는지 — 원인 가설 실증). sharp로 cropWindow 렌더 오버레이 스샷 대조.
- 100% 미달 시 재분석 노브(우선순위): `PLATE_H`(0.3~0.5) → GRID_OFFSETS 배수/방향(0.5배·좌우/대각 조정) → frac0/shrink → minFrac(최후 — a안 방향 초미세 크롭 전환 시에만).

## 7. 영향도 초안

- **`slot3d_front_center` 타 소비자 불변**: DB 값·Finalizer 산출식 무변경. 하향은 `expandDiscoveryTargets` 내부에서만 — 센터라이징(`expandPlateTargetsFromSlotSetup`)·뷰어 오버레이는 여전히 원값 사용. (documenter가 grep으로 소비처 전수 재확인.)
- **`plate_discovery.json`**: `step` 값 범위 1..30으로 확대(스키마 동일, 의미 = 격자 인덱스). 소비자는 감사용뿐 — 파급 없음.
- **slot_setup 쓰기 경로 불변**: `upsertSlotLpd` 부분 UPDATE 그대로([PlateDiscoveryJob.ts:204]), stringify5 그대로 — wipe fragility·소수점 규약 준수.
- **실행시간**: 미검지 슬롯당 LPD 최대 31회(기존 6회) — 시뮬 6슬롯 기준 수용 범위. 잡 상태머신·409 규약 불변.
- **§3 정책 준수**: LPD only(VPD 미접촉), 오버레이 로직 미접촉, config 스키마 무확장.
- **H_CONST 중복 상수**: Finalizer(1.5)와 plateDiscoveryWriter(1.5) 두 곳 — 값 변경 시 동기 필요. 주석 상호참조로 봉인(공용화는 과설계로 배제, 필요 시 후속).

## 8. 미해결/가정

- `PLATE_H = 0.4` 는 초기값(시뮬 차량 번호판 실높이 미실측) — goal/loop 검증에서 미달 시 1순위 튜닝 노브.
- 광학 PTZ tier는 범위 밖(기존 `needs_optical` 예약 그대로).

---

## 9. 배타성 게이트 — 옆판 절도(위장 found) 차단 (라이브 발견 `05_live_finding.md` 대응)

### 9-0. 문제 재확인 (사실)

cam1:preset2 라이브: `found:6/6` 위장 — 고유 번호판 3개(0.212/0.463/0.766)를 6슬롯이 중복 점유(실검지 3/6).
원인: `matchRadiusNorm=0.15` ≥ 인접 하향앵커 간격(~0.11~0.13) → slot8/10/12가 자기 판 미검출 시
**Tier0에서 이웃 판을 반경 내로 채택 → found 위장 → 격자 줌 루프(§3)가 아예 안 돎.**
(리더 진단: full-frame LPD 1개뿐, slot9 frac0.20 크롭은 2개 검출 — 줌은 유효하나 절도가 줌을 막음.)

### 9-1. 원칙 (Voronoi 소유권)

검출 번호판은 **"검출 중심에 대해 동일 프리셋 전체 슬롯 하향앵커 중 자기 앵커가 최근접일 때만"** 자기 것으로 채택.
이웃 앵커가 더 가까우면(동률 포함) **기각 → 그 tier/step는 미검출로 간주 → 다음 격자 스텝 계속**.
이것이 마스터 격자 루프(줌·사방·30회)가 실제로 돌게 하는 enabler다. 앵커는 이미 하향된 값(§2)이라
검출 중심(번호판 높이)과 같은 높이대 — Voronoi 비교 공간이 정합적이다.

### 9-2. 주입 경로 (결정: 시그니처 확장 — 최소침습)

| | (i) discoverSlot 3번째 인자 — **추천** | (ii) PlateDiscovery per-run 상태 주입 |
|---|---|---|
| 방식 | `discoverSlot(t, presetPtz?, peerAnchors: NormalizedPoint[] = [])` | 인스턴스에 프리셋별 앵커맵 setter/생성자 주입 |
| 무상태 규약 | 유지(클래스 주석 "무상태 — 호출마다 독립" 그대로) | **위반** — 잡이 프리셋 혼합 순회 시 상태 갱신 관리 필요 |
| 파급 | 옵셔널 기본 `[]` = 기존 동작(하위호환). `PlateDiscoveryApi = Pick<…,'discoverSlot'>` 타입 자동 추종 | 생성자/팩토리 시그니처 변경 — Job·테스트 시임 전부 수정 |

**(i) 채택.** `PlateDiscoveryJob.run` 이 모든 targets를 보유하므로, run 진입 시 1회
`Map<presetKey(`${camIdx}:${presetIdx}`), DiscoveryTarget[]>` 그룹핑 → 슬롯 처리 시
`peerAnchors = 같은 프리셋 targets 중 자기(slotId) 제외 · anchor != null 인 앵커들`을 전달.
types.ts 변경 0(NormalizedPoint 기존 import), 라우트·writer·cropZoom 불변.

### 9-3. 적용 지점·후보 선택 (양쪽 tier, plates 전체에서 자기소유 최근접)

신규 순수함수(`plateDiscovery.ts` 내 export — controlMath는 platePtz·detectPipeline 공유라 미접촉):

```ts
/** plates 중 Voronoi 자기소유(∀peer: d(c,self) < d(c,peer))만 남기고 자기 앵커 최근접 1개. 없으면 null.
 *  center 는 원본 프레임 정규화 좌표로 비교(동률 → 기각: 결정적·중복청구 불가). */
export function pickOwnedPlate(
  candidates: Array<{ plate: PlateBox; centerOrig: NormalizedPoint }>,
  selfAnchor: NormalizedPoint,
  peerAnchors: readonly NormalizedPoint[],
): PlateBox | null
```

- **단일 후보 사후검사가 아니라 필터-후-최근접** (권장안 채택): 크롭 창 안에 자기판+이웃판 공존 시,
  `pickNearestPlate` 단독은 자기판 미검출 프레임에서 이웃판을 뽑는다 — 소유권 필터를 먼저 걸어야 한다.
- **비교 좌표계 = 항상 원본 프레임 정규화.** 크롭 좌표는 w/h 비등방 스케일이라 거리 비교가 왜곡됨.
  - Tier0: 후보 center = `centerOf(p)` 그대로(원본 좌표).
  - crop tier: 후보 center = 크롭 정규화 중심을 `W.xy + c·W.wh` 아핀으로 원본 환산(= backmapQuad와 동일식,
    점 1개 버전 — 기존 아핀 재사용, 신규 수학 0).
- **Tier0**: `pickOwnedPlate` 통과 후보에 기존 `matchRadiusNorm` 게이트 **병행 유지**(소유권이 절도를 막고,
  반경이 터무니없이 먼 단독 검출을 막음 — 둘 다 통과 시만 full 채택). 불통과 → 격자 진입(기존 흐름).
- **crop tier(각 격자 스텝)**: `pickNearestPlate` 호출을 `pickOwnedPlate`로 교체. 불통과 → 다음 스텝.
- 채택 시 반환·역계산(backmapQuad)·step/cropWindow 기록 **기존 그대로**(§3 불변).

### 9-4. 매칭 방식 비교 — (a) per-slot Voronoi 채택

| | (a) per-slot Voronoi 게이트 — **추천** | (b) 전역 최대매칭(finalize 재사용) |
|---|---|---|
| 재사용 | 신규 순수함수 1개 | `assignClustersToSpaces`([spaceAssign.ts:43], Kuhn) 존재 확인(grep) — 단 단일 프레임 전제 |
| 구조 적합성 | 슬롯 독립·프레임별 — 순차 루프·"첫 검지 즉시 반환" 불변 | discovery는 **슬롯마다 다른 프레임·다른 크롭 스텝** — 교차프레임 검출 수집 후 일괄 매칭으로 잡 구조 재설계 필요(즉시 반환 폐기) |
| 한계 | 서로 다른 프레임 간 좌표 지터로 Voronoi 경계 근처 판정이 이론상 흔들릴 수 있음(드묾 — 30회 정직 실패가 흡수) | 정확하나 최소침습 위반 |

(b)는 후속 대안으로만 기록 — finalize 쪽 헬퍼는 존재하나 discovery의 슬롯별-프레임 구조와 맞지 않아 이번 범위에서 재사용하지 않는다.

### 9-5. 경계 규약

- 두 앵커 근접 시 한 슬롯이 이기면 진 슬롯은 자기 판을 격자 줌으로 찾는다(정상 — 이것이 목적).
- 동률(정확히 같은 거리) → 기각(어느 쪽도 청구 불가·결정적). float 공간에서 사실상 미발동.
- 30회 소진 → `no_plate` **정직 실패 유지**(마스터 "그래도 안되면 실패" 부합). 위장 found 재발 불가.
- `peerAnchors = []`(프리셋에 슬롯 1개뿐/필터 단독 실행) → 소유권 필터 자동 무조건 통과 = 기존 동작.

### 9-6. 2차 레버 (설계만 — 구현 보류, 배타성 라이브 실측 후)

우선순위·트리거(§6-2 노브 체계의 상위에 위치):
1. **줌레벨 간 재캡처(신선 프레임)**: 트리거 = 배타성 적용 후에도 특정 슬롯이 30회 소진으로 실패하고, 리더 sharp 진단상 해당 프레임에 자기 판이 아예 안 맺힘(같은 프레임 재크롭은 결정적이라 반복 무익). 방식 = level 전환 시점(k=7,13,19,25)에 `requestImage` 재캡처 — discoverSlot 내부 국한, 마스터 "박스 존재할 때까지 반복" 부합.
2. **줌레벨 미세화**: 진단상 frac 0.20 검출·0.12 미검출(줌 민감) — shrink 0.6→0.7 등으로 레벨 간격 축소(30 예산 내 레벨 수 재배분).

### 9-7. 검증 추가 (§6 증분)

| ID | 파일 | 항목 |
|---|---|---|
| V-10 | plateDiscovery.test.ts | `pickOwnedPlate` 순수: 이웃 앵커 최근접 후보 기각 / 자기소유 후보 채택 / 자기소유 다수 중 최근접 / 동률 기각 / peers=[] 무조건 통과 |
| V-11 | plateDiscovery.test.ts | **절도 재현 회귀**(05_live_finding slot8 시나리오): Tier0에 이웃 판만(자기 앵커 반경 0.15 이내) → full 기각·격자 진입, 이후 스텝 크롭에서 자기 판 검출 → found·step≥1·backmap 정확 |
| V-12 | plateDiscovery.test.ts | 크롭 창에 자기판+이웃판 공존 → 자기판 채택(원본좌표 환산 후 소유권 판정 확인) |
| V-13 | plateDiscoveryJob.test | run의 프리셋별 peer 그룹핑: 2개 프리셋 혼합 targets → 각 discoverSlot 호출이 자기 프리셋·자기 제외 앵커만 수신(스텁 기록 검증) |
| V-14 | 기존 회귀 | discoverSlot 스텁/시임(`PlateDiscoveryApi`) 3번째 인자 추가에 따른 기존 테스트 통과(옵셔널이라 무수정 통과 기대) |

라이브(리더): 동일 cam1:preset2 재실행 → `/discover/result` bbox 중심 **6개 전부 상이**(중복 점유 0) + found 6/6 목표. 미달 시 §9-6 레버 순서로 재분석.

### 9-8. 영향도 증분

- 변경 국소성: `plateDiscovery.ts`(pickOwnedPlate + 양 tier 게이트) + `PlateDiscoveryJob.ts`(run 그룹핑·전달) **2파일**. cropZoom·writer·routes·types·DB 불변. `pickNearestPlate`(controlMath)는 무수정 — platePtz·detectPipeline 소비자 영향 0.
- `discoverSlot` 시그니처 옵셔널 확장 — 하위호환(기존 호출부는 Job뿐).
- 미검지 슬롯의 절도-위장이 사라지므로 found 수치가 일시적으로 **정직하게 하락**할 수 있음(3/6 등) — 이는 회귀가 아니라 §9-0 위장의 교정임을 문서화(documenter)에 명기.
