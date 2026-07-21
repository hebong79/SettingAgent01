# Hucoms TypeScript Native Client

- 기준: `etc/HTTP_API_Hucoms_V1.22.pdf`
- 런타임: Node.js 20 이상, ESM, 외부 런타임 의존성 없음
- 구현: `src/clients/hucoms/`
- SettingViewer 어댑터: `src/viewer/RealPtzSource.ts`

## 1. 목적

기존 `RealPtzSource`의 추정 CGI(`/login.cgi`, `/snapshot.cgi`, `/ptz.cgi`)를 제거하고, Hucoms HTTP API V1.22를 TypeScript에서 직접 사용한다. Python 프로세스나 별도 sidecar를 실행하지 않는다.

## 2. 구성

```text
src/clients/hucoms/
├─ HucomsClient.ts  # 전체 V1.22 함수와 fetch transport
├─ parser.ts         # text/plain, section, multipart parser
├─ types.ts          # 공개 option/response 타입
├─ errors.ts         # validation/transport/HTTP/device/stream 오류
└─ index.ts          # 공개 export
```

`HucomsClient`가 제공하는 기능군:

- System Configuration
- Event Configuration
- Camera Configuration
- Stream Configuration
- Event/Alarm/JPEG/MJPEG
- PTZ/Zoom/Focus/Preset/Auto Pan/Centering
- Unified Command 1/2/3
- Video/Audio/PTZ Capabilities

문서에 없는 모델별 확장 명령은 `request(path, params)`로 호출할 수 있다.

## 3. 직접 사용

```ts
import { HucomsClient } from './src/clients/hucoms/index.js';

const camera = new HucomsClient({
  host: '192.168.0.153:80',
  username: 'admin',
  password: 'password',
  timeoutMs: 7000,
});

const info = await camera.getVersionInfo();
console.log(info.sections.Version);

await camera.goPtzfPosition({
  pan: 9000,
  tilt: 1000,
  zoom: 12000,
  panSpeed: 100,
  tiltSpeed: 100,
  zoomSpeed: 100,
});

const jpeg = await camera.getJpeg();
```

MJPEG:

```ts
const controller = new AbortController();
for await (const jpeg of camera.iterMjpeg({ signal: controller.signal })) {
  consume(jpeg);
}
```

## 4. SettingAgent 카메라 런타임 설정

`config/tools.config.json`:

```json
{
  "cameraRuntime": {
    "executionMode": "typescript-native",
    "selectedCameraId": "real-camera-1"
  },
  "cameraSources": [
    {
      "id": "simulator-1",
      "label": "시뮬레이터 1",
      "kind": "sim",
      "protocol": "unity-rpc",
      "baseUrl": "http://localhost:13110",
      "username": "",
      "password": "",
      "rtspUrl": ""
    },
    {
      "id": "real-camera-1",
      "label": "리얼 카메라 1",
      "kind": "hucoms",
      "protocol": "hucoms-v1.22",
      "baseUrl": "http://192.168.0.153:80",
      "username": "admin",
      "password": "",
      "rtspUrl": "rtsp://192.168.0.153:554/stream1"
    }
  ]
}
```

PTZ range를 생략하면 V1.22 기본 범위를 사용한다. 모델별 실제 범위가 다르면 capability와 실기 측정 결과로 덮어쓴다.

옵션창은 `cameraSources`를 콤보 목록으로 사용하며 선택값과 현재 항목의 URL·ID·Password·RTSP를 저장한다. GET `/settings`는 password 원문을 반환하지 않고 `passwordSet`만 반환한다. 저장 후 재시작하면 `CameraSourceClient`를 통해 Viewer와 셋업·정밀수집 파이프라인이 같은 `selectedCameraId`를 사용한다.

뷰어 로그인은 별도 login CGI를 호출하지 않는다. `RealPtzSource.login(user, pass)`가 자격증명을 메모리에 설정하고 `getservername` 요청으로 검증한다. config에 계정이 있으면 재시작 시 네이티브 클라이언트에 바로 주입된다.

## 5. CameraSource 매핑

| CameraSource | Hucoms API |
|---|---|
| `login()` | `servername.cgi?action=getservername`로 자격증명 검증 |
| `snapshot()` | `/cgi-bin/image/jpeg.cgi` |
| `move()` | `ptzf_status.cgi?action=goptzfpos` |
| snapshot PTZ echo | `ptzf_status.cgi?action=getptzfpos` |
| `streamMjpeg()` (레지스트리 실카메라) | `rtspUrl` → `RtspFfmpegAdapter` → JPEG generator |
| `HucomsClient.iterMjpeg()` (직접 사용 호환) | `/cgi-bin/image/mjpeg.cgi` |

`cameraRuntime.selectedCameraId`가 레지스트리 첫 소스와 메인 `ICameraClient`를 함께 결정한다. 기존 배포에서 `cameraRuntime`이 없으면 종전 `cameraMode` + `RpcCameraClient` 경로가 유지된다.

## 6. 폐쇄망·보안 주의

Hucoms V1.22는 `id`와 `passwd`를 URL query에 넣는 평문 HTTP 규격이다.

- 신뢰된 카메라 전용 폐쇄망에서만 직접 호출한다.
- Agent의 Hucoms packet 로그는 `passwd=***`로 마스킹한다.
- 옵션창에서 입력한 자격증명은 독립형 실행을 위해 `tools.config.json`에 저장할 수 있다. 파일 ACL을 SettingAgent 실행 계정으로 제한하고 형상관리에는 실제 비밀번호를 커밋하지 않는다.
- GET `/settings`, 화면 초기값, Hucoms packet 로그에는 비밀번호 원문을 노출하지 않는다.
- 카메라와 Agent 사이에 HTTP access proxy를 두면 proxy access log에서도 query를 마스킹해야 한다.
- 서로 다른 VLAN을 사용하는 경우 Agent에서 카메라 IP:port까지의 방화벽 규칙을 명시적으로 연다.
- 인터넷 DNS/NTP에 의존하지 않고 정적 IP와 현장 시간 기준을 사용한다.
- 실카메라 영상은 RTSP TCP 554를 기본 사용하며, 현장 PC에 FFmpeg를 사전 설치하거나 `cameraStreaming.ffmpegPath`로 동봉 바이너리의 절대 경로를 지정한다.

## 7. 검증

- `npm run typecheck`
- `test/hucomsClient.test.ts`: parser, multipart, auth query, 로그 마스킹, Error, validation, endpoint, 전체 공개 함수
- `test/realPtzSource.test.ts`: credential 검증, JPEG, PTZF, 좌표 변환, MJPEG, manual snapshot 순서
- 전체 SettingAgent 회귀 테스트 통과

실물 HNR-2036LA와의 종단 통신은 카메라가 연결된 폐쇄망에서 별도로 수행한다.
