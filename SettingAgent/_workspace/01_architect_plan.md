# 01 설계 — MCP 자동 바닥 ROI 생성 (이미지 코너 검출 경로)

- 작성: 2026-07-29 / 설계자(architect)
- 입력: `_workspace/00_leader_context.md`(리더 실측) · `docs/20260729_010651_*.md` · `docs/20260727_202948_*.md` · `docs/20260728_021006_*.md`
- 실행 모드: **B (goal/loop)**
- 이 문서의 수치는 **설계자가 이번 세션에서 직접 측정**한 것이다. 추측한 값에는 "미검증"이라고 적었다.

---

## 0. 요약 — 무엇이 결정됐고 무엇이 새로 밝혀졌나

리더가 "노면 도색선이 실재한다"까지 확인했다. 설계자는 그 위에서 **실제로 코너를 산출해 채점**해 보았고, 결과는 다음과 같다.

| # | 발견 | 근거(직접 측정) |
|---|---|---|
| **F1** | **전방 도색선은 서브픽셀로 검출된다.** 1:1 전 7면에서 9/9 샘플 검출, 수동 근변과의 오프셋 −0.75~+0.25px, **MAD ≤ 0.49px**, 대비 162~176, 선폭 8~12px | `probe_paint.mjs` |
| **F2** | **원변(후방)에는 도색 증거가 없다.** 검출 2~6/9, 대비 80~141(전방의 절반), MAD 최대 7.28px — 차량 하이라이트를 오검출한 것 | 같은 측정 |
| **F3** | ★ **원변은 도색 없이도 정확히 복원된다.** 근변코너 + 측면소실점 + f + 실치수비(5.0/2.5) 만으로 재구성한 결과 **1:1 = 6/7면 IoU 1.0000, 2:1 = 6/6면 1.0000, 2:2 = 4/4면 1.0000** | `probe_far2.mjs` |
| **F4** | **f 는 이미지 증거만으로 정확히 복원된다.** VP 직교 구속으로 얻은 f 가 정본 fov 대비 **오차 0.00%**(1:1 / 2:1 / 2:2), 1:2 만 −1.90% | 같은 측정 |
| **F5** | **정점 배정은 정답지 없이 판별된다.** 선택 기준을 IoU 가 아니라 "근변코너 등간격 잔차 + 측면 VP 잔차"로 두자 2:1 → rot=1 dir=−, 2:2 → rot=2 dir=− 로 자동 교정(IoU 0.0000 → 1.0000) | 같은 측정 |
| **F6** | ★ **미달 슬롯의 원인은 자동화가 아니라 수동 앵커의 오작화다.** `idx1` 의 우측 분리선은 실제 도색선에서 **9.03px** 떨어져 있다(MAD 0.46, 대비 185 — 확신 있는 검출). 그래서 idx1 은 어떤 방법으로도 수동 대비 0.95 이상이 안 된다 | `probe_paint.mjs`, 파일 실측 `idx1.p3=(373.02,701.19) ≠ idx2.p0=(364.65,703.29)` |
| **F7** | **"개별 IoU ≥ 0.98" 은 서브픽셀 요구다.** 가장 빡빡한 슬롯(1:1 idx7)의 허용 오차는 **전체 평행이동 0.40px / 단일 변 0.81px / 단일 정점 1.60px**, 깊이 스케일 상대오차 **0.31%** | `budget.mjs` |
| **F8** | 파이프라인은 **절대 스케일에 무관**하다. 깊이를 "측정된 폭 × 2"로 잡기 때문에 슬롯 실폭이 2.5m 이든 2.525m 이든 quad 는 동일하다. 이미지만으로 추정한 카메라 지상고는 4.950m(config 5.000m, −1.00%)로 3개 프리셋에서 동일 — 계통오차이며 quad 에는 영향 없음 | `probe_far3.mjs` |
| **F9** | `src/ground/contact.ts` 는 **코너 증거로 쓸 수 없다.** `slotAxes` 가 슬롯 폴리곤을 입력으로 받으므로 순환이고, 파일 자체가 "L은 항상 prior · 뒤 접지선은 원리적으로 안 보인다"고 못 박고 있다 | 소스 조사 |

**결론: 마스터 요구 "이미지에서 사각형 4점을 찾는다"는 성립한다.** 다만 4점 중 **2점(근변)만 도색에서 직접 나오고, 나머지 2점(원변)은 소실점 기하로 복원**된다. 이것은 우회가 아니라 이 장면의 물리적 사실이다 — 원변은 차량에 완전히 가려져 있고 어떤 검출기로도 볼 수 없다.

---

## 1. 증거원 우선순위 판정 (과제 1)

| 순위 | 증거원 | 강도 | 실패 조건 | 실카 전이 | 판정 |
|---|---|---|---|---|---|
| **1** | **노면 도색선 (전방 실선 + 분리선)** | ★★★ 대비 162~198, MAD ≤0.49px | 도색 마모·물기·강한 그림자·저대비 | **가능**(도색은 실제 주차장의 표준) | **채택 — 1순위** |
| **2** | **소실점 기하**(1순위 산출물의 파생) | ★★★ f 오차 0.00%, IoU 1.0000 | 슬롯 3면 미만, 분리선 2개 미만, 심한 렌즈왜곡 | 왜곡보정 필요(`packages/lens-calib`) | **채택 — 원변 전용** |
| 3 | LPD/VPD 검출 | ★ | 미검출 슬롯(메모 `slot10류`), 판은 지면이 아닌 지상 0.4~0.6m 수직면 | 가능 | **보류** — 교차검증용, 이번 범위 밖 |
| 4 | 차량 접지선 `contact.ts` | ✗ | **순환**(슬롯 폴리곤이 입력) + 뒤 접지선 관측 불가 | — | **기각** (F9) |

> 도색선 검출을 1순위로 확정한다. 접지선은 기각한다.

