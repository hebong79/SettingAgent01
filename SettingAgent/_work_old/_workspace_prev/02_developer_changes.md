# 02. 구현 변경 요약 — 로컬 Qwen2.5-VL 국소화 정확도 개선(해상도↑ + 네이티브 픽셀 그라운딩 + 좌표변환)

구현자(developer) · 대상: SettingAgent `src/` + `config/` + (tsc용) `test/` 픽스처 3곳
근거: `01_architect_plan.md`(§3 파일별 · §4 좌표변환 파이프라인 · §5 프롬프트 초안 · §6 해상도 · §8 테스트).
리더 확정: (1) imageMaxEdge=1288(28배수 고정점 1288×728≈0.94M<max_pixels 1.0M), (2) floor 1차 출력=points_2d 4코너(하이브리드 폴백 미구현), (3) 지연 무관.

핵심 설계 A/B/C: **해상도 상향(A)** + **픽셀 좌표 출력→코드가 정규화 변환(B)** + **그라운딩 기법 프롬프트(C)**. 변환은 **AgentRuntime 경계에서만** 흡수 → 다운스트림(floorRoi.ts/reviewer/geometry/반환타입) 무변경.

## 0. 결과(검증)
- **tsc `-p tsconfig.json --noEmit`: 에러 0**(src·test 전부 통과).
- **좌표 파이프라인 실측**(tsx 스크립트, 임시): `smartResizeJpegBase64(1288)` → 1920×1080→**1288×728**, 1600×1200→1148×868, 800×450→812×448 — 모두 **28의 배수 & ≤MAX_PIXELS(1,003,520)** 확인. 픽셀→정규화: `normalizeQuad([644,364]@1288×728)` → `{x:0.5, y:0.5}` 정확, `bbox_2d` 경로 `rectToQuad(normalizeBox([0,0,644,364]))` → 좌상 절반 quad 정확.
- **다운스트림 회귀 0**: floorRoi/floorRoiNormalizeEdge/floorRoiReviewer/finalizerFloor/floorRoiStore **49 테스트 통과**(정규화 폴리곤 계약 불변 재확인).
- **image/config 테스트 통과**: imageDownscale(기존 downscale 불변) + config(imageMaxEdge=1288·floorRoi 파싱).
- **깨진 테스트 18건은 QA 인계**(픽스처 shape 마이그레이션 — 아래 §QA 인계).

---

## A. 해상도 — smart-resize 28정렬 리사이저

### `src/util/image.ts` — `smartResizeJpegBase64` 신설(추가만, 기존 함수 불변)
- **추가**: `smartResizeJpegBase64(b64, maxLongEdge): Promise<{ base64, width, height }>` + 상수 `FACTOR=28`, `MAX_PIXELS=1280*28*28`(≈1.0M) + 헬퍼 `roundToFactor`/`floorToFactor`.
- 알고리즘(설계 §3-1·§4):
  1. sharp metadata 로 원본 (W0,H0).
  2. `scale = min(1, maxLongEdge/max(W0,H0))`(업스케일 없음).
  3. 각 변 **28의 배수로 반올림**(`roundToFactor`).
  4. `W*H > MAX_PIXELS` 이면 `√(MAX/(W*H))` 재축소 후 **28 배수로 내림**(`floorToFactor` — 상한 엄수, 서버 재축소 원천 차단).
  5. `sharp.resize(W,H, fit:'fill').jpeg(q80)` → 실제 전송 (W,H) 반환.
- **핵심**: 반환 (W,H) 는 sharp 재인코딩 **실측치**(추정 아님). 이 값이 좌표 정규화 기준(원본 1920 아님).
- **기존 `downscaleJpegBase64` 무변경**: stage1/centering 등 비-그라운딩 경로가 계속 사용(28정렬 불필요).

### `config/llm.config.json` — imageMaxEdge 상향
- **Before** `"imageMaxEdge": 960` → **After** `"imageMaxEdge": 1288`.
- `src/config/llmConfig.ts` 의 `LlmSchema.imageMaxEdge.default(960)`·`DEFAULT_LLM_CONFIG.llm.imageMaxEdge:960` **불변**(하위호환·default 계약 보존). 파일값만 상향.

---

## B. 좌표 형식·변환 (핵심) — 픽셀 그라운딩 → 경계에서 정규화

