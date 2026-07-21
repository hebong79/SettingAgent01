# 01. 설계서 — LPD 검지 패널 "DB에 추가" 버튼

## 0. 목표(한 줄)
LPD 검지 패널에서 **현재 프리셋의 라이브 LPD 검출 박스**(`state.detectByKey[key].plates`)를 각 슬롯에 공간배정해 `slot_setup.lpd_obb` 에 저장하는 버튼을 추가한다.

- 대상 = **라이브 검출**(`state.detectByKey`) — 순수 LPD / VPD→LPD / 현재화면 LPD 모드가 채운 `{quad,confidence}[]`.
- discovery(앞면중심 LOOP)는 이미 `upsertSlotLpd` 로 자동저장 → **제외**.
- MCP 경계: 이 기능은 **전량 결정형**(공간배정=순수 기하, 저장=SQLite 부분 UPDATE). LLM 두뇌 미개입. (메모리 `settingagent-llm-minimized` 준수)

---

## 1. 근거 조사 결과 (기존 자산 실측)

| 자산 | 위치 | 확인된 시그니처/사실 |
|---|---|---|
| 저장 | `src/capture/SqliteStore.ts:297` | `upsertSlotLpd(rows: SlotLpdRow[]): void` — `UPDATE slot_setup SET lpd_obb=?, updated_at=? WHERE slot_id=?`. 미존재 slot_id 조용히 무시. wipe 안전(부분 UPDATE). |
| 입력 타입 | `src/capture/types.ts:160` | `SlotLpdRow = { slotId:number; lpdObb:string|null; updatedAt:string }`. `lpdObb` 는 **stringify5 직렬화된 정규화 OBB JSON TEXT**(호출측 규약). |
| 슬롯 소스 | `SqliteStore.ts:222` `getSlotSetup()` | `SlotSetupView[]` — 각 `{slotId, camId, presetId, presetKey, roi: NormalizedPoint[](폴리곤), lpd, ...}`. |
| 공간배정 | `src/setup/plateMatch.ts:32` | `matchPlatesToSlots(slots: BuiltSlot[], plates: PlateBox[]): Map<positionIdx, NormalizedQuad>` — 전역 그리디(중심 ∈ ROI → overlap 내림 → frontAnchor 거리 tie-break, plate당 slot≤1, slot당 plate≤1). **반환 quad 는 입력 plate.quad 의 참조 보존**(문서화된 계약, `plateMatch.ts:59`). |
| BuiltSlot | `src/setup/RoiBuilder.ts:12` | `{ positionIdx:number; roi: NormalizedRect(rect); confidence:number }`. **roi 가 rect** — slot_setup 의 roi(폴리곤)와 타입 불일치. |
| PlateBox | `src/clients/LpdClient.ts:29` | `{ quad: NormalizedQuad; confidence: number }`. |
| 기하 헬퍼 | `src/domain/geometry.ts` / `src/domain/polygon.ts:95` | `quadBoundingRect(quad)→rect`, `center(rect)`, `containsPoint(rect,px,py)`, **`pointInPolygon(poly, p): boolean`(폴리곤 정확 판정 존재)**. |
| 직렬화 | `src/util/round.ts` | `stringify5(v)` — 소수 최대5자리(메모리 `settingagent-persist-5decimals` — TEXT writer 필수 규약). |
| 검출 응답 | `POST /capture/detect` (`captureRoutes.ts:610`) | `plates: {quad, confidence}[]`(현재 프레임 정규화). 프론트가 `state.detectByKey[presetKey(cam,preset)]` 보관(`app.js:1004`). |
| 기존 초기화 라우트 | `captureRoutes.ts:302` | `POST /capture/slots/reset` — 얇은 위임 패턴의 참고 선례. |

---

## 2. 배정 결정 (핵심 판단 — 라이브 검증 반영 개정 v2)

