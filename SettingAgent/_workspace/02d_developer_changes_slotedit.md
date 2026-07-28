# 02d 구현 변경 내역 — W4(슬롯편집 서버 정본화: 포팅 + 라우트·RPC + 웹 껍데기화)

작성: 2026-07-28 · 워크트리 `.claude/worktrees/feat-server-promote-4/SettingAgent`
입력: `_workspace/00_leader_decisions.md`(**우선 — Q3·Q4 가 설계서 §4 를 덮어쓴다**) ·
`_workspace/01_architect_plan.md` §0(특히 §0-9·§9.2)·§4·§5 단계 10·11·12·§5.2(S1·S2·S4)·§6(R10·R11·R12) ·
`_workspace/02_developer_changes.md`(W1: `mutFetch`·`READONLY_POST_PATHS`) ·
`02b_..._tour.md`(W2: PTZ 동기화 책임 인계·T4) · `02c_..._occupancy.md`(W3 인계 4항목)

범위: **W4 만**. W1·W2·W3 산출물의 로직은 한 줄도 수정하지 않았다(`controlGate.ts` 도 무편집 — W3 인계가 "건드리지 말 것"으로 명시).

---

## 1. 변경 파일 목록

### 신규(3)

| 파일 | 내용 |
|---|---|
| `src/setup/artifactSlotEdit.ts` | `web/core.js` 4함수(`rebuildGlobalIndex`·`removeSlot`·`nextSlotId`·`insertSlotAt`) **자구 포팅**(순수·I/O 0) |
| `test/artifactSlotEditParity.test.ts` | S1 — web↔src `toEqual` 깊은 비교 **19테스트** |
| `test/mappingSlotRoutes.test.ts` | S2+S4 — 라우트·RPC·md5 봉인 **21테스트** |

### 수정(4)

| 파일 | 무엇을 | 왜 |
|---|---|---|
| `src/api/server.ts` | zod 스키마 2 + 기본 rect 상수 1 + `slotEditMeta`/`baseArtifact`/`slotAddHandler`/`slotDeleteHandler` + 헤드리스 라우트 2 + **뷰어 컨텍스트 라우트 2** + import 2줄 | 단계 11 |
| `src/rpc/methods.ts` | `setup.slot.add`·`setup.slot.delete`(둘 다 `http` 위임, **handler 0줄**) | 카탈로그 74 → **76** |
| `web/app.js` | `addSlot`/`deleteSelectedSlot` 를 `async` + 서버 호출(`mutFetch`, `dryRun:true`)로 교체, 고아 import 3개 제거 | 단계 12 |
| `test/viewerPtzSyncCoverage.test.ts` | `NO_MOVE` 에 `/mapping/slot/add`·`/mapping/slot/delete` 2줄(근거 주석 포함) | 이 테스트는 **새 라우트에 분류를 강제**하도록 설계돼 있다(§0-9). 음성 대조로 실제 작동을 실증했다(§3.5) |

### 의도적 무변경(확인함)

`web/core.js` 4함수(**파리티 기준변 — 삭제 금지**) · `web/core.d.ts` · `test/slotInsertEdit.test.ts`(기준변 테스트, **무수정 green**) ·
`test/rpcParity.test.ts`(`known` 목록 **무편집** — `'/mapping'` 접두어로 통과. T4 동적 검사도 무편집 통과) ·
`src/api/controlGate.ts`(**무편집** — 변이 라우트라 deny-by-default 로 자동 보호. W3 인계 지시) ·
`src/api/artifactSchema.ts`·`src/setup/GlobalIndexer.ts`·`src/store/Repository.ts`(재사용만) ·
`src/capture/SqliteStore.ts`(**DB 쓰기 API 호출 0건** — `getSlotSetup()` 읽기만) ·
`src/index.ts`(주입 변경 없음 — 이 라우트는 기존 `deps.repo`/`deps.sqlite` 만 쓴다) · `src/mcp/server.ts`(카탈로그 프록시) ·
`test/roiDbLoad.test.ts`·`test/placeRoiRuntimeInvariants.test.ts`(사전 실패 2건, 무접촉) · 루트의 정체불명 `x.json`(W1~W3 그대로 미접촉).

