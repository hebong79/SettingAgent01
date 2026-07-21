# 02 · 구현 변경 노트 — 슬롯 앞면중심 기준 번호판 탐색·확대반복·역계산 (Phase 1+2)

> 대상: 검증자(qa)·문서화(documenter)
> 범위: **디지털 크롭-줌 tier(Phase 1 코어 + Phase 2 잡·라우트·DB)만**. 광학 PTZ tier(Phase 3)는 미구현(설계서 후속).
> 근거 설계서: `docs/20260719_153707_번호판탐색_줌반복_역계산_설계서.md` · `_workspace/01_architect_plan.md`

## 결과 요약
- `npx tsc --noEmit` **통과**(0 에러).
- `npx vitest run` **165 파일 / 1840 테스트 전량 green — 회귀 0**(기존 수집·최종화·센터라이징·원버튼 파이프라인 무영향).
- developer 스모크(node/tsx): 아핀 왕복·크롭창·조준점·루프 상태전이(T-1~T-4) + DB wipe-safety **전량 PASS**(수치 아래).

---

## 신규 파일

### 1. `src/calibrate/cropZoom.ts` (순수 기하 + sharp IO)
- `computeCropWindow(center, frac, aspect)`: 앞면중심 기준 크롭 창. **폭 w0 = frac**, **높이 h0 = frac·aspect**(aspect = 원본 imgW/imgH) → 크롭이 **픽셀 정사각** → 정사각 출력 업스케일에서 번호판 왜곡 0. 창은 크기 보존한 채 위치만 [0,1] 안으로 시프트(모서리 center 에서도 밖으로 안 나감).
  - ★ 설계서는 `computeCropWindow(center, frac, aspect)` 시그니처만 명시하고 높이 산출식은 미지정 → **h0 = frac·aspect(정사각 픽셀)로 확정**. frac 을 "창 폭 비율"(설계 §3-3 문구)로 해석. 역계산은 x·y 독립 아핀이라 이 선택과 무관하게 정확.
- `toCropPoint(p, W)`: 원본 정규화 점 → 크롭 정규화(아핀 순방향, anchor 환산·설계 §4).
- `backmapQuad(cropQuad, W)`: **아핀 역계산** `orig = W.xy + q·W.wh`(각 코너 독립, 설계 §2-1). 업스케일 배율 식에 없음.
- `cropAndUpscale(jpeg, W, outLongPx)`: sharp `extract`(픽셀 반올림·경계 클램프) + `resize`(장변 outLongPx·종횡비 보존) + jpeg. 원본 재사용·카메라 무이동.

### 2. `src/calibrate/plateDiscovery.ts` (`PlateDiscovery` 탐색 루프 — DI)
- `discoverSlot(t, presetPtz)` 상태전이(설계 §3-1): anchor 없음 → `no_anchor` / 원본 1회 캡처 → **Tier0 full**(원본 전체 LPD → pickNearestPlate → matchRadius(0.15) 이내면 역계산 불요) → 실패 시 **Tier1 crop** 축소반복(`frac_k = frac0·shrink^(k-1)`, k=1..maxSteps, frac<minFrac 종료) → 크롭 검출 시 `backmapQuad` 역계산 → 원본 OBB / 전부 미검출 → `no_plate`.
- camera/lpd/**crop** 주입(DI) — sharp 없이 순수 상태전이 테스트 가능. 기본 crop = `cropAndUpscale`.
- 상수 기본값(설계 §3-3): frac0=0.40, shrink=0.6, minFrac=0.05, maxSteps=5, matchRadiusNorm=0.15, outLongPx=원본 장변, settleMs=0(무이동).
- 재사용: `pickNearestPlate`(controlMath), `quadBoundingRect`(geometry), `readJpegSize`(util/jpeg).

### 3. `src/calibrate/plateDiscoveryWriter.ts` (slotPtzWriter 미러)
- `expandDiscoveryTargets(views)`: slot_setup 중 **slot3d_front_center 보유 슬롯만**(검출 무관 — 센터라이징 펼침이 `lpd==null` 누락하는 것과 대조, 과업 A2 해소). globalIdx=정수 slot_id, presetSlotIdx=DB 값 그대로.
- `writePlateDiscovery(artifact, outFile)`: `stringify5`+mkdir(writeSlotPtz 동일 패턴).

### 4. `src/calibrate/PlateDiscoveryJob.ts` (PtzCalibrator 상태머신 미러)
- 단일 인메모리 상태머신, 중복시작 거부(throw→409), 슬롯 순차 await, 개별슬롯 실패 흡수(정직 리포트).
- 프리셋 PTZ 키별 1회 캐시(`ptzByKey`), `getLastFrame`(onFrame), `getStatus`(state/done/total/**found**/current).
- 완료 시 `writePlateDiscovery`(JSON 정본) + `saveSlotLpd` → **`store.upsertSlotLpd` slot_id 부분 UPDATE**.
- `saveSlotLpd`: found && lpdOrig!=null && globalIdx!=null 만. lpdObb = `stringify5(item.lpdOrig)`(TEXT writer 규약). globalIdx 부재 warn+스킵. best-effort(try/catch — 실패해도 JSON·잡 완료 무방).

