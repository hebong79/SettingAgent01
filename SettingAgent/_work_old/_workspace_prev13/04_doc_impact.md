# 04 · 영향도 분석 — 번호판(LPD) 기준 floor ROI 재정의

작성: documenter / 대상: SettingAgent / 2026-07-03 20:05:00
근거: 01(설계)·02(구현)·03(검증) + 실제 변경 소스 대조.
상세 문서: `SettingAgent/docs/20260703_200500_주차면점유영역_번호판LPD기준_재정의.md`

---

## 1. 요약 판정

이번 재정의는 **결정형 생성 규칙(floorRoi.ts) 교체 + plateQuad 배선 + 프롬프트·스키마 4점화**에 국한된다.
공유 타입·저장 스키마·뷰어·DB 는 **본 작업에서 무변경**이며, 4점 사변형이 기존 가변 다각형 계약에 구조적으로 호환되어 파급이 억제됐다.

---

## 2. 모듈별 영향

### 2-1. `@parkagent/types` (packages/types) — 본 작업 무변경 (주의: §5 참조)

- 이번 재정의는 타입 파일을 **건드리지 않았다**. `floorRoiByPreset?: Record<string, NormalizedPolygon>`(4~10점 가변) 계약을 그대로 활용한다.
- **4점 `NormalizedQuad` 는 `NormalizedPolygon`(= `NormalizedPoint[]`)에 구조적으로 할당 가능** → 생성기가 4점만 산출해도 저장·전달 타입 계약을 위반하지 않는다.
- 결과: SettingAgent/ActionAgent/DMAgent 3개 에이전트가 공유하는 타입 계약 오염 **0**.

> **확인 필요(사실 고지)**: 현재 작업 트리에는 `packages/types/src/index.ts` 의 `floorRoiByPreset` 이 `NormalizedQuad`→`NormalizedPolygon` 으로 바뀐 미커밋 diff 가 존재한다. 이는 **선행 "가변 다각형" 작업**(참조: `docs/20260703_102157_주차면점유영역_가변다각형_비겹침.md`)의 산출물이며, 본 "LPD 기준 재정의" 작업의 변경이 아니다. 본 작업은 그 이미 확립된 `NormalizedPolygon` 을 소비만 한다. 작업 트리가 여러 기능의 미커밋 상태를 함께 담고 있어 git 만으로 작업별 diff 를 완전 분리하기 어려운 점을 명시한다.

### 2-2. 뷰어 `web/*` — 무변경

- `core.d.ts` 는 `floorRoiByPreset: Record<string, NormalizedPoint[] | NormalizedQuad>` 로 **가변 point 배열**을 처리. `hitTestQuadVertex`/`moveQuadVertex`/`updateSlotFloorRoi` 모두 점 수 무관.
- 4점이든 (deconflict 후) 5~6점이든 렌더·편집 그대로 동작 → **뷰어 코드 파급 0**. 오히려 4점이라 편집 UX 는 단순해진다.

### 2-3. 스토어 / DB 스키마 — 무변경

- floor ROI 는 좌표 배열(JSON)로 저장 → 스키마 구조 변경 없음. `SqliteStore.upsertFloorRoi`/`getFloorRois` 시그니처 무변경.
- 마이그레이션 스크립트 **불요**.

### 2-4. 저장된 기존 floorRoi 데이터 — 하위호환(마이그레이션 불요)

- 기존 4~10점 볼록 다각형은 `NormalizedPolygon` 계약 유지 → **로드·렌더 그대로 유효**, 스키마 위반 없음.
- 강제 재계산 불요: 다음 캡처/최종화 시 신규 규칙으로 자연 갱신.

### 2-5. 구 plate rect 데이터 — 각도 0 폴백

- `plateQuad` 부재(구DB·vehicle 행)면 `rectToQuad(predictPlateRect)` 승격 → 축정렬 → `plateAngleRad`=0. 별도 분기 없이 안전 동작.

---

## 3. 시그니처 변경 호출부 파급

| 변경 심볼 | 변경 내용 | 참조 지점 | 갱신 여부 |
|-----------|-----------|-----------|-----------|
| `resolveFloorPolygon` | `(llmPoly, vehicle, plateQuad?, plateRect?)` 4-arg 로 확장 | `FloorRoiReviewer.ts`(호출), `test/floorRoi.test.ts`·`test/floorRoiNormalizeEdge.test.ts`(테스트) | 전부 갱신·그린 |
| `fallbackPolygon`→`buildPlateAnchoredQuad` | 개명·재구현, 3번째 `depthFloor?` 추가 | `Finalizer.ts`(호출), `test/floorRoi.test.ts`·`test/floorRoiReviewer.test.ts`·`test/finalizerFloor.test.ts`(비교값) | 전부 갱신·그린 |
| `FloorRoiInput` | `plateQuad?: NormalizedQuad` 필드 추가 | `AgentRuntime.recognizeFloorRoi`, `FloorRoiReviewer`(호출) | 갱신 |
| `FloorRoiResultSchema.polygon` | `.min(4).max(10)`→`.length(4)` | `AgentRuntime.recognizeFloorRoi`(파싱), `agentRuntimeFloor.test.ts` | 4점 반환이라 정합, 그린 |
| `plateAngleRad`/`projectedSpan` | 신규(추가만) | `floorRoi.ts` 내부 | 신규 소비 |

