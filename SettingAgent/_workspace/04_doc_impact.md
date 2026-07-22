# 04 — 영향도 분석 (정밀수집 "시작" 파이프라인)

작성: 2026-07-22 19:21:30 · 근거: 설계서 §12, 구현 보고 §1·§4·§7, 검증 보고 §2·§5
최종 문서: `SettingAgent/docs/20260722_192130_정밀수집시작_파이프라인_구현.md`

---

## 1. 변경 파일별 파급 — 어떤 기존 경로가 이 변경을 지나가는가

| 파일 | 변경 | 이 변경을 지나가는 기존 경로 |
|------|------|------------------------------|
| `SettingAgent/src/ground/frontCenterBuild.ts`(신규) | `POST /capture/slots/cuboid` 라우트 본문(`captureRoutes.ts:488~524`) 이동 | ① 수동 `3D육면체 ROI생성` 버튼 → `POST /capture/slots/cuboid` ② 신규 `POST /capture/slots/load-roi` 자동 호출. **두 경로가 같은 함수를 공유**하므로 한쪽 회귀가 다른 쪽에 즉시 전파된다 |
| `SettingAgent/src/pipeline/SetupPipeline.ts` | `startPrecise()`/`beginCalibrate()`/`beginCalibrateAfterDelay()` 추가, `onDiscoverFinished` 분리 | 기존 자동 체인(`onCaptureStart`→`runFinalizeThenCalibrate`→`onDiscoverFinished`→`onCalibrateFinished`)이 이 파일 하나에 있다. `onDiscoverFinished`를 분리한 것은 **수집(autoChain) 경로와 정밀수집 경로가 동일 콜백을 공유**함을 의미 — `this.precise` 플래그로 분기하므로, 플래그 오염(예: 이전 run의 `precise=true`가 다음 수집 run에 남는 경우) 시 수집 경로에도 1s 대기가 새어 들어갈 수 있다. `onCaptureStart`가 `this.precise=false`를 명시적으로 리셋(`SetupPipeline.ts:130`)하므로 현재는 안전하지만, 향후 이 리셋을 건드리면 두 경로가 동시에 깨진다 |
| `SettingAgent/src/api/captureRoutes.ts` | `POST /capture/start-precise` 신규, `/slots/cuboid`·`/slots/load-roi`에 W6 위임/호출 추가, `deps.sources`/`deps.cameraCfg` 추가 | 기존 `/capture/pipeline`(GET, 폴링), `/capture/start`, `/capture/finalize`, `/discover/*`, `/calibrate/*` 라우트와 같은 파일·같은 `registerCaptureRoutes` 등록 함수 안에 있다. `deps` 타입 확장은 이 함수를 호출하는 **모든 서버 부트스트랩 경로**(`server.ts`, 테스트의 `buildTestApp`류 헬퍼)가 옵셔널 필드 누락에 안전한지 확인이 필요했던 지점 — 검증 보고 U7의 "sources 미주입 시 400" 케이스가 이를 봉인 |
| `SettingAgent/src/calibrate/PlateDiscoveryJob.ts` | `start()` 옵션 인자 2개 추가 | 이 잡은 **정밀수집 경로**(`SetupPipeline.startPrecise`)와 **수동 `/discover/ptz` 버튼** 양쪽에서 같은 인스턴스로 호출된다. 옵션 미전달=0 원칙이 깨지면(예: 기본값을 0이 아닌 값으로 바꾸는 향후 수정) 수동 버튼도 즉시 느려진다 |
| `SettingAgent/src/calibrate/PtzCalibrator.ts` | `start()` 옵션 인자(`betweenSlotMs`, `camera`) 추가 | 위와 동일 구조 — 정밀수집과 수동 `/calibrate/ptz` 버튼이 같은 인스턴스 공유. 추가로 `camera` 오버라이드는 `makePlatePtz` 2번째 인자를 배치 경로에 새로 노출한 것이라, 개별 클릭 센터라이징 경로(`centerOnPoint`)가 쓰던 통로와 **동일 통로를 배치가 함께 씀** — 개별 클릭 진행 중 배치가 동시에 돌면 두 경로가 같은 `makePlatePtz` 팩토리를 경합할 가능성(구현 보고 §7-3이 "카메라 오버라이드 시 프리셋 PTZ 캐시 미사용"으로 일부 언급) |
| `SettingAgent/src/api/server.ts` | `sources`/`cameraCfg`를 `registerCaptureRoutes`로 2줄 전달 | 이미 `calibrateRoutes`로 전달 중이던 것과 동일 값을 재사용 — 새 의존성 도입 없음 |
| `SettingAgent/web/index.html` | `#cap-floor-llm`·`#cap-autochain` 삭제, `#cap-capture-start` 버튼 신설 | `web/app.js`의 DOM 참조 5곳(`$('cap-floor-llm')`)이 이 삭제와 짝을 이룬다 — HTML만 보고 JS를 안 고치면 `null` 참조 에러 발생 지점이었음(구현자가 상수 접기로 해소, §2 확인) |
| `SettingAgent/web/app.js` | `startPrecise`(W5)·`drawDbCentering`(W7) 신규, `capStart`→`capCaptureStart` 개명, `capFinalize` 표시 전용화, `FLOOR_ROI_USE_LLM=false` 상수화 | `capFinalize`의 표시 전용화는 `#roi-db` 체크박스·`loadParkingSlots`·`drawRoiOverlay`·`renderSlotList` 등 **기존 DB 오버레이 경로 전체**를 그대로 재사용한다. 반대로 `POST /capture/finalize`를 더 이상 호출하지 않으므로 그 라우트에 딸린 `Finalizer.finalize` 로직은 정밀수집 UI에서 도달 불가가 된다(§2 R1) |
| `SettingAgent/test/viewerPtzSyncCoverage.test.ts` | 신규 라우트를 `MOVES_CAMERA`로 등록 | 이 테스트는 "카메라를 움직이는 모든 라우트가 분류되어 있는가"를 강제하는 하네스형 회귀 가드다. `/capture/start-precise`를 등록하지 않으면 **이 테스트가 실패**해 신규 라우트 자체를 막는다 — 향후 유사 라우트 추가 시 반드시 이 파일도 함께 갱신해야 함을 시사 |
| `SettingAgent/test/viewerDisplayReset.test.ts` | 심볼명 `capStart`→`capCaptureStart` | 프론트 리네이밍이 테스트 문자열 매칭에 그대로 전파됨(순수 명칭 추적) |

