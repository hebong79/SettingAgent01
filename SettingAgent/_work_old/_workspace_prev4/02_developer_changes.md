# 02 구현 변경 요약 — 차량 바닥 점유영역(floor ROI) 생성 개선

구현자(developer). 설계서 `01_architect_plan.md` + 리더 확정 2건(경고신호 조건 · UI=메시지박스) 반영.
컴파일: `npm run typecheck`(tsc --noEmit) 통과 · `node --check web/app.js`, `web/core.js` 통과.

---

## 변경 파일 목록

| 파일 | 종류 | 핵심 |
|------|------|------|
| `src/capture/floorRoi.ts` | 순수 모듈 | 폴백 발자국화 · `expandQuadToContainRect` 신규 · `resolveFloorQuad(plate?)` 확장 |
| `src/capture/FloorRoiReviewer.ts` | 서비스 | no-op 삭제 · 항상 후보 루프 · `{ llmUnavailable }` 반환 · plate 포함 강제 |
| `src/capture/CaptureJob.ts` | 잡 | review 결과 수신 · `llmFloorUnavailable` 상태 표식 노출 |
| `src/capture/types.ts` | 타입 | `CaptureStatus.llmFloorUnavailable?` 필드 추가 |
| `web/core.d.ts` | 타입선언 | `CaptureStatus.llmFloorUnavailable?` 반영 |
| `web/index.html` | UI | floor ROI 경고 메시지박스(모달) 추가 |
| `web/app.js` | UI | 런당 1회 경고 팝업 · 닫기 버튼 · 시작 시 가드 리셋 |
| `web/app.css` | UI | 경고 박스 스타일(경고색 테두리·제목) |
| `config/prompts/floor_roi.yaml` | 프롬프트 | 번호판 포함 규약 2줄 추가 |

---

## A. `src/capture/floorRoi.ts`

### 폴백 상수 재조정 (설계 §2)
- `FALLBACK_BAND` 0.35 → **0.55**(차 길이만큼 깊은 발자국).
- `FALLBACK_INSET`(단일 0.1) 삭제 → **front/rear 분리**: `FALLBACK_FRONT_INSET=0.04`, `FALLBACK_REAR_INSET=0.22`.
- `fallbackQuadFromRect`: 앞변(하단)은 front inset 만큼만, 뒤변(상단)은 rear inset 으로 강하게 좁혀 앞넓·뒤좁 원근 사다리꼴. 순서 [앞왼,앞오,뒤오,뒤왼] · 각 좌표 `clamp01` 유지.

### 신규 순수함수 `expandQuadToContainRect(quad, rect)`
- rect(번호판 bbox) 4모서리를 quad 가 모두 포함하도록 **최소 확장**. `min`/`max` 만 사용 → rect 가 이미 내부면 **멱등**(축소 없음).
- 앞변 y = `clamp01(max(FL.y,FR.y,rb))`, 뒤변 y = `clamp01(min(RL.y,RR.y,rt))` — **변 단위 공통값**으로 통일해 평행(사다리꼴) 유지.
- 좌측 x = `min(·, rect.x)`, 우측 x = `max(·, rect.x+rect.w)`. 반환 순서 [FL,FR,RR,RL] 유지, 최종 clamp01.

### `resolveFloorQuad(llmQuad, vehicle, plate?)` 확장
- `base = normalizeQuad(llmQuad) ?? fallbackQuadFromRect(vehicle)` 후, plate 있으면 `expandQuadToContainRect(base, plate)`.
- **LLM·폴백 공통 경로**로 plate 포함 강제. plate 없으면 base 그대로(회귀 안전).
- `normalizeQuad`/`clamp01` **불변**.

---

## B. `src/capture/FloorRoiReviewer.ts`

- **36줄 no-op 삭제**: `if(!brain?.enabled||!brain.recognizeFloorRoi) return;` 제거 → brain 비활성이어도 후보 루프 진행(폴백으로 항상 생성).
- `llmUsable = !!(brain?.enabled && brain.recognizeFloorRoi)`. 슬롯 루프에서 `recognizeFloorRoi` 는 **`llmUsable && brain?.recognizeFloorRoi` 존재 시에만** 호출(없으면 quadRaw=null → 폴백).
- 카운터 추적: `attempted`(LLM 호출 시도 수), `succeeded`(유효 quad 반환 수). 개별 throw 는 catch 후 폴백(경고 승격 안 함).
- `resolveFloorQuad(quadRaw, vehicle, plate)` 로 plate 전달(R4).
- **반환형 `void` → `Promise<{ llmUnavailable: boolean }>`.**

