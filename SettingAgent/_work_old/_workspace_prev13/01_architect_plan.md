# 01 · 설계 계획 — 주차면 점유영역(floor ROI) 번호판(LPD) 기준 재정의

작성: 설계자(architect) / 대상: SettingAgent / 트리거: 사용자 요청(점유영역 규칙 전면 재정의)

---

## 0. 목표 한 줄 요약

기존 "가변 다각형(4~10점) · 흰선/바퀴접지 기준 footprint" 를 폐기하고,
**번호판(plate OBB)의 각도·위치를 기준으로 구성한 4점 회전 사변형(OBB류)** 으로 점유영역을 재정의한다.
근거 = 참조 이미지 3장(녹색 사변형은 번호판 노란박스에 각도·중앙 정렬, 앞쪽으로 약간 치우침).

---

## 1. 근거 분석 결과 (읽은 코드 기준 확정 사실)

| 항목 | 현행 사실 | 시사점 |
|---|---|---|
| plate 데이터 형태 | LPD는 **OBB quad**(회전 4점). `PlateBox.quad:NormalizedQuad`, 집계엔 `AggregatedSlot.plateQuad:NormalizedQuad\|null` + rect(plateX/Y/W/H) 동시 보유 | **번호판 각도 추출 가능**(quad 하단변 벡터). 근거 확보 완료. |
| plate quad 순서 | `types.ts` 주석: ultralytics OBB **TL→TR→BR→BL** (`plateRoiByPreset` 규약). 구데이터(rect)는 `rectToQuad` 승격 | quad[0]=TL,[1]=TR,[2]=BR,[3]=BL 로 각도 산출 |
| floor 저장 타입 | `ParkingSlot.floorRoiByPreset?: Record<string, NormalizedPolygon>` (`NormalizedPolygon = NormalizedPoint[]`, 불변식 4~10점) | **4점 quad는 이 타입에 구조적 호환** → 저장/뷰어/공유타입 계약 **변경 불필요** |
| 뷰어 렌더 | `core.d.ts`: `floorRoiByPreset: Record<string, NormalizedPoint[]\|NormalizedQuad>`, `hitTestQuadVertex`/`moveQuadVertex`/`updateSlotFloorRoi` 모두 **가변 point 배열** 처리 | 4점이든 N점이든 렌더·편집 그대로 동작. **뷰어 변경 불필요** |
| 결정형 파이프 | `resolveFloorPolygon(llmPoly, vehicle, plate?)` → `normalizePolygon`(볼록껍질·마진) ∥ `fallbackPolygon` → `expandPolygonToContainRect`(plate 포함강제). 최종화 `deconflictPolygons`(반평면 클리핑 비겹침) | 포함강제·비겹침은 **볼록 4점에서도 성립**(반평면 클립은 볼록 유지, 점수만 증가 가능) |
| plate 전달 경로 | `FloorRoiReviewer`·`Finalizer` 모두 plate를 **rect로만** 전달(`plateQuad` 미전달) | **각도 사용하려면 plateQuad 배선 추가 필수** (핵심 변경점) |
| LLM 계약 | `FloorRoiInput{vehicle, plate?:NormalizedRect}` → 프롬프트 → `FloorRoiResult{polygon:4~10점, confidence}` | plate 각도 쓰려면 `FloorRoiInput`에 `plateQuad?` 추가 |

---

## 2. 핵심 설계 결정 (질문 항목별 답)

### 2-1. 좌표/데이터 모델 — **4점으로 특수화하되, 공유 타입은 유지**

- **결정**: 생성기(결정형·프롬프트)는 항상 **정확히 4점** 사변형을 산출한다.
  단, **저장 타입 `NormalizedPolygon`(4~10) 계약은 그대로 둔다.**
