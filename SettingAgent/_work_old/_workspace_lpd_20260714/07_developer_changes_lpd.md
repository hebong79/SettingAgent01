# 07. 구현(2차 증분) — LPD 번호판도 주차면 위 차량 것만

**근거**: `_workspace/06_architect_plan_lpd.md` (설계서). 리더 확정 사항(Q1 라벨 변경 / Q2 P-1 보류) 반영.
**규칙**: `keepPlate(p) = (유지된 VPD 차량에 귀속) OR (번호판 중심 ∈ 주차면 폴리곤)`

---

## 1. 변경 파일 (소스 5 + 테스트 4)

| 파일 | 변경 |
|---|---|
| `src/capture/onPlaceFilter.ts` | **`filterPlatesOnPlace` 신규**(+38줄). 기존 `groundBand`/`isVehicleOnPlace`/`filterVehiclesOnPlace` 무변경. |
| `src/capture/detectPipeline.ts` | `DetectResult.plates` 주석 재기술(계약 변경), `summary.lpdFilteredOut: number` 추가, 반환 `plates` 를 필터본으로, 모드A 게이트(`onPlaceOnly`) 블록 추가. |
| `src/capture/CaptureJob.ts` | `lpdFilteredOut` 카운터(필드·`start()` 초기화·`getStatus()` 조건부 스프레드), `presetPlace()` 추출(차량·번호판 필터 공유), `applyPlateFilter()` 신규, `captureTarget()` LPD 블록에서 필터 적용. |
| `src/capture/types.ts` | `CaptureStatus.lpdFilteredOut?: number`. 강등 사유는 `vpdOnPlaceDegraded` 공유(필드 추가 없음). |
| `web/app.js` | `cap-msg` 에 `번호판 N/M`, status 배지에 `(차량 제외 N대 · 번호판 제외 M)`. |
| `web/index.html` | 체크박스 라벨 → `주차면 위 차량만 검출(번호판 포함)`. **id `cap-vpd-onplace` 유지**(리더 지시). |
| `test/onPlaceFilter.test.ts` | P1~P7 신규(7건). |
| `test/detectPipeline.test.ts` | `toEqual` 2건 갱신, §6-12 주석 수정 + 신규 3건. |
| `test/captureJobOnPlace.test.ts` | §6-11 **describe 재작성**(§6-11′) — C1/C2/C3 + 전제 검증. |
| `test/captureRoutes.test.ts` | `toEqual` 2건 갱신, 경계면 계약 2건 확장. |

**무변경(설계서 확인대로)**: `Aggregator.ts`, `Finalizer.ts`, `web/core.js`, `src/api/captureRoutes.ts`, `src/index.ts`, `src/setup/plateMatch.ts`.

---

## 2. 핵심 구현 노트

### 2.1 귀속(A) — 신규 매칭 0줄
`filterPlatesOnPlace` 내부에서 `matchPlatesToSlots(keptVehicles→BuiltSlot 어댑트, plates)` 를 호출하고
그 **반환 Map 의 값 집합(=`plate.quad` 참조)** 을 `Set` 으로 만들어 `attached.has(p.quad)` 로 판정한다.
→ **차량당 번호판 1개** 규칙이 그대로 상속되어, VPD 거대 병합 박스(리더 V-1, conf 0.39 / 프레임 절반)가
배경 번호판을 전부 빨아들이는 것을 **정확히 1건으로 봉쇄**한다. (테스트 P4 가 이 성질을 봉인 — 자체 귀속으로 바꾸면 5건이 통과하며 즉시 깨진다.)

### 2.2 주차면 보정(B) — 점유 회귀 0
`center(quadBoundingRect(p.quad))` → `pointInPolygon`. **`matchPlatesToSlots` 와 완전 동일한 중심 정의**(제3의 centroid 없음).
`computeOccupancy` 가 참조하는 폴리곤 = 필터가 쓰는 그 폴리곤이므로, **필터가 제거하는 번호판은 점유를 참으로 만들 수 없는 것뿐**이다.

