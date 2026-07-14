# 03 검증 보고 — floor ROI 개선(발자국 폴백 + LPD 번호판 포함 강제 + LLM 강제동작/경고)

검증자(qa-tester). 대상: 설계서 `01_architect_plan.md` §7, 구현요약 `02_developer_changes.md`.
근거: CLAUDE.md 규칙2(유닛테스트 필수)·규칙3(동작 확인).

---

## 1. 실행 명령 / 결과

```
# floor 대상만
npx vitest run test/floorRoi.test.ts test/floorRoiReviewer.test.ts
  → floorRoi.test.ts        22 tests  ✓
  → floorRoiReviewer.test.ts 11 tests ✓
  → Tests 33 passed (33)

# 전체 회귀
npx vitest run
  → Test Files 56 passed (56)
  → Tests      426 passed (426)   ← 실패 0

# 타입체크
npm run typecheck  (tsc -p tsconfig.json --noEmit)
  → 에러 없음(정상 종료)
```

**최종: 전체 426 pass / 0 fail. 타입체크 통과.**

---

## 2. 추가·수정 테스트 케이스

### 2.1 `test/floorRoi.test.ts` (순수 모듈 — 신규 케이스 추가, 기존 회귀 유지)

| # | 케이스 | 검증 내용 |
|---|--------|-----------|
| 1 | 폴백 발자국 형태(설계 §7.1-1) | `{x:0.3,y:0.1,w:0.4,h:0.4}` → 앞변 y=0.5(=y+h), 뒤변 y=0.28(=y+h·0.45). 앞변 x=left+0.04w/right-0.04w, 뒤변 x=left+0.22w/right-0.22w. 앞변폭 > 뒤변폭, 폭차=2·(0.22-0.04)·w. 순서 [FL,FR,RR,RL] |
| 2 | bbox 하단 경계 clamp | y+h=1.3 → 앞변 y=clamp01=1, 모든 좌표 0~1 |
| 3 | expand — plate 아래(rb>앞변y) | 앞변 y 두 정점 공통값=rb(평행 유지) |
| 4 | expand — plate 위(rt<뒤변y) | 뒤변 y 두 정점 공통값=rt |
| 5 | expand — plate 좌측 초과 | FL.x·RL.x = rl |
| 6 | expand — plate 우측 초과 | FR.x·RR.x = rr |
| 7 | expand — 이미 내부면 멱등 | deep-equal 원본, 2회 적용도 동일 |
| 8 | expand — 4모서리 포함 | 좌·하 동시 초과 plate 4모서리 `pointInQuad` 전부 true |
| 9 | expand — 범위초과 plate clamp | rect{-0.1,-0.1,1.3,1.3} → 결과 전 좌표 0~1 |
| 10 | resolveFloorQuad (a) 유효 llm+plate | plate(quad 우측 밖) 4모서리 포함 |
| 11 | resolveFloorQuad (b) llm=null+plate | 폴백이 plate(좌측 밖) 포함 |
| 12 | resolveFloorQuad (c) plate 없음 | base(폴백/정규화)와 동일 — 기존 동작 유지 |
| — | normalizeQuad 회귀(불변) | 점≠4→null, NaN→null, undefined→null, 범위초과 clamp, 순서 뒤섞임→[FL,FR,RR,RL] (기존 케이스 그대로 통과) |

`pointInQuad`(cross product 부호 일관·경계 포함) 헬퍼로 포함 여부를 좌표 비교 대신 기하로 검증.

### 2.2 `test/floorRoiReviewer.test.ts` (서비스 — no-op 폐기 반영해 기존 2건 수정 + 신규 3건)

| # | 케이스 | 변경 | 검증 |
|---|--------|------|------|
| 1 | brain 비활성(enabled=false) | **수정**(기존 no-op 기대 → 폴백 생성) | upsert 1건 = `fallbackQuadFromRect`, 반환 `{llmUnavailable:true}` |
| 2 | recognizeFloorRoi 메서드 부재 | **수정**(기존 no-op → 폴백) | upsert 1건, `{llmUnavailable:true}` |
| 3 | brain 미주입(undefined) | 신규 | 폴백 1건, `{llmUnavailable:true}` |
| 4 | LLM throw | **수정**(경고신호 assert 추가) | 폴백 quad 저장 + `attempted>0·succeeded=0` → `{llmUnavailable:true}` (리더 확정 조건) |
| 5 | 정상 LLM 성공 | 신규 | `{llmUnavailable:false}` |
| 6 | 정상 LLM(plate 미포함 quad)+plate | 신규 | 저장 quad 가 plate 우측 초과분 포함(`pointInQuad` 4모서리 + max x ≥ plate 우측) |
| — | 프레임 skip / 무효 quad(null) 폴백 / rejected·merged 제외 / maxPerCheckpoint / plate input 전달 | 회귀 유지 | 전부 통과 |

