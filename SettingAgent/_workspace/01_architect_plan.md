# 설계: VPD 프로덕션 전 경로 차량 3D 육면체 산출 (det 권위 + seg 마스크 정합)

작성: 2026-07-14 / 설계자
입력: 마스터 Goal/결정 + `docs/20260714_194426_VPDseg_3D육면체_2DOF앵커지표.md`(정본, 커밋 23b24d4) + `_workspace_cuboid_20260714/02_developer_changes.md`
전제: **협상 불가 마스터 결정 5종**(det 권위 / det bbox 기반 육면체 / det↔seg 정합 신규 / DB 금지 / 뷰어 기본값)

> ## 3줄 요약
> 1. **신규 로직은 딱 하나 — `associateDetSeg()`**(det bbox ↔ seg 마스크 IoU 1:1 정합). 추정 수학은 `buildVehicleCuboids`/`computeAnchorMetrics`/`filterVehiclesOnPlace`/`segment()` 를 **한 줄도 안 고치고** 재사용한다. `src/ground/{contact,anchor,project,contactTypes}.ts` **변경 0줄**.
> 2. 두 프로덕션 경로(`CaptureJob` 백그라운드 · `detectPipeline` 요청-응답)는 **같은 순수 함수 `buildFrameCuboids()`** 를 부르고, **화면 전달 방식만 다르다**(잡=인메모리+폴링 라우트 / 검출=응답 인라인). DB 무접촉.
> 3. **정합 임계는 이 설계서에서 정하지 않는다.** 실프레임 3장 IoU 분포 실측(§5) 후 확정한다. 그리고 **"정합이 맞다"의 판정자는 IoU 가 아니다**(자기참조) — 리더 육안 합성 + 셔플 음성대조 + cls 일치율(§5-3).

---

## 0. 전제 확인 — 이번 변경이 건드리지 **않는** 것 (Goal 3 = 회귀 0의 구조적 근거)

점유 판정 경로는 **한 줄도 건드리지 않는다.** 근거는 "조심하겠다"가 아니라 **자료 흐름의 분리**다.

| 파일/함수 | 상태 | 이유 |
|---|---|---|
| `CaptureJob.captureTarget()` 의 `vpd.detect()` → `applyOnPlaceFilter()` → `store.insertDetections()` **3줄 블록**(`:314~341`) | **무변경** | 육면체 코드는 이 블록 **아래에 가산**된다. `raw`/`vehicles` 를 **읽기만** 한다 |
| `src/capture/Aggregator.ts` (`aggregate`) · `SqliteStore` · `parking_slots` | **무변경** | 마스크·육면체가 DB 로 흐르는 경로가 **존재하지 않는다**(신규 테이블·컬럼 0) |
| `src/capture/onPlaceFilter.ts` | **무변경** | 읽기 전용 재사용 |
| `src/ground/contact.ts` · `anchor.ts` · `project.ts` · `contactTypes.ts` | **무변경 (0줄)** | 정합 결과를 기존 `SegVehicle` 로 **채워 넣기만** 한다 |
| `packages/types` | **무변경** | `VehicleBox.mask?` 는 이미 있다 |
| `src/clients/VpdClient.ts` | **무변경** | `detect()`·`segment()`·`canSegment()` 전부 그대로 |

**∴ Goal 3(점유 회귀 0)은 "테스트로 확인"이기 전에 "구조적으로 불가능"이다.** 그래도 T6(§6)에서 **프로덕션 `CaptureJob` 을 호출해** `insertDetections` 인자 동일성을 봉인한다 — 구조 논증을 테스트가 배신하는지 본다.

---

## 1. ★ 핵심 신규 로직 — det bbox ↔ seg 마스크 정합

### 1-1. 왜 필요한가 (문제의 정확한 형태)

`vpd_det_v2_yolov11l.pt` 와 `vpd_seg_v2_yolov11l.pt` 는 **다른 모델**이다. 같은 프레임에서:
- 검출 **개수가 다를 수 있다**(det 5대 / seg 4대).
- 같은 차량이라도 **bbox 가 다르다**(다른 NMS·다른 헤드).
- **순서가 다르다**(인덱스 대조 불가 — `bboxes[i]` ↔ `masks[i]` 는 **seg 응답 내부에서만** 유효).

기존 `GET /capture/vehicle-cuboids` 는 이 문제를 **회피**했다 — seg 응답만 쓰고 그 안의 `bboxes[i]`/`masks[i]` 쌍을 그대로 썼다. 이제 **det 가 권위**이므로 회피가 불가능하다. **두 모델의 출력을 이어붙이는 단계가 반드시 필요하다.**

### 1-2. 신규 파일 `src/ground/segAssoc.ts` (순수 · IO 0 · LLM 0, ~70줄)

```ts
/** 정합 파라미터. ★ minIou 는 §5 실측 전까지 확정하지 않는다. */
export interface AssocOptions { minIou: number; }

export interface AssocPair { detIdx: number; segIdx: number; iou: number; }

export interface AssocResult {
  /** 1:1 보장. iou >= minIou. 내림차순 그리디. */
  pairs: AssocPair[];
  /** 짝을 못 찾은 det 인덱스 — **육면체 없이 통과**(점유 무영향). 조용히 사라지지 않는다. */
  unmatchedDet: number[];
  /** det 에 없는 seg 인덱스 — 육면체 생산에서는 **무시**(det 권위). 단 occluder 로는 쓴다(§1-5). */
  unmatchedSeg: number[];
  /** ★ 진단: det 별 최고 IoU(임계 미만도 그대로). 미정합 **사유**의 근거이자 §5 측정의 원자료. */
  bestIouByDet: number[];
  /** ★ 진단: det 별 2위 IoU. best−second 가 작으면 **모호** → 그리디≠최적 위험 신호(§1-4). */
  secondIouByDet: number[];
}

export function associateDetSeg(
  det: readonly NormalizedRect[],
  seg: readonly NormalizedRect[],
  opts: AssocOptions,
): AssocResult;
```