- **근거(CLAUDE.md §3 외과적·§2 단순함)**:
  - 4점 튜플은 `NormalizedPolygon`(가변 point 배열)에 구조적으로 할당 가능 → **@parkagent/types 무변경** = 3개 에이전트 계약 오염 0.
  - `deconflictPolygons`(finalization 비겹침 클립)는 4점을 5~6점으로 만들 수 있음 → **가변 저장 타입을 유지해야 안전**. 억지로 `NormalizedQuad`(4점 튜플) 저장으로 좁히면 비겹침 후 재정규화가 필요해져 코드가 늘어남 → 하지 않는다.
  - 뷰어/스토어/finalizer는 이미 가변 다각형 처리 → **파급 0**.
- **미치는 파급**: FloorRoiReviewer/AgentRuntime/저장 스키마/뷰어 렌더 **계약 시그니처 무변경**. 바뀌는 것은 "무엇을 채우는가"(생성 규칙)뿐.

### 2-2. 번호판 각도 추출 — 결정형, plateQuad 상·하단변 평균 방향

신규 순수함수(`domain/geometry.ts`):
```
plateAngleRad(quad: NormalizedQuad): number
  // quad = TL,TR,BR,BL
  top = quad[1] - quad[0]      // TL→TR
  bot = quad[2] - quad[3]      // BL→BR
  d   = normalize(top + bot)   // 상·하단변 평균(노이즈 완화)
  if |top+bot| ≈ 0 → return 0  // 퇴화 방어
  return atan2(d.y, d.x)       // 이미지 좌표 기준 하단변 기울기
```
- **rect(구데이터) plate**: `rectToQuad`로 승격되면 축정렬 → 상·하단변 수평 → **각도=0**(자연 폴백). 별도 분기 불필요.
- **plate 부재**: 각도=0 + `predictPlateRect(vehicle)`를 가상 번호판으로 사용(기존 함수 재사용). vehicle bbox는 축정렬이라 각도 참고값 없음 → 0이 타당.

### 2-3. 결정형 배치 규칙 — 신규 빌더 `buildPlateAnchoredQuad`

신규 순수함수(`capture/floorRoi.ts`, `fallbackPolygon` 대체·확장):
```
buildPlateAnchoredQuad(vehicle: NormalizedRect, plateQuad?: NormalizedQuad): NormalizedQuad
```
알고리즘(모두 결정형):
1. `θ = plateQuad ? plateAngleRad(plateQuad) : 0`
   `plate = plateQuad ?? rectToQuad(predictPlateRect(vehicle))`
2. 로컬 축: `u=(cosθ,sinθ)`(좌우, 하단변 방향), `nb=(sinθ,−cosθ)`(앞→뒤, 이미지 위쪽=카메라 반대).
3. 번호판 로컬 크기: plate 4점을 u·nb에 투영한 span → `wp`(좌우), `hp`(앞뒤). 중심 `Pc`=plate 4점 평균.
4. 사변형 크기(rule 6: bbox=크기 참고):
   - `W = max(vehicle.w * FLOOR_WIDTH_RATIO, wp*(1+PLATE_CONTAIN_MARGIN))`
   - `D = max(vehicle.h * FLOOR_DEPTH_RATIO, hp*(1+PLATE_CONTAIN_MARGIN))`
5. 사변형 중심(rule 4 좌우중앙·rule 5 세로 약간앞):
   - `Cq = Pc + nb * (D * (0.5 − PLATE_FRONT_RATIO))`  ← nb 방향으로만 평행이동(좌우좌표=Pc 유지 → 번호판 좌우중앙 보장)
6. 4모서리(순서 [FL,FR,RR,RL], 앞=−nb=이미지 하단):
   ```
   FL = Cq − (D/2)nb − (W/2)u
   FR = Cq − (D/2)nb + (W/2)u
   RR = Cq + (D/2)nb + (W/2)u
   RL = Cq + (D/2)nb − (W/2)u
   ```
7. 각 점 `clamp01`, 캐노니컬 정렬 재적용(감김/시작점 규약 유지).

