# 13. 구현 변경 — 점유영역 사다리꼴 → 평행사변형

**작업**: 마스터 지시 "평행으로 해줘" — 점유영역의 위 변 폭을 아래 변 폭과 동일하게 만들어 평행사변형으로 전환.
**일자**: 2026-07-16
**범위**: 상수 1개 + 짝 타입선언 JSDoc + 테스트 갱신/추가. 로직 무변경.

## 1. 변경 파일

| 파일 | 변경 |
|------|------|
| `SettingAgent/web/occupancyRegion.js` | `DEFAULTS.topWidthRatio` **0.85 → 1.0** (+ 근거 주석 1줄, `buildTrapezoid` JSDoc 1줄 정정) |
| `SettingAgent/web/occupancyRegion.d.ts` | `RegionConfig.topWidthRatio` JSDoc 기본값 표기 갱신 |
| `SettingAgent/test/occupancyRegion.test.ts` | **T4** 기준 1.0 으로 갱신, **T4b 신규**(판별력 보존) |

### 변경 상수

```js
// web/occupancyRegion.js — DEFAULTS
topWidthRatio: 1.0, // 1.0 = 평행사변형(마스터 지시). 번호판은 수직면이라 위(−v̂)는 먼 쪽이 아니라 높은 쪽 → 원근 수축 근거 없음.
```

다른 파라미터(`widthScaleMin/Max` 3.5/4.0, `upRatio` 0.90, `downRatio` 0.30, `scaleQuantum`, `areaEps`, `shrinkFactor`, `maxShrinkIters`, `minScale`)와 탐색 로직은 **일절 손대지 않음**(규칙 3 외과적 변경).

## 2. 근거 (오케스트레이터 결정 원문)

기존 0.85 의 근거는 설계 01 §2-3 의 "카메라가 내려다볼 때 먼 쪽(위)이 원근상 좁다"였다. 그러나 **번호판은 수직면이라 사다리꼴의 '위'(−v̂ 방향)는 더 먼 곳이 아니라 더 높은 곳**이며, 카메라를 향한 수직면에서 위로 갈수록 폭이 좁아질 기하적 이유가 없다. 마스터가 평행사변형을 명시 지시했고, 근거도 그쪽이 깔끔하다.

## 3. 함수명·용어 처리

`buildTrapezoid` 는 **개명하지 않았다**. 평행사변형은 사다리꼴의 특수형(포함적 정의)이고, 개명은 `app.js`·테스트·d.ts·문서에 걸친 광범위한 churn 이라 규칙 3 위반이다.

대신 "사다리꼴"이라고만 서술해 오해를 유발하는 **`buildTrapezoid` JSDoc 1지점만** 최소 정정(밀도·문체 유지):

```
 * 축·배율 → 사다리꼴 4점 [TL,TR,BR,BL](미클램프, 설계 §2-2). topWidthRatio 기본 1.0 → 실제 형상은
 * 평행사변형(사다리꼴의 특수형); 비-1.0 을 cfg 로 주면 일반 사다리꼴이 된다.
```

파일 헤더·`computeOccupancyRegions` JSDoc·`app.js` 주석의 "사다리꼴" 표현은 포함적 정의상 여전히 참이므로 유지(불필요한 diff 억제).

## 4. 갱신 테스트와 판별력 보존

### T4 (갱신)
`describe('buildTrapezoid — 사다리꼴 4점(§2-2)')` 내 **T4** 가 설계 01 §6 의 "폭비: |TR−TL| = 0.85 × |BR−BL|" 를 하드코딩 단언하고 있었다 → **1.0 기준**으로 갱신(제목·단언·주석). 아래 변 길이 단언(`bw = s·W = 4.0×0.04`)과 볼록성 단언(연속 변 외적 부호 동일 — 평행사변형에서도 성립)은 그대로.

### T4b (신규) — 판별력 보존
**문제**: 기본값이 1.0 이 되면 T4 의 `tw = topWidthRatio × bw` 단언은 **상수 1 이 결합을 가려버린다**. `tw = bw` 로 하드코딩한 구현(파라미터 무시)도 T4 를 통과한다 → 통합 모델의 판별력 소실.

**대응**: `topWidthRatio` 를 cfg 로 주입한 **비-1.0 케이스**를 봉인하는 T4b 추가.

