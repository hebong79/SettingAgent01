# 설계: 센터라이징 버튼 개명 + PtzCalibrator→PlatePtz 위임 + slot_ptz.json/DB(centering_slot) 이중 저장

작성: 2026-07-16 / 설계자(architect)
브랜치: `feat/vpd-seg-cuboid` (메인 리포 `D:\Work\Parking3D\AgentVLA\ParkAgent\SettingAgent`)
선행 문서: `_workspace/plate-ptz/01_architect_plan.md`(PlatePtz 설계 r2), `_workspace/plate-ptz/04_doc_impact.md`(후속과제 ① 지목)

> ## 3줄 요약
> 1. UI 노출 문구만 "캘리브레이션"→"센터라이징"으로 바꾸고(id/라우트/핸들러명 불변), `/calibrate/ptz` 잡의 A/B 자체 제어루프를 **라이브 검증된 `PlatePtz` 위임 + gain 체이닝**으로 교체한다. `platePtz.ts` 자체는 0줄 변경.
> 2. **LLM 자문(advise) 배관은 삭제를 권고한다** — 아키텍처 확정 결정("실시간·고빈도·수치반복 루프 = 결정형 도구", 전체아키텍처 설계서 §8.2:191·§8.4)과 정면 충돌하며, 실기동 이력이 사실상 0이고(아래 §1), 반복당 LLM 비전 호출(타임아웃 30s)×최대 30회/슬롯은 배치 작업에 구조적으로 부적합하다. (본 설계의 최대 판단점 — §4)
> 3. 저장은 기존 JSON 계약(`SlotPtzArtifact`) 불변 + `SqliteStore`에 `centering_slot` 테이블 신설(**성공 항목만, upsert 멱등** — 부분 캘리브레이션 시 타깃 외 행 보존). DB 는 생성자 옵셔널 DI, 미주입 시 JSON 만(기존 테스트 생성 방식 보존).

---

## 0. 실행 계획(단계 → 검증)

```
1. [UI 문구] index.html 3곳 + app.js 안내 1곳            → 검증: 화면 문구 변경, id/fetch 경로 diff 0
2. [config] fallbackGain −62/−35.5 정정, llmAdvise 제거    → 검증: config.test 갱신 green, zod parse 통과
3. [PlateTarget/expand] presetSlotIdx 파생 추가            → 검증: slotPtzWriter 신규 케이스 (T9)
4. [SqliteStore] centering_slot DDL + upsert/get           → 검증: 스토어 단위 케이스 (T12), 2회 실행 행수 불변
5. [PtzCalibrator] calibrateSlot → PlatePtz 위임 재작성     → 검증: T1~T6 (특히 gain 체이닝 관찰 T1)
6. [index.ts] store: sqlite 주입, brain 제거               → 검증: typecheck + 기동 스모크
7. [테스트 정리] LLM 자문 케이스 제거·cfg 리터럴 갱신        → 검증: npm test 전량 green (기준 1667 − 삭제분 + 신규분)
8. [경험적 검증] setup_artifact 복원 후 라이브 1슬롯 왕복    → 검증: /calibrate/ptz → slot_ptz.json items>0 + DB 행 + 재관측 err≤0.03
```

---

## 1. items:[] 원인 규명 — 결론 (실물 근거)

**결론: 리더 가설은 참이나 실제는 더 강한 형태다 — `plateRoiByPreset` 부재 수준이 아니라 `data/setup_artifact.json` 의 `slots` 배열 자체가 완전히 비어 있다.**

실물 증거:
- `data/setup_artifact.json` (353 bytes, `createdAt: 2026-07-15T13:40:46Z`): `presets:[]`, `slots:[]`, `globalIndex:[]`. report 필드에 LLM 이 직접 "총 슬롯도 0개" 라고 기록.
- `expandPlateTargets`(slotPtzWriter.ts:20) 는 `artifact.slots` 를 순회 — 빈 배열이므로 **타깃 0건** → `start()` 가 `total:0` 반환 → `run([])` → `buildSlotPtzJson([])` → `{"createdAt":"2026-07-16T10:35:44Z","items":[]}` (현재 파일과 정확히 일치).
- 즉 "버튼 눌러도 아무것도 안 나온다"의 진짜 원인은 **캘리브레이션 코드가 아니라 입력 데이터(빈 setup_artifact)** 다. 2026-07-15 의 마지막 finalize 가 채택 클러스터 0건인 상태로 정본을 덮어썼다(Finalizer.ts:208 `repo.saveArtifact`). 참고로 DB `parking_slots` 에는 run 92 산출 527행(프리셋 PTZ 포함)이 살아 있고, `save/result_202607xx.json`(finalize 자동 스냅샷, 최대 51KB)들이 존재한다 — 복원 재료는 있다.

**설계 함의**: 이번 리팩토링은 0-타깃 문제를 고치지 않는다(입력 데이터 문제). 라이브 검증(§10)에는 `save/result_*.json` 을 `/mapping` POST(server.ts:49 `repo.saveArtifact` 경유, validateArtifactBody 통과 필요)로 복원하거나 재-finalize 가 선행돼야 한다. UI 에는 `total===0` 일 때 원인을 알려주는 안내 1줄을 추가한다(§5-1 — 소폭 범위 확장, 마스터가 거부하면 제외 가능).

---

## 2. 시작 PTZ 정본 출처 — 결정 (실물 근거)

**결정: `detectPipeline.resolvePresetPtz(camera, camIdx, presetIdx)` (src/capture/detectPipeline.ts:212) 를 정본으로 사용한다.** 프리셋 키(`${cam}:${preset}`)별 1회 조회 캐시(Finalizer.ts:227 `ptzByKey` 패턴 미러). 조회 실패/null 이면 `{pan:0,tilt:0,zoom:1}` 폴백 + `logger.warn`(조용한 강등 금지).

