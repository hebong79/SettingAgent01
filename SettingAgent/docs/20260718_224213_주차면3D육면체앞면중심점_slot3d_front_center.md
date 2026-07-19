# 주차면 3D 육면체 앞면 중심점 (slot3d_front_center)

작성: 문서화 담당(documenter) · 작성일시: 2026-07-18 22:42
근거 산출물: `_workspace/01_architect_plan.md`(설계) · `_workspace/02_developer_changes.md`(구현) · `_workspace/03_qa_report.md`(검증) · 실제 diff(HEAD 대비)

## 0. 요약

주차면 3D 육면체(기존 `#roi-cuboid` 오버레이)의 **앞면(near 면) 중심점**을 계산하는 기능을 추가했다.

1. 웹 2D 오버레이에서 육면체를 그릴 때 앞면 중심에 **작은 원**을 함께 그린다(라이브 높이 슬라이더 기준).
2. `slot_setup` 테이블에 `slot3d_front_center` 컬럼을 신설, finalize 시 캐노니컬 높이(1.5m) 기준 앞면 중심을 정규화 좌표로 저장한다.

신규 투영 수학은 0줄이다. 기존 `web/core.js:projectCuboid`(뷰어)와 `src/ground/project.ts`(서버)의 검증된 투영 함수를 그대로 재사용하고, "8개 corner 중 앞면 4개의 산술평균"이라는 1개의 순수 연산만 양쪽에 대칭으로 추가했다.

## 1. 설계 단계에서 확정한 결정 (리더 확정)

### Q1 — 앞면의 정의: near 면 = corners `[0,3,7,4]`
`src/ground/types.ts`의 `PixelQuad` 규약상 `p0=근좌, p1=원좌, p2=원우, p3=근우`(근접=카메라·차로 방향)이다. `projectCuboid`/`projectCuboidPixels`는 바닥 4점을 입력 순서 그대로 `corners[0..3]`에, 상면을 같은 순서로 `corners[4..7]`에 배치한다. 따라서 **근접(앞) 모서리는 corners[0](근좌바닥)·[3](근우바닥)이고, 여기에 수직으로 대응하는 상면 코너가 [4]·[7]** 이므로 앞면 사각형은 `[0, 3, 7, 4]`가 된다.

- **리더 sharp 스샷으로 육안 확정**: cam1 p1/p2 렌더에서 원이 각 주차면 차량 전면(번호판 쪽) 앞면 중심에 정확히 앉는 것을 확인했다. 근거가 틀렸다면 인덱스 상수 1줄(`[1,2,6,5]`로 교체)만 바꾸면 되는 구조로 만들어 두었다.

### Q2 — 높이 정책: 대안 A(높이 포함 면 중심) 채택
앞면 "중심점"은 바닥 근접 edge만이 아니라 **상면 코너까지 포함한 4점 평균**이며, 이는 마스터가 요청한 "육면체 생성할 때, 앞면의 중심점"이라는 문구에 충실하다(대안 B — 바닥 근접 edge 중점 h=0 — 는 더 단순하지만 화면상 "면의 중앙"이 아니라 "아래 모서리"에 원이 앉아 문구와 어긋나므로 채택하지 않음).

- **2D 표시**: 현재 슬라이더로 그려지는 육면체의 실제 높이(`cuboidHeight()`, 기본 1.5m)를 그대로 사용 — 원이 육면체와 함께 움직인다.
- **DB 저장**: finalize 시점엔 슬라이더가 없으므로 **캐노니컬 상수 `H_CONST = 1.5`**(슬라이더 기본값과 동일)를 사용한다.
- 두 정책은 하나의 순수 함수를 서로 다른 `h` 인자로 호출하는 구조라, 이후 정책이 바뀌어도 상수 1개만 손대면 된다.

