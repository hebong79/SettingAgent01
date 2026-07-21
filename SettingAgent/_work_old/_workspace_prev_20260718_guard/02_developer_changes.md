# 02 구현: finalize 방어 가드 — 검출 없는 슬롯의 기존 vpd/lpd/occupy 보존

구현: 구현자. 설계서 `01_architect_plan.md`(A 선형) 그대로. 스코프: `src/capture/Finalizer.ts` 단일 파일.

## 변경 파일
- `src/capture/Finalizer.ts` — 3곳(외과적).

## 변경 함수
`Finalizer.finalize` 의 slot_setup 행 조립 블록(try/catch best-effort 내부).

## 핵심 diff
1. **import 추가**(line 23): `SlotSetupView` 를 `./types.js` import 목록에 추가.
   ```ts
   import type { AggregatedSlot, SlotSetupRow, SlotSetupView } from './types.js';
   ```
2. **기존 slot_setup 조회**(place 확인 직후, byPresetAcc 조립 전): slotId 키 맵 1회 조회.
   ```ts
   const existingBySlot = new Map<number, SlotSetupView>();
   for (const v of this.deps.store.getSlotSetup()) existingBySlot.set(v.slotId, v);
   ```
3. **세 검출 컬럼 else절만 prev 보존**(`spaces.forEach` 내): `const prev = existingBySlot.get(sp.idx);` 추가 후
   ```ts
   vpdBbox: hit ? JSON.stringify({ x: hit.x, y: hit.y, w: hit.w, h: hit.h }) : (prev?.vpd ? JSON.stringify(prev.vpd) : null),
   lpdObb: hit?.plateQuad ? JSON.stringify(hit.plateQuad) : (prev?.lpd ? JSON.stringify(prev.lpd) : null),
   occupyRange: occupyRange ? JSON.stringify(occupyRange) : (prev?.occupyRange ? JSON.stringify(prev.occupyRange) : null),
   ```

## 동작
- hit 있는 슬롯: 새 검출로 갱신(기존과 동일 — 회귀 0, 해피패스 바이트 동일).
- hit 없는 슬롯 + 기존행 존재: 기존 vpd/lpd/occupyRange 재직렬화 보존(빈 finalize 파괴 방지).
- hit 없음 + 기존행 없음: null(정상 신규, 파괴 아님).
- `getSlotSetup()` 파싱형(vpd={x,y,w,h}/lpd=quad/occupyRange=폴리곤) → `JSON.stringify` 재직렬화, 저장 shape 왕복 동일.

## 불변식 준수
- `replaceSlotSetup`·`getSlotSetup`·SlotSetupRow/View 시그니처 불변.
- 병합 조회/조립 전부 기존 try/catch(best-effort 격리) 안 → 예외가 artifact 저장/finalize 성공 불방해.
- pan/tilt/zoom/centered/img1 은 기존 그대로(null/0) — 이번 스코프 밖(센터라이징 컬럼).
- 키 정합: 기존 slotId 와 신규 `sp.idx` 둘 다 `normalizeGlobalIdx` 멱등 적용 → 안정 매칭. 불일치 시 null(안전 강등).

## 설계 대비 편차
- 없음. 설계서 §설계 1~4 그대로 구현.

## typecheck 결과
- `npm run typecheck`: **내 변경(Finalizer.ts) 신규 에러 0**.
- 잔존 에러 2건은 **내 스코프 밖 선행 결함** — 미추적(untracked) 테스트 파일 `test/dbOverlayParity.test.ts`:
  - `TS2459` `NormalizedQuad` 가 `../src/capture/types.js` 에서 export 안 됨(테스트가 잘못 import).
  - `TS2345` `NormalizedPoint[]` → `NormalizedQuad`(4-tuple) 대입 불가.
  - stash 후 typecheck 에서도 동일 재현(내 변경과 무관). qa/리더 판단 필요 — 이번 가드 스코프(Finalizer 단일 파일)를 벗어나 손대지 않음.

## qa 인계
- 유닛테스트 대상: `Finalizer.finalize` 내 병합 로직(별도 헬퍼 미분리 — 과설계 회피, finalize 내 노출).
- 설계서 §테스트 1~5 시나리오(보존/갱신/혼합/신규/기존회귀) 검증 요망.
- 주의: `test/dbOverlayParity.test.ts` 선행 타입에러가 전체 스위트 그린을 막을 수 있음 — 별도 처리 필요.
