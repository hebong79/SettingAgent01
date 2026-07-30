# 16회차 구현 계획 (설계자)

- 작성: 2026-07-29 / 설계자(architect)
- 근거: `docs/20260729_175500_15회차_재개지시서_16회차착수전.md` §3 순위 1 · `docs/20260729_171526_...15회차_골든v2와_증폭기통제.md` · `_workspace/03b_qa_report_round15.md`(적대검증) · `_workspace/01b_architect_plan_round15.md` §0 · `src/ground/bayGrid.ts` 456~558 · `src/tools/roiAutoFuse.ts`
- 실행 모드: **goal/loop B 모드**
- 성격: **교락 제거 + 측정 라운드.** 점수를 올리려는 튜닝은 이 계획에 한 줄도 없다

---

## 0. Goal 과 이번 라운드의 질문

> **재적합 교락을 제거해 「고정 지상고 + 근변선 재적합 ON」 조합을 처음으로 가능하게 하고, 그 위에서 증폭기 통제안이 기준 ①②③ 을 충족하는지 수치로 판정한다.**

15회차 실측이 남긴 상태:

| 사실 | 값 |
|---|---|
| 재적합 단독 기여 | v1 A 13면 → A0 8면 = **5면** |
| 증폭기 감도(MAD 0.055 섭동) | A 0.11933 · A0 0.09192 · C 0.09119 vs **B 0.00000033** (~3.6×10⁵ 배) |
| 기준② 무회귀 ±0.002 | B·C **모두 미달**(B: 1:1 −0.01895, 2:1 **+0.07752**) |

**B/C 는 증폭기를 껐지만 재적합 이득 5면도 같이 버렸다.** 그 둘이 한 플래그에 묶여 있었기 때문이다.
이번 라운드는 **묶임을 푸는 것**이 본체이고, 점수 판정은 그 뒤에 따라오는 관측이다.
**면수가 안 오르면 안 오른 대로 보고한다** — 이 계획에는 점수를 올리는 장치가 없다.

---

## 1. 설계질문 5개에 대한 답 (요약 — 근거는 §2~§5)

| # | 질문 | 답 |
|---|---|---|
| **1** | `fitRowGridOnce` 의 `calib` 인자는 내부에서 어떻게 쓰이나? null 허용인가 | **보고용 2곳뿐이다** — `bayGrid.ts:351 calibration: calib` 와 `bayGrid.ts:373 issues: calib ? [model.issues[…]] : []`. 기하 계산에 **일절 관여하지 않는다.** null 은 이미 정상 입력이다(`:224` `fitRowGrid` 가 항상 null, `:506` probe 도 null) |
| **2** | 조기반환 제거 시 기존 정상 경로의 비트 동일성 보장 | **변경을 ⓐ(`calibrateHeight===false`)로만 한정**한다. `calib!==null` 분기의 문장 순서·인자·부동소수 연산을 **한 줄도 건드리지 않고**, `if (!calib) return` 을 `if (!calib && opts.calibrateHeight) return`(의미상 ⓑ 보존)으로 좁힌 뒤 ⓐ 전용 초기화만 추가한다. 검증은 **골든 로그 바이트 대조 2종 + 단위테스트 deep-equal**(§5) |
| **3** | ⓐ(의도적 OFF)와 ⓑ(계수 기각)를 구분해야 하나 | **구분한다.** ⓑ 는 "엉뚱한 행 방어" 게이트(`bayGeometry.ts:146`)가 발화한 신호이고, ⓑ 에서 재적합을 도는 것은 **측정 근거가 0인 서비스 동작 변경**이다. 게다가 골든 v1·v2 실측상 **ⓑ 발생 0/30**(§4-3)이라 ⓑ 를 포함해도 이번 목표에 **아무 이득이 없다** |
| **4** | 다른 소비자 영향 · 서비스 기본 동작이 바뀌나 | **`roi.auto` 서비스는 비트 동일 — 기본 동작 변경 없음.** 서비스는 `calibrateHeight:true`(DEFAULT) 고정이라 ⓐ 에 절대 진입하지 않는다. 실제로 동작이 바뀌는 소비자는 **`roiAutoBench` 의 `CALIB=0` 하나뿐**이고(§4-2), `roiAutoFuse` 의 B·C 는 `refitFrontLine:false` 명시 고정으로 **의도적으로 보존**한다 |
| **5** | 이 경로를 덮는 기존 테스트가 있나 | **없다.** 3553 테스트 중 `detectBaysWithModel`·`fitRowGridOnce`·`refitFrontLineOverRow` 를 실행하는 테스트가 **0건**이다(`test/cameraIntrinsics.test.ts:191` 은 `rowFrameFromLine`/`widthCoordOf` 순수함수만). **신규 `test/bayGridRefitGate.test.ts` 5개 케이스를 반드시 써야 한다**(§5-2) |

---

## 2. `bayGrid.ts` 조기반환 수정 — 상세 설계 (★ 서비스 영향 판정 포함)

### 2-1. 현재 구조 (읽은 그대로)

```
bayGrid.ts:506  const probe = fitRowGridOnce(model, bestCand.front, …, opts, null);
bayGrid.ts:507  const calib = probe ? calibrationFromGrid(probe.evidWidths, probe.result.phaseM, model, opts) : null;
bayGrid.ts:508  if (!calib) return { best, tried, issues };      ← ★ ③ 블록(523~556) 앞
bayGrid.ts:509  const note = `지상고 자가보정: …`
bayGrid.ts:512  const corrected = withHeight(model, calib.correctedM, note);
bayGrid.ts:513  const refit    = fitRowGridOnce(corrected, bestCand.front, …, opts, calib);
bayGrid.ts:514  if (!refit) { issues.push(`${note} — … 공칭 결과 유지`); return { best, tried, issues }; }
bayGrid.ts:518  issues.push(note);
bayGrid.ts:519  let adopted = refit.result;  let adoptedCand = bestCand;
bayGrid.ts:523  if (frame && opts.refitFrontLine) { … corrected, calib 를 쓰는 재적합 루프 … }
bayGrid.ts:557  return { best: adopted, tried, issues };
```

