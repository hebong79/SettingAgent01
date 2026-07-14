# 02 · 구현 변경 내역 — 정밀수집(precise) 페이지 3기능

설계서 `01_architect_plan.md` + 리더 확정사항대로 구현. 순수 로직 최대 분리(sharp/DOM 얇게), ESM(.js import), 외과적 변경.
`npx tsc --noEmit` 통과. 기존 라우트/오버레이/슬롯편집/스트림 무회귀(기존 테스트 재실행 통과 — 하단).

## 리더 확정 반영
- 기능1 '열기' = **(b) 로컬 파일 → 메모리 표시 → 별도 '저장'으로 확정**(즉시 PUT 아님).
- 기능2 박스 편집 = **화면 표시만(임시, 메모리 편집, 저장 없음)**.
- 기능3 자동보정 = **이동+스케일만**(회전·원근 미보정), sharp 상호상관, 신규 의존성 0. PUT `/capture/place-roi` **무토큰**.

---

## 변경/신규 파일 요약

| 파일 | 종류 | 기능 | 요지 |
|------|------|------|------|
| `web/core.js` | 변경(가산) | 1/2/3 | 순수 함수 6종 추가(파일 말미, 기존 export 불변) |
| `web/core.d.ts` | 변경(가산) | 1/2/3 | 위 6종 타입 선언(core.js 와 1:1) |
| `src/capture/frameAlign.ts` | **신규** | 3 | 상호상관·스케일 리샘플·정합 추정(순수 수학) |
| `src/capture/placeRoi.ts` | 변경(가산) | 3 | `applyPlaceRoiUpdate` 추가(정규화→픽셀 역변환, 불변) |
| `src/api/captureRoutes.ts` | 변경(가산) | 3 | 라우트 3종 + `refFrameDir` dep + zod 스키마 |
| `src/api/server.ts` | 변경(1줄+dep) | 3 | `refFrameDir` ApiDeps 필드 + captureRoutes 로 전달 |
| `src/index.ts` | 변경(1줄) | 3 | `refFrameDir: join(dataDir,'refframes')` 배선 |
| `web/index.html` | 변경(가산) | 1/2/3 | `#cpreset-box`·`#align-box` 섹션 + `#det-delete` 버튼 |
| `web/app.js` | 변경(가산) | 1/2/3 | import·state 3필드·함수 그룹·오버레이 분기·버튼/단축키 결선 |

---

## 기능 1 — 카메라 PTZ 프리셋 리스트 CRUD

### 순수 함수(`web/core.js`, 시그니처)
- `cameraposListRows(views) → CameraposView[]` : camIdx ASC → presetIdx ASC 정렬(불변).
- `parseLoadedCamerapos(text) → {ok:true,views} | {ok:false,error}` : 로컬 '열기' 파싱. 허용 형태 = **최상위 배열** 또는 `{views:[...]}`. 각 항목 camIdx/presetIdx/pan/tilt/zoom 수치 검증(`parseLoadedArtifact` 미러). label 없으면 `Preset {n}` 폴백.

### 공유 함수화(중복 제거)
- `savePreset(asNew, labelOverride?)` — **선택적 `labelOverride` 인자 추가**(외과적). 미지정 시 기존대로 제어패널 `#preset-label`, 지정 시 정밀수집 `#cpreset-name` 사용. 제어패널/정밀리스트가 동일 함수 공유.
- 추가/수정/삭제 = 기존 `savePreset(true,..)`/`savePreset(false,..)`/`deletePreset()` 재사용(즉시 PUT). `cpresetAction(fn)` 래퍼가 열기 버퍼 폐기 + 실행 + 리스트 재렌더.

