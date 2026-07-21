# 영향도 분석 — 'DB 보기'(#roi-db) 소스 전환 수정

작성: 2026-07-21 · documenter
최종 문서: `docs/20260721_215536_DB보기_소스전환_수정.md`
변경 파일: `web/app.js`, `web/index.html` (+ 신규 `test/dbViewSourceSwitch.test.ts`)

## 1. 변경 범위 요약

`drawOccupancyOverlay`/`drawDetectOverlay`(LPD 분기)/`#roi-db` change 핸들러 3곳의 렌더 우선순위·로드 타이밍 수정 + `drawDbOccupancy` 신규 함수. 서버 API·DB 스키마·다른 에이전트 코드는 미변경.

## 2. 파일별 파급

| 파일/영역 | 영향 | 근거 |
|---|---|---|
| `web/app.js` | `drawOccupancyOverlay`(hasLive 게이트 제거) · `drawDbOccupancy`(신규) · `drawDetectOverlay` LPD 분기 순서 전환 · `#roi-db` 핸들러 async화. 순수 렌더/이벤트 로직만 변경, 데이터 모델·상태 스키마(`state.*`) 추가 없음 | `git diff web/app.js` |
| `web/index.html` | `#roi-db` 라벨 `title` 텍스트만 변경(문구 갱신, DOM 구조·id·class 무변경) | `git diff web/index.html` |
| 서버(`src/api/*`, `SqliteStore`) | **무접촉**. `GET /capture/slots` 요청/응답 shape 변경 없음 | 배경 진단에서 서버는 정상 확인, 수정 대상에서 제외 |
| DB(`slot_setup` 테이블) | **무접촉**. 스키마·값 변경 없음 | 읽기 전용 조회 경로만 관여 |
| `@parkagent/types`(공유 패키지) | 무변경. 신규/변경 필드 없음 | 이번 변경은 프런트엔드 렌더 분기뿐, 타입 계약 접촉 없음 |
| ActionAgent / DMAgent | **영향 없음**. SettingAgent 뷰어(`web/`)는 두 에이전트가 참조하지 않는 독립 UI 계층 | REST 계약·공유 타입 모두 무변경이므로 전파 경로 없음 |

## 3. 부수효과 — `renderSlotList()`의 `finalized` 분기 활성화 범위 확대

`renderSlotList()`(`app.js:1085`)는 `state.parkingSlotsByKey`가 채워져 있으면(`finalized = true`, `app.js:1091`) `buildFlatSlotRows`로 좌측 주차면 목록 패널을 전역 인덱스 순 평면 목록(DB 소스)으로 렌더한다. 이 분기는 `#roi-db` 체크와 별개로, `state.parkingSlotsByKey`의 존재 여부만으로 결정된다.

이번 수정으로 `#roi-db` change 핸들러가 소스 미로드 시 `loadParkingSlots()`를 직접 호출하게 됐으므로(§3.4, 최종 문서 참고), **제어·모니터링 탭에서 'DB 보기'를 처음 켜는 순간부터** `state.parkingSlotsByKey`가 채워지고, 이후 어떤 이유로든 `renderSlotList()`가 재호출되면(검출 도착 등) 좌측 목록 패널도 `finalized` 분기(DB 소스 평면 목록)로 전환된다.

- **이전 동작**: 이 분기는 사실상 '정밀 수집' 탭을 한 번이라도 방문해야만 활성화됐다(그 탭의 `setTab` 진입 로직만 `loadParkingSlots()`를 호출했으므로).
- **이후 동작**: 제어·모니터링 탭에서도 `#roi-db` 체크 한 번으로 동일하게 활성화될 수 있다.
- **판단**: 목록 패널의 렌더 함수(`buildFlatSlotRows`) 자체는 무변경이고, 표시되는 데이터도 동일한 DB 소스이므로 회귀가 아니라 '더 이른 시점에 같은 화면이 뜨는' 부수효과로 판단한다. 다만 마스터가 제어·모니터링 탭에서 이 목록 패널이 갑자기 나타나는 것을 예상 밖 동작으로 느낄 가능성은 있어 명시적으로 기록해 둔다. **코드 수정 없이 관찰 사실로만 남긴다.**

