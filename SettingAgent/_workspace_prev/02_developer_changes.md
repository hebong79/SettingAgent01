# 02. 구현 변경 내역 — 장기 관측·반복 수집 → SQLite 누적 → LLM 정밀 주차면

- 작성: 구현자(developer) · 2026-06-25
- 기준: `_workspace/01_architect_plan.md` + 설계서 `docs/20260625_224842_*.md`
- 결과: **SettingAgent typecheck 통과 · SettingAgent 기존 81 테스트 통과 · SettingViewer typecheck 통과 · SettingViewer 62 테스트 통과**.

---

## 0. DB 라이브러리 실측 결과 (1순위 리스크 — 해소)

- `npm install better-sqlite3 -w SettingAgent` → **better-sqlite3@12.11.1 프리빌트 설치 성공**.
  - 프리빌트 바이너리 존재 확인: `node_modules/better-sqlite3/build/Release/better_sqlite3.node`.
  - `node -e "require('better-sqlite3'); new D(':memory:') ... "` → **네이티브 빌드 없이 로드·CRUD 동작 확인**(Node v24.16.0, Windows 11).
  - allow-scripts 정책으로 install 스크립트가 자동 실행되지 않았으나, prebuild-install 산출물이 동봉되어 **node-gyp 빌드 불필요**.
- `@types/better-sqlite3@7.6.13` devDependency 설치.
- **결론**: `node:sqlite` 대안 불필요. 계획대로 better-sqlite3 채택. `SqliteStore` 인터페이스는 dbPath 주입형으로 유지(구현 교체 시 테스트 영향 최소).

---

## 1. 신규 파일 (SettingAgent)

| 파일 | 내용 |
|------|------|
| `src/capture/types.ts` | capture 내부 타입(`CaptureRunRow`/`ObservationRow`/`DetectionRow`/`AggregatedSlot`/`CheckpointRow`/`CaptureState`/`CaptureStatus`). @parkagent/types 와 분리. |
| `src/capture/SqliteStore.ts` | better-sqlite3 DAO. 6테이블+2인덱스 `IF NOT EXISTS` 보장. dbPath 주입. 동기. (DAO 시그니처는 §3) |
| `src/capture/Aggregator.ts` | **순수함수** `aggregate(dets, presetRounds, opts)`. 프리셋 분리·그리디 클러스터·중앙값 대표 bbox·support·occupancyRate·plateRoi 귀속. DB/IO 비의존. |
| `src/capture/CheckpointReviewer.ts` | 집계 텍스트 요약 → `brain.reviewCheckpoint` → `merges`/`rejects` status 갱신(좌표 불변) + `checkpoint` 행 저장. 순수 헬퍼 `clusterRef`/`advisoryLines` export. LLM 비활성/실패 시 null. |
| `src/capture/CaptureJob.ts` | 상태머신(idle→running→stopping→finalizing→done/stopped/error). 라운드 러너(프리셋 순회 캡처→VPD(+LPD)→적재). K라운드마다 집계+체크포인트. timer/sleep/now 주입. 중복 시작 거부. |
| `src/capture/Finalizer.ts` | 전체 집계(체크포인트 status 보존) + (LLM 활성 시)`finalizeCapture` 보조판정 → `orderByPosition`/`buildGlobalIndex`/`validateCoverage` → `SetupArtifact` → `repo.saveArtifact` + `artifact_snapshot`. LLM 비활성 시 결정형 강등. |
| `src/api/captureRoutes.ts` | `registerCaptureRoutes(app, deps)` + zod. `/capture/start|status|stop|finalize|runs|runs/:id/aggregate`. |

## 1.1 수정 파일 (SettingAgent, 전부 가산·외과적)

