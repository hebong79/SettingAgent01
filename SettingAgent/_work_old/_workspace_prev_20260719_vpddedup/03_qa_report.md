# 03_qa_report — VPD 오버레이 개선(차량당 1박스 + #roi-db VPD 소스 전환) 검증

검증자(qa-tester) / 입력: `01_architect_plan.md`, `02_developer_changes.md`, `web/core.js`, `web/core.d.ts`, `web/app.js`
대상 순수함수: `rectIoU`, `dedupeVehicles` (연결요소/union-find dedup)

## 1. 결론

**전체 통과. 소스 결함 없음. 회귀 0.**

- 신규 `test/dedupeVehicles.test.ts` — **21 테스트 전부 통과**.
- 전체 회귀 `npx vitest run` — **163 파일 / 1808 테스트 전부 통과**(이전 1787 + 신규 21). 기존 테스트 회귀 0.
- `npx tsc --noEmit` — **통과(exit 0)**. core.d.ts 선언(`rectIoU`, `dedupeVehicles<T extends {rect:NormalizedRect}>`) 정합.
- 핵심 회귀방지(그리디→연결요소 교정) 테스트가 **명시적으로** 그리디 실패 조건을 재현하고 연결요소 결과(1개)를 assert.

## 2. 작성한 테스트 목록·의도 (`test/dedupeVehicles.test.ts`)

import 방식은 기존 `preciseCore.test.ts`와 동일하게 `../web/core.js`에서 직접 ESM import.

### rectIoU (8건)
- 완전 일치 = 1 (이진 표현 정확한 좌표 R(0,0,1,1)로 부동소수 오차 회피 — 아래 §5 참조).
- 완전 비겹침 = 0.
- 경계 접함(모서리 공유, 교집합 폭 0) = 0.
- 부분 겹침 수치: a={0,0,1,1}, b={0,0,0.5,1} → 0.5(경계 임계 근처 1건).
- 부분 겹침 수치: 대각 half-overlap → 1/7(≈0.142857).
- 퇴화 w=0 → 면적 0 → IoU 0.
- 퇴화 h=0 → IoU 0.
- 양쪽 모두 퇴화(union≤0) → 0(0나눗셈 가드 검증).

### dedupeVehicles
- **기본 dedup**: 겹침 그룹(IoU≈0.68≥0.5) 마지막 1개 생존 + 별개 차량 유지 → 2개. 사전조건(그룹 겹침·별개 비겹침)도 assert.
- **★ 동심 다중스케일 체인(그리디 회귀 방지, 필수)**: 크기 0.10/0.13/0.17/0.22 동심 4박스. **인접 IoU≈0.59(≥0.5), 양끝 IoU≈0.207(<0.5), 중간 B–D IoU<0.5**를 모두 assert하여 *그리디였다면 [B,D] 2개 잔존*하는 데이터임을 명시. 연결요소 결과 = **정확히 1개, 생존=마지막 index(D)**.
- **마지막 검지 의미**: 동심 3박스(전부 상호 IoU≥0.5) → 1개, 생존 tag=2(원배열 max index).
- **원객체·필드 보존**: plate/confidence/cls 부가필드 가진 객체가 생존 시 **원본 참조 동일(`toBe`)** + 필드값 보존.
- **비겹침 3개**: 전부 유지·원순서·원참조(`toEqual`+`toBe`).
- **인접 차량 비병합**: 두 박스 IoU≈0.111(<0.5) → 각각 유지(2개, 과잉병합 없음).
- **엣지**: 빈 배열→[], undefined→[], null→[], 1개→그대로(원참조), 전부 malformed(rect 없음)→[], 일부 malformed 스킵+나머지 원순서.
- **iouThresh 인자**: 같은 입력(IoU≈0.111)에 th=0.5→2개, th=0.1→1개(병합, 마지막 index 생존). 인자 반영 확인.

## 3. 실행 결과 (그대로)

```
# 신규 테스트
test/dedupeVehicles.test.ts (21 tests) — 21 passed

# 전체 회귀
Test Files  163 passed (163)
     Tests  1808 passed (1808)
  Duration  12.81s

# 타입체크
npx tsc --noEmit → TSC_EXIT=0 (통과)
```

