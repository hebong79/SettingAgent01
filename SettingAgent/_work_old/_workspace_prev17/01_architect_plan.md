# 01 · 설계 계획 — 정밀수집(precise) 페이지 3기능 추가

## 0. 요청 요약
정밀수집 탭에 서로 **독립적인** 3기능을 추가한다. 셋 다 `web/index.html`(precise-box)·`web/app.js`·백엔드 라우트를 공유하므로 **ID 접두사·함수 그룹·라우트를 분리**해 충돌을 막는다.

- **기능1**: 카메라 PTZ 프리셋(camerapos.json) 리스트 CRUD (선택/수정/삭제/추가/저장/열기)
- **기능2**: VPD/LPD 검출 박스 선택·크기조절·삭제 (임시, 메모리만)
- **기능3**: 프리셋 주차면 자동보정 (이동+스케일, sharp 상호상관, 신규 의존성 0)

**MCP 두뇌/도구 경계 판단(전 기능 공통)**: 세 기능 모두 **결정형(도구)** 영역이다. 특히 기능3 자동보정은 "수치반복 루프(상호상관)"라 CLAUDE.md 경계상 **LLM 두뇌 아님** — sharp 픽셀 추출 + 순수 수학 함수로 처리한다. LLM 호출 신규 0.

---

## 1. 현황 실측(근거)

### 프론트(web/)
- `core.js` — 순수 로직 모듈(DOM/fetch 비참조, vitest 직접 import). 이미 보유:
  - 프리셋 편집: `upsertPreset`, `removePreset`, `nextPresetId`(camerapos views 편집, 불변).
  - 히트/리사이즈: `pointInRect`, `pointInQuad`, `hitTestRectHandle`(rect 8핸들+내부), `resizeRect`, `moveRect`, `hitTestQuadVertex`, `moveQuadVertex`.
  - 파일 ROI: `normalizePtzCamRoi`(PtzCamRoi raw→정규화 byPreset + report), `selectFloorRoi`.
  - 로컬 파일: `parseLoadedArtifact`, `defaultResultFilename`.
- `app.js`:
  - camerapos 편집 이미 존재(제어패널): `loadCameraposViews`/`saveCameraposViews`/`persistCamerapos`, `savePreset(asNew)`, `deletePreset()`. GET/PUT `/viewer/api/camerapos`.
  - 프리셋 이동: `gotoPreset()`(findPresetPtz→`move`→물리이동), `reconnectLiveIfActive()`.
  - 검출: `state.detectByKey[cam:preset]={vehicles:[{rect,plate?}],plates:[{quad}]}`, `runLiveDetect()`(POST /capture/detect), `drawDetectOverlay(ctx)`, 전체 렌더 `drawRoiOverlay()`(243).
  - 파일 ROI 상태: `state.placeRoi`(정규화 byPreset), `loadPlaceRoi()`, `drawFileFloorRoi(ctx)`.
  - 오버레이 편집 결선: `wireOverlayEditing()`(mousedown 최상단 `if (state.roiHidden || !state.mapping) return;` 가드 — **검출 편집은 이 가드 이전에 처리해야 함**).
  - 좌표: `eventToNorm(e)`(정규화), 픽셀변환 `toPixel/toPixelQuad`, 핸들 tol = `HANDLE_PX/overlay.width|height`.
- `index.html` — precise-box(140~188): 수집 파라미터 + `cap-*` 버튼 + PTZ 캘리브레이션. Live View toolbar에 `roi-detect` 토글·`cap-detect-run` 버튼 존재.

### 백엔드(src/)
- `viewer/routes.ts:349` — `cameraposFile` 주입 시 GET/PUT `/viewer/api/camerapos`(PUT은 controlToken 게이트, zoom clamp, `writeCamerapos`로 전체 파일 기록).
- `api/captureRoutes.ts` — `/capture/*`. `GET /capture/place-roi`(raw 서빙, 309), `POST /capture/detect`(326), deps에 `camera:ICameraClient`, `placeRoiFile`, `vpd`, `lpd` 이미 주입됨(server.ts:242~245).
- `clients/CameraClient.ts` — `ICameraClient.requestImage(camIdx,presetIdx,ptz?)` → `CapturedImage{jpg:Buffer,...}`. 현재 프레임 캡처의 표준 경로(신규 메서드 불요).
- `clients/RpcCameraClient.ts` — requestImage가 내부적으로 `cam.captureJPG`로 base64 JPEG 획득 → Buffer.
- `capture/placeRoi.ts` — PtzCamRoi 파싱/정규화 유틸(백엔드). 저장(쓰기) 함수는 미보유 → 신규 추가 대상.
- 파일 경로: `config/camerapos.json`(tools.map.cameraposFile), `data/Place01/PtzCamRoi.json`(dataDir + store.placeRoiFile). PtzCamRoi는 **픽셀 좌표 + camera.imageWidth/imageHeight**(정본은 픽셀).
- `package.json` — `sharp ^0.35.3` 이미 의존성 존재(신규 설치 불요). CV 라이브러리 없음.