---

## 2. 알고리즘 — 3단계

### Stage A. 프레임 → 서브픽셀 도색 직선

저장소 관례를 따른다: **sharp 는 라우트/포트 계층에서 그레이 배열만 뽑고, 알고리즘은 순수 함수**(`src/capture/frameAlign.ts:1` 이 명시한 규약, `src/api/captureRoutes.ts:220` 이 실제 사례).

```
A1. (라우트) sharp(jpg).greyscale().raw().toBuffer()  → Uint8Array(1920*1080)
A2. 도색 마스크
      배경 추정: 이미지를 16x16 블록으로 다운샘플 → 블록 median = bg(x,y) (쌍선형 보간)
      mask(x,y) = gray - bg > T          # T 는 프레임 전역 백분위로 결정(고정 규칙, 난수 없음)
      ※ 실측 대비 162~198 → 시뮬에서는 여유. 실카는 미검증(R10)
A3. 거친 직선 검출: Hough (rho, theta) 누적
      theta 해상도 0.2°, rho 해상도 1px  (고정)
      피크 선택: 누적값 내림차순 → 동점 시 (theta asc, rho asc) 낮은 인덱스 우선 (R2)
      비최대억제 창 고정
A4. ★ 서브픽셀 정련 — 여기가 정밀도의 원천 (실측 MAD ≤0.49px)
      for 각 Hough 직선:
        직선을 따라 NS(=9~25) 지점에서 법선 방향 ±14px 밝기 프로파일 채취(0.5px 간격, 최근접)
        각 프로파일에서 스트라이프 무게중심:
            bg  = 35 백분위,  peak = 최댓값
            if peak - bg < 45: 이 지점은 버림              # 스트라이프 없음
            thr = bg + (peak-bg)*0.5
            t*  = Σ(v-bg)*t / Σ(v-bg)   over  v >= thr
        중심점 ≥ 3개 → 총최소제곱(TLS)으로 직선 재적합
        산출: { line(a,b,c 정규화), residPx, hitRatio, meanWidthPx, meanContrast }
      정련 실패(hit < 3) → 그 직선 폐기
```

**A4 는 추측이 아니라 이번 세션에서 실제로 돌려 MAD 0.03~0.49px 를 측정한 코드다**(`probe_paint.mjs`). 상수(±14px, 0.5px, 35백분위, 대비 45, thr 0.5)는 그 실측에서 나온 값이고, 실카에서는 재조정 대상이다(R10).

### Stage B. 직선 → 베이 코너 4점

```
B1. 직선 분류
      전방선 L_f  = mask 지지 화소가 가장 많고 길이가 최대인 직선
      분리선 S_*  = L_f 와의 교각이 20°~160° 이고, 서로 공통 교점(VP)에 대한
                    잔차가 임계 이하인 최대 클러스터
      ※ 분류 기준은 "공통 소실점 일관성"이다. 방향각 상수 하드코딩 금지(R3 정신)

B2. VP_d = meetLS(S_*)            # 정규화 직선거리 최소화, 2x2 정규방정식 (닫힌 해, 난수 0)
      실측 잔차: 1:1 median 1.77px / 2:1 0.00px

B3. C_k = L_f ∩ S_k → L_f 를 따른 파라미터 s 로 정렬

B4. 정수 격자 위상 맞춤 (분리선 누락 허용)
      C_k 에 정수 인덱스 t_k 를 배정한다. 연속(0,1,2,..)을 가정하지 않는다 —
      분리선 1개가 미검출이면 실제 인덱스는 0,1,2,4,5 이다.
      탐색: 최대 누락 2개까지의 단조증가 정수열 후보를 **고정 순서로 전수 순회**,
            각 후보에 대해 B5 의 사영 1D 적합 잔차를 계산, 최소 잔차 채택.
            동점 → 낮은 인덱스 우선 (R2)

B5. VP_r  — 등간격 공선점의 사영 1D 적합
      s(t) = (a t + b)/(c t + 1) 를 선형 최소제곱으로 적합(미지수 a,b,c)
      VP_r = s(∞) = a/c 에 해당하는 이미지 점
      resid = max_k | s_hat(t_k) - s_k |      # 실측: 1:1 0.00px / 1:2 0.22px
      ※ 최소 4점(= 슬롯 3면) 필요. 미달 시 이 프리셋은 강등(§7)

B6. f = focalFromVPs(VP_d, VP_r, cx, cy)      ★ groundModel.ts:256 재사용 (R4)
      실측: 1:1 / 2:1 / 2:2 에서 정본 fov 대비 오차 0.00%
      부호 판정 실패(dot ≥ 0) → 강등. **PTZ zoom 기반 focalFromZoom 으로 폴백하지 않는다**
      (폴백하면 이미지 증거 경로가 조용히 텔레메트리 경로로 바뀐다 — 강등해서 드러내는 편이 정직하다)

B7. 지면 법선
      h = VP_d × VP_r                      # 지평선(동차)
      n ∝ [h0*f, h1*f, h0*cx + h1*cy + h2] ; 정규화, n_z > 0 이 되도록 부호 고정

B8. 지상고 d (metric 스케일)
      d=1 로 C_k 를 backprojectToGround → 인접 간 거리 median = wMed
      d = slotWidthM / wMed
      ★ 자기검증 게이트: | d - cameraHeightConfig | / cameraHeightConfig > 0.05 → issues 경고
        (실측 4.950m vs 5.000m = −1.00%. 3개 프리셋 동일 계통오차 = 슬롯 실폭이 2.525m 라는 뜻이며
         quad 자체에는 영향 없음 — F8)

B9. GroundModel 조립 → 격자 → quad
      GroundModel { camIdx, presetIdx, imgW, imgH, zoom, f, n, d, tiltDeg=asin(n[2]), source:'auto', ... }
      GroundGrid  { originM, thetaDeg, colPitchM=slotWidthM, rowPitchM=slotDepthM, cols=N, rows=1, slotIdByCell }
      quads = gridToPixelQuads(grid, model, panDeg)      ★ groundGrid.ts:170 재사용 (R4)
```

