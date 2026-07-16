# 04. 문서화 · 영향도 분석 — VPD 주차면 필터 2모드

**최종 문서**: `SettingAgent/docs/20260714_144345_VPD주차면필터_2모드_정밀수집체크박스.md`
**분석 기준시각**: 2026-07-14 14:43:45

---

## 1. 동작 변경 (가장 중요 — 이 항목만은 반드시 읽어야 한다)

> **실서비스 기본 동작이 모드 A 로 바뀐다.**

`src/index.ts:59` 가 `CaptureJob` 에 `placeRoiFile` 을 주입한다. `CaptureJob.start()` 는 `vpdOnParkingOnly = p.vpdOnParkingOnly ?? true` 로 기본 모드 A 다. 따라서 **정밀수집·라이브검출 모두 기본이 "주차면 위 차량만"** 이다. 이전 기본은 **"모든 차량"**(모드 B)이었다.

**파급 경로**:
```
vpd.detect()  →  [NEW] filterVehiclesOnPlace  →  insertDetections(detections)
                                                       ↓
                                                  aggregate()
                                                       ↓
                                                  Finalizer → parking_slots
```
- `detections` 테이블에 **통로 통행차 vehicle 행이 더 이상 들어오지 않는다.**
- 따라서 `aggregate()` → `parking_slots` 에도 통행차가 도달하지 않는다.
- **이전 run 대비 검출 수 감소는 정상이다.** 감소분은 `status.vpdFilteredOut` 으로 **관측 가능**하다(조용하지 않다).
- **모드 B 체크 해제 시 이전 동작 100% 복원** — `this.vpdOnParkingOnly ? applyOnPlaceFilter(...) : raw` 로 **필터 함수 자체를 건너뛴다**(우회가 아니라 미실행).

**리더 실측 근거**(`05_leader_empirical.md`): preset1 7/7 유지·0 제외, preset2 6/8 유지·2 제외, preset3 5/15 유지·10 제외. 제외된 차량의 겹침비는 **정확히 0.000** — 즉 제외된 것은 전부 **그 프리셋 ROI 와 전혀 겹치지 않는 차**다(다른 프리셋 소유 면의 주차차 또는 통로차). §5 프리셋 회계 참조.

**⚠️ 미검증**: 이 기본 동작 변경의 **실데이터 영향**(감소가 정상 감소인지 주차차 손실인지)은 라이브 수집 1라운드로만 최종 확인된다. 시뮬레이터·서버 미가동으로 **관찰하지 못했다.**

---

## 2. 영향 모듈 (의존성 그래프)

```
[신규] src/capture/onPlaceFilter.ts
   │   (import: domain/polygon.ts rectCorners·convexIntersectionArea, domain/geometry.ts area — 전부 기존, 무변경)
   ├──▶ src/capture/CaptureJob.ts        (정밀수집 경로)
   │       └── src/index.ts              (placeRoiFile 주입 → 기본 모드 A)
   └──▶ src/capture/detectPipeline.ts    (라이브검출 경로)
           └── src/api/captureRoutes.ts  (zod 2곳 + detect 핸들러)
                   └── web/app.js ← web/index.html  (#cap-vpd-onplace)

[타입]  src/capture/types.ts  CaptureStatus +3 옵셔널 필드
```

| 모듈 | 영향 | 성격 |
|---|---|---|
| `src/capture/onPlaceFilter.ts` | **신규** | 순수 함수 3 + 상수 2. 부작용 없음 |
| `src/capture/CaptureJob.ts` | 수정 | deps `+placeRoiFile?`, params `+vpdOnParkingOnly?`, 필드 5, `applyOnPlaceFilter()`, `getStatus()` 조건부 스프레드 3 |
| `src/capture/detectPipeline.ts` | 수정 | `OnPlaceOpts` 신설, `runDetect` **4번째 옵셔널** 인자, `summary` 3필드 가산 |
| `src/api/captureRoutes.ts` | 수정 | `StartBodySchema`/`DetectBodySchema` zod 가산, detect 핸들러가 폴리곤 조회 |
| `src/index.ts` | 수정 | `placeRoiFile` 주입 1줄 → **§1 동작 변경의 원인** |
| `src/capture/types.ts` | 수정 | `CaptureStatus` 옵셔널 3필드 |
| `web/index.html`, `web/app.js` | 수정 | 체크박스 + 2개 payload + 표시 2곳 |

### 2.1 무변경 확인 (리더가 파일 mtime 으로 검증)

| 파일 | mtime | 판정 |
|---|---|---|
| `src/capture/Finalizer.ts` | **2026-07-13 19:37:40** | 이번 세션 편집 없음. 주차면 *배정* 규칙 그대로 → 기존 점유 동작 회귀 0. F-2a 로 이월 |
| `web/core.js` | **2026-07-14 01:10:14** | 이번 세션 편집 없음. **이중구현 금지(HANDOFF §2-5) 준수** — 서버가 이미 필터된 결과를 주므로 뷰어는 그리기만. 파리티 테스트 불요 |

