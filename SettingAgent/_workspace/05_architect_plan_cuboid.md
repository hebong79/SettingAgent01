# 05 설계 — "3D육면체 ROI생성" 버튼 (slot3d_front_center 산출·저장·표시)

리더(현자 라) 직접 작성. Phase 0 실측 조사에 근거한 확정 설계.

## 목표(성공 기준)

정밀수집 상단 액션바 **"ROI 파일 로딩" 바로 옆**에 `3D육면체 ROI생성` 버튼을 추가한다.
클릭하면:
1. 프리셋별 **지면모델**로 각 슬롯의 3D 육면체를 산출하고 **앞면 중심점(slot3d_front_center)** 을 계산한다.
2. 결과를 DB `slot_setup.slot3d_front_center` 에 **저장**한다(부분 UPDATE — 다른 컬럼 무접촉).
3. 화면에 **육면체 + 앞면 중앙점이 즉시 표시**된다(오버레이 자동 ON, 새로고침 불필요).

## Phase 0 조사 사실 (재조사 금지)

1. **렌더러는 이미 있다.** `web/app.js:drawCuboidOverlay()`(613행~)가 `#roi-cuboid` 체크 시
   육면체 12모서리 + **앞면 중심점 원**까지 그린다(638행~). 근거는 `state.groundByKey` 하나뿐이고
   뷰어는 추정하지 않는다(`projectCuboid` 투영만). **렌더 수학 신규 작성 금지 — 이 경로를 그대로 쓴다.**
2. **지면모델 라우트도 이미 있다.** `GET /capture/ground-model` 가 live 로 동작하며,
   재생성된 ROI 파일 기준으로 **5프리셋 전부** 모델을 낸다(실측):
   `1:1 conf=0.106 / 1:2 conf=0.990 / 1:3 conf=0.480 / 2:1 conf=1.000 / 2:2 conf=1.000`.
3. **앞면중심 산출식도 이미 있다.** `src/capture/Finalizer.ts:48 slotFrontCenter(points, g, h)`
   (`backprojectToGround` → `projectCuboidPixels` → `frontFaceCenterPx`). 단 **모듈 private** 이라
   라우트가 쓰려면 승격이 필요하다. **이중구현 금지 — 복사하지 말고 옮겨라.**
4. **DB 저장 경로가 없다.** `slot3d_front_center` 는 지금 `Finalizer`(=최종화) 에서만 채워지고,
   `SqliteStore` 에는 이 컬럼만 갱신하는 부분 UPDATE 메서드가 없다
   (기존 부분 UPDATE 선례: `upsertSlotCentering` 283행, `upsertSlotLpd` 309행).
5. **1회 로드 가드 문제(중요).** `loadGroundModel()`(893행~)은 `state.groundLoaded` 1회 가드가 있어
   ROI 정본이 바뀌어도 **재로딩하지 않는다**. `loadPlaceRoi` 에서 이미 같은 버그를 고쳤다(§8.1).
6. **높이(h)**: Finalizer 는 상수 `H_CONST`, 뷰어는 슬라이더 `#cuboid-h`(0.5~3.0, 기본 1.5).

## 구현 계획

### A. 산출식 승격 — `src/ground/slotFrontCenter.ts` (신설)

`Finalizer.ts` 의 module-private `slotFrontCenter()` 와 상수 `H_CONST` 를 **이동**해 export.
`Finalizer` 는 import 로 전환(동작·결과 불변 — 기존 finalize 테스트가 그대로 통과해야 한다).

```ts
export const H_CONST: number;                     // Finalizer 에서 이동
export function slotFrontCenter(points: NormalizedPoint[], g: GroundModel, h: number): { x:number; y:number } | null;
```

### B. 저장 메서드 — `SqliteStore.upsertSlotFrontCenter`

`upsertSlotLpd` 와 **같은 형태**(키 단위 UPDATE, 전량 DELETE 금지 — memory: finalize-slotsetup-wipe-fragility):

```ts
/** slot3d_front_center 만 부분 갱신(slot_id 키). 미존재 slot_id 는 조용히 무시. 반환=갱신 행수. */
upsertSlotFrontCenter(rows: Array<{ slotId: number; slot3dFrontCenter: string | null; updatedAt: string }>): number
```
`UPDATE slot_setup SET slot3d_front_center = ?, updated_at = ? WHERE slot_id = ?` 를 단일 트랜잭션으로.

### C. 라우트 — `POST /capture/slots/cuboid`

```
body: { heightM?: number }   // 미지정 시 H_CONST. 0.5~3.0 범위 밖은 400.
```
- `deps.placeRoiFile` 미설정 또는 `deps.ground?.enabled !== true` → **404** `{ok:false,error}`.
- 절차: `buildGroundInputs` + `estimateGroundModels` 로 프리셋별 모델 맵 산출
  (**`/capture/ground-model` 라우트·`Finalizer.buildGroundModels` 와 동일 조합을 쓸 것** — 새 조합 금지).
  → DB `getSlotSetup()` 의 각 행에 대해 `(camId,presetId)` 모델을 찾아 `slotFrontCenter(v.roi, model, h)` 산출
  → `upsertSlotFrontCenter` 로 저장.
