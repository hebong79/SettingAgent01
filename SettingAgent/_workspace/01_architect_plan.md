# 01 ARCHITECT — 센터라이징 근본재설계: lpd 신원 기반 배타성 게이트 (이터레이션 2)

> 입력: `_workspace/00_goal.md`(리더+마스터 확정 근본원인) + `_workspace_prev_20260720_preaim/`(이터1: preAimPtz·저장3중, **이미 적용됨**) + 코드 재검증.
> 제약(불변·Requirements): VPD off · 결정론(LLM 무) · 부분 UPDATE(slot_setup wipe 금지) · stringify5/round5 · 외과적 최소 · **폐루프 제어수식(gain/predict/zoom/probe/panTilt) 무접촉 — 선정 로직에만 소유권**. 이터1 성과(저장3중·pre-aim·정렬) 회귀 0.

---

## 0. 한줄결론 + 추천안

**센터링 재검출 대상선정을 "화면중앙 최근접(`pickNearestPlate`)" → "자기 슬롯 lpd 소유권(`pickOwnedPlate`)" 으로 전환한다. 좌표계 문제는 절대 PTZ·게인 변환을 도입하지 않고, "peer 앵커를 자기 앵커 기준 상대 오프셋으로 표현"해 회피한다 — 센터링은 zoom 을 고정하므로 pan/tilt 이동은 정규화 프레임의 강체 평행이동이고, 강체 평행이동은 Voronoi 소유권을 보존하기 때문(오프셋은 프레임 불변). `PlatePtz` 에 `peerOffsets` 데이터 opt 하나를 추가해 `captureAndDetect` 의 선정 한 줄만 소유권으로 갈아끼우고(검증된 `pickOwnedPlate` 재사용), `PtzCalibrator` 는 프리셋별 그룹핑으로 각 슬롯의 peer 오프셋을 산출·주입한다. 제어 폐루프는 무접촉. 이웃 판은 소유권에서 기각 → latch 불가.**

추천안 = **설계선택지 (i)의 정련형(데이터 주입)**. (ii)·순수 절대좌표 (i) 는 아래 §A-0 에서 기각.

### 코드 재검증으로 확정한 사실(신뢰+검증)
1. **결함 위치 확정**: `PlatePtz.captureAndDetect`(platePtz.ts:383~399) 가 매 프레임 `pickNearestPlate(plates, prior)` 로 "prior 최근접" 을 고른다. prior 는 예측추적(§2.5)으로 자기 판을 좇지만, **prior 오차 > 판 간격 절반(0.075)** 이면 최근접이 이웃으로 갈아탄다(latch). lpd 신원이 "초기 힌트"일 뿐 "수렴 대상"이 아니라는 00_goal 진단과 일치.
2. **검증된 재사용 자산 확인**: `plateDiscovery.pickOwnedPlate(candidates, selfAnchor, peerAnchors)`(plateDiscovery.ts:79~99) = 자기 앵커가 **모든** peer 앵커보다 **엄격히**(strict `<`) 최근접인 후보만 자기 소유로 남기고 그 중 최근접 1개 반환. 동률 기각·중복청구 불가·결정적. `peerAnchors=[]` 면 전원 통과=최근접(하위호환). 이미 `plateDiscovery.test.ts` 로 검증됨.
3. **좌표계 크럭스(설계 최대 난점) 실증**: `pickOwnedPlate` 규약은 "비교 좌표계=항상 원본 프레임 정규화". 그런데 `PlatePtz` 는 카메라가 **물리적으로 pan/tilt/zoom 이동**하는 현재 프레임에서 검출한다 — lpd 앵커(DB cx=0.325/0.464/0.62)는 **원본 프리셋 프레임** 좌표라 현재 프레임 검출과 직접 비교 불가. PlateDiscovery 는 카메라 무이동(디지털 크롭)이라 아핀 역계산으로 원본 좌표를 복원해 이 문제가 없었다. **본 설계의 핵심 판단**: 절대 PTZ→원본 프레임 역변환(게인 의존, 비-cam1 부정확)을 도입하는 대신, **상대 오프셋 불변성**으로 우회한다(§A-1 근거).
4. **grouping 패턴 존재**: `PlateDiscoveryJob.run`(PlateDiscoveryJob.ts:142~158)이 이미 `byPreset` Map 으로 프리셋별 그룹핑 → 자기 제외 peer 앵커 산출. `PtzCalibrator.run` 에 동일 패턴 이식.
5. **pre-aim 은 유지**(제거·대체 아님) — 역할만 재정의(§3). 소유권은 **정확성**(이웃 latch 불가)을 보증하고, pre-aim 은 **가용성**(자기 판을 FOV·중앙 근처로 끌어와 소유 후보로 검출되게)을 담당. 상보적.

