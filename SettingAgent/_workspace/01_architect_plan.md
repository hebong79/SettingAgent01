# 01. 설계 — VPD 검출 모드 2종(주차면 위 차량만 / 모든 차량)

## 0. 요구 요약

| 모드 | 체크박스 | 동작 |
|---|---|---|
| **A (기본)** | `#cap-vpd-onplace` **ON** | `PtzCamRoi.json` 의 `parking_spaces` 폴리곤 위 차량만 검출·집계 |
| **B** | OFF | 이미지 위 **모든** 차량(통로 통행차 포함) — **현행 동작** |

플래그명 **`vpdOnParkingOnly`**, 기본 `?? true`. 적용 지점 **2곳**: `CaptureJob`(정밀수집 → DB) / `runDetect`(라이브 검출 → 뷰어 오버레이).

---

## 1. 판정 규칙 결정 (핵심)

### 결론
> **차량 bbox 의 "접지 근사 밴드"(하단 25% 스트립)와 주차면 폴리곤의 겹침 면적비가 임계값 이상이면 그 차량은 주차면 위에 있다.**
> 여러 주차면에 대해 **OR**(어느 한 면이라도 만족하면 통과).

```
band(rect)      = { x, y: y + h·(1−0.25), w, h: h·0.25 }        // GROUND_BAND_RATIO = 0.25
onPlace(rect,P) = convexIntersectionArea(rectCorners(band), P) / area(band) ≥ 0.15   // ON_PLACE_MIN_OVERLAP
keep(rect)      = polys.some(P => onPlace(rect, P))
```
기하 유틸은 **전부 기존 것 재사용**: `polygon.ts` 의 `rectCorners`, `convexIntersectionArea` + `geometry.ts` 의 `area`. 신규 기하 0줄.

### 근거 — 대안 비교

전제(마스터 지적 + HANDOFF §6): **VPD rect 는 지붕까지 포함한 axis-aligned 전체 bbox**, 주차면 ROI 는 **바닥 quad**. 지면 위 높이 z 의 점은 이미지에서 카메라 nadir 로부터 `H/(H−z)` 배 **바깥(먼 쪽)** 으로 밀려 보인다. 카메라 높이 H≈8m, 차량 중심 높이 z≈0.75m → 약 **+10%** → nadir 로부터 25m 지점이면 **약 2.5m = 주차면 정확히 한 칸** 만큼 어긋난다.

| 대안 | 주차차 누락(FN) | 통행차 통과(FP) | 판정 |
|---|---|---|---|
| **(a) bbox 중심 ∈ 폴리곤** (Finalizer 선례) | **높음** — 중심이 먼 쪽으로 ~한 칸 밀려 자기 주차면 밖으로 이탈 | **치명적** — 통로 차량의 중심이 **뒷줄 주차면 폴리곤 위로 투영**된다 | **탈락** |
| (b) 전체 rect ∩ 폴리곤 면적비 | 낮음 | **치명적** — 통로 차량의 차체가 이미지상 뒷줄 주차면을 **가리므로** 큰 겹침 발생 | **탈락** |
| (c) 하단 중앙 1점 ∈ 폴리곤 | 중간 — 경계선에 걸친 차·타이트한 ROI 에서 1점이 살짝 밖 → 즉시 드롭(임계 없는 하드 경계) | 낮음 | 차선 |
| **(d) 하단 밴드 겹침 면적비 (채택)** | **낮음** — 밴드가 폭을 가져 경계 민감도 완화 | **낮음** — 밴드는 차량 **접지 영역**이라 통로 아스팔트 위에 놓임 | **채택** |

**(a) 를 버리는 결정적 이유**: 모드 A 의 **1차 목적이 "통로 통행차 배제"** 인데, 중심 규칙은 바로 그 통행차를 **뒷줄 주차면에 올려놓는다**(FP). 목적 자체를 달성하지 못한다.

**(d) 가 임계값에 둔감한 이유**: 판정이 **전 폴리곤 OR** 이다. 주차면 *배정*(어느 칸인가)이 아니라 *필터*(주차면 위인가)이므로, 원근 오차로 밴드가 **옆 칸**에 걸쳐도 결과는 여전히 `keep` = 정답. 드롭되는 것은 **어느 주차면과도 겹치지 않는 차** = 통로/진출입로 차량뿐이다.

