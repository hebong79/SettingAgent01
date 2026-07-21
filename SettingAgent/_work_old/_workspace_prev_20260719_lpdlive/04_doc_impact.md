# 04_영향도 분석 — "현재화면 순수 LPD"(lpd-live) 타입 추가

최종 문서: `SettingAgent/docs/20260719_223437_현재화면순수LPD_타입추가.md`

## 변경 요약
- `src/capture/detectPipeline.ts`: `runDetect` args에 옵셔널 `ptz?:{pan?,tilt?,zoom?}`. 제공 시 `resolvePresetPtz` 스킵 → 그 값이 `presetPtz`(=base 렌더 PTZ)로 대입되고, 동일 값이 `basePtz`(역투영·zoom 재시도 기준)로 전파.
- `src/api/captureRoutes.ts`: `DetectBodySchema`에 옵셔널 `ptz` 객체 추가, `/capture/detect` 핸들러가 `runDetect` args로 전달.
- `web/index.html`: `#lpd-mode`에 `<option value="lpd-live">현재화면 순수 LPD</option>` 추가.
- `web/app.js`: `runLiveDetect(vpdEnabled=false, ptz?)` 옵셔널 확장, `runModeLpdLive()` 신규(runModeLpd 미러 + `runLiveDetect(false, state.ptz)`), 디스패처 `lpd-live` 분기.

## (a) `runDetect` / `DetectBodySchema` 옵셔널 확장 — 하위호환
- 두 시그니처 모두 **가산(addition)만** — 기존 필드/파라미터 제거·타입 변경 없음.
- `ptz` 미지정 시: `args.ptz`가 `undefined`이므로 삼항 분기가 기존 `await resolvePresetPtz(...)` 경로를 그대로 탄다 — 코드 경로가 문자 그대로 이전과 동일.
- 영향 없음 확인 대상(무영향):
  - 기존 3개 검지 모드(`순수 LPD`/`앞면중심 LOOP`/`VPD→LPD`) — 모두 `ptz` 미전달.
  - 자동 검출 경로(`web/app.js` 프리셋 순환 중 1회 자동 `runLiveDetect()`, 인자 없음).
  - 정밀수집(`CaptureJob`) 내부 검출 호출 — `runDetect` 직접 호출부가 아니며 본 변경과 무관.
  - `resolvePresetPtz` 함수 자체는 무변경, 호출 여부만 분기됨.

## (b) VPD 정책(vpdEnabled=false) 준수 — 미접촉
- `runModeLpdLive()`는 `runLiveDetect(false, state.ptz)`로 `vpdEnabled=false`를 고정 전달 — VPD 자동검출 금지 정책(마스터 확정 사항, 기본 OFF)을 위반하지 않는다.
- `runDetect` 내부의 `vpdEnabled` 게이트 로직(`rawVehicles = vpdEnabled ? await deps.vpd.detect(...) : []`, cuboid 분기)은 이번 작업과 무관하게 기존 코드베이스에 이미 존재하던 로직이며 본 변경이 손대지 않았다.

## (c) `resolvePresetPtz`·기존 프리셋 경로 — 불변
- `ptz` 오버라이드가 없는 모든 호출(회귀 테스트 T-2/T-4b로 가드)에서 `resolvePresetPtz`가 정확히 이전과 동일하게 호출되고 `basePtz`가 프리셋 PTZ와 일치함을 확인(`test/lpdLive.test.ts`, 문서화 시점 재실행 통과).
- 줌 재시도 루프·`inverseProjectQuad`(역투영)는 `basePtz` 변수 하나만 참조하므로, 오버라이드가 있을 때/없을 때 모두 자동으로 올바른 기준값을 사용 — 별도 분기 추가 없이 정합 유지.

## (d) 실카메라에서 `requestImage` ptz override의 물리이동 여부 — 확인 필요
- `deps.camera.requestImage(cam, preset, ptz)` 호출이 오버라이드 PTZ로 실제 카메라 프레임을 렌더한다는 전제는 **카메라 소스 구현에 의존**한다.
  - 시뮬레이터 소스(`SimulatorSource`/`CameraClient`): `/req_img` 요청 시 요청 PTZ로 즉시 렌더 — 오버라이드가 그대로 반영될 것으로 예상(코드상 확인, 실측 시뮬 환경 미가동으로 종단 미관찰).
  - 실카메라(Hucoms RTSP/PTZ, `RealPtzSource`/`RpcCameraSource` 계열): `req_img`가 카메라를 물리적으로 이동시키는지, 아니면 별도 `req_move`+안정화 대기가 선행돼야 하는지는 이번 세션에서 검증하지 못했다.
- 세션 중 활성 카메라 소스가 실 Hucoms PTZ 카메라(`192.168.0.153`)로 전환(별도 동시 작업 스트림)되어 시뮬레이터 프레이밍이 깨졌고, 이 때문에 실카메라 경로에서의 `lpd-live` 종단 관찰이 이루어지지 못했다.
- **결론**: 이 항목은 "확인 필요"로 남긴다. 실카메라 소스로 `lpd-live`를 실사용하기 전 별도 확인/검증이 필요하다.

## (e) 문서화 시점 전체 tsc/vitest 재실행 결과
- `npx tsc --noEmit` → **EXIT 0**(오류 없음).
- `npx vitest run` → **Test Files 175 passed (175) / Tests 2003 passed (2003)**.
- 구현자(`02_developer_changes.md`)·오케스트레이터 인계 메시지에는 세션 중 "별도 `getPtz`/hucoms 스트림(미커밋 `CameraSourceClient.ts`) 관련 tsc 8건·테스트 3건 실패, lpd-live와 무관"이라는 기록이 있었으나, 문서화 시점 독립 재실행에서는 해당 실패가 재현되지 않았다. 세션 중 동시 진행된 별도 작업 스트림이 그 상태를 이미 해소했을 가능성이 있으나 확정할 근거는 없다(추정).

## 영향받는 파일 목록 (구체)
| 파일 | 관계 |
|---|---|
| `src/capture/detectPipeline.ts` | 직접 변경 — `runDetect` 시그니처/base PTZ 분기 |
| `src/api/captureRoutes.ts` | 직접 변경 — `DetectBodySchema`/`/capture/detect` 핸들러 |
| `web/index.html` | 직접 변경 — `#lpd-mode` 옵션 추가 |
| `web/app.js` | 직접 변경 — `runLiveDetect`/`runModeLpdLive`/디스패처 |
| `test/lpdLive.test.ts` | 신규 — 본 변경 전용 12케이스 |
| `test/detectPipeline.test.ts` | 간접 영향(무회귀 확인 대상) — `runDetect` 기존 호출 케이스들이 `ptz` 없이 계속 통과함을 재검증 |
| `test/captureRoutes.test.ts` | 간접 영향(무회귀 확인 대상) — `DetectBodySchema` 기존 필드 파싱 케이스 |
| `resolvePresetPtz`(같은 파일 내 함수) | 미접촉이나 호출 여부가 분기됨 — 회귀 테스트로 가드 |
| `CaptureJob`, `CameraClient`/`RpcCameraClient`, MCP 서버, `/capture/start` 등 타 라우트 | 미접촉 — 확인 결과 변경 없음 |

## 확인 필요 항목 (재정리)
1. 실카메라(Hucoms) 소스에서 `requestImage` ptz 오버라이드의 물리 이동 여부 — 종단 미관찰.
2. lpd-live 검출 결과(번호판 박스)의 시각적 정합성 — 카메라 소스 전환으로 세션 내 미관찰.
