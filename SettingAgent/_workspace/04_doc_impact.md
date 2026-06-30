# 04 문서화·영향도 요약 — 주차면(ROI) 편집 + 전역 인덱스 수동 매핑 + 표시 제어

작성: 2026-06-30 11:27:04 · 문서화/영향도 분석가(documenter) · 파이프라인 마지막 단계
입력: `01_architect_plan.md`(설계) · `02_developer_changes.md`(구현) · `03_qa_report.md`(검증, PASS)

## 생성 문서 (SettingAgent/docs/)
- 구현/사용: `20260630_112704_주차면편집_수동인덱스_표시제어.md`
- 영향도 분석: `20260630_112704_주차면편집_영향도분석.md`
- README 가산: `SettingAgent/README.md`(REST 표에 PUT /mapping 1행, 산출물절에 편집/수동인덱스 1줄)

## 기능 요약(7)
#1 슬롯 선택(캔버스/목록, 하이라이트) · #2 삭제(+globalIndex/coveredSlotIds 재구성) · #3 크기조정(4모서리, 0~1 클램프) ·
#4 프리셋3 미표시 수정(전환 시 drawRoiOverlay 호출 추가)+진단(diffArtifactVsCameras 경고) ·
#5 표시 초기화(roiHidden, 데이터 보존) · #6 정밀수집 시작 정리/최종화 복귀 · #7 전역 인덱스 수동 매핑(분석 탭 ▲▼ + 정합 검증).

## 영속화
`PUT /mapping`(+`/viewer/api/mapping`, 동일 핸들러). 게이트: ① zod SetupArtifactSchema → ② validateCoverage(기존 재사용) → ③ saveArtifact.
불일치/shape 위반 시 400 미저장(파일 보호). GET 불변. 명시적 "저장" 모델.

## 테스트(검증자 인용, 사실)
typecheck 0 / `npm test` 46 files · **315 passed**(기존 281 + 신규 34, 회귀 0) / 신규 34 = roiEdit 22 + manualIndex 7 + mappingPut 5. 발견 결함 0.

## 영향도 핵심 결론
- **Action/DM 무영향**: SetupArtifact 계약·shape 불변 → 같은 형식 산출물 갱신.
- **REST 계약**: 쓰기 1개(PUT) 가산뿐. GET·/setup·/capture·/brain·/health·뷰어 카메라 라우트 불변.
- **@parkagent/types·GlobalIndexer·Repository·Finalizer·domain/types 불변**(재사용만).
- **산출물 일관성**: PUT 의 validateCoverage 게이트가 정합 불일치 400 미저장으로 보장.
- **직전분 보존**: floor 채움·roiHidden·표시초기화 가드 유지.

## 잔여/미검증(미검증은 미검증으로 명시)
- 브라우저 캔버스 상호작용(클릭 선택·핸들 드래그·▲▼ 재정렬): vitest 비대상 → 라이브 수동 검증 권장.
- #4 라이브: `/cameras` 프리셋3 실노출 실측 필요. 노출되는데도 미표시면 리더 에스컬레이션.
- 편집 중 finalize 동시성: 1차 보류(저장 시 재로드로 단순 처리). floor 사변형 편집: 1차 미지원.