---

## 2. 핵심 구현 노트

### 2.1 단계 10 — `src/setup/artifactSlotEdit.ts`(자구 포팅)

기준변은 `web/core.js`. 정렬키·`placed` 중복차단·안전망(`coveredSlotIds` 에 없는 슬롯은 `camIdx/presetIdx=0` 으로 뒤에)·
`nextSlotId` 의 **max+1 후 집합 bump**(결번 대응)·`insertSlotAt` 의 **명시적 splice**(rebuild 재사용 금지)·
`[1, N+1]` clamp·중복 slotId **no-op(원본 참조 반환)** 까지 1:1. 창의적 개선 0줄.

타입만 바꿨다: `ArtifactLike`(전 필드 옵셔널) → `SetupArtifact`. `?? []` 방어는 **웹 자구 그대로 남겼다** —
런타임 입력은 호출자 버퍼(외부 JSON)라 타입이 보장하지 못한다.

### 2.2 단계 11 — 라우트·RPC

**경로**: `POST /mapping/slot/add` · `POST /mapping/slot/delete`(리더 지시문 표기 채택. 설계서 §4.2 의 `/mapping/slot` 보다
add/delete 대칭이 명확하고, `known` 판정은 `'/mapping'` 접두어라 어느 쪽이든 무편집 통과다).

**리더 결정 Q3 구현**:
- 본문에 옵셔널 `artifact`(호출자 버퍼) + 옵셔널 `dryRun`(기본 `false`).
- `artifact` 미제공 → `deps.repo.loadArtifact()`. **`resolveMapping()` 을 쓰지 않는다** — DB 폴백 결과를 저장하면 DB 를 파일로 승격시켜 버린다.
- `dryRun:false`(기본) → 검증 후 저장(외부 RPC 는 한 방에 커밋). `dryRun:true` → **`saveArtifact` 미도달**.
- 두 경로 모두 **같은 `artifactSlotEdit` 순수함수**를 쓴다 → 정본은 하나.

**처리 순서(R11)**: zod → 편집 → **`validateArtifactBody`** → (dryRun 아니면) `saveArtifact`.
검증 실패는 `saveArtifact` 에 도달하지 못한다 = 파일 무변경. md5 로 증명했다(§3.4).

**오류코드**

| 상황 | HTTP | RPC | 파일 |
|---|---|---|---|
| zod 실패 | 400 `invalid body` | `-32602` | 무변경 ✔실측 |
| 편집 결과가 스키마/coverage 위반 | 400 `invalid artifact`/`coverage mismatch` | `-32602` | 무변경 ✔실측 |
| artifact 없음(파일·버퍼 둘 다) | 404 `no setup artifact` | `-32002 NOT_FOUND` | 무변경 ✔실측 |
| 삭제 대상 slotId 부재 | 409 `slotId 없음: X — 파일 무변경` | `-32005 CONFLICT` | 무변경 ✔실측 |
| RPC `confirm` 누락(delete) | — (라우트 미도달) | `-32602` | 무변경 ✔실측 |
| 라우트 미등록 | — | `-32004 UNAVAILABLE` | — (해당 없음: 이 2라우트는 **무조건 등록**된다) |
| `-32001 BUSY` | — | — | **발생 불가**(잡·카메라 미접촉). 발생 불가능한 시나리오에 에러 처리를 넣지 않았다(CLAUDE.md §2) |

409 문구에 `busy`/`already running` 이 없다는 것이 곧 CONFLICT 판정 근거다(`classify409`, errors.ts:86). 새 문자열 규약을 만들지 않았다.

**R10(renumber 순서 문제)은 코드로 막지 않았다** — 리더 확정대로 `warnings[]` + 카탈로그 `note` 로만 알린다.
`deps.sqlite` 가 있고 `getSlotSetup().length !== artifact.slots.length` 면
`"DB slot_setup(N) 과 artifact(M) 의 슬롯 수가 다르다 — slot.renumber / slot.placement.update 를 호출하면 이 편집은 DB 기준으로 되돌아간다"`.
`sqlite` 미주입이면 `dbSlotCount:null` + 경고 없음.

