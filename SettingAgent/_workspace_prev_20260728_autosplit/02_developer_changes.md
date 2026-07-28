# 02 구현 변경 — L3 후속: 미리보기 UX · `PtzCamRoi_auto.json` 분리 · promote · slot_setup 전량 재구성

작성: 2026-07-28 / 구현자(developer)
입력: `_workspace/01_architect_plan.md`(개정 1) + `_workspace/00_leader_context.md` + 리더 확정 결정
검증: `npx tsc --noEmit` **0 에러** · `npx vitest run` **252 파일 / 2999 테스트 전량 통과**

---

## 0. 요약

승인 1회가 `_auto 기록 → .bak 백업 → 정본 갱신 → DB 전량 재구성` 을 수행한다.
쓰기 순서를 `_auto → .bak → 정본` 으로 고정해 **앞 단계가 실패하면 정본이 손상되지 않는다**.
리더가 철회한 소스 선택 스위치(`roi_source.json` · `resolvePlaceRoiSource` · `/capture/roi-source`)는 **만들지 않았다**.

---

## 1. 파일별 변경

| 파일 | 구분 | 내용 |
|---|---|---|
| `src/capture/placeRoiPaths.ts` | **신규 51줄** | 파생 경로 순수 함수 3개 |
| `src/ground/autoRoiPlan.ts` | **가산 ~55줄** | `assertAutoPromoteSafe` + `sortedGlobalIdx`(내부) + `AutoPromoteGate` 타입 |
| `src/api/groundGridRoutes.ts` | **수정** | apply 에 S2 게이트·S3·S4·S5·S5.5 try 분리 · `refSpaceIdx` 스키마 1필드 · 응답 `autoFile`/`backupFile`. **bootstrap 무변경** |
| `web/app.js` | **가산 +250 / 삭제 1** | `setGgGate` · preview 게이트 · `renderSlotList` 1줄 · `runLoadRoiToDb()` 추출 · `ggApply` confirm·연쇄·메시지 |
| `web/index.html` | **가산** | `gg-preview disabled` · `gg-apply` 툴팁 3단계+파괴경고 · 패널 안내문 3단계 |
| `web/app.css` | **가산 6줄** | `.gg-warn` 셀렉터 1개(기존 `.map-msg` 규칙 본문 무변경) |
| `test/groundGridPanelUi.test.ts` | **신규** | T1~T8b + 승인 정직성 봉인 + `replaceSlotSetup` 정적 검사 (17 테스트) |
| `test/placeRoiPaths.test.ts` | **신규** | 경로 파생 (8 테스트) |
| `test/groundGridPromote.test.ts` | **신규** | `_auto`·백업·promote·롤백 매트릭스·게이트 (20 테스트) |
| `test/slotCuboidRoutes.test.ts` | **수정 5/2줄** | ★ 계획서에 없던 수정 — §4 사유 참조 |

### 무변경 확인 (`git diff --numstat` 실측)

`Finalizer.ts` · `SqliteStore.ts` · `roiDbLoad.ts` · `captureRoutes.ts` · `toolsConfig.ts` · `index.ts` · `server.ts` ·
`placeRoi.ts` · `groundModel.ts` · `project.ts` · `ground/types.ts` · `floorRoi.ts` · `web/core.js` — **이번 라운드에서 1줄도 건드리지 않았다.**
`test/captureLoadRoiRoutes.test.ts` **수정 0줄 green**(회귀 판정선 통과).
**신규 config 키 0** — `_auto`/`.bak` 경로는 전부 `store.placeRoiFile` 에서 파생.

> ⚠ `git status` 상 `src/api/server.ts` · `src/index.ts` · `src/config/toolsConfig.ts` · `test/viewerPtzSyncCoverage.test.ts` 가
> **modified** 로 보이지만 이는 **직전 L3 라운드의 미커밋 잔여**(`groundGridFile` config 키 배선)다. diff 내용을 직접 확인했다 —
> 이번 라운드의 변경은 0줄이다.

---

## 2. 신규 타입/함수 시그니처

