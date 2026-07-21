# 01 설계 — 정밀수집 "시작" 을 앞면중심 앵커 loop(discovery) 기반 LPD 로 전환

> B-mode(goal/loop). 목표: 정밀수집 "시작"(#cap-start) 자동 연쇄에서 **LPD 채우기를 전체프레임 검출 대신
> 3D 육면체 앞면중앙점 앵커 loop(discovery) 로 수행**하고, 점유→최종화→저장→센터라이징→저장 연쇄를 완성한다.
> 코드는 쓰지 않는다 — 무엇을/어디에/어떤 순서로/어떻게 검증할지 정의한다.

---

## 0. 한 줄 결론 + 핵심 결정

- **추천안 = 후보 C(외과적 최소):** 이미 배선된 autoChain(capture→finalize→centering) 에 **discovery 단계를
  finalize 와 centering 사이에 1개 삽입**한다. discovery(PlateDiscoveryJob) 가 앞면중심 앵커 loop 로
  `slot_setup.lpd` 를 **부분 UPDATE 로 덮어쓰고**, 센터라이징이 그 lpd 를 소비한다.
- **핵심 순서 결정(마스터 리스트와의 차이 — 반드시 확인):** 마스터의 나열 순서는 `LPD(1) → 점유(2) → 최종화(3)` 이지만,
  **discovery 앵커(`slot3d_front_center`)는 오직 finalize 가 부트스트랩**한다(아래 §B·§1 근거). 따라서
  앵커 loop 는 **finalize 이후에** 돌아야 성립한다. 즉 실제 실행 순서는
  **capture → finalize(점유+기하+앵커 부트스트랩) → discovery(앵커 loop LPD) → centering** 이 된다.
  마스터의 의도(=최종 persist 되는 `slot_setup.lpd` 가 전체프레임이 아니라 **앵커 loop 산출**)는 이 순서로 100% 충족되나,
  "LPD 를 finalize 보다 먼저" 라는 **문자 그대로의 순서와는 어긋난다**(이유: 앵커 의존성). → §G Q1 로 확인 요청.
- **앵커 = 하향앵커(`lowerFrontAnchor`) 유지**(핸드오프 §A·메모리 `lpd-discovery-anchor-grid-exclusivity`).
  마스터 표현 "앞면중앙점" 은 조준의 기준이고, 실제 픽셀 조준점은 판(지상 0.3~0.5m)이 앞면중심(≈0.75m)보다 아래라
  선형 하향 보정한 값이다. 이미 `expandDiscoveryTargets` 가 이 값을 산출한다 — **변경 없음**.

---

## A. 현재 end-to-end 흐름 정밀 매핑 (파일:라인)

### A-1. #cap-start 클릭 → 수집
- `web/app.js:2157 capStart()` → body `{count, intervalMs, checkpointTriggerMode, floorRoiUseLlm,
  vpdOnParkingOnly, vpdEnabled:false(고정), autoChain:#cap-autochain.checked}` → `POST /capture/start`.
- `src/api/captureRoutes.ts:156 /capture/start` → targets 해석(presetProvider|mapFiles) → `deps.job.start({... vpdEnabled: false})`
  (206: 제품 정책 자동경로 VPD OFF) → `deps.pipeline?.onCaptureStart(autoChain, vpdEnabled=false)`(210, autoChain 무장/해제).

### A-2. 수집 라운드(현재 LPD = 전체프레임 — **수정 대상**)
- `src/capture/CaptureJob.ts:303 runRound` → `358 captureTarget`:
  - `380` VPD off → `vehicles=[]`.
  - `392~405` **LPD = `this.deps.lpd.detect(cap.jpg)` (전체프레임)** → plate dets 누적. ← **마스터가 지목한 지점**.
- 완료 시 `283 finishRun('done')` → `288 deps.onFinished?.(status)` → `index.ts:80` → `pipeline.onCaptureFinished`.

### A-3. autoChain 연쇄(이미 배선됨)
- `src/pipeline/SetupPipeline.ts:81 onCaptureFinished`:
  - VPD off 이므로 `dets 0` 가드 **우회**(96, 결정 E — finalize 가 slot_setup 행+front_center 부트스트랩하는 유일 경로).
  - → `100 finalizing` → `133 runFinalizeThenCalibrate(snapshot)`.
- `Finalizer.finalize`(`src/capture/Finalizer.ts:117`):
  - `120` 집계 → `188` accepted 클러스터 → `276 store.replaceSlotSetup(rows)` 로 `slot_setup` 전량 재작성.
  - `252` **`slot3d_front_center` = `slotFrontCenter(sp.points, groundModel, H=1.5)`** — 기하 소스(PtzCamRoi.json 공간 +
    지면모델), **검출 무관·매 finalize 재계산**. ← **앵커의 유일 부트스트랩**.
  - `254` `occupy_range`(점유영역) = `buildPlateAnchoredQuad(hit.rect, hit.plateQuad)` — accepted **hit** 필요.
    VPD off 여도 **capture 전체프레임 LPD 의 plate 클러스터**가 hit 을 제공 → 점유영역·lpd 가 채워짐(현행).
  - `264` `slot_setup.lpd` = `hit.plateQuad ?? prev.lpd ?? null`(전체프레임 산출을 여기서 씀).
  - `215 repo.saveArtifact` + `283 saveStore.save`(파일 저장) → 마스터 4번(DB·파일 저장) 일부 충족.
- finalize 성공 → `SetupPipeline.ts:145~147` `expandPlateTargetsFromSlotSetup`(lpd 보유분) 커버리지 →
  `156 calibrating` → `158 calibrator.start()`.
- `PtzCalibrator`(`src/calibrate/PtzCalibrator.ts:106 start`) → `108 expandPlateTargetsFromSlotSetup`(lpd 필요) →
  `137 writeSlotPtz`(slot_ptz.json) + `138 saveCenteringSlots`(centering_slot DB) → `142 onFinished('done')` →
  `SetupPipeline.onCalibrateFinished` → done. → 마스터 5·6번(센터라이징·저장) 충족.

### A-4. 이미 존재하는 discovery(앞면중심 LOOP) — 재사용 대상
- `POST /discover/ptz`(`src/api/discoverRoutes.ts:25`) → `PlateDiscoveryJob.start`(`src/calibrate/PlateDiscoveryJob.ts:111`)
  → `113 expandDiscoveryTargets`(slot_setup 중 **`slot3dFrontCenter != null`** 슬롯만, `plateDiscoveryWriter.ts:45`) →
  `133 run`: 프리셋별 그룹핑(peer 앵커) → `152 discovery.discoverSlot(t, presetPtz, peerAnchors)` →
  `173 writePlateDiscovery`(plate_discovery.json) + `202 saveSlotLpd → upsertSlotLpd`(**부분 UPDATE**).
- `PlateDiscovery.discoverSlot`(`src/calibrate/plateDiscovery.ts:136`): Tier0 전체 → 실패 시 Tier1 **격자 30칸(5줌×6방)**
  하향앵커 크롭-줌 loop + 배타성 게이트(`pickOwnedPlate`). = 마스터가 말한 "loop 이용".

### A-5. 결정적 사실(설계 근거)
1. **앵커 의존성:** discovery 의 `expandDiscoveryTargets` 는 `slot3dFrontCenter` 없으면 대상 0. 그 값은 **finalize 만 생성**.
   → discovery 는 finalize **이후**에만 유효.
2. **점유영역 의존성:** finalize 의 `occupy_range` 는 accepted **hit** 필요. VPD off 상태에서 hit 은 **capture 전체프레임 LPD
   plate 클러스터**가 유일 공급. capture LPD 를 통째로 제거하면 **점유영역 생성이 깨진다**(주의).
3. **lpd 부분 UPDATE 안전:** `upsertSlotLpd` 는 slot_id 키 lpd 컬럼만 수정(DELETE+INSERT 아님) → finalize 뒤 discovery 가
   lpd 만 덮어써도 roi/occupy/front_center/ptz 무접촉(정책 3 준수).
4. **배선 공백:** `PlateDiscoveryJob` 은 `CaptureJob`/`PtzCalibrator` 와 달리 **`onFinished` 완료 콜백이 없다** →
   파이프라인에 연쇄하려면 추가 필요.

---

## B. "앞면중앙점" 앵커 정의 확정

| 후보 | 정의 | 판정 |
|------|------|------|
| `slot3d_front_center` (앞면중심, ≈h 0.75m) | 육면체 앞면 4모서리 평균 | 판(0.3~0.5m)보다 위 → 격자줌 시 판 탈락(핸드오프 §A 근본원인1) |
| **`lowerFrontAnchor(roi, front_center, plateH=0.4)`** | 앞 edge 중점(h=0)과 front_center 의 선형보간 하향 | **채택** — 판 높이 조준, `plateDiscoveryWriter.ts:23`, `expandDiscoveryTargets` 기본 |

- 결정: **하향앵커 유지, 신규 코드 0**. `web/core.js` 뷰어의 `frontFaceCenter` 는 표시용이며 서버 앵커와 무관(변경 없음).
- 정본 소스는 서버(`slot3d_front_center` DB 컬럼) → discovery 가 읽어 `lowerFrontAnchor` 로 하향(이중구현 없음).

---

## C. 후보 비교 · 추천

### 후보 (a) — CaptureJob 내부 LPD 경로를 앵커 loop 로 교체
- CaptureJob.captureTarget(392~405)의 전체프레임 detect 를 discovery loop 호출로 치환.
- **기각 사유:** (1) loop 구조 불일치 — CaptureJob 은 프리셋당 1캡처 관측 루프인데 discovery 는 슬롯별 크롭-줌 loop →
  **매 라운드마다 전 슬롯 discovery 재실행**(N회 낭비, PTZ/시간). (2) 앵커(front_center)가 capture 시점엔 아직 없음
  (finalize 전). (3) 점유·집계 경로와 얽혀 회귀 위험 큼. → **아키텍처적으로 부적합**.

### 후보 (A-literal) — 마스터 문자 순서: capture → discovery → finalize → centering
- **부분 기각:** (1) 앵커 의존성 — 첫 셋업(cold DB)엔 front_center 부재 → discovery 대상 0 → lpd 미충전. (2) capture LPD
  를 제거하면 finalize 점유영역이 깨짐(§A-5.2). (3) discovery 를 먼저 두려면 front_center 를 별도 부트스트랩해야 하는데
  이는 finalize 기하 로직 **이중구현**(정책 2·단순성 위배). → **warm DB 전제에서만 성립**, 콜드스타트 취약.

### ★ 후보 (C) — autoChain 에 discovery 단계 삽입 (추천)
```
capturing(VPD off, capture LPD 유지=점유영역 앵커용) 
  → finalizing(집계·점유영역·기하 front_center 부트스트랩·전체프레임 lpd 임시 기록·artifact 저장)
  → discovering(앞면중심 앵커 loop → slot_setup.lpd 부분 UPDATE 로 '덮어쓰기' + plate_discovery.json)
  → calibrating(discovery 가 채운 lpd 로 센터라이징 → slot_ptz.json + centering_slot)
  → done
```
- **마스터 의도 충족:** 최종 persist 되는 `slot_setup.lpd` = **앵커 loop 산출**(전체프레임 아님). 센터라이징이 그 lpd 소비.
- **점유영역 보존:** finalize 는 capture LPD 클러스터로 점유영역을 계속 만든다(회귀 0). capture 전체프레임 LPD 는
  **점유 앵커링 + 임시 lpd** 용도로만 남고, 최종 lpd 는 discovery 가 덮어씀.
- **앵커 의존성 해소:** finalize 가 먼저 front_center 를 깔아 discovery 대상이 항상 존재(콜드스타트 견고).
- **재사용 범위:** PlateDiscoveryJob/PlateDiscovery/plateDiscoveryWriter/cropZoom **그대로**(discoverSlot·배타성·격자30·하향앵커
  전부 재사용). 신규 기하/탐색 코드 0.
- **정책 부합:** VPD off 유지(R1) · 결정론(R2) · 부분 UPDATE(R3) · stringify5 는 기존 writer 가 수행(R4) ·
  nearest 하향앵커 게이트(R5, discovery 내장) · 위장 금지(R6, found 라이브 실증).

**추천: 후보 C.** (a) 는 구조 부적합, (A-literal) 은 콜드스타트·점유영역 취약. C 는 최소 배선(파이프라인 1단계 + 콜백 1개)으로
마스터 실질 의도를 달성하고 기존 검증된 discovery 를 통째로 재사용한다.

---

## D. 최소 변경 파일 목록 · 함수 시그니처 (구현자 전달)

경계 판단: **전부 결정형 도구 영역**(탐색·기하·상태머신). LLM 두뇌 개입 없음(R2).

1. **`src/calibrate/PlateDiscoveryJob.ts`** — 완료 콜백 추가(PtzCalibrator 미러).
   - `PlateDiscoveryJobDeps` 에 `onFinished?: (state: 'done' | 'error') => void` 추가.
   - `run()` 종료부(`177 state='done'` / `182 state='error'`)에서 `notifyFinished(state)` 호출(throw 흡수 래퍼).
   - 시그니처·기존 start/status 불변. 수동 `/discover/ptz` 경로 회귀 0(콜백 미주입 시 no-op).

2. **`src/pipeline/SetupPipeline.ts`** — discovery 단계 삽입.
   - `PipelineStage` 에 `'discovering'` 추가.
   - `SetupPipelineDeps` 에 `discovery: Pick<PlateDiscoveryJob, 'start' | 'getStatus'>` 추가.
   - `runFinalizeThenCalibrate` 분해: finalize 성공 후 **커버리지·센터라이징 발화 전에** `stage='discovering'` →
     `discovery.start({})`(전 프리셋). 신규 `onDiscoverFinished(state: 'done'|'error')`:
     - `error` → `fail('finalize'|'discover', ...)`(정직 실패).
     - `done` → 그때 `expandPlateTargetsFromSlotSetup(store.getSlotSetup())` 로 **커버리지 재계산**(discovery 반영본) →
       targets 0 이면 `note` + `finish('done')`(F6 가드 유지) / 아니면 `stage='calibrating'` → `calibrator.start()`.
   - `isBusy()` 에 `'discovering'` 포함(신규 수집 409 가드).
   - **주의:** 커버리지 산출 위치를 finalize 직후 → **discovery 직후**로 이동(lpd 는 이제 discovery 가 채움).

3. **`src/index.ts`** — 배선.
   - `SetupPipeline` deps 에 `discovery: plateDiscovery` 주입. 단, 현재 `plateDiscovery` 생성(101)이 `pipeline`(96)보다
     **뒤** → 생성 순서 조정 또는 `captureJob`/`calibrator` 와 동일한 **클로저 전방참조**(`onFinished:(s)=>pipeline?.onDiscoverFinished(s)`)로 해소.
   - `new PlateDiscoveryJob({..., onFinished: (s) => pipeline?.onDiscoverFinished(s) })`.

4. **`web/app.js`**(경미) — 파이프라인 상태표시 `renderCaptureStatus` 에 `'discovering'` 라벨 추가(예: "번호판 탐색 중…").
   기능 무관 UI 문자열. `#cap-autochain` 바디·엔드포인트 변경 없음.

- **불변(건드리지 말 것):** CaptureJob.captureTarget LPD 블록(점유 앵커용 유지), Finalizer(점유·front_center 로직),
  PlateDiscovery/cropZoom/plateDiscoveryWriter(탐색 코어), upsertSlotLpd/replaceSlotSetup(스토어).

---

## E. 관찰 가능한 검증 기준 (리더 라이브 확인 — goal/loop)

성공 기준(위장 금지 — 라이브 실증, R6):
1. **연쇄 완주:** `#cap-autochain` on 으로 "시작" → `GET /capture/pipeline` 이
   `capturing → finalizing → discovering → calibrating → done` 순으로 전이(각 단계 관측).
2. **LPD 출처 전환:** discovering 종료 후 `GET /capture/slots` 의 `lpd` 가 **discovery 앵커 loop 산출**과 일치
   (`data/plate_discovery.json` items 의 `lpdOrig` 와 동일 좌표) — 전체프레임 finalize 산출이 아님을 좌표로 확인.
3. **검출수 비교:** discovery `found` 수(`GET /discover/status`)가 동일 프리셋 전체프레임 방식 대비 **같거나 많음**
   (핸드오프 정직 기준 cam1:preset2 5/6 재현, 중복점유 0).
4. **점유·최종화·저장:** finalize 후 `GET /capture/slots` 에 `slot_roi`·`slot3d_front_center`·`occupy_range` 존재,
   `data/setup_artifact.json` 갱신, save 스냅샷 생성.
5. **센터라이징·저장(옵션):** lpd 보유 슬롯>0 이면 `data/slot_ptz.json` + `centering_slot` DB 갱신. lpd 0 이면
   `pipeline.note = '센터라이징 스킵'` + `done`(빈 파일 덮어쓰기 없음, F6).
6. **회귀 0:** `#cap-autochain` off("시작"만) → 기존 수동 3버튼 흐름 그대로(discovery 미발화). `npx vitest run
   --no-file-parallelism` + `npx tsc --noEmit` 그린(기준선 176파일/2019테스트, exit 0).

관찰형 지표(loop 재보정 트리거): found 수 < 기대 / 중복점유 발생 / 앵커 좌표가 판 위로 뜸 → §B 하향앵커 plateH(0.3~0.5) 또는
격자 상수(frac0/shrink/maxSteps) 미세조정 후 재실증.

---

## F. 회귀 · 리스크

| # | 리스크 | 완화 |
|---|--------|------|
| F1 | discovery 가 finalize 뒤 lpd 를 덮어쓸 때 roi/occupy/front_center 훼손 | `upsertSlotLpd` = lpd 컬럼 부분 UPDATE(검증됨, R3). QA 로 타 컬럼 불변 단언 |
| F2 | 콜드 DB(front_center 부재) → discovery found 0 | finalize 를 discovery 앞에 둠(front_center 항상 선-부트스트랩). found 0 이어도 정직 `note` |
| F3 | capture 전체프레임 LPD 제거 유혹 → 점유영역 붕괴 | **capture LPD 유지**(점유 앵커용). 최종 lpd 만 discovery 로 덮어씀 |
| F4 | discovery 단계가 길어져 파이프라인 점유(카메라 경합) | `isBusy()` 에 discovering 포함 → 신규 수집 409. discovery 는 카메라 무이동(원본 크롭 재사용) |
| F5 | PlateDiscoveryJob onFinished 미주입 시 수동 `/discover/ptz` 경로 영향 | 콜백 옵셔널 no-op(회귀 0). 테스트로 수동 경로 그대로 검증 |
| F6 | 파이프라인 실패 격리(discovery error 시 centering 오발화) | `onDiscoverFinished('error')` → `fail` 로 정지(위장 성공 금지) |
| F7 | index.ts 생성순서(pipeline↔discovery) 순환참조 | 기존 captureJob/calibrator 와 동일 클로저 전방참조 패턴 적용 |

---

## G. 미해결 / 가정 (확인 요청)

- **Q1(핵심·순서):** 마스터 나열은 `LPD(1)→점유(2)→최종화(3)` 이나, **앵커(front_center)는 finalize 가 부트스트랩**하므로
  실제 실행은 `finalize→discovery(LPD)` 순이어야 성립. **가정:** 마스터 의도는 "최종 lpd = 앵커 loop 산출"(방법)이지
  "finalize 이전 실행"(문자 순서)이 아니다 → 후보 C 진행. 문자 순서를 반드시 지켜야 하면 warm-DB 전제 후보(A-literal)로
  선회하거나 front_center 선-부트스트랩 단계를 별도 설계해야 함(이중구현 비용). → **자율진행 원칙상 C 로 착수, 이견 시 회신**.
- **Q2(점유영역 소스):** VPD 자동검출 금지(R1) 하에서 `occupy_range` 는 현재 capture LPD plate 클러스터 hit 로만 생성된다.
  마스터의 "점유 영역 만들기"가 (i) 현행 finalize 점유영역(차량/판 앵커 사각형)인지, (ii) LPD 존재→점유 판정(occupied 플래그)인지
  **가정:** (i) 현행 유지. (ii)를 원하면 별도 과업(범위 밖).
- **Q3(finalize 재실행 불요 가정):** discovery 가 lpd 를 DB(slot_setup)+plate_discovery.json 에 persist 하므로 lpd 를 위해
  finalize 를 두 번 돌리지 않는다. `setup_artifact.json` 은 slot_setup.lpd 를 담지 않으므로 discovery lpd 를 artifact 에
  반영할 필요가 있으면 별도 요구로 확인.
- **가정(환경):** 활성 카메라 소스는 시뮬(`simulator-1`) 기준 검증(핸드오프 §5). 실 Hucoms 물리이동은 discovery(무이동 크롭)와
  무관하므로 영향 없음.

---

## H. 핸드오프

- **구현자(developer):** §D 4개 파일. 핵심 = SetupPipeline 에 discovering 단계 + PlateDiscoveryJob onFinished 콜백 +
  index.ts 배선. 탐색/기하/스토어 코어는 **무접촉**. 커버리지 산출을 discovery 직후로 이동.
- **검증자(qa-tester):** setupPipeline.test.ts 에 `capturing→finalizing→discovering→calibrating→done` 전이 +
  discovery error/targets-0 분기 + upsertSlotLpd 타 컬럼 불변 단언. plateDiscoveryJob.test.ts 에 onFinished 통지.
- **문서화(documenter):** 영향 범위 = `pipeline/SetupPipeline.ts`(신규 stage·계약), `calibrate/PlateDiscoveryJob.ts`(콜백),
  `index.ts`(배선), `web/app.js`(라벨). 정책 §2(R1~R6) 준수 근거 명시.
</content>
</invoke>

---

## I. [goal/loop 이터레이션 2 — 리더 라이브 재분석] 점유영역을 discovery LPD 로 생성

### 관찰(사실, 2026-07-20 라이브 count=1 auto-chain)
- 전이 `capturing→finalizing→discovering→calibrating→done` 정상. discovery `found:17/17`(전부 고유 판, 중복 0 — 위장 아님).
- 최종 `slot_setup.lpd` = discovery 앵커 loop 산출과 좌표 일치(plate_discovery.json lpdOrig). **마스터 핵심 목표 달성.**
- 센터라이징 전 프리셋 수렴. slot_ptz.json 갱신, centered=true.
- **틀어짐:** 로그 `"occupancy","accepted":0,"slots":0` → **occupy_range = null**(마스터 순서 2번 "점유 영역 만들기" 미산출).

### 근본원인
- Finalizer 의 occupy_range 는 **capture 전체프레임 LPD accepted 클러스터**(hit)에서만 생성(Finalizer.ts:254). VPD off + 전체프레임 LPD 희소 → hit 0 → occupy_range null. (clusterMinSupport=1 이라 지지수 문제 아님, 검출/필터 희소가 원인.)
- 마스터 순서상 "점유 영역"은 "LPD 찾기" 직후 → **발견된 LPD 로부터 점유영역을 만드는 것이 의도.** 이제 discovery 가 슬롯별 LPD 를 신뢰성 있게 채우므로, 점유영역을 그 판 quad 로 결정형 생성함이 옳다.

### 결정(외과적·결정형·정책 준수)
- `PlateDiscoveryJob.saveSlotLpd`: found 슬롯의 `lpdOrig`(판 quad)로 **occupy_range = `buildPlateAnchoredQuad(quadBoundingRect(lpdOrig), lpdOrig)`**(floorRoi.ts, Finalizer 판-only 경로와 동일 재사용) 계산 → 행에 동봉.
- `SqliteStore.upsertSlotLpd` + `SlotLpdRow`: `occupy_range` 컬럼도 **부분 UPDATE**(`SET lpd_obb=?, occupy_range=?, updated_at=? WHERE slot_id=?`). found 슬롯만 갱신, 미검출은 스킵(기존 값 보존 — wipe 없음).
- 정책 준수: 부분 UPDATE(R3) · stringify5(R4) · 결정형·LLM 무(R2) · VPD off 유지(R1) · 위장 금지(found 만 저장, R6). 오버레이 삭제 없음(retain 정책).
- **불변:** Finalizer occupy_range 경로(capture hit 있으면 그대로 — 회귀 0). discovery 는 finalize 뒤라 최종 occupy_range 는 판이 있으면 discovery 산출로 갱신.

### 검증기준(추가)
- 재실행 후 `GET /capture/slots` 의 found 슬롯 `occupyRange != null`, 좌표가 판 quad 를 감싸는 사변형. 미검출 슬롯은 null(정직).
