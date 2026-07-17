# 영향도 분석: 센터라이징 버튼 개명 + PtzCalibrator→PlatePtz 위임 + centering_slot 이중 저장

작성: 2026-07-17 / 문서화(documenter)
대조 산출물: 상세 문서 `docs/20260717_000906_센터라이징_PlatePtz위임_centering_slot.md`
근거: `git diff HEAD`(14파일, 코드 13 + `data/setup_artifact.json` 1), `_workspace/centering/01~03`, Explore 서브에이전트의 ActionAgent/DMAgent/`@parkagent/types`/MCP 조사(§6).

---

## 1. 변경 범위 — 사실 확인

```
$ git diff --stat HEAD
config/tools.config.json       |   7 +-
data/setup_artifact.json       |  79 +++++++-      ← 리더의 라이브 검증용 데이터 복원(코드 아님)
src/calibrate/PtzCalibrator.ts | 284 ++++++++++------------------
src/calibrate/slotPtzWriter.ts |  11 ++
src/calibrate/types.ts         |   5 +
src/capture/SqliteStore.ts     |  44 ++++-
src/capture/types.ts           |  25 +++
src/config/toolsConfig.ts      |  16 +-
src/index.ts                   |   4 +-
test/calibrateRoutes.test.ts   |   4 +-
test/config.test.ts            |   3 +-
test/ptzCalibrator.test.ts     |  32 +---
web/app.js                     |   8 +-
web/index.html                 |   8 +-
14 files changed, 287 insertions(+), 243 deletions(-)
```
신규 미추적 파일: `test/centeringSlot.test.ts`(20케이스)·`test/centeringBoundary.test.ts`(1케이스), `data/slot_ptz.json`(라이브 산출물), `data/setup_artifact.EMPTY_BACKUP_20260716.json`(원본 백업).

`data/setup_artifact.json` 은 리더가 라이브 검증을 위해 빈 셋업 산출물을 이전 스냅샷으로 복원한 것으로, 코드 변경이 아니다(§1 설계서 결론 참조 — 버튼 무반응의 원인은 코드가 아니라 이 파일이 비어 있었던 것).

---

## 2. `platePtz.ts` / `controlMath.ts` — 0줄 변경 확인

```
$ git diff --stat HEAD -- src/calibrate/platePtz.ts src/calibrate/controlMath.ts
(출력 없음)
```
`git status --porcelain` 에도 두 파일이 나타나지 않는다. **위임만 이루어졌고, 제어 수식·폐루프 로직 자체는 이번 변경으로 한 줄도 건드리지 않았다** — 이는 이 작업 전체가 "이미 라이브 검증된 모듈에는 손대지 않고 소비만 바꾼다"는 설계 전제(`_workspace/centering/01_architect_plan.md` 3줄 요약 ①)를 그대로 지켰다는 뜻이며, 회귀 위험을 `PtzCalibrator.ts` 1개 파일의 배선 변경으로 국한시킨다.

`PtzCalibrator.ts` 는 `controlMath.ts` 의 9개 export 중 `buildSlotPtzJson` 1개만 계속 import 한다(`plateCenterError`/`pickNearestPlate`/`estimateGain`/`panTiltCorrection`/`zoomCorrection`/`isCentered`/`isWidthConverged`/`dampGain` 8개는 고아가 되어 import 목록에서 사라졌다). `controlMath.ts` 파일 자체가 변경되지 않았으므로 이 8개 함수는 **여전히 export 되어 있으나 소비자가 없는 상태**(dead export) — 다른 소비자가 없으면(§ 확인 필요) 향후 정리 후보이나 이번 범위에서는 삭제하지 않았다(0줄 변경 원칙).

---

## 3. `centering_slot` 신설이 기존 스키마에 주는 영향

`src/capture/SqliteStore.ts` 의 `ensureSchema()` 는 `CREATE TABLE IF NOT EXISTS` 로만 구성되어 있어 신규 테이블 추가가 기존 8개 테이블(`capture_run`/`observation`/`detection`/`occupancy`/`parking_slots`/`floor_roi`/`checkpoint`/그 외 1개 — 정확한 개수는 파일 상단 주석이 "8테이블→9테이블"로 갱신된 것으로 확인)·기존 5개 인덱스에 **구조적으로 영향을 줄 수 없다**(가산 전용, DROP/ALTER 없음).

