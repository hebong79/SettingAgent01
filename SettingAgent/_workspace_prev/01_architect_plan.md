# 01. 구현 계획 — 장기 관측·반복 수집 → SQLite 누적 → LLM 정밀 주차면 확보

- 작성: 설계자(architect) · 2026-06-25
- 기준 설계서(단일 기준): `SettingAgent/docs/20260625_224842_장기관측_반복수집_SQLite_LLM정밀주차면_설계서.md`
- 범위: 설계서 §10 1~7단계(SettingAgent 측 전부) + SettingViewer 프록시/UI(6단계). §10-8 동작확인은 QA가 시뮬레이터로 수행.
- 불변 계약(절대 변경 금지): `@parkagent/types`(SetupArtifact/ParkingSlot/NormalizedRect/GlobalSlotIndex), 기존 `/setup/*`·`/mapping`, 기존 81 테스트.
- 원칙: ParkSimMgr 컨벤션(ESM `.js` import, 1-based cam/preset/positionIdx, `fetchWithTimeout`/`withRetry` 재사용, 외과적·단순함 우선). 과설계 금지 — 설계서 범위만.

---

## 0. 핵심 설계 결정(설계서에서 확정, 구현자가 따를 것)

1. **방식 C(체크포인트 하이브리드)**: 결정형 누적이 정확도의 뼈대, LLM은 전략·판정 보조. LLM 호출은 `(N/K)+1` 수준.
2. **정지조건 = 횟수 기본 + 언제든 수동 정지**. 수렴은 LLM **자문 표시만**(자동 정지 아님).
3. **1차 체크포인트는 텍스트 요약만**(비전 썸네일 제외 — 설계서 §11-4, 사용자 확정). 비전은 후속 옵션.
4. **좌표 불변식**: 좌표는 검출+집계만 생성/수정. LLM은 클러스터 병합/라벨/수용·거부 **판정**과 수렴 **자문**만. bbox 좌표를 만들거나 바꾸지 않는다.
5. **LLM 비활성(`llm.enabled=false`) 강등**: 체크포인트·최종 LLM 생략 → 결정형 집계만으로 `SetupArtifact` 산출(방식 A 강등). 무LLM에서도 동작.
6. **better-sqlite3**(동기·프리빌트). DB 경로는 **주입 가능**(`:memory:`/임시파일 테스트).
7. **SetupArtifact 계약·`/setup/*`·`/mapping` 불변. 모두 가산적.**

---

## 1. 파일별 신규/수정 목록

### 1.1 SettingAgent — 신규

| 파일 | 책임 |
|------|------|
| `src/capture/SqliteStore.ts` | better-sqlite3 DAO. 6테이블 스키마 보장(`CREATE IF NOT EXISTS`)·DAO 메서드. 생성자에 **dbPath 주입**(`:memory:` 또는 파일). 순수 동기. 좌표·통계 read/write 만, 비즈니스 로직 없음. |
| `src/capture/Aggregator.ts` | **결정형 순수함수**: 누적 detection → 프리셋별 클러스터(clusterDist)·지지(clusterMinSupport)·대표 bbox(중앙값)·occupancyRate·plateRoi. DB·IO 의존 없음(입력=평면 행 배열, 출력=AggregatedSlot 배열). 합성 데이터 테스트 가능. |
| `src/capture/CaptureJob.ts` | 상태머신(idle→running→stopping→finalizing→done\|stopped\|error)·count·수동정지·주기 러너. 캡처 1라운드 = 프리셋 순회 → CameraClient/req_img → VPD(+LPD) → SqliteStore 적재. 주기 타이머·sleep·now **주입**(fake timers). 중복 시작 거부. K라운드마다 집계+(LLM 체크포인트). |
| `src/capture/CheckpointReviewer.ts` | 집계 텍스트 요약 → AgentRuntime.reviewCheckpoint → `{merges,labels,rejects,coverage,convergence}` 반영(메타만, 좌표 불변). 결과를 `checkpoint` 행 저장. LLM 비활성 시 no-op(null 반환). |
| `src/capture/Finalizer.ts` | 전체 집계 + 체크포인트 컨텍스트 → (LLM 활성 시) AgentRuntime.finalizeCapture 보조판정 → AggregatedSlot → `IndexableSlot`/`ParkingSlot`/`Preset` 조립 → `buildGlobalIndex`/`validateCoverage` → `SetupArtifact` → `Repository.saveArtifact` + `artifact_snapshot` 기록. LLM 비활성 시 결정형 강등. |
| `src/capture/types.ts` | capture 모듈 내부 타입(`CaptureRunRow`/`ObservationRow`/`DetectionRow`/`AggregatedSlot`/`CaptureStatus`/`CheckpointSummary`). **@parkagent/types 와 분리**(공유 계약 오염 금지). |
| `src/api/captureRoutes.ts` | `/capture/*` 라우트 등록 함수(`registerCaptureRoutes(app, deps)`) + zod 스키마. server.ts 가 호출(라우트 순서 보존). |

