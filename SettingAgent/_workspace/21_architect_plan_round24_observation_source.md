# 24회차 설계 — 관측원을 이미지 유래로 교체 (`degradeCar` → 실검출기)

- 작성: 2026-07-30 / 설계자 · 워크트리 `round22-rows-threshold`
- 선행: `_workspace/11_architect_plan_round23_individual_engine.md` · `_workspace/12_developer_individual_engine_round23.md`
- Goal: 정밀도 ≥0.70 유지 · 재현율 > `0.5853658536585366`
- **이 문서의 모든 수치는 이번 설계 중 실제로 호출해 얻은 실측이다. 추측은 「미측정」으로 표기했다.**

---

## 0. 결론 먼저 — 관측원은 **실재한다**. 강등본을 쓸 이유가 없다.

23회차 §12-1 은 「이미지에서 차량을 실제로 검출하는 소스: 미구현」이라 적었다. **그러나 미구현이지 부재가 아니었다.**
설계 중 골든 프레임 5장을 **실제 검출 서버에 그대로 POST 해서** 다음을 얻었다.

| 소스 | 엔드포인트 | 골든 프레임 적용 | HTTP | 지연 |
|---|---|---|---|---|
| **VPD det** (bbox) | `http://192.168.0.125:9081/vpd/api/v2/det/imgupload` | **가능** | `201` | 4.35s(초회) |
| **VPD seg** (bbox+**마스크 폴리곤**) | `.../vpd/api/v2/seg/imgupload` | **가능** | `201` | 0.74s |
| **LPD** (번호판 OBB) | `http://192.168.0.125:9082/lpd/api/v1/imgupload` | **가능** | `200` | — |

`/health` 는 양쪽 다 **404**(health 라우트 부재 — 서버가 죽은 게 아니다. 검출 라우트는 정상 응답).

### 0-1. ★ 실측 — 골든 5프레임 검출 수 (분모 = 23회차 가시면 41)

| 프리셋 | 골든 JPEG | 가시면(정답) | **VPD seg bbox** | **마스크 개수** | 마스크 점수(min/med/max) | **LPD 판** |
|---|---|---|---|---|---|---|
| 1:1 | `frame_1_1_d0.jpg` | 10 | 8 | **8** | 48 / 84 / 185 | 7 |
| 1:2 | `frame_1_2_d0.jpg` | 14 | 10 | **10** | 14 / 223 / 577 | 10 |
| 1:3 | `frame_1_3_d0.jpg` | 2 | 1 | **1** | 90 / 90 / 90 | 2 |
| 2:1 | `frame_2_1_d0.jpg` | 7 | 8 | **8** | 83 / 161 / 234 | 8 |
| 2:2 | `frame_2_2_d0.jpg` | 8 | 9 | **9** | 47 / 157 / 341 | 6 |
| **계** | | **41** | **36** | **36** | | **33** |

- `maskMismatch = 0` — 5프레임 전부 bbox 수 = 마스크 수. `VpdClient.segment()` 의 drop 경로가 안 탄다.
- **VPD det 은 seg 보다 후하다**: 1:1 에서 det `12` vs seg `8`. det 은 통로에 선 차·원경까지 잡는다(잡음원).

### 0-2. ★ 이것이 재현율에 거는 **하드 실링** (측정 전에 확정되는 값)

관측 1건 → 면 0 또는 1개(G1)이므로 **관측 수가 재현율 상한을 직접 못 박는다.**

| 소스 | 관측 수 | **재현율 이론 상한** (전부 서로 다른 참 면에 정확히 꽂힐 때) |
|---|---|---|
| 강등본(22·23회차) | 42 | `0.9512195121951219` (실측 달성) |
| **VPD seg 마스크** | **36** | **36/41 = `0.8780487804878049`** |
| **LPD 판** | **33** | **33/41 = `0.8048780487804879`** |

→ **목표선 `0.5853658536585366` 초과에는 여유가 있다.** seg 기준 36건 중 **25건**이 제대로 꽂히면 목표선을 넘는다(25/41 = `0.6097560975609756`).
→ 반대로 **강등본의 `0.95` 는 이 관측원으로는 원리적으로 도달 불가**다. 그것이 「치트였다」의 정량이다: **최소 `0.9512…−0.8780… = 0.0731…` 은 검출기 자체의 결손**이고, 나머지는 기하 결손이다. 24회차는 이 둘을 분리해서 잰다.

