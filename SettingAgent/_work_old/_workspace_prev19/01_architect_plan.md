# 주차면 셋업 자동화 로드맵 + 3D 육면체 렌더 — 아키텍처 설계

작성: 설계자(architect) / 대상: SettingAgent
**코드 수정 없음 — 설계·계획만.** 모든 주장은 소스 인용 또는 실데이터 실측으로 뒷받침한다.

> **요약 (먼저 읽을 것)**
> 1. **정밀수집은 프레임 원본을 보존하지 않는다**(메모리 Map 1장/프리셋, 매 라운드 덮어씀). 배경 median 합성은 **신규 프레임 영속화가 선행 조건**이다.
> 2. **지면 모델은 지금 당장, 새 데이터 0으로 만들 수 있다.** 기존 `PtzCamRoi.json` 만으로 소실점 기반 캘리브레이션을 실행해 **f 오차 ±3%, tilt 오차 ±0.3°** 를 실측 확인했다(Unity `camera` 블록 대조). → **1단계 = 파일 경로 육면체. SAM·median·LLM·시간누적 전부 불필요.**
> 3. **f 를 프리셋별로 독립 추정하면 안 된다.** 실측: σ=2px 노이즈에서 preset1 오차 **35.4%**. 카메라당 `fovBaseV` 하나를 **프리셋 공동 추정**하면 **1.7%** (20배 개선). 이것이 마스터가 지시한 "다수를 묶어 공동 추정"의 **올바른 축**이다(면(slot)을 묶는 게 아니라 **프리셋(zoom)을 묶는다**).
> 4. **마스터 전제 1건 정정**: `selectFloorRoi({useLlm})` 는 `#cap-floor-llm` 과 배선돼 있지 않다(§1.2). 효과는 동일하나 기전이 다르다 — 구현자가 오해하면 안 되므로 명시한다.

---

## 1. 현황 실측

### 1-1. 정밀수집은 프레임 원본을 보존하는가 → **아니다 (배경합성 가능 여부의 분기점)**

| 무엇이 남는가 | 어디에 | 근거 |
|---|---|---|
| 관측 메타(pan/tilt/zoom/`img_name`) | SQLite `observation` | `SqliteStore.ts:44-49` — 컬럼은 `pan REAL, tilt REAL, zoom REAL, img_name TEXT`. **BLOB 컬럼 없음** |
| 검출 박스(정규화 좌표) | SQLite `detection` | `SqliteStore.ts:50-57` |
| **JPEG 원본** | **메모리에만. 매 라운드 덮어씀** | `CaptureJob.ts:270-271` |

```ts
// CaptureJob.ts:270-271 — 라운드마다 같은 키를 덮어쓴다. 이력 없음.
this.lastFrame = { jpeg: cap.jpg, camIdx: t.camIdx, presetIdx: t.presetIdx, roundIdx };
this.lastFrameByPreset.set(`${t.camIdx}:${t.presetIdx}`, cap.jpg);
```
`lastFrameByPreset` 선언은 `CaptureJob.ts:82` (`Map<string, Buffer>`), 소비처는 체크포인트의 `FloorRoiReviewer`/`OccupancyReviewer` 뿐이다(`CaptureJob.ts:350-369`). `insertObservation` 은 `imgName` **문자열만** 적재한다(`CaptureJob.ts:272-282`, `SqliteStore.ts:168-186`).

**결론: 배경 median 합성(수단 2)은 "프레임 N장 보존" 이라는 신규 인프라가 없으면 불가능하다.** 다만 밑자락은 이미 깔려 있다:
- **선례**: `data/refframes/cam{c}_p{p}.jpg` 를 디스크에 쓰는 코드가 이미 있다 — `captureRoutes.ts:395-396` (`await writeFile(path, img.jpg)`), 자동보정 기준 프레임용.
- **미사용 설정**: `store.captureDir: 'data/captures'` 가 `toolsConfig.ts:264` 에 정의돼 있으나 **`src/` 전체에서 참조 0건**(데드 설정). 프레임 영속화의 자연스러운 자리다.
- **`sharp` 는 이미 서버 의존성**이다(`package.json:29`), 그레이스케일·리사이즈·raw 픽셀 추출까지 이미 사용 중(`captureRoutes.ts:80`: `sharp(jpg).greyscale().resize(w,h,{fit:'fill'}).raw().toBuffer()`). **median 합성에 새 의존성 0.**
- **`frameAlign.ts`**(113줄, 이동+스케일 정합 순수수학)가 이미 있다 — 라운드 간 PTZ 미세드리프트 보정에 재사용 가능.

### 1-2. `web/core.js` 재사용 가능 순수함수 + **좌표계 변환 지점**

| 함수 | 위치 | 좌표계 | 재사용 판단 |
|---|---|---|---|
| `normalizePtzCamRoi` | `core.js:364-409` | **픽셀 → 0..1** (`p.x / W, p.y / H`, `:401`) | 서버 쌍둥이 `placeRoi.ts:32-81` 존재. 파리티 테스트로 봉인됨 |
| `normalizeGlobalIdx` | `core.js:515-533` | 무관 | 서버 쌍둥이 `placeRoi.ts:90-110`. **`test/globalIdxParity.test.ts` 로 고정** |
| `buildFlatSlotRows` | `core.js:574-606` | 0..1 | 전역목록 표 |
| `computeOccupancy` | `core.js:454-463` | 0..1 | **C6 — 이번 범위 밖** |
| `pointInQuad` | `core.js:635-645` | 0..1 | ray casting, N각형 지원. 그대로 재사용 |
| `toPixel` / `toPixelQuad` | `core.js:11-13` / `19-21` | **0..1 → 표시 픽셀** | 육면체 12모서리 렌더에 그대로 재사용 |
| `selectFloorRoi` | `core.js:419-431` | 0..1 | §1.2-B 참조 |

**정규화 vs 픽셀의 경계는 정확히 두 곳이다:**
1. **입력단**: `normalizePtzCamRoi` 가 `imageWidth/imageHeight`(파일에 기록된 **원본 센서 크기** 1920×1080)로 나눠 0..1 로 만든다(`core.js:401`).
2. **출력단**: 그리기 직전 `overlay.width/height`(**브라우저 표시 크기**, `app.js:254-255`)를 곱한다.

> **호모그래피를 어느 좌표계에서 풀 것인가 → 답: 원본 픽셀(1920×1080) 좌표계. 서버에서.**
> **근거**: (a) 카메라 내부파라미터 `f`·주점은 **센서 픽셀** 단위로만 물리적 의미를 가진다. 0..1 정규화 좌표는 x/y 축의 스케일이 서로 달라(1920 vs 1080) **정사각 픽셀 가정이 깨지고**, 주점=중심·직교 제약이 성립하지 않는다. (b) `overlay.width` 는 브라우저 창 크기에 따라 변하므로(리사이즈마다 `app.js:254`) 캘리브레이션의 기준이 될 수 없다. (c) `PtzCamRoi.json` 이 이미 원본 픽셀을 담고 있고 `imageWidth/imageHeight` 도 함께 준다 — 변환 없이 바로 쓸 수 있다.
> → **지면모델은 원본 픽셀에서 풀고, 산출물(투영된 육면체 8점)만 0..1 로 내보낸다.** 뷰어는 기존대로 `toPixelQuad(quad, overlay.width, overlay.height)` 로 표시만 한다. **뷰어의 좌표 규약은 무변경.**

### 1-3. `web/app.js` 오버레이 렌더 경로 — 삽입 지점 특정