```ts
// src/capture/placeRoiPaths.ts  (순수 · IO 0 · 구분자 원본 보존, node:path 미사용)
export function fileNameOf(file: string): string;
export function autoPlaceRoiPathOf(manualFile: string): string;
//   'data/Place01/PtzCamRoi.json' → 'data/Place01/PtzCamRoi_auto.json'
//   'D:\\data\\PtzCamRoi.json'    → 'D:\\data\\PtzCamRoi_auto.json'   (구분자 보존)
//   'data/PtzCamRoi'             → 'data/PtzCamRoi_auto'             (확장자 없음)
export function backupPlaceRoiPathOf(manualFile: string, iso: string): string;
//   ('data/Place01/PtzCamRoi.json', '2026-07-28T10:15:30.123Z')
//     → 'data/Place01/PtzCamRoi.20260728T101530Z.bak.json'   (밀리초 버림 · 영숫자만)

// src/ground/autoRoiPlan.ts  (순수 · DB 접근 0)
export interface AutoPromoteGate {
  ok: boolean;
  error?: string;
  detail?: { nextSlots: number; currentSlots: number; missingIdx: number[] };
}
export function assertAutoPromoteSafe(nextJson: unknown, currentJson: unknown): AutoPromoteGate;
```

`sortedGlobalIdx()`(내부)가 `Map` 순회 결과를 **정렬된 number[] 로 즉시 환원**하므로 프리셋 선언 순서가 판정에 영향을 주지 않는다(테스트로 봉인).

---

## 3. 서버 apply 흐름 (`groundGridRoutes.ts`)

```
S1 planAutoRoi + 기존 R-4/R-5 게이트            (기존, 무변경)
S2 assertAutoPromoteSafe(next, current)        → 실패 시 409 { ok:false, error, detail, issues }
S3 PtzCamRoi_auto.json 기록                     → 실패 시 500 '자동 파일 쓰기 실패 — 정본 무변경'
S4 PtzCamRoi.<ts>.bak.json 백업 (currentText 원문 그대로)
                                               → 실패 시 500 '백업 실패 — 정본 무변경'
S5 PtzCamRoi.json 갱신 (stringify5(nextRoot,2)) → 실패 시 .bak 읽어 자동 복원 시도 + 500
S5.5 ground_grid.json (try 분리)               → 실패는 issues 로 강등, ok:true 유지
응답 { ok, applied, appended, autoFile, backupFile, issues }
```

구현 세부:

- **`.bak` 은 재직렬화하지 않는다.** apply 진입 시 읽은 **원문 문자열(`currentText`)** 을 그대로 쓴다 → 승인 직전 정본과 **바이트 완전 동일**(테스트로 봉인).
- **정본에 `_auto` 를 넣지 않는다.** promote 직전 `const nextRoot = {...placeRoiJson}; delete nextRoot._auto;` 로 명시적으로 보장하고, `_auto.json` 은 `{ _auto: meta, ...nextRoot }` 로 조립한다.
- `_auto.history[]` 는 기존 `_auto.json` 을 읽어 누적한다. **파싱 실패 시 history 만 포기**하고 issues 1건 남긴 뒤 **승인은 계속**한다(ENOENT 는 정상 부재이므로 issue 도 남기지 않는다).
- `refSpaceIdx` 는 계산에 쓰이지 않는 **추적성 전용 옵셔널 필드**다. 웹이 `state.selectedPlaceIdx` 를 보낸다. 미지정이면 `null` 로 기록한다.
- `groundGridRoutes.ts` 에 store/DB import 는 **여전히 0건**(테스트로 봉인).

---

## 4. 계획서와 달라진 점 (전부 사유 포함)

