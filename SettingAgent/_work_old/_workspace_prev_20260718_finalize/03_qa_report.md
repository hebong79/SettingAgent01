# 03. 검증자 리포트 — Finalizer 공간배정(그리디→최대매칭 Kuhn + centroid 게이트)

작성: 검증자(qa-tester) · 대상 브랜치: feat/vpd-seg-cuboid
입력: `_workspace/01_architect_plan.md` · `_workspace/02_developer_changes.md` + 변경 소스
연계 규칙: CLAUDE.md 2(유닛테스트 필수) · 3(동작 확인)

---

## 0. 결론(한 줄)

신설 `assignClustersToSpaces`(Kuhn 최대 이분매칭 + centroid 거리 게이트)와 Finalizer 배정블록 교체를
**신규 유닛 12케이스 + 통합 2케이스로 검증 완료**. cascade 회수(그리디 대비 카디널리티 +1)를 직접 재현·단언했고,
row shape·slotId·presetSlotIdx·occupyRange 경계면 불변을 확인. **전체 154파일 1721테스트 green, `tsc --noEmit` green,
회귀 0.**

---

## 1. 전체 vitest 결과 (있는 그대로)

| 시점 | 명령 | 결과 |
|------|------|------|
| 베이스라인(검증 전) | `npx vitest run` | **153 files / 1707 tests passed** |
| 신설 유닛 단독 | `npx vitest run test/spaceAssign.test.ts` | **12 passed** |
| 통합 확장 단독 | `npx vitest run test/finalizerParkingSlots.test.ts` | **10 passed**(기존 8 + 신규 2) |
| 최종 전체 | `npx vitest run` | **154 files / 1721 tests passed** |
| 타입체크 | `npx tsc --noEmit` | **exit 0(에러 0)** |

- 증가분: 파일 +1(spaceAssign.test.ts), 테스트 +14(유닛 12 + 통합 2). **기존 1707 전량 유지 = 회귀 0.**
- 실패로 남은 테스트 **없음**. developer 재실행 루프(SendMessage) 불필요.

### 검증 중 발견·자체수정한 테스트 이슈(구현 버그 아님)
- 최초 (e) 게이트 경계 케이스를 **제곱거리 = gate² 정확 동률**(gate 0.2, 거리 0.2)로 작성 → 실패.
  원인: IEEE754 부동소수 노이즈(`0.2*0.2 = 0.04000000000000001` vs `(0.7-0.5)² = 0.03999999999999998`)로
  knife-edge 동률이 관측 불가·의미 없음. **구현의 엄격 부등호(`cost < gate²`)는 정상**.
  → 케이스를 양측 여유 마진(gate 0.24 밖 / 0.26 안, 거리 0.25)으로 재작성해 게이트 안/밖을 안정 검증. 통과.

---

## 2. 신설/수정 테스트 목록

### 2.1 신설 `test/spaceAssign.test.ts` — 순수함수 단위(12 케이스)
설계서 §5.1 + developer §5.5(cascade 필수) 전 항목 커버.

| 케이스 | 내용 | 단언 |
|--------|------|------|
| **(a) cascade 회수** | Sα(경쟁)·Sβ(A전용) 배치. A(id1)=Sα(최저 0.0064)·Sβ, B(id2)=Sα(0.0144)만 도달 | 최대매칭 size=2, `{0→B, 1→A}`(A가 최저비용 Sα 아닌 Sβ로 밀리고 Sα를 B가 회수) |
| **(a) 그리디 대조** | 로컬 재현 `naiveGreedy`(비용↑정렬 선착)로 동일 입력 실행 | 그리디 size=1, 최대매칭 size = 그리디 **+1** |
| (b) 상호배타 1:1 | 완전연결 2×2 | 값(clusterId) 유일·키 유일, `{0→1,1→2}` |
| (c) 빈칸 보존 | #clusters 2 < #spaces 4 | size=2, 초과 슬롯 키 부재(`has(2)/has(3)=false`) |
| (d) 고아 미배정 | #clusters 4 > #spaces 2 | size=2, id3·id4 값에 부재 |
| (d) 진짜 고아(주행로) | 전 폴리곤 밖 + 전 centroid 거리 > gate | size=0 |
| (e) 게이트 밖 | 거리² 0.0625 > gate²(0.24→0.0576) | size=0 |
| (e) 게이트 안 | 거리² 0.0625 < gate²(0.26→0.0676) | size=1 |
| (f) 대표점: plateQuad 우선 | bbox중심(0.9,0.9) 밖 + plateQuad centroid(0.5,0.5) 내부 | 번호판 중심으로 배정 size=1 |
| (f) 대표점: bbox 폴백 | plateQuad 부재 + bbox중심(0.9,0.9) 밖 | size=0 |
| (g) 결정성: 반복 | 동일 입력 2회 | 동일 Map |
| (g) 결정성: 순서무관 | clusters 배열 정·역순 | 동일 Map(`{0→1,1→2}`) — clusterId 방문순 보장 |

### 2.2 `test/finalizerParkingSlots.test.ts` 확장 — 통합(신규 2 케이스)
기존 하네스(`seedFkParents`/`snapshotFromDets`/임시 PtzCamRoi 파일) 재사용. `makeFinalizerGate(store,file,gate)` 헬퍼 추가.

| 케이스 | 내용 | 단언 |
|--------|------|------|
| gate 0.18 cascade 회수 | 프리셋1:1에 2 클러스터(center 0.30·0.40) + 폴리곤 A(몰림)/B(인접 빈칸) | 두 슬롯 모두 `vpd≠null AND lpd≠null`, `vpd≠null` 슬롯 수=2(**손실 0**), 두 vpd.x 상이(상호배타) |
| gate 0.12 대조 | 동일 입력, 게이트만 축소 | C2가 폴리곤 B centroid 게이트 밖 → 두 클러스터 A만 경쟁 → `vpd≠null` 슬롯=1(**손실 1**) — 게이트가 회수 경계임을 실증 |

