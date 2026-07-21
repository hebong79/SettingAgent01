# 04 문서화·영향도 요약: 센터라이징 실시간 화면 갱신 + 정밀수집 종료 화면 리셋

문서화 담당(documenter) 작성. 최종 문서: `docs/20260718_133359_센터라이징화면갱신_정밀수집종료리셋.md`

## 영향 모듈·의존성 방향
```
web/app.js (calFrameTick, capPoll 리셋)
  └─ GET /calibrate/frame (src/api/calibrateRoutes.ts)
       └─ PtzCalibrator.getLastFrame() (src/calibrate/PtzCalibrator.ts)
            └─ onFrame 클로저 ← PlatePtz.onFrame 훅 (src/calibrate/platePtz.ts)
                 └─ ICameraClient.requestImage() (기존, 미변경)
```
단방향(라우트→calibrator→PlatePtz), 역방향 결합 없음.

## 기존 기능 영향
- 정밀수집(`capFrameTick`/`/capture/frame`/서버 `finalize` 로직) **미변경** — 웹 리셋은 종료 분기 가산, `buildFinalizeOccupancy()`는 `occComputeByKey` 비었을 때만 스냅샷 폴백.
- `PtzCalibrator` 기존 계약(슬롯 실패 흡수·JSON 정본 저장·`centering_slot` DB 저장) 불변 — `onFrame`은 순수 가산.
- `calibrateSlot`이 호출하는 `makePlatePtz({...})` 시그니처 미변경(`onFrame`은 기본 팩토리 클로저 내부에만 존재).
- config/어셈블리 정의 파일 변경 없음(순수 코드 가산).

## 잠재 리스크·주의점
- 정밀수집↔센터라이징 동시 실행 불가 전제(둘 다 카메라 독점) — 상호배타 폴 타이머(`stopCalFramePolling()`/`stopCapFramePolling()` 상호 호출)로 방어. 전제가 깨지면(향후 병렬 실행 요구) 서로를 강제 종료시키는 부작용 — **확인 필요**.
- `onFrame` 콜백은 현재 단순 대입이라 예외 전파 없음. 향후 콜백 로직이 복잡해지면 `captureAndDetect` 스택 안에서 throw가 센터라이징 잡을 실패시킬 수 있음 — 주의 필요.
- `/calibrate/frame`은 `/capture/frame`과 동일하게 인증/토큰 불요(관찰용 GET) — 신규 리스크는 아니나 향후 인증 도입 시 두 라우트 함께 검토 필요.
- `finalizeOccSnapshot`은 얕은 참조 스냅샷 — 현재 `resetOverlayDisplay()`가 `occComputeByKey`를 새 객체로 재할당해 문제 없음. 향후 in-place mutate 코드 추가 시 재검토 필요.

## 영향받는 구체 파일
| 파일 | 변경 성격 |
|---|---|
| `src/calibrate/platePtz.ts` | `onFrame` 훅 추가(옵셔널) |
| `src/calibrate/PtzCalibrator.ts` | `lastFrame` 버퍼 + `getLastFrame()` + 기본 팩토리 배선 |
| `src/api/calibrateRoutes.ts` | `GET /calibrate/frame` 라우트 신설 |
| `web/app.js` | 종료 리셋, finalize 폴백, `calFrameTick`/폴 함수, 상호배타, `captureActive()` 확장 |
| `test/calibrateFrame.test.ts` | 신규 테스트(7케이스) |

## 검증 결과 인용(검증자 실측)
- 신규 7케이스 PASS(프레임버퍼 2 + 라우트 3 + onFrame훅 2, 불변식 "추가 카메라 패킷 0" 3계층 교차검증 포함).
- 전체 `npx vitest run`: 155 files / 1728 tests passed, 0 failed(회귀 0).
- **미검증(명시)**: `web/app.js` DOM/타이머 결합 로직(vitest 대상 밖, 리더 경험적 검증 위임) 및 실 시뮬레이터 위 센터라이징 프레임 실측 갱신 확인 — 라이브 라우트 404 shape만 확인, 실 프레임 갱신은 후속 확인 필요.

## 확인 필요 항목
- 실 시뮬레이터 구동 상태에서 센터라이징 진행 중 `/calibrate/frame` 프레임이 실제로 갱신되는지 스모크(메커니즘은 검증된 `/capture/frame`과 동일 구조이나 실측 미수행).
- 정밀수집↔센터라이징 동시 실행 시나리오가 향후 요구되는지 여부(현재는 상호배타 전제).