### Finalizer 선례와의 관계 (⚠️ 마스터 질문 "같은 규칙 두 벌 금지")
`Finalizer.ts:237-241` 은 **다른 질문**에 답한다 — *필터*가 아니라 ***배정***(이 클러스터가 **어느** 주차면인가). 그리고 그것은 **번호판 중심 우선**(번호판은 지상 ~0.5m → 원근 오차 작음)이고 차량 중심은 **폴백**이다.

**이번 변경에서 Finalizer 는 건드리지 않는다.** 근거:
1. 모드 A 에서는 필터가 **상류**(검출 직후)에 있다 → Finalizer 에 도달하는 검출은 이미 전부 주차면 위 → 차량중심 폴백의 FP 위험(통행차가 뒷줄 칸에 배정)이 **필터에 의해 이미 제거**된다.
2. Finalizer 규칙 교체는 요청 범위 밖의 **점유 배정 동작 변경**이며 기존 테스트(`finalizerParkingSlots.test.ts`)가 그 동작을 단언 중이다.

**→ 미해결 질문 (마스터 확인 요청, §7-Q1)**: 모드 B 에서는 Finalizer 의 차량중심 폴백이 여전히 통행차를 뒷줄 칸에 배정할 수 있다. 이 규칙을 `isVehicleOnPlace` 로 통일할지는 **별도 과제(라이브 검증 필요)** 로 등록할 것을 권고한다.

### 임계값
모듈 named const(`Aggregator.ts` 선례 — tools.config 미승격). **설정 노출 안 함**(요청 범위 밖).
```ts
export const GROUND_BAND_RATIO = 0.25;    // 접지 근사 밴드 = bbox 하단 25%
export const ON_PLACE_MIN_OVERLAP = 0.15; // 밴드 면적 대비 폴리곤 겹침 하한
```

---

## 2. 필터 적용 지점

**`vpd.detect()` 직후 필터**(저장 시점 아님). 두 경로 모두 **동일 순수 함수 1개** 사용.

| 트레이드오프 | 검출 직후(채택) | 저장 시점/집계 시점 |
|---|---|---|
| 코드량 | 최소 | detections 스키마 플래그 + aggregate 시그니처 변경 |
| 사후 모드 전환 | **불가**(원 검출이 DB 에 없음 → 재수집 필요) | 가능 |
| 사용자 멘탈모델 | "검출하지 않는다" = 체크박스 문구 그대로 | 어긋남 |
| `runDetect` zoom 재시도 | **통행차에 대해 0회**(카메라 호출 절감) | 낭비 |

→ 검출 직후. **사후 전환 불가는 §7 한계로 명시.**

### 번호판(LPD)은 필터하지 않는다
- 체크박스 문구가 "주차면 위 **차량**만". 번호판은 대상 아님.
- `Aggregator.ts:256-311`: **plate 클러스터는 vehicle 클러스터를 통해서만 결과에 노출**된다(미매칭 plate 클러스터는 버려짐). → 통행차 번호판은 **자동으로 소멸**. 별도 필터 불요.
- `web/core.js:454 computeOccupancy(floorPolygons, plates)` 는 **번호판 중심 ∈ 폴리곤**으로 점유를 계산 → 통로 차량 번호판은 애초에 폴리곤 밖 → 점유 오염 없음. **plates 를 필터하면 오히려** VPD 가 놓친 주차차의 번호판까지 사라져 점유가 뒤집힐 위험.
- 유일한 부작용: 모드 A 에서 통행차 위에 **차량 박스 없이 번호판 quad 만** 그려질 수 있음. **의도된 동작으로 문서화**(§7 한계).

---

## 3. 강등 정책 (주차면 폴리곤 부재)

`placeRoiFile` 미설정 / 파일 없음 / 파싱 실패 / **해당 프리셋 주차면 0개** → 필터 기준이 없다.

> **전량 통과(모드 B 로 강등) + `reason` 포함 warn 로그 + 상태/응답에 advisory 노출.**

