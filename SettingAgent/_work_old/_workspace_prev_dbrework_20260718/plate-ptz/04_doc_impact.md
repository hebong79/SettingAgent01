# 영향도 분석: 번호판 센터링·줌 독립 함수 모듈 (PlatePtz)

작성: 2026-07-16 / 문서화(documenter)
브랜치: `feat/plate-ptz` (워크트리 `D:\Work\Parking3D\AgentVLA\ParkAgent-plate-ptz\SettingAgent`, 기준 커밋 `0deddb1`)

관련 문서: `docs/20260716_192522_번호판센터링줌모듈.md`(상세 설명·API·서사·라이브 검증)

> 이 파일은 이전 세션(VPD 육면체 과제)의 영향도 요약을 대체한다 — 본 워크트리 세션(PlatePtz)의 기록.

---

## 1. 변경 범위 — 사실 확인 (`git diff --numstat` 직접 실행)

```
$ git diff --numstat main -- src/calibrate/controlMath.ts
48      0       SettingAgent/src/calibrate/controlMath.ts

$ git status --porcelain (src 하위)
 M SettingAgent/src/calibrate/controlMath.ts
?? SettingAgent/src/calibrate/platePtz.ts
?? SettingAgent/test/platePtz.test.ts
```

- **신규 파일 2개**: `src/calibrate/platePtz.ts`(신규 클래스 `PlatePtz`), `test/platePtz.test.ts`(26 케이스).
- **기존 파일 수정 1개**: `src/calibrate/controlMath.ts` — **48줄 삽입 / 0줄 삭제**. `git diff` 훅 위치를 직접 확인한 결과 단일 지점(`@@ -103,3 +103,... @@`, 기존 마지막 함수 `dampGain`/`buildSlotPtzJson` 뒤)이며, 기존 라인은 한 줄도 수정·삭제되지 않았다(append-only).
  - 추가분: 순수 함수 3종 `scaleGainForZoom` / `predictPlateCenter` / `predictCenterAfterZoom` + JSDoc/주석.
  - 이 3함수의 JSDoc은 QA가 지적한 D-1(폐기된 r1 오염 실측값 `+45`가 부호 반대로 화석화되어 있던 문제)을 반영해 `실측: gainPan≈−36.6, gainTilt≈−21.0(zoom 1.69341 기준)`으로 이미 정정되어 있음을 코드에서 직접 확인했다(`controlMath.ts:112~117`).

이 외 `_workspace/*`(계획·구현·검증 보고서), `data/Place01/`·`data/refframes/`(라이브 검증용 데이터), `_workspace/plate-ptz/_live/*.mts`(진단·라이브 하네스 스크립트)는 코드 변경이 아니므로 영향도 분석 대상에서 제외한다.

---

## 2. 무접촉 확인 (실제 확인 — 추측 아님)

| 대상 | 확인 방법 | 결과 |
|---|---|---|
| `PtzCalibrator.ts` | `git status --porcelain` / `grep controlMath` | 워킹 diff 부재. `controlMath.js` 에서 기존 8종(`plateCenterError`/`pickNearestPlate`/`estimateGain`/`panTiltCorrection`/`zoomCorrection`/`isCentered`/`isWidthConverged`/`dampGain`) + `buildSlotPtzJson` 만 import — **신규 3종은 import 하지 않는다**. 무접촉. |
| `detectMath.ts` | `git status` / `platePtz.ts` import 목록 확인 | 워킹 diff 부재. `platePtz.ts` 는 `detectMath`/`fovBaseV` 를 import 하지 않음(설계 결정 — 오픈루프 배제). |
| `geometry.ts` | `git status` | 워킹 diff 부재. `quadBoundingRect` 를 **소비만**(변경 없음). |
| 라우트 | `grep -rln "platePtz\|PlatePtz" src/routes` | 매치 없음 — 라우트 노출 전혀 없음(설계 §5 의도적 결정, 요청 범위 밖). |
| MCP 도구 | `grep -rln "platePtz\|PlatePtz" src/mcp src/tools` | 매치 없음. |
| `config/tools.config.json` / `src/config/toolsConfig.ts`(zod 스키마) | `git status` | 워킹 diff 부재 — 스키마 확장 없음. `PlatePtzOpts` 의 fallback 게인(−62/−35.5)·probeStepDeg(1°)는 config 기본값과 **의도적으로 다른** PlatePtz 전용 상수(§4 후속과제 ①에서 이 차이 자체가 문제로 지적됨). |
| `@parkagent/types` | `grep -rn "@parkagent/types" platePtz.ts controlMath.ts platePtz.test.ts` | 매치 없음 — 이 모듈은 로컬 타입(`../domain/types.js` 의 `NormalizedRect`, `./types.js` 의 `Ptz`)만 사용. 공유 패키지 무접촉. |
| 메인 리포(`D:\Work\Parking3D\AgentVLA\ParkAgent`) | QA가 `cd` 후 `git status --porcelain SettingAgent/src/calibrate/` 실행(검증 보고 §4.3) — 본 문서화 세션은 메인 리포 쓰기 금지 지시에 따라 재확인하지 않고 QA 기록을 인용 | 변경 0건, `platePtz.ts` 부재 확인됨(QA 기록). 워크트리 산출물은 메인 리포에 반영되지 않았다. |

---

## 3. 의존성 영향 — `controlMath` 소비자

`controlMath.ts` 를 import 하는 기존 소비자는 `PtzCalibrator.ts` 1곳이며, import 목록은 다음과 같이 **신규 3종을 포함하지 않는다**(코드에서 직접 확인):

```
plateCenterError, pickNearestPlate, estimateGain, panTiltCorrection,
zoomCorrection, isCentered, isWidthConverged, dampGain, buildSlotPtzJson
```

