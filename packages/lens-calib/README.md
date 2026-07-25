# @parkagent/lens-calib

광각 PTZ(Hucoms) CCTV 에서 **"화면을 클릭하면 그 지점이 정확히 가운데로 온다"** 를 만드는
독립 컴포넌트. 외부 의존 **0** · 순수 TypeScript(ESM) · Node/브라우저 공용.

```ts
import { ClickCentering } from '@parkagent/lens-calib';

const cc = new ClickCentering({ camera: myAdapter, calibration: 'cam-001' });
await cc.click({ x: 1760, y: 150 });   // 이 픽셀이 화면 중앙으로 온다
```

이 패키지는 `unity/centering`(실기 Hucoms 검증 운영코드)의 **화각·게인 두 표를 TS 로 이식**하고,
그것이 미모델링으로 남긴 **곡면율(방사왜곡) 축을 세 번째 표로 추가**한 것이다.

---

## 무엇을 해결하나 — 표 세 개

광각 CCTV 에서 "클릭한 지점이 가운데로 안 온다"의 원인은 **하나가 아니라 셋**이고, 서로 다른 축이다.

| 표 | 뜻 | 편심 의존성 | 축 |
|---|---|---|---|
| `zoomHfov` `{z, h}` | 이 렌즈가 줌 z 에서 실제로 보는 수평 화각 | — | **표시** |
| `centeringGain` `{z, k}` | 펌웨어가 믿는 초점거리 오차 `f_fw/f_true` | **1승**(선형) | **조준** |
| `lensDistortion` `{z, k1, k2}` | 렌즈 방사왜곡(곡면율) | **3승**부터 | **조준·표시** |

- **게인**은 편심에 비례하는 오차만 만든다("가장자리로 갈수록 비례해서 덜 온다").
- **곡면율**은 편심의 세제곱부터 시작한다("가장자리에서만, 그것도 급격히"). 게인으로는 원리적으로 못 잡는다.

> 실기 105샘플이 확인한 것: Hucoms 펌웨어의 `setcenter` 는 이미 **정확한 tan 기하 + 1/cos(tilt)
> 짐벌 커플링**을 쓴다(팬·틸트 독립 역산 0.1% 일치). 틀린 것은 기하가 아니라 **상수**(초점거리)와,
> 넓은 렌즈에서 **가장자리의 곡면율**이다. 그래서 왜곡계수 테이블이 아니라 **줌별 스칼라들**을 잰다.

### 조준은 3단이고, 순서가 중요하다

```
클릭(실제 이미지 픽셀) → undistort(곡면율) → ×k(게인) → clamp → setcenter
```

펌웨어는 왜곡을 **모르고** 받은 좌표를 핀홀로 해석한다. 먼저 펴서 진짜 광선 각도를 얻고, 그 다음
펌웨어의 초점 배율오차를 상쇄해야 한다. **`k1=k2=0` 이면 undistort 가 항등이라 참조본 식과 완전히
동일**해진다 — 곡면율 표가 없으면 기존 동작과 비트 단위로 같다.

---

## 진입점 세 개 — 따로 쓸 수 있다

### ① 표만 (카메라 불필요)

```ts
import { CameraCalibration } from '@parkagent/lens-calib';

const cal = CameraCalibration.from('cam-001');        // 프리셋 | 실측객체 | null(무보정)
cal.hfovAt(zoomPos);                                   // 표시용 화각(도)
cal.aim({ x: 1760, y: 150, zoom: zoomPos });          // → { x, y, k, undistortScale, clamped }
```

### ② 조준 (어댑터 하나)

```ts
import { ClickCentering } from '@parkagent/lens-calib';

const cc = new ClickCentering({ camera, calibration: 'cam-001' });
await cc.click({ x: 1760, y: 150 });
```

### ③ 측정

```ts
import { CalibrationRunner } from '@parkagent/lens-calib';

const runner = new CalibrationRunner({ camera, calibration: 'cam-001', onProgress });
const v = await runner.verify();                       // 3분  — 프리셋이 이 개체에 맞나
const m = await runner.run({ mode: 'full' });          // 20분 — 화각·게인 (클릭 스윕)
const d = await runner.runDistortion();                // ★     — 곡면율 (회전 광류 격자)
const ab = runner.verifyDistortion(d.samples, d.points); // 곡면율 A/B 자가 판정
```

②만 쓰는 소비자는 ③(측정·매칭) 코드를 로드하지 않는다.

---

## 카메라 어댑터 (단 하나의 연결점)

기종·프로젝트 의존성은 전부 여기 모인다. 단위는 **Hucoms 네이티브**(픽셀 0~1920/0~1080 ·
centidegree · zoompos 레지스터).

```ts
const camera: HucomsCameraPort = {
  getPtz: () => /* { panpos, tiltpos, zoompos } */,
  setCenter: ({ x, y, speed }) => /* ptz_centering setcenter type=point */,   // ②에 필요
  goPtz: ({ panpos, tiltpos, zoompos, speed }) => /* goptzfpos 절대이동 */,     // ③·absolute 에 필요
  waitSettle: () => /* 정착 후 최종 PTZ */,                                     // 선택(없으면 getPtz)
  snapshotGray: () => /* { data, width, height } 그레이스케일 */,               // ③에만 필요
};
```

JPEG 디코딩은 **주입**한다 — 이 패키지는 디코더를 모른다. `snapshotGray` 안에서
`sharp(jpeg).greyscale().raw()...` 같은 것을 쓰면 된다.

---

## 곡면율 측정은 왜 "회전 광류"인가

