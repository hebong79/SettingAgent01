# SettingAgent 카메라 라이브 뷰 — 폴링(/req_img) → MJPEG 연속 스트리밍(/stream) 전환

- 작성: 문서화·영향도 분석가(documenter)
- 작성일시: 2026-07-09 14:12:27
- 대상: SettingAgent 웹 뷰어 라이브 스트림 경로
- 근거 산출물: `_workspace/01_architect_plan.md`(설계), `_workspace/02_developer_changes.md`(구현), `_workspace/03_qa_report.md`(검증)
- 참조 API 문서: `Docs/CWebCamCtrlServer_API_클라이언트연동_NodeJS_TS.md` §3.5(GET /stream), §5.2(MJPEG 소비), §6(주의사항)

---

## 1. 배경·목표

### 기존 동작
라이브 뷰는 프론트 `web/core.js:createStreamLoop`가 `GET /viewer/api/snapshot`을 약 3fps로 **반복 폴링**했다(→ 백엔드 `CameraSource.snapshot()` → Unity `/req_img`, base64 JPEG). 폴링은 요청·응답마다 연결·인코딩 오버헤드가 있고 프레임 간 지연·끊김이 발생한다.

### 목표
Unity 신규 엔드포인트 `GET /stream`(MJPEG, `multipart/x-mixed-replace`, 3fps 연속)을 소비하여 라이브 뷰를 **연속 스트리밍**으로 전환한다. 단, 전환은 **가산·외과적**이어야 한다.
- 폴링·단발 캡처 경로(정밀수집 `CaptureJob`, `gotoPreset` 폴백, `/snapshot` 라우트, `/req_img`)는 **무변경**으로 보존.
- 스트림은 **추가 경로**로 얹고, 프론트 라이브 뷰만 그쪽으로 전환.
- 스트림 미지원 소스(RealPtzSource=Hucoms)·오류 시 기존 **폴링으로 폴백**.

---

## 2. 아키텍처 선택 — B안(백엔드 SOI/EOI 소비 후 재송신)

프론트는 어느 안이든 `<img src="/viewer/api/stream?...">` 한 줄로 동일하다. 차이는 백엔드가 상류(Unity) 멀티파트 스트림을 **그대로 파이프(A안)**하느냐, **SOI/EOI로 JPEG 프레임을 잘라 재직렬화(B안)**하느냐이다.

| 구분 | A. 순수 파이프(pass-through) | **B. SOI/EOI 소비→재송신(채택)** |
|------|------------------------------|----------------------------------|
| 백엔드 | 상류 `res.body`를 `reply.raw`로 그대로 전달 | `splitJpegFrames`로 JPEG 단위 분리 후 `--frame` 멀티파트 재직렬화 |
| 문서 근거 | §5.2 말미 "그대로 프록시" | §5.2 본문 "SOI~EOI가 견고" |
| SOI/EOI 순수 파서(수용기준 2·6) | 불필요 → 만들면 추측성 데드코드 | 실경로에 탑재·유닛테스트 대상 |
| 동시 스트림 카운팅(수용기준 4) | 연결 수 카운팅만 | 동일 + 프레임 제어권 확보 |
| 코드량 | 최소 | +파서/제너레이터(약 40~60줄) |

### 채택 근거(B안)
1. 리더가 명시한 수용기준 2·6(SOI/EOI 파서를 **유닛테스트 가능한 순수 로직**으로)을 **데드코드 없이** 충족한다. A안은 파서가 실경로에 존재하지 않아 이 요구를 만들면 CLAUDE.md 규칙 2(추측성 코드 금지)에 위배된다.
2. 참조 문서 §5.2가 boundary 파싱 대신 SOI(`FFD8`)~EOI(`FFD9`) 절단을 "견고한 방식"으로 권한다.
3. 동시 스트림 카운팅·503 전파를 우리 프록시 계층에서 자연스럽게 제어할 수 있다.
4. 소스 추상화(`streamMjpeg?`)로 Hucoms 폴백이 깔끔하다.

설계 단계에서 A안(더 단순)을 반론으로 올렸고, 리더가 수용기준 2·6 충족을 근거로 **B안을 확정**했다.

---

## 3. 신규·변경 클래스·함수 상세

### 3.1 `src/clients/mjpeg.ts` — `splitJpegFrames` (신규, 순수 파서)

```ts
export function splitJpegFrames(buf: Buffer): { frames: Buffer[]; rest: Buffer }
```

누적 버퍼에서 완성된 JPEG를 SOI(`0xFF 0xD8`)~EOI(`0xFF 0xD9`) 기준으로 모두 잘라 `frames`로 반환하고, 아직 EOI가 오지 않은 잔여는 `rest`로 돌려준다. DOM/네트워크 미참조 → 직접 유닛테스트 가능.

**이월(carry-over) 규약** — 소비자(`CameraClient.streamMjpeg`)가 `buf = Buffer.concat([buf, rest_다음청크])` 방식으로 재호출한다는 전제로 설계된 핵심 계약:
- SOI 발견 후 **EOI 미도래** → `rest = buf.subarray(soi)` (SOI부터 다음 청크와 이어붙이도록 잔여 보존).
- **SOI 자체 미발견** → 마지막 바이트가 `0xFF`이면 다음 청크의 `0xD8` 후보이므로 **1바이트만 보존**, 아니면 잡음 전량 폐기(`rest` 빈 버퍼).
- SOI 앞의 boundary/헤더 텍스트(`--frame`, `Content-Type:` 등)는 SOI 탐색에서 자연 스킵된다.

**오탐 없음 전제(문서 §5.2)**: JPEG entropy 데이터 내 `0xFF`는 `0x00` 스터핑되고 restart 마커는 `0xFF 0xD0~0xD7`이라 `FFD8`/`FFD9`와 충돌하지 않는다.

### 3.2 `CameraClient.streamMjpeg` (`src/clients/CameraClient.ts`, 추가)