## 4. 시각적 트레이드오프 — 'DB 보기' 체크 시 라이브 검출 박스 은닉(의도된 동작)

수정 전에는 'DB 보기'가 라이브 없을 때만 보이는 폴백이라 라이브·DB가 동시에 화면에 보이는 경우는 없었다(어차피 라이브가 있으면 DB는 안 그려졌다). 수정 후에도 동시 표시는 없다 — 단, 방향이 바뀌었다: **`#roi-db` 체크 시에는 라이브 검출 유무와 무관하게 DB가 우선하고 라이브 박스는 그려지지 않는다**(VPD/LPD/점유영역 공통, "소스 전환" 규약). 이는 요구사항대로 의도된 동작이며, 라이브 검출 결과를 확인하려면 'DB 보기'를 꺼야 한다.

## 5. 확인 필요(불확실 항목)

- 없음. 서버·DB·타 에이전트 무접촉은 코드 경로(REST 핸들러·SqliteStore 호출부)와 diff로 직접 확인했고, 이번 변경이 건드린 함수 3개(`drawOccupancyOverlay`/`drawDetectOverlay`/`#roi-db` 핸들러) 전부 `web/app.js` 내부 순수 렌더/이벤트 로직으로 범위가 닫혀 있다.

## 6. 테스트 근거 (documenter 자체 실행 아님 — 검증자 실행 결과 인용)

- 신규 `test/dbViewSourceSwitch.test.ts`: 5케이스 전부 통과.
- 전체 `npx vitest run`: 193 파일 / 2271 테스트 전건 통과(회귀 0).
- 라이브 서버 sharp 합성 육안 확인: LPD/점유영역 DB 오버레이가 실프레임 위 실제 위치에 정확히 안착.
- VPD DB 오버레이는 `vpd_bbox` 전건 `null`이라 미검증 대상 자체가 없음(데이터 부재, 결함 아님) — 최종 문서 §6 참고.

상세 서사·코드 diff·검증 원문은 최종 문서(`docs/20260721_215536_DB보기_소스전환_수정.md`)를 참고.

---

# 영향도 분석(추가) — '점유영역 생성' 버튼(DB lpd → occupy_range 재생성)

작성: 2026-07-21 · documenter
최종 문서: `docs/20260721_221700_점유영역생성_버튼_공통진입점.md`
변경 파일: `src/capture/floorRoi.ts`(신규 export) · `src/calibrate/PlateDiscoveryJob.ts`(리팩토링) · `src/api/captureRoutes.ts`(신규 라우트) · `web/index.html` · `web/app.js` (+ 신규 `test/slotOccupyBuild.test.ts`, `test/viewerPtzSyncCoverage.test.ts` 1행 추가)

## 1. 변경 범위 요약

기존 discovery 인라인 점유영역 계산식을 `buildOccupyRangeFromPlate`(신규 export)로 추출해 `PlateDiscoveryJob`과 신규 라우트 `POST /capture/slots/occupy`가 공유하게 했다. 신규 라우트는 `slot_setup.lpd`가 있는 슬롯만 `occupy_range`를 재생성하는 부분 UPDATE(`upsertSlotLpd`)이며, 새 기하 알고리즘·DB 스키마 변경은 없다.

## 2. 확인 항목별 결론