### app.js 신규(그룹 `--- [기능1] 정밀수집 프리셋 리스트 ---`)
- `renderCameraposList()` : `cameraposEdit` 버퍼가 있으면 그것을, 없으면 `loadCameraposViews()`(서버) 렌더. 행 클릭=선택.
- `selectCameraposItem(cam,preset,label)` : state.cam/preset 설정 → `renderCamSelect()` 동기화 → `gotoPreset()`(물리 이동) → `reconnectLiveIfActive()`.
- `openCamerapos()` : `pickAndReadJsonFile`(기존) + `parseLoadedCamerapos` → `state.cameraposEdit` 버퍼에 표시(미저장).
- `saveCamerapos()` : 버퍼를 `persistCamerapos`(PUT) 로 확정 후 버퍼 폐기·서버 뷰 복귀.

### 라우트
- **신규 없음**. 기존 GET/PUT `/viewer/api/camerapos` 재사용(PUT 은 `tokenHeaders` controlToken 준용).

### UI
- `#cpreset-box` 섹션: `#cpreset-name`(이름) + 버튼 `#cpreset-add`(추가)·`#cpreset-update`(수정)·`#cpreset-delete`(삭제)·`#cpreset-open`(열기)·`#cpreset-save`(저장) + `#cpreset-list` + `#cpreset-msg`.

### state
- `state.cameraposEdit` : '열기'로 불러온 미저장 views 버퍼(있으면 리스트가 표시, 저장으로 확정).

### 가정/한계
- '열기' 대상 파일 형식은 **정규화 views**(GET `/camerapos` 응답 / PUT 본문과 동일 shape). Unity 원본 `camerapos.json`의 중첩 `datas` 포맷은 백엔드 `parseCameraViews` 소관 — 프론트 열기는 정규화 형식만(단순·범위 준수).
- 버퍼에만 있고 서버에 없는 프리셋 행을 클릭하면 `renderCamSelect`/`gotoPreset` 이 서버 목록 기준이라 선택이 서버 첫 프리셋으로 폴백될 수 있음(저장 후엔 정합). '표시 후 저장' 흐름과 정합.

---

## 기능 2 — VPD/LPD 검출 박스 선택·크기조절·삭제 (임시·메모리만)

### 순수 함수(`web/core.js`, 시그니처)
- `hitTestDetections({nx,ny,detect,tolX,tolY,selected}) → {kind,index,handle}|{kind:'plate',index,vertex?}|null`
  - 우선순위: **선택 대상 핸들/정점 > vehicle rect 내부 > plate quad 내부**. 같은 종류 겹침은 마지막(위) 우선(그리는 순서 정합).
  - vehicle: `hitTestRectHandle` 재사용(핸들 or `'in'`). plate: `hitTestQuadVertex`(선택된 quad 정점) / `pointInQuad`(선택).
- `removeDetection(detect, sel) → {...detect, vehicles, plates}` : sel.kind/index 항목 splice(불변, 여타 필드 보존).

### app.js 결선
- `state.selectedDetect = {kind,index}|null`(신규).
- `wireOverlayEditing()` mousedown **최상단(가드 이전)** 검출 분기: `roi-detect ON && !Ctrl && detect 존재` → `hitTestDetections` → 히트 시 선택 + dragState(`detResize`/`detMove`/`detVertex`), 빈 곳 클릭 시 선택 해제 후 기존 슬롯편집으로 낙하. **Ctrl+드래그(슬롯편집)와 물리 배타.**
- mousemove: `detResize=resizeRect`, `detMove=moveRect`(vehicle rect), `detVertex=moveQuadVertex`(plate quad) → `state.detectByKey[key]` **제자리 변형**(메모리) 후 `drawRoiOverlay()`.
- mouseup: det* 드래그는 `markDirty` 생략(mapping 미저장 표시 아님).
- `drawDetectOverlay` 확장: 선택 vehicle=굵은 대비색 rect + `drawHandles`, 선택 plate=`drawQuadHandles`(기존 렌더 함수 재사용).
- `deleteSelectedDetect()` + `renderDetectSelection()`(`#det-delete` disabled 토글). `runLiveDetect` 도착 시 `selectedDetect=null`(인덱스 무효화).
- 단축키: `document` keydown — Delete/Backspace=삭제, Esc=해제(입력/텍스트영역 포커스 시 무시).

