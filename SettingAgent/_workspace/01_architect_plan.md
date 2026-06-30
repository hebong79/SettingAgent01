# 01 설계서 — 주차면(ROI) 편집 + 전역 인덱스 수동 매핑

작성: 설계자(architect) · 대상: SettingAgent 웹 뷰어(SettingViewer) + 영속화 엔드포인트
근거: `Docs/20260624_162408_00_전체아키텍처_설계서.md`, 코드(`src/api/server.ts`, `src/store/Repository.ts`, `src/capture/Finalizer.ts`, `src/setup/GlobalIndexer.ts`, `web/{app.js,core.js,index.html}`), 현재 `data/setup_artifact.json`
원칙: ParkSimMgr 컨벤션(ESM·1-based·정규화 0~1·외과적·단순함 우선). 과설계 금지.

---

## 0. 핵심 계약·확정 사실(설계 전제)

- **SetupArtifact 계약 불변.** `{ presets[], slots[], globalIndex[], createdAt, warnings?, report? }` (`packages/types/src/index.ts` + `src/domain/types.ts`). 편집은 **같은 형식의 산출물을 갱신**할 뿐, 새 필드·새 타입을 추가하지 않는다. Action/DM 이 이 파일을 읽는 계약이므로 shape 변경 금지.
- **좌표 규약**: ROI(`roiByPreset[key]`)=정규화 `{x,y,w,h}` 0~1. floor(`floorRoiByPreset[key]`)=정규화 4점 `NormalizedQuad`. 키=`${camIdx}:${presetIdx}`(예 `1:3`). 1-based.
- **globalIndex 규약**(`GlobalIndexer.buildGlobalIndex`): camIdx ASC → presetIdx ASC → positionIdx ASC 정렬 후 `globalIdx=i+1`. `validateCoverage(globalIndex, slots)`: `globalIndex.slotId` 집합 == `slots.slotId` 집합(누락/초과 0).
- **현재 영속화 경로**: `Finalizer.finalize()` 와 `SetupOrchestrator` 만 `repo.saveArtifact()` 호출. 뷰어→artifact 는 **읽기 전용**(`GET /mapping`, `GET /viewer/api/mapping` 둘 다 `repo.loadArtifact()` 직접 반환). 쓰기 경로 없음 → **신규 필요**.

---

## #4 진단 결론(코드/데이터 기반 — 라이브 기동 없이 확정)

**결론: Finalizer/Aggregator/`drawRoiOverlay`/`renderSlotList`/키매칭에 프리셋3 버그 없음. 원인은 "프리셋3로 네비게이션 불가"(데이터/열거) 가능성이 가장 높음 → 코드 수정 대상 아님. 진단·안내(분석 탭 + 네비 가드)로 처리.**

근거(현재 `data/setup_artifact.json` 실측):
- presets: `1:1 n=8`, `1:2 n=6`, **`1:3 n=14`** — 프리셋3 채택 슬롯 14개 정상 존재.
- slots roiByPreset 키 분포: `{1:1:8, 1:2:6, 1:3:14}` — 프리셋3 슬롯 ROI 키 `"1:3"` 정상.
- globalIndex 15~28 이 `c1p3sN (1:3)` 로 정상 매핑. floor 키도 `1:3` 보유.

코드 경로 확인:
- `drawRoiOverlay()`/`renderSlotList()` 는 `key = presetKey(state.cam, state.preset)` 로 `slot.roiByPreset[key]` 를 조회한다. cam=1·preset=3 이면 key=`"1:3"` → 위 데이터와 정확히 일치 → **선택만 되면 반드시 그려진다.**
- 따라서 "안 그려진다"의 유일한 잔여 원인은 **사용자가 프리셋3을 선택할 수 없음**: 프리셋 셀렉트는 `GET /viewer/api/cameras`(=Unity `/cameras` 또는 presetProvider) 가 주는 `presets[]` 로 채워진다(`renderPresetSelect`). 이 목록에 `presetIdx=3` 이 없으면 key 가 `"1:3"` 이 되는 일이 없어 영구 미표시. (예: 시뮬레이터 `/cameras` 가 cam1 에 프리셋 1·2만 노출, 또는 라벨/인덱스 불일치.)
- 후보(a) clusterMinSupport 미달: capture 설정은 `clusterMinSupport:3` 이나, **이미 채택 14개가 산출됨** → 이번 산출물엔 해당 없음(다른 회차/데이터에서 0이면 별개 — 분석 탭 perPreset 으로 노출).

