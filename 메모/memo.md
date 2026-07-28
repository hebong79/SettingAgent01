# 📝 대현자 메모 (memo.md)

> **현자 라(대현자)가 기억해야 할 노트.** 세션을 마무리할 때 그 세션의 작업 내용을
> 요약해 **자동으로** 여기에 추가한다. 다음 세션의 내가 이 파일을 읽고 맥락을 이어간다.
> 최신 항목을 **맨 위**에 추가한다(역순). 각 항목은 `## YYYY-MM-DD 제목` 형식.

---

## 사용 안내

- **세션 요약**: 이번 작업에서 무엇을 했는지, 왜 그렇게 했는지.
- **인수인계 요약**: 다음 사람(또는 다음 세션의 나)이 바로 이어갈 수 있도록 현재 상태 · 다음 할 일 · 막힌 지점.
- **기타**: 결정 사항, 함정, 나중에 확인할 것 등.

> 긴 작업 **중간** 복구용 메모는 `checkpoint` 스킬(`.claude/checkpoints/`)이 담당한다.
> 이 파일은 **세션 종료 시점의 사후 요약**을 쌓는 대현자의 장기 기억장이다(역할 구분).

### 🔄 회전(rotation) 정책 — 10MB 초과 시

memo.md에 새 항목을 추가하기 **전에** 파일 크기를 확인한다. **10MB(10,485,760 byte) 이상**이면 먼저 회전한다:

1. 현재 항목 전체(헤더/사용안내 아래)를 `메모/archive/memo_<가장오래된날짜>_<가장최근날짜>.md` 로 옮긴다(아카이브에도 간단한 제목 헤더를 붙인다).
2. memo.md 는 **헤더 + 사용안내 + 이 회전 정책** 만 남기고 항목 영역을 비운다.
3. `메모/INDEX.md` 에 방금 만든 아카이브 링크 한 줄을 추가한다: `- [memo_A_B.md](archive/memo_A_B.md) — 날짜범위 · 주요내용 1줄`.
4. 그런 다음 새 항목을 비워진 memo.md 최상단에 기록한다.

> 과거 기록을 찾을 땐 [INDEX.md](INDEX.md) 를 먼저 본다(아카이브 목록·날짜범위·요약).

---

## 2026-07-28 그리기 렌더 결함 수정 + ROI 초기화/전체삭제 — **마스터 실사용이 7라운드 사각지대를 뚫음**

**세션 요약** — 마스터 실카 캡처 신고: *"점 4개를 찍은 후 사각형이 그려지지 않는다. 현재 그리고 있는/선택된 ROI 초기화, 화면의 모든 ROI 삭제 기능 필요."* 문서 `SettingAgent/docs/20260728_140851_그리기렌더수정_ROI초기화_전체삭제.md`, 산출물 `_workspace/00~04`(직전은 `_workspace_prev_20260728_placedraw/`).

- **★ 이 결함은 브라우저 렌더에서만 드러났고 유닛테스트가 7라운드 동안 못 잡았다.** 리더·검증자 모두 접근 불가라 "코드가 그 자리에 있다"까지만 증명했던 영역을 **마스터 실사용이 뚫었다.** 교훈: **"테스트 통과 = 동작 증명" 이 아니다.**
- **★ 리더 진단이 틀렸고 설계자가 코드로 정정**: 리더는 원인을 `drawPlaceDrawOverlay`(app.js:655-659)의 **`closePath()` 누락**으로 단정. 설계자 반박 — `placeDrawClick`(app.js:2325-2354)에서 **4점째 클릭은 렌더를 거치지 않고 같은 동기 블록에서 커밋**되고 `endPlaceDraw()` 가 `state.placeDraw=null` → **`drawPlaceDrawOverlay` 가 `pts.length===4` 로 호출되는 경로가 존재하지 않는다.** `closePath()` 만 넣었으면 **화면 1픽셀도 안 변했다.** 검증자 독립 재현으로 확정.
- **실제 원인 2개**: ① **`#roi-floor` 게이트** — `drawFileFloorRoi`(app.js:611)가 토글 꺼지면 즉시 return 해서 **커밋된 면이 안 보인다** ② **3점 단계 닫힘 예고 없음**. → **미리보기 무반응과 완전히 같은 결함 유형**(`ggPreview` 는 `#roi-auto` 를 강제로 켜주는데 그리기 경로엔 그 대응이 없었다). **같은 실수를 두 번 했다.**
- **수정**: `#roi-floor` 강제 ON 진입점 **4/4**(그리기 시작·커밋·정점편집 ON·**목록 행 선택**) 전부 **렌더보다 먼저** / 3점째 **p3→p1 점선 닫힘 예고**(`closePath()` 는 방어용, 4점 경로 도달 불가를 주석에 명시) / `clearPresetSpaces(placeRoi,key)` 신규 순수함수 — **큰 idx부터** `core.removePlaceSpace` 전량 위임(**core.js 무수정**) / 초기화·전체삭제(현재 프리셋·confirm)·되돌리기 1단계(`snapshotPlaceRoi`/`sealPlaceRoiUndo` 공용).
- **★ idx 재부여는 선택지가 없었다**: `normalizeGlobalIdx`(core.js:640)가 1..N 순열이 아니면 **무조건 재부여**하므로 구멍은 저장해도 다음 로드에서 메워진다. `removePlaceSpace`(core.js:682)가 이미 전역 재압축 → **전체삭제 = 기존 삭제 n회 = 새 위험 클래스 아님.** 검증자 실행 증명: 랜덤 **500케이스 전부 1..N 순열 유지**, **"큰 idx부터"가 정확성 조건임을 대조 실험으로 실증**(오름차순은 `1:2=[4]` 잔존으로 깨진다).
- **QA 결함 3건 수정**: **F-1[중]** 초기화가 선택 면을 **스냅샷 없이 삭제해 되돌리기로 복구 불가**(리더 요구 위반, 되돌리기 버튼이 바로 옆이라 오인 유발) → 초기화·전체삭제가 **같은** 1단계 스냅샷 사용. `confirm` 은 **의도적 미부착**(복구 가능해졌고, 같은 일을 하는 기존 `삭제` 버튼은 확인을 안 받아 동작이 갈리면 더 혼란). **F-2[하]** 되돌리기가 전체 맵 통째 교체로 이후 편집을 조용히 되감음 → `JSON.stringify` **지문이 다를 때만** 확인(항상 뜨는 경고는 안 읽힌다). **F-3[하]** `selectPlaceSpace` 에 강제 ON 누락 — **같은 결함의 네 번째 진입점** → 4/4 완성.
- **F-1 수정 실행 증명**(배포 소스 원문 5함수 절단 실행): `1:1=[1,2] 1:2=[3] 선택=2` → 초기화 `1:1=[1] 1:2=[2]` → 되돌리기 `1:1=[1,2] 1:2=[3]`. **복구 성공(좌표까지 바이트 동일) true / 1..N 순열 true.** `1:2` 면이 **idx 3→2 재압축됐다가 3 으로 정확히 복원** — 프리셋 단위 undo 였다면 불가능했을 지점.
- **회귀(리더 직접 재실행)**: `tsc --noEmit` **0에러** · `vitest run` **256파일 / 3079테스트 green** · **L3 골든 해시 green**. 보호 7파일(`project`·`ground/types`·`floorRoi`·**`core.js`**·`Finalizer`·`SqliteStore`·`roiDbLoad`) **전부 무변경**. `app.css` +15/-1 은 **직전 라운드 누적분**이며 이번 라운드 무변경(mtime 확인).

**미검증(위장 없음)**
1. **브라우저 실렌더 여전히 미확인** — 진입점 4/4 가 됐어도 **"토글 켜지면 초록 면이 뜬다"는 코드 경로 확인까지**다. `confirm` 실제 모달·점선 시인성·2행 레이아웃·실서버 왕복 전부 미확인. **마스터 육안 1순위.**
2. **`place-delete`(기존 삭제 버튼)로 지운 면은 여전히 복구 안 된다** — 요구가 "초기화·전체삭제 양쪽"이었고 범위 밖으로 뒀다.
3. F-2 지문 오탐률 전수 미확인(`JSON.stringify` 키 순서 의존). 오탐 결과는 "확인창 한 번 더"뿐이라 데이터 위험 없음 판단.
4. QA F-4·F-5[정보] 미조치 — **F-5(`되돌리기` 버튼 문구가 `#place-undo`/`#align-undo` 둘)** 는 다음 라운드 판단.

**★ 별건 관찰(다음 확인 대상)** — 마스터 실카 캡처의 **자동ROI(주황 점선) 격자 셀이 주차면 1대보다 훨씬 커 보인다**(레이블 `auto cam1 p01 8/10`). **실카에서 격자 스케일이 안 맞을 가능성.** 그리기 정상화 후 별도 확인. 이번 라운드에서 건드리지 않았다.

**인수인계 요약** — 최우선: ① **마스터 브라우저 육안 확인**(8라운드 누적, 이번이 결정적) ② **실카 자동ROI 격자 스케일 검증**(위 별건) ③ `place-delete` 복구 지원 여부 ④ R2·`normalizePtzCamRoi` 조용한 탈락 근본 수정 ⑤ `allowNew` UI.

## 2026-07-28 주차면(파일 ROI) **신규 그리기 도구** — L3 의 빠진 출발점 (parkagent-dev B모드)

**세션 요약** — 마스터 지적: *"처음 ROI는 수동으로 그리는 방법이 없다. 그래서 미리보기를 클릭할 수 없다."* → **리더 누락 인정**. 문서 `SettingAgent/docs/20260728_124910_주차면_신규그리기_도구.md`, 산출물 `_workspace/00~04`(직전 라운드는 `_workspace_prev_20260728_L3/`·`_workspace_prev_20260728_autosplit/`).

- **★ 리더 누락의 실체**: 마스터가 **세션 첫 질문에서** *"시뮬레이터 쪽에서 강제로 바닥 주차면을 그려서 Json파일에 저장한다"* 고 말했는데, 리더는 그 문장을 읽고도 **quad 가 이미 있다는 전제 위에만** L3 를 두 라운드 쌓았고 **"주차면 1개만 손으로 그리면"이 실제로 가능한지 한 번도 확인하지 않았다.** → **L3 는 Unity 시뮬레이터에서만 동작**했다. 리얼카메라·신규 주차장은 목록이 비어 선택 불가 → 미리보기 불가 → **전 기능 도달 불가**. 자동화 안전망으로 설계한 "수동 1개" 가 정작 리얼 환경에 없었다.
- **리더 실증**: `place-*` 버튼 전수(`delete`/`edit`/`gidx`/`msg`/`open`/`save`)에 **`add`·`draw` 없음**. 캔버스 드래그 kind 6종(`detResize`/`detMove`/`detVertex`/`vpdResize`/`vpdMove`/`floorVertex`) 중 파일 ROI **생성 0개**(`floorVertex` 는 artifact 슬롯 정점 이동).
- **★ 설계자가 찾은 리더 미인지 6건(F-1~F-6, 전부 코드 실측)**:
  - **F-1** 신규 골격에 **`pan/tilt/zoom` 필수** — `autoRoiPlan.ts:250` 이 `buildGroundInputs(json, [])` 로 camerapos 를 안 넘겨 **PtzCamRoi.json 이 유일한 PTZ 출처**. PTZ 없으면 저장돼도 부트스트랩이 그 자리에서 실패.
  - **F-2** `imageWidth/Height` **실측 출처가 저장소에 없다**(camerapos·toolsConfig 부재, DB `camera_info.img_w` 는 PtzCamRoi 파생이라 순환) → `<img>.naturalWidth` 유일. **1920×1080 추측 금지, 라이브 미시작이면 저장 거부.**
  - **F-3** PUT 의 **조용한 거짓 성공** — cam/preset 없으면 아무것도 안 하고 `{ok:true, spaceCount:N}`.
  - **F-4** `floorVertex` 는 `!FLOOR_ROI_USE_LLM`(상수 false) 가드로 **도달 불가 데드 분기** → **리더가 최대 리스크로 본 kind 충돌은 실재하지 않았다.**
  - **F-5** 편집 분기가 `!state.mapping`(app.js:4275) 차단 + mousemove 무가드 `state.mapping.slots` 읽기 → TypeError 위험.
  - **F-6** `index.html:171`/`app.js:1892` 의 *"수동 드로잉 경로는 그대로 유지된다"* 는 **거짓 서술**(리더가 단정해 생긴 주석).