### 라우트
- **없음**(메모리 편집만).

### UI
- Live View 툴바(`.roi-toggles`)에 `#det-delete` 버튼 1개(최소 UI, 단축키 title 안내).

### 임시 특성(문서화)
- 정밀수집 중 프레임 순환(`capFrameTick`) 또는 `runLiveDetect` 재검출 시 편집분이 **덮여 사라짐**(사용자 확정 '임시'와 정합). 단일 프리셋 정지 상태에서 편집이 유의미.

---

## 기능 3 — 주차면 자동보정 (이동+스케일, sharp)

### 순수 수학(`src/capture/frameAlign.ts`, 신규 — vitest 대상)
- `normalizedCrossCorrelation(ref,cur,w,h,maxShift) → {dx,dy,peak}` : 제로평균 정규화 상호상관. **peak 인 (dx,dy) 는 `ref[p] ≈ cur[p+(dx,dy)]`** → ref 좌표계 ROI 를 (dx,dy) 이동하면 cur 정합.
- `scaleGray(src,w,h,s) → Uint8Array` : 중심 기준 바이리니어 리샘플(동일 w×h). s>1 확대.
- `estimateAlign(ref,cur,w,h,{scales,maxShift}) → {dx,dy,scale,peak}` : scale 후보마다 cur 을 1/scale 로 되돌려 상호상관, peak 최대 선택. scale=cur 이 ref 대비 확대된 배율.

### 순수 아핀(`web/core.js`)
- `applyTranslateScale(point,{dx,dy,scale,cx=0.5,cy=0.5}) → {x,y}` : `new = center + scale*(old-center) + (dx,dy)`(정규화, 중심=이미지 중앙).
- `transformPlaceRoiPreset(spaces,transform) → spaces` : 각 space.points 에 적용(불변, idx 보존).

### 백엔드 역변환(`src/capture/placeRoi.ts`)
- `applyPlaceRoiUpdate(json,{camId,presetIdx,spaces}) → json` : 정규화 spaces 를 대상 카메라 imageWidth/imageHeight 로 **픽셀 역변환**(`[x*W,y*H]`)해 그 프리셋 `parking_spaces` 교체. 타 카메라/프리셋·메타 보존, 불변. 대상 부재·크기오류 시 원본 반환(throw 금지).

### 라우트(`src/api/captureRoutes.ts`, 3종 가산)
- `POST /capture/refframe {cam,preset}` → `camera.requestImage(cam,preset).jpg` 를 `refFrameDir/cam{c}_p{p}.jpg` write. → `{ok,path}`. 실패 502. (camera+refFrameDir 주입 시 등록)
- `POST /capture/autocorrect {cam,preset}` → 기준 jpg 로드 + 현재 캡처 → 각각 `sharp.greyscale().resize(128,72,{fit:'fill'}).raw()`(1채널 실측) → `estimateAlign` → `{ok, dx:dxPx/128, dy:dyPx/72, scale, peak, confidence:peak}`. 기준 없음 404, 캡처/sharp 실패 502. (camera+refFrameDir 주입 시 등록)
  - 파라미터: `ALIGN_W=128, ALIGN_H=72, ALIGN_MAX_SHIFT=12(±≈9.4%), ALIGN_SCALES=0.9~1.1 step0.02(11개)`. 정규화 오프셋은 다운스케일 불변.
- `PUT /capture/place-roi {camId,presetIdx,spaces}` → 파일 읽기 → `applyPlaceRoiUpdate` → write. `{ok,spaceCount}`. **무토큰**(GET 대칭). 파일 미설정/없음 404, 쓰기실패 500.
  - zod: `camId/presetIdx = int positive`, `spaces = [{idx:int, points:[{x,y}]}]`.

