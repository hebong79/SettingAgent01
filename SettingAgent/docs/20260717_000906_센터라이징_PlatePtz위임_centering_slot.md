# 센터라이징 버튼 개명 + PtzCalibrator→PlatePtz 위임 + slot_ptz.json/DB(centering_slot) 이중 저장

작성: 2026-07-17 / 문서화(documenter)
브랜치: `feat/vpd-seg-cuboid` (메인 리포 `D:\Work\Parking3D\AgentVLA\ParkAgent\SettingAgent`)
근거 문서: `_workspace/centering/01_architect_plan.md`(설계) · `02_developer_changes.md`(구현) · `03_qa_report.md`(검증) + 실제 `git diff` + 리더 라이브 검증 로그.
선행 문서: `docs/20260716_192522_번호판센터링줌모듈.md`(PlatePtz 모듈 자체), `_workspace/plate-ptz/04_doc_impact.md`(후속과제 ① — 이번 작업의 배경).

> ## 요약
> `PtzCalibrator` 의 A/B 자체 제어루프(probe 게인 + LLM 자문 하이브리드)를 라이브 검증된 `PlatePtz` 결정형 폐루프 위임으로 전면 교체했다. UI 문구를 "PTZ 캘리브레이션"→"센터라이징"으로 바꾸고, 결과를 기존 `slot_ptz.json` 계약 그대로 저장하되 신규 SQLite 테이블 `centering_slot` 에도 미러 저장(성공 항목만, upsert 멱등)한다. LLM 자문 배관은 삭제했다(brain 계층 자체는 보존, 소비자만 없어짐). 13개 소스/테스트 파일 변경, `npm test` 155 files / 1731 passed / 0 failed, 라이브 왕복 성공 + 독립 재관측(중심오차 0.0049, 폭 0.1899)까지 확인됨.

---

## 1. 마스터 요청 4가지 항목별 대조

| # | 요청 | 반영 결과 |
|---|---|---|
| 1. 버튼 개명 | "PTZ 캘리브레이션"→"센터라이징" | `web/index.html:208` `<h3>센터라이징</h3>`, `:213` 버튼 텍스트 `센터라이징`, `:205` 주석·`:209` 설명 동시 갱신. `id="cal-start"`·`/calibrate/*` 라우트·`calStart/calPoll/renderCalResult` 함수명은 전부 **불변**(내부 식별자는 안 건드리고 노출 문구만 변경). |
| 2. PlatePtz 연결 | 자체 제어루프 → 라이브 검증된 `PlatePtz` 모듈에 위임 | `PtzCalibrator.calibrateSlot` 이 `PlatePtz.centerOnPlate` → `PlatePtz.zoomToPlateWidth` 2단계 위임으로 재작성됨(§2). **center 결과의 실측 게인을 zoom 단계로 체이닝**하고, zoom 초기 prior 를 센터링 후 관측 위치로 갱신하는 것이 이 변경의 핵심(§2-2). `platePtz.ts`/`controlMath.ts` 는 **0줄 변경**(`git diff --stat` 확인) — 위임만, 제어 수식 재작성 없음. |
| 3. JSON 저장 | `slot_ptz.json` 계약 유지 | `SlotPtzArtifact{createdAt, items[]}`·`SlotPtzItem` 필드 스키마 **무변경**. 값 매핑만 PlatePtz 결과 기준으로 재구성(§3). |
| 4. DB `centering_slot` | 센터라이징된 PTZ 를 DB 테이블에도 저장 | `SqliteStore` 에 `centering_slot` 테이블 신설, 성공 슬롯만 upsert(§4). 기존 8테이블·인덱스는 무접촉. |

---

## 2. 변경/신규 클래스·함수 상세

### 2-1. `PtzCalibrator` 재작성 (`src/calibrate/PtzCalibrator.ts`, 326줄 → 232줄)

`git diff` 실측 기준 변경 규모: `+92 / -206`(파일 전체 다이제스트 상 `284` 변경 라인, 순감소 약 94줄).