> **개정 사유(05_live_finding.md)**: 초안의 `matchPlatesToSlots` bbox 재사용은 **원근 왜곡 주차면 폴리곤**에서 실패했다. 인접 슬롯 폴리곤의 bounding rect 가 ~60% 겹쳐(slot8~13 x-범위 실측) plate 중심이 3개 bbox 에 동시 포함 → overlap 그리디가 왼쪽으로 한 칸 오배정(0.325→slot9 오답/정답 slot10, 0.463→slot10 오답/정답 slot11). `matchPlatesToSlots` 는 **타이트한 차량 ROI(rect)용** 설계 — 넓은 원근 폴리곤엔 부적합. **bbox 재사용 폐기.**

### 결정: **nearest `slot3d_front_center`(하향앵커) 전역 1:1 그리디** — discovery 앵커와 동일 의미.

`matchPlatesToSlots` 는 **재사용하지 않는다**(그러나 **불변 유지** — finalize/detectPipeline 의 VPD 차량-슬롯 매칭 소비처가 계속 씀). 신규 배정은 **별도 자립 함수**로 구현하되, discovery 가 이미 검증한 앵커·게이트를 **재사용**한다.

**앵커 = `lowerFrontAnchor(view.roi, view.slot3dFrontCenter)`** (기존 export, `src/calibrate/plateDiscoveryWriter.ts:23`).
- 이유: 배정은 2D 거리 nearest 다. **raw `slot3dFrontCenter`(차 전면중심, h≈0.75)** 를 앵커로 쓰면 판 실제 위치보다 **위(y-offset ~0.05–0.08)** 라, 오답 이웃까지 거리 `hypot(0.13, 0.07)≈0.147` 로 게이트(0.15) 마진을 거의 다 먹는다. `lowerFrontAnchor` 는 앵커를 **판 높이로 하향** → 정답 거리 ~0.01–0.03, 오답 이웃 ~0.13 로 **깨끗이 분리** + 게이트 견고. discovery 가 raw front_center 가 아니라 이 하향앵커를 쓰는 이유와 동일("판이 있어야 할 위치").
- **재사용이 정당한 이유**: `lowerFrontAnchor` 는 순수 exported 함수(roi 이상 시 frontCenter 폴백 내장, throw 없음). `plateDiscoveryWriter.ts` 는 `src/setup/` 을 import 하지 않으므로 `setup→calibrate` import 는 **비순환**(실측 확인). 하향앵커 수학 재구현은 이중구현 위반.

**배정 알고리즘(전역 1:1 그리디 — matchPlatesToSlots 골격, 정렬 키만 overlap→거리)**:
```
anchors = slots
  .filter(s => s.slot3dFrontCenter != null)            // null 스킵(§ 폴백 결정)
  .map(s => ({ slotId: s.slotId, a: lowerFrontAnchor(s.roi, s.slot3dFrontCenter) }))
pairs = []
plates.forEach((plate, pi) => {
  const c = center(quadBoundingRect(plate.quad))        // plate 중심(정규화)
  anchors.forEach(({slotId, a}) => {
    const d = Math.hypot(c.x - a.x, c.y - a.y)
    if (d <= MATCH_RADIUS) pairs.push({ pi, slotId, quad: plate.quad, d })  // 게이트
  })
})
pairs.sort((x,y) => x.d - y.d || x.pi - y.pi || x.slotId - y.slotId)  // 거리↑ → 결정성 폴백
const result = new Map<number, NormalizedQuad>(); const used = new Set<number>()
for (const p of pairs) {
  if (used.has(p.pi) || result.has(p.slotId)) continue   // 양쪽 미배정일 때만(plate≤1·slot≤1)
  result.set(p.slotId, p.quad); used.add(p.pi)           // quad 참조 보존(§3-2 confidence 역조회 계약 유지)
}
return result
```

### 세부 결정 (리더 질의 응답)

