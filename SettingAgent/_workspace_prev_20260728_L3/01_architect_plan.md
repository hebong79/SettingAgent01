# 01 설계 계획 — L3: 주차면 1개 드로잉 → 전 프리셋 바닥 ROI 자동 생성

작성: 2026-07-27 / 설계자(architect) / 입력: `_workspace/00_leader_context.md`(단일 출처) + 코드 직접 확인

> 이 문서의 모든 단정은 **읽은 코드의 파일:줄**로 근거를 댄다. 근거 없는 항목은 "불확실"로 표기했다.

---

## 0. 요약 (구현자가 먼저 볼 3줄)

1. **정본 충돌은 설계서가 말한 형태로 존재하지 않는다.** LLM 폴리곤은 `slot_roi` 를 쓰지 않는다(미영속·미배선). 진짜 경쟁은 **파일 ROI(PtzCamRoi.json) vs 자동 격자**이고, 결론은 **파일이 정본, 자동 격자는 파일을 통해서만 DB 에 도달**한다.
2. 이 goal 을 달성하려면 **프리셋 불변 지면 2D 좌표계**가 반드시 필요하다. 이것이 이번 작업에서 **유일한 신규 수학**이다(약 40줄). 나머지는 기존 `groundModel.ts`/`project.ts` 재사용.
3. 리더 Loop 3 의 성공기준(`crossPresetSimilarityChecks` 통과)은 **자동 모델에 대해 항진명제(tautology)** 다. 그대로 쓰면 아무것도 검증하지 못한다 → §4-4 의 **홀드아웃 검증**으로 교체할 것을 제안한다(리더 확인 요청 Q1).

---

## 1. ★ 정본 충돌 결정 (구현 전 필수) — 코드 실태 확인 결과

### 1-1. 확인한 사실 (추측 아님)

**`slot_setup.slot_roi` 에 쓰는 코드는 저장소 전체에 정확히 2곳뿐이다.**

| 쓰기 지점 | 소스 | 근거 |
|---|---|---|
| `Finalizer.persistSlotSetupFromPlace` | `loadNormalizedPlaceRoi(placeRoiFile)` = **PtzCamRoi.json** | `src/capture/Finalizer.ts:286` `slotRoi: stringify5(sp.points)` (sp = place.byPreset 원소), 호출부 `:210-215` |
| `roiDbLoad.buildSlots` (→ `loadRoiIntoDb`) | `normalizePtzCamRoi(ptzRaw)` = **PtzCamRoi.json** | `src/capture/roiDbLoad.ts:182`, `:246`, `:319` |

**두 지점 모두 소스가 PtzCamRoi.json 이다. LLM 폴리곤 경로는 `slot_roi` 를 쓰지 않는다:**

- `resolveFloorPolygon` 의 유일한 호출자는 `FloorRoiReviewer.review` 이고, 반환값을 **`void` 로 버린다** — `src/capture/FloorRoiReviewer.ts:95`.
  같은 줄 위 주석(`:93-94`): *"캡처 루프 배선 제거(설계서 §6.5) … 구 upsertFloorRoi(DB 중간테이블) 폐기. 산출 폴리곤은 **미영속**(본 클래스는 미배선 잔존)"*.
- `FloorRoiReviewer` 자체가 **런타임에 배선되어 있지 않다** — `src/index.ts:63` *"캡처 루프 LLM off(설계서 §6.5): CheckpointReviewer/FloorRoiReviewer 배선 제거"*. `grep -rn FloorRoiReviewer src` 결과 생성 지점 0건.
- 웹은 `const FLOOR_ROI_USE_LLM = false;` 로 상수 고정(`web/app.js:87`), 이 상수가 서버 게이트로도 전달된다(`web/app.js:2545` → `captureRoutes.ts:84,296` → `CaptureJob.ts:235`).
- `resolveFloorPolygon`/`buildPlateAnchoredQuad` 계열이 실제로 살아 있는 곳은 **`occupy_range`(점유 발자국)** 와 artifact 의 floor 폴리곤이다(`Finalizer.ts:279`, `:371-376`) — **`slot_roi` 와 다른 컬럼**이다.

> **상위 설계서 §9 의 "LLM 폴리곤과 자동 격자가 동시에 slot_roi 를 쓴다"는 현재 코드 기준으로 사실이 아니다.**
> 이 문서가 그 기술을 정정한다. 문서화 단계에서 상위 설계서에 정정 노트를 남길 것.

### 1-2. 진짜 충돌과 결정적 근거

진짜 경쟁은 **자동 격자 → `slot_setup` 직접 쓰기** vs **파일(PtzCamRoi.json) → `slot_setup`** 이다.
그리고 이건 취향 문제가 아니라 **결정된다**:

> `Finalizer.persistSlotSetupFromPlace` 는 매 finalize 마다 **`replaceSlotSetup`(DELETE+INSERT 전량 교체)** 를 호출하며(`Finalizer.ts:300`), 그 소스는 무조건 PtzCamRoi.json 이다.
> 따라서 **자동 격자를 DB 에만 쓰면 다음 finalize 에서 반드시·조용히 소멸한다.** (검출 컬럼은 `existingBySlot` 로 보존되지만 `slotRoi` 는 `sp.points` 로 무조건 덮인다 — `:286`)

### 1-3. ★ 확정 규칙 (우선순위)

```
[1] 지면 격자 + 카메라 상수  (data/Place01/ground_grid.json)   ← 저작물(authored). 카메라당 숫자 8개.
        │  명시적 트리거(승인 버튼)로만 아래로 흐른다. 자동 재적용 금지.
        ▼
[2] PtzCamRoi.json                                            ← **정본 표면**. 사람이 손으로 고칠 수 있는 마지막 지점.
        │  기존 경로 그대로(변경 0줄)
        ▼
[3] slot_setup.slot_roi                                       ← 파생. 쓰기 지점은 지금의 2곳에서 늘리지 않는다.
```

**규칙 R-1.** 자동 격자는 **`slot_setup` 에 직접 쓰지 않는다.** 승인 시 `PUT /capture/place-roi` 와 동일한 경로로 **PtzCamRoi.json 을 갱신**하고, DB 반영은 기존 finalize/load-roi 가 담당한다. → 신규 DB 쓰기 코드 **0줄**, `replaceSlotSetup` 호출자 **증가 0**.

**규칙 R-2. 사람이 항상 이긴다.** 파일이 격자와 어긋나면 **파일이 옳다**. 격자 재적용은 승인 버튼에서만 일어나고, 덮어쓰기 직전 프리셋별 IoU/차이를 보여준다. 운영 중 자동 재추정·자동 재적용 금지(Requirements).

**규칙 R-3. LLM 폴리곤 경로는 손대지 않는다.** 승격도 제거도 하지 않는다. `slot_roi` 와 무관함이 확인됐으므로 이번 작업의 변경 대상이 아니다(외과적 변경 원칙).

**규칙 R-4. 승인 적용 시 슬롯 번호는 기존 파일 순서를 보존한다.**
대상 프리셋에 기존 space 가 N개 있으면, 자동 quad 를 **좌표만 교체**하는 방식으로 1:1 매칭한다(개수 불일치면 적용 거부 + 사유 표시). 기존 space 가 0개인 프리셋에서만 새 번호를 부여한다.
근거: `slot_id` 는 `normalizeGlobalIdx` 순서로 재부여되며(`roiDbLoad.ts:165`, `Finalizer.ts:264`) 여기가 흔들리면 `slot_ptz.json`·센터링 결과·artifact `globalIndex` 가 통째로 어긋난다.

**규칙 R-5. wipe 가드.** 승인 라우트는 `quads.length === 0` 또는 개수 불일치면 **파일에 쓰지 않고** `{ ok:false, error }` 를 반환한다(`roiDbLoad.ts:7-9` 의 기존 안전 규약과 동일 철학).
※ 기존에 알려진 `replaceSlotSetup` 의 **센터링 컬럼 리셋** 취약성(`Finalizer.ts:243-245`)은 이번 변경이 **노출 면적을 늘리지 않으므로 범위 밖**으로 둔다. 문서에 명시.

---

## 2. 프리셋 불변 지면 좌표계 — 이번 작업의 유일한 신규 수학

### 2-1. 왜 필요한가 (건너뛸 수 없는 이유)

`GroundModel` 의 `n`,`d` 는 **그 프리셋의 카메라 좌표계** 값이다(`types.ts:37-39`). 카메라는 프리셋마다 pan/tilt 로 **회전**하므로, 격자를 카메라 좌표로 표현하면 프리셋마다 다른 격자가 된다 → "1개 그려서 전 프리셋" 이 원리적으로 불가능하다.
리더 Loop 1 이 IoU 1.0 을 낸 것은 **각 프리셋 안에서의 왕복**이었다. 프리셋을 **건너뛰는** 다리가 아직 없다.

### 2-2. 다리의 정체 — 이미 있는 `slotBearingDeg` 의 역

