# 01 설계서 — 주차면별 번호판 중심 정렬·줌 PTZ 캘리브레이션 → `slot_ptz.json`

작성: 설계자(architect) · 대상: SettingAgent (초기 데이터 셋팅용 캘리브레이션 기능)
근거 코드: `src/clients/{CameraClient,LpdClient}.ts`, `src/brain/AgentRuntime.ts`, `src/capture/{CaptureJob,floorRoi}.ts`, `src/api/{server,captureRoutes}.ts`, `src/store/Repository.ts`, `src/config/toolsConfig.ts`, `src/domain/{geometry,types}.ts`, `data/setup_artifact.json`, `web/app.js`
원칙: ParkSimMgr 컨벤션(ESM·1-based·정규화 0~1·외과적·단순함 우선). 과설계 금지. 라이브 기동은 구현 단계에서 하지 않음(검증=모킹).

---

## 0. 목표·확정 사실(설계 전제)

### 목표(마스터)
번호판 보유 슬롯마다(=`setup_artifact.slots[].plateRoiByPreset` 보유), 해당 `camIdx/presetIdx`에서 카메라 PTZ를 움직여:
1. **① pan/tilt 로 번호판 중심을 화면 중앙 `(0.5, 0.5)` 에 정렬** →
2. **② zoom 으로 번호판 가로폭이 화면의 `~0.2` 가 되도록 맞춤** →
3. 최종 PTZ·plateWidth·수렴여부 기록 → `data/slot_ptz.json` 저장.
- **순서 엄수: 먼저 pan/tilt(중심), 그다음 zoom(폭).**

### 확정 사실(코드/데이터 실측)
- **`setup_artifact.json` 은 읽기 전용 입력.** 현재 27 슬롯 중 **26 슬롯이 `plateRoiByPreset` 보유**. 슬롯당 키=`${camIdx}:${presetIdx}`(1-based, 예 `"1:1"`). 값=정규화 `NormalizedRect {x,y,w,h}`. → 캘리브레이션은 이 파일을 **수정하지 않는다**(계약 불변). 별도 산출물 `slot_ptz.json` 만 쓴다.
- **카메라 단위(시뮬)**: `CameraClient.move(camIdx, pan, tilt, zoom)` = `POST /req_move {cam_idx,pan,tilt,zoom}`. pan/tilt 는 **도(°) 절대값**, zoom 은 1~36 배율(`clampZoom` 내장, `zoomMin=1.0`·`zoomMax=36.0`). `requestImage(camIdx, presetIdx, {pan,tilt,zoom})` = `POST /req_img` → 프리셋 적용 후 캡처(`{pan,tilt,zoom,jpg,...}` 반환). **응답의 실제 PTZ 가 진실**(명령값이 아닌 `cap.pan/tilt/zoom` 을 상태로 사용).
- **LPD**: `LpdClient.detect(jpg) → PlateBox[]`(정규화 rect + confidence + cls). 0개·다수 가능. 재시도/타임아웃 내장.
- **LLM 두뇌**: `AgentRuntime`(OpenAI 호환). `llm.enabled=false` 면 모든 메서드 `null` → **결정형 폴백**. 좌표를 만들지 않고 "판정/제안"만(좌표 불변식). `chatJson`(zod parse·1회 재시도·실패 시 null) 패턴 재사용.
- **잡 패턴**: `CaptureJob` = 단일 인메모리 상태머신(`idle→running→stopping→done|stopped|error`), 중복 시작 거부, 타이머/`sleep`/`now` 주입(fake timers 테스트), `getStatus()` 진행 반환, 라우트는 얇은 진입점(`captureRoutes.ts`). 이 패턴을 그대로 차용.
- **영속화**: `Repository` 는 `setup_artifact.json` 전용. `slot_ptz.json` 은 **신규 writer**(별도 파일, Repository 미오염).
- **결정형 폴백 사례**: `capture/floorRoi.ts` = 외부 의존 0 순수 모듈(클램프/폴백). 동일 스타일로 `controlMath.ts` 작성.
- **회귀 기준선**: 현재 vitest **331개**(49 파일). 목표 회귀 0.

---

