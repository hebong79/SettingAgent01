# 04_doc_impact — VPD 오버레이 개선(차량당 1박스 + `#roi-db` VPD 소스 전환) 영향도 분석

documenter / 입력: `01_architect_plan.md`, `02_developer_changes.md`, `03_qa_report.md` + 실제 소스(`web/core.js`, `web/core.d.ts`, `web/app.js`, `test/dedupeVehicles.test.ts`, `test/dbOverlayParity.test.ts`)

## 1. 변경 파일·함수 (사실 확인 완료)

| 파일 | 위치 | 변경 | 확인 |
|---|---|---|---|
| `web/core.js` | 1257행 | `rectIoU(a,b)` 신규 export | 소스 직접 확인 |
| `web/core.js` | 1274행 | `dedupeVehicles(vehicles, iouThresh=0.5)` 신규 export, IoU 연결요소(union-find) | 소스 직접 확인 |
| `web/core.d.ts` | 442-443행 | 위 2함수 타입 선언 | 소스 직접 확인 |
| `web/app.js` | 60행 | import 목록에 `dedupeVehicles` 추가 | 소스 직접 확인 |
| `web/app.js` | 933행 | `runLiveDetect()` 저장부에서 `vehicles: dedupeVehicles(detect.vehicles ?? [])` 로 수집 시점(ingestion) dedup | 소스 직접 확인 |
| `web/app.js` | 863-901행 | `drawDetectOverlay` 재구성 — VPD만 `#roi-db` 분기(체크→DB, 해제→라이브), LPD 블록 불변 | 소스 직접 확인 |
| `web/app.js` | 907-915행 | `drawDbVpd(ctx, rows)` 신설(DB vpd 전용, 선택·핸들 없음) | 소스 직접 확인 |
| `web/app.js` | (구 897행) | `drawDbDetect` 제거(유일 호출부 소실 → 고아 → CLAUDE.md 규칙3에 따라 제거) | grep으로 잔존 참조 0건 확인(정의·호출 모두 없음) |
| `test/dedupeVehicles.test.ts` | 신규(200행) | `rectIoU`/`dedupeVehicles` 유닛테스트 21건 | 소스 직접 확인 |
| `test/dbOverlayParity.test.ts` | 주석 2곳 | `drawDbDetect` → `drawDbVpd` 명칭 갱신(단정문 불변) | grep으로 확인 |

**불변 확인(그렙/코드 리뷰로 검증)**: 서버 `src/capture/*`(검출 파이프라인)·DB 스키마·라우트, `drawOccupancyOverlay`·`drawCuboidOverlay`·`drawVehicleCuboidOverlay`·`drawPlateQuad`·`hitTestDetections`·`removeDetection` — 이번 변경에서 grep 대상 함수명에 대한 수정 diff가 발견되지 않음.

## 2. 의존성 그래프 파급 분석

### 2.1 `state.detectByKey` 공유 소비처 (수집 시점 dedup의 핵심 근거)

`dedupeVehicles`를 렌더 시점이 아닌 `runLiveDetect()` 저장 직전에 적용한 이유는, `detectByKey`가 다음 4개 소비처의 **단일 공유 소스**이기 때문이다:

1. `drawDetectOverlay`(렌더) — 청록 박스 그리기.
2. `hitTestDetections`/`removeDetection`(기능2 선택·편집) — **index 기반** 선택/삭제.
3. `buildFlatSlotRows`(목록 VPD/LPD 태그) — 목록 UI.
4. 점유(occupancy) 판정 로직 — 같은 차량 중복이 있어도 판정 결과 자체는 불변(같은 차·같은 슬롯이므로).

수집 시점에 배열 자체를 축소하면 위 4곳이 모두 같은(이미 dedup된) 배열과 안정된 index를 참조하게 되어, 렌더에서만 dedup할 경우 발생할 수 있는 "그려진 박스 index ≠ 선택/삭제 대상 index" 불일치가 구조적으로 발생하지 않는다. 이 설계 판단은 `01_architect_plan.md` §1과 `02_developer_changes.md` §2에 근거 문서화되어 있으며, 소스(`app.js:933`)에서 실제로 저장 직전 1곳에서만 dedup이 적용됨을 확인했다.

### 2.2 `@parkagent/types` 등 공유 도메인 타입 영향

- 이번 변경은 `SettingAgent` 내부(프론트 `web/`)에 국한되며, `@parkagent/types`(모노레포 공유 타입 패키지)나 `SlotState`/`ParkingEvent` 등 서버·타 에이전트(ActionAgent/DMAgent) 공유 도메인 타입을 건드리지 않는다.
- 신규 타입은 `web/core.d.ts`(SettingAgent 프론트 전용 선언 파일)에만 추가되었고, 제네릭 `T extends { rect: NormalizedRect }`는 기존 vehicle shape(`{rect, confidence, cls, plate?}`)을 그대로 통과시키는 항등적 시그니처라 다른 타입 소비처에 영향이 없다.
- **결론: 타 에이전트(ActionAgent/DMAgent)로 전파되는 영향 없음.**

### 2.3 REST 계약 영향

- 서버 라우트(`src/api/captureRoutes.ts` 등)·`POST /capture/detect`·`GET /capture/slots` 응답 스키마는 변경되지 않았다. `dedupeVehicles`는 응답을 받은 **이후** 프론트 메모리(`state.detectByKey`)에만 적용되는 가공이며, 서버가 반환하는 raw JSON 자체는 그대로다.
- 따라서 REST 계약을 소비하는 다른 클라이언트(있다면)·통합 테스트에는 영향이 없다. `test/captureRoutes.test.ts` 등 서버 라우트 테스트는 이번 diff의 대상이 아니었고 qa-tester 전체 회귀(163/1808)에 포함되어 통과 확인됨.