- **원점**: 카메라 나딜(지면 수직발)은 카메라가 안 움직이므로 **세계 고정점**이다. 프리셋 p 의 카메라 좌표에서 나딜 = `d·n_p` (`n·X=d`, `|n|=1`).
- **축**: `slotBearingDeg`(`groundModel.ts:416-428`)가 `bearing = pan + azimuth` 를 프리셋 불변량으로 쓴다. 그 역이 곧 축 정의다.
  ```
  fwd_p   = unit(z − (z·n_p)·n_p)        // groundModel.ts:422 와 동일 식
  right_p = unit(n_p × fwd_p)            // :424 와 동일
  e1_p    = cos(pan_p)·fwd_p − sin(pan_p)·right_p   // bearing 0° 방향
  e2_p    = sin(pan_p)·fwd_p + cos(pan_p)·right_p   // bearing 90° 방향  (e1·e2 = 0)
  ```
- 지면점 X(카메라좌표) ↔ 지면 2D `(a,b)`:
  ```
  v = X − d·n_p ;  a = v·e1_p ;  b = v·e2_p
  X = d·n_p + a·e1_p + b·e2_p
  ```

**가정(정직하게 명시):** ① roll = 0 ② PTZ pan/tilt 보고값이 정확 ③ 광학중심이 pan/tilt 회전축과 일치(나딜이 pan 에 불변). 셋 다 실카에서 깨질 수 있고, ①③ 은 격자 **위상**을, ②는 격자 **방위**를 직접 오염시킨다. → §7 리스크.

### 2-3. 신규 파일 `src/ground/groundFrame.ts`

```ts
/** 프리셋 불변 지면 2D 좌표계(카메라 1대). 원점 = 카메라 나딜, 축 = pan 보정 기저. */
export interface GroundFrame {
  /** 나딜(카메라좌표 m) = d·n. */
  origin: Vec3;
  /** bearing 0°/90° 방향 단위벡터(카메라좌표, 지면 위, 상호 직교). */
  e1: Vec3;
  e2: Vec3;
}

/** GroundModel + PTZ pan → 지면 2D 프레임. 퇴화(수직 하방·n 불량) → null (throw 금지). */
export function groundFrameOf(g: GroundModel, panDeg: number): GroundFrame | null;

/** 지면 2D (a,b) → 카메라좌표 3D. */
export function groundPointOf(fr: GroundFrame, a: number, b: number): Vec3;

/** 카메라좌표 지면점 → 지면 2D (a,b). 지면 밖 점은 평면에 투영된 값을 준다(경고 없음 — 순수). */
export function groundCoordsOf(fr: GroundFrame, X: Vec3): { a: number; b: number };
```

순수·IO 없음·의존은 `types.ts` 와 벡터 헬퍼(`project.ts` 의 `dot3/cross3/unit3` **재사용**, 재구현 금지).

---

## 3. 지면 격자 자료구조 + 순수 변환

### 3-1. 신규 파일 `src/ground/groundGrid.ts`

```ts
/**
 * 주차장 지면 격자(미터, 프리셋 무관). 좌표는 GroundFrame(a,b) 기준.
 * ★ 함정1: colPitchM 은 **슬롯 폭(2.5m)** 이다. 깊이(5.0m)로 잡으면 인접 슬롯이 반칸 어긋나
 *          IoU 가 1/0 으로 교대한다(리더 실측 평균 0.5714).
 * ★ 함정2: 행(row)은 **다른 주차열**이다. 단일 행 가정 금지 — (row,col) 2D 인덱스가 필수.
 *          (리더 실측: preset 3 은 스팬 축이 뒤집힘 2.5×5.0, 단일 행 가정 시 preset 2 는 IoU 0.333)
 */
export interface GroundGrid {
  camIdx: number;
  /** 격자 원점(지면 2D, m) = 셀 (row 0, col 0) 의 '근좌' 코너. */
  originM: { a: number; b: number };
  /** 격자 방위(도, [0,90) mod 90). 열축 = e1 을 이 각만큼 회전한 방향. */
  thetaDeg: number;
  /** 열 피치(m) = 슬롯 폭. 기본 ground.slotWidthM(2.5). */
  colPitchM: number;
  /** 행 피치(m) = 슬롯 깊이. 기본 ground.slotDepthM(5.0). */
  rowPitchM: number;
  cols: number;
  rows: number;
  /** 셀 → 전역 슬롯번호. 키 `${row}:${col}`. 미배정 셀은 키 부재 = 그리지 않음. */
  slotIdByCell: Record<string, number>;
  issues: string[];
}
```

**결정론 규약(명문):**
- 순회는 **항상** `row asc → col asc` 정렬 키로 한다. `Object.keys`/`Map` 삽입 순서에 의존 금지.
- `thetaDeg` 는 `[0,90)` 로 접는다(폭/깊이 배정 뒤집힘 흡수 — `groundModel.ts:414` 의 mod 90 규약과 동일).
- 영속화 직전 전 수치에 `round5`, 파일 기록은 `stringify5`.