| 확인 항목 | 결론 | 근거 |
|---|---|---|
| `PlateDiscoveryJob` 리팩토링이 동작 불변인가 | **불변**. `stringify5(buildPlateAnchoredQuad(quadBoundingRect(it.lpdOrig), it.lpdOrig))` → `stringify5(buildOccupyRangeFromPlate(it.lpdOrig))`로 치환했고, `buildOccupyRangeFromPlate`의 구현이 정확히 그 식이므로 계산 결과가 100% 동일한 단순 함수 추출이다. 더 이상 쓰지 않는 `quadBoundingRect` import를 제거했다(고아 import 정리). | `git diff src/calibrate/PlateDiscoveryJob.ts` |
| `upsertSlotLpd`의 `occupyRange` undefined 규약(무접촉)과 정합하는가 | **정합**. `SqliteStore.upsertSlotLpd`는 `occupyRange`가 동봉되지 않은 행만 `lpd_obb`만 쓰는 얕은 분기(wipe 방지)를 타고, 동봉되면 `lpd_obb`+`occupy_range`를 함께 쓰는 분기(`stmtLpdOccupy`)를 탄다(`SqliteStore.ts:297~303`). 신규 라우트는 대상 슬롯마다 `occupyRange`를 **항상 명시적으로 채워** 보내므로 후자 분기를 타며, 이는 "이 라우트의 목적이 바로 occupy_range 생성"이라는 의도와 일치한다. lpd가 없는 슬롯은 애초에 `rows`에 넣지 않아(스킵) 그 슬롯의 행 자체가 `upsertSlotLpd` 호출에 포함되지 않는다 — 무접촉이 코드 구조상 보장된다. | `src/api/captureRoutes.ts` 신규 라우트 본문, `SqliteStore.ts:297~303` |
| Finalizer 경로(차량 bbox 기반 `buildPlateAnchoredQuad`)가 미변경인가 | **미변경**. `git diff`에 `Finalizer.ts`는 나타나지 않는다. `buildPlateAnchoredQuad` 함수 자체(`floorRoi.ts`)도 시그니처·본문 무변경 — `buildOccupyRangeFromPlate`는 그 함수를 호출하는 새 wrapper를 옆에 추가했을 뿐이다. Finalizer가 차량 bbox를 가진 경우 여전히 그 bbox로 `buildPlateAnchoredQuad`를 직접 호출하는 기존 경로를 그대로 쓴다(신규 라우트는 판-only 경로만 제공). | `git diff --stat`에 `Finalizer.ts` 부재, `floorRoi.ts` diff(순수 추가) |
| ActionAgent/DMAgent·DB 스키마에 영향이 있는가 | **없음**. `slot_setup` 테이블 컬럼 추가·변경 없음(기존 `occupy_range` 컬럼에 대한 UPDATE뿐). `@parkagent/types`(공유 계약) 변경 없음 — 이번 변경 전부가 SettingAgent 내부(`src/capture`·`src/calibrate`·`src/api`·`web`)에 닫혀 있다. ActionAgent/DMAgent가 참조하는 REST 계약·공유 타입에 접촉이 없으므로 전파 경로 자체가 없다. | `git diff --stat`(SettingAgent 외부 파일 없음), `SlotLpdRow`(`src/capture/types.ts`)가 이미 `occupyRange?: string \| null` 옵셔널 필드를 갖고 있어 타입 확장도 불필요했음 |

## 3. 회귀 가드 — `viewerPtzSyncCoverage.test.ts`와의 결합

이 테스트는 모든 라우트가 카메라 이동 여부로 분류돼 있음을 강제하는 가드다. 신규 라우트를 등록하지 않으면 이 테스트가 실패해 "분류 누락 라우트"를 자동 검출한다 — 이번에 `/capture/slots/occupy`를 `NO_MOVE`로 등록해 통과시켰다. 이는 향후 라우트 추가에도 적용되는 기존 안전장치이며, 이번 변경이 그 계약을 준수했음을 보여준다.

## 4. 확인 필요(불확실 항목)

