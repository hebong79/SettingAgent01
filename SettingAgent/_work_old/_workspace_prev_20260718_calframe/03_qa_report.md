# 03 QA 리포트: 센터라이징 실시간 프레임 버퍼 + GET /calibrate/frame + onFrame 훅

검증자(qa-tester) — vitest 유닛으로 설계 §A / 구현 §A1~A3 검증. 외부 REST(카메라/LPD)는 모킹.

## 작성 테스트 파일
- `test/calibrateFrame.test.ts` (신규, 7 케이스)

## 케이스 목록 및 결과 (전부 통과)

### 1. PtzCalibrator 프레임 버퍼 (2)
| 케이스 | 검증 내용 | 결과 |
|--------|-----------|------|
| 시작 전 undefined → 진행 중 갱신 → 종료 후 유지 | `getLastFrame()`이 시작 전 `undefined`, 잡 `done` 후 최신 프레임 보유. `jpeg`는 마지막 캡처 `cap.jpg`와 **참조 동일**(복사/재캡처 없음), `camIdx/presetIdx=1/1` | PASS |
| ★불변식: 프레임 버퍼가 카메라 요청 수 미증가 | 기본 팩토리(onFrame 배선) vs `makePlatePtz` 주입(onFrame 미배선) 두 잡의 `requestImage` 호출 수 **동일**. 후자는 `getLastFrame()` `undefined` | PASS |

### 2. GET /calibrate/frame (3)
| 케이스 | 검증 내용 | 결과 |
|--------|-----------|------|
| 버퍼 있음 → 200 | `getLastFrame()` stub → 200 + `Content-Type: image/jpeg` + `Cache-Control: no-store` + `X-Cal-Cam=2`/`X-Cal-Preset=3` + body=jpeg 버퍼 그대로(`rawPayload.equals`) | PASS |
| 버퍼 없음 → 404 | 잡 미실행(lastFrame undefined) → 404 `{error:"no frame"}` | PASS |
| ★불변식: 카메라 client mock call 0 | 라우트 호출이 `camera.requestImage`를 **부르지 않음**(spy `not.toHaveBeenCalled`) — 버퍼 반환만 | PASS |

### 3. platePtz onFrame 훅 (2)
| 케이스 | 검증 내용 | 결과 |
|--------|-----------|------|
| centerOnPlate 매 캡처 직후 onFrame | `onFrame` 호출 수 == `requestImage` 호출 수, 각 인자 `jpeg`가 그 캡처 `cap.jpg`와 참조 동일, `cam/preset=1/1` | PASS |
| ★onFrame 유무 무관 requestImage 수 동일 | onFrame 있음 vs 없음 두 실행의 `requestImage` 호출 수 동일 | PASS |

## 불변식 "추가 카메라 패킷 0" 검증 결과
세 계층 각각에서 교차 검증 완료 — **모두 통과**:
- PlatePtz 훅 계층: onFrame 은 캡처당 정확히 1회, `cap.jpg` 재사용(참조 동일), 있음/없음 간 `requestImage` 수 동일.
- PtzCalibrator 잡 계층: 기본 팩토리(버퍼 갱신) vs onFrame 미배선의 `requestImage` 총 호출 수 동일.
- REST 라우트 계층: `GET /calibrate/frame` 이 `camera.requestImage` 를 호출하지 않음.

## 전체 스위트 회귀
- `npx vitest run` (전체): **Test Files 155 passed / Tests 1728 passed / 0 failed**.
- 정밀수집·PlatePtz·calibrateRoutes 등 기존 테스트 회귀 0. 신규 파일만 가산.

## 한계 (경험적 검증 리더 위임)
- `web/app.js` 변경(정밀수집 종료 리셋·finalize 힌트 폴백·센터라이징 프레임 폴 `calFrameTick`·상호배타)은 DOM/타이머 결합이라 vitest 미대상. `buildFinalizeOccupancy`도 `state`/DOM 결합으로 순수 분리 불가 → **웹 종료리셋·프레임폴·상호배타는 리더 경험적 검증(라이브 라우트/스샷) 위임**.
- 실제 시뮬레이터 연동 스모크(`curl /calibrate/frame` 라이브 shape·헤더, 실 프레임 위 갱신)는 미수행(유닛/모킹만). 서버 구동 시 리더 확인 필요 — **누락으로 명시**.

## 결론
구현 결함 없음. 신규 7 케이스 전부 통과 + 전체 1728 통과(회귀 0). 불변식 3계층 교차 검증 완료.