### 1.2 SettingAgent — 수정(가산만, 외과적)

| 파일 | 수정 |
|------|------|
| `src/config/toolsConfig.ts` | `CaptureSchema` 추가 + `ToolsConfigSchema.capture` + `DEFAULT_TOOLS_CONFIG.capture` + `loadToolsConfig` 섹션 병합 루프에 자동 포함(키 기반 루프라 추가 불필요 — 검증만). |
| `src/brain/SetupBrain.ts` | `CheckpointInput`/`CheckpointResultSchema`/`FinalizeCaptureInput`/`FinalizeCaptureResultSchema` 타입·zod 추가 + `SetupBrain` 인터페이스에 `reviewCheckpoint?`/`finalizeCapture?` **옵셔널** 메서드 추가(기존 구현 무영향). |
| `src/brain/AgentRuntime.ts` | `reviewCheckpoint`/`finalizeCapture` 메서드 추가(기존 `chatJson` 재사용, 텍스트 요약 입력). 비활성 시 null. 기존 메서드 불변. |
| `src/api/server.ts` | `ApiDeps`에 `captureJob`/`finalizer`/`sqlite` 옵셔널 추가 + `registerCaptureRoutes(app, ...)` 호출 1줄. 기존 라우트 불변. |
| `src/index.ts` | SqliteStore/CaptureJob/CheckpointReviewer/Finalizer 조립 + buildServer 주입. 기존 조립 불변. |
| `package.json` | `dependencies`에 `better-sqlite3` + `devDependencies`에 `@types/better-sqlite3`. |
| `config/tools.config.json` | `capture` 섹션 추가(설계서 §7 값). |

### 1.3 SettingViewer — 신규/수정

| 파일 | 신규/수정 | 책임 |
|------|----------|------|
| `src/server.ts` | 수정 | `/viewer/api/capture/*` 프록시 추가(기존 `/viewer/api/mapping` 프록시와 동일 `fetchWithTimeout` 패턴, GET/POST 모두). `registerViewerRoutes` 호출 **전**에 등록(정적 와일드카드보다 앞). |
| `web/core.js` | 수정 | 순수 로직 추가: `captureProgress(status)`(진행률 %), `mapAdvisory(checkpoint)`(자문 표시 매핑), `pollPlan`(폴링 간격). DOM/fetch 미참조. |
| `web/index.html` | 수정 | "정밀 수집" 탭 마크업(반복횟수·주기·체크포인트 입력, 시작/정지/최종화 버튼, 진행바, 자문 패널). |
| `web/app.js` | 수정 | 탭 핸들러 + core.js 순수로직에 fetch/DOM 주입(폴링 시작/정지). |
| `web/core.d.ts` | 수정 | 신규 순수함수 타입 선언 추가. |

