# 01. 설계서 — 로컬 Qwen2.5‑VL‑32B floor ROI/occupancy 국소화 정확도 개선

작성: 설계자(architect) · 대상 브랜치 main · 대상 서비스 SettingAgent
목표: 로컬 vLLM Qwen2.5‑VL‑32B 가 "차량이 점유한 바닥 사각형(4점 OBB)"을 육안 정합 수준으로 **정확히** 국소화하게 한다. 지연 무관, 정확도 최우선. floor ROI 가 최우선 산출물, occupancy 폴리곤은 부수 개선, centering 은 자문(좌표 생성 아님)이라 소폭만.

---

## 1) 배경 / 조사 결과 (Qwen2.5‑VL 그라운딩 사실 + 출처)

현행 코드 실측(읽은 파일 근거):
- `config/llm.config.json`: model=`Qwen/Qwen2.5-VL-32B-Instruct`, `api=openai`(vLLM /v1), `imageMaxEdge=960`, floorRoi/occupancy `enabled=true`, occupancy `timeoutMs=300000`, floorRoi 는 전용 timeout 없음(→ `llm.timeoutMs=30000` 적용).
- `src/util/image.ts`: `downscaleJpegBase64` 가 긴변 960 으로 종횡비 유지 축소(업스케일 없음). **정규화 0~1 좌표는 균일 스케일 불변**이라 지금까지 회귀는 없었음.
- 프롬프트 3종(`floor_roi.yaml`/`occupancy.yaml`/`ptz_centering.yaml`)은 모두 **정규화 0~1 폴리곤**을 서술형으로 요구.

Qwen2.5‑VL 그라운딩 공식/커뮤니티 사실:
- **(a) 좌표계**: Qwen2.5‑VL 은 **절대 픽셀 좌표**로 그라운딩하도록 학습됨. bbox 는 `[x1,y1,x2,y2]`(코너, w/h 아님). 반환 좌표는 **모델이 실제 처리한(smart‑resize 된) 이미지 해상도 기준**이며, 원본으로 되돌리려면 리사이즈 비율을 곱한다. (HF 모델카드 토론, PyImageSearch)
- **(b) 출력 형식**: 네이티브 형식은 JSON `{"bbox_2d":[x1,y1,x2,y2],"label":...}` 배열. Qwen2.5‑VL 은 **point 그라운딩**(객체 세부 지점 좌표)도 지원 — box 로 표현이 어려운 형상을 점으로 찍을 수 있음. **회전 사변형/OBB/폴리곤 네이티브 출력은 문서화되어 있지 않음**(축정렬 bbox 또는 점만 확인됨).
- **(c) smart‑resize**: 입력을 각 변이 **28의 배수**가 되도록 리사이즈(패치 stride 14, `grid_thw×14 = 처리해상도`). 처리 픽셀 수는 `[min_pixels, max_pixels]` 로 클램프. 검출 예제 기본값 `min_pixels=256*28*28≈200k`, `max_pixels=1280*28*28≈1.0M`. 모델 출력은 이 **처리해상도 좌표계**.
- **(d) 권장 해상도**: 그라운딩은 처리 픽셀이 클수록 국소화 정밀도↑(단 max_pixels 상한 내). 16:9 기준 ~1.0M 픽셀(예 1288×728)이 상한 근방.

출처:
- https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct/discussions/13 — 좌표는 리사이즈된 이미지 기준, 28의 배수, 비율로 원본 환산, bbox_2d=[x1,y1,x2,y2].
- https://pyimagesearch.com/2025/06/09/object-detection-and-visual-grounding-with-qwen-2-5/ — min/max_pixels=256/1280*28*28, `input_h=grid_thw[1]*14`, processor 가 리사이즈 담당, 검출 프롬프트/`{"bbox_2d":[...]}` 형식.
- https://deepwiki.com/jzh15/Qwen2.5-VL/8.2-object-detection-and-grounding, https://github.com/QwenLM/Qwen2.5-VL/issues/866, arxiv 2502.13923(기술리포트) — box + point 그라운딩 능력.

