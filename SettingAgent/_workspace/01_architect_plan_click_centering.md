# 설계: 클릭 기반 개별 센터라이징 (정밀수집 페이지)

## 1. 목표(성공 기준)

- **기본 전체순회 센터라이징 유지**: 기존 `센터라이징` 버튼(`/calibrate/ptz` 배치 잡)은 동작·저장(`slot_ptz.json` · DB `centering_slot` · Setup 스냅샷) 전부 **무변경**.
- **개별 센터라이징 = 클릭 기반**: 라이브뷰(오버레이) 위에서 차량을 클릭 → **그 클릭 위치에서 가장 가까운 번호판**으로 카메라를 pan/tilt 정렬(+줌). 조작자가 눈으로 확인하는 용도.
- **저장 안 함**: 개별 센터라이징은 `slot_ptz.json`·DB·스냅샷 **어디에도 기록하지 않는다**(카메라는 물리적으로 그 지점을 향한 채 남는다 — 이는 정상, "저장"은 영속화만 의미).
- **게이트**: 센터라이징 UI 위치에 새 체크박스 **`개별 센터라이징`** 을 두고, **체크됐을 때만** 오버레이 클릭이 개별 센터라이징으로 동작. 미체크 시 클릭은 기존 편집 동작 그대로.

## 2. 현행 구조 (근거)

| 구성 | 위치 | 역할 |
|------|------|------|
| 배치 센터라이징 잡 | `src/calibrate/PtzCalibrator.ts` `start()` → `run()` | slot_setup 전개 → 슬롯별 acquire+width → **writer·DB·스냅샷 저장** |
| 결정형 폐루프 도구 | `src/calibrate/platePtz.ts` `centerOnPlate` / `zoomToPlateWidth` | 무상태. `plateRoi` prior 최근접 번호판 선정 → 폐루프. **저장 로직 없음** |
| 라우트 | `src/api/calibrateRoutes.ts` | `/calibrate/ptz|status|frame|result` |
| 프레임 스트림 | `PlatePtz.onFrame` → `PtzCalibrator.lastFrame` → `GET /calibrate/frame` | 잡이 방금 찍은 JPEG 관찰(카메라 재명령 0) |
| 프론트 | `web/app.js` `calStart/calPoll/calFrameTick` (2281~) · `overlay.mousedown` (3232~) · `eventToNorm` (1112) | 배치 폴링·오버레이 편집 |

**핵심 재사용점**: `PlatePtz.centerOnPlate(cam, preset, startPtz)` 에 `plateRoi = {x:클릭x, y:클릭y, w:0, h:0}` 를 주면 **클릭 지점 최근접 번호판**을 초기 대상으로 잡아 그대로 폐루프 센터링한다. 이것이 "클릭한 위치 차의 번호판"의 정확한 구현.

## 3. 설계

### 3.1 백엔드 — `PtzCalibrator.centerOnPoint()` (신규, 가산)

```ts
// PtzCalibrator 내 신규 public 메서드 (배치 start()/run() 과 완전 분리, 저장 없음)
async centerOnPoint(
  camIdx: number, presetIdx: number, point: NormalizedPoint,
  opts?: { zoom?: boolean },
): Promise<{ ok: boolean; ptz: Ptz; plateWidth: number | null; reason?: string }>
```

동작:
1. **상호배타 가드**: `this.state === 'running'`(배치 진행 중)이거나 `this.pointBusy`면 `throw`(→ 라우트 409). 카메라 경합 방지(불변식3과 동형).
2. `pointBusy = true` (try/finally 로 해제).
3. `startPtz = await this.startPtzFor({camIdx, presetIdx})` — 프리셋 base PTZ(라이브 프레임과 동일 기준). 기존 `ptzByKey` 캐시 재사용.
4. `prior = { x: point.x, y: point.y, w: 0, h: 0 }`.
5. `center = await makePlatePtz({ ...baseOpts(), plateRoi: prior }).centerOnPlate(camIdx, presetIdx, startPtz)`
   - **peerOffsets 미주입** → `pickNearestPlate` = 클릭 최근접(조작자가 명시적으로 가리킨 판을 선택하는 의미와 정확히 일치).
6. `center.ok && opts.zoom !== false` 이면 gain 체이닝으로 `zoomToPlateWidth(center.ptz)` 1회(배치의 width 마감과 동일 목표폭). 실패(`plate_lost` 등)면 center 결과 반환(정직).
7. `return { ok, ptz, plateWidth, reason? }`.
8. **저장 호출 없음**: `writer` / `saveCenteringSlots` / `saveSetupSnapshot` / `store.upsertSlotCentering` **미호출**. `onFrame` 훅은 생성자에 이미 배선되어 있어 진행 중 `lastFrame` 갱신 → `/calibrate/frame` 폴링이 자동 동작.

> 배치의 `acquire 줌인 사다리`는 **먼 작은 판을 slot_setup ROI 로 되찾는 최적화**라 클릭(조작자가 보이는 차를 가리킴)에는 불요. `centerOnPlate`(프리셋 zoom) → `zoomToPlateWidth` 조합으로 충분·단순.

### 3.2 라우트 — `POST /calibrate/point` (신규, 가산)

`src/api/calibrateRoutes.ts` 에 추가:

```ts
const PointBodySchema = z.object({
  cam: z.number().int().nonnegative(),
  preset: z.number().int().nonnegative(),
  point: z.object({ x: z.number(), y: z.number() }),
  zoom: z.boolean().optional(),
});
app.post('/calibrate/point', async (req, reply) => {
  const p = PointBodySchema.safeParse(req.body);
  if (!p.success) { reply.code(400); return { error: 'invalid body', detail: p.error.flatten() }; }
  try {
    const r = await deps.calibrator.centerOnPoint(p.data.cam, p.data.preset, p.data.point, { zoom: p.data.zoom });
    return { ok: r.ok, ptz: r.ptz, plateWidth: r.plateWidth, ...(r.reason ? { reason: r.reason } : {}) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    reply.code(msg.includes('running') || msg.includes('busy') ? 409 : 400);
    return { error: msg };
  }
});
```

기존 4개 라우트 불변. `/calibrate/frame` 폴링을 그대로 재사용(진행 관찰).

### 3.3 프론트 — `web/index.html`

`.centering-inline`(line 202~214) 에 체크박스 추가(센터라이징 버튼 옆):

```html
<label class="field check" title="체크 후 라이브뷰에서 차량을 클릭하면 그 번호판으로 센터라이징합니다(저장 안 함)">
  <input id="cal-click-mode" type="checkbox" /> 개별 센터라이징(클릭)
</label>
```

### 3.4 프론트 — `web/app.js`

**(a) 오버레이 클릭 분기 — 최우선**: `overlay.mousedown` 핸들러(3232) **맨 앞**에 게이트 삽입:

```js
if ($('cal-click-mode').checked && !e.ctrlKey) {
  const { nx, ny } = eventToNorm(e);
  e.preventDefault();
  void calPointCenter(nx, ny);   // 클릭 1회 = 개별 센터라이징 발화
  return;                        // 기존 편집 분기(검출/슬롯) 진입 차단(물리 배타)
}
```
> 체크 시 클릭이 최우선 소비되어 검출/슬롯 편집과 충돌 없음. 미체크 시 이 분기 자체를 건너뜀 → 기존 동작 100% 보존.

**(b) 발화 함수 `calPointCenter(nx, ny)`** (calStart 패턴 축소판):
- `cam = state.capFrameKey2?.cam ?? state.cam`, `preset = state.capFrameKey2?.preset ?? state.preset` (runLiveDetect 와 동일 규약).
- `$('cal-msg')` 에 "클릭 위치 번호판으로 센터라이징 중…" 표시.
- `startCalFramePolling()` (기존 함수 재사용 — 진행 프레임 실시간 표시).
- `await fetch('/calibrate/point', { POST, body:{cam, preset, point:{x:nx,y:ny}, zoom:true} })`.
- 완료 → `stopCalFramePolling()`; 결과 메시지(`ok` → "완료", 아니면 `종료(reason)`); `startLive()` 로 라이브 복귀.
- 배치와 상호배타: 배치 진행 중이면 409 → "센터라이징 진행 중" 안내.

**(c) 커서 피드백(선택)**: `cal-click-mode` change 시 `overlay.classList.toggle('click-centering', checked)` → CSS `cursor: crosshair` (app.css 1줄).

## 4. 영속화/저장 불변 (요구사항 재확인)

| 대상 | 배치 센터라이징 | 개별(클릭) 센터라이징 |
|------|:---:|:---:|
| `slot_ptz.json` | 기록 | **미기록** |
| DB `centering_slot`/`slot_setup` | UPDATE | **미기록** |
| Setup 스냅샷 | 기록 | **미기록** |
| 카메라 물리 위치 | 이동 후 유지 | 이동 후 유지(정상) |

## 5. 유닛 테스트 (qa · vitest)

`test/ptzCalibrator.point.test.ts` (신규):
1. `centerOnPoint` 는 `makePlatePtz(...).centerOnPlate` 를 **클릭 point = plateRoi prior** 로 호출한다(주입 opts 검증).
2. **저장 스파이 미호출**: `store.upsertSlotCentering`·`writer`·`saveStore.saveSnapshot` **호출 0회**(핵심 회귀 가드).
3. `zoom:true` → `zoomToPlateWidth` 체이닝, `zoom:false` → center 결과만.
4. 배치 `state==='running'` 중 호출 → throw(라우트 409 매핑).
5. `centerOnPlate` 실패(`no_plate`) → `{ ok:false, reason:'no_plate' }`, 저장 여전히 0회.

`test/calibrateRoutes.point.test.ts`: body 검증(400)·정상(200)·경합(409) shape.

기존 `PtzCalibrator`/`calibrateRoutes` 테스트는 **회귀 0**(가산만).

## 6. 영향도

- **가산 변경만**: 신규 메서드 1·라우트 1·프론트 체크박스+함수 1·CSS 1줄. 기존 배치 경로·저장 경로 **무접촉**.
- `platePtz.ts`·`controlMath.ts`·DB 스키마·`slot_setup` **변경 없음**.
- 상호배타: 배치 잡 ↔ 개별 클릭은 `state`/`pointBusy` 로 카메라 경합 차단. 프론트 프레임폴은 `/calibrate/frame` 단일 소스 공유(기존 상호배타 규약 유지).
- 리스크: 낮음. 개별 경로는 저장이 없어 데이터 파괴 위험 없음([[finalize-slotsetup-wipe-fragility]] 무관).

## 7. 미결 결정(마스터 확인 포인트)

1. **개별 센터라이징이 줌까지 할지?** 설계 기본값 = **center + zoom(plate width 0.2 마감)** — 배치와 동일하게 번호판을 크게. pan/tilt만 원하면 `zoom:false`로 축소 가능. → 기본 줌 포함 제안.
2. **선정 방식**: 클릭 최근접(`pickNearestPlate`) — 조작자가 가리킨 판 그대로. 소유권 게이트(peerOffsets) 미적용. → 이대로 제안.
