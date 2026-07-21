# 02 구현 — 뷰어 "마스크 show" 토글 (VPD seg 마스크 반투명 오버레이)

설계 확정본 `01_architect_plan.md` (M1)에 따른 구현. 신규 알고리즘 0, 신규 VPD 호출 0.

## 변경 파일 (3)

### 1. `src/ground/frameCuboids.ts` (+19줄)
- **import**: `import type { VehicleBox }` → `import type { NormalizedPolygon, VehicleBox }` (domain/types.js 경유, 이미 re-export됨). 추가로 `import { isVehicleOnPlace } from '../capture/onPlaceFilter.js';`.
- **타입 가산**: `interface FrameCuboids`에 `masks?: NormalizedPolygon[]` 옵셔널 필드 추가(`estimateUnverified: true;` 뒤).
- **성공 반환에만 채움** — ⚠️ **최종 의미(마스터 요구, 후속 §"masks on-place seg 직접 필터" 참조)**:
  ```ts
  // return 상단:
  const normSlotPolys = ctx.slotPolysPx.map((poly) => poly.map((p) => ({ x: p.x / model.imgW, y: p.y / model.imgH })));
  ...
  masks: segBoxes
    .filter((b) => isVehicleOnPlace(b.rect, normSlotPolys)) // VPD det 과 동일한 on-place 필터를 seg 박스에 직접
    .map((b) => b.mask)
    .filter((m): m is NormalizedPolygon => !!m), // 옵셔널 타입 방어
  ```
  - **의미**: on-place seg 마스크 **전부**(VPD on-place 방식). 육면체 정합(`a.pairs`, IoU≥0.4·1:1)·`keptIdx` 무관 → 병합/밀착 차도 표시.
  - **degraded() 경로 무변경**: seg 호출 前/실패 강등은 `masks` 필드 부재(옵셔널 가산 규약). `segDegraded`(검출 0대·S-1)면 `segBoxes=[]` → `masks: []`.

### 2. `web/index.html` (+3줄)
- `.roi-toggles` 내 `#roi-vcuboid` label 뒤, `#vcuboid-badge` span 앞에 `<label>…<input id="roi-mask" type="checkbox" /> 마스크</label>` 추가.
- **`checked` 없음 → 기본 off** (제약 3 준수).

### 3. `web/app.js` (+35줄)
- **디스패치 1줄**: `drawRoiOverlay`의 `drawVehicleCuboidOverlay(ctx);` 다음 줄에 `drawMaskOverlay(ctx);` 추가(지면 가드 이전).
- **신규 함수 `drawMaskOverlay(ctx)`** (`drawVehicleCuboidOverlay` 뒤): `#roi-mask` 체크 가드 → `state.vcuboidByKey[currentFrameKey()]?.masks` 순회 → 각 폴리곤을 `toPixelQuad`(core.js, N점 매퍼)로 픽셀화 → 보라 반투명 `rgba(175,82,222,0.28)` 채움 + `#af52de` 외곽선. masks 부재/빈 배열/폴리곤 <3점 → graceful skip.
- **change 리스너 1줄** (후속, 아래 참조): `$('roi-mask').addEventListener('change', drawRoiOverlay);`

## 후속 처리 — `#roi-mask` change 리스너 (문서화 검증 지적)

**지적:** `#roi-mask`에 전용 change 리스너가 없어 토글 시 즉시 재렌더 미보장 우려.

**확인(추측 아님, app.js L2849~2862 실측):** 단순 렌더 토글 6종(`#roi-vehicle`·`#roi-plate`·`#roi-floor`·`#roi-occupancy`·`#roi-detect`·`#roi-cuboid`)은 **각자 개별 `addEventListener('change', drawRoiOverlay)`** 로 재렌더한다(위임 리스너·폴링 의존 아님). `#roi-vcuboid`만 예외로 재렌더 + 조건부 `loadVehicleCuboids()` 자동 로드를 붙인다.

