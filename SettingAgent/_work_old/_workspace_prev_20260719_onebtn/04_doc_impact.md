# 04. 영향도 분석 — 원버튼 셋업 파이프라인 (수집→최종화→센터라이징 자동 연쇄)

**작성**: documenter, 2026-07-19 14:36
**최종 구현 문서**: `SettingAgent/docs/20260719_143601_원버튼셋업파이프라인_구현.md`
**참조**: 설계서 `docs/20260719_130352_원버튼셋업파이프라인_설계서.md`, 구현 노트 `_workspace/02_developer_changes.md`, 검증 리포트 `_workspace/03_qa_report.md`

---

## 1. 변경 파일·함수 (소스 직접 확인)

| 파일 | 변경 종류 | 함수/영역 |
|------|-----------|-----------|
| `src/pipeline/SetupPipeline.ts` | **신규**(169줄) | `SetupPipeline` 클래스 전체 — `onCaptureStart`/`onCaptureFinished`/`onCalibrateFinished`/`isBusy`/`getStatus`/`runFinalizeThenCalibrate`(private) |
| `src/capture/CaptureJob.ts` | 가산 | `CaptureJobDeps.onFinished?`(:51), `finishRun()`(:274-283) 말미 try/catch 콜백 호출 |
| `src/calibrate/PtzCalibrator.ts` | 가산 | `PtzCalibratorDeps.onFinished?`(:38), private `onFinished` 필드(:66), `run()` done/error 경로 → `notifyFinished()`(:152-158) |
| `src/api/captureRoutes.ts` | 가산 | `StartBodySchema.autoChain?`(:51), `CaptureRouteDeps.pipeline?`(:126-127), start 핸들러 409 가드(:171-174)·`onCaptureStart` 배선(:187), `GET /capture/pipeline`(:198-201) |
| `src/api/server.ts` | 가산 | `ApiDeps.pipeline?`(:88-89), `registerCaptureRoutes` 전달(:255) |
| `src/index.ts` | 가산 | 클로저 전방참조 조립(:61-98) — `let pipeline` 선언 → captureJob/calibrator `onFinished` 클로저 → `pipeline = new SetupPipeline(...)` |
| `web/index.html` | 가산 | 체크박스 `#cap-autochain`(:176, 기본 unchecked) |
| `web/app.js` | 가산 | `capStart()` 바디 `autoChain`(:2057)·`prevPipelineStage` 리셋(:2059), `pollPipeline()`(:1998-2036), `capPoll` 체인-폴 유지(:1982-1990) |
| `test/setupPipeline.test.ts` | 신규(303줄, 15케이스) | T1~T8 + coverage/isBusy/콜백가드 |
| `test/captureRoutes.test.ts`, `captureJob.test.ts`, `ptzCalibrator.test.ts` | 가산(+7/+2/+1) | autoChain 배선·라우트 shape·콜백 throw 흡수 |

> 세션 시작 시점 git status에 이미 M으로 있던 파일(`calibrateRoutes.ts`, `platePtz.ts`, `slotPtzWriter.ts`, `Finalizer.ts`, `SqliteStore.ts`, `types.ts`, `ground/project.ts`, `cameraposWriter.ts`, `Repository.ts`, `SaveStore.ts`, `migrateToSettingDb.ts`, `core.js`, `core.d.ts` 등)은 **브랜치 선행 변경**으로 이번 파이프라인 작업과 무관하며 손대지 않았음을 소스 확인으로 재확인.

---

## 2. 회귀 위험 및 방지 근거

