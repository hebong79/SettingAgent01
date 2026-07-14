# 03 · 검증 리포트 — 번호판(LPD) 기준 floor ROI 재정의

검증자(qa-tester) / 대상: SettingAgent / 근거: `01_architect_plan.md` §6 불변식 13종 · `02_developer_changes.md` §7.
방식: vitest 순수 유닛테스트(정확 좌표 대신 **불변식** 검증). 외부 서비스(LLM/Unity)는 미기동 → 육안 동작확인은 누락 명시.

---

## 1. 실행 결과 (그대로)

| 실행 | 파일 | 테스트 | 결과 |
|---|---|---|---|
| 베이스라인(구현자 인계 시점) | 69 | 592 | 전부 통과 |
| **최종(신규 불변식 추가 후)** | **70** | **611** | **전부 통과** |

- 신규 테스트 파일 **1개 · 19 테스트** 추가 → 611 = 592 + 19.
- `npx vitest run` 전체 그린. 회귀 0.

### 신규/변경 테스트 파일
- **신규**: `test/plateAnchoredQuadInvariants.test.ts` (19 테스트) — 계획 §6 불변식 1~12 전담.
- **기존 유지(무수정)**: `test/floorRoi.test.ts`(20) 등은 구현자가 이미 시그니처 정합 갱신 완료 → 회귀 그린만 확인. 구현 소스는 **수정하지 않음**(지침 준수).

---

## 2. 커버된 불변식 체크리스트 (계획 §6)

| # | 불변식 | 테스트 | 상태 |
|---|---|---|---|
| 1 | 생성기 산출 정확히 4점 | `정확히 4점 · 모두 0~1` | 통과 |
| 2 | 모든 점 0~1 | 동상 + `범위 초과 차량 클램프` | 통과 |
| 3 | 볼록·시계방향 캐노니컬 `q0.y>q3.y, q1.y>q2.y, q0.x<q1.x` | `캐노니컬 시계방향 [FL,FR,RR,RL]` | 통과 |
| 4 | 번호판 quad 4모서리 사변형 내부 포함 | `번호판 quad 4모서리 포함` + resolve 포함 | 통과 |
| 5 | 앞변 각도 = plateAngleRad ±3° | `앞변 각도 추종 ≤3°` | 통과 |
| 6 | 기운 plate 부호 일치(각도 정렬) | `각도 부호 일치` | 통과 |
| 7 | 좌우 중앙성 `|Δu| ≤ W·10%` | `u축 투영 좌우중앙 근접` | 통과 |
| 8 | 세로 약간앞 `frontDist<backDist ~0.42D` | `nb축 앞변 쪽` + resolve 깊이보조 | 통과 |
| 9 | plateAngleRad: 축정렬→0 / 회전→기대각 / 퇴화→0 | `plateAngleRad` describe 4종 | 통과 |
| 10 | rect plate·plate 부재 → 각도0·포함·중앙·front-ratio | `rect plate / plate 부재` describe 2종 | 통과 |
| 11 | 경계 차량/plate clamp 후 1·2·4 + near-vertical | `범위 초과 클램프` + `near-vertical 퇴화 폴백` | 통과 |
| 12 | 안전망 멱등(포함 시 no-op, 점수 4 유지) | `안전망 멱등 no-op` 2종(참조동일·재확장) | 통과 |
| 13 | 회귀(deconflict·Reviewer·Finalizer·agentRuntimeFloor·promptsYaml) | 해당 6 스위트 52 테스트 | 통과 |

추가로 `plateAngleRad` **점순서 뒤바뀜(배열 reverse=감김 반전) 각도 불변**(계획 §5 리스크 대응)도 검증 → 통과.

---

## 3. 발견 사항 (결함 아님 · 사양 표현 불일치 1건)

### F-1. 캐노니컬 `q[0]`은 회전 시 FL 이 아니라 FR 로 이동 — **문서(계획 §6-3·구현자 §7-3) 표현과 실제 동작 불일치. 기능 결함 아님.**

- **입력**: `buildPlateAnchoredQuad(vehicle, plateQuad(θ=+15°/+30°))`.
- **기대(문서 문자 그대로)**: `q[0]=FL(앞왼)`, 따라서 앞변 = `q[0]→q[1]`(FL→FR), 그 각도 = plateAngleRad.
- **실제**: `orderConvexCanonical`이 **시작정점 = 최대 y**(동률 min x)로 잡는데, +회전 시 최대 y 정점이 **FR**(앞오)로 바뀐다. 그 결과 `q[0]→q[1]`은 앞변이 아니라 **우측변**(≈ ∥nb, θ+90° 방향)이 된다.
  - 예 θ=15°: `q=[(0.627,0.656)FR,(0.670,0.496)RR,(0.380,0.419)RL,(0.337,0.578)FL]`, `q[0]→q[1]` 각도 = **−75°**(앞변 아님). 실제 앞변은 `q[3]→q[0]`로 각도 **+15°**(= θ, 정상).
