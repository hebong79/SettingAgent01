# 15회차 구현 계획 (설계자)

- 작성: 2026-07-29 / 설계자(architect)
- 근거: `docs/20260729_143656_...14회차_전체기록과_다음액션.md`(F1~F14 · 반증 20건) · `docs/20260729_143345_...방향재점검.md` §9 지시서
- 범위: **P1(골든 세트 v2 캡처) · P2(자가보정 증폭기 통제 A/B/C) 뿐.** 그 밖 금지
- 성격: **측정 라운드.** 점수를 올리는 변경은 이 계획에 하나도 없다

---

## 0. 요약 — 이 계획이 확인한 가장 중요한 사실

> **`calibrateHeight:false` 는 지상고 정책만 끄지 않는다. 8회차 근변선 2자유도 재적합(③)까지 같이 끈다.**

`bayGrid.ts:507-508`

```ts
const calib = probe ? calibrationFromGrid(probe.evidWidths, probe.result.phaseM, model, opts) : null;
if (!calib) return { best, tried, issues };   // ← 여기서 반환하면 ③ 재적합 루프(523~556)에 도달하지 못한다
```

`calibrationFromGrid` 는 `bayGrid.ts:131` 에서 `if (!opts.calibrateHeight) return null;` 로 즉시 null 이다.
따라서 **B(보정 OFF)·C(고정 지상고)는 구조상 재적합 없는 파이프라인이 되고, A(현행)만 재적합을 갖는다.**
이 상태로 A↔B/C 를 비교하면 "지상고 정책 차이"가 아니라 "지상고 정책 + 재적합 유무"를 재게 된다.

같은 교락이 **14회차가 인용한 `CALIB=0` 수치(1:1 0.85541→0.93182)** 에도 들어 있다 —
그 수치는 `roiAutoBench.ts:66` 의 `calibrateHeight: process.env.CALIB !== '0'` 로 만들어졌고, 동일 조기반환을 탄다.
**따라서 그 수치는 "보정을 껐더니 좋아졌다"가 아니라 "보정+재적합을 껐더니 좋아졌다"이다.** 보고서에 이 정정을 반드시 싣는다.

대응: **A0(= 보정 ON + 재적합 OFF) 통제군을 추가**한다. 옵션 1개(`refitFrontLine:false`)로 끝나고 알고리즘 변경이 0이다.
`A0 / B / C` 는 재적합 OFF 로 조건이 같아 지상고 정책만 비교되고, `A ↔ A0` 차이가 곧 재적합 기여분이다.

---

## 1. 파일 단위 변경 목록

| # | 파일 | 상태 | 내용 |
|---|---|---|---|
| 1 | `src/tools/roiAutoGoldenV2.ts` | **신규** | 정착 프레임 캡처 도구(P1). 30장 + manifest |
| 2 | `src/tools/roiAutoFuse.ts` | **수정** | 프레임 출처 v1/v2 선택 + 모드 A/A0/B/C(P2) |
| 3 | `test/fixtures/roiAutoGolden_v2/` | **신규 산출물** | 30장 + `manifest.json` (~10MB, git 미추적) |
| 4 | `_workspace/15_fuse_v1_{A,A0,B,C}.log` 등 | **신규 산출물** | 실행 원문 로그(프레임 해시 포함) |
| — | `src/rpc/services/roiAuto.ts` | **무변경** | 서비스 배선은 16회차 |
| — | `src/ground/*` | **무변경** | 아래 §3-1 참조. 단 §5 에 16회차 후보 1건 보고 |
| — | `test/fixtures/roiAutoGolden/`(v1) | **무변경** | 삭제·수정 금지. 도구가 물리적으로 막는다 |
| — | `config/*` · 정본 · DB | **무변경** | |

---

## 2. P1 — 골든 세트 v2 (정착 프레임)

### 2-1. 신규 파일: `src/tools/roiAutoGoldenV2.ts`