- **캔버스는 단 하나** (`index.html:49-54`: `<img id="frame">` + `<canvas id="overlay">`). `app.css:283` 주석이 계약을 못박음: *"letterbox 오차 방지: img 자체 크기에 canvas 일치. object-fit 미사용."*
- **캔버스 크기**: 매 draw 마다 재설정 — `app.js:254-255` `overlay.width = frame.clientWidth; overlay.height = frame.clientHeight;` (backing store = CSS px, 1:1, devicePixelRatio 미적용).
- **루트 진입점** `drawRoiOverlay()` (`app.js:253-306`). **rAF/interval 렌더루프 없음** — 명령형 호출(34개 호출처) + `ResizeObserver`(`app.js:2589-2591`).
- **레이어 디스패치와 결정적 가드**:
```js
// app.js:258-262
updateLogicOccupancy();
drawOccupancyOverlay(ctx);
drawFileFloorRoi(ctx);
drawDetectOverlay(ctx);
if (state.roiHidden || !state.mapping) return;   // ← 262: 이 아래는 mapping(산출물) 전용
```
> **육면체 레이어는 `app.js:261` 뒤, `:262` 가드 앞에 삽입해야 한다.** 그래야 `setup_artifact` 없이(=정밀수집 중/파일 모드에서) 그려진다.
- **모든 draw 는 `overlay.width/height` 를 곱한다** — `toPixel`/`toPixelQuad` 경유(`app.js:272, 284, 294, 378, 427, 448, 458`), 유일한 직접 곱셈은 `app.js:348-349`.
- **`eventToNorm`** (`app.js:570-576`) — 분모는 **CSS rect**(`overlay.getBoundingClientRect()`), `overlay.width` 가 아니다. 현재는 `app.js:254` 때문에 수치가 같다.
- **토글 리스너 블록** = `app.js:2514-2519` (신규 토글의 정확한 배선 지점).
- **`<input type="range">` 는 프로젝트 전체에 0건.** 슬라이더는 신규 패턴. 다만 **연속 드래그 → 즉시 재그리기 선례**가 있다: `wirePanelResize()`(`app.js:2244-2272`)가 드래그 틱마다 `drawRoiOverlay()` 호출(`app.js:2240`) + `localStorage` 영속(`'sv.panelWidth'`, `app.js:2235`). 높이 슬라이더는 이 패턴을 그대로 복제한다.

#### ⚠️ 1.2-B. **마스터 전제 정정 — `selectFloorRoi({useLlm})` 는 `#cap-floor-llm` 과 배선돼 있지 않다**

마스터 지시문의 전제("선례: `selectFloorRoi({useLlm})` 와 `#cap-floor-llm` 체크박스로 파일 ROI vs LLM ROI 를 토글한다")는 **효과는 맞지만 기전이 다르다.** 실측:

- `selectFloorRoi` 의 **호출처는 2곳뿐이고 둘 다 `useLlm: false` 하드코딩**이다 — `app.js:325`, `app.js:370`.
- `#cap-floor-llm` 은 대신 **두 렌더러의 상호배타 조기반환 게이트**로 작동한다:
  - `app.js:368` (`drawFileFloorRoi` 내부): `if ($('cap-floor-llm').checked) return;` → LLM 모드면 파일 바닥 숨김
  - `app.js:293` (`drawRoiOverlay` 슬롯 루프): `if (fquad && showFloor && $('cap-floor-llm').checked)` → LLM 모드에서만 슬롯별 floor
- 따라서 `selectFloorRoi` 의 `useLlm:true` 분기(`core.js:420-427`)는 **뷰어 관점에서 데드코드**다.

**설계 영향**: 확장할 패턴은 *"체크박스 → draw 함수 내 조기반환 게이트 + `app.js:2514-2519` 리스너"* 다. 이 패턴은 그대로 유효하며 새 개념을 발명할 필요 없다(C1 준수). **구현자는 `selectFloorRoi` 에 `useLlm` 을 넘기면 동작할 것이라 가정하지 말 것.** (데드코드 제거는 요청 범위 밖 — 언급만 하고 삭제하지 않는다. CLAUDE.md 규칙 3.)

### 1-4. `src/calibrate/detectMath.ts` — **부분 재사용. 반은 정확하고 반은 근사다.**

자체 주석이 한계를 명시한다:
```
detectMath.ts:6 — [실측 한계] 역투영은 지면 원근으로 y축 계통 오차(~10~12%)가 남는 근사
```
그런데 **이 파일은 두 가지 다른 것을 담고 있고, 품질이 정반대다:**

| 부분 | 위치 | 판정 | 근거 |
|---|---|---|---|
| **FOV↔zoom 법칙** `fovV`/`fovH` | `:31-38` | ✅ **정확 — 반드시 재사용** | Unity `camera.fov` 를 **소수점 5자리까지 왕복 복원**(아래 실측) |
| **역투영** `inverseProjectPoint` | `:62-74` | ❌ **재사용 금지 — 대체 대상** | 지면을 무시한 "중심고정 FOV 선형" 근사. 10~12% 계통오차의 근원 |

**FOV 법칙 검증(실측)**: `PtzCamRoi.json` 의 `camera.fov = 24.01697`, `eulerAngles = [18.8, 43.5, ~0]`. `camerapos.json` 의 preset 3 은 `pan=43.5, tilt=18.8, zoom=1.4` → **camera 블록은 preset 3 의 자세다**(eulerAngles.x=tilt, .y=pan). `fovV` 공식(`detectMath.ts:32`)으로 역산하면 `fovBaseV = 33.1666°`, 이를 다시 대입하면 `fovV(1.4) = 24.01697` — **파일값과 완전 일치**. → **`fovV` 는 Unity 카메라 모델과 수학적으로 동일하다.**

> **판단: 신규 지면모델은 `fovV`/`fovH`(zoom→FOV 법칙)를 **import 재사용**하고, `inverseProjectPoint` 는 **재사용하지 않는다**(호모그래피가 그 역할을 정확하게 대체). 중복 구현 위험은 이 분리로 해소된다 — 새 FOV 공식을 쓰지 않으므로 `test/detectMath.test.ts` 와 이중구현이 생기지 않는다.

### 1-5. `src/clients/` — SAM 을 **선택 의존**으로 붙일 자리

`VpdClient`/`LpdClient` 는 동일한 7단 패턴이다(`VpdClient.ts:8-76`). `detect()` 시그니처:
```ts
// VpdClient.ts:43-50
async detect(image: Buffer): Promise<VehicleBox[]> {
  const { width, height } = readJpegSize(image);
  return withRetry(() => this.detectOnce(image, width, height),
    (err) => (err instanceof VpdApiError ? isRetryable(err.httpStatus) : true),
    { maxRetries: this.cfg.maxRetries, sleep: this.sleep });
}
```
설정 스키마는 `VpdSchema`/`LpdSchema`(`toolsConfig.ts:18-36`) — `{endpoint, detPath, apiKeyEnv?, timeoutMs, maxRetries}`.
**선택 의존의 기존 선례**: `CaptureJob` 의 `lpd?: LpdClient` + `lpdEnabled: boolean`(`CaptureJob.ts:23, 33-34`) → 사용처 게이트 `if (this.deps.lpdEnabled && this.deps.lpd)`(`CaptureJob.ts:295`). **SAM 은 이 패턴을 글자 그대로 복제한다.**

### 1-6. `src/brain/` — LLM 검수/분류를 붙일 자리

`SetupBrain` 인터페이스(`SetupBrain.ts:200-217`)는 **모든 비전 메서드가 optional(`?`)이고 실패 시 `null` 반환**이 계약이다(`:199`). 신규 메서드 추가 절차는 확립돼 있다:
1. `config/prompts/<name>.yaml` — **최상위 키는 `system`/`user` 둘뿐**(`floor_roi.yaml:5,24`). 스키마는 YAML 이 아니라 `SetupBrain.ts` 의 zod 에 있다.
2. `llmConfig.ts` 에 `{enabled, prompt, timeoutMs}` 블록 추가(`OccupancySchema`, `llmConfig.ts:83-89` 미러) — **`loadLlmConfig` 의 섹션 병합 라인 추가 필수**(`llmConfig.ts:224-227`). 빠뜨리면 사용자 설정이 조용히 무시된다.
3. `AgentRuntime` 에 게이트(`!this.client || this.cfg.<블록>?.enabled !== true`) → `prepareGroundingImage`(`AgentRuntime.ts:364-373`) → `chatJson`(`:380-400`, 2회 재시도 후 null).
4. Reviewer 클래스(`FloorRoiReviewer`/`OccupancyReviewer`)의 `llmUnavailable` 관용구를 복제: `const llmUnavailable = !usable || (attempted > 0 && succeeded === 0);` (`FloorRoiReviewer.ts:98`).

