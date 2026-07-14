# 정밀수집·검출·캘리브레이션 카메라 호출 Unity 13110 RPC 전환 (RpcCameraClient)

- 작성일시: 2026-07-12 23:27 (KST)
- 대상 서비스: SettingAgent
- 신규: `src/clients/RpcCameraClient.ts`, `test/rpcCameraClient.test.ts`, `test/fixtures/camerapos.rpc.json`
- 변경: `src/clients/CameraClient.ts`(ICameraClient 추출), `src/index.ts`(주입 교체), 소비처 7개 타입 표기 교체
- 근거 산출물: `_workspace/01_architect_plan.md`, `_workspace/02_developer_changes.md`, `_workspace/03_qa_report.md`

---

## 1. 배경 — 왜 필요했나

Unity 시뮬레이터의 카메라 포트 구성이 바뀌면서 **13100(REST)가 죽고 13110(JSON-RPC + MJPEG 스트림)만 가동**하는 상태가 되었다. 그런데 SettingAgent는 다음과 같은 어긋난 배선을 갖고 있었다.

- `tools.config.json`의 `camera.baseUrl = http://localhost:13110`
- `index.ts`가 `new CameraClient(tools.camera)`로 **REST 클라이언트**를 만들어 주입
- REST `CameraClient`는 `/req_img`·`/req_move`·`/cameras`·`/health` 경로를 호출하는데, 이 경로들은 13110에 존재하지 않음 → **전부 404**

그 결과, 이 주입 `camera`를 소비하는 다음 기능이 전부 깨졌다.

- 정밀수집(`CaptureJob`) — move + requestImage
- 라이브 검출(`detectPipeline`) — listCameras + requestImage + clampZoom
- 캘리브레이션(`PtzCalibrator`) — requestImage + clampZoom
- 마감(`Finalizer`) — listCameras (preset PTZ 결합 저장)
- `SetupOrchestrator`(단발 셋업), server `/setting/health`(카메라 ping)

반면 **뷰어 스트림 경로만 정상**이었다. 뷰어는 별도 `RpcCameraSource`/`CameraposSource`를 쓰고, 스트림은 `CameraClient.streamMjpeg`(13110 `/stream`)에 위임하기 때문이다. 즉 죽은 REST 클라이언트에서 실제로 살아있던 메서드는 `streamMjpeg` 하나뿐이었다.

---

## 2. 해결 개요

정밀수집·검출·캘리브레이션의 **소비 로직을 건드리지 않고** 카메라 I/O만 13110 RPC로 갈아끼우는 것이 목표였다. 세 가지로 구성했다.

1. **`ICameraClient` 인터페이스 추출** — `CameraClient`의 공개 6메서드(`clampZoom`/`health`/`requestImage`/`streamMjpeg`/`listCameras`/`move`)를 인터페이스로 뽑음.
2. **`RpcCameraClient` 신규** — `ICameraClient`를 13110 `/rpc`로 구현. 내부에 REST `CameraClient` 하나를 `inner`로 보유해 `clampZoom`·`streamMjpeg`만 위임(로직 중복 0).
3. **`index.ts` 주입 교체** — `new CameraClient(...)` → `new RpcCameraClient({ rpc, cameraCfg, cameraposFile })`. 소비처는 **타입 표기만** `CameraClient` → `ICameraClient`로 교체(호출부·동작 불변).

### 인터페이스 추출이 불가피했던 이유

`CameraClient`는 `private readonly baseUrl`·`private cfg`를 가진다. TypeScript는 private 멤버가 있는 클래스를 **명목적(nominal)** 으로 취급하므로, 동일한 공개 메서드를 가진 `RpcCameraClient`라도 `CameraClient` 타입 변수에 대입할 수 없다. 따라서 공개면을 인터페이스로 분리하고 소비처가 그 인터페이스에 의존하도록 표기만 바꿨다. `Pick<CameraClient, ...>`를 쓰던 소비처(`detectPipeline`, `Finalizer`)는 `Pick`이 private를 떨궈 **구조적 타입**이 되므로 표기 변경조차 필요 없었다.

---

## 3. RPC 매핑표

