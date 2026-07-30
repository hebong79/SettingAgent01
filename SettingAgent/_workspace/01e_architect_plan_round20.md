# 20회차 설계 — 「현재 화면 그대로 검출」 모드 신설

- 작성: 2026-07-30 / 설계자
- 선행: `docs/20260729_215500_16-19회차_인계서_컨텍스트클리어용.md` §0-0 (정본) · `_workspace/00_leader_handoff.md` · `docs/20260729_175500_15회차_재개지시서_16회차착수전.md`
- 전임 계획: `01b`(round15) · `01c`(round16) · `01d`(round18) — 이 문서는 `01e`(round20)

---

## 0. 요약 — 이 라운드가 바꾸는 것

「검출」이 **카메라를 프리셋으로 이동시킨 뒤** 찍던 것을, **지금 보이는 화면 그대로** 찍게 한다.
그 결과 제원 공급원이 **프리셋별 fov 표 → 상수 2개 + 라이브 2개**로 바뀐다:

```
                 [종전 · preset 모드]                    [신규 · current 모드]
프레임 취득   preset.select / setPTZ(프리셋 PTZ)   →   cam.getPTZ 로 현재값 읽어 그 값으로 재설정(무이동)
화각          PtzCamRoi 프리셋별 fov(유효, 수직)   →   기준(줌1) 수평화각 × 현재 zoom
틸트          PtzCamRoi 프리셋 eulerAngles[0]      →   cam.getPTZ 의 tilt
설치고        현행 유지(공칭 5.0 + 자가보정)        →   현행 유지 (리더 결정 — 코드 0줄)
채점 정답     수동 정본 23면(프리셋 종속)          →   씬 정답을 **현재 PTZ 로 투영**(뷰 독립)
다시점 합의   6시점 디더(카메라 이동)              →   **강제 OFF**(§6)
```

**최소 변경 원칙**: `f` 경로는 **선택적 필드 1개 + 함수 1개**로 끝난다(기존 호출자 20곳 시그니처 무변경).
`sceneTruth.ts` · `bayGrid.ts` · `bayGeometry.ts` · `floorPaint.ts` 는 **1줄도 건드리지 않는다**.

---

## 1. 변경 파일 목록

### 신규

| 파일 | 무엇을 | 왜 |
|---|---|---|
| `src/tools/roiAutoCurrentView.ts` | 라이브 13020 에 `roi.auto.detect{view:"current"}` 를 쏘고, 응답의 `ptzUsed` 로 **씬 정답을 투영**해 재현율·정밀도·IoU 를 낸다. Unity 13110 은 **읽기만**(`cam.list`·`preset.list`) | 채점을 서비스 안에 넣지 않기 위해서다(§3-D). 검출 파이프라인을 **재구현하지 않고** 서비스가 실제로 낸 산출물을 채점하므로 도구↔서비스 괴리(11회차 U11 재발)가 원리적으로 불가능 |
| `test/roiAutoCurrentView.test.ts` | `focalPxAtZoom` 5프리셋 검산표 · `baseFocalPxOf` 파생 · 현재뷰 스키마·강등 경로 | §8 |

### 수정

| 파일 | 무엇을 | 왜 |
|---|---|---|
| `src/ground/cameraIntrinsics.ts` | `PresetIntrinsics.fovAtZoom?: 'zoom1'` 추가 + `focalPxAtZoom(i, zoom)` 신설 + `groundModelFromIntrinsics` 가 그것을 호출 | **결함 위치**(`:70` 이 `zoom` 을 받아만 두고 f 에 안 씀)의 근본 수정. 옵트인이라 기존 20개 호출자 무영향 |
| `src/ground/placeMetaIntrinsics.ts` | `baseFocalPxOf(meta, camIdx)` 신설 — 카메라의 **줌1 초점거리**를 프리셋 메타에서 파생 + 프리셋 간 산포 보고 | 시뮬 현재뷰에서 기준화각을 UI 없이도 세우기 위해. `fov` 는 이미 확정된 "카메라 사실"(F5)이고 주차면 필드는 이 모듈에 **타입상 존재하지 않는다**(R1 유지) |
| `src/rpc/services/roiAuto.ts` | ① `view` 파라미터 ② `cameraSpec.baseHfovDeg` ③ 현재뷰 해석기 ④ 무이동 캡처 ⑤ 현재뷰 consensus 강제 OFF ⑥ 응답에 `ptzUsed`·`candidateId`·`rows`(현재뷰 한정) | 본체 |
| `web/index.html` | 「현재 화면 그대로」 체크박스(기본 **checked**) · 수평화각 라벨/placeholder/tooltip 재정의 | 마스터 지시 |
| `web/app.js` | `view` 전송 · `apCameraSpec` 의 화각 필드 분기 · ETA 문구 | 위와 짝 |
| `web/autoPaint.js` + `web/autoPaint.d.ts` | `rows` 를 뷰에 실어 `autoQuadItems` 가 합집합을 그린다(rows 없으면 종전 그대로) | 「리스트」 단계의 화면 표현 |

### 무접촉 (명시)

`src/ground/{sceneTruth,bayGrid,bayGeometry,floorPaint,roiAutoScore,roiAutoRecall,project,autoRoiPlan}.ts` ·
`src/viewer/**` · `src/clients/**` · `packages/lens-calib/**` · `data/Place01/PtzCamRoi.json`(정본) · DB · `config/**`

> `src/clients` 무접촉이 성립하는 근거: `ICameraClient.getPtz`(`CameraClient.ts:47`)와 `CameraSourceClient.getPtz`(`:68`)가 **이미 있다**. 새 클라이언트 메서드가 필요 없다.

