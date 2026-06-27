# 01 · 설계서 — SettingViewer → SettingAgent 재통합 (단일 프로세스)

작성: 설계자(architect) · 대상: SettingAgent · 분류: 리팩토링(통합, 기능 추가 없음)

---

## 0. 목적·범위·불변식

**목적**: 분리되어 있던 SettingViewer(독립 서비스, :13030)를 SettingAgent(:13020) **단일 프로세스**로 되돌려 통합한다. `viewer.enabled` 토글로 웹 뷰어(SPA + `/viewer/api/*`)를 함께 서빙한다.

**핵심 불변식(반드시 보존)**
- 분리 이후 추가된 기능 전량 보존: 정밀 수집(/capture) 연동, 분석 탭, RealPtz 소스, 프리셋 이동(gotoPreset), 캐시/PTZ 표시 수정.
- 헤드리스 보존: `viewer.enabled=false` 면 뷰어 라우트·정적 서빙 **미등록**(순수 에이전트).
- 기존 계약 불변: `/health`, `/setup/*`, `/capture/*`, `/mapping` 의 메서드·경로·응답 shape 유지.
- 기존 156개 vitest 회귀 0.

**비목표(과설계 금지)**: 새 기능 없음. 추상화·설정 유연성 추가 금지. 단지 '통합'(프록시 1홉 제거 + 중복 제거 + 단일 포트/기동)만 수행한다.

**통합 이점**
- `/mapping`·`/capture` 는 SettingAgent 내부에 이미 존재 → HTTP 자기호출(프록시 1홉) 불필요. repo/핸들러 직접 사용.
- 코드 중복 제거: CameraClient(복제본), `util/http.ts`(복제본) 폐기.
- 단일 포트(13020)·단일 기동(`npm start`).

---

## 1. 현황 사실(코드 확인 결과)

| 항목 | SettingAgent(이식 대상) | SettingViewer(이동 원본) |
|------|------------------------|--------------------------|
| 서버 빌더 | `src/api/server.ts` `buildServer(ApiDeps)` — camera/vpd/repo/brain/orchestrator/capture 보유, `/mapping`·`/capture/*` 라우트 존재 | `src/server.ts` `buildViewerServer` — `/viewer/api/mapping`·`/viewer/api/capture/*` **프록시** + `registerViewerRoutes` |
| CameraClient | `src/clients/CameraClient.ts` — **`listCameras()` 없음**(분리 때 제거). `CapturedImage` 는 `@parkagent/types`(domain/types) 사용 | `src/clients/CameraClient.ts` — 복제본. `listCameras()` 보유, `CapturedImage`·`CameraList` 로컬 정의 |
| http 유틸 | `src/util/http.ts` — `fetchWithTimeout`+`withRetry`+`isRetryable`(상위집합) | `src/util/http.ts` — `fetchWithTimeout` 만(부분집합 → 폐기 가능) |
| 설정 | `src/config/toolsConfig.ts` — viewer/cameraSources **없음** | `src/config/viewerConfig.ts` — camera/viewer/cameraSources/settingAgentUrl/server |
| 정적 의존성 | `@fastify/static` **없음**(package.json) | `@fastify/static@^9.0.0` 보유 |
| 소스 추상화 | 없음 | `src/viewer/{CameraSource,SimulatorSource,RealPtzSource,sourceRegistry,routes}.ts` |
| SPA | 없음 | `web/{index.html,app.js,app.css,core.js,core.d.ts}` |

