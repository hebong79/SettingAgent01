# 영향도 분석 — 클릭 기반 개별 센터라이징

입력: `01_architect_plan_click_centering.md`(설계) · `02_developer_changes.md`(구현 노트) · `03_qa_report.md`(검증, 180파일/2089테스트 전부 통과·회귀 0) + 실제 코드(`src/calibrate/PtzCalibrator.ts`, `src/api/calibrateRoutes.ts`, `web/index.html`, `web/app.js`, `web/app.css`) 직접 확인.

## 1. 변경 파일별 영향 범위

| 파일 | 변경 종류 | 영향 범위 |
|---|---|---|
| `src/calibrate/PtzCalibrator.ts` | 가산 — `centerOnPoint()` public 메서드 신규(140~187행), `pointBusy` private 필드 신규(118행) | 클래스 내 기존 `start()`/`run()`/private 헬퍼(`baseOpts`, `startPtzFor`, acquire/width 사다리)는 코드 상 미변경. `centerOnPoint`는 `makePlatePtz`/`startPtzFor`/`baseOpts`를 **호출만** 하고 그 구현을 바꾸지 않음. `NormalizedRect` import 1개 추가(구현 노트 기준) — 이미 파일 상단에서 `quadBoundingRect, center`를 `../domain/geometry.js`에서 가져오는 것으로 확인(7행), 타입만 추가 사용 |
| `src/api/calibrateRoutes.ts` | 가산 — `POST /calibrate/point` 라우트 + `PointBodySchema` 신규(9~14, 45~59행) | 기존 4개 라우트(`/calibrate/ptz`, `/calibrate/status`, `/calibrate/frame`, `/calibrate/result`)는 코드 위치·본문 모두 미변경(직접 대조 확인). `registerCalibrateRoutes` 함수 시그니처(`CalibrateRouteDeps`) 불변 — 호출부(서버 부트스트랩) 재컴파일 영향 없음 |
| `web/index.html` | 가산 — `#cal-click-mode` `<select>` 삽입(203~214행) | `.centering-inline`/`.centering-progress` 등 주변 DOM 구조·id는 유지. 신규 id `cal-click-mode`가 다른 요소와 충돌하지 않음(그렙으로 유일성 확인) |
| `web/app.js` | 가산 — `wireOverlayEditing()`의 `mousedown` 핸들러 최상단에 게이트 3~4줄 삽입(3270~3279행), `calPointCenter()` 신규 함수(2344~2379행), `calPointBusy` 모듈 전역 변수, `change` 리스너 1개(3427~3429행) | **오버레이 클릭 경로에 직접 개입** — 아래 §3에서 상세 분석. `startCalFramePolling`/`stopCalFramePolling`/`startLive`/`eventToNorm` 등 기존 함수는 재사용만(수정 없음) |
| `web/app.css` | 가산 — `#overlay.click-centering { cursor: crosshair }` 1블록(1811~1813행) | 순수 시각 피드백. 기존 셀렉터와 겹치지 않음(신규 클래스명) |

**결론**: 5개 파일 전부 **가산 변경**이며, 기존 배치 센터라이징(`start`/`run`)·저장 3종(writer/DB/스냅샷)·기존 라우트 4개·기존 오버레이 편집 로직의 실행 경로 자체는 코드 상 한 줄도 수정되지 않았다. 유일하게 "기존 실행 경로에 물리적으로 개입"하는 지점은 `web/app.js`의 `overlay.mousedown` 핸들러 최상단 게이트이며, 그 게이트는 조건부 조기 `return`이라 `cal-click-mode`가 `off`(기본값)일 때는 이후 코드 흐름에 어떤 영향도 주지 않는다(§3에서 근거 제시).

## 2. 의존성·경계면

```
web/app.js (calPointCenter)
   │ POST /calibrate/point  { cam, preset, point:{x,y}, zoom }
   ▼
src/api/calibrateRoutes.ts (PointBodySchema 검증)
   │ deps.calibrator.centerOnPoint(cam, preset, point, {zoom})
   ▼
src/calibrate/PtzCalibrator.ts (centerOnPoint)
   │ makePlatePtz({...baseOpts(), plateRoi:클릭점}).centerOnPlate(...)
   │ makePlatePtz({...baseOpts(), plateRoi:quadBoundingRect(...), gain}).zoomToPlateWidth(...)
   ▼
src/calibrate/platePtz.ts (PlatePtz — 무상태 결정형 도구, 변경 없음)
```

