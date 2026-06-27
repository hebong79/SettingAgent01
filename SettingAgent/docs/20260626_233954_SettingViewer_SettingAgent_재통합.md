# SettingViewer → SettingAgent 재통합 (단일 프로세스 + viewer.enabled 토글)

작성: 2026-06-26 23:39:54 · 작성자: documenter · 대상: SettingAgent · 분류: 리팩토링(서비스 통합, 신규 기능 없음)

입력 산출물: `_workspace/01_architect_plan.md`(설계) · `_workspace/02_developer_changes.md`(구현) · `_workspace/03_qa_report.md`(검증) · 실제 변경 코드.

---

## 1. 배경 — 왜 다시 합쳤나

웹 뷰어는 한 차례 SettingAgent(:13020)에서 **독립 서비스 SettingViewer(:13030)** 로 분리되었다(이력: `docs/20260625_195152_SettingViewer_독립서비스_분리.md`). 이번 작업은 그 분리를 **되돌려** SettingAgent 단일 프로세스로 재통합한다. 결정 사유는 셋이다.

1. **운영 마찰 제거**: 두 서비스(2 포트·2 기동·기동 순서 의존)를 띄우고 유지해야 했다. 통합으로 `npm run start` 1회·포트 1개(:13020)로 단순화.
2. **중복 제거**: SettingViewer 는 `CameraClient`·`util/http.ts` 의 **복제본**과 `viewerConfig.ts`(설정 복제)를 들고 있었다. 동일 로직 2벌은 표류(drift) 위험. 단일 출처로 일원화.
3. **프록시 1홉 제거**: SettingViewer 는 `/viewer/api/mapping`·`/viewer/api/capture/*` 를 SettingAgent 로 **HTTP 자기 전달(프록시)** 했다. `/mapping`·`/capture/*` 는 이미 SettingAgent 안에 있으므로, 같은 프로세스가 자기 자신에게 HTTP 요청(1홉·타임아웃·502 분기)을 보낼 이유가 없다.

**헤드리스 보존**: 통합하되 순수 에이전트(뷰어 없는 헤드리스)로도 돌 수 있어야 한다. 이를 위해 `viewer.enabled` 토글을 둔다 — `false` 면 뷰어 라우트·정적 서빙을 **아예 등록하지 않는다**.

---

## 2. Before / After 아키텍처

### Before — 2 서비스

```
[브라우저] → SettingViewer (:13030)               SettingAgent (:13020)
              ├ 정적 SPA(web/*)
              ├ /viewer/api/cameras|snapshot|move|login|health   ← CameraSource 직접
              ├ /viewer/api/mapping     ──(HTTP 프록시)──→  GET /mapping (repo.loadArtifact)
              └ /viewer/api/capture/*   ──(HTTP 프록시)──→  /capture/*
              (CameraClient 복제본 / util/http 복제본 / viewerConfig 복제)
```

기동: SettingAgent 먼저 → SettingViewer 가 `settingAgentUrl` 로 프록시. 포트 2개.

### After — 단일 프로세스 + 토글

```
[브라우저] → SettingAgent (:13020)
              ├ /health, /setup/*, /mapping, /capture/*        (기존, 불변)
              └ viewer.enabled === true 일 때만 register:
                  ├ 정적 SPA(web/*)  @fastify/static  prefix=/viewer/
                  ├ /viewer/api/cameras|snapshot|move|login|health  ← CameraSource 직접(이식)
                  ├ /viewer/api/mapping   → repo.loadArtifact() 직접 읽기(프록시 폐기)
                  └ (capture 프록시 없음 — SPA 가 /capture/* 를 직접 호출)
              (CameraClient·util/http·설정 단일 출처)
```

기동: `npm run start` 1회. 포트 1개(:13020). `viewer.enabled=false` → 위 블록 전체 미등록(헤드리스).

---

## 3. 이동 / 병합 / 삭제 내역

### 3-1. 이동(SettingViewer → SettingAgent, 내용 동일 · import 경로만 보정)

