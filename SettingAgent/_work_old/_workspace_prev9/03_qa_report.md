# 03. 검증 보고 — 정밀수집 라운드 내 프리셋 이동 최소 1초 페이싱

## 실행 명령
```
cd SettingAgent
npx vitest run test/captureJob.test.ts   # 대상 파일
npx vitest run                           # 전체 회귀
npm run typecheck                        # tsc --noEmit
```

## 전체 결과 (pass/fail 그대로)
- **vitest 전체: Test Files 59 passed (59) / Tests 477 passed (477)** — 실패 0.
- **captureJob.test.ts: 21 passed** (기존 15 + 신규 페이싱 6).
- **typecheck: 통과(에러 없음)**. 초기 1건(`TS2493` — sleep spy 튜플 인덱싱) 발견 → 테스트 spy 시그니처 `vi.fn(async (_ms: number) => {})` 로 수정 후 통과.

## 검증 대상 구현
- `src/config/toolsConfig.ts`: CaptureSchema `moveIntervalMs`(기본 1000, 0=off).
- `src/capture/CaptureJob.ts`: `monotonic?: () => number` 주입(기본 Date.now) + runRound 인덱스 순회 페이싱.
  게이트(라인 199): `moveIntervalMs>0 && !isLast && cfg.moveBeforeCapture && state!=='stopping'` → `rest=moveIntervalMs-(monotonic()-t0)`, `rest>0` 이면 `sleep(rest)`.

## 페이싱 sleep 격리 근거
CaptureJob 내 `sleep()` 은 **페이싱 전용**이다. 라운드 간 대기는 `setTimer(intervalMs)`(라인 231), checkpoint 경로는 `sleep` 미사용. 따라서 `sleep` spy 호출 수 = 페이싱 호출 수로 그대로 계수 가능. 테스트는 라운드 1개(count=1) + checkpointEvery=99 로 라운드 간 대기·checkpoint 를 배제해 페이싱만 격리.

`monotonic` 은 가변 시계(`nowMs`)로 구동: `requestImage` 훅에서 타깃별 elapsed 만큼 `nowMs` 를 전진 → `t0 = 캡처 전 monotonic()`, 캡처 후 `monotonic() = t0 + elapsed` 가 결정적으로 성립.

## 검증 TC 목록 (설계 §5 TC1~5)
| TC | 시나리오 | 기대 | 결과 |
|----|----------|------|------|
| TC1 | 타깃2개, 각 elapsed=400, interval=1000 | 타깃1 뒤 `sleep(600)` 1회, 타깃2(마지막) 없음 → 총 1회, 인자 600 | PASS |
| TC2 | 타깃1 elapsed=1200(≥1000) | rest=-200 → 페이싱 sleep 미호출(0회) | PASS |
| TC3 | 타깃3개, 각 elapsed=100 | 타깃1·2 뒤 2회(타깃3 제외), 인자 각 900 | PASS |
| TC4 | 타깃1 캡처 시점 `stop()` | 페이싱 sleep 생략(0회) + 타깃2 진입 전 break → `stopped(manual)`, 다음 라운드 미예약 | PASS |
| TC5 | `moveIntervalMs=0` | 어떤 elapsed 여도 페이싱 sleep 0회 | PASS |
| TC5b | `moveBeforeCapture=false` (elapsed<interval) | 게이트 `cfg.moveBeforeCapture` 로 페이싱 미적용(0회) | PASS |

- TC1~3: floor 수식(`rest=interval-elapsed`, `rest>0`만 sleep, 초과분 패딩 없음) + 마지막 타깃 제외 검증.
- TC4: 정지 즉시반응 회귀 없음(`currentState()!=='stopping'` 게이트) — 기존 stop TC(§4-a)와 병존, 회귀 없음(477 전체 통과).
- TC5b: 설계 §3 기본안("move=off 여도 적용")이 아니라 **구현자 리더 확정 A**(게이트에 `moveBeforeCapture` 포함)를 반영. 구현 라인 199와 일치하므로 구현 기준으로 검증(불일치 아님).

## 경계면(구현↔설계) 교차 확인
- 설계서 §3 은 "move=off 여도 페이싱 적용"이 기본안이었으나, 구현(02_developer_changes §3, CaptureJob 라인 199)은 게이트에 `this.deps.cfg.moveBeforeCapture` 를 포함했다. 이는 설계서 §3 "리더 확인 A / 반대면 게이트 1줄 추가로 전환"의 확정 반영으로, **구현 버그가 아니라 확정 결정**으로 판단. 테스트는 구현 계약(게이트 포함)에 맞춰 TC5b 로 명시 검증. developer 재보고(SendMessage) 불요.
- `captureCfg` fixture(테스트 5건)에 `moveIntervalMs: 1000` 이 이미 반영되어 스키마 필수 필드(`ToolsConfig['capture']`) 정합 확인.

## 수동 확인 항목 (스모크 — 미실행, 누락 명시)
자동 유닛은 `sleep`/`monotonic` 을 모킹하므로 **실제 시뮬레이터 이동 간격 1초**는 검증 범위 밖이다. 아래는 실제 SettingAgent + Unity 시뮬레이터 가동 시 수동 확인 필요:
- **로그 `req_move` 타임스탬프 간격 ≈ 1s**: 정밀수집 라운드 내 연속 프리셋 이동(`camera.move` → `/req_move`) 발화 시각 간격이 ≈1000ms 이상(기존 ~0.6초 버스트 완화)인지 로그로 확인.
- 한 타깃 사이클(이동+캡처+검출)이 이미 1초↑이면 추가 대기 없이 즉시 다음 타깃으로 넘어가는지(패딩 없음) 로그 간격으로 확인.
- **상태**: 외부 시뮬레이터 미가동으로 본 검증 세션에서 스모크 미수행. 유닛(모킹)만 완료.

## 발견 이슈
1. **(수정 완료) 테스트 typecheck 오류 TS2493**: `sleepSpy.mock.calls.map((c)=>c[0])` 에서 `vi.fn(async ()=>{})` 의 호출 튜플이 `[]` 로 추론되어 인덱스 접근 불가. TC3 의 spy 를 `vi.fn(async (_ms: number)=>{})` 로 시그니처만 부여해 해결. 구현 코드 변경 아님(테스트 한정).
2. **구현 버그 없음**. 설계 TC1~5 전부 통과, 전체 회귀 무손상.

## 산출물
- 테스트: `SettingAgent/test/captureJob.test.ts` — describe "CaptureJob 라운드 내 프리셋 이동 페이싱 (moveIntervalMs, TC1~5)" (6 케이스 추가).
- 본 보고서: `SettingAgent/_workspace/03_qa_report.md`.
