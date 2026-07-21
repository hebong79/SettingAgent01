# RESUME 체크포인트 — 클릭 지점 화면중앙 조준 (개별 center)

작성: 2026-07-21. 다음 세션에서 이어서 작업하기 위한 재개 메모.

## 현재 상태: ✅ 완료·검증됨 (라이브 6/6 수렴)

정밀수집 센터라이징 콤보 "개별 center"(mode:'point') = **클릭한 지점 자체를 화면중앙으로** 옮기는 patch-NCC 폐루프. 번호판 무관, 저장 없음, 2~3회 반복 수렴.

- **개루프 1스텝 실패 → 패치 NCC 폐루프로 재구현.** 실패원인은 게인크기 아님(config −62/−35.5@z1 = 실측일치), ① 1스텝 잔차 미보정 ② 원근 비균일(~30%).
- 실측 게인(cam1/preset1/z1.69341/1920×1080): **pan+1°→dx −0.0266, tilt+1°→dy −0.0472** (분리·대칭).
- 라이브 6/6 클릭점 중앙 tol 0.03 이내 수렴(5개 dist≤0.002, 1개 0.019). 저텍스처 2건은 패치 확대재시도(half 32→64→96)로 구제.

## 관련 파일
- 신규: `src/calibrate/patchTrack.ts`(sharp NCC: toGray/patchTexture/extractTemplate/nccSearch), `src/calibrate/PointAimer.ts`(폐루프 `aim()` + 저텍스처 확대재시도)
- 수정: `src/calibrate/PtzCalibrator.ts`(`aimPointToCenter` 폐루프 위임), `src/api/calibrateRoutes.ts`(`mode:'point'` 응답 reason/iterations 가산), `web/app.js`(`calPointCenter` 실패사유 한글매핑)
- 콤보 UI: `web/index.html` `#cal-click-mode` 3옵션(off/center=point/center-zoom=plate-zoom)
- 테스트: `test/patchTrack.test.ts`, `test/pointAimer.test.ts`, `test/ptzCalibrator.point.test.ts`, `test/calibrateRoutes.point.test.ts`
- 문서: `docs/20260721_111734_클릭지점_중앙조준_폐루프.md`, `_workspace/01_architect_plan_patch_aim.md`, `_workspace/02~04_*.md`

## 검증 현황
- `npx tsc -p tsconfig.json --noEmit` → 0
- `npx vitest run` → 182파일/2121 green
- 라이브 검증: `/viewer/api/snapshot?cam=1&preset=1&mode=manual&pan=&tilt=&zoom=`로 스틸 취득 → `POST /calibrate/point {cam,preset,point,mode:'point'}` → `/calibrate/frame`(최종프레임) NCC 대조. (검증 스크립트는 임시로 작성 후 삭제; 재작성하려면 이 흐름 재현.)

## 튜닝 상수(PointAimer.ts 최상단, goal/loop 조정 대상)
WORK_W=960, PATCH_HALF_PX=32, SEARCH_RADIUS_PX=28, MIN_SCORE=0.5, TEX_MIN=8, MAX_STEP_DEG=2.5, MAX_ITER=20, TEXTURE_RETRY_HALVES=[32,64,96].

## 다음에 할 수 있는 후속(미착수)
1. **타 카메라/프리셋 실측 순회** — 게인은 cam1 기준. 다른 카메라는 초기게인만 다르고 폐루프가 흡수하나 실측 미확인. preset2/3, 타 cam에서 6클릭점 수렴 검증.
2. **저텍스처/야간 강건성** — 반복무늬·어두운 바닥에서 patch_lost 빈도 확인, 필요시 위상상관(방법②) 하이브리드 고려.
3. **온라인 게인보정(refineGain)** — 현재 미포함(고정게인+재측정으로 충분). 원근 큰 프리셋에서 수렴 느리면 EMA 게인보정 추가 검토(발산가드 필수).
4. **UX** — 실패사유 노출은 됐고, 진행 중 클릭 패치 위치를 오버레이에 표시하면 조작감 향상(선택).

## 환경 메모
- 서버 13020(리로드=nodemon src 감시), 카메라 13110(JSON-RPC), LPD 실서비스 192.168.0.125:9082. cam1 preset1=pan22/tilt6.8/zoom1.69341.
- 콤보 mode 매핑: center→'point'(폐루프), center-zoom→'plate-zoom'(번호판 center+zoom, 무변경), off→기존 편집.
