# 04 영향도 분석 — L3 후속: 지면격자 미리보기 UX · `PtzCamRoi_auto.json` 분리 · promote · `slot_setup` 전량 재구성

작성: 2026-07-28 02:10 / 문서화(documenter)
최종 문서: `SettingAgent/docs/20260728_021006_L3후속_자동ROI분리_승인적용.md`

---

## 1. 변경/신규 파일과 파급

| 파일 | 구분 | 파급 |
|---|---|---|
| `src/capture/placeRoiPaths.ts` | 신규(순수, IO 0) | `groundGridRoutes.ts`의 `apply`에서만 사용. 다른 모듈 영향 0 |
| `src/ground/autoRoiPlan.ts` | 가산(`assertAutoPromoteSafe`, G1~G5) | `groundGridRoutes.ts`의 `apply` S2에서만 호출. DB 접근 0, 다른 모듈 영향 0 |
| `src/api/groundGridRoutes.ts` | 수정(`apply`만, `bootstrap` 무변경) | `PtzCamRoi.json`(정본)을 갱신하는 **유일한 신규 쓰기 경로**. 정본을 읽는 13개 지점(§3) 전부가 승인 결과를 자동으로 보게 됨 |
| `web/app.js` | 가산 +256/−1 | 브라우저 클라이언트 로직만. 서버 계약 변경 없음. 미검증 렌더 면적 확대(§4) |
| `web/index.html`, `web/app.css` | 가산 | UI 표시만. `web/core.js`(뷰어 파리티) 무변경 |
| `test/groundGridPanelUi.test.ts`, `test/placeRoiPaths.test.ts`, `test/groundGridPromote.test.ts` | 신규 45테스트 | 기존 테스트 스위트에 추가만, 기존 테스트 영향 0 |
| `test/slotCuboidRoutes.test.ts` | 수정 5/2줄 | `loadRoiToDb→runLoadRoiToDb` 추출의 직접 결과. 기존 봉인 유지 + 위임 봉인 1건 순증 |

**정본 파일(`PtzCamRoi.json`) 스키마는 변경되지 않는다** — promote 직전 `_auto` 키를 명시적으로 제거하므로, 이 파일을 읽는 13개 지점(§3)에 어떤 코드 변경도 요구되지 않는다.

---

## 2. 보호 파일 무변경 — `git diff --numstat` 직접 재확인 (이번 라운드 vs 직전 라운드 구분)

문서화 담당이 저장소 루트(`ParkAgent`)에서 직접 재실행해 확인:

```
git diff --numstat -- SettingAgent/src/capture/Finalizer.ts SettingAgent/src/capture/SqliteStore.ts \
  SettingAgent/src/capture/roiDbLoad.ts SettingAgent/src/api/captureRoutes.ts \
  SettingAgent/src/capture/placeRoi.ts SettingAgent/src/ground/groundModel.ts \
  SettingAgent/src/ground/project.ts SettingAgent/src/ground/types.ts \
  SettingAgent/src/capture/floorRoi.ts SettingAgent/web/core.js \
  SettingAgent/src/config/toolsConfig.ts SettingAgent/src/index.ts SettingAgent/src/api/server.ts
```

| 파일 | numstat | 판정 |
|---|---|---|
| `Finalizer.ts` | (없음) | ✅ 이번 라운드 0줄 |
| `SqliteStore.ts` | (없음) | ✅ 이번 라운드 0줄 |
| `roiDbLoad.ts` | (없음) | ✅ 이번 라운드 0줄 |
| `captureRoutes.ts` | (없음) | ✅ 이번 라운드 0줄 |
| `placeRoi.ts` | (없음) | ✅ 이번 라운드 0줄(§4의 근본 원인 코드 — 의도적으로 손대지 않음) |
| `groundModel.ts` | (없음) | ✅ 이번 라운드 0줄 |
| `project.ts` | (없음) | ✅ 이번 라운드 0줄 |
| `ground/types.ts` | (없음) | ✅ 이번 라운드 0줄 |
| `floorRoi.ts` | (없음) | ✅ 이번 라운드 0줄 |
| `web/core.js` | (없음) | ✅ 이번 라운드 0줄 |
| `toolsConfig.ts` | `6  1` | ⚠️ **직전 L3 라운드**(`groundGridFile` config 키 배선)의 잔여. 이번 라운드 산출물이 아님 |
| `index.ts` | `1  0` | ⚠️ 위와 동일(직전 라운드 잔여) |
| `server.ts` | `12  0` | ⚠️ 위와 동일(직전 라운드 잔여, `registerGroundGridRoutes` 등록) |

**판정 근거:** 이번 라운드 소스 편집 시각(`placeRoiPaths.ts` 등 07-28 00:45~00:51)이 위 3개 파일의 diff 발생 시점(직전 L3 라운드, 07-27 22:52경 — QA 보고서 mtime 근거)보다 뒤이므로, 3개 파일의 변경은 **직전 라운드 산출물이며 이번 라운드가 만든 것이 아니다.** 이번 라운드는 이 3개 파일도 1줄도 건드리지 않았다.

