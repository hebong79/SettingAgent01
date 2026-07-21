# 04. 영향도 분석 — 센터라이징 소스 전환(setup_artifact → slot_setup)

작성: 문서화 담당(documenter)
최종 문서: `SettingAgent/docs/20260718_112319_센터라이징_slot_setup소스전환.md`

---

## 1. 모듈/의존성 그래프 영향

| 변경 지점 | 영향 |
|---|---|
| `PtzCalibrator` ↔ `SqliteStore` | 신규 필수 의존 `getSlotSetup` 추가(기존 `upsertSlotCentering`에 병합). `store` 옵셔널→필수 전환으로, `store` 없이 `PtzCalibrator`를 생성하는 코드는 **컴파일 에러**가 된다. 전 소스 grep 기준 생성 지점은 `src/index.ts`(1곳, 이미 `store: sqlite` 주입) + 테스트 4파일뿐 — 프로덕션 생성 지점 영향 없음. |
| `PtzCalibrator` ↔ `Repository` | 의존 완전 제거(`repo` dep/field/import). `Repository` 타입 자체는 `server.ts`/`index.ts`/`Finalizer` 등에서 계속 광범위 사용 — **전역 영향 없음**, `PtzCalibrator` 국소 import만 제거됨. |
| `slotPtzWriter.ts` | `SlotSetupView`(`../capture/types.js`) import 추가. 기존 `expandPlateTargets`/`writeSlotPtz`/`SetupArtifact` import는 유지(하위 호환). |
| `src/index.ts` | `PtzCalibrator` 생성자 호출 인자에서 `repo` 제거. `repo` 지역 변수 자체는 orchestrator/Finalizer/buildServer에서 계속 사용 — 조립부 다른 라인 영향 없음. |
| `calibrateRoutes`(`src/api/server.ts`) | **불변** — `/calibrate/*` 라우트 코드 자체는 이번 변경에서 건드리지 않음. `PtzCalibrator` 생성 시그니처만 바뀌었으므로 라우트 레이어는 영향 없음. |

## 2. REST 계약 영향

- `POST /calibrate/ptz`(start), `GET /calibrate/status`, `GET /calibrate/result`의 응답 shape·상태 코드(200/404/409/400)는 **불변**.
- 의미 변화 1건: `total`(start 응답) 및 `result.items[].slotId`가 "artifact 펼침 수/키" → "lpd 보유 slot_setup 수 / `String(정수 slot_id)`"로 바뀜. 구 형식(`'c1p1s1'`)을 문자열 파싱하던 클라이언트가 있다면 영향받는다 — QA 경계면 교차 검증에서 REST 단언·`slotIds` 필터·DB 매핑 전 지점이 일관되게 신 형식을 반영함을 확인(불일치 0건).
- 실제 REST 클라이언트/뷰어 코드에서 `slotId` 형식을 문자열 패턴(`c{n}p{n}s{n}`)으로 파싱하는 소비처가 있는지는 **확인 필요**(이번 세션 범위 밖 — SettingViewer/ActionAgent 쪽 grep 미수행).

## 3. 하위 소비자 영향

- `slot_ptz.json`(writer 산출물): 저장 경로·writer 로직 불변. 다운스트림 소비자(있다면) 영향 없음.
- `slot_setup` 테이블(pan/tilt/zoom/centered 컬럼): 이번 전환으로 처음 실질적으로 채워지기 시작함(라이브 확인 §6). ActionAgent가 향후 이 컬럼을 PTZ 소스로 소비할 계획이라면, "채우는 방식"(부분 UPDATE, slot_id 키, centered=1 플래그)은 이미 기존 `upsertSlotCentering` 계약 그대로이므로 ActionAgent 측 신규 대응은 불필요할 것으로 판단되나, **ActionAgent 실 코드 기준 확인은 이번 세션에서 미수행**.

## 4. 선행 의존(순서 제약)

센터라이징은 `slot_setup.lpd_obb`가 이미 채워져 있어야 대상이 생긴다. 즉 **정밀수집 → finalize**로 LPD(번호판 OBB) 검출·저장이 선행되어야 하며, 이 순서가 지켜지지 않으면(`slot_setup`이 비었거나 lpd 전부 null) `POST /calibrate/ptz`는 예외 없이 `total=0`으로 조용히 완료된다. 이는 설계 의도된 동작(빈 대상 = 정상 완료)이나, 운영 시 "정밀수집을 안 했는데 센터라이징이 아무 것도 안 한다"는 오인 소지가 있어 문서에 명시했다.

## 5. 위험 / 한계

- **lpd_obb 없는 슬롯은 센터라이징 대상에서 제외**된다(설계 의도, 결함 아님). 번호판이 각도상 검출되지 않는 슬롯은 영구히 센터라이징되지 않을 수 있음 — 별도 이슈로 다룰지는 확인 필요.
- **`PtzCalibrator.saveCenteringSlots`의 `if (!this.store) return;`**: `store` 필수화로 인해 이 분기는 이제 도달 불가능한 죽은 코드가 됐다. 설계서가 해당 함수를 "불변"으로 지정해 구현자가 그대로 뒀다(외과적 변경 원칙). 런타임 동작에는 영향 없음(무해) — 정리 여부는 리뷰어 판단 사항으로 남겨둠.
- **`expandPlateTargets`(구 소스, @deprecated) 존치**: 런타임 소비처는 0(PtzCalibrator가 신 함수로 전환 완료)이나, exported 공개 함수라 회귀 테스트(`slotPtzWriter.test.ts`, `centeringSlot.test.ts` T9)가 계속 참조 중. 완전 삭제는 이번 작업 범위 밖 — 별도 정리 작업으로 남겨둠.

## 6. 테스트 영향 범위

설계서가 지목한 2파일(`ptzCalibrator.test.ts`, `calibrateRoutes.test.ts`) 외에, `repo`→`store` 시그니처 전환의 실제 파급으로 `centeringBoundary.test.ts`·`centeringSlot.test.ts` 2파일이 추가로 컴파일 깨짐 → 개편 대상이 됐다(설계 단계에서 under-scope로 파악됐던 부분, 구현자가 발견해 QA로 이관, QA가 런타임 개편까지 완료). 최종 4개 테스트 파일 + 신설 `slotPtzWriter.test.ts` 병합 개편, 전체 153 files/1707 tests 그린.

## 7. 확인 필요(단정 보류)

- SettingViewer/ActionAgent 등 외부 소비자가 `item.slotId`를 구 문자열 형식(`c{camIdx}p{presetIdx}s{n}`)으로 파싱하는 코드가 있는지 — grep 미수행, 있다면 이번 의미 변화로 영향받음.
- lpd 미검출 슬롯의 영구 미센터링에 대한 운영 정책(재시도/알림 등) — 이번 작업 범위 밖, 설계 의도 확인만 완료.
