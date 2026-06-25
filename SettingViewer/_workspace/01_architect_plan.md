# SettingViewer 독립 서비스 분리 — 구현 계획 (01_architect_plan)

- 작성일: 2026-06-25
- 작성자: architect (ParkAgent 설계자)
- 목적: **SettingAgent 내부에 구현된 웹 뷰어를 `SettingViewer/` 독립 서비스로 통째로 분리**한다(자체 Node/Fastify·자체 포트).
- 기준 컨텍스트: `SettingAgent/_workspace_prev/01~04` + 뷰어 설계서(`SettingAgent/docs/20260625_170811_...`).
- **범위 한정**: 기능 추가/변경 없음 — **'분리(decouple)'만** 수행. 단 하나의 신규 기능은 `/mapping` 프록시 라우트(분리로 인해 불가피).
- 구현자(developer)는 이 문서를 그대로 따라 코딩한다. 과설계 금지(ParkSimMgr 컨벤션: ESM·1-based·외과적·단순함 우선).

---

## 0. 핵심 결정 요약

| 항목 | 결정 | 근거 |
|------|------|------|
| 신규 서비스 위치 | `SettingViewer/` (ParkAgent 루트 하위) | 사용자 지시 |
| 패키지명 | `parkagent-viewer` | 사용자 지시 |
| 기본 포트 | **13030** | 사용자 제안. SettingAgent 13020 / Unity 13100 과 비충돌 |
| 런타임 의존 | `fastify`, `@fastify/static`, `zod` (dev: `tsx`, `typescript`, `vitest`) | 사용자 지시 deps 목록 |
| SettingAgent 소스 의존 | **금지**(워크스페이스 npm link 외 소스 import 0건) | 사용자 지시 — 독립성 확보 |
| `@parkagent/types` 의존 | **추가 안 함** | CameraClient 가 쓰는 `CapturedImage` 는 작은 단독 인터페이스 → SettingViewer 내부에 로컬 정의(소스 의존 회피) |
| 단일 출처 유지 | 브라우저는 SettingViewer(:13030)만 호출. ROI(`/mapping`)는 SettingViewer 서버가 SettingAgent(:13020)로 프록시 | 사용자 지시 아키텍처 |
| 두 서비스 기동 순서 | SettingAgent 먼저(`/mapping` 제공) → SettingViewer | 프록시 대상 가용성 |

### MCP 도구 vs LLM 두뇌 경계
- **전부 결정형(도구) 영역**. SettingViewer 는 스냅샷 폴링·좌표변환·PTZ 절대이동·REST 프록시만 수행. **LLM 두뇌 호출 0건**(셋업 검토는 SettingAgent `/brain/*` 담당, 분리 후에도 SettingViewer 범위 밖).
- 신규 `/mapping` 프록시도 단순 REST 중계(결정형). 이 분리 작업으로 도구/두뇌 경계는 **변하지 않는다**.

---

## 1. SettingViewer/ 폴더 구조 (신설)

