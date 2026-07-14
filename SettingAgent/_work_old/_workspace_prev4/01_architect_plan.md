# 01 설계서 — 차량 바닥 점유영역(floor ROI · 4점 사변형) 생성 개선

작성: 설계자(architect) / 근거: CLAUDE.md 규칙1(설계필수)·규칙2(단순함). 확정 요구 R1~R4.

## 0. 목표 요약
- R1: 참조 이미지처럼 "차량 바닥 발자국 사다리꼴". 프롬프트는 최소 보강(R4 규약).
- R2: no-op 제거. 후보마다 LLM 항상 시도 → 실패/무효/비활성이면 폴백으로 **항상 생성**. LLM 동작불가 시 **UI 경고 + logger.warn**.
- R3: 폴백을 얕은 띠(35%) → 깊은 발자국(앞넓·뒤좁 강한 원근)으로 개선.
- R4: 최종 quad 는 LPD 번호판 bbox 를 **무조건 포함**(LLM·폴백 공통).

저장 계약(`floorRoiByPreset: z.record(NormalizedQuadSchema)`)·NormalizedQuad shape·globalIndex·ActionAgent/DMAgent **불변**. 좌표 순서 규약 [앞왼,앞오,뒤오,뒤왼] 유지.

---

## 1. 파일·함수별 수정 지점

### 1.1 `src/capture/floorRoi.ts` (순수 모듈 — 유닛테스트 핵심)
상수 재조정 + 신규 순수 함수 2개 + `resolveFloorQuad` 시그니처 확장.

```ts
// (변경) 폴백 발자국 비율 — §2 근거
const FALLBACK_BAND = 0.55;   // 0.35 → 0.55 (차 길이만큼 깊게)
const FALLBACK_FRONT_INSET = 0.04; // 앞변(하단) 좌우 살짝만
const FALLBACK_REAR_INSET  = 0.22; // 뒤변(상단) 강하게 좁힘(원근)

export function fallbackQuadFromRect(r: NormalizedRect): NormalizedQuad
// (신규) rect 4모서리를 모두 포함하도록 quad 최소 확장
export function expandQuadToContainRect(quad: NormalizedQuad, rect: NormalizedRect): NormalizedQuad
// (변경) plate? 옵셔널 파라미터 추가
export function resolveFloorQuad(
  llmQuad: Array<{x:number;y:number}> | null | undefined,
  vehicle: NormalizedRect,
  plate?: NormalizedRect,
): NormalizedQuad
```
`normalizeQuad` / `clamp01` 은 **불변**(회귀 테스트로 고정).

### 1.2 `src/capture/FloorRoiReviewer.ts`
- 36줄 no-op(`if(!brain?.enabled||!brain.recognizeFloorRoi) return;`) **삭제**.
- 후보 루프는 brain 무관하게 진행. `recognizeFloorRoi` 는 호출측에서 존재/활성 판단 없이 시도하되, 메서드 부재/비활성이면 내부적으로 null → 폴백.
- `review(...)` 반환형 `void` → `Promise<{ llmUnavailable: boolean }>`. LLM 동작불가(=brain 없음 · `brain.enabled===false` · `recognizeFloorRoi` 메서드 부재) 최초 감지 시 `logger.warn` 1회 + 플래그 true.
- `resolveFloorQuad(quadRaw, vehicle, plate)` 로 plate 전달(R4).

### 1.3 `src/capture/CaptureJob.ts`
- 283줄: `await this.deps.floorReviewer.review(...)` 결과 수신 → `llmUnavailable` 이면 `this.latestAdvisory` 앞에 경고 라인 1개 prepend(중복 방지 가드).
- 경고 문자열 상수(예: `⚠ LLM 비활성: 바닥영역을 자동추정(폴백)으로 생성 중입니다. 결과를 검토하세요.`).

### 1.4 `config/prompts/floor_roi.yaml`
- system "강한 단서"/"제외할 것" 사이 또는 user 말미에 번호판 포함 규약 1~2줄 추가(§6).