**알고리즘 (그리디 최대 IoU, 결정형):**
1. 모든 (i,j) 쌍의 `iou(det[i], seg[j])` 계산 — **`src/domain/geometry.ts:26` 의 기존 `iou()` 재사용. 신규 기하 0줄.**
2. `iou > 0` 인 쌍만 모아 **IoU 내림차순** 정렬. 동점은 `(detIdx, segIdx)` 사전순 — **랜덤 시드 0, flaky 0**.
3. 위에서부터 순회: det·seg 둘 다 미사용 && `iou >= minIou` → 채택. **1:1 은 "사용됨" 집합으로 구조적으로 보장**된다(임계와 무관).
4. 남은 det → `unmatchedDet`, 남은 seg → `unmatchedSeg`.

복잡도 O(n·m log(nm)). n,m ≤ ~30 → 무시 가능.

### 1-3. 왜 헝가리안이 아닌가 (CLAUDE.md §2)

헝가리안은 **전역 최적 배정**을 준다. 그리디와 결과가 갈리는 것은 **한 seg 마스크를 두 det 이 비슷한 IoU 로 다투는 경우**뿐이다. 주차 차량은 공간적으로 분리돼 있어 이 경우가 실제로 생기는지 **모른다** — 그래서 **측정한다**:

> **§5 측정 항목 ④** — 각 det 의 `best − second` 갭. **3프레임 전부에서 모호 쌍(갭 < 0.10)이 0건이면 그리디 = 헝가리안**(수학적으로 자명)이며, 헝가리안은 **불필요한 코드**다. 갭이 좁은 쌍이 나오면 **그때 리더에게 올린다.** 지금 헝가리안을 넣는 것은 **측정 없는 복잡도**다.

### 1-4. ⚠️ 임계(`minIou`)를 지금 정하지 않는 이유 — 마스터 지시 준수

임의 상수를 박으면 **그 상수가 다음 Loop 의 순환논법이 된다**(§9-2 `CONTACT_Z_OFFSET_M` 기각의 교훈). 대신:

- 코드에는 `DEFAULT_ASSOC_OPTIONS = { minIou: __MEASURED__ }` 를 **`segAssoc.ts` 한 곳에만** 둔다(임계 한 곳 원칙).
- **§5 측정(실프레임 3장 IoU 히스토그램) 전에는 머지하지 않는다.** 측정이 이중분포(참 매칭=고 IoU / 우연=저 IoU)를 보이면 **밸리**를 임계로 잡고, 그 히스토그램을 문서에 싣는다.
- 이중분포가 **안 나오면**(변별 불가) → 임계 선택 자체가 무의미 → **리더 보고 후 중단**. 조용히 0.5 를 박지 않는다.

### 1-5. ⚠️ 판단이 필요한 지점 — seg-only 마스크를 occluder 로 쓰는가

마스터: *"seg 에만 있는 검출은 무시(det 가 권위)"*. **육면체 생산에서 무시하는 것은 명확하다.** 그러나 `buildVehicleCuboids` 의 `occluderMasks`(가림 배제 [2])는 다른 질문이다.

- **추천: seg-only 마스크도 occluder 로 쓴다.** 근거: 가림은 **실루엣의 물리적 성질**이지 det 권위와 무관하다. 앞차가 뒷차 발을 가리면, 그 앞차가 det 에 없더라도 **가린다.** occluder 는 오염된 접지열을 **제거만** 하고 **육면체를 만들 수 없다** → "det 가 권위"를 위반할 수 없다.
- 기존 규약과도 일치: 정본 §2-1 — *"가림 배제는 필터 **전** 전량을 쓴다. 필터 후 집합으로 판정하면 가림이 조용히 누락된다."*
- **이견 시 1줄 변경**(`occluderMasks` 에 넣는 배열만 바꾸면 됨). → **Q3 (§8)**

---

## 2. 공유 산출기 `src/ground/frameCuboids.ts` (신규, ~120줄)

**세 표면(잡·검출·기존 라우트)이 같은 함수를 부른다. 산출 로직 중복 0.**

