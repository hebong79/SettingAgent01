# 영향도 분석 — `preset_pos` → `preset_info` DB 스키마 리팩토링

- 작성: 문서화 담당(documenter)
- 작성 시각: 2026-07-24 15:22:12
- 최종 문서: `SettingAgent/docs/20260724_152212_preset_pos를_preset_info로_리네임.md`
- 근거: `01_architect_plan.md` §3(영향 받는 파일) · `02_developer_changes.md` §2 · `03_qa_report.md` §2/§3/§4 + 실제 `git diff`

---

## 1. 영향 받는 모듈·의존성

### 1.1 직접 수정된 소스(5개)
| 파일 | 변경 요지 | 파급 |
|---|---|---|
| `src/capture/SqliteStore.ts` | DDL(`preset_info`+`preset_name`+`place_id`), `slot_setup` FK 부모 변경, 신규 private `migratePresetPosToInfo()`, `upsertPresetPos→upsertPresetInfo`, `getPresetKeys()` 테이블명 | 이 파일을 import하는 모든 곳(`roiDbLoad.ts`, `migrateToSettingDb.ts`, `captureRoutes.ts`, 다수 테스트)이 새 메서드명/타입명을 따라가야 함(기계적, 전량 반영 확인됨) |
| `src/capture/types.ts` | `PresetPosRow → PresetInfoRow`(`sname→presetName`, `placeId` 신규 required 필드) | 이 타입을 쓰는 모든 파일의 타입 임포트 변경 필요(전량 반영 확인됨) |
| `src/capture/roiDbLoad.ts` | 빌더 반환타입/Row 필드/`upsertPresetInfo` 호출 3곳 | `/slots/load-roi`, `/capture/start` 등 ROI 적재 경로의 내부 구현만 변화, REST 응답 계약 불변 |
| `src/tools/migrateToSettingDb.ts` | `upsertPresetInfo` 호출, 매핑 주석 | 구 10테이블→신 6테이블 마이그레이션 CLI 도구, 이관 대상 테이블명만 변경 |
| `src/api/captureRoutes.ts` | L452 주석 1줄만(사실 정확성) | 로직 변경 없음 |

### 1.2 REST 계약 영향
- **`GET /db/tables`(DB 뷰어)**: 노출 테이블 목록이 `sqlite_master` 동적 조회이므로 코드 변경은 불필요했으나, **노출되는 테이블명이 `preset_pos → preset_info`로 바뀐다.** `GET /db/table/preset_pos`는 이제 404, `GET /db/table/preset_info`가 유효 경로다. DB 뷰어 프런트(`web/`)가 테이블명을 하드코딩하지 않고 동적 목록을 그리는 구조라면 클라이언트 코드 변경은 불필요 — 다만 사용자가 북마크/직접 호출한 `preset_pos` 경로는 깨진다.
- 그 외 `/capture/*`, `/slots/*` 등 기존 REST 엔드포인트의 **요청/응답 바디 계약은 불변**이다(내부 DAO 구현만 교체).

### 1.3 공유 도메인 타입 파급
- `PresetInfoRow`는 `SettingAgent/src/capture/types.ts`에 국한된 내부 타입이며 `@parkagent/types`(공유 패키지)에는 존재하지 않는다. 따라서 **ActionAgent/DMAgent 등 타 에이전트로의 파급은 없다** — 검증자가 ParkAgent 타 서비스·Unity `Assets/Scripts` C# 코드 전수 grep으로 소비자 없음을 확인(`03_qa_report.md` §2 항목7).
- `SlotState`/`ParkingEvent` 등 도메인 이벤트 타입은 이번 변경과 무관(건드리지 않음).

### 1.4 테스트 파급(기계적, ~26개)
설계서 §3에 열거된 타입 import 교체(12개 파일) + Row 리터럴/헬퍼 변경(11개 파일) + raw SQL/테이블명 단언 갱신(5개 파일) + 신규 2개 파일(`presetInfoMigration.test.ts`, `presetInfoMigration.adversarial.test.ts`)이 실제 `git diff`로 확인됨. `test/slot3dFrontCenter.test.ts`의 레거시 `CREATE TABLE preset_pos ... sname ...` 픽스처는 **의도적으로 그대로 유지**되어 마이그레이션 입력(라운드트립 검증)으로 재활용된다.

