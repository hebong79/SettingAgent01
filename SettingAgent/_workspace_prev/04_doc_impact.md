# 04 · 문서화·영향도 요약 — LLM 비전 차량 바닥 ROI(floor ROI · 4점 사변형)

작성: 문서화(documenter) · 2026-06-29 23:56:26 · 입력: `01_architect_plan.md`·`02_developer_changes.md`·`03_qa_report.md`(PASS) + 실제 변경 소스 확인.

## 생성 문서
- 구현/사용: `SettingAgent/docs/20260629_235626_차량바닥ROI_LLM비전_floorRoi.md`
- 영향도 분석: `SettingAgent/docs/20260629_235626_차량바닥ROI_영향도분석.md`
- README 가산: `SettingAgent/README.md`(floor ROI 1~2줄 — 설정·산출물·표시).

## 변경 요지
LLM(`gemma4:12b`) 비전이 프리셋 이미지+차량 bbox 로 **지면 접지 4모서리(원근 footprint)** 를 추론 → `ParkingSlot.floorRoiByPreset?`(NormalizedQuad, `[앞왼,앞오,뒤오,뒤왼]`) 가산. 정밀수집 체크포인트마다 `FloorRoiReviewer` 가 `recognizeFloorRoi`(기존 image_url 경로 재사용)→`resolveFloorQuad`(검증·클램프·순서정규화·폴백)→`floor_roi` 테이블 upsert, `Finalizer` 가 산출물에 포함. 뷰어가 연두(#39ff14) 폴리곤으로 표시.

## 영향도 핵심 결론
- **전 구간 가산·옵셔널** → 기존 계약·경로·테스트 회귀 0. **278/278 통과**(기존 248 회귀 0, 신규 30).
- `@parkagent/types` 가산(`NormalizedPoint`/`NormalizedQuad`/`floorRoiByPreset?`) → **Action/DM 런타임 무영향**(옵셔널·미소비, 타입 인지만). types 는 소스-소비 패키지(`npx tsc --noEmit` 통과).
- LLM **좌표 생성** 위험은 결정형 검증·폴백(`floorRoi.ts` 순수함수)으로 격리 → floor ROI 항상 유효·존재. **신규 HTTP 0**(기존 멀티모달 재사용).
- 저장: 신규 테이블 `floor_roi`(멱등·집계와 수명주기 분리, 마이그레이션 불필요). 비용: `maxPerCheckpoint`(12) 상한.
- 계약 불변: `roiByPreset`/`plateRoiByPreset`·`/setup`·`/capture`·`/mapping` 무영향.

## 미검증(사실대로)
- 실 `gemma4:12b` 좌표 정확도(접지면 vs 차체 윤곽)·라이브 `/capture` 실연동·canvas 실픽셀 렌더링 — **미수행**. 폴백·순서강제가 안전망. **마스터 라이브 수집 후 뷰어 폴리곤(#39ff14) 육안 검증 권장.**
- Action/DM 독립 빌드 그린 — **확인 필요**(옵셔널 가산이라 타입상 안전).

## 판정
설계(01)·구현(02)·검증(03)·문서화(04) 파이프라인 완료. 문서화·영향도 분석 종료. 잔여는 실 LLM 육안 검증 1건.
