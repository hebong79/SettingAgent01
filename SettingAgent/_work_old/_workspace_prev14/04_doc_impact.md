# 04 · 영향도 분석 — LPD 실패 슬롯의 "이웃 번호판" 기반 예상 quad → floor ROI

작성: documenter / 대상: SettingAgent / 입력: `_workspace/01·02·03` + 실제 변경 소스
최종 문서: `docs/20260703_221401_번호판미검출_주변참고_예상위치_점유영역.md`

---

## 1. 영향 받는 모듈 (의존성 그래프)

| 모듈 | 변경 | 계약/시그니처 영향 | 파급 |
|------|------|--------------------|------|
| `src/capture/floorRoi.ts` | 신규 `PlateNeighbor` + `estimatePlateQuadFromNeighbors` export(추가만) | **없음**(신규 export, 기존 export 무변경) | 아래 두 호출부만 소비 |
| `src/capture/FloorRoiReviewer.ts` | 이웃 수집 + 트리거 + `effQuad` 를 recognize/resolve 양쪽 전달(내부 배선만) | **없음**(`review()` 시그니처 무변경) | 호출자(정밀수집 체크포인트) 무영향 |
| `src/capture/Finalizer.ts` | 폴백에 `?? estimated`(내부 배선만) | **없음**(`finalize()`/`assemble()` 시그니처 무변경) | 호출자(SetupOrchestrator 등) 무영향 |
| `config/prompts/floor_roi.yaml` | system 규칙 7 한 문장 가산 | LLM 계약 소폭(가산, 스키마·좌표규약 무변경) | 이웃 0개 잔여 케이스 소프트 가드레일 |
| `test/estimatePlateFromNeighbors.test.ts`(구현자 8) · `test/estimatePlateNeighborsIntegration.test.ts`(QA 8) | 신규 유닛/통합 | — | — |

**무변경 확인**(파급 없음): `src/domain/geometry.ts`(원시함수 재사용만) · `src/domain/types.ts`
(`NormalizedRect`/`NormalizedQuad`/`ParkingSlot`/`SetupArtifact` 형 무변경) · `@parkagent/types` ·
web 뷰어 · DB 스키마(`floor_rois` 테이블 shape·`AggregatedSlot`) 전부 무변경.

---

## 2. 하위호환 / 회귀 안전

- **이웃 0개 경로 = 기존과 바이트 동일**: 트리거 미충족 또는 유효 이웃 0개면 `estimated=undefined` →
  `buildPlateAnchoredQuad(v, undefined)` / `resolveFloorPolygon(null, v, undefined, ...)` 로 흘러가
  현행(`predictPlateRect` 상수 + θ=0)과 **`toEqual` 동일**(QA 불변식4로 실측 확인). 신규 분기 무진입.
- **실측 plate 우선 유지**: 트리거가 `plate 부재 && plateQuad 부재` 이므로 실측 plateQuad/rect 보유
  슬롯은 추정 자체를 실행하지 않음 → 기존 각도·배치 동작 100% 보존.
- **저장 스키마 무변경**: `plateRoiByPreset`/`floorRoiByPreset`/DB `floor_rois` shape 그대로.
  예상 quad 는 `plateRoiByPreset` 에 저장하지 않음(게이트3) → 아티팩트 소비자(web/DM) 무영향.

---

## 3. 시그니처 참조 지점 파급 (무변경 근거)

예상 quad 는 **기존 `plateQuad` 인자로 주입**되어 아래 함수들의 시그니처를 건드리지 않는다.
따라서 이들의 **모든 기존 호출부·테스트가 무영향**이다.

- `buildPlateAnchoredQuad(vehicle, plateQuad?, depthFloor?)` — 인자 형·개수 무변경.
- `resolveFloorPolygon(llmPoly, vehicle, plateQuad?, plateRect?)` — 무변경.
- `recognizeFloorRoi({...})` (SetupBrain) — `plateQuad` 옵셔널 필드에 합성 quad 주입(계약 변화 아님).
- `deconflictPolygons(items)` — `plate` 인자 소스 무변경(실측 `p.plateRect` 단일 경로).

참조 지점: `FloorRoiReviewer`·`Finalizer` 두 곳만 예상 quad 를 생성·주입. 그 외 `floorRoi` export
소비자(테스트 포함)는 신규 함수를 부르지 않으므로 파급 없음(회귀 627 그린으로 확증).

---

## 4. 리스크 / 후속 (확인 필요 항목 포함)

- **[튜닝 여지]** 게이트1: 이웃 선택 = 위치 최근접 1개. 행 전체 평활을 원하면 각도 median 으로
  교체 가능(원근 그래디언트 손실 트레이드오프). 실 데이터 육안 후 재조정 대상.
- **[미검증 → 확인 필요]** 실 LLM 스모크·Unity 뷰어 육안 렌더는 외부 서비스 미기동으로 **미수행**.
  프롬프트 규칙 7 의 실제 LLM 응답 품질은 검증 범위 밖(문구 존재만 `promptsYaml` 회귀로 확인).
- **[구조적 안전]** deconflict 예상 quad 미주입은 코드 정독 + 관찰 프록시(`plateRoiByPreset` 부재)로
  확인. 내부 직접 스파이는 없으나 소스가 `p.plateRect` 단일이라 도달 경로 부재.

---

## 5. 변경 파일 표

| 파일 | 변경 요지 | 영향 범위 |
|------|-----------|-----------|
| `src/capture/floorRoi.ts` | `PlateNeighbor` + `estimatePlateQuadFromNeighbors` 신규 export | 모듈 내 가산, 외부 계약 무변경 |
| `src/capture/FloorRoiReviewer.ts` | 이웃 수집·트리거·`effQuad` 양방향 전달(배선) | 클래스 내부, `review()` 시그니처 무변경 |
| `src/capture/Finalizer.ts` | 폴백 `?? estimated`; plateRoiByPreset/deconflict 불변 | 클래스 내부, `finalize()` 시그니처 무변경 |
| `config/prompts/floor_roi.yaml` | system 규칙 7 한 문장 가산 | LLM 프롬프트 소폭(가산) |
| `test/estimatePlateFromNeighbors.test.ts` | 신규 유닛 8 | 테스트만 |
| `test/estimatePlateNeighborsIntegration.test.ts` | 신규 통합 8(QA 보강) | 테스트만 |

**검증**: tsc EXIT 0 / vitest 72 files 627 tests PASS(신규 16, 회귀 0). 코드·테스트 미수정(문서만).
</content>
