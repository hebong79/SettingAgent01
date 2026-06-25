# SettingViewer 웹 뷰어 — 구현 변경 요약 (02_developer_changes)

- 작성일: 2026-06-25
- 작성자: developer (ParkAgent 구현자)
- 기준: `01_architect_plan.md` (§10.1 1~10단계). 11단계(RTSP→WebRTC) 제외.
- typecheck: **통과**. 기존 vitest 81개 **전부 통과(회귀 없음)**.

---

## 1. 신규 파일 (서버 — `src/viewer/`)

| 파일 | 핵심 내용 | 공개 API |
|------|-----------|----------|
| `src/viewer/CameraSource.ts` | 소스 추상화 계약(타입만). `Ptz`/`CameraList`/`SnapshotResult`/`SnapshotOpts`/`CameraSource`. `login?`은 옵셔널(실 PTZ만 구현). | `interface CameraSource`, `Ptz`, `CameraList`, `SnapshotResult`, `SnapshotOpts` |
| `src/viewer/SimulatorSource.ts` | `CameraClient` 위임 래퍼. `kind='sim'`. snapshot: manual 시 PTZ override 동봉, preset 시 미동봉. 단위변환 **항등**. | `class SimulatorSource implements CameraSource` |
| `src/viewer/RealPtzSource.ts` | Hucoms CGI 어댑터. `kind='hucoms'`. login 세션(메모리 통과), snapshot/move, 선형 PTZ 단위매핑(왕복 일치). CGI 경로/범위 **상수 분리**(`HUCOMS_*`, 실측 보정 표시). | `class RealPtzSource implements CameraSource` |
| `src/viewer/sourceRegistry.ts` | `cameraSources` → `Map<id, CameraSource>`. 미설정 시 `camera`(단일 sim) `id='sim'` 폴백(하위호환). | `buildSourceRegistry(tools): Map<string, CameraSource>` |
| `src/viewer/routes.ts` | `/viewer/api/*` 5개 라우트 + zod + `@fastify/static`. 등록 순서: API 먼저 → static 나중. `/viewer`→`/viewer/` 302. | `registerViewerRoutes(app, { sources, viewer }): Promise<void>` |

### 라우트 동작(스모크 inject 확인)
- `GET /viewer/api/cameras` → 200 `CameraList` JSON.
- `GET /viewer/api/snapshot` → 200 `image/jpeg` 바이너리 + `X-PTZ-Pan/Tilt/Zoom` + `Cache-Control: no-store`. mode 분기(preset/manual) 동작.
- `POST /viewer/api/move` → `{ok}`. `allowMove=false` → **403**. `controlToken` 설정 시 `X-Viewer-Token` 불일치 → **403**. zoom 클램프(99→36).
- `POST /viewer/api/camera/login` → sim 소스는 `400 {error:'login unsupported'}`. 응답 body에 자격증명 **미노출**(확인됨).
- `GET /viewer/api/health` → `{status:'ok', sources:[...]}`.
- `GET /viewer/index.html|app.js|app.css|core.js` → 200(text/html, application/javascript, text/css). `/viewer/`→index.html. `/viewer`→302.

## 2. 신규 파일 (프런트 — `web/`)

| 파일 | 내용 |
|------|------|
| `web/core.js` | **순수 로직(테스트 대상, DOM/fetch 비참조)**: `toPixel`, `presetKey`, `slotLabel`, `fpsToInterval`, `clampZoom`, `stepPtz`, `createStreamLoop`. |
| `web/app.js` | DOM 결선·이벤트·스트림 오케스트레이션(환경 의존). `core.js` import. 자격증명은 POST body로만(URL 미노출), 로그인 후 pass 필드 클리어. |
| `web/index.html` | SPA 진입점. 탭2개, `.viewport>img+canvas`, 제어 패널. `<script type="module" src="./app.js">`. |
| `web/app.css` | 레이아웃 + letterbox 오차 방지 CSS(`.viewport` inline-block, `object-fit` 미사용). |

### 테스트 대상 순수 함수(`web/core.js`) — 검증자 인계
- `toPixel(rect, imgW, imgH)` → `{px,py,pw,ph}` (G2)
- `presetKey(camIdx, presetIdx)` → `"cam:preset"`
- `slotLabel(slotId, globalIndex)` → globalIdx 매칭 / slotId 폴백 (G3-4 라벨 매핑)
- `fpsToInterval(fps)` → `Math.round(1000/fps)`
- `clampZoom(z, min=1, max=36)`
- `stepPtz(cur, dir, step)` → 절대 PTZ 환산(zoom ±1 클램프)
- `createStreamLoop(deps)` → `{start, stop, tick}`. **백프레셔(inflight 가드), 이전 Blob URL revoke, stop 시 timer 해제+abort**. 의존성 주입형(`fetchFn/makeUrl/createObjectURL/revokeObjectURL/setImage/onPtz`, 옵션 `setTimer/clearTimer`로 fake timer 주입 가능).

## 3. 수정 파일 (가산적, 기존 시그니처 불변)