| # | 계획 | 실제 | 사유 |
|---|---|---|---|
| D1 | `replaceSlotSetup` 호출자 **2곳**(`roiDbLoad.ts:319`/`Finalizer.ts:300`) | 실측 **3곳** — `src/tools/migrateToSettingDb.ts:96` 추가 | **기존** 코드다(설계 §3 M 항목의 1회성 CLI 이관 도구). 이번 변경이 늘린 것은 0곳. 정적 검사는 실측 3곳으로 봉인했다 |
| D2 | 게이트 **G4**(대상 0건) 를 독립 거부로 테스트 | **도달 불가** — `normalizePtzCamRoi` 가 빈 `parking_spaces` 프리셋을 `byPreset` 에 등재하지 않아 **G1 이 먼저 잡는다** | 게이트 코드는 설계대로 남기되, 테스트는 "G1 이 잡는다"는 **실측 사실**로 봉인했다. 거짓 green 을 만들지 않았다 |
| D3 | 라우트 레벨에서 G1~G4 각각 409 검증 | **라우트 경로로는 도달 불가** — §5 참조 | 순수함수 유닛테스트 7건으로 대체. 도달 불가 사실을 아래 §5 에 명시 |
| D4 | `test/slotCuboidRoutes.test.ts` 무변경 | **수정 5/2줄** | `loadRoiToDb` 본문을 `runLoadRoiToDb` 로 추출한 직접 결과. 봉인 의도(가드 해제가 ROI 로딩 경로에 있다)는 **그대로 유지**하고 대상 함수명만 옮겼으며, `loadRoiToDb → runLoadRoiToDb` 위임까지 추가로 봉인했다. 회귀 판정선(`captureLoadRoiRoutes.test.ts`)은 무수정 green |
| D5 | S3/S4 실패 시 `fileErrorReply` | 명시적 500 `reply.code(500)` | `fileErrorReply` 는 ENOENT 를 404 로 매핑한다. 쓰기 실패는 계획서 롤백표대로 **전부 500** 이어야 하므로 헬퍼를 쓰지 않았다 |
| D6 | S5 복원을 "메모리 원문"으로 | **`.bak` 파일을 읽어** 복원 | 백업 파일이 실제로 읽히는지까지 검증되는 경로를 택했다(계획서 문구 그대로) |

---

## 5. ★ 미완 · 미검증 항목 (숨기지 않는다)

1. **브라우저 실렌더 미검증 — 4라운드 연속.** `web/app.js`(+250줄)·`index.html`·`app.css` 를 건드렸으나 실제 브라우저에서 렌더·클릭을 확인하지 않았다. 정적 텍스트 봉인(17테스트)만 있다. 리더 Loop 5(라이브 13020 + sharp 스샷) **필요**.
2. **`renderSlotList` else 분기 도달 조건은 여전히 미확인.** `state.mapping` 이 채워지는 경로를 추적하지 않았다. 계획대로 도달 여부와 무관하게 1줄 방어만 넣었다. 도달한다면 `place-sel-info` 텍스트와 `place-delete.disabled` 가 **기존에 갱신 안 되던 것이 갱신되는** 동작 변경이 발생한다(두 값 모두 `state.selectedPlaceIdx` 하나로 결정되므로 잘못된 상태가 될 수는 없다).
3. **S2 게이트 G1~G4 는 현재 apply 라우트 경로로 도달 불가능하다.** `buildApplySpaces` 가 `fileSpaces.map(...)` 로 기존 idx·순서를 보존하고 `allowNew` 는 append 만 하므로, next 는 **항상 current 의 상위집합**이다. 즉 G1~G4 는 **미래 방어선(defense in depth)** 이며 이번 라운드에서 라우트 레벨 409 를 실제로 관측한 적이 **없다**. 순수함수 유닛테스트 7건으로만 검증했다.
4. **S5(정본 갱신) 실패 주입 테스트 없음.** S3·S4 실패는 경로에 디렉터리를 만들어 EISDIR 로 주입해 검증했으나(각 1건), S5 는 정본 경로 자체를 못 쓰게 만들면 setup 자체가 불가능해 주입하지 않았다. **자동 복원 경로는 미검증 코드**다.
5. **다중 클라이언트 동시 승인(read-modify-write 경합) 미방어.** 기존 `PUT /capture/place-roi` 와 동일 성질이며 면적을 늘리지 않았다. 잠금 미도입.
6. **`.bak` 누적 정리 정책 없음.** 승인할 때마다 `data/Place01/` 에 파일이 쌓인다. 수동 정리. 이번 범위 밖.
7. **배포 스크립트·백업 도구 영향 미확인.** `data/Place01/` 에 `_auto.json`·`.bak.json` 이 새로 생긴다. 그 디렉터리를 훑는 애플리케이션 코드는 없으나(경로를 직접 받는다), 외부 스크립트는 확인하지 않았다.
8. **실측 수치는 전부 Unity 픽스처 기준.** `test/fixtures/groundGrid.PtzCamRoi.json` 로만 검증했다. 실카 재조정은 별건.

