# 뷰어 카메라 제어 Unity 13110 JSON-RPC 전환 — RpcCameraSource

- 작성일: 2026-07-12 12:07:14
- 범위: SettingAgent 뷰어(카메라 목록·PTZ 이동·스냅샷)의 백엔드 소스 어댑터 교체
- 산출물 근거: `_workspace/01_architect_plan.md`(설계) · `02_developer_changes.md`(구현) · `03_qa_report.md`(검증) + 실제 변경 소스

---

## 1. 배경

- **13100 REST 서버가 완전히 다운**되었고, 앞으로는 **Unity 13110 단일 서버**만 사용한다(사용자 확정).
  - 13110 = `/rpc`(JSON-RPC 2.0) + `/stream`(MJPEG, PTZ 쿼리 지원).
- 13110 에는 REST 엔드포인트 `/cameras`·`/req_move`·`/req_img` 가 **없다(404)**. 이 때문에 뷰어가 부분적으로 깨져 있었다:
  - 카메라 드롭다운 빈값 — `listCameras()` → `/cameras` **404**.
  - 이동 안 됨 — `move()` → `/req_move` **404**.
  - 스냅샷 폴링 실패 — `snapshot()` → `/req_img` **404**.
  - **스트리밍(`/stream`)만 정상** (camera.baseUrl 이 이미 13110 을 가리킴).
- 목표: 뷰어의 **카메라 목록·PTZ 이동·스냅샷을 JSON-RPC 로 전환**하고, 스트림은 현행 유지. (cars/scene/measure 등 나머지 제어는 기존 RPC 콘솔이 커버 — 이번 범위 밖.)

---

## 2. 설계·구현 요약

### 2.1 채택 아키텍처

`CameraSource` 추상화를 그대로 유지하고, **신규 `RpcCameraSource`(kind:'rpc')** 를 추가해 **기본 소스만 교체**했다.

- 뷰어 라우트(`/viewer/api/cameras·move·snapshot·stream`)와 프론트(`web/app.js`, `web/index.html`)는 **무변경**(계약 동일). 변경은 소스 어댑터 계층 내부에 국한.
- `RpcCameraSource` 는 두 개의 기존 클라이언트를 **주입**받아 재사용한다:
  - `CRpcClient`(`/rpc`) — list/move/snapshot 을 JSON-RPC 로.
  - `CameraClient`(`/stream`) — `streamMjpeg` 만 위임(정상 동작하는 13110 스트림 재사용).

**대안(프론트를 직접 RPC 호출로 재작성)은 기각.** app.js 전반(카메라/프리셋/스냅샷/이동)을 RPC 로 다시 써야 하고 라우트 계약·스트림 프록시·인덱스 정합을 프론트로 흩뿌리게 되어 변경면이 크다. 소스 어댑터 방식이 외과적(라우트/프론트 무변경)이라 채택.

### 2.2 신규 클래스 — `RpcCameraSource` (`src/viewer/RpcCameraSource.ts`)

- `implements CameraSource`, `readonly kind = 'rpc'`.
- 생성자: `constructor(private rpc: CRpcClient, private camera: CameraClient)`.
- 단위 변환은 **항등(identity)**: 뷰어 PTZ(pan/tilt 도, zoom 1~36) = Unity `cam.setPTZ`/`getPTZ` 단위 동일 가정(설계서 §7-1, 리더 실측상 성립).

### 2.3 메서드 매핑 표

| CameraSource 메서드 | RPC/위임 매핑 | 반환 처리 |
|---|---|---|
| `listCameras()` | `cam.list {}` + `preset.list {}` | `camIdx=camId`, `enabled:true`, 프리셋을 `camIdx` 로 그룹핑. 프리셋 항목 `{presetIdx=idx, label=presetName}` — **주차면 프리셋이라 카메라 PTZ 없음 → pan/tilt/zoom omit(undefined)**. |
| `move(cam, ptz)` | `cam.setPTZ {camId, pan, tilt, zoom}` | `res.ok === true` → boolean. zoom 은 `camera.clampZoom`(1~36) 적용. |
| `snapshot(cam, opt)` — manual | `cam.setPTZ {…}` 선적용 → `cam.captureJPG {camId}` | `img_bytes`(base64) → `Buffer`. ptz = **요청값 echo**. |
| `snapshot(cam, opt)` — preset | `preset.select {idx}` → `cam.captureJPG {camId}` | ptz = `cam.getPTZ {camId}`(실패 시 `{0,0,1}` UNKNOWN 강등). |
| `streamMjpeg(cam, preset, signal, ptz?)` | `camera.streamMjpeg(...)` **위임** | 13110 `/stream` 현행 재사용(무변경). |
| `toNativePtz` / `fromNativePtz` | 항등 | 단위 동일 가정. |
| `login?` | 미구현(omit) | sim 과 동일 — RealPtz 전용. |

