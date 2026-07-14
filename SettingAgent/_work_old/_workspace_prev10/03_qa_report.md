# 03 검증 보고 — LLM 강제 구동(warm-up/preload) config 제어

## 실행 명령
```
cd SettingAgent
npx vitest run test/warmup.test.ts test/warmupTimeout.test.ts test/captureJob.test.ts test/captureRoutes.test.ts   # 변경/신규 집중
npx vitest run          # 전체 회귀
npm run typecheck       # tsc -p tsconfig.json --noEmit
```

## 전체 결과 (그대로)
- **전체 vitest**: `Test Files 61 passed (61)`, `Tests 503 passed (503)` — 실패 0.
  - 베이스라인(변경 전) 59 파일 / 477 테스트 → 신규 2 파일(`warmup.test.ts` 16, `warmupTimeout.test.ts` 2) + captureJob 6 + captureRoutes 3 = **+26 테스트** 추가, 전부 통과. 기존 477 회귀 통과.
- **typecheck**: `tsc --noEmit` **에러 0**(exit 0).
- **발견 이슈**: 없음(구현이 설계 §a/§b/§d/§e 와 일치). developer 재보고 불필요.

## 검증 케이스 (설계 §f 매핑)

### AgentRuntime.warmup (`test/warmup.test.ts`, global.fetch 모킹)
| # | 케이스 | 기대 | 결과 |
|---|--------|------|------|
| 엔드포인트1 | warmup 미지정(default)·baseUrl `/v1` | `POST http://h:11434/api/chat` 1회, true | ✅ |
| 엔드포인트2 | baseUrl 트레일링 `/v1/` 변형 | `.../api/chat` 로 유도 | ✅ |
| 엔드포인트3 | `warmup.url='http://other:99/api/chat'` | baseUrl 유도 무시, 그 URL 그대로 | ✅ |
| body1 | 기본 body | `model='m1'`, `keep_alive='24h'`, `stream===false`, `options.num_predict===1`, `content-type: application/json` | ✅ |
| body2 | `keepAlive='1h'`·`numPredict=3`·`model='m2'` | body 에 그대로 반영(warmup.model 우선) | ✅ |
| body3 | `warmup.model` 미지정 | `llm.model` 사용 | ✅ |
| 게이트1 | `warmup.enabled=false` | fetch 미호출, false | ✅ |
| 게이트2 | `llm.enabled=false` | fetch 미호출, false | ✅ |
| 게이트3 | provider `claude` | fetch 미호출, false | ✅ |
| 게이트4 | provider `codex` | fetch 미호출, false | ✅ |
| 게이트5 | warmup 블록 자체 미설정(undefined) | 게이트 통과, fetch 호출·true(설계: 미설정 시 활성) | ✅ |
| best-effort1 | fetch 비200(500) | false, throw 안 함 | ✅ |
| best-effort2 | fetch reject(예외) | false, throw 안 함 | ✅ |

### timeoutMs 전달 (`test/warmupTimeout.test.ts`, http.js 모킹)
- `warmup.timeoutMs=5000` → `fetchWithTimeout(url, init, 5000)` 3번째 인자 확인. ✅
- 기본 `timeoutMs=120000` 전달. ✅
- (분리 사유: global.fetch 모킹으로는 timeoutMs 가 AbortController 내부 소비돼 관찰 불가 → `fetchWithTimeout` 자체를 모킹해 인자 직접 관찰. 이렇게 콜드 로드용 긴 타임아웃이 실호출 30s 와 분리됨을 검증.)

### loadLlmConfig 파싱/병합 (`test/warmup.test.ts`)
- `DEFAULT_LLM_CONFIG.warmup === {enabled:true, keepAlive:'24h', numPredict:1, timeoutMs:120000}`. ✅
- 없는 경로(warmup 미지정) → default 채움(enabled true/24h/1/120000). ✅
- 실제 `config/llm.config.json` → warmup 존재·활성(`enabled:true`). ✅
- (부분 병합은 `loadLlmConfig` 의 `{ ...DEFAULT.warmup, ...raw.warmup }` 라인으로 보장 — 실 config 로드로 커버.)

