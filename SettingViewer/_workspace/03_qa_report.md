# SettingViewer 분리 리팩토링 — 검증 보고서 (03_qa_report)

- 작성일: 2026-06-25
- 작성자: qa-tester (ParkAgent 검증자)
- 기준: `_workspace/01_architect_plan.md` + `_workspace/02_developer_changes.md`
- 판정: **양쪽 그린, 재작업 불필요**(검증자 테스트 1건 보강 반영). 미커버 영역은 §7 명시.

---

## 0. 양쪽 테스트 결과 (수치 그대로)

| 대상 | typecheck | test | 비고 |
|------|-----------|------|------|
| SettingViewer | ✅ 통과(에러 0) | ✅ **62 passed / 7 files** | 구현자 61 + 검증자 타임아웃 보강 1 |
| SettingAgent | ✅ 통과(에러 0) | ✅ **81 passed / 19 files** | 회귀 **0** (불변 조건 충족) |

- SettingViewer 파일별: viewerCore 19, simulatorSource 6, sourceRegistry 4, cameraClientList 6, realPtzSource 8, mappingProxy **5**(보강 후), viewerRoutes 14.
- SettingAgent: config.test 포함 19개 파일 전부 그린. 뷰어 테스트(이동분 57)는 SettingAgent 에 부재(이동 완료) → 81 로 정상 회귀.
- 두 명령 모두 종료코드 0. 실행 환경: vitest 2.1.9, Windows.

---

## 1. 독립성 검증 (런타임 소스 의존 0건)

`SettingViewer/src` 전체 grep(`@parkagent`, `SettingAgent`, `from '..SettingAgent'`, `packages/types`):
- **런타임 import 0건**. 매칭된 라인은 전부 **주석/문자열**:
  - `src/clients/CameraClient.ts:6` — 주석("@parkagent/types 와 동일한 8필드…").
  - `src/config/viewerConfig.ts:5,7` — 주석.
  - `src/server.ts:10,19,26` — 주석(프록시 대상 설명).
- `web/core.d.ts:2`, `test/mappingProxy.test.ts` 매칭도 주석/테스트 설명 문자열뿐.
- 루트 `package.json` workspaces = `["packages/*","SettingAgent","SettingViewer"]` → SettingViewer 워크스페이스 link만 추가(소스 의존 아님). **판정: 독립성 확보 확인.**

`CapturedImage` 는 CameraClient.ts 내 로컬 인터페이스로 정의·export(8필드: camIdx/presetIdx/pan/tilt/zoom/imgName/jpg) → `simulatorSource.test.ts` 가 여기서 import. `@parkagent/types` 미의존 확인.

---

## 2. /mapping 프록시 검증 (보강 포함)

`mappingProxy.test.ts` — 검증자가 타임아웃 케이스 **1건 보강**해 5케이스로 완성:

| 케이스 | 입력 | 기대 | 결과 |
|--------|------|------|------|
| 200 패스스루 | upstream 200 + JSON | 200, content-type application/json, SetupArtifact JSON 그대로 | ✅ |
| 404 패스스루 | upstream 404 | 404 `{error:'no setup artifact'}` | ✅ |
| 5xx→502 | upstream 500 | 502 `{error 포함 'mapping upstream HTTP 500'}` | ✅ |
| 미가동→502 | 닫힌 포트(127.0.0.1:1) | 502 `{error:'mapping upstream unreachable'}` | ✅ |
| **타임아웃→502(보강)** | upstream 무응답 + fake timers 5000ms 진행 | 502 `{error:'mapping upstream unreachable'}` | ✅ |

- 보강 근거: 계획 §4 / 본 작업 검증항목 3이 "타임아웃" 커버를 요구. 구현상 타임아웃은 `fetchWithTimeout`(5000ms, AbortController)이 `fetch` 를 abort→예외→**unreachable 과 동일 catch 분기**. 기존 4케이스는 이 분기를 미가동(연결 거부)으로만 탔으므로, 무응답 upstream + `vi.useFakeTimers()`/`advanceTimersByTimeAsync(5000)` 로 **abort 경로를 명시적으로 발화**시키는 테스트를 추가했다. 동작 변경 없음(테스트만 보강).
- `settingAgentUrl` 사용 확인: `server.ts:24` 말미 슬래시 정규화(`replace(/\/+$/,'')`) 후 `${settingAgentUrl}/mapping` 호출. 라우트 등록 순서 = ① `/viewer/api/mapping` 프록시 → ② `registerViewerRoutes`(정적 와일드카드) — 우선순위 정상.
- 보강 파일: `SettingViewer/test/mappingProxy.test.ts`(import 에 `vi` 추가, 말미 타임아웃 it 1건 추가).

