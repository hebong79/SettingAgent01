# 03 검증 보고 — L3 후속: 미리보기 UX · `PtzCamRoi_auto.json` 분리 · promote · slot_setup 재구성

작성: 2026-07-28 / 검증자(qa-tester)
입력: `_workspace/00_leader_context.md` · `01_architect_plan.md`(개정 1) · `02_developer_changes.md` · `_workspace_prev_20260728_L3/03_qa_report.md`
방법: **구현자 보고를 액면 그대로 믿지 않고 전부 독립 재현**했다. 임시 검증 테스트 22건을 직접 작성·실행한 뒤 **삭제**했다(§7 정리 증명).

---

## 0. 총평

| 항목 | 결과 |
|---|---|
| `npx tsc --noEmit` | **0 에러**(출력 없음, exit 0) |
| `npx vitest run` | **252 파일 / 2999 테스트 전량 통과** (Duration 15.00s) — 구현자 보고 수치와 일치 |
| 직전 L3 골든 해시 | **green**(`test/groundGrid.test.ts` 13/13). 봉인 대상이 `test/fixtures/groundGrid.PtzCamRoi.json` 로 옮겨져 **직전 라운드 결함 1(self-invalidating seal) 해소 확인** |
| 구현자 자가신고 4건 | 3건 **사실 확인**, 1건(S5 자동 복원 미검증)은 **검증자가 실패 주입으로 검증 완료 — 정상 작동** |
| 신규 발견 결함 | **1건(심각도 중)** + 관찰 2건(하) |

**핵심 결론:** 쓰기 순서·롤백·백업 계층은 **실패 주입으로 깨뜨려도 설계 §5 롤백표대로 동작**한다.
다만 **S2 게이트(G1~G4)는 실제로 발생하는 유일한 파괴 경로를 못 본다**(결함 1). 게이트가 죽은 코드는 아니지만 방어 대상 선정이 틀렸다.

---

## 1. Requirements 항목별 판정표

| # | Requirement | 판정 | 근거(실행) |
|---|---|---|---|
| R1 | **기존 수동 경로 회귀 0** | ✅ 충족 | `bootstrap` 은 정본 **바이트·mtime·디렉터리 목록 전부 무변경**, 어떤 파일도 생성 안 함(QA-A, 실행 확인). 승인(apply) 전에는 DB 접근 코드 자체가 0(`groundGridRoutes.ts` 에 store import 0건). `test/captureLoadRoiRoutes.test.ts` **수정 0줄 green**(11 테스트) |
| R2 | 파괴 방지: 빈 소스·슬롯 0 → 거부 + DB 무변경 | ⚠️ **부분 충족** | 파일 계층 G1~G4 는 정상 판정(순수 유닛 7건). DB 계층 거부 5종은 **실측 확인**(손상 JSON·빈 cameras 주입 → `ok:false` + `getSlotSetup()` 문자열 동일). **그러나 결함 1의 삭제 경로는 게이트를 통과한다** |
| R3 | 자동 전환 금지 — 전부 명시적 트리거 | ✅ 충족 | `apply` 는 `confirm: z.literal(true)` 강제(`groundGridRoutes.ts:45`). 웹은 그 위에 `#gg-confirm` 체크 + `confirm()` 3단계 문구. `_auto.json`/`.bak` 을 자동으로 읽어 정본에 반영하는 경로 **0건**(기저는 항상 `PtzCamRoi.json`) |
| R4-a | 결정론 | ✅ 충족 | 서로 다른 작업공간 2회 승인 → `cameras` 문자열 동일. **프리셋 선언 순서를 뒤집어도** 정본 `cameras` 동일(QA-E, 실행 확인) |
| R4-b | `round5`/`stringify5` | ✅ 충족 | 정본·`_auto.json` 둘 다 `/-?\d+\.\d{6,}/` **0건**. `_auto` 중첩 메타(`constants`/`grid`)까지 5자리로 접힌다 — 설계 §8 미확인 3번 **해소** |
| R4-c | **throw 금지 → null + issues** | ✅ 충족 | 퇴화 입력 **실제 호출**로 확인(코드 읽기 아님): `assertAutoPromoteSafe`(null/undefined/0/''/[]/{}/NaN/`{cameras:null}` 각 2조합), `planAutoRoi`(쓰레기 JSON 8종·cols=0·NaN quad), `buildApplySpaces`/`nextGlobalIdxOf`, 경로 파생 6종. **throw 0건**. apply 라우트에 손상 JSON 정본 → 500 + 정본 바이트 무변경 |
| R4-d | 순회 순서 고정 | ✅ 충족 | `sortedGlobalIdx` 가 `Map` 순회를 정렬 배열로 환원(`autoRoiPlan.ts:500-505`). 프리셋 선언 순서 역전 시에도 게이트 판정·정본 결과 동일(실행 확인) |
| R5-a | **무변경 확정 13파일** | ✅ 충족(단서 있음) | `git diff --numstat` 독립 확인 — 아래 표 |
| R5-b | `Finalizer.ts`/`SqliteStore.ts` 손대기 전 보고 | ✅ 해당 없음 | 둘 다 0줄 |
| R6 | 직전 L3 테스트 유지 + tsc 0 + vitest 전량 | ✅ 충족 | §0 |
| R7 | 요청 범위 밖 리팩토링 금지 | ✅ 충족 | `loadRoiToDb` → `runLoadRoiToDb` 추출 1건뿐이며 승인 연쇄가 **후처리 순서를 복사하지 않기 위한 필수 추출**(설계 §4-1 명시) |
| R8 | CLAUDE.md 5대 규칙 | ⚠️ 부분 | 설계·유닛테스트·문서화·영향도는 충족. **규칙 3 "실제 동작 확인"은 브라우저 실렌더 기준으로 5라운드 연속 미충족**(§5-1) |

