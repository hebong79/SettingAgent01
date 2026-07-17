# 02c. 캡처 다운스트림 구현 (P2 인메모리 누적 / P3 REST·뷰어 / reviewer 배선 제거) — 변경 요약

> 범위: 설계서 §2(CaptureJob 인메모리)·§2.3(Finalizer snapshot)·§3(REST 재편·뷰어)·§6.5(reviewer 배선 제거) + P2-4(PtzCalibrator) + P2-5(slot_id 정합).
> devA(SqliteStore/types/migrate)·devB(dbRoutes/LLM config/adviseCentering) 파일은 **무접촉**. devA 신 계약(`replaceSlotSetup`/`getSlotSetup`/`upsertSlotCentering`/`SlotSetupRow`/`SlotCenteringRow`)에 다운스트림을 맞춰 재배선.

---

## 1. 성공기준 결과

- **`cd SettingAgent && npx tsc --noEmit` → src(`src/**`) 에러 0** (착수 시 41 → 0).
- **테스트(`test/**`) 에러 472는 미해소** — 구 테이블·구 메서드·구 시그니처를 검증하던 27개 테스트가 신 계약과 광범위 불일치. 리더 지시("테스트 대량 재작성은 qa 담당, 광범위 재작성은 목록화")에 따라 **qa 재작성 대상으로 목록화**(§6). 이 다운스트림 소스 변경이 시그니처(finalize/occupancyReview)까지 바꿔 착수 시 379 → 472로 증가(예상된 파괴).

---

## 2. 수정 파일 (소스)

| 파일 | 조치 |
|---|---|
| `src/capture/CaptureJob.ts` | 인메모리 누적 전환(§2.2). run_id/DB 중간기록 전량 제거. reviewer 3종 중 Checkpoint/Floor 배선 제거, Occupancy 만 인메모리 축소. snapshot/조회 게터 추가. |
| `src/capture/Finalizer.ts` | `finalize(snapshot)` 입력(§2.3). `replaceSlotSetup(SlotSetupRow[])` 로 교체. artifact_snapshot/getCheckpoints/getFloorRois/getLatestOccupancy/preset PTZ 조회 제거. |
| `src/capture/OccupancyReviewer.ts` | `insertOccupancy`(DB) → 인메모리 `occByPreset.set`. 시그니처 변경(runId 제거, occByPreset 주입). store 의존 제거. |
| `src/capture/CheckpointReviewer.ts` | 캡처 배선 분리(§6.5). 삭제된 `updateAggregatedStatus`/`insertCheckpoint` 호출 → 인메모리 status 직접 반영. `clusterRef`/`advisoryLines` 공유 유틸 잔존(파일 유지). |
| `src/capture/FloorRoiReviewer.ts` | 캡처 배선 분리(§6.5). 삭제된 `upsertFloorRoi` 호출 제거(폴리곤 미영속 — floor 는 Finalizer 결정형 담당). |
| `src/index.ts` | reviewer 3종 배선 정리(Checkpoint/Floor 주입 제거, Occupancy 는 `{brain}`). CaptureJob 에서 `store`/`reviewer`/`floorReviewer` 주입 제거. Finalizer `camera` 주입 제거. |
| `src/calibrate/PtzCalibrator.ts` | `upsertCenteringSlots`→`upsertSlotCentering`. `CenteringSlotRow`(문자열 slotId+pos JSON) → `SlotCenteringRow`(정수 slot_id + 분해 pan/tilt/zoom). |
| `src/api/captureRoutes.ts` | REST 재편(§3): `/capture/runs*` 4종 → `/capture/aggregate`·`/capture/occupancy`·`/capture/slots`. finalize 바디 runId 제거·snapshot finalize. |
| `src/setup/GlobalIndexer.ts` | slot_id 단일화 컨벤션 문서화(§2-5) — buildGlobalIndex 규칙이 normalizeGlobalIdx 와 동일 컨벤션임을 명시(코드 거동 불변, §5 참조). |
| `web/app.js` | fetchOccupancy/loadParkingSlots/renderOccupancyAnalysis 신 경로. runId 게이팅 제거. |
| `web/core.js` | buildFlatSlotRows: `slotIdx→slotId`, occupied 는 slot_setup 의 vpd 유무로 파생. |

---

## 3. snapshot 계약 (CaptureJob → Finalizer)