---

## 1. 답변 ① — 무엇을 관측원으로 쓸 것인가 (실재 확인 완료)

### 1-1. 채택: **VPD seg 마스크** (1순위)

이유: `VehicleObservation.footprintPx`(=접지 사각형)를 만들 수 있는 **유일한** 이미지 소스다.
- **det bbox** 는 축정렬 박스 → 방위 정보가 없다(`carAnchorUpper.ts:103` 주석이 그대로 지적). `groundAxisOf` 에 못 먹인다.
- **LPD 판** 은 판 1점 + 폭 → 방위는 판의 û 로 나오지만 **깊이축 원점(접지)** 이 없다.
- **seg 마스크만** 하단 윤곽 = 접지선을 준다.

### 1-2. ★ 재발명 금지 — 마스크→접지 파이프라인은 **이미 있다**

| 함수 | 위치 | 하는 일 |
|---|---|---|
| `bottomContour(mask, stepPx)` | `src/ground/contact.ts:85` | 마스크 폴리곤 → **열별 최하단 점**(`ContactCol[]`). 오목/bridge 폴리곤에서도 정확 |
| `fitContactLine(pts, opts)` | `src/ground/contact.ts:343` | (a,b) 축좌표 점 → 로버스트 접지선. **하위 분위수 + frontBand + frontSpan 검증** |
| `buildFootprint(fit, axes, opts)` | `src/ground/contact.ts:417` | 접지선 + `SlotAxes` → 지면 `Footprint`(폭 클램프·`wSource` 강등 포함) |
| `buildFrameCuboids(args)` | `src/ground/frameCuboids.ts:250` | det↔seg 정합 + 위 전부를 묶은 프레임 단위 진입점 |
| `VpdClient.segment(jpeg)` | `src/clients/VpdClient.ts:84` | seg POST → `SegBox[]`(정규화 mask 포함). HTTP 500(검출 0대) 강등 처리 내장 |
| `associateDetSeg` | `src/ground/segAssoc.ts` | det(권위) ↔ seg 1:1 IoU 정합 |

### 1-3. ★ 그러나 `buildFrameCuboids` 를 통째로 쓰면 **안 된다** — 오라클 오염 위험

`buildFrameCuboids` 는 `CuboidContext.slotPolysPx`(`frameCuboids.ts:28`)를 요구하고, `buildFootprint` 는 `SlotAxes`(`contactTypes.ts:64`)를 요구한다. **`SlotAxes` 는 슬롯 폴리곤에서 유도된다.** 골든 프레임에서 슬롯 폴리곤을 truth(`t.vis[].quad`)로 채우면 **그게 곧 오라클 주입**이다 — 우리가 찾으려는 답(면 위치·방위)을 입력으로 먹이는 꼴이고, 불변 제약(오라클 검출 경로 금지)을 정면 위반한다.

**→ 결정: `SlotAxes` 를 요구하는 상위 2단계(`fitContactLine`/`buildFootprint`/`buildFrameCuboids`)는 쓰지 않는다.**
**→ `bottomContour` 만 재사용하고**, 축은 23회차가 이미 쓰는 **비-오라클 경로 `groundAxisOf`**(관측 자기 자신의 지면 4점에서 축을 뽑는다)로 잇는다. 이러면 `proposeFromObservation`(`individualEngine.ts:155`)을 **한 줄도 안 고치고** 관측원만 갈아끼운다.

- 미측정 고지: 「`SlotAxes` 를 비-오라클로 부트스트랩할 수 있는가」는 **이번 회차 범위 밖**. `contact.ts` 의 로버스트 적합(하위 분위수·frontBand·frontSpan 검증)을 못 쓰는 것은 **자각한 손실**이며, 25회차 후보다.

### 1-4. `occupancyRegion` — 위치·시그니처 확인 (재발명 금지)

| 항목 | 값 |
|---|---|
| 파일 | `src/domain/occupancyRegion.ts` |
| 파라미터 정본 | `REGION_DEFAULTS` (`:34`) — `widthScaleMin 3.5` · `widthScaleMax 4.0` · `topWidthRatio 1.0` · `upRatio 0.9` · `downRatio 0.6` |
| 축 추출 | `plateAxes(quad: NormalizedQuad): PlateAxes \| null` (`:92`) |
| 사다리꼴 | `buildTrapezoid(axes, scale, cfg?): NormalizedPoint[]` (`:128`) |
| 겹침해소 포함 | `computeOccupancyRegions(items, cfg?): RegionResult` (`:166`) |
| **외부 진입점** | `buildOccupyRegionsBySlot(plates: Array<{slotId,quad}>, cfg?): Map<number, NormalizedPoint[]>` (`:238`) |