(이번 세션 변경 파일들의 mtime 은 전부 **14:25~14:28** 대다. 위 두 파일은 그보다 이르다 = 만지지 않았다.)

### 2.2 파급되지 **않는** 것

- **`@parkagent/types` 무변경** — 이번 변경은 `SettingAgent` 로컬 타입(`src/capture/types.ts`, `src/capture/detectPipeline.ts`)만 건드린다. **ActionAgent·DMAgent 로 전파되는 공유 도메인 타입(SlotState/ParkingEvent 등) 변경 0건.** 타 에이전트 영향 없음.
- **DB 스키마 무변경** — `detections`/`observation`/`parking_slots` 테이블 정의 그대로. 바뀐 것은 **들어가는 행의 개수**뿐(§1).
- **`PtzCamRoi.json` 스키마 무변경** — 필터는 **읽기 전용 소비자**다(`loadNormalizedPlaceRoi`). HANDOFF §5 제약 준수.
- **`domain/polygon.ts`·`domain/geometry.ts` 무변경** — 재사용만 했다.
- **LPD 경로 무변경** — `plates` 는 필터하지 않는다(§6).
- **MCP 도구 계약 무변경** — 필터는 결정형 기하 도구이며 LLM 경로(`floorReviewer`/`occupancyReviewer`)에 개입하지 않는다. 그들은 필터된 검출을 **입력으로 받을 뿐** 규칙을 알 필요가 없다.

---

## 3. REST 계약 변경 — **전부 옵셔널 가산 → 하위호환**

| 엔드포인트 | 변경 | 하위호환 |
|---|---|---|
| `POST /capture/start` body | `+ vpdOnParkingOnly?: boolean` (zod optional) | ✅ 미지정 시 기존 클라이언트 그대로 동작(단, **기본값이 `true`** = 모드 A → §1) |
| `POST /capture/detect` body | `+ vpdOnParkingOnly?: boolean` (zod optional) | ✅ 동일 |
| `POST /capture/detect` 응답 `DetectResult.summary` | `+ onPlaceOnly: boolean`, `+ filteredOut: number`, `+ onPlaceDegraded?: string` | ✅ **가산만** — 기존 `vpdCount`/`lpdCount`/`recovered` 의미 불변. `vpdCount` 는 여전히 **필터 전** 원 검출 수 |
| `GET /capture/status` 응답 `CaptureStatus` | `+ vpdOnParkingOnly?`, `+ vpdFilteredOut?`, `+ vpdOnPlaceDegraded?` | ✅ **전부 옵셔널 + 조건부 스프레드** — 값이 없으면 **키 자체가 없다** |

**계약 불변식**: `vehicles.length = vpdCount − filteredOut` (UI 가 "몇 대 중 몇 대 빠졌나"를 그대로 표시 — 제약 C1 "UI 는 항상 소스를 안다").

**`runDetect` 함수 계약**: 4번째 인자 `onPlace?: OnPlaceOpts` 는 **옵셔널**. 기존 3인자 호출은 `onPlaceOnly:false, filteredOut:0, onPlaceDegraded` 키 부재로 **회귀 0**(QA 15b 로 봉인).

**⚠️ 라우트 내부 변경 1건**: detect 핸들러가 `runDetect(..., parsed.data, cfg)` 로 **body 를 그대로 넘기던 것**을 `{ cam, preset }` **명시 전달**로 교체했다. 새 body 키(`vpdOnParkingOnly`)가 `args` 로 누출되는 것을 막는다. 외부 계약 변화 없음.

**옵셔널 키 falsy 가드 정합**(QA §4 가 교차 대조 — 조용한 `undefined` 표시 방지):
- `vpdFilteredOut` 0 → **키 부재** ↔ `app.js` 는 `status.vpdFilteredOut ? '(제외 N대)' : ''` falsy 가드 → 정합. 테스트로 고정.
- `vpdOnParkingOnly` 는 `runId` 정의 시에만 노출 ↔ `app.js` 는 `!== undefined` 게이트 → 정합. 테스트로 고정.

---

## 4. 기존 테스트 영향 — 갱신 2건, 동작 회귀 0

**핵심 성질**: **강등 정책**(폴리곤 부재 → 전량 통과) 덕분에 `placeRoiFile` 을 주입하지 않는 기존 테스트는 **전부 "전량 통과"(이전 동작)로 수렴**한다. 깨진 것은 응답 shape 을 `toEqual` 로 **완전일치** 단언한 2건뿐이다.

