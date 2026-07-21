# 구현 변경 요약 — LPD discovery 앵커 하향(A) + 2D 격자 크롭 탐색(B)

- 구현: developer / 2026-07-19
- 근거: `_workspace/01_architect_plan.md` §4 최소안
- 범위: discovery 코어 3파일 + types 주석 1줄. 라우트·DB·config 무변경, VPD 미접촉(LPD only).
- tsc: `npx tsc --noEmit` **exit 0** (SettingAgent 디렉터리).

## 변경 파일

### 1) `src/calibrate/cropZoom.ts` — 순수함수 1개 추가만
- `backmapQuad` 뒤에 `export function gridCenter(anchor, frac, aspect, off)` 추가.
  - 반환 `{ x: anchor.x + off.dx·min(1,frac), y: anchor.y + off.dy·min(1,frac·aspect) }`.
  - 창 크기 정의(`min(1,frac)`·`min(1,frac·aspect)`)를 computeCropWindow 와 동일 사용 → 오프셋 단위가 창 크기 배수.
- 기존 4함수(computeCropWindow/toCropPoint/backmapQuad/cropAndUpscale) **무변경**. import·기존 주석 무변경.

### 2) `src/calibrate/plateDiscovery.ts` — Tier1 루프 격자 순회로 교체
- import 에 `gridCenter` 추가(cropZoom.js).
- 모듈 상수 `GRID_OFFSETS`(5방: 중심→하→하좌→하우→더아래, dy 0/0.5/0.5/0.5/1.0, dx 0/0/-0.5/0.5/0) 추가.
- `maxSteps` 기본값 **5 → 20** (PlateDiscoveryOpts 주석 + ResolvedOpts 기본 둘 다, 주석 "= 격자 20칸(줌4×오프셋5)").
- Tier1 루프 교체:
  - `level = floor((k-1)/5)+1`, `frac = frac0·shrink^(level-1)`, `if frac < minFrac break`.
  - `off = GRID_OFFSETS[(k-1)%5]` → `c = gridCenter(...)` → `W = computeCropWindow(c, frac, aspect)`.
  - 중복창 스킵: `${W.x},${W.y},${W.w},${W.h}` 키 `Set` 관리, 이미 본 창이면 LPD 스킵·continue(k 계속 증가).
  - prior = `toCropPoint(anchor, W)` 기존식 유지(하향앵커 기준). 검출 시 `backmapQuad(pick.quad, W)` 즉시 반환 — 역계산 식 불변.
- Tier0 full·no_anchor·소진 시 `no_plate`(step=maxSteps) 반환 규약 **무변경**. discoverSlot 시그니처 불변.

### 3) `src/calibrate/plateDiscoveryWriter.ts` — 앵커 하향
- import `NormalizedPoint`(domain/types.js) 추가.
- 모듈 상수 `PLATE_H = 0.4`, `H_CONST = 1.5`(Finalizer.ts:41 동기 필요 주석 봉인), `BOTTOM_EDGES` 추가.
- 신규 export 순수함수 `lowerFrontAnchor(roi, frontCenter, plateH = PLATE_H)`:
  - roi 길이≠4 또는 비유한 좌표 → `frontCenter` 폴백(throw 금지).
  - 앞 edge = 4 edge 중 두 끝점 y평균 최대(project.ts frontFaceCornerIdx 동일 판정). 중점 B(h=0).
  - `t = plateH/(H_CONST/2)` = 0.4/0.75 ≈ 0.5333. 반환 `B + (frontCenter−B)·t`.
- `expandDiscoveryTargets` 앵커 산출 1줄 교체: `anchor: lowerFrontAnchor(v.roi, v.slot3dFrontCenter)`. `slot3dFrontCenter == null` 가드 기존 유지(null continue → 인자는 non-null 전제).

### 4) `src/calibrate/types.ts` — 주석 1줄
- `PlateDiscoveryItem.step` 주석 `crop=1..maxSteps` → `crop=1..maxSteps(격자 인덱스)`. 코드 무변경.

## 설계서 대비 이탈/판단 사항
- 없음. §4 최소안 시그니처·상수·로직 그대로 구현.
- `best` 튜플 타입은 project.ts frontFaceCornerIdx 와 동일하게 `readonly [number, number]` 어노테이션으로 재할당(tsc 통과).

## 개정 (20→30 격자, 2026-07-19 — 마스터 신규 요건 / Fable §3 개정판)