**확인된 의존 사실**
- `@fastify/static@9.1.3` 은 루트 `node_modules` 에 이미 호이스팅되어 있음(fastify 5.8.5 호환). 설치는 사실상 package.json 선언만 추가하면 됨.
- SettingViewer `util/http.ts` 는 SettingAgent `util/http.ts` 의 **부분집합** → 복제본 폐기, SettingAgent 것 사용.
- 두 CameraClient 의 차이는 ① `listCameras()` 유무 ② import 출처(`CapturedImage`·`CameraList`)뿐. 로직은 동일.
- SettingAgent 에는 `CameraList` 타입이 없다. 이 타입은 viewer `CameraSource.ts` 에 정의되어 있고 **함께 이동**한다. 재추가하는 `listCameras()` 는 이 이동된 모듈에서 `CameraList` 를 import 한다.
- `web/*` 는 순수 JS(빌드 비대상). `web/core.js` 는 환경 비의존 → 웹 테스트가 직접 import. `web/app.js` 는 `const api = (p) => `/viewer/api${p}`` 로 **모든** 엔드포인트를 `/viewer/api` 접두로 호출(capture·mapping 포함).
- 양쪽 `vitest.config.ts`·`tsconfig.json` 동일(`include: ['test/**/*.test.ts']`, `include: ['src/**/*.ts','test/**/*.ts']`). `web/` 는 tsconfig include 밖 → 타입체크 비대상.
- `viewerRoutes.ts` 는 `@fastify/static` 을 직접 register(와일드카드, API 라우트 뒤). 정적 서빙이 라우트에 내장됨.

---

## 2. 프록시 제거 결정 (근거 명시)

### 2-1. `/viewer/api/mapping` → **직접 읽기로 대체**(프록시 제거)
- **결정**: `buildViewerServer` 의 `/viewer/api/mapping` HTTP 프록시를 폐기하고, SettingAgent buildServer 안에서 `deps.repo.loadArtifact()` 를 **직접** 반환하는 `/viewer/api/mapping` 라우트로 대체.
- **근거**: SettingAgent 는 이미 `/mapping`(= `repo.loadArtifact()`)을 동일 프로세스에서 보유. 자기 자신에게 HTTP 요청(1홉·5s 타임아웃·502 분기)을 보낼 이유가 없다. 인메모리/파일 직접 접근이 가장 단순·정확.
- **404 동작 보존**: 산출물 없으면 `reply.code(404); return { error: 'no setup artifact' }` — 기존 프록시·`/mapping` 과 동일.
- **app.js 영향 없음**: `app.js` 는 `api('/mapping')` = `/viewer/api/mapping` 을 그대로 호출 → 경로 불변(SPA 무수정).

### 2-2. `/viewer/api/capture/*` → **제거하고 SPA 가 `/capture/*` 직접 호출**
- **결정(택1)**: `/viewer/api/capture/*` 프록시 라우트를 **만들지 않는다**. 대신 `app.js` 의 capture 호출만 `/capture/*`(접두 없음) 로 바꾼다.
- **비교한 두 안**
  - (A) SPA 가 `/capture/*` 직접 호출 — app.js 5개 호출 경로 수정.
  - (B) `/viewer/api/capture/*` 를 핸들러 직접 호출로 등록 — app.js 무수정이나 alias 라우트 5개를 SettingAgent 에 신설(중복 라우트).
- **(A) 채택 근거**: SettingAgent 는 이미 `/capture/{start,stop,finalize,status,runs,runs/:id/aggregate}` 를 동일 프로세스·동일 포트로 노출한다. SPA 가 같은 origin(`http://localhost:13020`)에서 그대로 호출하면 alias 라우트가 전혀 필요 없다. (B)는 동일 핸들러를 두 경로에 매다는 **중복**으로, "중복 제거"라는 통합 목표에 역행한다. app.js 수정은 5줄로 외과적이며, 단일 출처 원칙에 부합.
- **app.js 수정점**: `api('/capture/...')` → `'/capture/...'`(아래 §6 표 참조).

### 2-3. 카메라 라우트(`/viewer/api/{cameras,snapshot,move,camera/login,health}`)
- **결정**: 프록시 아님(원래도 CameraSource 직접 호출) → `registerViewerRoutes` 를 **그대로** 이식. CameraSource 레지스트리만 SettingAgent 조립부에서 주입.
- **app.js 영향 없음**: 이 경로들은 `/viewer/api` 접두 유지(아래 §6).

---

## 3. 이동 / 병합 / 삭제 목록 (파일별)