---

## 6. 실측한 수치 (원문)

```
npx tsc --noEmit          → 출력 없음(0 에러)
npx vitest run            → Test Files 252 passed (252) / Tests 2999 passed (2999) / Duration 15.31s
git diff --numstat web/app.js  → 250  1   (삭제 1줄 = 추출된 runLoadRoiToDb 의 `return;` → `return false;`)
git diff --numstat web/app.css → 10   1
git diff --numstat web/index.html → 32  0
```

신규 테스트: `groundGridPanelUi` 17 · `groundGridPromote` 20 · `placeRoiPaths` 8 = **45건 추가, 전부 green**.
기존 `groundGridRoutes.test.ts` 10건 **무수정 green**(직전 L3 골든 해시 포함 회귀 0).

---

## 7. 검증자·문서화 인계 메모

- **되돌리기의 정확한 성질**(문서에 반드시 유지): `.bak` 복원 → `ROI 파일 로딩` 은 **`slot_roi` 만** 복구한다. 검출(VPD/LPD)·점유영역·센터라이징은 `replaceSlotSetup` 의 DELETE+INSERT 로 **복구되지 않는다**. 이 문장은 `ggApply()` 의 `confirm()` 본문과 `#gg-apply` 툴팁에 **UI 문자열로 들어가 있다**(테스트 `T: confirm 본문에 …` 로 봉인). 문서에만 적힌 것이 아니다.
- **S6 실패의 성질**: 파일은 앞서고 DB 는 직전 정상값을 유지하는 **안전 실패 모드**다. `#gg-msg` 가 `'ROI 파일 로딩' 으로 재시도하세요(현재 DB 는 이전 상태 유지)` 를 표시한다.
- 검증자가 재현할 실패 주입 2건: `_auto.json` 경로에 디렉터리 생성(S3), `vi.setSystemTime` 고정 후 `.bak` 경로에 디렉터리 생성(S4). 둘 다 `groundGridPromote.test.ts` 에 있다.

---

# QA 수정 라운드 — 결함 QA-F(중) 대응: 게이트 **G5** 추가

작성: 2026-07-28 / 입력: `_workspace/03_qa_report.md` §4 결함 1 + 리더 방침(권고 1 채택)
검증: `npx tsc --noEmit` **0 에러** · `npx vitest run` **252 파일 / 3005 테스트 전량 통과**(직전 2999 → **+6**)

## Q1. 무엇이 문제였나 (검증자 재현 그대로)

```
승인 전 8면 → 승인 후 7면 (정본에서 소실)
```
`idx` 없는 주차면 → `normalizePtzCamRoi` 탈락 → `applyPlaceRoiUpdate` 가 `parking_spaces` 통째 교체 → raw 파일에서 삭제.
`assertAutoPromoteSafe` 는 **정규화된 idx 집합만** 비교하므로 그 면은 `current` 집합에도 없어 `missingIdx` 에 안 잡히고 **`ok:true` 로 통과**했다.

## Q2. 구현 — `G5` (raw `parking_spaces` 개수 비교)

`src/ground/autoRoiPlan.ts` 가산 ~45줄. **기존 G1~G4 와 같은 계층**(순수 · IO 0 · DB 접근 0 · 거부 시 `_auto.json` 도 안 씀).

```ts
/** 정규화 **이전** raw parking_spaces 개수를 `${cam_id}:${preset_idx}` 별로 센다. */
function rawSpaceCounts(json: unknown): Map<string, number>;   // 내부

export interface AutoPromoteGate {
  ok: boolean;
  error?: string;
  detail?: {
    nextSlots: number; currentSlots: number; missingIdx: number[];
    droppedRaw?: Array<{ key: string; from: number; to: number }>;   // ★ 신규(G5 전용)
  };
}
```