**처리:** `#roi-mask`는 순수 렌더 토글 부류다(masks는 detect 응답에 이미 동승 → 별도 데이터 로드 불필요). 따라서 `#roi-cuboid` 다음 줄에 **동일 1줄 패턴** 추가:
```js
$('roi-mask').addEventListener('change', drawRoiOverlay);
```
- `#roi-vcuboid`식 자동 데이터 로드는 **추가하지 않음**(과설계 — 마스크는 응답 동승). 이로써 `#roi-mask`가 단순 렌더 토글 6종과 정확히 같은 부류가 됨.

## 무변경 확인 (설계 §변경 파일 무변경 보장)
- `src/capture/detectPipeline.ts`: **내가 편집 0줄** (`git diff | grep mask` → 0건). `DetectResult.cuboids`가 masks를 자동 운반.
  - ⚠️ 이 파일은 세션 시작 시점 git 스냅샷에 이미 `M`(선행 브랜치 작업 cuboid/lpd). 그 diff는 본 작업과 무관.
- `web/core.js` / `web/core.d.ts`: 내가 편집 0줄(`toPixelQuad` 재사용). 마찬가지로 선행 브랜치 작업의 pre-existing `M` 존재 — 본 작업 무관.
- `VpdClient.ts` / `segAssoc.ts` / `contact.ts` / `anchor.ts` / `onPlaceFilter.ts` / `Aggregator.ts` / `SqliteStore.ts`: git diff 0줄(내 세션 기준).

## 설계 대비 편차
- **없음(1건 명시)**: 설계서는 `segBoxes.map((b) => b.mask!)` non-null 단정을 제시했으나, `SegBox.mask`가 옵셔널 타입이라 설계서 미해결가정 #1의 방어책(`.filter`)을 채택. 동작 동일(정상 경로 전량 통과), 타입세이프.

## 검증 결과
- `npx tsc --noEmit` → **exit 0**.
- (리스너 후속 시점) `vitest run frameCuboids + detectPipeline` → 52 passed.
- **masks on-place seg 직접 필터(3회차) 후 최종 재검증:**
  - `npx tsc --noEmit` → **exit 0**.
  - `vitest run test/frameCuboids.test.ts` → **21 passed / 3 failed**(위 §충돌 목록 ③④⑤ — 의도된 반전, 미수정).
  - `vitest run test/detectCuboid.test.ts` → **8 passed**.
- 내 target 3파일 diffstat: frameCuboids.ts +19 / app.js +35 / index.html +3.

## 후속 처리 — masks on-place 반전 (마스터 요구, 설계 결정 반전)

**요구:** 마스크를 VPD det 출력과 동일하게 **현재 프리셋 ROI(on-place) 통과분만** 내보낸다. 기존은 seg 전량이라 ROI 밖(통로 등) 차량 실루엣까지 그려져 VPD bbox(on-place만)와 불일치했다.

**변경 (`frameCuboids.ts`):**
- 성공 반환의 masks 산출을 `segBoxes 전량` → `a.pairs 중 keptSet(=keptIdx) 정합분`으로 교체. `keptSet`은 return 상단 선언.
- `p.segIdx`는 **압축 배열 `segBoxes` 위치**를 그대로 인덱싱(내부 계산 기준). `assoc` export용 vpdIdx 재매핑값 사용 금지(:302~307 주석 근거).
- masks 필드 주석(:92~97)·산출부 주석 모두 "seg 전량" → "on-place det 정합분만(VPD 출력과 동일)"으로 정정 + 반전 근거 1줄 명시(조용한 변경 아님).

**엣지 동작(확인 완료):**
- on-place det인데 seg 정합 없음(unmatched det) → 마스크 없음(bbox만 표시). 정상.
- seg-only(ROI 밖/det 없음) → 제외(마스터가 원하는 제거).
- `keptDetIdx` 미지정/강등(전량 kept) → 정합된 것 전부(VPD 강등 시 전량 표시와 일치).