**깊이가 폭의 2배라는 것만 쓰고 절대치는 안 쓴다** — B8 의 `d` 는 `GroundModel` 필드를 채우기 위한 것이고, quad 형상은 `rowPitchM/colPitchM = 2.0` 이라는 **비율**에만 의존한다(F8).

### Stage C. 채점 (별도 모듈 — 여기서만 수동 ROI 를 읽는다)

```
C1. 수동 정본 로드 → 정점 배정 해소
      이면군 4회전 × 방향 2 = 8 후보(+ 필요 시 반사 포함 16)를 고정 순서로 전수 순회
      ★ 선택 기준 = 이미지측 일관성만: (등간격 사영 잔차) + 0.05 × (측면 VP 잔차)
        IoU 를 선택 기준으로 쓰지 않는다 — 그러면 정답지가 입력이 된다 (R1)
      실측으로 2:1 → rot=1 dir=−, 2:2 → rot=2 dir=− 를 정답지 없이 회수함 (F5)
C2. 자동 quad ↔ 슬롯 매칭: 기존 MATCH_MIN_IOU(=0.5) 규약 재사용
C3. IoU = quadIoU(auto, manual)          ★ autoRoiPlan.ts:38 재사용, 신규 구현 금지 (R4)
C4. 산출: 슬롯별 IoU · 프리셋 평균/최소 · ≥0.98 통과수 · 강등 사유 · 진단수치
```

---

## 3. Hold-out 강제 구조 (과제 3, R1) — 약속이 아니라 구조로

세 겹으로 막는다.

**① 타입으로 막는다.** 검출·기하 모듈의 입력 타입에 수동 ROI 를 **표현할 수단이 없다**.

```ts
// floorPaint.ts / bayGeometry.ts 의 입력은 오직 이것뿐이다
interface FrameGray { data: Uint8Array; width: number; height: number; }
interface BayDetectOpts { slotWidthM: number; slotDepthM: number; expectedBays: number; /* 개수만 */ }
```
`PlaceRoiSpace` · `NormalizedPlaceRoi` · `PixelQuad`(수동 유래) 를 **인자로 받지 않는다**.

**② 모듈 경계로 막는다.** 수동 ROI 를 읽는 코드는 `roiAutoScore.ts` 한 파일에만 존재한다. 검출·기하 모듈은 `placeRoi.ts` 를 import 하지 않는다.

**③ 정적 봉인 테스트로 막는다.** 저장소에 이미 같은 패턴이 있다(`test/groundGrid.test.ts:183-198` 의 픽스처 봉인 메타 테스트). 그대로 흉내낸다.

```ts
// test/roiAutoHoldout.test.ts
it('검출·기하 모듈은 수동 ROI 를 어떤 경로로도 읽지 않는다', () => {
  for (const f of ['src/ground/floorPaint.ts', 'src/ground/bayGeometry.ts']) {
    const src = readFileSync(f, 'utf8');
    for (const banned of ['placeRoi', 'PlaceRoiSpace', 'normalizePtzCamRoi',
                          'placeRoiFile', 'PtzCamRoi', 'spaces']) {
      expect(src, `${f} 가 ${banned} 를 참조한다 — hold-out 오염`).not.toContain(banned);
    }
  }
});
```

**선언하는 누출 2건 (숨기지 않는다):**
1. **베이 개수 N** — 프리셋에 몇 면이 있는지는 DB/정본의 *메타데이터*(개수·순번)에서 온다. 기하가 아니다.
2. **슬롯 인덱스 진행 방향 1비트** — "왼쪽 끝이 slot 1 인가 오른쪽 끝인가". 이건 이미지에서 원리적으로 안 나온다. 기본은 `preset_slotidx` 순서 + 고정 규약으로 정하고, **두 방향의 점수를 모두 리포트**한다. 방향을 IoU 로 고르면 그 1비트만큼 정답지를 쓴 것이므로 응답에 `directionResolvedBy: 'convention' | 'score(1bit-leak)'` 로 명시한다.

C2 의 자동↔슬롯 **매칭**에 IoU 를 쓰는 것도 기존 규약 재사용이지만 정답지 사용이다. 기하는 오염되지 않고 *귀속*만 정하므로 허용하되 리포트에 명시한다.

---

## 4. 파일 구성 (과제 4) — 신규 4 · 수정 2 · 무변경(재사용) 6

### 4-1. 신규

| 파일 | 성격 | 내용 |
|---|---|---|
| `src/ground/floorPaint.ts` | **순수** (IO 0, sharp 미참조) | Stage A2~A4 |
| `src/ground/bayGeometry.ts` | **순수** | Stage B1~B9 |
| `src/ground/roiAutoScore.ts` | 순수 (수동 ROI 읽는 **유일** 모듈) | Stage C |
| `src/rpc/services/roiAuto.ts` | 핸들러 (IO·프레임 취득) | RPC 3종 |

