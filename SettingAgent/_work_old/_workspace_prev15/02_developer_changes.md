# 02 구현 변경 노트 — VPD 차량 rect Ctrl+드래그 편집 & 주차면 슬롯 전역 중간삽입

구현자(developer) · 대상: 검증자(qa-tester)·문서화(documenter) · 설계서: `_workspace/01_architect_plan.md` + 리더 게이트 G-1~G-4.
검증: SettingAgent `npx tsc -p tsconfig.json --noEmit` **EXIT 0**, `npx vitest run` **650 통과(73 파일)** — 회귀 0.

범위: `web/`(뷰어 프런트) + 신규 순수함수 유닛테스트. 서버(`src/`)는 **무변경**(기존 PUT `/mapping` 계약 재사용).

---

## 1. 리더 게이트 반영

| 게이트 | 결정 | 반영 |
|---|---|---|
| G-1 | 중간삽입 축 = 전역 globalIdx | `insertSlotAt`이 globalIndex 를 명시적 `splice`(수동 전역위치 보존). `rebuildGlobalIndex`(정규정렬) 미사용. |
| G-2 | 신규 슬롯 기본 rect/zone = 설계 확정안 | rect `{0.45,0.45,0.1,0.1}`(중앙 소형), zone `cam{cam}`. |
| G-3 | 휴면코드 임의삭제 금지 | 아래 §4 상세. `resizeRect`/`updateSlotRoi`/`drawHandles` **재활용(재활성)**, `hitTestHandle`/`hitTestEdge`만 신규 `hitTestRectHandle`이 **직접 대체**하여 제거(고아 방지). |
| G-4 | 수식키 Ctrl(ctrlKey)만 | mousedown 분기는 `e.ctrlKey` 만. `metaKey` 미추가. |

---

## 2. 변경 파일별 요지

### `web/core.js` — 신규 순수함수 4개(가산, 기존 export 무변경)
- `nextSlotId(artifact, camIdx, presetIdx) → 'c{cam}p{preset}s{N}'`
  결번 충돌회피: 해당 프리셋 기존 sN 최대치+1 부터 시작, 전체 slotId 집합과 충돌 없을 때까지 bump. (s2 삭제 결번 시 length+1=s3 충돌 회피.)
- `insertSlotAt(artifact, atGlobalIdx, newSlot) → artifact`
  전역 중간삽입(불변). ① 중복 slotId → no-op(원본 참조 반환). ② `slots=[...slots,newSlot]`. ③ (cam,preset)=roiByPreset 첫 key 파싱 → 해당 preset `coveredSlotIds` 말미 append, 부재 시 신규 preset push. ④ `globalIndex` 정렬 후 `splice(clamp(at,1,N+1)-1)` 삽입 → 1..N+1 재부여.
- `moveRect(rect, ndx, ndy) → NormalizedRect`
  평행이동(w,h 유지). `x∈[0,1−w]`, `y∈[0,1−h]` 클램프. `clamp01Rect`는 경계서 w/h 축소 → 이동엔 부적합하여 별도.
- `hitTestRectHandle(rect, nx, ny, tolX, tolY) → 'nw'|'ne'|'sw'|'se'|'n'|'s'|'e'|'w'|'in'|null`
  코너>변>내부>외부 우선순위. tol 주입(DOM 미참조, `hitTestQuadVertex` 패턴). 반환 핸들 문자열은 `resizeRect` handle 인자와 1:1.

### `web/core.d.ts` — 위 4함수 타입 선언 추가(기존 `ArtifactLike`/`NormalizedRect`/`SlotLike` 재사용)
- `RectHandle` 유니온 타입 추가, `hitTestRectHandle` 반환은 `RectHandle | 'in' | null`.

