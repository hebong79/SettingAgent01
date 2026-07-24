# 검증 보고서 — `preset_pos` → `preset_info` DB 스키마 리팩토링 (적대적 검증)

- 작성: 검증자(qa-tester)
- 대상 브랜치: `feature/preset-pos-to-info` (메인 리포 직접 작업)
- 코드 루트: `d:\Work\Parking3D\AgentVLA\ParkAgent\SettingAgent`
- 기준 문서: `_workspace_preset_info/01_architect_plan.md`, `_workspace_preset_info/02_developer_changes.md`
- 검증 방식: 구현자 주장을 신뢰하지 않고 **직접 재현**. 기존 테스트 실행 + **적대적 신규 테스트 23건 작성·실행** + **실 운영 DB(파일) 대조**

---

## 0. 판정 요약

**리팩토링 자체는 결함 없음 — 통과.** 설계서 §7 T0~T7 전부 실증 확인.
멱등성·데이터 보존·FK 추종·place_id 기본값·부분 마이그레이션 재개·외부 JSON 계약 불변 —
9개 적대적 항목 중 **기능 결함 0건**. 구현자가 보고한 tsc/vitest 수치는 **사실**이었다.

다만 리팩토링과 **무관한** 문제 3건과, 리팩토링이 **드러낸(유발하지 않은)** 선재 결함 1건을 발견했다.
가장 중요한 것은 **F1** — 이 리팩토링의 주인공 컬럼 `preset_name`이 **운영 DB에서 전부 NULL**이다.

| 심각도 | ID | 내용 | 이번 변경이 원인? |
|---|---|---|---|
| 중 | F1 | `preset_name`이 운영 경로에서 항상 NULL로 덮어써짐(ROI 유래 프리셋이 camerapos 라벨을 말소) | ❌ 선재(리네임 전 `sname`도 동일) |
| 중 | F2 | 세션 도중 제3자가 `web/app.js`·`web/index.html`을 동시 수정 → `setupResultRoute.test.ts` 2건 신규 red | ❌ 완전 무관(동시작업 사고) |
| 하 | F3 | 마이그레이션 DB와 신규 DB의 `preset_info` **컬럼 순서**가 다름 | ✅ 이번 변경(수용 가능) |
| 하 | F4 | `preset_pos`·`preset_info` 동시 존재 시 구 테이블 데이터가 **조용히 미이관** | ✅ 이번 변경(현실성 낮음) |
| 하 | F5 | 구현자가 만든 백업 파일이 `-wal` 미포함 → 복원 시 대량 데이터 손실 위험 | ❌ 운영 절차 |
| 하 | F6 | 정본 스키마 문서에 `preset_pos`(2번)와 `preset_info`(4번)가 **공존** + 항목번호 중복 | ❌ 문서 |

---

## 1. 실행 검증 (실제 수치)

작업 디렉토리 `d:\Work\Parking3D\AgentVLA\ParkAgent\SettingAgent`.

### 1.1 `npx tsc --noEmit`
```
(출력 0줄) → 에러 0, exit code 0
```
파이프 없이 exit code를 직접 채집해 확인(구현자 보고와 일치).

### 1.2 `npx vitest run` — 1차(15:00, 신규 테스트 추가 전)
```
 Test Files  1 failed | 227 passed (228)
      Tests  2 failed | 2659 passed (2661)
   Duration  14.13s
```
red 2건 = `test/buildTouringPlan.test.ts` 뿐. **구현자 보고 수치와 정확히 일치.**

### 1.3 `npx vitest run` — 2차(15:16, 적대적 테스트 23건 추가 후)
```
 Test Files  2 failed | 227 passed (229)
      Tests  4 failed | 2680 passed (2684)
   Duration  12.75s
```
- 2661 + 23 = 2684 ✓ (신규 23건 전부 green)
- red 4건 = buildTouringPlan 2건(기준선) + **setupResultRoute 2건(F2 — 1차엔 green이었음)**

### 1.4 신규 적대적 스위트 단독
```
 Test Files  1 passed (1)
      Tests  23 passed (23)
   Duration  1.53s
```

