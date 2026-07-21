# QA 검증 리포트 — LPD discovery 앵커 하향(A) + 2D 격자 크롭 탐색(B)

- 검증: qa-tester (Opus) / 2026-07-19
- 대상: `01_architect_plan.md` §6-1 V-1~V-9 / 구현 `02_developer_changes.md`
- 외부 서비스(LPD/카메라)는 전부 DI 스텁 모킹 — 실 서비스 호출 0(설계 §5 준수).

> **개정(2026-07-19, 격자 20→30):** Fable 재설계로 `GRID_OFFSETS` 가 6방(중심/하/하좌/하우/**좌/우**)으로,
> `level=floor((k-1)/6)+1`, `maxSteps 30`(5줌×6방)으로 변경(구현 `plateDiscovery.ts`만, tsc exit 0). 기존 (0,1.0)'더아래'
> 오프셋 제거로 **1920×1080 중앙앵커의 클램프 중복창이 사라져 LPD 30회 전부 고유**가 됨. V-3/V-4/V-6/V-9 갱신,
> V-1/V-2/V-5/V-7/V-8 은 격자 칸수 무관으로 무수정 통과 확인. 아래 §V-1~V-9 표는 30-격자 기준 최종 결과.
>
> **증분(2026-07-19, 배타성 게이트 §9):** `05_live_finding.md` 옆판 절도(위장 found 6/6) 대응. `pickOwnedPlate`
> (Voronoi 소유권) + `discoverSlot(t, ptz?, peerAnchors=[])` + 양 tier 게이트 교체(`plateDiscovery.ts`),
> `PlateDiscoveryJob.run` 프리셋별 peer 그룹핑·전달(`PlateDiscoveryJob.ts`). 검증 V-10~V-14 추가(§9-7). 아래 §V-10~V-14 표 참조.

## 총평

**전 항목 통과. 회귀 0.** 신규/수정 vitest 로 V-1~V-9(격자 개선) + V-10~V-14(배타성 게이트 §9)를 모두 봉인했다.
단, (1) V-8 항등 주장(§2-1)은 **선형투영 영역에서만 엄밀**하고 실 틸트 모델에선 sub-pixel 근사임을 실측·정량 봉인했고(이슈 1),
(2) §9 배타성으로 라이브 found 수치가 **정직하게 하락**할 수 있음(위장 교정 — 회귀 아님, 이슈 3)을 명시한다.

| 지표 | 값 |
|---|---|
| 전체 테스트 파일 | 172(핸드오프) → **174** (+2: `plateDiscoveryWriter.test.ts`, `plateDiscoveryJob.test.ts` 신규) |
| 전체 테스트 수 | 1934(핸드오프) → **1984** (+50, 순증만 / 회귀 0) |
| 타깃 4파일(cropZoom 48/plateDiscovery 18/plateDiscoveryWriter 10/plateDiscoveryJob 1) | **77 테스트 전부 통과** |
| `npx tsc --noEmit` | **exit 0** |

> §9 배타성 증분분: `plateDiscovery.test.ts` 11→**18**(+7: V-10×5·V-11·V-12), `plateDiscoveryJob.test.ts` **신규 1**(V-13). V-14(옵셔널 3번째 인자 하위호환)는 기존 discoverSlot/시임 테스트 **무수정 전수 통과**로 봉인.

## 항목별 결과 (V-1 ~ V-9)

| ID | 파일 | 결과 | 봉인 내용 |
|---|---|---|---|
| **V-1** | cropZoom.test.ts | ✅ | `gridCenter`: off(0,0)→앵커 그대로 / dy=0.5→y가 `min(1,frac·aspect)`·0.5 증가 / dx=-0.5→x 감소 / `frac·aspect>1`·`frac>1` 시 `min(1,·)=1` 클램프 반영 |
| **V-2** | cropZoom.test.ts | ✅ | 오프셋·클램프 창 왕복 파리티: 중앙/모서리(0.95,0.9) 앵커 × frac{0.4,0.24} × 5오프셋 × 3 quad → `backmapQuad∘toCropPoint==id` 오차 < 1e-9 |
| **V-3** | plateDiscovery.test.ts | ✅ | 정사각 프레임(aspect 1)에서 k=1..**6** 창 중심 = 6방 GRID_OFFSETS 순서(중심→하→하좌→하우→**좌→우**), frac 축소 시점이 k=**7**(level2 진입, 0.4→0.24)로 이동 |
| **V-4** | plateDiscovery.test.ts | ✅ | 전 스텝 미검출 시 crop 호출 ≤ **30**(정사각 중앙앵커는 중복 없어 정확히 30), 결과 `step=30, reason:'no_plate', lpdOrig=null` |
| **V-5** | plateDiscovery.test.ts | ✅ | k=2(하) 오프셋 창에만 번호판 → `found:true, step:2`, `cropWindow==W2`, `lpdOrig==backmapQuad(pick, W2)` (k=2 오프셋 6방서 불변 → 무수정 통과) |
| **V-6** | plateDiscovery.test.ts | ✅ | 모서리 앵커(0.98,0.98) → 클램프 동일창 반복 → LPD 실호출 **10회(<30)**, `step=30` 유지(seen-skip 예산 절약) |
| **V-7** | plateDiscoveryWriter.test.ts | ✅ | `lowerFrontAnchor`: 결과 y가 frontCenter(위)보다 아래·앞 edge 중점(아래)보다 위, `t=0.4/0.75≈0.5333` 보간 수치 일치(0.72). 코너 회전 불변, roi 길이≠4/비유한 → frontCenter 폴백 (격자 무관, 무수정) |
| **V-8** | plateDiscoveryWriter.test.ts | ✅(단서 有) | project.ts 실헬퍼(projectToPixel/projectPointAtHeight/projectCuboidPixels/frontFaceCenterPx)로 합성. **선형투영 영역(n_z=0)에서 항등 < 1e-9 봉인**. 틸트 모델(25°)에선 편차 ≈1.4e-3(sub-pixel)로 정량 봉인 (격자 무관, 무수정) |
| **V-9** | plateDiscovery.test.ts | ✅ | maxSteps 기본 5→**30** 반영: 기존 "crop 5회" 테스트를 6방·30 격자 세맨틱으로 갱신(1920×1080 중앙앵커는 **클램프 중복 소멸 → LPD 30회, step=30**). Tier0/no_anchor/전파 규약·`windowAt` 헬퍼(level/6·6방)를 갱신, 기존 통과 유지 |

## 항목별 결과 (V-10 ~ V-14 · 배타성 게이트 §9)

| ID | 파일 | 결과 | 봉인 내용 |
|---|---|---|---|
| **V-10** | plateDiscovery.test.ts | ✅ | `pickOwnedPlate` 순수(원본 정규화 좌표): (a) 이웃 앵커 최근접 후보 → null 기각 / (b) 자기소유 후보 채택 / (c) 자기소유 다수 → self 최근접 1개(먼 고conf 배제) / (d) **동률(dSelf==dPeer) → 기각**(엄격 `<`) / (e) `peers=[]` → 무조건 통과(최근접) |
| **V-11** | plateDiscovery.test.ts | ✅ | **절도 재현 회귀**(05_live_finding slot8): Tier0 에 이웃 판만(self 앵커 matchRadius 0.15 이내지만 peer 0.12 로 더 가까움) → `pickOwnedPlate` **full 기각 → 격자 진입**(crop ≥1회) → k=1 크롭서 자기판 소유 채택 → `found, tier:'crop', step:1`, backmap 정확. **예전 full/step0 위장 found 차단 확인** |
| **V-12** | plateDiscovery.test.ts | ✅ | 크롭 창에 자기판(conf 0.5)+이웃판(conf 0.99) 공존 → 크롭중심 **원본좌표 아핀 환산(W.xy+c·W.wh) 후 소유권 판정** → 자기판 채택(고conf 이웃판 아님), `confidence:0.5`, `lpdOrig==backmapQuad(self, W1)` |
| **V-13** | plateDiscoveryJob.test.ts | ✅ | `run` 프리셋별 peer 그룹핑: 2프리셋 혼합(1:1 슬롯1,2 / 1:2 슬롯3) → discoverSlot 스텁 기록 검증. 슬롯1 peers=[슬롯2 앵커], 슬롯2 peers=[슬롯1 앵커], 슬롯3 peers=[](단독). **자기 앵커 미포함·타 프리셋 미혼입** 확인 |
| **V-14** | 기존 전체 | ✅ | `discoverSlot` 3번째 인자 옵셔널(`peerAnchors=[]`) 추가 → `PlateDiscoveryApi=Pick<…,'discoverSlot'>` 시임 자동 추종, 기존 plateDiscovery 상태전이·Tier0·no_anchor·2후보 최근접·discoverRoutes 잡 테스트 **무수정 전수 통과**(회귀 0) |

## 발견 이슈

### 이슈 1 (설계 정확성 — 경미, advisory): §2-1 "항등" 주장은 선형투영 영역 한정

- 설계 §2-1은 정규화-보간안(①)이 지면모델 재투영안(②)과 **"근사가 아니라 항등"**이라 주장한다. 근거는 "픽셀 좌표가 h에 대해 선형".
- **검증 결과: `projectPointAtHeight` 는 원근분모(카메라좌표 법선 z성분 `n_z≠0`) 때문에 h에 엄밀히 선형이 아니다.** project.ts 실수식으로 확인:
  - `n_z=0`(광축 지면 평행) → 편차 2.2e-16(기계 오차) = **엄밀 항등**.
  - 틸트 25° → 정규화 편차 **≈1.4e-3**(1080px 기준 ≈1.5px), 틸트 10° → ≈6.3e-4.
- 즉 실 하향틸트 카메라에서 `lowerFrontAnchor`(선형보간)와 참-원근 재투영은 **sub-pixel 만큼 어긋난다**. 구현 결함은 아니다(함수는 선형보간을 정확히 수행) — **설계 주장의 정밀도 표현이 과했다**.
- 실무 영향 **무시 가능**: 편차가 sub-pixel이고, `PLATE_H=0.4`(0.3~0.5 눈대중) 자체의 거칠기가 이보다 훨씬 크다. discovery 앵커는 LPD 최근접 게이트/크롭 중심 용도라 sub-pixel 오차는 검지율에 영향 없음.
- 조치: V-8 테스트에 (a) 선형영역 항등 <1e-9, (b) 틸트영역 편차 `0 < dev < 3e-3` 두 케이스로 **근사 한계를 정직하게 봉인**하고 테스트 주석에 명시. 설계서 §2-1 문구는 documenter가 "선형투영 영역에서 항등, 틸트에서 sub-pixel 근사"로 보정 기록 권고.

### 이슈 2 (없음): 경계면 shape 불일치 0

- `PlateDiscoveryItem.step` 의미 확장(1..30 격자 인덱스)은 스키마 무변경, 소비자(`plate_discovery.json` 감사) 파급 없음(설계 §7 확인).
- `expandDiscoveryTargets`→`discoverSlot` 경계: `anchor` 계약(단일 점) 불변. roi 부재 슬롯은 frontCenter 폴백으로 기존 앵커 유지(회귀 0) — `test/plateDiscoveryWriter.test.ts` 및 기존 `discoverRoutes.test.ts`(roi:[]) 동시 통과로 교차 확인.
- **소유권 비교 좌표계**: 양 tier 모두 후보 center 를 **원본 프레임 정규화**로 통일(crop tier 는 `W.xy+c·W.wh` 아핀 환산). V-12 가 이 환산 경로를 실제로 통과시켜 crop 좌표 직접비교(w/h 비등방 왜곡) 미발생을 봉인.

### 이슈 3 (예고 — 회귀 아님, 문서화 대상): found 수치의 정직한 하락

- 설계 §9-8·§9-0 대로, 미검지 슬롯이 이웃 판을 훔쳐 만든 **위장 found(라이브 6/6)가 사라지므로** 라이브 재실행 시 found 가 정직하게 하락(예 3/6)할 수 있다. 이는 **회귀가 아니라 위장의 교정**이다.
- 유닛 레벨에서 이 교정을 V-11 이 직접 봉인(예전 full/step0 위장 → 현재 격자 진입 후 자기판 검출 또는 정직 no_plate). 라이브 6/6→정직화 및 "bbox 중심 6개 상이(중복 점유 0)" 실측은 §6-2/§9-7 리더 경험 검증 단계 담당(범위 밖).
- documenter 명기 필요: found 하락은 §9 의도된 교정(위장 제거)이며 성공기준은 "중복 점유 0"이지 "found 수치 유지"가 아님.

## 실행 로그 요약

```
# 타깃 클린 직렬(4파일 — Job 포함)
npx vitest run test/plateDiscovery.test.ts test/plateDiscoveryJob.test.ts test/plateDiscoveryWriter.test.ts test/cropZoom.test.ts --no-file-parallelism
→ 4 files / 77 tests passed

# 전체 회귀
npx vitest run --no-file-parallelism
→ 174 files / 1984 tests passed (0 failed)

# 타입체크
npx tsc --noEmit → exit 0
```

## 후속(리더 경험적 검증 §6-2)은 범위 밖

- 시뮬 6슬롯 검지율(목표 6/6) 실측·sharp 오버레이 대조는 goal/loop 리더 단계 담당. 본 QA는 유닛(모킹) 봉인까지.
- 실 LPD/카메라 스모크 테스트: **미수행(외부 서비스 미가동)** — 삭제·통과위장 아님, 명시적 누락.