### R5-a 무변경 13파일 — `git diff --numstat` 독립 확인

| 파일 | 추적 | numstat | 판정 |
|---|---|---|---|
| `src/capture/Finalizer.ts` | TRACKED | (없음) | ✅ 0줄 |
| `src/capture/SqliteStore.ts` | TRACKED | (없음) | ✅ 0줄 |
| `src/capture/roiDbLoad.ts` | TRACKED | (없음) | ✅ 0줄 |
| `src/api/captureRoutes.ts` | TRACKED | (없음) | ✅ 0줄 |
| `src/capture/placeRoi.ts` | TRACKED | (없음) | ✅ 0줄 |
| `src/ground/groundModel.ts` | TRACKED | (없음) | ✅ 0줄 |
| `src/ground/project.ts` | TRACKED | (없음) | ✅ 0줄 |
| `src/ground/types.ts` | TRACKED | (없음) | ✅ 0줄 |
| `src/capture/floorRoi.ts` | TRACKED | (없음) | ✅ 0줄 |
| `web/core.js` | TRACKED | (없음) | ✅ 0줄 |
| `src/config/toolsConfig.ts` | TRACKED | `6  1` | ⚠️ **이번 라운드 0줄** — 아래 |
| `src/index.ts` | TRACKED | `1  0` | ⚠️ 동일 |
| `src/api/server.ts` | TRACKED | `12  0` | ⚠️ 동일 |

**뒤 3개에 대한 검증자 판정 — 구현자 주장 사실 확인.**
- mtime: `server.ts` `2026-07-27 22:52:10` · `index.ts` `22:52:15` · `toolsConfig.ts` `22:52:35`
- 이번 라운드 소스 편집 시각: `placeRoiPaths.ts` `2026-07-28 00:45:06` · `autoRoiPlan.ts` `00:45:27` · `groundGridRoutes.ts` `00:46:38` · `app.js` `00:47:58`
- diff 내용도 전부 **직전 L3 라운드의 `groundGridFile` config 키 배선**뿐이다(`registerGroundGridRoutes` 등록 + `StoreSchema.groundGridFile` 기본값). 이번 라운드 산출물과 무관.
→ **"이번 라운드 변경 0줄" 은 참**이다. 단 워킹트리가 HEAD 대비 더러운 상태라는 사실은 기록에 남긴다.

