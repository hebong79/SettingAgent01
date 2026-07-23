# 01 설계서 — 전역번호 재번호(A안): 수동매핑 → DB slot_id + json 전파

작성: 설계자(architect) / 근거: `_workspace/00_leader_context.md` + 코드 직접 확인(아래 "근거 코드" 참조).
작업 위치(엄수): `WT = d:\Work\Parking3D\AgentVLA\ParkAgent\.claude\worktrees\analyze-fill-check`. 메인 경로 금지.

---

## 0. 요지 · 결정형 vs LLM 경계

- **전부 결정형(MCP 도구 성격) — LLM 두뇌 0.** DB 트랜잭션 재번호 + 순수 remap 함수 + 파일 IO. 모호·맥락판단 없음.
- 데이터 파괴 절대 금지: 재번호는 **slot_id 라벨만 이동**, 물리 슬롯(cam/preset/preset_slotidx)·기하(slot_roi/vpd/lpd/occupy)·센터링(pan/tilt/zoom/centered/img1/front_center) 전 컬럼 보존.
- 전역번호 == slot_id == globalIdx == slot_ptz.globalIdx 는 **하나의 정수 신원**. 재번호 = 이 신원 값을 순열로 갈아끼우는 것.
- 파괴 위험 지점(★특히 경고): (1) DB DELETE+re-INSERT 시 컬럼 누락, (2) 잘못된 순열로 PK 충돌/부분 커밋, (3) slot_ptz 를 DB 로 재생성 시도(→ plateWidth/converged 소실). 아래 설계로 전부 차단.

---

## 1. old→new 매핑 추출 · 검증(공유 순수함수)

**프론트가 보낼 것(확정):** `POST` body `{ mapping: [{ oldSlotId:number, newSlotId:number }, ...] }`.
- 프론트는 이미 `applyManualGlobalIds(lastArtifact, collectManualIds())` 로 `artifact.globalIndex`(각 `{globalIdx, slotId, ...}`)를 만든다. 여기서
  `mapping = res.artifact.globalIndex.map(g => ({ oldSlotId: Number(g.slotId), newSlotId: g.globalIdx }))` 로 파생해 전송.
- 백엔드는 **전체 artifact 를 신뢰/파싱하지 않는다** — 최소 페이로드(mapping 배열)만 받고 자체 재검증한다(클라 검증은 UX용, 서버가 정본 게이트).

