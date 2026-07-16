# 검증 보고: 번호판 센터링·줌 독립 모듈 (PlatePtz) — 마감 검증

작성: 2026-07-16 / 검증자(qa-tester)
브랜치: `feat/plate-ptz` (워크트리 `D:\Work\Parking3D\AgentVLA\ParkAgent-plate-ptz\SettingAgent`)
입력: `_workspace/plate-ptz/01_architect_plan.md`(r2) · `_workspace/plate-ptz/02_developer_changes.md`(r0/r1/r2) · `src/calibrate/platePtz.ts` · `src/calibrate/controlMath.ts` · `test/platePtz.test.ts` · `_workspace/plate-ptz/_live/*.mts`

> 이 파일은 이전 세션(VPD 육면체 과제)의 검증 보고서를 대체한다 — 본 워크트리 세션의 검증 기록.

## 판정 요약

**게이트 3종 재실행 전량 통과. Requirements ①②③ 전 항목 충족. 라이브 실측(리더 수행)을 뒤집을 근거 없음.**
단, **결함 2건(D-1 문서 · D-2 계약 노출)** 과 **리스크 6건**을 아래에 명시한다. 통과 위장 없음.

| 구분 | 결과 |
|---|---|
| 게이트(typecheck / platePtz 유닛 / 전량) | ✅ 3/3 (실제 출력 §1) |
| Requirements ①②③ | ✅ 충족 (근거 §2) |
| 확정 설계 결정 준수 | ✅ 13/13 (§2.2) |
| 경계면 교차 비교 | ✅ 불일치 0건 (§3) |
| 변경 범위(메인 리포 무접촉 · append-only) | ✅ 사실 확인 (§4) |
| 유닛 보강 | **1건 추가**(케이스 21 — §6). 나머지 추가 불요 |
| **발견 결함** | **D-1**(controlMath 주석에 부호가 반대인 폐기 실측값) · **D-2**(줌 단독 경로의 fallback 노출이 설계 전제와 불일치) |

---

## 1. 게이트 3종 — 직접 재실행 결과 (실제 출력)

작업 디렉터리: `D:\Work\Parking3D\AgentVLA\ParkAgent-plate-ptz\SettingAgent`

### ① `npm run typecheck`
```
> parkagent-setting@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit
```
→ 진단 출력 없음, exit 0. **구현자 보고와 일치.**

### ② `npx vitest run test/platePtz.test.ts`
```
 ✓ test/platePtz.test.ts (25 tests) 12ms

 Test Files  1 passed (1)
      Tests  25 passed (25)
   Duration  507ms
```
→ **25 passed — 구현자 보고와 일치(재현됨).**

**검증자 케이스 21 추가 후 재실행:**
```
 ✓ test/platePtz.test.ts (26 tests) 11ms

 Test Files  1 passed (1)
      Tests  26 passed (26)
   Duration  568ms
```

### ③ `npm test` (전량)
```
 Test Files  151 passed (151)
      Tests  1666 passed (1666)
```
→ **1666 passed, 회귀 0 — 구현자 보고와 일치.**

**케이스 21 추가 후 재실행:**
```
 Test Files  151 passed (151)
      Tests  1667 passed (1667)
```
→ 1666 → **1667**(+1 = 케이스 21). **회귀 0 유지.** `controlMath` 기존 테스트 무수정 green.

> 구현자 보고 §R2-5 의 수치는 전부 재현되었다. 위장·과장 없음.

---

## 2. Requirements 체크리스트 — 항목별 대조

### 2.1 마스터 원문 요구 ①②③

| # | 요구 | 판정 | 근거 |
|---|---|---|---|
| ① | 카메라가 LPD 번호판 OBB **중심점으로 이동**(pan/tilt) | **충족** | `centerOnPlate`(platePtz.ts:179~242). pan/tilt 만 명령하고 `zoom: startPtz.zoom` 을 매 반복 재구성(213행) — **구조적으로 zoom 변경 불가**. 유닛 1(명령 전량 `zoom===startPtz.zoom` 검증)·13. **라이브: errX=−0.0016 errY=−0.0022 (≤0.03) PASS** |
| ② | **zoom** 으로 OBB 가로가 **화면 가로 ~20%** | **충족** | `zoomToPlateWidth`. 목표 `targetPlateWidth 0.20 ± widthTol 0.02`(150~151행). "가로"=`quadBoundingRect(quad).w`(270·293·316행). 유닛 6·15·18·**21(검증자 추가 — 기울어진 OBB 로 정의 구분 검증)**. **라이브: 단독 width=0.1829 / 체이닝 0.1849 (0.18~0.22) PASS. 목시 화면 가로 ≈1/5** |
| ③-a | **하나의 모듈/클래스**로 관리 | **충족** | 단일 파일 `src/calibrate/platePtz.ts`, 단일 클래스 `PlatePtz`, 공개 메서드 정확히 2개. 신규 파일 2개(src 1 + test 1)뿐 |
| ③-b | 2개 작업 **완전 분리** | **충족** | 두 메서드 **상호 비호출**(코드 확인: `centerOnPlate` 안에 `zoomToPlateWidth` 호출 없음, 역도 없음). 유닛 10 이 각각 단독 green 확인 |
| ③-c | 각각 **단독 사용 편의** | **충족(단 D-2 참조)** | 무상태·생성자 주입·`Repository`/잡 상태머신/LLM 비의존. 인자 3개(`camIdx, presetIdx, startPtz`). **라이브 A(센터링 단독)·C(줌 단독, base 에서) 둘 다 PASS**. ⚠ **줌 단독 경로의 게인은 무측정 fallback 에 100% 의존 — D-2** |

