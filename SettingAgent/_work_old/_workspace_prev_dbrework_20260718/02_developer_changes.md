# 02. 구현 — 점유영역 사다리꼴 표시(번호판 앵커) + 겹침 회피 자동 폭 스케일

> 구현자(developer) 산출물. 2026-07-16. 입력: `_workspace/01_architect_plan.md`(§2~§6, §10 다음 단계).
> 검증자·문서화 인계용. 설계 이탈은 §3 에 전부 명시.

---

## 1. 변경 파일

| 파일 | 상태 | 변경 요지 |
|------|------|-----------|
| `web/occupancyRegion.js` | **신규** | `plateAxes` / `buildTrapezoid` / `clampToUnit` / `computeOccupancyRegions`(§2~§3 전체). 기하는 `occupancy.js`(clipByHalfPlane·convexIntersectionArea·polygonArea) + `core.js`(quadCentroid) **재사용** — 신규 프리미티브 없음 |
| `web/occupancyRegion.d.ts` | **신규** | §4 공개 API 타입 선언(occupancy.d.ts 짝 관례) |
| `web/core.js` | 수정 | `computeOccupancy` 내부 `centers` → `{center, quad}` 레코드 유지, occupied 행에 `plateQuad` **additive** 추가. 비점유 행·기존 필드 불변 |
| `web/core.d.ts` | 수정 | `OccupancySpace.plateQuad?: NormalizedPoint[]` 추가 |
| `web/occupancy.js` | 수정 | `judge` 1단계 plate 행 매핑에 `plateQuad: r.plateQuad` 추가(+ JSDoc `@returns` 동기화). bbox 행 무변경 |
| `web/occupancy.d.ts` | 수정 | `OccupancyJudgement.plateQuad?: NormalizedPoint[]` 추가 |
| `web/app.js` | 수정 | import 1줄, `updateLogicOccupancy` region 계산·저장 + `occRegionOverlapWarned` 프리셋당 1회 warn 가드, `drawOccupancyOverlay` 사다리꼴 다각형 렌더(면 레이어 선행) |
| `test/occupancyRegion.test.ts` | **신규** | §6 T1~T15 전량(16 it) |
| `test/occupancyJudge.test.ts` | 수정 | **T1 한 곳만** — base 를 `{idx,occupied,center}` 로 투영(§5·§8 예측분) |

서버(`src/`)·DB·라우트·HTML(신규 UI) 변경 **없음**. 사다리꼴은 기존 `#roi-occupancy` 토글 하위.

---

## 2. 핵심 구현 노트

- **축(§2-1)**: 대변 평균 엣지 → `û/v̂`, `W`=위·아래 엣지 길이 평균. `v_raw.y < 0` 이면 `û, v̂` **동시 반전**(핸디드니스 보존) → v̂ 는 항상 화면 아래(+y), '위'는 일관되게 `−v̂`. 퇴화(비4점·0길이 엣지)는 `null` 반환 — throw 없음(강등 철학). 4점·좌표 수치 검증은 `quadCentroid` 가 이미 수행하므로 중복 가드 없음.
- **사다리꼴(§2-2)**: `bw=s·W`, `tw=topWidthRatio·bw`, `Ct=C−upRatio·bw·v̂`, `Cb=C+downRatio·bw·v̂` → `[TL,TR,BR,BL]` 규약 유지.
- **탐색(§3)**: 1단계 상한(4.0) 비겹침이면 즉시 채택 → 아니면 하한(3.5) 비겹침 시 이진탐색 12회 + `floor(lo/0.05)·0.05` 스냅(축소 방향이라 비겹침 유지) → 하한에서도 겹치면 2단계 인스턴스별 0.9배 축소(≤20회, `minScale` 클램프). 순수·무상태·무난수.
- **경계(§2-4)**: `clampToUnit` = 단위정사각 4반평면 클립. 결과 3점 미만/면적 0 인스턴스는 `regions` 에서 제외(= region 없음 → 오버레이는 기존 원만).
- **bbox 폴백(§2-5)**: 사다리꼴 미생성 + 겹침 모집단 미포함 — `app.js` 에서 `source==='plate' && plateQuad` 로 필터.
- **렌더**: 사다리꼴 전량을 **면 레이어로 먼저** 그린 뒤(반투명 채움 `rgba(255,77,77,0.18)` + 윤곽 0.9), 기존 원/라벨 루프가 그 위에 그대로 남는다 — 기존 시각 회귀 0. 다각형 렌더 관용구는 `drawMaskOverlay` 와 동일(`toPixelQuad` N점 재사용).

