# 03 QA 검증 리포트 — 정밀수집 LPD 검지 3모드 콤보박스

> 검증일: 2026-07-19
> 정본 설계서: `docs/20260719_185846_LPD검지_3모드콤보박스_설계서.md`(§4 검증표)
> 구현 노트: `_workspace/02_developer_changes.md`
> 검증 범위: `web/core.js` `discoverView(status)` 순수 로직(vitest) + 회귀 + tsc + 경계면 교차.
> 작성 테스트: `test/discoverView.test.ts`(신규, 11 케이스).

---

## 1. 결론(요약)

- **신규 유닛테스트 `test/discoverView.test.ts` — 11/11 PASS.** 설계서 §4 표 전 케이스 + 경계 방어 + 불변식 커버.
- **전량 회귀 — PASS(회귀 0).** 클린 실행 시 172 파일 / 1922 테스트 전부 통과. `discoverView` 소비 로직·나머지 web 순수함수 전부 통과.
- **`npx tsc --noEmit` — EXIT 0(에러 0).** `core.d.ts` `discoverView` 선언 정합.
- **경계면 교차 — 정합.** `discoverView` 입력 shape 이 백엔드 `DiscoverStatus`(src/calibrate/types.ts:96-104)와 필드·타입 1:1.
- **소스 결함 없음.** 구현이 설계서 §3-4 스켈레톤과 일치. 리더(main) 에스컬레이션 불필요.

---

## 2. 작성 테스트 · 의도 (`test/discoverView.test.ts`)

`import { discoverView } from '../web/core.js';`(기존 core.js 순수함수 테스트와 동일 import 방식).

| # | 케이스 | 입력 | 기대 | 의도 |
|---|---|---|---|---|
| 1 | idle | `{}` | `{percent:0, label:'idle 0/0 (found 0)', runDisabled:false, polling:false}` | 초기 상태 기본값 |
| 2 | running 30% | `{state:'running',done:3,total:10,found:2}` | `{percent:30, label:'running 3/10 (found 2)', runDisabled:true, polling:true}` | 진행 중 percent·disable·poll·found 라벨 |
| 3 | done | `{state:'done',done:10,total:10,found:7}` | `{percent:100, label:'done 10/10 (found 7)', runDisabled:false, polling:false}` | 완료 시 100·disable/poll 해제 |
| 4 | total 0 | `{state:'running',done:0,total:0,found:0}` | `percent:0`(NaN 아님), running 이므로 disable/poll 유지 | **0 나눗셈 방어** |
| 5 | null | `null` | idle 폴백 | 안전 기본값(status 없음) |
| 6 | undefined | `undefined` | idle 폴백 | 안전 기본값 |
| 7 | found 반영 | `found:3` vs `found:0` | 라벨 `(found 3)` vs `(found 0)` 구별 | found 카운트 라벨 반영 증명 |
| 8 | 반올림 | `1/3`, `2/3` | `33`, `67` | `Math.round` 비정수 비율 |
| 9 | error | `{state:'error',done:2,total:10,found:1}` | `runDisabled:false, polling:false, percent:20, label:'error 2/10 (found 1)'` | error=종료 취급(백엔드 DiscoverState 정합) |
| 10 | 불변식 | 4 state 순회 | `runDisabled === polling === (state==='running')` | 실행버튼 disable ↔ 프레임폴 게이트 일치 |
| 11 | 필드 부분 누락 | `{state:'running'}` | `0/0 (found 0)`, percent 0 | `done/total/found ?? 0` 폴백 |

### 실행 결과(그대로)
```
 ✓ test/discoverView.test.ts (11 tests) 5ms
 Test Files  1 passed (1)
      Tests  11 passed (11)
```

설계서 §4 표 정확값과 구현(core.js:152-165) **완전 일치** — 구현/설계 불일치 없음.

---

## 3. 회귀 판정 (전량 vitest)

### 3-1. 최종(클린) 결과 — 회귀 0
직렬(단독) 실행 2회 연속 동일:
```
 Test Files  172 passed (172)
      Tests  1922 passed (1922)
```
`npx tsc --noEmit` → `TSC_EXIT=0`(에러 0). `core.d.ts:72-77` `discoverView` 선언 타입 정합.

### 3-2. 초기 관측된 7건 실패 — 원인 규명(프론트 무관, 재현 근거 포함)
최초 실행(§주의: **tsc 와 vitest 를 병렬 Bash 로 동시 실행**)에서 7 tests / 3 files 실패:
`cameraMode.test.ts`(3) · `settingsFormErrors.test.ts`(1) · `sourceRegistry.test.ts`(3).

교차확인으로 **프론트(LPD 콤보박스) 변경과 무관**을 확정:

1. **import 그래프(구조적 불가):** `cameraMode.test.ts`·`sourceRegistry.test.ts` 는 `../src/viewer/sourceRegistry.js` 만 import — **`web/` 참조 0**(grep 확인). 프론트 4파일(index.html·app.js·core.js·core.d.ts) 변경이 이 두 파일에 영향을 줄 경로가 존재하지 않음.
2. **git stash baseline 재현:** 프론트 4파일을 커밋 HEAD(66d9042, 콤보박스 이전)로 되돌려(`git stash push -- SettingAgent/web/{app.js,core.js,core.d.ts,index.html}`) 3파일을 재실행한 결과 — `cameraMode`·`sourceRegistry` 는 **되돌려도 통과**, `settingsFormErrors` 만 실패(단, 이는 core.js 를 HEAD 로 되돌려 카메라 검증 로직이 사라진 부작용 — 프론트 변경이 아니라 별개의 미커밋 카메라소스 리팩터 때문). 즉 **프론트 변경 유무가 이 실패들을 만들지 않음**.
3. **격리 실행 시 전량 통과:** 현재 워킹트리에서 이 3파일만 단독 실행 → **32/32 전부 통과**. 전량(172파일) 동시 실행에서만 실패 → **테스트 오염(order/공유파일 상태 의존)**. 해당 백엔드 카메라소스 테스트들은 작업 디렉토리의 공유 `config/tools.config.json`·`data/` 및 tmp 설정파일을 읽고 써서, 무거운 프로세스 동시 구동(초기 tsc‖vitest 병렬) 시 타이밍/상태 경합으로 flaky.
4. **클린 재실행 시 소멸:** 이후 vitest 를 단독으로 돌리면 7건 실패가 재현되지 않고 172/172 통과. tsc 병렬 시 잠깐 보였던 `src/stream/RtspFfmpegAdapter.ts` 2건 타입에러도 tsc 단독 실행에서 소멸(EXIT 0).

**판정: 이 7건은 이 작업(프론트 LPD 콤보박스)의 회귀가 아님.** 원인은 (a) 워킹트리에 진행 중인 별개의 백엔드 카메라소스/RTSP 네이티브 작업의 미커밋 상태 + (b) 무거운 프로세스 병렬 구동으로 인한 공유 설정파일 경합(flaky). 개발자 보고의 "config/cameraMode/cRpcClient 7건" 과 실패 파일 집합이 달라진 것(→ cameraMode/settingsFormErrors/sourceRegistry) 자체가, 실패가 변동하는 워킹트리·실행조건에 종속됨을 방증한다.

> 참고(범위 밖, 삭제/수정 안 함): 해당 백엔드 카메라소스 테스트 스위트가 전량 동시 실행에서 순서/공유파일 상태에 취약(flaky)함. 프론트 작업과 무관하나 별도 개선 대상으로 기록.

---

## 4. 경계면 교차 비교 (discoverView 입력 ↔ 백엔드 DiscoverStatus)

| 필드 | `discoverView` 소비(core.js) | 백엔드 산출(`DiscoverStatus`, types.ts:96-104) | 정합 |
|---|---|---|---|
| `state` | `status?.state ?? 'idle'`, `'running'` 비교 | `DiscoverState = 'idle'|'running'|'done'|'error'` | ✓ 값 집합 일치. `running` 만 진행, `done/error/idle` 은 종료로 취급 |
| `done` | `?? 0`, percent 분자 | `number` | ✓ |
| `total` | `?? 0`, percent 분모(0 방어) | `number` | ✓ |
| `found` | `?? 0`, 라벨 | `number` | ✓ |

- 라우트 정합: `GET /discover/status` → `deps.discovery.getStatus()`(discoverRoutes.ts:35)가 `DiscoverStatus` 반환. 프론트 `discPoll`(app.js)이 이를 `discoverView(status ?? {})` 로 전달(설계서 §3-3) — shape 손실 없음.
- 시작 응답: `POST /discover/ptz` → `{ ok, started, total }`(discoverRoutes.ts:27), 409 = `already running`(:30). 프론트 `discStart` 가 `total`/에러를 소비 — 설계서 §3-3과 정합(단, 이 경로는 DOM 이라 vitest 밖, §5 한계).
- **필드명·타입·폴백 불일치 없음.** 1-based 인덱스·base64 등 특수 경계 없음(단순 카운터 4필드).

---

## 5. 한계(정직 리포트 — vitest 밖, 리더 라이브 + 실 LPD 필요)

vitest 는 `discoverView` **순수 로직에 한정**. 다음은 브라우저 DOM/실서비스 영역으로 이번 자동 검증 범위 밖:

1. **DOM 모드 디스패치**: 콤보 3값(lpd/discover/vpd) → `runModeLpd`/`discStart`/`runModeVpd` 분기, 오버레이 토글, `runLiveDetect(false|true)` 실호출.
2. **폴 상태전이**: `discPoll` 재귀 폴(setTimeout)·`prevDiscState` running→종료 1회 전환·`startLive` 복귀·`renderDiscResult` found/total 요약.
3. **3자 프레임폴 상호배타**: cap/cal/disc `start*FramePolling` 이 서로 정지(불변식3). discovery 진행 중 라이브뷰가 `/discover/frame` 추종.
4. **discovery 실 검지율**: 실 LPD(da_lpd_api)·실 카메라 가동 시 "실제 몇 % 슬롯 구제"(선행 문서 §5와 동일 미관찰).

→ 위 1~4 는 **리더 라이브 관찰**로 검증(리더 라이브 검증 완료 통지 수신: 콤보 3옵션↔디스패처 정합·2버튼 제거·/discover/status 응답·상호배타 배선 확인).

---

## 6. 발견 이슈

- **소스 결함: 없음.** 구현(core.js `discoverView`, core.d.ts 선언)이 설계서 §3-4·§4 표와 완전 일치. 리더 에스컬레이션 불필요.
- **참고(프론트 무관):** 백엔드 카메라소스/RTSP 테스트 스위트가 전량 동시 실행 + 무거운 프로세스 병렬 시 공유 설정파일 상태 경합으로 flaky(§3-2). 이 작업 범위 밖이나 별도 안정화 대상으로 기록.
