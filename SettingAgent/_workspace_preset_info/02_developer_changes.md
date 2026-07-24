# 구현 결과 — `preset_pos` → `preset_info` 리네임 + `preset_name`/`place_id` 반영

- 작성: 구현자(developer)
- 기준 설계서: `_workspace_preset_info/01_architect_plan.md`
- 브랜치: `feature/preset-pos-to-info` (메인 리포, 워크트리 아님)
- 커밋: **하지 않음**(리더 담당)

---

## 1. 리더 확정 사항 반영 여부

| 확정 사항 | 반영 |
|---|---|
| place_id FK divergence **수용**(마이그레이션은 `ADD COLUMN place_id INTEGER NOT NULL DEFAULT 1`, REFERENCES 생략 / 신규 CREATE 는 `REFERENCES place_info(place_id)` 유지) | ✅ 그대로 구현. 테이블 재빌드 방식 미채택 |
| ensureSchema **순서 역전**(리네임 마이그레이션을 CREATE 블록 **이전**에 배치) | ✅ `ensureSchema()` 첫 줄에서 `migratePresetPosToInfo()` 호출 |
| `pan/tilt/zoom` REAL 3컬럼 유지(pos JSON 컬럼 신설 금지) | ✅ 신설 없음 |
| 외부 JSON 키 `sname` 불변 | ✅ `cameraposWriter.ts` / `mapTargets.ts` / 픽스처 JSON 전부 무변경. 문맥별 수동 판별(일괄치환 미사용) |
| 소수점 5자리 규약(round5) | ✅ `upsertPresetInfo` 의 pan/tilt/zoom 에 기존 `round5` 유지 |

---

## 2. 변경 파일별 내역

### 2.1 src (5개 수정)

| 파일 | 내역 |
|---|---|
| `src/capture/types.ts` | 헤더 주석 6테이블 목록 `preset_pos`→`preset_info`. `PresetPosRow` → **`PresetInfoRow`**: `sname: string \| null` → `presetName: string \| null`(JSDoc 에 "JSON 키 sname 값" 명시), **`placeId: number` 신규 required 필드** 추가 |
| `src/capture/SqliteStore.ts` | ① import `PresetPosRow`→`PresetInfoRow` ② `ensureSchema()` 선두에 `this.migratePresetPosToInfo()` 호출 삽입(CREATE 이전) ③ CREATE DDL `preset_pos`→`preset_info`(`sname`→`preset_name`, `place_id` 컬럼 추가) ④ `slot_setup` FK `REFERENCES preset_pos(...)`→`preset_info(...)` ⑤ **신규 private `migratePresetPosToInfo()`** ⑥ `upsertPresetPos`→**`upsertPresetInfo`**(INSERT 컬럼 8개 + ON CONFLICT 에 `preset_name`/`place_id` 반영) ⑦ `getPresetKeys()` `FROM preset_pos`→`preset_info` |
| `src/capture/roiDbLoad.ts` | import 타입 교체. `buildPresetsFromRoi`/`buildPresets` 반환타입 `PresetInfoRow[]`, Row 리터럴 `sname:`→`presetName:` + `placeId: PLACE_ID` 추가. `loadSetupTargetsFromRoi`/`roiToCameraViews` 의 Row 접근 `p.sname`→`p.presetName`. `loadRoiIntoDb`: 변수타입·자리표시자 리터럴 갱신, `store.upsertPresetPos(...)` **3곳** → `upsertPresetInfo`. 주석/issue 문자열의 `preset_pos` 표기 → `preset_info` |
| `src/tools/migrateToSettingDb.ts` | 주석 매핑표 `preset_pos ← camerapos ...(sname...)` → `preset_info ← ...(preset_name(=json sname)...)`. `store.upsertPresetPos(presets)` → `upsertPresetInfo(presets)`. `buildPresets` import·함수명 유지(외과적) |
| `src/api/captureRoutes.ts` | L452 주석 1줄만(`slot_setup 은 preset_info 를 FK 부모로 요구`) |

**src 불변(외부 JSON 계약)**: `src/setup/cameraposWriter.ts`(쓰기 키 `sname`), `src/setup/mapTargets.ts`(읽기 키 `v.sname`/`g.sname`), `src/api/dbRoutes.ts`(테이블 화이트리스트가 `sqlite_master` 동적 조회라 코드 변경 불필요 — 다만 `/db/tables` 노출명이 `preset_info` 로 바뀜).
`roiDbLoad.buildPresets` 의 우변 `p?.sname`(camerapos JSON 읽기)도 **유지** — 좌변만 `presetName:` 으로 번역.

