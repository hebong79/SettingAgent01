# 02 · 구현 노트 — LLM 비전 기반 차량 바닥 점유 영역(floor ROI · 4점 사변형)

작성: 구현자(developer) · 대상: SettingAgent · 분류: 기능 추가(가산 · 기존 계약 무영향)
검증자(qa-tester)·문서화(documenter) 인계용. 설계서 `01_architect_plan.md` 11단계를 그대로 구현.

---

## 0. 결과 요약

- **typecheck**: `npm run typecheck` 통과(SettingAgent + @parkagent/types 둘 다).
- **test**: `npm test` → **42 파일 / 278 테스트 통과**. 기존 248 + 신규 30 = 278. **기존 회귀 0**.
- **라이브 서버 미기동**(마스터 수동 관리). 검증은 typecheck + vitest(브레인/카메라/스토어 모킹)로만.
- floor ROI 는 **항상 존재**(LLM 실패·무효·프레임부재 외 모든 채택 슬롯). 폴백은 bbox 유도 결정형 사변형.

---

## 1. 신규 파일

| 파일 | 내용 |
|------|------|
| `SettingAgent/src/capture/floorRoi.ts` | 결정형 순수 모듈. `fallbackQuadFromRect`/`normalizeQuad`/`resolveFloorQuad`. 외부 의존 0. |
| `SettingAgent/src/capture/FloorRoiReviewer.ts` | 체크포인트 cadence 로 채택 슬롯의 floor quad (재)계산·저장. LLM 비활성 no-op, 실패 폴백, maxPerCheckpoint 상한. |
| `SettingAgent/config/prompts/floor_roi.system.md` | system 프롬프트(접지면 4점·순서 규약·JSON-only). |
| `SettingAgent/config/prompts/floor_roi.user.md` | user 템플릿(`{{camIdx}}`/`{{presetIdx}}`/`{{vehicle}}`/`{{plate}}`). |
| 테스트 5종 | `floorRoi.test.ts`(10) `floorRoiStore.test.ts`(3) `agentRuntimeFloor.test.ts`(3) `floorRoiReviewer.test.ts`(8) `finalizerFloor.test.ts`(2). |

## 2. 수정 파일(가산)