**`sqlite` 는 `getSlotSetup()` 읽기만** 호출한다(R12). `replaceSlotSetup` 계열 호출 0건 — grep 으로 확인했다.

**RPC 는 로직 0줄** — `http` 위임 2개. `setup.slot.delete` 만 `requireConfirm` + `omit(['confirm'])`(기존 파괴 메서드 관용구).
`requireFields` 는 **쓰지 않았다** — `camIdx`/`slotId` 는 URL 조립에 필요 없고 라우트 zod 가 소유하며(§0-1 "스키마를 두 벌 쓰지 않는다"),
넣으면 `rpcParity` 의 정적/동적 검사가 `m.http(dummy)` 에서 throw 해 **두 테스트를 동시에 깨뜨린다**(dummy 에 `camIdx`·`slotId` 가 없다). §4-2.

**리더 결정 Q4**(이름 오해 방지)는 **3곳**에 명시했다: RPC `note` 2개 · `artifactSlotEdit.ts` 파일 머리 주석 · `slotAddHandler` doc 주석.

### 2.3 단계 12 — 웹 껍데기화

`addSlot`/`deleteSelectedSlot` 에서 **편집 계산을 전부 제거**했다. 제거된 것: `presetKey`·`nextSlotId`·rect 리터럴·
`newSlot` 조립·`N` 계산·`Math.min` clamp·`insertSlotAt`·`removeSlot`. 남긴 것: `#map-msg` 가드·`#slot-insert-idx` 읽기·
`markDirty()`·`state.selectedSlotId`·3종 재렌더.

`at` 은 "입력칸이 비었나"만 판단해 값이 없으면 **필드를 아예 보내지 않는다**(서버가 `N+1` 기본값과 clamp 를 소유).
즉 웹에 남은 것은 UI 읽기뿐이고 편집 규칙은 0줄이다.

**2단계 UX 는 그대로**: `dryRun:true` 라 파일은 안 바뀌고, `markDirty()` 가 "편집됨(미저장) — 저장을 눌러 반영"을 띄우며,
영속화는 기존 '저장'(`PUT /mapping`)이 계속 소유한다. 버튼·문구·흐름 무변경.

- 새 변이 fetch 는 **`mutFetch`**(W1 규약) → `webTokenWiring` 무회귀(8 passed).
- **웹이 실제로 부르는 경로는 `/viewer/api/mapping/slot/*`**(`api()` 가 `/viewer/api` 를 붙인다) → 뷰어 캡슐에도
  **같은 closure 핸들러**를 등록했다(`renumber`/`placement` 와 동일 관용구). 이걸 빠뜨렸으면 웹 버튼이 404 로 죽었을 것이다 —
  테스트로 고정했다(§3.4 마지막 블록).
- `src` → `web` 역import **없음**(파리티 테스트만 web 을 읽는다).

---

## 3. 실행한 명령과 실제 출력

### 3.1 타입

```
$ npx tsc --noEmit
tsc done          ← 출력 0줄(에러 없음)
```
(중간에 1건 실패했고 고쳤다: `artifactSlotEditParity.test.ts` 의 `pair<T>` 가 web/src 반환형을 하나의 T 로 묶어
`SetupArtifact` → `ArtifactLike` 대입 오류 12건. `pair<W,S>` 로 분리해 해소. **숨기지 않고 기록한다.**)

### 3.2 신규 테스트

```
$ npx vitest run test/artifactSlotEditParity test/mappingSlotRoutes
 ✓ test/artifactSlotEditParity.test.ts (19 tests)
 ✓ test/mappingSlotRoutes.test.ts (21 tests)
```

### 3.3 봉인 무회귀(W1·W2·W3 + 기준변)

