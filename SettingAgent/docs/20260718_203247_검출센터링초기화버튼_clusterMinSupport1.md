# 검출·센터링 DB 초기화 버튼 + clusterMinSupport 3→1

작성: 문서화 담당(documenter) · 대상 브랜치: `feat/vpd-seg-cuboid` · 작성일시: 2026-07-18 20:32
연계 규칙: CLAUDE.md 4(상세 문서화) · 5(영향도 분석)
입력: `_workspace/01_architect_plan.md`(설계자) · `_workspace/02_developer_changes.md`(구현자) · `_workspace/03_qa_report.md`(검증자) + 실제 diff
직전 문서(짝): `docs/20260718_201025_finalize검출보존_방어가드.md`(finalize 방어 가드)

---

## 1. 배경 — 가드와의 관계(보존 vs 의도적 비움)

마스터 요구 원문: "기본가드는 그대로 유지하고, vpd/lpd/occupy/centering을 초기화하는 버튼을 만들어주고, 정밀수집 3회 이상후 최종화가 아닌 1회 이상 최종화로 변경."

직전 세션에서 `Finalizer.finalize`에 방어 가드가 들어갔다: 검출 hit이 없는(`accepted=0`) finalize가 실행돼도 기존 `vpd_bbox`/`lpd_obb`/`occupy_range`를 `null`로 덮어쓰지 않고 보존한다. 이 가드는 데이터를 지키는 방향으로만 동작하므로, **사용자가 의도적으로 검출·센터링 결과를 비우고 싶을 때(재캡처 전 초기화 등) 수단이 사라진다.** 이번 변경의 Part A는 그 유일한 의도적 비움 경로를 수동 버튼으로 제공한다. 가드는 무변경이다.

Part B는 별개 요구다. `accepted=0`이 되는 상위 원인 중 하나가 `clusterMinSupport`(같은 차량을 몇 라운드 관측해야 후보 클러스터로 승격시킬지)였다. 기본값 3이라 "3회 이상 관측"이 필요했는데, 마스터는 이를 1로 낮춰 "1회 관측만으로도 최종화 저장이 되게" 요구했다.

두 Part는 서로 독립이지만 상호작용한다: `clusterMinSupport=1`로 accepted≥1이 쉬워지면서 finalize가 실 데이터를 채우는 빈도가 늘고, 가드는 그 사이 사이(관측 실패한 finalize)의 파괴를 계속 막아준다. 초기화 버튼은 그 관계에서 유일하게 남는 "일부러 null로 되돌리는" 통로다.

## 2. Part A — 검출·센터링 DB 초기화

### 2.1 `SqliteStore.clearSlotSetupEnrichment` (신규 메서드)

`src/capture/SqliteStore.ts:274-281`, `upsertSlotCentering` 바로 뒤(클래스 끝)에 추가.

```ts
/** slot_setup 검출·센터링 컬럼 전량 초기화(수동 '초기화' 버튼). slot_roi·행은 보존. 반환=초기화 행수. */
clearSlotSetupEnrichment(updatedAt: string): number {
  const info = this.db.prepare(
    `UPDATE slot_setup SET vpd_bbox=NULL, lpd_obb=NULL, occupy_range=NULL,
     pan=NULL, tilt=NULL, zoom=NULL, centered=0, img1=NULL, updated_at=?`,
  ).run(updatedAt);
  return info.changes;
}
```

- 대상 8컬럼: `vpd_bbox`/`lpd_obb`/`occupy_range`(검출) + `pan`/`tilt`/`zoom`/`centered`/`img1`(센터라이징) → `NULL`(centered만 `0`).
- **비대상**: `slot_roi`(바닥 ROI geometry)와 행 자체(`slot_id`/`preset_key`/`preset_slot_idx`) — `WHERE` 절 없이 전 행을 UPDATE하지만 컬럼 자체를 건드리지 않으므로 보존된다.
- `upsertSlotCentering`(부분 UPDATE 패턴)을 준용하되, 이쪽은 `WHERE` 없이 전량 대상.
- 반환값 `info.changes`(초기화된 행 수) — 호출자(라우트)가 그대로 응답에 전달.
- 기존 `replaceSlotSetup`/`getSlotSetup`/`upsertSlotCentering`은 시그니처·본문 모두 무변경(순수 가산).