신규 `export interface CaptureSnapshot`(`CaptureJob.ts`):
```ts
{ dets: DetectionRow[];
  presetRounds: Map<string, number>;     // 프리셋별 관측 라운드 수(occupancyRate 분모)
  aggregated: AggregatedSlot[];          // 마지막 체크포인트 집계(status 보존 병합용)
  occByPreset: Map<string, OccupancyJudgment>; } // 축소 occupancy(LLM off → 빈 맵)
```
- CaptureJob 필드 누적: `dets`(push)·`roundsByPreset`(Set)·`aggregated`(체크포인트마다 `aggregate()`)·`occByPreset`(OccupancyReviewer 기록)·`obsSeq`/`runSeq`(인메모리 카운터). `start()` 에서 전부 clear.
- 게터: `getSnapshot()`(finalize 입력)·`getAggregated()`(REST)·`getOccupancy()`(REST rows shape)·`getRunId()`(인메모리 seq).
- `run_id`·`createRun/endRun/updateRunProgress/insertObservation/insertDetections` 전량 DB 무접촉. `runId` 는 `++runSeq`(로그·status 표시용).
- Aggregator 시그니처 **불변**(배열+맵). observation 원본(pan/tilt/zoom/imgName) 미보유(finalize 불필요).

---

## 4. REST 신 경로 (설계서 §3)

| 구 경로 | 신 경로 | 소스 |
|---|---|---|
| `GET /capture/runs` | **삭제** | (status 단일화) |
| `GET /capture/runs/:id/aggregate` | `GET /capture/aggregate` | `job.getAggregated()` (AggregatedSlot[] 동일) |
| `GET /capture/runs/:id/occupancy` | `GET /capture/occupancy` | `job.getOccupancy()` (rows shape `{camIdx,presetIdx,occupiedCount,total,rate,spacesJson}` 유지, LLM off → []) |
| `GET /capture/runs/:id/slots` | `GET /capture/slots` | `store.getSlotSetup()` (SlotSetupView: presetKey 파생·slotId·roi/vpd/lpd) |
| `POST /capture/finalize`(body.runId) | `POST /capture/finalize`(runId 제거) | `finalizer.finalize(job.getSnapshot(), {logicOccupancy})` |

`/capture/status` runId 필드는 인메모리 seq 로 유지(뷰어 무영향).

### slot_setup 행 조립(Finalizer)
`slotId=sp.idx`(normalizeGlobalIdx 정수 전역), `presetSlotIdx=배열순 1-based`, `slotRoi/vpdBbox/lpdObb=JSON`, `occupyRange=buildPlateAnchoredQuad(hit)` (점유 시), `pan/tilt/zoom=null·centered=0`(센터라이징은 이후 PtzCalibrator.upsertSlotCentering 채움). **단일 트랜잭션 교체**(실패 롤백 — 이전 확정본 보존).

---

## 5. 뷰어 변경 (§3.3)

- `fetchOccupancy()` 인자 제거 → `GET /capture/occupancy`. LLM off 빈배열 → `occupancy.js` 결정형 폴백(기존).
- `loadParkingSlots()` → `GET /capture/slots`. `r.presetKey` 유지(응답 파생).
- `renderOccupancyAnalysis()` → `/capture/runs` 폴백 삭제, `/capture/occupancy` 직접.
- `buildFlatSlotRows`(core.js): `r.slotIdx→r.slotId`, `occupied = !!db.vpd`(slot_setup 은 점유상태 미저장 → 배정 차량 bbox 유무로 표시). DB↔파일 전역번호 불일치 시 통째 기각 폴백 로직 유지.
- `buildDbTableModel`(core.js): sqlite_master 화이트리스트 기반 → 신 6테이블 자동 반영(로직 무변경).
- `state.lastRunId`: 게이팅 역할 제거(fetch 무조건). 필드/할당은 잔존(vestigial — 회귀 회피 위해 미삭제, §7).

### P2-5 slot_id 단일화 (판단 · 리더 확인 요망)
`slot_setup.slot_id`(Finalizer, `normalizeGlobalIdx` sp.idx)와 `setup_artifact.globalIndex.globalIdx`(`buildGlobalIndex`)는 **둘 다 cam→preset→프리셋내순서** 컨벤션이라 이미 정합한다. buildGlobalIndex 의 프리셋내 순서는 `orderByPosition`(상→하·좌→우 공간순), normalizeGlobalIdx 는 `parking_spaces 배열순`. **양자 일치의 전제 = PtzCamRoi.json 의 parking_spaces 가 공간 순서로 저장(통상 페인팅 순서)**. 두 넘버링은 각각 검출 클러스터/파일 공간이라는 **독립 소스**를 라벨링하므로, 정렬키 변경만으로 완전 보장은 불가 — 컨벤션을 동일하게 문서화·고정하고 전제를 명시하는 것이 결정형 상한이다. buildGlobalIndex 거동은 불변(이미 해당 컨벤션). **파일 배열순이 공간순과 어긋나는 데이터가 실재하면 별도 정렬 정규화가 필요** — 리더 경험적 검증(P3) 권장.