**중요한 정책 차이(설계에 반영)**: `FloorRoiReviewer` 는 LLM 실패 시에도 **항상 결정형 폴백 폴리곤을 쓴다**(`:93`). `OccupancyReviewer` 는 **아무것도 쓰지 않는다**(`:47, 60-61`). → 신규 "주차면 후보 검수/분류" 는 **후자(쓰지 않음)** 가 맞다. 자동 발견은 **틀리느니 비워두는 게 낫다**(§12 최상위 위험).

### 1-7. **지면모델·자동발견 로직은 뷰어인가 서버인가 → 서버. 단 렌더는 뷰어.**

| 기능 | 배치 | 근거 |
|---|---|---|
| 배경 median 합성 | **서버** | 프레임 수십~수백 장 + `sharp`(Node 전용). 브라우저 불가 |
| 시간 누적 히트맵 | **서버** | SQLite `detection` 이 이미 서버에 있다(`getDetectionsForRun`, `SqliteStore.ts:214`) |
| SAM / LLM 호출 | **서버** | REST 클라이언트·API 키 |
| **지면모델 추정**(f, H, 수직소실점) | **서버** | 입력(파일 ROI 또는 자동 후보)이 전부 서버에 있고, 프리셋 공동추정(§4)은 전 프리셋을 한 번에 봐야 한다 |
| **육면체 투영·렌더** | **뷰어** | 슬라이더로 높이 h 를 실시간 조절해야 함(C4). 서버 왕복은 UX 파탄 |

> **이중구현 회피 설계**: 서버가 **지면모델(프리셋당 숫자 몇 개)** 을 산출·영속화하고 `GET` 으로 노출한다. 뷰어는 **추정을 절대 하지 않고**, 받은 모델로 **투영만** 한다(`projectCuboid`, 순수함수 ~40줄).
> → `normalizeGlobalIdx` 때처럼 **같은 규칙을 두 언어로 구현하는 상황 자체가 발생하지 않는다.** 파리티 테스트가 필요 없다(있는 게 아니라, **필요 없게 설계**한다). 이것이 `test/globalIdxParity.test.ts` 전례에서 얻을 올바른 교훈이다 — 파리티 테스트는 이중구현의 **치료제**지 **면허**가 아니다.

---

## 2. 목표 아키텍처 1장

```
┌─────────────────────────── 서버 (Node/TS) ────────────────────────────┐
│                                                                        │
│  [기본 경로 — 회귀 0, 플래그 불필요]                                    │
│   PtzCamRoi.json ──▶ normalizePtzCamRoi ──▶ 프리셋별 4점 폴리곤 ──┐     │
│   (placeRoi.ts:32)                          (원본 픽셀 1920×1080) │     │
│                                                                   │     │
│  [자동 경로 — tools.config 플래그로 옵트인]                        │     │
│   정밀수집 관측 ──┬──▶ ①시간누적 히트맵(detection 테이블)          │     │
│   (CaptureJob)    ├──▶ ②배경 median 합성 ─▶ 주차선 검출  ──┬──▶ 후보 폴리곤
│   ※프레임 영속화  ├──▶ ③SAM 접지선(선택 의존, 미가동시 강등)  │     │     │
│     신규 필요!    └──▶ ④번호판 metric 앵커 ────────────────┘     │     │
│                                    │                              │     │
│                          ⑤LLM 검수·규격분류(set-of-mark)          │     │
│                                    │                              │     │
│                                    ▼                              ▼     │
│              ╔═══════════════════════════════════════════════════════╗ │
│              ║   ★ 합류점: GroundModel 인터페이스 (프리셋당)          ║ │
│              ║   { f, H(3×3), vertVP, horizon, conf, source }        ║ │
│              ║   ─ 두 경로가 여기서 만나고, 이후 코드는 출처를 모른다 ─ ║ │
│              ╚═══════════════════════════════════════════════════════╝ │
│                                    │                                    │
│                   GET /capture/ground-model  ──────────────────────────┼──┐
└────────────────────────────────────────────────────────────────────────┘  │
                                                                            │
┌─────────────────────────── 뷰어 (브라우저) ───────────────────────────────┼──┘
│  core.js (순수):  projectCuboid(quad, groundModel, h) → 8점 + 12모서리     │
│  app.js:261:      drawCuboidOverlay(ctx)   ← 신규 레이어(가산, 기존 대체 X) │
│  index.html:44:   [x] 육면체  [높이 h ═══◯═══ 1.5m]  (슬라이더)            │
│  소스 배지:        "지면모델: 파일(PtzCamRoi) | 자동(관측)  신뢰도 92%"    │
└────────────────────────────────────────────────────────────────────────────┘
```

**소유 경계(결정형 도구 vs LLM 두뇌)**

| 결정형 도구(코드) | LLM 두뇌 |
|---|---|
| 소실점·f·호모그래피 추정, 육면체 8점 투영 | 자동 생성 후보의 **검수**("3번은 주차면이 아니라 통로다") |
| 히트맵 봉우리 탐지, median 합성, 주차선 검출 | **규격 타입 분류**(표준/도로변/장애인/경차/EV) — 아이콘·색·글자 인식 |
| SAM 마스크 하단경계 → 접지선 | 라운드 간 이상 상황 서술 |
| 번호판 → metric 스케일 | ❌ **좌표 생성 금지**(VLM grounding 취약 — set-of-mark 로 "몇 번?"만 묻는다) |

이는 기존 불변식과 정확히 일치한다: *"좌표는 검출 멤버 중앙값으로만 산출(LLM 미개입 — 좌표 불변식 §0-4)"* (`Aggregator.ts:44`).

---

## 3. 단계별 로드맵

**정렬 원칙**: 싸고 즉시 가치 있는 것부터. **각 단계는 독립 출시 가능**하고, **앞 단계가 뒷 단계의 전제**가 되도록 배치했다.

---

### **1단계 — 파일 경로 육면체 렌더 (지면모델 v1)** 🥇 최우선

**왜 1등인가**: 아래 §4 에서 **실데이터로 증명**하듯, 기존 `PtzCamRoi.json` **하나만으로** 지면모델이 완성된다. **신규 데이터 수집 0, SAM 0, LLM 0, median 0, 시간누적 0.** 그러면서 (a) 마스터가 요구한 육면체를 즉시 내놓고, (b) **2~5단계 전부가 의존하는 `GroundModel` 인터페이스와 검증 하네스를 먼저 세운다.** 자동 경로를 먼저 지으면 검증할 기준(ground truth)이 없어 "조용히 틀림"을 잡을 수 없다.

- **얻는 것**: 프리셋별 지면모델 + 3D 육면체 오버레이 + 높이 슬라이더. **주차면 규격을 가정 아닌 측정으로 산출**(§4-5).
- **의존**: 없음(기존 파일만).
- **사람 작업 감소**: 0 (아직). **이 단계는 자동화의 *기반*이지 자동화 자체가 아니다** — 정직하게 밝힌다. 대신 즉시 얻는 것: 육면체 시각화 + "내 ROI가 기하학적으로 말이 되는가"를 검증하는 눈(잔차·신뢰도 advisory).
- **검증**: §8 합성카메라 왕복 + §9 Unity `camera` 블록 수치대조(이미 통과 확인 — f ±3%, tilt ±0.3°).
- **난이도**: **중하**. 신규 순수함수 3개 + 서버 라우트 1개 + 뷰어 레이어 1개 + 슬라이더 1개. 새 외부 의존 0.

---

### **2단계 — 프레임 영속화 + 배경 median 합성** 🥈

**왜 2등인가**: §1-1 에서 확인했듯 이것이 **자동 경로 전체의 물리적 전제**다(현재 프레임이 안 남는다). 그리고 median 배경은 **주차선을 드러내 1·3·5단계 모두를 이롭게 하는 공용 자산**이다.