**요구 ② 관련 — 검증자 추가 검증(케이스 21)의 의미**: 기존 픽스처의 번호판은 **전부 축정렬**(`rectToQuad`)이라, 설계 §4 의 정의 결정("화면 가로"=축정렬 boundingRect 폭 **vs** OBB 장변)이 모듈을 통해 **한 번도 구분된 적이 없었다**(축정렬에서는 두 정의의 수치가 같다). 실제 번호판은 기울어져 있고 두 정의는 cosθ 만큼 갈린다 — 어느 쪽으로 수렴하는지가 **요구 ②의 의미 그 자체**다. 12° 기울어진 OBB 를 통과시켜 **보고 폭이 `quadBoundingRect(quad).w` 와 12자리 일치**하고, OBB 장변과는 **실제로 다르며**(정의 구분이 유의미), 그 차가 **3.5% 이내**(설계 §4 ④ 주장)임을 확인 → **green**. 설계 §4 의 정의가 코드에 실제로 구현되어 있음이 이제 증명된다.

### 2.2 확정 설계 결정 준수

| 결정 | 판정 | 근거(코드 확인) |
|---|---|---|
| 폐루프(probe 게인 실측) | **준수** | `probeGain`(337~356행) → `estimateGain`. 오픈루프 1샷 없음 |
| `detectMath`·`fovBaseV` 미사용 | **준수** | platePtz.ts import 목록에 없음(15~33행). `fovBaseV` 문자열 부재 |
| "가로 크기"=`quadBoundingRect(quad).w` | **준수** | 270·293·316행. **케이스 21 이 기울어진 OBB 로 정의를 구분 검증** |
| 목표 0.20±0.02 | **준수** | 150~151행 기본값. `isWidthConverged` 사용 |
| `ICameraClient`·`LpdClient` 생성자 주입 | **준수** | `PlatePtzDeps`(37~41행), 145~146행 |
| `requestImage` 만 사용(`move()` 금지) | **준수** | 369행이 유일한 카메라 I/O. `move(` 호출 부재 |
| **PTZ 에코 불신·명령값 추적** | **준수** | 응답(`cap`)에서 `jpg` **만** 취하고 pan/tilt/zoom 을 읽지 않는다(369~371행). 상태는 명령값(`ptz = cmd`)으로만 갱신. 모킹이 echo 0/0/1 을 반환해 가정을 재현 |
| 두 메서드 **상호 비호출** | **준수** | 코드·유닛 10 |
| controlMath **순수 함수 추가만**·기존 무변경 | **준수** | `git diff --numstat main` = **46 삽입 / 0 삭제**, 단일 말미 훅(`@@ -103,3 +103,49 @@`) — §4.2 |
| `PtzCalibrator`·`geometry`·`detectMath`·라우트·config 스키마 **무접촉** | **준수** | 워킹 diff 에 부재 — §4.1 |
| 과설계 없음 | **준수** | platePtz.ts 385행. 메서드별 `over?` 오버라이드 미도입, 라우트/MCP 노출 없음, LLM 자문 없음, aliasing 추가 장치 없음(설계 §2.7 ④) |
| damp 상한 3회 | **준수** | `DAMP_LIMIT=3`(115행), 유닛 14 |
| 가드 선행 + 줌 스텝비 클램프 | **준수** | 283~299행(가드 후 `continue`), 303행 대칭 클램프. 유닛 15·18 |

---

## 3. 경계면 교차 비교

### 3.1 `PlatePtz` ↔ `controlMath` 신규 순수 함수 3종 — 계약(단위·부호·zoomRef 의미) 일치

