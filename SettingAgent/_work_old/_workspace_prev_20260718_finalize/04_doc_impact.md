# 04. 영향도 분석 요약 — finalize 공간배정(최대매칭) 교체

작성: 문서화 담당(documenter) · 최종 문서: `SettingAgent/docs/20260718_125209_finalize공간배정_최대매칭_번호판미달수정.md`

---

## 1. 모듈 의존성 그래프 영향

```
Finalizer.ts ──(신규 의존)──> spaceAssign.ts ──(재사용)──> domain/polygon.ts
                                                            (pointInPolygon, polygonCentroid)
Finalizer.ts ──(무접촉 유지)──> setup/plateMatch.ts   ← detectPipeline.ts:288, onPlaceFilter.ts:82 가 의존
Finalizer.ts ──(무접촉 유지)──> capture/Aggregator.ts (클러스터-내 번호판 귀속, 별개 관심사)
```

- **신규 파일** `src/capture/spaceAssign.ts`: 기존 의존자 0(신규 함수이므로 파급원 없음). `Finalizer.ts` 1곳에서만 import.
- **`plateMatch.ts` 의도적 무접촉**: 공유 사용처(`detectPipeline.ts:288`, `onPlaceFilter.ts:82`, `SetupOrchestrator`)가 `plate.quad` 참조 동등성 계약에 의존하므로 이 함수를 개조하지 않고 신규 함수로 분리 — 회귀면을 `spaceAssign.ts` 1개 파일로 국소화. qa 실측(`npx vitest run` 154 files/1721 tests, 회귀 0)이 이 무접촉을 뒷받침.
- **`domain/polygon.ts`**: 기존 export(`pointInPolygon`, `polygonCentroid`)를 그대로 재사용, 함수 시그니처·구현 변경 없음 → 다른 소비처(예: `deconflictPolygons` 등) 영향 없음.

## 2. REST 계약 · 클라이언트 영향

- `/capture/finalize`, `/capture/slots` 등 REST 응답 shape, `slot_setup` row 스키마, `slotId`(`c{cam}p{preset}s{position}`), `presetSlotIdx`(`i+1`) 규칙 **전부 불변**. `git diff Finalizer.ts` 실측(4 insertions/15 deletions)이 배정 로직 국소 교체만 증명.
- 뷰어(`web/core.js`)·`dbRoutes` 등 slot_setup을 소비하는 클라이언트 측 **무변경 필요** — 스키마·의미론 동일.
- 영향받는 것은 **배정 결과의 정확도**(더 많은 슬롯에 vpd/lpd가 채워짐)뿐, 계약 형태가 아님.

## 3. 공유 도메인 타입 영향

- `AggregatedSlot`, `PlaceRoiSpace`, `NormalizedPoint`, `NormalizedQuad`, `NormalizedRect` — 타입 정의 변경 없음, `spaceAssign.ts`는 기존 타입을 import만 함.
- `CaptureSchema`(`src/config/toolsConfig.ts`)에 필드 1개(`slotAssignGate`, default 존재) 추가 — **하위호환**. 이 필드가 required 컴파일 타입으로 노출되면서 `ToolsConfig['capture']` 타입을 리터럴로 명시한 **테스트 파일 20개**가 `TS2741 Property 'slotAssignGate' is missing`로 컴파일 실패했고, 각 파일에 `slotAssignGate: 0.12`(default와 동일한 중립값) 삽입으로 정합시켰다(로직/어서션 변경 없음). 대상: `assocQaFindings, boundaryCrossCheck, captureCheckpointTrigger, captureJob, captureJobCuboid, captureJobOccupancyGate, captureJobOnPlace, captureLiveRefresh, captureRoutes, checkpointFinalizer, estimatePlateNeighborsIntegration, finalizerFloor, finalizerOccupancy, finalizerParkingSlots, floorRoiUseLlmWiring, groundModelRoutes, jobCuboidRoutes, parkingSlotsRoutes, placeRoiRoutes, vehicleCuboidRoutes`.
- `@parkagent/types` 등 다른 에이전트(ActionAgent/DMAgent)가 공유하는 패키지는 **미접촉** — 이번 변경은 SettingAgent 내부(`src/capture/`, `src/config/`)로 완전히 국한.

## 4. config 운영 영향

- `capture.slotAssignGate` 신규 필드, default 0.18 — 기존 `config/tools.config.json`에 필드가 없어도 병합 시 default로 채워지므로 하위호환.
- **운영 주의(중요)**: `config/` 디렉토리는 nodemon watch 대상이 `src`뿐이라 감시되지 않는다. `tools.config.json`의 `slotAssignGate` 값을 바꿔도 **서버 재기동(또는 src 파일 touch로 강제 리로드) 없이는 반영되지 않는다.** 이번 라이브 검증에서 실제로 이 문제로 0.12→0.18 반영이 지연되었고, 리더가 src touch로 우회 확인했다.

## 5. 튜닝 파라미터 성격

- `slotAssignGate`는 원근 왜곡·슬롯 간격에 의존하는 **관측형 파라미터**다. 이번 씬에서는 0.18이 17/17 완전배정을 달성했지만, 새로운 장소·카메라 배치(다른 원근/슬롯 밀도)에서는 재튜닝이 필요할 수 있다. loop(B모드)에서 lpd_obb 채워진 슬롯 수를 관찰하며 조정하는 것을 전제로 한다.

## 6. 회귀 검증 결과 (인용)

- `npx vitest run` 최종: **154 files / 1721 tests passed**(베이스라인 153/1707 대비 +1 file/+14 tests, 기존 전량 유지 = 회귀 0).
- `npx tsc --noEmit`: exit 0.
- Finalizer 관련 4개 스위트(finalizerParkingSlots/finalizerFloor/finalizerOccupancy/checkpointFinalizer) 38 tests 별도 확인 green.

## 7. 확인 필요 / 후속 이슈(단정하지 않음)

- 극단 비볼록 주차면 폴리곤에서의 `pointInPolygon` 동작은 테스트가 볼록 사각형 전제로만 구성되어 **미검증**(설계서 §9 가정 B). 실제 비볼록 폴리곤이 존재하는지는 확인 필요.
- 극단 원근 프리셋에서 번호판중심 대신 차량 발자국(bbox 하단중심)을 대표점으로 쓰는 방안은 검토됐으나 **현재 미적용** — 별도 이슈로 남김.
- `slotAssignGate` 0.18이 다른 장소(Place)·카메라 배치에서도 유효한지는 해당 씬에서 재검증 필요(관측형 파라미터 특성상 단정 불가).