조치(이번 범위, 수정 아닌 진단·가드):
1. **분석 탭 perPreset 보강(이미 테이블 존재)**: artifact 에는 있으나 `/cameras` 에 없는 프리셋 키를 "네비게이션 불가(드롭다운 미노출)" 경고로 표시. `web/core.js` 에 순수 함수 `diffArtifactVsCameras(artifact, cameras)` 추가 → "artifact 에만 있는 presetKey" / "cameras 에만 있는 presetKey" 산출. 분석 탭 warnings 영역에 렌더.
2. **검수 탭 안내**: 선택 프리셋 key 에 해당하는 slot 이 0개면 `slot-list`/오버레이 영역에 "이 프리셋에 주차면 없음 — 다른 프리셋 선택 또는 분석 탭 확인" 안내 1줄(`renderSlotList` 빈 상태). 데이터가 진짜 0인 경우(검출 부족)와 네비 불가를 구분해 안내.

> 만약 developer 가 라이브에서 `/cameras` 에 프리셋3가 실제로 노출됨을 확인하면(=네비 가능한데도 미표시), 그때는 위 가정이 틀린 것이므로 **리더에게 에스컬레이션** 후 재진단(키 타입 불일치 number/string 등). 현재 코드상 `presetKey` 는 양쪽 모두 number 보간이라 불일치 없음.

---

## 영속화 모델(핵심 설계 결정)

### 결정: `PUT /mapping` — 전체 SetupArtifact 교체 (슬롯 단위 PATCH 기각)

- **신규 라우트**: `PUT /mapping` (헤드리스 API) **+** `PUT /viewer/api/mapping`(뷰어 컨텍스트). 본문 = 완전한 SetupArtifact.
- 처리: ① zod 스키마 검증(shape) → ② `validateCoverage(globalIndex, slots)` 정합 검증 → ③ 통과 시 `repo.saveArtifact(artifact)`, 실패 시 **400**(저장 안 함). 응답 `{ ok:true, slots, globalCount }`.
- **GET /mapping·/viewer/api/mapping 은 불변**(읽기 직접 유지).

**PATCH(슬롯 단위)를 기각하는 근거(단순함 우선)**:
- 삭제 1건이 slots·globalIndex·coveredSlotIds **3곳**을 동시에 바꾼다 → 부분 PATCH 는 서버가 재구성 로직을 또 들고, 클라이언트와 정합 책임이 갈라진다.
- 산출물 크기 작음(현재 28 슬롯, 단일 JSON 파일). 전체 교체 비용 무시 가능. 멱등·디버깅 용이.
- 뷰어가 이미 `state.mapping`(전체 artifact)을 메모리에 들고 있다 → 편집 후 통째 PUT 이 자연스럽다.
- 정합 책임을 **클라이언트(core.js 순수함수)가 재구성 → 서버가 validateCoverage 로 게이트**의 단일 지점으로 모은다.

### 편집 시 globalIndex 재계산 정책(확정)