> 조사 불확실성(명시): "모델이 반환하는 픽셀이 **처리해상도** 기준인가, **업로드 원본** 기준인가"는 서버(vLLM) 구현에 따라 커뮤니티 보고가 엇갈린다. 본 설계는 **이 애매성을 회피**한다 → §4 참조(우리가 보내는 이미지를 smart‑resize 고정점=28의 배수로 만들어 서버 내부 리사이즈를 항등화 ⇒ "처리해상도 == 원본 == 우리가 보낸 이미지"가 되어 어느 해석이든 동일 결과).

---

## 2) 근본 원인 (3중 결함)

1. **입력 해상도 부족**: 960 긴변(1920×1080→960×540, 0.52M px)으로 다운스케일. 원거리·기울어진 바닥 슬롯의 접지선을 픽셀 단위로 찍기엔 해상도가 낮아 국소화 정밀도 급감. Qwen 처리 상한(~1.0M) 대비 절반.
2. **좌표 형식 불일치(핵심)**: 프롬프트가 **정규화 0~1 폴리곤**을 요구. Qwen2.5‑VL 은 **절대 픽셀** 그라운딩으로 학습 → 학습 분포와 어긋나 좌표가 부정확(폴리곤이 접지면에 안 맞음). 모델 강점(픽셀 bbox/point)을 못 끌어냄.
3. **프롬프트 기법 부적합**: 길고 서술적인 한국어 프롬프트가 Qwen 그라운딩 트리거("detect/locate ... output coordinates in JSON")를 약하게 자극. 출력 스키마도 네이티브 형식과 다름.

교정 방향: **해상도 상향(A) + 픽셀 좌표 출력으로 전환하고 코드가 정규화 변환(B) + 그라운딩 기법 프롬프트(C)**. 다운스트림 결정형(`floorRoi.ts`)은 정규화 폴리곤을 받으므로 **변환은 AgentRuntime 경계에서** 흡수 → 다운스트림 무변경.

---

## 3) 파일별 변경 상세 (before/after)

### 3‑1. `src/util/image.ts` — smart‑resize 정렬 리사이저 신설
- **추가** `smartResizeJpegBase64(b64, maxLongEdge, opts?) : Promise<{ base64: string; width: number; height: number }>`
  - sharp 로 종횡비 유지 축소하되 **양 변을 28의 배수로 스냅**하고, 총 픽셀이 `MAX_PIXELS=1280*28*28` 를 넘지 않게 긴변을 조정. 실제 전송 크기(width,height)를 함께 반환.
  - 알고리즘(결정형):
    1. 원본 (W0,H0) 읽기(sharp metadata).
    2. `scale = min(1, maxLongEdge / max(W0,H0))` → (W1,H1).
    3. `factor=28` 로 각 변을 **가장 가까운 배수로 반올림**(최소 factor 보장).
    4. `W2*H2 > MAX_PIXELS` 이면 `√(MAX_PIXELS/(W2*H2))` 비율로 재축소 후 다시 28 스냅.
    5. sharp resize(정확히 W2×H2, `fit:'fill'`). 28 스냅에 따른 ≤14px/축 미세 종횡비 변화는 좌표를 "보낸 이미지" 기준으로 정규화하므로 무해.
  - 기존 `downscaleJpegBase64` 는 **그대로 유지**(stage1/centering 등 비‑그라운딩 경로가 계속 사용, 기존 테스트 불변).
- 근거: §4 좌표 파이프라인. 반환 (W,H) 는 재인코딩 결과 실측치. `readJpegSize`(util/jpeg.ts)로 교차검증 가능.

### 3‑2. `src/brain/SetupBrain.ts` — RAW(픽셀) 스키마 추가, 출력 타입 불변
- **추가** `FloorRoiRawSchema = z.object({ points_2d: z.array(z.tuple([z.number(),z.number()])).length(4).optional(), bbox_2d: z.tuple([z.number(),z.number(),z.number(),z.number()]).optional(), confidence: z.number().min(0).max(1).default(0) })` (points_2d 우선, 없으면 bbox_2d).
- **추가** `OccupancyRawSpaceSchema = { id:int, occupied:boolean, points_2d?:4tuple, bbox_2d?:4tuple }`, `OccupancyRawSchema = { spaces:[...], confidence }`.
- **불변**: 기존 `FloorRoiResultSchema`(정규화 {x,y}×4), `OccupancyResultSchema`, `FloorRoiInput/OccupancyInput`, 반환 타입(`FloorRoiResult`/`OccupancyJudgment`) — 다운스트림 계약 유지.

