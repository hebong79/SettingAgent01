# 01_architect_plan — 이터레이션 1(신규 goal): LPD 1회 미검으로 인한 `plate_lost` 조기사망 제거

작성: 2026-07-22 · 설계자(architect) · B 모드(goal/loop) 이터레이션 1
대상 goal: `_workspace/00_goal.md` · 직전 계약: `docs/20260721_191430_클릭센터줌_상한확정_진동제거_정렬무회귀.md`(수정 17~21)
변경 예정 소스: `src/calibrate/platePtz.ts` · `src/calibrate/PtzCalibrator.ts` · `src/config/toolsConfig.ts`(옵셔널 키 2개)

---

## 0. 한 줄 요약

`centerOnPlate`(및 `zoomToPlateWidth`)의 추적 캡처가 **1회 미검으로 즉시 `plate_lost`** 를 내는 지점에,
**미세 tilt 디더(±0.03°)로 프레이밍을 바꿔 재캡처하는 유한 재시도**를 넣는다.
재시도는 **동일한 `matchRadiusNorm` 게이트**를 그대로 통과해야만 채택되며(거짓 성공 금지선 불변),
**기본값은 재시도 0회 = 기존 동작**이고 **개별(클릭) 경로에서만 주입**한다(배치 회귀 구조적 0).

---

## 1. 문제의 코드 지점(리더 확정 사실을 코드로 고정)

| 지점 | 코드 | 현 동작 |
|---|---|---|
| A | `platePtz.ts:424-427` `centerOnPlate` 추적 루프 | `captureAndDetect` 1회 null → **즉시 `plate_lost` 반환** ← **이번 goal 의 실패 지점(R1)** |
| B | `platePtz.ts:503-506` `zoomToPlateWidth` 가드 재중심 캡처 | 동일 패턴 → 즉시 `plate_lost` |
| C | `platePtz.ts:526-529` `zoomToPlateWidth` 줌 후 캡처 | 동일 패턴 → 즉시 `plate_lost` |
| D | `platePtz.ts:827-835` 사다리 latch 후 미검 | 즉시 종료(+`restoreBest`) |
| E | `platePtz.ts:1130-1131` `probeGain` | **치명 아님** — 미검 시 fallback 게인으로 계속 |

`captureDetectPick`(`:1157`)이 반환하는 실패는 두 종류다.
- `plate===null, rejected=false, count=0` — LPD 가 아무것도 내지 않음
- `plate===null, rejected=true, count>0, nearestDist>radius` — 후보는 있으나 전부 게이트 밖

goal 의 재현 사례(`picked=null dist=0.126 count=4`)는 **후자**다. 이 구분이 §3.1 발동 조건의 근거가 된다.

---

## 2. 설계 결정 요약(결론 먼저)

| 항목 | 결정 | 근거 |
|---|---|---|
| 발동 조건 | **검출 0(`count=0`)과 반경 기각(`rejected`) 둘 다** | §3.1 |
| 디더 축·크기 | **tilt 만 ±`ditherDeg`(기본 0.03°)**, 순서 `[+d, −d]` | §3.2 |
| 재시도 횟수 | 기본 **2회**(클릭 경로 주입값). 라이브러리 기본값은 **0** | §3.2·§6 |
| prior 보정 | **디더분을 포함해 `predictPlateCenter` 로 재계산**(무시하지 않는다) | §3.3 |
| 게이트 | **불변** — 재시도도 동일 `radius` 인자로 `captureDetectPick` 호출 | §4 |
| 성공 시 PTZ | **디더된 PTZ 를 그대로 상태로 채택**(원복 금지) | §5 |
| 적용 범위 | A(필수) · B/C(동반) · **D 미적용** · **E 무변경** | §7 |
| 기본값 | `plateRecaptureRetries` 기본 **0 = 기존 동작**. 클릭 경로에서만 2 주입 | §6 |
| 금지 | `maxStepDeg` 축소 등 우회 **채택 안 함**(R4) | — |

---

## 3. 재포착(recapture-with-dither) 계약

### 3.1 발동 조건 — 검출 0 **과** 반경 기각 **둘 다**

근거(둘 다여야 하는 이유):

