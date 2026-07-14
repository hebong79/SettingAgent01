# 04. 영향도 분석 — 로컬 Qwen2.5-VL 국소화 정확도 개선(해상도↑ + 네이티브 픽셀 그라운딩 + 좌표변환)

문서화·영향도 분석가(documenter) · 대상: SettingAgent `src/`·`config/`(+ `test/`)
근거: 01(설계) · 02(구현) · 03(검증: tsc 0 / vitest 85파일·831 그린, +26) + 실제 변경 소스 대조.
최종 문서: `SettingAgent/docs/20260705_172023_qwen_국소화정확도.md`

핵심 설계 A/B/C: **해상도 상향(A)** + **픽셀 좌표 출력→코드가 정규화 변환(B)** + **그라운딩 기법 프롬프트(C)**. 변환은 **AgentRuntime 경계에서만** 흡수 → 다운스트림 무변경.

---

## 1. 변경 모듈

| 파일 | 변경 | 성격 |
|---|---|---|
| `src/util/image.ts` | `smartResizeJpegBase64`(28정렬·(W,H)반환) + FACTOR/MAX_PIXELS 상수·헬퍼 | **신규 함수**(추가만, downscale 불변) |
| `src/brain/SetupBrain.ts` | `FloorRoiRawSchema`(+refine)/`OccupancyRawSpaceSchema`/`OccupancyRawSchema` | RAW 파싱 스키마 가산(정규화 스키마·반환타입 불변) |
| `src/brain/AgentRuntime.ts` | `prepareGroundingImage` 신설, recognizeFloorRoi/judgeOccupancy 픽셀 파이프라인 전환, chat/chatJson `prepared` 플래그, 고아 import 정리 | 경계 로직 수정 |
| `src/config/llmConfig.ts` | `FloorRoiSchema.timeoutMs`(default 120000) + DEFAULT 반영 | 스키마·기본값 가산 |
| `config/llm.config.json` | imageMaxEdge 960→1288, floorRoi.timeoutMs 300000 | 값 수정 |
| `config/prompts/floor_roi.yaml`·`occupancy.yaml` | 절대픽셀 points_2d 그라운딩 전체 재작성 + `{{imgW}}/{{imgH}}/{{vehiclePx}}` | 프롬프트 재작성 |
| `config/prompts/ptz_centering.yaml` | system 첫 문단 소폭(스키마·치환키 불변) | 문구 |

변환 흡수점은 `recognizeFloorRoi`/`judgeOccupancy`의 `normalizeQuad`/`rectToQuad(normalizeBox)` **경계 2곳**뿐. 좌표계 격리점은 `chat()`의 `!prepared` 가드(prepared=true 시 재다운스케일 스킵).

---

## 2. 의존성 그래프 / 파급 추적

- **경계 흡수로 다운스트림 무변경·회귀 0.** 픽셀→정규화 변환이 AgentRuntime 안에서 끝나고 반환타입(`FloorRoiResult`/`OccupancyJudgment`)이 정규화 폴리곤으로 동일하므로, 소비측 `src/capture/floorRoi.ts`(resolveFloorPolygon/normalizePolygon)·`FloorRoiReviewer`·`OccupancyReviewer`·`Finalizer`·`SqliteStore`·store·viewer 오버레이·`domain/geometry.ts`(재사용만) **전부 무변경**. 03에서 floorRoi/floorRoiNormalizeEdge/floorRoiReviewer/finalizerFloor/floorRoiStore/occupancyReviewer/occupancyStore/sqliteStore 스위트 전건 PASS로 계약 불변 재확인.
- **`FloorRoiSchema.timeoutMs` → `LlmConfig` 타입 파급.** `.default(120000)`이 붙어 파싱 후 타입에서 필수 필드화 → `LlmConfig`/floorRoi 리터럴을 직접 만드는 픽스처가 tsc 파급 대상. 해당 픽스처(`agentRuntimeFloor`/`agentRuntimeOccupancy`/`agentRuntimeNative`)에 `timeoutMs` 추가로 해소. `loadLlmConfig`/`DEFAULT_LLM_CONFIG` 경유 코드는 default가 채워 무영향. 프로덕션 호출부 정상.
- **`smartResizeJpegBase64` → 신규 의존.** floor/occupancy만 이 경로. stage1/2/3·checkpoint·finalize·centering은 기존 `downscaleJpegBase64` 유지 → `imageDownscale.test.ts` 불변, 해상도 상향 혜택만 공유.
- **프롬프트 치환키 파급.** floor_roi/occupancy yaml의 `{{imgW}}/{{imgH}}/{{vehiclePx}}` 신 키가 renderTemplate로 전부 치환(`{{` 잔존 0, `promptsYaml.test.ts` 확인). `{{vehicle}}`(정규화) 제거는 AgentRuntime 렌더러가 vehiclePx로 주입하므로 정합.
- **@parkagent/types / MCP.** 변화 없음(내부 두뇌 경계 안에서 처리). REST 계약(`GET /capture/runs/:id/occupancy` 등)·SQLite 저장 shape 불변.

