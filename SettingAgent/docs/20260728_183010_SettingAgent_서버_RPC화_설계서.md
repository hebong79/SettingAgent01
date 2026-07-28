# SettingAgent(13020) 서버 RPC화 설계서

> 작성일: 2026-07-28 18:30
> 대상: `AgentVLA/ParkAgent/SettingAgent` — Fastify REST 서버(포트 13020) + 웹 클라이언트(`web/`)
> 목적: **셋팅에 필요한 조작을 외부(에이전트·다른 프로그램·CI)에서 컨트롤**할 수 있도록 서버 능력을 JSON-RPC 2.0 단일 제어 평면으로 노출한다.
> 범위: **설계만**(코드 변경 0). 노출 목록 · 웹 클라이언트 전용 능력의 승격 목록 · **제외 제안** · 안전 규약 · 단계별 로드맵.

---

## 0. 요약 (TL;DR)

- 현재 13020 은 **REST 76 라우트**(`src/api/*`, `src/viewer/routes.ts`)이고, 이미 프로젝트 안에 JSON-RPC 자산이 있다 — `CRpcClient`(Unity 13110 **클라이언트**), `POST /viewer/api/rpc`(Unity **프록시**), `GET /rpc/catalog` 규약, `x-viewer-token` 게이트.
- 즉 **RPC 규약은 이미 사내 표준이 있고**(Unity 13110 의 `cam.setPTZ`/`preset.list` 스타일), SettingAgent 는 그 규약의 **소비자**이기만 하다. 이번 작업은 SettingAgent 를 **RPC 제공자**로도 세우는 것이다.
- 노출 제안: **`POST /rpc` + `GET /rpc/catalog`(13020 루트)**, 7개 도메인 **58 메서드**. 셋팅 5대 관심사(주차면 자동생성 / 캘리브레이션 / 센터라이징 / 주차면 그리기 / 번호판 위치 / DB 컨트롤)를 전부 덮는다.
- **웹 클라이언트에만 있는 능력 12건**을 발굴했다(주차면 단건 편집·되돌리기·자동보정 적용·전역번호 자동부여·프리셋 CRUD·Touring 순회·클릭 지점 번호판 선택 등). 이건 **REST 에 없어서** 외부 컨트롤러가 지금은 흉내낼 수 없다 → **서버로 승격**해야 RPC화가 "외부에서 셋팅 가능"이라는 목적을 만족한다(§7).
- **제외 제안 14건**: MJPEG 스트림·JPEG 프레임(바이너리·롱리브드), 정적 SPA, 카메라 로그인(자격증명), 임의 SQL, LLM 운영 계열, 뷰어 렌더 전용 대용량 진단(`vehicle-cuboids`/`job-cuboids`), 레거시 `/setup/run*` 등(§8).
- **최대 리스크는 "두 번째 구현"**이다. 이 저장소의 규약은 *이중구현 금지*(`ground-model`·`detect`·`CaptureJob` 이 같은 팩토리를 쓰는 이유). RPC 는 **새 로직을 갖지 않고** 기존 핸들러에서 추출한 **서비스 함수 하나**를 REST 와 공유해야 한다(§5).

---

## 1. 현황 (As-Is)

### 1.1 제어 평면이 이미 둘이다

| 평면 | 경로 | 방향 | 소유 |
|---|---|---|---|
| REST(13020) | `/capture/*` `/calibrate/*` `/discover/*` `/mapping*` `/db/*` `/settings` `/viewer/api/*` | 웹 클라 → SettingAgent | `src/api/*`, `src/viewer/routes.ts` |
| JSON-RPC(13110) | `POST /rpc`, `GET /rpc/catalog` | SettingAgent → Unity | `src/clients/CRpcClient.ts` |
| RPC 프록시 | `POST /viewer/api/rpc` | 브라우저 → 13020 → Unity | `viewer/routes.ts:366` |

> ⚠️ **이름 충돌 주의**: `/viewer/api/rpc` 는 **Unity 프록시**다. SettingAgent **자신의** 메서드를 같은 경로에 얹으면 두 의미가 섞인다. 본 설계는 자기 능력을 **`POST /rpc`(루트)** 로 분리하고, Unity 는 `unity.*` 네임스페이스 **패스스루**로 같은 카탈로그에 합류시킨다(§4.6).

### 1.2 현행 REST 라우트 인벤토리 (76개)

| 그룹 | 라우트 | 파일 |
|---|---|---|
| 헬스·두뇌 | `GET /health` `GET /brain/ping` `POST /brain/review` | `api/server.ts` |
| 레거시 셋업 | `POST /setup/run` `POST /setup/run-from-map` `POST /setup/export-camerapos` `GET /setup/status` | `api/server.ts` |
| 매핑 | `GET/PUT /mapping` `POST /mapping/renumber` `POST /mapping/placement` (+ `/viewer/api/mapping*` 4종, **동일 클로저 공유**) | `api/server.ts` |
| 수집·파이프라인 | `POST /capture/start` `start-precise` `stop` `finalize` `warmup` / `GET /capture/status` `pipeline` `aggregate` `occupancy` `frame`(JPEG) | `api/captureRoutes.ts` |
| 슬롯(DB) | `GET /capture/slots` / `POST /capture/slots/reset` `load-roi` `sync-roi` `lpd` `occupy` `cuboid` | 〃 |
| 결과 저장 | `POST /capture/save` `setup-result` / `GET /capture/saves` `saves/:name` | 〃 |
| 주차면 정본 | `GET/PUT /capture/place-roi` `POST /capture/place-roi/validate` | 〃 |
| 지면·육면체 | `GET /capture/ground-model` `vehicle-cuboids` `job-cuboids` | 〃 |
| 자동보정 | `POST /capture/refframe` `autocorrect` | 〃 |
| 검출 | `POST /capture/detect` | 〃 |
| 자동 격자 | `GET /capture/ground-grid` `POST /capture/ground-grid/bootstrap` `apply` | `api/groundGridRoutes.ts` |
| 센터라이징 | `POST /calibrate/ptz` `point` / `GET /calibrate/status` `result` `frame`(JPEG) | `api/calibrateRoutes.ts` |
| 번호판 탐색 | `POST /discover/ptz` / `GET /discover/status` `result` `frame`(JPEG) | `api/discoverRoutes.ts` |
| 렌즈 캘리브 | `POST /calibrate/lens/start` `stop` `apply` / `GET /calibrate/lens/status` `result` | `api/lensCalibRoutes.ts` |
| 옵션 | `GET/PUT /settings` | `api/settingsRoutes.ts` |
| DB 뷰어 | `GET /db/tables` `db/table/:name` (read-only·마스킹) | `api/dbRoutes.ts` |
| 뷰어·카메라 | `GET /viewer/api/cameras` `ptz` `snapshot`(JPEG) `stream`(MJPEG) `health` `camerapos` `llm/models` `rpc/catalog` / `POST move` `camera/login` `llm/select` `rpc` / `PUT camerapos` | `viewer/routes.ts` |
| 정적 | `GET /viewer` + `/viewer/*` SPA | 〃 |

