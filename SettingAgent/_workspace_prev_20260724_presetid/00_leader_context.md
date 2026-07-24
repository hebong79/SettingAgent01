# 00 리더 컨텍스트 — 전역번호 재번호(A안): 수동매핑 → DB slot_id + json 전파

## 목표(Goal, 마스터 확정 A안 2026-07-23)
분석 탭 "전역 인덱스 수동 매핑"에서 전역 ID(=슬롯번호)를 바꿔 [저장]하면:
1) DB slot_setup.slot_id 가 그 값으로 재번호되고(저장),
2) setup_result.json 에 반영되고(재생성),
3) slot_ptz.json / setup_artifact.json 도 함께 변경된다.
"매핑을 다시 하는 이유 = json 파일에 다시 저장하려는 것." 전역번호==slot_id 를 항상 결합.

## 현행 사실(리더 선조사 — 재파생 금지)
- 수동매핑 저장 현행: saveManualIndex(app.js:3304) → applyManualGlobalIds → PUT /mapping → saveMappingHandler(server.ts:48) → repo.saveArtifact = **setup_artifact.json 파일만**. DB·setup_result 무접촉. ← 이게 결함.
- setup_result.json: writeSetupResultFiles(setupResult.ts:68) ← buildSetupResult(DB slot_setup). slotId = s.slotId(=DB slot_id). 재생성 진입점 이미 있음: POST /capture/setup-result(captureRoutes.ts:614) = writeSetupResultFiles(deps.store.getSlotSetup(), saveStore).
- slot_ptz.json: items[]{camIdx,presetIdx,slotId(str),globalIdx(num),ptz,plateWidth,centered,converged}. slotId==globalIdx==slot_id. writeSlotPtz(slotPtzWriter.ts:80). **오직 센터라이징(PtzCalibrator)만 씀**. plateWidth/converged 는 DB slot_setup 에 없음 → DB로 완전재생성 불가 → **old→new 리맵**으로 items 의 slotId/globalIdx 만 갱신 후 rewrite 가 정답.
- setup_artifact.json: 내 이전 fix 로 GET /mapping 이 파일 없/빈slots 시 DB(getSlotSetup)에서 buildArtifactFromSlotSetup 조립. globalIdx=slot_id. → 재번호 후 DB 기준으로 자동 정합(파일 비우거나 재빌드).

## DB 스키마(SqliteStore.ts) 핵심
- slot_setup: slot_id INTEGER PRIMARY KEY, UNIQUE(cam_id,preset_id,preset_slotidx). 컬럼: slot_roi,vpd_bbox,lpd_obb,occupy_range,pan,tilt,zoom,centered,img1,slot3d_front_center,updated_at.
- FK 참조자: parking_evnt.slot_id, parking_slot.slot_id → REFERENCES slot_setup(slot_id). **둘 다 "스키마만"(writer 미작성) → 실제 비어 있음.** foreign_keys=ON.
- 기존 패턴: replaceSlotSetup(DELETE+INSERT 단일 트랜잭션, 전 컬럼). upsertSlotCentering/Lpd/FrontCenter(부분 UPDATE). → 재번호는 replaceSlotSetup 류 DELETE+INSERT 로 전 컬럼 보존 + slot_id 만 remap(permutation 충돌 회피).

## 매핑 의미
- 표 각 행 = 현재 slot_id(=전역ID). 사용자가 전역ID 입력을 바꾸면 old→new 순열(1..N 고유). 물리 슬롯(cam/preset/preset_slotidx + ROI/lpd/ptz)은 그대로, slot_id 라벨만 이동.
- applyManualGlobalIds 결과 artifact.globalIndex 로 old(slotId)→new(globalIdx) 순열을 추출 가능.

## 재번호 연쇄(설계 요지)
1. 검증: newId 집합이 1..N 고유·전 행 커버(누락/중복/범위 위반 400).
2. DB: SqliteStore.renumberSlotIds(Map<oldId,newId>) — 트랜잭션 DELETE+re-INSERT 전 컬럼 보존, slot_id 만 new. (parking_evnt/parking_slot 비었음 확인 or 방어).
3. slot_ptz.json: 파일 읽어 items[].slotId=String(new)·globalIdx=new 로 remap(순서는 new asc 재정렬 권장), rewrite(writeSlotPtz). 파일 부재면 skip(best-effort).
4. setup_result.json: writeSetupResultFiles(DB) 재생성(재번호된 slot_id 반영).
5. setup_artifact.json: DB 기준 재빌드 저장(buildArtifactFromSlotSetup) 또는 파일 재기록 → globalIdx=new=slot_id.
6. 신규 라우트 1개(예: POST /capture/renumber-slots {mapping}) 또는 PUT /mapping 확장. 프론트 saveManualIndex 가 이 라우트를 부르도록 전환. 성공 후 loadMapping+renderAnalysis+주차면목록 재렌더.

## 파괴/회귀 불변식
- 재번호는 전 컬럼 보존(데이터 파괴 금지 — finalize-wipe 메모 영역). 센터라이징 값(pan/tilt/zoom/centered/front_center) 보존.
- 기존 PUT /mapping(순수 artifact 편집 저장)·finalize·autoChain 무변경. 내 이전 DB-fallback fix 유지.
- 기존 vitest 전량 green + tsc 0.

## 작업 위치(엄수)
WT = d:\Work\Parking3D\AgentVLA\ParkAgent\.claude\worktrees\analyze-fill-check
모든 에이전트는 WT 절대경로로 읽기/쓰기. vitest 는 `cd "/d/Work/Parking3D/AgentVLA/ParkAgent/.claude/worktrees/analyze-fill-check/SettingAgent" && npx vitest run ...`. 메인 경로 금지.

## Requirements 체크리스트(마감 대조)
1. 전역ID 변경+저장 → DB slot_setup.slot_id 재번호(순열 안전·전 컬럼 보존) (unit)
2. setup_result.json slotId 재번호 반영 (unit)
3. slot_ptz.json items slotId/globalIdx old→new 리맵(plateWidth/converged 보존) (unit)
4. setup_artifact.json globalIdx=new slot_id 정합 (unit/route)
5. 검증: newId 1..N 고유·전행커버 아니면 400, DB 무변경 (unit)
6. 프론트: saveManualIndex 가 재번호 라우트 호출 → 성공 후 재렌더
7. 파괴/회귀 0: 센터링 보존, 기존 라우트 무변경, tsc 0·전량 green