### 2-2. ★ 설계질문 1 — `fitRowGridOnce` 의 `calib` 인자는 무엇에 쓰이나

**함수 본문(229~386)을 전수 확인했다. `calib` 의 사용처는 정확히 2곳이며 둘 다 보고용이다.**

| 라인 | 코드 | 성격 |
|---|---|---|
| `bayGrid.ts:351` | `calibration: calib,` | GridResult 필드에 그대로 담는다(진단·`roiAutoFuse.View.heightM` 이 읽는다) |
| `bayGrid.ts:373` | `issues: calib ? [model.issues[model.issues.length - 1]] : []` | "내가 받은 model 이 보정본인가" 표시. `withHeight` 가 붙인 note 한 줄을 되읽는 용도 |

- **기하 계산 어디에도 들어가지 않는다.** 격자 구성(`buildAtPhase`)·채점(`quadPaintSupport`)·선택(`effective`)·`modelUsed`(`:352` = 인자 `model`) 전부 `calib` 과 무관하다.
- **null 은 예외가 아니라 정상 입력이다.** 이미 두 곳이 null 로 호출한다 — `:224`(`fitRowGrid` 의 유일한 호출)와 `:506`(probe). 즉 **null 경로가 매 프리셋마다 이미 수십 번 실행되고 있다.** 새로 열리는 위험 경로가 아니다.

> 따라서 **`calib===null` 경로에서 ③ 을 돌 때 `fitRowGridOnce` 에 넘길 인자는 `(model, re, adoptedCand.cornersPx, evidence, paintOpts, opts, null)` 이다.**
> `corrected` 자리에는 **`withHeight` 를 거치지 않은 원본 `model`** 을 그대로 쓴다.
> **`withHeight(model, model.d, …)` 로 "형식만 맞추는" 짓을 하지 마라** — note 가 `model.issues` 에 붙어 `:373` 의 `issues` 산출이 달라진다(현재 ⓐ 결과의 `issues` 는 `[]` 다).

### 2-3. ★ 설계질문 3 — ⓐ(의도적 OFF)와 ⓑ(계수 기각)를 구분해야 하나 → **구분한다**

`calib===null` 이 되는 경로는 정확히 셋이다:

| 경로 | 발생 조건 | 뜻 |
|---|---|---|
| **ⓐ** | `opts.calibrateHeight === false` → `bayGrid.ts:131` 즉시 null | 호출자가 **지상고 정책을 의도적으로 고정**했다. 근변선에 대한 부정적 증거는 **없다** |
| **ⓑ-1** | `estimateCellPitch` 가 null(`:119` `n<2`) | 격자 배정에 쓸 코너 표본이 2개 미만 = **증거 빈약** |
| **ⓑ-2** | `\|factor−1\| > maxHeightCorrection`(`:135`, 기본 0.15) | 관측 칸간격이 규격 대비 15% 밖 = **엉뚱한 행 방어 게이트 발화**(`bayGeometry.ts:146` 주석 그대로) |

**판단: ⓐ 만 ③ 으로 진행시키고, ⓑ 는 현행 조기반환을 그대로 둔다.** 근거 4가지:

1. **ⓑ 는 "이 격자가 틀렸을 수 있다"는 신호다.** ⓑ-2 게이트의 존재 이유가 문서화된 대로 *엉뚱한 행 방어*다. 틀렸을 수 있는 행 위에서 근변선을 8회차 재적합으로 더 정밀하게 맞추는 것은 **틀린 행을 더 잘 맞추는 일**이며, 이득/손실 어느 쪽도 측정된 바 없다.
2. **이번 Goal 에 ⓑ 는 필요 없다.** B+/C+ 는 전부 ⓐ 다. ⓑ 를 포함해도 16회차 수치는 **한 자리도 달라지지 않는다**.
3. **ⓑ 를 포함하면 서비스 동작이 바뀐다**(서비스는 `calibrateHeight:true` 고정이라 ⓐ 에는 절대 못 들어가고 ⓑ 에만 들어간다). 근거 없는 서비스 변경은 **리더 승인 사항**이며, 승인 근거가 될 측정치가 지금 0건이다.
4. **골든 세트에서 ⓑ 는 실제로 0건이다**(§4-3). 즉 ⓑ 를 배제해도 이번 라운드가 잃는 관측이 없다.

**구분 방법(신규 옵션 0개):** 호출 지점에서 `opts.calibrateHeight` 를 그대로 읽으면 된다.
`calib===null && opts.calibrateHeight===true` ⇔ ⓑ, `calib===null && opts.calibrateHeight===false` ⇔ ⓐ. **완전 판별이며 새 상태·새 필드가 필요 없다.**

> ⚠ 미세 경계 1건(정직 기록): `opts.calibrateHeight===true` 인데 `probe===null` 이어도 ⓑ 로 분류된다. `probe` 는 `best` 와 **동일 인자·동일 결정론 계산**(`fitRowGrid`=`fitRowGridOnce(…,null)`)이라 `best` 가 존재하는 한 `probe` 도 존재한다 — 실제로는 발생하지 않는 경계다. 이 경계에 별도 처리를 **넣지 마라**(발생 불가 시나리오 에러처리 금지).

### 2-4. ★ 설계질문 2 — 기존 정상 경로 비트 동일성 보장 (가장 중요)

**보장 전략은 "조심해서 고친다"가 아니라 "정상 경로의 코드가 실행 순서까지 그대로 남는 형태로만 고친다" + "3중 대조로 증명한다" 두 축이다.**

#### (가) 구조적 보장 — 정상 경로 문장을 이동·재작성하지 않는다

허용하는 편집은 **정확히 두 가지**뿐이다.