`src/tools/` 규약(camelCase · `roiAuto*` 접두 · `npx tsx` 단독 실행 · 상단 주석에 목적/근거/사용법)을 따른다.
v1 은 전용 도구 없이 `roiAutoFuse` 캐시에서 승격됐다(`manifest.json:30`) — **v2 는 정착 판정 루프가 필요하므로 신규 도구가 맞다.**

```
사용: npx tsx src/tools/roiAutoGoldenV2.ts [outDir]
      outDir 기본 test/fixtures/roiAutoGolden_v2
```

### 2-2. 함수 시그니처

```ts
/** 정착 판정 결과 1건. */
interface SettleResult {
  jpg: Buffer;
  width: number;
  height: number;
  sha256_12: string;
  /** 해시 연속 2회 동일로 채택했는가. 상한 초과 시 false(최후 프레임 채택). */
  settled: boolean;
  /** 총 캡처 시도 횟수(정착 판정에 걸린 횟수). */
  attempts: number;
  /** 첫 캡처 ~ 채택까지 경과(ms, 정수). */
  settleMs: number;
}

/** 한 시점의 정착 프레임 취득. cam.setPTZ 는 호출자가 먼저 한다. */
async function captureSettled(camId: number, intervalMs: number, budgetMs: number): Promise<SettleResult>;

/** v1 과 동일 스키마 + settled/attempts/settleMs. */
interface FrameEntryV2 {
  file: string; camId: number; presetIdx: number; ditherIdx: number; dither: [number, number];
  ptz: { pan: number; tilt: number; zoom: number };
  presetPtz: { pan: number; tilt: number; zoom: number };
  width: number; height: number; sha256_12: string; bytes: number; capturedAtApprox: string;
  settled: boolean; attempts: number; settleMs: number;   // ★ v2 추가 3필드
}
```

`rpc()` 는 `roiAutoFuse.ts:67-87` 과 동일한 재시도 래퍼를 그대로 쓴다(유니티 13110 이 keep-alive 를 끊는다).
`DITHER` 상수도 `roiAutoFuse.ts:56-63` 과 **같은 집합·같은 순서**여야 한다(v1 manifest `ditherSet` 과 일치).

### 2-3. 절차 (프리셋 5개 × 디더 6시점 = 30장)

```
0) roi.show2d {visible:false}  ← ★ F2. 실패하면 즉시 중단(초록 박스가 도색선을 덮는다)
0') outDir === 'test/fixtures/roiAutoGolden' 이면 거부하고 종료  ← v1 보호(하드 가드)
1) 각 (프리셋, 디더 i):
     cam.setPTZ { camId, pan: preset.pan+dp, tilt: preset.tilt+dt, zoom: preset.zoom }
     captureSettled(camId, intervalMs=2000, budgetMs=30000):
        h_prev = null; t0 = now
        loop:
          cap = cam.captureJPG        → sha256(base64 디코드).slice(0,12)
          if (h == h_prev) → settled:true, 그 프레임 채택, break
          h_prev = h
          if (now - t0 >= 30000) → settled:false, 최후 프레임 채택, break   ← 은닉 금지
          sleep 2000
     저장: outDir/frame_{cam}_{preset}_d{i}.jpg      ← v1 과 동일 명명(roiAutoFuse.frameOf 가 그대로 읽는다)
2) manifest.json 1회 저장
```

- 재시도/건너뛰기 없음(전량 재캡처). 최악 30장×30초 ≈ 15분, 정착이 빠르면 ~3분.
- 진행 로그에 시점마다 `키 · 해시 · settled · attempts · settleMs` 를 그대로 출력한다.
- **영속화 수치 규약:** `ptz`/`presetPtz` 는 정본 값 그대로 복사(정본이 이미 5자리 규약), `settleMs` 는 정수. 새로 계산해 저장하는 실수값이 없으므로 round5 대상은 발생하지 않는다 — 발생시키지 말 것.

### 2-4. 검증