### 3-2. 순수 변환 함수

```ts
/** 자동 산출 quad 1건. */
export interface GridQuad {
  slotId: number; row: number; col: number;
  /** 원본 센서 픽셀 4점, PixelQuad 규약(p0=근좌,p1=원좌,p2=원우,p3=근우). */
  quad: PixelQuad;
}

/**
 * 격자 → 프리셋 픽셀 quad. `project.ts::projectToPixel` 만 쓴다(신규 투영 수학 0줄).
 * 강등: 코너 4개 중 하나라도 null(지평선 위·카메라 뒤) → 그 셀만 **통째로 제외** + issues 1건.
 *       (부분 quad 금지 — projectCuboidPixels 의 "하나라도 퇴화하면 전체 null" 규약과 동일)
 * 순회 순서 고정: row asc → col asc.
 */
export function gridToPixelQuads(
  grid: GroundGrid,
  model: GroundModel,
  panDeg: number,
): { quads: GridQuad[]; issues: string[] };

/**
 * 역방향(부트스트랩·검증용): 프리셋 quad들 → 격자 파라미터 적합.
 * 결정론: RANSAC 금지. 방위 = 변 방향의 mod90 원형중앙값, 위상 = 잔차 median 최소화의 **닫힌 형태**
 *         (격자 위상은 1DOF ×2 → 후보를 정렬 스윕하지 않고 `mod` 잔차의 median 으로 직접 계산).
 * 실패(quad 0개·퇴화) → null + issues.
 */
export function fitGridFromQuads(
  quads: PixelQuad[], model: GroundModel, panDeg: number, opts: Pick<GroundOptions,'slotWidthM'|'slotDepthM'>,
): { grid: GroundGrid; issues: string[] } | null;

/** 픽셀 4점을 PixelQuad 규약 순서로 캐노니컬화(근=픽셀 y 큰 쪽, 좌우=이미지 외적 부호). 결정론. */
export function canonicalizeQuad(px: readonly Px[]): PixelQuad | null;
```

- **폭/깊이 축 판정은 픽셀 길이로 하지 않는다**(함정3). `fitGridFromQuads` 는 **지면 2D 실측 스팬**(backproject 후 미터)으로 판정한다 — `groundModel.ts:227-228`·`§4-6` 과 동일 원칙.
- `canonicalizeQuad` 가 중요한 이유: 산출 quad 가 그대로 `estimateGroundVPs`(변군 규약 `edgesOf`, `groundModel.ts:204-215`)의 입력이 되고, 순서가 틀리면 깊이/폭 배정이 조용히 뒤집힌다.

---

## 4. 부트스트랩 — 재사용/신규의 경계

### 4-1. 재사용(변경 0줄)

| 함수 | 위치 | 용도 |
|---|---|---|
| `estimateGroundVPs` | `groundModel.ts:230` | 기준 quad 1개 → 두 소실점 |
| `focalFromVPs` | `:256` | f (단독) |
| `buildGroundPlane` | `:326` | (n, d, metricErr, depthFamily, dirA) — median 기반, RANSAC 없음 |
| `poolFovBaseV` | `:292` | f + zoom → `fovBaseV` 역산 |
| `focalFromZoom` | `:273` | 다른 프리셋 f 유도 |
| `slotBearingDeg` | `:416` | 방위 불변량 |
| `crossPresetSimilarityChecks` | `:556` | 검증(신규 검증기 금지 — Requirements) |
| `projectToPixel` | `project.ts:61` | 투영 |

### 4-2. 신규 파일 `src/ground/groundBootstrap.ts`

```ts
/** 카메라 상수 — 프리셋 불변량. ground_grid.json 에 영속. */
export interface CameraGroundConstants {
  camIdx: number;
  imgW: number; imgH: number;
  /** 카메라 지상고(m). 리더 B-1 실측: 3프리셋 편차 0.00%. */
  d: number;
  /** zoom→f 유도용(도). poolFovBaseV 역산. */
  fovBaseV: number;
  /** roll 보정각(도). 이번 범위에서는 **항상 0**(가정) — 실카 확장 지점. */
  rollDeg: number;
  /** 부트스트랩에 쓴 프리셋(추적성). */
  fromPresetIdx: number;
  issues: string[];
}

/** 기준 주차면 1개(픽셀 4점) + 그 프리셋 PTZ → 카메라 상수. 실패 → null + issues. */
export function bootstrapCameraConstants(
  input: { camIdx: number; imgW: number; imgH: number; presetIdx: number;
           zoom: number; tilt: number; pan: number; quad: PixelQuad },
  opts: GroundOptions,
): { constants: CameraGroundConstants; model: GroundModel; issues: string[] } | null;

/**
 * 드로잉 없는 프리셋의 GroundModel 조립.
 *   f = focalFromZoom(zoom, fovBaseV, imgW, imgH)
 *   n = [0, cos t, sin t]   ← roll=0. groundModel.ts:505 (tiltDeg = asin(n[2])) 의 정확한 역
 *   d = 상수 재사용(프리셋 불변량)
 * source: 'auto'  ← types.ts:70 에 예약된 값이 **여기서 처음 실제로 쓰인다**.
 */
export function buildAutoGroundModel(
  c: CameraGroundConstants, preset: { presetIdx: number; zoom: number; tilt: number; pan: number },
): GroundModel | null;
```