**회귀 판정선:** `test/captureLoadRoiRoutes.test.ts` **numstat 없음(0줄) · 11 테스트 green**. 통과.
(참고: 설계 §4-1 은 이 파일을 "12테스트"라 적었으나 실측 **11테스트**다. 수정 0줄이므로 결함 아님 — 문서 수치 오기.)

---

## 2. ★ (B) 쓰기 순서·롤백을 실제로 깨뜨린 결과

주입 방식: ① 경로에 디렉터리 생성(EISDIR) ② `vi.mock('node:fs/promises')` 로 정본 쓰기만 가로채 **잘린 쓰기 후 ENOSPC**(디스크 가득참 재현) / **EACCES 전면 실패**.
판정은 전부 **`Buffer.compare` 바이트 비교**와 **`getSlotSetup()` 행 스냅샷 문자열 비교**로 했다.

| 단계 | 주입 | 관측 응답 | 정본 | `_auto` | `.bak` | `ground_grid` | DB | 설계 §5 표 |
|---|---|---|---|---|---|---|---|---|
| **S3** | `_auto` 경로 = 디렉터리 | 500 `자동 파일 쓰기 실패 — 정본 무변경` | **바이트 동일** | 미생성 | **미생성** | 미생성 | 무변경 | ✅ 일치 |
| **S4** | `.bak` 후보 경로 4개 = 디렉터리 | 500 `백업 실패 — 정본 무변경` | **바이트 동일** | **존재**(쓰기 순서 증명) | 미생성 | 미생성 | 무변경 | ✅ 일치 |
| **S5** | 잘린 쓰기(120바이트만 쓰고 ENOSPC) | 500 `정본 갱신 실패 — 백업에서 복원됨` + `backupFile` | ★ **손상 후 `.bak` 에서 바이트 단위로 복원됨**(`Buffer.compare===0`, `JSON.parse` 정상, cameras 2대) | 존재 | 존재 | 미생성 | 무변경 | ✅ 일치 |
| **S5(2)** | 정본 쓰기 전면 EACCES(복원도 실패) | 500 `정본 갱신 실패 — 자동 복원도 실패` + `backupFile` 명시 | 무변경(EACCES 성질) | 존재 | 존재·**승인 직전과 바이트 동일** | 미생성 | 무변경 | ✅ 일치 |
| **S5.5** | `ground_grid.json` 경로 = 디렉터리 | **200 `ok:true`** + `issues: ground_grid.json 기록 실패…` | 갱신됨 | 존재 | 존재 | 실패 | (S6 진행) | ✅ 강등 성립 |
| **S6** | 재구성 소스 손상 JSON | `ok:false` `… — DB 무변경` | 앞섬 | — | — | — | ★ **행 스냅샷 문자열 동일** | ✅ 안전 실패 |
| **S6(재시도)** | 정상 파일로 재호출 | `ok:true` | — | — | — | — | **최초 정상 스냅샷과 동일 = 수렴** | ✅ |
| **S6(빈 cameras)** | `{"cameras":[]}` | `ok:false` | — | — | — | — | **행 스냅샷 동일** | ✅ |

### ★ 구현자 미검증 항목 해소 — S5 자동 복원은 **실제로 작동한다**

구현자 §5-4 는 "S5 자동 복원 경로는 미검증 코드"라 신고했다. 검증자가 **정본을 실제로 손상시키는 잘린 쓰기**를 주입해 확인한 결과:

```
POST /capture/ground-grid/apply
→ 500 { ok:false, error:'정본 갱신 실패 — 백업에서 복원됨',
        backupFile:'PtzCamRoi.<ts>.bak.json' }
정본 바이트: Buffer.compare(after, before) === 0     ← 손상분이 완전히 되돌려졌다
정본 JSON.parse: 정상 (cameras 2대)
writeFile 주입 히트: 2 (1=갱신 실패, 2=복원 쓰기 통과)
```

