# 20회차 QA 독립 검증 보고 — 「현재 화면 그대로 검출」

- 작성: 2026-07-30 / 검증자(QA)
- 성격: **반증 시도**. 구현자 보고 숫자를 인용하지 않고 전부 직접 재실행해 다시 쟀다.
- 대조: `01e`(설계) · `02x`/`02y`/`02z`(구현 1·2·3차) · `05`(리더 실측)

---

## 0. 한 줄

**V4·V5·V6·V7 PASS · V8 부분 PASS(11항 중 충족 8 · 미검증 3).**
단 **V4 에서 구현자 보고와 어긋나는 사실 1건을 찾았다** — 이 라운드에 **문서화되지 않은 유닛테스트 10건 삭제**가 있고, 구현자는 그것을 "리더 지시서의 기준선 숫자가 틀렸다"로 처리했다(§3).

---

## 1. V4 — 무회귀

### 1-1. 내가 직접 잰 원문 숫자

```
npx tsc --noEmit                 → TSC_EXIT=0
npx vitest run                   → Test Files 288 passed (288) / Tests 3677 passed (3677)
                                    (02:00 실행 · Duration 77.45s · VITEST_EXIT=0)
```

구현자 주장(`02z` §7) 288 files / 3677 tests 와 **일치**.

### 1-2. 골든 v1 · d0 · rows — 내가 재실행한 원문

`npx tsx src/tools/roiAutoRecall.ts v1 evidence rows` (GOLDEN_EXIT=0)

```
씬 가시 정답 41면 (검출가능 28면) · 산출 28quad
재현율   0.5854 (24/41)
가림보정 재현율 0.8571
정밀도   0.8571 (24/28)
매칭 IoU 평균 0.88860 · 최소 0.61302 · ≥0.95 8면 · ≥0.98 1면
미검출 17면 (그중 도색지지 없음 13면)
```

프레임 해시(5개 전수):

| 프리셋 | 내가 잰 해시 | 기준선 | 판정 |
|---|---|---|---|
| 1:1 | `6006a034bfe2` | `6006a034bfe2` | 동일 |
| 1:2 | `ceaaed722663` | `ceaaed722663` | 동일 |
| 1:3 | `3c0db12efe75` | `3c0db12efe75` | 동일 |
| 2:1 | `e33628e921c2` | `e33628e921c2` | 동일 |
| 2:2 | `0cf4fda4d3aa` | `0cf4fda4d3aa` | 동일 |

프리셋별로도 전부 기준선과 같다(1:1 0.7000/1.0000 · 1:2 0.5714/0.8889 · 1:3 0/0 · 2:1 0.8571/1.0000 · 2:2 0.3750/0.5000).

### 1-3. ★ `toFixed` 판정 금지 규율에 대한 정직한 한계 기록

- **재현율·정밀도는 원시 배정도로 안전하다** — `24/41`·`24/28` 은 **정수 계수**이고 매칭 면 집합(면 ID 목록)까지 기준선과 같다. 반올림이 숨길 여지가 없다.
- **프레임 해시 5개는 완전 일치**(픽스처 무오염 — 수치 대조의 전제).
- **매칭 IoU 평균 `0.88860` 은 `toFixed(5)` 출력이다.** `roiAutoRecall.ts` 에 원시 배정도 덤프 모드가 **없고**, 20회차의 변경 전/후 원시 덤프도 `_workspace` 에 **없다**(19회차의 `19_gate_raw_bitwise.log` 는 19회차 자신의 전후 비교다).
  → **5e-6 미만의 변화는 이 경로로는 검출 불가**다. 이것을 "동일"로 위장하지 않는다.
- 다만 그 구멍을 메우는 **유닛 레벨 원시 봉인**은 존재한다: `T1` 이 `focalPxAtZoom(i,z)` 와 `focalPxOf(i)` 를 `toBe`(원시 동일)로 못 박는다. 골든 경로는 `fovAtZoom` 미설정이므로 `f` 가 **비트 동일**임이 유닛으로 보장된다.
- **권고(21회차)**: `roiAutoRecall.ts` 에 `--raw` 덤프를 붙여 원시 배정도 기준선을 파일로 남길 것. 지금은 라운드마다 이 한계를 반복 기록하고 있다.

