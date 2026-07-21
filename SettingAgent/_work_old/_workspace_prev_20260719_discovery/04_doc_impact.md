# 04 · 영향도 분석 — 슬롯 앞면중심 번호판 탐색·크롭줌·역계산

> 작성: 문서화(documenter) · 근거: 설계서/구현노트/QA리포트 + 실제 소스 라인 대조(직접 Read/Grep)
> 최종 문서: [../docs/20260719_163729_번호판탐색_줌반복_역계산_구현.md](../docs/20260719_163729_번호판탐색_줌반복_역계산_구현.md)

---

## 1. 변경 파일 목록(가산 vs 수정)

### 신규(가산만, 라인수 근거로 실존 확인)
| 파일 | 내용 |
|---|---|
| `src/calibrate/cropZoom.ts`(68줄) | `computeCropWindow`/`toCropPoint`/`backmapQuad`(순수) + `cropAndUpscale`(sharp IO). |
| `src/calibrate/plateDiscovery.ts`(145줄) | `PlateDiscovery.discoverSlot` 상태전이 루프(camera/lpd/crop DI). |
| `src/calibrate/plateDiscoveryWriter.ts`(35줄) | `expandDiscoveryTargets`(slot3dFrontCenter 보유분 펼침) + `writePlateDiscovery`. |
| `src/calibrate/PlateDiscoveryJob.ts`(205줄) | 잡 상태머신 + `saveSlotLpd`(→`upsertSlotLpd`). |
| `src/api/discoverRoutes.ts`(59줄) | `/discover/ptz|status|frame|result` 4개 라우트. |
| `test/cropZoom.test.ts`, `test/plateDiscovery.test.ts`, `test/discoverRoutes.test.ts` | 신규 테스트 3파일(+37건). |

### 수정(가산·외과적, 확인한 실제 diff 지점)
| 파일 | 변경 지점 | 성격 |
|---|---|---|
| `src/calibrate/types.ts` | import 확장(`NormalizedPoint`,`NormalizedQuad`) + 신규 타입 6종(`DiscoveryTarget`/`PlateDiscoveryItem`/`PlateDiscoveryArtifact`/`DiscoverState`/`DiscoverStatus`, 파일 53~104행). 기존 `PlateTarget`/`Ptz`/`SlotPtzItem`/`SlotPtzArtifact`/`CalibrateState`/`CalibrateStatus`는 라인 그대로(1~52, 106~119) 불변. | 가산 |
| `src/capture/types.ts` | 신규 `SlotLpdRow`(161~163행 부근: `slotId`/`lpdObb`/`updatedAt`). 기존 `SlotSetupRow`/`SlotSetupView`(`lpdObb: string\|null`, 107행 등) 불변. | 가산 |
| `src/capture/SqliteStore.ts` | 신규 `upsertSlotLpd(rows)`(297~303행): `UPDATE slot_setup SET lpd_obb=?, updated_at=? WHERE slot_id=?`, 트랜잭션. `replaceSlotSetup`(198행)·`upsertSlotCentering`(274행)·`clearSlotSetupEnrichment`(306행) 등 기존 메서드는 손대지 않음(라인 위치로 확인). | 가산 |
| `src/api/server.ts` | `ApiDeps`에 `plateDiscovery?: PlateDiscoveryJob`(91행), `discoverOutFile?: string`(93행) 옵셔널 필드 추가 + 271~272행에 조건부 `registerDiscoverRoutes` 등록(`deps.plateDiscovery && deps.discoverOutFile`일 때만). 기존 `discovery`(프리셋 자동탐색 설정) 필드와 이름 충돌 회피 위해 `plateDiscovery`로 명명 — 실제 소스에 두 필드가 공존함을 확인. | 가산 |
| `src/index.ts` | `PlateDiscoveryJob` import(20행), `discoverOutFile='data/plate_discovery.json'`(90행), `plateDiscovery = new PlateDiscoveryJob(...)`(91행), `buildServer`에 두 값 전달(104행). 기존 `captureJob`/`finalizer`/`calibrator`/`pipeline` 조립 라인은 미변경. | 가산 |

**결론**: 위 5개 수정 파일 모두 "기존 라인 삭제/변경 없이 신규 라인만 추가" 패턴이며, 실제 grep으로 신규 심볼(`plateDiscovery`, `upsertSlotLpd`, `PlateDiscoveryItem` 등)의 등장 위치가 파일 후반부·별도 블록에 국한됨을 확인했다.

---

## 2. 기존 기능과의 독립성(회귀 0 근거)