```sql
CREATE TABLE IF NOT EXISTS centering_slot (
  slot_id TEXT NOT NULL, cam_id INTEGER NOT NULL, preset_id INTEGER NOT NULL,
  preset_slotidx INTEGER, pos TEXT NOT NULL, updated_at TEXT,
  PRIMARY KEY (cam_id, preset_id, slot_id)
);
```
- 기존 인덱스(`idx_det_obs`/`idx_obs_run_preset`/`idx_occ_run` 등) 정의문 뒤에 신규 테이블 CREATE 문이 삽입된 위치이며 순서와 무관하게 `IF NOT EXISTS` 라 충돌 없음.
- **구 DB 파일 마이그레이션 실측**: QA·리더 라이브 실행 모두 기존 `data/observations.sqlite`(사전에 8테이블만 갖고 있던 파일)에 대해 서버 기동 시 `centering_slot` 이 정상 생성됨을 실제로 확인했다(`03_qa_report.md` §7-1 "기존 실파일 DB 에 정상 생성됨").
- `src/api/dbRoutes.ts` 의 `/db/tables`·`/db/table/:name` 은 하드코딩 화이트리스트가 아니라 `SELECT name FROM sqlite_master WHERE type='table'` 동적 조회(`dbRoutes.ts:53-57`, 직접 확인)이므로, `centering_slot` 이 **`dbRoutes.ts` 코드를 한 줄도 바꾸지 않고** `/db/tables` 목록과 `/db/table/centering_slot` 조회에 자동으로 노출된다. QA 가 fastify `inject`(유닛)와 실기동 서버(`:13020`, 라이브) 양쪽에서 200 응답을 확인했다.
- 기존 컬럼명 관례(`cam_idx`/`preset_idx`, 예: `parking_slots`)와 이번 테이블의 `cam_id`/`preset_id` 가 불일치한다 — 마스터가 지정한 스키마이므로 그대로 반영했으나, 향후 두 테이블을 JOIN 하는 쿼리를 작성할 경우 컬럼명 매핑에 주의가 필요하다(문서 §4에도 동일 경고 기재).

---

## 4. config 스키마 변경(llmAdvise 제거·fallbackGain 부호 정정)이 기존 config 파일 파싱에 주는 영향

`src/config/toolsConfig.ts` 확인 결과 `CalibrateSchema`·`ToolsConfigSchema` 모두 `z.object({...})` 로 정의되며 **`.strict()` 가 어디에도 없다**(grep 확인). zod 의 기본 `z.object` 는 스키마에 없는 여분 키를 파싱 시 **조용히 제거(strip)**하고 에러를 던지지 않는다(strict 여야 비로소 여분 키 에러가 난다). 따라서:

- 만약 어딘가에 `llmAdvise: true` 가 남아 있는 구버전 `tools.config.json` 사본이 존재하더라도, `loadToolsConfig()` 파싱은 **깨지지 않는다** — 해당 키가 무시될 뿐이다. 실제로 이번 변경에서 저장소 내 유일한 `config/tools.config.json` 은 `llmAdvise` 줄을 직접 제거했으므로(§1 diff) 이 시나리오는 가상의 경우이지만, 배포 환경에 별도 config 파일이 남아 있다면 안전하게 동작한다.
- `fallbackGainPanDeg`/`fallbackGainTiltDeg` 는 zod 스키마상 `z.number()`(부호 제약 없음) — 20/15 든 −62/−35.5 든 타입 검증은 동일하게 통과한다. 즉 이번 변경은 **파싱 계약을 바꾸지 않고 값만 정정**했다. 부호 제약을 스키마에 추가하지 않은 것은 설계서의 의도적 판단(카메라 장착 방향에 따라 게인 부호가 카메라별로 다를 수 있어, 스키마로 음수를 강제하면 실카메라 확장을 막는다)이며, JSDoc 경고로 대체했다.
- **영향 받는 파일**: `config/tools.config.json`(값 정정 + 키 삭제), `test/calibrateRoutes.test.ts`·`test/ptzCalibrator.test.ts`(cfg 리터럴에서 `llmAdvise` 필드 제거·fallback 값 갱신 — 안 하면 TS 컴파일은 통과하지만[여분 키가 있어도 객체 리터럴 타입 에러 발생 가능], 실제로는 3개 테스트 파일 모두 갱신됨), `test/config.test.ts`(`llmAdvise` 단언 삭제 → fallback 값 단언으로 교체).