### 3‑3. `src/brain/AgentRuntime.ts` — 리사이즈·픽셀 파싱·정규화 변환
- **`recognizeFloorRoi`**(before: 원본 b64 를 그대로 chatJson, 정규화 폴리곤 파싱):
  - after:
    1. `const { base64, width: W, height: H } = await smartResizeJpegBase64(input.imageBase64, this.cfg.llm.imageMaxEdge);`
    2. 템플릿에 `imgW=W, imgH=H` 및 **vehicle 를 픽셀 bbox** `[x1,y1,x2,y2]`(정규화×W/H)로 렌더.
    3. `const raw = await this.chatJson(system, user, j=>FloorRoiRawSchema.parse(j), base64, /*jsonMode*/true, this.cfg.floorRoi?.timeoutMs, /*prepared*/true);`
    4. raw→정규화 변환: `points_2d` 있으면 `normalizeQuad(points_2d, W, H)`(geometry.ts 재사용) → 4×{x,y}; 없고 `bbox_2d` 면 `rectToQuad(normalizeBox(bbox_2d, W, H))`. → `{ polygon, confidence }` (=`FloorRoiResult`).
- **`judgeOccupancy`**(before: 정규화 폴리곤/occupied 파싱, jsonMode off):
  - after: 위와 동일하게 pre‑resize + 템플릿 imgW/imgH, `OccupancyRawSchema.parse` → 각 space 의 pixel points/bbox 를 `normalizeQuad`/`normalizeBox+rectToQuad` 로 정규화 폴리곤화 → 기존 `OccupancyResult.spaces` 형태로 매핑(폴리곤 없으면 optional 유지). occupiedCount/total/rate 산술은 **기존대로 결정형**.
- **`adviseCentering`**: 좌표 생성이 아니므로 형식 전환 없음. 이미지가 chat() 기본 경로로 다운스케일되며 해상도 상향(imageMaxEdge↑)의 혜택만 받음. 프롬프트 소폭(§5‑3).
- **`chat` / `chatJson`**: `prepared` 플래그(기본 false) 추가. `prepared=true` 면 chat() 내부 `downscaleJpegBase64` **건너뜀**(이미 §3‑1 로 정확 크기 준비됨). 그 외 경로(stage1/centering)는 기존 동작 유지.
  - 픽셀→정규화 변환은 **각 메서드가 로컬 W,H 로 직접** 수행(chatJson 은 RAW 타입 그대로 반환) → chatJson 시그니처는 `prepared` 인자만 증가, 파서는 제네릭 유지.

### 3‑4. `src/config/llmConfig.ts` + `config/llm.config.json`
- `LlmSchema.imageMaxEdge` 기본 유지(하위호환), **llm.config.json 에서 1288 로 상향**(=46×28, 16:9 시 1288×728≈0.94M<max). 
- `FloorRoiSchema` 에 `timeoutMs: z.number().int().positive().default(120000)` 추가(occupancy 선례). llm.config.json floorRoi 에 `timeoutMs` 설정(고해상도 32B 대비). `loadLlmConfig` 병합 로직은 기존 spread 로 커버.

### 3‑5. 프롬프트 3종 (§5 최종 초안)
- `config/prompts/floor_roi.yaml`, `occupancy.yaml` — 픽셀 4점(또는 bbox_2d) 그라운딩으로 재작성 + `{{imgW}}/{{imgH}}` 변수.
- `config/prompts/ptz_centering.yaml` — 소폭(그라운딩 어투/명료화), 스키마 불변.

---

## 4) 좌표 변환 파이프라인 설계 (전송 크기 확보 · 정규화 · 애매성 제거)

핵심 아이디어: **우리가 보내는 이미지를 smart‑resize 고정점으로 만든다.** 두 변이 28의 배수이고 픽셀 수 ≤ `max_pixels` 이면, vLLM 내부 smart‑resize 는 **항등**(크기 불변)이 된다. ⇒ 모델이 반환하는 픽셀 좌표계 == 우리가 보낸 이미지(W×H) == 원본 처리해상도. "리사이즈된 vs 원본" 애매성이 원천 소거된다.