- **모델 없음/퇴화(null)** 인 슬롯은 **저장하지 않고** `skipped[]` 에 `{slotId, reason}` 기록(강등 철학, throw 금지).
  기존에 저장돼 있던 값은 **덮어쓰지 않는다**(null 로 지우지 말 것).
- 응답:
```ts
{ ok: true, updated: number, skipped: Array<{slotId:number; reason:string}>,
  models: Array<{ key:string; conf:number; issues:string[] }>, issues: string[], heightM: number }
```
- 슬롯이 0건이면(=ROI 미적재) `{ok:false, error:'slot_setup 비어있음 — ROI 파일 로딩 먼저'}` + **409**.

### D. 웹 UI — `web/index.html` + `web/app.js`

- `index.html`: `#cap-load-roi` **바로 뒤**에 버튼 추가
  ```html
  <button id="cap-build-cuboid" title="지면모델로 각 주차면의 3D 육면체와 앞면 중심점을 산출해 DB(slot_setup.slot3d_front_center)에 저장하고 화면에 표시. 검출·점유·센터링은 건드리지 않음">3D육면체 ROI생성</button>
  ```
- `app.js`: `buildSlotCuboids()` 신설 + `$('cap-build-cuboid')` click 등록(기존 `cap-load-roi` 등록부 옆).
  - body 에 현재 슬라이더 높이 전송: `{ heightM: cuboidHeight() }` (화면과 저장값 일치).
  - 성공 후 **반드시**:
    ```js
    state.groundLoaded = false;   // 1회 가드 해제 — 지면모델 재산출
    await loadGroundModel();
    $('roi-cuboid').checked = true;  // 육면체 오버레이 자동 ON(결과가 보이게)
    state.roiHidden = false;
    await loadParkingSlots();     // DB 갱신분(slot3dFrontCenter) 반영
    drawRoiOverlay(); renderSlotList();
    ```
  - 메시지: `산출 N건 / 스킵 M건(사유) / 모델 conf 요약` — `skipped`·`issues` 는 **숨기지 말 것**.
  - 파괴적이지 않으므로 `confirm()` 불요(ROI 로딩과 다름).
- **함께 고칠 것(같은 1회 가드 버그)**: `loadRoiToDb()` 에도 `state.groundLoaded = false; await loadGroundModel();`
  를 추가한다 — ROI 정본이 바뀌면 지면모델도 반드시 재산출돼야 한다.

## 검증(qa)

신규 `test/slotCuboidRoutes.test.ts` + `test/slotFrontCenter.test.ts`:
1. **승격 파리티**: 이동한 `slotFrontCenter` 가 기존 finalize 결과와 동일값(기존 `finalizerParkingSlots`·
   `slot3dFrontCenter` 테스트 무수정 통과가 1차 근거).
2. `upsertSlotFrontCenter`: 지정 slot_id 만 갱신, **다른 컬럼(vpd/lpd/occupy/pan/centered) 무변경**,
   미존재 slot_id 무시, 반환 행수 정확.
3. 라우트: 200 응답 shape / 404(ground·placeRoi 미설정) / 409(slot_setup 0건) /
   `heightM` 범위 밖 400 / 모델 없는 프리셋 슬롯이 `skipped[]` 로 빠지고 **기존 값 미파괴**.
4. **경계면 교차**: `web/app.js:buildSlotCuboids` 가 소비하는 필드명·타입 ↔ 라우트 응답 대조(과거 사고 이력).
5. 전체 `npx vitest run` 회귀 — 기존 실패 1건(`slot3dFrontCenter.test.ts`, 데이터 기인)만 남아야 한다.

리더 동작확인: 실 DB 사본에 라우트 로직을 태워 23슬롯 중 몇 건이 산출되는지 실측하고,
`sharp` 로 육면체+앞면중심을 렌더해 육안 확인한다(시뮬레이터 프레임 없으면 좌표 렌더로 대체·한계 명시).

## 하지 말 것

- `projectCuboid`/`frontFaceCenter`/`estimateGroundModels` 등 **기존 수학 변경 금지**(정본).
- `drawCuboidOverlay` 렌더 로직 변경 금지 — 버튼은 **데이터 산출·저장 + 토글 ON** 만 담당한다.
- `replaceSlotSetup` 사용 금지(부분 UPDATE 로만 저장).
- `Finalizer` 의 finalize 동작·출력 변경 금지(순수 import 전환만).
- 요청 범위 밖 리팩터·주변 코드 정리 금지.
