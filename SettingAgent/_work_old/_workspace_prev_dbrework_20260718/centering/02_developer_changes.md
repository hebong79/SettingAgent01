# 구현 보고: 센터라이징 개명 + PtzCalibrator→PlatePtz 위임 + slot_ptz.json/DB(centering_slot) 이중 저장

작성: 2026-07-16 / 구현자(developer)
브랜치: `feat/vpd-seg-cuboid` (메인 리포 직접 작업)
설계서: `_workspace/centering/01_architect_plan.md` + 리더 확정 판단(LLM 자문 삭제 승인 / 버튼 라벨 "센터라이징" / total===0 안내 승인)

> ## 3줄 요약
> 1. 설계서 §7 파일표 그대로 구현 완료. **설계서 대비 이탈 0건**(리더 확정 판단 3건은 지시대로 반영).
> 2. **검증 실측**: `npm run typecheck` 무오류 / `npm test` **1710 passed (153 files)**. 기준선을 직접 재측정(`git stash` → 전량 실행)한 결과 **HEAD = 1713** 이며, 1710 = 1713 − 3(설계서 §9 가 "의도된 삭제"로 명시한 LLM 자문 3케이스). **회귀 0 확정.**
> 3. **리더 전달 기준선 정정**: 지시문의 "현재 npm test = 1667" 은 **실측과 불일치(실제 1713)**. 1667 은 plate-ptz 병합 이전 수치로 추정. 이하 모든 판단은 실측 1713 기준.

---

## 1. 변경 파일 (13개 — 설계서 §7 표 대비)

| # | 파일 | 변경 | 설계서 대비 |
|---|---|---|---|
| 1 | `web/index.html` | :205 주석, :208 h3 → `센터라이징`, :209 설명 + `· DB centering_slot`, :213 버튼 → `센터라이징` | 버튼 문구만 리더 확정(설계서의 "센터라이징 시작" 아님) |
| 2 | `web/app.js` | :2006 주석, `calStart` total===0 안내 분기 | 설계서 §5-1 + 리더 승인 |
| 3 | `src/calibrate/types.ts` | `PlateTarget.presetSlotIdx: number \| null` 가산 | 그대로. **`CenteringAdvice`(:49-60) 무접촉**(기존 데드코드) |
| 4 | `src/calibrate/slotPtzWriter.ts` | `expandPlateTargets` — presets 맵 + `presetSlotIdx` 파생(indexOf+1, 미포함 null + warn) | 그대로 |
| 5 | `src/calibrate/PtzCalibrator.ts` | **핵심 재작성**(326줄 → 232줄). 아래 §2 | 그대로 |
| 6 | `src/capture/types.ts` | `CenteringSlotRow`/`CenteringSlotView` 추가 | 그대로 |
| 7 | `src/capture/SqliteStore.ts` | `centering_slot` DDL + `upsertCenteringSlots`/`getCenteringSlots` | 그대로 |
| 8 | `src/config/toolsConfig.ts` | `llmAdvise` 스키마·기본값 삭제, fallback −62/−35.5, JSDoc 갱신 | 그대로 |
| 9 | `config/tools.config.json` | fallback 정정, `llmAdvise` 줄 삭제 | 그대로 |
| 10 | `src/index.ts` | :77 주석, deps `brain` → `store: sqlite`(기존 인스턴스 재사용) | 그대로 |
| 11 | `test/ptzCalibrator.test.ts` | LLM 자문 describe 3케이스 삭제 + `SetupBrain` import 제거, cfg 리터럴 갱신 | §9 의도된 갱신 |
| 12 | `test/calibrateRoutes.test.ts` | cfg 리터럴 2줄 | §9 |
| 13 | `test/config.test.ts` | `llmAdvise` 단언 → fallback 기대값 2줄 | §9 |

**0줄 변경 준수**: `src/calibrate/platePtz.ts`, `src/calibrate/controlMath.ts`, `src/api/calibrateRoutes.ts`, brain 계층 전체(`SetupBrain`/`AgentRuntime.adviseCentering`/`config/prompts/ptz_centering.yaml`/`llmConfig.centering`) — `git diff --stat` 로 확인.

---

## 2. PtzCalibrator 재작성 — 핵심 구현 노트

