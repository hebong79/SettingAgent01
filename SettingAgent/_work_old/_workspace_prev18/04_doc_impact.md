# 04 영향도 분석 — 정밀수집 전역 인덱스 / 전체 주차면 리스트 (CLAUDE.md 규칙 5)

작성: 문서화(documenter) / 수신: 리더
최종 문서: `SettingAgent/docs/20260713_194236_정밀수집_전역인덱스_주차면목록_프리셋리스트제거.md`
근거: `_workspace/01~03` + **실제 코드 직접 대조** + 문서화 시점 테스트 재실행

---

## 0. 변경 표면

| 계층 | 파일 | 변경 |
|---|---|---|
| 뷰어(순수) | `web/core.js` | 신규 4함수(`normalizeGlobalIdx`/`reindexPlaceSpace`/`removePlaceSpace`/`buildFlatSlotRows`) + `selectFloorRoi` idx 가산 / 제거 3(`buildSlotListGroups`·`cameraposListRows`·`parseLoadedCamerapos`) |
| 뷰어(선언) | `web/core.d.ts` | 동기화 |
| 뷰어(DOM) | `web/index.html` | `#cpreset-box` 제거 · 주차면 툴바 `#place-*` 7종 신설 · artifact 도구 8종을 **분석 탭으로 이관** |
| 뷰어(로직) | `web/app.js` | 핸들러 9종 신규 / cpreset 계열 6함수+리스너 6 제거 / `renderSlotList` 평면화 |
| 뷰어(CSS) | `web/app.css` | 고아 `.slot-group` 3규칙 제거 |
| **서버** | `src/capture/placeRoi.ts` | **신규 `normalizeGlobalIdx`(순수)** |
| **서버** | `src/capture/Finalizer.ts` | import 1 + 2줄 — DB `slot_idx` 를 전역번호로 기록 |
| 테스트 | `test/placeGlobalIdx.test.ts`(신규 36) · `test/globalIdxParity.test.ts`(신규 9) · `test/finalizerParkingSlots.test.ts`(+3) · `test/buildSlotListGroups.test.ts`(삭제) |

**REST 라우트 변경 0건** — `PUT /capture/place-roi` 재사용. `PtzCamRoi.json` **스키마 무변경**(키 집합 동일, 검증됨).

---

## 1. 최상위 위험 — Unity 연동 (`CParkingSpace3DTo2D.cs`)

`Parking3D/Assets/Scripts/02_ParkSimulator/CParkingSpace3DTo2D.cs` 가 `PtzCamRoi.json` 을 **생성**한다(코드 직접 확인: `parkingSpace.idx = space.index;` L214, "파일이 이미 존재하면 로드 후 해당 cam_id·preset_idx 항목만 교체/추가" L350·L414).

| | 내용 |
|---|---|
| **위험** | Unity 재생성 시 idx 가 **프리셋별 0-based 로 리셋** → **사용자가 지정한 전역번호 유실** |
| **증폭 요인** | Unity 는 **일부 프리셋만** 교체할 수 있다. 한 프리셋만 0-based 로 덮여도 파일 전체가 1..N 순열을 잃으므로 **전 프리셋이 재부여**된다(부분 손상이 아니라 **전체 재번호**) |
| **완화(적용됨)** | 로드(`loadPlaceRoi`)·최종화(`Finalizer`) 시 `normalizeGlobalIdx` 가 중복을 감지해 **graceful 재부여**(1..N). 데이터 손상·크래시 없음. 뷰어는 `'전역번호 재부여됨(미저장) — 저장 필요'` 로 고지 |
| **완화 불가** | **사용자 커스텀 번호는 복원 불가.** 스키마 무변경 제약(마스터 확정)의 필연적 귀결 |
| **운영 수칙** | **Unity 에서 PtzCamRoi 를 재생성한 뒤에는 전역번호를 재지정해야 한다** |
| 부수 위험 | Unity 가 `parking_spaces[]` 에 **새 필드를 추가하면** `applyPlaceRoiUpdate` 가 `{idx, points}` 로만 재구성 → **저장 시 그 필드 소실**(현재 실데이터엔 해당 없음). 그때는 `{...sp, idx, points}` 로 고칠 것 |

---

## 2. 기존 DB run 정합 — 마이그레이션 없음(의도된 graceful degradation)

