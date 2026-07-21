# 04 문서화·영향도 분석 — 정밀수집 LPD 검지 3모드 콤보박스

> 작성일: 2026-07-19 19:19:14
> 최종 문서: `docs/20260719_191914_LPD검지_3모드콤보박스_구현.md`
> 근거: 설계서(`docs/20260719_185846_...`), 구현노트(`_workspace/02_developer_changes.md`), QA리포트(`_workspace/03_qa_report.md`) + 실 소스/테스트 재확인.

## 1. 변경 파일·라인 (실 소스 대조 확정)

| 파일 | 변경 | 확정 라인 |
|---|---|---|
| `web/index.html` | `cap-actions` 툴바(178-183)에 시작/정지/최종화/초기화 4버튼만 유지, `#cap-detect-run`·`#cap-vpd-test` 2버튼 제거됨(현재 파일에 부재 확인) → 아래 신규 라인(184-199): `#lpd-mode`(3옵션 select) + `#lpd-run` + `#disc-bar`/`#disc-label`/`#disc-msg` | 178-199 |
| `web/app.js` | `runModeLpd()`(2369-2379) / `runModeVpd()`(2380-2385), disc 상태변수·`discFrameTick`(2275)/`startDiscFramePolling`(2290)/`stopDiscFramePolling`(2299)/`discStart`(2306)/`discPoll`(2325)/`renderDiscResult`(2359), `#lpd-run` 디스패처(3338-3342), `startCapFramePolling`(1888)·`startCalFramePolling`(2182)에 `stopDiscFramePolling();` 각 1줄 | 1888, 2182, 2275-2385, 3338-3342 |
| `web/core.js` | `discoverView(status)` 순수 함수 추가 | 147-165 |
| `web/core.d.ts` | `discoverView` 시그니처 선언 추가 | 72-77 |
| `src/api/discoverRoutes.ts`·`src/calibrate/PlateDiscoveryJob.ts`·`src/calibrate/types.ts`·`src/index.ts`·`server.ts` | **무수정 확인**(grep/git diff 대상 외) | - |

## 2. 백엔드 무수정 확인

`git diff --stat`에서 이번 작업 관련 변경은 `web/index.html`·`web/app.js`·`web/core.js`·`web/core.d.ts` 4개 파일에만 국한됨을 확인. `src/api/discoverRoutes.ts`·`src/calibrate/PlateDiscoveryJob.ts`·`src/calibrate/types.ts`는 이번 세션 워킹트리 변경 목록에 없다(설계서 §5·구현노트 §1과 일치). `/discover/*` REST 계약(`POST /discover/ptz`→`{ok,started,total}`/409, `GET /discover/status`→`DiscoverStatus{state,done,total,found}`, `GET /discover/frame`→blob)은 그대로 재사용됐다.

## 3. 2버튼 제거 파급 (다른 참조 0)

`grep -rn "cap-detect-run|cap-vpd-test"` 전체 프로젝트 결과: 남은 매치는 `web/app.js`의 **주석**(`// 모드 (a): ... 기존 cap-detect-run 본문 이사`, `// 모드 (c): ... 기존 cap-vpd-test 본문 이사`, 코드 참조 아님)과 과거 설계/문서 파일(`docs/`, `_workspace_prev_*`, `_work_old/`)뿐이다. **활성 코드·활성 테스트에서 두 ID를 소비하는 곳은 0** — 버튼 제거가 다른 기능을 깨뜨릴 경로가 없다.

## 4. discovery 잡 재사용

`discStart()`가 호출하는 `POST /discover/ptz`는 기존 `PlateDiscoveryJob.start(undefined)` → `expandDiscoveryTargets`(슬롯 중 `slot3d_front_center` 보유 대상 전체 배치)를 그대로 트리거한다. 센터라이징(`calStart`)과 동일하게 body `{}` 전체 배치 방식이라 신규 백엔드 분기가 없다. 진행 표시(`discoverView`)·프레임 추종(`discFrameTick`)은 기존 `calPoll`/`calFrameTick`의 순수 미러 구조이므로 백엔드 상태 shape(`DiscoverState`)이 바뀌지 않는 한 프론트 영향은 이 4파일에 갇혀 있다.

## 5. 회귀 0 근거 (7건 flaky 판정 포함)

- **신규 테스트**: `test/discoverView.test.ts` 11/11 PASS — 본 문서화 단계에서 직접 재실행하여 재확인(`✓ test/discoverView.test.ts (11 tests) 4ms`, `Tests 11 passed (11)`).
- **전량 회귀**: QA가 클린 단독 재실행 2회 연속 172파일/1922테스트 전부 통과(회귀 0) 확인.
- **초기 7건 실패 판정**: 최초 실행 시(`tsc`‖`vitest` 병렬 구동) `cameraMode.test.ts`(3)·`settingsFormErrors.test.ts`(1)·`sourceRegistry.test.ts`(3) 실패. QA가 다음 근거로 이 작업과 무관함을 확정:
  1. import 그래프상 두 파일이 `../src/viewer/sourceRegistry.js`만 참조 — `web/` 참조 0(구조적으로 프론트 변경이 닿을 경로 없음).
  2. `git stash`로 프론트 4파일을 HEAD(콤보박스 이전)로 되돌려도 동일 파일들이 실패/통과 패턴 유지(프론트 변경 유무가 원인이 아님, 원인은 워킹트리의 별개 미커밋 카메라소스 리팩터 상태).
  3. 해당 3파일만 격리 단독 실행 시 32/32 전부 통과.
  4. vitest 단독 클린 재실행 시 7건 실패 소멸, 172/172 통과.
  → 판정: 전량 동시 실행 + 무거운 프로세스 병렬 구동 시 공유 `config/tools.config.json`/`data/` 상태 경합에 의한 **flakiness**이며, 이 작업(LPD 콤보박스)의 회귀가 아니다.
- **tsc**: `npx tsc --noEmit` EXIT 0.

## 6. 남은 한계 (확인 필요 항목 포함)

- **discovery 실 검지율**: 실 LPD(da_lpd_api)·실 카메라 가동 환경에서의 실제 구제율은 미관찰(범위 밖, 선행 문서와 동일 한계).
- **DOM 디스패치·폴 상태전이·3자 상호배타 배선**: vitest 범위 밖. QA는 "리더 라이브 검증 완료 통지 수신"으로 기록했으나, **본 문서화 에이전트는 그 라이브 관찰 원본(로그/스크린샷)을 직접 확인하지 못했다** — 확인 필요.
- **백엔드 카메라소스 테스트 스위트 flakiness**(`cameraMode`/`sourceRegistry`/`settingsFormErrors`): 이 작업과 무관하나 별도 안정화가 필요한 기존 이슈로, 이번 범위에서는 손대지 않음.

## 7. 최종 산출물

- 한글 문서: `docs/20260719_191914_LPD검지_3모드콤보박스_구현.md`
- 본 영향도 요약: `_workspace/04_doc_impact.md`(본 파일)