- **`calibrateRoutes.ts` ↔ `PtzCalibrator.ts`**: `centerOnPoint`의 반환 타입 `{ ok, ptz, plateWidth, reason? }`을 라우트가 그대로 매핑(53행). qa가 이 경계를 직접 대조 검증(§경계면 교차 검증 표, "반환 타입 ↔ 200 응답" ✅). 타입이 바뀌면 라우트도 같이 바뀌어야 하므로 향후 `centerOnPoint` 반환 shape 변경 시 `calibrateRoutes.ts` 53행이 1차 영향점이다.
- **프론트 body ↔ `PointBodySchema`**: `web/app.js` 2359~2363행의 `{cam, preset, point:{x,y}, zoom}`과 스키마(cam/preset=int≥0, point.{x,y}=number, zoom=bool optional)가 qa에서 대조 확인됨(✅ 일치). `cam`/`preset`은 `state.capFrameKey2` 규약(1-based)을 그대로 쓰므로 라우트의 `nonnegative()` 제약과 정합.
- **`/calibrate/frame` 공유(상호배타)**: 배치 센터라이징과 개별 센터라이징 모두 동일한 `GET /calibrate/frame`(`calibrator.getLastFrame()`)을 폴링 소스로 공유한다. 프론트의 `startCalFramePolling`/`stopCalFramePolling`은 배치(`calStart`)와 개별(`calPointCenter`) 양쪽에서 재사용되며, 두 경로가 동시에 폴링을 걸지 않는 것은 백엔드의 `state`/`pointBusy` 상호배타(카메라가 한 번에 한 작업만 수행)에 의해 논리적으로 보장된다 — 프론트 폴링 자체에는 별도 락이 없으나, 배치 실행 중 개별 요청은 409로 즉시 거절되고 그 반대도 동일하므로 실질적으로 한쪽만 진행한다.
- **`plateRoi`/`peerOffsets` 계약**: `centerOnPlate`는 `peerOffsets` 미주입 시 `pickNearestPlate`(최근접 선택)로 동작하는 기존 계약을 그대로 사용한다. `centerOnPoint`는 이 계약을 바꾸지 않고 소비만 한다 — `platePtz.ts` 자체는 미수정.

## 3. `web/app.js` 오버레이 게이트 — 회귀 리스크 상세

```js
const clickMode = $('cal-click-mode')?.value;
if (clickMode && clickMode !== 'off' && !e.ctrlKey) {
  const { nx, ny } = eventToNorm(e);
  e.preventDefault();
  void calPointCenter(nx, ny, clickMode === 'center-zoom');
  return;
}
```

- `$('cal-click-mode')`의 기본 옵션 값은 `off`(`<option value="off" selected>`, index.html 210행) — 신규 기능을 쓰지 않는 모든 기존 사용자/기존 E2E 흐름에서 `clickMode === 'off'`이므로 `if` 조건이 거짓이 되어 게이트를 그대로 통과, 이후 기존 편집 분기(검출 박스 편집·슬롯 선택 등, 3280행 이하)로 진입한다. **코드 흐름상 기존 mousedown 핸들러 로직에 어떤 문자도 삽입/삭제되지 않았다** — 삽입된 것은 이 조건문 블록뿐이며 조건이 거짓이면 사실상 no-op이다.
- Ctrl 클릭은 명시적으로 게이트에서 제외(`!e.ctrlKey`)되어 기존 정점/슬롯 조작 제스처를 침범하지 않는다.
- 리스크: **낮음**. 다만 이 부분은 vitest 대상이 아닌 순수 DOM 이벤트 배선이라 qa 리포트가 "프론트 DOM E2E 미검"으로 명시한 한계(§4-1)가 그대로 적용된다 — 코드 대조로는 안전성을 확인했으나 실제 브라우저 클릭 시나리오의 자동화 테스트는 없다.

## 4. 회귀 리스크 평가