### 1.5 UI: `web/core.js` `mapAdvisory` (불변) / `web/app.js` `renderCaptureStatus`
- `latestAdvisory` 에 경고가 실려오므로 `mapAdvisory` 는 그대로 표시. 단 경고 라인은 눈에 띄게: app.js 에서 라인 텍스트가 경고 접두(`⚠`)로 시작하면 `adv-line` 에 `adv-warn` 클래스 추가(빨강/굵게). CSS 1블록.
- 별도 모달 대신 기존 `cap-advisory` 배너에 강조 표시(최소 침습). (모달까지 원하면 옵션이나, 과설계 지양 — §7 미해결에 명시)

**변경 없음(확인):** `src/capture/types.ts`(latestAdvisory 이미 존재), `web/core.d.ts`, `@parkagent/types` NormalizedQuad, SqliteStore.upsertFloorRoi, `src/index.ts` 주입부.

---

## 2. 개선 폴백 기하 (R3) — 수식 + 비율 근거

입력 rect = {x,y,w,h}(정규화). bbox 는 차량 **전체**(지붕 포함)라 하단 일부만이 접지면. 발자국은 하단부터 차 길이만큼.

```
left       = x
right      = x + w
bottomY    = clamp01(y + h)                    // 앞변(카메라 근접, 이미지 하단)
topY       = clamp01(y + h*(1 - BAND))         // 뒤변(먼 쪽)
frontInset = w * FRONT_INSET
rearInset  = w * REAR_INSET
frontL = (left  + frontInset,  bottomY)
frontR = (right - frontInset,  bottomY)
rearR  = (right - rearInset,   topY)
rearL  = (left  + rearInset,   topY)
→ [frontL, frontR, rearR, rearL]  (각 x,y clamp01)
```

비율 근거:
- **BAND 0.55**(기존 0.35): 승용차 측면·사입 뷰에서 bbox 높이 대비 접지 발자국 세로 점유는 하단 약 절반~2/3. 0.35 는 "얇은 띠"라 R3 지적. 0.55 로 차 길이감 확보하되, 1.0 은 지붕까지 덮어 과대 → 0.55 채택(보수적 중앙값).
- **FRONT_INSET 0.04 / REAR_INSET 0.22**: 앞(근접)은 넓고 뒤(원거리)는 좁은 사다리꼴. 뒤변을 폭의 22% 씩(양변 합 44%) 좁혀 뚜렷한 원근. 앞변은 4%만 살짝 정리(bbox 좌우 여백 흡수). 값은 접지 사다리꼴의 앞:뒤 폭비 약 1 : 0.56 을 목표로 역산(1 - 2·0.22 = 0.56).
- 결과: 얕은 대칭 띠 → 깊고 앞넓뒤좁 사다리꼴. **여전히 bbox 유도 순수기하**(외부의존 0).

---

## 3. `expandQuadToContainRect(quad, rect)` — 알고리즘 (R4)

목적: rect(번호판 bbox) 4모서리가 quad 내부에 오도록 **최소 확장**. quad 는 [앞왼,앞오,뒤오,뒤왼]=[FL,FR,RR,RL].

전제(순서 정규화 보장): 앞변 y(FL.y,FR.y) ≥ 뒤변 y(RL.y,RR.y). x 는 FL≤FR, RL≤RR.

```
rl = rect.x            (left)
rr = rect.x + rect.w   (right)
rt = rect.y            (top)
rb = rect.y + rect.h   (bottom)

// 세로: 앞변(하단)은 번호판 하단보다 아래로, 뒤변(상단)은 번호판 상단보다 위로
FL.y = FR.y = clamp01(max(FL.y, FR.y, rb))   // 앞변을 rb 아래까지 확장
RL.y = RR.y = clamp01(min(RL.y, RR.y, rt))   // 뒤변을 rt 위까지 확장

// 가로: 좌측 정점 x 는 rl 이하, 우측 정점 x 는 rr 이상(앞·뒤 각각)
FL.x = clamp01(min(FL.x, rl));  RL.x = clamp01(min(RL.x, rl))
FR.x = clamp01(max(FR.x, rr));  RR.x = clamp01(max(RR.x, rr))

return [FL, FR, RR, RL]
```

핵심: `min`/`max` 만 쓰므로 **rect 가 이미 quad 안이면 아무 변화 없음**(멱등). 확장만, 축소 없음.

