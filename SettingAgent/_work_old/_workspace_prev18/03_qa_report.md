# 03 검증 보고 — 정밀수집 우측 패널: 프리셋 리스트 제거 + 전체 주차면 리스트(전역 인덱스)

작성: 검증자(qa-tester) / 수신: 구현자(developer), 문서화(documenter)
대상: `_workspace/01_architect_plan.md`(설계) + `_workspace/02_developer_changes.md`(구현, §6-A 추가 변경 포함)
산출 테스트: `SettingAgent/test/placeGlobalIdx.test.ts`(신규 36) — 이후 구현자가 추가한
`test/globalIdxParity.test.ts`(신규 9) + `test/finalizerParkingSlots.test.ts` 전역번호 describe(3) **재검증 완료**

---

## 0. 결론

| 항목 | 결과 |
|---|---|
| `npx vitest run` | **122 파일 / 1328 테스트 전량 통과** (최초 120/1280 → 1차 121/1316 → **§6-A 재검증 122/1328**, **회귀 0**) |
| `npx tsc -p tsconfig.json --noEmit` | **exit 0** |
| R1 프리셋 리스트 박스 제거 | **통과** — `#cpreset-*` 잔재 0건(html/js 전수 grep) |
| R2 전체 주차면 평면 목록 | **통과** — globalIdx 오름차순, 프리셋 경계 무시 |
| R3 전역 인덱스 정규화 | **통과** — 재부여·멱등·강등 전 경계 통과 |
| R4 수정/삭제/저장/열기 | **통과** — clamp·불변식·불변성·왕복 저장 |
| R5 artifact 도구 분석탭 이관 | **통과** — id·핸들러 결선 100% 생존, dangling id **0건** |
| **발견 결함 #1(수정 완료)** | `buildFlatSlotRows` DB 태그 **off-by-one 오귀속** (§3) |
| **§6-A(마스터 승인 추가범위) Finalizer 서버측 정규화** | **통과** — 뮤테이션 2건으로 검출력 재확인(§7) |
| 미검증(정직 고지) | 브라우저 라이브 3항목 (§5) |

---

## 1. 발견 결함 #1 (High) — DB 태그가 틀린 주차면에 붙는 off-by-one 오귀속

### 1-1. 개발자 인계 사항과 실제의 차이

구현 보고 §7-3 은 *"구 run 의 0-based `slot_idx` → `slotIdx===globalIdx` 매칭이 빗나가 **태그 미부착**(graceful)"* 이라고 기술했다.
**실측 결과 이는 사실이 아니다.** 첫 프리셋에서는 태그가 **미부착이 아니라 한 칸 밀려 잘못 부착**된다.

### 1-2. 원인 (경계면 교차 비교로 발견)

- `web/core.js:588` — `const db = dbRows.find((r) => r.slotIdx === sp.idx);`
- 구 run(0-based) DB 행의 `slotIdx` 집합 = `{0..6}`, 신 전역번호(cam1:1) = `{1..7}` → **`1..6` 이 겹친다.**
- 그러나 DB 의 `slot_idx=1` 은 그 프리셋 **배열 위치 1**(= 신 `globalIdx` **2**)의 데이터다. 이것이 `globalIdx` **1** 행에 부착된다 → **전 태그가 한 칸 시프트.**
- 배열 위치 0 의 데이터(`slot_idx=0`)는 어떤 `globalIdx` 와도 매칭되지 않아 **소실**.
- `cam1:2`(구 0..5 vs 신 8..13), `cam1:3`(구 0..3 vs 신 14..17) 은 번호대가 겹치지 않아 **정말로 미부착**(개발자 기술대로).

### 1-3. 레거시 run 만의 문제가 아니다 — 최초 사용의 기본 경로

`src/capture/Finalizer.ts:240` 이 `slotIdx: sp.idx` 로 **파일의 raw idx 를 그대로** 기록한다.
**서버에는 `normalizeGlobalIdx` 포팅이 없다**(`src/capture/placeRoi.ts` 에 없음 — 정규화는 `web/core.js` 클라이언트 전용).