---

## 2. `f` 경로 설계

### 2-1. 결론 — 대체가 아니라 **옵트인 병행**. 기본은 종전(유효 화각).

`focalPxOf(fovDeg)` 를 전역으로 `×zoom` 하게 바꾸면 **실카가 깨진다**: 실카 경로는
`interpolateHfov(zoomHfov, zoomRaw)` 가 이미 **그 줌에서의 유효 화각**을 준다(`roiAuto.ts:329`).
거기에 다시 `×zoom` 을 곱하면 17회차에 고친 ×4.64 오류를 종류만 바꿔 재발시킨다.
따라서 **"이 화각이 줌1 기준인가"를 값 자신이 들고 다니게** 한다.

### 2-2. 자료형 — `PresetIntrinsics` 확장 (새 타입 두지 않음)

새 타입을 두면 `CameraIntrinsicsProvider` · `chainProviders` · `staticProvider` · `withSpec` · 도구 9종이
전부 갈라진다. 선택 필드 1개면 **전부 그대로**다.

```ts
export interface PresetIntrinsics {
  camIdx: number; presetIdx: number;
  fovDeg: number;
  fovAxis: 'vertical' | 'horizontal';
  tiltDeg: number; heightM: number; imgW: number; imgH: number;
  source: string;

  /**
   * ★ 20회차 — `fovDeg` 가 **어느 줌에서의 화각인가**.
   *   생략(undefined) = 그 프레임의 **유효 화각**(종전 전부 이 뜻. 실카 zoomHfov 표가 이쪽).
   *   'zoom1'        = **줌 1 기준** 화각. 유효 f 는 `f@zoom1 × zoom`.
   * 근거: 시뮬 5프리셋 전수 f÷zoom = 1731.8~1732.0(편차 0.1px 안), f@zoom1 1731.89px ↔ HFOV 58.0000°(오차 4e-6도).
   */
  fovAtZoom?: 'zoom1';
}
```

### 2-3. 함수 — 신설 1개, 시그니처 변경 0개

```ts
/**
 * 이 프레임의 유효 초점거리(px). `fovAtZoom==='zoom1'` 일 때만 zoom 을 곱한다.
 * zoom 이 유한 양수가 아니면 **null**(1 로 대체하지 않는다 — 조용한 1.8배 오류의 원인이었다).
 */
export function focalPxAtZoom(i: PresetIntrinsics, zoom: number): number | null {
  const f0 = focalPxOf(i);
  if (f0 == null) return null;
  if (i.fovAtZoom !== 'zoom1') return f0;
  if (!Number.isFinite(zoom) || !(zoom > 0)) return null;
  const f = f0 * zoom;
  return Number.isFinite(f) && f > 0 ? f : null;
}
```

`groundModelFromIntrinsics(i, zoom)` 은 **시그니처를 바꾸지 않는다**. 본문 1줄만:

```diff
- const f = focalPxOf(i);
+ const f = focalPxAtZoom(i, zoom);
```

그리고 `issues` 문구에 기준을 밝힌다 — `fovAtZoom==='zoom1'` 이면
`(기준화각 58.000° horizontal @zoom1 × zoom 1.6934 → f 2932.8px, tilt …)`.

### 2-4. 호출자 전수 조사 (`groundModelFromIntrinsics` 20곳 · `focalPxOf` 6곳)

| 호출자 | 넘기는 intrinsics 출처 | `fovAtZoom` | 영향 |
|---|---|---|---|
| `src/ground/bayGrid.ts:15` (import 만, 지상고 자가보정 재구성) | 호출자가 준 것 복사 | 상속 | **무변화**(복사본에 필드가 따라간다) |
| `src/rpc/services/roiAuto.ts:676` | `resolverFor` | preset 모드=미설정 / current 모드=`'zoom1'` | 설계 대상 |
| `src/ground/placeMetaIntrinsics.ts:117` (`placeMetaProvider`) | 프리셋별 `fov`(유효) | **미설정** | **무변화** |
| `roiAuto.ts:337-350` 실카 인라인 provider | `interpolateHfov`(유효) | **미설정** | **무변화** ★ 이게 §2-1 의 이유 |
| `src/tools/{roiAutoFuse,roiAutoConsensus,roiAutoLopo,roiAutoBench,roiAutoNoise,roiAutoOverlay,roiAutoRecall,roiAutoResidual,roiAutoRowsOverlay,roiAutoRowsDiag,roiAutoRowWhy,roiAutoStripe,realFrameOverlay}.ts` (13종) | 전부 `placeMetaProvider` 또는 `interpolateHfov` | **미설정** | **무변화** |
| `test/cameraIntrinsics.test.ts`(9곳) · `test/bayGridExtent.test.ts:123` | 리터럴 `SIM` | **미설정** | **무변화** |

→ **기존 성적표(재현율 0.5854 / 정밀도 0.8571 / IoU 0.88860)를 내는 경로는 한 바이트도 안 지난다.**
구현자는 이 표를 `grep` 으로 재확인하고, 누락 호출자가 나오면 보고할 것.

### 2-5. 기준 초점거리를 어디서 얻는가

| 소스 | 우선순위 1 | 우선순위 2 | 없으면 |
|---|---|---|---|
| 시뮬 계열(`sim`·`rpc`·미상) | `cameraSpec.baseHfovDeg`(UI 입력) | `baseFocalPxOf(placeMeta, camIdx)` — 프리셋 메타에서 **파생** | 거부(`INTRINSICS_MISSING`) |
| 실카(`hucoms`) | — (**적용 안 함**) | `zoomHfov` 실측표 = 이미 유효 화각 | 종전 거부 규약 그대로 |

