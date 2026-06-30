# 01 · 설계서 — LLM 비전 기반 차량 바닥 점유 영역(floor ROI · 4점 사변형) 인식

작성: 설계자(architect) · 대상: SettingAgent · 분류: 기능 추가(가산 · 기존 계약 무영향)

---

## 0. 목적·범위·확정 결정

**목적**: LLM(비전, 현재 `gemma4:12b`)이 프리셋 이미지 + 차량 bbox(+번호판 bbox)를 보고, 차량이 **지면에 닿는 4모서리(원근 투영 footprint)** 를 추론하여 **바닥 점유 영역(floor ROI)** 을 4점 사변형으로 산출한다. 기존 차량 bbox ROI(`roiByPreset`)는 보존하고, 정밀수집(/capture) 체크포인트 주기에 floor ROI 를 (재)계산·갱신한다. 뷰어가 폴리곤으로 표시한다.

**확정 결정(마스터, 그대로 따른다)**
1. **형태 = 4점 사변형**(`NormalizedQuad`). 3D 계산 없음 — 단일 카메라 이미지 평면 원근 사변형.
2. **비전 모델 = 현재 `gemma4:12b`**. 기존 `AgentRuntime` 의 `image_url`(base64) 경로 재사용. 별도 VLM 엔드포인트 없음.
3. **계산 시점 = 체크포인트 주기**(`checkpointEvery`). 정밀수집 반복 중 K라운드마다 LLM 으로 floor ROI 를 (재)계산. 기존 `CheckpointReviewer` 와 같은 cadence.
4. **계약 = 가산적**. `ParkingSlot.floorRoiByPreset?: Record<key, NormalizedQuad>` 신설(`roiByPreset` 보존) → Action/DM 무영향(옵셔널 필드).
5. **표시**: 뷰어가 바닥 사변형(폴리곤)을 차량 bbox 와 다른 색으로 그린다.

**비목표(과설계 금지)**
- 3D 복원·호모그래피·바닥 평면 추정 없음. 다각형(N>4) 없음. **항상 정확히 4점**.
- 셋업(단발) 경로 floor ROI 는 **이번 범위 외**(§7에서 근거 기술 — 옵셔널 메서드라 기존 게이트 무영향, 추후 가산 가능).
- floor ROI 를 Action/DM 이 소비하도록 만드는 작업 없음(필드만 노출).

**불변식(반드시 보존)**
- 기존 `roiByPreset`/`plateRoiByPreset` 좌표·shape 불변. 기존 248개 vitest 회귀 0.
- LLM 비활성(`llm.enabled=false`) 또는 신규 플래그 off 시 floor ROI 계산을 **호출하지 않는다**(결정형 경로 무변화).
- floor ROI 는 **항상 존재 가능**해야 한다(LLM 실패·무효 시 bbox 유도 폴백 사변형).

---

## 1. 현황 사실(코드 확인 결과)