1. `bayGrid.ts:508` 의 조건을 **좁힌다**: `if (!calib) return …` → `if (!calib && opts.calibrateHeight) return …`
   (= ⓑ 는 예전 그대로 조기반환, ⓐ 만 통과)
2. `bayGrid.ts:509~519`(note/corrected/refit/`if(!refit)`/`issues.push(note)`/`adopted` 초기화)를 **`if (calib) { … }` 블록으로 감싸고**, `else` 에 ⓐ 전용 초기화 3줄을 둔다.
   - ⓐ 초기화: 재적합에 넘길 모델 = **`model`**(원본), 재적합에 넘길 calib = **`null`**, `adopted` = **`best`**(재계산 금지 — 오늘 조기반환이 돌려주던 바로 그 객체), `adoptedCand` = `bestCand`.

이때 **`calib!==null` 인 실행의 명령 순서는 다음과 같이 완전히 보존된다**:

| 오늘 | 수정 후 | 동일성 논거 |
|---|---|---|
| `:506` probe | 동일 위치·동일 인자 | 편집 대상 아님 |
| `:507` calib | 동일 | 편집 대상 아님 |
| `:508` 통과(calib 있음) | `if (!calib && …)` → 조건 `false` 로 동일하게 통과 | `!calib` 이 이미 false → `&&` 단축평가로 **`opts.calibrateHeight` 는 읽히지도 않는다** |
| `:509~519` | `if (calib) {}` 안에서 **같은 순서로 실행** | 문장 내용·인자·부동소수 연산 무변경. 블록 중첩은 값에 영향 없음 |
| `:523~556` ③ | 동일. 참조하는 변수만 `corrected`→(같은 값을 담은) 재적합 모델 변수, `calib`→(같은 값) 재적합 calib 변수 | `calib!==null` 일 때 두 변수는 **정의상 `corrected`·`calib` 그 자체**로 초기화된다 |
| `:557` return | 동일 | |

**핵심:** 부동소수 결과가 달라질 수 있는 변경(연산 순서·인자 치환·중간 변수 재계산)이 **하나도 없다.** 유일한 변화는 `if` 조건에 `&& opts.calibrateHeight` 한 항이 붙는 것과 블록 중첩이다.

**금지사항(비트 동일성을 깨는 전형적 유혹):**
- ⓐ 에서 `adopted` 를 `fitRowGridOnce(model, bestCand.front, …, null)` 로 **재계산하지 마라.** 값은 같겠지만 오늘의 `best` 객체와 참조가 달라지고, 무엇보다 불필요한 1패스다. `best` 를 그대로 쓴다.
- ⓑ 를 "일관성 있게" 통과시키지 마라(§2-3).
- `withHeight` 를 ⓐ 에서 호출하지 마라(§2-2).
- 인접 주석·포맷·`probe` 조기 단축평가 최적화 등 **요청 밖 리팩토링 금지**(§7-1 참조).

#### (나) 실측 보장 — 3중 대조

| 대조 | 내용 | 통과 기준 |
|---|---|---|
| **B1** | `npx tsx src/tools/roiAutoFuse.ts`(인자 없음, 모드 A) | `_workspace/15_fuse_v1_A_post.log` 와 **md5 `d8ac52be1561a61de50d397c0c9ce951` · 4719B 일치** |
| **B2** | `v1 A,A0,B,C` 실행 결과에서 `[A ]`/`[A0]`/`[B ]`/`[C ]` 행 + 프레임 해시 행 추출 | `_workspace/15_fuse_v1.log` 의 같은 행들과 **바이트 동일** |
| **B3** | 신규 단위테스트 `ⓑ 보존` 케이스 | `maxHeightCorrection:0`(강제 기각) 조건에서 `refitFrontLine:true` 결과와 `refitFrontLine:false` 결과가 **deep-equal** |

> B2 가 통과한다는 것은 **A(보정 ON+재적합 ON)·A0(보정 ON+재적합 OFF)·B·C 21면 × 4변형 × 5프리셋 전량의 IoU 가 소수 4자리까지 그대로**라는 뜻이다. 단위테스트보다 강한 증거다.
> **B1·B2 중 하나라도 어긋나면 즉시 중단하고 리더에 보고**한다. "거의 같다"로 넘어가지 마라(15회차 교훈 §7-1: `toFixed` 반올림으로 결론이 뒤집힐 뻔했다).

### 2-5. ★ 옵션 플래그로 신·구 동작을 가를 것인가 → **권고: 새 플래그를 만들지 마라**

| 안 | 평가 |
|---|---|
| **(권고) 신규 플래그 없음** — ⓐ 는 무조건 새 동작, ③ 실행 여부는 **기존 `refitFrontLine` 이 단독으로** 결정 | `refitFrontLine` 이 비로소 **진짜 직교 손잡이**가 된다. 옛 B/C 의미가 필요하면 호출자가 `refitFrontLine:false` 를 **명시**하면 되고, 그 명시는 자기설명적이다. 서비스는 ⓐ 에 진입하지 않으므로 **보호할 기본값 자체가 없다** |
| 신규 플래그(예 `refitWithoutCalibration`) 추가 | 하나의 동작에 손잡이가 둘이 된다. 서비스에서는 영원히 죽은 설정이다. 단순함 우선 위반 |

**따라서 이 변경에 「서비스 기본값 변경」은 포함되지 않으며, 리더 승인이 필요한 항목도 없다.**
(리더 승인이 필요해지는 것은 ⓑ 까지 확장하자는 별개 제안이며, 이번 계획은 그것을 하지 않는다 — §8-Q1 에 질문으로만 올린다.)

### 2-6. 변경 후 함수 시그니처

**변경 없음.** `detectBaysWithModel`·`fitRowGridOnce`·`calibrationFromGrid`·`refitFrontLineOverRow` 전부 시그니처 동일, export 목록 동일, 타입 동일.
`src/ground/bayGeometry.ts`(`BayDetectOpts`·`DEFAULT_BAY_OPTS`)도 **무변경**(새 옵션을 만들지 않으므로).