```ts
/** 프리셋별 육면체 산출 문맥. 라우트가 지면모델·슬롯을 해결해 넘긴다(잡·검출·라우트 공통). */
export interface CuboidContext {
  model: GroundModel;          // 해당 cam/preset 지면모델(estimateGroundModels 산출 — 재사용)
  slotPolysPx: Px[][];         // 슬롯 폴리곤(원본 픽셀)
  slotWidthM: number;
  slotDepthM: number;
}

export interface FrameCuboids {
  imgW: number; imgH: number;
  /** vpdIdx = **det 검출 인덱스**(권위). §2-2 참조. */
  cuboids: VehicleCuboid[];
  rejected: RejectedVehicle[];
  /** ★ 미정합 det — 육면체 없이 통과. **사유가 관측 가능**하다(조용히 버리지 않는다). */
  unmatched: Array<{ detIdx: number; bestIou: number; reason: string }>;
  /** ★ det↔seg 매핑(원본 되짚기 유일 키). segIdx 로 seg 응답의 masks[segIdx] 로 간다. */
  assoc: AssocPair[];
  anchor: AnchorMetrics;
  summary: {
    detCount: number; segCount: number;           // 두 모델의 검출 개수 — **다를 수 있다**
    kept: number; filteredOut: number;            // 주차면 필터
    matched: number; unmatchedDet: number; segOnly: number;
    cuboidCount: number; rejectedCount: number;
    segDegraded: boolean; maskMismatch: number;   // VpdClient 강등 카운터 그대로
    segMs: number; buildMs: number;               // ★ 성능 실측(§7)
  };
  issues: string[];
  /** ⚠️ **항상 true** — 배치(X,Y) 정확도를 재는 정량 지표가 없다(D-1, 정본 §9-1). 뷰어가 배지로 드러낸다. */
  estimateUnverified: true;
}

export async function buildFrameCuboids(args: {
  jpeg: Buffer;
  /** ★ 권위 — 점유 판정이 쓰는 **바로 그 det 배열**(필터 전 전량). 읽기 전용. */
  detBoxes: readonly VehicleBox[];
  /** 주차면 필터를 통과한 det 인덱스. 미지정 → 전량. */
  keptDetIdx?: readonly number[];
  vpd: Pick<VpdClient, 'segment' | 'canSegment'>;
  /** null → 육면체 미산출 + issue(지면모델·슬롯 없음). **throw 금지.** */
  ctx: CuboidContext | null;
}): Promise<FrameCuboids>;
```

### 2-1. 파이프라인 (기존 [0]~[8] 앞에 **[−1] 정합**만 추가)

```
[-1] associateDetSeg()      ★ 신규 — det bbox(권위) ↔ seg rect. 1:1.
[0]  segment()              기존 — 마스크 얻기 위한 **추가 호출**(det 는 이미 호출됨)
[0.5] filterVehiclesOnPlace 기존 — det rect 로 필터(권위 유지). 재사용, 0줄
[1]~[8] buildVehicleCuboids 기존 — **0줄 변경**
[9]  computeAnchorMetrics   기존 — 0줄 변경
```

### 2-2. ★ `SegVehicle` 조립 — 무엇이 det 에서 오고 무엇이 seg 에서 오는가

정합된 쌍 `(detIdx, segIdx)` 마다:

| `SegVehicle` 필드 | 출처 | 근거 |
|---|---|---|
| `vpdIdx` | **det 인덱스** | ★ **권위 목록의 키.** 점유 판정이 쓰는 그 배열로 되짚는다 |
| `cls`, `confidence` | **det** | det 가 권위 — seg 의 값을 쓰면 두 모델이 섞인다 |
| `bboxPx` | **det bbox** | 참고 IoU(`reprojIou`)의 기준도 권위 쪽 |
| `mask` | **seg** | seg 의 존재 이유. 이것만 seg 에서 온다 |

> ⚠️ **`vpdIdx` 의 의미가 바뀐다** — 기존 라우트에서는 "seg 검출 인덱스"였고, 이제 "**det(권위) 검출 인덱스**"다. 원본 마스크로 되짚는 키는 `assoc[].segIdx` 다. 두 키를 분리해 payload 에 둔다. **`contactTypes.ts` 는 손대지 않는다**(`assoc` 은 payload 레벨). → **Q5 (§8)**

### 2-3. 강등 정책 — **정밀수집 잡을 절대 죽이지 않는다** (마스터 §5)

| 상황 | 결과 | throw? |
|---|---|---|
| `vpd.canSegment() === false`(segPath 미배선) | `cuboids: []` + issue `'seg 미배선'` | ❌ |
| seg **HTTP 500**(검출 0대 — S-1 미해결) | `VpdClient` 가 이미 `{boxes:[], segDegraded:true}` 로 강등. `cuboids: []` + issue | ❌ |
| seg **타임아웃·네트워크 오류·기타 5xx** | `buildFrameCuboids` 가 **try/catch 로 흡수** → `cuboids: []` + issue(사유 문자열) | ❌ **신규 방어** |
| `masks.length ≠ bboxes.length` | 기존 `maskMismatch` drop → 그 seg 는 정합 후보에서 빠짐 | ❌ |
| **정합 실패**(bestIou < 임계 / 후보 0) | `unmatched[]` 에 **사유 + bestIou** 보존. 육면체 없이 통과 | ❌ |
| 지면모델 없음(그 프리셋) / 슬롯 폴리곤 0개 | `ctx: null` 또는 축 실패 → `cuboids: []` + issue(기존 동작) | ❌ |
| 접지선 게이트 탈락(flank·bridge·가림 과다) | 기존 `rejected[]` + 사유(기존 12종 강등 그대로) | ❌ |

**`throw` 총 0건.** 잡 쪽 호출부는 **추가로 한 겹 더** try/catch 로 감싼다(방어 이중화 — 잡 사망은 절대 불가).

---

## 3. 두 프로덕션 경로 — **화면에 닿는 방식이 다르다** (마스터 §3)

### 3-1. 경로 A: `CaptureJob` (백그라운드 라운드 반복 · 뷰어는 폴링)

