// 도색선 기반 자동 주차면 검출(`roi.auto.detect` / `roi.auto.score`) 응답 → 뷰어가 그릴 목록·요약으로 변환.
// **순수 ESM**(DOM/fetch/브라우저 전역 미참조) — vitest 가 직접 import 한다(core.js·placeDraw.js 관례).
//
// ★ 이 모듈은 아무것도 추정하지 않는다. 좌표(quadNorm)·IoU·frameHash 는 전부 **서버 산출을 그대로** 옮긴다.
//   뷰어가 IoU 를 다시 계산하거나 자동 quad ↔ 슬롯 귀속을 지어내지 않는다(귀속은 응답에 없다 — slotScoreItems 주석).

/**
 * 구조적 강등 코드 — 통과 집계에서 제외한다.
 * `src/ground/bayGeometry.ts` DEGRADE 의 D8/D9 와 같은 문자열이며,
 * 서버 `summarize`(roiAutoScore.ts:246)가 쓰는 STRUCTURAL 집합과 동일하다(≥0.95 면수만 서버에 없어 여기서 센다).
 */
const STRUCTURAL_DEGRADE = ['D8_NON_QUAD', 'D9_SLOT24'];

/**
 * 응답 정규화. `roi.auto.detect` 는 `presets[i]` 자체가 검출 뷰이고,
 * `roi.auto.score` 는 `presets[i].detect` 에 검출 뷰가 중첩되고 바깥이 채점 결과다(roiAuto.ts:493).
 * 두 형태를 한 모양으로 접어 렌더·요약이 분기를 갖지 않게 한다.
 */
export function autoPaintViews(result) {
  const out = [];
  for (const p of result?.presets ?? []) {
    const scored = p && typeof p === 'object' && p.detect ? p : null;
    const d = scored ? scored.detect : p;
    if (!d || typeof d !== 'object') continue;
    out.push({
      key: d.key ?? `${d.camId}:${d.presetIdx}`,
      camId: d.camId ?? null,
      presetIdx: d.presetIdx ?? null,
      frameHash: d.frameHash ?? null,
      quads: d.quads ?? [],
      // ★ 20회차 — 「현재 화면 그대로」 응답에만 붙는다. preset 응답에는 없어 종전과 동일하게 접힌다.
      view: d.view ?? null,
      ptzUsed: d.ptzUsed ?? null,
      rows: d.rows ?? [],
      // 채점 응답의 issues 는 검출 issues 를 이미 포함한다(서버가 push 로 합친다 — roiAuto.ts:490).
      issues: (scored ? scored.issues : d.issues) ?? [],
      slots: scored ? scored.slots ?? [] : [],
      scored: Boolean(scored),
      meanIoU: scored ? scored.meanIoU ?? null : null,
      graded: scored ? Boolean(scored.graded) : false,
      gradeReason: scored ? scored.gradeReason ?? null : null,
    });
  }
  return out;
}

/**
 * 프리셋 키(`cam:preset`)에 해당하는 뷰 1건(없으면 null). 다른 프레임을 보고 있으면 그리지 않기 위한 게이트.
 *
 * ★ 20회차 — 현재뷰(`cam:current`)는 **프리셋에 속하지 않는다**. 게이트의 취지는 "다른 프레임의 산출물을
 *   이 화면에 그리지 않는다"이고, 현재뷰는 그 카메라가 지금 보고 있는 화면이므로 **카메라가 같으면** 그린다.
 */
export function autoPaintViewFor(result, key) {
  const views = autoPaintViews(result);
  const hit = views.find((v) => v.key === key);
  if (hit) return hit;
  const camId = Number(String(key).split(':')[0]);
  return views.find((v) => v.view === 'current' && v.camId === camId) ?? null;
}

/**
 * IoU 라벨. 수치가 아니면 `IoU —`(없는 값을 0 으로 위장하지 않는다).
 *
 * ★ 자릿수가 2 가 아니라 3 인 이유(실측 근거): 1:1 라이브 채점에서 면별 IoU 가 0.9784·0.9793 인데
 *   2자리로 자르면 전부 `0.98` 로 보이고, 같은 화면의 요약은 `≥0.98 0면` 이라 **화면이 스스로와 모순**된다.
 *   0.98 은 이 프로젝트의 판정 경계값이라 하필 그 자리에서 반올림하면 안 된다.
 */
export function formatIoU(v) {
  return Number.isFinite(v) ? `IoU ${v.toFixed(3)}` : 'IoU —';
}

/**
 * 자동 quad 그리기 목록 — 좌표는 응답 그대로, 라벨은 격자 인덱스. 4점이 아닌 항목은 버린다.
 *
 * ★ 20회차 「리스트」 — 현재뷰 응답에는 `rows`(보이는 행 전체)가 실린다. 대표 행(`quads`)과 **합집합**을
 *   그린다. `rows` 가 없는 preset 응답에서는 목록·순서·라벨이 종전과 완전히 같다(회귀 0).
 *   `rows` 가 대표 행을 항상 포함하지는 않으므로(19회차 진입 문턱에 걸려 `rows` 가 빌 수 있다)
 *   합집합이지 대체가 아니다. 좌표가 같은 것은 접는다(같은 면을 두 번 그리지 않는다).
 */
