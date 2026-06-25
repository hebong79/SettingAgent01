# SettingViewer 독립 서비스 분리 — 구현 변경 내역 (02_developer_changes)

- 작성일: 2026-06-25
- 작성자: developer (ParkAgent 구현자)
- 기준 계획: `SettingViewer/_workspace/01_architect_plan.md`
- 요약: SettingAgent 내부 웹 뷰어를 `SettingViewer/`(포트 13030) 독립 서비스로 분리. 기능 추가 없음(분리만). 유일한 신규 기능은 `/mapping` 프록시 라우트.

---

## 0. 최종 검증 결과 (양쪽 그린)

| 항목 | 결과 |
|------|------|
| SettingViewer `npm run typecheck` | ✅ 통과(에러 0) |
| SettingViewer `npm test` (vitest) | ✅ **61 passed** (이동 57 + mappingProxy 4) |
| SettingAgent `npm run typecheck` | ✅ 통과(에러 0) |
| SettingAgent `npm test` (vitest) | ✅ **81 passed / 19 files** (회귀 0) |
| 루트 `npm install`(워크스페이스 SettingViewer 포함) | ✅ 성공 |
| SettingViewer 소스 → SettingAgent/@parkagent import | ✅ 0건(주석 제외) |
| 문서 잔존 경로(`SettingAgent/web`·`SettingAgent/src/viewer`·`localhost:13020/viewer`) | ✅ 0건 |

---

## 1. 신규(new) — SettingViewer 전용

| 파일 | 내용 |
|------|------|
| `SettingViewer/package.json` | name=`parkagent-viewer`, type=module. deps: `@fastify/static`^9·`fastify`^5.2·`zod`^3.24. devDeps: `@types/node`·`tsx`·`typescript`·`vitest`. scripts: start/dev/typecheck/test/test:watch. |
| `SettingViewer/tsconfig.json` | SettingAgent 와 동일(NodeNext, strict, rootDir=".", include src/test, types=[node]). |
| `SettingViewer/vitest.config.ts` | include `test/**/*.test.ts`, environment node. |
| `SettingViewer/src/config/viewerConfig.ts` | **신규 config 모듈**. toolsConfig 에서 camera/viewer/cameraSources 섹션 발췌 + `settingAgentUrl`(프록시 대상)·`server.port` 추가. `ViewerConfigSchema`/`ViewerConfig`/`CameraSourceConfig`/`DEFAULT_VIEWER_CONFIG`/`loadViewerConfig()` export. |
| `SettingViewer/config/viewer.config.json` | 실행 설정: camera(13100)·viewer·settingAgentUrl(13020)·server.port(13030). `cameraSources` 미기재(sim 단일 폴백). |
| `SettingViewer/src/server.ts` | `buildViewerServer(deps)` — Fastify 인스턴스 → ① `/viewer/api/mapping` 프록시 등록 → ② `registerViewerRoutes`(API+static). |
| `SettingViewer/src/index.ts` | 부트스트랩: `loadViewerConfig()` → `buildSourceRegistry(cfg)` → `buildViewerServer({sources,viewer,settingAgentUrl})` → `listen(server.port)`. |
| `SettingViewer/test/mappingProxy.test.ts` | `/viewer/api/mapping` 프록시 검증 4케이스: 200 패스스루 / 404 패스스루 / 5xx→502 / 미가동→502 unreachable. |
| `SettingViewer/web/core.d.ts` | **신규 타입 선언**(계획 외 추가 — §6 참조). core.js 의 공개 함수·`createStreamLoop` 시그니처 선언. 런타임 JS 무변경. |

---

## 2. 이동(move) — SettingAgent → SettingViewer

> git `.git` 디렉터리가 비어 있어(저장소 미초기화 상태) `git mv` 불가 → **일반 파일 이동(mv)** 사용. (§6 미해결 항목 1)

