# 04 영향도 분석 — 주차면(파일 ROI) 신규 그리기 도구

작성: 2026-07-28 12:49 / 문서화(documenter)
최종 문서: `SettingAgent/docs/20260728_124910_주차면_신규그리기_도구.md`

---

## 1. 변경/신규 파일과 파급

| 파일 | 구분 | 파급 대상 |
|---|---|---|
| `src/ground/quadDiag.ts` | 신규 | `POST /capture/place-roi/validate` 라우트에서만 사용. 외부 파급 없음(신규 read-only 유틸) |
| `src/ground/groundModel.ts` | 수정(export만) | `isUsableQuad`를 쓰는 기존 호출부(L3 부트스트랩/그리드 경로)는 **값·로직 무변경**이라 영향 없음. `quadDiag.ts`가 새 소비자로 추가됨 |
| `src/capture/placeRoi.ts` | 수정(래퍼 보존) | 기존 `applyPlaceRoiUpdate` 호출부 3곳(자동보정 `alignApply`, 목록 `savePlaceRoi`, `groundGridRoutes` apply 루프)은 시그니처·반환값 100% 동일 — **무변경 취급**. 신규 `applyPlaceRoiUpdateEx`는 `captureRoutes.ts` PUT 핸들러에서만 사용 |
| `src/api/captureRoutes.ts` | 수정 | PUT `/capture/place-roi` 응답에 `applied`/`appliedCount`/`issues` **가산**(기존 필드·상태코드 불변) → 이 필드를 안 보는 기존 클라이언트는 영향 없음. 신규 `POST /capture/place-roi/validate`는 새 엔드포인트 — 기존 라우팅과 충돌 없음(테스트 `captureRoutesShape.test.ts`가 등록을 강제) |
| `web/placeDraw.js`/`.d.ts` | 신규 | `web/app.js`에서만 import. `web/core.js`는 무변경(단 `hitTestQuadVertex`/`moveQuadVertex`를 placeDraw.js가 **재사용**만 함) |
| `web/app.js` | 수정(범위 큼) | 아래 §2 "기존 기능 영향" 참조 |
| `web/index.html`/`app.css` | 수정(가산) | 신규 버튼/체크박스/커서 클래스 추가. 기존 DOM id·클래스 제거 없음 |
| `test/*` 4종 신규 + 2종 1줄 수정 | — | 테스트 전용, 런타임 영향 없음 |

### 무변경 확인(보호 파일) — `git diff --numstat` 재확인 결과
```
$ git diff --numstat -- src/ground/project.ts src/ground/types.ts src/capture/floorRoi.ts \
    web/core.js src/capture/Finalizer.ts src/capture/SqliteStore.ts src/capture/roiDbLoad.ts
(출력 없음 = 전부 0줄 변경)
```
7파일 전부 무변경을 문서화 시점에 직접 재확인했다(리더·검증자 보고와 일치).

### 참고 — `data/Place01/PtzCamRoi.json`의 git 상태
`git status`에는 `M`(수정)으로 표시되지만, 이는 **이번 작업 이전(2026-07-22 커밋 이후)부터 이어진 미커밋
WIP**이며, QA가 파일 mtime(`2026-07-27 23:40:57`)이 본 검증 세션 시작(07-28 11:53) 이전임을 확인해
**이번 라운드의 테스트가 실파일을 건드리지 않았음**을 증명했다. 이번 문서화 시점 재확인 결과도 이번
작업의 소스 변경(§1 표)에 `data/` 쓰기가 포함되지 않으므로 파급 원인이 아니다. **다만 이 파일 자체가
왜 아직 커밋되지 않은 diff를 갖고 있는지는 이번 작업 범위 밖 — "확인 필요" 항목으로 남긴다.**

---

## 2. 기존 기능 영향

### 2-1. 캔버스 편집(검출 det / VPD)
- **회귀 0**(구조적으로 증명): `wireOverlayEditing()`의 `mousedown`은 `if (state.placeDraw) {...; return;}`
  단 1블록이 최상단에 prepend됐고, `state.placeDraw === null`(그리기 모드 off)일 때 그 아래 기존 코드는
  **삭제·수정 없이 원문 그대로 실행**된다. `git diff`의 삭제(`-`) 라인은 함수 전체에서 단 1줄
  (`if (!wasDetect) markDirty();` → 조건 분기로 대체, 기존 kind에 대해서는 의미 동일).
