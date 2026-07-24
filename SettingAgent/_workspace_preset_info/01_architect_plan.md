# 설계서 — DB 테이블 `preset_pos` → `preset_info` 리네임 + 누락 필드 추가 + 사용처 전수 수정

- 작성: 설계자(architect)
- 브랜치: `feature/preset-pos-to-info` (메인 리포)
- 코드 루트: `d:\Work\Parking3D\AgentVLA\ParkAgent\SettingAgent`
- 정본 스키마: `d:\Work\Parking3D\AgentVLA\ParkAgent\Docs\MyThink\my_db_table.md` §4 preset_info = { preset_id, preset_name, cam_id, pos(P,t,z), place_id }
- 실행 모드: **A. 선형 파이프라인**(tsc 0 + vitest 전량 green + 신규 마이그레이션 테스트로 성공 확정 가능한 명확한 기계적 작업)

---

## 0. 확정 사항 요약(마스터/리더 — 재결정 금지)

1. 테이블명 `preset_pos` → `preset_info`
2. 컬럼 `sname` → `preset_name`
3. 컬럼 `place_id INTEGER NOT NULL DEFAULT 1 REFERENCES place_info(place_id)` 신규 추가(현재 항상 1)
4. `pos`는 기존 `pan/tilt/zoom` REAL 3컬럼 유지(신규 JSON pos 컬럼 만들지 말 것)
5. **camerapos.json 등 외부 JSON 파일의 `sname` 키는 변경 금지.** DB 컬럼만 `preset_name`. JSON→Row 매핑에서 `json.sname → row.presetName` 번역만 수행

---

## 1. 결정적 기술 제약(반드시 반영 — 근거 확인 완료)

### 1.1 CREATE 전에 rename 마이그레이션이 선행되어야 한다 (순서 역전)
현재 `ensureSchema()`는 **CREATE(신규) → ALTER(마이그레이션)** 순서다(SqliteStore.ts:42~137).
그러나 이번 건은 **테이블 리네임**이라 이 순서를 그대로 두면 깨진다:

- 기존 DB(`preset_pos` 보유)에서 `CREATE TABLE IF NOT EXISTS preset_info (...)`를 먼저 실행하면
  → `preset_info`가 아직 없으므로 **빈 preset_info를 새로 생성** → 이후 `ALTER TABLE preset_pos RENAME TO preset_info`가 "이미 존재" 에러로 실패.

**해결:** 테이블/컬럼 리네임 마이그레이션은 **CREATE 블록보다 먼저** 실행한다.
신규 DB에서는 `preset_pos`도 `preset_info`도 없으므로 마이그레이션은 no-op → 이어지는 CREATE가 완비된 스키마를 만든다. (멱등)

### 1.2 `foreign_keys=ON` + `ADD COLUMN ... REFERENCES` + `NOT NULL DEFAULT 1` 는 동시 불가
SQLite `ALTER TABLE ADD COLUMN` 규칙:
- NOT NULL 컬럼은 **NULL 아닌 기본값**을 가져야 한다(→ `DEFAULT 1` 충족).
- **foreign_keys 활성 상태에서 REFERENCES 절이 있는 컬럼을 ADD 하면 기본값이 반드시 NULL이어야 한다.**

두 규칙이 충돌 → 마이그레이션 경로의 `ADD COLUMN place_id`에는 **REFERENCES 절을 넣을 수 없다.**
→ 마이그레이션은 `ALTER TABLE preset_info ADD COLUMN place_id INTEGER NOT NULL DEFAULT 1` (REFERENCES 없음)으로 한다.
→ **신규(CREATE) 경로**는 확정 사항 3대로 `place_id INTEGER NOT NULL DEFAULT 1 REFERENCES place_info(place_id)` 유지.

