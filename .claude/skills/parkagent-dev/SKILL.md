---
name: parkagent-dev
description: ParkAgent(SettingAgent/ActionAgent/DMAgent) 코드 개발을 4인 에이전트 팀으로 수행하는 오케스트레이터. TypeScript 기능 구현·버그 수정·리팩토링·MCP 도구/REST 클라이언트 작성 요청 시 반드시 사용한다. 설계→구현→검증(vitest)→한글 문서화·영향도 분석 파이프라인을 자동 실행. "기능 추가", "버그 수정", "리팩토링", "에이전트 구현", "MCP 도구 만들기", "다시 실행", "재실행", "업데이트", "수정", "보완", "이전 결과 기반으로", "개발 팀으로" 같은 요청에 트리거. 단순 질문·조회는 직접 응답.
---

# ParkAgent 개발 오케스트레이터

ParkAgent 코드 개발을 **4인 에이전트 팀**으로 조율한다. CLAUDE.md 5대 규칙(설계→유닛테스트→동작확인→한글문서화→영향도분석)을 파이프라인으로 실행한다.

## 실행 모드: 에이전트 팀 (생성-검증 파이프라인)

| 단계 | 에이전트 | 타입 | 산출물 |
|------|----------|------|--------|
| 1. 설계 | architect | Plan | `_workspace/01_architect_plan.md` |
| 2. 구현 | developer | general-purpose | 소스 + `_workspace/02_developer_changes.md` |
| 3. 검증 | qa-tester | general-purpose | 테스트 + `_workspace/03_qa_report.md` |
| 4. 문서·영향도 | documenter | general-purpose | `*/docs/yyyyMMdd_hhmmss_*.md` + `_workspace/04_doc_impact.md` |

**모든 Agent 호출에 `model: "opus"` 필수.** 구현↔검증은 통과까지 루프.

## Phase 0: 컨텍스트 확인

작업 시작 전 실행 모드를 판별한다:
- `_workspace/` 존재 + 부분 수정 요청 → **부분 재실행**(해당 에이전트만 재호출)
- `_workspace/` 존재 + 새 입력 → **새 실행**(기존 `_workspace/`를 `_workspace_prev/`로 이동)
- `_workspace/` 미존재 → **초기 실행**

작업 대상 에이전트(Setting/Action/DM)와 범위를 파악하고, 관련 설계서를 먼저 읽는다.

## Phase 1: 팀 구성 및 작업 할당

1. `TeamCreate`로 4인 팀 구성(architect, developer, qa-tester, documenter).
2. `TaskCreate`로 의존성 있는 작업 생성: 설계 → 구현 → 검증 → 문서. 구현·검증은 양방향 의존(루프).
3. 작업 디렉토리 하위 `_workspace/`에 중간 산출물 저장. 파일명: `{단계번호}_{에이전트}_{산출물}.md`.

## Phase 2: 파이프라인 실행

1. **설계자**가 계획 수립 → `01_architect_plan.md`.
2. **구현자**가 계획대로 구현 → 소스 + `02_developer_changes.md`. 계획 결함 발견 시 설계자와 합의.
3. **검증자**가 vitest 작성/실행 → `03_qa_report.md`. 실패 시 구현자에게 보고, **통과까지 구현↔검증 루프**.
4. **문서화**가 01~03 + 코드를 종합 → 한글 `*/docs/yyyyMMdd_hhmmss_*.md` + `04_doc_impact.md`.

팀원은 `SendMessage`로 실시간 조율, `TaskUpdate`로 진행 공유, 파일로 산출물 전달.

## Phase 3: 종합 및 보고

리더가 결과를 종합해 사용자에게 보고: 변경 요약, 테스트 결과(통과/실패 그대로), 생성 문서 경로, 영향도 요약. `_workspace/`는 사후 감사용으로 보존.

## 데이터 전달 프로토콜

- **태스크 기반**(조율): `TaskCreate`/`TaskUpdate` — 의존 관계·진행 추적.
- **파일 기반**(산출물): `_workspace/{phase}_{agent}_{artifact}.md` — 단계 간 전달, 감사 추적.
- **메시지 기반**(실시간): `SendMessage` — 구현↔검증 루프, 설계 합의.

## 에러 핸들링

- 외부 서비스 미가동으로 스모크 불가 → 유닛(모킹)만 수행, 스모크는 보고서에 **누락 명시**(통과 위장 금지).
- 에이전트 1회 재시도 후 재실패 → 해당 결과 없이 진행하되 누락을 보고서에 명시.
- 상충 데이터(설계 vs 기존 코드)는 삭제하지 않고 출처 병기.
- 요청이 모호하면 설계자가 해석안을 제시하고 리더가 사용자에게 확인.

## 테스트 시나리오

**정상 흐름**: "ActionAgent에 LPR 호출 재시도 로직 추가" → 설계자가 `centering.run` 도구 경계·백오프 정책 계획 → 구현자가 `fetchWithLog` 패턴으로 구현 → 검증자가 LPR 모킹으로 재시도 테스트 작성/통과 → 문서화가 한글 문서 + LPR 클라이언트 영향도 작성.

**에러 흐름**: 검증자가 1-based/0-based 인덱스 불일치를 경계면 교차 비교로 발견 → 구현자에게 보고 → 구현자 수정 → 재검증 통과 → 문서에 발견 버그·수정 내역 기록.

## 후속 작업

description의 후속 키워드("다시 실행", "재실행", "업데이트", "수정", "보완")로 트리거된다. Phase 0에서 부분/새/초기 실행을 판별하고, 각 에이전트는 이전 산출물이 있으면 읽고 개선점만 반영한다.