**신규/수정된 이번 라운드 파일**(참고, 보호 대상 아님):
```
web/app.css       10  1
web/app.js        256 1
web/index.html    32  0
test/slotCuboidRoutes.test.ts   5  2
```
`groundGridRoutes.ts`·`autoRoiPlan.ts`·`placeRoiPaths.ts`는 **git에 한 번도 커밋된 적 없는 untracked 신규 파일**이라 `git diff --numstat`에 나타나지 않는다(비교 대상 커밋이 없음). `git status`상 `??`(untracked)로 확인됨.

---

## 3. `PtzCamRoi.json` 읽기 지점 — 소스 갈라짐 0 (설계자 §3 전수 목록, 이번 라운드 검증 결과 재확인)

| 지점 | 파일:줄 | 산출 | 이번 라운드 코드 변경 |
|---|---|---|---|
| A | `Finalizer.persistSlotSetupFromPlace` | `Finalizer.ts:210,247-301` | `slot_setup` 전량 교체 | 0줄 |
| B | `Finalizer.buildGroundModelMap` | `Finalizer.ts:311` | 지면모델 | 0줄 |
| C | `roiDbLoad.loadRoiIntoDb` ← `POST /capture/slots/load-roi` | `roiDbLoad.ts:228-233` | `slot_setup` 전량 재구성 | 0줄 |
| D | `frontCenterBuild.buildSlotFrontCenters` | `frontCenterBuild.ts:54` | `slot3d_front_center` | 0줄 |
| E | `roiToCameraViews` | `captureRoutes.ts:478` | `camerapos.json` | 0줄 |
| F | `GET /capture/place-roi` | `captureRoutes.ts:670-682` | 웹 오버레이·주차면 목록·gg 기준면 | 0줄 |
| G | `PUT /capture/place-roi` | `captureRoutes.ts:686-702` | 수동 편집 저장 | 0줄(★ §4 소실 결함과 동일 성질이 여전히 남아 있음) |
| H | `loadSetupTargetsFromRoi` | `captureRoutes.ts:263-267` | 수집 순회 프리셋 | 0줄 |
| I | `GET /capture/ground-model` | `captureRoutes.ts:590-610,750-777` | 지면모델 | 0줄 |
| J | `cuboidContext.makeCuboidContextResolver` | `cuboidContext.ts:32-52` | 육면체 문맥 | 0줄 |
| K | `CaptureJob` 모드A 필터 | `CaptureJob.ts:243` | 검출 필터 | 0줄 |
| L | `detectPipeline.loadDetectCfg` | `detectPipeline.ts:178-188` | 검출 설정 | 0줄 |
| M | `migrateToSettingDb.ts`(1회성 CLI) | `migrateToSettingDb.ts:65` | 최초 이관 | 0줄 |

**13곳 전부 `PtzCamRoi.json` 하나를 읽는다. 승인이 이 파일을 갱신하므로 13곳이 자동으로 같은 소스를 본다. 소스 갈라짐 = 0.**

`replaceSlotSetup` 호출자는 실측 **3곳**(`Finalizer.ts:300` · `roiDbLoad.ts:319` · `tools/migrateToSettingDb.ts:96`) — 이번 라운드 증가 **0**(정적 검사로 봉인).

---

## 4. 기존 기능 영향

| 기능 | 영향 |
|---|---|
| **finalize 경로**(`Finalizer.persistSlotSetupFromPlace`) | 코드 변경 0줄. 승인이 정본을 갱신하므로 finalize가 승인분을 그대로 읽는다. 다음 finalize에서 전량 교체돼도 승인분은 이미 정본에 있으므로 소멸하지 않는다 |
| **`PUT /capture/place-roi`(기존 수동 편집 경로)** | 코드 변경 0줄. 단 §5(한계)의 "idx 없는 주차면 소실" 결함은 **이 경로에도 동일하게 존재**한다(이번 범위 밖, G5는 `ground-grid/apply` 경로에만 적용됨) |
| **뷰어 오버레이**(`web/core.js`) | 무변경. 정본 스키마 불변(`_auto` 키는 정본에 들어가지 않음)이므로 뷰어 파리티 계약 유지 |
| **정밀수집**(`/capture/start` 대상 선정, `CaptureJob` 모드A 필터) | 코드 변경 0줄. 승인 후 정본이 갱신되면 다음 수집부터 자동 반영 |
| **`slot_ptz.json`·센터링·`globalIndex` 순서 의존** | `loadRoiIntoDb`(`roiDbLoad.ts`) 코드 변경 0줄. 재구성 후 `slot_id`·`preset_slotidx`가 정본 파일 순회 순서(cam asc → preset asc → 배열순)와 1:1 일치함을 검증자가 실행 확인. 단 재구성은 **검출·점유·센터링 컬럼을 초기화**한다(`replaceSlotSetup`의 DELETE+INSERT 특성 — 기존 알려진 제약, 이번 변경이 새로 만든 것 아님) |
| **`test/captureLoadRoiRoutes.test.ts`(회귀 판정선)** | 수정 0줄, green(11테스트) — 문서화 담당 직접 재확인 |