**남긴 것**(잡 오케스트레이션 소유):
- 잡 상태머신(`idle/running/done/error`), 중복 시작 거부, 진행률(`done/total/current`), `getStatus()`
- 대상 펼침(`expandPlateTargets` + `slotIds` 필터 — 부분 캘리브레이션 API `start(slotIds?: string[])` 시그니처 불변)
- 슬롯 예외 흡수(`reason:'error'`, 잡 자체는 중단되지 않음)

**삭제한 것**(PlatePtz 위임으로 고아화):
`probeGain`·`captureAndDetect`·`advise`·`applyCenterAdvice`·`applyZoomAdvice`·`ADVISE_ZOOM_MIN/MAX`·`IMPROVE_EPS`·`improvement`·`clampStep`·`brain` 의존성. 이와 함께 `controlMath.ts` 의 8개 함수 import(`plateCenterError`/`pickNearestPlate`/`estimateGain`/`panTiltCorrection`/`zoomCorrection`/`isCentered`/`isWidthConverged`/`dampGain`)와 `SetupBrain`/`CenteringAdvice`/`PlateBox` import 가 고아가 되어 함께 제거됐다.

**신규 추가**:
- `startPtzFor(t)`: 시작 PTZ 를 `resolvePresetPtz(camera, camIdx, presetIdx)`(프리셋 정본, `src/capture/detectPipeline.ts`)로 조회, `${cam}:${preset}` 키 캐시(`ptzByKey`, Finalizer 의 캐시 패턴 미러). 조회 실패/미보유 시 `{pan:0,tilt:0,zoom:1}` 폴백 + **`logger.warn` 필수 동반**(조용한 강등 금지 — 리더 지시로 QA 가 T4 에 warn 실발화 단언을 가산).
- `baseOpts()`: `ToolsConfig['calibrate']` → `PlatePtzOpts` 매핑(`centerTol/targetPlateWidth/widthTol/maxIterations/probeStepDeg/maxStepDeg/settleMs/fallbackGainPanDeg/fallbackGainTiltDeg`). `matchRadiusNorm`/`maxZoomStepRatio` 는 PlatePtz 자체 기본값 사용 — config 스키마 확장 없음.
- `saveCenteringSlots(targets, items)`: `centering_slot` DB best-effort 미러(§4).
- `PtzCalibratorDeps` 확장: `store?: Pick<SqliteStore, 'upsertCenteringSlots'>`(옵셔널 — 미주입 시 JSON 만, 잡은 완전 정상 동작), `makePlatePtz?: (opts) => PlatePtzApi`(PlatePtz 팩토리 DI, 테스트 시임).

**gain 체이닝 로직**(이 변경의 핵심):
```ts
const c = await this.makePlatePtz({ ...base, plateRoi: t.plateRoi })
  .centerOnPlate(t.camIdx, t.presetIdx, startPtz);
if (!c.ok || !c.plate) return this.skipItem(t, c.ptz, c.plateWidth ?? 0, c.reason);

const z = await this.makePlatePtz({
  ...base,
  plateRoi: quadBoundingRect(c.plate.quad),  // ★ zoom 단계 초기 prior = 센터링 결과 위치(센터링 前 위치 아님)
  gain: c.gain,                               // ★ 실측 게인 체이닝(무측정 fallback 의존 소멸)
}).zoomToPlateWidth(t.camIdx, t.presetIdx, c.ptz);
```
`quadBoundingRect` 로 prior 를 갱신하지 않고 `t.plateRoi`(센터링 전 위치)를 그대로 쓰면, 이동한 화면에서 이웃 번호판을 초기 선정할 위험이 있다 — QA 가 T1 에서 이 지점을 `not.toBeCloseTo` 로 별도 단언했고, 뮤테이션 M2(prior 를 되돌림)로 실제로 RED 가 되는 것을 확인했다.

**동작 의미 변화 1건(의도적)**: 구 코드는 A 루프(중심정렬)가 반복 상한으로 끝나 `centered=false` 여도 B(zoom)를 시도했다. 신 코드는 **center 실패(`ok:false`) 시 zoom 을 시도하지 않는다** — 미중심 상태의 zoom-in 은 중심 오차를 배율만큼 확대해 대상을 화면 밖으로 밀어낼 수 있다는 물리적 근거(PlatePtz 설계 §2.3)에 따른 것이다. QA T6 이 이를 회귀 고정한다.