`controlMath.ts` 변경이 append-only(기존 함수·시그니처·동작 무변경, 48줄 전부 파일 말미 추가)이므로 **`PtzCalibrator` 의 동작에 영향이 없다** — 이는 추측이 아니라 다음 두 사실로 뒷받침된다.

1. `git diff` 상 기존 코드 라인 무삭제(§1).
2. `npm test` 전량 1667 passed(신규 26 포함) — 기존 `controlMath`/`PtzCalibrator` 테스트가 **한 줄도 수정되지 않은 채** green(회귀 0). 이는 구현자(§R1~R3)와 검증자 양쪽이 각각 실행해 재현한 결과다.

`PtzGain` 타입은 순환 import를 피하기 위해 `controlMath.ts` 가 아닌 `platePtz.ts` 가 소유·export 하고, `controlMath.ts` 의 3함수는 구조적으로 호환되는 인라인 타입(`{gainPan, gainTilt, zoomRef}`)만 받는다 — `controlMath → platePtz` 역방향 의존은 존재하지 않는다.

---

## 4. 후속 과제 (우선순위·근거)

### ① [최우선] `PtzCalibrator.calibrateSlot` → `PlatePtz` 위임 리팩토링

- **근거**: `config/tools.config.json:70-71` 의 `fallbackGainPanDeg:20`/`fallbackGainTiltDeg:15` 는 실측 부호(−36.6/−21.0 @z1.69341)와 **반대**다. `src/config/toolsConfig.ts:114-115`(zod 스키마, `z.number()`)에 부호 제약이 없다. `PtzCalibrator.ts:229` 의 `probeGain` 은 probe 실패 시 이 부호 반대 fallback 을 그대로 쓰므로, P 제어가 역방향으로 발산할 잠재 결함을 갖는다.
- **가중 요인**: `PtzCalibrator` 는 `PlatePtz` 가 이번 작업에서 고친 3가지 — 예측 prior 추적, damp 상한, 게인 zoom 스케일링 — 을 **전부 갖고 있지 않다**. 즉 config 상수(부호)만 고쳐도 신원 전환(aliasing) 취약성과 damp 죽음의 나선은 그대로 남는다.
- **결론**: 상수만 정정하는 미봉책보다, `PtzCalibrator.calibrateSlot` 의 A/B 단계를 `PlatePtz` 로 위임하는 리팩토링이 근본 해법이다. 단, 이는 잡 상태머신·`Repository`·LLM 자문 결박을 해체하는 별도 작업이며 기존 동작·테스트에 영향을 주므로 이번 범위에서는 의도적으로 손대지 않았다(설계 §8 결정, 리더에게 보고만 완료된 상태).

### ② [②는 ①에 종속] `improvement`/`IMPROVE_EPS` 승격

- `platePtz.ts:118-124, 397-401` 의 `improvement()` 함수와 `IMPROVE_EPS` 상수는 `PtzCalibrator.ts` 의 동일 정의를 복제한 것이다(그쪽이 module-private 라 import 불가능해 부득이 복제). ① 리팩토링 시점에 `controlMath.ts` 로 승격해 단일화하는 것이 옳다. 지금 시점에서는 3줄 복제가 기존 파일 수정(export 추가)보다 위험이 낮다는 판단이 유효하다.

### ③ preset2/3·cam2 이상·실카메라 검증 확대

- 라이브 검증은 cam1 preset1 단일 프리셋·단일 대상(6개 번호판 중 1개)뿐이다(QA R-1). 프리셋을 확장할 때 최소 1개 프리셋에서 센터링(A)/체이닝 줌(B)/줌 단독(C)/게인 정합(D) 재관측을 권고한다.

### ④ 라우트/MCP 도구 노출

- 이번 요청 범위 밖(마스터 요구는 "단독으로 쓰기 편한 함수"까지). 필요 시 별도 요청으로 진행.

---

## 5. 워크트리 분리 사실

- 이번 작업은 브랜치 `feat/plate-ptz`(워크트리 `D:\Work\Parking3D\AgentVLA\ParkAgent-plate-ptz\SettingAgent`, 기준 커밋 `0deddb1`)에서만 수행되었다.
- 메인 리포 `D:\Work\Parking3D\AgentVLA\ParkAgent` 는 QA가 확인한 대로 무접촉(§2 표)이며, 이번 문서화 세션도 메인 리포에 쓰기 작업을 하지 않았다.
- 동일 세션 내 다른 워크트리 작업(occupancy 관련 등, 세션 시작 시점 git status 스냅샷에 존재하던 변경분)과 파일 경로가 겹치지 않아 충돌 가능성은 구조적으로 없다.

---

## 6. 요약 (리더 보고용)

- **파일 변경면**: 신규 2개(`platePtz.ts`, `platePtz.test.ts`) + 기존 1개 append-only 수정(`controlMath.ts`, 48삽입/0삭제).
- **무접촉 확인**: `PtzCalibrator`/`detectMath`/`geometry`/라우트/MCP/config 스키마/`@parkagent/types`/메인 리포 — 전부 실제 확인, 추측 없음.
- **의존성 영향**: `controlMath` 기존 소비자(`PtzCalibrator`, 9개 export import)는 신규 3함수를 사용하지 않아 영향 없음 — `git diff` 무삭제 + 전량 테스트 회귀 0으로 뒷받침.
- **후속 과제 1순위**: `PtzCalibrator` 의 config 기본 게인 부호가 실측과 반대인 잠재 결함 → `PlatePtz` 위임 리팩토링이 근본 해법. 이번 범위에서는 의도적으로 미착수.