```
SettingViewer/
├── package.json            (신규: name=parkagent-viewer, type=module, port script)
├── tsconfig.json           (신규: SettingAgent 와 동일 NodeNext 설정, rootDir=".")
├── vitest.config.ts        (신규: include test/**/*.test.ts, environment node)
├── config/
│   └── viewer.config.json  (신규: camera·cameraSources·viewer·settingAgentUrl·server.port)
├── src/
│   ├── index.ts            (신규: 부트스트랩 — config 로드→소스 빌드→서버 기동)
│   ├── server.ts           (신규: buildServer — registerViewerRoutes + /mapping 프록시)
│   ├── config/
│   │   └── viewerConfig.ts (신규: zod 스키마+로더. SettingAgent toolsConfig 의 viewer 부분만 발췌)
│   ├── clients/
│   │   └── CameraClient.ts (이동/복제: SettingAgent → SettingViewer)
│   ├── util/
│   │   └── http.ts         (복제: fetchWithTimeout 만. withRetry/isRetryable 는 미사용 → 제외)
│   └── viewer/
│       ├── CameraSource.ts     (이동)
│       ├── SimulatorSource.ts  (이동)
│       ├── RealPtzSource.ts    (이동)
│       ├── sourceRegistry.ts   (이동)
│       └── routes.ts           (이동)
├── web/
│   ├── index.html          (이동)
│   ├── app.js              (이동 + /mapping 호출 1줄 수정)
│   ├── core.js             (이동, 무수정)
│   └── app.css             (이동, 무수정)
├── test/
│   ├── cameraClientList.test.ts (이동 + import 경로 보정)
│   ├── simulatorSource.test.ts  (이동 + import 경로 보정)
│   ├── sourceRegistry.test.ts   (이동 + import 경로 보정)
│   ├── realPtzSource.test.ts    (이동 + import 경로 보정)
│   ├── viewerRoutes.test.ts     (이동 + import 경로 보정)
│   ├── viewerCore.test.ts       (이동, ../web/core.js 경로 유지)
│   └── mappingProxy.test.ts     (신규: /mapping 프록시 라우트 검증)
├── doc/                    (문서 이동 대상 — 사용자 지시 폴더명 'doc')
│   ├── 20260625_170811_SettingViewer_웹뷰어_설계서.md (이동 + 경로 보정)
│   ├── 20260625_182819_SettingViewer_구현문서.md      (이동 + 경로 보정)
│   ├── 20260625_182819_SettingViewer_영향도분석.md    (이동 + 경로 보정)
│   └── 20260625_081406_settingviewer_validation.md    (이동 + 경로 보정)
└── _workspace/
    └── 01_architect_plan.md (본 문서)
```

---

## 2. 이동 / 복제 / 신규 / 삭제 — 파일 단위 명세

### 2.1 이동(move) — SettingAgent → SettingViewer (그대로 옮김, import 경로만 보정)

| 원본 | 대상 | 코드 수정 |
|------|------|-----------|
| `SettingAgent/src/viewer/CameraSource.ts` | `SettingViewer/src/viewer/CameraSource.ts` | 무수정(상대 import 없음) |
| `SettingAgent/src/viewer/SimulatorSource.ts` | `SettingViewer/src/viewer/SimulatorSource.ts` | import 경로 유지(`../clients/CameraClient.js`, `./CameraSource.js`) — 동일 트리이므로 무수정 |
| `SettingAgent/src/viewer/RealPtzSource.ts` | `SettingViewer/src/viewer/RealPtzSource.ts` | **수정**: `import type { CameraSourceConfig } from '../config/toolsConfig.js'` → `'../config/viewerConfig.js'`. `fetchWithTimeout` import(`../util/http.js`) 경로 유지 |
| `SettingAgent/src/viewer/sourceRegistry.ts` | `SettingViewer/src/viewer/sourceRegistry.ts` | **수정**: `import type { ToolsConfig } from '../config/toolsConfig.js'` → `ViewerConfig from '../config/viewerConfig.js'`. 타입명 `tools: ToolsConfig` → `cfg: ViewerConfig`(아래 §3 참조) |
| `SettingAgent/src/viewer/routes.ts` | `SettingViewer/src/viewer/routes.ts` | **수정**: `import type { ToolsConfig } from '../config/toolsConfig.js'` → `ViewerConfig from '../config/viewerConfig.js'`. `viewer: ToolsConfig['viewer']` → `viewer: ViewerConfig['viewer']`. `@fastify/static`·`CameraApiError`·`CameraSource` import 경로 유지 |
| `SettingAgent/web/index.html` | `SettingViewer/web/index.html` | 무수정 |
| `SettingAgent/web/core.js` | `SettingViewer/web/core.js` | 무수정 |
| `SettingAgent/web/app.css` | `SettingViewer/web/app.css` | 무수정 |
| `SettingAgent/web/app.js` | `SettingViewer/web/app.js` | **수정 1줄**(§4: `/mapping` → `api('/mapping')`) |
| `SettingAgent/test/simulatorSource.test.ts` | `SettingViewer/test/simulatorSource.test.ts` | **수정**: `import type { CapturedImage } from '../src/domain/types.js'` → `'../src/clients/CameraClient.js'`(로컬 정의 재수출). 나머지 `../src/viewer/*` 경로 유지 |
| `SettingAgent/test/sourceRegistry.test.ts` | `SettingViewer/test/sourceRegistry.test.ts` | **수정**: `DEFAULT_TOOLS_CONFIG, ToolsConfig from '../src/config/toolsConfig.js'` → `DEFAULT_VIEWER_CONFIG, ViewerConfig from '../src/config/viewerConfig.js'`. 테스트 본문의 `DEFAULT_TOOLS_CONFIG` 사용처를 `DEFAULT_VIEWER_CONFIG` 로 치환(아래 §3 호환) |
| `SettingAgent/test/realPtzSource.test.ts` | `SettingViewer/test/realPtzSource.test.ts` | **수정**: `CameraSourceConfig from '../src/config/toolsConfig.js'` → `'../src/config/viewerConfig.js'` |
| `SettingAgent/test/viewerRoutes.test.ts` | `SettingViewer/test/viewerRoutes.test.ts` | **수정**: `ToolsConfig from '../src/config/toolsConfig.js'` → `ViewerConfig from '../src/config/viewerConfig.js'`(`viewer` 섹션 타입만 사용) |
| `SettingAgent/test/cameraClientList.test.ts` | `SettingViewer/test/cameraClientList.test.ts` | **수정**: `ToolsConfig from '../src/config/toolsConfig.js'` → `ViewerConfig from '../src/config/viewerConfig.js'`. `CameraClient` 경로 유지 |
| `SettingAgent/test/viewerCore.test.ts` | `SettingViewer/test/viewerCore.test.ts` | 무수정(`../web/core.js` 경로 동일) |

