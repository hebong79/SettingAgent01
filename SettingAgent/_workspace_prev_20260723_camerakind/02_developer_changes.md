# 02 — 구현 완료 보고 (정밀수집 "시작" 파이프라인)

설계서: `docs/20260722_181647_정밀수집시작_파이프라인_설계.md`
구현: 2026-07-22 · 대상 `SettingAgent/`
컴파일 `npx tsc --noEmit` 통과 · `npx vitest run` **202 파일 / 2394 테스트 전량 green**

---

## 1. 변경 파일 목록

| 파일 | 변경 성격 | 내용 |
|------|-----------|------|
| `src/ground/frontCenterBuild.ts` | **신규** | W6 `buildSlotFrontCenters()` — `captureRoutes.ts:488~524` 본문 이동(로직 변경 0) |
| `src/pipeline/SetupPipeline.ts` | 가산 + 재배선 | W1 `startPrecise()`, 대기 상수 4개, `onDiscoverFinished` 후반부를 `beginCalibrate()` 로 분리 |
| `src/api/captureRoutes.ts` | 가산 + 위임 | W2 `POST /capture/start-precise`, `/slots/cuboid` W6 위임, `/slots/load-roi` W6 자동 호출, deps `sources`/`cameraCfg` |
| `src/calibrate/PlateDiscoveryJob.ts` | 파라미터 | W3 `start(filter, {betweenSlotMs, occupySettleMs})` |
| `src/calibrate/PtzCalibrator.ts` | 파라미터 | W4 `start(slotIds?, {betweenSlotMs, camera})` + 배치 경로 카메라 오버라이드 배선 |
| `src/api/server.ts` | 배선 2줄 | `sources`/`cameraCfg` 를 captureRoutes 로 전달 |
| `web/index.html` | UI | 체크박스 2개 삭제, `수집 시작` 버튼 추가, `시작`/`최종화` title 갱신 |
| `web/app.js` | UI | W5 `startPrecise()`, W7 `drawDbCentering()`, `capStart`→`capCaptureStart`, `capFinalize` 표시 전용화, `FLOOR_ROI_USE_LLM=false` 상수화 |
| `test/viewerPtzSyncCoverage.test.ts` | 분류 등록 | 신규 라우트를 `MOVES_CAMERA` 에 등록(테스트가 강제) |
| `test/viewerDisplayReset.test.ts` | 심볼명 | `capStart` → `capCaptureStart` |

**`src/index.ts` 는 무변경** — 마스터 Q2 결정(대기시간은 `start()` 인자)에 따라 싱글턴 주입이 불필요해졌다.

---

## 2. W1~W7 위임 대상

| ID | 신규 코드 | 위임 대상(전부 기존 함수) |
|----|-----------|---------------------------|
| **W1** `SetupPipeline.startPrecise()` | 상태 세팅 + 분기 | preflight=`expandDiscoveryTargets`(탐색 대상 조건과 **같은 함수**) · `deps.discovery.start({}, …)` · 이후 기존 `onDiscoverFinished`/`onCalibrateFinished` 체인 |
| **W2** `POST /capture/start-precise` | 얇은 라우트 | `pipeline.startPrecise()` · source 해석은 `/calibrate/point`(`calibrateRoutes.ts:66~74`) 관용구 **그대로 복제** · preflight 는 `src.listCameras()` |
| **W3** `PlateDiscoveryJob.start` opts | 인자 2개 | 기존 `this.sleep`(생성자 dep) |
| **W4** `PtzCalibrator.start` opts | 인자 2개 | 기존 `this.sleep` · 기존 `makePlatePtz(opts, camera)` 2번째 인자(개별 클릭 경로가 이미 쓰던 통로) |
| **W5** `startPrecise()` (프론트) | fetch 1회 + 폴러 기동 | `capPoll`/`discPoll`/`pollPipeline` 전부 기존 |
| **W6** `buildSlotFrontCenters()` | **코드 이동만** | `buildGroundInputs` → `estimateGroundModels` → `slotFrontCenter` → `upsertSlotFrontCenter` (한 줄도 새로 쓰지 않음) |
| **W7** `drawDbCentering()` | 순수 렌더 ~14줄 | 기존 `toPixelQuad` + bounding rect 중심 |