후보 비교(전부 실물 확인):

| 후보 | 실물 상태 | 판정 |
|---|---|---|
| `Preset.pan/tilt/zoom` (setup_artifact) | **Finalizer.ts:349 가 presets 에 PTZ 를 넣지 않는다** — `presets.push({camIdx, presetIdx, label, coveredSlotIds})`. 옵셔널 필드가 실제로는 항상 비어 있음 | 기각(정본 아님) |
| `config/camerapos.json` 직접 read | cam1 프리셋 3개(pan 22/56.6/43.5 …) 실재. 그러나 파싱 로직(`parseCameraViews`+`buildCameraList`)이 이미 존재 — 직접 read 는 중복 구현 | 기각(간접 사용) |
| `resolvePresetPtz` → `camera.listCameras()` | `RpcCameraClient.listCameras`(RpcCameraClient.ts:94)가 **camerapos.json 을 매 호출 fresh read** — 결국 camerapos 가 물리 정본이고 이 함수가 공식 접근 경로. Finalizer(:233)·runDetect(:245)가 이미 같은 방식 사용. DB parking_slots 의 pan/tilt/zoom(43.5/18.8/1.46583)이 camerapos 값과 일치함을 실물 확인 — 경로 검증 완료 | **채택** |

배선 판단: **`PlateTarget` 에 startPtz 를 싣지 않는다** — `expandPlateTargets` 는 artifact 순수 함수로 유지(비동기 조회 오염 금지). PtzCalibrator 가 슬롯 처리 시점에 조회한다(별도 provider DI 도 불요 — camera 가 이미 deps 에 있다). 기존 테스트의 모킹 camera 는 `listCameras` 가 없지만 `resolvePresetPtz` 는 내부 try/catch 로 null 을 반환(detectPipeline.ts:225)하므로 **기존 테스트는 폴백 0/0/1 로 그대로 green**(모킹 모델이 0/0/1 시작 전제로 작성돼 있음 — ptzCalibrator.test.ts:39).

부수 확인(리더 요청): PlatePtz 기본 fallback −62/−35.5 의 zoomRef=1 정합 — **검증 완료**: −36.6×1.69341=−61.98≈−62.0, −21.0×1.69341=−35.56≈−35.5. 즉 PlatePtz 기본값은 실측(@z1.69341)의 zoomRef=1 환산값이 맞다. config 정정값도 이 기준을 따른다(§6).

---

## 3. PlatePtz 위임 후 PtzCalibrator 의 책임 경계

### 남는 것 (PtzCalibrator 소유 유지)
- 잡 상태머신(`idle/running/done/error`), 중복 시작 거부, 진행률(done/total/current), `getStatus()`
- 대상 펼침(`expandPlateTargets` + slotIds 필터) 및 `presetSlotIdx` 파생 전달
- 시작 PTZ 해석(resolvePresetPtz + 키별 캐시 + 폴백)
- 슬롯별 PlatePtz 호출 오케스트레이션(center → **gain 체이닝** → zoom)과 `PlatePtzResult`×2 → `SlotPtzItem` 매핑
- artifact 조립(`buildSlotPtzJson`) + writer(JSON) + **DB upsert(신규, best-effort)**
- 슬롯 예외 흡수(reason:'error') — 기존 패턴 유지

### 사라지는 것 (위임으로 고아 — 제거)
- `calibrateSlot` 의 A/B 자체 루프 전체, `probeGain`(:224), `captureAndDetect`(:243), `applyCenterAdvice`(:275), `applyZoomAdvice`(:291)
- `advise`(:251) + `ADVISE_ZOOM_MIN/MAX`(:38-39) + `brain` dep + `CenteringAdvice` import — **LLM 자문 삭제 권고(§4)에 따름**
- module-private `IMPROVE_EPS`(:315)·`improvement`(:322)·`clampStep`(:317)
- controlMath import 중 위임 후 미사용분(`plateCenterError`/`pickNearestPlate`/`estimateGain`/`panTiltCorrection`/`zoomCorrection`/`isCentered`/`isWidthConverged`/`dampGain`) — `buildSlotPtzJson` 과 `quadBoundingRect`(zoom 단계 prior 산출용, §7)는 유지

### 후속과제 ② (improvement/IMPROVE_EPS 승격)에 대한 판단 변경
04_doc_impact.md §4-② 는 "controlMath 로 승격 단일화가 옳다"고 기록했으나, 그 전제는 **양쪽 사본이 공존**하는 상황이었다. 이번 위임으로 PtzCalibrator 쪽 사본이 고아가 되어 **삭제**되면 platePtz.ts 의 사본이 유일본이 된다 — 중복이 소멸하므로 **승격 자체가 불필요**해진다. controlMath 무접촉(변경 0줄)이 더 단순하고 회귀면도 좁다. **승격하지 않는다.**

### 기존 대비 의미 변화 1건 (명시)
구 코드는 A 루프가 반복 상한으로 끝나 `centered=false` 여도 B(zoom)를 시도했다. 신 설계는 **centerOnPlate 실패(ok:false) 시 zoom 을 시도하지 않는다** — 미중심 상태의 zoom-in 은 중심 오차를 배율만큼 확대해 대상을 날리는 물리(plate-ptz 설계 §2.3, 라이브 C 실패 실측)가 확인된 경로다. 실패는 reason 으로 정직하게 기록하는 편이 낫다.

---

## 4. ★ 최대 판단점: LLM 자문(advise) — **삭제 권고**