```ts
async *streamMjpeg(camIdx: number, presetIdx: number, signal: AbortSignal): AsyncGenerator<Buffer>
```

Unity `/stream?cam_idx={camIdx}&preset_idx={presetIdx}`(1-based, 수용기준 5)에 연결해 프레임(JPEG Buffer)을 순서대로 산출하는 **async generator**.
- 장수명 스트림이므로 `fetchWithTimeout`을 쓰지 않고(타임아웃 부적합) `signal`만 사용 → abort 시 상류 fetch 중단(수용기준 3).
- 상류 `503` → `CameraApiError('TOO_MANY_STREAMS', …, 503)` throw. 그 외 실패/`!body` → `CameraApiError('INTERNAL', …, status)` throw. 기존 `CameraApiError` 재사용.
- `res.body.getReader()`로 청크를 읽어 `splitJpegFrames`로 프레임 yield, 잔여는 `buf = rest`로 다음 루프에 이월.
- `let buf: Buffer` 명시 타입 — 신 `@types/node`의 `Buffer<ArrayBuffer>` vs `Buffer.concat` 반환형 불일치 회피.

**async generator 채택 이유**: 라우트가 `await it.next()`로 **첫 프레임/에러(503)를 HTTP 헤더 전송 전에** 판정할 수 있어 503 전파가 깔끔하다.

### 3.3 `CameraSource.streamMjpeg` 계약 (`src/viewer/CameraSource.ts`, placeholder 용도 전환)

미사용 placeholder였던 `streamUrl?(cam): string|null`("11단계용")를 아래로 **용도 전환**했다(새 필드 추가 대신 자리 재사용 — 외과적).

```ts
/** (선택) MJPEG 스트림. 프레임(JPEG Buffer)을 순서대로 산출. 미지원 소스는 미구현(→ 라우트 501 → 프론트 폴링 폴백). signal abort 시 상류 중단. */
streamMjpeg?(cam: number, presetIdx: number, signal: AbortSignal): AsyncGenerator<Buffer>;
```

`?`(optional)로 둔 것이 폴백 설계의 핵심: **구현 소스(Simulator)=존재, 미지원 소스(RealPtz)=undefined**로 라우트가 501 분기를 판단한다.

### 3.4 `SimulatorSource.streamMjpeg` (`src/viewer/SimulatorSource.ts`, 위임 추가)

```ts
streamMjpeg(cam, presetIdx, signal) { return this.camera.streamMjpeg(cam, presetIdx, signal); }
```

래핑한 `CameraClient`로 인자(cam, preset, signal)를 그대로 위임·프레임 패스스루. 단위 변환 없음(뷰어=Unity 단위 동일).

### 3.5 `RealPtzSource` (`src/viewer/RealPtzSource.ts`, 무변경)

`streamMjpeg` 미구현 유지(Hucoms 스트림 미지원). `streamMjpeg === undefined`이므로 라우트가 501을 반환하고 프론트가 폴링으로 폴백한다. 코드 변경 없이 폴백 근거만 문서화.

### 3.6 `GET /viewer/api/stream` 라우트 (`src/viewer/routes.ts`, 추가)

- **쿼리(zod)**: `StreamQuery = { source?: string, cam: coerce.int.positive, preset: coerce.int.positive }`. 1-based 강제(수용기준 5), `SnapshotQuery`와 동형 이름(cam/preset).
- **동시 스트림 카운팅(수용기준 4)**: 모듈 클로저 카운터 `activeStreams`, 상수 `MAX_STREAMS = 4`.
- **처리 흐름**:
  1. zod 파싱 실패 → `400`.
  2. `pickSource` 실패 → `400 source not found`.
  3. `!source.streamMjpeg` → `501 { code: 'STREAM_UNSUPPORTED' }` (프론트 폴백 신호).
  4. `activeStreams >= MAX_STREAMS` → 상류 연결 없이 즉시 `503 { code: 'TOO_MANY_STREAMS' }` (로컬 선차단).
  5. `AbortController` 생성 → `reply.raw.on('close', () => ac.abort())` (클라 disconnect → 상류 중단, 수용기준 3).
  6. `await it.next()` — 첫 프레임/에러를 헤더 전송 전 판정. 상류 `CameraApiError(503)` → `503 TOO_MANY_STREAMS` 전파, 그 외 오류 → `502`.
  7. **성립 후** `activeStreams++` → `reply.hijack()` → `writeHead(200, multipart/x-mixed-replace; boundary=frame, Cache-Control: no-store, Connection: close)`.
  8. `writeFrame`로 `first.value` + `for await`한 이후 프레임을 `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: N\r\n\r\n<JPEG>\r\n` 프레이밍으로 재송신.
  9. `finally { activeStreams--; reply.raw.end(); }` — 정상/에러/abort 무관 카운터 확실 감소.
- **등록 위치**: `/viewer/api/*` 그룹 내(snapshot 다음, move 앞), `@fastify/static` 와일드카드 이전(현행 순서 규약 준수).

### 3.7 프론트 (`web/app.js`, 수정) — Q2 원칙 반영

