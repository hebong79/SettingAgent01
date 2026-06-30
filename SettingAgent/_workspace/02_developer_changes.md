# 02 구현 변경 노트 — 주차면(ROI) 편집 + 전역 인덱스 수동 매핑 + 프리셋3 진단

작성: 구현자(developer) · 입력: `01_architect_plan.md` · 대상: SettingAgent(SettingViewer + 영속화 엔드포인트)
원칙: ParkSimMgr(ESM·1-based·정규화 0~1·외과적·단순함 우선), 계약 불변, 기존 281 테스트 회귀 0.

---

## 결과 요약

- **typecheck**: 통과(`npm run typecheck`, 에러 0).
- **test**: 315 통과 = 기존 281 + 신규 34 (회귀 0). `npm test` 46 파일.
- 계약(@parkagent/types, SetupArtifact shape)·GET 라우트·`/setup/*`·`/capture/*` 불변. 가산만.

---

## 단계별 변경

### 단계 1 — #4 진단·보강
- **순수 `diffArtifactVsCameras(artifact, cameras)`**(`web/core.js`): 산출물 presetKey 집합 ↔ 카메라 드롭다운 presetKey 집합 비교 → `{ artifactOnly, camerasOnly }`. `artifactOnly` = 산출물엔 있으나 드롭다운에 없어 **선택 불가(=미표시 원인)**.
- **분석 탭 경고 렌더**(`web/app.js renderAnalysis`): `artifactOnly` 각 키를 "산출물에는 있으나 카메라 드롭다운에 없음 → 검수 탭에서 선택 불가(미표시)" 경고로 표시.
- **검수 탭 빈 상태 안내**(`renderSlotList`): 현재 프리셋 key 에 슬롯 0개면 "이 프리셋에 주차면 없음 — 다른 프리셋 선택 또는 분석 탭 확인" 1줄.
- **버그 수정(핵심)**: `sel-preset`·`sel-cam` change 핸들러에 **`drawRoiOverlay()` 호출 추가**. 기존엔 프리셋/카메라 전환 시 `renderSlotList()`만 호출하고 오버레이를 다시 그리지 않아, 프리셋3 선택 후에도 ROI 오버레이가 갱신되지 않을 수 있었음. `state.roiHidden` 가드는 유지(초기화/수집 중 비표시 보존). 전환 시 `state.selectedSlotId=null`(선택 해제)도 추가.

### 단계 2 — #1 주차면 선택(히트테스트)
- **순수 함수**(`web/core.js`): `pointInRect(nx,ny,rect)`(경계 포함), `pointInQuad(nx,ny,quad)`(ray casting), `hitTestSlots({nx,ny,slots,key,layers})` → 차량 rect 우선·floor quad 차선, 배열 끝(상단)이 우선, `layers.vehicle/floor=false` 시 해당 레이어 히트 제외(현재 그리는 것과 정합).
- **app.js**: overlay `mousedown` → `eventToNorm`(오버레이 표시크기 기준, 히트테스트와 동일 분모) → `hitTestSlots` → `state.selectedSlotId`. 빈 곳 클릭 시 해제. 선택 슬롯은 `drawRoiOverlay`에서 굵은 대비색(빨강, lineWidth 4) 하이라이트 + 라벨. 슬롯 목록 클릭으로도 선택 가능(`.selected` 강조).

### 단계 3 — #2 선택 슬롯 삭제(영속화)
- **순수 함수**(`web/core.js`):
  - `rebuildGlobalIndex(slots, presets)`: **coveredSlotIds 배열 순서를 position 진실**로 사용(설계 §positionIdx). slotId 의 sN 파싱 금지. 정렬 camIdx→presetIdx→coveredSlotIds 내 위치, `globalIdx=i+1`. coveredSlotIds 에 없는 slot 은 안전망으로 뒤에 부여.
  - `removeSlot(artifact, slotId)`: slots·각 preset.coveredSlotIds 에서 제거 → `rebuildGlobalIndex` 재생성. createdAt 등 보존. 불변(새 artifact 반환).