```
$ npx vitest run test/artifactSlotEditParity test/mappingSlotRoutes test/rpcParity test/controlGate \
    test/webTokenWiring test/tourJob test/tourRoutes test/occupancyJudgeParity test/occupancyRoutes \
    test/viewerPtzSyncCoverage test/slotInsertEdit
 ✓ test/viewerPtzSyncCoverage.test.ts (13 tests)
 ✓ test/slotInsertEdit.test.ts (23 tests)
 ✓ test/artifactSlotEditParity.test.ts (19 tests)
 ✓ test/slotInsertEditQa.test.ts (10 tests)
 ✓ test/webTokenWiring.test.ts (8 tests)
 ✓ test/occupancyJudgeParity.test.ts (32 tests)
 ✓ test/tourJob.test.ts (17 tests)
 ✓ test/tourRoutes.test.ts (22 tests)
 ✓ test/controlGate.test.ts (19 tests)
 ✓ test/occupancyRoutes.test.ts (15 tests)
 ✓ test/mappingSlotRoutes.test.ts (21 tests)
 ✓ test/rpcParity.test.ts (14 tests)
 Test Files  12 passed (12)
      Tests  213 passed (213)
```
`rpcParity` 는 **`known` 목록 무편집**으로 통과했다(설계 예측 그대로). T4 동적 등록검사도 통과 —
`/mapping/slot/*` 은 `deps` 조건 없이 무조건 등록되기 때문이다.

### 3.4 전체

```
$ npx vitest run
 FAIL  test/placeRoiRuntimeInvariants.test.ts
 FAIL  test/roiDbLoad.test.ts > … > preset_slotidx 는 프리셋별 1-based 연속 …
 Test Files  2 failed | 272 passed (274)
      Tests  2 failed | 3436 passed (3438)
   Duration  18.72s
```
실패 2건 = **사전 실패 그대로**(무접촉). 통과 수 3396 → **3436**(+40 = 19+21). **회귀 0.**

### 3.5 완료기준 4 — 카탈로그 개수

임시 테스트로 실제 `buildServer` 인스턴스에 `GET /rpc/catalog` 를 inject 해 확인하고 **삭제**했다.
```
CATALOG COUNT = 76 | count field = 76
```
74 → **76** ✔ (slot 2개).

---

## 4. ★ 음성 대조 실증(§9.2 규약) — "green 이 곧 봉인 작동"이 아니다

봉인마다 **실제로 실패하는 입력을 한 번 보여주고 원복**했다. 실행 출력 그대로:

| # | 봉인 | 넣은 변이 | 결과 |
|---|---|---|---|
| A | `artifactSlotEditParity` | `nextSlotId` 의 `max + 1` → `slots.length + 1`(결번 회피 로직 제거) | **FAIL 2건** — `해당 프리셋 슬롯 0개 → s1`, `연속 슬롯 → 최대+1` |
| B | `artifactSlotEditParity` | `insertSlotAt` 의 clamp `Math.max(1, at)` → `Math.max(0, at)` | **FAIL 1건** — `at=0(0·N+1·999 clamp 포함)` |
| C | `artifactSlotEditParity` | `removeSlot` 이 `rebuildGlobalIndex(slots, artifact.presets)` (필터 안 된 옛 presets 사용) | **검출 못 함** |
| D | `mappingSlotRoutes`(md5) | `if (dryRun !== true) deps.repo.saveArtifact(...)` → 무조건 저장 (2곳) | **FAIL 2건** — `dryRun:true → … 파일 md5 불변`, `delete 도 dryRun:true 면 파일 md5 불변` |
| E | `mappingSlotRoutes`(409 가드) | delete 의 사전 존재 확인을 `if (false && …)` 로 무력화 | **FAIL 3건** — 409 md5 불변 / RPC CONFLICT / 뷰어 컨텍스트 |
| F | `viewerPtzSyncCoverage` | `NO_MOVE` 에서 `/mapping/slot/add` 1줄 삭제 | **FAIL 1건** — `미분류 라우트 발견 — /mapping/slot/add` |

**C 를 정직하게 기록한다.** 이유까지 확인했다: `rebuildGlobalIndex` 는 `slotSet`(=필터된 slots)에 있는 id 만 채택하므로,
삭제된 slotId 가 옛 `coveredSlotIds` 에 남아 있어도 `slotSet.has(id)` 가 false 라 결과가 같다. 즉 **의미상 등가 변이**이며
파리티가 놓친 것이 아니다. 반환되는 `presets` 필드는 여전히 필터본이라 `toEqual` 도 갈리지 않는다.
(A·B 가 검출됐으므로 이 파리티가 공허한 green 이 아님은 실증됐다.)