### 4-3. ★ 정직성 규약 — 자동 모델의 지표를 위장하지 않는다

`buildAutoGroundModel` 이 만드는 모델은 **이미지 증거가 0** 이다. 따라서:

- `metricErr = 0`, `tiltErrDeg = 0` 이 되는데 이는 **구성상 0**이지 품질이 아니다.
- 그러므로 **반드시** issues 에 고정 문구를 넣는다:
  `'source=auto: PTZ 로 유도된 모델 — metricErr/tiltErr 는 구성상 0이며 검증력이 없다'`
- `conf` 는 1.0 으로 채우지 **않는다.** 부트스트랩 프리셋의 `conf` 를 그대로 상속한다(그 이상의 근거가 없으므로).

### 4-4. ★ 검증 방법 정정 (리더 확인 요청 Q1)

리더 Loop 3 기준은 "`crossPresetSimilarityChecks` 통과(dDevRel<10%, bearingDevDeg<8°)" 인데:

> **자동 모델들은 `d` 를 같은 상수에서 복사하므로 `dDevRel` 이 정의상 0 이다. 방위도 같은 격자에서 나오므로 `bearingDevDeg` 도 0 이다. 이 검사는 자동 모델에 대해 항진명제이며, 아무것도 검증하지 못한다.**

의미 있는 검증 = **홀드아웃 대조**(기존 검사기·기존 데이터만 사용, 신규 검증기 0):

1. preset 1 의 quad **1개**로만 부트스트랩 → preset 2·3 의 **auto 모델** 생성.
2. 같은 preset 2·3 의 **파일 quad 로 추정한 모델**(기존 `estimateGroundModels` 산출)과 대조:
   - `|Δd|/d < 10%` (D_DEV_REL 과 같은 임계 재사용)
   - `|Δtilt| < 1.0°` (TILT_MISALIGN_DEG 재사용)
   - `|Δf|/f < 5%`
3. `crossPresetSimilarityChecks` 는 **파일 유래 모델 집합**에 대해 그대로 돌려 전제(불변량)를 재확인한다(리더 B-1 이 이미 통과: 편차 0.00%).

→ Loop 3 성공기준을 이걸로 교체할 것을 제안한다. **리더 승인 없이 임의 변경하지 않는다.**

---

## 5. 영속화

### 5-1. 파일 vs DB → **파일**

`data/Place01/ground_grid.json` (신규). `store.groundGridFile` 설정 추가(default `'Place01/ground_grid.json'`, `toolsConfig.ts:290-299` StoreSchema).

근거:
1. DB 스키마는 `Docs/MyThink/my_db_table.md` 기준 **6테이블 정본**으로 확정돼 있다(메모). 새 테이블 추가는 그 결정과 충돌 → 파일이 마찰이 적다.
2. 격자는 PtzCamRoi.json 과 **같은 계층의 저작물**이다. 같은 곳에 두는 게 개념상 정합.
3. 골든 해시 테스트를 파일 문자열(`stringify5`)로 직접 봉인할 수 있다.

형식(모든 수치 `round5`, 기록은 `stringify5(obj, 2)`):
```jsonc
{ "version": 1, "cameras": [ { "constants": { …CameraGroundConstants… },
                              "grid": { …GroundGrid… },
                              "appliedPresets": [1,2,3], "updatedAt": "ISO8601" } ] }
```

### 5-2. `GroundModel.source: 'auto'` 를 실제로 쓰는 지점

- `buildAutoGroundModel` 의 반환값 **하나뿐**이다.
- **`GET /capture/ground-model` 은 변경하지 않는다.** 지금 이 라우트는 육면체 렌더의 유일 근거이고(`captureRoutes.ts:709-713`, `web/app.js:914-924`), 소스를 조용히 auto 로 바꾸면 육면체가 프리셋 단위로 달라진다. 자동 모델은 **신규 미리보기 라우트에서만** 반환한다.
- 뷰어 `web/core.js:1540-1554` 는 `source` 를 읽지 않으므로 파리티 영향 0.

