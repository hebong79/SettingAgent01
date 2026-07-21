# 구현 보고 — 클릭점 화면중앙 조준(mode:'point')

설계서 `_workspace/01_architect_plan.md` §1 (a)~(e) 를 그대로 구현했다. 재설계·범위 확장 없음.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `src/calibrate/controlMath.ts` | `aimPtzForPoint()` 순수함수 추가(+`Ptz` 타입 import) |
| `src/calibrate/PtzCalibrator.ts` | `aimPointToCenter()`·`currentPtzFor()`·`gainRef()` 추가, `preAimPtz` 를 `aimPtzForPoint` 호출로 치환 |
| `src/clients/CameraClient.ts` | `ICameraClient.centerOnPoint?()` 옵셔널 선언 추가 |
| `src/viewer/CameraSource.ts` | `CameraSource.centerOnPoint?()` 옵셔널 선언 추가 |
| `src/clients/CameraSourceClient.ts` | 생성자에서 소스 지원 시에만 `centerOnPoint` **조건부 할당** |
| `src/viewer/RealPtzSource.ts` | `centerOnPoint()` 구현(휴컴스 `centerPtz type:'point'`) + 1920×1080 상수·`clamp01` |
| `src/api/calibrateRoutes.ts` | zod enum 에 `'point'` 부활, `mode==='point'` → `aimPointToCenter` 분기 |
| `web/app.js` | `clickMode==='center'` → `mode='point'`, 진행 문구, point 시 프레임 폴링 생략 |
| `web/index.html` | 개별 센터라이징 콤보 라벨/`title` 문구를 새 시맨틱으로 |
| `test/calibrateRoutes.point.test.ts` | 폐기 가드("point → 400")를 새 시맨틱으로 **반전**(+이력 주석), `aimPointToCenter` 스파이 추가 |

## 핵심 구현 노트

- **기하 단일 출처**: `aimPtzForPoint(point, base, gain, maxStepDeg)` = `scaleGainForZoom` → `panTiltCorrection(err={x-0.5, y-0.5})` → `{pan, tilt, zoom: base.zoom}`. `preAimPtz` 는 `center(plateRoi)` 를 넣어 이 함수를 호출하므로 **동작 불변**(기존 preaim 테스트가 회귀 가드).
- **기준 PTZ = 현재 PTZ**: `camera.getPtz(camIdx)`. 실패 시 `startPtzFor` 프리셋 폴백 + `logger.warn`(조용한 강등 금지).
- **능력 협상**: `CameraSourceClient` 는 생성자에서 `if (source.centerOnPoint)` 일 때만 자신의 `centerOnPoint` 프로퍼티를 채운다 → 시뮬(`RpcCameraSource`)은 프로퍼티 미정의 = 미지원 → 기하 폴백(`mode:'geometric'`), 실카(`RealPtzSource`)만 네이티브(`mode:'native'`).
- **저장·검출 0**: `aimPointToCenter` 는 writer/`upsertSlotCentering`/`saveSnapshot`/LPD 어느 것도 호출하지 않는다. `camera.move` 1회(또는 네이티브 1회)뿐. `plateWidth: null`.
- **zoom 불변**: 기하 경로는 `aim.zoom = cur.zoom` 그대로 move. 네이티브 `setcenter type=point` 는 사양상 pan/tilt 만.
- **상호배타**: 기존 `state==='running'`·`pointBusy` 락 그대로 재사용 → 라우트 409 매핑 불변.
- **번호판 경로 무접촉**: `centerOnPoint`(plate/plate-zoom)·`PlatePtz`·저장 경로 한 줄도 수정하지 않음.

## 설계서와 다르게 간 부분

1. **`gainRef()` 헬퍼 추출**(설계서 미기재). `preAimPtz` 와 `aimPointToCenter` 가 동일한 폴백 게인 리터럴을 쓰므로 사설 메서드 1개로 묶었다. 값·동작 동일.
2. **`web/app.js` 종료부 `startLive()` 도 point 에서 생략**. 설계서는 폴링 생략만 명시했으나, point 경로는 `stopLive()` 를 애초에 부르지 않으므로 종료 시 `startLive()` 를 호출하면 멀쩡한 스트림을 불필요하게 재연결한다. 대칭을 맞춰 `if (mode !== 'point')` 로 가드했다.
3. 그 외 (a)~(e) 는 설계서 문면 그대로.

## 검증 결과 (실측)

- `npx tsc --noEmit` → **0 에러**(출력 없음).
- `npx vitest run` → **Test Files 180 passed (180) / Tests 2095 passed (2095)**, Duration 10.87s. 실패 0.
  - 갱신한 `test/calibrateRoutes.point.test.ts` 의 `mode:'point'` 케이스 포함 통과.

## 미검증 한계(은닉 금지)

- 실카메라(192.168.0.153) 네이티브 경로는 장비 미선택이라 **라이브 검증 불가** — 유닛(모킹) 범위까지만.
- 네이티브 좌표 기준 1920×1080 은 휴컴스 사양 고정값. 스트림 해상도가 다를 때의 실측 대조는 미수행.
- 기하 경로 정확도는 폴백 게인(`fallbackGainPanDeg=-62`, `fallbackGainTiltDeg=-35.5` @zoom 1) 에 의존 — 시뮬 cam1 실측치이며 장비별로 다르다. 라이브 관찰 검증은 리더 몫.
