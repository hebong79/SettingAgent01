# SettingViewer 웹 뷰어 — 구현 계획 (01_architect_plan)

- 작성일: 2026-06-25
- 작성자: architect (ParkAgent 설계자)
- 기준 문서(single source of truth): `SettingAgent/docs/20260625_170811_SettingViewer_웹뷰어_설계서.md` (rev3)
- 구현 범위: 설계서 §10.1 **1~10단계** (11단계 RTSP→WebRTC 제외)
- 구현자(developer)는 이 문서를 그대로 따라 코딩한다. 과설계 금지 — 설계서 범위 밖 추상화/기능 추가 금지.

---

## 0. 핵심 결정 요약 (설계서 §11 확정 사항 반영)

| 항목 | 결정 |
|------|------|
| 프런트 스택 | 빌드리스 바닐라 ESM + Canvas (번들러 없음) |
| 정적 서빙 | `@fastify/static` (신규 의존성 1개), `SettingAgent/web/` |
| 단일 출처 프록시 | 브라우저는 `:13020`(SettingAgent)만 호출. 카메라 주소는 서버만 보유 |
| 수동 라이브 | `/req_img {cam,preset,pan,tilt,zoom}` PTZ override 연속 폴링 (해석 A 확정) |
| 영상 | 스냅샷 폴링 ≈3fps, 프록시가 base64→`image/jpeg` 바이너리 변환 |
| 보안 | `viewer.allowMove`(기본 true), `controlToken`(선택). 실카메라 자격증명은 UI 입력→프록시 통과(서버 영구저장 금지) |
| 소스 추상화 | `CameraSource` 인터페이스 + `SimulatorSource`(기존 CameraClient 래핑) + `RealPtzSource`(Hucoms CGI) |

### MCP 도구 vs LLM 두뇌 경계
- **전부 결정형(도구) 영역**. 뷰어는 스냅샷 폴링·좌표변환·PTZ 절대이동 등 **수치/REST 반복**만 수행한다. LLM 두뇌 호출 없음(셋업 검토는 기존 `/brain/*`가 담당, 뷰어 범위 밖).
- 따라서 신규 코드는 전부 ParkSimMgr 결정형 컨벤션(타임아웃·zod·1-based 인덱스)을 따른다.

---

## 1. 파일별 변경/신규 목록

### 신규 — 서버 소스 (`SettingAgent/src/viewer/`)
| 파일 | 구분 | 핵심 책임 |
|------|------|-----------|
| `src/viewer/CameraSource.ts` | 신규 | `CameraSource` 인터페이스 + 공유 타입(`Ptz`, `CameraList`, `SnapshotResult`) 정의. 구현체 없음(계약만). |
| `src/viewer/SimulatorSource.ts` | 신규 | `SimulatorSource implements CameraSource`. 기존 `CameraClient` 위임(snapshot=requestImage, move, list=listCameras). 단위변환 항등. `kind='sim'`. |
| `src/viewer/RealPtzSource.ts` | 신규 | `RealPtzSource implements CameraSource`(Hucoms CGI). login.cgi 세션·snapshot·move. CGI 경로/원시단위 범위는 **상수로 분리**(파일 상단 `HUCOMS_*` 상수 블록). `kind='hucoms'`. |
| `src/viewer/sourceRegistry.ts` | 신규 | `cameraSources[]` 설정 → `Map<sourceId, CameraSource>` 빌드. 하위호환: `cameraSources` 미설정 시 `camera`(단일 sim) 1개 등록. |
| `src/viewer/routes.ts` | 신규 | `registerViewerRoutes(app, deps)` — `/viewer/api/*` 5개 라우트 + zod 스키마 + `@fastify/static` 등록(순서 보장). |

### 신규 — 프런트 (`SettingAgent/web/`)
| 파일 | 구분 | 핵심 책임 |
|------|------|-----------|
| `web/index.html` | 신규 | SPA 진입점. 탭2개(제어·모니터링/주차면 검수), `.viewport>img+canvas`, 제어 패널 마크업. `<script type="module" src="./app.js">`. |
| `web/app.css` | 신규 | 레이아웃(좌 뷰포트+우 패널). letterbox 오차 방지 CSS(§5.2): `.viewport{position:relative;display:inline-block} img{display:block;max-width:100%} canvas{position:absolute;left:0;top:0;pointer-events:none}`. |
| `web/app.js` | 신규 | DOM 결선·이벤트·스트림 루프 오케스트레이션(환경 의존). 순수 로직은 `core.js`에서 import. |
| `web/core.js` | 신규 | **환경 비의존 순수 함수 모듈**(테스트 대상): `toPixel`, `presetKey`, `slotLabel`(slotId→globalIdx+폴백), `fpsToInterval`, `clampZoom`, `stepPtz`. DOM/fetch 미참조. |

