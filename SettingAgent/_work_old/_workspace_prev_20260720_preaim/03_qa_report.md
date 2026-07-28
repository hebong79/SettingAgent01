# 03 QA — 정밀수집 센터라이징 pre-aim·중복제거·최종저장 검증 리포트

> 입력: `01_architect_plan.md`(§B 검증기준) + `02_developer_changes.md`(구현요약) + 변경 소스 재검증.
> 판정: **전체 그린 · 회귀 0**. 단, 착수 시 기준선에 **3건 실패**(사이드카 회귀파일 `centeringSlot.test.ts` 의 stale 기대값) 발견 → 원인 판별 후 신 계약으로 갱신. 상세 아래.

---

## 0. 최종 결과 (한눈에)

| 항목 | 결과 |
|---|---|
| `npx tsc --noEmit` | **exit 0** |
| `npx vitest run --no-file-parallelism` (전체) | **177 파일 / 2057 테스트 PASS · exit 0** |
| 기준선(구현 직후, 내 개입 전) | 176 파일 / 2036 테스트 중 **3 FAIL**(`centeringSlot.test.ts`) |
| 신규 테스트 | **+21건** (centeringPreAim 14 · saveStore saveSnapshot/setupSaveName 7) |
| 갱신 테스트 | `centeringSlot.test.ts` T1/T3/T4 3건 (stale→신 계약) |

**결론: 결정형(B-1) 전 항목 확정. 라이브(B-3)는 sim 13100 DOWN 으로 검증 불가 — 한계 명시(§4).**

---

## 1. 착수 시 기준선 3건 실패 — 원인 판별 (구현 결함 아님 · stale 테스트)

구현자 self-check 는 `ptzCalibrator.test.ts`+`slotPtzWriter.test.ts` 2파일(20건)만 돌려 PASS 를 확인했으나,
**동일 컴포넌트의 사이드카 회귀파일 `centeringSlot.test.ts` 는 미실행**이었다. 전체 스위트 실행 시 3건 실패:

| 실패 | 위치 | 기대(구계약) | 실측(신동작) | 판정 |
|---|---|---|---|---|
| T1 | centeringSlot:160 | 센터링 단계 `opts[0].plateRoi.x≈0.62`(prior) | `plateRoi === undefined`(미전달) | **stale — 설계 §A-1 = plateRoi 미전달** |
| T3 | centeringSlot:206 | 첫 캡처 = 프리셋 base `{22,6.8,1.69341}` | 선조준값 `{27.309,9.630,1.69341}` | **stale — pre-aim 오프셋** |
| T4 | centeringSlot:216 | 폴백 첫 캡처 = base `{0,0,1}` | 선조준값 `{8.99,4.7925,1}` | **stale — pre-aim 오프셋** |

### 결함이 아니라 stale 인 근거(수학 검증)
구현이 설계(§A-1, §B-1.2) 의도와 **정확히 일치**함을 산식으로 확인:
- **T4**: base `0/0/1`, LPD 중심 `(0.645,0.635)` → errX=0.145, errY=0.135. g=scaleGainForZoom(`{-62,-35.5,1}`, z=1)=`{-62,-35.5}`.
  dPan = −0.145·(−62) = **8.99**, dTilt = −0.135·(−35.5) = **4.7925** → 실측과 완전 일치.
- **T3**: base zoom 1.69341 → g 는 1/1.69341 스케일 → dPan=−0.145·(−36.612)=**5.309** → pan=22+5.309=**27.309** → 실측과 일치.
- **T1**: 설계 §A-1 이 "centerOnPlate 호출에 `plateRoi` 미전달(= PlatePtz 기본 `{0.5,0.5,0,0}` 화면중앙 최근접)"을 **명시**. 즉 opts[0].plateRoi 부재가 의도된 신 계약.

→ 세 실패 전부 **의도된 동작 변경을 인코딩하지 못한 구계약 테스트**. 구현 결함 아님. 리더 회신 불요(구현자 재호출 불필요).

### 조치 (은닉 아님 · 동등 이상 엄격도로 신 계약 인코딩)
느슨화가 아니라 **더 강한 신 계약**으로 갱신 — 매직넘버를 구현 미러 `preAimOf(base)`(동일 순수함수 조합)로 대체하여
게인 상수 변경 시 회귀를 자동 감지하게 함:
- T1: `opts[0].plateRoi` **undefined** 단언(+ 사유 주석 §A-1 참조).
- T3: 첫 캡처 == `preAimOf({22,6.8,1.69341})`, zoom 보존(=1.69341), 우측박스→pan↑.
- T4: 첫 캡처 == `preAimOf({0,0,1})`, zoom 보존(=1).

---

## 2. 신규 테스트 목록 (설계 §B-1 매핑)

### `test/centeringPreAim.test.ts` (신규 · 14건) — makePlatePtz 스텁으로 centerOnPlate 인자(startPtz·opts) 캡처

**B-1.1 preAimPtz 선조준(anti-latch, 5건)**
- centerOnPlate 전달 startPtz == preAim(구현 미러와 **완전 일치** `toEqual`), base 그대로가 아님, `opts.plateRoi` 미전달.
- zoom == base.zoom 불변(선조준 zoom 미접촉).
- 부호: 우측 박스(cx>0.5)→errX>0→**pan↑**(pan>base.pan), 하단→tilt↑.
- 좌측 박스(cx<0.5)→**pan↓** 방향 반전 확인.
- **서로 다른 박스중심 → 서로 다른 pre-aim**(공유 시작점 latch 차단, anti-latch 핵심).

