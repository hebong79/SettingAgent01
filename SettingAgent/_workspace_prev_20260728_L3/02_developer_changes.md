# 02 구현 변경 — L3: 주차면 1개 드로잉 → 전 프리셋 바닥 ROI 자동 생성

작성: 2026-07-27 / 구현자(developer) / 입력: `00_leader_context.md`(우선) + `01_architect_plan.md`

---

## 0. 먼저 읽을 3줄 (검증자·문서화·리더)

1. **핵심 목표는 성립하되 범위가 다르다.** 실데이터 실측 결과 **"주차면 1개 → 카메라의 *모든* 주차열"은 원리적으로 불가능**하다.
   성립하는 명제는 **"주차면 1개 → *그 주차열* 전 슬롯 · 그 열이 보이는 전 프리셋"**. 근거는 §2. 설계 계획서 §7 Loop 3-1 이
   지시한 "단일 격자 가정 붕괴 시 즉시 보고" 조건에 **해당**한다.
2. 코어·라우트·웹 UI 전부 구현했다. `npx tsc --noEmit` **0에러**, `npx vitest run` **248파일 / 2936테스트 전부 green**(회귀 0).
   신규 테스트 29건(격자 12 · 부트스트랩 8 · 프레임 5 · 라우트 9 중 일부 중복 집계 제외).
3. **미검증 1건**: 웹 UI 는 문법·정적 봉인·라우트 계약까지만 확인했고 **브라우저 실렌더(sharp 스샷 육안)는 못 했다**
   (Unity 라이브 프레임 필요). 위장하지 않고 §7 에 명시한다.

---

## 1. 변경 파일

### 신규 (7)
| 파일 | 줄수 | 내용 |
|---|---|---|
| `src/ground/groundFrame.ts` | 90 | 프리셋 불변 지면 2D 좌표계 — **이번 작업의 유일한 신규 수학**(D-2) |
| `src/ground/groundGrid.ts` | 340 | `GroundGrid`, `canonicalizeQuad`, `gridToPixelQuads`, `fitGridFromQuads` |
| `src/ground/groundBootstrap.ts` | 160 | `CameraGroundConstants`, `bootstrapCameraConstants`, `buildAutoGroundModel`, `ptzNormal` |
| `src/ground/autoRoiPlan.ts` | 300 | 순수 계획기(부트스트랩→격자→전 프리셋 미리보기→IoU 매칭→적용 spaces 조립) |
| `src/ground/gridStore.ts` | 85 | `ground_grid.json` 읽기/쓰기(`stringify5`), `upsertCameraGrids` |
| `src/api/groundGridRoutes.ts` | 200 | 3개 라우트(bootstrap/GET/apply) |
| 테스트 4종 | — | `test/groundFrame.test.ts` / `groundGrid.test.ts` / `groundBootstrap.test.ts` / `groundGridRoutes.test.ts` |

### 수정 (7 — 전부 가산·소폭)
| 파일 | 변경 |
|---|---|
| `src/config/toolsConfig.ts` | `store.groundGridFile` 추가(default `'Place01/ground_grid.json'`) + DEFAULTS 동기화. 하위호환 有 |
| `src/api/server.ts` | `groundGridFile` dep + `registerGroundGridRoutes` 등록(3중 게이트) + import 1줄 |
| `src/index.ts` | `groundGridFile: join(dataDir, store.groundGridFile)` 1줄 |
| `web/index.html` | `#roi-auto` 토글 + `지면 격자(자동 바닥 ROI)` 패널 |
| `web/app.js` | `state.autoRoi`, `drawAutoRoi(ctx)`(가산 레이어), 패널 핸들러 5개, 리스너 4개 |
| `web/app.css` | `.gg-help` 셀렉터 1개(`.an-manual-help` 와 동일 스타일, 클래스만 분리 — 사유 §5) |
| `test/viewerPtzSyncCoverage.test.ts` | 신규 라우트 2개를 `NO_MOVE` 표에 분류(이 테스트의 **설계된 강제 지점**) |

### 변경 0줄 (D-2 목표 **전부 달성**)
`groundModel.ts` · `project.ts` · `types.ts` · `floorRoi.ts` · `Finalizer.ts` · `SqliteStore.ts` · `roiDbLoad.ts` · `web/core.js`
→ **DB 쓰기 신규 코드 0줄, `replaceSlotSetup` 호출자 증가 0** (D-1 달성).

---

## 2. ★★ 설계 전제 붕괴 보고 — 단일 격자로 카메라를 덮을 수 없다

계획서 §7 Loop 3-1 은 *"preset3 의 스팬 축 뒤집힘이 (row,col) 인덱스로 흡수되는지 확인. 흡수 안 되면 즉시 리더에 보고"*
라고 지시했다. **흡수되지 않는다.** 실데이터(`data/Place01/PtzCamRoi.json`)를 프리셋 불변 프레임에 올린 실측:

| 프리셋 | 열 중심 a | 셀 스팬 (a축 × b축) | 슬롯 반복 축 |
|---|---|---|---|
| cam1 preset1 | 26.276 | 5.0 × 2.5 m | b (피치 2.5) |
| cam1 preset2 | 10.686 | 5.0 × 2.5 m | b (피치 2.5) |
| cam1 preset3 | −0.014 | **2.5 × 5.0 m** ← 방위 90° 뒤집힘 | b (피치 5.0) |