> 이동은 `git mv` 사용 권장(이력 보존). import 보정은 위 표대로만(외과적).

### 2.2 복제(copy, 일부 발췌) — SettingAgent 잔존 + SettingViewer 신규 사본

CameraClient/http util 은 SettingAgent **셋업 파이프라인이 계속 사용**하므로 SettingAgent 에서 삭제 불가 → SettingViewer 로 **복제**(이동 아님). 두 사본의 향후 동기화는 리스크 §9 로 관리.

| 원본 | 대상 | 복제 시 수정 |
|------|------|--------------|
| `SettingAgent/src/clients/CameraClient.ts` | `SettingViewer/src/clients/CameraClient.ts` | **수정 2건**: ① `import type { CapturedImage } from '../domain/types.js'` 제거 → 파일 상단에 **로컬 `CapturedImage` 인터페이스 정의 + export**(packages/types 와 동일 8필드: camIdx/presetIdx/pan/tilt/zoom/imgName/jpg:Buffer). ② `import type { CameraList } from '../viewer/CameraSource.js'` 경로 유지(SettingViewer 트리에 CameraSource 존재). `ToolsConfig['camera']` 타입은 `ViewerConfig['camera']` 로 교체(`import type { ViewerConfig } from '../config/viewerConfig.js'`) |
| `SettingAgent/src/util/http.ts` 의 `fetchWithTimeout` | `SettingViewer/src/util/http.ts` | **발췌**: `fetchWithTimeout` 만 복제. `isRetryable`/`withRetry`/`RetryOptions` 는 SettingViewer 미사용 → **제외**(단순함 우선). 무로직 수정 |

> **로컬 CapturedImage 정의 근거**: SettingViewer 는 SettingAgent/packages 소스에 의존하지 않아야 함(사용자 지시). `CapturedImage` 는 의존성 없는 8필드 인터페이스라 복제 비용 최소. CameraClient 가 자체 export 하면 `simulatorSource.test.ts` 의 `import type { CapturedImage }` 도 CameraClient 에서 가져오면 됨.

### 2.3 신규(new) — SettingViewer 전용

