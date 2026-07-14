# 02 구현 결과 — 1단계: 파일 경로 육면체(지면모델 v1)

작성: 구현자(developer) / 대상: SettingAgent
입력: `_workspace/01_architect_plan.md` §1~§14 (1단계만). **2~5단계(median·SAM·LLM·시간누적·slot_spec)는 코드 0줄.**

> **요약**
> 1. `npx tsc --noEmit` **exit 0**. `npx vitest run` **1380 pass / 0 fail (128 파일) — 전량 통과.**
> 2. Unity GT 대비 **f 오차 −0.53% (기준 ≤5%)**, **tilt 오차 ≤0.14° (기준 ≤1°)**, 카메라 지상고 **4.94~4.99m vs GT 5.0m**.
> 3. sharp 로 실프레임 3프리셋에 육면체를 렌더해 **육안 확인 완료**(§6).
> 4. ⚠️ **`f`/`tilt` 일치는 ROI 정합을 보장하지 않는다(§5-A).** 실측: ROI 를 ±200px 평행이동해도 f 는 0.7%, tilt 는 0.05° 밖에 안 변한다. **정합 지표 4개**를 두되(§5-B), **`metricErr`+`tiltErrDeg` 는 상보적이지 않다**(검증자 지적 — 정정 완료). **지면 위 평행이동(= 주차면 한 칸)은 원리적으로 검출 불가**이며 이를 사각지대로 **명시·봉인**했다(§5-B-1).
> 5. **테스트 설계 결함 수정**(§7): 런타임 가변 데이터(`data/Place01/PtzCamRoi.json`)를 픽스처로 삼은 테스트 **7개 파일**을 동결 픽스처로 이전. **사용자가 뷰어에서 편집·저장해도 깨지지 않음을 시뮬레이션으로 검증**했다.
> 6. **설계서 대비 의도적 이탈 2건**(§4) — 리더 **승인 완료**.
> 7. 실데이터에서 설계 §4-6 의 **'폭/깊이 대응 뒤집힘' 함정이 실재**한다(§5-C). 방어 코드가 없었다면 스케일이 조용히 2배 틀렸다.

---

## 1. 변경 파일 목록

### 신규 (서버 — 추정은 전부 서버 소유)
| 파일 | 줄 수 | 내용 |
|---|---|---|
| `src/ground/types.ts` | 88 | `GroundModel`, `PixelQuad`, `Hom2`, `GroundCameraInput`, `GroundOptions` |
| `src/ground/groundModel.ts` | 379 | **순수 추정 수학**. 소실점·f·프리셋 공동추정·지면평면·퇴화방어 |
| `src/ground/groundInputs.ts` | 45 | PtzCamRoi.json + camerapos → 추정 입력(순수). 점 추출은 `normalizePtzCamRoi` 재사용 |

### 가산 (기존 파일 — 시그니처 변경 0, 기존 경로 변경 0)
| 파일 | 변경 |
|---|---|
| `src/api/captureRoutes.ts` | `GET /capture/ground-model` 추가(place-roi 라우트 옆). deps 에 `ground?` 추가 |
| `src/api/server.ts` | `ApiDeps.ground?` + `registerCaptureRoutes` 로 전달 (2줄) |
| `src/index.ts` | `ground: tools.ground` 주입 (1줄) |
| `src/config/toolsConfig.ts` | `GroundSchema` + `DEFAULT_TOOLS_CONFIG.ground` (섹션 병합 루프가 자동 처리 — 별도 병합 라인 불요) |
| `web/core.js` | **순수 가산**: `projectCuboid`, `formatGroundBadge`, `groundModelsByKey` (파일 끝에 추가, 기존 함수 무변경) |
| `web/core.d.ts` | 위 3개 + `ViewerGroundModel`/`Cuboid` 타입 선언 |
| `web/app.js` | `drawCuboidOverlay` / `updateGroundBadge` / `loadGroundModel` + 토글·슬라이더 리스너 |
| `web/index.html` | `#roi-cuboid` 토글 + `#cuboid-h` 슬라이더 + `#ground-badge` 배지 |
| `web/app.css` | 슬라이더·배지 스타일 (`.roi-toggles` 규칙 옆) |

### 신규 테스트 (전부 통과)
| 파일 | 내용 |
|---|---|
| `test/groundModelRoundTrip.test.ts` | **합성카메라 왕복**(K/R/t 복원) + 노이즈 + 공동추정 + 퇴화 |
| `test/groundModelRealData.test.ts` | **Unity GT 수치 대조**(f/tilt/카메라고) + 대응 뒤집힘 실증 |
| `test/viewerCuboid.test.ts` | `projectCuboid` 기하 + 17면 종단 |
| `test/groundModelRoutes.test.ts` | 라우트 계약(200/404/강등) |
| **`test/roiAlignmentSensitivity.test.ts`** | ★ **정합 한계 봉인 + 신규 지표 검증**(§5-A·5-B) |
| **`test/placeRoiRuntimeInvariants.test.ts`** | ★ 런타임 데이터 **구조 불변식만**(값 불단정, §7) |

### 신규 픽스처 (커밋 대상 — §7)
| 파일 | 내용 |
|---|---|
| `test/fixtures/PtzCamRoi.unity.json` | Unity 생성 **원형**(0-based idx, 원본 좌표). 값 단정 테스트 전용 |
| `test/fixtures/camerapos.sample.json` | 프리셋 PTZ 동결 |

### 기존 테스트 이전 (런타임 데이터 → 동결 픽스처, §7)
`normalizePtzCamRoi` / `placeRoi` / `placeGlobalIdx` / `selectFloorRoi` / `computeOccupancy` / `globalIdxParity` — **로직 변경 0, 입력 경로만 픽스처로 교체.**

### 손대지 않은 것 (계획대로)
`PtzCamRoi.json` 스키마 / DB 스키마 / `computeOccupancy`(C6 seam) / `detectMath.ts`(읽기 전용 import) / `slot_spec.json`(1단계에 불필요 → **만들지 않음**) / `selectFloorRoi` 의 데드 `useLlm:true` 분기(§1.2-B — 언급만, 삭제 안 함).

---

## 2. 신규 순수함수 시그니처