### 5-3. `slot_roi` 기록 경로

승인 → PtzCamRoi.json 갱신(§6) → **기존 경로 그대로** DB 로. `SqliteStore`/`Finalizer`/`roiDbLoad` **변경 0줄**.
가드는 §1-3 R-4/R-5 (개수 일치 + 빈 배열 거부). ※ `PlaceRoiPutSchema` 가 빈 `spaces` 를 허용하는지 구현자가 확인할 것(§8 미확인 항목).

---

## 6. 라우트 + 웹 UI

### 6-1. 라우트 — 신규 파일 `src/api/groundGridRoutes.ts`

등록 게이트: `deps.ground?.enabled && deps.placeRoiFile` (없으면 등록 안 함 — `registerGroundRoutes` 관례 `captureRoutes.ts:708`).

| 메서드 | 경로 | 동작 | 부작용 |
|---|---|---|---|
| POST | `/capture/ground-grid/bootstrap` | body `{camId, presetIdx, quad:[4×{x,y}](정규화), cols, rows, startSlotId?}` → 상수 + 격자 + **전 프리셋 미리보기 quad** + 프리셋별 `iouVsFile` | **없음(미저장)** |
| GET | `/capture/ground-grid` | 저장된 상수·격자(없으면 404) | 없음 |
| POST | `/capture/ground-grid/apply` | body `{confirm:true, presets:[idx…]}` → `ground_grid.json` 저장 + 대상 프리셋 PtzCamRoi.json 갱신 | **파일 2개** |

- 미리보기 계산은 **전부 서버**(뷰어는 추정하지 않는다 — `captureRoutes.ts:711` 규약).
- 파일 갱신은 기존 `applyPlaceRoiUpdate` 재사용(`captureRoutes.ts:697`) — 픽셀 역변환·구조 보존이 이미 검증된 단일 구현.
- `confirm !== true` 면 400(승인 없는 저장 불가). 실패는 전부 `{ok:false,error}` + issues, throw 금지.

### 6-2. 웹 UI

**입력(드로잉)은 신규 툴 0줄.** 기존 주차면 편집(추가/코너 드래그, `web/index.html:355-361`, `app.js:1266~`, `state.selectedPlaceIdx`)으로 그린 **1개 면**을 그대로 부트스트랩 입력으로 보낸다. 수동 경로는 **그대로 유지**(제거 금지 요건 충족).

신규 패널(정밀수집 탭) `지면 격자(자동 ROI)`:
```
[기준 주차면: #선택된 전역인덱스]  [부트스트랩]
  → fovBaseV / 카메라고 d / 방위 θ / issues 표시
[열 수][행 수][시작 슬롯번호]  [미리보기]
  → 프리셋별 표: 생성 슬롯수 · 파일 슬롯수 · 평균 IoU · issues
[☑ 위 결과를 확인했습니다]  [승인 후 적용]   ← 체크 없으면 disabled
```

**토글 공존 (`#roi-floor` / `#roi-db` 체계):**
- 신규 `#roi-auto` 체크박스를 `roi-toggles` 에 추가(`index.html:38-43`).
- **의미 분리:** `#roi-floor` = 바닥 레이어 마스터 스위치(현행 유지). `#roi-auto` = **가산 레이어** — 파일 ROI 를 **대체하지 않고 겹쳐** 그린다(겹쳐보기가 목적). `#roi-db` 는 DB 소스 게이트라 무관(현행 유지).
- 색: 파일=초록 `#39ff14`(`app.js:608-610`), DB=현행, **자동=주황 계열**(신규, 파일과 구분).
- `#roi-auto` off 면 기존 렌더와 **픽셀 단위 동일**해야 한다(가산 규약 — `app.js:630` 육면체 레이어와 같은 원칙). 이걸 Loop 5 완료 조건으로 봉인.

---

## 7. 단계 분할 (Loop 2~5) — 각 단계의 검증 가능한 완료 조건