복원 실패 케이스(EACCES 전면)도 `자동 복원도 실패` + `.bak` 경로를 응답에 명시하며, 그 `.bak` 이 승인 직전 정본과 **바이트 동일**함을 확인했다 → 운영자 수동 복구가 실제로 가능하다.

### `.bak` 바이트 동일성 — 독립 확인

구현자는 "원문 문자열(`currentText`) 그대로"라 주장했다. `readFileSync` 문자열 비교가 아니라 **`Buffer.compare(bytes(bak), bytes(before)) === 0`** 으로 재확인했다. **참**이다. 재직렬화 흔적 없음(`groundGridRoutes.ts:236` `writeFile(backupPath, currentText, 'utf8')`).

### promote 정본에 `_auto` 키 부재 — 확인

`readFileSync(placeRoiFile,'utf8')` 에 `_auto` **문자열 자체가 0회**. `nextRoot` 에서 `delete nextRoot._auto`(`:192-193`) 로 명시 보장. ✅

---

## 3. (C) 구현자 자가신고 4건 — 독립 재현·판정

### C-1. `replaceSlotSetup` 호출자 실측 3곳 — **사실 확인 ✅**

저장소 전체 grep 실측(수신자 `.` 가 있는 호출만):
```
src/capture/Finalizer.ts:300      store.replaceSlotSetup(rows)
src/capture/roiDbLoad.ts:319      store.replaceSlotSetup(keep)
src/tools/migrateToSettingDb.ts:96  store.replaceSlotSetup(slots)
```
계획서가 "2곳"이라 적은 것은 **계획서의 누락**이고, 3번째는 설계 §3 M 항목이 이미 인지한 1회성 CLI 이관 도구다.
`src/api/groundGridRoutes.ts` 에 `.replaceSlotSetup(` **0건**, `SqliteStore` import **0건**(`git diff --numstat` + grep 확인).
→ **이번 변경이 늘린 호출자는 정확히 0곳.** 판정: **정직한 신고**. 정적 검사가 3곳으로 봉인돼 있어 회귀도 막힌다.

### C-2. `test/slotCuboidRoutes.test.ts` 5/2줄 수정 — **봉인 유지, 오히려 강화됨 ✅**

diff 원문:
```diff
-  it('loadRoiToDb 에도 동일한 1회 가드 해제가 추가돼 있다', () => {
-    const roiFn = fnSource(appJs, 'async function loadRoiToDb()');
+  it('runLoadRoiToDb 에도 동일한 1회 가드 해제가 추가돼 있다', () => {
+    expect(fnSource(appJs, 'async function loadRoiToDb()')).toContain('runLoadRoiToDb()');
+    const roiFn = fnSource(appJs, 'async function runLoadRoiToDb()');
     expect(roiFn).toContain('state.groundLoaded = false');
     expect(roiFn).toContain('loadGroundModel()');
   });
```
원래 봉인 2개(`state.groundLoaded = false`, `loadGroundModel()`)는 **그대로**이고, 대상 함수명만 추출된 본문으로 옮겼다. 여기에 **`loadRoiToDb → runLoadRoiToDb` 위임 봉인 1줄이 추가**됐다(위임이 끊기면 red).
→ 판정: **약화 아님. 순증**. 계획서에 없던 수정이지만 함수 추출의 직접 결과이며 사유가 §4 D4 에 기록돼 있다. 수용.

### C-3. S2 게이트 G1~G4 가 apply 경로로 도달 불가 — **사실 확인 ✅ (단, 결론은 구현자보다 나쁘다)**

**도달 불가는 참이다.** 코드 근거로 재확인했다:
- `buildApplySpaces`(`autoRoiPlan.ts:477`)가 `fileSpaces.map(...)` 로 **정규화된 기존 슬롯을 전부 보존**하고 idx 를 바꾸지 않는다.
- `allowNew` 는 `nextGlobalIdx` 부터 **append 만** 한다(`:481-485`).
- `applyPlaceRoiUpdate`(`placeRoi.ts:132-148`)는 **대상 (cam,preset) 이외의 카메라·프리셋을 손대지 않는다**.
→ `next` 의 전역 idx 집합은 **항상 `current` 의 상위집합**. G2·G3·G4 는 구조적으로 성립할 수 없고, G1(유효 프리셋 0)도 좌표만 교체하므로 성립 불가.

