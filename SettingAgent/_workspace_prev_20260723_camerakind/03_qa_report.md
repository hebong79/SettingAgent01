# 03 — 검증 보고 (정밀수집 "시작" 파이프라인)

설계서: `docs/20260722_181647_정밀수집시작_파이프라인_설계.md` §11.1 (U1~U14)
구현 보고: `_workspace/02_developer_changes.md`
검증: 2026-07-22 · `SettingAgent/` · vitest 2.1.9 · `npx tsc --noEmit` 통과

---

## 1. 요약

| 항목 | 결과 |
|------|------|
| 전량 회귀 `npx vitest run` | **209 파일 / 2465 테스트 전량 통과 · 실패 0** |
| 신규 테스트 파일 | 7개 / **71 테스트** (전부 통과) |
| 기존 테스트 수정 | **0** (기존 202파일·2394테스트 그대로 + 71 = 2465, 산술 일치) |
| 발견한 구현 결함 | **0** — `dev-precise` 재수정 요청 없음 |
| 실데이터 파괴 | **없음**(DB 전부 `:memory:`, ROI/camerapos 는 동결 픽스처를 `os.tmpdir()` 로 복사) |

브리핑에 언급된 선행 실패(`test/slot3dFrontCenter.test.ts > 프리셋2 근접면 검증`)는 **현재 존재하지 않는다**.
커밋 `2d48088`("slot3dFrontCenter 실데이터 스모크 재정박")로 이미 해소되어 22 테스트 전량 green 이다.

---

## 2. U1~U14 항목별 결과

| ID | 파일 | 결과 | 비고 |
|----|------|------|------|
| **U1** | `test/setupPipelinePrecise.test.ts` | ✅ 8 | discovering→(1s)→calibrating→done · `discovery.start({}, {betweenSlotMs:500, occupySettleMs:300})` · `calibrator.start(undefined, {betweenSlotMs:1000[, camera]})` · finalize/getSnapshot **미접촉** |
| **U2** | 〃 | ✅ 3 | 앵커 0 → `discovery.start` 미호출 + `failed{discover}` + 사유에 "ROI 파일 로딩" · preflight 실패 후 잠기지 않음 |
| **U3** | 〃 | 6 ✅ | 비무장 no-op · 수집 경로는 `discovery.start` 인자 1개·`calibrator.start()` 인자 0개·**sleep 0회** · `precise` 키 미부착(응답 shape 불변) · 정밀→수집 전환 시 오버라이드 누수 없음 |
| **U4** | `test/plateDiscoveryJobDelay.test.ts` | ✅ 8 | **fake sleep 실측**: 500 = 슬롯수(6/3), 300 = **프리셋 그룹수**(2/3, Q3 확인) · 순서 `[500×N, 300×P]` · 미검출 프리셋은 300 없음 · **미지정/빈opts/0 → sleep 0회** |
| **U5** | `test/ptzCalibratorDelay.test.ts` | ✅ 7 | 1000 = 슬롯수(4/1/필터2) · `camera` 오버라이드가 배치의 **모든** PlatePtz 로 전달 · **미지정 → sleep 0회 + camera undefined** |
| **U6** | `test/ptzCalibratorZoomSaturated.test.ts` | ✅ 5 | **요건5 봉인**: `centered:true / converged:false / reason:'zoom_saturated'` · item.ptz·plateWidth 는 **줌 단계(포화)** 결과 · `upsertSlotCentering` 행 = `{slotId, pan, tilt, zoom, centered:1, img1:null, updatedAt}` **전 필드 단언** · `max_iterations` 동일 규약 · 수렴 시 대조군 |
| **U7** | `test/captureStartPreciseRoutes.test.ts` | ✅ 9 | 200+`{ok,stage:'discovering',precise:true}` · busy 409 · source 미존재 400 · sources 미주입 400 · invalid body 400 · preflight 실패 시 **200 이지만 ok:false + failure** · pipeline 미주입 시 404 · `listCameras` 실패 502 · source 어댑터가 `calibrator.start` 로 전달됨 |
| **U8** | 〃 | ✅ 5 | 프리셋 1/4 보유 → **400** + 사유에 '프리셋'·'1개' + `missing:['1:2','2:1','2:2']` + 잡 미발화·파이프라인 미무장 · 전량 보유/여분 보유는 200 · **source 미지정 시 preflight 미수행**(구현자 §7-5 구멍을 봉인이 아니라 관측으로 기록) |
| **U9** | `test/dbCenteringOverlay.test.ts` | ✅ 9 | `web/app.js` 의 `drawDbCentering` **원본 소스를 그대로 떼어** `new Function` 으로 실행(복사본 아님). lpd bounding rect 중심 · r=5 · `#ffd60a` · `centered=0`/`lpd=null` **스킵** · 비축정렬 quad 도 bbox 중심(꼭짓점 평균 아님) · 체크박스 2개 삭제·버튼 분리 배선 |
| **U10** | `test/setupResult.test.ts` | ✅ 7 | 무변경 회귀 통과 |
| **U11** | `test/loadRoiFrontCenterAuto.test.ts` | ✅ 2 | load-roi 200/ok:true + `issues` 에 `앞면 중심 산출 N건 … (h=1.5m)` · **보고 N = DB non-null 실적 일치** · 산출값 소수점 ≤5자리(round5 규약) |
| **U12** | 〃 | ✅ 3 | `ground` **미주입** / `ground.enabled=false` 둘 다 **200 + ok:true + slots>0**, `issues` 에 '앞면 중심 미산출 — …ground.enabled=false', front_center 전부 null(위장 저장 없음) · `/capture/slots` 응답 shape 불변 |
| **U13** | 〃 | ✅ 3 | **전 컬럼 비교**: 모든 컬럼을 실데이터처럼 시드(lpd/occupy/pan/tilt/zoom/centered/img1)한 뒤 라우트와 **동일 인자**로 `buildSlotFrontCenters` 실행 → `slot3dFrontCenter`·`updatedAt` 외 전 필드 동일(`toEqual` 전체 + 8개 필드 개별 단언). `updated>0` 로 무동작 통과 차단 · skipped 슬롯의 기존 front_center 미파괴 · **라우트 경로 쓰기 추적**: `replaceSlotSetup` 이후 DB 쓰기는 `['upsertSlotFrontCenter']` 하나뿐 |
| **U14** | 〃 | ✅ 3 | 같은 서버에서 `POST /capture/slots/cuboid`(heightM 미지정) 후 값 **완전 동일** + `updated` = 자동 산출 건수 · **독립 서버 대조**(A=자동만 / B=자동+버튼) 슬롯 신원 기준 완전 일치 · `heightM:2.5` 명시 시 값이 **달라짐**(일치가 자명한 결과가 아님을 반증) |