---

## 2. 기능1 — 카메라 PTZ 프리셋 리스트 CRUD

정밀수집 페이지 하단에 camerapos 프리셋 리스트를 추가한다. **기존 순수 함수·라우트를 그대로 재사용**하고, 제어패널의 프리셋 편집 로직과 **공유 함수화**해 중복을 제거한다.

### 2-1. 신규/변경 파일
- `web/index.html`(precise-box 내 신규 섹션 `#cpreset-box`): 프리셋 리스트(`#cpreset-list`) + 툴바(`#cpreset-add` 추가, `#cpreset-update` 수정, `#cpreset-delete` 삭제, `#cpreset-save` 저장, `#cpreset-open` 열기, `#cpreset-name` 이름 입력, `#cpreset-msg` 상태). ID 접두사 `cpreset-`로 기존 `preset-*`(제어패널)과 분리.
- `web/core.js`(순수, 신규):
  - `cameraposListRows(views)` → `camIdx ASC → presetIdx ASC` 정렬 배열(리스트 렌더용, 얇은 정렬).
  - `parseLoadedCamerapos(text)` → `{ok:true, views}` | `{ok:false, error}` (로컬 JSON '열기' 파싱·형태검증: 각 항목 camIdx/presetIdx/pan/tilt/zoom 수치 검증). `parseLoadedArtifact` 미러.
- `web/app.js`(신규 함수 그룹 `--- 정밀수집 프리셋 리스트 ---`):
  - `renderCameraposList()` — `loadCameraposViews()`→`cameraposListRows`→리스트 DOM. 각 행 클릭=선택.
  - `selectCameraposItem(camIdx,presetIdx)` — `state.cam/preset` 설정 → `renderPresetSelect()` 동기화 → `gotoPreset()`(물리 이동) → `reconnectLiveIfActive()`.
  - 추가/수정/삭제/저장 = 기존 `savePreset(true)`/`savePreset(false)`/`deletePreset()`/`persistCamerapos()` **재사용**(정밀수집 리스트 갱신 콜백만 추가). '열기' = `pickAndReadJsonFile()`(기존) + `parseLoadedCamerapos` → `saveCameraposViews`(PUT) 또는 메모리 반영 후 리스트 재렌더.

### 2-2. 라우트
**신규 없음**. 기존 GET/PUT `/viewer/api/camerapos` 재사용. PUT은 controlToken 게이트(옵션 탭 `#viewer-token` 값을 `tokenHeaders`로 준용 — 기존 패턴).

### 2-3. 검증(성공 기준)
1. `cameraposListRows` → 정렬 검증(cam→preset ASC). vitest.
2. `parseLoadedCamerapos` → 정상/깨진 JSON/필드 누락 각각 `{ok}` 검증. vitest.
3. 동작: 리스트 행 클릭 → 카메라가 해당 프리셋으로 물리 이동 + 스트림 재연결(라이브 시). 추가/수정/삭제 후 '저장' → GET 재조회 시 반영. '열기' → 파일 프리셋이 리스트에 표시.

### 2-4. 미해결/가정
- **Q1(리더 확인 요망)**: '열기'가 (a) 로컬 파일 → 즉시 PUT로 서버 파일 덮어쓰기, (b) 메모리 표시만(저장 별도) 중 어느 것인가? 배경설명은 "결과 저장/열기 패턴 참고, 또는 GET 리로드"로 양립. **기본 제안=(b) 메모리 표시 + 별도 '저장'**(결과 열기 패턴과 동일, 실수 저장 방지).
- 가정: 제어패널 기존 프리셋 UI는 유지하고 리스트만 가산(외과적). 공유 함수화는 신규 로직 없이 호출부만 정리.

---

## 3. 기능2 — VPD/LPD 검출 박스 선택·크기조절·삭제 (임시)

overlay 캔버스에서 검출 박스를 클릭 선택 → 하이라이트 → 크기조절 → 삭제. `state.detectByKey`를 **메모리에서만** 편집(저장 없음, 다음 검출/프레임에 갱신).

