# 01. 센터라이징(/calibrate/ptz) 소스 전환 설계 — setup_artifact → slot_setup

작성: 설계자(architect) / 대상 기능: `SettingAgent` 센터라이징 잡
근거 코드: `PtzCalibrator.ts`, `slotPtzWriter.ts`, `calibrate/types.ts`, `SqliteStore.getSlotSetup`, `capture/types.ts(SlotSetupView/SlotCenteringRow)`, `index.ts:73`, 기존 테스트 2종.

---

## 0. 목표(Goal) 요약 · 검증 기준

센터라이징 대상 소스를 비어 있는 `setup_artifact.json` 에서 **`slot_setup` 테이블**로 전환한다.
`slot_setup` 에서 `lpd_obb`(LPD OBB, `NormalizedQuad`)가 존재하는 모든 슬롯을 대상으로 번호판 중심 센터라이징하고, 산출 PTZ(pan/tilt/zoom) + `centered=1` 을 해당 `slot_id` 행에 부분 UPDATE 한다.

- **전체 성공 기준**: `store.getSlotSetup()` 이 lpd!=null 슬롯 N개를 반환할 때 `POST /calibrate/ptz` → `total=N`, 잡 완료 후 각 성공 슬롯의 `slot_setup` 행이 `pan/tilt/zoom/centered=1` 로 갱신되고 `slot_ptz.json` 도 병행 저장된다.
- **MCP 경계 판단**: 본 경로는 **결정형 도구** 영역이다(기하 변환 `quadBoundingRect` + DB 조회/부분 UPDATE + PlatePtz 수치 폐루프). LLM 두뇌 개입 없음 — 신규 코드에 LLM 호출을 추가하지 않는다. (memory: "셋업 좌표 정본은 전부 기하 / LLM 최소 보조" 정합.)

---

## 1. 단계별 구현 계획 (→ 검증)

### 단계 1 — 신설 함수 `expandPlateTargetsFromSlotSetup`
`src/calibrate/slotPtzWriter.ts` 에 기존 `expandPlateTargets` 옆에 co-locate(같은 펼침 책임).

시그니처:
```ts
export function expandPlateTargetsFromSlotSetup(views: SlotSetupView[]): PlateTarget[]
```
매핑 규칙(`lpd != null` 행만 포함, lpd==null 행 제외):
| PlateTarget 필드 | 소스 |
|---|---|
| `camIdx` | `v.camId` |
| `presetIdx` | `v.presetId` |
| `slotId` (string) | `String(v.slotId)` |
| `globalIdx` (number\|null) | `v.slotId` (정수 전역 id — 항상 존재) |
| `plateRoi` (NormalizedRect) | `quadBoundingRect(v.lpd)` |
| `presetSlotIdx` (number\|null) | `v.presetSlotIdx` (DB 값 그대로, 재계산 금지) |

- import 추가: `SlotSetupView` (`../capture/types.js`). `quadBoundingRect`·`PlateTarget` 은 이미 import 되어 있음.
- 프리셋 covered 순서 재계산 불필요 — `slot_setup.preset_slotidx` 가 정본이므로 그대로 전달.

→ **검증**: 유닛테스트(단계 5-A). lpd 있는 행만 매핑, 각 필드 정확, lpd null 제외, 빈 입력 → `[]`.

### 단계 2 — `PtzCalibrator.start()` 소스 전환 + store 필수화
`src/calibrate/PtzCalibrator.ts`

2-1. `store` 타입 확대 및 **필수화**(옵셔널 제거):
- 현행: `store?: Pick<SqliteStore, 'upsertSlotCentering'>`
- 변경: `store: Pick<SqliteStore, 'upsertSlotCentering' | 'getSlotSetup'>`  (Deps·필드 양쪽)
- **판단(리더 질문 항목 2)**: store 를 **필수**로 한다. 근거 — 소스가 DB(`getSlotSetup`)로 이동하면 store 는 잡의 유일한 데이터 소스이며, 미주입 시 `total 0` 으로 조용히 강등하는 것은 CLAUDE.md "조용한 강등 금지"에 위배된다. 타입 레벨에서 필수화하여 오구성을 컴파일 타임에 차단한다. `index.ts:73` 은 이미 `store: sqlite` 를 주입하므로 프로덕션 영향 없음. (대안: 옵셔널 유지 + `store` 없으면 throw — 그러나 타입 필수화가 더 단순·안전하여 채택.)