| 리스크 축 | 평가 | 근거 |
|---|---|---|
| 데이터 파괴(저장 오염) | **없음(0)** | `centerOnPoint` 본문에 `writer`/`saveCenteringSlots`/`store.upsertSlotCentering`/`saveSetupSnapshot` 호출이 코드 상 전혀 없음(직접 확인). qa가 성공·실패 양 경로에서 저장 스파이 0회를 검증(§5-A-2). `finalize-slotsetup-wipe-fragility`(배치 replaceSlotSetup의 DELETE+INSERT 취약점)와 **무관** — 개별 경로는 그 코드에 진입하지 않음 |
| 카메라 경합 | **낮음** | `state==='running'`(배치)·`pointBusy`(개별) 이중 가드로 상호배타. qa가 배치 진행 중 개별 호출 throw, 개별 재진입 throw를 모두 검증(§5-A-5) |
| 기존 오버레이 편집 회귀 | **낮음** | 게이트가 `off`일 때 no-op임을 코드로 확인(§3). 단, 브라우저 E2E는 미검 — "확인 필요"로 남김 |
| 기존 라우트 회귀 | **없음** | 4개 기존 라우트 코드 미변경 확인. vitest 전체 180파일/2089테스트 통과, 회귀 0(신규 24 제외 시 기존 178파일/2065 그대로) |
| 타입/컴파일 회귀 | **없음** | `npx tsc -p tsconfig.json --noEmit` EXIT 0(구현 노트 인용) |
| 프론트 구문 오류 | **없음** | `node --check web/app.js` OK(구현 노트 인용) — 단 이는 구문 검사이며 런타임 DOM 동작 검증은 아님 |

## 5. 기존 기능 영향 확인

- **배치 센터라이징**(`센터라이징` 버튼 → `/calibrate/ptz` → `start`/`run`): 코드 미변경. 저장 경로(writer/`centering_slot`/Setup 스냅샷) 전부 무영향.
- **finalize / `slot_setup`**: `centerOnPoint`는 `slot_setup`을 읽지도 쓰지도 않는다(배치 경로만 `expandPlateTargetsFromSlotSetup`으로 `slot_setup`을 읽음). finalize의 `replaceSlotSetup` DELETE+INSERT 경로와 완전히 분리.
- **DB 스키마**: 6테이블 체계(`my_db_table.md` 정본) 변경 없음. `centering_slot` 테이블에 대한 UPDATE 경로는 배치 전용으로 유지.
- **`/calibrate/frame` 폴링 계약**: 응답 shape(JPEG + `X-Cal-Cam`/`X-Cal-Preset` 헤더) 미변경. 개별 경로는 이 기존 GET을 소비만 함.

## 6. qa 한계 승계 (완료로 위장하지 않음)

`03_qa_report.md`가 명시한 한계를 그대로 승계한다:

1. **프론트 DOM E2E 미검**: `overlay.mousedown` 게이트 → `calPointCenter` → `fetch`로 이어지는 실제 브라우저 클릭 → 라우트 발화 흐름은 vitest 범위 밖이다. body shape·zoom 매핑은 소스 대조로만 확인했다. **실제 브라우저에서의 라이브 스모크 테스트가 수행되지 않았다** — "확인 필요" 항목.
2. **줌 실패 reason 미전파(UX 한계)**: "센터링 성공, 줌 실패" 상황에서 응답은 `ok:true`이며 줌 실패 이유가 `reason`에 담기지 않는다(`centered`의 reason만 반환되고 `centered`는 성공 시 reason이 없음). 조작자는 `plateWidth`를 보고 간접 판별해야 한다. 결함이 아니라 설계 정본 동작이나, UX 개선이 필요하면 후속 논의 대상.
3. **`centerOnPlate`/`zoomToPlateWidth` 폐루프 내부 로직**은 `centerOnPoint` 테스트에서 팩토리 시임으로 목킹되어 오케스트레이션만 검증되었다(폐루프 자체는 기존 `platePtz.test.ts`/`ptzCalibrator.test.ts`가 별도 커버 — 이번 변경으로 그 테스트들이 수정되지는 않았음).

## 7. 종합

- 전 파일 가산 변경, 기존 배치 저장·라우트·DB 경로 무접촉을 코드 레벨로 확인.
- 유일한 실행 경로 개입점(오버레이 mousedown 게이트)은 `off` 기본값에서 no-op임을 코드로 확인했으나, 브라우저 런타임 E2E는 미검 상태로 남아있다.
- 회귀 리스크는 vitest 전체 통과(180파일/2089테스트, 회귀 0)로 뒷받침되는 범위 내에서 낮음. 다만 이는 "코드 경계면"의 회귀 부재를 뜻하며, 프론트 DOM 동작의 실사용 검증은 별도 라이브 스모크가 필요하다(qa §한계-1과 동일 결론).

