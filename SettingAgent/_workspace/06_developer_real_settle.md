# 06. 구현: RealPtzSource.move() 실기 슬루 정착(settle) 폴링

작성: 구현자(developer) / 대상 브랜치: `fix/calibrate-follow-viewer-source` (커밋 없음)

## 1. 문제 (리더 확정 진단, 재조사 없음)

실카메라(192.168.0.153) `mode:'plate-zoom'` 폐루프가 과줌·헌팅.
`logs/setting_20260721_140420.log` 실측: 약 750ms 간격으로 goptzfpos 연속 발사,
`zoompos 12007 → 16171 → 21584 → 28621 → 27717 → 26573` 진동, 화면은 x36(최대) 포화.

원인: `RealPtzSource.move()` 가 `goPtzfPosition` 204 를 받자마자 **이동 완료를 확인하지 않고 반환**.
시뮬(Unity)은 setPTZ 즉시 반영이라 `settleMs=300` 으로 충분했지만, 실기는 팬/틸트/줌이 수 초에 걸쳐 슬루한다.
→ 폐루프가 **아직 움직이지 않은 프레임**을 측정 → 오차 그대로 → 스텝을 더 키움.

## 2. 변경 파일

| 파일 | 성격 | 내용 |
|------|------|------|
| `src/viewer/RealPtzSource.ts` | 수정 | 정착 폴링 추가(`waitUntilSettled`), raw 조회 헬퍼 추출, 타이밍 주입 옵션 |
| `test/realPtzSourceSettle.test.ts` | 신규 | 정착 폴링 유닛테스트 7건 |
| `test/realPtzSource.test.ts` | 1줄 수정 | move 검증에서 `seen.at(-1)` → `find(action==='goptzfpos')` (폴링이 뒤따르므로) |

`src/calibrate/*`(PlatePtz·PtzCalibrator·settleMs)는 **한 줄도 건드리지 않았다**. 신규 config 필드 없음.

## 3. 구현 내용

### 3.1 `move()` 흐름
```
goPtzfPosition(target raw)  →  waitUntilSettled(target)  →  lastPtz 갱신  →  true
```

### 3.2 `waitUntilSettled(target)` 종료 규칙
- 루프: `sleep(pollMs)` → `getPtzfPosition()` raw 읽기.
- **정상 종료**: (연속 2회 raw pan/tilt/zoom 이 모두 동일 = 정지) **AND** (목표 근접: pan/tilt |Δ|≤10, zoom |Δ|≤300).
  - 정지만으로 끊지 않는 이유: 명령 직후 **아직 슬루를 시작하지 않은 구간**도 "연속 동일"로 보인다.
    이 조기 반환이 곧 이번 버그의 재현이므로, 목표 근접을 함께 요구해 원점 정지 오판을 막는다.
    (지시서 종료조건 ①·② 를 논리곱으로 합친 형태 — ② 를 만족하면 ① 도 만족하므로 계약 위배 없음.)
- **상한 초과(안전판)**: 총 대기 `timeoutMs` 초과 시 `logger.warn({ cat:'centering', target, last, elapsedMs, timeoutMs }, 'PTZ 이동 정착 대기 상한 초과 — 미정착 상태로 반환')` 후 **정상 반환**. 예외를 던지지 않는다(폐루프가 죽는 것보다 낫다). 조용한 강등이 아니라 목표·최종 raw·경과 ms 를 전부 남긴다.
- **폴링 실패**: `getPtzfPosition` throw → 흡수하고 **즉시 반환**. 응답 필드 불완전(파싱 불가)도 즉시 반환.
  기존 `currentPtz` 의 "위치 조회 미지원 모델 강등" 정책과 일관.

### 3.3 상수와 근거 (코드 상수 + 한글 주석, config 아님)
| 상수 | 값 | 근거 |
|------|-----|------|
| `SETTLE_POLL_MS` | 150 | 실측 폐루프 재촬영 간격(~750ms)보다 촘촘해야 정지 판정이 늦지 않다. 5회 폴링이 1 스텝 주기 안에 들어간다. |
| `SETTLE_TIMEOUT_MS` | 5000 | x1→x36 풀 슬루가 수 초. 그 이상 미정착이면 장비 이상으로 보고 warn 후 진행. 폐루프 1 스텝이 최악 5s 로 상한. |
| `SETTLE_PAN_TILT_EPS` | 10 raw | 팬 0~35999(=360°)에서 0.1° 수준. 장비 정지 위치의 미세 편차 흡수용. |
| `SETTLE_ZOOM_EPS` | 300 raw | 줌 0~65535(=1~36x)에서 약 0.16x. 줌 인코더 잔떨림 흡수용. |