### 2.2 `POST /capture/slots/reset` (신규 라우트)

`src/api/captureRoutes.ts:275-278`, `GET /capture/slots` 바로 뒤에 추가.

```ts
app.post('/capture/slots/reset', async () => {
  const cleared = deps.store.clearSlotSetupEnrichment(new Date().toISOString());
  return { ok: true, cleared };
});
```

- **REST 계약**: 요청 body 없음(웹 클라이언트는 관례상 `{}` 전송) → 응답 `200 { ok: true, cleared: number }`.
- `deps.store`는 라우트 등록부에 이미 주입돼 있던 의존성(기존 시그니처 그대로 재사용).

### 2.3 웹 버튼 — `web/index.html`

`#cap-finalize`와 `#cap-detect-run` 사이(`:181`)에 추가.

```html
<button id="cap-reset-db" title="DB(slot_setup)의 검출(VPD/LPD)·점유영역·센터라이징(PTZ)을 모두 초기화. 바닥 ROI/슬롯은 유지. 되돌릴 수 없음(재캡처·재센터링 필요)">검출·센터링 초기화</button>
```

### 2.4 웹 핸들러 — `web/app.js`

함수(`:2049-2060`, `resetOverlayDisplay`/`capFinalize` 인근)와 이벤트 배선(`:3051`, `$('roi-clear')` 옆) 2곳 추가.

```js
async function resetSlotSetupDb() {
  if (!confirm('DB의 검출(VPD/LPD)·점유영역·센터라이징(PTZ)을 모두 초기화합니다. 되돌릴 수 없습니다. 진행할까요?')) return;
  const res = await fetch('/capture/slots/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { $('cap-msg').textContent = `초기화 실패: ${data.error ?? res.status}`; return; }
  resetOverlayDisplay();           // 클라 라이브 오버레이(detect/occ/vcuboid) 정리.
  await loadParkingSlots();        // DB 재조회 → null 반영(parkingSlotsByKey 갱신).
  drawRoiOverlay();
  renderSlotList();
  $('cap-msg').textContent = `초기화 완료: ${data.cleared ?? 0}개 슬롯`;
}
// ...
$('cap-reset-db').addEventListener('click', resetSlotSetupDb);
```

동작 흐름: 클릭 → `confirm()` 경고(되돌릴 수 없음 명시) → 승인 시 `POST /capture/slots/reset` → 성공 시 클라이언트 라이브 오버레이 초기화 + DB 재조회로 화면·리스트를 null 상태로 재동기화 → `cap-msg`에 초기화 행수 표시. 실패 시 에러 메시지만 표시하고 화면은 그대로 둔다.

**되돌릴 수 없음**: 이 버튼으로 비운 값은 재캡처(정밀수집)와 재센터라이징을 거쳐야만 다시 채워진다. 전 슬롯 전역 초기화이며 프리셋 단위 선택 옵션은 없다.

## 3. Part B — clusterMinSupport 3→1

`config/tools.config.json` **capture 섹션**(`:60`) `"clusterMinSupport": 3` → `1`. (`setup` 섹션 `:34`는 이미 1이라 원래도 무관했음, 이번에 손대지 않음.)

- **효과**: 클러스터 집계(Aggregator)에서 `support < clusterMinSupport`가 rejected 판정 조건이므로, `support=1`(1회 관측)도 `1<1==false`가 되어 `candidate`로 승격한다. 이전(3)에서는 `1<3==true`로 무조건 rejected였다. 결과적으로 "정밀수집 1회 후 최종화 저장"이 성립한다.
- **트레이드오프**: 단일 관측만으로 후보 승격되므로 false positive(오검출이 그대로 최종화될) 가능성이 이전보다 높아진다. 마스터 지시에 따라 수용.
- **⚠️ 운영 주의**: `config/`는 nodemon 감시 대상이 아니다. 이 값이 실제로 적용되려면 **서버 재기동이 필요**하다(마스터/운영자 안내 필요).
- 코드 상의 default(`toolsConfig.ts`의 `DEFAULT_CONFIG.capture.clusterMinSupport = 3`)는 **미변경**. config 파일이 런타임 권위(실제로 로드되는 값)이며, default를 건드리지 않아 default에 의존하는 기존 테스트의 기대값이 그대로 유지된다.

