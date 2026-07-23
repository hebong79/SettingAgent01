# 04 영향도 요약 — 전역번호 재번호(A안)

작성: documenter / 2026-07-23 20:40:07 (KST) / WT: analyze-fill-check
최종 문서: `SettingAgent/docs/20260723_204007_전역번호재번호_A안.md`

---

## 1. 건드린 모듈 (변경 그래프)

**신규(추가만, 기존 파일 무변경):**
- `src/setup/renumberMapping.ts` — `validateRenumberMapping` (순수 검증)
- `src/calibrate/slotPtzRenumber.ts` — `remapSlotPtz`(순수) / `renumberSlotPtzFile`(best-effort IO)
- 테스트 5개: `test/renumberMapping.test.ts`, `test/sqliteStore.renumber.test.ts`, `test/slotPtzRenumber.test.ts`, `test/renumberRoute.test.ts`, `test/renumber.adversarial.test.ts`

**수정(외과적, 메서드/라우트/함수 본문 단위 추가·교체):**
- `src/capture/SqliteStore.ts` — `renumberSlotIds` 메서드 1개 추가. 기존 메서드(`replaceSlotSetup` 포함) 무변경.
- `src/api/server.ts` — import 4종(`validateRenumberMapping`, `renumberSlotPtzFile`, `writeSetupResultFiles`, `logger`) + `RenumberBodySchema` + closure `renumberHandler` + 라우트 2개(`POST /mapping/renumber`, `POST /viewer/api/mapping/renumber`) 추가. 기존 라우트(`PUT /mapping` 등) 본문 무변경.
- `web/app.js` — `saveManualIndex()` 함수 본문만 교체(호출부 `$('an-manual-save').addEventListener` 등 불변).
- `test/viewerPtzSyncCoverage.test.ts` — NO_MOVE 라우트 분류 표에 `/mapping/renumber` 1행 추가(커버리지 봉인 테스트가 미분류 신규 라우트를 강제하므로 필수 변경).

**참고(이 작업과 무관, WT에 이미 존재하던 선행 변경 — 혼동 방지용 명시):**
- `src/setup/artifactFromSlotSetup.ts`(`buildArtifactFromSlotSetup`)는 이번 작업의 신규 산출물이 아니라 **이전 작업(분석 페이지 DB 즉석생성, `docs/20260723_174313_...`)에서 이미 만들어진 함수**를 재사용한 것이다. 본 작업은 이 함수를 import해 setup_artifact 재빌드에 쓸 뿐 수정하지 않았다.
- `test/precisePreciseProgress.test.ts`(1줄 변경)는 git status상 이 WT의 별도 선행 변경으로 보이며, 본 작업의 변경 범위에 포함되지 않는다.

---

## 2. slot_id 참조처 전파 정합

| 참조처 | 재번호 처리 | 정합 확인 |
|---|---|---|
| DB `slot_setup.slot_id`(PK) | `renumberSlotIds` 트랜잭션 DELETE+re-INSERT, 전 14컬럼 원시 보존, slot_id만 new | QA §1-B A: 7소수 미round5 값·TEXT 컬럼·`updated_at` 바이트 동일 실증 |
| DB `parking_evnt.slot_id`(FK, 스키마만) | 참조 안 함 — 재번호는 이 테이블이 **비어 있음**을 사전 확인 후에만 진행(행 있으면 throw) | QA §1-B C: `parking_evnt`/`parking_slot` 각각 참조행 주입 시 throw+DB무변경 실증 |
| DB `parking_slot.slot_id`(FK, 스키마만) | 상동 | 상동 |
| `setup_result.json` `slots[].slotId` | DB 재번호 후 `writeSetupResultFiles(getSlotSetup(), saveStore)` 재생성 → `buildSetupResult`가 `s.slotId`(=new) 사용 | QA §1-B E: DB↔setup_result 전역ID 일치(presetIdx 조인) |
| `slot_ptz.json` `items[].slotId`/`globalIdx` | DB로 재생성 불가(plateWidth/converged가 DB에 없음) → 기존 파일을 읽어 `remapSlotPtz`로 old→new만 리맵 후 rewrite | QA §1-B E,F: plateWidth 물리고정 유지, new asc 정렬, 미커버 무변, 비배열 items skip |
| `setup_artifact.json` `globalIndex[].globalIdx`/`slotId`, `slots[].slotId` | DB 재번호 후 `buildArtifactFromSlotSetup(getSlotSetup())`으로 전체 재빌드·저장 | QA §1-B E: globalIdx===Number(slotId) 불변식 + 4소스 일치 |
| 클라이언트 `web/app.js` (분석 탭 표/주차면 목록) | `saveManualIndex`가 서버 응답 성공 시 `loadMapping→renderAnalysis→renderSlotList` 순으로 재조회·재렌더 | 코드 확인(직접 Read) — 순서 준수, `renderAnalysis`는 내부에서 `fetchArtifact()`로 재조회하므로 `lastArtifact` 자동 갱신 |

