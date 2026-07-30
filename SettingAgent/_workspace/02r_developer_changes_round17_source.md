# 17회차 구현 — 검출 소스 불일치 수정 (배선과 정직성)

> Goal: **뷰어에서 보고 있는 그 카메라의 그 프레임으로 검출하고, 제원이 없어 검출할 수 없는 소스는
> 조용히 틀린 답을 내지 말고 명시적으로 거부한다.**
> 이 라운드는 검출 알고리즘을 **1줄도 바꾸지 않았다**(`src/ground/*` 무접촉).

## 1. 변경 파일

| 파일 | 변경 |
|---|---|
| `src/rpc/services/roiAuto.ts` | P0·P1 전부. `source`/`cameraSpec` 스키마, `FrameSource` 해석, `IntrinsicsResolver`(실카 거부), `usedSource` 응답 |
| `src/rpc/types.ts` | `RpcDeps.selectedCameraId?` 추가(소스 미지정 호출도 "어느 카메라였나"를 말하게) |
| `src/api/server.ts` | `ServerDeps.selectedCameraId?` 추가 + `registerRpcRoutes` 로 전달 |
| `src/index.ts` | `selectedCameraId: selectedEntry?.[0]` 배선 1줄 |
| `web/index.html` | 「도색선 자동검출」 패널에 **카메라 제원 입력 3종**(설치고·틸트·수평화각) |
| `web/app.js` | 검출 시 `state.source` 전송, 대상 표기에 소스 포함, `usedSource` 표시, 소스 불일치 경고, 거부 사유 표시 |
| `test/roiAutoSource.test.ts` | **신규** 10 테스트(ⓐ~ⓔ + 시뮬 회귀) |

**손대지 않은 것**: `src/ground/*`(검출 알고리즘), `config/*.json`, 정본 `data/Place01/PtzCamRoi.json`, DB,
`roi.auto.apply` 의 source 배선, `expectedBays`.

## 2. P0 — `source` 배선

- `roi.auto.detect` / `roi.auto.score` 스키마에 `source?: string` 추가(`SourceFields` 를 **merge**).
  `RoiAutoApplySchema` 는 `BaseSchema` 그대로라 apply 에는 `source` 가 **생기지 않는다**(마스터 제약).
- 지정 시 `ctx.deps.sources.get(source)` → `CameraSourceClient` (기존 `plate.pickAt` 와 동일 규약).
  없는 id → `RpcCode.INVALID_PARAMS(-32602)` + `{source, known:[...]}`.
- **미지정이면 종전 경로 그대로** `ctx.deps.camera`. 라이브 대조로 비트 동일 확인(§5).
- 모든 응답에 `usedSource: { id, kind, requested }`. `requested` 를 같이 실어 뷰어가 불일치를 스스로 경고한다.
- `roi.show2d{visible:false}`(D-5)는 **실카에서는 호출하지 않는다**(`kind !== 'hucoms'` 게이트).
  초록 주차면 박스는 시뮬만 렌더하므로 실카에는 의미가 없다.
- **실카에는 PTZ 명령을 보내지 않는다**: `requestImage` 에 ptz 를 넘기지 않아 `snapshot(mode:'preset')` =
  현재 위치 캡처만. 다시점 합의(디더 6시점)도 실카에서는 자동으로 단일 시점으로 내린다(`consensusFor`).

## 3. P1 — 소스별 제원 해석 + 명시적 거부

`IntrinsicsResolver` 를 도입해 **제원 해석 시점을 프레임 취득 뒤로** 옮겼다(실카 화각은 그 프레임의
네이티브 줌으로 실측표를 조회해야 하므로).

- **실카가 아닌 전부**(`sim`·`rpc`·미상) → 종전 그대로 `placeMetaProvider(readPlaceMeta(json))`.
  ※ 시뮬 계열이 `sim`(SimulatorSource)과 `rpc`(CameraposSource/RpcCameraSource)로 갈리므로
  `kind === 'sim'` 이 아니라 `kind !== 'hucoms'` 로 판정한다.
- **실카(`hucoms`)** → 필요 3종을 각각 확인하고 **하나라도 없으면 검출을 수행하지 않는다**:
  - 수평화각: `cameraSpec.hfovDeg` ?? `lens_calibration.json` 의 `zoomHfov` 보간(줌 원시값은
    소스 자신의 `toNativePtz` 로 되돌려 얻는다 — 단위 가정 없음)
  - 하향 틸트: `cameraSpec.tiltDeg` **만**. 자동 유도 금지(§4)
  - 설치고: `cameraSpec.heightM` **만**. 실측값 없음