> `web/core.js`는 vitest가 직접 import(브라우저 API 불필요). `web/app.js`는 jsdom 없이도 테스트 가능하도록, 폴링 루프 핵심(백프레셔/revoke/stop)을 **주입형 팩토리 함수**(`createStreamLoop({fetch, createObjectURL, revokeObjectURL, setImage})`)로 `core.js`에 두고 app.js는 실제 의존성만 주입한다.

### 수정 — 기존 서버 소스
| 파일 | 구분 | 변경 내용 |
|------|------|-----------|
| `src/clients/CameraClient.ts` | 수정(가산) | `listCameras(): Promise<CameraList>` 메서드 추가. 기존 `requestImage/move/health/clampZoom` **시그니처 불변**. |
| `src/config/toolsConfig.ts` | 수정(가산) | `viewer` 섹션 + `cameraSources` 옵셔널 스키마/기본값 추가. 기존 섹션 불변. |
| `src/api/server.ts` | 수정(가산) | `ApiDeps`에 `viewer`·`sources`(또는 `cameraSources` 설정) 추가, `registerViewerRoutes(app, ...)` 호출(`viewer.enabled`일 때만). 기존 라우트 불변. |
| `src/index.ts` | 수정(가산) | `buildSourceRegistry(tools)` → `buildServer`에 주입. `@fastify/static`은 routes.ts 내부 등록이라 index 변경 최소. |
| `package.json` | 수정 | `dependencies`에 `@fastify/static` 추가. |
| `config/tools.config.json` | 수정(가산) | `viewer` 섹션 추가(`cameraSources`는 하위호환 위해 미기재 — sim 단일 폴백). |

### 신규 — 테스트 (`SettingAgent/test/`)
| 파일 | 대상 |
|------|------|
| `test/cameraClientList.test.ts` | `CameraClient.listCameras()` mock 응답 파싱(2단계). |
| `test/viewerRoutes.test.ts` | `fastify.inject`로 `/viewer/api/*` 라우트·상태코드·헤더 검증(3·4단계, allowMove 403). |
| `test/simulatorSource.test.ts` | `SimulatorSource` 위임(snapshot/move/list)·항등 변환(1단계). |
| `test/realPtzSource.test.ts` | `RealPtzSource` Hucoms CGI 모킹(login 세션·snapshot·move·단위매핑 왕복·자격증명 미노출)(9단계). |
| `test/sourceRegistry.test.ts` | `cameraSources` 파싱·하위호환(미설정→sim 1개)·소스 선택(10단계). |
| `test/viewerCore.test.ts` | 프런트 순수 로직: `toPixel`/`presetKey`/`slotLabel`/`fpsToInterval`/`createStreamLoop`(백프레셔·revoke·stop)(6·7·8단계, G2·G3). |

---

## 2. `CameraSource` 인터페이스 시그니처 (설계서 §13.2 확정)

`src/viewer/CameraSource.ts`:
```ts
export interface Ptz { pan: number; tilt: number; zoom: number; }

/** /viewer/api/cameras 응답(A타입 그대로). presetProvider.ts 의 UnityCamerasResponse 와 동일 형태. */
export interface CameraList {
  cameras: Array<{
    camIdx: number;
    name: string;
    enabled: boolean;
    presets: Array<{ presetIdx: number; label: string; pan?: number; tilt?: number; zoom?: number }>;
  }>;
}

export interface SnapshotResult { jpeg: Buffer; ptz: Ptz; }

export interface SnapshotOpts {
  presetIdx?: number;
  ptz?: Ptz;
  mode: 'preset' | 'manual';
}

export interface CameraSource {
  readonly kind: 'sim' | 'hucoms';            // (onvif 는 후속, 이번 범위 제외)
  listCameras(): Promise<CameraList>;
  snapshot(cam: number, opt: SnapshotOpts): Promise<SnapshotResult>;
  move(cam: number, ptz: Ptz): Promise<boolean>;
  streamUrl?(cam: number): string | null;     // 이번 라운드 미사용(11단계용 선택 시그니처만)
  toNativePtz(viewerPtz: Ptz): unknown;        // 뷰어 단위 → 소스 원시 단위
  fromNativePtz(native: unknown): Ptz;         // 소스 원시 단위 → 뷰어 단위
}
```

