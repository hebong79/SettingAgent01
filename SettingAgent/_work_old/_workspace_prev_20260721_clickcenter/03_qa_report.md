# 검증 보고 — 개별 center = 클릭 지점을 화면 중앙으로 (mode:'point')

브랜치 `feat/click-center-pantilt` · 커밋 전 작업트리 · 검증자(qa-tester)
대상: `_workspace/01_architect_plan.md` §2 테스트 계획 1~4번 전체.

## 1. 실행 결과 (실측 출력 그대로)

```
> npx tsc --noEmit
(출력 없음, exit 0)   ← 0 에러

> npx vitest run
 Test Files  182 passed (182)
      Tests  2136 passed (2136)
   Start at  13:16:48
   Duration  9.79s (transform 5.09s, collect 29.53s, tests 18.79s, environment 34ms, prepare 17.45s)
```

실패 0 · skip 0 · todo 0. 구현자 보고 시점 기준선은 `180 files / 2095 tests` 였고,
본 검증에서 **테스트 파일 2개·테스트 41개**를 추가해 `182 / 2136` (2095+41=2136, 산술 일치)이 되었다.

검증 중 **1건 실패가 실제로 발생**했고(§4-A), 원인 규명 후 테스트 단언을 실제 계약에 맞게 수정해 통과시켰다.
구현 코드는 수정하지 않았다(느슨하게 고친 것이 아니라, 잘못된 기대를 실측 계약으로 교정).

## 2. 작성/변경한 테스트

| 파일 | 상태 | 내용 |
|---|---|---|
| `test/controlMath.test.ts` | 확장(+8) | `aimPtzForPoint` describe 추가 — 설계서 §2-1 전 항목 |
| `test/ptzCalibratorAimPoint.test.ts` | **신규**(17) | `PtzCalibrator.aimPointToCenter` — 설계서 §2-2 전 항목 |
| `test/calibrateRoutes.point.test.ts` | 확장(+8) | `mode:'point'` 경계면 교차·409/400 매핑·회귀 shape |
| `test/realPtzSourceCenterOnPoint.test.ts` | **신규**(7) | `RealPtzSource.centerOnPoint` — 스텁 계약 + 실 HTTP 와이어 |
| `test/cameraSourceClient.test.ts` | 확장(+2) | 능력 협상(조건부 할당) — 설계서 §1-c |

구현자가 갱신한 폐기 가드(`mode:'point' → 400` → 새 시맨틱 반전)는 **정상 갱신 확인**.
삭제가 아니라 의미 반전 + 이력 주석 형태로, 설계서 §2-3 요구를 충족한다.

### 설계서 §2 테스트 계획 대조

| 계획 항목 | 결과 |
|---|---|
| 1. `aimPtzForPoint` 중앙클릭 델타 0 | 통과 |
| 1. 부호(우하단→pan↑tilt↑ / 좌상단→↓↓) | 통과 |
| 1. zoom 불변 | 통과 (zoom 1/1.6934098/2/12/36 전부) |
| 1. maxStep 클램프 | 통과 (±양방향) |
| 1. zoom 2배 → 델타 절반 | 통과 (×2, ×4 모두 정확히 1/2, 1/4) |
| 2. 저장 스파이 0회(writer·upsertSlotCentering·saveSnapshot) | 통과 (성공·네이티브·move실패 3경로 전부) |
| 2. LPD 0회 | 통과 (+`makePlatePtz` 팩토리 진입 0회도 추가 확인) |
| 2. `camera.move` 1회 + 인자 검증 | 통과 |
| 2. native 우선(스텁 주입 시 move 미호출·`mode:'native'`) | 통과 |
| 2. `getPtz` 실패 → 프리셋 폴백 | 통과 (warn 로그 실측 확인) |
| 2. 배치 running → throw | 통과 |
| 2. 중복 → busy throw | 통과 (+락 finally 해제·예외 경로 해제 추가) |
| 3. `mode:'point'` → 위임·200 shape | 통과 |
| 3. `plate`·`plate-zoom` 회귀 | 통과 (응답에 `mode` 키가 붙지 않음까지 고정) |
| 3. 400·409 매핑 | 통과 (point 경로 전용으로도 별도 확인) |
| 3. 폐기 가드 새 시맨틱 갱신 확인 | 통과 |
| 4. `RealPtzSource` 정규화→픽셀(0.5,0.5→960,540) | 통과 |
| 4. `type:'point'` | 통과 (와이어에서 `center.startx` 부재까지 확인) |
| 4. 범위 clamp | 통과 (−0.4→0, 1.9→1080, 3→1920) |
| 4. setcenter 후 PTZ 조회 위임 | 통과 (호출 순서까지 확인) |