- 없음. §2의 네 항목 모두 diff·코드 경로로 직접 대조했고, 이번 변경이 건드린 파일(`floorRoi.ts`/`PlateDiscoveryJob.ts`/`captureRoutes.ts`/`web/*`) 범위가 SettingAgent 내부로 닫혀 있어 외부 전파 경로가 없다.

## 5. 테스트 근거 (검증자 실행 결과 인용)

- 신규 `test/slotOccupyBuild.test.ts`: 8케이스 전부 통과(공통함수 결정성, cam/preset 한정 갱신, lpd 없는 슬롯 보존, 기존 occupy 재생성, 타 프리셋·타 컬럼 불변, 전 프리셋 모드, 400 검증, GET 노출).
- 전체 `npx vitest run`: **194 파일 / 2279 테스트 전건 통과**(회귀 0). `tsc --noEmit` 클린.
- 라이브 검증(실서버 13020): `POST /capture/slots/occupy {cam:1,preset:1}` → `{ok:true,updated:7,skipped:0,failed:0}`. 재생성 결과를 discovery 산출 `occupy_range`와 비교 — 7슬롯 전부 소수점 5자리 마지막 자리에서만 ±0.00001 차이(반올림 경로 차이, 알고리즘 불일치 아님). 두 경로가 사실상 동일 산출임을 실증.
- 라이브 정적자산 확인: `/viewer/`에 `#occupy-build` 버튼, `/viewer/app.js`에 `buildOccupyRange` 노출.

상세 서사·코드 diff·검증 원문은 최종 문서(`docs/20260721_221700_점유영역생성_버튼_공통진입점.md`)를 참고.

---

# 영향도 분석(추가) — 점유영역(occupy_range) 생성식 정본 교체(번호판 기준 사다리꼴)

작성: 2026-07-21 · documenter
최종 문서: `docs/20260721_225200_점유영역_정본교체_사다리꼴.md`
변경 파일: 신규 `src/domain/occupancyRegion.ts` · `src/api/captureRoutes.ts`(생성식 교체, 계약 무변경) · `src/calibrate/PlateDiscoveryJob.ts`(같은 교체) · `src/capture/floorRoi.ts`(직전 추가분 원복 — diff 없음)

## 1. 변경 범위 요약

직전 작업(§ 위 섹션, `221700` 문서)이 만든 `buildOccupyRangeFromPlate`(판 bounding rect를 차량 대리로 써 `buildPlateAnchoredQuad`를 호출 — 결과적으로 번호판 크기의 작은 박스)를 폐기하고, 뷰어 라이브 오버레이가 이미 쓰던 기존 정본(`web/occupancyRegion.js`의 번호판 기준 사다리꼴 알고리즘)을 서버 TS로 옮긴 `src/domain/occupancyRegion.ts`의 `buildOccupyRegionsBySlot`으로 discovery·수동 생성 두 경로 모두 교체했다. REST 계약(`POST /capture/slots/occupy`의 요청/응답 shape)과 DB 스키마는 무변경 — **생성되는 값의 형상만** 바뀐다.

## 2. 파급 항목별 결론

