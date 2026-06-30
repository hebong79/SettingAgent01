# 02 구현 노트 — 주차면별 번호판 중심정렬·줌 PTZ 캘리브레이션 → `slot_ptz.json`

작성: 구현자(developer) · 대상: 검증자(qa-tester)·문서화(documenter)
근거: `_workspace/01_architect_plan.md` 단계 ①~⑦ + 마스터 확정 결정(A/C·★ PTZ 명령추적).

---

## 0. 결과 요약

- **typecheck**: `tsc -p tsconfig.json --noEmit` 무오류.
- **test**: `npm test` → **55 파일 / 372 테스트 전부 통과**. 기존 **50 파일 / 330 테스트 회귀 0**(설계서의 "331"은 실측 베이스라인 330 — 기준선 차이는 기존 테스트 수일 뿐 회귀 아님).
- 신규 테스트 5 파일 / +42: `controlMath`(16)·`slotPtzWriter`(4)·`ptzCalibrator`(10)·`calibrateRoutes`(8)·`agentRuntimeCentering`(3) + `config`(+1).

---

## 1. 파일별 변경

### 신규 — `src/calibrate/`
| 파일 | 내용 |
|---|---|
| `types.ts` | `PlateTarget`·`Ptz`·`SlotPtzItem`·`SlotPtzArtifact`·`CenteringAdvice`·`CalibrateState`·`CalibrateStatus`. **SettingAgent 로컬**(@parkagent/types 미승격, 결정 A). |
| `controlMath.ts` | 순수 제어수학(외부 의존 0). `plateCenterError`·`pickNearestPlate`·`estimateGain`·`panTiltCorrection`·`zoomCorrection`·`isCentered`·`isWidthConverged`·`dampGain`·`buildSlotPtzJson`. |
| `slotPtzWriter.ts` | `expandPlateTargets(artifact)`(plateRoiByPreset 키마다 1항목 펼침·globalIdx 역참조)·`writeSlotPtz`(Repository 비오염 별도 파일 I/O). |
| `PtzCalibrator.ts` | 잡(상태머신·슬롯순회·`calibrateSlot`). CaptureJob 패턴 차용. |

### 신규 — `src/api/`
- `calibrateRoutes.ts` — `POST /calibrate/ptz`(start·중복 409·zod 400)·`GET /calibrate/status`·`GET /calibrate/result`(없음 404). captureRoutes 패턴.

### 수정(가산만)
- `src/brain/SetupBrain.ts` — `CenteringAdviceInput`·`CenteringAdviceSchema`·`CenteringAdvice` + `SetupBrain.adviseCentering?` 인터페이스 가산.
- `src/brain/AgentRuntime.ts` — `adviseCentering` 메서드(인라인 한글 프롬프트·`chatJson` 재사용·이미지 멀티모달). import 가산.
- `src/config/toolsConfig.ts` — `CalibrateSchema` + `ToolsConfigSchema.calibrate` + `DEFAULT_TOOLS_CONFIG.calibrate`(병합 루프가 자동 처리).
- `config/tools.config.json` — `calibrate` 섹션.
- `src/api/server.ts` — `ApiDeps.calibrator?`·`calibrate?` + 주입 시 `registerCalibrateRoutes`(기존 라우트 불변).
- `src/index.ts` — `PtzCalibrator` 조립·주입(`camera,lpd,brain,repo,cfg`).
- `web/index.html` — 정밀수집 탭에 "PTZ 캘리브레이션" 영역(시작 버튼·진행바·요약).
- `web/app.js` — `calStart`·`calPoll`·`renderCalResult` + 버튼 결선 + 탭 진입 시 폴링.

### 신규 테스트
- `test/{controlMath,slotPtzWriter,ptzCalibrator,calibrateRoutes,agentRuntimeCentering}.test.ts`, `test/config.test.ts` 가산.

---

## 2. ★ PTZ 명령추적(결정적 수정) 구현

시뮬 `/req_img`·`/req_move` 응답 PTZ 가 0/0/1 echo 라 신뢰 불가 → **응답 PTZ 로 재동기화하지 않는다.**

