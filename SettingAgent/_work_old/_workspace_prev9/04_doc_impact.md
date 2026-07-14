# 04. 영향도 분석 — 정밀수집 라운드 내 프리셋 이동 최소 1초 페이싱 (moveIntervalMs)

- **작성일시**: 2026-07-01 23:36:17
- **최종 문서**: `SettingAgent/docs/20260701_233617_정밀수집_프리셋이동_1초페이싱.md`
- **근거**: 01 설계 · 02 구현 · 03 검증 + 실제 코드 대조(CaptureJob.ts L183~203, toolsConfig.ts L61~71/L226, tools.config.json L53, index.ts L47).

---

## 1. 변경 표면(직접 수정 파일)

| 파일 | 성격 |
|------|------|
| `src/config/toolsConfig.ts` | 스키마(CaptureSchema) + DEFAULT_TOOLS_CONFIG 확장 |
| `config/tools.config.json` | 운영 설정값 명기 |
| `src/capture/CaptureJob.ts` | Deps 인터페이스 + 런타임 페이싱 로직 |
| `test/captureJob.test.ts` | 신규 페이싱 TC + fixture |
| `test/captureLiveRefresh.test.ts` · `test/checkpointFinalizer.test.ts` · `test/captureRoutes.test.ts` · `test/finalizerFloor.test.ts` | fixture 필드 정합 |

본 변경은 **SettingAgent 내부 로컬 변경**이다. `@parkagent/types` 공유 도메인 타입(SlotState/ParkingEvent 등), REST 계약(요청/응답 shape), 타 에이전트(ActionAgent/DMAgent)로의 파급은 **없다** — 아래 §5에서 근거 제시.

---

## 2. 타입 의존성 전파 (`ToolsConfig['capture']`)

`moveIntervalMs`는 `CaptureSchema`의 **필수 필드**(zod `.default()`가 있어도 `z.infer` 타입에는 필수로 나타남)로 추가되었다. 따라서 `ToolsConfig['capture']` 리터럴을 **직접 구성**하는 모든 지점은 필드를 넣어야 컴파일된다.

- **런타임 소비자**: `src/index.ts:47` `new CaptureJob({ ..., cfg: tools.capture, ... })` — `tools.capture`는 `loadToolsConfig` 산출물이므로 default(1000)가 주입된다. 리터럴 조립이 아니라 **타입·런타임 모두 안전**(무변경).
- **테스트 소비자(리터럴 조립)**: `captureJob` / `captureLiveRefresh` / `checkpointFinalizer` / `captureRoutes` / `finalizerFloor` 5개 test 파일이 `captureCfg` 리터럴을 직접 만든다 → **5건 모두 `moveIntervalMs: 1000` 추가 완료**(검증 시 컴파일·전체 통과로 확인).
- **Finalizer**: `src/index.ts:52`에서 동일 `cfg: tools.capture`를 공유하나 `moveIntervalMs`를 참조하지 않는다 → 동작 영향 없음(타입만 확장).

**확인 필요 없음**: 리포지토리 내 `ToolsConfig['capture']` 리터럴 조립 지점은 위 6곳(런타임 1 + 테스트 5)이 전부이며, 전체 vitest 477 통과 및 typecheck 통과로 누락 없음이 실측 확인됨.

---

## 3. 런타임 동작 영향

### 3.1 라운드 총시간 증가 (핵심)

페이싱 적용 시 라운드 총시간이 최대 **`(프리셋수 - 1) × moveIntervalMs`** 만큼 증가한다.

- 예: 프리셋 8개, 기본 1000ms → 라운드당 최대 **+7초**.
- 각 타깃 사이클(이동+캡처+검출)이 이미 `moveIntervalMs` 이상이면 해당 타깃의 증가분은 0(floor 특성). 실제 증가분은 `Σ max(0, moveIntervalMs - elapsed_i)` (마지막 타깃 제외).
- 마지막 타깃 뒤에는 패딩이 없어 라운드 간 대기와 중복되지 않는다.

### 3.2 `intervalMs`(라운드 주기)와의 관계 — 영향 없음

- `moveIntervalMs`는 **라운드 내부**만 늘린다. 라운드 간 대기(`setTimer(intervalMs)`)는 라운드 종료 후 별도로 동작하므로 로직 불변.
- 주의(운영 인지 사항, 버그 아님): 라운드 내부가 길어져 `intervalMs`보다 커질 수 있으나, 라운드 종료 후 `intervalMs` 대기는 그대로 수행된다. 즉 실효 라운드 주기 = (내부 소요 + intervalMs)로, 점유 변화 포착 주기가 사실상 늘어날 수 있다. 페이싱 요구의 의도된 트레이드오프.