| 파일 | 변경 |
|------|------|
| `packages/types/src/index.ts` | `NormalizedPoint`/`NormalizedQuad`(고정 4-튜플) 신설, `ParkingSlot.floorRoiByPreset?` 가산. |
| `SettingAgent/src/domain/types.ts` | 재수출에 `NormalizedPoint`/`NormalizedQuad` 추가. |
| `SettingAgent/src/brain/SetupBrain.ts` | `FloorRoiInput`/`FloorRoiResultSchema`/`FloorRoiResult` + 인터페이스 옵셔널 `recognizeFloorRoi?`. |
| `SettingAgent/src/brain/AgentRuntime.ts` | `recognizeFloorRoi` 구현(기존 `chatJson` + image_url 멀티모달 100% 재사용, 신규 HTTP 0). |
| `SettingAgent/src/config/llmConfig.ts` | `FloorRoiSchema`(옵셔널) + `DEFAULT_LLM_CONFIG.floorRoi`(enabled=false) + merge 1줄. |
| `SettingAgent/config/llm.config.json` | `floorRoi.enabled=true`(gemma 사용). maxPerCheckpoint=12. |
| `SettingAgent/src/capture/SqliteStore.ts` | `floor_roi` 테이블(PK run_id+preset_key+cluster_id) + `upsertFloorRoi`/`getFloorRois`. |
| `SettingAgent/src/capture/CaptureJob.ts` | `lastFrameByPreset` Map(start 시 clear, captureTarget 시 set) + `floorReviewer?` deps + checkpoint 끝 호출. |
| `SettingAgent/src/capture/Finalizer.ts` | `getFloorRois`→`floorByRef` 맵→`assemble` 가산 인자→`slot.floorRoiByPreset` 세팅. |
| `SettingAgent/src/index.ts` | `FloorRoiReviewer` 생성·`captureJob` 주입(`maxPerCheckpoint=llm.floorRoi?.maxPerCheckpoint`). |
| `SettingAgent/web/core.js` | `toPixelQuad` 신설 + `analyzeArtifact` 에 `hasFloor`/`withFloor`. |
| `SettingAgent/web/core.d.ts` | `NormalizedQuad`/`PixelPoint` 타입 + `toPixelQuad` 선언 + `ArtifactAnalysis` 에 withFloor/hasFloor. |
| `SettingAgent/web/app.js` | `toPixelQuad` import, `drawRoiOverlay` floor 폴리곤(#39ff14), `roi-floor` 토글 리스너, 분석 '바닥 ROI' 카드. |
| `SettingAgent/web/index.html` | `roi-floor` 체크박스(기본 checked). |
| 테스트 3종 수정 | `config.test.ts`(+1) `analyzeArtifact.test.ts`(+2) `viewerCore.test.ts`(+1). |

---

## 3. 핵심 구현 노트

### 3.1 좌표 규약(전 모듈 공유)
순서 `[앞왼, 앞오, 뒤오, 뒤왼]`. 앞=이미지 하단/카메라 근접(y 큼), 뒤=상단(y 작음), 시계방향.
- `normalizeQuad`: y 기준 하(앞)/상(뒤) 2점씩 분리 → 각 쌍 x 기준 좌/우. **LLM 이 순서를 틀려도 뷰어 폴리곤이 꼬이지 않음.**
- 프롬프트(`floor_roi.system.md`)·`normalizeQuad`·뷰어 `toPixelQuad` 가 동일 규약. 테스트로 고정(`floorRoi.test.ts` 순서 정렬 케이스).

### 3.2 폴백 로직(floor ROI 항상 존재)
`resolveFloorQuad(llmQuad, vehicle) = normalizeQuad(llmQuad) ?? fallbackQuadFromRect(vehicle)`.
- `fallbackQuadFromRect`: bbox 하단 35% 밴드를 footprint 근사, 윗변 좌우 inset 10%(원근 근사). 모든 점 0~1 클램프.
- 무효 케이스(점≠4·NaN·undefined)는 `normalizeQuad`→null→폴백. **결정형이라 LLM 무관하게 항상 그럴듯한 사변형.**
- 폴백 발동 지점: (a) FloorRoiReviewer 에서 LLM throw/null/무효, (b) maxPerCheckpoint 초과·프레임부재 슬롯은 이번 주기 skip(다음 주기 보유).

### 3.3 LLM 단계(좌표 "생성")
`AgentRuntime.recognizeFloorRoi`: `this.client` 없거나 `cfg.floorRoi?.enabled !== true` → null.
- 전용 프롬프트 로드 → `renderTemplate`(vehicle/plate JSON) → `chatJson(system, user, FloorRoiResultSchema.parse, imageBase64)`.
- 이미지가 `image_url`(data:image/jpeg;base64) 멀티모달로 전송됨을 테스트로 검증(`agentRuntimeFloor.test.ts` 가 mock 서버 body 검사).
- **경계 일치**: 좌표 "생성"=LLM, "검증·강등·폴백"=결정형(floorRoi.ts). 기존 두뇌 규약(stage reviewer 는 좌표 불변)과 분리해 별 클래스(`FloorRoiReviewer`)로.

### 3.4 저장(별 테이블 근거)
`aggregated_slot` 은 `replaceAggregatedSlots` 가 run 단위 delete+insert(집계 멱등)라 floor quad 를 같은 행에 두면 소실 → **별 테이블 `floor_roi`**(IF NOT EXISTS, 마이그레이션 불필요). PK=(run_id, preset_key, cluster_id), upsert=ON CONFLICT DO UPDATE(중복 행 없음, 멱등).

### 3.5 체크포인트 통합
- `CaptureJob.lastFrameByPreset`: 프리셋별 최근 JPEG 보관(기존 `lastFrame` 1장 보존, 가산 1줄). `start()` 에서 clear.
- `checkpoint()` 끝에 `floorReviewer.review(runId, slots, lastFrameByPreset)` 가산. **미주입 시 기존 동작 그대로**(옵셔널 deps).
- 같은 cadence(`checkpointEvery`) 재사용 — 별도 주기 신설 없음.

### 3.6 Finalizer 가산
`getFloorRois(runId)` → `floorByRef: Map<presetKey#clusterId, quad>` → `assemble` 에서 `floorByRef.get(clusterRef(m))` 있으면 `slot.floorRoiByPreset = { [key]: quad }`. 없으면 키 미생성(옵셔널 보존). `roiByPreset`/`plateRoiByPreset` 불변.

### 3.7 설정 머지 주의
`DEFAULT_LLM_CONFIG.floorRoi` 가 항상 존재(enabled=false)하고 merge 가 `{...DEFAULT.floorRoi, ...raw.floorRoi}` 라 **로드 결과의 `cfg.floorRoi` 는 항상 정의됨**(런타임 안전). 스키마의 `.optional()` 은 config 객체를 코드로 직접 구성하는 경우(기존 agentRuntime.test.ts 의 cfg 리터럴 등) 하위호환용. → 설계서 §8 의 "미설정 시 undefined" 서술과 다르지만, **항상 정의되는 편이 `cfg.floorRoi.enabled` 접근에 더 안전**하여 이 방향으로 구현(아래 4. 설계 대비 차이 참고).

---

## 4. 설계 대비 차이(우회 아님 · 합리적 보강)

1. **`loadLlmConfig` 머지**: 설계 §8 검증 문구는 "floorRoi 미설정 → undefined" 였으나, DEFAULT 에 floorRoi 를 두고 항상 머지하도록 구현(런타임 `cfg.floorRoi.enabled` 접근 안전). 스키마는 여전히 `.optional()` 이라 외부에서 floorRoi 없는 config 리터럴도 파싱 가능(기존 테스트 cfg 무수정 통과 확인). 기능·계약 영향 없음.
2. 그 외 11단계 전부 설계서 그대로. 계획 충돌·기존 코드 막힘 없음.

---

## 5. 미해결 / 실측 보정 필요

- **gemma4:12b 좌표 정확도**: 사변형 정밀도·순서 정확도는 **실 LLM 호출로만** 검증 가능(vitest 는 mock). `normalizeQuad`(순서 강제·클램프) + 폴백으로 안전망은 갖췄으나, 실측에서 quad 가 차체(지붕) 윤곽을 찍는 경향이면 프롬프트(접지면 강조 문구) 튜닝 필요. → 마스터 라이브 수집 후 뷰어 폴리곤(#39ff14)으로 육안 확인 권장.
- **confidence 임계 폴백**: 1차 미적용(유효 quad 면 채택). 실측에서 저신뢰 quad 가 잦으면 `confidence < 임계 → 폴백` 후속 가산 가능(설계 §13-C).
- **프리셋별 프레임 메모리**: `lastFrameByPreset` = 프리셋 수 × JPEG. 현재 규모(수십 프리셋, 수 MB) 허용. 수백 프리셋이면 재검토.

---

## 6. 검증자(qa-tester) 인계 포인트

- 회귀 기준: **기존 248 회귀 0**(현재 278 통과). 신규 테스트가 floor 경로(순수·store·runtime·reviewer·finalizer·뷰어)를 커버.
- 교차 확인 권장:
  - `FloorRoiReviewer` → `SqliteStore.upsertFloorRoi` → `Finalizer.getFloorRois` → `ParkingSlot.floorRoiByPreset` 의 quad shape 일관성(8실수, 순서 규약).
  - 뷰어 `toPixelQuad` 출력이 `drawRoiOverlay` 폴리곤 순회와 일치(closePath 폐곡선).
  - `analyzeArtifact.totals.withFloor` 카운트 = floorRoiByPreset 보유 슬롯 수.
- 동작 확인(육안): `roi-floor` 토글 on/off 시 연두 폴리곤 표시/숨김, 분석 탭 '바닥 ROI' 카드 수치.
