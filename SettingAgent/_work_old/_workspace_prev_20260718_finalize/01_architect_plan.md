# 01. 설계자 계획서 — Finalizer 공간배정(slot_setup) 상호배타 1:1 배정 교체

작성: 설계자(architect) · 대상 브랜치: feat/vpd-seg-cuboid
연계 규칙: CLAUDE.md 1(설계) · 2(단순함) · 3(외과적) · 4(목표중심)

---

## 0. 한 줄 요약

`Finalizer.finalize()`의 slot_setup 조립부에서 **주차면 폴리곤마다 `clusters.find()`로 선착순 1개**를 집는 로직(약 209~239줄)을, **프리셋 단위 상호배타 전역-그리디 1:1 배정**으로 교체한다. 배정 산출만 바꾸고 row shape·slotId 규칙·occupyRange 채움 로직·assemble/artifact/globalIndex/센터라이징은 전부 불변.

---

## 1. 조사 결과 — 재사용 vs 신설 결정

### 1.1 `src/setup/plateMatch.ts::matchPlatesToSlots` 정독 결론 → **직접 재사용 불가, 신설(패턴만 차용)**

`matchPlatesToSlots(slots: BuiltSlot[], plates: PlateBox[]): Map<number, NormalizedQuad>` 는 확실히 **전역 그리디 상호배타 1:1 매칭**이다(진단 08 §4-2 근거 주석 존재). 그러나 **의미론·기하가 우리 문제와 다르다**:

| 항목 | plateMatch (기존) | finalize 가 필요한 것 |
|------|-------------------|----------------------|
| 매칭 대상 | **번호판 ↔ 차량 ROI** | **집계 클러스터 ↔ 주차면 폴리곤** |
| 슬롯 형상 | `BuiltSlot.roi` = **축정렬 `NormalizedRect`** | `PlaceRoiSpace.points` = **임의 4점 폴리곤(사선 주차면)** |
| 게이트 | `containsPoint(rect, 판중심)` (점-in-**rect**) | `pointInPolygon(poly, 대표점)` **OR** centroid 거리 게이트 |
| 비용(정렬) | 겹침 면적 내림 → frontAnchor 거리 | 대표점→폴리곤 centroid **거리 오름** |
| 반환 | `Map<positionIdx, quad>` | `Map<공간배열idx, AggregatedSlot>` |

- 사선 주차면 폴리곤을 boundingRect로 눌러 `matchPlatesToSlots`에 넣으면 **폴리곤 형상이 손실**되어 인접 슬롯 경계에서 오배정이 난다(관측된 preset1 사선 배치에 치명적).
- 결정적 이유: `matchPlatesToSlots`는 **detectPipeline.ts:288 / onPlaceFilter.ts:82** 가 **`plate.quad` 참조 동등성 계약**(주석 59줄, 80줄)에 의존한다. 여기에 폴리곤·거리게이트 분기를 끼워 넣으면 **두 공유 사용처가 회귀**한다. 이 함수는 **절대 손대지 않는다.**
- Aggregator.ts:276 의 클러스터-내 번호판 귀속도 별개 관심사(차량 클러스터↔번호판 클러스터)이며 그대로 둔다.

→ **결정: `matchPlatesToSlots`의 "전역-그리디 상호배타 maximal matching" *패턴*만 차용하고, 클러스터↔폴리곤 전용 순수 함수를 신설한다.** 이중구현이 아니라 **다른 기하 도메인**이다(rect+겹침 vs 폴리곤+거리). 신규 함수는 소규모(프리셋당 슬롯≤~10, 클러스터≤~10)라 **그리디-nearest로 결정형 충분**, Hungarian은 과하다(단순함 우선).

### 1.2 재사용하는 것(신규 코드 0)

- `src/domain/polygon.ts::pointInPolygon` (게이트 1차), `::polygonCentroid` (거리 게이트·비용 기준점).
- `src/capture/placeRoi.ts::normalizeGlobalIdx` / `loadNormalizedPlaceRoi` (호출부 불변).
- `src/capture/floorRoi.ts::buildPlateAnchoredQuad` (occupyRange 생성, 불변).
- 대표점(번호판 quad 중심) 산출: 기존 finalize `quadCentroid`(214줄)와 **동일한 4점 산술평균** 규칙 유지.

---

## 2. 신설: `src/capture/spaceAssign.ts` (순수·테스트 가능)

