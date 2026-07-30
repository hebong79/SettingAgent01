# 21회차 실행 계획 — 주차면 개별 독립 검출 (면별 독립 닫힘, A안)

- 작성: 2026-07-30 11:54 / 설계자
- 설계서: `docs/20260730_115425_주차면_개별독립검출_설계.md` (근거·비교표·반증대조는 그쪽)
- 이번 산출물: **설계서 2건. 소스 0줄 변경.**
- ★ 착수 전 리더 확인 5건(설계서 §12) — 특히 **#1(착수 순서 ① 건너뛰기)** 과 **#2(정밀도 게이트 완화)** 는 리더 확정 결정과 충돌한다.

---

## 0. 한 문장

행 단위 격자·행 점수·개수 분모를 쓰지 않고, **인접한 두 분리선(위치) + 규격 치수(2.5×5.0m)** 로 주차면을 **하나씩** 닫아 면별 게이트 2개로 채택하고 `quadIoU` 배타성만 해소한다. `expectedBays` 는 신규 경로 시그니처에 **없다**.

---

## 1. 단계 → 검증 (각 단계 통과 후 다음)

```
0-a. roiAutoRecall.ts 에 --raw (원시 배정도 IoU 덤프)
     → 검증: 골든 3지표가 toFixed 없이 재현. 재현율 24/41 · 정밀도 24/28 · meanIoU 원시 자리 노출.
             프레임해시 6006a034bfe2/ceaaed722663/3c0db12efe75/e33628e921c2/0cf4fda4d3aa 5개 일치.

0-b. ★ src/tools/sepAudit.ts 신규 — 분리선 감사(채점 도구 = 씬 정답 참조 허용)
     골든 5프레임 + 임의 뷰 A(프레임 캐시 reports/overlay_r20/frames/A_cam1.jpg) 에서
     · 참 면 경계 폭좌표 vs 정련 분리선 폭좌표 오차 분포(median/p90/max, m 단위)
     · 참 경계 적중률(±0.25m 안에 분리선이 있는 비율)
     · 행당 오검출 분리선 수 · 분리선 2개 미만인 행 비율
     → 검증: 위 4수치가 프레임별·전체로 출력된다(숫자가 나오는 것이 통과).
     → ★ 분기 판정: 적중률이 문턱 미만이면 A안 재현율 상한이 그 값에 묶인다 → B안(격자후보+면별승격) 전환.
        문턱값은 리더 확인 #3.  ※ 이 수치를 추정으로 채우지 마라 — 설계서 §9-1.

0-c. roiAutoRecall.ts 진단 1행 추가 — filledIndices 유래 quad 중 정답과 매칭된 수
     → 검증: 골든 매칭 24면 중 보간 기여 면수가 정수로 출력. (가림 트레이드오프의 실측 근거)

1. src/ground/bayIndependent.ts 신규(설계서 §3-4 시그니처). 서비스 미배선.
   test/roiAutoHoldout.test.ts 의 DETECT_MODULES 에 추가(안 넣으면 메타 테스트가 배선 시점에 터진다).
   → 검증: ① 합성 장면(F9 경로) 면별 IoU ≥ 0.9879
           ② expectedBays ∈ {1,2,4,7,8,12,16} 전부 산출 quad 좌표 **비트 동일**  ← H2, 20c 가 7에서 뒤집힌 축 직격
           ③ 같은 입력 2회 호출 결과 동일(난수 0·순회 고정)
           ④ 봉인 테스트 green · Math.random 0
           ⑤ npx tsc --noEmit exit 0 · npx vitest run 전량 green

2. roiAutoRecall.ts 에 --engine=lattice|independent · --no-interp. 골든 A/B.
   → 검증(게이트): H1 lattice 가 기준선 원시 재현 / H3 재현율(증거+보간) ≥ 0.5854 /
                   H4 매칭 IoU ≥ 0.88860 / H5 정밀도(증거만) ≥ 0.70(★리더 승인 필요)
                   + 증거만·증거+보간 **두 벌** 보고 + 프레임해시 5개 병기
   → 탈락 시 배선 금지(20c 규율 계승: 게이트 못 넘기면 되돌리고 수치만 남긴다)

3. 임의 뷰 검증 — roiAutoCurrentViewOverlay 에 엔진 스위치. 프레임 캐시 재사용(카메라 무이동).
   → 검증: H6 — expectedBays **미지정**으로 A 조건 재현율 ≥ 0.6000,
           리더 pan 스윕 6점(31.5·36.5·41.5·46.5·51.5·56.5) 매칭 IoU 최솟값이 현행 0.673 보다 개선
           + 오버레이 PNG 육안(초록=정답, 빨강=증거검출, 자홍=보간)

4. 서비스 옵트인 배선.
   roi.auto.detect 에 engine?:'lattice'|'independent' (기본 lattice).
   independent + view:'current' 이면 expectedBays 필수 거부 해제(roiAuto.ts:1020-1028 은 lattice 에서 유지).
   뷰어: 「예상 주차면 수」 칸 **비활성 + 안내문**(제거 아님).
   → 검증: preset 모드 응답 **바이트 동일**(20회차 무회귀 기준) ·
           expectedBays 없이 현재뷰 정상 응답 · H7(tsc 0 · vitest green · 정본/DB md5 불변 · roi.auto.apply 0회)

5. 기본을 independent 로 전환. lattice 는 engine:'lattice' 회귀 비교 전용 영구 유지. 뷰어 칸 제거.
   → 검증: Phase 2·3 게이트 통과 + 리더/마스터 승인. 승인 없이 기본을 바꾸지 않는다.
```

