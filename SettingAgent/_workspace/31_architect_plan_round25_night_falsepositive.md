# 25회차 설계 — 야간 실카 오검출 0 · 전경 역전 해소 · 최소 크기 하한

- 작성: 2026-07-31 / 설계자 · 워크트리 `round22-rows-threshold`
- 선행: `_workspace/21_architect_plan_round24_observation_source.md` · `_workspace/22_developer_observation_source_round24.md` · `_workspace/11_·12_`(23회차) · `docs/20260730_221143_22회차_인계서_다음세션용.md` §4
- **이 문서의 코드 사실은 전부 이번 설계 중 실제로 읽은 `파일:줄` 이다. 확인 못 한 것은 「미측정」·「부재」로 적었다.**

---

## 0. 결론 먼저 (4줄)

1. **마스터 스샷 7장은 재현 불가**다. `dfb43e65fd12` 외 6개 해시가 워크트리·본체 전역 파일명·파일내용에서 **0건**. 원본 JPEG 은 디스크에 없다.
2. **그러나 야간 실카 프레임은 이미 6장 디스크에 있다.** `test/fixtures/realCamDaylight/frame_20260729_2025~2034` (일몰 후 KST 20:25~20:34). 22회차 §2-4 의 「야간 0장」은 **그 시점 기준이고 지금은 참이 아니다.** 25회차의 야간 자산은 이것이다.
3. **오검출·전경 역전의 원인은 이미 코드에서 후보가 좁혀진다** — `refScore` 후보 의존(`bayGrid.ts:687-695`), `paint.score` 칸당 평균(`bayGeometry.ts:697-699`), **그리고 신규 발견: `paintTolPx=6` 픽셀 고정 허용오차**(`floorPaint.ts:158`)가 **거리에 따라 지상 관용도를 수십 배 바꾼다**. 마지막 항이 「전경 역전」의 1순위 용의자다.
4. **서비스 경로는 이번 회차에 건드린다.** 단 **기본 OFF 플래그 1개**만. 골든 무회귀는 「기본값 미오버라이드」로 **구조적으로** 보장한다(21회차 `rowExtentMode` 보존 규약과 동일 패턴).

---

## 1. 답변 ① — 스샷을 재현 가능한 자산으로 만들 수 있는가

### 1-1. 마스터 스샷 7장 — **원본 프레임 부재. 재현 불가.**

| 확인 | 결과 |
|---|---|
| 해시 7개(`dfb43e65fd12` `9e11abe06407` `c7f6018058a0` `24f2d7f77704` `7e5858301464` `1c0012045379` `9a62084dfa5e`) 전역 검색 | 워크트리 + 본체 `SettingAgent/`(node_modules·.git 제외) 파일명·파일내용 **0건** |
| 뷰어 「도색선 자동검출」이 프레임을 디스크에 남기는가 | **남기지 않는다.** `src/rpc/services/roiAuto.ts` 전체에 `writeFileSync`/`mkdirSync` **0건**. 버튼이 잡은 JPEG 은 메모리에만 존재 |

→ **그 7개 frameHash 로는 어떤 전/후 대조도 할 수 없다.** 마스터 스샷 PNG 는 **육안 증거로만** 쓰고 **수치 판정에 쓰지 않는다**(F13: 프레임해시 없는 IoU 무효).

### 1-2. 무이동 캡처 — **가능하다. 단 「현재 뷰 1장」뿐.**

| 사실 | 근거 |
|---|---|
| `RealPtzSource.snapshot()` 은 `mode==='manual' && ptz` 일 때만 `move()` 를 부른다 | `src/viewer/RealPtzSource.ts:232-237` |
| `mode==='preset'` 이면 장비 호출 0 — `getJpeg()` + PTZ 조회뿐 | 같은 곳. `HucomsClient.getJpeg()` = `GET /cgi-bin/image/jpeg.cgi` (`src/clients/hucoms/HucomsClient.ts:580-588`) |
| 서비스 정본도 실카엔 항상 ptz 미전달 | `src/rpc/services/roiAuto.ts:704` — `fs.kind === 'hucoms' ? undefined : t.ptz ?? undefined` |
| ★ 함정 A | `CameraSourceClient.ts:43` 은 `ptz` 가 **객체이기만 하면** truthy → 필드가 전부 undefined 여도 `{pan:0,tilt:0,zoom:1}` **원점 이동**. 인자를 아예 넘기지 마라 |
| ★ 함정 B | `realCamCapture.ts:286-298` 은 `mode=manual&현재좌표` 라 **좌표가 같아도 `goptzfpos` 를 발사**한다. 헤더 주석(6-10행)의 「이동 명령 없음」은 **코드와 불일치**. 25회차는 이 도구의 캡처 경로를 쓰지 않는다 |
| ★ 함정 C | `RealPtzSource.listCameras()` 는 실카 프리셋을 `[{presetIdx:1, label:'현재 위치'}]` **1개로 합성**한다(`RealPtzSource.ts:219-224`). 이 워크트리에서 EV1/EV3/EV4/EV5 로 **가는 경로 자체가 없다** |

→ **EV1/EV3/EV4/EV5 네 프리셋 뷰는 이번 회차에 재취득 불가**다. 취득하려면 물리 이동이 필요하고 그것은 **불변 제약 위반**이다. (main 최신 커밋 `a289817`/`9946e56` 에 휴컴스 프리셋 이동이 들어왔으나, 그건 **이동**이므로 어차피 금지다.)