- **얻는 것**: 프리셋별 "차량이 지워진 빈 주차장 바닥" 이미지. 주차선(흰 도색)이 선명해진다.
- **의존**: 1단계 불필요(병렬 가능). 단 `store.captureDir`(현재 데드) 활성화 + `frameAlign.ts` 로 라운드 간 드리프트 보정.
- **사람 작업 감소**: 0 (직접적으론). 하지만 3단계의 입력.
- **검증**: median 배경에 대해 VPD 를 돌려 **차량 검출 0건**이면 배경 합성 성공(강력하고 값싼 자동 검증). sharp 렌더로 육안 확인.
- **난이도**: **중**. 저장 정책(링버퍼 N장/프리셋)·디스크 예산이 실질 설계 포인트. **트레이드오프 명시: 셋업이 "즉시"에서 "시간~일 단위"가 된다**(§12).

---

### **3단계 — 자동 후보 발견 (히트맵 ⊕ 주차선) + LLM 검수** 🥉

**왜 3등**: 여기서 **처음으로 사람 작업이 실제로 줄어든다**(ROI 를 직접 그리지 않아도 된다 = 에이전트의 존재 이유).

- **얻는 것**: 관측만으로 주차면 후보 폴리곤 자동 생성. **상보 융합**: 시간누적(차가 서는 자리) ∪ 주차선(차가 안 서는 자리) → 커버리지를 서로 메움.
- **의존**: 2단계(median 배경). 1단계(지면모델)가 있으면 **후보를 지면에서 직사각형으로 스냅**할 수 있어 품질이 급상승 → **1·2단계 후에 하는 게 맞다.**
- **사람 작업 감소**: **큼** — ROI 수작업 → 후보 검수(체크박스)로 격하.
- **검증**: 자동 후보 vs 기존 `PtzCamRoi.json`(사람이 그린 정답)의 IoU. **17개 면이 이미 정답으로 있다** — 값싼 정량 지표.
- **난이도**: **상**. 조용히 틀릴 위험 최상위 → 신뢰도·advisory·검수 UI 가 **기능의 일부**(§12).

---

### **4단계 — 규격 메타데이터(`slot_spec.json`) + LLM 타입 분류**

- **얻는 것**: 면별 규격(표준/도로변/장애인/경차/EV) 자동 태깅. 지면모델 실측치(폭·깊이 m)와 LLM 아이콘·색 인식의 결합.
- **의존**: 1단계(metric 실측), 3단계(후보) — 단 **파일 경로만으로도 독립 출시 가능**(기존 17면에 타입 붙이기).
- **사람 작업 감소**: **중** — 규격 수동 입력 제거.
- **난이도**: **중**. 전역인덱스 재부여 위험 완화가 핵심(§7).

---

### **5단계 — SAM 접지선(선택 의존)**

- **왜 마지막**: **가장 비싸고(신규 REST 서비스) 가장 대체 가능하다.** VPD rect 하단 근사로 강등해도 1~4단계가 전부 동작한다. 마스터도 "필수 의존이 아니라 선택 의존" 이라 못박았다.
- **얻는 것**: VPD 의 axis-aligned rect 로는 알 수 없는 **정확한 접지선** → 차량 접지사각형 정밀화 → 지면모델의 **차량 기반 캘리브레이션**(주차면 규격 없이도) 가능.
- **의존**: 없음(어디에나 가산). 미가동 시 VPD rect 하단으로 강등(`lpdEnabled` 패턴).
- **난이도**: **중**(클라이언트 자체는 `VpdClient` 복제로 쉬움). 진짜 비용은 **SAM 서비스 운영**.

> **로드맵 전체를 한 번에 짓지 말 것.** 1단계만으로도 독립 출시 가능하고, 마스터가 요구한 육면체는 1단계에서 완결된다. **2~5단계는 1단계 결과를 보고 재평가할 것을 권한다**(§11).

---

## 4. 지면 모델 수학 — **실데이터로 검증 완료**

### 4-1. 입력 (실카메라가 줄 수 있는 것만)

C3 준수: `camera.position`/`eulerAngles`/`fov` 를 **프로덕션 경로에서 쓰지 않는다**. 쓰는 것은:
- **이미지 위의 점** (파일 ROI 4점 또는 자동 후보 4점 또는 차량 접지사각형)
- **알려진/측정된 metric 길이** 1개 (주차면 폭 또는 번호판 규격)
- **zoom** (카메라가 알려줌)

### 4-2. 알고리즘 — 2-소실점 캘리브레이션

주차면 사각형은 지면 위에서 **두 직교 방향**의 변을 가진다. 실데이터 확인: **인접 주차면이 정점을 공유한다**(`idx1.points[3] == idx2.points[0]`, `idx1.points[2] == idx2.points[1]` — 7면 전체가 연속 스트립). 점 규약은 `p0=근좌, p1=원좌, p2=원우, p3=근우`.

```
1) 두 직선군:
   깊이선 D = { line(p0,p1), line(p3,p2) } (전 면)   ← 근→원 방향
   폭선   W = { line(p0,p3), line(p1,p2) } (전 면)   ← 면 진행 방향
2) 최소제곱 소실점:  v1 = VP(D),  v2 = VP(W)     (동차 직선 l = p×q, 교점 = l1×l2)
3) 직교 제약(주점=중심 c, 정사각픽셀, 무왜곡):
        (v1 − c) · (v2 − c) + f² = 0
   →    f = sqrt( −(v1−c)·(v2−c) )
4) 지평선 h = v1 × v2   →   지면 법선 n = K⁻ᵀ h  →  수직 소실점 vVP = K·n
5) metric 스케일: 알려진 길이 1개(주차면 폭 2.5m 또는 번호판 규격)로 H 의 스케일 고정
6) 지면 호모그래피 H = K[r1 r2 t]  (r1,r2 = 두 지면 방향, t = 원점)
```

### 4-3. ★ 실측 결과 (`data/Place01/PtzCamRoi.json`, Unity `camera` 블록을 ground truth 로)

Unity GT: `fovBaseV = 33.1666°` (camera.fov=24.01697 @ preset3 zoom=1.4 에서 `detectMath.fovV` 로 역산, 왕복 오차 0).

| preset | zoom | GT f (px) | **추정 f (이미지점만)** | **f 오차** | GT tilt | **추정 tilt** | **tilt 오차** |
|---|---|---|---|---|---|---|---|
| 1 | 1.6 | 2901 | 2819 | **−2.83 %** | 6.8° | 7.07° | **0.27°** |
| 2 | 1.9 | 3445 | 3518 | **+2.11 %** | 7.4° | 7.40° | **0.00°** |
| 3 | 1.4 | 2539 | 2539 | **−0.00 %** | 18.8° | 18.80° | **0.00°** |

**→ 프로덕션 경로(Unity 블록 미사용)가 f 를 ±3%, tilt 를 ±0.3° 로 복원한다. 지면모델은 성립한다.**

### 4-4. ★★ 결정적 발견 — **f 는 프리셋별로 추정하면 안 된다**

픽셀 노이즈 σ 를 주입해 300회 시행한 결과(전 면 사용):

| | preset 1 (깊이변 199px) | preset 2 (271px) | preset 3 (620px) |
|---|---|---|---|
| σ=0.5px | 7.3 % | 1.7 % | 0.4 % |
| σ=1px | **16.0 %** | 4.5 % | 0.8 % |
| σ=2px | **35.4 %** | 15.8 % | 1.7 % |

**preset 1 은 σ=2px 에서 f 오차 35%** — 육면체가 완전히 무너진다. 원인은 **투영단축**: preset1 은 tilt 가 6.8° 로 얕아 5m 깊이가 **199px** 로 뭉개진다(preset3 은 620px). 깊이선의 baseline 이 짧으니 소실점이 불안정하다.

**또한: 같은 프리셋 안에서 면을 더 많이 묶어도 전혀 개선되지 않는다**(1면 → 7면, f 값 동일). 연속 스트립의 면들은 **같은 두 소실점을 공유**하므로 독립 정보가 늘지 않기 때문이다.