### 남긴 것 / 삭제한 것
- **남김**: 잡 상태머신·중복 시작 거부·진행률·`getStatus`·대상 펼침+필터·슬롯 예외 흡수(`reason:'error'`)·`buildSlotPtzJson`+writer.
- **삭제(위임 고아)**: A/B 자체 루프, `probeGain`, `captureAndDetect`, `advise`, `applyCenterAdvice`, `applyZoomAdvice`, `ADVISE_ZOOM_MIN/MAX`, `IMPROVE_EPS`, `improvement`, `clampStep`, `brain` dep, 그리고 이로써 고아가 된 import 8종(`plateCenterError`/`pickNearestPlate`/`estimateGain`/`panTiltCorrection`/`zoomCorrection`/`isCentered`/`isWidthConverged`/`dampGain`) + `SetupBrain`/`CenteringAdvice`/`PlateBox` import.
- **신규**: `startPtzFor`(resolvePresetPtz + `ptzByKey` 캐시 + 0/0/1 폴백 + warn), `baseOpts`(cfg → PlatePtzOpts), `saveCenteringSlots`(best-effort DB 미러).

### gain 체이닝(이 작업의 핵심) — 실물 관찰로 확인
```ts
const c = await this.makePlatePtz({ ...base, plateRoi: t.plateRoi })
  .centerOnPlate(t.camIdx, t.presetIdx, startPtz);
if (!c.ok || !c.plate) return this.skipItem(t, c.ptz, c.plateWidth ?? 0, c.reason);

const z = await this.makePlatePtz({
  ...base,
  plateRoi: quadBoundingRect(c.plate.quad),  // ★ 설계서 §7 함정 회피: center 前 t.plateRoi 아님
  gain: c.gain,                              // ★ 실측 게인 체이닝 → 무측정 fallback 의존 소멸
}).zoomToPlateWidth(t.camIdx, t.presetIdx, c.ptz);
```
`makePlatePtz` DI 스텁으로 **실제 구동해 관찰**(단위테스트가 아닌 tsx 스모크 — qa 의 T1 을 선점하지 않되 구현자 책임으로 확인):
```
zoom 인스턴스 opts.gain     : {"gainPan":-37.7,"gainTilt":-21.4,"zoomRef":1.69341}  (center 결과 gain 과 동일 참조: true)
zoom 인스턴스 opts.plateRoi : {"x":0.47,"y":0.48,...}   ← center 결과 boundingRect (center 前 prior 0.62/0.62 아님) ✓
zoomToPlateWidth startPtz   : {"pan":20.5,"tilt":5.5,"zoom":1.69341}  (center 결과 ptz 동일 참조: true)
```

### 결과 매핑(설계서 §5-4 표 준수)
- center 실패 → `skipItem(c.ptz, c.plateWidth ?? 0, c.reason)`, **zoom 미시도**(설계서 §3 의도된 의미 변화).
- 성공 → `ptz: z.ptz`, `plateWidth: z.plateWidth ?? c.plateWidth ?? 0`, `centered: true`, `converged: z.ok`, `reason: z.ok ? 없음 : z.reason`.
- `skipItem` 의 `reason` 을 **옵셔널**로 변경(구: 필수 string). 이유: 성공/실패 양쪽에서 `reason` 유무를 정직하게 표현하기 위함이며, 기존 호출부(`'error'`, `'no_plate'` 등)는 전부 값을 넘기므로 **외부 동작 불변**.

### 시작 PTZ
`resolvePresetPtz(camera, cam, preset)` → `${cam}:${preset}` 키 캐시. 조회 실패/미보유 시 `{0,0,1}` + `logger.warn`(조용한 강등 금지). 기존 모킹 camera(`listCameras` 부재)는 `resolvePresetPtz` 내부 try/catch 로 null → 폴백 → 기존 테스트 green 유지(스모크 로그로 경로 실증됨).

---

## 3. DB(centering_slot) — 실물 관찰로 확인

DDL·메서드는 설계서 §5-5 그대로(`upsertFloorRoi` 패턴 미러, PK `(cam_id, preset_id, slot_id)`, ON CONFLICT DO UPDATE, **전량 delete 없음**). 컬럼명은 마스터 지정(`slot_id`/`cam_id`/`preset_id`/`preset_slotidx`/`pos`) + 관례 `updated_at`. TS 는 `SELECT cam_id AS camIdx` 매핑.

`:memory:` 스토어로 직접 구동해 관찰:
```
1회차(2슬롯 upsert)            → 행수 2
2회차 부분 실행(슬롯1만 upsert) → 행수 2 (타깃 외 c1p1s2 보존, updated_at T1 유지)
                                  대상 c1p1s1 만 pos/updated_at 갱신(T2)   ✓ §5-5-3 함정 회피 실증
NULL presetSlotIdx 왕복        → null 로 복원 ✓
```
저장 지점은 `run()` 의 `writer(...)` 직후, `items[i] ↔ targets[i]` 인덱스 1:1 zip → `centered && converged` 필터 → try/catch best-effort(실패 시 warn, 잡 상태 불변).

**부수 확인**: `GET /db/table/centering_slot` 은 `dbRoutes` 가 `sqlite_master` 기반 동적 화이트리스트(dbRoutes.ts:53-57)라 **라우트 변경 없이 즉시 조회 가능**(설계서 §10 Goal 3 준비 완료).