2-2. `start()` 본문 교체:
```ts
start(slotIds?: string[]): { total: number } {
  if (this.state === 'running') throw new Error('calibrate already running');
  let targets = expandPlateTargetsFromSlotSetup(this.store.getSlotSetup());
  if (slotIds && slotIds.length > 0) {
    const set = new Set(slotIds);
    targets = targets.filter((t) => set.has(t.slotId));   // slotId(문자열) 필터 유지
  }
  this.state = 'running'; this.done = 0; this.total = targets.length;
  this.current = undefined; this.startedAt = this.now(); this.endedAt = undefined;
  void this.run(targets);
  return { total: targets.length };
}
```
- 제거: `const artifact = this.repo.loadArtifact()` + `if (!artifact) throw` + `expandPlateTargets(artifact)`.
- `slot_setup` 이 비었거나 lpd 슬롯이 없으면 `total 0` 으로 정상 완료(빈 대상은 오류 아님 — 기존 "필터 결과 0" 과 동일 취급). 더 이상 `'no setup artifact'` throw 는 없다.

→ **검증**: 유닛테스트(단계 5-B). `store.getSlotSetup` 1회 호출·targets 수 일치·slotIds 필터 동작. lpd 슬롯 0 → `total 0` 후 `state='done'`.

### 단계 3 — 고아화되는 artifact 경로 정리 범위 (외과적)
전환으로 `repo`(PtzCalibrator 한정)와 `expandPlateTargets` 가 소비처를 잃는다. 조사 결과:
- `PtzCalibrator.repo` : **오직 `start()` 에서만** 사용(loadArtifact) — 내 변경으로 완전 고아.
- `slotPtzWriter.expandPlateTargets` : **오직 PtzCalibrator 만** import(전 소스 grep 확인) — 내 변경으로 고아. 단 exported.

정리 방침(리더 지시 "무단 삭제 금지" + CLAUDE.md rule 3 절충):
- **`repo` (PtzCalibrator dep/field/import): 제거**. 근거 — 생성자에 미사용 `Repository` 를 남기면 오해 소지가 있는 죽은 주입이고, 제거 범위가 소스 전환에 직접 추적되는 최소 변경이다.
  - 삭제 대상: `PtzCalibratorDeps.repo`, `private readonly repo`, 생성자 `this.repo = deps.repo`, `import type { Repository } ...`, `import { expandPlateTargets, ... }` 중 `expandPlateTargets` 만.
  - `import { writeSlotPtz }` 는 유지, 신규 `expandPlateTargetsFromSlotSetup` import 추가.
  - 주의: `Repository` 는 프로젝트 타 모듈(server.ts/index.ts/Finalizer 등)에서 광범위 사용 — **PtzCalibrator 의 import 만** 제거(전역 제거 금지).
- **`slotPtzWriter.expandPlateTargets`: 존치 + `@deprecated` 표기**. 근거 — exported 공개 표면이고, 삭제 시 slotPtzWriter 의 `SetupArtifact` import 정리까지 번져 변경 범위가 확대된다(최소 변경 원칙). JSDoc 에 `@deprecated 센터라이징 소스가 slot_setup 으로 전환됨(expandPlateTargetsFromSlotSetup 사용). artifact 경로 잔존.` 명시. `writeSlotPtz` 는 계속 사용되므로 그대로.

→ **검증**: `tsc`/`vitest` 전체 통과(미사용 import 로 인한 컴파일 에러 0). 타 Repository 사용처 무변.

### 단계 4 — `index.ts` 생성자 호출 갱신
`src/index.ts:73`
```ts
// 변경 전
const calibrator = new PtzCalibrator({ camera, lpd, repo, cfg: tools.calibrate, store: sqlite });
// 변경 후 (repo 인자 제거)
const calibrator = new PtzCalibrator({ camera, lpd, cfg: tools.calibrate, store: sqlite });
```
→ **검증**: 컴파일 통과. 런타임 부팅 시 calibrator 정상 생성.