| 항목 | 영향 | 근거 |
|---|---|---|
| discovery 산출 `occupy_range`(DB) | **형상 변경**. 기존에 저장된 값(번호판 크기 박스)은 자동 재계산되지 않는다 — 다음 discovery 실행 또는 "점유영역 생성" 버튼 재클릭 시에만 새 형상(큰 사다리꼴)으로 갱신된다 | `PlateDiscoveryJob.saveSlotLpd`/`captureRoutes.ts` 라우트 둘 다 조건 없이 `buildOccupyRegionsBySlot` 호출로 교체됨 — 과거 행을 스캔해 일괄 보정하는 마이그레이션은 이번 변경에 없음 |
| 뷰어 라이브 오버레이(`web/app.js` `updateLogicOccupancy`, `web/occupancyRegion.js`) | **무변경**. 애초에 이 형상의 정본이었다 | `git diff --stat`에 `web/occupancyRegion.js` 부재, `web/app.js`는 이번 세션 diff에 없음(이전 세션 변경만 존재) |
| Finalizer(차량 VPD bbox 기반 `buildPlateAnchoredQuad` 직접 호출 경로) | **무변경**. 함수 시그니처·본문 그대로, 이번 교체는 "판-only 대리" 경로만 폐기했을 뿐 차량 bbox가 실제로 있는 정상 경로는 건드리지 않음 | `git diff`에 `Finalizer.ts` 부재, `floorRoi.ts`는 직전 추가분을 되돌려 HEAD와 diff 없음(`buildPlateAnchoredQuad` 그대로) |
| `setup_result.json`(최종 저장물)의 `occupy_roi` 값 | **형상이 커진다**(번호판 폭의 3.5~4배 폭, 위 0.90/아래 0.60 비대칭 사다리꼴). 저장 로직 자체는 무변경 — DB의 `occupy_range`를 그대로 실어 내는 경로이므로 DB 값이 바뀌면 다음 최종저장 시 자동으로 반영됨 | §1 확인 필요 — 실제 `setup_result.json` 재생성·비교는 미실행(문서화 단계에서 신규 검증 안 함), 코드 경로상 인과관계만 확인 |
| ActionAgent / DMAgent / DB 스키마 | **무영향**. `slot_setup.occupy_range` 컬럼 추가·타입 변경 없음, `@parkagent/types` 무변경. 이번 변경 전부가 SettingAgent 내부(`src/domain`·`src/api`·`src/calibrate`·`src/capture`)에 닫혀 있어 외부 전파 경로 자체가 없음 | `git diff --stat`(SettingAgent 외부 파일 없음) |
| 구현 2벌(`web/occupancyRegion.js` ↔ `src/domain/occupancyRegion.ts`) 유지보수 규약 | 정적 배포 경계(서버가 브라우저 ESM import 불가)로 알고리즘이 두 벌 존재. **형상 상수(배율 3.5~4.0·`topWidthRatio`·`upRatio`/`downRatio`) 변경 시 양쪽을 함께 고치고 `test/occupancyRegionParity.test.ts`를 반드시 통과시켜야 한다** — 이 테스트가 두 구현의 출력 동일성을 강제하는 유일한 안전장치 | 신규 `test/occupancyRegionParity.test.ts`(10케이스 + 상수 고정 케이스) |

## 3. 확인 필요(불확실 항목)

- `setup_result.json`(및 그 아카이브본)에 이미 기록된 과거 `occupy_roi` 값이 실제로 작은 박스 형상으로 남아있는지, 재생성 없이는 갱신되지 않는다는 사실을 운영자가 인지하고 있는지 — 이번 세션에서 일괄 마이그레이션은 수행하지 않았다.

## 4. 테스트 근거 (documenter 자체 실행)

- `npx vitest run`: **195 파일 / 2289 테스트 전건 통과**(직전 세션 대비 신규 `test/occupancyRegionParity.test.ts` 1파일 10케이스 추가, 회귀 0).
- `npx tsc --noEmit`: 클린.
- 라이브 검증(포트 13020): `POST /capture/slots/occupy {cam:1,preset:1}` → `{ok:true,updated:7,skipped:0,failed:0}`. sharp로 실 프레임(1920×1080) 위에 합성해 육안 확인 — 참조 이미지(`etc/주차면점유영역_02.jpg`)와 동일 형상(번호판 평행·차량 앞면 덮음·주차면 아래선까지)으로 7면 모두 정상.

상세 서사·코드 diff·검증 원문은 최종 문서(`docs/20260721_225200_점유영역_정본교체_사다리꼴.md`)를 참고.

---

# 영향도 분석(추가) — 'result 파일 생성' 버튼(DB slot_setup → 최종 결과물 파일 2벌, 공통 진입점 추출)