### 실물 확인 결과
| 항목 | 실물 |
|---|---|
| config 기본값 | `tools.config.json:74` `"llmAdvise": true`, `DEFAULT_TOOLS_CONFIG` 도 true — 명목상 활성 |
| 구현 존재 | `AgentRuntime.adviseCentering`(AgentRuntime.ts:331) 구현됨, 프롬프트 `config/prompts/ptz_centering.yaml`, llm.config `centering` 섹션 존재, llm.enabled=true |
| 실기동 이력 | **사실상 0 으로 추정** — calibrate 잡은 타깃이 있어야 자문 경로에 진입하는데, 현 setup_artifact 는 빈 상태고 `slot_ptz.json` 은 items:[](§1). 과거(7/3~7/7 finalize 스냅샷 존재 시기)에 실행됐는지는 **기록이 없어 불확실** — 단 실행됐다면 slot_ptz.json 에 흔적(items)이 남았어야 한다 |
| 비용 구조 | `advise` 는 매 반복 `requestImage` 1회 + LLM 비전 호출 1회(타임아웃 30s). maxIterations 15 × 2단계 = **슬롯당 최대 30회 LLM 호출**. 20슬롯 배치면 600회 — 셋업타임 배치 작업에 구조적으로 부적합 |
| 아키텍처 정합 | 전체아키텍처 설계서(Docs/20260624_162408) §8.2:188·:191 "**센터라이징(줌 20% 반복)·PTZ 미세이동 = 결정형 도구**", §8.4 "centering.run (결정형 제어루프)" — 반복 루프 내 LLM 자문은 **확정 설계 결정과 충돌** |
| 대체 가능성 | 자문의 고유 가치는 `occluded`(가림) 판정뿐인데, PlatePtz 의 `no_plate`/`plate_lost`(검출 소실 = 결정형 판정)가 기능적으로 동일 결과(스킵+사유 기록)를 낸다. `suggestPan/Tilt/ZoomFactor` 는 라이브 검증에서 결정형 P 제어만으로 goal 충족이 입증돼 잉여 |

### 선택지 비교
| 안 | 내용 | 평가 |
|---|---|---|
| (a) **삭제** | PtzCalibrator 자문 배관 + `cfg.llmAdvise` 스키마 제거. brain 계층(SetupBrain.adviseCentering·AgentRuntime 구현·프롬프트·llmConfig.centering)은 **보존**(공유 인터페이스·자체 테스트 보유 — agentRuntimeCentering.test.ts 등 green 유지) | **권고**. 아키텍처 정합 + 단순함(§2) + 검증된 결정형 루프. 테스트 3파일 소폭 수정 필요(§9) |
| (b) PlatePtz 에 옵션 주입 | PlatePtz 에 brain 옵션 추가 | 기각 — 라이브 검증된 모듈(0줄 변경 원칙)에 자문을 넣으면 예측 prior 추적 루프와 자문 제안이 충돌하고, plate-ptz 설계 §5 "LLM 자문 의도적 배제(결정형 도구)" 결정을 뒤집는다 |
| (c) PtzCalibrator 가 감쌈 | 위임 전후에 자문 삽입(예: 슬롯당 1회 occluded 사전판정) | 기각 — PlatePtz 는 원자 폐루프라 반복 중간 개입 불가, 슬롯당 1회 사전판정은 발명(요청에 없는 신규 기능) + `no_plate` 와 중복 |

### 권고안 (a) 의 삭제 범위 — 정확히
- `PtzCalibrator.ts`: advise/applyCenterAdvice/applyZoomAdvice/ADVISE_ZOOM_MIN/MAX/brain dep/CenteringAdvice·SetupBrain import 제거.
- `toolsConfig.ts`: `CalibrateSchema.llmAdvise` 필드 + `DEFAULT_TOOLS_CONFIG.calibrate.llmAdvise` 제거(zod 비-strict 객체라 기존 config 파일의 잔존 키는 조용히 무시됨 — 파싱 비파괴). `tools.config.json:74` 의 `"llmAdvise": true` 줄도 제거(정직한 config).
- **보존(무접촉)**: `SetupBrain.adviseCentering` 인터페이스·`AgentRuntime.adviseCentering` 구현·`config/prompts/ptz_centering.yaml`·llmConfig `centering` 스키마·해당 brain 테스트 3파일. 이들은 이번 변경으로 **소비자가 없어지는 고아**가 되지만, 다른 계층(공유 brain 계약)이며 삭제 파급(llmConfig 스키마·프롬프트 자산)이 커서 별도 결정 사안으로 보존+보고한다(CLAUDE.md §3 절충 — 영향도 문서에 데드코드로 명기).
- 기존 데드코드 발견(삭제 금지, 언급만): `src/calibrate/types.ts:49-60` 의 `CenteringAdvice` 인터페이스는 **이미 아무도 import 하지 않는 사본**(실사용은 SetupBrain.ts:197 zod 유도형)이다. 이번 변경과 무관한 기존 데드코드 — 손대지 않는다.

**이 판단점은 기능 삭제이므로 리더/마스터 컨펌 대상이다. 단, 마스터 Requirements 2 의 "위임으로 고아가 된 코드만 제거" 문구상 자문 배관은 위임의 직접 고아에 해당하여 권고안이 요구사항과 정합한다.**

---

## 5. Requirements 항목별 설계 (마스터 지정 불변 제약 대조)