---

## 2. 항목별 검증 결과 (지시된 1~9)

| # | 항목 | 판정 | 근거 |
|---|---|---|---|
| 1 | 멱등성(3회 재오픈) | ✅ | 레거시/신규 **파일 DB 각각 3회 오픈** — `sqlite_master` SQL·`PRAGMA table_info`·`foreign_key_list`·전 행 데이터(값+typeof) **스냅샷 완전 동일**. `place_id` 중복 추가 없음. `:memory:` 신규는 마이그레이션 no-op |
| 2 | 데이터 보존(바이트) | ✅ | preset 5행(유니코드/빈문자열/NULL 라벨, `-0.000012345`, `1e-7`, `updated_at` NULL, 백슬래시 포함) + slot_setup 3행(전 컬럼 채움) 시드 → 마이그레이션 후 **값 + SQLite 스토리지 클래스(`typeof()`)** 완전 일치. `sname` 값이 `preset_name`으로 무손실 이동. 빈 문자열이 NULL로 변질되지 않음. round5 재적용 없음(마이그레이션은 값 미변조) |
| 3 | FK 정합 | ✅ | `PRAGMA foreign_key_list(slot_setup)` → `[preset_info, preset_info]`, `cam_id->cam_id`/`preset_id->preset_id`. `slot_setup` 스키마 텍스트에 `preset_pos` 문자열 **잔존 없음**. 부모 없는 `(1,99)` INSERT → `FOREIGN KEY constraint failed` throw / 부모 있는 `(1,1)` → 통과. `PRAGMA foreign_keys`=1 실측. **실 운영 DB에서도 동일 확인**(아래 §3) |
| 4 | place_id 기본값 | ✅ | 마이그레이션된 5행 전부 `place_id=1`, NOT NULL 실효(`UPDATE ... NULL` → throw). **신규 CREATE 경로의 `REFERENCES place_info` 실효 확인** — `placeId:999` upsert → FK throw, `placeId:1` → 통과. 마이그레이션 DB는 설계서가 수용한 대로 place_id FK 없음(999 통과) — 대조군 테스트로 divergence 실증 |
| 5 | 부분 마이그레이션 중간 상태 | ✅ | 4가지 중간 상태 실증. A(`preset_info`+`sname`, place_id 無) → 컬럼 2건 보충. B(`preset_name` 有, place_id 無) → place_id만 추가. C(`preset_pos`인데 place_id 이미 有) → 리네임만, 중복 추가 없음. D(양 테이블 동시 존재) → **throw 없음**(단 F4 참조) |
| 6 | **sname 이중 문맥 회귀** | ✅ **회귀 없음** | `cameraposWriter.writeCamerapos` 출력 JSON에 `"sname"` 존재, `preset_name`/`presetName` 문자열 **부재**. 엔트리 키 집합 = `[cam_id, pan, preset_id, sname, tilt, zoom]`. `mapTargets.parseCameraViews`가 `sname`을 읽어 라벨 복원(왕복 성공) — 반증 대조군으로 키를 `preset_name`으로 바꾸면 폴백 라벨 `Preset 2`로 떨어짐 확인. 경계 교차 `JSON sname → PresetInfoRow.presetName → DB preset_name` 전 구간 통과. 고정 픽스처 2종도 `sname` 유지 |
| 7 | 누락 사용처 | ✅ | `src/`·`test/`·`web/`·`scripts/` 전수 grep 결과 잔존 참조 **0건**(`SqliteStore.ts`의 마이그레이션 코드·주석과, 설계서가 의도적으로 남긴 `slot3dFrontCenter.test.ts` 레거시 픽스처 제외). `src/`의 `sname` 잔존은 전부 **외부 JSON 키 문맥**임을 라인 단위로 확인. ParkAgent 타 서비스·Unity `Assets/Scripts` C# 전수 grep → 소비자 **없음**(교차 계약 파손 위험 없음) |
| 8 | renumber 무영향 | ✅ | 마이그레이션된 DB에서 `renumberSlotIds({7→1,8→2,9→3})` → `changed:3`, `(cam,preset)` 조합 보존(FK 부모 판정 유효), **재오픈 후에도 유지**. 기존 `sqliteStore.renumber`/`renumberRoute`/`renumber.adversarial` 스위트 green |
| 9 | DB 뷰어 | ✅ | 레거시 DB 마이그레이션 후 `GET /db/tables` → `preset_info` 포함·`preset_pos` **부재**. `GET /db/table/preset_info` → `columns`에 `preset_name`·`place_id`, `total:5`. `GET /db/table/preset_pos` → **404**(화이트리스트 동적 조회 동작 확인) |