| 파일 | 내용 |
|------|------|
| `SettingViewer/package.json` | name=`parkagent-viewer`, type=module, scripts(start/dev/typecheck/test), deps(`fastify`/`@fastify/static`/`zod`), devDeps(`@types/node`/`tsx`/`typescript`/`vitest`). 버전은 SettingAgent 와 동일 핀(@fastify/static `^9.0.0`, fastify `^5.2.0`, zod `^3.24.1`) |
| `SettingViewer/tsconfig.json` | SettingAgent 와 동일(NodeNext, strict, `include:["src/**/*.ts","test/**/*.ts"]`). `types:["node"]` |
| `SettingViewer/vitest.config.ts` | `include:['test/**/*.test.ts']`, `environment:'node'`(SettingAgent 동일) |
| `SettingViewer/src/config/viewerConfig.ts` | **신규 config 모듈**(§3). SettingAgent `toolsConfig.ts` 에서 **camera/viewer/cameraSources/server.port** 만 발췌 + `settingAgentUrl` 추가 |
| `SettingViewer/src/server.ts` | `buildViewerServer(deps)` — Fastify 인스턴스 생성 → `registerViewerRoutes` 호출 → **`/mapping` 프록시 라우트 등록**(§4) |
| `SettingViewer/src/index.ts` | 부트스트랩: `loadViewerConfig()` → `buildSourceRegistry(cfg)` → `buildViewerServer({...})` → `listen(server.port)` |
| `SettingViewer/config/viewer.config.json` | 실행 설정(§3.3) |
| `SettingViewer/test/mappingProxy.test.ts` | `/mapping` 프록시 검증(§4): SettingAgent stub(로컬 http 서버 또는 fetch mock) → 200 패스스루 / 404 / 502(SettingAgent 미가동) |

### 2.4 삭제(remove) — SettingAgent 정리(§5)

`SettingAgent/src/viewer/`(5파일), `SettingAgent/web/`(4파일), 뷰어 테스트 6파일, 그리고 §5의 배선/설정 제거.

---

## 3. SettingViewer config 모듈 (`src/config/viewerConfig.ts`)

SettingAgent `toolsConfig.ts` 전체를 가져오지 않고, **SettingViewer 가 실제 쓰는 섹션만 발췌**(단순함 우선). 발췌 대상: `camera`(CameraClient/SimulatorSource 용), `viewer`(routes 용), `cameraSources`(sourceRegistry 용), `server.port`(기동), 신규 `settingAgentUrl`(프록시 대상).

### 3.1 스키마(zod) — toolsConfig 에서 복제

```ts
import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';

const CameraSchema = z.object({          // toolsConfig CameraSchema 그대로
  baseUrl: z.string().url(),
  imageTimeoutMs: z.number().int().positive(),
  moveTimeoutMs: z.number().int().positive(),
  zoomMin: z.number().positive(),
  zoomMax: z.number().positive(),
});
const ViewerSchema = z.object({          // toolsConfig ViewerSchema 그대로
  enabled: z.boolean(),
  allowMove: z.boolean(),
  defaultFps: z.number().int().positive(),
  staticDir: z.string().min(1),
  controlToken: z.string(),
});
const CameraSourceConfigSchema = z.object({ /* toolsConfig 와 동일 */ });
export type CameraSourceConfig = z.infer<typeof CameraSourceConfigSchema>;
const ServerSchema = z.object({ port: z.number().int().positive() });

export const ViewerConfigSchema = z.object({
  camera: CameraSchema,
  viewer: ViewerSchema,
  cameraSources: z.array(CameraSourceConfigSchema).optional(),
  settingAgentUrl: z.string().url(),     // 신규: /mapping 프록시 대상
  server: ServerSchema,
});
export type ViewerConfig = z.infer<typeof ViewerConfigSchema>;

export const DEFAULT_VIEWER_CONFIG: ViewerConfig = {
  camera: { baseUrl: 'http://localhost:13100', imageTimeoutMs: 7000, moveTimeoutMs: 3000, zoomMin: 1.0, zoomMax: 36.0 },
  viewer: { enabled: true, allowMove: true, defaultFps: 3, staticDir: 'web', controlToken: '' },
  settingAgentUrl: 'http://localhost:13020',
  server: { port: 13030 },
};

/** viewer.config.json 로드(섹션 병합). 파일 없으면 기본값. (toolsConfig.loadToolsConfig 패턴 복제) */
export function loadViewerConfig(path = 'config/viewer.config.json'): ViewerConfig {
  if (!existsSync(path)) return ViewerConfigSchema.parse(DEFAULT_VIEWER_CONFIG);
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, any>;
  const merged: Record<string, unknown> = {};
  for (const key of ['camera', 'viewer', 'server'] as const) {
    merged[key] = { ...DEFAULT_VIEWER_CONFIG[key], ...(raw[key] ?? {}) };
  }
  merged.settingAgentUrl = raw.settingAgentUrl ?? DEFAULT_VIEWER_CONFIG.settingAgentUrl;
  if (raw.cameraSources !== undefined) merged.cameraSources = raw.cameraSources;
  return ViewerConfigSchema.parse(merged);
}
```