export function autoQuadItems(view) {
  const ok = (q) => Array.isArray(q?.quadNorm) && q.quadNorm.length === 4;
  const sigOf = (q) => q.quadNorm.map((p) => `${p.x},${p.y}`).join('|');
  const out = (view?.quads ?? []).filter(ok).map((q) => ({ quadNorm: q.quadNorm, label: `#${q.latticeIndex}` }));
  const seen = new Set(out.map((q) => sigOf(q)));
  for (const r of view?.rows ?? []) {
    for (const q of r?.quads ?? []) {
      if (!ok(q) || seen.has(sigOf(q))) continue;
      seen.add(sigOf(q));
      out.push({ quadNorm: q.quadNorm, label: `r${r.rowIndex}#${q.latticeIndex}` });
    }
  }
  return out;
}

/**
 * 면별 점수 라벨 목록(채점했을 때만 비지 않는다).
 *
 * ★ 라벨을 **자동 quad 가 아니라 수동 슬롯**에 붙이는 이유: 응답에 자동 quad ↔ 슬롯 귀속이 **없다**.
 *   `scorePreset`(src/ground/roiAutoScore.ts:191)은 슬롯마다 자동 quad 전체에 대한 IoU **최댓값**만 남기고
 *   어느 quad 였는지는 버린다. 순서로 짝짓는 것은 지어내는 것이므로 하지 않는다.
 *   IoU 는 그 값이 실제로 측정된 대상(= 수동 슬롯) 위에 그린다.
 */
export function slotScoreItems(view) {
  return (view?.slots ?? []).map((s) => ({
    slotIdx: s.slotIdx,
    iou: Number.isFinite(s.iouVsManual) ? s.iouVsManual : null,
    degrade: s.degrade ?? null,
    label: `s${s.slotIdx} ${formatIoU(s.iouVsManual)}${s.degrade ? ` ${s.degrade}` : ''}`,
  }));
}

/** 임계 이상 통과 면수. 서버 summarize 와 같은 필터(미채점 프리셋 제외 + 구조적 강등 제외). */
export function passCount(result, min) {
  let n = 0;
  for (const v of autoPaintViews(result)) {
    if (!v.scored || !v.graded) continue;
    for (const s of v.slots) {
      if (s.degrade && STRUCTURAL_DEGRADE.includes(s.degrade)) continue;
      if (Number.isFinite(s.iouVsManual) && s.iouVsManual >= min) n++;
    }
  }
  return n;
}

/** 화면 요약에 필요한 수치 묶음. 평균/최소/≥0.98 은 **서버 summary 를 그대로** 쓰고 ≥0.95 만 여기서 센다. */
export function autoPaintSummary(result) {
  const views = autoPaintViews(result);
  const s = result?.summary ?? null;
  return {
    scored: views.some((v) => v.scored),
    presetCount: views.length,
    quadCount: views.reduce((n, v) => n + (v.quads?.length ?? 0), 0),
    frameHashes: views.map((v) => v.frameHash ?? '-'),
    keys: views.map((v) => v.key),
    meanIoU: s?.meanIoU ?? null,
    minIoU: s?.minIoU ?? null,
    gradedSlots: s?.gradedSlots ?? 0,
    pass98: s?.pass98 ?? 0,
    pass95: passCount(result, 0.95),
  };
}

/**
 * 요약 한 줄. **frameHash 는 항상 넣는다** — 해시 없는 IoU 는 어느 프레임의 점수인지 알 수 없어 해석 불가(F13).
 * 평균은 4자리(판정용), 면별 라벨은 2자리(가독성)로 자릿수를 나눈다.
 */
export function autoPaintSummaryText(result) {
  const s = autoPaintSummary(result);
  const hash = `frameHash ${s.frameHashes.join('/')}`;
  const head = `프리셋 ${s.keys.join(',') || '-'} · 검출 ${s.quadCount}면 · ${hash}`;
  if (!s.scored) return head;
  const mean = Number.isFinite(s.meanIoU) ? s.meanIoU.toFixed(4) : '—';
  const min = Number.isFinite(s.minIoU) ? s.minIoU.toFixed(4) : '—';
  return `평균 IoU ${mean} · 최소 ${min} · ≥0.95 ${s.pass95}/${s.gradedSlots}면 · ≥0.98 ${s.pass98}면 · ${head}`;
}

/** 프리셋별 issues(지상고 자가보정·재적합 로그가 여기 담긴다 — 진단 핵심). 빈 프리셋은 뺀다. */
export function autoPaintIssues(result) {
  return autoPaintViews(result)
    .map((v) => ({ key: v.key, issues: v.issues ?? [] }))
    .filter((e) => e.issues.length > 0);
}