> 즉 `src/ground/` 의 실제 변경은 **`bayGrid.ts` 한 파일, 조건 1개 + 블록 1개**다.

---

## 3. `roiAutoFuse.ts` — 모드 B+/C+ 추가

### 3-1. 모드 표 (기존 4개 + 신규 2개)

| 모드 | `heightM` | `optOverride` | ③ 재적합 | 뜻 |
|---|---|---|---|---|
| **A** | null(공칭 5.0 → 자가보정) | `{}` | ON | 현행 서비스 기준선 |
| **A0** | null | `{ refitFrontLine: false }` | OFF | 재적합 기여분 분리용 통제군 |
| **B** | `4.950`(F6) | `{ calibrateHeight:false, refitFrontLine:false }` ← ★ **명시 추가** | OFF | 15회차 B **의미 보존** |
| **C** | 6시점 중앙값 | `{ calibrateHeight:false, refitFrontLine:false }` ← ★ **명시 추가** | OFF | 15회차 C **의미 보존** |
| **B+** | `4.950`(F6) | `{ calibrateHeight:false }` | **ON** | ★ 신규. 증폭기 OFF + 재적합 이득 유지 |
| **C+** | 6시점 중앙값(**C 와 동일 값**) | `{ calibrateHeight:false }` | **ON** | ★ 신규 |

> ★★ **B/C 에 `refitFrontLine:false` 를 명시하는 것이 이 파일 변경의 핵심이다.**
> `bayGrid` 수정 후에는 `{calibrateHeight:false}` 만 주면 재적합이 **자동으로 켜져** B 가 B+ 로 변해 버린다.
> 명시 고정이 있어야 15회차 로그와의 바이트 대조(B2)가 성립하고 「비교 가능성 보존」 제약도 지켜진다.
> C+ 는 **C 와 동일한 `hCRaw`/`hCTilt`** 를 쓴다 → C↔C+ 차이는 **재적합 단독**이다(교락 0).

### 3-2. 수정 지점 (전부 `src/tools/roiAutoFuse.ts` 내부, 도구 전용)

| # | 위치 | 변경 |
|---|---|---|
| 1 | `:77-78` `ModeTag` / `MODE_TAGS` | `'B+'`, `'C+'` 추가. **문자열 길이 2라 `padEnd(2)` 정렬(`:400`,`:443`)이 그대로 맞는다** |
| 2 | `:430` `needA` | `modes.includes('C+')` 를 **반드시** OR 에 추가(C+ 도 A 의 중앙값이 필요) |
| 3 | `:445` C 미산출 가드 | `mode === 'C'` → `mode === 'C' \|\| mode === 'C+'` (표본 0/6 이면 지어내지 않는다) |
| 4 | `:452-469` 모드 분기 | `B` 와 `C` 에 `refitFrontLine:false` 명시 + `B+`/`C+` 분기 2개 추가. `heightNote` 문구에 재적합 상태를 1구 덧붙인다(예 `… 보정 OFF · 재적합 ON`) — **단 B/C 의 기존 문구는 글자 하나도 바꾸지 마라**(B2 대조가 깨진다) |
| 5 | 파일 상단 주석 `:26-39` | B+/C+ 정의 2줄 추가 + `bayGrid.ts:508` 서술을 **16회차에 ⓐ 한정으로 해제됨**으로 정정 |

**하지 말 것:** `viewOf`·`detect`·`vote`·`fuse`·`stripeDriftPx`·변형 ①~④ 정의·집계 로직·CLI 파싱 구조 **손대지 마라.** `roiAutoFuse.ts:337` 동점 해소 규칙은 **16회차 순위 3 별건**이며 이번에 고치지 않는다(고치면 C/C+ 비교가 오염된다).

### 3-3. 알려진 결과 예측(가설로만 기록 — 측정으로 대체될 것)

- **C+ 의 `2:2` 도 0.00000 이 나올 수 있다.** 원인은 재적합이 아니라 QA V2 가 규명한 **득표 동점(2:2) + 최소 인덱스 대표 선택**(`roiAutoFuse.ts:337`)이다. 만약 0 이 나오면 **득표 문자열(`득표 미보정 x · 보정 y`)을 근거로 그 원인임을 확인**하고 그대로 보고하라. 규칙을 고쳐 0 을 지우려 하지 마라.
- 예측을 수치로 적지 마라. **미측정을 보간 추정으로 채우는 것은 금지다.**

---

## 4. 영향도 — ★ 설계질문 4

### 4-1. 소비자 전수 조사 (`detectBaysWithModel` 호출 지점 9곳)

| 소비자 | `calibrateHeight` | ⓐ 진입 | 영향 |
|---|---|---|---|
| **`src/rpc/services/roiAuto.ts:378`** | `DEFAULT_BAY_OPTS` = **true**(오버라이드는 `slotWidthM`/`slotDepthM`/`cameraHeightM`/`expectedBays` 뿐) | **불가능** | **비트 동일 · 서비스 기본 동작 변경 없음** |
| `src/tools/roiAutoBench.ts:66,100` | `process.env.CALIB !== '0'` | **`CALIB=0` 일 때 진입** | ★ **의미 변경 1건** — §4-2 |
| `src/tools/roiAutoOverlay.ts:115` | true(기본) | 불가능 | 무영향 |
| `src/tools/roiAutoConsensus.ts:109` | true | 불가능 | 무영향 |
| `src/tools/roiAutoResidual.ts:122` | true | 불가능 | 무영향 |
| `src/tools/roiAutoNoise.ts:97` | true | 불가능 | 무영향 |
| `src/tools/roiAutoStripe.ts:80` | true | 불가능 | 무영향 |
| `src/tools/roiAutoLopo.ts:99` | true(`aimCenterWeight` 만 오버라이드) | 불가능 | 무영향 |
| `src/tools/roiAutoFuse.ts:202` | 모드별 | B·C·B+·C+ 에서 진입 | **의도된 변경**. B·C 는 `refitFrontLine:false` 명시로 보존(§3-1) |

