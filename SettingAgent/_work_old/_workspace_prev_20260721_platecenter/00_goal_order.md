# 00 GOAL — 센터라이징 순서 엄수: pan/tilt 중앙정렬(넓은시야) → zoom 확대 (B-mode goal/loop 이터3)

## Goal (관찰 가능 · 라이브 실증)
센터라이징이 **반드시** 이 순서를 지킨다:
1. **먼저 Pan/Tilt** 로 번호판 박스를 **화면 중앙**으로 완전 정렬(넓은 시야 = 낮은 zoom 에서 수렴).
2. **그 후 zoom 만 점진 확대** — 번호판 폭이 화면(이미지) **20%(targetPlateWidth=0.2)** 가 될 때까지.

성공 관찰(로그 `cat:centering`):
- 각 슬롯 `phase:center` 가 **낮은 zoom(넓은시야)** 에서 수렴한 뒤 `phase:zoom` 진행.
- zoom 단계에서 pan/tilt 대폭 조정이 반복되지 않음(줌 우세). "줌 먼저·팬틸트 나중" 소멸.

## 현재 문제 (로그 실증, setting_20260720_172548.log)
- 유일한 `phase:center` 로그가 **zoom 2.03**(프리셋 줌)에서 수렴 — center 단계가 넓은 시야가 아니라 **프리셋 줌 상태**에서 일어남.
- 대부분 슬롯은 center 로그 없음 = pre-aim 후 `isCentered` 조기반환(iterations:0) → 실제 pan/tilt 정렬이 넓은 시야에서 충분히 안 됨.
- zoom 단계(`zoomToPlateWidth`)의 가드-선행 재중심이 pan/tilt 를 줌 사이에 끼워 넣음 → 마스터 눈엔 "줌 먼저, 팬틸트 나중".

## 해결 방향 (loop 로 실증·보정)
- 센터링(1단계)을 **넓은 시야(낮은 zoom, cfg.centerZoom 기본 1.0)** 에서 수행 → pan/tilt 완전 수렴.
- 줌(2단계)은 그 넓은 시야에서 **점진 확대**(1.0 → 20% 폭). 가드 재중심은 안전최소로 유지(줌인 중심오차 확대 방지 — 물리 필수).
- centerZoom 은 config(마스터가 tools.config.json 오픈)로 튜닝 가능. 너무 넓어 판 미검이면 loop 에서 상향.

## Loop (리더 주도, 이터레이션)
1. 분석: 로그로 center/zoom 순서·zoom값 확인.
2. 설계·구현: centerZoom 도입, calibrateSlot 이 넓은시야 센터 후 줌.
3. 라이브 검증: `POST /calibrate/ptz` 실행 → 새 로그 `cat:centering` 로 순서·zoom 확인 + slot_ptz.json 결과.
4. 틀어짐(판 미검·순서 위반·수렴 실패) → 재분석(centerZoom·guard·게인) 후 재실증.
5. 성공 → vitest(순수 로직) + 문서 마감.

## 제약(불변)
- 저장 3중(save/Setup_*.json·DB slot_setup·slot_ptz.json)·소유권 게이트(이터2)·타깃정렬(이터1) 회귀 0.
- 결정론·부분 UPDATE·stringify5·외과적 최소. PlatePtz 제어수식 무접촉(오케스트레이션·config만).

## 검증 한계(은닉 금지)
- 카메라 소스 13110(simulator-1) 라이브 — 실 PTZ 검증 가능. 실패 시 로그로 사실 확인 후 보정.
