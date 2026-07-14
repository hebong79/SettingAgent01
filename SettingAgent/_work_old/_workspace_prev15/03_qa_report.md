# 03 QA 검증 리포트 — VPD Ctrl+드래그 편집 & 슬롯 전역 중간삽입

검증자(qa-tester) · 대상: 구현자(developer)·문서화(documenter) · 근거: `01_architect_plan.md` §검증 불변식 / `02_developer_changes.md` §7.

## 종합 판정: **통과(PASS)** — 회귀 0, 신규 순수로직 불변식 전량 검증

| 항목 | 값 |
|---|---|
| `npx vitest run` 전체 | **660 passed / 74 files** (기존 650 + 신규 QA 10) |
| `npx tsc -p tsconfig.json --noEmit` | **EXIT 0** |
| 신규 QA 파일 | `test/slotInsertEditQa.test.ts` (10 tests, 전부 통과) |
| 구현자 테스트 | `test/slotInsertEdit.test.ts` (23 tests, 전부 통과) |
| 회귀(roiEdit 등) | `test/roiEdit.test.ts` 56 + 전체 그린 유지 |

---

## 1. 작성/실행한 테스트

### 구현자 제출 `test/slotInsertEdit.test.ts` (23건) — 평가: **충분, 부족분만 보강**
- moveRect(3) / hitTestRectHandle(7) / nextSlotId(3) / insertSlotAt(9) + 왕복(1). 불변식 #1~#4·#6~#13을 실질적으로 덮음.

### 검증자 보강 `test/slotInsertEditQa.test.ts` (10건) — 미커버 3개 축 보강
1. **#5 실제 서버 저장 스키마 parse (경계면 교차)**: 구현자 테스트는 `validateCoverage`만 호출 → 실제 `SetupArtifactSchema.safeParse`·`validateArtifactBody`(서버 PUT `/mapping` 경로) 미검증이었음. core.`insertSlotAt` **출력 shape ↔ 서버 소비(zod)** 를 직접 parse해 4케이스(일반삽입/서버본문검증/preset부재신규/addSlot경로) 통과 확인.
2. **경계**: 빈 artifact(slots/presets/globalIndex 빈배열) 삽입, 빈 artifact에 at=99 clamp, 맨앞 at=1 전체 +1 — 3케이스.
3. **순차 다중삽입 누적 정합**: at=2로 3회 연속 삽입 후 globalIdx 1..6 연속·`validateManualIndex`·`validateCoverage`·`validateArtifactBody` 유지, slotId 유니크, positionIdx 1..5 연속.
4. **nextSlotId 전체집합 유니크**: s2 결번→s4, 타 프리셋 비간섭(2케이스).

---

## 2. 불변식 체크리스트 (계획 §검증)

### 요구 B — 슬롯 중간삽입 (순수로직)
| # | 불변식 | 상태 | 근거 테스트 |
|---|---|---|---|
| 1 | insertSlotAt 삽입 위치(atGlobalIdx 정확·이후 +1·앞쪽 불변) | ✅ | slotInsertEdit #1,#2 |
| 2 | globalIndex 연속·중복없음(validateManualIndex) + coveredSlotIds 신규 포함 + positionIdx + presets 정합 | ✅ | #3,#4,#6 / Qa 다중삽입 |
| 3 | 경계: 맨앞/맨끝/범위밖 clamp + **빈 artifact** | ✅ | #8 + **Qa 빈artifact/at=99/at=1** |
| 4 | nextSlotId 결번·충돌회피·규칙(c{cam}p{preset}s{N})·유니크 | ✅ | #10,#11 + Qa s2결번→s4/타프리셋 |
| 5 | **SetupArtifactSchema/validateArtifactBody 실제 parse 통과** | ✅ | **Qa #5 4케이스(신규 보강)** |

### 요구 A — VPD Ctrl+드래그 (순수로직)
| # | 불변식 | 상태 | 근거 |
|---|---|---|---|
| 6 | hitTestRectHandle: 8핸들+내부/외부, 코너>변>내부, tol≤ 경계, tolX/tolY 비대칭 | ✅ | slotInsertEdit #13(7건) + null방어 |
| 7 | moveRect: 평행이동 후 clamp(0~1 밖 방지), w/h 보존 | ✅ | #12(3건, 4방향 경계) |
| 8 | resizeRect 재사용 정합(handle 문자열 1:1 방향) | ✅ | roiEdit.test.ts(n/s/w/e/코너·역전정규화) |
| 9 | 회귀: 기존 roiEdit·core·전체 그린 | ✅ | 660 passed |

---

## 3. G-3(휴면 헬퍼 제거) 확인
- `hitTestHandle`/`hitTestEdge` **잔존 참조 0건** — `grep` 결과 `web/`·`src/`·`test/` 전량 없음(빌드 tsc EXIT 0으로 이중 확인).
- `drawHandles`(app.js:259) 8핸들(4코너+4변중점) 재활성 확인, `drawRoiOverlay`(app.js:190)가 선택 슬롯에 호출. `hitTestVpd`(app.js:302)가 순수 `hitTestRectHandle`에 위임(DOM/state 결합은 래퍼에만). → **직접 대체된 두 헬퍼만 제거, 회귀 없음**.

---

## 4. DOM 배선 — vitest 밖(수동확인 범위, 통과 위장 금지)
아래는 jsdom 없이 vitest로 실행 불가하여 **미커버(소스 존재만 정적 확인)**. 뷰어 브라우저 육안 확인 필요:

| 항목 | 소스 정적 확인 | 실행 검증 |
|---|---|---|
| Ctrl+드래그 리사이즈/이동 실시간 반응 | app.js:1158 ctrlKey 분기, 1161/1166/1177 kind 스위치 | ❌ 미커버(수동) |
| 8핸들 렌더(선택+roi-vehicle on) | app.js:190 drawHandles 호출 | ❌ 미커버(수동) |
| Ctrl 없을 때 기존 floor 정점/선택 회귀 | mousedown 분기 순서(Ctrl 우선) | ❌ 미커버(수동) |
| `추가` 버튼 → 생성·선택·삽입위치 | app.js:1291 wire, addSlot(339), index.html:115-116 | ❌ 미커버(수동) |
| `저장` → PUT 성공·카운트 증가 | saveMapping→PUT `/mapping` | ❌ 미커버(수동) |

- **외부 서비스(Unity/VPD/LPD/LPR/VLA) 미기동** → 실 스트림 연동 스모크 **누락(명시)**. 삭제/통과위장 없이 미수행으로 남김.
- 순수로직으로 커버 가능한 편집 수학·인덱스 재부여·스키마 정합은 위 §1~§3에서 **전량 커버**. DOM 이벤트 배선·캔버스 렌더·fetch만 수동 범위.

---

## 5. 발견 결함
- **없음.** 구현 소스 미수정. 신규/기존 테스트 전량 통과. 스키마 경계면(core 출력 ↔ 서버 zod 소비) 불일치 없음.

## 6. 알려진 한계(범위 밖 — 영향도 분석서 반영 요망)
- `insertSlotAt`로 넣은 수동 전역위치는 이후 `removeSlot`(→`rebuildGlobalIndex` 정규정렬) 호출 시 cam→preset→position 순으로 리셋될 수 있음(구현자 §5 명시, 기존 한계). QA로 재현 대상 아님(설계상 의도된 기존 동작).