- **채택 판단**: **클릭 4회**(드래그 사각형 기각 — 원근 사다리꼴) / mousedown 최상단 **1블록 prepend**(회귀 0 구조 보장) / **`isUsableQuad` 재구현 금지** → read-only `POST /capture/place-roi/validate` 단일 원천 / **idx 끝 append**(기존 번호 불변) / 저장은 기존 `PUT /capture/place-roi` 확장(`create`/`applied`/`appliedCount`). 리더 승인: `groundModel.ts` 에 **`export` 키워드만** 추가(값 8/400 불변), **R3(artifact 있을 때 새 면 목록 노출)을 범위에 포함**(안 하면 Loop 4 가 실패 — 목표의 필요조건).
- **★ 리더 실측 — 신규 주차장 1면 부트스트랩 가능성**(메모리 골격, 실데이터 무변경): preset1 **7/7** · preset2 **4/4** · preset3 **0/2**(`focalFromVPs` f²≤0) → **13 중 11 성공**. preset3 은 급한 tilt(35.8°)/zoom 1 의 원리적 한계 → UI 가 **"다른 프리셋에도 1면을 그리세요"** 로 안내(preset1·2 가 fovBaseV 공급).
- **★ Loop 4/5 종단 성공**(검증자 재현): 빈 디렉터리 → 첫 면 저장 → bootstrap **200 ok:true `d=4.95001296446665`**(리더 실측과 일치). **PTZ 뺀 대조군은 "PTZ 미상 — 부트스트랩 불가"** 로 실패 → **F-1 필요성 실증**.
- **QA 결함 5건 수정**: **D-1[중]** `create` 가 **404 일 때만** 붙어 "파일 존재 + 대상 cam/preset 없음" 이 **저장 영구 불가**(현 데이터의 cam2:p3 도 막힘). 서버는 능력이 있었고 **프런트 게이트 한 줄이 막고 있었다** → 판정을 "파일에 그 키가 실재하는가"로 이전 + `applied:false` 시 **1회만** 재시도(루프 부재 봉인). 실행 원문으로 `applied:true` 확인. **D-2[경]** R3 부작용으로 `#slot-list` 가 항상 파일 평면 목록이 되어 **artifact 슬롯 선택 상실** → 병기로 복구(이중구현 0). **D-3** 거짓 주석 4곳 정정(잔존 grep 0). **D-4** `appliedCount` 추가. **D-5** zoom≤0 400 회피 + 경고 노출.
- **구현자 자기 정정(기록 가치)**: D-1 시나리오 첫 실행에서 전부 `f²≤0` 가 나왔으나 원인은 **자기 러너의 `ground` 설정 누락**이었고 제품 결함이 아니었다. **잘못된 중간 관측으로 R2 를 확대 주장하지 않으려고** 경위를 남겼다.
- **회귀(리더 직접 재실행)**: `tsc --noEmit` **0에러** · `vitest run` **256파일 / 3052테스트 green** · **L3 골든 해시 13/13 green**. 무변경 목표 7파일(`project`·`ground/types`·`floorRoi`·`core.js`·`Finalizer`·`SqliteStore`·`roiDbLoad`) **전부 무변경**. `groundModel.ts` 는 **export 2개 + 주석뿐, 값 8/400 불변**(리더 diff 확인).
- **검증자 독립 재현**: 회귀 0 실증(`wireOverlayEditing()` 삭제 **단 1줄**, 의미 동일 / mousedown 삭제 0 순수 prepend) · F-5 방어(4468 < 4514–4521 < **4522** 가드, 구간 내 `state.mapping` 역참조 **0건**) · `isUsableQuad` 교차일치(**다른 시드 5종×400=2000 + 경계 스윕 1261 mismatch 0**) · 전역 idx(N=23→24, **`[1..24]` 완전 순열**, 기존 23면 불변).

**미검증(위장 없음)**
1. **브라우저 실렌더 7라운드 연속 미검증** — 이번엔 **본질이 캔버스 상호작용**이라 특히 크다. 검증자도 jsdom 하네스 부재로 못 했고 증명된 건 **"코드가 그 자리에 있다"** 까지. **클릭이 원하는 지점에 찍히는가·보이는가 미증명 → 마스터 육안 확인 필수.** D-2 병기 목록 구분 헤더가 `.slot-empty` 재사용이라 시각 구분 약할 수 있음.
2. **R2 근본 해결 아님** — `focalFromVPs` f²≤0 형상이 존재(preset3). 1면뿐인 신규 주차장에서 실패 가능.
3. `frame.naturalWidth` 실측 대조 미실시(부분 해소: `/viewer/api/stream` 에 `sharp resize` 0건·ffmpeg 필터 스케일 없음 → **RTSP 서브스트림인 경우만 잔존 위험**).
4. 실카/Unity 라이브 종단 미실행(전부 `app.inject` in-process).

**인수인계 요약** — 최우선: ① **브라우저 육안 확인**(7라운드 누적, 이번이 가장 중요) ② 신규 주차장 실제 시나리오 1회(라이브 시작 → 그리기 → 저장 → 미리보기) ③ `normalizePtzCamRoi` 조용한 탈락 근본 수정 ④ `allowNew` UI ⑤ 실카 임계값 재조정.

## 2026-07-28 L3 후속 — 미리보기 UX 수정 + `PtzCamRoi_auto.json` 분리 + 승인 promote (parkagent-dev B모드)

**세션 요약** — 마스터 지적 3건 처리: ① 미리보기 무반응 ② 기존 floor_ROI 와 구분 관리 + `PtzCamRoi_auto.json` ③ 승인 후 slot_setup 초기화 저장 + "JSON 1개/2개 판단". 마스터 부재(오전 11시까지) 승인 없이 자율 완주. 문서 `SettingAgent/docs/20260728_021006_L3후속_자동ROI분리_승인적용.md`, 산출물 `_workspace/00~04`(직전 라운드는 `_workspace_prev_20260728_L3/`).

