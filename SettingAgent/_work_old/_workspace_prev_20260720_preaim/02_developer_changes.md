# 02 DEVELOPER — 정밀수집 센터라이징 버그 수정 구현 변경요약

> 입력: `_workspace/01_architect_plan.md`(A절) + 리더 D-1 확정(**a2 채택** — save/Setup_*.json = 완전한 최종 셋업 스냅샷).
> 제약 준수: PlatePtz/controlMath 코어 무접촉(import 재사용만) · VPD off · 결정론 · 부분 UPDATE · stringify5 · round5 · 외과적 최소.
> 빌드: `npx tsc --noEmit` **exit 0**. 회귀: `ptzCalibrator.test.ts`+`slotPtzWriter.test.ts` **20/20 PASS**.

---

## 변경 파일 (4개)

### 1. `src/store/SaveStore.ts` (A-3)
- **신규 메서드** `saveSnapshot(name: string, data: unknown): string` (약 L52~72)
  - `save()` 미러이되 `SetupArtifact` 타입 제약 없음(스냅샷 payload 는 SetupArtifact 형이 아니므로). `sanitizeName`→`stringify5(data,2)`→`save/{safe}.json` 기록 + `reportsDir` best-effort 미러(실패 격리). 안전화 실패 시 throw.
  - 기존 `save(name, SetupArtifact)` **무변경**.
- **신규 함수** `setupSaveName(date = new Date()): string` (파일 말미)
  - `Setup_YYYYMMDD_HHMMSS`(로컬 시각) — `defaultSaveName` 미러(`result_` → `Setup_`).

### 2. `src/calibrate/slotPtzWriter.ts` (A-2)
- **`expandPlateTargetsFromSlotSetup`** 반환 직전 정렬 1줄 추가 (L30~32)
  - `targets.sort((a,b) => a.camIdx-b.camIdx || a.presetIdx-b.presetIdx || (a.globalIdx! - b.globalIdx!))`
  - 주차면번호 asc 결정형 보장(R1 순서). `globalIdx`=정수 slot_id(항상 존재) → NULL tie-break 불요.
  - **`getSlotSetup` 의 `ORDER BY` 는 무접촉**(공유 소비자 blast radius 회피 — 정렬은 이 펼침 함수에서만).

### 3. `src/calibrate/PtzCalibrator.ts` (A-1, 핵심)
- **import 추가** (L6~11): `center`(geometry), `scaleGainForZoom`·`panTiltCorrection`(controlMath), `setupSaveName`·`type SaveStore`(SaveStore). 전부 기존 순수/헬퍼 — 코어 무접촉.
- **상수 신규** `PREAIM_MAX_STEP = 90`(°) — pre-aim coarse 스텝 상한. `cfg.maxStepDeg`(=5, 폐루프 미세보정용)는 재사용 금지 사유 주석.
- **생성자 dep 가산** `saveStore?: Pick<SaveStore,'saveSnapshot'>` — 인터페이스·필드·대입. 미주입 시 스냅샷 no-op(수동 흐름/테스트 회귀 0).
- **신규 private `preAimPtz(t, base): Ptz`** (baseOpts 앞) — 슬롯 LPD 박스 중심→화면중앙 결정형 1스텝 선조준. `scaleGainForZoom({cfg.fallbackGain*, zoomRef:1}, base.zoom)` + `center(t.plateRoi)` + `panTiltCorrection(err, g, base.pan, base.tilt, PREAIM_MAX_STEP)`. **zoom 불변**(넓은 시야 유지).
- **`calibrateSlot` 수정**:
  - `baseStart = startPtzFor(t)`(프리셋 base·캐시) → `startPtz = preAimPtz(t, baseStart)`(슬롯마다 다른 시작점, anti-latch).
  - `centerOnPlate` 호출에서 **`plateRoi` 미전달**(`{...base}`만) → PlatePtz 기본 `{0.5,0.5,0,0}`(화면중앙 최근접). pre-aim 후 대상이 중앙 근처 → 그 슬롯 판 pick. zoom 단계는 **무변경**.
- **`saveCenteringSlots` 게이트 완화(R2)**: `if (!it.centered || !it.converged)` → `if (!it.centered)`. zoom 미수렴(converged:false)도 pan/tilt 유효 → 저장. `centered:false`(번호판 미검)만 제외. zoom-수렴 뉘앙스는 slot_ptz.json 이 정본.
- **`run` done 경로 + 신규 `saveSetupSnapshot(items)`** (R3, **리더 D-1=a2**):
  - done 경로 순서: `writer(slot_ptz)` → `saveCenteringSlots(items)`(**DB UPDATE 먼저**) → `saveSetupSnapshot(items)`.
  - `saveSetupSnapshot`: best-effort. payload = `{ createdAt: this.now(), slots: this.store.getSlotSetup(), centering: items }` = **완전한 최종 셋업**(PTZ 반영된 slot_setup 뷰 + 센터링 상세 converged/reason). `saveStore.saveSnapshot(setupSaveName(new Date()), payload)`. saveStore 미주입·기록 실패는 격리(잡/JSON/DB 무영향).
  - **error 경로는 스냅샷 미기록**(부분·불신).

### 4. `src/index.ts` (A-4)
- `new PtzCalibrator({...})` 에 이미 생성된 `saveStore` 주입 1줄(L91). 수동 `/calibrate/ptz`·auto-chain 양 진입점 모두 스냅샷 반영.

---

## 설계 대비 판단 노트
- **리더 D-1=a2 반영**: 설계서 A-1 원안(스냅샷=`buildSlotPtzJson(items)`, a1)을 리더 확정대로 **a2**(getSlotSetup 병합 뷰)로 변경. `run()` 이 `saveCenteringSlots` **이후** `getSlotSetup()` 재조회하여 PTZ 반영된 최신 뷰를 스냅샷에 담음. `store` dep 타입은 이미 `getSlotSetup` 포함 → 추가 확장 불요.
- 리더 문구 `centering: buildSlotPtzJson(items, this.now()).items` 는 항등적으로 `items` 와 동일(`.items` 가 원본 배열) — 불필요한 래핑 제거하고 `centering: items` 로 구현(단순성, 값 동일).
- `preAimPtz` 부호: errX>0(우측 박스)·gainPan<0 → `-errX·gainPan>0` → pan↑(우향). detectMath 방향과 일치.

## 검증(구현자 self-check)
- `npx tsc --noEmit` → **exit 0**.
- `vitest run test/ptzCalibrator.test.ts test/slotPtzWriter.test.ts` → **20 passed**. 기존 mock(resolvePresetPtz 미지원→base 0/0/1) 에서 pre-aim 이 startPtz 를 이동시키나 폐루프가 정상 수렴(회귀 없음).

## 검증자 인계(추가 테스트 권고)
- `preAimPtz` 순수성(서로 다른 박스중심→서로 다른 PTZ, zoom 불변, 부호) — 현재 private. 필요 시 인자 캡처 스텁으로 `centerOnPlate` startPtz==preAim·plateRoi 미전달 검증.
- `saveCenteringSlots` `{centered:true,converged:false}` 포함 / `{centered:false}` 제외.
- `saveStore` 스텁 주입 시 done→`saveSnapshot(Setup_ prefix, {slots,centering})` 1회, error→미호출, 미주입→no-op.
- `SaveStore.saveSnapshot`/`setupSaveName` 파일 IO·이름 포맷·sanitize.
- **라이브 이월(은닉 금지)**: sim 13100 DOWN → 실 PTZ 물리 수렴·pre-aim 실판 중앙화·비-cam1 게인 정확도는 이번 검증 범위 밖(설계 B-3).