**전량 드롭 금지 근거**: 기준이 없다는 이유로 드롭하면 **데이터가 조용히 사라진다**(최악). HANDOFF §2-3 "조용한 폴백 제거" 원칙 — 폴백은 반드시 드러낸다(`fovBaseV` 버그가 숨었던 경로).

**입도(중요)**: 강등은 **프리셋 단위**다. `placeRoi.ts:79` 는 주차면이 1개 이상인 프리셋만 `byPreset` 에 키를 넣는다 → 키 부재 = "이 프리셋엔 ROI 없음". 파일 전체가 없으면 전 프리셋 강등, 특정 프리셋만 ROI 가 없으면 **그 프리셋만** 강등(다른 프리셋의 필터는 정상 동작).

| 상황 | reason 문자열 |
|---|---|
| `placeRoiFile` 미설정/로드 실패 | `주차면 파일 없음/로드 실패` |
| 해당 프리셋 주차면 0개 | `프리셋 cam{c}:{p} 주차면 0개` |

---

## 4. 변경 파일별 상세 계획

### 4.1 신규 — `src/capture/onPlaceFilter.ts` (~45줄, 순수)
```ts
import type { NormalizedPoint, NormalizedRect } from '../domain/types.js';
import { rectCorners, convexIntersectionArea } from '../domain/polygon.js';
import { area } from '../domain/geometry.js';

export const GROUND_BAND_RATIO = 0.25;
export const ON_PLACE_MIN_OVERLAP = 0.15;

/** 차량 bbox 접지 근사 밴드(하단 25%). VPD rect 는 지붕 포함 bbox → 중심은 원근으로 바닥면 밖(먼 쪽)으로 이탈한다. */
export function groundBand(rect: NormalizedRect): NormalizedRect;

/** 접지 밴드가 주차면 폴리곤들 중 **하나라도** 임계 이상 겹치는가(OR). polys 빈 배열 → false. 밴드 면적 0 → false. */
export function isVehicleOnPlace(
  rect: NormalizedRect,
  polys: readonly (readonly NormalizedPoint[])[],
): boolean;

/**
 * 모드A 필터. polys 가 null/빈 배열이면 **강등**: 전량 통과 + degraded=true (드롭 금지).
 * VehicleBox·DetectVehicle 양쪽에 쓰이도록 구조적 제네릭.
 */
export function filterVehiclesOnPlace<T extends { rect: NormalizedRect }>(
  vehicles: readonly T[],
  polys: readonly (readonly NormalizedPoint[])[] | null | undefined,
): { kept: T[]; filteredOut: number; degraded: boolean };
```
- `convexIntersectionArea` 는 **볼록** 폴리곤 전제. 주차면 4점 바닥 quad 는 통상 볼록(`floorRoi` 도 동일 전제). 사용자가 정점을 끌어 오목하게 만들면 겹침 과대추정 → §7 한계.

### 4.2 `src/capture/CaptureJob.ts`
| 위치 | 변경 |
|---|---|
| `CaptureJobDeps` (:20) | `placeRoiFile?: string;` 추가(Finalizer 와 **동일 경로** 주입) |
| `CaptureStartParams` (:45) | `vpdOnParkingOnly?: boolean;` 추가 |
| 필드 (:86 인근) | `private vpdOnParkingOnly = true;` / `private placePromise?: Promise<NormalizedPlaceRoi \| null>;` / `private vpdFilteredOut = 0;` / `private onPlaceDegraded?: string;` / `private degradeWarned = new Set<string>();` |
| `start()` (:153 인근) | `this.vpdOnParkingOnly = p.vpdOnParkingOnly ?? true;` + 카운터/가드 초기화 + `this.placePromise = loadNormalizedPlaceRoi(this.deps.placeRoiFile);` (**run 시작 시 1회 로드** → 사용자가 뷰어에서 편집·저장한 최신 ROI 반영. `loadNormalizedPlaceRoi(undefined)` = `null` 이므로 분기 불요) |
| `captureTarget()` (:284) | `const raw = await this.deps.vpd.detect(cap.jpg);` → 모드 A 면 `const polys = (await this.placePromise)?.byPreset.get(\`${t.camIdx}:${t.presetIdx}\`)?.map(s => s.points) ?? null;` → `filterVehiclesOnPlace(raw, polys)` → `degraded` 면 `markDegraded(t, reason)`(프리셋키당 warn 1회) 후 **raw 사용**, 아니면 `kept` 사용 + `this.vpdFilteredOut += filteredOut`. 이후 `dets` 조립은 **필터된 vehicles** 로. **LPD 경로(:295-306) 무변경.** |
| `getStatus()` (:132) | 조건부 스프레드 추가(`llmFloorUnavailable` 패턴): `...(this.runId !== undefined ? { vpdOnParkingOnly: this.vpdOnParkingOnly } : {})`, `...(this.vpdFilteredOut > 0 ? { vpdFilteredOut: this.vpdFilteredOut } : {})`, `...(this.onPlaceDegraded ? { vpdOnPlaceDegraded: this.onPlaceDegraded } : {})` |

