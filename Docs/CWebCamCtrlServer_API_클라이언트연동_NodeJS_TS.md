# CWebCamCtrlServer API — Node.js(TypeScript) 클라이언트 연동 가이드

Unity `CWebCamCtrlServer`(HttpListener 기반 인바운드 REST API)에 Node.js(TypeScript)
클라이언트가 연동하기 위한 패킷·엔드포인트·예제 레퍼런스.

> 서버 소스: `Assets/Scripts/99_Network/NetworkREST/CWebCamCtrlServer.cs`,
> `CWebCamCtrlServerHost.cs`
> 관련 변경 문서: `Docs/20260709_131756_CWebCamCtrlServer_MJPEG스트리밍_stream엔드포인트_추가.md`

---

## 1. 연결 정보

| 항목 | 값 | 비고 |
|------|-----|------|
| 프로토콜 | HTTP/1.1 | HTTPS 아님 |
| 기본 바인드 주소 | `localhost` | Host Inspector `m_BindAddress` |
| 기본 포트 | `13100` | Host Inspector `m_Port` |
| Base URL | `http://localhost:13100` | |
| 인증 | 없음 | 내부망 전용 |
| 인코딩 | UTF-8 | |

엔드포인트 요약:

| 메서드 | 경로 | 용도 | 본문 |
|--------|------|------|------|
| `GET`  | `/health`  | 헬스체크 | 없음 |
| `GET`  | `/cameras` | 카메라·프리셋 목록 조회 | 없음 |
| `POST` | `/req_move`| PTZ 절대 이동 | `SReqMove` |
| `POST` | `/req_img` | 단발 이미지 캡처(폴링) | `SReqImage` |
| `GET`  | `/stream`  | MJPEG 연속 스트림 | 없음(쿼리) |

---

## 2. 공통 규약

- **Content-Type**: 요청/응답 모두 `application/json; charset=utf-8` (스트림 제외).
- **인덱스**: `cam_idx`, `preset_idx`는 **1-based**. (1부터 시작, 0·음수는 오류)
- **바이너리**: 이미지 바이트(`img_bytes`)는 JSON 내 **base64 문자열**로 직렬화된다.
  TS에서는 `Buffer.from(img_bytes, "base64")`로 디코드.
- **PTZ 단위**: `pan`=수평각(°, Unity euler.y), `tilt`=수직각(°, euler.x),
  `zoom`=배율(**1.0 ~ 36.0**, FOV 변환값).

### 상태 코드 / 에러 스키마

에러 응답 본문은 항상 `SResError` 형태다:

```json
{ "error": "사람이 읽을 메시지", "code": "BAD_REQUEST" }
```

| HTTP | code | 발생 상황 |
|------|------|-----------|
| 200 | — | 정상 |
| 400 | `BAD_REQUEST` | JSON 파싱 실패·본문 누락 |
| 404 | `NOT_FOUND` | 미등록 경로 |
| 405 | `METHOD_NOT_ALLOWED` | 경로는 맞으나 메서드 불일치(예: `GET /req_img`) |
| 500 | `INTERNAL` | 서버 내부 예외(핸들러 미등록 포함) |
| 503 | `TIMEOUT` | 메인 스레드 응답 타임아웃(캡처/이동) |
| 503 | `TOO_MANY_STREAMS` | 동시 스트림 상한(4) 초과 |

---

## 3. 엔드포인트 레퍼런스

### 3.1 `GET /health`

헬스체크. 메인 스레드 디스패치 없이 즉시 응답.

- 응답 200: `{ "ok": true }`

### 3.2 `GET /cameras`

서버가 보유한 카메라와 각 프리셋 목록을 조회. 신규 수집 없이 현재 정의를 노출.

- 응답 200: `SResCameras`

```json
{
  "cameras": [
    {
      "camIdx": 1,
      "name": "Camera 1",
      "enabled": true,
      "presets": [
        { "presetIdx": 1, "label": "C1-P1", "pan": 30.0, "tilt": 12.0, "zoom": 2.0 },
        { "presetIdx": 2, "label": "C1-P2", "pan": 95.0, "tilt": 12.0, "zoom": 2.5 }
      ]
    }
  ]
}
```

- `enabled=false`인 카메라는 클라이언트가 제외한다.
- 카메라가 없으면 `{ "cameras": [] }`.

### 3.3 `POST /req_move`

지정 카메라의 PTZ를 **절대값**으로 이동하고, 해당 카메라를 뷰어의 활성 렌더타겟으로 전환.

- 요청 본문: `SReqMove`

```json
{ "cam_idx": 1, "pan": 45.0, "tilt": 10.0, "zoom": 2.0 }
```

- 응답 200: `SResMove` → `{ "success": true }`
- 존재하지 않는 `cam_idx` → `{ "success": false }` (HTTP는 여전히 200)

### 3.4 `POST /req_img`