**listCameras 조립 규칙:** `cam.list.cameras` 각 항목 → `{ camIdx: camId, name: name ?? "C{camId}", enabled: true, presets }`. `preset.list` 를 `camIdx` 로 그룹핑하되, `camIdx` 없는 프리셋은 스킵(방어적 파싱). presetName/name 누락 시 `C{camIdx}` / `C{camIdx}-P{idx}` 폴백 라벨. camId·idx 모두 1-based → camIdx·presetIdx 항등 매핑.

**snapshot 반환 ptz:** manual 은 요청값 echo(시뮬 응답 PTZ 는 신뢰 안 함 — REST 시절과 동일), preset 은 `cam.getPTZ` 결과(부분 필드 결측 시 그 필드만 폴백).

### 2.4 소스 등록 변경 (`src/viewer/sourceRegistry.ts`)

- `cameraSources` **미설정/빈배열** → 기본 폴백을 **sim → rpc** 로 교체:
  `new RpcCameraSource(new CRpcClient(cfg.unityRpc), new CameraClient(cfg.camera))` (id=`'rpc'`).
- 시그니처를 `Pick<ToolsConfig,'camera'|'cameraSources'>` → `Pick<...,'camera'|'cameraSources'|'unityRpc'>` 로 확장. `index.ts` 는 `buildSourceRegistry(tools)` 로 전체를 전달하므로 **무변경**.
- 명시 `cameraSources` 의 **sim/hucoms 분기는 보존**(삭제 금지 — 명시 config 용, 외과적 유지).

### 2.5 kind 유니온 확장 (`src/viewer/CameraSource.ts`)

- `readonly kind: 'sim' | 'hucoms'` → `'sim' | 'hucoms' | 'rpc'` (1줄).

---

## 3. 데이터 흐름

```
브라우저
  → /viewer/api/(cameras | move | snapshot)   [라우트 무변경]
      → RpcCameraSource
          → CRpcClient.callRpc  →  Unity 13110  POST /rpc   (JSON-RPC 2.0)

브라우저
  → /viewer/api/stream                          [라우트 무변경]
      → RpcCameraSource.streamMjpeg (위임)
          → CameraClient.streamMjpeg  →  Unity 13110  GET /stream   (MJPEG)
```

- 제어(list/move/snapshot)는 `/rpc`, 스트림만 `/stream`. 두 경로 모두 13110 단일 서버.
- 뷰어의 수동 카메라 제어는 **결정형 제어 평면**(사용자 클릭 → RPC 호출의 1:1 매핑). LLM 두뇌 개입 없음, 기존 MCP `unity_rpc`/`unity_rpc_catalog` 툴과 독립.

---

## 4. RPC 계약 (리더 실측)

`CRpcClient.callRpc(method, params)` 는 `POST /rpc` 로 JSON-RPC 2.0 봉투(`{jsonrpc:"2.0", id, method, params}`)를 보내고 `result` 를 반환한다. Unity 가 `error` 를 반환하면 `RpcClientError(kind='rpc_error')`, 연결 실패 시 `kind='connection_error'` 를 throw.

| method | params | 결과(사용 필드) |
|---|---|---|
| `cam.list` | `{}` | `{ cameras: [{ camId, name, pan?, tilt?, zoom? }] }` |
| `preset.list` | `{}` | `[{ idx, presetName?, camIdx? }]` (주차면 프리셋, 카메라 PTZ 없음) |
| `cam.setPTZ` | `{ camId, pan, tilt, zoom }` | `{ ok: boolean }` |
| `cam.captureJPG` | `{ camId }` | `{ img_bytes: base64 }` |
| `cam.getPTZ` | `{ camId }` | `{ pan?, tilt?, zoom? }` |
| `preset.select` | `{ idx }` | (best-effort) |

- 파라미터 구분: 카메라는 `camId`(1-based), 프리셋은 `idx`. 뷰어 인덱스와 1-based 항등.

---

## 5. 프리셋 의미 변화 (핵심 결정)

- **카메라 PTZ 프리셋이 부재**(cam.applyPreset → "프리셋 없음"). 그래서 뷰어 프리셋 드롭다운은 이제 **주차면(parking) 프리셋**을 표시한다.
- 프리셋 항목에 pan/tilt/zoom 이 없으므로 프론트 `findPresetPtz()` → undefined → `gotoPreset()` 이 기존 폴백 경로(preset 모드 스냅샷)를 탄다. **프론트 무변경으로 동작**.
- preset 모드 snapshot 에서 `preset.select {idx}` 를 호출해 Unity 의 활성 주차면을 프론트 선택과 동기화. 카메라 각도는 사용자가 PTZ 슬라이더/버튼(→ `cam.setPTZ`)으로 수동 조정.