> SettingViewer는 **얇은 제어·모니터 UI + 프록시**만. 집계·DB·LLM 로직은 SettingAgent 소유(설계서 §3).

---

## 2. SQLite 스키마 · DAO 시그니처 (설계서 §5)

### 2.1 스키마(SqliteStore 생성자에서 `CREATE TABLE IF NOT EXISTS`로 보장)
6테이블: `capture_run`, `observation`, `detection`, `aggregated_slot`, `checkpoint`, `artifact_snapshot` — 컬럼은 설계서 §5 그대로.
인덱스: `CREATE INDEX IF NOT EXISTS idx_det_obs ON detection(observation_id)`, `idx_obs_run_preset ON observation(run_id, preset_idx)`.

### 2.2 DAO 시그니처(`src/capture/SqliteStore.ts`)
```ts
export class SqliteStore {
  constructor(dbPath: string);                 // ':memory:' | 파일경로. 생성 시 스키마/인덱스 보장.
  close(): void;

  // 런
  createRun(p: { plannedCount: number; intervalMs: number; startedAt: string }): number; // → run_id
  updateRunProgress(runId: number, doneCount: number): void;
  endRun(runId: number, p: { status: 'done'|'stopped'|'error'; stopReason: 'count'|'manual'|'error'; endedAt: string }): void;
  getRun(runId: number): CaptureRunRow | undefined;
  listRuns(limit?: number): CaptureRunRow[];

  // 관측·검출(라운드 단위)
  insertObservation(o: { runId: number; roundIdx: number; camIdx: number; presetIdx: number; capturedAt: string; pan: number; tilt: number; zoom: number; imgName: string }): number; // → observation_id
  insertDetections(observationId: number, camIdx: number, presetIdx: number, dets: Array<{ kind:'vehicle'|'plate'; x:number; y:number; w:number; h:number; conf:number }>): void; // 트랜잭션 일괄

  // 집계 입력·출력
  getDetectionsForRun(runId: number): DetectionRow[];   // Aggregator 입력(평면 배열)
  replaceAggregatedSlots(runId: number, slots: AggregatedSlot[]): void; // run 기준 delete+insert(멱등)
  getAggregatedSlots(runId: number): AggregatedSlot[];

  // 체크포인트·스냅샷
  insertCheckpoint(runId: number, atRound: number, createdAt: string, summaryJson: string): void;
  getLatestCheckpoint(runId: number): CheckpointRow | undefined;
  insertArtifactSnapshot(runId: number, createdAt: string, artifactJson: string): void;
}
```
- 모든 좌표 정규화 0~1. 1-based cam/preset.
- `replaceAggregatedSlots`는 트랜잭션(`db.transaction`)으로 원자적.

---

## 3. Aggregator 결정형 알고리즘 (설계서 §4.2, §8)