**결과 divergence(수용):** 신규 DB의 preset_info.place_id 에는 FK 제약이 있고, 마이그레이션된 기존 DB에는 없다.
- 수용 근거: place_id는 항상 1이고 place_info(1)이 항상 존재하므로 실질 참조 무결성은 유지된다. 기존 slot3d_front_center ALTER 선례(제약 없이 ADD)와 일관. `단순함 우선`.
- FK 완전 동치가 꼭 필요하면 대안(테이블 재빌드 create-new→copy→drop→rename, 또는 마이그레이션 중 일시 `PRAGMA foreign_keys=OFF`)이 있으나 복잡도↑ → **채택하지 않음**(리더 재지정 시에만).

### 1.3 `RENAME TO` 의 FK 자동 추종
SQLite 3.25.0+ (better-sqlite3 번들 버전, `legacy_alter_table` 기본 OFF)에서
`ALTER TABLE preset_pos RENAME TO preset_info` 는 **자식 테이블(slot_setup)의 FK 정의 참조를 자동으로 `preset_info`로 갱신**한다.
- 코드가 `legacy_alter_table`를 ON으로 설정하는 곳은 없음(확인 완료) → 자동 추종 신뢰 가능.
- 컬럼 리네임 `sname → preset_name`은 어떤 FK도 이 컬럼을 참조하지 않으므로(slot_setup FK는 cam_id,preset_id) 추종 이슈 없음.
- ⚠️ 검증 필수(경험적): 신규 마이그레이션 테스트에서 **slot_setup FK를 실제로 건 레거시 DB**를 만들고, 오픈 후 slot_setup INSERT가 preset_info를 부모로 정상 통과하는지 확인(§7-T3).

---

## 2. 구현 단계 (검증 기준 포함)