### 책임 분해
- **`SimulatorSource`** (`kind='sim'`)
  - 생성자: `constructor(private camera: CameraClient)` — 기존 CameraClient 재사용.
  - `listCameras()` → `camera.listCameras()`.
  - `snapshot(cam, opt)`:
    - `mode==='preset'` → `camera.requestImage(cam, opt.presetIdx!)` (PTZ 미동봉).
    - `mode==='manual'` → `camera.requestImage(cam, opt.presetIdx!, opt.ptz)` (PTZ override 동봉).
    - 반환: `{ jpeg: captured.jpg, ptz: {pan,tilt,zoom} }`.
  - `move(cam, ptz)` → `camera.move(cam, ptz.pan, ptz.tilt, ptz.zoom)`.
  - `toNativePtz`/`fromNativePtz` = **항등**(`(p)=>p`).
- **`RealPtzSource`** (`kind='hucoms'`)
  - 생성자: `constructor(private cfg: CameraSourceConfig)` (host/port/loginPath/snapshotUrl/ptz 범위).
  - 내부 세션 상태: `private session: string | null`(쿠키/토큰). `login(user, pass)` 메서드로 갱신, 만료 시 재로그인.
  - `snapshot(cam, opt)` → 인증 세션으로 `snapshotUrl` GET → JPEG Buffer + 현재 PTZ(가능 시 CGI 조회, 없으면 마지막 명령 PTZ 반환).
  - `move(cam, ptz)` → `toNativePtz(ptz)`로 원시 단위 변환 → PTZ CGI 호출.
  - `toNativePtz`/`fromNativePtz`: `panRange/tiltRange/zoomRange`로 뷰어 단위↔원시 정수 선형 매핑. **왕복 일치**(테스트 §13.6).
  - **상수 분리(파일 상단)**: `const HUCOMS_LOGIN_PATH`, `HUCOMS_SNAPSHOT_PATH`, `HUCOMS_PTZ_PATH`, 기본 원시 범위 등 → 실기기 확인 후 보정 용이. CGI 정확 경로/파라미터 **미상은 상수로 흡수**(리스크 §8).
  - `listCameras()` → 설정 1소스를 단일 카메라/프리셋 없는 `CameraList`로 매핑(라이브 뷰).

> 명명 규약(설계서 §6.2): 프런트 URL `cam`/`preset` → 서버 핸들러 `camIdx`/`presetIdx` → CameraClient 호출 시 Unity `cam_idx`/`preset_idx` 변환(이미 CameraClient 내부 처리). `CameraSource.snapshot/move`의 인자명은 `cam`(number)으로 통일.

---

## 3. 프록시 라우트 명세 (`src/viewer/routes.ts`)

`registerViewerRoutes(app, { sources, viewer })` — `sources: Map<string, CameraSource>`, `viewer: ToolsConfig['viewer']`.

### 라우트 등록 순서 (설계서 §6.2 — 필수)
1. `/viewer/api/cameras`, `/snapshot`, `/move`, `/camera/login`, `/health` (정확 경로) **먼저** 등록.
2. `@fastify/static` (root=`web/`, prefix=`/viewer/`, 와일드카드) **나중**에 등록.
3. `GET /viewer` → `/viewer/` redirect(@fastify/static `redirect:true` 옵션).