- **주차열이 3개**이고 preset3 은 다른 열이며 **90° 회전**돼 있다.
- preset1↔preset2 의 행 간격은 **15.59m** 로 `rowPitch` 5.0m 의 **3.118배 — 정수배가 아니다**(주차통로).
- ⇒ 균일 격자 하나로 세 열을 덮을 수 없다. **격자 = 주차열(strip) 1개**이고 카메라는 격자를 여러 개 가진다.

**한 면으로 다른 주차열을 알아낼 방법은 원리적으로 없다**(그 열의 위상·방위에 대한 정보가 입력에 0). 이건 구현 한계가
아니라 정보 한계다. 따라서 채택한 명제:

> ✅ **주차면 1개 → 그 주차열 전 슬롯, 그리고 그 열이 보이는 전 프리셋**
> ❌ 주차면 1개 → 카메라의 모든 주차열 (열마다 1면씩 필요)

**교차 프리셋 이식은 실증됐다**(가치 보존): cam1 preset2 의 프레임 안에 preset1 의 슬롯 #4·#5·#6 이 실제로 들어온다
(투영 확인). 즉 한 열이 여러 프리셋에 걸치면 그 프리셋들에 자동 생성된다.

**코드 반영**: `gridStore.StoredCameraGrids.grids` 를 **배열**로 뒀다(설계서는 단수 `grid`). 이 사실은
`groundGrid.ts` 상단 주석 ★★, `web/index.html` 패널 안내문, 이 문서에 3중으로 명시했다.

---

## 3. 리더 결정 준수 대조

| 결정 | 준수 | 근거 |
|---|---|---|
| **D-1** 격자→PtzCamRoi.json→slot_setup, DB 직접쓰기 0 | ✅ | `groundGridRoutes.apply` 가 `applyPlaceRoiUpdate` 재사용. `SqliteStore`/`Finalizer` 변경 0줄. 테스트 `groundGridRoutes.test.ts` 가 파일 diff 국한 확인 |
| **D-2** 신규 수학 1건, 지정 7파일 변경 0줄 | ✅ | `groundFrame.ts` 90줄만 신규 수학. 7파일 전부 무변경(git diff 로 확인 가능) |
| **D-3** 홀드아웃 대조(≠`crossPresetSimilarityChecks`) | ✅ | `groundBootstrap.test.ts` "★ D-3 홀드아웃 대조". 실측 `|Δd|/d`·`|Δtilt|`·`|Δf|/f` **전부 0.00%**(임계 10%/1.0°/5%) |
| `conf` 를 1.0 으로 채우지 않기 + 정직성 issue | ✅ | `buildAutoGroundModel` 이 `bootstrapConf` 상속, `AUTO_MODEL_ISSUE` 상수 **항상** 부착. 테스트가 봉인 |
| R-4 슬롯 순서 보존 · 개수 불일치 거부 | ✅ | `buildApplySpaces` 가 파일 순서·idx 보존. 미매칭 기존 슬롯 1건이라도 있으면 `applicable=false` → 라우트가 전량 중단(부분 적용 없음) |
| R-5 빈 배열/wipe 가드 | ✅ | `spaces.length===0` 이면 파일 쓰기 전에 중단 |
| 함정1 피치=슬롯 폭(2.5) | ✅ | `colPitchM = slotWidthM`. 테스트 "★ 함정1" 이 `rows=1, cols=7` 로 봉인 |
| 함정2 단일 행 가정 금지 | ✅ | (row,col) 2D + §2 의 다중 격자 |
| 함정3 축 판정은 지면 실측 스팬 | ✅ | `fitGridFromQuads` §② — 픽셀 길이 미사용 |
| RANSAC 금지 / 순회 순서 고정 / round5·stringify5 | ✅ | 원형 median(닫힌 형태), `sortedCells` (row asc→col asc), `stringify5`. 테스트가 5자리 규약 검사 |
| 수동 드로잉 경로 유지 | ✅ | 기존 편집 UI·`PUT /capture/place-roi` 전부 무변경. 신규 패널은 가산 |
| 운영 중 자동 재추정 금지 | ✅ | 라우트는 명시적 POST 로만. `confirm: z.literal(true)` 없으면 400 |
| throw 금지 → null + issues | ✅ | 신규 코드 전역. 라우트도 `{ok:false, error, issues}` |

---

## 4. 신규 공개 API 시그니처