```
원본 JPEG(예 1920×1080)
   └─ smartResizeJpegBase64(b64, imageMaxEdge=1288)   [3-1]
        → 전송 base64 + (W,H) 예: 1288×728  (28의 배수, ≤1.0M px)
   └─ 프롬프트에 imgW=1288, imgH=728, vehicle=픽셀bbox 주입   [3-3]
   └─ chatJson(prepared=true) → vLLM Qwen2.5-VL-32B
        → RAW 픽셀: {"points_2d":[[x,y]×4] | "bbox_2d":[x1,y1,x2,y2], "confidence"}
   └─ 코드 변환(AgentRuntime, LpdClient 선례):
        normalizeQuad(points, W, H)  또는  rectToQuad(normalizeBox(bbox, W, H))
        → 정규화 0~1 폴리곤(각 점 clamp01)
   └─ 기존 다운스트림 그대로:
        FloorRoiReviewer → resolveFloorPolygon(polyRaw, ...)
        → normalizePolygon(convexHull+캐노니컬 정렬+마진)   ※ 파일 무변경
```

포인트:
- **전송 크기 확보**: sharp 재인코딩 결과의 실제 (W,H) 를 리사이저가 반환(추정 아님). `readJpegSize` 로 교차검증 가능.
- **정규화 기준**: 반드시 **"보낸 이미지"의 W,H** 로 나눈다(원본 1920 아님). 다운스케일을 코드가 하므로 이 값을 정확히 안다 — LpdClient 가 캡처 해상도로 `normalizeQuad` 하던 것과 동일 패턴.
- **정규화 좌표의 스케일 불변성**: 정규화 후에는 어떤 균일 스케일에도 불변 → `resolveFloorPolygon`/`normalizePolygon` 규약(0~1, 볼록, 캐노니컬 순서)에 그대로 투입. Qwen 점 순서가 규약과 달라도 `orderConvexCanonical` 이 [앞왼,앞오,뒤오,뒤왼]로 재정렬하므로 **강건**.
- **하위호환**: RAW 파서가 `points_2d` 부재 시 `bbox_2d` 수용, 둘 다 없으면 스키마 실패→`chatJson` 재시도→null→다운스트림 결정형 폴백(기존 불변식). 회귀 경로 보존.

---

## 5) 프롬프트 최종 초안

### 5‑1. `config/prompts/floor_roi.yaml`
```yaml
# 차량 바닥 점유 슬롯(4점 OBB) 픽셀 그라운딩 프롬프트. Qwen2.5-VL 네이티브 절대픽셀 출력.
# 좌표계: 주어진 W×H 이미지의 절대 픽셀(원점=좌상단). 코드가 0~1 정규화로 변환한다.
system: |
  You are a visual grounding expert for a fixed, downward-tilted CCTV parking view.
  Task: locate the FLAT GROUND RECTANGLE that ONE target vehicle occupies (the parking
  slot footprint on the floor), NOT the car body.
  The image is {{imgW}}x{{imgH}} pixels. Output ABSOLUTE PIXEL coordinates in that space.

  바닥 슬롯 정의(엄수):
  - 앞(카메라 근접)변 = 대상 차량 **타이어 접지선**. 뒤(먼)변 = 휠스톱/후방 주차선/차 뒤 지면 끝.
  - 좌우변 = 옆 슬롯과 나누는 주차선. 같은 줄 빈 슬롯과 비슷한 앞뒤 깊이.
  - 지붕·차체높이·창문·그림자·범퍼돌출 제외. 바닥에 누운 납작한 사다리꼴(원근으로 기움).

  대상 지정: 대상 차량 bbox(픽셀 [x1,y1,x2,y2])가 주어진다. 위치 표시용이며 억지로 맞추지 말고
  그 위치 차량이 실제 깔고 앉은 지면 슬롯을 판단해 그린다. 대상 1대의 슬롯만.

  Output format (STRICT, JSON object only, no prose, no code fence):
  {"points_2d": [[x,y],[x,y],[x,y],[x,y]], "confidence": 0.0}
  - points_2d = 4 corners of the ground slot in ABSOLUTE PIXELS, order [front-left,
    front-right, rear-right, rear-left] (front = nearer camera / larger y). Clockwise.
  - confidence in 0.0~1.0.
user: |
  camera={{camIdx}} preset={{presetIdx}} image={{imgW}}x{{imgH}}px
  target vehicle bbox (pixels [x1,y1,x2,y2]): {{vehiclePx}}
  Locate the ground parking-slot rectangle this vehicle occupies and output its 4 corner
  points in absolute pixels as the JSON schema above. Ground footprint only (tire contact
  line at front, slot far end at rear), not the car body.
```