| 항목 | 사실 | 근거 파일 |
|------|------|-----------|
| 공유 타입 | `NormalizedRect{x,y,w,h}` 만 존재. `ParkingSlot.roiByPreset`/`plateRoiByPreset?` 보유. Quad 없음 | `packages/types/src/index.ts:5-43` |
| 타입 재수출 | SettingAgent 는 `@parkagent/types` 를 `domain/types.ts` 에서 재수출 | `SettingAgent/src/domain/types.ts:3-14` |
| 비전 LLM 경로 | `AgentRuntime.chat()` 가 `imageBase64` 주면 `image_url`(data:image/jpeg;base64) 멀티모달 메시지 구성. `chatJson()` 가 JSON 모드+2회 재시도+zod parse | `AgentRuntime.ts:166-206` |
| 두뇌 인터페이스 | `SetupBrain` 에 옵셔널 메서드(`reviewCheckpoint?`/`finalizeCapture?`) 패턴 존재 → 가산 메서드 추가 용이 | `SetupBrain.ts:100-109` |
| 체크포인트 통합점 | `CaptureJob.checkpoint(roundIdx)` 가 `done % checkpointEvery === 0` 일 때 집계+`reviewer.review()` 호출. `lastFrame`(jpeg 1장)만 보관 — **프리셋별 보관 없음** | `CaptureJob.ts:164-167, 192, 231-249` |
| 집계 슬롯 | `AggregatedSlot` 에 bbox(x,y,w,h)+plate 4값. floor quad 칸 없음 | `capture/types.ts:46-62` |
| 집계 저장 | `aggregated_slot` 테이블(고정 컬럼). floor quad 컬럼 없음 | `SqliteStore.ts:54-61, 176-207` |
| 최종 조립 | `Finalizer.assemble()` 가 채택 클러스터→`ParkingSlot{roiByPreset,plateRoiByPreset?}` 조립 | `Finalizer.ts:131-175` |
| 프롬프트 로드 | `loadPrompt`/`renderTemplate`(`{{key}}`)/`extractJson`. config 의 `setupPrompts.{stageN}.{system,user}` 파일 경로로 로드 | `brain/prompts.ts`, `llmConfig.ts:42-85` |
| 뷰어 오버레이 | `drawRoiOverlay()` 가 `roiByPreset`(청록 `#00e5ff` strokeRect)·`plateRoiByPreset`(노랑 `#ffd60a`)만 그림. `toPixel(rect,…)` 은 rect 전용 | `web/app.js:134-162`, `web/core.js:11-13` |
| 분석 | `analyzeArtifact()` 가 slot 평탄화(roi/hasPlate). floor 미인지 | `web/core.js:148-176`, `web/core.d.ts:68-92` |
| capture 설정 | `CaptureSchema`(intervalMs/checkpointEvery/clusterDist…). floor 플래그 없음 | `toolsConfig.ts:61-76, 184-187` |

**확인된 제약**
- `gemma4:12b` 는 좌표 정밀도가 낮을 수 있음 → **폴백 필수**(§4), 좌표 검증·클램프 필수.
- `CaptureJob` 은 `lastFrame` 1장만 보관 → 체크포인트에서 **프리셋별 최근 프레임**이 필요하므로 보관 구조를 추가해야 함(§5).
- `aggregated_slot` 은 PK 없는 평면 테이블이고 `replaceAggregatedSlots` 가 run 단위 delete+insert(멱등). floor quad 는 LLM 산출이라 집계 재실행 시 덮어쓰면 안 됨 → **별도 테이블**(§6 근거).

---

## 2. 타입 신설 (가산) — `@parkagent/types`

### 2.1 `NormalizedQuad`
```ts
/** 정규화 4점 사변형 (좌표계 0~1). 차량 바닥 점유 영역(원근 투영 footprint).
 *  모서리 순서 규약: [0]=앞왼(frontLeft), [1]=앞오(frontRight), [2]=뒤오(rearRight), [3]=뒤왼(rearLeft).
 *  "앞"=카메라에 가까운 변(이미지 하단 쪽), 시계방향. */
export type NormalizedQuad = [NormalizedPoint, NormalizedPoint, NormalizedPoint, NormalizedPoint];
export interface NormalizedPoint { x: number; y: number; }
```
- 정확히 4점 고정 길이 튜플. (객체 `{frontLeft,…}` 대신 배열 — zod·뷰어 폴리곤 순회가 단순. 순서 규약은 주석·프롬프트로 강제.)

### 2.2 `ParkingSlot` 확장
```ts
export interface ParkingSlot {
  slotId: string;
  zone: string;
  roiByPreset: Record<string, NormalizedRect>;
  plateRoiByPreset?: Record<string, NormalizedRect>;
  /** key=`${camIdx}:${presetIdx}` → 이 면 차량의 바닥 점유 영역(LLM 비전 추론, 정규화 4점 사변형).
   *  roiByPreset(축정렬 차량 bbox)과 별개·가산. 미산출 시 키 없음. */
  floorRoiByPreset?: Record<string, NormalizedQuad>;
}
```

**검증**: `packages/types` 빌드(`tsc`) 통과 + `NormalizedQuad`/`NormalizedPoint` export 됨.

