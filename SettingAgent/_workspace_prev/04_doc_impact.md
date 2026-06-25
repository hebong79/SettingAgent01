# SettingViewer — 문서화·영향도 요약 (04_doc_impact)

- 작성일: 2026-06-25 18:28:19
- 작성자: documenter
- 파이프라인 마지막 단계(설계→구현→검증→문서화). 앞 단계 산출물 + 실제 코드 기반.

---

## 1. 생성 문서 (2개)

| 문서 | 경로 |
|------|------|
| 구현/사용 문서 | `SettingAgent/docs/20260625_182819_SettingViewer_구현문서.md` |
| 영향도 분석 | `SettingAgent/docs/20260625_182819_SettingViewer_영향도분석.md` |

### 구현문서 요약
- 무엇: SettingAgent(:13020)가 정적 SPA + 카메라 프록시를 단일 출처로 서빙하는 웹 뷰어. 범위 = 설계서 §10.1 1~10단계(11단계 WebRTC 제외).
- 아키텍처: 단일 출처 프록시, `CameraSource` 추상화(SimulatorSource/RealPtzSource), 프록시 라우트 5개.
- 파일별 책임·프록시 API 명세(403 등 에러코드)·명명규약·설정 가이드·실행법·실 PTZ 보정 항목·테스트 결과(138 통과) 수록.

### 영향도분석 요약
- 변경 파일 표(신규/수정·영향·리스크·완화).
- 기존 기능 보존: `CameraClient` 시그니처 불변(listCameras 가산), 셋업 파이프라인·SetupArtifact·`@parkagent/types` 무영향, ActionAgent/DMAgent 무관.
- 의존성 `@fastify/static@9.1.3`·조립부(index/server) 영향, 회귀(기존 81 그린), 잔여 리스크 7항.

---

## 2. 최종 영향도 결론

- **가산적·`/viewer` prefix 격리·옵셔널 기본값** — 기존 동작 경로(셋업·MCP·공유 타입·타 에이전트) 의미 변경 0.
- **공유 계약 무변경**: `@parkagent/types`(뷰어가 import 안 함)·`SetupArtifact`·기존 REST 라우트 → ActionAgent/DMAgent 파급 없음.
- **회귀 부재**: vitest 138 passed / 0 failed(기존 81 + 신규 57), 결함 0.
- **미검증 명시**: 실 PTZ 실기기(Hucoms CGI 가정값)·Unity 실서버 manual 모드·브라우저 DOM(jsdom 미도입)은 본 라운드 미커버 → 설계서 §10.1 12단계(동작확인) 대상.

---

## 3. 문서 외 최소 제안 (외과적 — 직접 대규모 수정 안 함)

1. **루트 `CLAUDE.md` 변경 이력 표**: SettingViewer 라운드를 한 줄 추가하면 추적성↑. (예: `| 2026-06-25 | SettingViewer 웹 뷰어(프록시/CameraSource/실 PTZ 어댑터) 추가 | SettingAgent | 셋업 산출물 시각 검수·카메라 제어 |`)
2. **`SettingAgent/README.md`**: "빠른 시작"에 `http://localhost:13020/viewer/` 접속 1줄, "설정" 표에 `viewer`/`cameraSources` 키 1~2줄 추가 제안. (현재 README 설정 키 목록에 viewer 미기재.)

> 위 2건은 **제안만**. 승인 시 최소 1~2줄 가산으로 반영. 미승인 시 본 docs 2종으로 충분.
</content>
