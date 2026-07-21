# 03 · 검증 리포트 — 영속화 수치 소수점 최대 5자리 정규화

## 결론
**전 테스트 통과.** `npx vitest run` = **162 files / 1787 tests passed (0 failed)**, `npx tsc --noEmit` = **에러 0(exit 0)**.
- 구현자 보고 실패 4건 = 전부 **5자리 반올림 기대값 이슈(로직 회귀 아님)** 로 확정 → 자릿수만 저장 정밀도로 갱신(검증 의도 유지).
- 신규 테스트 `test/round5.test.ts`(20건) 추가.
- 파리티 테스트 4종 전부 불변 통과 확인(저장 반올림과 무관 — 계산 대상 1e-6).

## 1. 실패 4건 근본 원인 분석 + 갱신 내역

각 실패를 열어 **저장경로가 round5/stringify5 를 타서 값의 자릿수만 달라진 것**임을 확인했다(구조·shape·산식 동일). 진짜 로직 회귀는 없음.

| 테스트 | 근본 원인(확인) | 갱신 방향(자릿수 조정, 의도 유지) |
|--------|------------------|-----------------------------------|
| `centeringSlot.test.ts` T7:345 | DB REAL pan/tilt/zoom 이 `upsertSlotCentering`→`round5` 로 저장(`9.999999999999995→10`, `3.722419436408399→3.72242`). in-memory `item.ptz` 는 롱플로트. 경계면 교차 비교 의도는 "동일 PTZ 매핑". | 기대값을 컴포넌트별 `round5(item.ptz.*)` 로. **로직 아님 — 저장 정밀도 정합.** |
| `checkpointFinalizer.test.ts` :207 | `SaveStore.save`→`stringify5` 기록 → 로드본 floorRoi 좌표 5자리(`0.39999999999999997→0.4`, `0.34909999999999997→0.3491`). in-memory `artifact` 는 롱플로트. 구조/키 완전 동일(diff 확인). | 기대를 `JSON.parse(stringify5(r.artifact))`(동일 5자리 정규화 왕복)와 deep-equal. **스냅샷 내용=artifact 검증 의도 유지.** |
| `finalizerFloor.test.ts` :178 | occupyRange TEXT 를 Finalizer 가 `stringify5` 로 기록 → `getSlotSetup` 파싱본 5자리. 기대값 `buildPlateAnchoredQuad(...)` 는 롱플로트(`0.37534470992048313` 등). | 기대를 `JSON.parse(stringify5(buildPlateAnchoredQuad(...)))` 로. **결정형 발자국 산식 검증 유지.** |
| `slot3dFrontCenter.test.ts` :354–355 | `slot3d_front_center` TEXT 를 Finalizer 가 `stringify5` 로 기록 → 저장점 5자리(`0.65728`). 파리티 계산값 `cpx.y/imgH=0.6572774299064489`, 차 ≈2.57e-6 > 기존 허용 5e-10(9자리). | `toBeCloseTo(...,9)` → `toBe(round5(cpx.*/img))` **정확 일치**. 9자리 근사→저장 정밀도 정확비교(오히려 강화). **배선 정합 검증 유지.** |

- 갱신은 전부 **기대값을 저장 정밀도(round5/stringify5)로 맞춘 것**이며, 임계값을 무의미하게 느슨하게 풀거나 검증 대상을 제거하지 않았다. `slot3dFrontCenter` 는 근사(9자리)→정확일치로 오히려 강해졌다.

## 2. 신규 테스트 `test/round5.test.ts` (20건, 전부 통과)