| 항목 | controlMath(제공) | platePtz(소비) | 판정 |
|---|---|---|---|
| `scaleGainForZoom(gain, zoom)` | `gain.zoomRef / zoom` 배 → `{gainPan, gainTilt}` (**zoomRef 미반환**) | 183행 `{...scale(fbBase, startPtz.zoom), zoomRef: startPtz.zoom}` / 280행 매 반복 스케일 | ✅ zoomRef 를 호출측이 명시 재부착 — 누락 없음 |
| **zoomRef 의미** | "게인 측정 시점 zoom" | fallback=`zoomRef 1`(182·264행), probe 실측=`zoomRef fb.zoomRef`=`startPtz.zoom`(183·355행), 결과 gain=`startPtz.zoom` | ✅ 일관. **유닛 1·4·13 이 `r.gain.zoomRef` 를 명시 검증** |
| `predictPlateCenter` 단위 | `c + dDeg/gain` — **입력 °, 게인 °/정규화, 출력 정규화** | 215·286·349행 모두 `{dPan, dTilt}` 를 **도(°) 차이**로 전달 | ✅ 단위 일치 |
| **부호** | 게인 음수 → `dPan>0` 이면 `cx` **감소** | fallback −62/−35.5(155~156행)·probe 실측 부호 그대로 사용(부호 보정·`Math.abs` 없음) | ✅ 물리(pan↑ → 화면 좌측 이동) 일치. 유닛 19·20 |
| `predictCenterAfterZoom` | 화면중심 기준 방사 `0.5+(c−0.5)·zTo/zFrom` | 309행 `(obsCenter, ptz.zoom, newZoom)` — **인자 순서 (from, to)** | ✅ 순서 정확(`ptz.zoom`=현재=from, `newZoom`=to). 유닛 19 |
| ε 방어 | `GAIN_EPS=1e-4`, 미달 시 직전값 유지 | 방어 결과를 그대로 수용(발산 없음) | ✅ |
| 타입 | **구조적 인라인**(`{gainPan,gainTilt,zoomRef}`) | `PtzGain` 인터페이스를 platePtz 가 소유·export | ✅ 구조적 호환 — **순환 import 없음**(controlMath→platePtz 역방향 부재 확인) |

### 3.2 `PlatePtz` ↔ `RpcCameraClient.requestImage` / `LpdClient.detect` — 데이터 shape·좌표계

| 항목 | 계약 | platePtz 사용 | 판정 |
|---|---|---|---|
| `requestImage(camIdx, presetIdx, ptz?)` | `ICameraClient`(CameraClient.ts:23~27). ptz 는 **부분 override** `{pan?, tilt?, zoom?}` | 369행 `requestImage(camIdx, presetIdx, ptz)` — 3필드 전량 명시 | ✅ |
| 반환 `CapturedImage` | `@parkagent/types`:80~88 — `{camIdx, presetIdx, pan, tilt, zoom, imgName, jpg: Buffer}` | `cap.jpg` **만** 소비 | ✅ **에코 필드(pan/tilt/zoom) 미소비 = "에코 불신" 결정이 코드로 강제됨** |
| **base64 경계** | `CameraClient.ts:88` `jpg: Buffer.from(body.img_bytes ?? '', 'base64')` — **클라이언트가 디코드 소유** | platePtz 는 `Buffer` 만 취급, base64 미인지 | ✅ 경계 정확(이중 디코드·문자열 혼입 없음) |
| `detect(image: Buffer): Promise<PlateBox[]>` | `LpdClient`. **픽셀→정규화 변환은 클라이언트가 수행**(주석 37~38행) | 371행 `detect(cap.jpg)` → 정규화 좌표로 수신 | ✅ **정규화 0~1, 픽셀 아님** — 일치 |
| `PlateBox` | `{quad: NormalizedQuad, confidence, cls}` | `quad` → `quadBoundingRect` 만(190·222·270행). `confidence`/`cls` 미사용 | ✅ (유닛만 confidence 를 신원 태그로 사용 — 프로덕션 결합 없음) |
| 좌표계 | 정규화 0~1. `centerTol 0.03`·`matchRadiusNorm 0.08`·`targetPlateWidth 0.20` 전부 정규화 단위 | 동일 단위끼리만 비교(376행 `Math.hypot(...) <= radius`) | ✅ **픽셀/정규화 혼용 없음** |
| **1-based 인덱스** | `calibrate/types.ts:3` "cam/preset 인덱스는 1-based". `CameraClient.ts:105` "1-based(수용기준 5)". 전송 시 `{cam_idx, preset_idx}` snake_case 변환은 **클라이언트 소유** | `camIdx`/`presetIdx` 를 **해석 없이 그대로 통과**(369행) — 오프셋 가감·0-based 변환 없음 | ✅ 관례 유지. 라이브 하네스도 `CAM=1, PRESET=1` |
| 전송 오류 | `LpdApiError`/`CameraApiError` | 삼키지 않고 전파(try/catch 부재) | ✅ 유닛 12 |

**불일치 0건.**

---

## 4. 변경 범위 — 사실 확인

### 4.1 워크트리 `git status --porcelain`
```
 M SettingAgent/_workspace/01_architect_plan.md
 M SettingAgent/_workspace/02_developer_changes.md
 M SettingAgent/src/calibrate/controlMath.ts
?? SettingAgent/_workspace/plate-ptz/_live/
?? SettingAgent/data/Place01/
?? SettingAgent/data/refframes/
?? SettingAgent/src/calibrate/platePtz.ts
?? SettingAgent/test/platePtz.test.ts
```
→ **소스 변경면은 정확히 3개**: `controlMath.ts`(수정) + `platePtz.ts`·`platePtz.test.ts`(신규).
`PtzCalibrator.ts`·`detectMath.ts`·`geometry.ts`·라우트·`config/tools.config.json`·`toolsConfig.ts` **전부 부재 = 무접촉 확인**.