---

## 3. 계약 보존 (경계면 교차 비교)

### 3.1 viewerRoutes (이동 라우트) — `viewerRoutes.test.ts` 14케이스 그린

| 계약 | 확인 |
|------|------|
| GET /cameras → 200 CameraList JSON, `camIdx` 1-based | ✅ |
| GET /snapshot preset → **content-type image/jpeg** + **X-PTZ-pan/tilt/zoom** + cache-control no-store | ✅ |
| GET /snapshot manual → ptz 소스 전달, X-PTZ-* 반영, JPEG SOI(ff d8) | ✅ |
| zoom 클램프(99→36) snapshot/move 양쪽 | ✅ |
| zod 실패(cam=0) → 400 | ✅ |
| POST /move → {ok:true}, allowMove=false → **403**(소스 미호출) | ✅ |
| POST /move controlToken 불일치 → **403**, 일치 → 200 | ✅ |
| POST /camera/login: sim → 400(unsupported), hucoms → 200 / **자격증명(user·pass) 응답 미노출** | ✅ |
| GET /health → {status:ok, sources:[...]} | ✅ |
| 라우트 우선순위(API > static), /viewer → 302 /viewer/ | ✅ |

### 3.2 명명규약 경계 (cam/preset ↔ camIdx ↔ cam_idx)

- 브라우저/뷰어 API: 쿼리 `cam`/`preset` → routes 가 `camIdx`/`presetIdx` 로 소스 호출(spySource 인자 `presetIdx:2` 확인).
- CameraClient → Unity REST 경계(`CameraClient.ts`): `requestImage`/`move` 가 바디에 **snake_case `cam_idx`/`preset_idx`** 송신, 응답 파싱도 `cam_idx`/`preset_idx`/`img_name`/`img_bytes`(base64→Buffer). camelCase↔snake_case 변환 **이동 후에도 동일**(무수정 복제).
- 주의(불일치 아님, 기존 계약): `/cameras` 응답은 `c.camIdx`(camelCase)로 읽음 — req_img/req_move(snake)와 다른 출처지만 분리 이전과 동일한 기존 계약. 이번 분리로 변경 없음.

---

## 4. SettingAgent 정리 검증

| 항목 | 기대 | 결과 |
|------|------|------|
| `SettingAgent/src/viewer/` 부재 | 삭제(이동) | ✅ 디렉터리 없음 |
| `SettingAgent/web/` 부재 | 삭제(이동) | ✅ 디렉터리 없음 |
| `src` 내 `listCameras`/`@fastify/static`/`registerViewerRoutes`/`buildSourceRegistry`/`cameraSources`/`ViewerSchema`/`viewer` | 0건 | ✅ grep no matches |
| `index.ts` 뷰어 배선(sources/CameraSource 등) | 부재 | ✅ no matches |
| `server.ts` 뷰어 배선 | 부재, `/mapping` **유지** | ✅ `/mapping` 라우트 server.ts:163 존재 |
| `package.json` @fastify/static 의존 | 제거(fastify 만 잔존) | ✅ static 0건 |
| `config/tools.config.json` viewer/cameraSources | 부재 | ✅ grep 0건 |
| `config.test.ts` 회귀 | 무수정 통과 | ✅ 4 passed (`toEqual(DEFAULT_TOOLS_CONFIG)` 양변 동시 변경, viewer 미단언 → 가정 A 확인) |

**`/mapping` 라우트 유지 확인**(SettingViewer 프록시 대상이므로 필수): `SettingAgent/src/api/server.ts:163 app.get('/mapping', ...)`. 정상.

---

## 5. 구현자 플래그 2건 재확인

### 5.1 git 미초기화 (사실 확인만, 테스트 무관)

- `ParkAgent/.git` 디렉터리가 **비어 있음**(`ls -la .git` → `.`/`..` 만). `git status` → `fatal: not a git repository`.
- 따라서 `git mv` 불가 → 일반 `mv` 로 이동됨(파일 내용·구조는 계획 일치, **git 이력 보존만 불가**). 저장소 초기화·재커밋은 리더 판단 영역. **테스트/동작에는 영향 없음**(보고서 기록 목적).

