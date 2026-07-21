# 01_architect_plan — VPD 오버레이 개선(차량당 1박스 + #roi-db DB 소스)

작성: 설계자 / 대상: `SettingAgent/web` 오버레이 렌더 경로 / 모드: goal(관찰형) 보조 유닛테스트

## 0. 코드 사실 재확인(근거)
- `web/app.js:862 drawDetectOverlay()` — `state.detectByKey[key].vehicles` 를 **전량 순회**하며 `v.rect` 를 청록(#00e5ff) `strokeRect`. VPD 모델이 같은 차량에 겹친 박스를 여러 개 반환(NMS/dedup 없음) → 겹침 발생.
- 같은 함수: 라이브 검출(`d`)이 **없을 때만** `#roi-db` 체크 시 `drawDbDetect()`(897행)로 DB(slot_setup)의 vpd/lpd 폴백. **라이브가 있으면 DB 소스는 절대 안 뜬다** → 요구2 미충족.
- `runLiveDetect()`(913행): POST /capture/detect 응답을 `state.detectByKey[presetKey(cam,preset)] = detect` 로 그대로 저장. `detect.vehicles` = 서버 `detectPipeline` 의 `outVehicles`(배열순 = VPD 원검출 순서, `src/capture/detectPipeline.ts:349`). **track id/timestamp 없음** → "마지막 검지" = 배열의 뒤쪽 요소.
- vehicle 요소 shape: `{ rect:{x,y,w,h}, confidence, cls, plate? }`.
- DB 소스: `state.parkingSlotsByKey[key]` = slot_setup 행배열, 각 행 `row.vpd`(NormalizedRect, 슬롯당 1개)·`row.lpd`(quad)·`row.occupyRange`. **행당 1 vpd → 이미 차량당 1개(구조적으로 dedup 완료)**.
- core.js 에 IoU/overlap/dedup 유틸 **없음**(pointInRect/pointInQuad 만 존재) → 신규 필요.
- `state.detectByKey` 소비처: drawDetectOverlay(렌더), `hitTestDetections`/`removeDetection`(기능2 선택·편집, index 기반), `buildFlatSlotRows`(목록 VPD/LPD 태그·점유). → **인덱스 정합이 걸린 소비처가 여럿** = dedup 을 렌더에서만 하면 선택 index 어긋남.
- `#roi-db change → drawRoiOverlay`(app.js:3041). occupancy 폴백(400행)·LPD 폴백도 동일한 "라이브 없을 때만" 패턴.

## 1. 확정: 중복 판정 = IoU 그리디 dedup(옵션 a) + **수집 시점(ingestion) 적용**

### 방식 선택 근거
- **(a) IoU 임계 그리디 채택.** 중복은 "같은 차량의 겹친 박스"이고 배열순이 곧 검지순 → IoU≥임계 그룹에서 **배열 뒤쪽(마지막)** 만 남기면 요구("차량당 1개, 마지막 검지")를 정확히 만족. 비겹침 별개 차량은 그대로 유지(과잉병합 없음).
- (b) 슬롯 귀속 기반 **기각**: slot 폴리곤(placeRoi)이 없을 수 있고(수집 초기), 한 슬롯 위 2대/슬롯 걸친 1대에서 오병합·미검. placeRoi 결합 = 범위 초과·복잡도 증가.
- (c) 단순 마지막 N개 **기각**: N 을 알 수 없음(겹침 구조 무시).

### "마지막 검지" 의미 확정
배열 index 가 클수록 나중 검지. 구현은 **뒤→앞 스캔**, 이미 채택된(더 뒤) 박스와 IoU≥임계면 드롭 → 각 겹침 그룹의 마지막만 생존. 마지막에 원배열 순서로 reverse(렌더/선택 index 안정).

### 적용 위치 = ingestion(수집 시점), 렌더 아님 — **확정**
`runLiveDetect()` 가 `detectByKey` 에 저장하기 **직전** dedup 하여 저장분 자체를 차량당 1개로 만든다.
- 이유: `detectByKey` 는 렌더 외에 **선택·편집(index)·목록·점유** 가 공유하는 단일 소스. 렌더에서만 dedup 하면 그린 index 와 `hitTestDetections`/`selectedDetect.index` 가 어긋나 선택 하이라이트·삭제가 오작동. 수집 시점 dedup 은 **모든 소비처를 자동 정합**시키고 변경점이 1곳이라 더 외과적.
- 영향 없음 확인: `summary`(vpdCount 등)는 서버 응답 별도 필드라 목록 카운트 메시지 불변. `detect.cuboids` 는 `vcuboidByKey` 로 별도 저장(vehicles 파생 아님) → 육면체 무영향. 같은 차량 중복 제거는 점유 판정을 바꾸지 않음(같은 차·같은 슬롯).

### 순수 함수(vitest 대상) — `web/core.js` 에 추가·export
```js
export function rectIoU(a, b) { // NormalizedRect 교집합/합집합
  const ix = Math.max(0, Math.min(a.x+a.w, b.x+b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y+a.h, b.y+b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const uni = a.w*a.h + b.w*b.h - inter;
  return uni <= 0 ? 0 : inter / uni;
}
export function dedupeVehicles(vehicles, iouThresh = 0.5) {
  const kept = [];
  for (let i = (vehicles?.length ?? 0) - 1; i >= 0; i--) { // 뒤→앞: 마지막 우선
    const v = vehicles[i];
    if (!v?.rect) continue;                                 // malformed 가드
    if (kept.some((k) => rectIoU(v.rect, k.rect) >= iouThresh)) continue;
    kept.push(v);
  }
  kept.reverse();                                           // 원순서 복원(index 안정)
  return kept;
}
```
- 임계 0.5 는 기본 인자로 하드코딩(설정 플럼빙 금지 — 최소주의). 원본 객체 참조 그대로 반환 → plate/confidence/cls 보존.

## 2. 확정: `#roi-db` 토글 재정의 = **VPD 소스 전환(옵션 X)**, LPD·점유는 기존 그대로

- **옵션 X 채택**: `#roi-db` 체크 → VPD 는 **DB 저장 vpd 로 전환(라이브 대체)**, 해제 → 라이브(중복제거) 표시.
- 옵션 Y(라이브+DB 가산) **기각**: 최종화 후 라이브·DB 가 공존하면 **같은 청록 박스가 다시 겹쳐** Goal1(차량당 1개)을 정면으로 깬다. DB vpd 는 슬롯당 1개라 라이브와 색이 같아 구분 불가.
- 기존 정책 정합: 메모리 overlay-retain-policy "DB소스는 #roi-db 체크 시 표시" 와 일치(체크가 DB 소스 스위치). 라이브 저장분은 삭제되지 않고 유지(체크 동안만 미표시).
- **회귀 0 경계(중요)**: 이 전환은 **VPD 레이어에만** 적용. **LPD·점유(occupancy)·육면체 렌더 경로는 한 줄도 바꾸지 않는다.** 특히 `#roi-db` 가 기존에 "라이브 없을 때만 폴백"이던 LPD/점유 동작은 그대로 둔다(LPD가 라이브+DB 이중으로 그려지는 회귀 방지).

### drawDetectOverlay 재구성안(구현자 실행용) — VPD 소스만 분기, LPD 는 기존과 바이트 동등
```js
function drawDetectOverlay(ctx) {
  const key = currentFrameKey();
  const d = state.detectByKey[key];
  const showVehicle = $('roi-vehicle').checked;
  const showPlate = $('roi-plate').checked;
  const dbOn = $('roi-db').checked;
  const rows = state.parkingSlotsByKey?.[key] ?? [];
  const sel = state.selectedDetect;

  // ── VPD: #roi-db 체크 → DB 저장 vpd, 아니면 라이브(이미 dedup 저장분) ──
  if (showVehicle) {
    if (dbOn) {
      drawDbVpd(ctx, rows);                       // DB vpd 만(청록). 읽기표시(선택·핸들 없음).
    } else if (d) {
      (d.vehicles ?? []).forEach((v, i) => {
        const { px, py, pw, ph } = toPixel(v.rect, overlay.width, overlay.height);
        const selected = sel?.kind === 'vehicle' && sel.index === i;
        ctx.strokeStyle = selected ? '#ff4d4d' : '#00e5ff';
        ctx.lineWidth = selected ? 4 : 2;
        ctx.strokeRect(px, py, pw, ph);
        if (selected) drawHandles(ctx, px, py, pw, ph);
      });
    }
  }

  // ── LPD: 기존 동작 그대로(회귀 0) ──
  if (showPlate) {
    if (d) {
      (d.vehicles ?? []).forEach((v) => { if (v.plate) drawPlateQuad(ctx, v.plate.quad, v.plate.recovered); });
      (d.plates ?? []).forEach((p, i) => {
        drawPlateQuad(ctx, p.quad, false);
        if (sel?.kind === 'plate' && sel.index === i) drawQuadHandles(ctx, toPixelQuad(p.quad, overlay.width, overlay.height));
      });
    } else if (dbOn) {
      for (const row of rows) { if (row.lpd) drawPlateQuad(ctx, row.lpd, false); }
    }
  }
}

function drawDbVpd(ctx, rows) {          // 기존 drawDbDetect 의 VPD 부분만 분리(LPD 이중렌더 회피).
  for (const row of rows) {
    if (!row.vpd) continue;
    const { px, py, pw, ph } = toPixel(row.vpd, overlay.width, overlay.height);
    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = 2;
    ctx.strokeRect(px, py, pw, ph);
  }
}
```
- 등가성 점검: (라이브 present, dbOn=false) 기존과 동일. (라이브 없음, dbOn) VPD·LPD 모두 DB — 기존 drawDbDetect 와 동일. (라이브 present, dbOn) 만이 의도된 신규 = VPD→DB / LPD→라이브 유지.
- **고아 코드 정리**: 기존 `drawDbDetect()`(897행)는 유일 호출부(867행)가 사라져 고아가 된다 → 내 변경으로 생긴 고아이므로 **제거**(CLAUDE.md 규칙3). VPD 는 drawDbVpd, LPD 는 위 인라인이 대체.
- **UX 주의(문서화/리더 전달)**: 최종화 전(rows 비어있음)에 `#roi-db` 체크 시 라이브 vpd 가 숨고 DB 가 비어 아무 박스도 안 보임 — "replace" 의미상 자연스러움(DB에 표시할 게 없음). 기존에도 그 상태에선 DB 폴백이 빈 화면이었음(회귀 아님).

## 3. 단계 → 검증

1. `core.js` 에 `rectIoU`, `dedupeVehicles` 추가·export → **검증**: `test/dedupeVehicles.test.ts` 신규(vitest) 통과.
   - 겹침 그룹(IoU≥0.5) → 마지막 요소만 생존, 순서 보존.
   - 비겹침 2대 → 둘 다 유지(과잉병합 없음).
   - 빈 배열 → `[]`, 1개 → 그대로.
   - `plate`/`confidence`/`cls` 필드 보존(원객체 참조).
   - `rectIoU`: 완전일치=1, 비겹침=0, 부분겹침 수치(경계 0.5 근처 1건).
   - 3개 체인 겹침(A∩B, B∩C, A∦C) 동작 명문화(그리디 결과 assert).
2. `core.d.ts` 에 선언 추가 → **검증**: `npm run typecheck`(SettingViewer) 통과.
   - `export function rectIoU(a: NormalizedRect, b: NormalizedRect): number;`
   - `export function dedupeVehicles<T extends { rect: NormalizedRect }>(vehicles: T[], iouThresh?: number): T[];`
3. `app.js` import 목록에 `dedupeVehicles` 추가(59행 `removeDetection` 인접) → **검증**: 로드 에러 없음.
4. `runLiveDetect()` 저장부(924행) 교체:
   `state.detectByKey[presetKey(cam, preset)] = { ...detect, vehicles: dedupeVehicles(detect.vehicles ?? []) };`
   → **검증**: 라이브 검출 후 한 차량에 청록 박스 1개(리더 관찰).
5. `drawDetectOverlay` §2 안으로 재구성 + `drawDbVpd` 추가 + `drawDbDetect` 제거 → **검증**: 전체 vitest 통과(특히 `dbOverlayParity.test.ts` — toPixel(row.vpd)/toPixelQuad(row.lpd) 계약 불변이라 통과 유지) + 리더 관찰(§4).

## 4. 검증 계획

### (a) vitest — 순수 로직(자동)
- `test/dedupeVehicles.test.ts`(신규): §3-1 케이스 전부.
- 회귀: 기존 전체 스위트 그린 유지. `dbOverlayParity.test.ts`(주석의 `drawDbDetect` 참조명은 정확성 위해 `drawDbVpd`로 갱신 가능 — 단정문은 불변).

### (b) 리더 관찰(sharp 스샷 또는 라이브 서버)
1. 겹침 유발 프리셋에서 '검출' 실행 → 차량 1대당 청록 박스 **1개**(기존 다중겹침 해소), 별개 차량은 각각 표시.
2. 최종화된 프리셋에서 `#roi-db` 체크 → slot_setup `vpd` 청록 박스 표시, 해제 → 라이브(중복제거) 표시.
3. 회귀 무: LPD(노랑 quad)·점유(빨강 채움)·육면체 오버레이가 변경 전과 픽셀 동등. `#roi-db` 가 LPD/점유를 라이브+DB로 이중 렌더하지 않음.
4. 기능2 선택: 라이브 청록 박스 클릭 시 선택 하이라이트(#ff4d4d)·8핸들 정상, 삭제 정상(index 정합).

## 5. 영향 파일·함수 목록(구현자·문서화 전달)

| 파일 | 변경 | 요지 | 회귀 위험 |
|---|---|---|---|
| `web/core.js` | 추가 | `rectIoU`, `dedupeVehicles` export(순수) | 없음(신규 심볼) |
| `web/core.d.ts` | 추가 | 위 2함수 선언(typecheck) | 없음 |
| `web/app.js` | 수정 | import `dedupeVehicles`; `runLiveDetect` 저장부 dedup; `drawDetectOverlay` VPD 소스분기 재구성; `drawDbVpd` 추가; `drawDbDetect` **제거(고아)** | 선택 index / LPD 이중렌더 — §1·§2 로 차단 |
| `test/dedupeVehicles.test.ts` | 신규 | dedup/IoU 유닛테스트 | 없음 |

- **불변(건드리지 않음)**: 서버 `src/capture/*`(검출 파이프라인)·DB 스키마·라우트, `drawOccupancyOverlay`·`drawCuboidOverlay`·`drawVehicleCuboidOverlay`·`drawPlateQuad`·`hitTestDetections`·`removeDetection`.

## 6. 미해결/가정(리더 확인용)

- **[가정1]** "마지막 검지" = detect 응답 `vehicles` 배열의 뒤쪽 요소로 해석(track id 부재 근거). 만약 "confidence 최고"를 원하면 dedup 의 생존 규칙만 교체(1줄) — 요구 문구상 '마지막'을 채택.
- **[가정2]** IoU 임계 0.5 하드코딩. 실관찰에서 과병합/미병합이면 리더 판단으로 0.4~0.6 조정(순수함수 인자라 리스크 0).
- **[결정확인 필요]** `#roi-db` = **VPD 소스 전환(replace)** 로 확정했다. LPD/점유는 기존 폴백 유지라 `#roi-db` 체크 시 레이어별 소스가 갈릴 수 있음(VPD=DB, 점유=라이브). "회귀 0" 제약 우선으로 이 비대칭을 수용했음 — 리더가 "체크 시 전 레이어 DB 전환"을 원하면 별도 요청으로 확장(점유/LPD 회귀 재평가 필요).
- **[관찰 의존]** Goal 은 시각 성공기준 → vitest 로 dedup 로직만 확정 가능, "겹침이 실제로 사라졌는가"는 리더의 라이브/스샷 관찰로 최종 확정.