**QA 테스트 충돌 목록 (내가 고치지 않음 — 검증자 갱신 대상):**
- `test/frameCuboids.test.ts` describe `🟣 masks surface …` **③ "seg 전량 — 정합 실패한 seg-only 마스크도 실린다"** (L292~303) — **런타임 실패(의도된 반전)**. 충돌 단언:
  - L296 `expect(r.masks).toHaveLength(2)` → 이제 **1** (seg-only far 제외).
  - L300 `expect(r.masks![1]).toEqual(far.mask)` → index 1 없음.
  - L302 `expect(r.summary.segCount).toBe(r.masks!.length)` → segCount=2 ≠ masks.length=1.
- ①(L269) 제목은 "masks.length === seg.boxes.length"라 **의미상 부정확**해졌으나, 그 케이스(seg 1개·on-place 정합)에선 단언이 우연히 성립 → **런타임 통과**. 검증자가 제목/의도 재정의 권장.
- describe 제목(L265)·머리주석(L262~264)의 "seg 전량" 표현도 새 의미와 불일치(문서성) — 검증자 갱신 대상.
- ② 좌표 보존(L286), `🟣 masks 옵셔널 회귀 0` 블록(L306~) 전부 새 의미와 무충돌 → 통과.

## 후속 처리 (goal/loop 3회차) — masks: 정합 게이팅 제거, on-place seg 직접 필터

**라이브 실측(cam1/preset1):** detCount 7 / segCount 6 / matched 4 / unmatchedDet 3(det2 IoU0.477 경합패배·det5·6 IoU0.27·0.29) / segOnly 2 → 정합 기반 masks=4. seg가 만든 6개 중 2개(병합/밀착·저IoU) 탈락 → 마스터 요구("VPD 박스 있는 곳에 마스크 모두") 미충족.

**변경 (`frameCuboids.ts`):**
- masks 산출을 `a.pairs∩keptIdx 정합분` → `segBoxes 에 isVehicleOnPlace 직접 적용`으로 교체. `keptSet`/`a.pairs` 기반 masks 로직 제거.
- `import { isVehicleOnPlace } from '../capture/onPlaceFilter.js';` 추가.
- `normSlotPolys` = `ctx.slotPolysPx` 픽셀→정규화(`/ model.imgW,imgH`). seg `.rect`(정규화)와 좌표계 일치.
- 필드 주석(:92~97)·산출부 주석을 "on-place det 정합분만" → "on-place seg 마스크 전부(VPD on-place 방식, 육면체 정합 무관)"로 정정 + 반전 근거 명시.

**슬롯 폴리곤 소스 동일성 확인(추측 아님):**
- `ctx.slotPolysPx`는 `cuboidContext.ts:52~57` → `loadNormalizedPlaceRoi(placeRoiFile)` → `parking_spaces`(PtzCamRoi.json) 정규화분을 `* imgW,imgH` 한 픽셀 폴리곤이다.
- VPD det 의 on-place 필터는 `captureRoutes.ts:494~498`에서 **바로 그 `ctx.slotPolysPx`를 `/ imgW,imgH`로 정규화**해 `filterVehiclesOnPlace`에 넘긴다.
- 즉 내 `normSlotPolys`는 captureRoutes 의 `polysNorm`과 **완전히 동일한 폴리곤·동일 정규화**. → seg 마스크가 VPD det bbox 와 정확히 같은 주차면·같은 판정식(`isVehicleOnPlace`)을 쓴다. **소스 불일치 없음.**

**엣지 동작(확인):**
- on-place det인데 seg 정합 없음(unmatched det) → seg 박스가 on-place면 마스크 표시(정합 무관, 의도됨).
- seg-only(det 없음)라도 on-place면 → 마스크 표시(마스터 요구: "박스 없어도 seg 실루엣이 주차면 위면 보인다"). off-place seg → 제외.
- keptDetIdx 미지정/강등 → masks 는 on-place seg 전부(det 필터와 독립).