### 5-1. UI (Req 1) — 노출 문구만
| 위치 | 현재 | 변경 |
|---|---|---|
| `web/index.html:208` | `<h3>PTZ 캘리브레이션</h3>` | `<h3>센터라이징</h3>` |
| `web/index.html:209` | `주차면별 번호판 중심정렬·줌 → <code>slot_ptz.json</code>` | **유지+확장**: `주차면별 번호판 중심정렬·줌 → <code>slot_ptz.json</code> · DB <code>centering_slot</code>` (동작이 실제로 DB 저장을 겸하게 되므로 설명이 정직해야 함) |
| `web/index.html:213` | `캘리브레이션 시작` | `센터라이징 시작` |
| `web/index.html:205` 주석 | `PTZ 캘리브레이션: …` | `센터라이징: …` (주석 — 문구 일관성) |
| `web/app.js` calStart(:2020) | `시작됨 (대상 ${data.total} 슬롯)` | total===0 이면 `대상 0 — 셋업 산출물에 번호판 ROI 슬롯이 없습니다(최종화 필요)` 안내로 분기 (§1 의 실사용 혼란 직결 — 3줄. 범위 확장으로 판단되면 제외 가능) |

**불변**: `id="cal-start"`·`cal-bar/label/msg/summary`·`/calibrate/*` 라우트·`calStart/calPoll/renderCalResult` 함수명·등록부(app.js:2842) 전부 무변경.

### 5-2. 동작 연결 (Req 2) — 위임 + gain 체이닝
신 `calibrateSlot(t)` 의사코드:
```
1. startPtz = await this.startPtzFor(t)                    // §2. 키별 캐시, 실패 → {0,0,1}+warn
2. c = makePlatePtz({ ...baseOpts, plateRoi: t.plateRoi }).centerOnPlate(t.camIdx, t.presetIdx, startPtz)
3. c.ok === false → toItem(t, c.ptz, c.plateWidth??0, centered:false, converged:false, reason:c.reason)
4. z = makePlatePtz({
       ...baseOpts,
       plateRoi: quadBoundingRect(c.plate.quad),           // ★ zoom 초기 prior = 센터링 후 마지막 관측 위치.
                                                           //   t.plateRoi(센터링 前 위치)를 그대로 쓰면 이동한 화면에서
                                                           //   이웃 번호판을 초기 선정할 위험 — 반드시 갱신한다.
       gain: c.gain,                                       // ★ 핵심: 실측 게인 체이닝 → platePtz.ts:267-273 의
     }).zoomToPlateWidth(t.camIdx, t.presetIdx, c.ptz)     //   무측정 fallback 1차 의존 경로 자체가 소멸
5. → toItem(t, z.ptz, z.plateWidth??c.plateWidth??0, centered:true, converged:z.ok, reason:z.ok?undefined:z.reason)
```
- PlatePtz 는 인스턴스별 opts(무상태·경량)이므로 **슬롯당 인스턴스 2개 생성**이 per-call 오버라이드 API 추가(PlatePtz 변경)보다 낫다 — platePtz.ts 0줄 변경 유지.
- `makePlatePtz` 는 생성자에서 준비하는 내부 팩토리이되 `deps.makePlatePtz?` 로 **옵셔널 DI**(기본 = `new PlatePtz({camera, lpd, sleep}, opts)`). 용도: T1(체이닝 관찰) 테스트 시임. 이 외 유연성 없음.
- baseOpts ← cfg 매핑: `centerTol/targetPlateWidth/widthTol/maxIterations/probeStepDeg/maxStepDeg/settleMs/fallbackGainPanDeg/fallbackGainTiltDeg` 그대로 전달. `matchRadiusNorm`·`maxZoomStepRatio` 는 PlatePtz 기본값 사용 — **config 스키마 확장 없음**(단순함).

### 5-3. 시작 PTZ (Req 3) — §2 에서 결정 완료 (resolvePresetPtz + 캐시 + 0/0/1 폴백)

### 5-4. JSON (Req 4) — 계약 불변, 매핑표
`SlotPtzArtifact{createdAt, items[]}` / `SlotPtzItem` 필드 무변경. **PlatePtzResult(×2) → SlotPtzItem 매핑표**:

| SlotPtzItem 필드 | 소스 | 규칙 |
|---|---|---|
| `camIdx`/`presetIdx`/`slotId`/`globalIdx` | `PlateTarget` | 불변(기존과 동일) |
| `ptz` | 실패 지점의 result.ptz | center 실패→`c.ptz`, zoom 실패→`z.ptz`(마지막 명령 — 기존 의미 유지), 성공→`z.ptz` |
| `plateWidth` | `z.plateWidth ?? c.plateWidth ?? 0` | PlatePtz 는 `number|null`, SlotPtzItem 은 `number` — null→0 (기존 skipItem 의 0 관례) |
| `centered` | `c.ok` | |
| `converged` | `c.ok && z.ok` | center 실패 시 zoom 미시도 → false |
| `reason` | `PlatePtzFailReason` → string | 아래 표 |

**reason 매핑** (SlotPtzItem.reason 은 자유 문자열 — 스키마 불변):

| PlatePtzFailReason | 기록값 | 기존 문자열과의 관계 |
|---|---|---|
| `no_plate` | `'no_plate'` | 기존과 동일 |
| `plate_lost` | `'plate_lost'` | 기존과 동일 |
| `max_iterations` | `'max_iterations'` | **신규 값**(기존엔 미수렴 시 reason 없이 centered/converged=false 만 기록) — 정보 증가, 소비자(web renderCalResult)는 문자열 그대로 표시라 영향 0 |
| `zoom_saturated` | `'zoom_saturated'` | **신규 값** — 동상 |
| (잡 예외 흡수) | `'error'` | 기존과 동일(run 의 catch 유지) |
| ~~occluded~~ | 소멸 | LLM 자문 삭제(§4)에 따라 이 값은 더 이상 생성되지 않음 |