### 5. `src/api/discoverRoutes.ts` (calibrateRoutes 미러)
- `POST /discover/ptz`(slotIds? 필터, 409 중복), `GET /discover/status`, `GET /discover/frame`(최근 원본 JPEG), `GET /discover/result`(plate_discovery.json).

---

## 수정 파일(가산·외과적)

### `src/calibrate/types.ts`
- import 에 `NormalizedPoint, NormalizedQuad` 추가.
- 신규 타입: `DiscoveryTarget`, `PlateDiscoveryItem`(설계 §5-1 정확 반영), `PlateDiscoveryArtifact`, `DiscoverState`, `DiscoverStatus`. 기존 타입 불변.

### `src/capture/types.ts`
- 신규 `SlotLpdRow`(slotId/lpdObb/updatedAt) — upsertSlotLpd 입력. 기존 타입 불변.

### `src/capture/SqliteStore.ts`
- import 에 `SlotLpdRow` 추가.
- 신규 `upsertSlotLpd(rows)`: `UPDATE slot_setup SET lpd_obb=?, updated_at=? WHERE slot_id=?`(트랜잭션). **★ DELETE+INSERT 없음** — 메모리 노트 "finalize slot_setup wipe fragility" 준수. 타깃 외 슬롯·타 컬럼(slot_roi/vpd/pan/tilt/zoom/centered/img1/front_center) 완전 불변. 미존재 slot_id 조용히 무시.
- `upsertSlotCentering`/`replaceSlotSetup` 등 기존 메서드 **완전 불변**.

### `src/api/server.ts`
- import `registerDiscoverRoutes`, type `PlateDiscoveryJob`.
- ApiDeps 에 `plateDiscovery?`, `discoverOutFile?`(옵셔널·가산 — 미주입 시 미등록). 기존 `discovery`(프리셋 자동탐색 설정)와 이름 충돌 회피 위해 **`plateDiscovery`** 명명.
- calibrate 등록 블록 뒤에 `/discover/*` 조건부 등록. 기존 라우트 불변.

### `src/index.ts`
- import `PlateDiscoveryJob`.
- `pipeline` 조립 뒤: `discoverOutFile='data/plate_discovery.json'`, `plateDiscovery = new PlateDiscoveryJob({camera, lpd, store: sqlite, outFile})`. buildServer 에 `plateDiscovery, discoverOutFile` 전달.
- **파이프라인 자동연쇄엔 미포함**(설계대로 수동 실행 상류 잡). captureJob/finalizer/calibrator/pipeline 배선 불변.

---