### 기준선 red 주장의 진위 (지시대로 의심하고 확인)
**주장은 사실이다.**
- `test/buildTouringPlan.test.ts`는 `web/core.js`의 `buildTouringPlan`과 `save/setup_result.json`만 사용한다. SqliteStore·preset 테이블·`src/capture/*` 전혀 미사용(파일 전문 확인).
- 세 파일 모두 `git status`상 **미변경**.
- 근본 원인 실측: `save/setup_result.json`의 슬롯 23건 중 `centering` 비-null이 **0건**(테스트는 23건 전부 non-null을 기대). 라이브 데이터 결손이지 코드 결함이 아니다.
→ 이번 변경과 **무관** 확정.

---

## 3. 실 운영 DB 대조 (합성 테스트 밖의 경험적 검증)

`data/setting.sqlite`(마이그레이션 완료본) vs `data/setting.sqlite.bak-presetinfo-20260724_145745`(구현자 백업본)을 직접 열어 대조:

| 항목 | 백업본(구) | 현재 운영 DB(신) |
|---|---|---|
| 프리셋 테이블 | `preset_pos` | `preset_info` |
| 라벨 컬럼 | `sname` | `preset_name` |
| place_id | 없음 | `place_id INTEGER NOT NULL DEFAULT 1` (REFERENCES 없음 — 수용된 divergence 실물 확인) |
| 컬럼 순서 | — | `..., zoom, updated_at, place_id` ← **맨 뒤**(F3) |
| `slot_setup` FK | `preset_pos` | **`preset_info`** ← RENAME TO 자동 추종 실물 확인 |

→ RENAME TO의 FK 자동 추종은 **합성 테스트뿐 아니라 실 운영 DB에서도 성립**함을 확인했다.

---

## 4. 발견 사항 상세

### F1 (심각도 중) — `preset_name`이 운영 경로에서 항상 NULL로 덮어써진다 · **선재 결함, 이번 변경이 원인 아님**

**현상**: 운영 DB `preset_info`의 `preset_name`이 5행 **전부 NULL**. 반면 `config/camerapos.json`에는
`"sname": "Preset 1"~"Preset 3"`이 정상 존재한다. 즉 이번 리팩토링이 도입한 주인공 컬럼이 실데이터에서 비어 있다.

**근본 원인**: `src/capture/roiDbLoad.ts`의 `loadRoiIntoDb` 순서.
1. `buildPresets(camerapos)` → `presetName: "Preset 1"…` 로 upsert (정상)
2. 직후 `buildPresetsFromRoi(ROI)` 결과를 **"camerapos.json 보다 우선"** 이라며 다시 upsert
3. 그런데 `data/Place01/PtzCamRoi.json`의 `presets[]`에는 `sname`/`name` 키가 **없다** → `label = null`
4. `upsertPresetInfo`의 `ON CONFLICT ... DO UPDATE SET preset_name=excluded.preset_name` 이 라벨을 **NULL로 말소**

**재현**(실제 실행 로그, 운영 데이터 파일 그대로):
```
buildPresets(camerapos).presetName   = ["Preset 1","Preset 2","Preset 3","Preset 1","Preset 2"]
buildPresetsFromRoi(ROI).presetName  = [null,null,null,null,null]
loadRoiIntoDb ok = true | issues 에 "ROI 파일의 프리셋 PTZ 5건 채택(camerapos.json 보다 우선)"
DB preset_info = [{cam_id:1,preset_id:1,preset_name:null,pan:19.8}, … 5행 전부 preset_name:null]
```