### 서버 `src/ground/groundModel.ts`
```ts
/** quad 가 추정 표본으로 쓸 수 있는가(4점·유한·최소변 8px·최소면적 400px²·볼록·비자기교차). */
export function isUsableQuad(quad: PixelQuad): boolean;

/** 이미지 4점 사각형들 → 두 직교 소실점 + 변군별 픽셀길이 중앙값. 무한원 소실점은 동차로 유지(w≈0). */
export function estimateGroundVPs(quads: PixelQuad[]):
  { v1: Hom2; v2: Hom2; edgePxA: number; edgePxB: number } | null;

/** 직교 제약 (v1−c)·(v2−c) + f² = 0. 무한원/f²≤0 → null (NaN·Infinity 전파 0). */
export function focalFromVPs(v1: Hom2, v2: Hom2, cx: number, cy: number): number | null;

/** zoom → f(px). detectMath.fovV 재사용(자체 FOV 공식 금지 — 이중구현 회피). */
export function focalFromZoom(zoom: number, fovBaseV: number, imgW: number, imgH: number): number | null;

/** ★ 카메라당 fovBaseV 공동추정. 깊이변 픽셀길이² 가중 합의. 표본 0 → null. */
export function poolFovBaseV(
  samples: Array<{ zoom: number | null; f: number | null; depthEdgePx: number }>,
  imgH: number,
): { fovBaseV: number; conf: number; issues: string[] } | null;

/** f + 소실점 + 주차면 규격 → 지면평면. 폭/깊이 배정은 metric 적합도로 자동 판별(depthFamily 로 보고). */
export function buildGroundPlane(
  quads: PixelQuad[], f: number, v1: Hom2, v2: Hom2, cx: number, cy: number,
  opts: Pick<GroundOptions, 'slotWidthM' | 'slotDepthM'>,
): { n: [number, number, number]; d: number; metricErr: number; depthFamily: 'a' | 'b' } | null;

/** 카메라 1대의 전 프리셋 지면모델. 추정 실패 프리셋은 models 에서 제외(육면체 미표시). */
export function estimateGroundModels(cam: GroundCameraInput, opts: GroundOptions):
  { models: GroundModel[]; fovBaseV: number | null; issues: string[] };
```

**`GroundModel` 정합 관련 필드(신규 포함) — 4개 지표**
```ts
metricErr: number;            // ① 이미지 평행이동(0.008 초과 시 advisory). 경사 탐지도 겸함
tiltErrDeg: number | null;    // ② 세로 어긋남 = 추정 tilt − PTZ tilt. |1.0°| 초과 시 advisory
dDevRel: number | null;       // ③ ★신규 — 지면 균일스케일 = 카메라고 d 의 프리셋 간 편차. |10%| 초과 시 advisory
bearingDevDeg: number | null; // ④ ★신규 — 지면 수직축회전 = 슬롯 방위의 프리셋 간 편차. |8°| 초과 시 advisory

ptzTiltDeg: number | null;    // 카메라 보고 PTZ tilt(실카메라도 주는 값)
slotBearingDeg: number | null;// 슬롯 스트립 방위(mod 90) = PTZ pan + 슬롯 azimuth. 프리셋 불변량
```
```ts
/** 슬롯 스트립 방위(mod 90). 카메라가 pan 만큼 돌면 azimuth 가 반대로 줄어 합이 불변 → 프리셋 불변량. */
export function slotBearingDeg(n: [number,number,number], dirA: [number,number,number], panDeg: number): number | null;
```
**❌ 어떤 필드도 지면 위 평행이동을 검출하지 못한다(§5-B-1 — 원리적 사각지대).**

### 뷰어 `web/core.js` (추정 없음 — **투영만**)
```js
/** 바닥 quad(0..1, 4점) + 지면모델 + 높이 h(m) → { corners:[8], edges:[12] } | null. */
export function projectCuboid(floorQuad, groundModel, heightM);
/** 소스 배지 문자열. 모델 없음 → '지면모델: 없음'. */
export function formatGroundBadge(model);
/** models[] → cam:preset 맵. */
export function groundModelsByKey(models);
```

---

## 3. 지면모델 수학 — 실제로 구현한 것

**지면 = (f, n, d) 세 값이 전부다.**
- `n` = 지면 하향 단위법선(카메라 좌표), `d` = 카메라 지상고(m), `f` = 초점거리(px).
- 지면 = `{ X | n·X = d }`. 픽셀 p 의 지면점 = `d·m/(n·m)`, `m = K⁻¹p`.
- **높이 h 점의 상**: `p_h ≃ p − h·((n·m)/d)·(K·n)` ← 뷰어 `projectCuboid` 가 쓰는 유일한 식(내적 2번).

산출 흐름 (프리셋별 → 카메라별 → 프리셋별):
```
1) estimateGroundVPs   : 변군 A(p0-p1,p3-p2) / B(p0-p3,p1-p2) 최소제곱 소실점
                         (Hartley 정규화 → 단위직선 → AᵀA 최소고유벡터[Jacobi])
2) focalFromVPs        : 프리셋 단독 f (직교 제약). f²≤0/무한원 → null
3) buildGroundPlane(1차): 단독 f 로 임시 평면 → **어느 변군이 깊이(5m)인지 확정**
4) poolFovBaseV        : ★ 카메라당 fovBaseV 하나를 깊이변² 가중으로 공동추정
5) focalFromZoom       : 프리셋 f = detectMath.fovV(zoom, fovBaseV) 로 **유도**
6) buildGroundPlane(2차): 공동추정 f 로 최종 평면 (n, d, metricErr)
```

---

## 4. ★ 설계서 대비 의도적 이탈 2건 (리더 **승인 완료**)

### 이탈 1 — `GroundModel` 을 `H`(3×3 호모그래피) 대신 **(f, n, d)** 로 실었다

설계 §6 은 `{ f, H, vertVP, horizon, conf, source }` 였다. 구현은 `{ f, n, d, tiltDeg, ... }`.

**이유**: `H` 를 실으면 **뷰어가 `H⁻¹` 과 `K⁻¹H` 분해(r1,r2,r3 복원·부호결정)를 재구현해야 한다** — 설계 §1-7 이 금지한 이중구현이 정확히 뷰어에서 발생한다. `(f,n,d)` 는 `H` 와 **정보적으로 등가**(지면 원점·방위라는 임의 선택분만 빠지며, 육면체는 그 값에 불변)이면서 뷰어 코드가 **내적 2번**으로 끝난다. `projectCuboid` 는 40줄이 아니라 **20줄**이다.
`vertVP`/`horizon` 은 **소비처가 없어 싣지 않았다**(CLAUDE.md 규칙 2). 필요하면 `K·n` 으로 언제든 유도된다.

### 이탈 2 — `poolFovBaseV` 에서 **하드 게이트(minDepthEdgePx)를 제거**했다

설계 §4-4/§6 은 게이트 미만 프리셋을 공동추정 표본에서 제외하는 안이었다. 구현은 **전 표본을 깊이변² 가중으로 합의**하고, `minDepthEdgePx` 는 **conf·advisory 전용**으로만 쓴다(설계 §4-6 표가 지정한 게이트의 원래 역할과 동일).

**이유(실측)**: 실데이터 깊이변은 **213 / 247 / 614px**. 게이트 250 을 그대로 적용하면 **preset 3 하나만 살아남아** 표본이 1개가 되고, **프리셋 간 교차검증(spread)이 영구히 불가능**해진다. 가중치(`b²` → 0.09/0.13/0.78)가 이미 조건수 나쁜 프리셋을 8배 낮추므로 게이트는 **중복이면서 유해**했다. 제거 후 결과가 오히려 더 좋다(§5). 게이트를 없애도 나쁜 표본의 오염이 <2% 임을 유닛테스트로 고정했다(`poolFovBaseV: 표본 1개 → … / 후보 불일치 → advisory`).

