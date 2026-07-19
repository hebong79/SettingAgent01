# SettingAgent RTSP StreamAdapter 설계서

- 작성: 코덱스 5.6 솔이
- 작성일: 2026-07-19
- 대상: `SettingAgent`
- 목표: 옵션에서 선택한 소스가 시뮬레이터이면 HTTP MJPEG, 실카메라이면 RTSP를 사용하되 Viewer와 상위 Agent는 같은 스트림 계약만 사용한다.

## 1. 현재 구조 분석

### 1.1 현재 데이터 흐름

```text
Browser <img>
  → GET /viewer/api/stream?source=...
  → CameraSource.streamMjpeg()
  → AsyncGenerator<JPEG Buffer>
  → multipart/x-mixed-replace
  → Browser <img>
```

`viewer/routes.ts`의 출력 계약은 이미 전송 방식과 무관한 JPEG 프레임 generator이므로 유지할 수 있다. 문제는 `CameraSource` 구현이 스트림 전송 방식을 직접 소유한다는 점이다.

| 소스 | 현재 제어 | 현재 스트림 | 문제 |
|---|---|---|---|
| Unity RPC 시뮬레이터 | JSON-RPC | `CameraClient`의 HTTP `/stream` | 소스와 스트림 방식 결합 |
| Unity REST 시뮬레이터 | HTTP REST | HTTP `/stream` | 소스와 스트림 방식 결합 |
| Hucoms 실카메라 | Hucoms V1.22 HTTP | Hucoms HTTP MJPEG | `rtspUrl` 설정을 사용하지 않음 |

추가 확인 사항:

- 옵션 페이지는 `rtspUrl`을 읽고 저장하지만 런타임에서 소비하지 않는다.
- 브라우저는 `rtsp://`를 `<img>`나 `<video>`로 직접 재생할 수 없다.
- 실행 환경에 FFmpeg 8.1.1이 설치되어 있다.
- 현재 실제 config의 `simulator-1.baseUrl`이 `ht tp://localhost:13110`으로 잘못 입력되어 재시작 시 Zod URL 검증이 실패한다.

## 2. 결정

스트림 전송을 `CameraSource`에서 분리한 `StreamAdapter` 계층으로 구성한다.

```text
                         ┌─ SimulatorMjpegAdapter ─ HTTP MJPEG
CameraSource ─ delegates ┤
                         └─ RtspFfmpegAdapter ─ RTSP/H.264,H.265 ─ FFmpeg ─ JPEG
                                      │
                                      └─ AsyncGenerator<JPEG Buffer>
                                                     │
Viewer /stream ──────────────────────────────────────┘
```

브라우저와 Viewer route는 계속 MJPEG multipart만 사용한다. RTSP 디코딩·JPEG 변환은 SettingAgent 서버 내부에서 수행한다.

### 2.1 대안 검토

| 대안 | 판정 | 이유 |
|---|---|---|
| 브라우저가 RTSP 직접 재생 | 제외 | 표준 브라우저 미지원 |
| Node.js에서 RTSP와 H.264/H.265를 순수 TypeScript로 직접 디코딩 | 제외 | 디코더 구현·유지 비용과 장비 호환 위험이 과도함 |
| 카메라의 HTTP MJPEG만 사용 | 제외 | 사용자 요구인 RTSP 사용을 충족하지 못함 |
| FFmpeg를 자식 프로세스로 사용해 image2pipe JPEG 출력 | 채택 | 폐쇄망에서 외부 서버 없이 동작하고 H.264/H.265 장비 호환성이 가장 높음 |

## 3. 공개 계약

```ts
export interface StreamRequest {
  cam: number;
  presetIdx: number;
  signal: AbortSignal;
  ptz?: Ptz;
}

export interface StreamAdapter {
  readonly transport: 'http-mjpeg' | 'rtsp-ffmpeg';
  stream(request: StreamRequest): AsyncGenerator<Buffer>;
}
```

구현체:

- `SimulatorMjpegAdapter`: 기존 `CameraClient.streamMjpeg()`를 그대로 위임한다.
- `RtspFfmpegAdapter`: RTSP를 FFmpeg로 열어 `image2pipe` JPEG 프레임으로 변환한다.
- `sourceRegistry`: `cameraSources[].kind`와 `rtspUrl`을 기준으로 적절한 구현을 주입한다.

## 4. 선택 규칙

```text
kind=sim
  → SimulatorMjpegAdapter

kind=hucoms AND rtspUrl 존재
  → RtspFfmpegAdapter

kind=hucoms AND rtspUrl 없음
  → fail-fast: 설정 오류
```

실카메라의 PTZ·스냅샷은 계속 Hucoms HTTP API V1.22를 사용하고 라이브 영상만 RTSP를 사용한다. 따라서 제어 평면과 영상 평면이 분리된다.

Viewer는 `/health`의 `sourceDetails[].streamTransport`를 사용한다. 실카메라 라이브·폴백 캡처에는 PTZ query를 붙이지 않아 단순 재생이나 재연결이 카메라 이동을 일으키지 않는다. PTZ 이동은 `/move`와 사용자가 선택한 프리셋 동작에서만 실행한다.

## 5. 설정

전역 변환 기본값:

```json
{
  "cameraStreaming": {
    "ffmpegPath": "ffmpeg",
    "rtspTransport": "tcp",
    "fps": 5,
    "jpegQuality": 5,
    "startupTimeoutMs": 10000
  }
}
```

카메라별 연결:

```json
{
  "id": "real-camera-1",
  "kind": "hucoms",
  "baseUrl": "http://192.168.0.153:80",
  "username": "admin",
  "password": "",
  "rtspUrl": "rtsp://192.168.0.153:554/stream1"
}
```

`rtspUrl`에 userinfo가 없으면 동일 카메라 항목의 `username/password`를 URL userinfo로 안전하게 인코딩해 FFmpeg에 전달한다. 실제 URL과 비밀번호는 로그에 남기지 않는다.

## 6. FFmpeg 실행 규약

기본 명령 의미:

```text
ffmpeg
  -hide_banner -loglevel error
  -rtsp_transport tcp
  -i <credential-injected-rtsp-url>
  -an
  -vf fps=5
  -f image2pipe
  -vcodec mjpeg
  -q:v 5
  pipe:1
```

- stdout: JPEG SOI/EOI 경계로 분리해 generator에 공급한다.
- stderr: 제한된 크기로만 보관하고 URL·비밀번호를 마스킹한다.
- 첫 프레임이 `startupTimeoutMs` 안에 오지 않으면 프로세스를 종료하고 502 오류로 반환한다.
- 브라우저 연결 종료 시 `AbortSignal`로 FFmpeg를 즉시 종료한다.
- Viewer의 기존 동시 스트림 상한 4개를 유지한다.

## 7. 오류와 폴백

| 상황 | 서버 동작 | Viewer 동작 |
|---|---|---|
| FFmpeg 실행 파일 없음 | 첫 프레임 전 502 | 기존 snapshot 폴링으로 폴백 |
| RTSP 인증 실패 | 첫 프레임 전 502 | snapshot 폴링으로 폴백 |
| RTSP 연결 시간 초과 | 프로세스 종료 + 502 | snapshot 폴링으로 폴백 |
| 스트림 중 카메라 단절 | multipart 종료 | `<img>` 오류 후 snapshot 폴링 |
| 브라우저 연결 종료 | Abort → FFmpeg 종료 | 정상 종료 |

실카메라 선택 시 RTSP가 없는 구성을 조용히 Hucoms MJPEG로 바꾸지 않는다. 오설정을 즉시 드러내기 위해 fail-fast한다.

## 8. 폐쇄망 배포

- 인터넷 다운로드 없이 동작하도록 현장 PC 이미지에 FFmpeg를 사전 설치하거나 고정 경로 바이너리를 함께 배포한다.
- `cameraStreaming.ffmpegPath`에 절대 경로를 지정할 수 있다.
- RTSP는 TCP를 기본값으로 사용해 패킷 손실과 방화벽 포트 범위를 줄인다.
- Agent PC에서 카메라 TCP 554와 HTTP 제어 포트만 허용한다.
- 실제 비밀번호가 있는 config는 형상관리에서 제외하고 파일 ACL을 실행 계정으로 제한한다.
- FFmpeg 프로세스 명령행에는 인증 URL이 노출될 수 있으므로 Agent PC의 일반 사용자 프로세스 조회 권한을 제한한다.

## 9. 테스트 계획

1. `SimulatorMjpegAdapter`가 기존 인자와 AbortSignal을 그대로 위임하는지 검증한다.
2. `RtspFfmpegAdapter`가 TCP/FPS/quality/URL 인자를 정확히 구성하는지 검증한다.
3. 분할된 stdout chunk에서도 JPEG 여러 장을 정확히 복원하는지 검증한다.
4. Abort 시 FFmpeg 종료, 시작 시간 초과, spawn 실패를 검증한다.
5. source registry에서 sim/real에 서로 다른 adapter가 주입되는지 검증한다.
6. `/viewer/api/stream` multipart와 기존 동시 연결 제한 회귀를 검증한다.
7. 전체 TypeScript, build, Vitest 회귀를 실행한다.

## 10. 완료 기준

- 옵션의 `selectedCameraId`가 시뮬레이터이면 해당 `baseUrl`의 HTTP MJPEG를 사용한다.
- 실카메라이면 해당 `rtspUrl`을 FFmpeg로 열어 Viewer에 MJPEG로 제공한다.
- 카메라 제어·Viewer route·상위 Agent는 전송 방식 차이를 알 필요가 없다.
- 종료·오류 시 FFmpeg 프로세스가 남지 않는다.
- 비밀번호가 API 응답·애플리케이션 로그에 노출되지 않는다.
- 기존 전체 테스트가 통과한다.

## 11. 구현 및 실기 확인 결과

- `SimulatorMjpegAdapter`와 `RtspFfmpegAdapter`를 분리 구현했다.
- 실카메라에 RTSP URL이 없거나 URL protocol이 `rtsp/rtsps`가 아니면 설정 단계에서 거부한다.
- 옵션 화면은 시뮬레이터에서 RTSP 입력을 비활성화하고, 선택된 소스의 실제 스트리밍 경로를 표시한다.
- `192.168.0.153:554/stream1`, `192.168.0.154:554/stream1` 모두 FFmpeg TCP 연결로 영상 프레임 1개 수신에 성공했다.
- 카메라 1은 실제 adapter와 같은 `image2pipe + MJPEG` 인자로 266,000 byte의 정상 JPEG(SOI/EOI) 생성까지 확인했다.
- adapter 단위 테스트에서 JPEG chunk 복원, Abort 종료, 시작 timeout, FFmpeg 미설치, 인증정보 마스킹을 검증했다.
- `npm run typecheck`, `npm run build`, 전체 Vitest 172 files / 1,925 tests가 통과했다.