1. **round5 단위(11)**: `0.11182877131922099→0.11183`, `0.5→0.5`/`0.10000→0.1`(뒤0 없음), 정수(`5/0/-3`) passthrough, 비유한(`NaN/±Infinity`) passthrough, null/undefined passthrough, 음수 롱플로트, 경계 `0.000005→0.00001`·`0.0000049→0`, `.5` round-half-up(`0.123455→0.12346`), 이미 5자리 이하 불변, 무작위 500표본 6자리+ 0건.
2. **stringify5(5)**: 중첩 객체/배열 전 숫자 5자리(재귀), 문자열·불리언·null·정수 보존, **Date→ISO 문자열 보존**(숫자 변환 안 함), indent pretty 유지, 출력 문자열 6자리+ 정규식(`/\.\d{6,}/`) 0건.
3. **DB 왕복(3)**: `upsertPresetPos`(preset_pos REAL round5, raw 조회), `replaceSlotSetup`(REAL round5 + stringify5 생산 TEXT 왕복 ≤5자리 — roi/occupyRange/slot3dFrontCenter), `upsertSlotCentering`(부분 UPDATE REAL round5).
4. **JSON 파일 라이터(2)**: `slotPtzWriter`(slot_ptz.json), `cameraposWriter`(camerapos.json) — 임시 경로 기록 후 파일 텍스트 6자리+ 0건 + 파싱값 검사.

## 3. 경계면 교차 검증(shape 대조)

- **DB DAO ↔ 소비자(slot_ptz JSON item.ptz)**: `centeringSlot` T7 이 `{pan,tilt,zoom}`(DB REAL, round5) ↔ `item.ptz`(JSON 롱플로트) 를 정수 `slot_id=globalIdx` 매핑으로 대조 → 저장 정밀도 차이만 존재(값·매핑 정합). 갱신 후 정합 확인.
- **표시(web/core.js) ↔ 저장(src/ground/project.ts)** `slot3dFrontCenter`: `FRONT_FACE_IDX [0,3,7,4]` 동일, 정규화 0~1 규약, 파리티 1e-6. round5 는 **저장 경계에만** 삽입 → 표시/계산 파리티(`frontFaceCenter` ↔ `frontFaceCenterPx/img`)는 1e-6 유지, 저장점만 round5. 파리티 테스트 22건 전부 통과.
- **JSON TEXT 생산지 규약**: `replaceSlotSetup` 은 넘어온 TEXT 를 재파싱·재반올림하지 않음 → 5자리 보장은 "생산지가 stringify5 사용"으로 성립(Finalizer/migrate). DB 왕복 테스트는 이 규약(생산지 stringify5)을 그대로 재현해 검증.

## 4. 불변 확인(회귀 없음)

- **파리티 4종 전부 통과·불변**: `dbOverlayParity`(2), `quadCentroidParity`(11), `globalIdxParity`(9), `occupancyGeometryParity`(8). round5 는 영속화 경계 전용, 파리티는 저장 전 계산값(core.js↔project.ts 1e-6) 비교라 무영향 — 예상대로 불변.
- 설계서 §4 "재확인" 후보 중 실제 실패는 위 4건뿐. `placeRoiRoutes`/`placeRoiUpdate`/`migrateToSettingDb`/`sqliteStore`/`repository`/`saveStore`/`cameraposWriter`/`slotPtzWriter`/`ptzCalibrator` 등은 픽스처가 5자리 이하이거나 range/shape 비교라 불변(전부 통과).

## 5. 수행 못 한 검증(한계 — 명시)

- **실데이터 스모크(§3 실데이터 자릿수 검사)**: `data/*.json` 3파일 일회성 정규화 결과(6자리+ 0건)는 구현자 보고(`02_developer_changes.md` 표)에 근거하며, 본 검증은 **로직 경로(라이터/DAO 유닛 + 임시파일 왕복)** 로 5자리 산출을 증명. 실 `data/setting.sqlite` 덤프 전수 정규식 스캔은 별도 스모크로 미수행(라이브 finalize 미구동).
- 외부 REST(VPD/LPD/VLA 등) 미가동 — 본 변경은 영속화 경계 전용이라 외부 연동 스모크 대상 아님.

## 6. 변경 파일(테스트)

- 갱신: `test/centeringSlot.test.ts`, `test/checkpointFinalizer.test.ts`, `test/finalizerFloor.test.ts`, `test/slot3dFrontCenter.test.ts` (각 import 1줄 + 기대값 자릿수 조정).
- 신규: `test/round5.test.ts` (20건).
- 프로덕션 소스 무수정(검증만).