> **→ 마스터의 "다수를 묶어 로버스트 공동 추정" 지시는 옳다. 단, 묶을 축은 *면(slot)* 이 아니라 *프리셋(zoom)* 이다.**
> PTZ 카메라의 f 는 **zoom 만의 함수**다. 카메라당 `fovBaseV` **단 하나**를 전 프리셋에서 공동 추정하고, 각 프리셋 f 는 `fovV(zoom_i, fovBaseV)`(`detectMath.ts:31-33` 재사용)로 **유도**한다. 조건수 좋은 프리셋이 나쁜 프리셋을 **구제**한다.

**검증(σ 노이즈, 300회 · 깊이변 최장 프리셋으로 `fovBaseV` 고정 후 전 프리셋 전파):**

| | preset 1 | preset 2 | preset 3 |
|---|---|---|---|
| σ=1px | 16.0 % → **0.8 %** | 4.5 % → **0.8 %** | 0.8 % → 0.8 % |
| σ=2px | 35.4 % → **1.7 %** | 15.8 % → **1.7 %** | 1.7 % → 1.7 % |

**preset 1 에서 20배 개선.** 이것이 지면모델 설계의 핵심 결정이다.

**조건수 지표(무료)**: **깊이변의 픽셀 길이 중앙값**. 199 / 271 / 620px 이 오차 순위와 정확히 일치한다. → **신뢰도 점수·가중치·advisory 의 근거로 그대로 사용**한다.

### 4-5. metric 실측 (가정이 아니라 측정)

Unity GT 로 17면 전부를 지면(y=0)에 역투영한 결과:

| preset | 면 | 실측 크기 |
|---|---|---|
| 1 | idx 1–7 | **2.57–2.58 × 5.01–5.02 m** |
| 2 | idx 8–13 | **2.55–2.57 × 5.10–5.13 m** |
| 3 | idx 14–17 | **2.53 × 5.05 m** |

→ 전 17면이 **≈2.5 × 5.0 m** 로 수렴. **주차면 규격을 가정하지 않고 측정으로 확인했다.** (§7 의 규격 기본값 표는 이 실측과 정합한다.)

### 4-6. 퇴화 케이스 방어

| 퇴화 | 증상 | 방어 |
|---|---|---|
| **깊이변이 너무 짧음**(얕은 tilt) | f 오차 폭발(실측 35%) | **공동추정으로 우회**(§4-4). 단일 프리셋 추정 결과는 **채택 금지**. 깊이변 중앙값 < 임계(예 250px) → `conf` 강등 + advisory |
| **소실점이 무한원**(두 변이 이미지에서 평행) | `v = l1×l2` 의 w≈0 → 발산 | 동차좌표로 유지(정규화 나눗셈 금지). `\|w\| < ε` 면 해당 방향은 **정사영으로 강등**하고 `conf` 하향 |
| **f² ≤ 0** (직교 제약 위반) | sqrt(음수) → NaN | **NaN 을 절대 전파하지 말 것.** `f²≤0` 이면 그 프리셋 추정 **기각** → 공동추정 표본에서 제외 → 다른 프리셋의 `fovBaseV` 로 유도 |
| **4점 대응 뒤집힘** | 호모그래피 붕괴 | **실제로 겪은 함정**: 투영단축 때문에 *픽셀상 짧은 변*이 *metric 상 긴 변*(5m)이다. 픽셀 길이로 폭/깊이를 판정하면 **틀린다.** → 두 대응을 모두 풀고 `f²>0` + 재투영오차 최소인 쪽 채택 |
| **비볼록/자기교차 4점** | 면적 음수 | `polygon.ts:60 polygonSignedArea` + `convexHull`(`polygon.ts:19`) 재사용 — **이미 있다** |
| **면이 너무 작음 / 거의 선분** | 조건수 붕괴 | 최소 면적·최소 변길이 게이트 → 추정 표본 제외 |
| **경사로(지면 비평면)** | 단일 H 로 표현 불가 | **가정 위반. 탐지만 하고 포기**: 면별 재투영 잔차가 크면 advisory("경사 의심"). 다중 평면은 범위 밖 |
| **광각 배럴왜곡** | 직선이 곡선 → 소실점 편향 | 현 데이터는 망원(fov 24°)이라 영향 미미. 광각 실카메라 도입 시 **재평가 필요**(위험 등록부) |
| **주점 오프셋** | f 편향 | 주점=중심 가정. 위반 시 f 에 계통오차. 현 실측 ±3% 안에 포함됨 |

---

## 5. 플래그·UI 설계 (C1 — 두 경로 공존)

### 5-1. 플래그 위치

```jsonc
// config/tools.config.json — 신규 섹션(기본값은 전부 "현행 동작")
"ground": {
  "enabled": true,          // 지면모델 산출(파일 경로). 기본 on — 회귀 없음(순수 가산)
  "autoDiscover": false,    // ★ 자동 경로 마스터 스위치. 기본 false = 현행 100% 동일
  "minDepthEdgePx": 250,    // 조건수 게이트(§4-6)
  "plateWidthM": 0.335,     // 번호판 metric 앵커 — ※규격 미확정, 설정값. 아래 주의 참조
  "plateHeightM": 0.155
},
"sam": {                    // 선택 의존(§1-5). 미설정 시 클라이언트 미주입 = 강등
  "endpoint": "http://127.0.0.1:9083",
  "detPath": "/sam/api/v1/segment",
  "timeoutMs": 8000, "maxRetries": 3, "enabled": false
}
```
> ⚠️ **번호판 규격은 확신하지 못한다.** 한국 번호판은 규격이 여러 종(구형/신형, 승용/대형)이라 **단정하지 않는다.** 위 값은 **플레이스홀더 기본값이며 반드시 실측·확인 후 확정**해야 한다. 스케일 앵커로 쓰기 전에 **주차면 폭(2.5m, §4-5 에서 실측 확인됨)을 1순위 앵커**로 삼고, 번호판은 **보조·교차검증용**으로 쓰는 것을 권한다. — *미해결 사항 Q3*

### 5-2. 뷰어 UI — **어느 소스가 표시 중인지 항상 안다**

`index.html:39-47` `.roi-toggles` 에 가산(기존 토글 옆):
```html
<label><input type="checkbox" id="roi-cuboid" /> 육면체</label>
<label class="field compact">높이 <input type="range" id="cuboid-h"
       min="0.5" max="3.0" step="0.05" value="1.5" /><span id="cuboid-h-val">1.5m</span></label>
```
**소스 배지(필수)** — 캔버스 상단 또는 `.roi-toggles` 우측에 **항상 표시**:
```
[지면모델: 파일(PtzCamRoi)]  f=2819px  tilt=7.1°  신뢰도 ●●●○ 
[지면모델: 자동(관측 132라운드)]  f=2790px  신뢰도 ●●○○  ⚠ 검수 필요
[지면모델: 없음]  ← 추정 실패/퇴화. 육면체 렌더 안 함(빈 화면 아님 — 기존 2D ROI 는 그대로)
```
- 색상 구분: 파일=기존 색 유지, 자동=구분색(예: 점선 테두리) → **한눈에 출처가 보인다.**
- **회귀 0 보장**: `#roi-cuboid` 기본 **off**. 끄면 기존 렌더와 **픽셀 동일**. 기존 2D 바닥 ROI 렌더는 **대체하지 않고 가산**(C4).

### 5-3. 배선 (기존 패턴 그대로)
- 마크업: `index.html:44` (`.roi-toggles` 내, `#det-delete` 앞)
- 리스너: `app.js:2519` 뒤 — `$('roi-cuboid').addEventListener('change', drawRoiOverlay);`
- 슬라이더: `$('cuboid-h').addEventListener('input', () => { $('cuboid-h-val').textContent = ...; drawRoiOverlay(); });` — `wirePanelResize`(`app.js:2244-2272`)의 연속 재그리기 선례와 동일. 값은 `localStorage`(`'sv.cuboidH'`)에 영속(`app.js:2235` 패턴).
- 레이어: `drawCuboidOverlay(ctx)` 를 **`app.js:261` 뒤, `:262` 가드 앞**에 삽입(§1-3).

---

## 6. 신규 순수함수 시그니처 + 배치

### 서버 — `src/ground/groundModel.ts` (신규, 순수·IO 비의존)