죽은 13100 REST → 13110 `/rpc` 매핑. RPC 인자 키는 뷰어 `RpcCameraSource`와 동일하게 `camId`(1-based, camIdx 그대로 전달).

| ICameraClient 메서드 | 기존(죽은 REST) | 신규 RPC 매핑 |
|---|---|---|
| `health()` | `GET /health` | `system.ping({})` 성공→true, 예외→false(장애 격리) |
| `move(cam,pan,tilt,zoom)` | `POST /req_move` | `cam.setPTZ({camId,pan,tilt,zoom:clampZoom})` → `res.ok===true` |
| `requestImage(cam,preset,ptz?)` | `POST /req_img` | ptz 있으면 `cam.setPTZ` 선행 → `cam.captureJPG({camId})` (+ptz 미제공 시 `cam.getPTZ` echo) |
| `listCameras()` | `GET /cameras` | **camerapos.json** fresh read → `parseCameraViews` + `buildCameraList`(프리셋 PTZ 포함) |
| `clampZoom(z)` | 자체 로직 | `inner.clampZoom(z)` 위임(REST 클래스 로직 재사용) |
| `streamMjpeg(...)` | `GET /stream` | `inner.streamMjpeg(...)` 위임(13110 `/stream`은 살아있음) |

### 실측 RPC 계약

| method | params | result |
|---|---|---|
| `system.ping` | `{}` | `{}` |
| `cam.setPTZ` | `{camId,pan,tilt,zoom}` | `{ok}` |
| `cam.captureJPG` | `{camId}` | `{img_bytes: base64}` |
| `cam.getPTZ` | `{camId}` | `{pan,tilt,zoom}` |

### requestImage 반환(CapturedImage) 구성 결정

- `pan/tilt/zoom`: **명령한 ptz echo**(zoom은 clamp 값). ptz 미제공 시 `cam.getPTZ` best-effort, 실패 시 `{0,0,1}` 강등. 시뮬 응답 PTZ를 신뢰하지 않는 기존 철학 유지 — detect/calibrator는 어차피 응답 PTZ를 무시하고 명령/프리셋값을 사용한다.
- `imgName`: RPC엔 img_name이 없어 `` `cam${camIdx}_p${presetIdx}.jpg` `` 로 합성(관측 기록용, 다운스트림 의미 없음).
- `jpg`: `Buffer.from(result.img_bytes ?? '', 'base64')`(누락 시 빈 Buffer graceful).

### listCameras가 camerapos.json을 쓰는 이유

RPC `cam.list`는 device의 **현재** PTZ를 주지 프리셋이 아니다. 카메라 PTZ 프리셋의 소유는 `config/camerapos.json`(형식 A)이고, `parseCameraViews`(mapTargets.ts) + `buildCameraList`(cameraposCatalog.ts)가 이미 이를 `CameraList`(pan/tilt/zoom 포함)로 변환한다 — 재사용했다. 파일 없음/파싱 실패 시 `{cameras:[]}`로 graceful 처리(파싱 실패는 `logger.warn`).

---

## 4. 데이터 흐름

```
CaptureJob / detectPipeline / PtzCalibrator / Finalizer
        │  (주입 camera: ICameraClient)
        ▼
   RpcCameraClient
        ├─ move / requestImage / health ──► CRpcClient.callRpc ──► Unity 13110 /rpc
        │                                     (cam.setPTZ · cam.captureJPG · cam.getPTZ · system.ping)
        ├─ listCameras ──────────────────► config/camerapos.json (fresh read, 프리셋 PTZ)
        └─ clampZoom / streamMjpeg ──────► inner: REST CameraClient (13110 /stream)
```

`index.ts`는 `rpc`(CRpcClient)를 `camera` 생성 **앞으로 이동**해, 뷰어 RPC 콘솔·카메라 도구·`buildServer`가 **동일 rpc 인스턴스**를 공유하도록 했다.

### resolvePresetPtz 정합 (코드 무변경)