### `web/app.js` — DOM 배선(순수 로직은 core.js 위임)
- **import**: `moveRect`/`hitTestRectHandle`/`nextSlotId`/`insertSlotAt` 추가. `resizeRect`/`updateSlotRoi` 의 `[미사용]` 주석 → 사용 주석으로 갱신(요구 A로 재활성).
- **`drawHandles`(app.js)**: 4모서리 → **8핸들(4코너+4변중점)** 확장, `[미사용]` 주석 제거(재활성). 색 `#ff4d4d`(차량 강조색) 유지.
- **`hitTestHandle`/`hitTestEdge` 제거** → 신규 `hitTestVpd(nx,ny)` 얇은 래퍼로 대체(선택 슬롯 vrect + HANDLE_PX/overlay 치수 tol 주입 → `hitTestRectHandle` 위임).
- **`drawRoiOverlay`**: 선택 슬롯 + `roi-vehicle` on 이면 vrect 위 `drawHandles` 호출(8핸들 시각화). floor quad 선택-핸들 UX와 대칭.
- **`addSlot`(신규)**: 요구 B. `nextSlotId`→기본 rect/zone→`#slot-insert-idx`(1..N+1, 비우면 맨끝) clamp→`insertSlotAt`→선택·markDirty·재렌더.
- **mousedown 상태머신 통합**(§3): Ctrl 분기 최상단 삽입.
- **mousemove**: `dragState.kind` 스위치 확장(floorVertex / vpdResize / vpdMove).
- **mouseup**: **무변경**(kind 무관 공통: `dragState=null; markDirty(); drawRoiOverlay()`).
- **`wire()`**: `$('slot-add').addEventListener('click', addSlot)` 배선(roi-delete 옆).
- **`dragState` 주석**: kind 3종 반영.

### `web/index.html` — `.roi-edit-bar` 가산
- `#slot-insert-idx`(number, min=1, placeholder "위치") + `#slot-add`("추가") 2요소를 `sel-slot-info` 뒤·`roi-delete` 앞에 추가.

### `web/app.css` — 가산
- `.slot-insert-idx { width: 3.5rem; }` 소량(입력창 폭).