⇒ 사용자가 뷰어에서 **'저장'을 누르기 전**(= Unity 가 생성한 0-based 파일 그대로) 정밀수집 → 최종화하면 **신규 run 도 0-based `slot_idx`** 로 기록되어 동일한 오귀속이 발생한다. 이는 예외 경로가 아니라 **최초 사용 시의 기본 경로**다.

### 1-4. 사용자에게 오해를 주는가 — **준다(High)**

크래시는 없으나 **틀린 값을 진실처럼 표시**한다. "태그가 안 보인다"(정보 부재 — 사용자가 인지 가능)와 "옆 주차면의 점유/VPD/LPD 가 내 주차면 것으로 보인다"(정보 오염 — 사용자가 **인지 불가능**)는 심각도가 다르다. 정밀수집의 목적이 주차면별 점유·검출 확인이므로, 이 결함은 **기능의 신뢰성을 직접 훼손**한다.

### 1-5. 조치 — **수정 완료 · 재검증 통과**

구현자가 `web/core.js:588~591` 에 **프리셋 단위 all-or-nothing 게이트** 적용:

```js
const fileIdx = new Set(spaces.map((sp) => sp.idx));
// 구 run(0-based {0..6})은 신 전역번호({1..7})와 부분만 겹쳐 한 칸 시프트된 값을 진짜처럼 표시 → 통째 기각.
const usable = dbRows.length > 0 && dbRows.every((r) => fileIdx.has(r.slotIdx)) ? dbRows : [];
```

DB 행 집합이 파일 전역번호 체계와 **완전히 정합할 때만** 태그를 채택하고, 부분 겹침이면 그 프리셋의 DB 행을 **통째로 기각**(→ 파일 계산 점유로 폴백, 태그 미부착). 이로써 구현자가 **의도했던 'graceful 미부착'이 실제로 성립**한다.

**재검증 — 뮤테이션(변이) 검사로 테스트의 결함 검출력을 실증:**
1. 수정 코드 → 신규 4테스트 통과.
2. 가드를 제거해 **구 버그를 인위적으로 재주입** → **해당 테스트 2건이 즉시 실패**(`오귀속 금지…`, `부분 불일치…`). ⇒ 테스트가 이 결함을 실제로 잡는다(우연한 통과가 아님).
3. 코드 원복 → 전량 통과.

> 판별력 확보를 위해 fixture 를 **파일 계산과 '오귀속된 DB 값'이 서로 반대**가 되도록 구성했다(파일 계산=점유 / 오귀속 DB=공차). 단순히 `occupied:false` 를 기대하면 두 경로가 우연히 같은 값을 내 결함을 놓친다 — 구현자의 지적을 반영해 기대값을 **의도 직접 assert** 로 뒤집었다.

> 근본 해소(선택, 이번 범위 밖): 파일을 정규화 상태로 저장하면(`저장` 1회) `Finalizer` 가 전역번호를 그대로 기록하므로 태그가 정확히 정합한다. 뷰어는 로드 시 `'전역번호 재부여됨(미저장) — 저장 필요'` 를 이미 고지한다. **문서에 "정밀수집 전 저장 1회 권장" 명시 필요**(→ documenter). 서버(`Finalizer`)측 전역번호 정규화는 계획 §4-3("서버 0줄") 범위 밖이라 미착수 — **후속 과제**.

---

## 2. 항목별 검증 결과

### 2-1. `normalizeGlobalIdx` (R3, 계획 §6 1~6) — 통과

| 케이스 | 기대 | 결과 |
|---|---|---|
| 실데이터형(프리셋별 0-based 중복 7/6/4면) | cam asc→preset asc→배열순 **1..17 재부여**, `changed:true` | 통과 (`1:1`=1..7, `1:2`=8..13, `1:3`=14..17) |
| **멱등** — 이미 1..N 고유 | **무변경**(`changed:false`) | 통과 |
| 사용자 재지정(1..N 고유·순서 뒤섞임 `[3,1]`) | **보존**(재부여 금지) | 통과 — 커스텀 번호 파괴 회귀 방지 |
| 누락/범위이탈(`1,2,4` for N=3) | 재부여 + `issues` | 통과 |
| malformed(비정수·0·음수·NaN·문자열) | throw 없이 재부여, issues 5건 | 통과 |
| 빈 `{}` / `null` / `undefined` | `{placeRoi:{},changed:false,issues:[]}` | 통과 |
| 프리셋 값이 배열 아님(`null`) | `[]` 로 강등, **키 보존** | 통과 |
| 객체 키 순서 뒤섞임(`1:3` 먼저) | cam asc→preset asc 기준 번호 부여 | 통과 |
| 불변성·좌표 보존 | 원본 미변형 | 통과 |

