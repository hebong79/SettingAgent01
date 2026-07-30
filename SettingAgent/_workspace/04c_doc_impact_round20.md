# 20회차 영향도 분석 — 「현재 화면 그대로 검출」

- 작성: 2026-07-30 02:01 / 문서화·영향도 분석가
- 근거: `_workspace/01e_architect_plan_round20.md` · `02x/02y/02z_developer_changes_round20*.md` · `05_leader_empirical_round20.md`
- 정본 문서: `docs/20260730_020139_MCP자동바닥ROI_20회차_현재화면그대로검출.md`

---

## 1. 변경 파일별 하류 영향

### 1-1. `groundModelFromIntrinsics` 호출자 20곳 — 왜 무영향인가

`focalPxAtZoom` 배선은 `PresetIntrinsics.fovAtZoom` 이 **옵트인**(생략 시 undefined)이므로, 이 필드를 세우는 곳은 신설된 `currentViewResolver`(`roiAuto.ts`) **단 하나**뿐이다. 설계서(`01e` §2-4)가 20곳을 전수 조사했고 구현자가 재확인(`02x` §1) —

| 호출자 | `fovAtZoom` | 영향 |
|---|---|---|
| `bayGrid.ts:15`(import, 지상고 자가보정) | 상속(복사본) | 무변화 |
| `placeMetaIntrinsics.ts:117`(`placeMetaProvider`, 프리셋별 fov) | 미설정 | 무변화 |
| `roiAuto.ts:337-350` 실카 인라인 provider(`interpolateHfov`) | 미설정 | 무변화 — 실카는 이미 그 줌에서의 유효 화각을 쓰므로 `×zoom` 을 다시 곱하면 17회차 ×4.64 오류가 재발한다. 그래서 설계 단계부터 **대체가 아니라 옵트인 병행**으로 결정됐다(`01e` §2-1) |
| `src/tools/{roiAutoFuse,roiAutoConsensus,roiAutoLopo,roiAutoBench,roiAutoNoise,roiAutoOverlay,roiAutoRecall,roiAutoResidual,roiAutoRowsOverlay,roiAutoRowsDiag,roiAutoRowWhy,roiAutoStripe,realFrameOverlay}.ts`(13종) | 미설정(`placeMetaProvider`/`interpolateHfov`) | 무변화 |
| `test/cameraIntrinsics.test.ts`(9곳)·`test/bayGridExtent.test.ts:123` | 리터럴 SIM, 미설정 | 무변화 |

**결론**: 기존 성적표(재현율 0.5854/정밀도 0.8571/매칭IoU 0.88860)를 내는 경로는 한 바이트도 지나지 않는다. `focalPxOf` 6곳도 같은 논리로 무영향(설계서 표 대조 완료, 누락 없음).

### 1-2. `focalPxOf` 6곳

전부 `fovAtZoom` 미설정 provider(placeMetaProvider·실카 인라인 provider)에서 호출되므로 `focalPxAtZoom` 이 신설되기 전과 동일한 값을 반환한다(T1: `fovAtZoom` 미설정 시 `focalPxAtZoom ≡ focalPxOf` 봉인 테스트로 고정).

### 1-3. `web/autoPaint.js` 의 `autoQuadItems` — preset 응답에 왜 무영향인가

`rows` 없는 응답(모든 preset 모드 응답)에서 `autoQuadItems` 는 종전과 완전히 동일한 목록·순서·라벨을 만든다(T13 봉인). `rows` 가 있는 응답(current 모드)에서만 좌표 서명 dedupe **합집합**을 추가한다. `rows` 는 `best` 를 항상 포함하지 않으므로(진입 문턱이 걸러낸 뒤 남는 값, `1:3`·`2:2` 는 라이브 실측 `rows=0행`) — 만약 「rows 를 대체」로 구현했다면 그 두 뷰에서 검출이 화면에서 사라졌을 것이다(`02x` §5-③). 합집합 구현이 이 회귀를 막는다.

또한 `autoPaintViewFor` 의 프레임 키 완전일치 게이트가 현재뷰 응답 키(`"1:current"`)를 preset 키(`"cam:preset"`)로 못 찾는 문제가 설계 문서에 없던 채 발견되어, 같은 카메라면 그리는 폴백이 추가됐다(`02x` §5-②). preset 응답 키 형식은 손대지 않아 이 폴백은 preset 경로에 영향이 없다.

---

## 2. 경계면

### 2-1. MCP 도구 ↔ REST 서비스 ↔ 뷰어