**입력은 정규화(0..1) 좌표계**다. 골든 파이프라인은 원본 픽셀(`t.W`/`t.H`)이므로 **변환 어댑터가 필요**하다.
**이번 회차에서 `occupancyRegion` 은 보조(소스 B)로만 쓴다** — 아래 §1-5.

### 1-5. 보조: **LPD 소스** (2순위 · 같은 회차에 나란히 잰다)

LPD 는 33건으로 seg(36)보다 적지만 **`degradeCar` 가 이미 `plateQuad`/`platePx` 를 내고 있어**(`carAnchorUpper.ts:169-197`) 강등본과 **축이 완전히 같은 비교**가 된다. 그리고 이것이 **실카 정본 경로**다(마스터 결정: LPD 중심 · VPD 자동검출 금지).

- 실카 규약상 **VPD 는 자동검출 금지**(auto-memory `vpd-auto-detect-forbidden`). **VPD seg 소스는 24회차 계측 전용**임을 문서에 못박는다 — 실카 셋업 경로에 배선하지 않는다.
- LPD 소스의 `footprintPx` 유도: 판 quad → `plateAxes` → `buildTrapezoid(axes, scale, REGION_DEFAULTS)` → **점유 사다리꼴이 곧 접지 후보 4점**. 신규 기하 0줄.

### 1-6. `mcp__setting13020__vpd_detect` 는 쓰지 않는다 (이유 명기)

시그니처는 `{ jpgBase64: string }` → 정규화 bbox. **det 전용이라 마스크가 없다** → 접지선 불가.
게다가 골든 JPEG 를 base64 로 도구 인자에 실으면 프레임당 수십만 자다. **`VpdClient` 직접 호출이 우월**하다(같은 서버·같은 라우트·재시도/로깅 내장). 카메라 물리 이동과도 무관하다(`camera_req_img` 를 안 부른다 → 21회차 (a) 회피).

---

## 2. 답변 ② — ★ 성패 예측선 (측정 **전에** 적는다)

### 2-1. 22회차 감도표 (기준)

| 오차 종류 | 크기 | 정밀도 | 재현율 |
|---|---|---|---|
| 접지선 랜덤 | ±40px | `0.851` | — |
| 접지선 **계통 편의** | 30px | `0.854` | 유지 |
| 접지선 **계통 편의** | 60px(≈1.4m) | — | **`0.5853658536585366` 로 붕괴** |

### 2-2. ★ 예측 (구현 전 확정 · 수정 금지)

**예측 P-a — 오차의 성질은 랜덤이 아니라 계통 편의(아래쪽)다.**
근거: seg 마스크는 **차체 아래 그림자를 포함**하는 방향으로 새는 것이 일반적이고, 그림자는 접지선을 **화면 아래(카메라 쪽)** 로 민다. `contact.ts:335` 부근 주석이 같은 함정을 이미 기록하고 있다 — 「로커패널·범퍼하단·언더바디 그림자(z≈0.15~0.25m)가 지면에 역투영되면 카메라에서 **멀어지는 쪽**으로 밀린다」. 방향은 그 주석과 부호가 반대일 수 있으나(마스크 하단 vs 현), **단방향 편의라는 성질**은 같다.

**예측 P-b — 편의 크기는 10~30px 대에 들어간다. 60px 붕괴선에는 안 닿는다.**
근거: 그림자 폭 z≈0.15~0.25m 이고, 골든 프레임 실측 관측 깊이가 `7.889550131209605~31.873783956026966 m`(23회차 §7)다. 근경(8m)에서 0.25m 는 수십 px, 원경(30m)에서는 한 자릿수 px 다. **원경일수록 작아지므로 평균은 30px 아래**.

**예측 P-c — 최종 성적 예측 (원시 배정도 구간)**