### Loop 2 — 격자 자료구조 + 순수 변환 (`groundFrame.ts`, `groundGrid.ts`)
1. `groundFrameOf`/`groundPointOf`/`groundCoordsOf` 구현 → **검증**: 합성 모델에서 `groundCoordsOf(groundPointOf(a,b)) === (a,b)` 오차 < 1e-9; 퇴화(수직 하방) → null.
2. `canonicalizeQuad` → **검증**: 임의 회전/감김 입력 4점이 항상 `isUsableQuad` 통과 + `edgesOf` 규약대로 근/원 배치.
3. `gridToPixelQuads` → **검증(a)**: 합성 격자 왕복 `backproject∘project` 오차 < 1e-6 px. **검증(b)**: 실데이터 `data/Place01/PtzCamRoi.json` 각 프리셋에 `fitGridFromQuads` → `gridToPixelQuads` → 원본 quad 대비 **평균 IoU ≥ 0.95**(리더 Loop 1 을 저장소 테스트로 봉인).
4. **골든 해시**: 고정 입력(커밋된 fixture) → `sha256(stringify5(quads))` 상수 비교 테스트.
5. `tsc --noEmit` 0, 전체 vitest green(회귀 0).

### Loop 3 — 프리셋 불변성 + 부트스트랩 (`groundBootstrap.ts`)
1. **불변 프레임 실증**: preset 1/2/3 의 **파일 quad** 를 각자 지면 2D 로 올렸을 때 세 프리셋의 격자가 일치 → 방위 편차 **< 8°(mod 90)**, 위상 편차 **< 0.25m**(= 열 피치 2.5m 의 10%).
   ※ 여기서 preset 3 의 스팬 축 뒤집힘(리더 함정 2)이 **(row,col) 인덱스로 흡수**되는지 확인. 흡수 안 되면 격자가 두 개 필요한 배치이므로 **즉시 리더에 보고**하고 설계 재검토(단일 격자 가정 붕괴).
2. **홀드아웃 검증(§4-4)**: preset 1 quad 1개 부트스트랩 → preset 2·3 auto 모델 vs 파일 유래 모델: `|Δd|/d<10%`, `|Δtilt|<1.0°`, `|Δf|/f<5%`.
3. `crossPresetSimilarityChecks` 를 파일 유래 모델에 적용해 전제 재확인(신규 검증기 0).
4. 자동 모델에 정직성 issue 문구가 **항상** 붙는지 테스트로 봉인(§4-3).

### Loop 4 — 전 프리셋 자동 ROI 생성
1. 부트스트랩 상수 + 격자 → 전 프리셋 `gridToPixelQuads`.
2. **검증**: 자동 quad vs 파일 quad **평균 IoU ≥ 0.9**, **슬롯 개수 일치**.
3. 개수 불일치·미생성 셀은 `issues` 로 노출되는지 확인(조용한 누락 0건).
4. 결정론: 같은 입력 2회 실행 → 산출 JSON 문자열 **완전 동일**(해시 일치).

### Loop 5 — 라우트 + 웹 UI
1. 라우트 유닛테스트: bootstrap 은 **파일을 절대 쓰지 않음**(fs write spy 0회), apply 는 `confirm:true` 없으면 400, 개수 불일치/빈 배열이면 파일 무변경.
2. apply 후 PtzCamRoi.json diff 가 **대상 프리셋에만** 국한(다른 프리셋 바이트 동일).
3. `#roi-auto` off 상태 렌더가 변경 전과 **픽셀 동일**(sharp 스샷 비교).
4. sharp 스샷 육안: 자동(주황) vs 파일(초록) 겹쳐보기 + IoU 표 표시 확인.

---

## 8. 리스크 · 미확인 · 범위 밖

### 리스크
| # | 리스크 | 영향 | 완화 |
|---|---|---|---|
| R1 | **roll ≠ 0**(실카) — `n=[0,cos t,sin t]` 가 틀림 | 전 프리셋 격자가 회전 | `rollDeg` 필드를 상수에 **자리만** 만들어 두고 이번엔 0 고정. 부트스트랩 프리셋의 추정 `n` 과 PTZ 유도 `n` 의 차이를 issues 로 **노출**(수정은 별건) |
| R2 | **PTZ pan/tilt 보고 바이어스** | 격자 방위·위상 오차, 실카 최대 위험 | Unity 데이터는 0.01° 일치(리더 B-1). 실카는 홀드아웃 검증을 프리셋별로 돌려 편차를 표로 노출 |
| R3 | **광학중심 ≠ 회전축**(나딜이 pan 에 따라 수 cm 이동) | 격자 위상 오차 | 5m 높이 기준 수 cm 는 열 피치 2.5m 의 ~1% → 허용. 명시만 |
| R4 | **프리셋 복귀 오차**(PTZ 반복정밀도) | 투영이 수~수십 px 밀림 | 상위 설계서 §7-4 대로 **범위 밖 선행과제**. 자동/파일 IoU 가 이를 노출 |
| R5 | 골든 해시가 부동소수 플랫폼 차이에 깨짐 | CI red | 해시 대상은 **반드시 `stringify5` 결과**(round5 후) |
| R6 | 자동 격자가 "그럴듯하게 틀린" ROI 를 승인 없이 밀어 넣음 | 조용한 데이터 파괴 | 승인 게이트(§6-1) + R-4 개수 일치 + R-5 빈 배열 거부 |