---

## A. 최소변경 파일 : 함수 시그니처 (구현자 전달)

### A-0. 설계선택지 비교 → 추천 확정

| 선택지 | 코어 침습 | 좌표 정합성 | 판정 |
|---|---|---|---|
| **(i)-절대좌표**: PlatePtz 에 `selfAnchor/peerAnchors`(원본 프레임 절대점) 주입 → captureAndDetect 가 현재 검출을 원본 프레임으로 역변환 후 pickOwnedPlate | 중(역변환 로직) | **낮음** — 역변환이 base PTZ·축별 게인에 의존. 비-cam1 게인 부정확 시 신원 오판. 이터1 게인 리스크를 선정까지 전염 | ✗ 기각 |
| **(i)-정련(데이터·상대오프셋)** ★추천 | **최소**(선정 1분기 + opt 1개) | **높음** — pan/tilt=강체평행이동이 소유권 보존, 오프셋 프레임불변. 게인 무의존 | ✔ **채택** |
| **(ii)-얇은 래퍼**: PlatePtz 불변, PtzCalibrator 가 선정만 감쌈 | (불가) | — | ✗ 기각 |

- **(ii) 기각 사유**: 대상선정(`captureAndDetect`)은 `PlatePtz` **private 폐루프 내부**에서 매 프레임 일어난다. 외부 래퍼가 이를 가로채려면 폐루프 자체를 재구현해야 하고(중복·발산, "PlatePtz 가 폐루프 소유" 원칙 위반) → (i)보다 **더** 침습적. 선정 주입점은 반드시 PlatePtz 내부여야 한다.
- **(i)-정련 채택 근거(좌표 우회의 수학)**: 센터링(`centerOnPlate`)은 **zoom 을 절대 안 바꾼다**(platePtz.ts:226 계약). 정규화 프레임에서 pan/tilt 이동은 근사적 **강체 평행이동**이다. 강체 평행이동은 모든 점을 같은 벡터로 옮기므로 **최근접(Voronoi) 소유권을 보존**한다 — 검출 후보·자기 기준점·peer 기준점을 **같은 현재 프레임**에서 일관 비교하면 결과가 원본 프레임 비교와 동일. 자기 기준점은 PlatePtz 가 이미 추적하는 `prior`(예측 자기중심)를 쓰고, peer 기준점 = `prior + (peerAnchor − selfAnchor)`. 괄호 안 **오프셋은 원본 프레임에서 1회 산출하는 상수이며 평행이동 불변**. → 절대 PTZ·게인 불필요.

### A-1. `src/calibrate/platePtz.ts` (코어 — 선정만)
- **`PlatePtzOpts` 에 옵셔널 필드 추가**: `peerOffsets?: NormalizedPoint[]`
  - 문서: "같은 프리셋 타 슬롯 판중심 − 자기 판중심(원본 정규화 프레임 상대 오프셋). pan/tilt 강체평행이동 불변. 미전달 → 기존 최근접(하위호환)." `NormalizedPoint`= `{x,y}`(domain/types).
- **`ResolvedOpts` + 생성자**: `gain` 과 동일한 조건부 스프레드 패턴으로 `peerOffsets` 보존 — `...(opts.peerOffsets ? { peerOffsets: opts.peerOffsets } : {})`.
- **`captureAndDetect`(383~399) 선정 한 줄 교체** — 폐루프·radius 게이트 나머지 전부 불변:
  - 현행: `const picked = pickNearestPlate(plates, prior);`
  - 신규:
    ```
    const picked = this.opts.peerOffsets
      ? pickOwnedByOffsets(plates, prior, this.opts.peerOffsets)   // 소유권 선정
      : pickNearestPlate(plates, prior);                          // 기존(하위호환)
    ```
  - `if (!picked || radius === null) return picked;` 이하 **radius 게이트 무변경**(소유권=이웃기각, radius=자기 진짜소실 — 상보 유지).
