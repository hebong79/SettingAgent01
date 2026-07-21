# 03 QA 검증 리포트 — discovery 현재 프리셋 한정 + LPD 박스 표시

검증자(qa-tester) 독립 검증. 대상: discoverRoutes.ts / PlateDiscoveryJob.ts / web/app.js / test/discoverRoutes.test.ts.
검증일 2026-07-19. 작업 디렉토리 `SettingAgent`.

## 판정 요약

| 항목 | 결과 |
|---|---|
| 개발자 테스트 감사 | 통과 — 단, **부분 지정(cam만/preset만) 미커버** → 보강 4케이스 가산 |
| 필터 위치·옵셔널 게이트 정합 | 통과 — expandDiscoveryTargets 직후·slotIds 앞, `cam!=null && preset!=null` 게이트 확인 |
| 회귀 0(직렬 전량) | **172 파일 / 1934 테스트 전량 통과** (exit 0) |
| `npx tsc --noEmit` | exit 0 |
| `node --check web/app.js` | APP_JS_OK |
| 경계면 교차(REST↔Job↔프론트) | shape 일치 확인, key 정합 확인 |
| 소스 결함 | **없음** (리더 main 에스컬레이션 불요) |

## 1. 개발자 테스트 감사 (discoverRoutes.test.ts)

개발자 신규 describe "현재 프리셋 한정" 4케이스는 정확하나 **옵셔널 게이트의 부분 지정 거동을 검증하지 않음**. 설계 확정 결정(G1)은 "cam+preset **동시** 전달 시에만 필터"인데, cam만·preset만 전달 시 전체 배치가 보존되는지(게이트가 실제로 `&&` 인지)는 테스트 공백이었다. 게이트가 실수로 `||` 나 단일 조건으로 바뀌어도 개발자 테스트는 전부 통과하는 허점 → 아래 4케이스 보강.

보강 케이스(test/discoverRoutes.test.ts, describe "현재 프리셋 한정"):
- `start({cam:1}).total===2` — cam만 → 게이트 미충족 → 전체 보존
- `start({preset:2}).total===2` — preset만 → 게이트 미충족 → 전체 보존
- `start({cam:1,preset:1,slotIds:['1']}).total===1` — 프리셋 한정 + slotIds 교집합(둘 다 같은 자리)
- `start({cam:1,preset:1,slotIds:['2']}).total===0` — 프리셋 한정 후 불일치 slotIds → 공집합

결과: **discoverRoutes.test.ts 16/16 통과**(기존 12 + 보강 4). 게이트가 `&&` 로 올바르게 구현됨을 실증.

감사한 기존 커버리지(유효): `start({cam:1,preset:2}).total===1`(프리셋 한정), `start({}).total===2`(회귀 0), `start({cam:9,preset:9}).total===0`(미보유), 라우트 `payload:{cam:1,preset:2}`→200·total===1, `payload:{cam:'x'}`→400(스키마), 409/404/frame 기존 케이스 불변.

## 2. 필터 위치·옵셔널 게이트 정합 (코드 검증)

PlateDiscoveryJob.ts:113-121 실측:
```
let targets = expandDiscoveryTargets(this.store.getSlotSetup());   // 펼침 불변
if (filter.cam != null && filter.preset != null) {                 // ★ 둘 다일 때만
  targets = targets.filter((t) => t.camIdx === filter.cam && t.presetIdx === filter.preset);
}
if (filter.slotIds && filter.slotIds.length > 0) { ... }            // 기존 slotIds 필터(뒤·같은 자리)
```
- 위치: `expandDiscoveryTargets` **직후**, 기존 slotIds 필터 **앞**. 설계 명시 위치와 일치. expandDiscoveryTargets 불변.
- 게이트: `!= null` 이 undefined·null 모두 커버(`filter.cam` 미전달 시 undefined → 게이트 미충족). 부분 지정 시 안전하게 전체 배치 보존(§1 보강 테스트로 실증).
- 필드 정합: `t.camIdx`=`v.camId`, `t.presetIdx`=`v.presetId`(plateDiscoveryWriter.ts:20-23) ↔ `filter.cam`/`filter.preset`. 1-based 정수 비교 일치.

## 3. 회귀 0 확정 (직렬 전량)

`npx vitest run --no-file-parallelism`(클린 직렬):
```
Test Files  172 passed (172)
     Tests  1934 passed (1934)
  Duration  65.56s
```
- 개발자 보고 1930 → 1934(보강 4 반영). 전량 통과.
- **직렬(--no-file-parallelism)에서 flaky 7건(config/cameraMode/cRpcClient) 0 실패 재현 확인.** 병렬 flaky 는 파일 간 자원 경합이며 직렬에서 소거됨(소스 결함 아님).
- `npx tsc --noEmit` exit 0, `node --check web/app.js` APP_JS_OK.