## 1. 제어 설계(핵심 — 반드시 구체화)

### 1.1 좌표·단위 규약(혼동 방지 — developer 필독)
- 번호판 중심 오프셋: 정규화 화면좌표. `errX = cx - 0.5`, `errY = cy - 0.5` (cx,cy = 번호판 rect 중심). **errX>0 = 번호판이 화면 오른쪽** / **errY>0 = 번호판이 화면 아래쪽**.
- pan/tilt 는 **도(°)**. "정규화 변위 1.0 당 몇 도 움직여야 하는가"를 **probe 로 추정한 게인** `gainPan`·`gainTilt`(°/정규화)로 환산.
- **pan↔X, tilt↔Y 의 부호는 시뮬 규약에 의존** → 하드코딩하지 않고 **probe 단계가 부호까지 포함해 게인을 측정**(아래 1.3). 이것이 FOV 불요·부호 무관 적응형 제어의 핵심.
- zoom 은 배율(1~36). 번호판 가로폭 `plateWidth`(정규화 w)와 선형 근사: 폭 ∝ zoom.

### 1.2 순수함수 분리(전부 `src/calibrate/controlMath.ts`, vitest 대상, 외부 의존 0)
| 함수 | 시그니처(개념) | 책임 |
|---|---|---|
| `plateCenterError(plate)` | `(rect) → {errX, errY}` | 중심 - 0.5 |
| `pickNearestPlate(plates, target)` | `(PlateBox[], NormalizedRect) → PlateBox \| null` | 다수 번호판 중 **대상 슬롯 `plateRoiByPreset` 중심에 가장 가까운** 1개 선택(중심 유클리드 거리 최소). 빈 배열 → null |
| `estimateGain(beforeErr, afterErr, probeDeltaDeg)` | `({errX,errY}, {errX,errY}, {dPan,dTilt}) → {gainPan, gainTilt}` | probe 이동 전후 변위로 °/정규화 게인 추정(부호 포함). 변위 미미(분모≈0)면 **fallback 게인**(설정값) 반환 |
| `panTiltCorrection(err, gain, curPan, curTilt, maxStepDeg)` | `→ {pan, tilt}` | P 제어: `newPan = curPan - errX*gainPan`(부호는 gain 에 흡수), 스텝 `maxStepDeg` 로 클램프 |
| `zoomCorrection(curZoom, plateWidth, targetWidth, clampZoom)` | `→ number` | `newZoom = clampZoom(curZoom * sqrt(targetWidth / plateWidth))`. plateWidth≈0 방어 |
| `isCentered(err, centerTol)` | `→ boolean` | `|errX|≤tol && |errY|≤tol` |
| `isWidthConverged(plateWidth, targetWidth, widthTol)` | `→ boolean` | `|plateWidth - targetWidth| ≤ widthTol` |
| `buildSlotPtzJson(items, now)` | `→ {createdAt, items}` | 최종 JSON 조립(아래 2장 스키마) |

> **게인 적응**: 1차는 "probe 1회로 게인 추정 후 그 게인으로 P 제어"(단순함 우선). 추가 적응(매 스텝 게인 재추정)은 **불안정·과복잡** → 범위 제외. 단, **수렴이 정체(개선 < ε)되면 게인을 절반으로 감쇠**해 진동 방지(controlMath 에 `dampGain(gain, factor)` 소함수 1개로 충분).

### 1.3 슬롯당 제어 루프(`PtzCalibrator.calibrateSlot`)
의사코드(상태=시뮬 응답의 실제 PTZ):