**문제**: 잡은 백그라운드로 돌고 뷰어는 `/capture/status` + `/capture/frame` 을 폴링한다. 뷰어가 기존 `GET /capture/vehicle-cuboids` 를 부르면 **그 라우트가 카메라를 새로 촬영한다** → (a) 화면에 뜬 프레임과 **다른 프레임**의 육면체를 그리게 되고, (b) 잡이 PTZ 를 돌리는 중에 **카메라를 뺏는다**. → **라이브 촬영 라우트는 잡 경로에 쓸 수 없다.**

**설계**:
1. `CaptureJob.captureTarget()` — 기존 블록(`:314~341`) **아래에 가산**:
   ```ts
   // ↓ 기존 3줄 블록은 그대로. 아래만 추가(점유 경로 읽기 전용).
   if (this.cuboidCtxResolver) {
     const keptDetIdx = vehicles.map((v) => raw.indexOf(v)); // ★ 참조 동일성 — 필터가 객체를 보존한다
     await this.updateCuboids(t, cap.jpg, raw, keptDetIdx, roundIdx); // 내부 try/catch, throw 0
   }
   ```
   - `keptDetIdx` 는 **필터 결과를 재계산하지 않고** `indexOf`(참조 동일성)로 얻는다 → **필터 경로 무접촉**.
   - `await` 한다(fire-and-forget 아님). 이유: **결정성**(테스트 가능) + 라운드 간 30~80초 대기가 있어 체감 0(§7).
2. 결과를 **인메모리**에 보관: `private cuboidsByPreset = new Map<string, FrameCuboids & { roundIdx, capturedAt }>()`. `start()` 에서 clear. **DB 무접촉.**
3. **화면 전달 — 2단 구조**:
   - `GET /capture/status` 에 **경량 인덱스**만 가산:
     ```jsonc
     "cuboid": { "1:1": { "round": 3, "cuboidCount": 4, "unmatched": 1, "segDegraded": false } }
     ```
     (프리셋당 4개 숫자. 폴링 주기마다 수십 KB 를 실어 보내지 않는다.)
   - **신규 라우트 `GET /capture/job-cuboids?cam&preset`** → 잡 메모리의 `FrameCuboids` 전문. **카메라 호출 0 · VPD 호출 0**(읽기만).
   - 뷰어: status 의 `cuboid[key].round` 가 **바뀔 때만** job-cuboids 를 재요청 → `state.vcuboidByKey[key]` 갱신 → 기존 `drawVehicleCuboidOverlay` 가 그린다(**뷰어 렌더 신규 0줄**).

> **왜 status 에 전문을 싣지 않는가**: 프리셋 7개 × 차량 10대 × (floorQuad+floorGround+issues) ≈ 수십 KB. status 는 초당 폴링된다. **round 인덱스만 싣고 전문은 필요할 때 가져오는 것**이 최소 설계다. 마스터의 *"status/응답에 실어야 한다"* 는 **DB 를 쓰지 말라**는 뜻으로 읽었다 — 인메모리 + 폴링 라우트가 그 제약을 만족한다. **이견 시 status 전문 탑재로 전환 가능**(1곳 변경). → **Q4 (§8)**

4. `src/index.ts` — `CaptureJob` 에 `ground: tools.ground` · `cameraposFile` 주입(현재 미주입). `ground.enabled === false` → **육면체 전 기능 자동 off**(기존 킬스위치 재사용 — **신규 설정 플래그 0**).

### 3-2. 경로 B: `detectPipeline` (`POST /capture/detect` · 요청-응답)

**단순하다 — 응답에 인라인.**

1. `DetectDeps.vpd` 확장:
   ```ts
   vpd: Pick<VpdClient, 'detect'> & Partial<Pick<VpdClient, 'segment' | 'canSegment'>>;
   ```
   ★ **`Partial`** 인 이유: 기존 테스트 스텁(`{ detect }` 만 구현)이 **타입 에러 없이 그대로 컴파일**된다 → 회귀 0(CLAUDE.md §3). seg 부재 = 육면체 미산출(강등).
2. `runDetect(deps, args, cfg, onPlace?, cuboidCtx?)` — **5번째 옵셔널 인자**. 미지정 시 기존과 **완전히 동일한 응답 shape**(`cuboids` 필드 자체가 없다).
3. 육면체는 **base 프레임**(`base.jpg`)에서 산출한다 — det bbox 가 나온 **바로 그 프레임**. zoom 재시도 뷰는 쓰지 않는다.
4. 위치: 주차면 필터 **직후**, zoom 재시도 루프 **전**(루프와 무관·독립).
5. `DetectResult.cuboids?: FrameCuboids` 가산 → 뷰어가 `state.vcuboidByKey[key] = res.cuboids` 로 바로 그린다.
6. 라우트 `/capture/detect` 는 `resolveCuboidContext(deps, cam, preset)` 로 ctx 를 해결해 넘긴다.

### 3-3. 중복 제거 — `resolveCuboidContext()` 헬퍼 추출

지면모델 + 슬롯 폴리곤 해결 코드가 **현재 `/capture/ground-model` 과 `/capture/vehicle-cuboids` 에 두 번**(`captureRoutes.ts:406~432`, `:457~491`) 있고, 이제 `/capture/detect` 와 `CaptureJob` 에도 필요하다 → **4중복.** `captureRoutes.ts` 안의 로컬 헬퍼로 1개 추출(이중구현 금지 규약 준수).

---

## 4. 기존 `GET /capture/vehicle-cuboids` 의 운명 — **리더 승인 필요** (마스터 §4)