### 4.2 `controlMath.ts` append-only — 실제 검증
```
$ git diff --numstat main -- src/calibrate/controlMath.ts
46      0       SettingAgent/src/calibrate/controlMath.ts

$ git diff main -- src/calibrate/controlMath.ts | grep -E "^@@|^-[^-]"
@@ -103,3 +103,49 @@ export function dampGain(...)
(삭제 줄 0건 — '-' 로 시작하는 출력 없음)
```
→ **삽입 46 / 삭제 0**, 훅 **단 1개**이며 위치는 **파일 말미**(기존 마지막 함수 `buildSlotPtzJson` 뒤). **기존 줄 무삭제·무수정 = append-only 사실 확인.** 기존 `controlMath` 테스트 무수정 green(§1 ③)이 동작 무변경을 뒷받침.

### 4.3 메인 리포 무접촉
```
$ cd D:\Work\Parking3D\AgentVLA\ParkAgent
$ git status --porcelain SettingAgent/src/calibrate/
(출력 없음)
$ ls SettingAgent/src/calibrate/
PtzCalibrator.ts  controlMath.ts  detectMath.ts  slotPtzWriter.ts  types.ts
```
→ 메인 리포 `src/calibrate/` **변경 0건**, `platePtz.ts` **부재**. 본 과제의 산출물은 메인 리포에 **한 줄도 쓰이지 않았다**.
(메인 리포에 존재하는 다른 수정분 — `web/*`·`occupancyJudge.test.ts`·`.claude/*` 등 — 은 **본 세션 시작 시점 스냅샷에 이미 존재**하던 이전 세션(vpd-seg-cuboid)의 것으로 PlatePtz 와 무관하다.)

---

## 5. 발견 결함 (은닉 없음)

### D-1. `controlMath.ts:114` — **폐기된 r1 오염 실측값이 부호까지 틀린 채 JSDoc 에 남아 있다** (문서·중요)

```ts
/**
 * 게인의 zoom 스케일: 게인[°/정규화] ∝ FOV ∝ 1/zoom → gain(z) = gain(zRef)·zRef/z.
 * 실측: gainPan≈+45, gainTilt≈−21 (zoom 1.69 기준) → zoom 20 에서 약 1/12.   ← ★ 여기
 */
export function scaleGainForZoom(...)
```

- **문제**: `gainPan≈+45` 는 **r1 의 aliasing 오염 허상**이며 **부호가 반대**다. r2 참값은 **−36.6**(diagSweep), 라이브 실측도 **−37.1**. 이 프로젝트에서 **r1 라이브 실패의 근본 원인이 정확히 "게인 부호를 +로 잘못 믿은 것"** 인데, 그 틀린 믿음이 **"실측:" 이라는 단정형으로 코드 주석에 화석화**되어 있다.
- **왜 살아남았나**: r2 판이 `controlMath.ts` 를 "이번 판 무접촉"으로 선언했기 때문. 그러나 이 줄은 **main 에 없던, r1 이 새로 추가한 줄**이므로 정정해도 append-only 제약을 깨지 않는다(§4.2 의 46삽입/0삭제 블록 내부).
- **영향**: 런타임 0(주석). 그러나 다음 엔지니어가 `scaleGainForZoom` 을 읽고 "게인은 양수(+45)"라 믿을 유일한 근거가 되며, 이는 **정확히 r1 실패를 재생산하는 경로**다. 기본값(−62)·설계서·테스트는 전부 음수인데 **이 주석만 홀로 +를 주장** = 코드베이스 내부 모순.
- **조치**: 구현자 소관(검증자는 src 를 고치지 않음). **`실측: gainPan≈−36.6, gainTilt≈−21.0 (zoom 1.69341 기준, diagSweep 전체목록 공통변위)` 로 정정 권고 — 1줄, 무위험.**

### D-2. **`zoomToPlateWidth` 단독 경로에서 fallback 게인은 "probe 실패 시에만" 쓰이지 않는다 — 무측정으로 100% 사용된다** (계약 노출·중요)

리더가 준 전제 *"probe 가 부호를 실측하므로 fallback 은 probe 실패 시에만 쓰인다"* 는 **`centerOnPlate` 에만 참이고 `zoomToPlateWidth` 에는 거짓이다.**

- **코드 사실**: `probeGain` 호출부는 **202행 단 1곳(`centerOnPlate`)**. `zoomToPlateWidth` 는 **probe 를 전혀 하지 않는다**(설계 §2.2 의 의도적 결정 — "스케일링이 probe 재실행을 대체").
  ```ts
  // platePtz.ts:264 — zoomToPlateWidth
  const gainRef: PtzGain = o.gain ?? { gainPan: o.fallbackGainPanDeg, gainTilt: o.fallbackGainTiltDeg, zoomRef: 1 };
  // → opts.gain 미전달(=단독 호출) 시 fallback 이 전 가드 스텝의 게인. 측정 기회 0.
  ```