```ts
/** 프리셋 지면모델. 원본 픽셀(imgW×imgH) 좌표계 기준. */
export interface GroundModel {
  camIdx: number; presetIdx: number;
  imgW: number; imgH: number;
  f: number;                    // 초점거리(px)
  H: number[][];                // 3×3 지면(metric m) → 이미지(px) 호모그래피
  vertVP: [number, number, number] | null;  // 수직 소실점(동차, 무한원 가능)
  conf: number;                 // 0~1 신뢰도(깊이변 픽셀길이·재투영잔차 기반)
  source: 'file' | 'auto';      // ★ UI 배지의 근거
  issues: string[];             // advisory(placeRoiReport 패턴 — placeRoi.ts:14-19)
}

/** 이미지 4점 사각형들 → 두 직교 소실점. 무한원 소실점은 동차로 유지(w≈0). */
export function estimateGroundVPs(quads: PixelQuad[]): { v1: Hom2; v2: Hom2; depthEdgePx: number };

/** 직교 소실점 제약으로 f 추정. f²≤0 이면 null(기각 — NaN 전파 금지, §4-6). */
export function focalFromVPs(v1: Hom2, v2: Hom2, cx: number, cy: number): number | null;

/**
 * ★ 카메라당 fovBaseV 공동 추정(§4-4 — 설계의 핵심).
 * 프리셋별 f 후보를 조건수(depthEdgePx)로 가중해 로버스트 합의 → fovBaseV 하나 산출.
 * 각 프리셋 f 는 detectMath.fovV(zoom, {fovBaseV, zoomRef:1, aspect}) 로 유도한다(재사용, §1-4).
 */
export function poolFovBaseV(
  samples: Array<{ zoom: number; f: number | null; depthEdgePx: number }>,
  imgH: number,
): { fovBaseV: number; conf: number; issues: string[] } | null;

/** f + 소실점 + 알려진 metric 길이 1개 → 지면 호모그래피 H. 대응 뒤집힘은 내부에서 양쪽 시도(§4-6). */
export function buildGroundHomography(
  quad: PixelQuad, f: number, knownWidthM: number, knownDepthM: number, cx: number, cy: number,
): { H: number[][]; reprojErrPx: number } | null;
```

### 뷰어 — `web/core.js` (순수, 추정 없음 — **투영만**)

```js
/**
 * 바닥 quad(정규화 0..1) + 지면모델 + 높이 h(m) → 육면체 8점·12모서리(정규화 0..1).
 * 서버 GroundModel 을 그대로 받아 투영만 한다(뷰어는 추정하지 않는다 — §1-7 이중구현 회피).
 * 지면모델 없음/퇴화 → null (호출측이 렌더 skip. 기존 2D ROI 는 영향 없음).
 * @returns { corners: [{x,y}×8], edges: [[i,j]×12] } | null
 */
export function projectCuboid(floorQuad, groundModel, heightM) { … }
```
> 렌더는 기존 `toPixelQuad(pts, overlay.width, overlay.height)`(`core.js:19-21`)로 그대로 픽셀화한다. **뷰어 좌표 규약 무변경.**

### 서버 라우트 (`src/api/captureRoutes.ts` 에 가산)
```
GET /capture/ground-model            → { models: GroundModel[] }   (전 프리셋)
```
기존 `GET /capture/place-roi`(`captureRoutes.ts:340`) 바로 옆에 둔다 — 뷰어 `loadPlaceRoi()`(`app.js:396-420`)와 같은 시점에 1회 로드.

---

## 7. `slot_spec.json` 스키마 + 전역인덱스 재부여 위험 완화

### 7-1. 왜 별도 파일인가 (스키마 무변경 — C5)

`PtzCamRoi.json` 에 필드를 추가하면 **서버가 저장 시 지운다**:
```ts
// placeRoi.ts:139-142 — applyPlaceRoiUpdate 는 parking_spaces 를 {idx, points} 로만 재구성
const parking_spaces = (update.spaces ?? []).map((sp) => ({
  idx: sp.idx,
  points: (sp.points ?? []).map((p) => [p.x * W, p.y * H]),
}));
```
추가 필드는 **PUT `/capture/place-roi` 한 번에 전부 소실**한다. + Unity 재생성 시에도 소실. → **별도 파일이 유일한 답.**

### 7-2. 스키마 — `data/Place01/slot_spec.json`

```jsonc
{
  "version": 1,
  "sourceFile": "Place01/PtzCamRoi.json",
  "specs": [
    {
      "globalIdx": 1,                    // ★ 키 = PtzCamRoi.parking_spaces[].idx (파일 전체 고유 1..N)
      "fingerprint": "1:1#a3f2c1",       // ★ 재부여 위험 완화(§7-3)
      "type": "standard",                // standard|parallel|disabled|compact|ev  (LLM 분류 or 수동)
      "typeSource": "llm",               // llm|manual|default  ← 출처를 항상 안다
      "typeConf": 0.86,
      "measured": { "widthM": 2.57, "depthM": 5.01, "conf": 0.92 },  // ★ 지면모델 실측(가정 아님)
      "updatedAt": "2026-07-14T…"
    }
  ]
}
```

**규격 기본값 표 — 전부 "기본값(수정 가능)". 법령 수치를 확신 없이 단정하지 않는다.**

| type | 기본 폭×깊이 (m) | 비고 |
|---|---|---|
| `standard` | 2.5 × 5.0 | **§4-5 에서 실측 확인**(2.53–2.58 × 5.01–5.13) |
| `parallel` | 2.0 × 6.0 | 도로변 평행주차 — **미검증, 기본값** |
| `disabled` | 3.3 × 5.0 | 장애인 — **미검증, 기본값**(폭이 넓은 것은 확실) |
| `compact` | 2.0 × 3.6 | 경차 — **미검증, 기본값** |
| `ev` | 2.5 × 5.0 | 충전소 — 규격은 표준과 같고 **도색·아이콘으로 구분** |

> 이 표의 `standard` 외 수치는 **확신하지 못한다.** config 로 빼고 "기본값(수정 가능)"으로 표기하며, **자동 경로에서는 이 표를 신뢰하지 말고 `measured` 를 우선**한다. — *미해결 사항 Q4*

### 7-3. ★ 전역인덱스 재부여 위험 완화 (핵심 위험)

**위험**: Unity 가 `PtzCamRoi.json` 을 재생성 → `normalizeGlobalIdx`(`placeRoi.ts:90-110`, `core.js:515-533`)가 **1..N 을 재부여** → `slot_spec.json` 의 `globalIdx` 키가 **다른 면을 가리킨다**(조용한 오귀속). 실제로 `buildFlatSlotRows`(`core.js:588-591`)에 이미 같은 종류의 사고를 막는 방어가 있다:
> *"구 run(0-based {0..6})은 신 전역번호({1..7})와 부분만 겹쳐 한 칸 시프트된 값을 진짜처럼 표시하므로 통째 기각"*

**완화책 (3중 방어)**:

1. **`fingerprint` = 기하 지문** (1차 방어). `sha1(camIdx:presetIdx + 폴리곤 중심 좌표를 소수 3자리로 양자화)` 의 앞 6자. **전역번호가 재부여돼도 폴리곤이 그대로면 지문은 불변** → 지문으로 재매칭한다.
   - 로드 시: `globalIdx` 로 찾고 → **지문 대조**. 불일치면 **지문으로 재검색**해 `globalIdx` 를 자동 교정 + advisory.
   - 지문도 못 찾으면(폴리곤이 실제로 바뀜) → **그 spec 을 기각**(추측해서 붙이지 않는다).
2. **전량 검증 게이트** (2차). `buildFlatSlotRows` 의 "통째 기각" 철학 복제: spec 의 지문 집합이 파일의 지문 집합과 **매칭률 < 임계(예 80%)** 이면 **`slot_spec.json` 전체를 기각**하고 사용자에게 재확인 요구. **부분 오귀속보다 전체 미적용이 안전하다.**
3. **파리티 테스트** (3차). `test/slotSpecRebind.test.ts` — Unity 재생성 시뮬레이션(0-based 리셋, 면 삽입/삭제, 순서 뒤바뀜)에서 지문 재바인딩이 옳은 면을 찾는지. `test/globalIdxParity.test.ts`(118줄) 를 템플릿으로.

