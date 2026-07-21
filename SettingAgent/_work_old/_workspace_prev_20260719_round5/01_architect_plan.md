# 01 · 설계 계획 — 영속화 수치 소수점 최대 5자리 정규화

## 0. 요청 요약
- SettingAgent 가 **영속화**(DB + JSON 파일)하는 모든 수치를 소수점 이하 **최대 5자리**로 저장.
  - "최대 5자리" = 반올림 후 불필요한 뒤 0 제거(예: `0.11182877131922099 → 0.11183`, `0.5 → 0.5`).
- 기존 `data/*.json` 파일도 5자리로 일회성 정규화.
- **범위 = 영속화 경계에만.** 전송/휘발성 payload·설정파일은 제외.

## 1. 코드 조사로 확정한 사실 (근거)

### 1-1. 헬퍼 배치
- `src/util/` 에 `logger.ts / http.ts / image.ts / jpeg.ts` 존재. ESM `.js` 확장자 import 규약(예: `import { logger } from '../util/logger.js'`). → **신규 `src/util/round.ts`** 가 자연스러운 단일 출처.

### 1-2. DB(SqliteStore) 수치 컬럼 전수 식별 (`src/capture/SqliteStore.ts`)
| 테이블 | REAL 수치 컬럼 | JSON TEXT(수치 내포) 컬럼 | 정수/문자 컬럼(무영향) |
|--------|----------------|---------------------------|------------------------|
| `place_info` | 없음 | 없음 | place_id(INT PK), place_name |
| `camera_info` | 없음 | 없음 | **img_w/img_h = INTEGER**, cam_id 등 |
| `preset_pos` | **pan, tilt, zoom** | 없음 | cam_id, preset_id(PK), sname |
| `slot_setup` | **pan, tilt, zoom** | slot_roi, vpd_bbox, lpd_obb, occupy_range, **slot3d_front_center** | slot_id(PK), preset_slotidx, centered(0/1), img1 |
| `parking_evnt` / `parking_slot` | 없음(writer 미구현) | 없음 | 전부 정수/문자 |

- **REAL 바인딩 지점 3곳(단일 choke point)**: `upsertPresetPos`(SqliteStore.ts:186), `replaceSlotSetup`(:207), `upsertSlotCentering`(:279). 여기서 pan/tilt/zoom 바인딩만 `round5` 로 감싸면 **모든 호출자**(migrate·PtzCalibrator·Finalizer·테스트)가 자동 커버.
- **JSON TEXT 는 이미 문자열로 도착**한다: `replaceSlotSetup` 은 `r.slotRoi`(string) 등을 그대로 바인딩. 따라서 TEXT 5자리화는 **DAO 가 아니라 문자열 생산지(Finalizer·migrate)의 `JSON.stringify`** 에 `stringify5` 를 적용해야 함(§2 결정).
  - ⚠ **경계 함의(명시)**: `replaceSlotSetup` 은 넘어온 TEXT 를 재파싱·재반올림하지 않는다. 즉 slot_setup JSON TEXT 의 5자리 보장은 "모든 생산지가 `stringify5` 를 쓴다"는 규약으로 성립한다(생산지 = Finalizer 5곳 + migrate 1곳, 전수 식별됨). 이 경계를 문서·주석에 남긴다.

### 1-3. JSON 파일 write 지점 전수 (`src/**` 의 `JSON.stringify` + write)
- Grep 결과 파일 write 로 이어지는 `JSON.stringify`:
  - **영속화(적용 대상)**: Repository.ts:19, SaveStore.ts:37, slotPtzWriter.ts:78, cameraposWriter.ts:37, captureRoutes.ts:352, Finalizer.ts:261~270, migrateToSettingDb.ts:115.
  - **비영속/제외**: AgentRuntime.ts(LLM 프롬프트 다수), mcp/server.ts(도구 응답), CameraClient.ts / CRpcClient.ts(네트워크 body), settingsStore.ts:87/96(config), CaptureJob.ts:556(REST 응답 — §3 충돌 항목).