```
web/index.html·app.js  →  POST /rpc {method:"roi.auto.detect", params:{view:"current",...}}  →  roiAuto.ts (REST 서비스)
                                                                                                       │
                                                                                              currentViewResolver → groundModelFromIntrinsics → floorPaint/bayGrid (무변경)
                                                                                                       │
src/tools/roiAutoCurrentView.ts (MCP 도구, 별도 프로세스) ──── 같은 /rpc 호출 ──────────────────────────┘
       │
       └─ 응답의 ptzUsed 로 sceneTruth 를 투영해 채점(도구 쪽에서만 수행)
```

### 2-2. `roi.auto.detect` 의 `view` 파라미터가 `score`/`apply` 에서 명시 거부되는 설계 근거

`view` 를 공통 `BaseSchema` 에 넣으면 `roi.auto.score`·`roi.auto.apply` 도 그 필드를 파싱은 하게 된다. 설계서(`01e`)에는 이 두 메서드의 처리가 없어 **조용히 무시**될 뻔했는데, 이 저장소 규율(조용한 무시 금지)에 따라 구현자가 둘 다 `INVALID_PARAMS` 로 명시 거부하도록 추가했다(`02x` §5-⑥):
- `score`: 수동 정본(23면)은 **프리셋 종속**이라 현재뷰 개념과 안 맞는다.
- `apply`: 정본 쓰기는 **프리셋 단위**로 설계돼 있어 현재뷰가 무엇을 "적용"할지 정의되지 않는다.

이로써 현재뷰 개념이 검출(read) 경로에만 국한되고, 정본을 건드리는 쓰기 경로(score의 채점 기준, apply의 쓰기)로 새어나가지 못하게 막는다.

---

## 3. 어셈블리·의존성

- `packages/lens-calib/**` — **무접촉.** 실카 초점거리/화각 실측표(`cam-001` 상속 포함)는 이번 라운드가 다루는 "옵트인 줌1 기준값" 경로와 분리돼 있다(§1-1의 실카 무변화 근거와 동일 이유).
- `sceneTruth.ts` — **봉인 유지.** `test/roiAutoHoldout.test.ts` 가 `floorPaint`·`bayGeometry`·`bayGrid`·`cameraIntrinsics`·`placeMetaIntrinsics` 의 참조를 문자열로도 막는 구조를 그대로 유지했다. 채점을 서비스(`roiAuto.ts`)가 아니라 별도 도구(`roiAutoCurrentView.ts`)에 둔 이유가 바로 이 경계를 지키기 위해서다(`01e` §3-D):
  1. 검출과 채점이 같은 파일에 있으면 그 경계가 "사람이 지키는 약속"으로 강등된다.
  2. 씬 정답은 `preset.list` 유래 = 시뮬 전용. 서비스 RPC 로 노출하면 실카에서 "왜 안 되냐"가 반복된다.
  3. 도구가 **서비스가 실제로 낸 응답을 채점**하므로, 도구가 구 경로를 몰래 재구현해 서비스와 갈라지는 유형(11회차 U11)이 구조적으로 불가능해진다.
- `src/ground/{sceneTruth,bayGrid,bayGeometry,floorPaint,roiAutoScore,roiAutoRecall,project,autoRoiPlan}.ts` — 설계서가 무접촉 선언했고(`01e` §1), 구현자가 grep 재확인. 20b·20c 진단·위상 라운드에서 `bayGrid.ts` 에 **주석 5줄만**(미배선 수정안 기록) 추가된 것이 유일한 예외 — 동작 변경 없음(§4-3 참조).
- `src/clients/**` — 무접촉. `ICameraClient.getPtz`(`CameraClient.ts:47`)와 `CameraSourceClient.getPtz`(`:68`)가 이미 존재해 새 클라이언트 메서드가 필요 없었다(`01e` §1 근거).
- `data/Place01/PtzCamRoi.json`(정본) · DB · `config/**` — 무접촉. 전 실험 전후 md5 동일(§5-5 in 정본 문서).

---

## 4. 회귀 위험

### preset 모드 응답 바이트 동일성이 무엇으로 보장되는가