**신규 알고리즘·검출 로직 0개.** 요건10/11 준수.

---

## 3. 대기시간 배선 (Q2 반영)

`SetupPipeline.ts` 코드 상수 4개 → `startPrecise` 가 `start()` **인자**로만 전달.

| 요구 | 상수 | 적용 지점 |
|------|------|-----------|
| 1 (슬롯당 0.5s) | `PRECISE_DISCOVER_BETWEEN_SLOT_MS=500` | `PlateDiscoveryJob.run` 슬롯 루프 말미 |
| 2 (점유 0.3s) | `PRECISE_OCCUPY_SETTLE_MS=300` | `PlateDiscoveryJob.saveSlotLpd` **프리셋 그룹** 루프(Q3: 슬롯 단위로 쪼개지 않음) |
| 3 (탐색→센터링 1s) | `PRECISE_DISCOVER_TO_CALIBRATE_MS=1000` | `SetupPipeline.beginCalibrateAfterDelay` |
| 6 (센터링 슬롯당 1s) | `PRECISE_CALIBRATE_BETWEEN_SLOT_MS=1000` | `PtzCalibrator.run` 슬롯 루프 말미 |

**회귀 0의 구조적 근거**: 수동 `/discover/ptz`·`/calibrate/ptz` 는 인자를 넘기지 않는다 → 값이 `undefined` →
`if (opts.betweenSlotMs)` 가 거짓 → **sleep 코드에 도달조차 하지 않는다**. 같은 싱글턴을 공유해도 안전.

---

## 4. 설계서와 달라진 점

| # | 설계서 | 실제 구현 | 이유 |
|---|--------|-----------|------|
| D1 | W3/W4 를 `Deps` 필드로 | **`start()` 인자**로 | 마스터 Q2 결정 |
| D2 | 대기값을 `index.ts` 에서 주입 | `SetupPipeline.ts` **코드 상수** | D1 의 귀결 — 주입 지점이 사라짐. `index.ts` 무변경 |
| D3 | (미언급) | `SetupPipelineDeps.sleep?` 추가 | 요구3 대기의 테스트 시임. 미주입 시 `setTimeout` |
| D4 | (미언급) | `PipelineStatus.precise?: boolean` 추가 | 프론트 완료 메시지 분기(요구8). **수집 경로 응답 shape 불변**(precise 일 때만 부착) |
| D5 | (미언급) | `SetupPipeline.beginCalibrate()` / `beginCalibrateAfterDelay()` private 분리 | `onDiscoverFinished` 후반부를 **그대로** 옮긴 것. 대기를 삽입할 자리를 만들기 위한 최소 분리(로직 변경 0) |
| D6 | W6 이 라우트 가드까지 흡수 | 가드는 라우트에 잔류 | `/slots/cuboid` 의 404(ground 미설정)·409(slot_setup 비어있음)·ENOENT 매핑을 **바이트 단위로 보존**하기 위해. 함수는 실패 시 throw 하고 호출자가 코드를 정한다 |
| D7 | 최종화 라벨 변경 검토(Q5) | 라벨 `최종화` 유지, title 만 갱신 | 마스터 Q5 결정 |
| D8 | 완료 메시지 형식 | `정밀수집 완료 — 탐색 n/N · 센터링 m/M · setup_result.json 저장` | 설계서 SC7 그대로. n/N·m/M 은 기존 `/discover/status`·`/calibrate/status` 를 1회씩 읽어 채운다(신규 집계 0) |