```ts
// groundFrame.ts — 프리셋 불변 지면 2D(원점=카메라 나딜 d·n, 축=pan 보정 기저)
interface GroundFrame { origin: Vec3; e1: Vec3; e2: Vec3 }
groundFrameOf(g: GroundModel, panDeg: number | null): GroundFrame | null
groundPointOf(fr: GroundFrame, a: number, b: number): Vec3
groundCoordsOf(fr: GroundFrame, X: Vec3): { a: number; b: number }

// groundGrid.ts
interface GroundGrid { camIdx; originM:{a,b}; thetaDeg; colPitchM; rowPitchM; cols; rows;
                       slotIdByCell: Record<string, number>; issues: string[] }
interface GridQuad { slotId; row; col; quad: PixelQuad }
cellKey(row, col): string
sortedCells(grid): Array<{row, col, slotId}>              // (row asc → col asc) 결정론
canonicalizeQuad(px: readonly Px[]): PixelQuad | null
gridToPixelQuads(grid, model, panDeg): { quads: GridQuad[]; issues: string[] }
fitGridFromQuads(quads, model, panDeg, opts, slotIds?): { grid: GroundGrid | null; issues: string[] }

// groundBootstrap.ts
const AUTO_MODEL_ISSUE: string                            // 자동 모델에 항상 붙는 정직성 문구
interface CameraGroundConstants { camIdx; imgW; imgH; d; fovBaseV; rollDeg; fromPresetIdx; bootstrapConf; issues }
bootstrapCameraConstants(input, opts): { constants; model; issues } | null
buildAutoGroundModel(c, preset): GroundModel | null       // source:'auto' 최초 실사용 지점
ptzNormal(tiltDeg): [number, number, number]

// autoRoiPlan.ts
const MATCH_MIN_IOU = 0.3
quadIoU(a, b): number
planAutoRoi(input: AutoRoiPlanInput): { plan: AutoRoiPlan | null; issues: string[] }
expandGrid(base, cols, rows, colStart, rowStart): GroundGrid
buildApplySpaces(plan, fileSpaces, opts?): PlaceRoiSpace[] | null
nextGlobalIdxOf(placeRoiJson): number

// gridStore.ts
readGroundGridFile(file?): Promise<GroundGridFile | null>
writeGroundGridFile(file, data): Promise<void>
upsertCameraGrids(file, entry): GroundGridFile
```

### 라우트
| 메서드 | 경로 | 부작용 |
|---|---|---|
| POST | `/capture/ground-grid/bootstrap` | **없음**(테스트가 파일 바이트 동일 확인) |
| GET | `/capture/ground-grid` | 없음(미저장 시 404) |
| POST | `/capture/ground-grid/apply` | `PtzCamRoi.json` + `ground_grid.json`. `confirm:true` 필수 |

---

## 5. 계획서와 달라진 점 (전부 사유 명시)

| # | 계획서 | 구현 | 사유 |
|---|---|---|---|
| 1 | 카메라당 격자 **1개** | 격자 **N개**(`grids: GroundGrid[]`) | §2 — 실데이터에서 단일 격자 가정 붕괴. 계획서 §7 Loop 3-1 이 지시한 보고 사항 |
| 2 | `thetaDeg ∈ [0,90) mod 90` | `[0,180)` | `colPitch(2.5) ≠ rowPitch(5.0)` 이므로 θ 와 θ+90 은 **다른 격자**다. mod 90 으로 접으면 함정2·3(preset3 축 뒤집힘)을 표현할 수단이 사라진다. θ↔θ+180 은 인덱스 재매김으로 동일하므로 180 에서 접는다. 접힘 경계(179.9999…)는 `round5` 후 180 이 되어 불변식을 깨므로 1e-4 이내면 0 으로 스냅 |
| 3 | `fitGridFromQuads(...): {grid,issues} \| null` | `{ grid: GroundGrid \| null; issues }` | 원 시그니처는 실패 시 **issues 가 소실**된다(강등 철학 위반) |
| 4 | `fitGridFromQuads(quads, ...)` | `+ slotIds?` 선택 인자 | 셀↔전역 idx 대응에 필요. 생략 시 1-based 순번 |
| 5 | `CameraGroundConstants` 필드 | `+ bootstrapConf` | §4-3 의 "conf 를 1.0 으로 채우지 않고 부트스트랩 conf 상속"을 지키려면 필수 |
| 6 | 라우트 로직을 라우트 파일에 | 순수 계획기 `autoRoiPlan.ts` 로 분리 | "라우트는 얇은 진입점" 저장소 관례 + HTTP 없이 유닛테스트 |
| 7 | R-4 = "개수 불일치면 거부" | **IoU 1:1 매칭** 기준으로 정밀화 | 단순 개수 비교는 순서 역전 시 **조용히 좌표를 뒤바꾼다**. 기존 슬롯이 하나라도 자동 quad 와 매칭(IoU≥0.3)되지 않으면 거부. 매칭 잉여 자동 quad 는 기본적으로 **버린다** |
| 8 | — | `allowNew` 옵션 추가(기본 **false**) | 미매칭 자동 quad 를 `max(idx)+1` 부터 **append**. 기존 idx 를 건드리지 않아 `normalizeGlobalIdx` 의 1..N 순열 조건이 유지된다. 기본 false 라 기본 경로는 엄격 R-4. **라우트에서는 노출했으나 UI 는 노출하지 않았다**(§7) |
| 9 | `web/app.css` 무변경 예정 | `.gg-help` 1개 추가 | `test/manualTableMarkup.test.ts` 가 **첫 번째** `.an-manual-help` 를 수동매핑표 안내문으로 봉인한다. 같은 클래스를 쓰면 그 봉인이 깨진다 → 클래스만 분리(스타일 동일) |
| 10 | — | `test/viewerPtzSyncCoverage.test.ts` 수정 | 신규 라우트를 `NO_MOVE` 로 분류. 이 테스트는 **새 라우트에 분류를 강제하도록 설계**된 것이라 수정이 의도된 사용법이다 |