---

# 영향도 분석 추가분 — 개별 center "클릭 지점 자체를 화면중앙으로"(번호판 무관)

입력: `02_developer_changes.md`(구현 노트, 이번 변경분) · `03_qa_report.md`(검증, 180파일/2104테스트 전부 통과·회귀 0) + 실제 코드(`src/calibrate/PtzCalibrator.ts` 189~224행, `src/api/calibrateRoutes.ts`, `web/app.js` 2344~2379/3271~3280행) 직접 확인. 위 섹션(클릭 기반 개별 센터라이징 최초 도입분)을 전제로 그 위에 얹힌 변경이다 — "개별 center" 옵션이 **가리키는 백엔드 동작**만 바뀌었고, 기능 골격(콤보 게이트·저장 없음 원칙·상호배타)은 무접촉.

## 1. 변경 파일별 영향(가산·수정 구분)

| 파일 | 변경 종류 | 영향 범위 |
|---|---|---|
| `src/calibrate/PtzCalibrator.ts` | **가산** — `aimPointToCenter()` public 메서드 신규(201~224행), `centerOnPoint` 바로 아래 삽입 | 기존 `centerOnPoint`(162~187행)·`start`/`run`(배치)·`preAimPtz`(492행 부근)·저장 경로는 코드 상 한 줄도 수정되지 않음(직접 대조 확인). `aimPointToCenter`는 `startPtzFor`/`scaleGainForZoom`/`panTiltCorrection`/`PREAIM_MAX_STEP`을 **호출만** — 신규 import 0(전부 기존 파일 상단에 이미 존재). `pointBusy` 락 필드를 `centerOnPoint`와 **공유**하므로 두 개별 경로(점 조준/번호판 center)가 서로도 배타적이다(신규 필드 추가 없음, 기존 필드 재사용) |
| `src/api/calibrateRoutes.ts` | **수정** — `PointBodySchema`에 `mode` 필드 추가(15행), 핸들러에 `mode==='point'` 분기 추가(55~58행) | 기존 4개 라우트(`/calibrate/ptz`, `/calibrate/status`, `/calibrate/frame`, `/calibrate/result`) 코드 미변경. **단, `PointBodySchema`와 핸들러 자체는 이번이 두 번째 수정**(최초 도입분에서 `zoom` 불리언만 있던 스키마에 `mode` enum이 가산됨) — `zoom` 필드·legacy 분기(61행 `mode ? ... : body.zoom`)는 그대로 보존돼 **하위호환 깨짐 없음**을 코드로 확인 |
| `web/app.js` | **수정** — 오버레이 게이트의 `calPointCenter` 3번째 인자를 `zoom`(bool) → `mode`(string)로 변경(3278행), `calPointCenter` 함수 시그니처·진행 메시지 분기 변경(2348, 2353행) | `web/index.html`(콤보 마크업)·`web/app.css`(crosshair 클래스)는 **무접촉**(이번 변경은 백엔드 매핑만 바꿈, UI 마크업 변경 없음). `startCalFramePolling`/`stopCalFramePolling`/`startLive`/`eventToNorm`은 재사용만(무수정) |

**결론**: 3개 파일 중 `PtzCalibrator.ts`는 가산, `calibrateRoutes.ts`·`web/app.js`는 기존 코드 일부 수정(시그니처/분기 변경)이지만 legacy 경로(무-mode, `zoom` 불리언)를 그대로 보존해 **호환성 파괴 없음**을 코드·테스트 양쪽으로 확인했다.

## 2. 경계면(확장)

```
web/app.js (calPointCenter)
   │ POST /calibrate/point  { cam, preset, point:{x,y}, mode }   ← zoom(bool) 대체
   ▼
src/api/calibrateRoutes.ts (PointBodySchema: mode 추가 검증)
   │ mode==='point'  → calibrator.aimPointToCenter(cam,preset,point)        → {ok,ptz}
   │ mode!=='point'  → calibrator.centerOnPoint(cam,preset,point,{zoom})    → {ok,ptz,plateWidth,reason?}
   ▼                                    ▼
src/calibrate/PtzCalibrator.ts      src/calibrate/PtzCalibrator.ts
   aimPointToCenter (신규)              centerOnPoint (무변경)
   │ startPtzFor → 개루프 1스텝            │ makePlatePtz.centerOnPlate/zoomToPlateWidth (폐루프, 무변경)
   ▼
this.camera.requestImage (기존 인터페이스, 무변경)
```

