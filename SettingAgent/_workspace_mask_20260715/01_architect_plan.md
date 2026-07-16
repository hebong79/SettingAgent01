# 01 설계 — 뷰어 "마스크 show" 토글 (VPD seg 마스크 반투명 오버레이)

작업 성격: **선형 파이프라인 · 소규모 시각화**. 신규 알고리즘 0, 신규 VPD 호출 0.

---

## 결정 — M1 (coupled), 단 **원본 seg 마스크 전량**을 surface

**근거(3줄):**
1. M2를 "이중 seg 호출 없이" 올바로 구현하면 = `buildFrameCuboids`가 이미 부른 `segment()` 결과를 재사용해야 하고, 그건 사실상 M1이다. 남는 차이는 "지면모델 없을 때만 seg를 한 번 더 부르는 폴백"뿐 — 신규 호출 사이트·정합·`DetectVehicle.mask` 필드·중복가드를 더한다(과설계).
2. 실사용 경로(`/capture/detect` → `runDetect`, `#roi-vcuboid` 기본 on)는 **지면모델이 배선된 워크플로**에서만 돈다. 마스크 show의 두 목적("실루엣 정합"·"접지 하단이 뜨는가")은 **육면체 튜닝과 같은 화면에서** 쓰이며, 접지 검증은 지면모델이 있을 때만 의미가 있다. 따라서 M1의 유일한 한계(지면모델 부재 시 마스크 미표시)는 이 기능의 실제 사용 맥락과 충돌하지 않는다.
3. M1은 `buildFrameCuboids` 성공 반환에 `masks` 1필드 가산 + 뷰어 렌더 1블록으로 끝난다 — "빠르게·최소 변경"에 가장 부합, 이중 호출 위험 0.

**핵심 보정:** assoc(det↔seg 정합)로 게이팅하지 **않는다**. 마스크 show의 목적은 "seg가 무엇을 봤는지" 육안 검증이므로 `seg.boxes` **전량**(마스크 유효분 전부, 정합 실패·seg-only 포함)을 그대로 내보낸다. 이게 assoc 매핑보다 더 단순하고 목적에 정확하다.

**M1의 알려진 한계(수용):** 지면모델/슬롯 미배선 → `buildFrameCuboids`가 seg 호출 **전** 강등 → `masks` 필드 없음 → 마스크 미표시. issues[]에 사유가 이미 뜬다(조용한 실패 아님). 지면모델 없이도 마스크가 필요해지면 그때 M2 폴백을 별도 작업으로 추가.

---

## 변경 파일별 정확한 편집 지점

### 1. `src/ground/frameCuboids.ts` — `FrameCuboids`에 `masks?` 가산
- **타입 추가** (interface `FrameCuboids`, 현재 `estimateUnverified: true;` 위 L91 근처):
  ```ts
  /**
   * ★ 시각화 전용(가산·옵셔널). seg 응답의 **마스크 유효 검출 전량**(정규화 폴리곤).
   *   정합/육면체 성공과 무관 — "seg가 무엇을 봤나" 육안 검증용. 강등(seg 호출 前) → 필드 없음.
   *   점유·육면체 산출 로직은 이 필드를 읽지 않는다(순수 표시).
   */
  masks?: NormalizedPolygon[];
  ```
  - `NormalizedPolygon`는 이미 import되어 있음(L20 `import type { VehicleBox } from '../domain/types.js'` 옆) — 없으면 `import type { NormalizedPolygon }` 추가. (실제로 `contact.ts`/타입 경유. dev가 import 라인 확인.)