`normalizeGlobalIdx` **불필요**(전역번호가 아니라 좌표만 쓴다).

### 4.3 `src/capture/types.ts` — `CaptureStatus` (:127)
```ts
  /** 이번 run 에 적용된 VPD 필터 모드(true=주차면 위 차량만). */
  vpdOnParkingOnly?: boolean;
  /** 필터로 제외된 차량 누적 대수(run 누적). */
  vpdFilteredOut?: number;
  /** 주차면 폴리곤 부재로 모드B 강등 중(사유). C1 — UI 가 항상 소스를 안다. */
  vpdOnPlaceDegraded?: string;
```

### 4.4 `src/capture/detectPipeline.ts`
```ts
/** 모드A 옵션. 미지정 → 필터 없음(runDetect 계약 불변 — 기존 3인자 호출 회귀 0). */
export interface OnPlaceOpts {
  onlyOnPlace: boolean;
  /** 대상 프리셋 주차면 폴리곤(정규화). null/빈 → 강등(전량 통과). */
  polys: NormalizedPoint[][] | null;
}
export async function runDetect(
  deps: DetectDeps, args: { cam; preset }, cfg: DetectCfg, onPlace?: OnPlaceOpts,
): Promise<DetectResult>
```
- `:197` 직후 필터 → **zoom 재시도 루프(:210-236) 진입 전** 차량 배열 축소(통행차에 대한 카메라 호출 0회).
- `matchPlatesToSlots` (:201) 는 **필터된 vehicles** 로 호출(인덱스 정합 유지).
- 강등 시 `logger.warn({cam, preset, reason}, ...)`.
- `DetectResult.summary` 확장(:61):
```ts
summary: {
  vpdCount: number;        // 필터 **전** 원 검출 수(의미 불변)
  lpdCount: number;        // 불변(plates 미필터)
  recovered: number;       // 불변
  onPlaceOnly: boolean;    // 실제 적용된 모드(강등 시 false)
  filteredOut: number;     // 제외 대수(모드B/강등 시 0)
  onPlaceDegraded?: string;// 요청 true 였으나 폴리곤 없음 → 사유
}
```
`vehicles.length = vpdCount − filteredOut` → **"몇 대 중 몇 대 빠졌나"** 를 UI 가 그대로 표시(C1).
- `plates` 배열(:244) **무변경**(§2 근거).

### 4.5 `src/api/captureRoutes.ts`
- `:42` `StartBodySchema` 에 `vpdOnParkingOnly: z.boolean().optional()` 추가 → `:163` 인근에서 `job.start({..., vpdOnParkingOnly: parsed.data.vpdOnParkingOnly})` (기본값은 CaptureJob 이 `?? true`).
- `:60` `DetectBodySchema` 에 `vpdOnParkingOnly: z.boolean().optional()` 추가.
- `:494-498` detect 핸들러: `loadNormalizedPlaceRoi(deps.placeRoiFile)` → `polys = place?.byPreset.get(\`${cam}:${preset}\`)?.map(s => s.points) ?? null` → `runDetect({camera,vpd,lpd}, { cam, preset }, cfg, { onlyOnPlace: parsed.data.vpdOnParkingOnly ?? true, polys })`.
  ⚠️ 현재 `runDetect(..., parsed.data, cfg)` 로 body 를 그대로 넘긴다 → **`{ cam, preset }` 명시 전달로 교체**(새 키 누출 방지).
  `import { loadNormalizedPlaceRoi }` 는 `placeRoi.js` 에서(이미 `applyPlaceRoiUpdate` 를 같은 모듈에서 import 중 — :7).