- **노출 범위(정확히)**:
  | 경로 | 게인 출처 | fallback 부호·크기 오류 시 |
  |---|---|---|
  | `centerOnPlate`, probe **성공** | **probe 실측**(부호 포함) | **무해** — 주 경로는 자가 교정 |
  | `centerOnPlate`, probe **실패**(검출 누락·매칭 기각) | fallback | 예측 prior 오염 → 발산/`plate_lost` |
  | `zoomToPlateWidth` + `opts.gain` 체이닝 | 호출측 실측 게인 | **무해** |
  | **`zoomToPlateWidth` 단독(opts.gain 없음)** | **fallback 무조건** | **가드가 매 반복 역방향으로 밀어 오차 확대 → `plate_lost`** (= r1 C 실패의 메커니즘) |
- **왜 지금 green 인가**: r2 fallback(−62/−35.5)이 **이 시뮬 카메라의 참값 그 자체**라서다. 라이브 C(줌 단독, base 에서) PASS 는 **"fallback 이 맞았기 때문에" 통과한 것**이지, 단독 경로가 게인을 스스로 알아내서가 아니다.
- **왜 중요한가**: **요구 ③-c("각각 단독 사용 편의")가 지목하는 경로가 정확히 이 경로**다. 즉 요구가 요구하는 사용법이, 이 모듈에서 게인 지식이 가장 취약한 사용법이다. 다른 카메라·프리셋에서 게인이 다르면 **`zoomToPlateWidth` 단독만 조용히 열화**한다(센터링은 probe 로 자가 교정되므로 멀쩡하다 → **증상이 비대칭이라 진단이 어렵다**).
- **판정**: **설계 §2.2 의 의식적 결정이며 이번 범위의 구현 결함은 아니다**(설계·구현 모두 문서화된 대로 동작). 그러나 **설계서·JSDoc 어디에도 "단독 줌은 fallback 정확도에 전적으로 의존한다"가 명시되어 있지 않다** — **이 침묵이 결함이다**. **JSDoc 1~2줄 명시 권고**(후속 대안: 단독 호출 시 첫 가드에서 probe 1회. 단 설계 §2.6 이 비용 근거로 기각한 바 있어 **현 범위에서는 문서화가 옳다**).

---

## 6. 유닛 보강 — 1건 추가 (그 외 추가 불요)

### 추가: 케이스 21 — "화면 가로 20%" 정의(설계 §4)를 기울어진 OBB 로 구분 검증

`test/platePtz.test.ts` 에 `describe('21. ...')` 신설(+ 헬퍼 `rotatedPlateAt`/`tiltedZoomModel`, `quadBoundingRect` import). **26 tests green, 전량 1667 green(회귀 0).**

- **왜 필요했나**: 기존 픽스처의 번호판은 **전부 `rectToQuad` 축정렬**이었다. 축정렬 OBB 에서는 `quadBoundingRect(quad).w` 와 OBB 장변의 **수치가 같아** 두 정의가 구분되지 않는다. 즉 **설계 §4 의 정의 결정 — 요구 ② "화면 가로의 20%"의 의미 그 자체 — 이 모듈을 통해 한 번도 검증된 적이 없었다.** 실제 번호판은 기울어져 있다(설계 §4 가 cosθ·15°·3.5% 를 논한 이유가 바로 그것이다).
- **검증 내용**: 12° 기울어진 OBB(장변 0.05·z, 단변 0.012·z, 중심 고정)를 `zoomToPlateWidth` 에 통과시켜
  ① 보고 폭이 `quadBoundingRect(r.plate.quad).w` 와 **12자리 일치**(장변·중심 정의가 아님을 못박음)
  ② 그 정의로 **0.18~0.22 수렴**
  ③ OBB 장변과 보고 폭이 **실제로 다름**(=①이 유의미한 구분임을 증명 — 축정렬 픽스처였다면 이 단언이 red)
  ④ 두 정의 차 **< 3.5%**(설계 §4 ④의 근거 주장 자체를 검증)
- **결과**: **green** — 설계 §4 의 정의가 코드에 실제로 구현되어 있음이 이제 증명된다. **결함 아님, 커버리지 공백 해소.**
- **과설계 아님 근거**: `it` 1개 + 헬퍼 1개. 마스터 요구 ②에 직결. 기존 케이스와 중복 0. 기존 케이스는 **한 줄도 고치지 않았다**(기대값 완화 0).

### 추가하지 않은 것 — 근거

| 후보 | 미추가 근거 |
|---|---|
| `zoomToPlateWidth` 의 `no_plate` 분기(268행) | `centerOnPlate` 의 동일 분기를 케이스 2 가 덮고, 두 분기는 동일 1줄 패턴. reason 열거는 타입이 강제. **비용 대비 정보 0** |
| opts 오버라이드(`centerTol`/`targetPlateWidth` 등) 개별 테스트 | 케이스 8·9·14·16·20 이 이미 opts 주입 경로를 실사용. 값 전달 테스트는 동어반복 |
| `settleMs`/sleep 호출 횟수 | 관측 가치 없음(과설계) |
| aliasing 추가 방어 테스트 | 설계 §2.7 이 **장치를 넣지 않기로 결정** — 없는 기능은 테스트 대상이 아님. 회귀 감시는 케이스 20-② 가 담당 |
| 라이브 스모크의 유닛화 | 불가·부적절. 라이브는 리더가 실장비로 수행(§7), 결과는 §7 에 기록 |

