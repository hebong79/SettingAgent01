# 03 QA 리포트 — 뷰어 "마스크 show" (VPD seg 마스크 오버레이) 검증

**결론(최신, 3차 반전 기준): 전 항목 통과. 발견 이슈 0. 구현자 재작업 불요.**
`vitest run` 실제 실행 · `tsc --noEmit` 실제 실행 결과 그대로 보고.

⚠️ **이 리포트는 3차(최신) 의미 기준 최종본이다.** `masks` 의미가 짧은 기간에 세 번 바뀌었다 —
조용한 덮어쓰기를 피하기 위해 아래에 **세 의미의 이력을 전부** 남기고, 최신(3차) 검증 결과를 그 뒤에 기록한다.

## masks 의미 변경 이력 (조용한 덮어쓰기 금지 — 전부 기록)

| 차수 | 의미 | 트리거 | 검증 결과(당시) |
|------|------|--------|----------------|
| **1차(최초 M1 설계)** | `segBoxes` 전량(정합·on-place 무관) — "seg 가 무엇을 봤나" 육안 검증 | 최초 설계·구현 | 통과(이슈 0), `test files 146 / tests 1605` |
| **2차** | `a.pairs` 중 `keptSet(=keptIdx)` 정합분만 — VPD det 출력과 동일 기준으로 좁힘 (`masks = a.pairs.filter(p=>keptSet.has(p.detIdx)).map(p=>segBoxes[p.segIdx].mask)`) | 마스터 요구 — bbox·마스크 오버레이 차량 집합 불일치 제거 | 통과(테스트 갱신 후 이슈 0), `test files 146 / tests 1607` |
| **3차(현재)** | `segBoxes.filter(b => isVehicleOnPlace(b.rect, normSlotPolys))` — **det 정합(a.pairs)·keptIdx 와 완전히 무관**, seg 박스 자체를 VPD det 과 동일한 on-place 필터로 직접 거른다 | goal/loop 라이브 실측(cam1/preset1) — 2차 방식이 육면체 정합 게이트(IoU≥0.4·1:1 경합)에 마스크를 묶어 병합/밀착 차의 마스크가 탈락함을 발견(seg 6개 중 matched 4 → masks 4) | **통과(이번 리포트, 이슈 0)**, `test files 146 / tests 1609` |

**3차 반전의 핵심**: 마스크는 seg 실루엣 **표시 목적**이지 육면체(엄격한 det↔seg 정합) 산출물이 아니다. 정합 임계·1:1 경합에 마스크를 묶으면 안 된다 — seg 박스의 **공간 위치**(on-place 여부)만으로 걸러야 한다.

## 실행 결과 (실측, 3차 반전 후 최종)
| 실행 | 결과 |
|------|------|
| `npx tsc --noEmit` | **exit 0** |
| `test/frameCuboids.test.ts` | **26 passed** (기존 15 + 마스크 관련 11: surface 7 + 옵셔널회귀 4) |
| `test/detectCuboid.test.ts` | **8 passed** (경계면 케이스 포함, 무변경) |
| `test/detectPipeline.test.ts` | **30 passed** (회귀 기준선 불변) |
| 점유·육면체 회귀 6종(computeOccupancy·onPlaceFilter·captureJobCuboid·captureJobOccupancyGate·cuboidBoundary·cuboidTraceability) + detectPipeline | **114 passed** |
| **전체 스위트** `npx vitest run` | **146 files / 1609 tests passed, 0 failed** |

## 3차 구현 확인 (`src/ground/frameCuboids.ts:295~341`)
```ts
const normSlotPolys = ctx.slotPolysPx.map((poly) => poly.map((p) => ({ x: p.x / model.imgW, y: p.y / model.imgH })));
...
masks: segBoxes
  .filter((b) => isVehicleOnPlace(b.rect, normSlotPolys))
  .map((b) => b.mask)
  .filter((m): m is NormalizedPolygon => !!m),
```
- `isVehicleOnPlace`(`src/capture/onPlaceFilter.ts:29`) — VPD det on-place 필터(`filterVehiclesOnPlace` 가 내부에서 쓰는 바로 그 함수)를 **seg 박스 rect 에 직접** 적용. det 별도 계산(`a.pairs`/`keptIdx`) 경유 0.
- `normSlotPolys` = `ctx.slotPolysPx`(픽셀)를 이미지 크기로 정규화 — det on-place 필터와 **동일 폴리곤·동일 정규화 기준**(별도 좌표계 변환 없음).