### 5-5. DB (Req 5) — centering_slot 최종안

**DDL (ensureSchema 에 CREATE TABLE IF NOT EXISTS 로 가산 — 기존 8테이블 뒤)**:
```sql
CREATE TABLE IF NOT EXISTS centering_slot (
  slot_id        TEXT    NOT NULL,  -- 전체슬롯id (setup_artifact slotId, 예: c1p1s3)
  cam_id         INTEGER NOT NULL,  -- 1-based
  preset_id      INTEGER NOT NULL,  -- 1-based
  preset_slotidx INTEGER,           -- 프리셋내 슬롯순서(1-based, coveredSlotIds 순서). 도출 불가 시 NULL
  pos            TEXT    NOT NULL,  -- 센터라이징된 PTZ JSON: {"pan":..,"tilt":..,"zoom":..}
  updated_at     TEXT,
  PRIMARY KEY (cam_id, preset_id, slot_id)
);
```

마스터가 판단 요구한 5건의 결정과 근거:

1. **`pos` 표현 = 단일 TEXT(JSON)** — 채택. 근거: ① 마스터가 컬럼명을 `pos` 단수로 명시 — 3분리(pan/tilt/zoom REAL)는 지정 스키마 위반. ② 기존 관례에도 구조체는 TEXT JSON 으로 두는 선례가 충분(`roi_json`/`vpd_json`/`lpd_json`/`polygon_json`/`spaces_json`). ③ 소비 패턴이 "PTZ 3값을 한 덩어리로 읽기"(축별 정렬/집계 질의 없음)라 JSON 이 자연스럽고, 필요 시 SQLite `json_extract(pos,'$.zoom')` 로 질의 가능. ④ DB 뷰어(dbRoutes)는 전 컬럼 CAST TEXT 검색이라 가독성 동일. **절충안(pos TEXT + pan/tilt/zoom REAL 병기)은 기각** — 동일 값의 이중 진실원(sync 불변식 관리 비용)으로 CLAUDE.md §2 위반 판정.
2. **컬럼명 `cam_id`/`preset_id` 유지(마스터 지정)** — 기존 `cam_idx`/`preset_idx` 관례와 불일치함을 **문서 경고로 남긴다**(교차 JOIN 작성 시 혼동 유의). TS 쪽은 `SELECT cam_id AS camId` 매핑으로 흡수(기존 패턴).
3. **PK `(cam_id, preset_id, slot_id)` + 멱등 = upsert(ON CONFLICT DO UPDATE), 전체 DELETE 금지** — 근거: 같은 slotId 가 복수 프리셋에서 관측될 수 있어(`plateRoiByPreset` 키마다 1타깃) slot_id 단독 PK 는 불가. **부분 캘리브레이션(`start(slotIds)`)이 멱등 설계의 함정**: `replaceParkingSlots` 식 전량 delete+insert 를 그대로 미러링하면 부분 실행이 타깃 외 성공 행을 전멸시킨다 → delete 범위를 "이번 잡의 타깃 키"로 좁히면 그것이 곧 upsert. 사내 선례 `upsertFloorRoi`(SqliteStore.ts:350, ON CONFLICT DO UPDATE + PK) 패턴을 미러링한다. 트랜잭션 원자성은 `db.transaction` 으로 동일 보장. **트레이드오프(문서화)**: 전량 실행 시 소멸한 슬롯의 stale 행이 잔존할 수 있음 — slotId 체계가 결정적(`c{cam}p{preset}s{pos}`)이라 재-셋업 시 대부분 덮어써지고, updated_at 으로 식별 가능. 모드 분기(전량=delete all/부분=upsert)는 코드 2배 대비 이득이 작아 기각.
4. **`preset_slotidx` 도출**: `artifact.presets` 에서 `${camIdx}:${presetIdx}` 프리셋의 `coveredSlotIds.indexOf(slotId) + 1`(1-based — Finalizer 의 positionIdx 순서와 동일, 기존 slot_idx 규약 정합). **프리셋 부재 또는 미포함 시 NULL** + warn 로그(조용한 0/−1 발명 금지). 도출 위치는 `expandPlateTargets`(artifact 를 이미 들고 있는 유일한 지점) — `PlateTarget` 에 `presetSlotIdx: number | null` 필드 가산(테스트 실물 확인: slotPtzWriter.test.ts 는 필드 단위 assert 라 가산 무해).
5. **실패 슬롯(centered=false 또는 converged=false)은 DB 에 넣지 않는다** — 근거: ① 마스터 정의상 이 테이블은 "센터라이징**된** PTZ 리스트" — 실패 슬롯의 ptz 는 소비 가능한 값이 아니라 복구 재료다. ② 실패 사유·미수렴 상태는 JSON(reason/centered/converged)이 이미 완전 보존 — DB 중복 기록은 마스터 지정에 없는 reason 컬럼을 강요한다. ③ upsert 와 결합하면 "이전 성공 행을 이번 실패가 덮어쓰지 않는다"(last-known-good 보존)는 바람직한 성질이 공짜로 나온다.

**추가 컬럼 판단**: `updated_at` 은 마스터 지정 목록 밖이지만 기존 모든 가변 테이블(parking_slots/floor_roi/occupancy)의 공통 관례 + stale 식별(§5-5-3 트레이드오프의 완화책)이라 포함한다. plateWidth 등 그 외는 넣지 않는다(JSON 소유).