| 원본 | 대상 | 보정 |
|------|------|------|
| `src/viewer/CameraSource.ts` | `SettingAgent/src/viewer/CameraSource.ts` | 무수정(`CameraList` 타입 정의 동반 이동) |
| `src/viewer/SimulatorSource.ts` | 동일 | 무수정(`../clients/CameraClient.js` 경로 동일) |
| `src/viewer/RealPtzSource.ts` | 동일 | `CameraSourceConfig` import 출처 `../config/viewerConfig.js` → `../config/toolsConfig.js` |
| `src/viewer/sourceRegistry.ts` | 동일 | 시그니처 `buildSourceRegistry(cfg: ViewerConfig)` → `Pick<ToolsConfig,'camera'\|'cameraSources'>` (본문 로직 불변) |
| `src/viewer/routes.ts` | 동일 | `ViewerConfig['viewer']` → `ToolsConfig['viewer']` (라우트 로직 불변) |
| `web/*` (index.html·app.js·app.css·core.js·core.d.ts) | `SettingAgent/web/*` | app.js 만 capture 4줄 수정(§4) |
| `doc/*.md`(7개) | `SettingAgent/docs/` | 이력 보존(파일명 유지) |
| `test/*`(11개) | `SettingAgent/test/` | import/타입 경로 보정(§5 검증) |

### 3-2. 병합(중복 → SettingAgent 단일)

| 병합 대상 | 결과 |
|-----------|------|
| `viewerConfig.ts` 의 `ViewerSchema`·`CameraSourceConfigSchema` | `toolsConfig.ts` 로 흡수(§3-3) |
| SettingViewer `CameraClient.ts`(복제본) | SettingAgent `CameraClient.ts` 에 `listCameras()` 만 가산(나머지는 이미 동일) |
| SettingViewer `util/http.ts`(부분집합) | SettingAgent `util/http.ts`(상위집합) 사용 — 복제본 미이동 |

### 3-3. 삭제(이동·병합 완료 후)

| 삭제 대상 | 사유 |
|-----------|------|
| `SettingViewer/src/server.ts`(`buildViewerServer`) | 프록시 폐기·buildServer 통합 |
| `SettingViewer/src/index.ts` | SettingAgent 단일 부트스트랩 |
| `SettingViewer/src/clients/CameraClient.ts` | SettingAgent 로 일원화 |
| `SettingViewer/src/util/http.ts` | SettingAgent 상위집합 사용 |
| `SettingViewer/src/config/viewerConfig.ts` | toolsConfig 로 병합 |
| `SettingViewer/test/mappingProxy.test.ts`·`captureProxy.test.ts` | 프록시 소멸 → 대체/삭제(§5) |
| `setviewer.bat` | 통합으로 무의미(`setagent.bat` 가 뷰어까지 서빙) |
| `SettingViewer/` 폴더 전체 | 소스·doc 이관 후 제거(추적 파일 0, 잔여는 §6) |

루트 `package.json` workspaces 도 `["packages/*","SettingAgent","SettingViewer"]` → `["packages/*","SettingAgent"]` 로 축소. `@fastify/static@^9.0.0` 는 SettingAgent `dependencies` 로 정식 편입.

---

## 4. 프록시 제거 결정 + app.js 수정점

### 4-1. `/viewer/api/mapping` → 직접 읽기로 대체

`buildViewerServer` 의 HTTP 프록시를 폐기하고, `buildServer` 안에서 `deps.repo.loadArtifact()` 를 **직접** 반환한다(`src/api/server.ts` L204–216).

```ts
instance.get('/viewer/api/mapping', async (_req, reply) => {
  const artifact = deps.repo.loadArtifact();
  if (!artifact) { reply.code(404); return { error: 'no setup artifact' }; }
  return artifact;
});
```

- 산출물 있음 → 200 패스스루, 없음 → 404 `{error:'no setup artifact'}`. **404 동작은 기존 프록시와 동일**하게 보존.
- 경로(`/viewer/api/mapping`)가 그대로라 **SPA(app.js) 무수정**.
- 자기호출의 1홉·5s 타임아웃·502 분기는 소멸.

### 4-2. `/viewer/api/capture/*` → 폐기, SPA 가 `/capture/*` 직접 호출

capture 프록시 alias 를 **만들지 않는다**. 대신 SPA 가 동일 origin(`http://localhost:13020`)의 `/capture/*` 를 직접 호출한다. alias 라우트를 신설하면 동일 핸들러를 두 경로에 매다는 중복이 되므로, "중복 제거" 목표에 맞춰 SPA 호출 경로만 4줄 외과 수정.

**app.js 수정점(4줄)** — `const api=(p)=>`/viewer/api${p}`` 정의는 유지하되, capture 호출만 접두 제거:

| 함수(위치) | 변경 전 | 변경 후 |
|-----------|---------|---------|
| `capFetchStatus`(L262) | `fetch(api('/capture/status'))` | `fetch('/capture/status')` |
| `capStart`(L301) | `fetch(api('/capture/start'), …)` | `fetch('/capture/start', …)` |
| `capStop`(L312) | `fetch(api('/capture/stop'), …)` | `fetch('/capture/stop', …)` |
| `capFinalize`(L319) | `fetch(api('/capture/finalize'), …)` | `fetch('/capture/finalize', …)` |

> `runs`/`aggregate` 는 app.js 가 호출하지 않으므로 4줄로 충분.

### 4-3. 카메라 라우트는 그대로 이식

`/viewer/api/{cameras,snapshot,move,camera/login,health}` 는 원래도 프록시가 아니라 `CameraSource` 직접 호출이었다. `registerViewerRoutes` 를 그대로 이식하고 SettingAgent 조립부에서 `sources` 만 주입한다. app.js 의 해당 호출은 `/viewer/api` 접두 유지(무수정).

### 4-4. async 처리 — buildServer 동기 유지(register 래핑)

`registerViewerRoutes` 는 내부에서 `@fastify/static` 을 `await register` 한다(async). 기존 156개 테스트가 `buildServer({...})` 를 **동기 호출** 후 즉시 `app.inject()` 하므로, `buildServer` 를 async 화하면 전 호출처에 `await` 보정이 필요해진다. 이를 피하려고 뷰어 블록을 `app.register(async (instance) => { … await registerViewerRoutes(instance, …) })` 로 감싸 **buildServer 의 동기 시그니처를 유지**했다. `app.inject()` 가 내부적으로 `app.ready()` 를 호출해 plugin(정적 라우트) 등록을 보장하므로 inject 테스트에서 정적 404 위험은 없다(테스트로 실증됨).

---

## 5. 설정·실행·접속

### 5-1. 설정 — `viewer` + `cameraSources`

`tools.config.json`(및 `DEFAULT_TOOLS_CONFIG`)에 `viewer` 섹션 추가:

```json
"viewer": { "enabled": true, "allowMove": true, "defaultFps": 3, "staticDir": "web", "controlToken": "" }
```

| 키 | 의미 |
|----|------|
| `enabled` | 뷰어 라우트·정적 서빙 등록 여부. `false` = 헤드리스(순수 에이전트) |
| `allowMove` | PTZ 이동(`/viewer/api/move`) 허용 |
| `defaultFps` | 스냅샷 폴링 기본 FPS |
| `staticDir` | 정적 SPA 루트(기본 `web`) |
| `controlToken` | 제어 토큰(빈 문자열=미사용) |

`cameraSources`(옵셔널 배열)는 미기재 시 단일 `sim` 으로 폴백(`camera.baseUrl` 사용 = 기존 단일 시뮬레이터 동작). 실 PTZ(`hucoms`) 사용 시에만 항목 추가.

**병합 주의**: `loadToolsConfig` 는 `Object.keys(DEFAULT)` 로 **객체 섹션 단위 spread 병합**한다. `viewer` 는 객체라 그대로 동작하나, `cameraSources` 는 DEFAULT 에 없는 옵셔널 **배열**이라 순회에서 누락된다. 따라서 `if (raw.cameraSources !== undefined) merged.cameraSources = raw.cameraSources;` 패스스루 한 줄을 명시 추가했다(`toolsConfig.ts` L202–203).

### 5-2. viewer.enabled on/off 동작

| 상태 | `/viewer/*`·정적 SPA | `/health`·`/setup/*`·`/mapping`·`/capture/*` |
|------|----------------------|-----------------------------------------------|
| `enabled=true`(기본) | 등록(SPA 200, `/viewer/api/*` 동작) | 정상(불변) |
| `enabled=false`(헤드리스) | **미등록**(SPA·`/viewer/api/*` 404) | 정상(불변) |

`index.ts` 가 `enabled` 일 때만 `buildSourceRegistry(tools)` 로 `sources` 를 빌드하고, `server.ts` 가 `if (deps.viewer?.enabled && deps.sources)` 이중 가드로 등록한다.

### 5-3. 실행 / 접속

```bash
cd SettingAgent
npm run start                       # REST :13020 (뷰어 포함)
# 브라우저: http://localhost:13020/viewer/
```

- SettingViewer 서비스(:13030)·`setviewer.bat` 는 **폐지**. 기동 순서 의존 소멸.
- 헤드리스로 돌리려면 `tools.config.json` 의 `viewer.enabled=false`.

---

## 6. 테스트 결과 (검증자 03 리포트 인용)