`resolvePresetPtz(camera, cam, preset)`(detectPipeline)와 Finalizer는 `listCameras().cameras[].presets[].pan/tilt/zoom`만 읽는다. `RpcCameraClient.listCameras`가 camerapos 프리셋 PTZ를 그대로 노출하므로 **호출 코드 무변경**으로 정합한다(QA #16에서 실 함수로 검증).

---

## 5. 검증 결과 (사실 기반)

QA 리포트(`03_qa_report.md`) 및 리더 라이브 실증 인용.

- **유닛테스트**: 신규 `test/rpcCameraClient.test.ts` **18개 전부 통과**. `npx vitest run`(전체) **117 files / 1238 tests 통과, 회귀 0**(설계 기준 +18). `npx tsc --noEmit` **exit 0**.
- 커버: move(ok/clamp), requestImage(ptz有/無/부분필드/img누락), listCameras(성공/파일없음), health(성공/실패), clampZoom(경계), resolvePresetPtz 정합(camerapos preset2 → `{56.6,7.4,1.9}`), ICameraClient 계약.
- **호출 순서 고정**: ptz 제공 시 `setPTZ → captureJPG`, ptz 미제공 시 `getPTZ → captureJPG`(setPTZ 미발생).
- **리더 라이브 실증**(유닛으로 못 잡는 실 Unity 왕복 대체):
  - `POST /capture/detect` — basePtz 22 / 6.8 / 1.6, 1920×1080, VPD/LPD 검출 확인.
  - `POST /capture/start` count=1 — move + capture done 1/1.

### 한계 (위장 없이 명시)

- 실 Unity 13110 전체 수집 런, 캘리브레이션 e2e, camerapos JSON 깨짐(warn) 경로는 유닛 미포함 → **리더 부분 실증 + 유닛으로 대체**. end-to-end 스모크는 본 작업 범위 밖.

---

## 6. 하위호환

- REST `CameraClient` 클래스는 **삭제하지 않고 보존**(ICameraClient 구현). 부트스트랩·스트림·clampZoom 위임과, REST 서버 복귀 시 재사용을 위해 유지.
- 기본 주입만 `RpcCameraClient`로 전환. 뷰어 소스(sourceRegistry의 자체 CameraClient / CameraposSource)는 무변경 → 스트림·프리셋 목록 정상 유지.
- **중복 setPTZ 유지**(트레이드오프): `CaptureJob.captureTarget`은 `moveBeforeCapture=true`일 때 `camera.move`(setPTZ) 후 `camera.requestImage(t.ptz)`(setPTZ 재차) → 동일 값 setPTZ 2회. 멱등이고 localhost라 비용 미미. 소비처 무변경 원칙을 지키기 위해 유지(move 생략 최적화는 별도 티켓).

---

## 7. 후속 과제 (이번 범위 밖)

`src/mcp/server.ts`·`tools/exportCamerapos.ts`·`tools/e2eSmoke.ts`는 여전히 `new CameraClient(cfg.camera)`(baseUrl=13110 REST)를 사용 → 이들의 카메라 호출은 계속 404(죽은 REST). 이번 전환은 `index.ts` 주입 경로만 대상이었다. **MCP 서버가 카메라 도구를 노출하는 시점에 RpcCameraClient로 전환 필요.**

---

## 8. 관련 파일 요약

| 구분 | 파일 |
|---|---|
| 신규 | `src/clients/RpcCameraClient.ts`, `test/rpcCameraClient.test.ts`, `test/fixtures/camerapos.rpc.json` |
| 변경(인터페이스) | `src/clients/CameraClient.ts` (ICameraClient 추출 + implements) |
| 변경(주입) | `src/index.ts` (rpc 이동 + RpcCameraClient 주입, 고아 CameraClient import 제거) |
| 변경(타입 표기만) | `capture/CaptureJob.ts`, `calibrate/PtzCalibrator.ts`, `setup/SetupOrchestrator.ts`, `api/server.ts`, `api/captureRoutes.ts`, `setup/presetProvider.ts`, `setup/discover.ts` |
| 무변경(구조적 호환) | `capture/detectPipeline.ts`, `capture/Finalizer.ts`(Pick), `viewer/*`, `viewer/cameraposCatalog.ts`(재사용) |

상세 영향도는 `_workspace/04_doc_impact.md` 참조.
