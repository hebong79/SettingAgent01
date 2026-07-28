# 04 영향도 분석 — L3: 주차면 1개 드로잉 → 전 프리셋 바닥 ROI 자동 생성

작성: 2026-07-27 / 문서화(documenter) / 최종 문서: `SettingAgent/docs/20260727_235515_L3_주차면1개_바닥ROI_자동생성.md`

---

## 1. 변경/신규 파일 목록과 파급

### 신규 (7코드 + 1픽스처 + 5테스트, 문서 2건 별도)

| 파일 | 파급 범위 |
|---|---|
| `src/ground/groundFrame.ts` | 신규 모듈. import 하는 곳은 `groundGrid.ts`/`groundBootstrap.ts`/`autoRoiPlan.ts` 뿐. 기존 코드가 이 파일을 참조하지 않으므로 **하위 파급 없음**(순수 추가) |
| `src/ground/groundGrid.ts` | 상동. `project.ts`(`dot3/cross3/unit3`, `projectToPixel`)를 재사용하지만 `project.ts` 는 무변경이므로 **역방향 파급 없음** |
| `src/ground/groundBootstrap.ts` | `groundModel.ts` 의 공개 함수(`estimateGroundVPs`, `focalFromVPs`, `buildGroundPlane`, `poolFovBaseV`, `focalFromZoom`, `estimateGroundModels`)를 호출만 함. `groundModel.ts` 무변경이므로 그 함수들의 다른 호출자(`captureRoutes.ts` 등 기존 경로)는 **영향 없음** |
| `src/ground/autoRoiPlan.ts` | 위 3파일 + `types.ts`(`PlaceRoiSpace` 등 타입만 import)를 조합. `types.ts` 무변경 |
| `src/ground/gridStore.ts` | 신규 파일 `ground_grid.json` 하나만 다룸. 기존 `SqliteStore`/DB 스키마(6테이블 정본)와 **완전히 분리** |
| `src/api/groundGridRoutes.ts` | `applyPlaceRoiUpdate`(기존 `captureRoutes.ts` 공유 함수)를 재사용해 `PtzCamRoi.json` 을 갱신 — 이 경로를 타는 순간 **기존 `PUT /capture/place-roi` 와 동일한 하위 파급**이 발생한다(§3-1) |
| `test/fixtures/groundGrid.PtzCamRoi.json` | 동결 픽스처(QA 결함1 수정). 런타임 `data/Place01/PtzCamRoi.json` 과 **독립** — 후자가 바뀌어도 이 테스트들은 깨지지 않음(의도된 설계) |
| `test/groundFrame.test.ts` / `groundGrid.test.ts` / `groundBootstrap.test.ts` / `groundGridRoutes.test.ts` / `groundAutoRoiPlan.test.ts` | 신규 5파일, 격리된 테스트. 기존 테스트 파일과 이름 충돌·공유 상태 없음 |

### 수정 (7 — 전부 가산)

| 파일 | 변경 | 파급 |
|---|---|---|
| `src/config/toolsConfig.ts` | `store.groundGridFile` 키 추가(default 有) | `StoreSchema` 를 참조하는 기존 코드는 optional 필드 추가라 영향 없음. **default 가 없는 상태로 배포되면** `src/index.ts` 의 `join(dataDir, store.groundGridFile)` 이 undefined 참조 위험 — default 값이 있으므로 실질 위험 낮음(§4 운영 유의사항) |
| `src/api/server.ts` | 신규 라우트 3개 등록(3중 게이트: `deps.ground?.enabled && deps.placeRoiFile && deps.groundGridFile`) | 게이트가 없으면 **라우트가 등록되지 않는다** — 기존 배포(설정 미변경)에서는 라우트 부재로 동작, 신규 요청이 없던 것과 동일. 기존 라우트 순서·경로에 충돌 없음(경로가 전부 신규 prefix `/capture/ground-grid`) |
| `src/index.ts` | `groundGridFile` dep 1줄 추가 | 상동 |
| `web/index.html` | `#roi-auto` 토글 + 신규 패널 추가 | DOM 추가만. 기존 요소 id/class 변경 없음(검증자가 확인: 기존 `#roi-floor`/`#roi-db` 무변경) |
| `web/app.js` | `state.autoRoi`, `drawAutoRoi(ctx)`(가산 레이어), 핸들러 5개, 리스너 4개 | `git diff --numstat` = 187 insertions / **0 deletions** — 기존 로직 라인 변경 없음. `drawRoiOverlay` 안에 `drawAutoRoi(ctx);` 1줄 추가가 유일한 기존 함수 개입점이며, 이 함수는 `#roi-auto` 미체크 시 즉시 return(기본 off) |
| `web/app.css` | `.gg-help` 셀렉터 1개 추가 | 기존 규칙 본문 무변경. `test/manualTableMarkup.test.ts` 가 첫 `.an-manual-help` 요소를 다른 용도로 봉인하고 있어 클래스를 분리했다 — 그 테스트의 봉인 대상과 충돌 없음 |
| `test/viewerPtzSyncCoverage.test.ts` | 신규 라우트 2개를 `NO_MOVE` 표에 추가 | 이 테스트는 신규 라우트가 반드시 분류되도록 설계된 강제 지점 — 수정하지 않으면 오히려 이 테스트가 실패한다(정상 사용법) |