### 3.2 sourceRegistry 시그니처 조정
- `buildSourceRegistry(tools: ToolsConfig)` → `buildSourceRegistry(cfg: ViewerConfig)`.
- 본문 `tools.cameraSources` / `tools.camera` → `cfg.cameraSources` / `cfg.camera`(`camera` 필드명 동일 → 본문 거의 무변경).
- `new CameraClient(tools.camera)` → `new CameraClient(cfg.camera)`. `CameraClient` import 경로 유지.

### 3.3 `config/viewer.config.json` (실행 설정)
```jsonc
{
  "camera": {
    "baseUrl": "http://localhost:13100",
    "imageTimeoutMs": 7000, "moveTimeoutMs": 3000, "zoomMin": 1.0, "zoomMax": 36.0
  },
  "viewer": { "enabled": true, "allowMove": true, "defaultFps": 3, "staticDir": "web", "controlToken": "" },
  "settingAgentUrl": "http://localhost:13020",
  "server": { "port": 13030 }
}
```
- `cameraSources` 미기재(sim 단일 폴백 = 기존 동작 보존). 실 PTZ 는 설정 주입으로만(자격증명 미기재).

---

## 4. `/mapping` 프록시 (분리로 인한 유일한 신규 기능)

### 4.1 서버측 — `src/server.ts`
브라우저 ROI(`loadMapping`)가 호출하던 SettingAgent `/mapping` 을 SettingViewer 가 중계한다.

```ts
// buildViewerServer 내부, registerViewerRoutes 등록과 함께:
app.get('/viewer/api/mapping', async (_req, reply) => {
  try {
    const res = await fetchWithTimeout(`${settingAgentUrl}/mapping`, { method: 'GET' }, 5000);
    if (res.status === 404) { reply.code(404); return { error: 'no setup artifact' }; }
    if (!res.ok)            { reply.code(502); return { error: `mapping upstream HTTP ${res.status}` }; }
    reply.header('Content-Type', 'application/json');
    return reply.send(await res.text());   // SetupArtifact JSON 패스스루(파싱 불필요)
  } catch {
    reply.code(502); return { error: 'mapping upstream unreachable' };
  }
});
```
- 경로: **`GET /viewer/api/mapping`**(다른 뷰어 API 와 prefix 통일). `registerViewerRoutes` 의 정적 와일드카드(`/viewer/`)보다 **먼저** 등록(라우트 우선순위 — routes.ts 와 동일 패턴). → 등록 순서: ① 이 프록시 라우트 → ② `registerViewerRoutes`(API + static).
- `fetchWithTimeout` 재사용(복제본). 타임아웃 5000ms.
- 응답 본문은 `res.text()` 패스스루(서버가 SetupArtifact shape 을 알 필요 없음 — 결합 최소).

### 4.2 프런트측 — `web/app.js` 수정 (1줄)
```diff
  async function loadMapping() {
    try {
-     const res = await fetch('/mapping');
+     const res = await fetch(api('/mapping'));
      state.mapping = res.ok ? await res.json() : null;
    } catch {
      state.mapping = null;
    }
  }
```
- `api('/mapping')` → `/viewer/api/mapping`(기존 `api` 헬퍼: ``/viewer/api${path}``). 그 외 app.js 무변경.

---

## 5. SettingAgent 정리 (decouple — 외과적)

> **불변 조건: 기존 81개 셋업 테스트 그대로 통과.** 뷰어 분리 후 138 → 81 로 회귀(신규 57 = 뷰어 테스트는 SettingViewer 로 이동).

### 5.1 삭제
| 대상 | 비고 |
|------|------|
| `SettingAgent/src/viewer/` (5파일 전체) | SettingViewer 로 이동 완료 후 삭제 |
| `SettingAgent/web/` (4파일 전체) | 〃 |
| `SettingAgent/test/{cameraClientList,simulatorSource,sourceRegistry,realPtzSource,viewerRoutes,viewerCore}.test.ts` (6파일) | 〃 |

