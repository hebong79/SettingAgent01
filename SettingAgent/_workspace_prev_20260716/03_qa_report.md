# 검증 보고 — det↔seg 정합 + 공유 육면체 산출기

작성: 2026-07-15 / 검증자
입력: `01_architect_plan.md` · `02_developer_changes.md` · 변경 소스 전량
방법: **뮤테이션 테스트**(고의 결함 주입 → 테스트가 잡는가) + 경계면 교차 + 회귀 재검증
재검증 범위: 리더가 확정한 J1(육안)·J2 대체·게이트는 **재검증하지 않았다**(지시대로).

**추신(2026-07-15, DEFECT 수정 재검증 완료)**: 아래 §3·§4 의 DEFECT-1·DEFECT-2 는 구현자(`dev-assoc`)가 수정했고, **내가 직접 재검증했다** — 원래 실증 테스트(§3 의 `segIdx` 확인 스크립트)를 고친 코드에 그대로 재실행 → 통과. MUTANT-2(`onPlaceFilter` 참조 보존 파괴)를 다시 주입 → 이번엔 **잡 경로(T6)와 검출 경로(신규 `detectCuboid.test.ts` 봉인) 둘 다** 잡는다(이전엔 검출 경로가 사각지대였다). 게이트 재실행: `tsc` exit 0 / **vitest 146파일 1590테스트 전량 통과**(독립 재확인). OBS-1(`unmatched[]` 불변식 복원)·OBS-2(`ctx=null` 헛촬영 제거, 기존 200 계약 유지 확인)도 코드로 확인. **최종 판정: 머지 가능. 결함 없음.**

> ## 3줄 요약 (최초 검증 시점 기록 — 아래 결함은 모두 수정·재검증됨)
> 1. **회귀 0 은 진짜다.** T6 는 공허하지 않다 — 고의 결함(육면체 on 일 때 점유 필터 우회)을 주입하니 `insertDetections` deep-equal 과 `aggregate()` 가 **둘 다 즉시 실패**했다. 무변경 보장 9개 파일 `git diff` **0줄** 확인.
> 2. **결함 1건 발견(중) → 수정 완료.** `assoc[].segIdx` 는 **seg 응답 원문 인덱스가 아니었다** — 마스크 drop 후 **압축 배열 위치**였다. 문서·주석이 약속한 "원본 되짚기 유일 키"가 `maskMismatch > 0` 일 때 **엉뚱한 차량**을 가리켰다. **이것은 `SegBox.vpdIdx` 가 존재하는 바로 그 이유(D-3)의 재발이었다.** 구현자가 출력 경계 1곳에서 `SegBox.vpdIdx` 로 되돌리는 수정을 적용, 재검증 통과.
> 3. **결함 1건(중하) → 수정 완료.** `keptDetIdx` 의 참조 동일성 전제가 깨지면 **조용히** 육면체 0개로 강등됐다(`.filter(i => i >= 0)` 가 위반을 숨겼다). "조용한 실패 금지" 위반이었다. 구현자가 `-1` 을 그대로 넘기고 `buildFrameCuboids` 한 곳에서 issues 로 드러내도록 수정, 검출 경로 사각지대도 신규 테스트로 봉인.

---

## 1. 게이트 — 독립 재실행

| 항목 | 구현자 보고 | **내 실측** | 판정 |
|---|---|---|---|
| `npx tsc --noEmit` | exit 0 | **exit 0** | ✅ |
| `npx vitest run` | 145파일 / 1581테스트 | **146파일 / 1584테스트 전량 통과**(2회 연속 동일 — flaky 0) | ✅ (보고 수치는 stale) |
| C3(`camera.fov`/`position`/`eulerAngles` 읽기) | — | **src 전역 0건** | ✅ |
| 무변경 보장 9종 | "0줄" | **`git diff` 출력 비어 있음 = 0줄** | ✅ |

무변경 확인 대상: `contact.ts` · `anchor.ts` · `project.ts` · `contactTypes.ts` · `VpdClient.ts` · `onPlaceFilter.ts` · `Aggregator.ts` · `SqliteStore.ts` · `packages/types`.

---

## 2. ★ 회귀 0 재검증 — **뮤테이션으로 공허성을 깼다**

"T6 가 통과하도록 짜여 있으면 의미 없다"는 지적에 따라, **고의 결함을 프로덕션 코드에 주입**해 T6 가 실제로 잡는지 봤다.

