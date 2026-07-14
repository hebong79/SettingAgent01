# 04 영향도 분석 — VPD Ctrl+드래그 편집 & 슬롯 전역 중간삽입

작성일: 2026-07-03 22:40:43 · 문서화·영향도 분석가(documenter)
근거: `01_architect_plan.md` · `02_developer_changes.md` · `03_qa_report.md` + 실제 변경 소스 정독
상세 문서: `SettingAgent/docs/20260703_224043_뷰어_VPD편집_슬롯중간삽입.md`

---

## 1. 영향 모듈 (의존성 그래프)

변경은 **뷰어 프런트(`web/`)에 국한**된다. 서버·타입·DB로의 전파 없음.

```
web/core.js  ── (신규 export 4) ──▶ web/core.d.ts (타입 선언 1:1)
     │                                    │
     └── import ─────────────────────────┴──▶ web/app.js (이벤트·렌더 배선)
                                                   │
                                          index.html / app.css (DOM·스타일)
                                                   │
                                          PUT /viewer/api/mapping  ← 기존 계약(무변경)
                                                   │
                                          src/api/server.ts saveMappingHandler
                                                   │
                                          validateArtifactBody(zod + validateCoverage)
                                                   │
                                          repo.saveArtifact (DB)
```

| 모듈 | 영향 | 근거 |
|---|---|---|
| `web/core.js` | 신규 순수함수 4개 export(가산). 기존 export 무변경 | 순수 가산, 기존 함수 시그니처·동작 불변 |
| `web/core.d.ts` | 신규 4함수 타입 + `RectHandle` 유니온 선언(가산) | core.js와 1:1, 런타임 무변경 |
| `web/app.js` | mousedown/mousemove 배선, `hitTestVpd`/`addSlot` 신규, `drawHandles` 확장, `hitTestHandle`/`hitTestEdge` 제거 | Ctrl 배타 분기로 기존 인터랙션 보존 |
| `web/index.html` | `#slot-insert-idx`·`#slot-add` 가산 | `.roi-edit-bar` 요소 추가만 |
| `web/app.css` | `.slot-insert-idx` 폭 스타일 가산 | 기존 규칙 무영향 |

### 전파되지 않는 경계 (근거 명시)

- **`src/**` 서버 전량 무변경**: 슬롯 추가·VPD 편집 결과는 `state.mapping`(메모리)에만 반영되고, 영속화는 **기존** `PUT /viewer/api/mapping`(전체 artifact 본문)을 그대로 재사용한다. 신규 라우트·핸들러·검증 로직 없음. `saveMappingHandler`·`validateArtifactBody`·`SetupArtifactSchema`·`validateCoverage`는 소비만 하고 무수정.
- **`@parkagent/types`(packages/types) 무변경**: `ParkingSlot`/`Preset`/`GlobalSlotIndex` 도메인 타입을 **읽기만** 하며 스키마 확장 없음. → 이 타입에 의존하는 다른 에이전트(ActionAgent/DMAgent)로의 전파 없음.
- **DB/저장 포맷 무변경**: `insertSlotAt` 출력은 기존 `SetupArtifactSchema` 형태를 그대로 만족(QA #5 실 parse 교차검증 통과). setup_artifact 스키마 변경 없음.

---

## 2. 하위호환성

- **기존 편집 인터랙션 무영향**: floor 정점편집·슬롯 선택/해제는 `Ctrl 없음` 경로로만 도달하고, VPD 편집은 `Ctrl 누름` 경로에서만 동작 → **물리적 배타**. 기존 mousedown 분기 순서 뒤에 위치하지 않고 앞에 위치하지만, Ctrl 게이팅으로 Ctrl 미사용 시 기존 분기로 그대로 낙하한다.
- **mouseup 무변경**: kind 무관 공통 로직 유지.
- **기존 artifact 로드·저장 무변경**: 신규 필드 없음. 기존 산출물을 로드해 편집·저장하는 경로에 영향 없음.
- **제거된 `hitTestHandle`/`hitTestEdge`**: 잔존 참조 0건(grep + tsc EXIT 0 이중 확인) → 제거로 인한 회귀 없음. 두 함수는 신규 `hitTestRectHandle`이 직접 대체.

---

## 3. 기존 한계 명시 (구현자 인계 — 후속 고려)

- `insertSlotAt`로 넣은 **수동 전역위치**는 이후 `removeSlot`(→ `rebuildGlobalIndex`가 cam→preset→position 정규순서로 재생성) 호출 시 **정규순서로 리셋될 수 있다**. 즉 "중간삽입으로 지정한 전역 위치"와 "삭제 후 재생성되는 정규 전역 순서"는 서로 다른 정책이며, 삭제가 일어나면 후자가 이긴다.
- 이는 **기존 `removeSlot` 동작에서 비롯한 기존 한계**이며 본 작업 범위 밖이다. QA는 재현 대상으로 삼지 않았다(설계상 의도된 기존 동작). 수동 전역위치의 영속 보존이 요구되면 `removeSlot`의 재정렬 정책 재설계가 필요하다.

---

## 4. 리스크 · 후속

| 구분 | 내용 | 상태 |
|---|---|---|
| DOM 육안 확인 | Ctrl+드래그 실반응·8핸들 렌더·`추가`/`저장` 버튼·PUT 성공은 jsdom 밖 → 뷰어 브라우저 수동확인 필요 | **후속(미검증)** |
| 실 스트림 스모크 | 외부 서비스(Unity/VPD/LPD/LPR/VLA) 미기동 → 실 연동 스모크 누락 | **후속(미수행)** |
| 전역위치 리셋 | §3 removeSlot 상호작용 | 기존 한계, 범위 밖 |
| 순수로직 회귀 | 660 passed, tsc EXIT 0, 회귀 0 | **통과** |

---

## 5. 변경 파일 표

| 파일 | 변경 요지 | 영향 범위 |
|---|---|---|
| `web/core.js` | 신규 `nextSlotId`/`insertSlotAt`/`moveRect`/`hitTestRectHandle` | 가산, 하위호환 |
| `web/core.d.ts` | 위 4함수 타입 + `RectHandle` 선언 | 가산, 런타임 무변경 |
| `web/app.js` | mousedown Ctrl 분기·mousemove kind 스위치·`hitTestVpd`/`addSlot` 신규·`drawHandles` 8핸들 확장·`hitTestHandle`/`hitTestEdge` 제거 | 뷰어 편집 UX(Ctrl 배타로 기존 보존) |
| `web/index.html` | `#slot-insert-idx`·`#slot-add` 가산 | 가산 |
| `web/app.css` | `.slot-insert-idx` 폭 | 가산 |
| `test/slotInsertEdit.test.ts` | 신규 23건 | 테스트만 |
| `test/slotInsertEditQa.test.ts` | 신규 10건 | 테스트만 |
| `src/**` · `@parkagent/types` · DB | **무변경** | PUT `/mapping` 계약·도메인 타입·스키마 재사용 |