지정 카메라·프리셋으로 **단발** 캡처. 요청의 `pan/tilt/zoom`이 프리셋 위에 적용된 뒤 렌더한다.
3fps 폴링 방식은 이 엔드포인트를 반복 호출한다.

- 요청 본문: `SReqImage`

```json
{ "cam_idx": 1, "preset_idx": 1, "pan": 30.0, "tilt": 12.0, "zoom": 2.0 }
```

- 응답 200: `SResImage` (`img_bytes`는 base64 JPEG)

```json
{
  "cam_idx": 1,
  "preset_idx": 1,
  "pan": 30.0,
  "tilt": 12.0,
  "zoom": 2.0,
  "img_name": "cam1_p1.jpg",
  "img_bytes": "/9j/4AAQSkZJRgABAQ..."
}
```

- 응답의 `pan/tilt/zoom`은 **적용 후 실제 카메라 상태**(역산값).
- `preset_idx`에 해당하는 프리셋이 없으면 현재 카메라 상태로 캡처(경고 로그).

### 3.5 `GET /stream`  (MJPEG, 신규)

연결을 유지한 채 지정 카메라·프리셋 화면을 **3fps MJPEG**(`multipart/x-mixed-replace`)로 연속 송출.
캡처 경로는 `/req_img`와 동일(같은 렌더·프리셋 적용).

- 쿼리(1-based, 필수 기본값 있음): `cam_idx`(기본 1), `preset_idx`(기본 1)
- 쿼리(**선택, PTZ override**): `pan`, `tilt`, `zoom` — `/req_img`의 동명 파라미터와 **동일 의미**.
  제공 시 해당 각도를 프리셋 위에 적용해 **프레임마다** 렌더하고, 미제공 시 프리셋 기본 동작(종전 `/stream`과 동일).
  세 값은 독립 파싱되며 파싱 실패·미제공 항목은 `0`으로 취급된다(수동 PTZ 뷰 연동용).
- 예: `GET /stream?cam_idx=1&preset_idx=1&pan=45&tilt=10&zoom=2`
  (프리셋만: `GET /stream?cam_idx=1&preset_idx=1`)
- 응답 200 헤더: `Content-Type: multipart/x-mixed-replace; boundary=frame` (chunked)
- 본문(프레임 반복, ~333ms 간격):

```
--frame
Content-Type: image/jpeg
Content-Length: <N>

<JPEG 바이트>
--frame
Content-Type: image/jpeg
Content-Length: <N>

<JPEG 바이트>
...
```

- 동시 스트림 상한 **4**. 초과 시 `503 TOO_MANY_STREAMS`.
- 클라이언트가 연결을 끊으면 서버 루프가 종료된다.

---

## 4. TypeScript 타입 정의

```ts
// ── 요청 ──────────────────────────────────────────────
export interface SReqMove {
  cam_idx: number;   // 1-based
  pan: number;       // 수평각(°)
  tilt: number;      // 수직각(°)
  zoom: number;      // 1.0 ~ 36.0
}

export interface SReqImage {
  cam_idx: number;    // 1-based
  preset_idx: number; // 1-based
  pan: number;
  tilt: number;
  zoom: number;
}

// ── 응답 ──────────────────────────────────────────────
export interface SResMove { success: boolean; }

export interface SResImage {
  cam_idx: number;
  preset_idx: number;
  pan: number;
  tilt: number;
  zoom: number;
  img_name: string;
  img_bytes: string; // base64 JPEG → Buffer.from(img_bytes, "base64")
}

export interface SPresetItem {
  presetIdx: number; // 1-based
  label: string;
  pan: number;
  tilt: number;
  zoom: number;      // 1.0 ~ 36.0
}

export interface SCameraItem {
  camIdx: number;    // 1-based
  name: string;
  enabled: boolean;
  presets: SPresetItem[];
}

export interface SResCameras { cameras: SCameraItem[]; }

export interface SResError {
  error: string;
  code: "BAD_REQUEST" | "NOT_FOUND" | "METHOD_NOT_ALLOWED"
      | "TIMEOUT" | "INTERNAL" | "TOO_MANY_STREAMS";
}
```

---

## 5. 클라이언트 예제 (Node 18+, 내장 fetch)

### 5.1 REST 클라이언트