`baseFocalPxOf` — 새 순수 함수(`placeMetaIntrinsics.ts`, ~25줄):

```ts
/** 카메라의 **줌1 초점거리**(px)를 프리셋 메타에서 파생. `fov` 는 수직이므로 imgH 를 쓴다. */
export function baseFocalPxOf(meta: PlaceMeta, camIdx: number): {
  fBasePx: number;      // 대표값 = presetIdx 최소인 유효 프리셋 (결정론)
  from: string;         // "preset1 fov 20.86546°(vertical) ÷ zoom 1.6934"
  samples: Array<{ presetIdx: number; fBasePx: number }>;
  spreadPx: number;     // max-min. 규칙이 실제로 상수인지 **화면에 보이게** 한다
} | null;
```

- 대표값은 **평균·중앙값이 아니라 최소 presetIdx 표본**이다 — 통계로 뭉개면 표본 하나가 이상해도 안 보인다.
- `spreadPx` 는 `issues` 에 항상 싣는다. 리더가 검산한 0.2px(1731.8~1732.0)을 **매 실행마다 재확인**하는 셈이다.
- `spreadPx > 5px` 이면 `⚠` 접두 경고(“`f = f@zoom1 × zoom` 규칙이 이 카메라에서 성립하지 않는다”). **거부는 아니다** — 임계값 5px 의 근거는 없으므로 판단을 사람에게 넘긴다.

---

## 3. 현재뷰 모드의 데이터 흐름

### 3-A. RPC 계약 (추가분만)

```ts
// BaseSchema 에 추가
view: z.enum(['preset', 'current']).default('preset'),

// SourceFields.cameraSpec 에 추가
baseHfovDeg: z.number().positive().max(179).optional(),   // 기준(줌1) 수평화각
```

**`default('preset')` 로 두는 이유(설계 판단 — 리더 확인 요망)**
마스터 지시는 "신규가 기본"이다. 그런데 **와이어 기본값**을 `current` 로 하면 `view` 를 안 보내는
기존 테스트·도구·`realCamCapture.ts:245` 가 전부 동작이 바뀌어 3661 green 이 흔들린다.
→ **와이어 기본 = `preset`(하위호환 100%), 사용자에게 보이는 기본 = `current`**
(뷰어 체크박스가 기본 checked 라 「검출」 버튼은 **항상 `view:"current"` 를 명시 전송**한다).
마스터가 보는 「검출」 버튼은 지시대로 신규가 기본이고, 회귀는 0 이다. 뒤집으려면 스키마 1줄이다.

### 3-B. 단계별 책임 모듈

```
① 파라미터 해석            roiAuto.ts  RoiAutoDetectSchema.parse
       view:'current'
       ↓
② 소스 확정                roiAuto.ts  resolveFrameSource(ctx, source)      [기존 함수 재사용]
       ↓ FrameSource{id,kind,camera,src}
③ 대상 1건 합성            roiAuto.ts  currentTargetOf(camId, presetIdx)    [신규 ~8줄]
       key = `${camId}:current` · manual = []  ← ★ 정본을 전혀 읽지 않는다
       ↓                                          (실카에 프리셋이 없어도 성립하는 이유)
④ 현재 PTZ 읽기            fs.camera.getPtz(camId)   → ICameraClient(기존)
       실패 시 → 강등 응답 gradeReason:'CURRENT_PTZ_UNAVAILABLE'(검출 미수행, 프레임도 안 찍는다)
       ↓ ptzNow{pan,tilt,zoom}
⑤ 무이동 캡처              roiAuto.ts  grabFrame(…, ptzOverride = ptzNow)
       requestImage(cam, preset, ptzNow) → mode:'manual' → cam.setPTZ(**같은 값**) → captureJPG
       ★ preset.select 를 거치지 않는다 = 프리셋 이동 소멸
       ↓ frame · frameHash · greenRatio · zoom(=ptzNow.zoom echo)
⑥ 제원 구성                roiAuto.ts  currentViewResolver(...)             [신규 ~45줄]
       시뮬: { fovDeg: baseHfov, fovAxis:'horizontal', fovAtZoom:'zoom1',
               tiltDeg: ptzNow.tilt, heightM: 현행규칙, imgW, imgH }
       실카: 종전 resolverFor 의 hucoms 분기 그대로(유효 화각 · tiltRaw/100)
       ↓ PresetIntrinsics
⑦ 지면모델                 cameraIntrinsics.groundModelFromIntrinsics(i, zoom)
       f = focalPxAtZoom(i, zoom) = 1731.89 × zoom            ← §2-3
       ↓ GroundModel
⑧ 검출                     floorPaint → bayGrid.detectBaysWithModel        [무변경]
       ↓ GridDetection{ best, rows[], tried }
⑨ 응답                     roiAuto.ts  detectView + currentViewExtras
       ptzUsed · rows[] · candidateId
       ↓
⑩ 채점(별도 실행)          src/tools/roiAutoCurrentView.ts                  [신규]
       ptzUsed + cam.list(camPos) + preset.list(씬 제원)
       → sceneTruth.projectTruth / visibleTruth  → roiAutoRecall.scoreDetection
```

### 3-C. ④⑤ 무이동 캡처가 안전한 근거

`CameraSourceClient.requestImage`(`:38`)는 `ptz` 를 **주면 manual**, **안 주면 preset**으로 간다.
그리고 `RpcCameraSource.snapshot`(`:69`)의 preset 분기는 `preset.select` 를 **실제로 호출한다** —
즉 "ptz 를 안 넘기면 안 움직인다"는 **거짓**이다(시뮬 한정. 이 함정을 계획서에 박아둔다).