```ts
// ── src/ground/floorPaint.ts ───────────────────────────────────────────
export interface FrameGray { data: Uint8Array; width: number; height: number }
export interface PaintOptions {
  bgBlockPx: number;        // 16
  minContrast: number;      // 45
  thetaStepDeg: number;     // 0.2
  rhoStepPx: number;        // 1
  profileHalfPx: number;    // 14
  profileStepPx: number;    // 0.5
  samplesPerLine: number;   // 9
  maxLines: number;         // 40
}
export const DEFAULT_PAINT_OPTIONS: PaintOptions;

/** 밝기-배경 차 마스크. 반환은 0/1 바이트 배열(같은 크기). 난수 0. */
export function paintMask(frame: FrameGray, opts: PaintOptions): Uint8Array;

/** Hough 거친 직선. 반환 순서 고정(누적 desc → theta asc → rho asc). */
export function coarseLines(mask: Uint8Array, w: number, h: number, opts: PaintOptions):
  Array<{ line: [number, number, number]; votes: number }>;

/** ★ 서브픽셀 정련(실측 MAD ≤0.49px). hit<3 이면 null. */
export function refineLine(
  frame: FrameGray, line: readonly [number, number, number], opts: PaintOptions,
): { line: [number, number, number]; residPx: number; hit: number;
     widthPx: number; contrast: number } | null;

/** A2~A4 일괄. 정련 성공 직선만, 지지도 내림차순 고정 정렬. */
export function detectPaintLines(frame: FrameGray, opts: PaintOptions): RefinedLine[];
```

```ts
// ── src/ground/bayGeometry.ts ──────────────────────────────────────────
export interface RefinedLine { line: [number, number, number]; residPx: number; hit: number;
                               widthPx: number; contrast: number }
export interface BayDetectOpts { slotWidthM: number; slotDepthM: number;
                                 expectedBays: number; cameraHeightM: number | null;
                                 maxMissingSeparators: number /* 2 */ }
export interface BayDetection {
  frontLine: [number, number, number];
  separators: [number, number, number][];
  cornersPx: Array<{ x: number; y: number }>;   // 근변 코너 C_k (N+1 개)
  latticeIndex: number[];                        // C_k 의 정수 격자 인덱스(누락 허용)
  vpDepth: [number, number] | null;
  vpRow: [number, number] | null;
  focalPx: number | null;
  normal: [number, number, number] | null;
  cameraHeightM: number | null;                  // 이미지증거 추정 d
  diag: { rowResidPx: number; sideResidPx: number; widthSpreadPct: number;
          heightDevPct: number | null };
  issues: string[];
}

/** 정규화 직선거리 최소화 교점. 2x2 정규방정식 — 난수·RANSAC 0. */
export function meetLines(lines: readonly [number, number, number][]): [number, number] | null;

/** 등간격 공선점 → 사영 1D 적합 → 행방향 소실점. 4점 미만이면 null. */
export function rowVanishingPoint(
  corners: ReadonlyArray<{ x: number; y: number }>, index: readonly number[],
): { vp: [number, number]; residPx: number } | null;

/** B1~B3. 전방선/분리선 분류 + 코너 산출. */
export function classifyAndIntersect(
  lines: readonly RefinedLine[], opts: BayDetectOpts,
): Pick<BayDetection, 'frontLine' | 'separators' | 'cornersPx' | 'latticeIndex' | 'issues'> | null;

/** Stage B 전체. 수동 ROI 를 **인자로 받지 않는다**(R1). */
export function detectBays(lines: readonly RefinedLine[], imgW: number, imgH: number,
                           opts: BayDetectOpts): BayDetection;

/** B9. 검출 결과 → 기존 자료구조. 이후 quad 생성은 gridToPixelQuads 에 위임(R4). */
export function toGroundModelAndGrid(
  det: BayDetection, camIdx: number, presetIdx: number, zoom: number,
  imgW: number, imgH: number, opts: BayDetectOpts,
): { model: GroundModel; grid: GroundGrid; issues: string[] } | null;
```

```ts
// ── src/ground/roiAutoScore.ts ─────────────────────────────────────────
export interface SlotScore { slotIdx: number; iou: number; matched: boolean }
export interface PresetScore {
  key: string; camId: number; presetIdx: number;
  bays: number; manualSlots: number;
  slots: SlotScore[];
  meanIoU: number | null; minIoU: number | null; pass98: number;
  assignment: { rot: number; dir: 1 | -1; rowResidPx: number; sideResidPx: number };
  directionResolvedBy: 'convention' | 'score(1bit-leak)';
  gradeReason: string | null;            // 강등 사유 — null 이면 유효 채점 대상
  issues: string[];
}
/** ★ 이 파일이 수동 ROI 를 읽는 유일한 곳이다. 배정 선택 기준은 IoU 가 아니다(R1). */
export function resolveManualAssignment(
  manual: readonly PlaceRoiSpace[], imgW: number, imgH: number,
): { rot: number; dir: 1 | -1; rowResidPx: number; sideResidPx: number } | null;

export function scorePreset(
  autoQuads: readonly GridQuad[], manual: readonly PlaceRoiSpace[],
  imgW: number, imgH: number, key: string, camId: number, presetIdx: number,
): PresetScore;                          // 내부에서 quadIoU 재사용 (R4)
```

### 4-2. 수정

| 파일 | 변경 | 규모 |
|---|---|---|
| `src/rpc/methods.ts` | `roi.auto.*` 3행 가산. **기존 76 메서드 무변경** | +3 항목, import 3줄 |
| `src/rpc/index.ts`(또는 deps 배선 지점) | 프레임 취득 시임 주입이 필요하면 1줄 | ≤1줄 |

### 4-3. 재사용(무변경) — R4 대응

| 자산 | 용도 |
|---|---|
| `quadIoU` (`autoRoiPlan.ts:38`) | 채점. **신규 IoU 구현 금지** |
| `assertAutoPromoteSafe` G1~G5 (`autoRoiPlan.ts:557`) | apply 게이트 |
| `buildApplySpaces` (`autoRoiPlan.ts:470`) | 정본 spaces 조립 |
| `gridToPixelQuads` / `fitGridFromQuads` / `canonicalizeQuad` (`groundGrid.ts:170/265/127`) | 격자↔quad |
| `projectToPixel` / `backprojectToGround` (`project.ts:61/49`) | 투영 — **직접 수식 재구현 금지** |
| `focalFromVPs` (`groundModel.ts:256`) | B6 |
| `round5` / `stringify5` (`util/round.ts`) | 영속화 (R7) |
| `writePlace` 경로 (`services/placeSpaces.ts:114`) | 정본 쓰기 + `.bak` |

