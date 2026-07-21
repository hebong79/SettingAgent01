# 설계 — 클릭점 화면중앙 조준(방안 C: 능력 협상 하이브리드)

작성: 리더(오케스트레이터). 사전 코드 조사 완료 — 아래 경로·심볼은 실재 확인됨.

## 0. 핵심 발견 (재조사 불요)
- `PtzCalibrator.preAimPtz()` ([PtzCalibrator.ts:458](../src/calibrate/PtzCalibrator.ts#L458))가 **이미 정확히 필요한 기하**를 한다:
  `err={cx-0.5, cy-0.5}` → `scaleGainForZoom(gain, base.zoom)` → `panTiltCorrection(err, g, pan, tilt, PREAIM_MAX_STEP)` → **zoom 불변**.
  즉 "클릭점 조준"은 `plateRoi 중심` 대신 `클릭점`을 넣는 것과 동일하다. 신규 수학 없음.
- 게인 실측치: `fallbackGainPanDeg=-62`, `fallbackGainTiltDeg=-35.5` @zoomRef=1, 게인 ∝ 1/zoom (`platePtz.ts` 상단 주석: 1°/2°/3° 완전 선형 검증).
- 휴컴스 네이티브: `HucomsClient.centerPtz({type:'point', pointX, pointY})` → `ptz_centering.cgi/setcenter`. **픽셀 0~1920 / 0~1080**, point 타입은 pan/tilt만. 현재 호출자 0건.
- 런타임 카메라: `cameraRuntime.selectedCameraId="simulator-1"`(Unity RPC) → `CameraSourceClient` → `RpcCameraSource`. 실카(`real-camera-1`)는 미선택.
- 폐기 이력: 이전 `mode:'point'`(patch-NCC 폐루프)는 실패·삭제됨. **이번 안은 폐루프·패치추적을 쓰지 않는다**(오픈루프 1샷). 폐기 가드 테스트는 "새 시맨틱"으로 갱신 대상.

## 1. 변경 목록 (외과적)

### (a) `src/calibrate/controlMath.ts` — 순수함수 추가
```ts
/** 정규화 지점(0~1)을 화면중앙으로 보내는 절대 pan/tilt. zoom 불변. */
export function aimPtzForPoint(
  point: { x: number; y: number },
  base: Ptz,
  gain: { gainPan: number; gainTilt: number; zoomRef: number },
  maxStepDeg: number,
): Ptz
```
- 내부: `scaleGainForZoom` → `panTiltCorrection({errX: point.x-0.5, errY: point.y-0.5}, ...)` → `{pan, tilt, zoom: base.zoom}`.
- `PtzCalibrator.preAimPtz` 는 이 함수를 호출하도록 **치환**(중복 제거, 동작 불변 — 기존 preaim 테스트가 회귀 가드).

### (b) `src/calibrate/PtzCalibrator.ts` — `aimPointToCenter` 추가 (가산)
```ts
async aimPointToCenter(camIdx, presetIdx, point): Promise<{ ok, ptz, plateWidth: null, mode: 'native'|'geometric', reason? }>
```
1. 상호배타 가드(`state==='running'` → throw 'running', `pointBusy` → throw 'busy'). 기존 `centerOnPoint` 와 동일 락 재사용.
2. **기준 PTZ = 현재 PTZ**(`camera.getPtz(camIdx)`). 클릭은 "지금 보이는 화면" 기준이므로 프리셋 base 를 쓰면 안 된다.
   실패 시 `startPtzFor({camIdx,presetIdx})` 폴백 + `logger.warn`(조용한 강등 금지).
3. 네이티브 우선: `camera.centerOnPoint?.(camIdx, point)` 가 있으면 호출 → 반환 Ptz 로 `mode:'native'` 반환.
4. 없으면 기하: `aimPtzForPoint(point, cur, {gainPan: cfg.fallbackGainPanDeg, gainTilt: cfg.fallbackGainTiltDeg, zoomRef: 1}, PREAIM_MAX_STEP)` → `camera.move(pan, tilt, zoom)` 1회 → `mode:'geometric'`.
5. **저장 호출 0**(writer/upsertSlotCentering/saveSnapshot 미호출). 검출(LPD) 호출 0. `plateWidth: null`.
6. `finally { pointBusy = false }`.

### (c) 능력 협상 배선 (옵셔널 메서드 3곳)
- `src/clients/CameraClient.ts` `ICameraClient` 에 `centerOnPoint?(camIdx, point): Promise<Ptz>` **옵셔널** 추가(기존 구현체 무영향).
- `src/viewer/CameraSource.ts` `CameraSource` 에 동일 옵셔널 추가.
- `src/clients/CameraSourceClient.ts`: `source.centerOnPoint` 존재 시에만 자신도 노출해야 함 →
  **주의**: 메서드를 무조건 정의하면 sim 에서도 "지원"으로 보인다. 생성자에서
  `if (source.centerOnPoint) this.centerOnPoint = (c, p) => source.centerOnPoint!(c, p);` 형태로 **조건부 할당**한다.
- `src/viewer/RealPtzSource.ts`: 구현.
  ```ts
  async centerOnPoint(_cam: number, p: {x:number;y:number}): Promise<Ptz> {
    await this.client.centerPtz({ type: 'point',
      pointX: Math.round(clamp01(p.x) * 1920), pointY: Math.round(clamp01(p.y) * 1080), speed: 50 });
    return this.currentPtz();   // setcenter 는 PTZ echo 가 없다 → 장비 조회로 확정
  }
  ```
  픽셀 기준값 1920×1080 은 상수 + 주석(스트림 해상도 상이 시 오차 가능 — 한계 명시).

### (d) `src/api/calibrateRoutes.ts` — `mode:'point'` 부활
- zod enum: `['point', 'plate', 'plate-zoom']`.
- 분기: `mode==='point'` → `calibrator.aimPointToCenter(cam, preset, point)`, 그 외는 **기존 `centerOnPoint` 경로 그대로**.
- 응답: `{ ok, ptz, plateWidth, ...(mode?), ...(reason?) }`. 409/400 매핑 불변.

### (e) `web/app.js` — 콤보 매핑 1줄
- `clickMode === 'center'` → `mode='point'`(기존 `'plate'`). `center-zoom` → `'plate-zoom'` 유지.
- 진행 메시지 문구: "클릭 지점을 화면 중앙으로 이동 중…".
- **주의**: `startCalFramePolling()`은 `/calibrate/frame`(잡이 캡처한 프레임) 폴링인데 point 경로는 캡처를 안 하므로 프레임이 갱신되지 않는다 → point 모드에서는 폴링을 **생략**하고 라이브 스트림 유지(정직하게 즉시 반영).
- `web/index.html` 옵션 라벨/타이틀 문구를 새 시맨틱으로 수정(`title` 속성 포함).

## 2. 테스트 계획 (qa-tester)
- `controlMath.aimPtzForPoint`: 중앙 클릭(0.5,0.5) → 델타 0 / 부호(우측 클릭 시 pan 방향) / zoom 불변 / maxStep 클램프 / zoom 2배 시 델타 절반.
- `PtzCalibrator.aimPointToCenter`: 저장 스파이 0회, LPD 0회, `camera.move` 1회·인자 검증, native 우선(스텁 주입 시 move 미호출), getPtz 실패 → 프리셋 폴백, 배치 running → throw, 중복 → busy throw.
- `calibrateRoutes`: `mode:'point'` → `aimPointToCenter` 호출·200 shape / `plate`·`plate-zoom` 회귀 / 400·409 매핑. **기존 "point → 400" 폐기 가드 테스트는 새 시맨틱으로 갱신**(삭제가 아니라 의미 반전 + 주석에 이력).
- `RealPtzSource.centerOnPoint`: HucomsClient 스텁으로 픽셀 변환(0.5,0.5 → 960,540)·type='point'·clamp 검증.

## 3. 영향도(사전)
- 기존 `centerOnPoint`(번호판 기준) 무접촉 → `plate`/`plate-zoom` 회귀 없음.
- `ICameraClient`/`CameraSource` 는 **옵셔널** 확장이라 기존 구현체(CameraClient/RpcCameraClient/SimulatorSource/RpcCameraSource/CameraposSource) 수정 불요.
- 저장·DB·파이프라인 자동연쇄 무접촉.
- `preAimPtz` 리팩터는 동작 동일(기존 preaim 테스트가 가드).