### 단계 1 — `src/capture/SqliteStore.ts` DDL + 마이그레이션 + 메서드
1. **import**(L7): `PresetPosRow` → `PresetInfoRow`.
2. **ensureSchema 순서 재구성**(L42~137):
   - `ensureSchema()` 맨 앞에 신규 `this.migratePresetPosToInfo();` 호출을 추가(**CREATE exec 이전**).
   - CREATE 블록(L70~80)의 `preset_pos` 테이블을 아래로 교체:
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
     ```
   - slot_setup FK(L101~102) `REFERENCES preset_pos(cam_id, preset_id)` → `REFERENCES preset_info(cam_id, preset_id)`.
   - 기존 slot3d_front_center ALTER(L133~136)는 **그대로 유지**(CREATE 이후).
3. **신규 private 메서드 `migratePresetPosToInfo()`** 추가(멱등, CREATE 이전 호출):
   ```ts
   /** 멱등 마이그레이션: 구 preset_pos → preset_info(테이블/컬럼 리네임 + place_id 추가). 신규 DB 는 no-op. */
   private migratePresetPosToInfo(): void {
     const tableNames = () =>
       (this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[])
         .map((t) => t.name);
     let names = tableNames();
     // 1) 테이블 리네임(구 preset_pos 만 있고 preset_info 부재). RENAME TO 가 slot_setup FK 참조를 자동 추종.
     if (names.includes('preset_pos') && !names.includes('preset_info')) {
       this.db.exec(`ALTER TABLE preset_pos RENAME TO preset_info`);
       names = tableNames();
     }
     // 2) 컬럼 마이그레이션(preset_info 존재 시에만 — 신규 DB 는 이 블록 진입 전 CREATE 가 완비).
     if (names.includes('preset_info')) {
       const cols = (this.db.prepare(`PRAGMA table_info(preset_info)`).all() as { name: string }[]).map((c) => c.name);
       if (cols.includes('sname') && !cols.includes('preset_name')) {
         this.db.exec(`ALTER TABLE preset_info RENAME COLUMN sname TO preset_name`);
       }
       if (!cols.includes('place_id')) {
         // ★ FK ON + REFERENCES + NOT NULL DEFAULT 동시 불가(§1.2) → REFERENCES 없이 추가.
         this.db.exec(`ALTER TABLE preset_info ADD COLUMN place_id INTEGER NOT NULL DEFAULT 1`);
       }
     }
   }
   ```
4. **upsertPresetPos → upsertPresetInfo**(L177~191): 주석 헤더 `preset_pos`→`preset_info`, 파라미터 타입 `PresetPosRow[]`→`PresetInfoRow[]`, INSERT/ON CONFLICT 갱신:
   ```sql
   INSERT INTO preset_info (cam_id, preset_id, preset_name, place_id, pan, tilt, zoom, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(cam_id, preset_id) DO UPDATE SET
     preset_name=excluded.preset_name, place_id=excluded.place_id,
     pan=excluded.pan, tilt=excluded.tilt, zoom=excluded.zoom, updated_at=excluded.updated_at
   ```
   바인딩: `stmt.run(r.camId, r.presetId, r.presetName, r.placeId, round5(r.pan), round5(r.tilt), round5(r.zoom), r.updatedAt)`.
5. **getPresetKeys**(L195): `FROM preset_pos` → `FROM preset_info` (그 외 로직 불변).

- **검증:** tsc 0. `:memory:` 오픈 시 sqlite_master 에 `preset_info` 존재·`preset_pos` 부재. preset_info PRAGMA 에 `preset_name`·`place_id` 존재. upsertPresetInfo 왕복 시 place_id 기본 1.

### 단계 2 — `src/capture/types.ts`
1. 주석(L5~7): "신 6테이블(... **preset_pos**/...)" → `preset_info`.
2. `PresetPosRow`(L83~92) → `PresetInfoRow`:
   - 필드 `sname: string | null` → `presetName: string | null`
   - 필드 `placeId: number` 신규 추가(CameraInfoRow 와 동일하게 **required** — 형제 테이블 Row 일관성). 위치: presetId 다음 또는 zoom 다음(권장: presetName 다음).
   - JSDoc 의 "preset_pos 행" → "preset_info 행".

- **검증:** tsc 0(다운스트림 import 오류가 후속 단계에서 모두 해소될 때까지 반복).

> 판단(설계자): `placeId`를 **required**로 둔다. 근거 — 형제 `CameraInfoRow.placeId`가 이미 required이고, DB 컬럼도 NOT NULL. optional(`?` + upsert `?? 1`)은 요청 없는 유연성(단순함 원칙 위배). 대신 테스트/빌더 리터럴에 `placeId: 1` 명시 추가가 필요(기계적).

### 단계 3 — `src/capture/roiDbLoad.ts`
JSON 키 읽기(우변 `p.sname`)는 **유지**, Row 필드(좌변/접근)만 변경. 각 빌더에 `placeId: PLACE_ID` 추가.
1. import(L16): `PresetPosRow` → `PresetInfoRow`(SlotSetupRow/CameraInfoRow 병기 유지).
2. `buildPresetsFromRoi`(L60~88): 반환타입 `PresetInfoRow[]`. push(L84) `sname: label` → `presetName: label`, `placeId: PLACE_ID` 추가.
3. `loadSetupTargetsFromRoi`(L108): Row 필드 접근 `p.sname` → `p.presetName`.
4. `roiToCameraViews`(L123): Row 필드 접근 `p.sname` → `p.presetName`.
5. `buildPresets`(L131~155): 반환타입 `PresetInfoRow[]`. push(L146) 좌변 `sname:` → `presetName:`(우변 `p?.sname`은 camerapos JSON 키 → **유지**), `placeId: PLACE_ID` 추가.
6. `loadRoiIntoDb`:
   - 변수타입 `let presets: PresetPosRow[]`(L252) → `PresetInfoRow[]`.
   - `store.upsertPresetPos(...)` 3곳(L267, L272, L294) → `store.upsertPresetInfo(...)`.
   - 자리표시자(L288~291): `sname: \`C${camId}-P${presetId} (PTZ 미상)\`` → `presetName: ...`, `placeId: PLACE_ID` 추가.
   - 주석 내 `preset_pos`(L251, L260, L276, L280, L296, L301, L312, L315) 표현은 정확성 위해 `preset_info`로 갱신(문자열/주석만, 로직 불변).

- **검증:** tsc 0. roiDbLoad 관련 테스트 green(§7).

### 단계 4 — `src/tools/migrateToSettingDb.ts`
1. 주석 매핑표(L11): `preset_pos ← camerapos ...(... sname ...)` → `preset_info ← camerapos ...(... preset_name(=json sname) ...)`.
2. `store.upsertPresetPos(presets)`(L95) → `store.upsertPresetInfo(presets)`.
- `buildPresets` import·함수명은 **유지**(리네임 미지정 — 외과적). 반환타입만 PresetInfoRow[]로 자연 변경.

- **검증:** migrateToSettingDb 실행 시 place/camera/preset/slot 이관 정상. 테스트 §7-T5.

### 단계 5 — 외부 JSON 포맷 코드(변경 여부 판단 결과: **불변**)
확정 사항 5 — JSON 키 `sname`은 계약이므로 그대로 둔다.
- `src/setup/cameraposWriter.ts` L25 `sname: v.label`: camerapos.json **쓰기** 키 → **변경 금지(불변)**.
- `src/setup/mapTargets.ts` L40/L55 `v.sname`·`g.sname`: camerapos.json **읽기** 키 → **변경 금지(불변)**.
- roiDbLoad 의 camerapos/ROI JSON 읽기 우변 `p.sname`/`p.name`(L72,83,139,146 RHS)도 JSON 키 → 유지.

### 단계 6 — 조회/화이트리스트(코드 변경 불필요, 동작 변화만)
- `src/api/dbRoutes.ts`: 테이블 화이트리스트는 `sqlite_master` 동적 조회(L61~102) → **코드 변경 불필요**. 다만 `/db/tables` 노출 목록의 테이블명이 `preset_pos` → `preset_info`로 바뀐다(뷰어 표시 변화 — 문서화 대상).
- `src/api/captureRoutes.ts` L452 주석("slot_setup 은 preset_pos 를 FK 부모로 요구") — 사실 정확성 위해 `preset_info`로 갱신(주석만, **선택적 권장**).

---

## 3. 영향 받는 파일/모듈 (구현자·문서화 전달용)

### src (수정)
| 파일 | 변경 요지 |
|------|-----------|
| `src/capture/SqliteStore.ts` | DDL(preset_info+preset_name+place_id), slot_setup FK, `migratePresetPosToInfo()` 신규, `upsertPresetPos→upsertPresetInfo`, getPresetKeys 테이블명, import |
| `src/capture/types.ts` | `PresetPosRow→PresetInfoRow`(sname→presetName, placeId 추가), 주석 |
| `src/capture/roiDbLoad.ts` | 타입/빌더 Row 필드(presetName·placeId), upsert 호출명 3곳, 주석 |
| `src/tools/migrateToSettingDb.ts` | upsert 호출명, 주석 매핑표 |
| `src/api/captureRoutes.ts` | L452 주석만(선택) |

### src (불변 — JSON 계약)
`src/setup/cameraposWriter.ts`, `src/setup/mapTargets.ts`, `src/api/dbRoutes.ts`.

### test (수정 — 기계적, ~25개)
분류별 변경:
- **타입 import** `PresetPosRow→PresetInfoRow`: `sqliteStore.test.ts`, `sqliteStore.renumber.test.ts`, `renumberRoute.test.ts`, `renumber.adversarial.test.ts`, `roiDbLoad.test.ts`, `captureResetRoutes.test.ts`, `captureLoadRoiRoutes.test.ts`, `clearSlotSetupEnrichment.test.ts`, `setupResultRoute.test.ts`, `slotFrontCenter.test.ts`, `slotLpdDbAdd.test.ts`, `slotOccupyBuild.test.ts`.
- **Row 리터럴/헬퍼** `sname:`→`presetName:` + `placeId: 1` 추가, `upsertPresetPos→upsertPresetInfo`: 위 + `centeringSlot.test.ts`, `centeringBoundary.test.ts`, `dbOverlayParity.test.ts`, `finalizerFloor.test.ts`, `finalizerPreserveDetection.test.ts`, `finalizerParkingSlots.test.ts`, `boundaryCrossCheck.test.ts`, `loadRoiFrontCenterAuto.test.ts`, `slotCuboidRoutes.test.ts`, `parkingSlotsRoutes.test.ts`, `round5.test.ts`.
- **테이블명 raw SQL/단언**: `sqliteStore.test.ts` L73 6테이블 목록 `preset_pos→preset_info`, `migrateToSettingDb.test.ts` L106 `count('preset_pos')→count('preset_info')`, `round5.test.ts` L152 `FROM preset_pos→preset_info`, `roiDbLoad.test.ts` L304·L342 `FROM preset_pos→preset_info`, `roiDbLoad.test.ts` L242 describe 문자열.
- **레거시 DB 시뮬레이션(주의)**: `slot3dFrontCenter.test.ts` L207~218 은 구 `preset_pos`를 직접 CREATE 하는 **레거시 픽스처**다. 이제 SqliteStore 오픈 시 마이그레이션이 이를 `preset_info`로 리네임한다 → 기존 단언(slot_setup 행 보존)은 여전히 통과해야 함. **이 테스트의 레거시 CREATE 는 preset_pos 그대로 두어 마이그레이션 입력으로 활용**(수정하지 말 것). 단, 이 픽스처의 slot_setup 은 FK 미부여 형태이므로 FK 추종 검증은 별도 신규 테스트(§7-T3)에서 수행.

### test (불변 — JSON 키 `sname` 유지)
`cameraposSource.test.ts`, `mapTargets.test.ts`, `test/fixtures/camerapos.*.json`, 그리고 각 테스트 안의 camerapos/ROI **JSON 리터럴**의 `sname` 키(예: `captureLoadRoiRoutes.test.ts`의 camerapos writeFileSync, `roiDbLoad.test.ts`의 camerapos datas). → JSON 키이므로 **변경 금지**. (변경 대상은 오직 `PresetInfoRow` 객체 리터럴의 필드명)

> 구현 시 주의: `sname` 은 (a) DB Row 필드(변경) 와 (b) 외부 JSON 키(유지) 두 문맥에 공존한다. 일괄치환 금지 — 문맥별 수동 판별 필수.

---

## 4. MCP 도구 vs LLM 두뇌 경계 판단
해당 없음. 순수 **결정형 스키마/DAO 리팩토링**(DDL·타입·SQL 문자열·테스트). LLM 두뇌·MCP 실시간 루프와 무관.

---

## 5. 마이그레이션 DDL 스니펫 (최종)

신규(CREATE) 경로:
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
-- slot_setup FK:
FOREIGN KEY (cam_id, preset_id) REFERENCES preset_info(cam_id, preset_id)
```

기존(마이그레이션) 경로 — CREATE 이전, 멱등:
```sql
-- 1) 테이블 리네임(FK 자동 추종)
ALTER TABLE preset_pos RENAME TO preset_info;          -- preset_pos 有 & preset_info 無 일 때만
-- 2) 컬럼 리네임
ALTER TABLE preset_info RENAME COLUMN sname TO preset_name;  -- sname 有 & preset_name 無 일 때만
-- 3) place_id 추가(REFERENCES 절 없음 — §1.2 제약)
ALTER TABLE preset_info ADD COLUMN place_id INTEGER NOT NULL DEFAULT 1;  -- place_id 無 일 때만
```

---

## 6. 리스크 / 미해결 · 가정

| 항목 | 판단 | 대응 |
|------|------|------|
| RENAME TO 의 slot_setup FK 자동 추종 | 3.25+/legacy_alter_table OFF 기본 → 신뢰. 코드가 OFF를 안 바꿈 | §7-T3 경험적 검증(FK 부여 레거시→INSERT 통과) |
| ADD COLUMN place_id REFERENCES 불가(FK ON) | 확정 제약 → 마이그레이션은 REFERENCES 생략 | 신규 vs 마이그레이션 place_id FK divergence **수용**(값 항상 1, place_info(1) 상존) |
| ensureSchema 순서(CREATE→ALTER) | 리네임엔 부적합 → **마이그레이션을 CREATE 이전으로** | 단계 1-2/1-3 반영 |
| `sname` 이중 문맥(DB필드 vs JSON키) | 일괄치환 시 JSON 계약 파손 위험 | §3 "일괄치환 금지" 명시, 문맥별 수동 |
| placeId Row 필드 required 채택 | 형제 CameraInfoRow 일관·NOT NULL DB | 테스트 리터럴 `placeId:1` 추가 churn 감수(기계적) |
| 기존 파일 DB(data/setting.sqlite) 실물 | 첫 오픈 시 자동 마이그레이션 — 데이터 보존 | 백업 권장(문서화가 안내). 실 파일은 커밋 대상 아님 |

**가정:** better-sqlite3 번들 SQLite ≥ 3.25.0(RENAME COLUMN·FK 추종 지원). 구현 단계에서 마이그레이션 테스트가 실패하면 이 가정 재검토(대안: 테이블 재빌드 방식).

**미해결 질문(리더 확인 — 진행은 기본안으로):** place_id FK divergence(마이그레이션 DB에 place_id FK 미부여)를 수용하는가? 기본안=수용(단순함). 엄격 동치 필요 시에만 재빌드 방식으로 전환.

---

## 7. 검증 기준 (qa-tester 성공조건)

- **T0 tsc:** `npx tsc --noEmit` 0 에러.
- **T1 스키마(신규):** `:memory:` 오픈 → sqlite_master 에 `preset_info` 존재·`preset_pos` 부재. PRAGMA table_info(preset_info) 에 `preset_name`·`place_id` 존재. 6테이블 목록 단언(sqliteStore.test.ts L73) `preset_info` 반영.
- **T2 upsert 왕복:** upsertPresetInfo → raw SELECT 로 `preset_name`·`place_id`(기본 1)·pan/tilt/zoom(round5) 확인. ON CONFLICT 갱신(멱등) 확인.
- **T3 마이그레이션(신규 테스트 추가 권장):** 파일 DB 로 **구 preset_pos(sname, place_id 없음) + slot_setup FK→preset_pos** 를 raw 로 시드 → SqliteStore 오픈 → (a) preset_info 리네임 완료, (b) preset_name 컬럼 존재·기존 라벨 보존, (c) place_id 컬럼 존재·기존 행 기본값 1, (d) preset_pos 부재, (e) slot_setup 행/데이터 보존 + preset_info 를 부모로 한 slot_setup INSERT 정상(FK 추종 실증). **멱등**: 재오픈 시 무변경·무오류.
- **T4 FK 무결성:** 부모(preset_info) 없는 slot_setup INSERT → throw + 롤백(기존 sqliteStore.test.ts L100 계승, 테이블명만 갱신).
- **T5 migrate 도구:** migrateToSettingDb 실행 후 `count('preset_info')` 일치(테스트 L106 갱신).
- **T6 전량 회귀:** 기존 vitest 전량 green(≈이전 통과 수 유지). JSON 픽스처 `sname` 불변 확인(cameraposSource/mapTargets green).
- **T7 라운드트립 파일 DB:** slot3dFrontCenter 레거시 마이그레이션 테스트(L202~235) green(이제 preset_pos→preset_info 리네임 경유).

---

## 8. 구현 순서 권장(선형)
1. types.ts (PresetInfoRow) → 2. SqliteStore.ts (DDL+migrate+upsert) → 3. roiDbLoad.ts → 4. migrateToSettingDb.ts → 5. 테스트 전량 갱신 + T3 신규 → 6. tsc 0 → 7. vitest green.
각 단계 후 `npx tsc --noEmit` 로 다운스트림 타입오류를 좁혀가며 진행.
