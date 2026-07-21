# 02 · 구현 요약 — 영속화 수치 소수점 최대 5자리 정규화

설계서 `01_architect_plan.md` §2 적용지점 표 + 리더 확정을 그대로 구현. 신규 헬퍼 1파일(2함수) + 13개 적용지점(외과적) + 기존 3개 data 파일 일회성 정규화.

## 리더 확정 반영
- **CaptureJob.ts:556 `spacesJson` 제외**(설계서 §5 Q1 권장대로): REST 응답·휘발성·정수/불리언뿐 → stringify5 미적용.
- 나머지는 설계서 §2 (b) 표 그대로.

## 신규 파일
- **`src/util/round.ts`** (단일 출처, 14줄) — 의존성 없음.
  - `round5(n)`: `Number.isFinite(n) ? Math.round(n*1e5)/1e5 : n`. 정수/비유한/비수치 passthrough.
  - `stringify5(value, indent?)`: `JSON.stringify(value, (_k,v)=> typeof v==='number' ? round5(v) : v, indent)`. 숫자만 반올림, 그 외(Date/문자열/null) passthrough. JSON.stringify 재귀로 중첩 배열·객체 자동 커버.

## 변경 파일 목록 + 라인

### stringify5 적용(JSON 파일 write / JSON TEXT 생산지) — 8파일
| # | 파일 | 지점 | 변경 |
|---|------|------|------|
| 1 | `store/Repository.ts` | :19 `saveArtifact` | `JSON.stringify(artifact,null,2)` → `stringify5(artifact,2)`. setup_artifact.json. import 추가. |
| 2 | `store/SaveStore.ts` | :37 `save` | `const json = stringify5(artifact,2)` (43줄 reports 미러까지 1곳 수정으로 커버). import 추가. |
| 3 | `calibrate/slotPtzWriter.ts` | :78 `writeSlotPtz` | `stringify5(artifact,2)`. slot_ptz.json. import 추가. |
| 4 | `setup/cameraposWriter.ts` | :37 `writeCamerapos` | `stringify5(out,2)`. camerapos.json. import 추가. |
| 5 | `api/captureRoutes.ts` | :352 `PUT /capture/place-roi` | `stringify5(next,2)`. PtzCamRoi.json. import 추가. |
| 6 | `capture/Finalizer.ts` | slot_setup 6곳 | slotRoi / vpdBbox(hit·prev) / lpdObb(hit·prev) / occupyRange(hit·prev) / slot3dFrontCenter 의 모든 `JSON.stringify` → `stringify5`. import 추가. |
| 7 | `tools/migrateToSettingDb.ts` | :115 `buildSlots` | slotRoi `stringify5(sp.points)`. import 추가. |

### round5 적용(DB REAL 바인딩 3 choke point) — `capture/SqliteStore.ts`
| 지점 | 변경 |
|------|------|
| `upsertPresetPos`(:186) | pan/tilt/zoom NOT NULL → `round5(r.pan)`, `round5(r.tilt)`, `round5(r.zoom)` 직접. |
| `replaceSlotSetup`(:210) | pan/tilt/zoom nullable → `r.pan==null?null:round5(r.pan)` 형태 3개(null 보존). |
| `upsertSlotCentering`(:279) | 센터링 pan/tilt/zoom nullable → `r.x==null?null:round5(r.x)` 3개. |
- import `round5` 추가. 정수 컬럼(slot_id/img_w/img_h/centered)·문자 컬럼 무변경(외과적).

### 제외(수정 안 함, 설계서 §2 (c) 근거)
- `brain/AgentRuntime.ts`(LLM 프롬프트), `mcp/server.ts`(도구 응답), `clients/*`(네트워크 body), `config/settingsStore.ts`(설정파일), **`capture/CaptureJob.ts:556` spacesJson**(REST 휘발 응답). 전송/휘발/설정 경계 — 정밀도 유지.

