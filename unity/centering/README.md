# @baro/centering

광각 PTZ CCTV 에서 **"화면을 클릭하면 그 지점이 정확히 가운데로 온다"** 를 만드는 라이브러리.
의존성 없음 · 순수 ESM · Node 18+ / 브라우저 공용.

```js
import { ClickCentering } from "./centering/index.mjs";

const centering = new ClickCentering({ camera: myAdapter, calibration: "cam-001" });
await centering.click({ x: 1440, y: 300 });   // 이 픽셀이 화면 중앙으로 온다
```

---

## 목차

- [무엇을 해결하나](#무엇을-해결하나)
- [가져다 쓰기](#가져다-쓰기)
- [카메라 어댑터](#카메라-어댑터-단-하나의-연결점)
- [API](#api)
- [캘리브레이션 절차](#캘리브레이션-절차)
- [브라우저에서 쓰기](#브라우저에서-쓰기)
- [자주 하는 실수](#자주-하는-실수)
- [예제](#예제)

---

## 무엇을 해결하나

### 이건 배럴 왜곡(곡면율) 보정이 **아니다**

광각 CCTV 에서 "클릭한 지점이 가운데로 안 온다"를 보면 렌즈 왜곡을 의심하게 되지만, 실측
105샘플로 확인한 원인은 다른 것이었다:

- 카메라 펌웨어의 `setcenter` 는 **이미 정확한 직선(tan) 기하 + 1/cos(tilt) 짐벌 커플링**을
  쓴다. 팬 스윕과 틸트 스윕으로 각각 역산한 초점거리가 **0.1% 이내로 일치**한다 — 선형 모델이면
  불가능하고, 커플링을 안 걸면 틸트 6°~33° 에서 20% 흔들려야 한다.
- 틀린 것은 기하가 아니라 **상수 하나**: 펌웨어가 믿는 초점거리 `f_fw` 가 실제 렌즈의 `f_true`
  와 어긋나고, 줌인할수록 벌어진다 (`f_fw/f_true` = 와이드 0.99 → z8000 이상 **약 1.11**).

초점거리 배율오차는 **편심에 비례하는** 오차로 나타난다. 그래서 증상이 "가운데는 멀쩡한데
가장자리로 갈수록 심하고, 와이드에서는 거의 안 보인다"인 것이다.

### 보정은 근사가 아니라 정확하다

펌웨어도 tan, 렌즈도 tan. 둘은 **초점거리 배율 하나만** 다르다. 그러므로:

```
atan(k·dx / f_fw)  ==  atan(dx / f_true)     ⟺     k = f_fw / f_true
```

클릭 좌표를 프레임 중심 기준으로 `k` 배 밀면 **모든 편심·모든 틸트에서** 오차가 상쇄된다.
위치별 오차 테이블도, 폐루프 재조준도, 추가 왕복도 필요 없다.

### 그래서 이 라이브러리가 들고 있는 표는 둘

| 표 | 뜻 | 축 |
|---|---|---|
| `zoomHfov` `{z, h}` | 이 렌즈가 줌 z 에서 **실제로 보는** 수평 화각 | **표시** — 오버레이·역투영·월드 투영 |
| `centeringGain` `{z, k}` | 클릭 편심에 미리 곱할 배율 | **조준** — 클릭 센터링 |

**두 표는 서로 다른 축이다. 바꿔 쓰면 화면 가장자리로 갈수록 어긋난다.**

---

## 가져다 쓰기

폴더째 복사한다. 빌드도, 설치도 필요 없다.

```bash
cp -r doc/centering  <내-프로젝트>/vendor/centering
```

```js
import {
  ClickCentering,      // 클릭 → 그 지점으로 (핵심)
  CameraCalibration,   // 두 곡선을 들고 있는 값 객체
  PtzGeometry,         // 픽셀 ↔ PTZ 기하
  WorldProjector,      // 월드 좌표 → 픽셀 (선택)
  FrameMatcher,        // "클릭한 게 어디 떨어졌나" 측정
  CalibrationSolver,   // 샘플 → 표
  CalibrationRunner,   // 스윕 자동화 (측정 전체)
} from "./vendor/centering/index.mjs";
```

npm 워크스페이스로 쓸 거면 `package.json` 이 이미 들어 있다 (`@baro/centering`).

---

## 카메라 어댑터 (단 하나의 연결점)

기종 의존성은 전부 여기 모여 있다. 이 인터페이스만 구현하면 어떤 카메라든 붙는다.

```js
const camera = {
  // 필수
  async getPtz()                 { return { panpos, tiltpos, zoompos }; }, // centidegree, 줌 스텝

  // 조준 — 둘 중 하나면 된다
  async setCenter({ x, y, speed })  { /* 이 픽셀을 가운데로 (mode "setcenter") */ },
  async goPtz({ panpos, tiltpos, zoompos, panspeed, tiltspeed, zoomspeed }) { /* 절대이동 (mode "absolute") */ },

  // 선택
  async setCenterBox({ startX, startY, endX, endY, speed }) { /* 박스줌 */ },
  async waitSettle({ before })   { /* 정착까지 대기 후 최종 PTZ 반환. 없으면 getPtz 한 번 */ },

  // 캘리브레이션을 직접 돌릴 때만 필요
  async snapshotGray()           { return { data, width, height }; },  // 8bit 그레이스케일
};
```

Hucoms 계열 CGI 카메라용 완성 어댑터는 [examples/hucoms-adapter.mjs](examples/hucoms-adapter.mjs)
에 있다. JPEG 디코딩은 **주입**한다(라이브러리를 의존성 없이 두기 위한 경계):

```js
decodeGray: async (jpeg) => {
  const { data, info } = await sharp(jpeg).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
```

---

## API

### `CameraCalibration`

이 렌즈의 두 곡선. 값 객체이므로 만들어서 돌려 쓰면 된다.

```js
// 만드는 네 가지 길
CameraCalibration.from("cam-001")                       // 내장 프리셋
CameraCalibration.from(deviceConfig.intrinsics)         // 실측 객체 { zoomHfov, centeringGain, ... }
CameraCalibration.from(null)                            // 캘리브레이션 없음 = 무보정 조준
new CameraCalibration({ zoomHfov, centeringGain })      // 직접
```

| 멤버 | 하는 일 |
|---|---|
| `hfovAt(zoom)` | 줌 → 수평 화각(도) |
| `vfovAt(zoom)` / `vfovFrom(hfov)` | 수직 화각. tan 관계이므로 비율이 일정하지 않다 |
| `focalAt(zoom)` | 줌 → 실제 초점거리(px) = `f_true` |
| `gainAt(zoom)` | 줌 → 보정 게인 `k` (곡선이 없으면 1) |
| **`aim({x, y, zoom})`** | **클릭 좌표 → setcenter 에 보낼 좌표.** `{ x, y, k, clamped }` |
| `aimBox({startX, startY, endX, endY, zoom})` | 박스의 **중심만** 보정해 통째로 평행이동 |
| `toJSON()` | config 저장용 모양. 그대로 `from()` 에 다시 넣을 수 있다 |
| `describe()` | 사람이 읽을 요약 한 줄 |
| `hasGain` | 게인 곡선이 있는가 = 보정을 하는가 |

새 기종을 재고 나면 프리셋으로 등록할 수 있다:
```js
CameraCalibration.register("cam-002", { label: "...", zoomHfov: [...], centeringGain: [...] });
```

### `ClickCentering`

클릭 한 번의 전체 파이프라인.

```js
const centering = new ClickCentering({
  camera,                    // 어댑터
  calibration: "cam-001",    // 프리셋명 | 실측객체 | CameraCalibration | null(무보정)
  mode: "setcenter",         // "setcenter" (기본) | "absolute"
  frameWidth: 1920,          // 카메라가 좌표를 받는 기준 프레임
  frameHeight: 1080,
  speed: 50,
});
```

| 멤버 | 하는 일 |
|---|---|
| `click({x, y, frameWidth?, frameHeight?, speed?, rawAim?})` | 그 지점을 중앙으로. `frameWidth/Height` 를 주면 임의 해상도 좌표를 자동 환산한다 |
| `clickBox({startX, startY, endX, endY, ...})` | 드래그한 네모로 센터링 + 줌인 |
| `preview({x, y, zoom})` | 카메라를 움직이지 않고 보정량만 계산 (UI 프리뷰·디버깅) |
| `normalize({x, y, frameWidth, frameHeight})` | 좌표만 기준 프레임으로 환산 |
| `ClickCentering.fromEvent(event, imgElement)` | 브라우저 클릭 이벤트 → 프레임 좌표 (정적 메서드) |

**두 가지 모드**

- `"setcenter"` (기본) — 카메라의 setcenter 에 **보정된 좌표**를 준다. 왕복 1회, 가장 빠르다.
- `"absolute"` — 목표 PTZ 를 직접 계산해 절대이동한다. `f_true` 로 각도를 풀기 때문에 게인도,
  프레임 가장자리 클램프도 필요 없다. **setcenter 가 없는 카메라**이거나, 가장자리 클릭까지
  완벽해야 할 때.

**`rawAim: true`** 는 보정을 우회한다. 캘리브레이션 측정 전용이다 — 재려는 대상을 보정 너머로
재면 안 되니까.

### `PtzGeometry` — 픽셀 ↔ PTZ

```js
const geo = new PtzGeometry({ calibration });

geo.pixelToDelta({ x, y, zoom, tiltCd })          // → { panDelta, tiltDelta } centidegree
geo.pixelToTarget({ x, y, ptz })                  // → { panpos, tiltpos } 절대 목표
geo.directionToPixel({ view, target })            // → { x, y, inFrame, behind } 역투영
geo.focal(zoom)                                   // → 초점거리(px)
```

`pixelToDelta` 는 **가로로만 클릭해도 `tiltDelta` 가 0 이 아니다.** 팬 축이 월드 수직축이라
광축이 기울어져 있으면 가로 이동에 틸트가 딸려 온다 — 실기가 정확히 그렇게 움직인다.

`directionToPixel` 은 근접 촬영해 둔 지점을 와이드 화면에 점으로 찍을 때 쓴다.

### `WorldProjector` — 월드 좌표 → 픽셀 (선택)

설치 측량값(마운트 위치 + `pan=0` 일 때의 방위)이 있을 때만 쓴다. 좌표계는 Unreal Engine
규약(좌수계, forward=+X, right=+Y, up=+Z).

```js
const projector = new WorldProjector({
  calibration,
  mount: { location: { x, y, z }, baseYaw },
});
projector.project({ point: { x, y, z }, ptz });   // → { x, y, depth, visible, behind }
projector.projectMany({ points, ptz });
```

### `FrameMatcher` — "클릭한 게 어디 떨어졌나"

캘리브레이션이 필요로 하는 단 하나의 측정. 카메라는 이걸 알려줄 수 없다.

```js
const matcher = new FrameMatcher({ /* frameWidth, half, search, step, pad, ... */ });
const m = matcher.locate(beforeGray, afterGray, { clickX, clickY });
// → { landedX, landedY, peak, margin, contrast, usable, reason }
```

신뢰도가 **세 숫자**로 나오는 것이 중요하다:

- `peak` — ZNCC 점수. 0.6 미만이면 붙잡을 게 없었다.
- `margin` — 1등 로브가 2등보다 얼마나 높은가. **점수보다 이게 중요하다.** 실측 사례: 피크
  0.898, 8px 옆 0.897 — OpenCV 와 이 매처가 서로 다른 로브를 골랐고 **둘 다 10px 틀렸다.**
  점수는 아무것도 말해주지 않았고 margin(0.0008 vs 정상 0.04+)이 전부를 말했다.
- `contrast` — 패치 RMS 대비. 실패 원인을 `"dark"`(낮에 다시 오라) / `"smooth"`(미세 디테일
  없음) / `"featureless"`(무늬 있는 쪽으로 돌려라) 로 가른다. 처방이 다르므로 구분해야 한다.

> **매칭 파라미터는 실제 이미지 픽셀 기준이다.** 1920×1080 스냅샷이면 기본값을 그대로 쓴다.
> 더 작게 렌더/캡처한다면 `half`/`search`/`pad` 를 같은 비율로 줄여야 한다.

### `CalibrationSolver` — 샘플 → 표

**독립된 세 경로**로 같은 답에 도달한다. 이 삼중화가 이 캘리브레이션을 믿을 수 있게 만든다.

```js
const solver = new CalibrationSolver();
solver.fitTrueFocal(samples)      // (a) 영상만: 착지 픽셀을 설명하는 단 하나의 f_true
solver.firmwareFocal(samples)     // (b) 텔레메트리만: 펌웨어가 믿는 f_fw (영상 불필요)
solver.undershootSlope(samples)   // (c) 모델 없음: 잔차/편심 기울기의 중앙값
solver.solveZoom(rows, { gainApplied })   // 한 줌의 { hfov, gain, residualPx, fitRmsPx }
solver.build(samples, { gainApplied, measuredAt })  // → { calibration, points, skipped }
```

- **화각**은 (a)에서: `hfov = 2·atan((W/2) / f_true)`
- **게인**은 (c)에서: `k = gainApplied / (1 - g)` — (a)/(b) 비율과 일치하지만 기울기가 열화에
  강하다(초점 피팅 하나가 실패해도 안 흔들린다)
- (b)의 팬/틸트 두 추정이 일치한다는 사실이 "펌웨어 기하는 정확하다"의 **증명**이다

### `CalibrationRunner` — 측정 전체 자동화

```js
const runner = new CalibrationRunner({
  camera,                       // getPtz / goPtz / setCenter / snapshotGray 필요
  calibration: installedCal,    // 검증 패스가 통과시킬 대상
  onProgress: ({ done, total, message, sample }) => { ... },
  grid: { zooms, dx, dy },      // 선택 — 기본은 14줌 × 8클릭 = 112샘플
});

const verified = await runner.verify();              // 짧은 격자 + 보정 켬 (~3분)
const measured = await runner.run({ mode: "full" }); // 전체 스윕 + 보정 끔 (~20분)
```

- 생성 패스는 `rawAim` 으로 돈다 — 이미 설치된 보정을 우회한다.
- 검증 패스는 보정을 **켜고** 돈다 — "이 보정이 이 개체에 맞나?"가 질문이므로.
- **끝나면 카메라를 찾았던 자리에 돌려놓는다** — 실패했을 때도, `AbortSignal` 로 취소됐을 때도.
- 검증 판정: `pass` (모두 측정 + 최악 잔차 ≤ 10px) / `fail` / `incomplete`(한 줌이라도 측정
  실패 — **합격이 아니다**).

### `Curve`

구간선형 + 양끝 **클램프**(외삽 금지). 두 표의 공통 자료구조.

```js
const c = new Curve([{ z: 0, h: 57.14 }, { z: 8000, h: 22.59 }], "h");
c.at(4000);      // 39.9 — 보간
c.at(99999);     // 22.59 — 클램프. 실제 렌즈가 포화하므로 외삽하면 거짓말이 된다
c.toJSON(2);     // 원래 모양으로
```

---

## 캘리브레이션 절차

### 1. 검증부터 (약 3분)

내장 프리셋이나 지금 걸린 표가 **이 개체에도** 맞는지 먼저 본다. 합격이면 끝이다.

```js
const v = await runner.verify();
// { verdict: "pass"|"fail"|"incomplete", worstPx, checks: [{zoom, residualPx, gainApplied, gainNeeded}] }
```

### 2. 불합격이면 전체 캘리브레이션 (약 20분)

```js
const r = await runner.run({ mode: "full" });
console.log(r.calibration.describe());
await saveToConfig(r.calibration.toJSON());   // devices.list[].intrinsics 같은 곳에
```

### 3. 저장 후 다시 검증

잔차가 실제로 줄었는지 확인한다. 이때가 **보정 후 남는 오차**를 말할 수 있는 유일한 시점이다.

### 돌리기 전 조건 — 권고가 아니라 측정 가능 조건

- **밝을 때.** 야간·저조도는 노이즈 리덕션이 화면을 뭉개서 **고배율부터 측정에 실패**한다
  (실측: 야간 z16384 에서 6샘플 중 2개는 너무 어둡고 3개는 상관면이 평평해 위치 특정 불가).
- **차량·주차선처럼 무늬가 있는 쪽**을 향한 상태로. 하늘·빈 아스팔트는 찾을 게 없다.
- 스윕 중에는 다른 이동 명령을 **차단**해야 한다. 도중의 수동 조작 하나가 샘플을 오염시키고,
  운영자는 그 이유를 영영 알 수 없다.

### 왜 개체마다 재야 하나

`k = f_펌웨어 / f_렌즈`. 분자는 펌웨어에 박힌 상수라 같은 모델·펌웨어면 동일하지만, **분모는
개체차를 탄다.** 개체차의 크기는 아직 미측정이다(실카메라 1대뿐). 그 개체의 오차가 프리셋의
절반보다 작으면 **보정이 오히려 오차를 키운다.** 그래서 프리셋은 자동 적용이 아니라 기기별
opt-in 이고, 검증이 먼저다.

**기하학적으로 정확한 카메라(시뮬레이터 등)에는 보정을 걸지 말 것** — 렌더와 같은 표로
조준하므로 이미 정확하다(k=1). 보정을 걸면 없던 오차가 생긴다.

---

## 브라우저에서 쓰기

빌드 없이 그대로 `<script type="module">` 에서 import 된다.

```html
<img id="view" src="/api/stream">
<script type="module">
import { ClickCentering } from "./centering/index.mjs";

const view = document.getElementById("view");
const centering = new ClickCentering({
  camera: {
    getPtz: () => fetch("/api/ptz").then((r) => r.json()),
    setCenter: (p) => fetch("/api/center", { method: "POST", body: JSON.stringify(p) }),
  },
  calibration: "cam-001",
});

view.addEventListener("click", async (e) => {
  // 표시 크기 → 원본 프레임 좌표 환산까지 해 준다
  const point = ClickCentering.fromEvent(e, view);
  await centering.click(point);
});
</script>
```

> 실제 배포에서는 **보정을 서버에서** 하는 편이 낫다(카메라 자격증명이 브라우저로 내려가지
> 않도록). 브라우저는 `preview()` 로 UI 표시만 하고, 실제 `click()` 은 서버가 돌린다.

---

## 자주 하는 실수

1. **조준 표와 표시 표를 바꿔 쓴다.** `centeringGain` 은 카메라에 명령할 때, `zoomHfov` 는
   화면에 그릴 때. 둘 다 tan 이지만 역할이 다르다.
2. **와이드 화각을 상수로 따로 적는다.** 표가 갱신돼도 그 상수는 안 바뀐다 — 실제로 옛 값
   하나가 측정보다 오래 살아남은 적이 있다. 항상 `calibration.hfovAt(0)` 를 읽어라.
3. **캘리브레이션 측정에 보정을 켜 둔다.** 재려는 대상을 보정 너머로 재게 된다. `rawAim` 필수.
4. **측정 못 한 줌을 합격으로 처리한다.** 한 프레임도 못 본 줌을 두고 "괜찮습니다"라고 말하는
   것이 이 기능이 낼 수 있는 최악의 결과다. `incomplete` 는 `pass` 가 아니다.
5. **표를 외삽한다.** 마지막 앵커 너머에서 실제 렌즈는 포화한다. `Curve` 가 클램프하는 이유다.
6. **매칭 파라미터를 논리 좌표로 준다.** `half`/`search`/`pad` 는 **실제 이미지 픽셀** 기준이다.
7. **박스줌에서 크기까지 보정한다.** 크기는 펌웨어가 목표 줌을 읽는 값이라 별개 문제다.
   중심만 보정하고 박스를 통째로 민다.

---

## 예제

```bash
node examples/01-click-to-center.mjs   # 보정 전/후 오차 비교 + 절대이동 모드
node examples/02-projection.mjs        # 화각 조회 · 클릭 보정 미리보기 · 역투영 · 월드 투영
node examples/03-calibrate.mjs         # 스윕 → 매칭 → 솔버 → 검증 → 저장 (전 과정)
```

셋 다 하드웨어 없이 [examples/mock-camera.mjs](examples/mock-camera.mjs) 로 돈다. 이 가짜
카메라는 실기의 병을 **일부러 주입**한다 — 렌더는 `f_true` 로, setcenter 는 `f_fw = f_true × k`
로. 예제 3 은 그 숨겨둔 정답을 캘리브레이션이 되찾아내는 것을 보여준다:

```
   zoom   화각(측정)  화각(정답)   게인(측정)  게인(정답)   보정 전 오차
      0      54.96°     55.00°       0.999      1.000         0.3px
   5129      32.00°     32.00°       1.080      1.080        35.7px
   8000      20.99°     21.00°       1.119      1.120        51.1px

검증 결과: pass  (최악 잔차 0.5px · 기준 10px)
```

실기 연결은 [examples/hucoms-adapter.mjs](examples/hucoms-adapter.mjs) 참고.

---

## 파일 구조

```
centering/
  index.mjs              공개 API
  src/
    curve.mjs            Curve            — 구간선형 + 클램프
    calibration.mjs      CameraCalibration — 두 곡선 + aim()
    geometry.mjs         PtzGeometry, WorldProjector — 픽셀 ↔ PTZ ↔ 월드
    centering.mjs        ClickCentering    — 클릭 파이프라인
    frame-match.mjs      FrameMatcher      — ZNCC 착지 측정 (의존성 없음)
    solver.mjs           CalibrationSolver — 샘플 → 표
    runner.mjs           CalibrationRunner — 스윕 자동화
  examples/
    01-click-to-center.mjs
    02-projection.mjs
    03-calibrate.mjs
    mock-camera.mjs      하드웨어 없이 돌리는 가짜 카메라
    hucoms-adapter.mjs   실기 어댑터 (Hucoms CGI)
```

## 출처

`baro_calory` 저장소의 운영 코드를 이식·정리한 것이다. 원본 구현과 측정 근거는
[click-centering-calibration.md](click-centering-calibration.md) 에 정리돼 있다
(어느 파일 몇 줄이 무엇을 하는지, 표가 어떻게 만들어졌는지).

원본은 그대로 두었다. 이 폴더는 **다른 프로젝트에 복사해 가기 위한 독립 사본**이며, 원본이
바뀌면 수동으로 맞춰야 한다.