### 1.3 재사용 가능한 규약 자산

| 자산 | 위치 | RPC화에서의 쓰임 |
|---|---|---|
| JSON-RPC 2.0 봉투·에러 객체 | `clients/CRpcClient.ts` | 응답 포맷·오류 코드 **동형** 유지(Unity 와 같은 모양) |
| `GET /rpc/catalog` | 〃 `getCatalog()` | 카탈로그 → **MCP 도구 자동 노출** 파이프라인(아키텍처 §8)에 그대로 연결 |
| `x-viewer-token` 게이트 | `viewer/routes.ts:321,368,431` | 변이 메서드 게이트로 재사용 |
| `parseOr400` / zod 스키마 | `api/routeHelpers.ts` + 각 라우트 | 메서드 `params` 스키마로 **그대로 이식**(재작성 금지) |
| 잡 점유 판정 클로저 | `index.ts:118` `lensCalib.isBusy` | 전역 `system.busy` 로 승격 → 모든 카메라 점유 메서드가 공유 |
| 파일 안전 규약 | `groundGridRoutes.ts`(`_auto`→`.bak`→정본), `roiSlotSync.ts`(차등·orphans) | 파괴적 RPC 의 가드 규약 원본 |

---

## 2. 목표 · 성공 기준

**목표** — 외부 프로그램이 브라우저 없이, 아래 셋팅 전 과정을 RPC 로 수행한다.

1. 주차면 자동생성(미완성 기능 포함) — 격자 부트스트랩 미리보기 → 승인 적용
2. 캘리브레이션 — 렌즈(화각·게인·곡면율) 실측·표 적용
3. 센터라이징 — 전체 배치 / 슬롯 단건 / 클릭 지점 조준
4. 주차면 그리기 — 면 추가·수정·삭제·검증·저장·되돌리기
5. 선택한 차량 번호판 위치 — 라이브 LPD → 지점 선택 → 슬롯 배정 → DB 저장
6. DB 컨트롤 — 조회·ROI 동기·초기화·재번호·배치 변경·점유/육면체 재생성

**성공 기준(검증 가능)**

- [ ] `GET /rpc/catalog` 가 노출 메서드 전량을 반환하고, 목록에 없는 메서드 호출은 `-32601`
- [ ] 같은 작업을 REST 와 RPC 로 각각 수행했을 때 **DB·파일 결과 바이트가 동일**(동일 서비스 함수 호출 증거)
- [ ] 파괴적 메서드는 가드 미충족 시 **파일·DB 무변경 + 고유 에러코드**(`-32005`)
- [ ] 헤드리스 시나리오 1종(빈 DB → ROI 로딩 → 자동격자 → 검출 → 센터라이징 → setup_result) 이 RPC 호출만으로 완주
- [ ] 기존 REST·웹 클라이언트 회귀 0 (vitest 전량 green, 라우트 응답 shape 불변)

---

## 3. 설계 원칙 (이 문서의 판단 기준)

| # | 원칙 | 근거 |
|---|---|---|
| P1 | **RPC 는 로직을 갖지 않는다.** 메서드 = 얇은 어댑터, 로직은 REST 와 공유하는 서비스 함수 | 저장소 규약(이중구현 금지). `ground-model`/`detect`/`CaptureJob` 이 `makeCuboidContextResolver` 하나를 공유하는 이유와 동일 |
| P2 | **가산·불변.** 기존 REST/웹 클라이언트는 이번 작업으로 한 줄도 안 바뀐다 | 모든 기존 라우트가 "주입 시에만 등록(가산)" 패턴 |
| P3 | **파괴적 조작에는 반드시 가드.** `confirm`/`expect*`/`dryRun` 없이 전량 교체 금지 | 실사고 2건 — 8면→7면 소실, `replaceSlotSetup` 로 센터링 23→0 |
| P4 | **위장 금지.** 못 한 일은 `skipped[]`/`issues[]` 로 드러내고 값을 만들지 않는다 | `slots/occupy`·`slots/cuboid` 의 기존 규약 |
| P5 | **바이너리·롱리브드는 RPC 밖.** JPEG/MJPEG 는 HTTP 유지, RPC 는 URL·메타만 | JSON-RPC 는 단건 요청/응답 모델 |
| P6 | **카메라는 하나뿐.** 카메라를 움직이는 메서드는 전역 배타 게이트를 공유 | `lensCalib.isBusy` 가 이미 부분적으로 함 |

---

## 4. 전송·규약 설계

### 4.1 엔드포인트

| 경로 | 메서드 | 설명 |
|---|---|---|
| `POST /rpc` | JSON-RPC 2.0 단건 | SettingAgent **자기 능력** |
| `GET /rpc/catalog` | — | `{ methods: [{name, title, mutating, params, requiresCamera}] }` |
| `POST /viewer/api/rpc` | (현행 유지) | Unity 13110 프록시 — **의미 불변**, 하위호환 |

> Unity 규약과 동형: `{"jsonrpc":"2.0","id":1,"method":"place.space.add","params":{...}}` → `{"jsonrpc":"2.0","id":1,"result":{...}}` 또는 `error:{code,message,data}`.
> 배치 요청(array)은 **초기 미지원**(잡 점유 순서 보장이 어려움). 필요해지면 읽기 전용 메서드만 허용.

### 4.2 네임스페이스