```
입력: {camIdx, presetIdx, slotId, globalIdx, plateRoi(목표 prior)}
1. cap0 = requestImage(cam, preset)                  // 프리셋 PTZ 로 시작(절대 기준)
   (pan,tilt,zoom) = cap0 의 실제 PTZ
2. plates = LPD.detect(cap0.jpg)
   plate = pickNearestPlate(plates, plateRoi)
   if !plate: 결과 기록 {centered:false, converged:false, reason:'no_plate'} 후 종료(스킵)

── A) pan/tilt 중심 정렬 ───────────────────────────
3. err = plateCenterError(plate)
4. [probe] 작은 dPan/dTilt(probeStepDeg) 1회 이동 → move → settle → 재캡처 → LPD → 재선택
      gain = estimateGain(err_before, err_after, {dPan,dTilt})
5. for iter in 1..maxIterations:
      if isCentered(err, centerTol): break
      (선택) LLM 자문: adviseCentering(image, err, target) → 제안 보정(검증·클램프)·없으면 게인 P제어
      {pan,tilt} = panTiltCorrection(err, gain, pan, tilt, maxStepDeg)
      move(cam, pan, tilt, zoom) → settle(settleMs)
      cap = requestImage(cam, preset, {pan,tilt,zoom})   // 실제 PTZ 재동기화
      (pan,tilt,zoom) = cap 의 실제 PTZ
      plates = LPD.detect(cap.jpg); plate = pickNearestPlate(plates, plateRoi)
      if !plate: break(가림/소실 — 마지막 상태 기록)
      newErr = plateCenterError(plate)
      if |newErr| 개선 < ε: gain = dampGain(gain)    // 진동 감쇠
      err = newErr
   centered = isCentered(err, centerTol)

── B) zoom 폭 정렬(중심 수렴 후에만) ────────────────
6. for iter in 1..maxIterations:
      plateWidth = plate.rect.w
      if isWidthConverged(plateWidth, targetWidth, widthTol): break
      newZoom = zoomCorrection(zoom, plateWidth, targetWidth, clampZoom)
      move(cam, pan, tilt, newZoom) → settle
      cap = requestImage(cam, preset, {pan,tilt,zoom:newZoom})
      (pan,tilt,zoom) = cap 의 실제 PTZ
      plates = LPD.detect(cap.jpg); plate = pickNearestPlate(plates, plateRoi)
      if !plate: break
      // zoom 으로 중심이 드리프트하면 1스텝 재중심(panTiltCorrection 1회)
      if !isCentered(plateCenterError(plate), centerTol):
          {pan,tilt} = panTiltCorrection(...); move; re-capture; re-detect
   converged = isWidthConverged(plate.rect.w, targetWidth, widthTol)

7. 결과 기록: {camIdx,presetIdx,slotId,globalIdx, ptz:{pan,tilt,zoom}, plateWidth, centered, converged}
```

- **하이브리드 결정**(마스터 확정 1): **결정형 적응형 비례제어가 엔진**(probe 게인 + P 제어 + zoom 공식). LLM 은 **자문**(초기 추정/수렴·가림 판단/제안 보정)만. **`llm.enabled=false` 또는 LLM 실패/검증실패 시 순수 결정형 폴백**(항상 동작). gemma 좌표 한계는 비례제어가 흡수.
- **대상**(마스터 확정 2): `plateRoiByPreset` 보유 슬롯 **전부**(현재 26). 미보유·미검출 슬롯은 결과에 `reason`과 함께 스킵 기록.
- **settle**: `move` 후 `settleMs`(설정, 예 300ms) 대기 → PTZ 정착 후 캡처. `sleep` 주입(테스트 fake).
- **상한**: 슬롯당 pan/tilt·zoom 각 `maxIterations`(예 15). 무한루프 방지.

---

## 2. 출력 스키마 — `data/slot_ptz.json`

```jsonc
{
  "createdAt": "ISO8601",
  "items": [
    {
      "camIdx": 1, "presetIdx": 1, "slotId": "c1p1s1", "globalIdx": 1,
      "ptz": { "pan": 12.3, "tilt": -4.5, "zoom": 8.2 },
      "plateWidth": 0.198,        // 최종 번호판 정규화 가로폭
      "centered": true,           // pan/tilt 중심 수렴 여부
      "converged": true,          // zoom 폭 수렴 여부
      "reason": "no_plate"        // (옵셔널) 스킵·미수렴 사유. 정상이면 생략
    }
  ]
}
```
- `globalIdx` 는 `setup_artifact.globalIndex` 에서 `slotId` 로 역참조(없으면 `null`).
- 슬롯이 여러 프리셋에 ROI 를 가지면 **(slotId, camIdx, presetIdx) 조합마다 1 항목**(plateRoiByPreset 키 단위로 펼침).
- 타입: `src/calibrate/types.ts` 에 `SlotPtzItem`·`SlotPtzArtifact` 정의(SettingAgent 로컬 — **`@parkagent/types` 가산 불필요**, 아래 영향도 참조).