---

## 6. 검증 결과 (실행 결과 그대로)

```
npx tsc --noEmit   → 0 error
npx vitest run     → 248 files / 2936 tests, all passed (회귀 0)
```

| 검증 | 기준 | 실측 |
|---|---|---|
| 왕복 복원 IoU (전 카메라·전 프리셋 5조합) | ≥ 0.95 | **평균·최소 모두 1.0000** |
| D-3 홀드아웃 `\|Δd\|/d` | < 10% | **0.00%** |
| D-3 홀드아웃 `\|Δtilt\|` | < 1.0° | **0.000°** |
| D-3 홀드아웃 `\|Δf\|/f` | < 5% | **0.00%** |
| Loop 4 자동모델 재투영 IoU | ≥ 0.9 | **평균 1.0000 / 최소 0.9999**, 슬롯 개수 일치 |
| 결정론 | 2회 실행 문자열 동일 | 통과 + **골든 해시** `3b5656b3…` 봉인 |
| 영속화 소수 자리 | ≤ 5 | 두 파일 전수 정규식 검사 통과 |
| bootstrap 부작용 | 0 | 파일 바이트 동일 + `ground_grid.json` 미생성 |
| apply diff 국한 | 대상 프리셋만 | 다른 프리셋·다른 카메라 객체 완전 동일 |

### ⚠️ 이 숫자를 읽는 법 (정직성)
`data/Place01/PtzCamRoi.json` 은 **Unity 시뮬레이터 생성분**이다. PTZ 보고값이 정확하고 격자가 구조적으로 완벽해서
편차가 0.00% 로 나온다. **"실카에서도 0" 을 뜻하지 않는다.** 이 수치가 증명하는 것은 **파이프라인 수학이 무손실**이라는
것뿐이다. 실카 위험(roll≠0 · PTZ 바이어스 · 광학중심≠회전축)은 `groundFrame.ts` 상단과 계획서 §8 R1~R4 에 그대로 있고,
`bootstrapCameraConstants` 는 추정 법선과 PTZ 유도 법선의 각차가 1° 넘으면 issues 로 **드러낸다**(수정은 하지 않는다).

---

## 7. ★ 미완 · 미검증 (위장 없음)

1. **브라우저 실렌더 미확인.** `web/index.html`/`app.js`/`app.css` 변경은 (a) `node --check` 문법, (b) 정적 봉인 테스트,
   (c) 라우트 응답 계약까지만 확인했다. **sharp 스샷 육안 확인(계획서 Loop 5-3/5-4)은 하지 못했다** — Unity 라이브 프레임이
   필요하다. 특히 다음 2건은 **미검증**이다:
   - `#roi-auto` **off 상태 렌더가 변경 전과 픽셀 동일**한지(가산 규약). 코드상 `drawAutoRoi` 는 첫 줄에서
     `if (!$('roi-auto')?.checked || !state.autoRoi) return;` 로 빠지므로 성립할 것으로 보이나 **스샷 대조는 안 했다**.
   - 주황(자동) vs 초록(파일) 겹쳐보기 육안.
2. **`allowNew` 는 라우트에만 있고 UI 에 없다.** 즉 웹에서는 지금 **기존 슬롯 좌표 교체**만 가능하고 신규 슬롯 추가는 못 한다.
   → 그 결과 "1면 그려서 7면 생성"의 실사용 이득은 **파일에 이미 7개 항목이 있을 때만** 나온다. 백지 주차장에서 면을
   늘리려면 `allowNew:true` 를 UI 에 노출해야 한다(안전 검토 후 별건 권장).
3. **행(row) 확장의 유효성.** `rows>1` 은 슬롯이 깊이 방향으로 **맞물려** 있을 때만 옳다. 실데이터는 주차통로가 있어
   preset1↔2 사이가 정수배가 아니었다(§2). UI 기본값 `rows=1`, 툴팁에 경고를 넣었다.
4. **격자 병합 규칙 없음.** `upsertCameraGrids` 는 같은 카메라의 기존 격자를 **통째로 교체**한다. 열 2개를 각각
   부트스트랩하면 나중 것만 `ground_grid.json` 에 남는다(PtzCamRoi.json 적용분은 누적되므로 ROI 자체는 안전).
   격자 이력 누적이 필요하면 별건.
5. **실카 데이터 미검증.** 위 전 항목이 Unity 데이터 기준이다.
6. **범위 밖(코드·문서에 명시함)**: 사선주차·불규칙 배치 → 수동 드로잉 유지. L0(노면 도색선)·L1(번호판) 부트스트랩.
   `replaceSlotSetup` 센터링 컬럼 리셋 취약성(이번 변경이 노출 면적을 늘리지 않음).

---

## 8. 검증자(qa)에게

