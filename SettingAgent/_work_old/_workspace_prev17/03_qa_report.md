# 03 · QA 검증 리포트 — 정밀수집(precise) 3기능 유닛테스트

검증자(qa-tester). 근거: `01_architect_plan.md` §2/§3/§4, `02_developer_changes.md` 기능1/2/3 순수 함수 시그니처.
정밀수집 3기능(프리셋 리스트 CRUD / 검출 박스 편집(임시) / 주차면 자동보정)의 **순수 로직**을 vitest로 검증했다.
리더 라이브 실증(refframe 저장 / autocorrect dx0·peak0.99999, pan+3° dx-0.094·peak0.93 / place-roi PUT→ok spaceCount:6 / camerapos CRUD)이 완료되어, 본 vitest는 순수 함수·경계면 정합에 집중했다.

## 결과 요약

- **신규 테스트 3파일 · 50 케이스 전부 통과.**
- **전체 스위트 121파일 · 1304 테스트 전부 통과(회귀 0).**
- **`npx tsc --noEmit` 통과(무출력).**
- 구현 결함 **0건**. 테스트 결함 1건 발견·자가수정(부동소수점 근사, 아래 §수정 이력).

```
test/frameAlign.test.ts      9 passed
test/preciseCore.test.ts    32 passed
test/placeRoiUpdate.test.ts  9 passed
전체: Test Files 121 passed (121) / Tests 1304 passed (1304)
```

## 신규 테스트 파일 및 커버리지

### 1. `test/frameAlign.test.ts` (기능3 순수 수학 · 9)
대상: `src/capture/frameAlign.ts` — `normalizedCrossCorrelation` / `scaleGray` / `estimateAlign`.
- **normalizedCrossCorrelation**: 가우시안 블롭 합성 배열에 알려진 시프트(dx=3,dy=-2) 주입 → 정확 복원, peak>0.999. 동일 프레임 dx=dy=0·peak≈1. featureless(상수) 배열 → 분산 0 → peak=0(방어). 실제 시프트가 maxShift 초과 시 반환값이 항상 `[-maxShift, maxShift]` 내(경계 보장).
- **scaleGray**: s=1 항등(값 그대로). s>1 확대 시 동일 w×h 캔버스 유지·중심 밝기 보존.
- **estimateAlign**: 동일 프레임 → scale=1·dx=dy=0·peak≈1. cur이 ref 대비 1.1배 확대 → scale≈1.1 정확 선택·이동≈0·peak>0.9(이중 리샘플 스무딩으로 <1이나 높음, 02문서 임시검증 0.976과 정합). scales 미지정 시 [1] 폴백.

### 2. `test/preciseCore.test.ts` (기능1/2/3 web/core.js 순수 6종 · 32)
- **cameraposListRows**(기능1): camIdx ASC → presetIdx ASC 정렬 순서, 원본 불변(새 배열), null 방어.
- **parseLoadedCamerapos**(기능1): 최상위 배열/`{views:[]}` 정상 파싱, label 폴백(`Preset {n}`)·보존, 깨진 JSON→`{ok:false}`, 배열아님→형식오류, 필드누락(pan)→1-based 항목번호 메시지, 문자열 zoom→거부.
- **hitTestDetections**(기능2): vehicle rect 내부(`handle:in`), 선택 vehicle 코너 핸들 우선(`nw`), plate quad 내부, 선택 plate 정점 우선(`vertex`), 빈 곳 null, vehicle rect가 plate quad보다 우선(겹침).
- **removeDetection**(기능2): vehicle/plate splice, 여타 필드(meta) 보존, 원본 불변, 인덱스 범위밖 무변형, sel 없음 얕은복사.
- **applyTranslateScale**(기능3): 항등(근사), 순수 이동, 중심 기준 2배 스케일(중심 불변·코너 2배), 커스텀 중심.
- **transformPlaceRoiPreset**(기능3): 항등(근사)·idx 보존, 순수 이동 가산, 원본 불변, null 방어.

### 3. `test/placeRoiUpdate.test.ts` (기능3 백엔드 역변환 · 9)
대상: `src/capture/placeRoi.ts` — `applyPlaceRoiUpdate`.
- 정규화→픽셀 역변환 정확성([0.5,0.5]×1920/1080→[960,540], [0,0]→[0,0], [1,1]→[1920,1080]).
- 대상 카메라의 타 프리셋 보존, 타 카메라 보존, 최상위/카메라 메타(imageWidth 등) 보존.
- 원본 json 불변.
- 방어(throw 금지): 대상 카메라 부재→내용 동등, 대상 프리셋 부재→변형없음, 이미지 크기 0→해당 카메라 변형없음, 비객체 입력→그대로 반환.
- **경계면 교차검증**: `applyPlaceRoiUpdate`(픽셀 역변환) ↔ `normalizePtzCamRoi`(정규화) **왕복 정합** — 정규화 4점 저장 후 되읽으면 동일 정규화값 복원(PUT→GET 라운드트립의 순수 코어 증명).