1. **실측이 반경 기각 쪽이다.** goal 재현 로그는 `count=4`(후보 있음) + `dist 0.126 > 0.08` 기각이다.
   `count===0` 에만 걸면 **이번 goal 의 실패를 하나도 못 고친다.**
2. **두 실패는 같은 사건의 두 얼굴이다.** 원인은 "LPD 가 그 프레임에서 **대상 판을 내지 않았다**"이고,
   화면에 이웃 판이 있으면 `pickNearestPlate` 가 이웃을 골라 `rejected`, 없으면 `count=0` 이 될 뿐이다.
   프레임 하나의 우연(어떤 이웃이 그 프레임에서 검출됐는가)으로 회복 기회를 가르는 것은 근거가 없다.
3. **추적 루프에서의 `rejected` 는 "클릭이 틀렸다"는 뜻이 아니다.** 신원은 이미 첫 캡처에서 확립됐고,
   여기 반경은 추적용 `matchRadiusNorm` 이다. "클릭이 틀렸다"를 뜻하는 `initialRadiusNorm` 기각은
   §3.5 대로 **디더 대상이 아니다**.

### 3.2 디더 크기·부호·횟수

- **축: tilt 단독.** 리더 실측이 전부 세로 방향이다(tilt 10.367→10.4 = 1.7px, 동일 이미지 1/2/3px **세로** 시프트 → 5/7/7개).
  pan 을 함께 흔들 근거가 없고, 축을 늘리면 재시도 수만 늘어난다(규칙 2 — 최소).
- **크기: 기본 0.03°.** 리더 실측에서 검출 결과를 바꾼 최소 관측 변위(0.033° ≈ 1.7px)와 같은 자릿수다.
  현재 프레이밍에서의 화면 변위는 `dTilt / gainTilt_eff`(`predictPlateCenter` 모델)이며
  `gainTilt_eff = 35.5/zoom` 이므로 **변위 = 0.03 × zoom / 35.5**:

  | zoom | 화면 변위(정규화) | ≈px(1080 기준) |
  |---|---|---|
  | 1.693(클릭 base) | 0.0014 | 1.5 |
  | 13~16(개별 성공 슬롯의 줌 구간) | 0.011~0.014 | 12~15 |
  | 36(장비 상한) | 0.030 | 33 |

  → 어느 zoom 에서도 **재프레이밍은 확실히 발생**하고, 동시에 `matchRadiusNorm`(0.08)의 **최대 38%**라
  게이트를 무의미하게 만들지 않는다(§4).
- **부호·순서: `[+d, −d]`.** 대칭이라 두 번 다 실패해도 순 이동은 0 에 가깝고(−0.03° 잔차),
  한 방향으로만 누적해 대상을 밀어내지 않는다.
- **횟수: 2(클릭 주입값).** 리더 실측(1px/2px/3px → 5/7/7)에서 **한 번의 재프레이밍이면 결과가 바뀐다**.
  3회 이상은 왕복 비용만 늘리고 근거가 없다. `plate_lost` 는 **`1 + retries` 회 연속 미검**에서만 확정한다.

### 3.3 각 재시도의 prior 와 게이트

재시도는 **prior 를 다시 계산한다**. 기존 코드가 이미 쓰는 식과 **동일 식**이므로 근사가 아니라 정확하다:

```
prior_i = predictPlateCenter(obsCenter, { dPan: cmd_i.pan - obsPtz.pan,
                                          dTilt: cmd_i.tilt - obsPtz.tilt }, gain)
```
`cmd_i` 가 디더된 명령이므로 디더분이 자동으로 반영된다. **추가 비용 0.**

"무시해도 되는가"에 대한 수치 판단(요청 항목):
- base zoom(1.693)에서 미보정 오차는 **0.0014** = `matchRadiusNorm` 의 **1.8%** → 무시 가능.
- 그러나 zoom 36 에서는 **0.030** = 게이트의 **38%** → **무시 불가**. 이웃 판까지 여유가 그만큼 깎인다.
- 보정 비용이 0 이고 고zoom 에서 실제로 유의하므로 **항상 보정**한다(경로별 분기 없음 = 단순).