- **성공 반환에만 채움** (L289~320 `return { imgW: model.imgW, ... }` 객체):
  ```ts
  masks: segBoxes.map((b) => b.mask!), // seg.boxes = 마스크 유효분만(VpdClient가 mask-less drop). 정규화 폴리곤.
  ```
  - `segBoxes = seg.boxes`(L221), 각 `SegBox.mask: NormalizedPolygon`(정규화, VpdClient가 이미 채움).
  - **degraded() 경로에는 넣지 않는다** — seg 호출 전/실패 강등은 masks 없음(필드 부재 = 옵셔널 가산 규약, 기존 cuboids와 동일 거동).
  - `seg.segDegraded`(검출 0대·S-1)면 `segBoxes=[]` → `masks: []`(빈 배열, 정상).

### 2. `src/capture/detectPipeline.ts` — **무변경**
- `DetectResult.cuboids?: FrameCuboids`(L89)가 `masks`를 통째로 실어 나른다. `runDetect`는 `cuboids`를 그대로 반환(L267~275, L하단) → 클라이언트 `detect.cuboids.masks`로 도착. **편집 0줄.**

### 3. `web/index.html` — 토글 추가
- `.roi-toggles` div 내부, `#roi-vcuboid` label(L48~50) **뒤에** 추가:
  ```html
  <label title="VPD seg 마스크(차량 실루엣)를 반투명으로 표시. 실루엣 정합·접지 하단 뜸 육안 검증용. 지면모델 배선 시에만 산출됨">
    <input id="roi-mask" type="checkbox" /> 마스크
  </label>
  ```
  - `checked` 없음 → **기본 off**(제약 3).

### 4. `web/app.js` — 렌더 함수 + 디스패치
- **디스패치 추가** (`drawRoiOverlay`, L272 `drawVehicleCuboidOverlay(ctx);` 다음 줄):
  ```js
  drawMaskOverlay(ctx); // VPD seg 마스크 반투명 오버레이(#roi-mask, 기본 off). 지면 가드 이전(수집 중에도 표시).
  ```
- **신규 함수** (`drawVehicleCuboidOverlay` 다음, L493 뒤):
  ```js
  function drawMaskOverlay(ctx) {
    if (!$('roi-mask').checked) return;
    const data = state.vcuboidByKey[currentFrameKey()]; // 육면체와 동일 소스(masks 동승).
    const masks = data?.masks;
    if (!masks || !masks.length) return; // 지면모델 미배선/강등 → 미표시(조용한 소실 아님, issues에 사유).
    ctx.save();
    for (const poly of masks) {
      if (!poly || poly.length < 3) continue;
      const pts = toPixelQuad(poly, overlay.width, overlay.height); // N점 정규화 폴리곤 → 픽셀.
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.px, p.py) : ctx.moveTo(p.px, p.py)));
      ctx.closePath();
      ctx.fillStyle = 'rgba(175, 82, 222, 0.28)'; // 보라 반투명 — 초록(바닥)·청록(bbox)·주황(육면체)과 구분(제약 4).
      ctx.fill();
      ctx.strokeStyle = '#af52de';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }
  ```
  - `toPixelQuad`(core.js L19)는 `arr.map(p => ({px:p.x*w, py:p.y*h}))` — 임의 N점 처리(마스크 폴리곤 OK). 마스크 점은 `{x,y}` 객체(frameCuboids `px` 매퍼 입력과 동형).
  - `state.vcuboidByKey`는 `runLiveDetect`(L763)가 `detect.cuboids`를 이미 저장 → **신규 state 없음**. masks가 `.masks`로 자동 동승.

### 5. `web/core.js` / `web/core.d.ts` — **무변경**
- `toPixelQuad` 재사용. 시그니처·구현 손대지 않음.

---

## 단계별 구현 계획 + 검증 기준