### 1-3. ★ 차선 — 실제로 쓸 야간 자산 (이것이 25회차의 입력이다)

| 자산 | 경로 | 장수 | 성격 |
|---|---|---|---|
| **A. 야간 실카 6장** | `test/fixtures/realCamDaylight/frame_20260729_202543 / _202654 / _202835 / _202939 / _203100 / _203442 .jpg` | **6** | 해시 `0a737d6776d8` `562ff727e6e2` `824431bc3e6d` `27a8021dfe60` `87675f5a77ab` `ac161eaa5445`. `manifest.json:3` = 「뷰어 프록시 · **real-camera-2**(cam 1)」 |
| **B. 무이동 현재뷰 1장(신규 취득)** | `reports/r25_frames/frame_<hash>.jpg` + `.ptz.json` | 1~3 | `emptyBayProbe.ts:103-108` 의 저장 규약 재사용. 지금 야간이므로 **야간 real-camera-1 을 얻을 유일한 합법 경로** |
| **C. 시뮬 골든 v1 5장** | `test/fixtures/roiAutoGolden` | 5 | 회귀 기준선. 해시 `6006a034bfe2` `ceaaed722663` `3c0db12efe75` `e33628e921c2` `0cf4fda4d3aa` |

**정직 고지 3건**
- A 는 **real-camera-2** 다. 마스터 스샷은 **real-camera-1**. **다른 카메라·다른 장면**이다. 「EV3 전량 오검출」을 A 로 재현할 수 있다고 주장하지 마라. A 는 「야간 실카에서 오검출이 어떻게 생기는가」를 재는 자산이지, 마스터가 본 그 화면이 아니다.
- B 는 카메라가 **지금 향하고 있는 방향** 뿐이다. 어느 방향인지 사전에 알 수 없다. 주차면이 안 보이면 그 사실을 그대로 적고 A 로 간다.
- 시뮬 원경 뷰(`1c0012045379`)도 골든에 **부재**. 「전경 역전」은 그 프레임으로 재현 불가 → **§3 의 거리-편향 측정으로 대리**한다(같은 성분을 골든 5장 + 야간 6장에서 잰다).

---

## 2. 답변 ② — 오검출을 가설이 아니라 측정으로 가른다

### 2-1. 현행 서비스 경로 (실측 지도)

```
roi.auto.detect → roiAuto.ts:1182 → detectOne roiAuto.ts:856-976
  ├ 도색선/분리선/코너   roiAuto.ts:944-954  (전방선 후보 상한 frontCandidates=8  floorPaint.ts:156)
  └ detectBaysWithModel  roiAuto.ts:955 → bayGrid.ts:647
       ├ 후보마다 fitRowGrid            bayGrid.ts:665
       │   └ fitRowGridOnce             bayGrid.ts:272-512
       │        칸 필터  near ≥ extendMinNearSupport 0.35   bayGrid.ts:345
       │        행 게이트 near < minNearSupport 0.5 → 탈락   bayGrid.ts:402
       │        점수  baseScore = paint.score + 0.?*phaseTerm + 0.?*aimTerm   bayGrid.ts:457
       │              effective = baseScore * coverage^coverageExponent        bayGrid.ts:458
       ├ refScore = (baseScore argmax 후보의 paint.score)   bayGrid.ts:687-695
       ├ rows = dedupe 후 paint.score ≥ refScore*0.94 AND near ≥ 0.69         bayGrid.ts:696-699
       └ best = effectiveScore argmax → 지상고 자가보정 → 근변선 재적합        bayGrid.ts:712-780
```

**면적·크기 필터는 서비스 경로에 존재하지 않는다.** 있는 것은 퇴화 컷(`groundGrid.ts:143`, `|area2| < 1e-9`)과 발산 방어(`maxRowSpanM 200` `bayGeometry.ts:225`, `maxRowCells 60` `:226`)뿐. `MIN_AREA_PX = 200` 은 **도구 전용**(`src/tools/roiAutoRecall.ts:79`)이라 서비스가 안 쓴다. → **하한을 넣을 자리가 비어 있다**(§4).

### 2-2. 오검출 원인 후보와 **가르는 측정**

「잔디·보도·나무 위에 면이 선다」의 후보를 전부 나열하고, **각각을 어떤 관측량이 가르는지** 못 박는다. 전부 **읽기 전용 진단 덤프 1회**로 동시에 갈린다.

