# 04. 영향도 분석 — 점유영역 사다리꼴 표시(번호판 앵커) + 겹침 회피 자동 폭 스케일

> documenter 산출물. 2026-07-16. `01_architect_plan.md §8` 을 그대로 인용하지 않고 **최종 구현 기준으로 재검증**했다.
> 검증 방법: 소비처를 실제 grep/Read 로 확인(에이전트 조사, 300단어 보고 기반 + documenter 직접 대조) + git diff 로 실 변경분 대조.

---

## 1. `computeOccupancy`(web/core.js) 반환 확장(`plateQuad` additive)의 파급

### 1-1. 실제 호출부 전수 (grep 확인)

| 호출부 | 소비 필드 | 영향 |
|---|---|---|
| `web/occupancy.js:149` `OccupancyJudge.judge` | 전체 행(occupied 여부로 분기 후 `r.center`/`r.plateQuad` 사용) | **영향 있음(의도된 확장)** — plate 행에 `plateQuad` 전달(:151) |
| `web/core.js:608` `buildFlatSlotRows` | `o.idx`, `o.occupied` 만 | 무영향(확인됨) |
| `test/computeOccupancy.test.ts` | occupied 행은 `toMatchObject`(예: :64,81,83), 비점유 행은 `toEqual`(예: :68,119)이나 비점유 행엔 애초 `plateQuad` 가 붙지 않음 | 무영향(확인됨) — 수정 불요, 실측 통과 |
| `test/lpdFilterRegression.test.ts:79-80,236` | `{idx,occupied}` 로 투영 또는 `.occupied` bool 만 | 무영향(확인됨) |
| `test/occupancyJudge.test.ts:53-55` (T1) | `computeOccupancy(...)` 결과를 `toEqual` 로 **행 전체** 비교 | **영향 있음 — 유일한 수정 지점**. `base` 를 `{idx,occupied,center}` 로 투영하도록 보정 완료(git diff 확인). 설계 §8 예측과 일치, 다른 파일에서 추가 보정 필요 지점은 발견되지 않음 |
| `test/occupancyRegion.test.ts:289` (T13) | `plateQuad` 필드 자체를 검증 대상으로 사용 | 신규 테스트 — 영향 아님(추가분) |

**결론**: 설계서 §8 의 "T1 한 곳만" 주장은 **최종 구현에서도 유효**함을 직접 grep+git diff 로 재확인했다. 추가 회귀 지점 없음.

### 1-2. `state.occComputeByKey` 소비처 (`region` additive)

`web/app.js:379-388` (`updateLogicOccupancy`) 에서 `spaces[i]` 에 `region` 필드를 additive 로 추가(`id, occupied, source, center, vehicleRect` 기존 필드는 그대로 유지 — git diff 로 확인).

| 소비처 | 필드 사용 | 영향 |
|---|---|---|
| `web/app.js` `drawOccupancyOverlay`(:399~) | `sp.region` 신규 소비(면 레이어 렌더) + 기존 `sp.occupied/source/vehicleRect/center` 그대로 | 의도된 확장. 기존 원/배지 렌더 순서·스타일 무변경(사다리꼴이 먼저 그려지고 원이 그 위에 남음) |
| `web/app.js:1961-1966` `buildFinalizeOccupancy` | `{ idx: s.id, occupied: !!s.occupied }` 로 **명시적 투영**(git diff 미변경 확인, region/plateQuad 미포함) | **무영향** — 최종화 바디(서버 POST)에 `region`/`plateQuad` 가 섞여 나가지 않음. 서버·DB 계약 변경 없음 |

**결론**: `region` 은 뷰어 렌더 전용 additive 필드이며, 서버로 전송되는 최종화 스냅샷(`buildFinalizeOccupancy`)은 여전히 `{idx, occupied}` 두 필드만 투영한다 — 계약 영향 없음을 코드로 직접 확인.

---

## 2. 기존 테스트 회귀 실측

| 항목 | 수치 | 출처 |
|---|---|---|
| 최종(5차) 게이트 | `npx vitest run` → 151 files / 1660 tests 전량 통과, `npx tsc --noEmit` → exit 0 | `03_qa_report.md` §6(5차 이터레이션), 4차 개발자 보고(§4)와 일치 |
| 회귀 지점 | `occupancyJudge.test.ts` T1 투영 보정 **1곳** | §1-1 로 직접 재확인(git diff) |
| 신규 테스트 | `occupancyRegion.test.ts` 18케이스(T1~T18) 전량 통과 | 동일 게이트 통과분에 포함 |
| 회귀 0 | 위 외 기존 파일 diff 없음 | `git status`(SettingAgent/test 하위 변경 파일이 `occupancyJudge.test.ts` 1개뿐임을 확인) |

`_workspace/03_qa_report.md` 1차·3차·5차 이터레이션 각각에서 검증자가 **독립 재실행**한 vitest/tsc 결과가 구현자 보고와 매 회 일치 — 위장/스킵 정황 없음.

---

## 3. 서버(src/)·DB·라우트·어셈블리 계약 영향