- **`calibrateRoutes.ts` ↔ `PtzCalibrator.ts` 신규 경계**: `aimPointToCenter`의 반환 타입 `{ ok, ptz }`(plateWidth/reason 없음)를 라우트가 그대로 매핑(57~58행). qa가 B-1 케이스로 `plateWidth` 키 부재를 `not.toHaveProperty`로 직접 검증. 향후 `aimPointToCenter` 반환 shape이 바뀌면 라우트 57~58행이 1차 영향점.
- **프론트 body ↔ `PointBodySchema` 신규 필드**: `web/app.js` 2362행의 `{cam, preset, point:{x,y}, mode}`과 스키마의 `mode: z.enum(['point','plate','plate-zoom']).optional()`이 qa에서 대조 확인됨. 콤보는 `mode:'plate'`(center-only-no-zoom)를 UI로 노출하지 않으나, 스키마·라우트는 지원 상태로 남아 있다 — API 소비자가 직접 `mode:'plate'`를 보내는 것은 여전히 유효(문서 §4.1에 "확인 필요" 아님, 코드로 확인된 사실).
- **legacy 하위호환 경계**: `mode` 미전달 시 `body.zoom`(불리언)으로 낙하하는 61행 분기는 최초 도입분과 동일 로직을 유지 — 이번 변경이 `mode`를 "추가"했을 뿐 `zoom` 경로를 제거하지 않았음을 코드로 확인(제거했다면 구버전 클라이언트/테스트가 깨진다).
- **`pointBusy` 공유 배타**: `aimPointToCenter`와 `centerOnPoint`가 동일 `pointBusy` 필드를 쓰므로, 개별 center(점 조준) 진행 중 개별 center+zoom(번호판) 요청이 오면 `pointBusy` throw(409)로 거절된다 — 즉 두 개별 모드도 서로 배타적이다(신규 파악 사실, qa A-5b가 재진입 케이스로 간접 커버).

## 3. 회귀 리스크(이번 변경분)

| 리스크 축 | 평가 | 근거 |
|---|---|---|
| 데이터 파괴(저장 오염) | **없음(0)** | `aimPointToCenter` 본문에 저장 호출(writer/DB/스냅샷) 전혀 없음(코드 직접 확인). qa A-3이 저장 스파이 0회 검증 |
| `centerOnPoint`(번호판 center+zoom, 3옵션) 회귀 | **없음** | 메서드 코드 자체 미수정(직접 대조). 라우트에서 `mode==='plate-zoom'`으로 도달하는 경로가 `zoom:true` legacy와 동일 호출(`centerOnPoint(...,{zoom:true})`)임을 코드로 확인. qa B-2/B-4a가 각각 검증, 결과 동일 |
| legacy(`zoom` 불리언, mode 미전달) 회귀 | **없음** | 61행 분기 보존 확인. qa B-4a/B-4b가 명시적으로 재검증(회귀 스위트에 그대로 남음) |
| 카메라 경합 | **낮음** | `pointBusy`를 `aimPointToCenter`/`centerOnPoint`가 공유, `state`(배치)와도 배타. qa A-5a/b가 두 throw 케이스 검증 |
| 프론트 배선 회귀 | **확인 필요** | `calPointCenter` 3번째 인자 타입 변경(불리언→문자열)이 호출부 3278행 외에 다른 호출부가 없는지는 그렙으로 1곳만 확인했으나, 실제 브라우저 런타임 동작(E2E)은 미검 — qa §6과 동일 한계 |
| 타입/컴파일 회귀 | **없음** | tsc 에러 0(선재 3에러 포함 해소). vitest 180파일/2104테스트 전부 green, 회귀 0 |

## 4. 한계 승계(완료로 위장하지 않음)