**QA 테스트 충돌 목록 (내가 고치지 않음 — 검증자 갱신 대상):** `test/frameCuboids.test.ts` describe `🟣 masks surface …`(이전 정합-기반 의미로 작성됨) 중 3건 실패 = 의도된 반전:
- **③ "[반전] seg-only 는 제외"** (L304~307): `toHaveLength(1)`/`not.toContainEqual(far.mask)` → far seg 가 on-place 면 이제 **포함**(got 2). 새 의미: on-place seg 전부.
- **④ "[신규] on-place 필터링 본질 — off-place det 는 마스크 X"** (L323~326): `toHaveLength(1)`/`not.toContainEqual(b.mask)` → keptIdx 제외(det b)여도 b **seg 박스가 on-place면 마스크 포함**(got 2). masks 는 keptIdx 가 아니라 seg 박스 on-place 로 판정.
- **⑤ "on-place det인데 seg 정합 없으면 마스크 없다"** (L333~334): `masks toEqual []` → seg 박스가 on-place 면 정합과 무관하게 **마스크 존재**(got 1). masks 는 정합에 묶이지 않는다.
- 부수: describe 제목("on-place det 정합분만") 및 ①②의 제목/주석도 새 의미(on-place seg 직접)로 재정의 권장 — ①②는 단일 on-place 정합 케이스라 런타임 통과하나 표현이 stale.
- `detectCuboid.test.ts` → **8 passed**(무충돌).

**무변경 유지 확인:** `onPlaceFilter.ts`(호출만·수정 0)·`VpdClient.ts`·`segAssoc.ts`·`web/core.js`·점유 경로 전부 내 세션 git diff 0줄.

## 후속 처리 (goal/loop 4회차) — 마스크 per-instance 색상

**마스터 실측 확정:** 마스크 겹침은 중복 검출이 아니라 "인접 마스크가 같은 보라색이라 뭉쳐 보이는 것"(iou 스윕 0.5~0.9 동일·dup 0·maxPairIoU 0.22). → **마스크마다 색을 순환**해 인접 차량이 구분되게 한다. 순수 뷰어 렌더 변경.

**변경 (`web/app.js` — `drawMaskOverlay`만):**
- 모듈 레벨 `const MASK_PALETTE`(잘 구분되는 RGB 8종) 추가 — `drawMaskOverlay` 바로 위.
- 순회를 `for...of` → `masks.forEach((poly, i) => ...)`로 바꿔 인스턴스 인덱스 확보. 내부 `pts.forEach`의 index 변수는 충돌 피해 `i`→`j`.
- 색상: 고정 `rgba(175,82,222,0.28)` → `const [r,g,b] = MASK_PALETTE[i % MASK_PALETTE.length]` 기반 `fillStyle rgba(r,g,b,0.30)` + `strokeStyle rgba(r,g,b,0.95)`(같은 색 진한 외곽선). `lineWidth 1.5` 유지.
- 가드·`toPixelQuad`·polygon<3점 skip·save/restore 로직 전부 그대로. **함수 밖 무변경**(resolveAbsPtz 등 선행 미커밋 hunk 미접촉).

**검증:**
- `node --check web/app.js` → OK. `npx tsc --noEmit` → **exit 0**.
- `vitest run frameCuboids detectCuboid` → **34 passed**(렌더 변경 — 마스크 데이터 로직 무변경, 회귀 0).
- 캔버스 렌더라 유닛 한계 → 최종은 마스터 육안(리더 안내): 인접 차량 마스크가 서로 다른 색으로 구분되는지.

## 검증자(QA)에게
- 추가 유닛테스트 제안: `frameCuboids.test.ts`에 (a) 성공 케이스 `masks.length === seg.boxes.length` 및 각 원소 정규화 폴리곤, (b) degraded 케이스(ctx=null / canSegment=false / segDegraded 전강등)에서 `masks` 필드 `undefined`(회귀 0) 검증.
- 라이브 육안(리더): off→픽셀 불변 / on→차량 위 보라 반투명 실루엣 / 지면모델 없는 프리셋→마스크 안 뜸(정상).