| # | 단계 | 검증 기준 |
|---|---|---|
| 1-1 | 도구 작성 | `npm run typecheck` exit 0 |
| 1-2 | v1 보호 가드 | outDir 를 v1 경로로 주고 실행 → **캡처 0회로 종료**, v1 파일 mtime 무변화 |
| 1-3 | 캡처 실행 | `roiAutoGolden_v2/` 에 정확히 30장 + manifest.json. 파일명이 `frame_{cam}_{preset}_d{i}.jpg` 규약과 100% 일치 |
| 1-4 | manifest 정합 | 각 엔트리의 `sha256_12` 가 실제 파일 sha256 앞 12자와 일치(전 30건). `settled:false` 건수를 그대로 보고 |
| 1-5 | v1 무변경 | `git status`(v1 은 미추적) + 파일 수·바이트 합계 v1 전후 동일 |
| 1-6 | **v1↔v2 대조(부수 산출)** | 30시점 중 **v1 과 해시가 같은 시점 수**를 표로 보고. 이 수가 30 이면 씬이 정지 상태라 G2 격차 측정이 성립하지 않는다 — 그 사실을 결론에 명시(추정 금지) |
| 1-7 | 소비 확인 | `npx tsx src/tools/roiAutoFuse.ts v2 A` 가 30장을 읽고 프레임 해시를 출력 |

---

## 3. P2 — 자가보정 증폭기 통제 A/A0/B/C

### 3-1. 옵션 흐름 (설계 질문 1의 근거)

```
roiAutoFuse.ts
  ├ intrinsics = placeMetaProvider(readPlaceMeta(placeJson))            :91   heightM ← camera.position[1] = 5.0
  │
  └ viewOf(i, frame, baseIntr, t, bays, compensateTilt, policy)         :220
       ├ m0  = groundModelFromIntrinsics(baseIntr, zoom)                :222   ← 기저 좌표계. **모드와 무관하게 공칭 5.0 유지**
       ├ intrV = { ...baseIntr, tiltDeg: +dt }                          :223
       │        ★ 여기에 heightM 오버라이드를 얹는다 → { ...baseIntr, tiltDeg, heightM: policy.heightM }
       ├ mv  = groundModelFromIntrinsics(intrV, zoom)                          → cameraIntrinsics.ts:85  d = i.heightM
       └ detect(frame, mv, bays, policy.optOverride)                    :153
            └ detectBaysWithModel(cands, model, ev, DEFAULT_PAINT_OPTIONS,
                                  { ...DEFAULT_BAY_OPTS, expectedBays, ...optOverride }, frame)   :167  ★ 유일한 주입 지점
                 │                                     └ bayGeometry.ts:150 DEFAULT_BAY_OPTS (:195 calibrateHeight=true, :196 maxHeightCorrection=0.15)
                 ├ ① 선별   fitRowGrid(model, ...) × 후보 전수                   bayGrid.ts:472-494
                 ├ ② 보정   calibrationFromGrid(...)                            bayGrid.ts:507
                 │            └ bayGrid.ts:131  if (!opts.calibrateHeight) return null
                 │          if (!calib) return { best, ... }                    bayGrid.ts:508  ★★ 조기반환 → ③ 미실행
                 │          corrected = withHeight(model, calib.correctedM)     bayGrid.ts:512
                 └ ③ 재적합 refitFrontLineOverRow × rowRefitPasses              bayGrid.ts:523-556
```

**답: `src/ground/*` 를 고치지 않고 주입 가능하다.** 주입점은 `roiAutoFuse.ts:167` 의 `{ ...DEFAULT_BAY_OPTS, expectedBays: ... }` 객체 리터럴 하나뿐이고, 여기에 `calibrateHeight:false` / `refitFrontLine:false` 를 얹으면 된다. `DEFAULT_BAY_OPTS` 자체는 건드리지 않는다(다른 도구·서비스가 공유한다).

**단, 위장하지 않고 명시한다 — `src/ground/*` 무변경으로는 "고정 지상고 + 재적합 ON" 조합을 만들 수 없다.**
`bayGrid.ts:508` 조기반환이 구조적으로 막는다. 우회로는 두 가지뿐이며 둘 다 이번 라운드 기본 범위 밖이다:
(가) 도구 레벨에서 ③ 을 재현(`fitRowGrid`·`refitFrontLineOverRow` 둘 다 export 되어 있음) → §3-6 조건부 단계,
(나) `bayGrid.ts:508` 을 고쳐 calib 없이도 ③ 으로 진행 → **16회차 후보로 보고만** 한다.