### MUTANT-1 — 육면체 on 일 때 점유 경로가 갈라진다
`CaptureJob.ts:346` 을 `const vehicles = this.deps.cuboidCtx ? raw : (필터 적용)` 으로 바꿨다
(= 육면체 기능이 켜지면 주차면 필터가 우회된다 — T6 가 막아야 할 바로 그 회귀).

```
× T6 > insertDetections 인자가 완전히 동일하다(deep equal)
  → expected [[1,1,1,[{…},…(2)]]] to deeply equal [[1,1,1,[{…},{…}]]]
× T6 > aggregate() 산출(점유의 실제 소비처)도 동일하다
  → expected [{presetKey:'1:1',…}, …(2)] to deeply equal […(1)]
× (외 4건 연쇄 실패)
```
→ **T6 는 공허하지 않다.** 점유 인자 동일성과 `aggregate()` 를 **둘 다** 잡는다. ✅

### MUTANT-2 — `keptDetIdx` 참조 동일성 전제 붕괴
`onPlaceFilter.ts:51` 을 `.filter(...).map(v => ({...v}))` 로 바꿨다(향후 리팩터가 복사를 끼워넣는 상황).

```
× T6 > insertDetections 인자 동일 … expected +0 to be 2   (summary.kept 가 0)
× T6 > keptDetIdx 는 참조 동일성으로 얻는다 … expected [] to deeply equal [0, 2]
```
→ 전제 붕괴는 **잡 경로에서는** 잡힌다 ✅. **그러나 → DEFECT-2 참조**(조용한 강등 + detect 경로 미봉인).

### MUTANT-3 — 정규화 누출(px 스케일 제거)
`frameCuboids.ts:195` 의 `px()` 에서 `* model.imgW/imgH` 를 뺐다.
→ **5개 파일 11개 테스트가 실패**(전용 감지선 `"정규화 누출 → 육면체 전멸"` 포함). ✅

**전제 A2 검증**: `filterVehiclesOnPlace` 는 `Array.filter`(강등 시 `[...vehicles]` 스프레드) — **둘 다 객체 참조 보존**. `VpdClient.detect()` 는 매 호출 새 객체를 생성하므로 중복 참조·재생성 경로 없음 → `raw.indexOf(v)` 는 정확하다. ✅ (전제 자체는 참. 문제는 **깨졌을 때의 거동** — DEFECT-2)

---

## 3. 🔴 DEFECT-1 (중) — `assoc[].segIdx` 는 seg 응답 원문 인덱스가 **아니다**

### 약속된 계약
- `frameCuboids.ts:45` — *"det↔seg 매핑(**원본 되짚기 유일 키**). `segIdx` 로 seg 응답의 `masks[segIdx]` 로 간다."*
- `cuboidTraceability.test.ts:17` — *"seg 응답의 `masks[]` 로 되짚는 키는 이제 별도로 `FrameCuboids.assoc[].segIdx` 다."* ← **Q5 갱신의 핵심 문장**

### 실제
`frameCuboids.ts:192` 는 `associateDetSeg(..., segBoxes.map(b => b.rect), ...)` 를 부른다. 여기서
`segBoxes = seg.boxes` 는 **VpdClient 가 마스크 없는 검출을 drop 한 뒤의 압축 배열**이다.
∴ `segIdx` 는 **압축 배열 위치**이지 원문 인덱스가 아니다.

### 실증 (프로덕션 `VpdClient` + `buildFrameCuboids` 직접 호출)
seg 원문 3대, **#0 의 마스크 퇴화 → drop**:
```
seg.maskMismatch = 1
seg.boxes.map(vpdIdx) = [1, 2]        ← 배열 위치 0,1 ↔ 원문 1,2 (어긋난다)

det#0(가운데 차) → assoc.segIdx = 0   ← 계약대로면 1 이어야 한다
                   masks[0] 은 **drop 된 왼쪽 차**다.
```
→ **`masks[assoc[].segIdx]` 로 되짚으면 엉뚱한 차량을 가리킨다.**

### 왜 중요한가
이것은 **`SegBox.vpdIdx` 라는 필드가 애초에 존재하는 이유(D-3)의 재발**이다.
`VpdClient.ts:124` 주석이 그대로 말한다 — *"여기서 drop 이 일어나므로 **배열 위치로는 되짚을 수 없다**"*.
새 경로는 그 해결책(`vpdIdx`)을 손에 쥔 채로 **쓰지 않고** 배열 위치를 내보낸다.
직전 커밋 `23b24d4` 가 봉인한 성질을, 그 봉인 파일의 헤더 주석이 **틀린 문장으로** 갱신했다.