**실증:** 정상 경로로 `presets:[1]`/`[2]`/`[3]` 3회 승인 → **409 관측 0회**. 구현자 신고와 일치.

**검증자 판정 — 죽은 코드인가 미래 방어인가:**
> **미래 방어선으로서는 정당하다**(순수·IO 0·DB 접근 0·비용 무시 가능, `allowNew` UI 노출 시에도 append 는 상위집합이므로 무해).
> **그러나 방어 대상 선정이 틀렸다.** 게이트는 "idx 집합이 줄어드는" 파괴만 본다. 그런데 **실제로 도달 가능한 파괴 경로는 idx 집합에 나타나지 않는다** → **결함 1**(§4).
> 즉 게이트는 *일어나지 않는 일*을 막고, *일어나는 일*을 놓친다.

**라우트 레벨 실증은 불가능하다.** 게이트를 라우트로 도달시키려면 `buildApplySpaces` 나 `applyPlaceRoiUpdate` 를 바꿔야 하는데, 그것은 검증이 아니라 제품 변경이다. 도달 불가라는 **사실 자체를 봉인**하는 것이 옳고, 구현자가 순수함수 7건으로 대체한 판단은 타당하다(거짓 green 을 만들지 않았다).

### C-4. 브라우저 실렌더 미검증 / S5 자동 복원 미검증

| 항목 | 판정 |
|---|---|
| S5 자동 복원 | ✅ **해소** — 검증자가 실패 주입으로 검증, 정상 작동(§2) |
| 브라우저 실렌더 | ❌ **여전히 미검증**. 이번 라운드에 `web/app.js` +250/−1, `index.html` +32, `app.css` +10/−1 이 들어갔고 검증은 **정적 텍스트 봉인 17건뿐**이다. 검증자도 headless 브라우저를 띄우지 않았다 — **못 했다고 명시한다**. `#gg-preview` 의 `disabled` 가 실제로 회색으로 보이는지, `.gg-warn` 이 실제로 눈에 띄는지, `renderSlotList` else 분기 1줄이 실렌더에서 부작용이 없는지 **전부 미확인**. 리더 Loop 5(라이브 13020 + sharp 스샷) **필수** |

---

## 4. 발견 결함

### ★ 결함 1 (심각도 **중** — 데이터 손실 · 게이트 사각지대) — `idx` 없는 주차면이 promote 로 정본에서 **소리 없이 삭제**된다

**재현(실행 확인, 임시 테스트로 실증):**
```
1. 픽스처 cam1 preset1 의 parking_spaces 에 idx 없는 주차면 1건을 추가 → 총 8면
   { "points": [[10,10],[20,10],[20,20],[10,20]] }     ← idx 키 없음(사람이 그리다 만 것·구버전 파일)
2. POST /capture/ground-grid/apply (camId:1, presetIdx:1, presets:[1], cols:7)
3. 관측: statusCode 200 · ok:true       ← 게이트 G1~G4 전부 통과
4. 승인 후 정본 cam1 preset1 parking_spaces = 7면    ← ★ 1면이 사라졌다
```
실행 로그 원문:
```
[QA-F 사각지대] 승인 전 8면 → 승인 후 7면 (7 이면 정본에서 소실)
```

**원인(경계면 불일치):**
- `normalizePtzCamRoi`(`placeRoi.ts:59`)는 `idx == null` 인 space 를 **`byPreset` 에서 탈락**시킨다(issues 만 남김).
- `buildApplySpaces` 는 그 **탈락 후의 `fileSpaces`** 만 받는다(`groundGridRoutes.ts:166`).
- `applyPlaceRoiUpdate` 는 대상 프리셋의 `parking_spaces` 를 **통째로 교체**한다(`placeRoi.ts:141-145`) → 탈락분이 raw 파일에서 사라진다.
- `assertAutoPromoteSafe` 는 **정규화된 idx 집합만** 비교한다(`autoRoiPlan.ts:500-505`) → 애초에 idx 가 없던 space 는 `current` 집합에도 없어 **`missingIdx` 에 잡히지 않는다**.

