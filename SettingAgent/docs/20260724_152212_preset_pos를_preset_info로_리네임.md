# `preset_pos` → `preset_info` DB 스키마 리팩토링

- 작성: 문서화 담당(documenter)
- 작성 시각: 2026-07-24 15:22:12
- 브랜치: `feature/preset-pos-to-info` (메인 리포, 워크트리 아님)
- 코드 루트: `d:\Work\Parking3D\AgentVLA\ParkAgent\SettingAgent`
- 종합 근거: `_workspace_preset_info/01_architect_plan.md`(설계) · `02_developer_changes.md`(구현) · `03_qa_report.md`(적대적 검증) + 실제 `git diff`

---

## 1. 변경 배경

정본 스키마 문서 `Docs/MyThink/my_db_table.md` §4 `preset_info`가 `{ preset_id, preset_name, cam_id, pos(P,t,z), place_id }`로 정의되어 있는 반면, 실제 코드의 DB 테이블명은 옛 이름 `preset_pos`, 라벨 컬럼은 `sname`이었고 `place_id` 컬럼이 아예 없었다. 이번 작업은 코드를 정본 문서의 명명·스키마에 맞춰 정합시키는 **순수 DDL/DAO/타입 리팩토링**이다(신규 기능 없음).

`pos(P,t,z)`는 정본 문서상 개념적 표기이며, 실제로는 기존과 동일하게 `pan/tilt/zoom` REAL 3컬럼을 그대로 유지한다(신규 JSON `pos` 컬럼을 만들지 않음 — 리더 확정 사항).

---

## 2. 스키마 Before / After

| 구분 | Before(`preset_pos`) | After(`preset_info`) |
|---|---|---|
| 테이블명 | `preset_pos` | `preset_info` |
| 라벨 컬럼 | `sname TEXT` | `preset_name TEXT` |
| 장소 컬럼 | (없음) | `place_id INTEGER NOT NULL DEFAULT 1`(신규 CREATE 경로만 `REFERENCES place_info(place_id)` 부여) |
| PTZ 컬럼 | `pan/tilt/zoom REAL NOT NULL` | 동일(불변) |
| PK | `(cam_id, preset_id)` | 동일(불변) |
| `slot_setup` FK 부모 | `preset_pos(cam_id, preset_id)` | `preset_info(cam_id, preset_id)` |

**신규(CREATE) DDL**(`SqliteStore.ts` `ensureSchema()`):
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

---

## 3. 마이그레이션 3단계 DDL과 멱등성 보장 방식

신규 private 메서드 `SqliteStore.migratePresetPosToInfo()`가 `ensureSchema()` **맨 앞**(CREATE 블록보다 먼저)에서 호출된다. 순서를 뒤집은 이유: 기존 순서(CREATE→ALTER)를 그대로 두면, 기존 DB(`preset_pos` 보유)에서 `CREATE TABLE IF NOT EXISTS preset_info`가 먼저 실행돼 빈 `preset_info`가 생성되고, 뒤이은 `ALTER TABLE preset_pos RENAME TO preset_info`가 "이미 존재" 에러로 실패한다. 신규 DB에서는 `preset_pos`도 `preset_info`도 없으므로 이 마이그레이션은 no-op이 되고, 뒤따르는 CREATE가 완비된 스키마를 만든다.

각 단계는 **현재 상태를 조회해 필요할 때만 실행**하는 조건부 가드로 멱등성을 보장한다(재오픈해도 무변경·무오류):

```sql
-- 1) 테이블 리네임: sqlite_master 에 preset_pos 有 && preset_info 無 일 때만 실행.
--    SQLite 3.25+(legacy_alter_table 미설정) RENAME TO 는 slot_setup의 FK 참조를
--    preset_info 로 자동 추종한다.
ALTER TABLE preset_pos RENAME TO preset_info;

-- 2) 컬럼 리네임: PRAGMA table_info(preset_info) 에 sname 有 && preset_name 無 일 때만 실행.
ALTER TABLE preset_info RENAME COLUMN sname TO preset_name;

-- 3) place_id 추가: PRAGMA table_info(preset_info) 에 place_id 無 일 때만 실행.
--    foreign_keys=ON 상태에서 REFERENCES 절이 있는 컬럼을 ADD COLUMN 하려면
--    기본값이 반드시 NULL 이어야 한다는 SQLite 제약과, place_id 가 NOT NULL DEFAULT 1
--    이어야 한다는 요구가 충돌 → 마이그레이션 경로에서는 REFERENCES 절을 생략한다.
ALTER TABLE preset_info ADD COLUMN place_id INTEGER NOT NULL DEFAULT 1;
```