| 항목 | 결과 |
|------|------|
| `npm run typecheck` | 오류 0 |
| `npm test`(vitest) | **Test Files 36 passed (36) / Tests 239 passed (239)**, Duration 2.12s, **회귀 0** |
| 신규/대체 | `mappingDirect.test.ts`(2)·`viewerEnabled.test.ts`(2) ✓ |
| 이관 | viewerRoutes(14)·cameraClientList(6)·realPtzSource(8)·sourceRegistry(4)·simulatorSource(6)·viewerCore(19)·analyzeArtifact(5)·findPresetPtz(4)·panelResize(4)·captureCore(9) 전부 ✓ |
| 삭제 확인 | `mappingProxy.test.ts`·`captureProxy.test.ts` 부재 ✓ |

통합 전 SettingAgent 단독 25 파일 → 통합 후 36 파일(이관 11 + 신규 2 − 삭제 2 = +11).

**대체/삭제/신규 테스트 의도**:
- `mappingProxy.test.ts` → `mappingDirect.test.ts`: upstream HTTP stub 무의미 → repo 스텁으로 `/viewer/api/mapping` 의 200 패스스루·404 검증. 502/타임아웃 케이스는 자기호출 제거로 소멸.
- `captureProxy.test.ts` → 삭제: 프록시 alias 없음 → `/capture/*` 동작은 기존 `captureRoutes.test.ts` 가 커버.
- `viewerEnabled.test.ts`(신규): `enabled=false`→`/viewer/api/health` 404 + `/health`(루트)·`/setup/status` 정상(헤드리스), `enabled=true`→`/viewer/api/health` 200(`{status:'ok',sources:['sim']}`) + 경로 충돌 없음.

### 미커버(사실 그대로 — 미검증)

1. **라이브 기동(`npm start`) 미수행** — 포트 13020 점유 가능성으로 inject(fastify.inject)만 사용. 실제 `listen()` 후 `/viewer/`(SPA HTML 200)·정적 자산 서빙은 별도 스모크 필요.
2. **브라우저 DOM 동작 미커버** — 카메라 선택/스냅샷 렌더/PTZ 이동/프리셋 이동(gotoPreset)/정밀수집 탭/분석 탭의 실제 DOM·fetch 왕복은 `web/core.js` 순수 로직 단위테스트로만 부분 커버. 엔드투엔드 브라우저 검증은 범위 외.
3. **실 PTZ(HNR-2036LA) 스모크 미수행** — `RealPtzSource` 의 CGI/PTZ 범위는 미확인 가정값. `realPtzSource.test.ts`(8)는 모킹 기반. 실 장비 연결 후 실측 보정 필요.
4. **`SettingViewer/` 빈 폴더 잔존** — `git ls-files SettingViewer`=0·작업트리 파일 0 이나 디렉터리 핸들 잠금(다른 프로세스 cwd 점유 추정)으로 빈 폴더 자체 삭제 실패. git 추적상 영향 없음. 프로세스 종료 후 `Remove-Item -Recurse -Force SettingViewer` 1회 필요.

---

## 7. 변경/신규 요소 요약

| 요소 | 종류 | 설명 |
|------|------|------|
| `CameraClient.listCameras()` | 메서드 가산 | `GET /cameras`(A타입) 파싱. `name ?? 'C{idx}'`·`label ?? 'C{idx}-P{idx}'` 폴백, `enabled !== false` 보존, presets 중첩 PTZ 보존. `CameraList` 출처 `../viewer/CameraSource.js` |
| `ViewerSchema`·`CameraSourceConfigSchema` | 스키마 가산 | toolsConfig 로 흡수. `CameraSourceConfig` export |
| `loadToolsConfig` cameraSources 패스스루 | 로직 가산 | 옵셔널 배열 병합 누락 보정 1줄 |
| `ApiDeps.viewer?`·`sources?` | 타입 가산(옵셔널) | 기존 호출처 무영향 |
| `buildServer` 뷰어 블록 | 로직 가산 | `app.register` 래핑, 이중 가드, `/viewer/api/mapping` 직접 읽기 + `registerViewerRoutes` |
| `buildSourceRegistry(tools)` 주입 | 조립 가산 | `index.ts`, `enabled` 일 때만 빌드 |
| `src/viewer/*`(5)·`web/*`(5) | 이식 | 내용 동일, import 경로만 보정 |

상세 영향도는 동반 문서 `20260626_233954_SettingViewer_재통합_영향도분석.md` 참조.