| 파일 | 현상 | 조치 |
|---|---|---|
| `test/detectPipeline.test.ts:118` | `summary` 에 `onPlaceOnly:false, filteredOut:0` 가산 → 완전일치 실패 | 기대값 갱신 |
| `test/captureRoutes.test.ts:500` | 라우트 `?? true` + `placeRoiFile` 미주입 → 강등 → `onPlaceDegraded` 가산 | 기대값 갱신(강등 경로가 정상임을 단언) |
| `test/captureJob*.test.ts` (4건) | 강등 → 전량 통과 | **무변경 통과**(예측이 실측으로 확인) |
| `test/finalizer*.test.ts` | Finalizer 무변경 | 영향 없음 |
| `getStatus()` 를 `toEqual` 로 단언하는 테스트 | **없음**(grep 확인) | `CaptureStatus` 필드 가산 안전 |

**게이트 실측**: `tsc --noEmit` exit 0 / `vitest run` **133 파일 · 1456 테스트 전량 통과**(신규 +44). 실패 0, 구현 버그 0.

---

## 5. 프리셋 단위 회계 — 중복 집계 방지 (부수 효과, 긍정)

리더 실측(§05 §5): preset2 에서 제외된 전경 2대는 **실제 주차차**지만 그 차들이 선 면은 **preset1 의 ROI(전역 1~7)** 다. preset3 에서 제외된 원경 10대도 preset1/2 의 면에 선 차다.

→ **각 차량은 자기 면을 소유한 프리셋에서만 1회 집계된다.** 프리셋 순회 수집에서 **같은 차를 여러 번 세지 않는다.** 이는 모드 A 의 의도된 부수 효과이며 집계 품질에 **긍정적**이다.
→ 반대급부: **ROI 에 등록되지 않은 구획에 선 차는 모드 A 에서 빠진다.**

---

## 6. LPD 미필터 결정의 파급

`plates` 는 **필터하지 않는다.** 이 결정이 다른 모듈에 미치는 영향:

| 소비자 | 영향 |
|---|---|
| `Aggregator.ts:256-311` | plate 클러스터는 **vehicle 클러스터를 통해서만** 결과에 노출(미매칭 plate 클러스터는 버려짐) → **통행차 번호판은 자동 소멸.** 별도 필터 불요 |
| `web/core.js:454 computeOccupancy(floorPolygons, plates)` | **번호판 중심 ∈ 폴리곤**으로 점유 계산. 통로 차량 번호판은 애초에 폴리곤 밖 → **점유 오염 없음.** |
| **만약 plates 를 필터했다면** | VPD 가 **놓친** 주차차의 번호판까지 사라져 `computeOccupancy` 의 **점유가 뒤집힐 위험**(있는 차가 없다고 나옴). → 필터하지 않는 것이 안전측 |
| `matchPlatesToSlots` (`detectPipeline.ts:201`) | **필터된 vehicles 로 호출** — 인덱스 정합 유지(QA 12b 로 봉인. 인덱스가 밀리면 즉시 깨짐) |
| 부작용 | 모드 A 에서 통행차 위에 **차량 박스 없이 번호판 quad 만** 그려질 수 있음 → **의도된 동작**으로 문서화 |

---

## 7. 확인 필요 (단정하지 않음)

1. **라이브 수집 중 필터 동작** — 시뮬레이터·서버 미가동으로 미관찰. 유닛테스트로만 확인. 다음 세션에서 모드 A 수집 1라운드 → `status.vpdFilteredOut > 0` 이면서 **주차차가 빠지지 않았음**을 육안 대조할 것.
2. **UI 체크박스 실동작** — 브라우저 실행 미검증. `#cap-vpd-onplace` **rename 시 어떤 테스트도 깨지지 않고 프론트만 조용히 죽는다.**
3. **다른 카메라 자세로의 일반화** — 임계값 강건성은 cam1·3프리셋·이 장면 기준. 낮은 틸트에서 접지밴드 가정 약화 가능.
4. **기본 동작 변경의 실데이터 영향** — `parking_slots` 검출 수 감소가 정상인지 손실인지는 라이브 대조 필요.

## 8. 등록한 후속 과제

| ID | 내용 |
|---|---|
| **F-2a** | `Finalizer.ts:237-241` 차량중심 폴백 → **모드 B 에서** 통행차를 뒷줄 면에 배정 가능. `isVehicleOnPlace` 통일 여부는 점유 배정 동작 변경 + 기존 테스트 단언 대상 → 라이브 검증 동반 별도 과제. **모드 A 에선 상류 필터가 이미 제거** |
| **V-1** | **VPD 저신뢰 거대 병합 박스**(실측 preset3 #14, bbox `(77,0)-(1380,716)`, conf **0.39**). 캡처 경로에 **confidence 하한 미적용**. **이번 변경과 무관한 선행 노이즈** — 모드 B 에서도 그대로 들어왔다. 처방은 `setup.minConfidence` 를 캡처 경로에도 적용하는 것 |