- `web/occupancyRegion.js`·`.d.ts` 는 **신규 파일**이며 브라우저 ESM 단일 소스. `SettingAgent/src/`(TypeScript 서버) 하위에서 `occupancyRegion` 참조는 없음(grep 확인) — 서버 코드 무변경.
- **주의(혼동 방지용 기록)**: `plateQuad` 라는 필드명이 `SettingAgent/src/capture/{Aggregator,Finalizer,floorRoi,FloorRoiReviewer,SqliteStore}.ts`·`types.ts:66` 에 **이미 존재**한다. 이는 이번 세션과 무관한 **기존 필드**로, 캡처/최종화 파이프라인의 `AggregatedSlot` 도메인에 속한다. 이번 세션에서 추가한 `web/core.js`·`web/occupancy.js` 의 `plateQuad`(occupied 행에 매칭 번호판 quad 를 얹는 브라우저 전용 additive 필드)와는 **동일 이름·별개 코드 경로**다. `web/*.js` → `src/*.ts` import 관계가 없으므로(뷰어는 빌드 없이 브라우저가 직접 ESM 로드, `01_architect_plan.md §4` 근거) 타입 충돌·런타임 충돌은 없다. 다만 향후 두 `plateQuad` 를 동일 개념으로 착각할 위험이 있어 문서로 명시해 둔다.
- DB(`parking_slots` 등)·REST 라우트(`/capture/*`)·HTML 신규 UI 변경 없음 — `git status` 로 `SettingAgent/src/`, `*.html` 하위 변경 파일이 없음을 확인.
- 결론: **서버/DB/라우트 계약 영향 없음**(확인됨, 추측 아님).

---

## 4. 성능 영향

`computeOccupancyRegions` 는 프레임(프리셋 전환)당 1회 호출된다.

- 1단계(전역 이진탐색): `BINARY_ITERS=12`(코드 상수 확인, `occupancyRegion.js:28`) × O(N²) 쌍별 `convexIntersectionArea`(클립 다각형 정점 k≤8) → O(12·N²·k²).
- 2단계(폴백, 하한에서도 겹칠 때만): 최대 20회 × O(N²).
- N(프리셋당 plate 점유면)은 실측 3프레임에서 3~6(cam1 p1=6·p2=5·p3=3) — 설계 추정 "≤ 약 30"과 정합적인 규모.
- 3fps 렌더 루프에서 프레임당 마이크로초~저밀리초 대 연산이므로 체감 성능 영향 없음. 실측 프레임(1차·3차·5차 검증) 전부 **1단계 상한(4.0) 즉시 채택**으로 종료돼, 실제로는 대부분 O(N²) 단일 패스만 소모됐다(이진탐색조차 미작동) — 설계 추정보다 유리한 실측치.
- 스트레스(합성 밀착) 케이스에서만 2단계 20회 폴백이 발동 — 정상 주차 밀도에서는 드문 경로.

**결론**: 설계 §3-3 의 복잡도 추정이 실측과 부합하며, 성능 영향은 무시 가능한 수준(확인됨).

---

## 5. `.claude/` 하네스 변경 영향

`git status` 로 실제 변경분 확인:

| 파일 | 변경 | 확인 |
|---|---|---|
| `.claude/skills/model-routing/` | **신규** 스킬 디렉터리 | `git status` `??` 로 신규 확인 |
| `.claude/skills/parkagent-dev/SKILL.md` | 수정(참조 갱신) | `git status` `M` |
| `.claude/agents/architect.md` | `model: opus` → `model: fable` | `git diff` 로 실측 확인 |
| `.claude/agents/qa-tester.md` | `model: sonnet` → `model: opus` | `git diff` 로 실측 확인 |
| `.claude/agents/developer.md`·`documenter.md` | 이번 diff 에 **미포함**(변경 없음) | `git status` 대상 목록에 없음 — 기존 값(opus/sonnet)이 model-routing 규칙과 이미 합치했던 것으로 판단됨(추가 확인 필요 시 별도 점검 권고) |

**영향**: 이번 4인 팀 실행(architect=fable, developer=opus, qa-tester=opus, documenter=sonnet)은 `model-routing` 스킬이 신규 도입된 이후 첫 적용 사례다. 코드 산출물(`web/occupancyRegion.js` 등)과는 독립적인 하네스 설정 변경이며, 기능 코드의 동작에는 영향을 주지 않는다 — 오케스트레이션 계층에만 적용됨.

---

## 6. 종합

| 영역 | 영향 | 근거 |
|---|---|---|
| `computeOccupancy` 소비처 | 회귀 1곳(`occupancyJudge.test.ts` T1), 그 외 무영향 | §1-1 grep+git diff 재확인 |
| `state.occComputeByKey` 소비처 | additive만, 서버 전송 스냅샷 무영향 | §1-2 `buildFinalizeOccupancy` 코드 직접 확인 |
| 기존 테스트 전체 | 151 files/1660 tests, 회귀 0 | §2, 3회 독립 재실행 일치 |
| 서버·DB·라우트 | 변경 없음(단, `plateQuad` 동명이의 필드 혼동 주의) | §3 |
| 성능 | 무시 가능(실측상 1단계 즉시 종료가 대부분) | §4 |
| 하네스(`.claude/`) | model-routing 신규 적용, 코드 동작과 독립 | §5 |

**확인 필요로 남긴 항목**: `.claude/agents/developer.md`·`documenter.md` 의 model 값이 이번 세션 이전부터 opus/sonnet 이었는지, 아니면 더 이전 커밋에서 이미 정렬된 것인지는 이번 diff 범위에서 확인되지 않음(변경 파일 목록에 없어 "무변경"으로만 판단 가능, 그 이전 이력은 미조사).