### 마스터 결정 반영 확인
- **Q3** 0.3s = 프리셋 그룹 단위 ✓ (`buildOccupyRegionsBySlot` 미분해)
- **Q4** `config/tools.config.json` **무변경** ✓ (targetPlateWidth 0.215 / widthTol 0.015 그대로)
- **Q5** `최종화` 표시 전용화 ✓ · `Finalizer` 클래스와 `/capture/finalize` 라우트 **보존** ✓
- **Q6** 노란 원 = `slot_setup.lpd` bounding rect 중심, `!centered || !lpd` 스킵 ✓
- **Q8** `수집 시작` 버튼 분리 추가 → 기존 `POST /capture/start` 호출(핸들러 `capCaptureStart` 로 이름만 정리) ✓
- **Q9** `PlateDiscoveryJob.start({})` = 전 슬롯 ✓
- **Q11** 자동 경로 `H_CONST=1.5` 고정, 프론트는 `heightM` 미전송 ✓
- **요건12** 백엔드 `autoChain`·`floorRoiUseLlm` **스키마·코드 전부 보존** ✓ (프론트가 `autoChain` 미전송)

---

## 5. Q7 확인 결과 — **규약 준수 (수정 불필요)**

`src/store/SaveStore.ts:60` — `saveSnapshot(name, data)` 은
```ts
const json = stringify5(data, 2);
```
`stringify5` 를 사용한다. `writeSetupResultFiles` → `SaveStore.saveSnapshot` 경로는 소수점 5자리 규약을 지킨다.

**실측 교차검증**: 실행 후 `save/setup_result.json` 전문을 정규식 `-?\d+\.(\d{6,})` 로 훑어 **소수점 6자리 이상 0건**.
샘플: `{"pan":5.07684,"tilt":10.84132,"zoom":11.10518}`.

---

## 6. 실동작 검증 (13020 라이브)

> ⚠️ 착수 시 브리핑은 "시뮬레이터(13100) 미가동" 이었으나, **실제로는 카메라 소스가 응답했다**
> (포트 13100/13110 은 refused 이지만 `simulator-1` 소스는 다른 경로로 살아 있었다).
> 덕분에 **정밀수집 전 구간 실동작 검증이 가능**했다.

| SC | 결과 |
|----|------|
| SC1 stage 전이 | `idle → discovering → calibrating → done` ✓ **capturing/finalizing 단계 없음** |
| SC3 lpd·occupy | `GET /capture/slots`: 23행 중 **lpd 23 · occupyRange 23 · centered 22 · frontCenter 23** |
| SC4 탐색→센터링 ≥1.0s | discovery `endedAt 10:01:57.699` / calibrate `startedAt 10:01:58.702` → **1.003s** ✓ |
| SC5 판폭 | `slot_ptz.json` 23건 중 **22건이 0.18~0.25**. 밴드 밖 1건 = slot12 `plateWidth 0, reason no_plate`(정직 실패 — 위장 없음) |
| SC6 setup_result | `save/setup_result.json` + `save/Setup_20260722_190453.json` 2벌 생성, `centering` non-null **22** = 센터링 성공 수 일치 ✓ |
| SC10 리얼 차단 | `POST /capture/start-precise {"source":"real-camera-1"}` → **400** `리얼 소스는 프리셋 순회 미지원(소스 프리셋 1개) …` + `missing:["1:2","1:3","2:1","2:2"]` ✓ |
| — source 미존재 | `{"source":"nope"}` → **400** `source not found` ✓ |
| **W6 자동 경로** | `POST /capture/slots/load-roi` → **200 ok:true**, `issues` 말미 `앞면 중심 산출 23건 / 스킵 0건(h=1.5m)` ✓ |
| **W6 동등성(U14)** | load-roi 자동 산출 결과와 `POST /capture/slots/cuboid`(heightM 미지정) 결과의 `slot3d_front_center` **전 슬롯 완전 일치** ✓ |