`GridResult.calibration` 소비자(`roiAutoBench:119`·`roiAutoFuse:323`·`roiAutoNoise:102`·`roiAutoOverlay:123`)는 전부 **null 안전**하게 쓰고 있으며, ⓐ 에서 `calibration` 이 null 인 것은 오늘과 동일하다(변화 없음).

### 4-2. ★ 유일한 부작용 — `roiAutoBench` 의 `CALIB=0` 의미가 바뀐다

- 오늘: `CALIB=0` = **보정 OFF + 재적합 OFF**(15회차가 정정한 그 교락).
- 수정 후: `CALIB=0` = **보정 OFF + 재적합 ON**.
- **`roiAutoBench.ts` 를 고치지 마라**(요청 범위 밖·요청받지 않은 유연성 금지). 대신 **문서화 필수**:
  > 14회차가 인용한 `CALIB=0` 수치(1:1 0.85541→0.93182)를 재현하려면 16회차 이후에는 `CALIB=0` 만으로 부족하고 `refitFrontLine:false` 를 함께 줘야 한다.

### 4-3. ⓑ 실제 발생 빈도 — 골든 세트 실측 **0/30**

15회차 로그 `[A ] 시점별 자가보정 지상고(m)` 행(=`viewsTilt` 6시점 × 5프리셋)에 **`--` 가 한 건도 없다.**

| 세트 | 1:1 | 1:2 | 1:3 | 2:1 | 2:2 |
|---|---|---|---|---|---|
| v1 | 4.956 4.973 5.017 5.012 4.980 5.080 | 4.981 5.007 4.972 4.952 4.955 5.043 | 5.055 5.208 5.278 5.058 5.057 4.941 | 5.067 5.121 4.983 5.019 5.022 5.004 | 5.040 5.042 4.953 5.033 4.995 5.040 |
| v2 | 5.051 4.973 5.056 5.049 4.955 5.116 | 5.217 5.018 4.972 4.952 4.955 5.043 | (v1 동일) | (v1 동일) | (v1 동일) |

→ **60시점 전부 `calib!==null`.** 최대 편차도 5.278/5.0 = +5.6% 로 게이트 15% 안이다.
**정직 단서(미검증):** 이 행은 `viewsTilt` 분기만 출력한다. `viewsRaw` 분기의 ⓑ 발생은 **관측되지 않았다** — "0건"이라고 단정하지 말고 **"tilt 보정 분기 30/30 에서 0건, 미보정 분기 미관측"** 으로 표기하라. (필요하면 §5-3 프로브로 센다.)

---

## 5. 회귀 위험과 대응 — ★ 설계질문 5

### 5-1. 현재 테스트 커버리지 실측

| 항목 | 사실 |
|---|---|
| `detectBaysWithModel` 을 실행하는 테스트 | **0건** (`test/` 전수 grep) |
| `fitRowGridOnce`(private)·`fitRowGrid`·`refitFrontLineOverRow`·`calibrationFromGrid` | **0건** |
| `bayGrid.ts` 를 import 하는 테스트 | `test/cameraIntrinsics.test.ts:17` — **`rowFrameFromLine`/`widthCoordOf` 순수함수만** |
| `test/roiAutoHoldout.test.ts` | `bayGrid.ts` **소스 문자열 검사**(금지 심볼·색채널·`Math.random`). 이번 변경은 금지 심볼을 추가하지 않으므로 통과. **소스 해시 봉인은 아니다** |
| `test/bayGeometry.test.ts:276` 골든 해시 | **구경로 `detectBays`** 의 결정론 봉인이라 `bayGrid` 경로와 무관 |

> **결론: 3553 테스트 중 이 변경을 지켜 주는 테스트가 하나도 없다. 신규 테스트를 반드시 써야 한다.**

### 5-2. 신규 유닛테스트 — `test/bayGridRefitGate.test.ts` (신규 파일)

**입력 구성 방침(중요):** `detectBaysWithModel` 은 `candidates` 를 **인자로 받는다.** 따라서 `detectPaintLines` 의 출력에 의존하지 않고 **참 근변선을 소량 섭동한 `RowCandidate` 를 손으로 만들어 주입**할 수 있다. 이렇게 하면 재적합이 **반드시 움직일 것**이 보장되어 테스트가 흔들리지 않는다.

합성 장면은 `test/bayGeometry.test.ts:64-151`(`backproject`/`trueCorners`/`drawSegment`/`synthFrame`)과 **같은 방식**으로 새 파일 안에 최소 형태로 구성한다(기존 테스트 파일을 리팩토링해 헬퍼를 빼내지 마라 — 외과적 변경 원칙).

| # | 케이스 | 설정 | 단언 |
|---|---|---|---|
| **T1** | **ⓑ 비트 보존**(가장 중요) | `calibrateHeight:true` + `maxHeightCorrection:0`(계수 강제 기각) | `refitFrontLine:true` 결과 ≡ `refitFrontLine:false` 결과 (**`JSON.stringify` deep-equal**, `issues` 포함). 즉 ⓑ 에서 재적합이 **돌지 않았음**을 증명 |
| **T2** | **ⓐ 가 ③ 에 도달한다** | `calibrateHeight:false` + `refitFrontLine:true` + `frame` 제공 | `issues` 에 `근변선 재적합 pass` 로 시작하는 항목이 **1건 이상** |
| **T3** | **ⓐ 의 재적합 OFF 는 옛 동작 그대로** | `calibrateHeight:false` + `refitFrontLine:false` | `issues` 가 **빈 배열**, `best.calibration === null`, `best.modelUsed.d === model.d`(보정 안 된 공칭 지상고) |
| **T4** | **ⓐ 는 지상고를 건드리지 않는다** | T2 결과 | `best.calibration === null` **그리고** `best.modelUsed.d === model.d` — 재적합이 켜져도 **지상고 보정은 여전히 OFF** |
| **T5** | **결정론(R2)** | T2 설정으로 2회 실행 | 두 결과의 `JSON.stringify` 가 동일 |