### 5.2 `CameraClient.listCameras()` 제거 (고아 정리)
- **근거**: `listCameras` 호출처는 `SimulatorSource`(뷰어 전용)뿐 — grep 결과 비뷰어 코드 0건. 뷰어 분리 후 SettingAgent 셋업은 `listCameras` 미사용 → **고아**.
- **조치**: `SettingAgent/src/clients/CameraClient.ts` 에서 `listCameras()` 메서드 삭제 + `import type { CameraList } from '../viewer/CameraSource.js'` 삭제(viewer 폴더 삭제로 깨지는 import 동시 제거 — CLAUDE.md 규칙 3 "내 변경으로 고아 된 import 제거").
- `requestImage`/`move`/`health`/`clampZoom` **시그니처 불변**(셋업·presetProvider·discover 무영향).

### 5.3 `toolsConfig.ts` 정리
- `ViewerSchema` 삭제, `CameraSourceConfigSchema`·`CameraSourceConfig` export 삭제.
- `ToolsConfigSchema` 에서 `viewer`·`cameraSources` 필드 삭제.
- `DEFAULT_TOOLS_CONFIG.viewer` 삭제.
- `loadToolsConfig` 의 `cameraSources` 명시 대입 1줄(`if (raw.cameraSources !== undefined) ...`) 삭제.
- 주의: `config.test.ts`(기존 81개 중) 가 viewer 기본값을 단언하면 회귀 → developer 가 해당 단언 라인도 정리(테스트가 viewer 를 검증 안 하면 무수정). **확인 필요 항목**(§아래 가정).

### 5.4 `server.ts` 정리
- `import type { CameraSource } from '../viewer/CameraSource.js'` 삭제.
- `import { registerViewerRoutes } from '../viewer/routes.js'` 삭제.
- `ApiDeps` 의 `viewer?`·`sources?` 필드 삭제.
- 말미 `if (deps.viewer?.enabled && deps.sources) { void registerViewerRoutes(...) }` 블록 삭제.
- **`/mapping` 라우트는 유지**(SettingViewer 프록시가 이걸 호출). 기존 setup/brain 라우트 불변.

### 5.5 `index.ts` 정리
- `import { buildSourceRegistry } from './viewer/sourceRegistry.js'` 삭제.
- `const sources = buildSourceRegistry(tools);` 삭제.
- `buildServer({...})` 인자에서 `viewer: tools.viewer, sources` 삭제.

### 5.6 `package.json` 정리
- `dependencies` 에서 **`@fastify/static` 제거**. grep 결과 SettingAgent src 내 유일 사용처는 `src/viewer/routes.ts`(삭제 대상) → 타 사용처 없음 → 안전 제거.

### 5.7 `config/tools.config.json` 정리
- `viewer` 섹션(50~56행) 삭제. `cameraSources` 는 원래 미기재 → 변경 없음.

---

## 6. 단계별 작업 순서 + 검증 기준

```
1. SettingViewer 스캐폴드: package.json·tsconfig.json·vitest.config.ts·폴더 생성
   → 검증: `cd SettingViewer && npm i` 성공, `npm run typecheck`(빈 src) 통과

2. viewerConfig.ts 신규 + config/viewer.config.json 작성
   → 검증: 노드 1회 로드 스모크(loadViewerConfig() 가 DEFAULT 와 파일 병합 반환), zod parse 통과

3. 파일 이동: src/viewer/*(5)·web/*(4)·test/*(6) → SettingViewer (git mv)
   → 검증: 파일 존재 확인. (아직 import 미보정이라 typecheck 실패 정상)

4. 복제: clients/CameraClient.ts(+로컬 CapturedImage)·util/http.ts(fetchWithTimeout)
   → 검증: CameraClient 가 ViewerConfig['camera']·로컬 CapturedImage·CameraList(viewer) 만 참조(SettingAgent 소스 import 0건 — grep `from '\.\./\.\./SettingAgent'` 및 `@parkagent` 0건)

5. import 경로 보정(§2.1 표): RealPtzSource·sourceRegistry·routes·테스트 5종
   → 검증: `npm run typecheck` 통과(SettingViewer 전체)

6. /mapping 프록시: src/server.ts(buildViewerServer)·src/index.ts·app.js 1줄 수정
   → 검증: mappingProxy.test.ts (200 패스스루/404/502) + 이동 테스트 전부 통과
   → `npm test` (SettingViewer) — 신규 57 + mappingProxy 케이스 그린

7. SettingAgent 정리(§5): viewer/web/test 삭제, listCameras 제거, toolsConfig·server·index·package·config 정리
   → 검증: `cd SettingAgent && npm run typecheck` 통과, `npm test` → **81 passed**(회귀 0)
   → grep `viewer`·`@fastify/static`·`listCameras` 가 SettingAgent src 에서 0건

8. 루트 워크스페이스 반영(§7): package.json workspaces 에 "SettingViewer" 추가
   → 검증: 루트 `npm i` 성공, 양쪽 typecheck/test 통과

9. 문서 이동/보정(§부록): 4개 문서 → SettingViewer/doc/, 경로 참조 보정
   → 검증: 이동 후 doc/ 4개 존재, 본문 'SettingAgent/src/viewer'·'SettingAgent/web'·'SettingAgent/docs' → SettingViewer 기준 표기 보정 완료

── 분리 종료 ──
```