### 2.2 test (25개 수정 + 1개 신규)

- **타입/메서드 식별자 일괄**(24파일): `PresetPosRow`→`PresetInfoRow`, `upsertPresetPos`→`upsertPresetInfo`.
- **Row 리터럴 27곳**(라인 단위 수동 지정): `sname: X` → `presetName: X, placeId: 1`.
  `Partial<PresetInfoRow>` 오버라이드 3곳(`sqliteStore.test.ts` L124/168/204)은 이름만 변경(placeId 미추가 — 기본값이 헬퍼에 있음).
- **raw SQL/단언/테이블명**:
  - `sqliteStore.test.ts` L73 6테이블 목록 → `preset_info`
  - `migrateToSettingDb.test.ts` L106 `count('preset_pos')` → `count('preset_info')`
  - `round5.test.ts` L152 `FROM preset_pos` → `preset_info`
  - `roiDbLoad.test.ts` L304/L342 `SELECT ... sname ... FROM preset_pos` → `SELECT ... preset_name ... FROM preset_info` + 결과 타입/`toMatchObject`/`toEqual` 의 `sname:` → `preset_name:`(**DB 컬럼명**이므로 변경 대상)
  - 관련 주석/describe 문자열의 `preset_pos` 표기 갱신
- **의도적 미변경**: `slot3dFrontCenter.test.ts` L214~215 의 레거시 `CREATE TABLE preset_pos ... sname ...` 픽스처 — 이제 마이그레이션 **입력**으로 기능하므로 설계서 판단대로 그대로 둠(해당 테스트 green 유지 = 라운드트립 검증 T7).
- **JSON 키 불변 확인**: `cameraposSource.test.ts`, `mapTargets.test.ts`, `test/fixtures/camerapos.*.json`, 각 테스트의 camerapos/ROI JSON 리터럴(`captureLoadRoiRoutes.test.ts` writeFileSync, `roiDbLoad.test.ts` datas 등)의 `sname` 은 **전혀 손대지 않음**.

- **신규**: `test/presetInfoMigration.test.ts` (4 tests) — 설계서 §7-T3.
  1. 레거시 파일 DB(구 `preset_pos`+`sname`, place_id 없음, `slot_setup` FK→`preset_pos`) 시드 → 오픈 후 리네임 완료·`preset_name`/`place_id` 존재·`sname` 부재·`preset_pos` 부재·기존 라벨/PTZ 보존·`place_id` 기본 1·slot_setup 행 보존
  2. **FK 자동 추종 실증** — 부모 있는 `(1,1)` INSERT 통과 / 부모 없는 `(1,9)` throw + 롤백
  3. **멱등** — 재오픈 시 무변경·무오류(`place_id` 중복 추가 없음)
  4. 신규 `:memory:` DB 는 CREATE 만으로 완비(마이그레이션 no-op) + round5 왕복

---

## 3. 마이그레이션 DDL (실제 구현)

신규(CREATE) 경로 — `SqliteStore.ensureSchema()`:
```sql
CREATE TABLE IF NOT EXISTS preset_info (
  cam_id      INTEGER NOT NULL REFERENCES camera_info(cam_id),
  preset_id   INTEGER NOT NULL,
  preset_name TEXT,
  pan         REAL NOT NULL,
  tilt        REAL NOT NULL,
  zoom        REAL NOT NULL,
  place_id    INTEGER NOT NULL DEFAULT 1 REFERENCES place_info(place_id),
  updated_at  TEXT,
  PRIMARY KEY (cam_id, preset_id)
);
-- slot_setup:
FOREIGN KEY (cam_id, preset_id) REFERENCES preset_info(cam_id, preset_id)
```

기존(마이그레이션) 경로 — `migratePresetPosToInfo()`, **CREATE 이전 실행**, 전부 감지 후 조건 실행(멱등):
```sql
-- 1) sqlite_master 에 preset_pos 有 & preset_info 無 일 때만. slot_setup FK 참조를 SQLite 가 자동 추종.
ALTER TABLE preset_pos RENAME TO preset_info;
-- 2) PRAGMA table_info 에 sname 有 & preset_name 無 일 때만.
ALTER TABLE preset_info RENAME COLUMN sname TO preset_name;
-- 3) place_id 無 일 때만. foreign_keys=ON + REFERENCES + NOT NULL DEFAULT 동시 불가 → REFERENCES 생략.
ALTER TABLE preset_info ADD COLUMN place_id INTEGER NOT NULL DEFAULT 1;
```

