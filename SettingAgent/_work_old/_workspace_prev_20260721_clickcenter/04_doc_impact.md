# 영향도 분석 — 클릭지점 화면중앙 조준(mode:'point') 능력 협상 재도입

작성: documenter / 대상 커밋: 브랜치 `feat/click-center-pantilt`(작업트리, 커밋 전)
근거: 실제 `git diff` + 소스 대조(추정 없음). 상세 서술은 `docs/20260721_132500_클릭지점_화면중앙조준_능력협상.md` 참조.

## 1. 기존 `centerOnPoint`(번호판 기준) 경로 — 무접촉 확인

`src/api/calibrateRoutes.ts` diff:
```ts
if (p.data.mode === 'point') {
  const a = await deps.calibrator.aimPointToCenter(p.data.cam, p.data.preset, p.data.point);
  return { ok: a.ok, ptz: a.ptz, plateWidth: a.plateWidth, mode: a.mode, ...(a.reason ? { reason: a.reason } : {}) };
}
// 번호판 기반 centerOnPlate. mode 우선(plate=center만/plate-zoom=center+zoom), 없으면 legacy zoom 불리언.
const zoom = p.data.mode ? p.data.mode === 'plate-zoom' : p.data.zoom;
const r = await deps.calibrator.centerOnPoint(p.data.cam, p.data.preset, p.data.point, { zoom });
```
`mode==='point'` 분기는 함수 진입부에서 **조기 반환**하므로 이후의 기존 `centerOnPoint` 호출 코드는
문자 그대로 한 줄도 수정되지 않았다. `PtzCalibrator.centerOnPoint()`(번호판 center/center+zoom,
`platePtz.ts`의 `PlatePtz` 폐루프 사용) 본문도 이번 diff에 포함되지 않는다(`git diff PtzCalibrator.ts`
확인: 추가된 것은 `aimPointToCenter`·`currentPtzFor`·`gainRef`뿐, 기존 메서드는 무변경).
**판정: 무접촉.** `plate`/`plate-zoom` 경로 회귀는 QA가 `calibrateRoutes.point.test.ts`에서
"응답에 `mode` 키가 붙지 않음"까지 고정해 확인했다(`03_qa_report.md` §2 대조표).

## 2. 옵셔널 인터페이스 확장이 기존 구현체에 미치는 영향

`ICameraClient.centerOnPoint?()`(`CameraClient.ts`) / `CameraSource.centerOnPoint?()`(`CameraSource.ts`)
모두 `?` 옵셔널 시그니처로 추가됐다. TypeScript 구조적 타이핑에서 옵셔널 멤버는 구현체가 정의하지
않아도 인터페이스 만족 조건을 깨지 않는다.

실제 구현체 확인(`grep implements`):
| 구현체 | 파일 | `centerOnPoint` 정의 | 영향 |
|---|---|---|---|
| `CameraClient` | `src/clients/CameraClient.ts` | 없음(diff 대상 아님) | 없음 — 컴파일 통과, 호출 시 `undefined`이므로 폴백 경로로 판정됨 |
| `RpcCameraClient` | `src/clients/RpcCameraClient.ts` | 없음 | 없음(동일) |
| `SimulatorSource` | `src/viewer/SimulatorSource.ts` | 없음 | 없음(동일) — 시뮬은 이 경로를 통해 `mode:'geometric'`으로 폴백 |
| `RpcCameraSource` | `src/viewer/RpcCameraSource.ts` | 없음 | 없음(동일). 오늘 라이브 검증(§5 in 본문 문서)은 이 경로로 수행됨 |
| `CameraposSource` | `src/viewer/CameraposSource.ts` | 없음 | 없음(동일) |
| `RealPtzSource` | `src/viewer/RealPtzSource.ts` | **있음**(신규 구현, §4.5) | 실카메라 전용 신규 기능. 기존 메서드(diff 확인: `login`/`move`/`getPtz`/`streamMjpeg` 등)는 무변경 |
| `CameraSourceClient` | `src/clients/CameraSourceClient.ts` | **조건부**(생성자에서 `source.centerOnPoint` 존재 시만 할당) | 생성자 본문에 1줄 추가 외 기존 메서드 무변경 |

**판정: 실질적 영향은 `RealPtzSource`(신규 구현)와 `CameraSourceClient`(조건부 배선 1줄) 두 파일에
한정되며, 나머지 5개 구현체는 소스 코드 수정 없이 `tsc --noEmit` 0 에러로 컴파일 호환성이 실측
확인됐다(`03_qa_report.md` §1).**

## 3. 저장·DB·SetupPipeline 자동연쇄 — 무접촉 확인

`aimPointToCenter()` 본문(`PtzCalibrator.ts` diff)에는 다음 호출이 **존재하지 않는다**:
- `writer(...)`/`writeSlotPtz` 계열
- `upsertSlotCentering`(DB `centering_slot`)
- `saveSnapshot`/`SaveStore` 계열(Setup 스냅샷)
- `expandPlateTargetsFromSlotSetup`, `makePlatePtz`(LPD 검출 진입점)

QA가 3개 경로(성공/네이티브/move 실패)에서 저장 스파이 0회, LPD·`PlatePtz` 팩토리 진입 0회를 단언해
통과시켰다(`03_qa_report.md` §2 표). `aimPointToCenter`는 `run()`(배치 잡, 저장 3중 경로)과 별개의
공개 메서드이며 `run()`을 호출하지 않는다. **판정: SetupPipeline·DB·파일 저장 자동연쇄 무접촉.**

## 4. `preAimPtz` 리팩터가 배치 센터라이징에 미치는 영향