### 4.6 `src/index.ts` (:56)
`new CaptureJob({ ..., placeRoiFile: join(tools.store.dataDir, tools.store.placeRoiFile) })` — Finalizer(:63)/server(:77)와 **동일 표현**.

### 4.7 `web/index.html` (:166 인근, `.capture-grid` 내부, `#cap-floor-llm` 바로 뒤)
```html
<label class="field check"><input id="cap-vpd-onplace" type="checkbox" checked /> 주차면 위 차량만 검출</label>
```
`checked` = 기본 모드 A.

### 4.8 `web/app.js`
| 위치 | 변경 |
|---|---|
| `:1616` 인근(capStart body) | `vpdOnParkingOnly: $('cap-vpd-onplace').checked,` 추가 |
| `:565-569` (`runLiveDetect`) | detect payload 에 `vpdOnParkingOnly: $('cap-vpd-onplace').checked` 추가 |
| `runLiveDetect` 응답 처리(:571 이후) | `const s = res.summary;` → `$('cap-msg').textContent = \`검출 ${s.vpdCount - s.filteredOut}/${s.vpdCount}대 · 주차면필터 ${s.onPlaceOnly ? 'ON' : 'OFF'}${s.onPlaceDegraded ? ` — 강등: ${s.onPlaceDegraded}` : ''}\`` (C1) |
| `renderCaptureStatus`(status 렌더 지점) | `status.vpdOnParkingOnly` → "주차면필터 ON(제외 N대)" 배지, `status.vpdOnPlaceDegraded` → 경고 문구(`llmFloorUnavailable` 표시 패턴 재사용) |

### 4.9 `web/core.js` — **변경 없음**
서버가 **이미 필터된 결과**를 준다. 뷰어는 그리기만. → HANDSOFF §2-5(이중구현 금지) 준수, **파리티 테스트 불요**.
`core.js:454 computeOccupancy` 는 번호판 기반 별개 규칙이며 이번 변경의 대상이 아니다(§2 참조).

---

## 5. 영향받는 기존 테스트 + 예상 조치

**핵심 성질**: 강등 정책 덕분에 **`placeRoiFile` 을 주입하지 않는 기존 테스트는 전부 "전량 통과"(현행 동작)로 수렴** → 동작 회귀 0. 깨지는 것은 **응답 shape 을 `toEqual` 로 완전일치 단언한 2건**뿐이다.

| 파일:줄 | 현상 | 조치 |
|---|---|---|
| `test/detectPipeline.test.ts:118` | `expect(out.summary).toEqual({vpdCount:1, lpdCount:1, recovered:0})` — summary 에 `onPlaceOnly:false, filteredOut:0` 가산 → **실패** | 기대값에 `onPlaceOnly: false, filteredOut: 0` 추가(3인자 호출 = 필터 미적용) |
| `test/captureRoutes.test.ts:500` | `expect(body.summary).toEqual({vpdCount:0, lpdCount:0, recovered:0})` — 라우트가 `?? true` + `placeRoiFile` 미주입 → **강등** → `onPlaceOnly:false, filteredOut:0, onPlaceDegraded:'주차면 파일 없음/로드 실패'` 가산 → **실패** | 기대값 갱신(강등 경로가 정상임을 단언) |
| `test/captureJob*.test.ts` (4건) | `placeRoiFile` 미주입 → `placePromise=null` → 강등 → 전량 통과 | **무변경 통과 예상**(warn 로그만 증가) |
| `test/finalizer*.test.ts` | Finalizer 무변경 | 영향 없음 |
| `test/groundSimilarityDetect.test.ts`, `rpcCameraClient.test.ts` | `summary` 전체를 `toEqual` 하지 않음(grep 확인) | 영향 없음 |
| `getStatus()` 를 `toEqual` 로 단언하는 테스트 | **없음**(grep 확인) → CaptureStatus 필드 가산 안전 | 없음 |