- 구 run 의 `parking_slots.slot_idx` 는 **프리셋별 0-based** 그대로 남는다. **마이그레이션하지 않는다.**
- `buildFlatSlotRows` 의 **프리셋 단위 all-or-nothing 게이트**(core.js:588~591)가 DB 행 집합이 파일 전역번호 집합에 **전부 포함될 때만** 태그를 채택하고, 부분 겹침이면 **통째 기각** → 파일 계산 점유로 폴백.
- 결과: 구 run 은 **태그 미부착**(정보 부재 — 사용자 인지 가능), 점유는 정상 표시. **오귀속 없음.** 재최종화하면 정합.
- 게이트 도입 전에는 구 `{0..6}` 과 신 `{1..7}` 의 부분 겹침으로 **태그가 한 칸 밀려 오귀속**됐다(QA 발견, High — 정보 오염이라 사용자가 인지 불가능). **수정 완료.**
- **신규 run**: `Finalizer` 가 서버측 `normalizeGlobalIdx` 로 정규화 후 기록 → 뷰어 '저장' 여부와 무관하게 **항상 전역번호**. 사전 '저장' 강제 불필요.

---

## 3. 규칙 이중구현 위험 — 향후 수정 시 반드시 3파일 동시

`normalizeGlobalIdx` 규칙이 **두 런타임에 각 1개** 존재한다:

| | 파일 |
|---|---|
| 뷰어(브라우저 ESM) | `web/core.js:515~533` |
| 서버(TS/Node) | `src/capture/placeRoi.ts:90~110` |

**브라우저가 TS 서버 모듈을 import 할 수 없어 물리적 단일 소스 공유가 불가능**하다. 대신 `test/globalIdxParity.test.ts`(9케이스)가 **동일 raw JSON → 동일 전역번호**를 강제한다.

- 한쪽만 고치면 **CI 가 즉시 실패**한다(안전망).
- 실증: 서버 정렬키 `preset asc → desc`(1글자 변이) → 파리티 테스트 **4/9 즉시 실패**.
- **수칙: 규칙 변경 시 `web/core.js` + `src/capture/placeRoi.ts` + `test/globalIdxParity.test.ts` 를 항상 함께 갱신.**

---

## 4. `idx` 소비자 전수 — 안전 근거

| 소비 지점 | idx 사용 방식 | 전역 고유 idx 로 바뀌면 |
|---|---|---|
| `normalizePtzCamRoi`(web/server) | pass-through | 영향 없음 |
| `selectFloorRoi` | `label: String(sp.idx)` — 오버레이 라벨 | **표시만 변경**(0..6 → 1..17). 의도된 개선 |
| `computeOccupancy` | idx pass-through(키 아님) | 영향 없음 |
| `drawFileFloorRoi` / `updateLogicOccupancy` | 라벨·집계 id(키 아님) | 표시 의미만 변경 |
| `transformPlaceRoiPreset` / `alignApply`(자동보정) | 좌표만 변환, **idx 보존 PUT** | 영향 없음 — 자동보정 저장이 전역번호를 파괴하지 않는다 |
| `applyPlaceRoiUpdate`(서버) | **payload idx 를 그대로 기록** | 영향 없음 — **오히려 이번 설계가 의존하는 성질**(라우트 확장 불필요의 근거) |
| `Finalizer` → `parking_slots.slot_idx` | 기록값 | **값 의미 변경**(§2). 정규화 후 기록으로 정합 |
| `SqliteStore` PK `(run_id, preset_key, slot_idx)` | 프리셋 스코프 키 | **PK 유효** — 전역 고유 ⊃ 프리셋내 고유. 제약 위반 없음 |
| `loadDetectCfg` | PtzCamRoi 에서 **fov 만** | 영향 없음 |

**깨지는 코드 0곳.** 전역 고유는 프리셋내 고유의 상위집합이므로 idx 를 프리셋 스코프 키로 쓰는 두 곳(DB PK, 점유 Map)이 모두 안전하다.

### 4-1. PTZ 캘리브레이션(`slot_ptz.json`) — **정합 안 깨짐**

`slotPtzWriter`/`PtzCalibrator` 는 **`artifact.globalIndex`**(`GlobalIndexer`, setup_artifact 의 `slotId` 기준)를 쓴다. **`PtzCamRoi.idx` 를 키로 쓰지 않는다.** → 기존 캘리브레이션 데이터 무손상.

> **동음이의 주의**: "전역 인덱스"가 **2체계**다 — ① `artifact.globalIndex`(slot_ptz/캘리브레이션) ② `PtzCamRoi.idx`(신규, 정밀수집 목록·DB slot_idx). **서로 무관**. 분석 탭에 두 체계 UI 가 공존하므로 혼동 주의.

---

## 5. UI 이관 회귀 (R5 대안 B)