---

## 2. 변경 파일 (Phase 별)

| Phase | 파일 | 종류 | 내용 |
|---|---|---|---|
| 0-a | `src/tools/roiAutoRecall.ts` | 수정 | `--raw` 플래그. `toFixed(5)`(`:198`·`:215`) 경로 옆에 원시 덤프 |
| 0-b | `src/tools/sepAudit.ts` | **신규** | 분리선 감사. `sceneTruth` 참조(채점 도구) |
| 0-c | `src/tools/roiAutoRecall.ts` | 수정 | 보간 유래 매칭 면수 1행 |
| 1 | `src/ground/bayIndependent.ts` | **신규** | 핵심 모듈. 순수·IO 0 |
| 1 | `test/bayIndependent.test.ts` | **신규** | H2(bays 불변) 포함 |
| 1 | `test/roiAutoHoldout.test.ts` | 수정 | `DETECT_MODULES` 에 신규 파일 추가 |
| 2 | `src/tools/roiAutoRecall.ts` | 수정 | `--engine` · `--no-interp` |
| 3 | `src/tools/roiAutoCurrentViewOverlay.ts` | 수정 | 엔진 스위치 |
| 4 | `src/rpc/services/roiAuto.ts` | 수정 | `engine` 파라미터 · `RowCandidateSeps` 조립(`:836-845`) · 현재뷰 거부 조건 |
| 4 | `web/index.html` · `web/app.js` | 수정 | 칸 비활성 + 안내 |
| 5 | `web/index.html` · `web/app.js` · `src/rpc/services/roiAuto.ts` | 수정 | 기본 전환 · 칸 제거 |

**무접촉(절대)**: `src/ground/bayGrid.ts` · `bayGeometry.ts` · `floorPaint.ts` · `sceneTruth.ts` · `roiAutoRecall.ts`(모듈) · `project.ts` · `roiAutoScore.ts` · `config/` · `data/Place01/PtzCamRoi.json` · `data/setting.sqlite`.
★ `bayGrid.ts` 0줄이 **A/B 기준선 무오염의 근거**다(20회차 함정 (d) 회피). 여기에 손이 가면 계획이 깨진 것이다.

---

## 3. 핵심 인터페이스 (전문은 설계서 §3-4)

