# 02 구현 변경노트 — 전역번호 재번호(A안)

작성: 구현자(developer) / 근거: `_workspace/01_architect_plan.md` 그대로 구현. 작업 위치 = WT(`.claude/worktrees/analyze-fill-check`).

---

## 신규 파일

### 1. `src/setup/renumberMapping.ts` (순수 검증 — §1)
- `validateRenumberMapping(currentIds, mapping)` : old→new 순열 게이트. DOM/DB 무의존.
- 검사: N>0 · length===N · old집합===currentIds집합(중복/누락/추가 없음) · new 전부 정수 && 집합==={1..N}.
- 성공 시 `idMap`(old→new) 반환, 실패 시 `{ok:false, error(한글)}`. **검증 위치는 이 함수 한 곳**(라우트가 유일 소비자).

### 2. `src/calibrate/slotPtzRenumber.ts` (remap + 파일 IO — §3)
- `remapSlotPtz(artifact, idMap)` : 순수. `items[].slotId=String(new)`·`globalIdx=new` 리맵, plateWidth/converged/centered/ptz/camIdx/presetIdx/reason 보존, idMap 미커버 항목은 무변, **new globalIdx asc 재정렬**, createdAt 원본 유지.
- `renumberSlotPtzFile(outFile, idMap)` : best-effort. 파일 부재/파싱실패 → `'skipped'`(예외 삼킴·로그만), 성공 → `'written'`(기존 `writeSlotPtz` 재사용 = stringify5·mkdir). **DB 로 재생성 금지**(plateWidth/converged 는 DB 에 없음).

### 3. 테스트 4종 (`.test.ts` — 설계서는 `.spec.ts` 명명이나 vitest include 가 `test/**/*.test.ts` 라 관례 준수)
- `test/renumberMapping.test.ts` (8) — 정상/항등/빈배열/length/old누락/old중복/new중복/new≠1..N.
- `test/sqliteStore.renumber.test.ts` (5) — 순열 swap 전 컬럼 보존·updated_at 불변, round5 무재적용, idMap미커버 throw+무변경, new중복 throw+무변경, parking_evnt 참조행 throw+무변경.
- `test/slotPtzRenumber.test.ts` (5) — remap 리맵/보존/asc·미커버 무변, 파일 왕복·부재 skip·파싱실패 skip.
- `test/renumberRoute.test.ts` (4) — 200 정상전파(DB/setup_result/setup_artifact/slot_ptz)·400 비순열 DB무변경·zod 400·뷰어 경로.

---

## 수정 파일 (외과적)

### `src/capture/SqliteStore.ts` — `renumberSlotIds(idMap)` 메서드 추가 (§2)
- `replaceSlotSetup` 패턴 복제. **원시 SELECT**(파싱·round5·updated_at 재작성 안 함) → 단일 트랜잭션 `DELETE`+`re-INSERT`, `slot_id`만 remap, 전 15컬럼 보존.
- 방어: (a) parking_evnt/parking_slot COUNT>0 → throw(FK 보호), (b) 모든 행 slot_id 가 idMap 에 있어야 함, (c) new id 고유(PK 충돌 예방). 예외 시 트랜잭션 자동 롤백. 반환 `{changed}`.
- 기존 메서드 전부 무변경.

### `src/api/server.ts` — 라우트 2개 + closure 핸들러 (§6)
- import 4종 추가: `validateRenumberMapping`·`renumberSlotPtzFile`·`writeSetupResultFiles`·`logger`.
- `RenumberBodySchema`(zod) 추가.
- `buildServer` 내부 closure `renumberHandler(body, reply)` : sqlite 미주입 501 → zod 400 → **검증 실패 400(DB 무변경)** → DB 재번호(throw 500) → slot_ptz(calibrate.outFile 있을 때) → setup_result(saveStore 있을 때) → setup_artifact(`repo.saveArtifact(buildArtifactFromSlotSetup(getSlotSetup()))`). 파일 3종은 각 격리 best-effort. 응답 `{ok, renumbered, slotPtz, setupResult, artifactSaved}`.
- 라우트 `POST /mapping/renumber`(헤드리스) + `POST /viewer/api/mapping/renumber`(뷰어 register 블록) — 동일 closure 공유.

### `web/app.js` — `saveManualIndex()` 본문 교체 (§7)
- `PUT /mapping`(artifact 통째) → `POST /mapping/renumber`(mapping 배열). `applyManualGlobalIds` 클라 검증 게이트 유지, `res.artifact.globalIndex` 에서 `{oldSlotId:Number(g.slotId), newSlotId:g.globalIdx}` 파생 전송. 성공 시 `loadMapping`+`renderAnalysis`+`renderSlotList` 재렌더. 다른 함수·PUT /mapping 경로 불변.

### `test/viewerPtzSyncCoverage.test.ts` — 라우트 분류 1줄 추가
- app.js 신규 fetch `/mapping/renumber` 를 NO_MOVE 표에 등재(DB·파일 IO, 카메라 미이동). 커버리지 봉인 테스트가 미분류 라우트를 강제하므로 필수.

---

## 계획 대비 차이
- **테스트 확장자만 `.spec.ts`→`.test.ts`** 로 조정(vitest `include: test/**/*.test.ts`). 그 외 파일경로·시그니처·의사코드·처리순서 전부 계획서대로.
- 결정 C(setup_artifact = DB 재빌드): 계획대로 채택. setup_artifact.json 에만 있던 수동 ROI 폴리곤 편집이 있다면 DB-파생 bbox 로 치환됨(현 데이터모델=DB 기하 정본에서 정합, 신규 손실 아님).

## 검증 결과
- 신규 22 테스트 전부 green(4 파일). slotPtz 파싱실패 케이스의 콘솔 SyntaxError 로그는 best-effort 격리 증거(정상).
- **전량 vitest: 219 files / 2581 tests 전부 green.**
- **`npm run typecheck`(tsc --noEmit): 0 에러.**
