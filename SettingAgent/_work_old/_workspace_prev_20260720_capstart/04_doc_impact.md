# 04 문서화·영향도 분석 — 정밀수집 discovering 단계 삽입 + occupy_range 결정형 생성

> 최종 문서: `SettingAgent/docs/20260720_104435_정밀수집_LPD디스커버리_점유영역전환.md`
> 근거: `01_architect_plan.md`(§C/§D/§I) + `02_developer_changes.md` + `03_qa_report.md` + 실제 소스 대조(Read 검증 완료).

## 1. 변경 범위 요약

| 파일 | 변경 종류 | 핵심 |
|---|---|---|
| `src/pipeline/SetupPipeline.ts` | 상태머신 확장 | `'discovering'` stage 삽입, `onDiscoverFinished`, isBusy, 커버리지 산출 시점 이동, `failure.stage:'discover'` |
| `src/calibrate/PlateDiscoveryJob.ts` | 콜백 추가 + occupy 계산 | `onFinished?`(옵셔널), `saveSlotLpd`가 `buildPlateAnchoredQuad` 재사용해 occupy_range 동봉 |
| `src/capture/SqliteStore.ts` | SQL 분기 확장 | `upsertSlotLpd` 조건부(undefined=무접촉/제공=갱신/null=클리어) |
| `src/capture/types.ts` | 타입 확장 | `SlotLpdRow.occupyRange?: string \| null` |
| `src/index.ts` | 배선 | discovery 주입 순서 조정 + 클로저 전방참조 |
| `web/app.js` | UI 라벨 | `'discovering'` 상태 라벨/폴링 조건 |
| `web/index.html`(리더 수정) | UI 라벨 | `#cap-autochain` 라벨·툴팁 정확화 |

## 2. 의존성 그래프 영향

### 2-1. `@parkagent/types` — 영향 없음
이번 변경은 SettingAgent 로컬 타입(`src/capture/types.ts`)만 확장했다. 공유 패키지 `@parkagent/types`,
`SlotState`/`ParkingEvent` 등 도메인 공유 타입은 **일절 접촉하지 않음**. ActionAgent/DMAgent로의 전파 없음.

### 2-2. REST 계약 변경 — 값 집합 확장(구조 불변)
`GET /capture/pipeline`의 `stage`/`failure.stage` enum에 값이 1개씩 추가됐을 뿐, JSON 스키마·필드 구조는
불변이다. 클라이언트(`web/app.js`)는 신규 값을 명시 처리하도록 수정됐고(§3-6 문서 참조), 미처리 클라이언트가
있다면 `switch`/`if-else` 기본 분기로 흘러 들어가되 크래시는 발생하지 않는다(문자열 값이므로 타입 에러 없음).
외부(ActionAgent/DMAgent 등 다른 서비스)가 이 엔드포인트를 소비하는 코드는 저장소 내에서 확인되지 않았다 —
**SettingAgent 로컬 UI 전용 계약**으로 판단됨(확인 필요 시 별도 grep 권장).

### 2-3. `slot_setup` 테이블(occupy_range 컬럼) — 쓰기 경로 3곳 교차영향
`occupy_range` 컬럼에 쓰는 경로가 이제 2곳(기존 Finalizer + 신규 discovery)이고, 읽는(보존해야 하는) 경로가
1곳(수동 `/capture/slots/lpd`) 추가로 존재한다.

| 쓰기/보존 경로 | 변경 여부 | 영향 |
|---|---|---|
| `Finalizer.finalize`(`Finalizer.ts:254`, capture hit 기반) | **무수정** | 회귀 0. hit 있으면 기존대로 채움 |
| `PlateDiscoveryJob.saveSlotLpd`(신규, 판 quad 기반) | 신규 | finalize 이후 실행되므로 판 발견 슬롯은 discovery 값으로 최종 갱신 |
| `captureRoutes.ts:341` 수동 `/capture/slots/lpd`("현재화면 LPD DB추가") | **무수정**(occupyRange 키 미전달) | `upsertSlotLpd`가 undefined로 인식 → occupy_range 무접촉(보존). 조건부 분기로 이 회귀를 원천 차단(§9 설계편차 참조) |

**핵심 리스크 완화**: 설계서 §I의 리터럴 SQL(단일 statement + `?? null`)을 그대로 구현했다면 수동 경로가
매번 occupy_range를 null로 wipe했을 것 — 구현자가 조건부 분기로 조정했고, 검증자가 기존 wipe-safety 봉인
테스트(`sqliteStore.test.ts:301`) 무수정 통과로 확인했다(`03_qa_report.md` §3·§4).