| 항목 | 결정 | 근거 |
|---|---|---|
| **앵커** | `lowerFrontAnchor` 재사용 (raw front_center 아님) | 게이트 2D 마진 확보 + discovery 동일 앵커. raw front_center 도 관측 데이터(x)는 정답이나 y-offset 로 게이트 견고성 저하. |
| **거리 상한 게이트** | **둔다. `MATCH_RADIUS = 0.15`** (discovery `matchRadiusNorm` 기본값과 동일) | nearest-only 는 프레임 밖/무관 오검출도 어떤 슬롯엔가 강제 배정(과배정). discovery 가 이미 0.15 로 게이트. 초과 plate → 미배정(응답 `unassigned` 로 정직 카운트). |
| **front_center null 슬롯** | **스킵**(배정 대상 제외) | discovery 와 동일(`plateDiscoveryWriter.ts:48` `if slot3dFrontCenter==null continue`). roi centroid 폴백은 **과설계로 배제** — 위장 배정 금지. |
| **`matchPlatesToSlots`** | **불변** | VPD 차량-슬롯 매칭(finalize/detectPipeline) 계약. 신규 배정은 별도 함수. |
| **함수 시그니처** | **초안과 동일** `assignPlatesToSlotViews(slots, plates): Map<slotId,quad>` | 라우트(§3-2) 무변경 — 본체만 교체. |

> **불채택**: (1) bbox point-in-polygon 그리디(라이브 실패). (2) raw front_center 앵커(게이트 마진 저하). (3) `lowerFrontAnchor` 의 `PLATE_H`(0.4) 재튜닝 — 현 데이터로 판 간격 0.13 ≫ 오차라 불필요(과설계).

---

## 3. 구현 계획 (백엔드 우선 — 결정형·테스트가능)

### 3-1. 배정 함수 (nearest 하향앵커 그리디) — `src/setup/plateMatch.ts` 에 함수 1개 가산
`matchPlatesToSlots` 와 같은 모듈에 신규 함수 추가(응집 — plate↔slot 매칭 모듈). `matchPlatesToSlots` 는 손대지 않는다.

```ts
// 입력: 특정 프리셋의 슬롯뷰 + 라이브 plate 배열 → slotId 별 배정된 quad(nearest 하향앵커 전역 1:1).
export function assignPlatesToSlotViews(
  slots: SlotSetupView[],          // cam:preset 필터·slot3d_front_center 보유분만 유효
  plates: PlateBox[],
): Map<number /*slotId*/, NormalizedQuad>
```
- 본체: §2 알고리즘 그대로. `MATCH_RADIUS = 0.15`(모듈 상수, 주석에 discovery `matchRadiusNorm` 동일값 명기).
- import 추가: `lowerFrontAnchor`(`../calibrate/plateDiscoveryWriter.js`), `center`·`quadBoundingRect`(`../domain/geometry.js`, `quadBoundingRect` 는 기존 import 에 이미 있음 → `center` 만 추가). `SlotSetupView`(`../capture/types.js`).
- **신규 기하 유틸 없음**(bbox 유틸 폐기). `lowerFrontAnchor`·`center`·`quadBoundingRect` 재사용만.
- quad 는 입력 plate.quad **참조 그대로** 담는다(§3-2 confidence 역조회 계약 유지 — `matchPlatesToSlots:59` 와 동일 규약).
- **검증**: (a) plate 중심이 어느 슬롯 하향앵커에 최근접 → 그 slotId(라이브 시나리오 0.325→slot10 류), (b) plate 2·슬롯 2 전역 1:1, (c) `slot3dFrontCenter==null` 슬롯 스킵, (d) 모든 앵커에서 `>MATCH_RADIUS` 인 plate → 미배정(반환맵 제외).

> 배치: 순수 함수는 `plateMatch.ts`(도메인) 에 두어 라우트를 얇게 유지 + 단위테스트 용이. 라우트 파일 로컬 함수는 배제.

### 3-2. 신규 라우트 `POST /capture/slots/lpd` — `src/api/captureRoutes.ts` (얇은 진입점)
`registerCaptureRoutes` 내부, 기존 `/capture/slots/reset`(라인 302) 인접에 등록.

