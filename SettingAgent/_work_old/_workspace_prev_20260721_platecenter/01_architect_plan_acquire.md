# 01 ARCHITECT — 센터라이징 검출확실성 재설계: 방안2(먼저 확대해 찾기·목표PTZ 직접산출) + 방안3(줌아웃 사다리 폴백)

> 입력: `_workspace/00_goal_acquire.md`(리더+마스터 확정) + `_workspace_prev_20260720_preaim/01`(이터1 pre-aim·저장3중) + 현 `_workspace/01_architect_plan.md`(이터2 소유권 peerOffsets) + 코드 재검증(PtzCalibrator/platePtz/controlMath/plateDiscovery/types/toolsConfig/테스트).
> 제약(불변·00_goal Requirements): 이터1~3 회귀0(저장3중·소유권게이트·타깃정렬·config노브) · 결정론(LLM 무) · 부분UPDATE · stringify5 · 외과적 최소 · **PlatePtz 폐루프 제어수식 무변경** · 소유권(peerOffsets) 전구간 유지 · 좌표계 일관(정규화 프레임).

---

## 0. 한줄결론 + 추천안

**현 `preaim(넓은시야)→center(넓은시야)→zoom` 을 `preaim(프리셋시야)→acquire(목표폭 근처로 줌인해 큰 판을 검출·센터)→width(20% 마감)` 로 재조립하고, acquire 지점서 미검이면 `줌아웃 사다리`로 재포착한다. 핵심 통찰 3가지로 최소침습이 성립한다: ① 목표 zoom 은 게인무관 직접산출(`Zt = presetZoom × targetWidth / lpdWidth`, 폭∝zoom) — 새 pure 함수 1개(controlMath.zoomForWidth). ② `centerOnPlate` 는 이미 "주어진 zoom 에서 검출+pan/tilt 센터"의 완성된 프리미티브다 — 넘기는 startPtz.zoom 만 넓은시야→acquire 줌으로 바꾸면 방안2가 사실상 공짜다. ③ 사다리는 폐루프가 아니라 "어느 zoom 을 시도할지"의 오케스트레이션 — `centerOnPlate` 를 감싸는 PtzCalibrator 의 얇은 재시도 루프이고, 성공 후 `zoomToPlateWidth`(무변경)가 드리프트가드 재중심을 포함해 Zt까지 마감한다. → PlatePtz 코어 무변경, 변경은 controlMath 신규함수 1개 + PtzCalibrator.calibrateSlot 재조립 + config 노브 3개.**

### 추천 판정 (goal 이 요구한 트레이드오프 2건)
- **점진 접근 채택(점프 기각)**: acquire 목표폭 = `cfg.acquirePlateWidth`(기본 0.12, < 목표 0.2)로 **바운드된 중간 zoom** 까지만 줌인한다. 이유: 실패근원 판폭 0.027 대비 0.12 는 이미 4.4배 — 검출 확실성은 0.2(full jump)와 사실상 동일한데, FOV 여유가 full-Zt 대비 크게 남아 조준오차 프레임이탈 리스크가 낮다(방안3 사다리 부담↓·시간↓). 마감 0.12→0.2 는 `zoomToPlateWidth` 가 드리프트가드로 안전 처리. **대안(full jump, acquirePlateWidth=targetWidth)** 은 §D-1 노브 한 값으로 즉시 전환 가능 — 라이브에서 중간 zoom 도 미검이면 점프로.
- **재조립 채택(새 메서드 기각)**: PlatePtz 에 `acquireAndCenter` 신설은 `centerOnPlate` 의 probe+P제어 폐루프를 복제(발산·중복). `centerOnPlate`(고정 zoom 검출·센터) + `zoomToPlateWidth`(드리프트가드 줌인) 두 프리미티브 조합이 정확히 acquire·마감을 표현한다. 사다리만 PtzCalibrator 재시도 루프로 추가.