- 추가로 `frame` 인자를 **주지 않은** 호출에서는 ⓐ 여도 ③ 이 돌지 않음(`bayGrid.ts:523` `if (frame && …)`)을 T3 변형으로 확인해도 좋다(선택).
- **테스트가 골든 픽스처(`test/fixtures/roiAutoGolden*`)에 의존하게 만들지 마라** — git 미추적이라 다른 환경에서 즉시 깨진다.

### 5-3. (선택·QA) ⓑ 빈도 프로브

15회차 QA 방식(`_qa_r15_probe/`)대로 `src/**`·`test/**` **밖**에 임시 프로브를 두고, 골든 v1·v2 60시점 × 2분기에서 `calib===null && calibrateHeight===true` 건수를 센다. 종료 후 삭제. `tsc`/`vitest` include 밖이라 회귀에 영향 없고 nodemon(`watch:["src"]`)도 건드리지 않는다.

### 5-4. 위험 표

| # | 위험 | 대응 |
|---|---|---|
| R-1 | 조기반환 수정이 정상 경로를 미세하게 바꾼다 | §2-4 (가)구조적 제약 + (나)B1·B2 바이트 대조. **어긋나면 즉시 중단** |
| R-2 | B/C 가 자동으로 B+/C+ 로 변해 15회차 비교 기반이 소실 | §3-1 `refitFrontLine:false` 명시. B2 대조가 이를 직접 검증 |
| R-3 | ⓑ 까지 열어 서비스 동작이 조용히 바뀐다 | §2-3 판단 고정 + T1 테스트가 구조로 못 박음 |
| R-4 | `roiAutoBench CALIB=0` 의미 변경이 문서화 없이 인용된다 | §4-2 문서화 필수. 14회차 수치 재현 조건 명기 |
| R-5 | 런타임(6모드 × 2세트) | 15회차 실적: 4모드 v1·v2 **병렬 ~46분**. 6모드면 ~70분 예상. **골든 모드는 읽기 전용**이라 v1/v2 동시 실행 안전. 백그라운드 실행 권장 |
| R-6 | `src/ground/bayGrid.ts` 편집이 13020 nodemon 재시작 유발 | `nodemon.json watch:["src"]` → **재시작한다.** 라이브 채점(`roi.auto.score`)과 겹치지 않는 시각에 편집하고 편집 시각을 로그에 남긴다. **서버를 수동으로 재시작하지는 마라** |
| R-7 | C+ `2:2` 가 0 으로 나와 "재적합이 망쳤다"로 오독 | §3-3. 득표 문자열로 동점 원인을 확인해 그대로 보고 |
| R-8 | 프레임 해시 누락 IoU 보고(F13) | 모든 표에 프레임 해시 병기. 없으면 표를 폐기 |

---

## 6. 측정 계획

### 6-1. 실행 순서 (각 단계에 통과 기준)

| # | 단계 | 명령/산출 | 검증(통과 기준) |
|---|---|---|---|
| **1** | `bayGrid.ts` 수정 | — | `npx tsc -p tsconfig.json --noEmit` **exit 0** |
| **2** | 신규 유닛테스트 작성 | `test/bayGridRefitGate.test.ts` | T1~T5 전부 green. **T1 이 실패하면 §2-4 구조 제약을 어긴 것** |
| **3** | 전체 회귀 | `npx vitest run` | **281+1 파일 · 3553+N 테스트 전량 green**(기존 3553 중 실패 0) |
| **4** | `roiAutoFuse.ts` 수정 | B/C 고정 + B+/C+ 추가 | `tsc` exit 0 |
| **5** | **게이트 B1** | `npx tsx src/tools/roiAutoFuse.ts > _workspace/16_gate_v1_A.log` | `15_fuse_v1_A_post.log` 와 **md5 `d8ac52be…` · 4719B 동일** |
| **6** | 본 측정 v1 | `npx tsx src/tools/roiAutoFuse.ts v1 A,A0,B,C,B+,C+ > _workspace/16_fuse_v1.log` | 완주(exit 0) |
| **7** | **게이트 B2** | `16_fuse_v1.log` 에서 `[A ]`/`[A0]`/`[B ]`/`[C ]` 행 + `=== ` 행 + `프레임 ` 행 추출 → `15_fuse_v1.log` 의 동일 추출과 diff | **바이트 동일**(diff 출력 0). 어긋나면 **즉시 중단·보고** |
| **8** | 본 측정 v2 | `npx tsx src/tools/roiAutoFuse.ts v2 A,A0,B,C,B+,C+ > _workspace/16_fuse_v2.log` | 완주. `15_fuse_v2.log` 대비 동일 추출 대조도 **바이트 동일** |
| **9** | 집계 | `_workspace/16_scoreboard.md` | §6-2 표 전량. 프레임 해시 병기 |

> 5·6·8 은 골든 세트 **읽기 전용**이라 병렬 실행 가능(권장: 6·8 동시, 5 는 먼저 또는 동시).
> **`roi.auto.apply` 금지 · 정본/DB 쓰기 금지 · 서버 재시작 금지 · `config/tools.config.json`·`src/config/*` 무접촉**(다른 작업 동시 진행 중).

### 6-2. 집계 표 (16_scoreboard.md 필수 항목)

