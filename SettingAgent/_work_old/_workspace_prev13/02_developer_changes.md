# 02 · 구현 변경 노트 — 주차면 점유영역(floor ROI) 번호판 기준 재정의

구현자(developer) / 대상: SettingAgent / 근거: `01_architect_plan.md`(해석 B 확정) + 리더 게이트 확정.

게이트 확정 반영: 해석 B(LLM floor 호출 유지 + 프롬프트 전면 재작성), 출력 키 `polygon` 유지 + `.length(4)`,
상수 초기값 `FLOOR_WIDTH_RATIO=1.0 / FLOOR_DEPTH_RATIO=0.55 / PLATE_FRONT_RATIO=0.42 / PLATE_CONTAIN_MARGIN=0.15`.

---

## 1. 변경 파일별 요지

### 1) `src/domain/geometry.ts` (추가만, 기존 함수 무변경)
- **신규** `plateAngleRad(quad: NormalizedQuad): number` — 번호판 OBB 상단변(TL→TR)·하단변(BL→BR) **평균 방향**의 `atan2`. 점순서 뒤바뀜·노이즈에 강건. 퇴화(평균벡터 |·|<1e-9, 예: 면적0)면 `0`.
- **신규** `projectedSpan(pts, ax, ay): number` — 점들을 단위축 (ax,ay)에 투영한 span(max−min). 로컬 OBB 크기 산출용(빈 배열 0).
- import 에 `NormalizedPoint` 추가.

### 2) `src/capture/floorRoi.ts` (핵심)
- **상수 재정리(파일 상단 4종, QA/육안 후 미세조정 지점)**:
  `FLOOR_WIDTH_RATIO=1.0`, `FLOOR_DEPTH_RATIO=0.55`, `PLATE_FRONT_RATIO=0.42`, `PLATE_CONTAIN_MARGIN=0.15`.
- **제거된 상수(사용처 소멸 → 정리)**: `FALLBACK_BAND`, `FALLBACK_FRONT_INSET`, `FALLBACK_REAR_INSET`(구 `fallbackPolygon` 사다리꼴 전용). `POLY_MARGIN`/`PLATE_*`(predictPlateRect·normalizePolygon 경로)은 여전히 사용 → 유지.
- **`fallbackPolygon` → `buildPlateAnchoredQuad(vehicle, plateQuad?, depthFloor?)` 로 교체**. 알고리즘(계획 §2-3):
  1. `θ = plateQuad ? plateAngleRad(plateQuad) : 0`, `plate = plateQuad ?? rectToQuad(predictPlateRect(vehicle))`.
  2. 로컬축 `nb=(sinθ,−cosθ)`(앞→뒤), 앞(−nb)=이미지 하단 되도록 `nb.y>0`이면 부호 반전(near-vertical·점순서 뒤바뀜 방어). `u=(−nb.y, nb.x)`(nb 직교 좌우축).
  3. `wp/hp`=plate 를 u/nb 에 투영한 span, `pc`=plate 4점 평균.
  4. `W=max(vehicle.w·1.0, wp·1.15)`, `D=max(vehicle.h·0.55, hp·1.15, depthFloor)`.
  5. `Cq = pc + nb·(D·(0.5−0.42))` — 좌우는 번호판중심 유지(좌우중앙), 세로만 이동해 번호판을 앞(아래)쪽에.
  6. 4모서리 [FL,FR,RR,RL] 산출 → `clamp01` → `orderConvexCanonical` 재적용 → `NormalizedQuad`(정확히 4점) 반환.
- **`resolveFloorPolygon(llmPoly, vehicle, plateQuad?, plateRect?)`** 로 시그니처 확장·내부 재구성:
  - 빌더가 각도·좌우중앙·세로약간앞·크기하한 **권위**.
  - LLM 사변형은 `normalizePolygon` 통과 시 그 nb축 span 을 **깊이 D 하한(depthFloor)으로만 보조**(각도·배치 미반영).
  - 최종 안전망 `expandPolygonToContainRect(base, plateRect ?? quadBoundingRect(plateQuad) ?? predictPlateRect(vehicle))` 유지(멱등, 정상 경로 no-op).
- `predictPlateRect`, `normalizePolygon`, `expandPolygonToContainRect`, `deconflictPolygons`, `applyMargin`, `orderConvexCanonical`, `simplifyToMax` **무변경**.
- import 에 `NormalizedQuad`, geometry 의 `rectToQuad/quadBoundingRect/plateAngleRad/projectedSpan` 추가.