> **부수 효과**: `poolFovBaseV(samples, imgH)` 가 되어 **설계서 §6 의 시그니처와 정확히 일치**하게 됐다.

---

## 5. ★ Unity ground truth 대비 실측 오차 + **정합(alignment) 한계·신규 지표**

`test/groundModelRealData.test.ts` 가 CI 로 고정. 입력은 **동결 픽스처** `test/fixtures/PtzCamRoi.unity.json`(§7).
Unity `camera` 블록은 **이 테스트에서만** 읽는다(프로덕션 추정 경로는 `position`/`eulerAngles`/`fov` **미사용** — C3).

**GT 자체의 불확실성(정직하게 명시)**: 픽스처의 camera 블록은 `eulerAngles=[6.8, 22.0]` 인데 camerapos preset 1 은 `pan=20` 이다(2° 차이) — 저장 시점 카메라가 프리셋에 **정확히** 있지 않았다. 그래서 이 블록에서 역산한 `fovBaseV=32.83`, 런타임 파일 블록(preset 3 자세와 정확히 일치)에서 역산한 값은 `33.17` — **GT 자체가 ~1% 흔들린다.** 우리 추정치 `32.997` 은 두 GT 사이에 있다.

| preset | zoom | GT f | **추정 f** | **f 오차** | GT tilt | **추정 tilt** | **tilt 오차** | 카메라고 d (GT 5.0m) | 깊이변 | conf |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1.6 | 2933 | **2917** | **−0.53%** | 6.8° | **6.84°** | **+0.04°** | **4.96 m** | 213px | 0.84 |
| 2 | 1.9 | 3483 | **3464** | **−0.53%** | 7.4° | **7.51°** | **+0.11°** | **4.99 m** | 344px | 0.97 |
| 3 | 1.4 | 2566 | **2552** | **−0.53%** | 18.8° | **18.71°** | **−0.09°** | **4.94 m** | 614px | 1.00 |

**기준: f ≤5% / tilt ≤1° → 전 프리셋 통과.** 카메라 지상고는 주차면 폭 2.5m 앵커만으로 −0.2%~−1.2% 로 복원.

---

### 5-A. ⚠️ **정정 — `f`/`tilt` 일치는 ROI 정합을 보장하지 않는다**

**이전 판 보고서는 위 표를 '성공'으로 읽히게 썼다. 그것은 절반의 진실이다.** 소실점은 직선의 **방향**에서 나오고, 폴리곤을 통째로 평행이동해도 방향은 변하지 않는다. 실제로 자동보정이 preset 1 ROI 를 **+105px 이동**시켰는데 f/tilt 지표는 만점이었고, 렌더에서만 ROI 가 흰 주차선과 어긋나 보였다.

**실측 (preset 1 ROI 를 강제 평행이동, 공동추정 f 기준)** — `test/roiAlignmentSensitivity.test.ts` 가 CI 로 봉인:

| ROI 어긋남 | Δf | Δtilt | Δd | **metricErr** | **tiltErrDeg** (추정−PTZ) |
|---|---|---|---|---|---|
| 가로 −200px | 0.52% ✗ | 0.035° ✗ | 0.28% ✗ | **0.19 → 2.43%** ✓ | 0.04° ✗ |
| 가로 +105px (실제 발생) | 0.34% ✗ | 0.023° ✗ | 0.16% ✗ | **0.19 → 1.53%** ✓ | 0.02° ✗ |
| 가로 +200px | 0.69% ✗ | 0.047° ✗ | 0.32% ✗ | **0.19 → 2.73%** ✓ | 0.05° ✗ |
| **세로 +200px** | ~0 ✗ | — | — | **0.19 → 0.38%** ✗ **(눈이 멂)** | **−3.86°** ✓ |
| **세로 −200px** | ~0 ✗ | — | — | **0.19 → 0.15%** ✗ **(눈이 멂)** | **+3.88°** ✓ |

**→ `f 오차 0.53%` 는 ROI 정합에 대해 아무것도 말해주지 않는다.** 이 문장을 테스트로 박아뒀다(`★ 한계 봉인` describe).

### 5-B. ★★ 정합 지표 4개 — 그리고 **덮지 못하는 사각지대**(검증자 지적 반영, 정정판)

> **⚠️ 이전 판의 과장을 정정한다.** 이전 판은 "축마다 다른 지표가 민감하다"고 써서 **2축이 정합 공간을 덮는다는 오독**을 불렀다. 그것은 거짓이다.
> **`metricErr` + `tiltErrDeg` 는 상보적이지 않다 — 공통 사각지대가 있다.**
> 두 지표가 실제로 재는 것은 *"이 ROI 가 (PTZ tilt 를 가진) 어떤 카메라로 본 2.5×5.0m 직사각형 스트립의 상인가"* 뿐이다.
> **지면 위 닮음변환(평행이동 2 DOF + 수직축회전 1 + 균일스케일 1 = 4 DOF)은 그 성질을 완전히 보존**하므로 두 지표가 **전혀 움직이지 않는다.**

**실측 (기준 모델로 역투영→지면 변환→재투영해 정확히 구성, preset 1)** — `test/groundSimilarityDetect.test.ts`:

| 변환 | 이미지 평균변위 | metricErr | tiltErrDeg | **d 편차**(신규) | **방위 편차**(신규) |
|---|---|---|---|---|---|
| 기준 | 0px | 0.19% | 0.04° | 0.9% | ~2.3° |
| 이미지 가로이동 +105px *(실제 발생)* | 105px | **1.53%** ✓ | 0.02° ✗ | – | – |
| 이미지 세로이동 200px | 200px | 0.38% ✗ | **3.9°** ✓ | – | – |
| 이미지 회전 10° | **77px** | 0.57% **✗ 놓침** | 0.05° ✗ | – | – |
| **[지면] 평행이동 3m/3m** | **360px** | 0.19% ✗ | 0.04° ✗ | 0% ✗ | 0° ✗ |
| **[지면] 수직축 회전 30°** | 144px | 0.23% ✗ | 0.04° ✗ | 0% ✗ | **30°** ✓ |
| **[지면] 균일스케일 ×2** | **473px** | 0.14% ✗ | 0.03° ✗ | **−50%** ✓ | 0° ✗ |

**신규 지표 2개 — 4 DOF 중 2 DOF 를 닫는다 (신규 입력 0)**

| 지표 | 검출 대상 | 원리 | 임계 |
|---|---|---|---|
| **`dDevRel`** = 카메라고 d 의 프리셋 간 편차 | **지면 균일스케일** | 카메라는 프리셋 사이에 **움직이지 않으므로** `d` 는 프리셋 불변량이어야 한다. `d` 는 metric 스케일의 **유일한 담지자** — 이게 틀리면 육면체 높이가 통째로 틀린다 | **10%** (정상 0.9%, ×2 스케일 → −50%) |
| **`slotBearingDeg` / `bearingDevDeg`** = PTZ pan + 슬롯 azimuth (mod 90) | **지면 수직축 회전** | 같은 주차장이면 스트립 방위는 프리셋 불변량. pan 이 돌면 azimuth 가 반대로 줄어 **합이 불변** | **8°** (정상 ~2.3°, 30° 회전 → 정확히 30°) |

