# 주차면 ROI + preset PTZ DB 결합 저장 및 ROI 파일명 config화

작성일: 2026-07-09 20:51:47
작성자: 문서화·영향도 분석가(documenter)
대상 서비스: SettingAgent
근거 산출물: `_workspace/01_architect_plan.md`(설계) · `02_developer_changes.md`(구현) · `03_qa_report.md`(검증)
준거: CLAUDE.md 규칙 4(상세 문서화) · 5(영향도 분석)

---

## 1. 배경 / 목표

정밀수집 finalize 단계에서 파일 바닥ROI(`PtzCamRoi.json`) 기준으로 주차면을
`parking_slots` 테이블에 저장한다. 그러나 기존 저장 행에는 **해당 프리셋의 실제 PTZ 값
(pan/tilt/zoom)이 없었다** — `my_think 6a` 갭("parking_slots에 preset ptz 없음").

이번 변경은 두 가지를 해소한다.

- **변경 1 (preset PTZ 결합 저장)**: `(cameraId, presetId, preset PTZ, 주차면 ROIs)`를
  한 테이블 행에 **결합 저장**한다. 소비처(슬롯 목록 UI, `GET /slots`)가 주차면별로
  프리셋의 실 PTZ를 행 단위로 즉시 얻을 수 있게 한다.
- **변경 2 (ROI 파일명 config화)**: `index.ts`에 하드코딩돼 있던 ROI 파일 경로
  (`Place01/PtzCamRoi.json`)를 `tools.store.placeRoiFile` 설정 값으로 치환한다.

두 변경 모두 **결정형 도구 영역**(스키마/저장/설정)에 속한다. LLM 두뇌 경계·좌표 판정
로직·MCP 도구·프롬프트와는 무관하다.

---

## 2. 변경 상세

### 2-1. `parking_slots` 스키마 확장 (`src/capture/SqliteStore.ts`)

CREATE TABLE `parking_slots`에 `pan REAL, tilt REAL, zoom REAL` 3컬럼을 추가했다.
컬럼 순서는 **`occupancy_rate, pan, tilt, zoom, updated_at`**로 통일했으며,
CREATE / INSERT / 바인딩 / SELECT 4곳에 동일 순서를 적용해 위치 바인딩 불일치를 방지했다.

```
parking_slots (
  run_id, cam_idx, preset_idx, preset_key,
  slot_idx, roi_json, vpd_json, lpd_json,
  occupied, occupancy_rate,
  pan REAL, tilt REAL, zoom REAL,   -- ← 신규 3컬럼
  updated_at,
  PRIMARY KEY (run_id, preset_key, slot_idx)
)
```

PRIMARY KEY·기존 컬럼·run 단위 delete+insert 멱등성은 불변이다.

### 2-2. 구DB 마이그레이션 (`SqliteStore.ts`)

`CREATE TABLE IF NOT EXISTS`는 기존 파일 DB에 신컬럼을 추가하지 못한다. 따라서
기존 마이그레이션 패턴(`addColumnsIfMissing`, quad·신뢰도·polygon_json과 동일)을 재사용해
1줄을 추가했다.

```ts
this.addColumnsIfMissing('parking_slots', ['pan', 'tilt', 'zoom'], 'REAL');
```

`addColumnsIfMissing`는 `PRAGMA table_info`로 존재 컬럼을 검사한 뒤, 없는 컬럼만
`ALTER TABLE ADD COLUMN`으로 추가한다(better-sqlite3는 `ADD COLUMN IF NOT EXISTS`
미지원). 구DB의 기존 행은 pan/tilt/zoom = NULL로 유지되어 뷰에서 `null`로 폴백된다.

### 2-3. 타입 확장 (`src/capture/types.ts`)

- `ParkingSlotRow`: `occupancyRate` 뒤에 `pan / tilt / zoom: number | null` 추가
  (주석: "프리셋 실 PTZ, 미조회/미보유 시 null").
- `ParkingSlotView`: 동일 3필드 추가.

### 2-4. INSERT / SELECT 확장 (`SqliteStore.ts`)

- `replaceParkingSlots`: INSERT 컬럼·VALUES에 `pan, tilt, zoom` 추가.
  바인딩은 `r.pan ?? null, r.tilt ?? null, r.zoom ?? null`.
- `getParkingSlots`: SELECT에 `pan, tilt, zoom` 추가, 결과 타입 3필드 추가,
  `.map` 반환 객체에 `pan: r.pan ?? null` 등 추가.

> 주의(검증됨): `?? null` 병합은 **falsy 0을 뭉개지 않는다**. `zoom = 0` 같은 경계값도
> `0`으로 정확 복원됨을 QA 유닛테스트가 명시 검증했다(널병합 함정 방지).

### 2-5. `resolvePresetPtz` export 재사용 (`src/capture/detectPipeline.ts`)