- 회귀 확인 지점: `web/app.js` 의 `drawRoiOverlay` 에 `drawAutoRoi(ctx)` 1줄이 추가됐다. **off 기본값**이라 회귀 0이어야
  하지만, 가능하면 sharp 스샷 pre/post 픽셀 대조를 해달라(내가 못 한 §7-1).
- `test/groundGrid.test.ts` 의 골든 해시는 `data/Place01/PtzCamRoi.json` **내용에 의존**한다. 그 파일을 의도적으로 바꿨다면
  해시도 갱신해야 한다. 이유 없이 바뀌었다면 회귀다.
- 라우트 테스트는 실데이터를 임시 디렉터리로 **복사해서** 쓴다 — 원본 `data/Place01/PtzCamRoi.json` 은 절대 건드리지 않는다.

## 9. 문서화에게

- 계획서 §1-1 의 정정(“LLM 폴리곤은 `slot_roi` 를 쓰지 않는다”)은 코드 확인 결과 **맞다**. 상위 설계서 §9 정정 노트 필요.
- **가장 중요한 문서화 대상은 §2**(단일 격자 가정 붕괴 + 성립하는 명제의 정확한 범위)다. 이걸 흐리게 쓰면
  다음 사람이 "1면 그리면 카메라 전체가 된다"고 읽는다.
- 신규 설정 키 1개: `store.groundGridFile`(default `Place01/ground_grid.json`, 하위호환).

---

# QA 수정 라운드 (2026-07-27, B 모드 재수정 이터레이션)

입력: `_workspace/03_qa_report.md`. 아래 수치는 전부 **내가 다시 실행한 결과 원문**이다.

## 요약 3줄

1. **우선순위 1 답: 코디네이터의 가설은 절반 맞았다.** `colStart` 자동 탐색은 **실제 결함이었고 고쳤다** —
   자기 열 자동생성 성공률 **4/5 → 5/5**. 하지만 **교차 프리셋 이식 0건은 `colStart` 탓이 아니다.**
   10,000칸 격자 전개 + 533회 브루트포스 스윕으로 **반증**했다(§QA-1).
2. 그 과정에서 **내가 새 결함을 발견해 고쳤다**: 격자를 넓게 펼치면 90° 뒤집힌 다른 주차열에
   `IoU 0.3995/0.3769` 짜리 **오매칭**이 생겨 `applicable=true` 가 됐다 — 올바른 ROI 를 40%만 겹치는
   엉뚱한 quad 로 **덮어쓸 수 있었다**. QA 도 나도 이전 라운드에서 못 잡은 것이다(§QA-6).
3. QA 지적 5건(우선순위 1~5) **전부 수정**. `tsc` 0에러, `vitest` **249파일 / 2954테스트 전량 green**.
   D-2 8파일 무변경 유지. **미완 2건은 여전히 미완**이며 §QA-10 에 그대로 남긴다.

---

## QA-1. ★ 우선순위 1 — colStart 와 "교차 프리셋 이식 0건"의 인과 규명

### 1-a. 무엇을 고쳤나 — 스윕이 아니라 **닫힌 형태 지수 계산**

코디네이터는 "후보 범위를 정렬 순서로 스윕"을 예시로 제시했지만, 그럴 필요가 없다는 것을 먼저 밝힌다:

> `colStart` 는 **무한 격자(lattice)에서 잘라낼 창(window)의 위치**일 뿐이다.
> 어떤 파일 슬롯이 격자와 맞는지는 **창 위치와 무관**하다(격자는 평행이동에 대해 주기적이다).

따라서 스윕 대신 각 파일 슬롯의 **lattice 지수를 직접 계산**한다(`latticeIndexOf`, O(슬롯수), 난수·해시순회 0):

```
colF = (중심·u - origin·u)/colPitch - 0.5 ,  col = round(colF)
residM = hypot((colF-col)*colPitch, (rowF-row)*rowPitch)   ← 최근접 격자점까지의 거리
```

그 다음 **on-lattice 슬롯을 가장 많이 덮는 창**을 고른다(`chooseStart`).
타이브레이크 순서(명시): (1) 덮는 수 최대 (2) `pref`(사용자 지정/기본 0)에 가까움 (3) 값이 큰 쪽.
동점을 남기지 않으며 입력 순서에 의존하지 않는다. `autoOffset:false` 로 수동 오버라이드 가능.

**검산**: `residM` 은 창 평행이동에 **불변**이어야 한다 → 테스트로 봉인(`colStart` 를 -9/5/17,
`rowStart` 를 -2/1/3 으로 바꿔도 `residM` 이 소수점 10자리까지 동일).

### 1-b. 실측 — 자기 열 자동생성 **4/5 → 5/5**

| cam | preset | 파일 슬롯 | QA 라운드 | **이번 라운드** |
|---|---|---|---|---|
| 1 | 1 | 7 | OK 7/7 (colStart=0) | **7/7** avgIoU 0.99998 |
| 1 | 2 | 4 | OK 4/4 | **4/4** avgIoU 1.00000 |
| 1 | 3 | 2 | ❌ **부트스트랩 불가** | **2/2** avgIoU 1.00000 (§QA-4) |
| 2 | 1 | 6 | ⚠️ 1/6 — `colStart=-5` **수동** 필요 | **6/6** avgIoU 0.99999 (**자동** `colStart=-5`) |
| 2 | 2 | 4 | OK 4/4 | **4/4** avgIoU 1.00000 |