**신규 순수 모듈: `src/setup/renumberMapping.ts`** (route·test 공유, DOM/DB 무의존):
```ts
export interface RenumberEntry { oldSlotId: number; newSlotId: number; }
export interface RenumberValidation {
  ok: boolean;
  error?: string;               // 실패 사유(400 노출)
  idMap?: Map<number, number>;  // 성공 시 old→new
}
/**
 * currentIds = 현재 DB slot_setup 의 slot_id 전량. mapping = 프론트 제출.
 * 순열 게이트: (N=currentIds.length)
 *  - mapping.length === N
 *  - oldSlotId 집합 === currentIds 집합 (전 행 커버·누락/추가/중복 없음)
 *  - newSlotId 전부 정수 && 집합 === {1..N} (고유 + 1..N 커버)
 * 통과 시 idMap(old→new) 반환. 실패 시 ok:false + 사람이 읽는 error.
 */
export function validateRenumberMapping(currentIds: number[], mapping: RenumberEntry[]): RenumberValidation;
```
- newId 를 **정확히 {1..N}** 로 강제(Requirements #5, 클라 `validateManualIndex` 와 동치). 단순 고유가 아니라 1..N 커버까지.
- **검증 위치 = 이 순수함수 한 곳.** 라우트는 이 함수만 부른다 → 테스트로 전 케이스 커버.

**검증 기준:** vitest — 정상 순열→ok+idMap 정확 / old 누락·추가·중복→error / new 중복→error / new 가 1..N 아님(예: {1,2,4})→error / length 불일치→error / currentIds 빈배열→error.

---

## 2. `SqliteStore.renumberSlotIds(idMap)` — 트랜잭션 DELETE+re-INSERT 전 컬럼 보존

**위치:** `src/capture/SqliteStore.ts` 에 메서드 추가(기존 `replaceSlotSetup` 패턴 복제, 전량 delete 는 여기서만 정당 — 순열 재라벨이라 전 행 대상).

**시그니처:**
```ts
/**
 * slot_id 라벨만 순열 재부여(재번호). 전 컬럼 보존 — slot_id 외 어떤 값도 변형 금지.
 * idMap 은 현 slot_id 전량을 정확히 커버하는 순열(라우트가 validateRenumberMapping 로 사전 검증).
 * DELETE 후 re-INSERT 를 단일 트랜잭션 → 예외 시 자동 롤백(이전 상태 보존).
 * 방어: (a) 모든 행의 slot_id 가 idMap 에 있어야 함(없으면 throw), (b) new id 고유(PK 충돌 throw),
 *       (c) parking_evnt/parking_slot 비었음 확인(참조행 있으면 FK 위반 전에 throw — 데이터 보호).
 * 반환: { changed } = 재삽입 행수.
 */
renumberSlotIds(idMap: Map<number, number>): { changed: number };
```

**의사코드:**
```ts
renumberSlotIds(idMap) {
  // 1) FK 방어: 참조 테이블이 비어 있어야 안전하게 전량 DELETE 가능(현행 writer 미작성 → 비어 있음 전제).
  const evnt = this.db.prepare(`SELECT COUNT(*) c FROM parking_evnt`).get().c;
  const pslot = this.db.prepare(`SELECT COUNT(*) c FROM parking_slot`).get().c;
  if (evnt > 0 || pslot > 0) throw new Error('renumber blocked: parking_evnt/parking_slot not empty (FK refs)');

  // 2) 원시 행 전량 SELECT(파싱 안 함 — TEXT/REAL 그대로 재삽입해 바이트 보존, round5 재적용 금지).
  const rows = this.db.prepare(
    `SELECT slot_id, cam_id, preset_id, preset_slotidx, slot_roi, vpd_bbox, lpd_obb, occupy_range,
            pan, tilt, zoom, centered, img1, slot3d_front_center, updated_at FROM slot_setup`).all();

  // 3) 순열 방어(라우트 검증과 이중화 — 스토어 단독 호출/테스트 안전).
  const seen = new Set();
  for (const r of rows) {
    if (!idMap.has(r.slot_id)) throw new Error(`renumber: slot_id ${r.slot_id} not in idMap`);
    const nid = idMap.get(r.slot_id);
    if (seen.has(nid)) throw new Error(`renumber: duplicate new id ${nid}`); // PK 충돌 예방
    seen.add(nid);
  }

  // 4) DELETE 전량 → re-INSERT(slot_id 만 new, 나머지 원시값 그대로) 단일 트랜잭션.
  const del = this.db.prepare(`DELETE FROM slot_setup`);
  const ins = this.db.prepare(`INSERT INTO slot_setup
    (slot_id, cam_id, preset_id, preset_slotidx, slot_roi, vpd_bbox, lpd_obb, occupy_range,
     pan, tilt, zoom, centered, img1, slot3d_front_center, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const tx = this.db.transaction((list) => {
    del.run();
    for (const r of list) {
      ins.run(idMap.get(r.slot_id), r.cam_id, r.preset_id, r.preset_slotidx, r.slot_roi,
              r.vpd_bbox, r.lpd_obb, r.occupy_range, r.pan, r.tilt, r.zoom,
              r.centered, r.img1, r.slot3d_front_center, r.updated_at);
    }
    return list.length;
  });
  return { changed: tx(rows) };
}
```
- ★ `round5` **재적용 안 함**(원시 SELECT 값 그대로) — 재저장 드리프트 0.
- ★ `updated_at` **보존**(라벨만 바뀜, 실데이터 불변) — 재작성 안 함.
- FK: slot_setup→preset_pos(cam_id,preset_id) 는 cam_id/preset_id 불변이라 유지. UNIQUE(cam_id,preset_id,preset_slotidx) 도 불변.

**검증 기준:** vitest(`:memory:`) — (1) 순열 swap 후 `getSlotSetup()` 의 slotId 가 new 집합과 일치, 각 물리행의 cam/preset/roi/vpd/lpd/occupy/pan/tilt/zoom/centered/front_center **완전 동일**(라벨만 이동). (2) idMap 미커버→throw. (3) new 중복→throw. (4) parking_evnt 1행 주입 후 호출→throw & 롤백(행수 불변). (5) 반환 changed == 행수.

---

## 3. slot_ptz.json 리맵 — 순수 remap + 파일 IO 분리

**신규 모듈: `src/calibrate/slotPtzRenumber.ts`.**

**순수 함수(테스트 대상):**
```ts
import type { SlotPtzArtifact } from './types.js';
/**
 * items[].slotId/globalIdx 만 old→new 로 remap. plateWidth/converged/centered/ptz/camIdx/presetIdx/reason 보존.
 * idMap 에 없는 slotId 항목은 변경 없이 유지(best-effort — 정상적으로는 slot_setup 하위집합이라 전부 커버됨).
 * new globalIdx asc 재정렬. createdAt 은 원본 유지(센터링 데이터 자체는 불변임을 반영).
 */
export function remapSlotPtz(artifact: SlotPtzArtifact, idMap: Map<number, number>): SlotPtzArtifact {
  const items = artifact.items.map((it) => {
    const nid = idMap.get(Number(it.slotId));
    if (nid == null) return it; // 미커버는 그대로(방어)
    return { ...it, slotId: String(nid), globalIdx: nid };
  });
  items.sort((a, b) => (a.globalIdx ?? Infinity) - (b.globalIdx ?? Infinity));
  return { createdAt: artifact.createdAt, items };
}
```

**파일 IO(best-effort, 절대 throw 로 라우트 죽이지 않음):**
```ts
import { readFileSync, existsSync } from 'node:fs';
import { writeSlotPtz } from './slotPtzWriter.js';
import { logger } from '../util/logger.js';
/** 반환: 'written' | 'skipped'(부재/파싱실패). 예외 삼킴(로그만). */
export function renumberSlotPtzFile(outFile: string, idMap: Map<number, number>): 'written' | 'skipped' {
  try {
    if (!existsSync(outFile)) return 'skipped';
    const parsed = JSON.parse(readFileSync(outFile, 'utf-8')) as SlotPtzArtifact;
    if (!parsed || !Array.isArray(parsed.items)) return 'skipped';
    writeSlotPtz(remapSlotPtz(parsed, idMap), outFile); // 기존 writer 재사용(stringify5·mkdir).
    return 'written';
  } catch (e) { logger.warn({ err: e, outFile }, 'slot_ptz 재번호 리맵 실패(격리)'); return 'skipped'; }
}
```
- ★ slot_ptz 는 **DB 로 재생성 불가**(plateWidth/converged 가 DB 에 없음) → 반드시 파일 읽어 items 리맵 후 rewrite. 이 설계가 정답(00_leader_context 근거).
- outFile 경로 = `deps.calibrate.outFile`(= `data/slot_ptz.json`, tools.config.json:76).

**검증 기준:** vitest — (1) remapSlotPtz: 2항목 순열 후 slotId/globalIdx new & plateWidth/converged/ptz 동일 & new asc 정렬. (2) idMap 미포함 항목 무변. (3) renumberSlotPtzFile: 임시파일 왕복 후 파일 내용 new 반영. (4) 파일 부재→'skipped' 무예외.

---

## 4. setup_result.json 재생성 — 기존 진입점 재사용

- DB 재번호 **후** `writeSetupResultFiles(deps.sqlite.getSlotSetup(), deps.saveStore)` 호출(재생성).
- `buildSetupResult` 가 `s.slotId`(=new slot_id) 사용 → slotId 재번호 자동 반영. 물리 순서(cam/preset/preset_slotidx)는 getSlotSetup ORDER BY 로 보존, slotId 라벨만 새 값.
- best-effort: `saveStore` 미주입 시 스킵(파일 없음). 이력본(Setup_*.json)+고정본(setup_result.json) 2벌 동일 산출(기존 규약).

**검증 기준:** 라우트 통합 테스트에서 saveStore 스텁으로 재작성 호출됐고 slots[].slotId 가 new 값인지 확인.

---

## 5. setup_artifact.json — DB 기준 재빌드 저장(결정 + 근거)

**결정: 옵션 1 — `deps.repo.saveArtifact(buildArtifactFromSlotSetup(deps.sqlite.getSlotSetup()))`** (DB 재번호 후).

**근거(정합·단순):**
- 재번호의 의미 = "DB slot_setup 을 정본으로 만들고 파일로 전파". 재번호 후 DB-파생 artifact 가 **정본 표현**(globalIdx = new slot_id, slotId 문자열 = new).
- `resolveMapping`(server.ts:124)은 파일에 slots 있으면 파일 우선 → **재번호 후 파일을 갱신하지 않으면 GET /mapping 이 옛 globalIdx 를 서빙**(불일치). 그러므로 파일은 반드시 갱신 대상. 재빌드 저장이 파일을 신선하게 유지(옵션2 '파일 삭제'는 물리파일 부재 → renderAnalysis 의 `data/setup_artifact.json` 소스 표기·외부 소비자 기대와 어긋남).
- 파일 그래프(slots/presets.coveredSlotIds/globalIndex 의 slotId 상호참조)를 통째로 remap 하는 것보다 DB 재빌드가 훨씬 단순·결정형.

**★ 감수하는 트레이드오프(문서화·경고):** setup_artifact.json 에만 존재하고 DB 에 없는 **수동 ROI 폴리곤 편집**(있다면)은 DB-파생 bbox 로 치환됨. 근거: (a) 수동매핑 패널은 ROI 가 아니라 전역ID 만 다룸, (b) DB slot_roi 가 기하 정본, (c) `buildArtifactFromSlotSetup` 은 이미 GET 폴백의 표현(roiByPreset=bbox)이라 신규 손실 아님. ROI 폴리곤 보존이 요건이면 별도 과제(범위 밖) — 리더에 플래그.

**검증 기준:** 라우트 후 `repo.loadArtifact().globalIndex` 의 globalIdx 가 전부 new slot_id 와 일치.

---

## 6. 신규 라우트 `POST /mapping/renumber` (server.ts 내 closure)

**위치 결정: `src/api/server.ts`** (captureRoutes 아님).
- 근거: 필요한 deps(`repo`, `sqlite`, `saveStore`, `calibrate.outFile`)가 **전부 server.ts 클로저에 존재** → captureRoutes 로 새 deps(`repo`, `slotPtzFile`) 스레딩 불필요(외과적·최소 변경).
- 프론트 `api()` = `/viewer/api${path}`(app.js:76) → **뷰어 블록에도 등록 필수**. 헤드리스 `/mapping/renumber` + 뷰어 `/viewer/api/mapping/renumber` 둘 다 같은 closure 핸들러 위임(PUT /mapping ↔ /viewer/api/mapping 대칭과 동일 패턴).

**요청 shape(zod):**
```ts
const RenumberBodySchema = z.object({
  mapping: z.array(z.object({
    oldSlotId: z.number().int().positive(),
    newSlotId: z.number().int().positive(),
  })).min(1),
});
```

**closure 핸들러(buildServer 내부, resolveMapping 옆):**
```ts
function renumberHandler(body, reply) {
  if (!deps.sqlite) { reply.code(501); return { error: 'sqlite not configured' }; }
  const parsed = RenumberBodySchema.safeParse(body);
  if (!parsed.success) { reply.code(400); return { error: 'invalid body', detail: parsed.error.flatten() }; }

  // 1) 검증(순수). currentIds = DB 현재 slot_id 전량.
  const currentIds = deps.sqlite.getSlotSetup().map((s) => s.slotId);
  const v = validateRenumberMapping(currentIds, parsed.data.mapping);
  if (!v.ok) { reply.code(400); return { error: v.error }; }        // ★ DB 무변경(원자성)

  // 2) DB 재번호(트랜잭션·전 컬럼 보존). throw 시 롤백.
  let changed;
  try { changed = deps.sqlite.renumberSlotIds(v.idMap!).changed; }
  catch (e) { reply.code(500); return { error: 'renumber failed', detail: String(e) }; }

  // 3) 파일 전파(각 격리·best-effort — DB 커밋 후엔 파일 실패가 요청을 실패시키지 않음).
  let slotPtz = 'skipped';
  if (deps.calibrate?.outFile) slotPtz = renumberSlotPtzFile(deps.calibrate.outFile, v.idMap!);

  let setupResult = null;
  if (deps.saveStore) { try { setupResult = writeSetupResultFiles(deps.sqlite.getSlotSetup(), deps.saveStore); } catch (e) { logger.warn(...); } }

  let artifactSaved = false;
  try { deps.repo.saveArtifact(buildArtifactFromSlotSetup(deps.sqlite.getSlotSetup())); artifactSaved = true; }
  catch (e) { logger.warn(...); }

  return { ok: true, renumbered: changed, slotPtz,
           setupResult: setupResult ? { archive: setupResult.archive, fixed: setupResult.fixed } : null,
           artifactSaved };
}
app.post('/mapping/renumber', async (req, reply) => renumberHandler(req.body, reply));
// 뷰어 블록(app.register 내부)에도:
instance.post('/viewer/api/mapping/renumber', async (req, reply) => renumberHandler(req.body, reply));
```

**처리 순서(원자성 규약):** 검증(실패→400·DB무변경) → DB 재번호(트랜잭션·all-or-nothing) → slot_ptz → setup_result → setup_artifact. DB 커밋 성공이 진실의 기준; 파일 3종은 순차 best-effort(부분 실패는 응답 필드로 노출·로깅, 롤백 없음 — DB 정본이 이미 옳음).

**import 추가(server.ts):** `writeSetupResultFiles`(store/setupResult.js), `renumberSlotPtzFile`(calibrate/slotPtzRenumber.js), `validateRenumberMapping`(setup/renumberMapping.js), `logger`(util/logger.js). `buildArtifactFromSlotSetup`·`z` 는 이미 있음.

**검증 기준:** buildServer inject 통합 — (1) 유효 mapping→200, DB slotId=new, setup_result 재작성(slotId=new), setup_artifact.globalIdx=new. (2) 비순열→400 & `getSlotSetup()` id 불변(DB 무변경). (3) 뷰어 경로도 동일 동작.

---

## 7. 프론트 — saveManualIndex 를 재번호 라우트로 전환

**대상: `web/app.js` `saveManualIndex()` (3304).** 기존 PUT `/mapping`(artifact 통째) → POST `/mapping/renumber`(mapping 배열).
```js
async function saveManualIndex() {
  if (!lastArtifact) return;
  const msg = $('an-manual-msg');
  const res = applyManualGlobalIds(lastArtifact, collectManualIds()); // 클라 검증 게이트 유지(빠른 피드백)
  if (!res.ok) { if (msg) msg.textContent = `저장 불가: ${res.error}`; return; }
  const mapping = res.artifact.globalIndex.map((g) => ({ oldSlotId: Number(g.slotId), newSlotId: g.globalIdx }));
  try {
    const r = await fetch(api('/mapping/renumber'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mapping }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      if (msg) msg.textContent = `재번호 저장됨: ${data.renumbered}면 (slot_ptz:${data.slotPtz})`;
      await loadMapping();       // 검수 탭·state.mapping 재동기화
      await renderAnalysis();    // 분석 탭 재렌더(재번호 반영)
      renderSlotList();          // 주차면 목록 재렌더
    } else { if (msg) msg.textContent = `저장 실패: ${data.error ?? r.status}`; }
  } catch (err) { if (msg) msg.textContent = `저장 실패(네트워크): ${err}`; }
}
```
- **기존 PUT `/mapping`(순수 artifact 편집 저장)·`saveMappingHandler` 는 무변경 유지** — ROI 편집 등 다른 소비자(app.js 1360/2368 등) 회귀 0. 이 패널만 전환.
- `renderAnalysis` 는 내부에서 `fetchArtifact()`→`api('/mapping')` 재조회하므로 `lastArtifact` 자동 갱신. `renderSlotList()` 는 `state.mapping`(loadMapping 이 채움) 소비 → 호출 순서 loadMapping→renderSlotList 준수.

**검증 기준:** (수동/육안·qa 라우트 통합으로 대체 가능) 입력 변경→저장→표·슬롯맵·분석 탭이 new 전역ID 로 갱신. 비순열 입력은 클라에서 차단(applyManualGlobalIds), 서버도 400 이중방어.

---

## 8. 테스트 계획(qa 전달)

신규 파일별 vitest(WT 경로, `cd .../SettingAgent && npx vitest run <spec>`):
1. `test/renumberMapping.spec.ts` — validateRenumberMapping 6+ 케이스(§1 검증기준).
2. `test/sqliteStore.renumber.spec.ts` — renumberSlotIds `:memory:` 보존/순열/충돌/FK가드(§2 검증기준).
3. `test/slotPtzRenumber.spec.ts` — remapSlotPtz 순수 + renumberSlotPtzFile 파일 왕복/부재 skip(§3 검증기준).
4. `test/renumberRoute.spec.ts` — buildServer inject: 200 정상 전파(DB/setup_result/setup_artifact/slot_ptz) · 400 비순열 DB무변경 · 뷰어 경로(§6 검증기준).
5. 회귀: 기존 PUT /mapping spec·finalize·autoChain 전량 green, `npx tsc --noEmit` 0.

각 단계 성공기준은 "X 입력→Y 반환/상태" 로 명문화됨(위 §별 검증 기준).

---

## 9. 영향도 · 회귀 위험

**신규(추가만):**
- `src/setup/renumberMapping.ts`(순수 검증), `src/calibrate/slotPtzRenumber.ts`(remap+IO).
- `SqliteStore.renumberSlotIds`(메서드 추가 — 기존 메서드 무변경).
- server.ts: import 4종 + closure `renumberHandler` + 라우트 2개(헤드리스·뷰어).

**수정(외과적):**
- `web/app.js` `saveManualIndex` 본문만 교체(다른 함수 불변).

**불변식(파괴 0 확인 목록):**
- 센터링(pan/tilt/zoom/centered/img1/front_center)·기하(slot_roi/vpd/lpd/occupy) 전 컬럼 보존(§2 원시 SELECT 재삽입).
- 기존 라우트 무변경: PUT /mapping, GET /mapping(resolveMapping), finalize, autoChain, calibrate. 리더 이전 DB-fallback fix 유지.
- slot_ptz plateWidth/converged 무손실(파일 리맵, DB 재생성 금지).
- 전량 vitest green + tsc 0.

**회귀 위험 & 완화:**
- (위험) FK 참조행 존재 시 전량 DELETE 불가 → (완화) §2 방어 카운트로 사전 throw(현행 parking_evnt/parking_slot 비어 있음).
- (위험) 파일 부분 실패 → (완화) best-effort 격리, DB 정본 우선, 응답 필드로 가시화.
- (위험) 뷰어/헤드리스 경로 불일치 → (완화) 동일 closure 핸들러 공유.

---

## 10. 가정 · 미해결(리더 확인 사항)

- **가정 A:** parking_evnt/parking_slot 은 현재 writer 미작성으로 비어 있음(00_leader_context §DB). 방어 카운트로 안전장치 병행.
- **가정 B:** slot_ptz.json 경로는 `deps.calibrate.outFile`(=data/slot_ptz.json). calibrate deps 미주입 헤드리스 구성이면 slot_ptz 리맵 스킵('skipped').
- **결정 C(플래그):** setup_artifact 는 DB 재빌드(§5 옵션1). setup_artifact.json 에만 있던 수동 ROI 폴리곤 편집은 DB-파생 bbox 로 치환됨 — 현 데이터모델(DB=기하 정본)에서 정합이나, ROI 폴리곤 보존이 요건이면 별도 과제(범위 밖).
- **결정 D:** 라우트는 server.ts 에 배치(captureRoutes 아님) — deps 스레딩 최소화. 경로명 `/mapping/renumber`(+뷰어) — 기존 /mapping 계열과 의미 일관.
- 상충 없음: 요청과 설계 결정(DB 정본·LLM 최소·5소수·전량보존) 모두 부합.
