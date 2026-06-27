# 02 · 구현자(developer) 변경 내역 — SettingViewer → SettingAgent 재통합

작성: 구현자(developer) · 대상: SettingAgent · 분류: 리팩토링(통합, 기능 추가 없음)
설계서: `_workspace/01_architect_plan.md` 의 §3~§10 을 그대로 구현.

---

## 0. 결론(검증 결과)

- `cd SettingAgent && npm run typecheck` → **오류 0**.
- `cd SettingAgent && npm test`(vitest) → **36 파일 / 239 테스트 전부 통과**(회귀 0).
  - 통합 전 SettingAgent 단독 25 파일 → 통합 후 36 파일(이관 viewer 테스트 11개 + mappingDirect/viewerEnabled 신규 2개 − mappingProxy/captureProxy 삭제 2개 = +11).
- 라이브 기동(`npm start`)은 마스터 지시대로 **시도하지 않음**(포트 13020/13030 점유 가능). 검증은 typecheck + vitest(fastify.inject) 로만 수행.

---

## 1. 설정 병합 (1단계)

### `src/config/toolsConfig.ts` (가산/병합)
- `ViewerSchema`(enabled/allowMove/defaultFps/staticDir/controlToken) 추가 — 기존 viewer `viewerConfig.ts` 의 동명 스키마 흡수.
- `CameraSourceConfigSchema` + `export type CameraSourceConfig` 추가 — viewer `viewerConfig.ts` 에서 이동.
- `ToolsConfigSchema` 에 `viewer: ViewerSchema`, `cameraSources: z.array(...).optional()` 추가.
- `DEFAULT_TOOLS_CONFIG` 에 `viewer: { enabled:true, allowMove:true, defaultFps:3, staticDir:'web', controlToken:'' }` 추가. `cameraSources` 는 기본값 미설정(undefined → sourceRegistry 단일 sim 폴백).
- `loadToolsConfig` 병합 보정: 객체 섹션 spread 병합 루프(`Object.keys(DEFAULT)`)는 `cameraSources`(DEFAULT 부재·옵셔널 배열)를 누락하므로 **`if (raw.cameraSources !== undefined) merged.cameraSources = raw.cameraSources;` 패스스루 한 줄** 추가(§5 지시).

### `config/tools.config.json`
- `viewer` 섹션 추가(기본값과 동일). `cameraSources` 는 미기재(단일 sim 폴백 = 기존 단일 시뮬레이터 동작 유지).

### `package.json`(SettingAgent)
- `dependencies` 에 `"@fastify/static": "^9.0.0"` 추가(알파벳 순 선두). 루트 `npm install` 후 `node_modules/@fastify/static@9.1.3`(fastify 5.8.5 호환) 정식 등록 확인.

> config.test.ts 회귀 없음(기본값 로드/병합 테스트 통과). `DEFAULT_TOOLS_CONFIG` 비교 테스트는 viewer 기본값 포함 상태로 통과.

---

## 2. 소스 이동 + CameraClient.listCameras 재추가 (2단계)

### 이동(내용 동일, import 경로만 보정) → `src/viewer/`
| 파일 | 보정 |
|------|------|
| `CameraSource.ts` | 무수정(상대 import 없음) |
| `SimulatorSource.ts` | 무수정(`../clients/CameraClient.js` 경로 동일) |
| `RealPtzSource.ts` | `import type { CameraSourceConfig }` 출처 `../config/viewerConfig.js` → **`../config/toolsConfig.js`**. `../util/http.js`(fetchWithTimeout) 경로 동일 → 무수정 |
| `sourceRegistry.ts` | 시그니처 `buildSourceRegistry(cfg: ViewerConfig)` → **`Pick<ToolsConfig,'camera'\|'cameraSources'>`**. 본문 로직 불변(폴백·다중소스 동일) |
| `routes.ts` | `ViewerDeps.viewer` 타입 `ViewerConfig['viewer']` → **`ToolsConfig['viewer']`**. `CameraApiError` import 경로 동일. 본문 라우트 로직 불변 |

### 가산: `src/clients/CameraClient.ts`
- `import type { CameraList } from '../viewer/CameraSource.js';` 추가.
- `async listCameras(): Promise<CameraList>` **재추가**(viewer 복제본의 메서드를 그대로). GET `/cameras` 호출 + A타입 파싱(name/label 폴백, enabled=false 보존, presets PTZ 중첩 보존). 기존 메서드(health/requestImage/move/clampZoom) **불변**, `CapturedImage` 출처(`../domain/types.js`) 불변.

