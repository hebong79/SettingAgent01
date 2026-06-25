# 04_doc_impact — 문서화·영향도 요약 (documenter)

- 작성일: 2026-06-25 19:51:52
- 작성자: documenter
- 기준: `_workspace/01~03` + 실제 코드(SettingViewer/·SettingAgent/·루트 package.json)

---

## 1. 생성한 문서

| 문서 | 경로 |
|------|------|
| A. 분리 리팩토링 문서 | `SettingViewer/doc/20260625_195152_SettingViewer_독립서비스_분리.md` |
| B. 영향도 분석 | `SettingViewer/doc/20260625_195152_SettingViewer_분리_영향도분석.md` |

### A 요약 — 분리 리팩토링
- 배경: 뷰어가 SettingAgent 내부에 결합 → 독립 서비스화(생명주기·관심사 분리, 단일 출처 유지).
- Before/After: 브라우저→SettingViewer(:13030) 단일 출처. ROI(/mapping)는 SettingAgent(:13020) 프록시.
- 폴더 구조 + 신규/이동/복제/삭제 표. 독립성(CameraClient·http 복제, CapturedImage 로컬화, viewerConfig 발췌).
- `/mapping` 프록시 명세(200/404/502, app.js 1줄). 실행/운영(기동 순서·포트·config·npm).
- 테스트: SettingViewer 62 / SettingAgent 81, 회귀 0. 미커버 4영역 명시.

### B 요약 — 영향도
- SettingAgent: 제거(viewer/web/테스트/listCameras/toolsConfig/배선/@fastify/static), **/mapping 유지**, 셋업·SetupArtifact·81 테스트 무영향.
- 신규 운영: 2-프로세스, 기동 순서(SettingAgent 먼저), 포트 13030 비충돌.
- 중복 2벌(CameraClient/http) + 동기화 가이드. git 미초기화(이력 보존 불가).
- 다른 에이전트·@parkagent/types 무영향. 잔여: 실기기·실서버·통합구동·DOM·RTSP→WebRTC.

---

## 2. 이동 문서 4종 경로 점검 결과 (추가 점검)

`SettingViewer/doc/` 4개 문서 본문을 grep 점검:
- 플래그 토큰(`SettingAgent/src/viewer`, `SettingAgent/web`, `SettingAgent/docs/...설계서`, `localhost:13020/viewer`) → **0건**.
- 4개 문서 모두 "**SettingViewer(:13030)가 SPA+카메라 프록시 서빙, ROI 는 SettingAgent(:13020)/mapping 프록시**" 모델로 **이미 정정 완료** 상태.
- 잔존하는 `:13020` 참조는 전부 **SettingAgent 가 /mapping 을 제공하는 정상 서술**(프롬프트 지시대로 보존).

**보정 내역: 없음**(이동 단계에서 경로 보정이 이미 적용되어, 외과적 보정이 필요한 잔존 오류 미발견). 통과 위장이 아니라 실제 grep 결과 기반.

---

## 3. 분리 최종 영향도 결론

- **핵심 무영향**: SettingAgent CameraClient 시그니처 동결 + `/mapping` 유지 + @parkagent/types/SetupArtifact 불변 → 셋업 파이프라인·81 테스트 회귀 0.
- **파급 국한**: SettingAgent ↔ SettingViewer 두 서비스 경계에 한정. ActionAgent/DMAgent·공유 도메인 타입 전파 없음.
- **신규 운영 부담**: 2-프로세스 + 기동 순서(SettingAgent 먼저). 포트 충돌 없음(13030 신규).
- **관리 리스크 2건**: ① CameraClient/http 중복 2벌(동기화 원칙 필요) ② git 미초기화(이력 보존 불가, 저장소 초기화 시 재커밋 고려).
- **미검증 잔여**: 실기기(Hucoms)·Unity 실서버·두 서비스 통합구동·브라우저 DOM·RTSP→WebRTC(후속) — 전부 수동/E2E/후속 영역.