### 2.3 게이트 = `onPlaceOnly`(실제 적용 모드), 강등 정책 공유
`detectPipeline` 은 요청값 `onPlace.onlyOnPlace` 가 아니라 **차량 필터가 확정한 `onPlaceOnly`** 로 분기한다.
→ 폴리곤 부재 시 차량과 **같은 이유로** 번호판도 통과. 강등 warn·사유는 차량 필터가 이미 내므로 **번호판용 별도 필드·로그 없음**(중복 금지).
`CaptureJob` 도 동일: `filterPlatesOnPlace` 가 degraded 면 `filteredOut===0` 이라 카운터가 오르지 않는다.

### 2.4 의도적으로 수용한 중복 (설계서 §3 — "최적화하지 말 것")
`runDetect` 는 `matchPlatesToSlots` 를 **2회** 호출한다(자기 매칭 1회 + 필터 내부 1회, 동일 입력·동일 결과).
순수 함수 O(n·m), n·m ≤ ~20. `matched` 를 인자로 넘기는 대안은 `CaptureJob` 에 BuiltSlot 어댑터를 복제해야 해서 더 나쁘다. **그대로 뒀다.**

### 2.5 `vehicles[].plate` 무변경
귀속분은 `matched`(이미 필터된 vehicles 로 산출) 이므로 정의상 kept 차량 것뿐이고, 복원분(`recovered`)은 zoom 뷰에서 새로 얻은 quad라 `platesBase` 에 원래 없다. 회귀 0 — 손대지 않았다.
`:258` 의 conf 조회는 **`platesBase`(원본) 유지**(matched 의 출처와 일치. `plates` 로 바꾸면 조용히 `?? 1` 폴백된다).

---

## 3. 계획과 달라진 점

| 항목 | 계획 | 실제 | 사유 |
|---|---|---|---|
| 배지 falsy 가드 | `status.vpdFilteredOut ? ... : ''` 유지 | `status.vpdFilteredOut \|\| status.lpdFilteredOut ? ... : ''` | 차량 제외 0 · 번호판 제외 >0 인 경우(예: VPD 미검출 주차차 + 통행차 번호판)에 괄호가 통째로 사라져 `lpdFilteredOut` 이 **관측 불가**해진다. 가드를 두 카운터의 OR 로 확장했다(0/0 이면 괄호 생략 — 기존 동작 보존, 기존 테스트 `after.vpdFilteredOut === undefined` 통과). |

그 외 전부 설계서대로. **설계 결함 발견 없음** → 설계자 재문의 불요.

---

## 4. 게이트 결과 (있는 그대로)

```
$ npx tsc -p tsconfig.json --noEmit
TSC_EXIT=0                                  # 출력 없음

$ npx vitest run
 Test Files  133 passed (133)
      Tests  1469 passed (1469)
   Duration  7.07s
```

증분 4파일 재실행: `onPlaceFilter 28` / `detectPipeline 30` / `captureJobOnPlace 10` / `captureRoutes 49` = **117 passed**.