```ts
export interface IndependentBay {
  rowKey: number; centerAM: number; quad: PixelQuad;
  origin: 'evidence' | 'interpolated';
  paint: PaintSupport;              // quadPaintSupport([quad]) — 면 1개 기준
  evidence: BayEvidence | null;     // interpolated 는 null
}
export interface IndependentOpts { widthTolRatio: number; interpolateGaps: boolean; }

export function detectBaysIndependent(
  candidates: readonly RowCandidateSeps[], model: GroundModel, evidence: PaintEvidence,
  paintOpts: PaintOptions, opts: BayDetectOpts, ind: IndependentOpts, frame?: FrameGray,
): IndependentDetection;   // ← 시그니처에 expectedBays 가 없다
```

```ts
/** cornersPx 와 **같은 순서·같은 길이**가 계약. meetLines 성공 시에만 두 배열에 동시 push. */
export interface RowCandidateSeps extends RowCandidate {
  sepQuality: Array<{ residPx: number; spanPx: number }>;
}
```

**핵심 결정 규칙 (구현자가 바꾸면 안 되는 것)**
1. **모든 쌍**(i<j) 열거. 인접 쌍만 보지 않는다 — 오검출 분리선 내성이 여기서 나온다.
2. 게이트① `|Δ − w| ≤ w·widthTolRatio` / 게이트② `paint.near ≥ extendMinNearSupport`(기존 0.35).
3. 위치 `aLo = (a_i + (a_j − w)) / 2` (관측 2개 평균). **치수는 규격 고정** — 측정 폭을 쓰지 않는다(U12: 현행 산출은 정확히 2.500/5.000).
4. 서열(배타성 순서만) `paint.score` desc → `|widthDevM|` asc → `rowKey` asc → `centerAM` asc.
5. 배타성 문턱은 **기존 `rowMergeIoU`(0.5) 재사용**. `quadIoU` 재사용(R4 — 신규 IoU 0줄).
6. 보간은 **채택 면 사이만**, 간격 `k·w`(k−1 ≤ `maxGap`), **외삽 절대 금지**, `origin:'interpolated'` 표기.
7. 근변선은 **행 단위**. `refitFrontLineOverRow` 그대로. **면별 재적합 금지**(U10 회전 편향 재발).
8. 신규 수치 튜닝 축은 `widthTolRatio` **1개**뿐. 다른 축을 추가하려면 리더 승인.

---

## 4. 밟지 말 것 (이번 계획 전용)

- **`side` 도색지지를 면별 신뢰도의 근거로 쓰지 마라.** 면의 좌우변이 검출된 분리선이면 `edgePaintSupport` 는 정의상 ≈1 이다 — **자기충족이며 정보 0**이다.
- **`bayGrid.ts`·`bayGeometry.ts` 에 한 줄도 넣지 마라.** 골든 A 기준선이 오염되면 Phase 2 가 해석 불능이 된다.
- **`toFixed` 로 무회귀 판정 금지.** Phase 0-a 를 먼저 끝내고 그 뒤 모든 비교는 `--raw` 로.
- **프레임 해시 없는 IoU 는 무효(F13).** 임의 뷰는 프레임 캐시를 고정해 한 장으로 스윕(20c 방식).
- **미측정을 채우지 마라.** `widthTolRatio` 값·분리선 정확도·보간 기여 면수는 **실측 전에는 숫자를 쓰지 않는다**. 모르면 "구현자 실측 필요".
- **반증목록 20건 재시도 금지.** 특히 #5(`phaseFitWeight` 무접촉 — 다만 현재 0 이라는 사실은 기록됨) · #7 · #10. 전수 대조표는 설계서 §10.
- `roi.create2d` · `roi.auto.apply` · 정본/DB 쓰기 · `config/` 변경 **금지**. Unity RPC 는 읽기만.
- 착수 시 `docs/` 를 당일 날짜로 정렬해 훑을 것(20회차 함정 (f) — 인계서 이후 별건 작업을 놓친다).

---