## 3. Requirements 항목별 충족 대조표

| # | Requirement | 판정 | 근거 |
|---|---|---|---|
| 1 | `개별 center+zoom` 기존 그대로(`plate-zoom`) · 회귀 0 | **충족** | `calibrateRoutes.point.test.ts` plate/plate-zoom/legacy zoom 불리언 전 케이스 통과, 응답 shape에 `mode` 키 미부착 고정. `ptzCalibrator.point.test.ts`(기존 13) 무변경 통과. 전체 2136 통과 |
| 2 | 휴컴스 네이티브 `ptz_centering setcenter type=point` 를 실카 경로에서 실제 사용 | **코드상 충족 / 라이브 미검증** | `realPtzSourceCenterOnPoint.test.ts` 가 실 HTTP 서버로 `GET /cgi-bin/control/ptz_centering.cgi?action=setcenter&type=point&speed=50&center.pointx=960&center.pointy=540` 발신을 확인. **장비(192.168.0.153) 미선택이라 물리 동작은 미검증** — §5 참조 |
| 3 | 시뮬 경로가 오늘 동작·검증 | **충족** | 유닛: `mode:'geometric'` 폴백 경로 전 항목 통과. 라이브: 리더 실측 2케이스 성공(§4-C) |
| 4 | 저장 경로 무접촉(회귀 가드 유지) | **충족** | writer·`upsertSlotCentering`·`saveSnapshot` 0회를 3경로에서 단언. LPD·PlatePtz 팩토리 진입도 0회 |
| 5 | 배치·개별 상호배타 가드 유지(409) | **충족** | calibrator throw 2종 + 라우트 409 매핑 point 경로 전용 확인. 락 해제(정상·예외) 추가 확인 |
| 6 | 기존 오버레이 편집 동작(콤보 off) 100% 보존 | **충족(간접)** | `web/app.js` 변경은 `clickMode && clickMode !== 'off'` 분기 **안쪽**의 mode 리터럴 1개 + 폴링 가드뿐. off 경로 코드 무접촉. `viewerOverlayInteractive.test.ts` 등 기존 오버레이 테스트 전부 통과 |

### Goal(관찰 가능한 성공) 대조

| Goal 항목 | 판정 |
|---|---|
| 클릭 지점이 화면 중앙으로 온다 | 충족 — 리더 라이브 실측(§4-C)이 유일한 정본 근거. 유닛은 기하 계산의 정확성만 보증 |
| pan/tilt 만 변한다 · zoom 불변 | 충족 — 유닛(순수함수·calibrator·move 인자) + 라이브 실측 zoom 동일 |
| 검출 비의존 | 충족 — LPD·PlatePtz 호출 0회 단언 |
| 저장 없음 | 충족 — 저장 스파이 3종 0회 단언 |

## 4. 발견 사항

### A. (실패로 드러남 → 계약 확정) 능력 협상은 `in` 연산자로 판정하면 오판한다

내가 처음 작성한 단언 `expect('centerOnPoint' in client).toBe(false)` 가 **실제로 실패**했다.

```
FAIL test/cameraSourceClient.test.ts > centerOnPoint 미지원 소스 …
AssertionError: expected true to be false
```