### 3) `src/capture/FloorRoiReviewer.ts` (호출부만)
- `plateQuad = s.plateQuad ?? undefined` 도출.
- `recognizeFloorRoi` 입력에 `...(plateQuad ? { plateQuad } : {})` 주입(plate rect 와 병행).
- `resolveFloorPolygon(polyRaw, vehicle, plateQuad, plate)` 로 4-arg 호출.

### 4) `src/capture/Finalizer.ts` (호출부만)
- import `fallbackPolygon` → `buildPlateAnchoredQuad`.
- fallback base: `floorByRef.get(...) ?? buildPlateAnchoredQuad(rect, m.plateQuad ?? undefined)`.
- `plateRect`(집계 rect) 변수는 deconflict·plateRoiByPreset 경로에서 계속 사용 → 유지.

### 5) `src/brain/SetupBrain.ts` (인터페이스·스키마)
- `FloorRoiInput` 에 `plateQuad?: NormalizedQuad` 필드 추가.
- `FloorRoiResultSchema.polygon`: `.min(4).max(10)` → **`.length(4)`**(4점 특수화). 키 `polygon` 유지.
- import 에 `NormalizedQuad` 추가, 인터페이스 주석 1줄(가변 다각형→4점 회전 사변형) 갱신.

### 6) `src/brain/AgentRuntime.ts` (내부만)
- `recognizeFloorRoi` 의 `renderTemplate` vars 에 `plateQuad: input.plateQuad ? JSON.stringify(...) : '(없음)'` 주입.

### 7) `config/prompts/floor_roi.yaml` (전면 재작성)
- 구 흰선/바퀴접지/사다리꼴·출력키 `quad` 폐기.
- 신규: 번호판 기준 규칙 1~6(내부포함·하단변평행·각도추종·좌우중앙·세로약간앞·번호판>bbox), 좌표규약 [앞왼,앞오,뒤오,뒤왼] 정규화 0~1, 출력 `{"polygon":[{x,y}×4],"confidence"}` **정확히 4점**·코드펜스 금지.
- user 템플릿에 `{{plateQuad}}`(TL,TR,BR,BL 각도 단서) 추가.
- 참고: 구 yaml 은 출력키를 `quad` 로 안내했으나 `FloorRoiResultSchema` 는 `polygon` 을 파싱 — 잠재 불일치였음. 재작성으로 `polygon` 통일(정합 회복).

### 8) `web/*`, `@parkagent/types` — **무변경**(계획 §3 항목8·9). 회귀만 확인(전 테스트 그린).

---

## 2. 신규/변경 함수 시그니처

```
+ plateAngleRad(quad: NormalizedQuad): number                                   // geometry.ts
+ projectedSpan(pts: readonly NormalizedPoint[], ax: number, ay: number): number // geometry.ts
- fallbackPolygon(vehicle, plate?: NormalizedRect): NormalizedPolygon            // 삭제
+ buildPlateAnchoredQuad(vehicle: NormalizedRect,
+     plateQuad?: NormalizedQuad, depthFloor?: number): NormalizedQuad           // floorRoi.ts 신규
~ resolveFloorPolygon(llmPoly, vehicle, plateQuad?, plateRect?): NormalizedPolygon
~ FloorRoiInput { ..., plateQuad?: NormalizedQuad }                             // SetupBrain.ts
~ FloorRoiResultSchema.polygon: z.array(...).length(4)
```

## 3. 상수(초기값, floorRoi.ts 상단 집중)
| 상수 | 값 | 의미 |
|---|---|---|
| `FLOOR_WIDTH_RATIO` | 1.0 | 좌우폭 하한 = bbox.w × 비율 |
| `FLOOR_DEPTH_RATIO` | 0.55 | 앞뒤깊이 하한 = bbox.h × 비율 |
| `PLATE_FRONT_RATIO` | 0.42 | 앞변→번호판중심 비율(<0.5=앞/아래) |
| `PLATE_CONTAIN_MARGIN` | 0.15 | 번호판 포함 여유(W·D 하한 보정) |

---

## 4. 계획 대비 편차(사유)