### 2-2. `expandPlateTargets` 확장 (`src/calibrate/slotPtzWriter.ts`)

`PlateTarget` 에 `presetSlotIdx: number | null` 필드를 추가로 파생한다. `artifact.presets[].coveredSlotIds.indexOf(slotId) + 1`(1-based). 프리셋 자체가 없거나 `coveredSlotIds` 에 해당 슬롯이 없으면 `null` + `logger.warn`(0/−1 발명 금지). `centering_slot.preset_slotidx` 컬럼의 유일한 소스다.

### 2-3. `centering_slot` DB 스토어 (`src/capture/SqliteStore.ts`, `src/capture/types.ts`)

`upsertFloorRoi` 패턴(트랜잭션 + `ON CONFLICT DO UPDATE`)을 미러링한 신규 메서드 2개:
- `upsertCenteringSlots(rows: CenteringSlotRow[]): void` — PK `(cam_id, preset_id, slot_id)` upsert, **전량 delete 없음**.
- `getCenteringSlots(): CenteringSlotView[]` — 스네이크→카멜 `AS` 매핑 조회, `cam_id, preset_id, preset_slotidx, slot_id` 순 정렬.

저장 지점은 `run()` 의 `writer(...)`(JSON 기록) 직후. `items[i]`↔`targets[i]` 인덱스 1:1 zip 으로 `presetSlotIdx` 를 붙이고, `centered && converged` 필터를 거쳐 upsert 한다. 예외는 `try/catch` 로 흡수(`logger.warn`) — DB 실패가 잡 상태를 `error` 로 만들지 않는다(JSON 이 정본, DB 는 best-effort 미러).

### 2-4. config 정정 (`src/config/toolsConfig.ts`, `config/tools.config.json`)

- `fallbackGainPanDeg`: `20` → `-62`, `fallbackGainTiltDeg`: `15` → `-35.5`. 실측(cam1 시뮬 `-36.6/-21.0 @zoom 1.69341`)의 zoomRef=1 환산값 — 기존 값은 **부호가 반대**였다(probe 실패 시 P 제어가 역방향으로 발산할 잠재 결함, `plate-ptz` 후속과제 ①에서 지적된 문제의 해소).
- `CalibrateSchema.llmAdvise` 필드 및 `DEFAULT_TOOLS_CONFIG.calibrate.llmAdvise` 삭제. `config/tools.config.json` 의 `"llmAdvise": true` 줄도 제거.
- JSDoc 갱신: fallback 게인이 "probe 실패 시 기본 게인"이 아니라 "**zoomRef=1 기준** fallback 게인 — PlatePtz 가 시작 zoom 으로 스케일해 사용"이라는 의미로 정정.

### 2-5. `src/index.ts` 배선

```diff
- const calibrator = new PtzCalibrator({ camera, lpd, brain, repo, cfg: tools.calibrate });
+ const calibrator = new PtzCalibrator({ camera, lpd, repo, cfg: tools.calibrate, store: sqlite });
```
`brain` deps 제거, 기존 `sqlite`(`SqliteStore`, `tools.capture.dbFile` 인스턴스) 재사용 주입 — 신규 DB 커넥션을 만들지 않는다. `brain` 변수 자체는 `AgentRuntime` 로 다른 다수 소비자(`SetupOrchestrator`/`CheckpointReviewer`/`FloorRoiReviewer`/`OccupancyReviewer`/`CaptureJob`/`Finalizer`)가 여전히 사용하므로 `index.ts` 전체 관점에서 고아 변수가 되지는 않는다 — **`PtzCalibrator` 가 `brain.adviseCentering` 을 더 이상 부르지 않게 된 것**이 이번 변경의 실제 효과다.

### 2-6. UI (`web/index.html`, `web/app.js`)

문구 변경 외에 `calStart()` 에 `total===0` 분기 추가:
```js
const okMsg = data.total === 0
  ? '대상 0 — 셋업 산출물에 번호판 ROI 슬롯이 없습니다(최종화 필요)'
  : `시작됨 (대상 ${data.total} 슬롯)`;
```
이는 리더가 라이브로 실증한 "버튼이 무반응처럼 보이는 원인 = 코드 버그가 아니라 `setup_artifact.json` 의 `slots:[]`" 문제(§6)를 사용자에게 알리기 위한 안내이며, 요청 범위를 소폭 넘는 것이나 리더 확정 승인 사항이다.