### 3-2. 모드 정의

| 모드 | heightM(검출 모델) | opt 오버라이드 | 재적합 ③ | 뜻 |
|---|---|---|---|---|
| **A** | 공칭 5.0 → 검출 중 자가보정 | 없음(현행 그대로) | **ON** | 현행 서비스 기준선 |
| **A0** | 공칭 5.0 → 자가보정 | `refitFrontLine:false` | OFF | ★ 신규 통제군. B·C 와 조건을 맞춘다 |
| **B** | **4.950 고정**(F6) | `calibrateHeight:false` | OFF(구조상) | 보정 OFF |
| **C** | **시점 중앙값 고정** | `calibrateHeight:false` | OFF(구조상) | 6시점 공유 |

> **B 는 `calibrateHeight:false` 만으로 성립하지 않는다.** 정본 `camera.position[1]` 이 5.0 이므로
> 플래그만 끄면 5.0m 가 쓰인다. F6 상수 4.950m 를 쓰려면 `heightM` 오버라이드가 **함께** 필요하다.
> (`5.0 → 4.950` = −1.0%, 4회차 자가보정 계수 0.99018/0.99194 와 같은 크기 — 무시할 수 없다.)

### 3-3. C안 — 고정 지상고 적용 경로 (설계 질문 2의 답)

- **되먹이는 값**: `View.heightM`(`roiAutoFuse.ts:265` = `best.calibration?.correctedM`, 타입 `bayGrid.HeightCalibration.correctedM`).
- **적용 필드**: `PresetIntrinsics.heightM`(`cameraIntrinsics.ts:33`) → `groundModelFromIntrinsics` 가 `GroundModel.d` 로 옮긴다(`cameraIntrinsics.ts:85`). `bayGeometry` 쪽 필드가 아니다 — `BayDetectOpts.cameraHeightM` 은 구경로(`bayGeometry.detectBays`)의 게이트 전용이고 **bayGrid 경로에서는 읽히지 않는다**. 건드리지 말 것.
- **2-pass**:
  ```
  pass1 = 모드 A 실행 결과 재사용(추가 검출 0회). 시점 6개의 heightM 수집
  hC    = medianLow(heights.filter(h => h != null))        ← roiAutoFuse.ts:206 기존 함수 재사용(짝수면 낮은 쪽, R2)
  pass2 = 전 시점을 { ...baseIntr, tiltDeg, heightM: hC } + calibrateHeight:false 로 재검출
  ```
- **분기 독립**: `viewsRaw`(tilt 미보정)와 `viewsTilt`(tilt 보정)는 각자의 6시점에서 **따로** 중앙값을 낸다. 한쪽 값을 다른 쪽에 섞지 않는다.
- **표본 0건**: 자가보정이 전 시점에서 거부되어 `heightM` 이 전부 null 이면 **C 를 산출하지 않고 `C: 미산출(자가보정 표본 0/6)` 로 표기**한다. 대체값을 지어내지 않는다.
- `hC` 는 콘솔 출력 전용이다. 파일·manifest·DB 어디에도 쓰지 않는다(영속화 없음 → round5 대상 아님).

**스케일 불변성 주의(구현자가 "버그"로 오인하지 말 것):** `viewOf` 는 `backprojectToGround(p, best.modelUsed)` → `toBaseFrame` → `projectToPixel(Xb, m0)` 로 기저 픽셀을 만든다. `d` 는 역투영 결과 `X` 를 **균일 배율**로만 바꾸고, 회전은 배율을 보존하며, 핀홀 투영은 `X` 의 방향에만 의존한다 → **`modelUsed.d ≠ m0.d` 여도 재투영 픽셀은 동일하다.** 그래서 `m0` 는 전 모드에서 공칭 5.0 으로 고정해 기저 좌표계를 통일한다. (부수 영향: `View.centre` 는 절대 스케일을 타므로 모드 간 ~1% 달라진다. 득표 군집 임계 2.0m 대비 무시 가능하나, 득표 문자열이 모드별로 갈리면 그대로 보고한다.)

