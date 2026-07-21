# 04. 영향도 분석 — LPD 검지 패널 "DB에 추가" 버튼

최종 문서: `SettingAgent/docs/20260719_234602_LPD박스_DB추가버튼_공간배정.md`

## (a) `matchPlatesToSlots` 불변 → VPD 차량-슬롯 매칭 무영향
`src/setup/plateMatch.ts` 의 기존 `matchPlatesToSlots` 본체·시그니처·export 는 이번 변경에서 **한 줄도 수정되지 않았다**(diff 확인: 함수 위에 신규 함수 `assignPlatesToSlotViews` 와 `MATCH_RADIUS` 상수만 가산). 소비처(`grep matchPlatesToSlots`):
- `src/capture/Aggregator.ts`
- `src/capture/detectPipeline.ts`
- `src/capture/onPlaceFilter.ts`
- `src/setup/SetupOrchestrator.ts`

이들은 finalize/detectPipeline 경로에서 VPD 차량-슬롯 매칭에 계속 기존 함수를 사용하며 회귀 없음(전체 vitest 2019/2019 통과로 실증).

## (b) `lowerFrontAnchor` 재사용 — setup→calibrate import 비순환 확인
`src/setup/plateMatch.ts` 가 신규로 `import { lowerFrontAnchor } from '../calibrate/plateDiscoveryWriter.js'` 를 추가했다. `src/calibrate/plateDiscoveryWriter.ts` 의 import 목록을 실측 확인한 결과 `node:fs`/`node:path`/`../capture/types.js`/`../domain/types.js`/`../util/round.js`/`./types.js` 뿐이며 **`src/setup/` 를 참조하지 않는다** → `setup → calibrate` 방향 신규 import 1건은 비순환. `tsc --noEmit exit 0` 으로도 순환 부재가 간접 확인됨(순환 import 는 통상 빌드/런타임에서 드러남).

## (c) `upsertSlotLpd` 부분 UPDATE·`stringify5` = discovery 자동저장과 동일 컬럼/경로 공유
신규 라우트는 discovery(`plateDiscoveryWriter`)가 이미 쓰는 동일 메서드(`SqliteStore.upsertSlotLpd`, `UPDATE slot_setup SET lpd_obb=?, updated_at=? WHERE slot_id=?`)와 동일 직렬화 규약(`stringify5`, 소수 5자리)을 재사용한다. **경합이 아니라 공유** — 두 쓰기 주체가 같은 컬럼을 같은 부분 UPDATE 방식으로 갱신하므로 어느 쪽이 나중에 실행되든 다른 컬럼(roi/vpd/occupy/pan/tilt/zoom/centered/img1/slot3d_front_center)은 wipe 되지 않는다(`test/slotLpdDbAdd.test.ts` 실DB 왕복 테스트로 실증: 타 컬럼·타 슬롯 불변, `updatedAt` 미변경 슬롯 원본 유지 확인).

## (d) 신규 라우트 가산·기존 라우트 불변
`POST /capture/slots/lpd` 는 신규 엔드포인트로 `deps.store` 만 사용해 무조건 등록(가드 없음). 기존 `/capture/detect`·`/capture/slots`(GET)·`/capture/slots/reset` 요청/응답 shape 은 **무변경**(captureRoutes.test.ts 60개 전부 통과로 회귀 0 확인).

## (e) types·VPD 정책 불변
- `@parkagent/types`/`src/domain/types.ts`(NormalizedQuad 등) 신규 타입 없음 — 기존 타입 재사용만.
- VPD 자동검출 정책(메모리 `vpd-auto-detect-forbidden`) 미접촉 — 이 버튼은 LPD 전용 경로이며 VPD 클라이언트/검출을 호출하지 않는다.
- 오버레이 유지 정책(메모리 `settingagent-overlay-retain-policy`) 준수 — 저장 후 오버레이를 지우지 않고 `#roi-db` DB 소스만 재조회.
- 5자리 소수 영속화 규약(메모리 `settingagent-persist-5decimals`) 준수 — `stringify5` 로 직렬화.

## (f) 좌표 정합 한계 (수동 PTZ) — 확인 필요 항목으로 명시
"현재화면 순수 LPD"(수동 줌 PTZ) 모드로 검출한 plate 는 검출 프레임 좌표계가 프리셋 base 좌표계와 다를 수 있어, 이 버튼을 그 모드 검출 직후 사용하면 배정이 부정확할 수 있다. 이번 구현·검증 범위에서 **수동 PTZ 프레임의 base 역투영 여부는 검증되지 않았다** — 향후 사용 시 "확인 필요" 항목으로 남긴다. 순수 LPD/VPD→LPD(프리셋 PTZ 그대로 검출) 경로는 라이브 재검증(문서 §4)으로 정합이 실증됐다.

## 요약 표

| 영향 대상 | 결과 |
|---|---|
| VPD 차량-슬롯 매칭(finalize/detectPipeline) | 무영향(함수 불변, 소비처 4곳 확인) |
| import 순환 | 비순환(실측 확인) |
| DB 쓰기 경합(discovery vs 버튼) | 없음(동일 부분 UPDATE 경로 공유) |
| 기존 REST 계약 | 불변(회귀 테스트로 확인) |
| 공유 타입/VPD 정책 | 불변 |
| 좌표 정합 | 프리셋 정합 검출 한정 유효, 수동 PTZ는 한계로 명기(확인 필요) |