### 3.4 주입 (테스트 결정성)
생성자 4번째 인자 `settle: RealPtzSettleOptions = {}` — `{ pollMs?, timeoutMs?, sleep? }`.
`sleep` 기본값은 `setTimeout` 래퍼. `sourceRegistry` 호출부(3인자)는 무변경 → 기본 상수 사용.

### 3.5 부수 정리
`currentPtz()` 내부의 raw 파싱을 신설 `readNativePtz()` 로 추출해 정착 폴링과 공유(동작 동일, 중복 제거).
이 추출은 이번 변경으로 필요해진 것만 대상이며 그 외 코드·포맷은 손대지 않았다.

## 4. 검증 실측

```
$ npx tsc --noEmit
tsc exit=0            (출력 없음 = 0 에러)

$ npx vitest run
 Test Files  184 passed (184)
      Tests   2147 passed (2147)
   Duration  13.26s
```
기준선 183파일/2140테스트 → 184파일/2147테스트 (신규 파일 1, 신규 테스트 7). **실패 0, 회귀 0.**

신규 테스트(`test/realPtzSourceSettle.test.ts`) 7건:
1. 슬루 중 계속 폴링 → 정지+근접에서 종료, `move` 가 true, 폴링 5회·sleep 5회.
2. 정지했지만 목표에서 멀면 조기 종료 안 함(미출발 구간 오판 방지).
3. 허용 오차 이내(35990/8995/65300)면 도달로 판정 → 폴링 2회.
4. 상한 초과: `Date.now` + 주입 sleep 으로 가상 시각 진행 → 예외 없이 `logger.warn` 1회, payload 의 target/last/elapsedMs 검증.
5. 폴링 예외 흡수 → 1회 읽고 즉시 반환(재시도 없음).
6. 응답 필드 불완전 → 즉시 반환.
7. 타이밍 미주입(기본 상수)에서도 계약 동일 — 정지 프레임이면 2회 폴링(≈300ms).
1~6 은 sleep 주입으로 **실시간 대기 0**.

## 5. 영향도

- **시뮬(Unity) 경로**: `SimulatorSource`/`src/calibrate/*` 무변경 → 회귀 0(전체 스위트로 확인).
- **실기 경로**: `move()` 가 이제 정지 확인까지 블로킹한다. 정상 슬루 시 지연 = 실제 이동 시간 + 최대 150ms, 최악 5s 상한. `snapshot(manual)`, `streamMjpeg(ptz)` 도 move 경유라 동일하게 정착 후 진행 — 이것이 본래 의도(이동 완료 후 촬영).
- `centerOnPoint`(네이티브 `setcenter`) 경로는 **미변경**. 지시대로 손대지 않았다.
- 공개 API 변경: 생성자 4번째 선택 인자 추가(하위호환), `RealPtzSettleOptions` export 신설.

## 6. 미검증 (은닉 금지)

- 상수 150ms / 5000ms / ±10 / ±300 의 **현장 적정성은 라이브 미검증**. 실기에서 (a) 5s 상한 warn 이 뜨는 빈도, (b) 줌 인코더 잔떨림이 ±300 raw 를 넘어 정지 판정이 안 서는지, (c) x1→x36 풀 슬루가 5s 안에 끝나는지 확인 필요.
- `setcenter`(centerOnPoint)에는 정착 폴링을 넣지 않았다(지시 범위 밖). 센터링 직후 조회가 이동 중 값을 읽을 가능성은 남아 있다.
- 폐루프 과줌이 실제로 사라지는지는 **실장비 재현 로그로만** 확정 가능. 본 변경은 원인(조기 반환) 제거이며, 폐루프 게인 자체는 손대지 않았다.