### 3-4. `roiAutoFuse.ts` 수정 명세

**CLI(하위호환 — 인자 없이 실행하면 14회차와 동일 출력):**
```
npx tsx src/tools/roiAutoFuse.ts [frames] [modes]
  frames : v1(기본) | v2 | <디렉터리 경로>     v1/v2 는 골든 세트 별칭
  modes  : A(기본) | CSV 조합 예 "A,A0,B,C"
```

**추가/변경 시그니처:**
```ts
/** 지상고 정책 1건. 모드 = 이 구조체 하나로 표현된다(분기 추가 금지). */
interface HeightPolicy {
  tag: 'A' | 'A0' | 'B' | 'C';
  /** 검출 모델의 설치고(m). null 이면 정본 메타 공칭값(5.0). */
  heightM: number | null;
  /** DEFAULT_BAY_OPTS 위에 얹을 오버라이드. */
  optOverride: Partial<BayDetectOpts>;
}

// 변경 — 인자 1개 추가
function detect(frame: FrameGray, model: GroundModel, expectedBays: number, optOverride: Partial<BayDetectOpts>);
function viewOf(i: number, frame: FrameGray, baseIntr: PresetIntrinsics, t: Target,
                bays: number, compensateTilt: boolean, policy: HeightPolicy): View | null;

// 변경 — 골든 디렉터리 별칭 해석
function frameOf(t: Target, i: number): Promise<FrameGray>;   // GOLDEN_DIR 상수 → GOLDEN_DIRS 맵
```

**출력 형식(프리셋 블록):**
```
=== 1:1 (수동 7면)  득표 미보정 6 · 보정 6            ← 모드별로 갈리면 모드마다 출력
    프레임 6006a034bfe2/…/…                          ← ★ F13. 모드와 무관하게 항상 병기
  [A ] ① 단일(기저)       s1=… …  | ≥0.95 7/7 · ≥0.98 0/7 · 평균 0.97474
  [A ] ② 선별 tilt미보정  …
  [A ] ③ 선별 tilt보정    …
  [A ] ④ 융합 tilt보정    …
  [A0] ① … ④
  [B ] ① … ④
  [C ] ① … ④
  시점별 tC 드리프트(px): …                            ← 기존 유지
  시점별 자가보정 지상고(m): [A ] 4.951 … (중앙값 4.9xx)   ← ★ 모드별 1줄씩. B/C 는 고정값 표기
```
**전체 집계**: `(모드 × 변형)` 16행으로 `≥0.95 · ≥0.98 · 프리셋평균의평균`.

**하지 말 것**: 기존 ①~④ 변형 정의·득표 규칙·`fuse()`·`stripeDriftPx()` 손대지 않는다. 주석 밀도와 문체(★ 표기, 실측 근거 명시)를 그대로 따른다. 요청 밖 리팩토링 금지.

### 3-5. 실행·검증 계획

| # | 단계 | 검증 기준 |
|---|---|---|
| 2-1 | 도구 수정 | `npm run typecheck` exit 0 |
| 2-2 | **무회귀 확인** | 인자 없이 실행 → 14회차 기록(`02n`)의 v1·③ 성적(1:1 7/7 0.97474 · 1:2 3/4 · 2:1 1/6 · 2:2 2/4, 전체 13면)과 **면별 IoU 가 소수 5자리까지 일치**. 불일치면 수정이 A 경로를 건드린 것 — 즉시 중단 |
| 2-3 | v1 × A,A0,B,C | 로그 `_workspace/15_fuse_v1.log`. 프레임 해시 전 시점 병기 |
| 2-4 | v2 × A,A0,B,C | 로그 `_workspace/15_fuse_v2.log` |
| 2-5 | G2 표 | 두 로그의 프리셋 평균 차 `|v1−v2|` 를 모드별로 표기(뺄셈만 — 보간 추정 금지) |
| 2-6 | 판정 | §3-7 기준으로 성공/기각 기록 |