| 지표 | 예측 구간 | 근거 |
|---|---|---|
| **재현율(VPD seg)** | **`0.60` ~ `0.78`** | 상한 `0.8780487804878049`(§0-2) × 기하 생존율(편의 30px 이내 → 22회차 표에서 재현율 유지 쪽) |
| **정밀도(VPD seg)** | **`0.75` ~ `0.90`** | 22회차 30px 계통편의 정밀도 `0.854` 근방 · seg 잡음(통로 차·원경)이 det 보다 적다 |
| **재현율(LPD)** | **`0.45` ~ `0.70`** | 상한 `0.8048780487804879` · 판→접지는 사다리꼴 prior 의존이라 seg 보다 열등할 것 |
| **목표선 통과 여부** | **VPD seg = 통과 · LPD = 반반** | |

### 2-3. ★ 예측이 틀리면 무엇을 배우는가

| 실측 결과 | 배우는 것 |
|---|---|
| 재현율 **> 0.78** (예측 상회) | 편의가 10px 미만 = 시뮬 그림자가 약하다. **시뮬 골든이 실카보다 쉬운 데이터**라는 증거 → 시뮬 성적으로 실카를 예측하면 안 된다는 결론이 강화된다 |
| 재현율 **0.60~0.78** (적중) | 22회차 감도표가 **실제 검출기 오차를 예측하는 도구로 검증**된다. 앞으로 실카 σ 만 재면 성적을 미리 계산할 수 있다 |
| 재현율 **< 0.5853658536585366** (붕괴) | **편의가 60px(1.4m) 급**이라는 뜻. 예측 P-b 가 틀린 것이고, 원인은 그림자가 아니라 **마스크 하단이 접지가 아닌 다른 것**(가림 차량 경계·bridge 병합). 이때는 `contact.ts` 의 로버스트 적합(하위 분위수)을 못 쓴 §1-3 의 결정이 대가를 치른 것 → 25회차는 **비-오라클 `SlotAxes` 부트스트랩**이 최우선 과제가 된다 |
| 정밀도 **< 0.70** | 잡음원이 오검출이 아니라 **기하 붕괴**(엉뚱한 위치에 면을 닫음). 게이트 축을 §4 로 갈아야 한다 |

---

## 3. 답변 ③ — 인터페이스 (교체 접점)

### 3-1. 접점은 함수 1개 — `ObservationSource.observe`

```
individualEngine.ts:77-81   interface ObservationSource { kind; observe(t, view): VehicleObservation[] }
individualEngine.ts:88      simDegradedSource(...)   ← 기존 (강등본)
individualEngine.ts:75      ObservationKind 에 'real-seg' | 'real-vpd' | 'real-lpd' 자리가 이미 있다
```

**신규 파일 `src/tools/imageObservation.ts` 에 소스 2개를 추가한다. `individualEngine.ts` 는 import 1줄 + CLI 분기만 늘린다.**

| 신규 소스 | `kind` | 산출 |
|---|---|---|
| `vpdSegSource(cache)` | `'real-seg'` | 마스크 → `bottomContour` → 접지 4점 → `footprintPx` |
| `lpdPlateSource(cache)` | `'real-lpd'` | 판 quad → `plateAxes`+`buildTrapezoid` → `footprintPx` (+ `plateQuad`/`platePx` 채움) |

**`VehicleObservation` 타입은 안 고친다**(`carAnchorUpper.ts:99-110`). `source: 'sim-projected'` 필드값이 안 맞으면 **타입만 유니온 확장**(`'sim-projected' | 'real-vpd-seg' | 'real-lpd'`) — 리터럴 추가 1줄. 로직 0줄.

### 3-2. ★ 같은 프레임에서 **나란히** 재는 방법

`runEngine(t, view, src, g, ev)`(`individualEngine.ts:259`)는 이미 소스를 인자로 받는다. **같은 `targets`/`views` 로 소스만 바꿔 3회 돌린다.**

```
--source degraded   (기본 · 회귀 기준선)
--source vpdseg
--source lpd
--source all        ← 3개를 한 실행에서 돌려 같은 frameHash 로 대조표 출력
```

`--source all` 이 정본이다. 프레임을 **한 번만** 읽으므로 `frameHash` 가 물리적으로 같음이 보장된다.

### 3-3. ★ 검출 응답 캐시 (필수 — 결정성·무이동)

