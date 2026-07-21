# 02 구현 변경 기록: 정밀수집 종료 화면 리셋 + 센터라이징 실시간 갱신

구현자 — `01_architect_plan.md` 설계 그대로 반영. 추가 카메라 패킷 0(기존 캡처 프레임 버퍼링·폴링 재사용).

## 변경 파일 목록

| 파일 | 변경 |
|------|------|
| `src/calibrate/platePtz.ts` | `PlatePtzDeps.onFrame?` 추가, 생성자 보관, `captureAndDetect` requestImage 직후 훅 호출 |
| `src/calibrate/PtzCalibrator.ts` | `lastFrame` 버퍼 + `getLastFrame()` + 기본 팩토리에 `onFrame` 주입 |
| `src/api/calibrateRoutes.ts` | `GET /calibrate/frame` 라우트 추가 |
| `web/app.js` | 종료 리셋, finalize 힌트 폴백, 센터라이징 프레임 폴, 상호배타 |

## 서버 구현 노트

### A1. `src/calibrate/platePtz.ts`
- `PlatePtzDeps` 에 `onFrame?: (jpeg: Buffer, camIdx: number, presetIdx: number) => void` 추가(가산·옵셔널).
- 생성자에서 `this.onFrame = deps.onFrame` 로 `private readonly` 보관.
- `captureAndDetect`(line ~388): `const cap = await this.camera.requestImage(...)` **직후** `this.onFrame?.(cap.jpg, camIdx, presetIdx);` 1줄. 새 requestImage 추가 없음 — 이미 찍은 `cap.jpg` 재사용. 이 파일 유일 캡처 지점이라 모든 프레임(center/probe/zoom) 커버.

### A2. `src/calibrate/PtzCalibrator.ts`
- private 필드 `lastFrame?: { jpeg: Buffer; camIdx: number; presetIdx: number }` 추가(CaptureJob.getLastFrame 패턴).
- public `getLastFrame()` 추가(getStatus 위). 잡 종료 후에도 버퍼 유지 → 웹이 마지막 프레임 읽고 라이브 복귀.
- 생성자에서 `onFrame` 클로저 `(jpeg,camIdx,presetIdx)=>{ this.lastFrame = {...}; }` 정의 후 **기본 팩토리** `new PlatePtz({ camera, lpd, sleep, onFrame }, opts)` deps 로 주입. `calibrateSlot` 의 `makePlatePtz({...})` 호출은 시그니처(opts 만)라 **미변경** — onFrame 은 팩토리에 baked in. 테스트 시임(`makePlatePtz` 주입) 시엔 onFrame 미호출이어도 무방(옵셔널).

### A3. `src/api/calibrateRoutes.ts`
- `GET /calibrate/frame` 추가. `deps.calibrator.getLastFrame()` → 없으면 `reply.code(404)` `{error:'no frame'}`; 있으면 `/capture/frame` 미러 헤더(`Content-Type: image/jpeg`, `Cache-Control: no-store`, `X-Cal-Cam`, `X-Cal-Preset`) 후 `reply.send(jpeg)`. `CalibrateRouteDeps` 는 이미 `calibrator` 보유 → deps 확장 없음. 카메라 재명령 없음(버퍼 반환만).

## 웹 구현 노트 (`web/app.js`)

### B1. 정밀수집 종료 리셋 (capPoll)
- state 리터럴에 `finalizeOccSnapshot: {}` 필드 추가.
- `wasActive && (done|stopped|error)` 분기의 `showCaptureResult(status)` 직후: `state.finalizeOccSnapshot = state.occComputeByKey;`(얕은 참조 스냅샷) → `resetOverlayDisplay();`(검출·육면체·점유·마스크 삭제+재렌더) → `startLive();`(라이브 MJPEG 재연결).
- `capStart`: `state.finalizeOccSnapshot = {};` 초기화(기존 occByKey/occComputeByKey 초기화 옆).

### B2. finalize 힌트 폴백 (buildFinalizeOccupancy)
- `const src = Object.keys(state.occComputeByKey).length ? state.occComputeByKey : (state.finalizeOccSnapshot || {});` 후 `src` 로 map. 리셋이 occComputeByKey 를 비워도 스냅샷으로 최대매칭 힌트 보존.

### B3. 센터라이징 프레임 폴
- `capFrameTimer` 패턴 복제: `calFrameTimer`/`calFrameUrl` 변수, `calFrameTick`/`startCalFramePolling`/`stopCalFramePolling`.
- `calFrameTick`: `fetch('/calibrate/frame',{cache:'no-store'})` → !ok(404) return; blob→objectURL→frame.src, decode, 이전 URL revoke; `X-Cal-Cam`/`X-Cal-Preset` 로 `cal-msg` 진행 표기. 라운드 개념 없어 직전 키 비교 생략, 매 폴 갱신(500ms). 오버레이 미표시(순수 프레임).
- `startCalFramePolling`: `if(calFrameTimer)return; stopCapFramePolling(); stopLive(); setInterval(500); 즉시 1회.`
- `stopCalFramePolling`: clearInterval + null.
- `calPoll`: `st==='running'` → `startCalFramePolling()`, 아니면 `stopCalFramePolling()`. 활성→완료 전환 블록에 `startLive()` 추가(라이브 복귀; 센터라이징은 오버레이 안 쌓아 resetOverlayDisplay 불요). `calStart` 미변경(startCalFramePolling 가 stopLive 담당).

### B4. 상호배타(불변식3)
- `startCapFramePolling` 앞에 `stopCalFramePolling()` 추가(startCalFramePolling 은 이미 `stopCapFramePolling()` 포함).
- `captureActive()`: `return capFrameTimer !== null || calFrameTimer !== null;` — 센터라이징 중에도 connectionTick(loadCameras 카메라 경합) 억제.

## 불변식 준수 확인
- 추가 카메라 패킷 0: onFrame 은 기존 cap.jpg 재사용, `/calibrate/frame` 은 버퍼 반환만. 새 requestImage 없음.
- 정밀수집 회귀 0: capFrameTick·/capture/frame·finalize 서버로직 미변경. 웹 리셋은 종료 분기 **가산**, buildFinalizeOccupancy 는 폴백만 추가.
- PtzCalibrator 기존 계약(슬롯 실패 흡수·JSON 정본·centering_slot DB) 불변. onFrame 순수 가산.

## 설계 대비 편차
없음. 설계서 A/B 항목 그대로 구현.

## 검증
- `npm run typecheck`(tsc -p tsconfig.json --noEmit) 통과(에러 0).
- 유닛테스트는 다음 단계 qa 담당. 테스트 노출점: `PtzCalibrator.getLastFrame()` public, `PlatePtzDeps.onFrame` 주입점, `GET /calibrate/frame`(버퍼 있음 200+X-Cal 헤더 / 없음 404, 카메라 client mock call 0).