→ 현재 PTZ 를 **읽어서 그대로 되쓰는** manual 경로를 쓴다. 이 패턴은 이미 실측 검증됐다:
06:33 실카 캡처 작업이 `mode=manual + 현재 PTZ` 로 돌면서 **전후 PTZ 동일**을 실측했다(인계서 §1).
새 클라이언트 코드 0줄이고, ④에서 어차피 tilt·zoom 이 필요하므로 추가 왕복도 없다.

### 3-D. 채점을 서비스에 넣지 않는 이유

1. `sceneTruth.ts` 는 **채점 전용 정적 봉인**이고 `test/roiAutoHoldout.test.ts` 가 `floorPaint`·`bayGeometry`·`bayGrid`·`cameraIntrinsics`·`placeMetaIntrinsics` 의 참조를 **문자열로도** 막는다. 검출과 채점이 같은 파일에 있는 `roiAuto.ts` 에 넣으면 그 경계가 사람 약속으로 강등된다.
2. 씬 정답은 `preset.list` 유래 = **시뮬 전용**이다. 실카에서는 원리적으로 없다(R10). 서비스 RPC 로 노출하면 실카에서 "왜 안 되냐"가 반복된다.
3. 도구가 **서비스 응답을 채점**하므로 U11(도구가 구 경로를 렌더) 유형의 괴리가 구조적으로 불가능하다.

### 3-E. ★ 채점의 알려진 한계 (숨기지 말 것)

씬 정답을 임의 PTZ 로 투영하려면 **그 뷰의 f 가 필요**한데, 그 f 는 검출이 쓰는 것과 **같은 규칙**
(`1731.89 × zoom`)에서 온다. 즉 **정답과 검출이 f 오차를 공유**한다 — 완전 독립 채점이 아니다.

이 라운드에서 할 수 있는 봉합은 둘:
- **V2 앵커 검산**(§7): 프리셋 5곳에서는 독립 정답(`PtzCamRoi` 프리셋 `fov`)이 있으므로 그 5점에서 규칙을 못 박는다.
- **줌 범위 경고**: 현재 zoom 이 검산 구간 **[1.0000, 1.8064]** 밖이면 응답에 `⚠ 외삽` 을 싣는다.
  그 밖에서의 f 정확도는 **미측정**이다. 추정하지 않는다.

---

## 4. 「찾고 → 리스트 → 선택」 3단계 인터페이스

| 단계 | 이번 라운드 | 계약 |
|---|---|---|
| **① 찾고** | **구현** | `roi.auto.detect { camId, view:"current", source, expectedBays?, cameraSpec? }` |
| **② 리스트** | **구현**(최소선 달성) | 응답의 `rows[].quads[]` — 각 quad 에 `candidateId` |
| **③ 선택(번호 배정)** | **미구현**(다음 라운드) — 계약만 확정 | 아래 |

### 응답 추가분 (현재뷰에서만 붙는다 — preset 모드 응답은 바이트 동일)

```ts
{
  view: 'current',
  ptzUsed: { pan, tilt, zoom },          // round5. 채점 도구·재현의 유일한 입력
  intrinsics: { source, focalPx, fBasePx, fovAtZoom: 'zoom1' },
  rows: [{
    rowIndex: 0,                          // grid.rows 순서(점수 내림차순 — bayGrid 규약 그대로)
    paintScore: 0.98123,
    quads: [{
      candidateId: `${frameHash}#${rowIndex}.${latticeIndex}`,
      latticeIndex: 3,
      quadNorm: [{x,y},{x,y},{x,y},{x,y}],
    }],
  }],
  quads: [ … ],                           // = best 행. 종전 키 그대로 유지(뷰어 하위호환)
}
```

**`candidateId` 를 `frameHash#row.lattice` 로 두는 이유**: 순수 인덱스는 다음 검출에서 **말없이 다른 면**을
가리킨다. 프레임 지문을 접두로 두면 ③에서 "그때 그 프레임의 그 후보"임이 **검증 가능**해지고,
프레임이 바뀌었으면 서버가 거절할 수 있다(F13 과 같은 규율).

### ③ 선택 단계 계약 (이번 라운드 **코드 없음** · 문서로만 확정)

```
roi.auto.assign {
  camId, frameHash,                       // 이 프레임에서 고른 것임을 서버가 검증
  assignments: [{ candidateId, slotIdx }], // slotIdx = 전역 1-based 주차면 번호
  confirm: true,                           // 정본 쓰기이므로 confirm 필수(R6)
} -> { applied, backupFile }
```
- 정본 쓰기 경로이므로 **마스터 별도 승인 전까지 라우트 등록 금지**(`roi.auto.apply` 와 같은 취급).
- 이번 라운드가 보장할 것은 하나: **`candidateId` 만 있으면 ③을 나중에 붙일 수 있다.**

---

## 5. UI 「카메라 제원」 의미 재정의

| 항목 | 종전 | 신규 |
|---|---|---|
| 라벨 | `수평화각` | `기준 수평화각(줌1)` |
| placeholder | `도` | `줌1 기준 · 예 58` |
| tooltip | "비우면 실카는 zoomHfov 표를 보간" | "**줌 1 일 때의** 수평화각(도). 유효 화각이 아니다 — 서버가 현재 줌을 곱한다(`f = f@zoom1 × zoom`). 비우면 시뮬은 프리셋 메타에서 파생하고, 실카는 zoomHfov 실측표를 현재 줌으로 보간한다" |
| 전송 필드 | `cameraSpec.hfovDeg` | 시뮬 계열 → `cameraSpec.baseHfovDeg` / 실카 → `cameraSpec.hfovDeg`(종전 그대로) |