> **⚠️ ②(tiltErrDeg) 와 ④(bearingDevDeg) 는 성질이 다르다 — 혼동 주의.**
> ②는 **절대** 검사다("수평 지면"이라는 세계 기준이 있어 PTZ tilt 와 **직접** 대조 가능). ④는 **상대** 검사다 — 슬롯의 실제 세계 방위를 우리는 모르므로 **PTZ pan 과 직접 대조하는 검사는 성립하지 않는다.** pan 은 프리셋을 **공통 좌표계로 정규화**하는 데만 쓰고, 판정은 프리셋 간 일치로만 한다. (검증자 초안은 "pan 직접 대조"를 제안했으나 성립하지 않음 — 검증자도 §2-6 에서 이를 정정했다.) 따라서 ③④는 **프리셋 1개면 검사 불가**이고, **전 프리셋이 똑같이 틀리면 침묵**한다.

- **C3 준수**: `pan`/`tilt` 는 `camerapos`(카메라 PTZ 리드백)에서 온다 — **실카메라도 주는 값**. Unity 전용 GT 아님. `parseCameraViews` 가 이미 `pan?: number` 를 준다 → **신규 입력·신규 의존 0.**
- 4개 지표 전부 `GroundModel` 에 실려 `GET /capture/ground-model` 로 나가고, 임계 초과 시 advisory 가 붙으며 뷰어 배지에 표시된다.
- **제약**: 두 신규 검사는 **프리셋 간 상대 불일치**만 잡는다. 프리셋이 1개거나(→ advisory) 전 프리셋이 똑같이 틀리면 침묵한다.

### 5-B-1. ❌ **원리적 사각지대 — 지면 위 평행이동(2 DOF)은 검출 불가**

**어떤 지표로도 못 잡는다.** ROI 를 지면에서 밀어도 그것은 여전히 "같은 카메라로 본 직사각형 스트립"이기 때문이다.

> **실질 위험: 지면 평행이동 2.5m = 주차면 정확히 한 칸.** ROI 가 통째로 옆 칸을 덮어도 **4개 지표 전부 침묵**하고, 점유가 옆 칸에 찍힌다. 이것을 지표로 덮은 척하지 않는다 — `test/groundSimilarityDetect.test.ts` 가 이 침묵을 **테스트로 봉인**했다(사각지대를 코드에 명시).

**닫으려면 이미지 증거(노면 도색)와의 직접 대조가 필요하다.** 차량이 주차선을 가리므로 **2단계(빈 배경 median 합성)가 선행 조건**이다. → 후속 단계 필수 항목으로 등록.

**기각한 대안 — ROI 오프셋 *역추정*(격자탐색 argmin)**: 구현·측정까지 해봤으나 **폐기**했다. (a) `f` 와 `dx` 가 강하게 결합돼(105px 이동 ≈ 단독 f 3.9% 변화) **f 오차 0.55% 만으로 dx 추정이 ~15px 편향**되고 탐색 경계까지 발산했다. (b) `dy` 방향은 잔차 지형이 **평평한 골짜기**라 최소점이 정해지지 않는다. → **"확신 있게 틀린 숫자"** 를 내놓게 되므로 검출까지만 하고 정량 역추정은 하지 않는다.

### 5-C. ★ 설계 §4-6 의 '대응 뒤집힘' 은 **실재한다**

| preset | 점 규약대로 A=깊이인가? | 채택된 깊이 변군 | metric 잔차 |
|---|---|---|---|
| 1 | ✅ | `a` | 0.2% |
| **2** | ❌ **아니다** | **`b`** | **0.3%** |
| 3 | ✅ | `a` | 0.0% |

`PtzCamRoi.json` 의 점 순서 규약은 **프리셋마다 균일하지 않다**. `preset 2` 는 p0-p1 이 **폭변(2.5m)** 이다. 설계 §4-2 의 규약(`p0=근좌,p1=원좌…`)을 하드코딩했다면 **preset 2 의 스케일이 조용히 2배 틀렸을 것**이다(육면체 높이가 2배 또는 절반). `buildGroundPlane` 이 **두 배정을 모두 풀고 metric 재구성 오차가 작은 쪽을 채택**하기 때문에 세 프리셋 모두 5m 를 복원한다. → `test/groundModelRealData.test.ts` 의 `expect(family).toEqual(['a','b','a'])` 로 봉인.

### 합성카메라 왕복(σ=1px 노이즈, 100 시행) — 공동추정의 효과
| | preset 1(최악 조건수) | preset 2 | preset 3 |
|---|---|---|---|
| 프리셋 **단독** f 오차(RMS) | 큼 | — | 작음 |
| **공동추정** f 오차(RMS) | **< 3%** | **< 3%** | **< 3%** |
| 개선 | **최악 프리셋에서 2배 이상** (테스트로 고정) | | |

---

## 6. 동작 확인 (sharp 실렌더 — CLAUDE.md 규칙 3)

`data/refframes/cam1_p{1,2,3}.jpg` 실프레임 위에 육면체(보라 12모서리) + 기존 2D 바닥 ROI(초록)를 sharp 로 합성해 육안 확인했다. **3프리셋 전부 통과:**

- ✅ **밑면이 주차면 폴리곤과 일치** (기존 초록 ROI 위에 정확히 앉는다)
- ✅ **수직 모서리가 실제 차량의 수직선(A필러·B필러)과 평행** ← 수직소실점이 맞다는 가장 빠른 증거
- ✅ **h=1.5m 상면이 실제 승용차 지붕 높이에 안착**
- ✅ **preset 1(조건수 최악, 깊이변 213px)에서도 무너지지 않는다** (최우선 관찰 대상 — 공동추정이 구제)
- ✅ 기존 2D 바닥 ROI 렌더가 **그대로 살아 있다**(가산 확인)

렌더 산출물(리더 검증용): `<scratchpad>/cuboid_p1.png`, `cuboid_p2.png`, `cuboid_p3.png`

---

## 7. ★ 테스트 설계 결함 수정 — 런타임 가변 데이터를 픽스처로 삼지 않는다

```
npx tsc -p tsconfig.json --noEmit   → exit 0
npx vitest run                      → 1380 passed / 0 failed  (128 files)   ★ 전량 통과
```

### 근본 원인 (리더 지적대로, 데이터 문제가 아니라 **테스트 설계 결함**이었다)

`data/Place01/PtzCamRoi.json` 은 **git 미추적 런타임 산출물**이다. 사용자가 뷰어에서 주차면을 편집·저장하면 바뀐다 — 그리고 실제로 바뀌었다:

| 무엇이 바뀌었나 | 원인(뷰어 기능) |
|---|---|
| preset 1 좌표 **+105px 이동** | 주차면 자동보정(`applyTranslateScale`) |
| idx **0-based → 전역 1..17 재부여** | `normalizeGlobalIdx` + '저장' |
| preset 2 가 **13,12,…,8 역순** | 사용자 '수정'(수동 전역번호 재지정) |
| `camera` 블록이 **preset 1 자세 → preset 3 자세** | 카메라 포즈 스냅샷(저장 시점 pan/tilt/fov) |