- **`buildPlateAnchoredQuad` 에 3번째 인자 `depthFloor?: number` 추가** (계획 표기 시그니처는 `(vehicle, plateQuad?)`).
  - 사유: 해석 B의 "LLM 사변형 = 깊이 D 하한 보조"를 구현하려면 D 계산 시점에 하한값을 주입해야 함. `resolveFloorPolygon` 이 LLM nb축 span 을 계산해 이 인자로 전달한다. 옵셔널·기본 무시(빌더 단독 호출 시 영향 0)라 외과적. 계획 의도("빌더 권위+LLM 깊이 보조")에 부합.
- 그 외 파일·시그니처·상수·프롬프트는 계획·게이트대로.

## 5. 데드코드/관찰 (삭제하지 않음, 언급만)
- `floorRoi.ts` 파일 헤더 주석의 "가변 다각형 4~10점" 표현은 저장 타입 관점에선 유효(생성기는 4점). 오해 소지 있으나 계약 서술이라 유지.
- 위 §1-7 의 구 yaml `quad` 키 vs 스키마 `polygon` 불일치는 이번 재작성으로 해소됨(기존 잠재 결함).

---

## 6. 검증 결과

- **타입체크**: `npx tsc -p tsconfig.json --noEmit` → **EXIT 0**(무오류). tsconfig 는 `src`+`test` 포함.
- **전체 유닛테스트**: `npx vitest run` → **69 파일 / 592 테스트 전부 통과**. `promptsYaml.test.ts`(재작성 yaml 검증) 포함.
- 시그니처 변경에 따른 테스트 호출부 갱신(컴파일·기존 불변식 유지 목적, QA가 §6 신규 불변식 확장 예정):
  - `test/floorRoi.test.ts` — `fallbackPolygon`→`buildPlateAnchoredQuad`(describe/호출), plate 인자를 `rectToQuad(plate)` 로, `resolveFloorPolygon` plate 를 4번째 인자로.
  - `test/floorRoiReviewer.test.ts`, `test/finalizerFloor.test.ts` — 폴백 비교값 `fallbackPolygon`→`buildPlateAnchoredQuad`.
  - `test/floorRoiNormalizeEdge.test.ts` — `resolveFloorPolygon(raw, vehicle, plate)` → `(raw, vehicle, undefined, plate)`(plate=포함강제 안전망).

## 7. QA가 알아야 할 검증 포인트 (계획 §6 불변식 대응)

1. **정점 수**: `buildPlateAnchoredQuad` 는 항상 **정확히 4점**(deconflict 전). `.length(4)` 스키마와 정합.
2. **각도 산출**: `plateAngleRad` — 축정렬 quad→0, 회전 quad→기대각(±ε), 퇴화(면적0)→0. (신규 유닛테스트 권장)
3. **하단변 평행/각도추종(rule 2·3)**: 기운 plateQuad 입력 시 앞변 `FL→FR` 각도가 `plateAngleRad(plateQuad)` 를 추종(부호 일치, ≤3° 권장 허용오차). `nb.y>0` 부호정규화로 앞=하단 보장.
4. **좌우중앙(rule 4)**: plate 중심 u축 투영 ≈ 사변형 u축 중심(빌더가 좌우 이동 안 함 → 경계 clamp 없을 때 정확 일치).
5. **세로 약간앞(rule 5)**: plate 중심의 nb 위치가 앞변에서 ~0.42D → `frontDist < backDist`.
6. **번호판 포함(rule 1)**: plateQuad(또는 boundingRect) 4모서리가 사변형 내부. 안전망 `expandPolygonToContainRect` 멱등(정상 경로 no-op, 참조 동일).
7. **경계 케이스**: 범위초과 vehicle/plate → clamp 후에도 4점·0~1·포함. near-vertical plate(θ≈±90°) 부호정규화.
8. **깊이 보조**: LLM 사변형 nb-span 이 bbox 유도 D 보다 크면 D 확장(depthFloor). 작으면 무영향.
9. **회귀**: `deconflictPolygons`(4점→5~6점 가능, 저장 타입 가변 유지) · Reviewer · Finalizer 기존 계약 그린(확인됨).
10. **동작확인(육안)**: 실 캡처 1런 → 뷰어에서 녹색 사변형이 번호판에 각도·좌우중앙·앞쪽치우침 렌더(참조 `etc/주차면점유영역_0{1,2,3}.jpg` 대조).