- **★ 미리보기 무반응 = 서버 무죄, 클라이언트 UX**. 리더가 라이브 라우트로 확인: `POST /capture/ground-grid/bootstrap` → `ok:true` matched 7/7 IoU 0.9999768 applicable:true. 정적자산도 최신(`no-store`·새 app.js·gg-* id 9개 일치·리스너 배선). **진짜 원인**: `ggPreview()`(app.js:1961~) 가 기준 주차면 미선택 시 즉시 return, 안내는 `#gg-msg` 작은 텍스트뿐 → 눈에는 무반응. `gg-apply` 엔 disabled 게이트가 있는데 **`gg-preview` 만 없었다**. 설계자가 추가로 **`renderSlotList()` else 분기에서 `renderPlaceSelectionInfo()` 미호출** 구멍을 찾음 — 안 막고 게이트만 넣으면 **버튼이 회색으로 굳는 더 나쁜 무반응**. 둘 다 수정. (부수 확인: `parking_spaces.idx` 는 전역 1..23 이고 `selectedPlaceIdx=globalIdx` 와 규약 일치 — 인덱스 버그 없음.)
- **★ 리더가 자기 결정을 뒤집음(D-1' 철회 → 대안 B)**. 처음엔 "파일 2개 완전 분리 + 소스 선택 스위치"로 정했으나, 설계자가 비용을 근거로 올림: `PtzCamRoi.json` **읽기 지점 13곳**·부팅 시 생성자 배선 4곳이라 일부만 전환하면 **소스가 갈라진 채 운영**되고, 그 무해 근거가 *"`allowNew` 가 UI 에 없어서 슬롯 집합이 동일"* 인데 **그건 곧 켜려던 스위치**였다. 조건부 무해에 구조를 걸 수 없다 → **스위치는 완전분리가 만든 문제를 푸는 장치였으므로 원인을 제거**.
- **확정 흐름**: 미리보기 → 결과확인 체크 → 승인(파괴 경고 confirm) → **S3 `_auto.json` 기록 → S4 `.bak` 백업 → S5 정본 갱신 → S6 기존 `POST /capture/slots/load-roi` 연쇄로 slot_setup 전량 재구성**. 쓰기 순서가 `_auto → .bak → 정본` 이라 앞 단계 실패 시 정본 무손상. **읽기 지점 변경 0곳 · 소스 갈라짐 0**(13곳이 전부 같은 파일을 보므로 정본만 갱신하면 자동 일치). `_auto.json` 은 승인 후에도 **삭제 안 함**(감사 기록, `_auto.history[]` 누적). promote 정본엔 `_auto` 키 **미포함**(정본 스키마 불변 — `web/core.js` 파리티 계약 보호).
- **★ QA-F [중] 데이터 소실 발견·차단**: 승인 시 **8면 → 7면**. `idx` 없는 주차면이 `normalizePtzCamRoi` 에서 탈락 → `applyPlaceRoiUpdate` 가 `parking_spaces` 를 통째 교체하며 raw 에서 삭제 → 그런데 게이트는 **정규화된 idx 집합만** 비교해 통과. 직전 라운드부터 있던 결함이나 "승인 1회 = 정본+DB" 로 승격되며 파급 확대. **G5(raw 개수 비교)** 로 차단. 라우트 409 원문: `nextSlots:23 === currentSlots:23`, `missingIdx:[]` 인데 `droppedRaw:[{key:"1:1",from:8,to:7}]` — **G1~G4 가 이 파괴를 전혀 못 본다는 직접 증거**.
- **검증자 판정(날카로움)**: 기존 G1~G4 는 **라우트 도달 불가**(409 관측 0). *"미래 방어로는 정당하나 방어 대상 선정이 틀렸다 — 일어나지 않는 일을 막고 실제로 일어나는 파괴를 놓친다."* G5 로 게이트 계층이 **처음으로 라우트 도달 가능**해짐.
- **★ 롤백 실패 주입 성공**: 구현자가 "미검증" 이라 **정직하게 신고한 S5 자동 복원**을 검증자가 깨뜨려 확인 — `vi.mock('node:fs/promises')` 로 정본을 실제 손상시키는 잘린 쓰기(ENOSPC) 주입 → 500 + 정본이 `.bak` 에서 **바이트 단위 완전 복원**(`Buffer.compare === 0`). 신고 안 했으면 검증 안 됐을 경로.
- **회귀(리더 직접 재실행)**: `tsc --noEmit` **0에러** · `vitest run` **252파일 / 3005테스트 green**.
- **보호 파일**: 의미 보호 10파일(`Finalizer`·`SqliteStore`·`roiDbLoad`·`captureRoutes`·`placeRoi`·`groundModel`·`project`·`ground/types`·`floorRoi`·`web/core.js`) **0줄**. ⚠️ `server.ts`(+12)·`toolsConfig.ts`(+6/-1)·`index.ts`(+1) 은 **직전 L3 라운드의 라우트 등록·config 배선**(`registerGroundGridRoutes`/`groundGridFile`)이며 이번 라운드 0줄 — **리더 보호목록이 과하게 넓었던 것**(신규 라우트는 어딘가에 등록돼야 한다). `replaceSlotSetup` 호출자 **실측 3곳**(`Finalizer:300`/`roiDbLoad:319`/`tools/migrateToSettingDb:96`), 증가 0.
- **리더 라이브 안전 확인**: apply 를 `confirm` 없이 호출 → **400 거부**, 정본 md5 동일(`43b96b46…`), 부산물 0(`_auto.json`·`.bak`·`ground_grid.json` 모두 미생성). **완전 apply 는 실행하지 않음** — 실 DB 의 검출·점유·센터링을 지우는 되돌리기 어려운 동작이라 마스터 부재 중 단독 실행하지 않았다.

**미해결·미검증(위장 없음)**
1. **근본 원인 잔존**: G5 는 **파괴를 막을 뿐 탈락분을 보존하지 못한다** — 사용자가 손으로 `idx` 를 채워야 승인된다. `normalizePtzCamRoi` 의 조용한 탈락과 `applyPlaceRoiUpdate` 통째 교체는 보호 파일이라 미수정. **같은 소실이 기존 `PUT /capture/place-roi` 경로에 여전히 존재**한다.
2. **브라우저 실렌더 6라운드 연속 미검증** — 이번에도 `web/app.js`(+256/-1)·`index.html`(+32)·`app.css`(+10/-1) 를 건드려 **미검증 면적이 계속 증가**. 리더·검증자 모두 접근 불가.
3. G1~G4 는 여전히 라우트 도달 불가(G5 만 도달 가능).
4. 라이브 13020 **완전 종단 미실시**(정본·DB 보호), 동시 승인 경합 미검증, 실카 수치 없음.
5. 되돌리기 성질: 수동 소스 재구성은 `slot_roi` 만 복구, **검출·점유·센터링은 복구 안 됨**(`replaceSlotSetup` DELETE+INSERT). 이 문장은 **승인 confirm 대화상자에 실제 노출**돼 있다.

**인수인계 요약** — 최우선 후속: ① **브라우저 육안 확인**(마스터만 가능, 6라운드 누적) ② 마스터 입회 하 **완전 apply 종단 1회**(정본·DB 백업 후) ③ `normalizePtzCamRoi` 조용한 탈락 근본 수정(`PUT /capture/place-roi` 공통 결함) ④ `allowNew` UI 노출 여부 ⑤ 실카 임계값 재조정.

## 2026-07-27 L3 구현 — 주차면 1개 드로잉 → 바닥 ROI 자동 생성 (parkagent-dev B모드, 4인 팀)

**세션 요약** — 위 설계 검토(B-1/B-1b)에 이어 **L3 경로를 실제 구현**. `parkagent-dev` B(goal/loop) 모드. 문서: `SettingAgent/docs/20260727_235515_L3_주차면1개_바닥ROI_자동생성.md`, 산출물 `SettingAgent/_workspace/00~04`.

- **★ 최종 명제(과장 금지 · 3단 구분)**:
  - ✅ **성립**: "1면 → **그 프리셋의 · 그 주차열의** 전 슬롯" (5/5, IoU 0.99998~1.00000)
  - ❌ **불가(정보 한계)**: "1면 → 카메라의 **모든 주차열**". 주차열 3개, p1↔p2 행간격 **15.59m = 3.118×rowPitch(5.0)** → 정수배 아님(통로), **열 위상차 1.318m**(슬롯폭의 0.527배), cam2 도 동일하게 깨짐. 증명 3종: medResid 불변량(1.321m = 임계 0.25m 의 5.3배, 평행이동은 2.5m 단위로만 움직임) / 1만 셀 확장에도 matched=0 / **533회 전수 스윕**(colStart −20..20 × rowStart −6..6) max matched **0**.
  - ⚠️ **미증명(반증 아님)**: "1면 → 그 열의 **전 프리셋**". 아키텍처는 지원하고 투영도 닿지만(preset2 프레임이 preset1 슬롯 #4~6 포함), 현재 파일이 각 열 슬롯을 한 프리셋에만 배정해 **이식 대상이 없다**. 판정에 필요한 데이터가 저장소에 없음.
- **리더 Loop1(왕복 복원) 통과**: quad → GroundModel → **지면 2D 격자로 압축** → 역투영 → 원본과 IoU **1.0000**(13슬롯 전부). 단순 backproject→project 는 항등이라 무의미 — 반드시 격자로 한 번 압축해야 전제가 검증된다.
- **리더가 틀렸고 설계자가 코드 근거로 정정한 것 2건**: ① **"LLM vs 자동격자 정본 충돌"은 실재하지 않음** — `slot_roi` 쓰기는 2곳(`Finalizer.ts:286`,`roiDbLoad.ts:182`)뿐이고 둘 다 PtzCamRoi 소스, LLM 은 `FloorRoiReviewer.ts:95` 에서 `void` 로 버려지고 `index.ts:63` 배선 제거됨. 진짜 결정은 **DB 에만 쓰면 다음 finalize 의 `replaceSlotSetup` 전량교체로 반드시 소멸** → **정본=PtzCamRoi.json 파일 갱신**(D-1). ② **리더가 준 Loop3 기준이 항진명제** — 자동 모델은 d 를 같은 상수에서 복사해 `dDevRel`/`bearingDevDeg` 가 정의상 0 → **홀드아웃 대조로 교체**(D-3).
- **D-2 달성**: 신규 수학은 **프리셋 불변 지면 2D 좌표계 1건**(원점=카메라 나딜 d·n, 축=pan 보정 기저 — `slotBearingDeg` 의 역). 보호 8파일(`groundModel/project/types/floorRoi/Finalizer/SqliteStore/roiDbLoad/web-core.js`) `git diff --numstat` **8/8 NO_CHANGE**.
- **★ [중대] 결함 — 구현자가 수정 라운드 중 스스로 발견**: preset3 이 **90° 회전된 다른 열**과 IoU 0.40 으로 매칭돼 `applicable=true` 가 됐다. 적용됐다면 **정상 ROI 를 40% 겹침 쓰레기로 덮어썼다** — "조용히 틀린 ROI 보다 안 그리는 게 낫다" 직접 위반. QA 도 리더도 못 잡았다. 수정: **격자 위 슬롯만 매칭 후보**(기하 게이트) + `MATCH_MIN_IOU` 0.3→**0.5**(진짜 매칭은 ≥0.99).
- **QA 결함 5건 수정**: 골든 해시가 **미커밋 워킹트리 파일에 봉인**(self-invalidating — apply 라우트가 그 파일을 덮어씀) → `test/fixtures/groundGrid.PtzCamRoi.json` 동결 + 런타임 경로 리터럴 금지 정적 봉인 / 라우트 `JSON.parse` try 밖 500 throw → try 안 / `buildApplySpaces` 빈배열 → null / **colStart 자동 결정**(스윕 아님 — `latticeIndexOf` 닫힌형, 창 위치는 격자 적합성에 불변) → self-row 4/5→**5/5** / `upsertCameraGrids` 통째교체 → `gridKeyOf`(방위+위상)로 **열 단위 누적**.
- **cam1 preset3 부트스트랩 불가** 해소: `focalFromVPs` f²≤0(tilt 35.8°/zoom 1 에서 직교 소실점 제약 불성립) → **같은 카메라 다른 프리셋에서 `fovBaseV` 차용**(옵셔널 3번째 인자, `groundModel.ts` 무변경). 2/2 IoU 1.00000. 차용은 항상 `issues` 노출.
- **회귀(리더 직접 재실행 확인)**: `npx tsc --noEmit` **0에러**, `npx vitest run` **249파일 / 2954테스트 전량 green**.
- **미검증(위장 없음)**: ① **브라우저 실렌더·sharp 픽셀 대조 미확인** — 수정 라운드에서 `web/app.js` 를 또 건드려 **미검증 면적이 늘었다** ② `allowNew` UI 미노출 → 웹 경로는 **기존 슬롯 좌표 교체만** 가능(신규 주차장은 라우트 직접 호출) ③ `ON_LATTICE_MAX_M=0.25`/`MATCH_MIN_IOU=0.5` 는 **Unity 데이터 튜닝값** — 실카 재조정 필요 ④ **모든 IoU 1.0000 류는 Unity 픽스처 기준**(PTZ 정확·격자 구조적 완벽) → **파이프라인 수학이 무손실이라는 것만 증명**, 실카에 대해서는 아무 말도 안 함.

**인수인계 요약** — 다음: ① **브라우저 육안 확인**(미검증 면적 최대) ② `allowNew` UI 노출 여부 결정(신규 주차장 지원) ③ **실카 데이터로 임계값 재조정** ④ "1면 → 그 열의 전 프리셋" 판정용 데이터 확보. 별개로 L1(번호판)은 B-1b 미해결 ①(preset2 의 n 검증)·③(결합추정)에서 재개.

## 2026-07-27 바닥 ROI 자동생성 설계 검토 (질의응답 · 코드 없음 · 문서 2건)

**세션 요약** — 마스터 질문 "리얼카메라 프리셋 화면에 주차면 ROI 를 자동으로, 결정론적으로 그릴 수 있나" → 설계 검토만 수행. **코드 변경 0**. 문서: `SettingAgent/docs/20260727_202948_자동_바닥ROI_생성_설계.md`, `20260727_205257_부트스트랩_주차면_무드로잉_자동화.md`.

- **핵심 발견: 수학의 90%가 이미 있다.** `src/ground/groundModel.ts`(quad+2.5×5.0m → 소실점 → f → 지면평면 n,d) + `src/ground/project.ts`(`backprojectToGround`/`projectToPixel`). `types.ts:70` 의 `source: 'file' | 'auto'` 에서 **`'auto'` 는 이미 예약**. 빠진 건 **역방향(모델→사각형) 배선**뿐 — 현재 `groundInputs.ts` 는 시뮬레이터 `PtzCamRoi.json` → 모델 방향만 쓴다.
- **손 드로잉의 정보량 = 6개 숫자**(`f, n, d, θ, u₀, v₀`). 슬롯 20개 그리면 좌표 160개지만 독립정보는 6개 → 160개는 중복 인코딩이고 서로 미세 불일치까지 있다. **ROI JSON 을 authored → derived 로 전환**하는 것이 설계 골자(주차장 지면 격자가 정본, 프리셋별 ROI 는 투영 산출물).
- **결정론은 공짜로 따라온다**: `projectToPixel` 이 순수함수(난수·NN·프레임 의존 0). "학습으로 결정론"이 아니라 **"학습 결과를 동결해서 결정론"**. 운영 중 자동 재추정 금지가 핵심 규율.
- **★ 부트스트랩의 실체는 스칼라 1개** — `f`=`focalFromZoom(zoom,fovBaseV)`(lens-calib), `n`=`[0,cos t,sin t]`(PTZ tilt, `groundModel.ts:505` 의 `tiltDeg=asin(n[2])` 의 역)는 드로잉 없이 나온다. **미지수는 `d`(카메라고) 하나뿐이고 프리셋 불변량**. 즉 "첫 주차면 그리기"=미터 스케일 1개 정하기.
- **차량 3D 육면체는 부트스트랩 불가(순환)** — `contact.ts:60` 의 `CuboidBuildInput` 이 `ground: GroundModel` + `slotPolysPx` 를 **입력으로 요구**한다. 더 결정적으로 `contact.ts:7`: **`L = 항상 prior(뒤 접지선은 원리적으로 안 보인다)`** → 차량 전장은 영원히 관측 불가, 폭만으로는 편차 ±15% → `d` 오차가 격자를 무너뜨린다. **교차검증용으로만 쓸 것.**
- **소스 계층**: L0 노면도색선(원리적 최강 — `d`·θ·**원점 2DOF** 전부. `groundModel.ts:550` 이 "이미지 증거 없이 검출 불가"라 명시한 그 증거. 단 LSD/Hough 신규 구현 필요) > **L1 번호판(실전 최적 — 실치수 법정고정 520×110/335×155, 이미 수집 중, 지면모델 순환 없음, 마모 없음)** > L2 줄자 실측 > L3 수동 1개(안전망, **반드시 유지**).
- **번호판 → d**: 판 quad+f → IPPE(닫힌해, RANSAC 불필요) → 판중심 `X_p` → **`d = n·X_p + h_p`** (h_p≈0.50m). h_p ±0.08m → 카메라고 6m 기준 d 오차 **1.3%**. 판 다수 median 으로 개별 편차 상쇄. 판중심을 h_p 내리면 지면점 → θ·원점까지 부수 산출.
- **코워크 판단**: 병렬 이득 = 독립 증거원 4트랙(독립성이 목적 자체 — 순차하면 앵커링 오염)·적대적 반증·프리셋 스윕. 병렬 손해 = **기하 설계 자체**(f,n,d,θ,u₀,v₀ 가 얽혀 있어 일부만 본 에이전트는 자신있게 틀린다)·B-1. 순서는 **조사(Workflow 팬아웃) → 결론 → 구현(parkagent-dev)**.
- **B-1 의 성격**: 설계도 QA 도 아닌 **전제 실측(feasibility probe)**. 검증 대상이 우리 코드가 아니라 **우리 가설**이고, 실패하면 코드가 아니라 **설계를 버린다**. goal/loop B모드의 `05_leader_empirical` 자리 → `parkagent-dev` 없이 단일 진행이 맞다.
- **실데이터 확인**: `data/Place01/PtzCamRoi.json`(cam1, 프리셋 3개, 픽셀좌표, **Unity camera position `[-9.5, 5.0, -7.1]` → 카메라고 GT = 5.0m**), `data/plate_discovery.json`(2026-07-24, 판 OBB 정규화 4점, cam1/preset1 slot 1..N). **절대 정답 대조가 가능한 조건.**

**★ B-1 전제 실측 실행 결과(같은 날 진행 · 저장소 코드 변경 0 · 스크래치 조사)** — 문서 `20260727_205257_*` §9 에 전문.

- **트랙 A(quad→지면모델) 완벽**: 3 프리셋 전부 `d=4.9500m`(GT 5.0 대비 −1.00%, **편차 0.00%**), `metricErr=0.00%`, 추정 tilt 가 PTZ tilt 와 소수 둘째자리까지 일치(8.70/20.10/35.80). → **설계 전제 2개 실측 확인: ① `d` 는 프리셋 불변량 ② `n=[0,cos t,sin t]` 유효.** −1% 는 3 프리셋 공통 계통오차라 격자에 무해.
- **트랙 B(번호판→d) 불합격**: preset1 −3.78% / preset2 +9.25% / preset3 +6.14% (기준 5%). 개별 판 산포 −14~+16%. **역산 h_p 가 프리셋 간 0.09/0.74/0.25m** — 상수(≈0.5m)여야 할 값이 흔들림.
- **★ 원인 = 조건수 붕괴(구현 문제 아님)**: 코너 **±1px** 섭동 → |Δd| 가 판 115×34px 에서 **10%**, 44×13px 에서 **64%**. **오차 ∝ 1/h_px²**(판 높이 2.6배 → 오차 6.4배≈2.6²). 관측 산포가 최악 1px 케이스보다 **작다** → 검출기가 아니라 **방법이 원리적으로 병조건**. 근본원인은 **13~17px 짧은 변으로 판의 면외회전(자유 6DOF pose)을 푸는 것**. 5% 달성에 필요한 판 높이 **≥49px**(폭 230px), 2%면 ≥77px — 실측 프리셋(13~35px) 전부 미달.
- **다음: B-1b** — **판은 지면에 수직**이라는 물리 제약으로 6DOF→4DOF, 스케일을 **긴 변(45~116px)** 에서만 뽑는다. 오차가 `1/h²`→`1/w` 로 바뀜, 예측 ~1.7%. 통과하면 L1 부활, 실패하면 L1 접고 **L0(노면 도색선)** — 도색선은 지면 위라 이 문제가 원리적으로 없다.
- **판정**: 버릴 것은 설계가 아니라 **판 pose 추정 방식**. 그리고 트랙 A 가 완벽하므로 **L3(수동 1개 → 전 프리셋 자동)은 지금 당장 구현 가능**하다.
- 함정 2건(내 구현 버그, 재발 방지용): ① 넓고 얇은 판은 **y 정렬로 코너를 못 맞춘다**(기울기가 높이와 맞먹어 섞임 → 종횡비 0.30) — OBB 의 **순환 순서**를 보존해야 한다. ② 감김 반전 시 `[c0,c3,c2,c1]` 로 뒤집으면 **긴 변이 앞자리에서 밀려나** 종횡비가 역수가 된다 — `[c1,c0,c3,c2]` 가 옳다.

**★ B-1b(판 수직 구속 4DOF) 실측 결과 — 조건수 해결 확정 / 정확도 미달** (문서 §9-5·9-6)

- **목적 달성**: 1px 섭동 |Δd| 가 **10~64% → 0.5~3.5%(median 1.39%)**. 44.7×13.3px 판이 64.4%→**3.5%**. **예측(~2%)과 실측이 일치 → 원인 진단이 옳았음 확인.**
- **그러나 d 정확도 미달**: preset1 −4.04% / preset2 −5.51% / preset3 **+21.06%** (A 대비, h_p=0.5 가정 시).
- **★ 새 수확: 재투영 RMS 가 품질 판정자로 작동**. 자유 6DOF 는 4점·6DOF 라 **항상 잔차 0 → 품질을 알 수 없었다**. 수직구속은 8식·4미지수라 잔차가 남고 그게 "이 판에 수직 가정이 맞는가"를 말한다. preset3 slot12(RMS 5.10px → d +38% 쓰레기)를 **게이트가 정확히 걸러냈고** 남은 판은 +2.78%.
- **h_p 는 가정이 아니라 사이트 캘리브 상수** — preset1 에서 1회 캘리브하면 **0.700m**(가정 0.5m 와 0.2m 차이). Unity 차량 판 높이가 0.5m 가 아니었을 뿐. 오차가 아니라 측정 대상.
- **실패 성격이 바뀜: 노이즈 문제 → 계통 문제.** 그리고 **표본이 절대 부족**(게이트 후 preset3 판 1개, preset2 0개, 전체 13개).
- **미해결 4건**: ① **preset2 계통 잔차**(판이 제일 큰데 RMS 3.5~6.6px 로 최악 — 프리셋 단위로 뭉치므로 **`n` 자체가 틀렸을 가능성**(roll≠0). 검증: n 을 2DOF 자유로 풀어 필요한 보정량 관찰) ② 표본 확대(시간 누적) ③ **결합추정**(한 프리셋의 모든 판이 같은 d 공유 + h_p 사이트상수 제약 동시최적화 — 개별 median 보다 강건) ④ ψ 월드방위: preset1 353.8°/preset2 359.5°(양호) vs preset3 87.1°(**약 90° 차 → 다른 주차열 가능성**, 격자 원점·방위 설계에 직접 영향).

**인수인계 요약** — 다음 단계는 **B-1b 미해결 ①(preset2 의 n 검증)** 과 **③(결합추정)**. 통과 시 Workflow 팬아웃 → 구현. 별개로 **L3 경로(수동 1개 → 전 프리셋 투영)는 이미 근거가 확보**되어 착수 가능. **미해결 리스크**: `floorRoi.ts` 의 LLM 폴리곤 경로와 자동 격자 경로가 **동시에 `slot_roi` 를 쓴다** — 정본 우선순위를 구현 전에 확정하지 않으면 조용히 서로 덮어쓴다.

## 2026-07-27 정밀수집 페이지 렌즈 캘리브레이션 웹 UI (워크트리 `feat-lens-calib-web-ui`, 커밋 1d38f9e · 미머지)

**세션 요약** — 2026-07-26 미결 "(1) 웹에 캘리브레이션 버튼(`/calibrate/lens/*` 라우트+UI) 없음, 표 생성은 CLI" 를 해소. 설계서 `SettingAgent/docs/20260727_111602_*`, 구현·영향도 `20260727_130533_*`.

- **엔진 무변경**: `packages/lens-calib` 의 `CalibrationRunner` 가 이미 `onProgress`(진행/로그)·`AbortSignal`(정지)·`finally { goHome() }`(원 PTZ 복귀)를 제공 → 신규는 **(a) 잡 (b) 얇은 라우트 (c) UI 카드** 3겹뿐.
- **`LensCalibrationJob`**(PlateDiscoveryJob 패턴): `idle→running→done|aborted|error`, 중지는 **stopping 경유**(abort 후에도 카메라가 귀환 중이라 즉시 idle 이라 말하면 안 된다). 중지는 error 가 아니라 aborted. 로그는 **링버퍼 500 + seq 증분 폴**(SSE 미도입 — 저장소 전체가 폴 방식이고 `pollPlan` 이 검증돼 있다), 넘치면 `logsTruncated`. `usable:false` 샘플은 사유와 함께 warn.
- **점유 충돌 409**: 정밀수집/센터라이징/탐색이 running 이면 시작 거부. 잡이 남의 클래스를 import 하지 않고 `isBusy` 클로저만 주입받는다(index.ts 배선).
- **★ `RealPtzSource` 재사용 불가**(중요): 뷰어 소스는 정규화 좌표 + **보정이 이미 걸린** 경로라, 그걸로 재면 "재려는 대상을 보정 너머로" 재게 된다. 네이티브 단위 + rawAim 이 필수 → `realLensVerify.ts` 의 검증된 포트 조립을 `src/calibrate/hucomsCameraPort.ts` 로 **복사 이식**(CLI 는 .gitignore 라 서버가 의존할 수 없다).
- **표 쓰기 규칙**(`lensCalibFile.ts`): 한 카메라 항목만 upsert(타 항목·`_comment` 보존), **새 표는 항상 `enabled:false`**(검증 전 자동적용 금지), 실측 표가 들어오면 `model` 제거(두 출처 공존 금지), 축끼리 안 지움, `stringify5`.
- **UI**: LPD 검지 카드 뒤 `#lens-box`. 기존 카드 클래스 재사용 → CSS 추가는 `.op-log`·`.op-target` 2블록. 대상 카메라 **배지**(무엇을 점유하는지 클릭 전에 보여준다), 긴 모드 확인창, sim 사전 차단, 단일 폴 타이머, 새로고침 복구(결선 시 `lensPoll()` 1회). 순수 뷰는 `core.js` `lensCalibView`.
- **검증**: vitest **2884 pass** / tsc 0 / 신규 89케이스(5파일) + `viewerPtzSyncCoverage` 에 신규 5라우트 분류 등록(**필수** — 누락 시 기존 테스트가 실패한다). 기존 실패 1건(`buildTouringPlan`)은 워크트리에 gitignore 대상 `save/setup_result.json` 이 없어서 — 기존 현상.
- **실카 154 라이브**(포트 **13030** 임시 기동 — 마스터의 13020 과 충돌 회피, 확인 후 종료·config 원복): **verify 완주 pass · 최악 8.4px · 17/18**, 적용/필요 게인 세 줌 모두 1~2% 일치. **중지 → stopping → 원 PTZ 복귀 → aborted** 확인. 증분로그(sinceSeq)·apply(restartRequired)·`/viewer/` 정적서빙 반영 확인. verify 가 보정표를 안 건드리는 것도 git 으로 확인.
  - ⚠️ 8.4px 는 07-26 의 2.4px 보다 크다(판정은 pass). 장면·조도 차이로 보이며 이번 범위와 무관 — 원인 규명은 별건.
- **미검증**: `full`(25~40분)·`distortion`(10~15분) 실카 완주는 안 했다(유닛 목만). 브라우저 수동 클릭도 안 했다(DOM 자동화 없음 → 정적 봉인으로 대체). **기존 탭은 하드리로드 전까지 옛 JS** 라는 07-24 함정 여전히 유효.
- **운영 유의**: ① 표 적용은 **서버 재시작** 필요(`sourceRegistry` 가 기동 시 1회 로드 — 핫리로드 미도입) ② `full` 을 돌리면 그 카메라가 `enabled:false` 로 **강등**되어 apply 전까지 보정이 꺼진다(154는 현재 ON) ③ 곡면율 reject 는 정상 결과(2026-07-25 시차 교란 결론).
- **함정(내 실수 기록)**: 이 메모를 쓰다 백틱이 셸에 먹혀 memo.md 가 깨졌고, `git checkout -- 메모/memo.md` 로 되돌리려다 **마스터의 미커밋 07-25·07-26 항목을 날렸다**(memo.md 는 미커밋 상태로 유지되고 있었다). 세션 초반에 읽어둔 원문으로 복원했다. → **memo.md 는 커밋되지 않은 채 쌓이므로 `git checkout` 절대 금지**, 편집은 파일 경유(heredoc/Write)로 할 것.

---

## 2026-07-25 광각렌즈 곡면율(방사왜곡) 캘리브레이션 컴포넌트 제작 + 실카 연동(기본 OFF)

**세션 요약 (브랜치 `feat/lens-distortion-calibration`, 커밋 dea1384 · 미머지 · 실카 검증 진행 중)**

- 발단: 마스터가 `unity/centering/`(참조본, 실기 Hucoms 검증 운영코드 JS)를 보고 "광각렌즈 곡면율 캘리브레이션을 TS로 다시 설계해 제작"을 지시. "독립 컴포넌트로 쓰기 쉽게".
- **중요 방향전환**: 처음엔 "단위(픽셀/centidegree/zoompos)가 ParkAgent(정규화/도/배율)와 달라 전량 재설계"로 판단했으나 **틀렸다**. 코드 실사로 참조본=우리 카메라(Hucoms) 것임을 확인 — `RealPtzSource.centerPtz` 와 와이어포맷·좌표기준(0~1920/1080)·zoompos 포화(16384) 모두 동일. → **재설계 폐기, 이식 + 곡면율 축 추가**로 전환(설계서 R2).

**만든 것: `packages/lens-calib` (@parkagent/lens-calib, 의존성 0)**
- 참조본 화각(`zoomHfov`)·게인(`centeringGain`) 두 표를 TS 이식(프리셋 cam-001 황금값 고정) + 참조본이 §7-5에 미모델링으로 남긴 **곡면율(`lensDistortion` k1,k2) 세 번째 축 신규**.
- 게인=편심 1승 오차 / 곡면율=편심 3승 오차 → 서로 못 대신함. 조준 3단 `undistort→×k→clamp`. **k1=k2=0이면 참조본 식과 비트 동일**(회귀 0 근거).
- 곡면율 측정=**회전 광류 격자**(클릭 스윕은 착지가 중앙 근처라 가장자리 왜곡 못 봄). (f,k1,k2) Nelder-Mead + 과적합 게이트(자유도 승급 + 개선율·코너변위). A/B 자가판정(adopt/reject) — 2026-07-21 tan기각 실험의 자동화판.
- **2026-07-21 tan기각과 충돌 안 함**: 그건 시뮬 렌더 A/B였고 1-파라미터 이지선다였음. 곡면율 항 넣으면 선형·tan 둘 다 특수해. 예측대로 **k1<0(배럴)** 나옴.

**검증**: 패키지 유닛 99개 green·tsc 0. goal/loop 경험검증 — 실카해상도 1920에서 k1복원 4.2%(목표≤5%, 저해상도 오차는 목텍스처 에일리어싱). SettingAgent 전체 **2811 green**·tsc 0(회귀 0).

**연동(기본 OFF)**: `RealPtzSource.centerOnPoint`에 `lensCorrector` 주입(기본 IDENTITY=비트동일). `src/calibrate/lensCorrection.ts` 어댑터(파일없음/비활성/빈표 → 항등). **활성화는 실측 후 수동**(sourceRegistry 배선 1줄 미착수 — 검증된 표 없으면 speculative).

**문서**: 설계 `SettingAgent/docs/20260725_002405_*.md`(R2), 구현·영향도 `20260725_123605_*.md`, 패키지 `README.md`.

**실카 실측 완료 (일회성 도구 `SettingAgent/realLensVerify.ts`, 미커밋 — env: CAM_HOST/CAM_USER/CAM_PASS)**
- ⚠️ **153은 다른 곳에서 동시 제어 중 → 충돌**. 마스터 지시로 **154로 전환**. 153 곡면율 1차 결과(잔차 56~66px)는 충돌 오염이라 **무효**. 153은 더 건드리지 않음(이미 남의 작업 중 슬루시킴).
- 자격증명: 153=admin/admin, **154=admin/`mts6500!!!`**(config `cameraSources[].password`에 있음. 154는 다른 값이라 처음에 401).
- **154 검증 패스 = PASS, 최악 잔차 2.4px**(17/18). 적용게인 vs 필요게인 0.988/0.99·1.11/1.104·0.765/0.768 — **cam-001 프리셋이 154 개체에도 거의 완벽히 맞음**. 두 물리 개체 공통 확인.
- **154 곡면율 스윕 = A/B fail → reject(안전장치 정상 작동)**. 핵심 발견: **z0(최광각) 잔차 33px인데 k1 넣어도 안 줄어듦** = 방사왜곡 아님. 채택된 z5129 k1=+0.17은 **양수(핀쿠션)** = 잔차 지배하는 비방사 성분(PTZ 팬축·광학중심 오프셋 시차, 근거리 주차장)에 낀 아티팩트. → **회전-광류 곡면율 측정은 이 카메라 와이드줌에서 시차에 교란**되고 실제 방사왜곡은 이 방법 노이즈 바닥 아래.
- **대응 조치(커밋함)**: 설계 §3이 약속한 **배럴 부호 게이트(k1<0만 채택)** 를 `solveDistortionZoom`에 구현 + 유닛테스트. 스퓨리어스 핀쿠션 채택 차단. 패키지 100 green.

**▶ 결론/다음**: 배포 성과 = **게인 프리셋이 실기 검증됨(verify PASS, 2.4px)** → RealPtzSource 연동은 게인만으로 켤 가치 있음. 곡면율은 **현 회전-광류 방식으로는 이 PTZ에서 채택 불가**(시차 교란). 정말 필요하면 시차 보정(회전중심-광학중심 오프셋 추정) 또는 원거리 장면 전용 측정이 선행돼야 함 — 별건. `ZoomMap`(zoompos↔배율)은 체크포인트 (B) 대응 그대로 유효.

### 2026-07-26 이어진 작업 (실카 154 검증 + 게인 보정 활성화 — main 커밋·푸시 완료)
- ⚠️ **테스트는 153 아니라 154(real-camera-2)로.** 153=real-camera-1은 다른 곳에서 상시 사용 중 → 충돌(fetch failed 폭주). 자격증명: 153=admin/admin, **154=admin/`mts6500!!!`**(config에 있음).
- **실측 도구 `SettingAgent/realLensVerify.ts`**(.gitignore): 이제 **`CAM=<id>`로 config에서 host·자격증명 자동 로드**, 미지정 시 **기본 154**(153은 CAM=real-camera-1 명시해야만). 셸: PowerShell은 `$env:MODE='verify'; npx tsx realLensVerify.ts`(인라인 `MODE=verify`는 bash 전용).
- **154 검증**: 낮에 **PASS 2.4px**(세 줌), 야간엔 z8000만 측정(2.2~2.7px 게인 일치)·z0/z16384는 저조도·무늬부족으로 incomplete(코드문제 아님, 컴포넌트가 정직 보고). → **게인 프리셋 적합 충분히 확인**.
- **게인 보정 활성화(커밋 fee0159, origin 푸시 완료)**: `data/lens_calibration.json`에 `{id:'real-camera-2', model:'cam-001', enabled:true}` + `sourceRegistry` 실카 2곳에 `loadLensCorrector(파일, src.id)` 주입. **소스 id 매칭**(뷰어 cam 번호 모호 회피, camIdx 하위호환). 런타임 확인: 154=보정적용/153·simulator=항등. tsc 0·SettingAgent **2812 green**(회귀 0). 끄기=enabled:false/파일삭제.
- 사용 가이드: `packages/lens-calib/사용가이드_캘리브레이션과_클릭사용법.md`(캘리브레이션 실행·클릭 사용법, PowerShell/bash 양쪽).
- **적용하려면 서버 재시작 필요** — 이 환경엔 **nodemon 미설치라 `npm start` 실패**, **`npm run dev`(tsx watch) 사용**. 웹 http://<IP>:13020/ → real-camera-2 선택 → 클릭 조준(가장자리 특히 개선).
- 미결/후속: (1) 웹에 캘리브레이션 버튼(`/calibrate/lens/*` 라우트+UI) 아직 없음 — 표 생성은 현재 CLI. (2) 곡면율 시차 보정은 별건. (3) 154 깨끗한 3줌 pass는 낮·무늬방향에서 재측정하면 나옴.

---

## 2026-07-24 초당 3프레임 패킷 부활 — 근본원인(편도 폴백) 제거 + 연결폴 30초 + 패킷로그 5분 요약

**세션 요약 (브랜치 `fix/live-stream-poll-and-packet-log` → main 머지, origin 푸시 완료 · vitest 238files/2800 green · tsc 0)**

- 발단: 마스터가 로그 스샷 2장(`fetch failed` 도배 / `status:200` 도배)과 함께 "초당 3프레임 요청 패킷이 부활했다. 근본 원인을 파악해줘".

**① 근본원인 — 뷰어의 MJPEG→폴링 폴백이 편도(one-way)였다**

- 3fps 폴링을 켜는 경로는 저장소 전체에 단 하나 — `app.js` `fallbackToPolling()` → `loop.start(fps=3)`. 트리거는 `<img src="/viewer/api/stream">` 의 `onerror`.
- **스트림으로 돌아오는 자동 경로가 없었다.** 복귀는 사용자가 시작 버튼·cam/preset 변경을 눌렀을 때뿐. 4초 `connectionTick` 은 Unity 재연결을 감지해 뱃지만 켤 뿐 스트림을 복구하지 않음.
- 로그 실증(`logs/setting_20260724_215422.log`): 21:54:22 서버 재기동 → MJPEG 절단 → 폴백(3.3/s, 전부 fetch failed) / 22:18:03 Unity down 상태에서 라이브 재시작 → `/stream` 502 → 재고착 / 22:18:17 Unity 기동 → **6.3/s 로 7분+ 지속**. 1프레임 = `mode=manual` 스냅샷 = `cam.setPTZ` + `cam.captureJPG` **2 RPC**(로그의 `ms:2~15`/`ms:58~76` 교대가 증거). 즉 뷰어가 카메라에 **초당 3회 제어 명령**을 쏘고 있었다.
- 클라이언트는 서버가 아니라 **Chrome 탭**(pid 확인, `src/` 에 `setInterval` 0건). 그 시점에도 `/viewer/api/stream` 은 200/11.7MB(3초)로 **정상** — 고장난 건 탭의 `liveMode='poll'` 상태였다.

**② 수정 — 폴백 코드 자체를 삭제하고 스트림 자동 재시도로 대체**

- 삭제: `fallbackToPolling()`, `liveMode` 의 `'poll'`, `core.js` `fpsToInterval()`, `createStreamLoop` 의 타이머(`start`/`setTimer`/`clearTimer`), `index.html` 의 fps 입력, 대응 d.ts·테스트. **존치**: 라이브 off 의 1회 스냅샷(`snapshot.tick()`).
- 개명: `createStreamLoop` → `createSnapshotFetcher(deps) → { tick, abort }` (타이머 빠지면 이름이 사실과 불일치).
- 대체: `core.js` 순수함수 `nextStreamRetryDelay(prev)`(1s→×2→30s cap)·`streamRetryLabel()` + app.js 결선(`cancelStreamRetry()` 를 **타이머 소유 단일 지점**으로, 콜백에 `liveMode` 가드). `onload` = 백오프 리셋(MJPEG 는 프레임마다 발화). 최악에도 **30초당 1요청**.
- qa 가 잡은 엣지 1건 보정: 실패 직후 시작 재클릭 시 **동일 URL 재대입**을 브라우저가 생략해 또 다른 고착 가능 → 실패 이력이 있을 때만 캐시버스터 `_r`. 정상 경로 URL 형태는 불변.

**③ 연결폴 4초 → 30초** (`web/app.js` `CONN_POLL_MS = 30000`)

- 라이브 중이면 스트림 `onerror`/`onload` 가 연결을 실시간 통지하므로 폴은 배경 동기화 역할만. 30초를 상한으로 본 근거: 그 이상이면 Unity 기동 후 목록 미반영 구간이 길어져 **수동 새로고침(F5)** 을 유발(그게 더 비싸다).

**④ 패킷 로그 5분 요약** (신규 `src/util/packetAggregator.ts` 순수모듈 + `packetLog.ts` 결선)

- 정책 4: **같은 키 첫 발생은 즉시 기록**(이번 진단이 최초 발생 시각·케이던스로 가능했으므로 진단력 사수) / 이후 반복만 5분 창 집계 / **실패·비-2xx 는 항상 즉시**(level 40 승격) / `n<=1` 이면 요약 생략.
- 집계 키 `METHOD url(쿼리제거)#op` — 쿼리 제거는 Hucoms 가 id/passwd/좌표를 쿼리에 실어 **키 무한증식**(부수효과로 자격증명 미유입), `op` 는 `/rpc` 하나에 `cam.list`/`cam.setPTZ`/`cam.captureJPG` 가 뭉개지는 것 방지. `fetchWithTimeout` 에 선택 인자 `op?` 추가(다른 호출자 무영향).
- 플러시는 **지연 sweep(타이머 0개)**. qa 지적으로 **`span` 필드 추가** — `win` 만 쓰면 침묵 구간이 섞여 rate 가 최대 1/100 로 과소평가된다. 판독: 활성 rate `(n-1)/span*1000`, 창 평균 `n/win*1000`, 침묵량 `win-span`.
- 라이브 실측: `23:39:52 즉시 → 23:44:52 요약{win:303972, span:299971, n:76, ok:76, msAvg:10}` + 즉시 1줄 = **5분에 3줄**(종전 76줄). 활성 rate 0.25/s = 4초 간격 → **그 시점 브라우저가 하드리로드 전이라 30초가 미적용**임이 요약 한 줄로 드러남(진단력 보존의 실증).

**함정·인수인계**

- `web/*` 는 **nodemon 감시 밖**(`src` 만 감시). 뷰어 코드를 고쳐도 **하드리로드(Ctrl+Shift+R) 전까지 기존 탭은 옛 코드로 계속 돈다** — 이번 고착도 그래서 오래 살아있었다. 다음 세션에서 뷰어 변경 후엔 항상 이걸 먼저 확인할 것.
- 미검증 한계: 실브라우저 스모크(F21~23), MJPEG 의 프레임별 `onload` 발화·동일 URL 재요청 생략 여부는 node 유닛으로 재현 불가. `/ptz?cam_idx=N` 은 쿼리 제거로 카메라별 관측력 상실(한계로 수용).
- 문서: `docs/20260724_225404_라이브스트림_폴링폴백제거_자동재시도.md`, `docs/20260724_234344_연결폴30초_패킷로그5분요약.md`. 감사 산출물 `_workspace/00~08`.

## 2026-07-24 프리셋 순서값(id) 도입 — 분석탭 첫 열 + DB preset_info.id 첫 컬럼 배치

**세션 요약 (커밋 `1f044f1`, `1d7d3b2` · 워크트리 `preset-order-id` → main FF 머지, origin 푸시는 안 함)**

- 마스터 요청 2단계: ① 분석탭 `프리셋별 요약` 표의 **`프리셋 키`(1:1) 열을 순서(1부터)로 교체** ② **DB `preset_info` 에 id(순서값) 추가** → 이후 ③ **그 id 를 표시 맨 왼쪽으로**.
- ①: `app.js` 헤더 `['순서', …]` + `perPreset.map((p, i) => [i + 1, …])`. `core.js` `analyzeArtifact` 는 무변경(`perPreset[].key` 유지 — 다른 소비처 있음). 점유율 표의 `프리셋 키` 열은 **별개 표**라 안 건드림.
- ②: `id` 를 **파생값**으로 설계 — PK 는 `(cam_id,preset_id)` 유지, `id` = `(cam_id,preset_id)` 오름차순 1-based. `PresetInfoRow` 타입/writer 무변경(`roiDbLoad`·`migrateToSettingDb` 영향 0). `renumberPresetInfo()` 가 upsert 직후·구 DB ALTER 직후 **전체 재번호**(상관 서브쿼리 COUNT 단일 UPDATE, 행수=프리셋수라 비용 무시).

**③ 컬럼 재배치 — SQLite 제약과 정면충돌한 지점**

- DB 뷰어(`dbRoutes`)는 `PRAGMA table_info` 순서 + `SELECT *` 를 그대로 쓴다. 그런데 `ALTER TABLE ADD COLUMN` 은 **항상 맨 뒤** → id 가 화면 오른쪽 끝. SQLite 엔 컬럼 위치 변경 구문이 없어 **테이블 재작성이 유일한 방법**.
- `reorderPresetInfoColumns()`: 새 테이블 CREATE → `INSERT…SELECT` → `DROP` → `RENAME`. 순서가 이미 정본이면 no-op. 정본 순서/DDL 은 모듈 상수 `PRESET_INFO_COLS` / `PRESET_INFO_DDL(table)` 로 **CREATE 와 공유**(정의 이중화 방지).
- **PRAGMA 2개가 반드시 필요**(finally 원복): `foreign_keys=OFF`(자식 `slot_setup` 이 참조 중인 부모 DROP), **`legacy_alter_table=ON`** — 이 순간 slot_setup 이 '없는 preset_info' 를 참조하는 상태라 끄면 RENAME 이 스키마 파싱 오류로 실패한다. **이거 모르면 재작성이 통째로 깨진다.**
- **의도적 동작 변경**: 재작성이 정본 DDL 을 쓰므로 마이그레이션 DB 도 신규와 **스키마 수렴** → 컬럼 순서 동일 + `place_id` FK 강제. 기존 "수용된 divergence" 를 실증하던 적대적 테스트 2케이스를 **수렴 검증으로 갱신**. 실사용은 `PLACE_ID=1` 고정 + `roiDbLoad` 가 place_info(1) 선행 upsert 라 무해.

**함정 — WAL 빼먹은 사본으로 오판했다**

- 실가동 DB 검증 때 `data/setting.sqlite` **본체만** 복사해서 "실 DB 는 아직 구 preset_pos 단계" 라고 **틀리게 보고**했다. 이 DB 는 `journal_mode=WAL` 이라 최신 상태가 `-wal`(3.2MB)에 있다. 마스터 화면 스샷(5행 + id)이 반증.
- **규칙: 사본 검증은 `.sqlite` + `-wal` + `-shm` 을 함께 복사할 것.** 다시 검증하니 id 맨 앞·값 1~5 유지·slot_setup 23행 보존·`foreign_key_check []`·재오픈 멱등.

**검증**

- `vitest run` **2723 green**(메인 체크아웃 기준), `tsc --noEmit` 0. 신규 `presetOrderId.test.ts` 8케이스(뷰어 소스가드 2 + DB 6: 삽입순서 무관 1..N / 중간삽입 재번호 / 충돌 upsert id 유지 / 첫 컬럼 id / 구 DB 채움·멱등 / **재작성이 slot_setup 자식행·FK 보존**).
- 워크트리에선 `buildTouringPlan.test.ts` 1건 실패 — gitignore 대상 `save/setup_result.json` 픽스처가 워크트리에 없어서. **메인에선 통과**(내 변경 무관, 지난 세션 기록과 동일 현상).
- 브라우저 DOM 자동화는 여전히 없음 → 뷰어는 소스 가드 테스트로 봉인(`cameraKindSelect.test.ts` 선례).

**현재 상태 / 다음**

- main FF 머지 완료(`a7d0c39 → 1d7d3b2`), **origin/main 푸시는 미실시**(요청 없었음, ahead 2).
- **서버 재기동 필요** — 재기동 시 실 DB 에 재작성이 1회 적용되고, DB 탭·분석 탭 새로고침으로 눈으로 확인 가능(정적파일 `no-store`).
- `Docs/MyThink/my_db_table.md` 의 `- id : 프리셋 key 값` 줄은 **마스터의 미커밋 편집**이라 손대지 않음. 정확히는 `프리셋 순서값 ( 1부터 시작 )`.
- 작업 전부터 있던 미커밋 변경(`_workspace_*` 삭제분 등 50건)은 무접촉.

---

## 2026-07-24 전역 인덱스 수동 매핑 행 편집 + zone 열 제거 + 센터라이징 설명 정정

**세션 요약 (커밋 `2f4a98a`, 브랜치 `feat/manual-index-editable-rows` → main FF 머지·푸시)**

- 마스터 요청 3건: ① 정밀수집 화면 **센터라이징 설명이 틀렸다**(실제는 `setup_result.json` + DB `slot_setup`) ② 전역 인덱스 수동 매핑 표의 **모든 열을 편집 가능**하게(카메라·프리셋·프리셋내 위치), slotId 는 전역ID를 따라감 ③ **zone 의미 조사 후 무의미하면 삭제**.
- ①: `index.html:207` 문구를 `setup_result.json` + DB `slot_setup` 으로 정정. 구 표기 `centering_slot` 테이블은 2026-07-18 DB 개편 때 사라졌다(현 저장은 `PtzCalibrator.ts:423-425` = slot_ptz.json + `upsertSlotCentering`(slot_setup 부분 UPDATE) + setup_result 2벌). `slot_ptz.json` 은 여전히 쓰이지만 마스터가 지목한 2개만 문구에 넣었다.
- ③ **zone 판정 = 정보량 0 → 표에서 삭제**: 값 출처는 LLM `zoneLabels` 아니면 폴백 `cam{camIdx}` 뿐인데, **DB slot_setup 에 zone 컬럼이 없어** setup_result 에도 안 실리고 setup_artifact 안에서만 왕복한다. LLM 최소화 정책상 실값은 항상 `cam{N}` = 카메라 열 중복. `buildMappingRows` 의 zone 필드까지 제거(고아 정리). **단 `ParkingSlot.zone` 필드 자체는 유지** — 스키마·Finalizer·LLM 경로·분석 탭 '존' 카드가 물려 있어 요청 범위 밖.

**②의 설계 판단 (그냥 input 만 넣으면 반쪽)**

- 편집이 의미를 가지려면 **DB 정본에 반영**돼야 한다. 기존 저장 버튼은 `POST /mapping/renumber`(slot_id 재번호)뿐이라 배치 3컬럼용 경로를 신설: **`POST /mapping/placement`**(+뷰어 alias). `SqliteStore.updateSlotPlacement` 는 cam/preset/slotidx + updated_at 만 부분 UPDATE(기하·검출·센터링 무접촉).
- **함정1 — UNIQUE(cam,preset,preset_slotidx)**: 위치 교환(A↔B)을 행 단위로 UPDATE 하면 중간상태에서 제약이 깨진다. → ① 대상 행 `preset_slotidx` 전부 NULL 로 비우고 ② 최종값 적용하는 2단계 트랜잭션(SQLite 는 NULL 을 서로 다른 값으로 봄).
- **함정2 — 저장 순서**: 배치는 **현재** slot_id 를 키로 쓰므로 반드시 `placement` → `renumber` 순. 반대로 하면 남의 행을 고친다. 배치 실패 시 재번호는 아예 안 보낸다(DB 무변경 유지). 이 순서를 소스 정적 테스트로 봉인함.
- **함정3 — 부분 갱신의 침범**: `validateSlotPlacement` 는 미제출 행의 **현재 삼중키까지 시드로 넣고** 충돌을 본다. FK(preset_info 미등록 cam/preset)도 사전 차단해 500 대신 400.
- **의도적으로 안 한 것**: ROI 좌표 변환 없음(원 프리셋 화면 기준 정규화라 옮겨도 그대로 남음 → 재수집 필요), 센터링 PTZ 자동 삭제 없음(데이터 파괴 금지). 대신 안내문에 ⚠ 경고. `slot_ptz.json` 도 배치 변경 시 무접촉. **자동 클리어 정책이 필요하면 마스터 지시 대기.**

**검증**

- `vitest run` **2713 green**(신규 27: 서버 게이트 7 / 라우트 통합 6 / 클라 게이트 9 / UI 구조 봉인 5), `tsc --noEmit` 0.
- **라이브 HTTP 스모크**(임시 tsx 스크립트로 실서버 listen + 파일 SQLite): 이동 200 & DB 반영, 충돌 400 & DB 무변경, `GET /mapping` 재조립 `1→[1] 2→[3,2]` 확인 후 스크립트 삭제.
- 기존 가드가 신규 라우트 분류를 강제함(`viewerPtzSyncCoverage.test.ts` → NO_MOVE 등록). 브라우저 DOM 자동화는 여전히 없음(이전 세션 기록과 동일) → 마크업 정적 봉인으로 대체.

**현재 상태 / 다음**

- main FF 머지 후 origin/main 푸시 완료. `feat/manual-index-editable-rows` 브랜치는 남겨둠(정리 가능).
- 실제 브라우저 화면 확인은 미실시 — 서버 띄우고 분석 탭에서 표 렌더·입력·저장 왕복 1회 눈으로 볼 것.
- 작업 전부터 있던 미커밋 변경(`config/tools.config.json`, `data/*.json`, `_workspace_*` 삭제분)은 손대지 않음.

---

## 2026-07-24 뷰어 Touring Test 버튼 이동 + result 파일 생성 버튼 제거 (워크트리 세션)

**세션 요약 (커밋 1개 `cfc8d34`, 워크트리 `worktree-work-20260724` / 브랜치 동명)**

- 마스터 요청 2건: ① 정밀수집 툴바의 **Touring Test** 버튼을 아래 **센터라이징** 영역으로 이동 ② **result 파일 생성** 버튼 제거(센터라이징 끝나면 `setup_result.json` 자동 저장되므로).
- 구현: `web/index.html` 에서 `#cap-touring` 을 `.cap-actions.toolbar.capture-actions` → `.centering-inline` 의 **삭제된 `#cal-result-file` 자리 그대로** 이동. `.centering-inline` 이 `auto / minmax(0,1fr)` 2열 그리드라 **CSS 무변경**으로 `[센터라이징] [Touring Test]` 한 행 배치가 나온다. `web/app.js` 에서 `makeSetupResultFile()` 핸들러+결선 삭제(고아 코드 제거), `#cap-touring` 은 id 불변이라 `runTouringTest` 결선 그대로.
- **버튼 제거가 안전한 근거**: 파일 생성 진입점은 `writeSetupResultFiles()` 하나뿐이고 호출처 3곳 중 정상 경로는 `PtzCalibrator.saveSetupSnapshot()`(센터라이징 완료 시 자동). 나머지는 재번호 경로(`server.ts`)와 버튼이 쓰던 `POST /capture/setup-result`.
- **`POST /capture/setup-result` 라우트는 남겼다** — 지금 호출자는 테스트뿐이지만, 공개 REST 표면 삭제는 UI 요청 범위 밖. 정리 여부는 마스터 판단 대기(문서 §6에 명시).

**검증**

- 신규 가드 4건: `buildTouringPlan.test.ts` 에 버튼 위치(`.centering-inline` 안 `#cal-start` 뒤 · 툴바엔 없음)·결선 유지 2건, `setupResultRoute.test.ts` 의 기존 "버튼 존재" 검증 2건을 **재추가 방지 가드**(`not.toContain`) 1건으로 교체.
- `tsc --noEmit` 0 / `vitest run` 2656 pass. **잔여 실패 2건은 기존 데이터 의존 실패** — `buildTouringPlan.test.ts` 의 실데이터 픽스처가 gitignore 대상 `save/setup_result.json` 을 읽는데 현 파일은 23슬롯 `centering` 이 **전부 null**(마지막 생성 이후 미센터라이징). **변경 없는 main 체크아웃에서도 동일 재현**(14 pass / 2 fail) 확인 — 내 변경 탓이 아님. 센터라이징 1회 돌리면 해소.
- 라이브(13020): 뷰어 정적파일이 `Cache-Control: no-store` 라 **서버 재시작 없이 새로고침만으로** 반영됨을 실측. 서빙 HTML/JS 에서 새 배치·`cal-result-file` 0건·`makeSetupResultFile` 0건 확인.
- 브라우저 DOM 자동화(playwright/jsdom)는 이 저장소에 **없다** — 뷰어 검증은 기존 방식대로 마크업·결선 소스 검사로 한다.

**동시 세션 충돌 처리 (상대편 기록과 대칭)**

- 머지하려 메인 체크아웃을 `main` 으로 전환한 순간, 세션 시작엔 없던 **다른 세션의 미커밋 스키마 WIP**(`PresetPosRow→PresetInfoRow` 계열, src+테스트 20여개)이 드러났고 `test/setupResultRoute.test.ts` 가 겹쳐 머지 거부됨.
- **남의 WIP은 손대지 않는 쪽**으로 처리: 브랜치를 원래 `feature/preset-pos-to-info` 로 되돌리고, 작업트리를 건드리지 않는 **`git push . worktree-work-20260724:main`** 으로 main ref만 FF. 워크트리 공유 스택이므로 **stash는 쓰지 않았다**.
- 이후 상대 세션이 그 위로 rebase 해 `origin/main aa4d4a3` 에 함께 올라감. 최종 확인: `origin/main` 이 `cfc8d34` 포함, 내 파일 5개 중 4개 바이트 동일, `setupResultRoute.test.ts` 3줄 차이는 상대의 스키마 개명이 얹힌 정상 결과. 내 가드 테스트 3건 origin/main 에 생존.

**현재 상태 / 다음**

- 푸시 완료 상태(내가 민 게 아니라 상대 세션 rebase 편승). 워크트리 `worktree-work-20260724` 는 역할 종료 — 정리 가능.
- Touring Test 실동작 확인은 아직 못 함: `save/setup_result.json` 의 `centering` 이 전량 null 이라 지금 누르면 **전 슬롯 skip**. 센터라이징 1회 후 재확인 필요.

---

## 2026-07-24 DB 테이블 preset_pos → preset_info 리네임 + 누락필드 추가 — main 병합·푸시 완료

**세션 요약 (커밋 4개, origin/main `aa4d4a3` 반영)**

- 발단: 마스터가 `my_db_table.md`에 §camera_info·§preset_info 정의를 붙이며 "DB테이블 추가및 생성해줘".
- **선확인으로 방향이 바뀐 건**: `camera_info`는 **이미 스키마에 완전 존재**(§3 정의와 일치, +img_w/img_h)라 만들 게 없었고, `preset_info`는 기존 `preset_pos`와 pos가 중복이었다. 이 중복을 물었더니 마스터 결정 = **"preset_pos를 preset_info로 이름 바꾸고 없는 필드 추가 + 사용처도 수정"**.
- 확정 스키마: 테이블 `preset_pos`→`preset_info`, 컬럼 `sname`→`preset_name`(기존 sname이 곧 프리셋 라벨), 신규 `place_id`(기본 1), `pan/tilt/zoom` REAL 3컬럼 유지(pos용 JSON 컬럼 새로 만들지 않음), `slot_setup` FK 갱신. 타입 `PresetPosRow`→`PresetInfoRow`, 메서드 `upsertPresetPos`→`upsertPresetInfo`.

**핵심 기술 함정 2개 (설계 단계에서 잡음 — 그냥 짰으면 깨짐)**

1. **ensureSchema 순서 역전 필수**: 기존 DB에서 `CREATE TABLE IF NOT EXISTS preset_info`가 먼저 돌면 **빈 preset_info가 생겨** 뒤이은 `ALTER TABLE preset_pos RENAME TO preset_info`가 "이미 존재"로 실패. → 리네임 마이그레이션을 **CREATE 블록 이전**에 배치.
2. **`foreign_keys=ON` + `ADD COLUMN ... REFERENCES ... NOT NULL DEFAULT 1` 동시 불가**(SQLite 규칙: FK 활성 중 REFERENCES 컬럼 ADD는 기본값 NULL이어야 함). → ALTER 경로는 REFERENCES 생략, 신규 CREATE 경로만 REFERENCES 유지. **place_id FK divergence는 수용**(place_id 항상 1·place_info(1) 상존. 엄격 동치는 테이블 재빌드 12단계라 단순함 우선).
- `ALTER TABLE ... RENAME TO`가 **자식 slot_setup의 FK 참조를 자동 추종**함은 가정이 아니라 레거시 파일 DB를 시드해 **실증**함.

**검증**: tsc 0 / vitest **229파일 2685테스트 전량 green**. 신규 테스트 27건(`presetInfoMigration.test.ts` 4 + `presetInfoMigration.adversarial.test.ts` 23). 라이브(13020) `/db/tables`에 `preset_info` 노출·`preset_pos` 404, 5행 데이터 보존(updated_at이 마이그레이션 이전 시각 유지로 입증), slot_setup 23행 정합.

**핵심 사실 (다음 세션 참고)**

- ⚠️ **`sname`은 두 문맥에 공존**: (a) DB 컬럼/Row 필드 → `preset_name`/`presetName`으로 변경됨, (b) **camerapos.json의 JSON 키 `sname` → 외부 포맷 계약이라 불변**. `cameraposWriter`/`mapTargets`/`roiDbLoad`의 JSON 읽기·쓰기는 그대로고 **매핑 지점에서만 번역**한다. 일괄 sed 치환 금지.
- **`preset_pos` 잔존 참조는 전부 정당하니 지우지 말 것**: `SqliteStore.ts`(구DB 감지→rename하는 마이그레이션 로직 — 지우면 미변환 DB 영구 불가), `presetInfoMigration*.test.ts`·`slot3dFrontCenter.test.ts`(구 스키마를 **입력으로 시드**하는 픽스처), `SettingAgent/docs/*.md`(과거 시점 기록물).
- 실 DB는 서버 첫 기동 시 **자동 마이그레이션·롤백 코드 없음**. 백업 `data/setting.sqlite.bak-presetinfo-20260724_145745` + **`-wal`(3.1MB)·`-shm` 동반 필수**(본체 49KB보다 WAL이 큼 — WAL 빼면 복구 불가).
- 정본 문서 최종: `1 floor_ROI / 2 camera_info / 3 preset_info / 4 place_info / 5 slot_setup / 6 parking_evnt / 7 parking_slot` (번호 연속·중복 해소, preset_pos 완전 제거). 마스터가 직접 편집한 부분은 손대지 않고 그대로 커밋했다.

**⚠️ 동시 세션 충돌 (재발 방지)**

- 작업 중 **다른 세션이 같은 메인 리포에서 `cfc8d34`를 main에 올림**(Touring Test 버튼 이동 + result 버튼 제거). 그 커밋이 `test/setupResultRoute.test.ts`를 **내 커밋과 함께 건드려** FF 병합 불가 → **main 위로 rebase**로 해소(충돌 없이 자동병합됐지만 **자동병합은 문법만 보장**하므로 반드시 테스트로 재검증했고 전량 green).
- 그 과정에서 작업트리의 `web/app.js`·`index.html` 더티가 **남의 커밋 내용과 바이트 동일**함을 대조한 뒤에야 복원했다(남의 변경은 확인 없이 버리지 말 것).
- 무관 더티(마스터의 `my_db_table.md`, 런타임 `data/`, 기존 `_workspace_*` 삭제분 41건)는 **stash로 보호 후 전량 복원**, 커밋엔 1건도 안 섞였다. 커밋은 **경로 한정**(`git commit -- <paths>`)으로 인덱스에 이미 staged된 남의 삭제분을 피했다.
- 교훈: **병렬 세션이 예상되면 워크트리 분리가 안전**하다. 단 하네스 서브에이전트는 메인 리포에 launch-pin되므로, 이번엔 일부러 **메인 리포에 브랜치만 따서**(worktree 아님) 경로 불일치를 피했다 — 이 트레이드오프를 매번 판단할 것.

**잔여과제**

- ⚠️ **`preset_name`이 운영 DB 5행 전부 NULL** (선재 결함, 이번 회귀 아님 — updated_at이 마이그레이션보다 선행). 원인: `loadRoiIntoDb`가 camerapos 라벨을 upsert한 **직후** 라벨 없는 ROI 유래 프리셋을 재upsert해 `ON CONFLICT SET preset_name=excluded.preset_name`으로 **라벨을 말소**. 마스터 확인함·미수정.
- `preset_pos`/`preset_info` 동시 존재 시 구 테이블 데이터 **무경고 미이관**(F4, 현실성 낮아 수용).
- 마이그레이션된 기존 DB는 `place_id` 컬럼이 **맨 뒤**에 붙음(ADD COLUMN 특성, 기능 영향 없음).
- `feat/vpd-seg-cuboid` 원격 포인터가 4커밋 뒤처짐 — 내용은 origin/main에 있어 유실 없음(다른 세션 브랜치라 미조치).
- 관련 메모리: [[settingagent-db-schema]], [[finalize-slotsetup-wipe-fragility]], [[settingagent-persist-5decimals]].

**커밋**: `b04b3ff`(리네임 본체) → `d230870`(문서 preset_info 정의) → `58a60f8`(문서 preset_pos 제거) → `aa4d4a3`(문서 번호 재정렬). **main = origin/main = `aa4d4a3`**. 산출물: `SettingAgent/docs/20260724_152212_preset_pos를_preset_info로_리네임.md`, `SettingAgent/_workspace_preset_info/01~04`.

---

## 2026-07-24 분석페이지 DB 즉석생성 + 전역번호 재번호(A안) — main 병합·푸시 완료

**세션 요약 (2기능, 커밋 `663f8dd`, origin/main 반영)**

1) **분석페이지 DB 즉석생성** — 정밀수집 완료해도 분석 탭이 안 채워지던 문제.
   - 원인: 분석 탭 주 산출물은 `GET /mapping` ← `setup_artifact.json` 파일 only. 이 파일은 `Finalizer.finalize`만 쓰는데, 정밀수집(startPrecise)은 finalizing 단계를 건너뛰고(discovering→calibrating→done) 최종화 버튼도 표시전용(capFinalize)이라 파일이 절대 안 써짐 → 항상 빈 상태.
   - 해결: `resolveMapping()`(server.ts) — 파일 없/빈slots 시 `buildArtifactFromSlotSetup(getSlotSetup())`로 **DB 즉석 조립**. 파괴적 finalize/replaceSlotSetup 미경유(센터라이징 보존). 파일 slots 있으면 파일 우선. 정밀수집 done 시 분석 탭 열려있으면 renderAnalysis 자동. **신규 `src/setup/artifactFromSlotSetup.ts`**.

2) **전역번호 재번호(A안)** — 수동매핑 전역ID 변경이 setup_artifact.json 파일만 바꾸고 DB·setup_result와 단절돼 있던 문제. 마스터 결정: 전역번호==slot_id 결합.
   - 신규 `POST /mapping/renumber`: 검증(순열 1..N 고유·전행커버, 실패 400·**DB무변경 원자성**) → `SqliteStore.renumberSlotIds`(트랜잭션 DELETE+re-INSERT, slot_id 라벨만 이동·**전 컬럼 바이트 보존**) → `slot_ptz.json` 리맵(`remapSlotPtz` — plateWidth/converged는 DB에 없어 재생성 불가라 리맵) → `setup_result.json` 재생성 → `setup_artifact.json` DB 재빌드.
   - 신규 `src/setup/renumberMapping.ts`, `src/calibrate/slotPtzRenumber.ts`. 프론트 `saveManualIndex`가 이 라우트 호출로 전환.