---

## 3. LLM 비전 메서드 — `recognizeFloorRoi`

### 3.1 인터페이스(`SetupBrain.ts`, 옵셔널 — 기존 구현 무영향)
```ts
export interface FloorRoiInput {
  camIdx: number; presetIdx: number;
  imageBase64: string;                 // 프리셋 최근 프레임 JPEG
  vehicle: NormalizedRect;             // 대상 차량 bbox(집계 대표)
  plate?: NormalizedRect;              // 번호판 bbox(있으면 앞쪽 단서)
  slotHint?: string;                   // 예: "presetKey#clusterId" (로깅/맥락)
}
export const FloorRoiResultSchema = z.object({
  quad: z.array(z.object({ x: z.number(), y: z.number() })).length(4),
  confidence: z.number().min(0).max(1).default(0),
});
export type FloorRoiResult = z.infer<typeof FloorRoiResultSchema>;

// SetupBrain 인터페이스에 추가:
recognizeFloorRoi?(input: FloorRoiInput): Promise<FloorRoiResult | null>;
```
- zod 는 길이 4만 강제. **0~1 클램프·순서 정규화는 유틸(§4)에서** 수행(zod 통과 후). 이유: 범위 초과를 reject 하지 않고 클램프로 살려야 floor ROI 항상 존재.

### 3.2 구현(`AgentRuntime.ts`)
- 신규 메서드 `recognizeFloorRoi`. `this.client` 없거나 `cfg.floorRoi?.enabled !== true` 면 `null`.
- 전용 프롬프트 로드(`cfg.floorRoi.prompt.{system,user}`), `renderTemplate` 변수: `camIdx`, `presetIdx`, `vehicle`(JSON), `plate`(JSON 또는 `(없음)`).
- 호출: `this.chatJson(system, user, (j)=>FloorRoiResultSchema.parse(j), input.imageBase64)` — **기존 image_url 경로 100% 재사용**(신규 HTTP 코드 없음).
- 반환은 검증 전 raw quad(점 4개) — 클램프/순서 정규화는 호출측(§5 통합 지점)에서 `normalizeQuad()` 적용.

### 3.3 전용 프롬프트 파일(신규)
- `config/prompts/floor_roi.system.md`, `config/prompts/floor_roi.user.md` (기존 stage 프롬프트 스타일 모방 — `extractJson` 친화, 코드펜스 없이 JSON 만).
- system 핵심 지시:
  - "차량이 **지면에 닿는 4모서리**(바퀴 접지면 바깥 윤곽)만 추정. 지붕·차체 높이·그림자 제외."
  - "원근 때문에 위에서 본 직사각형이 이미지에서는 사다리꼴로 보인다 — 그 사다리꼴 4점."
  - 순서 규약: `[앞왼, 앞오, 뒤오, 뒤왼]`(앞=이미지 하단/카메라 근접, 시계방향).
  - 좌표 정규화 0~1. "오직 JSON 객체만, 설명·코드펜스 금지."
  - 스키마: `{"quad":[{"x":..,"y":..} × 4], "confidence":0~1}`
- user 템플릿: `camera={{camIdx}} preset={{presetIdx}}`, 차량 bbox `{{vehicle}}`, 번호판 `{{plate}}`, "이 차량의 바닥 점유 사변형을 JSON 으로만 답하라."

**검증**: AgentRuntime 단위테스트 — fake OpenAI client 가 4점 JSON 반환 시 `FloorRoiResult` 파싱 성공; `floorRoi.enabled=false` 시 `null`.

---

## 4. 강건성 / 폴백 / 좌표 정규화 — 신규 순수 모듈 `capture/floorRoi.ts`

순수 함수(테스트 용이, 외부 의존 0):