프리셋 PTZ 조회 로직을 신규 작성하지 않고, `detectPipeline.ts`에 이미 존재하던
`resolvePresetPtz`에 **`export`만 추가**해 Finalizer에서 재사용했다(DRY, 로직 1곳).
시그니처·본문·`runDetect` 호출부는 불변이다.

동작: `listCameras()` → camIdx 일치 카메라 → presetIdx 일치 프리셋 →
**pan/tilt/zoom 3필드가 모두 존재할 때만** `{pan,tilt,zoom}` 반환, 아니면 `null`
(부분 보유 방지). 조회 실패는 try/catch로 격리해 `null` 반환.

### 2-6. Finalizer preset PTZ 주입 (`src/capture/Finalizer.ts`)

- import 2건 추가: `resolvePresetPtz`(detectPipeline), `CameraClient` 타입.
- `FinalizerDeps`에 `camera?: Pick<CameraClient, 'listCameras'>` 추가(**선택 주입**).
- place ROI 루프에서 `Map<string, {pan,tilt,zoom}|null>` 캐시(`ptzByKey`)로
  **preset_key별 1회만** PTZ를 조회한다(같은 프리셋의 여러 슬롯이 조회를 반복하지 않음).
  - `deps.camera` 주입 시 `resolvePresetPtz(deps.camera, camIdx, presetIdx)`, 미주입 시 `null`.
  - 각 `rows.push({...})`에 `pan / tilt / zoom: ptz?.* ?? null` 주입.
- 조회는 기존 주차면 저장 `try/catch`(211~257행) 블록 **내부**에 위치 →
  조회 실패도 격리된다. 정본 artifact 저장 흐름은 불변(이미 이전 단계에서 저장 완료).

### 2-7. index.ts 주입 (`src/index.ts`)

- `new Finalizer({...})`에 상단에서 이미 생성된 `camera` 인스턴스를 전달(`camera,` 1줄).

### 2-8. ROI 파일명 config화 (변경 2)

- `src/config/toolsConfig.ts` `StoreSchema`:
  `placeRoiFile: z.string().min(1).default('Place01/PtzCamRoi.json')` 추가.
  `DEFAULT_TOOLS_CONFIG.store`에도 동일 기본값 명시.
- `config/tools.config.json` `store`에 `"placeRoiFile": "Place01/PtzCamRoi.json"` 추가.
- `src/index.ts` 두 곳(Finalizer 주입 59행, buildServer 인자 73행):
  `join(tools.store.dataDir, 'Place01', 'PtzCamRoi.json')`
  → `join(tools.store.dataDir, tools.store.placeRoiFile)`.
- `placeRoiFile`은 **dataDir 상대경로**만 지원한다(절대경로·다중파일 확장은 범위 밖).
  기본값이 기존 하드코딩과 동일하므로 해석 경로는 `data/Place01/PtzCamRoi.json`로 무회귀.

---

## 3. 데이터 흐름

```
GET /cameras (preset PTZ 포함)
   │
   ▼
resolvePresetPtz(camera, camIdx, presetIdx)   -- 3필드 모두 존재 시만 {pan,tilt,zoom}
   │  (Finalizer 내 preset_key별 1회 캐시)
   ▼
Finalizer rows: ParkingSlotRow{ ...ROI, pan, tilt, zoom }
   │
   ▼
SqliteStore.replaceParkingSlots(runId, rows)   -- run 단위 delete+insert(멱등)
   │
   ▼
SqliteStore.getParkingSlots(runId): ParkingSlotView[]  -- pan/tilt/zoom 포함
   │
   ▼
GET /capture/runs/:id/slots   -- getParkingSlots 직반환(신필드 자동 포함)
```

프리셋 인덱스는 전 구간 1-based 일관, preset_key는 `${camIdx}:${presetIdx}` 형식 동일.

---

## 4. 입출력 / REST 계약

`GET /capture/runs/:id/slots` (captureRoutes.ts:254) 응답 행에 **가산 필드 3개**가 추가된다.

| 필드 | 타입 | 설명 |
|------|------|------|
| `pan` | `number \| null` | 프리셋 실 PTZ pan. 미조회/미보유 시 null |
| `tilt` | `number \| null` | 프리셋 실 PTZ tilt. 미조회/미보유 시 null |
| `zoom` | `number \| null` | 프리셋 실 PTZ zoom. 미조회/미보유 시 null |

기존 필드(camIdx/presetIdx/presetKey/slotIdx/roi/vpd/lpd/occupied/occupancyRate)의
이름·타입·의미는 불변이다. 라우트 검증 로직(id 400 / run 없음 404)도 불변.

> 경계면(검증됨): JSON 직렬화 후에도 `null`이 유지되어 `undefined`로 사라지지 않는다
> (`'pan' in s` 확인). 소비처 shape 정합.

---

## 5. 영향도 분석 (요약 — 상세는 `_workspace/04_doc_impact.md`)