F 는 **W2 가 고친 `[Ff]etch\(` 정규식이 실제로 `mutFetch(` 를 수집한다**는 재확인이기도 하다 —
수집이 안 됐다면 표에서 지워도 통과했을 것이다.

---

## 5. 설계와 달라진 점 / 근거

| # | 설계서(§4) | 실제 구현 | 근거 |
|---|---|---|---|
| 1 | `POST /mapping/slot` · `/mapping/slot/delete`, 즉시 반영 1단계 | `POST /mapping/slot/add` · `/mapping/slot/delete`, `artifact`+`dryRun` | **리더 결정 Q3 가 설계서를 덮어쓴다**. 경로명은 리더 지시문 표기 채택(대칭·명시) |
| 2 | (언급 없음) | **뷰어 컨텍스트 라우트 2개 추가**(`/viewer/api/mapping/slot/*`) | 웹의 `api()` 가 `/viewer/api` 를 붙인다 — 헤드리스 라우트만 만들면 웹 버튼이 404 다. `renumber`/`placement` 와 동일하게 **같은 closure** 를 공유해 이중구현이 아니다 |
| 3 | RPC 에 `requireFields(['camIdx','presetIdx'])`·`requireFields(['slotId'])` | **넣지 않음** | `rpcParity` 의 정적·동적 검사가 `m.http(dummy)` 를 부르는데 dummy 에 그 키가 없어 **throw → 테스트 2개 동시 실패**. 그리고 이 필드는 URL 조립에 필요 없다(§0-1: 파라미터 검증은 위임 대상이 소유) |
| 4 | 응답 `{ok,slotId,globalIdx,slots,globalCount,warnings,dbSlotCount}` | + `artifact`(편집본) + `saved`(bool) | `dryRun:true` 의 존재 이유가 "계산 결과를 돌려받는 것"이다. 조건부로 넣으면 shape 이 둘이 되므로 **항상 포함**했다 |
| 5 | delete 본문 `{ slotId, confirm:true }` | 라우트는 `confirm` 을 받지 않는다 | `confirm` 은 **RPC 단계 게이트**라는 기존 규약(`slot.reset`·`slot.roi.load` 전례)을 따랐다. `omit(['confirm'])` 으로 라우트에 새지 않게 했다 |
| 6 | `at` 을 웹이 clamp | 웹은 "비었나"만 보고 서버가 기본값·clamp | 껍데기화 취지. 웹에 남은 편집 규칙 0줄 |

---

## 6. 검증하지 못한 항목(정직 보고)

1. **라이브 브라우저 확인 미수행.** 13021 서버를 띄워 실제로 "추가 → Ctrl+드래그 배치 → 저장", "삭제" UX 를 눌러보지 못했다.
   대체 검증: ①web↔src 파리티 ②라우트 200/404/409/400 실측 ③**뷰어 컨텍스트 경로 등록 확인**(웹이 부르는 바로 그 URL)
   ④`markDirty`/`state.selectedSlotId`/3종 재렌더 호출 보존 ⑤app.js 구문검사(`node --check` OK).
   **"화면이 같은가"는 라이브에서만 최종 확정**된다(검증자 인계 1순위).
2. **R10 의 실제 소실 시나리오를 재현하지 않았다.** "add 후 `/mapping/renumber` 를 부르면 추가분이 사라진다"는 코드 독해로 확인했고
   경고 문구로 알리지만, 실제로 add→renumber→artifact 확인까지 돌려보지는 않았다. **의도적으로 막지 않는 동작**이라 테스트로 고정하면
   오히려 "그게 사양"이라고 못 박는 셈이라 넣지 않았다 — 판단 근거를 남긴다.
3. **`-32001 BUSY`·`-32004 UNAVAILABLE` 은 실측하지 않았다.** 이 2라우트에서는 **발생할 수 없다**(잡·카메라 미접촉, 무조건 등록).
   "미구현"이 아니라 **"해당 없음"**이다.