- **app.js**: "삭제" 버튼(선택 시 활성) → `removeSlot` → `state.mapping` 갱신(미저장) → `markDirty`. "저장"으로 PUT.

### 단계 4 — #3 크기 조정(핸들 드래그)
- **순수 함수**(`web/core.js`): `clamp01Rect`(x,y∈[0,1], w,h≥0.001, x+w≤1, y+h≤1), `resizeRect(rect, handle, ndx, ndy)`(nw/ne/sw/se 모서리 이동 + 좌우/상하 뒤집힘 정규화 + clamp01Rect), `updateSlotRoi(artifact, slotId, key, rect)`(해당 slot roiByPreset[key]만 교체, slot 집합·globalIndex 불변).
- **app.js**: 선택 슬롯에 4모서리 핸들 렌더(`drawHandles`). overlay mousedown(핸들 히트 `hitTestHandle`) → window mousemove(정규화 델타 → `resizeRect` → `updateSlotRoi` 실시간 미리보기) → mouseup 확정 + `markDirty`.
- **floor 사변형 편집은 1차 범위 제외**(확정 C). 사각형 ROI 편집만.

### 단계 5 — 영속화 엔드포인트 `PUT /mapping`
- **`src/api/server.ts`**(가산):
  - zod `SetupArtifactSchema`(presets/slots/globalIndex/createdAt shape, warnings·report optional). NormalizedRect/Point/Quad·Preset·ParkingSlot·GlobalSlotIndex 스키마.
  - 공유 핸들러 `saveMappingHandler(repo, body, reply)`: ① zod 검증 실패 → 400 `{error:'invalid artifact', detail}` ② `validateCoverage(globalIndex, slots)`(기존 GlobalIndexer 재사용) 불일치 → 400 `{error:'coverage mismatch', missing, extra}`(미저장) ③ 통과 → `repo.saveArtifact` + `{ok:true, slots, globalCount}`.
  - 라우트: 헤드리스 `PUT /mapping`, 뷰어 블록 `PUT /viewer/api/mapping`(동일 핸들러). **GET /mapping·/viewer/api/mapping 불변**.
- **app.js `saveMapping()`**: `PUT /viewer/api/mapping` → 성공 시 `loadMapping()` 재로드·선택 해제·메시지, 실패 시 명시적 에러(coverage mismatch 누락/초과 표시, 네트워크 분기).

### 단계 6 — #7 전역 인덱스 수동 매핑
- **순수 함수**(`web/core.js`): `validateManualIndex(globalIndex)` → `{ok, duplicates, gaps}`(1..N 연속·중복), `reorderGlobalIndex(artifact, orderedSlotIds)` → 지정 순서로 globalIdx 1..N 재부여, slots 집합과 1:1(누락/초과/중복 입력) 검증 실패 시 `null`. camIdx/presetIdx 는 기존 globalIndex 보존.
- **분석 탭에 가산**(확정 A, 신규 탭 X): index.html "전역 인덱스 수동 매핑" 섹션(정합 상태 + 저장 버튼 + ▲▼ 재정렬 행). app.js `renderManualIndex`/`drawManualList`/`moveManual`/`saveManualIndex`(같은 PUT 재사용 → 저장 후 검수·분석 재동기화).

---

## PUT /mapping 명세

| 항목 | 값 |
|---|---|
| 경로 | `PUT /mapping`(헤드리스), `PUT /viewer/api/mapping`(뷰어). 동일 로직 |
| 본문 | 완전한 SetupArtifact JSON(`{presets, slots, globalIndex, createdAt, warnings?, report?}`) |
| 200 | `{ ok:true, slots, globalCount }` + `repo.saveArtifact` 1회 |
| 400(shape) | `{ error:'invalid artifact', detail }` — 미저장 |
| 400(정합) | `{ error:'coverage mismatch', missing, extra }` — 미저장(파일 보호) |
| 게이트 | `validateCoverage(globalIndex, slots)`(GlobalIndexer 재사용) |

---

## 순수 함수 목록(core.js — 전부 vitest 대상, DOM/fetch 미참조)