- `liveMode: 'off' | 'stream' | 'poll'` 상태 도입.
- `streamUrl()`: 현재 cam/preset/source로 1-based 스트림 URL 조립.
- `startLive()`: `loop.stop()`(폴백 폴링 중지) → `frame.onerror = fallbackToPolling` → `frame.src = streamUrl()` → `drawRoiOverlay()` 시작 1회.
- `stopLive()`: `frame.onerror = null` → `frame.removeAttribute('src')`(연결 종료 → `reply.raw` close → 상류 abort) → `loop.stop()`.
- `fallbackToPolling()`: 501/네트워크/503 오류 시 `liveMode='poll'` + 기존 `loop.start(fps)`(폴백 경로 보존). 재진입 방지 가드.
- `reconnectLiveIfActive()`: cam/preset 변경 시 스트림 모드면 새 쿼리로 `frame.src` 재설정(폴링 모드는 state 추종이라 무동작). `sel-cam`/`sel-preset` change에 결선.
- `move()`: `liveMode==='stream'`이면 `loop.tick()` **생략**(생략 안 하면 스냅샷 blob이 MJPEG 스트림을 덮어씀). PTZ는 `/req_move` 전역 상태 변경 → 다음 스트림 프레임이 추종(Q2 원칙, 문서 §6 근거).
- `startCapFramePolling()`(정밀수집 시작): 기존 `loop.stop()` → `stopLive()`로 교체(스트림·폴백 폴링 모두 중단, 카메라 경합 회피).
- 오버레이 재그리기: per-tick 의존은 폴링 경로에만 유지. 스트림은 표시 크기 불변이라 시작 1회 + 기존 ResizeObserver/편집·선택 트리거로 충분.

---

## 4. 입출력·REST 계약

### 4.1 `GET /viewer/api/stream` (신규)

| 항목 | 값 |
|------|----|
| 쿼리 | `cam`(양수, 1-based, 필수), `preset`(양수, 1-based, 필수), `source`(선택) |
| 성공(200) | `Content-Type: multipart/x-mixed-replace; boundary=frame`, `Cache-Control: no-store`, `Connection: close`. 본문: `--frame`/`Content-Type: image/jpeg`/`Content-Length: N`/`<JPEG>` 반복 |
| 400 | 쿼리 무효(누락·cam=0 등) / source not found |
| 501 | `{ code: 'STREAM_UNSUPPORTED' }` — 스트림 미지원 소스(폴링 폴백 신호) |
| 502 | 상류 첫 프레임 일반 오류 |
| 503 | `{ code: 'TOO_MANY_STREAMS' }` — 로컬 상한(4) 초과 또는 상류 503 전파 |

### 4.2 상류 계약(Unity `GET /stream`, 문서 §3.5)

`GET /stream?cam_idx={n}&preset_idx={n}` → `200 multipart/x-mixed-replace; boundary=frame`(chunked, 3fps ~333ms 간격). 동시 상한 4, 초과 시 `503 TOO_MANY_STREAMS`. 클라 연결 종료 시 서버 루프 종료.

### 4.3 경계면 정합(검증자 교차 비교)
- 1-based 인덱스: `CameraClient` URL `cam_idx`/`preset_idx` ↔ 라우트 zod `cam`/`preset`(`.int().positive()`) 정합. cam=0은 400.
- 503 코드 체인: 상류 503 → `CameraApiError('TOO_MANY_STREAMS',503)` → 라우트 `httpStatus===503` 분기 → `503 { code:'TOO_MANY_STREAMS' }`. 로컬 선차단도 동일 코드.
- 파서↔소비자: `splitJpegFrames`의 `{frames, rest}` 이월 규약을 `streamMjpeg`의 `buf = rest` 누적 루프가 동일 사용.

---

## 5. 데이터 흐름 다이어그램(텍스트)

```
[브라우저 <img src="/viewer/api/stream?cam=&preset=&source=">]
        │  (HTTP GET, multipart/x-mixed-replace 네이티브 렌더)
        ▼
[SettingAgent  GET /viewer/api/stream (routes.ts)]
        │  zod 파싱 → pickSource → 501/503 선판정
        │  AbortController(reply.raw 'close' → abort)
        ▼
[source.streamMjpeg(cam, preset, signal)  = SimulatorSource → CameraClient]
        │  fetch(/stream?cam_idx=&preset_idx=, {signal})  ── 503/실패 → CameraApiError
        ▼
[Unity CWebCamCtrlServer  GET /stream]  ── multipart 3fps chunk 스트림 ──▶
        │
        ▼  (res.body.getReader() 청크)
[splitJpegFrames(buf) → {frames, rest}]   SOI/EOI 절단, rest 이월
        │  yield JPEG Buffer …
        ▼
[routes.ts writeFrame → reply.raw]  --frame\r\nContent-Type: image/jpeg\r\nContent-Length\r\n\r\n<JPEG>\r\n
        │  (재직렬화 multipart)
        ▼
[브라우저 <img> 연속 갱신]

폴백 경로(501/네트워크/503): frame.onerror → fallbackToPolling() → loop.start(fps)
        → 기존 GET /viewer/api/snapshot 폴링(→ /req_img). 무변경 경로 재사용.
```

---

## 6. 요구사항(수용 기준) 항목별 충족 대조표

| # | 수용 기준 | 충족 | 근거 |
|---|-----------|------|------|
| 1 | 기존 폴링·단발 캡처 경로 무변경 공존 | 충족 | `requestImage`(/req_img)·`/snapshot`·`createStreamLoop`·CaptureJob·`gotoPreset` 폴백 코드 무변경(구현 §6). 리더 라이브 실증. |
| 2 | SOI/EOI 프레임 파서 실경로 탑재 | 충족 | `splitJpegFrames`가 `CameraClient.streamMjpeg`에서 실제 사용. vitest 9케이스. |
| 3 | 클라 disconnect → 상류 abort 연쇄 | 충족 | `reply.raw.on('close', abort)` → `signal.aborted=true`(실서버 테스트 확인). |
| 4 | 동시 스트림 상한 카운팅 | 충족 | `MAX_STREAMS=4` + `activeStreams`. 5번째 503, 해제 후 카운터 복구(실서버 테스트). |
| 5 | 1-based 인덱스 계약 | 충족 | URL `cam_idx`/`preset_idx` + zod `.int().positive()` 정합. cam=0 → 400. |
| 6 | 순수 로직 유닛테스트 | 충족 | 신규 25테스트(파서·클라이언트·라우트·계약). vitest 1065 전부 통과. |

---

## 7. 검증 결과(검증자 03 리포트 인용)