- **정규화를 쓰지 않는 것이 핵심이다.** `normalizePtzCamRoi` 는 `idx` 누락 / `points` 비배열 / 이미지 크기 오류 3종을 조용히 탈락시킨다(`placeRoi.ts:59-68` 실독). G5 는 **raw 배열 길이**를 세므로 **3종 전부**를 잡는다(검증자가 보고한 `idx` 누락은 그중 하나).
- `cam_id`/`preset_idx` 가 없는 파일에서도 짝을 잃지 않도록 **배열 위치(`#0`)를 대체 키**로 쓴다(양쪽 파일에 같은 규칙).
- `droppedRaw` 는 `key` 오름차순 정렬 — `Map` 삽입 순서에 의존하지 않는다(결정론).
- 판정 위치는 **G4 다음, `return {ok:true}` 직전**. 기존 G1~G4 의 번호·메시지·순서는 **1줄도 바꾸지 않았다**.

거부 메시지는 **어느 프리셋에서 몇 면이 줄어드는지 + 원인 + 조치**를 담는다(리더 요구):
```
적용 거부(G5): 주차면이 파일에서 사라진다 — cam1 preset1 8면→7면.
원인: idx 누락 · points 누락 · 이미지 크기 오류로 정규화에서 탈락한 주차면은 좌표 교체 시 삭제된다.
해당 주차면에 idx 를 넣어 저장한 뒤 다시 승인하세요 — 정본·DB 무변경
```
`web/app.js` `ggApply()` 는 `detail.droppedRaw` 를 `소실 위험 1:1 8→7면` 형태로 `#gg-msg` 에 노출한다(정적 봉인 1건 추가).

## Q3. ★ 라우트 레벨 거부 실제 관측 — **원문 결과**

임시 관측 테스트를 작성·실행하고 **삭제**했다(`test/zzG5Observe.test.ts`, `x.json` 잔여물도 제거).

```
STATUS=409
BODY={"ok":false,
 "error":"적용 거부(G5): 주차면이 파일에서 사라진다 — cam1 preset1 8면→7면. 원인: idx 누락 · points 누락 · 이미지 크기 오류로 정규화에서 탈락한 주차면은 좌표 교체 시 삭제된다. 해당 주차면에 idx 를 넣어 저장한 뒤 다시 승인하세요 — 정본·DB 무변경",
 "detail":{"nextSlots":23,"currentSlots":23,"missingIdx":[],"droppedRaw":[{"key":"1:1","from":8,"to":7}]},
 "issues":["f 공동추정 표본 1개 — 프리셋 간 교차검증 불가", "부트스트랩 표본 = 주차면 1개 — 프리셋 간 f 교차검증 불가(카메라 상수 정확도는 이 1면에 전적으로 의존)"]}
정본 바이트 동일=true
_auto 생성=false
.bak 목록=[]
```

> **`nextSlots: 23 === currentSlots: 23` 이고 `missingIdx: []` 다.** 즉 **G1~G4 는 이 파괴를 전혀 보지 못하고**, `droppedRaw` 만이 소실을 드러낸다 — 검증자 C-3 판정("일어나지 않는 일을 막고 실제로 일어나는 파괴를 놓친다")의 직접 증거이자, 그것이 해소됐다는 증거다.
>
> **이로써 S2 게이트 계층은 라우트 레벨에서 처음으로 도달 가능해졌다** — 죽은 코드가 아니다.

이 관측은 임시 테스트가 아니라 **영구 테스트로도 봉인**돼 있다(`test/groundGridPromote.test.ts` → `describe('★ S2 게이트 라우트 레벨 도달 — G5 는 죽은 코드가 아니다')`).

## Q4. 추가된 테스트 (+6, 전부 green)

| 파일 | 테스트 | 성격 |
|---|---|---|
| `groundGridPromote.test.ts` | `idx 없는 주차면이 사라지는 promote → 거부 + 어느 프리셋에서 몇 면인지 보고` | 순수. `missingIdx:[]` · `nextSlots===currentSlots` 를 **함께 봉인**해 "G2 가 왜 못 잡는가"를 고정 |
| " | `points 누락으로 탈락하는 주차면도 잡는다` | 순수. 검증자가 보고하지 않은 **두 번째 탈락 조건** |
| " | `개수가 같거나 늘면 통과(정상 좌표 교체 · allowNew append)` | 순수. 오탐 방지 |
| " | **`idx 없는 주차면이 대상 프리셋에 있으면 409 + 정본·_auto·.bak 전부 무변경`** | ★ **라우트 레벨** |
| " | **`탈락분이 대상 아닌 프리셋에 있으면 통과한다(오탐 없음)`** | ★ 라우트 레벨. 승인 대상이 아닌 프리셋은 교체되지 않으므로 거부하면 **안 된다** |
| `groundGridPanelUi.test.ts` | `G5 거부의 소실 프리셋·개수(droppedRaw)가 화면에 드러난다` | 정적 봉인 |