**게이트는 `radius` 인자를 그대로 재사용**한다. 첫 캡처가 `matchRadiusNorm` 이면 재시도도 `matchRadiusNorm` 이다.
완화·해제·`null` 전달은 **금지**(§4).

### 3.4 `plate_lost` 확정 시점

`1(원 캡처) + retries(디더 캡처)` 가 **전부** 실패했을 때만. 이때 반환하는 `ptz` 는
**마지막으로 명령한(=카메라가 실제로 있는) 디더 PTZ** 다(정직성 — §5 와 같은 원칙).
결과에 `recaptureDithers`(시도 횟수)를 남겨 "몇 번 흔들어도 안 나왔다"가 로그·응답에서 보이게 한다.

### 3.5 디더하지 **않는** 곳: 최초 대상 선정(`centerOnPlate` 첫 캡처, `:376`)

- 그 캡처의 게이트 기준점은 **조작자의 클릭 좌표**(원 프레임 기준)다. 카메라를 흔들면 클릭 좌표가
  가리키던 세계점이 프레임에서 이동하므로, 게이트 기준을 함께 보정해야 하고 그 순간
  "클릭 반경 0.10"의 의미가 흐려진다. 신원 확립 전이라 보정을 검증할 관측 앵커도 없다.
- 그 실패는 `no_plate` / `no_plate_near_click` 으로 **사유가 분리돼 있고**, 조작자가 다시 클릭할 수 있다.
- goal 의 실패는 전부 `plate_lost`(추적 중)이라 범위 밖이다.
→ **이번 이터레이션 미적용. 한계로 명시**(라이브에서 첫 캡처 미검이 관측되면 다음 루프에서 별도 설계).

---

## 4. 거짓 성공 금지선 불변 증명(코드 경로 논증)

채택은 오직 `captureDetectPick` 내부의 한 줄이 결정한다(`platePtz.ts:1186`):

```ts
if (radius !== null && dist > radius) return { plate: null, rejected: true, ... };
```

1. **게이트 값 불변**: 재시도는 헬퍼가 받은 **같은 `radius` 변수**를 그대로 넘긴다.
   설계상 헬퍼 시그니처에 radius 는 **1개**뿐이라 "재시도용 완화 반경"이라는 개념 자체가 존재할 수 없다.
2. **기준점(prior) 불변성**: 재시도 prior 는 원 prior 를 디더분(≤0.030, base 에서 0.0014)만큼 옮긴 값이다.
   이웃 판 최소 간격은 원 프레임 0.15 이고 zoom 확대 시 관측 간격은 0.15·k 로 **더 벌어진다**.
   최악(base zoom, 디더가 이웃 쪽으로 향함): 이웃까지 거리 ≥ 0.15 − 0.0014 = **0.1486 > 0.08** → 기각.
   zoom 36 최악: 관측 간격 0.15·k ≫ 0.03 이므로 여유는 오히려 커진다.
   ⇒ **디더가 이웃을 게이트 안으로 끌어들일 수 있는 수치 구간이 존재하지 않는다.**
3. **선정 규칙 불변**: `pickNearestPlate` / `pickOwnedByOffsets` 는 손대지 않는다.
4. **성공 판정 불변**: `isCentered` / `isWidthConverged` / latch 규칙 무변경. 디더는
   "어느 프레임을 보는가"만 바꾸고 "무엇을 성공이라 부르는가"는 건드리지 않는다.
5. **대상이 진짜 없으면 여전히 실패**: 모든 재시도가 게이트를 못 넘으면 `plate_lost` 확정(§3.4).
   테스트로 고정한다(§9 T3).

---

## 5. 디더된 PTZ 의 처리 — **채택**(원복 금지)

**결정: 재포착 성공 시 그 디더된 PTZ 를 그대로 루프 상태(`ptz`, `obsPtz`)로 채택한다.**

근거:
1. **이 파일의 제1 불변식**은 "상태 = 내가 명령한 값"이고, `obsPtz` 의 정의는
   **`obsCenter` 를 관측한 그 프레임의 명령 PTZ** 다. 관측은 디더된 프레임에서 나왔으므로
   `obsPtz` 를 디더 전 값으로 두면 다음 prior 가 `dTilt` 만큼 **체계적으로 틀린다**
   (zoom 36 에서 0.03 = 게이트의 38%. 무시할 수 없다 — §3.3 표).