### `src/brain/SetupBrain.ts` — RAW(절대픽셀) 스키마 추가, 정규화 출력 스키마·반환타입 불변
- **추가** `FloorRoiRawSchema`: `{ points_2d?: 4×[x,y], bbox_2d?: [x1,y1,x2,y2], confidence }` + `.refine(points_2d||bbox_2d)`(둘 다 없으면 parse 실패 → chatJson 재시도 → null → 결정형 폴백; 설계 §4).
- **추가** `OccupancyRawSpaceSchema`(`id,occupied,points_2d?,bbox_2d?`) + `OccupancyRawSchema`(`spaces,confidence`). occupancy 는 refine 없음 → points/bbox 둘 다 없는 면도 통과(폴리곤 미보유 graceful, optional 계약 계승).
- **불변**: `FloorRoiResultSchema`(정규화 {x,y}×4)·`OccupancyResultSchema`/`OccupancySpaceSchema`(정규화 polygon optional)·`FloorRoiResult`/`OccupancyJudgment` 반환타입 — **다운스트림 계약 유지**. RAW 는 파싱 전용, 정규화 스키마는 반환 shape 기준.

### `src/brain/AgentRuntime.ts` — pre-resize + 픽셀 파싱 + 정규화 변환(경계 흡수)
import 조정: `smartResizeJpegBase64` 추가, geometry `normalizeBox/normalizeQuad/rectToQuad` 추가, `FloorRoiResultSchema`/`OccupancyResultSchema` → `FloorRoiRawSchema`/`OccupancyRawSchema`(고아 import 정리 — 두 정규화 스키마는 AgentRuntime 이 더 이상 직접 파싱 안 함).

- **신설 헬퍼** `prepareGroundingImage(b64)`: `smartResizeJpegBase64(cfg.llm.imageMaxEdge ?? 1288)` 호출, 실패 시 `logger.warn` + **null**(그레이스풀 스킵 — FloorRoiReviewer/OccupancyReviewer 가 이미 null/폴백 처리).
- **`recognizeFloorRoi`**:
  - Before: 원본 b64 → `chatJson(FloorRoiResultSchema.parse)` (정규화 폴리곤 직파싱).
  - After: `prepareGroundingImage` → `(base64,W,H)` → 템플릿에 `imgW=W, imgH=H` + **vehicle 를 전송이미지 픽셀 bbox** `[round(x·W),round(y·H),round((x+w)·W),round((y+h)·H)]` = `vehiclePx` 주입 → `chatJson(FloorRoiRawSchema.parse, base64, jsonMode=true, floorRoi.timeoutMs, prepared=true)` → **raw→변환**: `points_2d? normalizeQuad(pts,W,H) : rectToQuad(normalizeBox(bbox_2d,W,H))` → `{ polygon, confidence }`(=FloorRoiResult, 반환타입 불변).
- **`judgeOccupancy`**:
  - Before: 원본 b64 → `chatJson(OccupancyResultSchema.parse, false, occupancy.timeoutMs)` → spaces 그대로.
  - After: `prepareGroundingImage` → `(base64,W,H)` → 템플릿 `imgW/imgH/expected` → `chatJson(OccupancyRawSchema.parse, base64, jsonMode=false, occupancy.timeoutMs, prepared=true)` → 각 space 픽셀 points/bbox 를 `normalizeQuad`/`rectToQuad(normalizeBox)` 로 정규화(둘 다 없으면 polygon 생략) → `{id,occupied,polygon?}` 매핑. **occupiedCount/total/rate 산술은 결정형 그대로**(spaces.length·occupied 필터).
- **`chat`/`chatJson`**: `prepared` 플래그(기본 false) 추가.
  - `chatJson(..., prepared=false)` → `chat(..., prepared)` 로 전달.
  - `chat` 내부: `if (image && !prepared && cfg.llm.imageMaxEdge)` — **prepared=true 면 재다운스케일 건너뜀**(좌표계 불일치 방지). 그 외 경로(stage1/centering/adviseCentering)는 기존 downscale 동작 유지.

### 좌표 변환 지점(데이터 흐름)
```
원본 JPEG(1920×1080)
 → smartResizeJpegBase64(1288)  [image.ts]      → base64 + (W=1288,H=728)   ← 전송크기 확보(실측)
 → 프롬프트: imgW/imgH + vehiclePx(픽셀)  [AgentRuntime]
 → chatJson(prepared=true) → Qwen2.5-VL          → RAW 픽셀 {points_2d|bbox_2d}
 → normalizeQuad / rectToQuad(normalizeBox) (W,H) [AgentRuntime 경계]  ← 픽셀→정규화 0~1 흡수점
 → FloorRoiResult.polygon / OccupancyJudgment.spaces[].polygon  (정규화, 반환타입 불변)
 → resolveFloorPolygon / OccupancyReviewer / geometry / SqliteStore / viewer  ※ 전부 무변경
```
- **정규화 기준 = "보낸 이미지 (W,H)"**(원본 아님). 다운스케일을 코드가 하므로 정확히 앎(LpdClient 가 캡처해상도로 normalizeQuad 하던 것과 동일 패턴).
- **점 순서 강건**: Qwen 코너 순서가 규약과 달라도 다운스트림 `orderConvexCanonical`(convexHull+캐노니컬)가 [앞왼,앞오,뒤오,뒤왼]로 재정렬. 값 정합만 보장하면 됨.