- `PtzCalibrator.calibrateSlot` 내부에서 PTZ 상태(`ptz: Ptz`)는 **내가 명령한 값**으로만 갱신한다. `captureAndDetect(t, ptz)` 가 `camera.requestImage(cam, preset, ptz)` 로 **명령 PTZ override** 를 넘겨 현재 명령 화면을 얻고, 응답 객체의 `pan/tilt/zoom` 은 **읽지 않는다**.
- 게인은 **명령한 도(°) 변화 ↔ 관측 번호판 정규화 변위**로 측정(`probeGain` → `estimateGain`). 응답 PTZ 무관.
- 테스트(`ptzCalibrator.test.ts`)의 모킹 LPD 는 응답 PTZ(0/0/1)가 아니라 **명령 PTZ(requestImage 인자)** 에 따라 번호판 위치·폭을 생성해 이 규약을 재현·검증한다.

---

## 3. 제어 루프·게인(설계서 §1.3 의사코드 구현)

순서 엄수: **A) pan/tilt 중심정렬(0.5,0.5) → 수렴 후 B) zoom(폭 targetPlateWidth)**.

- **probe 게인**: 시작점에서 `probeStepDeg`(1°) pan·tilt 1회 이동 후 변위로 부호 포함 게인 추정. 변위 미미(분모≈0)면 fallback 게인(`fallbackGainPanDeg/TiltDeg`).
- **P 제어**: `panTiltCorrection` = `newPan = curPan - errX*gainPan`(부호는 probe 측정 gain 에 흡수), 1스텝 `±maxStepDeg` 클램프.
  - **설계 의사코드(line 44)의 부호(`- errX*gain`)를 그대로 따름.** 구현 1차에 `+`로 작성했다가 모킹 수렴 실패로 발견 → `-`로 정정(controlMath.ts). 설계 위반 아님(설계서가 명시한 부호).
- **zoom**: `zoomCorrection` = `clampZoom(curZoom * sqrt(target/cur))`, plateWidth≈0 방어, `clampZoom` 1~36(CameraClient).
- **진동 감쇠**: 중심정렬 루프에서 오차 크기(유클리드) 개선이 `IMPROVE_EPS`(1e-3) 미만이면 `dampGain`(절반).
- **zoom→중심 드리프트**: zoom 루프 내 중심 이탈 시 `panTiltCorrection` 1스텝 재중심(과보정 방지 1회).
- **상한**: pan/tilt·zoom 각 `maxIterations`(15) 루프 상한.
- **settle**: `captureAndDetect` 내 `requestImage` 직후 `sleep(settleMs)`. sleep/now 주입(테스트 fake).

### 하이브리드(LLM 자문) + 폴백
- `cfg.llmAdvise && brain.adviseCentering` 존재 시에만 자문 호출. 응답을 **결정형 클램프**(pan/tilt ±maxStepDeg, zoomFactor 0.5~2.0) 후 적용.
- `null`·검증실패 → **비례제어 폴백**. `occluded=true` → 슬롯 스킵(`reason:'occluded'`).
- `brain=undefined`·`llmAdvise=false`·`adviseCentering` 미구현/null 모든 경우 **순수 결정형으로 동작**(테스트로 보장).

### 장애 격리(슬롯 단위 흡수)
- 개별 슬롯 예외는 `run` 루프에서 흡수(경고 + `reason:'error'` 항목, 잡 중단 아님 — CaptureJob `captureTarget` 패턴).
- 번호판 사유 코드: `no_plate`(초기 미검출)·`plate_lost`(중심정렬 중 소실)·`occluded`(자문 가림 판정)·`error`(예외).

---

## 4. `slot_ptz.json` 포맷(설계서 §2)