- **기존 파이프라인 자동 연쇄에 미포함**: `index.ts:88` 주석 및 91행 조립 코드 확인 결과, `PlateDiscoveryJob`은 `captureJob`/`Finalizer`/`PtzCalibrator`/`pipeline`과 배선상 연결되지 않은 **독립 인스턴스**다. 수집(`CaptureJob`)·최종화(`Finalizer`)·센터라이징(`PtzCalibrator`)·원버튼 파이프라인(`SetupOrchestrator`) 어느 것도 이번 신규 코드를 import하지 않는다(역방향 의존 없음, `PlateDiscoveryJob.ts`만 `detectPipeline.ts`의 `resolvePresetPtz`를 재사용하는 순방향 의존).
- **REST 등록이 조건부·가산적**: `server.ts:271`의 `if (deps.plateDiscovery && deps.discoverOutFile)` 가드로 인해, 두 값을 주입하지 않는 기존 테스트(`calibrateRoutes.test.ts` 등)·기존 서버 조립 경로는 `/discover/*` 라우트 자체가 등록되지 않는다 — QA가 "미주입 시 `/discover/status` 404, `/health` 정상"으로 이 대칭을 실측 확인(discoverRoutes.test.ts).
- **DB 쓰기 경로가 유일한 접점**: 기존 기능과 실제로 상태를 공유하는 지점은 오직 `slot_setup.lpd_obb` 컬럼 하나이며, 그마저 부분 UPDATE(§3)라 타 기능이 쓰는 타 컬럼과 충돌하지 않는다.
- **QA 실측**: 작업 전 165파일/1840테스트 → 작업 후 168파일/1882테스트(+42, 기존 1840 그대로 유지) — `npx vitest run` 전량 통과로 회귀 0을 직접 확인(`_workspace/03_qa_report.md`).

---

## 3. `slot_setup.lpd` 소비처 — 이 기능이 무엇을 바꾸는가

`slot_setup.lpd_obb`(정규화 LPD OBB quad)를 실제로 읽는 지점 3곳을 소스에서 확인했다:

### 3-1. `src/calibrate/slotPtzWriter.ts:20` — `expandPlateTargetsFromSlotSetup`
```ts
if (v.lpd == null) continue;   // ← lpd 없는 슬롯은 센터라이징 대상에서 누락
```
센터라이징(PtzCalibrator) 잡은 이 함수가 펼친 목록만 처리한다. 즉 **원본 프레임에서 LPD가 검출되지 않은 슬롯은 지금까지 센터라이징 자체가 시도되지 않았다**(과업 A2로 기록된 문제).

이번 기능은 `slot_setup.lpd`를 부분 UPDATE로 채우므로(§4의 `PlateDiscoveryJob.saveSlotLpd`), **discovery 잡을 먼저 돌리면 이전에는 `lpd==null`이라 누락되던 슬롯이 센터라이징 대상 목록에 새로 포함된다.** discovery는 센터라이징의 **상류(upstream) 별개 잡**으로 위치하며(데이터는 discovery→센터라이징 단방향, 역방향 없음 — 순환 없음), 센터라이징 로직 자체는 한 줄도 수정되지 않았다.

### 3-2. `web/app.js:898` — `drawDbVpd`류 DB 폴백 오버레이
```js
for (const row of rows) { if (row.lpd) drawPlateQuad(ctx, row.lpd, false); } // DB 번호판 OBB quad(노랑, 라이브 없을 때만).
```
`#roi-db` 체크(라이브 검출 없을 때) 시 DB 정본 LPD를 노랑 quad로 렌더링. discovery가 `lpd_obb`를 채운 슬롯은 이 오버레이에 **새로 나타난다** — 이전엔 미검출이라 표시가 없던 슬롯에 박스가 보이게 되는 것이 사용자가 관찰 가능한 직접 효과.

### 3-3. `web/core.js:641` (`buildFlatSlotRows`) → `web/app.js:969` — 슬롯 목록 LPD 태그
```js
lpd: !!db?.lpd,                                  // core.js:641
const tags = [r.vpd ? 'VPD' : null, r.lpd ? 'LPD' : null] ...  // app.js:969
```
슬롯 목록에 `LPD` 태그가 `lpd` 존재 여부로 붙는다. discovery가 채운 슬롯은 목록에서 `LPD` 태그가 새로 붙는다.