4. **동시 요청(경합) 미검증.** 두 클라이언트가 동시에 `dryRun:false` 로 add 하면 read-modify-write 경합으로 하나가 덮일 수 있다.
   기존 `PUT /mapping`·`place.save` 와 **동일한 기존 특성**이며 이번 변경이 악화시키지 않는다 — 새 잠금 장치를 발명하지 않았다.
5. **파리티 변이 4건 중 1건(C) 검출 실패** — §4 에 이유와 함께 기록. 의미상 등가 변이다.
6. 루트의 정체불명 `x.json`(untracked)은 W1~W3 그대로 **건드리지 않았다**.

---

## 7. 다음 단계(마감·문서화) 인계

- 카탈로그 **76** 달성(70 → 토큰 0 + tour 3 + occupancy 1 + slot 2). MCP `setting_rpc_catalog` 는 그대로 노출되므로 **MCP 파일 수정 0**.
- **문서화가 반드시 다뤄야 할 이름 문제**: `setup.slot.add` 는 *artifact 슬롯 엔트리 편집*이지 주차면 추가가 아니다.
  실제 주차면 추가는 `place.space.add` + `slot.roi.sync`. 코드 3곳에 명시했으나 **한글 문서에도 굵게 남길 것**(리더 결정 Q4).
- **알려진 한계 2건**(은닉 금지): ①`plate.detect` 는 `mutating:false` 인데 카메라를 물리 이동시킨다(리더 Q1(a) 현행 유지, 별건)
  ②artifact 슬롯편집은 `slot.renumber`/`slot.placement.update` 로 되돌아간다(R10 — 코드로 막지 않음).
- 사전 실패 2건(`roiDbLoad`·`placeRoiRuntimeInvariants`)은 W1~W4 내내 **무접촉·상태 변화 없음**.
- ActionAgent/DMAgent 가 읽는 `data/setup_artifact.json` 의 **스키마는 불변**. 다만 이 기능이 **슬롯 수를 바꿀 수 있다** — 문서에 명시할 것.

---

# 8. QA 결함 수정 — D-1(중간) · D-6(경미) (리더 지시, 2026-07-28 추가)

## 8.1 D-1 — `artifact` 버퍼가 파일 전체를 대체하던 문제

**QA 가 찾은 것(정확한 지적이다)**: 디스크 파일에 슬롯 2개(`c1p1s1`·`c1p1s2`)가 있는 상태에서
슬롯 1개짜리 `artifact` 버퍼로 `dryRun` 없이(=커밋) 호출하면, 파일이 3슬롯이 아니라 **2슬롯**이 되고
`c1p1s2` 가 **조용히 소실**됐다. `createdAt:'TAMPERED'` 같은 임의 필드도 디스크에 그대로 안착했다.
이름은 "슬롯 1개 추가"인데 실제 사정거리는 **파일 전체 교체**였고, 그 사실이 어디에도 없었다.

내 W4 보고서가 R12 를 "파괴 경로 미진입"으로 적었는데 그건 **DB 에만 참이고 파일에는 거짓**이었다.
`slotAddHandler` 가 `baseArtifact(caller) → saveArtifact` 를 무조건 통과시켰기 때문이다. 지적을 그대로 수용한다.

**수정(리더가 지정한 방식)**: `artifact` 를 주면서 `dryRun !== true` 면 **거부**한다.

| 항목 | 값 |
|---|---|
| 신규 함수 | `rejectBufferCommit(caller, dryRun, reply)` — `src/api/server.ts` |
| 위치 | zod 통과 **직후**, `baseArtifact()`·편집·저장 **이전** → 구조적으로 파일 무변경 |
| HTTP | **409**(`busy`/`already running` 단어 미포함) → RPC **`-32005 CONFLICT`** |
| 메시지 | `artifact(호출자 버퍼)는 계산 전용이다 — dryRun:true 와 함께만 쓸 수 있다. 파일에 커밋하려면 artifact 를 빼고 호출하라(서버가 디스크 정본을 읽는다). 파일 무변경` |
| 적용 범위 | `slotAddHandler`·`slotDeleteHandler` **양쪽**(리더 지시대로 delete 도 동일 규약) |
| 뷰어 컨텍스트 | `/viewer/api/mapping/slot/*` 는 **같은 closure** 를 공유하므로 자동 적용 — 추측하지 않고 **테스트로 확인**했다(§8.3) |