| # | 후보 | 기전(코드 근거) | **가르는 측정량** | **후보가 참일 때의 서명** |
|---|---|---|---|---|
| **H1** | `refScore` 후보 오염 | `bayGrid.ts:687-695` — 기준선이 `baseScore` argmax 후보의 `paint.score`. 잔디/보도 경계가 최고점을 잡으면 문턱이 통째로 이동 | 후보별 `(rank, baseScore, paint.score, near, medianDepthM)` 전수 덤프. **refScore 를 잡은 후보의 근변선을 오버레이에 굵게 그린다** | refScore 보유 후보의 근변선이 **잔디/보도 경계 위**. 22회차 EV1 「스타리아 지붕 몰딩선」과 동형 |
| **H2** | `paint.score` 칸당 평균 | `bayGeometry.ts:697-699` `near/k` — 분모가 칸 수. `supportSamples=21` 고정(`floorPaint.ts:157`)이라 짧은 칸이 유리. 코드 주석이 실측 사례를 이미 기록(`bayGrid.ts:408-423`) | 행별 `(quads.length, median 칸 픽셀길이, paint.near, paint.score)` | 오검출 행이 **칸 수는 적고 칸당 near 는 높다** |
| **H3 ★신규** | **`paintTolPx=6` 픽셀 고정** | `floorPaint.ts:158`. 허용오차가 **화면 픽셀 고정**이라, 지상 환산 관용도가 **거리에 비례해 커진다**. 원경·지평선 근처에서는 6px 가 지상 수십 cm~m → **아무 직선이나 도색으로 통과** | 행별 `paintTolPx` 의 **지상 환산치**(면 중심 깊이에서 1px 가 몇 m 인가 × 6) | 오검출 행의 지상환산 관용도가 정답 행의 **수 배**. 잔디/보도/나무 경계는 원경에 몰려 있다 |
| **H4** | `coverage` 포화 | `bayGrid.ts:432-435` + `roiAuto.ts:936` — `expectedBays>=1` 이면 분모가 `min(expectedBays, inFrameCells)`. `expectedBays` 는 `roiAuto.ts:929` 에서 **정본 4점 슬롯 수**로 채워진다 | 프레임별 `expectedBays` 실값 · 행별 `quads.length`·`coverage` | **마스터 스샷 4프레임 중 3개가 정확히 4면**(EV1 4 · 시뮬1:1 4 · 시뮬1:2 4). `expectedBays==4` 이고 `coverage==1` 이면 **강한 정황** |
| **H5** | 야간 노출/대비 | `floorPaint.ts` 의 도색 판정이 절대 밝기인지 상대인지 — **미측정(설계 중 미확인)** | 같은 장면 주간 5장 vs 야간 6장의 `detectPaintLines` 후보 수·점수 분포 | 야간에 후보 수가 늘거나 점수 분포가 뭉개짐 |
| **H6** | 자가보정 역효과 | `bayGrid.ts:730-737` 지상고 1회 자가보정. 22회차 EV4 IoU −23.7% 전례 | `calibration` 필드 전/후 IoU·면적 | 보정 후 면적이 급팽창(EV4 「거대 사각형」과 정합) |

**측정 도구는 1개다.** 신규 `src/tools/gridDiag.ts`(계측 전용, `src/ground/*` 무접촉) — JPEG + `.ptz.json` 을 받아 `detectBaysWithModel` 을 호출하고 **`GridDetection.tried` / `rows` / `best` 를 전부 JSON 으로 덤프** + 오버레이 PNG. 서비스 응답이 버리는 필드(`baseScore`/`coverage`/`effCells`/`denomCells`/`medianDepthM`/`calibration` — `bayGrid.ts:173-207` 에 있으나 `roiAuto.ts:983-1011` 이 안 싣는다)가 **이번 회차의 관측량 전부**다.

> **재발명 금지 확인 의무**: `src/tools/emptyBayProbe.ts`(실카 단계별 생존 추적) · `src/tools/realFrameOverlay.ts` · `src/tools/sepAudit.ts:508-537`(프레임 캐시 + `.ptz.json`) 가 이미 유사 작업을 한다. **구현 전에 이 3개를 읽고, 확장으로 될 일이면 신규 파일을 만들지 마라.** 신규가 필요하면 그 사유를 보고서에 한 줄 적어라.

### 2-3. 이미 확정된 것 — 다시 세우지 마라

- 22회차 §2-4: 「근변 무도색은 **구조**」·「근변은 **행별 성질**」 → **확정.** 「근변에 도색이 없어서 못 잡았다」를 새 가설로 올리지 마라.
- 22회차 §4 (C): **실카 정밀도는 하한**이다. 실카 정답 라벨이 「보이는 모든 면」이 아니다. → **실카에서 정밀도 숫자를 절대 판정선으로 쓰지 마라.** 실카 판정은 **육안 라벨**(§6 Q1)로 한다.
- 22회차 §4 (D): IoU 0 을 「엉뚱하게 그렸다」로 읽지 마라.

---

## 3. 답변 ③ — 전경 역전은 H2 와 같은 성분인가

### 3-1. 분해 — 두 성분은 **다르다**

| 성분 | 위치 | 「짧아지면 이득」의 경로 |
|---|---|---|
| **H2 (22회차 (B))** | `bayGeometry.ts:697-699` | **분모**. 칸을 쪼개면 `k` 가 늘고 평균이 오른다. 커버리지 곱이 유일한 방어 |
| **H3 (신규)** | `floorPaint.ts:158` `paintTolPx=6` | **분자**. 원경일수록 6px 의 지상 관용도가 커져 `hitRatio`(=`floorPaint.ts:921-952`)가 후해진다. **칸 수와 무관** |

둘 다 「원경 유리」로 나타나지만 **분모/분자로 갈린다.** 「전경 역전」(원경 7면 · 전경 0면)은 칸 수 차이 없이도 성립하므로 **H3 가 1순위**다.

### 3-2. 가르는 측정 — 한 프레임 안에서 깊이만 다른 두 행 비교

골든 5장 + 야간 6장 전부에서 행 후보를 전수 덤프하고 다음 표를 만든다.

| 행별 기록 | 산출 |
|---|---|
| `medianDepthM` | `GridResult.medianDepthM` (`bayGrid.ts:173-207`) |
| `mPerPx@행중심` | 면 중심에서 1px 의 지상 길이. `backprojectToGround` 로 (x, y)와 (x+1, y) 를 역투영해 차분 |
| **`tolM = 6 × mPerPx`** | ★ H3 의 직접 관측량 |
| `paint.near` · `paint.score` · `quads.length` · `median 칸 픽셀길이` | H2 의 관측량 |