`PtzCalibrator.ts` diff:
```diff
 private preAimPtz(t: PlateTarget, base: Ptz): Ptz {
-  const g = scaleGainForZoom({...}, base.zoom);
   const c = center(t.plateRoi);
-  const err = { errX: c.cx - 0.5, errY: c.cy - 0.5 };
-  const pt = panTiltCorrection(err, g, base.pan, base.tilt, PREAIM_MAX_STEP);
-  return { pan: pt.pan, tilt: pt.tilt, zoom: base.zoom };
+  return aimPtzForPoint({ x: c.cx, y: c.cy }, base, this.gainRef(), PREAIM_MAX_STEP);
 }
```
호출 인자를 그대로 대입하면 신구 로직이 수학적으로 동일하다(`scaleGainForZoom(gain, base.zoom)` →
`panTiltCorrection(err, g, base.pan, base.tilt, PREAIM_MAX_STEP)`, `err`도 동일 정의). `gainRef()`는
기존 `{fallbackGainPanDeg, fallbackGainTiltDeg, zoomRef:1}` 리터럴을 그대로 반환하는 헬퍼이므로 값 변경
없음.

`preAimPtz`의 호출부는 `grep` 결과 `PtzCalibrator.ts:333`(배치 `run()` → `calibrateSlot` 경로) **단 1곳**
뿐이다. 즉 이 리팩터가 영향을 미칠 수 있는 표면은 배치 센터라이징의 슬롯별 선조준 1개 지점으로
한정된다. 회귀 가드는 기존 pre-aim 테스트(수정 없이 그대로 통과)와 전체 vitest 2136 통과로 확인됐다.
**판정: 동작 동일(리팩터), 영향 없음.** 단, 이 판정은 정적 코드 대조 + 유닛 테스트 통과에 근거하며,
배치 센터라이징 자체의 라이브 재실측(예: 전 슬롯 재실행)은 이번 QA 범위에 포함되지 않았다 —
**확인 필요**로 남긴다(다만 배치 경로 코드 자체는 diff 대상이 아니므로 리스크는 낮다고 판단).

## 5. web UI 콤보 변경이 오버레이 편집에 미치는 영향

`web/app.js` diff의 변경 지점은 `wireOverlayEditing()` 내부 게이트:
```diff
 if (clickMode && clickMode !== 'off' && !e.ctrlKey) {
   const { nx, ny } = eventToNorm(e);
   e.preventDefault();
-  const mode = clickMode === 'center-zoom' ? 'plate-zoom' : 'plate';
+  const mode = clickMode === 'center-zoom' ? 'plate-zoom' : 'point';
   void calPointCenter(nx, ny, mode);
   return;
 }
```
이 분기는 `clickMode !== 'off'`(콤보가 `center` 또는 `center-zoom`으로 명시 선택된 경우)에서만
진입한다. 콤보 기본값은 `off`이며, `off`일 때는 이 블록 전체가 건너뛰어져 이후의 기존 검출/슬롯 편집
분기로 그대로 진입한다 — **이 diff는 `off` 경로의 코드를 한 줄도 건드리지 않는다.**

바뀐 것은 `center` 선택 시 전달되는 문자열 리터럴(`'plate'` → `'point'`) 하나이며, `calPointCenter()`
함수 내부의 프레임 폴링 생략 조건(`if (mode !== 'point')`)과 종료 시 `startLive()` 생략 조건도
같은 함수 내 조건부 가드일 뿐 다른 함수·전역 상태를 변경하지 않는다.

QA가 확인한 근거: `viewerOverlayInteractive.test.ts` 등 기존 오버레이 테스트 전체 통과
(`03_qa_report.md` Requirements 6 대조: "충족(간접)"). 다만 이는 **REST 계약·JS 로직 수준의 간접
확인**이며, 실제 브라우저 DOM에서 `off` 상태의 오버레이 클릭(검출/슬롯 선택)이 여전히 동일하게
동작하는지의 **E2E 스모크는 수행되지 않았다** — `docs/20260721_132500_...` §8-4에서 이미 명시한
한계와 동일선상이다.

**판정: 코드 경로상 `off`(기본, 통상적 오버레이 편집) 무접촉. `center`/`center-zoom` 선택 시에만
동작이 바뀌며, 이는 이번 기능의 의도된 변경이다.**

## 6. 종합

| 영향 대상 | 판정 | 근거 |
|---|---|---|
| 번호판 기준 `centerOnPoint`(`plate`/`plate-zoom`) | 무접촉 | §1, diff 조기 반환 구조 |
| `ICameraClient`/`CameraSource` 기존 5개 구현체 | 무접촉(컴파일·런타임 모두) | §2, 옵셔널 멤버 + tsc 0에러 |
| 저장(`writer`)/DB(`centering_slot`)/Setup 스냅샷 | 무접촉 | §3, 호출부 부재 + QA 스파이 단언 |
| 배치 센터라이징 `preAimPtz`(슬롯 선조준) | 동작 동일(리팩터) | §4, 수학적 등가 + 단일 호출부 + 테스트 통과 |
| web 오버레이 편집(`off`, 기본값) | 무접촉 | §5, 조건부 게이트 밖 |
| web 오버레이 편집(`center`/`center-zoom` 선택 시) | 의도된 변경 | §5 — `'plate'` → `'point'` 리터럴 |

**확인 필요로 남긴 항목**: §4의 배치 센터라이징 라이브 재실측(전 슬롯 실행)은 이번 작업 범위에서
수행되지 않았다. 정적 대조·단위 테스트로는 리스크 낮음으로 판단되나, 실측 재확인은 후속 필요 시
별도 진행 권고.