### 변경 0줄 (D-2 보호 대상 — 아래 §2 표로 독립 확인)

`groundModel.ts` · `project.ts` · `types.ts` · `capture/floorRoi.ts` · `capture/Finalizer.ts` · `capture/SqliteStore.ts` · `capture/roiDbLoad.ts` · `web/core.js`

---

## 2. D-2 보호 8파일 무변경 — `git diff --numstat` 직접 확인

문서화 단계에서 재실행한 원문(2026-07-27 23:55, 워킹트리 기준):

```
$ git diff --numstat -- \
    src/ground/groundModel.ts src/ground/project.ts src/ground/types.ts \
    src/capture/floorRoi.ts src/capture/Finalizer.ts src/capture/SqliteStore.ts \
    src/capture/roiDbLoad.ts web/core.js
(출력 없음)
```

| 파일 | 결과 |
|---|---|
| `src/ground/groundModel.ts` | NO_CHANGE |
| `src/ground/project.ts` | NO_CHANGE |
| `src/ground/types.ts` | NO_CHANGE |
| `src/capture/floorRoi.ts` | NO_CHANGE |
| `src/capture/Finalizer.ts` | NO_CHANGE |
| `src/capture/SqliteStore.ts` | NO_CHANGE |
| `src/capture/roiDbLoad.ts` | NO_CHANGE |
| `web/core.js` | NO_CHANGE |

**8/8 전부 무변경.** 검증자가 QA 단계에서 확인한 결과와 문서화 단계 재확인 결과가 일치한다. D-2("신규 수학은 groundFrame.ts 1건뿐, 이 8파일은 건드리지 않는다")가 코드 사실로 유지되고 있다.

---

## 3. 기존 기능 영향

### 3-1. finalize / `replaceSlotSetup` 경로

`Finalizer.persistSlotSetupFromPlace` 는 매 finalize 마다 `replaceSlotSetup`(DELETE+INSERT 전량 교체)을 호출하며 소스는 항상 PtzCamRoi.json 이다. 이번 변경은 이 경로에 **신규 코드를 추가하지 않았다** — 자동 격자는 `groundGridRoutes.apply` → `applyPlaceRoiUpdate`(기존 함수, `PUT /capture/place-roi` 와 공유) → PtzCamRoi.json 갱신까지만 하고, 그 다음 DB 반영은 **기존 finalize/load-roi 가 그대로 담당**한다. 따라서:
- 자동 ROI 를 승인·적용한 뒤에도 **다음 finalize 에서 소멸하지 않는다**(파일이 정본이므로).
- `replaceSlotSetup` 의 기존 취약성(센터링 컬럼 리셋, `Finalizer.ts:243-245`)은 이번 변경이 호출자를 늘리지 않았으므로 **노출 면적 증가 없음** — 그러나 그 취약성 자체는 이번 작업으로 해결된 것도 아니다(범위 밖, 기존 이슈 그대로).

### 3-2. `slot_ptz.json` / 센터링 / artifact `globalIndex` 순서 의존