**판정 규칙(사전 확정)**
- `paint.near` 를 `medianDepthM` 에 회귀했을 때 **양의 기울기**가 나오고, `quads.length` 를 통제해도 남으면 → **H3 확정**(거리 편향은 분자에서 온다).
- `quads.length` 로 설명이 다 되면 → **H2 와 같은 성분**.
- 둘 다 아니면 → 원인은 행 선택(`refScore` 문턱)이고 **H1** 로 간다.

### 3-3. 후보 진입 컷도 같이 잰다 (22회차 병목 ③)

전경 도색선이 **`frontCandidates=8`**(`floorPaint.ts:156`) 밖으로 밀렸을 가능성. 22회차 EV5 가 정답 근변선 **rank #11** 이었다.
→ 덤프에 **후보 rank 를 반드시 포함**한다. 전경 행이 rank 9 이상이면 원인은 점수식이 아니라 **진입 컷**이다. 이 경우 25회차는 **`frontCandidates` 를 늘리지 말고**(비용·잡음 증가) 사실만 기록한다 — 원인 규명이 이번 회차 산출이다.

---

## 4. 답변 ④ — 최소 크기 하한의 축을 실측으로 정한다

### 4-1. 세 축의 사전 판정 (값이 아니라 **축 선택**의 논리)

| 축 | 「자투리」를 죽이는가 | **「먼 진짜 면」을 죽이는가** | 판정 |
|---|---|---|---|
| **픽셀 면적** (px²) | 죽인다 | ★ **죽인다.** 원경 진짜 면은 픽셀로 작다 | **단독 사용 금지** |
| **화면 점유율** (면적/WH) | 죽인다 | ★ 죽인다(픽셀 면적의 정규화일 뿐) | **단독 사용 금지** |
| **지상 면적** (m²) | ? | **안 죽인다** — 진짜 면은 거리와 무관하게 `slotWidthM × slotDepthM` 근방 | **1순위 축** |

**단, 지상 면적에는 함정이 있다.** 격자는 `buildAtPhase`(`bayGrid.ts:219-247`)가 `slotWidthM`/`slotDepthM` 로 만드므로 **정의상 거의 상수**일 수 있다 → 하한이 무력할 수 있다. 그렇다면 실제로 걸러야 할 것은 **하한이 아니라 상한**이다.

### 4-2. ★ 마스터 지시의 재해석 — 「너무 작은 것」과 「과대 면」은 같은 병의 양끝

| 마스터가 본 것 | 크기 | 축 |
|---|---|---|
| EV5 좌측 「자투리」 · 원경 미검 | **작다** | 하한 |
| EV1 좌하단 큰 사각형(SUV 앞 공터) · **EV4 하단 거대 사각형(다른 면의 몇 배)** | **크다** | **상한** |

두 개를 하나의 축으로 다룬다: **`cellAreaRatio = 면의 지상 면적 / (slotWidthM × slotDepthM)`**. 진짜 면은 1 근방. 자투리는 ≪1, 과대 면은 ≫1. 이 비율이 **거리에 불변**이므로 §4-1 의 함정(원경 진짜 면 살해)을 원리적으로 피한다.

**과대 면의 기전**(가설, 측정으로 확인): 역투영은 지평선에 가까울수록 발산한다. 깊이 추정이 무너진 행은 지상 면적이 폭발한다. 그러므로 `cellAreaRatio` 상한은 **깊이 붕괴 탐지기**이기도 하다. `medianDepthM` 과 상관을 같이 잰다.

### 4-3. 값 도출 규칙 (사전 확정 · 사후 조정 금지)

23·24회차 규칙 승계: **「참을 하나도 안 죽이는 최대(하한) / 최소(상한)」**.
- 참 라벨: **시뮬 골든 41 가시면**(기존 truth) + **야간 실카는 육안 라벨**(면별로 「주차면/비주차면」 2치. 라벨링 근거 스샷을 남긴다).
- 분포를 뽑기 전에 값을 적지 마라. **이 문서에 숫자를 쓰지 않은 것은 의도다.**
- 도출한 값은 **CLI 인자로만** 존재한다. `config/`·정본에 쓰지 않는다(시뮬→실카 이전 금지).

---

## 5. 답변 ⑤ — ★ 배선 범위 판정

### 5-1. 판정: **건드린다. 단 「기본 OFF 플래그 1개」로 한정.**

**근거(찬성)**
- 마스터는 **제품 화면**(뷰어 「도색선 자동검출」)을 보고 지시했다. `src/tools/` 안에서만 도는 계측은 그 화면을 1픽셀도 바꾸지 못한다. 23·24회차가 연속 2회 `src/ground/*` 0줄이었고, **화면은 그대로다**.
- 계측만 반복하면 원인을 알고도 못 고치는 상태가 3회차째 이어진다.

**근거(제약)**
- 24회차는 설계자 예측 4개 중 **4개 다 빗나갔다**(F2·F3·F4·F5). **원인 미확정 상태의 배선은 도박이다.**
- 골든 rows 6지표는 23·24회차 연속 비트 동일이다. 이 무회귀가 유일한 신뢰 기반이다.

**→ 절충: 2단 게이트.** R25-A(계측)가 원인을 **단일 축으로** 확정했을 때에만 R25-B(배선)로 넘어간다. 확정 못 하면 **배선하지 않고 그대로 보고한다**(부정 결과 허용).

### 5-2. 골든 무회귀를 **구조적으로** 보장하는 방법 (21회차 `rowExtentMode` 규약과 동형)