---

## 3. API·UI

### 3.1 라우트(`src/api/calibrateRoutes.ts` 신규, `captureRoutes.ts` 패턴)
| 메서드·경로 | 동작 |
|---|---|
| `POST /calibrate/ptz` | 백그라운드 잡 시작. 본문 옵셔널 `{slotIds?: string[]}`(미지정=전체). running 중이면 **409**(중복 거부). 응답 `{ok:true, jobId/started:true, total}` |
| `GET /calibrate/status` | 진행 상태 `{state, done, total, current?:{slotId}, startedAt?, endedAt?}` |
| `GET /calibrate/result` | `slot_ptz.json` 내용 반환(없으면 404) |

- 헤드리스(`buildServer` 본체)에 등록 + 뷰어 컨텍스트(`/viewer/api/...` 불필요 — 뷰어는 동일 `/calibrate/*` 를 직접 폴링, app.js 가 절대경로 호출). **의존성 주입 시에만 등록**(가산, 기존 라우트 불변).
- 잡 의존성: `PtzCalibrator`(아래) + `repo`(setup_artifact 읽기) + writer. `index.ts` 에서 조립·주입.

### 3.2 잡 — `src/calibrate/PtzCalibrator.ts`
- `CaptureJob` 패턴 차용: 단일 인메모리 상태머신, 중복 거부, `start()/getStatus()`, 슬롯 순회를 비동기 루프로(타이머 대신 순차 await — 캘리브레이션은 주기 잡이 아님). 타이머 불필요, `sleep`(settle)·`now` 주입.
- 의존성: `{ camera: CameraClient, lpd: LpdClient, brain?: AgentRuntime, repo: Repository, writer, cfg: ToolsConfig['calibrate'], sleep?, now? }`.
- 흐름: setup_artifact 로드 → plateRoiByPreset 펼침 → (필터 slotIds) → 각 항목 `calibrateSlot` → 결과 수집 → `buildSlotPtzJson` → writer 저장. 개별 슬롯 실패는 **흡수**(경고 + reason 기록, 잡 중단 아님 — CaptureJob `captureTarget` 흡수 패턴).

### 3.3 LLM 자문 — `AgentRuntime` 가산(옵셔널)
- 신규 메서드 `adviseCentering(input): Promise<CenteringAdvice | null>`:
  - 입력: `{imageBase64, err:{errX,errY}, plateWidth, target:{centerTol, targetWidth}, phase:'center'|'zoom'}`.
  - 출력(zod): `{ suggestPan?, suggestTilt?, suggestZoomFactor?, converged?:boolean, occluded?:boolean }`(전부 옵셔널·작은 제안값). **좌표 생성 아님 — 보정 제안·판정만**.
  - `chatJson`(json 모드·1회 재시도·실패 null) 재사용. 인라인 한글 프롬프트(reviewCheckpoint 스타일, 단순함 우선).
  - 호출측(`PtzCalibrator`)이 **결정형 클램프**(제안 ±maxStepDeg, zoomFactor 0.5~2.0) 후 적용. `null`·검증실패 → 비례제어 폴백. `occluded=true` → 해당 슬롯 스킵·기록.

### 3.4 설정 — `tools.config.json` 신규 섹션 `calibrate`
`toolsConfig.ts` 에 `CalibrateSchema` 가산(기존 섹션 불변):
```
calibrate: {
  targetPlateWidth: 0.2,   // 목표 번호판 가로폭(정규화)
  centerTol: 0.03,         // 중심 수렴 허용오차
  widthTol: 0.02,          // 폭 수렴 허용오차
  maxIterations: 15,       // pan/tilt·zoom 각 단계 상한
  probeStepDeg: 1.0,       // 게인 추정용 probe 이동(도)
  maxStepDeg: 5.0,         // 1스텝 최대 보정(도, 진동 방지)
  fallbackGainPanDeg: 20,  // probe 실패 시 기본 게인(°/정규화)
  fallbackGainTiltDeg: 15,
  settleMs: 300,           // move 후 정착 대기
  outFile: "data/slot_ptz.json"
}
```
`DEFAULT_TOOLS_CONFIG.calibrate` 기본값 추가 + `loadToolsConfig` 섹션 병합 루프가 자동 처리(키가 `DEFAULT` 에 있으면 병합됨 — 추가 코드 불요).

