# 02. 구현 변경 요약 — 정밀수집 라운드 내 프리셋 이동 최소 1초 페이싱

## 개요
정밀수집(CaptureJob) 한 라운드 안에서 프리셋(타깃) 순회 시, 연속 프리셋 이동 사이에
**최소 간격(floor)**을 두어 ~0.6초 버스트를 완화한다. 한 타깃 사이클(이동+캡처+검출)이
이미 `moveIntervalMs` 이상 걸렸으면 추가 대기 없이 즉시 다음 타깃으로 넘어간다.

## 변경 파일
| 파일 | 변경 내용 |
|------|----------|
| `src/config/toolsConfig.ts` | CaptureSchema 에 `moveIntervalMs` 필드 추가 + DEFAULT_TOOLS_CONFIG.capture 기본값 |
| `config/tools.config.json` | capture 섹션에 `"moveIntervalMs": 1000` 명기(운영 가시성) |
| `src/capture/CaptureJob.ts` | Deps `monotonic?` 주입 + 필드/생성자 + runRound for 루프 페이싱 |
| `test/captureJob.test.ts` | `captureCfg` fixture 에 `moveIntervalMs: 1000` 추가 |
| `test/captureLiveRefresh.test.ts` | 동일 fixture 필드 추가 |
| `test/checkpointFinalizer.test.ts` | 동일 fixture 필드 추가 |
| `test/captureRoutes.test.ts` | 동일 fixture 필드 추가 |
| `test/finalizerFloor.test.ts` | 동일 fixture 필드 추가 |

> 테스트 fixture 5건은 스키마 필수 필드(`ToolsConfig['capture']`) 추가로 인한 **기계적 컴파일 정합**만 수행.
> 페이싱 검증 테스트(TC1~5) 신규 작성은 qa-tester 담당(미포함).

## 1. 설정값 — `moveIntervalMs`
```ts
// CaptureSchema
moveIntervalMs: z.number().int().nonnegative().default(1000),
```
- **의미**: 라운드 내 프리셋 이동 최소 간격(ms, floor). `intervalMs`(라운드 **간** 30000)와 구분.
- `0` 이면 페이싱 off(기존 동작).
- DEFAULT_TOOLS_CONFIG.capture 및 `config/tools.config.json` capture 섹션에 `1000` 반영.
  (loadToolsConfig 는 섹션 병합으로 default 를 주입하므로 JSON 명기는 가시성 목적.)

## 2. monotonic 시계 주입 (테스트 결정성)
- `now: () => string`(ISO)는 간격 산술에 부적합 → 숫자 단조 시계 별도 주입.
- CaptureJobDeps 에 `monotonic?: () => number;` 추가(옵셔널 → 기존 조립부 무변경).
- 생성자: `this.monotonic = deps.monotonic ?? (() => Date.now());`
- 필드: `private readonly monotonic: () => number;`
- 기존 `sleep`/`now`/`setTimer` 주입 패턴과 동형. 운영은 `Date.now` 로 무변경.

## 3. runRound 페이싱 (수정 지점: 타깃 순회 for 루프)
`for...of` → **인덱스 순회**로 교체(마지막 타깃 판정 위함). 각 타깃:
```ts
const t0 = this.monotonic();            // 이동 시작 시점(captureTarget 진입 직전 ≈ move 직전)
try { await this.captureTarget(...); } catch { /* 흡수(기존 유지) */ }
const isLast = i === targets.length - 1;
if (moveIntervalMs > 0 && !isLast && this.deps.cfg.moveBeforeCapture && this.currentState() !== 'stopping') {
  const rest = moveIntervalMs - (this.monotonic() - t0);
  if (rest > 0) await this.sleep(rest);
}
```

### 페이싱 수식
- `rest = moveIntervalMs - elapsed`, `elapsed = monotonic()_후 - t0`(캡처+검출 포함 전체 사이클).
- `rest > 0` 일 때만 `sleep(rest)`. **floor**: 초과분 패딩 없음(`elapsed >= moveIntervalMs` → sleep 미호출).

### 게이트 조건 (리더 확정 A)
1. `moveIntervalMs > 0` — 0 이면 페이싱 자체 off.
2. `!isLast` — 마지막 타깃 뒤엔 대기 없음(라운드는 이후 `intervalMs` 로 대기).
3. `this.deps.cfg.moveBeforeCapture` — **이동이 실제 일어날 때만** 페이싱(이동 없으면 미적용).
4. `this.currentState() !== 'stopping'` — 정지 요청 중이면 sleep 생략(정지 즉시반응 회귀 방지).

### 유지된 stop 확인점
- 타깃 루프 상단 `stopping` break, checkpoint 전 `stopping` 스킵, floorReviewer shouldStop 콜백 모두 무변경.

## 4. 무변경 확인
- `intervalMs`(라운드 간) 로직, `moveBeforeCapture` 정의, 검출/집계/체크포인트 로직 무변경.
- catch 로 흡수된 타깃도 동일 페이싱(elapsed 크면 rest<=0 → sleep 생략, 별도 분기 불필요).

## 5. typecheck 결과
```
> tsc -p tsconfig.json --noEmit
(에러 없음 — 통과)
```