`rowExtentMode` 의 선례가 정확한 본보기다:
- 필드 선언 `bayGeometry.ts:178` → 기본값 `DEFAULT_BAY_OPTS` `bayGeometry.ts:252` (`'evidence'`)
- 서비스는 `roiAuto.ts:956-962` 에서 **5개만 오버라이드**(`slotWidthM`/`slotDepthM`/`cameraHeightM`/`expectedBays`/`coverageDenom`) → `rowExtentMode` 를 **건드리지 않는다**
- 와이어 스키마 `BaseSchema` `roiAuto.ts:57-81` 에도 **없다**
→ 결과: 필드가 존재해도 **서비스 동작이 바뀌지 않는다.**

**25회차 플래그도 정확히 같은 4지점 규약을 따른다.**

| 지점 | 25회차 조치 |
|---|---|
| ① `BayDetectOpts` (`bayGeometry.ts:50-202`) | `cellAreaRatioMin?: number` · `cellAreaRatioMax?: number` **2필드 추가** (선택 필드) |
| ② `DEFAULT_BAY_OPTS` (`bayGeometry.ts:204-264`) | **무력값** — `Min: 0` · `Max: Infinity`. 이 값이면 필터가 **아무것도 안 거른다** |
| ③ 적용 지점 | `bayGrid.ts:344-346` 의 칸 필터 **한 줄 옆**. `kept` 계산에 `&& ratioOk(q)` 만 추가. 점수식(`:457-458`)·`refScore`(`:687-695`)·`rows` 문턱(`:696-699`) **무수정** |
| ④ 서비스 전달 `roiAuto.ts:956-962` | **오버라이드 추가 금지.** `BaseSchema`(`roiAuto.ts:57-81`) 에도 **노출 금지** |

**이 규약의 귀결**: 기본 경로에서 `Min=0`·`Max=Infinity` 이므로 `ratioOk` 는 항상 true → **골든 rows 는 비트 동일일 수밖에 없다.** 무회귀가 「측정 결과」가 아니라 **구조적 보장**이 된다.

### 5-3. 그러면 마스터 화면은 언제 좋아지는가 — 승격 조건을 지금 못 박는다

플래그가 기본 OFF 면 화면은 안 바뀐다. 정직하게 적는다. **기본값 승격의 판정선을 25회차에 미리 확정한다:**

> **승격 조건 (26회차에 기본값을 바꿔도 되는가)**
> `Min`/`Max` 를 §4-3 으로 도출한 값으로 **ON 한 상태에서**,
> (a) 야간 실카 육안 오검출이 **감소**하고 **정답 면이 0개도 안 죽고**,
> (b) **골든 rows 6지표가 여전히 비트 동일**(recall `0.5853658536585366` · recallDetectable `0.8571428571428571` · precision `0.8571428571428571` · meanIoU `0.8886003068644802` · minIoU `0.6130202566182261` · pass95 `8` · pass98 `1`)
> 두 조건을 **동시에** 만족할 때에만 26회차에 기본값 승격을 제안한다. (b)가 깨지면 **그 값은 시뮬 튜닝값이므로 실카로 옮기지 않는다**(22회차 (G)).

---

## 6. 답변 ⑥ — 판정선 (원시 배정도 · `toFixed` 판정 금지)

| # | 조건 | 문턱 | 성격 |
|---|---|---|---|
| **Q1** ★ | **야간 실카 육안 판정** — 자산 A 6장(+B) 에서 산출 면을 「주차면/비주차면(잔디·보도·나무)/과대」 3치로 라벨하고 **표로 기록**. 플래그 ON 에서 **비주차면+과대 = 0** | 서술 판정 + 개수 | 마스터 Goal ① |
| **Q2** ★ | **거리 편향 확정** — `paint.near` vs `medianDepthM` 회귀 기울기와 `quads.length` 통제 후 잔차. **H2/H3/H1 중 하나로 귀착**시켜 근거와 함께 적어라 | 서술 판정(수치 필수) | Goal ②·설계 §3 |
| **Q3** | **원인 후보 6개(H1~H6) 전부에 판정** — 참/거짓/미측정. 「미측정」은 사유 필수 | 6행 표 | §2-2 |
| **Q4** | **하한/상한 축 확정** — `cellAreaRatio` 분포를 참/오검출 라벨로 나눠 제시. **분리 가능/불가**를 명시. 분리 불가면 「불가」로 적고 플래그를 넣지 마라 | 분포 + 판정 | Goal ③·§4 |
| **Q5** ★ | **골든 rows 무회귀 (플래그 OFF)** — `npx tsx src/tools/roiAutoRecall.ts v1 evidence rows --raw` 산출이 24회차와 `diff` **0줄** | diff 0 | 절대 조건 |
| **Q6** ★ | **골든 rows 무회귀 (플래그 ON, 도출값)** — 같은 명령에 플래그 ON. **결과를 그대로 기록**. 비트 동일이면 §5-3 승격 조건 (b) 충족, 아니면 「불충족」으로 적어라 | diff 줄 수 기록 | 승격 판단 근거 |
| **Q7** | **정적 봉인** — 새 코드에 `faceSlot`/`presetId`/`visible`/`pos.`/`rotY`/`t.vis` **부재**. `roi.auto.apply` 호출 **0**. `PtzCamRoi.json`·`data/setting.sqlite`·`config/` 쓰기 **0** | 테스트 green | 불변 제약 |
| **Q8** | **무이동 증명** — `CameraSourceClient.requestImage` 에 **ptz 인자 미전달**(§1-2 함정 A). `mode=manual` 경로·`realCamCapture` 캡처 경로 **미사용**. `goptzfpos` 호출 0 | 코드 직독 + 로그 | 카메라 물리 이동 금지 |
| **Q9** | `npx tsc --noEmit` exit 0 · `npx vitest run` 전체 green (기준선 **296 파일 / 3757 테스트** + 신규분) | 실패·스킵 0 | |