각 단계는 `sqlite_master`/`PRAGMA table_info` 조회 결과로 조건을 판단하므로, 이미 일부만 진행된 중간 상태(예: 테이블만 리네임되고 컬럼은 아직 `sname`인 상태)에서 재오픈해도 남은 단계만 이어서 수행되고 완료된 단계는 다시 실행되지 않는다.

**수용된 divergence**: 위 제약 때문에 신규 CREATE 경로의 `preset_info.place_id`에는 `place_info(place_id)` FK가 있는 반면, 마이그레이션 경로로 생긴 `preset_info.place_id`에는 FK가 없다. `place_id` 값이 항상 1이고 `place_info(1)`이 상존하므로 실질적 참조 무결성은 유지된다는 판단 하에 리더가 수용했다(기존 `slot3d_front_center` ALTER 선례와 일관, 테이블 재빌드 방식은 복잡도 상 미채택).

---

## 4. 타입·메서드 리네임 매핑표

| 구분 | Before | After |
|---|---|---|
| 타입(interface) | `PresetPosRow` | `PresetInfoRow` |
| 필드 | `sname: string \| null` | `presetName: string \| null` |
| 필드(신규) | — | `placeId: number`(required — 형제 `CameraInfoRow.placeId`와 동일하게 optional 미채택) |
| upsert 메서드 | `SqliteStore.upsertPresetPos(rows: PresetPosRow[])` | `SqliteStore.upsertPresetInfo(rows: PresetInfoRow[])` |
| 마이그레이션 도구 호출 | `store.upsertPresetPos(presets)` | `store.upsertPresetInfo(presets)` |
| `roiDbLoad.ts` 빌더 반환타입 | `PresetPosRow[]` | `PresetInfoRow[]`(`buildPresetsFromRoi`, `buildPresets` — 함수명은 유지) |

수정 파일(소스 5개): `src/capture/SqliteStore.ts`, `src/capture/types.ts`, `src/capture/roiDbLoad.ts`, `src/tools/migrateToSettingDb.ts`, `src/api/captureRoutes.ts`(L452 주석 1줄만).

---

## 5. `sname` 이중 문맥과 처리 원칙

`sname`이라는 이름은 이번 리팩토링 전후로 **두 개의 서로 다른 문맥**에서 쓰여 왔고, 문맥에 따라 다르게 처리했다.

1. **DB 컬럼 / Row 필드(변경 대상)**: `preset_pos.sname` 컬럼과 `PresetPosRow.sname` 필드는 각각 `preset_info.preset_name`, `PresetInfoRow.presetName`으로 리네임했다.
2. **외부 JSON 파일의 키(불변 대상)**: `config/camerapos.json`의 `datas[].sname` 키는 **외부 계약**이므로 그대로 둔다. 쓰기 측(`src/setup/cameraposWriter.ts` `sname: v.label`)과 읽기 측(`src/setup/mapTargets.ts` `v.sname`/`g.sname`)은 전혀 손대지 않았다.

경계 번역은 `roiDbLoad.ts`의 Row 빌더에서 한 지점으로 모았다: JSON을 읽는 **우변**은 `p.sname`/`p?.sname` 그대로 두고, Row 리터럴의 **좌변**만 `presetName: label`로 바꿔 매핑한다. 처리 원칙은 "일괄 치환 금지, 문맥별 수동 판별"이며, 검증자가 `test/presetInfoMigration.adversarial.test.ts`(적대적 6번 그룹)에서 `cameraposWriter`/`mapTargets` 출력 JSON에 `preset_name`/`presetName` 문자열이 전혀 없고 `sname`만 존재함을 실측으로 확인했다.

---

## 6. 검증 결과 (실제 실행 수치 — 정직 기재)

작업 디렉토리 `SettingAgent`, 검증자가 구현자 보고를 신뢰하지 않고 직접 재현.

- **`npx tsc --noEmit`** → 출력 0줄, exit code 0(에러 0건).
- **`npx vitest run`(적대적 테스트 추가 후, 최종)** → **2680 passed / 4 failed**(Test Files 2 failed | 227 passed(229)).
  - 실패 4건:
    - `test/buildTouringPlan.test.ts` 2건 — 기준선 red. `web/core.js`의 `buildTouringPlan`과 라이브 데이터 `save/setup_result.json`만 사용(SqliteStore·preset 테이블 미사용, 두 파일 모두 이번 작업에서 미변경). 근본 원인은 `save/setup_result.json`의 슬롯 23건 중 `centering` 비-null이 0건인 라이브 데이터 결손 — 이번 변경과 무관.
    - `test/setupResultRoute.test.ts` 2건 — 세션 도중 제3자가 `web/app.js`·`web/index.html`을 동시 수정(`#cal-result-file` 버튼·결선 삭제)해 발생. preset 코드와 무접촉이며 이번 변경과 무관. **본 문서화 대상에서 제외**(작업 지시에 따라 `web/` 변경은 무관한 제3자 변경으로 취급).
  - 이 4건을 제외한 나머지는 전량 green.