### 하위호환 영향도 (프로덕션)
- `index.ts` 가 `placeRoiFile` 을 주입하므로 **실서비스 기본 동작이 바뀐다**: 정밀수집·라이브검출 모두 기본 **모드 A**(주차면 위 차량만). 이전에는 "모든 차량"이었다.
- 결과적으로 `detections` → `aggregate()` → `parking_slots` 에 **통로 통행차가 더 이상 들어오지 않는다**. 이전 run 대비 검출 수 감소는 **정상**이며, 감소분은 `status.vpdFilteredOut` 으로 관측된다.
- 사용자가 모드 B 를 원하면 체크 해제(=이전 동작 100% 복원 — 필터 함수 자체를 건너뜀).

---

## 6. 유닛테스트 항목 제안 (qa-tester)

**`test/onPlaceFilter.test.ts` (신규, 순수 — 핵심)**
1. 주차차: bbox 하단이 폴리곤 내부 → `keep`.
2. **통행차(규칙 선택의 근거 — 회귀 봉인)**: bbox **중심은 뒷줄 폴리곤 안**, **하단 밴드는 통로**(폴리곤 밖) → **`drop`**. ← 중심규칙이었다면 통과했을 케이스.
3. 폴리곤을 살짝 스치는 차(밴드 겹침 < 0.15) → `drop`.
4. **다중 폴리곤 OR**: 자기 칸이 아니라 **옆 칸** 밴드와만 겹쳐도 `keep`(배정이 아니라 필터임을 봉인).
5. 강등: `polys = null` / `[]` → `degraded=true`, `kept.length === vehicles.length`, `filteredOut === 0`.
6. 방어: `h=0`/`w=0` rect → throw 없이 `false`.
7. `groundBand`: 밴드가 rect 하단 25% 임을 좌표로 단언.

**`test/captureJobOnPlace.test.ts` (신규)**
8. `placeRoiFile` = **동결 픽스처 `test/fixtures/PtzCamRoi.unity.json`**(⚠️ HANDOFF §2-2 — 런타임 `data/Place01/PtzCamRoi.json` 절대 사용 금지) + VPD 스텁(주차차 1 + 통행차 1) → `insertDetections` 에 vehicle **1건**.
9. `vpdOnParkingOnly:false` → vehicle **2건**(모드 B 회귀 0).
10. 강등: `placeRoiFile` 미주입 → **2건 전량** + `getStatus().vpdOnPlaceDegraded` 존재 + `vpdFilteredOut` 미노출.
11. LPD 는 필터 무관 — plate 검출 건수 불변(모드 A/B 동일).

**`test/detectPipeline.test.ts` (증분)**
12. 4번째 인자 `{onlyOnPlace:true, polys}` → 통행차 제외 + `summary.onPlaceOnly=true`, `filteredOut=1`, `vpdCount`=원 검출 수.
13. **카메라 호출 절감**: 통행차는 zoom 재시도 진입 전에 제외 → `camera.requestImage` 호출 수로 단언.
14. `{onlyOnPlace:true, polys:null}` → `onPlaceOnly=false` + `onPlaceDegraded` 존재 + 전량 통과.
15. 3인자 호출(기존) → `onPlaceOnly=false`, `filteredOut=0` (계약 불변).

**`test/captureRoutes.test.ts` (증분)**
16. `POST /capture/start` body `{vpdOnParkingOnly:false}` → zod 통과 → job 에 전달됨.
17. `POST /capture/detect` body 미지정 + `placeRoiFile` 주입 → 필터 적용(기본 true 확인).
18. `POST /capture/detect` body `{vpdOnParkingOnly:false}` + `placeRoiFile` 주입 → 전량 통과.

---

## 7. 검증 불가 / 한계 (은닉 금지)