- **Q1·Q2 가 이 회차의 산출물이다.** Q4 가 「분리 불가」로 나와도 회차는 실패가 아니다. **다만 문턱을 사후에 낮추거나 실패를 감추면 그것이 실패다.**
- **실카 정밀도 수치를 판정선에 넣지 않았다** — 22회차 (C)(실카 정밀도는 하한). 실카는 **육안 라벨**로만 판정한다.

---

## 7. 스샷 계획 — `reports/overlay_r25a/`

**같은 frameHash 로 전/후.** 파일명과 이미지 헤더 양쪽에 frameHash 를 찍는다(23회차 규약 승계).

| 파일명 패턴 | 내용 | 장수 |
|---|---|---|
| `r25_base_{tag}_{frameHash}.png` | 현행 서비스 산출(플래그 OFF) — **대조군** | 12 (야간 6 + 골든 5 + 현재뷰 1) |
| `r25_diag_{tag}_{frameHash}.png` | ★ **핵심 그림** — 전방선 후보 전부를 rank 라벨과 함께 그리고, **`refScore` 를 잡은 후보를 굵게**. 행별 `paint.near`/`medianDepthM`/`tolM` 를 캡션에 | 12 |
| `r25_on_{tag}_{frameHash}.png` | 플래그 ON 산출 (§5-2, Q4 가 「분리 가능」일 때만) | 12 |
| `r25_label_{tag}_{frameHash}.png` | 야간 실카 육안 라벨(주차면/비주차면/과대 3색) | 6~7 |

**육안 3문 (구현자가 반드시 답할 것)**
1. `r25_diag_*` 야간 실카 — **`refScore` 를 잡은 후보의 근변선이 어디에 있는가?** 도색선 위인가, 잔디·보도·연석 경계 위인가? (H1 직접 판정)
2. `r25_diag_*` 골든 중 행이 2개 이상인 프레임 — **원경 행의 `tolM` 이 전경 행의 몇 배인가?** 그 배수만큼 `paint.near` 가 벌어지는가? (H3 직접 판정)
3. `r25_base_*` 야간 실카 — **과대 면이 나오는가?** 나온다면 그 행의 `medianDepthM` 과 `calibration` 필드는? (H6 직접 판정)

---

## 8. 불변 제약 준수 방식

| 제약 | 준수 방법 |
|---|---|
| G1~G8 | 점수식(`bayGrid.ts:457-458`)·`refScore`(`:687-695`)·`rows` 문턱(`:696-699`) **무수정**. 추가는 절대 문턱 필터 1개뿐(면간 상호작용 없음) |
| 오라클 검출 경로 금지 | `faceSlot`/`presetId`/`visible`/`pos`/`rotY` 를 계측·필터 코드가 **읽지 않는다**. 육안 라벨은 **사람이 스샷을 보고** 만든다(코드 입력 아님) |
| `quadIoU` 재사용 | `autoRoiPlan.quadIoU` 만. 신규 IoU 0줄 |
| `toFixed` 판정 금지 | 판정 비교 전부 원시 배정도. `toFixed` 는 SVG/캡션 렌더에만 |
| `roi.auto.apply` 금지 | 호출 0 (정적 검사) |
| 정본·DB 쓰기 금지 | `PtzCamRoi.json`·`data/setting.sqlite`·`config/` **읽기만**. 쓰기는 `reports/` 하위만 |
| **카메라 물리 이동 금지** | §1-2 함정 A·B·C 회피. `requestImage(cam, preset)` 를 **ptz 인자 없이**. `mode=manual` 경로·`realCamCapture` 캡처 금지. EV 프리셋 이동 **시도 금지** |
| 시뮬 튜닝값 → 실카 이전 금지 | 도출값은 **CLI 인자로만**. 기본값 승격은 §5-3 조건 (b) 충족 시 **26회차 제안**으로만 |
| 「살아났다」 금지 | 오검출 감소를 성립 근거로 쓰지 마라. **정답 면이 0개도 안 죽었음**을 같이 보여야 성립 |
| 미추적 파일 `git diff` 무용 | 3중 증거 — ① `git status --porcelain -- src/ground src/rpc/services web` ② 코드 직독 ③ 산출 재현 |

---

## 9. ★ 구현자 실행 지시 (그대로 따를 것)

### 단계 0 — 자산 확보 (배선 0줄)
1. 자산 A 6장 존재 확인: `test/fixtures/realCamDaylight/frame_20260729_202543|_202654|_202835|_202939|_203100|_203442.jpg` + `manifest.json`.
   - **검증**: 각 JPEG 의 `sha256` 앞 12자가 `0a737d6776d8` `562ff727e6e2` `824431bc3e6d` `27a8021dfe60` `87675f5a77ab` `ac161eaa5445` 와 일치. 해시 함수는 `roiAuto.ts:724` 와 **같은 식**(`createHash('sha256').update(jpg).digest('hex').slice(0,12)`).
   - **불일치 시 즉시 보고하고 멈춰라.** 파일이 바뀐 것이다.
   - 각 프레임에 `.ptz.json` 이 있는지 확인. **없으면 「부재」로 적고**, PTZ 없이 `GroundModel` 을 만들 수 있는지 코드로 확인해 보고하라(없으면 자산 A 는 계측 불가 → 자산 B 로만 간다).