**실카만 `hfovDeg` 로 보내는 이유**: 실카의 `zoomHfov` 실측표는 이미 **유효 화각**이다.
뷰어 `zoom`(1~36)과 실카 광학 배율의 관계는 **미측정**이므로 실카에 `×zoom` 을 적용할 근거가 없다.
UI 는 `selectedSourceIsReal()`(기존 함수)로 갈라 보내고, 라벨도 같이 바꾼다(실카일 때 `수평화각(유효)`).
서버가 조용히 재해석하지 않게 하는 것이 핵심이다 — **`baseHfovDeg` 가 hucoms 소스로 오면 명시적 거부**.

**이것이 §0-1 함정의 근본 해결이다**: 마스터가 58 을 넣으면 이제 `2:1` 에서 `58° @zoom1 × 1.8064 → f 3128.5px`
로 **맞는 값**이 나온다(종전엔 1731.9 로 고정되어 1.81배 오류 → IoU 0.3354).
preset 모드에서도 같은 규칙이 적용되므로 "카메라 제원 3칸을 비워라"는 회피책이 **불필요해진다**.

**추가 컨트롤** (`web/index.html` 툴바 1줄):
```html
<label title="카메라를 프리셋으로 이동시키지 않고 지금 보이는 화면 그대로 검출한다.
              끄면 종전대로 프리셋 위치로 이동한 뒤 찍는다(회귀 비교용).
              실카에는 프리셋이 없으므로 켜야 한다.">
  <input id="ap-currentview" type="checkbox" checked /> 현재 화면 그대로
</label>
```

---

## 6. 다시점 합의 처리 — **현재뷰에서 강제 OFF** (복귀 없음)

`consensusFor(fs, p)` 를 `p.consensus && fs.kind !== 'hucoms' && p.view !== 'current'` 로 확장(1줄).
`p.consensus:true` 가 와도 무시하고, **무시했다는 사실을 `issues` 에 남긴다**.

근거 4개:

1. **요구의 직접 위반.** 디더는 `cam.setPTZ` 로 pan±1.5°/tilt±0.8° 를 흔든다. "지금 보이는 화면 그대로"를
   지시받은 기능이 사용자가 손으로 맞춘 화면을 6번 흔드는 것은 모순이다.
2. **"흔든 뒤 복귀"는 안전하지 않다.** `detectConsensus`(`roiAuto.ts:575`)는 시점 실패 시 `catch{ continue }`
   로 넘어간다 — 예외 경로에 복귀 보장이 없다. 게다가 마스터가 동시에 조작 중이면 복귀는 **틀린 위치로
   되돌리는** 행위가 된다. 복귀를 안전하게 만들려면 finally + 점유락이 필요한데 그건 이번 범위 밖이다.
3. **새 규칙이 아니라 기존 규칙의 확장이다.** `consensusFor` 는 이미 실카(`hucoms`)에서 같은 이유로
   ("PTZ 이동 명령을 보내지 않는다") consensus 를 끈다. 현재뷰는 그 조건을 **소스 종류에서 모드로** 넓힐 뿐이다.
4. **비용**: 70초 → 12초. 마스터가 화면을 맞추고 누르는 대화형 조작에 70초는 쓸 수 없다.

**알려진 손실(기록)**: `2:2` 유형의 임계 프리셋 구제(U13 — 기저 0.0000 → pan−1.5° 0.9440)를 잃는다.
현재뷰에서 그런 프리셋을 만나면 **마스터가 화면을 1~2도 돌려 다시 누르면 된다** — 사람이 하는
디더가 코드가 하는 디더보다 이 모드의 취지에 맞다. preset 모드는 그대로 남으므로 비교도 가능하다.

---

## 7. 검증 계획 (리더가 그대로 실행)

> **전제**: 13020 구동 · Unity 13110 구동 · `selectedCameraId = simulator-1`.
> 모든 IoU 보고에 **frameHash 병기**(F13). `toFixed` 로 동일 판정 금지 — 무회귀는 **원시 배정도**로.

### V1 — ★ 카메라가 움직이지 않는가 (이 라운드의 핵심 성공기준)

```bash
# ① 검출 전 PTZ (Unity 직결, 읽기 전용)
curl -s -X POST http://localhost:13110/rpc -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"cam.getPTZ","params":{"camId":1}}' > /tmp/ptz_before.json
# ② 현재 화면 그대로 검출
curl -s -X POST http://localhost:13020/rpc -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"roi.auto.detect","params":{"camId":1,"view":"current","source":"simulator-1","expectedBays":8}}' > /tmp/det.json
# ③ 검출 후 PTZ
curl -s -X POST http://localhost:13110/rpc -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"cam.getPTZ","params":{"camId":1}}' > /tmp/ptz_after.json
diff /tmp/ptz_before.json /tmp/ptz_after.json && echo "PASS: PTZ 무이동"
```
**성공** = `diff` 무출력(원시 배정도 동일) · **실패** = 한 축이라도 다르다.
대조군: 같은 명령에서 `"view":"preset"` 으로 하면 **달라져야 한다**(달라지지 않으면 preset 모드가 이미 안 움직이고 있다는 뜻 → 전제 재검토).

### V2 — `f = 1731.89 × zoom` 규칙 앵커 검산 (5프리셋)