---

## 2. 외부 계약 불변 확인

`config/camerapos.json` 등 외부 JSON 파일의 **`sname` 키는 변경되지 않았다.**
- 쓰기: `src/setup/cameraposWriter.ts`(`sname: v.label`) — 무변경.
- 읽기: `src/setup/mapTargets.ts`(`v.sname`/`g.sname`) — 무변경.
- 픽스처: `test/fixtures/camerapos.*.json` 및 각 테스트 내 camerapos/ROI JSON 리터럴 — 무변경.

검증자가 `cameraposWriter.writeCamerapos` 실제 출력 JSON을 검사해 `sname` 키만 존재하고 `preset_name`/`presetName` 문자열이 전혀 없음을 실측 확인했고, 반증 대조군(키를 `preset_name`으로 바꾸면 라벨 복원이 `Preset 2` 같은 폴백으로 깨짐)까지 통과시켰다. **Unity/시뮬레이터 등 이 JSON을 소비하는 외부 클라이언트에 영향 없음.**

---

## 3. 운영 영향

- `data/setting.sqlite`는 **SettingAgent 첫 기동 시 `ensureSchema()` 경로에서 자동 마이그레이션**된다. `migratePresetPosToInfo()`가 `ALTER TABLE preset_pos RENAME TO preset_info` → 컬럼 리네임 → `place_id` 추가를 조건부·멱등으로 수행하며, **되돌리는 코드(롤백 마이그레이션)는 없다.**
- 백업본: `data/setting.sqlite.bak-presetinfo-20260724_145745`(+ `-wal`, `-shm` 동반). **WAL 포함 여부가 복구 완전성에 필수적이다** — 검증자가 확인한 바, 마이그레이션 직전 WAL은 약 3.13MB였고 WAL 없이 메인 파일만 복원하면 그 시점 이후 미체크포인트 변경분(운영 DB 기준 `preset_pos` 3행/`slot_setup` 17행 → 현재 5행/23행 차이)이 소실된다. 이번 백업은 WAL/shm을 동반 생성해 **F5(백업 WAL 누락) 조치 완료** 상태다.
- 실 운영 DB 대조(검증자 실측, `03_qa_report.md` §3): 마이그레이션 후 프리셋 테이블 `preset_info`, 라벨 컬럼 `preset_name`, `place_id`(FK 없음 — 마이그레이션 경로 divergence 실물), `slot_setup` FK가 `preset_info`로 자동 추종됨을 확인. 컬럼 순서는 `..., zoom, updated_at, place_id`로 `place_id`가 맨 뒤(ADD COLUMN 특성).

---

## 4. QA 발견사항(F1~F6) 처리 상태

