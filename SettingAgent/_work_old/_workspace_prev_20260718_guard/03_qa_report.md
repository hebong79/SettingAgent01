# 03 검증(QA): finalize 방어 가드 + 선행 타입에러 정리

검증자(qa-tester). 실 SqliteStore(:memory:) + 실 Finalizer 왕복. 통과 위장 없음 — 아래는 실제 실행 결과.

## 결과 요약
- `npm run typecheck`(tsc --noEmit): **exit 0**(에러 0). 선행 2건 해소 + Finalizer 변경 무에러 확인.
- 전체 `npx vitest run`: **Test Files 157 passed / Tests 1734 passed**. 실패 0, 회귀 0.
- 신규 테스트: `test/finalizerPreserveDetection.test.ts` — **4 케이스 전부 통과**.

## 작업 1: 방어 가드 유닛테스트(신규)
파일: `test/finalizerPreserveDetection.test.ts`. `finalizerParkingSlots.test.ts` 셋업 패턴 최소 복제(mem 스토어·FK 시드·PtzCamRoi 파일·snapshotFromDets). 실 finalize → getSlotSetup 재조회로 검증.

| # | 케이스 | 검증 내용 | 결과 |
|---|--------|-----------|------|
| 1 | 보존(핵심) | 1차 finalize(hit)로 slot1 vpd/lpd/occupy 적재 → 2차 finalize(검출0, accepted=0) → 재조회 시 vpd/lpd/occupy **null 아님 + 1차 값과 동일**(재직렬화 왕복 일치) | 통과 |
| 2 | 갱신(회귀0) | 1차 bbox(0.3) → 2차 bbox(0.32) 동일 폴리곤 hit → vpd.x=0.32(새 값), 0.3 아님. lpd 갱신 | 통과 |
| 3 | 혼합 | 1차 slot1(polyA)·slot2(polyB) 모두 채움 → 2차 slot1만 hit → slot1 갱신(0.32) / slot2 기존 보존(0.7, lpd·occupy 동일) 동시 | 통과 |
| 4 | 신규 슬롯 | 선적재 없음 + 검출0 finalize → 행 생성되나 vpd/lpd/occupy=null(파괴 아님, 정상 강등). roi 는 파일 폴리곤으로 저장 | 통과 |

accepted=0 은 빈 dets 스냅샷(`emptySnapshot`)으로 구현 — aggregate([]) → 빈 집계 → 배정 hit 없음. 가드 로직(`prev = existingBySlot.get(sp.idx)`)이 slotId 키로 기존행을 찾아 재직렬화 보존함을 실측 확인.

## 작업 2: 선행 타입에러 2건 정리
파일: `test/dbOverlayParity.test.ts`(직전 세션 산출물). **의도·검증 로직 보존, import/캐스트만 교정. 프로덕션(core.js/app.js) 무변경.**

1. `TS2459`(10,29): `NormalizedQuad` 를 `../src/capture/types.js` 에서 import했으나 그 모듈은 재수출 안 함(로컬 import만).
   → `DetectionRow` 는 capture/types.js 유지, `NormalizedQuad` 는 `../src/domain/types.js`(= `@parkagent/types` 재수출처)에서 import하도록 분리.
2. `TS2345`(133,28): `toPixelQuad(row.occupyRange!, …)` — occupyRange 는 `NormalizedPoint[]`(N점 폴리곤)이나 toPixelQuad 선언은 `NormalizedQuad`(4-tuple). 런타임은 N점 매핑 정상.
   → `as unknown as NormalizedQuad` 최소 캐스트 + 사유 주석. 런타임 동작 불변.

교정 후 `dbOverlayParity.test.ts` 런타임 테스트도 정상 통과(전체 스위트 포함).

## 경계면 교차 비교(shape)
- slot_setup 저장 shape ↔ getSlotSetup 파싱 shape: vpd={x,y,w,h} / lpd=quad(4점) / occupyRange=폴리곤(NormalizedPoint[]). 보존 시 `JSON.stringify(prev.*)` 재직렬화 → 파싱 왕복 동일함을 케이스1에서 `toEqual` 로 확인.
- 키 정합: 보존 조회 키(slotId) = 신규 `sp.idx`(둘 다 normalizeGlobalIdx 멱등) → 동일 파일 재-finalize 시 안정 매칭. 케이스1~3에서 실측 일치.

## 회귀/누락
- 회귀: 없음(기존 finalizerParkingSlots 등 전량 그린).
- 스모크: 해당 없음(외부 REST 미개입, 순수 DB/finalize 경로).