**divergence(수용)**: 신규 DB 의 `preset_info.place_id` 에는 `place_info(place_id)` FK 가 있고, 마이그레이션된 기존 DB 에는 없다. 값이 항상 1이고 `place_info(1)` 이 상존하므로 실질 참조 무결성은 유지된다(기존 `slot3d_front_center` ALTER 선례와 일관).

**FK 자동 추종은 가정이 아니라 실증됨** — `presetInfoMigration.test.ts` 2번 테스트에서 FK 를 실제로 건 레거시 DB 로 확인(better-sqlite3 번들 SQLite ≥3.25, `legacy_alter_table` 미설정).

**운영 주의**: 실 파일 DB(`data/setting.sqlite`)는 SettingAgent 첫 기동 시 자동 마이그레이션된다(데이터 보존, 되돌리는 코드는 없음) → 기동 전 파일 백업 권장.

---

## 4. 검증 결과 (실제 실행 수치)

작업 디렉토리 `d:\Work\Parking3D\AgentVLA\ParkAgent\SettingAgent`.

### 4.1 `npx tsc --noEmit`
```
(출력 없음) → 에러 0
```

### 4.2 `npx vitest run`
```
 Test Files  1 failed | 227 passed (228)
      Tests  2 failed | 2659 passed (2661)
   Duration  13.68s
```

**실패 2건 = 리더가 지정한 기준선 red 예외 그대로:**
- `test/buildTouringPlan.test.ts > preset 스텝은 그룹당 1개(총 5개) ...` — `expected [] to have a length of 23 but got +0`
- `test/buildTouringPlan.test.ts > 각 preset 스텝 직후에 그 그룹의 slot 스텝들이 배치된다 ...` — 그룹 카운트 전부 0

> **본 변경과 무관함을 확인**: 이 테스트는 `web/core.js` 의 `buildTouringPlan` + 라이브 데이터 파일 `save/setup_result.json` 만 사용한다(SqliteStore·preset 테이블 미사용). 두 파일 모두 이번 작업에서 **수정하지 않았다**(`git status` 로 확인). 실패 원인은 현재 `save/setup_result.json` 의 슬롯 centering 데이터가 비어 있는 것.

**그 외 red 없음.** 신규 `test/presetInfoMigration.test.ts` 4 tests 전부 green.

### 4.3 설계서 §7 성공조건 대응
| ID | 항목 | 결과 |
|---|---|---|
| T0 | tsc 0 에러 | ✅ |
| T1 | 신규 스키마(preset_info 존재/preset_pos 부재, preset_name·place_id 컬럼, 6테이블 목록) | ✅ `sqliteStore.test.ts` + `presetInfoMigration.test.ts` |
| T2 | upsertPresetInfo 왕복(preset_name/place_id 기본1/round5, ON CONFLICT 멱등) | ✅ |
| T3 | 마이그레이션(리네임·컬럼·데이터 보존·FK 추종·멱등) | ✅ 신규 테스트 4건 |
| T4 | FK 무결성(부모 없는 slot_setup INSERT → throw+롤백) | ✅ |
| T5 | migrate 도구 `count('preset_info')` | ✅ |
| T6 | 전량 회귀 + JSON 픽스처 `sname` 불변 | ✅ (buildTouringPlan 2건 기준선 예외) |
| T7 | slot3dFrontCenter 레거시 마이그레이션 라운드트립 | ✅ green |

---

## 5. 후속(문서화 담당 전달 사항)

- `/db/tables` 뷰어 노출 테이블명이 `preset_pos` → `preset_info` 로 바뀐다(코드 변경 없이 동작만 변화).
- `docs/` 하위 기존 문서(`20260718_012723_DB스키마전면개편_LLM최소화.md`, `SETUP_GUIDE_초기셋팅.md` 등)의 `preset_pos` 표기는 **이번 범위 밖**이라 손대지 않았다 — 문서 갱신 필요 여부 판단 요망.
- 외부 JSON 계약(`camerapos.json` 의 `sname`)은 불변이므로 Unity/시뮬레이터 측 영향 없음.
