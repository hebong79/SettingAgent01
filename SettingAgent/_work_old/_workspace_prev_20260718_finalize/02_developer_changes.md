# 02. 구현자 변경요약 — Finalizer 공간배정 상호배타 1:1 배정 교체

작성: 구현자(developer) · 대상 브랜치: feat/vpd-seg-cuboid
입력: `_workspace/01_architect_plan.md` · 연계 규칙: CLAUDE.md 2(단순함)·3(외과적)·4(목표중심)

---

## 0. 한 줄 요약

Finalizer 의 slot_setup 조립부에서 주차면마다 `clusters.find()` 로 선착순 1개를 집던 로직을, 프리셋 단위 **전역-그리디 상호배타 1:1 배정**(신규 순수함수 `assignClustersToSpaces`) 호출로 교체했다. row shape·slotId 규칙·occupyRange·assemble/artifact/globalIndex/센터라이징은 전부 불변. `tsc --noEmit` green, 기존 finalizer 테스트 38개 green.

---

## 1. 파일별 변경 요지

### 1.1 신규 `src/capture/spaceAssign.ts` (순수 함수, DB·IO 비의존)

설계서 §2 시그니처 그대로 구현.

```ts
export function assignClustersToSpaces(
  spaces: readonly PlaceRoiSpace[],
  clusters: readonly AggregatedSlot[],
  opts: { centroidGate: number },
): Map<number, AggregatedSlot>   // key = spaces 배열 인덱스(0-based), 미배정 공간은 키 없음
```

핵심 로직(설계서 §2.1~2.3 충실 구현):
- **대표점**(`reprPoint`): `plateQuad` 있으면 quad 4점 산술평균 중심(우선), 없으면 차량 bbox 중심 `{x+w/2, y+h/2}`(폴백).
- **후보쌍 조건**: `pointInPolygon(space.points, repr)` **OR** 대표점↔`polygonCentroid(space)` 거리 < centroidGate.
  - sqrt 회피 위해 제곱거리 vs `gate² (= centroidGate*centroidGate)` 로 비교.
- **비용** = 대표점↔폴리곤 centroid 제곱거리.
- **정렬**(결정형 전순서) = 비용↑ → clusterId↑ → 공간배열idx↑.
- **그리디** = 정렬 순회 중 공간·클러스터 양쪽 모두 미배정일 때만 확정(`usedSpace`/`usedCluster` Set) → maximal matching.
- 재사용: `pointInPolygon`·`polygonCentroid`(`src/domain/polygon.ts`), 타입 `PlaceRoiSpace`(`placeRoi.ts`)·`AggregatedSlot`(`types.ts`)·`NormalizedPoint`(`domain/types.ts`).
- **신규 코드만 추가, 기존 파일 로직 무변경.** `plateMatch.ts` 무접촉(설계서 §1.1 결정 준수).

### 1.2 `src/capture/Finalizer.ts` (외과적 — 배정 블록만 교체)

- **import 교체**: `import { pointInPolygon } from '../domain/polygon.js';` 제거 → `import { assignClustersToSpaces } from './spaceAssign.js';` 추가.
- **고아 정리**(CLAUDE.md 3, 내 변경으로 고아화된 것만): 파일 로컬 헬퍼 `quadCentroid`(구 32~38줄) 삭제, `NormalizedPoint` 타입 import 삭제(둘 다 교체된 블록에서만 쓰였음 — grep 으로 잔여 사용 0 확인). `NormalizedQuad`/`NormalizedRect` 는 `assemble()` 에서 여전히 사용 → 유지.
- **배정 블록 교체**(구 209~239 → 현재):
  ```ts
  const clusters = byPresetAcc.get(key) ?? [];
  const assigned = assignClustersToSpaces(spaces, clusters, { centroidGate: this.deps.cfg.slotAssignGate });
  spaces.forEach((sp, i) => {
    const hit = assigned.get(i) ?? null;   // 선착순 find() → 사전 배정 조회
    const occupyRange = hit ? buildPlateAnchoredQuad(...) : null;
    rows.push({ ...100% 동일... });
  });
  ```