`src/capture/Aggregator.ts` — **순수함수**(DB 비의존):
```ts
export interface AggregateOptions { clusterDist: number; clusterMinSupport: number; minConfidence: number; }
export function aggregate(dets: DetectionRow[], opts: AggregateOptions): AggregatedSlot[];
```
알고리즘(설계서 + 기존 `RoiAccumulator.buildSlotsAccumulated` 패턴 차용·확장):
1. `kind==='vehicle'` 검출만 클러스터 대상. `conf < minConfidence` 제외.
2. **프리셋별로** 분리(`presetKey = camIdx:presetIdx`). 같은 프리셋 내에서만 클러스터링(다른 프리셋 좌표계 혼합 금지).
3. 그리디 클러스터링: 중심 거리 `clusterDist` 이내면 같은 클러스터(기존 `dist`/`center` 재사용). 
4. `support`(관측 수) `< clusterMinSupport` 클러스터는 `status:'rejected'`(노이즈), 이상은 `status:'candidate'`.
5. 대표 bbox = 멤버 **중앙값**(median x/y/w/h — 지터에 평균보다 강건. 설계서 §4.2 "중앙값/대표 bbox" 명시). 별도 `median()` 헬퍼.
6. `occupancyRate` = (해당 클러스터에 차량 검출이 있었던 관측 라운드 수) / (해당 프리셋 총 관측 라운드 수). 관측 라운드 수는 별도 인자 또는 dets 의 distinct observation_id 로 산출 → **`aggregate`에 프리셋별 총 라운드 맵을 함께 전달**(`presetRounds: Map<string, number>`).
7. `plateRoi`: `kind==='plate'` 검출을 같은 방식으로 클러스터링 후 각 vehicle 클러스터에 귀속(기존 `matchPlatesToSlots` 규칙 — 번호판 중심이 vehicle 대표 ROI 내부 + 겹침 최대). 매칭된 클러스터의 `plate_x/y/w/h` 채움.
8. 출력: `AggregatedSlot[]`(preset_key·cluster_id·좌표·support·occupancy_rate·plate_*·status). 좌표는 정규화, positionIdx는 Finalizer에서 `orderByPosition`으로 부여(집계는 좌표·통계만).

> 재사용: `domain/geometry`(center/dist/median 없으면 추가), `setup/ordering.orderByPosition`(Finalizer에서), `setup/plateMatch` 규칙. **새 클러스터 로직은 RoiAccumulator와 중복되나 입력 형태(평면 DetectionRow vs frames)·median·occupancy가 달라 별도 함수가 단순**(과한 추상화로 통합하지 않음).

---

## 4. CaptureJob 상태머신 (설계서 §4.1)

`src/capture/CaptureJob.ts`:
```ts
export type CaptureState = 'idle'|'running'|'stopping'|'finalizing'|'done'|'stopped'|'error';
export interface CaptureJobDeps {
  camera: CameraClient; vpd: VpdClient; lpd?: LpdClient;
  store: SqliteStore; aggregator: typeof aggregate; reviewer?: CheckpointReviewer;
  cfg: ToolsConfig['capture']; lpdEnabled: boolean;
  setTimer?: (fn:()=>void, ms:number)=>NodeJS.Timeout; clearTimer?: (h:NodeJS.Timeout)=>void; // 주입(fake timers)
  sleep?: (ms:number)=>Promise<void>; now?: ()=>string;
}
export class CaptureJob {
  start(p: { count:number; intervalMs:number; checkpointEvery:number; targets: SetupTarget[] }): { runId:number };
  stop(): void;            // running→stopping(현재 라운드까지만 마치고 stopped)
  getStatus(): CaptureStatus; // {state, runId?, round, done, planned, latestAdvisory?}
  getRunId(): number | undefined;
}
```
상태전이:
- `idle --start--> running`. **중복 시작 거부**(running/stopping/finalizing 중 start → 에러 `{error:'capture already running'}`).
- 매 라운드: 프리셋 순회 캡처·검출·DB 적재 → `done++` → `updateRunProgress`. `done % checkpointEvery === 0` 이고 reviewer 있으면 집계 후 체크포인트.
- `running --stop--> stopping`: 진행 중 라운드 마치면 `stopped`(stop_reason='manual'). 타이머 다음 발화 취소.
- `done === planned` 도달 시 자동 종료(stop_reason='count') → `done` 상태(여기서는 finalize는 별도 호출 — 설계서 §6.1 "정지/완료 후 호출").
- 라운드 중 예외 → `error`(런 status='error', stop_reason='error'). 개별 프리셋 캡처 실패는 경고로 흡수(잡 중단 아님 — 기존 detectPlates 패턴).
- 주기 러너는 `setTimer` 주입으로 fake timers 테스트. 단일 잡(인메모리 1개 인스턴스).

---

## 5. 체크포인트 / 최종화 + AgentRuntime 가산 (설계서 §4.3·4.4·8)