| 파일 | 변경 | 영향 |
|------|------|------|
| `src/capture/SqliteStore.ts` | 스키마·마이그레이션·INSERT·SELECT | 신DB 3컬럼, 구DB ALTER 마이그레이션. 기존 행 NULL 폴백 |
| `src/capture/types.ts` | Row·View 3필드 | 타입 확장. 팩토리(테스트 2파일) 고아화 → `pan/tilt/zoom: null` 복구 |
| `src/capture/detectPipeline.ts` | `export` 1개 | 시그니처·호출부 불변 → `runDetect` 무영향 |
| `src/capture/Finalizer.ts` | camera dep·PTZ 주입 | camera 선택 주입. 미주입/실패 시 전부 null·저장 성공(격리) |
| `src/index.ts` | camera 주입·config 치환 | 부팅 배선만. 해석 경로 무회귀 |
| `src/config/toolsConfig.ts` | `placeRoiFile` 스키마 | 기본값=기존 하드코딩 → 미지정 사용자 무회귀 |
| `config/tools.config.json` | `store.placeRoiFile` | 명시값=기본값 |

**무영향 확인**:
- app.js `slot-list`(renderSlotList): pan/tilt/zoom은 **순수 가산 필드**. 알 수 없는
  필드는 무시되어 UI 무영향(활용은 별도 요청 시).
- `GET /capture/runs/:id/slots`: `getParkingSlots` 직반환 → 신필드 자동 포함(가산).
- MCP 도구·다른 라우트·좌표/점유 판정 로직: 무관.

리스크: **낮음**. 파괴적 변경 없음, 전부 가산·하위호환.

---

## 6. 하위호환 / 폴백 (불변식)

- **구DB**: ALTER로 pan/tilt/zoom 추가, 기존 행 NULL → 뷰에서 null. 기존 소비 무영향.
- **camera 미주입 / 조회 실패 / preset 부분 보유**: 전부 null, parking_slots 저장은 정상
  진행(best-effort · 격리 철학 유지).
- **기존 config**: `placeRoiFile` 미지정 → default `Place01/PtzCamRoi.json`. 설정 미변경
  사용자 무회귀.
- artifact/저장 흐름 · PRIMARY KEY · run 단위 delete+insert 멱등 **불변**.

---

## 7. 검증 결과 (03_qa_report.md 인용 — 실제 실행)

| 명령 | 결과 |
|------|------|
| `npx tsc --noEmit` | **통과**(에러 0) |
| `npx vitest run`(전체) | **1083 passed / 107 files** |
| 대상 5파일 단독 실행 | 61 passed (기존 47 + 신규 14) |

신규/확장 유닛테스트 14건:

1. **왕복**(`parkingSlotsStore.test.ts`, +4) — pan/tilt/zoom 값 정확 복원, null 복원,
   **zoom=0 경계**(널병합 함정), 행별 독립(보유+null 혼재).
2. **마이그레이션**(`sqliteStore.test.ts`, +1) — 구 스키마 raw 생성 후 재오픈 → 3컬럼
   ALTER 확인, 기존 행 NULL, 이후 INSERT 정상 왕복.
3. **config**(`config.test.ts`, +3) — 미지정 3경우 기본값, 커스텀 값, 실 config 파일 값.
4. **Finalizer PTZ 주입**(`finalizerParkingSlots.test.ts`, +5) — camera 주입 시 전 행 결합,
   미주입 시 전부 null·저장 성공, 부분 보유 null, `listCameras` throw 격리,
   **캐시 1회 호출** 검증(preset 1개 + 슬롯 3개 → listCameras 1회).
5. **라우트**(`parkingSlotsRoutes.test.ts`, +1) — 응답 행에 신필드 포함, JSON 직렬화 후
   null 유지(`'pan' in s`).

**리더 라이브 확인**: config → `/capture/place-roi` 서빙, `/cameras` preset PTZ 확인.

### 한계 (사실 기록 — "검증됨"으로 위장하지 않음)

- Finalizer 테스트는 실 `data/Place01/PtzCamRoi.json` 대신 tmp 픽스처
  (`writePlaceRoi`)와 `listCameras` **스텁**으로 대체. 실 파일·실 Unity `/cameras`
  연동은 미검증.
- **전체 capture → finalize end-to-end 스모크 미실행**: 실 SettingAgent 부팅 →
  `/req_img`·`/cameras` 실 응답으로 parking_slots에 실 PTZ가 채워지는 end-to-end는
  외부 서비스(Unity 시뮬) 미가동으로 **누락**. 유닛(모킹)+부분 라이브로 대체.
  실 연동 확인은 운영 환경에서 별도 스모크 필요.

---

## 8. 후속 항목 (별개 — my_think 참조)

- **P4 slot PTZ의 setup 파일 통합**: 주차면별 캘리브레이션 PTZ(`slot_ptz.json`)와
  setup artifact 통합은 이번 범위 밖.
- **전역인덱스 DB 통일**: 별개 항목으로 남음.
- app.js에서 pan/tilt/zoom 신필드 **활용**(UI 표시 등)은 별도 요청 시.
