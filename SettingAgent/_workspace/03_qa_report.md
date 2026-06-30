# 03 검증 리포트 — 주차면별 번호판 중심정렬·줌 PTZ 캘리브레이션 → `slot_ptz.json`

작성: 검증자(qa-tester) · 대상: 구현자(developer)·문서화(documenter)
근거: `_workspace/01_architect_plan.md` + `_workspace/02_developer_changes.md` + 실측 코드/테스트 실행.

---

## 0. 결론

- **typecheck**: `tsc -p tsconfig.json --noEmit` **무오류**.
- **test**: `npm test` → **55 파일 / 372 테스트 전부 통과, 실패 0, 회귀 0**.
- **★ 명령추적·순서·폴백·라우트·계약 전부 검증 통과.**
- **재작업 필요 없음.** 발견된 구현 결함 없음. 테스트 작성 결함 없음(통과 위장 없음).

베이스라인 확인: 전체 372 − 신규 41 = **331 = 기존 베이스라인**. (구현 노트 "330 + config +1" 과 일치 — config 가산 1건이 기존 config.test.ts 파일에 들어가 기존 카운트에 포함됨. 설계서의 "331" 은 신규 41 제외한 실측 기존치와 정확히 일치.)

---

## 1. 테스트 실행 결과(수치 그대로)

### 전체
```
Test Files  55 passed (55)
     Tests  372 passed (372)
  Duration  2.92s
```

### 신규 5 파일(41 테스트)
```
test/controlMath.test.ts          16 tests  ✓
test/slotPtzWriter.test.ts         4 tests  ✓
test/ptzCalibrator.test.ts        10 tests  ✓
test/calibrateRoutes.test.ts       8 tests  ✓
test/agentRuntimeCentering.test.ts 3 tests  ✓
                                  ──────────
                                  41 passed
```
(구현 노트의 "+42" 는 config.test.ts 가산 1건 포함. 신규 *파일* 합은 41. 둘 다 정합.)

---

## 2. 검증 항목별 결과

### 2.1 제어수학(순수, controlMath.test.ts) — 통과
- `plateCenterError`: 정중앙→0, 우하단→errX·errY 양수. ✓
- `pickNearestPlate`: 다수 중 prior 최근접 선택·빈 배열 null. ✓
- `estimateGain`: probe 전후 변위로 **부호 포함** 게인(pan +2°/errX +0.1→+20, tilt +1°/errY −0.05→**−20** 부호 반영), 분모≈0→fallback(20/15). ✓
- `panTiltCorrection`: `newPan = cur − errX*gain` 부호·`±maxStepDeg` 클램프(−10→−5). ✓
- `zoomCorrection`: 폭>목표 축소·폭<목표 확대·**clamp 1~36**·plateWidth≈0 방어(현재 zoom 반환). ✓
- `isCentered`/`isWidthConverged`: tol 경계(=tol 포함, +ε 초과 false). ✓
- `dampGain`: 절반 감쇠. ✓
- `buildSlotPtzJson`: createdAt·items 스키마 조립. ✓
- `expandPlateTargets`(slotPtzWriter.test.ts): plateRoi 보유 슬롯만·다중 프리셋 키마다 1항목·미보유 제외·globalIdx 역참조(없으면 null)·**실 setup_artifact.json → 26 항목**. ✓

### 2.2 ★ PTZ 명령값 추적(핵심) — 통과
모킹 모델이 규약을 정확히 재현·강제한다:
- 모킹 `camera.requestImage` 는 응답 PTZ 를 **항상 `pan:0,tilt:0,zoom:1`(echo)** 로 반환.
- 모킹 LPD 는 응답 echo 가 아니라 **명령 PTZ**(ptzCalibrator: `moves[]` 의 마지막 명령값 / calibrateRoutes: jpg 페이로드에 실린 명령값)로 번호판 위치·폭을 생성.
- **검증 논리**: 만약 구현이 응답 PTZ(0/0/1)로 상태를 재동기화했다면, 명령을 아무리 줘도 화면은 항상 초기(우하단 0.7/0.8·폭 0.05)로 고정 → **영원히 수렴 불가**. 그러나 happy-path 가 `centered:true·converged:true·plateWidth≈0.2` 로 수렴 → 구현이 **명령값(commanded)만 추적**함을 역으로 증명. ✓
- `calibrateSlot` 소스 확인: 상태 `ptz` 는 내가 명령한 값으로만 갱신, `captureAndDetect` 가 `requestImage(cam,preset,ptz)` 로 명령 override 전달, 응답 객체의 `pan/tilt/zoom` 미참조. 게인은 `probeGain`→`estimateGain`(명령 도 변화↔관측 변위). ✓

### 2.3 순서(pan/tilt 중심 → zoom) — 통과
`ptzCalibrator.test.ts "순서(중심→줌)"`: 첫 `zoom≠1` 명령 인덱스가 마지막 pan/tilt 변화 인덱스보다 **뒤**여야 함을 move 시퀀스로 단언. `firstZoomChange>0 && lastPanTiltChange < firstZoomChange`. ✓
소스 확인: zoom 루프(B)는 중심정렬 루프(A) 완료 후 진입. zoom 루프 내 드리프트 재중심은 1회 한정. ✓