원인: `tsconfig.json` `target: "ES2022"` → `useDefineForClassFields` 기본 true.
`CameraSourceClient` 의 `centerOnPoint?: (…) => Promise<Ptz>;` **필드 선언**이 생성자 본문보다 먼저
프로퍼티를 `undefined` 로 *정의*한다. 따라서 미지원 소스에서도 `'centerOnPoint' in client === true`.

- **현 구현은 정상**: `PtzCalibrator` 가 `const native = this.camera.centerOnPoint; if (native)` 로
  **값 truthy** 판정을 하므로 시뮬은 정확히 `geometric` 으로 간다(테스트로 확정).
- **다만 지뢰**: 향후 누가 `in` / `Object.keys` / 스프레드로 능력을 판정하면 시뮬을 네이티브로 오판한다.
  설계서 §1-c 의 "조건부 할당" 의도가 프로퍼티 **존재**까지 막지는 못한다는 점이 문서와 어긋난다.
- 조치: 이 계약을 `cameraSourceClient.test.ts` 에 주석과 함께 못 박았다(값 truthy 가 유일한 판정 기준).
  구현 변경은 하지 않았다(범위 밖·동작 정상).

### B. `reason` 필드가 계약에만 있고 채워지지 않는다 (정직성 gap, 경계면)

`aimPointToCenter` 반환 타입은 `reason?: string` 을 선언하고 라우트도 `...(a.reason ? {reason} : {})` 로
전파하지만, **구현 어느 경로도 `reason` 을 설정하지 않는다.**

경계면 교차 결과 UI 에서 다음이 일어난다 — `web/app.js` 는
`const why = (data && (data.reason || data.error)) ?? (res ? res.status : 'error')`.
기하 경로에서 `camera.move` 가 `false` 를 반환하면 응답은 `{ok:false, …, mode:'geometric'}`(reason 없음, HTTP 200)이고,
조작자는 **`종료(200)`** 이라는 무의미한 문구를 본다. 실패했는데 이유가 없다.

- 심각도: 낮음(기능 실패 아님, 진단성 결함). 
- 권고: `move` 실패 시 `reason: 'move_failed'`, 네이티브 throw 시 라우트 400 메시지 유지.
- 테스트는 **미래 계약을 선반영**해 두었다(`reason` 동반 반환 → 응답 전파 통과). 구현이 채우기만 하면 된다.

### C. `mode` 값이 프론트에 도달하지만 사용되지 않는다

라우트가 `mode:'native'|'geometric'` 을 200 응답에 실어 보내는데 `web/app.js` 는 이 필드를 읽지 않는다.
Requirements 에 없는 항목이라 **미충족으로 판정하지 않는다**. 다만 실카/시뮬 경로 구분을 조작자가 알 수 없으므로,
네이티브 도입 후 진단을 위해 문구에 표기하는 편이 낫다(문서화 담당에게 전달).

### D. 네이티브 경로에서 불필요한 `getPtz` 왕복 1회 + 오해 소지 warn

`aimPointToCenter` 는 `const cur = await this.currentPtzFor(...)` 를 **네이티브 분기 판정보다 먼저** 실행한다.
네이티브 경로에서 `cur` 는 전혀 쓰이지 않으므로, 실카메라 클릭마다 장비 PTZ 조회가 1회 낭비된다.
게다가 조회가 실패하면 실제로는 프리셋으로 조준하지 않는데도
`'현재 PTZ 조회 실패 → 프리셋 PTZ 로 조준(오차 가능)'` warn 이 찍힌다(사실과 다른 로그).

- 심각도: 낮음(지연 1왕복 + 로그 정확도).
- 권고: 네이티브 분기를 `currentPtzFor` 호출보다 앞으로 옮긴다(1줄 이동).
- 현 동작은 테스트로 고정해 두었다(`getPtz throw + 네이티브 → 여전히 native`) — 리팩터 시 회귀 가드가 된다.

### E. 경계면 shape 교차 비교 (MCP/REST ↔ 소비자) — 불일치 없음