### 5.1 SetupBrain 인터페이스 가산(옵셔널 — 기존 구현 무영향)
```ts
export interface CheckpointInput {
  atRound: number; plannedCount: number;
  presets: Array<{ key:string; slotCount:number; expected?:number; avgOccupancy:number }>;
  newFacesRecentK: number; // 최근 K회 신규 면 수(수렴 신호 입력)
}
export const CheckpointResultSchema = z.object({
  merges: z.array(z.array(z.string())).default([]),     // 같은 면으로 볼 cluster_id 그룹
  labels: z.record(z.string(), z.string()).default({}), // preset_key/cluster_id → zone 라벨
  rejects: z.array(z.string()).default([]),             // 노이즈 cluster_id
  coverage: z.array(z.object({ preset:z.string(), expected:z.number(), got:z.number(), short:z.boolean() })).default([]),
  convergence: z.object({ converged:z.boolean(), advice:z.string() }).default({ converged:false, advice:'' }),
});
export const FinalizeCaptureResultSchema = z.object({
  duplicates: z.array(z.array(z.string())).default([]), // 프리셋 간 중복 cluster_id 그룹
  zoneLabels: z.record(z.string(), z.string()).default({}),
  rejects: z.array(z.string()).default([]),
  report_ko: z.string().default(''),
});
// SetupBrain 에 옵셔널 추가:
//   reviewCheckpoint?(input: CheckpointInput): Promise<CheckpointResult | null>;
//   finalizeCapture?(input: FinalizeCaptureInput): Promise<FinalizeCaptureResult | null>;
```

### 5.2 AgentRuntime 메서드(텍스트 요약 입력, 기존 `chatJson` 재사용, 비활성 시 null)
- `reviewCheckpoint(input)`: 집계 텍스트 요약을 user 프롬프트로 → CheckpointResultSchema 파싱. 프롬프트는 llm.config의 신규 `capturePrompts.checkpoint.{system,user}`(없으면 인라인 기본 프롬프트로 폴백 — 단순함 위해 1차는 **인라인 한글 프롬프트** 사용, 프롬프트 파일화는 후속).
- `finalizeCapture(input)`: 전체 집계 + 체크포인트 누적 요약 → FinalizeCaptureResultSchema.
- **이미지 미전달**(§11-4 텍스트만). `chatJson(system, user, parse)` 그대로.

### 5.3 CheckpointReviewer 적용 범위(좌표 불변)
- `merges`/`rejects` → `aggregated_slot.status`를 `merged`/`rejected`로 갱신(좌표 불변). `labels` → 후속 Finalizer에서 zone 부여.
- `coverage`/`convergence` → `checkpoint.summary_json` 저장 + `getStatus().latestAdvisory`로 노출(자동 정지 아님 — 표시만).

### 5.4 Finalizer 결정형 강등 경로
- LLM 활성: `finalizeCapture` 결과로 프리셋 간 중복 제거·zone 라벨·노이즈 제외 반영 → ParkingSlot/Preset 조립.
- LLM 비활성/실패: 결정형만 — `status!=='rejected'` 클러스터만 채택, zone=`cam{N}` 기본, 중복 제거 생략. `report` 생략.
- **공통(좌표 불변식)**: ParkingSlot.roi = AggregatedSlot 대표 bbox 그대로. positionIdx = `orderByPosition`. slotId = `c{cam}p{preset}s{pos}`(기존 `slotIdOf` 규칙 동일). `buildGlobalIndex`/`validateCoverage` 재사용. `SetupArtifact` shape 기존과 동일.

---

## 6. `/capture/*` REST 명세 + zod (설계서 §6.1)

`src/api/captureRoutes.ts` — 기존 `/setup/*` 불변, 가산:

| 메서드 | 경로 | body/zod | 응답 |
|--------|------|----------|------|
| POST | `/capture/start` | `{count:int>0, intervalMs?:int>0, checkpointEvery?:int>0, targets?:Target[]}` | `{ok, runId}` / 409 `{error:'capture already running'}` |
| GET | `/capture/status` | — | `{state, runId?, round, done, planned, latestAdvisory?}` |
| POST | `/capture/stop` | — | `{ok, state}` (running 아니면 400) |
| POST | `/capture/finalize` | `{runId?}` (미지정 시 최근 종료 런) | `{ok, slots, globalCount}` / 409 if running |
| GET | `/capture/runs` | — | `CaptureRunRow[]`(메타) |
| GET | `/capture/runs/:id/aggregate` | params id:int | `AggregatedSlot[]` / 404 |

- `targets` 미지정 시 기존 `loadSetupTargets(mapFiles)`/discovery 재사용(server.ts의 run-from-map 로직 차용).
- zod 스키마는 `TargetSchema`(server.ts 기존) 재export/재사용.
- `intervalMs`/`checkpointEvery` 미지정 시 `cfg.capture` 기본값.

---

## 7. SettingViewer 프록시 + UI (설계서 §6.2)

### 7.1 프록시(`src/server.ts`, 기존 `/viewer/api/mapping` 패턴 복제)
- `GET /viewer/api/capture/status`, `GET /viewer/api/capture/runs`, `POST /viewer/api/capture/start`, `POST /viewer/api/capture/stop`, `POST /viewer/api/capture/finalize` → `${settingAgentUrl}/capture/*` 중계.
- 동일 에러 처리: 404 패스스루, 5xx→502, 미가동→502 `unreachable`. body 패스스루(POST는 `req.body` JSON 전달).
- **단순화**: 개별 라우트 5개 대신 prefix 기반 1개 핸들러(`/viewer/api/capture/*`)로 메서드·경로 패스스루 가능하나, 기존 코드가 명시 라우트 스타일 → **명시 라우트로 일관**(외과적).

### 7.2 UI(`web/index.html` 탭 + `web/app.js` + `web/core.js`)
- 탭: 기존 `control`/`inspect`에 `precise`("정밀 수집") 추가(기존 `data-tab` 패턴).
- 입력: 반복 횟수(기본 정지조건), 주기(초), 체크포인트 간격. 버튼: 시작/정지/최종화. 진행: 진행바(done/planned)·라운드·검출 수·체크포인트 자문(수렴됨/부족 프리셋)·경고. 완료 후 검수 탭이 `/viewer/api/mapping` 표시(정밀 결과).
- **순수 로직(`core.js`, 테스트 분리)**:
  - `captureProgress(status)` → `{percent, label}`(done/planned, 0 division 방어).
  - `mapAdvisory(checkpoint)` → 표시 문자열 배열(coverage short/convergence).
  - `pollPlan(state)` → 폴링 계속 여부·간격(running 중만 폴링).
- `app.js`는 fetch/DOM을 core 순수함수에 주입(기존 `createStreamLoop` 주입 패턴 동일).

---

## 8. 설정 스키마(capture 섹션) · 기본값 · 하위호환 (설계서 §7)

`toolsConfig.ts`에 추가:
```ts
const CaptureSchema = z.object({
  defaultCount: z.number().int().positive(),
  intervalMs: z.number().int().positive(),
  checkpointEvery: z.number().int().positive(),
  dbFile: z.string().min(1),
  clusterDist: z.number().min(0).max(1),
  clusterMinSupport: z.number().int().positive(),
  minConfidence: z.number().min(0).max(1),  // 집계용(setup 과 독립값 허용)
});
// DEFAULT_TOOLS_CONFIG.capture:
{ defaultCount: 50, intervalMs: 30000, checkpointEvery: 10, dbFile: 'data/observations.sqlite',
  clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5 }
```
- **하위호환**: `loadToolsConfig`는 `DEFAULT_TOOLS_CONFIG`의 키를 루프 병합 → `capture` 키 자동 포함. 기존 `tools.config.json`(capture 없음)도 기본값으로 채워져 파싱 성공(기존 config.test.ts 회귀 없음 — DEFAULT에 capture 추가되므로 `toEqual(DEFAULT)` 테스트는 자동 정합).
- `config/tools.config.json`에 `capture` 섹션 추가(명시값).