### 2.4 하이브리드/폴백 — 통과
- `brain=undefined` → 결정형만으로 수렴(centered true). ✓
- `llmAdvise=true` + `adviseCentering=()=>null` → 결정형 폴백 수렴. ✓
- `adviseCentering occluded=true` → 스킵 `reason:'occluded'`. ✓
- `agentRuntimeCentering.test.ts`: 정상 JSON→파싱(멀티모달 `image_url`·`data:image/jpeg;base64,` 전송 확인)·잘못된 JSON→재시도 후 null·`llm.enabled=false`→null. ✓
- `applyCenterAdvice`/`applyZoomAdvice` 소스: 자문 제안을 `±maxStepDeg`·zoomFactor `0.5~2.0` 결정형 클램프 후 적용, 없으면 비례제어/zoom 공식. ✓

### 2.5 잡/라우트(calibrateRoutes.test.ts, app.inject) — 통과
- `POST /calibrate/ptz`: 정상 200 `{ok,started,total}`·**중복 409**(영원히 보류 sleep 으로 running 유지)·zod 비배열 slotIds **400**. ✓
- `GET /calibrate/status`: `{state,done,total}` shape. ✓
- `GET /calibrate/result`: 없음 **404**·완료 후 200 `{createdAt,items}`·outFile 직접 존재 시 200. ✓
- **가산 보장**: calibrator 미주입 시 `/calibrate/status` **404** + `/setup/status` 200(기존 라우트 무영향). ✓
- writer 가 별도 outFile(임시 디렉터리)에 기록 → setup_artifact 미오염. ✓

### 2.6 계약 불변 — 통과
- 소스 diff: `server.ts(+12)·toolsConfig.ts(+34)·AgentRuntime.ts(+19)·SetupBrain.ts(+25)·index.ts(+5)` = **95 삽입 / 0 삭제(전부 가산)**. ✓
- `/calibrate/*` 등록은 `deps.calibrator && deps.calibrate` 주입 시에만 → 기존 `/setup`·`/capture`·`/mapping`·뷰어 라우트 불변. ✓
- 캘리브레이션 코드는 `repo.loadArtifact()`(읽기 전용)만 호출. `saveArtifact` 미호출 — setup_artifact·@parkagent/types 무변경, `slot_ptz.json` 별도 파일. ✓
- `clampZoom` 보존: `zoomCorrection`·`applyZoomAdvice` 가 `camera.clampZoom`(1~36) 경유. ✓
- 기존 50개 파일 / 331 테스트 회귀 0. ✓

---

## 3. 발견 결함 / 수정

- **구현 결함: 없음.** 모든 검증 항목 통과.
- **테스트 작성 결함: 없음.** 직접 수정한 테스트 없음.
- 참고(결함 아님): `data/setup_artifact.json` 이 git 상 수정 상태이나, 이는 **이전 capture 커밋의 산출물**(작업 시작 스냅샷에 이미 존재)이며 본 캘리브레이션 작업과 무관. 캘리브레이션은 이 파일을 읽기만 함(2.6 검증).
- 참고(설계 대비 차이, 정당): `estimateGain` 시그니처가 설계 표의 3인자 대신 **4번째 `fallback` 인자**를 받음 — fallback 게인을 설정에서 주입하는 합리적 구현(controlMath 순수성 유지). 설계 의도(분모≈0→fallback) 충족, 테스트로 검증됨.

---

## 4. 미커버 / 라이브 의존(본 단계 범위 외 — 명시)

모킹 검증의 한계로 **다음은 검증되지 않음**(삭제·통과 위장 없이 누락 명시):

1. **시뮬 실측 게인(미해결 D)**: pan↔X·tilt↔Y 실제 부호·스케일은 시뮬 라이브에서 probe 응답이 명령 PTZ 와 다른 화면을 실제로 보여줄 때만 검증 가능. 모킹은 규약·수렴 로직만 검증. **시뮬 라이브에서 probe 변위 관측 여부** 확인 필요.
2. **gemma 자문 신뢰도**: `adviseCentering` 실 LLM 응답 품질은 실 모델 호출 필요. 본 단계는 fake OpenAI 호환 서버로 파싱·클램프·폴백 경로만 검증.
3. **실 PTZ 단위(미해결 B)**: 본 기능은 시뮬 도(°) 단위 한정. 실 PTZ 매핑 미검증.
4. **브라우저 UI**: `web/{app.js(+72),index.html(+17)}` 캘리브레이션 버튼·폴링·결과 렌더는 정적 추가만 확인. 실제 브라우저 동작은 미검증(헤드리스 라우트 계약만 app.inject 로 검증).

---

## 5. 최종 판정

**합격.** 372/372 통과, 회귀 0, typecheck 무오류. ★명령추적·순서·폴백·라우트·계약 전부 검증. 재작업 불요. 라이브 의존 4건만 후속 스모크 대상으로 인계.