---

## 3. `SlotPtzItem.reason` 값 집합 변화 (Action/DM 계약 관점 점검)

`SlotPtzItem.reason` 은 스키마상 **자유 문자열**(`reason?: string`) — 값 집합이 바뀌어도 JSON 스키마 자체는 불변이다.

| 이전 | 이후 |
|---|---|
| `no_plate` | `no_plate`(불변) |
| `plate_lost` | `plate_lost`(불변) |
| `occluded`(LLM 자문 가림 판정) | **소멸** — LLM 자문 삭제로 더 이상 생성되지 않음 |
| (미수렴 시 reason 없이 `centered/converged=false` 만) | `max_iterations`(신규 — 반복 상한 소진을 문자열로 명시) |
| (동상) | `zoom_saturated`(신규 — zoom 상한에서 폭 미달) |
| `error`(예외 흡수) | `error`(불변) |

소비측(`web/app.js` 의 `renderCalResult`)은 `reason` 을 그대로 화면에 표시하는 방식이라 값 집합 변화에 영향받지 않는다(문자열 렌더만). **ActionAgent/DMAgent 가 `reason==='occluded'` 를 특정 분기로 소비하고 있었다면 영향이 있으나, 그런 소비 코드는 발견되지 않았다**(§7 확인 결과 참조). `centered`/`converged` 불리언 필드의 의미(§ 2-1 "동작 의미 변화 1건")는 실제 값 계산 로직이 바뀌었으므로, 이 두 필드를 소비하는 외부 코드가 있다면 재확인이 필요하다 — 단, 이번 조사 범위(SettingAgent 리포 내)에서는 `slot_ptz.json`/`centering_slot` 의 외부 소비자를 찾지 못했다(§7).

---

## 4. `centering_slot` DB 스키마·조회 예시

```sql
CREATE TABLE IF NOT EXISTS centering_slot (
  slot_id        TEXT    NOT NULL,  -- 전체슬롯id (setup_artifact slotId, 예: c1p2s1)
  cam_id         INTEGER NOT NULL,  -- 1-based
  preset_id      INTEGER NOT NULL,  -- 1-based
  preset_slotidx INTEGER,           -- 프리셋내 슬롯순서(1-based, coveredSlotIds 순서). 도출 불가 시 NULL
  pos            TEXT    NOT NULL,  -- 센터라이징된 PTZ JSON: {"pan":..,"tilt":..,"zoom":..}
  updated_at     TEXT,
  PRIMARY KEY (cam_id, preset_id, slot_id)
);
```

조회: `GET /db/table/centering_slot` (기존 `dbRoutes.ts` 의 `sqlite_master` 기반 동적 화이트리스트 덕분에 **라우트 코드 변경 없이** 자동 노출됨).

### 설계 판단과 근거 (마스터가 판단 요구한 항목)