### 2-2. `reindexPlaceSpace` (R4 수정, 계획 §6 7~13) — 통과

| 케이스 | 결과 |
|---|---|
| `from<to`(3→7) 밀어내기 | 통과 — `1:1` idx `[1,2,7,3,4,5,6]`(배열 순서 유지, idx 만 갱신) |
| `from>to`(7→3) | 통과 — `[1,2,4,5,6,7,3]` |
| **프리셋 경계 넘는 이동**(14→1) | 통과 — 대상은 **`1:3` 소속 유지**, **좌표 불변**, `1:3`=`[1,15,16,17]` |
| `from===to` | 통과 — 원본 동일 참조(no-op) |
| **경계 clamp** `to<1`(-99) / `to>N`(999) | 통과 — 각각 1 / N(17) 로 clamp |
| 존재하지 않는 `from`(999) / 비수치 `to`(NaN) / `null` 입력 | 통과 — 원본 그대로 |
| **사후조건 불변식**: idx 집합 = `{1..N}`, 중복 0 | **전 케이스 assert 통과** |
| 불변성(원본 미변형) | 통과 |
| 수정 결과 재정규화 → `changed:false` | 통과(멱등 정합) |

### 2-3. `removePlaceSpace` (R4 삭제, 계획 §6 14~18) — 통과

| 케이스 | 결과 |
|---|---|
| 중간 삭제(8) | 통과 — 9..17 → 8..16 재압축, N=16 |
| 첫(1) / 마지막(17) 삭제 | 통과 |
| **프리셋의 마지막 1개 삭제** | 통과 — **키가 `[]` 로 유지**(삭제 금지 — 저장 시 `spaces:[]` PUT 필요) |
| 없는 idx(999, 0) / `null` | 통과 — 원본 그대로 |
| 불변성 | 통과 |

### 2-4. `buildFlatSlotRows` (R2) — **삭제된 `buildSlotListGroups.test.ts` 동등 커버리지 복원 완료**

> 개발자 인계 #1. 삭제된 테스트는 **커밋 이력에 없어**(직전 세션 미커밋 파일) 복구 불가 → 계획 §3-4 사양 기준으로 **동등 커버리지를 재작성**.

| 승계한 커버리지 | 결과 |
|---|---|
| **점유 재계산**(`computeOccupancy` 재사용) — 번호판 중심 폴리곤 내부 | 통과 |
| 번호판 소스 **합집합**(`plates` ∪ `vehicles[].plate`) | 통과 |
| **DB 태그 우선** — `slotIdx===globalIdx` 행의 `occupied/vpd/lpd` 가 파일 계산을 덮어씀 | 통과 |
| DB 행 `vpd/lpd` 가 **객체 또는 null**(실 shape) → `!!` 불리언화 | 통과 (§4-2 참조) |
| DB 행 없는 globalIdx → 파일 계산 폴백, 태그 없음 | 통과 |
| **빈/누락/malformed 입력 강등**(`{}`/`null`/`undefined`/인자 없음/프리셋 값 비배열) → `[]`, **throw 금지** | 통과 |
| globalIdx 오름차순 평면 정렬(키 순서 역전 입력으로 검증) | 통과 |
| 구 run 0-based DB × 신 전역번호 | **§1 결함 발견 → 수정 후 통과**(오귀속 금지·graceful 미부착·신 run 정합 부착·부분 불일치 기각 4케이스) |

### 2-5. `selectFloorRoi` idx 가산 (계획 §3-5) — 통과(회귀 0)