### 3-1. 이동(SettingViewer → SettingAgent, 내용 그대로 + import 경로만 보정)
| 원본 | 대상 | 비고 |
|------|------|------|
| `SettingViewer/src/viewer/CameraSource.ts` | `SettingAgent/src/viewer/CameraSource.ts` | 무수정(상대 import 없음) |
| `SettingViewer/src/viewer/SimulatorSource.ts` | `SettingAgent/src/viewer/SimulatorSource.ts` | `../clients/CameraClient.js` import — SettingAgent 경로 동일 → 무수정 |
| `SettingViewer/src/viewer/RealPtzSource.ts` | `SettingAgent/src/viewer/RealPtzSource.ts` | `../config/viewerConfig.js`(CameraSourceConfig)·`../util/http.js` import → **§3-3 병합 후 경로 보정**(아래) |
| `SettingViewer/src/viewer/sourceRegistry.ts` | `SettingAgent/src/viewer/sourceRegistry.ts` | `../config/viewerConfig.js` import → toolsConfig 로 보정(§3-3) |
| `SettingViewer/src/viewer/routes.ts` | `SettingAgent/src/viewer/routes.ts` | `../config/viewerConfig.js`(ViewerConfig['viewer'])·`../clients/CameraClient.js`(CameraApiError) import → toolsConfig 로 보정 |
| `SettingViewer/web/*`(index.html, app.js, app.css, core.js, core.d.ts) | `SettingAgent/web/*` | app.js 만 capture 경로 5줄 수정(§6) |

### 3-2. 가산(SettingAgent 기존 파일에 추가)
| 파일 | 변경 |
|------|------|
| `SettingAgent/src/clients/CameraClient.ts` | **`listCameras(): Promise<CameraList>` 재추가**(viewer 복제본에서 그대로). `CameraList` 는 `../viewer/CameraSource.js` 에서 import. 나머지 메서드 불변 |
| `SettingAgent/src/config/toolsConfig.ts` | `viewer{enabled,allowMove,defaultFps,staticDir,controlToken}` + `cameraSources[]` 스키마·기본값 추가(§5) |
| `SettingAgent/src/api/server.ts` | `ApiDeps` 에 `viewer?`, `sources?` 추가. `viewer.enabled` 일 때 `/viewer/api/mapping`(직접 읽기) 등록 + `registerViewerRoutes` 등록(§4) |
| `SettingAgent/src/index.ts` | `buildSourceRegistry` 로 sources 빌드 → `buildServer` 주입(§7) |
| `SettingAgent/package.json` | `dependencies` 에 `"@fastify/static": "^9.0.0"` 추가 |
| `SettingAgent/config/tools.config.json` | `viewer`·`cameraSources` 섹션 추가(§5) |

### 3-3. 병합(중복 → SettingAgent 단일)
- **CameraSourceConfig / cameraSources / viewer 타입**: viewer `viewerConfig.ts` 의 `CameraSourceConfigSchema`(→ `CameraSourceConfig`)·`ViewerSchema` 를 SettingAgent `toolsConfig.ts` 로 **병합**. 이후:
  - `RealPtzSource.ts` 의 `import type { CameraSourceConfig } from '../config/viewerConfig.js'` → `'../config/toolsConfig.js'` 로 변경.
  - `sourceRegistry.ts` 의 `ViewerConfig` 의존 → `ToolsConfig`(camera·cameraSources) 로 시그니처 변경(§7-2).
  - `routes.ts` 의 `ViewerConfig['viewer']` → `ToolsConfig['viewer']`.
- **http 유틸**: viewer `util/http.ts`(복제본)는 이동하지 않음. RealPtzSource 가 SettingAgent `util/http.ts`(동일 `fetchWithTimeout`) 사용 → import 경로 동일(`../util/http.js`)이라 무수정.

### 3-4. 삭제(이동·병합 완료 후)
| 삭제 대상 | 사유 |
|-----------|------|
| `SettingViewer/src/clients/CameraClient.ts` | SettingAgent CameraClient 로 일원화(listCameras 재추가됨) |
| `SettingViewer/src/util/http.ts` | SettingAgent http.ts 가 상위집합 |
| `SettingViewer/src/config/viewerConfig.ts` | toolsConfig 로 병합 |
| `SettingViewer/src/server.ts` | buildServer 로 통합(프록시 폐기) |
| `SettingViewer/src/index.ts` | SettingAgent index.ts 단일 부트스트랩 |
| `SettingViewer/test/mappingProxy.test.ts`·`captureProxy.test.ts` | 프록시 폐기로 의미 소멸 → **대체 테스트**로 교체(§8) |
| `SettingViewer/config/viewer.config.json` | tools.config.json 으로 흡수 |
| `SettingViewer/` 폴더 전체(소스 이동·doc 이관 후) | §9 |