```bash
for P in 1 2 3; do  # cam1
  curl -s -X POST http://localhost:13020/rpc -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"roi.auto.detect\",\"params\":{\"camId\":1,\"presetIdx\":$P,\"view\":\"preset\",\"source\":\"simulator-1\",\"consensus\":false}}" \
  | python -c "import sys,json;r=json.load(sys.stdin)['result']['presets'][0];print(r['key'],r['frameHash'],r['intrinsics'])"
done   # cam2 는 presetIdx 1,2 로 반복
# 그 위치에서 이동 없이 현재뷰로 재측정
#   → intrinsics.focalPx(current) vs focalPx(preset) 차이가 ±0.5px 이내여야 한다
```
**성공 기준(전 5프리셋)**: `|focalPx_current − focalPx_preset| ≤ 0.5px`
그리고 `focalPx_current ≈ 1731.89 × ptzUsed.zoom` (±0.5px).
**동시에 확인할 것**: `ptzUsed.tilt` 가 인계서 표(1:1=8.70 / 1:2=20.10 / 1:3=35.80 / 2:1=10.00 / 2:2=17.00)와 일치.
**실패하면** 뷰어 PTZ 단위 ≠ Unity euler 단위라는 뜻이고, 그 경우 §9 M2 로 되돌아간다.

### V3 — 임의 뷰 채점 (씬 정답 투영)

```bash
cd SettingAgent
npx tsx src/tools/roiAutoCurrentView.ts 1        # camId. 현재 PTZ 그대로 1회 검출 + 채점
```
출력 필수 항목: `frameHash` · `ptzUsed` · `씬 가시 N면` · `재현율` · `정밀도` · `매칭 IoU` · `줌 외삽 여부`.
**이 라운드에는 절대 목표를 걸지 않는다** — 자(분모)가 프리셋 종속에서 임의뷰로 또 바뀌었으므로
19회차 숫자와 **직접 비교 불가**다. 이번에 확정할 것은 "임의 뷰에서 채점이 성립한다"까지.
단, 프리셋 위치에 세워두고 실행하면 **19회차 수치와 비교 가능**해야 한다 → 그것이 V4.

### V4 — 무회귀 (깨뜨리면 반려)

```bash
cd SettingAgent
npx tsc --noEmit                       # exit 0
npx vitest run                         # 287파일 3661 green (신규 테스트만큼 증가는 허용)
npx tsx src/tools/roiAutoRecall.ts v1 evidence rows   # 골든 v1 · d0
```
**골든 기준선(원시 배정도로 대조)**: 재현율 `0.5854`(24/41) · 정밀도 `0.8571`(24/28) · 매칭 IoU `0.88860`
프레임 해시: 1:1 `6006a034bfe2` / 1:2 `ceaaed722663` / 1:3 `3c0db12efe75` / 2:1 `e33628e921c2` / 2:2 `0cf4fda4d3aa`
→ 골든은 파일 프레임이라 해시가 바뀌면 **픽스처가 오염된 것**이다. 수치 대조 전에 해시부터 본다.

라이브 preset 모드 무회귀:
```bash
curl -s -X POST http://localhost:13020/rpc -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"roi.auto.score","params":{"camId":1,"presetIdx":1,"consensus":false}}'
```
`view` 미지정 = `preset` 이므로 응답 JSON 이 종전 키 집합과 **완전 동일**해야 한다(새 키 `view`·`ptzUsed`·`rows` 가 **붙으면 안 된다**).

### V5 — 정본·DB 무접촉 증명

```bash
cd SettingAgent
git status --short data/ && ls -l --time-style=full-iso data/Place01/PtzCamRoi.json
md5sum data/Place01/PtzCamRoi.json data/setting.sqlite 2>/dev/null
```
전 실험 전후 md5 동일. `roi.auto.apply` 호출 **0회** 유지. `roi.create2d` 호출 **0회**.

---

## 8. 유닛 테스트 계획 (CLAUDE.md 규칙 2)

| # | 대상 | 검증 |
|---|---|---|
| T1 | `focalPxAtZoom` | `fovAtZoom` 미설정 → `focalPxOf` 와 **완전 동일**(회귀 봉인) |
| T2 | `focalPxAtZoom` | `fovAtZoom:'zoom1'` · 58° horizontal · imgW 1920 → zoom 1.6934/1.5799/1.0/1.8064 에서 f = 2932.8/2736.2/1731.9/3128.5 (**±0.2px**, 인계서 5행 표 그대로) |
| T3 | `focalPxAtZoom` | zoom = 0 · −1 · NaN · Infinity → **null**(1 로 대체하지 않음) |
| T4 | `groundModelFromIntrinsics` | `fovAtZoom:'zoom1'` 일 때 `GroundModel.f` 가 `×zoom` 반영 + `issues` 에 "기준화각 … @zoom1 × zoom" 문구 |
| T5 | `baseFocalPxOf` | 실제 `PtzCamRoi.json` 로 cam1·cam2 → `fBasePx` 1731.9 ±1px, `spreadPx` ≤ 1px, 대표 표본이 **최소 presetIdx** |
| T6 | `baseFocalPxOf` | 프리셋 0개 / `zoom` 결측 / `fov` 결측 → **null**(0 이나 기본값 금지) |
| T7 | 현재뷰 스키마 | `view` 미지정 → `'preset'`. `roi.auto.score` 응답에 `view`·`ptzUsed`·`rows` 키가 **없음**(V4 의 유닛판) |
| T8 | 현재뷰 캡처 | 스텁 소스로 `view:'current'` 실행 → `getPtz` 1회 · `snapshot` 이 **`mode:'manual'` + getPtz 와 동일 값** · `preset.select` 호출 **0회** |
| T9 | 현재뷰 강등 | `getPtz` throw → `gradeReason:'CURRENT_PTZ_UNAVAILABLE'` · `requestImage` 호출 **0회**(프레임도 안 찍는다) |
| T10 | consensus | `view:'current' + consensus:true` → 디더 시점 촬영 **0회**, `issues` 에 무시 사유 기록 |
| T11 | `baseHfovDeg` × hucoms | 명시적 거부(조용한 재해석 없음) |
| T12 | `candidateId` | `frameHash#row.lattice` 형식 · 응답 안에서 **유일** |
| T13 | `autoQuadItems` | `rows` 없는 뷰(preset 응답) → 종전과 동일 목록 / `rows` 있는 뷰 → 합집합 |
| T14 | 봉인 유지 | `test/roiAutoHoldout.test.ts` · `test/roiAutoSeal.test.ts` 그대로 green (신규 코드가 `sceneTruth`·DB 심볼을 끌어오지 않음) |