| 경계 | 생산자 | 소비자 | 결과 |
|---|---|---|---|
| `aimPointToCenter` 반환 ↔ `POST /calibrate/point` 200 | `{ok, ptz, plateWidth:null, mode, reason?}` | 라우트가 동일 키로 매핑 | 일치(단, `reason` 은 §4-B) |
| 라우트 200 ↔ `web/app.js` | `{ok, ptz, plateWidth, mode}` | `data.ok` / `data.reason\|\|data.error` | 일치(미사용 필드 §4-C) |
| `web/app.js` 요청 ↔ `PointBodySchema` | `{cam, preset, point:{x,y}, mode}` | zod enum `['point','plate','plate-zoom']` | 일치 |
| `CameraSource.centerOnPoint` ↔ `RealPtzSource` | 정규화 `{x,y}` 0~1 | ×1920/×1080 후 `range(0,1920)` 정수 | 일치 (clamp01 이 `HucomsValidationError` 를 선제 차단 — 확인함) |
| `HucomsClient.centerPtz` ↔ 와이어 | `pointX/pointY` | `center.pointx`/`center.pointy` | 일치(실 HTTP 로 확인) |
| 콤보 `center` ↔ mode | `'center'` | `'point'` | 일치 (`center-zoom`→`plate-zoom` 회귀 없음) |

## 5. 라이브 검증 사실 기록 및 한계 (은닉 금지)

### 리더가 수행한 라이브 검증 (시뮬 `cam1 preset1`, 본 검증자가 아닌 리더 실측)

| 케이스 | 클릭(정규화) | 관측 결과 | zoom |
|---|---|---|---|
| 1 | (0.117, 0.690) | (0.492, 0.483) — 중앙 근접 | 1.6934098 (불변) |
| 2 | (0.943, 0.479) | (0.506, 0.479) — 중앙 근접 | 1.6934098 (불변) |

두 케이스 모두 `mode: 'geometric'`. 화면 폭 기준 중앙 오차 |Δ| ≤ 0.017 로,
Goal "그 지점이 화면 중앙으로 온다" 및 "zoom 불변" 을 관찰 수준에서 만족한다.
좌우 극단(0.117 / 0.943) 양방향에서 성립하므로 부호·게인 방향도 실증됐다.

### 미검증 한계 (통과로 위장하지 않음)

1. **실카메라 네이티브 경로 라이브 미검증**. 장비(192.168.0.153)가 런타임에 선택돼 있지 않다
   (`cameraRuntime.selectedCameraId = "simulator-1"`). `mode:'native'` 는 **모킹·실 HTTP 와이어 형식까지만**
   검증했고, 실제 `setcenter` 로 화면이 중앙에 오는지·응답 지연·PTZ 조회 타이밍(이동 완료 전 조회 시 과거값 반환 가능)은
   전혀 확인하지 못했다. 스모크 테스트 **누락**으로 명시한다.
2. **기준 해상도 1920×1080 가정 미실측**. 스트림 해상도가 다를 때의 좌표 오차는 장비 없이는 확인 불가.
3. **기하 게인은 시뮬 cam1 실측치**(`fallbackGainPanDeg=-62`, `fallbackGainTiltDeg=-35.5` @zoom 1).
   다른 카메라·프리셋·큰 zoom 에서의 정확도는 미검증. 게인 ∝1/zoom 선형성은 zoom 1.69341 부근 실측 근거만 있다.
4. **라이브 관찰은 리더 실측 2케이스**뿐이며 화면 중앙 판정은 육안·좌표 대조다. 자동 회귀는 없다.

## 6. 결론

Requirements 6항 전부 충족(2번은 코드·와이어 계약까지 충족, 물리 동작은 미검증 한계 명시).
`tsc --noEmit` 0 에러, `vitest run` **182 files / 2136 tests 전부 통과, 실패 0**.
구현 수정을 요할 실패(blocking bug)는 발견되지 않았다. §4-B·§4-D 는 후속 개선 권고(비차단)다.