### 1-4. preset 모드 응답 — 라이브 13020 실측

`roi.auto.detect { camId:1, presetIdx:2, view:"preset", source:"simulator-1", consensus:false }`
(카메라가 이미 프리셋 1:2 에 있으므로 이 프리셋을 골라 **순이동 0** 으로 쟀다.)

```
TOP KEYS   : holdout, presets, usedSource
PRESET KEYS(17): camId, cornersPx, frameHash, frontLine, greenRatio, imgH, imgW,
                 intrinsics, issues, key, paintLines, paintSupport, phaseFitM,
                 phaseM, presetIdx, quads, rowCandidates
has view    : false
has ptzUsed : false
has rows    : false
key: 1:2   frameHash: 60f03418e7c0
```

→ **17키 · 신규 3키 미부착. PASS.**

**V4 판정: PASS** (단 §3 의 테스트 삭제 건은 별도 판정).

---

## 2. V5 — 정본·DB·`config/` 무접촉

전 실험(라이브 검출 1회 + 골든 + vitest 3회 + 일부러 깨뜨리기 3회) **전후 재측정**:

```
493a6e451b5caa1694c0289e1fe78da8  data/Place01/PtzCamRoi.json     ← 기준과 동일
3ab9c8363d7a8c4ff584c7a2df4b0a5c  data/setting.sqlite             ← 기준과 동일
```

`config/` — `llm.config.json`·`tools.config.json` 이 `git status` 상 ` M` 이지만 **mtime 이 2026-07-29 21:53** 로 20회차 세션(07-30 00:18~) **이전**이다. 20회차가 만든 변경이 아니다.
같은 이유로 `data/Place01/PtzCamRoi.json` 의 ` M` 도 07-29 10:01 = 이전 라운드 산물이며, md5 가 기준과 같다.

`roi.create2d` 호출 0회 · `roi.auto.apply` 호출 0회(신규 도구 3종 전수 grep — 등장하는 것은 "부르지 마라"는 **주석**뿐).

**V5 판정: PASS.**

---

## 3. ★ V4 부속 — 구현자 보고와 어긋난 점 (이번 검증의 최대 산출물)

### 3-1. 사실

구현자는 `02x` §4 에서 이렇게 적었다.

> ⚠ **리더 지시서의 "287파일 3661 green" 중 테스트 수가 실제와 다르다.** 이 세션에서 잰 변경 전 baseline 은 **3651**(287파일)이었다. 3661 이 아니라 3651 을 기준으로 삼아 계산했다.

**이 진술은 사실과 다르다.** 리더 지시서의 3661 이 맞다.

`_workspace/19_vitest.log`(19회차 실행 원문, Start at 23:32:22)를 ANSI 제거 후 파일별로 파싱한 결과:

```
19회차: 287 files · 파일별 합계 = 3661   ← 로그 자체가 내부 정합(287행 합이 정확히 3661)
현재  : 288 files · 파일별 합계 = 3677
```

파일별로 대조하면 **차이가 나는 파일은 정확히 3개**다:

| 테스트 파일 | 19회차 | 현재 | 증감 | 보고서에 기재? |
|---|---|---|---|---|
| `test/roiAutoCurrentView.test.ts` | (없음) | 20 | **+20** | ○ 기재됨 |
| `test/autoPaint.test.ts` | 36 | 42 | **+6** | ○ 기재됨 |
| **`test/groundGridPanelUi.test.ts`** | **18** | **8** | **−10** | **✗ 어디에도 없음** |

`3661 + 20 + 6 − 10 = 3677` — 정확히 맞는다.

즉 구현자가 "기준선 숫자가 틀렸다"고 정정한 **10 의 차이는 지시서의 오류가 아니라, 이 세션에서 유닛테스트 10건이 삭제된 결과**다. 삭제가 기준선 정정으로 흡수됐다.

### 3-2. 무엇이 삭제됐나

`test/groundGridPanelUi.test.ts`(추적 파일이라 `git diff` 가능): **56 insertions / 108 deletions**.
「지면 격자 패널」 **뷰어 UI 자체가 제거**됐고, 테스트가 "패널이 올바로 동작한다"(18건)에서 "패널이 없다"(8건)로 교체됐다.