- **판정**: **구현 결함 아님**. 사변형 자체는 θ 로 정확히 기운 회전 직사각형이며, 앞변(두 앞 정점 사이 모서리)은 plate 각도를 정확히 추종한다. 시작정점 index 이동은 렌더(닫힌 다각형)·point-in-polygon·deconflict에 무해(순서 무관). 또한 계획 §6-3의 **구조 부등식**(`q0.y>q3.y, q1.y>q2.y, q0.x<q1.x`)은 회전에도 여전히 성립(테스트 통과).
- **영향**: 문서상 "앞변 = FL→FR = `q[0]→q[1]`"라는 서술만 부정확. 소비 코드가 `q[0]`을 "앞왼"으로 **의미적으로** 신뢰하면(현재 그런 소비처 없음) 오해 소지. 리더 판단으로 계획/구현노트의 해당 문장을 "앞변은 두 앞(−nb) 정점 사이 모서리이며, 캐노니컬 시작정점은 회전 부호에 따라 FL/FR 로 달라질 수 있다"로 정정 권장(코드 변경 불요).
- **테스트 대응**: 앞변을 index 고정(`q[0]→q[1]`)이 아니라 **nb 투영 최소 두 정점**으로 안정 식별(`frontEdgeAngle(q, θ)`)하여 §6-5·6·8 를 검증. (초기 작성 시 index 고정으로 3건 실패 → 원인 규명 후 헬퍼 보정, 구현 소스는 무수정.)

> 참고: θ<0(예 −25°)에서는 최대 y 정점이 우연히 FL 이라 `q[0]→q[1]`이 앞변과 일치했다. 즉 부호 비대칭이라 "가끔 맞아" 보이는 것이 오히려 함정. nb 기반 식별이 정답.

### 관찰(결함 아님, 언급만)
- 번호판 span 이 매우 커 D 를 plate 가 지배하는 극단 케이스(hp·1.15 > vehicle.h·0.55, 즉 hp ≳ 0.48·vehicle.h)에서는 빌더 단독의 앞쪽 nb 여유가 `0.42·D` vs plate 앞쪽 반폭 `0.5·hp = 0.43·D` 로 미세하게 부족 → 번호판 앞모서리가 살짝 돌출 가능. 그러나 (a) 실제 번호판이 차량 bbox 세로의 48% 를 점하는 일은 비현실적이고, (b) `resolveFloorPolygon`의 `expandPolygonToContainRect` 안전망이 이를 포함강제한다. 정상 경로(작은 plate) 포함은 테스트로 확인됨. 설계 §2-4 의도 범위 내 → 결함 아님.

---

## 4. 경계면 교차 비교 (plateQuad shape 일관성)

`plateQuad` 순서 규약 **TL,TR,BR,BL** 이 전 구간 일관함을 소스 대조로 확인:

| 지점 | shape | 비고 |
|---|---|---|
| `capture/types.ts` `AggregatedSlot.plateQuad: NormalizedQuad\|null` | OBB quad(방향 보존) | 원천 |
| `FloorRoiReviewer.ts` | `s.plateQuad` → `recognizeFloorRoi({plateQuad})` **및** `resolveFloorPolygon(polyRaw, vehicle, plateQuad, plate)` | 동일 객체 그대로 전달 |
| `Finalizer.ts` | `buildPlateAnchoredQuad(rect, m.plateQuad ?? undefined)`; 저장 `plateRoiByPreset = m.plateQuad ?? rectToQuad(plateRect)` | 동일 규약 |
| `geometry.plateAngleRad` | `quad[0..3]=TL,TR,BR,BL` 전제(상·하단변 평균) | 소비 |
| `SetupBrain.FloorRoiResultSchema` | `polygon: array.length(4)` | LLM 출력 4점 강제 — 프롬프트 키 `polygon` 통일(구 `quad` 불일치 해소) |

→ 필드명·타입·순서 규약 **불일치 없음**. rect→quad 폴백(`rectToQuad`)도 TL,TR,BR,BL 로 승격되어 각도 0 자연 수렴.

---

## 5. 누락(통과 위장 금지 · 명시)

- **동작확인(규칙3, Play 상응 육안 렌더)**: 실 캡처 1런으로 `floorRoiByPreset` 생성 → 뷰어에서 녹색 사변형이 번호판에 각도·좌우중앙·앞쪽치우침으로 렌더되는지 참조 이미지(`etc/주차면점유영역_0{1,2,3}.jpg`) 대조 — **미수행(누락)**. 사유: 외부 LLM(floor 비전)·Unity 미기동. 순수 기하 불변식은 유닛으로 전량 검증했으나, LLM 깊이 힌트가 실제 프레임에서 유효한지·렌더 정합은 스모크 필요.
- **실 연동 스모크(LLM `recognizeFloorRoi` 실호출)**: 미수행(모킹만). `agentRuntimeFloor.test.ts` 는 결정형 파싱 경로만 커버.

---

## 6. 결론

- 계획 §6 불변식 1~13 전량 vitest 로 검증 완료, 전체 611 테스트 그린. **구현 결함 없음**.
- 사양 표현 불일치 1건(F-1: 캐노니컬 시작정점의 FL/FR 이동)은 **문서 정정 권장, 코드 변경 불요**.
- 육안 동작확인·실 LLM 스모크는 외부 서비스 미기동으로 **누락**(문서 대조 필요) — 리더/문서화 단계로 인계.