**이번 변경이 원인이 아닌 근거**:
- 리네임 전 코드도 `sname: label`(null) + `sname=excluded.sname`로 **동일 의미**였다. 순수 리네임이라 의미 변화 없음.
- 운영 DB의 해당 행 `updated_at`이 `2026-07-23T09:17:35`(마이그레이션 실행 07-24 14:5x보다 **하루 전**) → 마이그레이션은 이미 NULL이던 값을 그대로 보존했을 뿐이다.

**권고(구현자·리더 판단 필요, 내가 고치지 않음)**: `preset_name`을 실제로 쓸 것이라면
`buildPresetsFromRoi`의 라벨 null일 때 기존 값을 보존하도록 `ON CONFLICT` 에서
`preset_name = COALESCE(excluded.preset_name, preset_name)` 로 바꾸거나, PTZ만 갱신하는 별도 문을 쓰는 설계 결정이 필요하다.
**범위 밖이라 이번 검증에서는 수정하지 않았다.**

### F2 (심각도 중, 프로세스) — 세션 도중 제3자가 `web/` 파일을 동시 수정해 테스트 2건이 신규 red

- 세션 시작 시 `git status`에 `web/` 항목 **없음**(clean). 15:00 전량 실행에서 `setupResultRoute.test.ts` **green**.
- **15:14:45**에 `web/app.js`(-13줄)·`web/index.html`(-2/+1줄)이 외부에서 수정됨. 내용: `makeSetupResultFile()` 함수와 `$('cal-result-file')` 결선, `<button id="cal-result-file">result 파일 생성</button>` **삭제**(대신 `cap-touring` 버튼 이동).
- 그 결과 `test/setupResultRoute.test.ts > 뷰어 결선(#cal-result-file)` 2건이 삭제된 버튼을 단언하다 실패.
- **preset 코드와 무관**(DB/타입/DAO 무접촉). 이 브랜치를 **워크트리 없이 메인 리포에서 직접** 작업 중이라 동시 편집 충돌에 노출돼 있다.
- 조치 권고: 리더가 해당 `web/` 변경의 출처를 확인하고, 의도된 변경이면 `setupResultRoute.test.ts`를 함께 갱신해야 한다. **preset 리팩토링의 성공/실패 판정에 포함시키면 안 된다.**

### F3 (심각도 하) — 마이그레이션 DB와 신규 DB의 컬럼 순서 divergence
```
마이그레이션: cam_id, preset_id, preset_name, pan, tilt, zoom, updated_at, place_id   ← place_id 맨 뒤
신규 CREATE : cam_id, preset_id, preset_name, pan, tilt, zoom, place_id, updated_at   ← zoom 다음
```
`ADD COLUMN`은 항상 마지막에 붙기 때문이며, 컬럼 **집합**은 동일하다.
프로덕션 코드는 전부 명시 컬럼 리스트를 쓰므로 기능 영향 없음. 다만 `/db/table/preset_info` 뷰어의 **컬럼 표시 순서가 DB마다 다르게** 보이고, 향후 누군가 `INSERT INTO preset_info VALUES(...)`(컬럼 생략)를 쓰면 조용히 깨진다. 실 운영 DB에서도 실물 확인함. 테스트로 고정해 두었다.

### F4 (심각도 하) — `preset_pos`와 `preset_info`가 동시 존재하면 구 데이터가 조용히 사라진다
`migratePresetPosToInfo()`는 `preset_pos 有 && preset_info 無`일 때만 리네임한다. 둘 다 있으면
리네임을 건너뛰고 `preset_info`만 정비하며, **`preset_pos`의 행은 이관되지 않고 경고도 없다**(테스트로 실증: `getPresetKeys()`가 구 테이블 행을 못 봄). throw는 없어 크래시하지 않는다.
현실적 발생 경로가 거의 없어(신규 코드가 빈 `preset_info`를 먼저 만들 수 없는 순서로 설계됨) 심각도 하로 판단하나, 무경고 침묵이라 최소한 `issues`/로그 경고는 있는 편이 낫다.

