# SettingAgent 후속 구현 (2차) — mapConfig 자동로딩 / ROI 누적 클러스터링 / LLM 두뇌 실연동

- 작성일: 2026-06-24
- 선행: `20260624_181703_SettingAgent_구현문서.md`(1차)
- 범위: 1차에서 후속으로 남긴 3개 항목 마무리

---

## 1. #1 mapConfig 자동 프리셋 로딩

설계 확정값 "프리셋 정의 출처 = mapConfig + Unity CameraPos PTZ 추출"을 구현(ParkSimMgr 파싱 패턴 이식).

- 신규: `src/setup/mapTargets.ts`
  - `parseCameraViews(json)` — 형식 A(카메라별 그룹)/B(단일 카메라, idx 0-based→+1) 모두 지원. PTZ 추출(**pan=rot.y, tilt=rot.x, zoom=zoom**).
  - `parseFaceGroups(json)` — 프리셋별 주차면 개수(기대값 검증용, 선택).
  - `viewsToTargets(views)` — `cam→preset` 정렬 + PTZ 보유 시 ptz 포함 → `SetupTarget[]`.
  - `loadSetupTargets({cameraposFile, presetFile?})` — 파일 로드 → 대상 변환.
- config: `tools.config.json` 에 `map: { cameraposFile, presetFile }` 추가. 예시 `config/camerapos.json` 동봉.
- API: `POST /setup/run-from-map` — camerapos에서 프리셋 자동 로딩 후 셋업 실행.
- 동작 확인: `config/camerapos.json`(cam1 2프리셋+cam2 1프리셋) → `loadedTargets=3`, 셋업 DONE, 3슬롯.

## 2. #2 실 PTZ ROI 누적 클러스터링

설계서 §8-1-1 "실 PTZ는 검출 누적+클러스터링으로 수동 ROI 없이 자동 생성".

- 신규: `src/setup/RoiAccumulator.ts` — `buildSlotsAccumulated(frames, opts)`
  - 여러 프레임의 모든 차량 bbox를 **중심 거리 기준 그리디 클러스터링**(`clusterDist` 이내면 동일 슬롯).
  - `minSupport` 미만(전이성/오검지) 클러스터 제외 → 안정 슬롯만.
  - 대표 ROI = 멤버 **평균 사각형 + 패딩**, 위치 순서(상→하/좌→우)로 `positionIdx` 부여.
  - 반환 타입은 `RoiBuilder`와 동일(`BuiltSlot[]`) → 오케스트레이터가 두 경로 호환.
- 통합: `SetupOrchestrator.captureSlots()` — `setup.accumFrames>1` 이면 프레임 N장 캡처(간격 `accumIntervalMs`) 후 누적 클러스터링, 아니면 단일 프레임(시뮬 강체).
- config: `setup.{accumFrames, accumIntervalMs, clusterDist, clusterMinSupport}` 추가(기본 `accumFrames=1` → 시뮬 단일 프레임).
- 동작 확인: 누적 테스트(흔들리는 동일 위치 병합/전이성 제거/원거리 분리) + 오케스트레이터 누적모드 테스트(3프레임 캡처→1슬롯).

## 3. #3 로컬 LLM 두뇌 실연동 (model-agnostic)

- `src/brain/AgentRuntime.ts`:
  - `ping()` 추가 — `/models` 조회(미지원 시 1토큰 chat)로 엔드포인트 연결 점검.
  - `reviewSetup(artifact)` — 셋업 요약을 LLM에 검토 요청(보조). 비활성 시 null.
  - OpenAI 호환 클라이언트(`openai` 패키지) → vLLM/Ollama/llama.cpp에 그대로 연결. provider는 qwen3/gemma/claude/codex/openai-compatible.
- API: `GET /brain/ping`, `POST /brain/review`(저장된 산출물 검토).
- **검증 범위(중요)**: 이 환경엔 로컬 LLM 서버가 없어, **OpenAI 호환 목(mock) HTTP 서버**로 ping/review의 실제 호출·응답 파싱을 검증했다(`test/agentRuntime.test.ts`).
  - **실제 Qwen3/Gemma 연동 확인은 모델 서버 기동 후 수행 필요** (아래 실행법).

### 로컬 LLM 실행법(예: Ollama)
```bash
# 1) 로컬 모델 서버 기동 (OpenAI 호환 :8000 가정)
#    예) vLLM:  python -m vllm.entrypoints.openai.api_server --model Qwen/Qwen3-8B --port 8000
#    예) Ollama: ollama serve  (baseUrl 을 http://localhost:11434/v1 로, model 을 qwen3 로)
# 2) config/llm.config.json 에서 "enabled": true, baseUrl/model 맞춤
# 3) 점검:  curl localhost:13020/brain/ping   → {"enabled":true,"reachable":true}
# 4) 검토:  curl -X POST localhost:13020/brain/review
```

---

## 4. 동작 확인 (실측)

- `npm run typecheck` → **에러 0**
- `npm test` → **44/44 통과** (1차 30 + 후속 14: mapTargets 6, roiAccumulator 5, agentRuntime 2, 오케스트레이터 누적 1)
- API 스모크: `/setup/run-from-map` 200(loadedTargets=3, 3슬롯), `/brain/ping` 비활성 시 503.

## 5. 영향도

- 기존 1차 코드 **무수정**(추가만). 단 `setup` config에 필드 4개 + `map` 섹션 추가 →
  기존 `tools.config.json`은 섹션 병합 로더가 기본값으로 채우므로 **하위호환**(검증됨).
- `setup_artifact.json` 스키마 불변 → Action/DM 계약 영향 없음.
- 누적 모드는 옵트인(`accumFrames>1`)이라 시뮬 기본 동작(단일 프레임) 불변.

## 6. 남은 후속

- 실제 Unity/da_vpd_api/로컬 LLM 3종 동시 기동 통합 스모크(E2E).
- `domain/types.ts` → `@parkagent/types` 공통 패키지화(ActionAgent 착수 전 권장).
- preset 파일 faceCount로 셋업 결과 슬롯 수 교차검증(현재 camerapos만 사용).