성공기준(지시서):
- ① 프레임 강건성: `2:1` 의 v1/v2 평균 격차 0.112 → **≤0.02**
- ② 만장일치 프리셋 무회귀: **±0.002** 이내
- ③ v2 기준 ≥0.95 통과면수: **A 대비 감소 없음**

★ ③ 은 재적합 교락 때문에 A 와 직접 비교가 불공정하다. **A 대비·A0 대비 두 값을 모두 병기**하고, 어느 쪽이 지시서 기준인지는 판단을 리더에게 올린다(임의 선택 금지).

### 3-6. (조건부) P2-3 — 재적합 복원 B+/C+

**착수 게이트: B 또는 C 가 기준 ①(2:1 격차 ≤0.02)을 A0 대비 충족했을 때에만.** 미충족이면 증폭기 가설 기각을 기록하고 여기서 끝낸다(코드 0줄 추가).

게이트 통과 시 **승자 모드 1개에 한해** 도구 레벨에서 ③ 을 재현한다(`src/ground/*` 무변경 유지):
```
승자 = detectBaysWithModel(mv_fixed, { calibrateHeight:false }, frame).best      // ①만 수행됨
cand = cands.find(c => c.front.line === best.frontLine)                          // 승자 후보 복원
loop rowRefitPasses:
   raw  = refitFrontLineOverRow(frame, adopted.frontLine, adopted.quads, paintOpts,
                                rowRefitSamples, rowRefitTrimK, rowRefitUniformBins)   // bayGrid.ts:403 export
   next = fitRowGrid(mv_fixed, raw, cand.cornersPx, ev, paintOpts, opts)                // bayGrid.ts:212 export
   (감쇠·지지하락 가드·stopPx 종료 조건은 bayGrid.ts:527-554 와 동일 규칙)
```
근거: `fitRowGrid` 는 `fitRowGridOnce(..., calib=null).result` 와 동일하다(`bayGrid.ts:224`) → 재현이 등가다.

**파리티 검증(필수, 통과 못 하면 B+/C+ 수치를 쓰지 않는다):** 30시점 각각에 대해 `heightM = 그 시점의 A correctedM` + `calibrateHeight:false` + 재현 ③ 을 돌려 **A 의 quad 와 좌표가 일치하는 시점 수**를 센다. 30/30 이면 재현 충실. 불일치가 있으면 그 개수와 원인(①선별 승자가 보정 높이에서 갈렸는가)을 그대로 보고하고 B+/C+ 는 참고치로만 표기한다.

### 3-7. 반드시 보고할 한 줄

> **증폭기 제거 후 `2:1` 에 남는 잔여 결손 크기** — `A0`(재적합 OFF, 보정 ON) 대비 `B`·`C` 의 `2:1` ≥0.95 면수와 평균. 이것이 16회차 `2:1` 표적화의 입력이다.

---

## 4. MCP 도구 vs LLM 두뇌 경계

| 항목 | 판정 | 근거 |
|---|---|---|
| 정착 캡처 루프(해시 비교 · 2초 간격 · 30초 상한) | **결정형 도구** | 고빈도 수치반복. LLM 이 매 캡처를 판단하면 비결정·비용 폭증. R2(결정론) 위반 위험 |
| A/A0/B/C 반복 검출·중앙값·집계 | **결정형 도구** | 수치 루프. 난수 0 |
| 성공/기각 판정, 교락 해석, 16회차 표적 선택 | **LLM(리더)** | 맥락 판단·트레이드오프. 도구는 수치만 낸다 |
| 서비스 배선 여부 | **LLM(리더) · 16회차** | 이번 라운드 범위 밖 |

신규 MCP 도구·RPC 메서드는 **추가하지 않는다.** 두 도구 모두 `npx tsx` 단독 실행이다.

---

## 5. 리스크