### 코드 재검증으로 확정한 사실 (신뢰 + 검증)
1. **`centerOnPlate` = acquire 프리미티브**(platePtz.ts:201·234). zoom 은 `startPtz.zoom` 으로 **절대 고정**(계약, :234 주석). 초기검출→probe 게인실측→P제어 센터를 그 고정 zoom 에서 수행. 즉 startPtz.zoom 을 acquire 줌으로 주면 "큰 판을 그 줌에서 검출·센터"가 그대로 성립. **폐루프 본문 손댈 필요 0.**
2. **`zoomToPlateWidth` = 마감 프리미티브**(platePtz.ts:292·309~357). 가드선행(중심 tol 밖이면 그 반복은 줌 보류·1스텝 재중심) + `maxZoomStepRatio` 클램프로 **줌인 중 재중심을 이미 내장**. acquire 지점(zoom Zf)에서 호출하면 Zf→Zt 줌인+재중심을 안전 처리 → goal "재센터·재줌인"을 신규코드 없이 충족.
3. **게인무관 목표 zoom 직접산출 성립**. 폭∝zoom(controlMath.zoomCorrection 의 선형모델·platePtz 테스트 `w = w0·z/z0` 로 실증). `zoomCorrection` 은 sqrt **감쇠 스텝**(반복 안정용)이라 직접 목표산출과 다르다 → **신규 선형 pure 함수** 필요(`zoomForWidth = curZoom × targetWidth/curWidth`, clamp·0가드). PtzCalibrator 는 presetZoom(`startPtzFor`)·lpdWidth(`t.plateRoi.w`, 이미 quadBoundingRect rect) 둘 다 보유 → **카메라 추가호출 0**.
4. **소유권 좌표계 = acquire 재설계의 진짜 크럭스**. 이터2 는 `peerOffsets` 를 **상수**(원본 프리셋 프레임 오프셋)로 썼다 — 이는 `centerOnPlate` 가 프리셋 zoom 근처에서 돌 때만 정합(pan/tilt=강체평행이동, zoom 불변). acquire 는 **프리셋과 다른 큰 zoom** 에서 `centerOnPlate` 를 돌리므로, 화면상 이웃간격이 `zoom/presetZoom` 배로 확대된다 → 상수 오프셋은 팬텀 peer앵커를 화면중앙 근처에 찍어 **자기 판(중앙에서 벗어난)을 과기각**한다. **해법: peerOffsets 를 각 단계 호출 zoom 으로 스케일**(× zoom/presetZoom). `centerOnPlate` 는 zoom 고정이라 사전 정적 스케일이 그 호출 내내 정확 → **PlatePtz 무변경, PtzCalibrator 가 단계별 사전스케일**. (이터2 D-1 이 예견한 dynamic scaling 을 정적 사전스케일로 대체 — 코어 무접촉.)
5. **사다리의 역할 = 검출가능성(프레임이탈·판크기), 소유권 아님**. 스케일 오프셋 하에서 소유판정은 **zoom 불변**(dSelf<dPeer ⟺ residual_preset < offset_preset/2, 유도 §C). 즉 pre-aim 잔차가 이웃간격 절반 미만이면 검출되는 순간 소유확정. acquire 큰 zoom 에서 잔차×zoom 이 프레임을 벗어나면 **미검**(detect 후보없음) → 사다리 줌아웃으로 판을 프레임 안으로 되돌려 검출 → 그 지점서 `centerOnPlate` 가 자체 probe 로 게인 재측정·센터. **게인 부정확은 "잔차 확대→프레임이탈"로 나타나고 사다리가 이를 흡수**(goal 명제와 정합).

---

## A. 최소변경 파일 : 함수 시그니처 (구현자 전달)

### A-0. 설계선택지 → 추천 확정
| 축 | 선택지 | 판정 |
|---|---|---|
| acquire 도달 | ★**점진(acquirePlateWidth 0.12)** / full-jump(=target 0.2) | 점진 채택(FOV 여유·사다리부담↓). 노브로 점프 전환 |
| 구현 형태 | ★**재조립(centerOnPlate+zoomToPlateWidth 재사용)** / PlatePtz.acquireAndCenter 신설 | 재조립 채택(폐루프 복제 회피) |
| 소유권 좌표 | ★**단계별 정적 스케일(zoom/presetZoom)** / 상수(이터2) / PlatePtz 동적스케일 | 정적 스케일 채택(코어 무접촉·acquire 정합) |
| 목표zoom 위치 | ★**controlMath.zoomForWidth(신규 pure)** / PtzCalibrator private | controlMath(재사용·단위테스트 홈·기존함수 무변경) |