**성질:**
- **이번 라운드 신규 결함은 아니다.** 직전 L3 라운드에서 apply 가 이미 정본을 `writeFile` 했으므로 그때부터 존재했다. 같은 성질이 기존 `PUT /capture/place-roi` 에도 있다.
- **그러나 이번 라운드가 이 경로를 "승인 1회 = 정본 갱신 + DB 전량 재구성" 으로 승격**시켰으므로 **노출도와 결과 파급이 커졌다**(사라진 주차면이 즉시 DB 에도 반영된다).
- 완화 요인: 이번에 도입한 **`.bak` 이 실제로 복구를 가능하게 한다**(§2 에서 바이트 동일성 확인). 즉 되돌릴 수는 있다 — 다만 **사용자가 소실을 알아채야** 되돌린다.

**권고(택 1, 우선순위 순):**
1. `assertAutoPromoteSafe` 에 **G5** 추가 — `next`/`current` 의 **raw `parking_spaces` 개수**(정규화 전)를 프리셋별로 비교해 감소하면 거부. 순수함수 유지, DB 접근 0, 라우트 배선 1줄. **라우트 레벨 409 가 처음으로 도달 가능해진다**(C-3 이 지적한 "게이트가 도달 불가"도 동시에 해소).
2. 최소 조치 — `applyPlaceRoiUpdate` 호출 전 탈락분 개수를 세어 `issues` 에 경고를 남기고 응답·`#gg-msg` 에 노출(거부는 안 함).
3. 아무것도 안 한다면 **문서에 알려진 제약으로 명시**하고 confirm 문구에 추가한다.

### 관찰 2 (심각도 **하** — 추적성) — `refSpaceIdx` 가 클라이언트 재번호 대기 중이면 어긋난다

`ggApply()` 는 `refSpaceIdx: state.selectedPlaceIdx` 를 보낸다. `state.placeRoi` 는 `loadPlaceRoi()` 에서 **클라이언트 `normalizeGlobalIdx` 로 재번호될 수 있다**(`app.js:981-991`, `placeRoiDirty=true` 미저장 버퍼). 서버는 **raw 파일 idx** 로 계산한다.
→ 재번호가 미저장인 상태에서 승인하면 `_auto.meta.refSpaceIdx` 가 **파일 idx 와 다른 번호**를 가리킨다.
계산에는 쓰이지 않는 추적성 전용 필드이므로 **기능 영향 0**. 감사 기록의 정확도 문제로만 남는다. 좌표(`quad`)는 정규화 0~1 로 넘어가므로 무관하다.

### 관찰 3 (심각도 **하** — 테스트 위생, **기존 문제**) — 테스트가 저장소 루트에 `SettingAgent/x.json` 을 남긴다

`npx vitest run` 을 돌릴 때마다 `SettingAgent/x.json` 이 생성된다(`test/jobFrameReset.test.ts:38,110` 의 `outFile: 'x.json'` 이 cwd 상대 경로로 쓰인다). **이번 변경과 무관한 기존 문제**이며 `git status` 를 오염시킨다. 검증자가 매 실행 후 삭제했다.

---

## 5. (D) 경계면 교차 비교