| 네임스페이스 | 관심사 | 정본(single source of truth) |
|---|---|---|
| `system.*` | 헬스·busy·카탈로그 | 런타임 |
| `cam.*` | 카메라·PTZ·프리셋(camerapos) | `config/camerapos.json` |
| `place.*` | 주차면 ROI 그리기·편집·자동보정 | `Place01/PtzCamRoi.json` |
| `grid.*` | 주차면 자동생성(지면 격자) | `data/ground_grid.json` + 정본 파일 |
| `slot.*` | DB 슬롯(로딩·동기·검출·점유·육면체·배치·재번호) | `data/setting.sqlite` |
| `plate.*` | 번호판 검출·선택·배정·탐색 | DB `slot_setup.lpd_obb` |
| `center.*` | 센터라이징 | DB `centering_slot` + `data/slot_ptz.json` |
| `lens.*` | 렌즈 캘리브레이션 | `data/lens_calibration.json` |
| `capture.*` | 수집·원버튼 파이프라인 | 잡 인메모리 → DB |
| `setup.*` | 매핑·아티팩트·최종 결과 | `data/setup_artifact.json`, `save/` |
| `db.*` | DB 뷰(read-only) | SQLite(독립 read-only 연결) |
| `unity.*` | 13110 패스스루 | Unity |

### 4.3 오류 코드 매핑 (현행 HTTP 상태 → RPC)

| RPC code | 이름 | 현행 HTTP | 의미 |
|---|---|---|---|
| `-32602` | INVALID_PARAMS | 400 | zod 검증 실패(`detail` 에 flatten 그대로) |
| `-32601` | METHOD_NOT_FOUND | — | 카탈로그에 없음 |
| `-32001` | BUSY | 409 (`pipeline busy`, `already running`) | 잡 점유 — **재시도로 풀림** |
| `-32005` | CONFLICT | 409 (`expectRawCount` 불일치, `sync-roi` slot_id 불일치) | 가드 거부 — **파일·DB 무변경**, 재시도해도 안 풀림 |
| `-32002` | NOT_FOUND | 404 | 파일·결과·테이블 없음 |
| `-32003` | UPSTREAM | 502 | 카메라·VPD·LPD 실패 |
| `-32004` | UNAVAILABLE | 501/503 | 미설정·미배선(`ground.enabled=false` 등) |
| `-32006` | FORBIDDEN | 403 | 토큰 불일치 / `allowMove=false` |
| `-32603` | INTERNAL | 500 | 그 외 |

> **BUSY 와 CONFLICT 를 분리하는 것이 이 표의 핵심이다.** 외부 컨트롤러의 재시도 정책이 갈린다(BUSY=백오프 재시도, CONFLICT=사람 개입).

### 4.4 인증

- 변이(mutating) 메서드: `viewer.controlToken` 설정 시 `x-viewer-token` 필수(기존 `/move`·`/rpc`·`camerapos` 게이트와 **동일 규칙**).
- 읽기 메서드: 무게이트(현행 REST 와 동일 수준).
- 카탈로그의 `mutating: true` 플래그가 게이트 대상 여부의 **단일 출처**.
- ⚠️ 미결정: `server.apiKeyEnv: "SETTING_API_KEY"` 가 config 에 선언돼 있으나 **현재 아무도 소비하지 않는다**. 외부 노출을 하려면 토큰 체계를 하나로 정해야 한다(§11 Q1).

### 4.5 장기 잡 규약

수집·센터라이징·탐색·렌즈캘리브는 **수 분~수십 분** 걸린다. RPC 는 단건 요청/응답이므로:

```
<domain>.start   → { ok, total, stage }      // 즉시 반환(비동기 시작)
<domain>.status  → { state, progress, ... }  // 폴링(기존 getStatus() 그대로)
<domain>.stop    → { ok, state }
system.busy      → { busy, who }             // 전역 점유자(카메라 배타)
```

- 상태 shape 은 **기존 `getStatus()` 반환값 그대로**(재정의 금지 — 웹 클라이언트와 동일 데이터).
- 진행 로그 푸시가 필요하면 **SSE(`GET /rpc/events`)를 별도 채널**로. RPC 안에 스트리밍을 넣지 않는다(P5).
- `lens.*` 는 이미 `sinceSeq` 증분 로그 규약이 있으므로 폴링만으로 충분하다.

### 4.6 Unity 패스스루

`unity.<method>` 로 들어오면 `CRpcClient.callRpc(<method>, params)` 로 전달하고, 카탈로그는 13110 `getCatalog()` 결과를 `unity.` 접두어로 병합한다. → **외부 컨트롤러는 엔드포인트 하나(13020 `/rpc`)만 알면 카메라 시뮬레이터까지 제어**한다. Unity 미기동 시 카탈로그 병합만 실패하고 나머지는 정상(graceful, 기존 규약).

---

## 5. 구현 아키텍처 — 이중구현을 어떻게 막는가

### 안 A. inject 브리지 (Fastify `app.inject()` 로 자기 라우트 호출)

- 장점: **코드 이동 0**, 회귀 위험 최소, 하루면 전 메서드 노출.
- 단점: HTTP 왕복 비용(로컬 인메모리라 미미), 바이너리 응답이 어색, 라우트 URL 이 사실상 계약으로 굳음, 에러코드 매핑이 상태코드 추론에 의존.

### 안 B. 서비스 추출 (핸들러 → 순수 서비스 함수, REST·RPC 가 공유)

- 장점: P1 을 구조적으로 보장, 스키마·에러가 1급 시민, 테스트가 서비스 단위로 쉬워짐.
- 단점: `captureRoutes.ts`(1105줄) 등 대공사, 회귀 위험.

### ✅ 권장: 하이브리드 (단계 분리)

| 단계 | 방식 | 대상 |
|---|---|---|
| Phase 1 | **안 A(inject)** | 읽기 전용 전량 + 위험 낮은 변이(`status`/`list`/`get`/`start`) — 즉시 외부 제어 가능 |
| Phase 2 | **안 B(추출)** | **정본을 쓰는 경로만**: `place.*`, `slot.*`, `grid.apply`, `setup.mapping.*` — 이미 `saveMappingHandler`/`renumberHandler`/`placementHandler` 는 **클로저로 추출돼 REST 2곳이 공유 중**이라 선례가 있다 |
| Phase 3 | 안 B | §7 승격 신규 서비스(웹 클라 전용 로직) |

> Phase 2 의 추출 순서는 **핸들러 본문이 이미 분리된 것부터**(`handleSlotsLpd`, `handleSlotsOccupy`, `handleSlotsCuboid`, `handleCaptureStart`, `handleStartPrecise`, `handleCaptureFinalize` …)。 `captureRoutes.ts` 는 이미 `registerXxx` + `handleXxx` 로 쪼개져 있어 **함수 시그니처만 `(deps, params)` 로 바꾸면 된다**.