**검증**: 개발자 22 + QA 적대 12 = 전량 **2593 tests green, tsc 0, 결함 0**. 라이브 스왑(22↔23) 왕복 e2e로 DB+3파일 전파·원복 실증.

**핵심 사실 (다음 세션 참고)**
- slot_id 참조처: DB `slot_setup`(PK), FK `parking_evnt`/`parking_slot`(스키마만·writer 미작성·비어있음), 파일 3종(setup_result/slot_ptz/setup_artifact). 재번호는 이 전부에 전파해야 정합.
- `slot_ptz.json`은 plateWidth/converged를 DB가 안 가져 **DB 재생성 불가 → 리맵**만 가능(주의).
- `setup_artifact.roiByPreset`은 원래 bbox 타입(폴리곤 정본은 DB slot_roi·setup_result floor_roi). DB 재빌드가 폴리곤 손실 아님.
- 관련 메모리: [[finalize-slotsetup-wipe-fragility]], [[settingagent-db-schema]], [[centering-preaim-and-setup-save]].

**프로세스 함정 (재발 방지)**
- ⚠️ **하네스 서브에이전트(architect/developer/qa/documenter)는 워크트리가 아니라 메인 리포에 launch-pinned** 된다. 워크트리 세션에서 상대경로/메인절대경로를 주면 **메인에 써버린다**(1차 시도 때 발생 → 수습). 대책: 모든 서브에이전트에 **워크트리 절대경로 + vitest는 `cd <워크트리>/SettingAgent` 명시**. node_modules는 ParkAgent 루트 호이스팅이라 워크트리에서도 해석됨.
- 라이브 검증은 워크트리 코드가 미배포라 안 됨 → 실행 인스턴스(main, nodemon)에 파일 복사 배포 후 curl. 최종은 워크트리 브랜치 커밋 → main FF 병합(무관 더티 보존 위해 커밋대상 경로만 정리 후 `merge --ff-only`) → origin 푸시.

