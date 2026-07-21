# 03 · 검증 리포트 — 슬롯 앞면중심 번호판 탐색·크롭줌·역계산 (Phase 1+2)

> 작성: 검증자(qa-tester) · 대상: 리더(main)·문서화(documenter)
> 근거: 설계서 `docs/20260719_153707_번호판탐색_줌반복_역계산_설계서.md` §2~§7 · 구현노트 `_workspace/02_developer_changes.md`
> 범위: 디지털 크롭-줌 tier(Phase 1 코어 + Phase 2 잡·라우트·DB). 광학 PTZ tier(Phase 3)는 미구현(설계 후속).

## 요약(성공 기준 충족)
- **신규/가산 테스트 42건 전량 green.** `npx tsc --noEmit` **exit 0**(클린).
- **전체 회귀 0**: `npx vitest run` → **168 파일 / 1882 테스트 전량 통과**.
  - 기준선(작업 전): 165 파일 / **1840** 통과 → 신규 3파일(+37) + sqliteStore 가산(+5) = **+42** → **1882**. 기존 1840 불변.
- 소스 결함 **미발견**. 리더 sharp 기하 검증(아핀 왕복 1.11e-16)을 순수 vitest 로 독립 재현(오차 <1e-9, 실측 <1e-12).

---

## 작성 테스트 · 의도

### 1. `test/cropZoom.test.ts` (23건) — 순수 기하, 외부의존 0
- **역계산 왕복 파리티(핵심, T-1)**: 원본 quad → `toCropPoint(W)` 각 코너 → `backmapQuad(W)` == 원본. 창 W 5종(리터럴 중심/소형, computeCropWindow 중심·모서리클램프·초소형) × quad 3종(축정렬·**기운 OBB**·프레임 넓게퍼짐) = 15조합 전부 오차 <1e-9.
- **업스케일 배율 무관**: `backmapQuad` 식에 scale 항 부재 → 동일 quad 를 실효줌 다른(frac 0.9→0.05) 창 4종으로 왕복해도 전부 <1e-12. (LPD 가 크롭 픽셀크기로 정규화 → q 는 배율 흡수, 설계 §2-1 봉인.)
- **computeCropWindow(T-2)**: w=frac·h=frac·aspect(픽셀 정사각)·중심 정렬 / 모서리 center 클램프(창 **크기 보존** + [0,1] 내부 유지, 밖으로 안 나감) / frac·aspect>1 → h=1·y=0 클램프 / frac>1 → w=1·x=0 클램프.
- **toCropPoint 창밖 점**: 좌상 밖 → 음수, 우하 밖 → 1 초과(클램프 안 함, 그대로). 내부 중심 → 0.5.

### 2. `test/plateDiscovery.test.ts` (7건) — discoverSlot 상태전이, camera/lpd/crop DI 스텁
- **Tier0 full 즉시검출**: 반경 내(≈0.01<0.15) → found(tier full/step0), quad 그대로(역계산 불요), **crop 미호출**.
- **matchRadius 게이트**: full 후보 반경밖(≈0.495>0.15) → 기각 후 **crop 진입**(step1 검출) + `backmapQuad` 원본좌표 역매핑(실 함수 교차검증).
- **Tier1 크롭 step 전이**: step1 미검출 → **step2 최초검출**, cropWindow=W2(frac=0.24), confidence 전파, lpdOrig=backmap(pick,W2).
- **이웃 배제(T-3)**: 크롭 창 안 2후보 중 conf 높은 far 가 아니라 **anchor(크롭 환산) 최근접 near** 채택.
- **outLongPx**: 원본 장변 1920 으로 crop 호출.
- **no_plate**: full·crop 전부 미검출 → found:false·reason:no_plate·tier:crop·step:5(maxSteps)·lpdOrig:null, **crop 정확히 5회**(0.4·0.6⁴=0.05184 ≥ minFrac 0.05).
- **no_anchor**: anchor 부재 → 즉시 반환, **카메라 캡처조차 안 함**(requestImage 0회).