### A-1. `src/calibrate/controlMath.ts` — 신규 pure 함수 (기존 무변경)
- **신규** `export function zoomForWidth(curZoom: number, curWidth: number, targetWidth: number, clampZoom: (z: number) => number): number`
  - 반환 `curWidth <= GAIN_EPS ? clampZoom(curZoom) : clampZoom(curZoom * (targetWidth / curWidth))`.
  - 문서: "폭∝zoom 선형 **직접 목표**(게인무관). `zoomCorrection` 의 sqrt 는 반복 감쇠 스텝 — 이건 감쇠없는 1발 목표산출이라 별개 함수." curWidth≈0 가드, clamp 상한.
  - **게인 무의존 구조 보장**: 시그니처에 gain 없음(구조적).

### A-2. `src/calibrate/PtzCalibrator.ts` — calibrateSlot 재조립 + 헬퍼 3개
> 이 클래스 원칙(줄64~68): "제어 폐루프 미소유 — PlatePtz 위임, 잡은 오케스트레이션만". 사다리(어느 zoom 시도)·목표zoom 산출·오프셋 스케일은 전부 **오케스트레이션** → 여기 배치 정당. import 추가: `zoomForWidth` from `./controlMath.js`.

- **신규 상수(module-private)**: `ACQUIRE_PLATE_WIDTH_DEFAULT = 0.12`, `ACQUIRE_LADDER_STEP_DEFAULT = 1.5`, `ACQUIRE_LADDER_MAX_STEPS_DEFAULT = 5`. (cfg 미설정 폴백 — 기존 config 무파괴.)

- **신규 private** `computeAcquirePlan(t: PlateTarget, presetZoom: number): { targetZoom: number; acquireZoom: number }`
  - `const lpdWidth = t.plateRoi.w;` (plateRoi 는 이미 quadBoundingRect rect — 재계산 불요.)
  - `if (lpdWidth <= 1e-4) return { targetZoom: presetZoom, acquireZoom: presetZoom };` (퇴화 lpd → acquire 스킵=프리셋시야, 정직).
  - `const clamp = (z: number) => this.camera.clampZoom(z);`
  - `const targetZoom = zoomForWidth(presetZoom, lpdWidth, this.cfg.targetPlateWidth, clamp);`
  - `const aw = this.cfg.acquirePlateWidth ?? ACQUIRE_PLATE_WIDTH_DEFAULT;`
  - `const acquireZoom = Math.min(targetZoom, zoomForWidth(presetZoom, lpdWidth, aw, clamp));` (Za ≤ Zt — 목표 초과 금지.)

- **신규 private** `scalePeerOffsets(offsets: NormalizedPoint[], zoom: number, presetZoom: number): NormalizedPoint[]`
  - `const k = zoom / presetZoom;` (presetZoom ≥ 1 보장 — 0나눗셈 없음.)
  - `return offsets.map((o) => ({ x: o.x * k, y: o.y * k }));`
  - 문서: "원본 프레임 오프셋 → 현재 zoom 화면 오프셋(방사 ∝ zoom, predictCenterAfterZoom 모델과 정합). centerOnPlate 는 zoom 고정이라 이 정적 스케일이 호출 내내 정확. zoomToPlateWidth 는 시작 zoom 기준 스케일=줌인시 이웃이 더 멀어져 **보수적(안전)**."

- **신규 private** `acquireAndCenter(t, aim: Ptz, plan: {acquireZoom:number}, presetZoom: number, peerOffsets: NormalizedPoint[], base: PlatePtzOpts): Promise<PlatePtzResult>`
  - 사다리: `step = cfg.acquireLadderStep ?? DEFAULT`, `maxSteps = cfg.acquireLadderMaxSteps ?? DEFAULT`, **floor = presetZoom**.
  - `let zoom = plan.acquireZoom; let last: PlatePtzResult | undefined;`
  - 루프 `for (let i = 0; i <= maxSteps; i++)`:
    - `const rungZoom = Math.max(zoom, presetZoom);` (floor 클램프)
    - `const scaled = this.scalePeerOffsets(peerOffsets, rungZoom, presetZoom);`
    - `const opts = { ...base, ...(scaled.length ? { peerOffsets: scaled } : {}) };`
    - `const c = await this.makePlatePtz(opts).centerOnPlate(t.camIdx, t.presetIdx, { pan: aim.pan, tilt: aim.tilt, zoom: rungZoom });`
    - `last = c; if (c.ok) return c;`  (성공 rung 확정)
    - **로그(신규·cat:centering·phase:'acquire')**: `{cam,preset,slot,rung:i,rungZoom,reason:c.reason}` — acquire 경로 라이브 관측용.
    - `if (rungZoom <= presetZoom) break;`  (floor 도달 → 더 낮출 곳 없음)
    - `zoom = rungZoom / step;`
  - `return last!;`  (전 rung 실패 → 마지막 실패결과=skipItem 재료)
  - **주의**: 성공 rung 은 `!c.ok` 뿐 아니라 `no_plate`/`plate_lost`/`max_iterations` 어느 실패든 다음(더 낮은) rung 시도. 실패 rung 은 초기검출 1캡처만 소비(즉시 return, 저비용).