- 파일 모드: `quad`/`label`(=`String(idx)`) **기존 필드 불변** + `idx` 가산.
- LLM 모드: **완전 무변경**(`idx` 미부여) — 회귀 0 확인.

---

## 3. 경계면 교차 비교 (지시 3번)

### 3-1. shape 정합: `web/core.js` 정규화 출력 ↔ `src/capture/placeRoi.ts` `applyPlaceRoiUpdate` 입력

| 경계 | 검증 |
|---|---|
| `state.placeRoi` = `{ "cam:preset": [{idx, points:[{x,y}]}] }` | `savePlaceRoi`(app.js:1142~1149)가 `key.split(':')` → `{camId, presetIdx, spaces}` 로 변환 |
| `PlaceRoiPutSchema`(captureRoutes.ts:61~70) | `camId/presetIdx: int positive`, `spaces[].idx: int`, `points[]: {x,y}` — **정규화 출력과 정확히 맞물림** |
| `applyPlaceRoiUpdate` | payload `idx` 를 **그대로 기록**(placeRoi.ts:110~113) → 전역번호 저장에 서버 변경 불필요(설계 §1-1 확인) |
| **빈 프리셋 PUT**(`spaces:[]`) | 서버가 `parking_spaces: []` 로 반영, **프리셋 키 유지** — `removePlaceSpace` 의 "빈 배열 키 유지" 결정과 정합 (테스트 통과) |
| 순차 PUT 필수 | 라우트가 매 요청 `readFile→apply→writeFile` — 구현이 `for...of + await` 직렬 준수 확인(app.js:1142) |

### 3-2. 실데이터 왕복 (`data/Place01/PtzCamRoi.json`) — 통과

`GET → normalizePtzCamRoi → normalizeGlobalIdx → reindexPlaceSpace(14→1) → 전 프리셋 순차 applyPlaceRoiUpdate(서버 실함수) → 재파싱`

| 검증 | 결과 |
|---|---|
| 전역번호 파일 보존 | `1:3`=`[1,15,16,17]`, `1:1`=`[2..8]`, `1:2`=`[9..14]` — **그대로 기록됨** |
| 재로드 멱등 | 저장 후 재파싱 → `normalizeGlobalIdx().changed === false` (재부여 없음) |
| **스키마 키 불변** | top=`["cameras"]`, cam=`["camera","presets"]`, preset=`["preset_idx","parking_spaces"]`, space=`["idx","points"]` — **소실·추가 0** |
| 카메라 메타 보존 | `cam_id/name/position/eulerAngles/fov/imageWidth/imageHeight` 전부 동일 |
| points 형태 | 픽셀 `[x,y]` 배열 4점 유지 |
| 좌표 왕복 오차 | **최대 1.1e-13 px**(136좌표 중 128개 비트단위 동일) — 무해, 조치 불요 |

### 3-3. DB 행 shape 교차 확인 (신규 발견 — 타입 선언 부정확)

`SqliteStore.getParkingSlots`(L503~511) 의 실제 행:
```
{ slotIdx: number, vpd: object|null, lpd: object|null, occupied: boolean, ... }
```
그러나 `web/core.d.ts:224` 는 `parkingSlotsByKey?: Record<string, Array<{ slotIdx; vpd?: boolean; lpd?: boolean; occupied?: boolean }>>` 로 **`vpd/lpd` 를 `boolean` 으로 선언**한다.

- **런타임 영향 없음** — `buildFlatSlotRows` 가 `!!db?.vpd` 로 불리언화하므로 객체(truthy)/null(falsy) 모두 올바르게 동작한다(테스트로 실 shape 고정 완료).
- 다만 **타입 선언이 실제 계약과 다르다**(경계면 문서화 오류). `.d.ts` 이므로 tsc 는 잡지 못한다. → **`vpd?: unknown; lpd?: unknown` 으로 정정 권고**(경미, 기능 영향 0 → 이번 스코프 밖으로 두고 documenter 가 기록).

---

## 4. 이관 회귀 검증 (지시 5번) — 통과, 결선 100% 생존

`web/index.html` id ↔ `web/app.js` `$()` 참조·`addEventListener` 정적 전수 대조:

| 검사 | 결과 |
|---|---|
| app.js 가 참조하지만 html 에 없는 id (→ `wire()` 시 TypeError) | **0건** (html id 140개 / app.js 참조 139개) |
| 이관된 artifact 도구 5종 (`#slot-add`/`#roi-delete`/`#map-save`/`#result-save`/`#result-open`) | **전부 html 존재 + click 핸들러 결선 O** |
| 부속 3종 (`#sel-slot-info`/`#slot-insert-idx`/`#map-msg`) | 전부 존재(비버튼 — 표시/입력용) |
| **이관 위치** | 위 8개 **전부 `#analyze-view`(분석 탭) 내부**에 위치 — 대안 B 확정대로 |
| 신규 PtzCamRoi 도구 7종 + `#slot-list` | 전부 **정밀수집 탭**에 존재, 4버튼 click 결선 O |
| `#cpreset-*` 잔재 | **0건** (html/js 전수 grep — 완전 제거) |

→ **기능 회귀 0.** 이관은 DOM 위치 이동뿐이며 id·핸들러·라벨이 보존되어 `$('slot-add')` 등은 탭과 무관하게 동작한다(숨겨진 탭에도 DOM 은 존재).

---

## 5. 미검증 항목 (성공으로 위장하지 않음)

외부 서비스(Unity 시뮬레이터 13100, LPD/VPD) **미가동** — 순수함수는 전량 유닛 검증했으나 아래는 **DOM/실서비스 의존이라 실행하지 못했다.**