### 2-4. `PlateDiscoveryJob` 소비자 — 2곳
- `SetupPipeline`(신규 dep 주입) — 자동연쇄 전용.
- `discoverRoutes.ts`(`POST /discover/ptz`, 수동) — `onFinished` 미주입으로 인스턴스 생성. 콜백이 옵셔널이라
  **행동 변경 없음**(no-op).

두 소비자가 **동일 `plateDiscovery` 인스턴스**를 공유하도록 `index.ts`에서 배선되어 있어(§3-5 문서),
자동연쇄와 수동 버튼이 같은 상태머신을 사용한다 — 자동연쇄 진행 중 수동 `/discover/ptz`를 누르면 기존과
동일하게 `discover already running` 경합 에러가 발생한다(회귀 아님, 기존에도 동일 인스턴스 공유였다면
동일했을 동작; `isBusy()`에 `'discovering'`이 추가되어 `/capture/start` 쪽 409는 새로 가드됨).

### 2-5. 오버레이 retain 정책 — 접촉 없음
`SettingAgent overlay retain policy`(정밀수집 종료 후 VPD/LPD/점유 오버레이 유지·삭제 금지)와 관련된 코드
경로는 이번 변경에서 건드리지 않았다. discovery/finalize 모두 DB 컬럼 갱신만 수행하며 오버레이 파일 삭제
로직에 접촉하지 않는다.

### 2-6. autoChain opt-in 정책 — 유지
`#cap-autochain` 체크박스가 꺼진 상태(`armed=false`)에서는 `SetupPipeline.onCaptureStart(false, ...)`가
`stage='idle'`로 리셋하고, `onCaptureFinished`/`onDiscoverFinished`/`onCalibrateFinished` 전부
`if (!this.armed) return;` 가드로 no-op 처리된다(코드 확인: `SetupPipeline.ts:65-80`, `110-111`). 기존 수동
3버튼(수집/최종화/센터라이징) 흐름은 discovery 미발화로 완전히 보존된다.

## 3. 리스크(F1~F7) 완화 현황

| # | 리스크 | 완화 상태 |
|---|---|---|
| F1 | discovery가 lpd 덮어쓸 때 roi/occupy/front_center 훼손 | **완화 확인**. `upsertSlotLpd` 부분 UPDATE(slot_id 키만), QA가 타 컬럼(`vpd/pan/tilt/zoom/centered/img1/slot3d_front_center/slot_roi`) 불변을 단위 단언. 리더 라이브에서도 무손상 실증 |
| F2 | 콜드 DB(front_center 부재) → discovery found 0 | **완화**. finalize를 discovery 앞에 배치해 front_center 항상 선-부트스트랩. found 0이어도 정직 note |
| F3 | capture 전체프레임 LPD 제거 유혹 → 점유영역 붕괴 | **회피**. capture LPD 블록 무수정 유지(점유 앵커용), 이터레이션 2로 discovery 판 quad가 occupy_range 1차 소스로 보강 |
| F4 | discovery 단계 길어져 파이프라인 카메라 점유 경합 | **완화**. `isBusy()`에 discovering 포함(신규 수집 409). discovery는 카메라 무이동(원본 크롭 재사용) |
| F5 | onFinished 미주입 시 수동 `/discover/ptz` 영향 | **완화 확인**. 콜백 옵셔널 no-op, 유닛 테스트로 수동 경로 그대로 검증(`plateDiscoveryJob.test.ts`) |
| F6 | discovery error 시 centering 오발화 | **완화 확인**. `onDiscoverFinished('error')` → `fail('discover', ...)` → calibrator.start 미호출(단위 D-2로 봉인) |
| F7 | index.ts 생성순서 순환참조(pipeline↔discovery) | **완화 확인**. captureJob/calibrator와 동일한 클로저 전방참조 패턴 적용, 실제 소스(`index.ts:74,99-105`)로 확인 |

## 4. 회귀 검증 상태

- 단위: `npx tsc --noEmit` exit 0, `npx vitest run --no-file-parallelism` 176파일/2036테스트 PASS(기준선 2019 + 신규 17), exit 0, 신규 실패 0.
- 라이브(리더, count=1): 전이 완주, discovery found 17/17 고유·중복 0, occupy_range 17/17 생성, 컬럼 무손상, 센터라이징 수렴.
- 미검증(한계로 명시): 실 서비스 상시 스모크, 다중 카메라 소스·다른 프리셋 조합에서의 반복 재현성.

## 5. 확인 필요 항목

- `GET /capture/pipeline`을 SettingAgent 외부(ActionAgent/DMAgent 등)에서 소비하는 코드가 있는지는 본
  분석에서 grep 확인하지 않았다 — 저장소 구조상 SettingAgent 로컬 UI 전용으로 보이나 단정하지 않음.