### 5‑2. `config/prompts/occupancy.yaml`
```yaml
# 보이는 모든 주차면을 픽셀 4점으로 국소화 + 점유 판정. Qwen2.5-VL 절대픽셀.
system: |
  You are a visual grounding expert for a downward-tilted CCTV parking view
  ({{imgW}}x{{imgH}} pixels). Detect EVERY visible parking slot (painted floor rectangle),
  output each slot's ground footprint as 4 ABSOLUTE PIXEL corners, and judge occupancy.
  Map the floor slot (ground), not the car body.

  각 면: 앞변=카메라 근접(점유면이면 타이어 접지선), 뒤변=먼 끝(휠스톱/주차선), 좌우변=구획 주차선.
  같은 줄 빈 면과 비슷한 앞뒤 깊이. 지붕·차체높이·그림자·범퍼돌출·주행로·인도·기둥 제외.
  빈 면과 점유 면 모두 나열. 왼→오, 위 줄 먼저로 1-based id. recall 우선(먼/어두운 면도 포함).
  점유율(%)은 계산하지 말 것 — occupied 플래그만. 보이는 면이 없으면 spaces=[].

  Output format (STRICT, JSON object only, no prose/code fence):
  {"spaces":[{"id":1,"occupied":true,"points_2d":[[x,y],[x,y],[x,y],[x,y]]}],"confidence":0.0}
  - points_2d = 4 corners in ABSOLUTE PIXELS, order [front-left,front-right,rear-right,rear-left]
    (front = larger y, nearer camera), clockwise. occupied required.
user: |
  camera={{camIdx}} preset={{presetIdx}} image={{imgW}}x{{imgH}}px expected(hint)={{expected}}
  List every visible parking slot with its 4 ground-footprint corner points (absolute pixels)
  and occupied flag, per the JSON schema. Floor footprint only, not the car body.
```
- jsonMode: occupancy 는 **off 유지**(다면 디코딩 가속 + extractJson 회수, 기존 선례). floor 는 단일 소형 객체라 **json_object 유지**(스키마가 top‑level object 라 vLLM guided decode 호환).

### 5‑3. `config/prompts/ptz_centering.yaml` (소폭)
- 스키마·의미 불변. system 첫 줄에 이미지 픽셀 크기 인지 문구만 추가하고 표현 명료화. 좌표 출력이 없으므로 픽셀 전환 없음. (변경 최소 — 정확도 기여가 작음.)

---

## 6) 해상도 정책
- **imageMaxEdge = 1288**(=46×28). 16:9 → 1288×728(≈0.94M px, <max_pixels 1.0M). 4:3 → 1288×968(28스냅) 재확인해 max 초과 시 자동 축소(§3‑1 4단계).
- 상한 상수 `MAX_PIXELS = 1280*28*28`(Qwen 검출 기본), `FACTOR=28` 을 image.ts 에 명시(설정 노출 안 함 — 단순함). 서버 vLLM 이 더 낮은 max_pixels 로 구성돼 있으면 전송 이미지가 재축소되어 좌표 불일치 위험 → §10 리스크에 명시(서버 max_pixels ≥ 1.0M 전제).
- 작업별 차등: floor/occupancy 만 smartResize 경로(정밀 필요). stage1/centering 은 기존 downscale(정규화/자문이라 28정렬 불필요) — 단 imageMaxEdge 상향 혜택은 공유.

---

## 7) 단계별 실행 (단계 → 검증)

