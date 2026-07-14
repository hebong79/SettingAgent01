# 04 영향도 분석 — floor ROI 개선(발자국 폴백 + 번호판 포함 강제 + LLM 강제동작/경고)

문서화·영향도 분석가(documenter). 근거: CLAUDE.md 규칙5. 실제 코드/ git 상태로 교차 검증한 사실 기반.
연계 최종 문서: `SettingAgent/docs/20260701_174012_floorROI개선_발자국폴백_번호판포함강제_LLM경고.md`

---

## 1. 계약 변경(Breaking-ish)과 소비처

### 1.1 `FloorRoiReviewer.review` 반환형 `void → Promise<{ llmUnavailable: boolean }>`
- **소비처 = 유일 1곳**: `src/capture/CaptureJob.ts:287` 의 `await this.deps.floorReviewer.review(...)`.
  - `floorRes.llmUnavailable` 이면 `this.llmFloorUnavailable = true`(289줄) → 상태 필드로 승격.
- 다른 호출부 없음(grep 확인). 반환형 확장은 동시 수정 완료로 미해결 호출부 없음.
- 테스트: `test/floorRoiReviewer.test.ts` 가 반환 객체를 직접 assert(11 tests). 회귀 위험 낮음.

### 1.2 `CaptureStatus.llmFloorUnavailable?: boolean` 신규 필드
정의·전파·소비 3지점 정합(검증 03 §3 교차확인):
- 정의: `src/capture/types.ts:90`
- 서버 노출: `CaptureJob.getStatus()` → `...(this.llmFloorUnavailable ? { llmFloorUnavailable:true } : {})`(`CaptureJob.ts:118`). status API(`src/api/server.ts` 경유)로 클라이언트에 전달.
- 클라이언트 타입 선언: `web/core.d.ts:50`
- 클라이언트 소비: `web/app.js:595` `status?.llmFloorUnavailable`
- **옵셔널 추가만** → 기존 status 소비 코드·기존 필드 하위호환. 필드명·옵셔널·타입 3자 일치.

---

## 2. 저장 계약 / 공통 타입 / 인접 에이전트 — 불변 확인

| 대상 | 확인 방법 | 결과 |
|------|-----------|------|
| `@parkagent/types` `NormalizedQuad`/`NormalizedPoint` | `git status` 상 `packages/types/src/index.ts` **변경 없음**(M 아님) | 불변 ✅ |
| 저장 계약 `floorRoiByPreset: Record<string, NormalizedQuad>` | Finalizer 산출물 shape · `@parkagent/types:60` 미변경 | 불변 ✅ |
| `SqliteStore.upsertFloorRoi(runId,presetKey,clusterId,quad,now)` | 시그니처 미변경, quad 는 4×{x,y} 순서 [FL,FR,RR,RL] 왕복 | 불변 ✅ |
| globalIndex 매핑 · slot box map | quad **값**만 변경, 키·구조 불변 | 불변 ✅ |
| ActionAgent / DMAgent | floor ROI 소비 shape 동일(NormalizedQuad) → 데이터 구조 무변경 | 무영향 ✅ |
| `Finalizer.ts`(git 상 M 표기) | 이번 변경 심볼(FALLBACK_BAND/expand/resolve/llmUnavailable) 참조 0건 → **본 변경과 무관**, 선행 작업(slot_ptz 등)에서 온 수정 | 본 건 무영향 ✅ |

핵심: **경계면(shape) 무변경.** 좌표 순서 규약 [앞왼,앞오,뒤오,뒤왼] 유지 → 뷰어/하류 소비측 재작업 불필요.

---

## 3. 폴백 상수 변경이 기존 산출물에 미치는 영향 (주의)

- `FALLBACK_BAND` 0.35→0.55, INSET 단일 0.1 → front 0.04 / rear 0.22 는 **폴백 quad 의 좌표 값**만 바꾼다.
- **DB/산출물 마이그레이션 없음**: 이미 저장된 quad 는 재계산 전까지 옛 값(얕은 띠)으로 남는다. 새 형상은 **다음 수집·재계산(upsert)** 시점부터 적용된다.
- 따라서 동일 런/뷰에 옛 폴백(35% 띠)과 새 폴백(55% 발자국)이 **혼재**할 수 있다(재수집 전 구간). 시각적으로만 감지되며 스키마/파싱에는 무해.
- LLM 이 정상 동작한 슬롯은 폴백 상수와 무관(LLM quad 사용). 상수 변경 영향은 폴백 경로 슬롯에 한정.

---

## 4. UI 경로 영향

- **모달 신설**(`#floor-llm-warn-modal`): 기존 `.modal`/`.modal-box` 인프라 재사용 → 레이아웃 충돌 위험 낮음. `.floor-llm-warn-box`(app.css:844) 추가 스타일만.
- **폴링 가드**(`floorLlmWarnShown`): 전역 변수 1개. `capStart()` 리셋(app.js:624)·`capPoll()` 게이트(app.js:595). 다른 폴링 로직과 상태 공유 없음 → 부작용 없음.
- **설계 편차 반영**: `latestAdvisory` 배너 경로는 이번에 건드리지 않음(별도 필드로 분리). 기존 advisory 표시 회귀 없음.

---

## 5. 회귀 위험 평가

| 항목 | 위험 | 완화 |
|------|------|------|
| review 반환형 확장 | 낮음 | 호출부 1곳 동시 수정 + reviewer 테스트 11건 green |
| no-op 제거로 항상 upsert | 낮음 | LLM off 시 upsert 증가(폴백) — 기대 동작. maxPerCheckpoint 상한 유지로 호출량 제한 |
| 경고 조건 `attempted>0 && succeeded===0` | 낮음 | 리더 확정 조건, 검증 케이스4/5로 양방향 확인 |
| 폴백 상수 변경 | 낮음(시각적) | §3 혼재 — 스키마 무영향. 필요 시 재수집 |
| normalizeQuad/clamp01 회귀 | 없음 | 미변경 + 회귀 테스트 고정 |
| 전체 회귀 | 없음 | vitest 426/426 pass, typecheck 통과 |

---

## 6. 확인 필요(단정 회피)

- **UI 모달 실제 렌더/1회 표시**: DOM 유닛 미커버. 브라우저에서 llm 비활성 수집으로 육안 확인 필요(최종 문서 §11-1).
- **폴백 형상 실측 적정성**: BAND 0.55 등은 카메라 각도 무관 근사. 실측 프레임에서 과대/과소 시 상수 재튜닝 여지(구조 불변).
- **status API 직렬화 경유**: `getStatus()` → server → app.js 사이 필드 통과는 shape 정합으로 확인했으나, 실 서버 응답 육안 확인은 수동 항목.

---

## 7. 결론

- 파급 범위는 **SettingAgent 내부에 한정**. 공통 타입·저장 계약·globalIndex·ActionAgent/DMAgent 무영향(코드/ git 근거).
- 계약 변경 2건(review 반환형, CaptureStatus 필드)은 소비처가 각각 1곳/제어된 경로로 동시 수정·하위호환.
- 유일한 관찰 가능 부작용은 폴백 상수 변경으로 인한 **재수집 전 옛/새 폴백 형상 혼재**(스키마 무해).
- 회귀 위험 종합 낮음. 잔여는 DOM/실측 수동확인 3건.
