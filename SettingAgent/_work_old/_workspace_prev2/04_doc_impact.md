# 04 영향도 분석 — 차량 ROI 박스 "변(edge) 드래그" 리사이즈

- 작성일시: 2026-07-01 15:49:29 (시스템 시각)
- 대상 변경: `web/core.js` `resizeRect` case 4개 추가 · `web/app.js` `hitTestEdge` 신규 + mousedown 결선 · `test/roiEdit.test.ts` 11 케이스 추가
- 최종 문서: `SettingAgent/docs/20260701_154929_박스변드래그리사이즈.md`

---

## 1. 변경 소비처(의존성) 추적

### 1.1 `resizeRect` 소비처
- **유일 런타임 소비처**: `web/app.js` mousemove(1052줄) `resizeRect(cur, dragState.handle, ndx, ndy)`.
  - `dragState.handle`은 코너(nw/ne/sw/se) 또는 신규 변(n/s/e/w). handle 문자열 도메인이 넓어진 것뿐 시그니처·반환 shape `{x,y,w,h}` 불변 → 소비처 파싱 불일치 없음.
- **테스트 소비처**: `test/roiEdit.test.ts`(직접 import).
- 그 외 `resizeRect` 참조 없음(코너/변 공통 경로 하나만 존재).

### 1.2 `updateSlotRoi` 소비처
- `web/app.js` mousemove(1053줄)에서 `resizeRect` 결과를 받아 호출. 변경으로 **호출 방식·인자 형태 불변**.
- `updateSlotRoi`는 대상 슬롯의 `roiByPreset[key]`만 교체하고 `slots` 집합·순서·`globalIndex`는 건드리지 않음 → 아래 3절 불변성 근거.

### 1.3 드래그 결선(mousedown/move/up) 소비처
- `wireOverlayEditing` 내부에 폐쇄. `dragState` 구조 불변(코너 경로와 완전 공유). mousemove/mouseup 무수정.
- `hitTestEdge`는 `hitTestHandle`와 동일 상태(`state.selectedSlotId`, `roiByPreset[key]`, `overlay`, `HANDLE_PX`)만 읽는 신규 뷰 로직. 외부 노출·재사용 없음.

---

## 2. 기존 코너 리사이즈에 미치는 영향

- `resizeRect`의 코너 case(nw/ne/sw/se) 및 정규화·clamp 로직은 **한 줄도 변경되지 않음**. 변 case는 코너 case 위에 독립 추가되어 상호 간섭 없음.
- mousedown에서 `hitTestHandle`(코너)를 **먼저** 호출하고, `hitTestEdge`가 `inX/inY`로 코너 구간을 배제 → 코너 우선순위 이중 보장. 코너 히트 동작 회귀 없음.
- 회귀 스위트 385/385 통과(코너 케이스 포함 기존 21 케이스 유지)로 확인.

---

## 3. mapping 저장(`PUT /mapping`) · globalIndex 불변성

- **globalIndex 불변**: 변 드래그는 `updateSlotRoi`로 `roiByPreset[key]`만 수정한다. 슬롯 추가/삭제/재정렬이 없으므로 `globalIndex`(globalIdx↔slotId 매핑, 1-based)는 영향받지 않는다. `rebuildGlobalIndex`·`reorderGlobalIndex`·`applyManualGlobalIds` 경로와 무관.
- **PUT /mapping 계약 불변**: 저장은 기존 공유 `saveMapping()`이 전체 `state.mapping`을 본문으로 PUT한다. 본 변경은 새 엔드포인트·본문 스키마·서버 검증(coverage mismatch 등)을 추가하지 않는다. 서버는 변경된 `roiByPreset` 값을 기존과 동일한 rect 형태로 수신.
- **영속화 시점**: 변 드래그 mouseup은 `markDirty()`만 호출(메모리 갱신·미저장 표시). 디스크 반영은 사용자가 "저장"을 눌러 `PUT /mapping`을 태울 때만 — 기존 코너 리사이즈와 동일 흐름.