1. **`pos` 를 단일 TEXT(JSON) 로 한 이유**: 마스터가 컬럼명을 `pos` **단수**로 지정 — pan/tilt/zoom 3분리 REAL 컬럼은 지정 스키마 위반이 된다. 기존 DB 관례(`roi_json`/`vpd_json`/`lpd_json`/`polygon_json`/`spaces_json`)에도 구조체를 TEXT JSON 으로 저장하는 선례가 있고, 소비 패턴이 "PTZ 3값을 한 덩어리로 읽기"라 자연스럽다. 필요 시 `json_extract(pos,'$.zoom')` 로 질의 가능. **pos TEXT + pan/tilt/zoom REAL 병기(절충안)는 기각** — 동일 값의 이중 진실원이 되어 동기화 불변식 관리 비용이 생긴다(CLAUDE.md §2 단순함 위반 판정).
2. **PK `(cam_id, preset_id, slot_id)`**: 같은 `slotId` 가 복수 프리셋(`plateRoiByPreset` 의 서로 다른 키)에서 관측될 수 있어 `slot_id` 단독 PK 는 불가능하다.
3. **전량 delete 대신 upsert 를 택한 이유(부분 캘리브레이션 함정)**: `replaceParkingSlots` 처럼 전량 delete+insert 를 그대로 미러링하면, 부분 실행(`start(slotIds)`)이 **타깃 외의 기존 성공 행을 전멸**시킨다. delete 범위를 "이번 잡의 타깃 키"로 좁히면 그것이 곧 upsert 이므로, `upsertFloorRoi` 패턴(`ON CONFLICT DO UPDATE` + PK)을 그대로 미러링했다. 트레이드오프: 전량 재실행 시 소멸한 슬롯의 stale 행이 잔존할 수 있다 — `updated_at` 으로 식별 가능하며, `slotId` 체계가 결정적(`c{cam}p{preset}s{pos}`)이라 재-셋업 시 대부분 자연히 덮어써진다.
4. **성공 항목만 DB 저장(실패는 JSON 에만)**: 이 테이블은 "센터라이징**된** PTZ 리스트"이지 실패 로그가 아니다. 실패 사유는 JSON(`reason`/`centered`/`converged`)이 이미 완전 보존한다. 부수 효과로 "이전 성공 행을 이번 실패가 덮어쓰지 않는다"(last-known-good 보존)는 성질이 공짜로 따라온다 — QA T11 이 이를 실측 확인(2회차 `no_plate` 여도 DB 는 1회차 `pos`·`updated_at` 완전 불변).
5. **컬럼명이 기존 관례 `cam_idx`/`preset_idx` 와 다른 점(마스터 지정 `cam_id`/`preset_id`)**: 의도적으로 유지하되, **교차 JOIN 작성 시 혼동 유의 경고**로 남긴다. TS 쪽은 `SELECT cam_id AS camIdx` 매핑으로 이 불일치를 흡수한다.

---

## 5. LLM 자문(advise) 삭제

**근거**: 전체아키텍처 설계서(`Docs/20260624_162408`) §8.2:191 이 "센터라이징(줌 반복)·PTZ 미세이동 = 결정형 도구"로 이미 확정한 결정과, 반복 루프 내 LLM 자문 구조가 정면 충돌한다. 슬롯당 반복 상한 15 × 2단계(center/zoom) = **최대 30회 LLM 비전 호출**(타임아웃 30초)이라는 비용 구조도 배치 셋업 작업에 구조적으로 부적합하다.

**삭제 범위**: `PtzCalibrator.ts` 의 `advise`/`applyCenterAdvice`/`applyZoomAdvice`/`ADVISE_ZOOM_MIN/MAX`/`brain` 의존성/`CenteringAdvice`·`SetupBrain` import. `toolsConfig.ts` 의 `CalibrateSchema.llmAdvise` 필드와 `DEFAULT_TOOLS_CONFIG.calibrate.llmAdvise`. `config/tools.config.json` 의 `"llmAdvise": true` 줄.

**보존(무접촉) — 고아가 된 것**: `SetupBrain.adviseCentering` 인터페이스, `AgentRuntime.adviseCentering` 구현, `config/prompts/ptz_centering.yaml` 프롬프트, `llmConfig.centering` 스키마, 관련 brain 테스트(전부 green 유지). **이들은 이번 변경으로 소비자가 없어진 고아 코드다** — brain 계층 자체가 통째로 죽은 것은 아니고(`AgentRuntime` 은 `SetupOrchestrator` 등 다른 다수 소비자가 계속 사용), `adviseCentering` 이라는 단일 메서드/스키마 조각만 호출자를 잃었다. 삭제 파급(공유 brain 계약·프롬프트 자산)이 크다는 판단에 따라 별도 결정 사안으로 보존했다 — 삭제 여부는 이번 범위 밖의 후속 결정 사안이다.

**기존 데드코드(이번 변경과 무관, 삭제하지 않음, 언급만)**: `src/calibrate/types.ts:53-65` 의 `CenteringAdvice` 인터페이스는 이번 변경 이전부터 아무도 import 하지 않던 사본이다(실사용은 `SetupBrain.ts` 의 zod 유도형). CLAUDE.md §3(외과적 변경) 원칙에 따라 삭제하지 않고 존재만 기록한다.

---