- **신규 module-private 헬퍼** `pickOwnedByOffsets(plates, prior, offsets)`:
  - `selfRef = { x: prior.x + prior.w/2, y: prior.y + prior.h/2 }` (점 형태 `{x,y}`).
  - `cands = plates.map(p => ({ plate: p, centerOrig: <{x,y} of quadBoundingRect(p.quad)> }))`.
  - `peerAnchors = offsets.map(o => ({ x: selfRef.x + o.x, y: selfRef.y + o.y }))`.
  - `return pickOwnedPlate(cands, selfRef, peerAnchors);` (검증된 함수 그대로).
  - **★ 점 형태 주의(잠복버그 차단)**: `pickOwnedPlate` 는 `NormalizedPoint{x,y}` 를, platePtz 내부 `Center` 는 `{cx,cy}` 를 쓴다. 이 헬퍼는 반드시 `{x,y}` 로 만든다(혼용 금지).
- **import 추가**: `pickOwnedPlate` from `./plateDiscovery.js`. (순환참조 없음 — plateDiscovery 는 platePtz 를 import 하지 않음. 확인함.) `NormalizedPoint` from `../domain/types.js`.

### A-2. `src/calibrate/PtzCalibrator.ts` (peer 오프셋 산출·주입)
- **`run(targets)`(138~165) 루프 진입 전 프리셋별 그룹핑 추가**(PlateDiscoveryJob.run 패턴 이식):
  - `const byPreset = new Map<string, PlateTarget[]>();` 로 `${t.camIdx}:${t.presetIdx}` 그룹핑.
- **신규 private** `peerOffsetsFor(t: PlateTarget, group: PlateTarget[]): NormalizedPoint[]`:
  - `const s = center(t.plateRoi);` (center→`{cx,cy}`)
  - `return group.filter(p => p.slotId !== t.slotId).map(p => { const c = center(p.plateRoi); return { x: c.cx - s.cx, y: c.cy - s.cy }; });`
  - 같은 (cam,preset) 자기제외 타 슬롯의 판중심 상대오프셋. 좌표계=원본 정규화 일관(`plateRoi`=slot_setup.lpd 유래, 전부 원본 프레임).
- **`calibrateSlot(t)` → `calibrateSlot(t, peerOffsets)`**: run 이 `peerOffsetsFor` 결과를 넘김. **두 makePlatePtz 호출 모두**에 주입:
  - centerOnPlate 인스턴스: `this.makePlatePtz({ ...base, peerOffsets })`
  - zoomToPlateWidth 인스턴스: `this.makePlatePtz({ ...base, plateRoi: quadBoundingRect(c.plate.quad), gain: c.gain, peerOffsets })` — **줌 단계도 동일 소유권 게이트**(zoom-in 중 이웃 유입 차단, 00_goal 요구 5).
  - **preAimPtz·startPtzFor·saveCenteringSlots·saveSetupSnapshot·run 의 저장/스냅샷/콜백 경로는 전부 무변경**(이터1 회귀 0).
- 단일슬롯 프리셋 → `peerOffsets=[]` → `pickOwnedPlate(..., [])` = 최근접(무해·동작 동일). 특수분기 불요.

### 변경 요약(무엇을/어디에)
| 파일 | 함수 | 변경 | 성격 |
|---|---|---|---|
| platePtz.ts | `PlatePtzOpts`/`ResolvedOpts`/ctor | `peerOffsets?` 옵트 가산 | 데이터 |
| platePtz.ts | `captureAndDetect` | 선정 1분기(소유권 vs 최근접) | **선정만** |
| platePtz.ts | (신규)`pickOwnedByOffsets` | selfRef+오프셋→peerAnchors→pickOwnedPlate | 선정만 |
| PtzCalibrator.ts | `run` | 프리셋 그룹핑(byPreset) | 오케스트레이션 |
| PtzCalibrator.ts | (신규)`peerOffsetsFor` | 상대오프셋 산출 | 순수 |
| PtzCalibrator.ts | `calibrateSlot` | peerOffsets 인자→양 인스턴스 주입 | 배선 |

- **제어수식 무접촉 확증**: `controlMath`(gain/predict/zoom/panTilt), `probeGain`, centerOnPlate/zoomToPlateWidth 의 폐루프 본문 **불변**. `pickNearestPlate` 도 존치(하위호환 분기). VPD·Finalizer·discovery·라우트·config 스키마 무접촉.

---

## B. vitest 검증기준