> **Q5 판정**: `vpdIdx` → det 권위 인덱스 변경은 **정당하고 주석에 이유도 남았다** ✅.
> 그러나 **함께 도입한 `assoc[].segIdx` 계약이 거짓**이다 ❌.

### 수정안 (1줄 · 하위호환)
출력 경계에서만 원문 키로 되돌린다. 내부의 `p.segIdx` 사용처(`segByDet`·`occluderMasks`)는 `segBoxes` 를 인덱싱하므로 **그대로 두어야 한다**.
```ts
// frameCuboids.ts — return 문
assoc: a.pairs.map((p) => ({ ...p, segIdx: segBoxes[p.segIdx].vpdIdx })),
```
기존 단언은 전부 `maskMismatch = 0`(→ `vpdIdx === 배열위치`)이라 **깨지지 않는다.**
`maskMismatch > 0` 회귀 테스트를 함께 추가할 것(내가 쓴 실증 테스트를 그대로 쓰면 된다).

**대안**: `segIdx` 를 "압축 배열 위치"로 재정의하고 `segVpdIdx` 를 신설. 단 이 경우 **주석 2곳의 거짓 문장을 반드시 고쳐야** 한다(현재는 문서가 거짓).

---

## 4. 🔴 DEFECT-2 (중하) — `keptDetIdx` 붕괴가 **조용히** 강등된다

```ts
// CaptureJob.ts:382 · detectPipeline.ts:270
const keptDetIdx = vehicles.map((v) => raw.indexOf(v)).filter((i) => i >= 0);
//                                                     ^^^^^^^^^^^^^^^^^^^^^ 위반을 **숨긴다**
```
MUTANT-2 실측: 참조 보존이 깨지면 → `kept: 0` · `cuboids: []` · **`issues: []`**.
운영자는 **빈 오버레이를 보고 사유를 못 본다.** 이 팀의 "조용한 실패 금지" 규약 위반이다.

**권고**: `-1` 이 나오면 버리지 말고 사유를 남긴다.
```ts
const idx = vehicles.map((v) => raw.indexOf(v));
const missing = idx.filter((i) => i < 0).length;
// missing > 0 → issues.push(`keptDetIdx 해석 실패 ${missing}건 — 필터가 참조를 보존하지 않는다`) + logger.warn
```

**추가**: `detectPipeline.ts:270` 의 **같은 패턴은 어떤 테스트도 봉인하지 않는다** — MUTANT-2 에서 `detectCuboid.test.ts` 는 **초록으로 통과했다**. 잡 경로만 보호되고 검출 경로는 무방비다.

---

## 5. 강등 전수 — 각 경로가 잡을 죽이지 않는가

| 경로 | throw? | 카운터/issue | 판정 |
|---|---|---|---|
| `ctx: null`(지면모델·슬롯 없음) | ❌ | `issues:['지면모델/슬롯 없음…']` | ✅ |
| `canSegment() === false` | ❌ | `issues:['VPD seg 미배선…']` | ✅ |
| `slotPolysPx.length === 0` | ❌ | `issues:['슬롯 폴리곤 0개…']` | ✅ |
| seg **HTTP 500**(S-1, 검출 0대) | ❌ | `summary.segDegraded=true` · `segError` **없음** | ✅ **정상 강등과 하드 실패를 정확히 구분** |
| seg **호출 실패**(타임아웃·네트워크) | ❌ | `segError` **있음** + issue | ✅ |
| `maskMismatch > 0` | ❌ | `summary.maskMismatch` + issue | ✅ |
| 미정합 det | ❌ | `unmatched[]` + **사유 3분기** | ✅ |
| `minFrontSpanM` 기각 등 게이트 | ❌ | `rejected[]`(기존 12종) | ✅ |
| **잡 사망** | — | seg throw · ctx throw 둘 다 `state='done'` + 검출 정상 적재 | ✅ |

### `FrameCuboids.segError` 신설(설계에 없던 것) — 두 소비자 분기 검증
- **잡**: `segError` 를 **무시**하고 계속 돈다 → 라운드 완주·검출 적재 확인 ✅
- **라우트**: `if (fc.segError) reply.code(502)` → 기존 502 단언 유지 ✅
- **S-1(500)은 502 가 아니다**: `segDegraded` 로 갈려 200 유지 ✅

→ **분기 설계가 옳다.** 설계 이탈(§6-②)은 **정당하다** — `200 + 빈 배열`로 하드 실패를 숨기지 않는다.

---

## 6. 경계면 교차 — 정규화 vs 픽셀