엣지케이스:
- plate=undefined → 호출 안 함(§4 resolveFloorQuad 가드).
- rect 가 quad 밖 좌하단에 크게 걸침 → FL.x/FL.y 동시 확장, clamp01 로 프레임 안.
- 앞변을 rb 로 내렸는데 이미 1.0 이면 clamp 유지(더 못 내려도 사각형 유효).
- **주의**: 앞변 y 를 두 정점 공통값으로 세팅(평행 유지). 뒤변도 동일. → 사다리꼴 형태 보존. (개별 정점만 밀면 뒤틀림 발생하므로 변 단위로 통일.)
- normalizeQuad 순서 규약과 정합: 반환 배열 순서 [FL,FR,RR,RL] 그대로 유지.

---

## 4. `resolveFloorQuad` 확장 — plate 포함 강제 (R4)

```ts
export function resolveFloorQuad(llmQuad, vehicle, plate?) {
  const base = normalizeQuad(llmQuad) ?? fallbackQuadFromRect(vehicle);
  return plate ? expandQuadToContainRect(base, plate) : base;
}
```
- LLM quad·폴백 quad **공통 경로**로 plate 포함 강제(R4 "공통").
- plate 없으면 base 그대로(기존 동작 유지 — 회귀 안전).

---

## 5. FloorRoiReviewer no-op 제거·강제시도·경고신호 흐름 (R2)

```
review(runId, slots, framesByPreset): Promise<{ llmUnavailable }>
  llmUnavailable = false
  llmUsable = !!(brain?.enabled && brain.recognizeFloorRoi)   // 동작 가능 여부
  if (!llmUsable) { llmUnavailable = true; logger.warn({...}, 'floor ROI: LLM 비활성 — 폴백 생성') }
  candidates = slots.filter(status != rejected && != merged)
  for s of candidates (maxPerCheckpoint 상한):
    jpeg = framesByPreset.get(s.presetKey); if !jpeg continue
    vehicle = {x,y,w,h}; plate = (plateX..!=null) ? {..} : undefined
    quadRaw = null
    if (llmUsable):
      try quadRaw = (await brain.recognizeFloorRoi({...vehicle, plate?, ...}))?.quad ?? null
      catch: logger.warn('추론 실패(폴백)')   // 개별 실패는 llmUnavailable 로 승격 안 함
    quad = resolveFloorQuad(quadRaw, vehicle, plate)   // 항상 생성 + plate 포함
    store.upsertFloorRoi(runId, presetKey, clusterId, quad, now())
  return { llmUnavailable }
```

판단 경계(MCP 규칙): floor ROI **좌표 생성**은 원근·맥락 판단 → LLM 두뇌(recognizeFloorRoi) 담당. **검증·클램프·폴백·plate 포함 강제**는 결정형 순수모듈(floorRoi.ts). 경계 불변, 개선은 결정형 측에 집중.

CaptureJob(283줄):
```ts
const r = await this.deps.floorReviewer.review(this.runId, slots, this.lastFrameByPreset);
if (r.llmUnavailable) {
  const warn = FLOOR_LLM_WARN; // 상수
  if (!this.latestAdvisory.includes(warn)) this.latestAdvisory = [warn, ...this.latestAdvisory];
}
```
- `latestAdvisory` 는 이미 status 로 나가고(115줄) UI 가 표시 → 별도 배관 불필요(최소 침습).

---

## 6. 프롬프트 보강 문구 (R1·R4) — `config/prompts/floor_roi.yaml`

system "제외할 것" 블록 아래 또는 "좌표·순서 규약" 위에 삽입:
```
번호판 포함 규약(엄수):
- 번호판 bbox 가 주어지면, 네가 찍는 바닥 사변형은 그 번호판 bbox 네 모서리를 모두 감싸야 한다(번호판이 사변형 밖으로 나가면 안 됨).
- 단, 번호판 높이만큼 위로 억지로 늘리지 말고 바닥 발자국을 자연스럽게 그 지점까지 확장하라.
```
과설계 금지: 2줄만. 기존 원근/발자국 규약은 유지.

---

## 7. 검증 유닛테스트 케이스 (qa-tester 전달)

### 7.1 `test/floorRoi.test.ts` (순수 — 신규/보강)
1. **폴백 발자국 형태**: `fallbackQuadFromRect({x:0.3,y:0.1,w:0.4,h:0.4})` →
   - 앞변 y(FL.y=FR.y) === clamp01(0.5), 뒤변 y === clamp01(0.1+0.4*0.45)=0.28.
   - 앞변폭(FR.x-FL.x) > 뒤변폭(RR.x-RL.x) (앞넓뒤좁).
   - 뒤변 좌우 inset === w*0.22 반영. 순서 [FL,FR,RR,RL].