**마감 상태**: main `663f8dd` = origin/main. 워크트리 `worktree-analyze-fill-check`는 병합 완료(세션 종료 시 삭제 가능). data/setup_artifact.json은 실내용으로 채워짐, slot_ptz.json은 검증 후 원복(둘 다 runtime·커밋 제외).

---

## 2026-07-24 SettingAgent 리팩토링(150줄초과 6함수 분할) + 분석페이지 기능 병합 → main 반영·push

**세션 요약**
- 목표: 소스 최적화·재사용·복잡도 제거, **함수 본문 150줄↑ → 함수화**. 다른 세션과 충돌 없이 진행 + 설계서(Fable) 작성.
- 격리 워크트리 `worktree-work-20260723b`(HEAD 9c2291b 분기)에서 진행. 미사용 워크트리 `work+20260723` 정리, `analyze-fill-check`는 미커밋 있어 보존.
- **동시성 안전 전략**: 다른 세션 편집 파일(server.ts / web/app.js / precisePreciseProgress.test.ts / artifactFromSlotSetup.ts) **전면 제외** + **공개 export 시그니처 동결** → 파일단위 충돌 0. 이 덕분에 나중에 기능커밋 병합도 무충돌.

**리팩토링 결과(5커밋 + 설계·문서 2)**
- routeHelpers.ts 신설(parseOr400/fileErrorReply/parseCamPreset/sendJpeg/resolveSourceCamera).
- 라우트 계층: `registerCaptureRoutes` **752→9줄**(서브등록기 7 + 핸들러 명명함수 추출), `registerViewerRoutes` **325→60줄**(withSource 고차함수).
- ground 순수함수 분할(frameCuboids/groundModel/contact) + reason/issue 중첩삼항 평탄화(문자열 스냅샷 봉인).
- platePtz 결과빌더 okResult/failResult/limitResult(인라인 21곳 수렴) + detectZoomStall/nextLadderZoom 순수함수. `Finalizer.finalize` **181→110줄**(compareOccupancyAgreement/persistSlotSetupFromPlace). iterMultipart→parseMultipartFrame, AgentRuntime ollamaEndpoint/authHeaders.
- 신규 테스트 +64. **S1(150줄초과 0건) 달성 — 단 1건 문서화 예외**.