---

## C. 프롬프트 — 절대픽셀 그라운딩 재작성

### `config/prompts/floor_roi.yaml` — 전체 재작성(설계 §5-1)
- 정규화 서술형 → **절대픽셀 points_2d 그라운딩**. `You are a visual grounding expert...` 영어 지시 + 도메인 규약(바닥 접지면 정의: 앞=타이어 접지선/뒤=슬롯 먼끝, 지붕·차체높이 제외) 한국어 유지.
- 출력형식 `{"points_2d":[[x,y]×4],"confidence"}` (절대픽셀, [front-left,front-right,rear-right,rear-left]).
- 치환키: `{{vehicle}}` → **`{{vehiclePx}}`**(픽셀 bbox), **`{{imgW}}`/`{{imgH}}` 신규**, camIdx/presetIdx 유지.

### `config/prompts/occupancy.yaml` — 전체 재작성(설계 §5-2)
- 정규화 4점 → **절대픽셀 points_2d**. 전 주차면 나열 + occupied + recall 우선 규약 유지, 접지면 정의 유지.
- 출력 `{"spaces":[{"id,occupied,points_2d:[[x,y]×4]}],"confidence"}`. jsonMode **off 유지**(다면 디코딩 가속·extractJson 회수, 기존 선례).
- 치환키: `{{imgW}}/{{imgH}}` 신규, camIdx/presetIdx/expected 유지.

### `config/prompts/ptz_centering.yaml` — 소폭(설계 §5-3)
- system 첫 문단만 그라운딩 어투로 명료화("비스듬히 내려다보는 PTZ CCTV 화면을 관찰"). **스키마·치환키·의미 불변**(좌표 출력 없음 → 픽셀 전환 없음, 정규화 오차 기반 유지).

### jsonMode 정책(설계 §5·§10-4)
- floor: **json_object 유지**(단일 소형 top-level object → vLLM guided decode 호환). `chatJson(..., jsonMode=true)`.
- occupancy: **off 유지**(다면 + extractJson 회수).

---

## config 스키마 변경·하위호환

### `src/config/llmConfig.ts` — `FloorRoiSchema.timeoutMs` 추가
- **추가** `timeoutMs: z.number().int().positive().default(120000)`(occupancy 선례 동일). 고해상도 32B floor 그라운딩이 llm.timeoutMs(30s) 초과하는 문제 대응.
- `DEFAULT_LLM_CONFIG.floorRoi` 에 `timeoutMs: 120000` 추가(default 계약).
- `config/llm.config.json` floorRoi 에 `"timeoutMs": 300000`(5분, occupancy 와 동일 여유).
- **하위호환**: `.default(120000)` 라 기존 config(timeoutMs 생략)도 파싱 성공. `loadLlmConfig` spread 병합 그대로 커버.

---

## 파일별 변경 목록

| 파일 | 트랙 | 요지 |
|---|---|---|
| `src/util/image.ts` | A | `smartResizeJpegBase64`(28정렬·(W,H)반환) + 상수/헬퍼 **추가**. downscale 불변. |
| `config/llm.config.json` | A·config | imageMaxEdge 960→1288, floorRoi.timeoutMs 300000 추가. |
| `src/brain/SetupBrain.ts` | B | `FloorRoiRawSchema`(+refine)/`OccupancyRawSpaceSchema`/`OccupancyRawSchema` **추가**. 정규화 스키마·반환타입 불변. |
| `src/brain/AgentRuntime.ts` | B | recognizeFloorRoi/judgeOccupancy pre-resize→픽셀파싱→normalize 변환. `prepareGroundingImage` 신설. chat/chatJson `prepared` 플래그. import 정리. |
| `src/config/llmConfig.ts` | config | FloorRoiSchema.timeoutMs 추가 + DEFAULT 반영. |
| `config/prompts/floor_roi.yaml` | C | 절대픽셀 points_2d 그라운딩 전체 재작성. |
| `config/prompts/occupancy.yaml` | C | 절대픽셀 points_2d 전체 재작성. |
| `config/prompts/ptz_centering.yaml` | C | system 첫 문단 소폭(스키마 불변). |
| `test/agentRuntimeFloor.test.ts` | tsc | floorRoi 픽스처에 timeoutMs 추가(타입 컴파일용). |
| `test/agentRuntimeOccupancy.test.ts` | tsc | floorRoi 픽스처에 timeoutMs 추가. |
| `test/agentRuntimeNative.test.ts` | tsc | floorRoi 픽스처에 timeoutMs 추가. |

