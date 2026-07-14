# 03 · QA 검증 리포트 — LPD 실패 슬롯의 "이웃 번호판" 기반 예상 quad → floor ROI

검증자: qa-tester / 대상: SettingAgent / 입력: `_workspace/01_architect_plan.md`, `_workspace/02_developer_changes.md`
검증 도구: vitest (실제 실행) + tsc --noEmit

---

## 1. 실행 결과 (있는 그대로)

- `npx tsc -p tsconfig.json --noEmit` → **EXIT 0**.
- `npx vitest run` (전체) → **72 files / 627 tests 전부 PASS, 실패 0**.
  - 기준선(구현자 제출 상태): 71 files / 619 tests.
  - 보강분 신규 파일 1개(`test/estimatePlateNeighborsIntegration.test.ts`, 8 tests) 추가 → +1 file / +8 tests.
  - 회귀 0: `estimatePlateFromNeighbors`(구현자 8), `plateAnchoredQuadInvariants`, `floorRoi`, `finalizerFloor`, `floorRoiReviewer`, `deconflictPolygons`, `promptsYaml`, `agentRuntimeFloor` 등 기존 전원 그린.

---

## 2. 구현자 유닛(8 tests) 커버리지 평가

`test/estimatePlateFromNeighbors.test.ts` 8 tests 는 헬퍼 순수 로직을 잘 덮음. 단, 계획 §9 불변식 중 **경계면·통합·바이트동일**은 미커버였음:

| 계획 §9 불변식 | 구현자 8 tests | 판정 |
|---|---|---|
| 1. 각도 추종 (`plateAngleRad(est)≈θ`) | 있음(헬퍼 레벨) | 부분 — floor ROI **앞변** 추종 end-to-end 없음 → **보강** |
| 2. 상대오프셋/크기 반영 | 있음 | 충분 |
| 3. 최근접 선택 | 있음(`[far,near]`) | 충분하나 argmin·순서무관 하드닝 → **보강** |
| 4. 이웃0개 = 현행 동일 | `undefined` 반환만 | 부족 — **바이트 동일** 미확인 → **보강** |
| 5. 게이트2 실측 우선 | 없음(배선 조건) | **보강**(Finalizer 통합) |
| 6. 게이트3 미오염(예상 quad 미저장·deconflict 미주입) | 없음 | **보강**(Finalizer 통합) |
| 7. quad 유효성·degenerate·clamp·순서 | 있음 | 충분 |
| 8. 회귀 | 전체 그린으로 확인 | 충분 |

---

## 3. 보강 테스트 (`test/estimatePlateNeighborsIntegration.test.ts`, 8 tests, 전부 PASS)

1. **불변식1 end-to-end**: `estimate → buildPlateAnchoredQuad` 및 `→ resolveFloorPolygon(null,...)` 의 **앞변 각도 ≈ 이웃 θ (≤3°)** — deg 0/12/22/-18. 헬퍼 각도가 실제 floor ROI 기하까지 전파됨을 확인.
2. **불변식4 바이트 동일**: 빈 이웃/전부 degenerate → `estimate=undefined` → `buildPlateAnchoredQuad(v, undefined)` 및 `resolveFloorPolygon(null,v,undefined,undefined)` 와 **`toEqual` 동일**. 이웃 0개 시 상수(predictPlateRect·θ=0) 폴백 100% 보존.
3. **불변식3 하드닝**: 3 이웃(먼-가까운중간-먼)을 입력 순서 3가지로 셔플 → 항상 최근접(중간 배치, 7°) 채택. argmin 이 첫/끝 요소 편향 없음.
4. **불변식5 게이트2(Finalizer 통합)**: target 이 자기 실측 plate(0°) 보유 시, 이웃(40°) 무시하고 **실측 0°** 사용(앞변 수평 ≤3°) + `plateRoiByPreset` 저장. 추정 트리거가 실측 존재 시 미진입 확인.
5. **불변식6 게이트3(Finalizer 통합)**: target=plate 완전 부재 + 이웃=25° plate 시나리오로 `finalize()` 실행.
   - target `floorRoiByPreset` 앞변 각도 ≈ 25°(≤3°) — 예상 quad 각도 추종.
   - **대조**: `|frontEdgeAngle(floor,θ)| > 3°` — 추정이 실제로 축정렬(0°)에서 각도를 바꿨음(무의미 통과 방지).
   - target `slot.plateRoiByPreset` = **undefined**(예상 quad 를 번호판 ROI 로 미저장), 실측 이웃은 `plateRoiByPreset` 저장(대조).
6. **불변식4 통합 대조**: 이웃도 plate 부재 → target floor ROI 앞변 수평(θ=0, ≤3°) + `plateRoiByPreset` undefined. 상수 폴백 회귀 확인.

---

## 4. 경계면 교차 비교 (핵심 점검)

- **게이트3 deconflict 미주입**: `Finalizer.assemble` L207–209 코드 정독 — `deconflictPolygons` 의 `plate` 인자는 `p.plateRect`(= `m.plateX/Y/W/H` 실측에서만 유도), 예상 `estimated` quad 는 `base`(폴리곤 인자)로만 흘러가고 `plate` 보호 인자에는 들어가지 않음. 관찰 프록시로 `plateRoiByPreset` 부재(동일 `p.plateRect` 소스 게이트)를 통합 테스트로 확인. **불일치 없음.**
- **폴백 우선순위**: Reviewer `plateQuad ?? estimated`, Finalizer `m.plateQuad ?? estimated ?? undefined` — 실측 > 이웃추정 > undefined 순서 일관. 두 호출부 트리거 조건(`plate 부재 && plateQuad 부재`) 동일.
- **quad 순서 규약**: 헬퍼 반환 TL,TR,BR,BL 이 `plateAngleRad`/`buildPlateAnchoredQuad`/`rotatedPlateQuad` 규약과 일치(라운드트립 6자리 확인).

---

## 5. 발견 결함

- **없음.** 구현이 계획을 정확히 따르며, 8개 보강 불변식 전부 통과. 구현 소스 미수정.

---

## 6. 누락 명시 (통과 위장 아님)

- **육안 렌더 동작확인 미수행**: LLM(floor_roi.yaml 규칙 7 가드레일)·Unity 뷰어 오버레이의 실제 렌더는 외부 서비스(LLM/Unity) 미기동으로 검증 불가 → 이번 검증은 **결정형 기하 + 모킹/인메모리 통합** 한정. 프롬프트 규칙 7 문구 존재는 `promptsYaml` 회귀로만 확인(실제 LLM 응답 품질 아님).
- **deconflict plate 미주입**은 코드 정독 + 관찰 프록시(`plateRoiByPreset` 부재)로 확인. `deconflictPolygons` 내부에 예상 quad 가 도달하지 않음을 직접 스파이하지는 않음(구조적으로 소스가 `p.plateRect` 단일이라 도달 경로 부재).

---

## 7. 산출 파일

- 신규: `SettingAgent/test/estimatePlateNeighborsIntegration.test.ts` (보강 8 tests).
- 기존: `SettingAgent/test/estimatePlateFromNeighbors.test.ts` (구현자 8 tests, 회귀 그린).