### 신규·수정 테스트
- **P1** (A항): 번호판 중심이 kept 차량 rect 안 · **폴리곤 밖** → keep. (전제로 `pointInPolygon=false` 를 먼저 단언 → (A) 없이는 죽는 케이스임을 증명)
- **★P2** (B항): `keptVehicles=[]`(VPD 가 주차차 놓침) + 폴리곤 안 번호판 → **keep**. (없으면 `computeOccupancy` 가 그 면을 `occupied:false` 로 뒤집는다)
- **P3**: 통로 번호판 → drop, `filteredOut=1`.
- **★P4**: 거대 병합 박스 + 배경 번호판 5개(전부 rect 안, 폴리곤 밖) → **정확히 1개만 keep**, 4개 drop.
- **P5/P6**: 강등(null/[]/undefined) 전량 통과·복사본 / 귀속 공집합 방어.
- **★P7**: 비대칭 quad 로 **4점 평균(0.26) vs bbox 중심(0.32)** 이 폴리곤 안팎으로 갈리는 좌표를 만들어, 서버가 **bbox 중심 정의**를 쓴다는 것을 봉인.
- **detectPipeline**: 통행차 번호판 모드A drop(`lpdCount=2, lpdFilteredOut=1, plates=1`) / 모드B 유지(2건) · 불변식 `plates.length === lpdCount − lpdFilteredOut`(4케이스) · recovered 번호판은 `plates` 와 무관하게 `vehicles[].plate` 로 유지 · 강등 시 번호판 미필터.
- **§6-12 주석 수정**: `PARKED_PLATE`(폴리곤 밖·kept 차량 안)가 유지되는 것은 **우연이 아니라 (A) 귀속 항의 실증**임을 명기.
- **captureJobOnPlace §6-11′**(재작성): C1 모드A plate 1건/`lpdFilteredOut=1` · 모드B 2건/미노출 → **C2** VPD `[]` + 폴리곤 안 번호판 → **plate 적재됨**(점유 뒤집힘 방지 DB 끝단 봉인) → C3 강등 2건 전량. 픽스처는 `test/fixtures/PtzCamRoi.unity.json` 만 사용(HANDOFF §2-2 준수), 통행차 번호판이 **어떤 폴리곤에도 없음**을 전제 테스트로 검증.
- **captureRoutes**: summary `toEqual` 2건 + 경계면에 `typeof lpdFilteredOut === 'number'` · `plates.length === lpdCount − lpdFilteredOut` · status `lpdFilteredOut` 미노출 단언 추가.

---

## 5. 발견한 문제 · 한계 (은닉 금지)

1. **라이브 미검증**: 유닛테스트·타입체크만 통과했다. 설계서 §7-7 이 "성공 판정의 본체"로 지목한 **preset3 라이브 재현**(뒷줄 노란 번호판 소멸 + 점유 면 수 불변)은 **구현자가 수행하지 않았다** — 서버·시뮬레이터 기동이 필요하다. 리더/QA 소관.
2. **중심 정의 ε 불일치 잔존**: 서버 = `quadBoundingRect→center`, `web/core.js:quadCentroid` = 4점 산술평균. 직사각/평행사변형 OBB 에선 동일하나 **원근으로 심하게 비대칭인 quad** + 중심이 폴리곤 경계 ε 이내일 때 점유가 갈릴 수 있다. **테스트 P7 이 이 ε 이 실재함을 좌표로 보여준다**(같은 quad 가 두 정의에서 반대 판정). → 후속 과제 **P-1**.
3. **차량당 1개 규칙의 이면**: 한 kept 차량 rect 안 번호판이 2개면 겹침 작은 쪽이 (A)에서 탈락한다. `Aggregator` 도 동일한 max-overlap 규칙이라 집계·`parking_slots` 결과는 동일하고, **뷰어 오버레이 표시만 1개 줄어든다**.
4. **(A)·(B) 동시 실패 조합**: VPD 미검출 + 번호판 중심이 폴리곤 밖(차량 앞으로 튀어나온 번호판) → drop(점유 뒤집힘). 확률 낮고 **경고 없음**(관측 불가).
5. **거대 병합 박스(V-1) 잔존**: 봉쇄는 "차량당 1개"까지 — 배경 번호판 1개는 여전히 통과한다. 근본 처방은 VPD conf 하한(리더 후속 과제 V-1).
6. **사후 모드 전환 불가**: 검출 시점 필터라 원 번호판이 DB 에 남지 않는다(1차 §7-3 상속).

---

## 6. 후속 과제

| ID | 내용 | 상태 |
|---|---|---|
| **P-1** | `web/core.js:quadCentroid`(4점 평균) ↔ 서버 `quadBoundingRect+center` **중심 정의 이중구현 통일**. 이번엔 `web/core.js` 무변경 제약(리더 Q2 결정)으로 보류. 테스트 P7 이 두 정의가 갈리는 좌표를 이미 확보해 뒀다. | 등록 |
| V-1 | VPD 저신뢰 거대 병합 박스 — 캡처 경로 confidence 하한. | 리더 기등록 |