**경고신호 조건 정합**: 구현은 `llmUnavailable = !llmUsable || (attempted>0 && succeeded===0)`. 설계 §7.2 케이스9 초안("throw → llmUnavailable:false")은 구현요약 §B·리더 확정으로 재정의됨(throw만 있고 성공 0이면 true). 본 검증은 **리더 확정 조건**을 기준으로 케이스4를 작성(설계 초안 아님). 성공 quad ≥1이면 false(케이스5).

---

## 3. 경계면(shape) 교차 비교

- `FloorRoiReviewer` → `store.upsertFloorRoi(runId, presetKey, clusterId, quad, now)` : quad 는 `NormalizedQuad` = 4×{x,y}.
- `store.getFloorRois(runId)` 반환 `{presetKey, clusterId, quad: NormalizedQuad}` — 컬럼 x0..y3 ↔ quad[0..3].{x,y} 순서 그대로 왕복. 테스트에서 `got[0].quad` deep-equal 로 확인.
- `resolveFloorQuad`/`fallbackQuadFromRect`/`expandQuadToContainRect` 모두 4점 배열 [FL,FR,RR,RL] 순서 반환 → 저장 계약(`floorRoiByPreset: record<NormalizedQuad>`)·뷰어 소비측 shape 불변. **불일치 없음.**
- `CaptureStatus.llmFloorUnavailable?: boolean`(src/capture/types.ts) ↔ `web/core.d.ts` 선언 ↔ `web/app.js` `status?.llmFloorUnavailable` 소비 — 필드명·옵셔널·타입 일치.

---

## 4. 수동 확인 항목 (유닛 대상 아님 — DOM/모달·실측 프레임)

1. **LLM off 시 경고 메시지박스 1회 표시**: `capPoll()` 이 `status.llmFloorUnavailable && !floorLlmWarnShown` 에서 `#floor-llm-warn-modal` 을 1회 열고 `floorLlmWarnShown=true` 가드 → 매 폴링 반복 팝업 금지. `capStart()` 에서 리셋(런당 1회). 닫기 버튼 배선. → **브라우저에서 llm.config 비활성 상태로 수집 실행해 팝업이 정확히 1회 뜨는지 육안 확인 필요.**
2. **폴백 발자국 시각/번호판 포함**: 폴백 사변형이 얕은 띠가 아닌 앞넓뒤좁 깊은 발자국(BAND 0.55)으로 그려지고, 번호판 bbox 가 사변형 안에 들어오는지 실측 프레임 오버레이로 시각 확인 권장(설계 §9 튜닝 대비).
3. **LLM off 시 floor ROI(초록영역) 생성**: no-op 폐기로 LLM 미가동에도 초록 영역이 생성·표시되는지 뷰어에서 확인.

이 3건은 순수 유닛으로 커버 불가(DOM/렌더/실측). **삭제·통과위장 없이 수동 항목으로 명시.**

---

## 5. 발견 이슈

- **구현 버그: 없음.** 설계·구현요약과 코드가 정합. 개별 실패 승격 조건은 설계 초안이 아니라 리더 확정본(구현요약 §B)과 일치함을 확인.
- **테스트 측 조정 2건(구현 문제 아님)**:
  - 기존 reviewer 테스트 2건(`brain 비활성 → no-op`, `메서드 부재 → no-op`)은 no-op 폐기로 **필연적 실패**. 설계 §7.2 지시대로 "폴백 생성 + llmUnavailable" 로 수정(느슨하게 푼 것이 아니라 새 사양에 맞춰 강화).
  - 신규 expand 포함 테스트에서 plate bottom=1.03(범위초과)을 clamp 인지 못한 초기 assert 오류 → clamp 되는 좌표를 기대에 반영해 plate 를 범위 내로 조정(테스트 오류 수정). clamp 자체는 별도 케이스9로 검증 유지.

---

## 6. 결론

설계 §7 유닛 케이스(폴백 발자국 형태 / expand 4방향·멱등·clamp·포함 / resolveFloorQuad+plate 3분기 / normalizeQuad 회귀 / reviewer 비활성·부재·미주입·throw·정상·정상+plate / maxPerCheckpoint) **전부 green**. 전체 회귀 426 pass, 타입체크 통과. UI 경고 모달·폴백 시각·초록영역은 수동확인 항목으로 이관.