---

## 3. 서버 통합 (3단계) — `src/api/server.ts`

- import 추가: `registerViewerRoutes`(../viewer/routes.js), `CameraSource` 타입(../viewer/CameraSource.js).
- `ApiDeps` 에 `viewer?: ToolsConfig['viewer']`, `sources?: Map<string, CameraSource>` **가산**(옵셔널 → 기존 호출처 무영향).
- capture 라우트 등록 직후, `return app` 직전에 뷰어 통합 블록 추가:
  - `if (deps.viewer?.enabled && deps.sources)` 이중 가드(헤드리스 보존).
  - **`/viewer/api/mapping` 직접 읽기** 라우트: `deps.repo.loadArtifact()` 반환, 없으면 `reply.code(404); { error:'no setup artifact' }`(프록시·404 동작 보존). HTTP 자기호출 제거.
  - `await registerViewerRoutes(instance, { sources, viewer })`(카메라 라우트 + 정적 SPA 와일드카드).

### buildServer 동기 유지 결정(설계 §4·§13-1 위임 사항)
- **register 래핑 채택**(설계의 (대안)): `registerViewerRoutes` 가 async(@fastify/static register)이므로 `app.register(async (instance) => { ...; await registerViewerRoutes(instance, ...) })` 로 감싸 **buildServer 의 동기 `FastifyInstance` 반환 시그니처를 유지**.
- **근거**: 기존 156 테스트(apiRefresh/captureRoutes 등)가 `buildServer({...})` 를 동기 호출하고 결과를 즉시 `app.inject()` 한다. async 화 시 전 호출처에 `await` 보정이 필요(회귀 위험). 래핑은 호출처 0 수정. `app.inject()` 가 내부적으로 `app.ready()` 를 호출해 plugin(정적 라우트) 등록을 보장하므로 inject 테스트에서 static 404 위험 없음 → 실제로 viewerRoutes/mappingDirect/viewerEnabled 테스트 통과로 확인.

---

## 4. 조립 (4단계) — `src/index.ts`

- import 추가: `buildSourceRegistry`(./viewer/sourceRegistry.js).
- `const sources = tools.viewer.enabled ? buildSourceRegistry(tools) : undefined;`(헤드리스 시 미빌드).
- `buildServer({ ... , viewer: tools.viewer, sources })` 주입.
- 기동 로그에 `viewerEnabled: tools.viewer.enabled` 추가.
- `buildServer` 호출은 동기 유지(§3 결정) → `await buildServer` 불필요.

---

## 5. SPA 이동 + app.js 수정 (5단계)

- `web/*`(app.css, app.js, core.d.ts, core.js, index.html) → `SettingAgent/web/`(git mv).
- `web/app.js` capture 호출 **4줄**만 `api('/capture/X')` → `'/capture/X'`(접두 제거, 동일 origin 직접 호출):
  - `capFetchStatus`(L262) `/capture/status`
  - `capStart`(L301) `/capture/start`
  - `capStop`(L312) `/capture/stop`
  - `capFinalize`(L319) `/capture/finalize`
- `const api = (path) => `/viewer/api${path}``(L19) **유지** — cameras/snapshot/move/camera/login/health/mapping 는 `/viewer/api` 접두 그대로(동일 경로로 통합 서버가 제공). grep 으로 `api('/capture` 잔존 0 확인.
- 그 외 web 파일 무수정.

---

## 6. 테스트 이관 (6단계) — `test/`

### 이동(경로/타입 보정)
| 파일 | 보정 |
|------|------|
| `analyzeArtifact / findPresetPtz / panelResize / captureCore / viewerCore` | `../web/core.js` 경로 동일 → 무보정(git mv) |
| `simulatorSource.test.ts` | `CapturedImage` import 분리: `../src/clients/CameraClient.js` 는 재export 안 함 → **`../src/domain/types.js`** 로 이동. `CameraList` 는 `../src/viewer/CameraSource.js` |
| `cameraClientList.test.ts` | `ViewerConfig['camera']` → **`ToolsConfig['camera']`**(import 출처 변경) |
| `realPtzSource.test.ts` | `CameraSourceConfig` 출처 → **`../src/config/toolsConfig.js`** |
| `sourceRegistry.test.ts` | `DEFAULT_VIEWER_CONFIG`/`ViewerConfig` 제거 → `DEFAULT_TOOLS_CONFIG` 기반 `Pick<ToolsConfig,'camera'\|'cameraSources'>` 입력 구성 |
| `viewerRoutes.test.ts` | `ViewerConfig['viewer']` → **`ToolsConfig['viewer']`**(viewerCfg/mkApp 타입) |