```ts
/** bbox 하단부를 지면 근사한 폴백 사변형. floor ROI 항상 존재 보장.
 *  하단 band(예: 아래 35%)를 footprint 로, 원근 근사로 윗변을 살짝 안쪽으로. */
export function fallbackQuadFromRect(r: NormalizedRect): NormalizedQuad;

/** LLM raw quad → 유효 NormalizedQuad. 점!=4·NaN·전부범위초과면 null(호출측이 폴백).
 *  그 외엔 각 점 0~1 클램프 + 순서 정규화(앞=y큰 두 점, 뒤=y작은 두 점; 각 쌍 x로 좌/우). */
export function normalizeQuad(raw: Array<{x:number;y:number}>): NormalizedQuad | null;

/** 최종 진입점: LLM 결과(또는 null) + 차량 rect → 항상 NormalizedQuad. */
export function resolveFloorQuad(llm: FloorRoiResult | null, vehicle: NormalizedRect): NormalizedQuad;
```

- `fallbackQuadFromRect`: 차량 bbox `{x,y,w,h}` 에서 하단 접지 근사. 예) 바닥 변 y=`y+h`, 윗 변 y=`y+h*(1-band)`, 윗 변은 원근 상 좁으므로 좌우 inset(예 `w*0.1`). 단순 결정형(LLM 무관) — 항상 그럴듯한 사변형.
- `normalizeQuad`: 점 수·수치 유효성 검사 → 클램프 → **순서 강제**(LLM 이 순서를 틀려도 뷰어 폴리곤이 꼬이지 않게). y 기준 하/상 분리, x 기준 좌/우 분리 → `[앞왼,앞오,뒤오,뒤왼]`.
- `resolveFloorQuad`: `normalizeQuad(llm?.quad)` 실패 시 `fallbackQuadFromRect(vehicle)`.

**검증(vitest, 핵심 목표 중심)**:
- `fallbackQuadFromRect`: 입력 rect→4점, 모두 0~1, 바닥 변 y > 윗 변 y.
- `normalizeQuad`: 3점→null, 범위초과→클램프, 뒤섞인 순서→`[앞왼,앞오,뒤오,뒤왼]` 정렬.
- `resolveFloorQuad`: llm=null→폴백 사변형; 유효 llm→정규화 quad.

---

## 5. 체크포인트 통합 — 프리셋별 프레임 보관 + floor 계산

### 5.1 `CaptureJob` — 프리셋별 최근 프레임 보관
- 신규 필드 `private lastFrameByPreset = new Map<string, Buffer>();` (key=`${camIdx}:${presetIdx}`).
- `captureTarget()` 에서 `this.lastFrameByPreset.set(\`${t.camIdx}:${t.presetIdx}\`, cap.jpg)` 추가(기존 `lastFrame` 보존 — 가산 1줄).
- 메모리: 프리셋 수 × JPEG 1장(수십~수백 KB). 프리셋 수십 개 가정 → 수 MB. 허용(리스크 §10에 명시). run 시작 시 `clear()`.

### 5.2 신규 협력자 `capture/FloorRoiReviewer.ts`
`CheckpointReviewer` 와 같은 cadence·같은 장애격리 패턴. **좌표 생성을 하는 유일한 LLM 단계**(기존 reviewer 는 좌표 불변, 이건 floor quad 생성 — 역할 분리해 별 클래스로).

```ts
export class FloorRoiReviewer {
  constructor(deps: { store: SqliteStore; brain?: SetupBrain; now?: () => string });
  /** 집계 슬롯 + 프리셋별 프레임으로 floor quad (재)계산·저장. brain 비활성/메서드 없음 시 no-op. */
  async review(runId, slots: AggregatedSlot[], framesByPreset: Map<string, Buffer>): Promise<void>;
}
```
동작:
1. `brain?.enabled && brain.recognizeFloorRoi` 아니면 return(no-op).
2. 채택 후보(`status !== 'rejected' && !== 'merged'`) 슬롯만 순회.
3. 각 슬롯: `framesByPreset.get(presetKey)` 없으면 skip(이번 라운드 프레임 부재). 있으면 `recognizeFloorRoi({…, imageBase64: jpeg.toString('base64'), vehicle:{x,y,w,h}, plate: plate값 있으면})` 호출(try/catch — 실패 시 그 슬롯은 폴백).
4. `resolveFloorQuad(llmResult, vehicleRect)` 로 quad 확정(항상 존재).
5. `store.upsertFloorRoi(runId, presetKey, clusterId, quad)` 저장(§6).
- **호출 한도**: 슬롯 수가 많으면 토큰·시간 비용 큼 → `cfg.floorRoi.maxPerCheckpoint`(예 12) 로 상한, 초과분은 이번 체크포인트 skip(다음 주기에). 결정형 폴백이 항상 있으므로 누락 슬롯도 floor ROI 보유.