→ QA 결함 5(=`colStart` 기본 0 방향 문제) **해소**. 사용자가 `colStart` 를 손으로 스윕할 필요가 없다.

### 1-c. ★ 실측 — 교차 프리셋 이식은 **여전히 0건**이고, 그것은 원리적 한계다

cam1 preset1 면 1개로 부트스트랩(`colStart` 자동):

```
preset1: gen=7 file=7 matched=7 applicable=true  onLattice=7/7 medResid=0.000m avgIoU=0.99998
preset2: gen=7 file=4 matched=0 applicable=false onLattice=0/4 medResid=1.321m
preset3: gen=7 file=2 matched=0 applicable=false onLattice=0/2 medResid=1.791m
```

**근거 1 (닫힌 형태).** `medResid` 는 **최근접 격자점까지의 거리**다. 창을 어디로 옮겨도 격자점 집합은
같으므로 이 값은 변하지 않는다. preset2 의 1.321m 은 임계 0.25m 의 **5.3배**이고, 격자 평행이동은
2.5m 의 정수배만 가능하므로 **어떤 정수 이동으로도 1.321m 을 0 으로 만들 수 없다.**
(QA 가 독립 측정한 "열 위상차 1.318m" 과 소수점 3자리까지 일치한다.)

**근거 2 (전수 반증, 실행).** 창을 최대로 열어 **위치 자체를 무의미하게** 만들었다:

```
창 60x20  = 1,200칸  전개 → preset2 matched=0 · preset3 matched=0
창 200x50 = 10,000칸 전개 → preset2 matched=0 · preset3 matched=0
(preset1 은 두 경우 모두 matched=7 — 자기 열은 정상)
```

**근거 3 (브루트포스, 실행).** `colStart` -20..20 x `rowStart` -6..6 = **533회 전수 스윕**
→ `preset2 최대 matched = 0`.

→ **결론: 이식 0건은 창 탐색 부재가 아니라 정보 한계다.** 다른 주차열의 위상·방위는 입력(면 1개+PTZ)의
어떤 함수로도 표현되지 않는다. QA §5-2 의 판정이 옳았고, 이번에 **실행으로 재확인**했다.

### 1-d. ★ 사용자에게 보고할 최종 명제 (측정으로 확정)

> ✅ **"주차면 1개 → 그 프리셋 · 그 주차열의 전 슬롯"** — 현 데이터 **5/5 성공**, 평균 IoU 0.99998~1.00000
> ❌ "주차면 1개 → 그 열의 전 프리셋" — 이 데이터셋에서 **실증 0건**
> ❌ "주차면 1개 → 카메라의 모든 주차열" — **원리적 불가**(위 3중 근거)