`src/calibrate/plateDiscovery.ts` 만 갱신(cropZoom.ts·plateDiscoveryWriter.ts 무변경 — gridCenter·lowerFrontAnchor 그대로 재사용):
1. `GRID_OFFSETS` 5방 → **6방** 교체: 중심→하→하좌→하우→좌→우. `(0,1.0)` 과이동 제거(하향앵커 적용 반영), 순수 좌/우 `(-0.5,0)`·`(0.5,0)` 추가. 주석 "줌 5레벨 × 6방 = 30칸".
2. 루프 `level = floor((k-1)/6)+1`, `off = GRID_OFFSETS[(k-1)%6]` (기존 /5·%5 → /6·%6). 주석 동기.
3. `maxSteps` 기본값 20 → **30** (PlateDiscoveryOpts 주석 + ResolvedOpts 기본, 주석 "= 격자 30칸(5줌×6방)").
4. `minFrac 0.05` 무변경 — level5 frac=0.40·0.6^4≈0.05184 ≥ 0.05 로 5줌 전부 유효, `if frac<minFrac break` 가드 유지(기본값 미발동).
5. 중복창 스킵·gridCenter·computeCropWindow·backmapQuad·Tier0·no_anchor·시그니처 전부 불변.

tsc: `npx tsc --noEmit` **exit 0** 재확인.

## 개정 (§9 배타성 게이트 — 옆판 절도/위장 found 차단, 2026-07-19 라이브 대응)

2파일 변경(cropZoom.ts·plateDiscoveryWriter.ts·routes·types·DB 불변):

### `src/calibrate/plateDiscovery.ts`
- **신규 export `pickOwnedPlate(candidates, selfAnchor, peerAnchors)`** (§9-3): 각 후보 `centerOrig`(원본 프레임 정규화)에 대해 `d(centerOrig, self) < d(centerOrig, peer)` 를 **모든 peer**에 엄격(`<`, 동률 기각) 만족하는 후보만 남기고, 그 중 self 최근접 1개 반환(없으면 null). `peerAnchors=[]` → 전원 통과(기존 최근접 동작).
- **`discoverSlot` 시그니처 옵셔널 확장**: `discoverSlot(t, presetPtz?, peerAnchors: NormalizedPoint[] = [])`. 하위호환.
- **Tier0(full) 게이트**: `pickNearestPlate` → 후보 `{plate, centerOrig: centerOf(p)}` 배열 + `pickOwnedPlate(cands, anchor, peerAnchors)`. 통과 후보에 **기존 matchRadiusNorm 게이트 병행 유지**(둘 다 통과 시만 full 채택, step=0). 불통과 → 격자 진입.
- **crop tier 게이트**: `pickNearestPlate(priorRect(toCropPoint(...)))` → 크롭 정규화 중심 `cc=centerOf(p)` 를 `centerOrig={x:W.x+cc.x*W.w, y:W.y+cc.y*W.h}`(backmapQuad 점 버전) 로 **원본 환산** 후 `pickOwnedPlate(cands, anchor, peerAnchors)`. 채택 시 `backmapQuad(pick.quad,W)`·step/cropWindow 기존 그대로.
- **비교 좌표계 = 항상 원본 프레임 정규화**(크롭 좌표 직접 비교 금지).
- **고아 제거**(내 변경으로 미사용): `pickNearestPlate` import(controlMath.js), `toCropPoint` import(cropZoom.js), 로컬 `priorRect` const 삭제. `NormalizedRect` 타입 import 는 CropFn 에서 계속 사용 → 유지. `pickNearestPlate` 함수 자체(controlMath.ts)는 무수정(platePtz·detectPipeline 공유).

### `src/calibrate/PlateDiscoveryJob.ts`
- `run(targets)` 진입 시 1회 `Map<`${camIdx}:${presetIdx}`, DiscoveryTarget[]>` 그룹핑.
- 각 슬롯: `peerAnchors = 같은 presetKey targets 중 자기(slotId) 제외 · anchor != null` (flatMap 으로 null 배제·NormalizedPoint[] 산출, 캐스팅/assertion 없음) → `discoverSlot(t, presetPtz, peerAnchors)`.
- `PlateDiscoveryApi = Pick<PlateDiscovery,'discoverSlot'>` 시임 무수정(옵셔널 인자 자동 추종).

tsc: `npx tsc --noEmit` **exit 0** 재확인.

## 검증
- `npx tsc --noEmit` exit 0.
- vitest 담당(qa): 격자 개정 반영 — V-3(k=6 축소→k=7), V-4(20→30·step=30). §9 신규 — V-10(pickOwnedPlate 순수: 이웃기각/자기채택/다수최근접/동률기각/peers=[]통과), V-11(절도 재현 회귀: Tier0 이웃판만→기각·격자진입→크롭서 자기판), V-12(크롭 자기+이웃 공존→자기 채택, 원본환산 확인), V-13(Job 프리셋별 peer 그룹핑), V-14(3번째 인자 옵셔널 하위호환).
- **주의(found 하락은 회귀 아님)**: 배타성 게이트로 미검지 슬롯의 위장 found 가 사라져 found 수치가 정직하게 하락 가능(§9-0 위장 교정).