### 3. `test/sqliteStore.test.ts` (가산 5건) — upsertSlotLpd 부분 UPDATE (wipe-safety 봉인)
검출·센터링·기하 컬럼이 전부 채워진 슬롯 fixture 로 변경 격리 검증.
- 대상 슬롯 **lpd_obb·updated_at 만 갱신** — vpd/occupy/pan/tilt/zoom/centered/img1/slot_roi/**front_center 전부 불변**.
- 부분 갱신: 대상만 채우고 **타 슬롯 전멸/변경 금지**(행수 2 보존 = DELETE+INSERT 아님).
- lpdObb=null → 해당 슬롯 lpd 클리어(updated_at 동반).
- 미존재 slot_id → throw 없이 조용히 무시, 타 슬롯 불변.
- 다행 트랜잭션 일괄 갱신.

### 4. `test/discoverRoutes.test.ts` (7건) — /discover/* REST(fastify.inject), calibrateRoutes 미러
- POST /discover/ptz → 200 `{ok, started, total}` / running 중 재시작 → **409**.
- GET /discover/status → 진행 shape(state/done/total/**found**), 완료 후 found=1.
- GET /discover/result → 없음 404 / 완료 후 200 `{createdAt, items}`(slotId='1', found:true).
- GET /discover/frame → 캡처 프레임 없음 404.
- **미주입 대칭**: plateDiscovery 미주입 → /discover/status 404, /health 정상(가산 보장).

---

## 실행 결과(그대로)

```
# 신규/가산 4파일
Test Files  4 passed (4)
     Tests  56 passed (56)     # cropZoom 23 · sqliteStore 19(기존14+가산5) · plateDiscovery 7 · discoverRoutes 7

# tsc
$ npx tsc --noEmit → TSC_EXIT=0

# 전체 회귀
Test Files  168 passed (168)
     Tests  1882 passed (1882)
   Duration 15.26s
```

---

## 경계면 교차 비교(shape 정합 확인)
스텁이 실제 소비 계약과 일치함을 소스 대조로 확인 — 불일치 없음.
- **LpdClient.detect → PlateBox** `{ quad: NormalizedQuad, confidence, cls }`: discoverSlot 이 `pickNearestPlate`(quadBoundingRect 중심)·`centerOf`·`backmapQuad`로 소비. 스텁 반환 shape 일치.
- **CameraClient.requestImage → CapturedImage** `{ camIdx, presetIdx, pan, tilt, zoom, imgName, jpg:Buffer }`: `cap.jpg`만 사용(readJpegSize→aspect/outLongPx). 스텁 일치.
- **CropFn** `(jpeg:Buffer, W:NormalizedRect, outLongPx:number)=>Promise<Buffer>` = `cropAndUpscale` 시그니처: 스텁 일치. crop 출력은 lpd 스텁만 소비(sharp 불요).
- **아핀 왕복**: 테스트 기대값을 실제 `computeCropWindow`/`toCropPoint`/`backmapQuad`로 산출 → discoverSlot 내부 역계산과 동일 함수라 좌표계(원본↔크롭 정규화) 정합이 구조적으로 봉인됨.
- **SlotLpdRow** `{ slotId:number, lpdObb:string|null, updatedAt:string }` → `UPDATE slot_setup SET lpd_obb=?, updated_at=? WHERE slot_id=?`: getSlotSetup 뷰의 lpd(NormalizedQuad 복원)로 왕복 확인.
- **DiscoverStatus** `{ state, done, total, found, current?, startedAt?, endedAt? }`: 라우트가 getStatus() 그대로 반환 — 응답 키 검증.

## 상수(눈대중 튜닝 대상 — 현재값으로 테스트 통과 확인)
설계 §3-3/§9-4 가 "실측 없는 초기값"으로 명시한 상수들. 현재 코드 기본값에서 루프가 의도대로 도는지 확인:
- frac0=0.40, shrink=0.6, minFrac=0.05, maxSteps=5 → 스텝별 frac: 0.40 / 0.24 / 0.144 / 0.0864 / **0.05184**. 5스텝 전부 실행됨(0.05184 ≥ 0.05).
  - ⚠ **경계 근접 관찰(결함 아님)**: step5 frac(0.05184)이 minFrac(0.05) 바로 위. shrink 를 낮추거나 minFrac 을 올리면 step5 가 조기 종료(maxSteps 도달 전 break)됨 — 튜닝 시 `maxSteps`와 `minFrac`이 서로 의존함을 유의. 현재값은 설계 의도(0.40·0.6⁴≈0.05)와 정합.
- matchRadiusNorm=0.15(full tier 게이트): 반경 내/밖 양쪽 경로를 테스트가 커버. 실측 기반 미세조정은 라이브 대상.

## 명시적 한계(은닉 금지)
1. **sharp 실 크롭 이미지 품질·업스케일 보간**: 순수테스트 밖. 리더가 sharp 기하 파리티(왕복 1.11e-16, 크롭 내 확대·복원 육안)로 별도 검증. crop 은 본 테스트에서 스텁.
2. **실 LPD 검출 성패**: da_lpd_api 미가동 → 검출 알고리즘 자체의 검지율은 검증 불가. 본 테스트는 검출 결과가 주어졌을 때의 **상태전이·역계산·후보선택·DB 반영**만 봉인. 라이브 스모크(설계 §7-c)는 **누락**(외부 서비스 미가동) — 위장 통과 아님, 한계로 명시.
3. **광학 PTZ tier(Phase 3)**: 설계대로 미구현. 디지털 실패 슬롯은 현재 `reason:'no_plate'`. `needs_optical` 은 타입에만 존재.
4. **후면주차·번호판 세로오프셋·차종별 높이**(설계 §6): 앞면중심 조준 전제의 구조적 한계 — 범위 밖(리포트만).

## 발견 이슈
- **소스 결함: 없음.** developer 의 유일 해석 확정점(`computeCropWindow` 높이식 h0=frac·aspect, 설계 미지정)은 역계산 정확성과 독립(x·y 독립 아핀)임을 왕복 파리티로 재확인.
- 상수 경계 근접(위 상수 절 ⚠)은 튜닝 유의사항이며 현재값 정상 동작. 리더 SendMessage 불요.
