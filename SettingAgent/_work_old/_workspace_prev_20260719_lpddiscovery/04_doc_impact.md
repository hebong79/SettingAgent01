# 영향도 분석 — LPD discovery 검지율 개선 (A 앵커하향 / B 격자탐색 / §9 배타성게이트)

- 작성: documenter (Sonnet) / 2026-07-19
- 최종 문서: `SettingAgent/docs/20260719_220248_LPD검지율개선_앵커하향_격자탐색_배타성게이트.md`
- 변경 파일(4개): `src/calibrate/plateDiscovery.ts`, `src/calibrate/cropZoom.ts`, `src/calibrate/plateDiscoveryWriter.ts`, `src/calibrate/PlateDiscoveryJob.ts`. `src/calibrate/types.ts`는 주석 1줄만(코드 무변경).

## (a) `slot3d_front_center` 타 소비자 — 불변 확인 (grep 전수)

`slot3dFrontCenter`/`slot3d_front_center` 소비 파일 전수(grep 결과):
`PlateDiscoveryJob.ts`, `types.ts`(도메인 타입), `plateDiscoveryWriter.ts`, `pipeline/SetupPipeline.ts`, `capture/types.ts`, `index.ts`, `capture/SqliteStore.ts`, `tools/migrateToSettingDb.ts`, `capture/Finalizer.ts`.

- **DB 값·산출식 자체는 무변경.** `Finalizer.ts:252`의 `slotFrontCenter(sp.points, model, H_CONST)` 산출 로직, `SqliteStore`의 저장 컬럼, `capture/types.ts`의 타입 정의 모두 손대지 않았다.
- **하향은 `expandDiscoveryTargets`(plateDiscoveryWriter.ts) 내부에만 국한.** `anchor: lowerFrontAnchor(v.roi, v.slot3dFrontCenter)`로 discovery용 `DiscoveryTarget.anchor`만 하향점으로 치환하고, `v.slot3dFrontCenter` 원본 값은 그대로 둔다.
- **센터라이징 경로(`expandPlateTargetsFromSlotSetup`, `slotPtzWriter.ts:17-32`)는 `v.lpd`(검출된 LPD quad)를 사용하지, `v.slot3dFrontCenter`를 전혀 참조하지 않는다** — 코드 확인 완료(별개 데이터 소스). 따라서 이번 변경으로 센터라이징 동작에 영향 없음.
- **뷰어 오버레이**: `viewer/routes.ts`·`capture/types.ts`에서 `slot3dFrontCenter`는 조회·직렬화 대상일 뿐 discovery 앵커 하향 로직과 분리되어 있다 — grep 결과 뷰어 쪽에서 하향된 값을 참조하는 지점 없음(직접 코드 문자열 `slot3dFrontCenter` 매치 없음, 뷰어는 `capture/types.ts`의 원본 타입을 그대로 통과).
- **결론**: discovery 앵커 하향은 discovery 파이프라인 내부 전용이며, 다른 어떤 소비자(센터라이징·뷰어·DB)에도 파급되지 않는다.

## (b) `discoverSlot` 시그니처 — 옵셔널 확장, 하위호환

```ts
discoverSlot(t: DiscoveryTarget, presetPtz?: Ptz | null, peerAnchors: NormalizedPoint[] = []): Promise<PlateDiscoveryItem>
```
- 3번째 인자 `peerAnchors`는 옵셔널 배열(기본 `[]`)로 추가됐다. 기존 2-인자 호출부는 전부 그대로 컴파일·동작한다(`[]`이면 배타성 게이트가 무조건 통과 — 구 동작과 동일한 "최근접 채택" 결과).
- 유일한 호출부는 `PlateDiscoveryJob.run`(내부)이며, 이번 변경으로 3번째 인자를 채워 전달하도록 수정됐다.
- 테스트 시임 `PlateDiscoveryApi = Pick<PlateDiscovery, 'discoverSlot'>`은 구조적 타입이라 옵셔널 인자 추가를 자동 추종 — 시임 정의 자체는 무수정.
- qa-tester V-14가 기존 discoverSlot/시임 테스트 무수정 전수 통과로 하위호환을 실측 봉인.

## (c) slot_setup.lpd 쓰기 경로 · 데이터 규약 — 불변

- `upsertSlotLpd`(`PlateDiscoveryJob.ts:214`)를 통한 부분 UPDATE 방식은 그대로다 — DELETE+INSERT로의 회귀 없음(기존 "finalize wipe fragility" 이슈와 무관, 그 취약점을 재유발하지 않음).
- `stringify5`(소수점 5자리 규약)도 `saveSlotLpd`·`writePlateDiscovery` 양쪽에서 그대로 사용.
- 격자 30칸 확장(`step` 값 범위 1..30)은 `PlateDiscoveryItem` 스키마를 바꾸지 않는다(`step: number`는 원래도 임의 정수 허용) — `plate_discovery.json` 소비자(감사용)는 파급 없음.
- 아핀 역계산(`backmapQuad`) 공식은 무변경 — 오프셋 창에서도 좌표 정확성이 유지됨을 V-2(왕복 파리티)가 봉인.