```ts
export class ParkCamClient {
  constructor(private baseUrl = "http://localhost:13100") {}

  async health(): Promise<boolean> {
    const r = await fetch(`${this.baseUrl}/health`);
    return r.ok;
  }

  async getCameras(): Promise<SResCameras> {
    const r = await fetch(`${this.baseUrl}/cameras`);
    if (!r.ok) throw await this.toError(r);
    return r.json() as Promise<SResCameras>;
  }

  async move(req: SReqMove): Promise<SResMove> {
    const r = await fetch(`${this.baseUrl}/req_move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!r.ok) throw await this.toError(r);
    return r.json() as Promise<SResMove>;
  }

  /** 단발 캡처. JPEG 바이트(Buffer) 반환. */
  async captureImage(req: SReqImage): Promise<{ meta: SResImage; jpeg: Buffer }> {
    const r = await fetch(`${this.baseUrl}/req_img`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!r.ok) throw await this.toError(r);
    const meta = (await r.json()) as SResImage;
    const jpeg = Buffer.from(meta.img_bytes, "base64");
    return { meta, jpeg };
  }

  private async toError(r: Response): Promise<Error> {
    let detail = `${r.status} ${r.statusText}`;
    try {
      const e = (await r.json()) as SResError;
      detail = `${r.status} ${e.code}: ${e.error}`;
    } catch { /* 본문 없음 */ }
    return new Error(`ParkCam API 오류: ${detail}`);
  }
}
```

### 5.2 MJPEG `/stream` 소비 (라이브러리 없이)

`multipart/x-mixed-replace` 응답 스트림을 읽어 JPEG 프레임 단위로 잘라낸다.
바운더리 파싱 대신 JPEG SOI(`FFD8`)~EOI(`FFD9`)로 자르는 방식이 견고하다.

> 수동 PTZ 뷰를 원하면 URL에 `&pan=&tilt=&zoom=`(선택)을 덧붙인다(§3.5). 아래 예제는 프리셋 기본이며, override가 필요하면 `url` 조립부에 세 파라미터를 추가하면 된다.

```ts
const SOI = Buffer.from([0xff, 0xd8]); // JPEG 시작
const EOI = Buffer.from([0xff, 0xd9]); // JPEG 끝

/**
 * /stream 에 연결해 프레임마다 onFrame(jpeg) 호출.
 * AbortSignal 로 중단하면 서버 루프도 종료된다.
 */
export async function consumeMjpeg(
  baseUrl: string,
  camIdx: number,
  presetIdx: number,
  onFrame: (jpeg: Buffer) => void,
  signal?: AbortSignal,
): Promise<void> {
  const url = `${baseUrl}/stream?cam_idx=${camIdx}&preset_idx=${presetIdx}`;
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) {
    throw new Error(`stream 연결 실패: ${res.status}`);
  }

  const reader = res.body.getReader();
  let buf = Buffer.alloc(0);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf = Buffer.concat([buf, Buffer.from(value)]);

    // 완성된 JPEG를 모두 잘라낸다
    let start: number;
    let end: number;
    while (
      (start = buf.indexOf(SOI)) !== -1 &&
      (end = buf.indexOf(EOI, start + 2)) !== -1
    ) {
      const jpeg = buf.subarray(start, end + 2);
      onFrame(jpeg);
      buf = buf.subarray(end + 2);
    }
  }
}
```

사용 예:

```ts
const client = new ParkCamClient();
const cams = await client.getCameras();

// 첫 카메라·첫 프리셋을 3fps 스트림으로 수신
const controller = new AbortController();
consumeMjpeg("http://localhost:13100", 1, 1, (jpeg) => {
  console.log(`프레임 수신: ${jpeg.length} bytes`);
  // 저장/디코드/재전송 ...
}, controller.signal).catch(console.error);

// 10초 후 중단 → 서버 스트림 루프도 종료
setTimeout(() => controller.abort(), 10_000);
```

브라우저로 재전송할 경우, Node가 받은 스트림을 그대로 프록시하고
브라우저에서 `<img src="http://<proxy>/stream">` 한 줄이면 재생된다.

---

## 6. 주의사항 / 한계

- **폴링 vs 스트림 병행**: `/req_img` 폴링과 `/stream`은 공존한다(추가 방식).
  기존 폴링 클라이언트는 무변경으로 계속 동작한다.
- **PTZ 상태 공유**: 카메라 PTZ·렌더타겟은 서버 전역 상태다. 어떤 카메라를 스트리밍하는 중에
  그 **같은 카메라**로 `/req_move`나 다른 `preset_idx`의 `/req_img`를 보내면 화면이 흔들릴 수 있다.
  서로 다른 카메라를 쓰면 간섭 없음.
- **대역폭**: MJPEG는 프레임 간 압축이 없다. 폴링(base64) 대비 ~30% 감소하나,
  근본적 대역폭 절감이 목표라면 H.264(WebRTC/RTSP)가 필요하다.
- **동시 스트림 상한 4**: 초과 시 `503 TOO_MANY_STREAMS`. 스트림당 서버 스레드·렌더 비용이 든다.
- **타임아웃**: 캡처가 메인 스레드에서 지연되면 `503 TIMEOUT`. 재시도 로직을 두면 안전하다.
- **Unity 에디터/빌드 상태 의존**: 서버는 Host 컴포넌트가 활성인 씬이 실행 중일 때만 응답한다.
```
