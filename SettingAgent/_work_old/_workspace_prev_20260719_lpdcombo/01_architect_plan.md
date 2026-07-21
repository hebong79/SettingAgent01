# 01 설계 계획 — 정밀수집 LPD 검지 3모드 콤보박스

> 공식 설계서: `docs/20260719_185846_LPD검지_3모드콤보박스_설계서.md` (구현자는 이것을 정본으로)
> 범위: **web/index.html · web/app.js · web/core.js(+.d.ts) 프론트 배선만.** 백엔드(`/discover/*`, `PlateDiscoveryJob`) 완성됨 → **수정 없음 목표**.

## 목표
정밀수집 페이지 검출부를 `cap-actions` 툴바(index.html:178-185)에서 분리 → **콤보박스(3모드)+실행 버튼** 별도 라인. 모드: (a)순수 LPD `runLiveDetect(false)` / (b)앞면중심 LOOP discovery 잡 UI 연결 / (c)VPD→LPD `runLiveDetect(true)`.

## 확정 결정
1. **대체(병존X)**: `#cap-detect-run`(a)·`#cap-vpd-test`(c) 버튼 제거, 콤보로 흡수. 두 ID는 바인딩 외 참조 0(grep 확인) → 안전. 핸들러 본문은 모드함수로 이사(로직 보존).
2. **discovery = 전체 배치**: `POST /discover/ptz` body `{}`(slotIds 미전달) → 앞면중심 보유 전 슬롯. calStart(`'{}'`)와 동일 패턴.
3. **폴/프레임틱 = calPoll/calFrameTick 미러**: 신규 `discPoll`·`discFrameTick`, 상태변수 `disc` 접두. `pollPlan`(core.js:124)이 'running' 대응 → 재사용.
4. **3자 상호배타**: `startDiscFramePolling`이 cap·cal 프레임폴 정지; `startCap/CalFramePolling`(app.js:1884·2177)에 `stopDiscFramePolling()` 1줄씩 추가.
5. **중복 시작**: 백엔드 409 의존(프론트 선제락 불필요, cal과 동일). 실행버튼 disable은 discovery running 중만.

## 단계 → 검증
1. HTML: 툴바서 2버튼 삭제 + 검지 라인 div 삽입(§3-1) → **검증**: `#lpd-mode`(3옵션)·`#lpd-run` 존재, 툴바에 시작/정지/최종화/초기화 4버튼만.
2. core.js `discoverView(status)` 순수함수 + core.d.ts 선언(§3-4) → **검증(vitest)**: idle/running(30%,disable,poll)/done/total0(percent0) 매핑.
3. app.js 모드 디스패처: 기존 3215-3230 제거→모드함수 이동, `#lpd-run` 바인딩(§3-2) → **검증(리더 라이브)**: 콤보 3값 실행 시 각 경로.
4. app.js discStart/discPoll/discFrameTick/상호배타(§3-3) → **검증(리더 라이브)**: /discover/ptz→status폴→frame추종→found/total 요약, 종료 startLive.
5. 전량 회귀 → **검증**: `npx vitest run` 기존 불변 + `npx tsc --noEmit` exit0 + 라이브 기존 검출·수집·센터링·원버튼 불변.

## 영향 파일 (구현자·문서화)
- **수정**: web/index.html(2버튼 삭제·라인 삽입), web/app.js(바인딩 교체·disc 폴 3함수·상호배타 2줄).
- **가산**: web/core.js(`discoverView`), web/core.d.ts(선언 1줄).
- **불변(수정 금지)**: src/api/discoverRoutes.ts, src/calibrate/PlateDiscoveryJob.ts, src/calibrate/types.ts, src/index.ts, server.ts. 백엔드 완성 상태 재사용만.

## MCP 두뇌 vs 도구 경계
전 모드 **결정형(도구)**. (a)(c) 단발 REST 검출, (b) 순수 기하 크롭줌·아핀 역계산(LLM 미사용). 이 작업엔 판단/LLM 신규 로직 없음 — 순수 UI 배선.

## 미해결/가정 (리더 확인 지점)
- 가정A: 2버튼 콤보 대체(병존 원하면 확인). 근거상 중복 → 대체 권장.
- 가정B: discovery 전체 배치(프리셋/슬롯 한정 원하면 별도 요청, 범위 밖).
- 가정C: 완료 요약 = status found/total로 충분. /discover/result 슬롯별 상세는 미포함(최소주의, 필요시 후속).
- 한계: 실 LPD·카메라 미가동 → discovery 실 검지율 미관찰(선행문서 §5 동일). vitest는 discoverView 순수로직 한정, DOM 디스패치·폴 전이는 리더 라이브 검증.
```
1. HTML 라인분리        → 검증: #lpd-mode(3옵션)+#lpd-run, 툴바 4버튼만
2. core.discoverView    → 검증: vitest 상태매핑(percent/label/disable/poll)
3. app 모드 디스패처    → 검증: 리더 라이브 3모드 경로
4. app disc 폴/상호배타 → 검증: 리더 라이브 discovery 폴·프레임·요약
5. 회귀 0               → 검증: vitest 불변 + tsc exit0 + 라이브 기존기능 불변
```