- **삭제**: 제거된 slot 을 slots·globalIndex·해당 preset.coveredSlotIds 에서 빼고, **남은 슬롯을 `buildGlobalIndex` 규약(cam→preset→position)으로 재번호**(globalIdx 연속 1..N 유지). 수동 매핑(#7)이 적용돼 있으면 그 순서를 보존(아래).
- **크기 조정(#3)**: `roiByPreset[key]` 만 갱신. slot 집합 불변 → globalIndex·coveredSlotIds 불변.
- **수동 매핑(#7)**: 사용자가 정한 `globalIdx` 순서를 globalIndex 배열로 직접 반영(1..N 연속·중복 없음 검증). 이후 삭제가 일어나면 "수동 순서 보존 + 빈 번호 메꿈" 정책으로 재번호(자동 cam→preset 재정렬로 되돌리지 않음).
- **coveredSlotIds 규약**: 각 preset 의 `coveredSlotIds` 는 그 프리셋 소속 slot 들을 **positionIdx(프리셋 내 위치) 순서**로 유지. 삭제 시 해당 id 만 제거(순서 보존).

### positionIdx 표현 문제(중요 — developer 필독)

`globalIndex[]` 에는 `positionIdx` 가 **없다**(타입에 없음). 재번호 시 cam→preset→position 정렬을 하려면 position 정보가 필요하다. position 의 신뢰 원천은 **`preset.coveredSlotIds` 의 배열 순서**(Finalizer 가 `orderByPosition` 결과 순으로 push). → 순수 재구성 함수는 `(slots, presets)` 에서 `coveredSlotIds` 순서를 position 으로 사용해 globalIndex 를 재생성한다. slotId 문자열(`c1p3s7`)의 sN 파싱에 의존하지 말 것(수동 삭제 후 sN 이 불연속될 수 있음 — 배열 순서가 진실).

---

## 작업 순서(빠른 순) · 각 단계 검증

### 단계 1 — #4 진단·안내 (코드 영향 최소, 먼저)
- `web/core.js`: 순수 함수 `diffArtifactVsCameras(artifact, cameras)` 추가 → `{ artifactOnly: string[], camerasOnly: string[] }`(presetKey 기준).
- `web/app.js`: `renderAnalysis()` 에서 `state.cameras` 와 비교해 warnings 에 "프리셋 키 X: 산출물에는 있으나 카메라 드롭다운에 없음(선택 불가)" 추가. `renderSlotList()` 빈 상태 안내 1줄.
- **검증**: vitest `diffArtifactVsCameras` — (artifact 1:3 보유 + cameras 1:1,1:2만) → `artifactOnly:['1:3']`. 빈 입력 방어. 분석 탭 수동 확인(문구 노출).

### 단계 2 — #1 주차면 선택(히트테스트)
- `web/core.js` 순수 함수:
  - `pointInRect(nx, ny, rect)` — 정규화 좌표 점이 `{x,y,w,h}` 내부인지.
  - `pointInQuad(nx, ny, quad)` — 4점 다각형 내부(짝수-홀수 ray casting).
  - `hitTestSlots({ nx, ny, slots, key, layers })` → 최상위(마지막 그려진=배열 끝 우선) 매칭 `slotId|null`. vehicle rect 우선, floor quad 차선(현재 그리는 순서와 정합).
- `web/app.js`: overlay 캔버스 `click` → 캔버스 픽셀→정규화(`/overlay.width`, `/overlay.height`) → `hitTestSlots` → `state.selectedSlotId` 설정 → `drawRoiOverlay()` 에서 선택 슬롯 하이라이트(굵은 테두리/대비색). 프리셋/탭 전환 시 선택 해제.
- **검증**: vitest — rect 내부/경계/외부, quad 내부/외부, 겹친 슬롯 시 상단 우선, layers off 시 제외. 수동: 클릭 시 하이라이트.

### 단계 3 — #2 선택 슬롯 삭제(영속화)
- `web/core.js` 순수 함수 `removeSlot(artifact, slotId)` → 새 artifact:
  - slots 에서 제거 → 각 preset.coveredSlotIds 에서 id 제거 → `rebuildGlobalIndex(slots, presets)`(coveredSlotIds 순서 기반 재번호)로 globalIndex 재생성. createdAt 등 나머지 보존.
- `rebuildGlobalIndex(slots, presets)` 순수 함수 분리(재사용: 삭제·수동매핑 정합 산출).
- `web/app.js`: "선택 슬롯 삭제" 버튼 → `removeSlot` → `state.mapping` 갱신 → "저장"으로 `PUT`. 저장 전까진 미반영(명시적 저장 모델).
- 서버: `PUT /mapping`(아래 단계 5와 공유) 구현.
- **검증**: vitest — 삭제 후 `validateCoverage` ok, globalIdx 연속 1..N-1, coveredSlotIds 에서 제거됨, 다른 슬롯 ROI 불변.

### 단계 4 — #3 크기 조정(핸들 드래그)
- `web/core.js` 순수 함수:
  - `resizeRect(rect, handle, ndx, ndy)` → 모서리(nw/ne/sw/se) 드래그 델타 적용 후 `clamp01Rect`(x,y∈[0,1], w,h>0, x+w≤1, y+h≤1).
  - `updateSlotRoi(artifact, slotId, key, rect)` → 해당 slot `roiByPreset[key]` 만 교체(불변 갱신).
- `web/app.js`: 선택 슬롯에 4모서리 핸들 렌더, mousedown→mousemove(정규화 델타)→`resizeRect` 실시간 미리보기→mouseup 확정→`state.mapping` 갱신. "저장"으로 PUT.
- **floor 사변형 편집은 1차 범위 제외**(사각형 우선). 결정: 범위 밖(복잡도↑·요청도 "1차 판단"). 문서에 명시, 추후 과제.
- **검증**: vitest — se 핸들 +δ → w/h 증가, 경계 클램프(1 초과 안 됨, 음수 폭 방지), 다른 slot 불변.

### 단계 5 — 영속화 엔드포인트 `PUT /mapping`
- `src/api/server.ts`: zod `SetupArtifactSchema`(presets/slots/globalIndex shape) 추가. `PUT /mapping` 핸들러: 파싱 실패→400, `validateCoverage` 실패→400 `{error, missing, extra}`, 성공→`repo.saveArtifact` + `{ok,slots,globalCount}`.
- viewer 블록(`app.register` 내부)에 `PUT /viewer/api/mapping` 동일 로직(또는 공용 핸들러 함수 추출). 뷰어는 `/viewer/api/mapping` 으로 PUT.
- `web/app.js`: `saveMapping()` → `PUT /viewer/api/mapping` → 성공 시 메시지·`loadMapping()` 재로드, 실패 시 에러 표시(정합 불일치/네트워크). "저장" 버튼.
- **검증**: vitest(`mappingDirect.test.ts` 스타일, `app.inject`) — 유효 artifact PUT→200 + saveArtifact 호출됨, coverage 깨진 artifact→400 + 미저장, 잘못된 shape→400.

### 단계 6 — #7 전역 인덱스 수동 매핑(설계+UI)
- `web/core.js` 순수 함수:
  - `validateManualIndex(globalIndex)` → `{ ok, duplicates:number[], gaps:number[] }`(globalIdx 1..N 연속·중복 검사).
  - `reorderGlobalIndex(artifact, orderedSlotIds)` → 사용자 지정 순서대로 globalIdx 1..N 재부여(slots 집합과 1:1 검증). 불일치 시 `null`/throw.
- `web/index.html`/`app.css`: 분석 탭(또는 검수 탭) 에 "전역 인덱스 수동 매핑" 영역 — slotId↔globalIdx 목록을 드래그 재정렬 또는 숫자 입력. "정합 검사" 표시(중복/누락 빨강). "저장"으로 PUT.
- `web/app.js`: 편집 UI 결선 → `validateManualIndex` 실시간 → `reorderGlobalIndex` → PUT.
- **검증**: vitest — 중복 globalIdx 감지, gap 감지, 정상 재정렬 시 coverage ok·순서 반영. 수동: UI 재정렬→저장→재로드 일관.

> 단계 5(서버 PUT)는 3·4·6 모두의 저장 의존성. 구현 순서상 3에서 PUT 골격을 먼저 세우고(단계 5 일부 선행), 4·6 은 클라이언트 편집 + 동일 PUT 재사용으로 진행 권장.

---

## 파일별 신규/수정

### 서버(TypeScript ESM)
- `src/api/server.ts` — **수정(가산)**: `SetupArtifactSchema`(zod), `PUT /mapping`, viewer 블록에 `PUT /viewer/api/mapping`. 저장 핸들러는 `validateCoverage` 게이트. 기존 `GET /mapping` 불변.
- `src/setup/GlobalIndexer.ts` — **불변**(재사용: `buildGlobalIndex`, `validateCoverage`). 서버는 이미 import 가능.
- `src/store/Repository.ts` — **불변**(`saveArtifact` 그대로 사용).

### 뷰어 순수 로직 — `web/core.js`(전부 vitest 대상, DOM/fetch 미참조)
- `diffArtifactVsCameras(artifact, cameras)` — #4 진단.
- `pointInRect`, `pointInQuad`, `hitTestSlots` — #1 히트테스트.
- `rebuildGlobalIndex(slots, presets)` — coveredSlotIds 순서 기반 globalIndex 재생성(삭제·정합 공용).
- `removeSlot(artifact, slotId)` — #2 삭제 후 정합 재구성.
- `clamp01Rect`, `resizeRect`, `updateSlotRoi` — #3 크기 조정.
- `validateManualIndex`, `reorderGlobalIndex` — #7 수동 매핑.
- `core.d.ts` — 신규 export 타입 시그니처 추가(기존 패턴 유지).

### 뷰어 상호작용 — `web/app.js`(환경 의존, 비테스트)
- state 확장: `selectedSlotId`, (편집 중) `editing` 플래그. 기존 `state.mapping` 을 편집 대상으로 사용.
- overlay click/mousedown/mousemove/mouseup 결선(선택·핸들 드래그). `drawRoiOverlay` 에 선택 하이라이트·핸들 렌더 추가.
- `saveMapping()`(PUT), 삭제/저장 버튼 핸들러, #7 UI 결선.

### UI — `web/index.html`, `web/app.css`
- 검수 탭: "선택 슬롯 삭제", "저장" 버튼 + 선택 슬롯 정보 표시. (핸들은 캔버스 렌더.)
- 분석 탭(또는 신규): "전역 인덱스 수동 매핑" 영역 + 정합 표시.
- 선택 하이라이트·핸들·경고 스타일(app.css 가산).

### 테스트 — `test/`
- 신규: `roiEdit.test.ts`(히트테스트·resize·removeSlot·rebuildGlobalIndex), `manualIndex.test.ts`(validate/reorder), `mappingPut.test.ts`(`app.inject` PUT 200/400). `diffArtifactVsCameras` 는 `viewerCore.test.ts` 에 추가 가능.

---

## 순수 함수 ↔ 환경 의존 분리(테스트 경계)

| 순수(core.js·vitest) | 환경 의존(app.js·수동) |
|---|---|
| diffArtifactVsCameras, pointInRect/Quad, hitTestSlots, removeSlot, rebuildGlobalIndex, clamp01Rect, resizeRect, updateSlotRoi, validateManualIndex, reorderGlobalIndex | 캔버스 좌표 변환, 마우스 이벤트, fetch(PUT/GET), DOM 렌더 |
| 서버: validateCoverage(기존), SetupArtifactSchema 파싱 | Repository 파일 IO(기존) |

---

## MCP 도구 vs LLM 두뇌 경계 판단

- 이 기능 전체는 **사람-인-더-루프 수동 편집 UI** + **결정형 검증/영속화**다. **LLM 두뇌 미사용**(좌표 생성·판단 없음). 좌표 불변식(§0-4: LLM 좌표 생성 금지)과 정합 — 편집은 사용자 입력, 검증은 순수 함수, 저장은 Repository.
- 실시간 반복 루프(센터라이징/PTZ 미세이동) 아님 → MCP 결정형 도구 신설 불필요. 기존 REST 계약에 **쓰기 1개(PUT)** 가산만으로 충족.

---

## 영향도 분석

- **계약 불변**: SetupArtifact 형식·필드 그대로. Action/DM 은 같은 파일을 읽으므로 **무영향**(편집은 같은 형식 갱신).
- **기존 회귀 0 목표**: `GET /mapping`·`/viewer/api/mapping`·`/setup/*`·`/capture/*` 라우트 불변(가산만). 기존 281개 테스트 통과 유지. 신규 PUT 은 추가 라우트.
- **뷰어 비편집 경로 불변**: 스트림 루프·정밀 수집·분석 탭 기존 동작 보존(가산 UI).
- **Finalizer 불변**: 최종화는 여전히 자동 산출물을 쓴다. 편집은 그 위에 사용자 수정. (동시성 리스크는 아래.)

## 리스크 · 완화

1. **편집 중 finalize 동시성**: 사용자가 편집·미저장 상태에서 `/capture/finalize` 가 artifact 를 덮어쓰면 편집 유실. → 완화: 저장 시 `PUT` 응답에 createdAt 비교(낙관적). 1차는 **저장 시 최신 재로드 경고**("산출물이 갱신됨 — 다시 불러오세요")로 단순 처리. finalize 잠금까지는 과설계 — 보류.
2. **캔버스 좌표 정확도**: 표시 크기(clientWidth) 기준 정규화. img object-fit/letterbox 가 있으면 오차. → 현재 오버레이가 frame.clientWidth/Height 를 그대로 쓰므로 동일 기준 유지(추가 변환 없음). 히트테스트도 같은 분모 사용 → 일관.
3. **정합 깨짐**: 클라이언트 재구성 버그 시 globalIndex↔slots 불일치. → 서버 `validateCoverage` 가 400 으로 거부(저장 안 됨) → 파일 보호. 순수 함수 vitest 로 1차 차단.
4. **저장 실패 처리**: 네트워크/400. → app.js 에서 명시적 에러 메시지·미반영(파일 불변). 성공 시에만 `loadMapping` 재동기화.
5. **#4 가정 오류 가능성**: `/cameras` 에 프리셋3가 실제 노출되는데도 미표시면 가정이 틀림 → 라이브 확인 후 리더 에스컬레이션(코드상 키 불일치 없음 확인됨).

---

## 미해결 / 가정(리더 확인 요청)

- **A. #7 UI 위치**: 분석 탭에 넣을지(읽기 중심 탭) 신규 "매핑 편집" 탭을 만들지. → 1차 제안: **분석 탭에 가산**(신규 탭 회피, 단순함). 이의 시 알려주세요.
- **B. 저장 모델**: "명시적 저장 버튼"(편집은 메모리, 저장 시 1회 PUT) 가정. 자동 저장(편집마다 PUT) 아님(동시성·실수 위험↓). 동의 확인.
- **C. floor 사변형 편집**: 1차 **범위 제외**(사각형만). 동의 확인.
- **D. #4 실제 원인 확정**: 코드·현 데이터로는 "네비게이션 불가" 가설이 가장 유력하나, `/cameras` 응답 실측은 라이브 필요(이번 금지). developer 가 단계 1 안내를 넣고, 라이브 확인은 별도 진행 권장.