화각·게인은 **클릭 스윕**(편심 클릭 → 착지 잔차)으로 잰다 — 실기 검증된 방식이라 그대로 이식했다.
그러나 곡면율만은 다르다:

- 클릭 스윕의 착지는 **언제나 화면 중앙 근처**인데, 왜곡은 **가장자리에서만** 크다.
  즉 클릭 스윕은 왜곡이 가장 잘 보이는 곳을 관측에서 빼고 있다.
- 대신 **한 번 회전시키고 프레임 전체 격자(5×3)를 추적**하면 회전 1회에 대응점 15개가 나오고,
  **코너까지** 관측에 들어온다. 줌마다 4방향(±pan, ±tilt) 회전한다.

LPD(번호판) 기반은 쓰지 않는다 — 판 위치를 못 고르고(코너 커버리지 불가), LPD 중심의 스케일
의존 편향이 왜곡 신호와 구별되지 않아 표에 그대로 흡수되기 때문이다.

---

## 절차

1. **검증부터 (3분).** 내장 프리셋이 이 개체에도 맞는지 본다. 합격이면 끝.
2. 불합격이면 **전체 캘리브레이션 (20분)** → 저장 → 재검증.
3. **곡면율**이 필요하면(넓은 렌즈·엄격한 요구) `runDistortion()` → `verifyDistortion()` A/B →
   `recommendation === 'adopt'` 일 때만 켠다.

측정 가능 조건(권고가 아님): **밝을 때** · 차량·주차선처럼 **무늬 있는 쪽** · 스윕 중 다른 이동 차단.
실패·취소해도 카메라는 **항상 원 PTZ 로 복귀**한다.

### 왜 개체마다 재야 하나

`k = f_펌웨어 / f_렌즈`. 분자는 펌웨어 상수(동일 모델 공통)지만 **분모는 개체차를 탄다.** 그 개체의
오차가 프리셋의 절반보다 작으면 보정이 오히려 오차를 키운다. 그래서 프리셋은 자동 적용이 아니라
**기기별 opt-in** 이고, 검증이 먼저다. 기하가 정확한 카메라(시뮬레이터)에는 걸지 말 것 — 이미 정확하다.

---

## A/B 가 스스로 기각을 말한다

`verifyDistortion` 은 같은 대응점을 곡면율 **켜고/끄고** 각각 예측해 잔차를 비교한다. 세 조건을
**모두** 만족해야 `recommendation: 'adopt'`:

1. 측정 실패 줌이 없다 (`incomplete` 은 `pass` 가 아니다)
2. 보정 후 잔차가 허용치 이하
3. **어느 줌에서도 ON 이 OFF 보다 나쁘지 않다**

셋 중 하나라도 어기면 `reject` 를 스스로 선언한다. 이것은 과거에 사람이 손으로 A/B 를 재서
tan 보정을 기각했던 실험의 자동화판이다.

---

## 파일 구조

```
lens-calib/
  src/
    types.ts        Ptz · Point · GrayFrame · HucomsCameraPort · 표 스키마
    curve.ts        ZoomCurve         — 구간선형 + 양끝 클램프(외삽 금지)
    presets.ts      PRESETS['cam-001']— 참조본 실측표 이식(황금값)
    distortion.ts   LensDistortion    — ★곡면율 축. distort/undistort
    calibration.ts  CameraCalibration — 세 표 + aim() 3단
    geometry.ts     PtzGeometry       — 픽셀↔PTZ, 역투영
    centering.ts    ClickCentering    — 클릭 파이프라인(setcenter/absolute)
    frameMatch.ts   FrameMatcher      — ZNCC 추적(순수). 탐색중심 파라미터화
    optimize.ts     goldenSection · nelderMead
    solver.ts       CalibrationSolver — 샘플 → 세 표
    runner.ts       CalibrationRunner — run() 클릭스윕 · runDistortion() 광류격자
    zoomMap.ts      ZoomMap           — zoompos ↔ 배율(화각표에서 유도)
    verify.ts       A/B 판정 · explain()
  mock/mockCamera.ts  정답 주입 가짜 Hucoms 카메라(하드웨어 불요)
  examples/01-distortion.ts
  test/               vitest — 파일별 1:1
```

## 자주 하는 실수

1. **조준 표와 표시 표를 바꿔 쓴다.** `centeringGain` 은 명령할 때, `zoomHfov` 는 그릴 때.
2. **곡면율 방향을 헷갈린다.** 조준은 `undistort`(실제→이상), 표시는 `distort`(이상→실제).
3. **캘리브레이션 측정에 보정을 켜 둔다.** `rawAim` 필수 — 재려는 대상을 보정 너머로 재면 안 된다.
4. **측정 못 한 줌을 합격으로 처리한다.** `incomplete` 는 `pass` 가 아니다.
5. **표를 외삽한다.** 마지막 앵커 너머에서 실제 렌즈는 포화한다. `ZoomCurve` 가 클램프하는 이유다.
6. **매칭 파라미터를 논리 좌표로 준다.** `half`/`search`/`pad` 는 **실제 이미지 픽셀** 기준이다.

## 예제

```bash
npx tsx examples/01-distortion.ts   # 정답 주입 → 곡면율 복원 → A/B → 조준 개선 (하드웨어 불요)
```

## 출처

`unity/centering`(= `baro_calory` 저장소 운영 코드) 를 TS 로 이식·확장했다. 원본 구현과 측정
근거는 `unity/centering/click-centering-calibration.md` 에 있다. 원본은 대조용으로 보존한다.