1. **개루프 1스텝 조준의 실측 정확도**: vitest는 공식(`scaleGainForZoom`/`panTiltCorrection`) 배선의 정합만 검증했고, 실제 카메라에서 클릭 지점이 화면중앙에 얼마나 근접하는지는 fallback 게인의 실측 정확도(cam1 시뮬 유도값)에 좌우된다 — 비-cam1 실카메라 라이브 실측 미수행.
2. **프론트 DOM E2E 미검**: 최초 도입분과 동일한 한계가 이번 변경(인자 타입 변경)에도 이어진다 — 실제 브라우저 클릭→`calPointCenter`(신 시그니처)→`fetch` 발화는 미검.
3. **선재 tsc 3에러**는 qa가 테스트 파일 타입 주석만 수정해 해소(런타임 무변경) — developer 재작업 불필요, 이번 변경의 구현 결함 아님.

## 5. 종합(추가분)

- `PtzCalibrator.ts`는 가산, `calibrateRoutes.ts`/`web/app.js`는 legacy 보존 하에 수정 — 3옵션(번호판 center+zoom)·저장 없음 원칙·상호배타 세 가지 핵심 계약 모두 무회귀를 코드+테스트로 확인.
- 유일한 신규 리스크 표면은 "개루프 1스텝의 실카메라 정확도"이며, 이는 결정형 유닛으로 검증 불가능한 영역으로 명시적으로 남겨둔다(위장 금지).

---

# 영향도 분석 추가분 — 개루프 1스텝 실패 → 클릭 패치 NCC 폐루프 재구현

바로 위 섹션(`aimPointToCenter` 개루프 1스텝 도입분)의 **실카메라 실패**를 받아 이번에 재구현했다. 입력: `01_architect_plan_patch_aim.md`(설계, 리더 실측 게인/실패원인 포함) · `02_developer_changes.md`(구현 노트) · `03_qa_report.md`(검증, 182파일/2121테스트 전부 통과·회귀 0) + 실제 코드(`src/calibrate/patchTrack.ts`, `src/calibrate/PointAimer.ts`, `src/calibrate/PtzCalibrator.ts` 192~219행, `src/api/calibrateRoutes.ts`, `web/app.js` 2345~2380/3284~3288행) 직접 대조. 문서화 단계에서 `npx tsc --noEmit`(exit 0)·`npx vitest run`(182파일/2121테스트)을 독립 재실행해 동일 수치를 재확인했다.

## 1. 변경 파일별 영향(가산·수정 구분)

| 파일 | 변경 종류 | 영향 범위 |
|---|---|---|
| `src/calibrate/patchTrack.ts` | **신규** | 순수 함수 4종(`toGray`/`patchTexture`/`extractTemplate`/`nccSearch`), 상태 없음, `sharp` 외 신규 의존성 0. 다른 모듈이 아직 import하지 않으므로(현재 소비자는 `PointAimer.ts` 1곳) 독립 모듈 — 회귀 표면 자체가 이 파일 하나로 국한됨 |
| `src/calibrate/PointAimer.ts` | **신규** | 클래스 `PointAimer`(`aim()`). 의존은 `ICameraClient`/`ToolsConfig['calibrate']`/`sleep`/`onFrame`뿐 — `Repository`/`writer`/`DB` 미참조(저장 통로 없음). `controlMath`(`scaleGainForZoom`/`panTiltCorrection`/`isCentered`/`predictPlateCenter`)·`detectPipeline`(`resolvePresetPtz`)를 **재사용만**(그 함수들 본문은 무수정 — 배치 `preAimPtz`도 동일 함수를 계속 사용하므로 고아 없음) |
| `src/calibrate/PtzCalibrator.ts` | **수정** — `aimPointToCenter()` **본문 교체**(206~219행), `pointAimer: PointAimer` private 필드 신규(121행) + 생성자에서 1회 생성(131행), `import { PointAimer }` 1줄(14행) | 시그니처(`(camIdx,presetIdx,point)`)·반환 shape(`{ok,ptz,finalErr,iterations,reason?}`)·상호배타 가드(`state==='running'`/`pointBusy`)·`try/finally` **전부 무변경** — 라우트·프론트는 재컴파일 불필요. 개루프 인라인 코드(전용 preAim 호출·수동 `lastFrame` 갱신)는 제거되고 `PointAimer.aim` 위임으로 대체됨. `centerOnPoint`(번호판 center, 162~187행 부근)·`start`/`run`(배치)·`preAimPtz`는 코드 상 한 줄도 수정되지 않음(직접 대조 확인) |
| `src/api/calibrateRoutes.ts` | **수정** — point 분기 응답에 `reason`/`iterations` 조건부 스프레드 가산(58행) | `PointBodySchema`(`mode`/`zoom` 필드)·`mode!=='point'` 분기(61~63행)·기존 4개 라우트는 무변경. 성공 시(`reason` 없음) 스프레드가 아무것도 추가하지 않아 `{ok,ptz}` 그대로 — 기존 라우트 테스트(`calibrateRoutes.point.test.ts`)의 `toEqual({ok,ptz})` 단정이 스텁이 `reason`/`iterations`를 반환하지 않는 한 깨지지 않음(qa 확인) |
| `web/app.js` | **수정** — `calPointCenter` 실패 처리에 `mode==='point'` 한정 `reason`→한글 매핑 분기 추가(2373~2380행) | 성공 메시지·`plate`/`plate-zoom` 경로 메시지·409 처리·`index.html`/`app.css` 무변경. 콤보 게이트(`clickMode`→`mode` 매핑, 3284~3288행)는 직전 섹션에서 이미 도입된 것으로 이번엔 무접촉 |