2. 자산 B 취득: **무이동 현재뷰**. `emptyBayProbe.ts:98` 의 `requestImage(1, 1)` 형태를 그대로 따른다(**ptz 인자 미전달**). 저장은 `emptyBayProbe.ts:103-108` 규약으로 `reports/r25_frames/frame_<hash>.jpg` + `.jpg.ptz.json`.
   - **검증(= Q8)**: 호출 전후로 `getPtzfPosition` 값이 **불변**임을 로그로 남겨라. `goptzfpos` 가 나가면 **즉시 중단**.
   - 카메라가 주차면을 안 보고 있으면 **그대로 적고** 자산 A 로만 진행한다. **이동해서 맞추지 마라.**

### 단계 1 — 진단 덤프 도구 (`src/ground/*` 0줄)
1. **먼저 `src/tools/emptyBayProbe.ts` · `realFrameOverlay.ts` · `sepAudit.ts:508-537` 를 읽어라.** 확장으로 되면 신규 파일을 만들지 마라. 신규가 필요하면 사유 1줄을 보고서에.
2. JPEG + `.ptz.json` → `detectBaysWithModel` 호출 → **`GridDetection` 전체를 JSON 덤프**. 반드시 포함:
   - 후보별: `rank`, `baseScore`, `paint.score`, `paint.near`, `paint.side`, `paint.far`, `coverage`, `effCells`, `denomCells`, `medianDepthM`, `quads.length`, `extentEndedBy`, `calibration`, `modelUsed`
   - **`refScore` 값과 그것을 잡은 후보의 rank** (`bayGrid.ts:687-695`)
   - **`rows` 문턱 실값** = `refScore * opts.rowMinScoreRatio` 와 각 후보의 통과/탈락
   - 프레임별 `expectedBays` 실값 · `coverageDenom` 실값 (`roiAuto.ts:929,936`)
   - 면별: 픽셀 면적 · **지상 면적** · **`cellAreaRatio`** · 면 중심 `depthM` · **`tolM = 6 × mPerPx`**
   - **검증**: 골든 v1 5장에서 덤프의 `rows` 구성이 `roiAutoRecall.ts v1 evidence rows` 산출과 **면 개수·latticeIndex 가 일치**. 불일치면 도구가 서비스 경로를 재현 못 한 것 — **고칠 때까지 다음 단계로 가지 마라.**

### 단계 2 — H1~H6 판정 (= Q3)
단계 1 덤프로 §2-2 표의 6행을 전부 채운다. **각 행에 「참/거짓/미측정 + 그 판정을 낸 수치」**.
- **검증**: 6행 전부에 값이 있다. 「미측정」은 사유 필수.

### 단계 3 — 거리 편향 (= Q2 · Goal ②)
행별 `(medianDepthM, tolM, paint.near, quads.length, median 칸 픽셀길이)` 표를 골든 5장 + 야간 6장(+B) 전부에서 만든다.
- `paint.near` vs `medianDepthM` 회귀 기울기(원시 배정도). `quads.length` 통제 전/후 둘 다.
- **검증**: §3-2 판정 규칙대로 **H3 / H2 / H1 중 하나로 귀착**. 어느 것도 아니면 「미귀착」으로 적고 관측된 것을 그대로 적어라.
- 후보 rank 도 함께 본다 — 전경 행이 rank ≥ 9 면 원인은 **진입 컷**(`frontCandidates=8`)이다. **`frontCandidates` 를 늘리지 마라.** 사실만 적는다.

### 단계 4 — `cellAreaRatio` 분포 (= Q4 · Goal ③)
1. 야간 실카 산출 면을 **육안으로** 「주차면/비주차면/과대」 3치 라벨(라벨 스샷 `r25_label_*` 필수).
2. 라벨별 `cellAreaRatio` 분포 + 픽셀 면적 분포 + 화면 점유율 분포를 **셋 다** 낸다.
3. **검증**: 세 축 중 **어느 축이 라벨을 분리하는가**를 명시. 분리하는 축에서만 §4-3 규칙(「참을 하나도 안 죽이는 최대/최소」)으로 값을 뽑는다.
4. **분리 불가면 「불가」로 적고 단계 5 를 건너뛴다.** 억지로 값을 만들지 마라.

### 단계 5 — 배선 (단계 4 가 「분리 가능」일 때만)
§5-2 의 4지점 규약을 **그대로**:
- `bayGeometry.ts:50-202` 에 `cellAreaRatioMin?`·`cellAreaRatioMax?` 2필드
- `bayGeometry.ts:204-264` 에 무력 기본값 `0` / `Infinity`
- `bayGrid.ts:344-346` 의 `kept` 필터에 조건 **1개** 추가
- `roiAuto.ts:956-962` **무수정** · `BaseSchema`(`roiAuto.ts:57-81`) **무수정**
- 점수식·`refScore`·`rows` 문턱 **무수정**
- **검증(= Q5)**: 플래그 OFF 로 `npx tsx src/tools/roiAutoRecall.ts v1 evidence rows --raw` → 24회차 산출과 `diff` **0줄**. 다르면 **되돌려라.**
- **검증(= Q6)**: 플래그 ON 으로 같은 명령 → diff 줄 수를 **그대로 기록**(0이든 아니든).

