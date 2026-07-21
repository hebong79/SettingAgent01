# 영향도 분석 — 결과 저장/열기: 서버 save/ → OS 네이티브 로컬 파일 대화상자

- 작성: 문서화·영향도 분석가(documenter)
- 작성 시각: 2026-07-03 23:06:32 (로컬)
- 상세 문서: `SettingAgent/docs/20260703_230632_결과저장열기_네이티브파일대화상자.md`
- 근거: `_workspace/01~03` + 실제 변경 소스 재확인

---

## 1. 영향 모듈 (직접 변경)

| 모듈 | 변경 | 파급 |
|------|------|------|
| `web/core.js` | 순수 export 2개 신규(`parseLoadedArtifact`/`defaultResultFilename`) | 순수 추가 — 기존 export 불변, 하위호환 유지 |
| `web/core.d.ts` | 위 2함수 선언 추가 | tsc 소비측(app.js는 JS라 직접 대상 아님, 타입만 제공) EXIT 0 |
| `web/app.js` | import 2 추가 / IO·렌더 헬퍼 3 추가 / `saveResult`·`openResult` 재작성 / `renderSaveList`·`openSaved`·`open-result-close` 배선 삭제 | 뷰어 저장/열기 흐름 전면 교체. 다른 핸들러·스트림 루프 무영향 |
| `web/index.html` | `#open-result-modal` 삭제 / 버튼 title 갱신 | 버튼 요소·배선 유지. 잔존 모달(`cap-result-modal`/`floor-llm-warn-modal`) 무관 |

**`web/app.css` 미변경(중요)**: 모달 마크업은 삭제했으나 `.modal`/`.modal-box` 클래스는 다른 모달(`cap-result-modal` 등)이 공용으로 사용한다. CSS 규칙을 건드리면 타 모달 회귀 위험 → 손대지 않음. `.save-item` 전용 규칙은 원래 없었으므로 CSS 변경 불필요.

---

## 2. 의존성 그래프 파급 추적

- **`core.js` → `app.js`**: `app.js`가 `parseLoadedArtifact`/`defaultResultFilename`를 신규 import하여 소비. 경계면 shape(`{ok/error/artifact}`, `string|null` 취소 규약)은 QA §4에서 소비측 가드와 정합 확인.
- **`core.js` → vitest**: 신규 순수함수가 `test/parseLoadedArtifact.test.ts`(7) + `test/parseLoadedArtifact.qa.test.ts`(16)로 커버. 기존 core 소비 테스트(analyzeArtifact/roiEdit 등) 무회귀.
- **`state.mapping`(SetupArtifact) 도메인 shape**: 불변. 저장은 동일 객체를 직렬화, 열기는 동일 shape을 주입 → 기존 렌더/편집 로직(`drawRoiOverlay`/`renderSlotList`/`renderSelectionInfo`) 그대로 재사용. 도메인 타입 파급 없음.
- **뷰어 → 서버 REST 계약**: `POST /capture/save`·`GET /capture/saves`·`GET /capture/saves/:name` 소비 제거. 서버는 소비자만 사라진 상태(계약 자체 무변경).

---

## 3. 서버측 미사용화 명시 (삭제 아님 — CLAUDE.md §3)

뷰어에서 더 이상 호출되지 않으나 **서버 코드·라우트는 그대로 유지**한다(요청받지 않은 서버 데드코드 제거 금지):

| 대상 | 상태 | 생존 근거 |
|------|------|-----------|
| `src/api/captureRoutes.ts` `POST /capture/save` | 뷰어 미사용화 | 라우트 잔존, 외부 호출 가능성 |
| `src/api/captureRoutes.ts` `GET /capture/saves` | 뷰어 미사용화 | 동상 |
| `src/api/captureRoutes.ts` `GET /capture/saves/:name` | 뷰어 미사용화 | 동상 |
| `src/store/SaveStore.ts` | **생존** | `Finalizer`의 finalize 자동 스냅샷이 계속 사용 → 삭제 불가 |
| `src/capture/Finalizer.ts` | 무변경 | SaveStore 자동저장 유지 |
| `src/api/artifactSchema.ts` | 무변경 | 서버 검증 스키마 유지 |
| `config/tools.config.json`(`store.saveDir`) | 무변경 | 자동 스냅샷 저장 경로 유지 |