**→ 그 파일을 픽스처로 삼은 테스트는 사용자가 앱을 쓸 때마다 깨진다.**

### 조치 — 동결 픽스처로 전량 이전

**신규 픽스처(커밋 대상)**
- `test/fixtures/PtzCamRoi.unity.json` — Unity 생성 **원형**(`Parking3D/Save/ParkSpaceData/PtzCamRoi.json` 복사): 프리셋별 **0-based idx**, **원본 좌표**(preset1 첫 점 `57.3171`).
- `test/fixtures/camerapos.sample.json` — 프리셋 PTZ 동결(`config/camerapos.json` 도 뷰어에서 편집 가능한 가변 파일이다).

**이전한 테스트 7개 파일** (좌표·idx·면 수를 단정하던 전부)
| 파일 | 비고 |
|---|---|
| `test/normalizePtzCamRoi.test.ts` | 원래 0-based 를 기대하고 쓰여 있었다 → 픽스처가 **원래 의도를 복원** |
| `test/placeRoi.test.ts` | 〃 |
| `test/placeGlobalIdx.test.ts` | 〃 |
| `test/selectFloorRoi.test.ts` | **시뮬레이션으로 새로 발견**(면 수 7/6/4 단정 — 면 삭제 시 깨짐) |
| `test/computeOccupancy.test.ts` | 〃 (사전 예방) |
| `test/globalIdxParity.test.ts` | 〃 (사전 예방) |
| `test/groundModelRealData.test.ts` | **내가 새로 만든 것도 같은 함정이었다** — 리더 지적대로 이전 |
| (+ `groundModelRoutes` / `viewerCuboid`) | 지면모델 신규 테스트 전부 픽스처 기반 |

**런타임 파일에 남긴 것**: `test/placeRoiRuntimeInvariants.test.ts` — **구조 불변식만** 검증(파싱 가능, 4점, 유한좌표, 정규화 후 idx 1..N 고유). **좌표·idx 값은 일절 단정하지 않는다.** 파일 부재 시 skip.

### 검증 — "사용자가 편집해도 안 깨지는가"를 시뮬레이션으로 확인

런타임 파일에 **아핀변환(1.03배 스케일 + (−37,+21) 이동) + 면 1개 삭제 + 전역번호 재부여 + 프리셋 내 순서 뒤집기 + 카메라 포즈 변경**을 한꺼번에 가하고 전체 스위트를 돌렸다:

```
== 사용자 편집 시뮬레이션 적용 ==   →  1380 passed / 0 failed  ✅
== 원본 복원 ==                   →  1380 passed / 0 failed  ✅
```
이 시뮬레이션이 **`selectFloorRoi.test.ts` 의 잠복 결함을 실제로 잡아냈다**(면 수 단정 → 면 삭제 시 파손). 그것까지 고친 뒤 통과.

### 부수 발견 — 런타임 데이터에 화면 밖 좌표

자동보정 +105px 이동의 부작용으로 `preset1 idx7` 의 한 점이 **x=1980 > 1920(이미지 폭)** 으로 프레임을 벗어나 있다. `placeRoiRuntimeInvariants` 가 **경고만** 하고 실패시키지는 않는다 — 사용자가 주차면을 프레임 밖으로 끄는 것은 **정당한 조작**이므로 이를 단정하면 같은 함정을 반복하게 된다. **데이터 정리 필요 여부는 리더 판단 요청.**

---

## 8. 회귀 0 보장 근거

- `#roi-cuboid` **기본 off**. 끄면 `drawCuboidOverlay` 가 첫 줄에서 return → **기존 렌더와 픽셀 동일**.
- 육면체 레이어는 `app.js` 의 `drawDetectOverlay` 뒤 · `if (state.roiHidden || !state.mapping) return;` **앞**에 삽입(설계 §1-3) → 산출물 없이도(수집 중/파일 모드) 그려지고, **기존 2D 바닥 ROI 를 대체하지 않고 가산**.
- 기존 함수 시그니처 변경 0 / 기존 렌더 경로 변경 0 / `PtzCamRoi.json`·DB 스키마 변경 0.
- `ground.enabled=false` → 라우트 404 → 뷰어는 조용히 미표시(킬스위치).
- 서버 라우트는 `placeRoiFile` + `ground` **둘 다 주입될 때만** 등록(가산 패턴).

---

## 9. 강등 철학 준수 (throw 금지)

| 퇴화 | 처리 |
|---|---|
| 비볼록/자기교차(bowtie)·거의 선분·미소면적(<400px²) quad | `isUsableQuad` 기각 → 추정 표본 제외 |
| f² ≤ 0 (직교 제약 위반) | `focalFromVPs` → **null** (NaN 전파 0) |
| 무한원 소실점(w≈0) | `focalFromVPs` → null. **단 `buildGroundPlane` 은 정상 동작**(K⁻¹ 은 무한원 소실점도 처리) |
| 전 프리셋 f 실패 / zoom 미상 | 공동추정 skip → 프리셋 단독 f 로 **강등 + advisory** |
| 지평선 위 / 법선 퇴화 / 스케일 불가 | `buildGroundPlane` → null → **그 프리셋 모델 없음 = 육면체 미표시** |
| 뷰어: 지면모델 없음 / 지평선 위 점 | `projectCuboid` → null → **그 면만 skip**, 프리셋당 1회 `console.warn` |
| camerapos 파일 부재 | 200 + zoom 미상 강등(기각 아님) |

**"조용히 틀린 육면체보다 안 그리는 게 낫다"** 를 전 경로에 적용. 모든 강등은 `issues[]` 로 배지 tooltip 에 노출된다.

---

## 10. 미검증 · 남은 위험