- `writeCamerapos` 는 viewer/routes.ts:372, server.ts:137/189, e2eSmoke, exportCamerapos 등 **다수 호출자**를 갖지만 write 는 함수 1곳(cameraposWriter.ts:37) → 여기 한 곳만 고치면 전 호출자 커버.
- `saveArtifact`(Repository) 호출자: server.ts:49, Finalizer.ts:214, SetupOrchestrator.ts:193 → write 는 Repository.ts:19 한 곳 → 단일 수정으로 커버.
- `SaveStore.save` 호출자: captureRoutes.ts:297, Finalizer.ts:284 → write 는 SaveStore.ts:37/43 → 단일 수정 커버.

### 1-4. 정밀도/포맷 특성
- `round5(n) = Math.round(n*1e5)/1e5`. 대상 크기(좌표 0~2000px, 각도, zoom 1~36)에서 결과 double 의 최단 왕복 표현이 정확히 5소수여서 `JSON.stringify` 가 깔끔히 출력(뒤 0 자동 제거). `-9e-7 → round5 → -0 → JSON "0"`(무해, 리더 확인).
- 반올림 = **round-half-up**(`Math.round`, .5 는 +∞ 방향). 리더 확정 규칙과 정합.

## 2. 확정 설계 (리더 결정 반영)

### (a) 헬퍼 시그니처 — `src/util/round.ts` (단일 출처, ~15줄)
```ts
/** 유한수만 소수점 최대 5자리로 반올림(round-half-up). 정수/비유한/비수치는 그대로. */
export function round5(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 1e5) / 1e5 : n;
}

/** JSON.stringify 에 숫자 replacer(round5) 적용. 숫자 값만 반올림, 그 외 passthrough. */
export function stringify5(value: unknown, indent?: number): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'number' ? round5(v) : v), indent);
}
```
- **replacer 정확성 근거**: `JSON.stringify` 는 중첩 배열/객체를 재귀 순회하며 각 값에 replacer 를 호출 → 자동 재귀. `Date` 등 `toJSON` 보유 값은 replacer 가 받기 전에 문자열로 변환되므로 `typeof v==='number'` 에 걸리지 않아 무영향. `NaN/Infinity` → round5 passthrough 후 `JSON.stringify` 가 기존과 동일하게 `null` 출력(동작 불변).
- 최소주의(CLAUDE.md §2): 헬퍼 2개만. 통화·자릿수 옵션 등 추측성 유연성 금지.

### (b) 적용 지점 표 — stringify5 vs round5