### 탐색 실측(설계 예측과 일치)

| 케이스 | 결과 |
|--------|------|
| T8 dx=0.15 (bw=dx 인 s=3.75 경계) | `globalScale = 3.75` — 해석적 예측값과 일치, 0.05 그리드 위 |
| T9 dx=0.05 | `globalScale=null`, 인스턴스 scale `1.220`(=3.5·0.9¹⁰), `overlapPairs=[]` — 20회 상한 내 수렴 |
| T11 모서리(0.02,0.02) | 클립 후 4정점, 면적 > 0 |

---

## 3. 설계 대비 이탈·판단 사항

| # | 항목 | 판단 | 사유 |
|---|------|------|------|
| 1 | **2단계 루프 구조** | 설계 §3-3 의사코드는 `pairs` 검출 → shrink 순으로, 20회 소진 시 **마지막 shrink 로 이미 해소된 쌍**이 `overlapPairs` 로 보고될 수 있었다. 축소 후 재판정하도록 루프를 재배치(`pairs = overlappingPairs(scales)` 를 shrink 뒤에 1회) | 설계 의도("**잔존** 겹침 쌍 보고")를 정확히 구현하기 위함. 반복 상한·축소율·결정성은 설계 그대로. 기능적 이탈 아님 |
| 2 | **items 정렬** | `computeOccupancyRegions` 가 입력을 `idx` 오름차순으로 **정렬 후** 처리(설계는 "정렬된 입력" 전제) | 설계 §3-3 결정성 요건("쌍 순회는 idx 정렬 고정")을 호출측 전제가 아닌 함수 내부에서 보장. 3줄 |
| 3 | **`spaces` 필드명** | 설계 §4 배선도는 `spaces[i].region`. 실제 `app.js` 는 `id: o.idx` 규약이라 `{ id, occupied, source, center, vehicleRect, region }` 으로 `region` 만 additive 추가 | 기존 파일 스타일 유지(규칙 3). 소비처(`drawOccupancyOverlay`)만 접점 |
| 4 | **테스트 수** | §5 표는 "T1~T14", §6 표는 T15 까지 → **T1~T15 전량** 구현(16 it: T11 이 `computeOccupancyRegions` 경계 + `clampToUnit` 전부클립 2 케이스) | §6 이 상세 표. 전부클립 → `[]` 은 §4 가 명시한 반환 분기(region 미생성)라 봉인 |
| 5 | 파라미터 UI 노출 | 없음(코드 기본값만) | 설계 §2-3·§10-3 |

**설계 결함 보고 없음** — §2~§4 수학·API 를 그대로 구현했고, 위 1번은 의사코드의 보고 시점 미세 결함으로 설계 의도 범위 내에서 해소.

---

## 4. 검증 게이트 실행 결과

```
d:\Work\Parking3D\AgentVLA\ParkAgent\SettingAgent> npx tsc -p tsconfig.json --noEmit
TSC_EXIT=0                                  ← 에러 0

d:\Work\Parking3D\AgentVLA\ParkAgent\SettingAgent> npx vitest run
 Test Files  151 passed (151)
      Tests  1657 passed (1657)
   Duration  12.51s
EXIT=0                                      ← 실패 0, 회귀 0
```

신규/영향 파일 상세:

| 파일 | 테스트 | 결과 |
|------|--------|------|
| `test/occupancyRegion.test.ts` (신규) | 16 | 전량 통과 |
| `test/occupancyJudge.test.ts` (T1 투영 보정) | 11 | 전량 통과 |
| `test/computeOccupancy.test.ts` (무수정) | 15 | 전량 통과 — 설계 §8 예측대로 `toMatchObject`/비점유 `toEqual` 이라 무영향 |

**테스트 무력화·skip·통과 위장 없음.** 설계 §8 이 예측한 `occupancyJudge.test.ts` T1 한 줄 외에 기존 테스트 수정 없음.

---

## 5. 인계 (검증자 / goal/loop)