- 거부 응답: `{ rejected:true, graded:false, gradeReason:'INTRINSICS_MISSING', missing:[...], note, presets:[], summary:null }`.
  `D*` 네임스페이스를 쓰지 않는다(D12 는 `src/ground` 에서 이미 사용 중이고, 이건 **검출을 시작조차 안 한** 사유다).
- `roi.auto.apply` 도 **같은 해석기**를 쓴다(source 파라미터는 없음). 기본 카메라가 실카인 배포에서
  시뮬 제원으로 정본을 덮어쓰는 일을 구조적으로 막는다 → `CONFLICT` + 정본 무변경.

## 4. ★ RealPtzSource tilt 선형매핑 조사 결론 — **가정이다(실각도 아님)**

`src/viewer/RealPtzSource.ts:412-413` 의 `mapRange(tilt, [-90,90] ↔ [-2000,9000])` 는
**슬라이더 범위 맞춤(range-fit)이지 각도 변환이 아니다.**

근거:
1. 네이티브 단위는 **centi-degree** 로 문서 2곳이 일치한다.
   - `docs/20260721_150000_광각보정율_조사와_실측기각.md:16` — 사양서 §8.1(p.54) 인용 `tiltpos -2000~9000`
   - `docs/20260725_002405_광각렌즈_곡면율_캘리브레이션_설계.md:29` — "pan/tilt 네이티브 | **centidegree** | panRange 0~35999, tiltRange −2000~9000 | 동일"
   - `src/clients/hucoms/HucomsClient.ts:645` 가 같은 범위로 클램프
2. pan 이 결정적 방증이다: `0~35999` = 0.00~359.99° → 같은 단위족이면 tilt `-2000~9000` = **−20.00°~+90.00°**.
3. 그렇다면 뷰어 매핑은 **틀렸다**: 선형 range-fit 은 네이티브 0(수평)을 뷰어 **−57.27°** 로 보낸다
   (`(0−(−2000))/11000×180−90`). 실제 −20°~+90° 구간을 −90°~+90° 에 억지로 늘린 것이다.
   pan 은 0~359.99 → −180~180 이 단순 원점 이동이라 우연히 정합하지만, tilt 는 그렇지 않다.

**그래서 어떻게 했나**: 네이티브 `tiltpos/100` 을 각도로 **쓰지 않았다**. 사양·문서 근거는 있으나
ParkAgent 안에 "tiltpos X ↔ 실제 각도 Y" 를 대조한 **실측 기록이 0건**이기 때문이다.
3회차에 초점거리 오차가 IoU 를 0 으로 만든 전례가 있어, 추측 각도로 지면을 세우지 않는다.
→ 실카 tilt 는 **미검증**으로 표시하고 P1 거부 사유에 그대로 싣는다. 필요하면 마스터가 패널에 직접 입력한다.

## 5. 검증 실측

1. `npx tsc --noEmit` → **exit 0**
2. `npx vitest run` → **284파일 3610테스트 전량 green**(기준선 283/3600 + 신규 1파일 10테스트)
3. 유닛 ⓐ~ⓔ 전부 `test/roiAutoSource.test.ts` 에 있음. ⓓ 는 **카메라 호출 0회**까지 단언한다(실카 무접촉).
4. 라이브(13020, 서버 재시작 없이 nodemon 자동 반영):
   - `source:"real-camera-2"` → **거부 응답**(원문은 최종 보고에). 카메라 캡처·이동 **0회**.
   - `source:"simulator-1"` vs **소스 미지정** → `frameHash 2fecd51b1e5f` 동일, `focalPx 2932.79189` 동일,
     `quads 7`·`q0` 좌표 동일, issues 동일 → **회귀 없음**. `usedSource.requested` 만 `"simulator-1"` vs `null`.
   - 13021(격리 서버)은 `roi.auto.*` 자체가 없는 별도 빌드라 대상 아님.
5. `curl /viewer/index.html` → `ap-height`·`ap-tilt`·`ap-hfov` 신규 엘리먼트 확인.

## 6. 미검증 (은닉 금지)

- **실카 실검출 0건.** `real-camera-2` 는 제원이 없어 거부까지만 확인했고, 제원을 채운 실카 검출은 해보지 않았다.
- **실카 tilt 미검증**(§4). `real-camera-1` 의 `zoomHfov` 보간 경로도 **실호출 미검증**(tilt·설치고가 없어 거부에 걸린다).
- `toNativePtz` 왕복으로 얻는 줌 원시값은 논리상 정확하나(같은 소스의 역함수) **실장비 대조 0건**.
- **육안 확인은 마스터 몫** — 뷰어에서 `real-camera-2` 선택 후 「검출」을 눌러 거부 사유가 화면에 뜨는지,
  `simulator-1` 에서 종전과 같은 시안색 사각형이 나오는지는 **마스터 확인 대기**다.
