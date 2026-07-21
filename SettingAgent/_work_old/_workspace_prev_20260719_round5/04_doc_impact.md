# 04 영향도 분석: 영속화 수치 소수점 최대 5자리 정규화

작성: 문서화 담당(documenter). 최종 문서: `docs/20260719_094327_영속화수치_소수점5자리제한.md`

## 신규 파일

| 파일 | 내용 | 파급 |
|---|---|---|
| `src/util/round.ts` | `round5(n)`, `stringify5(value, indent?)` 2개 함수, 14줄, 의존성 없음 | 신규 단일 출처. 기존 어떤 모듈도 이 파일을 몰랐으므로 import 추가 외 파급 없음 |

## 변경 파일 목록 (라인 단위)

### stringify5 적용 — 8파일

| 파일:라인 | 대상 | 변경 |
|---|---|---|
| `store/Repository.ts:19` | `data/setup_artifact.json` | `JSON.stringify` → `stringify5` + import 1줄 |
| `store/SaveStore.ts:37` | `save/`·`reports/*.json` | 동일(43줄 미러는 37줄 값 재사용이라 자동 커버) |
| `calibrate/slotPtzWriter.ts:78` | `data/slot_ptz.json` | 동일 |
| `setup/cameraposWriter.ts:37` | `camerapos.json` | 동일 |
| `api/captureRoutes.ts:352` | `PUT /capture/place-roi` → `PtzCamRoi.json` | 동일 |
| `capture/Finalizer.ts:262,263,264,265,271` | `slot_setup` TEXT(slotRoi/vpdBbox/lpdObb/occupyRange/slot3dFrontCenter, hit·prev 양쪽 총 9개 호출) | 동일 |
| `tools/migrateToSettingDb.ts:115` | slot_roi TEXT(마이그레이션) | 동일 |

### round5 적용 — `capture/SqliteStore.ts` (3 choke point)

| 지점:라인 | 대상 | 변경 |
|---|---|---|
| `upsertPresetPos:187` | `preset_pos.pan/tilt/zoom`(NOT NULL) | `round5(r.pan)` 등 직접 적용 |
| `replaceSlotSetup:211` | `slot_setup.pan/tilt/zoom`(nullable) | `r.pan==null?null:round5(r.pan)` |
| `upsertSlotCentering:282` | 센터링 `pan/tilt/zoom`(nullable) | 동일 패턴 |

정수 컬럼(`img_w/img_h/slot_id/centered`)·문자 컬럼은 무변경.

### 갱신된 테스트 4 + 신규 테스트 1

| 파일 | 변경 |
|---|---|
| `test/centeringSlot.test.ts` | 기대값을 `round5(item.ptz.*)`로 갱신 |
| `test/checkpointFinalizer.test.ts` | 기대값을 `stringify5` 왕복값과 비교하도록 갱신 |
| `test/finalizerFloor.test.ts` | 기대 좌표를 5자리로 갱신 |
| `test/slot3dFrontCenter.test.ts` | `toBeCloseTo(...,9)` → 정확 일치(`toBe`) 비교로 강화 |
| `test/round5.test.ts`(신규) | round5/stringify5 단위 16건 + DB·파일 왕복 4건, 총 20건 |

### 기존 data 파일 일회성 정규화 (프로덕션 코드 무관)

| 파일 | 6자리+ before → after |
|---|---|
| `data/setup_artifact.json` | 308 → 0 |
| `data/slot_ptz.json` | 0 → 0 |
| `data/Place01/PtzCamRoi.json` | 42 → 0 |

`scratchpad/normalize5.mjs` 일회성 스크립트로 재기록(빌드된 `dist/src/util/round.js` 재사용, 로직 복제 없음). `data/setup_artifact.EMPTY_BACKUP_20260716.json`은 백업이라 미변경.

## 의도적 제외(무변경) 지점

`brain/AgentRuntime.ts`(LLM 프롬프트), `mcp/server.ts`(MCP 응답), `clients/CameraClient.ts`·`clients/CRpcClient.ts`(네트워크 명령 body), `config/settingsStore.ts`(설정 파일), `capture/CaptureJob.ts:556`(`GET /capture/occupancy` 응답 — 휘발성이고 정수/불리언뿐이라 실질 무영향). 전송·설정·제어 정밀도 보존을 위해 그대로 둠.

## `@parkagent/types` 등 공유 타입 파급

- 이번 변경은 타입·스키마·REST 필드 shape을 전혀 건드리지 않는다. `SlotSetupRow`/`SlotSetupView`(`src/capture/types.ts`)의 필드 구성은 그대로이며, 값의 **정밀도만** 축소되었다.
- `@parkagent/types` 공유 패키지, `SlotState`/`ParkingEvent` 등 도메인 타입에는 영향 없음(SettingAgent 로컬 영속화 경로 전용 변경).
- ActionAgent/DMAgent가 `GET /capture/slots`, `setup_artifact.json`, `camerapos.json` 등을 소비하는 경로가 있더라도, 응답 shape·키가 동일하고 숫자 값만 소수점 5자리로 잘리므로 **파싱·로직 파급 없음** — 다만 이번 세션에서 다른 에이전트 코드를 교차 확인하지는 않았다(아래 "확인 필요" 참조).