### 3.5 뷰어 UI(최소)
- `web/index.html`: 분석 탭(또는 제어 패널)에 "PTZ 캘리브레이션" 영역 — **시작 버튼** + 진행 표시(`done/total`, current slot) + 결과 요약(수렴 N/전체, 미수렴 목록).
- `web/app.js`: `calStart()`(`POST /calibrate/ptz`) + `calPoll()`(`GET /calibrate/status` 폴링, 기존 `capPoll`/`pollPlan` 패턴 차용) + 완료 시 `GET /calibrate/result` 요약 렌더. 순수 폴링 판정이 필요하면 `web/core.js` 에 소함수 1개(`pollPlan` 유사) — 단, 1차는 capture 폴링 패턴 그대로 재사용해 신규 순수함수 최소화.

---

## 4. 작업 순서 + 단계별 검증

> 순수 로직(controlMath·types·buildSlotPtzJson) → 잡(PtzCalibrator, 클라이언트 모킹) → 라우트 → LLM 자문 → 설정 → 뷰어. 각 단계 vitest 통과를 게이트로.

**단계 1 — 순수 제어수학 + 타입** → 검증: `controlMath.test.ts`
- `src/calibrate/{controlMath,types}.ts` 작성(외부 의존 0).
- vitest: `plateCenterError`(중심→0,0; 우하단→양수), `pickNearestPlate`(다수 중 최근접·빈배열 null), `estimateGain`(probe 전후→부호 포함 게인; 분모≈0→fallback), `panTiltCorrection`(maxStep 클램프·부호), `zoomCorrection`(폭 0.4→축소·0.1→확대·clamp 1~36·0 방어), `isCentered`/`isWidthConverged` 경계, `dampGain`, `buildSlotPtzJson`(스키마·globalIdx 역참조 null).

**단계 2 — slot_ptz writer + setup_artifact 펼침** → 검증: `slotPtzWriter.test.ts`
- `src/calibrate/slotPtzWriter.ts`(파일 쓰기 — Repository 비오염) + `expandPlateTargets(artifact) → {camIdx,presetIdx,slotId,globalIdx,plateRoi}[]` 순수함수.
- vitest: 26 슬롯 fixture → 26 항목 펼침, plateRoiByPreset 다중 키 슬롯 펼침, globalIdx 매핑, 미보유 슬롯 제외. writer 는 임시 경로에 쓰고 재로드 일치.

**단계 3 — PtzCalibrator(클라이언트·LPD·brain 모킹)** → 검증: `ptzCalibrator.test.ts`
- `calibrateSlot` + 잡 상태머신 + 슬롯 순회.
- vitest(모킹 camera/lpd/brain, sleep/now 주입):
  - **수렴 happy path**: 모킹 LPD 가 move 에 따라 점점 중심·목표폭으로 수렴 → `centered:true, converged:true, plateWidth≈0.2`.
  - **순서 검증**: zoom 단계가 **중심 수렴 이후에만** 호출됨(move 호출 인자 시퀀스로 확인 — pan/tilt 변화가 zoom 변화보다 선행).
  - **번호판 미검출**: LPD 빈 배열 → 스킵·`reason:'no_plate'`, 잡 계속.
  - **maxIter 미수렴**: 절대 안 맞는 모킹 → `converged:false`, 루프 상한에서 종료.
  - **다수 번호판**: 대상 prior 최근접 선택.
  - **LLM off/실패**: brain=undefined·메서드 null → 결정형만으로 동작(폴백).
  - **중복 시작 거부**: running 중 start → throw/409.