| ID | 내용 | 이번 변경이 원인? | 처리 상태 |
|---|---|---|---|
| F1 | `preset_name`이 운영 DB 전행 NULL. `loadRoiIntoDb`가 camerapos 라벨 upsert 직후 ROI 유래 프리셋(라벨 없음)을 재upsert해 `ON CONFLICT SET preset_name=excluded.preset_name`으로 라벨을 말소하는 구조 | ❌ 선재 결함(리네임 전 `sname`도 동일 로직·동일 증상). 운영 DB 해당 행 `updated_at`이 마이그레이션 실행보다 하루 앞섬(2026-07-23) — 마이그레이션이 이미 NULL이던 값을 보존했을 뿐 | **미수정.** 이번 범위 밖, 잔여과제로 기록(§8 참조: `COALESCE` 방식 등 별도 설계 결정 필요) |
| F2 | 세션 도중 제3자가 `web/app.js`·`web/index.html` 동시 수정 → `setupResultRoute.test.ts` 2건 신규 red | ❌ 완전 무관(동시 편집 사고, preset 코드와 무접촉) | 검증 중 관측된 **외부 요인**으로만 기록. 이번 리팩토링의 성공/실패 판정에서 제외. 이 브랜치는 워크트리 없이 메인 리포에서 직접 작업 중이라 동시 편집 충돌에 노출됨 |
| F3 | 마이그레이션 DB와 신규 DB의 `preset_info` 컬럼 순서 divergence(`ADD COLUMN`은 항상 마지막에 붙음) | ✅ 이번 변경(수용 가능) | **수용.** 컬럼 집합은 동일, 프로덕션 코드가 전부 명시 컬럼 리스트를 사용해 기능 영향 없음. 테스트로 고정됨 |
| F4 | `preset_pos`·`preset_info` 동시 존재 시 구 테이블 데이터가 무경고로 미이관 | ✅ 이번 변경(현실성 낮음) | **수용.** 잔여과제로 기록(§8) |
| F5 | 구현자 백업 파일이 WAL 미포함 → 복원 시 대량 데이터 손실 위험 | ❌ 운영 절차 | **조치 완료.** WAL/shm 동반 백업 생성됨(`data/setting.sqlite.bak-presetinfo-20260724_145745` + `-wal`/`-shm`) |
| F6 | 정본 문서 `Docs/MyThink/my_db_table.md`에 §2 `preset_pos`와 §4 `preset_info`가 공존, 항목번호 중복 | ❌ 문서(정본 설계 문서는 편집 대상 아님) | **마스터 확인 요청** — §2 `preset_pos`는 이번 리네임으로 §4 `preset_info`에 통합됨. 정본 문서 갱신이 필요하나 마스터의 문서이므로 임의 편집하지 않았다. 최종 문서 §9에도 동일 요청 명시 |

---

## 5. 테스트 결과 (인용 — 실제 실행)

- `npx tsc --noEmit` → **0 에러**.
- `npx vitest run` → **2680 passed / 4 failed**.
  - `buildTouringPlan.test.ts` 2건: 기준선 red, `save/setup_result.json`의 centering 전건 null 의존 — 이번 변경 무관.
  - `setupResultRoute.test.ts` 2건: 제3자 `web/` 편집 유래(F2) — 이번 변경 무관.
- 신규: `test/presetInfoMigration.test.ts`(4건) + `test/presetInfoMigration.adversarial.test.ts`(23건) = **27건 전량 green**.
- 검증자 재현치가 구현자 보고 수치와 정확히 일치함을 확인(1차 15:00 기준 2661/2 실패, 2차 15:16 적대적 테스트 추가 후 2684/4 실패, 신규 23건은 전부 2차 증가분).

---

## 6. 확인 필요 항목

- `docs/` 하위 기존 산문 문서(`20260718_012723_DB스키마전면개편_LLM최소화.md`, `SETUP_GUIDE_초기셋팅.md` 등)의 `preset_pos` 표기 갱신 여부 — 이번 범위 밖으로 판단해 미반영. 필요 여부 판단 요망.
- `Docs/MyThink/my_db_table.md` §2/§4 공존·항목번호 중복(F6) — 마스터 확인 후 갱신 여부 결정 필요(§4 표 참조).
- 대용량 DB에서의 마이그레이션 시간·잠금 영향, 동시 프로세스 마이그레이션 경합 — 검증자가 명시적으로 **미검증**이라 밝힌 항목이며 이번 분석에서도 확인 불가.

---

## 7. 결론

리팩토링 자체(테이블/컬럼 리네임, `place_id` 추가, 멱등 마이그레이션, FK 자동 추종)는 검증자의 9개 적대적 항목 전수 조사에서 **기능 결함 0건**으로 통과했다. 외부 계약(`camerapos.json`의 `sname`)과 `@parkagent/types` 등 타 에이전트로의 파급은 없음을 확인했다. 남은 항목은 이번 리팩토링의 결함이 아니라 **선재 결함(F1)**, **동시 편집 외부 요인(F2)**, **의도적으로 수용한 divergence(F3/F4)**, **정본 문서 갱신 필요성(F6, 마스터 확인 요청)**이며, 모두 위 표에 정직하게 기재했다.
