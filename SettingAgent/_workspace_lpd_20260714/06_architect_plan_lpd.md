# 06. 설계(2차 증분) — LPD 번호판도 주차면 위 차량 것만 (1차 §2 결정 번복)

**전제**: 1차(`01_architect_plan.md`) §2 는 "**번호판(LPD)은 필터하지 않는다**"로 확정했고, 리더 실측(`05_leader_empirical.md` §9.3)이 그 동작을 실증했다(DB plate 7/7/13 = 미필터).
**이번 요구**: 마스터 — "주차면위에 vpd가 존재하면 lpd도 검출해야됨". 즉 **모드 A(체크박스 ON)에서 번호판도 필터한다.** → 1차 §2 를 **번복**한다.
**증상**: preset3 라이브 검출에서 VPD 박스는 주차면 위 차량만 남는데 뒷줄(주차면 밖) 차량들의 **노란 번호판 quad 가 그대로 표시**된다(= `DetectResult.plates` 미필터).

---

## 1. 확정 규칙과 그 근거

```
keepPlate(p)  =  (A) 유지된 VPD 차량 중 하나에 귀속        OR   (B) 번호판 중심 ∈ 주차면 폴리곤
                  ── matchPlatesToSlots 재사용 ──              ── pointInPolygon 재사용 ──
```

### (A) 귀속 항 — 기존 `matchPlatesToSlots` **그대로** 재사용 (신규 매칭 0줄)

`src/setup/plateMatch.ts:14 matchPlatesToSlots(slots, plates)` 는 이미 정확히 이 규칙이다:
> 번호판 중심(`quadBoundingRect` → `center`)이 차량 `roi` 내부 → 후보, 그중 **겹침 최대** 차량에 귀속, **차량당 번호판 1개**.

`detectPipeline.runDetect:245` 는 **이미 필터된 `vehicles`** 로 이 함수를 호출한다 → `matched: Map<vehicleIdx, quad>` 의 **값 집합이 곧 "유지된 차량에 귀속된 번호판"** 이다. 새로 짤 것이 없다.