## (d) `pickNearestPlate`(controlMath) — 무접촉, 타 소비자 영향 0

- `pickNearestPlate` 함수 자체(`controlMath.ts`)는 이번 변경에서 수정하지 않았다.
- `plateDiscovery.ts`는 이번 변경으로 `pickNearestPlate` import를 제거하고 신규 `pickOwnedPlate`로 대체했다(고아 정리 — CLAUDE.md §3 "자신의 변경으로 사용되지 않게 된 import 제거" 원칙 부합).
- `pickNearestPlate`의 다른 소비자인 `platePtz.ts`(PTZ 폐루프 정렬)·`detectPipeline.ts`는 이번 변경과 무관하게 그대로 `pickNearestPlate`를 계속 사용 — **영향 0**. grep으로 소비 파일 4개(`plateDiscovery.ts`, `detectPipeline.ts`, `platePtz.ts`, `controlMath.ts`) 확인, 이 중 `plateDiscovery.ts`만 이번에 참조를 끊었을 뿐 나머지 3곳은 무변경.

## (e) `H_CONST` 중복 상수 — 동기 주의 (구조적 부채, 확인 필요 항목)

- `Finalizer.ts:41` (`H_CONST = 1.5`, private)와 `plateDiscoveryWriter.ts:13` (`H_CONST = 1.5`, 신규)가 **값을 독립적으로 중복 보유**한다. `Finalizer`의 상수가 private라 import가 불가능해 부득이하게 리터럴을 복제했다.
- 양쪽 다 주석으로 상호참조를 명기했으나(`plateDiscoveryWriter.ts:12` "Finalizer.ts:41과 동일값... 값 변경 시 양쪽 동기 필요"), **컴파일러가 강제하는 장치는 없다.** 향후 육면체 높이(`H_CONST`) 값이 변경되면 한쪽만 고치고 다른 쪽을 놓칠 위험이 존재한다.
- **확인 필요(단정 보류)**: 공용 상수화(예: `Finalizer.ts`의 `H_CONST`를 export하거나 별도 공용 모듈로 승격)는 이번 범위에서 하지 않았다 — 설계서 §7이 "공용화는 과설계로 배제, 필요 시 후속"으로 명시적으로 보류한 결정이다. 후속 작업에서 재검토가 필요하다면 이 부채를 인지하고 진행할 것.

## (f) 실행시간·잡 구조 영향

- 미검지 슬롯당 LPD 최대 호출 수: 기존 6회(Tier0 1 + Tier1 5) → **31회**(Tier0 1 + 격자 30). 검지 성공 슬롯은 즉시 반환이라 영향 미미, 미검지 슬롯(예: slot10)의 소요 시간이 늘어난다 — 시뮬 6슬롯 기준 라이브에서 수용 범위로 확인됨(리더 3회 재실행 완료).
- 잡 상태머신(`idle`/`running`/`done`/`error`)·409 중복거부 규약은 무변경.

## (g) found 수치 해석 변경 — 문서화 필수 사항

- §9 배타성 게이트 적용 후 `found` 카운트가 정직해지며(위장 절도 제거), 동일 시나리오에서 수치가 **하락할 수 있다**(관찰: 6/6 위장 → 5/6 정직). 이는 소프트웨어 결함이 아니라 의도된 교정이므로, 향후 이 잡의 `found`/`done` 통계를 소비하는 모니터링·QA 스크립트가 있다면 "found 감소 = 회귀"로 오판하지 않도록 그 소비처에 이 사실을 전달할 필요가 있다(현재 grep 기준 `PlateDiscoveryJob.getStatus()`의 `found` 소비처는 `viewer`/`routes` 상태 조회뿐 — 자동 알람·게이트로 소비하는 곳은 확인되지 않음, **확인 필요** 항목으로 남김).

## 검증 근거 (qa-tester 실측, 그대로 인용)

- `npx vitest run --no-file-parallelism` → **174 files / 1984 tests passed (0 failed)**.
- `npx tsc --noEmit` → **exit 0**.
- 실 LPD/카메라 스모크 테스트: **미수행**(외부 서비스 미가동, 명시적 누락 — 통과 위장 아님).
- 라이브(리더, 실 서비스): cam1:preset2 3회 재실행 일관 — 정직 5/6, 중복 점유 0. slot10은 리더가 15+ 크롭 구성으로 직접 스윕해 LPD 서비스 한계로 진단(파이프라인 결함 아님).

## 미해결 / 확인 필요 항목 (documenter 단정 보류)

1. `H_CONST` 중복 상수 공용화 여부 — 설계상 의도적 보류, 후속 판단 필요.
2. `found` 통계를 소비하는 외부 모니터링/알람 존재 여부 — 현재 코드 grep 기준 없음으로 보이나 완전한 부정 증명은 아님.
3. slot10류 LPD 미검 사례의 향후 재발 시 대응(§9-6 2차 레버: 줌레벨 간 재캡처·줌레벨 미세화)은 설계만 되어 있고 미구현 — 필요 시 별도 이터레이션.