**결론**: 신규 2파일(독립 모듈)+수정 3파일. 수정 3파일 모두 "본문 교체/가산"이며 시그니처·계약(라우트 응답 shape 핵심 필드, 프론트 성공 경로)은 보존됐다 — 배치 센터라이징·저장 3종·`mode:'plate'`/`'plate-zoom'`(번호판 center)·`controlMath`·`platePtz.ts`는 전부 무접촉.

## 2. 경계면 교차 확인

```
web/app.js (calPointCenter, mode:'point')
   │ POST /calibrate/point { cam, preset, point:{x,y}, mode:'point' }
   ▼
src/api/calibrateRoutes.ts  (mode==='point' 분기)
   │ calibrator.aimPointToCenter(cam,preset,point) → {ok,ptz,finalErr,iterations,reason?}
   │ 라우트는 {ok,ptz,reason?,iterations?}만 echo(finalErr는 라우트가 소비하지 않음)
   ▼
src/calibrate/PtzCalibrator.ts (aimPointToCenter)
   │ 상호배타 가드(state/pointBusy) → this.pointAimer.aim(camIdx,presetIdx,point) 위임
   ▼
src/calibrate/PointAimer.ts (aim)
   │ resolvePresetPtz → requestImage(cap0) → toGray → patchTexture 게이트(확대재시도)
   │ → extractTemplate → [panTiltCorrection→requestImage→toGray→predictPlateCenter→nccSearch] 반복
   ▼
src/calibrate/patchTrack.ts (toGray/patchTexture/extractTemplate/nccSearch, 순수함수)
```

- **좌표 정규화 일관성**: 라우트 `point{x,y}`(`NormalizedPoint`, 0~1) → `PointAimer.aim`의 `click` → `patchTrack`의 전 함수가 정규화 입출력(픽셀 인덱싱은 함수 내부 한정, `workW` 다운스케일과 무관) — 해상도 변경(1920↔960)에도 좌표계가 깨지지 않음을 코드로 확인(`clampCenter`가 매 함수에서 동일하게 픽셀 환산).
- **반환 shape 회귀점**: `aimPointToCenter`가 가산한 `finalErr`/`iterations`/`reason`을 라우트가 조건부 스프레드로만 echo하므로, 향후 `PointAimResult`(`PointAimer.ts` 76~83행)의 필드가 변경되면 `PtzCalibrator.ts:216`과 `calibrateRoutes.ts:58` 두 지점이 1차 영향점이다.
- **`onFrame`/`lastFrame` 공유**: `PointAimer`는 `PtzCalibrator` 생성자가 넘긴 동일한 `onFrame` 콜백(`lastFrame` 갱신)을 쓴다(`PlatePtz`와 동일 패턴) — `/calibrate/frame` 폴링이 배치·번호판 center·클릭 패치 폐루프 3경로 모두에서 동일하게 동작한다.
- **`pointBusy` 배타 유지**: `aimPointToCenter`는 여전히 `centerOnPoint`와 `pointBusy` 필드를 공유 — 이번 재구현이 상호배타 계약을 바꾸지 않았다(필드 재사용, 신규 락 없음).

## 3. 회귀 리스크