- **불변**: `presetSlotIdx=i+1`, `slotId=sp.idx`, `slotRoi`/`vpdBbox`/`lpdObb`/`occupyRange`(`buildPlateAnchoredQuad`)/`pan`/`tilt`/`zoom`/`centered`/`img1`/`updatedAt` 채움 규칙, 단일 트랜잭션 `replaceSlotSetup(rows)`, best-effort try/catch 격리, `assemble()`/`buildGlobalIndex`/`saveArtifact`/`saveStore` 전부 손대지 않음.

### 1.3 `src/config/toolsConfig.ts` (필드 1개 + default)

- `CaptureSchema` 에 `slotAssignGate: z.number().min(0).max(1).default(0.12)` 추가(한글 주석 포함, `clusterDist`/`minConfidence` 계열 위치).
- `DEFAULT_TOOLS_CONFIG.capture` 에 `slotAssignGate: 0.12` 추가.
- default 존재 → 기존 config·소비처 하위호환(파일에 필드 없어도 병합 시 채워짐).

### 1.4 `config/tools.config.json` (관측형 튜닝값 노출)

- `capture` 섹션에 `"slotAssignGate": 0.12` 추가. 근거: 리더가 B모드 loop 에서 **빌드 없이** 조정 가능해야 한다는 설계서 §4 취지.

---

## 2. slotAssignGate 배선 경로

```
config/tools.config.json (capture.slotAssignGate: 0.12)
  └─ loadToolsConfig() 섹션병합 → ToolsConfigSchema.parse (default 0.12 폴백)
      └─ ToolsConfig['capture'] → FinalizerDeps.cfg (기존 주입, 신규 배선 0)
          └─ Finalizer.finalize(): this.deps.cfg.slotAssignGate
              └─ assignClustersToSpaces(spaces, clusters, { centroidGate: <값> })
```

- `FinalizerDeps.cfg` 는 이미 `ToolsConfig['capture']` 로 주입돼 있어 **배선 신규 코드 0**(설계서 §4 권장안).

---

## 3. tsc 결과

`cd SettingAgent && npx tsc --noEmit` → **에러 0(green)**.

중간에 발생했던 유일한 컴파일 이슈: `slotAssignGate` 를 required 필드로 추가하면서 **테스트 20개 파일의 `captureCfg` 리터럴**(`ToolsConfig['capture']` 타입 명시)이 `TS2741 Property 'slotAssignGate' is missing` 로 깨짐. 이는 시그니처(설정 타입) 변경에 따른 컴파일 정합 문제 → 지침이 허용한 **최소 컴파일 수정**으로 처리(§4 참조). 로직 변경 없음.

---

## 4. QA 인계 포인트

### 4.1 신규 유닛테스트 (미작성 — qa 담당)
- 설계서 §5.1 `test/spaceAssign.test.ts` 8케이스(충돌 회복/상호배타/빈칸 보존/고아 미배정/진짜 고아/게이트 경계/대표점 우선순위/결정성) **미작성**. 순수함수 `assignClustersToSpaces` 직접 호출로 작성 요망.
- 설계서 §5.2 `finalizerParkingSlots.test.ts` 충돌회복 통합 케이스(한 폴리곤 근방 2 클러스터 + 인접 빈칸 → 두 폴리곤 모두 배정, 손실 0) 확장 요망.

### 4.2 기존 테스트에 가한 컴파일 정합 수정(로직 재작성 아님)
- **20개 테스트 파일**의 `captureCfg` 리터럴에 `slotAssignGate: 0.12` 삽입(단일 sed, `minConfidence: 0.5, moveBeforeCapture` → `minConfidence: 0.5, slotAssignGate: 0.12, moveBeforeCapture`). 대상:
  `assocQaFindings, boundaryCrossCheck, captureCheckpointTrigger, captureJob, captureJobCuboid, captureJobOccupancyGate, captureJobOnPlace, captureLiveRefresh, captureRoutes, checkpointFinalizer, estimatePlateNeighborsIntegration, finalizerFloor, finalizerOccupancy, finalizerParkingSlots, floorRoiUseLlmWiring, groundModelRoutes, jobCuboidRoutes, parkingSlotsRoutes, placeRoiRoutes, vehicleCuboidRoutes`.
- 값 `0.12` = default 와 동일 → 기존 배정 동작이 게이트로 인해 바뀌지 않도록 중립 유지. **테스트 어서션·시나리오는 무변경.**

