# 04 문서화·영향도 분석 요약 — 개별 center+zoom (이터레이션 1+2+3 누적)

작성: 2026-07-21 · 문서화(documenter)
이터레이션 1 문서: `SettingAgent/docs/20260721_161759_클릭센터줌_반경게이트_줌사다리.md`
이터레이션 2 문서: `SettingAgent/docs/20260721_175130_클릭센터줌_실카라이브결함_zoomRange정정.md`
**이터레이션 3 문서(신규)**: `SettingAgent/docs/20260721_191430_클릭센터줌_상한확정_진동제거_정렬무회귀.md`

이 파일은 이터레이션 3(수정 17~21) 반영으로 **갱신**한 것이다. 이터레이션 1·2 시점 내용은 각 이터레이션 문서 §4 참조. 아래 §이터레이션 3 섹션이 이번 갱신분이며, 그 위 섹션들은 이터레이션 2 시점 그대로 보존한다.

---

## ★ 이터레이션 3 갱신분 (수정 17~21)

### 반전 요약(이터레이션 3)
마스터 2차 실카 검증에서 양쪽 끝 먼 차량 조준이 성공(이터레이션 2 zoomRange 정정이 주효)했고, 남은 3건을 처리했다. 그 과정에서 "사다리가 더 나쁜 상태로 끝난다"는 리더의 로그 관측이 **1회성이 아니라 3주기 반복 진동**이었고, 원인이 **뷰어 zoom이 raw 엔코더의 선형 사상이지 광학 배율의 선형 사상이 아니라는 것**(실측 `w/z`가 16배→36배 구간에서 5배 변화)임이 드러났다. 대응은 사다리의 선형 외삽(`zWant=zoom×target/width`)을 **모델 무가정 이분 탐색**으로 교체하는 것이었다. 사다리의 핵심 제어 방정식(latch·게이트 스케일링·성공 판정 조건)은 "다음 zoom을 고르는 방법" 외에는 이번에도 손대지 않았다.

### 변경 파일(이터레이션 3, git diff 기준)
- `src/calibrate/platePtz.ts` — 신규 private 메서드 3건: `finalizeAtDeviceLimit()`(수정 17, 상한 도달 시 재중심 1회로 정렬을 "만들어" 최종 확정) · `restoreBest()`(수정 18, 종료 상태가 최선보다 `widthTol`만큼 더 나쁘면 최선 지점 복귀) · `finalizeConverged()`(수정 21, 폭 수렴 성공 출구의 무회귀 정렬 확인). 이분 탐색 로직(수정 20, `LADDER_BRACKET_MIN_SPAN=0.01`) + `PlatePtzFailReason`에 `'zoom_resolution_limit'` 추가. 신규 결과 필드: `recenterAttempts`·`restoredToBest`·`centerShortfall`(전부 옵셔널)
- `web/app.js` — 신규 헬퍼 `moveBasePtz()`(수정 19, 이동 직전 장비 실측 기준화 + 조회 실패 시 이동 차단) + 완료 메시지 일반화(수정 20)
- 신규/확장 테스트: `test/platePtzLadder.test.ts` L7(5, 수정 17·18) · L8(4, 수정 20 — **`opticalMock` 임의 곡선 주입 스텁 신규 도입**) · L9(5, 수정 21)

### 무접촉/무변경 확인(이터레이션 3)
- `src/api/calibrateRoutes.ts` — 이번에도 무접촉.
- `config/`·`src/config/toolsConfig.ts` — 이터레이션 3은 config를 건드리지 않는다(이터레이션 2의 zoomRange 정정만 유효).
- 사다리 latch 판정·게이트 스케일링(`k=zoom/aimZoom`)·`preLatchZoomStepRatio`·성공 조건(`isWidthConverged`) — **무변경**. 수정 20이 바꾼 것은 다음 zoom을 고르는 방법(외삽→괄호 이분)뿐이다.
- `@parkagent/types` — 변경 없음. 신규 필드(`recenterAttempts`/`restoredToBest`/`centerShortfall`/`zoom_resolution_limit`)는 전부 `platePtz.ts` 내부 로컬 타입 → **타 에이전트 전파 없음**.

### REST 계약 변경(이터레이션 3)
- 엔드포인트·요청·응답 shape 무변경.
- 신규 옵셔널 필드 3종(`recenterAttempts`·`restoredToBest`·`centerShortfall`) + `PlatePtzFailReason` 신규 값 `'zoom_resolution_limit'` — 전부 하위호환.