---

## 7. 라이브 실측 (리더 수행 — 재현하지 않고 기록·검토)

환경: **실 Unity :13110 JSON-RPC + 실 LPD :9082**, cam1 preset1 base=`{pan:22, tilt:6.8, zoom:1.69341}`, 화면 번호판 6개. 하네스 `_workspace/plate-ptz/_live/platePtzLive.mts`(관측은 `track.mts` 미세스텝 추적 — **최근접 휴리스틱 배제**, 설계 §7 r2 준수 확인).

```
사전: 대상 cx=0.4270 cy=0.6707 w=0.0274 (errX=-0.0730 errY=0.1707)
A centerOnPlate 단독 : ok=true iters=1  ptz={pan:19.293, tilt:10.426, zoom:1.69341}
                       독립추적: errX=-0.0016 errY=-0.0022 width=0.0304   → PASS(≤0.03)
D 게인 정합           : gainPan=-37.1 / gainTilt=-21.2 (@z1.69, 참값 -36.6/-21.0 ±20%) → PASS
B zoom(센터링 후 체이닝): ok=true iters=6 zoom=10.998 width=0.1849 errX=-0.0138 errY=-0.0136 → PASS(0.18~0.22)
C zoom 단독(base 에서) : ok=true iters=7 zoom=11.127 width=0.1829 errX=-0.0216            → PASS
목시: 번호판 '351주6523' 이 화면 중앙, 가로 폭 ≈ 화면의 1/5. 센터링 스샷과 동일 번호판(신원 유지).
```

**검증자 검토**: 설계 §7 Goal ①②③④ 전 항목 충족. 관측 기법이 r2 교훈(전체목록/미세스텝 추적)을 준수하므로 **r1 같은 허위 PASS 위험은 배제**. 유닛 모델의 예측(케이스 15: iters=7 · zoom 11.22 · width 0.182)이 **라이브 C(iters=7 · zoom 11.127 · width 0.1829)와 1% 내 일치** — 모킹 물리 모델이 실물리를 재현한다는 강한 방증. **뒤집을 근거 없음.**

---

## 8. 남은 리스크·한계 (은닉 없음)

### R-1. 라이브 검증은 **단일 프리셋·단일 대상**뿐 — 일반화 근거 없음 (높음)

- 하네스가 `CAM=1, PRESET=1, BASE={22, 6.8, 1.69341}` **상수 고정**(`platePtzLive.mts`). **preset2/3 미검증, cam2+ 미검증, 실카메라(Hucoms) 미검증, 야간·우천·원거리 미검증, 대상 번호판은 6개 중 1개(중심 최근접)뿐.**
- 즉 **"이 모듈은 cam1 preset1 의 그 번호판에서 동작한다"** 가 실증의 정확한 범위다. A/B/C/D 전항 PASS 는 **필요조건 통과**이지 일반화가 아니다.
- **preset2/3 은 번호판 간격·게인·가시 개수가 달라** R-4(간격)·D-2(fallback)의 노출이 달라진다. **프리셋 확장 시 최소 1개 프리셋에서 A~D 재관측 권고.**

### R-2. fallback 게인의 **다른 카메라·실장비 타당성 — 근거 없음** (중간, 단 노출 제한적)

- `fallbackGainPanDeg=-62`/`fallbackGainTiltDeg=-35.5` 는 **Unity 시뮬 cam1 의 실측(−36.6/−21.0 @z1.69341)을 zoomRef=1 로 환산한 값**이다. **이 카메라 1대의 광학·마운트에서 유도된 상수**이며, 다른 카메라에서 타당하다는 근거는 **없다**(게인 크기는 FOV·센서에, 부호는 마운트·회전 규약에 종속).
- **부호 반전 여지 — 코드 확인 결과**:
  - `RealPtzSource.toNativePtz`(124~130행)는 `mapRange(viewerPtz.pan, VIEWER_PAN_RANGE[-180,180], panRange)` **선형 매핑**이다. 기본 `HUCOMS_DEFAULT_PAN_RANGE=[0,36000]`·`HUCOMS_DEFAULT_TILT_RANGE=[0,9000]` 은 **단조 증가**(c<d) → **부호 보존**. 따라서 **기본 설정의 Hucoms CGI 매핑은 부호를 뒤집지 않는다.**
  - **단 2가지 반전 경로가 열려 있다**: ① `cfg.ptz.panRange` 를 **역순(예 `[36000, 0]`)으로 설정하면 `mapRange` 가 부호를 반전**시킨다(역순 range 를 막는 검증 코드 없음). ② `HUCOMS_PTZ_PARAMS` 에 **`// 실측 보정 필요`** 주석이 달려 있다 — **실장비 파라미터 매핑 자체가 미검증**임을 코드가 자인한다.
  - **단, `RealPtzSource` 는 뷰어 계층 `CameraSource` 이며 `PlatePtz` 가 쓰는 `ICameraClient` 경로가 아니다.** PlatePtz 의 라이브 경로는 `RpcCameraClient`(Unity RPC)였다. **실카메라를 PlatePtz 에 물리는 경로는 아직 존재하지 않는다** — 그 경로를 만들 때 부호 검토가 필요하다.
