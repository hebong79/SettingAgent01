# 03 검증 리포트 — 주차면(ROI) 편집 + 전역 인덱스 수동 매핑 + 프리셋3 진단/수정

검증자(qa-tester) · 입력: `02_developer_changes.md`, `01_architect_plan.md`, 변경 소스 + 설계 §5/§6
판정: **통과(PASS) — 재작업 불필요.** 회귀 0, 신규 34 전부 통과, PUT 정합·#4·계약 검증 통과.

---

## 1. 전체 테스트 결과(수치 그대로)

| 항목 | 결과 |
|---|---|
| `node --check web/app.js web/core.js` | `NODE_CHECK_OK` (구문 오류 0) |
| `npm run typecheck` (tsc --noEmit) | 에러 0 |
| `npm test` | **46 files, 315 tests passed** (기존 281 + 신규 34, **회귀 0**) |
| 신규 3파일(`roiEdit`·`manualIndex`·`mappingPut`) 단독 | 3 files, **34 tests passed** |

신규 34 = roiEdit 22 + manualIndex 7(파일 표기) + mappingPut 5. (developer 노트의 "34" 수치 일치.)

---

## 2. 순수함수 정확성(core.js — 단위 테스트 + 추가 엣지 직접 검증)

기존 테스트(roiEdit/manualIndex)에 더해 **미커버 엣지 10건을 직접 실행**(전부 통과)하여 교차 확인:

- `pointInRect`/`pointInQuad`: 내부·경계·외부·null 방어 ✔. ray casting quad 내부/외부 ✔.
- `hitTestSlots`: 단일/겹침(배열 끝=상단 우선)/빈곳 null/`layers.vehicle=false` 제외/floor quad 차선 ✔. **추가 검증**: 한 slot 에 rect+floor 동시 존재 시 1회 hit, `layers.floor=false` 시 rect 밖 floor 영역 제외 ✔ — **그리는 순서·레이어 토글과 정합**.
- `rebuildGlobalIndex`: cam→preset→coveredSlotIds 위치 순 1..N ✔. **slotId sN 파싱 안 함**(`['b','a']` 순서 그대로) ✔. **추가 검증**: coveredSlotIds 에 없는 orphan slot 안전망으로 뒤에 부여(globalIdx 연속) ✔.
- `removeSlot`: 삭제 후 `validateCoverage.ok`, globalIdx 연속, 해당 preset.coveredSlotIds 에서 제거, 타 슬롯 ROI 불변, 원본 불변(불변 갱신) ✔. **추가 검증**: 멀티 카메라(cam1·cam2)에서 cam 정렬 보존 ✔.
- `clamp01Rect`/`resizeRect`/`updateSlotRoi`: se +δ 증가, 1 초과 클램프, 음수폭 붕괴 방지·좌우 뒤집힘 정규화, 음수좌표→0 ✔. **추가 검증**: nw 핸들이 우하단 고정(좌상단만 이동), updateSlotRoi 새 key 추가 시 기존 key 보존·globalIndex 동일 참조 유지 ✔.
- `validateManualIndex`: ok / 중복(duplicates+gaps) / gap 감지 ✔. **추가 검증**: 빈 배열 → ok ✔.
- `reorderGlobalIndex`: 정상 재정렬(coverage ok·순서 반영), 누락/미존재/중복 입력 → null ✔. **추가 검증**: camIdx/presetIdx 기존 globalIndex 에서 보존 ✔.
- `diffArtifactVsCameras`: artifact 1:3 보유 + cameras 1:1,1:2 → `artifactOnly:['1:3']`, 빈 입력 방어, camerasOnly 산출 ✔.

**판정: 순수함수 11개 전부 설계 규약대로 동작.**

---

## 3. PUT 영속화 정합(핵심) — `app.inject`

mappingPut.test.ts(5) + **검증자 추가 inject 테스트 3건**(extra·zod·GET404, 실행 후 정리)로 경계 전수 확인:

| 시나리오 | 기대 | 결과 |
|---|---|---|
| 유효 SetupArtifact → PUT /mapping | 200 `{ok:true,slots,globalCount}` + `repo.saveArtifact` 1회 | ✔ |
| 유효 → PUT /viewer/api/mapping(동일 핸들러) | 200 + saveArtifact 호출 | ✔ |
| coverage **missing**(slots 에 있고 globalIndex 에 없음) | 400 `coverage mismatch` `missing:['b']` + **미저장** | ✔ |
| coverage **extra**(globalIndex 에 잉여 slotId) | 400 `coverage mismatch` `extra:['ghost']` + 미저장 | ✔(추가검증) |
| globalIndex=[] (전부 누락) | 400 `missing:['a']` + 미저장 | ✔ |
| zod shape 위반(`presets:'nope'`) | 400 `invalid artifact` + 미저장 | ✔ |
| zod shape 위반(roiByPreset rect 필드 누락 `{x,y,w}`) | 400 `invalid artifact` + 미저장 | ✔(추가검증) |
| GET /mapping (artifact 없음) | 404 불변 | ✔(추가검증) |

