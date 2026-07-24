# Touring Test 버튼 이동 + 'result 파일 생성' 버튼 제거 (2026-07-24)

## 1. 요청

1. 정밀수집 실행 툴바에 있던 **Touring Test** 버튼을 아래 **센터라이징** 영역으로 이동.
2. **result 파일 생성** 버튼은 사용하지 않으므로 제거 — 센터라이징이 끝나면 `setup_result.json` 이 자동 저장되기 때문.

## 2. 설계(변경 범위)

뷰어 프론트엔드 전용 변경이다. 서버 로직·DB·산출물 포맷은 건드리지 않는다.

| 항목 | 변경 |
|------|------|
| `web/index.html` | `#cap-touring` 을 `.cap-actions.toolbar.capture-actions` → `.centering-inline` 내부(`#cal-start` 바로 뒤)로 이동. `#cal-result-file` 버튼 삭제 |
| `web/app.js` | `makeSetupResultFile()` 핸들러 삭제 + `$('cal-result-file')` 결선 삭제. `#cap-touring` 결선(`runTouringTest`)은 id 불변이라 그대로 |
| `test/setupResultRoute.test.ts` | `#cal-result-file` 뷰어 결선 검증 2건 → **재추가 방지 가드 1건**으로 교체 |
| `test/buildTouringPlan.test.ts` | Touring Test 버튼 위치·결선 가드 2건 신규 |

### 레이아웃 근거 (CSS 무변경)

`.centering-inline` 은 `grid-template-columns: auto minmax(0, 1fr)` 2열 그리드다.
자식 배치 순서는 `centering-info`(전열 span) → `#cal-start`(1열) → **`#cal-result-file`(2열)** → `개별 센터라이징` label(1열) → 진행바(2열) 순이었다.
삭제된 `#cal-result-file` **자리에 그대로** `#cap-touring` 을 넣었으므로 그리드 흐름·CSS 규칙은 한 줄도 바꿀 필요가 없다. 화면상 `[센터라이징] [Touring Test]` 가 한 행에 놓인다.

정밀수집 툴바는 flex 나열이라 마지막 버튼 1개가 빠져도 배치가 무너지지 않는다(버튼 7개 유지).

## 3. 'result 파일 생성' 제거의 안전성

제거해도 최종 결과물 생성 경로가 사라지지 않는다. 파일 생성 진입점은 `writeSetupResultFiles()` 하나이고, 호출처는 세 곳이다.

| 호출처 | 경로 | 상태 |
|--------|------|------|
| `src/calibrate/PtzCalibrator.ts:448` (`saveSetupSnapshot`) | 센터라이징 잡 완료 시 **자동** | **유지 — 정상 경로** |
| `src/api/server.ts:317` | 전역번호 재번호 후 `setup_result` 재생성 | 유지 |
| `src/api/captureRoutes.ts:640` (`POST /capture/setup-result`) | 수동 버튼이 쓰던 REST 라우트 | **라우트는 유지, UI 결선만 제거** |

즉 "센터라이징 끝나면 자동 저장"은 버튼과 무관하게 `PtzCalibrator` 가 수행한다(같은 함수 → 산출물 동일).

**REST 라우트 `POST /capture/setup-result` 는 남겼다.** 이유: 버튼 제거는 UI 요청이고, 공개 REST 표면을 없애는 것은 요청 범위를 넘는다. 현재 이 라우트의 호출자는 테스트뿐이므로, 원치 않으면 라우트+테스트도 함께 제거할 수 있다(마스터 판단 사항).

## 4. 검증

### 4.1 유닛 테스트

신규/변경 케이스:

- `buildTouringPlan.test.ts > Touring Test 버튼 위치 — 센터라이징 영역(.centering-inline)`
  - `#cap-touring` 이 `.centering-inline` 블록 안에서 `#cal-start` **뒤**에 있고, 정밀수집 툴바 블록에는 **없다** ✅
  - `$('cap-touring').addEventListener('click', runTouringTest)` 결선 유지 ✅
- `setupResultRoute.test.ts > 뷰어 — result 파일 생성 버튼 제거`
  - `index.html` 에 `cal-result-file` 없음, `app.js` 에 `makeSetupResultFile` 없음 ✅
  - 라우트 자체 검증(파일 2벌 동일 내용·DB 정본 반영·실패 격리) 기존 5건 전부 통과 ✅

### 4.2 전체 회귀

```
npx tsc --noEmit   → 0 error
npx vitest run     → 227 파일 / 2658 테스트 중 2656 통과, 2 실패
```

**실패 2건은 이번 변경과 무관한 기존 실패**다. `buildTouringPlan.test.ts` 의 실데이터 fixture 2건이 `save/setup_result.json`(gitignore 되는 런타임 산출물)을 읽는데, 현재 파일의 23슬롯 `centering` 이 **전부 null**(마지막 재생성 이후 센터라이징 미수행)이라 "23 슬롯 순회 스텝" 기대치를 만족하지 못한다.
동일 실패가 **변경 없는 main 체크아웃에서도 재현**됨을 확인했다(14 passed / 2 failed). 즉 데이터 상태 이슈이며, 센터라이징을 한 번 돌려 `setup_result.json` 이 갱신되면 해소된다.

### 4.3 정적 검증

- `node --check web/app.js`(ESM) → 구문 정상. 핸들러 삭제로 인한 파싱 오류 없음.
- `rg "makeSetupResultFile|cal-result-file" web/` → 0건(잔여 참조 없음).

브라우저 DOM 자동화 도구(playwright/jsdom)가 프로젝트에 없어 뷰어 실측은 이 저장소의 기존 방식대로 **마크업·결선 소스 검증**으로 수행했다.

## 5. 영향도 분석

| 대상 | 영향 |
|------|------|
| `web/app.css` | **없음** — 셀렉터·그리드 규칙 무변경(자리 교체만) |
| `web/core.js` / `core.d.ts` (`buildTouringPlan`) | **없음** — 순수 함수, 버튼 위치와 무관 |
| `runTouringTest()` | **없음** — `$('cap-touring')` id 그대로, 버튼 라벨 토글(`origLabel`) 로직도 그대로 동작 |
| `#touring-done-modal` | **없음** — 별개 마크업, 결선 유지 |
| `POST /capture/setup-result` | 라우트 유지, **UI 호출자 0** (테스트만 호출) |
| `src/store/setupResult.ts`, `PtzCalibrator`, `server.ts` 재번호 경로 | **없음** — 자동 저장 경로 그대로 |
| `#cal-msg` 메시지 영역 | 이제 센터라이징 잡 메시지 전용(결과 파일 생성 메시지 소멸) |
| 다른 에이전트(ActionAgent/DMAgent), MCP 도구 | **없음** — SettingAgent 뷰어 한정 |

## 6. 잔여 판단 사항

- `POST /capture/setup-result` 라우트와 `setupResultRoute.test.ts` 의 라우트 검증 블록을 함께 정리할지 여부(현재 UI 호출자 없음).
