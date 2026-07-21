# 01 ARCHITECT — 정밀수집 센터라이징 슬롯순서·중복제거·최종저장 설계

> 입력: `_workspace/00_goal.md`(리더 확정 근본원인) + 코드 재검증. B-mode(goal/loop) 1번 단계.
> 제약(불변): VPD off 유지 · 결정론(LLM 무) · 부분 UPDATE(slot_setup wipe 금지) · stringify5 · 외과적 최소 · **PlatePtz/controlMath 코어 무접촉**(import 재사용만).

---

## 0. 한줄결론 + 추천안

**슬롯별 "LPD Box 중심 → 화면중앙" 선조준(pre-aim) PTZ 를 결정형으로 산출해 `centerOnPlate` 시작점으로 넘기고(R1), 저장 게이트를 `centered`-only 로 완화(R2)하고, 잡 종료부에서 `save/Setup_*.json` 스냅샷을 1회 기록(R3)한다. 세 변경은 전부 `PtzCalibrator.run/calibrateSlot/saveCenteringSlots` 안에서 이뤄져 수동·auto-chain 양 진입점을 한 지점으로 커버한다(C).**

### 코드 재검증으로 확정한 사실(신뢰+검증)
1. **R1 원인 = 공유 시작 PTZ**(중복 프리셋 prior 아님). DB 실측: preset2 슬롯 8~13 LPD 중심 `cx = 0.096 / 0.212 / 0.325 / 0.464 / 0.62 / 0.766` — **서로 뚜렷이 다르다**(0.11~0.15 간격). 그런데 `slot_ptz.json` 증거에서 slot11/12/13(=preset2 pslot4/5/6, 서로 다른 prior)이 **동일 PTZ 55.44 로 수렴**했다. → prior 는 구분되는데 결과가 겹친다 = **공유 넓은-FOV 시작점에서 폐루프가 이웃으로 갈아탐**. `startPtzFor` 가 프리셋 base PTZ(preset1 ≈ pan29.52/tilt9.45/zoom1.69, slot5 미검 흔적으로 확인)를 모든 슬롯에 반환하는 것이 유일 원인. **prior 가 구분되므로 pre-aim 은 유효**(만약 prior 가 중복이면 pre-aim 도 같은 latch — 이 경우가 아님을 실측으로 배제).
2. **centerOnPlate 초기 prior**: `captureAndDetect(..., o.plateRoi, null)` — 넓은 FOV·큰 초기오차에서 첫 스텝이 커 예측추적(matchRadius 0.08)이 이웃으로 이탈. pre-aim 으로 대상을 화면중앙 근처에 두면 초기오차↓→스텝↓→예측 정확→lock 유지.
3. **R2**: `saveCenteringSlots` 가 `!it.centered || !it.converged` 로 스킵 → pan/tilt 는 맞았는데 zoom 폭만 못 맞춘(`centered:true,converged:false`) 슬롯이 DB 누락(증거 slot1/2). `centered:false`(번호판 자체 미검, slot5) 는 저장 안 하는 게 옳다(오염).
4. **R3**: 센터링 결과가 `save/` 스냅샷 부재. `result_*.json`(Finalizer)은 센터링 前 SetupArtifact.
5. **양 진입점 공통 통로 확인**: 수동 `/calibrate/ptz`→`calibrator.start()`, auto-chain `SetupPipeline.onDiscoverFinished`→`calibrator.start()` 모두 `run()` 통과. → run/calibrateSlot 안에 넣으면 라우트/파이프라인 수정 0.

---

## A. 최소변경 파일 : 함수 시그니처 (구현자 전달)

> 결정형 도구(수치반복 폐루프)에 속하는 변경 — LLM 두뇌 무관. 새 기하코드 최소화: `controlMath`(scaleGainForZoom/panTiltCorrection)·`geometry.center` **재사용**.