---

## 6. RPC 노출 메서드 목록 (58)

> 범례 — **M**: 변이(토큰 게이트) · **C**: 카메라 점유(배타) · **D**: 파괴적(가드 필수)

### 6.1 `system.*` (4)

| 메서드 | params | 대응 현행 | 비고 |
|---|---|---|---|
| `system.ping` | — | — | RPC 평면 생존 확인(신규) |
| `system.health` | — | `GET /health` | camera/vpd/brain 상태 |
| `system.busy` | — | (신규, `lensCalib.isBusy` 승격) | `{busy, who}` — **모든 C 메서드의 선행 확인** |
| `system.catalog` | — | `GET /rpc/catalog` | 메서드 목록(자기 + `unity.*`) |

### 6.2 `cam.*` — 카메라·프리셋 (8)

| 메서드 | params | 대응 현행 | 플래그 |
|---|---|---|---|
| `cam.list` | `{source?}` | `GET /viewer/api/cameras` | |
| `cam.sources` | — | `GET /viewer/api/health` | 소스 id·kind·전송 |
| `cam.getPTZ` | `{source?, cam}` | `GET /viewer/api/ptz` | |
| `cam.move` | `{source?, cam, pan, tilt, zoom}` | `POST /viewer/api/move` | M C |
| `cam.gotoPreset` | `{source?, cam, preset}` | **웹 클라 `gotoPreset()` 승격** | M C |
| `cam.preset.list` | — | `GET /viewer/api/camerapos` | |
| `cam.preset.upsert` | `{camIdx, presetIdx, label, pan, tilt, zoom}` | **웹 클라 `savePreset()` 승격**(현행은 전량 PUT) | M |
| `cam.preset.delete` | `{camIdx, presetIdx}` | **웹 클라 `deletePreset()` 승격** | M |

### 6.3 `place.*` — 주차면 그리기 (11)

| 메서드 | params | 대응 현행 | 플래그 |
|---|---|---|---|
| `place.get` | `{camId?, presetIdx?}` | `GET /capture/place-roi` | raw 또는 정규화 옵션 |
| `place.spaces.list` | `{camId, presetIdx}` | (클라 `normalizePtzCamRoi`) | 정규화 결과를 **서버가** 반환 |
| `place.space.add` | `{camId, presetIdx, points[], idx?}` | **승격**(현행: 전량 PUT) | M |
| `place.space.update` | `{camId, presetIdx, idx, points[]}` | **승격** | M |
| `place.space.delete` | `{camId, presetIdx, idx, mode:'clear'\|'remove'}` | **승격** | M |
| `place.preset.clear` | `{camId, presetIdx, confirm:true}` | **승격**(`clearCurrentPresetSpaces`) | M D |
| `place.save` | `{camId, presetIdx, spaces[], expectRawCount?, create?}` | `PUT /capture/place-roi` | M D |
| `place.create` | `{camId, presetIdx, imageWidth, imageHeight, pan, tilt, zoom}` | **승격**(`buildPlaceSkeleton`) | M |
| `place.validateQuad` | `{camId, presetIdx, quad[4], imageWidth?, imageHeight?}` | `POST /capture/place-roi/validate` | 읽기 전용 |
| `place.revert` | `{backupFile?}` | **승격**(클라 undo 스택 → 파일 `.bak`) | M D |
| `place.backups` | — | (신규) | `.bak` 목록 |

> **`place.space.*` 가 이번 설계의 핵심 승격이다.** 현행 `PUT /capture/place-roi` 는 **프리셋을 통째 교체**한다 — 클라이언트가 전체 배열을 정확히 재구성해야 하고, 실패하면 조용히 주차면이 사라진다(2026-07-28 8면→7면 실사고). 외부 컨트롤러에 그 책임을 넘기면 같은 사고가 반복된다. 서버가 read-modify-write 를 원자적으로 수행해야 한다.

### 6.4 `place.align.*` — 카메라 틀어짐 자동보정 (3)

| 메서드 | params | 대응 현행 | 플래그 |
|---|---|---|---|
| `place.align.saveRef` | `{cam, preset}` | `POST /capture/refframe` | M C |
| `place.align.estimate` | `{cam, preset}` | `POST /capture/autocorrect` | C — `{dx,dy,scale,peak}` |
| `place.align.apply` | `{cam, preset, dx, dy, scale}` | **승격**(현행: 클라 `alignApply` 가 좌표 변환 후 PUT) | M D |

### 6.5 `grid.*` — 주차면 자동생성 (3)

| 메서드 | params | 대응 현행 | 플래그 |
|---|---|---|---|
| `grid.bootstrap` | `{camId, presetIdx, quad[4], cols, rows?, colStart?, rowStart?}` | `POST /capture/ground-grid/bootstrap` | 미리보기·**파일 무변경** |
| `grid.apply` | `+ {confirm:true, presets[], allowNew?, refSpaceIdx?}` | `POST /capture/ground-grid/apply` | M D — `_auto`→`.bak`→정본 3단 쓰기 |
| `grid.get` | — | `GET /capture/ground-grid` | 저장된 격자 |

> 미완성 기능이라는 점을 카탈로그에 **명시**한다(`stability: "experimental"`). 실측 미해결 항목: 실카(RTSP) 격자 스케일. 자동 승인(`confirm` 생략) 은 절대 허용하지 않는다(R-2 "사람이 항상 이긴다").

### 6.6 `slot.*` — DB 컨트롤 (10)

| 메서드 | params | 대응 현행 | 플래그 |
|---|---|---|---|
| `slot.list` | — | `GET /capture/slots` | `SlotSetupView[]` |
| `slot.roi.load` | `{confirm:true}` | `POST /capture/slots/load-roi` | M **D(전량 재구성 — 검출·점유·센터링 초기화)** |
| `slot.roi.sync` | — | `POST /capture/slots/sync-roi` | M — **비파괴 차등**(권장 기본값) |
| `slot.reset` | `{confirm:true}` | `POST /capture/slots/reset` | M D |
| `slot.occupy.build` | `{cam?, preset?}` | `POST /capture/slots/occupy` | M |
| `slot.cuboid.build` | `{heightM?}` | `POST /capture/slots/cuboid` | M |
| `slot.placement.update` | `{placements[]}` | `POST /mapping/placement` | M |
| `slot.renumber` | `{mapping[]}` | `POST /mapping/renumber` | M D |
| `slot.groundModel` | — | `GET /capture/ground-model` | 자동생성·육면체 근거(읽기) |
| `slot.occupancy.evaluate` | `{cam, preset, vehicles[]}` | **승격**(클라 `updateLogicOccupancy`) | 판정 로직 서버 이관 |