**허용 조합 2가지는 그대로 산다(기능 손실 0)** — 이것도 테스트로 고정했다:
1. `artifact` + `dryRun:true` = 계산 전용(**웹 경로**) → 200, 파일 무변경
2. `artifact` 없음 + 커밋 = 디스크 정본 편집(**외부 RPC 경로**) → 200, 파일 변경

**웹 무영향 확인**: `web/app.js` 의 두 호출은 이미 `dryRun: true` 를 보낸다(`:1500`·`:1528` — grep 으로 실측).
가드에 걸릴 수 있는 웹 경로는 **0개**다.

**부수 수정 1건(정직 기록)**: 기존 테스트 `버퍼가 깨진 artifact → … 400` 이 `dryRun` 없이 버퍼를 보내고 있어
새 가드에 먼저 걸렸다(409). `dryRun: true` 를 추가해 **원래 검증하려던 것**(편집 후 `validateArtifactBody` 가
저장 전에 400 을 낸다)을 그대로 유지했다. 단정값은 바꾸지 않았다.

## 8.2 D-6 — `addSlot` 경고 문구 누적

`web/app.js:addSlot` 이 `msg.textContent = \`${msg.textContent} — …\`` 로 **직전 문구를 읽어 이어붙였다**.
→ 읽지 않고 **대체**하도록 1줄 수정: `msg.textContent = \`편집됨(미저장) — ${data.warnings.join(' / ')}\``.
누적 가능성이 구조적으로 사라졌고(직전 값을 참조하지 않는다) "미저장" 신호는 유지된다.

## 8.3 카탈로그 `note`

`setup.slot.add`·`setup.slot.delete` 양쪽에 1줄씩 추가:
`⚠ artifact(호출자 버퍼)는 **계산 전용**이다 — dryRun:true 없이 주면 409(CONFLICT)로 거부된다(버퍼 커밋은 파일 전체 교체가 되므로).`
`src/api/server.ts` 스키마 주석에도 같은 사실을 명시했다(정의처와 카탈로그가 갈리지 않게).

## 8.4 회귀 테스트 — QA 재현 케이스를 그대로 편입

`test/mappingSlotRoutes.test.ts` 에 `describe('D-1 회귀 — artifact 버퍼는 커밋할 수 없다')` **6테스트** 신설(21 → **27**):

1. **QA 재현 그대로**: 파일 2슬롯 + 1슬롯 버퍼 커밋 → **409** · **파일 md5 불변** · `c1p1s2` **생존** · `createdAt` 이 `'DISK'`(버퍼의 `'TAMPERED'` 미안착)
2. `delete` 도 같은 규약으로 거부 + md5 불변
3. RPC 에서 **CONFLICT(-32005)**(BUSY 아님 — 재시도 대상이 아니라 호출 방식이 틀린 것) + md5 불변
4. `dryRun:false` 를 **명시**해도 거부(기본값 회피 우회 차단)
5. 허용 조합 2가지 정상 동작(기능 손실 0 증명)
6. **뷰어 컨텍스트 라우트**(`/viewer/api/mapping/slot/add`·`delete`)에도 가드 적용

## 8.5 ★ 음성 대조 실증(§9.2)

가드 조건을 `if (true) return null;`(항상 통과 = 가드 무력화)로 바꿔 실행:

```
$ npx vitest run test/mappingSlotRoutes      # 가드 무력화 상태
 FAIL  … > D-1 회귀 … > add: 파일 2슬롯 + 1슬롯 버퍼 커밋 → 409 · 파일 md5 불변 · c1p1s2 생존
 FAIL  … > D-1 회귀 … > delete 도 같은 규약으로 거부된다
 FAIL  … > D-1 회귀 … > RPC 에서도 CONFLICT(-32005) — BUSY 가 아니다…
 FAIL  … > D-1 회귀 … > dryRun:false 를 **명시**해도 거부된다(기본값 회피 우회 차단)
 FAIL  … > D-1 회귀 … > 뷰어 컨텍스트 라우트에도 같은 가드가 적용된다(같은 closure 공유)
      Tests  5 failed | 22 passed (27)
```
**5건 전부 검출**(허용 조합 테스트는 가드가 없어도 통과하는 것이 정상 — 그래서 5/6 이다).
원복 후 `27 passed` 확인. 이 봉인은 공허한 green 이 아니다.

