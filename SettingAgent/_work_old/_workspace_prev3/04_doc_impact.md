# 04 영향도 분석 — 편집 대상 전환(차량 bbox → floor ROI 4점 quad) + 4꼭짓점 개별 드래그

- 작성일: 2026-07-01 16:26:03
- 작성: 문서화·영향도 분석가(documenter)
- 최종 문서: `SettingAgent/docs/20260701_162603_floorROI정점편집.md`
- 근거: 01/02/03 산출물 + 실제 코드 정적 확인(파일·라인 명시).

## 0. 결론 요약

- **파급 범위: SettingAgent 뷰어 프런트엔드(`web/`)로 국한.** 서버·산출물 스키마·공유 타입·타 에이전트 무변경.
- **REST 계약 무변경**: `floorRoiByPreset`(4점 quad)는 이미 존재하던 필드. PUT `/viewer/api/mapping` zod 스키마·`@parkagent/types` 모두 그대로.
- **값(vertex 좌표)만 변한다. shape 은 불변.** 하위 소비자(brain/AgentRuntime)는 재컴파일·수정 불필요.
- 잔존 orphan(A안) 코드가 유일한 잠재 위험(혼동·미래 회귀). 아래 §5.

## 1. floorRoiByPreset 소비처 (뷰어 프런트엔드 내부)

이번 변경이 편집·소비하는 필드는 `slot.floorRoiByPreset[key]` (key = `presetKey(cam,preset)`). 뷰어 내 소비 지점(`web/app.js`):

| 위치 | 소비 | 이번 변경과의 관계 |
|------|------|------------------|
| `app.js:192` `drawRoiOverlay` | `slot.floorRoiByPreset?.[key]` → `toPixelQuad(fquad, w, h)` 렌더 | floor quad 렌더는 기존과 동일. 신규 `drawQuadHandles(ctx, pts)` 가 동일 pts 소비(정합 확인, 03 §3). |
| `app.js:276` `hitTestFloorVertex` | `slot?.floorRoiByPreset?.[key]` → `hitTestQuadVertex` | **신규 소비**. floor 레이어 ON·선택 슬롯 가드. |
| `app.js:1076` `mousemove` | `slot?.floorRoiByPreset?.[dragState.key]` → `moveQuadVertex` → `updateSlotFloorRoi` | **신규 소비**. 값 갱신 경로. |

- `toPixelQuad`(`{x,y}`→`{px,py}`), `hitTestSlots`(app.js:1062, 슬롯 선택) 은 **무변경** — 슬롯 선택/floor 렌더 기존 동작 유지.
- 검증자 경계면 교차 비교(03 §3): `moveQuadVertex` 반환(4×`{x,y}`) ↔ `updateSlotFloorRoi` 저장 ↔ `toPixelQuad` 픽셀 변환 전 구간 shape 정합. **불일치 없음.**

## 2. 저장 계약(PUT /viewer/api/mapping) 스키마 영향 — 무변경(확인 완료)

실제 서버 코드 정적 확인:
- `src/api/server.ts:56` — `floorRoiByPreset: z.record(NormalizedQuadSchema).optional()` (**이미 존재**).
- `src/api/server.ts:36~41` — `NormalizedQuadSchema = z.tuple([point, point, point, point])` (4점 튜플).
- `src/api/server.ts:293` — `PUT /viewer/api/mapping` → `saveMappingHandler(deps.repo, req.body, reply)` (헤드리스와 동일 로직, zod 검증 + validateCoverage).

→ 이번 변경은 이 필드의 **값(vertex 좌표)만** 바꾼다. 필드 추가/삭제/타입 변경 없음. **PUT 스키마·검증 로직 무변경 확인.** `saveMappingHandler` 관련 테스트(`captureRoutes.test.ts` 등)도 무영향.

## 3. globalIndex(1-based) 불변 — 확인 완료

- `updateSlotFloorRoi` 는 `{...artifact, slots}` 만 교체, `globalIndex` 는 참조 그대로 전달 → `next.globalIndex === artifact.globalIndex`(03 updateSlotFloorRoi 케이스로 검증).
- floor 정점 편집은 slot 의 좌표만 건드리고 globalIdx(1-based 전역 매핑)를 재계산/재배열하지 않음.
- `validateCoverage`(globalIndex↔slots) 검증 통과 조건 불변 — 저장 시 400 위험 없음.