### F5 (심각도 하, 운영) — 백업 파일이 WAL을 포함하지 않는다
`data/setting.sqlite.bak-presetinfo-20260724_145745`는 **메인 파일만** 복사됐다. 당시 `data/setting.sqlite-wal`은 **3.13MB**였고, 메인 파일의 내용은 07-18 시점이었다.
실제로 백업본을 열어보면 `preset_pos` 3행 / `slot_setup` 17행인 반면, 현재 운영 DB는 5행 / 23행이다.
→ **이 백업으로 롤백하면 07-18 이후 변경분이 전부 소실된다.** 향후 백업은 `-wal`/`-shm` 동반 복사 또는 `VACUUM INTO`/`.backup`을 사용해야 한다. (문서화 담당 전달 권고)

### F6 (심각도 하, 문서) — 정본 스키마 문서 불일치
`Docs/MyThink/my_db_table.md`에 신규 `preset_info` 절이 추가됐으나(`4. preset_info`), 기존 `2. preset_pos` 절이 **그대로 남아 있고**, 항목 번호가 `4. preset_info` / `4. place_info`로 **중복**된다.
또한 `SettingAgent/docs/` 하위 기존 문서들의 `preset_pos` 표기도 미갱신(구현자가 범위 밖으로 명시). 문서화 담당 처리 대상.

---

## 5. 추가한 테스트

**신규 파일**: `d:\Work\Parking3D\AgentVLA\ParkAgent\SettingAgent\test\presetInfoMigration.adversarial.test.ts` (23 tests, 전부 green)

| 그룹 | 테스트 | 덮는 지시 항목 |
|---|---|---|
| 적대적 1 | 레거시 파일 DB — 1회차 마이그레이션 후 2·3회차 스냅샷 완전 동일 | 1 |
| 적대적 1 | 신규 파일 DB — 3회 오픈해도 스키마·데이터 불변 | 1 |
| 적대적 1 | `:memory:` 신규 DB는 마이그레이션 no-op(컬럼 순서까지 고정) | 1 |
| 적대적 2 | preset 5행 — 유니코드/빈문자열/NULL 라벨·정밀 실수가 손실 없이 이동(값+스토리지 클래스) | 2 |
| 적대적 2 | 마이그레이션 후 `getPresetKeys`/`getSlotSetup`가 전 행을 그대로 본다 | 2 |
| 적대적 3 | `PRAGMA foreign_key_list(slot_setup)` 부모가 `preset_info`(+스키마 텍스트에 `preset_pos` 부재) | 3 |
| 적대적 3 | 신규 DB도 동일하게 `preset_info` 부모 | 3 |
| 적대적 3 | 부모 없는 INSERT throw / 부모 있으면 통과 | 3 |
| 적대적 3 | `foreign_keys` PRAGMA가 실제로 ON | 3 |
| 적대적 4 | 마이그레이션 5행 전부 `place_id=1` + NOT NULL 실효 | 4 |
| 적대적 4 | **신규 CREATE 경로의 `REFERENCES place_info` 실효**(999 → throw) | 4 |
| 적대적 4 | 수용된 divergence 실증(마이그레이션 DB엔 place_id FK 없음, 신규엔 있음) | 4 |
| 적대적 4 | 컬럼 순서 divergence 고정(F3) | 4 |
| 적대적 5 | 상태 A: 테이블만 리네임됨 → 컬럼 2건 보충 | 5 |
| 적대적 5 | 상태 B: 컬럼 리네임까지 됨 → place_id만 추가 | 5 |
| 적대적 5 | 상태 C: 구 테이블인데 place_id 이미 有 → 중복 추가 없음 | 5 |
| 적대적 5 | 상태 D: 양 테이블 동시 존재 → throw 없음(F4 동작 고정) | 5 |
| 적대적 6 | writer가 여전히 `sname` 키로 쓰고 `preset_name` 키를 쓰지 않는다 | 6 |
| 적대적 6 | `parseCameraViews`가 여전히 `sname`을 읽는다(왕복 + 반증 대조군) | 6 |
| 적대적 6 | 경계 교차 `JSON sname → PresetInfoRow.presetName → DB preset_name` | 6 |
| 적대적 6 | 고정 픽스처 camerapos JSON 2종도 `sname` 유지 | 6 |
| 적대적 8 | 마이그레이션 DB에서 `renumberSlotIds` 정상 + 재오픈 후 유지 | 8 |
| 적대적 9 | `/db/tables`에 `preset_info` 노출·`preset_pos` 404 | 9 |