1. **모드 × 변형 전체집계**(6모드 × 4변형 = 24행): `≥0.95 면수 · ≥0.98 면수 · 프리셋평균의평균`, v1/v2 각각.
2. **기준 ① 프레임 강건성**: 프리셋별 `|v1평균 − v2평균|`(변형 ③), 모드별.
   - **★ 필수 병기: 프리셋별 v1↔v2 프레임 해시 동일 시점 수**(15회차 실측 22/30 — `1:1` 0/6 · `1:2` 4/6 · `1:3`·`2:1`·`2:2` 각 6/6).
   - **6/6 동일인 프리셋(`1:3`·`2:1`·`2:2`)에서 ① 은 측정 자체가 불성립이다.** 0 이 나와도 "강건"이라 쓰지 마라 — **`측정불성립(프레임 동일 6/6)`** 으로 표기한다.
   - 실질 측정 가능 프리셋은 **`1:1`(0/6 동일)** 이고 `1:2`(4/6)는 부분이다. 지시서 기준①이 `2:1` 을 지목했으므로 **기준 재정의가 필요하다 → §8-Q2 로 리더에 올린다(임의 대체 금지).**
3. **기준 ② 무회귀 ±0.002**: 프리셋별 `모드평균 − 기준선평균`(변형 ③).
   - **기준선 2종을 모두 낸다**: `vs A`(재적합 ON 끼리 — B+/C+ 의 공정 비교) 와 `vs A0`(재적합 OFF 끼리 — B/C 의 공정 비교).
   - 15회차의 B `1:1 −0.01895` / `2:1 +0.07752` 를 같은 표에 그대로 두어 B→B+ 이동량이 보이게 한다.
4. **기준 ③ v2 기준 ≥0.95 통과면수**: A 대비, A0 대비 **양쪽 병기**.
5. **재적합 단독 기여분 3쌍**: `A−A0`, `B+−B`, `C+−C`(면수·평균). ★ 이번 라운드의 가장 직접적인 산출이다 — **세 값이 서로 다르면 "재적합 이득이 지상고 정책에 의존한다"는 새로운 사실**이므로 반드시 명시.
6. **증폭기 감도(G2)**: 모드별 `|v1−v2|`. **`toFixed(5)` 로 0 을 주장하지 마라**(15회차 함정 1). 5자리 미만은 `<5×10⁻⁶` 로 표기하거나 원시 배정도로 낸다.
7. **ⓑ 발생 건수**(§4-3 형식, 미보정 분기 미관측 명시).

### 6-3. 판정 규칙

- 위 표만 내고 **성공/기각 판정은 리더에 올린다.** 도구·구현자는 수치만 낸다.
- **면수가 안 오르면 그대로 보고한다.** 임계 조정·가중치 변경·대표 선택 규칙 손질로 면수를 만드는 것은 **이번 라운드 금지**.

---

## 7. 제약 준수 확인

### 7-1. 반증목록 20건(14회차 §16)과의 대조 — **재시도 0건**

이번 계획은 **알고리즘 파라미터를 하나도 바꾸지 않는다**(`phaseFitWeight`·`farWeight`·`aimCenterWeight`·`maxHeightCorrection`·`rowRefitPasses`·`rowRefitDamping`·`rowRefitUniformBins`·커버리지 전부 무변경). 특히:

- **#12 재적합 반복 증가 · #13 감쇠계수 0.5** — `rowRefitPasses:2`·`rowRefitDamping:1` **그대로**. 이번 변경은 "재적합을 **더** 돌리자"가 아니라 "재적합이 **꺼져 있던 조합에서 켜지게** 하자"다. 다른 명제다.
- **#11 `maxHeightCorrection` 15→5%** — 기본값 무변경. T1 테스트에서 `0` 을 쓰는 것은 **테스트 내 강제 조건**일 뿐 기본값 제안이 아니다.
- **#19 P2 좌표 융합** — 변형 ④ 를 서비스에 넣자는 제안이 아니다. 집계에만 남긴다.
- **#6 슬롯 치수 2.525** — 무관.

### 7-2. 금지사항 체크리스트 (구현자가 착수 전 확인)

- [ ] 정본 `data/Place01/PtzCamRoi.json` · DB **쓰기 0**
- [ ] `roi.auto.apply` **호출 0**
- [ ] 서버(13020/13021/13110) **수동 재시작 0** (nodemon 자동 재시작은 R-6 로 시각만 기록)
- [ ] `config/tools.config.json` · `src/config/*` **무접촉**
- [ ] 골든 픽스처 v1·v2 **읽기 전용**(sha256 전후 대조)
- [ ] `git add` 금지(커밋 여부는 리더 미결 A4)
- [ ] 시뮬 점수 튜닝 0줄

### 7-3. 파일 변경 목록

| 파일 | 상태 | 규모 |
|---|---|---|
| `src/ground/bayGrid.ts` | **수정** | 조건 1개 + 블록 1개(약 10줄 내). 시그니처·export 무변경 |
| `src/tools/roiAutoFuse.ts` | **수정** | 모드 태그 2개 + 분기 2개 + B/C 명시 + 상단 주석. 검출 로직 무변경 |
| `test/bayGridRefitGate.test.ts` | **신규** | T1~T5 |
| `_workspace/16_*.log` · `16_scoreboard.md` | **신규 산출물** | 로그·집계 |
| `src/ground/bayGeometry.ts` · `src/rpc/services/roiAuto.ts` · 다른 `src/tools/*` · `config/*` · 정본 · DB | **무변경** | |

### 7-4. 발견했으나 손대지 않는 것 (보고만 — 데드/개선 후보)

1. **`bayGrid.ts:506` probe 낭비** — `opts.calibrateHeight===false` 면 `calibrationFromGrid` 가 `:131` 에서 즉시 null 이므로 그 앞의 `fitRowGridOnce` 한 패스가 통째로 버려진다. B/C/B+/C+ 실행에서 검출 시간의 상당분이다. **관측 결과를 바꾸지 않는 순수 최적화**지만, 이번 라운드는 바이트 대조가 생명이라 **건드리지 않는다.** 17회차 후보.
2. **`roiAutoFuse.ts:72-73` 골든 판정 문자열 완전일치** — 끝 슬래시 하나로 `golden=false` 가 되어 라이브 캐시를 v1 픽스처 디렉터리에 쓴다(15회차 QA V4 부수). `resolve()` 통일 권고. **이번엔 고치지 않는다**(별건, 순위 4).
3. **`roiAutoFuse.ts:337` 동점 해소 = 최소 인덱스** — C `2:2` 붕괴의 직접 원인. **순위 3 별건.**

