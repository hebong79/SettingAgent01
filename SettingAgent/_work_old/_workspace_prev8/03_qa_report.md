# 03. QA 검증 보고 — 정밀수집 "라이브 Unity 동기화(최신 캡처 프레임 추종)"

## 실행 명령
```
npx vitest run                       # 전체
npx vitest run test/viewerCore.test.ts   # 대상 파일만
```
(cwd: `SettingAgent/`)

## 전체 결과 (그대로)
```
 Test Files  59 passed (59)
      Tests  471 passed (471)
   Duration  3.49s
```
- 대상 파일: `test/viewerCore.test.ts` — **27 passed** (기존 20 + 신규 `capFrameKey` 7).
- 실패 0. 회귀 0.

## 대상 & 검증 방식
- **유닛 대상(순수 함수)**: `web/core.js`의 `capFrameKey(cam, preset, round)` → `test/viewerCore.test.ts`에 describe 블록 추가.
- app.js `capFrameTick`/`startCapFramePolling`은 DOM/fetch/타이머 의존 → 유닛 대상 아님. 아래 "수동 확인"으로 이관.

## 추가한 테스트 케이스 (`capFrameKey`)
| 케이스 | 내용 | 기대 |
|---|---|---|
| (a) 동일 | 동일 (cam,preset,round) → 동일 문자열, 숫자/문자 혼용 안정성(`1,2,3` == `'1','2','3'`) | `'1:2:3'`, `===` |
| (b-cam) | cam 만 변화 | `'1:2:3' ≠ '9:2:3'` |
| (b-preset) | preset 만 변화 | `'1:2:3' ≠ '1:9:3'` |
| (b-round) | round 만 변화(라운드 전환) | `'1:2:3' ≠ '1:2:4'` |
| (c) 전부 null | 세 인자 모두 null/undefined | `null` 반환 |
| (d) 부분 null | 부분 null 조합의 키 형태 | `'1::3'`, `':2:3'`, `'1:2:'`, `'::3'` (null 아님) |
| 부분 null 충돌 | 빈 세그먼트 위치가 다르면 다른 키 | `'1::3' ≠ ':1:3'` 등 |

## 경계면 교차 비교 (핵심)
설계 A의 서버 무변경 전제와 실제 소비 경로를 동시에 읽고 shape 대조:
- **서버 산출** `src/api/captureRoutes.ts:129-131`: `X-Cap-Cam / X-Cap-Preset / X-Cap-Round` 를 각각 `String(camIdx)` / `String(presetIdx)` / `String(latest?.roundIdx ?? 0)` 로 방출. → 헤더는 항상 **문자열**(round 미상이면 `'0'`).
- **소비** `web/app.js:539-542`: `capFrameKey(res.headers.get('X-Cap-Cam'), get('X-Cap-Preset'), get('X-Cap-Round'))` — 헤더명·인자 **순서(cam→preset→round)** 가 core 시그니처와 정확히 일치.
- **스킵 판정** `app.js:545`: `key != null && key === lastCapFrameKey` → 조기 return. core 의 "전부 null → null" 규약과 정합(키가 null이면 스킵 안 함 = 항상 갱신). 문자열 헤더끼리 비교이므로 타입 불일치 없음.
- **폴링 주기** `app.js:566`: `setInterval(capFrameTick, 500)` — 설계 500ms(리더 #2) 반영.
- **고아 제거**: `capPresetKeys`/`capCycleIdx`/`X-Cap-Presets` 참조 grep 결과 app.js 내 소비측 0건(서버측 `X-Cap-Presets` 헤더는 라우트 계약으로 잔존 = 미사용화, 데드 아님).
- 불일치 **없음**. 필드명·타입·인자 순서 전 구간 일치.

## 수동 확인 항목 (유닛 대상 아님 — 위장 금지, 실제 브라우저 확인 필요)
아래는 DOM/타이머/실 Unity·캡처잡 의존으로 vitest로 검증 불가. **미검증 상태로 명시**하며, 정밀수집 실행 중 웹에서 육안 확인 요망:
1. 수집 시작 → 라이브 스트림 꺼지고 캡처 프레임 표시(`startCapFramePolling`이 `loop.stop()`).
2. **수집 중 추종**: 라운드 내 타깃 순회 시 웹 프레임이 캡처(=Unity 카메라 이동)를 따라 갱신된다.
3. **대기 중 고정**: 라운드 사이(intervalMs) 동일 프레임 고정 — 프리셋 순환 없음, cap-msg 라운드 번호 불변(동일 키 스킵 동작).
4. **깜빡임 없음**: 대기 중 동일 프레임 반복 fetch에도 이미지 재디코드/깜빡임 없음(조기 return).
5. **종료 후**: done/stopped 시 얼어붙지 않고 마지막 캡처 프레임 유지, 자동 라이브 복귀 안 함(리더 #1). 수동 ▶(loop.start)로만 라이브 재개.

## 발견 이슈
- 없음. 구현이 설계 A + 리더 확정(#1 자동복귀 안 함 / #2 500ms / #3 헬퍼 분리)에 정합.
- 참고(요청 범위 밖, 조치 불요): `captureRoutes.ts`의 `getFrameByPreset`/`getFramePresets`/`X-Cap-Presets`는 뷰어 미사용화되었으나 라우트 계약이라 잔존(설계 §영향도에 문서화됨).

## 결론
- 자동(vitest): **PASS** (471/471, 대상 27/27).
- 수동: 위 5개 항목 브라우저 실확인 **필요**(현 보고서 시점 미수행).