1. `smartResizeJpegBase64` 추가(image.ts) → **검증**: 유닛 — 1920×1080 입력 시 반환 (W,H) 가 28의 배수·≤MAX_PIXELS·종횡비 근사, 반환 base64 가 유효 JPEG(sharp 디코드).
2. RAW 스키마 추가(SetupBrain.ts) → **검증**: 유닛 — points_2d 4점 / bbox_2d / 둘다부재 각각 parse 성공·실패가 기대대로.
3. `chat/chatJson` `prepared` 플래그 + `recognizeFloorRoi` 픽셀 파이프라인 전환 → **검증**: 유닛(fake OpenAI 서버가 `{"points_2d":[[px..]]}` 픽셀 반환) — 반환 polygon 이 정규화 0~1·4점, W,H 로 나눈 값과 일치. `bbox_2d` 만 준 경우도 4점 폴리곤화.
4. `judgeOccupancy` 픽셀 전환 → **검증**: 유닛 — spaces 픽셀 points → 정규화 폴리곤, occupiedCount/total/rate 산술 불변, 폴리곤 부재 space graceful.
5. config 상향(imageMaxEdge=1288, floorRoi.timeoutMs) + 프롬프트 3종 교체 → **검증**: `promptsYaml.test.ts` 로 yaml 로드/치환 키(`imgW`,`imgH`,`vehiclePx`) 존재 확인. `config.test.ts` 로 스키마 파싱.
6. `prepared=true` 시 chat() 이 재다운스케일 안 함 → **검증**: 유닛 — downscale 이중 적용이 없음(spy 미호출 또는 전송 이미지 크기가 준비 크기와 동일)을 모킹으로 확인.
7. **라이브 스모크(리더 수행, 필수)**: floorRoi.enabled=true 로 실제 프레임 1~3장 → 오버레이 폴리곤이 차량 접지면과 정합하는지 육안. occupancy 면별 폴리곤 육안. 좌표 sanity(0~1, 4점, 앞=y큰쪽).

---

## 8) 유닛테스트 케이스 (vitest)

신규/수정 파일 후보:
- `test/imageSmartResize.test.ts`(신규): (a) 1920×1080→W,H 28배수·≤MAX_PIXELS, (b) 종횡비 근사(±1 factor 이내), (c) 소형 입력도 28 스냅, (d) 유효 JPEG 디코드, (e) 비이미지 throw.
- `test/agentRuntimeFloor.test.ts`(수정): fake 서버 응답을 **픽셀 points_2d** 로 교체 → 반환 polygon 이 `points/W,H` 와 일치(정규화 검증). `bbox_2d` 폴백 케이스 추가. enabled=false/llm.enabled=false null 유지.
- `test/agentRuntimeOccupancy.test.ts`(수정): 픽셀 points_2d 다면 응답 → 정규화 폴리곤·집계 산술 불변. 폴리곤 부재 space 처리.
- `test/floorRoi.test.ts`/`floorRoiNormalizeEdge.test.ts`(불변 확인): 다운스트림 정규화 계약이 그대로임을 회귀로 재실행(변경 없음).
- `test/promptsYaml.test.ts`(수정): 새 치환 키 존재/렌더.
- `test/config.test.ts`(수정): imageMaxEdge=1288, floorRoi.timeoutMs 파싱.

핵심 단언: **픽셀→정규화 변환 정확성**(예: points [644,364] @1288×728 → {x≈0.5, y≈0.5}), 4점 길이, clamp01. 순서 규약은 다운스트림이 재정렬하므로 값 정합만 확인.

---

## 9) 영향도

- **직접 변경**: `src/util/image.ts`(추가), `src/brain/AgentRuntime.ts`(floor/occupancy/chat), `src/brain/SetupBrain.ts`(RAW 스키마 추가), `src/config/llmConfig.ts`(floorRoi.timeoutMs), `config/llm.config.json`, 프롬프트 3종.
- **무변경(계약 보존)**: `src/capture/floorRoi.ts`(resolveFloorPolygon/normalizePolygon), `FloorRoiReviewer.ts`/`OccupancyReviewer.ts`(정규화 폴리곤 소비), `domain/geometry.ts`(normalizeQuad/normalizeBox/rectToQuad **재사용만**), `SqliteStore`/store, viewer 오버레이. 반환 타입 `FloorRoiResult`/`OccupancyJudgment` 불변 → downstream 시그니처 영향 없음.
- **다른 LLM 경로**: stage1/2/3, checkpoint, finalize, centering 은 좌표 출력이 없어 영향 없음(해상도 상향 혜택만). `downscaleJpegBase64` 유지로 기존 `imageDownscale.test.ts` 불변.
- **성능**: 해상도 0.52M→0.94M + 32B → 호출 지연 증가(무관, 셋팅용). floorRoi.timeoutMs 상향으로 타임아웃 폴백 방지.
- **@parkagent/types / MCP**: 변화 없음(내부 두뇌 경계 안에서 처리).