> ⚠️ `slot.roi.load` 와 `slot.roi.sync` 의 차이를 카탈로그 설명에 **반드시** 적는다. 라이브 대조 실측: 같은 편집에서 load = 센터링/vpd/점유 **23→0**, sync = **23→23 유지**. 외부 컨트롤러의 기본값은 `sync` 여야 한다.
> ⚠️ `sync` 는 FK 부모(place/camera/preset)를 만들지 않는다 — **빈 DB 첫 호출은 실패**(`FOREIGN KEY constraint failed`). 최초 1회는 `slot.roi.load` 로 부트스트랩(순서 제약을 카탈로그에 명시).

### 6.7 `plate.*` — 선택 차량 번호판 (6)

| 메서드 | params | 대응 현행 | 플래그 |
|---|---|---|---|
| `plate.detect` | `{cam, preset, ptz?}` | `POST /capture/detect`(vpdEnabled=false) | C — LPD quad 목록 |
| `plate.pickAt` | `{cam, preset, point{x,y}, tolerance?}` | **승격**(현재 `centerOnPoint` **내부**에만 존재) | C — 클릭 지점 최근접 번호판 + 후보 slotId |
| `plate.assign` | `{cam, preset, plates[]}` | `POST /capture/slots/lpd` | M — 공간배정 후 `slot_setup.lpd` 부분 UPDATE |
| `plate.discover.start` | `{slotIds?, cam?, preset?}` | `POST /discover/ptz` | M C |
| `plate.discover.status` | — | `GET /discover/status` | |
| `plate.discover.result` | — | `GET /discover/result` | |

> "선택한 차량 번호판 위치" 시나리오의 RPC 조합: `plate.detect` → (외부가 대상 선택) `plate.pickAt` → `plate.assign` → `center.point{mode:'plate-zoom'}` → `slot.occupy.build`.
> **VPD(차량) 자동검출은 기본 OFF 를 유지한다**(제품 정책). `vpdEnabled:true` 는 `detect.vehicles` 라는 **별도 메서드**로만 열어 실수로 켜지지 않게 한다(§8-13).

### 6.8 `center.*` — 센터라이징 (4)

| 메서드 | params | 대응 현행 | 플래그 |
|---|---|---|---|
| `center.start` | `{slotIds?}` | `POST /calibrate/ptz` | M C |
| `center.status` | — | `GET /calibrate/status` | |
| `center.result` | — | `GET /calibrate/result` | `slot_ptz.json` |
| `center.point` | `{cam, preset, point, mode:'point'\|'plate'\|'plate-zoom', source?}` | `POST /calibrate/point` | M C |

> `mode:'point'` 의 의미는 **"클릭 지점을 화면 중앙으로"(기하 오픈루프, pan/tilt only)** 다 — 확정된 정본 규약이므로 카탈로그 설명에 그대로 적는다.

### 6.9 `lens.*` — 렌즈 캘리브레이션 (5)

| 메서드 | params | 대응 현행 | 플래그 |
|---|---|---|---|
| `lens.start` | `{source, mode:'full'\|'verify'\|'distortion'}` | `POST /calibrate/lens/start` | M C — **수십 분 카메라 점유** |
| `lens.stop` | — | `POST /calibrate/lens/stop` | M |
| `lens.status` | `{sinceSeq?}` | `GET /calibrate/lens/status` | 증분 로그 |
| `lens.result` | `{source}` | `GET /calibrate/lens/result` | |
| `lens.apply` | `{source, enabled}` | `POST /calibrate/lens/apply` | M — `restartRequired:true` **반드시 전달** |

### 6.10 `capture.*` — 수집·파이프라인 (7)

| 메서드 | params | 대응 현행 | 플래그 |
|---|---|---|---|
| `capture.start` | `{count, intervalMs?, targets?, autoChain?, …}` | `POST /capture/start` | M C |
| `capture.startPrecise` | `{source?, skipCentering?}` | `POST /capture/start-precise` | M C |
| `capture.stop` | — | `POST /capture/stop` | M |
| `capture.status` | — | `GET /capture/status` | |
| `capture.pipeline` | — | `GET /capture/pipeline` | 단계 전이(discovering/calibrating…) |
| `capture.finalize` | `{occupancy?}` | `POST /capture/finalize` | M D |
| `capture.tour.start` / `.status` | `{}` | **승격**(클라 `runTouringTest`) | M C — 순회 검증 |

> `capture.finalize` 가 D 인 이유: `Finalizer.persistSlotSetupFromPlace` 가 `replaceSlotSetup`(DELETE+INSERT)를 부른다. 검출 컬럼은 가드가 있으나 **센터링 컬럼은 여전히 취약**하다(기록된 미해결 항목). RPC 는 이 사실을 카탈로그에 적고 `confirm` 을 요구한다.

### 6.11 `setup.*` — 매핑·결과 (7)

| 메서드 | params | 대응 현행 | 플래그 |
|---|---|---|---|
| `setup.mapping.get` | — | `GET /mapping` | 파일 우선 → DB 폴백 |
| `setup.mapping.save` | `{artifact}` | `PUT /mapping` | M |
| `setup.mapping.autoNumber` | `{dryRun?}` | **승격**(클라 `autoNumberManual`) | M — 전역번호 자동 부여 |
| `setup.slot.add` / `.delete` | `{afterSlotId?}` / `{slotId}` | **승격**(클라 `addSlot`/`deleteSelectedSlot`) | M |
| `setup.result.write` | — | `POST /capture/setup-result` | M — 이력본+고정본 |
| `setup.saves.list` | — | `GET /capture/saves` | |
| `setup.saves.load` / `.save` | `{name}` / `{name, artifact}` | `GET /capture/saves/:name`, `POST /capture/save` | M |

### 6.12 `db.*` — DB 조회 (2) · `config.*` (1)

| 메서드 | params | 대응 현행 | 비고 |
|---|---|---|---|
| `db.tables` | — | `GET /db/tables` | |
| `db.table.query` | `{name, search?, limit?, offset?}` | `GET /db/table/:name` | **read-only·화이트리스트·비밀번호 마스킹 유지** |
| `config.get` | — | `GET /settings` | 키 값 미노출 |