---

## 9. 단계별 작업 순서 + vitest 검증 기준 (설계서 §10 / G1~G5 매핑)

```
1. SqliteStore (better-sqlite3 + 6테이블·DAO)
   → 검증(G2): :memory: store 에 run/observation/detection 적재 후 getDetectionsForRun/listRuns 조회 일치.
     replaceAggregatedSlots 멱등(2회 호출 → 중복 없음). 스키마 IF NOT EXISTS 재생성 무해.
2. Aggregator (순수함수: 클러스터·지지·점유·plateRoi)
   → 검증(G3): 합성 DetectionRow 배열 입력 →
     - 같은 위치 반복 검출 → 1 클러스터·support=N·중앙값 bbox.
     - support<minSupport → status:'rejected'.
     - 점유/미점유 라운드 혼합 → occupancyRate 정확.
     - plate 검출이 vehicle ROI 내부 → 해당 클러스터 plate_* 채움.
     - 프리셋 분리: 다른 preset_key 검출은 별도 클러스터.
3. CaptureJob (상태머신·count·수동정지·주기 — fake timers)
   → 검증(G1): fake setTimer 주입.
     - start→running, 중복 start 거부(에러).
     - count 라운드 도달 → done 상태(stop_reason='count'), DB done_count 일치.
     - 수동 stop → 현재 라운드 마치고 stopped(stop_reason='manual').
     - 캡처 1프레임 실패 → 잡 미중단(경고 흡수). 라운드 예외 → error.
     - fake camera/vpd 주입(기존 setupOrchestratorBrain.test 패턴).
4. /capture/* REST + zod (fastify.inject)
   → 검증: app.inject 로 start(200,runId)/status/stop/finalize/runs/runs/:id/aggregate.
     잘못된 body → 400. running 중 finalize → 409. 기존 /setup/* 라우트 200 회귀 확인.
5. CheckpointReviewer + Finalizer (브레인 모킹)
   → 검증(G4): fake brain(reviewCheckpoint/finalizeCapture) 주입.
     - merges/labels/rejects 반영(status 갱신, zone 라벨). 좌표 불변(대표 bbox 그대로) 검증.
     - finalize → SetupArtifact shape(presets/slots/globalIndex/createdAt) + repo.saveArtifact 호출 + artifact_snapshot 행.
     - LLM off 강등: brain 미주입 → 결정형 산출(rejected 제외, zone=cam{N}, report 없음).
     - globalIndex validateCoverage ok.
6. SettingViewer /viewer/api/capture/* 프록시 + core 순수로직
   → 검증(G5): mappingProxy.test 패턴(stub upstream) — status/start/stop/finalize 패스스루·404·502·unreachable.
     core.js: captureProgress/mapAdvisory/pollPlan 단위테스트(viewerCore.test 패턴).
7. 설정(capture) · 문서 · 영향도
   → 검증: config.test — loadToolsConfig 에 capture 기본값 존재, 기존 tools.config.json 파싱 성공.
     문서화 에이전트가 한글 .md(yyyyMMdd_hhmmss) 작성.
8. 동작확인(QA): 시뮬레이터(:13100) N=소수·짧은 주기 → 수집→집계→(LLM)→/mapping 정밀 결과 확인.
```
- 테스트: vitest, 외부 서버·LLM 모킹. SQLite는 `:memory:`/임시파일.
- 각 단계는 독립 통과 가능(앞 단계 산출물에만 의존).

---

## 10. 영향도 사전분석 (설계서 §9)