---

## 5. MCP RPC 인터페이스 (과제 5, R6)

기존 `grid.*` 3종(웹 승인 흐름)은 **1줄도 건드리지 않는다.** 별도 네임스페이스로 병존한다.

| method | mutating | destructive | requiresCamera | stability | 역할 |
|---|---|---|---|---|---|
| `roi.auto.detect` | ✗ | ✗ | **✓** | experimental | 프레임 1장 → 도색선·소실점·f·코너·quad 미리보기. **수동 ROI 를 읽지 않는다** |
| `roi.auto.score` | ✗ | ✗ | **✓** | experimental | detect 결과를 수동 정본과 대조 채점(hold-out). 파일·DB 무접촉 |
| `roi.auto.apply` | ✓ | ✓ | ✓ | experimental | 정본 `PtzCamRoi.json` 갱신. `confirm:true` 필수 |

`requiresCamera: true` 가 **기존 `place.*` 쓰기 경로와의 결정적 차이**다. 기존 자동 ROI 경로는 카메라 무관여였지만 이번 경로는 프레임이 반드시 필요하다 → 호출 전 `system.busy` 확인 대상이며 카탈로그에 그대로 드러내야 한다.

```ts
// src/rpc/services/roiAuto.ts — 저장소 관례 그대로
export const RoiAutoDetectSchema = z.object({
  camId: z.number().int().positive(),
  presetIdx: z.number().int().positive(),
  expectedBays: z.number().int().min(1).max(200).optional(),
  slotWidthM: z.number().positive().default(2.5),
  slotDepthM: z.number().positive().default(5.0),
});
export const RoiAutoScoreSchema = RoiAutoDetectSchema.extend({
  camId: z.number().int().positive().optional(),   // 미지정 = 전 카메라·전 프리셋 순회
  presetIdx: z.number().int().positive().optional(),
});
export const RoiAutoApplySchema = RoiAutoDetectSchema.extend({
  confirm: z.literal(true),
  presets: z.array(z.number().int().positive()).min(1),
  minIoU: z.number().min(0).max(1).default(0.98),  // 이 값 미만인 면이 있으면 거부
  expectTotal: z.number().int().nonnegative().optional(),
});

export async function roiAutoDetect(raw: unknown, ctx: RpcContext): Promise<unknown>;
export async function roiAutoScore(raw: unknown, ctx: RpcContext): Promise<unknown>;
export async function roiAutoApply(raw: unknown, ctx: RpcContext): Promise<unknown>;
```

`methods.ts` 등록 (기존 템플릿 그대로):

```ts
{ name: 'roi.auto.detect', title: '도색선 기반 바닥 ROI 검출(미리보기)',
  mutating: false, requiresCamera: true, stability: 'experimental',
  note: '파일·DB 를 쓰지 않는다. 수동 ROI 를 읽지 않는다(hold-out).',
  requires: ['camera'], handler: roiAutoDetect },
{ name: 'roi.auto.score', title: '자동 ROI 채점(수동 정본 대비)',
  mutating: false, requiresCamera: true, stability: 'experimental',
  requires: ['camera', 'placeRoiFile'], handler: roiAutoScore },
{ name: 'roi.auto.apply', title: '자동 ROI 정본 적용',
  mutating: true, destructive: true, requiresCamera: true, stability: 'experimental',
  note: '정본(PtzCamRoi.json) 갱신. DB 반영은 별도로 slot.roi.sync 를 호출할 것.',
  requires: ['camera', 'placeRoiFile'], handler: roiAutoApply },
```

에러는 `throw new RpcMethodError(...)`, 부분 강등은 `issues: string[]` — 저장소 규약 그대로.

**프레임 취득은 불확실 항목이다(§9-U1).** `ctx.deps.camera` 시임의 정확한 형태를 구현자가 먼저 확인해야 한다.

---

## 6. 파괴 방지 (과제 6, R5)

**R5 를 "직접 호출"이 아니라 "호출하지 않음"으로 만족시킨다 — 더 강하다.**

조사 결과 `updateSlotRoiGeometry`(`SqliteStore.ts:526`)의 **유일한 호출자는 `src/capture/roiSlotSync.ts:150` (`syncRoiToDb`)** 이고, 이는 기존 RPC `slot.roi.sync` 로 노출돼 있다. 따라서:

```
roi.auto.apply
  ├─ S1. 검출·채점 재실행 (미리보기와 동일 입력 → 동일 결과여야 함, R2)
  ├─ S2. 합격선 게이트: 대상 프리셋 전 면 IoU ≥ minIoU 아니면 즉시 CONFLICT 거부
  ├─ S3. assertAutoPromoteSafe(next, current) — G1~G5 재사용
  ├─ S4. guardTotal(expectTotal) — 동시편집 가드 재사용
  └─ S5. writePlace() 경로: .bak 원문 바이트 백업 → stringify5(json,2) 정본 갱신 → 실패 시 복원

  DB 는 건드리지 않는다. 반영이 필요하면 호출자가 기존 `slot.roi.sync` 를 별도 호출한다.
```

**정적 봉인 테스트 (필수):**
```ts
it('roiAuto 는 DB 쓰기 경로를 신설하지 않는다', () => {
  const src = readFileSync('src/rpc/services/roiAuto.ts', 'utf8');
  expect(src).not.toContain('replaceSlotSetup');
  expect(src).not.toContain('SqliteStore');
  expect(src).not.toContain('updateSlotRoiGeometry');
});
it('replaceSlotSetup 호출자는 여전히 3곳이다', () => { /* 전역 grep 카운트 = 3 */ });
```

