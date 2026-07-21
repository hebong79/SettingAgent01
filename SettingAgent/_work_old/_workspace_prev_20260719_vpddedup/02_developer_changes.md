# 02_developer_changes — VPD 오버레이 개선(차량당 1박스 + #roi-db VPD 소스 전환)

구현자 / 입력: `01_architect_plan.md` / 대상: `SettingAgent/web` 오버레이 렌더 경로

## 1. 변경 파일·라인·요지

| 파일 | 위치 | 변경 | 요지 |
|---|---|---|---|
| `web/core.js` | `[기능2]` 섹션 직전(구 1253행 앞) | 추가 | 순수함수 `rectIoU`, `dedupeVehicles` export. IoU **연결요소(union-find)** dedup, 그룹당 마지막 검지 1개. |
| `web/core.d.ts` | `removeDetection` 선언 직후 | 추가 | `rectIoU(a,b): number`, `dedupeVehicles<T extends {rect:NormalizedRect}>(vehicles, iouThresh?): T[]` 선언. |
| `web/app.js` | import(구 59행 `removeDetection` 인접) | 추가 | `dedupeVehicles` import 1줄. |
| `web/app.js` | `runLiveDetect` 저장부(구 924행) | 수정 | `detectByKey` 저장 직전 `vehicles: dedupeVehicles(detect.vehicles ?? [])` 로 수집 시점 dedup. |
| `web/app.js` | `drawDetectOverlay`(구 862–891행) | 재구성 | VPD 소스만 `#roi-db` 분기(체크→DB vpd, 해제→라이브). LPD·선택·핸들 로직 불변. |
| `web/app.js` | `drawDbVpd`(신설, 구 `drawDbDetect` 자리) | 신설+제거 | `drawDbDetect` **제거**(고아) → VPD 전용 `drawDbVpd` 로 대체. |

**불변(한 줄도 안 건드림)**: 서버 `src/capture/*`·DB·라우트, `drawOccupancyOverlay`·`drawCuboidOverlay`·`drawVehicleCuboidOverlay`·`drawPlateQuad`·`hitTestDetections`·`removeDetection`.

## 2. dedup "마지막 검지" 의미 구현 방식 (그리디 → 연결요소 교정)

- `detect.vehicles` 배열순 = VPD 원검출 순서(track id/timestamp 부재). 배열 **뒤쪽 index = 나중 검지**로 해석(설계서 §1 가정1).
- **[교정] 알고리즘 = IoU 연결요소(union-find)**: `rectIoU ≥ 0.5` 간선으로 그룹핑 후 **각 연결요소의 원배열 최대 index(=마지막 검지)만 생존**. 비겹침 별개 차량은 별도 그룹으로 유지(과잉병합 없음). 생존 index 를 원배열 순서로 정렬해 **원순서 복원** → 렌더·선택 index 안정.

### 그리디 방식 폐기 사유(리더 경험적 검증, sharp 렌더)
- 초기 구현(뒤→앞 그리디: "kept 중 하나라도 IoU≥th면 스킵")은 **동심 다중스케일 박스**(한 차량이 라운드별로 작은~큰 박스 3~4개로 검지)에서 **체인 양 끝(가장 작은 ↔ 가장 큰 박스)이 서로 IoU<0.5면 둘 다 생존** → "차량당 1개" 위반. 렌더 관찰상 24박스→9박스로 줄어도 4박스 차량 2대에 박스가 2개씩 잔존.
- 연결요소는 인접 쌍이 IoU≥th 로 연쇄되면(transitive) 양 끝이 서로 안 겹쳐도 **1그룹으로 병합** → 확실히 1개. 인접 별개 차량은 IoU 가 낮아(관찰상 최대 0.183 ≪ 0.5) 별도 그룹으로 남는다. 임계 0.5·시그니처·기본값·원순서·원객체참조·malformed 스킵은 그대로.
- 스모크 재확인: 동심 4박스 체인(인접 IoU=0.592, **양끝 IoU=0.207**<0.5 → 그리디 실패 조건) → **1개**로 병합, 생존=마지막 index. 4박스 차량 2대(인접 최대 IoU=0.021) → 2개 유지.
- **적용 위치 = 수집 시점(ingestion)**: `runLiveDetect`가 `detectByKey`에 저장하기 직전 정제. `detectByKey`는 렌더 외에 선택·편집(index)·목록(`buildFlatSlotRows`)·점유가 공유하는 단일 소스이므로, 여기서 dedup하면 **모든 소비처가 자동 정합**(렌더에서만 dedup 시 선택 index 어긋남을 회피). 변경점 1곳으로 외과적.
- 원객체 참조 그대로 반환 → `plate`/`confidence`/`cls` 보존. `iouThresh` 기본 0.5 하드코딩(설정 플럼빙 없음).
- `detect.cuboids`는 `vcuboidByKey`로 별도 저장(vehicles 파생 아님) → 육면체 무영향. `summary`는 서버 응답 별도 필드라 목록 카운트 메시지 불변.