**⚠️ 의도적 예외 2건(정직 기록)**
- `centerAndZoomByLadder` **289줄 유지**: 6반환지점이 루프 지역상태와 강결합된 **환원불가 상태기계**, 종료블록 로그필드 상이 → 순수함수 추출까지만(302→289). 더 낮추면 line-golf 위해 동작드리프트 위험. 설계 §4.3/§8.2가 사전승인.
- `captureWithDither` 통합 **보류**: tilt/zoom 축별 로깅 구조·메시지 divergence로 안전한 콜백통합 불가(로그 바이트 미검증). → **잔여과제: 로깅 통일 선행 후 재시도**.

**분석페이지 버그(정밀수집·최종화 후 주차면목록+수동매핑 미생성) — 진단·해결**
- **내 리팩토링 회귀 아님**(Finalizer persist는 바이트동일 추출, slot_setup 23행 정상). 원인: 분석페이지가 읽는 `/mapping`(SetupArtifact)이 **검출기반**이라 비면 빈값 → 이를 **slot_setup DB에서 즉석생성하는 fallback**(artifactFromSlotSetup.ts)이 내 브랜치에 없었음.
- 그 fallback은 analyze-fill-check 세션 작업(커밋 `663f8dd` "분석페이지 DB즉석생성 + 전역번호 재번호"). **cherry-pick으로 병합**(파일 무충돌) → `/mapping` 이제 23슬롯 반환 확인.