### 라우트별 명세
| 메서드/경로 | 입력(zod) | 처리 | 응답 |
|-------------|-----------|------|------|
| `GET /viewer/api/cameras` | query `{ source?: string }`(기본 첫 소스) | `source.listCameras()` | `CameraList` JSON |
| `GET /viewer/api/snapshot` | query `{ source?, cam: int>0, preset: int>0, mode: 'preset'\|'manual', pan?, tilt?, zoom?, t? }` | mode 분기: preset→`snapshot(cam,{presetIdx,mode:'preset'})`; manual→`snapshot(cam,{presetIdx,ptz:{pan,tilt,zoom},mode:'manual'})` | `Content-Type: image/jpeg` 바이너리 + 헤더 `X-PTZ-Pan/Tilt/Zoom`, `Cache-Control: no-store` |
| `POST /viewer/api/move` | body `{ source?, cam: int>0, pan: number, tilt: number, zoom: number }` | `viewer.allowMove===false` → **403**; `controlToken` 설정 시 `X-Viewer-Token` 불일치 → **403**; 통과 시 `source.move(cam, {pan,tilt,zoom})` | `{ ok: boolean }` |
| `POST /viewer/api/camera/login` | body `{ source: string(필수), user: string, pass: string }` | hucoms 소스의 `login(user,pass)` 호출. **자격증명 미저장·응답/로그 미노출** | `{ ok: boolean }` (성공/실패만) |
| `GET /viewer/api/health` | — | 기존 `/health` 와 동일 정보 alias(또는 단순 `{status:'ok'}` 배지) | JSON |

- zod 스키마 명: `CamerasQuery`, `SnapshotQuery`, `MoveBody`, `LoginBody`. `coerce`로 query 문자열→number 변환.
- zoom 클램프: snapshot/move 진입 시 `CameraClient.clampZoom`(또는 소스 범위) 재사용. manual snapshot의 ptz.zoom도 클램프.
- **명명 변환은 핸들러 1곳에서만**: query `cam`/`preset` → `camIdx`/`presetIdx`(지역 변수) → `source.snapshot(cam, ...)`. Unity의 `cam_idx`/`preset_idx`는 CameraClient 내부에서만 처리.
- 에러: zod 실패 → 400 `{error,detail}`. 소스 호출 실패(CameraApiError 등) → 502 `{error}`. (기존 server.ts 패턴 준수.)
- login 라우트는 **hucoms 소스가 하나도 없으면** 등록은 하되 해당 source가 sim이면 400 `{error:'login unsupported'}`.

---

## 4. 설정 스키마 (`src/config/toolsConfig.ts`)

### `viewer` 섹션 (신규, 옵셔널+기본값 → 기존 config 호환)
```ts
const ViewerSchema = z.object({
  enabled: z.boolean(),
  allowMove: z.boolean(),
  defaultFps: z.number().int().positive(),
  staticDir: z.string().min(1),
  controlToken: z.string(),      // 빈 문자열 = 미사용
});
```
기본값:
```ts
viewer: { enabled: true, allowMove: true, defaultFps: 3, staticDir: 'web', controlToken: '' }
```

### `cameraSources` (신규, **옵셔널**, 하위호환 핵심)
```ts
const CameraSourceConfigSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['sim', 'hucoms']),
  baseUrl: z.string().url().optional(),          // sim
  host: z.string().optional(),                   // hucoms
  port: z.number().int().positive().optional(),
  loginPath: z.string().optional(),
  snapshotUrl: z.string().optional(),
  ptz: z.object({
    panRange: z.tuple([z.number(), z.number()]),
    tiltRange: z.tuple([z.number(), z.number()]),
    zoomRange: z.tuple([z.number(), z.number()]),
  }).optional(),
});
// ToolsConfigSchema 에 추가:
viewer: ViewerSchema,
cameraSources: z.array(CameraSourceConfigSchema).optional(),
```

### 로더 하위호환 처리 (`loadToolsConfig`)
- 현재 로더는 `DEFAULT_TOOLS_CONFIG` 키를 순회하며 섹션 병합한다. `viewer`는 default에 포함 → 기존과 동일하게 병합.
- `cameraSources`는 **옵셔널 배열**이라 default 키에 넣지 않는다(배열은 섹션병합 부적합). 로더에서 `raw.cameraSources`가 있으면 그대로 통과, 없으면 `undefined`.
  - 구현 주의: 현재 병합 루프는 `DEFAULT_TOOLS_CONFIG`의 키만 순회 → `cameraSources`를 별도로 `merged.cameraSources = raw.cameraSources`로 명시 대입한 뒤 `ToolsConfigSchema.parse`. (외과적: 루프 뒤 한 줄 추가.)