---

## 6. 남은 테스트 재작성 범위 (qa 담당 — 472 에러, 27파일)

**(A) 삭제 테이블·구 스토어 전용 — 전면 재작성 또는 폐기 대상:**
`sqliteStore.test.ts`(94)·`parkingSlotsStore.test.ts`(41)·`occupancyStore.test.ts`(25)·`floorRoiStore.test.ts`(17)·`centeringSlot.test.ts`(21)·`floorRoiStoreCompat.test.ts`(6) — 구 10테이블/구 메서드(createRun/insertObservation/replaceParkingSlots/upsertCenteringSlots/upsertFloorRoi/insertOccupancy 등) 검증. 신 6테이블 계약으로 재작성 필요(devA `SqliteStore` 표면 기준).

**(B) 시그니처 변경 추종 — 부분 수정:**
`captureJob.test.ts`(35)·`captureJobCuboid.test.ts`(12)·`captureJobOnPlace.test.ts`(7)·`captureCheckpointTrigger.test.ts`(4)·`captureJobOccupancyGate.test.ts`(1)·`captureLiveRefresh.test.ts`(1) — CaptureJob deps 에서 `store`/`reviewer`/`floorReviewer` 제거, 인메모리 게터(getSnapshot/getAggregated/getOccupancy) 기반 어서션으로 전환.
`finalizerParkingSlots.test.ts`(47)·`checkpointFinalizer.test.ts`(42)·`finalizerOccupancy.test.ts`(13)·`finalizerFloor.test.ts`(12) — `finalize(runId)`→`finalize(snapshot)`, `replaceSlotSetup`/`getSlotSetup` 어서션.
`occupancyReviewer.test.ts`(26)·`floorRoiReviewer.test.ts`(26)·`floorRoiUseLlmWiring.test.ts`(8) — 신 review 시그니처(occByPreset 주입, floor/checkpoint 미배선).
`captureRoutes.test.ts`(12)·`parkingSlotsRoutes.test.ts`(7) — 신 경로(/capture/aggregate·occupancy·slots) + store 모킹.

**(C) 단발(1~5) — 공유 헬퍼/타입 파급 추정:**
`estimatePlateNeighborsIntegration.test.ts`(5)·`floorRoiNormalizeEdge.test.ts`(5)·`vehicleCuboidRoutes.test.ts`·`placeRoiRoutes.test.ts`·`jobCuboidRoutes.test.ts`·`groundModelRoutes.test.ts`·`assocQaFindings.test.ts`(각 1) — 공용 store/deps 픽스처가 구 메서드를 참조할 가능성. 픽스처 정리 시 일괄 해소 예상.

---

## 7. 미완 · 차단 · 리더 확인 요망

1. **FK 부모 선행성**: `replaceSlotSetup` 은 `slot_setup.(cam_id,preset_id) → preset_pos` FK(foreign_keys=ON) 를 건다. finalize 전에 **`preset_pos`(및 camera_info/place_info)가 채워져 있어야** INSERT 성공 — 미충족 시 트랜잭션 롤백(→ 격리 warn, artifact 는 저장됨, slot_setup 미반영). 순서: **P1 마이그레이션(devA `migrateToSettingDb`) 실행 후 finalize**. 리더 P3 경험적 검증 시 확인 필요.
2. **테스트 472 에러**: §6 대로 qa 재작성 대상. "전체 tsc 0" 은 qa 테스트 패스 후 달성. **src 는 0**.
3. **P2-5 정합 전제**: §5 — parking_spaces 배열순=공간순 전제. 데이터 위반 시 정렬 정규화 추가 필요(리더 판단).
4. **잔존 死배선**: CheckpointReviewer/FloorRoiReviewer 클래스는 미배선 상태로 잔존(리더 확정 "삭제 말고 배선만"). `clusterRef`/`advisoryLines` 는 계속 사용. 완전 삭제 원하면 지시 요망.
5. **vestigial `state.lastRunId`**(app.js): 게이팅 제거했으나 필드/할당 잔존(회귀 회피). 완전 상수화 원하면 별도 지시.