- **진입점**: `computeOccupancyRegions(items, cfg?)` — `web/occupancyRegion.js`. 오프라인 스샷은 이 함수에 `[{idx, quad}]`(LPD plate OBB) 를 직접 넣으면 됨(`plateAxes`/`buildTrapezoid` 도 개별 export).
- **라이브 경로**: `app.js updateLogicOccupancy` → `state.occComputeByKey[key].spaces[i].region`(정규화 다각형) → `drawOccupancyOverlay`.
- **관찰 포인트(§7)**: 겹침(콘솔 `[OccupancyRegion] <key> 겹침 잔존:` — 프리셋당 1회) / 위·아래 변의 번호판 가로 기울기 정합 / 위 길이 / 폭(≈3.5~4×번호판).
- **튜닝 1순위**: `topWidthRatio`(0.85, `web/occupancyRegion.js` DEFAULTS) → 이후 `upRatio`/`downRatio`. 프레임 떨림 시 `scaleQuantum` 0.05→0.1.

---

# 【2차 이터레이션】 번호판 quad 점 순서 순환 회전 강건화 (`plateAxes` 장축 채택)

> 구현자(developer) 산출물. 2026-07-16. 입력: `_workspace/03_qa_report.md` §3-1 · §5(구현자 인계).
> 1차 내용은 위에 그대로 보존. 본 섹션은 **결함 수정분만** 기술.

## 1. 결함 원인

설계 §2-1 은 `NormalizedQuad = [TL,TR,BR,BL]` 이며 `TL→TR` 이 번호판 **가로**라고 전제했다.
실 LPD(ultralytics OBB)는 4점을 **박스 자체 회전 순서**로 내보내므로 라벨이 순환 회전돼 들어온다.
`src/domain/geometry.ts:92 normalizeQuad` 는 점 순서를 **정규화 없이 통과**시킨다 — 규약은 문서상 존재하나 강제 코드가 없다.

결과: `plateAxes` 가 `TL→TR` 을 무조건 û(가로)로 신뢰 → cam1_p2 **전 5개**에서 û 가 번호판 **단축**을 잡고 사다리꼴이 90° 회전·과소 생성.

**실측 재확인**(`_qa_data/detect_cam1_p2.json`, 캐시 오프라인):

| 프레임 | idx | 픽셀 네 변 | 기존 û | 판정 |
|--------|-----|-----------|--------|------|
| p2 | 9 | 17.7 / **56.5** / 17.7 / **56.5** | (-0.058, 0.998) = 세로 | 순환 회전 ✘ |
| p1 | 1 | **71.1** / 19.0 / … | 가로 | 규약 준수 ✔ |

## 2. 수정 내용 — `web/occupancyRegion.js` `plateAxes` **단독**

1. **장축 채택**: 두 대변 평균 벡터(`a`: TL→TR·BL→BR / `b`: TL→BL·TR→BR)를 모두 구해 **긴 쪽을 û(가로)**, 짧은 쪽을 v̂ 로 채택. `width` = 채택된 û 방향의 **평균 엣지 길이**. 근거: 번호판은 실물 가로가 항상 김(한국 규격 약 520×110mm ≈ 4.7:1).
2. **핸디드니스 복원**: 두 기저를 맞바꾸면 핸디드니스가 뒤집히므로 교체 시 û 를 반전(`usign = swapped ? -flip : flip`).
3. 기존 `v̂.y < 0` 부호 정규화(û·v̂ 동시 반전)는 **그대로 유지** → '위' = `−v̂` 일관성 보존.
4. 강제 직교화 **미도입** — 설계 §2-1 대로 대변 평균을 그대로 쓴다. `buildTrapezoid`·탐색 루프·렌더 **무변경**.

### 【중요】 핸디드니스는 상수로 고정하면 안 된다 (실측으로 발견)

구현 중 "cross(û,v̂) > 0 강제" 가드를 검토했으나 **실측에서 기각**했다. 실 LPD quad 는 규약 준수 프레임(p1·p3)조차 `cross(û,v̂) ≈ **−0.99**` 로, 합성 테스트 픽스처(`plateAt`, `+1`)와 **반대 감김**이다. 상수 가드를 넣었다면 **p1/p3 에서 발화해 기존 결과를 바꿨을 것**이다.
→ 채택안은 절대 부호를 강제하지 않고 **입력 quad 자신의 핸디드니스를 복원**한다(순환 회전은 `cross(a,b)` 부호를 보존하므로 정합). 데이터 규약 비의존.

### 【리스크 노트】 정규화 좌표계에서 종횡비 마진은 픽셀 대비 절반

`plateAxes` 는 **정규화 좌표**에서 동작하므로 이방성(1080/1920 = 0.5625)이 종횡비를 압축한다.
판이 픽셀공간에서 가로로 누울수록: `정규화비 ≈ 픽셀비 × 0.5625`.

