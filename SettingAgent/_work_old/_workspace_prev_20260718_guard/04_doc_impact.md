# 04 영향도 분석: finalize 방어 가드 (검출 없는 슬롯 vpd/lpd/occupy 보존)

작성: 문서화 담당(documenter). 최종 문서: `docs/20260718_201025_finalize검출보존_방어가드.md`

## 변경 범위
- `src/capture/Finalizer.ts` 단일 파일, `Finalizer.finalize`의 slot_setup 행 조립부 3곳(외과적):
  1. import에 `SlotSetupView` 추가.
  2. `existingBySlot`(slotId → SlotSetupView) 사전 조회 1회 추가.
  3. `vpdBbox`/`lpdObb`/`occupyRange` 세 필드에 `hit ? 새값 : (prev?.* ? 기존값 재직렬화 : null)` 3분기 추가.
- 부수: `test/dbOverlayParity.test.ts`(직전 세션 산출물, 미추적 파일)의 선행 타입에러 2건 정리(import 출처 교정 + 최소 캐스트). 프로덕션 코드 무변경.

## 직접 영향 모듈
- **`Finalizer` (src/capture/Finalizer.ts)**: 유일한 변경 지점. `finalize()`의 slot_setup 조립 로직만 변경, 클래스 외부 인터페이스(생성자 deps, `finalize()` 시그니처·반환값) 불변.

## 무영향 확인 (시그니처·계약 불변)
- **`SqliteStore.replaceSlotSetup`/`getSlotSetup`** (src/capture/SqliteStore.ts): 시그니처·전량교체 시맨틱 변경 없음. `Finalizer`는 두 메서드를 기존과 동일하게 호출만 추가(`getSlotSetup` 1회 더 호출)했을 뿐 계약 변경 없음.
- **`migrateToSettingDb.ts`**: `replaceSlotSetup`/`getSlotSetup` 사용처이나 이번 변경과 무관한 별도 마이그레이션 경로 — 무영향.
- **`PtzCalibrator.ts` / `slotPtzWriter.ts`** (센터라이징 경로): `getSlotSetup`을 읽어 pan/tilt/zoom 등을 다루나, 이번 가드는 검출 컬럼(vpd/lpd/occupy)만 다루고 센터라이징 컬럼은 손대지 않음 — 동작 무영향. 단, §한계 항목의 "센터라이징 컬럼 동일 취약점"은 이 두 모듈이 다루는 데이터와 직결되므로 후속 검토 시 우선 확인 대상.
- **`captureRoutes.ts`** (`GET /capture/slots` 등): `getSlotSetup` 응답 shape 불변이므로 REST 계약·클라이언트(`web/app.js`) 무영향.
- **REST 계약**: 엔드포인트 경로/요청/응답 스키마 변경 없음. 클라이언트가 관찰하는 차이는 오직 "hit 없는 슬롯의 vpd/lpd/occupy 값이 이후 finalize에서도 유지된다"는 데이터 내용뿐, 스키마 변경 아님.
- **공유 도메인 타입(`@parkagent/types`, `src/domain/types.ts`)**: 이번 변경에서 미수정. `SlotSetupRow`/`SlotSetupView`(src/capture/types.ts, capture 로컬 타입) 필드 구성도 불변 — import만 1개(`SlotSetupView`) 추가.
- **타 테스트**: `finalizerParkingSlots.test.ts`, `finalizerFloor.test.ts`, `sqliteStore.test.ts`, `captureRoutes.test.ts` 등 기존 테스트 전량 그린(회귀 0, QA 확인).

## 동작 영향
- **해피패스(전 슬롯 hit)**: 기존과 바이트 동일 — 회귀 없음(QA 케이스2 확인).
- **부분 finalize(일부 슬롯 무-hit)**: 무-hit 슬롯이 stale(과거) 검출값을 보존 — 파괴보다 안전한 선택. slot_setup은 "참조용 검출 스냅샷" 성격이라 완전 클린 재캡처로 언제든 갱신 가능(설계서 근거).
- **best-effort 격리**: 병합 조회·조립 전부 기존 try/catch(§231, artifact 저장 보호 블록) 안에 위치 — 예외 발생 시에도 artifact 저장·finalize 성공 자체는 불방해(기존 격리 정책 유지).
- **config/어셈블리**: 변경 없음. package.json/tsconfig/의존성 목록 무변경.

## 잠재 리스크
- 무-hit 슬롯이 오래된(stale) 검출값을 계속 보존할 수 있음 — 그러나 이는 이전의 "즉시 null 파괴"보다 명백히 안전하며, 정상 재캡처(clean finalize, 전 슬롯 hit)로 자연 갱신됨.
- 센터라이징 컬럼(pan/tilt/zoom/centered/img1)에 동일한 파괴 패턴이 구조적으로 남아있음 — 이번 스코프 밖으로 확정하고 후속 검토 항목으로 명시(확인 필요).
- `accepted=0`의 상위 원인(clusterMinSupport 미달/주차면 필터·정합)은 데이터·런타임 요인으로, 이번 코드 변경으로 해소되지 않음 — 실 DB의 기존 null 값 복구는 별도의 정상 재캡처가 필요(확인 필요 아님, 설계서에 명시된 기지 사실).

## 검증 근거 (검증자 실행 결과 인용)
- `npm run typecheck`: exit 0.
- `npx vitest run`: Test Files 157 passed / Tests 1734 passed, 실패 0.
- 신규 `test/finalizerPreserveDetection.test.ts` 4케이스 전부 통과.