작성: 2026-07-21 · documenter
최종 문서: `docs/20260721_230807_result파일생성_버튼_DB기반.md`
변경 파일: `src/store/setupResult.ts`(신규 export) · `src/calibrate/PtzCalibrator.ts`(공통 진입점 위임) · `src/api/captureRoutes.ts`(신규 라우트) · `web/index.html` · `web/app.js` (+ 신규 `test/setupResultRoute.test.ts`, `test/viewerPtzSyncCoverage.test.ts` 1행 추가)

## 1. 변경 범위 요약

`PtzCalibrator.saveSetupSnapshot`이 인라인으로 갖던 "1회 변환 → 이력본/고정본 2벌 best-effort 저장" 로직을 `writeSetupResultFiles`(신규 export, `src/store/setupResult.ts`)로 추출해, 센터라이징 잡 done 경로(`PtzCalibrator`)와 신규 수동 라우트(`POST /capture/setup-result`)가 같은 함수를 호출하게 했다. 새 변환/생성 로직은 없다 — 기존 `buildSetupResult` 변환과 `SaveStore.saveSnapshot` 저장 방식을 그대로 재사용한다.

## 2. 확인 항목별 결론

| 확인 항목 | 결론 | 근거 |
|---|---|---|
| `PtzCalibrator.saveSetupSnapshot` 리팩토링이 동작 불변인가 | **불변**. 기존 2개의 인라인 `try/catch`(이력본 저장, 고정본 저장)를 `writeSetupResultFiles(this.store.getSlotSetup(), this.saveStore)` 한 줄로 축소했을 뿐, 호출 인자(`getSlotSetup()` 결과)·저장 순서(이력본→고정본)·실패 시 로그 흡수 방식이 모두 동일하다. 더 이상 쓰지 않는 `setupSaveName`/`buildSetupResult`/`SETUP_RESULT_NAME` 직접 import를 제거했다(고아 import 정리) | `git diff src/calibrate/PtzCalibrator.ts` |
| 신규 라우트가 잡 done 경로와 산출물이 갈릴 수 있는가 | **갈리지 않는다**. 두 경로 모두 `writeSetupResultFiles(slots, saveStore)`를 호출하고, `slots`는 항상 `store.getSlotSetup()`(DB 정본 현재 값)이다. 변환(`buildSetupResult`)도 함수 내부에서 1회만 수행되므로 이력본·고정본 내용이 항상 동일 — `test/setupResultRoute.test.ts` 1번 케이스가 두 파일 바이트 동일을 직접 단언 | `src/store/setupResult.ts` `writeSetupResultFiles` 본문, 테스트 §6.1-1 |
| `saveStore` 타입을 넓히지 않았는가 | **넓히지 않음**. `writeSetupResultFiles`의 파라미터 타입이 `Pick<SaveStore, 'saveSnapshot'>` — 기존 `PtzCalibrator`가 필드에서 이미 좁혀 쓰던 타입 그대로다. `captureRoutes.ts`는 `SaveStore` 전체 인스턴스를 그대로 넘기므로(구조적 타이핑) 호출부 수정 없이 정합 | `src/store/setupResult.ts:70`, `src/api/captureRoutes.ts` 신규 라우트 |
| `saveStore` 미주입 서버에 영향이 있는가 | **라우트 자체가 존재하지 않는다**. 신규 라우트는 기존 `if (deps.saveStore) { ... }` 블록 안에 등록되므로, 정밀수집 저장 기능이 비활성인 구성에서는 등록되지 않는다 — 이 경우 버튼 클릭은 404가 되고 UI가 실패 메시지를 그대로 표시한다(위장 없음, 기존 save 블록 라우트들과 동일한 조건부 등록 규약을 따랐을 뿐) | `git diff src/api/captureRoutes.ts`(신규 라우트가 `if (deps.saveStore)` 블록 내부에 위치) |
| `save/` 디렉터리 파일 수 증가 | **이력본이 클릭마다 누적**된다. 고정본(`setup_result.json`)은 항상 1개로 덮어쓰기지만, 이력본(`Setup_YYYYMMDD_HHMMSS.json`)은 버튼을 누를 때마다 새 파일이 생긴다 — 기존에도 센터라이징 완료마다 쌓이던 것과 동일한 증가 패턴이 수동 트리거로도 발생할 뿐, 새로운 파일 종류나 무한정 증가 위험은 아니다 | `writeSetupResultFiles`가 `setupSaveName(now)`(초 단위 타임스탬프)를 매 호출 새 이름으로 사용 |
| 고정본을 읽는 소비측(외부 도구·다음 파이프라인 단계)에 영향이 있는가 | **의도된 즉시 최신화**. 버튼 사용 시 `setup_result.json`이 DB 현재 값으로 즉시 덮어써지므로, 이 파일을 고정 경로로 읽는 소비측은 클릭 시점부터 새 값을 본다. 파일 스키마(`SetupResult`/`SetupResultSlot`)는 무변경이므로 스키마 파급은 없음 | `src/store/setupResult.ts`의 `SetupResult`/`SetupResultSlot` 인터페이스 diff 없음(신규 export만 추가) |
| DB 스키마·ActionAgent/DMAgent·`@parkagent/types`에 영향이 있는가 | **없음**. `slot_setup` 테이블 읽기 전용 조회(`getSlotSetup()`)만 관여하고 쓰기는 없다. `@parkagent/types`(공유 계약) 변경 없음. 이번 변경 전부가 SettingAgent 내부(`src/store`·`src/calibrate`·`src/api`·`web`)에 닫혀 있어 ActionAgent/DMAgent로의 전파 경로 자체가 없음 | `git diff --stat`(SettingAgent 외부 파일 없음) |