| # | 항목 | 상태 |
|---|---|---|
| **0** | **★ 지면 평행이동 = 주차면 한 칸(2.5m) — 4개 지표 전부 침묵(원리적 사각지대)** | ❌ **미해결.** 점유가 통째로 옆 칸에 찍힐 수 있다. **2단계(빈 배경 median) 없이는 원리적으로 검출 불가** — §5-B-1. **후속 단계 최우선 항목.** 지표로 덮은 척하지 않고 테스트로 봉인만 해뒀다 |
| 1 | **라이브 프레임 정합 (ROI ↔ 실제 노면 도색)** | ❌ **미검증 — 통과로 위장하지 않는다.** Unity 시뮬레이터(13100)가 꺼져 있어 리더·검증자 모두 확인하지 못했다. §5-B 의 지표들은 *기하학적 일관성*을 재는 **간접** 지표다 |
| 2 | **브라우저 실동작(슬라이더 드래그·토글·배지)** | ❌ **미검증**. 순수함수·라우트·sharp 렌더는 검증했으나 실제 DOM 이벤트는 수동 확인 필요 |
| 3 | **GT 자체의 불확실성 ~1%** | 픽스처 camera 블록이 프리셋 자세와 2° 어긋나 있다(§5). f 오차 −0.53% 는 이 불확실성보다 작다 — **더 정밀한 GT 를 원하면 카메라를 프리셋에 정확히 두고 재저장 필요** |
| 4 | **광각 실카메라 배럴왜곡** | 미검증(설계 R8). 현 데이터는 망원이라 무영향. 실카메라 도입 시 재평가 |
| 5 | **주점=중심 가정** | 위반 시 f 계통오차 + **§5-B 의 가로 정합 지표가 오작동**(주점 이동 ≡ ROI 평행이동이므로 구별 불가). 실카메라 도입 시 재평가 |
| 6 | **다중 카메라** | `models[].f` 는 카메라별로 정확하나 응답 최상위 `fovBaseV` 는 마지막 카메라 값(배지·디버그용). 현 데이터는 1대 — 실해 없으나 인지 필요 |
| 7 | **경사 주차장** | 탐지만(`metricErr > 5%` → advisory). 다중평면 미지원(설계 R9, 범위 밖) |
| 8 | `slot_spec.json` / 점유판정 seam | **손대지 않음**(1단계 범위 밖 — 설계 §10·§11-1) |

---

## 11. 검증자·문서화 전달 사항

- **검증자**: `npx vitest run` **1380/1380 전량 통과**, `tsc --noEmit` exit 0.
  - **런타임 데이터에 의존하는 값 단정 테스트는 이제 0개다.** 새 테스트를 쓸 때 `data/Place01/*` 를 픽스처로 삼지 말 것 — `test/fixtures/PtzCamRoi.unity.json` 을 쓸 것.
  - 미검증 영역은 §10 의 #1·#2 **둘뿐**이며, 둘 다 **통과로 위장하지 않았다**.
- **문서화**:
  - `GroundModel` 이 2~5단계의 **합류점 인터페이스**(`source: 'file' | 'auto'`).
  - **설계서 §6 갱신 필요**: (a) 이탈 2건(§4 — `H` → `(f,n,d)`, 게이트 제거), (b) **신규 필드 4종**(`ptzTiltDeg`/`tiltErrDeg`/`slotBearingDeg`+`bearingDevDeg`/`dDevRel`).
  - **§5-A·§5-B-1 은 문서에 반드시 남길 것**: "f/tilt 일치 ≠ ROI 정합", 그리고 **"경보 없음 ≠ 정합"**(지면 평행이동 사각지대). 이걸 모르면 다음 사람이 또 지표 통과를 정합 성공으로 오독한다.
  - **설계서 §10(점유 seam) 에 경고 추가**: 지면 평행이동 사각지대가 열려 있는 한, 지면모델로 점유 seam 을 닫아도 **ROI 자체가 옆 칸이면 여전히 틀린다.**

---

## 12. 검증자(qa-cuboid) 지적 반영 결과

| # | 지적 | 조치 |
|---|---|---|
| **1** | **[최상위]** `metricErr`+`tiltErrDeg` 는 상보적이지 않다 — 지면 닮음변환 4 DOF 를 전부 놓친다 | ✅ **수용.** 독립 재현했다(지면 3m/3m = 이미지 360px 인데 두 지표 불변). **(a) 과장 정정**: `groundModel.ts` 의 "≳60px 어긋남을 잡는다" 주석을 **"순수 이미지 평행이동에만 성립"** 으로 정정하고 반례(이미지 회전 10° = 77px 를 놓침)를 명기. 보고서 §5-B 전면 재작성. 뷰어 배지 tooltip 에 한계 상시 표시. **(b) 신규 검출기 2개 구현**: `dDevRel`(균일스케일) · `bearingDevDeg`(수직축회전) — 둘 다 프리셋 불변량 대조, **신규 입력 0**. `test/groundSimilarityDetect.test.ts`(10 테스트)로 검출력 + **남은 사각지대(지면 평행이동)** 를 함께 봉인 |
| **2** | 공동추정이 통합 경로에서 무방비(M6 뮤테이션 생존) | ✅ **수용.** 로직은 옳으나 **테스트 커버리지 구멍**이 맞다 — 내 `groundModelRoundTrip` 은 `poolFovBaseV` 를 직접 호출해 **진입점이 그것을 쓰는지**를 검증하지 못했고, `estimateGroundModels` 를 부르는 테스트는 σ=0 이라 두 경로가 구별되지 않았다. 검증자의 `test/groundModelPoolingIntegration.test.ts` 로 봉인됨. **코드 수정 불필요**(신규 필수 필드 `pan` 때문에 해당 파일에 `pan: null` 1줄만 추가) |
| **3** | `detectPipeline.ts:78` 이 프로덕션에서 `camera.fov` 를 읽는다 | ⚠️ **확인. 내 변경 범위 밖 — 손대지 않았다.** 지면모델 경로는 C3 완전 준수지만, *"프로덕션이 Unity camera 블록을 읽지 않는다"* 는 **프로젝트 전체로는 거짓**이라는 지적이 맞다. 해당 코드는 폴백을 갖고 있다(파일 없으면 상수). **리더 판단 사항으로 상신** |

---

# §13. [2차 작업] C3 위반 해소 + 프레임 밖 좌표 감사

> 리더 지시 2건. (문서 §1~§12 는 1단계 육면체 작업 — 그대로 유효.)
> 게이트: `npx tsc --noEmit` **exit 0**, `npx vitest run` **131 files / 1411 tests 전량 통과**(기존 1403 + 신규 8).

## 13-1. ★★ 과제 1 — C3 위반은 "호환성 문제"가 아니라 **실제 수치 버그**였다

### 발견: `camera.fov` 는 base FOV 가 아니다

`FovOpts.fovBaseV` 의 정의는 **zoom=1 기준 수직 FOV**다. 그런데 `PtzCamRoi.json` 의 `camera.fov` 는
**저장 시점 카메라의 현재 fov 스냅샷**이다 — 그 파일은 preset3(zoom=1.4) 자세에서 저장됐고 `fov=24.017°` 는
**zoom 1.4 에서의 fov**다. 즉 **줌이 걸린 fov 를 base 로 오인**해 왔다. (`detectMath.ts:14` 주석이
*"fovBaseV = PtzCamRoi.json camera.fov"* 라고 **틀리게** 적혀 있던 것이 원인 — 그 주석도 정정했다.)

### 라이브 Unity 실측으로 확정 (추측 아님)

시뮬레이터(**13110 `/rpc`** — 13100 REST 는 죽었고 `RpcCameraClient` 경로가 살아 있다)를 직접 구동해
**pan 을 2° 돌리고 중앙부 픽셀 이동량을 ZNCC 로 측정** → `f = s/(Δ·cos(tilt))` 로 초점거리를 직접 잰다.

| preset | zoom | **라이브 실측 f** | 변경 전 f (`camera.fov`) | **변경 후 f (지면모델)** |
|---|---|---|---|---|
| 1 | 1.6 | 2900 px | 4062 px (**+40%**) | **2907 px (0%)** |
| 2 | 1.9 | 3511 px | 4823 px (**+37%**) | **3452 px (−2%)** |
| 3 | 1.4 | 2508 px | 3554 px (**+42%**) | **2544 px (+1%)** |