### `test/slotInsertEdit.test.ts` — 신규(23 테스트)
- `moveRect`(#12), `hitTestRectHandle`(#13), `nextSlotId`(#10,#11), `insertSlotAt`(#1~#9) + `validateCoverage`/`validateManualIndex`/`buildMappingRows` 교차검증 + `nextSlotId→insertSlotAt` 왕복(app.js addSlot 경로).

### 무변경(외과적 확인)
- `src/**` 전량(PUT `/mapping` 계약·`SetupArtifactSchema`·`validateCoverage` 재사용). `test/roiEdit.test.ts`·`test/viewerOverlayInteractive.test.ts` 등 기존 테스트 무수정 통과.

---

## 3. mousedown 상태머신 통합 지점(줄·함수)

`wireOverlayEditing()`(app.js) `overlay.addEventListener('mousedown', ...)` 콜백:

```
[가드] roiHidden/!mapping → return
{nx,ny}=eventToNorm; key=presetKey
── [신규·요구 A] if (e.ctrlKey && $('roi-vehicle').checked) ──   ← 기존 분기보다 우선(물리 배타)
   h = hitTestVpd(nx,ny)
   h ∈ 8핸들  → dragState={kind:'vpdResize', handle:h, ...}; preventDefault; return
   h === 'in' → dragState={kind:'vpdMove', ...};             preventDefault; return
   (vrect 밖/미선택) hitTestSlots(vehicle-only) hit → 선택+재렌더 + dragState={kind:'vpdMove', slotId:hit}; preventDefault; return
   Ctrl+빈곳 → 낙하(아래 기존 분기 = 선택 해제)
── [기존] hitTestFloorVertex → floorVertex 드래그 ──           ← Ctrl 아닐 때만 실질 도달
── [기존] hitTestSlots 선택/해제 ──
```

- 우선순위 확정: **Ctrl 누름=VPD 편집 / Ctrl 없음=기존(floor 정점·선택)**. floor 정점편집·slot 선택·plate(비편집)와 물리 배타.
- mousemove kind 스위치: `floorVertex`(기존 moveQuadVertex→updateSlotFloorRoi 유지) / else(`vpdResize`=resizeRect, `vpdMove`=moveRect → updateSlotRoi). slot lookup 1회 공유.

---

## 4. G-3 휴면코드 처리 결정 및 사유

| 휴면 대상 | 처리 | 사유 |
|---|---|---|
| `resizeRect`(core.js) | **재활용** | 8핸들 리사이즈 이미 완비(roiEdit.test 커버). vpdResize 경로가 직접 사용. |
| `updateSlotRoi`(core.js) | **재활용** | 불변 rect 교체 완비. vpdResize/vpdMove 결과 반영에 사용. |
| `drawHandles`(app.js) | **재활용+확장** | 4모서리→8핸들 확장 후 `drawRoiOverlay`가 선택 vrect 에 호출(재활성). 신규 `drawVpdHandles` 만들지 않고 기존 헬퍼 확장(중복 방지). |
| `hitTestHandle`(app.js) | **제거** | 신규 순수 `hitTestRectHandle`(코너)이 **직접 대체**. 잔존 시 미사용 중복 → 고아 방지 위해 제거(G-3 규칙: 직접 대체된 헬퍼만 제거). |
| `hitTestEdge`(app.js) | **제거** | 동일 — `hitTestRectHandle`(변)이 직접 대체. |

- `hitTestHandle`/`hitTestEdge` 제거는 CLAUDE.md 규칙3의 "데드코드 임의삭제 금지"와 충돌하지 않음: G-3이 "신규 순수함수가 특정 휴면 헬퍼를 직접 대체하는 경우에만 그 헬퍼 제거(고아 방지)"로 명시 허용. 두 함수는 `hitTestVpd`→`hitTestRectHandle` 도입으로 정확히 대체되며 어떤 호출부도 없음(전 코드베이스 grep: 소스/테스트 0건, docs·workspace 문서에만 언급).
- 최종 미사용 중복 없음 확인: `resizeRect`·`updateSlotRoi`·`drawHandles`·신규 4함수 전부 호출부 존재.

---

## 5. 슬롯삽입 정합 처리(불변식)

- **전역위치**: `atGlobalIdx`(1-based) 위치 splice, 이후 globalIdx +1(at 미만 불변). clamp `[1, N+1]`.
- **preset-내 위치**: 대상 preset `coveredSlotIds` 말미 append → `buildMappingRows` positionIdx 연속(전역 위치와 독립 축, 수동 매핑 체계와 일관).
- **coverage**: globalIndex↔slots 집합 동일 유지 → `validateCoverage.ok`. 저장 시 `SetupArtifactSchema`·`validateCoverage` 통과.
- **1..N 고유**: 재부여로 `validateManualIndex.ok`.
- **불변성**: 원본 slots/globalIndex 미변형(참조·값), 신규 배열 반환.
- **중복 방어**: 존재 slotId 삽입 시 no-op(원본 참조 반환).

**알려진 상호작용(문서화 필요, 본 작업 범위 밖)**: `removeSlot`은 `rebuildGlobalIndex`로 전역순서를 cam→preset→position 정규순서로 재생성. 따라서 `insertSlotAt`로 넣은 수동 전역위치는 *이후 다른 슬롯 삭제 시* 정규순서로 리셋될 수 있음. 기존 한계이며 영향도 분석서에 명시 요망.

---

## 6. 계획 대비 편차

- 편차 없음. 설계 §A·§B 전 항목 반영. `drawVpdHandles` 신규 대신 `drawHandles` 확장 선택(설계가 "또는"으로 허용, G-3 재활용 우선).
- 설계 발견 그대로: **디바운스 없음** — 편집은 `markDirty()`만, 영속화는 `저장` 버튼(`#map-save`→`saveMapping`→PUT). 새 디바운스/자동저장 미도입.

---

## 7. QA 검증 포인트

**순수함수(vitest — 신규 test/slotInsertEdit.test.ts 23건 통과, 심화는 QA 몫)**
- `moveRect`: 평행이동 w/h 유지, 4방향 경계 클램프.
- `hitTestRectHandle`: 8핸들/내부/외부, tol 경계값(≤), tolX/tolY 비대칭, 우선순위(코너>변>내부).
- `nextSlotId`: 결번 충돌회피, s1 시작.
- `insertSlotAt`: #1~#9(삽입위치·밀림·coverage·1..N·no-op·positionIdx·preset부재·클램프·불변성).

**DOM 배선(vitest 밖 — 수동확인 범위, 뷰어 브라우저에서 육안. 외부 서비스(Unity/VPD/LPD/LPR/VLA) 미기동이라 캡처·프리셋 이동 등 실 스트림 연동은 이번 확인 범위에서 제외)**:
- Ctrl+드래그로 선택 차량 rect 리사이즈(8핸들)/이동 실시간 반응.
- 8핸들 렌더(선택 + roi-vehicle on).
- Ctrl 없을 때 기존 floor 정점편집·slot 선택/해제 정상(회귀 없음).
- `추가` 버튼 → 슬롯 생성·선택·`#slot-insert-idx` 삽입위치 반영(빈값=맨끝).
- `저장` → PUT 성공, 슬롯/전역 카운트 증가(`SetupArtifactSchema`·`validateCoverage` 통과).

---

## 8. 검증 결과
- `npx tsc -p tsconfig.json --noEmit`: **EXIT 0**.
- `npx vitest run`: **650 passed / 73 files**(기존 그린 유지 + 신규 23건). 회귀 0.
- 제거된 `hitTestHandle`/`hitTestEdge` 참조: 소스·테스트 0건(grep 확인).