| 경계 | 검증 방법 | 결과 |
|---|---|---|
| 웹 `state.placeRoi` → `POST bootstrap/apply` 의 `quad` | `ggRefSpace()` 는 `sp.points`(클라 `normalizePtzCamRoi` 산출 = **정규화 0..1 `{x,y}`**)를 그대로 넘기고, 서버 `QuadSchema` 는 `{x:number,y:number}` 4개를 **정규화로 해석**(`toPixelQuad` 가 `p.x*imgW`) | ✅ 일치. 리더 라이브 실측(avgIoU 0.9999768)과도 정합 |
| 서버 응답 `pairs[].quadNorm` → `drawAutoRoi` | 정규화 4점 → `toPixelQuad(quad, overlay.width, overlay.height)` — `drawPlateQuad` 와 동일 규약 | ✅ 일치 |
| **전역 idx 1..N** — 파일 ↔ `_auto` ↔ 정본 ↔ DB | 승인 후 `loadRoiIntoDb` 실행 → `getSlotSetup()` 의 `slotId` 배열이 파일 순회(cam asc → preset asc → 배열순) idx 와 **완전 일치**, 총 **23행**. `presetSlotIdx` 는 프리셋 내 1-based 순번으로 **전 행 일치** | ✅ 실행 확인 |
| **`_auto.json` → `normalizePtzCamRoi` 호환** | ① `_auto` 포함본과 제거본의 `byPreset`/`report` deep-equal ② ★ **실제 `_auto.json` 파일을 그대로 `loadRoiIntoDb` 의 소스로 넣어** 정본 소스일 때와 `ok`·`slots`·`getSlotSetup()` 전량 **동일** 확인 | ✅ 실행 확인. `_auto` 최상위 메타 키는 파이프라인 전체에 무해 |
| 정본 스키마 불변(`GET /capture/place-roi` raw 서빙) | promote 결과에 `_auto` 문자열 0회 | ✅ |
| 프리셋 선언 순서 | 역전 입력으로 apply → 정본 `cameras` 동일 | ✅ |
| **정규화 탈락분 ↔ raw 파일** | 위 결함 1 | ❌ **어긋남** |

---

## 6. 못 한 검증 (숨기지 않는다)

1. **브라우저 실렌더 — 미수행.** headless 브라우저·sharp 스샷을 띄우지 않았다. `web/app.js` +250줄의 실동작(버튼 회색/활성 전환, `.gg-warn` 가시성, `confirm()` 대화상자, 승인 연쇄 후 화면 갱신)은 **전부 미확인**. 정적 텍스트 봉인만 있다.
2. **라이브 서버(13020) 종단 미수행.** 실제 `data/Place01/PtzCamRoi.json` 을 대상으로 승인을 돌리지 않았다 — **의도적**이다(운영 정본 파괴 금지). 전 검증은 `os.tmpdir()` 사본과 `test/fixtures/` 픽스처로만 했다.
3. **S2 게이트 라우트 레벨 409 — 관측 0회.** 도달 불가가 사실이므로 **제품을 바꾸지 않는 한 실증 불가**(C-3).
4. **`renderSlotList` else 분기 실제 도달 조건 — 여전히 미확인.** `state.mapping` 이 채워지는 경로를 추적하지 않았다(설계 §8-1, 구현자 §5-2 와 동일하게 미해결).
5. **다중 클라이언트 동시 승인(read-modify-write 경합) — 미시험.**
6. **`.bak` 누적·배포 스크립트 영향 — 미확인.** `data/Place01/` 에 `_auto.json`·`.bak.json` 이 쌓이기 시작한다는 사실만 확인했다(현재 그 디렉터리에는 `PtzCamRoi.json` 1개뿐).
7. **실카 기준 수치 — 없음.** 모든 IoU·잔차는 Unity 픽스처(`test/fixtures/groundGrid.PtzCamRoi.json`) 기준이며 파이프라인 무손실만 증명한다. `ON_LATTICE_MAX_M=0.25`/`MATCH_MIN_IOU=0.5` 는 실카 재조정 대상으로 남아 있다.

---

## 7. 검증용 임시물 정리 증명

작성 후 삭제한 임시 테스트: `test/zzQaL3Verify.test.ts`(19 테스트) · `test/zzQaL3S5.test.ts`(3 테스트) · `test/zzDiag.test.ts`(1) — **전부 삭제 완료**.