```
VPD det/seg 응답        픽셀 정수
  ↓ VpdClient.normalizeBox / normalizeMask
NormalizedRect/Polygon  0~1          ← associateDetSeg 가 IoU 를 계산하는 좌표계(A1: det·seg 동일 기준 ✅)
  ↓ frameCuboids.px()  × model.imgW/imgH
SegVehicle.mask/bboxPx  **원본 픽셀** ← 지면모델은 여기서만 성립 ✅
  ↓ buildVehicleCuboids → contact.ts:580  ÷ g.imgW/imgH
VehicleCuboid.floorQuad 0~1(NormalizedQuad)
  ↓ 뷰어 projectCuboid  × g.imgW → 3D lift → ÷ g.imgW
  ↓ toPixelQuad(corners, overlay.width, overlay.height)
캔버스 픽셀 (캡처 해상도와 무관 — 스케일 독립 ✅)
```
- **MUTANT-3** 이 이 사슬을 봉인함을 실증(11테스트 실패). ✅
- **지면모델 동일성**: 잡(`index.ts`) · 라우트(`captureRoutes.ts`) · 뷰어(`/capture/ground-model`) **셋 다** `placeRoiFile` + `mapFiles.cameraposFile` + `ground` 로 `estimateGroundModels` 를 부른다 → **같은 f·imgW·d·n**. 산출 시점 모델과 렌더 시점 모델이 갈리지 않는다 ✅
- **키 형식**: 잡 `cuboidsByPreset` = `` `${camIdx}:${presetIdx}` `` / status 인덱스 동일 / 뷰어 `presetKey()` = `` `${camIdx}:${presetIdx}` `` → **일치** ✅
- `assoc[].segIdx` — ❌ **DEFECT-1** (위 §3)

---

## 7. Q1 교체 — `/capture/vehicle-cuboids`

**기존 계약 전부 유지** ✅ (`vehicleCuboidRoutes.test.ts` 단언 12건 무수정 통과):

| 상황 | 코드 | 확인 |
|---|---|---|
| `canSegment()=false` | 404 | ✅ |
| ground/placeRoi 미설정 | 404 | ✅ |
| cam/preset 비정수·0·음수 | 400 | ✅ |
| 카메라/VPD throw | 502 | ✅ |
| 지면모델 없는 프리셋 | **200 + cuboids:[] + issues** | ✅ |
| VPD 500(검출 0대) | 200 + `segDegraded` | ✅ |
| 정상 | 200 + 육면체 | ✅ |

**"두 개의 다른 진실" 소멸 확인** ✅ — 이전 라우트는 `withMask`(seg 응답)로 차량 목록을 만들었다. 이제 `vpd.detect()` 를 부르고 `detBoxes: det` 를 권위로 넘긴다. 세 표면(잡·검출·라우트)이 **같은 `buildFrameCuboids`** 를 부른다.

⚠️ **픽스처 주의(경미)**: `fakeVpd` 의 det 스텁이 **seg boxes 에서 파생**된다(`opts.seg.boxes.map(b => ({rect: b.rect, …}))`) → 항상 IoU=1. 이 파일이 보는 것은 **라우트 계약**이지 정합 품질이 아니고 구현자가 주석에 명시했으므로 **수용**한다(정합 품질은 녹화 픽스처가 본다). 단 **det≠seg 개수인 라우트 레벨 테스트는 없다.**

---

## 8. `/capture/job-cuboids` — 카메라·VPD 미호출

- **카메라 호출 카운터로 봉인**됨: 잡 1라운드 후 `calls=1`, 라우트 호출 후에도 **`calls=1` 유지** ✅
- 라우트 본문은 `deps.job.getCuboids(cam, preset)` **인메모리 읽기뿐** — VPD 참조 0 ✅
- 400(비정수) / 404(잡 미실행·기능 off) ✅
- **잡의 PTZ 를 뺏지 않는다.** ✅

---

## 9. 테스트 규약 준수

| 함정 | 판정 |
|---|---|
| 테스트가 프로덕션을 재구현 | ✅ 전 테스트·하네스가 `associateDetSeg`/`buildFrameCuboids`/`VpdClient`/`iou` 를 **import 해 호출**. `_qa_assoc_iou.ts` 에 로컬 IoU·매칭 구현 **0건**(grep 확인) |
| 픽스처가 검증 대상의 가정을 복사 | ✅ `test/fixtures/assoc/*.json` 은 **진짜 실서버 녹화**다 — float32 원시 confidence(`0.970576822757721`), 95~312점 불규칙 폴리곤, API 스키마 `success`/`id` 키, **det 와 seg 의 박스 순서가 실제로 다름**. 합성 아님 |
| IoU 로 정합 품질을 판정 | ✅ 안 한다. 독립 판정자(J1 육안 / J2a 교차프레임 / J2b 강제오배정 / J3 cls)로 판정. `assocRealFrames.test.ts` 의 음성대조는 **교차프레임**(순열 아님) |
| 회계 항등식 | ✅ `pairs + unmatchedDet = detN`, `pairs + unmatchedSeg = segN` 을 실데이터로 단언 |