`reports/detcache_r24/{frameHash}_{seg|lpd}.json` 에 **원문 그대로** 저장하고, 있으면 네트워크를 안 탄다.
- 실행마다 값이 흔들리면 판정선이 무의미해진다 → **캐시가 결정성의 근거**다.
- 골든 프레임은 파일이므로 **카메라 물리 이동 0**. `camera_req_img`/`requestImage` 를 **부르지 않는다**.
- seg 가 HTTP 500(검출 0대)이면 `VpdClient.segment` 가 `segDegraded:true` 로 강등한다 — 그대로 기록하고 관측 0으로 간다(위장 금지).

---

## 4. 답변 ④ — 게이트 재검토 (새 가중식 발명 금지)

23회차 실측: 게이트 탈락 **0건** · 배타성 접힘 **0건**. **관측원이 바뀌면 잡음의 성질이 바뀐다.**

### 4-1. 무엇이 바뀔 것으로 보는가

| 축 | 강등본에서 (23회차) | 이미지 유래에서 예상 |
|---|---|---|
| `footprintAreaPx` **하한** | 무력 — 잡음이 참보다 **컸다**(칸 밖 큰 차) | **여전히 무력할 것.** 단 seg 는 원경 파편 마스크(14점짜리 — 1:2 실측 min)를 낼 수 있어 **하한이 처음으로 일을 할 가능성**이 생겼다 |
| `outOfFramePts` | 조이면 참 2 : 잡음 2 (P4 실패) | 동일 구조 예상. **변경 없이 재측정만** |
| `depthM` | 참/잡음 완전 포함 → null | **재측정.** 원경 오검출이 늘면 `depthHiM` 이 처음으로 분리력을 가질 수 있다 |
| **`confidence`** (신규 축) | **존재하지 않았다** | ★ **이미지 유래에서만 생기는 축.** VPD 실측이 `0.6848217844963074 ~ 0.9614785313606262` 로 **넓게 퍼져 있다**. 하위 3건(`0.735`/`0.698`/`0.685`)이 1:1 의 겹친 원경 박스다 |

### 4-2. 결정 — 게이트에 **축 1개만** 추가한다: `minConfidence`

- **새 가중식이 아니다.** `gateBay`(`individualEngine.ts:199`)와 **같은 형태의 절대 문턱 1줄**(`if (!(p.confidence >= g.minConfidence)) failed.push('conf')`). G5 무위반 — 다른 면을 안 본다.
- 검출기가 **주는 값**이지 우리가 만든 점수가 아니다. 강등본에는 `confidence = 1` 고정(축이 무력화 → 회귀 기준선 불변 보장).
- 기존 3축(`area`/`outOfFrame`/`depth`)은 **한 줄도 안 고친다.** 도출 규칙도 23회차 그대로 — **「참을 하나도 안 죽이는 최대값」을 Phase 0 분포에서 뽑는다**.
- `edgeHit`(도색지지)는 **이번에도 측정만**. 승격 금지(23회차 §7 결론 유지).

### 4-3. 게이트 판정은 여전히 **부정 결과를 허용**한다
23회차처럼 「효과 0 → 안 넣는 것도 결론」이 나오면 그대로 기록한다. 게이트를 살리려고 문턱을 참 쪽으로 밀지 않는다.

---

## 5. 답변 ⑤ — 스샷 계획 `reports/overlay_r24a/`

**같은 `frameHash` 에서 강등본 vs 이미지유래 나란히.** 파일명·이미지 헤더 양쪽에 `frameHash` 를 찍는다(23회차 규약 승계).

| 파일명 패턴 | 내용 | 장수 |
|---|---|---|
| `r24_degraded_{cam}_{preset}_{frameHash}.png` | 강등본 (23회차 재현 · 대조군) | 5 |
| `r24_vpdseg_{cam}_{preset}_{frameHash}.png` | VPD seg 유래 | 5 |
| `r24_lpd_{cam}_{preset}_{frameHash}.png` | LPD 유래 | 5 |
| `r24_rawmask_{cam}_{preset}_{frameHash}.png` | **원 마스크 + `bottomContour` 접지선**만 오버레이(기하 없음) | 5 |

- 렌더러는 `drawEngineOverlay`(`individualEngine.ts:296`) 재사용. 범례 4색(초록=정답 / 시안=매칭 / 빨강=비매칭 / 회색점선=탈락) 그대로.
- **`r24_rawmask_*` 가 이번 회차의 핵심 그림**이다. 예측 P-a/P-b(그림자 편의)를 **육안으로 직접 확인**하는 유일한 증거이며, 성적이 나쁠 때 「검출기 결손인가 / 기하 결손인가」를 가른다.