### B-1. 소유권 선정 (platePtz.test.ts — `makeWorld` 다판+decoy 모델 재사용)
1. **이웃판 존재 시 자기 판만 픽**: 판 3개(자기 aX=0 + 이웃 ±0.14, confidence 로 신원 태그), `peerOffsets=[{x:-0.14},{x:+0.14}]` 주입 → `centerOnPlate` 최종 `plate.confidence` == 자기 태그. 이웃 태그 **한 번도** 선택 안 됨(매 스텝 검증).
2. **미소유 기각(latch→honest miss)**: 자기 판 부재·이웃만 존재 → 소유권 선정 `null` → `reason:'no_plate'` (또는 루프 중 소실 시 `plate_lost`). **대조군**: 동일 입력에 `peerOffsets` 미전달(레거시) → 이웃 오선택(현행 latch 재현). = 회귀의 근본원인이 소유권으로 제거됨을 입증.
3. **줌 단계 신원 유지**: `zoomToPlateWidth` 에 이웃이 확대 중 중앙으로 접근하는 world → 소유권이 이웃 기각·자기 유지(신원 태그 불변). 상수 오프셋의 보수성(zoom 시 이웃 과소추정=안전) 회귀 확인.
4. **하위호환(회귀 0)**: `peerOffsets` 미전달 → 기존 `platePtz.test.ts` 전 케이스 결과 **동일**(선정 경로 byte 동치).

### B-2. peer 오프셋 산출·그룹핑 (ptzCalibrator.test.ts — makePlatePtz 스텁으로 opts 캡처)
5. **오프셋 정확·프레임 격리**: 같은 프리셋 3슬롯(lpd cx 0.325/0.464/0.62) → slot@0.464 의 `calibrateSlot` 이 받는 `peerOffsets` == `[{x:-0.139..},{x:+0.156..}]`(자기 제외). **다른 프리셋** 슬롯은 peer 에서 제외. 단일슬롯 프리셋 → `[]`.
6. **인접 슬롯 서로 다른 판 수렴(anti-dup end-to-end)**: 같은 프리셋 2슬롯 + "모든 판이 함께 이동" world 스텁 → 두 슬롯 최종 PTZ **상이**(중복 없음). 현행(최근접)에서 동일 PTZ 수렴(중복) 재현 → 소유권으로 해소 대조.

### B-3. 이터1 저장·정렬 회귀 0 (기존 스위트 그대로 green)
7. `saveCenteringSlots` 게이트(`centered:true,converged:false` 포함 / `centered:false` 제외 / `globalIdx:null` 제외), 저장 3중(`save/Setup_*.json`+DB `slot_setup`+`slot_ptz.json`), `expandPlateTargetsFromSlotSetup` 정렬 — `ptzCalibrator.test.ts`·`slotPtzWriter.test.ts`·`platePtz.test.ts` 기존 케이스 **무수정 통과**. `plateDiscovery.test.ts`(pickOwnedPlate) 무변경 재확인.
8. `npx tsc --noEmit` exit 0.

### B-4. 라이브 한계(은닉 금지 — 00_goal 검증한계)
- **시뮬 13100 DOWN** → 실 PTZ 물리 수렴·pre-aim 이 실카메라에서 자기 판을 실제로 중앙에 두는지·비-cam1 게인 정확도는 **검증 불가**. B-1~B-3(소유권 선정·오프셋 산출·이웃기각·anti-dup·회귀0)은 결정형 vitest 로 확정하고, 실카메라 수렴은 **라이브 확증 필요 항목으로 명시**(위장 성공 금지).

---

## C. 회귀 / 리스크