즉 서버 자동 스냅샷(finalize→SaveStore)은 **그대로 동작**하고, 뷰어의 수동 저장/열기만 로컬 경로로 전환됐다.

---

## 4. 하위호환 / 사용자 인지사항

- **서버 save/ 기존 파일 접근성**: 이전에 서버 `save/`에 저장돼 있던 결과는 뷰어 '결과 열기'에서 **더 이상 목록으로 뜨지 않는다**(로컬 파일 방식 전환). 필요하면 해당 서버 파일을 직접 로컬로 내려받아 '결과 열기'로 여는 우회가 필요하다(사용자 인지사항).
- **파일 상호호환**: 로컬 저장 파일은 순수 `SetupArtifact` JSON → 서버 `save/*` 및 `data/setup_artifact.json`과 shape 호환. 서버 파일을 로컬로 받아 열면 동일 렌더.
- **브라우저 지원**: File System Access API(`showSaveFilePicker`)는 **Chromium(Chrome/Edge) + 보안 컨텍스트(https 또는 localhost)** 필요. dev는 localhost라 OK. 비지원 브라우저는 폴백(`<a download>`/`input[type=file]`)으로 자동 강등 — 기능 유지, UX만 차이.

---

## 5. 리스크 / 후속

- **비Chromium 저장 폴백 UX**: `<a download>`는 저장 폴더 지정 불가(브라우저 기본 다운로드 폴더), 파일명만 제안. 리더 확정 수용 사항이나 UX 차이 존재.
- **브라우저 육안 스모크 미수행(잔여)**: DOM·File System Access API 배선 7종(§상세 문서 6.1)은 vitest 밖 → **Chromium(localhost) 육안 스모크 필요, 현재 미수행**. 통과로 위장하지 않음. 자동화는 Playwright 등 e2e 필요(현 범위 밖).
- **확인 필요(단정 회피)**: `POST /capture/save` 등 3라우트를 뷰어 외 다른 소비자(외부 스크립트/타 에이전트)가 호출하는지는 이번 범위에서 확증하지 않음 → "서버 라우트 잔존"으로 보수적 유지.

---

## 6. 변경 파일 표

| 파일 | 구분 |
|------|------|
| `web/core.js` | 수정(순수함수 2 추가) |
| `web/core.d.ts` | 수정(선언 2 추가) |
| `web/app.js` | 수정(재작성+헬퍼 추가+고아 삭제) |
| `web/index.html` | 수정(모달 삭제+title 갱신) |
| `test/parseLoadedArtifact.test.ts` | 신규(7) |
| `test/parseLoadedArtifact.qa.test.ts` | 신규(16) |
| `web/app.css` | **미변경**(공용 .modal 회귀 회피) |
| `src/api/captureRoutes.ts` | **미변경**(3라우트 뷰어 미사용화, 잔존) |
| `src/store/SaveStore.ts` | **미변경**(finalize 자동저장 생존) |
| `src/capture/Finalizer.ts`, `src/api/artifactSchema.ts`, `config/tools.config.json` | **미변경** |

---

## 7. 검증 근거 (검증자 실측)

- `npx vitest run` → **76 files / 683 tests PASS**(신규 23=구현7+QA16, 회귀 0).
- `npx tsc -p tsconfig.json --noEmit` → **EXIT 0**.
- Q2 고아 제거: `web/` grep `renderSaveList`/`openSaved`/`open-result`/`save-item` **잔존 0건**(문서화 담당 재확인 동일).
- 미검증: 브라우저 DOM·File API 배선 7종 육안 스모크(미수행).
</content>