`diffArtifactVsCameras`, `pointInRect`, `pointInQuad`, `hitTestSlots`, `rebuildGlobalIndex`, `removeSlot`, `clamp01Rect`, `resizeRect`, `updateSlotRoi`, `validateManualIndex`, `reorderGlobalIndex`.
(타입 선언은 `web/core.d.ts` 가산 — `removeSlot/updateSlotRoi/reorderGlobalIndex` 는 제네릭 `T extends ArtifactLike` 로 입력 형태 보존.)

---

## #4 처리 결론

설계 결론(데이터·키매칭 정상, 원인은 "프리셋3 네비게이션 불가" 가설)을 그대로 반영했다.
- **진단**: `diffArtifactVsCameras` 로 산출물에만 있는 프리셋 키를 분석 탭 경고로 노출 + 검수 탭 빈 상태 안내.
- **버그 수정**: 프리셋/카메라 전환 시 `drawRoiOverlay()` 미호출 가능성을 수정(change 핸들러에 호출 추가). 이로써 프리셋3 선택 시 ROI 가 즉시 다시 그려진다.
- 라이브에서 `/cameras` 에 프리셋3가 실제 노출되는데도 미표시면 설계 가정이 틀린 것 → 리더 에스컬레이션(설계서 §리스크 5).

---

## 변경 파일 목록

| 파일 | 변경 |
|---|---|
| `web/core.js` | 순수 함수 11개 가산(#1~#4, #7) |
| `web/core.d.ts` | 신규 함수 타입 선언 + `ArtifactLike`/`SlotLike`/`PresetLike`/`GlobalSlotIndexEntry` |
| `web/app.js` | 선택·삭제·크기조정 결선, `saveMapping`, #7 UI, #4 drawRoiOverlay 수정, state.selectedSlotId |
| `web/index.html` | 검수 탭 편집 바(선택정보/삭제/저장/메시지), 분석 탭 수동 매핑 섹션 |
| `web/app.css` | 선택 슬롯·빈 상태·편집 바·수동 매핑 스타일(가산) |
| `src/api/server.ts` | `SetupArtifactSchema`(zod), `saveMappingHandler`, `PUT /mapping`·`PUT /viewer/api/mapping`(가산) |
| `test/roiEdit.test.ts` | 신규 — 히트테스트·resize·removeSlot·rebuildGlobalIndex·diff |
| `test/manualIndex.test.ts` | 신규 — validateManualIndex/reorderGlobalIndex |
| `test/mappingPut.test.ts` | 신규 — `app.inject` PUT 200/400(헤드리스·뷰어) |

불변(미수정): `src/setup/GlobalIndexer.ts`, `src/store/Repository.ts`, `packages/types`, `src/domain/types.ts`, GET 라우트.

---

## typecheck / test 결과

```
npm run typecheck  → 에러 0
npm test           → 46 files, 315 tests passed (기존 281 + 신규 34, 회귀 0)
```

---

## 미해결 / 실측 보정(검증자·문서화 인계)

- **브라우저 캔버스 상호작용은 수동 확인 필요**: 클릭 선택 하이라이트, 모서리 핸들 드래그 리사이즈, 삭제/저장 후 재로드, #7 ▲▼ 재정렬은 vitest 비대상(환경 의존). 순수 로직은 단위 테스트로 차단했으나 실제 마우스/캔버스 동작은 라이브 뷰어 수동 검증 권장.
- **#4 라이브 확인**: `/cameras` 응답에 프리셋3 노출 여부 실측은 라이브 필요. 미표시 재현 시 위 진단 경고로 1차 구분, 그래도 노출되는데 미표시면 리더 에스컬레이션.
- **동시성**: 편집 미저장 중 `/capture/finalize` 가 artifact 를 덮으면 편집 유실 가능(설계 §리스크 1). 1차는 저장 성공 시 `loadMapping` 재동기화로 단순 처리(finalize 잠금 미구현 — 과설계 보류).
- **저장 경로**: 명시적 "저장" 버튼 모델(확정 B). 자동저장 아님.
