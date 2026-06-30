# 04 문서·영향도 요약 — PTZ 캘리브레이션 → `slot_ptz.json`

작성: 문서화(documenter) · 근거: 01/02/03 산출물 + 실제 변경 코드 + `git diff --stat` 실측.

## 생성 문서
- 구현/사용: `SettingAgent/docs/20260630_225107_PTZ캘리브레이션_slot_ptz.md`
- 영향도: `SettingAgent/docs/20260630_225107_PTZ캘리브레이션_영향도분석.md`
- README 가산: `/calibrate` 라우트 1행 + `slot_ptz.json` 산출물 1행 + 문서 링크.

## 영향도 핵심 결론
- **전부 가산(95 삽입 / 0 삭제, 신규 calibrate 모듈 + 라우트 + web/config/test)**, 삭제·리팩토링 없음.
- **계약 불변**: setup_artifact 읽기 전용(`saveArtifact` 미호출)·`@parkagent/types` 무변경·기존 라우트(`/setup`·`/capture`·`/mapping`·뷰어) 불변. `slot_ptz.json` 은 별도 파일.
- `/calibrate/*` 는 `calibrator && calibrate` 주입 시에만 등록 → 미주입 시 기존 경로 무영향(QA 검증).
- 신규 타입은 SettingAgent 로컬. ActionAgent 소비 계약 확정 시 `@parkagent/types` 승격은 후속(미해결 A).
- **회귀 0**: 372/372 통과, 기존 331 회귀 0, tsc 무오류.

## 검증 결과 (실측 인용)
- `npm test` 55 파일 / 372 통과(신규 41: controlMath 16·slotPtzWriter 4·ptzCalibrator 10·calibrateRoutes 8·agentRuntimeCentering 3 + config +1).
- ★명령값 추적·순서(중심→줌)·하이브리드/폴백·잡/라우트(409/400/404)·계약 불변 전부 통과. 재작업 불요.

## 미검증 (라이브 의존 — 후속 스모크)
시뮬 실측 게인 · gemma 자문 신뢰도 · 실 PTZ 단위 · 브라우저 UI 동작. (모킹은 규약·수렴·계약만 검증.)

## 분리(무관 변경)
`captureRoutes.ts`(+24/−4)·`captureLiveRefresh.test.ts` 는 정밀수집 라이브 프리셋 갱신 기능으로 본 작업과 무관(calibrate 미참조). `data/setup_artifact.json`·`observations.sqlite*` 는 이전 capture 산출물.