**신규 상수(제안값, floorRoi.ts 상단)**:
| 상수 | 값 | 의미 |
|---|---|---|
| `FLOOR_WIDTH_RATIO` | `1.0` | bbox 폭 → 사변형 좌우폭(최소 하한) |
| `FLOOR_DEPTH_RATIO` | `0.55` | bbox 높이 → 사변형 앞뒤깊이(기존 FALLBACK_BAND 재사용값) |
| `PLATE_FRONT_RATIO` | `0.42` | 앞변에서 번호판중심까지 비율(<0.5 = 중앙보다 앞/아래). rule 5 |
| `PLATE_CONTAIN_MARGIN` | `0.15` | 번호판 포함 여유(W·D 하한 보정) |

> 값은 참조 이미지 눈대중 기준 제안. QA 검증 후 리더 판단으로 미세조정(파라미터 1곳 집중).

### 2-4. 포함강제·정규화·비겹침 — 유지, 안전망으로만

- **포함강제**: 빌더가 W·D를 번호판 span×(1+margin) 하한으로 잡아 **구성 단계에서 포함 보장** → 정상 경로에선 확장 불필요(4점 유지). 다만 이미지 경계 clamp로 변형될 수 있으므로 `expandPolygonToContainRect(quad, quadBoundingRect(plate))`를 **최종 안전망**으로 1회 호출(멱등, 대부분 no-op). 회전 사변형은 볼록이라 기존 함수 그대로 성립.
- **normalizePolygon**: LLM 경로 유지 시 그대로 사용(볼록껍질→4점 캐노니컬). 4점 특수화와 충돌 없음.
- **deconflictPolygons**: 무변경. 회전 볼록 4점에도 반평면 클립 성립(점수 4→5~6 가능, 저장 타입 가변이라 무해).

### 2-5. LLM vs 결정형 분담 — **결정형이 각도·배치의 권위, LLM은 보조(깊이)**

두 해석을 병기한다(CLAUDE.md §1). **기본 계획 = 해석 B**(프롬프트 재작성이 명시 요청됨).

- **해석 A (최소·권장 단순화, 리더 확인 필요)**: 신규 규칙 1~6은 `plateQuad + vehicle bbox`만으로 **완전 결정형** 구성 가능(이미지 픽셀 불요). → LLM floor 호출 제거, `floorRoi.enabled=false` 기본화, 프롬프트 폐기. 가장 단순·견고·테스트 용이. **대가**: 흰선 스냅 등 이미지 기반 판단 상실(단, 신규 규칙엔 흰선 개념이 없음).
- **해석 B (기본 계획)**: LLM은 이미지를 보고 **4점 회전 사변형**을 제안. 결정형은 각도(2-2)·좌우중앙·세로약간앞·포함(2-3/2-4)을 **강제**하고, LLM 사변형에서는 **깊이 D의 하한만 참고**(nb축 span이 bbox 유도값보다 크면 채택). 즉 각도·배치는 결정형 권위, LLM은 footprint 깊이 힌트.

> **리더에게 질문(미해결)**: 신규 규칙이 순수 기하라 LLM이 사실상 불필요하다. **해석 A로 갈지(LLM 제거) B로 갈지** 확정 요청. 아래 파일 목록·검증은 **B 기준**으로 작성하되, A 선택 시 "프롬프트 폐기 + Reviewer의 LLM 분기 제거"만 추가하면 된다(더 작은 변경).

### 2-6. 프롬프트 재작성 방향 (`config/prompts/floor_roi.yaml`, 전면 교체)

기존(흰선/바퀴접지/사다리꼴) **폐기**. 신규 골격:

- **system**:
  - 역할: "번호판(노란 박스)을 기준으로 차량이 점유한 바닥 사각영역(녹색 사변형) 4점을 찍는다."
  - 규칙 명시(참조 이미지 = 목표):
    1. 번호판이 사변형 **내부에 완전히 포함**.
    2. 번호판 **하단변 ∥ 사변형 앞(하단)변**.
    3. 번호판 **회전각과 같은 방향**으로 사변형을 기울인다.
    4. 번호판이 사변형 **좌우 중앙**.
    5. 번호판이 사변형 **세로에서 중앙보다 약간 앞(아래/카메라 쪽)**.
    6. 우선순위 **번호판 > 차량bbox**; bbox는 크기 참고.
  - 좌표규약: 정규화 0~1, 좌상단 원점, 순서 **[앞왼,앞오,뒤오,뒤왼]**(앞=이미지 하단, 시계방향).
  - 출력규약: JSON 1개만, 코드펜스 금지. 스키마 `{"quad":[{x,y}×4],"confidence":0~1}` — **정확히 4점**.
- **user 템플릿**: `camIdx/presetIdx`, `vehicle`(bbox), `plate`(rect), **신규 `plateQuad`(4점, 각도 단서)** 주입. "번호판 각도·중앙배치 규칙을 지켜 4점 사변형을 JSON으로만 답하라."
- **주의**: 출력 키를 기존 `polygon`(4~10) 대신 `quad`(정확히4)로 바꾸면 `FloorRoiResultSchema`·`recognizeFloorRoi` 파싱·기존 테스트(`agentRuntimeFloor.test.ts`)가 연동 변경됨 → **택1**:
  - (권장) 키 `polygon` 유지 + 스키마 `.length(4)`로 좁힘(호출측이 4점 전제). 변경 최소.
  - 또는 키 `quad` 신설(주석/테스트 동반 수정). 명확하나 변경 증가.
  → **기본: `polygon` 유지 + `.min(4).max(10)`→`.length(4)`** (surgical). 리더 반대 없으면 이대로.

---

## 3. 변경 파일 목록 (B 기준, 구현자 전달)

| # | 파일 | 변경 요지 | 시그니처 변경 |
|---|---|---|---|
| 1 | `src/domain/geometry.ts` | **신규** `plateAngleRad(quad)`; 로컬축 투영 헬퍼(`projectSpan`) 필요시 | 추가만(기존 무변경) |
| 2 | `src/capture/floorRoi.ts` | `fallbackPolygon` → **`buildPlateAnchoredQuad(vehicle, plateQuad?)`** 로 교체/추가; `resolveFloorPolygon` 시그니처에 `plateQuad?` 추가, 내부를 빌더 권위+LLM 깊이 보조로 재구성; 상수 4종 추가(기존 FALLBACK_*·PLATE_* 정리); 포함강제 안전망 유지 | **변경**: `resolveFloorPolygon(llmPoly, vehicle, plateQuad?, plateRect?)`, `fallbackPolygon`→`buildPlateAnchoredQuad` |
| 3 | `src/capture/FloorRoiReviewer.ts` | `s.plateQuad`를 `resolveFloorPolygon`·`recognizeFloorRoi`에 전달(plate rect와 병행) | 호출부만 |
| 4 | `src/capture/Finalizer.ts` | fallback 경로에 `m.plateQuad` 전달(`buildPlateAnchoredQuad(rect, m.plateQuad ?? undefined)`) | 호출부만 |
| 5 | `src/brain/SetupBrain.ts` | `FloorRoiInput`에 `plateQuad?: NormalizedQuad` 추가; `FloorRoiResultSchema` 키 유지·`.length(4)`로 좁힘(2-6 결정 따름) | 인터페이스 필드 추가 |
| 6 | `src/brain/AgentRuntime.ts` | `recognizeFloorRoi`가 `plateQuad`를 템플릿에 주입(`renderTemplate`에 `plateQuad` 키) | 내부만 |
| 7 | `config/prompts/floor_roi.yaml` | **전면 재작성**(2-6 골격) | 파일 내용 |
| 8 | (뷰어 `web/*`) | **무변경**(가변 다각형 렌더 그대로). 4점이라 편집 UX 오히려 단순 | — |
| 9 | (`@parkagent/types`) | **무변경**(2-1) | — |