DB·IO 비의존 순수 함수. 프리셋 1개 범위의 배정만 담당.

```
export function assignClustersToSpaces(
  spaces: readonly PlaceRoiSpace[],       // 한 프리셋의 주차면 폴리곤들(배열 순서 = presetSlotIdx-1)
  clusters: readonly AggregatedSlot[],    // 같은 프리셋의 accepted 클러스터들
  opts: { centroidGate: number },         // 거리 게이트(정규화)
): Map<number, AggregatedSlot>            // key = spaces 배열 인덱스(0-based), 미배정 슬롯은 키 없음
```

### 2.1 대표점(reprPoint) 우선순위 — 실측 근거

1. **번호판 quad 중심**(`quadCentroid(cluster.plateQuad)`) — **최우선**. 실측 13/14가 번호판중심으로 매칭됨(바닥 근접).
2. **폴백: 차량 bbox 중심** `{x + w/2, y + h/2}` — 번호판 완전 부재 클러스터만. (실측상 bbox 중심은 폴리곤 위로 떠서 부정확 → 폴백으로만.)

### 2.2 게이트(빈칸 보존의 핵심)

한 (공간, 클러스터) 쌍이 **후보**가 되는 조건:

> `pointInPolygon(space.points, repr)` **OR** `dist(repr, polygonCentroid(space.points)) < centroidGate`

**★ pointInPolygon 단독으로는 관측된 충돌 버그를 못 고친다.** preset1:1 #4 폴리곤에 두 클러스터의 번호판중심이 **둘 다 내부**로 들어온 케이스: 폴리곤-포함만으로는 클러스터2가 #5와 **후보쌍을 못 만들어** 결국 고아·#5 빈칸 잔존. **centroid 거리 게이트가 있어야** 클러스터2가 인접 #5의 centroid 근처라는 이유로 #5와 후보쌍을 형성하고, 아래 비용정렬이 클러스터2→#5로 회수한다. **이 거리 게이트가 본 설계의 핵심 회복 메커니즘이다.**

### 2.3 비용·정렬·배정(전역 그리디 상호배타)

- 각 후보쌍 비용 = `dist²(repr, polygonCentroid(space))` (제곱거리, sqrt 불요).
- 정렬 키(전순서, 결정성 보장): **비용 오름 → clusterId 오름 → 공간배열idx 오름**.
  (clusterId는 프리셋 내 1-based 고유 — Aggregator 부여값. plateMatch의 (pi,si) 최후 폴백과 동형.)
- 그리디: 정렬 순회하며 **공간·클러스터 양쪽 모두 미배정일 때만** 확정(`usedCluster`/`assignedSpace` 셋).
  → maximal matching. 충돌쌍을 남기지 않는다(= 차선 슬롯 폴백).

### 2.4 목표 케이스 충족 검산