| # | 리스크 | 대응 |
|---|---|---|
| R-1 | **재적합 교락**(§0) — B/C 가 부당하게 불리 | A0 통제군 필수. ③ 기준은 A·A0 양쪽 병기. `bayGrid.ts:508` 은 16회차 후보로 **보고만** |
| R-2 | 정착 미수렴(U17 씬 간헐 변동, 3분 9종) | 30초 상한 + `settled:false` 기록. 은닉·재시도 무한루프 금지 |
| R-3 | **v2 가 v1 과 대부분 동일 프레임** → G2 격차가 측정 불가 | 검증 1-6 으로 동일 해시 시점 수를 먼저 센다. 30/30 이면 "G2 측정 불성립"을 결론에 그대로 쓴다(우회 금지) |
| R-4 | 런타임 3~4배(모드 4개 × 6시점 × 2분기 = 프리셋당 48 detect) | 모드를 CSV 로 나눠 실행 가능하게 설계. 과도하면 B/C 의 ②(tilt 미보정) 생략을 리더에 질의 — **임의 생략 금지** |
| R-5 | 라이브 캡처 중 `selectedCameraId` 오염(14회차 사고 재발) | P1 실행 **전후** `config/tools.config.json` 값을 로그에 찍고 보고서에 병기. 값 변경은 금지(P0 은 리더 소관) |
| R-6 | v1 훼손 | 도구의 하드 가드(§2-3 절차 0') + 검증 1-5 |
| R-7 | 픽스처 +10MB | §6 질문 4 참조 — 회귀 영향 없음. 커밋 여부는 A4 미결(리더) |
| R-8 | 서버 재시작 유발 | 파일 저장 위치가 `test/fixtures/`·`_workspace/` → nodemon 감시 대상(`src/`) 밖. `src/tools/*.ts` 편집은 13020 nodemon 재시작을 유발할 수 있으므로 **편집 시각을 로그에 남기고** 라이브 채점과 겹치지 않게 한다 |

---

## 6. 설계 질문 4개에 대한 답

**Q1. `calibrateHeight:false` 주입 경로 / `src/ground` 무변경 가능한가**
`roiAutoFuse.ts:167` 의 `detectBaysWithModel(..., { ...DEFAULT_BAY_OPTS, expectedBays: … }, frame)` 객체 리터럴이 유일한 주입 지점이다. 흐름은 `detect()` → `detectBaysWithModel`(bayGrid.ts:456) → `calibrationFromGrid`(bayGrid.ts:507, 내부 `:131` 에서 플래그 검사) → `withHeight`(`:512`) → 재적합(`:523`). `src/ground/*` 무변경으로 **주입은 가능하다.** 그러나 **`bayGrid.ts:508` 의 조기반환 때문에 보정을 끄면 8회차 근변선 재적합(③)까지 함께 꺼진다** — 지상고 정책만 분리할 수 없다. 14회차가 인용한 `CALIB=0` 수치도 같은 교락을 안고 있다. 대응으로 A0(보정 ON + `refitFrontLine:false`) 통제군을 추가한다. "고정 지상고 + 재적합 ON"은 `src/ground` 무변경으로는 불가능하며, 도구 레벨 재현(§3-6, 조건부) 또는 `bayGrid.ts:508` 수정(16회차 후보 보고)뿐이다.

**Q2. C안 고정 지상고의 적용 경로**
`View.heightM`(`roiAutoFuse.ts:265` = `best.calibration.correctedM`) 6개 → `medianLow`(`roiAutoFuse.ts:206`, 짝수면 낮은 쪽) → **`PresetIntrinsics.heightM`**(`cameraIntrinsics.ts:33`) 오버라이드 → `groundModelFromIntrinsics` 가 `GroundModel.d` 로 옮긴다(`cameraIntrinsics.ts:85`) → 그 모델로 `detect()` 를 2pass 재실행하며 `calibrateHeight:false`. `bayGeometry` 의 필드가 아니다(`BayDetectOpts.cameraHeightM` 은 구경로 게이트 전용, bayGrid 미사용). `viewOf` 의 `intrV`(`:223`) 스프레드에 `heightM` 을 얹는 방식이 B·C 공통 기구다. 기저 모델 `m0` 는 전 모드 공칭 5.0 고정(재투영은 스케일 불변).

**Q3. v2 캡처 도구 — 신규**
신규 `src/tools/roiAutoGoldenV2.ts`. v1 은 전용 도구 없이 `roiAutoFuse` 캐시를 승격해 만든 것이라(manifest `createdBy`) 확장할 기존 도구가 없고, 정착 판정 루프(해시 2연속 · 2초 간격 · 30초 상한 · `settled` 기록)는 채점 도구인 `roiAutoFuse` 의 책임이 아니다. 출력 파일명은 v1 규약(`frame_{cam}_{preset}_d{i}.jpg`)을 그대로 지켜 `roiAutoFuse` 가 바로 읽는다. v1 경로를 outDir 로 받으면 즉시 거부한다.

**Q4. 30장 ~10MB 픽스처가 회귀에 영향을 주나 — 영향 없음**
`vitest.config.ts` 의 `include` 가 `test/**/*.test.ts` 뿐이라 픽스처는 수집 대상이 아니다. `tsconfig.json` `include` 도 `src/**/*.ts`·`test/**/*.ts` 로 `.jpg` 와 무관하다. v2 를 읽는 테스트를 **추가하지 않으므로**(이번 라운드 계획에 없음) 3553 테스트의 실행 시간·결과에 변화가 없다. 저장소 측면: v1(11MB)이 이미 `.gitignore` 미적용이지만 **미추적 상태**(`git ls-files` 0건)이므로 v2 도 같은 상태로 두면 커밋 크기 영향 0이다. 커밋 여부는 미결 A4 — **리더 결정 전까지 `git add` 금지.**

---

## 7. 미해결 · 리더에게 올리는 질문

| # | 질문 | 기본 동작(회신 없을 때) |
|---|---|---|
| Q-a | **A0 통제군 추가 승인.** 지시서는 A/B/C 3모드지만, 재적합 교락(§0) 때문에 A0 없이는 B/C 결과 해석이 불가능하다. 알고리즘 변경 0·옵션 1개 | **추가한다**(측정 타당성 확보가 이번 라운드 목적이므로) |
| Q-b | 성공기준 ③("≥0.95 통과면수 A 대비 감소 없음")의 비교 대상이 A 인가 A0 인가 | 양쪽 병기, 판정 보류 |
| Q-c | §3-6 B+/C+(도구 레벨 ③ 재현) 착수 승인 — 게이트 통과 시 | 게이트 미통과면 미착수. 통과 시 **회신 대기**(임의 착수 금지) |
| Q-d | `bayGrid.ts:508` 조기반환 수정을 16회차 표적으로 올릴지 | 보고만, 코드 무변경 |
| Q-e | R-4 런타임 과다 시 B/C 의 ②(tilt 미보정) 변형 생략 가부 | 생략하지 않는다(전량 산출) |
| Q-f | P1 라이브 캡처가 P0(`selectedCameraId`) 정리 이후여야 한다 — 현재 상태 확인 필요 | 캡처 전 config 값을 읽어 시뮬 계열이 아니면 **캡처 중단·보고**(config 수정 금지) |

---

## 8. 구현자·문서화 전달 사항

- **구현자(developer)**: §1 파일 목록 · §2-2/§3-4 시그니처 · §2-4/§3-5 검증표 순서대로. 2-2(무회귀 5자리 일치)를 통과하기 전에는 v2 캡처로 넘어가지 말 것. 금지사항(정본·DB 쓰기, `roi.auto.apply`, 서버 재시작, config 변경, 점수 튜닝, 반증 20건 재시도) 준수.
- **문서화(documenter)**: 영향 범위 초안 — 신규 `src/tools/roiAutoGoldenV2.ts`, 수정 `src/tools/roiAutoFuse.ts`(도구 전용, 서비스·`src/ground` 무영향), 신규 픽스처 `test/fixtures/roiAutoGolden_v2/`. **14회차 `CALIB=0` 수치의 교락 정정(§0)** 을 문서에 반드시 반영. F 목록에 추가 후보: "`calibrateHeight:false` 는 근변선 재적합도 함께 끈다(bayGrid.ts:508)".
