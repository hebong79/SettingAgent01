# 01. 설계서 — 정밀수집(CaptureJob) 라운드 내 프리셋 이동 최소 1초 페이싱

## 0. 요구 요약 (사용자 확정)
- 라운드 내 타깃(프리셋) 순회 시 **연속 프리셋 이동 사이 최소 1초 간격**(현재 ~0.6초 버스트 → 완화).
- 한 타깃 사이클(이동+캡처+검출)이 **이미 1초 이상 걸렸으면 추가 대기 없이 즉시** 다음 타깃으로.
  즉 1초는 **최소 간격(floor)**, 초과분엔 패딩 없음: `sleep(max(0, moveIntervalMs - elapsed))`.
- 이동↔캡처 사이 settle 이 아니라 **타깃 간 이동 간격**. 이동 후에는 기존처럼 즉시 캡처.

## 1. 설정값 추가 — `moveIntervalMs`
- **CaptureSchema**(`src/config/toolsConfig.ts`)에 필드 추가:
  ```ts
  /** 라운드 내 프리셋 이동 최소 간격(ms, floor). 한 타깃 사이클이 이 값보다 짧으면
   *  남은 시간만큼 대기해 연속 이동이 버스트되지 않게 한다. 0 이면 페이싱 없음(기존 동작). */
  moveIntervalMs: z.number().int().nonnegative().default(1000),
  ```
- **DEFAULT_TOOLS_CONFIG.capture** 에 `moveIntervalMs: 1000` 추가.
- **config/tools.config.json** 의 `capture` 섹션에 `"moveIntervalMs": 1000` 추가.
  (loadToolsConfig 는 섹션 단위 `{...DEFAULT, ...raw}` 병합 → 명시하지 않아도 기본값 주입되나, 운영 가시성 위해 명기.)
- 검증: `intervalMs`(라운드 간 30000) 와 별개임을 주석·명명으로 구분. 혼동 없게 `moveIntervalMs`(타깃 간) vs `intervalMs`(라운드 간).

## 2. runRound 페이싱 로직 (`src/capture/CaptureJob.ts` runRound, 179~188 for 루프)
현재:
```ts
for (const t of this.params.targets) {
  if (this.currentState() === 'stopping') break;
  try { await this.captureTarget(this.runId, roundIdx, t); }
  catch (e) { logger.warn(...); }
}
```
변경(외과적, 인덱스 순회로 "마지막 타깃 제외" 판정):
```ts
const targets = this.params.targets;
const moveIntervalMs = this.deps.cfg.moveIntervalMs;
for (let i = 0; i < targets.length; i++) {
  const t = targets[i];
  if (this.currentState() === 'stopping') break;
  const t0 = this.monotonic();                 // 이동 시작 시점(captureTarget 진입 직전 ≈ move 직전)
  try { await this.captureTarget(this.runId, roundIdx, t); }
  catch (e) { logger.warn({ err: e, cam: t.camIdx, preset: t.presetIdx }, '캡처 라운드 프리셋 실패(흡수)'); }
  // 타깃 간 이동 페이싱: 마지막 타깃 뒤엔 불필요(라운드는 intervalMs 로 대기).
  // stop 요청 중이면 대기 생략(정지 즉시반응 유지).
  const isLast = i === targets.length - 1;
  if (moveIntervalMs > 0 && !isLast && this.currentState() !== 'stopping') {
    const rest = moveIntervalMs - (this.monotonic() - t0);
    if (rest > 0) await this.sleep(rest);
  }
}
```
포인트:
- **t0 = captureTarget 진입 직전**(move 직전). "이동 간격" 정의에 맞춰 이동 시작 기준 측정. elapsed 는 캡처+검출 포함 사이클 전체.
- **floor 수식**: `rest = moveIntervalMs - elapsed`, `rest > 0` 일 때만 sleep. elapsed >= interval 이면 sleep 미호출(즉시 다음).
- **마지막 타깃 제외**: `isLast` 이면 패딩 안 함. 라운드 종료 후 어차피 `intervalMs` 대기(216).
- **catch 로 흡수된 타깃도 페이싱 적용**: elapsed 가 이미 크면 rest<=0 → sleep 생략되므로 무해. 별도 분기 불필요(단순함).

## 3. moveBeforeCapture=off 시 정책
- **무조건 적용**(move 여부와 무관하게 페이싱). 근거:
  - 사용자 확정은 "타깃 간 이동 간격"이지만 실 목적은 **버스트 완화**(연속 사이클 사이 간격 확보). move=off 여도 requestImage 는 매 타깃 발생하므로 페이싱 이득 있음.
  - move 여부로 분기하면 코드·테스트 복잡도만 증가(규칙 2 단순함). elapsed 기반이라 move 없어 사이클이 짧으면 rest 만 커질 뿐 동작 일관.
  - `moveIntervalMs=0` 으로 페이싱 자체를 끌 수 있어 유연성은 설정으로 충분.
- **미해결 → 리더 확인 A**: "move=off 인데도 1초 페이싱"이 의도와 맞는지. (설계 기본: 적용. 반대면 `&& cfg.moveBeforeCapture` 게이트 1줄 추가로 전환.)

## 4. monotonic 시계 주입 (테스트 결정성)
- `now: () => string`(ISO)는 간격 산술에 부적합 → **숫자 단조 시계** 별도 주입.
- **CaptureJobDeps** 에 추가: `monotonic?: () => number;`
- 생성자: `this.monotonic = deps.monotonic ?? (() => Date.now());`
- 필드: `private readonly monotonic: () => number;`
- 근거: 기존 `sleep`/`now`/`setTimer` 주입 패턴과 동형. `Date.now` 기본으로 운영 무변경, 테스트는 카운터 주입해 elapsed 를 결정적으로 제어.
- **주의**: `sleep` 은 테스트에서 실제 대기하지 않으므로(mock), monotonic 은 sleep 과 독립적으로 호출 시점 값 반환 → 테스트가 captureTarget 소요를 직접 지정 가능.