**단계 4 — calibrateRoutes(app.inject)** → 검증: `calibrateRoutes.test.ts`
- `POST /calibrate/ptz`(시작·중복 409), `GET /calibrate/status`(진행 shape), `GET /calibrate/result`(있음 200·없음 404). 잡은 모킹(즉시완료 stub)으로 라우트 계약만.

**단계 5 — AgentRuntime.adviseCentering** → 검증: `agentRuntime.test.ts` 가산(기존 패턴)
- LLM off→null, 모킹 응답→zod parse·클램프 통과, 잘못된 JSON→재시도 후 null. (기존 `agentRuntime*.test.ts` 모킹 패턴 재사용.)

**단계 6 — 설정 스키마** → 검증: `config.test.ts` 가산
- `calibrate` 섹션 파싱·기본값·부분 병합. 기존 config 테스트 회귀 0.

**단계 7 — index.ts 조립 + 뷰어 UI** → 검증: 타입체크 + 기존 viewer 테스트 회귀 0 + 수동 확인은 구현 단계 외(모킹). 
- `index.ts` 에 `PtzCalibrator`·writer 조립·`buildServer` 주입. `web/{index.html,app.js}` 버튼·폴링.

**최종 게이트**: `npm test` 전체 → 신규 통과 + 기존 **331개 회귀 0**, `tsc` 무오류.

---

## 5. 파일별 신규/수정

### 신규(`src/calibrate/`)
- `controlMath.ts` — 순수 제어수학(1.2 표). 외부 의존 0.
- `types.ts` — `SlotPtzItem`, `SlotPtzArtifact`, `PlateTarget`, `CenteringAdvice`, `CalibrateStatus`.
- `PtzCalibrator.ts` — 잡(상태머신·슬롯순회·calibrateSlot). CaptureJob 패턴.
- `slotPtzWriter.ts` — `slot_ptz.json` 쓰기 + `expandPlateTargets`.

### 신규(`src/api/`)
- `calibrateRoutes.ts` — `/calibrate/*` 3개 라우트(captureRoutes 패턴).

### 수정(가산만)
- `src/brain/AgentRuntime.ts` — `adviseCentering` 메서드 + `SetupBrain.ts` 에 `CenteringAdviceSchema`·타입·인터페이스 가산.
- `src/config/toolsConfig.ts` — `CalibrateSchema` + `DEFAULT_TOOLS_CONFIG.calibrate` + `ToolsConfigSchema` 에 `calibrate` 추가.
- `config/tools.config.json` — `calibrate` 섹션(선택, 기본값으로 동작 가능).
- `src/api/server.ts` — `ApiDeps` 에 `calibrator?`·`calibrate?` 추가, 주입 시 `registerCalibrateRoutes` 호출(기존 라우트 불변).
- `src/index.ts` — `PtzCalibrator`·writer 조립·주입.
- `web/index.html`, `web/app.js`(, `web/app.css`) — 캘리브레이션 버튼·진행·결과(최소).

### 신규 테스트(`test/`)
- `controlMath.test.ts`, `slotPtzWriter.test.ts`, `ptzCalibrator.test.ts`, `calibrateRoutes.test.ts`. `agentRuntime`/`config` 테스트는 가산.

---

## 6. MCP 도구 vs LLM 두뇌 경계 판단

| 구분 | 결정형(엔진·도구) | LLM 두뇌(자문) |
|---|---|---|
| 역할 | probe 게인 추정, P 제어 pan/tilt, zoom 공식, 수렴판정, 최근접 번호판, JSON 조립 | 초기 추정/수렴·가림 판단/소폭 보정 제안 |
| 빈도 | 고빈도·수치반복 루프(슬롯×iter) → **반드시 결정형** | 슬롯당 소수회 자문(옵셔널) |
| 폴백 | 항상 동작(LLM 무관) | off/실패/검증실패 시 **결정형으로 강등** |

→ 마스터 "LLM 통해 처리" 요구를 **자문 계층**으로 충족하되, gemma 좌표 한계는 비례제어가 흡수. **새 MCP 도구 신설 불필요**(기존 REST 계약 `/req_move`·`/req_img`·LPD 재사용 + 신규 REST 라우트 가산).

---

## 7. 영향도 분석