| 프레임 | 픽셀 종횡비 | 정규화 장/단축비(실측) |
|--------|------------|----------------------|
| p1 | 3.7 : 1 | **2.11** |
| p2 idx9 | 3.2 : 1 | **1.82** (최소 마진) |
| p3 | — | 1.93 ~ 2.19 |

역전(장단축 오판) 조건은 **픽셀 종횡비 < 약 1.78:1**. 실측 최악이 3.2:1 이므로 마진은 충분하나, QA 보고서가 근거로 든 3.2:1/4.7:1 보다 **실효 마진은 얇다**(1.82 vs 1.0). 극단 사선뷰에서 판이 1.78:1 미만으로 압축되면 재발 가능 — 향후 관찰 대상.

## 3. 신규 테스트 — `test/occupancyRegion.test.ts` (T1~T15 전량 유지)

| 테스트 | 내용 |
|--------|------|
| **T16** | 90° 순환 회전 quad(`rotateOrder(quad,1)`, 장축 TR→BR) → û·v̂·width 가 회전 전과 **딥 근사 동일**, `width ≈ 0.04`(단축 0.02 아님) |
| **T17** | **30° 기운** 판으로 4가지 순환 회전(0/90/180/270°) 전부 → 동일 축·width + `buildTrapezoid` 4점 **좌표 근사 동일**(축정렬은 부호 오류를 가리므로 기운 판 사용) |
| **T18** | **실검출 회귀(cam1_p2)** — `detect_cam1_p2.json` idx 9 실좌표 픽스처 → `width ≈ 장축(0.02975)`, 단축(0.01633)과 0.01 이상 이격, `cross(û, 장축) ≈ 0` |

신규 헬퍼 `rotateOrder(quad,k)` — 좌표 불변, 라벨만 k칸 순환.

### 테스트 유효성 실증 (위장 방지)

신규 3개 테스트를 **수정 전 구현에 실행 → T16·T17·T18 전부 FAIL**, 수정 후 PASS 확인. T1~T15 는 양쪽 모두 PASS(무회귀).
※ `web/occupancyRegion.js` 는 **git 미추적(`??`)** 이라 `git stash` 로는 되돌려지지 않는다 — 임시 복사본으로 검증했다.

## 4. 게이트 실측 결과

| 게이트 | 결과 |
|--------|------|
| `npx tsc -p tsconfig.json --noEmit` | **exit 0** |
| `npx vitest run` | **151 files / 1660 tests 전량 통과** (1차 1657 → +3, 회귀 0) |

## 5. 영향도 — p1·p3 무변경 실증

수정 전/후 구현을 **동시 import** 해 실검출 3프레임의 `computeOccupancyRegions` 출력을 JSON 딥 비교:

| 프레임 | 구/신 region 출력 | width(px-eq) 구 → 신 |
|--------|------------------|---------------------|
| p1 | **완전 동일** | `[71.3, 61.8, 51.8, 54.1, 52.0, 46.5]` → 동일 |
| p2 | *** 변경됨 *** (의도) | `[34.3, 31.6, 29.9, 31.4, 25.9]` → `[73.6, 61.3, 55.8, 57.1, 47.9]` |
| p3 | **완전 동일** | `[104.4, 80.9, 66.1]` → 동일 |

**보장 근거(코드 경로)**: `swapped = |b| > |a|` 가 거짓이면 `uc=a, vl=bl2, usign=flip, width=a.width` 로 **1차 구현과 문자 그대로 동일한 식**이 된다. p1(6개)·p3(3개) 전수 `swap=no`, p2(5개) 전수 `swap=YES` — 실측 확인.

`buildTrapezoid`·`clampToUnit`·`computeOccupancyRegions`·`app.js`·서버(`src/`)·DB·라우트 **변경 없음**. `occupancyRegion.d.ts` 시그니처 불변(반환 형태 동일).

**p2 보정 배율은 1.82×**(정규화 공간 기준)이며, QA 보고서 §3-1 의 "3.3× 과소"는 픽셀공간 기준 수치다 — 두 값의 차이는 위 이방성 노트로 설명된다.

## 6. 설계자 인계 사항