## 3. 회귀 가드 — `viewerPtzSyncCoverage.test.ts`와의 결합

이 테스트는 모든 라우트가 카메라 이동 여부로 분류돼 있음을 강제하는 가드다. 신규 라우트를 등록하지 않으면 이 테스트가 실패해 "분류 누락 라우트"를 자동 검출한다 — 이번에 `/capture/setup-result`를 `NO_MOVE`(파일 IO)로 등록해 통과시켰다.

## 4. 확인 필요(불확실 항목)

- 없음. §2의 모든 항목을 diff·코드 경로로 직접 대조했고, 이번 변경이 건드린 파일(`setupResult.ts`/`PtzCalibrator.ts`/`captureRoutes.ts`/`web/*`) 범위가 SettingAgent 내부로 닫혀 있어 외부 전파 경로가 없다.

## 5. 테스트 근거 (검증자 실행 결과 인용)

- 신규 `test/setupResultRoute.test.ts`: 6케이스 전부 통과(2벌 생성·내용 동일, DB 정본 반영(미센터라이징 null), 고정본 덮어쓰기/이력본 누적, 빈 DB 시 파일 생성, 한쪽 저장 실패 시 나머지 기록+null 보고, 뷰어 결선).
- 전체 `npx vitest run`: **196 파일 / 2295 테스트 전건 통과**(회귀 0). `tsc --noEmit` 클린.
- 라이브 검증(실서버 13020): `POST /capture/setup-result` → `{"ok":true,"slots":17,"archive":"Setup_20260721_230646","fixed":"setup_result"}`. `save/`에 두 파일 생성 확인, `setup_result.json` 17슬롯·`occupy_roi` 결측 0건. `/viewer/`에 `#cal-result-file` 노출 확인. slot1의 `centering: null`은 해당 슬롯 미센터라이징 상태를 DB 그대로 반영한 것(결함 아님).

상세 서사·코드 diff·검증 원문은 최종 문서(`docs/20260721_230807_result파일생성_버튼_DB기반.md`)를 참고.