### 3.3 종료 조건(count) · checkpoint — 영향 없음

- 라운드 카운트(`this.round`/`this.done`) 증가 로직, count 종료 조건, `checkpointEvery` 주기 판정 모두 **for 루프 이후** 수행되며 페이싱은 루프 내부에만 삽입됨 → 로직 불변.

### 3.4 stop 반응성 — 회귀 없음, 최악 지연 <1s

- 페이싱 sleep은 `this.currentState() !== 'stopping'` 게이트로 감싸 정지 요청 시 진입하지 않는다(즉시반응 유지).
- 단, **이미 진입한 `sleep(rest)` 도중 stop** 이 오면 해당 sleep(최대 `moveIntervalMs`ms) 종료 후 다음 for 반복 상단 `stopping` break로 종료된다. 기존 stop이 await 경계에서 반응하던 특성과 동일하며 **최악 지연 < moveIntervalMs(기본 1s)**. 허용 범위(검증 TC4로 게이트 동작 확인).

### 3.5 `moveBeforeCapture = false` — 미적용

- 게이트 조건 3(`this.deps.cfg.moveBeforeCapture`)에 의해 이동이 없는 모드에서는 페이싱이 적용되지 않는다. 설계서 §3 기본안("move=off에도 적용")에서 **리더 확정 A로 변경된 계약**이며, TC5b로 명시 검증됨.

---

## 4. monotonic 주입의 영향

- `CaptureJobDeps.monotonic?`는 **옵셔널**. `src/index.ts:47` 조립부는 이를 넘기지 않으므로 런타임은 `Date.now` 기본값 사용 → **운영 무변경**.
- 테스트에서만 가변 카운터를 주입해 elapsed를 결정적으로 제어. 기존 `sleep`/`now`/`setTimer` 주입 패턴과 동형이라 테스트 인프라 신규 도입 없음.
- **부작용 없음**: `monotonic`은 간격 산술 전용(숫자). 기존 `now: () => string`(ISO, 로그·DB 타임스탬프용)은 그대로 유지 → 로그/DB 시각 표기에 영향 없음.

---

## 5. 파급 범위 경계(전파되지 않는 것)

- **`@parkagent/types`**: 본 변경은 SettingAgent 로컬 `CaptureSchema`(toolsConfig)만 확장. 공유 도메인 타입 무변경 → ActionAgent/DMAgent 무영향.
- **REST 계약**: `/capture/*` 라우트의 요청/응답 shape 변경 없음. `moveIntervalMs`는 서버 내부 설정값이며 API 파라미터·응답 필드로 노출되지 않음 → 클라이언트(뷰어 UI)·기존 REST 테스트 무영향.
- **공유 도메인(SlotState/ParkingEvent 등)**: 미접촉.
- **DB 스키마/집계/검출(VPD·LPD)/Finalizer 산출물**: 미접촉(타이밍만 삽입, 데이터 흐름 불변).

---

## 6. 회귀 위험 평가

| 항목 | 위험 | 근거/완화 |
|------|------|-----------|
| 기존 테스트 fixture 컴파일 | 낮음 | 필수 필드 추가 → 5개 test fixture 반영 완료, vitest 477 통과 |
| 런타임 조립부 파손 | 없음 | `cfg: tools.capture`는 loadToolsConfig default 주입, `monotonic` 옵셔널 미전달 |
| stop 즉시반응 저하 | 낮음 | 게이트로 진입 차단, 최악 지연 <1s(TC4 통과) |
| 실효 라운드 주기 증가 | 중(의도된 트레이드오프) | §3.1/§3.2 — 운영 인지 필요, `moveIntervalMs=0`으로 원복 가능 |
| catch 흡수 타깃 이중 대기 | 없음 | 실패 시 elapsed 큼 → rest<=0 → sleep 생략(설계 §2, 구현 §4) |

---

## 7. 확인 필요 항목 (단정 회피)

- **실 시뮬레이터 동작확인 미실행**: 자동 유닛은 `sleep`/`monotonic` 모킹 기반이라 **실제 프리셋 이동 간격 ≈1초는 미검증**이다. 실 SettingAgent + Unity 시뮬레이터 가동 후 로그 `req_move` 타임스탬프 간격(≈1000ms)으로 반드시 확인해야 한다. 현재 상태 = **"수동 확인 필요"**(검증됨 아님).
- **실효 라운드 주기 정책**: §3.2의 "내부 소요 + intervalMs" 누적이 점유 변화 포착 주기 요구와 상충하는지는 운영 관점 판단 필요(코드 결함 아님).