---

## 4. 검증 결과 (실측 — 위장 없음)

| 항목 | 명령 | 결과 |
|---|---|---|
| 타입 | `npm run typecheck` | **무오류**(출력 없음) |
| 기준선(HEAD) | `git stash` → `npx vitest run` | **153 files / 1713 passed** |
| 변경 후 | `npx vitest run` | **153 files / 1710 passed, 0 failed** |
| 차분 | | −3 = LLM 자문 3케이스(설계서 §9 의도된 삭제). **그 외 전 스위트 무수정 green — 회귀 0** |
| DB 동작 | tsx 스모크(:memory:) | 멱등·부분보존·NULL왕복 §3 표대로 |
| 체이닝 동작 | tsx 스모크(makePlatePtz DI) | gain/startPtz/prior 3건 §2 로그대로 |

`platePtz.test.ts`(26) · `controlMath.test.ts` · `slotPtzWriter.test.ts` 전부 무수정 green(대상 모듈 0줄 변경 + `presetSlotIdx` 는 필드 가산이라 기존 필드 단위 assert 무해).

qa-tester 를 위한 시임은 설계서대로 준비됨: `deps.makePlatePtz?`(T1/T6), `deps.store?`(T7/T8/T10/T11/T13), `getCenteringSlots`(T7/T12).

---

## 5. 설계서 대비 이탈 / 발견한 문제

### 이탈: 0건
설계서 §5-2 의사코드·§5-4 매핑표·§5-5 DDL·§6 config·§7 파일표를 그대로 구현했다. 리더 확정 3건(자문 삭제 / 버튼 "센터라이징" / total===0 안내)은 지시 그대로.

### 발견한 문제·보고 사항

1. **[리더 전달값 오류] 테스트 기준선 1667 ≠ 실측 1713.** 지시문의 "현재 npm test = 1667 passed" 는 재현되지 않았다. HEAD 를 직접 stash 실행해 1713 을 확인했다. 1667 로 판정했다면 "회귀 0"을 잘못 계산(+43 의 유령 증가)했을 것이다. **후속 판단은 1713/1710 기준으로 할 것.**

2. **[의도된 고아 — 무접촉 보존]** LLM 자문 삭제로 소비자가 사라진 코드: `SetupBrain.adviseCentering` 인터페이스 · `AgentRuntime.adviseCentering` 구현 · `config/prompts/ptz_centering.yaml` · `llmConfig.centering` 스키마 · 관련 brain 테스트(전부 green 유지). 리더 지시대로 무접촉. **문서화(documenter)가 데드코드로 명기해야 한다.**

3. **[기존 데드코드 — 손대지 않음]** `src/calibrate/types.ts:49-60` 의 `CenteringAdvice` 는 이번 변경 전부터 아무도 import 하지 않던 사본이다(실사용은 `SetupBrain.ts:197` zod 유도형). CLAUDE.md §3 대로 언급만.

4. **[문서 stale — 이번 범위 밖]** `docs/20260630_225107_PTZ캘리브레이션_slot_ptz.md` 의 §LLM 자문 절과 config 표(fallback 20/15, llmAdvise true)가 이번 변경으로 사실과 어긋난다. 소스 무관 문서라 미수정 — **documenter 판단 요망**.

5. **[R4 잔존 — 설계서 §11 등록됨]** 부분 캘리브레이션 시 `slot_ptz.json` 이 부분 items 로 덮어써져 기존 항목이 소실되는 기존 결함은 이번 범위 밖(스키마 불변 제약). DB 는 upsert 라 이 결함이 없어 보완재로 동작한다.

---

## 6. 후속(문서화·검증자에게)

- **qa-tester**: 신규 T1~T13 작성. 기준선은 **1710**(1713 아님). `makePlatePtz`/`store` 옵셔널 DI 시임 준비 완료.
- **documenter**: 영향 범위 = 본 문서 §1 표 13파일 + brain 계층 고아화(§5-2) + DB 신테이블(소비자 0, 가산 — `dbRoutes` 자동 노출) + config 부호 정정(기존 열화 결함 해소). **reason 값 집합 변화**: `occluded` 소멸 / `max_iterations`·`zoom_saturated` 신규(SlotPtzItem.reason 은 자유 문자열 — 스키마 불변, web `renderCalResult` 는 문자열 그대로 표시라 영향 0). §5-4 stale 문서 판단 요망.
- **경험적 검증(§10)**: 현 `data/setup_artifact.json` 이 `slots:[]` 라 그대로는 total=0(코드 문제 아님 — 설계서 §1). 라이브 왕복 전 `save/result_*.json` 복원 또는 재-finalize 선행 필요.