### 함수 시그니처 변경 요약
```
+ plateAngleRad(quad: NormalizedQuad): number                         // geometry.ts 신규
- fallbackPolygon(vehicle, plate?)                                    // 삭제/개명
+ buildPlateAnchoredQuad(vehicle: NormalizedRect,
+                        plateQuad?: NormalizedQuad): NormalizedQuad   // floorRoi.ts 신규
~ resolveFloorPolygon(llmPoly, vehicle, plateQuad?, plateRect?)       // plateQuad 추가
~ FloorRoiInput { ..., plateQuad?: NormalizedQuad }                   // SetupBrain.ts
~ FloorRoiResultSchema.polygon: z.array(...).length(4)                // 4점 특수화
```

---

## 4. 하위호환 / 마이그레이션

- **기존 저장 floorRoi 데이터**(4~10점 볼록 다각형): 타입 `NormalizedPolygon` 유지 → **로드·렌더 그대로 유효**, 스키마 위반 없음. 강제 재계산 불요(다음 캡처/최종화 시 신규 규칙으로 자연 갱신).
- **구 plate rect 데이터**: `rectToQuad` 승격 경로 존재 → 각도=0으로 안전 동작(기존 로직).
- **DB/artifact 스키마**: 변경 없음(좌표 배열만). 마이그레이션 스크립트 불요.
- 즉, **파괴적 마이그레이션 없음** — 신규 산출물만 규칙이 바뀐다.

---

## 5. 리스크 / 주의

| 리스크 | 대응 |
|---|---|
| plate quad 점순서가 실제로 TL,TR,BR,BL 아닐 수 있음(모델 원순서) | `plateAngleRad`를 **상·하단변 평균**으로 산출(순서 뒤바뀜에 강건). 추가로 quad가 거의 축정렬이면 각도≈0으로 수렴 |
| 세로 near-vertical plate(θ≈±90°) → nb 부호 뒤집힘 | nb.y<0(카메라 반대) 되도록 부호 정규화; 퇴화 시 θ=0 폴백 |
| 경계 clamp로 사변형 찌그러짐 → 번호판 미포함 | `expandPolygonToContainRect` 안전망 유지(멱등) |
| `FloorRoiResultSchema` `.length(4)` 변경 → 기존 `agentRuntimeFloor.test.ts`(4점 반환)와 정합 | 해당 테스트는 이미 4점 반환 → 통과. 5~10점 케이스 테스트가 있으면 QA가 4점으로 갱신 |
| deconflict 후 5~6점 → "4점 특수화" 기대와 상충 | 저장 타입은 가변 유지(2-1). 4점은 **생성기 산출 기준**이며 비겹침 후 증가는 허용·문서화 |
| 해석 A/B 미확정 | §2-5 리더 질문으로 게이트. 미확정 시 B로 진행(가역적) |

---

## 6. 검증 기준 (QA가 작성할 불변식 · 성공 조건)

`buildPlateAnchoredQuad` / `resolveFloorPolygon` / `plateAngleRad` 순수 유닛테스트로 검증. 좌표 정확값 대신 **불변식**:

1. **점 수**: 생성기 산출 정확히 **4점**(deconflict 전).
2. **범위**: 모든 점 0~1.
3. **볼록·시계방향**: 캐노니컬 순서 `[FL,FR,RR,RL]`, `q[0].y>q[3].y`, `q[1].y>q[2].y`, `q[0].x<q[1].x`(기존 floorRoi.test 패턴 재사용). signed area 부호 일관.
4. **번호판 포함**: `plateQuad`(또는 그 boundingRect) 4모서리가 사변형 내부.
5. **하단변 평행(rule 2)**: 앞변 `FL→FR` 방향각과 `plateAngleRad(plateQuad)` 차이 ≤ 허용오차(예 **≤3°**, 회전·기울임 케이스).
6. **각도 정렬(rule 3)**: 기운 plate quad 입력 시 사변형 앞변 각도가 plate 각도를 추종(부호 일치).
7. **좌우 중앙성(rule 4)**: plate 중심의 **u축 투영**이 사변형 u축 중심과 근접(|Δ| ≤ 허용, 예 W의 ≤10%).
8. **세로 약간-앞(rule 5)**: plate 중심의 nb축 위치가 앞변에서 `PLATE_FRONT_RATIO`(<0.5) 근방 → **중앙보다 앞(아래)**. `frontDist < backDist`.
9. **각도 산출(plateAngleRad)**: 축정렬 quad→0; 알려진 회전 quad→기대각(±ε); 퇴화(면적0)→0.
10. **rect plate/plate 부재**: 각도 0, `predictPlateRect` 기반, 위 1~4·7·8 성립.
11. **경계 차량/plate**: clamp 후에도 1·2·4 성립(안전망 동작).
12. **멱등·안전망**: 이미 포함이면 `expandPolygonToContainRect` no-op(점수 4 유지).
13. **회귀**: `deconflictPolygons`·`FloorRoiReviewer`·`Finalizer` 기존 테스트 그린(계약 무변경 확인).

동작 확인(규칙3 Play 상응): 실 캡처 1런으로 `floorRoiByPreset` 생성 → 뷰어에서 녹색 사변형이 번호판에 각도·중앙 정렬·앞쪽 치우침으로 렌더되는지 육안 확인(참조 이미지와 대조).

---

## 7. 변경 파일 체크리스트 (구현자용)

- [ ] `src/domain/geometry.ts` — `plateAngleRad(quad)` (+투영 헬퍼) 추가, 기존 함수 무변경
- [ ] `src/capture/floorRoi.ts` — `buildPlateAnchoredQuad` 신규, `resolveFloorPolygon(+plateQuad)`, 상수 4종, 포함 안전망; 구 `fallbackPolygon` 대체
- [ ] `src/capture/FloorRoiReviewer.ts` — `s.plateQuad` 를 recognize/resolve 로 전달
- [ ] `src/capture/Finalizer.ts` — fallback 경로에 `m.plateQuad` 전달
- [ ] `src/brain/SetupBrain.ts` — `FloorRoiInput.plateQuad?` 추가, `FloorRoiResultSchema` 4점화
- [ ] `src/brain/AgentRuntime.ts` — 템플릿에 `plateQuad` 주입
- [ ] `config/prompts/floor_roi.yaml` — 신규 규칙으로 전면 재작성
- [ ] `web/*` — 무변경 확인(회귀만)
- [ ] `@parkagent/types` — 무변경 확인
- [ ] 테스트 — `test/floorRoi.test.ts` §6 불변식으로 갱신/추가, `agentRuntimeFloor.test.ts` 4점 정합, `deconflictPolygons`/`Reviewer`/`Finalizer` 회귀 그린

---

## 8. 리더 확인 필요(게이트)

1. **해석 A vs B**(§2-5): LLM floor 호출 유지(B·기본) vs 완전 결정형 제거(A·더 단순). 프롬프트 재작성이 명시 요청되어 B로 기본 진행하나, 규칙이 순수 기하이므로 A가 더 CLAUDE.md 부합. **확정 요청.**
2. **출력 키**(§2-6): `polygon` 유지·4점화(권장) vs `quad` 신설. 기본 = 유지·4점화.
3. **상수 초기값**(§2-3): `FLOOR_DEPTH_RATIO=0.55`, `PLATE_FRONT_RATIO=0.42` 등은 참조 이미지 눈대중 제안 — 초기값 승인/조정.