| 파일 | 변경 |
|------|------|
| `src/clients/CameraClient.ts` | `listCameras(): Promise<CameraList>` 추가(GET /cameras, A타입 파싱). `import type { CameraList }` 추가. **기존 requestImage/move/health/clampZoom 시그니처 불변**. |
| `src/config/toolsConfig.ts` | `ViewerSchema`·`CameraSourceConfigSchema`(+ `CameraSourceConfig` 타입 export) 추가. `ToolsConfigSchema`에 `viewer`(필수, 기본값 제공)·`cameraSources`(옵셔널) 추가. `DEFAULT_TOOLS_CONFIG.viewer` 추가. 로더에 `cameraSources` 명시 대입 1줄(병합 루프 뒤). |
| `src/api/server.ts` | `ApiDeps`에 `viewer?`·`sources?` 추가. `/mapping` 뒤에서 `viewer.enabled && sources` 일 때 `registerViewerRoutes` 호출. 기존 라우트 불변. |
| `src/index.ts` | `buildSourceRegistry(tools)` → `buildServer`에 `viewer`/`sources` 주입(2줄). |
| `package.json` | `dependencies`에 `@fastify/static@^9.0.0`(설치본 9.1.3, fastify 5.x 호환). |
| `config/tools.config.json` | `viewer` 섹션 추가. `cameraSources` 미기재(sim 단일 폴백 = 기존 동작 보존). |

## 4. 설계 결함/충돌 — 없음 (경미 사항만)

- **`buildServer` 동기 유지**: `registerViewerRoutes`는 async(@fastify/static 등록 await)이지만, Fastify가 플러그인/라우트를 큐잉하므로 `void registerViewerRoutes(...)`로 호출해도 `app.ready()`/`listen()` 시점에 순서대로 등록·완료된다. inject 스모크로 API→static 우선순위·정적 서빙 모두 확인. → `buildServer`를 async로 바꿔 index.ts/테스트로 파급시키지 않음(외과적).
- **`/viewer` 트레일링 슬래시**: `@fastify/static`의 `redirect:true`는 `/viewer/`(디렉터리)만 index 매핑하고 bare `/viewer`는 404였음 → 계획 §3.3 step3 충족 위해 `app.get('/viewer', → reply.redirect('/viewer/'))` 명시 추가(302).

## 5. 미해결 / 실측 보정 필요 항목

1. **Hucoms CGI 실제 경로/파라미터/원시 범위 미상**(설계서 §13.6). `RealPtzSource` 상단 `HUCOMS_LOGIN_PATH`/`HUCOMS_SNAPSHOT_PATH`/`HUCOMS_PTZ_PATH`/`HUCOMS_PTZ_PARAMS` + 기본 범위 상수로 흡수. **실기기(192.168.0.153, HNR-2036LA) 연결 후 보정** 필요. 단위테스트는 CGI 모킹 전제.
2. **세션 추출 방식 가정**: login 응답의 `set-cookie` 또는 토큰 — 실기기 응답 확인 후 보정(현재 cookie 헤더 폴백).
3. **뷰어 PTZ 단위 가정**: pan `[-180,180]`·tilt `[-90,90]`·zoom `[1,36]`(상수). Unity 시뮬레이터(sim)는 항등이라 무관, 실 PTZ 매핑 기준값은 실측 후 조정.
4. **`X-PTZ-*` manual 모드 값**: Unity `/req_img`가 override PTZ를 응답에 반영하는지(해석 A 전제). 12단계 실서버 동작확인에서 검증.
5. **소스 kind 노출**: 프런트는 소스 kind를 모름(health는 id만 반환) → login 박스를 항상 노출하고 sim이면 서버가 400 반환. 필요 시 health에 kind 추가 검토(이번 범위 밖).

## 6. 검증자(qa-tester) 인계 — 테스트 포인트

1. `cameraClientList.test.ts`: `globalThis.fetch` mock A타입 응답 → `listCameras()` 파싱(enabled=false 보존, presets 매핑, label/name 폴백).
2. `simulatorSource.test.ts`: snapshot(preset→PTZ 미동봉 / manual→PTZ 동봉) 위임, move 인자, list 위임, 항등 변환.
3. `viewerRoutes.test.ts`: `fastify.inject` — cameras/snapshot(content-type·X-PTZ-*·no-store)/move(403 allowMove=false, 403 token 불일치, zoom 클램프)/login(자격증명 미노출), 라우트 우선순위(API>static), 400 zod.
4. `realPtzSource.test.ts`: CGI 모킹 — login 세션, snapshot image/jpeg, move 원시단위, `toNativePtz`/`fromNativePtz` 왕복 일치, 자격증명이 mock 호출 URL에 평문 미포함.
5. `sourceRegistry.test.ts`: 미설정→sim 1개(id='sim'), 다중소스(sim+hucoms) 선택.
6. `viewerCore.test.ts`(`web/core.js`): toPixel/presetKey/slotLabel/fpsToInterval/clampZoom/stepPtz 단위 + `createStreamLoop` 백프레셔·revoke·stop(fake timers, mock 주입).

> vitest.config.ts include는 `test/**/*.test.ts`. `viewerCore.test.ts`는 `../web/core.js`를 직접 import(순수 ESM, 브라우저 API 불필요).