---

## 9. 위험 · 미지수 (추정으로 메우지 않는다)

| # | 항목 | 상태 | 조치 |
|---|---|---|---|
| **M1** | **현재뷰의 `expectedBays` 기본값** | **미정.** `rowExtentMode:'evidence'` 에서도 `expectedBays` 는 `maxIndex = expectedBays + maxGap + 2`(`bayGeometry.ts:425`)와 `trimToSpan`·순위 분모(`bayGrid.ts:393`)를 통해 **산출에 영향**한다. preset 모드는 정본 면수를 썼는데 현재뷰엔 정본이 없다 | **구현자 실측**: `{4,6,8,10,12,16}` 스윕을 프리셋 5곳 현재뷰에서 돌려 재현율·정밀도 곡선을 내고 평탄역을 고른다. **그 전까지는 파라미터 필수**(미지정 시 명시적 오류 — 조용히 1 로 잘리던 17회차 함정 재발 금지) |
| **M2** | **뷰어 `tilt` 의 절대 의미** | 문서 근거는 일치(`camerapos` 1:1 tilt 8.7 = 인계서 표 8.70° = `eulerAngles[0]`)하나 **런타임 실측 없음** | V2 에서 5프리셋 전수 대조. 어긋나면 현재뷰 전체가 무효이므로 **V2 통과 전에 V3 로 넘어가지 마라** |
| **M3** | **뷰어 `zoom` 의 절대 의미** | 같은 이유로 미실측. `clampZoom`(config `zoomMin/zoomMax`)이 값을 바꿀 수 있다 | V2 에서 `ptzUsed.zoom` vs `PtzCamRoi` 프리셋 `zoom` 대조. `clampZoom` 이 물면 `issues` 에 명시 |
| **M4** | **`f = f@zoom1 × zoom` 의 검산 구간 밖** | zoom ∈ [1.0000, 1.8064] 에서만 검산됨. 그 밖은 **미측정** | 응답에 `⚠ 줌 외삽` 경고. 확장 검산은 별도 라운드 |
| **M5** | **채점의 f 상관오차**(§3-E) | 정답 투영과 검출이 같은 f 규칙을 공유 | 한계로 **명시 기록**. 앵커 5점(V2) 밖에서는 IoU 를 절대치로 해석하지 말 것 |
| **M6** | **실카 `RealPtzSource.snapshot({mode:'preset'})` 이 움직이는가** | **미확인.** `roiAuto.ts:474` 주석은 "안 움직인다"고 하나 소스 코드 확인 안 됨 | 구현자가 `src/viewer/RealPtzSource.ts` 를 읽고 확인. 어느 쪽이든 현재뷰는 manual 경로를 쓰므로 **설계는 안 바뀐다** — 사실만 기록 |
| **M7** | **`baseFocalPxOf` 의 `spreadPx` 경고 임계 5px** | **근거 없는 임의값** | 첫 실행의 실측 산포(리더 검산 0.2px)를 보고 구현자가 재조정 또는 경고 자체를 제거 제안 |
| **M8** | **시뮬 씬이 정지하지 않는다**(U17) | 기지 사실 | 현재뷰는 라이브 프레임이라 실행마다 IoU 가 흔들린다. **frameHash 병기 필수**. 재현 필요 시 preset 모드 + 골든으로 |
| **M9** | **`rows` 응답 크기** | 19회차 실측 33행×3.97quad = 131 quad → 정밀도 필터 후 28. 필터가 rows 단계 이전인지 이후인지 미확인 | 구현자가 `grid.rows` 가 **필터 후**인지 확인. 필터 전이면 응답이 수백 quad 로 부푼다 → 상한(예: 상위 20행)을 실측 후 결정 |

---

## 10. 반증목록 20건 대조 결과

`_workspace/00_leader_handoff.md` §4 및 `docs/20260729_143656_…14회차….md` §16 의 **20건 전수 대조**.

| # | 반증된 가설 | 이 계획에 포함? |
|---|---|---|
| 1 | 지상고 편차를 선택 1순위 정렬키로 | ✗ 선택 로직 무접촉 |
| 2 | `focalFromVPs` 로 f 추정 | ✗ **정반대다.** 이 계획은 f 를 제원에서 주입하는 경로를 **강화**한다(추정 안 함) |
| 3 | 더 긴 분리선 스텁 찾기 | ✗ |
| 4 | 격자를 카메라 쪽으로 확장 | ✗ |
| 5 | `phaseFitM` 가중치 상향 | ✗ 가중치 무접촉 |
| 6 | 슬롯 치수 2.525 | ✗ 2.5×5.0 유지(F7) |
| 7 | 도색지지 단독 적용 | ✗ |
| 8 | `farWeight` 상향 | ✗ |
| 9 | 거리 기반 하드 게이트 | ✗ |
| 10 | 커버리지 페널티 완화·제거 | ✗ |
| 11 | `maxHeightCorrection` 15→5% | ✗ 설치고 정책 **현행 유지**(리더 결정, 코드 0줄) |
| 12 | 재적합 반복 증가 | ✗ `bayGrid` 무접촉 |
| 13 | 감쇠계수 0.5 | ✗ |
| 14 | 표본 균등 가중 | ✗ |
| 15 | 스트라이프 모서리 규약 보정 | ✗ |
| 16 | 폭 비례 창 | ✗ |
| 17 | "도색이 3D 에서 비직선" | ✗ |
| 18 | JPEG 압축 인공물 | ✗ |
| 19 | P2 좌표 융합(중앙값) | ✗ 좌표 융합 없음 |
| 20 | "캡처 잡음 = 0" | ✗ **반대로 전제한다** — M8 에서 프레임 변동을 명시 위험으로 등재하고 frameHash 병기를 강제 |