**진단**: 중복도 고아도 아니고 — **"두 개의 다른 진실"이 된다.** 이 라우트는 **seg 를 권위**로 차량 목록을 만든다(seg 검출 4대 → 육면체 4개). 새 경로는 **det 를 권위**로 만든다(det 5대 → 정합 4대 → 육면체 4개, 미정합 1대 관측). 같은 프리셋에서 **다른 차량 집합**을 낼 수 있다. 뷰어가 어느 쪽을 그렸는지에 따라 화면이 달라진다.

| 안 | 내용 | 장 | 단 |
|---|---|---|---|
| **가** | 그대로 두고 **"seg-권위 진단용 레거시"** 로 명시. 뷰어는 안 씀 | 변경 0 | **두 진실 상존** — 다음 사람이 이 라우트를 보고 "육면체는 seg 권위"로 오해한다 |
| **나 ★추천** | **내부를 `buildFrameCuboids` 로 교체**(det+seg 2회 호출 · 정합 적용). 응답 shape 은 `unmatched`/`assoc` **가산**만. URL·기존 필드 전부 유지 | **하나의 진실.** 뷰어 토글이 잡·검출 없이도 계속 동작. 산출 로직 1곳 | VPD 호출 1→2회. `vehicleCuboidRoutes.test.ts`(12건) 픽스처가 det 스텁을 추가해야 함(단언은 유지) |
| 다 | 삭제 | 표면 감소 | **금지**(마스터: 임의 삭제 금지). 잡·검출 없이 임의 프리셋 육면체를 볼 수단이 사라짐 |

**추천: 나.** 이유 — "두 개의 진실"은 이 팀이 반복해서 다친 유형(문서·주석·tooltip 이 갈라진 D-2)의 **코드판**이다. `buildFrameCuboids` 로 교체하면 **세 표면이 같은 함수**를 부르고, 정합/미정합/미검증 배지가 전부 일관된다.

> **리더 승인 없이 진행하지 않는다.** 승인 전까지 구현자는 **가**(무변경)를 가정하고 신규 표면만 만든다.

---

## 5. ★ 정합 품질 실측 계획 (Goal 4) — **자기참조 방어가 설계의 일부다**

하네스: `SettingAgent/_qa_assoc_iou.mjs`(기존 `_qa_live_roi_overlay.mjs` 전례 — **`src/` 아님, 프로덕션 코드 아님**).
입력: `data/refframes/cam1_p{1,2,3}.jpg` (실프레임 3장), 라이브 VPD `192.168.0.125:9081`.
**★ 규약: 하네스는 프로덕션 `associateDetSeg()` 를 `import` 해서 호출한다. 재구현 금지**(D-1 함정).

### 5-1. 측정 항목 (전부 프레임별 + 합산)

| # | 측정 | 왜 |
|---|---|---|
| ① | `detN` vs `segN` — 두 모델의 검출 개수 | **다르다는 전제 자체의 실증.** 같다면 정합이 사소한 문제일 수도 |
| ② | 전체 IoU 행렬(det × seg) | 원자료. 문서에 그대로 싣는다 |
| ③ | det 별 **bestIoU 히스토그램**(bin 0.05) | **이중분포(참 매칭 고 / 우연 저)의 밸리 = 임계.** 임계는 **여기서만** 나온다 |
| ④ | det 별 **best − second 갭** | 갭 < 0.10 인 모호 쌍이 **0건이면 그리디 = 헝가리안**(§1-3) |
| ⑤ | 임계 스윕 τ ∈ {0.1 … 0.9} → matched% / unmatchedDet% / segOnly% | 임계 민감도. 절벽이면 위험 |
| ⑥ | **미정합 사유 분류**: (a) 후보 0(seg 가 그 차를 못 봄) (b) 마스크 파편화·병합(중간 IoU) (c) det FP | Goal 4 의 "미정합 사유" |
| ⑦ | **det/seg 지연 실측(ms) × 3프레임** | §7 성능 |

### 5-2. 🔴 "정합이 잘 됐다"를 **무엇으로 판정하는가** — 이 팀이 다섯 번 빠진 함정

> **IoU 로 정합 품질을 판정하면 자기참조다.** IoU 는 **정합 알고리즘 자신의 점수 함수**다. "IoU 가 높으니 정합이 맞다"는 `frontFitResidPx` 가 "잔차가 작으니 배치가 맞다"고 한 것과 **정확히 같은 오류**다(D-1).

**IoU 와 독립인 판정자 3종만 쓴다:**

| 판정자 | 내용 | 독립성 |
|---|---|---|
| **J1. 리더 육안 (주 판정자)** | sharp 합성 이미지 `docs/assets/.../assoc_p{1,2,3}.jpg` — det bbox(실선) + **정합된 seg 마스크를 같은 색**으로 · 미정합 det(빨강 점선) · seg-only(회색). **리더가 눈으로 1:1 대응을 확인**한다 | ✅ 완전 독립(사람) |
| **J2. 셔플 음성대조** | seg 목록을 무작위 순열해 재정합 → **matched% 가 붕괴해야 한다.** 안 붕괴하면 IoU 가 변별력 0 → 임계 자체가 무의미 → **리더 보고 후 중단** | ✅ IoU 의 **변별력**을 재는 것이지 IoU 로 정답을 재는 게 아니다 |
| **J3. cls 일치율** | 정합 쌍의 det.cls vs seg.cls 일치 비율. **기하가 아니다** | ✅ 기하와 독립 신호(약하지만 교락 없음) |

> ⚠️ **J1 조차 완전하지 않다** — 정본 §5-4 에서 리더의 육안이 한 번 오판했다. 그래서 **J2·J3 를 함께** 본다. 셋이 갈리면 **단정하지 않고 리더에게 올린다.**