### 3-1. 데이터 형태
- VPD = `vehicles[i].rect{x,y,w,h}`(정규화) → **rect 8핸들 리사이즈**(`hitTestRectHandle`+`resizeRect`+`moveRect` 재사용).
- LPD = `plates[i].quad[4]{x,y}` / `vehicles[i].plate.quad` → **quad 정점 드래그**(`hitTestQuadVertex`+`moveQuadVertex` 재사용).

### 3-2. 신규/변경 파일
- `web/core.js`(순수, 신규):
  - `hitTestDetections({nx,ny,detect,tolX,tolY,layers})` → `{kind:'vehicle'|'plate', index, handle?}` | null. 우선순위: 선택 대상 핸들 > vehicle rect > plate quad. `detect={vehicles,plates}`.
  - `removeDetection(detect, sel)` → 새 `{vehicles,plates}`(sel.kind/index 항목 제거, 불변).
- `web/app.js`:
  - `state.selectedDetect = {kind,index} | null`(신규 필드).
  - `wireOverlayEditing()` **최상단 가드 이전에** 검출 편집 분기 삽입: `$('roi-detect').checked && state.detectByKey[currentFrameKey()]` 일 때 hit 판정 → 리사이즈/이동/선택 dragState(`kind:'detResize'|'detMove'|'detVertex'`) 후 return. hit 없으면 기존 로직으로 낙하.
  - mousemove: detResize=`resizeRect`, detMove=`moveRect`(vehicle rect), detVertex=`moveQuadVertex`(plate quad) → `state.detectByKey[key]` 갱신 후 `drawRoiOverlay()`.
  - `drawDetectOverlay(ctx)` 확장: 선택 항목 하이라이트(굵은 대비색) + 핸들(`drawHandles`/`drawQuadHandles` 재사용).
  - 삭제: `deleteSelectedDetect()`(버튼 `#det-delete` + 단축키). `keydown` 리스너: Delete/Backspace=삭제, Esc=선택해제(입력 필드 포커스 시 무시).
- `web/index.html`: Live View toolbar(roi-toggles) 또는 별도 `#det-edit-bar`에 `#det-delete` 버튼 1개(최소 UI). 단축키 안내 title.

### 3-3. 라우트
**없음**(메모리 편집만).

### 3-4. 검증(성공 기준)
1. `hitTestDetections` → rect 내부/핸들/quad 정점/빈 곳 각각 반환값 검증. vitest.
2. `removeDetection` → vehicle/plate 제거 후 배열·불변성 검증. vitest.
3. 동작: 박스 클릭→하이라이트, 코너 드래그→크기변경, Delete→삭제, Esc→해제, 재검출(`runLiveDetect`)/프레임 갱신 시 편집분 사라짐(임시 확인).

### 3-5. 미해결/가정
- **정밀수집 중 프레임 자동갱신(`capFrameTick`)이 프리셋 순환 시 `runLiveDetect`를 재호출**해 편집분을 덮는다 → 임시 편집이 곧 사라짐(사용자 확정 '임시'와 정합). 정지/단일 프리셋 상태에서 편집이 유의미. 문서에 명시.
- 선택 대상 vs 기존 슬롯편집(Ctrl+드래그) 충돌 방지: 검출 편집은 **plain click**(Ctrl 아님) + detect 토글 ON + 가드 이전 분기라 물리 배타. 가정으로 명시.

---

## 4. 기능3 — 프리셋 주차면 자동보정 (이동+스케일, sharp)

기준 프레임을 프리셋별로 저장해두고, 현재 프레임과 상호상관으로 이동(dx,dy)+스케일(s)을 추정해 주차면 ROI 폴리곤을 아핀 이동/스케일한 뒤 검토·저장한다.

### 4-1. 저장 경로 결정(리더 요청 명확화)
- **기준 프레임**: `data/refframes/cam{c}_p{p}.jpg`(디스크). 라우트 dep `refFrameDir`(=`join(dataDir,'refframes')`)를 server.ts→captureRoutes에 주입.
- **주차면 ROI 정본 = `data/Place01/PtzCamRoi.json`**. 따라서 보정 결과 저장은 **신규 PUT `/capture/place-roi`**로 PtzCamRoi.json에 직접 기록(정규화→픽셀 역변환). setup_artifact/map-save 경로는 건드리지 않음(파일 ROI와 산출물 ROI는 별개 계보).

