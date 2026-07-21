# 01 설계서 — VPD 자동검출 정지 + VPD 테스트 버튼 분리

작성: 설계자(architect) · 2026-07-19 · 대상: SettingAgent

---

## 0. 목표 / 성공 기준

**목표(마스터 확정 요구):**
1. VPD(차량 검출)를 **자동 경로에서 정지**한다(기본 OFF). — 자동 경로 = ① 정밀수집 잡 캡처 라운드, ② 라이브 "검출 실행" 버튼(POST /capture/detect).
2. VPD 검출은 **별도 "VPD 검출(테스트)" 버튼**으로만 1회 실행·표시.
3. LPD(번호판)는 계속 — 자동 경로에서 LPD는 그대로 동작.

**검증 가능한 성공 기준:**
- vitest: 기본(VPD off)에서 `vpd.detect` 스파이 **0회**(캡처 라운드 · /capture/detect). `vpdEnabled:true`일 때만 호출.
- vitest: VPD off에서도 LPD 플레이트가 수집/응답되고, 플레이트 필터가 **폴리곤 직접(filterPlatesOnPlace, vehicles 비결박)** 로 동작.
- vitest: VPD off에서 캡처 라운드가 육면체(seg) 호출을 하지 않음.
- 라이브(리더): "검출 실행" 응답에 vehicles 없음(LPD만) · "VPD 검출(테스트)" 버튼 경로에서만 vehicles/육면체 표시.

---

## 1. 배경 — 코드가 말하는 데이터 흐름(근거 재확인, 이 위에 설계)

이 설계의 정당성은 아래 **확인된 사실**에 근거한다(추측 아님, 파일:라인 명시).

### 1.1 CaptureJob(정밀수집)은 **VPD 앵커**다
- `src/capture/CaptureJob.ts:370` — 매 라운드 `vpd.detect(cap.jpg)`. `:386` `applyPlateFilter(rawPlates, vehicles, t)` = 플레이트를 VPD vehicles에 결박(모드A). → **마스터가 지목한 방해 메커니즘**.
- `src/capture/Aggregator.ts:255-257` — `const vehicles = presetDets.filter(kind==='vehicle'); const plates = ...; if (vehicles.length === 0) continue;`. **클러스터는 vehicle에서만 생성**되고 plate는 vehicle 클러스터에 종속 귀속된다.
  - ⇒ **VPD off로 vehicles=[]이면 `aggregate()`는 빈 배열을 낸다.** 수집한 plate det는 집계에서 전부 버려진다.

### 1.2 slot_setup.lpd / 센터링은 **discovery(LPD-only) 경로**가 채운다 — CaptureJob이 아니다
- `src/index.ts:98-101` — `PlateDiscoveryJob({ camera, lpd, store, outFile })`. **vpd 미주입(LPD-only)**. `plateDiscovery.ts:112,127` 은 `lpd.detect`만 호출(vpd import·필드·호출 전무). 주석: "앞면중심 기준 디지털 크롭-줌 → slot_setup.lpd **부분 UPDATE**. 센터라이징 상류 **별개 잡** — 파이프라인 자동연쇄엔 **미포함**(수동 실행)."
- **discovery 대상 판정은 `slot3d_front_center` 보유 여부**(`plateDiscoveryWriter.ts:18` — `v.slot3dFrontCenter==null` 스킵). lpd가 아니라 front_center가 discovery의 입력 게이트다. `PlateDiscoveryJob.ts:200` `upsertSlotLpd`(lpd_obb만 부분 UPDATE, VPD 무관).
- 센터링(`PtzCalibrator`→`platePtz.ts`, 둘 다 vpd 없음·`lpd.detect`만)은 `expandPlateTargetsFromSlotSetup(views)`(`slotPtzWriter.ts:19` — `v.lpd==null` 스킵)로 대상을 만든다(`SetupPipeline.ts:139-141`). 출력 `upsertSlotCentering`(pan/tilt/zoom/centered/img1).
- ⇒ 마스터의 "앞면중심 discovery·센터링은 **이미 LPD-only**"가 코드로 확인됨. **VPD를 CaptureJob에서 꺼도 slot_setup.lpd 수집은 discovery가 계속 담당한다.**