**SqliteStore 신규 메서드** (replace/upsert 기존 패턴 미러):
```ts
/** centering_slot upsert(트랜잭션). PK(cam_id,preset_id,slot_id) — 부분 캘리브레이션 시 타깃 외 행 보존. */
upsertCenteringSlots(rows: CenteringSlotRow[]): void
/** 조회(camId/presetId/slotIdx 정렬, AS 매핑) — 테스트·후속 소비용. */
getCenteringSlots(): CenteringSlotView[]
```
`CenteringSlotRow = { slotId: string; camId: number; presetId: number; presetSlotIdx: number | null; pos: string /* 직렬화 완료 JSON */; updatedAt: string }` — `src/capture/types.ts` 에 정의(DB 행 타입의 기존 거처).

### 5-6. 저장 시점·DI (Req 6)
- `PtzCalibratorDeps` 에 `store?: Pick<SqliteStore, 'upsertCenteringSlots'>` **옵셔널** 추가(구조적 타입 — 모킹 용이, calibrate→capture 는 타입 import 만). **미주입 시 JSON 만 쓰고 완전 정상 동작** — 기존 ptzCalibrator.test.ts 의 deps 리터럴(store 없음)이 무수정 green 이어야 한다는 제약 충족(옵셔널이므로 타입 오류 없음).
- 저장 지점: `run()` 의 `this.writer(...)`(현 :128) 직후. items 는 targets 와 **인덱스 1:1**(실패 포함 타깃당 1 push)이므로 zip 으로 `presetSlotIdx` 를 붙여 행 조립 → `centered&&converged` 필터 → upsert. **try/catch best-effort**(실패 시 warn — JSON 이 정본, DB 는 미러. Finalizer 의 parking_slots 격리 패턴(:258) 미러). DB 실패가 잡 상태를 error 로 만들지 않는다.
- `src/index.ts`: **기존 `sqlite` 인스턴스(:50, `tools.capture.dbFile`) 재사용** — 신규 인스턴스 금지(동일 파일 WAL 커넥션 중복은 무익). `:78` → `new PtzCalibrator({ camera, lpd, repo, cfg: tools.calibrate, store: sqlite })` (brain 제거 — §4).

---

## 6. config 정정 (fallbackGain 부호 결함 해소)

| 항목 | 현재 | 변경 | 근거 |
|---|---|---|---|
| `tools.config.json:70` `fallbackGainPanDeg` | `20` | `-62` | 실측 −36.6@z1.69341 의 zoomRef=1 환산(§2 검증). 현행 +20 은 부호 반대 — probe 실패 시 P 제어 역방향 발산(04_doc_impact §4-①) |
| `tools.config.json:71` `fallbackGainTiltDeg` | `15` | `-35.5` | 동상(−21.0×1.69341≈−35.6) |
| `toolsConfig.ts:113-115` JSDoc | "probe 실패 시 기본 게인(°/정규화)" | "**zoomRef=1 기준** fallback 게인(°/정규화). PlatePtz 가 시작 zoom 으로 스케일해 사용. cam1 시뮬 실측 유래 — 카메라별 상이 가능" 로 갱신 | PlatePtz 의 fallback 해석(zoomRef=1)과 의미를 일치시켜야 함 |
| zod 부호 제약 | 없음 | **추가하지 않음** | 게인 부호는 카메라 장착 방향에 종속(장비별 상이 가능) — 스키마로 음수를 강제하면 실카메라 확장을 막는다. JSDoc 경고로 충분 |
| `DEFAULT_TOOLS_CONFIG.calibrate` | fallback 20/15, llmAdvise true | fallback −62/−35.5, llmAdvise 필드 삭제 | §4·본 절 |

---

## 7. 파일별 변경 계획 (경로 · 함수 · 대략 라인)

| # | 파일 | 변경 | 규모 |
|---|---|---|---|
| 1 | `web/index.html` | :205 주석, :208 h3, :209 설명, :213 버튼 문구 | ~4줄 |
| 2 | `web/app.js` | :2006 주석 문구, calStart(:2020) total=0 안내 분기 | ~4줄 |
| 3 | `src/calibrate/types.ts` | `PlateTarget` 에 `presetSlotIdx: number \| null` 가산(+JSDoc). 그 외 무접촉(SlotPtzItem/Artifact 계약 불변) | ~4줄 |
| 4 | `src/calibrate/slotPtzWriter.ts` | `expandPlateTargets`(:14) — presets 맵 구성 + `presetSlotIdx` 파생(indexOf+1, 미포함 NULL) | ~8줄 |
| 5 | `src/calibrate/PtzCalibrator.ts` | **핵심**. deps: `-brain`, `+store?`, `+makePlatePtz?`. `calibrateSlot`(:140) → §5-2 의사코드로 재작성. `startPtzFor`(신규, resolvePresetPtz+캐시). `run`(:114) 말미 DB upsert. 고아 삭제: probeGain/captureAndDetect/advise/applyCenterAdvice/applyZoomAdvice/ADVISE_*/IMPROVE_EPS/improvement/clampStep + 관련 import. 로그 문구 '캘리브레이션'→'센터라이징'(수정 라인 한정) | 326줄 → 약 220줄 |
| 6 | `src/capture/types.ts` | `CenteringSlotRow`/`CenteringSlotView` 추가 | ~15줄 |
| 7 | `src/capture/SqliteStore.ts` | `ensureSchema`(:36) DDL 가산, `upsertCenteringSlots`/`getCenteringSlots`(replaceParkingSlots :461 뒤) | ~45줄 |
| 8 | `src/config/toolsConfig.ts` | CalibrateSchema llmAdvise 삭제·fallback JSDoc(:100-122), DEFAULT(:275-279) 정정 | ~8줄 |
| 9 | `config/tools.config.json` | :70-71 fallback 정정, :74 llmAdvise 삭제 | 3줄 |
| 10 | `src/index.ts` | :77 주석, :78 deps(brain→store) | 2줄 |
| 11 | `test/ptzCalibrator.test.ts` | §9 명세 반영(LLM describe 삭제, cfg 리터럴, 신규 T1~T11) | 재작성 수준 |
| 12 | `test/calibrateRoutes.test.ts` | cfg 리터럴에서 llmAdvise 제거·fallback 갱신 | 2줄 |
| 13 | `test/config.test.ts` | :43 llmAdvise 단언 삭제, fallback 기대값 갱신 | ~3줄 |
| 14 | `test/sqliteStore*.test.ts`(기존 스토어 테스트 파일) | T12(upsert 단위) 가산 | ~40줄 |
| — | `src/calibrate/platePtz.ts` / `controlMath.ts` / `calibrateRoutes.ts` / brain 계층 | **변경 0줄** | — |

