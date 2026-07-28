# 00 리더 컨텍스트 — 주차면(파일 ROI) **신규 그리기** 도구

작성: 2026-07-28 / 실행 모드: **B(goal/loop)**
선행: `_workspace_prev_20260728_L3/`(L3 1라운드), `_workspace_prev_20260728_autosplit/`(L3 후속),
`docs/20260727_235515_L3_*.md`, `docs/20260728_021006_L3후속_*.md`

## 왜 이 작업이 필요한가 — 리더의 누락 인정

마스터 지적: **"처음 ROI는 수동으로 그리는 방법이 없다. 그래서 미리보기를 클릭할 수 없다."**

마스터는 **이 세션 첫 질문에서 이미** 말했다 — *"현재 이 프로젝트에서는 시뮬레이터 쪽에서 강제로 바닥
주차면을 그려서 Json파일에 저장한다."* 리더는 그 문장을 읽고도 **quad 가 이미 존재한다는 전제 위에만**
L3 를 두 라운드나 쌓았고, **"주차면 1개만 손으로 그리면"이라는 L3 의 출발점이 실제로 가능한지 한 번도
확인하지 않았다.**

결과: **L3 는 Unity 시뮬레이터에서만 동작한다.** 시뮬레이터가 파일을 써주기 때문이다.
리얼카메라·신규 주차장에서는 목록이 비어 → 선택 불가 → 미리보기 불가 → **전 기능 도달 불가**.
자동화 실패 시의 안전망으로 설계한 **L3(수동 1개)가 정작 리얼 환경에 없다.**

## 리더 실증 (재조사 불필요)

**`place-*` 버튼 전수** (`web/index.html` grep):
`place-delete` · `place-edit`(idx 변경) · `place-gidx` · `place-msg` · `place-open` · `place-save`
→ **`add`·`draw` 없음.**

**캔버스 드래그 kind 전수** (`web/app.js` grep):
`detResize` · `detMove` · `detVertex` · `vpdResize` · `vpdMove` · `floorVertex`
→ `floorVertex`(app.js:4305)는 `slotId: state.selectedSlotId` 를 물고 있는 **artifact 슬롯의 기존 바닥
정점 이동**이지 `state.placeRoi`(PtzCamRoi `parking_spaces`) 생성이 아니다.

**결론: 파일 ROI 를 새로 만드는 수단이 저장소에 0개.**

**현재 데이터 상태**: `data/Place01/` 에 `PtzCamRoi.json` 하나뿐(`_auto.json`·`.bak`·`ground_grid.json` 없음)
— 운영에서 apply 가 한 번도 실행된 적 없다.

## 리더 확정 결정

### D-1. 점 순서 규약은 제약이 아니다
`buildGroundPlane` 이 폭/깊이 배정을 **양쪽 다 풀어 metricErr 가 작은 쪽을 채택**한다
(`groundModel.ts` 의 `solve(asA)`/`solve(asB)` → `takeA` 판정). 따라서 사용자는
**순환 순서(시계 또는 반시계)로만 찍으면 되고** 어느 변이 2.5m 인지는 코드가 판정한다.
막을 것은 **자기교차(bowtie)와 퇴화**뿐이고, 기존 **`isUsableQuad`**(최소 변 8px · 최소 면적 400px² ·
볼록 · 비자기교차)가 **이미 그 게이트다** — 재구현 금지, 그 판정을 쓰거나 동일 기준을 UI 에 반영.

### D-2. 저장은 기존 경로 재사용
신규 저장 경로·신규 DB 쓰기 금지. 기존 **`PUT /capture/place-roi`(`applyPlaceRoiUpdate`)** 계약 안에서 해결.

### D-3. 전역 idx 규약을 깨지 말 것
`parking_spaces.idx` 는 **전역 1..N**(실측: cam1 p1:1-7 / p2:8-11 / p3:12-13 / cam2 p1:14-19 / p2:20-23)이고
`slot_ptz.json` · 센터링 · artifact `globalIndex` 가 이 순서에 의존한다.
신규 면의 idx 부여 규칙(끝 append vs 중간 삽입)을 **명시**하고 기존 번호를 흔들지 말 것.