### 5.3 `CaptureJob.checkpoint()` 에서 호출
- 기존 `checkpoint(roundIdx)` 끝부분에 가산: `floorReviewer` 주입돼 있으면 `await this.deps.floorReviewer.review(runId, slots, this.lastFrameByPreset)`.
- `CaptureJobDeps` 에 `floorReviewer?: FloorRoiReviewer` 추가(옵셔널 — 미주입 시 기존 동작 그대로).

**검증**: `FloorRoiReviewer` 단위테스트 — fake brain(4점 반환)+fake store, 프레임 있는 프리셋만 upsert 호출; brain 비활성 시 no-op; LLM throw 시 폴백 quad 로 upsert; maxPerCheckpoint 상한 준수.

---

## 6. 저장 — 신규 테이블 `floor_roi` (근거: 별도 테이블)

**결정: `aggregated_slot` 컬럼 확장이 아니라 신규 테이블.**
근거: `replaceAggregatedSlots` 는 매 체크포인트 run 단위 **delete+insert**(집계 멱등) → 같은 행에 floor quad 를 두면 다음 집계가 덮어써 소실. floor quad 는 LLM 산출이라 집계와 수명주기가 다름 → 분리가 맞다. 또한 quad=8실수라 컬럼 8개 추가는 평면 테이블을 비대하게 함.

```sql
CREATE TABLE IF NOT EXISTS floor_roi (
  run_id INTEGER, preset_key TEXT, cluster_id INTEGER,
  x0 REAL,y0 REAL, x1 REAL,y1 REAL, x2 REAL,y2 REAL, x3 REAL,y3 REAL,
  updated_at TEXT,
  PRIMARY KEY (run_id, preset_key, cluster_id)
);
```
`SqliteStore` 신규 메서드(가산):
- `upsertFloorRoi(runId, presetKey, clusterId, quad: NormalizedQuad)` — `INSERT … ON CONFLICT(run_id,preset_key,cluster_id) DO UPDATE`.
- `getFloorRois(runId): Array<{presetKey;clusterId;quad:NormalizedQuad}>`.
- `ensureSchema()` 에 `CREATE TABLE IF NOT EXISTS floor_roi …` 추가(IF NOT EXISTS — 기존 DB 무해, 마이그레이션 불필요).

**검증**: SqliteStore 단위테스트(`:memory:`) — upsert 후 get 으로 동일 quad 회수; 같은 키 재upsert 시 갱신(중복 행 없음).

---

## 7. Finalizer — artifact 에 `floorRoiByPreset` 포함

- `Finalizer.finalize()` 에서 최종 집계 후 `store.getFloorRois(runId)` 로 `Map<\`${presetKey}#${clusterId}\`, quad>` 구성.
- `assemble()` 가 채택 클러스터→`ParkingSlot` 만들 때, 그 클러스터의 quad 가 있으면 `slot.floorRoiByPreset = { [key]: quad }` 가산(`plateRoiByPreset` 패턴과 동일).
  - `assemble` 시그니처에 `floorByRef: Map<string, NormalizedQuad>` 인자 추가. 멤버의 `clusterRef(member)` 로 조회.
- floor quad 가 없는 슬롯은 `floorRoiByPreset` 키 자체를 안 만든다(옵셔널 보존).

**셋업(단발) 경로**: 이번 범위 외. `recognizeFloorRoi` 가 옵셔널 메서드이고 `SetupOrchestrator` 는 호출 코드를 추가하지 않으므로 단발 셋업은 완전 무변화. (추후 게이트로 가산 가능하나 마스터 지정 핵심은 정밀수집.)