### Q3 — Finalizer에 camerapos/ground 필수 배선
`slot3d_front_center`를 채우려면 finalize 시점에 지면모델(GroundModel)이 있어야 한다. 이를 위해 `src/index.ts`에서 Finalizer 생성 시 `cameraposFile`, `ground` 설정을 **필수로 주입**하도록 확정했다. 미주입 시 매 finalize마다 이 컬럼이 `null`로 강등(덮어쓰기)되는 취약성이 있어(기존 MEMORY: finalize-slotsetup-wipe-fragility 계열과 유사한 성격), 배선 유지를 상시 조건으로 명문화했다.

## 2. 변경/신규 함수 상세

### (뷰어) `web/core.js` — `frontFaceCenter(cuboid)`
```js
const FRONT_FACE_IDX = [0, 3, 7, 4];
export function frontFaceCenter(cuboid)
```
- 입력: `projectCuboid()`가 반환한 `{corners, edges}` (또는 `null`/`undefined`).
- 동작: `corners`가 배열이 아니거나 길이가 8 미만이면 `null`. `FRONT_FACE_IDX` 4개 코너 중 하나라도 없거나 `x`/`y`가 유한하지 않으면 `null`. 그 외에는 4점의 `x`, `y` 산술평균 `{x, y}`(정규화 0~1)를 반환.
- `web/core.d.ts`에 타입 선언(`frontFaceCenter(cuboid: Cuboid | null | undefined): NormalizedPoint | null`) 추가 — 테스트(.ts)가 이 선언으로 타입 검사됨.

### (서버) `src/ground/project.ts` — `frontFaceCenterPx(corners)`
```ts
export const FRONT_FACE_IDX = [0, 3, 7, 4] as const;
export function frontFaceCenterPx(corners: readonly Px[]): Px | null
```
- `web/core.js`와 **동일 인덱스 상수**를 독립적으로 선언(교차참조 주석). `corners.length !== 8`이거나 비유한 좌표가 있으면 `null`. 그 외 픽셀 좌표 산술평균 반환.

### (서버) `src/capture/Finalizer.ts` — `slotFrontCenter(points, g, h)` (비export 내부 헬퍼)
```ts
const H_CONST = 1.5;
function slotFrontCenter(points: NormalizedPoint[], g: GroundModel, h: number): { x: number; y: number } | null
```
- 파이프라인: 정규화 슬롯 quad 4점 → 픽셀(`×imgW/imgH`) → `backprojectToGround`(지면 3D 복원) → `projectCuboidPixels(h)`(육면체 8모서리 픽셀) → `frontFaceCenterPx` → `/imgW,/imgH`로 재정규화.
- `points.length !== 4`, 지면 복원 실패(지평선 위 등 퇴화), 육면체 산출 실패, 앞면 중심 산출 실패 중 하나라도 발생하면 `null`.

### (서버) `Finalizer.buildGroundModelMap()` (private, 신규)
- `GET /capture/ground-model` 라우트와 동일한 조합(`buildGroundInputs` + `estimateGroundModels`)으로 프리셋별 `GroundModel`을 1회 산출해 `Map<"camIdx:presetIdx", GroundModel>`으로 반환.
- `this.deps.ground?.enabled`가 거짓이거나 `placeRoiFile` 미주입, 파일 읽기/파싱 실패, camerapos 파일 부재/파싱 실패 시 예외를 던지지 않고 **빈 맵**(또는 zoom 미상으로 일부 프리셋 누락)을 반환 — 해당 슬롯들의 `slot3dFrontCenter`는 `null`로 강등되지만 나머지 slot_setup 저장(roi/vpd/lpd/occupy 등)은 정상 진행된다.

### 웹 렌더 — `web/app.js: drawCuboidOverlay(ctx)`
- 기존 12모서리 스트로크 직후, `frontFaceCenter(cub)`가 유효하면 정규화 좌표를 오버레이 픽셀로 변환해 반지름 4px의 원을 그린다. 채움색은 선택된 슬롯이면 빨강(`#ff4d4d`), 아니면 육면체와 같은 보라(`#b47cff`) 계열이며, 흰 테두리(`#ffffff`)로 육면체 모서리선과 구분한다.
- `#roi-cuboid` 체크박스 게이트를 그대로 사용하는 **가산(additive) 레이어**이므로, 체크 해제 시 기존 렌더와 픽셀 단위로 동일하다.