**무변경 사수(계약 보존)**: `src/capture/floorRoi.ts`(resolveFloorPolygon/normalizePolygon), `FloorRoiReviewer.ts`/`OccupancyReviewer.ts`, `src/domain/geometry.ts`(재사용만), `SqliteStore`/store, viewer 오버레이, 반환타입 `FloorRoiResult`/`OccupancyJudgment`.

**고아 정리**: AgentRuntime 에서 `FloorRoiResultSchema`/`OccupancyResultSchema` import 제거(RAW 스키마로 대체 — 내 변경으로 고아화된 import). 두 스키마는 SetupBrain export 유지(테스트·반환 shape 계약, 다른 곳에서 사용). 기존 데드코드 삭제 없음.

---

## QA 인계 (깨진 18건 — 픽스처 shape 마이그레이션, 신규 로직 아님)

원인 2종: **(i)** fake 응답이 정규화 `polygon`/`spaces` → 이제 RAW 픽셀 `points_2d`/`bbox_2d` 필요(refine·파싱), **(ii)** fake 이미지가 `Buffer.from('img')`(비-JPEG) → smartResize 실패 → prepareGroundingImage null → 메서드 null.

- **`test/agentRuntimeFloor.test.ts`**: (1) `imageBase64` 를 **실제 JPEG**(sharp 생성)로 교체, (2) fake 응답 `{polygon:[...]}` → **`{points_2d:[[px,py]×4], confidence}`**(전송 W,H 기준 픽셀), (3) 단언을 `polygon = points/W,H` 정규화 정합으로. `bbox_2d` 폴백 케이스 추가. enabled=false 케이스는 그대로.
- **`test/agentRuntimeOccupancy.test.ts`**: (1) 실제 JPEG, (2) fake spaces 를 **픽셀 points_2d** 로, (3) 집계 산술 불변 재확인 + 정규화 정합 단언, (4) T-2(guided off·extractJson 회수)·T1~T4(타임아웃 격리) 픽스처를 픽셀 응답으로 갱신(occupancy.timeoutMs create 2번째 인자 검증 로직 자체는 불변). 폴리곤 미보유 space graceful 케이스.
- **`test/agentRuntimeNative.test.ts`**: (1) `FLOOR_JSON` 을 픽셀 `points_2d` 로, (2) **(d) 다운스케일 단언 갱신**: floor 는 이제 smartResize(prepared) 경로 → imageMaxEdge=960 시 1920×1080→**952×532**(28배수), plain 960×540 아님. `meta.width%28===0 && ≤960` 형태로. adviseCentering/네이티브 라우팅·think·비200 케이스는 불변.
- **`test/promptsYaml.test.ts`**: floor_roi 단언 `[앞왼`·`{{vehicle}}` → **`points_2d`·`{{vehiclePx}}`·`{{imgW}}`** 로 갱신. ptz_centering 단언은 불변.
- **신규 권장(설계 §8)**: `test/imageSmartResize.test.ts` — (a) 1920×1080→28배수·≤MAX, (b) 종횡비 근사(±1 factor), (c) 소형 28스냅, (d) 유효 JPEG 디코드, (e) 비이미지 throw. `test/config.test.ts` — imageMaxEdge=1288·floorRoi.timeoutMs 파싱.
- **핵심 단언**: 픽셀→정규화 정확성(예 `[644,364]@1288×728 → {x≈0.5,y≈0.5}`), 4점 길이, clamp01. 순서는 다운스트림 재정렬이라 값 정합만.

## 미해결/리더(설계 §10 계승)
- 라이브 스모크(리더): floorRoi.enabled=true 실제 프레임 → 오버레이 폴리곤 접지면 정합 육안, 좌표 sanity(0~1·4점·앞=y큰쪽). occupancy 면별 육안.
- (가정) vLLM 서버 max_pixels ≥ 1.0M — 아니면 전송(≈0.94M) 재축소 → 좌표 불일치. imageMaxEdge 하향 필요. **서버 min/max_pixels 확인 요청**.
- points_2d(OBB) 부정확 시 §10-2 대안(bbox_2d 축정렬 우선 + 번호판 회전 재구성) — RAW 파서가 이미 bbox_2d 수용하므로 프롬프트만 전환 가능. 스모크 육안 후 결정.