2. **원복은 왕복을 1회 더 쓴다.** 원복 후의 프레임에서 대상이 또 안 나올 수 있고(원복 위치가 바로
   미검이 났던 그 프레임이다!) 그러면 회복이 원점으로 돌아간다 — **원복은 이 버그를 되살린다.**
3. 물리적 대가는 `centerTol`(0.03) 대비 base zoom 에서 **1/21**(0.0014) 수준이고, 루프가
   다음 반복에서 실측 오차로 자동 흡수한다. 최종 성공 판정은 **그 자리에서 실측한 err** 로만 내리므로
   디더로 인한 위치 오차가 성공 판정에 숨어들 경로가 없다.

---

## 6. 옵션화와 기본값(기존 2260 테스트 무회귀)

### 6.1 신규 옵션(`PlatePtzOpts`)

```ts
/**
 * (재포착) 추적 캡처가 미검일 때 프레이밍을 바꾸기 위해 tilt 에 가하는 미세각(°). 기본 0.03.
 * LPD 는 같은 PTZ 프레임에 대해 결정적이라 같은 자리 재캡처는 무의미하다(리더 실측).
 */
plateRecaptureDitherDeg?: number;   // 기본 0.03
/**
 * (재포착) 디더 재캡처 최대 횟수. ★ 기본 0 = 재포착 없음 = **기존 동작**.
 * 0 이 기본인 이유는 §6.2(무회귀·배치 보호).
 */
plateRecaptureRetries?: number;     // 기본 0
```

`ResolvedOpts` 에는 숫자로 확정(`?? 0.03`, `?? 0`) — `initialRadiusNorm` 처럼 undefined 에 의미를 주는
관용구가 필요 없다(0 이 곧 "없음"이다).

### 6.2 기본 0 을 택한 이유(요청 항목 — 명시적 논증)

- **구조적 무회귀**: `retries=0` 이면 헬퍼의 재시도 루프가 0바퀴 → 호출 횟수·반환 PTZ·reason 이
  현재 코드와 **바이트 단위로 동일**하다. 2260건 중 어떤 것이 캡처 횟수나 실패 시 PTZ 를 단언하든 영향 0.
- **배치 회귀 금지(R5)를 근거가 아니라 구조로 보장**: 배치는 `baseOpts()` 만 쓰고 새 키를 주입하지 않으므로
  코드가 배치에 도달하지 않는다. "무해할 것이다"라는 논증에 기대지 않는다.
- **스텁 카메라 무해성 확인(요청 항목)**: 대부분의 테스트 스텁은 `plate = f(ptz)` 형태라 디더해도 같은 판을
  내므로 켜도 무해하지만, **`plate_lost` 를 재현하는 픽스처**(무조건 null / 이웃만 반환)에서는
  ① 캡처 호출 횟수가 3배가 되고 ② 실패 시 반환 `ptz.tilt` 가 −0.03 달라진다.
  즉 "켜도 무해"는 **거짓**이다 → 기본 0 이 옳다.
- 클릭 경로는 §6.3 에서 명시적으로 켠다. 즉 **주입 없으면 기존 동작, 주입하면 새 동작.**

### 6.3 주입 지점(개별 클릭 경로 한정)

`PtzCalibrator.centerOnPoint`(`:218~227`)의 **두 `makePlatePtz` 호출에만** 추가한다
(`baseOpts()` 에 넣지 않는다 — 그러면 배치가 함께 켜진다):

```ts
// centerOnPlate 용
{ ...this.baseOpts(), plateRoi: prior, initialRadiusNorm: this.pointRadius(), ...this.recaptureOpts() }
// zoomToPlateWidth 용
{ ...this.baseOpts(), plateRoi: ..., gain: centered.gain, ...this.recaptureOpts() }
```