## 4. 경계면 교차 비교

**(A) `/discover/ptz` body ↔ Job.start(filter) ↔ DiscoveryTarget**
- REST StartBodySchema: `{ slotIds?: string[], cam?: number(int,positive), preset?: number(int,positive) }.default({})`. 라우트가 `deps.discovery.start(parsed.data)` 로 파싱 객체 그대로 전달(discoverRoutes.ts:32).
- Job.start filter 시그니처 `{ slotIds?, cam?, preset? }` 와 필드명·타입 **정확히 일치**. `.default({})` → 빈 body 시 `start({})` → 전체 보존(회귀 0).
- 필터 비교값 `t.camIdx/t.presetIdx`(1-based) ↔ 스키마 `positive` 정수. 정합.

**(B) `/discover/result` item ↔ 프론트 discoverByKey 소비 shape**
- 백엔드 item(types.ts PlateDiscoveryItem): `{ found: boolean, lpdOrig: NormalizedQuad|null, camIdx, presetIdx, ... }`. lpdOrig=원본 프레임 정규화 OBB(4점 quad).
- 프론트 renderDiscResult(app.js:2395-2399): `it.found && it.lpdOrig` 게이트 → `byKey[presetKey(it.camIdx,it.presetIdx)].push(it.lpdOrig)`. 필드명 일치, null 필터 일치.
- 렌더 drawDetectOverlay(app.js:908-909): `state.discoverByKey?.[currentFrameKey()]` 조회 → `drawPlateQuad(ctx, q, false)`. q=lpdOrig quad → `toPixelQuad`(정규화 4점→픽셀). 기존 라이브/DB LPD(라인 899·901·905, row.lpd OBB quad)와 **동일 헬퍼·동일 quad shape**. 좌표 변환 불요(원본 프레임 정규화라 라이브 LPD 와 동좌표계).

**(C) key 정합(핵심 — 저장키 vs 조회키)**
- 저장: `presetKey(it.camIdx, it.presetIdx)` = `${camIdx}:${presetIdx}`(core.js:24).
- 조회: `currentFrameKey()`(app.js:358-361) = `presetKey(cam, preset)` — 동일 함수·동일 포맷. **키 포맷 불일치 없음.**
- 값 정합: discStart 가 보낸 cam/preset 로 백엔드 필터 → result item 의 camIdx/presetIdx 가 그 값 → 저장키가 그 프리셋. 조회키(currentFrameKey)가 현재 표시 프리셋과 같으면 렌더. 프리셋 전환 시 키 불일치로 자동 은닉(설계 의도 D). #roi-plate 게이트 공유.

## 5. 한계 / 리더 라이브 필요 (vitest 범위 밖)

- **박스 표시 DOM 렌더**: drawPlateQuad 의 canvas 실제 픽셀 출력·노랑 색상·#roi-plate 해제 시 은닉은 DOM 없이 유닛 불가. 리더 라이브 검증(배경 정보상 완료: discoverByKey→drawPlateQuad #roi-plate 게이트·현재 프리셋만 확인)에 의존.
- **discovery 실 검지율**: lpdOrig 산출은 실 LPD 서비스 필요. 유닛은 makeDiscovery 시임(foundItem)으로 대체 — 실 검지 정합은 리더 라이브+실 LPD 스모크 필요(**누락 명시**, 통과 위장 아님).
- **capFrameKey2 게이트 비대칭(관찰 권고)**: discStart 는 `state.capFrameKey2?.cam ?? state.cam` 무조건 사용, currentFrameKey 는 `capFrameTimer && capFrameKey2` 조건부. 정밀수집 순환 중(capFrameTimer 활성) 저장키=capFrameKey2 프리셋, 완료 후 startLive 가 capFrameTimer 를 멈추면 조회키가 state.cam/preset 로 폴백 → 순환 표시 프리셋과 라이브 선택 프리셋이 다를 경우 키 불일치 가능. **단, 이는 기존 detectByKey(라인 872)·runLiveDetect 와 동일한 키 시맨틱을 그대로 상속**한 것으로(설계가 runLiveDetect L928-929 미러 명시), 신규 결함이 아님. 라이브 검출 박스가 현재 프리셋에 정상 표시된다면 discovery 박스도 동일하게 표시됨. 정밀수집 순환 뷰 상태에서의 표시 일치는 리더 라이브 sanity 로 확인 권고.

## 결론

소스 결함 없음. 개발자 구현은 설계(4파일 침습·게이트·필터 위치·shape) 준수. 개발자 테스트의 부분 지정 공백을 보강(16/16)하여 옵셔널 게이트를 실증. 회귀 172파일/1934테스트 직렬 전량 통과, tsc 0. 리더(main) 에스컬레이션 불요.