---

## 5. 테스트

- **신규 테스트**: 45건(`groundGridPanelUi` 17 + `groundGridPromote` 20 + `placeRoiPaths` 8), 전부 green. QA 수정 라운드(G5)에서 +6건 추가(`groundGridPromote` 5 + `groundGridPanelUi` 1) — 최종 신규 기여는 51건.
- **회귀**: 0건. `tsc --noEmit` 0에러, `vitest run` 252파일/3005테스트 전량 통과 — 문서화 담당이 저장소 루트에서 독립 재실행해 확인(§3-1 본문 문서 참조).
- **직전 L3 골든 해시**(`test/groundGrid.test.ts`): 13/13 green, 봉인 대상이 픽스처 파일로 이전된 상태 유지.

---

## 6. 운영 유의

- **서버 재시작 필요 여부**: `groundGridRoutes.ts`·`autoRoiPlan.ts`·`placeRoiPaths.ts`는 서버 프로세스가 로드하는 TypeScript 소스이므로, 배포 시 재빌드·재시작이 필요하다(런타임 핫 리로드 없음, 이 저장소의 일반 배포 방식과 동일).
- **`.bak` 위치·복구 절차**: `data/Place01/PtzCamRoi.<타임스탬프>.bak.json` — 정본과 같은 디렉터리. 복구는 **운영자 수동**: `.bak` 파일을 `PtzCamRoi.json`으로 복사해 덮어쓴 뒤 `ROI 파일 로딩` 버튼(`POST /capture/slots/load-roi`)을 눌러 DB를 동기화한다. 단 이 복구는 `slot_roi`(기하)만 복원하며, 검출·점유·센터링은 복원되지 않는다(재수집·재센터링 필요).
- **`_auto.json`의 의미**: `data/Place01/PtzCamRoi_auto.json` — **감사 기록**. 승인 후에도 삭제되지 않고 `history[]`에 누적된다. 이 파일을 직접 편집하거나 정본으로 승격시키는 자동 경로는 없다(전부 명시적 승인 트리거로만 정본이 갱신됨).
- **`.bak` 누적**: 승인할 때마다 새 `.bak` 파일이 쌓인다. 자동 정리 정책 없음 — 필요 시 수동 정리(범위 밖으로 확정됨).
- **워킹트리 상태**: 이 기능(`groundGridRoutes.ts`·`autoRoiPlan.ts`·`placeRoiPaths.ts` 포함)은 **아직 git에 커밋되지 않았다**(`git status`상 untracked/modified). `data/Place01/PtzCamRoi.json`도 검증 과정과 무관하게 이미 워킹트리에서 수정 상태(직전 라운드의 `stringify5` 재직렬화 흔적) — 커밋 시 포함 여부는 리더 판단 필요.

---

## 7. 후속 권고 (우선순위)

1. **[최상위] 브라우저 육안 확인** — 6라운드 연속 미검증. `web/app.js`(+256/−1)의 실제 동작(버튼 회색/활성 전환, `.gg-warn` 가시성, `confirm()` 대화상자, 승인 후 화면 갱신)을 라이브 13020에서 sharp 스샷으로 확인해야 한다. 이번 라운드까지 미검증 면적이 가장 크게 누적됐다.
2. **idx 없는 주차면 소실의 근본 원인 처리** — G5는 `ground-grid/apply` 경로만 막는다. 동일 결함이 `PUT /capture/place-roi`에는 여전히 있다. `normalizePtzCamRoi`/`applyPlaceRoiUpdate`를 고치거나(보호 파일이라 신중한 별도 설계 필요), 최소한 그 경로에도 사전 경고를 추가하는 후속 검토 필요.
3. **라이브 13020 승인 종단 실시** — 검증자는 운영 정본 보호를 위해 의도적으로 회피했다. `_auto.json` 생성·`.bak` 생성·정본 갱신·`GET /capture/slots` 행 수/좌표 일치를 리더가 직접 확인해야 한다.
4. **`data/Place01/PtzCamRoi.json` 워킹트리 오염 처리** — 직전 라운드의 `stringify5` 재직렬화 흔적. 커밋 포함/되돌림 여부 결정 필요.
5. **`renderSlotList` else 분기 도달 조건 규명** — `state.mapping`이 채워지는 실제 경로가 3라운드 연속 미확인. 도달한다면 §1-2(구멍 B) 관련 동작 변경의 실제 영향 범위를 재확인해야 한다.
6. **동시 승인 경합(read-modify-write) 검토** — 기존 `PUT /capture/place-roi`와 동일 성질로 면적은 늘지 않았으나 근본적으로 미방어. 다중 클라이언트 운영 시 우선순위 상향 검토.