```ts
/** (개별 클릭 전용) LPD 프레이밍 불안정 회복. 배치에는 주입하지 않는다(§회귀 안전성). */
private recaptureOpts(): PlatePtzOpts {
  return {
    plateRecaptureDitherDeg: this.cfg.pointRecaptureDitherDeg ?? POINT_RECAPTURE_DITHER_DEFAULT, // 0.03
    plateRecaptureRetries:   this.cfg.pointRecaptureRetries   ?? POINT_RECAPTURE_RETRIES_DEFAULT, // 2
  };
}
```

`src/config/toolsConfig.ts` `CalibrateSchema` 에 옵셔널 키 2개 추가(`pointMatchRadiusNorm` 과 동일 관용구):
```ts
pointRecaptureDitherDeg: z.number().min(0).max(1).optional(),
pointRecaptureRetries:   z.number().int().min(0).max(5).optional(),
```
`config/tools.config.json` 은 **건드리지 않는다**(기본값으로 동작 — 튜닝이 필요할 때만 추가).

---

## 7. 적용 범위(요청 항목)

| 경로 | 적용 | 근거 |
|---|---|---|
| **A** `centerOnPlate` 추적 루프(`:424`) | **적용(1순위)** | goal 의 실패 지점 그 자체(R1) |
| **B/C** `zoomToPlateWidth`(`:503`,`:526`) | **적용** | 완전히 동일한 실패 패턴이고, 클릭 경로는 A 성공 직후 B/C 로 이어진다. A 만 고치면 같은 원인이 한 칸 뒤에서 재발한다(slot1~3 이 zoom 단계까지 진입하는 것이 이번 수정의 결과다) |
| **D** `centerAndZoomByLadder` latch 후 미검(`:827`) | **이번 이터레이션 미적용** | ① 사다리는 rung 마다 zoom 이 달라 **다음 프레임이 이미 재프레이밍**된다(디더의 목적이 부분적으로 내장) ② 실카 전용 경로라 이번 루프(시뮬)에서 **검증할 수단이 없다** ③ 실카 미검증 변경을 얹는 것은 R6(은닉 금지)·규칙 2(최소)에 어긋난다. **한계로 명시**하고, 실카에서 latch 후 `plate_lost` 가 관측되면 같은 헬퍼를 그 지점에 1줄로 붙이는 것을 다음 루프 후보로 남긴다 |
| **E** `probeGain`(`:1130`) | **무변경** | 미검이 **치명이 아니다** — fallback 게인으로 진행한다. 게다가 cam1 의 fallback(−62/−35.5@z1)은 실측 참값이라 손실이 사실상 0. 치명적이지 않은 곳에 왕복을 추가할 근거가 없다(규칙 2) |
| 배치 `calibrateSlot` | **무변경·무주입** | R5. §6.2·§6.3 대로 코드가 도달하지 않는다 |

---

## 8. 구현 계획(파일·함수·시그니처·의사코드)

### 8.1 `platePtz.ts` — 신규 private 헬퍼 1개