### 거짓 성공 금지선 재점검(이터레이션 3 — 구현자 자체 재확인, QA 독립 재실행 없음)
수정 17이 상한 도달 시 성공 판정을 확장하지만, latch 실패·반경 밖 판·재중심 후 tol 밖·재확인 대상 소실·재중심 명령 거절·이웃 갈아타기·폭 미달 은닉 7개 금지선을 코드 경로로 재대조해 전부 차단을 재확인했다(이터레이션 2 문서 §S2에서 QA가 세운 반례 7건과 동일 구조). 수정 21은 `ok:true`→`ok:false` 전환을 만들지 않는 무회귀 설계이며, 이는 L9 테스트(§아래 검증 상태 요약)로 고정됐다. **다만 이 재점검 자체는 구현자 자체 확인이며, 03_qa_report.md에 이터레이션 3 전용 검증 섹션은 없다** — 아래 "검증 상태 요약(이터레이션 3)" 참조.

### 검증 상태 요약(이터레이션 3, 사실 그대로)
- **191파일 / 2260테스트 전건 통과 — 리더 독립 확인**(`tsc --noEmit` 포함).
- 경과: 191/2246(이터레이션 2 마감, 리더 확인) → 191/2251(수정 17~19 후, 구현자 자체 보고) → 191/2255(수정 20 후, 구현자 자체 보고) → **191/2260(수정 21 후, 구현자 자체 보고 + 리더 독립 확인)**.
- **`03_qa_report.md`에는 수정 17~21(이터레이션 3)에 대한 전용 검증 섹션이 없다.** 이터레이션 1·2에서 QA가 수행한 독립 재실행·반례 설계·델타 검증 패턴이 이번 범위에는 적용되지 않았다 — 이 공백을 은닉하지 않는다.

### 운영 주의사항(이터레이션 3 — 이터레이션 2와 동일, 재확인 필요)
- `web/`은 nodemon 감시 밖 — 수정 19·20의 UI 동작(이동 기준 실측화·완료 메시지)을 반영하려면 브라우저 강력 새로고침(Ctrl+F5) 필요. **이터레이션 2 검증에서 이 절차 누락이 "수정이 안 먹은 것"으로 보인 유력 원인**이었으므로 3차 검증 전 특히 주지시킬 것.
- config 변경 없음(이번 이터레이션은 서버 재기동 불요).

### 확인 필요(이터레이션 3 — 불확실, 단정하지 않음)
- **마스터 3차 실카 검증 미실시.** 수정 17~20의 인과(§진동 산술 포함)는 로그 사후분석 + `opticalMock` 유닛 테스트로 확정됐으나, 이분 탐색이 실제 장비에서 진동을 제거하는지는 미실측.
- **`centerOnPlate`·`zoomToPlateWidth`(배치 경로)는 여전히 실카 미검증** — 실카 배치 센터라이징 실행 전 별도 검증 필요.
- **`real-camera-2` 미실측**(이터레이션 2부터 이어지는 한계, 해소되지 않음).
- **느리지만 계속 움직이는 장비의 rung 대기**(이터레이션 2 QA S4) — 이번 이터레이션에서 다루지 않음, 그대로 남음.
- QA의 독립 재실행이 수정 17~21 범위에 없음(위 검증 상태 요약 참조).

---

## 이터레이션 1+2 누적분 (보존 — 이터레이션 2 시점 그대로)

이 파일은 이터레이션 2(수정 7~16 + 리더 파이프라인 밖 핫픽스) 반영으로 **갱신**한 것이다. 이터레이션 1 시점 내용은 이터레이션 1 문서 §4 참조.

---

## 반전 요약
이터레이션 1은 "줌 사다리 알고리즘이 옆차를 확대한다"는 가설로 마감됐다. 마스터 실카 라이브 실측 후 로그 분석으로 **진짜 원인은 `RealPtzSource`의 `zoomRange` 오설정([0,65535], 실제 장비 상한은 16384)**임이 확정됐다. 사다리 알고리즘(게이트 스케일링·배율·rung 예산)은 이터레이션 2에서 **한 줄도 수정되지 않았다** — 전부 그 주변(zoom 범위·UI 상태 동기화·조준/줌 정착 대기·상한 도달 시 성공 판정)에 대한 대응이다.