`replaceSlotSetup` 호출자 실측 3곳(`Finalizer.ts:300` · `roiDbLoad.ts:319` · `migrateToSettingDb.ts:96`)은 **개수 그대로 유지**한다.

---

## 7. 정직한 강등 경로 (과제 7) — 위장 금지

검출·적합이 성립하지 않는 구간은 **자동 대상에서 빼고 사유를 숫자로 남긴다.** 억지로 채우지 않는다.

| 강등 코드 | 조건(전부 수치 판정) | 조치 |
|---|---|---|
| `D1_TOO_FEW_BAYS` | 슬롯 < 3 (근변코너 < 4) → B5 사영 1D 적합 불가 | 자동 제외. **`1:3`(2면) 이 여기 해당** |
| `D2_NO_FRONT_LINE` | 정련 통과 직선 0개 또는 최장 직선 지지도 < 임계 | 자동 제외 |
| `D3_FEW_SEPARATORS` | 분리선 < 2 → VP_d 불가 | 자동 제외 |
| `D4_ROW_RESID` | B5 등간격 잔차 > 2.0px → 격자 불규칙(사선주차·간격불균등) | 자동 제외 |
| `D5_VP_DEGENERATE` | `focalFromVPs` 부호 실패 또는 f 가 [0.3, 5.0]×imgH 밖 | 자동 제외. **PTZ zoom 폴백 금지** |
| `D6_HEIGHT_DEV` | 이미지추정 d 가 config 지상고 대비 >5% 이탈 | 경고(issues)만, 제외는 아님 |
| `D7_WIDTH_SPREAD` | 근변코너 간격 편차 > 5% | 경고. **>15% 는 배정 오판 신호**(실측 2:1 오배정 시 77.7%) |
| `D8_NON_QUAD` | 수동 슬롯이 4점이 아님 | 채점 대상에서 제외 |
| `D9_SLOT24` | 슬롯 24 (파일↔DB 배치 불일치, R8) | 채점·적용 전 범위 제외 |
| `D10_ANCHOR_DEFECT` | 자동 코너가 도색선 위에 있는데(정련 resid < 1px) 수동 변이 도색선에서 > 3px 이탈 | **수동 쪽 오작화로 분류.** 자동을 수동에 맞추지 않는다 |

**D10 이 이번 설계에서 새로 필요해진 항목이다.** `idx1` 의 우측 분리선은 실제 도색선에서 9.03px 떨어져 있다(F6). 이 상태에서 "IoU ≥ 0.98" 을 만족시키려면 **자동 산출을 일부러 도색선에서 벗어나게 만들어야 하는데, 그것이 곧 위장이다.** 따라서 D10 구간은 "수동 정본에 결함 있음"으로 보고하고 마스터 판단을 받는다(§9-Q1).

응답 예:
```json
{ "key": "1:3", "graded": false, "gradeReason": "D1_TOO_FEW_BAYS",
  "detail": { "bays": 2, "cornersNeeded": 4, "cornersFound": 3 } }
```
`graded:false` 인 프리셋은 **통과로 세지 않는다.** 평균에도 넣지 않는다.

---

## 8. 검증 계획 — 무엇을 어떤 수치로 확인하면 성공인가

| 단계 | 내용 | 성공 기준(수치) |
|---|---|---|
| **V1** | `floorPaint` 유닛테스트 — 합성 이미지(기울어진 흰 스트라이프, 폭 9px, 대비 170)에 정련 적용 | 복원 직선의 법선 오프셋 오차 **< 0.2px**, 각도 오차 **< 0.05°** |
| **V2** | 실프레임 회귀 — 동결 픽스처(cam1 preset1 JPEG)에 `detectPaintLines` | 전방선 1개 + 분리선 ≥6개 검출, 전방선 정련 resid **< 0.5px** (설계자 실측 MAD 0.03~0.49px) |
| **V3** | `bayGeometry` 골든 해시 | `sha256(stringify5({det, model, grid, quads}))` 고정. 재실행 시 불변 (R2/R9) |
| **V4** | ★ **f 회수 정확도** — 검출 코너로 `focalFromVPs` | 정본 `fov` 대비 상대오차 **< 1.0%** (설계자 실측 0.00%) |
| **V5** | ★ **지상고 자기검증** | 이미지추정 d 가 config 5.0m 대비 **< 3%** (설계자 실측 −1.00%) |
| **V6** | ★ **채점 (본 목표)** — 전 프리셋 hold-out | 유효 채점 대상(`graded:true`) 전 면 **IoU ≥ 0.98**. 미달 면은 D1~D10 중 하나로 **반드시 분류** |
| **V7** | 배정 판별 — IoU 를 쓰지 않는 기준으로 | `2:1` → rot=1 dir=−, `2:2` → rot=2 dir=− 회수 (설계자 실측) |
| **V8** | hold-out 봉인 | `test/roiAutoHoldout.test.ts` green (§3) |
| **V9** | 파괴 방지 봉인 | `roiAuto.ts` 에 DB 심볼 0건, `replaceSlotSetup` 호출자 = 3곳 (§6) |
| **V10** | apply 왕복 | 적용 후 `slot_setup` 의 `vpd_bbox/lpd_obb/occupy_range/pan/tilt/zoom/centered/img1/slot3d_front_center` **전 컬럼 불변** 실측 |
| **V11** | 소수 5자리 | 정본 왕복 후 모든 좌표가 소수 ≤5자리 (R7) |
| **V12** | 회귀 | `npx tsc --noEmit` exit 0, `npx vitest run` 전량 green (직전 기준 252파일/3005테스트) |
| **V13** | 육안 | sharp 오버레이 — 초록=수동, 빨강=자동, **노랑=검출된 도색선**. 자동 근변이 도색선 위에 얹혔는지 확인 |

**V13 에 "검출된 도색선"을 반드시 그린다.** 자동과 수동만 비교하면 F6 같은 "수동이 틀린 경우"를 영영 못 본다.