### 단계 5 — 유닛테스트
기존 시임 패턴(makePlatePtz·writer 주입, 명령 PTZ 추적 모킹 LPD) 재사용.

**5-A. 신규 `test/slotPtzWriter.test.ts` (또는 기존 writer 테스트에 추가)** — `expandPlateTargetsFromSlotSetup`
- lpd!=null 슬롯 2 + lpd==null 슬롯 1 fixture → 결과 length=2(null 제외).
- 필드 검증: `camIdx===camId`, `presetIdx===presetId`, `slotId===String(slotId)`, `globalIdx===slotId(정수)`, `plateRoi` == `quadBoundingRect(lpd)`, `presetSlotIdx` 그대로.
- 빈 배열 → `[]`.

**5-B. `test/ptzCalibrator.test.ts` 개편** — repo/artifact fixture → store fixture
- `repoWith()` 제거. 신규 헬퍼 `storeWith(views, capture)`:
  ```ts
  function storeWith(views: SlotSetupView[], sink?: SlotCenteringRow[][]) {
    return {
      getSlotSetup: () => views,
      upsertSlotCentering: (rows: SlotCenteringRow[]) => { sink?.push(rows); },
    } as unknown as Pick<SqliteStore,'upsertSlotCentering'|'getSlotSetup'>;
  }
  ```
- fixture: lpd 1슬롯 `SlotSetupView`(slotId=7, camId=1, presetId=1, lpd=rectToQuad(...), presetSlotIdx=1). 기존 happy-path 가 기대하던 `globalIdx===7` 유지되도록 slotId=7.
- `makeCalibrator` 가 `repo` 대신 `store` 주입. 기존 5개 시나리오(수렴·순서·no_plate·maxIter·다수 번호판)는 소스만 store 로 교체, 단언 불변.
- **교체**: "setup_artifact 없음 → throw" 테스트 → **"lpd 슬롯 0(getSlotSetup 빈 배열) → total 0, state done"** 로 대체(더 이상 throw 아님).
- **추가**: saveCenteringSlots 검증 — 수렴 성공 시 `upsertSlotCentering` 이 `slotId:7`(정수)·`centered:1` 로 1회 호출됨(sink 검사). globalIdx 부재 케이스는 신규 소스에서 발생 불가하므로 별도 테스트 불필요.
- "중복 시작 → throw" 는 유지.

**5-C. `test/calibrateRoutes.test.ts` 갱신** — PtzCalibrator 생성부만
- `makeServer` 및 409 테스트의 `new PtzCalibrator({...repo...})` → `repo` 제거 + `store: storeWith([view])` 추가.
- `repoWith(artifact())` 는 **orchestrator·buildServer 용으로 계속 필요**하므로 유지(server/orchestrator 는 여전히 repo 사용). PtzCalibrator 생성 인자에서만 repo 를 빼고 store 를 넣는다.
- 라우트 계약(start 200 / 409 / zod 400 / status / result 404·200) 단언 불변 — `total` 은 store fixture 의 lpd 슬롯 수(1)로 맞춘다.

→ **검증**: `npm test`(vitest) 전체 그린. 특히 위 3개 파일 통과 + platePtz/기타 회귀 무영향.

---

## 2. 파일별 변경점 요약 (구현자 전달)

| 파일 | 변경 |
|---|---|
| `src/calibrate/slotPtzWriter.ts` | **신설** `expandPlateTargetsFromSlotSetup(views)`; `SlotSetupView` import 추가; 기존 `expandPlateTargets` 에 `@deprecated` JSDoc(존치) |
| `src/calibrate/PtzCalibrator.ts` | `store` 타입 확대+필수화(`'upsertSlotCentering'\|'getSlotSetup'`); `start()` 를 `getSlotSetup`→`expandPlateTargetsFromSlotSetup` 소싱으로 교체; `repo` dep/field/import 제거; `expandPlateTargets` import 제거·신규 함수 import 추가 |
| `src/index.ts` (73행) | `PtzCalibrator({...})` 인자에서 `repo` 제거 |
| `test/ptzCalibrator.test.ts` | repo/artifact fixture → store fixture 개편; "artifact 없음 throw" → "빈 소스 total 0"; upsertSlotCentering 호출 검증 추가 |
| `test/calibrateRoutes.test.ts` | PtzCalibrator 생성 2곳에서 repo 제거·store 주입(orchestrator/buildServer 의 repo 는 유지) |
| **신설** `test/slotPtzWriter.test.ts` | `expandPlateTargetsFromSlotSetup` 매핑·필터 유닛테스트 |