1. **임계값(0.25 / 0.15)은 해석적으로 유도한 값이 아니다.** 유닛테스트는 규칙의 *논리*만 봉인하며 임계값의 *적절성*은 봉인하지 못한다. → **라이브 검증 필수**: 모드 A 로 정밀수집 1라운드 → 라이브 프레임 위에 유지/제외 차량을 육안 대조(`GET /viewer/api/snapshot?cam=1&preset=N&mode=preset` + 검출 오버레이). `filteredOut` 이 0 이 아니면서 **주차차가 빠지지 않았음**을 확인해야 성공이다.
2. **가림(occlusion)**: 앞줄 차가 뒷줄 차의 하단을 가리면 bbox 하단이 실제 접지선보다 **위**로 잡혀 접지 근사가 틀어진다. 전 폴리곤 OR 로 상당 부분 흡수되지만 **완전 해결은 SAM 접지선**(HANDOFF §6 후속 과제)뿐이다.
3. **사후 모드 전환 불가**: 검출 시점 필터라 원 검출이 DB 에 남지 않는다. 모드를 바꾸려면 **재수집**해야 한다(§2 트레이드오프).
4. **#0 정합 사각지대 상속**: 주차면 ROI 자체가 한 칸 평행이동돼 있으면 필터도 **똑같이 틀린다**(경고 없음, HANDOFF §3). 필터는 ROI 를 검증하지 않는다.
5. **오목 폴리곤**: `convexIntersectionArea` 는 볼록 전제 → 사용자가 정점을 끌어 오목 quad 를 만들면 겹침이 과대추정된다(FN 감소 방향이라 안전측이지만 부정확).
6. **모드 A 에서 통행차 위에 번호판 quad 만 표시될 수 있음**(차량 박스 없이). 의도된 동작(§2).

---

## 8. MCP 도구 vs LLM 두뇌 경계

**전부 결정형 도구.** 순수 기하(면적비·다각형 클리핑) — 반복·수치 루프이며 모호성이 없다. **LLM 은 이 경로에 개입하지 않는다**(좌표 불변식 유지). 기존 `floorReviewer`/`occupancyReviewer`(LLM)는 필터된 검출을 **입력으로 받을 뿐** 규칙을 알 필요가 없다.

---

## 9. 미해결 / 마스터 확인 요청

- **Q1 (§1 말미)**: 모드 B 에서 `Finalizer.ts:240` 의 **차량중심 폴백**은 여전히 통행차를 뒷줄 주차면에 배정할 수 있다. 이 규칙을 `isVehicleOnPlace` 로 통일할지 — **이번 범위 밖(요청되지 않은 점유 배정 동작 변경 + 기존 테스트 단언 대상)** 이라 보류하고 후속 과제 등록을 권고한다. 지금 함께 처리할지 판단 요청.
- **Q2**: 체크박스가 **정밀수집·라이브검출 공용**이다(하나의 `#cap-vpd-onplace` 가 두 payload 에 실림). 수집 중 체크박스를 토글하면 **라이브 검출만** 즉시 바뀌고 **진행 중인 run 은 시작 시 모드를 유지**한다(`status.vpdOnParkingOnly` 로 실제 모드를 표시해 혼동 방지). 이 동작으로 확정해도 되는지 확인 요청.

---

## 10. 실행 순서 (구현자)

1. `src/capture/onPlaceFilter.ts` 신규 → **검증**: `test/onPlaceFilter.test.ts` 항목 1-7 통과(특히 #2 통행차 드롭).
2. `src/capture/types.ts` CaptureStatus 3필드 → **검증**: `tsc --noEmit` exit 0.
3. `src/capture/CaptureJob.ts` 배선 → **검증**: 항목 8-11 통과 + 기존 `captureJob*.test.ts` 4건 무변경 통과.
4. `src/capture/detectPipeline.ts` `OnPlaceOpts` + summary 확장 → **검증**: 항목 12-15 + `detectPipeline.test.ts:118` 기대값 갱신 후 통과.
5. `src/api/captureRoutes.ts` zod 2곳 + detect 핸들러 → **검증**: 항목 16-18 + `captureRoutes.test.ts:500` 갱신 후 통과.
6. `src/index.ts` `placeRoiFile` 주입 → **검증**: `tsc --noEmit` + 전체 `vitest run` 전량 통과.
7. `web/index.html` + `web/app.js` → **검증**: 뷰어에서 체크박스 ON/OFF 로 검출 실행 → `cap-msg` 에 `검출 N/M대 · 주차면필터 ON/OFF` 표시.
8. **라이브 경험적 검증(§7-1)**: 모드 A 수집 → 유지/제외 차량 육안 대조 → 필요 시 임계값 재조정(이 단계가 성공 판정의 본체).