### 대체/삭제/신규
- **`mappingProxy.test.ts` → `mappingDirect.test.ts`(대체)**: upstream HTTP stub 폐기. `buildServer`(viewer enabled + repo 스텁 + 임시 staticDir)로 `/viewer/api/mapping` 을 inject: 산출물 있음 → 200 패스스루, null → 404. (502/타임아웃 케이스는 자기호출 제거로 소멸 → 삭제.)
- **`captureProxy.test.ts` → 삭제**: SPA 가 `/capture/*` 직접 호출(프록시 alias 없음). `/capture/*` 동작은 기존 `captureRoutes.test.ts` 가 커버.
- **`viewerEnabled.test.ts`(신규)**: `enabled=false` → `/viewer/api/health` 404 + `/health`(루트)·`/setup/status` 정상(헤드리스). `enabled=true` → `/viewer/api/health` 200(sources:['sim']) + `/health` 정상(경로 충돌 없음).

---

## 7. 정리 (7단계)

- **doc 이관**: `SettingViewer/doc/*.md`(7개) → `SettingAgent/docs/`(git mv, 파일명 유지).
- **SettingViewer 제거**: 추적 파일 전부 `git rm -r SettingViewer`(index·작업트리에서 제거 완료). `setviewer.bat` `git rm` 완료. `setagent.bat` 유지.
- **루트 `package.json` workspaces**: `["packages/*","SettingAgent","SettingViewer"]` → `["packages/*","SettingAgent"]`.
- **루트 `npm install`**: 성공(removed 1 package = SettingViewer 워크스페이스). lock 갱신, `@fastify/static@9.1.3` SettingAgent dep 등록 확인.
- **잔존 참조 grep**: `src/` 내 `buildViewerServer/settingAgentUrl/viewerConfig` 라이브 코드 참조 0(toolsConfig.ts 의 통합 설명 주석 1건만 — 의도적).

---

## 8. 미해결 / 실측 보정 필요

1. **`SettingViewer/` 빈 디렉터리 잔존(잠금)**: `git rm -r` 로 추적 파일·작업트리 파일은 모두 제거되었고 `find SettingViewer -type f` 결과 0 이나, **디렉터리 핸들이 다른 프로세스에 의해 잠겨**(`Device or resource busy` / `being used by another process`) 빈 폴더 자체 삭제는 실패. 마스터의 SettingViewer dev 서버(nodemon/tsx watch, cwd=SettingViewer)가 살아 있을 가능성이 큼(포트 13020/13030 점유 경고와 일치). **조치**: 해당 프로세스 종료 후 `rm -rf SettingViewer`(또는 `Remove-Item -Recurse -Force SettingViewer`) 1회. git 커밋에는 삭제로 반영됨(빈 디렉터리는 git 비추적이라 영향 없음). 임의 프로세스 kill 은 하지 않음.
2. **RealPtzSource CGI/PTZ 범위**: HNR-2036LA 실기기 미확인 가정값(login/snapshot/ptz CGI 경로·원시 범위) 그대로 이관. 실 장비 연결 후 실측 보정(신규 기능 아님, 설계 §13.6). `cameraSources[].ptz` 주입 시 우선.
3. **cameraSources 실 PTZ 항목**: tools.config.json 에 미기재(단일 sim 폴백). 실 PTZ 사용 시 기존 viewer 절차와 동일하게 `cameraSources` 추가.

---

## 9. 검증자 인계 포인트

- 회귀 기준: `npm test` 36 파일 / 239 테스트 통과(현재 상태). `npm run typecheck` 0.
- 신규/대체 검증 대상: `mappingDirect.test.ts`(직접읽기 200/404), `viewerEnabled.test.ts`(토글·라우트 충돌), 이관분 9개(viewerRoutes/cameraClientList/realPtzSource/sourceRegistry/simulatorSource/viewerCore/analyzeArtifact/findPresetPtz/panelResize/captureCore).
- 계약 불변 확인 포인트: `/health`(루트)·`/setup/*`·`/capture/*`·`/mapping`(루트) 메서드·경로·shape 유지. `/viewer/api/*` 는 `viewer.enabled` 게이트.
- 라이브/브라우저 동작(카메라/스냅샷/이동/프리셋이동/정밀수집/분석탭)은 포트 점유 해소 후 별도 확인(이번 범위 외).