- **body(zod)**:
  ```ts
  const SlotLpdSaveSchema = z.object({
    cam: z.number().int().positive(),
    preset: z.number().int().positive(),
    plates: z.array(z.object({
      quad: z.array(z.object({ x: z.number(), y: z.number() })).length(4),
      confidence: z.number().optional(),
    })), // 빈 배열 허용(→ 0건 저장)
  });
  ```
  - `quad` 는 `NormalizedQuad`(4점). confidence 미지정 → 배정엔 무영향(슬롯 confidence 만 tie-break 에 안 씀), 응답용으로만 기본 0.
- **처리**:
  1. `store.getSlotSetup()` → `camId===cam && presetId===preset` 필터(프리셋 슬롯). `slot3dFrontCenter==null` 스킵은 `assignPlatesToSlotViews` 내부에서 처리.
  2. `plates` → `PlateBox[]` 로 매핑(`confidence: p.confidence ?? 0`).
  3. `assignPlatesToSlotViews(slots, plateBoxes)` → `Map<slotId, quad>`(nearest 하향앵커 그리디 + 0.15 게이트).
  4. rows = `[...map].map(([slotId, quad]) => ({ slotId, lpdObb: stringify5(quad), updatedAt: now }))`.
  5. `store.upsertSlotLpd(rows)`.
- **반환**:
  ```json
  { "ok": true, "updated": N,
    "assigned": [{ "slotId": s, "confidence": c }],
    "unassigned": M }
  ```
  - `unassigned = plates.length - map.size`(정직 — 배정 안 된 plate 수).
  - `assigned[].confidence`: 반환 quad 의 **참조 동등성**으로 원 plate 를 역조회(`plateMatch.ts:59` 계약)해 confidence 부착. 참조 매칭 실패 시 confidence 생략(방어).
- **의존성**: `store` 만 사용(이미 `deps.store` 존재). camera/vpd/lpd 불요 → **무조건 등록**(가드 없음). `stringify5` 는 이미 import 됨(`captureRoutes.ts:30`).
- **좌표 정합 주의(명기)**: `plates` 는 검출 프레임 정규화, `slot_roi` 는 프리셋 base 프레임 정규화. **순수 LPD / VPD→LPD(PTZ=프리셋)는 정합**. **현재화면 순수 LPD(수동 줌 PTZ)는 좌표 불일치**로 오배정 가능 → 이 버튼은 **프리셋 정합 검출에 유효**함을 UI/문서에 한계로 표기. (수동 PTZ 역투영은 범위 밖 — 2차.)
- **정책 준수**: `upsertSlotLpd` 부분 UPDATE(wipe 안전, 메모리 `finalize-slotsetup-wipe-fragility`) · `stringify5`(메모리 `persist-5decimals`) · **VPD 미접촉**(메모리 `vpd-auto-detect-forbidden`).
- **검증**: plates→getSlotSetup 배정→upsertSlotLpd 스텁 호출 인자 확인(stringify5 직렬화·slotId), 빈 plates→0건·updated:0, 미존재 프리셋→updated:0.

### 3-3. 프론트 버튼 — `web/index.html`
LPD 검지 패널(`#lpd-run` 액션 바, `index.html:224` `.cap-actions.operation-actions`)에 `#lpd-run` 옆으로 secondary 버튼 추가:
```html
<button id="lpd-db-add" title="현재 프리셋 라이브 LPD 검출을 slot_setup.lpd 에 저장">DB에 추가</button>
```
- 위치: `#lpd-run` 뒤(같은 툴바). 클래스는 미지정(기본=secondary 스타일 — `align-*` 보조 버튼들과 동일 관례, `index.html:251-254`).