## Q5. 불변 제약 재확인 (실측)

| 제약 | 실측 |
|---|---|
| 무변경 확정 13파일 0줄 | `git diff --numstat` — 13파일 전부 이번 라운드 0줄(`toolsConfig`/`index`/`server` 의 diff 는 직전 L3 잔여, 검증자 §1 R5-a 판정과 동일) |
| `replaceSlotSetup` 호출자 | grep 실측 **3곳 유지**(`Finalizer.ts:300` · `roiDbLoad.ts:319` · `tools/migrateToSettingDb.ts:96`). 증가 0 |
| S5 자동 복원 테스트 | **건드리지 않았다.** `groundGridPromote.test.ts` 의 S3/S4/S5 롤백 테스트 전부 무수정 green |
| 쓰기 순서 `_auto → .bak → 정본 → slot_setup` | 무변경. G5 는 **S3 이전**(S2 계층)에서 판정하므로 거부 시 `_auto` 미생성(관측 확인) |
| 결정론 · 순회 순서 고정 | `droppedRaw` key asc 정렬. `rawSpaceCounts` 는 배열 순회만 하고 `Map` 순서를 판정에 쓰지 않는다 |
| throw 금지 | `rawSpaceCounts` 는 `null`/비객체/`cameras` 비배열/`presets` 비배열/`parking_spaces` 비배열을 전부 빈 값으로 강등. throw 경로 0 |
| 골든 해시·기존 테스트 | `252 파일 / 3005 테스트` 전량 green |

## Q6. 이번 라운드에서 **못 고친 것** (숨기지 않는다)

1. **근본 원인은 그대로다.** `normalizePtzCamRoi` 의 조용한 탈락과 `applyPlaceRoiUpdate` 의 통째 교체는 **1줄도 안 고쳤다**(둘 다 무변경 확정 파일 `placeRoi.ts`). G5 는 **파괴를 막을 뿐 탈락분을 보존하지는 못한다.** 사용자는 여전히 손으로 `idx` 를 채워 넣어야 승인할 수 있다. 같은 소실은 **기존 `PUT /capture/place-roi` 경로에는 여전히 존재**한다(이번 범위 밖).
2. **G1~G4 는 여전히 라우트로 도달 불가**다. G5 만 도달 가능해졌다. G1~G4 를 미래 방어선으로 남긴 판단은 바뀌지 않았다.
3. **브라우저 실렌더 여전히 미검증(6라운드 연속).** 이번에 `web/app.js` 가 +6줄 더 늘었다(`droppedRaw` 표시). `#gg-msg` 에 그 문구가 실제로 어떻게 보이는지 미확인.
4. **관찰 2(`refSpaceIdx` 재번호 어긋남) 미조치.** 감사 정확도만 영향, 기능 영향 0 이라는 검증자 판정을 수용하고 손대지 않았다.
5. **관찰 3(`x.json` 테스트 잔여물) 미조치.** 이번 변경과 무관한 기존 문제이며 범위 밖. 다만 이번 라운드 실행 후 생긴 `x.json` 은 삭제했다.
6. **실카 미검증.** 전 검증이 `test/fixtures/groundGrid.PtzCamRoi.json` 기준이다.

## Q7. 실측 원문

```
npx tsc --noEmit   → 출력 없음(0 에러)
npx vitest run     → Test Files 252 passed (252) / Tests 3005 passed (3005) / Duration 14.51s
git diff --numstat web/app.js → 256  1     (QA 라운드 전 250 1 → +6)
grep -rn "\.replaceSlotSetup(" src/
  src/capture/Finalizer.ts:300 / src/capture/roiDbLoad.ts:319 / src/tools/migrateToSettingDb.ts:96
```