- **vitest 전체: 107 파일 / 1065 테스트 전부 통과**(+3 파일·+25 테스트, 기존 104파일·1040 대비). 회귀 없음.
- **타입체크 `npx tsc --noEmit` → EXIT 0(통과)**.
- **구현 결함 없음**. 테스트 작성 중 발견한 이슈 2건(정확히는 3건 기록)은 모두 **테스트 코드 자체 결함**이었고 테스트만 수정, 구현 코드는 무변경.
- 신규/확장 테스트: `test/mjpeg.test.ts`(9), `test/cameraClientStream.test.ts`(5), `test/viewerStreamRoutes.test.ts`(9), `test/simulatorSource.test.ts`(+1), `test/realPtzSource.test.ts`(+1).
- **종단간 라이브 실증(리더 수행)**: Unity(13100) + SettingAgent(13020) 프록시 스트림 정합·동시 상한·파서 parity 확인. 8프레임 연속 재생 / 503 / 카운터 복구 검증됨.

> 사실 기반 주의: 종단간 라이브(3초 8프레임 SOI=EOI=경계 정합, PTZ 추종)는 **vitest 미수행**이며 **리더 라이브 검증으로 대체**되었다. 프론트(app.js) 라이브 전환(startLive/stopLive/fallback/reconnect, `<img>` multipart 렌더, move tick 가드)은 DOM 의존이라 유닛테스트 대상이 아니며 경험적 검증(리더) 영역이다.

---

## 8. 한계·주의

- **RealPtzSource(Hucoms) 스트림 미지원**: 501 반환 → 프론트 폴링 폴백. 라이브 스트림은 SimulatorSource(Unity)에서만 동작.
- **Q2(스트림 프레임의 PTZ 추종)**: `/stream`이 프리셋 PTZ를 프레임마다 재적용하는 게 아니라 **서버 전역 카메라 상태를 렌더**한다는 원칙(문서 §6)에 근거해, 스트림 중 `/req_move`로 같은 카메라를 조종하면 다음 프레임이 추종한다고 가정·구현했다. 리더의 종단간 라이브에서 정합 확인됨. (문서 §6: 같은 카메라로 `/req_move`/다른 preset `/req_img`를 보내면 화면이 흔들릴 수 있음 — 서로 다른 카메라는 무간섭.)
- **대역폭(문서 §6)**: MJPEG는 프레임 간 압축이 없어 폴링(base64) 대비 ~30% 감소에 그친다. 근본적 절감이 목표면 H.264(WebRTC/RTSP)가 필요 — 이번 범위 밖.
- **동시 상한 4**: 스트림당 서버 스레드·렌더 비용. 5번째 연결은 503.
- **타임아웃(문서 §6)**: 캡처가 메인 스레드에서 지연되면 상류가 `503 TIMEOUT`. 스트림은 `fetchWithTimeout` 미사용(장수명)이라 이 경우 첫 프레임 판정에서 502/503로 표면화될 수 있다.
- **브라우저 전제**: `<img>`의 `multipart/x-mixed-replace` 네이티브 렌더 지원(Chrome/Chromium, Unity 뷰어 환경) 전제.

---

## 9. 변경 파일 요약

| 파일 | 구분 |
|------|------|
| `src/clients/mjpeg.ts` | 신규(순수 파서) |
| `src/clients/CameraClient.ts` | 추가(`streamMjpeg` async generator) |
| `src/viewer/CameraSource.ts` | 교체(placeholder `streamUrl?` → `streamMjpeg?`) |
| `src/viewer/SimulatorSource.ts` | 추가(위임) |
| `src/viewer/RealPtzSource.ts` | 무변경(미구현 유지) |
| `src/viewer/routes.ts` | 추가(`GET /viewer/api/stream`) |
| `web/app.js` | 수정(라이브 전환·폴백·재연결·move 가드) |
| `test/*` | 신규 3 + 확장 2 |

상세 영향도는 `_workspace/04_doc_impact.md` 참조.

---

## [루프2] 수동 PTZ 제어 버그 수정(MJPEG 프리셋 재적용 대응)

- 추가 작성일시: 2026-07-09 14:50:31
- 대상: SettingAgent 웹 뷰어 라이브 뷰 상태기계(`web/app.js`, 순수 로직 `web/core.js`, 타입 `web/core.d.ts`)
- 근거 산출물: `_workspace/01_architect_plan.md` "## [루프2]", `02_developer_changes.md` "## [루프2]", `03_qa_report.md` "## [루프2]"
- 범위: **프론트만**. 백엔드(`routes.ts`/`CameraClient.ts` 등)·Unity 서버 **무변경**.

### L2-1. 발견된 버그·증상

루프1(MJPEG 전환) 이후 라이브 스트림 재생 중 **카메라 제어가 되지 않는** 회귀가 관측되었다.
- 증상: PTZ 버튼/절대이동을 눌러도 화면이 즉시 **원래 프리셋 위치로 제자리 복귀**("카메라 제어가 안 됨").
- 마스터 추가 확인: 뷰어 조작이 아니라 **Unity에서 카메라를 직접 움직여도**, 스트림이 열려 있으면 약 **333ms(≈3fps 주기)마다 프리셋 위치로 되돌아온다**. 즉 프론트 코드만의 문제가 아니라 스트림 연결 자체가 위치를 되돌리고 있었다.

루프1 구현의 직접 원인은 `move()`가 `liveMode==='stream'`일 때 `loop.tick()`(스냅샷 override)을 **생략**하도록 되어 있어(스냅샷 blob이 MJPEG를 덮지 않게 하려는 의도), 수동 PTZ가 화면에 전혀 반영되지 않고 프리셋 화면으로 고정된 것이다.

### L2-2. 확정 근본 원인(리더 스샷 실증 — 재조사 불요)