| 위험 | 방지 메커니즘 | 근거 |
|------|--------------|------|
| 수동 3버튼 흐름이 자동 체인 도입으로 깨질 위험 | `onFinished?`/`pipeline?`가 전부 **옵셔널** — 미주입/비무장이면 완전 no-op. `SetupPipeline.onCaptureFinished`도 `!this.armed \|\| stage!=='capturing'` 이면 즉시 return | `CaptureJob.ts:51,277-283`, `PtzCalibrator.ts:38,152-158`, `SetupPipeline.ts:78-79,99-100` |
| 콜백이 잡을 죽일 위험(throw 전파) | `finishRun`/`notifyFinished` 각각 try/catch로 콜백 예외를 흡수하고 warn 로그만 남김(T9로 검증) | `CaptureJob.ts:278-282`, `PtzCalibrator.ts:153-157` |
| `CaptureStatus`/`CalibrateStatus` 응답 shape 변경 | 무변경 확인 — `getStatus()` 시그니처·필드 소스 재확인, 신규 필드는 전부 `GET /capture/pipeline`(별도 라우트)에만 존재 | `CaptureJob.ts:184-202`, `PtzCalibrator.ts:91-100`(변경 없음) |
| 기존 테스트가 신규 옵셔널 dep 미전달 시 깨질 위험 | 기존 테스트 파일 **무수정**으로 전체 통과 확인(1808→1833, +25만 순수 가산) | `_workspace/03_qa_report.md` §2b |
| `POST /capture/start` 기존 호출자(바디에 `autoChain` 미포함)가 영향받을 위험 | `autoChain: z.boolean().optional()`이며 `parsed.data.autoChain ?? false`로 처리 — 미지정 시 `onCaptureStart(false)`만 호출(pipeline 미주입이면 이마저 옵셔널 체이닝으로 스킵) | `captureRoutes.ts:51,187` |
| finalize 데이터 파괴(F10, 메모리 [[finalize-slotsetup-wipe-fragility]]) | 자동 체인 경로에서 `dets.length===0`이면 `finalizer.finalize`를 **호출 자체를 하지 않음** — QA가 스파이 0회로 봉인 | `SetupPipeline.ts:90-93`, `_workspace/03_qa_report.md` §4 |

**결론**: 옵셔널·가산 방식으로 구현되어 기존 수동 경로에 대한 회귀 위험은 구조적으로 낮다. 단, 이 판단은 vitest 회귀 스위트(1833건) 및 자체 검증 범위 내에서의 결론이며, 아래 §5의 라이브 미관찰 한계는 그대로 남는다.

---

## 3. 소비처 영향 (주차장관리 에이전트 MCP 연계 관점)

- 저장소 전체(`ParkAgent/` 하위 49개 파일)에서 `capture/start|capture/pipeline|capture/finalize` 문자열을 검색한 결과, **SettingAgent 자체(src/web/test)와 문서 파일 외에는 참조하는 소비 코드가 없음**을 확인했다. 즉 ActionAgent/DMAgent 또는 별도 MCP 도구 정의에서 이 라우트를 아직 호출하는 코드는 존재하지 않는다 — **현재 시점 실제 소비처는 0건**.
- 이번 변경의 설계 의도(설계서 §2 결정 근거)는 향후 주차장관리 에이전트가 `POST /capture/start {autoChain:true}` + `GET /capture/pipeline` 폴링만으로 헤드리스 셋업 체인을 구동하는 것이다. 신규 라우트는 **추가**될 뿐 기존 라우트 계약을 변경하지 않으므로, 향후 소비처가 붙을 때도 기존 REST 클라이언트 코드에 대한 하위호환 파괴는 없다.
- **확인 필요**: MCP 도구 스펙(tool definition)에 `autoChain`/`GET /capture/pipeline`을 노출할지는 이번 작업 범위에 포함되지 않았다 — 실제 MCP 두뇌 연계 시점에는 별도 설계·구현이 필요하다(현재는 REST 계약만 준비된 상태).

---

## 4. 불변 확인 (DB 스키마 · slot_ptz shape · status shape)

