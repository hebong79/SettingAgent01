# 04 DOCUMENTER — 정밀수집 센터라이징 슬롯순서·최종저장 수정 영향도 분석

> 입력: `00_goal.md`·`01_architect_plan.md`·`02_developer_changes.md`·`03_qa_report.md` + 실제 diff 재확인.
> 최종 문서: `SettingAgent/docs/20260720_130900_정밀수집_센터라이징_슬롯순서_최종저장수정.md`

---

## 1. 변경 파일 요약

| 파일 | 변경 유형 | 라인 규모 |
|---|---|---|
| `src/calibrate/PtzCalibrator.ts` | 수정(핵심) | +68 |
| `src/calibrate/slotPtzWriter.ts` | 수정(가산 1줄) | +3 |
| `src/store/SaveStore.ts` | 수정(신규 메서드/함수 가산) | +28 |
| `src/index.ts` | 수정(배선 1줄) | +1/-1 |
| `test/captureRoutes.test.ts` | 테스트 갱신(무관 배선 보강) | +7/-1 |
| `test/centeringSlot.test.ts` | 테스트 갱신(stale→신계약) | +34/-6 |
| `test/saveStore.test.ts` | 테스트 확장 | +83 |

## 2. 의존성 그래프 — 이 변경이 건드리는 소비자

### 2.1 `PtzCalibrator` (핵심 변경 지점)

`PtzCalibrator`는 아래 **두 진입점이 하나의 인스턴스를 공유**한다(`src/index.ts` L90~93에서 1회 생성).
따라서 이번 수정(선조준·저장게이트·스냅샷)은 **양쪽 모두**에 자동으로 반영된다 — 별도 배선 불필요.

```
src/index.ts
  └─ new PtzCalibrator({..., saveStore})  (1개 인스턴스)
       ├─ src/api/calibrateRoutes.ts  POST /calibrate/ptz → calibrator.start(slotIds) → run()
       └─ src/pipeline/SetupPipeline.ts  onDiscoverFinished() → calibrator.start() → run()
                (auto-chain: finalize → discovering → calibrating)
```

- **`src/api/calibrateRoutes.ts`**: 코드 변경 없음. `deps.calibrator.start()`를 그대로 호출하므로 이번 수정의
  영향을 자동으로 받는다. 회귀 리스크: 낮음(라우트 자체는 무접촉).
- **`src/pipeline/SetupPipeline.ts`**: 코드 변경 없음(`onDiscoverFinished`가 `calibrator.start()`를 그대로 호출).
  단, `test/captureRoutes.test.ts`의 파이프라인 스텁 구성에 `discovery: PlateDiscoveryJob` dep이 추가된 것은
  **이번 센터라이징 수정과 무관한 별도 변경**(discovery 단계 삽입 관련 사이드카)으로 보인다 — 이 문서의 영향
  범위 밖으로 명시하고, 착오 없이 확인만 해 둔다.
- **양 진입점 정합**: 설계·구현 모두 `run()`/`calibrateSlot()`/`saveCenteringSlots()`/`saveSetupSnapshot()`
  내부에 로직을 넣어 라우트/파이프라인 코드를 건드리지 않는 전략을 취했다. 실제 diff로 재확인한 결과 이 전략이
  그대로 지켜졌다 — `calibrateRoutes.ts`·`SetupPipeline.ts` 모두 diff 없음.

### 2.2 `expandPlateTargetsFromSlotSetup` (정렬 추가) 의 다른 소비자

`grep` 결과 이 함수의 호출자는 `PtzCalibrator.run()`(L123) **단 한 곳**뿐이다. `SetupPipeline.onDiscoverFinished`
(L117~118)도 커버리지 계산을 위해 같은 함수를 호출하므로, 정렬 부작용은 **auto-chain의 커버리지 카운트 로직에도
전파**된다 — 다만 정렬은 `targets.length`(집합 크기)를 바꾸지 않으므로 커버리지 수치(`targets/uncovered`)에는
영향이 없고, 순서만 바뀐다. 유사 함수 `expandDiscoveryTargets`(`plateDiscoveryWriter.ts`)는 **별도 함수**라
이번 정렬의 영향을 받지 않는다.

`getSlotSetup()`의 `ORDER BY` 자체는 무접촉이므로, 이 DB 조회 결과에 의존하는 다른 소비자
(`captureRoutes.ts` `GET /capture/slots`, `Finalizer.ts`, `setup/plateMatch.ts`, `SetupPipeline.ts` 커버리지 계산)는
**영향 없음** — 정렬은 `expandPlateTargetsFromSlotSetup` 함수 스코프 안에서만 일어난다.

### 2.3 DB `slot_setup` (게이트 완화) 의 다른 소비자

`upsertSlotCentering`으로 UPDATE되는 대상 행 집합이 `centered && converged` → `centered`만으로 넓어졌다.
이 테이블을 읽는 다른 소비자:

- `getSlotSetup()`을 호출하는 모든 지점(`Finalizer`, `SetupPipeline`, `captureRoutes /capture/slots`,
  `expandPlateTargetsFromSlotSetup`/`expandDiscoveryTargets`) — 이전보다 **더 많은 슬롯의 pan/tilt/zoom이
  갱신된 채로** 조회된다. zoom 미수렴 슬롯도 이제 pan/tilt 값이 채워진다. `centered` 컬럼 자체의 의미(true/false)는
  변경되지 않았으므로, `centered` 값을 읽는 기존 로직(예: 다음 회차 재-run 시 대상 판정)은 영향 없음.
- **ActionAgent 등 외부 소비자**(SettingAgent 밖): 이번 세션에서 직접 확인하지 않았다 — `slot_setup`의
  pan/tilt/zoom을 조준 prior로 사용하는 하류 서비스가 있다면, zoom 미수렴 값(포화/미달 가능성)이 섞여 들어올 수
  있다는 점을 **확인 필요** 항목으로 남긴다. 설계서(§C R-2)는 "ActionAgent 조준 prior로는 pan/tilt가 핵심이라
  허용"이라고 판단했으나, 이는 설계 시점의 판단이며 실제 ActionAgent 코드베이스 대조는 이번 범위 밖이다.

### 2.4 `save/Setup_*.json` 신규 산출물 — 뷰어·다른 저장 소비자와의 shape 불일치 (중요)

`SaveStore.saveSnapshot()`이 만드는 `save/Setup_*.json`은 `SaveStore.save()`가 만드는 기존
`save/{name}.json`(예: `result_*.json`, 수동 `/capture/save`)과 **같은 디렉터리·같은 확장자**를 쓰지만
**내용 shape이 다르다**.

- 기존 `SetupArtifact`(`src/domain/types.ts` L22~31): `{ presets: Preset[], slots: ParkingSlot[],
  globalIndex: GlobalSlotIndex[], createdAt, warnings?, report? }`.
- 신규 `Setup_*.json` payload: `{ createdAt, slots: SlotSetupView[] (=getSlotSetup() DB flat rows), centering: SlotPtzItem[] }`.

두 shape은 필드명(`slots`)만 겹칠 뿐 타입이 전혀 다르다(`ParkingSlot` vs `SlotSetupView`) — `presets`/`globalIndex`는
아예 존재하지 않는다. 그런데 `captureRoutes.ts` L372~387의 `GET /capture/saves`(목록)·`GET /capture/saves/:name`
(열기)는 `saveStore.list()`/`saveStore.load()`를 통해 **디렉터리 안의 모든 `.json` 파일을 구분 없이** 나열·반환한다.
`SaveStore.load()`(L88~94)는 파일을 읽어 `as SetupArtifact`로 **타입 단언만 하고 런타임 검증을 하지 않는다**.

**결과**: `Setup_*.json`은 `GET /capture/saves` 목록에는 정상적으로 뜨지만, `GET /capture/saves/:name`으로
"열기"를 시도하면 `SetupArtifact`로 캐스팅된 채 `slots`(형 불일치)·`presets`/`globalIndex`(부재) 상태로
클라이언트에 반환된다. 이 응답을 뷰어가 기존 `SetupArtifact` 파싱 로직으로 렌더링하려 하면 **깨진 shape을
그대로 받게 된다**(런타임 예외 또는 빈 렌더 가능성 — 뷰어 클라이언트 코드는 이번 세션에서 확인하지 않아
정확한 실패 양상은 "확인 필요"로 남긴다).

이것은 설계 단계에서 이미 인지된 트레이드오프다. 설계서(§C R-1)는 원래 a1(스냅샷=`slot_ptz.json`과 동형
`SlotPtzArtifact`)을 권고하며 "열기 라우트로 열면 뷰어가 렌더 못 함"을 **의도된 한계**로 명시했고, "Setup_은
감사/아카이브용, 뷰어 열기 대상은 result_*.json(SetupArtifact) 유지"라는 방침이었다. 그런데 리더가 D-1을 **a2**
(기하+PTZ 병합 뷰)로 확정하면서 실제 구현은 a1보다 **더 SetupArtifact에 가까운 것처럼 보이는 shape**
(`slots` 필드 존재)이 되었고, 오히려 겉보기 유사성 때문에 "열기"를 시도했을 때 부분적으로만 필드가 있는 것처럼
보여 혼동을 일으킬 여지가 a1안보다 크다. 이 문서에서는 이 갭을 명시적으로 기록한다.

- **회귀 리스크**: 기존 `save/*.json`(수동 저장·finalize 자동 저장) 파일과 파일시스템 경로가 같은 디렉터리를
  공유하지만 파일명 prefix(`Setup_` vs `result_`/사용자 지정)가 다르므로 **덮어쓰기 충돌은 없다**.
- **후속 검토 필요(확인 필요)**: `GET /capture/saves/:name`에 `Setup_` prefix를 별도 처리(예: 열기 거부 또는
  전용 뷰)하거나, 목록 응답에 종류를 구분하는 필드를 추가할지는 이번 라운드 범위 밖 — 리더 판단 필요.