## 3. `#roi-db` = VPD 소스 전환(replace) 구현

- `#roi-db` 체크 → VPD를 **DB 저장 vpd(slot_setup)로 전환**(라이브 대체), 해제 → 라이브(dedup 저장분). **VPD 레이어에만** 적용.
- **LPD는 기존 동작 그대로**: 라이브 있으면 라이브, 없고 `#roi-db`면 DB 폴백. `#roi-db` 체크가 라이브+DB 이중 렌더를 유발하지 않음(회귀 0). 점유·육면체 경로 불변.
- 등가성: (라이브 present, dbOff)=기존과 동일 / (라이브 없음, dbOn)=VPD·LPD 모두 DB(구 `drawDbDetect`와 동일) / (라이브 present, dbOn)=의도된 신규(VPD→DB, LPD→라이브 유지).

## 4. drawDbDetect 처리 — 제거(근거)

- 기존 `drawDbDetect`(VPD+LPD 폴백)의 **유일 호출부**(구 867행 `if(!d)` 폴백)가 재구성으로 사라져 **내 변경으로 생긴 고아** → CLAUDE.md 규칙3에 따라 제거.
- 대체: VPD는 `drawDbVpd`(신설), LPD는 `drawDetectOverlay` LPD 블록의 `else if (dbOn)` 인라인이 담당(구 `drawDbDetect`의 `row.lpd` 처리와 동일).
- grep 확인: `drawDbDetect` 활성 참조는 구 867행 호출부와 897행 정의뿐(테스트/문서의 언급은 주석·문자열). 소스 참조 0 확인 후 제거.

## 5. 자체 스모크 결과(브라우저 없이 `node --input-type=module`)

`rectIoU`/`dedupeVehicles`를 core.js에서 직접 import(ESM)해 assert 전부 통과.

초기(그리디) 스모크 15/15 통과. **교정(연결요소) 후 재확인 12/12 통과**:

- 동심 4박스 체인(인접 IoU=0.592, 양끝 IoU=0.207<0.5 = 그리디 실패 조건) → **1개**로 병합, 생존=마지막 index(D).
- 4박스 차량 2대(인접 두 차량 최대 IoU=0.021) → **2개**(차량당 1개), 각 차량 마지막 검지 생존·원순서.
- 겹침쌍 → 마지막(v1) 생존·별개차량(v2) 유지·원객체 참조(plate/cls/conf 보존).
- 엣지: 빈배열→`[]`, `undefined`→`[]`, 1개→그대로, malformed(rect 없음) 스킵, 비겹침 3개 원순서 유지.

검증 커맨드/스위트(교정 후 재실행):
- `npx tsc --noEmit` → 통과(core.d.ts 선언 정합; `web`는 tsconfig include는 아니나 `test/*`가 core.js를 import해 core.d.ts로 typecheck됨). 시그니처 무변경이라 선언 불변.
- `npx vitest run` → **162 파일 / 1787 테스트 전부 통과**(회귀 0). 특히 `viewerToggleGating`(roi-detect 미참조·roi-vehicle/roi-plate/showVehicle/showPlate 존재)·`dbOverlayParity`(toPixel/toPixelQuad 계약) 통과 유지.

## 6. 발견 이슈 / 설계 정합 메모

- **설계 결함 없음** — 설계서 §1·§2 안 그대로 구현. 임의 변형 없음.
- `dbOverlayParity.test.ts` 주석에 `drawDbDetect` 참조명이 남아있음(단정문은 `toPixel`/`toPixelQuad` 직접 사용이라 통과 불변). 설계서 §3-5가 "주석명 갱신 가능(단정문 불변)"으로 열어둠 — **테스트 소유는 qa-tester**라 소스에서 건드리지 않았다. qa-tester가 신규 `dedupeVehicles.test.ts` 추가 시 함께 갱신 권장.
- **UX 주의(리더 전달)**: 최종화 전(rows 비어있음) `#roi-db` 체크 시 라이브 vpd가 숨고 DB가 비어 VPD 박스가 안 보임 — "replace" 의미상 자연스러움(기존 폴백도 그 상태에선 빈 화면, 회귀 아님).
- **관찰 의존**: "겹침이 실제로 사라졌는가"·"#roi-db 전환 시각"은 리더의 라이브/sharp 스샷 관찰로 최종 확정(dedup 로직은 vitest로 확정).