### 트리거 (`test/captureJob.test.ts`, mock brain)
| 케이스 | 기대 | 결과 |
|--------|------|------|
| `start()` 발화 | `brain.warmup` 1회, start 반환이 warmup await 에 안 막힘(동기 `running` 반환) | ✅ |
| checkpoint 도달 | checkpoint 진입 시 warmup 재보장 → 총 2회(start+checkpoint) | ✅ |
| stopping 중 checkpoint | 게이트(`currentState!=='stopping'`)로 checkpoint 스킵 → warmup 1회(start)만 | ✅ |
| brain 미주입 | 옵셔널 체이닝 no-op, 잡 정상 done | ✅ |
| warmup false(콜드 로드 실패) | 잡 정상 done(best-effort, 폴백 유지), warmup 2회 | ✅ |

### 수동 엔드포인트 (`test/captureRoutes.test.ts`, mock brain + fastify.inject)
| 케이스 | 기대 | 결과 |
|--------|------|------|
| brain 주입 + warmup 성공 | `POST /capture/warmup` → 200 `{ok:true}`, 스파이 1회 | ✅ |
| brain 주입 + warmup 실패 | 200 `{ok:false}` | ✅ |
| brain 미주입 | 200 `{ok:false}`(옵셔널 체이닝 no-op) | ✅ |

## 경계면 교차 비교(shape 검증)
- **warmup body ↔ Ollama 네이티브 `/api/chat` 스키마**: `{ model, messages:[{role,content}], stream:false, keep_alive, options:{num_predict} }` — 설계 §b 및 Ollama `/api/chat` 계약과 필드명·타입 일치(camelCase 아님 — `keep_alive`·`num_predict` snake_case 확인). ✅
- **엔드포인트 유도 ↔ baseUrl**: `baseUrl.replace(/\/v1\/?$/,'') + '/api/chat'` — `/v1`·`/v1/` 두 변형 모두 정확히 `/api/chat` 로 치환(정규식 경계 `$` 확인). `warmup.url` 지정 시 유도 완전 우회. ✅
- **SetupBrain.warmup? 시그니처 ↔ 소비측**: 인터페이스 `warmup?(): Promise<boolean>` 옵셔널 ↔ CaptureJob `this.deps.brain?.warmup?.()`·captureRoutes `deps.brain?.warmup?.()` 옵셔널 체이닝. 반환 `boolean` ↔ 라우트 `{ ok: ok ?? false }` 정합. ✅
- **트리거 반환값 처리**: start 는 `void`(값 무시·non-blocking), checkpoint 는 `await`(값 무시·완료 대기), 라우트만 값 사용 — 설계 §d/§e 의도와 일치. ✅

## 수동 확인 필요 항목(유닛 미포함 — 실환경 스모크)
외부 서비스(Ollama 192.168.0.210:11434)는 유닛에서 전량 모킹했다. 아래는 **실 연동 스모크로 별도 확인** 필요(현재 미수행 — 누락으로 명시):
1. **실 Ollama warm-up 후 로드 확인**: `POST /capture/warmup` 호출 → Ollama `GET /api/ps`(또는 `/api/tags` 로드 상태)로 `gemma`/12B 모델이 로드되어 `keep_alive` 만료 시각이 ~24h 로 세팅됐는지 확인.
2. **콜드 로드 흡수**: 모델 언로드(5분 유휴) 상태에서 capture `start()` → 라운드1 동안 warm-up 이 12B 로드를 흡수 → 첫 checkpoint 의 floor ROI 실호출이 웜 상태(타임아웃 폴백 없음)인지 로그(`LLM warm-up 성공`·floor ROI `llmUnavailable` 미발생)로 확인.
3. **floor ROI 실동작**: warm-up 도입 후 실 수집에서 `llmFloorUnavailable` 경고가 감소/소멸하는지(설계 §g 부수효과) 확인.
4. **`enabled:false`/`url` 오버라이드 실환경 반영**: `config/llm.config.json` warmup 블록 조정 후 재기동 시 게이트/엔드포인트가 config 대로 바뀌는지 확인.

## 산출물
- 신규: `SettingAgent/test/warmup.test.ts`, `SettingAgent/test/warmupTimeout.test.ts`
- 보강: `SettingAgent/test/captureJob.test.ts`(warm-up 트리거 5케이스 + vi import 기존 보유), `SettingAgent/test/captureRoutes.test.ts`(수동 엔드포인트 3케이스 + `vi` import 추가)