```ts
/**
 * (재포착) 추적 캡처 1회 + 미검 시 미세 tilt 디더 재캡처. **게이트는 절대 완화하지 않는다.**
 * prior 는 매 시도 cmd 기준으로 재계산하므로 디더분이 정확히 반영된다.
 * @returns plate 성공 시 그 판과 **그때 명령한 PTZ**(디더 포함 — 호출측이 상태로 채택).
 *          실패 시 plate=null, ptz=마지막으로 명령한 PTZ(카메라 실제 위치 — 지어내지 않는다).
 */
private async captureTrack(
  camIdx: number, presetIdx: number, cmd: Ptz,
  obsCenter: Center, obsPtz: Ptz,
  gain: { gainPan: number; gainTilt: number },
  radius: number | null,
): Promise<{ plate: PlateBox | null; ptz: Ptz; dithers: number }> {
  const o = this.opts;
  const deltas = [0, ...ditherSeq(o.plateRecaptureRetries, o.plateRecaptureDitherDeg)]; // [0, +d, -d, +2d, ...]
  let last: Ptz = cmd;
  for (let i = 0; i < deltas.length; i++) {
    const p: Ptz = { pan: cmd.pan, tilt: cmd.tilt + deltas[i], zoom: cmd.zoom };
    const prior = predictPlateCenter(obsCenter,
      { dPan: p.pan - obsPtz.pan, dTilt: p.tilt - obsPtz.tilt }, gain);   // ★ 디더분 포함 정확 보정
    const got = await this.captureDetectPick(camIdx, presetIdx, p, priorRect(prior), radius); // ★ radius 그대로
    last = p;
    if (got.plate) {
      if (i > 0) logger.info({ cat:'centering', phase:'recapture', cam:camIdx, preset:presetIdx,
        dither: r3(deltas[i]), attempt: i, nearestDist: got.nearestDist===null?null:r3(got.nearestDist),
        radius }, '미세 디더 재캡처로 대상 재포착');
      return { plate: got.plate, ptz: p, dithers: i };
    }
    if (i < deltas.length - 1) logger.info({ cat:'centering', phase:'recapture', cam:camIdx, preset:presetIdx,
      attempt: i, plates: got.count, rejected: got.rejected,
      nearestDist: got.nearestDist===null?null:r3(got.nearestDist), radius, nextDither: r3(deltas[i+1]) },
      '추적 캡처 미검 → 미세 디더 재캡처 시도');   // ★ 발동은 count=0·rejected 양쪽 모두(§3.1)
  }
  return { plate: null, ptz: last, dithers: deltas.length - 1 };
}
```
`ditherSeq(n, d)` = `[+d, −d, +2d, −2d, ...]` 를 n 개(모듈 로컬 순수 함수, `n=0 → []`).
발동 조건이 "`got.plate` 가 null 인 모든 경우"이므로 `count=0` 과 `rejected` 를 **함께** 덮는다(§3.1).

### 8.2 호출측 치환(3곳, 동작 동형)

- A `centerOnPlate:422-427`
  ```ts
  const tr = await this.captureTrack(camIdx, presetIdx, cmd, obsCenter, obsPtz, gain, o.matchRadiusNorm);
  ptz = tr.ptz;                       // ★ 디더 채택(§5). 기존 `ptz = cmd` 를 대체
  if (!tr.plate) return { ok:false, ptz, ..., reason:'plate_lost',
                          ...(tr.dithers>0 ? { recaptureDithers: tr.dithers } : {}) };
  plate = tr.plate;
  ```
  (기존 `const prior = predictPlateCenter(...)` 줄은 헬퍼로 이관되어 삭제 — 고아 코드 정리 범위)
- B `zoomToPlateWidth:501-506` — 동일 치환(gain 은 `effGain`).
- C `zoomToPlateWidth:524-529` — 줌 후 캡처는 prior 가 `predictCenterAfterZoom` 이라 모델이 다르다.
  **여기만 별도 처리**: 줌 명령 자체는 디더하지 않고, 미검 시 tilt 디더 재캡처를 하되 prior 는
  `predictPlateCenter(predictCenterAfterZoom(obsCenter, zFrom, zTo), {dPan:0, dTilt:delta}, effGain)`
  로 합성한다(두 모델의 순차 합성 — 각 단계가 이미 검증된 식이다).
  구현상 헬퍼를 `obsCenter` 대신 **"줌 후 예측 중심"을 앵커로, `obsPtz`=줌 후 ptz** 로 넘기면 같은 함수로 처리된다.

### 8.3 결과 필드(옵셔널·하위호환)

```ts
/** (재포착) 대상을 다시 잡기까지 사용한 미세 디더 재캡처 횟수(0 이면 필드 자체를 싣지 않는다). */
recaptureDithers?: number;
```
성공·실패 양쪽에 실을 수 있다(정직성 관용구 — `widthShortfall`/`centerShortfall` 과 동형).
`PtzCalibrator.centerOnPoint` 의 반환 shape(`{ok, ptz, plateWidth, reason?}`)은 **무변경** — REST 계약 불변.

### 8.4 변경 파일 목록(문서화·구현자 인계)