## 6. 리더 라이브 검증 결과 (직접 실행·관측)

환경: SettingAgent `:13020` 실기동, Unity 시뮬 JSON-RPC `:13110 /rpc`(프로덕션 배선은 `RpcCameraClient`, `src/index.ts:34`), 실 LPD `192.168.0.125:9082`.

- **`items:[]` 원인 실증**: 빈 `setup_artifact.json`(`slots:[]`) 상태에서 `POST /calibrate/ptz` → `{"ok":true,"started":true,"total":0}`. 버튼이 무반응처럼 보인 원인은 **코드 결함이 아니라 입력 데이터 부재**였음이 라이브로 확인됐다. 리더가 `reports/result_20260708_115303.json`(슬롯 1건 `c1p2s1`)으로 복원 → `total:1`. 원본 빈 artifact 는 `data/setup_artifact.EMPTY_BACKUP_20260716.json` 에 백업 보존.
- **왕복 성공**: `centered:true, converged:true`. 센터링 1회 반복(`errX -0.002 / errY -0.004`), 줌 6회 반복(`plateWidth 0.181`).
- **시작 PTZ 실증**: `camerapos.json` `cam1:preset2` = `pan 56.6 / tilt 7.4 / zoom 2.03134` 에서 실제로 출발함을 확인 — 하드코딩 `0/0/1` 제거가 라이브로 검증됨.
- **DB 멱등 실증**: 2회 실행 → `centering_slot` 행 1개 유지, `updated_at` 만 갱신. `pos` 가 `item.ptz` 와 바이트 일치, `preset_slotidx=1`(1-based).
- **DB 뷰어**: `GET /db/table/centering_slot` 라우트 변경 없이 200 확인(`dbRoutes.ts` 동적 화이트리스트).
- **독립 재관측(Goal 4 — QA 가 명시적으로 미수행이라 밝힌 공백을 리더가 닫음)**: 폐루프 **밖에서** 최종 PTZ 로 새 프레임 캡처 → 실 LPD 직접 검출 → 번호판 중심 `(0.4966, 0.5035)`, 오차거리 `0.0049`(허용 0.03), 폭 `0.1899`(목표 0.2±0.02) → **중심·폭 모두 PASS**. 육안 오버레이(`_workspace/centering/_live/reobs_overlay.png`)로 번호판 `480호5357` 이 십자 중앙, 중심점이 허용원 내부임을 확인. 즉 `centered:true` 는 폐루프 자신의 자기보고가 아니라 **독립 관찰로 뒷받침됨**. 하네스 스크립트: `_workspace/centering/_live/reobserve.mts`.

---

## 7. 테스트 결과 (있는 그대로 인용)

- `npm run typecheck` **무오류**. 전량 **155 files / 1731 passed / 0 failed**.
- **기준선 정정(중요)**: 지시문·설계서의 "1667" 은 **재현되지 않았다**. 구현자가 `git stash` 로, QA 가 독립 워크트리(HEAD detached)로 각각 별도 재측정한 결과 클린 체크아웃 = **1709 passed + 4 skipped(총 1713)**. 4-skip 은 `test/placeRoiRuntimeInvariants.test.ts` 가 untracked `data/Place01/` 부재 시 `describe.skipIf` 로 스킵되는 것이며, 해당 파일을 단독 실행하면 4 passed 로 확인된다. 변경 후 최초 1710 passed(차분 −3 = 설계상 의도된 LLM 자문 3케이스 삭제), 신규 테스트 21건(`centeringSlot.test.ts` 20 + `centeringBoundary.test.ts` 1) 추가로 최종 1731.
- **⚠ CI 경고**: 신규 클론·CI 환경처럼 `data/Place01/` 이 없으면 절대값이 4씩 낮게 나온다(HEAD 1709 / 변경후 1706). 차분 −3 은 동일하게 성립하나, **절대값(1713/1710/1731)을 CI 게이트로 고정하면 오탐한다** — 반드시 차분(전·후 동일 환경 비교)으로 관리할 것.
- **뮤테이션 반증 10/10 탐지**: gain 체이닝 절단(M1)·zoom prior 회귀(M2)·미중심 zoom 허용(M3)·전량 delete 회귀(M4)·DB best-effort 제거(M5)·실패슬롯 필터 제거(M6)·0-based 회귀(M7)·프리셋 PTZ 무시(M8)·warn 삭제(M9)·zip 오염(M10) — 전부 RED. 즉 위 계약들은 테스트로 실제로 강제되고 있음이 입증됐다. 단 M3 시도 중 QA 가 **최초 작성한 T6 자체가 무의미**했음을 발견해 수정했다(fixture 의 `plate:null` 이 `!c.plate` 절만 태워 `!c.ok`(의미 변화의 본체)를 한 번도 실행하지 않았던 결함 — 피위임 모듈의 실제 반환 계약(non-null plate)에 맞게 fixture 를 교정).

