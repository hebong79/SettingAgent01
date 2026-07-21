# 설계: 클릭 지점 → 화면중앙 폐루프 조준 (패치 NCC 추적, goal/loop B모드)

## 0. 배경·실패원인(경험적 확인)
"개별 center"(mode:'point')의 기존 `aimPointToCenter`는 `preAimPtz`(배치의 **coarse 1스텝 사전조준**) 공식을 1회만 적용 → 실패.
- 실측(cam1, preset1, z1.69341, 1920×1080): pan+1°→dx −0.0266 / tilt+1°→dy −0.0472, pan↔dx·tilt↔dy 순수 분리·대칭, 텍스처부 NCC score 0.95+.
- 게인 크기는 config(−36.6@z)와 일치. 실패는 **① 1스텝 개루프라 잔차 미보정 ② 원근 비균일(중앙 −0.0266 vs 변두리 −0.0177, ~30%)** 때문. → **폐루프로 매 스텝 재측정하면 수렴.**

## 1. Goal(관찰형 성공기준)
라이브뷰 임의 지점 클릭 → 그 **클릭 픽셀**이 화면중앙(0.5,0.5)에 `centerTol`(0.03≈30px) 이내로 오도록 pan/tilt를 폐루프 반복 조정. **저장 없음. 번호판 무관(클릭 패치 자체 추적).** 성공은 before/after 프레임 육안(클릭했던 내용이 중앙에 옴)으로 확증.

## 2. 방법: 클릭 패치 NCC 추적 + 게인 예측 소탐색창 + 온라인 게인보정
추적 대상=클릭 내용이므로 **항상 화면 안**(시작=클릭위치 → 끝=중앙). LPD·번호판 불필요. sharp만 사용(신규 의존성 0).

### 2.1 신규 모듈 `src/calibrate/patchTrack.ts` (순수·유닛테스트 대상)
- `toGray(jpeg, workW): Promise<{data:Uint8Array,w,h}>` — sharp grayscale + **작업해상도 다운스케일**(예 960폭, 속도). 정규화좌표는 해상도 무관.
- `patchTexture(gray, cxN, cyN, halfPx): number` — 로컬 표준편차(패치 신뢰 판정용).
- `extractTemplate(gray, cxN, cyN, halfPx): {tpl:Float32Array,half,mean,std}`.
- `nccSearch(gray, template, predCxN, predCyN, radiusPx, step=1): {cxN,cyN,score}` — 정규화상관 최대점. 경계 클램프. (측정 스크립트 `ncc` 로직 이식·검증됨.)