### 5-3. 🔴 픽스처 함정 방어 (마스터 지적 5종)

| 함정 | 이번 설계의 방어 |
|---|---|
| ① 픽스처가 **검증 대상의 가정을 복사** | 정합 테스트 픽스처는 **실서버 응답을 그대로 녹화한 JSON**(`test/fixtures/assoc/cam1_p{1,2,3}.json` — det 응답 + seg 응답 원문). **합성 bbox 로 정합을 검증하지 않는다.** 합성은 **극단 케이스 보조**(완전중첩·0중첩)로만 |
| ② 픽스처가 **실데이터 구조를 대표 못함** | 3프레임은 tilt 6.9°/7.5°/18.8° · D 41/38/15m · 차량 5/9/14대로 **이미 이질적**이다. 그대로 녹화 |
| ③ 테스트가 **프로덕션을 재구현** | **모든 테스트·하네스가 프로덕션 `associateDetSeg`/`buildFrameCuboids` 를 `import` 해 호출한다.** 로컬 헬퍼로 IoU·매칭을 다시 짜면 **PR 거부** |
| ④ 회귀분석이 **교락을 신호로 오인** | 이번 작업엔 회귀분석이 **없다**(z 오염·배치 지표 건드리지 않음). §9-2 의 열린 항목은 **열린 채로 둔다** |
| ⑤ 대안 지표가 **같은 교락의 다른 얼굴** | **배치 정확도 지표를 새로 만들지 않는다**(리더 Q-QA1 결정 유지). 이번 작업은 **정합**만 다룬다 — 배치는 여전히 미검증이고 화면이 그렇게 말한다(§6-7) |

---

## 6. 단계별 구현 계획 (각 단계 = 검증 기준)

| # | 단계 | **검증(성공 기준)** |
|---|---|---|
| **1** | `src/ground/segAssoc.ts` — `associateDetSeg()`. `iou()` 재사용. `minIou` 는 **placeholder 로 두고 §5 전엔 확정 금지** | `vitest`: **1:1 불변식**(한 det 이 두 seg 를 못 먹고 그 역도). 완전중첩 3×3 · 0중첩 · det0개 · seg0개 · 동점 결정성(2회 호출 결과 동일). **전부 프로덕션 함수 호출** |
| **2** | 하네스 `_qa_assoc_iou.mjs` — §5 측정 ①~⑦ + J1 합성 이미지 + J2 셔플 + J3 cls | **리더 관찰**: 히스토그램 이중분포 확인 → **임계 확정.** J2 붕괴 확인. J1 육안 1:1 확인. **여기서 임계가 정해지기 전엔 3단계로 못 간다** |
| **3** | 임계 반영 + `test/fixtures/assoc/*.json` **녹화**(실서버 응답 원문) | `vitest`: 녹화 픽스처 3프레임 → 프로덕션 `associateDetSeg` → matched/unmatched **카운트 봉인**. 셔플 음성대조에서 matched **붕괴** 단언 |
| **4** | `src/ground/frameCuboids.ts` — `buildFrameCuboids()`. `buildVehicleCuboids`·`computeAnchorMetrics`·`filterVehiclesOnPlace` **그대로 호출** | `vitest`: **강등 7종**(§2-3) 전부 `throw` 0 + issue 문자열 확인. det cls/conf/bbox 가 **det 것**이고 mask 만 seg 것임을 단언. seg-only 가 `occluderMasks` 에 **들어감**을 인자 캡처로 단언 |
| **5** | `resolveCuboidContext()` 추출(captureRoutes 로컬) | `tsc` exit 0 + 기존 `/capture/ground-model`·`/capture/vehicle-cuboids` 테스트 **무변경 통과**(리팩터 회귀 0) |
| **6** | `detectPipeline` — `vpd` Pick 확장(**Partial**) + `runDetect` 5번째 옵셔널 인자 + `DetectResult.cuboids?` | `vitest`: ctx 미주입 → 응답 shape **기존과 동일**(cuboids 키 없음). 기존 `detectPipeline.test.ts`·`lpdFilterRegression.test.ts` **전량 무수정 통과**. ctx 주입 → cuboids 산출 |
| **7** | `/capture/detect` 라우트 — ctx 해결·전달 | `vitest`: 라우트 계약 200 + `cuboids` 존재. seg 미배선 → `cuboids` 없이 200(400/502 아님) |
| **8** | `CaptureJob` — `updateCuboids` 가산 + `cuboidsByPreset` 인메모리 + `getStatus()` 경량 인덱스 | ★ **T6 회귀 봉인**: 프로덕션 `CaptureJob` 을 육면체 **on/off** 두 번 돌려 `store.insertDetections` 인자가 **완전 동일**(deep equal) + `aggregate()` 결과 동일. seg 가 **throw 해도 잡이 running 유지**(사망 금지) |
| **9** | `GET /capture/job-cuboids` 신규 라우트(잡 메모리 읽기 — 카메라·VPD 호출 0) | `vitest`: 잡 미실행 → 404/빈. 실행 후 → payload. **카메라 스텁이 한 번도 안 불림**을 단언 |
| **10** | `src/index.ts` — `CaptureJob` 에 `ground`·`cameraposFile` 주입 | `tsc` exit 0. `ground.enabled=false` → 육면체 전 기능 off(기존 킬스위치) |
| **11** | 뷰어 — status 인덱스 폴링 → job-cuboids 페치 / detect 응답 인라인 / **미검증 배지**(§6-7) / `index.html:162` 50→**1** · `:168` 10→**1** | **리더 경험적 검증**(G1~G5, §6-8) |
| **12** | (승인 시) `/capture/vehicle-cuboids` 내부를 `buildFrameCuboids` 로 교체(§4 나안) | 기존 `vehicleCuboidRoutes.test.ts` **단언 유지**, 픽스처만 det 스텁 가산. `cuboidTraceability.test.ts` **영향 확인**(§8 Q5) |