### 2.4 `drawDbDetect` 제거의 파급

- 제거 전 유일 호출부는 `drawDetectOverlay`의 `if (!d)` 폴백(구 867행) 1곳이었다. grep으로 재확인한 결과 소스 내 참조는 정의·호출 모두 0건(테스트/문서의 언급은 문자열·주석뿐). 따라서 이 함수 제거로 인한 런타임 참조 오류 위험은 없다.
- `test/dbOverlayParity.test.ts`는 `drawDbDetect`를 직접 import/호출하지 않고 `toPixel(row.vpd)`/`toPixelQuad(row.lpd)` 계약을 단정하는 구조라, 함수명 제거의 영향을 받지 않는다(주석 2곳만 `drawDbVpd`로 명칭 갱신, 단정문 불변 — qa-tester가 실측 확인).

## 3. 회귀 위험 및 검증 근거

| 회귀 위험 항목 | 근거 | 검증 방법·결과 |
|---|---|---|
| LPD(번호판 quad) 렌더 로직 변경 여부 | `drawDetectOverlay`의 LPD 블록(889-899행)이 재구성 전과 바이트 동등(코드 리뷰로 대조) | `dbOverlayParity.test.ts` 통과(toPixelQuad 계약 불변) |
| 점유(occupancy) 오버레이 | 이번 diff가 `drawOccupancyOverlay`를 건드리지 않음(grep 0건) | 전체 회귀 스위트 통과에 포함 |
| 육면체(cuboid) 오버레이 | `detect.cuboids`는 `vcuboidByKey`로 별도 저장(vehicles 파생 아님), `drawCuboidOverlay`/`drawVehicleCuboidOverlay` 미변경 | 전체 회귀 스위트 통과에 포함 |
| 선택(기능2)·8핸들·삭제 | index 정합이 수집 시점 dedup으로 구조적으로 보장(§2.1) | 코드 리뷰로 확인(qa-tester 보고, `03_qa_report.md` §4). **브라우저 실행 스모크는 미실시** — 시각 확인은 리더 관찰 몫으로 명시됨 |
| `dedupeVehicles`/`rectIoU` 로직 정확성(그리디→연결요소 회귀) | 동심 다중스케일 체인에서 그리디가 실패하는 정확한 조건(양끝 IoU<th, 인접 IoU≥th)을 재현하는 테스트 존재 | `test/dedupeVehicles.test.ts` 21/21 통과(qa-tester 실행) |
| 전체 회귀(기존 기능 전반) | — | **documenter가 본 문서 작성 시점에 `npx vitest run` 재실행하여 직접 확인: 163 파일 / 1808 테스트 전부 통과.** QA 보고치(163/1808)와 일치 |
| 타입 정합 | `core.d.ts` 제네릭 선언과 실제 사용 shape 일치 | qa-tester `npx tsc --noEmit` exit 0(통과) |

## 4. 남은 한계 (은닉 없이 명시)

1. **threshold 0.5는 하드코딩 기본값**이며 실측 관찰(라이브 VPD, 다양한 카메라/거리 조건)에 따라 과병합(별개 차량이 합쳐짐)·미병합(같은 차량이 남음)이 나타날 수 있다. 순수함수 인자(`iouThresh`)로 노출되어 있어 조정 자체의 리스크는 낮지만, **최종 튜닝값 확정은 라이브 VPD 관찰이 필요**하며 이번 파이프라인은 vitest로 로직만 확정했다(qa-tester 보고 §6, 확인 필요 상태 유지).
2. **DOM/canvas 실브라우저 렌더 스모크는 vitest 범위 밖**이라 이번 검증에서 실시되지 않았다. "겹침이 실제로 사라졌는가", "`#roi-db` 체크 시 VPD가 시각적으로 DB 소스로 전환되는가", "선택 하이라이트/8핸들/삭제가 실제 클릭으로 동작하는가"는 `02_developer_changes.md`에 기록된 리더의 sharp 렌더 경험적 관찰(그리디→연결요소 교정을 촉발한 관찰)로 일부 확정되었으나, documenter가 이를 재관찰하지는 않았다. **확인 필요** 항목으로 유지한다.
3. **`#roi-db` 체크 시 레이어별 소스 비대칭**: VPD는 DB로 전환되지만 LPD/점유는 기존 "라이브 없을 때만 DB 폴백" 정책을 유지해, 체크 상태에서 VPD=DB / 점유=라이브처럼 소스가 갈릴 수 있다. 이는 "회귀 0" 제약을 우선한 설계 확정 사항이며, 전 레이어 DB 전환을 원하면 별도 요청·재평가가 필요하다(`01_architect_plan.md` §6).
4. **주석 불일치(사소, 기능 무관)**: `web/app.js:60`과 `web/core.js:1254`의 주석이 "IoU 그리디"라는 초기 구현 당시 표현을 그대로 남기고 있어, 실제 알고리즘(연결요소/union-find)과 어긋난다. 동작에는 영향이 없으나 코드베이스 정확성을 위해 추후 갱신을 권고한다. 이번 작업 범위(문서화)에서 코드는 수정하지 않았다.

## 5. 산출물

- 최종 한글 문서: `SettingAgent/docs/20260719_105405_정밀수집_VPD중복제거_DB소스전환.md`
- 본 영향도 분석: `SettingAgent/_workspace/04_doc_impact.md`