> 참고: 적대적 9의 `afterEach`는 `rmSync`를 try/catch로 감쌌다. `dbRoutes`의 read-only 연결이 프로세스 수명 동안 캐시 오픈 상태라 Windows에서 임시 폴더 즉시 삭제가 EPERM으로 실패하기 때문이며, **기존 `test/dbRoutes.test.ts`와 동일한 기존 패턴**이다(검증 본문과 무관).

---

## 6. 검증하지 못한 한계 (위장 금지)

1. **실 운영 DB의 라벨 보존은 직접 증명하지 못했다.** 운영 DB의 `preset_name`은 마이그레이션 **이전부터** 이미 NULL이었다(F1). 따라서 "실데이터에서 non-null `sname`이 보존되었다"는 명제는 **합성 테스트로만** 증명했고, 운영 데이터로는 증명 불가였다. 또한 구현자 백업본이 WAL을 빠뜨려(F5) 마이그레이션 직전 상태와의 1:1 대조 자체가 불가능했다.
2. **실서비스 기동(Play Mode 상당) 스모크 미수행.** SettingAgent 프로세스를 띄워 `/capture/start`·`/slots/load-roi` 등 라이브 라우트를 실제로 태우는 검증은 하지 않았다. VPD/LPD/LPR/VLA/Unity 외부 서비스 미가동 상태이며, 이번 변경이 순수 DDL/DAO/타입 리네임이라 유닛 레벨로 충분하다고 판단했으나 **스모크는 누락**임을 명시한다.
3. **동시성 마이그레이션 미검증.** 두 프로세스가 같은 파일 DB를 동시에 처음 여는 경우(`ALTER TABLE` 경합)는 테스트하지 않았다. `migratePresetPosToInfo()`는 트랜잭션으로 감싸여 있지 않다(각 ALTER가 개별 자동 커밋). 단일 프로세스 기준으로는 중간 상태에서 재개 가능함을 F5-A~C로 실증했다.
4. **매우 큰 DB에서의 마이그레이션 시간·잠금 영향 미측정.** 운영 DB가 5행/23행 규모라 의미가 없었다.
5. **`web/` 동시 수정(F2)의 출처를 특정하지 못했다.** 타임스탬프(15:14:45)와 diff 내용까지만 확인했고, 어느 세션/프로세스가 썼는지는 추적하지 않았다. 해당 red 2건은 이번 리팩토링 판정에서 제외했다.
6. **`docs/` 하위 산문 문서와 `dist/` 빌드 산출물은 지시대로 검증 범위에서 제외**했다(`dist/`에는 구 심볼이 남아 있을 수 있으나 재빌드로 해소되는 산출물이다).

---

## 7. 구현자 전달 사항

- **재작업 필요 없음.** 요청된 스키마 리팩토링 범위에서 결함을 찾지 못했다. tsc 0, 신규 적대적 23건 전부 green.
- **리더 판단 요망**: F1(`preset_name` 상시 NULL 말소)은 이번 범위 밖의 선재 결함이지만, 이 리팩토링의 목적(프리셋 이름 컬럼 정본화)을 실질적으로 무력화한다. 별도 작업으로 처리할지 결정 필요.
- **리더 확인 요망**: F2(`web/` 동시 수정) — 의도된 변경인지, 되돌려야 하는지.