## DB 쓰기 방식(wipe 방지 근거)
`slot_setup.lpd` 는 **slot_id 키 부분 UPDATE** 만 사용. `replaceSlotSetup`(DELETE 후 전량 INSERT)은 검출 없는 finalize 가 데이터를 파괴할 수 있어(메모리 노트) **절대 미사용**. discovery 는 검출된 슬롯의 `lpd_obb`(+updated_at)만 원본 좌표로 갱신 → 타 슬롯·타 컬럼 불변. DB 스키마 변경 0(기존 slot_setup.lpd_obb 컬럼 재사용).

## 배선 요약
`index.ts → PlateDiscoveryJob(camera, lpd, sqlite, outFile) → server.ts(plateDiscovery, discoverOutFile) → registerDiscoverRoutes(/discover/*)`. config 스키마 확장 없음(설계 §8 "코드 기본값 우선"). outFile 은 calibrate.outFile(`data/slot_ptz.json`)과 동일 규약의 cwd-상대 리터럴 `data/plate_discovery.json`.

---

## 자체 스모크 결과(수치)
- **T-1 아핀 왕복**: 5개 frac(0.4→0.05) 창 왕복 maxErr = **1.11e-16** (< 1e-9). 좌상단 모서리 클램프 창 왕복 err=0.
- **T-2 크롭창**: 중심(0.5,0.5) 유지, w=0.4, h=0.711(=0.4·16/9). 모서리(0.98,0.02) center → 창 {x:0.6,y:0,w:0.4,h:0.711} 전부 [0,1] 내부.
- **T-3 조준점**: 중앙 anchor → 크롭 중앙(0.5,0.5).
- **T-4 루프**: full 즉시검출(tier full/step0) / 반경밖→crop step2 검출 + 역매핑 원본좌표 midX=0.5 정합 / no_anchor / no_plate 경로 전부 정확.
- **DB wipe-safety**: slot3 lpd 갱신 + roi/vpd/pan/tilt/zoom/centered/img1/front_center **전부 불변**, updated_at 만 갱신, slot5(타슬롯) 전부 불변, 미존재 slot_id throw 없이 무시.

## qa 전달 테스트 포인트
1. `test/cropZoom.test.ts`: **T-1 아핀 왕복**(다양한 W — 중심·모서리·클램프 경계, 오차<1e-9) + **T-2 창 [0,1]클램프·중심유지·h=frac·aspect**.
2. `test/plateDiscovery.test.ts`: **T-4 mocked LPD** — Tier0 full(matchRadius 게이트: 반경밖 후보 기각→crop 진입), Tier1 크롭 step k 최초검출·`backmapQuad` 원본좌표 역매핑, `no_anchor`/`no_plate` 경로. crop 은 stub 주입(sharp 불요). **T-3 이웃 배제**: 크롭 창 안 2개 후보 중 anchor(크롭 환산) 최근접 1개 채택.
3. `PlateDiscoveryJob`: makeDiscovery/writer 시임 주입 → 잡 상태(running 중복시작 409·done·found 카운트), JSON 정본 저장, **upsertSlotLpd 부분 UPDATE**(globalIdx 부재 스킵, best-effort). getSlotSetup 으로 타 컬럼·타 슬롯 불변 검증(wipe 회귀 봉인).
4. 회귀: 기존 slotPtzWriter/PtzCalibrator/SqliteStore(upsertSlotCentering·replaceSlotSetup) 테스트 불변 확인.

## 발견 이슈 / 설계 결함
- **없음(설계 결함 미발견)**. 유일한 해석 확정 지점은 `computeCropWindow` 높이식(설계 미지정) → **h0 = frac·aspect(정사각 픽셀)** 로 결정, 위에 근거 기록. 역계산 정확성은 이 선택과 독립(x·y 독립 아핀). 필요 시 QA 가 frame-aspect 크롭(h0=frac)으로 대안 튜닝 가능하나 왜곡·역계산엔 무영향.
- 광학 tier(Phase 3)는 설계대로 **미구현** — 디지털 실패 슬롯은 현재 `reason:'no_plate'` 로 리포트(설계 §3-1 의 `needs_optical` 표식은 광학 tier 도입 시 부여). `PlateDiscoveryItem.reason` 에 `'needs_optical'` 는 타입에 존재(후속 대비).