| 리스크 축 | 평가 | 근거 |
|---|---|---|
| 데이터 파괴(저장 오염) | **없음(0)** | `patchTrack.ts`/`PointAimer.ts` 어디에도 writer/DB/스냅샷 import·호출 없음(소스 정적 확인). qa가 저장 스파이 0회로 검증(§pointAimer.test.ts) |
| 배치 센터라이징(`start`/`run`) | **없음** | 코드 미변경. `PointAimer`는 별도 클래스로 `PlatePtz`/배치 경로와 공유 상태 없음(생성자에서 독립 생성) |
| `mode:'plate'`/`'plate-zoom'`(번호판 center) | **없음** | `centerOnPoint` 코드 미변경, `mode!=='point'` 라우트 분기 미변경 |
| 라우트 응답 계약(성공 케이스) | **없음** | 조건부 스프레드 — `reason`/`iterations` 미존재 시 `{ok,ptz}` 그대로. 기존 라우트 테스트 unaffected(qa 확인) |
| 프론트 성공 경로 | **없음** | 실패(`!data.ok`) + `mode==='point'` + `data.reason` 존재 조건에서만 새 분기 진입 — 성공 메시지·plate 경로 메시지는 그 조건에 걸리지 않음 |
| 개루프→폐루프 전환에 따른 기존 테스트 파괴 | **예상된 파괴, qa가 재작성으로 흡수** | `test/ptzCalibrator.point.test.ts` §A(구 개루프 계약: 가짜 JPEG+"requestImage 1회" 단정) 16건이 폐루프 위임 계약으로 재작성됨(§B plate 경로 11건은 무변경). 재작성 후 182파일/2121테스트 전부 green |
| 실카메라 강건성(저텍스처/원근/PTZ지연) | **경험적 검증만 가능, vitest 밖** | 리더 라이브 6클릭점 6/6 수렴(§본문 문서 §5)으로 뒷받침. 결정형 유닛은 알고리즘 정합(부호·좌표·수렴수학)만 보증(qa 한계 명시) |
| 타입/컴파일 회귀 | **없음** | `npx tsc --noEmit` exit 0(qa 인용 + 본 문서 작성 시 재확인) |

## 4. 한계 승계(완료로 위장하지 않음)

1. **비-cam1 카메라 게인 편차**: `fallbackGainPanDeg/TiltDeg`는 cam1 시뮬 실측 유래. 폐루프가 재측정으로 잔차를 흡수하므로 원리적으로는 수렴하나, 타 카메라의 초기 예측창 크기·반복 수·`WIDE_SEARCH_MULT` 재탐색 의존도는 **확인 필요**(미실측).
2. **저텍스처/야간/반복무늬**: 확대 재시도(32→64→96)에도 미달이면 `low_texture`/`patch_lost`를 정직 반환 — 기하 폴백 없음(VPD 자동검출 금지 원칙과 동일 기조).
3. **온라인 게인보정(refineGain) 미구현**: 의도적 설계 결정(§본문 문서 §2.3) — 향후 필요 시 EMA·발산가드 도입 여지만 주석으로 남김.
4. **프론트 DOM E2E 미검**: 직전 섹션과 동일한 기존 한계가 이번 재구현에도 이어진다(브라우저 실클릭→`calPointCenter`→`fetch` 발화 흐름은 vitest 범위 밖, 라이브 경험적 검증으로만 확증됨).

## 5. 종합(재구현분)

- 신규 2파일(순수 함수 모듈 + 무상태 조준기 클래스)은 저장 통로가 없어 데이터 파괴 리스크가 구조적으로 0이다.
- 수정 3파일(`PtzCalibrator.ts`/`calibrateRoutes.ts`/`web/app.js`)은 시그니처·계약을 보존한 채 본문/조건부 가산만 이뤄져, 배치·번호판 center·저장 경로 회귀가 코드 레벨로 확인되지 않는다.
- 유일하게 "예상된 파괴"인 개루프 전용 테스트(§A 16건)는 qa가 폐루프 위임 계약으로 재작성해 전량 green 전환했으며, 이는 개루프→폐루프 전환의 필연적 결과이지 결함이 아니다.
- 실카메라 강건성(저텍스처/원근/지연)은 리더의 라이브 6/6 수렴 결과로 뒷받침되나, 이는 vitest가 보증할 수 없는 영역으로 명시적으로 남겨둔다(위장 금지) — 상세 결과·게인표는 `docs/20260721_111734_클릭지점_중앙조준_폐루프.md` §5에 기록.