- **수정** `calibrateSlot(t: PlateTarget, peerOffsets: NormalizedPoint[])`(현 216~247) 재조립:
  1. `const baseStart = await this.startPtzFor(t);` `const presetZoom = baseStart.zoom;`
  2. `const plan = this.computeAcquirePlan(t, presetZoom);`
  3. `const aim = this.preAimPtz(t, baseStart);` — **pre-aim 을 프리셋 zoom 기준으로**(plateRoi 가 측정된 프레임과 게인스케일 일치). 기존 `wideBase`(centerZoom override) 제거.
  4. `const base = this.baseOpts();`
  5. `const c = await this.acquireAndCenter(t, aim, plan, presetZoom, peerOffsets, base);`
  6. `if (!c.ok || !c.plate) return this.skipItem(t, c.ptz, c.plateWidth ?? 0, c.reason);`
  7. `const z = await this.makePlatePtz({ ...base, plateRoi: quadBoundingRect(c.plate.quad), gain: c.gain, ...(this.scalePeerOffsets(peerOffsets, c.ptz.zoom, presetZoom) 를 조건부 peerOffsets 로) }).zoomToPlateWidth(t.camIdx, t.presetIdx, c.ptz);` — **마감 소유권도 c.ptz.zoom 스케일**.
  8. return item(현 236~246 구조 그대로 — centered/converged/reason 매핑 무변경).
  - **preAimPtz·startPtzFor·peerOffsetsFor·saveCenteringSlots·saveSetupSnapshot·run·notifyFinished·baseOpts·skipItem 무변경**(이터1~2 회귀0). `run` 의 byPreset 그룹핑·peerOffsetsFor 주입 경로 그대로.

- **`preAimPtz`(275~284) 무변경**: 이미 `base.zoom` 기준 게인스케일. 호출을 `baseStart`(=presetZoom)로만 바꿈 → **centerZoom 미설정 기본에서 기존 동작과 동일**(baseStart.zoom==presetZoom). centerZoom 설정 시에만 달라짐(§D-4).

### A-3. `src/config/toolsConfig.ts` — CalibrateSchema 노브 3개 (전부 optional·기존 config 무파괴)
- `acquirePlateWidth: z.number().min(0).max(1).optional()` — acquire 시작줌이 겨눌 판폭(기본 0.12). "먼저 확대해 찾기"의 확대 정도. 0.2 로 두면 full-jump.
- `acquireLadderStep: z.number().min(1).max(3).optional()` — 사다리 줌아웃 1스텝 배율(기본 1.5).
- `acquireLadderMaxSteps: z.number().int().nonnegative().optional()` — 사다리 최대 rung(기본 5). 0 이면 사다리 없음(acquire 1발만).
- DEFAULT_TOOLS_CONFIG.calibrate 에 값 미추가(코드 폴백이 담당 — 기존 default 객체 최소변경). 필요 시 문서에 튜닝값 명시.

### A-4. PlatePtz.ts / slotPtzWriter.ts / plateDiscovery.ts — **무변경**
- PlatePtz: `peerOffsets` opt·`captureAndDetect` 선정분기·`pickOwnedByOffsets`·폐루프·`zoomForWidth` 미사용 — **전부 그대로**. 스케일은 호출측(PtzCalibrator)이 사전 처리.
- slotPtzWriter: `expandPlateTargetsFromSlotSetup` 정렬·plateRoi 유래 무변경.
- plateDiscovery(pickOwnedPlate): 무변경(참고자산 — 디지털 크롭줌은 무이동, 물리 사다리와 별개).