- **코어 침습 범위(최소 확인)**: platePtz 변경은 `PlatePtzOpts`+`captureAndDetect` 선정 1분기+헬퍼 1개+import. 제어수식·probe·폐루프 본문 불변. **`peerOffsets` 미전달 시 선정 경로가 레거시와 동치** → PlatePtz 를 쓰는 타 경로(없음: discovery 는 PlateDiscovery 사용) 및 기존 테스트 회귀 0. 소유권은 오직 PtzCalibrator 주입 시만 활성.
- **plate_lost/no_plate 증가 가능성(설계된 트레이드오프)**: 소유권은 "이웃으로의 조용한 오수렴"을 "정직한 미검"으로 바꾼다. pre-aim 오차 ≳ 최근접 오프셋 절반(≈0.055~0.078) 또는 게인 대오차 시, 자기 판이 자기 Voronoi 셀 밖으로 나가 **기각**될 수 있다 → 중복은 사라지되 미검 슬롯이 늘 수 있음. **이는 goal 1(이웃 latch 금지)의 의도된 귀결**이며 중복·오수렴보다 안전. 완화=pre-aim 이 대상을 중앙근처로 유지(가용성).
- **좌표계 일관(핵심 리스크의 처리)**: pan/tilt 단계는 강체평행이동=소유권 보존이라 **정확**. **zoom 단계는 오프셋을 스케일하지 않고 상수 사용** — self 가 중앙(0.5) 유지되므로 이웃거리 **과소추정=보수적(자기 소유 판정을 더 엄격하게)** → 오귀속 없음(안전측). 이 근사는 D-1 로 명시. 절대 PTZ·게인 **무의존**이라 이터1 게인 리스크가 선정으로 전염되지 않음.
- **점 형태 혼용 리스크**: `{x,y}`(pickOwnedPlate) vs `{cx,cy}`(platePtz Center/geometry.center) — A-1/A-2 에서 변환 명시. 미준수 시 좌표 뒤섞임(잠복버그) → 테스트 B-1 이 포착.
- **import 방향**: platePtz→plateDiscovery(pickOwnedPlate). 순환 없음 확인. (대안: pickOwnedPlate 를 controlMath 로 이관해 선정수학 응집 — 범위 밖, D-3.)
- **성능**: peerOffsets 산출=슬롯당 순수계산 1회(카메라 호출 0 추가). captureAndDetect 소유권=후보×peer 선형(수 개 규모, 무시).

---

## D. 미해결 / 가정 (리더 확인 요청)

- **D-1 (zoom 오프셋 스케일, 가정=상수)**: 줌 단계 peer 오프셋을 **상수로 고정**(스케일 없음)한다 — self 중앙유지로 보수적·안전·단순. 만약 라이브에서 공격적 zoom-in 중 이웃 유입이 관측되면 `offset × (currentZoom / anchorZoom)`(anchorZoom=base.zoom) 스케일 추가. **가정: 상수로 충분**(줌 시작=센터링 완료프레임이라 이웃이 방사로 멀어짐).
- **D-2 (초기 pick selfRef, 가정=중앙)**: 첫 검출의 자기 기준점 = `center(prior)` = pre-aim 이 겨눈 중앙(0.5). 소유권 정확성은 **pre-aim 오차 < 최근접 오프셋 절반**을 요구. 위반 시 latch 가 아니라 `no_plate`(정직 미검)로 강등 — 안전. **절대좌표 역변환(base PTZ+게인)** 대안은 게인 대오차 시 동일 한계에 코어 침습만 늘어 **기각**. 가정: 상대오프셋 채택.
- **D-3 (pickOwnedPlate 위치, 가정=현 위치 import)**: `plateDiscovery.js` 에서 import(최소변경). 선정수학 응집을 위한 `controlMath` 이관은 선택(공유 소비자 blast radius 有) — **가정: 이관 안 함**.
- **D-4 (peer 소스 전제)**: peer 앵커 = 같은 (cam,preset) 타 슬롯 `slot_setup.lpd` 중심. lpd 미채움 슬롯은 애초 `expandPlateTargetsFromSlotSetup` 에서 target 제외(peer 후보 아님) → auto-chain(discovery→calibrate)에서 충족. 수동 `/calibrate/ptz` 단독은 사전 discovery 전제(기존과 동일).
- **D-5 (라이브 확증 이월)**: sim 13100 UP 시 실판 중앙화·이웃 latch 소멸·중복/누락 소멸을 라우트 실측으로 최종 확인(이번 라운드 범위 밖, 은닉 금지).

---

## 구현 순서 (검증 첨부)

1. platePtz.ts: `peerOffsets` opt + `pickOwnedByOffsets` 헬퍼 + captureAndDetect 선정 분기 + import → **검증**: B-1.1~4, B-4 tsc.
2. PtzCalibrator.ts: run `byPreset` 그룹핑 + `peerOffsetsFor` + calibrateSlot 주입(양 인스턴스) → **검증**: B-2.5·6.
3. 이터1 회귀 스위트 재실행 → **검증**: B-3.7·8(무수정 green).
4. 라이브(B-4)는 한계 명시로 종결 — 결정형 확정분과 라이브 이월분을 분리 보고.