### D-4. 직전 라운드 결함 재생산 금지
`idx` 없는 주차면은 `normalizePtzCamRoi` 에서 **조용히 탈락**하고 `applyPlaceRoiUpdate` 통째 교체 시
raw 에서 **삭제**된다(QA-F 결함, G5 게이트로 차단 중). **신규 생성 면에 반드시 idx 가 붙도록 보장**할 것.

## Loop
1. 신규 주차면 그리기(캔버스 4점) → 그린 직후 초록 파일 ROI 로 즉시 표시, `isUsableQuad` 미달이면 **사유 표시**
2. 정점 드래그 미세조정 → 클릭 4번으로 모서리를 정확히 못 맞춘다. `floorVertex` 패턴 참고, 저장 반영 확인
3. 저장 → `PUT /capture/place-roi` 반영, 재로딩 후 좌표·idx 일치. **기존 면 idx·순서 불변**을 테스트 봉인
4. **★ L3 연결(핵심)** → 새로 그린 면 1개로 지면격자 **미리보기가 실제 동작**. 리더가 라이브 종단 확인
5. **★ 빈 상태(존재 이유)** → `PtzCamRoi.json` 부재 또는 주차면 0개인 신규 주차장에서 **첫 면을 그릴 수 있는가.**
   못 하면 그 자체가 실패다

## Requirements (불변 제약)
- [ ] **기존 동작 회귀 0** — 그리기 모드 off 면 기존 캔버스 상호작용 완전 동일. **드래그 kind 충돌 반드시 검토**
- [ ] **빈 파일/파일 부재에서 시작 가능**(신규 주차장). 미달 시 목표 미달
- [ ] 그리기 취소(Esc)·되돌리기. **저장은 명시적 트리거** — 실수로 그린 면이 즉시 파일에 박히면 안 됨
- [ ] 결정론 · `round5`/`stringify5` · throw 금지(→ null + issues) · 순회 순서 고정
- [ ] 무변경 목표: `groundModel.ts`·`project.ts`·`ground/types.ts`·`floorRoi.ts`·`web/core.js`·
      `Finalizer.ts`·`SqliteStore.ts`·`roiDbLoad.ts` — 손대야 하면 **사유 먼저 보고**
- [ ] 기존 테스트(L3 골든 해시 포함) 유지. `tsc --noEmit` 0에러 + `vitest run` 전량 통과
- [ ] 범위 밖 리팩토링 금지
- [ ] CLAUDE.md 5대 규칙

## 리더 결정 (2026-07-28, 설계 리뷰 후)

설계자가 **리더가 몰랐던 사실 6건(F-1~F-6)** 을 코드 실측으로 올렸다. 전부 수용한다.

### 승인 1 — `groundModel.ts` 에 `export` 키워드만 추가 ✅ **승인**
`MIN_EDGE_PX`/`MIN_AREA_PX` 에 **`export` 만** 붙인다. **값·로직 0 변경.**
근거: `isUsableQuad` 재구현 금지 원칙을 지키면서 UI 가 실제 임계값을 문장으로 보여줄 수 있다
("변 8px 이상 · 면적 400px² 이상 필요"). 의미상 무변경이라 무변경 목표의 취지를 해치지 않는다.
**조건**: 값이 바뀌지 않았음을 테스트로 봉인할 것.

### 승인 2 — R3(artifact 존재 시 새 면이 목록에 안 보임) **범위에 포함** ✅
설계자는 "기존 결함, 기본 범위 밖"으로 분류했으나 **리더 판단으로 범위에 넣는다.**
근거: `renderSlotList` 가 `finalized || fileMode` 분기에서 artifact 기준으로 목록을 그리므로,
artifact 가 있는 **현재 Unity 환경**에서 새로 그린 면이 목록에 안 보인다 → 선택 불가 → 미리보기 불가.
**Loop 4(L3 연결)가 그대로 실패한다.** 범위 확장이 아니라 **목표 달성의 필요조건**이다.