- **노출 범위(정확히 — D-2 와 연동)**: **"probe 가 실측하므로 fallback 은 안전판일 뿐"은 센터링에 한해 참**이다. **줌 단독은 fallback 이 1차 의존**이다(D-2 표 참조).
- **권고**: 새 카메라 도입 시 **`diagSweep` 로 게인 실측 후 `opts.fallbackGain*` 주입**(config 스키마 확장 불요 — opts 로 조정 가능).

### R-3. **config 기본 `+20`/`+15` 는 실측 부호와 반대 → `PtzCalibrator` 경로가 동일 결함을 잠재 보유** (중간, 이번 범위 무접촉 — 후속 과제)

코드로 확인한 사실:
```
config/tools.config.json:70-71     "fallbackGainPanDeg": 20,  "fallbackGainTiltDeg": 15,
src/config/toolsConfig.ts:277      probeStepDeg: 1.0, maxStepDeg: 5.0, fallbackGainPanDeg: 20, fallbackGainTiltDeg: 15,
src/config/toolsConfig.ts:114-115  fallbackGainPanDeg: z.number(),  fallbackGainTiltDeg: z.number(),   ← 부호 제약 없음
src/calibrate/PtzCalibrator.ts:229 const fb = { gainPan: this.cfg.fallbackGainPanDeg, gainTilt: this.cfg.fallbackGainTiltDeg };
```
- **둘 다 양수(+20/+15) = 실측 부호(−36.6/−21.0)와 반대.** 크기도 1.8배 작다. zod 스키마에 부호 제약 없음.
- **영향 범위(정확히)**: `PtzCalibrator.probeGain`(223~240행)에서 **probe 실패 시에만** 이 fb 가 `estimateGain` 의 폴백으로 쓰인다 → 그 경우 P 제어가 **역방향 보정 → 발산**. probe 성공 시에는 `estimateGain` 이 부호를 실측하므로 무해.
- **가중 요인**: `PtzCalibrator` 는 **예측 prior 추적이 없다**(`captureAndDetect(t, ptz)` 가 고정 prior 최근접). 즉 **PlatePtz 가 r1 에서 겪은 신원 전환(aliasing)에 구조적으로 노출**되어 있고 거기에 부호 반대 fallback 이 겹친다. **PlatePtz 가 고친 3가지(부호·신원추적·damp 상한)를 `PtzCalibrator` 는 전부 그대로 갖고 있다.**
- **이번 범위 무접촉이 옳다**(변경 시 기존 테스트·동작 영향 — 설계 §8). **후속 과제로 명시 기록**: ① config 기본을 −62/−35.5 로 정정할지(→ `PtzCalibrator` 동작 변화·기존 테스트 영향 검토 필요) ② 또는 설계 §8 의 `PtzCalibrator` → `PlatePtz` 위임 리팩토링으로 근본 해소. **②가 옳다** — 상수만 고치면 신원추적·damp 상한 결함은 남는다.

### R-4. 번호판 간격 0.15 보다 **촘촘한 장면**의 aliasing 여유 (중간)

r2 의 안전 논증은 **실측 간격 0.15**(절반 0.075)를 분모로 삼는다. 간격이 좁아지면 여유가 선형으로 줄어든다:

| 장치 | 변위/예측오차 | 안전 조건 | 간격 0.15 에서 | **여유가 소진되는 지점** |
|---|---|---|---|---|
| probe 1° | 0.027(pan) / **0.048(tilt)** | 변위 < 간격/2 | 36%(pan)·**64%(tilt)** 사용 | **tilt 기준 간격 ≈0.095 에서 한계** |
| 본 루프(probe 실측 게인, 오차 ≤1%) | 최악 tilt 5° → 0.238 × 1% = **0.0024** | 예측오차 < 간격/2 | 3% 사용 | 간격 ≈0.005 (**사실상 무한 여유**) |
| **fallback 구동 시**(probe 실패 · **줌 단독**) | 0.238 × (fallback 상대오차) | 예측오차 < 간격/2 | 허용 오차 **31%** | 간격 0.08 → 허용 **17%**, 간격 0.05 → **10%** |
| `matchRadiusNorm` 0.08 | — | 반경 < 간격 − 예측오차 | 0.15 에서 유효 | **간격 <0.08 이면 이웃이 반경 안 = 반경 가드 무력화** |