| # | 미검증 항목 | 사유 | 필요 조치 |
|---|---|---|---|
| M1 | 행 클릭 → 다른 프리셋이면 `gotoPreset()` **물리 이동** + `reconnectLiveIfActive()` 라이브 재연결 | Unity 시뮬레이터 미가동 + DOM 이벤트 | 리더 브라우저 수동 확인 |
| M2 | `drawFileFloorRoi` 선택 하이라이트(#ff4d4d, lineWidth 4)가 **선택 행과 시각적으로 일치**하는지 | Canvas 렌더 — 유닛 불가 | 스크린샷 확인 |
| M3 | `저장` 버튼 → 실제 `PUT /capture/place-roi` 3회 순차 → 파일 반영 → `GET` 재조회 | 서버 미기동(코어 `applyPlaceRoiUpdate` 는 실함수로 왕복 검증 완료 §3-2) | 서버 기동 후 스모크 |
| M4 | `열기` 파일 피커(`pickAndReadJsonFile`) | 브라우저 파일 다이얼로그 | 수동 |

> M3 은 **서버 코어 함수까지는 실제로 교차검증**했으므로(라우트 zod·파일 IO 만 미검증), 위험은 낮다. M1/M2 는 관찰형 항목으로 리더 확인이 필요하다.

---

## 6. 잔여 위험 (문서화 필요 — documenter 인계)

1. ~~최초 1회 '저장' 권장~~ → **§6-A 로 해소됨**(아래 §7). Finalizer 가 서버측에서 직접 정규화하므로 뷰어 저장 여부와 무관하게 신규 run 은 항상 태그가 정합한다. **단 마이그레이션 이전(§6-A 반영 전) run 의 DB 행은 여전히 옛 raw idx** — §1 의 all-or-nothing 게이트가 graceful 기각 처리(정상).
2. **Unity 재생성 시 커스텀 전역번호 소실**(설계 §5-1) — 스키마 무변경 제약의 필연. `normalizeGlobalIdx` 가 graceful 재부여하지만 사용자 지정 번호는 복구 불가.
3. **"전역 인덱스" 동음이의 2체계** — `artifact.globalIndex`(GlobalIndexer/slot_ptz.json/캘리브레이션) vs `PtzCamRoi.idx`(신규). 서로 무관하여 캘리브레이션 정합은 깨지지 않으나, **분석 탭에 두 체계 UI 가 공존**하므로 문서에 구분 명시 필요.
4. **저장 부분 실패 시 자동 롤백 없음** — 순차 PUT 중단 → 앞 프리셋만 반영. `#place-msg` 에 실패 프리셋 명시 + dirty 유지로 고지(설계대로).
5. **`core.d.ts` 의 `vpd/lpd: boolean` 선언이 실제 shape(객체|null)과 불일치**(§3-3) — 런타임 영향 0, 선언 정정 권고. 이번 스코프(계획 §4-4) 밖 — documenter 기록 후 리더 판단.
6. **Unity 가 space 에 새 필드 추가 시** `applyPlaceRoiUpdate` 가 `{idx,points}` 로만 재구성 → 필드 소실(현재 해당 없음).
7. **`normalizeGlobalIdx` 규칙이 서버·뷰어에 물리적으로 중복 구현**(§7) — 브라우저가 TS 서버 모듈을 import 할 수 없어 단일 소스 공유는 불가. `test/globalIdxParity.test.ts` 가 두 구현의 divergence 를 감시하는 유일한 안전망이므로, 향후 둘 중 하나만 고치는 변경 시 **반드시 파리티 테스트도 함께 갱신**해야 함(documenter 문서에 이 결합관계 명시 권고).

---

## 7. §6-A 재검증 — Finalizer 서버측 전역번호 정규화 (마스터 승인 추가범위)

developer 가 §1 의 후속 과제(잔여위험 §6-1 구판)를 이번 스코프로 승격해 구현. 재검증 결과 **통과**.

### 7-1. 변경 확인
- `src/capture/placeRoi.ts:90~110` — 신규 `normalizeGlobalIdx(byPreset: Map<...>) → Map<...>`. 정렬 키(`cam asc → preset asc`)·유효성 판정(정수·1..N 범위·중복)·재부여 로직이 `web/core.js` 와 **동일 규칙**임을 코드 대조로 확인.
- `src/capture/Finalizer.ts:225,228` — `const byPresetPlace = normalizeGlobalIdx(place.byPreset); for (const [key, spaces] of byPresetPlace) {...}`. 점유 배정(`byPresetAcc`)·PTZ 캐시(`ptzByKey`)·best-effort try/catch 격리는 무변경 확인.

### 7-2. 신규 테스트 검토
- **`test/globalIdxParity.test.ts`**(9케이스) — 동일 raw JSON 을 서버(`src/capture/placeRoi.ts`)·뷰어(`web/core.js`) 양쪽 정규화 경로에 통과시켜 **동일 전역번호**를 assert. 0-based 중복/1..N 뒤섞임 멱등/누락/0 포함/비정수/프리셋 파일 역순/빈 파일/실데이터/멱등 — 규칙의 전 분기를 포괄.
- **`test/finalizerParkingSlots.test.ts`** 신규 describe(3케이스) — 그중 `'성공기준: 0-based 파일로 최종화해도 뷰어 목록에 DB 태그(VPD/LPD)가 부착된다'`(L297~317) 는 **Finalizer 실경로 → `store.getParkingSlots` → core 정규화 → `buildFlatSlotRows`** 를 전부 실함수로 연결해 §1 결함의 **엔드투엔드 해소**를 직접 증명. 요청했던 성공기준과 정확히 일치.

### 7-3. 뮤테이션 검사(요청 항목 재현) — 검출력 확인

| 뮤테이션 | 대상 | 결과 |
|---|---|---|
| A. Finalizer 를 `byPresetPlace` → `place.byPreset`(정규화 생략)로 되돌림 | `Finalizer.ts` 1줄 | `finalizerParkingSlots.test.ts` 신규 2건 **즉시 실패**(0-based 재부여 케이스, 성공기준 케이스) — 원복 후 전량 통과 |
| B. 서버 정렬키 `preset asc` → `preset desc` (`pa - pb` → `pb - pa`) | `placeRoi.ts:94` 1글자 | `globalIdxParity.test.ts` **4/9 즉시 실패**(0-based 재부여·프리셋 역순·실데이터·멱등) — 원복 후 전량 통과 |

두 뮤테이션 모두 코드 원복 후 `git diff`/`diff` 로 **원본과 100% 동일함을 확인**(잔재 없음). 파리티 테스트는 "서버·뷰어 규칙이 실제로 같은 결과를 낸다"를 검증할 뿐 아니라 "정렬 키가 살짝 달라지면 반드시 실패한다"는 **판별력**까지 갖췄다 — 우연히 통과하는 테스트가 아니다.

### 7-4. 서버 강등 동작 vs core.js 대조 (요청 항목)

| 케이스 | 서버(`placeRoi.ts:90~110`) | 뷰어(`core.js:515~533`) | 일치 |
|---|---|---|---|
| 빈 Map/빈 placeRoi | `keys=[]` → 루프 없음 → `valid=true` → 원본(빈 Map) 그대로 | `items=[]`, `n=0` → `issues=[]`, `seen.size(0)===n(0)` → `changed:false` | 일치(둘 다 무변경) |
| 비정수 idx(1.5) | `!Number.isInteger` → `valid=false` → 재부여 | 동일 조건 → 재부여 | 일치 |
| idx < 1 (0, 음수) | `sp.idx < 1` → `valid=false` | 동일 | 일치 |
| idx 중복 | `seen.has(sp.idx)` → `valid=false` | 동일(`seen.has`) | 일치 |
| 이미 1..N 고유(순서 무관) | `valid` 유지 → **원본 그대로 반환**(멱등) | `changed:false` → 원본 그대로 | 일치 — `globalIdxParity.test.ts` 케이스 2·`멱등` 케이스로 고정 |

`globalIdxParity.test.ts` 의 9케이스가 위 표의 각 행을 실제로 커버하므로 강등 동작의 서버·뷰어 일치는 **테스트로 고정된 사실**이며, 코드 대조도 결과와 부합한다.

### 7-5. 결론
§6(구판)-1 의 "최초 1회 저장 권장" 완화책은 이제 근본 해소로 격상되었다. **잔여**는 §6-1(신판)에 반영 — 마이그레이션 이전 run 은 여전히 §1 게이트의 graceful 기각 대상이며 이는 의도된 동작이다.

---

## 8. `web/core.d.ts` 타입 계약 건 — 처리 방침 확정

`vpd/lpd: boolean` 선언과 `SqliteStore.getParkingSlots` 실반환(객체|null) 불일치(§3-3)는 developer 가 **계획 §4-4 범위 밖**으로 확인 후 보류. 런타임 영향 0(`buildFlatSlotRows` 의 `!!` 불리언화로 안전). **documenter 가 영향도 분석에 기록**하고, 리더가 원하면 `unknown` 으로 정정하는 후속 작업으로 남긴다.

---

## 9. 산출물

- `SettingAgent/test/placeGlobalIdx.test.ts` — **신규 36 테스트**

| describe | 수 | 커버 |
|---|---|---|
| `normalizeGlobalIdx` | 9 | 재부여·멱등·커스텀 보존·누락·malformed·빈입력·키순서·불변성 |
| `reindexPlaceSpace` | 8 | 밀어내기(양방향)·프리셋 경계 이동·clamp·no-op·불변식·불변성 |
| `removePlaceSpace` | 5 | 재압축·첫/마지막·빈 프리셋 키 유지·없는 idx·불변성 |
| `buildFlatSlotRows` | 5 | **삭제된 `buildSlotListGroups.test.ts` 동등 커버리지 복원** |
| 구 run × 신 전역 인덱스 | 4 | **오귀속 금지(§1) 회귀 감시** |
| `selectFloorRoi` | 2 | idx 가산 · LLM 모드 회귀 0 |
| 경계면 교차(왕복) | 3 | 실데이터 왕복·스키마 키 보존·빈 프리셋 PUT |

- developer 산출(§6-A, 재검증 완료): `test/globalIdxParity.test.ts`(신규 9) + `test/finalizerParkingSlots.test.ts` 전역번호 describe(3)
- 최종 전량 실행: `npx vitest run` → **122 files / 1328 tests passed**, `npx tsc -p tsconfig.json --noEmit` → **exit 0**
- 뮤테이션 검사 총 3건(§1-5 1건 + §7-3 2건)으로 신규 테스트의 결함 검출력 실증 — 전부 코드 원복 후 diff 로 원본과 동일함 확인.