---

## 2. 회귀 위험

### R1. `최종화` 표시 전용 전환 — `Finalizer` 기능 상실 (요구9 해석변경의 직접 귀결)

`capFinalize`(`SettingAgent/web/app.js:2383~2389`)가 이제 `POST /capture/finalize`를 호출하지 않는다. 그 결과:
- `Finalizer.finalize`가 수행하던 **setup_artifact.json 생성**과 **전역 인덱스 검증**(설계서 §2.3 "finalizing" 단계 소유물)이 정밀수집 UI 경로에서 더 이상 발생하지 않는다.
- `/capture/finalize` 라우트·`Finalizer` 클래스 자체는 코드로 보존되어 수집(`수집 시작`)→수동 최종화 경로나 테스트에서는 여전히 도달 가능하지만, **정밀수집 1버튼 흐름만 쓰는 사용자는 setup_artifact.json이 갱신되지 않는 것을 눈치채지 못할 수 있다.**
- 근거: 요구 순서대로(센터라이징 완료→최종화→표시) 종전 라우트를 그대로 불렀다면 `replaceSlotSetup`이 방금 만든 센터라이징의 pan/tilt/zoom을 null로 되돌려 파괴했을 것(설계서 §9.1, `Finalizer.ts:241~244`) — 이 파괴를 피하기 위한 의도된 트레이드오프다.

**마스터 판단 필요**: setup_artifact.json·전역 인덱스가 정밀수집 결과와 별도로 필요하다면, 이를 갱신할 대체 경로(예: 별도 버튼, 또는 파괴적이지 않은 setup_artifact 갱신 함수)가 없는 현재 상태로 둘 것인지 결정해야 한다.

### R2. `autoChain` UI 제거 — `SetupPipeline.onCaptureStart` 무장 경로 소멸

`#cap-autochain` 체크박스가 삭제되고 `capCaptureStart`가 `autoChain` 필드를 아예 전송하지 않는다(`SettingAgent/web/app.js:2336` 주석 "autoChain 미전송"). 결과:
- 서버 스키마(`StartBodySchema.autoChain`)와 `SetupPipeline.onCaptureStart` 무장 로직은 코드상 보존되어 있으나, **UI로는 도달할 방법이 없다.** API를 직접 호출(`curl`/스크립트)해야만 구 자동연쇄(수집→finalize→discovering→calibrating)를 켤 수 있다.
- 이는 의도된 결과(설계서 §8.2 "위험: autoChain을 UI에서 못 켜게 되므로 구 `/capture/start` 자동연쇄는 수동 API 호출로만 도달 가능해진다(의도된 결과)")이나, **이번 정밀수집 경로와 구 autoChain 경로가 사실상 중복 기능**이 되어 유지보수 대상이 두 배로 남는다는 부담은 남는다.