2. **expand — 각 방향 확장**:
   - plate 가 quad 아래(rb>앞변y) → 앞변 y 가 rb 로 내려감.
   - plate 가 quad 위(rt<뒤변y) → 뒤변 y 가 rt 로 올라감.
   - plate 좌측 튀어나감(rl<좌정점x) → FL.x·RL.x = rl.
   - plate 우측 튀어나감(rr>우정점x) → FR.x·RR.x = rr.
3. **이미 포함 시 불변(멱등)**: plate 가 quad 내부 → `expandQuadToContainRect(q,plate)` deep-equal q.
4. **clamp**: plate.right=1.2 등 범위초과 → 결과 모든 x,y ∈ [0,1].
5. **resolveFloorQuad + plate**: LLM quad 가 plate 미포함 → 반환 quad 가 plate 4모서리 포함(경계 부등식 검증). plate=undefined → base 와 동일.
6. **normalizeQuad 회귀(불변)**: 기존 케이스(점≠4→null, NaN→null, 순서 뒤섞인 4점→[FL,FR,RR,RL]) 그대로 통과.

### 7.2 `test/floorRoiReviewer.test.ts` (보강 — no-op 폐기 반영)
7. **brain 비활성 → 폴백 생성 + 경고**: `fakeBrain({enabled:false})` 로 review → upsertFloorRoi **호출됨**(기존 no-op 기대 71~76줄 **수정**), 반환 `{llmUnavailable:true}`.
8. **recognizeFloorRoi 메서드 부재 → 폴백 + 경고**: `hasMethod:false` → upsert 호출, `llmUnavailable:true` (79~85줄 수정).
9. **LLM throw → 폴백, but llmUnavailable:false**: 개별 실패는 비활성 아님 → 폴백 quad 저장, `{llmUnavailable:false}`.
10. **정상 LLM → plate 포함**: slot 에 plate 지정 + goodResult(plate 미포함 quad) → 저장 quad 가 plate 포함.
11. **maxPerCheckpoint 상한**: 유지(회귀).

### 7.3 CaptureJob (경량)
12. floorReviewer.review 가 `{llmUnavailable:true}` 반환 시 status.latestAdvisory 에 경고 라인 포함, 중복 호출에도 1개만.

**성공 기준**: `npm test` (vitest) 전 케이스 green. 기존 slotPtzWriter/captureJob 등 회귀 통과.

---

## 8. 영향도 분석

| 대상 | 영향 | 확인 |
|------|------|------|
| 저장 계약 `floorRoiByPreset` | shape 불변(여전히 record<NormalizedQuad>) | ✅ 값 내용만 개선 |
| NormalizedQuad / @parkagent/types | 타입 불변 | ✅ |
| globalIndex 매핑·slot box map | quad 값만 변경, 키·구조 불변 | ✅ |
| ActionAgent / DMAgent | floor ROI 소비측 — shape 동일 → 무영향 | ✅ |
| `review` 반환형 void→객체 | 호출부는 CaptureJob 1곳뿐 | ✅ 동시 수정 |
| UI advisory | 라인 추가만(배너 재사용) | ✅ |
| CaptureStatus | latestAdvisory 기존 필드 재사용 → 스키마 무변경 | ✅ |

---

## 9. 미해결 / 가정
- **가정(BAND/INSET 값)**: 0.55 / 0.04 / 0.22 는 뷰 각도 무관 보수적 근사. 특정 카메라 각도에서 과대/과소면 상수만 재튜닝(구조 불변). 실측 프레임으로 시각 검증 권장(동작확인 단계).
- **UI 경고 형태**: 배너 강조(`adv-warn`)로 설계. 마스터가 "메시지창(모달)"을 강히 원하면 별도 확인 필요 — 현재는 과설계 지양해 배너 채택. → **리더 확인 요청 항목**.
- **개별 LLM 실패 vs 전면 비활성 구분**: 개별 throw 는 llmUnavailable 로 승격 안 함(폴백만). 전면 경고는 brain 비활성/메서드부재만. 이 구분이 요구와 맞는지 확인 권장.