- **DB 스키마**: `SqliteStore.getSlotSetup(): SlotSetupView[]`(`SqliteStore.ts:221`), `upsertSlotCentering(rows: SlotCenteringRow[]): void`(`:273`) 시그니처를 직접 확인 — 이번 변경은 두 메서드를 **호출만** 하고(`SetupPipeline.ts:139`, `PtzCalibrator.ts:251` 기존 호출 경로 그대로) 스키마·컬럼을 변경하지 않았다. 6테이블 개편(메모리: settingagent-db-schema)은 이번 작업 이전 완료분이며 무관.
- **`slot_ptz.json` shape**: `PtzCalibrator.run()`이 `buildSlotPtzJson(items, this.now())`을 호출하는 경로(`PtzCalibrator.ts:137`)는 무수정. 자동 체인은 `calibrator.start()`를 인자 없이 호출해 기존 전체 타깃 펼침 경로를 그대로 태울 뿐, writer·아티팩트 shape에는 관여하지 않는다.
- **`CaptureStatus`/`CalibrateStatus` shape**: 위 §2 표에서 확인한 대로 무변경. 신규 필드(`armed/stage/failure/finalize/coverage/note`)는 전부 별도 타입 `PipelineStatus`(`SetupPipeline.ts:23-33`)에만 존재하며 `GET /capture/pipeline`이라는 신규 라우트로만 노출된다.

---

## 5. 남은 한계 (은닉 없이 그대로 기록)

1. **LPD 홀(F5) 근본 미해결**: 센터라이징 대상이 lpd 보유 슬롯으로 제한되는 기존 한계는 이번 파이프라인이 `coverage`로 정직하게 리포트할 뿐 해결하지 않는다. 근본 해결(A2 — 앞면중심 prior 전슬롯 커버)은 범위 밖 후속.
2. **실 VPD/카메라 미가동으로 전체 체인 엔드투엔드 미관찰**: vitest는 상태머신·가드·라우트를 완전 커버했으나(스텁 기반), 실제 검출→finalize→PlatePtz 센터라이징이 물리/시뮬 카메라와 함께 도는 실동작(설계서 §6b L1~L6)은 서비스 미가동으로 미실행. 리더의 라우트 라이브 확인은 `GET /capture/pipeline` 응답 전이 관찰 수준에 그친다.
3. **프론트 연쇄(web/app.js) 런타임 미검증**: `pollPipeline`/체인-폴 유지/calPoll 재기동/오버레이 자동 갱신은 브라우저 DOM 의존이라 vitest 범위 밖. `node --check`(구문)만 확인, 실제 브라우저 동작은 미관찰.
4. **수동 경로 stale slot_setup 가드 미해결(후속)**: 자동 체인과 무관하게 기존부터 있던 한계 — 수집만 다시 하고 최종화 없이 수동 센터라이징을 누르는 시나리오에 대한 가드는 이번 범위 밖.
5. **centering 컬럼 wipe 취약(별건, 메모리 참조)**: 메모리 [[finalize-slotsetup-wipe-fragility]]가 언급하는 "검출컬럼은 가드됨/센터링컬럼은 취약"이라는 기존 지적은 이번 변경 대상이 아니며 그대로 남아있다 — **확인 필요** 항목으로 명시(이번 작업 범위에서 재검증하지 않음).

---

## 6. 결론

- 변경은 옵셔널 콜백 2개 + 신규 클래스 1개 + 라우트 가산 1개로 외과적이며, 기존 수동 흐름·DB 스키마·기존 REST 계약(`CaptureStatus`/`CalibrateStatus`/slot_ptz shape)에 대한 회귀는 vitest 전체 회귀(1833건, 기존 무수정)로 확인된 범위 내에서 없음.
- 현재 실제 소비처(ActionAgent/DMAgent/MCP 도구)는 아직 이 라우트를 참조하지 않으며, 향후 연계 시 기존 계약과 충돌하지 않는 가산 인터페이스만 준비된 상태.
- 실 서비스 엔드투엔드·프론트 DOM 연쇄·centering 컬럼 취약 재검증은 검증되지 않은 채로 남아 있다는 점을 완료로 위장하지 않고 그대로 보고한다.