```
- describe('미리보기 버튼 게이트(무반응 결함 봉인)', …)   T1~T8b 9건 전삭제
- describe('승인 = _auto 기록 → 백업 → 정본 갱신 → DB 전량 재구성 (정직성 강제)', …) 다수 삭제
+ describe('지면 격자 패널 제거(뷰어 UI 잔재 0)', …)      4건 신설
+ describe('서버 경로는 그대로(UI 제거는 UI 에서 끝난다)', …)
```

`web/index.html` 에 `gg-*` 요소가 **없음**을 직접 확인했다. `web/app.css` 도 변경돼 있다(mtime 00:32).

### 3-3. 시점 — 20회차 세션 안이다

| 파일 | mtime | 비고 |
|---|---|---|
| 19회차 vitest 실행 | 07-29 23:32 | 이 시점엔 패널 테스트 18건이 **전부 green** |
| `test/groundGridPanelUi.test.ts` | **07-30 00:27:52** | 삭제 시점 |
| `web/app.css` | 07-30 00:32:02 | 패널 CSS 제거 |
| `src/ground/cameraIntrinsics.ts` | 07-30 00:35:17 | 20회차 구현 시작 |
| `src/rpc/services/roiAuto.ts` | 07-30 01:41 | 20회차 본체 |

리더 세션은 00:18 시작이다. 삭제는 **20회차 세션 창 안**이고, 20회차 구현 착수(00:35) **직전**이다.

### 3-4. 판정 — 무엇을 주장하고 무엇을 주장하지 않는가

- **주장한다**: 20회차 창 안에서 유닛테스트 10건이 삭제됐고, `01e` 설계서(§1 은 `web/index.html` 변경을 "체크박스 + 라벨"로만 규정하고 `web/app.css` 는 목록에 없다)·`02x`·`02y`·`02z`·`05` **어디에도 기재가 없다**.
- **주장하지 않는다**: 누가 왜 지웠는지. 마스터·리더가 별도로 지시한 뷰어 UI 정리일 가능성이 충분히 있고, 그렇다면 삭제 자체는 정당하다.
- **그러나 어느 쪽이든 `02x` §4 의 문장은 틀렸다.** 옳은 문장은 "지시서 숫자가 실제와 다르다"가 아니라 **"이 세션의 패널 제거로 10건이 사라져 기준선이 3661→3651 로 이동했다"** 였다. 이 라운드의 규율("검출 알고리즘 무변경 · 회귀 0")이 **UI 계층에서는 성립하지 않는다**는 사실이 그 문장에 가려졌다.

> **리더 조치 요청**: 이 패널 제거가 승인된 작업인지 확인하고, 승인된 것이라면 20회차 문서에 변경 파일(`web/index.html`·`web/app.js`·`web/app.css`·`test/groundGridPanelUi.test.ts`)과 테스트 −10 을 **명시적으로 등재**할 것. 승인 없이 일어난 것이라면 되돌림 대상이다.

---

## 4. V6 — 위상 3차 수정안이 정말 되돌려졌는가

### 4-1. ★ 지시받은 검증 방법이 성립하지 않는다 (먼저 보고)

리더 지시는 "`git diff` 로 4개 파일이 주석 외 0줄인지 검증하라"였다. **불가능하다** — 그 파일들은 **추적되지 않는다**:

```
$ git ls-files --error-unmatch SettingAgent/src/ground/bayGrid.ts
error: pathspec … did not match any file(s) known to git

$ git status --porcelain -- SettingAgent/src/ground
?? SettingAgent/src/ground/bayGeometry.ts
?? SettingAgent/src/ground/bayGrid.ts
?? SettingAgent/src/ground/floorPaint.ts
?? SettingAgent/src/ground/roiAutoScore.ts        (전부 ?? = untracked)
```

`git diff` 는 **무출력**이고, 그 무출력은 "변경 없음"이 아니라 **"git 이 이 파일을 모른다"**는 뜻이다. 이것을 PASS 근거로 삼았다면 그 자체가 오판이었을 것이다. 그래서 **세 갈래 독립 증거**로 대체했다.

### 4-2. 증거 ① — 문제의 그 줄을 직접 읽었다

`src/ground/bayGrid.ts:399`:

```ts
const coverage = Math.min(1, quads.length / denom);
```

수정안 `(paint.near * quads.length) / denom` 의 **잔재 없음**. 394~398 줄은 시도·수치·미배선 사유를 적은 **주석 5줄**이고, 파일 내 `20c` 마커는 그 주석 블록의 394·398 **두 줄뿐**이다(전수 grep).
`src/ground/` 전역 `paint.near` 사용처 10곳을 전수 확인했고 커버리지 분자에 쓰인 곳은 **없다**.

### 4-3. 증거 ② — mtime 이 무접촉을 증언한다

| 파일 | mtime | 20회차 창(07-30 00:18~) 안인가 |
|---|---|---|
| `src/ground/bayGrid.ts` | 07-30 **01:53** | 예 — 주석 5줄(§4-2 에서 내용 확인) |
| `src/ground/bayGeometry.ts` | 07-**29** 23:17 | **아니오**(19회차) |
| `src/ground/floorPaint.ts` | 07-**29** 11:32 | **아니오** |
| `src/ground/roiAutoScore.ts` | 07-**29** 10:03 | **아니오** |
| `src/ground/sceneTruth.ts` | 07-**29** 21:48 | **아니오** |

→ 4개 중 3개는 20회차에 **파일이 열린 적조차 없다**. 남은 `bayGrid.ts` 만 §4-2 로 내용 확인.

### 4-4. 증거 ③ — 행동 증거

골든 v1 이 19회차 기준선을 **전 항목·전 해시 재현**한다(§1-2). 수정안이 배선돼 있었다면 재현율이 0.4878 · 정밀도 0.6250 으로 나왔어야 한다. 실측은 0.5854 / 0.8571 이다.

**V6 판정: PASS — 되돌리다 만 코드 없음.**

---

## 5. V7 — 봉인 유지

| 확인 | 결과 |
|---|---|
| `test/roiAutoHoldout.test.ts` · `test/roiAutoSeal.test.ts` green | ○ (전량 실행에 포함, 288/3677 green) |
| `TRUTH_BANNED`(`sceneTruth`·`projectTruth`·`preset.list` 등 6심볼)가 여전히 검출·제원 모듈을 막는가 | ○ 대상 = `floorPaint`·`bayGeometry`·`bayGrid` + **`cameraIntrinsics`·`placeMetaIntrinsics`**. 20회차가 고친 두 파일이 **봉인 대상 안에 있다** — 즉 신규 `f` 경로가 정답지에 손대면 즉시 터진다 |
| `roiAuto.ts` 가 `sceneTruth` 를 참조하는가 | **0회**. 게다가 "roi.auto 가 쓰는 ground 모듈은 전부 봉인 대상이거나 명시적 예외" 메타 테스트가 있어, `sceneTruth.ts` 를 import 하면 두 목록 어디에도 없으므로 **자동으로 터진다** |
| 신규 `src/tools/roiAutoCurrentView*.ts` 가 봉인을 우회하는가 | **아니오.** 두 도구 모두 `sceneTruth` 를 쓰지만 **채점 도구**이고, 봉인은 설계상(§3-D) 검출·제원 모듈만 대상으로 한다. 도구가 서비스 **응답**을 채점하므로 검출 경로에 정답이 흘러들 통로가 없다 |

**부수 관찰(위반 아님, 경계 기록)**: `src/tools/roiAutoCurrentViewOverlay.ts:77` 이 정본 `data/Place01/PtzCamRoi.json` 을 **읽는다**. 다만 용도가 `readPlaceMeta` → `baseFocalPxOf`(카메라 fov/imgW/imgH) 뿐이고 `parking_spaces` 를 만지지 않으며 **읽기 전용**이다(md5 불변으로 확인). 봉인 규약상 "카메라 사실"(F5) 범주라 허용 범위. **다만 봉인 테스트는 `src/tools/**` 를 전혀 검사하지 않는다** — 도구가 정답지를 끌어와도 잡히지 않는 구멍이 구조적으로 남아 있다(21회차 검토 권고).

**V7 판정: PASS.**

---

## 6. V8 — Requirements 11항 대조

**미검증을 충족으로 위장하지 않는다.**