## 검증 항목별 결과 (3차 의미 기준, `test/frameCuboids.test.ts` describe `🟣 masks surface — on-place seg 직접 필터`)

**① 성공 경로 (통과, 재작성).** on-place seg 박스 1개(car, 슬롯 k=0 위) → `masks.length===1`. 주석을 "det 정합 때문"이 아니라 "seg rect 자체가 on-place라서"로 정정.

**② 좌표 보존 (통과, 무변경).** `masks[0]` 이 seg 입력 정규화 마스크와 `toEqual`.

**③ ★★ [3차 반전 본질] on-place seg-only 포함 (통과, 완전 재작성 — 구현자 지적 사항).**
det(가운데) + seg 2개(car=정합, far=슬롯 k=1 위 on-place·정합 실패) 구성:
- `summary.matched===1`(육면체는 여전히 정합된 car 만), `summary.segOnly===1`(정합 실패 집계 불변 — 육면체 로직 자체는 안 바뀜).
- **`masks.length===2`**, `masks` 가 `car.mask` 와 `far.mask` **둘 다 포함** — 2차에서는 `not.toContainEqual(far.mask)` 였던 단언을 `toContainEqual`로 완전히 뒤집었다. 주석에 "2차 반전에선 여기가 실패했다"를 명시해 회귀 이력을 코드에 남김.