## 4. 입출력 계약 요약

| 항목 | 내용 |
|---|---|
| 신규 REST | `POST /capture/slots/reset` → `{ ok: true, cleared: number }` (요청 body 없음/무시) |
| 신규 store API | `clearSlotSetupEnrichment(updatedAt: string): number` |
| DB 영향 | `slot_setup`의 8컬럼(vpd_bbox/lpd_obb/occupy_range/pan/tilt/zoom/centered/img1)만 null·0화. `slot_roi`·행·slot_id·preset_key·preset_slot_idx 불변 |
| config 변경 | `config/tools.config.json` capture.clusterMinSupport: 3 → 1 (재기동 필요) |
| 기존 REST/스키마 | 변경 없음 |

## 5. 검증 결과(실제 실행, 요약 인용)

검증자(qa-tester)가 실 `SqliteStore(:memory:)` + 실 라우트 부팅으로 왕복 검증했다(`_workspace/03_qa_report.md`).

| 항목 | 결과 |
|---|---|
| `npm run typecheck` | exit 0(에러 0) |
| 신규 테스트 파일 | 3개 / 11케이스 전부 통과 |
| 전체 스위트 `npx vitest run` | 160 파일 / 1745 테스트 전부 통과(exit 0) |
| 회귀 가드(finalizerPreserveDetection·dbOverlayParity) | 그린 유지(6/6) |

신규 테스트 3파일:

1. **`test/clearSlotSetupEnrichment.test.ts`**(4케이스) — 풍부한 슬롯 채운 뒤 clear → 8필드 전부 null/false 확인, `slot_roi`·행·slotId·presetKey·presetSlotIdx 보존 확인, 다중 슬롯(3행) → `changes=3`(개별 roi 보존), 빈 테이블 → `changes=0`(throw 없음).
2. **`test/captureResetRoutes.test.ts`**(3케이스) — 빈 상태 200 `{ok:true,cleared:0}`, `clearSlotSetupEnrichment` 스파이 위임 확인(인자가 ISO 문자열), **왕복 검증**: 2슬롯 시드 → GET로 enrichment 채워짐 확인 → reset(`cleared:2`) → 재조회 시 enrichment 전부 null·roi/행수 2 보존.
3. **`test/clusterMinSupportOne.test.ts`**(4케이스) — support=1 관측이 `clusterMinSupport:1`이면 `candidate`, `clusterMinSupport:3`이면 `rejected`(대조), 다중 프리셋·경계값(support=2)까지 확인.

경계면 교차 비교: route↔store 응답 필드명/타입 일치, store가 쓰는 8컬럼 ↔ `getSlotSetup` 파생 뷰 필드 매핑 정합, config 파일 값(1) vs 코드 default(3, 미변경) 분리 확인.

## 6. 한계

- **웹 UI 미검증**: `#cap-reset-db` 버튼·`resetSlotSetupDb()`는 DOM 결합이라 vitest 대상 밖. 실제 클릭→confirm→초기화 메시지→오버레이/리스트 갱신 확인은 리더/마스터의 경험적 확인이 필요하다.
- **config 런타임 반영 미검증**: nodemon이 `config/`를 감시하지 않아 서버 재기동 없이는 `clusterMinSupport=1`이 반영되지 않는다. 유닛테스트는 파라미터 주입으로 승격 로직만 증명했고, 재기동 후 "1회 캡처→최종화 저장" 라이브 스모크는 별도 확인이 필요하다.
- **이미 파괴된 실 DB 값**: 초기화 버튼은 새 기능이며, 직전 방어 가드 도입 이전에 이미 null로 덮어써진 값이 있다면 이 변경으로 복구되지 않는다(재캡처만이 복구 경로).

---

## 7. 영향도 분석 요약

전체 상세는 `_workspace/04_doc_impact.md` 참조. 핵심: 변경은 `SqliteStore`에 메서드 1개, `captureRoutes`에 라우트 1개, `web/`에 버튼·핸들러 1쌍을 **가산**했을 뿐 기존 메서드·라우트·시그니처는 전혀 건드리지 않았다. `config/tools.config.json`의 값 변경 1건은 코드 default와 분리돼 기존 테스트 회귀가 없다. `Finalizer`(방어 가드)·센터라이징·DB 오버레이 로직은 이번 변경에서 무변경이다.