`slot_id` 는 `normalizeGlobalIdx` 순서로 재부여되며, 이 순서가 흔들리면 `slot_ptz.json`·센터링 결과·artifact `globalIndex` 가 통째로 어긋난다. 이번 구현은:
- `buildApplySpaces` 가 IoU 1:1 매칭으로 **기존 파일 순서를 그대로 보존**한다(설계 R-4를 구현 단계에서 "개수 일치"→"IoU 매칭"으로 정밀화 — 단순 개수 비교는 순서 역전 시 조용히 좌표를 뒤바꿀 위험이 있었기 때문).
- 검증자가 `fileSpaces` 를 역순 주입해도 출력 idx 가 입력 순서 그대로 나옴을 실측 확인(§2 R-4 실험, `03_qa_report.md`).
- `allowNew:true` 로 신규 슬롯을 append 하는 경우도 `normalizeGlobalIdx` 가 1..N 순열이 유지되는 한 재번호가 일어나지 않음을 검증자가 실측 확인(전역 idx {1..26}, N=26 순열 유지 → 무변경). 단, 신규 슬롯 번호가 물리적 인접 순서와 어긋나는 운영 혼동 요인은 남아 있음(기능 결함 아님).

### 3-3. 뷰어 오버레이 토글 체계 (`#roi-floor`/`#roi-db`/`#roi-auto`)

- `#roi-floor`(바닥 레이어 마스터 스위치)·`#roi-db`(DB 소스 게이트)는 **현행 유지**, 코드 변경 없음.
- 신규 `#roi-auto` 는 **가산 레이어**로 설계·구현됐다 — 파일 ROI 를 대체하지 않고 겹쳐 그리며, 기본 off. off 상태에서 기존 렌더와 픽셀 단위로 동일해야 한다는 규약(가산 규약)이 있으나, **이 규약의 실측 검증(sharp 스샷 pre/post 대조)은 수행되지 않았다** — 정적 논증(early-return + 0 deletions)만 있다. §6 한계 참조.
- `GET /capture/ground-model`(육면체 렌더의 유일 근거)은 변경하지 않았다 — 자동 모델(`source:'auto'`)은 신규 라우트에서만 반환되므로, 뷰어의 육면체 렌더링은 이번 변경으로 영향받지 않는다.

### 3-4. 정밀수집(capture) 파이프라인

정밀수집 루프(`CaptureJob`, `FloorRoiReviewer` 등)와 이번 변경은 **배선상 접점이 없다**. `viewerPtzSyncCoverage.test.ts` 가 신규 라우트 2개를 `NO_MOVE` 로 분류했다는 것은 이 라우트들이 카메라를 움직이지 않는다는 뜻이며, 정밀수집 진행 중 PTZ 동기화 상태를 교란하지 않는다.

---

## 4. 테스트 영향

- **QA 원 라운드**: `tsc --noEmit` 0 error, `vitest run` **248파일 / 2936테스트 전량 green**(검증자 직접 실행, 회귀 0 확인). 신규 테스트는 격자 12·부트스트랩 8·프레임 5·라우트 9 등(구현자 집계, 일부 중복 제외).
- **QA 수정 라운드 이후**(구현자 재실행): `tsc --noEmit` 0 error, `vitest run` **249파일 / 2954테스트 전량 green**(+1파일/+18테스트 — `test/groundAutoRoiPlan.test.ts` 16테스트 신규 + 기존 3파일에 픽스처 전환·손상 JSON 테스트 추가분). **이 수치는 구현자가 실행한 것이며, 검증자의 독립 재확인은 이 시점 이후 수행되지 않았다.** 문서화 단계에서도 재실행하지 않았다 — 인용임을 명시한다.
- **골든 해시 봉인 결함(QA 결함1) 전후**: 수정 전에는 런타임 정본(`data/Place01/PtzCamRoi.json`, 워킹트리 미커밋 상태)에 봉인되어 있어 HEAD 로 되돌리면 2개 테스트 red(검증자가 직접 재현). 수정 후에는 `test/fixtures/groundGrid.PtzCamRoi.json` 동결 픽스처로 분리되어, 구현자 실행 기준 29/29 green. **검증자가 이 수정 이후 버전을 직접 재확인한 기록은 없다** — 문서화 단계에서도 재실행하지 않았으므로 "확인 필요" 항목으로 남긴다.
- **기존 테스트 회귀**: 두 라운드 모두 0으로 보고됨(검증자 QA 원 라운드 직접 실행 확인, 수정 라운드는 구현자 보고 인용).

---

## 5. 운영 유의사항