Unity `GET /stream`은 **프레임마다 `preset_idx`를 재적용**한다. 즉 스트림이 열려 있는 동안에는 프레임 생성 시점마다 카메라가 해당 프리셋 PTZ로 리셋되어, `/req_move`(수동 PTZ)로 바꾼 위치가 다음 프레임(~333ms)에 덮여 사라진다. 이는 뷰어의 조작이든 Unity 직접 조작이든 동일하게 되돌림을 유발한다.

핵심 함의: **스트림 연결을 닫아야만 프리셋 재적용이 멈춘다.** 스트림을 유지한 채 재연결하거나(`/req_move` 무시) 스냅샷을 겹쳐도 위치는 유지되지 않는다. 우리가 고칠 수 없는 Unity 서버 시그니처(`/stream`은 cam/preset만 수신) 한계이므로, **수동 제어는 스트림을 닫고 폴링(override) 경로로만 가능**하다.

### L2-3. 수정 설계·구현

리더 권고 **A안(모드 전환)** 채택 — 수동 PTZ 조작 시 폴링(override) 경로로 자동 전환하여 MJPEG 연결을 닫고, 프리셋 계열 조작 시 MJPEG 스트림으로 복귀한다. 더 단순한 대안(전부 폴링 회귀 / 스트림만 재연결 / 1회 스냅샷)은 각각 MJPEG 도입 목적 위반·근본원인상 무효(재연결해도 preset 재적용)·연속 수동제어 불가로 모두 기각되었다(설계 [루프2] L2-0).

**`liveMode` 3-상태 전이(핵심 두 전이)**:
- **수동 PTZ = stream → poll(자동 전환)**: PTZ 버튼·절대이동 시 MJPEG를 닫고 폴링 override(`mode=manual` + `state.ptz`)로 수동 위치를 연속 렌더.
- **프리셋 계열 = poll → stream(자동 복귀)**: 프리셋/cam 변경·프리셋 이동 시 폴링을 멈추고 MJPEG 재연결(/stream이 preset 존중).

변경 함수·지점:

1. **`web/core.js: moveRenderDirective(liveMode, origin)`** (신규 순수 export) — 이동 시 렌더 경로를 DOM 무관하게 결정.
   ```js
   export function moveRenderDirective(liveMode, origin) {
     if (origin === 'manual' && liveMode === 'stream') return 'stream-to-poll';
     if (liveMode !== 'stream') return 'tick';
     return 'none';
   }
   ```
   - `(manual, stream)` → `'stream-to-poll'`(수동+스트림 → 폴링 전환, 유일 전환 경로), `liveMode!=='stream'` → `'tick'`(poll 지속갱신 / off·preset(off) 1회 스냅샷), 그 외(preset+stream) → `'none'`(reconnect가 뷰 복귀 담당).
   - `web/core.d.ts`에 타입 선언 추가(tsc 정합).

2. **`web/app.js: move(ptz, { origin = 'manual' } = {})`** — 시그니처 확장. fetch 성공 후 `state.ptz` 갱신·`updatePtzDisplay()`, 이어 `moveRenderDirective` 결과로 분기:
   - `'stream-to-poll'`: `liveMode='poll'` → `frame.onerror=null`(스트림 폴백 해제) → `loop.start(fps)` → `await loop.tick()`(즉시 override 렌더). **닫힘 보장**: 폴링 tick의 `setImage`가 `frame.src=blobURL`로 교체 → 기존 MJPEG `<img>` 연결이 닫힘 → 프록시 `reply.raw` close → 상류 fetch abort → Unity `/stream` 루프 종료 → 프리셋 재적용 중단.
   - `'tick'`: `await loop.tick()`.
   - `'none'`: 무동작(reconnect가 담당).
   - PTZ 버튼(data-dir)·절대이동(btn-abs) 호출부는 **기본값 `origin='manual'`** 이라 무변경.

3. **`web/app.js: reconnectLiveIfActive()`** — poll→stream 복귀로 확장. `liveMode==='off'`면 무동작, `'poll'`이면 `loop.stop()`(수동 폴링 중지) 후 `liveMode='stream'` + `frame.onerror=fallbackToPolling` + `frame.src=streamUrl()` + `drawRoiOverlay()` 1회.

4. **`web/app.js: gotoPreset()`** — 프리셋 PTZ 보유 시 `move(ptz, { origin: 'preset' })`로 호출(폴링 전환 금지, 뷰 복귀는 reconnect가 담당). 폴백(프리셋 PTZ 미제공) 경로 무변경.

5. **`web/app.js: btn-goto 결선`** — `() => { gotoPreset(); reconnectLiveIfActive(); }`로 변경(poll 상태에서 프리셋 이동 시 스트림 복귀). sel-cam/sel-preset은 이미 `gotoPreset(); reconnectLiveIfActive();`라 무변경(reconnect 확장으로 poll→stream도 처리).

**race 처리(설계 L2-5)**: sel-*/btn-goto는 `reconnectLiveIfActive()`(동기)가 먼저 `liveMode='stream'`을 확정하므로, 뒤늦게 resolve되는 `move(origin='preset')`는 `moveRenderDirective('stream','preset')='none'`으로 tick을 하지 않아 스냅샷이 스트림을 덮지 않는다(결정적).

### L2-4. 입출력·계약 영향

- **REST/백엔드 계약 변경 없음.** 수동 override는 기존 `GET /viewer/api/snapshot?mode=manual&pan=&tilt=&zoom=`(→ `/req_move` + `X-PTZ-*` 헤더) 경로를 그대로 재사용한다. `/viewer/api/stream`·`/move`·`/snapshot` 시그니처 불변.
- 신규 순수 함수 계약: `moveRenderDirective(liveMode, origin) → 'stream-to-poll' | 'tick' | 'none'`. 반환 리터럴 3종이 `move()`의 분기와 1:1.

### L2-5. 검증 결과(검증자 03 리포트 [루프2] 인용)