### 5-1. 스샷 육안 3문 (구현자가 반드시 답할 것)
1. `r24_rawmask_1_1_*` — 접지선이 타이어 접점에 붙는가, **그림자 아래끝**에 붙는가? 붙는 쪽이 아래면 편의 방향이 P-a 대로다.
2. `r24_vpdseg_2_2_*`(밀집 8대) — 강등본이 8/8 회수했던 그 프레임에서 **몇 개가 살아남는가**? 죽은 것은 **검출 미탐(마스크 없음)** 인가 **기하 어긋남(마스크 있는데 면이 빗나감)** 인가?
3. `r24_lpd_1_3_*` — LPD 가 2건 잡았다(가시면 2 = **유일하게 100% 검출된 프리셋**). 그 2건이 면으로 닫히는가?

---

## 6. 답변 ⑥ — 판정선 (원시 배정도 · `toFixed` 금지)

| # | 조건 | 문턱(원시 배정도) |
|---|---|---|
| **Q1** ★ | **VPD seg 소스** `scoreGated.precision ≥ 0.70` **AND** `scoreGated.recall > 0.5853658536585366` | Goal 그대로 |
| **Q2** | **rows 골든 무회귀** — recall `0.5853658536585366` · precision `0.8571428571428571` · meanIoU `0.8886003068644802` · minIoU `0.6130202566182261` · pass95 `8` · pass98 `1` · frameHash 5개 | diff **0** |
| **Q3** | **강등본 소스 비트 동일** — `--source degraded` 가 23회차와 동일: outputs `42` · faces `39` · recall `0.9512195121951219` · precision `0.9285714285714286` | 이식 무해성. 하나라도 다르면 **회귀** |
| **Q4** | **상한 정합** — VPD seg 재현율 ≤ `0.8780487804878049`, LPD 재현율 ≤ `0.8048780487804879` | 넘으면 **오라클 누출 의심** — 즉시 중단하고 원인 규명 |
| **Q5** | 오염 격리 봉인 — `faceSlot`/`presetId`/`visible`/`pos`/`rotY` 가 새 소스 경로에 **문자열로도 없다** | 정적 봉인 테스트 green |
| **Q6** | `npx tsc --noEmit` exit 0 · `npx vitest run` 전체 green(기준선 **295 파일 / 3750 테스트** + 신규분) | 실패·스킵 0 |
| **Q7** | 예측(§2-2) 대비 실측 기록 — 적중/상회/붕괴 중 어디인지 **명시**하고 §2-3 표의 「배우는 것」을 적는다 | 서술 판정 |

- **Q1 실패해도 회차는 실패가 아니다.** §2-3 이 각 결과의 학습을 미리 정의했다. **다만 실패를 감추거나 문턱을 사후에 낮추면 그건 실패다.**
- **LPD 소스는 판정선이 아니다**(부가 측정). 상한이 낮고 접지 유도가 prior 의존이라 이번 회차엔 계측만 한다.

---

## 7. 불변 제약 준수 방식

| 제약 | 준수 |
|---|---|
| 검출 소스 0줄 (`src/ground/*`·`src/rpc/services/*`·`web/*`) | **읽기(import)만**. `bottomContour` 재사용은 import 다. `git status --porcelain` 로 증명 |
| 신규는 `src/tools/` 만 | `src/tools/imageObservation.ts` 신규 · `src/tools/individualEngine.ts` 수정 |
| 오라클 검출 경로 금지 | `faceSlot`/`presetId`/`visible`/`pos`/`rotY` 를 새 소스가 **읽지 않는다**. 새 소스의 입력은 **JPEG 바이트 + `GroundModel` + 검출 응답 JSON 뿐**. §1-3 의 `SlotAxes` 배제가 바로 이 제약 때문이다 |
| `quadIoU` 재사용 | `autoRoiPlan.quadIoU` 만. 신규 IoU 0줄 |
| `toFixed` 판정 금지 | 판정 비교는 전부 원시 배정도. `toFixed` 는 SVG 좌표 렌더에만 |
| `roi.auto.apply` 금지 | 호출 0 |
| 정본·DB 쓰기 금지 | `PtzCamRoi.json`·`data/setting.sqlite`·`config/` 읽기만. 쓰기는 `reports/` 하위만 |
| **카메라 물리 이동 금지** | `camera_req_img`/`requestImage` **호출 0**. 골든 JPEG **파일**만 읽는다. 21회차 (a) 원천 회피 |
| 시뮬 튜닝값 → 실카 이전 금지 | 도출한 게이트 값은 `--minArea` 등 **CLI 인자**로만 존재. `config/`·정본에 **쓰지 않는다**. VPD seg 소스는 **계측 전용**(실카는 VPD 자동검출 금지 규약) |
| G1~G8 | 23회차 구조 그대로 — `proposeFromObservation` 미변경(반환 `BayProposal \| null`), `gateBay` 는 절대 문턱만, 면간 상호작용은 배타성뿐 |

