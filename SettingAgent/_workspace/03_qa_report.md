# 03 · 검증자(qa-tester) 리포트 — SettingViewer → SettingAgent 재통합 검증

작성: 검증자(qa-tester) · 대상: SettingAgent · 분류: 리팩토링(통합) 검증
입력: `01_architect_plan.md`(§8·§10 검증 기준) + `02_developer_changes.md` + 변경 소스

---

## 0. 결론

**재작업 불필요. 통과.** 구현 결함 0건. 설계서의 모든 검증 항목 충족(회귀 0).

- `npm run typecheck` → **오류 0**.
- `npm test`(vitest) → **36 파일 / 239 테스트 전부 통과**(02 보고 수치와 일치, 회귀 0).
- 토글·프록시제거·계약불변·중복제거·라우트순서 전부 코드/inject 로 교차 검증됨.

---

## 1. 양쪽 테스트 결과(수치 그대로)

| 항목 | 결과 |
|------|------|
| `cd SettingAgent && npm run typecheck` | 오류 0 |
| `cd SettingAgent && npm test` | **Test Files 36 passed (36) / Tests 239 passed (239)**, Duration 2.12s |
| 신규/대체 테스트 통과 | `mappingDirect.test.ts`(2) ✓, `viewerEnabled.test.ts`(2) ✓ |
| 이관 테스트 통과 | viewerRoutes(14)·cameraClientList(6)·realPtzSource(8)·sourceRegistry(4)·simulatorSource(6)·viewerCore(19)·analyzeArtifact(5)·findPresetPtz(4)·panelResize(4)·captureCore(9) 전부 ✓ |
| 삭제 확인 | `mappingProxy.test.ts`·`captureProxy.test.ts` 부재(Glob 0) ✓ |
| 루트 workspaces | `["packages/*","SettingAgent"]` — SettingViewer 제거 반영 ✓ |
| `@fastify/static` | `node_modules/@fastify/static@9.1.3` 설치 확인(fastify 5.8.5 호환) ✓ |

> captureJob.test 의 로그(`preset2 캡처 실패`/`DB 적재 폭발`/`LPD down`)는 **의도된 에러 흡수 경로 테스트**(레벨 40/50 logger 출력)로 통과에 영향 없음. 전부 ✓.

---

## 2. viewer.enabled 토글 검증 (inject, 라이브 서버 미사용)

`viewerEnabled.test.ts` 가 `app.inject` 로 검증(포트 점유 없음):

- **enabled=false** → `/viewer/api/health` **404**(헤드리스 강등), `/health`(루트) 200, `/setup/status` 200. ✓
- **enabled=true** → `/viewer/api/health` **200** + `{status:'ok', sources:['sim']}`, `/health`(루트) 200(경로 충돌 없음). ✓

서버 코드(`server.ts` L201) 이중 가드 `if (deps.viewer?.enabled && deps.sources)` 확인 — enabled=false 또는 sources 미주입 시 뷰어 라우트·정적 블록 자체가 `app.register` 되지 않음(미등록 → 404). 헤드리스 보존 정합.

`mappingDirect.test.ts` 가 enabled=true + 임시 staticDir 로 `/viewer/`(SPA 200 경로) 등록을 간접 증명(static root 존재 시 register 성공, inject 통과).

---

## 3. 프록시 제거 정합

- **`/viewer/api/mapping` = `repo.loadArtifact()` 직접**(server.ts L206–213): 산출물 → 200 패스스루, null → 404 `{error:'no setup artifact'}`. `mappingDirect.test.ts` 2케이스로 검증(content-type application/json, body.slots[0].slotId 패스스루 확인). HTTP 자기호출(1홉·502·타임아웃) 소멸 확인. ✓
- **`/viewer/api/capture/*` 라우트 부재**: src 전역 grep `viewer/api/capture` → 0건. alias 미신설 확인. ✓
- **app.js capture 직접 호출**(grep 교차): L262 `/capture/status`, L301 `/capture/start`, L312 `/capture/stop`, L319 `/capture/finalize` — 모두 접두 없는 직접 호출. `api('/capture` 잔존 0. ✓
- **mapping/cameras/snapshot/move/login/health 는 `/viewer/api/*` 유지**(app.js): `api('/mapping')`(L47·L336)·`api('/cameras...')`(L38)·`api('/snapshot...')`(L188·L238)·`api('/move')`(L210)·`api('/camera/login')`(L564)·`api('/health')`(L56·L113) — `const api=(p)=>`/viewer/api${p}`` 접두 유지. ✓

---

## 4. 계약 불변