- **소스 빌드(`buildSourceRegistry`)**:
  - `cameraSources`가 있으면 각 항목을 kind별로 인스턴스화(`sim`→`new SimulatorSource(new CameraClient({...baseUrl}))`, `hucoms`→`new RealPtzSource(cfg)`).
  - **미설정 시**: `camera` 단일 설정으로 `SimulatorSource(new CameraClient(tools.camera))` 1개를 `id='sim'`로 등록(하위호환).

### `config/tools.config.json` 추가
```jsonc
"viewer": { "enabled": true, "allowMove": true, "defaultFps": 3, "staticDir": "web", "controlToken": "" }
```
`cameraSources`는 **미기재**(sim 단일 폴백으로 기존 동작 보존). 실 PTZ 테스트는 설정 주입으로만 검증(자격증명은 config에 두지 않음 — §13.5).

---

## 5. 프런트 구조 (`SettingAgent/web/`, 바닐라 ESM)

### 모듈 분리 (테스트 용이성)
- **`core.js` (순수, vitest 직접 import)**:
  - `toPixel(rect, imgW, imgH)` → `{px,py,pw,ph}` (설계서 §5.2). `imgW/imgH = img.clientWidth/clientHeight` 전제.
  - `presetKey(camIdx, presetIdx)` → `` `${camIdx}:${presetIdx}` ``.
  - `slotLabel(slotId, globalIndex)` → globalIndex에서 slotId 매칭 시 `globalIdx`, 없으면 `slotId` 폴백(G3 라벨 매핑).
  - `fpsToInterval(fps)` → `Math.round(1000/fps)`.
  - `clampZoom(z, min=1, max=36)`, `stepPtz(cur, dir, step)` → 절대 PTZ 환산.
  - `createStreamLoop(deps)` → `{start(fps), stop()}`. deps 주입: `{fetchFn, makeUrl(seq), createObjectURL, revokeObjectURL, setImage(url), decode(), onPtz(headers), onFrame()}`. 내부에 `inflight` 백프레셔 가드, `lastUrl` revoke, `AbortController` 정지. **DOM/브라우저 전역 미참조** → 테스트에서 mock 주입.
- **`app.js` (환경 의존, 결선)**:
  - `/mapping`·`/viewer/api/cameras` fetch → 카메라/프리셋 트리 렌더(G1).
  - 탭 전환, cam/preset 선택, 모드(preset/manual) 토글.
  - ROI canvas 렌더: `core.toPixel` + `ResizeObserver`로 리사이즈 시 재draw. 차량=시안/번호판=노랑, `slotLabel` 텍스트. `plateRoiByPreset` 없으면 차량 ROI만(테스트 §10.2-5).
  - 스트림: `core.createStreamLoop` 실제 의존성 주입(`fetch`, `URL.createObjectURL/revokeObjectURL`, `img.decode()`). manual 모드에서 현재 PTZ 상태 보존→URL 동봉(프리셋 복귀 방지).
  - PTZ 버튼/절대이동 → `POST /viewer/api/move` 후 `tick()` 1회 갱신. zoom in/out=±1 클램프, step 기본=`viewer.defaultFps`와 무관(기본 500).
  - login UI: hucoms 소스 선택 시 user/pass 입력 → `POST /viewer/api/camera/login`. **자격증명 미저장·URL 미노출**(POST body로만).

### ROI 정렬 (letterbox 방지 — 설계서 §5.2 필수)
- `<img>` 자체 크기에 canvas 일치(`.viewport` inline-block). `object-fit` 미사용. `toPixel`은 `img.clientWidth/clientHeight` 사용.

---

## 6. 의존성

- **추가**: `@fastify/static` (`package.json` dependencies). 버전은 fastify 5.x 호환(`^7` 또는 설치 시점 최신 메이저 — developer가 `npm i` 후 lockfile 확인).
- **그 외 신규 의존성 없음**: Node 내장 `fetch`/`Buffer`/`AbortController` 활용. 프런트는 번들러 없음(브라우저 네이티브 ESM).

---

## 7. 단계별 작업 순서 + 검증 기준 (설계서 §10.1 1~10 매핑)