각 단계 후 해당 `npm run typecheck` + 관련 test. 7·8단계 후 **양쪽 서비스 전체 그린**(SettingViewer 신규/SettingAgent 81).

---

## 7. 포트 / 실행 / 워크스페이스

- **포트**: SettingViewer 기본 **13030**(`config/viewer.config.json` server.port). SettingAgent 13020·Unity 13100 과 비충돌.
- **scripts**(SettingViewer/package.json):
  - `"start": "tsx src/index.ts"`, `"dev": "tsx watch src/index.ts"`
  - `"typecheck": "tsc -p tsconfig.json --noEmit"`, `"test": "vitest run"`, `"test:watch": "vitest"`
- **루트 워크스페이스**: `package.json` `workspaces` 에 `"SettingViewer"` **추가**.
  - 현재: `["packages/*", "SettingAgent"]` → `["packages/*", "SettingAgent", "SettingViewer"]`.
  - 근거: SettingAgent 가 이미 워크스페이스 멤버 → 동일 패턴. 단, SettingViewer 는 `@parkagent/types` 미의존(독립). 워크스페이스 포함은 **설치·스크립트 일원화** 목적만(소스 link 아님).
- **기동 순서**: ① SettingAgent(:13020) → ② SettingViewer(:13030). SettingAgent 미가동 시 `/viewer/api/mapping` 은 502 반환(ROI 미표시, 영상/PTZ 는 정상 — 카메라 소스는 SettingViewer 가 직접 호출).

---

## 8. 영향도 사전분석

| 대상 | 영향 | 판정 |
|------|------|------|
| SettingAgent 셋업 파이프라인(SetupOrchestrator/presetProvider/discover/mapTargets) | `CameraClient.requestImage/move/health/clampZoom` 시그니처 불변, `/mapping` 라우트 유지 | **무영향** |
| SettingAgent 기존 81 테스트 | 뷰어 테스트(57) 이동, config.test 의 viewer 단언만 정리(가정 확인) | **회귀 0 목표** |
| `@parkagent/types`·SetupArtifact | SettingViewer 가 import 안 함(로컬 CapturedImage), `/mapping` 은 JSON 패스스루 | **무영향** |
| ActionAgent / DMAgent | 뷰어와 무관 | **무영향** |
| 두 서비스 기동 순서 | SettingAgent 먼저(`/mapping` 제공) | 운영 문서화 필요(§7) |
| 포트 충돌 | 13030 신규(13020/13100 비충돌) | **없음** |
| CameraClient 코드 중복 | SettingAgent 잔존 + SettingViewer 복제 = 2벌 | 리스크 §9-1 |

---

## 9. 리스크 / 미확정