**결론: 20건 중 재시도 항목 0건.** 이 라운드는 검출 알고리즘의 **파라미터·점수·기하 로직을 하나도 건드리지 않는다**.
바꾸는 것은 (a) 프레임을 **어디서** 찍는가, (b) `f` 를 **어떻게 세우는가**, (c) 채점 정답을 **어디에 투영하는가** 세 가지뿐이다.

### 금지 사항 준수 확인

| 금지 | 이 계획 |
|---|---|
| `roi.create2d` 호출 | **0건.** Unity 는 `cam.getPTZ`·`cam.list`·`preset.list`·`cam.captureJPG`·`cam.setPTZ`(현재값 되쓰기)·`roi.show2d{visible:false}` 만 |
| `roi.auto.apply` | **0건.** ③ 선택 단계는 라우트 등록조차 안 한다 |
| 정본 `PtzCamRoi.json` 쓰기 | **0건.** 현재뷰는 정본을 **읽지도 않는다**(카메라 메타 제외) |
| DB 쓰기 | **0건.** `roiAutoSeal.test.ts` 유지 |
| `toFixed` 동일 판정 | V1·V4 모두 **원시 배정도 diff** |
| 화각·틸트를 전 프리셋에 일괄 적용 | 현재뷰는 **프리셋 개념 자체가 없다.** 값은 전부 그 프레임의 라이브 PTZ 에서 온다 |
| `calibrateHeight:false` 단독 실험 | **없음.** 설치고 현행 유지 |
| `config/` 변경 | **없음** (재기동 불필요) |
| 미측정을 보간으로 채움 | M1·M2·M3·M4·M6·M7·M9 를 **"구현자 실측 필요"로 남김**. 값 지정 안 함 |

---

## 11. 구현 순서 (각 단계 검증 포함)

```
1. cameraIntrinsics.ts: fovAtZoom + focalPxAtZoom + 1줄 배선
   → 검증: T1~T4 green · npx vitest run 전량 green(무회귀) · npx tsc --noEmit 0

2. placeMetaIntrinsics.ts: baseFocalPxOf
   → 검증: T5·T6 green · 실제 PtzCamRoi 로 fBasePx 1731.9 ±1px, spreadPx 실측값 보고

3. roiAuto.ts: view 파라미터 + currentTargetOf + currentViewResolver + 무이동 캡처 + consensus OFF
   → 검증: T7~T11 green · **V1(PTZ 무이동 diff 무출력)** · V4 라이브 preset 응답 키 집합 동일

4. roiAuto.ts: ptzUsed / rows / candidateId 응답
   → 검증: T12 green · M9(rows 개수) 실측 보고

5. web/: 체크박스 + 라벨 재정의 + view 전송 + autoPaint rows
   → 검증: T13 green · 뷰어에서 「검출」 눌러 **화면이 안 움직이는 것을 눈으로** 확인(sharp 스샷 첨부)

6. src/tools/roiAutoCurrentView.ts
   → 검증: **V2(f 규칙 5프리셋 앵커)** → 통과해야만 → **V3(임의 뷰 채점)**

7. 전체 회귀
   → 검증: V4 · V5
```

**게이트**: 3단계 V1 이 실패하면 그 아래로 내려가지 마라. 4~7 은 전부 "안 움직인다"를 전제로 한 작업이다.

---

## 12. 리더에게 올리는 확인 요청

| # | 항목 | 설계자 권고 |
|---|---|---|
| 1 | **와이어 기본값 `view:'preset'` + UI 기본 `current`**(§3-A) — 마스터 문언은 "신규가 기본" | 권고안 채택. 회귀 0 이고 마스터가 보는 버튼은 지시대로다. 뒤집으려면 스키마 1줄 |
| 2 | **`rows` 를 응답에 싣는 범위**(§4) — 「리스트」의 최소선이 `best`(1행) 인가 `rows`(다행) 인가 | `rows` 권고. `best` 만이면 리스트에 뒷줄이 없어 "보이는 모든 주차면"과 모순된다. 현재뷰 한정이라 회귀 0 |
| 3 | **preset 모드에서도 UI 화각이 `baseHfovDeg` 로 바뀐다**(§5) — §0-1 근본 해결이지만 preset 모드의 수동입력 동작이 달라진다 | 채택 권고. 골든 기준선은 화각 칸이 **비어 있는** 상태라 §6 회귀 기준선에 영향 0 |
| 4 | **M1(expectedBays 기본값) 스윕**을 이번 라운드에 포함할지 | 포함 권고. 이게 없으면 현재뷰가 실사용에서 조용히 잘린다 |
| 5 | **③ 선택 단계**를 다음 라운드로 미루는 것 | 미루기 권고. 정본 쓰기 경로라 마스터 승인이 선행이고, `candidateId` 만 있으면 언제든 붙는다 |