## 5. 문서화·영향도 초안 (documenter 에게)

- 영향 범위: `src/ground/`(신규 1파일) · `src/tools/`(신규 1 + 수정 2) · `src/rpc/services/roiAuto.ts`(Phase 4) · `web/`(Phase 4·5) · `test/`(신규 1 + 봉인 수정 1).
- 계약 변경: `roi.auto.detect` 에 `engine` 추가(기본 lattice → preset 모드 응답 바이트 동일). `view:'current'` 의 `expectedBays` 필수 → independent 에서 선택.
- 회귀 감시: 골든 v1 3지표 + 프레임해시 5개 · vitest 288/3677 · 정본·DB md5 `493a6e45…`/`3ab9c836…`.
- 강조할 개념 2개: (a) **위치는 증거·치수는 규격** (b) **증거로 찾은 면 vs 보간으로 만든 면의 구분(자홍 규약)**.

---

## 6. 미해결 / 가정 (리더 확인 필요)

| # | 항목 | 설계자 권고 |
|---|---|---|
| 1 | 착수 순서 ①(`rows` 문턱 분리)을 건너뛴다 | 건너뛴다 — A안은 오염 경로가 없고, ①은 A 기준선을 이동시킨다(설계서 §7-4). **리더 확정 결정과 충돌** |
| 2 | H5 정밀도 하한 0.8571 → 0.70 완화 | 완화(비용 비대칭 + 사람 선택 단계). **승인 없이 진행 금지** |
| 3 | Phase 0-b 의 B안 전환 문턱(적중률) | 0.70 제안이나 분포를 본 뒤 정하는 편이 옳을 수 있다 |
| 4 | 가림 대응 ⓐ(보간 없음) vs ⓑ(사후 보간) | ⓑ. 단 `interpolateGaps` 스위치로 두 답을 다 재고 마스터가 고를 수 있다 |
| 5 | 뷰어 칸: Phase 4 비활성 → Phase 5 제거 | 2단계(즉시 제거는 회귀 비교 수단 상실 + 함정 (f) 재발 위험) |

---

## ★ 리더 판정 (2026-07-30 · 확인 요청 5건 전부 결론)

설계자가 조용히 결정하지 않고 올린 것을 승인한다. 아래가 **착수 시 유효한 결정**이며, 되돌릴 근거는 각 행에 적었다.