---

## 8. ★ 구현자 실행 지시 (그대로 따를 것)

### 단계 0 — 검출 응답 캐시 채우기
`src/tools/imageObservation.ts` 에 캐시 채움 CLI 를 만들고 실행:
```
npx tsx src/tools/imageObservation.ts --fetch v1 --cache reports/detcache_r24
```
- `goldenTargets(GOLDEN_DIRS['v1'])`(`sepAudit.ts:405`)로 `t.jpg`/`t.frameHash` 확보 → `VpdClient.segment(t.jpg)` · `LpdClient.detect(t.jpg)` 호출 → `reports/detcache_r24/{frameHash}_seg.json` / `_lpd.json` 에 **원문 저장**.
- `ToolsConfig` 는 `config/tools.config.json` 을 그대로 로드(엔드포인트 하드코딩 금지).
- **검증**: 파일 10개 생성. 개수가 설계 §0-1 표(seg 8/10/1/8/9 · lpd 7/10/2/8/6)와 **일치**할 것. **불일치 시 즉시 보고하고 멈춰라** — 서버 상태가 바뀐 것이다.

### 단계 1 — `vpdSegSource` 구현
- 캐시 JSON → `masks[i]`(픽셀 정수 폴리곤) → `bottomContour(mask, stepPx=4)` (`src/ground/contact.ts:85` **재사용**).
- 접지 콘투어에서 **로버스트 하위대(카메라 쪽 아래 끝)** 를 뽑아 `footprintPx`(4점) 를 만든다.
  - **신규 코드는 이 밴드 선택뿐이며 20줄을 넘기지 마라.** 콘투어 x 범위의 좌/우 끝과 y 의 로버스트 분위수로 근변 2점을 잡고, 지면 역투영(`backprojectToGround`) 후 차량 prior 길이 `CAR_BODY.lengthM`(4.7m) 만큼 깊이축으로 밀어 원변 2점을 만든 뒤 다시 이미지로 투영한다.
  - **`SlotAxes` 를 만들지 마라. `fitContactLine`/`buildFootprint`/`buildFrameCuboids` 를 호출하지 마라**(§1-3 오라클 사유).
- 반환 `VehicleObservation`: `obsId = 'seg#'+vpdIdx` · `footprintPx` · `bboxPx`(seg rect 픽셀화) · `plateQuad=null` · `platePx=0`.
- **검증**: 5프레임 합 관측 수 = **36**(마스크 개수와 동일). 적으면 몇 건이 어느 단계(콘투어 실패/역투영 실패)에서 죽었는지 **개수와 사유를 표로** 남겨라.

### 단계 2 — `lpdPlateSource` 구현
- 캐시 `polygons[i]`(픽셀) → `t.W`/`t.H` 로 정규화 → `plateAxes`(`occupancyRegion.ts:92`) → `buildTrapezoid(axes, REGION_DEFAULTS.widthScaleMin, REGION_DEFAULTS)`(`:128`) → 픽셀 복원 → `footprintPx`.
- **`occupancyRegion` 의 수치를 고치지 마라.** `REGION_DEFAULTS` 그대로 쓴다.
- **검증**: 5프레임 합 관측 수 = **33**.

### 단계 3 — `--source` 배선 + 3소스 동시 실행
`individualEngine.ts` 의 `main()` 에 `--source degraded|vpdseg|lpd|all` 추가. `runEngine` 시그니처 **불변**.
```
npx tsx src/tools/individualEngine.ts v1 --source all --dist --out reports/overlay_r24a
```
- **검증(= Q3)**: `--source degraded` 산출이 outputs `42` · faces `39` · recall `0.9512195121951219` · precision `0.9285714285714286` 로 **비트 동일**. 다르면 배선이 기존 경로를 오염시킨 것 — **되돌려라**.