### 3-4. 점유(occupancy) 판정 — **영향 없음 확인**
`web/occupancy.js`를 grep한 결과 `lpd` 참조가 전혀 없다(`area`/`polygonArea`/`convexIntersectionArea`/`groundBand` 등은 전부 `vpd`/사각형 좌표 연산). 즉 **점유 판정 로직(`occupancyJudge`)은 `lpd_obb`를 입력으로 쓰지 않으며, 이번 변경이 점유 표시(`점유`/`공차`) 자체를 바꾸지는 않는다.** 목록의 `LPD` 태그는 점유 뱃지와 별개의 "번호판 확보 여부" 표시일 뿐이다. 이 점은 원 작업지시서가 "occupancy" 소비처로 명시했으나, 실제 코드 확인 결과 occupancy 로직과는 무관함을 정정해 기록한다(추측 금지 원칙).

### 3-5. `expandDiscoveryTargets`(신규) — 센터링 대상과의 대비
`plateDiscoveryWriter.ts:18` `if (v.slot3dFrontCenter == null) continue;` — discovery 자신의 대상 펼침은 **검출과 무관**(앞면중심은 지면모델 기하 산출이라 항상 대상). 이 대비(discovery=기하 기준 펼침 vs 센터링=검출 기준 펼침)가 §3-1의 A2 해소 논리의 근거다.

---

## 4. DB 스키마·기존 데이터 shape 불변성

- `slot_setup` 테이블 컬럼 추가 없음. 기존 `lpd_obb` TEXT 컬럼을 그대로 재사용(정규화 OBB JSON, `stringify5` 직렬화 — 사용자 메모리 노트 "[[settingagent-persist-5decimals]]" 규약 그대로 준수: `PlateDiscoveryJob.ts:196`에서 `stringify5(item.lpdOrig)`).
- `SqliteStore.upsertSlotLpd`(SqliteStore.ts:297-303)는 `UPDATE ... WHERE slot_id=?` 단일 문 트랜잭션 — **DELETE 없음**. 이는 사용자 메모리 노트 "[[finalize-slotsetup-wipe-fragility]]"(검출 없는 `replaceSlotSetup`이 데이터를 파괴할 수 있다는 기록)가 지적한 패턴과 정확히 반대로 설계·구현되었으며, 기존 `upsertSlotCentering`(SqliteStore.ts:274, 동일 부분 UPDATE 계약)과 일관된 스타일이다. QA가 sqliteStore.test.ts 가산 5건에서 "대상 슬롯의 lpd_obb/updated_at만 갱신, vpd/occupy/pan/tilt/zoom/centered/img1/slot_roi/front_center 전부 불변, 타 슬롯 행수 보존"을 실측 확인했다.
- 미존재 `slot_id`에 대한 UPDATE는 영향 행 0으로 조용히 종료(throw 없음) — best-effort 원칙(잡 완료를 막지 않음).

---

## 5. 남은 한계(추측 금지 — 확인 필요 항목 포함)

1. **광학 PTZ tier(Phase 3) 미구현** — `G_i`(줌 상태 지면모델) 유도 방식 미확정. `PlateDiscoveryItem.reason`에 `'needs_optical'`은 타입 정의(types.ts:83)에만 존재하고 실제 부여 경로 없음.
2. **실 LPD/카메라 미가동** — 라이브 검지율(몇 %가 실제로 구제되는지)은 이번 검증 범위에서 관찰되지 않았다. vitest+리더 sharp 합성 파리티로 기하·역계산·상태전이·REST는 커버했으나, 실 서비스 연동 시의 검출 성패는 **확인 필요** 항목으로 남긴다.
3. **후면주차·번호판 세로 오프셋·차종별 높이 편차** — 앞면중심 조준 전제의 구조적 한계, 이번 범위 밖(리포트만, §6 문서 참조).
4. **상수(`frac0`/`shrink`/`minFrac`/`maxSteps`/`matchRadiusNorm`) 눈대중 초기값** — 라이브 튜닝 필요. QA가 관찰한 "step5 frac(0.05184)이 minFrac(0.05) 바로 위" 경계 근접은 결함이 아니나, `maxSteps`와 `minFrac`을 독립적으로 튜닝하면 서로 영향을 준다는 점은 후속 조정 시 유의해야 한다.
5. **`@parkagent/types`(공유 도메인 타입) 영향** — 이번 변경분(`PlateDiscoveryItem` 등)은 전부 `SettingAgent/src/calibrate/types.ts`(로컬 타입, `@parkagent/types` 미승격, 파일 2행 주석 "SettingAgent 초기 셋팅 산출물 — @parkagent/types 승격 안 함" 확인)에 위치한다. 즉 **ActionAgent/DMAgent 등 타 에이전트로의 전파는 없다** — 확인 필요 항목 아님, 소스 주석으로 명확히 확정된 사실.