## 기존 3개 data 파일 일회성 정규화 결과
- 방식: scratchpad throwaway 스크립트(`scratchpad/normalize5.mjs`)가 빌드된 `dist/src/util/round.js`의 `stringify5`를 재사용(로직 복제 0) → 각 파일 read→JSON.parse→`stringify5(obj,2)` 재기록.
- **6자리+ 소수 잔존 = 전 파일 0건**(정규식 `\.[0-9]{6,}`):

| 파일 | before 6+ | after 6+ |
|------|-----------|----------|
| `data/setup_artifact.json` | 308 | **0** |
| `data/slot_ptz.json` | 0 | **0** |
| `data/Place01/PtzCamRoi.json` | 42 | **0** |

- **구조/키순서 보존 검증**: setup_artifact.json 라인수 957 → 957 불변, 비수치 스켈레톤(숫자·부호 제거 후) diff 완전 일치 → 값만 5자리로 변경 확인.
- **`data/setup_artifact.EMPTY_BACKUP_20260716.json` 미변경**(mtime 07-16 유지, 정규화 대상 제외).
- 3파일 모두 재기록 후 유효 JSON 파싱 확인.

## 자체 검증
- `npx tsc --noEmit`: **통과(에러 0)**.
- `npx tsc -p tsconfig.json` 빌드: **통과** → `dist/src/util/round.js` 생성(정규화 스크립트가 재사용).
- `npx vitest run`: **1763 passed / 4 failed (161 files)**.

## 깨질 테스트 목록(4건 — 전부 5자리 반올림 기대값 이슈, 진짜 로직 회귀 아님)
qa 는 아래만 round5 기준으로 실패-주도 갱신. 나머지 1763건은 불변.

| 테스트 | 실패 원인 | 갱신 방향 |
|--------|-----------|-----------|
| `test/centeringSlot.test.ts` — `slot_setup pan/tilt/zoom == item.ptz` | 저장값이 `upsertSlotCentering` round5 통과 → `pan:10`(기존 `9.999999999999995`), `zoom:3.72242`. 기대값이 원본 롱플로트. | 기대값을 `round5(item.ptz)`로 갱신. |
| `test/checkpointFinalizer.test.ts` — `save/ 스냅샷 내용 == artifact` | SaveStore.save 가 stringify5 로 기록 → 재파싱 시 5자리, in-memory `artifact`는 롱플로트 → deep equal 실패. | 기대를 stringify5 왕복값(또는 round5 적용 사본)과 비교하도록 갱신. |
| `test/finalizerFloor.test.ts` — `occupyRange == buildPlateAnchoredQuad(...)` | Finalizer occupyRange stringify5 저장 → 5자리, 기대값은 buildPlateAnchoredQuad 롱플로트. | 기대 좌표를 5자리로 갱신(또는 round5 매핑 비교). |
| `test/slot3dFrontCenter.test.ts` — `getSlotSetup().slot3dFrontCenter ≈ frontFaceCenterPx (9자리)` | 저장값 stringify5 로 5자리 → 라이브 파리티 계산값과 차이 ≈2.6e-6 > 허용 5e-10. | `toBeCloseTo` 정밀도를 9→5자리로 완화(또는 round5(파리티값) 비교). |

- 설계서 §4 "재확인" 후보 중 실제 실패는 위 4건뿐. `placeRoiRoutes`/`placeRoiUpdate`/`migrateToSettingDb`/`sqliteStore`/`repository`/`saveStore`/`cameraposWriter`/`slotPtzWriter`/`ptzCalibrator` 및 파리티·구조 비교 테스트는 **불변**(픽스처가 5자리 이하이거나 range/shape 비교라 무영향).

## 발견 이슈 / 주의
- 설계 결함 없음. 설계서 그대로 구현 가능.
- **slot_setup JSON TEXT 5자리 보장은 생산지 규약**(Finalizer 6곳 + migrate 1곳이 stringify5 사용). `replaceSlotSetup`은 넘어온 TEXT 를 재파싱·재반올림하지 않음 — 향후 slot_setup TEXT 신규 writer 는 반드시 `stringify5` 사용해야 함(회귀 방지 규약).