### 변경 요약
| 파일 | 함수 | 변경 | 성격 |
|---|---|---|---|
| controlMath.ts | (신규)`zoomForWidth` | 게인무관 목표zoom 직접산출 | 순수 |
| PtzCalibrator.ts | (신규)`computeAcquirePlan` | Zt·Za 산출 | 순수 |
| PtzCalibrator.ts | (신규)`scalePeerOffsets` | 오프셋 zoom 스케일 | 순수 |
| PtzCalibrator.ts | (신규)`acquireAndCenter` | 줌아웃 사다리 재시도 | 오케스트레이션 |
| PtzCalibrator.ts | `calibrateSlot` | acquire→center→width 재조립 | 배선 |
| toolsConfig.ts | CalibrateSchema | 노브 3개(optional) | 스키마 가산 |
| **platePtz.ts** | — | **무변경**(코어 무접촉) | — |

---

## B. 검증 기준

### B-1. controlMath.zoomForWidth (controlMath.test.ts — pure)
1. `zoomForWidth(1.69341, 0.0274, 0.2, id) ≈ 12.36`(=1.69×0.2/0.0274). `targetWidth=0.12 → ≈5.41`. **폭∝zoom 직접 목표 확인**.
2. `curWidth<=1e-4 → clampZoom(curZoom)` 반환(0가드).
3. clamp 상한: 초소 lpd(0.005) → 산출 zoom > 36 → clampZoom 로 36. (clampZoom=Math.min(36,max(1,·)).)
4. **게인무관 구조**: 동일 (curZoom,curWidth,targetWidth) 는 어떤 게인 입력과도 무관(시그니처에 gain 부재)로 확정.

### B-2. acquire 계획·사다리·소유권 스케일 (ptzCalibrator.test.ts — makePlatePtz 스텁이 opts+centerOnPlate startPtz 캡처)
> 스텁은 rung 별 centerOnPlate 호출을 배열로 캡처(startPtz.zoom·opts.peerOffsets), 지정 시나리오 결과 반환. presetZoom 은 기존 테스트대로 fallback(resolvePresetPtz null→{0,0,1}) → presetZoom=1 → 산출 검증 용이.
5. **acquire 우선(줌인 먼저)**: 첫 centerOnPlate 의 `startPtz.zoom == acquireZoom`(= 1×acquirePlateWidth/lpdWidth). 넓은시야(1)·프리셋(1) 아님. lpdWidth=0.05·기본0.12 → **Za=2.4**. `startPtz.{pan,tilt}==preAimPtz` 결과.
6. **Za≤Zt**: 산출 acquireZoom ≤ targetZoom(=1×0.2/0.05=4.0). 마감 zoomToPlateWidth 가 Zt 방향 줌인.
7. **사다리 폴백(재포착)**: 스텁이 zoom≥임계 rung 은 `{ok:false,reason:'no_plate'}`, 하위 rung 에서 `{ok:true, plate, gain, ptz:{...,zoom:rung}}` → calibrateSlot 이 **감소 zoom 수열**(Za, Za/1.5, …)로 재시도 후 하위 rung 성공, 최종 item.centered=true. 캡처된 rung zoom 수열이 단조감소·floor(presetZoom) 이상.
8. **사다리 소진**: 스텁 전 rung `{ok:false}` → item.centered=false·reason 전파, centerOnPlate 호출 ≤ maxSteps+1 회, **어떤 rung 도 presetZoom 미만 아님**(floor 보장).
9. **소유권 전구간 유지 + 스케일**: 다슬롯(peerOffsets 존재)일 때 성공 rung 의 `opts.peerOffsets == presetOffsets × (rungZoom/presetZoom)`(요소별 근사). zoomToPlateWidth 의 `opts.peerOffsets == presetOffsets × (c.ptz.zoom/presetZoom)`. 단일슬롯(peerOffsets=[]) → 스케일 후에도 `[]`(=최근접, 무해).
10. **마감 목표폭**: 스텁 체이닝(acquire ok → zoomToPlateWidth ok, plateWidth 0.2) → 최종 item plateWidth≈0.2·converged=true.