## 경계면 교차 비교(핵심)

- **autocorrect 라우트 ↔ frameAlign**: 02문서 §기능3 라우트에서 `estimateAlign` 결과를 `{dx:dxPx/128, dy:dyPx/72, scale, peak}`로 정규화. frameAlign의 dx/dy는 그리드 픽셀 단위(ALIGN_W=128, ALIGN_H=72)이며 정규화 오프셋은 다운스케일 불변 — 테스트에서 픽셀 시프트 정확 복원을 검증해 라우트의 나눗셈 정규화가 성립함을 뒷받침. 부호 규약(`ref[p]≈cur[p+(dx,dy)]`)도 shift 헬퍼로 명시 검증.
- **place-roi PUT(정규화 spaces) ↔ PtzCamRoi.json(픽셀 정본)**: `applyPlaceRoiUpdate`가 `{x,y}`(정규화)→`[x*W, y*H]`(픽셀 배열)로 역변환, `normalizePtzCamRoi`는 `[x,y]`(픽셀)→`x/W, y/H`(정규화). 두 함수의 좌표 shape(객체 `{x,y}` ↔ 배열 `[x,y]`)·1-based cam_id/preset_idx 매칭을 왕복 테스트로 교차 확인.
- **transformPlaceRoiPreset(프론트 오버레이) ↔ applyPlaceRoiUpdate(백엔드 저장)**: 둘 다 정규화 `{idx, points:[{x,y}]}` shape을 소비. 프론트가 오버레이 변환에 쓰는 값이 그대로 PUT 본문(zod: `spaces=[{idx, points:[{x,y}]}]`)이 됨 — shape 일치 확인.

## 수정 이력(테스트 결함 자가수정)

- **부동소수점 근사**: `transformPlaceRoiPreset`/`applyTranslateScale` 항등변환 테스트에서 초기 `toEqual` 사용 시 `0.5 + 1*(0.1-0.5) = 0.09999999999999998` 로 비트 불일치. 이는 중심 감산·가산의 정상적 부동소수점 특성(구현 버그 아님)이므로 `toBeCloseTo(…, 10)` 근사 비교로 수정. 재실행 통과.
- TS strict 대응: frameAlign `scales: number[]` 명시, DetectResult.vehicles optional에 대한 non-null 접근, CameraposView.label 필수 필드 보강.

## 한계(누락 명시 — 삭제·통과위장 없음)

vitest는 순수 로직만 검증한다. 다음은 **리더 라이브/브라우저 수동** 소관(실증 완료 또는 별도):
- **DOM 오버레이 편집**: `wireOverlayEditing` mousedown 분기, 드래그(detResize/detMove/detVertex)의 제자리 변형, `drawDetectOverlay` 하이라이트·핸들 렌더.
- **단축키**: Delete/Backspace 삭제, Esc 해제, 입력 포커스 시 무시.
- **sharp 픽셀 추출 라우트**: `POST /capture/refframe`(jpg write), `POST /capture/autocorrect`(sharp greyscale+resize+raw), `PUT /capture/place-roi`(파일 read/write·zod·상태코드 404/500/502) — 리더 라이브 실증 완료(refframe 저장·autocorrect dx0/peak0.99999 및 pan+3° dx-0.094/peak0.93·place-roi PUT ok spaceCount:6).
- **실 프레임 정합·물리 이동**: 카메라 미세 이동→자동보정→오버레이 폴리곤 이동/스케일, 리스트 행 클릭→물리 이동+스트림 재연결, 검출 편집분 재검출 시 소멸(임시 특성) — 리더 라이브/브라우저 수동.
- **camerapos CRUD 라우트**: 기존 GET/PUT `/viewer/api/camerapos` 재사용(리더 CRUD 실증 완료).

## 검증 명령(재현)

```
cd d:/Work/Parking3D/AgentVLA/ParkAgent/SettingAgent
npx tsc --noEmit          # 통과(무출력)
npx vitest run            # 121 files / 1304 tests passed
npx vitest run test/frameAlign.test.ts test/preciseCore.test.ts test/placeRoiUpdate.test.ts  # 신규 50 passed
```

## 결론

정밀수집 3기능의 순수 로직(상호상관·스케일 정합·아핀 변환·정규화 역변환·리스트 정렬·로컬 파싱·검출 히트/삭제)이 계획 성공 기준을 충족한다. 구현 결함 0, 회귀 0, 타입체크 통과. 라우트·DOM·실 프레임은 리더 라이브 실증으로 커버됨(위 한계에 명시). **문서화 단계 진행 가능.**