### 6-7. ⚠️ 미검증 표기 — **화면이 거짓말하면 안 된다** (마스터 §7)

정본 §9-1: **배치(X,Y) 정확도를 재는 정량 지표는 없다. L·H 는 원리적으로 관측 불가(항상 prior).** 사용자가 육면체를 "측정값"으로 오인하면 안 된다.

- `FrameCuboids.estimateUnverified: true`(리터럴 — **끌 수 없다**).
- 뷰어: 육면체 토글이 켜지면 **항상** 배지 표시 — `추정(미검증)` + 정합 요약 `정합 4/5 · 미정합 1`.
- 배지 tooltip(운영자가 읽는 **유일한 표면** — D-2 의 교훈: 소스 주석만 고치면 안 된다):
  ```
  [⚠️ 미검증 추정 — 측정값이 아니다]
  · 위치(X,Y): 앞범퍼 접지선 역투영에서 나온 값이나, **그 정확도를 재는 지표가 없다**(자기참조 잔차만 존재).
              유일한 근거는 육안이며 육안은 오판한 전례가 있다.
  · 길이(L)·높이(H): **항상 차종 prior**(세단 4.7m / 1.45m) — 원리적으로 관측 불가.
              SUV·트럭이면 육면체가 틀린다.
  · 방향(yaw): 슬롯 폴리곤 prior.
  · 폭(W): 관측(점선 = prior 강등분).
  ```
- 미정합 차량은 **아무것도 그리지 않는다**(빈 자리로 남는다) + 배지 카운트로 드러난다. **조용히 버리지 않는다.**

### 6-8. 리더 경험적 검증에 맡기는 것 (vitest 로 못 하는 것)

| G | 확인 | 성공 기준 |
|---|---|---|
| **G1** | 정밀수집 시작(count=1 · checkpoint=1) | 뷰어에 **육면체가 그려진다**(Goal 1) |
| **G2** | "검출 실행" 버튼 | 뷰어에 **육면체가 그려진다**(Goal 2) |
| **G3** | `assoc_p{1,2,3}.jpg` 육안 | det bbox ↔ 마스크가 **같은 차량**인가(J1) |
| **G4** | 육면체 배치 육안 | 바닥면이 바퀴에 닿는가. **⚠️ 이것이 배치의 유일한 근거이며 그 자체로 오판 가능**(정본 §5-4) |
| **G5** | 배지·tooltip | "미검증 추정"이 **읽힌다**(Goal 7) |
| **G6** | 라운드 소요시간 | seg 추가로 라운드가 **눈에 띄게 느려지지 않는다**(§7) |

---

## 7. 성능 — 프레임당 VPD 2회 (마스터 §6)

| 경로 | 호출 | 예상 |
|---|---|---|
| `CaptureJob` 라운드 | 프리셋당 det 1 + **seg 1**(신규) | 라운드 간 대기 **30~80초** → 프리셋당 +0.3~1s 는 **체감 0**. 단 프리셋 7개면 라운드당 **+7 seg 호출** |
| `POST /capture/detect` | det 1 + LPD 1 + **seg 1**(신규) + zoom 재시도(최대 4× 캡처+LPD) | seg 1회는 **이미 있는 최대 9회 호출** 대비 미미 |

**실측 계획**(추측 금지):
- `summary.segMs` / `buildMs` 를 payload·로그에 싣는다(§2 타입에 이미 포함).
- 하네스 §5 ⑦ 에서 det/seg 지연을 3프레임 실측 → 문서에 기재.
- **G6**: `count=1` 로 육면체 off/on 라운드 총시간 비교(리더 관찰).
- **캐시·병렬화·배치 호출은 넣지 않는다**(요청 없음 — CLAUDE.md §2). 실측이 문제를 보이면 **그때** 리더 판단.

---

## 8. 미해결 / 가정 — **리더 확인 필요** (조용히 선택하지 않는다)