---

## 8. MCP 도구 vs LLM 두뇌 경계 판단

이 기능 전체(센터라이징 폐루프·저장)는 **결정형 도구** 영역이다 — 전체아키텍처 설계서 §8.2 확정표가 "센터라이징(줌 20% 반복)·PTZ 미세이동"을 결정형 칸에 명시. 이번 설계는 반복 루프 내 LLM 개입(구 advise)을 제거함으로써 기존 구현이 위반하던 이 경계를 **복원**하는 방향이다. LLM 두뇌의 정당한 역할(모호·예외 판단)이 필요해지면 잡 바깥(호출자 수준)에서 감싼다.

---

## 9. 테스트 명세 (qa-tester 구현용 — vitest)

기준선: 현재 `npm test` **1667 passed**. 아래 "삭제"는 기능 삭제(§4)에 따른 의도된 갱신이며 그 외 전 스위트 무수정 green 이 회귀 0 의 정의다.

**기존 테스트 처리**:
| 파일 | 처리 |
|---|---|
| `ptzCalibrator.test.ts` | 유지: happy path·순서(중심→줌)·no_plate·maxIter 미수렴·다수 번호판·중복시작·산출물없음(모킹 모델 cx=0.7−pan·0.02 는 PlatePtz 로도 수렴 — 검토 완료: 게인 −50 실측, 단일 대상이라 prior 추적 무해, zoom 방사예측 오차 ≤0.015 < matchRadius 0.08). **삭제**: 'LLM off/실패 폴백' describe 3케이스(기능 삭제). cfg 리터럴 llmAdvise 제거·fallback −62/−35.5 갱신 |
| `calibrateRoutes.test.ts`/`config.test.ts` | cfg 리터럴·기본값 단언만 갱신 |
| `platePtz.test.ts`(26)·`controlMath.test.ts`·`slotPtzWriter.test.ts` | 무수정 green 필수(대상 모듈 0줄 변경. slotPtzWriter 는 T9 가산만) |

**신규 케이스**:
| # | 케이스 | 방법 | 검증 |
|---|---|---|---|
| T1 | **gain 체이닝 실증** | `makePlatePtz` DI 스텁: 1번째 호출(center)이 gain G·ptz P 를 반환하도록 조작, 2번째 생성 opts 캡처 | zoom 인스턴스의 `opts.gain === G`(동일 참조/값) && `zoomToPlateWidth` 의 startPtz === P && zoom 인스턴스 `opts.plateRoi` = center 결과 plate 의 boundingRect(§5-2 prior 갱신) |
| T2 | 위임 후 수렴 회귀 | 기존 모킹 모델 그대로 | centered/converged true, plateWidth≈0.2, globalIdx=7 (기존 happy path 승계) |
| T3 | 시작 PTZ 정본 | 모킹 camera 에 `listCameras`(pan22/tilt6.8/zoom1.69341) 부여 | 첫 requestImage 명령 ptz = 프리셋 PTZ(moves[0] 검사) |
| T4 | 시작 PTZ 폴백 | listCameras 부재(기존 모킹) | 0/0/1 시작으로 잡 정상 완료(기존 케이스가 암묵 커버 — 명시 단언 1개) |
| T5 | reason 매핑 4종 | detect 시나리오 조작(초기 []→no_plate / 도중 []→plate_lost / 무반응→max_iterations / w=0.004·zoom→zoom_saturated) | SlotPtzItem.reason 문자열 정확 일치, centered/converged 플래그 §5-4 표와 일치 |
| T6 | center 실패 시 zoom 미시도 | makePlatePtz 스텁: center ok:false | zoomToPlateWidth 호출 0회, item.converged=false |
| T7 | DB 멱등(2회 실행) | `:memory:` SqliteStore 주입, 동일 잡 2회 | centering_slot 행수 1회차 === 2회차(중복 0), pos JSON parse → item.ptz 와 일치 |
| T8 | DB 미주입 정상 | store 생략(기존 deps 그대로) | 잡 done + JSON 저장 — 예외 없음 |
| T9 | preset_slotidx 도출 | artifact fixture: presets coveredSlotIds ['a','b','c'] | slot 'b' 타깃의 presetSlotIdx=2(1-based); coveredSlotIds 미포함 slotId → null |
| T10 | 부분 캘리브레이션 delete 범위 | 슬롯 2개 전량 실행(2행) → `start(['슬롯1만'])` 재실행 | 여전히 2행(타깃 외 보존), 대상 행 updated_at 만 갱신 |
| T11 | 실패 슬롯 DB 미저장 + last-known-good | 1회차 성공 → 2회차 같은 슬롯 no_plate | JSON 2회차 items 에 reason 존재, DB 는 1회차 성공 pos 유지(덮어쓰기 없음) |
| T12 | upsertCenteringSlots 단위 | SqliteStore 직접(:memory:) | 신규 insert / 동일 PK 재-upsert 갱신 / getCenteringSlots AS 매핑 / NULL presetSlotIdx 왕복 |
| T13 | DB 예외 격리 | store.upsertCenteringSlots 가 throw 하는 스텁 | 잡 state='done' 유지 + JSON 정상(경고만) |