---

## 4. 라우트 통합 (buildServer 변경)

`buildServer(deps)` 끝부분(capture 라우트 등록 다음, `return app` 전)에 추가:

```ts
// 뷰어 통합: viewer.enabled && sources 주입 시에만 등록(헤드리스 보존, 가산).
if (deps.viewer?.enabled && deps.sources) {
  // /mapping 직접 읽기(프록시 폐기) — repo.loadArtifact() 그대로 반환, 404 보존.
  app.get('/viewer/api/mapping', async (_req, reply) => {
    const artifact = deps.repo.loadArtifact();
    if (!artifact) { reply.code(404); return { error: 'no setup artifact' }; }
    return artifact;
  });
  // 카메라 라우트 + 정적 SPA(와일드카드는 내부에서 API 뒤에 register).
  await registerViewerRoutes(app, { sources: deps.sources, viewer: deps.viewer });
}
```

- **주의**: `buildServer` 가 동기 `FastifyInstance` 를 반환하지만, `registerViewerRoutes` 는 async(내부 `await app.register(fastifyStatic)`). 두 가지 중 택1(구현자 판단, 단순한 쪽):
  - (권장) `buildServer` 를 `async` 로 바꾸고 `await registerViewerRoutes(...)`. 호출부(index.ts·테스트)는 `await buildServer(...)`. — Fastify 는 `listen()` 시 plugin 등록을 보장하지만, `inject()` 테스트에서 static 라우트가 등록 전이면 404 위험이 있으므로 `await` 가 안전.
  - (대안) `app.register(async (i) => { await registerViewerRoutes(i, ...) })` 로 감싸고 `buildServer` 동기 유지 + 테스트는 `await app.ready()`.
  - **결정**: (권장) `buildServer` 를 async 화. 기존 156 테스트의 `buildServer(...)` 호출 전부 `await` 추가 필요 여부를 확인하고, 동기 사용처가 깨지면 최소 수정. (대부분 테스트는 `app.inject` 전에 await 가능.)
- **라우트 등록 순서**: `/viewer/api/mapping`(정확 경로) → `registerViewerRoutes`(내부에서 `/viewer/api/*` 정확 경로들 먼저, `@fastify/static` 와일드카드 `/viewer/` 마지막). 카메라/capture/mapping 정확 경로가 와일드카드보다 앞서야 함(이미 routes.ts 가 보장).
- **`/health` 충돌 주의**: SettingAgent 에 이미 `/health`(루트) 존재. 뷰어는 `/viewer/api/health`(접두 다름) → 충돌 없음.

---

## 5. 설정 스키마 (toolsConfig 확장)

`toolsConfig.ts` 에 추가(viewer `viewerConfig.ts` 에서 가져옴, 하위호환):

```ts
const ViewerSchema = z.object({
  enabled: z.boolean(),
  allowMove: z.boolean(),
  defaultFps: z.number().int().positive(),
  staticDir: z.string().min(1),
  controlToken: z.string(),
});

const CameraSourceConfigSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['sim', 'hucoms']),
  baseUrl: z.string().url().optional(),
  host: z.string().optional(),
  port: z.number().int().positive().optional(),
  loginPath: z.string().optional(),
  snapshotUrl: z.string().optional(),
  ptz: z.object({
    panRange: z.tuple([z.number(), z.number()]),
    tiltRange: z.tuple([z.number(), z.number()]),
    zoomRange: z.tuple([z.number(), z.number()]),
  }).optional(),
});
export type CameraSourceConfig = z.infer<typeof CameraSourceConfigSchema>;
```

`ToolsConfigSchema` 에 `viewer: ViewerSchema`, `cameraSources: z.array(CameraSourceConfigSchema).optional()` 추가.

