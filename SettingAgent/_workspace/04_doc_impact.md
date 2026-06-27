# 04 · 문서화·영향도 요약 — SettingViewer → SettingAgent 재통합

작성: 2026-06-26 23:39:54 · documenter · 파이프라인 최종 단계(01 설계 + 02 구현 + 03 검증 통합)

---

## 생성 문서

| 문서 | 경로 |
|------|------|
| 통합 문서 | `SettingAgent/docs/20260626_233954_SettingViewer_SettingAgent_재통합.md` |
| 영향도 분석 | `SettingAgent/docs/20260626_233954_SettingViewer_재통합_영향도분석.md` |
| README 보정 | `SettingAgent/README.md`(REST 표에 `/viewer/*` + 설정에 `viewer` 가산) |

## 핵심 요약

- **무엇**: 분리됐던 SettingViewer(:13030)를 SettingAgent(:13020) 단일 프로세스로 재통합. `viewer.enabled` 토글로 헤드리스 보존. 신규 기능 없음(리팩토링).
- **왜**: 운영 마찰(2 포트·기동 순서) + 코드 중복(CameraClient·http·설정 복제) + 프록시 1홉(자기 HTTP 호출) 제거.
- **어떻게**: `src/viewer/*`(5)·`web/*`(5) 이식, CameraClient 에 `listCameras()` 가산, toolsConfig 에 `viewer`·`cameraSources` 흡수, buildServer 에 `app.register` 래핑 뷰어 블록(이중 가드). `/viewer/api/mapping` 은 repo 직접 읽기, capture 는 SPA 가 `/capture/*` 직접 호출(app.js 4줄).

## 테스트 결과(검증자 03 인용 — 사실)

- `npm run typecheck` → 오류 0.
- `npm test` → **36 파일 / 239 테스트 통과, 회귀 0**(통합 전 25 파일 → +11).
- inject(fastify.inject) 기반. 라이브 `listen()`·브라우저 E2E·실 PTZ 는 **미검증**.

## 영향도 결론

- **외부 무영향**: `@parkagent/types`·`/setup`·`/capture`·루트 `/mapping`·`/health` 전부 불변 → ActionAgent·DMAgent·MCP 도구·LLM 두뇌 영향 없음. 재배포 불요.
- **내부 가산만**: 옵셔널 dep(`viewer?`·`sources?`) + register 래핑으로 기존 buildServer 호출처·156 테스트 무변경.
- **중복 해소**: CameraClient/http/설정 단일화. `@fastify/static` SettingAgent 편입. 라이브 코드에 SettingViewer 잔존 참조 0.
- **운영**: 단일 프로세스·단일 포트(:13020)·단일 기동. 헤드리스=`viewer.enabled=false`.

## 확인 필요(미검증)

1. 라이브 기동(`npm start`) 후 `/viewer/` SPA 200·정적 서빙.
2. 브라우저 E2E(카메라/스냅샷/PTZ/프리셋이동/정밀수집/분석탭).
3. 실 PTZ(HNR-2036LA) CGI/PTZ 범위 실측 보정.
4. `SettingViewer/` 빈 폴더 — 점유 프로세스 종료 후 `Remove-Item -Recurse -Force` 1회(git 추적상 영향 없음).