- `floorVertex`(정점 드래그) 분기는 `!FLOOR_ROI_USE_LLM`(상수 `false`)로 원래도 도달 불가한 데드
  분기라, 신규 `placeVertex` 분기와의 kind 충돌 우려는 **실재하지 않았다**(F-4).
- 신규 `placeVertex` 히트테스트는 `#place-edit-vertex`(기본 unchecked) 뒤에 있어 OFF 상태에서는
  첫 줄에서 return — 정점편집을 켜지 않는 한 기존 det/VPD 히트테스트 우선순위에 영향 없음.

### 2-2. `#slot-list` UI (의도된 변경 — D-2로 병기 복구)
- 승인2(R3)로 `fileMode` 조건에 `|| placeSpaceCount() > 0`이 추가되어, **artifact가 있고 파일 ROI도
  있는 환경**(현재 Unity 운영 데이터: `data/Place01` 23면)에서는 목록이 **항상** 파일 평면 목록이 된다.
  이는 "캔버스 상호작용 회귀 0"과 별개로 **목록 UI 거동이 바뀐 것**이다(QA D-2가 지적).
- D-2 수정으로 기존 artifact 슬롯 목록(`renderArtifactSlotRows`)은 파일 목록 뒤에 구분 헤더와 함께
  **병기**되어 선택 기능 자체는 복구됐으나, **화면 레이아웃(항목 수·헤더 존재)은 변경됨** — 브라우저
  육안 확인 시 확인 대상.

### 2-3. `PUT /capture/place-roi` 호출부
| 호출부 | 영향 |
|---|---|
| 자동보정 `alignApply` | `applyPlaceRoiUpdate`(래퍼) 그대로 호출 — 무변경 |
| 목록 편집 `savePlaceRoi`(app.js) | `create`/`applied` 확장을 **직접 활용**하도록 수정됨(이번 작업의 핵심 변경) |
| `groundGridRoutes.ts` apply 루프 | `applyPlaceRoiUpdate`(래퍼) 그대로 호출 — 무변경 |
| 신규 제3의 클라이언트(있다면) | `spaceCount`가 여전히 "요청 개수"이지 "적용 개수"가 아님(D-4) — `applied`를 안 보면 과거와 동일한 착시 위험이 남음(QA 권고: 계약 주석 명시) |

### 2-4. 지면격자(ground grid) 패널
- `ggRefSpace()`가 `state.placeRoi`를 순회해 `s.idx === state.selectedPlaceIdx`를 찾는 방식은 무변경.
  신규 그리기 커밋 시 `state.selectedPlaceIdx`를 새 idx로 설정하므로 **기존 선택 로직을 그대로 재사용**해
  L3에 연결된다(신규 로직 0줄).
- `ggPreview`에 미저장(`placeRoiDirty`) 게이트가 새로 추가됨 — 저장하지 않고 미리보기를 시도하면
  버튼 동작 자체가 막히고 "저장 후 미리보기하세요" 안내가 뜬다(서버가 파일을 읽는다는 사실을 사용자
  동작으로 노출). 기존 정상 흐름(저장 후 미리보기)에는 영향 없음.

### 2-5. 전역 idx 의존(`slot_ptz.json` · 센터링 · artifact `globalIndex`)
- 신규 면은 **항상 끝 append**(idx = 기존 면 수 + 1)로만 생성 가능 — 기존 면의 idx·좌표는 검증자가
  실데이터 동형 픽스처(N=23)로 재현해 **하나도 안 흔들림**을 확인(`toEqual` 전건 일치, 순열 `[1..24]`
  유지, `normalizeGlobalIdx` 멱등).
- 따라서 `slot_ptz.json`·센터링 매핑·artifact `globalIndex`는 **기존 면에 대해서는 영향 없음**. 신규
  면이 추가된 이후에는 그 신규 idx에 대해 센터링·`slot_ptz.json` 갱신이 **후속 워크플로(기존 절차)로
  별도 필요**하다 — 이번 작업 범위는 "면을 만들고 저장하는 것"까지이며, 센터링 파이프라인 자체는
  손대지 않았다.