---

## 5. `src/index.ts` 배선 변경 — brain 제거, store 주입

```diff
- const calibrator = new PtzCalibrator({ camera, lpd, brain, repo, cfg: tools.calibrate });
+ const calibrator = new PtzCalibrator({ camera, lpd, repo, cfg: tools.calibrate, store: sqlite });
```

- `brain`(`AgentRuntime` 인스턴스, `index.ts:39`)은 이 한 줄에서만 빠졌을 뿐, 파일 전체에서 `SetupOrchestrator`/`CheckpointReviewer`/`FloorRoiReviewer`(추정)/`OccupancyReviewer`/`CaptureJob`/`Finalizer` 등 최소 6곳에서 여전히 주입되고 있음을 `grep -n brain src/index.ts` 로 확인했다(9줄 매치, `PtzCalibrator` 줄만 빠짐). 즉 `brain` 변수 자체는 고아가 아니며, **`PtzCalibrator` 가 `adviseCentering` 을 더 이상 호출하지 않게 된 것**이 실제 효과다.
- `store: sqlite` 는 `index.ts` 상단에서 이미 생성된 기존 `SqliteStore` 인스턴스(`tools.capture.dbFile` 대상)를 재사용 주입한 것이며, 신규 DB 커넥션이나 신규 파일을 만들지 않는다 — `centering_slot` 은 캡처 파이프라인과 **동일 SQLite 파일**에 테이블만 추가된 형태다. 이는 동일 파일에 대한 중복 WAL 커넥션을 피하기 위한 의도적 재사용이며, 파일 잠금·동시성 측면에서 기존 캡처 관련 쓰기와 동일한 커넥션을 공유하게 된다(별도 리스크 관찰되지 않음 — `better-sqlite3` 는 단일 프로세스 내 동일 커넥션 재사용이 표준 패턴).

---

## 6. 1-based 인덱스 규약 준수 확인

- `cam_id`/`preset_id`: `PlateTarget.camIdx`/`presetIdx` 를 그대로 저장 — 기존 `setup_artifact` 체계가 이미 1-based(`camIdx:1`부터)이므로 그대로 승계.
- `preset_slotidx`: `expandPlateTargets` 가 `coveredSlotIds.indexOf(slotId) + 1` 로 **명시적으로 +1** 하여 1-based 로 변환한다(`slotPtzWriter.ts` diff 확인). QA T9(`coveredSlotIds ['a','b','c']` 중 `'b'` → `presetSlotIdx=2`)와 라이브 실측(`preset_slotidx=1`, 단일 슬롯이 프리셋 내 첫 번째 위치) 양쪽에서 1-based 를 확인했다. 0-based 로 되돌리는 뮤테이션(M7, `pos + 1`→`pos`)이 QA T9 를 실제로 RED 로 만드는 것도 확인됨 — 이 불변식은 테스트로 강제되고 있다.
- 도출 불가 시(`coveredSlotIds` 미포함, 프리셋 자체 부재) `null` 을 쓰고 `0`/`-1` 등 임의값을 발명하지 않는다 — 1-based 규약을 어길 바에야 미해결로 남기는 방향.

---

## 7. 다른 에이전트(ActionAgent/DMAgent)·MCP 도구·`@parkagent/types` 영향 유무 — 조사 결과

별도 서브에이전트(Explore, 읽기 전용)로 저장소 전체를 조사한 결과다.