- **스키마 레벨**: `view` 필드가 `default('preset')`이고, `view` 미지정 요청(기존 모든 호출자·테스트)은 preset 분기를 그대로 탄다.
- **T7**: `view` 미지정 → `'preset'`. `roi.auto.score` 응답에 `view`·`ptzUsed`·`rows` 키가 **없음**을 유닛테스트로 봉인.
- **T13**: `rows` 없는 뷰(=preset 응답)에서 `autoQuadItems` 가 종전과 동일한 목록을 낸다는 것을 유닛테스트로 봉인.
- **라이브 실측**: 구현자가 `roi.auto.score{camId:1,presetIdx:1,consensus:false}` 를 직접 호출해 응답 키 집합이 종전 17키와 완전 동일함을 확인(`02x` §4).
- **골든 회귀**: `npx tsx src/tools/roiAutoRecall.ts v1 evidence rows` 를 20/20b/20c 세 라운드 전부 실행해 재현율·정밀도·매칭IoU·프레임해시가 **원시 배정도로 전 항목 동일**함을 반복 확인(§5-4 in 정본 문서). 20c 라운드는 위상 수정안을 실제로 배선해 골든이 악화되는 것까지 실측한 뒤 되돌렸고, 되돌린 후 골든이 복원됨을 재확인했다(`02z` §7) — 이는 "무회귀 확인 절차 자체가 검증됐다"는 의미이기도 하다.

### 잔여 위험

- `web/autoPaint.js` 의 프레임 키 폴백(§1-3)은 설계서에 없던 즉흥 수정이라, preset 키 형식이 향후 바뀌면 이 폴백의 "같은 카메라면 그린다" 조건이 의도와 다르게 동작할 가능성이 있다 — 코드 리뷰 시 확인 필요(문서화 시점 기준 **확인 필요** 항목).
- 1 ULP tilt 드리프트(§5-1 in 정본 문서)는 무해하다고 실측됐으나, 이 되쓰기 패턴이 다른 축(pan/zoom)에서도 항상 0 인지는 **소수 표본**(리더 1회 + 20b회차 1회)으로만 확인됐다 — 표본 확대는 다음 라운드 과제.

---

## 5. 미해결 부채

| # | 항목 | 위치 | 상태 |
|---|---|---|---|
| 1 | `bayGrid.ts:508` 조기반환 | `src/ground/bayGrid.ts:508` | `calibrateHeight:false` 단독 실험을 막는 구조적 결합(고정 지상고 + 재적합이 같이 꺼짐). 16-19회차 인계서부터 이월, 20회차도 미착수(리더 결정: 설치고 정책 현행 유지, 코드 0줄) |
| 2 | `roiAutoFuse.ts:337` 동점 규칙 | `src/tools/roiAutoFuse.ts:337` | 20회차 범위 밖, 무접촉 확인만 됨 |
| 3 | 봉인 테스트의 전이 import 검사 | `test/roiAutoHoldout.test.ts` | 현재는 문자열 매칭 기반 봉인. "전수 조회 → 예외 목록 → green → `quadIoU` 리프 추출" 순서의 강화가 16-19회차 인계서 §4 순위5 로 남아 있고 20회차에서도 착수하지 않음 |
| 4 | **위상 선택 결함의 근본 수정** | `bayGrid.ts:393-394` (coverage 산식) | §6 in 정본 문서. 원인 확정 · 수정안 마련됐으나 G3(골든 무손) 탈락으로 미배선. 21회차 착수물(§9 우선순위 3건은 인계서 참조) |
| 5 | `phaseFitWeight = 0` | `bayGrid.ts` 위상 적합 항 가중치 | 현재 완전히 꺼져 있음(4회차 결정 기록 있음). 위상 결함과 직접 관련된 사실이나 이번 라운드는 재평가하지 않음(반증목록 5번과 구분 — §6 참조) |
| 6 | `expectedBays` 필수 파라미터의 UX 부채 | `roiAuto.ts` 파라미터 검증 | 기본값을 둘 수 없다는 것이 실측으로 확정(8이 하필 A 를 붕괴시킴). "화면 보이는 대로 세어 입력"이라는 사용자 부담이 남음 — 다음 라운드에서 UI 가이드 강화 검토 여지 |

---

## 6. 요약 (리더 보고용 3줄)

1. `groundModelFromIntrinsics`/`focalPxOf` 호출자 26곳은 신설 필드가 옵트인이라 전수 무영향이며, `sceneTruth` 채점 로직은 별도 도구(`roiAutoCurrentView.ts`)로 격리되어 서비스-도구 경계가 코드 구조로 강제된다.
2. preset 모드 응답 바이트 동일성은 스키마 기본값·유닛테스트(T7/T13)·라이브 응답 키 대조·골든 3지표 원시 배정도 대조 4중으로 보장되며, 20c 라운드는 이 절차가 실제 회귀(위상 수정안)를 잡아내는 것까지 실측했다.
3. 최대 발견(격자 위상 반칸 어긋남)의 수정안은 골든 정밀도를 0.8571→0.6250 으로 악화시켜(G3 탈락) 배선하지 않았고, `rows` 진입 문턱이 `effectiveScore` 에 종속된 구조가 이 실패의 근본 원인으로 지목되어 21회차 1순위 과제로 남았다.
