# 10. 구현(3차) — D-1 수정: LPD 필터 (B)항 중심 정의를 소비처와 일치

**대상 결함**: `08_qa_report_lpd.md` §3.2 **D-1** — 검증자가 반례로 봉인.
**리더 확정 방침**: (B) 항의 중심 정의를 소비처(`web/core.js:computeOccupancy`)와 동일한 **4점 평균(quadCentroid)** 으로 통일. `web/core.js` 무변경, (A) 귀속 항 무변경.

---

## 1. 무엇이 문제였나 (한 줄)

```
서버 (B)항 :  center(quadBoundingRect(quad))   ← bbox 중심
소비처      :  quadCentroid(quad)              ← 4점 평균     ★ 정의가 달랐다
```

(B) 항의 **유일한 존재 이유가 점유 회귀 방지**인데, 소비처가 4점 평균으로 점유를 판정하는 동안 필터는 bbox 중심으로 드롭 여부를 정했다.
→ *4점평균은 폴리곤 안 · bbox중심은 밖* 인 비아핀 quad 를 서버가 지워버리고, 그 번호판은 원래 `occupied=true` 를 만들던 것 → **점유가 경고 없이 false 로 뒤집힌다**(HANDOFF §2-3 "조용한 폴백/실패 금지" 위반).

직사각형·회전 OBB 에서는 두 정의가 **정확히 일치**해 실데이터에서 잠복했다(리더 라이브 3회 미발동).

---

## 2. 변경 파일

| 파일 | 변경 |
|---|---|
| `src/domain/geometry.ts` | **신규** `quadCentroid(q: NormalizedQuad): NormalizedPoint` — 4점 산술평균. `web/core.js:quadCentroid` 와 **동일 누산 순서**(비트 동일). |
| `src/capture/onPlaceFilter.ts` | (B) 항이 `quadCentroid` 사용. 고아가 된 import `center`·`quadBoundingRect` 제거. 주석에 D-1 근거 명시. **(A) 항 무변경.** |
| `test/quadCentroidParity.test.ts` | **신규 11건** — 서버 ≡ 뷰어 파리티 봉인. |
| `test/onPlaceFilter.test.ts` | **P7 방향 전환**(아래 §4 — 이 테스트가 구 버그를 얼어붙여 놓고 있었다). |
| `test/lpdFilterRegression.test.ts` | ★★ 반례를 **해소 단언**으로 갱신(삭제 아님) + **일반 명제** 1건 신규. |
| `web/core.js` | **무변경**(지시대로 — 서버를 소비처에 맞췄다). |
| `src/capture/Aggregator.ts` / `Finalizer.ts` | **무변경**(D-2 는 코드 수정 대상 아님). |

핵심 diff:

```ts
// onPlaceFilter.ts:87-92
const kept = plates.filter((p) => {
  if (attached.has(p.quad)) return true;          // (A) 무변경 — 차량 귀속이지 점유가 아니다
  const c = quadCentroid(p.quad);                 // (B) ← 소비처와 **동일** 중심 정의
  return polys.some((poly) => pointInPolygon(poly, c));
});
```

---

## 3. D-1 이 해소된 근거

설계서 §1 의 보장은 원래 이것이었다:

> **필터가 제거하는 번호판은 점유를 참으로 만들 수 없는 것뿐** → 점유 회귀 0

(B)가 소비처와 **같은 중심 정의**를 쓰는 순간 이 명제는 **정의상 참**이 된다:

- (B)가 드롭 ⟹ `quadCentroid(quad) ∉ 모든 주차면 폴리곤`
- `computeOccupancy` 가 occupied=true 로 만들려면 ⟹ `quadCentroid(quad) ∈ 어떤 폴리곤`
- 두 조건은 **동일한 술어의 부정**이다 → 드롭된 번호판이 점유를 참으로 만들 **수 없다**. **ε 예외 소멸.**

역방향(bbox중심 안 · 4점평균 밖 → 이제 드롭됨)은 **무해**하다: 그 번호판은 소비처 기준으로도 폴리곤 밖이라 애초에 점유를 참으로 만들지 못한다. (P7 이 이 무해성을 직접 단언한다.)

### ★ 이 명제를 반례 1건이 아니라 **성질로** 봉인했다
`test/lpdFilterRegression.test.ts` 신규 「일반 명제」: 폴리곤 경계 근방(구 ε 위험대)에 무작위 quad **300개**를 뿌리고,
**드롭된 번호판 중 소비처 점유를 참으로 만드는 것이 0건**임을 단언. 공허참 방지로 `filteredOut > 0` · `kept > 0` 도 함께 단언.

---

## 4. ★ 계획에 없던 발견 — P7 이 구 버그를 얼어붙여 놓고 있었다 (보고 필수)

리더 지시는 갱신 대상으로 `test/lpdFilterRegression.test.ts` 만 지목했으나, **`test/onPlaceFilter.test.ts:293` P7 이 D-1 을 그대로 단언하고 있었다**:

```ts
// 수정 전 P7 (구 버그를 "사양"으로 못 박고 있었다)
it('★ P7 (중심 정의) — 비대칭 quad 는 quadBoundingRect+center 로 판정(4점 평균이 아니다)', ...)
expect(r.kept).toEqual([p]); // 서버는 bbox 중심 정의를 쓴다   ← 이 단언이 D-1 그 자체
```

이 테스트를 그대로 두면 수정이 **테스트 실패로 거부**된다. 삭제하지 않고 **방향을 뒤집어** 갱신했다 —
"(B)는 quadCentroid 로 판정한다 → 이 skew quad 는 drop 되고, **그 drop 은 무해하다**(소비처 기준으로도 폴리곤 밖)".
같은 quad·같은 전제를 유지한 채 결론만 바꿔, 구 사양이 무엇이었고 왜 틀렸는지가 테스트에 남는다.