MCP 도구 vs LLM 두뇌 경계 판단:
- **LLM 두뇌**(맥락·형상 판단): 바닥 슬롯 4점 그라운딩, 점유 판정 — Qwen 픽셀 그라운딩. 유지.
- **결정형**(수치·검증): 픽셀→정규화 변환, clamp/볼록껍질/캐노니컬 정렬/마진/비겹침/집계 산술 — 전부 코드(AgentRuntime 경계 + floorRoi.ts). 경계 위반 없음(LLM 은 좌표 "생성"만, 검증·강등은 결정형).

---

## 10) 리스크 · 대안 (조사 불확실성 포함)

1. **반환 좌표계 애매성**(처리해상도 vs 원본): §4 의 28정렬 전송으로 서버 내부 리사이즈를 항등화해 소거. **단, 서버 vLLM 의 `max_pixels` 가 우리 전송(≈0.94M)보다 작게 구성**되면 서버가 재축소 → 좌표 불일치. 완화: MAX_PIXELS 를 Qwen 기본(1.0M)로 잡고 전송 ≤ 그 값. 필요 시 서버 processor min/max_pixels 확인. 대안: 리사이저가 실제 전송 (W,H) 를 반환하므로 스모크에서 어긋나면 전송 상한을 더 낮춰 재검.
2. **OBB(4점) 그라운딩 신뢰도**: Qwen 네이티브는 축정렬 bbox/point 가 가장 안정적. 임의 사변형 4코너 point 그라운딩은 상대적으로 OOD → 접지선/먼끝 코너가 흔들릴 수 있음. 완화: (a) RAW 파서가 `bbox_2d` 도 수용(모델이 bbox 로 답하면 축정렬 4코너로), (b) 다운스트림 `resolveFloorPolygon` 결정형 폴백 유지. **대안(스모크 결과에 따라)**: floor 를 "bbox_2d(축정렬) 우선 + 번호판 각도로 회전 재구성"(현행 `buildPlateAnchoredQuad` 자산 활용) 하이브리드로 전환. 1차는 points_2d 로 시도하고 부정확하면 이 대안 채택 — 결정은 스모크 육안 후.
3. **28 스냅에 의한 미세 종횡비 변화**(≤14px/축): 좌표를 "보낸 이미지" 기준 정규화하므로 자체는 무해하나, 스냅 왜곡이 원근을 미세 변형. 완화: 긴변 큰 값(1288)에서 상대 왜곡 <1.1% → 무시 가능.
4. **json_object(guided) vs off**: floor 는 object 스키마라 json_object 호환·유지. 만약 guided decode 가 그라운딩 품질을 떨어뜨리면 floor 도 off + extractJson 로 전환(occupancy 선례). 스모크에서 판단.
5. **프롬프트 언어**: Qwen 그라운딩 예제는 영어 지시가 다수 → 지시문은 영어, 도메인 규약은 한국어 혼용으로 초안. 품질 미흡 시 전 영어화 대안.

### 미해결/가정 (리더 확인 요청)
- (가정) vLLM 서버 max_pixels ≥ 1.0M — 아니면 imageMaxEdge 하향 필요. **확인 요청**: 서버 기동 옵션의 min/max_pixels 값.
- (가정) 1차 floor 출력은 **points_2d 4코너**. 스모크 부정확 시 §10‑2 대안(bbox+번호판 회전)으로 전환 — **리더 육안 결과 공유 요청**.
- (확인) imageMaxEdge 전역 1288 상향이 stage1 등 다른 비전 호출 지연을 키우는데 허용 가능한지(셋팅용이라 무관 예상).

---

### 구현자 전달 요약
- 신규: `smartResizeJpegBase64`(image.ts, 28정렬·(W,H)반환). RAW 픽셀 Zod 스키마(SetupBrain.ts).
- 수정: AgentRuntime `recognizeFloorRoi`/`judgeOccupancy`(pre‑resize→픽셀파싱→`normalizeQuad`/`normalizeBox+rectToQuad` 정규화), `chat/chatJson` `prepared` 플래그. llmConfig `floorRoi.timeoutMs`. llm.config.json imageMaxEdge=1288 + floorRoi.timeoutMs. 프롬프트 3종.
- 무변경 사수: floorRoi.ts / reviewer / geometry(재사용) / 반환 타입.
- 문서화(documenter) 영향범위 초안: §9 표 그대로.
