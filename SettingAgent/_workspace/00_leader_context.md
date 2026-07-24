# 00 리더 컨텍스트 — 뷰어 라이브 3fps 스냅샷 폴링 고착 제거

작성: 2026-07-24 / 실행 모드: **A(선형 파이프라인)** — 성공기준을 vitest + 라이브 라우트/로그 관측으로 확정 가능.

## 사용자 요청

> "초당 3프레임 요청 패킷이 부활했다. 근본적인 원인을 파악해줘." → (원인 보고 후) **"수정해주고 기존 코드는 제거해줘."**

## 리더가 확정한 근본 원인 (로그·실측 근거)

3fps 폴링을 켜는 코드 경로는 단 하나: `web/app.js:1565` `loop.start(Number($('fps').value) || 3)`,
호출자는 `fallbackToPolling()`(app.js:1561) 하나뿐이며 트리거는 `frame.onerror`.

**MJPEG → 스냅샷 폴링 폴백이 편도(one-way)** — 스트림이 한 번 실패하면 `liveMode='poll'` + `setInterval(333ms)` 으로
영구 고착된다. 스트림 자동 복귀 경로가 없고(사용자가 시작/cam·preset 변경 시에만 복귀), 실패 시 백오프도 없다.

### 증거 (`SettingAgent/logs/setting_20260724_215422.log`)

| 시각 | 관측 | 해석 |
|------|------|------|
| 21:54:22 | 서버 재기동 | 열린 탭의 MJPEG 절단 → onerror → 폴백(3.3 패킷/s, 전부 fetch failed) |
| 22:18:03 | 33·36 패킷/10초 | Unity down 상태에서 라이브 재시작 → `/stream` 502 → 폴백 재고착 |
| 22:18:17 | Unity(Parking3D pid 8796) 기동 | 이후 **63 패킷/10초 = 6.3/s** = 3fps × RPC 2회 |
| ~22:25 | 6.3/s 7분+ 지속 | 스트림이 정상인데도 폴링 유지 |

- 1프레임 = `mode=manual` 스냅샷 = `cam.setPTZ` + `cam.captureJPG` **2 RPC**(`RpcCameraSource.snapshot`).
  로그의 `ms:2~15`(setPTZ) / `ms:58~76`(captureJPG) 교대 패턴이 이를 확증.
- 클라이언트는 서버가 아니라 **Chrome 탭**(pid 12756 → 13020 ESTABLISHED). `src/` 에 `setInterval` 0건.
- 실측: Unity `GET /stream` 200(13MB/3s), SettingAgent `GET /viewer/api/stream?cam=1&preset=1` 200(11.7MB/3s)
  → 스트림 경로는 **정상**. 고장난 것은 탭의 상태(`liveMode='poll'`).

## 이번 작업 범위 (리더 결정)

"기존 코드 제거" = **레거시 3fps 폴링 폴백 경로 자체를 삭제**한다(죽은 분기 방치 금지 — CLAUDE.md §3).

1. `fallbackToPolling()` 삭제 → **스트림 자동 재시도(지수 백오프)** 로 대체.
2. `liveMode` 도메인: `'off' | 'stream'` (+ 재시도 대기 상태 표현) — `'poll'` 제거.
3. 고아가 되는 코드 제거: `core.js` `fpsToInterval`, `createStreamLoop` 의 타이머(`start`/`setTimer`/`clearTimer`),
   `index.html` 의 `fps` 입력, `core.d.ts` 대응 타입, 관련 테스트.
   **단, 라이브 off 상태의 1회 스냅샷(`loop.tick()`)은 존치**(move/gotoPreset 화면 갱신에 필요).
4. 재시도 중임을 UI에 표시(무표시 열화 금지).

### 유지/비범위
- 정밀수집·센터라이징·탐색의 500ms 프레임 폴(`capFrameTimer`/`calFrameTimer`/`discFrameTimer`)은 **잡 진행 표시용 별도 경로** — 무변경.
- `/viewer/api/snapshot` 라우트·`CaptureJob`·`CameraSourceClient.pollSnapshots`(스트림 미지원 소스 서버측 폴백) 무변경.

### 알려진 트레이드오프 (설계 시 반영)
`img.onerror` 는 HTTP 상태를 알 수 없어 501(STREAM_UNSUPPORTED)과 일시 장애를 구분하지 못한다.
폴링 폴백을 없애면 스트림 미지원 소스에서는 재시도만 반복된다.
현재 등록 소스는 전부 스트림 지원(`/viewer/api/health`: simulator-1/2 `http-mjpeg`, real-camera-1/2 `rtsp-ffmpeg`)이므로 수용 가능.
재시도 상한 도달 시 사용자에게 명시적으로 알리는 것으로 갈음한다.