---

## 3. 하위호환 / 무영향

- **하위호환(config).** `LlmSchema.imageMaxEdge.default(960)`·`FloorRoiSchema.timeoutMs.default(120000)` 불변 → 기존 json(값 생략)도 파싱 성공. 실제 `llm.config.json` 값만 1288·300000으로 상향. `config.test.ts`/`llmThinkConfig.test.ts`가 default 960·120000 유지 + 실 config 1288·300000 양쪽 단언.
- **하위호환(호출부).** `chat/chatJson`의 `prepared`(기본 false)는 옵셔널 후행 추가 → 기존 비-그라운딩 호출부(stage1~3/checkpoint/finalize/adviseCentering/reviewSetup) 무변경(prepared=false → 기존 downscale 동작).
- **RAW→정규화 폴백.** points_2d/bbox_2d 둘 다 없으면 refine 실패 → 재시도 → null → 다운스트림 결정형 폴백. 회귀 경로 보존. occupancy는 폴리곤 미보유 면 graceful.

---

## 4. 리스크

| # | 리스크 | 수준 | 비고 |
|---|---|---|---|
| R1 | vLLM 서버 max_pixels < 1.0M이면 전송(≈0.94M) 재축소 → 좌표 불일치 | 중 | **가정: max_pixels ≥ 1.0M**. 서버 min/max_pixels 확인 필요. 어긋나면 imageMaxEdge 하향. 유닛 범위 밖 |
| R2 | points_2d(OBB 4코너) Qwen 네이티브 대비 상대 OOD → 접지선/먼끝 흔들림 가능 | 중 | RAW 파서가 bbox_2d 폴백 수용 + 다운스트림 결정형 폴백. 부정확 시 후속: bbox 축정렬 우선 + 번호판 각도(`buildPlateAnchoredQuad`) 회전 재구성 하이브리드. 스모크 육안 후 결정 |
| R3 | 해상도 0.52M→0.94M + 32B로 호출 지연 증가 | 저 | 셋팅용이라 무관. floorRoi.timeoutMs=300000으로 타임아웃 폴백 방지 |
| R4 | 28 스냅 종횡비 변형 ≤1.5% | 저 | 정규화가 전송 기준이라 무해(테스트로 상한 확인) |
| R5 | 실 Qwen 국소화 품질(육안) 미검증 — 리더 라이브 스모크 **진행 중, 결과 별도** | 중 | 자동 범위 밖. 오버레이 접지면 정합·occupancy 면별·좌표 sanity 육안 필요 |

---

## 5. 검증 상태 (사실 기반 — 통과 위장 없음)

- **자동 검증 그린:** tsc `--noEmit` 0 에러, vitest **85파일 / 831 테스트 PASS**(+26, 회귀 0). 착수 실패 20건은 전부 픽스처 shape 마이그레이션(신규 로직 결함 아님). 좌표변환 수치([644,364]@1288×728→{0.5,0.5})·smartResize·RAW파싱·재다운스케일방지·반환계약불변 결정적 단언.
- **미수행:** 실 Qwen2.5-VL 국소화 품질(육안) — 리더 라이브 스모크 소관, **진행 중, 결과 별도 반영 필요**. vLLM 서버 max_pixels 값 확인 필요.

---

## 6. 후속 과제

- 실환경 육안 검증(리더 스모크) 완료 후 결과 반영.
- points_2d 부정확 시 bbox_2d + 번호판 각도 회전 재구성 하이브리드로 전환(프롬프트 전환만으로 가능 — RAW 파서 준비됨).
- occupancy/centering도 동일 픽셀 그라운딩 기법으로 추가 튜닝 여지.