---

## 5. 파리티 봉인 (`test/quadCentroidParity.test.ts`, 11건)

선례 `test/globalIdxParity.test.ts` 를 따랐다. 서버 `domain/geometry.ts:quadCentroid` ≡ 뷰어 `web/core.js:quadCentroid` 를 **동일 입력 → 동일 출력**(`toEqual` = 비트 동일, 근사 아님)으로 단언:

| 케이스 | 의도 |
|---|---|
| 축정렬 직사각형 | 정상 |
| 회전 OBB **24각도 스윕** | 아핀 — 두 정의가 일치하는 영역 |
| 기울어진 keystone(원근) | 비아핀 실측형 |
| **★ D-1 반례 스파이크 quad** | 문제를 일으켰던 바로 그 입력 |
| 퇴화(4점 붕괴 / 4점 일직선) | 면적 0 — 면적가중 centroid 가 무너지는 지점 |
| 경계값(0/1 코너), 점순서 역방향 | 클램프·순서 무관성 |
| 무작위 quad **200개** | 광범위 스윕 |
| **혼동 방지 2건** | `quadCentroid` ≠ `center∘quadBoundingRect`, `quadCentroid` ≠ `polygonCentroid`(면적가중) 를 **명시적으로 단언** |

마지막 2건은 리더가 경고한 함수 혼동(`polygon.ts:polygonCentroid` 는 **면적가중**으로 다른 함수)을 코드로 못 박은 것이다.

---

## 6. 게이트 결과 — 있는 그대로

```
$ npx tsc -p tsconfig.json --noEmit
TSC_EXIT=0                       # 출력 없음

$ npx vitest run
 Test Files  135 passed (135)
      Tests  1491 passed (1491)
```

검증자 2차 기준선(134 files / 1479 tests) 대비 **+1 file / +12 tests** = 파리티 11 + 일반명제 1. 산술 일치. **실패·스킵 0건.**

### ★ 테스트가 공허하지 않음을 경험적으로 확인
"새 테스트가 구 구현을 실제로 잡는가"를 확인하기 위해 (B)를 **bbox 중심으로 되돌리고** 돌렸다:

```
× P7 (onPlaceFilter)                    AssertionError: expected [ {quad…} ] to have a length of +0 but got 1
× ★★ D-1 해소 (lpdFilterRegression)      AssertionError: expected [] to have a length of 1 but got +0
× ★ 일반 명제 (무작위 300 quad)          AssertionError: expected [ …(10) ] to have a length of +0 but got 10
   Tests  3 failed | 35 passed
```

→ 정확히 3건이 실패한다(그리고 수정본에서는 통과). 특히 **일반 명제가 구 구현에서 10건**을 잡아냈다 —
D-1 은 손으로 만든 quad 1개짜리 이론적 구멍이 아니라, 경계 근방 비아핀 quad 분포에서 **재현성 있게 도달 가능한 결함**이었다.
확인 후 수정본을 복원했고, 위 게이트(135/1491)는 **복원 상태에서 재실행한 결과**다.

---

## 7. 남은 한계 (은닉 금지)

1. **라이브 미검증**: 이번 수정은 유닛·파리티 레벨에서만 확인했다. 리더 라이브(`09_leader_empirical_lpd.md`)는 **수정 전** 코드였고, 거기서는 실 LPD quad 가 아핀에 가까워 D-1 이 발동하지 않았다. 수정 후 라이브 재확인 시 **점유 집합이 동일하게 유지되어야 한다**(회귀 없음). 실 LPD quad 가 아핀에 가까우므로 **라이브 산출은 수정 전후 동일할 가능성이 높다** — 즉 라이브는 이 수정의 효과를 **관측하지 못할 수 있다**(그것이 정상이다. 이 수정은 원리적 구멍을 막은 것이지 현재 증상을 고친 것이 아니다).
2. **★ `quadCentroid` 3중 구현 — 정리하지 않았다**: `src/capture/Aggregator.ts:118` 과 `src/capture/Finalizer.ts:35` 에 **이미 private `quadCentroid` 사본**이 있다(둘 다 4점 평균, 내가 추가한 것과 정의 동일). 이제 서버에만 사본이 3개다.
   - **건드리지 않은 이유**: 리더가 Aggregator 무변경을 지시했고, CLAUDE.md §3(외과적 변경 / 기존 데드·중복 코드는 언급만 하고 삭제 금지)에 따랐다.
   - **그러나 이것이 D-1 을 낳은 바로 그 패턴이다**(같은 개념의 사본이 갈라짐). 두 사본을 `domain/geometry.ts:quadCentroid` import 로 교체하는 것은 순수 no-op 리팩토링이며, **후속 과제로 등록을 권고**한다(리더 판단 필요).
3. **(A) 항은 여전히 bbox 중심**: 의도된 것이다(차량 귀속 ≠ 점유). 다만 "서버 안에 중심 정의가 2개"라는 사실은 남는다 — (A)와 (B)가 서로 다른 중심을 쓴다는 점을 주석에 명시했다.
4. **설계서 §7-4(A·B 동시 실패)** 는 이 수정과 무관하게 **그대로 유효**하다: VPD 미검출 + 번호판 중심이 폴리곤 밖 → 드롭(점유 뒤집힘). 관측 불가·미봉인.
5. **D-2 무조치**: 지시대로 코드 수정하지 않았다(문서 정정 소관). `lpdFilterRegression.test.ts` 의 D-2 반례 테스트는 **그대로 유효하며 통과한다**(손실 0·개선 방향).