**불변(건드리지 않음)**: `src/api/server.ts` 의 `/calibrate/*` 라우트, `calibrate/types.ts`(PlateTarget 재사용), `SqliteStore.getSlotSetup`·`upsertSlotCentering`, `saveCenteringSlots()`(globalIdx=slot_id 로직 그대로), `writeSlotPtz`(JSON 병행 저장 유지).

---

## 3. MCP 도구 vs LLM 두뇌 경계

- 전 경로 **결정형 도구**: `getSlotSetup`(DB 조회) → `quadBoundingRect`(기하) → `PlatePtz` centerOnPlate/zoomToPlateWidth(수치 폐루프) → `upsertSlotCentering`(DB 부분 UPDATE). 고빈도·수치반복 루프(센터링/줌 반복)는 이미 `PlatePtz` 결정형에 위임되어 있고 본 전환은 그 **입력 소스만** 교체한다.
- LLM 두뇌 개입 없음 — 신규 코드에 brain/LLM 호출 추가 금지(요청 범위 밖).

---

## 4. 영향도 분석 (문서화 담당 초안 공유)

- **동작 변화**: 센터라이징 대상이 `setup_artifact.slots[].plateRoiByPreset` → `slot_setup.lpd_obb`. artifact 가 비어도 DB 에 lpd 슬롯이 있으면 정상 targets 생성(현행 total 0 문제 해소). 반대로 DB 에 lpd 슬롯이 없으면 total 0.
- **저장 경로 불변**: `slot_ptz.json` 병행 저장(writer 그대로), `slot_setup` 부분 UPDATE(`upsertSlotCentering`, slot_id 키). `saveCenteringSlots` 의 `globalIdx`(=정수 slot_id) 매핑이 신규 소스에서 항상 채워지므로(globalIdx=v.slotId) 스킵 경고 경로 사실상 미발생.
- **REST 계약 불변**: `/calibrate/ptz`·`/status`·`/result` 응답 shape·상태코드 동일. `total` 의 의미만 "artifact 펼침 수" → "lpd 보유 slot_setup 수"로 변함.
- **DB 선행 조건**: `upsertSlotCentering` 은 slot_id 미존재 행을 조용히 무시 → 소스가 `slot_setup` 자체이므로 대상 slot_id 는 항상 존재(정합 보장).
- **테스트 영향**: `ptzCalibrator.test.ts`·`calibrateRoutes.test.ts` 개편 필요(위 5-B/5-C). 그 외 테스트(platePtz 등) 무영향.
- **고아 처리**: `expandPlateTargets` 는 `@deprecated` 존치(런타임 소비처 0, exported 표면 유지). `Repository` 전역 사용처 무변(PtzCalibrator 국소 import 만 제거).

---

## 5. 가정 · 미해결 사항

- **가정 1**: `slot_setup` 은 이미 채워져 있음(리더 확정). `getSlotSetup` 은 `ORDER BY cam_id, preset_id, preset_slotidx` 정렬 반환 → targets 순서도 그 순서. 잡 결과에 순서 의존 단언 없음(문제 없음).
- **가정 2**: `slotIds` 필터는 문자열 slot_id(예: "7")로 들어온다는 기존 계약 유지. `expandPlateTargetsFromSlotSetup` 이 `slotId=String(v.slotId)` 로 채우므로 정합.
- **판단 확정(리더 질문 반영)**: (a) store **필수화** 채택(§2-1 근거). (b) `repo` **제거**, `expandPlateTargets` **deprecated 존치**(§3 근거).
- **미해결(구현자 확인 요청 없음, 진행 가능)**: `test/slotPtzWriter.test.ts` 신설 vs 기존 writer 테스트 파일 병합 — 신설 권장(단일 책임). 구현자 재량 허용.