- `/health`(루트)·`/setup/*`·루트 `/mapping`·`/capture/*` shape·동작 유지 — 기존 테스트(apiRefresh·captureRoutes 19개·setupOrchestrator 등) 전부 통과로 회귀 0 확인. server.ts 의 기존 라우트 핸들러 무수정(가산만). ✓
- **CameraClient 시그니처 불변 + listCameras 가산만**(CameraClient.ts 정독):
  - `health()`·`requestImage(camIdx,presetIdx,ptz?)`·`move(camIdx,pan,tilt,zoom)`·`clampZoom(zoom)` 본문·시그니처 불변. `CapturedImage` 출처 `../domain/types.js` 유지.
  - `listCameras(): Promise<CameraList>` 재추가. A타입 파싱: `name ?? 'C{idx}'`, `label ?? 'C{idx}-P{idx}'` 폴백, **`enabled: c.enabled !== false`(false 보존)**, presets 중첩 PTZ(pan/tilt/zoom) 보존. `CameraList` 출처 `../viewer/CameraSource.js`. cameraClientList.test(6) 통과. ✓

---

## 5. 중복 제거

- `src/` 내 `buildViewerServer`/`settingAgentUrl`/`loadViewerConfig`/`DEFAULT_VIEWER_CONFIG` 라이브 참조 **0건**. `viewerConfig`·`SettingViewer` 언급은 toolsConfig.ts/index.ts/server.ts 의 **의도적 통합 주석 3건뿐**(라이브 코드 아님). ✓
- 중복 파일 부재: `src/viewer/` = {CameraSource, SimulatorSource, RealPtzSource, sourceRegistry, routes}.ts 5개만(viewer 복제 CameraClient 없음). `viewerConfig.ts` 부재(Glob 0). `src/util/http.ts` 단일(상위집합, viewer 복제본 미이동). ✓
- SettingViewer 소스 import 0: `git ls-files SettingViewer` = 0, 작업트리 파일 0(빈 폴더만 잔존). ✓

---

## 6. 라우트 등록 순서

- `routes.ts`: `/viewer/api/{cameras,snapshot,move,camera/login,health}`(정확 경로) 전부 등록 후 **마지막에** `@fastify/static`(prefix `/viewer/`, 와일드카드) register. server.ts 는 그 앞에 `/viewer/api/mapping` 등록. 정확 경로가 와일드카드보다 우선 → 충돌 없음.
- inject 검증: `viewerEnabled.test.ts` 의 `/viewer/api/health` → 200 JSON `{status:'ok',sources:['sim']}` 반환(정적 index.html 이 아님) = 정확 경로가 static 보다 먼저 매칭됨을 실증. ✓

---

## 7. 발견 결함 / 수정

- **구현 결함: 0건.** 테스트 작성 실수: 0건(직접 수정 없음). 통과 위장 없음.

---

## 8. 미커버(명시)

1. **라이브 기동(`npm start`) 미수행**: 포트 13020 점유 가능성으로 마스터 지시대로 inject 만 사용. 실제 `listen()` 후 `/viewer/`(SPA HTML 200)·정적 자산 서빙은 별도 스모크 필요.
2. **브라우저 DOM 동작 미커버**: 카메라 선택/스냅샷 렌더/PTZ 이동/프리셋 이동(gotoPreset)/정밀수집 탭/분석 탭의 실제 DOM·fetch 왕복은 web 테스트(core.js 순수 로직 단위테스트)로만 부분 커버. 엔드투엔드 브라우저 검증은 범위 외.
3. **실 PTZ(HNR-2036LA) 스모크 미수행**: RealPtzSource CGI/PTZ 범위는 미확인 가정값(설계 §13.6). 실 장비 연결 후 실측 보정 필요. realPtzSource.test(8)는 모킹 기반.
4. **SettingViewer 빈 폴더 잠금**: `git ls-files` 0·작업트리 파일 0 이나 디렉터리 핸들 잠금으로 빈 폴더 자체 삭제 실패(다른 프로세스가 cwd 점유 추정). git 추적상 영향 없음. 프로세스 종료 후 `Remove-Item -Recurse -Force SettingViewer` 1회 필요(02 §8-1과 동일).

---

## 9. 검증 항목 요약표

| 검증 항목 | 결과 |
|-----------|------|
| 1. 양쪽 테스트(typecheck/test) | ✓ 0 오류 / 36파일·239테스트 통과 |
| 2. viewer.enabled 토글(inject) | ✓ false→404·true→200, 헤드리스 보존 |
| 3. 프록시 제거 정합 | ✓ mapping 직접·capture alias 부재·app.js 직접호출 |
| 4. 계약 불변 | ✓ 기존 라우트·CameraClient 시그니처 불변 |
| 5. 중복 제거 | ✓ 복제 CameraClient/http/viewerConfig 잔존 0 |
| 6. 라우트 등록 순서 | ✓ 정확경로 우선(inject 실증) |

이상 — 통과. 재작업 불필요.