**검증**: Finalizer 단위테스트 — store 에 floor_roi 있는 run finalize 시 해당 slot 에 `floorRoiByPreset[key]` 4점; 없는 run 은 필드 부재; 기존 `roiByPreset`/`plateRoiByPreset` 불변.

---

## 8. 설정 — `llm.config.json` / `llmConfig.ts`

`LlmConfigSchema` 에 **옵셔널** `floorRoi` 블록 추가(미설정 시 비활성 → 완전 무영향):
```ts
floorRoi: z.object({
  enabled: z.boolean(),
  maxPerCheckpoint: z.number().int().positive().default(12),
  prompt: z.object({ system: z.string().min(1), user: z.string().min(1) }),
}).optional()
```
- `DEFAULT_LLM_CONFIG` 에 `floorRoi: { enabled:false, maxPerCheckpoint:12, prompt:{system:'config/prompts/floor_roi.system.md', user:'config/prompts/floor_roi.user.md'} }`.
- `loadLlmConfig` 의 merge 에 `floorRoi` 1줄 추가.
- `config/llm.config.json` 에 `floorRoi.enabled:true` 로 활성(gemma 사용 중이므로).
- cadence 는 **재사용**(별도 주기 신설 없음 — `checkpointEvery` 사용).

**검증**: `loadLlmConfig` 단위테스트 — floorRoi 미설정 config 는 `floorRoi===undefined`(파싱 성공); 설정 시 enabled/prompt 회수.

---

## 9. 뷰어 표시 — 폴리곤 오버레이 + 분석

### 9.1 `web/core.js` — 순수 변환 함수 분리(테스트 대상)
```js
/** 정규화 quad(4×{x,y}) → 표시 픽셀 점 배열. toPixel 의 폴리곤판. */
export function toPixelQuad(quad, imgW, imgH) {
  return quad.map((p) => ({ px: p.x * imgW, py: p.y * imgH }));
}
```
- `core.d.ts` 에 `toPixelQuad(quad: NormalizedQuad, imgW, imgH): Array<{px;py}>` 선언 추가.
- `analyzeArtifact()` slot 평탄화에 `hasFloor: !!(s.floorRoiByPreset && Object.keys(s.floorRoiByPreset).length)` 추가, totals 에 `withFloor` 추가. `core.d.ts` 의 `ArtifactAnalysis` 동기 갱신.

### 9.2 `web/app.js` — `drawRoiOverlay()` 가산
- 신규 토글 `roi-floor`(index.html 체크박스 추가, 기존 `roi-vehicle`/`roi-plate` 패턴).
- slot 순회에 가산: `const fquad = slot.floorRoiByPreset?.[key]; if (fquad && showFloor) { ctx.beginPath(); const pts = toPixelQuad(fquad, overlay.width, overlay.height); pts.forEach((p,i)=> i? ctx.lineTo(p.px,p.py): ctx.moveTo(p.px,p.py)); ctx.closePath(); ctx.strokeStyle='#39ff14'; ctx.lineWidth=2; ctx.stroke(); }` (연두 — 청록/노랑과 구분).
- `index.html` 에 `roi-floor` 체크박스 + `setupEventListeners` 에 `$('roi-floor').addEventListener('change', drawRoiOverlay)` 가산.
- 분석 탭: floor 보유 슬롯 수 표기(`withFloor`).

**검증**: `core.js` 단위테스트 — `toPixelQuad` 4점 정확 변환; `analyzeArtifact` 가 `floorRoiByPreset` 있는 slot 에 `hasFloor:true`, totals.withFloor 카운트.

---

## 10. 단계별 작업 순서 + 검증