### 확인 못 한 항목 (qa-tester 인계)
1. **SC2 슬롯 간격 0.5s 실측** — 잡 상태 폴링(2s 주기)으로는 슬롯 경계를 직접 재지 못했다. 전체 실적은 탐색 23슬롯 44초(≈1.9s/슬롯, LPD 왕복 포함)로 0.5s 대기와 모순 없으나 **직접 증거는 아니다**. → fake sleep 유닛테스트(U4)로 봉인 필요.
2. **SC5 센터링 슬롯 간격 1.0s 실측** — 동일. 센터링 23슬롯 175초(≈7.6s/슬롯). → U5 로 봉인 필요.
3. **SC7/SC8/SC9 (프론트)** — 브라우저 렌더는 확인하지 못했다. 완료 메시지·노란 원·DOM 제거는 정적 검사만 수행.
4. **U12 강등 경로** — `ground.enabled=false` 에서 load-roi 가 200·`issues` 강등되는지는 라이브로 재현하지 못했다(설정 변경 필요). 코드 경로는 `if (!deps.ground?.enabled)` 분기로 존재.
5. **U13 부작용 격리** — W6 실행 전후 전 컬럼 비교는 `lpd/occupyRange/centered` 카운트 수준으로만 확인.

### 실행 부산물 (마스터 확인 요망)
정밀수집 1회 완주로 아래가 **실데이터로 갱신**되었다(백업 보관: 스크래치패드에 `plate_discovery.bak.json`·`slot_ptz.bak.json`):
`data/plate_discovery.json`, `data/slot_ptz.json`, `data/setting.sqlite`(slot_setup lpd/occupy/centering), `save/setup_result.json`, `save/Setup_20260722_190453.json`, `data/camerapos.json`(load-roi 파생 갱신).

---

## 7. 구현 중 발견한 문제 / 주의

1. **`test/viewerPtzSyncCoverage.test.ts` 가 신규 라우트 분류를 강제한다.** `/capture/start-precise` 를 `MOVES_CAMERA` 로 등록하지 않으면 실패한다. 설계서에 없던 하네스 제약이라 여기에 기록한다.
2. **`buildFinalizeOccupancy()` 고아화** — `capFinalize` 가 `/capture/finalize` 를 더 이상 부르지 않으면서 유일 호출자가 사라졌다. 내 변경이 만든 고아이므로 제거했다(CLAUDE.md §3).
3. **`PtzCalibrator` 카메라 오버라이드 시 프리셋 PTZ 캐시 미사용** — 기존 `startPtzFor(t, override)` 계약이 "override 시 캐시 금지"(소스 간 PTZ 테이블 혼입 방지)라 그대로 따랐다. 결과적으로 배치에 source 를 지정하면 슬롯마다 `listCameras()` 1회가 추가된다(23회). 슬롯당 1s 대기가 있는 경로라 체감 영향은 없으나 **설계서에 없던 부작용**이라 기록한다.
4. **`cap-finalize` 버튼의 disabled 게이트 유지** — 수집 진행 중에는 여전히 비활성이다(`captureUiState.finalizeDisabled`). 표시 전용이 된 지금은 굳이 막을 이유가 약하지만 **요청 범위 밖**이라 건드리지 않았다.
5. **소스 미지정 시 프리셋 preflight 미수행** — `source` 를 안 보내면 부팅 카메라를 쓰는데, 그 소스의 프리셋 집합은 검사하지 않는다(설계 §7.2 분기 B 가 요청 source 기준). 프론트는 항상 `state.source` 를 보내므로 실사용 경로는 덮이지만, API 직접 호출 시 구멍이 남는다.
6. **기존 데드코드(미삭제, 보고만)** — `src/capture/Finalizer.ts` 와 `POST /capture/finalize` 는 정밀수집 UI 에서 도달 불가가 되었다. 마스터 Q5 지시대로 **보존**했다. 수집(`수집 시작`) 경로·기존 테스트는 계속 사용한다.