**B-1.2 anti-duplication(1건)**
- 구분되는 prior 인접 두 슬롯(동일 cam/preset base) → **서로 다른 최종 `item.ptz`**(slot_ptz.json 증거의 동일-55.44 이웃수렴 재현 방지). 각 startPtz==preAim, 둘 다 plateRoi 미전달.

**B-1.3 순서(1건)**
- `expandPlateTargetsFromSlotSetup`: camIdx/presetIdx/globalIdx 역순 + `presetSlotIdx=null` 섞은 입력 → 반환 targets `(camIdx,presetIdx,globalIdx)` **asc** (`[8,12,19,20,30]`), 연속쌍 단조 비감소.

**B-1.4 R2 게이트(3건)** — upsertSlotCentering rows 캡처
- `{centered:true,converged:false}`(zoom 미수렴) → **포함**(rows 1건, slotId=7, centered:1).
- `{centered:false}`(번호판 미검) → **제외**(upsert 미호출).
- `{globalIdx:null}`(방어경로, slotId=null 캐스팅) → **제외**(매핑 불가 스킵).

**B-1.5 R3 스냅샷(4건)**
- done: `saveSnapshot` **정확히 1회**, name `^Setup_\d{8}_\d{6}$`, payload=`{createdAt:'T', slots:getSlotSetup(), centering:items}`(참조 동일성까지).
- error(writer throw→state error): `saveSnapshot` **미호출**(부분·불신 미기록).
- saveStore 미주입: **no-op**(잡 정상 done).
- saveSnapshot throw: **격리**(잡 done 유지).

### `test/saveStore.test.ts` (확장 · +7건) — B-1.7 / R3 이름
- saveSnapshot: stringify5 직렬화(1.123456789→1.12346, 9.999…995→10), reports 미러 동일 바이트, 미주입 시 save/만, 미러 실패 격리(warn 1회), **sanitize traversal 차단**(`../evil`·`a/b`·`..` → throw).
- setupSaveName: `Setup_YYYYMMDD_HHMMSS`(고정 Date `2026-07-20 13:05:07`→`Setup_20260720_130507`), 안전화 통과.

### `test/centeringSlot.test.ts` (갱신 · 3건) — §1 참조.

---

## 3. 경계면 교차 검증 (MCP↔REST shape · 1-based · DB 컬럼)

| 경계 | 검증 | 결과 |
|---|---|---|
| preAim → PlatePtz.centerOnPlate | startPtz(Ptz `{pan,tilt,zoom}`) shape 일치, plateRoi(opts) 미전달 | ✅ |
| SlotPtzItem.ptz ↔ SlotCenteringRow | 분해 pan/tilt/zoom 매핑, 키 `slotId`=정수 globalIdx(문자열 아님), round5 영속 정밀도 | ✅(centeringSlot T7 유지) |
| expand 정렬 인덱스 | camIdx/presetIdx **1-based**, globalIdx=정수 slot_id, asc | ✅ |
| 스냅샷 payload | `slots`=getSlotSetup()(PTZ 반영 뷰, DB UPDATE **후** 재조회), `centering`=items | ✅ |
| stringify5 영속 경계 | 스냅샷·writer 수치 소수점 최대 5자리 | ✅ |

DB UPDATE→getSlotSetup 재조회 순서(run: writer→saveCenteringSlots→saveSetupSnapshot) 코드상 확인 — 스냅샷이 최신 PTZ 반영 뷰를 담음.

---

## 4. 라이브 한계 (은닉 금지 · 설계 §B-3)

**시뮬레이터 13100 DOWN → 아래는 이번 라운드 검증 불가(위장 성공 금지):**
- 실 PTZ 물리 수렴 — pre-aim 이 **실카메라에서 정말 정판을 화면중앙에 두는지**.
- **비-cam1 게인 정확도** — fallback 게인(−62/−35.5)은 cam1 실측값. 타 카메라 pre-aim 은 coarse 라 게인 50% 오차에도 이웃 disambiguation(간격 0.11~0.15 의 절반)엔 충분하다는 것이 설계 가정이나, **최종 확증은 라이브 필요**.
- `/calibrate/ptz` 실발화 후 `slot_ptz.json` 순서·`slot_setup.centered` 행·`save/Setup_*.json` 실파일 존재(B-2 라우트 실측) — 결정형 로직은 유닛으로 확정했으나 실 IO 스모크는 **미수행(누락 명시)**.

결정형(B-1: 선조준 산출·인자 전달·정렬·저장 게이트·스냅샷 호출/미호출/격리·파일 IO)은 **전부 확정**.

---

## 5. 재현 절차

```
cd SettingAgent
npx tsc --noEmit                      # exit 0
npx vitest run --no-file-parallelism  # 177 files / 2057 tests PASS
# 대상만:
npx vitest run test/centeringPreAim.test.ts test/centeringSlot.test.ts test/saveStore.test.ts --no-file-parallelism
```

## 6. 문서화 인계 (documenter)
- 구현 3중저장(save/Setup_*.json a2 · DB slot_setup centered-only 게이트 · slot_ptz.json 무변경) 및 pre-aim anti-latch 를 한글 문서화.
- **process 지적**: 구현자 self-check 가 컴포넌트 사이드카 회귀파일(`centeringSlot.test.ts`)을 누락 → 전체 스위트 미검증 상태로 "20/20 PASS" 보고. 향후 회귀 주장은 전체 스위트 기준 권장(영향도 분석에 반영).