| 대상 | 결과 |
|---|---|
| `ActionAgent/` | `SlotPtzItem`/`SlotPtzArtifact`/`PlateTarget`/`slot_ptz`/`centering_slot`/`reason` 값을 소비하는 코드 **없음**. 설계 문서(`ActionAgent/docs/20260624_162408_ActionAgent_설계서.md`)에 "centering.run" 언급이 있으나 이는 VLA `/centering` MCP 결정형 도구를 가리키는 **ActionAgent 자체의 독립 설계**이며, SettingAgent 의 이번 `slot_ptz.json`/`centering_slot` 산출물과는 무관하다(이름만 유사, 소비 관계 없음). |
| `DMAgent/` | 매치 0건. **해당 없음**. |
| `@parkagent/types`(`packages/types/src/index.ts`) | 확인됨 — 그러나 `SlotPtzItem`/`PlateTarget`/`CenteringSlotRow`/`Ptz` 타입은 **이 패키지에 없다**. 패키지에는 `NormalizedRect`/`Point`/`Quad`/`Polygon`/`Camera`/`Preset`/`ParkingSlot`/`VehicleBox`/`Occupancy`/`ParkingEvent` 등만 정의되어 있다. `SettingAgent/src/calibrate/types.ts` 최상단 주석이 "SettingAgent 초기 셋팅 산출물 — `@parkagent/types` 승격 안 함"이라고 이미 명시하고 있어, 이번 변경은 이 의도적 로컬-전용 방침을 그대로 유지했다. **공유 도메인 타입 영향 없음.** |
| SettingAgent `src/mcp`, `src/tools`(MCP 도구) | 디렉토리는 존재(`src/mcp/server.ts`, `src/tools/e2eSmoke.ts`, `exportCamerapos.ts`)하나, 등록된 MCP 도구는 `camera_req_img`/`camera_req_move`/`vpd_detect`/`unity_rpc`/`unity_rpc_catalog` 뿐이다. `centering_slot`/`slot_ptz`/`PlatePtz`/`PtzCalibrator` 를 참조하는 MCP 도구는 **없음** — 이 기능은 MCP 가 아니라 순수 REST(`POST /calibrate/ptz` 등, `src/api/calibrateRoutes.ts`)로만 노출된다. |

**결론**: 이번 변경은 SettingAgent 리포 내부(소스 7 + 테스트 3 + web 2 + config 1)로 완전히 국한되며, ActionAgent/DMAgent·공유 타입 패키지·MCP 도구 표면 어디에도 관측 가능한 파급이 없다. 단, 이는 "현재 코드베이스에 그런 소비 코드가 없다"는 사실 확인이며, **향후 ActionAgent 가 `slot_ptz.json` 또는 `centering_slot` 을 prior 로 소비하기 시작하면** §3 의 `reason` 값 집합 변화(`occluded` 소멸, `max_iterations`/`zoom_saturated` 신규)와 §2-1 의 "center 실패 시 zoom 미시도"(centered/converged 계산 로직 변화)를 반드시 재검토해야 한다 — **확인 필요 항목으로 명시**한다.

---

## 8. 요약 (리더 보고용)

- **파일 변경면**: 코드 13파일(소스 7 + 테스트 3 + web 2 + config 1) + 데이터 1파일(`setup_artifact.json`, 리더의 라이브 검증용 복원 — 코드 아님).
- **0줄 변경 확인**: `platePtz.ts`/`controlMath.ts` — 위임 전제 그대로 지켜짐.
- **DB 영향**: `centering_slot` 신설은 기존 8테이블·인덱스·`dbRoutes` 화이트리스트에 무해 가산. 구 DB 파일에도 `CREATE TABLE IF NOT EXISTS` 로 안전 마이그레이션됨(라이브 실증).
- **config 영향**: zod 비-strict 라 `llmAdvise` 잔존 키가 있어도 파싱 불파괴. fallback 부호 정정은 타입 계약 변화 없이 값만 교정.
- **index.ts 배선**: `brain` 은 다른 소비자가 있어 전체 고아 아님 — `PtzCalibrator` 의 `adviseCentering` 호출만 없어짐.
- **1-based 규약**: `preset_slotidx` 의 `+1` 파생과 null 폴백으로 준수, 테스트(T9)·뮤테이션(M7)·라이브 양쪽에서 확인.
- **타 에이전트/공유 타입/MCP**: 확인된 소비 코드 없음(Explore 조사). 단 향후 ActionAgent 가 이 산출물을 소비하기 시작할 경우 reason 값 집합 변화 재검토가 필요함을 확인 필요 항목으로 남김.
- **완료 게이트**: `npm test` 155 files / 1731 passed / 0 failed, `npm run typecheck` 무오류. 라이브 왕복 + 독립 재관측(중심오차 0.0049, 폭 0.1899) 성공.