---

## 3. 테스트

- 신규 테스트: `test/placeDraw.test.ts`(11) · `test/placeRoiCreate.test.ts`(7, QA D-1 봉인 포함) ·
  `test/placeRoiValidate.test.ts`(10) · `test/placeDrawWiring.test.ts`(14, QA D-1/D-2/D-5 봉인 포함)
  = 최초 구현 42건 + QA 수정 라운드 5건 추가.
- 회귀: `npx tsc --noEmit` 0에러, `npx vitest run` **256파일/3052테스트 green**(구현자·검증자 실행 수치
  일치), L3 골든 해시(`test/groundGrid.test.ts`) **13/13 green**.
- 회귀 0은 소스 텍스트 봉인뿐 아니라 **검증자의 `git diff` 삭제 라인 전수 조사**로 구조적으로 증명됨.

---

## 4. 운영 유의

- **서버 재시작 필요 여부**: TypeScript 컴파일 산출물을 서빙하는 기존 배포 방식과 동일 — 신규 라우트
  포함 재빌드/재시작 필요(런타임 핫리로드 없음, 기존 운영 절차와 동일).
- **라이브 미시작 시 저장 거부 조건**: `savePlaceRoi`가 `frame.naturalWidth/naturalHeight`를 사용하며
  `> 0`이 아니면 PUT을 보내지 않고 즉시 중단("라이브 프레임을 먼저 시작하세요"). 이 가드는 **골격이
  필요한 경로(`needsPlaceSkeleton`)에서만** 적용되도록 D-1 수정에서 조정되어, 기존 저장 경로(이미
  파일에 있는 cam/preset 갱신)에는 새로운 실패 조건을 추가하지 않는다.
- **신규 주차장 시작 절차**(빈 `PtzCamRoi.json` 또는 파일 부재):
  1. 라이브 프레임 시작(뷰어에서 스트림 표시) — `naturalWidth/height` 확보 필수.
  2. `[면 그리기]` → 캔버스 4클릭으로 사다리꼴 → 저장(자동으로 `create` 골격 첨부, PTZ는 현재 프리셋
     값 또는 뷰어 현재 PTZ 사용).
  3. 목록에서 선택 → 지면격자 패널에서 미리보기.
  4. 실패(f²≤0) 시 같은 카메라의 다른 프리셋에도 1면을 추가로 그려 재시도(R2 한계, 이번 범위로 근본
     해결하지 않음).

---

## 5. 후속 권고 (우선순위)

1. **[최상위] 브라우저 육안 확인** — 클릭이 원하는 지점에 찍히는가, 노란 점/고무줄선/crosshair 커서가
   보이는가, D-2 병기 목록의 구분 헤더(`.slot-empty` 재사용)가 시각적으로 구분되는가. 7라운드 연속으로
   미검증인 영역이며, 이번 작업은 본질이 캔버스 상호작용이라 리스크가 가장 크다.
2. Loop 4(L3 연결) 라이브 종단을 실카/Unity에서 재확인 — 지금까지는 전부 `app.inject`(in-process) 기반.
3. `frame.naturalWidth`가 실카 설정 해상도와 일치하는지 실측 대조(현재는 SettingAgent 내부에
   다운스케일이 없다는 코드 근거까지만 확보, RTSP 서브스트림 케이스는 미확인).
4. R2(단일 quad `focalFromVPs` f²≤0) 근본 해결 — 이번 범위는 UI 행동 지시(다른 프리셋에 추가로 그리기)로
   우회했을 뿐, 1면짜리 신규 주차장에서 구조적으로 실패할 수 있는 케이스가 남아 있다.
5. `data/Place01/PtzCamRoi.json`의 미커밋 WIP diff(§1 참고) 정리 — 이번 작업 범위 밖이지만 방치 시
   차기 라운드의 "무접촉 증명"을 흐릴 수 있다.
6. D-4(`spaceCount`가 적용 개수가 아님) 계약 주석 명시 — 우선순위 낮음(경).
