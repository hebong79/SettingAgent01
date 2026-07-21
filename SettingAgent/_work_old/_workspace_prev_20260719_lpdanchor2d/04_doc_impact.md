# 04 문서화·영향도 요약 — discovery 현재 프리셋 한정 + LPD 박스 표시

최종 문서: `docs/20260719_200525_discovery_현재프리셋한정_박스표시_구현.md`

## 변경 4파일 · 라인(실측)

| 파일 | 라인 | 내용 |
|---|---|---|
| `src/api/discoverRoutes.ts` | 6-12, 32 | `StartBodySchema`에 `cam`/`preset` 옵셔널 2필드, `start(parsed.data)` 객체 전달 |
| `src/calibrate/PlateDiscoveryJob.ts` | 111, 114-117 | `start(filter)` 시그니처, `cam!=null && preset!=null` 게이트로 프리셋 필터 삽입(expandDiscoveryTargets 직후·slotIds 필터 앞) |
| `web/app.js` | 100, 2325~, 2381-2399, 908-909 | `discoverByKey` 상태 필드, discStart body(cam/preset), renderDiscResult result 파싱·대체저장, drawDetectOverlay 렌더(`#roi-plate` 게이트 공유) |
| `test/discoverRoutes.test.ts` | describe "현재 프리셋 한정" | 개발 4케이스 + QA 보강 4케이스(부분지정 게이트 실증) = 8케이스 |

## 불변 확인(코드 직접 대조)

- `expandDiscoveryTargets`(`src/calibrate/plateDiscoveryWriter.ts`): 필터가 이 함수 호출 **이후** 위치에 삽입되어 함수 자체 무변경. 확인 완료.
- `PtzCalibrator.ts`: discovery 필터·렌더와 무관 경로, 이번 변경 무접촉. (git status상 M 이지만 이는 선행 커밋들에서 이어진 상태이며 이번 discovery 작업이 만든 변경이 아님 — grep으로 discStart/PlateDiscoveryJob 관련 코드 없음 확인.)
- `src/calibrate/types.ts`·`plateDiscovery.ts`(`lpdOrig`): 기존 산출 필드 재사용만, 신규 로직 없음.
- `web/index.html`·`web/core.js`·`web/core.d.ts`: 무접촉(콤보박스·폴링은 선행 완성분).
- `slot_setup.lpd` 부분 UPDATE(`upsertSlotLpd`): 저장 경로 무접촉, wipe 금지 정책(MEMORY: finalize slot_setup wipe fragility) 유지.

## 회귀 0 근거

- `npx vitest run test/discoverRoutes.test.ts` → 16/16 통과(QA 보강 반영, `_workspace/03_qa_report.md` §1).
- `npx vitest run --no-file-parallelism`(직렬 전량) → **172 파일 / 1934 테스트 전량 통과**, 65.56s. flaky 7건(config/cameraMode/cRpcClient)은 병렬 자원경합 기인, 직렬 재현 0 실패로 소스 결함 아님 확인(QA §3).
- `npx tsc --noEmit` exit 0, `node --check web/app.js` APP_JS_OK.
- REST 계약 변경은 additive(`cam`/`preset` 옵셔널 추가)라 기존 빈 body 호출자 회귀 없음. `PlateDiscoveryJob.start` 시그니처 변경 호출부는 `discoverRoutes.ts` 1곳(개발자 보고 grep 근거, 문서화 단계 재confirm 안 함 — 확인 필요 항목).

## 파급 범위

- REST 계약(`POST /discover/ptz` body)에 `cam`/`preset` 필드 추가 — 클라이언트는 `web/app.js`(discStart) 1곳뿐, 다른 REST 클라이언트/외부 소비자 없음(확인 필요: 코드베이스 전역 grep은 개발자/QA 보고 인용이며 documenter가 재검색은 안 함).
- 공유 도메인 타입(`SlotState`/`ParkingEvent` 등) 변경 없음 — `PlateDiscoveryItem`(types.ts) 스키마 무변경, `lpdOrig` 필드 기존 그대로 재사용.
- `@parkagent/types` 패키지 변경 없음 — 타 에이전트(ActionAgent/DMAgent) 전파 없음.

## 남은 한계(정직 리포트, 완료로 위장하지 않음)

- 박스의 실제 canvas 픽셀 렌더·`#roi-plate` 해제 시 은닉·프리셋 전환 시 은닉/복귀는 DOM 필요 — vitest 범위 밖, 이번 세션 리더 라이브 관찰 미수행.
- discovery 실 검지율은 실 LPD 서비스·카메라 필요 — 유닛은 시임(foundItem) 대체, 미관찰.
- QA 지적: 정밀수집 순환 중(`capFrameTimer` 활성) 저장키(discStart의 `capFrameKey2?.cam ?? state.cam` 무조건)와 조회키(`currentFrameKey`의 `capFrameTimer && capFrameKey2` 조건부) 비대칭 가능성 — 단, 기존 `detectByKey`/`runLiveDetect`가 이미 가진 키 시맨틱 상속이라 신규 결함 아님(QA 결론). 순환 뷰 상태에서의 표시 일치는 리더 라이브 sanity 확인 권고로 남김.