---

## 10. 관찰(경미 — 결함 아님)

| # | 내용 |
|---|---|
| **OBS-1** | **`degraded()` 회계 불일치** — 실측: `summary.unmatchedDet = 2` 인데 `unmatched[] = []`. 정상 경로에서 성립하는 불변식 `unmatched.length === summary.unmatchedDet` 가 **4개 강등 경로에서 깨진다**. 사유는 `issues[]`/`segError` 로 드러나고 뷰어 배지가 그것을 렌더하므로 **조용한 실패는 아니다**. 단 불변식에 의존하는 소비자가 생기면 깨진다 |
| **OBS-2** | `/capture/vehicle-cuboids` 가 **ctx=null(지면모델 없음)일 때도 카메라를 찍고 det 를 돌린다**. 이전엔 모델 확인 후 조기 return(촬영 0). 계약은 유지(200+issues)되나 **헛촬영 1회 + det 1회** |
| **OBS-3** | **측정표(§5)가 ctx 해결 비용을 포함하지 않는다** — `buildMs` 는 ctx 해결 **후** 시작한다. 매 라운드·프리셋마다 `PtzCamRoi.json`+`camerapos.json` 재파싱 + `estimateGroundModels` 재실행(캐시 없음 — 의도된 설계). 라운드 간 30~80초 대비 무해하나, `segMs≈400 / buildMs 2~5` 를 **총 추가비용으로 읽으면 안 된다** |
| **OBS-4** | **뷰어 지면모델 캐시 staleness**(기존 문제, 이번 변경이 노출을 키움) — 뷰어는 `state.groundLoaded` 로 지면모델을 **세션 1회만** 로드한다. `refreshOnRun`이 `camerapos.json` 을 런타임에 다시 쓰면 잡의 ctx 모델은 갱신되고 뷰어 모델은 낡는다 → **새 f 로 계산된 육면체를 옛 f 로 투영.** 이번 변경 이전엔 육면체가 수동 1회 로드라 겹칠 일이 적었다 |

---

## 11. 🔴 검증하지 못한 것 (성공으로 위장하지 않는다)

1. **G1/G2 — 브라우저 DOM 배선.** `web/app.js` 는 유닛테스트가 **없다**. `#vcuboid-badge` id, `syncJobCuboids` 폴링 배선, `roi-vcuboid` 기본 on 은 **데이터 레벨(라우트 payload)까지만** 봉인됐다. id 오타 하나면 조용히 죽는다. → **리더 경험적 검증 필수.** (구현자도 동일하게 신고함)
2. **라이브 VPD 스모크 미수행.** 나는 **모킹 + 녹화 픽스처**만 돌렸다. 구현자의 라이브 실측(det/seg 지연, 3프레임 정합 수치)을 **독립 재실행하지 않았다**. 외부 서비스(`192.168.0.125:9081`) 미가동 전제.
3. **배치(X,Y) 정확도** — 지시대로 **손대지 않았다**(D-1: 정량 지표 원리적 부재).
4. **다중 카메라** — cam1 만. cam2+ 경로 미검증.
5. **status 폴링 ↔ job-cuboids 경합**(라운드 진행 중 전문 요청) — 유닛만. 라이브 미확인.

---

## 12. 판정 (최초 검증 시점)

| Goal | 판정 |
|---|---|
| 회귀 0(점유) | ✅ **확정** — 구조 + 뮤테이션 2종으로 이중 확인 |
| 강등 전수 throw 0 | ✅ **확정** |
| 경계면 정합(정규화↔픽셀) | ✅ **확정** — 단 `assoc[].segIdx` ❌ |
| Q1 계약 유지 + 두 진실 소멸 | ✅ **확정** |
| job-cuboids 카메라 미호출 | ✅ **확정** |
| C3 | ✅ **확정** |
| **추적성(원본 되짚기)** | ❌ **DEFECT-1 — 수정 필요** |
| **조용한 실패 금지** | ⚠️ **DEFECT-2 — 수정 권고** |

