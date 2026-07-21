# 00 GOAL — 정밀수집 센터라이징 슬롯순서·중복제거·최종저장 수정

> B-mode(goal/loop). 리더 근본원인 분석 확정본(slot_ptz.json 실증 기반). 팀은 이 goal 을 불변 제약으로 유지한다.

## Goal (관찰 가능한 성공기준)
1. **슬롯 번호 순서대로 진행**: 센터라이징이 `카메라 asc → 프리셋 asc → 주차면(slot) asc` 순으로 각 슬롯의
   LPD Box 로 이동한 뒤 센터링한다. 진행 로그/status.current 가 이 순서로 단조 증가한다.
2. **각 주차면 1회씩**: 동일 물리 번호판을 두 슬롯이 중복 센터링하지 않는다. 결과 items 에서 서로 다른 slotId 가
   (거의) 동일 PTZ 로 수렴하는 중복이 사라진다. 다른 주차면 건너뛰기(=대상인데 미처리) 없음.
3. **최종 결과 저장(3중)**:
   - (a) **`save/Setup_YYYYMMDD_HHMMSS.json`** — Master 신규 요구. 센터링 반영된 최종 산출.
   - (b) DB **`slot_setup`** 의 pan/tilt/zoom/centered — 처리된 슬롯 저장(현재 converged 만 저장 → 개선).
   - (c) 기존 `data/slot_ptz.json` 유지(회귀 0).

## 확정 근본원인 (slot_ptz.json 17항목 실증)
- **R1 중복/건너뛰기**: `PtzCalibrator.startPtzFor` 가 슬롯마다 **프리셋 공유 PTZ** 를 시작점으로 반환 →
  PlatePtz 가 `pickNearestPlate` 로 대상 선정 → 인접 슬롯이 **같은 번호판에 latch**.
  증거: slot1·2 PTZ 7.80/10.72 동일(둘 다 plate_lost), slot3·4 PTZ 24.52/9.97 동일(둘 다 converged).
  → 슬롯별 **LPD Box 중심으로 선조준(coarse pre-aim)** 후 미세 센터링이 필요.
- **R2 DB 미저장**: `saveCenteringSlots` 가 `it.centered && it.converged` 행만 upsert → 미수렴 슬롯 누락.
- **R3 최종파일 미저장**: 센터링 결과가 `save/` 스냅샷(SaveStore)으로 저장되지 않음. finalize 의 `result_*.json`
  은 센터링 前 setup_artifact 라 PTZ 미반영.

## 제약(불변 · Requirements)
- VPD 자동검출 금지 유지(R1 정책). 결정론 유지(LLM 무). 부분 UPDATE 원칙(slot_setup wipe 금지).
- 영속화 수치 소수점 최대 5자리(stringify5/round5).
- 외과적 최소 변경 — 탐색/기하 코어(PlatePtz 폐루프 수식, Finalizer, discovery) 무접촉 지향.
- 양 진입점(수동 `/calibrate/ptz` · auto-chain SetupPipeline) 모두 수정 반영.

## 검증 한계(은닉 금지)
- **시뮬레이터 13100 DOWN** → 라이브 PTZ 물리 수렴은 이번엔 검증 불가. 결정형(순서·선조준 타깃 산출·저장 3중)은
  vitest + 라우트/데이터 실측으로 확정하고, 라이브 카메라 수렴은 **한계로 명시**(위장 성공 금지).