---

## 9. 불확실·미해결·질문

### 미검증 (정직 표기)

| # | 항목 | 상태 |
|---|---|---|
| **U1** | **프레임 취득 시임** — `ctx.deps.camera` 의 정확한 인터페이스를 확인하지 못했다. `src/api/captureRoutes.ts:220` 이 `sharp(jpg).greyscale().raw()` 를 쓰는 것은 확인했으나, 그 `jpg` 를 어디서 받는지는 미추적 | **구현 착수 전 1순위 확인** |
| **U2** | **도색 검출은 `cam1 preset1` 프레임 1장에서만 검증됐다.** 다른 4개 프리셋은 PTZ 이동이 필요해 미측정(설계 단계는 무접촉 원칙). cam2 의 현재 화각 프레임에서 도색선이 **더 잘 보이는 것**(분리선이 전방선까지 가림 없이 이어짐)은 육안 확인함 | 첫 loop 에서 측정 |
| **U3** | **실카(RTSP) 전면 미검증** (R10). 대비 162~198 은 시뮬 수치다. 실카는 마모·그림자·저대비·**렌즈왜곡**(직선이 휘면 VP 적합이 무너진다) 이 전부 미지수. A2/A4 상수는 실카 재조정 대상 | 이 환경에서 검증 불가 |
| **U4** | **Hough 단계는 미구현·미측정이다.** 설계자가 실측한 것은 A4(정련)와 Stage B 이고, A3(거친 검출)은 수동 ROI 를 seed 로 대체해 측정했다. **"seed 없이 처음부터 찾는" 부분이 이 설계에서 가장 검증이 약한 지점**이다 | 첫 loop 의 최우선 과제 |
| **U5** | `1:2` 는 측면 VP 잔차 9.97px · 폭편차 3.4% · f 오차 −1.90% 로 다른 프리셋과 성격이 다르다. 수동 드로잉 결함인지 실제 배치 불규칙인지 미확인 (자동 IoU 0.928~0.984) | loop 에서 분류 |
| **U6** | 정련 상수(±14px, 35백분위, 대비 45)는 실측 1건에서 나온 값이다. 슬롯이 매우 멀어 선폭이 2~3px 인 구간에서의 거동 미검증 | |

### 마스터 판단 요청

**Q1 (결정적).** `idx1`·`idx8` 은 수동 앵커가 실제 도색선에서 **9.03px 벗어나 있다**(F6, 확신 있는 검출). 자동 산출은 도색선 위에 정확히 놓이므로, 이 두 면은 **자동이 더 정확한데 IoU 는 0.95 로 떨어진다.** 셋 중 하나를 골라 주십시오.
  - **(a) 도색선을 정본으로 인정** — 자동 산출로 앵커를 교정하고, 교정 후 재채점한다. (설계자 권고)
  - **(b) 두 면을 `D10_ANCHOR_DEFECT` 로 제외** 하고 나머지 21면에서 ≥0.98 을 판정한다.
  - **(c) 수동을 정본으로 고수** — 이 경우 **목표는 원리적으로 달성 불가**이며, 달성했다고 보고하려면 자동을 일부러 틀리게 만들어야 한다(= 위장). 채택 시 불가 사유를 그대로 보고한다.

**Q2.** `1:3`(2면)은 사영 1D 적합에 필요한 4점이 안 나온다(`D1`). "검증 불가"로 표기하고 통과 집계에서 빼는 것으로 확정해도 되겠습니까. (리더 컨텍스트 §6 판단과 일치)

**Q3.** 슬롯 24 를 `cam1:preset1` 과 `cam2:preset1` 중 어디로 확정합니까 (R8). 확정 전까지는 범위에서 제외한 채 진행합니다.

**Q4.** `roi.auto.apply` 는 정본 파일만 쓰고 DB 반영은 기존 `slot.roi.sync` 를 별도 호출하는 구조로 두었습니다(§6 — DB 쓰기 경로를 신설하지 않는 것이 R5 를 가장 강하게 만족). apply 가 sync 까지 자동 연쇄하기를 원하시면 알려 주십시오.

---

## 10. R1~R10 대조표