---

## 7. 웹 클라이언트에만 있는 능력 → 승격 목록

> "웹에서는 되는데 REST 에는 없다" = **외부에서 컨트롤 불가**. RPC화의 목적을 달성하려면 이 12건이 서버로 올라와야 한다.

| # | 웹 클라 위치 | 지금 서버에 없는 이유 | 승격 RPC | 서버 구현량 |
|---|---|---|---|---|
| 1 | `savePlaceRoi()` / `placeDrawClick()` / `deletePlaceSpace()` / `editPlaceIdx()` (`app.js:2486,2557,2320,2302`) | 편집 버퍼가 브라우저 메모리, 서버는 **프리셋 통째 교체**만 | `place.space.add/update/delete` | 중 — `applyPlaceRoiUpdateEx` 재사용 + 단건 병합 |
| 2 | `snapshotPlaceRoi()`/`undoPlaceRoi()`/`sealPlaceRoiUndo()` (`2333~2413`) | 되돌리기 스택이 브라우저 메모리 | `place.revert` / `place.backups` | 소 — `groundGridRoutes` 의 `.bak` 규약 재사용 |
| 3 | `alignApply()` (`2782`) | 서버는 **오프셋 추정만**, 좌표 적용은 클라 | `place.align.apply` | 소 — 순수 기하(이동·스케일) |
| 4 | `buildPlaceSkeleton()`/`needsPlaceSkeleton()` (`2652`) | 신규 주차장 골격 판단이 클라 | `place.create` | 소 — `PUT`의 `create` 필드 래핑 |
| 5 | `autoNumberManual()` (`4241`) | 전역번호 자동 부여가 클라 계산 | `setup.mapping.autoNumber` | 소 |
| 6 | `addSlot()`/`deleteSelectedSlot()` (`1455,1477`) | artifact 슬롯 편집이 클라 | `setup.slot.add/delete` | 중 — 전역 인덱스 정합 검증 |
| 7 | `savePreset()`/`deletePreset()`/`persistCamerapos()` (`1994,2017,1978`) | camerapos CRUD 가 클라 배열 편집 + 전량 PUT | `cam.preset.upsert/delete` | 소 — `writeCamerapos` 재사용 |
| 8 | `runTouringTest()` (`1876`) | 순회 루프가 클라 | `capture.tour.start/status` | 중 — 잡 1개 신설(카메라 배타) |
| 9 | `gotoPreset()`/`gotoHomePreset()` (`1844,3306`) | 프리셋 홈 이동이 "클라 조회 + move" 2단 | `cam.gotoPreset` | 소 |
| 10 | `updateLogicOccupancy()` + `web/occupancy.js` | 점유 **판정**이 클라 정본(→ finalize body 로 전달) | `slot.occupancy.evaluate` | 중 — 판정 로직 이식(생성식은 이미 서버에 `domain/occupancyRegion`) |
| 11 | `hitTestVpd()`/검출 선택 + `calPointCenter()` (`1418,3530`) | "클릭 지점 최근접 번호판" 진입점이 서버에 없음(내부에만 존재) | `plate.pickAt` | 소 — `PtzCalibrator` 내부 로직 노출 |
| 12 | `renderDbTable()` 페이징 상태 | (승격 불필요 — 이미 `db.table.query` 로 충분) | — | — |

**클라이언트에 남길 것(승격 대상 아님)** — 오버레이 렌더링(`drawRoiOverlay`/`drawCuboidOverlay`/`drawOccupancyOverlay` 등 10종), 캔버스 히트테스트·드래그 제스처, 프레임 프리즈·스트림 표시, 검출 박스 **임시**(비영속) 편집, 모달/탭/폼 상태, 파일 다운로드·업로드 다이얼로그. 이들은 **표시 계층**이라 서버 계약이 될 이유가 없다.

---

## 8. 제외 제안 (14건)

| # | 제외 대상 | 사유 | 대안 |
|---|---|---|---|
| 1 | `GET /viewer/api/stream` (MJPEG) | 롱리브드 멀티파트 — JSON-RPC 모델과 불일치 | 현행 HTTP 유지. RPC 는 `cam.streamUrl` 로 **URL 만** 반환 |
| 2 | `GET /viewer/api/snapshot`, `/capture/frame`, `/calibrate/frame`, `/discover/frame` (JPEG) | 바이너리. base64 로 감싸면 응답 수 MB·로그 오염 | HTTP 유지 + RPC 는 URL·`X-Cap-*` 메타 반환. 헤드리스가 정말 필요하면 `cam.snapshot{encoding:'base64', maxWidth}` 를 **옵트인·크기 상한**으로 별도 검토 |
| 3 | `GET /viewer` + `/viewer/*` 정적 SPA | 파일 서빙 | 그대로 |
| 4 | `POST /viewer/api/camera/login` | **자격증명 통과** — RPC 로그·카탈로그에 노출될 위험 | config(`cameraSources[].username/password`) 경유 유지. 실제로 `tools.config.json` 의 비밀번호는 **영구 미커밋** 상태로 관리 중 |
| 5 | 임의 SQL 실행(`db.exec` 류) | 원격 임의 쓰기 = 데이터 파괴 경로. read-only 뷰어의 설계 의도 파괴 | `db.table.query`(화이트리스트·바인딩·마스킹·limit≤1000)만 |
| 6 | `PUT /settings` | config 파일 대량 편집 + **재시작 필요**. 원격에서 바꾸면 런타임과 파일이 어긋난 채 방치됨 | `config.get`(읽기)만 노출. 쓰기는 사람이 웹 옵션 페이지에서 |
| 7 | `POST /viewer/api/llm/select`, `GET /viewer/api/llm/models` | 셋팅 제어와 무관한 운영 계열. LLM 은 이미 **최소 보조**로 축소된 정책 | 제외(필요 시 `ops.*` 별도 네임스페이스) |
| 8 | `GET /brain/ping`, `POST /brain/review`, `POST /capture/warmup` | 〃 (두뇌 진단·워밍업) | 제외 |
| 9 | `GET /capture/vehicle-cuboids`, `GET /capture/job-cuboids` | **뷰어 렌더 전용** 대용량 진단 응답(차량별 육면체·assoc·mask). 외부 제어에 쓸 일이 없고 `vehicle-cuboids` 는 카메라를 뺏는다 | 제외. 근거가 필요하면 `slot.groundModel` 로 충분 |
| 10 | `GET /capture/aggregate`, `GET /capture/occupancy` | 잡 인메모리 진단(수집 중에만 의미). LLM off 시 `[]` | 낮은 우선순위 — 필요해지면 `capture.diag.*` 로 별도 |
| 11 | `POST /setup/run`, `POST /setup/run-from-map`, `GET /setup/status` | **레거시 오케스트레이터**. 현행 정본은 `capture.startPrecise` 파이프라인 | 신규 RPC 미노출(동결). REST 는 유지 |
| 12 | `POST /setup/export-camerapos` | `presetProvider` 가 `camerapos`(수동)면 항상 400. 현재 config 상 무의미 | 제외(공급자 도입 시 재검토) |
| 13 | VPD 자동검출(`vpdEnabled:true`)을 일반 `detect` 파라미터로 노출 | **자동검출 금지가 확정 정책**(기본 OFF). 파라미터로 열면 외부가 실수로 켠다 | `detect.vehicles` 라는 **별도 메서드 + 명시적 확인**으로만 |
| 14 | JSON-RPC **배치 요청**·`notification`(id 없는 호출) | 잡 점유 순서·부분 실패 보고가 모호 | 초기 미지원. 필요 시 읽기 전용 메서드로 한정 |