- **`moveRenderDirective` 6케이스 vitest 전부 통과**(`test/viewerCore.test.ts` 확장, 27→33): `(stream,manual)→stream-to-poll`, `(poll,manual)→tick`, `(off,manual)→tick`, `(stream,preset)→none`, `(poll,preset)→tick`, `(off,preset)→tick`.
- **vitest 전체: 107 파일 / 1071 테스트 전부 통과**(루프1 기준 1065 → +6). 회귀 없음.
- **타입체크 `npx tsc --noEmit` → EXIT 0**.
- **구현 결함 없음**(`moveRenderDirective`는 이미 export되어 있어 테스트만 추가).
- **리더 실증**: 폴링 override 경로가 `pan=115` 지정 시 응답 `X-PTZ-Pan=115`로 수동 위치를 반영함을 확인(스트림→폴링 전환 후 수동 제어 성립).

> 사실 기반 주의: DOM 전이(실제 `frame.src` 교체·스트림 종료·reconnect·override 진입)와 "닫힘 보장에 의한 프리셋 재적용 중단"은 브라우저/`<img>` multipart·fetch 의존이라 **vitest 대상이 아니며 브라우저 수동확인 영역**이다(검증자 03 [루프2] §4 명시). vitest는 `moveRenderDirective` 결정 로직만 회귀 고정한다.

### L2-6. 남은 트레이드오프·한계

