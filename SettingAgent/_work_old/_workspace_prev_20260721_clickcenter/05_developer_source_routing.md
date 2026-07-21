# 05. 구현 — /calibrate/point 소스 라우팅(뷰어가 보고 있는 카메라로 명령)

## 배경(리더 실측 진단)

- `/calibrate/*` 가 쓰는 카메라는 부팅 시 `cameraRuntime.selectedCameraId` 로 **고정된** `CameraSourceClient` 1개.
- 뷰어는 요청마다 `source=` 로 소스를 고르므로, 실카를 보며 클릭해도 명령은 시뮬로 갔다.
- 실기 휴컴스 `setcenter type=point` 자체는 정상.

## 변경 파일

| 파일 | 변경 |
|------|------|
| `src/api/calibrateRoutes.ts` | `PointBodySchema.source` 옵셔널 추가. `CalibrateRouteDeps.sources`/`cameraCfg`(둘 다 옵셔널). source 지정 시 요청마다 `CameraSourceClient` 조립 → calibrator opts 로 전달, 미해결이면 400 `{error:'source not found'}` |
| `src/api/server.ts` | `ApiDeps.cameraCfg`(=`ToolsConfig['camera']`) 추가. `registerCalibrateRoutes` 에 `sources`·`cameraCfg` 전달 |
| `src/index.ts` | `buildServer({ …, cameraCfg: tools.camera })` 주입(기존 `sources` 재사용) |
| `src/calibrate/PtzCalibrator.ts` | (B) `makePlatePtz(opts, camera?)` 확장 + `centerOnPoint`/`aimPointToCenter` opts 에 `camera?` / (C) `centerOnPoint` 기준 PTZ 를 `currentPtzFor`(현재 PTZ 우선) 로 전환 / `currentPtzFor`·`startPtzFor` 오버라이드 수용 |
| `web/app.js` | `calPointCenter` body 에 `source: state.source \|\| undefined` 동봉 |
| `test/calibratePointSource.test.ts` (신규) | 라우트 source 위임/400/미지정 3케이스 |
| `test/ptzCalibrator.point.test.ts` | `centerOnPoint` 가 `getPtz` 를 기준으로 삼는 케이스 1건 추가 |

## 구현 노트

1. **가산·상태 없음**: source 지정 요청마다 얇은 `CameraSourceClient` 를 새로 만들고 그 호출에만 쓴다.
   미지정이면 기존 파이프라인 카메라 그대로(회귀 0). `sources`/`cameraCfg` 미주입(헤드리스)이면 source 를 보내도
   `source not found` 400 — 조용한 시뮬 폴백을 만들지 않는다(정직).
2. **배치 무접촉**: `start()/run()/calibrateSlot` 경로는 한 줄도 바뀌지 않았다. 프리셋 정본·`ptzByKey` 캐시 그대로.
3. **(C) 개별 경로 기준 PTZ**: 실카(`RealPtzSource`)는 프리셋 PTZ 테이블이 없어 `startPtzFor` 가 `{0,0,1}` 폴백으로
   떨어진다 → `centerOnPoint` 도 `aimPointToCenter` 와 동일하게 `currentPtzFor`(getPtz 우선, 실패 시 프리셋 폴백 + warn)를
   쓴다. 기존 목 카메라(getPtz 없음)는 폴백 경로로 내려가 프리셋 PTZ 를 그대로 받으므로 기존 테스트 의미 불변.
4. **`makePlatePtz` 호환**: 2번째 인자는 옵셔널 — 기존 목 팩토리(1인자)는 그대로 통과한다(실측 확인).

## 설계와 다르게 간 부분(1건, 근거 있음)

- `startPtzFor(t, override?)` 에서 **오버라이드가 있으면 `ptzByKey` 캐시를 쓰지도 채우지도 않게** 했다.
  캐시 키가 `cam:preset` 뿐이라 소스가 다르면 서로 다른 PTZ 테이블이 한 캐시에 섞여 오염되기 때문이다.
  (설계 문구에는 없었으나 오버라이드 도입이 직접 만드는 결함이라 같은 변경 안에서 막았다.)

## 실측 검증

```
> npx tsc --noEmit
(출력 없음 — 0 에러)

> npx vitest run
 Test Files  183 passed (183)
      Tests  2140 passed (2140)
   Duration  12.68s
```

기준선 182파일/2136테스트 → 183파일/2140테스트(신규 파일 1 + 신규 테스트 4). 기존 테스트 수리 0건.
커밋하지 않았다(작업트리 상태 유지 — 리더 라이브 검증 대기).