| # | 단계 | 검증 |
|---|------|------|
| 1 | `@parkagent/types`: `NormalizedQuad`/`NormalizedPoint`/`ParkingSlot.floorRoiByPreset?` 추가 → `packages/types` 빌드, SettingAgent `tsc` | `npm run build`(types) 통과, 재수출 import OK, **기존 248 테스트 회귀 0** |
| 2 | `capture/floorRoi.ts`(`fallbackQuadFromRect`/`normalizeQuad`/`resolveFloorQuad`) | vitest §4 — 폴백·클램프·순서정규화 |
| 3 | `SetupBrain.ts`: `FloorRoiInput`/`FloorRoiResultSchema`/`recognizeFloorRoi?` 추가 | typecheck; 스키마 length(4) 검증 |
| 4 | `AgentRuntime.recognizeFloorRoi` + 프롬프트 2파일 | vitest §3 — fake client 4점 파싱, 비활성 null |
| 5 | `llmConfig.ts`+`llm.config.json`: `floorRoi` 옵셔널 블록 | vitest §8 — 미설정/설정 파싱 |
| 6 | `SqliteStore`: `floor_roi` 테이블 + upsert/get | vitest §6 — upsert→get, 갱신 멱등 |
| 7 | `FloorRoiReviewer.ts` | vitest §5 — upsert 호출/no-op/폴백/상한 |
| 8 | `CaptureJob`: `lastFrameByPreset` + `floorReviewer` 주입 + `checkpoint()` 호출 | vitest — fake timers 라운드 진행 시 체크포인트에서 review 호출, 미주입 시 기존 동작 |
| 9 | `Finalizer`: `getFloorRois`→`assemble` 가산 | vitest §7 — artifact slot 에 floorRoiByPreset, 없을 때 부재 |
| 10 | 뷰어: `core.js toPixelQuad`/`analyzeArtifact`/`core.d.ts`/`app.js`/`index.html` | vitest §9(core) + 수동 동작확인(오버레이 폴리곤) |
| 11 | 전체 회귀 | `npm test`(SettingAgent) — 신규 통과 + 기존 248 회귀 0; `npm run build` 무에러 |

각 단계는 독립 커밋 가능. 1·11 사이 어느 단계든 typecheck+vitest 그린 유지.

---

## 11. 영향도 사전분석

| 대상 | 영향 | 비고 |
|------|------|------|
| `@parkagent/types` | **가산만**(새 타입 + 옵셔널 필드). 패키지 빌드·재수출 필요 | 단계1에서 빌드. 기존 필드 불변 |
| ActionAgent / DMAgent | **런타임 무영향**. `floorRoiByPreset?` 옵셔널 → 기존 코드 미참조, 소비 안 함 | 타입 인지만(빌드 시 노출). 계약 가산이라 깨짐 없음 |
| 단발 셋업(`SetupOrchestrator`/`RoiBuilder`) | **무영향**. 호출 코드 미추가 | §7 — 범위 외 |
| 기존 capture 경로(`Aggregator`/`CheckpointReviewer`/`replaceAggregatedSlots`) | **무영향**. floor 는 별 테이블·별 reviewer | 집계 멱등 보존 |
| `llm.config`/`tools.config` | floorRoi 옵셔널(미설정=비활성) | 기존 설정 파일 무수정 시 동작 동일 |
| 뷰어 | 가산 토글·오버레이. floor 없는 artifact 도 정상(옵셔널) | 기존 ROI/plate 표시 불변 |
| 기존 248 vitest | **회귀 0 목표** | 모든 신규는 가산·옵셔널 |

---

## 12. MCP 도구 vs LLM 두뇌 경계 판단

- **LLM 두뇌(맥락 판단)**: floor 4점 추론 = 이미지에서 원근·차체높이를 보고 접지면을 가늠하는 **모호·맥락 판단** → LLM(gemma 비전) 적합. `recognizeFloorRoi`.
- **결정형 도구**: 좌표 클램프·순서 정규화·폴백 사변형 = **수치·규칙** → 순수 함수(`floorRoi.ts`). 실시간 반복 루프 아님(체크포인트 K라운드 1회)이라 고빈도 결정형 도구는 불필요.
- 경계 일치: 좌표 "생성"은 LLM, "검증·강등·폴백"은 결정형 — 기존 두뇌 규약(LLM 은 판단, 폴백은 결정형)과 정합.

