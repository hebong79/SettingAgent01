# SettingAgent 보완 — ROI 좌표 클램프 + LLM 단계 JSON 강건화

- 작성일: 2026-06-25
- 배경: 실서버 셋업 검증(`setup_artifact.json` 생성 성공) 중 발견한 2건 보완.

---

## 1. ROI 좌표 0~1 클램프 (#3)

**문제**: 번호판/차량 bbox 가 화면 경계를 넘으면 `normalizeBox` 결과가 0~1 을 벗어남
(실측 예: `plateRoiByPreset.x = -0.0015`).

**수정** (`src/domain/geometry.ts`):
- `clamp01(v)`, `clampRect(r)` 추가. `clampRect` 는 `x,y` 및 `x+w, y+h` 를 0~1 로 보정.
- `normalizeBox()` 가 결과를 `clampRect` 로 감싸 항상 0~1 보장.

**효과**: VPD/LPD 가 경계 초과 bbox 를 줘도 ROI 가 음수/1초과 없이 저장됨.

---

## 2. LLM 단계 JSON 강건화 (#2)

**문제**: gemma4 가 stage2(중복제거)에서 비-JSON(설명문)을 반환 → `게이트2 실패(JSON 없음)` → 중복 병합 누락.

**수정** (`src/brain/AgentRuntime.ts`):
- `chat()` 에 JSON 모드 추가 → 구조화 단계 호출 시 `response_format: { type: 'json_object' }` 전송(모델에 JSON 강제).
- `chatJson()` 헬퍼 신설: JSON 모드 호출 → `extractJson`+zod 파싱, **실패 시 1회 재시도**, 그래도 실패면 `null`(게이트 건너뜀 = 결정형 폴백).
- `judgePreset`/`dedupeAndLabel`/`finalReport` 3단계 모두 `chatJson` 사용으로 통일.

**효과**:
- 모델이 JSON 을 강제로 내도록 유도(Ollama OpenAI 호환 `response_format` 지원).
- 일시적 비-JSON 응답은 재시도로 복구, 끝내 실패해도 셋업은 비중단(결정형 결과 유지).

---

## 3. 동작 확인

- `npm run typecheck` → 에러 0
- `npm test` → **80/80 통과** (신규)
  - geometry: `clamp01`/`clampRect`/경계초과 `normalizeBox` 3건.
  - brainRetry: 비-JSON→재시도 성공, 2회 실패→null 2건.
- 기존 테스트 견고화: `mapTargets` 의 실 config 의존 테스트를 픽스처 기반으로 전환(camerapos 가 refreshOnRun 으로 바뀌어도 안정).

> 실 gemma4 대상 효과(게이트2 JSON 정상화·좌표 음수 제거)는 다음 실서버 셋업 재실행으로 최종 확인 권장.

---

## 4. 영향도

- `normalizeBox` 출력이 항상 0~1 → VpdClient/LpdClient 결과, RoiBuilder/plateMatch, 산출물 모두 안전(상위 호환).
- `chatJson` 은 내부 구현 변경(공개 메서드 시그니처 동일) → 호출부 영향 없음.
- `response_format` 미지원 엔드포인트일 경우 대비: 파싱 실패 시 재시도→null 폴백이 있어 안전.
- 남은 항목 #1(검출 과다·기대치 불일치)은 `preset.json` 갱신/장면 튜닝의 데이터 이슈로 별도.

---

## 5. 추가 보완 — stage3 JSON 모드 해제 (2번 방안) + 라이브 검증

**문제(2차 실행에서 발견)**: stage3 에 JSON 강제(`response_format`)를 적용하니, 긴 한글 리포트(`report_ko`)가
토큰 한도에서 잘려 JSON 무효 → 재시도 실패 → **리포트가 null**(누락)이 됨.

**수정**:
- `chatJson(..., jsonMode=true)` 파라미터 추가. stage1/2 는 JSON 강제 유지, **stage3(finalReport)만 jsonMode=false**
  (자유 텍스트 허용 → 잘려도 `extractJson` 가 회수, 재시도·null 폴백은 유지).
- 방어적으로 `llm.maxTokens` 2048 → **3072** 상향.
- 근거: stage1/2 는 기계 소비용 구조 결정이라 엄격 JSON 필수, stage3 는 사람이 읽는 긴 서술이라 JSON 강제가 오히려 취약.

**테스트**: `brainJsonMode.test.ts` — stage1/2 요청은 `response_format=json_object`, stage3 는 미설정 확인. 총 **81/81 통과**.

**라이브 검증(실 gemma4 재실행)**:
```
state=DONE  slots=18  globalCount=18
좌표 0~1 위반: 0 (OK)
게이트2 실패 경고: false
리포트 존재: true (477자, "주차장 셋업 결과 검토 보고서 ...")
```
→ 좌표 클램프·게이트2 강건화 유지 + **stage3 리포트 정상 복구** 확인.

> 참고: 슬롯 수가 실행마다 변동(27→18 등)하는 것은 VPD 검출/장면 상태에 따른 것으로, #1(데이터/장면 정합) 영역이다.