**"그 열의 전 프리셋"에 대한 정직한 단서**: 아키텍처는 이식을 지원하고 투영도 실제로 닿는다
(preset2 프레임 안에 preset1 슬롯 #4·5·6 이 들어온다). 다만 **이 파일은 각 열의 슬롯을 한 프리셋에만
배정**해 두어서 교차 적용할 대상이 없다. 즉 **미실증**이지 **불가 판정은 아니다** — 한 열이 두 프리셋에
나뉘어 등록된 데이터가 있어야 판정할 수 있고, 그런 데이터가 지금 없다. 이 구분을 문서에서 흐리면 안 된다.

---

## QA-2. 우선순위 2 — 골든 해시 봉인 결함 (**수정 완료**)

- `test/fixtures/groundGrid.PtzCamRoi.json` 을 **동결 픽스처**로 추가(현 워킹트리 내용의 사본).
- `groundGrid` / `groundBootstrap` / `groundGridRoutes` 테스트 3종이 **픽스처만** 읽는다.
  런타임 정본 참조 **0건**.
- **검증(실행)**: 런타임 정본을 `git checkout HEAD -- ...` 로 되돌린 뒤 실행 → **29/29 green**
  (QA 라운드에서는 2 failed 였다). 이후 워킹트리를 원상복구했고 `git diff --stat` 이 검증 전후 동일한
  `109 insertions / 109 deletions` 임을 확인했다.
- **재발 방지 봉인 추가**: 신규 테스트 4종이 런타임 정본 경로를 문자열 리터럴로 담으면 실패하는
  정적 테스트를 넣었다(니들은 자기참조를 피하려 조립해서 만든다).
- 선례 준수: `test/groundModelRealData.test.ts` 상단 — "사용자가 앱을 쓰는 것만으로 깨지는 테스트는
  테스트가 아니다".

## QA-3. 우선순위 3 — Requirements 위반 (**수정 완료**)

- **결함 2**: `groundGridRoutes` 의 `JSON.parse` 를 **try 안으로** 이동(bootstrap·apply 양쪽).
  손상 JSON → `fileErrorReply` 로 강등(`{error:'place-roi 읽기/파싱 실패', detail}`). 기존
  `captureRoutes.ts:696-702` 관례와 정합. 라우트 테스트로 봉인(두 라우트 모두 검사).
- **결함 3**: `buildApplySpaces` 가 결과 길이 0이면 `null` 반환. R-5(wipe 가드)를 **순수함수 자체**에도.

## QA-4. 우선순위 4 — cam1 preset3 부트스트랩 불가 (**수정 완료 — groundModel.ts 무변경**)

**원인 규명**: `estimateGroundVPs` 는 성공하는데(두 소실점 산출됨) `focalFromVPs` 가 `null` 이다.
직교 소실점 제약 `f2 = -(v1-c)·(v2-c)` 가 **음수**가 되기 때문이다 — preset3 은 tilt 35.8°/zoom 1 로
깊이변이 짧고, **면 1개**의 두 변군만으로는 두 소실점이 직교 조건을 만족할 만큼 정확히 잡히지 않는다.
(슬롯이 2개뿐인 것은 원인이 아니다 — 부트스트랩은 어차피 면 1개만 쓴다.)

**수정**: `bootstrapCameraConstants(input, opts, knownFovBaseV?)` — 3번째 선택 인자 추가.
`focalFromVPs` 가 실패하면 **같은 카메라의 다른 프리셋에서 공동추정한 `fovBaseV`** 로 `focalFromZoom`
하여 f 를 유도한다. `planAutoRoi` 가 실패 시 `estimateGroundModels(cam, opts).fovBaseV` 를 넘긴다.

- **D-2 준수**: `groundModel.ts` **변경 0줄**. 기존 공개 함수(`estimateGroundModels`/`focalFromZoom`)만 호출.
  신규 수학 0줄. → **사유 보고 후 수정이 필요한 상황이 아니었다**(무변경으로 해결).
- **정당성**: `fovBaseV` 는 zoom 만의 함수인 **카메라 상수**다. 프리셋을 건너 빌리는 것은
  production `estimateGroundModels` 가 이미 카메라 단위로 하는 일과 같다. 위장이 아니다.
- **실측**: cam1 preset3 → `fovBaseV 34.635°` 차용 → `matched 2/2, applicable=true, avgIoU 1.00000`
  (cols=1, rows=2 — 이 열은 슬롯이 **깊이축**으로 쌓여 있다).
- **차용 사실을 반드시 노출한다**: issues 에 *"기준면 단독으로는 f 를 낼 수 없어(직교 소실점 제약 f2<=0)
  같은 카메라의 다른 프리셋에서 공동추정한 fovBaseV ... 를 빌려 부트스트랩했다"*.
- **한계는 남는다(정직)**: 그 카메라에 **다른 프리셋 주차면이 하나도 없으면** 폴백 근거가 없어
  여전히 실패한다. 그 경우 실패 메시지를 *"기준 주차면을 다시 그려라"*(QA 가 "거짓 안내"라고 지적)에서
  *"...폴백도 실패했다 — 이 프리셋은 수동 드로잉을 쓴다"* 로 **정정**했다. 테스트로 봉인.

## QA-5. 우선순위 5 — upsertCameraGrids 통째 교체 (**수정 완료**)

- `gridKeyOf(grid)` 신설: **주차열 동일성 키** = 방위 + 두 축의 lattice 위상(피치 나머지, 0.01m 양자화).
  창(cols/rows/colStart)·셀 배정은 같은 열의 다른 '보기'이므로 키에서 제외한다.
- 같은 열이면 **갱신**, 다른 열이면 **추가**. 카메라 상수는 최신 부트스트랩 값으로 갱신.
- 격자 배열은 `gridKeyOf` asc 로 정렬 → **부트스트랩 순서와 무관하게 파일 바이트 동일**(결정론).
- **파일 포맷 무변경**(`grids` 는 처음부터 배열) — 기존 `ground_grid.json` 호환 유지.
- 테스트 4건(다른 열 추가 / 같은 열 갱신 / 위상 정수배 동일성 / 삽입순서 무관 결정론).

## QA-6. ★ 이번 라운드에서 **새로 발견해 고친 결함** (QA·구현자 모두 놓쳤던 것)

우선순위 1 을 측정하다가 드러났다. 격자를 넓게 펼치면(cols=60,rows=20):

```
[수정 전] preset3: matched=2 applicable=true
             slot12 IoU=0.3995   slot13 IoU=0.3769     ← 90도 뒤집힌 **다른 주차열**과의 우연한 겹침
```

`fileCount=2, matched=2` 라 `unmatchedFile=[]` → **`applicable=true`** → apply 시 올바른 ROI 를
**40%만 겹치는 엉뚱한 quad 로 덮어쓴다.** 리더 원칙("조용히 틀린 ROI 보다 안 그리는 게 낫다") 정면 위반.

**수정 (2중 방어선)**:
1. **1차(주된 것)**: **on-lattice 슬롯만 매칭 후보**로 삼는다. off-lattice = 다른 주차열이므로
   칸이 겹쳐도 같은 슬롯이 아니다. 기하학적으로 의미 있는 게이트이며 IoU 운에 의존하지 않는다.
2. **2차**: `MATCH_MIN_IOU` **0.3 → 0.5**. 같은 슬롯이면 실측 IoU 가 0.99 이상 나온다.
   0.5 는 실카 부정확성 여유이자 오매칭 차단선이다.

```
[수정 후] preset3: matched=0 applicable=false offLattice=[12,13]   ← 적용되지 않는다
          preset1: matched=7 applicable=true  (자기 열은 영향 없음)
```

## QA-7. 진단 노출 (부수 개선)

`PresetPlan` 에 `onLattice` / `offLattice` / `medianResidM` 추가 → 라우트 응답·웹 표에 노출.
**`matched=0` 의 원인을 사용자가 구분할 수 있다**:
- `onLattice > 0` 인데 `matched = 0` → **창 문제**(자동 선택이 해결)
- `onLattice = 0` → **다른 주차열**(창을 어떻게 옮겨도 불가 → 그 열에 기준면을 따로 그려야 함)

## QA-8. 변경 파일 (이번 라운드)

| 파일 | 변경 |
|---|---|
| `src/ground/autoRoiPlan.ts` | `latticeIndexOf`·`chooseStart`·`ON_LATTICE_MAX_M` 신설, `autoOffset` 입력, on-lattice 매칭 게이트, `MATCH_MIN_IOU` 0.3→0.5, `buildApplySpaces` 빈 결과 가드, fovBaseV 폴백 배선, 진단 3필드 |
| `src/ground/groundBootstrap.ts` | `bootstrapCameraConstants` 에 `knownFovBaseV?` 선택 인자 |
| `src/ground/groundGrid.ts` | `quadToGroundM` export(재사용), 셀 키 주석 |
| `src/ground/gridStore.ts` | `gridKeyOf` 신설, `upsertCameraGrids` 를 열 단위 누적으로 |
| `src/api/groundGridRoutes.ts` | `JSON.parse` → try 안, 진단 3필드 응답 노출 |
| `web/app.js` · `web/index.html` | 미리보기 표에 격자정합·이탈 컬럼, `열시작` 툴팁을 '선호값(자동 선택)'으로 |
| `test/fixtures/groundGrid.PtzCamRoi.json` | **신규 동결 픽스처** |
| `test/groundAutoRoiPlan.test.ts` | **신규** 16테스트(우선순위 1/3/4/5 + 오매칭 차단) |
| `test/groundGrid.test.ts` · `groundBootstrap.test.ts` · `groundGridRoutes.test.ts` | 픽스처 전환 + 픽스처 봉인 테스트 + 손상 JSON 테스트 |

**변경 0줄 유지(D-2 재확인, `git diff --numstat`)**: `groundModel.ts` · `project.ts` · `types.ts` ·
`floorRoi.ts` · `Finalizer.ts` · `SqliteStore.ts` · `roiDbLoad.ts` · `web/core.js` → **8/8 NO_CHANGE**.

## QA-9. 검증 결과

```
npx tsc --noEmit → 0 error
npx vitest run   → 249 files / 2954 tests, all passed   (직전 라운드 248/2936 → +1 파일 / +18 테스트)
런타임 정본을 HEAD 로 되돌린 상태 → 지면격자 테스트 29/29 green (QA 라운드는 2 failed)
```

## QA-10. ★ 여전히 미완 — 고쳤다고 쓰지 않는다

1. **브라우저 실렌더 / sharp 스샷 pre-post 픽셀 대조 — 여전히 미수행.** Unity 라이브 프레임이 없다.
   이번 라운드에서 `web/app.js` 를 **추가 수정**했으므로(표 컬럼 2개) 미검증 범위가 오히려 **늘었다**.
   `#roi-auto` off 픽셀 동일성은 여전히 정적 논증(early-return)뿐이다.
2. **`allowNew` UI 미노출 — 고치지 않았다.** QA 권고 5번이 "지금 상태(UI 미노출)가 더 안전하다" 였고,
   `rows>1` 과 조합하면 주차통로 위에 가짜 슬롯을 파일에 써넣을 수 있다는 QA B-3 지적이 유효하다.
   → **의도적으로 남겨 둔다.** 결과적으로 웹에서는 여전히 **기존 슬롯 좌표 교체만** 가능하고,
   백지 주차장에서 면을 늘리는 것은 불가하다. 노출하려면 `rows=1` 강제·off-lattice 셀 제외를 함께 걸어야 한다.
3. **실카 데이터 미검증** — 전 수치가 Unity 시뮬레이터 데이터다. IoU 0.99998~1.00000 과 홀드아웃 편차
   0.00% 는 **파이프라인 수학이 무손실**이라는 뜻일 뿐 실카 정확도가 아니다.
   특히 이번에 새로 넣은 `ON_LATTICE_MAX_M = 0.25m` 와 `MATCH_MIN_IOU = 0.5` 는 **Unity 데이터 기준 튜닝값**이며
   실카에서 재조정이 필요할 수 있다(너무 빡세면 정상 슬롯을 거부 → 안전 실패, 너무 느슨하면 QA-6 재발).
4. **"1면 → 그 열의 전 프리셋" 미실증** — §QA-1d 참조. 불가 판정이 아니라 **판정할 데이터가 없다**.