### 1.2b **slot_setup.lpd 는 두 경로가 쓴다 — 하나는 VPD 종속, 하나는 LPD-only**
- `Finalizer.ts:264`(replaceSlotSetup) — `lpdObb = hit?.plateQuad ? … : prev?.lpd ?? null`. `hit`은 **accepted vehicle 클러스터**(§1.1). ⇒ VPD off면 hit 없음 → 신규 lpd 못 채움(prev 보존/null). **CaptureJob-finalize의 lpd는 VPD 종속.**
- `PlateDiscoveryJob.ts:200` `upsertSlotLpd` — **VPD 무관 LPD-only 대체 경로**. front_center만 있으면 VPD off여도 lpd를 채운다.
- **`slot3d_front_center` 를 쓰는 코드는 `Finalizer.ts:271`(replaceSlotSetup)이 유일**(그 외 마이그레이션 툴뿐). front_center는 `slotFrontCenter(sp.points, model, H_CONST)` — **hit/VPD와 독립인 순수 기하**(`Finalizer.ts:251-252`).
- ⇒ **부트스트랩 선행조건(중요):** discovery가 돌려면 그 전에 **최소 1회 finalize**로 slot_setup 행 + front_center가 깔려 있어야 한다(discovery는 front_center를 입력으로 요구). front_center 산출은 VPD off여도 성립하므로 **VPD off finalize도 행·front_center를 정상 기록한다**(→ 결정 E의 근거).

### 1.3 finalize의 slot_setup 기하 산출은 **VPD 무관(순수 기하)**
- `src/capture/Finalizer.ts:242-276` — slot_setup 행은 **place 파일(PtzCamRoi.json byPreset)** 을 순회해 만든다. `slot_roi`(폴리곤)·`slot3d_front_center`(지면모델+높이)는 **검출과 무관한 기하**다. `vpd/lpd/occupy`만 accepted 클러스터에서 채워지고, **hit 없으면 `prev`(기존값) 보존**(`:250,263-265`).
- ⇒ **VPD off → accepted 빈 배열 → vpd/occupy는 보존/null(정상 강등), slot_roi·front_center는 불변으로 계속 써진다.** 이것이 discovery가 쓰는 입력이다.

### 1.4 runDetect(라이브 "검출 실행")도 VPD 선행
- `src/capture/detectPipeline.ts:250` `vpd.detect(base.jpg)` → `:275` cuboid(seg) → `:288` 매칭 → `:311-350` 미귀속 차량 zoom 재시도(vehicles 순회). 플레이트 필터는 `:299 filterPlatesOnPlace(platesBase, vehicles, polys)`.

### 1.5 F10 가드의 실제 조건
- `src/pipeline/SetupPipeline.ts:90` — `if (snapshot.dets.length === 0)` finalize 미호출. **`dets`에는 plate 행도 포함**(CaptureJob.ts:398-412)이므로 **"VPD off ⇒ dets 항상 0"은 사실이 아니다** — LPD가 플레이트를 잡으면 dets>0로 가드는 통과한다. (리더 전달 사항의 "dets 항상 0" 전제를 정정한다.)

---

## 2. 설계 결정

### 결정 A — 플래그: **요청 바디 `vpdEnabled?:boolean`** (config 킬스위치 아님)
`vpdOnParkingOnly`가 이미 start/detect 바디 필드인 선례와 동일 패턴. 프리셋별·요청별 토글이 필요(테스트 버튼)하므로 config 전역 킬스위치보다 바디 플래그가 최소·정합.