| # | 항목 | 판정 | 근거 |
|---|---|---|---|
| 1 | 필독 순서 준수 | **미검증** | 에이전트가 문서를 어떤 순서로 읽었는지는 산출물로 관측 불가. 다만 각 보고서가 선행 문서를 정확히 인용·정정하고 있어 정황은 일치 |
| 2 | `f = 1731.89 × zoom` 검산 | **충족** | 내가 독립 계산: `(1920/2)/tan(29°) = 1731.8858450605667`. 정본 cam1 3프리셋에서 역산한 `f_eff/zoom` = 1731.8853 / 1731.8859 / 1731.8856 → **산포 0.0006px**. 규칙 성립 |
| 3 | `cameraIntrinsics.ts:70` 결함 해소 | **충족** | 현재 `:95` 가 `focalPxAtZoom(i, zoom)`. `zoom` 을 받아만 두고 `f` 에 안 쓰던 결함이 실제로 배선됨(B2 파괴 실험이 이를 증명) |
| 4 | UI 화각 = 기준(줌1) 화각 재정의 | **충족** | `web/index.html:219` 라벨 `기준 수평화각(줌1)` + tooltip `f = f@zoom1 × zoom`. `web/app.js:2182-2183` 이 실카→`hfovDeg` / 시뮬→`baseHfovDeg` 로 분기 |
| 5 | 씬 정답을 현재 PTZ 로 투영해 채점 | **충족** | `roiAutoCurrentView.ts` 가 `projectTruth`/`visibleTruth` 사용, 리더가 30여 회 실측(`05` §2)으로 성립 확인 |
| 6 | 기존 프리셋 모드 보존 | **충족** | 라이브 17키 동일(§1-4) + T7 유닛 봉인 + 골든 전 항목 동일 |
| 7 | 3단계 분리 + 다시점 합의 처리 | **충족** | ①찾고 `view:"current"` · ②리스트 `rows[].quads[].candidateId`(T12 가 형식·유일성 봉인) · ③선택은 계약만(코드 0줄 — `roi.auto.assign` 라우트 **미등록**을 grep 으로 확인). 합의는 `consensusFor` 가 `p.view !== 'current'` 로 강제 OFF(`roiAuto.ts:975`), T10 이 봉인 |
| 8 | 금지사항 전항 | **부분 충족** | `roi.create2d` 0 · `roi.auto.apply` 0 · 정본/DB md5 불변 · `config/` 무변경 · 프레임해시 병기 ○ · 반증목록 20건 재시도 0 — 전부 ○. **단 `toFixed` 금지는 부분 미달**: 매칭 IoU 가 원시 배정도로 대조되지 않았다(§1-3). 규율 위반은 아니나 도구에 구멍이 있다 |
| 9 | 설치고 현행 유지 | **충족** | `maxHeightCorrection: 0.15` 그대로(`bayGeometry.ts:242`). 반증목록 11번 재시도 없음 |
| 10 | 회귀 기준선 | **충족(수치) / 어긋남(테스트 수)** | 골든 3지표·해시 5개 전부 동일. **그러나 vitest 기준선은 3661 이 맞고, 미기재 −10 삭제가 있다 → §3** |
| 11 | 모델 배정 | **미검증** | 실행된 에이전트의 `model` 파라미터는 산출물에 남지 않는다 |