### 4.3 회귀 확인(구현자 사전 실행)
- `npx vitest run test/finalizerParkingSlots.test.ts test/finalizerFloor.test.ts test/finalizerOccupancy.test.ts test/checkpointFinalizer.test.ts` → **38 tests passed**. row shape·slotId·occupyRange 불변 증명(단일 클러스터 케이스에서 배정 결과 동일).
- 전체 스위트는 qa 가 실행 확인.

### 4.4 관측형 튜닝(리더 B모드)
- `slotAssignGate` 현재 0.18(아래 §5 재설계 반영). 재캡처→finalize 후 lpd_obb 채워진 슬롯 수 미달이면 상향, 과배정이면 하향(설계서 §4·§8-4).

---

## 5. B모드 루프 재설계 — 그리디 → 최대 카디널리티 이분매칭(Kuhn)

리더 라이브 검증(이번 run, 17클러스터 전부 accepted)에서 **"비용↑ 정렬 후 선착 그리디"가 max-cardinality 가 아님**을 확정. 값싼 엣지를 먼저 소비해 회수 가능한 클러스터를 막는 cascade 발생:
- gate 0.12: **greedy 15 vs 최대매칭 16** (preset1:2 클러스터 하나가 폴리곤 내부·centroid거리 0.072인데도 슬롯을 더 가까운 클러스터에 뺏겨 미배정).
- gate 0.18: **greedy 15 vs 최대매칭 17** (preset1:3 가장자리 클러스터 0.172도 정당 회수 — 원근 오프셋).

### 5.1 `src/capture/spaceAssign.ts` — 알고리즘 본체만 교체
- **교체 전**: 후보쌍 전체를 (비용↑→clusterId↑→spaceIdx↑) 정렬 후 순회하며 양쪽 미배정일 때만 확정(그리디 maximal, 최대 아님).
- **교체 후**: **Kuhn 증가경로**(max-cardinality bipartite matching).
  - 각 클러스터의 인접(유효) 슬롯 리스트를 **비용 오름(동률 spaceIdx 오름)** 으로 정렬 → 저비용 엣지 우선 매칭(비용선호).
  - 클러스터를 **clusterId 오름차순**으로 방문하며 `tryKuhn(u, seen)` 증가경로 탐색, `matchOfSpace[]` 역포인터. → 결정성(매 실행 동일 결과).
  - N≤7 소규모라 O(V·E) 충분(Hungarian 불요).
- **불변**: 시그니처·반환 타입(`Map<spaceIdx, AggregatedSlot>`)·유효 후보쌍 조건(`pointInPolygon(space, repr) OR 제곱거리 < gate²`)·대표점(번호판 quad centroid 우선, 차량 bbox 중심 폴백)·plateMatch 무접촉.

### 5.2 gate 기본값 0.12 → 0.18 (세 곳)
- `toolsConfig.ts` `CaptureSchema.slotAssignGate` default, `DEFAULT_TOOLS_CONFIG.capture`, `config/tools.config.json` capture 섹션.
- 근거: 최대매칭+상호배타가 과배정을 억제하므로, 원근 오프셋 큰 프리셋의 정당 슬롯(실측 0.172)까지 포함하도록 상향.
- 테스트 20개 리터럴의 `slotAssignGate: 0.12` 는 유지(단일 클러스터 케이스는 gate 무관 · 컴파일 정합 중립값).

### 5.3 tsc / 회귀
- `npx tsc --noEmit` → 에러 0(green).
- finalizer 4개 스위트 38 tests 재확인 green(단일 클러스터 배정 결과 그리디=최대매칭 동일).

### 5.4 기대 결과(리더 라이브 재검증)
- gate 0.18 + 최대매칭 → 이 씬 17클러스터 → slot_setup lpd **17/17**.

### 5.5 QA 인계(추가 — 필수)
- `test/spaceAssign.test.ts` 에 **cascade 회수 케이스** 반드시 포함: 클러스터가 폴리곤 내부(또는 gate 이내)인데도 **선착 그리디였다면 미배정**되는 배치(값싼 엣지를 다른 클러스터가 선점 → 증가경로로 회수)를 구성해, 최대매칭이 그리디보다 **+1 이상 카디널리티** 달성함을 어서션. 결정성(입력 순서 뒤섞어도 동일 배정)·비용선호(동일 카디널리티 해가 여럿이면 저비용 엣지 선택) 케이스도 추가.