- **수동 PTZ 중에는 MJPEG가 아니라 폴링(override)로 동작**한다 — Unity `/stream` API가 cam/preset만 받고 프레임마다 preset을 재적용하는 구조적 한계상 **불가피**하다. 스트림을 유지한 채 수동 제어할 방법은 없다.
- 따라서 **수동 제어 구간에서는 MJPEG의 대역폭/연속성 이점이 없고 폴링 fps(#fps 입력, 기본 3)에 의존**한다. 프리셋 모니터링 뷰는 종전대로 MJPEG로 유지된다.
- 정밀수집 종료 후 라이브 복귀는 사용자가 `btn-start`로 재시작(기존 동작 유지, 자동 복귀는 범위 밖).

---

## [루프3] /stream PTZ override 지원 + 라이브 단일화

- 추가 작성일시: 2026-07-09 16:02:30
- 대상: Unity `CWebCamCtrlServer`(C#) + SettingAgent 라이브 뷰(TS/JS, 양 리포지토리)
- 근거 산출물: `_workspace/01_architect_plan.md`·`02_developer_changes.md` "## [루프3]", `03_qa_report.md`
- 참조 API 문서: `Docs/CWebCamCtrlServer_API_클라이언트연동_NodeJS_TS.md` §3.5(pan/tilt/zoom 선택 쿼리 추가)

### L3-1. 배경 — 왜 다시 손대는가

루프2는 "Unity `/stream`이 프레임마다 `preset_idx`를 재적용해 `/req_move`(수동 PTZ)를 덮어쓴다"는 상류 한계를 프론트 **모드 전환**(수동 PTZ = stream→poll 폴링 override)으로 우회했다. 이 때문에 수동 제어 구간은 MJPEG가 아니라 폴링(`/req_img`)으로 동작했고, 라이브 경로가 스트림과 폴링 두 갈래로 갈라져 있었다.

마스터 요구: **라이브 뷰의 `/req_img` 폴링 의존을 제거하고 `/stream`(뷰) + `/req_move`(물리 이동)로 통일**한다. 이를 위해 Unity `/stream`이 `pan/tilt/zoom` override 쿼리를 받도록 상류를 확장했다(= `/req_img mode=manual`과 동일하게 그 각도를 프레임마다 렌더). 그 결과 루프2의 "수동 PTZ → 폴링 전환"이 **불필요**해지고, 수동·프리셋 PTZ를 **모두 `/stream` 재연결** 하나로 표현할 수 있다.

원칙:
- 물리 이동은 여전히 `/req_move`(뷰어 `/viewer/api/move`)로 수행한다. `/stream`은 그 위에 pan/tilt/zoom을 실어 **뷰만** 렌더한다.
- 스트림 미지원 소스(RealPtzSource=Hucoms, `streamMjpeg` 미구현)는 **폴링 폴백을 그대로 보존**한다.
- 라이브 뷰에서 `/req_img`(스냅샷 폴링)는 제거하되, **정밀수집(CaptureJob)·`gotoPreset` 프리셋 스냅샷 폴백 등 캡처 파이프라인의 `/req_img`는 유지**한다.

### L3-2. Unity 변경 (`CWebCamCtrlServer.cs`, `HandleStream`)

`HandleStream`의 쿼리 파서에 `pan/tilt/zoom` 파싱을 추가하고, 프레임 캡처용 `SReqImage`에 전달한다(파일 471줄 부근).

```csharp
// pan/tilt/zoom 은 /req_img 와 동일한 PTZ override 파라미터(선택). 미제공 시 0 → 기존 /stream 동작(프리셋) 유지.
if (key == "pan"  && float.TryParse(val, out float f)) pan  = f;
if (key == "tilt" && float.TryParse(val, out float t)) tilt = t;
if (key == "zoom" && float.TryParse(val, out float z)) zoom = z;
...
frame = DispatchToMain(
    new SReqImage { cam_idx = camIdx, preset_idx = presetIdx, pan = pan, tilt = tilt, zoom = zoom },
    OnRequestImage, ImageTimeoutMs);
```

- **경로 재사용**: `OnRequestImage`(=`/req_img`가 쓰는 델리게이트)가 preset 적용 후 `req.pan/tilt/zoom`을 얹는 기존 로직을 그대로 탄다 → 신규 렌더 경로 없음.
- **무회귀(하위호환)**: pan/tilt/zoom 미제공 시 `0`으로 기본화되어 기존 `/stream`(프리셋) 동작이 그대로 유지된다. 동시 스트림 상한·multipart 프레이밍·503 경로 무변경.

### L3-3. SettingAgent 변경 (TS/JS)

| 파일 | 변경 | 요지 |
|------|------|------|
| `src/clients/CameraClient.ts` | `streamMjpeg` 시그니처 확장 | 4번째 선택 인자 `ptz?: { pan; tilt; zoom }`. 제공 시 URL에 `&pan=&tilt=&zoom=`(zoom은 `clampZoom` 1~36) 부가 |
| `src/viewer/CameraSource.ts` | 계약 확장 | `streamMjpeg?(cam, presetIdx, signal, ptz?: Ptz)` |
| `src/viewer/SimulatorSource.ts` | 위임 확장 | `streamMjpeg(..., ptz?)` → `camera.streamMjpeg(..., ptz)` |
| `src/viewer/routes.ts` | 쿼리 확장 | `StreamQuery`에 `pan/tilt/zoom`(coerce number, optional). **세 값 모두 있을 때만** `{pan, tilt, zoom: clampZoom(zoom)}` 구성해 소스에 전달, 하나라도 없으면 `undefined`(preset 기본) |
| `web/app.js` | 라이브 단일화 | `streamUrl()`에 pan/tilt/zoom 항상 부가 / `move()` origin 인자 제거 + stream 재연결 분기 / `gotoPreset()` origin 제거 |
| `web/core.js` | `moveRenderDirective` 시그니처 변경 | origin 인자 제거, `stream → 'stream-reconnect'` / 그 외 `'tick'` |
| `web/core.d.ts` | 타입 동기화 | `moveRenderDirective(liveMode) → 'stream-reconnect' \| 'tick'` |
| `test/viewerCore.test.ts` | 갱신 | `moveRenderDirective` 6케이스 → 3케이스(stream/poll/off)로 교체(신 시그니처 정합) |

주요 함수 상세:

- **`CameraClient.streamMjpeg(camIdx, presetIdx, signal, ptz?)`**: `ptz` 미제공 시 기존과 동일(`/stream?cam_idx=&preset_idx=`). 제공 시 `&pan={pan}&tilt={tilt}&zoom={clampZoom(zoom)}` 부가. cam/preset 1-based, SOI/EOI 파서·503/오류·abort 경로 무변경.
- **`GET /viewer/api/stream`**: 쿼리 `?cam=&preset=[&source=][&pan=&tilt=&zoom=]`. `q.pan!==undefined && q.tilt!==undefined && q.zoom!==undefined`일 때만 override 전달(`zoom`은 라우트에서도 `clampZoom`). 동시상한4·abort·501(미지원 소스)·503(TOO_MANY_STREAMS) 경로 **전부 무변경**.
- **`web/app.js: streamUrl()`**: `cam/preset(+source)`에 더해 `pan/tilt/zoom = state.ptz`를 **항상** 부가(폴링 `makeUrl`과 동일 값 정책). 프리셋/수동 어느 경우든 `state.ptz`가 최신 → 스트림이 그 PTZ를 렌더.
- **`web/app.js: move(ptz)`**(origin 인자 제거): `/move`(→`/req_move`) 성공 후 `state.ptz=ptz; updatePtzDisplay()`. 이어 `moveRenderDirective(liveMode)`가 `'stream-reconnect'`이면 새 PTZ가 실린 `frame.src = streamUrl()`로 재연결 → Unity `/stream`이 수동 PTZ를 프레임마다 렌더. `'tick'`(poll/off)이면 `await loop.tick()`(폴백 폴링 지속갱신 / off 1회 스냅샷 override — **폴백 경로 보존**).
- **`web/app.js: gotoPreset()`**: `move(ptz)`로 호출(origin 제거). 스트림 모드면 move 내부 재연결이 프리셋 PTZ로 스트림을 렌더. sel-cam/sel-preset/btn-goto의 외부 `reconnectLiveIfActive()`는 무변경 — reconnect(동기)가 먼저 `streamUrl()`로 재연결하고, 뒤늦게 resolve되는 move의 재연결은 **동일 URL**이라 `<img>` 재로드 없이 무해(race 결정적).

**`moveRenderDirective` 계약 변경(시그니처)**: 기존 `moveRenderDirective(liveMode, origin) → 'stream-to-poll' | 'tick' | 'none'` → 신 `moveRenderDirective(liveMode) → 'stream-reconnect' | 'tick'`. `/stream`이 pan/tilt/zoom을 지원하므로 루프2의 "수동+스트림→폴링 전환"·"프리셋+스트림→무동작"이 모두 **stream 재연결** 하나로 통합됐고, origin은 더 이상 렌더 경로에 영향이 없어 인자를 제거했다(내 변경으로 고아가 된 파라미터 정리, CLAUDE.md 규칙3). `move()`·`gotoPreset()`의 origin 전달·기본값도 함께 제거했다.

### L3-4. 입출력·REST 계약 영향

- **Unity `/stream` 계약 확장(하위호환)**: `pan/tilt/zoom`은 **선택** 쿼리 파라미터. 미제공 시 종전 프리셋 동작이라 기존 클라이언트 무회귀.
- **뷰어 `/viewer/api/stream` 계약 확장(하위호환)**: `pan/tilt/zoom`(coerce number, optional) 추가. 세 값 모두 있을 때만 override. `streamMjpeg`의 `ptz?`가 선택 인자라 옛 3-인자 호출·RealPtzSource·기존 테스트 모두 그대로 유효.
- **`/req_move`·`/req_img`·`/snapshot` 시그니처 불변.** 라이브에서 `/req_img` 폴링 의존만 제거되고(수동 PTZ도 이제 스트림), `/req_img`는 캡처 파이프라인에서 계속 쓰인다.

### L3-5. 검증 결과(검증자·구현자 산출물 인용)

- **`npx tsc --noEmit` → EXIT 0(통과)**.
- **`vitest run viewerCore/viewerRoutes/simulatorSource/cameraClientStream` → 56 tests 전부 통과**. `streamMjpeg`의 `ptz?`는 선택 인자(하위호환)라 simulatorSource/cameraClientStream/viewerRoutes 테스트는 무수정 통과했고, `viewerCore.test.ts`의 `moveRenderDirective`만 6케이스→3케이스(stream→'stream-reconnect', poll→'tick', off→'tick')로 교체했다.
- **리더 라이브 실증(부분)**: 옛(미재컴파일) Unity에 대해 추가 pan/tilt/zoom 쿼리 파라미터가 graceful하게 무시되어 스트림이 정상 동작(28프레임 연속 수신). 즉 하위호환은 실증됨.

### L3-6. 한계·미검증(은닉 없이 명시)

- **Unity C# 변경은 에디터 재컴파일 후에만 실반영된다.** 따라서 **수동 PTZ가 실제로 스트림에 반영되는지**(pan 버튼/절대이동 후 화면이 그 각도로 연속 렌더)는 **재컴파일 + 브라우저 하드리프레시 후 검증이 필요하며, 현재 시점 미검증**이다. 현재 실증된 것은 "추가 쿼리 파라미터가 옛 Unity에서 무해하게 무시됨(28프레임)"까지다. 신 Unity에서의 PTZ 실반영은 후속 확인 항목이다.
- **DOM 전이**(`frame.src` 재연결, `<img>` multipart 렌더, 폴백 진입)는 유닛테스트 대상이 아니다(브라우저/리더 실증 영역).
- RealPtzSource 폴백 경로(501 → `fallbackToPolling` → `loop.tick()`)는 코드 무변경으로 보존되나, 실 PTZ 하드웨어 종단 검증은 이번 범위 밖이다.

---

## [루프4] 정적자산 캐시 무효화(재발 방지)

- 추가 작성일시: 2026-07-09 17:15:41
- 대상: SettingAgent 웹 뷰어 정적 자산 서빙(`src/viewer/routes.ts` `@fastify/static` 등록부)
- 근거 산출물: `_workspace/02_developer_changes.md` "## [루프4]" + 실제 변경 소스(`src/viewer/routes.ts`, `test/viewerRoutes.test.ts`)
- 범위: **백엔드 정적 서빙 헤더만**. API 라우트·프론트·Unity **무변경**.

### L4-1. 배경 — 캐시로 인한 코드 미반영 재발

루프1~3 내내 뷰어 정적 자산(`app.js`/`core.js`/`index.html` 등)이 브라우저에 캐시되어, 코드 변경 후 일반 새로고침으로는 반영되지 않고 **매번 하드새로고침(Ctrl+F5)이 필요**했다. 개발 반복(goal/loop)마다 "코드는 고쳤는데 화면이 그대로"인 현상이 재발해 검증 신뢰도를 떨어뜨렸다.

**근본원인 판정(리더 실증)**: 루프3까지 브라우저 라이브 뷰가 여전히 `/req_img` 폴링에 머물러 있던 것이 코드 회귀가 아니라 **브라우저 캐시(원인 A)** 였다. 하드새로고침 후에는 라이브 뷰가 `/stream`(pan/tilt/zoom override 포함)으로 정상 동작함을 **Network 탭 + 슬롯 프로브**로 확인했다. 즉 루프3 코드는 정상이었고, 캐시가 옛 `app.js`를 계속 제공하고 있었을 뿐이다.

### L4-2. 조치 — 모든 정적 응답에 `Cache-Control: no-store`

`@fastify/static` 등록부에 `cacheControl: false`로 기본 `Cache-Control`(max-age) 생성을 끄고, `setHeaders`로 명시적 `no-store`를 부여했다(최소·외과적 수정).

```ts
// 캐시 무효화(루프4): 코드 변경 후 하드새로고침 없이 최신 자산을 로드하도록 모든 정적 응답에 no-store.
await app.register(fastifyStatic, {
  root: resolve(viewer.staticDir),
  prefix: '/viewer/',
  redirect: true,
  cacheControl: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
});
```

- 라우트 순서(정확 경로 API → static 와일드카드)·`redirect: true`·`prefix: '/viewer/'` **유지**.
- `setHeaders`는 static 응답에만 적용되므로 `/viewer/api/*` 동작 **불변**(API의 `no-store`는 이미 각 핸들러가 개별 설정 — 스냅샷·스트림 응답에 기존부터 존재).

### L4-3. 검증

- `npx vitest run test/viewerRoutes.test.ts` → **15 tests 통과**(기존 14 + 신규 1건). 신규 assert: `GET /viewer/app.js` 응답의 `cache-control: no-store`(`test/viewerRoutes.test.ts` L259~). `app.inject`에서도 `setHeaders`가 정상 적용됨을 확인.
- `npx vitest run`(전체) → **107 files / 1069 tests 전부 통과**. 기존 static/mapping/viewerEnabled 회귀 0.
- **라이브 확인**: 정적 응답 헤더에 `Cache-Control: no-store`가 실제로 실림을 확인.

### L4-4. 최종 goal 달성 확정

브라우저 라이브 뷰가 **`/stream`(MJPEG, PTZ override)로 동작**하고 **`/req_img` 라이브 폴링이 제거**됨을 확정했다. 루프3에서 "미검증"으로 남겼던 신 Unity 수동 PTZ 스트림 실반영도, 하드새로고침 후 `/stream`(pan/tilt/zoom) 정상 동작으로 확인되었다. 루프4는 그 확인을 가로막던 캐시 요인을 제거하여 **동일 문제의 재발을 방지**한다.

### L4-5. 한계

- `no-store`는 개발 편의·재발 방지를 위한 것으로, 운영 배포 시 캐시 정책이 필요하면 별도 조정 대상이다(현재 범위 밖). 뷰어는 로컬 개발 툴이라 트래픽 영향은 미미하다.