| # | 단계 | 검증 (vitest) | 검증 (리더 육안) |
|---|------|--------------|-----------------|
| 1 | `frameCuboids.ts`: `FrameCuboids.masks?` 타입 + 성공 반환에 `masks: segBoxes.map(b=>b.mask!)` | 성공 케이스: 반환 `masks.length === seg.boxes.length`, 각 원소가 정규화 폴리곤. **degraded 케이스(ctx=null / canSegment=false / segDegraded 전강등): `masks` 필드 undefined**(회귀 0). 기존 `frameCuboids.test.ts` 전부 green(cuboids/assoc/summary shape 불변) | — |
| 2 | `detectPipeline.ts` 무변경 확인 | 기존 `detectPipeline.test.ts` green. detect 응답에 `cuboids.masks`가 지면모델 주입 시 존재, 미주입 시 `cuboids` 키 자체 없음(회귀 0) | — |
| 3 | `index.html` `#roi-mask` 토글(기본 off) | — | 뷰어 로드 시 "마스크" 체크박스 **꺼진 상태**로 보임 |
| 4 | `app.js` `drawMaskOverlay` + 디스패치 | (해당 시) core 순수함수 테스트 유지 green | ① off일 때 오버레이 **픽셀 불변**(기존과 동일). ② 검출 실행 후 on → 각 차량 위에 **보라 반투명 실루엣**. ③ 마스크 하단이 바퀴 접지선과 얼마나 뜨는지 육안 확인 가능. ④ 지면모델 없는 프리셋 → 마스크 안 뜸(정상, issues 확인) |

**성공 정의:** 위 4행 검증 전부 통과 + 점유 판정/기존 오버레이 회귀 0.

---

## 영향 파일 목록

**변경(4):**
- `src/ground/frameCuboids.ts` — `masks?` 타입 1줄 + 성공 반환 1줄 (가산·옵셔널).
- `web/index.html` — 토글 label 1개.
- `web/app.js` — 디스패치 1줄 + `drawMaskOverlay` 함수 1개(~15줄).
- 테스트: `test/frameCuboids.test.ts`(또는 상응)에 masks surface/부재 케이스 가산.

**무변경 보장(회귀 0):**
- `src/capture/detectPipeline.ts` — `DetectResult.cuboids`가 masks를 자동 운반. 0줄.
- `onPlaceFilter` / `computeOccupancy` / `matchPlatesToSlots` — 점유 경로 0줄(제약 1).
- `VpdClient.ts` / `segAssoc.ts` / `contact.ts` / `anchor.ts` — seg 호출·정합·육면체 수학 0줄.
- `web/core.js`·`core.d.ts` — `toPixelQuad` 재사용, 0줄.

**부수효과(수용):** `masks`가 `FrameCuboids`에 붙으므로 `CaptureJob.JobCuboids`·`/capture/vehicle-cuboids` 응답·잡 영속화에도 동승한다(폴리곤 수십 점/대 → 경미한 payload 증가). 마스크 show가 라이브 검출 오버레이 전용임을 감안하면 무해. 저장 크기가 문제되면 별도 작업으로 분리(현재 범위 밖).

---

## MCP 경계 판단
순수 **뷰어 시각화**. LLM 두뇌·결정형 도구 어느 쪽도 아님(오버레이 렌더). 서버는 이미 계산된 마스크를 **패스스루**만 한다 — 신규 추론·반복 루프 0.

---

## 미해결 가정
1. **`SegBox.mask` 비옵셔널 가정:** `VpdClient.segment()`가 mask-less 검출을 drop하므로 `seg.boxes` 전원 mask 보유. `b.mask!` non-null 단정 안전. (dev: `VehicleBox.mask`가 옵셔널 타입이면 `.filter(m=>m)`로 방어하되 정상 경로에선 전량 통과.)
2. **마스크 좌표계 = 뷰어 오버레이와 동일 정규화 기준.** det bbox와 같은 캡처 해상도 정규화(A1 기설계 확정) → 변환 없이 `overlay.width/height` 곱만으로 정합. 라이브 육안(단계4-②)에서 최종 확인.
3. 색상 `rgba(175,82,222,·)`(보라)는 제약 4 충족 제안값. 리더가 주황 선호 시 `drawMaskOverlay` 색만 교체(1줄, 로직 무관).