### B-3. end-to-end 해피패스 (기존 mock 모델 스타일 — 회귀 겸 신경로 실증)
11. 기존 `PtzCalibrator 수렴 happy path`: 신경로(Za=2.4 검출→center→2.4→4.0 width)로도 centered·converged·plateWidth≈0.2 유지(기존 mock 은 항상 검출 → 통과). **단 아래 B-4 order 테스트는 개정 필요**.

### B-4. 이터1~3 회귀 (기존 스위트 green — 회귀0)
12. **platePtz.test.ts 전 21블록 무수정 green**: PlatePtz 코어 **무변경** → 바이트 동치. (소유권·probe·zoom·게인·OBB폭 전부.)
13. **ptzCalibrator.test.ts 개정 1건(의도된 변경)**: `PtzCalibrator 순서(중심→줌)` 테스트의 전제("zoom 변화는 중심 수렴 이후")는 **이번 재설계로 반전**(줌인이 센터보다 먼저 = 방안2 핵심). → 신 계약으로 개정: "첫 명령이 acquireZoom(>presetZoom)으로 줌인, 이후 pan/tilt 센터, 이후 width 가 Zt 방향." **나머지 블록(happy·no_plate·maxIter·multi-plate·saveCentering·onFinished·dup-start)은 무수정 통과** 확인(재검증: empty→전 rung no_plate→skip no_plate ✓ / stuck→전 rung 미수렴→centered false ✓ / noise→최근접 self ✓).
14. **저장3중·정렬·게이트 회귀0**: `saveCenteringSlots`·`expandPlateTargetsFromSlotSetup`·`saveSetupSnapshot` 무변경 → 관련 테스트 green.
15. `npx tsc --noEmit` exit 0.

### B-5. 라이브 검증 (시뮬 13110 — 리더 주도, 은닉 금지)
- `POST /calibrate/ptz` → `cat:centering` 로그: **acquire 경로 관측**(Zt·Za 산출값, 각 사다리 rung+검출결과, 선정 rung zoom, phase:'acquire'→'center'→'zoom' 전이).
- **converged 수 ↑**: 이전 10/17 크게 상회(goal 1). no_plate/plate_lost 대폭 감소.
- **최종폭 0.2±widthTol**: 완주 슬롯 plateWidth ≈ 0.2(goal 4).
- **틀어짐 재분석 트리거**: 중간 zoom 도 미검(사다리 소진 다수) → acquirePlateWidth↑(점프쪽) 또는 사다리 maxSteps↑·step 완화. 과줌 프레임이탈 빈발 → acquirePlateWidth↓(FOV 여유↑).
- **한계(이월)**: fallback 게인 −62/−35.5=cam1 특화 → 실 Hucoms·타 카메라 pre-aim/probe 정확도 미검증. 방안3 사다리가 프레임이탈은 흡수하나 게인 대오차(잔차>이웃간격 절반)의 오귀속 한계(§C)는 라이브 실측 필요.

---

## C. 회귀 / 리스크