### 결정 B — **정책은 라우트/UI 경계에서 OFF, 라이브러리는 하위호환 기본 유지**(레이어 분리, 테스트 churn 최소화 — CLAUDE.md §3)
- **라이브러리(CaptureJob.start / runDetect)**: 인자 미지정 시 기본 **true**(= 기존 "완전 검출" 동작 보존 → 기존 vitest 무수정).
- **라우트(정책 계층)**: `/capture/start`·`/capture/detect` 모두 `parsed.data.vpdEnabled ?? **false**` — **제품 기본 OFF**.
- **UI**: 정밀수집 시작은 `vpdEnabled:false` 전송(체크박스 없음 — 마스터 3회 반복 확정: 그냥 정지). VPD는 테스트 버튼만.
- 근거: 라이브러리는 "메커니즘"(시키는 대로), 라우트는 "제품 정책"(VPD off). 유일 호출자는 라우트/테스트뿐 → 숨은 true 기본의 실사용 위험 0.

### 결정 C — 플레이트 필터의 "vehicles 결박 → 폴리곤 직접" 전환은 **자동 성립**
`applyPlateFilter`/`filterPlatesOnPlace`는 `keptVehicles=[]`이면 (A)귀속항이 비고 **(B)번호판 중심 ∈ 주차면 폴리곤**만 남는다(`onPlaceFilter.ts:80-91`). ⇒ VPD off로 vehicles=[]가 되는 순간 **코드 변경 없이 폴리곤 직접 필터**가 된다(방해 제거의 본질). 별도 분기 추가 불필요.

### 결정 D — 육면체(cuboid)는 VPD off 시 게이트
cuboid는 `vpd.segment`에 의존(VPD 산물). VPD off면 raw det도 없어 산출물이 비므로, 낭비 seg 호출을 막기 위해 `vpdEnabled` 게이트를 명시한다(마스터: "육면체 등 VPD 의존 기능 자연 비활성").

### 결정 E — F10 가드 재정의(VPD 인지) — **필요(선택 아님)**
`SetupPipeline`이 이번 run의 vpdEnabled를 알고, **`vpdEnabled && dets.length===0`일 때만** finalize를 막는다. VPD off면 dets 가드를 우회해 finalize를 진행한다.
**근거(§1.2b 부트스트랩):** VPD off 흐름에서 slot_setup 행 + `slot3d_front_center` 를 까는 **유일 코드가 finalize(replaceSlotSetup)** 이고, 이것이 있어야 discovery(LPD-only)가 대상을 펼쳐 lpd를 채운다. front_center는 VPD 무관 기하라 검출 0이어도 산출된다. 따라서 **VPD off에서 finalize를 막으면 LPD-only 하류 전체(discovery→센터링)가 부트스트랩 불가**가 된다. 가드 우회는 안전(hit 없으면 검출컬럼 prev 보존)하며 필수다.

---

## 3. 단계별 구현 계획 (파일별 · 각 단계 검증기준)

### S1. CaptureJob — 라운드 VPD 게이트
`src/capture/CaptureJob.ts`
- `CaptureStartParams`에 `vpdEnabled?: boolean` 추가(주석: 기본 라이브러리 true, 라우트 false).
- 필드 `private vpdEnabled = true;`. `start()`에서 `this.vpdEnabled = p.vpdEnabled ?? true;`.
- `captureTarget()`(:370~386):
  - `const raw = this.vpdEnabled ? await this.deps.vpd.detect(cap.jpg) : [];`
  - `const vehicles = (this.vpdEnabled && this.vpdOnParkingOnly) ? await this.applyOnPlaceFilter(raw, t) : raw;`
  - 플레이트 필터 라인(:386)은 **무변경** — vehicles=[]로 결정 C가 자동 성립.
- cuboid 블록(:419) 게이트: `if (this.deps.cuboidCtx && this.vpdEnabled)`.
- `getStatus()`: `...(this.runId!==undefined ? { vpdEnabled: this.vpdEnabled } : {})` 추가(강등 사유 노출).
- **검증**: 신규 `captureJobVpdOff.test.ts` — vpdEnabled:false start → `vpd.detect` 스파이 0회, lpd.detect는 호출·plate dets 누적, cuboidCtx 스파이 0회. vpdEnabled:true → vpd.detect 호출.

