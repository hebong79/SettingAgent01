# 04 영향도 분석 — 마스크 show (VPD seg 마스크 반투명 오버레이)

작성: 2026-07-15 17:41:49 · 갱신: 2026-07-15 18:13:06(masks 의미 반전 반영)
문서: `SettingAgent/docs/20260715_174149_마스크show오버레이.md`

> ⚠️ **결정 반전(마스터 요구, 2026-07-15).** `masks` 산출 기준이 "seg 전량"에서
> **"on-place det(현재 프리셋 ROI 통과분)에 정합된 seg 마스크만"** 으로 바뀌었다(`frameCuboids.ts` L295~336).
> 사유: VPD det bbox는 on-place만 출력하는데 마스크가 전량이면 통로 등 ROI 밖 실루엣까지 그려져 불일치가
> 생긴다 — 마스크를 VPD 출력과 같은 기준으로 맞췄다. 아래는 반전 이후 기준으로 갱신한 영향도다.

---

## 1. 변경 파일별 영향

| 파일 | 변경 | 성격 | 영향 |
|------|------|------|------|
| `src/ground/frameCuboids.ts` | interface `FrameCuboids`에 `masks?: NormalizedPolygon[]`(L97) + `keptSet`(L298) + 성공 반환의 masks를 **`a.pairs.filter(keptSet 정합) → segBoxes[].mask`** 로 산출(L333~336, 원안의 `segBoxes.map` 전량에서 교체) | 옵셔널 가산 필드 + **필터 기준 반전** | 하위호환(옵셔널·강등 시 필드 부재는 불변). 단 **필드 의미가 바뀌었다** — masks가 이제 on-place 부분집합만 담는다(§3.3) |
| `web/index.html` | `.roi-toggles`에 `#roi-mask` label 1개(L51~52, 기본 off) | 신규 토글 | 반전과 무관, 변경 없음 |
| `web/app.js` | `drawRoiOverlay` L273 디스패치 1줄 + `drawMaskOverlay` 함수(L500~519) + `#roi-mask` change 리스너(L2856, 후속 추가) | 가산 렌더 레이어 | 렌더 로직 자체는 무변경(소스 데이터만 좁아짐). off일 때 픽셀 불변 |

---

## 2. 무변경 보장 파일 (회귀 0)

- **`src/capture/detectPipeline.ts`** — `cuboids?: FrameCuboids`(L89)가 `masks`를 통째로 운반, `runDetect`는
  `cuboids`를 그대로 반환(L343). 마스크용 편집 0줄. 단 `keptDetIdx: vehicles.map(...)`(L271, on-place 필터
  통과 인덱스)이 **masks 필터 기준의 입력**으로 새로 쓰이게 됐다(코드 변경 없이 기존 인자가 재사용됨 — §3.3).
- **점유 경로** — `onPlaceFilter` / `computeOccupancy` / `matchPlatesToSlots`: `masks`를 읽지 않음. 0줄.
- **`VpdClient.ts` / `segAssoc.ts` / `contact.ts` / `anchor.ts`** — seg 호출·정합·육면체 수학 불변. 0줄.
  (신규 VPD 호출 0 — `masks`는 `buildFrameCuboids`가 이미 부른 `segment()` 결과의 `a.pairs`를 재사용.)
- **`web/core.js` / `web/core.d.ts`** — `toPixelQuad` 재사용, 시그니처·구현 무변경. 0줄.

---

## 3. 어셈블리 / 의존성 영향

### 3.1 하위호환 (옵셔널 가산 필드, 반전 이후에도 유지)
`masks`는 옵셔널이라 기존 소비자는 무시해도 안전하고, 강등 경로엔 키 자체가 없어 기존 응답 shape가 완전 불변이다.
`DetectResult`/`FrameCuboids`를 읽는 어떤 코드도 수정 불필요 — 이 점은 반전 전후 동일하다.

### 3.2 세 소비 경로가 masks를 동승 (부수효과, 반전 전후 동일)
`masks`가 `FrameCuboids`에 붙으므로, `FrameCuboids`를 실어 나르는 **세 경로 모두**에 자동 동승한다 —
모두 뷰어 `state.vcuboidByKey`로 수렴해 `drawMaskOverlay`가 소비:

| 경로 | 운반체 | 뷰어 수신 |
|------|--------|-----------|
| 라이브 검출 | `DetectResult.cuboids`(detectPipeline L343) | `runLiveDetect` app.js L789 |
| 정밀수집 잡 | `JobCuboids = FrameCuboids & {...}`(CaptureJob L58, `...fc` L404) → `GET /capture/job-cuboids` | app.js L613 |
| 수동 토글 | `GET /capture/vehicle-cuboids`(라이브 촬영 1회) | app.js L650 |

**부수효과(수용, 반전으로 오히려 축소):** job-cuboids·vehicle-cuboids 응답에 실리는 마스크 폴리곤 수가
on-place 부분집합으로 줄어 payload 증가폭이 원안보다 작다. `CaptureJob.cuboidsByPreset`는 **인메모리**
(DB 저장 금지 — L57 주석)이므로 영속 저장 크기 영향은 여전히 없다.