- `plateQuad` shape 규약(TL,TR,BR,BL)이 원천(`capture/types.ts AggregatedSlot.plateQuad`)→소비(`plateAngleRad`)까지 전 구간 일관(검증자 §4 소스 대조 확인). 필드명·타입·순서 불일치 없음.
- 전 호출부가 컴파일(tsc EXIT 0)·회귀 테스트 통과.

---

## 4. 리스크 / 후속 조치

| 리스크 | 현황 | 후속 |
|--------|------|------|
| 상수 4종(0.55/0.42/1.0/0.15) 육안 부적합 | 참조 이미지 눈대중 초기값 | 실 캡처 렌더를 `etc/주차면점유영역_01~03.jpg` 와 대조해 미세조정(파라미터 1곳 집중) |
| near-vertical plate(θ≈±90°) nb 부호 뒤집힘 | `nb.y>0` 부호 정규화 + 퇴화 θ=0 폴백으로 방어, 유닛 통과 | 실 프레임 근수직 번호판 케이스 후속 확인 |
| 실 LLM `recognizeFloorRoi` 스모크 미수행 | 모킹만 커버(외부 서비스 미기동) | LLM 활성 환경에서 4점 출력·깊이 힌트 유효성 스모크 |
| 육안 렌더 대조 미수행 | 유닛 불변식 전량 통과, 시각 정합 미확인 | Unity·뷰어 기동 후 육안 검증 |
| 극단 케이스(번호판이 bbox 세로 48%↑ 점유) | 앞모서리 미세 돌출 가능하나 `expandPolygonToContainRect` 안전망이 포함강제, 비현실적 입력 | 결함 아님(설계 §2-4 의도 범위), 모니터만 |

---

## 5. 회귀 안전성 근거

- **vitest 70 파일 / 611 테스트 전부 통과**(검증자 실측). 베이스라인 592 + 신규 19 = 611, 회귀 0.
- 타입체크 `tsc --noEmit` EXIT 0.
- 계약 무변경 회귀 스위트(deconflict·Reviewer·Finalizer·agentRuntimeFloor·promptsYaml) 그린 → 시그니처 확장이 기존 동작을 깨지 않음을 확인.
- 단, §4 의 육안·실 LLM 스모크는 **미수행(누락)** — 순수 기하는 검증됐으나 실 서비스 정합은 후속.

---

## 6. 변경 파일 · 영향 범위 표

| 파일 | 변경 요지 | 영향 범위 |
|------|-----------|-----------|
| `src/domain/geometry.ts` | 신규 `plateAngleRad`·`projectedSpan`(추가만) | floorRoi.ts 소비 / 기존 함수 무영향 |
| `src/capture/floorRoi.ts` | 빌더 교체·`resolveFloorPolygon` 확장·상수 4종 | Reviewer·Finalizer·테스트 4종 |
| `src/capture/FloorRoiReviewer.ts` | plateQuad 전달(호출부) | 계약 무변경 |
| `src/capture/Finalizer.ts` | 폴백 base 빌더 교체(호출부) | 계약 무변경 |
| `src/brain/SetupBrain.ts` | `FloorRoiInput.plateQuad?`·스키마 4점화 | AgentRuntime·Reviewer |
| `src/brain/AgentRuntime.ts` | 템플릿 plateQuad 주입(내부) | 프롬프트 |
| `config/prompts/floor_roi.yaml` | 규칙 1~6 전면 재작성·출력 polygon 4점 | LLM 계약(정합 회복) |
| `test/plateAnchoredQuadInvariants.test.ts` | 신규 19 테스트 | — |
| `test/floorRoi/finalizerFloor/floorRoiReviewer/floorRoiNormalizeEdge.test.ts` | 시그니처 정합 갱신 | 회귀 그린 |
| `web/*` | 본 작업 무변경 | 가변 다각형 렌더 그대로 |
| `@parkagent/types`(packages/types) | 본 작업 무변경(§2-1 주의 참조) | 3개 에이전트 계약 오염 0 |