---

## 8. 한계 (정직히 명시 — 통과 위장 금지)

- 라이브는 **cam1/preset2 단일 슬롯(`c1p2s1`) 1건**뿐이다. 다중 슬롯·다중 프리셋·`cam2` 는 미검증(유닛에선 2슬롯 커버).
- **부분 캘리브레이션(`start(slotIds)`) 라이브 미검증** — 셋업에 슬롯이 1개뿐이라 의미 있는 실행이 불가능했다. 유닛(모킹, T10)으로만 커버됨.
- 브라우저 실화면 UI 미검증 — HTML/JS 소스 정적 확인(`grep`/diff)과 fastify `inject` 헤드리스 라우트 테스트만 수행. 실제 클릭 → 진행률 → `renderCalResult` 렌더는 미확인.
- 현재 `data/setup_artifact.json` 은 **7/8 스냅샷 복원본**이라 최신 현장 상태가 아닐 수 있다. 정상 운영하려면 재-finalize 가 필요하다.

---

## 9. 영향도 요약 (상세는 `_workspace/centering/04_doc_impact.md` 참조)

- `platePtz.ts`/`controlMath.ts` **0줄 변경** 확인.
- `centering_slot` 신설은 기존 8개 테이블·인덱스·`dbRoutes` 화이트리스트에 무해 가산(§4).
- config 스키마 변경(`llmAdvise` 제거, fallback 부호 정정)은 zod 비-strict 객체라 기존 config 파일의 잔존 `llmAdvise` 키가 있어도 조용히 무시되어 파싱은 깨지지 않는다.
- `src/index.ts` 배선 변경(brain 제거, store 주입) — brain 자체는 다른 소비자가 있어 무접촉.
- 1-based 인덱스 규약(`cam_id`/`preset_id`/`preset_slotidx`) 준수 확인.
- ActionAgent/DMAgent·MCP 도구·`@parkagent/types` 영향은 별도 조사 결과를 영향도 문서에 기록.

---

## 10. 후속과제 (기록만, 이번 범위 밖)

1. `dbRoutes.ts` 에 `onClose` 훅이 없어 read-only 커넥션이 해제되지 않는다(QA 실측 — Windows 에서 임시 DB 삭제 `EPERM`). 기존 결함, 이번 브랜치에서 `dbRoutes.ts` 는 0줄 변경.
2. `docs/20260630_225107_PTZ캘리브레이션_slot_ptz.md` 가 `llmAdvise:true`·fallback `20/15`·LLM 자문 하이브리드 구조를 현행으로 서술 — 이번 변경으로 낡았다. 본 문서 작성 시 해당 문서 상단에 구버전 표기를 추가했다(전면 재작성은 하지 않음 — CLAUDE.md §3, 무관 파일 대량 수정 회피).
3. brain 계층(`SetupBrain.adviseCentering`/`AgentRuntime.adviseCentering`/`config/prompts/ptz_centering.yaml`/`llmConfig.centering`)의 고아화 처리(삭제 여부)는 별도 결정 사안.
4. `src/calibrate/types.ts` 의 `CenteringAdvice`(이번 변경 전부터 미사용) — 기존 데드코드, 삭제하지 않음.
5. 부분 캘리브레이션 시 `slot_ptz.json` 이 부분 items 로 덮어써져 기존 항목이 소실되는 기존 결함(스키마 불변 제약상 이번 범위 밖) — DB 는 upsert 라 이 결함이 없어 보완재 역할을 한다.