## 3. 입출력 / DB·REST 계약

### DB 스키마 — `slot_setup.slot3d_front_center`
- 타입: `TEXT` (nullable). 값 형식: 정규화 0~1 좌표 JSON 문자열, 예: `{"x":0.111,"y":0.669}`.
- 기준: `camera_info.img_w/img_h`로 역변환하면 이미지 픽셀 좌표가 된다(기존 `slot_roi` 등 다른 가변정점 컬럼과 동일 규약).
- 값이 없을 조건: 지면모델 없음/추정 실패, 슬롯 quad가 지평선 위 등으로 지면 복원 퇴화 — 이때 `null` 저장(육면체 표시 skip 철학과 동일한 강등).
- 마스터 스펙 문서 `Docs/MyThink/my_db_table.md` §5(slot_setup)에 이미 `slot3d_front_center : 주차면 3D 육면체의 앞면의 중심점(이미지좌표로 변환된 점)`으로 정의되어 있다 — 이번 구현이 그 정의를 그대로 충족한다(문서 추가 갱신 불필요).

### 마이그레이션 방식 — 멱등 ALTER
`SqliteStore.ensureSchema()`는 `CREATE TABLE IF NOT EXISTS`만 수행하므로 기존 DB(`data/setting.sqlite`)에는 컬럼이 자동으로 생기지 않는다. 이에 다음 가드를 `ensureSchema()` 말미에 추가했다.
```ts
const slotSetupCols = this.db.prepare(`PRAGMA table_info(slot_setup)`).all() as { name: string }[];
if (!slotSetupCols.some((c) => c.name === 'slot3d_front_center')) {
  this.db.exec(`ALTER TABLE slot_setup ADD COLUMN slot3d_front_center TEXT`);
}
```
- 신규 DB: `CREATE TABLE` 문 자체에 컬럼이 포함되어 있어 ALTER는 no-op.
- 기존 DB: 최초 기동 1회 `ALTER TABLE ... ADD COLUMN`으로 컬럼이 추가되고, 기존 행은 값이 `NULL`로 채워진 채 보존된다(다음 finalize에서 값이 채워짐).
- 컬럼은 `img1`과 `updated_at` 사이에 위치(CREATE TABLE 기준).

### REST — `SlotSetupRow` / `SlotSetupView` / `GET /capture/slots`
- `src/capture/types.ts`: `SlotSetupRow.slot3dFrontCenter: string | null`(직렬화된 JSON), `SlotSetupView.slot3dFrontCenter: {x:number;y:number} | null`(파싱된 객체) 필드 추가.
- `replaceSlotSetup` INSERT / `getSlotSetup` SELECT 양쪽에 컬럼 바인딩·파싱(`parseJsonOrNull`) 추가.
- `GET /capture/slots` 응답 JSON에 `slot3dFrontCenter` 필드가 가산된다. 기존 소비측(뷰어의 `GET /capture/slots` 호출부, DB 오버레이 `#roi-db`)은 이 신규 필드를 사용하지 않으므로 무시해도 무해 — 계약은 하위 호환(가산)이다. 뷰어가 DB 저장값을 근거로 원을 그리는 것은 이번 범위 밖(현재는 라이브 육면체 슬라이더 기준으로만 표시).

### `FinalizerDeps` 확장
```ts
cameraposFile?: string; // zoom 소스(camerapos.json) 경로
ground?: ToolsConfig['ground']; // ground-model 라우트와 동일한 지면모델 설정
```
둘 다 옵셔널이며, 미주입 시 `slot3dFrontCenter`가 전부 `null`로 강등될 뿐 나머지 finalize 동작(roi/vpd/lpd/occupy/센터링 보존 등)은 그대로 정상 동작한다(하위 호환). 실제 서비스 배선(`src/index.ts`)에서는 Q3 결정에 따라 **필수로 주입**한다.