### 2.5 `data/slot_ptz.json` (c) — 무변경 확인

`writer(buildSlotPtzJson(items, this.now()), this.cfg.outFile)` 호출은 이번 변경에서 순서·인자 모두 그대로다.
`saveCenteringSlots`/`saveSetupSnapshot`은 이 호출 **이후**에 추가됐을 뿐 `writer` 자체에는 개입하지 않는다.
`data/slot_ptz.json`을 읽는 소비자(ActionAgent 조준 등, 이번 세션에서 직접 대조하지 않음)에는 회귀가 없다.

### 2.6 공유 타입(`@parkagent/types`) 영향

이번 변경은 `@parkagent/types`(공유 도메인 타입: `SlotState`/`ParkingEvent` 등)를 **전혀 수정하지 않았다**.
`SetupArtifact`(SettingAgent 로컬 타입, `domain/types.ts`)도 무변경이다. 따라서 다른 에이전트(ActionAgent/DMAgent)의
타입 계약에 대한 파급은 없다.

## 3. 회귀 리스크 종합

| 리스크 | 내용 | 완화/근거 |
|---|---|---|
| R-1 | `save/Setup_*.json`이 뷰어 "열기" shape과 불일치 | §2.4. 설계 단계에서 인지된 트레이드오프, 목록에는 노출됨 |
| R-2 | zoom 미수렴 슬롯의 pan/tilt만 DB에 저장됨 | `centered:false`만 제외해 오염 방지. 하류(ActionAgent) 영향은 확인 필요 |
| R-3 | pre-aim 게인이 cam1 실측값 의존 | coarse 용도라 disambiguation 목적엔 민감도 낮음(설계 판단) — **라이브 미확증** |
| R-4(신규 발견) | 구현자 self-check가 사이드카 회귀파일(`centeringSlot.test.ts`) 누락 | QA가 전체 스위트(2057건)로 재검증해 포착·해소. 향후 회귀 주장은 전체 스위트 기준 권장(§4) |

`PlatePtz`/`controlMath` 함수 본문·시그니처는 import만 하고 무수정 — 코어 무접촉 원칙은 diff로 재확인됨.
VPD 경로·`Finalizer`·discovery 로직도 diff에 나타나지 않아 무접촉 확인.

## 4. 검증 프로세스에 대한 지적 (영향도 분석에 반영)

QA 보고서(§0, §6)에 따르면 구현자 self-check는 `ptzCalibrator.test.ts`+`slotPtzWriter.test.ts` 2개 파일(20건)만
실행해 "20/20 PASS"로 보고했으나, 동일 컴포넌트의 사이드카 회귀파일 `centeringSlot.test.ts`를 실행하지 않아
전체 스위트 기준으로는 3건 실패 상태였다(이후 stale 계약으로 판별·갱신, 구현 결함 아님으로 확정). 이는 구현
결함이 아니라 **검증 범위 선정 프로세스**의 문제로, 향후 "컴포넌트 X 회귀 없음" 주장은 그 컴포넌트를 다루는
전체 관련 테스트 파일(사이드카 포함) 또는 전체 스위트 실행을 기준으로 해야 한다는 점을 이 라운드의 교훈으로
기록한다.

## 5. 라이브 검증 이월 항목 (은닉 금지)

시뮬레이터(13100) DOWN으로 이번 라운드에 확인하지 못한 항목 — 시뮬레이터 복구 후 별도 확인 필요:

1. 실 PTZ 물리 수렴 — pre-aim이 실카메라에서 실제로 정판을 화면중앙에 두는지.
2. 비-cam1 카메라에서 fallback 게인(cam1 실측 `-62/-35.5`) 기반 pre-aim의 정확도.
3. `/calibrate/ptz` 실발화 후 `data/slot_ptz.json` 순서·`slot_setup.centered` 행·`save/Setup_*.json` 실파일 존재를
   실데이터로 확인하는 라우트/데이터 실측(설계 B-2) — 결정형 로직은 vitest로 확정했으나 실 IO 스모크는 미수행.

## 6. 확인 필요 항목 (단정 금지)

- `slot_setup`의 zoom 미수렴 행이 하류(ActionAgent 등)의 조준 prior 사용처에 실질적으로 미치는 영향 — 이번
  세션에서 ActionAgent 코드베이스를 대조하지 않았다.
- `save/Setup_*.json`을 `GET /capture/saves/:name`으로 열었을 때 뷰어 클라이언트가 정확히 어떤 실패 양상을
  보이는지(런타임 예외 vs 빈 렌더) — 뷰어 클라이언트 코드는 이번 세션 범위 밖.
- `test/captureRoutes.test.ts`의 `discovery: PlateDiscoveryJob` 스텁 추가는 이번 센터라이징 수정과 직접 관련이
  없어 보이는 선행/병행 변경으로 판단되나, 원 커밋 경계를 재확인하지 않았다.