```jsonc
{
  "createdAt": "ISO8601",
  "items": [
    { "camIdx":1, "presetIdx":1, "slotId":"c1p1s1", "globalIdx":1,
      "ptz":{"pan":12.3,"tilt":-4.5,"zoom":8.2},
      "plateWidth":0.198, "centered":true, "converged":true,
      "reason":"no_plate" } // 옵셔널(스킵·미수렴 시만)
  ]
}
```
- `globalIdx`: `setup_artifact.globalIndex` 에서 `slotId` 역참조(없으면 `null`).
- plateRoiByPreset 키(`${camIdx}:${presetIdx}`)마다 1 항목으로 펼침(다중 프리셋 슬롯 = 키 수만큼 항목, 결정 E).
- **setup_artifact 미수정** — 별도 writer(`writeSlotPtz`), Repository 비오염.

---

## 5. 엔드포인트(설계서 §3.1)

| 메서드·경로 | 동작 |
|---|---|
| `POST /calibrate/ptz` | 백그라운드 잡 시작(본문 옵셔널 `{slotIds?}`). running 중 **409**, no artifact **400**. 응답 `{ok,started,total}`. |
| `GET /calibrate/status` | `{state,done,total,current?,startedAt?,endedAt?}`. |
| `GET /calibrate/result` | `slot_ptz.json` 반환(없으면 **404**). |

- `ApiDeps.calibrator && calibrate` 주입 시에만 등록(가산·미주입 시 미등록 — 테스트로 보장).
- 헤드리스 본체에 등록 → 뷰어는 절대경로 `/calibrate/*` 직접 폴링(capture 와 동일).

---

## 6. 설정(`calibrate` 섹션)

```
targetPlateWidth 0.2 · centerTol 0.03 · widthTol 0.02 · maxIterations 15
probeStepDeg 1.0 · maxStepDeg 5.0 · fallbackGainPanDeg 20 · fallbackGainTiltDeg 15
settleMs 300 · outFile "data/slot_ptz.json" · llmAdvise true
```
- **`llmAdvise`(결정 C)**: false 면 순수 결정형(자문 호출 안 함). 기본 true.
- `DEFAULT_TOOLS_CONFIG.calibrate` 추가 → `loadToolsConfig` 섹션 병합 루프가 자동 처리(부분 병합 검증 추가).

---

## 7. 순수함수 목록(controlMath.ts — vitest 대상, 외부 의존 0)

`plateCenterError` · `pickNearestPlate` · `estimateGain` · `panTiltCorrection` · `zoomCorrection` · `isCentered` · `isWidthConverged` · `dampGain` · `buildSlotPtzJson` (+ writer 측 `expandPlateTargets`).

---

## 8. 검증자 인계 포인트

- **계약 불변 확인**: `setup_artifact.json`·`@parkagent/types`·`/setup/*`·`/capture/*`·`/mapping`·뷰어 라우트 무변경. 기존 330 회귀 0.
- **모킹 전략**: camera/lpd/brain 모킹 + sleep/now 주입. **응답 PTZ(0/0/1)와 명령 PTZ 분리 모델**로 ★ 규약 검증(`ptzCalibrator.test.ts`).
- **라우트**: `app.inject`(라이브 기동 없음). 409 케이스는 영원히 보류되는 sleep 주입으로 running 유지.
- **백그라운드 잡 대기**: 테스트는 `state!=='running'` 까지 microtask/inject 폴링.

---

## 9. 미해결 / 실측보정 필요(라이브 의존 — 본 단계 범위 외)

- **게인 실측(미해결 D)**: pan↔X·tilt↔Y 부호·스케일은 시뮬 라이브에서 probe 응답이 명령 PTZ 와 다른 화면을 실제로 보여줄 때만 검증 가능. 모킹은 규약·수렴 로직만 검증. **시뮬 라이브에서 probe 변위가 관측되는지** 확인 필요.
- **gemma 자문 신뢰도(미해결)**: `adviseCentering` 실 LLM 응답 품질은 실 모델 호출 필요. 본 단계는 fake OpenAI 서버로 파싱·클램프·폴백 경로만 검증.
- **실 PTZ 단위(미해결 B)**: 본 기능은 **시뮬 도(°) 단위** 한정. 실 PTZ 매핑은 후속.
- **베이스라인 수치**: 설계서 "331"과 실측 "330" 차이는 기존 테스트 카운트일 뿐(회귀 아님).