- 통합 로그로 `accepted:2, slots:2` 확인(2 클러스터 정상 집계). gate 0.18에서 두 폴리곤 모두 채움, 0.12에서 한 폴리곤만 채움.

### 2.3 기존 테스트 회귀
- finalizerParkingSlots 기존 8케이스(파일ROI 배정/프리셋분리/best-effort skip/저장실패 격리/전역번호 1..N/멱등) **전량 green** — 단일 클러스터 케이스에서 최대매칭 결과가 기존 `find()`와 동일함을 증명(row shape·slotId 불변).
- 나머지 전 스위트(centering·config·floor·occupancy·cuboid·routes 등) green.

---

## 3. 경계면(shape) 교차 비교 결과

### 3.1 `assignClustersToSpaces` 반환 ↔ Finalizer 소비
- **반환**: `Map<number, AggregatedSlot>`, key = `spaces` 배열 인덱스(0-based), 미배정 공간 키 없음.
- **소비**(Finalizer.ts:205-206): `spaces.forEach((sp, i) => { const hit = assigned.get(i) ?? null; ... })`.
  → 소비측 `i`(forEach 인덱스) = 반환 Map key(spaces 배열 0-based). **인덱스 기준 일치 확인.** off-by-one/1-based 혼선 없음.
- 미배정 시 `?? null` 폴백 → 이전 `clusters.find() → undefined` 경로와 동일 의미(occupyRange/vpd/lpd null).

### 3.2 slot_setup row shape 불변 (git working-tree diff 실측)
`git diff src/capture/Finalizer.ts` = **4 insertions / 15 deletions**, 변경은 배정 로직에 국한:
- 추가: `import assignClustersToSpaces`, 주석 1, `const assigned = assignClustersToSpaces(...)`, `const hit = assigned.get(i) ?? null`.
- 삭제: `import pointInPolygon`, `NormalizedPoint` 타입 import, 파일 로컬 `quadCentroid` 헬퍼(고아), 구 `clusters.find(...)` 블록.
- **불변(diff에 미포함)**: `slotId: sp.idx`, `presetSlotIdx: i + 1`, `slotRoi/vpdBbox/lpdObb/occupyRange/pan/tilt/zoom/centered/img1/updatedAt` 채움 규칙, `buildPlateAnchoredQuad` 호출, 단일 트랜잭션 `replaceSlotSetup(rows)`, best-effort try/catch. → **row 조립 100% 불변** 확인.

### 3.3 config 배선
- `CaptureSchema.slotAssignGate = z.number().min(0).max(1).default(0.18)`, `DEFAULT_TOOLS_CONFIG.capture.slotAssignGate = 0.18`, `config/tools.config.json` capture.slotAssignGate = 0.18 — **세 곳 모두 0.18 일치** 확인.
- `this.deps.cfg.slotAssignGate` → `assignClustersToSpaces(..., { centroidGate })` 전달. 기존 `FinalizerDeps.cfg` 주입 재사용(신규 배선 0).
- default 존재 → 기존 config·소비처 하위호환(config.test.ts 등 green).

---

## 4. 리더 라이브 검증 인용(관찰형 — vitest 범위 밖, 참고)

리더 B모드 loop 실측(이번 run, 검출 17클러스터 전량 accepted):
- **gate 0.18 + 최대매칭**: finalize → slot_setup **vpd=17 / lpd=17 / occ=17**(전 프리셋 7·6·4 완전배정, **손실 0**), 이후 센터라이징 17/17로 pan/tilt/zoom·centered 채움.
- 대조: **그리디@0.12는 15~16**(cascade 미달) — greedy 15 vs 최대매칭 16(preset1:2 폴리곤내부·거리0.072 클러스터), gate 0.18 상향 시 최대매칭 17(preset1:3 가장자리 0.172 정당 회수).

→ 본 리포트의 유닛 (a) cascade(+1)·통합 gate 0.18/0.12 대조가 이 라이브 관찰을 결정형 재현으로 고정.

---

## 5. 한계·누락(위장·삭제 없이 명시)

- **외부 서비스 스모크 없음**: 본 변경은 순수 기하(LLM·REST 미개입)라 VPD/LPD/LPR/VLA/Unity 모킹 불요. 해당 경계면 없음.
- **라이브 finalize 재현은 vitest 밖**: §4 17/17 결과는 리더 관찰(B모드 loop) 소관 — 검증자는 결정형 유닛·통합·경계면 담당. 유닛 통합 케이스는 라이브 배치를 축약 재현한 것(실좌표 아님).
- **게이트 knife-edge 동률**: 부동소수 특성상 `cost == gate²` 정확 동률은 관측·검증 대상 아님(측도 0). 엄격 부등호는 양측 마진으로 검증(§1 자체수정 참조).
- **pointInPolygon 비볼록**: 극단 비볼록 폴리곤은 ray-casting + centroid 게이트 보조 전제(설계서 §9 가정 B). 테스트는 볼록 사각 폴리곤으로 구성.

---

## 6. 산출물

- 신설: `test/spaceAssign.test.ts`(12 케이스)
- 확장: `test/finalizerParkingSlots.test.ts`(+2 케이스, `makeFinalizerGate` 헬퍼)
- 검증 대상(구현자 산출, 무변경): `src/capture/spaceAssign.ts`, `src/capture/Finalizer.ts`, `src/config/toolsConfig.ts`, `config/tools.config.json`