## 5. 검증 유닛테스트 (`test/captureJob.test.ts` 신규 describe: "라운드 내 프리셋 이동 페이싱")
공통: `sleep` 을 spy(`vi.fn(async () => {})`)로 교체해 **호출 여부·인자(잔여 ms)** 검증. `monotonic` 은 배열/카운터로 사이클별 elapsed 주입.
`captureCfg.moveIntervalMs = 1000`(케이스별 오버라이드).

- **TC1 elapsed<interval → sleep 호출·잔여 정확**: 타깃1 사이클 elapsed=400ms(monotonic: t0=0, 종료=400) → 타깃1 뒤 `sleep(600)` 1회. 2타깃이면 타깃2(마지막)는 sleep 없음 → `sleep` 총 1회, 인자 600.
- **TC2 elapsed>=interval → sleep 미호출**: 타깃1 elapsed=1200ms → rest=-200 → sleep 미호출. 마지막 타깃도 미호출 → `sleep` 0회(페이싱 sleep 기준).
- **TC3 마지막 타깃 패딩 없음**: 타깃 3개, 각 elapsed=100ms → sleep 은 타깃1·2 뒤 2회만(타깃3 제외), 인자 각 900.
- **TC4 stopping 중 sleep 생략**: 타깃1 캡처 시점(요구는 stop 반영) `job.stop()` → 타깃1 뒤 페이싱 sleep 생략(정지 즉시반응). 기존 §4-a stop break 테스트와 병존(회귀 없음). 검증: 페이싱 `sleep` 0회 + state='stopped'.
- **TC5 moveIntervalMs=0 → 페이싱 없음**: cfg.moveIntervalMs=0 → 어떤 elapsed 여도 페이싱 sleep 0회(기존 동작).
- **주의(격리)**: 기존 테스트들은 `sleep: async () => {}` 를 주입 중 → 페이싱 sleep 이 섞여도 무해(대기 0). 단 **TC 에서 sleep 호출 카운트**는 페이싱 목적 호출만 계수되도록, 현재 CaptureJob 내 다른 sleep 사용처 없음 확인(captureTarget/checkpoint 에 sleep 미사용) → sleep 호출=페이싱 전용. 안전.
- fake timers 불요(sleep mock 즉시 resolve). 기존 `makeManualTimers` 그대로 사용.

## 6. 영향 받는 파일/모듈
| 파일 | 변경 |
|------|------|
| `src/config/toolsConfig.ts` | CaptureSchema `moveIntervalMs` 필드 + DEFAULT_TOOLS_CONFIG.capture 기본값 |
| `config/tools.config.json` | capture 섹션 `moveIntervalMs: 1000` 명기 |
| `src/capture/CaptureJob.ts` | Deps `monotonic?`, 생성자·필드, runRound for 루프 페이싱 |
| `test/captureJob.test.ts` | 페이싱 describe(TC1~5), 기존 `captureCfg` 에 moveIntervalMs 추가 |

- **CaptureJobDeps 소비자 회귀**: `monotonic` 옵셔널이라 기존 생성부(server/captureRoutes 조립) 무변경. `captureCfg` 리터럴에 `moveIntervalMs` 누락 시 **타입 에러**(Schema 는 default 있으나 `ToolsConfig['capture']` 타입은 필수 필드) → 테스트 fixture·실 조립부 모두 값 필요. **조립부 점검 필요**: capture cfg 는 `loadToolsConfig` 산출물이라 default 주입되어 런타임 OK, 타입상 `ToolsConfig['capture']` 는 moveIntervalMs 포함 → 문제 없음. 단 테스트 `captureCfg` 리터럴은 필드 추가 필수.
- **동작 영향(핵심)**: 라운드 총시간 증가 = 최대 `(프리셋수 - 1) × moveIntervalMs`. 예 프리셋 8개·기본 1000ms → 라운드당 최대 +7초. 사이클이 이미 1초↑면 증가 0. `intervalMs`(라운드 주기)와 무관(라운드 내부만 늘어남) — count 종료 조건·checkpoint 주기 로직 불변.
- **stop 반응성**: 페이싱 sleep 도 stopping 게이트로 감싸 정지 즉시반응 회귀 없음. 단 **이미 진입한 sleep(rest) 도중 stop** 은 해당 sleep 이 끝난 뒤 다음 for 반복 상단 break 로 종료(기존 stop 이 await 경계에서 반응하는 것과 동일 특성) → 최악 지연 <1초. 허용.

## 7. MCP 도구 vs LLM 두뇌 경계
- 본 변경은 **결정형 타이밍 로직**(고정 floor 간격, 수치 산술) → CaptureJob 내부 결정형 처리. LLM 개입 없음. 경계 신설 없음.

## 8. 미해결/가정 — 리더 확인 포인트
- **확인 A(§3)**: moveBeforeCapture=off 에도 페이싱 적용? 기본 설계는 "적용". 반대면 게이트 1줄로 전환.
- **가정 B**: 페이싱은 **라운드 내부**에만(라운드 간은 기존 intervalMs 유지). 마지막 타깃 뒤 패딩 없음이 이를 보장.
- **가정 C**: elapsed 는 캡처+검출(VPD/LPD) 포함 전체 사이클. t0 은 captureTarget 진입 직전(= move 직전) 고정.
- **가정 D**: sleep mock 상 monotonic 은 호출 시점 값만 반환하면 되며 sleep 지속과 무관(테스트가 elapsed 를 직접 지정).