| 원본 | 대상 | 수정 |
|------|------|------|
| `SettingAgent/src/viewer/CameraSource.ts` | `SettingViewer/src/viewer/CameraSource.ts` | 무수정 |
| `SettingAgent/src/viewer/SimulatorSource.ts` | `SettingViewer/src/viewer/SimulatorSource.ts` | 무수정 |
| `SettingAgent/src/viewer/RealPtzSource.ts` | `SettingViewer/src/viewer/RealPtzSource.ts` | import `toolsConfig.js`→`viewerConfig.js` |
| `SettingAgent/src/viewer/sourceRegistry.ts` | `SettingViewer/src/viewer/sourceRegistry.ts` | import `ToolsConfig`→`ViewerConfig`; `buildSourceRegistry(tools: ToolsConfig)`→`(cfg: ViewerConfig)`, 본문 `tools.*`→`cfg.*`, 루프변수 `cfg`→`src`(파라미터명 충돌 회피) |
| `SettingAgent/src/viewer/routes.ts` | `SettingViewer/src/viewer/routes.ts` | import `ToolsConfig`→`ViewerConfig`; `ViewerDeps.viewer: ViewerConfig['viewer']` |
| `SettingAgent/web/index.html` | `SettingViewer/web/index.html` | 무수정 |
| `SettingAgent/web/core.js` | `SettingViewer/web/core.js` | 무수정 |
| `SettingAgent/web/app.css` | `SettingViewer/web/app.css` | 무수정 |
| `SettingAgent/web/app.js` | `SettingViewer/web/app.js` | **1줄**: `fetch('/mapping')` → `fetch(api('/mapping'))` (§4) |
| `SettingAgent/test/cameraClientList.test.ts` | `SettingViewer/test/cameraClientList.test.ts` | import `ToolsConfig`→`ViewerConfig`; `ToolsConfig['camera']`→`ViewerConfig['camera']` |
| `SettingAgent/test/simulatorSource.test.ts` | `SettingViewer/test/simulatorSource.test.ts` | `CapturedImage` import 출처 `../src/domain/types.js`→`../src/clients/CameraClient.js`(CameraClient 와 합쳐 1줄) |
| `SettingAgent/test/sourceRegistry.test.ts` | `SettingViewer/test/sourceRegistry.test.ts` | `DEFAULT_TOOLS_CONFIG/ToolsConfig`→`DEFAULT_VIEWER_CONFIG/ViewerConfig`, `base()` 반환타입 `ViewerConfig` |
| `SettingAgent/test/realPtzSource.test.ts` | `SettingViewer/test/realPtzSource.test.ts` | `CameraSourceConfig` import 출처 `toolsConfig.js`→`viewerConfig.js` |
| `SettingAgent/test/viewerRoutes.test.ts` | `SettingViewer/test/viewerRoutes.test.ts` | `ToolsConfig`→`ViewerConfig`(import + `ViewerConfig['viewer']` 2곳) |
| `SettingAgent/test/viewerCore.test.ts` | `SettingViewer/test/viewerCore.test.ts` | `../web/core.js` 경로 유지. **1줄 보정**: `vi.fn(() => 'TIMER')`→`vi.fn((_fn: () => void, _ms: number) => 'TIMER')`(§6 typecheck 결함 정정) |

문서 이동(→ `SettingViewer/doc/`, 일반 이동):
- `SettingAgent/docs/20260625_170811_SettingViewer_웹뷰어_설계서.md`
- `SettingAgent/docs/20260625_182819_SettingViewer_구현문서.md`
- `SettingAgent/docs/20260625_182819_SettingViewer_영향도분석.md`
- `Docs/20260625_081406_settingviewer_validation.md`

---

## 3. 복제(copy) — SettingAgent 잔존 + SettingViewer 사본

SettingAgent 셋업 파이프라인이 계속 사용하므로 이동이 아닌 **복제**.

| 원본 | 대상 | 복제 시 수정 |
|------|------|--------------|
| `SettingAgent/src/clients/CameraClient.ts` | `SettingViewer/src/clients/CameraClient.ts` | ① `CapturedImage` 를 `../domain/types.js` import 대신 **파일 내 로컬 인터페이스로 정의+export**(8필드 동일). ② `ToolsConfig['camera']`→`ViewerConfig['camera']`. ③ `CameraList` import 경로 유지(SettingViewer/src/viewer/CameraSource.js). requestImage/move/health/clampZoom/listCameras 5개 메서드 보유. |
| `SettingAgent/src/util/http.ts` 의 `fetchWithTimeout` | `SettingViewer/src/util/http.ts` | **`fetchWithTimeout` 만 발췌**. `isRetryable`/`withRetry`/`RetryOptions` 미사용 → 제외. |

> 중복 2벌(SettingAgent 원본 + SettingViewer 사본)은 의도된 결과(독립성 우선). 한쪽 버그 수정이 자동 반영 안 됨 — 향후 공유 패키지 승격 검토는 이번 범위 밖.

---

## 4. `/mapping` 프록시 (분리로 인한 유일 신규 기능)

### 서버측 — `SettingViewer/src/server.ts`
- `GET /viewer/api/mapping` 라우트를 `registerViewerRoutes`(정적 와일드카드 포함)보다 **먼저** 등록.
- `fetchWithTimeout(`${settingAgentUrl}/mapping`, {GET}, 5000)` 호출.
  - 200 → `Content-Type: application/json` + `res.text()` 패스스루(SetupArtifact shape 무관).
  - 404 → 404 `{error:'no setup artifact'}`.
  - 그 외 비 2xx → 502 `{error:'mapping upstream HTTP <status>'}`.
  - 예외(연결 불가/타임아웃) → 502 `{error:'mapping upstream unreachable'}`.
- `settingAgentUrl` 은 말미 슬래시 정규화 후 사용.

### 프런트측 — `SettingViewer/web/app.js`
- `loadMapping()` 내 `fetch('/mapping')` → `fetch(api('/mapping'))`. `api('/mapping')` = `/viewer/api/mapping`. 그 외 app.js 무변경.

---

## 5. SettingAgent 정리(제거 항목)

