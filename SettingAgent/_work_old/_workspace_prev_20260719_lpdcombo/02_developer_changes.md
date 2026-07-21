# 02 구현 변경 내역 — 정밀수집 LPD 검지 3모드 콤보박스

> 정본 설계서: `docs/20260719_185846_LPD검지_3모드콤보박스_설계서.md`
> 범위: **프론트 배선만**(web/index.html·app.js·core.js·core.d.ts). 백엔드(`/discover/*`, `PlateDiscoveryJob`) **무수정**.
> 검증 대상 전달: qa-tester(§검증 포인트), documenter(§전체).

## 1. 변경 파일 요약

| 파일 | 변경 | 성격 |
|---|---|---|
| `web/index.html` | cap-actions 툴바에서 2버튼(`cap-detect-run`·`cap-vpd-test`) 삭제 → 아래 **별도 검지 라인**(select 3옵션 + 실행 + 진행/라벨/메시지) 삽입 | 수정 |
| `web/app.js` | discoverView import 1줄 / disc 상태변수·6함수(discFrameTick·start/stopDiscFramePolling·discStart·discPoll·renderDiscResult) / 모드함수 2개(runModeLpd·runModeVpd) / 기존 2바인딩 → `#lpd-run` 디스패처 / startCap·CalFramePolling에 stopDisc 1줄씩 | 수정 |
| `web/core.js` | `discoverView(status)` 순수 함수 추가(captureUiState 옆) | 가산 |
| `web/core.d.ts` | `discoverView` 선언 1줄 추가 | 가산 |
| `src/api/discoverRoutes.ts`·`PlateDiscoveryJob.ts`·`types.ts`·`index.ts`·`server.ts` | **불변**(완성분 재사용만) | 불변 |

## 2. 핵심 구현 노트

### 2-1. HTML 라인 분리 (index.html)
- **삭제**: cap-actions 툴바(178-)에서 `#cap-detect-run`(LPD 검출)·`#cap-vpd-test`(VPD 검출 테스트) 두 `<button>`만 제거. 시작/정지/최종화/검출·센터링초기화 **4버튼 유지**.
- **삽입**(툴바 `</div>` 직후):
  - `<div class="cap-actions toolbar">`: `<label class="field">LPD 검지 <select id="lpd-mode">`(옵션 `lpd`(기본 selected)/`discover`/`vpd`) + `<button id="lpd-run" class="primary">실행</button>` — 라인 187·193.
  - `<div class="cap-progress">`: `<progress id="disc-bar" max=100 value=0>` + `<span id="disc-label">idle 0/0</span>` — 라인 196-197.
  - `<div id="disc-msg" class="cap-msg">` — 라인 199.
- **신규 CSS 없음**: 기존 `.field`/`cap-actions toolbar`/`cap-progress`/`cap-msg` 클래스 재사용.

### 2-2. 3모드 디스패처 (app.js)
- 기존 두 바인딩(구 3215-3230)을 **제거**하고 두 핸들러 본문을 모듈 함수로 이사(로직 보존, 삭제·개선 없음):
  - `runModeLpd()`(app.js:2370) — 비-LPD 오버레이 4토글 off + `roi-plate` on + `runLiveDetect(false)`.
  - `runModeVpd()`(app.js:2381) — `roi-vehicle`·`roi-occupancy` on + `runLiveDetect(true)`.
- 신규 단일 바인딩 `$('lpd-run')`(app.js:3338): `$('lpd-mode').value` → `lpd`→runModeLpd / `discover`→discStart / `vpd`→runModeVpd.

### 2-3. 모드 (b) discovery 폴/프레임틱 — calPoll/calFrameTick 미러 (app.js)
- **상태변수**(cal 대칭, `disc` 접두): `discPollTimer`, `prevDiscState='idle'`, `discFrameTimer`, `discFrameUrl`.
- `discStart()`(2306): `POST /discover/ptz` body `'{}'`(전체 배치) → !ok면 `disc-msg`에 실패(409 "already running" 포함), total 0이면 "대상 0" 안내, else "시작됨(대상 N)" → `discPoll()`. (calStart 미러)
- `discFrameTick()`(2275): `GET /discover/frame` → blob → `frame.src` 교체·decode·이전 objectURL revoke. (calFrameTick 미러, X-Disc-Cam 헤더는 라벨 미사용이라 참조 안 함)
- `discPoll()`(2325): `GET /discover/status` → `discoverView(status ?? {})`로 percent/label/runDisabled/polling 매핑 → `disc-bar.value`·`disc-label.textContent`·`lpd-run.disabled` 반영. `view.polling`이면 `startDiscFramePolling()` else stop. `prevDiscState==='running' && st!=='running'` 전환 1회에 done→`renderDiscResult()`, else `종료(st)` + `startLive()`. `pollPlan(st)`로 running에서만 재폴(setTimeout).
- `renderDiscResult()`(2359): 최종 `GET /discover/status` found/total → "완료 — 발견 F/T 슬롯".