| 파일 | 변경 |
|---|---|
| `src/calibrate/platePtz.ts` | `PlatePtzOpts` 2키 · `ResolvedOpts` 2키 · `PlatePtzResult.recaptureDithers` · private `captureTrack` · 모듈 로컬 `ditherSeq` · 호출측 3곳 치환 |
| `src/calibrate/PtzCalibrator.ts` | 상수 2개 + private `recaptureOpts()` + `centerOnPoint` 의 makePlatePtz 2곳에 스프레드 |
| `src/config/toolsConfig.ts` | `CalibrateSchema` 옵셔널 키 2개 |
| `config/tools.config.json` | **무변경** |
| `web/app.js` · 라우트 · `@parkagent/types` | **무변경**(응답 shape 불변) |

---

## 9. 유닛테스트로 고정할 케이스(파일: `test/platePtz.test.ts` 신규 섹션 + `test/ptzCalibrator.point.test.ts`)

스텁 설계: **캡처 횟수·PTZ 를 기록**하고 `tilt` 값에 따라 판을 내거나 안 내는 카메라/LPD
(= 리더가 실측한 "프레임 내 결정적, 프레이밍 바뀌면 결과 바뀜"을 그대로 모사).

| # | 케이스 | 검증(성공 기준) |
|---|---|---|
| **T1** | 회복(검출 0) — 원 tilt 에서 `count=0`, `tilt+0.03` 에서 대상 검출 | `ok:true`, `recaptureDithers:1`, 최종 `ptz.tilt` 가 **디더된 값**(§5 채택), 캡처 호출 2회 |
| **T2** | 회복(반경 기각) — 원 tilt 에서 **이웃만** 검출(dist 0.126), 디더 후 대상 검출 → **goal 재현 케이스** | `ok:true`, `recaptureDithers:1`, 채택된 판이 **대상 판**(이웃 아님) |
| **T3** | ★금지선 — 대상이 **정말 없다**(모든 tilt 에서 이웃만) | `ok:false`, `reason:'plate_lost'`, `recaptureDithers:2`, **이웃을 채택하지 않았음**(반환 plate 가 직전 대상 판이며 이웃 id 가 아님) |
| **T4** | ★이웃 갈아타기 차단 — 디더 후 프레임에 이웃(원 프레임 0.15 간격)만 등장 | `plate_lost`. 게이트 통과 후보 0 |
| **T5** | prior 보정 — 고zoom(36) 프레임에서 디더 시도의 prior 가 `predictPlateCenter` 로 0.030 이동했음을 스텁이 받은 prior 로 단언 | prior 보정 부재 시 실패하는 단언(보정 회귀 감지) |
| **T6** | ★무회귀(기본값) — 옵션 미주입 | 미검 1회 → **즉시 `plate_lost`**, 캡처 호출 **정확히 1회**, 반환 `ptz` = 원 명령값 |
| **T7** | ★배치 무회귀 — `calibrateSlot` 경로에서 미검 픽스처 | 캡처 횟수·결과가 **수정 전과 동일**(옵션 미도달 확인) |
| **T8** | 주입 경로 — `PtzCalibrator.centerOnPoint` | `makePlatePtz` 스텁이 받은 opts 에 `plateRecaptureRetries:2`·`ditherDeg:0.03` 이 있고, **배치 호출의 opts 에는 없음** |
| **T9** | `zoomToPlateWidth` 회복(B/C 각각) | 가드 재중심 미검·줌 후 미검 각각에서 회복 → `ok:true`, 폭 수렴 |
| **T10** | 사다리 무회귀 | `centerAndZoomByLadder` 의 캡처 횟수·결과 무변경(§7 D 미적용 고정) |

라이브 성공 기준(리더 실측, goal §Loop 2): 슬롯 1~7 전부 `ok:true` + `plateWidth 0.20±0.02`.

---

## 10. 왕복 비용(요청 항목)

1 왕복 = `requestImage` + `settleMs`(300ms) + `lpd.detect` ≈ **0.6s**.

| 시나리오 | 추가 왕복 | 추가 시간 |
|---|---|---|
| 미검이 없는 정상 진행(대부분) | **0** | 0 |
| 반복 1회에서 1차 디더로 회복 | +1 | +0.6s |
| 반복 1회에서 2차 디더로 회복 | +2 | +1.2s |
| **진짜 미검(실패 확정)** | +2 | +1.2s 후 `plate_lost` |
| 이론적 최악(`centerOnPlate` 15반복 × 매번 2회 디더) | **+30** | **+18s** |
| 클릭 1회 전체 최악(center 15 + zoom 15) | +60 | +36s |