| 파일 | 수정 |
|------|------|
| `src/domain/geometry.ts` | `median(values)` 헬퍼 추가(Aggregator 대표 bbox 용). 기존 함수 불변. |
| `src/brain/SetupBrain.ts` | `CheckpointInput`/`CheckpointResultSchema`/`CheckpointResult`/`FinalizeCaptureInput`/`FinalizeCaptureResultSchema`/`FinalizeCaptureResult` 추가 + `SetupBrain`에 **옵셔널** `reviewCheckpoint?`/`finalizeCapture?`. 기존 인터페이스 불변. |
| `src/brain/AgentRuntime.ts` | `reviewCheckpoint`/`finalizeCapture` 메서드 추가(인라인 한글 프롬프트 + 기존 `chatJson` 재사용). 기존 메서드 불변. |
| `src/config/toolsConfig.ts` | `CaptureSchema` + `ToolsConfigSchema.capture` + `DEFAULT_TOOLS_CONFIG.capture`. `loadToolsConfig` 키 루프라 자동 병합. |
| `src/api/server.ts` | `ApiDeps`에 `captureJob?`/`finalizer?`/`sqlite?`/`capture?` 옵셔널 추가 + 모두 주입 시 `registerCaptureRoutes` 호출. 기존 라우트 불변. |
| `src/index.ts` | SqliteStore/CheckpointReviewer/CaptureJob/Finalizer 조립 + buildServer 주입. `loadExpectedFaces`로 expectedByPreset 주입. |
| `package.json` | dep `better-sqlite3@^12.11.1`, devDep `@types/better-sqlite3@^7.6.13`. |
| `config/tools.config.json`, `config/tools.config.example.json` | `capture` 섹션 추가(설계서 §7 값). |

## 1.2 SettingViewer

| 파일 | 수정 |
|------|------|
| `src/server.ts` | `/viewer/api/capture/{status,runs,runs/:id/aggregate}`(GET)·`{start,stop,finalize}`(POST) 프록시 추가. `registerViewerRoutes` **전** 등록. `proxyCapture` 헬퍼(`/mapping` 패턴: 404 패스스루, 400/409 패스스루, 5xx→502, 미가동→502 unreachable). |
| `web/core.js` | 순수함수 `captureProgress(status)`/`mapAdvisory(status)`/`pollPlan(state)` 추가. DOM/fetch 미참조. |
| `web/core.d.ts` | 위 3함수 + `CaptureStatus` 타입 선언 추가. |
| `web/index.html` | "정밀 수집"(`precise`) 탭 + 패널(반복횟수·주기·체크포인트 입력, 시작/정지/최종화, 진행바, 자문/메시지). |
| `web/app.js` | core 순수로직에 fetch/DOM 주입(폴링·시작/정지/최종화). 탭 전환 시 precise 패널 표시. 최종화 후 `/viewer/api/mapping` 재로딩. |

---

## 2. 공개 API · 시그니처

### REST `/capture/*` (SettingAgent)
- `POST /capture/start` `{count:int>0, intervalMs?, checkpointEvery?, targets?}` → `{ok,runId}` / 400(invalid·target) / 409(already running)
- `GET /capture/status` → `{state, runId?, round, done, planned, latestAdvisory?}`
- `POST /capture/stop` → `{ok,state}` / 400(not running)
- `POST /capture/finalize` `{runId?}` → `{ok,slots,globalCount}` / 409(running) / 404(no run) / 500
- `GET /capture/runs` → `CaptureRunRow[]`
- `GET /capture/runs/:id/aggregate` → `AggregatedSlot[]` / 404

### 핵심 클래스/함수
- `SqliteStore(dbPath)`: `createRun`/`updateRunProgress`/`endRun`/`getRun`/`listRuns`/`insertObservation`/`insertDetections`/`getDetectionsForRun`/`getPresetRounds`/`replaceAggregatedSlots`/`getAggregatedSlots`/`updateAggregatedStatus`/`insertCheckpoint`/`getLatestCheckpoint`/`getCheckpoints`/`insertArtifactSnapshot`/`close`.
  - 계획 대비 **가산 보조 메서드**: `getPresetRounds`(occupancy 분모, §11-6), `updateAggregatedStatus`(체크포인트 status 갱신), `getCheckpoints`(Finalizer 컨텍스트).
- `aggregate(dets: DetectionRow[], presetRounds: Map<string,number>, opts: {clusterDist,clusterMinSupport,minConfidence}): AggregatedSlot[]`.
- `CaptureJob`: `start(p)`/`stop()`/`getStatus()`/`getRunId()`.
- `CheckpointReviewer.review(runId, atRound, plannedCount, slots, newFacesRecentK, expectedByPreset?)`.
- `Finalizer.finalize(runId): Promise<{artifact,slots,globalCount}>`.
- `AgentRuntime.reviewCheckpoint(input)` / `finalizeCapture(input)` (비활성 시 null).

---

## 3. 순수 로직 함수 (검증자 단위테스트 대상)

| 함수 | 위치 | 검증 포인트 |
|------|------|------------|
| `aggregate` | `capture/Aggregator.ts` | 같은 위치 반복→1클러스터/support=N/중앙값 bbox; support<minSupport→rejected; 점유율; plate 귀속; 프리셋 분리. |
| `median` | `domain/geometry.ts` | 홀/짝 길이, 빈 배열=0. |
| `clusterRef`/`advisoryLines` | `capture/CheckpointReviewer.ts` | `presetKey#clusterId` 포맷; coverage short/convergence 표시 문자열. |
| `captureProgress`/`mapAdvisory`/`pollPlan` | SettingViewer `web/core.js` | 진행률 0 division 방어; 자문 배열; running/stopping/finalizing 만 폴링. |