### 미확인 (구현자가 확인할 것)
1. `PlaceRoiPutSchema`(`captureRoutes.ts` 근처)가 `spaces: []` 를 허용하는가 → 허용하면 신규 라우트 쪽에서 `min(1)` 가드.
2. `data/Place01/PtzCamRoi.json` 의 preset 3 이 실제로 **다른 주차열**인지(리더 §9-6-4: 월드 방위 약 90° 차) — Loop 3-1 이 이걸 판정한다.
3. `packages/lens-calib` 의 `fovBaseV` 와 이 경로의 `fovBaseV` 가 **같은 정의·같은 왜곡 보정 상태**인지. 이번 L3 는 `poolFovBaseV` 역산값만 쓰므로 **의존하지 않지만**, 나중에 L2(무드로잉)로 갈 때 반드시 대조 필요.

### 범위 밖 (명시)
- 사선주차·불규칙 배치 — 격자 파라미터로 표현 불가 → **수동 드로잉 유지**.
- L0(노면 도색선)·L1(번호판) 부트스트랩 — 별건.
- `replaceSlotSetup` 의 센터링 컬럼 리셋 취약성 — 이번 변경이 노출 면적을 늘리지 않음.
- LLM 폴리곤 경로 개편.

---

## 9. 파일별 변경 계획 (구현자 인계)

| 파일 | 구분 | 내용 |
|---|---|---|
| `src/ground/groundFrame.ts` | **신규** | `GroundFrame`, `groundFrameOf`, `groundPointOf`, `groundCoordsOf` (~60줄) |
| `src/ground/groundGrid.ts` | **신규** | `GroundGrid`, `GridQuad`, `gridToPixelQuads`, `fitGridFromQuads`, `canonicalizeQuad` (~180줄) |
| `src/ground/groundBootstrap.ts` | **신규** | `CameraGroundConstants`, `bootstrapCameraConstants`, `buildAutoGroundModel` (~120줄) |
| `src/ground/gridStore.ts` | **신규** | `ground_grid.json` 읽기/쓰기(`stringify5`), 파일 부재 시 null (~60줄) |
| `src/api/groundGridRoutes.ts` | **신규** | 3개 라우트 (~180줄) |
| `src/api/server.ts` | 소폭 | 신규 라우트 등록 배선 |
| `src/config/toolsConfig.ts` | 소폭 | `store.groundGridFile` 추가(default 有 → 하위호환) |
| `web/index.html` | 소폭 | `#roi-auto` 토글 + `지면 격자` 패널 |
| `web/app.js` | 가산 | `state.autoRoi`, `drawAutoRoi(ctx)`(가산 레이어), 패널 핸들러 |
| `src/ground/groundModel.ts` | **변경 없음** | 재사용만 |
| `src/ground/project.ts` | **변경 없음** | `projectToPixel` 재사용 |
| `src/ground/types.ts` | **변경 없음** | `source:'auto'` 는 이미 타입에 있음 |
| `src/capture/floorRoi.ts` | **변경 없음** | R-3 |
| `src/capture/Finalizer.ts` | **변경 없음** | R-1 |
| `src/capture/SqliteStore.ts` | **변경 없음** | R-1 |
| `web/core.js` | **변경 없음** | 파리티 규약 보존 |

신규 테스트: `test/groundFrame.test.ts`, `test/groundGrid.test.ts`, `test/groundGridGolden.test.ts`, `test/groundBootstrap.test.ts`, `test/groundGridRoutes.test.ts`.

---

## 10. 리더에게 올리는 질문 (조용히 선택하지 않음)

- **Q1 (필수).** Loop 3 성공기준을 `crossPresetSimilarityChecks` 통과 → **§4-4 홀드아웃 대조**로 교체해도 되는가? 기존 기준은 자동 모델에 대해 항진명제라 검증력이 0이다.
- **Q2.** 정본 규칙 R-1(자동 격자는 PtzCamRoi.json 을 통해서만 DB 도달)을 확정해도 되는가? 대안은 `slot_setup` 직접 쓰기지만, `Finalizer` 의 전량 교체(`Finalizer.ts:300`)가 다음 finalize 에 반드시 지운다.
- **Q3.** 상위 설계서 §9(정본 충돌 기술)가 코드 실태와 다르다(§1-1). 문서화 단계에서 정정 노트를 남기면 되는가, 원문 수정까지 할 것인가?