결론: **4개 소스(DB·setup_result.json·slot_ptz.json·setup_artifact.json) + 클라이언트 표시가 단일 트랜잭션(DB) + 순차 best-effort(파일 3종) + 재렌더(클라)로 정합됨**을 설계·구현·QA 3단계 모두에서 일관되게 확인.

---

## 3. 회귀 위험 · 불변식 (변경 없음 확인)

- **`PUT /mapping`(`saveMappingHandler`, 순수 artifact 편집 저장)**: 본문 무변경. `web/app.js`의 다른 소비자(ROI 편집 등, 예: 1360/2368 라인대)는 계속 이 경로를 사용 — 회귀 없음.
- **`finalize`, `autoChain`(정밀수집 자동체인)**: 무접촉. 이번 작업이 건드리는 것은 slot_id **라벨**뿐이며 finalize/autoChain의 부트스트랩·검출 로직에는 관여하지 않음.
- **직전 선행 fix(GET `/mapping` DB-fallback, `docs/20260723_174313_...`)**: `buildArtifactFromSlotSetup`을 import해 재사용할 뿐 그 함수 자체나 GET `/mapping`(`resolveMapping`) 로직은 무변경.
- **전량 vitest / typecheck**: QA 보고 기준 **220 files / 2593 tests green**, `tsc --noEmit` **0 에러** (개발자 자체 실행분 219 files / 2581 tests + QA 적대 테스트 1파일/12건 합산). documenter는 이 수치를 재실행하지 않고 QA 리포트를 그대로 인용한다.

---

## 4. 한계 (은닉 없이 명시)

1. **FK writer 미작성 가정 의존.** `parking_evnt`/`parking_slot`에 실제 writer가 없다는 전제(00_leader_context 가정 A) 위에서 재번호가 안전하다. 이 가정이 향후 깨지면(즉 두 테이블에 writer가 생기면) 현재의 "참조행 있으면 무조건 차단" 방어는 재번호 자체를 막아버리므로, 그 시점엔 cascade 갱신 전략 재설계가 **필요**하다(현재 범위 밖, 확인 필요 항목으로 남김).
2. **`setup_artifact.json`의 ROI 표현 = DB 파생 bbox로 정본 이동.** 재번호 시 `setup_artifact.json`은 DB 기준으로 전체 재빌드되므로, 이 파일에만 있던 수동 폴리곤 편집(있었다면)은 사각형(bbox)으로 대체된다. 새로운 손실은 아니다(기존 GET `/mapping` DB 폴백도 동일 표현이었음, `roiByPreset` 타입 자체가 `NormalizedRect`) — 폴리곤 정본은 DB `slot_roi`/`setup_result.json`의 `floor_roi`에 보존됨을 QA가 바이트 단위로 실증했다. 다만 "폴리곤 편집을 setup_artifact에 남기고 싶다"는 요건이 향후 생기면 별도 과제.
3. **실브라우저 육안 확인 미수행.** QA 검증은 fastify `inject` 라우트 통합 테스트로 전 경로(DB/파일 3종/원자성/경계면 정합)를 실증했으나, 실제 웹 UI에서 사용자가 표를 편집하고 저장 버튼을 누르는 육안 스모크는 이 라운드에서 수행되지 않았다.

---

## 5. 후속 제안 (간결)

- FK writer(`parking_evnt`/`parking_slot`) 도입이 로드맵에 있다면, 재번호 기능과의 상호작용(cascade UPDATE vs 차단 유지)을 그 작업의 설계 단계에서 미리 검토해두는 것을 권장.
- 실 브라우저 육안 스모크(표 편집→저장→분석 탭/주차면 목록 갱신 확인)를 다음 세션에서 짧게 수행하면 REST 계약 실증에 UI 왕복까지 더해져 완결성이 높아짐(선택 사항, 현재도 결함으로 보진 않음).

---

## 6. 최종 산출물 경로

- 상세 문서: `SettingAgent/docs/20260723_204007_전역번호재번호_A안.md`
- 본 영향도 요약: `SettingAgent/_workspace/04_doc_impact.md`