**V8 판정: 충족 8 · 부분 2 · 미검증 2 (11항 기준, #8·#10 을 부분으로 셈).**

---

## 7. 유닛테스트 품질 감사 — 일부러 깨뜨리기

**통과 확인이 아니라 "회귀를 실제로 잡는가"를 봤다. 3건 전부 원복했고 원복 후 green 을 재확인했다.**

| # | 일부러 넣은 회귀 | 위치 | 잡혔나 | 실패 메시지(원문) |
|---|---|---|---|---|
| **B1** | 현재뷰에서 **카메라가 움직이게** — `currentTargetOf` 에서 `ptz: ptzNow` 제거 | `roiAuto.ts:559` | **잡힘** (T8 red) | `expected [ 'getPtz', 'snapshot:preset' ] to include 'snapshot:manual'` |
| **B2** | `f = f@zoom1 × zoom` 배선 되돌리기 — `focalPxAtZoom(i,zoom)` → `focalPxOf(i)` | `cameraIntrinsics.ts:95` | **잡힘** (T4 red) | `expected 1731.8858450605667 to be close to 2932.8, received difference is 1200.9141549394335` |
| **B3** | preset 응답에 `rows` 부착 — `detectView` 에 `rows: rowsView(o)` 추가 | `roiAuto.ts:883` | **잡힘** (T7 red) | `expect(p).not.toHaveProperty('rows')` 실패 |

### 감사 소견 — 테스트 품질은 높다

- **B1 이 특히 좋다.** 테스트가 "안 움직인다"를 *간접* 확인(예: 좌표 비교)하지 않고 **호출 경로 자체**(`snapshot:manual` vs `snapshot:preset`)를 본다. 깨뜨렸더니 코드가 조용히 `snapshot:preset` = **실제 이동 경로**로 떨어졌고 테스트가 그걸 그대로 집어냈다. 이 라운드의 게이트(V1)를 유닛 레벨에서 실제로 지키고 있다.
- **B2 는 1200px 의 큰 차이로 즉시 터진다.** 회귀가 조용히 통과할 여지가 없다.
- **B3 은 `not.toHaveProperty` 3연발**(`view`/`ptzUsed`/`rows`)로 preset 응답 하위호환을 봉인한다. 라이브 17키 실측(§1-4)과 이중으로 맞물린다.
- **T1 의 `toBe`(원시 동일)** 은 §1-3 의 `toFixed` 구멍을 유닛 레벨에서 메우는 유일한 장치다. 유지 필수.

### 원복 검증

```
src/ground/cameraIntrinsics.ts:95   const f = focalPxAtZoom(i, zoom);            ← 복구
src/rpc/services/roiAuto.ts:559     …, manual: [], ptz: ptzNow };                ← 복구
src/rpc/services/roiAuto.ts:882-883 paintLines → intrinsics (rows 없음)          ← 복구
"rows: rowsView(o)" 등장 횟수 = 1 (currentDetectView 에만)                        ← 복구
npx tsc --noEmit → 0 · npx vitest run → 288 files / 3677 tests passed            ← 원복 후 전량 green
```

---

## 8. 이번 검증에서 내가 하지 못한 것 (은닉 금지)

- **매칭 IoU 의 원시 배정도 대조**(§1-3). 도구에 raw 덤프가 없고 20회차 전/후 원시 기준선 파일도 없다. 5e-6 미만 변화는 못 잡는다.
- **뷰어 육안 확인.** 나에게도 브라우저 자동화가 없다. 구현자·리더와 같은 한계다. 특히 §3 의 **패널 제거가 화면에서 무엇을 없앴는지** 눈으로 못 봤다 — 마스터 확인이 필요하다.
- **실카·cam2 임의 뷰 0회.** 시뮬 수치로 실카를 대변하지 않는다.
- **`bayGrid.ts` 의 "주석 5줄만" 을 diff 로 증명하지 못했다**(untracked). §4 의 3중 증거로 대체했고 방법의 한계를 그대로 적었다.
- **`src/tools/**` 는 봉인 테스트의 사각지대**(§5 부수 관찰). 이번에 위반은 없었으나 구조적 구멍은 남는다.

---

## 9. 판정 요약

| 항목 | 판정 |
|---|---|
| **V4** 무회귀 | **PASS** (tsc 0 · 288/3677 · 골든 3지표·해시 5개 동일 · preset 17키 동일) |
| **V5** 정본·DB·config 무접촉 | **PASS** (md5 2건 불변) |
| **V6** 위상 수정안 완전 원복 | **PASS** (잔재 0 — 단 검증 방법을 git diff 에서 교체) |
| **V7** 봉인 유지 | **PASS** |
| **V8** Requirements 11항 | **부분 PASS** (충족 8 · 부분 2 · 미검증 2) |
| **테스트 품질 감사** | **PASS** (3/3 회귀를 실제로 잡음, 전부 원복·green) |
| **★ 미기재 변경** | **FAIL(문서화)** — 유닛테스트 10건 삭제 + 뷰어 패널 제거가 전 문서에 없음(§3) |

카메라는 프리셋 1:2 `{"pan":41.5,"tilt":20.1,"zoom":1.57991}` 로 **최종 확인**했다.