setup_artifact 도구 8종(`#sel-slot-info`·`#slot-insert-idx`·`#slot-add`·`#roi-delete`·`#map-save`·`#result-save`·`#result-open`·`#map-msg`)을 **분석 탭 '전역 인덱스 수동 매핑' 섹션으로 이관**. **id·라벨·핸들러 전부 동일 — DOM 위치 이동뿐.**

- QA 정적 전수 대조: **dangling id 0건**(html 140 / app.js 참조 139), 이관 5버튼 전부 click 결선 생존, `#cpreset-*` 잔재 **0건**.
- 숨겨진 탭에도 DOM 은 존재하므로 `$('slot-add')` 등은 탭과 무관하게 동작. **기능 회귀 0.**
- 부작용: 오버레이 Ctrl+드래그 편집 → **분석 탭의 '저장'** 으로 영속화하는 동선(탭 이동 필요).

---

## 6. 검증 결과 (문서화 시점 재실행으로 직접 확인)

| | 결과 |
|---|---|
| `npx vitest run` | **122 files / 1328 tests 전량 통과** (회귀 0) |
| `npx tsc -p tsconfig.json --noEmit` | **exit 0** |
| 뮤테이션 검사 3건 | 게이트 제거 → 2건 실패 / Finalizer 정규화 생략 → 2건 실패 / 서버 정렬키 1글자 변이 → 4/9 실패 → **검출력 실증**(우연한 통과 아님) |
| 실데이터 왕복 | 전역번호 파일 보존 · 재로드 멱등 · **스키마 키 불변** · 카메라 메타 보존 · 좌표 오차 ≤1.1e-13 px |
| 렌더 결과 | **리더 경험적 검증**으로 확인 |

### 6-1. 미검증 4건 — **위장 금지, 한계로 명시**

Unity 시뮬레이터·LPD/VPD **미가동**:

| # | 미검증 | 비고 |
|---|---|---|
| M1 | 행 클릭 → `gotoPreset()` **물리 이동** + 라이브 재연결 | 관찰형 — 리더 브라우저 확인 필요 |
| M2 | 선택 하이라이트가 선택 행과 시각적으로 일치 | Canvas — 유닛 불가 |
| M3 | `저장` → 실 `PUT /capture/place-roi` 라우트 스모크 | **서버 코어 순수함수(`applyPlaceRoiUpdate`) 왕복은 검증 완료** — 미검증분은 라우트 zod·파일 IO 뿐, 위험 낮음 |
| M4 | `열기` 파일 피커 | 브라우저 다이얼로그 |

---

## 7. 타입 계약 불일치 1건 (마스터 지시로 수정 완료)

`web/core.d.ts` 의 `buildFlatSlotRows` **입력** `parkingSlotsByKey[].vpd/lpd` 가 `boolean` 으로 선언돼 있었으나, 실제 소스(`SqliteStore.getParkingSlots` → `ParkingSlotView`)는 **검출 객체 | null** 을 반환한다.

- 정정: `vpd?: NormalizedRect | null; lpd?: NormalizedQuad | null` (`ParkingSlotView.vpd/lpd` 와 동형). **출력** `FlatSlotRow.vpd/lpd: boolean` 은 `!!db?.vpd` 결과이므로 **그대로 유지**(입력/출력 타입이 다른 것이 정상).
- 부수 효과: 정정 즉시 `test/finalizerParkingSlots.test.ts` 의 픽스처가 tsc 에 걸렸다. 이 테스트는 DB 행을 `vpd: !!r.vpd` 로 **불리언 강제**해 실제 뷰어 경로(`app.js:1560` — DB 행을 **그대로** push)와 달랐다. 실제 경로대로 raw 행을 넘기도록 수정 → **픽스처가 실 계약과 일치**하게 됨(테스트 충실도 개선).
- 검증: `npx tsc --noEmit` exit 0, `npx vitest run` **122 files / 1328 tests 전량 통과**(회귀 0).

## 8. 기타 잔여 위험

- **저장 부분 실패 시 자동 롤백 없음** — 직렬 PUT 중단 → 앞 프리셋만 반영. 실패 프리셋을 `#place-msg` 에 명시 + dirty 유지로 고지(설계된 동작).
- **직렬 PUT 필수** — 라우트가 매 요청 `readFile→apply→writeFile` 이므로 **병렬화하면 갱신 유실**. 향후 리팩토링 시 `for...of + await` 를 `Promise.all` 로 바꾸지 말 것.
- **최종화 후 목록 소스가 `state.placeRoi`** — DB 는 태그 소스로만 사용. PtzCamRoi 파일이 없으면 최종화 후에도 목록이 빈다(정상 경로에선 Finalizer 가 PtzCamRoi 를 소스로 하므로 미발생).