### dep 배선
- `CaptureRouteDeps.refFrameDir?` 추가 → server.ts `ApiDeps.refFrameDir?` → index.ts `join(tools.store.dataDir,'refframes')`. 미주입 시 refframe/autocorrect 미등록(가산, 회귀 0). PUT place-roi 는 `placeRoiFile` 런타임 게이트(GET 대칭).

### app.js 신규(그룹 `--- [기능3] 주차면 자동보정 ---`)
- `alignSaveRef()`→refframe, `alignRun()`→autocorrect→`transformPlaceRoiPreset` 로 `state.placeRoi[key]` 변환→`drawRoiOverlay()`+peak/오프셋·"이동/스케일만(회전·원근 미보정)" 표기, `alignUndo()`→직전 스냅샷 복원, `alignApply()`→PUT place-roi.
- 대상 프리셋 = `alignTarget()`(수집 중 `capFrameKey2`, 아니면 `state.cam/preset` — runLiveDetect 패턴).
- `state.placeRoiBackup = {key,spaces}`(되돌리기용 직전 깊은복사).

### UI
- `#align-box` 섹션: `#align-save-ref`(기준 저장)·`#align-run`(주차면 자동보정)·`#align-undo`(되돌리기)·`#align-apply`(저장) + `#align-msg`.

### 한계(UI·문서 명시)
- **이동+스케일만**(회전·원근 미보정). 특징 부족·큰 변화 시 부정확 → peak(신뢰도) 표기 + 되돌리기 제공.

---

## 충돌 격리(공유 파일)
- ID 접두사 `cpreset-`/`det-`/`align-` 로 DOM 충돌 0. app.js 는 그룹 헤더 주석으로 구획. core.js 는 파일 말미 신규 섹션(기존 함수 불변).
- `wireOverlayEditing` mousedown 은 기능2 분기만 최상단 추가(Ctrl 아님 → 슬롯편집과 물리 배타). 좌표계산(`eventToNorm`)을 핸들러 상단 1회로 통합(중복 선언 제거).

## 타입체크
- `cd SettingAgent && npx tsc --noEmit` → **통과**(무출력). frameAlign/placeRoi/captureRoutes/server/index 전부 strict 통과.

## 유닛 테스트 후보(다음 단계 — qa-tester)
1. `frameAlign`: 합성 시프트 (dx,dy) 복원 / 시프트+스케일 근사 복원 / peak 범위. *(구현자 임시검증: dx=5,dy=-3→정확 복원 peak=1 / scale=1.1→scale 1.1 peak≈0.976 확인)*
2. `applyTranslateScale`/`transformPlaceRoiPreset`: 항등(불변)·순수 이동·순수 스케일 수치.
3. `applyPlaceRoiUpdate`: 정규화→픽셀 역변환([0.5,0.5]×1920/1080→[960,540])·타 프리셋 보존·불변. *(임시검증 확인)*
4. `cameraposListRows`(정렬)·`parseLoadedCamerapos`(정상/깨진 JSON/필드누락).
5. `hitTestDetections`(rect 내부/핸들/quad 정점/빈곳)·`removeDetection`(불변·splice).
6. 라우트: refframe write 파일 존재 / autocorrect 동일프레임 dx≈dy≈0·scale≈1·peak≈1(모킹 camera/sharp) / place-roi PUT→GET 반영.

## 라이브 검증(다음 단계)
- 리스트 행 클릭→물리 이동+스트림 재연결 / 추가·수정·삭제→GET 재조회 반영 / 열기→표시 후 저장.
- 검출 박스 클릭→하이라이트, 코너 드래그→크기변경, Delete→삭제, Esc→해제, 재검출 시 편집분 소멸(임시).
- 기준 저장→카메라 미세 이동→자동보정→오버레이 폴리곤 이동/스케일 확인(sharp 스샷/오버레이) + 저장→GET place-roi 반영.

## 회귀 확인(구현자 실행)
- `vitest run captureRoutes/placeRoiRoutes/placeRoi` → 57 passed. `viewerCore/viewerOverlayInteractive/normalizePtzCamRoi` → 87 passed.