### 3-4. 프론트 핸들러 — `web/app.js`
- 신규 async 함수 `saveLpdToDb()`:
  - `cam = state.capFrameKey2?.cam ?? state.cam; preset = state.capFrameKey2?.preset ?? state.preset;`(runLiveDetect 와 동일 프리셋 판별, `app.js:989`).
  - `key = presetKey(cam, preset); const plates = state.detectByKey[key]?.plates ?? [];`
  - `plates` 비면 `#disc-msg` 에 안내(`현재 프리셋에 저장할 LPD 검출이 없습니다`) 후 return.
  - `POST /capture/slots/lpd` `{cam, preset, plates}`(fetch, resetSlotSetupDb 패턴 `app.js:2247`).
  - 성공: `#disc-msg` = `DB 추가: {updated} 슬롯 (미배정 {unassigned})`. 실패: `DB 추가 실패: {error}`.
  - 저장 후 `await loadParkingSlots(); drawRoiOverlay(); renderSlotList();` — `#roi-db`(slot_setup 소스) 오버레이 정합 갱신(`app.js:2251-2253` 선례).
- 배선: 초기화 블록(`app.js:3484` `#lpd-run` 리스너 직후)에 `$('lpd-db-add').addEventListener('click', saveLpdToDb);`.

---

## 4. 변경 파일 목록 (구현자 전달)

| 파일 | 변경 | 요지 |
|---|---|---|
| `src/setup/plateMatch.ts` | **가산** | `assignPlatesToSlotViews(slots, plates)`(nearest 하향앵커 그리디) + `MATCH_RADIUS=0.15` 상수 + import(`lowerFrontAnchor`, `center`). bbox 유틸 없음. 기존 `matchPlatesToSlots` **불변**. |
| `src/api/captureRoutes.ts` | **가산** | `SlotLpdSaveSchema`(zod) + `POST /capture/slots/lpd` 라우트(얇음). |
| `web/index.html` | **가산** | `#lpd-db-add` 버튼 1개. |
| `web/app.js` | **가산** | `saveLpdToDb()` + 리스너 1줄. |
| `test/plateMatch.test.ts`(있으면 확장, 없으면 신규) | **가산** | `assignPlatesToSlotViews` 단위테스트. |
| `test/captureRoutes.test.ts` | **가산** | `/capture/slots/lpd` 라우트 테스트(store 스텁). |

**신규 파일 없음**(전부 기존 파일 가산) — 외과적.

---

## 5. 검증 계획 (goal 검증 기준)

### vitest (결정형 — 성공 기준 명확)
1. **배정 함수**(`assignPlatesToSlotViews`) — nearest 하향앵커
   - **라이브 재현 시나리오**: 슬롯 slot10~13(front_center x 0.323/0.457/0.605/0.770 + roi) + plate x 0.325/0.463/0.635/0.783 → 배정이 slot10/11/12/13(초안 bbox 방식의 한 칸 밀림이 사라짐) 확인. ← goal 회귀 방지 핵심 테스트.
   - plate 2 · 슬롯 2 전역 1:1(plate당 slot≤1, slot당 plate≤1) 확인.
   - `slot3dFrontCenter==null` 슬롯 스킵 확인(배정 대상 제외).
   - **거리 상한 게이트 양면**: (a) 모든 앵커에서 `>0.15` 인 plate → 미배정(반환맵 제외), (b) `≤0.15` plate → 배정.
2. **라우트**(`POST /capture/slots/lpd`)
   - store 스텁: `getSlotSetup()` 고정 반환 → plates 입력 → `upsertSlotLpd` 가 받은 rows 의 `slotId`·`lpdObb`(=`stringify5(quad)`, 소수5자리) 검증.
   - 응답 `{ok, updated:N, assigned, unassigned:M}` 정합(updated == map.size, unassigned == plates.length - map.size).
   - **빈 plates → updated:0**, upsertSlotLpd 는 `[]` 로 호출(또는 미호출) — 0건.
   - 잘못된 body(cam 누락 등) → 400.
3. **회귀**: 기존 `captureRoutes.test.ts`·`SqliteStore`·`plateMatch`(matchPlatesToSlots) 테스트 무영향(불변 확인).