---

## 3. 구현자가 "확인 못 했다"고 보고한 항목의 처리

| 구현자 보고 | 본 검증의 결론 |
|-------------|----------------|
| SC2 슬롯 간격 0.5s 실측 불가 | **U4 로 확정** — fake sleep 호출 인자·횟수 직접 계수(슬롯 6개 → `sleep(500)` 정확히 6회). 미지정 시 0회도 함께 봉인 |
| SC5 센터링 1.0s 실측 불가 | **U5 로 확정** — 슬롯 4개 → `sleep(1000)` 정확히 4회 |
| U12 `ground.enabled=false` 강등 미재현 | **U12 로 재현·확정**(라우트 경유 200/ok:true/issues/전 null) |
| U13 전 컬럼 비교 미수행 | **U13 로 수행**(전 컬럼 `toEqual` + 쓰기 호출 추적 2중) |
| SC7/SC8/SC9 프론트 렌더 | **부분 확정** — `drawDbCentering` 의 좌표·스킵 로직은 실소스 실행으로 확정. 실제 canvas 픽셀·브라우저 렌더는 **미검증**(§5) |

---

## 4. 신규 테스트 파일

```
test/setupPipelinePrecise.test.ts        17  U1·U2·U3
test/plateDiscoveryJobDelay.test.ts       8  U4
test/ptzCalibratorDelay.test.ts           7  U5
test/ptzCalibratorZoomSaturated.test.ts   5  U6
test/captureStartPreciseRoutes.test.ts   14  U7·U8
test/dbCenteringOverlay.test.ts           9  U9
test/loadRoiFrontCenterAuto.test.ts      11  U11·U12·U13·U14
                                         ──
                                         71
```

격리 관용구: DB `SqliteStore(':memory:')` · ROI/camerapos 는 `test/fixtures/PtzCamRoi.unity.json`·
`camerapos.sample.json` 을 `mkdtempSync(tmpdir())` 로 복사 · 잡 `writer` 는 전부 스텁(파일 IO 0) ·
외부 REST(카메라/LPD/VPD/소스)는 전부 스텁 — 실 서비스 왕복 **0**.

---

## 5. 검증하지 못한 것 (정직한 명시)

1. **브라우저 실렌더** — `startPrecise()` 진행 메시지, 완료 메시지 문자열(`preciseDoneMessage`), 노란 원의
   실제 canvas 픽셀은 확인하지 못했다. U9 는 `drawDbCentering` 의 **좌표·스킵 로직**만 실소스로 확정했고,
   `#roi-db` 체크 → `drawDbCentering` 호출까지의 DOM 이벤트 경로는 **정적 문자열 검사**에 그친다.
2. **실시간 대기의 벽시계 검증** — U4/U5 는 fake sleep 이라 `sleep(500)` 이 실제로 500ms 를 소비하는지는
   보지 않는다(기본 `setTimeout` 구현 신뢰). 구현자의 라이브 실측(SC4 탐색→센터링 1.003s)이 이를 보완한다.
3. **`data/setting.sqlite` 실 DB 상 동작** — 전부 `:memory:` 로 수행했다. 실 파일 DB 의 잠금·트랜잭션 거동은
   기존 `sqliteStore.test.ts` 범위이며 본 변경이 건드리지 않았다.
4. **시뮬레이터 라이브 스모크** — 본 검증은 전부 모킹이다(브리핑 요구). 라이브 실적은 구현자 보고 §6 이 정본.
5. **`source` 미지정 시 프리셋 preflight 미수행**(구현자 §7-5) — 이는 결함이 아니라 **설계 범위 밖의 구멍**으로
   판단해 U8 마지막 케이스로 **현 거동을 관측·기록**했다(봉인하지 않음). API 직접 호출 시 잘못된 소스로
   순회가 시작될 수 있다 — 마스터 판단 필요.

---

## 6. 부수 관찰(수정하지 않음)

- `SettingAgent/config/camerapos.json` 이 구현자의 라이브 실행(19:00)으로 갱신되어 있다. 본 검증은 이 파일을
  읽지도 쓰지도 않았다(mtime 무변동 확인).
- `test/viewerPtzSyncCoverage.test.ts` 가 신규 라우트를 `MOVES_CAMERA` 로 분류하도록 강제하는 하네스 제약은
  구현자가 이미 반영했고, 전량 회귀에서 통과한다.