1. **CameraClient/http util 중복(2벌)**: SettingAgent 셋업이 원본을 계속 사용 → SettingViewer 는 복제본. 한쪽 버그 수정이 다른쪽에 자동 반영 안 됨. **완화**: SettingViewer 복제본은 뷰어가 쓰는 메서드(requestImage/move/health/clampZoom/listCameras)만 보유, 향후 공유 필요 시 `@parkagent/types` 류 패키지로 승격 검토(이번 범위 밖). 복제 사실을 SettingViewer doc 에 명시.
2. **두 서비스 동시 구동 운영**: 개발/배포 시 프로세스 2개. **완화**: README/문서에 기동 순서·포트 명시. 분리는 단순 2-프로세스(오케스트레이션 도구 도입 안 함 — 과설계 금지).
3. **문서 경로 보정 누락**: 이동 문서 4종 내 'SettingAgent/...' 참조 다수. **완화**: §부록 보정 항목 체크리스트화, 이동 후 grep `SettingAgent/(src/viewer|web|docs)` 로 잔존 확인.
4. **config.test.ts viewer 단언(가정)**: SettingAgent 기존 테스트가 `DEFAULT_TOOLS_CONFIG.viewer` 를 단언하는지 미확인 → developer 가 §5.3 정리 시 해당 테스트 동반 정리(없으면 무수정). **확인 필요**(아래).
5. **`/mapping` 프록시 CORS/콘텐츠**: 동일 출처(브라우저→SettingViewer)라 CORS 불필요. SetupArtifact 는 JSON → text 패스스루로 충분(Buffer/바이너리 아님). 리스크 낮음.

---

## 10. 미해결 / 가정 사항 (리더 확인 요청)

- **(가정 A)** `SettingAgent/test/config.test.ts`(또는 toolsConfig 테스트)가 `viewer` 기본값을 단언하면 §5.3 에서 동반 정리. 단언 안 하면 무수정. → developer 가 정리 단계에서 실제 확인 후 처리(외과적). **본 계획은 "viewer 단언이 있으면 제거" 로 진행 지시.**
- **(가정 B)** `/mapping` 프록시 경로를 `/viewer/api/mapping` 으로 통일(다른 뷰어 API 와 prefix 일관). 사용자 지시 다이어그램의 `/viewer/api/mapping` 과 일치 → 확정.
- **(가정 C)** 워크스페이스에 SettingViewer 포함하되 `@parkagent/types` 의존은 추가하지 않음(독립성 우선). 만약 추후 타입 공유가 필요하면 별도 라운드. → 본 분리에서는 **로컬 CapturedImage 정의**로 진행.
- 위 가정에 이견 없으면 developer 가 §6 순서대로 진행 가능.

---

## 부록. 문서 이동 + 경로 보정 체크리스트

### 이동 (→ `SettingViewer/doc/`, git mv)
| 원본 | 대상 |
|------|------|
| `SettingAgent/docs/20260625_170811_SettingViewer_웹뷰어_설계서.md` | `SettingViewer/doc/20260625_170811_SettingViewer_웹뷰어_설계서.md` |
| `SettingAgent/docs/20260625_182819_SettingViewer_구현문서.md` | `SettingViewer/doc/20260625_182819_SettingViewer_구현문서.md` |
| `SettingAgent/docs/20260625_182819_SettingViewer_영향도분석.md` | `SettingViewer/doc/20260625_182819_SettingViewer_영향도분석.md` |
| `Docs/20260625_081406_settingviewer_validation.md` | `SettingViewer/doc/20260625_081406_settingviewer_validation.md` |

### 경로 보정 항목(이동 문서 본문 내 — grep 후 일괄)
- `SettingAgent/src/viewer/` → `SettingViewer/src/viewer/`
- `SettingAgent/web/` → `SettingViewer/web/`
- `SettingAgent/test/{viewer 테스트}` → `SettingViewer/test/...`
- `SettingAgent/docs/...설계서.md` → `SettingViewer/doc/...`
- "SettingAgent(:13020)가 정적 SPA + 프록시 서빙" 류 서술 → "SettingViewer(:13030)가 서빙, ROI 는 SettingAgent(:13020)/mapping 프록시" 로 보정
- `src/config/toolsConfig.ts` 의 viewer/cameraSources 참조 → `src/config/viewerConfig.ts`
- `CameraClient.listCameras()`(SettingAgent 가산) 서술 → SettingViewer 복제본 메서드로 보정
- 접속 URL `http://localhost:13020/viewer/` → `http://localhost:13030/viewer/`
- 기동 순서/포트 절(節) 신설 또는 보정(SettingAgent 먼저 → SettingViewer)

> 보정은 **사실 정정 범위만**(분리 반영). 문서 재작성/확장 금지(외과적). 보정 완료 후 grep `SettingAgent/\(src/viewer\|web\)` 잔존 0건 확인.