---

## 4. 공유 타입 / 크로스 에이전트 파급

- **`@parkagent/types` 영향 없음**: 순수 프론트엔드 캔버스 상호작용. SlotState/ParkingEvent 등 공유 도메인 타입, MCP 도구 스키마, REST 계약 어느 것도 변경하지 않음.
- **ActionAgent / DMAgent 파급 없음**: SettingAgent 뷰어 내부 편집 UI 한정. 산출 아티팩트(`setup_artifact.json` 등)의 스키마 변화 없음(rect 값만 사용자가 조정 가능해질 뿐, 필드 구조 동일).
- **REST 클라이언트/테스트 파급 없음**: 새 요청·응답 형태가 없어 다른 클라이언트·통합 테스트에 전파되지 않음.

---

## 5. core.d.ts 타입 선언 갱신 여부

- **결론: 갱신 불필요(변경하지 않음).**
- 근거: `web/core.d.ts` 161줄
  `export function resizeRect(rect: NormalizedRect, handle: string, ndx: number, ndy: number): NormalizedRect;`
  `handle` 파라미터가 이미 넓은 `string` 타입으로 선언되어 있어 신규 변 핸들 `'n'|'s'|'e'|'w'`를 그대로 수용한다. 코너 union(`'nw'|'ne'|'sw'|'se'`) 같은 리터럴 좁힘이 없으므로 타입 오류가 발생하지 않으며, 추가할 union도 없다.
- (참고) `hitTestEdge`는 `app.js` 내부 함수라 `core.d.ts` 선언 대상이 아님.
- 외과적 원칙에 따라 `core.d.ts`를 포함해 그 외 코드는 수정하지 않았다.

---

## 6. 회귀 위험 평가

| 항목 | 위험도 | 근거 |
|------|--------|------|
| 코너 리사이즈 회귀 | 낮음 | 코너 로직 무변경 + 호출 순서/구간 배제 이중 보장, 385/385 통과 |
| resizeRect 뒤집힘·경계 붕괴 | 낮음 | 기존 min/abs·clamp01Rect 재사용, clamp/뒤집힘 케이스(7·8·9·10) 검증 |
| 슬롯 선택/해제 오작동 | 낮음 | handle 미스 시 기존 `hitTestSlots` 경로 그대로, 결선 2줄만 추가 |
| DOM 히트테스트 정확도 | 중간(자동검증 불가) | `hitTestEdge`는 vitest 미검증 → **수동 동작확인 필수**(문서 6.2 체크리스트) |
| globalIndex/저장 계약 파손 | 없음 | `roiByPreset[key]`만 갱신, PUT 경로·스키마 불변 |

---

## 7. 영향 받는 파일 목록(구체)

- 변경됨: `SettingAgent/web/core.js`, `SettingAgent/web/app.js`, `SettingAgent/test/roiEdit.test.ts` (git status M 3건).
- 간접 연관(무변경, 계약 유지 확인 대상): `SettingAgent/web/core.d.ts`(타입 갱신 불필요), `PUT /mapping` 라우트(본문 스키마 불변), `updateSlotRoi`/`rebuildGlobalIndex` 등 core.js 순수 함수(호출 방식 불변).
- 파급 없음: `@parkagent/types`, ActionAgent, DMAgent, MCP 도구/REST 클라이언트.

---

## 8. 확인 필요(단정 회피)

- `hitTestEdge`·mousedown 결선의 실제 브라우저 동작(변 히트/코너 우선/선택 한정/얇은 박스)은 **자동 검증 대상이 아님**. 문서 6.2 체크리스트로 수동 확인이 완료되어야 "동작 확인(규칙 #3)"이 충족된다. 현재는 순수 함수(resizeRect)만 자동 검증 통과 상태.