---

## 8. MCP 도구 vs LLM 두뇌 경계

| 항목 | 판정 | 근거 |
|---|---|---|
| 6모드 × 6시점 × 2분기 반복 검출·중앙값·집계 | **결정형 도구**(`npx tsx`) | 고빈도 수치 루프, 난수 0(R2). LLM 개입 시 비결정 |
| 재적합 반복(감쇠·지지하락 가드·stopPx) | **결정형 도구**(`src/ground`) | 수치 수렴 루프 |
| ⓐ/ⓑ 구분 판단, 기준①의 측정 성립 여부, 성공/기각 판정 | **LLM(리더)** | 맥락·트레이드오프 판단 |
| 서비스 배선 여부 | **LLM(리더)** | 이번 라운드는 **서비스 무변경** |

**신규 MCP 도구·RPC 메서드는 추가하지 않는다.**

---

## 9. 미해결 · 리더에게 올리는 질문 (임의 결정 금지)

| # | 질문 | 회신 없을 때의 기본 동작 |
|---|---|---|
| **Q1** | **ⓑ(계수 기각)에서도 재적합을 돌릴 것인가.** 설계자 권고는 **아니오**(§2-3). 그러나 "재적합은 지상고 정책과 무관해야 한다"는 일관성 논거도 성립한다. 다만 이는 **서비스 동작 변경**이고 뒷받침할 측정치가 0건이다 | **ⓐ 만 연다.** ⓑ 는 현행 유지 |
| **Q2** | **기준 ① 의 측정 대상 프리셋 재정의.** 지시서는 `2:1`(0.112→≤0.02)을 지목했으나 v1↔v2 프레임이 **6/6 동일**이라 측정 불성립이다. 실질 측정 가능한 것은 `1:1`(0/6 동일)뿐 | **`2:1` 은 `측정불성립` 으로 표기**하고, `1:1` 격차를 **참고치**로만 병기. 대체 판정하지 않음 |
| **Q3** | **기준 ② 의 기준선이 A 인가 A0 인가.** 16회차 이후 B+/C+ 는 A 와 재적합 조건이 같아져 `vs A` 가 공정해진다. B/C 는 여전히 `vs A0` 가 공정하다 | **양쪽 병기, 판정 보류** |
| **Q4** | 14회차 `CALIB=0` 수치의 재현 조건이 바뀐다(§4-2). `roiAutoBench` 에 `REFIT` 환경변수를 추가할 것인가 | **추가하지 않는다.** 문서 각주로만 처리 |
| **Q5** | 새 `bayGrid` 동작을 서비스에 노출할 계획이 있는가(= 언젠가 서비스를 `calibrateHeight:false` 로 돌릴 것인가) | **없다.** 이번 라운드 서비스 무변경. 배선은 수치가 기준②를 넘긴 뒤 별도 결정 |
| **Q6** | 6모드 × 2세트 런타임(~70분 × 2, 병렬 가능)을 승인하는가 | **실행한다**(골든 읽기 전용·정본 무접촉이므로) |

---

## 10. 구현자 · 문서화 전달 사항

### 구현자(developer)

1. **순서를 지켜라**: §6-1 의 1→2→3→4→**5(게이트 B1)**→6→**7(게이트 B2)**→8→9.
   **게이트 5·7 을 통과하기 전에는 B+/C+ 수치를 한 줄도 인용하지 마라.**
2. `bayGrid.ts` 편집은 §2-4 (가)의 **허용 편집 2가지**를 벗어나지 마라. 인접 주석·포맷 개선 금지, 변수명 정리 금지, `probe` 최적화 금지(§7-4-1).
3. `roiAutoFuse.ts` 의 B/C `heightNote` **문자열을 바꾸지 마라** — B2 바이트 대조가 깨진다. B+/C+ 문구는 새로 만들어도 된다.
4. 기존 파일의 주석 밀도·문체(★ 표기, 실측 근거 명시, 한글)를 그대로 따른다.
5. **보고에 프레임 해시를 반드시 병기**(F13). 동일성 주장은 **원시 배정도**로 하라(`toFixed(5)` 금지, 15회차 함정 1).
6. 미측정 항목은 **`미측정`** 으로 남겨라. 보간·추정으로 채우지 마라.

### 문서화(documenter) — 영향 범위 초안

- **수정**: `src/ground/bayGrid.ts`(조기반환 ⓐ 한정 해제) · `src/tools/roiAutoFuse.ts`(B/C 고정 + B+/C+)
- **신규**: `test/bayGridRefitGate.test.ts`
- **무변경**: `src/rpc/services/roiAuto.ts` · `src/ground/bayGeometry.ts` · 다른 `roiAuto*` 도구 · 정본 · DB · config
- **반드시 문서에 실을 것**:
  - **서비스 기본 동작은 바뀌지 않는다**(서비스 `calibrateHeight:true` 고정 → ⓐ 미진입) — 근거와 함께.
  - `roiAutoBench` `CALIB=0` 의미 변경(§4-2)과 14회차 수치 재현 조건.
  - **F 목록 갱신 후보**:
    - **F15 정정**: "`calibrateHeight:false` 는 근변선 재적합도 함께 끈다" → **16회차부터 ⓐ 한정으로 해제.** 재적합 ON/OFF 는 `refitFrontLine` 이 단독 결정한다. **단 ⓑ(계수 기각)에서는 여전히 재적합이 돌지 않는다.**
    - **F17 후보**: `bayGrid` 경로에서 `calib` 인자는 **보고 전용**이며 기하에 영향이 없다(`bayGrid.ts:351,373`).
    - **F18 후보**: 골든 v1·v2 tilt 보정 분기 60시점에서 **자가보정 기각(ⓑ) 0건**(최대 계수 +5.6%, 게이트 15%).