## 4. 경계면 교차 비교 (dedup 입력 shape ↔ detect 응답 vehicles shape)

- **detect 응답 vehicle 요소 shape**(plan §0): `{ rect:{x,y,w,h}, confidence, cls, plate? }`.
- **dedupeVehicles 시그니처**(core.d.ts:443): `<T extends { rect: NormalizedRect }>(vehicles: T[], iouThresh?: number): T[]`. `NormalizedRect = {x,y,w,h}` (core.d.ts:5) — rect 필드 정합.
- **app.js 통합**(app.js:933): `state.detectByKey[presetKey(cam,preset)] = { ...detect, vehicles: dedupeVehicles(detect.vehicles ?? []) }`. 입력이 raw 응답 배열, `?? []`로 null 가드. 출력이 **원객체 참조 보존**이므로 `confidence/cls/plate`가 하위 소비처(drawDetectOverlay `index i`, `hitTestDetections`, `buildFlatSlotRows`)로 그대로 전달 — 필드 유실 없음.
- **index 정합**: 수집 시점(ingestion) dedup + 원순서 복원(`sort((a,b)=>a-b)`)이므로 `detectByKey`를 공유하는 렌더·선택·목록 소비처가 동일한 축소 배열·안정 index를 본다(렌더에서만 dedup 시 발생하는 선택 index 어긋남 회피). 구조적으로 정합.
- **#roi-db VPD 소스 전환**: app.js:876 `drawDbVpd(ctx, rows)` 신설·`drawDbDetect` 제거 확인. DB 렌더 계약(`toPixel(row.vpd)` → `{px,py,pw,ph}`)은 `dbOverlayParity.test.ts`가 실 finalize→DB→getSlotSetup 전 경로로 통과 유지(2 테스트 pass).

## 5. 발견 이슈 / 처리

- **테스트 자체 버그 1건(수정 완료)**: 초기 "완전 일치=1"을 좌표 R(0.1,0.1,0.2,0.2)로 작성 시 `1.0000000000000004`(부동소수 오차)로 실패. **이는 rectIoU 소스 결함이 아니라 부동소수 동일성 비교의 오검증** — 이진 표현이 정확한 R(0,0,1,1)로 교체해 정확히 1을 얻어 통과. (다른 수치 케이스는 `toBeCloseTo`로 검증.)
- **소스 결함 없음**: 설계서 §1(연결요소 교정)·§2 안 그대로 구현. dedupeVehicles가 동심 체인 회귀를 정확히 방지함을 테스트로 확정.
- **dbOverlayParity.test.ts 주석 갱신**: 구현자 노트대로 `drawDbDetect` 참조는 주석 2곳뿐(단정문은 `toPixel`/`toPixelQuad` 직접 사용). 정확성을 위해 주석을 `drawDbVpd`로 외과적 갱신(단정문 불변, 통과 유지). 소스 로직은 미변경.

## 6. 검증 한계 (은닉 없이 명시)

- **DOM/canvas 렌더는 vitest 범위 밖**: "겹침 박스가 실제로 사라졌는가", "#roi-db 체크 시 VPD가 DB 소스로 전환되는 시각", "선택 하이라이트/8핸들/삭제 동작"은 리더의 라이브 서버/sharp 스샷 관찰로 최종 확정(설계서 §4-b). 본 검증은 **순수 로직(dedup/IoU)만 vitest로 확정** — 차량당 1개 병합 규칙·마지막 검지·원순서·malformed 스킵·임계 인자는 완전 커버.
- **app.js 통합(runLiveDetect dedup 호출, #roi-db 분기, drawDbVpd)은 코드 리뷰(shape 교차 §4)로 확인**했고, 순수함수 단위 커버로 로직 정합은 보장되나 브라우저 실행 스모크는 리더 관찰 몫(외부 VPD/DOM 미가동 환경 — 삭제/위장 없이 한계로 명시).

## 7. 산출물

- 신규 테스트: `SettingAgent/test/dedupeVehicles.test.ts`
- 갱신(주석만): `SettingAgent/test/dbOverlayParity.test.ts`
- 본 리포트: `SettingAgent/_workspace/03_qa_report.md`