- **`setup_artifact.json` 계약 불변**: 읽기 전용 입력. Action/DM 무영향. 새 산출물 `slot_ptz.json` 은 **별도 파일**(Repository·Finalizer 비오염).
- **`@parkagent/types` 가산 판단 → 불필요(1차)**: `slot_ptz.json` 은 SettingAgent 초기 셋팅 산출물. 현재 Action/DM 이 이 파일을 읽는 계약이 없음 → **로컬 타입(`src/calibrate/types.ts`)으로 충분**. 추후 ActionAgent 가 소비하면 그때 공유 타입 승격(과설계 회피). → **미해결 A**로 리더 확인.
- **기존 라우트·잡 불변**: `/setup/*`·`/capture/*`·`/mapping`·뷰어 라우트 가산만. `CaptureJob`·`Finalizer`·`Repository` 코드 불변(패턴만 차용).
- **회귀 0 목표**: 기존 **331 테스트** 통과 유지. 신규 라우트·설정 섹션은 주입/병합 가산이라 기존 경로 미변경.
- **CameraClient/LpdClient 불변**: 기존 시그니처 그대로 사용(수정 없음).

---

## 8. 리스크 · 완화

1. **gemma 자문 신뢰도 낮음**: 좌표/제안 부정확 → **결정형 비례제어가 주 엔진**, LLM 은 클램프된 소폭 제안만. 검증실패·null 즉시 폴백. (마스터 확정 1 그대로.)
2. **게인 적응 불안정(진동)**: probe 1회 추정 + `maxStepDeg` 클램프 + 개선 정체 시 `dampGain` 감쇠. 매 스텝 재추정은 범위 제외(단순함).
3. **번호판 가림·미검출 슬롯**: `pickNearestPlate` null → 스킵·`reason` 기록(잡 계속). zoom 단계 중 소실도 마지막 상태 기록.
4. **zoom→중심 드리프트**: zoom 루프 내 1스텝 재중심(B-6). 과보정 방지 위해 1회만.
5. **LLM/LPD 비용·시간**: 슬롯 26 × iter → LPD 다회 호출. `maxIterations` 상한·`settleMs` 합리값. LLM 자문은 옵셔널(off 시 비용 0).
6. **실제 PTZ 단위(실 PTZ)**: 본 기능은 **시뮬 `/req_move` 도 단위** 한정. 실 PTZ 게인/범위는 후속 과제(명시). → **미해결 B**.
7. **probe 의 파괴적 이동**: probe 가 화면 밖으로 밀어낼 수 있음 → `probeStepDeg` 작게(1°), probe 후 즉시 재검출로 게인만 취하고 본 제어로 복귀.
8. **응답 PTZ 신뢰**: 시뮬이 명령 PTZ 를 그대로 echo 하지 않을 수 있어 **항상 응답값으로 상태 재동기화**(명령값 사용 금지).

---

## 9. 미해결 / 가정(리더 확인 요청)

- **A. 출력 타입 위치**: `slot_ptz.json` 타입을 SettingAgent 로컬(`src/calibrate/types.ts`)로 둔다(1차 제안). ActionAgent 소비 계획이 확정되면 `@parkagent/types` 승격. 동의 확인.
- **B. 실 PTZ 단위**: 본 캘리브레이션은 **시뮬 도(°) 단위** 한정. 실 PTZ 매핑은 후속. 동의 확인.
- **C. LLM 자문 활성 기본값**: `llm.enabled` 전역값을 그대로 따른다(별도 토글 없음). 자문 전용 플래그가 필요하면 알려주세요(1차는 미추가, 단순함).
- **D. probe 부호 규약**: pan↔X·tilt↔Y 부호를 **probe 로 실측**(하드코딩 안 함). 만약 시뮬이 probe 응답 PTZ 를 echo 하지 않으면 게인 추정 불가 → fallback 게인 사용·경고. 라이브 확인은 구현 단계(모킹 검증 후).
- **E. 다중 프리셋 슬롯**: 한 slotId 가 여러 `plateRoiByPreset` 키를 가지면 **키마다 1 항목** 산출(가정). slot 단위 1개만 원하면 알려주세요.