## REST 계약 변경 파급

- 계약(필드 shape) 변경 없음. `PUT /capture/place-roi` 응답 본문의 숫자 정밀도만 축소.
- 기존 계약 테스트(`placeRoiRoutes`, `placeRoiUpdate` 등)는 값 비교가 아니라 range/shape 비교 위주였던 항목은 통과, 정확 비교였던 항목은 픽스처가 이미 5자리 이하라 영향 없었음(qa 확인, 전부 통과).

## 정밀도 영향

- 좌표(0~2000px 정규화 기준) 5자리 반올림 = 최대 오차 약 0.02px(1920px 기준) — 시각적으로 무해.
- PTZ(pan/tilt/zoom)·각도 값도 동일 수준의 반올림이며 카메라 제어에 영향 없는 수준(제어 명령 자체는 네트워크 경계에서 제외되어 원본 정밀도 유지).

## 소비측 영향

- `setup_artifact.json`/`camerapos.json`/`slot_ptz.json`/`PtzCamRoi.json`을 읽는 뷰어·Action/DM 에이전트는 정밀도만 낮아질 뿐 shape·키는 불변 — 하위 호환.
- DB `slot_setup`/`preset_pos`를 읽는 모든 조회 경로(`getSlotSetup` 등)도 동일하게 하위 호환.

## 규약/리스크 (반드시 인지할 것)

- **`slot_setup` JSON TEXT 5자리 보장은 DB가 아니라 "생산지 규약"으로 성립한다.** `replaceSlotSetup`은 넘어온 TEXT를 재파싱·재반올림하지 않는다. 현재 생산지는 `Finalizer.ts`(6곳) + `migrateToSettingDb.ts`(1곳) 뿐이며, 이들이 모두 `stringify5`를 쓰기 때문에 5자리가 보장된다. **향후 slot_setup TEXT를 새로 쓰는 코드는 반드시 `stringify5`를 사용해야 한다** — 이 규약이 깨지면 조용히 6자리 이상 값이 재유입될 수 있다.
- 라이브 `data/setting.sqlite`에 이미 저장된 기존 행(정규화 스크립트가 손대지 않은 DB 자체 데이터)은, 이번 변경만으로는 즉시 갱신되지 않는다. 다음 `upsertPresetPos`/`replaceSlotSetup`/`upsertSlotCentering` write(예: 다음 finalize·센터링·PTZ 이동)가 발생할 때 비로소 5자리로 갱신된다. 그 전까지는 과거 저장분이 롱플로트로 남아있을 수 있다.

## 검증 결과 인용(qa 실측)

- `npx vitest run`: 162 files / **1787 tests passed, 0 failed**. `npx tsc --noEmit`: 에러 0.
- 구현 단계 실패 4건(`centeringSlot`/`checkpointFinalizer`/`finalizerFloor`/`slot3dFrontCenter`)은 전부 5자리 반올림 기대값 이슈로 확인·갱신(로직 회귀 아님, 검증 의도 유지). `slot3dFrontCenter`는 근사 비교(9자리)→정확 일치로 오히려 강화됨.
- 파리티 테스트 4종(`dbOverlayParity`/`quadCentroidParity`/`globalIdxParity`/`occupancyGeometryParity`, 총 30건)은 저장 반올림과 무관(계산 대상 1e-6 비교)하여 전부 불변 통과.
- 리더 확인: 3개 data 파일 6자리+ 잔존 0건, `PtzCamRoi.json` 프리셋2 순서(idx 8→13) 보존.

## 확인 필요 (단정 보류)

- **실 라이브 DB 전수 스캔 미수행**: `data/setting.sqlite`에 대해 정규식(`\.\d{6,}`) 전수 스캔은 라이브 finalize를 구동하지 않아 이번 세션에서 수행하지 못했다. 검증은 로직 경로(DAO 유닛 테스트 + 임시 파일 왕복)로만 5자리 산출을 증명했다.
- **다른 에이전트(ActionAgent/DMAgent)의 SettingAgent 산출물 직접 소비 여부**는 이번 세션에서 코드베이스 전체를 교차 확인하지 않았다. 값 정밀도만 축소되는 가산적/무해 변경이라는 판단이나, 확정된 사실은 아니다.

## 회귀 여부

- DB 스키마(컬럼·타입·제약) 무변경. 함수 시그니처 대부분 무변경(내부 반올림 삽입만). `finalize-slotsetup-wipe-fragility`(MEMORY) 취약성과는 무관 — round5/stringify5는 값 정밀도만 다루며, DELETE+INSERT 로직·검출 보존 가드는 이번 변경으로 손대지 않았다.
