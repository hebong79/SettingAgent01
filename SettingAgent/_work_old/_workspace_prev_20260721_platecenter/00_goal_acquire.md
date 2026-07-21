# 00 GOAL — 센터라이징 검출확실성 재설계: 방안 2(목표PTZ 직접산출) + 방안 3(줌사다리 폴백)

> B-mode goal/loop 이터4. 마스터 확정: **"순서보다 정확히 찾는 게 우선."** 넓은 시야에서 판이 작아 미검→센터링 실패면 순서 무의미. **먼저 확대해서 확실히 찾은 뒤** 센터링.

## 확정 사실 (라이브·코드 실증)
- 넓은 시야(낮은 zoom) 재검출이 실패 근원: zoom=1 → 2/17, 프리셋 zoom(~2) → 10/17. 판이 작아 LPD 미검(no_plate)·줌중 소실(plate_lost).
- **lpd 는 이미 discovery(디지털 크롭-줌, 무이동)가 확실히 찾은 산출물** — `slot_setup.lpd`. 즉 "찾기"는 검증됨. 센터라이징이 이 lpd 를 "목표"로 안 쓰고 물리이동+넓은시야 재검출에 의존하는 게 문제.
- **게인 무관 목표 zoom 직접산출 가능**: 폭 ∝ zoom → `Zt = presetZoom × targetPlateWidth / lpdWidth`. PtzCalibrator 는 presetZoom(`startPtzFor`)·lpdWidth(`plateRoi.w`) 둘 다 보유. (pan/tilt 조준만 게인 필요 — pre-aim.)

## Goal (관찰 가능 · 라이브 실증)
1. **검출 확실성 최우선**: 각 lpd 보유 슬롯에서 번호판을 **확실히 재포착**해 센터라이징 완주. no_plate/plate_lost 대폭 감소(목표: 라이브 converged ≥ 이전 10/17 크게 상회).
2. **방안 2(먼저 확대해서 찾기)**: lpd 로 목표 zoom(게인무관 직접산출)·목표 pan/tilt(pre-aim) 산출 → **목표 zoom 근처로 줌인**(판이 커져 확실히 검출) → 소유권으로 자기 판 확인 → 미세 센터(pan/tilt)+폭(20%) 마감.
3. **방안 3(줌 사다리 폴백)**: 목표 줌인 지점에서 판 미검(조준오차로 FOV 밖)이면 **줌아웃 한 단계씩 넓혀 재포착**(검출되는 zoom 찾기) → 재포착 후 재센터·재줌인. 검출될 때까지 사다리(상한 내). 게인 부정확에 강건.
4. **최종 폭 20%**: 완주 슬롯 plateWidth ≈ targetPlateWidth(0.2±widthTol).

## 제약(불변 · Requirements)
- 이터1~3 성과 회귀 0: 저장3중(save/Setup_*.json·DB slot_setup·slot_ptz.json)·소유권 게이트(peerOffsets)·타깃정렬·config 노브(centerZoom/maxZoomStepRatio).
- 결정론(LLM 무)·부분 UPDATE·stringify5·외과적 최소. 좌표계 일관(정규화 프레임).
- PlatePtz 제어수식(gain/predict/zoomCorrection/panTiltCorrection) 재사용 — 재조립은 허용하되 수식 자체 무변경 지향.
- 소유권 게이트(pickOwnedPlate/peerOffsets) 재검출 전 구간 유지(이웃 판 배제).

## Loop (리더 주도)
1. 분석: 현 calibrateSlot/PlatePtz 흐름·실패 로그.
2. 설계(architect): 목표PTZ 산출 + 줌인 우선 acquire + 줌아웃 사다리 폴백. calibrateSlot/PlatePtz 재조립 지점.
3. 구현(developer).
4. 라이브 검증(리더): `POST /calibrate/ptz` → 로그(`cat:centering`)·slot_ptz.json 로 converged 수·폭·acquire 경로 확인.
5. 틀어짐(미검·소실·과줌) → 재분석(목표zoom 상수·사다리 스텝·게인) 후 재실증.
6. 성공 → vitest(순수 로직) + 문서 마감.

## 검증 한계(은닉 금지)
- 카메라 13110(simulator-1) 라이브. fallback 게인 −62/−35.5(cam1)는 여전히 pan/tilt 조준 정확도에 영향 — 방안3 사다리가 이를 흡수하도록 설계. 실 Hucoms·타 카메라는 미검증(이월).