- **서버 재시작 필요 여부**: 필요하다. `store.groundGridFile` 설정 키와 신규 라우트 등록(`server.ts`)은 부팅 시점에 배선되므로, 배포 후 서버 프로세스 재시작이 있어야 신규 라우트(`/capture/ground-grid/*`)가 활성화된다. 설정을 추가하지 않고 배포하면(default 값이 코드에 있으므로) 라우트는 등록되지만 데이터 파일은 없는 상태로 시작 — `GET /capture/ground-grid` 는 404 를 반환한다(정상 동작, 에러 아님).
- **파일 백업**: `apply` 라우트가 `PtzCamRoi.json` 을 갱신하므로(대상 프리셋만, 검증자가 diff 국한 실측 확인), 운영 중 자동 ROI 를 처음 적용하기 전 `data/Place01/PtzCamRoi.json` 을 백업해 둘 것을 권고한다. `ground_grid.json` 은 신규 생성 파일이라 백업 대상이 아니다.
- **되돌리는 법**: `apply` 로 갱신된 `PtzCamRoi.json` 은 일반 파일이므로 git 이력 또는 수동 백업본으로 복원 가능하다. `ground_grid.json` 은 삭제해도 `PtzCamRoi.json`/`slot_setup` 에는 영향이 없다(파생물이 아니라 이력/추적성 파일).
- **골든 해시 테스트 주의**: 결함1 수정으로 픽스처 분리가 됐지만, `data/Place01/PtzCamRoi.json` 을 **의도적으로** 바꾸는 작업(예: 실카 데이터로 교체)을 하더라도 이제는 `test/fixtures/groundGrid.PtzCamRoi.json` 이 별도이므로 그 테스트들은 깨지지 않는다 — 단, 실데이터가 근본적으로 바뀌면 픽스처도 함께 갱신해야 실제 데이터를 반영한 테스트가 된다는 점은 남는다.

---

## 6. 후속 권고 (우선순위 포함)

| 우선순위 | 권고 | 사유 |
|---|---|---|
| 1(높음) | **브라우저 실렌더/sharp 스샷 검증을 별도 세션으로 반드시 수행** | CLAUDE.md 규칙 3(동작 확인) 미완 항목. `#roi-auto` off 픽셀 동일성이 정적 논증에만 의존 중이며, QA 수정 라운드에서 `web/app.js` 를 추가로 건드려 미검증 면적이 늘었다 |
| 2(중간) | **실카 데이터로 D-3 홀드아웃 대조·자기 열 IoU 재실측** | 모든 수치(0.00% 편차, IoU 1.0000)가 Unity 시뮬레이터 기준이며, 파이프라인 수학의 무손실성만 증명한다. roll≠0·PTZ 바이어스·광학중심≠회전축 위험은 실카 데이터 없이는 검증 불가 |
| 3(중간) | **`ON_LATTICE_MAX_M`/`MATCH_MIN_IOU` 를 실카 데이터로 재튜닝** | 현재 값은 Unity 데이터 기준. 너무 빡세면 안전 실패(정상 슬롯 거부), 너무 느슨하면 오매칭(§4 결함) 재발 |
| 4(낮음, 검토 후 결정) | **`allowNew` UI 노출 여부 재검토** | 노출하면 "1면 그려 신규 주차장 생성"이 가능해지나, `rows>1` 과 조합 시 주차통로 위에 가짜 슬롯을 쓸 위험(B-3)이 있다. 노출한다면 `rows=1` 강제 또는 off-lattice 셀 제외를 함께 걸어야 한다 |
| 5(낮음) | **"그 열의 전 프리셋" 이식 실증을 위한 데이터 확보** | 한 열이 두 프리셋에 나뉘어 등록된 테스트 데이터가 있어야 이 명제를 판정할 수 있다. 현재는 "미증명"이며 이 저장소에 판정 가능한 데이터가 없다 |
| 6(낮음) | **`upsertCameraGrids` 격자 이력 누적 정책 검토** | 현재 같은 열이면 갱신, 다른 열이면 추가로 개선됐으나, 이력 자체를 남기지 않고 최신값만 유지한다. 운영상 감사(audit) 필요성이 있으면 이력 누적을 별건으로 검토 |

---

## 7. 확인 필요 (단정하지 않음)

- QA 수정 라운드 이후 vitest 249/2954 수치의 **검증자 독립 재확인 미실시** — 다음 세션에서 재실행 권장.
- 골든 해시 결함1 수정 버전의 **검증자 재확인 미실시**.
- `web/app.js` 의 `#roi-auto` off 픽셀 동일성 — **실측 미실시**(정적 논증만).