### 경고 신호 조건 (리더 확정 반영)
```
llmUnavailable = !llmUsable || (attempted > 0 && succeeded === 0)
```
- `!llmUsable`: brain 비활성 또는 `recognizeFloorRoi` 메서드 부재.
- `attempted>0 && succeeded===0`: 시도했으나 전 슬롯 무효 quad(부분 실패 아님 = 전면 실패).
- `llmUnavailable` 시 `logger.warn({...}, 'floor ROI: LLM 비활성/불가 — 결정형 폴백 사용')` **1회**.
- 설계 §5 는 `!llmUsable` 만 경고로 봤으나, 리더 확정으로 `attempted>0 && succeeded===0`(호출은 되나 전부 실패) 케이스도 경고에 포함.

---

## C. `src/capture/CaptureJob.ts`

- 필드 `private llmFloorUnavailable = false;` 추가. `start()` 에서 매 런 초기화(latestAdvisory 초기화 옆).
- checkpoint 283줄: `const floorRes = await this.deps.floorReviewer.review(...)` 수신 → `floorRes.llmUnavailable` 이면 `this.llmFloorUnavailable = true`.
- `getStatus()` 에 `...(this.llmFloorUnavailable ? { llmFloorUnavailable: true } : {})` 노출 → app.js 가 status 로 읽어 메시지박스 표시.
- **설계 대비 편차**: 설계 §5 는 `latestAdvisory` 앞 경고라인 prepend(배너) 였으나, 리더 확정으로 **UI=메시지박스**. 배너 오염 없이 별도 상태 필드(`llmFloorUnavailable`)로 표식만 전달 → 클라이언트가 모달 표시. `latestAdvisory` 흐름은 미변경(최소 침습).

## `src/capture/types.ts` / `web/core.d.ts`
- `CaptureStatus` 에 `llmFloorUnavailable?: boolean` 추가(스키마 확장, 기존 필드 불변).

---

## D. web — UI 경고 = 메시지박스 (리더 확정)

- `web/index.html`: 결과 모달 다음에 `#floor-llm-warn-modal`(기존 `.modal`/`.modal-box` 인프라 재사용, 닫기 버튼 `#floor-llm-warn-close`). 문구: "⚠ … LLM이 동작하지 않아 바닥 점유영역을 자동(폴백)으로 생성했습니다. llm.config.json 확인이 필요합니다."
- `web/app.js`:
  - `floorLlmWarnShown` 가드 변수. `capPoll()` 에서 `status.llmFloorUnavailable && !floorLlmWarnShown` 이면 1회 모달 표시 후 가드 set → **매 폴링 반복 팝업 금지**.
  - `capStart()` 에서 `floorLlmWarnShown=false` 리셋(새 런당 1회).
  - 닫기 버튼 이벤트 배선.
- `web/app.css`: `.floor-llm-warn-box`(경고색 `--warn` 테두리) + 제목 색. 기존 모달 스타일 상속, 최소 추가.

---

## E. `config/prompts/floor_roi.yaml`

- "제외할 것" 블록 아래 **번호판 포함 규약 2줄** 추가(기존 문체 유지):
  - 번호판(노란 bbox) 주어지면 그 영역은 반드시 사변형 안에 포함되도록 앞/좌우 변을 충분히 잡아라.
  - 번호판 높이만큼 억지로 늘리지 말고 바닥 발자국을 자연스럽게 확장하라.

---

## 저장 계약 / 영향

- `NormalizedQuad` shape · `floorRoiByPreset` 저장 계약 · `upsertFloorRoi` 시그니처 **불변**(값 내용만 개선).
- `review` 반환형 `void → 객체`: 호출부는 CaptureJob 1곳 → 동시 수정 완료.
- `CaptureStatus` 필드 추가만(하위호환). ActionAgent/DMAgent 소비측 무영향.

## 검증자(qa-tester) 전달 노트

- 테스트 파일 미작성(다음 단계 담당). 설계 §7 케이스(폴백 발자국 형태 / expand 각 방향·멱등·clamp / resolveFloorQuad+plate / normalizeQuad 회귀 / reviewer 비활성·메서드부재·throw·정상+plate / maxPerCheckpoint) 대상.
- **경고신호 테스트 주의**: `llmUnavailable` 은 `!llmUsable` **또는** `attempted>0 && succeeded===0`. throw(개별 실패)만 있고 성공 0 이면 `attempted>0 && succeeded===0` 로 **true** 가 됨(설계 §7 케이스9 "throw → llmUnavailable:false" 와 상충 가능 → qa 는 리더 확정 조건 기준으로 검증할 것). 성공 quad 가 1개 이상이면 false.