### 승인 3 — F-1/F-2 골격 설계 ✅ **승인**
- **F-1**: 최소 골격에 **`pan/tilt/zoom` 이 필수**다. `autoRoiPlan.ts:250` 이 `buildGroundInputs(json, [])` 로
  camerapos 를 안 넘기므로 **PtzCamRoi.json 이 유일한 PTZ 출처**다. PTZ 없는 골격은 저장은 되지만
  `ref.zoom == null` → "PTZ 미상 — 부트스트랩 불가" 로 **Loop 4 가 그 자리에서 실패**한다.
  → 골격 생성 시 **뷰어의 현재 PTZ 를 반드시 기록**할 것.
- **F-2**: `imageWidth/imageHeight` 의 실측 출처는 뷰어 `<img id="frame">` 의 `naturalWidth/naturalHeight`
  뿐이다(camerapos·toolsConfig 에 없고 DB `camera_info.img_w` 는 PtzCamRoi 파생이라 순환).
  **1920×1080 추측 금지**, 라이브 미시작이면 **저장 거부**(사유 표시).

### 추가 지시 (승인 요청 외)
- **F-3 조용한 거짓 성공은 결함이다 — 반드시 고칠 것.** 파일은 있는데 cam/preset 이 없으면
  `applyPlaceRoiUpdate` 가 원본을 그대로 돌려주는데 라우트가 `{ok:true, spaceCount:N}` 을 반환한다.
  **아무것도 적용되지 않았는데 성공으로 보인다.** `applied` 를 명시해 거짓 성공을 없앨 것.
- **F-4 수용**: `floorVertex` 는 `!FLOOR_ROI_USE_LLM`(상수 false) 가드로 **도달 불가 데드 분기**.
  리더가 최대 리스크로 지목한 kind 충돌은 **실재하지 않는다.** 설계가 단순해진다.
- **F-5 수용**: 편집 분기 전체가 `!state.mapping`(app.js:4275)에서 차단되고 `mousemove`(:4342)가
  `state.mapping.slots` 를 무가드로 읽어 **TypeError 위험**이 있다. 신규 분기는 **그 가드 위**에 놓고
  placeVertex 는 그 이전에 return 할 것.
- **F-6 수용**: `index.html:171`/`app.js:1892` 의 "수동 드로잉 경로는 그대로 유지된다" 는 **거짓 서술**이다
  (리더가 그렇게 단정해 생긴 주석이다). 사실에 맞게 고칠 것.
- **R2 한계는 숨기지 말고 UI 로 안내**: 수동 단일 quad 는 `focalFromVPs` 실패 가능(f²≤0)하고 폴백이
  같은 카메라의 다른 프리셋을 요구하므로 **1면뿐인 신규 주차장에선 부트스트랩이 실패할 수 있다.**
  이번 범위로 해결 불가 → 실패 시 **"다른 프리셋에도 1면을 그리세요"** 라는 행동 지시를 사용자에게 줄 것.

### 판단 채택 (설계자 제안 그대로)
- **클릭 4회** 채택(드래그 사각형 기각) — 원근 사다리꼴 + `dragState` 공용 경로 무변경
- mousedown 최상단 `if (state.placeDraw) { placeDrawClick(e); return; }` **단 1블록 prepend** → off 면 기존 코드 원문 실행
- `isUsableQuad` 재구현 회피 = read-only `POST /capture/place-roi/validate` 신설(파일 IO 0 → D-2 위반 아님),
  verdict 단일 원천 + 무작위 200케이스 교차일치 봉인
- **idx = 끝 append**(중간삽입 기각) — 기존 번호를 하나도 안 흔든다. 중간 배치는 기존 `reindexPlaceSpace` 재사용
- 저장은 `PUT /capture/place-roi` 에 옵셔널 `create` + `applied` 확장(`applyPlaceRoiUpdate` 는 래퍼로 보존)

## 이월된 미검증 (그대로 유효)
- **브라우저 실렌더 6라운드 연속 미검증** — 이번 작업은 **본질이 캔버스 상호작용**이라 미검증 면적이
  또 크게 는다. 마스터 육안 확인이 사실상 필수인 라운드다. 이를 처음부터 전제로 두고 진행한다.
- `normalizePtzCamRoi` 조용한 탈락 근본 원인 잔존(`PUT /capture/place-roi` 공통 결함)
- `allowNew` UI 미노출 / Unity 튜닝값(`ON_LATTICE_MAX_M`·`MATCH_MIN_IOU`) / 실카 수치 없음