## 4. @parkagent/types · ActionAgent · DMAgent 파급 — 없음(확인 완료)

- **@parkagent/types**: `floorRoiByPreset?: Record<string, NormalizedQuad>` 및 `NormalizedQuad = [NP, NP, NP, NP]` 이미 선언(`packages/types/src/index.ts:60, :23`). **타입 변경 없음** → 이 타입을 참조하는 어떤 패키지도 재컴파일/수정 불필요.
- **floorRoiByPreset 생산 경로**(무변경): `src/capture/Finalizer.ts:191`, `src/capture/FloorRoiReviewer.ts`(LLM 비전) — 이번 변경은 생산 로직을 건드리지 않고, 뷰어에서 사용자 편집 경로만 추가.
- **floorRoiByPreset 소비 경로**(shape 무변경 → 무영향): `src/brain/AgentRuntime.ts`, `src/brain/SetupBrain.ts`. 값만 바뀌므로 로직 수정 불필요.
- **ActionAgent / DMAgent**: 이 저장소 내 정적 확인 범위에서 `floorRoiByPreset`/`NormalizedQuad` 직접 참조는 SettingAgent·packages/types 에만 존재(Grep 32파일 전부 SettingAgent 하위 + packages/types). ActionAgent/DMAgent 가 `setup_artifact.json`/`@parkagent/types` 를 소비하더라도 **shape 불변**이므로 파급 없음.
  - **확인 필요(단정 회피)**: ActionAgent/DMAgent 가 별도 리포/서브모듈로 floor quad 를 런타임 소비한다면, "정점 좌표 변경이 반영된 새 산출물"을 재로드하는지는 각 에이전트 배포 시점 문제(코드 계약 문제 아님). 계약(shape) 관점 파급은 없음.

## 5. orphan(A안) 코드로 인한 잠재 혼동·회귀 위험

A안(보존+주석) 적용으로 데드코드가 잔존한다. 사실 그대로 위험을 명시한다.

- **잔존 대상**: app.js `drawHandles`/`hitTestHandle`/`hitTestEdge`(차량 UI 함수) + import `resizeRect`/`updateSlotRoi`. core.js 차량 순수 함수·테스트는 정상 사용(무변경).
- **현 상태 무해 확인**: typecheck exit 0, 미사용 경고 없음, 411/411 PASS(03). **런타임/타입 무영향.**
- **잠재 위험**:
  1. (혼동) 미래 유지보수자가 `hitTestHandle`/`hitTestEdge` 가 여전히 활성인 줄 오해할 수 있음 → 주석으로 완화했으나 완전 제거는 아님.
  2. (회귀) 차량 bbox 재편집을 되살릴 때 mousedown 결선을 복원하면 floor/차량 두 편집 경로가 동시에 히트할 수 있어 우선순위 재설계 필요.
  3. (정합) `resizeRect`/`updateSlotRoi` import 는 보존되나 호출 없음 — 트리셰이킹/린트 규칙이 강화되면 경고 발생 가능(현재는 무경고).
- **권고**: 차량 bbox 편집 복구 계획이 없다면 후속 정리 티켓에서 B안(제거) 검토. 이번 범위에서는 사용자 지침(bbox 로직 보존)에 따라 보존.

## 6. 회귀·테스트 영향

- 기존 388 tests 전부 통과 유지(차량 rect `resizeRect`/`updateSlotRoi` 등 무영향). 신규 floor 23 케이스 추가 후 **411/411 PASS**(03 §1).
- app.js DOM 결선은 유닛테스트 커버 불가 → **수동 체크리스트 5항목 미실행**(03 §4, 최종 문서 §7). 실기 확인 전까지 "검증됨"으로 간주하지 않음.

## 7. 확인 필요(단정 회피) 항목

- app.js 수동 동작확인 5항목(최종 문서 §7) — 실기 뷰어 미실행.
- ActionAgent/DMAgent 의 런타임 산출물 재로드 시점(계약 파급 아님, 배포 운영 문제).
