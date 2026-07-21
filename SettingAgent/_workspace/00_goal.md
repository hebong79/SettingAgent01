# 00 GOAL — 센터라이징 근본재설계: lpd 신원 기반 배타성 (이터레이션 2)

> B-mode(goal/loop) 이터레이션 2. 이터레이션 1(pre-aim, `_workspace_prev_20260720_preaim/`)은 시작점만 옮겨
> 근본해결 실패. 마스터 진단 승인: **lpd 필드값이 최종 수렴을 지배하지 못하는 "재검출 nearest" 방식이 원인.**

## 확정 근본원인 (실제 DB setting.sqlite slot_id 순회 실증)
- 각 slot_id 의 lpd 중심은 **모두 뚜렷이 구별**됨(preset2 cx=0.097/0.212/0.325/**0.464**/0.62/**0.766**). 순회는 실제로 slot_id 1:1(반복/누락 없음 — 마스터 구조 논리 맞음).
- 그런데 결과 PTZ: slot11(lpd cx0.464)·slot13(lpd cx0.766)이 **둘 다 pan≈55.5 로 수렴**(완전히 다른 판인데 겹침), slot12 미검. = "같은 주차면 반복 + 건너뛰기"의 정체.
- **핵심 결함**: `PtzCalibrator.calibrateSlot`→`PlatePtz` 는 lpd 를 "목표"가 아니라 "초기 검출 힌트"로만 쓰고, 최종 수렴 대상을 매 프레임 **화면중앙 최근접 재검출(`pickNearestPlate`)** 로 정함. → "몇 번 슬롯 처리 중"(순회 1:1)과 "화면 어느 판으로 수렴"(재검출 nearest)이 **분리**. 밀집 프리셋(간격 0.11)에서 줌인 중 이웃 판으로 갈아탐(latch).
- pre-aim 이 불충분한 이유: 시작점만 옮기고 수렴은 여전히 nearest 의존 → pre-aim 오차 > 판 간격이면 즉시 이웃 latch(비-cam1 게인 부정확 시 특히).

## Goal (관찰 가능한 성공기준)
1. **lpd 신원이 수렴을 지배**: 각 슬롯 센터링이 그 슬롯의 lpd 필드값이 가리키는 **바로 그 판**으로만 수렴한다. 이웃 판으로 갈아타지 않는다.
2. **결과 무중복·무누락**: 서로 다른 slot_id 가 (거의) 동일 PTZ 로 수렴하는 중복이 사라진다. lpd 보유 슬롯은 전부 처리(건너뛰기 없음), 이웃절도로 인한 미검이 사라진다.
3. **저장 3중 유지**(이터1 성과 보존): `save/Setup_*.json`(완전셋업 스냅샷) · DB `slot_setup` · `data/slot_ptz.json`.

## 해결 방향 (검증된 코드 재사용 — 새 발명 최소)
- **배타성 게이트 재사용**: `plateDiscovery.pickOwnedPlate(candidates, selfAnchor, peerAnchors)` = Voronoi 소유권(자기 앵커가 모든 peer 앵커보다 엄격 최근접인 판만 자기 소유). 이미 discovery 에서 검증됨.
- 센터링 재검출 대상 선정을 `pickNearestPlate` → **소유권 기반**으로: selfAnchor=자기 슬롯 lpd 중심, peerAnchors=**같은 프리셋 타 슬롯들의 lpd 중심**. 이웃 판은 소유권에서 기각 → latch 불가.
- lpd → 목표 PTZ 직접 산출(pre-aim 유지·강화 가능)로 대상을 화면중앙 근처에 두되, **최종 수렴 신원은 소유권 게이트가 보증**.

## 제약(불변 · Requirements)
- VPD off 유지 · 결정론(LLM 무) · 부분 UPDATE(slot_setup wipe 금지) · stringify5/round5 · 외과적 최소.
- 이번엔 PlatePtz 대상선정(재검출) 코어 변경이 **불가피** — 단 폐루프 제어수식(gain/predict/zoom)은 무접촉, 선정 로직에만 소유권 주입. 최소 침습.
- 양 진입점(수동 `/calibrate/ptz` · auto-chain SetupPipeline) 모두 반영. 이터1 저장 3중 회귀 0.

## 검증 한계(은닉 금지)
- 시뮬 13100 DOWN → 라이브 PTZ 물리 수렴은 검증 불가. 소유권 선정 로직·peerAnchors 산출·이웃기각은 vitest 결정형으로 확정하고, 실카메라 수렴은 한계로 명시.