---

## 8. 유닛테스트 계획

**필수 — 합성 카메라 왕복 검증**(마스터 지시):
```
test/groundModelRoundTrip.test.ts
  1. 알려진 K(f=2900, 주점=중심), R(tilt=7°/19°, pan 임의), t(높이 5m) 를 정한다.
  2. 지면 위 2.5×5.0m 직사각형 N개(스트립)를 정의 → K[R|t] 로 투영 → 정답 이미지 4점 생성.
  3. 그 이미지점만 estimateGroundVPs → focalFromVPs → buildGroundHomography 에 넣는다.
  4. 검증: 복원 f ≈ 2900 (±1%), 복원 tilt ≈ 원래 tilt (±0.5°),
           지면 역투영 크기 ≈ 2.5×5.0m (±2%).   ← K/R/t 왕복 복원
```
추가 케이스:
| 테스트 | 검증 |
|---|---|
| `poolFovBaseV` 공동추정 | 조건수 나쁜 프리셋 1개 + 좋은 프리셋 1개 → **나쁜 쪽 f 오차가 개선**되는지(§4-4 재현) |
| 노이즈 강건성 | σ=1px 주입 → 공동추정 f 오차 < 3% (실측 0.8% 근거) |
| **퇴화 방어** | f²≤0 → `null` 반환(**NaN 전파 0**) / 무한원 소실점 → 발산 없음 / 비볼록 4점 → 기각 / 면적 0 → 기각 |
| **4점 대응 뒤집힘** | 폭·깊이를 바꿔 넣어도 올바른 H 채택(§4-6 실제 함정) |
| `projectCuboid`(뷰어) | h=0 → 바닥 quad 와 상면 일치 / h 증가 → 상면이 **수직소실점 방향**으로 이동 / 지면모델 null → `null` 반환 |
| **실데이터 회귀** | `data/Place01/PtzCamRoi.json` → f 추정이 Unity GT 대비 ±5% 이내(§4-3 고정) |
| **회귀 0 보장** | `#roi-cuboid` off 시 `drawRoiOverlay` 출력이 기존과 동일(기존 스냅샷 테스트 유지) |
| `slot_spec` 재바인딩 | §7-3 |

기존 테스트 174개는 **전부 통과 유지**(가산 설계이므로 기존 경로 불변).

---

## 9. 경험적 검증 계획 (goal/loop B 모드)

1. **Unity `camera` 블록 = ground truth 수치 대조** — **이미 1회 수행, 통과**(§4-3: f ±3%, tilt ±0.3°). 이를 **CI 회귀 테스트로 고정**한다.
2. **sharp 렌더 육안 확인** — 프리셋별 실프레임 위에 육면체 12모서리를 그려 PNG 저장(`sharp` 이미 보유). 확인 항목:
   - 육면체 **밑면이 주차면 폴리곤과 일치**하는가
   - **수직 모서리가 실제 차량의 수직 방향과 평행**한가 (← 수직소실점이 맞는지 육안 판정하는 가장 빠른 방법)
   - h=1.5m 육면체가 **실제 승용차 높이와 맞아 보이는가**
   - 3개 프리셋 전부에서. **preset 1(조건수 최악, 깊이변 199px)이 최우선 관찰 대상.**
3. **라이브 라우트** — `GET /capture/ground-model` 응답의 `conf`/`issues` 가 preset1 을 실제로 낮게 평가하는지(신뢰도 지표가 작동하는지).
4. **슬라이더 반응** — h 를 0.5→3.0m 드래그 시 상면이 매끄럽게 따라오는가(뷰어 순수 투영이므로 서버 왕복 0).

---

## 10. 점유 판정 seam (C6 — **설명만, 구현하지 않음**)

현행 판정은 **번호판 중심이 바닥 폴리곤 안인가**이다:
```js
// core.js:459-462
return floorPolygons.map((f) => {
  const center = centers.find((c) => pointInQuad(c.x, c.y, f.quad));
  return center ? { idx: f.idx, occupied: true, center } : { idx: f.idx, occupied: false };
});
```
**이것은 구조적으로 틀린다.** 번호판은 지상 ~0.5m 에 떠 있는 점인데, 바닥 폴리곤은 지면(높이 0)의 도형이다. 카메라가 비스듬히 볼수록 높이 0.5m 의 점은 이미지에서 **자기 발밑 지점으로부터 수직소실점 방향으로 밀려나 보인다**(시차). 그 변위가 주차면 폭에 근접하면 **번호판이 옆 칸 폴리곤 안으로 들어가** 점유가 옆 칸에 찍힌다. 얕은 tilt(preset 1)일수록 변위가 커져 더 자주 틀린다.

**지면모델이 이 seam 을 어떻게 닫는가**: 지면모델은 수직소실점 `vertVP` 와 지면 호모그래피 `H` 를 준다. 그러면 번호판 중심을 **"높이 0.5m 의 점"으로 해석해 발밑(지면) 좌표로 내릴 수 있다** — 이미지의 번호판 점과 `vertVP` 를 잇는 직선이 곧 그 점의 수직선이고, 그 선 위에서 높이 0.5m 만큼 **아래로 내린 지점**이 실제 접지점이다(높이는 `H` 의 metric 스케일로 환산). 즉 `pointInQuad(발밑점, 바닥폴리곤)` 로 바꾸기만 하면 시차 오류가 원리적으로 사라진다. **한 줄 교체 수준의 변경이 되지만, 그것은 지면모델이 존재한 다음의 이야기다.** — **이번 범위 밖. 구현하지 않는다.**

---

## 11. 단순화 검토 / 반론

### 11-1. **1단계로 무엇만 하면 가장 큰 가치가 나오는가**

> **답: `GroundModel` 추정(서버) + `projectCuboid`(뷰어) + 육면체 레이어 + 높이 슬라이더. 그게 전부다.**
> **입력은 이미 있는 `PtzCamRoi.json` 하나. 신규 데이터 수집·SAM·LLM·median·시간누적 전부 불필요.**

§4-3 이 이를 증명한다 — 그 파일만으로 f 를 ±3%, tilt 를 ±0.3° 로 복원했다. 마스터가 요구한 육면체는 **여기서 완결된다.** 규모: 순수함수 4개 + 라우트 1개 + 뷰어 함수 1개 + UI 2개. **200줄로 될 일을 2000줄로 짓지 않는다.**

### 11-2. 반론 — 내가 마스터 지시와 다르게 판단한 것

1. **"다수를 묶어 로버스트 공동 추정"의 축이 다르다.** 마스터는 *면·차량을 묶으라*고 했다. 실측 결과 **같은 프리셋 안의 면을 묶는 것은 효과가 0**이다(연속 스트립이 같은 소실점을 공유하므로 독립 정보가 없다 — §4-4). 실효가 있는 축은 **프리셋(zoom)** 이다. 지시의 *정신*(단일 추정 금지, 로버스트 결합)은 그대로 따르되, **묶는 대상을 바꾸는 것이 옳다.**
2. **"차량도 캘리브레이션 타겟"은 1단계에 넣지 않는다.** 맞는 말이지만, 주차면 4점이 **이미 있고 더 정확하다**(차량 접지사각형은 SAM 없이는 추정치). 차량 타겟은 **주차면이 아예 없는 프리셋**을 위한 5단계 보강재로 미룬다. 지금 넣으면 검증 불가능한 코드를 미리 짓는 것이다(CLAUDE.md 규칙 2).
3. **SAM 을 마지막으로 미뤘다.** 가장 비싸고(신규 서비스 운영) 가장 대체 가능하다. 1~4단계가 SAM 없이 전부 동작함을 확인했다.
4. **시간누적·median 을 2단계로 뒤로 뺐다.** 프레임이 안 남아서(§1-1) 인프라 신설이 선행돼야 하고, **셋업 소요가 시간~일 단위로 늘어나는 큰 트레이드오프**를 동반한다. 1단계는 그 비용 없이 가치를 낸다.

