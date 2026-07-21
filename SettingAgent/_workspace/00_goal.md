# Goal — 개별 center = 클릭 위치점을 화면 중앙으로 (pan/tilt only)

브랜치: `feat/click-center-pantilt` · 실행모드: **B(goal/loop, 관찰형 성공기준)**

## Goal (관찰 가능한 성공)
라이브뷰에서 `개별 center` 모드로 임의의 지점을 클릭하면, **그 지점이 화면 중앙**으로 온다.
- pan/tilt 만 변한다. **zoom 은 변하지 않는다.**
- 번호판/차량 검출에 의존하지 않는다(클릭점 자체가 목표).
- 어디에도 저장하지 않는다(slot_ptz.json / DB centering_slot / Setup 스냅샷 미기록).

## Requirements (루프 내내 유지되는 불변 제약)
1. `개별 center+zoom` 은 **기존 그대로**(번호판 기준 `plate-zoom`) 유지 — 회귀 0.
2. 휴컴스 네이티브 함수(`ptz_centering setcenter type=point`)를 **실카메라 경로에서 실제로 사용**한다.
3. 현재 선택 런타임 카메라는 시뮬(`simulator-1`, Unity RPC)이므로 **시뮬 경로가 오늘 동작·검증되어야** 한다.
4. 저장 경로 무접촉(회귀 가드 테스트 유지).
5. 배치 센터라이징(`state==='running'`)·개별 진행 중 상호배타 가드 유지(409).
6. 기존 오버레이 편집 동작(콤보 off 일 때) 100% 보존.

## 성공 확인 방법 (경험적)
1. 스냅샷 A 촬영 → 특징점(차량 모서리 등) 픽셀 좌표 선택.
2. `POST /calibrate/point {mode:'point'}` 발화.
3. 스냅샷 B 촬영 → 그 특징점이 **중앙 십자(#center-cross) 근처**인지 육안 대조.
4. 응답 ptz 의 zoom 이 발화 전 zoom 과 동일한지 수치 확인.

## 검증 한계(은닉 금지 대상)
- 실카메라(192.168.0.153) 네이티브 경로는 장비 미선택 상태라 **라이브 검증 불가** → 유닛(모킹)까지만.