## 4. 동작 확인 (경험적 검증 — 리더 goal/loop)

- 실제 `core.js`의 `projectCuboid` + `frontFaceCenter`로 cam1 refframe 위에 렌더한 결과, 앞면 중심 원이 근접(앞)면 중심에 정합함을 확인(7개 중 6개 슬롯 정상 표시 — 나머지 1개는 육면체 자체가 그려지지 않는 프리셋/조건으로 별건).
- 라이브 서버 `GET /capture/slots` 호출로 확인: 마이그레이션이 기존 17행을 보존한 채 컬럼을 추가했고, `slot3dFrontCenter`가 `{x:0.111, y:0.669}` 등 정규화 유효 범위의 값으로 채워짐을 확인.
- Q1(near/far)은 이 육안 확인으로 근접면=앞으로 확정, 상수 플립은 불필요했다.

## 5. 유닛 테스트 (qa-tester, `test/slot3dFrontCenter.test.ts`)

| 항목 | 결과 |
|---|---|
| 신규 테스트 `test/slot3dFrontCenter.test.ts` | **17/17 통과** |
| 전체 회귀 `vitest run` | **161 파일 / 1762 테스트 전부 통과**(기저 1745 + 신규 17) |
| `npx tsc --noEmit` | **에러 0** |
| 신규 기능으로 인한 기존 테스트 회귀 | **0건** |

검증 항목별 요지:
1. `frontFaceCenter`(core.js): 정상 8corner → `[0,3,7,4]` 평균 일치 / h=0 퇴화 시 `avg(p0,p3)`와 등가(대안 B 봉인) / corners<8·비유한·null·undefined → 전부 `null`.
2. `frontFaceCenterPx`(project.ts): 동일 인덱스, 길이≠8 또는 비유한 → `null`.
3. **파리티(핵심)**: tilt `{8,15,22}` × h `{1.5,2.4,0.0}` 4개 조합에서 `projectCuboid→frontFaceCenter`(표시, 정규화)와 `projectCuboidPixels→frontFaceCenterPx`(저장, 픽셀→정규화)가 **1e-6 이내 일치**, 저장점이 0~1 범위 내(픽셀 누수 없음)도 함께 검증.
4. `slotFrontCenter`(Finalizer 헬퍼, 비export): Finalizer 종단 경로로 검증 — 정상 모델 → 0~1 유효점, 슬롯 quad가 지평선 위(퇴화) → `null`.
5. `SqliteStore` 마이그레이션: 컬럼 없는 레거시 DB를 열어 `ensureSchema`가 `PRAGMA table_info` 가드 후 `ALTER ADD COLUMN` 수행함을 확인, 기존 행 보존. `replaceSlotSetup → getSlotSetup` 왕복에서 `{x,y}` 정확 복원 + `null` 왕복.
6. `Finalizer`: ground 미주입 시 모든 row `slot3dFrontCenter=null`(강등, 나머지 저장은 정상). ground 주입(모킹 지면모델)에서는 값이 채워지고, 독립 재계산값(H_CONST=1.5)과 소수점 9자리까지 일치.

경계면 교차검증(ParkAgent 상습 버그 지점) — 전부 정합:
- `web/core.js`와 `src/ground/project.ts`의 `FRONT_FACE_IDX`가 `[0,3,7,4]`로 **동일**함을 확인 — 표시점과 DB 저장점이 같은 면을 가리킨다.
- 저장점은 `frontFaceCenterPx`(픽셀) → `/imgW,/imgH`로 정규화되며 0~1 범위임을 테스트로 봉인.
- corner 인덱스는 0-based, `presetSlotIdx = i+1`(1-based)은 기존 규약과 일관 — 이번 기능이 인덱스 규약을 바꾸지 않음.

