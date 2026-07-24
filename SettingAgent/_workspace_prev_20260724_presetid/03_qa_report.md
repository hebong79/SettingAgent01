# 03 QA 검증 리포트 — 전역번호 재번호(A안) 적대적 검증

작성: 검증자(qa-tester) / 대상: `01_architect_plan.md` + `02_developer_changes.md` 구현물.
작업 위치 = WT(`.claude/worktrees/analyze-fill-check`). 모든 경로 WT 절대경로.

---

## 0. 총평

**구현은 적대적 검증을 통과했다.** 개발자 테스트 22개가 실제로 green 이며, 추가로 작성한 적대 테스트 12개(원자성·바이트보존·순열다양성·FK가드·경계면 교차정합·slot_ptz 방어)도 전부 green. **데이터 파괴·원자성 위반·경계면 불일치 결함 없음.** 아래 §5에 설계상 트레이드오프 1건(마스터 기승인)을 한계로 명시.

- 전량 vitest: **220 files / 2593 tests 전부 green** (개발자 기준 219/2581 → 적대 테스트 파일 +1 / +12).
- `npm run typecheck`(tsc --noEmit): **0 에러**.

---

## 1. 실행한 검증

### 1-A. 개발자 테스트 재실행(실측 green)
| 파일 | 테스트 수 | 결과 |
|------|:---:|:---:|
| `test/renumberMapping.test.ts` | 8 | ✅ |
| `test/sqliteStore.renumber.test.ts` | 5 | ✅ |
| `test/slotPtzRenumber.test.ts` | 5 | ✅ (파싱실패 케이스의 SyntaxError 콘솔로그 = best-effort 격리 증거) |
| `test/renumberRoute.test.ts` | 4 | ✅ |

### 1-B. 신규 적대 테스트 — `test/renumber.adversarial.test.ts` (12, 전부 green)
과제의 적대 항목별 대응:

| # | 적대 항목 | 추가 테스트 | 결과 |
|---|-----------|-------------|:---:|
| A | **원시 바이트 보존** | 직접 INSERT 로 round5 를 안 거친 `pan=12.3456789`(7소수)·`tilt`·`zoom`·vpd/lpd/occupy/front TEXT·`updated_at='ORIG-TS'` 주입 → 재번호 후 raw SELECT 로 **전부 바이트 동일**(round5 재적용 X, updated_at 덮어쓰기 X) 실증 | ✅ |
| B | **순열 다양성** | 항등(변화없음)·완전역순 `{1→3,2→2,3→1}`·3-사이클 `{1→2,2→3,3→1}` → PK 충돌 없이 정확 이동, 물리슬롯 데이터(img1) 라벨만 이동 | ✅ |
| C | **FK 방어(parking_slot)** | 개발자는 parking_evnt 만 검증 → **parking_slot 참조행 주입** 케이스 추가, `/not empty/` throw + DB 무변경 | ✅ |
| D | **비순열 원자성** | new범위밖·new중복·old중복(누락)·old존재안함·개수불일치 **5케이스** 각각 라우트 통합으로 400 + **DB slot_id 불변 + slot_ptz.json 바이트 불변 + setup_result.json 미생성 + setup_artifact 미저장** 동시 실증(검증 전 DB/파일 무접촉) | ✅ |
| E | **경계면 3파일 교차정합** | 순열 `{1→3,2→1,3→2}` 후 **DB↔setup_result↔setup_artifact↔slot_ptz** 를 `presetIdx`(물리슬롯) 조인으로 대조. 각 소스에서 `globalIdx===Number(slotId)` 불변식 + 4소스 전역ID 완전 일치 + slot_ptz new asc 정렬 + plateWidth 물리고정 검증 | ✅ |
| F | **slot_ptz remap 방어** | 유효 JSON 이나 `items` 가 배열 아님 → `'skipped'` + 파일 원본 바이트 불변 | ✅ |

---

## 2. 데이터 보존 실증(요건 핵심)

- `renumberSlotIds` 는 원시 SELECT → 트랜잭션 DELETE+re-INSERT. **slot_id 만 remap, 나머지 14컬럼 원시값 그대로.**
- ★ **round5 재적용 없음**을 non-round5 값(7소수 pan)으로 직접 증명 — 개발자 테스트는 replaceSlotSetup 경유(이미 round5된 값)라 이 경로가 약했는데, 적대 테스트가 raw INSERT 로 보강.
- ★ `updated_at` 덮어쓰기 없음 실증(`'ORIG-TS'` 그대로).
- lpd/occupy/vpd/slot3d_front_center/slot_roi TEXT 바이트 동일.