이론적 최악은 "매 반복 첫 캡처가 미검이고 매번 디더로 회복"이라는 조합이며, 관측된 실패율
(슬롯 7개 중 3개에서 각 1회)과는 거리가 멀다. **실측 기대값은 클릭당 +0~1.2s.**
최악을 더 조이려면 "호출당 총 디더 예산" 상수를 두면 되지만, `maxIterations` 가 이미 상한을 주므로
새 임계값을 추가하지 않는다(규칙 2). 라이브에서 총 시간이 문제로 관측되면 그때 도입한다.

---

## 11. 리스크·트레이드오프

| # | 리스크 | 평가·완화 |
|---|---|---|
| R-1 | 디더가 **회복하지 못하는** LPD 실패(가림·각도·오염 등 프레이밍과 무관한 원인) | 이 설계는 그런 경우 **정직하게 `plate_lost`**. 로그의 `recaptureDithers`·`plates`·`nearestDist` 로 "흔들어도 안 나옴"이 구분된다. goal 은 시뮬 1~7 실측으로 판정한다 |
| R-2 | 0.03° 가 특정 장비·zoom 에서 **재프레이밍에 부족**(픽셀 이동 < 1px) | §3.2 표대로 base zoom 에서도 1.5px. 부족하면 `pointRecaptureDitherDeg` 로 튜닝 가능(코드 변경 불요) |
| R-3 | 디더로 카메라가 실제로 0.03° 어긋난 채 종료 | `centerTol` 의 1/21(base). 성공 판정은 **디더된 그 자리에서 실측한 err** 로만 내리므로 판정에 숨어들지 않는다 |
| R-4 | 실패 시 반환 `ptz` 가 −0.03° 달라져 기존 테스트가 깨질 가능성 | 기본 `retries=0` 이라 **기존 테스트 경로에는 디더가 존재하지 않는다**(§6.2). 클릭 경로 신규 테스트에서만 단언 |
| R-5 | `zoomToPlateWidth` 고zoom 구간(z36)의 디더 변위 0.030 이 게이트(0.08)의 38% | prior 보정으로 상쇄되고(§3.3), 이웃까지의 관측 간격은 0.15·k 로 훨씬 크다(§4-2). 안전 여유 유지 |
| R-6 | 사다리(실카) 미적용 → 실카에서 같은 증상이 남을 수 있음 | **한계로 명시**(R6). 실카 로그에 latch 후 `plate_lost` 가 나오면 같은 헬퍼를 1줄로 적용하는 후속 루프 |
| R-7 | 왕복 증가로 클릭 체감 지연 | §10 — 기대값 +0~1.2s, 최악 +36s(비현실적 조합). 라이브에서 채록 |

**핵심 트레이드오프**: "1회 미검 = 사망"이라는 **빠르지만 부서지기 쉬운** 계약을,
"연속 3회(원+디더2) 미검 = 사망"이라는 **최대 +1.2s 느리지만 견고한** 계약으로 바꾼다.
거짓 성공 금지선은 게이트가 그대로이므로 **한 치도 넓히지 않는다**(§4).

---

## 12. 가정·미해결(은닉 금지)

1. **가정**: LPD 의 프레이밍 민감도가 tilt 방향 미세 이동으로 충분히 흔들린다 — 리더 실측(1/2/3px 세로 시프트 → 5/7/7)에 근거하나, **디더 후 실제로 대상이 검출되는지는 라이브 실측으로만 확정된다**(goal Loop 2).
2. **미검증**: 실카(`real-camera-*`)·사다리 경로. §7 D 대로 이번 범위 밖.
3. **미적용**: 최초 대상 선정(첫 캡처)의 디더(§3.5). 라이브에서 첫 캡처 미검이 관측되면 재설계 필요.
4. **질문(리더 판단 요청, 진행은 막지 않음)**: 재시도 기본 2 로 goal 이 달성되지 않으면 3~4 로 올릴지,
   아니면 디더 축을 pan 까지 확장할지 — **라이브 1차 실측 결과를 보고 결정**하는 것을 권한다(추측 금지).