`fovBaseV`: **24.017° → 33.102°**(런타임 데이터 공동추정). 라이브 실측 ≈33°, 설계서 GT 역산 33.167° — **3자 일치.**

### 검출 동작 변화 — **종단 실측** (리더 판단 필요 사항)

라이브 카메라에서 `vehicleCenterZoomPtz` 를 실제로 돌려(타깃을 화면 중심으로 당기는 PTZ 계산 → 실촬영 →
타깃이 실제로 어디 찍혔는지 ZNCC 로 측정) **재중심 잔차**를 쟀다:

| fovBaseV | 재중심 후 타깃의 중심 이탈(평균, 3지점) |
|---|---|
| 24.017 (변경 전) | **154 px** (폭의 8.0%) — 항상 **~30% 미달** |
| 33.102 (변경 후) | **45 px** (폭의 2.4%) — **3.4배 개선** |

**→ 동작이 유의미하게 바뀐다(지시대로 보고).** 다만 방향은 **명백한 개선**이며 라이브 실측이 근거다.
잔여 45px 은 `vehicleCenterZoomPtz` 의 **선형 FOV 근사**(tan 대신 각도 선형) + pan 의 `cos(tilt)` 미보정에서
온다 — **이번 범위 밖이라 손대지 않았다**(별도 항목으로 등록 권고).

### 구현 (최소 변경)

| 파일 | 변경 |
|---|---|
| `src/capture/detectPipeline.ts` | `cm.fov` 읽기 **삭제**. `estimateFovBaseV()` 신설 — 지면모델 `estimateGroundModels().fovBaseV` 재사용(추정 수학 **신규 0줄**). `loadDetectCfg(placeRoiFile, camId, sources?)` 3번째 인자 추가(선택 — 하위호환) |
| `src/api/captureRoutes.ts` | `/capture/detect` 가 `{ cameraposFile, ground }` 주입 (유일한 호출처) |
| `src/calibrate/detectMath.ts` | `FovOpts.fovBaseV` 주석 정정(**버그의 근원** — "camera.fov 가 아니다") |
| `test/detectPipeline.test.ts` | C3 봉인 테스트 **8개** 추가 |

- **입력은 실카메라도 주는 것뿐**: 주차면 4점(이미지 픽셀) + `camerapos` zoom 리드백. `position`/`eulerAngles`/`fov` **미사용**.
- **강등(throw 금지)**: 추정 실패(소실점 실패 / zoom 미상 / camerapos 없음 / ground 미주입 / 주차면 0개) → **폴백 상수 24.017 + advisory 로그**.
- **전수 확인**: `SettingAgent/src` · `ActionAgent/src` · `DMAgent/src` · `packages` 에서 `camera.fov`/`eulerAngles`/`position` **읽기 0건**(주석만 잔존). 테스트의 GT 사용은 지시대로 **유지**.

### ⚠️ 남은 함정 — 폴백 상수 자체가 틀린 값이다

`FALLBACK_FOV_BASE_V = 24.017` 은 **지금 우리가 틀렸다고 밝힌 바로 그 값**이다(zoom 1.4 의 fov).
지시("추정 실패 시 **기존** 폴백 상수로 강등")대로 **그대로 뒀다**. 추정이 실패하면 검출은 다시 154px 오차로 돌아간다.
→ **리더 판단 요청**: 폴백을 실측 기반(≈33.1°)으로 바꿀지. (바꾸면 폴백 경로도 개선되나, "기존 동작 보존"이 깨진다.)

## 13-2. 과제 2 — 프레임 밖 좌표 감사 (리더 지시대로 **데이터 무수정**)

리더의 라이브 검증 결론(**자동보정 +105px 가 옳고, 현재 런타임 데이터가 정답**)을 접수. **`PtzCamRoi.json` 손대지 않았다.**
독립 확인: preset1 만 원본 대비 **dx=+105.0 / dy=0.0 순수 평행이동**, preset2·3 은 원본과 **완전 동일**(좌표 기준).

프레임 밖 점: **`preset1 idx7` 의 4번째 점 하나뿐** — `x=1980.2 > 1920`(60.2px 초과, y 는 정상). 다른 프리셋엔 없다.

### 시스템이 이 점을 어떻게 다루는가 — **3개 다 문제없다**

| # | 질문 | 실측 답 |
|---|---|---|
| 1 | `normalizePtzCamRoi` 의 `좌표 범위 이탈` 경보 | ⚠️ **거짓 경보 맞다.** 단 **면은 유지되고 클램프도 드롭도 없다**(`placeRoi.ts:73` 은 무조건 push) → 정규화 x = **1.0313** 그대로 보존. **동작을 게이팅하지 않는다**(전수 확인: issues 는 **advisory 전용**, 분기 0건). 노출은 **브라우저 콘솔 `console.warn` 뿐**(`app.js:378-381`) — **UI 표시 없음** → 사용자 오해 유발 가능성 **사실상 0**, 개발자에겐 노이즈 |
| 2 | 지면모델 **오염** | ✅ **오염 없다**(이론대로 — 프레임 밖 점도 기하학적으로 **유효한 투영점**). idx7 포함/제외 비교: `fovBaseV` 차이 **0.0104°(0.03%)**, `f` **≤2px(0.06%)**, `tilt` **≤0.01°**, `d` **≤1mm**. 오히려 **포함이 유리**(preset1 `conf` 0.676 → **0.722**) |
| 3 | 육면체 렌더 파손 | ✅ **안 깨진다.** `projectCuboid`(`core.js:1316-1338`)에 **0..1 바운드 가드가 없다** — 유한성·지평선만 본다. idx7 → corners 8 / edges 12 **전부 유한**, x 범위 [0.785, **1.035**] → 캔버스 밖은 **canvas 가 자연 클립**. 대조군(프레임 안 idx1)과 동일하게 정상 |

### 최소 수정안 (거짓 경보 — **리더 승인 없이 적용 안 함**)

- **옵션 A(권고)**: `placeRoi.ts:72` 문구만 정정 — `좌표 범위 이탈` → `좌표 프레임 밖(정상일 수 있음)`. **1줄, 동작 변화 0.** 신호는 남기고 오해만 제거.
- **옵션 B**: 바운드 검사 삭제, 비유한(`NaN`/`Infinity`)만 경보. → 진짜 손상된 대좌표를 놓친다. **비권고.**
- **옵션 C**: 현행 유지. 콘솔 전용이라 실해가 없다. **허용 가능.**

---

## 13-3. [리더 승인 2건 적용] 폴백 상수 정정 + advisory 문구

게이트: `npx tsc --noEmit` **exit 0** / `npx vitest run` **131 files / 1412 tests 전량 통과**(기준 1403 → **+9**).

### 승인 1 — `FALLBACK_FOV_BASE_V` : 24.017 → **33.1**