### A-1. `src/calibrate/PtzCalibrator.ts` (핵심)
- **import 추가**: `scaleGainForZoom, panTiltCorrection` from `./controlMath.js`; `center` from `../domain/geometry.js`; `setupSaveName` from `../store/SaveStore.js`. (모두 기존 순수/헬퍼 — 코어 무접촉.)
- **생성자 dep 추가(옵셔널·가산)**: `saveStore?: Pick<SaveStore, 'saveSnapshot'>`. 미주입 시 스냅샷 no-op(수동 흐름/테스트 회귀 0). `this.saveStore` 보관.
- **신규 private** `preAimPtz(t: PlateTarget, base: Ptz): Ptz`
  - `const g = scaleGainForZoom({ gainPan: cfg.fallbackGainPanDeg, gainTilt: cfg.fallbackGainTiltDeg, zoomRef: 1 }, base.zoom)`
  - `const c = center(t.plateRoi)` (plateRoi 는 이미 `quadBoundingRect` rect)
  - `const err = { errX: c.cx - 0.5, errY: c.cy - 0.5 }`
  - `const pt = panTiltCorrection(err, g, base.pan, base.tilt, PREAIM_MAX_STEP)` — **coarse 큰 스텝**용 `PREAIM_MAX_STEP` 상수(예 90°; cfg.maxStepDeg=5 는 너무 작아 재사용 금지).
  - `return { pan: pt.pan, tilt: pt.tilt, zoom: base.zoom }` — **zoom 불변**(넓은 시야 유지, 센터링은 zoom 안 건드림).
  - 부호 검증 완료: errX>0(우측 박스)·gainPan<0(−62/z) → `-errX·gainPan>0` → pan↑(우향) = detectMath `vehicleCenterZoomPtz` 와 동일 방향.
- **수정** `calibrateSlot(t)`:
  - `const base = await this.startPtzFor(t);` (프리셋 base — 캐시 유지, 이름/역할 그대로)
  - `const startPtz = this.preAimPtz(t, base);`  ← 슬롯마다 **다른** 시작점
  - `centerOnPlate` 호출에 `plateRoi` **미전달**(= PlatePtz 기본 `{0.5,0.5,0,0}` = 화면중앙 최근접). pre-aim 후 대상이 중앙 근처 → 초기 pick = 중앙 최근접 = 그 슬롯 판.
    → `this.makePlatePtz(base_opts).centerOnPlate(t.camIdx, t.presetIdx, startPtz)` (opts 에서 plateRoi 제거).
  - zoom 단계(`plateRoi: quadBoundingRect(c.plate.quad)`, `gain: c.gain`)는 **무변경**.
- **수정** `saveCenteringSlots(items)`: 게이트를 `if (!it.centered) continue;` 로(=`&& !it.converged` 제거). DB `centered:1` 유지(스키마에 zoom-수렴 컬럼 없음 — 그 뉘앙스는 slot_ptz.json 의 converged/reason 이 정본). `globalIdx==null` 스킵·키 UPDATE·round5 그대로.
- **수정** `run(targets)`: `writer(...)` + `saveCenteringSlots(items)` 직후, **done 경로에서만** best-effort 스냅샷 1회:
  - `try { this.saveStore?.saveSnapshot(setupSaveName(new Date()), buildSlotPtzJson(items, this.now())); } catch (e) { logger.warn(... 'Setup 스냅샷 저장 실패(격리)'); }`
  - error 경로(잡 예외)는 스냅샷 미기록(부분·불신).

### A-2. `src/calibrate/slotPtzWriter.ts` — 슬롯 asc 순서 보장(R1 순서)
- **수정** `expandPlateTargetsFromSlotSetup(views)`: 반환 직전 정렬 추가
  `targets.sort((a, b) => a.camIdx - b.camIdx || a.presetIdx - b.presetIdx || (a.globalIdx! - b.globalIdx!))`
  - `globalIdx` = 정수 slot_id(항상 존재, slot_setup 유래). **주차면번호 asc** 를 결정형 보장.
  - **`getSlotSetup` 의 `ORDER BY` 는 건드리지 않는다**(뷰어/dbOverlay 등 공유 소비자 blast radius 회피 — 외과적). preset_slotidx NULL 가능성은 slotId 정렬로 무력화(NULL tie-break 불필요).

### A-3. `src/store/SaveStore.ts` — Setup_ 이름 + 스냅샷 writer(가산)
- **신규** `export function setupSaveName(date = new Date()): string` → `Setup_YYYYMMDD_HHMMSS`(로컬 시각, `defaultSaveName` 미러).
- **신규 메서드** `saveSnapshot(name: string, data: unknown): string` — `sanitizeName`→`stringify5(data,2)`→`save/{safe}.json` 기록 + `reportsDir` best-effort 미러. **기존 `save(name, SetupArtifact)` 무변경**(SetupArtifact 타입 제약 존중 — 스냅샷은 SetupArtifact 아니므로 `save()` 강제 안 함).