| 대상 | 영향 | 확인 포인트 |
|------|------|------------|
| `@parkagent/types`(SetupArtifact 등) | **변경 없음** | capture/types.ts는 별도 정의. Action/DM 무영향. |
| `/setup/*`·`/mapping` | **불변** | captureRoutes는 가산. server.ts 기존 라우트 미수정. |
| 기존 81 테스트 | **회귀 없음** | 단 `config.test`의 `toEqual(DEFAULT_TOOLS_CONFIG)`는 DEFAULT에 capture 추가로 자동 정합(테스트 수정 불필요). 기타 영향 없음. |
| `better-sqlite3` | 신규 의존성(네이티브) | **Windows 프리빌트 설치 확인**: `npm i better-sqlite3` 후 `node -e "require('better-sqlite3')"` 빌드 없이 로드되는지. 실패 시 `node:sqlite`(Node22+) 대안 검토(설계서 §11-2). 프리빌트 가용 Node 버전 확인. |
| AgentRuntime/SetupBrain | 가산(옵셔널 메서드) | 기존 judgePreset/dedupeAndLabel/finalReport·reviewSetup 불변. 옵셔널이라 기존 fake brain 테스트 무영향. |
| SettingViewer | 가산(프록시+탭) | `/viewer/api/mapping`·기존 탭·`createStreamLoop` 불변. |
| 운영 | 두 서비스(13020/13030) 동시 운영·장시간 잡·DB 증가 | DB 파일 위치(`store.dataDir`/`capture.dbFile`). 보존/정리 정책 후속. |

---

## 11. 리스크 / 미확정 (설계서 §11)

1. **better-sqlite3 설치(Windows 프리빌트)** — 1순위 리스크. 1단계 시작 시 즉시 설치·로드 실측. 프리빌트 미가용 시 리더에 보고 후 `node:sqlite` 대안 결정.
2. **집계 임계 튜닝값**(`clusterDist`/`clusterMinSupport`/`intervalMs`/`minConfidence`) — 시뮬 기준 잠정값. 실데이터 튜닝은 후속(설정으로 노출하여 조정 가능).
3. **장시간 잡 운영·DB 증가** — 1차는 런 단위 보존. 정리 정책 범위 밖.
4. **재기동 복구**(running 중 프로세스 종료) — **범위 밖**. 상태만 DB 기록(런 status='running'으로 남음). 재기동 시 정리 로직 없음(후속).
5. **체크포인트/최종 프롬프트 위치** — 1차 인라인 한글 프롬프트(단순함 우선). 프롬프트 파일화(llm.config capturePrompts)는 후속. → 구현자가 인라인으로 시작하되 리더 확인 권장.
6. **occupancyRate 분모(프리셋 총 라운드 수)** — Aggregator에 `presetRounds` 맵을 함께 전달하는 설계. observation 테이블에서 `COUNT(DISTINCT round_idx) GROUP BY preset` 으로 SqliteStore가 제공.

---

## 12. 구현자/문서화 전달 요약

- **구현자(developer)**: §1 파일목록 순서대로(§9 단계) 구현. 좌표 불변식(§0-4)·ESM `.js` import·1-based·주입형 의존성(timer/sleep/now/dbPath) 필수. RoiAccumulator/ordering/plateMatch/geometry/GlobalIndexer 재사용. 1단계에서 better-sqlite3 설치 실측 먼저.
- **문서화(documenter)**: 영향 범위 = SettingAgent capture 모듈 신규 + AgentRuntime/server/index/config 가산, SettingViewer 프록시+탭. @parkagent/types·/setup/*·기존 81테스트 불변. 한글 .md(yyyyMMdd_hhmmss) 작성.
- **미해결 → 리더 확인 권장**: (a) 체크포인트 프롬프트 인라인 vs 파일화(§11-5), (b) better-sqlite3 프리빌트 가용성(§11-1) — 1단계 실측 결과 보고.