| 파일 | 제거 내용 |
|------|-----------|
| `SettingAgent/src/viewer/` (5파일) | 폴더 통째 이동(삭제됨) |
| `SettingAgent/web/` (4파일) | 폴더 통째 이동(삭제됨) |
| 뷰어 테스트 6파일 | 이동(삭제됨) |
| `SettingAgent/src/clients/CameraClient.ts` | `listCameras()` 메서드 + `import type { CameraList } from '../viewer/CameraSource.js'` 제거(뷰어 분리로 고아). requestImage/move/health/clampZoom 시그니처·본문 불변. |
| `SettingAgent/src/config/toolsConfig.ts` | `ViewerSchema`·`CameraSourceConfigSchema`·`CameraSourceConfig` export 삭제. `ToolsConfigSchema` 에서 `viewer`·`cameraSources` 필드 삭제. `DEFAULT_TOOLS_CONFIG.viewer` 삭제. 로더의 `cameraSources` 명시 대입 1줄 삭제. |
| `SettingAgent/src/api/server.ts` | `CameraSource` import·`registerViewerRoutes` import 삭제. `ApiDeps.viewer?`·`sources?` 필드 삭제. 말미 `registerViewerRoutes` 등록 블록 삭제. **`/mapping` 라우트 유지**(프록시 대상). |
| `SettingAgent/src/index.ts` | `buildSourceRegistry` import·`const sources` 삭제. `buildServer({...})` 인자에서 `viewer`·`sources` 삭제. |
| `SettingAgent/package.json` | `dependencies` 에서 `@fastify/static` 제거. |
| `SettingAgent/config/tools.config.json` | `viewer` 섹션 삭제. |

> `config.test.ts` 는 `viewer` 를 단언하지 않음(`toEqual(DEFAULT_TOOLS_CONFIG)` 양변 동시 변경) → **무수정으로 통과**(가정 A 확인 결과: 동반 정리 불필요).

---

## 6. 미해결 / 계획 대비 편차 (검증자·리더 확인 요청)

1. **git 미사용(이력 보존 불가)**: `ParkAgent/.git` 디렉터리가 비어 있어(저장소 미초기화) `git mv`·`git status` 등 모든 git 명령이 `fatal: not a git repository` 로 실패. → 일반 `mv` 로 이동(파일 내용·구조는 계획과 동일, 단 git 이력 보존은 불가). 저장소 초기화 후 재커밋 필요 시 리더 판단.

2. **viewerCore.test.ts typecheck 결함(계획의 "무수정" 가정 정정)**: 계획 §2.1 은 viewerCore.test.ts 를 무수정 이동으로 명시했으나, 해당 파일은 **SettingAgent 에서도 이미 typecheck 가 깨져 있던 잠재 결함**을 안고 있었다(SettingAgent 에 임시 복원해 재현 확인 완료):
   - `TS7016`: `import ... from '../web/core.js'` 가 선언 없는 JS → implicit any.
   - `TS2493`: `setTimer.mock.calls[0][1]` — `vi.fn(() => 'TIMER')` 의 파라미터 튜플이 `[]` 로 추론되어 인덱스 1 접근 불가.
   - SettingAgent `npm run typecheck` 가 뷰어 테스트 포함 시 그린이 아니었음(이동 후 SettingAgent 에서 사라져 현재는 그린).
   - **외과적 정정 2건**으로 해소(테스트 동작·검증 의도 불변):
     - `SettingViewer/web/core.d.ts` 신규(core.js 타입 선언) → TS7016 해소 + `createStreamLoop` 시그니처 부여.
     - viewerCore.test.ts 159행 `vi.fn(() => 'TIMER')`→`vi.fn((_fn: () => void, _ms: number) => 'TIMER')` → TS2493 해소. (stop 테스트의 동일 mock 은 `[1]` 미접근이라 무수정.)
   - 두 정정은 **계획 범위를 벗어나는 동작 변경이 아니라 typecheck 통과를 위한 최소 타입 보정**이며, 계획의 "SettingViewer typecheck 통과" 성공 기준을 만족시키기 위한 불가피한 조치. 검증자 확인 요망.

3. **CameraClient/http util 2벌 중복**: §3 기재대로 의도된 결과. 동기화 리스크는 SettingViewer doc 으로 관리.

4. **기동 순서**: SettingAgent(:13020) 먼저 → SettingViewer(:13030). SettingAgent 미가동 시 `/viewer/api/mapping` 502(ROI 미표시), 영상/PTZ 는 정상(SettingViewer 가 카메라 직접 호출).

---

## 7. 검증자 인계 포인트

- **회귀 가드**: SettingAgent 셋업 81 테스트 그린 유지가 불변 조건. CameraClient 시그니처(requestImage/move/health/clampZoom) 동결 확인.
- **신규 검증 대상**: `mappingProxy.test.ts`(200/404/502×2). 실제 SettingAgent 연동(:13020 /mapping) E2E 는 두 프로세스 기동 후 수동확인 영역.
- **typecheck 정정(§6-2)**: core.d.ts 와 viewerCore.test.ts 1줄 보정이 테스트 의도를 바꾸지 않았는지 재확인(61 그린 유지).
- **수동확인 미수행**: 브라우저 `:13030/viewer/` 실제 로딩·canvas 오버레이·ROI 프록시 표시(jsdom 미도입으로 단위테스트 제외 영역).