## 변경 파일 (이터레이션 2, git diff 기준)
- `src/viewer/RealPtzSource.ts` — `waitUntilStopped()`(신규) · `centerOnPoint`가 `settled` 필드 반환 · `waitUntilSettled`에 `stopped_short`/`no_motion` 조기 반환 추가. `HUCOMS_DEFAULT_ZOOM_RANGE` 값 자체는 **무변경**([0,65535] 유지 — 다른 실측 모델 보호 목적, config로 override)
- `src/calibrate/platePtz.ts` — `recenterTo`가 `settled:false`→`aim_failed` 전파 · `LADDER_ZOOM_STALL_*` 정체 판정(수정 11) · `saturatedOutcome`(수정 13, 성공 경계 변경) · 진단 로그 필드 4종(`zoomCmd`/`zoomAct`/`bytes`/`sha`) 가산. **사다리 게이트 스케일링·배율(2.0/1.3)·rung 예산은 무변경**(구현자·QA 매 수정마다 재확인)
- `src/config/toolsConfig.ts` — `CameraSourceConfigSchema.ptz.{panRange,tiltRange,zoomRange}` 개별 `.optional()`화(**리더 파이프라인 밖 핫픽스**, 경위는 아래 참조)
- `config/tools.config.json` / `tools.config.example.json` — `real-camera-1`·`real-camera-2`에 `"ptz":{"zoomRange":[0,16384]}` 추가(**운영 데이터 변경**)
- `web/app.js` — `syncPtzAfterJob` 신규 헬퍼 + 배선 6곳(수정 7 최초 4곳 + 수정 14 신규 2곳: `runLiveDetect`·`pollPipeline` discovering 전이) + 완료 메시지 문구(수정 13)
- 신규 테스트: `test/toolsConfigPtzOptional.test.ts`(11) · `test/viewerPtzSyncCoverage.test.ts`(11) · `test/realPtzSourceCenterSettle.test.ts`(+9, 누적 14) · `test/platePtzLadder.test.ts`(+L4/L5/L6)

## 리더 핫픽스 경위 (숨기지 않음)
수정 10(config에 `zoomRange` 단독 추가) 직후 **마스터 서버가 ZodError로 기동 실패**했다 — 스키마가 `ptz` 세 필드를 함께 요구했는데 `RealPtzSource.ts:132~134`는 이미 축별 `?? 기본값` 폴백이라 코드는 그럴 필요가 없었다. 리더가 급히 세 필드를 각각 `.optional()`로 바꿔 **유닛테스트 없이 `tsc` 통과만 확인**하고 반영했다. 이후 QA가 최우선으로 검증(§S1): 기존 3축 config·`zoomRange`만 지정(현재 실카)·`ptz` 미지정(시뮬)·실제 config 로드·축별 optional↔`RealPtzSource` 폴백 정합·3-튜플 아닌 값은 여전히 거부됨을 전부 확인했고, `test/toolsConfigPtzOptional.test.ts`(11케이스, 영구 테스트)로 회귀 가드를 봉인했다.

## 무접촉/무변경 확인
- `src/api/calibrateRoutes.ts` — 이터레이션 2에서도 **무접촉**(reason/필드는 그대로 통과).
- 사다리 알고리즘 핵심(게이트 스케일링 `k=zoom/aimZoom`·`preLatchZoomStepRatio`·`ladderRungBudget`) — **이터레이션 2 전체에서 무변경**. 원인이 알고리즘이 아니라 zoom 범위 설정이었다는 §반전 요약의 직접적 증거.
- 배치 경로 코드(`calibrateSlot`/`acquireAndCenter`/`zoomToWidthWithRecovery`) — 무변경. 단 zoomRange 정정으로 **물리적 도달 가능 범위가 3.7배 넓어져 동작 결과가 달라질 수 있다**(재측정 필요, 아래 확인 필요 참조).
- `@parkagent/types`(공유 패키지) — 변경 없음. 신규 필드(`settled`/`widthShortfall`/`zoomCmd` 등)는 전부 SettingAgent 내부 로컬 타입. **타 에이전트(ActionAgent/DMAgent) 전파 없음.**