| # | 제약 | 이 설계에서의 충족 방식 | 검증 |
|---|---|---|---|
| **R1** | 이미지에서 4점을 찾을 것. 수동 ROI 는 정답지로만 — hold-out | 근변 2점 = 도색선∩분리선 **직접 검출**(F1). 원변 2점 = 소실점 기하 복원(F3). 검출·기하 모듈은 타입·모듈경계·정적봉인 **3중**으로 수동 ROI 차단(§3). 누출 2건(베이 개수·방향 1비트)은 **선언**하고 응답에 표기 | V2·V6·**V8** |
| **R2** | 선형 최소제곱. RANSAC·난수 금지. 순회 순서 고정, 동점 시 낮은 인덱스 | VP 교점 = 2×2 정규방정식(닫힌 해). 사영 1D 적합 = 3×3 정규방정식. Hough 피크 = 누적 desc → (theta asc, rho asc). 격자 위상 후보 = 고정 순서 전수 순회. **`Math.random` 0회** | **V3 골든해시** |
| **R3** | 정점 순서 하드코딩 금지 — 데이터에서 판별 | 이면군×방향 전수 탐색 유지. ★ 선택 기준을 **IoU 가 아닌 이미지측 일관성**(등간격 잔차 + 측면 VP 잔차)으로 바꿔 R1 과 양립시킴. 실측으로 2:1/2:2 배정을 정답지 없이 회수(F5). 직선 분류도 각도 상수가 아니라 VP 일관성으로 | **V7** |
| **R4** | 기존 자산 재사용. 신규 IoU 구현 금지 | `quadIoU` · `assertAutoPromoteSafe`(G1~G5) · `buildApplySpaces` · `gridToPixelQuads`/`fitGridFromQuads`/`canonicalizeQuad` · `project.ts` · **`focalFromVPs`(B6)** · `round5`/`stringify5` · `writePlace` 전부 재사용(§4-3). IoU·투영 수식 재구현 0 | import 검사 |
| **R5** | DB 쓰기는 `updateSlotRoiGeometry` 만. `replaceSlotSetup` 금지, 호출자 3곳 유지 | **DB 를 아예 쓰지 않는다.** apply 는 정본 파일만 갱신하고 DB 반영은 기존 `slot.roi.sync`(유일한 `updateSlotRoiGeometry` 호출자 `roiSlotSync.ts:150`)에 위임. `roiAuto.ts` 에 `SqliteStore`/`replaceSlotSetup`/`updateSlotRoiGeometry` 문자열 0건을 정적 봉인 | **V9·V10** |
| **R6** | MCP 채점·미리보기(무해) / 적용(destructive+confirm) 분리. `grid.*` 3종 무접촉 | `roi.auto.detect`·`roi.auto.score` = `mutating:false`. `roi.auto.apply` = `mutating:true, destructive:true` + `confirm: z.literal(true)`. 별도 네임스페이스, `grid.*` 코드 0줄 변경. `requiresCamera:true` 신규 명시(§5) | 카탈로그 확인 |
| **R7** | 영속화 수치 소수점 최대 5자리 | 정본 쓰기는 `writePlace` 재사용 → `stringify5(json, 2)` 강제 경로. 응답(휘발성)에는 적용하지 않음(규약대로 영속화 경계 전용) | **V11** |
| **R8** | 슬롯 24 범위 제외 + 보고서 명시 | 강등 코드 `D9_SLOT24` 로 채점·적용 양쪽에서 제외. §9-Q3 로 마스터 판단 요청. 미해소 상태를 응답 `issues` 와 문서에 명시 | 채점 응답 |
| **R9** | 골든 해시 vitest 결정론 봉인 + 기존 회귀 유지 | V3 골든 해시(동결 JPEG 픽스처 사용 — 런타임 정본을 쓰면 apply 가 스스로 깨뜨린다, `groundGrid.test.ts:19-24` 의 self-invalidating seal 경고 준수). 신규 테스트 파일을 픽스처 봉인 메타 테스트 목록에도 추가 | **V3·V12** |
| **R10** | 시뮬 수치로 실카 대변 금지. 미검증분은 미검증으로 표기 | 전 수치에 출처 표기. §9-U2/U3/U4 에 미검증 3건 명시(다른 프리셋·실카·Hough 단계). 실카 리스크로 **렌즈왜곡**을 추가 식별(직선이 휘면 VP 적합이 무너짐 — 시뮬에는 없는 실카 고유 위험). 보고서에 "실카 검증 0건"을 유지 | 문서 |

---

## 11. 구현 순서 (구현자에게)

1. **U1 확인** — 프레임 취득 시임. 여기가 막히면 나머지가 전부 못 돈다. → 검증: cam1 프레임을 `Uint8Array` 그레이로 받는 최소 코드 1개 동작
2. `bayGeometry.ts` 먼저 (Stage B) — **이미 실측으로 IoU 1.0000 이 확인된 부분**이라 위험이 가장 낮다. 입력은 코너 배열. → 검증: V3·V4·V5
3. `roiAutoScore.ts` + `roi.auto.score` — 코너를 **수동 근변에서 뽑아** 넣은 상태로 먼저 배선하고 채점표를 낸다(중간 상태이며 hold-out 아님 — **반드시 그렇게 표기**). → 검증: V7
4. `floorPaint.ts` (Stage A) — **U4 가 여기 있다. 가장 위험한 단계.** → 검증: V1·V2
5. 3의 코너 입력을 4의 검출 결과로 **교체** → 이 시점에 비로소 R1 이 성립한다. → 검증: **V6·V8**
6. `roi.auto.apply` + 봉인 → 검증: V9·V10·V11
7. 회귀·문서 → V12·V13

> **5번이 결정적이다.** 4번까지만 하고 멈추면 L0 자기재현과 다를 바 없다.

---

## 12. 영향도 (문서화 담당 전달용 초안)

| 모듈 | 영향 |
|---|---|
| `src/ground/floorPaint.ts` · `bayGeometry.ts` · `roiAutoScore.ts` | **신규**. 순수·IO 0 |
| `src/rpc/services/roiAuto.ts` | **신규**. 핸들러 |
| `src/rpc/methods.ts` | 가산 3항목 + import. 기존 76 메서드 무변경 |
| `src/ground/groundModel.ts` · `project.ts` · `groundGrid.ts` · `autoRoiPlan.ts` | **변경 없음 — 재사용만** |
| `src/capture/SqliteStore.ts` · `Finalizer.ts` · `roiDbLoad.ts` | **변경 없음.** `replaceSlotSetup` 호출자 3곳 유지 |
| `src/capture/placeRoi.ts` · `placeRoiEdit.ts` | **변경 없음**(보호 파일) |
| `src/api/groundGridRoutes.ts` · `web/*` | **변경 없음.** 웹 `grid.*` 흐름과 병존 |
| `PtzCamRoi.json` | `roi.auto.apply` 의 쓰기 대상. 기존 `.bak` 체계 그대로 |
| DB `slot_setup` | **이번 범위에서 무접촉** |
| `package.json` | **의존성 추가 없음** — sharp 만으로 충분(OpenCV 불필요) |

**최대 리스크 3개:** ① U4(seed 없는 Hough 검출) ② U3(실카 렌즈왜곡 → VP 붕괴) ③ Q1(수동 앵커 결함이 목표 달성을 원리적으로 막는 문제). 셋 다 코드 품질이 아니라 **데이터·물리**의 문제라 유닛테스트로 자동 검출되지 않는다.