```
1. CameraSource 인터페이스 + SimulatorSource(CameraClient 래핑)
   → 검증: simulatorSource.test.ts — snapshot(preset/manual 인자 위임)·move·list 위임, 항등 변환

2. CameraClient.listCameras() 추가 (GET /cameras, A타입 파싱)
   → 검증: cameraClientList.test.ts — fetch mock 응답 → CameraList 파싱(enabled=false 포함 여부·presets 매핑)

3. /viewer/api/* 프록시 라우트(cameras/snapshot/move/health/login)+zod
   → 검증: viewerRoutes.test.ts — fastify.inject 라우트별 mock 소스, zod 400, allowMove=false→403, controlToken 불일치→403

4. snapshot 프록시: base64→image/jpeg + X-PTZ-* 헤더, mode 분기
   → 검증: viewerRoutes.test.ts — content-type=image/jpeg, X-PTZ-Pan/Tilt/Zoom 값, preset/manual 시 소스 인자 차이

5. /viewer 정적 서빙(@fastify/static, web/) + SPA(index/app.js/css/core.js)
   → 검증: viewerRoutes.test.ts — GET /viewer/index.html 200·content-type text/html, /viewer/api/* 우선순위(정적보다 먼저 매칭)

6. ROI 좌표 변환·오버레이(toPixel, slotLabel)
   → 검증: viewerCore.test.ts — toPixel(0~1×크기) 환산(G2), slotLabel globalIdx 매칭+폴백

7. 스트림 폴링·백프레셔·정지·Blob revoke (createStreamLoop)
   → 검증: viewerCore.test.ts — inflight 가드(겹침 스킵), 새 프레임 시 이전 URL revoke(G3-4), stop() 시 timer 해제+abort(G3-1)

8. PTZ 제어(절대/스텝/zoom 클램프)+수동모드 PTZ 동봉 폴링
   → 검증: viewerCore.test.ts(stepPtz·clampZoom) + viewerRoutes.test.ts(move 인자·클램프); manual URL에 pan/tilt/zoom 동봉 확인(G3-2·G4)

9. [실 PTZ] RealPtzSource(Hucoms CGI): login.cgi 세션·snapshot·move·단위매핑
   → 검증: realPtzSource.test.ts — CGI 모킹: login→세션, snapshot image/jpeg, move 원시단위, toNative/fromNative 왕복일치, 자격증명 미노출(§13.6)

10. [실 PTZ] cameraSources 설정 로딩(하위호환) + POST /viewer/api/camera/login
   → 검증: sourceRegistry.test.ts(미설정→sim 1개, 다중소스 선택) + viewerRoutes.test.ts(login 라우트 자격증명 미반환)
── 이번 라운드 종료 ──
```

각 단계 완료 시 `npm run typecheck` + 해당 test 통과. 전 단계 후 `npm test` 전체 그린.

---

## 8. 테스트 계획 개요 (vitest, 외부 서버 모킹)

### 서버 (`fastify.inject` + fetch/소스 mock)
- `viewerRoutes.test.ts`:
  - mock `CameraSource`(인메모리) 주입 → 라우트 동작만 격리 검증.
  - allowMove=false → POST move 403 / controlToken 설정+헤더 누락·불일치 → 403.
  - snapshot: `Content-Type: image/jpeg`, `X-PTZ-Pan/Tilt/Zoom` 헤더 존재·값, `Cache-Control: no-store`.
  - login: 응답 body에 user/pass **미포함**(자격증명 미노출 검증).
  - 라우트 우선순위: `/viewer/api/cameras`가 정적보다 먼저 매칭.
- `cameraClientList.test.ts`: 전역 `fetch`를 vi.fn으로 stub(기존 테스트 패턴 — 없으면 `globalThis.fetch` mock), A타입 응답 파싱.

### 프런트 순수 로직 (`viewerCore.test.ts`)
- `toPixel`/`presetKey`/`slotLabel`/`fpsToInterval`/`clampZoom`/`stepPtz` 단위.
- `createStreamLoop`: 주입 mock(fetchFn 지연 Promise)로 백프레셔(겹침 스킵)·revoke 호출 횟수·stop abort 검증. fake timers(`vi.useFakeTimers`).

### 실 PTZ (`realPtzSource.test.ts`, Hucoms CGI 모킹)
- `globalThis.fetch` mock으로 login.cgi/snapshot/PTZ CGI 응답 시뮬레이션.
- 세션 만료→재로그인, 단위 왕복 일치, 클램프, 자격증명 미노출(mock 호출 인자 검사 — URL에 평문 없음).