게이트 순서 = ① zod → ② `validateCoverage`(기존 GlobalIndexer 재사용) → ③ saveArtifact. **정합 불일치 시 파일 보호(미저장) 동작 확인.** GET /mapping·/viewer/api/mapping 읽기 직접 반환·404 보존(코드+테스트 확인).

---

## 4. #4(프리셋3 진단/수정) — 코드 확인(라이브 불가)

- `sel-cam`·`sel-preset` change 핸들러에 **`drawRoiOverlay()` 호출 추가** 확인(app.js L937·L945, grep). 전환 시 `state.selectedSlotId=null`(선택 해제)도 추가됨.
- `drawRoiOverlay`: `state.roiHidden` 가드 보존(L162), key=`presetKey(cam,preset)` 로 `slot.roiByPreset[key]` 조회 — 설계 진단(키매칭 정상)과 정합.
- `diffArtifactVsCameras` → 분석 탭 경고(artifactOnly = 드롭다운에 없어 선택 불가) / 검수 탭 빈 상태 안내 결선 확인.
- **미커버**: `/cameras` 에 프리셋3 실제 노출 여부는 라이브 필요(설계서 §리스크5). 코드상 진단·재그리기는 정상.

---

## 5. 계약·기존기능 불변(영향도)

- **GlobalIndexer.ts·Repository.ts: diff 0**(불변, 재사용). 계약 게이트는 기존 `validateCoverage` 그대로.
- **SetupArtifact shape 불변**: PUT 핸들러는 같은 형식 갱신만. zod 스키마는 계약과 동형(필드 추가 없음). `src/domain/types.ts` 의 `NormalizedPoint`/`NormalizedQuad` 재수출은 **선행 floorRoi 작업** 소산이며 본 ROI-편집 과제와 무관(SetupArtifact 필드 불변).
- floor 채움(직전 변경) 보존: `drawRoiOverlay` 의 floor `fill('rgba(57,255,20,0.22)')` 유지(L193-194). roiHidden/표시초기화 가드 보존.
- GET 라우트·`/setup/*`·`/capture/*` 무수정(가산만). 캡처/recognizeFloorRoi 경로 무영향(테스트 회귀 0 으로 확인).
- 오버레이 편집 결선: 히트테스트·리사이즈 모두 `eventToNorm` 동일 분모 사용(설계 §리스크2 — 좌표 일관성 확보), 레이어 토글이 hit-test 와 draw 양쪽에 반영.

---

## 6. 발견 결함 / 수정

- **발견 결함: 없음.** 모든 단위·inject·엣지 검증 통과. 테스트 느슨화/통과 위장 없음.
- 검증 중 작성한 임시 inject 테스트(extra/zod/GET404)는 확인 후 삭제 — 저장소 오염 없음.

---

## 7. 미커버(명시)

- **브라우저 캔버스 상호작용**(vitest 비대상, 환경 의존): 마우스 클릭 선택 하이라이트, 4모서리 핸들 드래그 리사이즈 실시간 미리보기, 삭제/저장 버튼 후 재로드, #7 ▲▼ 재정렬 UI. → 순수 로직은 단위로 차단했으나 실제 마우스/캔버스 동작은 **라이브 뷰어 수동 검증 권장**.
- **#4 라이브**: `/cameras` 응답에 프리셋3 실노출 여부 실측(라이브 필요). 미표시 재현 시 진단 경고로 1차 구분, 그래도 미표시면 리더 에스컬레이션.
- **동시성**: 편집 미저장 중 `/capture/finalize` 덮어쓰기 유실(설계 §리스크1) — 1차 보류(과설계 회피). finalize 잠금 미구현은 설계 결정.
- 라이브 서버 기동: 본 검증 범위 제외(지시대로 미기동).

---

## 최종 판정

**PASS — 재작업 불필요.** typecheck 0 / 315 tests passed(회귀 0) / 신규 34 / PUT 정합(missing·extra·zod·미저장·GET404) 전수 통과 / #4 코드 수정·진단 결선 확인 / 계약·기존기능 불변 확인. 잔여는 전부 환경 의존(브라우저·라이브) 수동 항목으로 명시.