---

## 6. 검증 결과 (03 검증 리포트 인용)

**전체 통과.** 실행되지 않은 항목은 아래 §7 에 그대로 명시한다.

- `npx vitest run test/rpcCameraSource.test.ts` → **22/22 통과**(신규).
- `npx vitest run`(전체) → **113 파일 / 1153 테스트 전부 통과**(직전 대비 +22).
- `npx tsc --noEmit` → **exit 0(통과)**.

신규 `test/rpcCameraSource.test.ts` 22건 구성(외부 RPC/Camera 모킹):
- listCameras 5건(camIdx/presetIdx/label 정합, camIdx 그룹핑, **pan/tilt/zoom omit**, 빈 params 호출, 폴백 라벨, 방어적 파싱).
- move 4건(`{camId,pan,tilt,zoom}` 인자 정합, `ok:true→true`/`false·부재→false` 엄격, clampZoom(36)).
- snapshot manual 3건(setPTZ→captureJPG 순서·인자, base64→Buffer, ptz 요청 echo, 기본 `{0,0,1}`, img_bytes 누락 시 빈 Buffer).
- snapshot preset 4건(preset.select→getPTZ→captureJPG 순서·인자, ptz=getPTZ, 기본 idx:1, **getPTZ 실패 시 `{0,0,1}` 강등**, 부분 필드 결측만 폴백).
- RPC 에러 전파 3건(cam.list/setPTZ/captureJPG throw → 각 메서드 전파, 강등 안 함).
- PTZ 항등 1건, streamMjpeg 위임 2건(cam/preset/signal/ptz 인자 그대로, ptz 미제공 시 undefined).

**경계면 교차 비교**(03): `RpcCameraSource` 의 `CameraList`/`SnapshotResult` shape 이 인터페이스 및 sim 소스 산출물과 동일 → 프론트 드롭다운 동작 무변경. 라우트 `catch` 는 `err instanceof CameraApiError ? err.message : String(err)` 로 502 매핑 — `RpcClientError` 는 `CameraApiError` 가 아니므로 `String(err)` 로 **502 정상 노출**.

**리더 라이브 실증**(유닛테스트 대체분): cameras 조립 확인, move `cam.setPTZ` pan=20 반영, snapshot 유효 JPEG, stream 28프레임, `health.sources = ['rpc']`.

---

## 7. 한계 / 후속

- **실 원격 Unity 13110 RPC 스모크는 유닛테스트에 미포함** — 외부 서비스 모킹으로 어댑터 로직만 검증했고, 실 연동은 위 리더 라이브 실증으로 대체(중복 불필요). 완전한 자동화 스모크는 없음.
- **카메라 PTZ 프리셋(cam.savePreset/applyPreset) 미사용** — 현재 주차면 프리셋만 존재. 프리셋 선택은 주차면 `preset.select` 의미이며, 카메라 PTZ 프리셋 UI 는 후속.
- **PTZ 단위 항등 가정** — 뷰어 zoom 1~36·pan/tilt 도 = Unity 단위. 리더 실측상 항등 성립. 실측 범위 상이 시 `toNativePtz` 매핑 추가 필요.
- **`cam.create` UI 미노출** — 카메라 1대뿐이라 이번 범위 제외. 다중 카메라 등록 UI 필요 시 후속.
- cars/scene/measure 등 나머지 제어는 기존 RPC 콘솔로 다룬다(이번 범위 밖).

---

## 8. 사용 메모

- **이제 13110 만 있으면 된다.** `camera.baseUrl`·`unityRpc.baseUrl` 모두 13110 을 가리키며 config 값 변경은 없다(이미 정합).
- 명시 `cameraSources` 를 설정하지 않으면 자동으로 rpc 소스가 기본 등록된다.

---

## 9. 변경 파일 목록

| 파일 | 변경 |
|---|---|
| `src/viewer/CameraSource.ts` | kind 유니온에 `'rpc'` 추가(1줄) |
| `src/viewer/RpcCameraSource.ts` | **신규** — CameraSource 구현 |
| `src/viewer/sourceRegistry.ts` | 기본 폴백 sim→rpc, 시그니처에 unityRpc 추가, sim/hucoms 분기 보존 |
| `test/rpcCameraSource.test.ts` | **신규** — 22건 |
| `test/sourceRegistry.test.ts` | 기본 폴백 기대값 sim→rpc |
| `test/viewerEnabled.test.ts` | `health.sources` `['sim']`→`['rpc']`, 호출부 unityRpc 전달 |
| `test/mappingDirect.test.ts`, `test/mappingPut.test.ts` | `buildSourceRegistry` 호출부에 unityRpc 추가(1줄) |

상세 영향도는 `_workspace/04_doc_impact.md` 참조.