## REST 계약 변경
- 엔드포인트·요청·응답 shape **무변경**(이터레이션 1과 동일).
- `saturatedOutcome`으로 새로 열리는 성공 출구: `ok:true` + `widthShortfall:true`(신규 옵셔널 필드) — 폭 미달이라도 신원·정렬이 실측 검증되면 성공. 하위호환.
- `settled?: boolean`이 `Ptz`를 확장(`CameraClient.NativeCenterResult`) — 기존 구현·호출부 전부 호환.

## config 스키마·운영 데이터 변경
- `CameraSourceConfigSchema.ptz` 3필드 개별 optional화 — 기존 config 그대로 유효, 완화만 됨(형태 검증력은 유지: 3-튜플 아닌 값은 여전히 거부).
- `config/tools.config.json`의 `real-camera-1`/`real-camera-2`에 `zoomRange:[0,16384]` 추가 — **실제 운영 값 변경**이며 zoom 계산 전체(사다리·배치·UI 수동 줌·acquire 사다리)의 물리적 상한이 바뀐다.

## ★ 운영 주의사항 (필독)
1. **`web/`은 nodemon 감시 밖이다.** 수정 7·13·14의 UI 동작(PTZ 동기화·완료 메시지·VPD/discovery 동기화)을 반영하려면 **마스터가 브라우저를 강력 새로고침(Ctrl+F5)** 해야 한다. 서버 자동 재기동으로는 반영되지 않는다.
2. **`config/`는 서버 재기동이 필요하다.** `loadToolsConfig()`는 기동 시 1회 로드이며 핫리로드가 아니다. `zoomRange:[0,16384]` 정정을 포함해 `config/tools.config.json` 변경 후 **서버를 재기동하지 않으면 구 설정으로 계속 동작한다.**

## 공유 도메인 타입 파급
이터레이션 1과 동일 — `@parkagent/types` 무변경, 전파 없음.

## 검증 상태 요약 (03_qa_report.md 인용, 사실 그대로)
- 리더 독립 확인 최종 수치: **191파일 / 2246테스트 전건 통과**(`tsc --noEmit` 클린).
- QA가 **직접 실행해 구현자 보고와 일치를 확인**한 지점: 187/2192(이터레이션1 재검증) · 189/2220(이터레이션2 기준선) · 190/2231(신규 회귀테스트 추가 후).
- 189/2213(수정 7~9 직후)·191/2246(수정 14~16 직후)은 **구현자 자체 보고**이며, `03_qa_report.md`에는 이 두 시점에 대한 QA의 독립 재실행 기록이 없다. 191/2246은 리더가 이 문서화 지시 시점에 별도로 독립 확인했다.
- 이터레이션 2에서 QA가 새로 발견한 결함 8건(전부 "거짓 성공 아님"으로 분류, `03_qa_report.md` §S9): S6-①/② 중간(동기화 누락 2곳, 수정 14로 해소) · S4 중간(저속 지속 이동 장비 rung당 15초 유지) · S7 중간(영속 zoom 17건 물리적 의미 변화, 수정 16으로 시뮬 출처 확정·조치불요 결론) · S3-①/S6-③/S2-①/S5 낮음(사유 오보·source 불일치·UX 경계·no-op 구별 불가, 전부 미해결로 남김).
- 수정 13(성공 경계 변경) 금지선은 QA가 반례 7건을 별도 설계해 전건 차단을 확인했다(§S2) — 위장 성공 금지 원칙 유지.

## 확인 필요(불확실 — 단정하지 않음)
- **마스터 실카 재검증이 아직 수행되지 않았다.** zoomRange 정정 이후 실제 클릭 성공률은 미실측.
- **`real-camera-2`(192.168.0.154)의 `zoomRange:[0,16384]`는 미실측**이다(같은 기종이라 같은 값을 넣었으나 확인 안 됨).
- **배치 센터라이징 폭 수렴률 재측정 미수행** — zoomRange 정정으로 천장이 넓어진 효과가 과거 미수렴 슬롯에 어떤 영향을 줬는지 확인되지 않음.
- **S6-③(배치 잡이 `source`를 동봉하지 않는데 동기화는 `state.source`를 조회하는 구조적 불일치)**은 이번 범위 밖으로 남겨져 리더 판단 대기 중.
- 189/2213·191/2246에 대한 QA 독립 재실행 기록 부재 — 191/2246은 리더가 별도 확인했으나 정식 QA 산출물(`03_qa_report.md`)에는 반영되지 않았다.