### A-4. `src/index.ts` — 배선 1줄
- `new PtzCalibrator({ camera, lpd, cfg: tools.calibrate, store: sqlite, onFinished: ..., saveStore })` — 이미 생성된 `saveStore`(48행) 주입. 이 한 줄로 **양 진입점**(수동/auto-chain) 모두 스냅샷 반영(C).

### 저장 3중 요약
| 대상 | 산출 | 변경 |
|---|---|---|
| (a) `save/Setup_*.json` | 센터링 결과 `SlotPtzArtifact`(items, centered/converged/reason 포함) 스냅샷 | **신규**(A-1 run + A-3 + A-4) |
| (b) DB `slot_setup` | `centered:true` 슬롯 pan/tilt/zoom/centered 부분 UPDATE | 게이트 완화(A-1 saveCenteringSlots) |
| (c) `data/slot_ptz.json` | 전 items(현행) | **무변경**(회귀 0) |

---

## B. 검증 기준

### B-1. vitest 결정형(sim 불요 — 이번 라운드 확정 대상)
1. **pre-aim 수학**: `preAimPtz` 순수성 — base{pan,tilt,zoom} + 박스중심 → 기대 pan/tilt 반환. 특히 **서로 다른 박스중심 → 서로 다른 pre-aim PTZ**(anti-latch 속성). zoom == base.zoom 불변. 부호(우측박스→pan↑) 확인.
2. **anti-duplication 로직**: `makePlatePtz` 스텁을 "startPtz 가 함의하는 화면중앙 최근접 판을 반환"하도록 구성 → 인접 두 슬롯(구분 prior)이 **서로 다른 최종 PTZ** 산출. 스텁이 `centerOnPlate` 인자(startPtz, plateRoi)를 캡처해 startPtz==preAim·plateRoi==center(미전달) 검증.
3. **순서**: `expandPlateTargetsFromSlotSetup` 에 (preset_slotidx NULL·역순 섞은) views 입력 → 반환 targets 가 (camIdx, presetIdx, globalIdx) asc. run() 처리 순서(status.current 단조)는 배열순=정렬순으로 귀결.
4. **R2 게이트**: `saveCenteringSlots` — `{centered:true,converged:false}` item 이 `upsertSlotCentering` rows 에 **포함**, `{centered:false}` 는 **제외**, `globalIdx:null` 제외. (store 스텁으로 rows 캡처.)
5. **R3 스냅샷**: `saveStore` 스텁 주입 → run() done 시 `saveSnapshot(setupSaveName, artifact)` **1회** 호출(이름 `Setup_` prefix 정규식·payload=items). error 경로에선 **미호출**. `setupSaveName(고정 Date)` 포맷 단위테스트.
6. **saveStore 미주입 회귀 0**: 기존 생성자 호출(수동/테스트)이 saveSnapshot no-op 로 통과.
7. **SaveStore.saveSnapshot**: 임시 dir 에 stringify5 JSON 기록·reports 미러·sanitize(경로 traversal 차단) — 파일 IO 단위테스트.

### B-2. 라우트/데이터 실측(경계면 교차)
- `/calibrate/ptz`(수동) 발화 후 `data/slot_ptz.json` 순서·항목, DB `slot_setup` centered 행, `save/Setup_*.json` 존재를 실데이터로 확인(모킹 카메라/LPD).

### B-3. 라이브 한계(은닉 금지)
- **시뮬레이터 13100 DOWN** → **실 PTZ 물리 수렴·pre-aim 이 실카메라에서 정말 정판을 중앙에 두는지·비-cam1 게인 정확도는 이번 검증 불가**. B-1/B-2(순서·pre-aim 산출·저장 3중·게이트)는 결정형으로 확정하고, 위 항목은 **라이브 검증 필요 항목으로 명시**(위장 성공 금지). fallback 게인(−62/−35.5)은 cam1 실측 — 타 카메라 pre-aim 은 coarse 라 게인 50% 오차에도 이웃 disambiguation(간격 0.11~0.15 의 절반 0.07)엔 충분하나, 최종 확증은 라이브.

---