```ts
it('T4b 폭비는 cfg.topWidthRatio 를 실제로 따른다 → 비-1.0 이면 위가 좁은 사다리꼴', () => {
  for (const ratio of [0.85, 0.5]) {
    const [tl, tr, br, bl] = buildTrapezoid(ax, 4.0, { topWidthRatio: ratio });
    expect(len(sub(tr, tl))).toBeCloseTo(ratio * len(sub(br, bl)), 12);
    expect(len(sub(br, bl))).toBeCloseTo(4.0 * 0.04, 12); // 아래 변은 ratio 에 불변(배율 기준변)
    expect(len(sub(tr, tl))).toBeLessThan(len(sub(br, bl)));           // 위가 좁다
  }
});
```

- 두 값(구 기본값 **0.85** + 무관값 **0.5**)을 순회 → 상수 하드코딩·단일값 특수처리 양쪽을 잡는다.
- 아래 변이 `ratio` 에 **불변**임을 함께 단언 → "ratio 를 bw 에 잘못 곱하는" 구현을 배제.
- **마스터가 나중에 사다리꼴로 되돌릴 때**도 그대로 유효한 계약이 된다(기본값만 바꾸면 T4 만 갱신 대상).

`0.85` 를 하드코딩 단언하는 다른 케이스는 전수 grep 결과 **없음**(픽스처 JSON 의 좌표값 0.85x 는 무관).

## 5. 3프리셋 겹침 실측 (필수 재확인)

동결 픽스처 + `occupancyAnchor.regression.test.ts` 의 `regionsFor` 와 **동일 경로**(judge → `source==='plate'` 필터 → `computeOccupancyRegions`)로 실측. 신규 기본값 1.0 과 구 기본값 0.85 를 대조.

| 케이스 | topWidthRatio | globalScale | regions | overlapPairs |
|--------|--------------|-------------|---------|--------------|
| **p1** `detect_cam1_p1_fixed.json` (R5b) | **1.0 (신규)** | **4.0** | **7** | **[]** |
| p1 `detect_cam1_p1_fixed.json` (R5b) | 0.85 (구) | 4.0 | 7 | [] |
| **p2** `detect_cam1_p2.json` | **1.0 (신규)** | **4.0** | **6** | **[]** |
| p2 `detect_cam1_p2.json` | 0.85 (구) | 4.0 | 6 | [] |
| **p3** `detect_cam1_p3.json` | **1.0 (신규)** | **4.0** | **4** | **[]** |
| p3 `detect_cam1_p3.json` | 0.85 (구) | 4.0 | 4 | [] |
| (참고) p1 `detect_cam1_p1.json` 구서버 | 1.0 (신규) | null | 7 | [[5,6]] |
| (참고) p1 `detect_cam1_p1.json` 구서버 | 0.85 (구) | null | 7 | [[5,6]] |

**판정**:
- **R5b 유지** — p1(수정 서버) `overlapPairs=[]` + `regions=7` 그대로. 깨지지 않음.
- 3프리셋 전부 **globalScale = 4.0 = `widthScaleMax`** 유지 → 1단계 이진탐색조차 진입하지 않는다(첫 `anyOverlap(4.0)` 이 false). **2단계 폴백 미진입**.
- **0.85 → 1.0 이 어느 프리셋의 결과도 바꾸지 않았다.** 위 변이 넓어져 겹침 여유가 줄 수 있다는 우려는 실측상 현실화되지 않음 — 상한 4.0 에서도 인스턴스 간 여유가 충분하다.
- 구서버 p1 픽스처의 `[[5,6]]` 겹침도 폭비와 무관하게 동일 재현 → **R5b 의 판별력(구 픽스처 주입 시 FAIL)도 보존**된다.
- 파라미터 추가 조정 **없음**.

## 6. 검증 게이트 실측

```
cd d:\Work\Parking3D\AgentVLA\ParkAgent\SettingAgent
npx tsc -p tsconfig.json --noEmit   → exit 0
npx vitest run                       → exit 0, 152 files / 1687 tests 전량 통과 (11.10s)
```

**증감**: 기준선 152 files / **1686** tests → **152 files / 1687 tests (+1)**. 증가분 1건은 신규 **T4b** 1개. 파일 수 증감 없음, 실패·스킵 0.

## 7. 영향도

- **`web/app.js`**: `computeOccupancyRegions` 를 호출만 하며 폭비를 알지 못한다 → 코드 변경 없음. 뷰어 렌더 결과는 위 변이 아래 변과 같은 폭으로 넓어진다(의도된 시각 변화).
- **서버·MCP·REST 계약**: `occupancyRegion.js` 는 순수 브라우저 모듈이라 무관.
- **되돌리기**: `DEFAULTS.topWidthRatio` 를 0.85 로 되돌리고 T4 단언만 갱신하면 원복(T4b 는 그대로 유효).