### 4-2. 신규/변경 파일
- `src/capture/frameAlign.ts`(순수 수학, 신규 — vitest 대상):
  - `normalizedCrossCorrelation(ref:Uint8Array, cur:Uint8Array, w:number, h:number, maxShift:number)` → `{dx,dy,peak}`. 제로평균·정규화 상호상관으로 정수 픽셀 이동 추정(다운스케일 배열이라 O(w·h·shift²) 허용).
  - `scaleGray(src:Uint8Array, w:number, h:number, s:number)` → `Uint8Array`(중심 기준 바이리니어 리샘플, 동일 w×h 캔버스).
  - `estimateAlign(ref, cur, w, h, {scales:number[], maxShift:number})` → `{dx,dy,scale,peak}`. 스케일 후보(예 0.9~1.1, step 0.02)마다 cur 리샘플→상호상관 peak 최대 선택.
- `src/capture/placeRoi.ts`(백엔드, 신규 함수 가산):
  - `applyPlaceRoiUpdate(json, {camId,presetIdx,spaces})` → 새 json. 정규화 spaces(`[{idx,points:[{x,y}×4]}]`)를 해당 카메라 imageWidth/imageHeight로 **픽셀 역변환**해 그 프리셋 `parking_spaces` 교체(나머지 구조 보존, 불변). vitest 대상.
- `src/api/captureRoutes.ts`(라우트 3종 가산):
  - `POST /capture/refframe {cam,preset}` → `camera.requestImage(cam,preset)`.jpg를 `refFrameDir/cam{c}_p{p}.jpg`로 write. → `{ok, path}`. camera 미주입 시 미등록(가산).
  - `POST /capture/autocorrect {cam,preset}` → 기준 jpg 로드 + 현재 프레임 캡처 → 각각 sharp `.greyscale().resize(w,h,{fit:'fill'}).raw()` → gray Uint8Array → `estimateAlign` → 정규화 오프셋 반환 `{ok, dx:dxPx/w, dy:dyPx/h, scale, peak, confidence:peak}`. 기준 없음 404, sharp 실패 502.
  - `PUT /capture/place-roi {camId,presetIdx,spaces}` → 파일 읽기 → `applyPlaceRoiUpdate` → write. `{ok, spaceCount}`. (GET place-roi와 대칭. 게이트는 기존 `/capture/*` 관례상 무토큰 — 아래 Q2.)
- `web/core.js`(순수, 신규):
  - `applyTranslateScale(point, {dx,dy,scale,cx=0.5,cy=0.5})` → `{x,y}`: `new = center + scale*(old-center) + (dx,dy)`(정규화 좌표, 중심=이미지 중앙).
  - `transformPlaceRoiPreset(spaces, transform)` → 각 space.points에 `applyTranslateScale` 적용(불변).
- `web/app.js`(신규 그룹 `--- 주차면 자동보정 ---`):
  - `#align-save-ref`(기준 저장)→POST refframe, `#align-run`(주차면 자동보정)→POST autocorrect→`transformPlaceRoiPreset`로 `state.placeRoi[key]` 변환→`drawRoiOverlay()`, `#align-apply`(보정 저장)→PUT place-roi, `#align-undo`(되돌리기)→직전 스냅샷 복원. `#align-msg`에 peak/신뢰도·"이동/스케일만(회전·원근 미보정)" 표기.
  - `state.placeRoiBackup`(되돌리기용 직전 byPreset[key] 스냅샷).
- `web/index.html`: precise-box 내 신규 섹션 `#align-box`(버튼 4개 + 메시지). ID 접두사 `align-`.
- `src/index.ts` / `src/api/server.ts`: `refFrameDir` dep 배선(1줄).

### 4-3. sharp/DOM 경계
sharp는 라우트에서 **픽셀 추출만**(greyscale+resize+raw). 상호상관·스케일탐색·아핀은 전부 순수 함수. DOM은 오버레이 렌더·버튼 결선만. (CLAUDE.md 단순·경계 준수)

### 4-4. 검증(성공 기준)
1. `normalizedCrossCorrelation` → 합성 배열을 알려진 (dx,dy)로 시프트했을 때 그 값 복원. vitest.
2. `estimateAlign` → 시프트+스케일 합성 케이스에서 (dx,dy,scale) 근사 복원, peak 범위. vitest.
3. `applyTranslateScale`/`transformPlaceRoiPreset` → 항등변환(dx=dy=0,s=1) 불변, 순수 이동/순수 스케일 수치 검증. vitest.
4. `applyPlaceRoiUpdate` → 정규화→픽셀 역변환·구조 보존·타 프리셋 불변. vitest.
5. 라우트: refframe write 후 파일 존재, autocorrect가 동일 프레임 입력 시 dx≈dy≈0·scale≈1·peak≈1(모킹 카메라/sharp). place-roi PUT 후 GET place-roi에 반영.
6. 동작(goal/loop 경험적): 기준 저장 → 카메라 미세 이동 → 자동보정 → 오버레이가 이동 방향으로 폴리곤 이동 확인(sharp 스샷/오버레이).