`DEFAULT_TOOLS_CONFIG` 에:
```ts
viewer: { enabled: true, allowMove: true, defaultFps: 3, staticDir: 'web', controlToken: '' },
// cameraSources 는 기본값 미설정(undefined → sourceRegistry 가 단일 sim 으로 폴백)
```

**병합 함수 주의(`loadToolsConfig`)**: 현재 `for (key of Object.keys(DEFAULT)) merged[key] = {...DEFAULT[key], ...raw[key]}` 로 **섹션 단위 객체 병합**한다. `viewer` 는 객체이므로 그대로 동작. 그러나 `cameraSources` 는 **옵셔널 배열** → 객체 spread 병합이 부적합. viewer 의 `loadViewerConfig` 가 한 것처럼 별도 처리 필요:
```ts
// 객체 섹션만 spread 병합. cameraSources(배열)는 있으면 그대로 통과.
for (const key of OBJECT_KEYS) merged[key] = { ...DEFAULT[key], ...(raw[key] ?? {}) };
if (raw.cameraSources !== undefined) merged.cameraSources = raw.cameraSources;
```
→ `Object.keys(DEFAULT_TOOLS_CONFIG)` 순회에서 `cameraSources` 는 DEFAULT 에 없으므로(undefined) 누락된다. 따라서 `cameraSources` 패스스루 한 줄을 명시 추가. (config.test.ts 회귀 확인.)

`tools.config.json` 에 추가(하위호환·기본값):
```json
"viewer": { "enabled": true, "allowMove": true, "defaultFps": 3, "staticDir": "web", "controlToken": "" }
```
- `cameraSources` 는 미기재(폴백: 단일 sim, id='sim', camera.baseUrl 사용) — 기존 단일 시뮬레이터 동작과 동일.
- **강등 경로**: `viewer.enabled=false` → buildServer 가 `/viewer/api/*`·정적 미등록. SPA 접속 시 404(순수 에이전트). index.ts 는 enabled 와 무관하게 sources 를 빌드해도 무방하나, 불필요 시 `enabled` 일 때만 빌드해도 됨(§7).

---

## 6. SPA(`web/app.js`) 수정점 (정확)

`const api = (path) => `/viewer/api${path}``(L19) **유지**. capture 호출 5곳만 접두 없는 절대경로로 변경:

| 위치(함수) | 변경 전 | 변경 후 |
|-----------|---------|---------|
| `capFetchStatus` (L262) | `fetch(api('/capture/status'))` | `fetch('/capture/status')` |
| `capStart` (L301) | `fetch(api('/capture/start'), {...})` | `fetch('/capture/start', {...})` |
| `capStop` (L312) | `fetch(api('/capture/stop'), {...})` | `fetch('/capture/stop', {...})` |
| `capFinalize` (L319) | `fetch(api('/capture/finalize'), {...})` | `fetch('/capture/finalize', {...})` |

> 참고: capture GET 중 SPA 가 실제 호출하는 것은 `status` 뿐(runs·aggregate 는 app.js 미사용). start/stop/finalize/status 4개만 수정하면 됨.

**유지(수정 금지)** — 동일 origin/동일 프로세스라 그대로 동작:
- `/viewer/api/cameras`, `/viewer/api/snapshot`, `/viewer/api/move`, `/viewer/api/camera/login`, `/viewer/api/health` → `registerViewerRoutes` 가 동일 경로로 제공.
- `/viewer/api/mapping`(loadMapping·fetchArtifact, L47·L336) → §4 직접 읽기 라우트가 동일 경로 제공 → **무수정**.