## 8.6 수정 후 실행 결과(실제 출력)

```
$ npx tsc --noEmit
TSC OK                      ← 출력 0줄

$ npx vitest run test/mappingSlotRoutes
      Tests  27 passed (27)

$ npx vitest run
 FAIL  test/placeRoiRuntimeInvariants.test.ts > … > 모든 주차면: 4점 + 유한 좌표
 FAIL  test/roiDbLoad.test.ts > … > preset_slotidx 는 프리셋별 1-based 연속 …
 Test Files  2 failed | 272 passed (274)
      Tests  2 failed | 3452 passed (3454)
   Duration  17.53s

CATALOG COUNT = 76 | count field = 76
```
기준선 **3436 → 3452**(+16 = D-1 회귀 6 + …). 실패 2건은 **사전 실패 그대로**. **회귀 0.**

> ※ **+16 의 출처를 끝까지 확인했다**(추측으로 남기지 않는다). 내 변경분은 **+6** 뿐이고
> (`mappingSlotRoutes` 21 → **27**), 나머지 **+10** 은 내가 3436 을 측정한 23:08 이후 **검증자가 추가한 봉인 강화 테스트**다.
> 파일 타임스탬프(23:32~23:40)와 실측 개수로 대조했다:
>
> | 파일 | 내 W4 보고 시점 | 현재 | 차 |
> |---|---|---|---|
> | `mappingSlotRoutes` | 21 | **27** | +6 (**내 변경**) |
> | `artifactSlotEditParity` | 19 | **21** | +2 (검증자가 `describe('… 봉인 강화(음성 대조로 발견한 구멍)')` 추가) |
> | `occupancyJudgeParity` | 32 | **35** | +3 (검증자) |
> | `tourJob` | 17 | **20** | +3 (검증자) |
> | `touringPlanParity` | (미기록) | 19 | 검증자 증분 포함 |
>
> 검증자가 내 파리티 테스트에 덧붙인 케이스(다중 카메라 정렬 우선순위·`roiByPreset` 키 2개일 때 첫 키 귀속)는
> **내 §4 음성 대조가 "C 를 못 잡았다"고 기록한 바로 그 구멍을 메운 것**이다. 내 원본 19케이스는 그대로 살아 있고
> 전부 green 이다. 겹치지 않으므로 되돌리거나 통합하지 않았다.

## 8.7 손대지 않은 것(지시 준수)

- **D-3**(`/capture/autocorrect` 무인증 카메라 이동) — 문서 처리 확정, 코드 변경 0.
- **D-4**(config 의 `LIVETEST`/port 13021) — 리더 라이브 검증 흔적. **건드리지 않았다**(`git status` 상 `SettingAgent/config/tools.config.json` 은 내 변경 대상이 아니다).
- W1·W2·W3 산출물 · 사전 실패 2건 · `x.json` — 전부 무접촉.

## 8.8 이 수정으로도 남는 한계(정직 보고)

1. **라이브 브라우저 확인은 여전히 미수행.** 웹이 `dryRun:true` 를 보낸다는 것은 소스 grep 으로 확인했으나,
   실제 브라우저에서 추가/삭제 버튼을 눌러 409 가 안 나는지는 확인하지 못했다.
2. **동시 커밋 경합**은 이번에도 다루지 않았다(기존 `PUT /mapping`·`place.save` 와 동일 특성).
   다만 D-1 가드로 "커밋 경로는 항상 디스크를 읽어 편집한다"가 보장되어 **read-modify-write 창이 최소화**됐다 —
   가드 이전에는 오래된 버퍼를 통째로 쓸 수 있었으므로, 이 수정은 경합 위험도 함께 줄인다.