### 3.3 [반전의 핵심 경계면 사실] `masks`와 `DetectResult.vehicles`가 kept-det 인덱스 집합을 공유
- `frameCuboids.ts` L298 `keptSet = new Set(keptIdx)`의 `keptIdx`는 `buildFrameCuboids` 호출 인자
  `keptDetIdx`이며, 이는 `runDetect`가 넘기는 `vehicles.map((v) => rawVehicles.indexOf(v))`
  (detectPipeline.ts L271) — 즉 **on-place 필터를 통과해 `DetectResult.vehicles`(VPD bbox 출력)를 구성하는
  바로 그 det 인덱스 집합**이다.
- 따라서 `masks.length ≤ DetectResult.vehicles.length`이며(정합 안 된 on-place det는 마스크 없음),
  masks에 실리는 모든 항목은 **반드시 on-place 차량 것**이다 — off-place(ROI 밖) det나 seg-only 검출의
  마스크는 구조적으로 masks에 들어올 수 없다.
- **파급:** `masks`를 소비하는 어떤 신규 코드도 이제 "VPD bbox가 뜨는 차량과 같은 집합"이라는 불변식에
  기댈 수 있다(QA 케이스 ④가 코드 레벨로 봉인, §4). 반대로 "seg가 관측한 전체 차량"을 보고 싶은 소비자는
  이 필드로는 더 이상 얻을 수 없다(§3.4).

### 3.4 진단 범위 축소 (트레이드오프, 은닉 없이 기록)
원안(seg 전량)은 정합 실패·seg-only 검출까지 화면에 드러내 "seg가 무엇을 오검했는지" 폭넓게 진단할 수
있었다. 반전 후에는 on-place 정합분만 남아 그 진단력 일부가 사라진다 — 화면 일관성(bbox=마스크 차량
집합)과 교환된 결과다(마스터 요구, §4.3 in 본 문서 §서두).

---

## 4. 회귀 위험 평가

- **전체 스위트**: `npx vitest run` → **146 파일 / 1607 테스트 전부 통과, 0 실패**
  (검증자 `_workspace_mask_20260715/03_qa_report.md` 실측 + 문서화 단계 2026-07-15 18:12 직접 재실행으로
  교차 확인, 두 결과 일치). 반전 전 판(1605)에서 **+2**(신규 케이스 ④⑤).
- **`test/frameCuboids.test.ts`**: 24 passed(기존 15 + 마스크 신규 9 = surface 5 + 옵셔널회귀 4). 반전으로
  기존 케이스 ③이 의도적으로 재작성됐고(seg-only 포함 단언 → 제외 단언), 신규 케이스 ④(on-place 필터링 직접
  검증) · ⑤(on-place인데 정합 없음 → masks=[])가 추가됐다.
- **`test/detectCuboid.test.ts`**: 8 passed(경계면 재검증, 반전으로 인한 값 변화 없음 — 해당 케이스는 det
  전량 on-place라 우연히 반전 전후 동일).
- **점유·육면체 회귀 6종 + detectPipeline**: 114 passed — `masks` 필터링이 `built.cuboids`/`assoc`/`summary`
  등 기존 산출에 영향 없음(masks는 이들과 독립적으로 계산되는 가산 필드).
- **타입체크**: `npx tsc --noEmit` → exit 0.
- 위험 등급: **낮음**. 필드 shape·하위호환성은 불변, 값 필터링만 변경. 소비자는 뷰어 `drawMaskOverlay` 단
  하나뿐이라 파급面이 좁다(§2, §3.2).

---

## 5. 후속 과제 / 확인 필요

1. **[해결됨] `#roi-mask` 토글 즉시성.** 이전 판에서 지적한 change 리스너 부재는 후속 처리로 해결됐다
   (`app.js` L2856, 다른 순수 렌더 토글 6종과 동일 패턴).
2. **실 VPD 라이브 스모크 미수행.** 유닛테스트는 seg 스텁 모킹만. 실제 seg 서버 응답으로 on-place 차량에만
   보라 실루엣이 뜨고 통로 차량은 안 뜨는지, 접지 하단 뜸이 육안으로 보이는지 라이브 검증 필요(리더 육안,
   QA도 스코프 밖으로 명시).
3. **M2 폴백(지면모델 없는 프리셋 마스크 표시).** 현재 지면모델(cuboidCtx) 배선 시에만 마스크 산출. 반전과
   무관하게 여전히 미해결 — 별도 작업.
4. **§3.4 진단 범위 축소가 실사용에 문제되는지 확인 필요.** seg-only/오검 진단이 다시 필요해지면 별도 토글
   (예: "마스크(전체)")을 추가하는 방안을 검토할 수 있으나, 현재 요구 범위 밖.

---

## 6. 요약

가산·옵셔널·읽기전용 시각화 레이어라는 골격은 유지되지만, **masks의 값 산출 기준이 반전**됐다(seg 전량 →
on-place det 정합분만, 마스터 요구). 핵심 경계면 사실: `masks`와 `DetectResult.vehicles`가 이제
**동일 kept-det 인덱스 집합**을 공유한다(`keptDetIdx` 경유, §3.3) — bbox와 마스크가 항상 같은 차량 집합을
그린다. 변경 파일 3종은 동일(frameCuboids.ts / index.html / app.js), 무변경 보장 파일도 동일. 회귀 근거는
**146파일 / 1607테스트 0 실패**(QA 실측 + 직접 재확인 일치, 신규 케이스 ④⑤ 포함)로 갱신. 미결: 실 VPD
스모크 · M2 폴백 · 진단 범위 축소의 실사용 영향.