### 2-4. discPoll/discFrameTick 상호배타 (불변식3)
- `startDiscFramePolling()`(2290): `stopCapFramePolling()`+`stopCalFramePolling()`+`stopLive()` 후 500ms interval.
- `stopDiscFramePolling()`(2299): 타이머 clear.
- 역방향 배타 완성: `startCapFramePolling`(app.js:1888)·`startCalFramePolling`(app.js:2182)에 `stopDiscFramePolling();` **1줄씩 추가** → cap·cal·disc 3자 프레임폴이 서로를 정지시킴.

### 2-5. 순수 헬퍼 discoverView (core.js:152 / core.d.ts:72)
```
discoverView(status) → { percent, label:`${st} ${done}/${total} (found ${found})`, runDisabled, polling }
```
- `st=status.state??'idle'`, done/total/found `??0`. `percent = total>0 ? round(done/total*100) : 0`(0나눗셈 방어). `running = st==='running'` → `runDisabled=polling=running`.
- `pollPlan`과 정합: discovery엔 stopping/finalizing 상태 없어 running에서만 poll(부작용 0).

## 3. 자체 검증 결과

| 검증 | 명령 | 결과 |
|---|---|---|
| app.js 구문 | `node --check web/app.js` | **APP_JS_OK** |
| core.js 구문 | `node --check web/core.js` | **CORE_JS_OK** |
| 타입 정합(core.d.ts) | `npx tsc --noEmit` | **EXIT=0** |
| discoverView 스모크 | `node import('./web/core.js')` 5케이스 | 아래 전부 설계 §4 표와 일치 |
| 전량 회귀 | `npx vitest run` | 아래 "회귀 분석" 참조 — **내 변경 기인 실패 0** |

### discoverView 스모크(설계 §4 검증표 대조)
- idle(`{}`) → `{percent:0,label:'idle 0/0 (found 0)',runDisabled:false,polling:false}` ✓
- running done3/total10 found2 → `{percent:30,label:'running 3/10 (found 2)',runDisabled:true,polling:true}` ✓
- done 10/10 found7 → `{percent:100,...,runDisabled:false,polling:false}` ✓
- total0(running 0/0) → `percent:0`(0나눗셈 방어), runDisabled/polling true ✓
- null → idle 폴백 ✓

### 회귀 분석 (vitest 전량)
- 결과: 170 파일 중 **166 passed / 4 failed**(7 tests failed). 실패 파일: `config.test.ts`(5)·`cameraMode.test.ts`(1)·`cRpcClient.test.ts`(1)·`migrateToSettingDb.test.ts`(skipped, 실패 아님).
- **내 변경과 무관 확인**: `git stash`로 web/4파일을 되돌린 **baseline에서 동일 7 failed 재현**(config/cameraMode/cRpcClient 3파일). 원인은 워킹트리의 미커밋 `config/tools.config.json`·`data/` 상태(카메라 source URL 검증 등) — 프론트 배선과 접점 없음. **내 변경이 추가한 실패 0**.
- 내 `discoverView`가 속한 core.js 로직 및 나머지 web 소비 테스트 전부 통과.

## 4. 발견 이슈 / 설계 결함
- **없음**(설계서 §3 스켈레톤 그대로 구현 가능). 백엔드 상태 shape(`state/done/total/found`, DiscoverState=idle|running|done|error)·`/discover/{ptz,status,frame,result}` 라우트가 설계 가정과 정확히 일치함을 소스 대조로 확인(discoverRoutes.ts, PlateDiscoveryJob.ts:95-104, types.ts:93-104).
- 참고(삭제 안 함): `X-Disc-Cam`/`X-Disc-Preset` 헤더가 `/discover/frame`에 존재하나 calFrameTick과 달리 discovery 라벨엔 미사용 → discFrameTick에서 참조하지 않음(진행 표기는 disc-bar/label로 충분, 최소주의).

## 5. qa-tester 전달 — 검증 포인트
- **discoverView 순수 케이스(vitest 신규 대상)**: 설계 §4 표 5케이스 — idle/running30(percent30·disable·poll)/done/total0(0나눗셈)/null 폴백. label 포맷 `"{state} {done}/{total} (found {found})"` 고정. `runDisabled===polling===(state==='running')` 불변식.
- **DOM 디스패치·폴 상태전이는 리더 라이브 관찰**(브라우저 전용, vitest 밖): 콤보 3값 실행 경로 / discovery `/discover/ptz`→status폴→frame추종→found/total 요약 / 3자 프레임폴 상호배타 / 종료 startLive 복귀.
- **회귀**: 기존 검출·수집·센터링·원버튼·초기화 불변(cap-detect-run/cap-vpd-test 제거가 다른 참조 깨지지 않음 — grep상 코드 참조 0, 남은 매치는 주석뿐).