| # | 항목 | **리더 판정** | 근거 |
|---|---|---|---|
| 1 | 착수 순서 ①(`rows` 문턱 분리) 건너뛰기 | **승인 — 건너뛴다.** ①을 「격자 경로를 계속 튜닝할 경우의 선행 과제」로 **재분류** | 내가 ①을 1순위로 정한 것은 **"격자 경로를 계속 튜닝한다"는 전제** 아래였다. 마스터가 방향을 바꿔 그 전제가 소멸했다. A안은 `bayGrid.ts` 를 0줄 고치므로 오염 경로가 없고, ①을 먼저 하면 비교 대상인 A 기준선이 움직인다. **설계자 반박이 옳다** |
| 2 | H5 정밀도 하한 0.8571 → **0.70** | **승인.** 단 **조건부** — 「증거만」 기준 재현율이 현행 0.5854 를 **넘지 못하면 완화를 정당화하지 못한다.** 정밀도만 내려가고 재현율이 그대로면 배선 금지 | 마스터 지시 1번이 "보이는 모든 주차면"이고 구상 3단계(찾고→**리스트**→선택)에 사람이 있다 → **오검출 비용 낮고 미검출 비용 높다.** 19회차가 정밀도를 0.1832→0.8571 로 올린 성과를 일부 되돌리는 것이므로, 되돌린 만큼 **재현율로 갚아야** 한다. 게이트별 탈락 수(`gate` 진단)를 반드시 병기하라 |
| 3 | Phase 0-b 의 B안 전환 문턱(참 경계 적중률) | **0.70 을 지금 못 박지 않는다 — 기각.** **분포를 먼저 재서 리더에게 올려라.** 그 뒤 문턱을 정한다 | 설계자 스스로 "이 값 자체가 임의값"이라고 적었다. 이 저장소 규율은 **미측정을 추정으로 채우지 않는 것**이다(18회차에 설계자가 두 번 어겼고 둘 다 구현자 실측이 잡았다). 문턱을 먼저 쓰면 그 숫자가 곧 보간 추정이 된다 |
| 4 | 가림 대응 | **ⓑ 채택하되 보간은 기본 OFF.** 구현은 하고, `interpolateGaps` 를 **명시 opt-in** 으로 둔다. 재현율·정밀도는 **항상 두 벌**(증거만 / 증거+보간) 보고 | 마스터 지시는 **"한 개, 한 개를 독립적으로 찾아서 만들어줘"** 다. **조용히 보간된 면은 「찾은」 것이 아니다.** 3단계에 사람이 있어 빠진 면은 사람이 채울 수 있다. 단 「증거만」이 H3(0.5854) 미달이면 **기본값 결정을 마스터에게 올린다** — 리더가 대행하지 않는다 |
| 5 | 뷰어 「예상 주차면 수」 칸 제거 시점 | **승인 — 2단계**(Phase 4 비활성 → Phase 5 제거) | 마스터는 "임의 갯수 입력이 필요없다"고 했고 최종 상태는 제거다. 다만 즉시 제거는 ⓐ회귀 비교 수단을 없애고 ⓑ20회차 함정 (f)(두 작업이 같은 `web/index.html` 을 건드려 기준선이 10건 어긋남)를 되풀이한다. **도달점은 같고 순서만 안전하게** 간다 |

### 추가 지시 (리더)

1. **Phase 0-b 가 이 설계의 생사를 정한다.** §9-1 대로 정련된 분리선의 참 경계 적중률·오차 분포가 A안 재현율 상한을 그대로 결정한다. **Phase 0-b 결과를 보고 A/B 전환을 판단할 때까지 Phase 1 로 넘어가지 마라.** `floorPaint.ts:757-761` 의 "2.6~31px" 는 **정련 전 씨앗** 값이며 A안의 근거로 쓸 수 없다(설계자가 스스로 밝힌 대로).
2. **설계자가 코드에서 새로 찾은 사실을 확립사실로 등재하라** — `paint.score` 가중 총합 1.8 중 **위상을 아는 성분은 `side` 0.5 = 27.8% 뿐**이고, 근변·원변은 u 방향 연속 도색 띠 위에 있어 **위상에 눈이 멀었다**. 20c 표가 확인: side **+0.1576**(판별) · far **−0.0521(오답 편)** · near +0.1020(끝칸 부수효과). **이것이 반증 #5·#7·#8 이 왜 실패했는지를 한꺼번에 설명한다** — 점수의 72%가 위상을 못 보는데 위상 항의 가중치를 올려도 다수를 못 이긴다. 방향 전환의 진짜 근거이며 다음 인계서 §확립사실에 넣어라.
3. **반증목록 #7(도색지지 단독 적용)과의 구분 논증을 구현 착수 시 재확인하라.** 설계자가 "결정 단위가 행→면, 새 기하 구속 추가, 행 전체 판정 소멸"로 기전 부재를 논증했고 리더는 이를 수용한다. 그러나 **Phase 2 에서 재현율이 떨어지면 #7 재현일 가능성을 최우선 후보로 올려라**(#7 의 실패 양상이 정확히 recall 손실이었다: 0.09116→0.08300).
4. **`expectedBays` 활성 생존 경로가 `bayGrid.ts:393` 유일**이라는 전수 조사 결과를 수용한다(`:317-329` 는 `'expected'` 죽은 가지, `bayGeometry.ts:425` 는 서비스 도달 불가). 20b 의 자기정정과 일치한다.
5. 구현 착수 전 **`docs/` 를 당일 날짜로 정렬해 훑어라** — 20회차 함정 (f).