- **결론**: **본 루프는 촘촘한 장면에서도 매우 안전**(probe 실측 게인 덕). **취약한 것은 ① tilt probe**(간격 ≈0.095 이하에서 1° 변위 0.048 이 간격 절반에 접근 — pan 보다 tilt 가 먼저 터진다) **② fallback 구동 경로**(=D-2 의 줌 단독).
- **간격 0.08 미만 장면에서는 `matchRadiusNorm` 기본 0.08 이 이웃을 배제하지 못한다** — 이때 오매칭 차단은 전적으로 "예측 오차 < 후보 간 중점 거리"에 의존한다(설계 §2.7 이 논증한 실제 판정 기준이므로 즉시 파탄은 아니나, **반경이라는 안전망이 사라진다**).
- **자동 조정 없음** — `matchRadiusNorm`·`probeStepDeg` 는 opts 로 수동 조정 가능하나 **장면 밀도를 감지해 조정하는 장치는 설계상 없다**(과설계 금지 결정). **촘촘한 장면 도입 시 1순위 튜닝 대상**이며 증상은 `plate_lost` 반복이다.

### R-5. (경미) 모킹 물리 모델의 구조적 한계

유닛의 `makeWorld` 는 `gain ∝ 1/zoom` **핀홀·소각 근사를 참으로 가정**한다. 라이브 B/C(zoom 7~13)가 이 가정 하에서 PASS 했으므로 **시뮬 카메라에 대해서는 검증됨**. 그러나 **유닛 green 은 라이브 성공의 필요조건일 뿐 충분조건이 아니다**(구현자 §R2-6-1 의 자기평가에 동의). 실카메라의 zoom-FOV 곡선이 비선형이면 가드가 과/부족 보정할 수 있다(설계 §9-6).

### R-6. (경미) `improvement`/`IMPROVE_EPS` 3줄 중복

`platePtz.ts:110·381~384` 가 `PtzCalibrator.ts` 의 module-private 정의를 복제. 런타임 영향 0, 범위 밖(설계 §2.6 이 controlMath 추가를 3종으로 한정). 설계 §8 위임 리팩토링 시 `controlMath` 승격으로 해소 권고.

---

## 9. 구현자에게 (재실행 루프 아님 — 실패 리포트 없음)

게이트는 **전량 green 이며 재현되었다**. 테스트를 느슨하게 고친 항목 없음. 요청은 **2건뿐이며 둘 다 문서/주석**이다(로직 무변경 권고 — 현 로직은 라이브가 검증했다):

1. **D-1 (권고·1줄)**: `src/calibrate/controlMath.ts:114` JSDoc 의 `실측: gainPan≈+45, gainTilt≈−21 (zoom 1.69 기준)` → **`실측: gainPan≈−36.6, gainTilt≈−21.0 (zoom 1.69341 기준, diagSweep 전체목록 공통변위)`**. **부호가 반대인 폐기값이 "실측"으로 남아 r1 실패를 재생산할 유일한 근거가 된다.** 이 줄은 r1 이 추가한 줄이라 정정해도 append-only 유지.
2. **D-2 (권고·JSDoc 1~2줄)**: `zoomToPlateWidth` JSDoc 에 **"`opts.gain` 없이 단독 호출하면 가드 게인은 probe 없이 fallback 에 100% 의존한다 — 카메라가 바뀌면 `opts.fallbackGain*` 를 `diagSweep` 실측으로 주입할 것"** 명시. 현 JSDoc 은 "fallback(−62/−35.5)"을 언급하나 **그것이 무측정 1차 의존이라는 사실은 침묵**한다.

## 10. 문서화에게

- **핵심 메시지**: 신규 2파일(`platePtz.ts`·`platePtz.test.ts`) + `controlMath.ts` **append-only 46줄**. `PtzCalibrator`·`geometry`·`detectMath`·라우트·config **무접촉**(§4 로 사실 확인). 메인 리포 **무접촉**.
- **게이트**: typecheck 무오류 / platePtz **26 passed**(검증자 케이스 21 추가) / 전량 **151 files · 1667 passed · 회귀 0**.
- **라이브**: cam1 preset1 실 Unity+실 LPD 에서 A/B/C/D **전항 PASS**(§7) — **단 단일 프리셋 실증임을 반드시 명기**(R-1).
- **반드시 문서에 실을 것**: D-1(주석 부호 오정보) · D-2(줌 단독의 fallback 의존) · R-3(**config +20/+15 → `PtzCalibrator` 잠재 결함 — 후속 과제**) · R-4(촘촘한 장면 여유).
- **"완벽 통과"로 요약하지 말 것** — 실증 범위는 **cam1 preset1 단일 프리셋·단일 대상**이다.

---

## 부록: 검증자 변경 파일

| 파일 | 변경 |
|---|---|
| `test/platePtz.test.ts` | **케이스 21 추가**(`describe` 1 + `it` 1) + 헬퍼 `rotatedPlateAt`/`tiltedZoomModel` + `quadBoundingRect` import. 25→**26 `it`**. **기존 케이스 무변경**(기대값 완화 0). |
| `_workspace/plate-ptz/03_qa_report.md` | 본 보고서(이전 세션 VPD 과제 보고서를 대체). |

`src/` **무변경** — 검증자는 소스를 고치지 않았다(D-1/D-2 는 구현자 소관으로 이관).