**⚠️ 거대 병합 박스(리더 실측 V-1) 봉쇄 근거**
VPD 가 가끔 `conf 0.39`, `(77,0)-(1380,716)` 짜리 **프레임 절반 크기 병합 박스**를 뱉는다(preset3 #14). 만약 귀속을 *"번호판 중심 ∈ 유지된 차량 rect"* 로 **직접** 판정하면 그 거대 박스가 **배경 번호판을 전부 빨아들인다**.
`matchPlatesToSlots` 는 **슬롯당 최대 1개**(`bestArea` 맵)로 제한하므로 **피해가 정확히 1건으로 봉쇄**된다. → **이 성질이 (A)를 자체 구현하지 않는 결정적 이유다.** 구현자는 자체 귀속 로직을 짜지 말 것.

### (B) 주차면 보정 항 — **없으면 점유가 뒤집힌다** (OR 의 존재 이유)

1차 §2 가 LPD 를 필터하지 않기로 한 유일한 기술적 근거는 **점유 판정이 번호판 중심 기반**이라는 것이었다. 코드로 확인했다 — 소비처는 **두 곳, 둘 다 같은 입력**이다:

| 소비처 | 코드 |
|---|---|
| `web/app.js:338-340` `updateLogicOccupancy` | `plates = [...detect.plates, ...detect.vehicles.map(v=>v.plate)]` → `computeOccupancy(파일바닥ROI, plates)` |
| `web/core.js:581-586` `buildFlatSlotRows`/`buildGlobalPlaces` | **동일한 union** → `computeOccupancy(spaces, plates)` |

`core.js:454 computeOccupancy` = **번호판 중심이 그 폴리곤 안이면 occupied=true**.

> **엄격 귀속(A)만** 쓰면: VPD 가 주차차를 놓친 프레임(박스 미검출) → 그 차의 번호판이 어떤 kept 차량에도 귀속되지 않음 → 필터에서 **삭제** → `computeOccupancy` 가 그 주차면을 **`occupied:false` 로 뒤집는다**. (B)가 이 회귀를 막는다.

### ★ (B)가 만드는 **증명 가능한 무회귀 성질** (이번 설계의 핵심 논거)

`computeOccupancy` 가 참조하는 폴리곤 집합 = `placeRoi[key].points` = **우리가 필터에 쓰는 바로 그 `parking_spaces` 폴리곤**이다(`buildGlobalPlaces:585`, `updateLogicOccupancy:335`).

- 어떤 번호판이 **occupied=true 를 만들 수 있음** ⟺ 그 중심이 **어떤 폴리곤 안**에 있음.
- (B)는 **중심이 폴리곤 안인 번호판을 전부 유지**한다.
- ∴ **필터가 제거하는 번호판은 점유를 참으로 만들 수 없는 것뿐이다.**

> **`computeOccupancy` 결과는 필터 전후 동일하다(불변).** — 점유 회귀 0. (단 §7-1 중심 정의 ε 예외)

### (B)의 중심 정의 — **새 정의를 만들지 않는다**

`quadBoundingRect(quad)` → `center(rect)` (둘 다 `src/domain/geometry.ts`) = **`matchPlatesToSlots` 와 완전 동일한 정의**. 판정은 `src/domain/polygon.ts:95 pointInPolygon`.
`web/core.js:434 quadCentroid`(4점 산술평균)와는 **별개 정의가 이미 존재**한다(레거시). **제3의 정의를 추가하지 않는다.** 두 정의의 차이는 §7-1 에 한계로 명시.

---

## 2. Aggregator 파급 분석 (질문 6) — **결론: 회귀 없음**

`src/capture/Aggregator.ts:254-317` 을 코드로 따라갔다.

```
aggregate():
  plates = presetDets.filter(kind==='plate')          // DB 에서 온 것
  pClusters = clusterDetections(plates)
  plateReps = pClusters.map(robustRect)
  for (vehicle 클러스터 c):                            // ← 모드A 에선 전부 "주차면 위" 차량
     hit = plateReps 중  center(pr) ∈ rep(c)  &&  겹침 최대   // 279-289
  → plate 클러스터는 **vehicle 클러스터에 매칭될 때만** 결과에 노출된다.
```

필터가 제거하는 번호판을 3분류하면:

| 제거되는 번호판 | 오늘(미필터) aggregate 에서의 운명 | 필터 후 |
|---|---|---|
| 어떤 kept 차량 rect 밖 + 폴리곤 밖 (예: 뒷줄 통행차 번호판) | **어떤 vehicle 클러스터에도 매칭 안 됨 → 버려짐** | 상류에서 제거 — **동일** |
| kept 차량 rect 안이지만 **차량당 1개 경쟁에서 탈락**(겹침 작은 쪽) | aggregate 도 **max-overlap** 로 큰 쪽을 고름 → 탈락자는 **버려짐** | 상류에서 제거 — **동일**(선택되는 번호판이 같다) |
| 폴리곤 안 (VPD 미검출 주차차 번호판) | vehicle 클러스터 없음 → 버려짐 | **(B)로 유지** → aggregate 에선 여전히 미매칭·버려짐 = **동일**, 그러나 `computeOccupancy`(프론트)에는 **살아남는다** ← 이게 목적 |

**핵심**: `matchPlatesToSlots`(상류, 프레임 단위)와 `Aggregator`(하류, 클러스터 대표 단위)는 **같은 규칙**(중심 포함 + 겹침 최대 + 대상당 1개)이다. 상류가 버리는 것은 하류도 버렸을 것들이다.
→ **`aggregate()` 산출(`AggregatedSlot.plateX/Y/W/H/plateQuad`, `Finalizer` → `parking_slots.lpdJson`)은 불변.** `Aggregator.ts` / `Finalizer.ts` **무변경**.

**부수 효과(개선 방향)**: 모드A 에서 DB `plate` 행이 줄어 → `pClusters` 수 감소 → 그리디 클러스터링의 오염(통행차 번호판이 근처 클러스터에 흡수) 가능성이 **줄어든다**. 손실이 아니라 잡음 감소다.

---

## 3. 신규 함수 — `src/capture/onPlaceFilter.ts` 에 **1개만** 추가

```ts
import type { PlateBox } from '../clients/LpdClient.js';
import { matchPlatesToSlots } from '../setup/plateMatch.js';
import { pointInPolygon } from '../domain/polygon.js';
import { center, quadBoundingRect } from '../domain/geometry.js';

/**
 * 모드A 번호판 필터. keepPlate = (유지된 차량에 귀속) OR (번호판 중심 ∈ 주차면 폴리곤).
 * - 귀속: matchPlatesToSlots 재사용(차량당 1개 → 거대 병합 박스가 배경 번호판을 전부 빨아들이는 것을 봉쇄).
 * - 보정: VPD 가 놓친 주차차의 번호판을 살려 computeOccupancy(번호판 중심 기반 점유)의 뒤집힘을 막는다.
 * - 중심 정의는 matchPlatesToSlots 와 동일(quadBoundingRect → center) — 새 centroid 정의 금지.
 * polys 부재 → **강등**: 전량 통과 + degraded=true (filterVehiclesOnPlace 와 동일 정책, 드롭 금지).
 */
export function filterPlatesOnPlace(
  plates: PlateBox[],
  keptVehicles: readonly { rect: NormalizedRect; confidence: number }[],
  polys: readonly (readonly NormalizedPoint[])[] | null | undefined,
): { kept: PlateBox[]; filteredOut: number; degraded: boolean } {
  if (!polys || polys.length === 0) return { kept: [...plates], filteredOut: 0, degraded: true };
  // 귀속 집합: matchPlatesToSlots 는 plate.quad **참조**를 그대로 담는다(detectPipeline:258 이 이미 의존하는 성질).
  const attached = new Set(
    matchPlatesToSlots(
      keptVehicles.map((v, i) => ({ positionIdx: i, roi: v.rect, confidence: v.confidence })),
      plates,
    ).values(),
  );
  const kept = plates.filter((p) => {
    if (attached.has(p.quad)) return true;                       // (A)
    const c = center(quadBoundingRect(p.quad));                  // (B) — matchPlatesToSlots 와 동일 정의
    return polys.some((poly) => pointInPolygon(poly, { x: c.cx, y: c.cy }));
  });
  return { kept, filteredOut: plates.length - kept.length, degraded: false };
}
```

**제네릭 쓰지 않는다**: 두 호출측(`detectPipeline.platesBase`, `CaptureJob` LPD 응답)이 **모두 `PlateBox[]`** 다. `matchPlatesToSlots(slots, plates: PlateBox[])` 시그니처와 그대로 맞는다 → `plateMatch.ts` **무변경**.
**BuiltSlot 어댑터(`positionIdx/roi/confidence`)를 이 함수 안에 둔다** → 어댑터가 두 곳에 복제되지 않는다(`CaptureJob` 은 `matchPlatesToSlots` 를 몰라도 된다).

### 감수하는 트레이드오프 (구현자는 "최적화"하지 말 것)
`runDetect` 는 `matchPlatesToSlots` 를 **두 번** 호출하게 된다(자기 것 1회 + 필터 내부 1회, 동일 입력·동일 결과). 순수 함수 O(n·m), n,m ≤ ~20 → **무시 가능**. `matched` 맵을 인자로 넘기는 대안은 `CaptureJob` 에 BuiltSlot 어댑터를 복제해야 해서 **더 나쁘다**. 그대로 둔다.

---

## 4. 파일별 변경 계획

### 4.1 `src/capture/onPlaceFilter.ts` — `filterPlatesOnPlace` 추가(~20줄)
§3. 기존 `filterVehiclesOnPlace`/`isVehicleOnPlace`/`groundBand` **무변경**.
→ **검증**: `test/onPlaceFilter.test.ts` P1~P7(§6) 통과.

### 4.2 `src/capture/detectPipeline.ts`

| 위치 | 변경 |
|---|---|
| `:61` `DetectResult.plates` 주석 | "모드A 에서도 필터하지 않는다" → **삭제**하고 새 규칙 기술(주석이 곧 계약이다) |
| `:62-73` `summary` | `lpdFilteredOut: number;` 추가. **`lpdCount` 의미 불변 = 필터 전 원 검출 수**(vpdCount 선례). 불변식 `plates.length === lpdCount − lpdFilteredOut` |
| `:245` `matched` | **무변경**(이미 필터된 `vehicles` 로 호출 중) |
| `:245` 직후 | `let plates = platesBase; let lpdFilteredOut = 0;`<br>`if (onPlaceOnly) { const rp = filterPlatesOnPlace(platesBase, vehicles, onPlace!.polys); plates = rp.kept; lpdFilteredOut = rp.filteredOut; }` |
| `:258` conf 조회 | `platesBase.find(p => p.quad === baseQuad)` — **`platesBase`(원본) 유지**(matched 의 출처와 일치. 바꾸면 조용히 `?? 1` 로 폴백된다) |
| `:288` 반환 `plates` | `platesBase.map(...)` → **`plates.map(...)`**(필터된 것) ← **마스터 스크린샷의 노란 박스가 여기서 사라진다** |
| `:289-296` summary | `lpdCount: platesBase.length`(불변) + `lpdFilteredOut` |

**게이트는 `onPlaceOnly`(= 실제 적용된 모드)** 를 쓴다 — `onPlace.onlyOnPlace`(요청)가 아니다. 강등(폴리곤 부재) 시 차량과 **같은 이유로** 번호판도 필터하지 않는다. 강등 사유·warn 은 차량 필터가 이미 낸다 → **번호판용 별도 강등 필드·로그 없음**(중복 금지).

**`vehicles[].plate` 는 건드릴 필요가 없다(질문 3 답)**:
- 귀속분: `matched` 가 **이미 필터된 vehicles** 로 산출 → 정의상 kept 차량 것뿐 + `filterPlatesOnPlace` 의 (A) 항이 **같은 함수·같은 입력**이므로 `vehicles[].plate ⊆ plates`(base 매칭분) 가 **구조적으로 보장**된다.
- 복원분(`recovered`): zoom 뷰에서 새로 얻은 quad라 `platesBase` 에 **원래 없다**. 소유 차량이 kept(주차면 위)이므로 정합. `plates` 배열과 무관.
→ **회귀 0. 변경 없음.**

→ **검증**: `test/detectPipeline.test.ts` D1~D5(§6) 통과.

### 4.3 `src/capture/CaptureJob.ts`

| 위치 | 변경 |
|---|---|
| 필드(:99 인근) | `private lpdFilteredOut = 0;` |
| `start()`(:174 인근) | `this.lpdFilteredOut = 0;` (카운터 초기화 — `vpdFilteredOut` 옆) |
| `getStatus()`(:161 인근) | `...(this.lpdFilteredOut > 0 ? { lpdFilteredOut: this.lpdFilteredOut } : {})` (조건부 스프레드 패턴 동일) |
| `applyOnPlaceFilter`(:341) | 폴리곤 조회 2줄을 `private async presetPlace(t): Promise<{ place: NormalizedPlaceRoi \| null; polys: NormalizedPoint[][] \| null }>` 로 추출해 **두 필터가 공유**(강등 사유 문자열은 `place` 유무로 계속 구분). `placePromise` 는 캐시된 Promise 라 파일 I/O 재발생 없음 |
| `captureTarget()`(:321-332) | LPD 블록: `const rawPlates = await this.deps.lpd.detect(cap.jpg);`<br>`const plates = this.vpdOnParkingOnly ? await this.applyPlateFilter(rawPlates, vehicles, t) : rawPlates;`<br>이후 `for (const p of plates)` — **`insertDetections` 의 `kind:'plate'` 가 여기서 필터된다** |
| 신규 private | `applyPlateFilter(plates, keptVehicles, t)`: `presetPlace(t)` → `filterPlatesOnPlace` → `this.lpdFilteredOut += filteredOut` → `kept` 반환. **강등 시 `filteredOut===0`** 이라 별도 분기 불요(차량 필터가 이미 warn·`onPlaceDegraded` 기록) |

`vehicles` 는 이미 필터된 `VehicleBox[]`(`rect`+`confidence` 보유) → 그대로 `keptVehicles` 로 전달.
→ **검증**: `test/captureJobOnPlace.test.ts` C1~C3(§6) 통과 + 기존 `captureJob*.test.ts` 무변경 통과.

### 4.4 `src/capture/types.ts` — `CaptureStatus`(:148 뒤)
```ts
  /** 주차면 필터로 제외된 번호판 누적 수(run 누적). 강등/모드B 시 미노출. */
  lpdFilteredOut?: number;
```
강등 사유는 `vpdOnPlaceDegraded` **하나로 공유**(폴리곤 소스가 같다 → 사유도 같다). 필드 추가 금지.

### 4.5 `src/api/captureRoutes.ts` — **무변경**
`/capture/detect` 는 이미 `polys` + `onlyOnPlace` 를 넘긴다. `/capture/start` 도 이미 `vpdOnParkingOnly` 를 넘긴다. **zod·핸들러 변경 0.**

### 4.6 `src/index.ts` — **무변경** (`placeRoiFile` 이미 주입됨)

### 4.7 `web/core.js` — **무변경** (제약 준수)
서버가 필터된 `plates` 를 준다. `computeOccupancy` 는 §1 의 무회귀 성질로 **결과 불변**. 이중구현 0.

### 4.8 `web/app.js` — 관측값 노출(C1, 질문 5)

| 위치 | 변경 |
|---|---|
| `:576-578` `runLiveDetect` cap-msg | ``검출 ${s.vpdCount - s.filteredOut}/${s.vpdCount}대 · 번호판 ${s.lpdCount - s.lpdFilteredOut}/${s.lpdCount} · 주차면필터 ${s.onPlaceOnly ? 'ON' : 'OFF'}`` + 기존 강등 접미사 |
| `:1442` `renderCaptureStatus` 배지 | ``주차면필터 ON(차량 제외 ${status.vpdFilteredOut ?? 0}대 · 번호판 제외 ${status.lpdFilteredOut ?? 0})`` — 기존 falsy 가드 유지(0 이면 괄호 생략) |

### 4.9 `web/index.html`(:166 인근) — 라벨 문구 (리더 확인 요청, §8-Q1)
`주차면 위 차량만 검출` → **`주차면 위 차량만 검출(번호판 포함)`**. **id `cap-vpd-onplace` 는 유지**(배선·테스트가 id 로 봉인돼 있다). 라벨이 이제 동작을 덜 설명한다 → 갱신 권고. 문구는 리더/마스터 확정 사항.

---

## 5. 깨질 기존 테스트 + 조치 (질문 7)

| 파일:줄 | 현상 | 조치 |
|---|---|---|
| **★ `test/captureJobOnPlace.test.ts:210-226`**<br>`§6-11 — LPD(번호판)는 필터 대상이 아니다`<br>`'모드A/모드B 모두 plate 검출 건수 불변(2건)'` | **이 단언은 이제 틀렸다.** 1차 §2 결정을 봉인한 테스트다. 모드A 에서 통로 번호판 `quad(0.45,0.97)`(kept 차량 밖 + 폴리곤 밖)이 **드롭**된다 → `modeA.plates` = **1**. | **describe 전체 재작성** → `§6-11′ LPD 도 주차면 위 차량 것만`. 모드A: plates **1**(주차차 것) + `status.lpdFilteredOut === 1`. 모드B: plates **2** + `lpdFilteredOut` **undefined**. |
| `test/detectPipeline.test.ts:119` | `expect(out.summary).toEqual({vpdCount:1, lpdCount:1, recovered:0, onPlaceOnly:false, filteredOut:0})` → `lpdFilteredOut` 가산으로 **실패** | 기대값에 `lpdFilteredOut: 0` 추가 |
| `test/detectPipeline.test.ts:306` | 동일(`§6-15b`) | 동일 |
| `test/detectPipeline.test.ts:236-238` | 주석 `// plates 는 필터하지 않는다(체크박스 대상은 '차량')` + `expect(out.plates).toHaveLength(1)` — **단언 자체는 계속 통과**(`PARKED_PLATE=plate(0.43,0.22)` 는 폴리곤 `BACK_ROW`(y 0.30~0.45) **밖**이지만 `PARKED` rect(y 0.18~0.44) **안** → **(A) 귀속 항으로 살아남는다**) | **주석만 수정** + `lpdFilteredOut: 0` 단언 추가. ⚠️ **이 케이스는 우연이 아니라 (A) 항의 실증**이다 — 폴리곤 밖 번호판이 kept 차량 소유라서 유지된다. 주석에 그 사실을 남긴다. |
| `test/captureRoutes.test.ts:503-510` | `body.summary` `toEqual` (강등 경로) → **실패** | `lpdFilteredOut: 0` 추가 |
| `test/captureRoutes.test.ts:615-617` | `§6-17` `body.summary` `toEqual({vpdCount:2, lpdCount:0, ...})` → **실패** | `lpdFilteredOut: 0` 추가 |
| `test/captureRoutes.test.ts:647-657` (★ 경계면 계약) | 통과하지만 **불완전** | `lpdFilteredOut` typeof number + 불변식 `plates.length === lpdCount − lpdFilteredOut` 추가(신규 필드가 프론트 계약에 들어왔다) |
| `test/captureRoutes.test.ts:663-673` (★ status 경계면) | 통과 | `lpdFilteredOut` 미노출(0) 단언 추가 |
| `test/aggregator*.test.ts`, `test/finalizer*.test.ts` | `Aggregator`/`Finalizer` **무변경** | 영향 없음 |
| 기존 `captureJob*.test.ts`(모드A 무관 4건) | `placeRoiFile` 미주입 → 강등 → 전량 통과 | **무변경 통과 예상** |

---

## 6. 유닛테스트 항목 제안 (qa-tester)

### `test/onPlaceFilter.test.ts` (증분 — 순수, 핵심)
- **P1 (A 항)**: 번호판 중심이 kept 차량 rect 안, **폴리곤 밖** → `kept`. (귀속 항이 없으면 죽는 케이스)
- **★ P2 (B 항 — OR 의 존재 이유)**: `keptVehicles=[]`(VPD 가 주차차를 **놓침**) + 번호판 중심 ∈ 폴리곤 → **`kept`**. → 이게 없으면 `computeOccupancy` 가 그 면을 `occupied:false` 로 뒤집는다. **테스트 이름에 그 이유를 쓴다.**
- **P3 (드롭 — 마스터 증상)**: 뒷줄 통행차 번호판(kept 차량 rect 밖 + 폴리곤 밖) → `drop`, `filteredOut=1`.
- **★ P4 (거대 병합 박스 봉쇄, 리더 V-1)**: `keptVehicles=[프레임 절반 rect(conf 0.39)]` + 폴리곤 **밖** 배경 번호판 **5개**(전부 그 rect 안) → **정확히 1개만** `kept`, 4개 `drop`. (`matchPlatesToSlots` 차량당 1개 규칙 봉인 — 자체 귀속으로 바꾸면 여기서 5개가 통과하며 즉시 깨진다.)
- **P5 (강등)**: `polys = null` / `[]` → `degraded=true`, `kept.length === plates.length`, `filteredOut=0`.
- **P6**: `keptVehicles=[]` + 폴리곤 밖 번호판 → `drop`(귀속 집합이 공집합일 때의 방어).
- **P7 (중심 정의)**: 기울어진 OBB quad 로 `quadBoundingRect+center` 판정임을 좌표로 단언(4점 평균과 값이 갈리는 비대칭 quad 사용).

### `test/detectPipeline.test.ts` (증분)
- **D1**: `§6-12` 갱신 — `PARKED_PLATE`(폴리곤 밖·kept 차량 안)가 모드A 에서 **유지**됨 + `lpdFilteredOut=0`.
- **D2 (신규·핵심)**: `PASSING` 차량 위 번호판을 LPD 스텁에 **추가** → 모드A: `plates` **1**건, `lpdCount=2`, `lpdFilteredOut=1`. 모드B(3인자): `plates` **2**건, `lpdFilteredOut=0`.
- **D3**: 불변식 `out.plates.length === summary.lpdCount − summary.lpdFilteredOut` (6케이스 전부).
- **D4**: `vehicles[0].plate` 는 모드A/B 동일(귀속 경로 회귀 0 — `§6-12b` 유지).
- **D5**: `recovered` 번호판(zoom 복원)은 `plates` 배열과 무관하게 `vehicles[].plate` 로 **유지**됨(모드A).
- **D6**: 강등(`polys:null` + `onlyOnPlace:true`) → `plates` 전량 통과 + `lpdFilteredOut=0`.

### `test/captureJobOnPlace.test.ts` (§6-11 재작성 + 신규)
- **C1**: 모드A → DB `plate` **1**건(주차차 것) / 모드B → **2**건. `status.lpdFilteredOut`: 1 / undefined.
- **★ C2 (점유 뒤집힘 방지, DB 끝단)**: VPD 스텁이 **`[]`**(주차차 미검출) + 폴리곤 **안** 번호판 1건 → 모드A 에서도 `plate` 행이 **적재된다**(vehicle 0건, plate 1건). ← OR (B) 항이 DB 경로에서도 작동함을 봉인.
- **C3 (강등)**: `placeRoiFile` 미주입 → `plate` **2건 전량** + `status.lpdFilteredOut` **미노출** + `vpdOnPlaceDegraded` 존재.
- 픽스처 규약 준수: **`test/fixtures/PtzCamRoi.unity.json`** 만. 런타임 `data/Place01/PtzCamRoi.json` 사용 금지(HANDOFF §2-2).

### `test/captureRoutes.test.ts` (증분)
- **R1**: `summary` `toEqual` 2건에 `lpdFilteredOut` 반영(§5).
- **R2 (★ 경계면 계약)**: `typeof s.lpdFilteredOut === 'number'` + `plates.length === lpdCount − lpdFilteredOut` + `status.lpdFilteredOut` 계약(app.js 소비 필드 봉인 — 필드명이 바뀌면 프론트가 조용히 `NaN` 을 표시한다).

### `test/aggregator*.test.ts` — **신규 불요**
`Aggregator` 무변경 + §2 에서 "상류가 버리는 것 = 하류도 버렸을 것"을 코드로 확인했다. 굳이 넣는다면 **회귀 봉인 1건**: 폴리곤 밖 번호판을 제거한 검출 집합과 제거하지 않은 집합의 `aggregate()` 결과에서 **accepted 슬롯의 `plateQuad` 가 동일**함을 단언(선택).

---

## 7. 한계 / 검증 불가 (은닉 금지)

1. **중심 정의 ε 불일치**: 서버 (B) 항 = `quadBoundingRect → center`, `web/core.js:434 quadCentroid` = **4점 산술평균**. 평행사변형/직사각형 OBB 에서는 **두 값이 정확히 일치**(중심대칭) → 실 LPD 응답에선 사실상 무해. **원근으로 심하게 비대칭인 quad** 에서만 미세 차이가 나고, 번호판 중심이 폴리곤 **경계로부터 그 ε 이내**일 때만 점유가 뒤집힐 수 있다. → §1 의 "무회귀"는 **이 ε 을 제외하고** 성립한다. 정의 통일(core.js 를 `quadBoundingRect` 기반으로)은 `web/core.js` 무변경 제약에 걸려 **이번 범위 밖**(후속 과제 **P-1** 로 등록 권고).
2. **차량당 1개 규칙의 이면**: 한 kept 차량 rect 안에 번호판이 **2개**(거대 병합 박스·박스 겹침)면 겹침 작은 쪽이 (A)에서 탈락한다. 그것이 실제 주차차 번호판이고 폴리곤 밖이면 **표시에서 사라진다**. 단 `Aggregator` 도 동일한 max-overlap 규칙이라 **집계·`parking_slots` 결과는 동일**하다(§2). 뷰어 오버레이 표시만 1개 줄어든다.
3. **거대 병합 박스(V-1) 잔존**: 봉쇄는 "차량당 1개"까지다. 배경 번호판 **1개**는 여전히 통과한다. 근본 처방은 **VPD conf 하한**(리더 후속 과제 V-1)이며 이 필터의 일이 아니다.
4. **VPD 미검출 + 번호판도 폴리곤 밖**: 주차차의 번호판이 차량 앞으로 튀어나와 주차면 폴리곤 밖에 중심이 놓이고, 그 차의 VPD 박스도 없으면 → **드롭**(점유 뒤집힘). (A)·(B) 둘 다 실패하는 유일한 조합. 확률 낮음, 관측 불가(경고 없음).
5. **사후 모드 전환 불가 상속**: 검출 시점 필터라 원 번호판이 DB 에 남지 않는다(1차 §7-3 동일).
6. **#0 정합 사각지대 상속**: 주차면 ROI 자체가 틀어져 있으면 (B) 항도 **똑같이 틀린다**.
7. **라이브 미검증**: 이 설계는 코드 정적 분석 기반이다. **`preset3` 에서 뒷줄 번호판이 실제로 사라지는지**는 마스터 스크린샷과 동일 조건의 **라이브 검출 재현으로 확인해야 한다**(성공 판정의 본체). 대조 지표: `summary.lpdFilteredOut > 0` **AND** `computeOccupancy` 로 계산된 점유 면 수가 **필터 전과 동일**.

---

## 8. 미해결 / 리더 확인 요청

- **Q1 (§4.9)**: 체크박스 라벨 `주차면 위 차량만 검출` → `주차면 위 차량만 검출(번호판 포함)` 로 갱신할지. 동작이 바뀌었으므로 갱신 권고하나 문구는 마스터 확정 사항. **id 는 유지**(변경 금지 — 배선·경계면 테스트가 id 로 봉인).
- **Q2 (§7-1)**: `web/core.js:quadCentroid` ↔ 서버 `quadBoundingRect+center` **이중 정의**를 통일할지(후속 과제 P-1). 이번은 `core.js` 무변경 제약으로 보류.

---

## 9. MCP 도구 vs LLM 두뇌 경계

**전부 결정형 도구.** 점 포함 판정·겹침 최대 매칭 — 수치·반복이며 모호성이 없다. **LLM 은 이 경로에 개입하지 않는다**(좌표 불변식 유지). `floorReviewer`/`occupancyReviewer`(LLM)는 필터된 검출을 **입력으로 받을 뿐** 규칙을 모른다.

---

## 10. 실행 순서 (구현자)

1. `src/capture/onPlaceFilter.ts` — `filterPlatesOnPlace` 추가 → **검증**: `test/onPlaceFilter.test.ts` P1~P7 (특히 **P4 거대 박스 1건 봉쇄**, **P2 폴리곤 보정**).
2. `src/capture/types.ts` — `CaptureStatus.lpdFilteredOut` → **검증**: `tsc --noEmit` exit 0.
3. `src/capture/detectPipeline.ts` — `summary.lpdFilteredOut` + 반환 `plates` 필터 → **검증**: D1~D6 + 기존 `toEqual` 2건 갱신 후 통과.
4. `src/capture/CaptureJob.ts` — `presetPlace` 추출 + `applyPlateFilter` + 카운터 → **검증**: C1~C3 + 기존 `captureJob*.test.ts` 무변경 통과.
5. `test/captureRoutes.test.ts` — `toEqual` 2건 갱신 + 경계면 계약 확장 → **검증**: 전체 `vitest run` 전량 통과.
6. `web/app.js`(+ Q1 확정 시 `web/index.html`) → **검증**: 라이브 검출에서 `cap-msg` 에 `번호판 N/M` 표시.
7. **★ 라이브 경험적 검증(§7-7 — 성공 판정의 본체)**: `preset3` 모드A 라이브 검출 → **뒷줄 노란 번호판 박스가 사라졌는가**(마스터 스크린샷 대조) + **점유 면 수가 필터 전과 동일한가**(회귀 0). 두 조건을 동시에 만족해야 성공.