### R3. `load-roi` 응답 지연

`POST /capture/slots/load-roi`가 성공하면 같은 요청 안에서 W6(`buildSlotFrontCenters`)까지 수행한다(`SettingAgent/src/api/captureRoutes.ts:457~464`). 지면모델 산출은 순수 계산(카메라·LPD 왕복 0)이라 설계·구현 단계 모두 "체감 지연 없음"으로 판단했으나, **실측(벽시계)은 수행되지 않았다** — §3 미해결 항목 참조.

### R4. heightM 불일치 (자동 경로 vs 수동 버튼)

자동 경로(`load-roi`)는 `H_CONST=1.5`(`SettingAgent/src/ground/slotFrontCenter.ts:7`)로 고정되고, 수동 `3D육면체 ROI생성` 버튼은 화면 슬라이더(`#cuboid-h`) 값을 사용한다. 사용자가 슬라이더를 1.8로 두고 화면에서 육면체를 확인한 뒤 ROI를 로딩하면, **화면에 보였던 높이(1.8)와 실제 저장된 앵커(1.5)가 어긋난다.** 완화 요인:
- 로딩 완료 메시지에 `h=1.5m`가 명시되어 사용자가 인지할 수 있음.
- 앵커는 `lowerFrontAnchor`로 번호판 높이 쪽으로 하향보정되므로 오차가 축소되나 **0은 아니다**.
- 근본 해소(슬라이더 값을 자동 경로 요청에 실어 전달)는 이번 작업 범위 밖으로 마스터가 이미 Q11에서 "H_CONST 고정"을 확정했다 — 즉 **이 불일치는 승인된 트레이드오프**이지 미검토 결함이 아니다.

---

## 3. 남은 미해결

- **`source` 미지정 API 직접 호출 시 프리셋 preflight 구멍**(검증 보고 §d-5, U8 마지막 케이스): `POST /capture/start-precise`에 `source`를 보내지 않으면 부팅 카메라를 그대로 쓰는데, 이 경로는 프리셋 집합 검사(요건13 분기 B)를 수행하지 않는다. 프론트는 항상 `state.source`를 실어 보내므로(`web/app.js:2278`) **실사용 경로는 이 구멍을 지나지 않지만**, API를 직접 호출하는 스크립트나 향후 다른 클라이언트는 리얼 소스로 프리셋 미해결 상태에서 순회가 시작될 수 있다. QA는 이를 결함이 아니라 "설계 범위 밖 구멍"으로 판단해 봉인 없이 관측만 기록했다.
- **§2.2 미검증 항목과 겹치는 것**: R3(load-roi 응답 지연)의 실측치, `ground.enabled=false` 강등의 라이브 재현(구현 단계에서 설정 변경 없이는 재현 못 함).

---

## 마스터 판단이 필요한 항목 (모음)

1. **R1 — `Finalizer`(setup_artifact.json·전역 인덱스 검증) 기능 상실**: 정밀수집 UI에서 더 이상 호출되지 않는다. 이 기능이 정밀수집 결과와 별도로 여전히 필요하면, 파괴적이지 않은 대체 갱신 경로를 새로 설계해야 한다. 필요 없다면 현 상태(코드 보존·UI 도달 불가)로 확정.
2. **R2 — `autoChain`을 UI로 켤 수단 소멸**: 구 자동연쇄(수집→finalize→discovering→calibrating)가 API 직접 호출로만 남는다. 이 경로 자체를 폐기(코드 제거)할지, 아니면 계속 이중 유지할지 결정 필요.
3. **`source` 미지정 시 프리셋 preflight 구멍**: 결함으로 취급해 봉인할지, 현재처럼 "실사용 경로가 늘 source를 보내므로 방치"로 둘지 결정 필요.
4. **R4 — heightM 불일치(H_CONST=1.5 고정)**: 이미 마스터가 Q11로 확정한 트레이드오프이나, 화면 슬라이더와의 괴리가 사용자 혼란을 재발시킬 수 있다는 점을 재확인 차원에서 명시. 추가 조치 불필요 시 "확정 유지"로 응답해도 됨.
5. **R3 — `load-roi` 응답 지연 실측 부재**: 벽시계 실측이 없다. 실사용 시 체감 지연이 문제라면 별도 성능 측정 작업이 필요.