### 2.2 신규 폐루프 `src/calibrate/PointAimer.ts`(또는 PtzCalibrator private) — centerOnPlate 구조 미러, 측정만 패치로 교체
입력: camera(ICameraClient), cfg(calibrate), 옵션(patchHalfPx, workW, searchRadiusPx, minScore, maxIter, centerTol, maxStepDeg, settleMs).
```
aim(cam, preset, clickPt): {ok, ptz, finalErr, iterations, reason?}
  startPtz = resolvePresetPtz(cam,preset)
  cap0 = camera.requestImage(cam,preset,startPtz); onFrame(cap0)   // lastFrame 갱신
  g0 = toGray(cap0.jpg, workW)
  if patchTexture(g0, clickPt, half) < TEX_MIN: return {ok:false, reason:'low_texture'}  // 정직
  tpl = extractTemplate(g0, clickPt, half)
  pNow = clickPt; ptz = startPtz
  // 게인: config fallback(deg/err) scaleGainForZoom(startPtz.zoom) — 실측과 일치, 초기값으로 충분
  gain = scaleGainForZoom({gainPan:cfg.fallbackGainPanDeg,gainTilt:cfg.fallbackGainTiltDeg,zoomRef:1}, startPtz.zoom)
  for iter in 0..maxIter:
    err = {errX:pNow.x-0.5, errY:pNow.y-0.5}
    if isCentered(err, centerTol): return {ok:true, ptz, finalErr:err, iterations:iter}
    next = panTiltCorrection(err, gain, ptz.pan, ptz.tilt, maxStepDeg)   // 기존 controlMath 재사용
    cmd = {pan:next.pan, tilt:next.tilt, zoom:startPtz.zoom}             // zoom 불변
    cap = camera.requestImage(cam,preset,cmd); onFrame(cap); await settle
    g = toGray(cap.jpg, workW)
    // 예측: 명령 변위(cmd-ptz)를 게인으로 화면변위로 환산해 pNow 이동 예측 → 그 근처만 소탐색
    pPred = predictShift(pNow, {dPan:cmd.pan-ptz.pan, dTilt:cmd.tilt-ptz.tilt}, gain)
    m = nccSearch(g, tpl, pPred.x, pPred.y, searchRadiusPx)
    if m.score < minScore: { 광역 재탐색 1회; 실패면 return {ok:false, reason:'patch_lost'} }
    // 온라인 게인보정: 실제 화면변위 vs 명령 변위 → 게인 갱신(과보정 방지 EMA)
    gain = refineGain(gain, measuredShift=(m − pNow), commanded=(cmd-ptz))   // 선택적·EMA, 발산가드
    pNow = {x:m.cxN, y:m.cyN}; ptz = cmd
  return {ok:false, ptz, finalErr:err, iterations:maxIter, reason:'max_iterations'}
```
- `predictShift`/`refineGain`: 실측 부호(pan+ → dx−, tilt+ → dy−)와 정합. panTiltCorrection 규약(Δdeg=−gain·err 형태, 기존과 동일)을 그대로 쓰고, 예측은 그 역으로 화면변위 산출.
- **저장 호출 0**(writer/DB/스냅샷/upsert 미호출).

### 2.3 배선 — 계약 무변경
`PtzCalibrator.aimPointToCenter`의 **본문만** 이 폐루프로 교체(시그니처·라우트 `mode:'point'`·프론트 `calPointCenter` 그대로). 상호배타(state/pointBusy) 유지. onFrame→lastFrame로 `/calibrate/frame` 폴링 표시.

## 3. 파라미터 초기값(실측 근거, goal/loop로 튜닝)
- workW=960(속도/정확 균형), patchHalfPx=32(원본 64 상당), searchRadiusPx=28, step=1, minScore=0.5, TEX_MIN≈8(표준편차; 실측 저텍스처 tex=7 실패·tex≥14 성공), centerTol=0.03, maxStepDeg=**2.5**(1스텝 화면변위 pan~0.066/tilt~0.118 → 예측+소탐색 커버), settleMs=cfg(300), maxIter=20.
- 원근 비균일은 매 스텝 재측정으로 흡수(변두리→중앙 이동하며 게인 균일해짐).

## 4. 검증(B모드)
- **유닛(qa)**: patchTrack을 **합성 평행이동 이미지**로 정밀 검증(알려진 dx,dy 주입→nccSearch가 복원). 저텍스처→score 저하 게이팅. PointAimer 오케스트레이션은 camera+tracker 목킹으로(요청PTZ 수렴·저장0·reason 분기).
- **경험적(리더)**: 서버(13020) 실카메라로 `POST /calibrate/point{mode:'point'}` 구동 → 응답 finalErr·iterations 확인 + before/after 스냅샷 sharp 렌더로 클릭내용 중앙수렴 육안 확인. 여러 클릭점(중앙/변두리/저텍스처) 순회. 틀어지면 파라미터 튜닝·재분석.
- **한계 명시**: 저텍스처/야간/반복무늬 클릭은 신뢰도 저하 → 정직히 reason 반환. 실카메라 PTZ 지연은 settleMs로 흡수.

## 5. 영향도
- 신규 파일 2(patchTrack, PointAimer) + `aimPointToCenter` 본문 교체 + 신규 dep 0. 배치 센터라이징·저장·preAimPtz·라우트·프론트 계약 무접촉. mode:'plate'/'plate-zoom' 무변경.