CaptureJob 은 setTimer/sleep/now 주입으로 fake timers 테스트. SqliteStore 는 `:memory:`/임시파일 주입. Finalizer/CheckpointReviewer 는 fake brain 주입.

**자체 스모크(임시 스크립트, 삭제함)**: `:memory:` store 3라운드 적재 → `aggregate` → 안정 클러스터(support=3, occupancy=1, plate 매칭, candidate) + 노이즈(support=1 → rejected) + `replaceAggregatedSlots` 멱등(2회→2행) 확인.

---

## 4. 좌표 불변식 적용 지점 (§0-4)

- **좌표 생성/수정은 검출+집계만**: `Aggregator.aggregate`의 `medianRect`(검출 멤버 중앙값)가 유일한 bbox 산출처. plate 도 동일.
- **LLM 은 메타만**:
  - `CheckpointReviewer`: `rejects`→status='rejected', `merges`(2번째부터)→status='merged'. **좌표 미변경**(`updateAggregatedStatus`는 status 컬럼만).
  - `Finalizer`: LLM `rejects`/`duplicates`→채택 제외, `zoneLabels`→slot.zone, `report_ko`→artifact.report. **roi 는 집계 대표 bbox(+패딩) 그대로**.
- `coverage`/`convergence`는 `checkpoint.summary_json` 저장 + `getStatus().latestAdvisory` 표시만(자동 정지 아님).

---

## 5. typecheck / 테스트 결과

- `cd SettingAgent && npm run typecheck` → 통과(0 에러).
- `cd SettingAgent && npm test` → **19 파일 / 81 테스트 통과**(회귀 없음). `config.test`의 `toEqual(DEFAULT_TOOLS_CONFIG)`는 DEFAULT에 capture 추가로 자동 정합.
- `cd SettingViewer && npm run typecheck` → 통과(0 에러).
- `cd SettingViewer && npm test` → **7 파일 / 62 테스트 통과**.

---

## 6. 미해결 / 실측 보정 / 검증자 인계 포인트

1. **계획 대비 가산 DAO 3개**(`getPresetRounds`/`updateAggregatedStatus`/`getCheckpoints`) — 설계서 §11-6(occupancy 분모) 및 체크포인트 status 반영·Finalizer 컨텍스트 요구를 충족하기 위한 직접 추론 추가. 좌표·계약 불변.
2. **`newFacesRecentK` 단순화**(§11-5 인접) — 1차는 "현재 rejected 제외 후보 면 수"를 수렴 신호로 전달(라운드별 신규 면 추적 미구현). 후속 정교화 여지. LLM 비활성 시 무영향.
3. **체크포인트/최종 프롬프트 인라인**(§11-5, 확정대로) — `AgentRuntime` 코드 내 한글 프롬프트. 파일화(`capturePrompts`)는 후속.
4. **CaptureJob 첫 라운드 즉시 발화**: `start`는 `setTimer(fn, 0)`로 첫 라운드 예약(주기는 2번째부터). fake timers 테스트 시 `advanceTimersByTimeAsync(0)`/`runOnlyPendingTimers`로 첫 라운드 트리거 필요.
5. **`/capture/finalize` 기본 runId 선택**: `body.runId` → `job.getRunId()` → `listRuns(1)[0].id` 순. 종료된 최근 런 대상.
6. **SettingViewer 프록시 400/409 패스스루**: `/mapping` 프록시는 404만 패스스루였으나, capture 는 잘못된 body(400)·중복/정지불가(409)도 상태·본문 그대로 전달하도록 확장(QA: mappingProxy.test 패턴으로 status/start/stop/finalize·404·502·unreachable 검증 권장).
7. **DB 파일 경로**: `capture.dbFile='data/observations.sqlite'`. `SqliteStore`가 디렉터리 자동 생성. 운영 시 보존/정리 정책은 범위 밖(설계서 §11-3).
8. **동작확인(QA §10-8)**: 시뮬레이터(:13100) N=소수·짧은 주기 → 수집→집계→(LLM/무LLM)→`/capture/finalize`→`/mapping` 정밀 결과. CaptureJob는 단일 인메모리 잡(재기동 복구 범위 밖).