### S2. runDetect — 라이브 검출 VPD 게이트
`src/capture/detectPipeline.ts`
- `args`에 `vpdEnabled?: boolean` 추가. 내부 `const vpdEnabled = args.vpdEnabled ?? true;`.
- `:250` → `const rawVehicles = vpdEnabled ? await deps.vpd.detect(base.jpg) : [];`.
- cuboid 조건(:275) → `if (cuboidCtx && vpdEnabled && deps.vpd.segment && deps.vpd.canSegment)`.
- 나머지(매칭·zoom 재시도)는 vehicles=[]로 자연 스킵. onPlace 플레이트 필터는 결정 C로 폴리곤 직접(`filterVehiclesOnPlace([],polys)`는 degraded=false·kept=[] → onPlaceOnly=true → `filterPlatesOnPlace(platesBase,[],polys)`).
- `summary`에 `vpdEnabled` 필드 추가(0대와 "미실행" 구분 — 정직 표기).
- **검증**: `detectPipeline.test.ts`에 케이스 추가 — vpdEnabled:false → vpd.detect 0회, plates는 반환, summary.vpdEnabled=false. 기존 케이스(인자 생략)는 기본 true라 **무수정 통과**.

### S3. captureRoutes — 바디 스키마 + 정책 기본 OFF
`src/api/captureRoutes.ts`
- `StartBodySchema`에 `vpdEnabled: z.boolean().optional()` 추가. `job.start({... vpdEnabled: parsed.data.vpdEnabled ?? false})`.
- `onCaptureStart` 호출을 `deps.pipeline?.onCaptureStart(parsed.data.autoChain ?? false, parsed.data.vpdEnabled ?? false)`로.
- `DetectBodySchema`에 `vpdEnabled: z.boolean().optional()`. `/capture/detect`에서 `runDetect({camera,vpd,lpd},{cam,preset, vpdEnabled: parsed.data.vpdEnabled ?? false}, ...)`.
- **검증**: `captureRoutes.test.ts` — POST /capture/detect(바디 vpdEnabled 생략) → vpd.detect 스파이 0회; `{vpdEnabled:true}` → 1회. POST /capture/start 동일.

### S4. SetupPipeline — F10 가드 VPD 인지(결정 E)
`src/pipeline/SetupPipeline.ts`
- 필드 `private runVpdEnabled = true;`.
- `onCaptureStart(armed: boolean, vpdEnabled = true)` — `this.runVpdEnabled = vpdEnabled;`(기본값 true로 기존 테스트 호출부 무수정).
- `onCaptureFinished`(:90) 가드 → `if (this.runVpdEnabled && snapshot.dets.length === 0) { this.fail('finalize','검출 0건 — finalize 미실행(DB 보호)'); return; }`. VPD off면 통과 → finalize(기하 안전).
- **검증**: `setupPipeline.test.ts` — armed+vpdEnabled:false+dets 0 → finalize 호출됨(가드 우회); armed+vpdEnabled:true+dets 0 → 종전대로 fail.

### S5. web UI — 버튼 분리
`web/index.html` (정밀수집 탭, :183 옆)
- 기존 `#cap-detect-run` 버튼 title을 "현재 프리셋 1회 **번호판(LPD)** 검출(VPD 미실행)"로, 라벨은 "검출 실행" 유지(또는 "번호판 검출").
- 신규 버튼 추가: `<button id="cap-vpd-test" title="현재 프리셋 1회 VPD(차량) 검출 — 테스트용. 자동 경로엔 VPD 미실행">VPD 검출(테스트)</button>`.

`web/app.js`
- `runLiveDetect(vpdEnabled = false)`(:921) — 바디에 `vpdEnabled` 추가. summary 메시지에서 VPD off일 때 "VPD 미실행"으로 표기(vpdCount 0/0 오해 방지).
- 바인딩(:3204): `$('cap-detect-run').addEventListener('click', () => runLiveDetect(false));` + `$('cap-vpd-test').addEventListener('click', () => runLiveDetect(true));`.
- capStart 바디(:2048): `vpdEnabled: false` 추가(정밀수집 VPD off 고정 — 체크박스 없음).
- 상태 렌더(:1800 부근): `status.vpdEnabled === false`면 "VPD 미실행(LPD 전용)" 배지.
- 오버레이(`drawDetectOverlay`)는 **무변경** — vehicles=[]면 차량 박스 자동 미표시, VPD 테스트 시에만 vehicles 표시(기존 detectByKey 재사용).
- **검증**(리더 라이브): "검출 실행" → 응답 vehicles 없음·플레이트만 표시. "VPD 검출(테스트)" → vehicles+플레이트(+육면체) 표시.