완료 게이트: `npm test` 전량 green + `npm run typecheck` 무오류.

---

## 10. 경험적 검증(goal/loop 인계 — 동작 확인)

전제(§1): 현 setup_artifact 가 비어 있어 그대로는 total=0. **선행 스텝**: `save/result_20260703_203139.json`(51KB — plateRoiByPreset 포함 여부를 열어 확인 후 선택) 을 `/mapping` POST 로 복원하거나 capture→finalize 재실행.

Goal(관찰 수치):
1. UI: "센터라이징" 문구 확인 + 시작 → 진행률 → 완료 요약.
2. `data/slot_ptz.json` items ≥ 1, 성공 항목 centered&&converged, 실패 항목 reason 4종 중 하나.
3. `GET /db/table/centering_slot` — 성공 항목 수 == 행 수, pos JSON 의 zoom ∈ [1,36], preset_slotidx 1-based.
4. 성공 항목 1건 독립 재관측(결과 PTZ 로 재캡처→LPD, **전체목록 공통변위 기법** — plate-ptz §7 r2 교훈): |errX|,|errY| ≤ 0.03, 폭 ∈ [0.18,0.22].
5. 잡 2회 실행 → DB 행수 불변(멱등 라이브 확인).

Loop: 미달 시 반복 로그(cat:'centering' — PlatePtz 가 이미 iterations/err/ptz 를 남김)와 스샷으로 원인 분석 → 재설계.

---

## 11. 리스크 · 롤백

| # | 리스크 | 완화 |
|---|---|---|
| R1 | **LLM 자문 삭제는 기능 제거** — 마스터가 자문 유지를 원할 가능성 | §4 에 선택지 (b)(c) 병기. 컨펌 후 진행. brain 계층은 무접촉이라 복원 비용 낮음(PtzCalibrator 1파일 revert) |
| R2 | fallback 게인(−62/−35.5)은 cam1 시뮬 실측 유래 — cam2+/실카메라 일반화 근거 없음(platePtz.ts:65 주석 승계) | probe 가 1차 방어(정상 경로에선 fallback 미사용). JSDoc 경고 유지. 실카메라 확장 시 diagSweep 재실측 |
| R3 | 전량 재실행 시 소멸 슬롯의 stale 행 잔존(upsert 트레이드오프 §5-5-3) | updated_at 식별 + 문서 경고. 실해 관찰 시 "전량 실행 한정 delete-all" 후속 |
| R4 | 부분 캘리브레이션 시 **slot_ptz.json 이 부분 items 로 덮어써져 기존 항목 소실** — 기존 동작의 결함이나 스키마 불변 제약상 이번 범위 밖 | 문서 경고 + 후속과제 등록(DB 는 upsert 라 이 결함이 없음 — DB 가 보완재) |
| R5 | center 실패 시 zoom 미시도는 구 동작(maxIter 후에도 zoom 시도)과 다름(§3) | 의도된 변경으로 문서 명기. reason 이 더 정직해짐 |
| R6 | ptzCalibrator.test 모킹 모델이 PlatePtz 의 예측 prior/매칭 반경과 상성이 나쁠 가능성 | §9 에서 수치 사전 검토 완료(단일 대상·게인 −50·방사예측 오차 < 0.08). 실패 시 platePtz.test 의 공통 실측 모델 차용 |
| 롤백 | 코드: 변경 14파일 단일 커밋 revert. DB: `centering_slot` 은 가산 테이블(기존 소비자 0) — 잔존해도 무해, 필요 시 DROP 1회 | |

## 12. 가정·미해결 (명시)

1. **[불확실]** 과거(setup_artifact 가 채워져 있던 7월 초)에 /calibrate/ptz 가 타깃과 함께 실행된 적 있는지 — 기록 없음. §4 의 "실기동 이력 0"은 현 증거 기반 추정이며 권고 강도에는 영향 없음(비용·아키텍처 근거가 독립적으로 성립).
2. **[가정]** startPtz 폴백 0/0/1 은 사실상 no_plate 로 귀결되는 열화 시야다 — 별도 reason('no_preset_ptz') 발명 대신 warn 로그 + 자연 실패로 둔다(단순함).
3. **[가정]** centering_slot 의 소비자는 아직 없다(ActionAgent 예정) — getCenteringSlots 는 테스트·뷰어용 최소 조회만.
4. **[미해결·후속]** brain 계층의 adviseCentering 일식(고아화) 정리, R4(JSON 부분 실행 소실) — 별도 과제.

## 구현자(developer)에게
§5-2 의사코드·§7 파일표 준수. **platePtz.ts/controlMath.ts 0줄 변경 — 제어 수식·루프 재작성 금지, 위임만.** zoom 단계 초기 prior 는 반드시 center 결과 plate 의 boundingRect(§5-2 ★). ESM `.js` import, strict. 완료 게이트 = §9.

## 문서화(documenter)에게
영향 범위: §7 표 14파일 + 기능 삭제(§4 — brain 계층 고아화 명기) + DB 신테이블(소비자 0, 가산) + config 부호 정정(기존 열화 결함 해소). reason 값 집합 변화(§5-4)를 Action/DM 계약 관점에서 한 번 더 점검.