**값 선정 근거 = 독립 3자 일치**(코드 주석에도 동일 기록):

| 출처 | 값 | 성격 |
|---|---|---|
| ① 라이브 실측(pan 2° 회전 → ZNCC, 프리셋 줌대역 1.4~1.9) | **32.6~33.5°** | 카메라에서 직접 측정 |
| ② 지면모델 공동추정(`poolFovBaseV`, 실데이터) | **33.102°** | 이미지 점에서 추정 |
| ③ 설계서 GT(`camera.fov`=24.01697 @ zoom 1.4 역산) | **33.167°** | 파일에서 역산 |

세 값이 서로 **≤1.7% 내에서 일치** → 그 중앙 **33.1** 채택.
**설정(`tools.config.json`)으로 빼지 않았다** — 이건 운영자가 튜닝할 값이 아니라 *추정 실패 시의 마지막 방어선*이고,
설정화하면 "틀린 값을 넣을 자유"를 다시 여는 셈이다(CLAUDE.md 규칙 2 — 요청 이상의 설정 가능성 금지).

**폴백 사용을 항상 드러낸다**: 기존엔 `placeRoiFile` 미설정 시 **로그 없이** 조용히 폴백했다(이 버그가 숨은 경로).
이제 **모든 폴백 경로**가 `reason` 과 함께 `logger.warn` 을 남긴다 — 실측 확인:
`{"reason":"placeRoiFile 미설정","fovBaseV":33.1,"msg":"fovBaseV 폴백 상수로 강등 — 재중심/역투영 정확도 저하 가능"}`

### ⚠️ 폴백 변경이 바꾼 테스트 — **무엇을 지키던 테스트였나**

| 테스트 | 이전 기대 | 변경 | 그 테스트가 지키던 것 |
|---|---|---|---|
| `detectPipeline` 폴백 3건 | `24.017` | `33.1` | **폴백 경로가 상수를 낸다**(값 자체는 부수적) |
| `placeRoi` 범위이탈 1건 | `'좌표 범위 이탈'` | `'좌표 프레임 밖(정상일 수 있음)'` | **① issue 발생 ② 면이 드롭되지 않고 byPreset 에 기록됨** — 문구는 부수적이었다 |

**★ 검출력 손실 1건 발견·보강**: 폴백(33.1)이 추정치(≈33.0)와 **거의 같아져서 값만으로 두 경로를 구별할 수 없게 됐다.**
(폴백이 24.017 이던 시절엔 값 차이가 곧 구별이었다.) → 검출력을 **구조적 단언**으로 옮겼다:
- 추정 경로는 `estimateGroundModels().fovBaseV` 와 **소수 9자리까지 동일**해야 한다 → 조용히 폴백(33.1)으로 떨어지면 깨진다.
- `not.toBeCloseTo(FALLBACK_FOV, 2)` 로 "폴백이 아니라 추정이 쓰였다"를 명시 단언.
- **신규 회귀 테스트**: 폴백이 24.017 로 되돌아가면 실패(그 값이 왜 틀린지 주석에 실측 수치와 함께 기록).

### 승인 2 — advisory 문구 (`placeRoi.ts:72`)

`좌표 범위 이탈` → **`좌표 프레임 밖(정상일 수 있음)`**. 동작 변화 0.
함께 **클램프 금지 불변식을 테스트로 봉인**했다(문구가 기대는 사실이므로): 정규화 x=2.0 이 **1 로 잘리지 않음**.
잘리면 지면모델·육면체가 조용히 왜곡된다 — 프레임 밖 점도 **유효한 투영점**이다.

---

## 13-4. 후속 과제 등록 (이번에 **구현하지 않음** — 리더 지시)

| # | 항목 | 사실 | 근본 해법 |
|---|---|---|---|
| **F-1** | `vehicleCenterZoomPtz` 의 **선형 FOV 근사 + pan 의 `cos(tilt)` 미보정** | fovBaseV 를 고친 뒤에도 재중심 잔차 **45px** 이 남는다(라이브 실측). 각도↔픽셀을 tan 이 아니라 **선형**으로 근사하고, 월드 수직축 pan 이 화면에서 `cos(tilt)` 배로 나타나는 것을 무시한다 | 정확한 핀홀 역산으로 교체(`atan` + `cos(tilt)` 보정). 45px → ~0 예상 |
| **F-2** | **자동보정(translate+scale)의 원근 잔차** — 리더 라이브 확인 | `preset1` 의 `metricErr 1.53%` 는 **오경보가 아니다**. 자동보정은 **이동+스케일만** 하는데(`회전·원근 미보정`) **pan 변화는 평행이동이 아니라 호모그래피**다. 보정된 ROI 는 눈으로는 주차선에 맞지만 정확한 원근 투영이 아니며, 그 잔차(**≈4cm**)를 `metricErr` 가 정확히 집어냈다 | **Unity 에서 현재 자세로 ROI 재추출**, 또는 자동보정을 **호모그래피 기반**으로 교체 |

> **F-2 의 함의**: `metricErr` 는 **작동하는 지표**임이 실증됐다(1.53% = 실재하는 4cm 원근 잔차). 잡음이 아니다.

---

## 13-5. ★ "Unity 시뮬 미가동" 은 **오진이다** — 라이브 검증은 가능하다 (팀 공통 함정)

02 §10 #1 · 04 §4 #1 · 03(검증자 이번 라운드) 이 모두 *"시뮬레이터 미가동 → 라이브 검증 불가"* 로 적었다.
**전부 오진이다.** 시뮬은 **켜져 있었다**(`Parking3D.exe` PID 31608). 두 가지가 겹쳐 죽은 것처럼 보인다:

| 함정 | 사실 |
|---|---|
| **① IPv6 전용 바인딩** | `[::1]:13110` 에만 LISTEN 한다. **`127.0.0.1` 로 찌르면 연결 실패**, `localhost` 로 찌르면 붙는다 |
| **② REST 는 죽었다** | `/health`·`/req_img`·`/req_move`·`/cameras` → `알 수 없는 엔드포인트`. 살아있는 건 **`POST /rpc`** (JSON-RPC) |
| ③ 13100 | 아무것도 없다(포트 자체가 안 열려 있음). `RpcCameraClient` 주석의 *"죽은 13100 REST"* 가 정확하다 |

**재현 레시피(검증자·문서화 공통)**:
```bash
curl -s -X POST http://localhost:13110/rpc -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"system.ping"}'          # → {"result":{}}
# 촬영: cam.setPTZ{camId,pan,tilt,zoom} → cam.captureJPG{camId} → result.img_bytes(base64 JPEG)
```
⚠️ **`CameraClient`(REST) 의 `health()` 는 거짓 양성이다** — 13110 이 `/health` 에 `{"ok":true}` 를 주므로
헬스는 통과하지만 `/req_img` 는 404 다. **라이브 확인은 반드시 `/rpc` 로 하라.**

→ **이 함정 때문에 팀 전체가 "라이브 정합 미검증" 을 3라운드째 이월해 왔다.** 이제 그럴 이유가 없다.