### 단계 4 — Phase 0 분포 → 게이트 도출 (소스별 독립)
`--dist` 로 소스별 참/잡음 분포를 낸다. 축: `footprintAreaPx`·`outOfFramePts`·`depthM`·**`confidence`(신규)**·`edgeHit`(측정만).
- 문턱 규칙은 23회차와 **동일**: 「참을 하나도 안 죽이는 최대값」. 사후 조정 금지.
- **검증**: 게이트 전/후 재현율 차이를 기록. 23회차처럼 **효과 0 이면 그대로 「효과 0」으로 적고 게이트를 안 넣는다.**

### 단계 5 — 스샷 (§5)
```
npx tsx src/tools/individualEngine.ts v1 --source all --out reports/overlay_r24a
```
20장(4패턴 × 5프리셋). **`r24_rawmask_*` 5장을 반드시 육안으로 보고 §5-1 의 3문에 답하라.**

### 단계 6 — 테스트
`test/imageObservation.test.ts` 신규. 최소 6개:
1. 캐시 JSON 고정 픽스처 → `vpdSegSource` 관측 수·`footprintPx` 4점 유효성
2. `lpdPlateSource` 가 `REGION_DEFAULTS` 를 안 바꾸는지(참조 동일성)
3. **정적 봉인** — `imageObservation.ts` 소스 문자열에 `faceSlot`·`presetId`·`visible`·`rotY` **부재**
4. 정적 봉인 — `fitContactLine`·`buildFootprint`·`buildFrameCuboids`·`SlotAxes` **부재**(§1-3 결정을 코드로 고정)
5. 강등본 소스 회귀(Q3 수치 하드코딩)
6. 23회차 G1~G8 정적 봉인 7토큰 유지
- **검증(= Q6)**: `npx tsc --noEmit` exit 0 · `npx vitest run` 전체 green.

### 단계 7 — 보고서
`_workspace/22_developer_observation_source_round24.md` 에 기록. **반드시 포함**:
- Q1~Q7 판정 표 (**원시 배정도** · `toFixed` 금지)
- **§2-2 예측 vs 실측 대조** — 어느 칸에 떨어졌는지 명시하고 §2-3 의 「배우는 것」을 적어라
- **미회수 면의 원인 분해**: 「검출 미탐(마스크·판이 아예 없다)」 몇 면 / 「기하 결손(관측은 있는데 면이 빗나갔다)」 몇 면. ★ **이 분해가 24회차의 실제 산출물이다** — 25회차가 검출기를 볼지 기하를 볼지를 이 숫자가 정한다
- §5-1 육안 3문 답변
- 미측정 항목 정직 기록

---

## 9. 미해결 · 가정 (리더 확인 요청)

| # | 항목 | 상태 |
|---|---|---|
| 1 | 골든 프레임은 **d0**(`frame_*_d0.jpg`)만 쓴다. d1~d5 는 미사용(23회차와 동일 조건 유지) | 가정 |
| 2 | `SlotAxes` 비-오라클 부트스트랩 불가 → `contact.ts` 로버스트 적합(하위 분위수·frontBand·frontSpan) **미사용** | **자각한 손실.** §2-3 붕괴 분기의 원인 후보 1순위 |
| 3 | 차량 치수 단일 가정 `4.7×1.85×1.45m` 유지 | 가정(23회차 승계) |
| 4 | 검출 서버(`192.168.0.125`)가 회차 도중 응답을 바꾸면 캐시와 어긋난다 | **캐시가 정본**. 단계 0 개수 불일치 시 중단 규약(§8) |
| 5 | VPD seg 는 **계측 전용** — 실카 셋업 경로 배선 금지(auto-memory `vpd-auto-detect-forbidden`) | 확정 |
| 6 | 23회차 σ 5시드 평균 재측정 | **미측정 유지** — 24회차 범위 밖 |
| 7 | `VehicleObservation.source` 리터럴 유니온 확장 1줄이 `carAnchorUpper.ts` 수정에 해당 | 23회차 `export` 추가와 같은 성격(로직 0줄). **3중 증거로 무해성 재증명 필요** |