### 4-5. 한계·미해결/가정
- **이동+스케일만**(회전·원근 미보정). 특징 부족·큰 변화 시 부정확 → peak(신뢰도) 표기 + 되돌리기 제공. 문서·UI 명시.
- **Q2(리더 확인 요망)**: PUT `/capture/place-roi`에 controlToken 게이트를 둘까? 기존 `/capture/*`는 무토큰이라 대칭상 무토큰 기본 제안(단, 파일 정본 변형이라 필요 시 게이트 가능).
- 가정: 자동보정 대상 프리셋은 사용자가 라이브로 그 프리셋을 보고 있는 상태(현재 프레임=그 프리셋). refframe/현재 둘 다 `requestImage(cam,preset)`로 동일 경로 캡처. 다운스케일 크기는 고정(예 128×72) — 정규화 오프셋은 다운스케일 불변.

---

## 5. 충돌 정리(공유 파일)

| 파일 | 기능1 | 기능2 | 기능3 |
|------|-------|-------|-------|
| index.html precise-box | `#cpreset-box` 섹션 | `#det-delete`(toolbar) | `#align-box` 섹션 |
| app.js | 프리셋 리스트 그룹 | overlay 편집 분기+`state.selectedDetect` | 자동보정 그룹+`state.placeRoiBackup` |
| core.js | `cameraposListRows`,`parseLoadedCamerapos` | `hitTestDetections`,`removeDetection` | `applyTranslateScale`,`transformPlaceRoiPreset` |
| 라우트 | (재사용) camerapos GET/PUT | 없음 | refframe/autocorrect/place-roi PUT |

- ID 접두사(`cpreset-`/`det-`/`align-`)로 DOM 충돌 0. app.js는 그룹 헤더 주석으로 구획. core.js는 파일 말미 신규 섹션에 추가(기존 함수 불변).
- `wireOverlayEditing` mousedown은 **기능2 분기만** 최상단에 추가(기능3은 오버레이 드래그 아님 → 무충돌).

---

## 6. 영향도(구현자·문서화 전달)

- `drawRoiOverlay`/`drawDetectOverlay`: 기능2 선택 하이라이트·핸들 렌더 추가(기존 렌더 경로 보존, 가산).
- `state.detectByKey`: 기능2가 메모리 변형. `runLiveDetect`/`capFrameTick`가 프리셋 재검출 시 덮음(임시 특성).
- `state.placeRoi`: 기능3이 변형(정규화 byPreset). `updateLogicOccupancy`/`drawFileFloorRoi`가 이를 소비 → 보정 후 점유 판정·바닥 오버레이도 이동(의도된 동작).
- camerapos: 기능1이 PUT로 파일 갱신 → `/cameras`(CameraposSource) 재조회 시 반영. 제어패널 프리셋 UI와 동일 파일 공유(공유 함수화로 일관).
- PtzCamRoi.json: 기능3 PUT로 정본 변형 → GET place-roi·`normalizePtzCamRoi` 소비처 전체 반영.
- 정밀수집 폴(`capPoll`/`capFrameTick`) 로직 불변(기능 추가는 가산). `setTab('precise')`에 리스트·기준 로드 훅 1~2줄 추가 가능.

## 7. 하위호환
- 라우트 3종 모두 dep(camera/refFrameDir/placeRoiFile) 주입 시에만 등록(기존 패턴). 미주입 시 미등록 → 회귀 0.
- core.js 신규 함수는 순수·가산. 기존 export/서명 불변.
- PtzCamRoi.json 구조 보존(파싱 관용도 유지). refframes 디렉터리는 없으면 생성.

## 8. 구현 순서 제안
1. core.js 순수 함수 6종 + `frameAlign.ts` + `applyPlaceRoiUpdate` → vitest(가장 독립, 검증 선행).
2. 라우트 3종(기능3) + server/index 배선 → 라우트 테스트(모킹 camera/sharp).
3. index.html 섹션·버튼 + app.js 결선(기능1→2→3 순, DOM 격리).
4. 동작 확인(라이브 라우트/오버레이/sharp 스샷) → 문서화·영향도.