`data/` 실파일은 **한 바이트도 건드리지 않았다.** 세션 시작 시점과 종료 시점의 `git diff --numstat -- data/ config/` 가 동일함:
```
15   5    SettingAgent/config/tools.config.json
109  109  SettingAgent/data/Place01/PtzCamRoi.json
114  0    SettingAgent/data/lens_calibration.json
225  261  SettingAgent/data/plate_discovery.json
939  5    SettingAgent/data/setup_artifact.json
94   95   SettingAgent/data/slot_ptz.json
```
> ⚠ 기록: `data/Place01/PtzCamRoi.json` 은 **세션 시작 시점에 이미 더러웠다**(mtime `2026-07-27 23:40:57` = 직전 L3 라운드). diff 내용은 `5.0→5`, `35.8000031→35.8`, `1.6934098→1.69341` 류의 **`stringify5` 재직렬화 흔적**이다. 이번 라운드 소스 편집(07-28 00:45~00:51)보다 **앞서므로 이번 라운드 산출이 아니다.** 커밋 시 이 파일을 어떻게 처리할지는 리더 판단 사항이다.

정리 후 `npx vitest run` 재실행: **252 파일 / 2999 테스트 전량 통과**(§0 과 동일).

---

## 8. 실행 명령과 원문 결과

```
$ npx tsc --noEmit
(출력 없음)                                     exit 0

$ npx vitest run
 Test Files  252 passed (252)
      Tests  2999 passed (2999)
   Start at  10:50:06
   Duration  15.00s (transform 10.37s, setup 0ms, collect 48.01s, tests 29.83s, environment 47ms, prepare 25.81s)

$ npx vitest run test/groundGrid.test.ts            # 직전 L3 골든 해시
 ✓ test/groundGrid.test.ts (13 tests) 19ms
      Tests  13 passed (13)

$ npx vitest run test/groundGridRoutes.test.ts test/captureLoadRoiRoutes.test.ts \
    test/groundGridPanelUi.test.ts test/groundGridPromote.test.ts \
    test/placeRoiPaths.test.ts test/slotCuboidRoutes.test.ts
 ✓ test/placeRoiPaths.test.ts       (8 tests)   6ms
 ✓ test/groundGridPanelUi.test.ts   (17 tests)  40ms
 ✓ test/groundGridRoutes.test.ts    (10 tests)  182ms
 ✓ test/groundGridPromote.test.ts   (20 tests)  281ms
 ✓ test/captureLoadRoiRoutes.test.ts (11 tests) 188ms
 ✓ test/slotCuboidRoutes.test.ts    (21 tests)  246ms
 Test Files  6 passed (6)
      Tests  87 passed (87)

$ npx vitest run test/zzQaL3Verify.test.ts          # 검증자 임시(삭제됨)
 ✓ test/zzQaL3Verify.test.ts (19 tests) 298ms
      Tests  19 passed (19)
 stdout: [QA-F 사각지대] 승인 전 8면 → 승인 후 7면 (7 이면 정본에서 소실)

$ npx vitest run test/zzQaL3S5.test.ts              # 검증자 임시(삭제됨)
 ✓ test/zzQaL3S5.test.ts (3 tests) 114ms
      Tests  3 passed (3)
```

---

## 9. 리더 인계 — 처리 우선순위

| # | 항목 | 권고 |
|---|---|---|
| 1 | **결함 1**(idx 없는 주차면 소실 · 게이트 사각지대) | **G5(raw 개수 비교) 추가**를 권고. 부수 효과로 G1~G4 의 "라우트 도달 불가"도 해소돼 게이트가 살아난다. 즉시 조치가 어려우면 최소한 `issues` 경고 + 문서 명시 |
| 2 | **브라우저 실렌더 — 5라운드 연속 미검증** | 리더 Loop 5(라이브 13020 + sharp 스샷) 실행 필요. 이번엔 `web/app.js` +250줄이라 미검증 면적이 가장 크다 |
| 3 | `data/Place01/PtzCamRoi.json` 워킹트리 오염 | 직전 라운드 잔여. 커밋 포함/되돌림 여부 결정 필요 |
| 4 | 관찰 2(`refSpaceIdx` 재번호 어긋남) | 감사 정확도만 영향. 후속 |
| 5 | 관찰 3(`x.json` 테스트 잔여물) | 기존 문제. 별건 정리 |