### 단계 6 — 스샷 (§7)
`reports/overlay_r25a/` 에 생성 후 **`Read` 로 육안 확인**하고 §7 의 3문에 답하라. **본 것을 수치와 함께 적어라.**

### 단계 7 — 테스트 (= Q7 · Q9)
`test/gridDiag.test.ts`(또는 확장한 도구의 테스트) 최소 5개:
1. 고정 픽스처 → 덤프 필드 존재·타입
2. `cellAreaRatio` 계산의 거리 불변성(같은 면을 두 깊이에 놓아도 비율이 같은 스케일)
3. **무력 기본값 봉인** — `DEFAULT_BAY_OPTS.cellAreaRatioMin === 0` · `Max === Infinity`
4. **서비스 미오버라이드 봉인** — `roiAuto.ts` 소스 문자열에 `cellAreaRatio` **부재**(§5-2 ④를 코드로 고정)
5. 오라클 봉인 — 새 코드에 `faceSlot`/`presetId`/`visible`/`rotY`/`t.vis` **부재**
- **검증**: `npx tsc --noEmit` exit 0 · `npx vitest run` 전체 green.

### 단계 8 — 보고서
`_workspace/32_developer_round25_night_falsepositive.md`. **반드시 포함**:
- Q1~Q9 판정 표 (**원시 배정도** · `toFixed` 금지)
- H1~H6 6행 판정 표
- 거리 편향 귀착 결론(H3/H2/H1/미귀착) + 회귀 수치
- `cellAreaRatio` 분포 표 + 축 선택 근거
- **§5-3 승격 조건 (a)(b) 각각 충족/불충족**
- 육안 3문 답변
- **미측정 항목 정직 기록** · 자산 A 가 real-camera-2 라는 한계 재기록

---

## 10. Goal 재확정 (리더 초안 대비 변경점 + 근거)

| 리더 초안 | 설계자 확정 | 근거 |
|---|---|---|
| ① 마스터 제공 실카 4프리셋에서 오검출 0 | **① 야간 실카 자산 A(6장·real-camera-2) + B(현재뷰)에서 오검출 0.** 마스터 4프리셋은 **재현 불가** | §1-1(해시 0건) · §1-2(프리셋 이동 경로 부재 + 물리이동 금지) |
| ② 시뮬 `1c0012045379` 에서 전경 열을 잡는다 | **② 「전경 역전」의 원인을 H1/H2/H3 중 하나로 귀착시킨다.** 그 프레임은 부재 | §1-3(골든에 없음). 같은 성분을 골든 5장 + 야간 6장에서 잰다 |
| ③ 최소 크기 하한 (값 미확정) | **③ `cellAreaRatio` 단일 축으로 하한·상한을 동시에.** 축이 라벨을 분리 못 하면 「불가」로 마감 | §4-1(픽셀 면적은 원경 진짜 면을 죽인다) · §4-2(마스터가 본 「과대 면」도 같은 병) |
| ④ 24회차 31도 방위 오차를 줄인다 | **④ 이번 회차 범위에서 제외.** | 24회차 방위 오차는 `src/tools/imageObservation.ts` 의 `nearEdgeOf`(계측 전용 소스) 산물이다(24회차 §4-1). **서비스 경로(`bayGrid`)의 격자는 `nearEdgeOf` 를 안 쓴다.** 마스터가 지시한 것은 **제품 화면**이므로 25회차는 서비스 경로에 집중한다. 축 부트스트랩은 **26회차 표적으로 유지** |

**★ ④의 변경이 이번 설계의 가장 큰 판단이다.** 24회차 인계는 「최우선 = 비-오라클 축 부트스트랩」이었으나, 그 31도는 **계측용 개별엔진 경로**의 결함이고 마스터가 본 화면(`bayGrid` 격자)과 **다른 파이프라인**이다. 둘을 섞으면 회차가 표적을 잃는다. 리더가 이 판단에 동의하지 않으면 되돌려라 — **근거를 명시했으니 조용히 선택한 것은 아니다.**

---

## 11. 미해결 · 가정 (리더 확인 요청)

| # | 항목 | 상태 |
|---|---|---|
| 1 | 자산 A 6장에 `.ptz.json` 이 동반되는가 — **설계 중 미확인**. 없으면 `GroundModel` 구성 불가 → 자산 B 단독 진행 | **미측정. 단계 0 이 확인** |
| 2 | 자산 A 는 **real-camera-2**, 마스터 스샷은 **real-camera-1**. 다른 장면 | **확정된 한계.** 「EV3 오검출」의 직접 재현이 아님 |
| 3 | 자산 B 가 주차면을 향할 확률 — 사전에 알 수 없다 | 가정 |
| 4 | `floorPaint` 의 도색 판정이 절대 밝기인지 상대인지(H5) | **미측정.** 단계 2 가 확인 |
| 5 | 지상 면적이 격자 정의상 상수라 하한이 무력할 가능성 | **미측정.** 단계 4 가 확인. 무력이면 상한만 남는다 |
| 6 | `slotWidthM`/`slotDepthM` 기본값 `2.5`/`5.0`(`roiAuto.ts:57-81`)이 야간 실카 현장과 맞는가 | **미측정.** `cellAreaRatio` 의 분모라 결과에 직접 영향 — 단계 4 에서 **실값을 반드시 기록**하라 |
| 7 | main 최신 커밋(`a289817`·`9946e56`)의 휴컴스 프리셋 이동은 이 워크트리에 **부재** | 확정. 어차피 물리이동이라 사용 금지 |