---

## 9. 안전 규약 (파괴적 메서드)

| 메서드 | 파괴 범위 | 필수 가드 |
|---|---|---|
| `slot.roi.load` | `slot_setup` 전량 재구성 — 검출·점유·센터링 소실 | `confirm:true` + 응답에 `willClear` 예상치. **기본 경로는 `slot.roi.sync`** 로 유도 |
| `slot.reset` | 검출·센터링 컬럼 비움 | `confirm:true` |
| `slot.renumber` | `slot_id` 재번호 + 파일 3종 전파 | 기존 검증(`validateRenumberMapping`) → 실패 시 **DB 무변경** |
| `capture.finalize` | `replaceSlotSetup` 경유 | `confirm:true` + **센터링 컬럼 취약성** 경고를 카탈로그에 명시 |
| `place.save` / `place.preset.clear` | 프리셋 통째 교체 | `expectRawCount`(로드 시점 **원시** 개수) — 불일치 시 `-32005` + 파일 무변경 |
| `place.align.apply` | 좌표 일괄 이동·스케일 | 적용 전 `.bak` 자동 생성 → `place.revert` 가능 |
| `grid.apply` | 정본 갱신 | `confirm:true` + `_auto`→`.bak`→정본 3단 쓰기(기존) + G1~G4 게이트 |

**공통 규약**
- 수치 영속화는 **소수점 최대 5자리**(`round5`/`stringify5`) — RPC 응답도 동일 규약을 따른다.
- 카메라 점유 메서드(C)는 진입 시 `system.busy` 를 확인하고 점유 중이면 `-32001` + `who`.
- 부분 성공은 `{ok:true, updated, skipped[], issues[]}` 로 드러낸다. **없는 값을 만들지 않는다.**
- 순서 제약(빈 DB → `slot.roi.load` 먼저)은 카탈로그 `preconditions` 필드로 기계 판독 가능하게 적는다.

---

## 10. 로드맵 · 검증

| Phase | 산출물 | 검증 |
|---|---|---|
| **0. 규약** | `POST /rpc`·`GET /rpc/catalog` 스켈레톤, `system.*`, `unity.*` 패스스루, 에러 매핑 표 | vitest: 봉투·에러코드·미등록 메서드 `-32601`. 라이브: `curl` 로 `system.ping`·`unity.cam.list` |
| **1. 읽기·저위험** | `*.status`/`*.list`/`*.get` 전량 + `capture.*`/`center.*`/`lens.*`/`plate.discover.*` start·stop (inject 브리지) | vitest: REST 응답 == RPC `result` **동등성 테스트**. 라이브: 웹 UI 와 나란히 동작 |
| **2. 정본 쓰기** | `place.*`·`slot.*`·`grid.*`·`setup.mapping.*` 서비스 추출 + RPC/REST 공유 | vitest: 서비스 단위 + 가드(`-32005` 시 파일·DB 무변경 바이트 비교). 라이브: 실제 DB 로 sync/load 대조(23→23 vs 23→0 재현) |
| **3. 클라 승격** | §7 의 12건 신규 서비스 + (선택) 웹 클라를 `/rpc` 로 이관 | vitest + 라이브 시나리오 완주(빈 DB → setup_result) |
| **4. 확장(선택)** | 카탈로그 → **MCP 도구 자동 노출**(아키텍처 §8), SSE 이벤트 채널 | MCP 클라이언트로 셋팅 1회 완주 |

**헤드리스 완주 시나리오(수용 테스트)**

```
system.health → place.create → place.space.add ×N → place.validateQuad
→ grid.bootstrap → grid.apply{confirm} → slot.roi.load{confirm}
→ slot.roi.sync → plate.detect → plate.pickAt → plate.assign
→ slot.occupy.build → slot.cuboid.build → center.start → center.status(폴링)
→ setup.mapping.autoNumber → slot.renumber → setup.result.write
```

---

## 11. 영향도 분석

| 대상 | 영향 | 근거 |
|---|---|---|
| 기존 REST 76 라우트 | **무변경**(Phase 2 에서 핸들러 본문이 서비스 함수 호출로 바뀌지만 **응답 shape 불변**) | P2. `saveMappingHandler`/`renumberHandler` 가 이미 REST 2곳에서 공유되는 선례 |
| `web/` 웹 클라이언트 | Phase 0~2 **무변경**. Phase 3 이관은 선택 | 웹은 REST 를 그대로 호출 |
| `src/mcp/server.ts` | 가산 — 카탈로그를 소비해 `setting_*` 도구 자동 등록 가능 | 현재 도구 5개(`camera_*`/`vpd_detect`/`unity_rpc*`) 뿐 |
| `CRpcClient` | 무변경(클라이언트 역할 그대로) | 서버 측은 별도 디스패처 |
| 포트·배포 | 신규 포트 0 — 13020 에 경로 2개 추가 | |
| 보안 표면 | **증가**. 토큰 미설정(`controlToken: ""`) 상태로 외부 개방하면 무인증 원격 제어 | §11 Q1 결정 필요 |
| 테스트 | 신규 vitest 파일 추가(기존 3142 green 유지 전제) | |
| 성능 | inject 브리지는 인메모리 왕복 — 무시 가능. 카탈로그는 Unity 미기동 시 부분 실패(graceful) | |