| Q | 질문 | 설계자 추천 | 미결 시 |
|---|---|---|---|
| **Q1** | **`GET /capture/vehicle-cuboids` 처리**(§4) 가/나/다 | **나**(내부를 `buildFrameCuboids` 로 교체 — 하나의 진실) | **가**(무변경) 가정하고 신규 표면만 구현 |
| **Q2** | 뷰어 `#roi-vcuboid` **기본값**(현재 off) | **on 으로 변경.** Goal 1·2 가 *"화면에 그려진다"* 인데 기본 off 면 아무것도 안 보인다. 렌더 토글은 **점유 판정과 무관** → Goal 3 무영향 | off 유지(리더가 매번 수동으로 켬) |
| **Q3** | **seg-only 마스크를 occluder 로 쓰는가**(§1-5) | **쓴다**(가림은 실루엣의 성질. 육면체를 만들 수 없으므로 det 권위 위반 불가) | 안 씀(1줄 변경) |
| **Q4** | 잡 육면체 전달: **status 경량 인덱스 + 폴링 라우트** vs **status 전문 탑재** | **경량 인덱스 + `/capture/job-cuboids`**(status 는 초당 폴링 — 수십 KB 를 매번 싣지 않는다) | status 전문 탑재(1곳 변경) |
| **Q5** | `vpdIdx` 의미 변경(seg 인덱스 → **det 권위 인덱스**) + `assoc[].segIdx` 신설 | **변경한다**(det 권위의 필연). `contactTypes.ts` 는 무변경 — `assoc` 은 payload 레벨 | — (Q1=나 채택 시 `cuboidTraceability.test.ts` 의미 재확인 필요) |
| **Q6** | `CaptureJob` 이 **매 라운드** seg 를 부르는가 | **매 라운드**(화면이 항상 최신 프레임과 일치). 킬스위치는 기존 `ground.enabled` 재사용 — **신규 설정 플래그 0** | 첫 라운드만 / 체크포인트마다 |
| **Q7** | **정합 임계값** | **지금 정하지 않는다.** §5 측정 후 확정. **측정 없이 머지 금지** | — |

### 8-1. 명시적 가정 (틀리면 알려달라)

- **A1**: det 응답과 seg 응답의 `rect` 정규화 기준(imgW/imgH)이 **같다** — 같은 JPEG 를 `readJpegSize` 로 읽으므로 참. IoU 를 정규화 좌표에서 직접 계산 가능.
- **A2**: `filterVehiclesOnPlace` 는 입력 객체 **참조를 보존**한다(`Array.filter`) → `raw.indexOf(v)` 로 `keptDetIdx` 를 얻는 것이 정확하다. (`onPlaceFilter.ts:51` 확인함.)
- **A3**: `GroundModel.imgW/imgH` == 캡처 JPEG 크기. 기존 `/capture/vehicle-cuboids` 가 이미 이 가정 위에 서 있다(`:498`) — **새 가정이 아니다**.
- **A4**: 마스터의 *"DB 저장 금지"* 는 **SQLite `detections`/`parking_slots` 뿐 아니라 신규 테이블 일체**를 뜻한다 → 인메모리 + 응답 전용.

---

## 9. MCP 경계 판단 (하네스 규약)

**전부 결정형 도구. LLM 0회.**
- `associateDetSeg` — IoU 그리디. 수치 반복·결정형. **LLM 이 관여할 여지 없음**(모호 판단이 아니라 기하).
- `buildFrameCuboids` — 순수 조합 + REST 호출 1회. LLM 0.
- `CaptureJob` 육면체 갱신 — 백그라운드 결정형. **체크포인트 LLM 경로와 완전히 분리**(`checkpoint()` 무접촉).
- **LLM 두뇌는 이번 작업에 등장하지 않는다.**

---

## 10. 영향 받는 파일 (구현자·문서화 인계)

### 신규
| 파일 | 성격 |
|---|---|
| `src/ground/segAssoc.ts` | **순수** · IO 0 · LLM 0. **이번 작업의 유일한 신규 알고리즘** |
| `src/ground/frameCuboids.ts` | 조합 + seg 호출 1회. throw 0 |
| `test/segAssoc.test.ts` | 1:1 불변식 · 결정성 · 극단 케이스 |
| `test/assocRealFrames.test.ts` | **녹화 실픽스처** 3프레임 + 셔플 음성대조 |
| `test/frameCuboids.test.ts` | 강등 7종 · det/seg 출처 분리 · occluder 규약 |
| `test/captureJobCuboid.test.ts` | ★ **점유 회귀 봉인**(insertDetections 인자 동일 · 잡 사망 금지) |
| `test/fixtures/assoc/cam1_p{1,2,3}.json` | **실서버 응답 원문 녹화**(합성 금지) |
| `_qa_assoc_iou.mjs` | 하네스(프로덕션 아님). §5 측정 + J1/J2/J3 |

### 변경 (**전부 가산** — 기존 경로 0줄 수정)
| 파일 | 변경 |
|---|---|
| `src/capture/CaptureJob.ts` | `updateCuboids` 가산 · `cuboidsByPreset` 인메모리 · `getStatus()` 경량 인덱스. **`:314~341` 점유 블록 무변경** |
| `src/capture/detectPipeline.ts` | `DetectDeps.vpd` **Partial 확장** · `runDetect` 5번째 옵셔널 인자 · `DetectResult.cuboids?` 옵셔널 |
| `src/api/captureRoutes.ts` | `resolveCuboidContext()` 추출 · `GET /capture/job-cuboids` 신규 · `/capture/detect` 에 ctx 전달 · (Q1 승인 시) `/capture/vehicle-cuboids` 내부 교체 |
| `src/index.ts` | `CaptureJob` 에 `ground`·`cameraposFile` 주입 |
| `web/app.js` | status 인덱스 → job-cuboids 폴링 · detect 응답 인라인 · **미검증 배지** |
| `web/index.html` | `:162` `#cap-count` 50→**1** · `:168` `#cap-checkpoint` 10→**1** · (Q2) `#roi-vcuboid` 기본 checked |

### 무변경 보장 (**검증 대상**)
`src/ground/contact.ts` · `anchor.ts` · `project.ts` · `contactTypes.ts` · `src/clients/VpdClient.ts` · `src/capture/onPlaceFilter.ts` · `src/capture/Aggregator.ts` · `src/capture/SqliteStore.ts` · `packages/types/*`
→ **git diff 로 0줄 확인**(구현자 보고 필수 항목).