> 모든 외부 REST(`Unity :13100`, Hucoms `:80`)는 모킹. 실서버 통합 동작확인은 12단계(문서화/동작확인 라운드)·실기기는 §13.6 보류.

---

## 9. 영향도 사전분석

| 대상 | 변경 | 영향/리스크 | 완화 |
|------|------|-------------|------|
| `CameraClient.requestImage/move/health/clampZoom` | **불변**(listCameras만 가산) | 기존 호출부(SetupOrchestrator/presetProvider/discover) 무영향 | 시그니처 동결, 회귀 테스트 |
| `presetProvider.ts UnityPresetProvider` | 불변 | `/cameras` 파싱 중복? — listCameras는 **전체 A타입 구조**(presets 중첩) 반환, presetProvider는 **flatten된 CameraView**. 용도 다름 → 중복 아님 | 두 파서 공존(외과적). 필요 시 후속 통합(이번 범위 밖) |
| `toolsConfig.ts` | viewer/cameraSources 가산 | 기존 config 파일 호환(옵셔널+기본값) | 누락 시 기본값/sim 폴백. config.test.ts 회귀 |
| `server.ts`/`index.ts` | 라우트·소스 주입 가산 | 기존 라우트 prefix 충돌 없음(`/viewer` 격리) | `viewer.enabled=false` 시 미등록 |
| `package.json` | `@fastify/static` | 셋업/MCP 경로 무관, 번들영향 미미 | — |
| 셋업 파이프라인·`SetupArtifact`·`/mapping` | **불변**(읽기 전용 소비) | 산출물 계약 무영향 | 뷰어는 `/mapping` GET만 |
| `@parkagent/types` | **불변** | 공유 계약 무영향(Preset/ParkingSlot/GlobalSlotIndex/NormalizedRect 소비만) | — |
| ActionAgent / DMAgent | **무영향** | 뷰어는 SettingAgent 단독 | — |

> 핵심: 모든 변경은 **가산적·prefix 격리·옵셔널 기본값**. 기존 동작 경로(셋업·MCP·공유 타입)는 한 줄도 의미 변경 없음.

---

## 10. 리스크 / 미확정 사항

1. **Hucoms CGI 실제 경로·파라미터 미상** (login.cgi 외 snapshot/PTZ CGI 경로·인증 방식·원시 PTZ 범위). → `RealPtzSource` 상단 `HUCOMS_*` 상수 + `cameraSources[].ptz` 범위로 흡수. 단위테스트는 모킹, **실기기 통합확인은 장비 연결 후 보류**(§13.6).
2. **`@fastify/static` 버전**: fastify 5.x 호환 메이저 확인 필요(developer가 설치 후 typecheck로 확정).
3. **`X-PTZ-*` 헤더의 manual 모드 값**: Unity `/req_img`가 override PTZ를 응답에 반영하는지(설계서 §1.4 해석 A 전제). 시뮬레이터 응답 PTZ를 그대로 헤더에 실음 — 실서버 동작확인(12단계)에서 검증.
4. **`listCameras` vs `UnityPresetProvider` 파서 중복**: 의도적 공존(반환 형태 상이). 통합은 이번 범위 밖.
5. **프런트 jsdom 미도입**: `app.js`(DOM 결선)는 단위테스트 제외, 순수 로직(`core.js`)만 테스트. DOM 동작은 12단계 브라우저 수동확인(G1~G4 스크린샷).
6. **controlToken**: 기본 빈 문자열(미사용). 활성화는 운영 설정 — 이번 구현은 "설정 시 검사" 로직만.

---

## 11. 구현자(developer)에게 — 시작점

- 1단계부터 순차 진행. 각 단계 후 `npm run typecheck` + 해당 vitest.
- 1-based 인덱스(cam/preset) 전 구간 준수. 외부 호출은 `fetchWithTimeout` 재사용(타임아웃).
- 외과적 변경: 기존 파일은 명시된 가산만. 인접 코드 리팩토링 금지.
- 순수 로직은 `web/core.js`로 분리(테스트 가능). 과설계 금지(설계서 §10.1 1~10 범위 한정).
- 문서화(documenter)는 구현 완료 후 §9 영향도 표를 기준으로 한글 `.md` 작성.
