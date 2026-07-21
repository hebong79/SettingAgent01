# 01 설계: 정밀수집 종료 화면 리셋 + 센터라이징 실시간 화면 갱신

작성: 리더(현자 라) — B(goal/loop) 모드. 사전 분석 완료 근거로 직접 설계.

## Goal
1. 정밀수집이 done/stopped/error 로 끝나면 화면을 **시작 전 상태**(라이브뷰 + 오버레이 없음)로 되돌린다.
2. 센터라이징 진행 중 화면이 **실시간 갱신**된다.
3. 두 경우 모두 **시뮬레이터 추가 카메라 패킷 0** — 잡이 이미 찍은 프레임을 버퍼링·폴링(정밀수집 `/capture/frame` 패턴 재사용).

## 근본 원인(사실 확인 완료)
- 정밀수집 프레임 갱신 = `CaptureJob.lastFrame` 메모리 버퍼([CaptureJob.ts:349](../src/capture/CaptureJob.ts#L349)) + 웹 500ms 폴 `GET /capture/frame`([captureRoutes.ts:190](../src/api/captureRoutes.ts#L190)). **폴은 카메라 재명령 안 함.** 3초 로그는 잡 자체 `requestImage` 캡처 주기.
- 버그1: 종료 시 `capPoll`([app.js:1899](../web/app.js#L1899))이 `stopCapFramePolling()`만 하고 오버레이 데이터(`detectByKey/vcuboidByKey/occComputeByKey/occByKey`)를 안 지움 + 라이브뷰 미복귀 → 얼어붙은 마지막 프레임 위에 검출/육면체가 남음.
- 버그2: 센터라이징은 `PlatePtz.captureAndDetect`([platePtz.ts:386](../src/calibrate/platePtz.ts#L386))가 매 반복 프레임을 찍지만(=3초 로그) **버퍼/라우트/웹폴이 전무** → 화면 정지.

## 변경 설계

### A. 서버 — 센터라이징 최신 프레임 버퍼 + 라우트 (패킷 0)
1. **`PlatePtzDeps`에 `onFrame?: (jpeg: Buffer, camIdx: number, presetIdx: number) => void` 추가**([platePtz.ts:37](../src/calibrate/platePtz.ts#L37)). `captureAndDetect`의 `requestImage` 직후 `this.onFrame?.(cap.jpg, camIdx, presetIdx)` 1줄 호출. **추가 requestImage 금지** — 이미 찍은 `cap.jpg` 재사용. 단일 캡처 지점이라 이 한 곳이 모든 프레임 커버.
2. **`PtzCalibrator`에 `lastFrame?: {jpeg,camIdx,presetIdx}` 버퍼 + `getLastFrame()`** 추가. `makePlatePtz` 생성 시 `onFrame`을 주입해 버퍼 갱신. 잡 종료(done/error) 시 버퍼는 유지(웹이 마지막 프레임 읽고 라이브 복귀).
3. **`GET /calibrate/frame`**([calibrateRoutes.ts](../src/api/calibrateRoutes.ts)) 추가 — `deps.calibrator.getLastFrame()` 반환. `/capture/frame` 미러: `Content-Type: image/jpeg`, `Cache-Control: no-store`, `X-Cal-Cam`/`X-Cal-Preset` 헤더, 없으면 404. **카메라 재명령 없음.**
   - `CalibrateRouteDeps`는 이미 `calibrator` 보유 → deps 확장 불필요.

### B. 웹 — 정밀수집 종료 리셋 + 센터라이징 프레임 폴
1. **정밀수집 종료 리셋**([app.js capPoll](../web/app.js#L1899)): 활성→종료 전환(wasActive && done/stopped/error) 시 `showCaptureResult` 결과 모달 표시 **후**, 화면을 pre-start로 정리 + 라이브뷰 복귀.
   - **finalize 힌트 보존(확정)**: `finalize`는 클라이언트 `occupancy`를 **optional** 힌트로 받고([captureRoutes.ts:252](../src/api/captureRoutes.ts#L252)) 서버 `job.getSnapshot()`으로도 동작하지만, 최근 "공간배정 최대매칭" 튜닝을 회귀시키지 않도록 힌트를 보존한다. → 리셋 직전 `state.finalizeOccSnapshot = state.occComputeByKey`(얕은 스냅샷)로 저장하고, `buildFinalizeOccupancy()`가 `occComputeByKey` 비었으면 `finalizeOccSnapshot` 폴백. `capStart`에서 스냅샷 초기화.
   - **정리 대상(시각 클러터)**: `resetOverlayDisplay()` 재사용(검출·차량육면체·점유·seg마스크 데이터 삭제 + 선택 해제 + 재렌더). resetOverlayDisplay는 파일 바닥ROI(placeRoi)·mapping을 안 건드리므로 이후 '최종화'가 슬롯을 정상 렌더.
   - **라이브뷰 복귀**: 종료 리셋 시 `startLive()`(스트림 재연결)로 얼어붙은 마지막 캡처 프레임을 실시간으로 대체. 라이브가 원래 off였을 수 있으나, "시작 전 상태 = 라이브뷰"가 사용자 기대 → startLive로 명시 복귀.
2. **센터라이징 프레임 폴**([app.js calPoll](../web/app.js#L2026)): `capFrameTick` 패턴 복제한 `calFrameTick`/`startCalFramePolling`/`stopCalFramePolling`(별도 `calFrameTimer`). `GET /calibrate/frame` 폴(500ms), `X-Cal-*` 헤더로 표시. `calStart`에서 `stopLive()`, running 중 폴 시작, 종료 시 폴 중지 + 라이브뷰 복귀.
3. **상호배타(불변식3)**: 정밀수집 폴(`capFrameTimer`)과 센터라이징 폴(`calFrameTimer`)이 동시에 돌지 않게. `startCalFramePolling`은 `stopLive()`+정밀수집 비활성 전제(센터라이징은 정밀수집과 동시 실행 불가 — 둘 다 카메라 독점). 방어적으로 서로 시작 시 상대 타이머 확인.

## 불변식 / 회귀 가드
- 추가 카메라 패킷 0: onFrame은 기존 `cap.jpg` 재사용, `/calibrate/frame`은 버퍼 반환만.
- 기존 정밀수집 회귀 0: capFrameTick·/capture/frame·finalize 미변경(리셋 로직만 종료 분기에 가산).
- 개별 슬롯 실패 흡수·JSON 정본 저장 등 PtzCalibrator 기존 계약 불변(onFrame은 순수 가산).

## 테스트(vitest)
- `PtzCalibrator`: onFrame 주입 → run 중 `getLastFrame()`이 최신 프레임으로 갱신되는지(camera mock이 jpg 반환, onFrame 호출 검증). 잡 종료 후 버퍼 유지.
- `/calibrate/frame` 라우트: 버퍼 있음 → 200 + jpeg + X-Cal 헤더 / 버퍼 없음 → 404. **카메라 client mock call 0**(라우트가 재명령 안 함).
- (있으면) 웹 순수 리셋 헬퍼 — 대부분 DOM이라 리더 경험적 검증으로 대체, 순수분만 vitest.

## 경험적 검증(리더)
- 라이브 라우트: 서버 13020 구동 중이면 `curl /calibrate/frame`로 shape·헤더 확인(잡 미실행 시 404 정상).
- 시뮬레이터 미가동이면 실 프레임 위 갱신은 한계로 명시, 유닛+라우트 shape로 대체.
