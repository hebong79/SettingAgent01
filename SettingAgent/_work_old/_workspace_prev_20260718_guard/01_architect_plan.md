# 01 설계: finalize 방어 가드 — 검출 없는 최종화가 기존 vpd/lpd/occupy를 파괴하지 않게

작성: 리더(현자 라). 실행 모드: **A(선형 파이프라인)** — 순수 로직·유닛테스트로 성공 확정 가능.

## 문제(근본원인, 확정)
- `Finalizer.finalize`는 파일 바닥ROI(PtzCamRoi.json)의 슬롯 전량에 대해 `SlotSetupRow`를 만들고 `store.replaceSlotSetup(rows)`(DELETE 후 전량 INSERT)로 교체한다([Finalizer.ts:195-229](../src/capture/Finalizer.ts#L195), [SqliteStore.ts:189-207](../src/capture/SqliteStore.ts#L189)).
- 각 행의 `vpdBbox/lpdObb/occupyRange`는 `hit`(그 슬롯에 배정된 검출 클러스터) 있을 때만 채우고 없으면 **null**.
- 따라서 검출 매칭이 0인 finalize(짧은 캡처·차량 미검출·주차면필터 전량제거 → `accepted=0`)가 한 번 돌면 **직전에 저장됐던 정상 vpd/lpd/occupy(예: 66d9042 라이브 17/17)를 전부 null로 덮어써 파괴**한다.
- 이 파이프라인 코드는 이번 세션에서 미변경(회귀 아님). 방어 가드만 추가한다.

## 목표(검증가능 성공기준)
- **검출 hit이 없는 슬롯은 기존 slot_setup의 vpd/lpd/occupy를 보존**한다(null로 덮지 않음).
- 검출 hit이 있는 슬롯은 기존대로 새 검출로 갱신(회귀 0 — 66d9042 해피패스 동일).
- 완전 빈 finalize(accepted=0)는 기존 검출 데이터를 전혀 파괴하지 않는다.
- 바닥 geometry(slot_roi) 및 artifact 저장은 기존대로 동작.

## 설계 (Finalizer 내부 병합 — replaceSlotSetup 시맨틱 불변)
`replaceSlotSetup`은 전량교체 계약 유지(migrateToSettingDb·테스트 무영향). 병합은 **Finalizer.finalize 의 slot_setup 행 조립부**에서만 한다.

1. slot_setup 행 조립 **전에** 기존 데이터를 읽는다: `const existing = this.deps.store.getSlotSetup();` → `Map<number, SlotSetupView>`(key=slotId).
2. 각 슬롯 행 조립 시(현재 [Finalizer.ts:205-227](../src/capture/Finalizer.ts#L205) `spaces.forEach`):
   - `const prev = existingBySlot.get(sp.idx);`
   - `vpdBbox: hit ? JSON.stringify({x,y,w,h}) : (prev?.vpd ? JSON.stringify(prev.vpd) : null)`
   - `lpdObb: hit?.plateQuad ? JSON.stringify(hit.plateQuad) : (prev?.lpd ? JSON.stringify(prev.lpd) : null)`
   - `occupyRange: occupyRange ? JSON.stringify(occupyRange) : (prev?.occupyRange ? JSON.stringify(prev.occupyRange) : null)`
   - 즉 **hit 있으면 새 값, 없으면 기존값 보존, 둘 다 없으면 null**.
   - `getSlotSetup()`은 파싱형(vpd={x,y,w,h}/lpd=quad/occupyRange=폴리곤) 반환 → `JSON.stringify` 재직렬화(왕복 동일 shape, [types.ts SlotSetupView](../src/capture/types.ts) 근거).
3. **키 정합**: 기존 행 slotId 와 신규 `sp.idx` 는 둘 다 동일 파일에 `normalizeGlobalIdx` 적용(멱등) → 안정 매칭. 불일치 시 preservation 미적용(null) — 파괴 아님(안전 강등).
4. **범위 한정(스코프)**: 이번 가드는 **검출 컬럼(vpd/lpd/occupy)만** 보존. 센터라이징 컬럼(pan/tilt/zoom/centered/img1)은 **기존 동작 유지**(finalize 시 null → 이후 /calibrate 재적용, 설계 §185 주석). 센터라이징도 같은 파괴 취약점이 있으나 "finalize 후 재센터링" 기존 흐름 존중 — 별도 판단 필요분으로 문서에 명시(이번 스코프 밖).

## 불변식 / 회귀 가드
- `replaceSlotSetup`·`getSlotSetup` 시그니처 불변 → migrateToSettingDb·기존 테스트 무영향.
- hit 있는 슬롯: 결과 동일(회귀 0). 해피패스(전 슬롯 hit) = 기존과 바이트 동일.
- best-effort 격리 유지: getSlotSetup/조립 예외는 기존 try/catch(§231) 안 → artifact 저장 불변.
- CLAUDE.md 외과적: forEach 3줄만 조건부 확장 + 상단 existing 조회 1회. 인접 리팩토링 금지.

## 테스트(vitest) — qa
1. **보존(핵심)**: DB에 vpd/lpd/occupy 채워진 slot_setup 선행 저장 → 검출 0(accepted=0)인 finalize 실행 → getSlotSetup 재조회 시 **기존 vpd/lpd/occupy 유지**(null 아님) 검증.
2. **갱신(회귀0)**: 검출 hit 있는 finalize → 해당 슬롯 새 검출로 갱신(기존 값 대체) 검증.
3. **혼합(부분)**: 일부 슬롯만 hit → hit 슬롯 갱신 / 무-hit 슬롯 기존 보존 동시 검증.
4. **신규 슬롯**: 기존 행 없는 슬롯 + hit 없음 → null(파괴 아님, 정상).
5. 기존 `finalizerParkingSlots.test.ts` 회귀 0 + 전체 스위트 그린.

## 경험적 검증(리더)
- 서버 13020 재기동 후(src 변경 nodemon 감지) 실제 재현: 현재 null인 실 DB에 대해 정상 데이터 복구는 재캡처 필요(별개) — 가드는 "이후 빈 finalize가 파괴 안 함"을 유닛으로 확정. 실 DB 파괴 재현/방지는 로그·왕복으로 확인.