- 설계 §2-1 의 "`TL→TR` = 가로" 전제는 **실 LPD 출력에서 성립하지 않는다**. 본 수정은 `plateAxes` 국소 강건화로 흡수했으나, 근본 해결은 `src/domain/geometry.ts normalizeQuad` 에서 점 순서를 규약으로 정규화하는 것이다(범위 밖 — 미착수, 발견 사항으로만 보고).
- QA 보고서 §3-4(사다리꼴이 차량을 못 덮음)는 본 수정 후 **재측정 필요** — p2 는 축이 바뀌었으므로 1차 수치가 무효다.

---

# 4차 이터레이션 — 파라미터 확정(수렴): `upRatio` 0.55 → 0.90

## 1. 변경 상수

`DEFAULTS.upRatio` **0.55 → 0.90** (단 하나). `downRatio=0.30` 유지 → **up:down = 3:1**.
다른 파라미터·로직·함수 시그니처 **전부 무변경**(규칙 3 외과적 변경).

| 파일 | 변경 |
|------|------|
| `web/occupancyRegion.js` | `DEFAULTS.upRatio: 0.55` → `0.90` (L19) |
| `web/occupancyRegion.d.ts` | `RegionConfig.upRatio` JSDoc "기본 0.55" → "기본 0.90" |
| `test/occupancyRegion.test.ts` | T3 갱신(아래 §3) |
| `_workspace/01_architect_plan.md` | §2-3 파라미터 표 `upRatio` 행만 갱신 |

## 2. 결정 근거 (오케스트레이터 스샷 육안 판정 — `_qa_shots/iter3_sweep_p{1,3}_up{055,090,130,170}.png` 8장 + `03_qa_report.md` 3차 스윕 수치표)

- **up=0.55** 는 차량 앞코만 덮어(덮음률 p1 30.8% / p3 12.6%) 마스터 요구 "위가 좀 길어야 한다"가 시각적으로 약하다.
- **up=0.90** 은 p1 에서 차체를 적절히 덮고(43.8%), 사선뷰 p3 에서도 이웃침범률 14.6% 로 자기 차 덮음률(18.9%) 대비 우위를 유지한다. → **채택**
- **up=1.30 이상**은 p1 에서 사다리꼴 상단이 지붕을 넘어 배경으로 뻗고, p3 에서는 up=1.70 시 이웃침범률(33.6%)이 자기 차 덮음률(33.3%)을 추월해 점유 표시로서 오인을 유발한다.
- `upRatio` 는 **R1(겹침 금지)·R4(3.5~4배)를 제약하지 않음이 수치로 확인됨**(3차 스윕 전 8수준 `globalScale=4.0`, `overlapPairs=[]`, 최대 교차면적 0.000e+0). 사다리꼴은 v̂ 방향으로만 자라 좌우 평행 띠끼리 만나지 않기 때문. 따라서 본 결정은 **순수 시각 판정이며 하드 제약과 무충돌**.

## 3. 갱신한 테스트

`test/occupancyRegion.test.ts` — **T3 "위가 길다"** 1건만 갱신(그 외 테스트 무변경).

- 제목 `(0.55/0.30)` → `(0.90/0.30)`.
- 단언을 2단으로 분리:
  1. **불변식(R2)**: `expect(ratio).toBeGreaterThan(1)` — 하드코딩 부등식. 기본값이 어떻게 바뀌든 "위가 아래보다 김"을 독립 검증하며, 구현을 그대로 베끼지 않아 회귀 탐지력을 보존한다.
  2. **확정값 핀**: `expect(ratio).toBeCloseTo(0.9 / 0.3, 9)` — 4차 확정 기본값 고정.
- `DEFAULTS` 참조는 **하지 않음**: 모듈이 export 하지 않으며, 테스트 편의만을 위해 내부 상수를 공개 API 로 승격하는 것은 규칙 3(외과적 변경)·규칙 2(요청 없는 확장) 위반. 위 부등식+핀 조합으로 상수 중복의 실질 위험(구현 복사)은 해소된다.

**미갱신(의도적)**: 설계서 §5 인터페이스 스켈레톤 주석(`upRatio?: number; // 0.55`)과 §6 T3 케이스 표(`0.55/0.30`)에 구값이 남아 있다. 지시가 "§2-3 표만, 다른 부분은 건드리지 마라"였으므로 손대지 않았다 — **설계자/문서화 인계 사항**.

## 4. 게이트 실측

```
cd SettingAgent
npx tsc -p tsconfig.json --noEmit   → exit 0 (출력 없음)
npx vitest run                       → exit 0
   Test Files  151 passed (151)
        Tests  1660 passed (1660)
     Duration  11.04s
```
회귀 **0건**.