---

## 13. 리스크 / 가정

**리스크**
1. **gemma 12B 좌표 정확도 한계**: 사변형이 부정확하거나 순서 뒤섞일 수 있음 → `normalizeQuad`(순서 강제·클램프) + 폴백 필수(이미 설계). confidence 낮으면(임계 미만) 폴백 사용도 옵션(1차는 단순화 — 유효하면 채택).
2. **프리셋별 프레임 메모리**: `lastFrameByPreset` 이 프리셋 수만큼 JPEG 보관 → 수 MB. run 종료/시작 시 clear. 프리셋 수백 개면 재검토(현재 규모 아님).
3. **토큰·시간 비용**: 체크포인트마다 슬롯당 멀티모달 호출 → `maxPerCheckpoint` 상한으로 제한. 폴백이 항상 있어 누락 무해.
4. **좌표계 일관성**: floor quad 는 `roiByPreset` 과 **같은 정규화 0~1·같은 프레임**(프리셋 이미지) 기준이어야 뷰어 폴리곤이 맞음. `lastFrameByPreset`(집계와 동일 프리셋 프레임) 사용으로 보장. 다른 카메라/프리셋 프레임 혼용 금지.
5. **순서 규약 오해**: 뷰어·프롬프트·`normalizeQuad` 가 같은 규약(`[앞왼,앞오,뒤오,뒤왼]`)을 공유해야 함 — 주석으로 명시·테스트로 고정.

**가정(불확실 시 리더에 질문)**
- (A) floor quad 의 "대상 차량 bbox" = 집계 대표 `AggregatedSlot{x,y,w,h}`(클러스터 중앙값). LLM 에 이 1개 차량 bbox + 프리셋 프레임 전체를 주고 그 차량의 접지면을 묻는다. → 타당하다고 보고 진행.
- (B) `maxPerCheckpoint` 기본 12, floorRoi.enabled 기본 false(config 에서 true). → 보수적 기본값으로 진행.
- (C) confidence 임계 기반 폴백 선택은 1차 미적용(유효 quad 면 채택). 필요 시 후속.

위 (A)~(C) 중 마스터 의도와 다른 부분이 있으면 구현 착수 전 알려주시기 바랍니다.

---

## 14. 영향 받는 파일/모듈 (구현자·문서화 전달)

**신규**
- `packages/types/src/index.ts` (가산: NormalizedQuad/NormalizedPoint/floorRoiByPreset)
- `SettingAgent/src/capture/floorRoi.ts` (순수: 폴백·정규화·resolve)
- `SettingAgent/src/capture/FloorRoiReviewer.ts`
- `SettingAgent/config/prompts/floor_roi.system.md`, `floor_roi.user.md`

**수정(가산)**
- `SettingAgent/src/brain/SetupBrain.ts` (FloorRoiInput/Result/recognizeFloorRoi?)
- `SettingAgent/src/brain/AgentRuntime.ts` (recognizeFloorRoi 구현)
- `SettingAgent/src/config/llmConfig.ts` + `SettingAgent/config/llm.config.json` (floorRoi 블록)
- `SettingAgent/src/capture/SqliteStore.ts` (floor_roi 테이블 + upsert/get)
- `SettingAgent/src/capture/CaptureJob.ts` (lastFrameByPreset + floorReviewer)
- `SettingAgent/src/capture/Finalizer.ts` (getFloorRois→assemble)
- `SettingAgent/src/domain/types.ts` (재수출에 NormalizedQuad 추가)
- `SettingAgent/web/core.js` + `core.d.ts` (toPixelQuad/analyzeArtifact)
- `SettingAgent/web/app.js` + `web/index.html` (roi-floor 토글·폴리곤)
- DI 조립 지점(서버 빌더, `src/api/server.ts` 등): FloorRoiReviewer 생성·주입 1곳

**무수정(영향만 인지)**: ActionAgent/DMAgent, SetupOrchestrator/RoiBuilder, Aggregator, CheckpointReviewer.