**결론(당시): DEFECT-1 수정 후 머지 가능.** DEFECT-2 는 같은 커밋에서 함께 고치는 것을 권고한다(둘 다 수 줄).
두 결함 모두 **점유 판정·기존 계약에는 무영향**이다 — 진단/추적성 표면의 정확성 문제다.

---

## 13. ★ 재검증 (2026-07-15, DEFECT-1·2 수정 후 — 최종)

구현자가 두 결함과 OBS-1·OBS-2 를 수정했다고 보고. **원래 실증 코드를 그대로 재사용**해 고친 프로덕션 코드에 재실행했다(추측 아님).

| 항목 | 재검증 방법 | 결과 |
|---|---|---|
| **게이트** | `tsc --noEmit` / `vitest run` 독립 재실행 | exit 0 / **146파일 1590테스트 전량 통과**(구현자 보고와 일치) |
| **DEFECT-1** | §3 의 실증 테스트(seg 3대 중 #0 마스크 퇴화 → drop)를 **고친 코드에 그대로 재실행** | `assoc[0].segIdx === 1`(원문 인덱스) — **수정 확인**. `frameCuboids.ts` diff 확인: 출력 경계 한 곳(`assoc: a.pairs.map(p => ({...p, segIdx: segBoxes[p.segIdx].vpdIdx}))`)만 바뀌었고 내부 `segByDet`·`occluderMasks` 는 압축 배열 인덱싱을 그대로 씀(제안한 수정 범위와 정확히 일치) |
| **DEFECT-2** | MUTANT-2(`onPlaceFilter` 참조 보존 파괴)를 **다시 주입**해 재확인 | 이번엔 **잡 경로(T6)와 검출 경로 양쪽 다** 실패로 잡힘 — 검출 경로 전용 신규 테스트(`detectCuboid.test.ts` "DEFECT-2 — 검출 경로의 참조 동일성 전제도 봉인한다(QA MUTANT-2 사각지대)")가 정확히 내가 지적한 사각지대를 메웠다. `CaptureJob.ts`·`detectPipeline.ts` diff 확인: 양쪽 다 `.filter((i) => i >= 0)` 제거, `-1` 을 그대로 전달 |
| OBS-1 | `frameCuboids.ts` diff 확인 | `degraded()` 가 `keptIdx.map(detIdx => ({detIdx, bestIou:0, reason}))` 로 `unmatched[]` 채움 — 불변식 복원 확인 |
| OBS-2 | `captureRoutes.ts` diff 확인 + 기존 "지면모델 없음→200+issues" 단언 재통과 확인 | `ctx===null` 이면 카메라 호출 전에 조기 return. 기존 12건 계약(404/400/502/200+issues) 안 깨짐 |

재검증 후 **stray 뮤테이션 코드 잔존 여부**: `grep -c MUTANT src/**/*.ts` 0건, `git status` 로 확인한 변경분은 구현자의 실제 수정과 정확히 일치(내 재검증 과정에서 만든 임시 파일은 전부 삭제·원복).

**최종 결론: 머지 가능. 결함 없음.** 회귀 0·강등 전수·경계면·추적성·조용한 실패 금지 전부 확정.
G1/G2(브라우저 DOM 렌더)·다중 카메라·라이브 경합은 여전히 **미검증**(§11) — 리더 경험적 검증 필요.

---
---

# 부록 — 2차 검증(동시 진행, 독립 관점)

> ⚠️ **이 부록은 위 본문과 별도의 검증 세션이 dev-assoc 의 4개 중점 요청(T6 재검·segError 분기·미확인 항목·p2 수율)에 답하며
> 동시에 작성한 것이다.** 본문(DEFECT-1/2, 뮤테이션 테스트)을 먼저 읽고, 이 부록은 **겹치지 않는 추가 발견**만 남긴다.
> 본문의 DEFECT-1 을 **직접 재현해 독립적으로 확인**했다(아래 §A0). DEFECT-2 도 두 호출부(`CaptureJob.ts:382`·
> `detectPipeline.ts:270`) 모두에서 코드로 재확인했다 — 본문 주장과 **완전히 일치**한다.

## §A0. DEFECT-1 독립 재현 (동의)

`buildFrameCuboids` 를 직접 호출하는 최소 재현으로 확인:
```
det 3대(왼쪽/가운데/오른쪽) · seg 원문 3대 중 왼쪽 마스크만 퇴화 → VpdClient 가 drop
  → seg.boxes = [ {vpdIdx:1, ...가운데}, {vpdIdx:2, ...오른쪽} ]  (압축 배열)

r.assoc = [ {detIdx:1, segIdx:0}, {detIdx:2, segIdx:1} ]
seg.boxes[0].vpdIdx = 1 (가운데 차 원본 인덱스)   segIdx(0) !== vpdIdx(1)  ★ 불일치
seg.boxes[1].vpdIdx = 2 (오른쪽 차 원본 인덱스)   segIdx(1) !== vpdIdx(2)  ★ 불일치
```
본문 §3 의 실증과 **정확히 같은 결함**이다. **동의한다 — 수정 필요.**

**추가로 확인한 것(본문에 없는 부분)**: `assoc[].segIdx` 는 현재 **어떤 소비처도 없다**(`grep -rn "\.segIdx" web/app.js src/` → 프로덕션 소비처 0건, `frameCuboids.ts`/`segAssoc.ts` 자기 자신과 테스트 파일뿐). 즉 이 결함의 **현재 blast radius 는 0** 이다 — 지금 당장 조용히 틀린 값을 아무도 보고 있지 않다. 그러나 그것이 위험을 줄이지 않는다: `assoc[].segIdx` **가 존재하는 유일한 이유가 미래의 추적성 도구**(디버그 뷰어·로그 상관관계)이므로, 계약을 지금 고치지 않으면 **다음에 그것을 믿고 쓰는 사람이 D-3 을 반복**한다. 본문의 "중" 등급에 동의하되, **근거를 하나 추가**한다: 지금 고치는 비용(1줄)이 나중에 고치는 비용(소비처가 생긴 뒤 발견 → 디버깅 지옥)보다 압도적으로 싸다.

## §A1. 추가 발견 D-3(경미~중) — `/capture/vehicle-cuboids` 는 ctx==null 일 때도 카메라·det 를 호출한다

**이전 구현**(이번 라운드 이전)은 그 프리셋의 지면모델을 못 찾으면 `camera.requestImage` 를 부르기 **전에** 즉시 return 했다. 이번 리팩터는 `ctx` 해결 결과와 무관하게 **항상 먼저 카메라를 찍고 det 를 부른 뒤** `buildFrameCuboids` 내부에서 강등한다.

**실측**(호출 카운팅 스텁, `cam=1&preset=99` — 그 카메라에 없는 프리셋 → ctx 는 반드시 null):
```
camera.requestImage 호출: 1회   (이상적으로는 0회)
vpd.detect 호출:          1회   (이상적으로는 0회)
vpd.segment 호출:         0회   (ctx null 체크가 seg 호출보다는 앞선다 — 그나마 다행)
```
**왜 사소하지 않은가**: 이 라우트는 잡이 PTZ 를 이동시키며 쓰는 **그 카메라**를 공유한다. `jobCuboidRoutes.test.ts` 헤더가 이미 이 위험(잡에게서 카메라를 뺏는다)을 명시적으로 경계하는데, 정작 `/capture/vehicle-cuboids` 자신은 **응답이 처음부터 빈 배열로 확정되는 요청**(잘못된 preset 번호 등)에도 매번 카메라를 훔쳐 쓰고 det 비용(≈230~330ms, 본문 §5 실측 인용)을 태운다. 응답 correctness 는 무영향이라 기존 12건 단언은 안 깨진다 — **조용한 실패가 아니라 조용한 낭비**다.

부수(경미): 같은 경로에서 `issues` 에 "지면모델 없음" 사유가 **2회** 중복 등재된다(`buildFrameCuboids` 자체 사유 + 라우트가 덧붙인 사유). 둘 다 틀린 말은 아니나 운영자에게 같은 원인이 두 번 보인다.

**봉인**: `test/assocQaFindings.test.ts`(신규, 3건) — 카메라·det 호출 실측 + 중복 issues 실측(최소 보장만 하드 단언, 정확한 개수는 warn 로그로 노출해 향후 개수가 바뀌어도 안 깨지게 함).

## §A2. T6 보강 — `cuboidCtx` 콜백 자체가 throw 하는 경로는 기존 스위트에 없었다(닫음)

본문이 뮤테이션으로 확인한 것은 "잡 경로 로직이 깨졌을 때 T6 가 잡는가"였다. 별도로 확인이 필요했던 것은: `updateCuboids` 의 try/catch 가 **`vpd.segment()` 실패뿐 아니라 `this.deps.cuboidCtx!(...)` 자체의 throw 까지** 흡수하는가 — 프로덕션 `makeCuboidContextResolver` 는 내부에서 전부 흡수해 절대 throw 하지 않지만, `cuboidCtx` 는 **주입 가능한 일반 콜백 타입**이라 다른 구현이 그 계약을 어길 수 있다. "잡은 절대 죽지 않는다"가 이 기능의 최우선 불변식이므로 방어의 마지막 층까지 테스트로 닫았다(`test/captureJobCuboid.test.ts` +1건):
```
cuboidCtx: async () => { throw new Error('placeRoi 파일 파싱 폭발'); }
→ job.getStatus().state === 'done' (에러 아님) · 검출 2건 정상 적재 · getCuboids() === undefined(강등, 조용히 죽지 않음)
```

## §A3. 정직한 부기 — 재현 안 되는 간헐적 실패를 관찰했으나, **본문을 읽고 원인을 정정한다**

`captureJobCuboid.test.ts` 를 단독 반복 실행(bash 루프)하는 과정에서 총 ~40회 중 2회 T6 테스트가 `insertDetections`/`cuboids` 관련 assertion 으로 실패하는 것을 관찰했다. 원인을 확정하지 못한 채 "환경 잡음일 수 있다"고 잠정 기록하려던 참이었다 — 그런데 본문을 읽고 나서 훨씬 유력한 설명을 얻었다: **본문 작성자가 같은 타임프레임에 `onPlaceFilter.ts`·`frameCuboids.ts` 같은 공유 프로덕션 파일을 뮤테이션 테스트를 위해 일시적으로 수정하고 있었다**(§2 MUTANT-1/2/3). 내가 관찰한 간헐 실패 시각과 그 뮤테이션 주입 시각이 겹쳤다면, 그것으로 충분히 설명된다 — 동시에 `_workspace/*.md` 파일들이 계속 D/M 으로 바뀌는 것도 목격했다(동시 작업의 방증).
→ **CaptureJob 자체의 비동기 경쟁 상태라는 가설은 철회한다.** 원본 파일(뮤테이션 없음)만 단독으로 25회+8회 연속 실행했을 때는 **전부 통과**했다 — 이것이 오히려 "프로덕션 코드에 실제 결함은 없다"는 본문 §2 의 결론과 정합적이다.

## §A4. dev-assoc 요청 확인 요약 (부록 관점)

| 요청 | 확인 |
|---|---|
| T6 공허성 | 본문 §2 뮤테이션 테스트로 **더 강하게** 확인됨(고의 결함 주입 → 실패 확인) — 처음 읽었을 때의 "deep equal + 육면체 실제 산출 병행 단언" 정적 검토보다 한 단계 위의 증거 |
| segError 분기 타당성 | 부록 독자적으로도 타당하다고 판단(§0 요약 참조) — 세 소비자(잡=흡수/라우트=502/detect=200) 구분이 정확히 테스트로 커버됨 |
| G1/G2 브라우저 미확인 | 부록도 브라우저 미실행. **정적 대조**(id 매칭)는 완료 — `roi-vcuboid`/`vcuboid-badge`/`anchor-badge`/`cap-count`/`cap-checkpoint` 전부 html↔js 일치, `syncJobCuboids`/`updateVehicleCuboidBadge` 가 렌더·폴링 루프에 실제로 걸림(고아 함수 아님) 확인 — id 오타류는 배제되나 **시각적 렌더 정확성은 여전히 리더 경험적 검증 필요** |
| p2 수율 2/6 | 기존 임계(`minFrontSpanM`) 문제, 이번 라운드 무관 — `contactTypes.ts` git diff 0줄로 재확인. 동의 |

## §A5. 최종 게이트(부록 작성 시점 재확인)

```
npx tsc --noEmit        exit 0
npx vitest run          146 파일 / 1585 테스트 전량 통과
```
(본문의 146/1584 와 1건 차이 — 부록이 추가한 `captureJobCuboid.test.ts` +1건 때문. 파일 수는 동일)

## §A6. 리더 판단 요청 — 부록 추가분

4. **D-3**(§A1): `/capture/vehicle-cuboids` 가 ctx==null 일 때도 카메라·det 를 호출하는 것을 감수할지, 라우트 앞단에 빠른 실패 체크를 되살릴지(`resolveCuboidContext` 직후 `if (!ctx) return 200 강등` — 구현 비용 작음). **QA 가 임의로 고치지 않았다.**
5. **부수**(§A1): issues 중복(cosmetic) 제거 여부.

**본문 DEFECT-1/DEFECT-2 를 최우선으로 본다 — 부록의 D-3/부수는 그보다 낮은 우선순위다.**