→ 순변경: app.js 4줄. (다른 파일 web/* 무수정.)

---

## 7. 조립 변경 (index.ts) + 소스 레지스트리

### 7-1. index.ts
```ts
import { buildSourceRegistry } from './viewer/sourceRegistry.js';
...
const sources = tools.viewer.enabled ? buildSourceRegistry(tools) : undefined;
const app = await buildServer({   // async 화(§4)
  orchestrator, repo, camera, vpd, brain, mapFiles: tools.map, discovery: tools.discovery,
  presetProvider, refreshOnRun: tools.presetProvider.refreshOnRun,
  captureJob, finalizer, sqlite, capture: tools.capture,
  viewer: tools.viewer, sources,            // 가산
});
await app.listen({ port: tools.server.port, host: '0.0.0.0' });
```
- 로그 한 줄에 `viewerEnabled: tools.viewer.enabled` 추가(선택).

### 7-2. sourceRegistry 시그니처 변경
현재 `buildSourceRegistry(cfg: ViewerConfig)` 가 `cfg.camera`·`cfg.cameraSources` 사용. ToolsConfig 도 동일 필드(`camera`·`cameraSources`)를 가지므로 시그니처만 변경:
```ts
export function buildSourceRegistry(cfg: Pick<ToolsConfig, 'camera' | 'cameraSources'>): Map<string, CameraSource>
```
- 본문 로직 불변(폴백: cameraSources 없으면 단일 sim).
- `SimulatorSource` 가 받는 `new CameraClient(cfg.camera)` — SettingAgent CameraClient 생성자는 `ToolsConfig['camera']` 를 받으므로 타입 일치(이미 동일 shape).

---

## 8. 테스트 이관 (vitest)

### 8-1. 그대로 이동(경로 보정만)
| 원본(viewer/test) | 대상(SettingAgent/test) | 보정 |
|-------------------|-------------------------|------|
| `cameraClientList.test.ts` | 동일 | import `../src/clients/CameraClient.js`(경로 동일). `ViewerConfig['camera']` 타입 참조 → `ToolsConfig['camera']` 로 변경(또는 인라인 객체 유지) |
| `simulatorSource.test.ts` | 동일 | `../src/viewer/SimulatorSource.js` 경로 동일 → 무보정 |
| `realPtzSource.test.ts` | 동일 | `CameraSourceConfig` import 출처 → `../src/config/toolsConfig.js` |
| `sourceRegistry.test.ts` | 동일 | `buildSourceRegistry` 인자 타입(ViewerConfig→ToolsConfig 부분) 보정 |
| `viewerRoutes.test.ts` | 동일 | `registerViewerRoutes`·`CameraSource` import 경로 동일. `ViewerConfig` import → 제거/인라인 |
| `viewerCore.test.ts` | 동일 | `../web/core.js` 경로 동일 → 무보정 |
| `analyzeArtifact.test.ts` | 동일 | `../web/core.js` → 무보정 |
| `findPresetPtz.test.ts` | 동일 | `../web/core.js` → 무보정 |
| `panelResize.test.ts` | 동일 | `../web/core.js` → 무보정 |
| `captureCore.test.ts` | 동일 | `../web/core.js` → 무보정 |

### 8-2. 대체/수정(프록시 폐기로 의미 변경)
- **`mappingProxy.test.ts` → `mappingDirect.test.ts`(대체)**: 더 이상 upstream HTTP 흉내가 무의미. `buildServer` 를 repo 스텁(`loadArtifact` 가 산출물/null 반환)으로 띄워 `/viewer/api/mapping` 이:
  - 산출물 있음 → 200 + JSON(`repo.loadArtifact()` 결과) 패스스루
  - 산출물 없음 → 404 `{error:'no setup artifact'}`
  를 검증. (502/타임아웃 케이스는 자기호출 제거로 소멸 → 삭제.)
- **`captureProxy.test.ts` → 삭제(기존 `captureRoutes.test.ts` 가 커버)**: SPA 가 `/capture/*` 를 직접 호출하므로 프록시 alias 가 없다. `/capture/*` 동작은 SettingAgent 기존 `captureRoutes.test.ts`(11KB, 이미 통과)가 검증. 별도 뷰어용 capture 테스트 불필요.
  - 대신 통합 회귀로 **`viewerEnabled.test.ts`(신규, 소형)** 추가 권장: `viewer.enabled=false` 면 `/viewer/api/health` 가 404, `true` 면 200 + `/health`(루트)·`/capture/status` 가 enabled 무관하게 동작 — 헤드리스 강등·라우트 충돌 없음을 1개 파일로 검증.

### 8-3. 검증 목표
- SettingAgent 단일 `npm test`(vitest) 가 **기존 156 + 이관분(약 11개 파일)** 전부 통과.
- `npm run typecheck` 무오류(이동 파일 import 경로 보정 포함).

---

## 9. SettingViewer 폴더 처리 + 루트 워크스페이스

1. **doc 이관(이력 보존)**: `SettingViewer/doc/*.md`(7개) → `SettingAgent/docs/` 로 이동(파일명 유지). SettingViewer 설계·검증·분리 이력 보존.
2. **소스/테스트/web/config 이동·삭제 완료** 후 `SettingViewer/` 폴더 **전체 제거**.
3. **루트 `package.json` workspaces** 에서 `"SettingViewer"` 제거 → `["packages/*", "SettingAgent"]`.
4. **bat 정리**: `setviewer.bat` 제거(통합으로 무의미). `setagent.bat` 유지(`cd SettingAgent && npm start` 가 뷰어까지 서빙). — 루트 정리 항목으로 명시(구현자 재량, 선택).
5. **루트 `package-lock.json`**: workspaces 변경 후 `npm install` 1회로 갱신(`@fastify/static` 을 SettingAgent dep 로 정식 등록).

---

## 10. 단계별 작업 순서 + 각 단계 검증

```
1. [설정 병합] toolsConfig.ts 에 ViewerSchema·CameraSourceConfigSchema·cameraSources 패스스루 추가.
              tools.config.json 에 viewer 섹션 추가. package.json 에 @fastify/static 추가.
   → 검증: npm run typecheck 통과. config.test.ts 통과(viewer 기본값 로드 확인).

2. [소스 이동] src/viewer/*(5파일) 이동 + import 경로 보정(CameraSourceConfig→toolsConfig).
              CameraClient.listCameras() 재추가(CameraList from ../viewer/CameraSource.js).
   → 검증: npm run typecheck 통과.

3. [서버 통합] buildServer async 화 + viewer.enabled 분기(/viewer/api/mapping 직접읽기 + registerViewerRoutes).
              ApiDeps 에 viewer?·sources? 추가.
   → 검증: typecheck 통과. 기존 buildServer 사용 테스트(apiRefresh 등) await 보정 후 통과.

4. [조립] index.ts 에서 buildSourceRegistry 로 sources 빌드 → buildServer 주입(await).
   → 검증: typecheck 통과. npm run dev 기동 → http://localhost:13020/viewer/ 200, /health 200.

5. [SPA 이동] web/* 이동. app.js capture 4줄(status/start/stop/finalize) → /capture/* 직접호출.
   → 검증: 브라우저 접속 — 카메라/스냅샷/이동/프리셋이동/정밀수집/분석탭 동작(Play 상응).

6. [테스트 이관] viewer/test 11파일 이동·경로보정. mappingProxy→mappingDirect 대체.
              captureProxy 삭제. viewerEnabled.test.ts 신규.
   → 검증: npm test — 기존 156 + 이관분 전부 통과(회귀 0).

7. [정리] doc 이관(SettingViewer/doc→SettingAgent/docs). SettingViewer/ 삭제.
         루트 package.json workspaces 에서 SettingViewer 제거. npm install 로 lock 갱신.
   → 검증: npm test(루트/SettingAgent) 통과. SettingViewer 참조 잔존 0(grep).
```

---

## 11. 영향도 사전분석

| 대상 | 영향 | 근거 |
|------|------|------|
| `@parkagent/types`(SetupArtifact 등) | **무영향** | 타입 변경 없음. `/mapping` 응답 shape 동일(repo.loadArtifact) |
| ActionAgent / DMAgent | **무영향** | SettingAgent 외부 계약(`/setup`·`/mapping`·`/capture`) 불변. 별 워크스페이스 |
| `/setup/*` 계약 | **무영향** | 미수정 |
| `/capture/*` 계약 | **무영향** | 라우트·핸들러 불변. SPA 가 직접 호출하도록만 변경(서버측 동일) |
| `/mapping` 루트 라우트 | **무영향** | 기존 `/mapping`(repo 직접) 그대로. 신설은 `/viewer/api/mapping`(별 경로) |
| `/health` 루트 라우트 | **무영향** | 뷰어는 `/viewer/api/health`(별 경로) |
| 기존 156 vitest | **회귀 0 목표** | 변경은 가산·async 보정뿐. buildServer async 화로 호출부 await 보정만 필요(소수 테스트) |
| MCP 도구 / LLM 두뇌 경계 | **무영향** | 통합은 REST·정적 서빙 계층. MCP server(src/mcp)·brain 미수정 |
| 런타임 포트 | 13030 폐기, 13020 단일 | setviewer.bat 제거 |

**MCP 도구 vs LLM 두뇌 경계 판단**: 이번 작업은 **둘 다 아님**. 순수 인프라(REST 라우팅·정적 파일 서빙·설정 통합) 변경으로, 결정형 도구(센터라이징/PTZ 루프)도 LLM 판단도 신설하지 않는다. CameraSource 추상화는 기존 결정형 카메라 제어(req_img/req_move/cameras)의 어댑터일 뿐 — 경계 변동 없음.

---

## 12. 리스크 & 완화

| 리스크 | 영향 | 완화 |
|--------|------|------|
| `buildServer` async 화로 기존 테스트 호출부 깨짐 | 회귀 | (대안) `app.register(async i => registerViewerRoutes(i,...))` 로 감싸 buildServer 동기 유지 + 테스트 `await app.ready()`. 둘 중 회귀 적은 쪽 채택. 먼저 grep 으로 buildServer 호출처 전수 확인 |
| `loadToolsConfig` 의 cameraSources(배열) 병합 누락 | cameraSources 무시됨 | §5 패스스루 한 줄 추가 + config.test.ts 에 케이스 보강 |
| app.js capture 경로 누락 수정 | 정밀수집 탭 깨짐 | §6 표의 4줄 정확 명시(status/start/stop/finalize). runs/aggregate 는 app.js 미사용 |
| `/viewer/api/*` 와일드카드 vs 정확경로 순서 | mapping/capture 404 | routes.ts 가 이미 API 라우트 뒤에 static 등록. `/viewer/api/mapping` 은 그 앞(§4 등록 순서 준수) |
| `@fastify/static` 버전 불일치 | 기동 실패 | 루트에 9.1.3 호이스팅 확인됨(fastify 5.8.5 호환). package.json `^9.0.0` 선언 + npm install |
| 중복 제거 누락(viewer http.ts·CameraClient·viewerConfig 잔존) | 데드코드·혼란 | §3-4 삭제 목록 체크리스트화. 7단계 grep 으로 `SettingViewer`·`viewerConfig`·`buildViewerServer` 참조 0 확인 |
| `CameraList` 타입 위치 | 빌드 오류 | viewer `CameraSource.ts` 와 함께 이동되므로 SettingAgent 내부에 존재. CameraClient.listCameras 가 `../viewer/CameraSource.js` 에서 import |
| 헤드리스(enabled=false) 시 sources 미빌드 | RealPtz/sim 의존 누락 | index.ts 에서 `enabled ? buildSourceRegistry(tools) : undefined`. buildServer 가 `viewer.enabled && sources` 이중 가드 |

---

## 13. 미해결 / 가정 (리더 확인 필요 시)

1. **buildServer async 화 vs register 래핑**: 본 설계는 async 화를 권장하되, buildServer 호출처 전수 조사 후 회귀가 적은 쪽을 구현자가 택하도록 위임. (둘 다 동작상 동등) — 진행 가능, 별도 승인 불요.
2. **setviewer.bat / setagent.bat**: 통합 후 setviewer.bat 제거를 제안. 마스터가 두 bat 유지를 원하면 setagent.bat 만 남기는 것으로 충분(뷰어 포함 서빙). — 기본은 setviewer.bat 제거로 진행.
3. **cameraSources 실 PTZ(hucoms) 항목**: 현재 viewer.config.json 에 cameraSources 미기재(단일 sim 폴백). 통합 후에도 동일 폴백 유지 → 실 PTZ 사용 시 tools.config.json 에 cameraSources 추가(기존 viewer 와 동일 절차). 신규 기능 아님.

이상 — 구현자(developer)는 §3·§4·§5·§6·§7·§10 을 그대로 따르고, 검증자(qa-tester)는 §8·§10 의 검증 기준으로 회귀 0 을 확인한다.
