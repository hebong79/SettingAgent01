# 02. 구현 변경 요약 — 정밀수집 뷰어 "라이브 Unity 동기화(최신 캡처 프레임 추종)"

설계서 방안 A + 리더 확정(#1 자동복귀 안 함 / #2 500ms / #3 헬퍼 분리)을 구현했다. 서버·라우트·CaptureJob 무변경.

## 변경 파일 목록
1. `web/core.js` — 순수 헬퍼 `capFrameKey` 신규 export.
2. `web/core.d.ts` — `capFrameKey` 타입 선언 추가.
3. `web/app.js` — import 추가, `capFrameTick`/`startCapFramePolling` 재작성, 고아 변수 제거.

## 핵심 구현 노트

### web/core.js (헬퍼 분리 — 리더 #3, vitest 대상)
- 시그니처: `capFrameKey(cam, preset, round): string | null`
- 반환: `` `${cam ?? ''}:${preset ?? ''}:${round ?? ''}` `` 형태 유일 키.
  - 세 인자 모두 null/undefined 면 `null` 반환(식별 불가 → 스킵하지 않음, 즉 항상 갱신).
  - `X-Cap-Cam/Preset/Round` 헤더 조합이 캡처 1건을 유일 식별. 같은 라운드에서 프리셋을 순회하므로 cam·preset·round 모두 포함해야 유일.
- pollPlan 바로 아래 삽입(순수 함수 구역).

### web/app.js
- **import**(~16): `pollPlan` 뒤에 `capFrameKey` 추가(from './core.js').
- **모듈 스코프 변수(526~)**:
  - 제거(내 변경으로 미사용): `capPresetKeys`, `capCycleIdx` 및 주석.
  - 신규: `let lastCapFrameKey = null;`(직전 프레임 키 보관).
  - 유지: `capFrameTimer`, `capFrameUrl`(revoke 대상).
- **`capFrameTick`**: `capPresetKeys` 순환·`?cam=&preset=` 쿼리 완전 제거 → `fetch('/capture/frame', {cache:'no-store'})` 파라미터 없이 최신 프레임 요청.
  - 응답 헤더로 `capFrameKey(...)` 계산 → `key != null && key === lastCapFrameKey` 이면 **조기 return**(blob 생성·`URL.createObjectURL`·`frame.src` 교체·revoke·cap-msg 갱신 모두 스킵 → 대기 중 동일 프레임 재디코드/깜빡임 방지).
  - 새 키면 `lastCapFrameKey` 갱신 후 기존과 동일하게 blob 표시 + 직전 url revoke(누수 방지).
  - cap-msg: `수집 중 — cam{c} 프리셋{p} (라운드 {r})`. 순환 제거로 근거 사라진 "대상 카메라 목록"(capPresetKeys 파생) 문구 제거.
- **`startCapFramePolling`**: `loop.stop()` 유지. `capPresetKeys=[]`/`capCycleIdx=0` 초기화 라인 → `lastCapFrameKey = null` 로 교체. `setInterval` 주기 **700ms → 500ms**.
- **수집 종료(capPoll else 분기, ~608)**: 무변경. 자동 라이브 복귀(loop.start) 없음 — 마지막 캡처 프레임 유지, 수동 ▶(loop.start)로만 재개(기존 경로). done 메시지·결과 모달·floor 경고·pollPlan 재예약 전부 무변경.

## 고아 제거 (내 변경으로 미사용화된 것만)
- `capPresetKeys` (구 530), `capCycleIdx` (구 531) 변수 선언 및 관련 주석.
- `web/app.js` 내 잔여 참조 0건 확인(grep: capPresetKeys/capCycleIdx/X-Cap-Presets 무매치).

## 미사용화(데드 아님, 요청 범위 밖 → 무변경)
- 서버 `getFrameByPreset`/`getFramePresets`/`X-Cap-Presets` 응답 헤더: 뷰어가 더 이상 사용 안 하나 라우트 계약이므로 삭제하지 않음(문서화에서 "미사용화" 언급).

## node --check 결과
```
$ node --check web/app.js  → app.js OK
$ node --check web/core.js → core.js OK
```
둘 다 통과.

## 검증자(qa-tester) 전달 사항
- 순수 유닛테스트 대상: `capFrameKey`
  - 같은 (cam,preset,round) → 동일 문자열(직전 키와 `===` → 스킵 판정 true).
  - 하나라도 다르면 다른 문자열(스킵 안 함).
  - 세 인자 모두 null/undefined → `null`(스킵 판정에서 `key != null` 가드로 항상 갱신).
  - 숫자/문자 혼용(헤더는 문자열) → 문자열 조합 안정성.
- app.js/core.js 는 순수 JS이므로 `node --check`로 문법 검증(빌드/tsc 대상 아님).