**④ ★ [3차 반전] keptIdx(det) 무관 (통과, 완전 재작성).**
det 2대(둘 다 공간상 on-place, 슬롯 k=-1/k=1) 중 `keptDetIdx:[0]` 로 det#1(b) 를 호출측이 임의 제외:
- `summary.kept===1`, `summary.filteredOut===1`(det#1 은 육면체를 못 만든다 — 이 부분은 불변).
- **`masks.length===2`**, `a.mask`·`b.mask` **둘 다 포함** — 2차에서는 b 제외였던 것을 뒤집음. keptIdx 는 이제 masks 에 영향 0.

**⑤ ★ [3차 반전] unmatched det 여도 masks 존재 (통과, 완전 재작성).**
det(가운데)과 정합 안 되는 far(슬롯 k=1 위, on-place)만 seg 로 줌:
- `r.unmatched.length===1`, `r.cuboids` `toEqual([])`(육면체 정합 실패는 불변).
- **`masks.length===1`**, `masks[0]===far.mask` — 2차에서는 `masks===[]` 였던 것을 뒤집음(정합 무관하게 on-place 면 마스크 존재).

**⑥ ★ [신규] off-place seg 제외 (통과, 마스터 원래 요구 "현재 프리셋 ROI 만" 유지 확인).**
슬롯 폴리곤 범위(a ∈ [-3.75, 3.75]) 밖에 seg 박스(aC=20)를 두고 on-place(car)와 함께 seg 응답에 포함:
- `masks.length===1`(car 만), off-place 박스의 마스크는 seg-only 여도 `not.toContainEqual` — "on-place 만" 요구가 3차에서도 유지됨을 직접 봉인.

**⑦ ★ [신규] 정합 임계와 완전 독립 (통과).**
슬롯 3개 전부에 on-place seg 박스(left/car/right)를 하나씩 두고 det 는 car 하나뿐:
- `summary.matched===1`, `summary.segOnly===2`, `summary.segCount===3`(관측 자체 불변).
- **`masks.length===3`** — matched(1) 도 아니고, "우연히 segCount 와 같아 보일 수 있는" 값도 아님(⑥이 이미 "off-place 섞이면 segCount ≠ masks.length" 를 반증). masks 개수가 오직 on-place seg 박스 수로 결정됨을 봉인.

**옵셔널 회귀 0 블록(`🟣 masks 옵셔널 회귀 0`, 무변경).** ctx null / canSegment=false / seg throw(강등) → `masks` 필드 부재. seg HTTP 500(S-1) → `masks===[]`. 이 블록은 on-place 필터 적용 **이전** 단계(seg 호출 자체가 없거나 결과가 비어있음)라 3차 반전과 무충돌 — 재검증만으로 확인 완료.

**detect 응답 shape 회귀 0 (`detectCuboid.test.ts`, 통과, 재검증만).** `cuboidCtx` 미주입 → `cuboids` 키 없음. 경계면 케이스(③b): seg 마스크가 `detect.cuboids.masks` 로 도착 — 이 픽스처는 det 1대가 전량 on-place(슬롯 위)이므로 3차 의미에서도 값이 동일해 재검증만으로 충분했다.

**점유 경로 무영향 (통과).** onPlaceFilter/computeOccupancy/captureJob 등 114테스트 + 전체 1609 green.

## 경계면 — masks 가 이제 `DetectResult.vehicles`(det on-place) 와 **다른 집합**이다

이번 반전의 가장 중요한 경계면 함의:
- **2차까지**: `masks` 의 기준 집합은 `keptIdx`(= `vehicles.map(v=>rawVehicles.indexOf(v))`, `DetectResult.vehicles` 와 동일 det 인덱스 집합)였다. 즉 `#roi-detect`(det bbox)와 `#roi-mask`(마스크)가 **같은 차량 집합**을 그렸다.
- **3차(현재)**: `masks` 는 **seg 박스의 on-place 필터**로 독립적으로 결정된다. `DetectResult.vehicles`(det on-place, VPD 검출 기준)와 `cuboids.masks`(seg on-place, seg 검출 기준)는 **서로 다른 검출 모델·집합**이다 — 두 모델이 다르게 보면(seg 가 병합/밀착 차를 하나로 보거나 det 가 놓친 차를 seg 가 봤거나) 두 오버레이의 차량 수가 달라질 수 있다.
- **뷰어 소비 측 영향(app.js, 무변경 확인)**: `drawMaskOverlay`(app.js:500~504)는 여전히 `state.vcuboidByKey[currentFrameKey()]?.masks` 를 읽을 뿐, det 집합과 비교하지 않는다 — 코드 배선은 이 반전에 영향받지 않는다(순수 서버 산출 기준 변경). `drawVehicleCuboidOverlay`(육면체, det 권위)와 `drawMaskOverlay`(마스크, seg on-place)가 이제 **서로 다른 기준의 두 레이어**임을 리더가 화면에서 인지해야 한다(육안 확인 시 "마스크 개수 ≠ 육면체/det 개수"가 정상임을 전제로 봐야 함).
- **타입/필드명**: `masks: NormalizedPolygon[]` 키·정규화 좌표 형식은 1~3차 내내 불변 — 이번 반전은 **필터 기준**만 바뀌었을 뿐 payload shape 계약은 유지된다.

## 스코프 밖 (리더 육안 담당 — 누락 아님, 명시)
DOM 렌더 결과(off→픽셀 불변 / on→**on-place 슬롯 위 seg 실루엣 전부**(병합·밀착 차 포함, 정합 무관) 표시되고 off-place/통로만 제외 / 지면모델 없는 프리셋→미표시)는 캔버스 렌더 육안 검증 영역으로 유닛테스트 범위(payload 배선·shape·필터 기준) 밖. 특히 "정합 탈락한 병합/밀착 차도 이제 마스크가 뜬다"는 이번 반복의 실측 목적은 **리더 육안**이 라이브 cam1/preset1 에서 최종 확인해야 한다(코드 레벨은 ③~⑤로 봉인). 실 VPD 연동 스모크도 미수행(모킹 검증만).

## 산출물
- `test/frameCuboids.test.ts` — describe `🟣 masks surface — on-place seg 직접 필터` 전면 재작성(①②만 재확인, ③④⑤ 뒤집기, ⑥⑦ 신규) + `🟣 masks 옵셔널 회귀 0`(무변경) — `d:\Work\Parking3D\AgentVLA\ParkAgent\SettingAgent\test\frameCuboids.test.ts`
- `test/detectCuboid.test.ts` — 변경 없음(재검증만), `d:\Work\Parking3D\AgentVLA\ParkAgent\SettingAgent\test\detectCuboid.test.ts`

기존 스텁(`segOf`/`fakeVpd`/`toBox`/`carMaskPx`/`ctx`) 재사용, 로컬 재구현 0. 프로덕션 `buildFrameCuboids`/`runDetect` 를 import 호출.