### 5.2 viewerCore.test.ts typecheck 정정 — 테스트 의도/동작 불변 확인

- `web/core.d.ts` **신규**: core.js 공개 함수(toPixel/presetKey/slotLabel/fpsToInterval/clampZoom/stepPtz)·`createStreamLoop`(StreamLoopDeps/StreamLoop) 타입 선언. **런타임 JS 무변경**(선언파일만). TS7016(implicit any) 해소용.
- `viewerCore.test.ts:159` 1줄: `vi.fn(() => 'TIMER')` → `vi.fn((_fn: () => void, _ms: number) => 'TIMER')`. 파라미터 튜플 추론을 `[]`→`[fn,ms]` 로 만들어 `setTimer.mock.calls[0][1]`(index 1) 접근 가능(TS2493 해소). 단언값 `.toBe(333)` **불변**.
- **검증 의도 보존 확인**(19 테스트 그린):
  - toPixel: 0~1 정규화 → 픽셀 환산(전체/부분) ✅
  - slotLabel: globalIdx 매칭/미매칭/부재 폴백 ✅
  - createStreamLoop **백프레셔**(inflight 겹침 시 fetch 1회) ✅
  - **revoke**(새 프레임 시 이전 Blob URL revoke, 첫 프레임 revoke 없음) ✅
  - **stop**(timer clear + inflight abort signal.aborted=true) ✅
  - fake timers 간격 발화 ✅
- `stop` 테스트(170행)는 `setTimer` mock 의 index 1 미접근이라 `vi.fn(() => 'TIMER')` 무수정 유지 — 정확. **두 정정 모두 타입 보정에 한정, 동작/의도 변경 없음.**

---

## 6. 발견 결함 / 수정

- **기능 결함: 0건.** 양쪽 typecheck/test 그린, 계약·정리·독립성 모두 통과.
- **테스트 커버리지 보강 1건(검증자 직접 반영, 동작 변경 아님)**:
  - 파일 `SettingViewer/test/mappingProxy.test.ts`
  - 변경: import 에 `vi` 추가, 말미에 "SettingAgent 무응답(타임아웃) → 502 unreachable" it 추가(fake timers 로 5000ms abort 발화).
  - 사유: 검증항목 3 "타임아웃 커버" 명시 충족. 보강 후 mappingProxy 5 passed / 전체 62 passed.

리더가 구현자에게 전달할 재작업 항목: **없음**.

---

## 7. 미커버 영역 (누락 명시 — 통과 위장 금지)

다음은 단위테스트(모킹) 범위 밖이며 **수행하지 않았음**:

1. **외부 서비스 실연동 스모크 — 누락**: Unity 카메라 REST(:13100)·SettingAgent(:13020) **실서버 미가동**. snapshot/move/health/login 및 `/mapping` 실프록시 E2E 는 모킹(stub)으로만 검증. 실기기/실서버 스모크는 두 프로세스 기동 후 별도 수동 영역.
2. **두 서비스 통합 구동 — 누락**: SettingAgent(:13020) 먼저 → SettingViewer(:13030) 동시 기동 후 실제 `/viewer/api/mapping` 200/502 흐름 미검증(프로세스 미기동).
3. **브라우저 DOM/렌더 — 누락**: jsdom 미도입. `:13030/viewer/` 실제 로딩, canvas ROI 오버레이, app.js `loadMapping()`→`api('/mapping')` 호출, 영상 스트리밍 시각 동작은 단위테스트 제외(core.js 순수 함수만 직접 검증).
4. **git 미초기화 — 사실 기록**(§5.1): 이력 보존 불가, 테스트 무관.
5. **실 PTZ(hucoms) 로그인 실연동 — 누락**: spySource 모킹으로 자격증명 비노출·전달만 검증. 실 카메라 인증 미검증.

---

## 8. 최종 판정

- **재작업 불필요.** 양쪽 그린(Viewer 62 / Agent 81, 회귀 0), 독립성 확보, 프록시·계약·정리 모두 충족.
- 보강 1건(타임아웃 테스트)은 검증자가 직접 반영 완료 — 동작 변경 없음.
- 잔여 위험은 전부 §7 미커버 영역(실연동·DOM·통합구동)으로, 분리 작업 범위 밖의 수동/E2E 영역.