## 3. 원자성 실증(요건 #5)

- 검증(`validateRenumberMapping`)이 DB 접촉 **전** 게이트. 5종 비순열 전부 400 + slot_setup 한 행도 안 바뀜 + 파일 전파 자체가 없음(slot_ptz 바이트 불변·setup_result 미생성·artifact 미저장). "검증 전 DB 안 건드림" 규약 실증.
- DB 재번호는 단일 트랜잭션(better-sqlite3 자동 롤백) — idMap 미커버/new중복/FK참조행 시 throw & 무변경 실증.

## 4. 경계면 교차 비교(핵심)

소비측 shape 확인:
- `buildArtifactFromSlotSetup`(artifactFromSlotSetup.ts:53): `globalIndex[].globalIdx = v.slotId`, `slotId = String(v.slotId)` → **globalIdx == Number(slotId)** 불변식.
- `buildSetupResult`(setupResult.ts:37): `slots[].slotId = s.slotId`(= DB slot_id = new).
- `remapSlotPtz`: `items[].slotId=String(new)`, `globalIdx=new`.

→ 재번호 후 3파일 + DB 를 `presetIdx`(물리슬롯 불변 키)로 조인했을 때 전역ID가 4소스 모두 동일함을 §1-B E 로 실증. **경계면 불일치 없음.**

---

## 5. 발견 사항 / 한계 (결함 아님 — 판단·기록용)

### 5-1. (한계·설계승인) setup_artifact.json ROI 표현 = bbox 고정
- `buildArtifactFromSlotSetup` 은 `roiByPreset` 을 `bboxOf(slot_roi)`(축정렬 사각형)로 산출. 재번호 시 `repo.saveArtifact` 가 setup_artifact.json 을 DB-파생본으로 덮어쓴다.
- **단, 이는 신규 손실이 아니다:** `SetupArtifact.slots[].roiByPreset` 타입 자체가 `NormalizedRect`(사각형)이며, GET /mapping DB 폴백도 동일 표현. **폴리곤 정본은 DB `slot_roi` 와 setup_result.json `floor_roi` 에 보존**(재번호가 이 둘의 폴리곤 바이트 보존 실증됨). plateRoi(quad)도 DB lpd 에서 그대로 전파.
- 설계서 §5 결정 C = 마스터 기승인 트레이드오프. **재확인만 필요, 조치 불필요.**

### 5-2. (가정·안전장치 병존) FK 가드 = 하드 throw
- parking_evnt/parking_slot 에 행이 있으면 재번호 전면 차단(throw). 현행 writer 미작성 → 항상 비어 있음(설계 가정 A). 방어 카운트가 실제 동작함을 A·C 로 실증. 향후 이 테이블 writer 도입 시 재번호는 cascade 전략 재설계 필요(현재 범위 밖).

### 5-3. 스모크(라이브 REST) 미수행 — 해당 없음
- 이 기능은 외부 서비스(VPD/LPD/Unity) 연동이 아니라 순수 DB 트랜잭션 + 파일 IO. 라우트 통합(fastify inject)으로 전 경로 실증 완료 → 별도 스모크 불요.

---

## 6. 회귀

- 전량 `npx vitest run`: **220 files / 2593 tests green**. 기존 라우트(PUT /mapping·finalize·autoChain·calibrate·viewerPtzSyncCoverage 봉인) 회귀 0.
- `npm run typecheck`: **0 에러**.
- 프론트 `saveManualIndex`(app.js:3304)·커버리지 분류(viewerPtzSyncCoverage.test.ts:74) 설계대로 반영 확인.

---

## 7. 산출물

- 신규 테스트: `WT\SettingAgent\test\renumber.adversarial.test.ts` (12 tests).
- 본 리포트: `WT\SettingAgent\_workspace\03_qa_report.md`.

**결론: 구현 결함 없음. developer 재호출 불필요. documenter 진행 가능.** (§5 한계 2건은 설계 승인·가정으로 기록만.)