### 11-3. 더 단순한 대안 (검토 후 기각)

- **"Unity `camera` 블록을 그냥 쓰자"** → **기각.** 실카메라에서 얻을 수 없다(C3). 다만 **검증용 ground truth 로는 최대한 활용**한다(§9). 두 경로를 한 코드로 유지하는 것이 C3 의 핵심.
- **"뷰어에서 전부 계산하자"** → **기각.** median·SAM·LLM 이 서버에만 있고, 프리셋 공동추정은 전 프리셋을 동시에 봐야 한다(§1-7).
- **"호모그래피를 정규화 0..1 좌표에서 풀자"** → **기각.** x/y 스케일이 달라(1920 vs 1080) 정사각픽셀·주점중심 가정이 깨진다(§1-2).

---

## 12. 위험 등록부

**최상위 위험: 자동화가 *조용히* 틀리는 것.** 사람이 안 그리는 대신 에이전트가 틀린 면을 확신 있게 그려 놓으면, 사람이 그리는 것보다 **나쁘다**. 아래 완화책은 **기능의 일부**이지 사후 점검이 아니다.

| # | 위험 | 발생 | 영향 | 완화 (설계에 내장) |
|---|---|---|---|---|
| **R1** | **얕은 tilt 프리셋에서 f 가 조용히 30%+ 틀림** | **확인됨**(preset1, σ=2px→35.4%) | 육면체 붕괴, metric 오측 | **프리셋 공동추정 `fovBaseV`**(§4-4, 20배 개선). 단일추정 결과 채택 금지. `depthEdgePx` 게이트 + `conf` 강등 + advisory |
| **R2** | 자동 후보가 통로/차선을 주차면으로 오인 | 중 | 잘못된 주차면 등록 | **LLM set-of-mark 검수**(좌표 생성 금지, "몇 번이 주차면인가"만). `OccupancyReviewer` 정책 채택 — **불확실하면 쓰지 않는다**(§1-6) |
| **R3** | **전역인덱스 재부여로 `slot_spec` 오귀속** | 중~높음 | 규격이 엉뚱한 면에 | **지문 재바인딩 + 매칭률<80% 시 전체 기각**(§7-3). `buildFlatSlotRows`(`core.js:588-591`) 의 "통째 기각" 철학 복제 |
| **R4** | 시간누적이 **셋업을 시간~일 단위로** 늘림 | **확실**(설계상) | 도입 저항 | **정직하게 명시.** 1단계는 시간누적 **불필요** → 즉시 가치. 누적은 2단계 옵트인 |
| **R5** | 프레임 영속화로 디스크 폭증 | 높음 | 운영 장애 | 프리셋당 **링버퍼 N장**(median 에 필요한 만큼만, 예 32장). `store.captureDir` 활용 + 상한·회수 정책 필수 |
| **R6** | SAM 미가동 시 파이프라인 정지 | 중 | 자동경로 사망 | **선택 의존**(`lpdEnabled` 패턴, `CaptureJob.ts:295`) → VPD rect 하단 근사로 강등 |
| **R7** | LLM 이 좌표를 지어냄(VLM grounding 취약) | 높음 | 좌표 오염 | **LLM 에 좌표를 만들게 하지 않는다.** 기하가 후보 생성 → LLM 은 번호 선택·분류만(C2-5). 기존 불변식(`Aggregator.ts:44`)과 동일 |
| **R8** | 광각 실카메라 배럴왜곡 | 미검증 | 소실점 편향 | 현 데이터는 망원(fov 24°)이라 무영향. **실카메라 도입 시 재평가 항목으로 등록**(무왜곡 가정 위반) |
| **R9** | 경사 주차장(지면 비평면) | 낮음 | 단일 H 로 표현 불가 | **탐지만**: 재투영 잔차 → advisory. 다중평면은 범위 밖(가정 위반을 조용히 넘기지 않는다) |
| **R10** | 신규 오버레이가 기존 렌더를 깨뜨림 | 중 | **회귀** | 토글 기본 off + `app.js:261` **가산 삽입**(대체 아님) + 기존 스냅샷 테스트 유지 |

---

## 13. 미해결 사항 / 마스터 확인 요청

| # | 질문 | 왜 묻는가 | 내 권고 |
|---|---|---|---|
| **Q1** | **1단계만 먼저 출시하고 2~5단계는 그 결과를 보고 재평가**해도 되는가? | 1단계가 육면체 요구를 완결하고, 자동경로는 비용·위험이 훨씬 크다. 로드맵 전체를 한 번에 짓지 말라는 지시와 정합 | **그렇게 하기를 강력 권고** |
| **Q2** | **깊이변 199px(preset 1)** 처럼 조건수가 나쁜 프리셋에서, 공동추정으로도 신뢰도가 낮으면 **육면체를 아예 안 그리는 것**이 맞는가(빈 화면 대신 기존 2D ROI 유지)? | "조용히 틀리느니 안 그린다" 철학의 적용 범위 확인 | **안 그리고 advisory** 를 권고 |
| **Q3** | **번호판 metric 규격**을 확정해 줄 수 있는가? | 확신이 없어 단정하지 않았다(§5-1). 주차면 폭 2.5m 는 §4-5 에서 실측 확인됨 | 주차면 폭을 **1순위 앵커**, 번호판은 **보조·교차검증**으로 |
| **Q4** | 규격 표(§7-2)의 `standard` 외 수치(도로변/장애인/경차)를 **실측 또는 근거 자료**로 확정해 줄 수 있는가? | 법령 수치를 확신 없이 단정하지 말라는 지시 준수 | config 기본값으로 두고, 자동경로는 **`measured` 우선** |
| **Q5** | `selectFloorRoi` 의 데드 `useLlm:true` 분기(§1.2-B)를 **정리해도 되는가**? | CLAUDE.md 규칙 3(요청 않은 데드코드 삭제 금지)에 따라 **언급만 하고 손대지 않았다** | 이번 범위에서는 **그대로 두기**를 권고 |

---

## 14. 영향 받는 파일/모듈 (구현자·문서화 전달용)

### 1단계 (신규)
| 파일 | 변경 |
|---|---|
| `src/ground/groundModel.ts` | **신규** — 순수 추정 함수 4개(§6) |
| `src/ground/types.ts` | **신규** — `GroundModel`, `PixelQuad`, `Hom2` |
| `src/api/captureRoutes.ts` | **가산** — `GET /capture/ground-model` (`:340` 의 place-roi 옆) |
| `src/config/toolsConfig.ts` | **가산** — `ground` 섹션(`:214-238` 스키마, `:242-270` 기본값) |
| `src/calibrate/detectMath.ts` | **읽기 전용 재사용** — `fovV`/`fovH` import. **수정 없음** |
| `web/core.js` | **가산** — `projectCuboid` |
| `web/app.js` | **가산** — `drawCuboidOverlay` (`:261` 뒤 삽입), 리스너(`:2519` 뒤) |
| `web/index.html` | **가산** — `#roi-cuboid` 토글 + `#cuboid-h` 슬라이더 + 소스 배지(`:44`) |
| `web/app.css` | **가산** — 슬라이더·배지 스타일(`.roi-toggles` 규칙 `:252-256`) |
| `test/groundModelRoundTrip.test.ts` 외 | **신규** — §8 |

### 2~5단계 (예고 — 1단계에서는 손대지 않는다)
`src/capture/CaptureJob.ts`(프레임 영속화), `src/capture/SqliteStore.ts`(`addColumnsIfMissing` 마이그레이션 관용구 `:123-131`), `src/ground/median.ts`, `src/clients/SamClient.ts`, `src/capture/SlotSpecReviewer.ts`, `config/prompts/slot_type.yaml`, `src/config/llmConfig.ts`.

### 회귀 위험 0 근거
1단계 변경은 **전부 가산**이다. 기존 함수 시그니처 변경 0, 기존 렌더 경로 변경 0, `PtzCamRoi.json` 스키마 변경 0, DB 스키마 변경 0. `#roi-cuboid` 를 켜지 않은 사용자는 **현행과 픽셀 단위로 동일**하다(C1).