**최종 상태 / 인수인계**
- **main = origin/main = `69f305c`** (리팩토링 + 분석페이지 기능 병합). **push 완료.** tsc 0, vitest **2655 green**.
- ⚠️ `buildTouringPlan.test.ts` 2건 실패 = **라이브데이터 의존 취약 테스트**(gitignore된 `save/setup_result.json`을 읽는데, 정밀수집·최종화만 하고 센터라이징 안 하면 슬롯 centering이 null이라 기대 불일치). **코드 무관·기준선에서도 red**. 잔여과제: 이 테스트를 고정 fixture로 전환.
- 웹 실측은 SettingAgent 서버 포트 **13020**(config 고정, env 오버라이드 없음). 세션 중 실측 위해 여러 번 재기동했고 **현재는 중단 상태**. Unity RPC(13110)는 응답하나 VPD/LPD 스택 상태는 가변.
- 잔여과제 재확인: ① captureWithDither 로깅통일, ② `replaceSlotSetup` 센터링컬럼(pan/tilt/zoom/centered/img1) 무가드 리셋 보강([[finalize-slotsetup-wipe-fragility]]), ③ buildTouringPlan fixture 고정화.
- 관련 메모리: [[finalize-slotsetup-wipe-fragility]], [[centering-preaim-and-setup-save]], [[settingagent-persist-5decimals]].