## C. 회귀 / 리스크
- **R-1 (a2 미채택 트레이드오프)**: `save/Setup_*.json` 은 `SlotPtzArtifact`(a1) — SetupArtifact 아님. `/capture/saves` 목록엔 뜨지만 "열기"(SetupArtifact 파싱) 라우트로 열면 뷰어가 렌더 못 함. **의도된 한계**: Setup_ 은 감사/아카이브용 스냅샷, 뷰어 열기 대상은 `result_*.json`(SetupArtifact) 유지. → **미해결 D-1 참조**(Master 가 병합 정본 원하면 a2).
- **R-2 (게이트 완화 부작용)**: `centered:true,converged:false` 슬롯의 zoom 값은 best-effort(포화/미달). ActionAgent 조준 prior 로는 pan/tilt 가 핵심이라 허용. 정밀 converged/reason 은 slot_ptz.json 이 보존. 재-run 시 converged→centered-only 퇴행하면 DB 가 최신값으로 갱신(DB 정본 정책 정합).
- **R-3 (pre-aim 게인 의존)**: pre-aim 은 fallback 게인 cam1 특화값 의존. 비-cam1 에서 pre-aim 부정확 가능 — 단 coarse disambiguation 목적이라 민감도 낮음(R-2 리스크보다 라이브 확증 필요). PlatePtz 내부 probe 가 이후 정밀 게인 자가교정.
- **무접촉 확인**: PlatePtz·controlMath 함수 본문·시그니처 **불변**(import만). VPD 경로·Finalizer·discovery 무접촉. `getSlotSetup` ORDER BY 불변(공유 소비자 안전). stringify5·round5·부분 UPDATE 원칙 유지.
- **성능**: pre-aim 은 슬롯당 순수계산 1회(카메라 호출 0 추가 — centerOnPlate 의 startPtz 만 교체). 스냅샷은 잡당 파일 1회.

---

## D. 미해결 / 가정 (리더 확인 요청)
- **D-1 (a1 vs a2, 권고=a1)**: `save/Setup_*.json` 내용을 **(a1) 센터링 SlotPtzArtifact 스냅샷**(권고 — 최소변경·items 재사용) 으로 할지, **(a2) DB `slot_setup` 뷰(기하+PTZ 병합) 정본 스냅샷**(더 충실하나 SetupArtifact 생태계와 shape 충돌·getSlotSetup 재조회) 으로 할지. 둘 다 "열기" 라우트와는 shape 불일치. **가정: a1 채택.** Master 가 "완전한 최종 셋업 1파일(기하+PTZ)"을 원하면 a2 로 전환(변경점: run() 에서 `getSlotSetup()` 스냅샷, +약간의 코드). → 리더 판단 요청.
- **D-2 (pre-aim maxStep)**: `PREAIM_MAX_STEP` 상수값 가정 90°(정상 오프셋 ~18° 이내라 미클립, 이상 게인 방어 상한). 이견 시 조정.
- **D-3 (전제)**: 실행 시 slot_setup 에 LPD prior 가 채워져 있어야 pre-aim 대상 존재(현 DB: preset2 만 lpd 有, preset1/3 은 null → discovery 재실행 후 센터링 순서 유효). auto-chain 은 discovery→calibrate 순이라 충족. 수동 단독 `/calibrate/ptz` 는 사전 discovery 필요(기존과 동일 전제).
- **D-4 (라이브 확증 이월)**: sim 13100 UP 시 pre-aim 실판 중앙화·중복 소멸·순서 단조를 라우트 실측으로 최종 확인(이번 라운드 범위 밖).

---

## 구현 순서(검증 첨부)
1. `controlMath`/`geometry` import + `preAimPtz` 추가 → **검증**: preAimPtz 순수 단위테스트(B-1.1).
2. `calibrateSlot` startPtz=preAim·plateRoi=center 교체 → **검증**: 스텁으로 인자 캡처·anti-dup(B-1.2).
3. `expandPlateTargetsFromSlotSetup` 정렬 → **검증**: 순서 단위테스트(B-1.3).
4. `saveCenteringSlots` 게이트 완화 → **검증**: rows 포함/제외(B-1.4).
5. `SaveStore.setupSaveName`+`saveSnapshot` → **검증**: 파일 IO·이름 포맷(B-1.7).
6. `run()` 스냅샷 호출 + `index.ts` saveStore 배선 → **검증**: done/​error 호출/미호출·미주입 no-op(B-1.5,6).
7. 라우트 실측(B-2). 라이브(B-3)는 한계 명시로 종결.