- **신규 테스트**: `test/presetInfoMigration.test.ts`(4건) + `test/presetInfoMigration.adversarial.test.ts`(23건) = **27건 전량 green**. 멱등성(3회 재오픈)·바이트 단위 데이터 보존·FK 자동 추종 실증·`place_id` 기본값/FK divergence·부분 마이그레이션 중간 상태 4종·`sname` 경계 회귀 없음·renumber 무영향·DB 뷰어 노출명 전환을 실측으로 덮는다.
- 검증자는 실 운영 DB(`data/setting.sqlite`)와 마이그레이션 전 백업본을 직접 열어 `preset_pos→preset_info`, `sname→preset_name`, `slot_setup` FK 추종을 합성 테스트 밖에서도 실물로 확인했다.

---

## 7. 한계 (검증하지 못한 항목 — 위장 금지)

검증자가 명시한 한계를 그대로 인용한다.

1. 실 운영 DB의 "non-null 라벨 보존"은 합성 테스트로만 증명했다. 운영 DB의 `preset_name`은 마이그레이션 **이전부터 이미 NULL**이었다(§8 F1 참조 — 이번 변경의 회귀가 아님).
2. 실서비스 기동(Play Mode 상당) 스모크 — `/capture/start`·`/slots/load-roi` 등 라이브 라우트를 실제 프로세스로 태우는 검증은 수행하지 않았다. 순수 DDL/DAO/타입 리네임이라 유닛 레벨로 충분하다고 판단했으나 스모크 자체는 누락이다.
3. 두 프로세스가 같은 파일 DB를 동시에 처음 여는 동시성 마이그레이션 경합은 검증하지 않았다(`migratePresetPosToInfo()`는 트랜잭션으로 감싸여 있지 않고 각 ALTER가 개별 자동 커밋).
4. 대용량 DB에서의 마이그레이션 시간·잠금 영향은 미측정(운영 DB가 5행/23행 규모라 의미 없음).
5. `docs/` 하위 기존 산문 문서(`20260718_012723_DB스키마전면개편_LLM최소화.md` 등)의 `preset_pos` 표기 갱신 여부는 이번 범위 밖으로 판단해 손대지 않았다.

---

## 8. 잔여 과제 (수정하지 않음 — 리더 판정)

| ID | 내용 | 처리 |
|---|---|---|
| F1 | `preset_name`이 운영 경로에서 항상 NULL로 덮어써짐. `loadRoiIntoDb`가 `camerapos.json` 라벨 upsert 직후, 라벨 없는 ROI 유래 프리셋을 `ON CONFLICT ... SET preset_name=excluded.preset_name`으로 재upsert해 라벨을 말소하는 구조. 운영 DB 해당 행 `updated_at`이 마이그레이션 실행 시각보다 하루 앞서 있어(2026-07-23), 마이그레이션이 이미 NULL이던 값을 그대로 보존했을 뿐임을 확인. **선재 결함, 이번 리팩토링의 회귀 아님 → 이번 범위 밖, 미수정.** 필요 시 `ON CONFLICT`를 `preset_name = COALESCE(excluded.preset_name, preset_name)`로 바꾸는 등 별도 설계 결정 필요. |
| F4 | `preset_pos`와 `preset_info`가 동시에 존재하는 상태에서 마이그레이션을 실행하면(리네임 조건이 `preset_pos 有 && preset_info 無`이므로) 리네임을 건너뛰고 `preset_info`만 정비하며, `preset_pos`의 행은 무경고로 미이관된다. 발생 경로 현실성 낮음(신규 코드가 빈 `preset_info`를 먼저 만들 수 없는 순서). **수용, 잔여과제로 기록.** |

---

## 9. 마스터 확인 요청

- **정본 문서 `Docs/MyThink/my_db_table.md`에 §2 `preset_pos`와 §4 `preset_info`가 공존**하며 항목 번호도 `4. preset_info`/`4. place_info`로 중복되어 있다. 이번 리네임으로 §2 `preset_pos`는 §4 `preset_info`에 통합된 것이므로 정본 문서 갱신이 필요하나, 마스터의 정본 설계 문서라 **임의 편집하지 않았다**. 갱신 여부·방식은 마스터 확인 후 진행을 권고한다.