- **[핵심] 소유권 좌표 정합(스케일)**: `dSelf<dPeer ⟺ residual_preset<offset_preset/2` (유도: 화면프레임에서 dSelf=residual_preset·z/pz, peerAnchor 를 offset_preset·z/pz 로 스케일 → dPeer=|residual−offset|_preset·z/pz → z 소거). **소유판정은 zoom 불변**. 귀결: ① 잔차<간격절반이면 검출즉시 소유확정(사다리는 프레임이탈만 흡수). ② 잔차>간격절반(게인 대오차)이면 **어느 zoom 서도 미소유→정직 no_plate**(고립 판도 기각 가능) — 오귀속(이웃 latch)보다 안전하나 개선 상한을 만든다. cam1 fallback 이 대체로 정확하다는 goal 전제 하에 대다수 슬롯 잔차<절반 → 소유. **라이브 확증 필요**.
- **과줌·좁은FOV 프레임이탈**: acquire 큰 zoom 에서 잔차×zoom 이 프레임 초과 → 미검. **완화=점진 acquirePlateWidth(FOV 여유) + 사다리 줌아웃**. 잔여 리스크: pre-aim 이 **이웃 판을 중앙에** 두는 대오차(잔차≈이웃간격 1개≈게인 ~100% 오차) 시 사다리·소유권 모두 이웃을 self 로 오인 — 극단적, 발생희박, 리스크로 명시.
- **시간**: 슬롯당 acquire 1발+마감. 사다리 실패 rung=초기검출 1캡처(즉시 return, settleMs 1회)로 저비용. 최악 (maxSteps+1)캡처 후 센터. 17슬롯×(사다리≤5 + center + width). maxSteps 작게(5) 바운드. 총시간 증가는 유한·관측(로그)로 확인.
- **게인**: pre-aim·centerOnPlate probe 는 여전히 게인 의존(fallback cam1). 사다리는 프레임이탈(게인→잔차확대) 흡수, 프레임 재진입 후 centerOnPlate probe 가 게인 재측정·센터(자기교정). 비-cam1 미검증(이월).
- **clampZoom 상한**: 초소 lpd → Zt>36 clamp → 목표폭 0.2 미달 시 `zoomToPlateWidth` 가 `zoom_saturated`(정직). 위장수렴 없음.
- **회귀 경계**: PlatePtz·controlMath 기존함수·slotPtzWriter·plateDiscovery·VPD·Finalizer·라우트 **무접촉**. 신규 config 3개 optional → 기존 config 파싱 무파괴. order 테스트 개정은 **의도된 계약변경**(회귀 아님).
- **성능(계산)**: computeAcquirePlan·scalePeerOffsets = 슬롯당 순수계산(카메라 호출 0 추가).

---

## D. 미해결 / 가정 (리더 확인 요청)

- **D-1 (acquirePlateWidth 기본, 가정=0.12 점진)**: 점진(0.12) 추천 — FOV 여유·사다리부담↓. 라이브에서 중간 zoom 미검이 잦으면 0.2(full jump)로. **노브 한 값 전환**. 확정 요청.
- **D-2 (사다리 step/maxSteps/floor, 가정=1.5/5/presetZoom)**: 라이브 튜닝. floor=presetZoom(그 아래는 실패근원 판크기라 무의미). step 완화(1.3)=촘촘·느림, 강화(2.0)=성김·빠름.
- **D-3 (오프셋 스케일, 가정=단계별 정적 사전스케일)**: centerOnPlate 는 zoom 고정이라 정적 정확, zoomToPlateWidth 는 시작zoom 기준=보수적(안전). 대안(PlatePtz 내 dynamic scaling)은 코어 침습 → 기각. 라이브서 마감 중 이웃 유입 관측되면 재고.
- **D-4 (centerZoom 초과, 가정=supersede·유지)**: 재설계 acquire 흐름은 `centerZoom` 미사용(pre-aim 은 presetZoom 기준). config 필드는 **제거 않고 유지**(back-compat) — 문서에 "acquire 재설계로 대체됨" 명시. 제거 원하면 별도 요청. (ladder floor 로 재활용안도 있으나 의미 과적재 회피 위해 미채택.)
- **D-5 (전제)**: slot_setup.lpd 채워진 슬롯만 target(expandPlateTargetsFromSlotSetup) — auto-chain(discovery→calibrate) 충족. 수동 단독은 사전 discovery 전제(기존과 동일). t.plateRoi 는 원본 프리셋 프레임(pre-aim/스케일 프레임 기준점).
- **D-6 (라이브 확증 이월)**: converged↑·폭0.2·acquire경로·게인오귀속 상한은 시뮬 13110 실측으로 최종 확인(결정형 확정분 B-1~B-4 와 분리 보고, 위장금지).

---

## 구현 순서 (검증 첨부)
1. controlMath.ts `zoomForWidth` 추가 → **검증**: B-1.1~4.
2. toolsConfig.ts CalibrateSchema 노브 3개(optional) → **검증**: 기존 config 파싱 green·tsc.
3. PtzCalibrator.ts `computeAcquirePlan`·`scalePeerOffsets` 추가 → **검증**: 순수 산출·스케일 단위(B-2.5·6·9 부분).
4. PtzCalibrator.ts `acquireAndCenter`(사다리) + `calibrateSlot` 재조립 + acquire 로그 → **검증**: B-2.7·8·10, B-3.11.
5. ptzCalibrator.test.ts order 테스트 개정 + 나머지 회귀 확인 → **검증**: B-4.12~15.
6. 라이브(B-5)는 리더 주도 실측·튜닝, 한계 명시로 종결.