- `#clusters < #spaces` → 후보 없는 공간은 map 키 없음 = **빈칸 유지**. ✅
- `#clusters > #spaces` → 초과 클러스터는 값에 없음 = **미배정(고아)**. ✅
- 진짜 고아(주행로 차량): 모든 폴리곤 밖 + 모든 centroid에서 `centroidGate` 초과 → 후보쌍 0 → **미배정**. ✅
- 관측 버그(#4에 2대·#5 빈칸): 클러스터A→#4(내부·근접), 클러스터B는 #5 centroid가 게이트 이내면 (B,#5) 후보 형성 → 비용정렬로 **B→#5 회복**, 손실 0. ✅
- 진짜 적층 충돌(2대가 실제로 #4에 겹침, #5 진짜 빈칸): B의 #5 centroid 거리 > gate → (B,#5) 후보 탈락 → **B 고아·#5 빈칸**(물리적으로 정확). ✅ ← gate 값이 이 판별 경계를 결정.

---

## 3. Finalizer.ts 변경 (외과적 — slot_setup 조립 블록만)

`finalize()` 약 **209~239줄** `for (const [key, spaces] of byPresetPlace) { ... spaces.forEach((sp,i)=>{ const hit = clusters.find(...) }) }` 만 교체:

```
for (const [key, spaces] of byPresetPlace) {
  const [camIdx, presetIdx] = key.split(':').map(Number);
  const clusters = byPresetAcc.get(key) ?? [];
  const assigned = assignClustersToSpaces(spaces, clusters, { centroidGate: <게이트값> });
  spaces.forEach((sp, i) => {
    const hit = assigned.get(i) ?? null;    // find() 대신 사전 배정 조회
    const occupyRange = hit ? buildPlateAnchoredQuad({x:hit.x,y:hit.y,w:hit.w,h:hit.h}, hit.plateQuad ?? undefined) : null;
    rows.push({ ...동일... });               // row shape 100% 불변
  });
}
```

- `import { assignClustersToSpaces } from './spaceAssign.js';` 추가.
- 파일 내 사용 안 하게 되는 `quadCentroid`(32~38줄): **spaceAssign가 대표점 계산을 흡수하면 finalize의 quadCentroid는 고아가 될 수 있음** → CLAUDE.md 3에 따라 **내 변경으로 고아가 된 것만 제거**(다른 곳에서 안 쓰이면 삭제, 쓰이면 유지). developer가 미사용 확인 후 판단.
- `pointInPolygon` import: finalize에서 직접 안 쓰게 되면 동일 기준으로 정리.
- **불변**: presetSlotIdx=`i+1`, slotId=`sp.idx`, slotRoi/vpdBbox/lpdObb/occupyRange/pan/tilt/zoom/centered/img1/updatedAt 채움 규칙, 단일 트랜잭션 `replaceSlotSetup(rows)`, best-effort try/catch 격리, assemble()/globalIndex/artifact 저장/saveStore 전부 손대지 않음.

---

## 4. 튜닝 파라미터 `centroidGate` — config 승격 권장

**관측형 튜닝 파라미터**(리더가 B모드 loop에서 재캡처→finalize→lpd_obb 채워진 슬롯 수 확인하며 조정). 두 안 제시:

- **(권장) config `capture` 섹션 필드 추가** — `CaptureSchema`에 `slotAssignGate: z.number().min(0).max(1).default(0.12)`. 근거: ① 리더가 **빌드 없이** loop에서 조정 가능(관측형 파라미터의 본질), ② `this.deps.cfg`(=`ToolsConfig['capture']`)가 Finalizer에 **이미 주입**되어 배선 비용 최소, ③ `clusterDist`/`clusterMinSupport`와 같은 계열.
- (대안) 모듈 const — Aggregator의 강건통계 const 선례(§3.6 "config 미승격")와 정합하나, loop 튜닝마다 재빌드 필요 → 본 작업 성격(관측 튜닝)에 부적합.

**초기값 0.12 근거**: 정규화 슬롯 centroid 간격 ~0.10~0.15. 게이트를 간격보다 약간 작게(0.12) 두면 **인접 1칸까지는 회수, 2칸 이상 이격은 차단** → 충돌 회복과 진짜 고아 배제의 균형점. 리더가 lpd 수 미달이면 상향(더 공격적 회수), 과배정이면 하향.

→ **결정 요청 없음. config 승격으로 진행**(마스터 자율진행 지침). developer는 schema+default+주석만 추가, 다른 config 소비처 무영향.

---

## 5. 유닛 테스트 목록 (qa-tester)

### 5.1 신규 `test/spaceAssign.test.ts` (순수 함수 단위 — 배정 로직 고정)

1. **충돌 회복(핵심 버그 재현)**: 클러스터 2개가 space#0 폴리곤에 둘 다 내부, space#1은 빈칸이나 클러스터2의 repr가 #1 centroid 게이트 이내 → `#0→클A, #1→클B`, **손실 0**.
2. **상호배타**: 한 클러스터가 두 공간에 중복 배정되지 않음(map 값 유일).
3. **빈칸 보존**: `#clusters(2) < #spaces(4)` → 미배정 공간은 map 키 부재.
4. **고아 미배정**: `#clusters(4) > #spaces(2)` → 초과 클러스터 map 값에 부재.
5. **진짜 고아(주행로)**: 모든 폴리곤 밖 + 전 centroid 거리 > gate → 후보 0 → 미배정.
6. **게이트 경계**: repr가 폴리곤 밖이지만 centroid 거리 = gate−ε → 배정 / gate+ε → 미배정.
7. **대표점 우선순위**: plateQuad 보유 시 판중심으로 폴리곤 내부 판정(차량중심은 밖이어도 배정) / plateQuad 부재 시 차량중심 폴백.
8. **결정성**: 완전 동률 비용 → clusterId·공간idx 순 tie-break로 안정 배정(입력 순서 무관).

### 5.2 `test/finalizerParkingSlots.test.ts` 확장(통합 — 기존 하네스 재사용)

- 기존 harness(`seedFkParents`/`snapshotFromDets`/place ROI 임시파일) 그대로 사용.
- **케이스**: preset1:1 재현(한 폴리곤 근방에 2 클러스터, 인접 폴리곤 빈칸) → `finalize` 후 `store.getSlotSetup()`(SlotSetupView) 조회 시 **두 폴리곤 모두 `lpd`≠null / `vpd`≠null**, `vpd≠null` 슬롯 수 = 게이트 통과 클러스터 수와 일치, 클러스터 손실 0.
- 회귀 확인: 기존 finalize 테스트(occupancy/floor/parkingSlots) 전량 green 유지(row shape·slotId 불변 증명).

---

## 6. 영향도 분석

| 대상 | 영향 | 위험 |
|------|------|------|
| `src/setup/plateMatch.ts` | **무변경** | 없음 — detectPipeline.ts:288·onPlaceFilter.ts:82·SetupOrchestrator 공유 사용처 **회귀 위험 0**(의도적 미접촉이 최대 안전판) |
| `src/capture/Aggregator.ts` | 무변경 | 클러스터-내 번호판 귀속(276줄)은 별 관심사 |
| `src/capture/Finalizer.ts` | slot_setup 조립 블록만 교체 + import 1 | assemble/artifact/globalIndex/센터라이징/saveStore **불변**. best-effort try/catch로 실패 격리 유지 |
| `src/capture/spaceAssign.ts` | **신규** | 기존 의존자 0 |
| `src/config/toolsConfig.ts` | `CaptureSchema` 필드 1개 `+default` | default 존재 → 기존 config·소비처 무영향(하위호환) |
| `src/capture/SqliteStore.ts::replaceSlotSetup` | 무변경 | SlotSetupRow shape 불변 |
| 뷰어(web/core.js)·REST(dbRoutes) | 무변경 | slot_setup 스키마·slotId(1..N) 정본 불변 |

**공유 회귀 최대 리스크**였던 "plateMatch 개조"를 **택하지 않음**으로써 회귀면을 신규 파일 1개로 국소화. SetupOrchestrator 경로는 본 변경과 무접촉.

---

## 7. MCP 도구 vs LLM 두뇌 경계

- 본 배정은 **결정형 기하(그리디 min-cost 상호배타)** — 순수 함수, LLM 미개입. 좌표 불변식(§0-4) 준수: LLM은 중복/라벨/거부 메타만, 좌표 생성·수정 없음.
- `centroidGate`는 리더의 **관측형 loop(B모드)** 튜닝 대상 — 사람/리더 판단 루프이지 런타임 LLM 호출 아님.

---

## 8. 실행 순서(검증 게이트)

1. `spaceAssign.ts` 신설 → 검증: 5.1 유닛 8케이스 green.
2. `toolsConfig.ts` `slotAssignGate` 추가 → 검증: config 로드/기존 테스트 green(default 하위호환).
3. `Finalizer.ts` 조립 블록 교체 + 고아 import/헬퍼 정리 → 검증: 5.2 통합 + 기존 finalize 테스트 전량 green.
4. (리더·B모드) 재캡처→finalize → 검증: lpd_obb 채워진 슬롯 수 ≈ 실주차 16~17, 충돌/고아 손실 소멸. 미달 시 `slotAssignGate` 조정 반복.

---

## 9. 미해결/가정

- **가정 A**: preset1:1 #4의 두 클러스터는 물리적으로 #4·#5 두 슬롯 차량이며, 인접 슬롯 centroid가 게이트(0.12) 이내다. 실데이터에서 게이트 초기값이 회수에 부족하면 리더가 상향(§4 loop). — 이는 관측형이므로 loop에서 확정.
- **가정 B**: `PlaceRoiSpace.points`는 사실상 볼록 4점(대체로). `pointInPolygon`은 ray-casting이라 볼록 전제 불요·순서 무관하나, 극단 비볼록 폴리곤은 centroid 거리 게이트가 보조.
- **미결 없음** — plateMatch 재사용 여부는 조사로 확정(신설), 튜닝 파라미터 위치도 확정(config). 마스터 자율진행 지침에 따라 리더 승인 대기 없이 developer 인계.
