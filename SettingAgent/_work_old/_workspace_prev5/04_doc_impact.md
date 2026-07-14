# 04 영향도 분석 요약 — 드롭다운 선택 시 Unity 물리 이동 결선

- 작성일시: 2026-07-01 18:08:12
- 변경 범위: `SettingAgent/web/app.js` 2줄(`sel-cam`·`sel-preset` change 핸들러 각 `gotoPreset();` 1줄)
- 최종 문서: `SettingAgent/docs/20260701_180812_SettingAgent_뷰어드롭다운선택_Unity물리이동_결선.md`

## 1. 변경이 유발하는 파급

### 1-1. 드롭다운 선택 → 물리 이동 유발 (의도된 동작 변경)
- 이전: 드롭다운 change는 표시만 갱신(`/req_img` 스트림 유지).
- 이후: 드롭다운 change 시마다 `gotoPreset()`→`move()`→`POST /viewer/api/move`→`/req_move` 물리 이동이 1회 발생.
- **부수효과**: 카메라/프리셋 전환이 잦으면 `/req_move`(및 후속 `loop.tick()`의 `/req_img`) 호출 빈도가 증가한다. 사용자 상호작용당 1회이므로 폭주는 아니나, 전환이 빈번한 세션에서 Unity 이동 명령 트래픽이 늘어난다. `gotoPreset()`은 fire-and-forget이라 UI 블로킹은 없음.

### 1-2. `btn-goto` 기능 중복 (무해)
- "이동" 버튼(app.js:1155)과 드롭다운 자동 이동이 동일 `gotoPreset()`을 호출 → 기능 중복.
- 의도된 중복. 버튼은 동일 프리셋 재적용/명시적 재이동 수단으로 유지. 이중 실행 위험 없음(각각 별개 이벤트).

### 1-3. 초기 로드 무이동으로 인한 초기 웹↔Unity 불일치
- 정책상 초기 페이지 로드 시 물리 이동을 하지 않으므로, 로드 직후 웹 표시 PTZ와 실제 Unity 카메라 위치가 다를 수 있다.
- **해소 시점**: 사용자가 프리셋/카메라를 (재)선택하거나 "이동" 버튼을 누르는 첫 조작에서 즉시 동기화됨. 초기화 레이스 회피를 위해 의도적으로 채택한 트레이드오프.

## 2. 무영향 확인 (의존성 그래프 추적)

| 대상 | 영향 | 근거 |
|------|------|------|
| `web/core.js` / `core.d.ts` | 무영향 | `findPresetPtz` 등 기존 함수 재사용, 시그니처·로직 무변경 |
| 서버 라우트(`viewer/routes.ts` `/viewer/api/move`) | 무영향 | 기존 `/move`→`/req_move` 계약 그대로 재사용, 신규/변경 엔드포인트 없음 |
| `SimulatorSource` / `CameraSource` / `CameraClient` | 무영향 | REST 계약(`/req_move`, `/req_img`) 변경 없음 |
| 스트리밍(`makeUrl`, `loop`) | 무영향 | `move()` 성공 시 기존대로 `state.ptz` 갱신 후 `loop.tick()` — 자동 이동 후 스트림이 새 PTZ를 따라가는 것은 의도된 동작 |
| 기존 버튼(방향/절대/goto) | 무영향 | 코드 무변경, 동작 동일 |
| `renderPresetSelect` / `syncPtzFromPreset` | 무영향 | 무변경. 물리 이동 미주입으로 초기화 레이스 없음 |
| 캡처 파이프라인(`CaptureJob`/`Finalizer`) | 무영향 | 뷰어 프런트엔드 이벤트 결선일 뿐, 캡처 로직과 무관 |
| MCP 도구(`camera_req_move` 등) / 도구 경계 | 무영향 | 순수 프런트엔드 DOM 결선. 결정형 도구/LLM 두뇌 신설·변경 없음 |
| ActionAgent / DMAgent | 무영향 | 별도 서비스. 공유 REST 계약·공유 타입 변경 없음(변경은 SettingAgent 웹 정적자산 국한) |
| `@parkagent/types` / 공유 도메인 타입(SlotState/ParkingEvent 등) | 무영향 | 타입 변경 없음 → 타 에이전트로의 타입 전파 없음 |

## 3. 검증 상태 (사실 기반)

- 전체 vitest **426/426 통과**(회귀 없음). 신규 순수 로직 없어 **신규 테스트 없음**.
- `node --check web/app.js` 통과. 서빙 `app.js`에 `gotoPreset` 참조 **3회**(버튼1+신규2) 확인.
- **실제 Unity 물리 이동은 자동 검증 밖 → 수동 확인 필요**(최종 문서 §7 체크리스트).

## 4. 확인 필요 항목 (단정하지 않음)

- 실 Unity 환경에서의 드롭다운→물리 이동·초기 로드 미이동은 수동 확인으로만 검증 가능(자동 검증 미포함).
- 전환이 매우 빈번한 사용 패턴에서의 `/req_move` 호출 증가에 따른 체감 부하는 실사용 관찰 필요(현재는 상호작용당 1회로 판단, 문제 징후 없음).