---

## 12. 미결정 사항 (마스터 판단 필요)

| # | 질문 | 선택지 | 권장 |
|---|---|---|---|
| Q1 | 인증 체계 | (a) `viewer.controlToken` 재사용 (b) 미사용 상태인 `SETTING_API_KEY` 활성화 (c) 둘 다 | **(a) 먼저**, 외부망 노출 시 (b) 승격 |
| Q2 | 경로 | (a) `POST /rpc`(루트) (b) `/api/rpc` (c) `/viewer/api/rpc` 에 합침 | **(a)** — Unity 13110 과 동형, 프록시와 의미 분리 |
| Q3 | `unity.*` 패스스루 포함 | 포함 / 제외 | **포함** — 외부는 엔드포인트 1개만 알면 됨 |
| Q4 | 프레임 base64 | 전면 금지 / 상한 옵트인 | **상한 옵트인 검토**(헤드리스 시각 검증용, 기본 off) |
| Q5 | 웹 클라 `/rpc` 이관 | Phase 3 에서 이관 / REST 유지 | **REST 유지**(회귀 위험 대비 이득 작음). 신규 기능만 RPC |
| Q6 | 이벤트 채널 | 폴링만 / SSE 추가 | **폴링 먼저**(기존 status 규약이 이미 충분) |
| Q7 | `grid.*` 노출 시점 | 지금(experimental) / 실카 검증 후 | **지금 + experimental 표기** — 미완성 사실을 카탈로그가 말하게 |

---

## 부록 A. 현행 라우트 → RPC 매핑 전량 (커버리지 확인용)

| 현행 | RPC | 판정 |
|---|---|---|
| `GET /health` | `system.health` | 노출 |
| `GET /brain/ping`, `POST /brain/review` | — | **제외**(§8-8) |
| `POST /setup/run`, `run-from-map`, `GET /setup/status` | — | **제외**(§8-11 레거시) |
| `POST /setup/export-camerapos` | — | **제외**(§8-12) |
| `GET/PUT /mapping` | `setup.mapping.get/save` | 노출 |
| `POST /mapping/renumber`, `placement` | `slot.renumber`, `slot.placement.update` | 노출 |
| `POST /capture/start`, `start-precise`, `stop`, `finalize` | `capture.start`, `startPrecise`, `stop`, `finalize` | 노출 |
| `POST /capture/warmup` | — | **제외**(§8-8) |
| `GET /capture/status`, `pipeline` | `capture.status`, `capture.pipeline` | 노출 |
| `GET /capture/aggregate`, `occupancy` | — | **보류**(§8-10) |
| `GET /capture/frame` | — | **제외**(§8-2) |
| `GET /capture/slots` | `slot.list` | 노출 |
| `POST /capture/slots/reset`, `load-roi`, `sync-roi` | `slot.reset`, `slot.roi.load`, `slot.roi.sync` | 노출(D) |
| `POST /capture/slots/lpd`, `occupy`, `cuboid` | `plate.assign`, `slot.occupy.build`, `slot.cuboid.build` | 노출 |
| `POST /capture/save`, `setup-result` / `GET /capture/saves`, `saves/:name` | `setup.saves.save`, `setup.result.write`, `setup.saves.list/load` | 노출 |
| `GET/PUT /capture/place-roi`, `POST place-roi/validate` | `place.get`, `place.save`, `place.validateQuad` | 노출(D) |
| `GET /capture/ground-model` | `slot.groundModel` | 노출 |
| `GET /capture/vehicle-cuboids`, `job-cuboids` | — | **제외**(§8-9) |
| `POST /capture/refframe`, `autocorrect` | `place.align.saveRef`, `place.align.estimate` | 노출 |
| `POST /capture/detect` | `plate.detect` / `detect.vehicles`(분리) | 노출(§8-13) |
| `GET /capture/ground-grid`, `POST bootstrap`, `apply` | `grid.get`, `grid.bootstrap`, `grid.apply` | 노출(D·experimental) |
| `POST /calibrate/ptz`, `point` / `GET status`, `result` | `center.start`, `center.point`, `center.status`, `center.result` | 노출 |
| `GET /calibrate/frame` | — | **제외**(§8-2) |
| `POST /calibrate/lens/*`, `GET /calibrate/lens/*` | `lens.*` 5종 | 노출 |
| `POST /discover/ptz`, `GET status`, `result` | `plate.discover.*` | 노출 |
| `GET /discover/frame` | — | **제외**(§8-2) |
| `GET /settings` / `PUT /settings` | `config.get` / — | 부분(§8-6) |
| `GET /db/tables`, `db/table/:name` | `db.tables`, `db.table.query` | 노출(read-only) |
| `GET /viewer/api/cameras`, `ptz`, `health` | `cam.list`, `cam.getPTZ`, `cam.sources` | 노출 |
| `POST /viewer/api/move` | `cam.move` | 노출 |
| `GET/PUT /viewer/api/camerapos` | `cam.preset.list` / `cam.preset.upsert/delete` | 노출(승격) |
| `GET /viewer/api/snapshot`, `stream` | — | **제외**(§8-1,2) |
| `POST /viewer/api/camera/login` | — | **제외**(§8-4) |
| `GET/POST /viewer/api/llm/*` | — | **제외**(§8-7) |
| `POST /viewer/api/rpc`, `GET rpc/catalog` | (현행 유지) + `unity.*` | 유지·병합 |
| `GET /viewer`, `/viewer/*` | — | **제외**(§8-3) |
| — (웹 클라 전용 12건) | §7 승격 목록 | **신규** |

## 부록 B. 카탈로그 엔트리 스키마(제안)

```jsonc
{
  "name": "slot.roi.sync",
  "title": "ROI 정본 → DB 차등 동기(비파괴)",
  "mutating": true,
  "destructive": false,
  "requiresCamera": false,
  "stability": "stable",              // stable | experimental
  "preconditions": ["slot_setup 부트스트랩 완료(최초 1회는 slot.roi.load)"],
  "params": { /* zod → JSON Schema 변환 */ },
  "errors": [-32005, -32002, -32004]
}
```

> 이 스키마 하나가 **RPC 카탈로그 · MCP 도구 정의 · 외부 문서**의 공통 원천이 된다(§10 Phase 4).