### S6. 문서화 인계
영향 파일 목록(§6)을 documenter에 전달.

---

## 4. MCP 도구 vs LLM 두뇌 경계

- 이 변경은 **전부 결정형(도구 계층)**. VPD/LPD는 결정형 REST 클라이언트, 이번 작업은 그 호출을 **게이트**할 뿐 LLM 두뇌 무개입.
- 실시간·고빈도 루프(캡처 라운드, zoom 재시도)는 기존대로 결정형 — 경계 이동 없음.

---

## 5. 회귀 0 대상(반드시 불변 확인)

- 센터링(`PtzCalibrator`/`PlatePtz`) — slot_setup.lpd 입력·slot_ptz 출력 불변.
- **plate discovery(`PlateDiscoveryJob`)** — LPD-only, 이번 변경 무접촉. slot_setup.lpd 계속 채움. 부트스트랩 입력(`slot3d_front_center`)은 VPD off finalize도 계속 기록(§1.2b).
- 원버튼 파이프라인 **상태머신 자체**(idle→…→done/failed) — 전이 로직 불변, 가드 조건만 VPD 인지.
- 수동 finalize(`POST /capture/finalize`) — 가드 없음·무변경.
- 뷰어 기존 토글(#roi-vehicle/#roi-plate/#roi-db/#roi-mask/#roi-cuboid), DB 오버레이, job-cuboids/vehicle-cuboids 수동 진단 라우트 — 무변경(VPD 테스트 버튼이 요청할 때만 vehicles 등장).
- `vpdOnParkingOnly` 체크박스 — 의미 유지. VPD off일 때는 **플레이트 폴리곤 필터** 모드로 계속 기능(차량은 없음).

---

## 6. 파급 정합 — 정직하게 열거(숨기지 않음)

VPD off는 **VPD 의존 기능의 자연 강등**을 낳는다. 마스터 요구대로 강등 사유를 노출하고 조용한 위장을 금한다.

| 기능 | VPD off 시 거동 | 조치 |
|------|----------------|------|
| 캡처 라운드 vehicle det 누적 | 0건 | 정상(의도). status.vpdEnabled=false 노출 |
| `aggregate()`/finalize accepted | 빈 배열(Aggregator.ts:257) | slot_setup vpd/occupy = **prev 보존/null**(파괴 아님). slot_roi·front_center는 기하로 계속 써짐 |
| setup_artifact.json slots | vehicle 클러스터 0 → **빈 slots** | 정상 강등. 정본은 slot_setup(DB). 문서에 명시 |
| 점유통계(occupancy) | 미산출 | occupancyReviewer는 라운드 LLM off라 이미 최소. 강등 |
| 육면체(cuboid) | 미산출 | S1/S2 게이트로 seg 호출도 스킵 |
| 수집 라운드 plate det | 누적되나 aggregate가 폐기 | **정직 한계**: VPD off에선 캡처 라운드의 plate는 slot_setup에 반영 안 됨(vehicle 앵커라서). slot_setup.lpd는 **discovery**가 담당. 문서에 명시 |
| F10 가드 | vpdEnabled=false면 우회(결정 E) | finalize 기하 안전 |

**미세 정직 갭(수정 안 함, 명시만):** VPD off + `vpdOnParkingOnly` + 폴리곤 부재 시 플레이트 필터가 강등(전량 통과)하지만 경고는 원래 차량 필터가 남기던 것 → 차량 필터 미실행이라 warn 미노출. 기능은 안전(전량 통과). 범위 밖.

---

## 7. 가정 · 미해결 (진행 전 리더 확인 요청)

1. **[가정] 정밀수집 VPD는 체크박스 없이 항상 OFF.** 마스터 3회 반복 확정("그냥 정지")에 근거해 체크박스를 추가하지 않고 UI에서 `vpdEnabled:false` 고정. 만약 "고급 사용자 옵트인 체크박스"를 원하면 알려주면 추가(1줄). — **기본안: 체크박스 없음.**
2. **[결정 E 채택 — 부트스트랩 근거로 확정]** F10 가드는 "VPD 인지 우회"로 재정의한다. explore 조사(§1.2b)로 **finalize가 VPD off 흐름의 유일 부트스트랩**(행+front_center)임이 확인되어, 무변경(가드 유지)은 discovery 하류를 부트스트랩 불가로 만든다 → 채택하지 않는다. 별도 리더 승인 없이 결정 E로 진행한다(반대 지시 없으면).
3. **[확인] setup_artifact.json 빈 slots 허용?** VPD off면 vehicle 앵커 아티팩트가 빈다. 정본이 DB(slot_setup)라는 전제(메모리: "DB 정본")면 정상. 아티팩트를 소비하는 다른 화면(GET /mapping 등)이 빈 slots로 깨지지 않는지는 documenter 영향도에서 교차확인.

---

## 8. 검증 계획 (요약)

**vitest(구현자→qa):**
- `captureJobVpdOff.test.ts`(신규): 라운드 VPD off → vpd.detect/cuboidCtx 스파이 0, lpd/plate det 누적.
- `detectPipeline.test.ts`(추가): runDetect vpdEnabled:false → vpd.detect 0, plates 반환.
- `captureRoutes.test.ts`(추가): /capture/detect·/capture/start 바디 기본 → vpd.detect 0; `vpdEnabled:true` → 호출.
- `setupPipeline.test.ts`(추가): vpdEnabled 인지 가드(off+dets0 → finalize 진행 / on+dets0 → fail).
- **실패-주도 갱신 허용 목록**(qa 전달): VPD 경로를 전제한 기존 테스트는 `vpdEnabled:true` 명시로 갱신 — `captureJobOnPlace.test.ts`, `captureJobCuboid.test.ts`, `captureCheckpointTrigger.test.ts`, `captureJobOccupancyGate.test.ts` 등에서 vehicle det가 필요한 케이스(라이브러리 기본 true라 대부분 무수정, 라우트 경유 테스트만 vpdEnabled:true 주입).

**라이브(리더):**
- "검출 실행" → 응답 vehicles 없음(LPD만), 오버레이 차량 박스 없음.
- "VPD 검출(테스트)" → vehicles + 플레이트(+육면체) 표시.
- 정밀수집 시작 → status.vpdEnabled=false 배지, 라운드 로그에 vpd 호출 없음.

---

## 9. 인계

- **구현자(developer)**: §3 파일별 순서대로. 라이브러리 기본 true / 라우트·UI 기본 false 레이어 규칙 준수. 오버레이·discovery·센터링 무접촉.
- **문서화(documenter)**: §6 파급표 + §7-3 setup_artifact 소비처 교차확인 + 영향 파일 목록.

**영향 파일**
- 백엔드: `src/capture/CaptureJob.ts`, `src/capture/detectPipeline.ts`, `src/api/captureRoutes.ts`, `src/pipeline/SetupPipeline.ts`
- 프런트: `web/index.html`, `web/app.js`
- 테스트: `test/captureJobVpdOff.test.ts`(신규), `test/detectPipeline.test.ts`, `test/captureRoutes.test.ts`, `test/setupPipeline.test.ts`(+실패-주도 갱신 대상)
- 무접촉(회귀 0): `src/capture/onPlaceFilter.ts`, `src/capture/Aggregator.ts`, `src/capture/Finalizer.ts`, `src/calibrate/PlateDiscoveryJob.ts`·`plateDiscovery.ts`·`plateDiscoveryWriter.ts`, `src/calibrate/PtzCalibrator.ts`·`platePtz.ts`·`slotPtzWriter.ts`