### 리더 라이브(관찰형 — goal)
- 순수 LPD 4검출(cam1:preset2) → **DB에 추가** 클릭 → `#disc-msg` `DB 추가: N 슬롯` → `GET /capture/slots` 응답의 해당 프리셋 행 `lpd` 반영 확인 → **slot9~13 배정이 discovery(앞면중심 LOOP) 결과와 일치 · 오배정 0**(초안의 한 칸 밀림 재발 없음) → `#roi-db` 체크 시 오버레이 정합.

---

## 6. 영향도 초안 (문서화 전달)

- **DB 스키마**: 변경 없음. `slot_setup.lpd_obb` 컬럼에 **기존 쓰기 경로(upsertSlotLpd)** 를 재사용할 뿐 — 새 쓰기 주체(라이브 버튼)만 추가. discovery 자동저장 경로와 **동일 컬럼·동일 메서드** 공유(경합 아님, 부분 UPDATE).
- **REST 계약**: `POST /capture/slots/lpd` **신규**(가산). 기존 `/capture/detect`·`/capture/slots`·`/capture/slots/reset` 불변.
- **프론트 상태**: `state.detectByKey`(읽기 전용 소비) · `state.parkingSlotsByKey`(저장 후 재로드) — 기존 흐름 재사용, 신규 전역상태 0.
- **VPD 정책**: 미접촉(메모리 `vpd-auto-detect-forbidden`). 이 버튼은 LPD 전용.
- **오버레이 유지 정책**(메모리 `settingagent-overlay-retain-policy`): 저장은 오버레이를 지우지 않음 — `#roi-db` 재조회로 DB 소스만 갱신.
- **배정 방식 변경(v2)**: 배정을 nearest `slot3d_front_center`(하향앵커)로 재설계 → **discovery(앞면중심 LOOP)와 동일 앵커·게이트** = 두 경로가 같은 슬롯에 판을 귀속(일관성↑). `lowerFrontAnchor` 재사용으로 `src/setup/plateMatch.ts`→`src/calibrate/plateDiscoveryWriter.ts` **신규 import 1건**(비순환 확인). `matchPlatesToSlots`·VPD 소비처 무영향.
- **의존성**: `slot3d_front_center` 없는 프리셋(ground 미설정/강등 finalize)에서는 배정 대상 0 → `updated:0`·전량 미배정. 문서·UI 에 "front_center(지면모델) 필요" 전제 명기.
- **잠재 위험**: 현재화면 순수 LPD(수동 PTZ) 모드 좌표계 불일치 오배정(§3-2 명기·UI 한계 표기로 완화). 게이트 `MATCH_RADIUS=0.15` 는 discovery 검증값 — 판 간격이 이보다 촘촘한 배치가 생기면 재튜닝 노브.

---

## 7. 미해결/가정
- **가정 1**: `slot_roi` 는 base(프리셋) 프레임 정규화 좌표, `detectByKey[key].plates` 도 프리셋 경로에선 동일 base 정규화 → 정합. (근거: `runDetect` 가 프리셋 base 프레임에서 검출, place-roi 폴리곤과 같은 좌표계.) 검증은 리더 라이브에서 확정.
- **가정 2**: `slot3d_front_center` 는 `slot_roi` 와 동일 base 프레임 정규화 좌표 → plate 중심과 직접 거리 비교 가능. (근거: Finalizer 가 같은 프리셋 프레임에서 산출.)
- **확정(v2)**: 앵커=`lowerFrontAnchor`(하향), 게이트=0.15, null=스킵, `matchPlatesToSlots` 불변, 시그니처 불변(라우트 무변경), types 무변경 — 라이브 발견 반영 완료.
- **질문(리더)**: `assigned[].confidence` 를 UI 에 노출할 필요가 있는가? 현재 계획은 응답에만 포함하고 `#disc-msg` 엔 슬롯 수만 표기. 불필요하면 응답 `assigned` 를 `slotId[]` 로 축소 가능(더 단순). — **기본은 정직성 위해 confidence 포함 유지**, 반대 지시 없으면 그대로 진행.