---

## 2026-07-23 센터라이징 → setup_result.json 생성 조건 분석

**세션 요약**
- 질문: "센터라이징하면 미수렴 주차면이 있어도 `setup_result.json`이 만들어지는가?" → **답: 예, 만들어진다.**
- 결론: `setup_result.json` 생성은 **잡이 done으로 끝났는가**에만 의존한다. 미수렴 여부와 무관. 잡이 예외로 죽으면(`state='error'`) 생성 안 됨.

**핵심 코드 경로**
- 센터라이징 잡 done 흐름 [PtzCalibrator.ts:415-421](../SettingAgent/src/calibrate/PtzCalibrator.ts#L415-L421):
  `slot_ptz.json 기록 → saveCenteringSlots(DB UPDATE) → saveSetupSnapshot() → state='done'`
- `saveSetupSnapshot()` ([:438-441](../SettingAgent/src/calibrate/PtzCalibrator.ts#L438-L441))는 **수렴 여부를 검사하지 않고** 무조건 `writeSetupResultFiles` 호출.
- 개별 슬롯 실패는 흡수([:407-411](../SettingAgent/src/calibrate/PtzCalibrator.ts#L407-L411)) → done 경로 유지. 잡 전체 예외만 error.
- `writeSetupResultFiles`([setupResult.ts](../SettingAgent/src/store/setupResult.ts)): 동일 내용 2벌 기록 — `save/Setup_YYYYMMDD_HHMMSS.json`(이력본) + `save/setup_result.json`(고정본). 각자 best-effort.

**미수렴 슬롯이 파일에 담기는 방식** (`centering` 필드 = pan/tilt/zoom 모두 있을 때만 채움, [setupResult.ts:44-47](../SettingAgent/src/store/setupResult.ts#L44-L47))
- **zoom 미수렴**(`converged:false`, `centered:true`): pan/tilt는 판 위 조준됨 → DB 저장됨 → `centering` **채워짐**.
- **미센터**(`centered:false`, 번호판 자체 미검): DB 저장에서 제외([:691](../SettingAgent/src/calibrate/PtzCalibrator.ts#L691)) → `centering: null`.
- 모든 slot_setup 슬롯이 행으로 들어가되, 미수렴/미센터는 정직하게 null/부분값 표기(0 위장 없음).

**기타 · 주의점**
- ⚠️ **파일 존재 = 센터라이징 전부 수렴, 이 아니다.** 파일은 "현재 slot_setup 정본의 스냅샷"일 뿐 완결 보증 아님.
- 수렴 완결성은 `centering: null`인 슬롯 수, 또는 `slot_ptz.json`의 `converged` 플래그로 별도 확인.
- 수동 'result 파일 생성' 버튼(`POST /capture/setup-result`)도 **같은 진입점**(`writeSetupResultFiles`) 사용 → 동일 산출.
- 관련 메모리: [[centering-preaim-and-setup-save]], [[finalize-slotsetup-wipe-fragility]].

---

<!-- 아래에 새 항목을 추가하세요. 템플릿:

## YYYY-MM-DD 제목

**세션 요약**
-

**인수인계 / 다음 할 일**
-

**기타 · 주의점**
-

-->