| # | 파일:라인 | 대상 | 적용 | 변경 요지 |
|---|-----------|------|------|-----------|
| 1 | `store/Repository.ts:19` | setup_artifact.json | **stringify5** | `JSON.stringify(artifact,null,2)` → `stringify5(artifact,2)` |
| 2 | `store/SaveStore.ts:37` | save/·reports/*.json | **stringify5** | `const json = stringify5(artifact,2)`(37줄 1곳 수정으로 43줄 미러까지 커버) |
| 3 | `calibrate/slotPtzWriter.ts:78` | slot_ptz.json | **stringify5** | `writeFileSync(outFile, stringify5(artifact,2), ...)` |
| 4 | `setup/cameraposWriter.ts:37` | camerapos.json | **stringify5** | `writeFileSync(path, stringify5(out,2), ...)` |
| 5 | `api/captureRoutes.ts:352` | PtzCamRoi.json(place-roi PUT) | **stringify5** | `writeFile(deps.placeRoiFile, stringify5(next,2), ...)` |
| 6 | `capture/Finalizer.ts:261` | slot_setup.slot_roi TEXT | **stringify5** | `JSON.stringify(sp.points)` → `stringify5(sp.points)` |
| 7 | `capture/Finalizer.ts:262` | vpd_bbox TEXT(hit·prev 양쪽) | **stringify5** | 2개 `JSON.stringify` 모두 |
| 8 | `capture/Finalizer.ts:263` | lpd_obb TEXT(hit·prev) | **stringify5** | 2개 모두 |
| 9 | `capture/Finalizer.ts:264` | occupy_range TEXT(hit·prev) | **stringify5** | 2개 모두 |
| 10 | `capture/Finalizer.ts:270` | slot3d_front_center TEXT | **stringify5** | `front ? stringify5(front) : null` |
| 11 | `tools/migrateToSettingDb.ts:115` | slot_roi TEXT | **stringify5** | `stringify5(sp.points)` |
| 12 | `capture/SqliteStore.ts:186` | preset_pos.pan/tilt/zoom REAL | **round5** | `stmt.run(r.camId,r.presetId,r.sname, round5(r.pan), round5(r.tilt), round5(r.zoom), r.updatedAt)` (null 아님 전제 — NOT NULL 컬럼) |
| 13 | `capture/SqliteStore.ts:207` | slot_setup.pan/tilt/zoom REAL | **round5** | `r.pan==null?null:round5(r.pan)` 형태(nullable 보존) 3개 |
| 14 | `capture/SqliteStore.ts:279` | slot_setup 센터링 pan/tilt/zoom REAL | **round5** | `r.pan==null?null:round5(r.pan)` 3개 |

- round5 는 **정수·null 무영향**이므로 `camera_info.img_w/img_h`(INTEGER) 및 정수 PK 는 손대지 않는다(불필요한 표면 확대 금지, §외과적).
- ⚠ **nullable 주의**: slot_setup·centering 의 pan/tilt/zoom 은 `?? null` 로 넘어올 수 있음(Finalizer 는 항상 null). `round5(null)` 은 `Number.isFinite(null)===false` 라 null passthrough → **그대로 써도 안전**하지만, 타입상 `number` 시그니처와 어긋나므로 `x==null ? null : round5(x)` 로 감싼다(preset_pos 는 NOT NULL 이라 직접 round5).

### (c) 제외 지점 + 근거 (반올림 금지)
| 지점 | 근거 |
|------|------|
| `brain/AgentRuntime.ts` 전 `JSON.stringify`(141,172,183,197,217,232,261,337,411) | **LLM 프롬프트/응답 payload** — 영속화 아님. 반올림 시 모델 입력 왜곡·의미 없음(휘발성). |
| `mcp/server.ts`(42,71,84,104,107,125,128) | MCP 도구 **응답 텍스트**(전송) — 소비자는 실시간 값 필요. 영속화 아님. |
| `clients/CameraClient.ts`(77,150), `clients/CRpcClient.ts`(53) | **카메라·RPC 네트워크 body** — 명령값(pan/tilt/zoom 등)을 임의 반올림하면 제어 정밀도·벤더 계약 훼손. 결정형 실시간 경로(MCP 경계: 도구·네트워크). |
| `config/settingsStore.ts`(87,96) | llm.json/tools.config.json **설정파일** — 설정값·키 순서 보존이 목적(주석에 in-place 보존 명시). 좌표 데이터 아님. |
| `capture/CaptureJob.ts:556`(spacesJson) | `getOccupancy()` → **`GET /capture/occupancy` REST 응답(휘발성)**. DB/파일 write 아님. 리더 결정3 목록과 결정4(전송 제외)가 **충돌** → §5 Q1 로 확인 요청(권장: 제외). 게다가 spaces={idx:int, occupied:bool} 로 부동소수 없음 → 실질 무영향. |

### (d) 기존 파일 일회성 정규화 방식 — **scratchpad 일회성 스크립트(권장)**
- 대상: `data/setup_artifact.json`, `data/slot_ptz.json`, `data/Place01/PtzCamRoi.json`. (제외: `data/setup_artifact.EMPTY_BACKUP_*` — 백업 불변.)
- 방식: 프로덕션 코드에 마이그레이션 로직을 넣지 않고(§외과적·§단순), **빌드된 헬퍼를 재사용**하는 throwaway 스크립트로 재기록.
  ```
  1) 헬퍼 구현 후 tsc 빌드(dist/src/util/round.js 생성)
  2) scratchpad/normalize5.mjs:
     - 3개 파일 각각 readFileSync → JSON.parse → writeFileSync(stringify5(obj, 2))
     - stringify5 는 dist/src/util/round.js 에서 import(단일 출처 재사용 — 로직 복제 0)
  3) 1회 실행 → git diff 로 값만 5자리로 바뀌고 구조/키순서 동일 확인
  ```
- 근거: JSON.parse 는 문자열 키 순서를 보존 → 재직렬화해도 포맷(2-space)·구조 동일, **값만** 5자리. PtzCamRoi.json 의 `eulerAngles z=-9e-7→0` 은 무해(리더 확인).
- 대안(비권장): 프로덕션 `ensureSchema`/부팅 시 자동 정규화 — 범위 초과·추측성. 채택 안 함.

## 3. 검증 방법 (성공 기준)

### 유닛(vitest, qa-tester)
1. `round5`: `0.11182877131922099→0.11183`, `0.5→0.5`, `0.10000→0.1`, 정수 `5→5`, `NaN→NaN`, `Infinity→Infinity`, `-9e-7→` 결과 `JSON.stringify` 시 `"0"`. → 검증: 각 입력→기대 출력.
2. `stringify5`: 중첩 `{a:[{x:0.123456789}], d:new Date(0)}` → x 는 5자리, Date 문자열 무변경, 배열 재귀 반올림 확인. `indent` 전달 시 pretty. → 검증: `JSON.parse` 후 자릿수·구조.
3. DB REAL round5: `upsertPresetPos`/`upsertSlotCentering`/`replaceSlotSetup` 에 6+자리 pan/tilt/zoom 저장 → `getSlotSetup`/조회 시 5자리. → 검증: 저장·재조회 값 == round5(입력).
4. Finalizer TEXT stringify5: 지면모델 주입 finalize → `getSlotSetup` 의 slot3d_front_center/slot_roi 각 좌표가 소수 ≤5자리(정규식 `/\.\d{6,}/` 미매칭). → 검증: 문자열 자릿수 스캔.
5. 파일 writer: Repository/SaveStore/slotPtzWriter/cameraposWriter/place-roi PUT 후 파일 텍스트에 6+자리 소수 없음. → 검증: 파일 read 후 정규식 스캔.

### 실데이터 스모크(자릿수 검사)
- 정규화 스크립트 실행 후 3개 data 파일 + finalize 1회 → `data/setting.sqlite` 덤프에 대해 **정규식 `\.\d{6,}` 전무** 확인(수치 컬럼·JSON TEXT 모두). 성공 기준 = 매치 0건.

## 4. 영향 테스트 목록 (qa 갱신 대상 후보)

### 반드시 재확인 — 영속화 경계를 지나며 6+자리 기대값 보유
| 테스트 | 위험 | 판정 |
|--------|------|------|
| `test/slot3dFrontCenter.test.ts` | **혼재**: (a) Finalizer 경로로 저장된 front-center 를 assert 하는 케이스 → **round5 로 값 변동 가능(갱신 필요)**. (b) 라인 248/254 는 테스트가 `JSON.stringify({x:0.512345,...})` 로 **직접 문자열을 만들어 `replaceSlotSetup` 에 주입** → stringify5 를 우회하므로 **round-trip 불변(안 깨짐)**. qa 는 두 케이스를 구분해 (a)만 round5 기대값으로 갱신. |
| `test/placeRoiRoutes.test.ts`, `test/placeRoiUpdate.test.ts` | PtzCamRoi 픽셀(예 `57.31739`,`828.721436`) PUT→재기록. place-roi PUT 이 stringify5 면 5자리로 저장 → 6+자리 정확 비교 assert 시 파괴. | 값 비교 있으면 round5 기대값으로 갱신, range/shape 비교면 불변. |
| `test/migrateToSettingDb.test.ts` | 픽스처 pan/tilt/zoom·slot_roi 가 6+자리면 저장 시 5자리 → 왕복 정확 비교 파괴. | 확인 후 갱신. |
| `test/sqliteStore.test.ts` | 6+자리 소수 없음(확인함) → **불변 예상**. 단 pan/tilt/zoom 정확비교 케이스 유무 재확인. | 저위험. |
| `test/ptzCalibrator.test.ts`, `test/centeringSlot.test.ts` | 센터링 pan/tilt/zoom 이 6+자리로 저장·assert 되면 round5 로 변동. | 확인 후 갱신. |
| `test/cameraposWriter.test.ts` | camerapos 왕복(pan/tilt/zoom). 6+자리 값이면 5자리로 기록. | 확인 후 갱신. |
| `test/slotPtzWriter.test.ts` | slot_ptz.json 왕복 값. | 확인 후 갱신. |
| `test/repository.test.ts`, `test/saveStore.test.ts` | artifact 왕복(roi/quad 좌표). 6+자리 좌표 정확 비교 시 파괴. | 확인 후 갱신. |
| `test/finalizerParkingSlots.test.ts`, `test/finalizerFloor.test.ts`, `test/finalizerOccupancy.test.ts`, `test/finalizerPreserveDetection.test.ts` | finalize→getSlotSetup TEXT 좌표 정확 비교 케이스. | 확인 후 갱신. |

### 불변(근거와 함께 명시)
- `test/dbOverlayParity.test.ts` — **구조/범위(finite·in-canvas) 비교만**, 정확 float 비교 없음(코드 확인). 5자리화 무영향. **불변.**
- `test/quadCentroidParity.test.ts`, `test/globalIdxParity.test.ts`, `test/occupancyGeometryParity.test.ts` 등 **파리티(계산 대상 core.js↔project.ts) 테스트** — 저장 반올림과 무관하게 **연산 입력에 대한 1e-6 정합**을 검사. round5 는 영속화 경계에만 삽입되고 파리티는 저장 전 계산값 비교 → **불변.**
- 순수 수학 테스트(geometry/occupancyRegion/normalizePtzCamRoi/placeRoi 등 6+자리 보유분) — 영속화 경계 미통과 → **불변.**

> qa 는 위 "재확인" 목록을 실제 실행(vitest)해 실패분만 round5 기준으로 갱신한다("모두 갱신"이 아니라 실패-주도 갱신 — 외과적).

## 5. 미해결 / 확인 요청 (숨기지 않음)
- **Q1 (CaptureJob.ts:556 충돌)**: 리더 결정3 은 spacesJson 을 stringify5 대상으로 열거했으나, 실제 `getOccupancy()` 는 **`GET /capture/occupancy` REST 응답(휘발성)** 이며 DB/파일 write 가 아니다(결정4 "전송/휘발성 제외"와 충돌). 또한 spaces 는 정수 idx·불리언뿐이라 실질 무영향. → **권장: 제외**(전송 payload 규칙 준수). 리더 확정 요청.
- **Q2 (round5 DAO 위치)**: REAL 5자리화를 **DAO 바인딩 3곳**(단일 choke point, 전 호출자 커버)에 두는 것을 권장. 대안(각 row 빌더에서 round5)은 지점 분산·누락 위험. → 권장안대로 진행.
- **가정**: slot_setup JSON TEXT 5자리 보장은 "생산지가 모두 stringify5 사용"으로 성립(§1-2 경계 함의). 향후 slot_setup TEXT 를 쓰는 신규 코드는 stringify5 를 써야 함(주석·문서 규약화).

## 6. 영향도 초안 (documenter 전달용)
- **신규 파일**: `src/util/round.ts`(헬퍼 2개, 단일 출처). 의존성 없음.
- **DB**: 스키마 불변(컬럼·타입·제약 무변경). REAL 저장 정밀도만 ≤5자리로 축소 — 정규화 좌표 5자리 = 최대 ~0.02px(1920 기준) 오차(허용). 기존 행은 다음 finalize/센터링 시 5자리로 갱신, 즉시 마이그레이션은 §2(d) 스크립트가 파일 정본을 정규화.
- **REST/소비자**: setup_artifact.json / camerapos.json / slot_ptz.json / PtzCamRoi.json 을 읽는 Action/DM/뷰어는 값 정밀도만 축소 — shape/키 불변, 하위호환.
- **제외 경계 불변**: LLM 프롬프트·MCP 응답·카메라/RPC 네트워크·config 파일은 무변경(정밀도 유지) — 제어·설정 정확성 보존.
- **테스트**: §4 "재확인" 목록 일부가 기대값 갱신 필요(실패-주도). 파리티·구조 비교 테스트는 불변.
- **위험**: (1) slot_setup TEXT 5자리는 생산지 규약 의존(신규 writer 누락 시 회귀) — 문서 규약으로 완화. (2) `MEMORY: finalize slot_setup wipe` 취약성과 무관(round5 는 값 정밀도만, DELETE+INSERT 로직·검출 가드 무변경).