한계(모킹 범위, 통과 위장 없음):
- `Finalizer.buildGroundModelMap`(private)을 `vi.spyOn`으로 모킹 지면모델로 대체해 격리 검증했다. 즉 **finalize의 배선(quad→모델→앞면중심→저장)과 강등 로직은 완전 검증**되었으나, `buildGroundInputs`+`estimateGroundModels`(실제 카메라/소실점 추정) 자체의 수치 정확도는 이 신규 테스트 범위 밖이며 기존 `groundModelRoutes` 등 별도 테스트가 커버한다.
- 웹 육안 검증(Q1 확정, 슬라이더 높이 이동 시 원 추종)은 유닛테스트 범위 밖으로 §4(동작 확인)의 브라우저 라이브 검증으로 대체 수행됨.
- 외부 서비스(VPD/카메라) 연동은 합성 `DetectionRow`로 모킹 — 실 연동 스모크는 이 세션에서 수행하지 않음.

## 6. 변경 파일 목록

| 파일 | 변경 |
|---|---|
| `web/core.js` | `FRONT_FACE_IDX` 상수 + `frontFaceCenter(cuboid)` export 추가 |
| `web/core.d.ts` | `frontFaceCenter` 타입 선언 추가 |
| `web/app.js` | import에 `frontFaceCenter` 추가, `drawCuboidOverlay`에 앞면 중심 원 렌더 추가 |
| `src/ground/project.ts` | `FRONT_FACE_IDX` 상수 + `frontFaceCenterPx(corners)` export 추가 |
| `src/capture/types.ts` | `SlotSetupRow.slot3dFrontCenter`, `SlotSetupView.slot3dFrontCenter` 필드 추가 |
| `src/capture/SqliteStore.ts` | CREATE TABLE 컬럼 추가, 멱등 ALTER 마이그레이션, `replaceSlotSetup`/`getSlotSetup` 바인딩·파싱 추가 |
| `src/capture/Finalizer.ts` | `H_CONST`, `slotFrontCenter()`, `buildGroundModelMap()` 추가, `FinalizerDeps`에 `cameraposFile?`/`ground?` 추가, finalize 루프에서 각 row에 `slot3dFrontCenter` 채움 |
| `src/index.ts` | Finalizer 생성 시 `cameraposFile`, `ground` 주입(Q3 필수 배선) |
| `src/tools/migrateToSettingDb.ts` | `SlotSetupRow` 리터럴에 `slot3dFrontCenter: null` 추가(마이그레이션 시점엔 지면모델 없음) |
| `test/slot3dFrontCenter.test.ts` | 신규 테스트 17건 |

`slot3dFrontCenter`가 `SlotSetupRow`/`SlotSetupView`의 **필수** 필드로 추가되면서, 이를 생성하는 기존 producer 코드들이 typecheck 실패를 일으켜 `slot3dFrontCenter: null`을 기계적으로 추가해야 했다(로직 변경 없음): `calibrateFrame`, `calibrateRoutes`, `captureResetRoutes`, `captureRoutes`, `centeringBoundary`, `centeringSlot`, `clearSlotSetupEnrichment`, `parkingSlotsRoutes`, `ptzCalibrator`, `slotPtzWriter`, `sqliteStore`(테스트 픽스처).

## 7. 영향도 분석

상세는 `_workspace/04_doc_impact.md` 참조. 요지:
- DB: `slot_setup` 1컬럼 가산(nullable), 기존 6테이블 계약·FK·UNIQUE 무변경, 마이그레이션 멱등.
- REST: 응답 필드 가산이며 기존 소비측은 무시해도 무해.
- 뷰어 렌더: `#roi-cuboid` 게이트 위 가산 1레이어, off 시 픽셀 완전 동일.
- Finalizer deps 확장은 옵셔널 하위 호환이나, 실제 배선은 필수로 유지해야 값 유지가 보장된다(Q3).
- `clearSlotSetupEnrichment`(검출·센터링 초기화 버튼, 별도 세션 기능)는 이 컬럼을 비우지 않는다 — `slot_roi`처럼 기하 소스로 간주되어 보존 대상.
