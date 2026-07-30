// ★ 21회차 Phase 3 — 진행바 **3상태 스샷**(마스터 상시 요구: 실측 + 스샷).
//
// ══════════════════════════════════════════════════════════════════════════
// ★ 이 그림의 한계를 먼저 적는다(그래야 오해가 없다)
//   이 저장소에는 브라우저 자동화가 없다. 그래서 실제 렌더가 아니라 **SVG 재현**이다:
//     · 색·치수는 `web/app.css` 에서 **실제로 파싱**해 쓴다(하드코딩 아님 — 팔레트 드리프트 방지).
//     · **문구·진행률은 `web/apProgress.js` 를 그대로 호출**해 만든다(그림이 로직과 어긋날 수 없다).
//     · 그러나 **폰트·자간·flex 배치·CSS 애니메이션은 브라우저와 다를 수 있다.** 불확정 상태의
//       "왕복 띠"는 애니메이션 한 프레임을 정지 화면으로 그린 것이다.
//   → 배치·정렬의 최종 확인은 마스터/리더의 **브라우저 육안**이 필요하다. 이 그림은 모양·문구·상태 전환의
//     검증까지만 담당한다.
// ══════════════════════════════════════════════════════════════════════════
//
// 사용: npx tsx src/tools/apProgressShots.ts [outDir]

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
// ★ 판정·문구는 뷰어와 **같은 모듈**을 쓴다(재구현 0줄).
import { apDoneSummary, apEta, apProgressState } from '../../web/apProgress.js';

const outDir = process.argv[2] ?? 'reports/overlay_r21d';
mkdirSync(outDir, { recursive: true });

/** `web/app.css` 의 `:root` 토큰을 실제로 읽는다. 없으면 던진다(조용히 다른 색으로 그리지 않는다). */
function cssToken(css: string, name: string): string {
  const m = css.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`app.css 에 --${name} 토큰이 없다`);
  return m[1].trim();
}
/** `.ap-progress*` 규칙에서 숫자 값을 읽는다(치수도 CSS 를 따른다). */
function cssNum(css: string, selector: string, prop: string): number {
  const block = css.slice(css.indexOf(selector));
  const m = block.slice(0, 400).match(new RegExp(`${prop}:\\s*([0-9.]+)`));
  if (!m) throw new Error(`${selector} 에 ${prop} 이 없다`);
  return Number(m[1]);
}

const css = readFileSync('web/app.css', 'utf8');
const C = {
  surface: cssToken(css, 'surface'),
  line: cssToken(css, 'line'),
  lineSoft: cssToken(css, 'line-soft'),
  accent: cssToken(css, 'accent'),
  faint: cssToken(css, 'faint'),
  muted: cssToken(css, 'muted'),
  text: cssToken(css, 'text'),
};
const trackH = cssNum(css, '.ap-progress-track', 'height');
const indetW = cssNum(css, '.ap-progress-track.indeterminate .ap-progress-fill', 'width'); // %

const W = 760;
const H = 132;
const PAD = 16;
const LABEL_W = 128; // .ap-progress-label min-width
const TRACK_X = PAD;
const TRACK_Y = 52;
const GAP = 8; // .ap-progress gap

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 한 상태를 그린다. `msg` 는 기존 텍스트 메시지(#ap-msg) — 가산 레이어임을 보이기 위해 함께 그린다. */
function svgOf(title: string, state: ReturnType<typeof apProgressState> | null, label: string, msg: string, done: boolean): string {
  const trackW = done ? 0 : W - PAD * 2 - LABEL_W - GAP;
  const parts: string[] = [];
  parts.push(`<rect width="${W}" height="${H}" rx="12" fill="${C.surface}"/>`);
  parts.push(`<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="none" stroke="${C.line}"/>`);
  parts.push(
    `<text x="${PAD}" y="28" fill="${C.text}" font-family="Segoe UI, sans-serif" font-size="14" font-weight="600">${esc(title)}</text>`,
  );
  if (!done) {
    // 트랙
    parts.push(`<rect x="${TRACK_X}" y="${TRACK_Y}" width="${trackW}" height="${trackH}" rx="${trackH / 2}" fill="${C.lineSoft}"/>`);
    if (state?.determinate) {
      parts.push(
        `<rect x="${TRACK_X}" y="${TRACK_Y}" width="${((state.percent ?? 0) / 100) * trackW}" height="${trackH}" rx="${trackH / 2}" fill="${C.accent}"/>`,
      );
    } else {
      // 불확정 — 좁은 띠 1프레임(애니메이션 중간 위치). 채우지 않는다.
      const bandW = (indetW / 100) * trackW;
      parts.push(
        `<rect x="${TRACK_X + trackW * 0.42}" y="${TRACK_Y}" width="${bandW}" height="${trackH}" rx="${trackH / 2}" fill="${C.accent}"/>`,
      );
    }
    parts.push(
      `<text x="${W - PAD}" y="${TRACK_Y + trackH + 6}" fill="${C.faint}" font-family="Segoe UI, sans-serif" font-size="11" text-anchor="end">${esc(label)}</text>`,
    );
  } else {
    parts.push(
      `<text x="${PAD}" y="${TRACK_Y + trackH + 4}" fill="${C.muted}" font-family="Segoe UI, sans-serif" font-size="11">${esc(label)}</text>`,
    );
  }
  // 기존 텍스트 메시지(#ap-msg) — 삭제하지 않았음을 그림으로 보인다.
  parts.push(
    `<text x="${PAD}" y="${H - 24}" fill="${C.faint}" font-family="Segoe UI, sans-serif" font-size="12">${esc(msg)}</text>`,
  );
  parts.push(
    `<text x="${PAD}" y="${H - 8}" fill="${C.faint}" font-family="Segoe UI, sans-serif" font-size="10">※ SVG 재현 — 색·치수는 app.css 파싱, 문구·진행률은 apProgress.js 호출. 폰트·flex·애니메이션은 브라우저와 다를 수 있다.</text>`,
  );
  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
}

const eta = apEta({ currentView: true }); // 시뮬 현재뷰 12초(실측 12140/12104ms)
const running = apProgressState(3_000, eta.ms);
const overdue = apProgressState(eta.ms + 4_000, eta.ms);
const doneText = apDoneSummary({ ok: true, quads: 7, frameHash: '6006a034bfe2', elapsedMs: 12_345 });

const shots: Array<{ file: string; svg: string; note: string }> = [
  {
    file: 'ap_progress_1_running.png',
    note: `진행 중(확정) — ${running.percent}%`,
    svg: svgOf(
      `① 진행 중 — 확정 막대(경과 3.0초 ÷ 예상 ${eta.ms / 1000}초)`,
      running,
      running.label,
      '검출 중… 3초 경과 (예상 약 12초 — 카메라 이동 없음 · simulator-1 · cam 1 현재 화면 그대로)',
      false,
    ),
  },
  {
    file: 'ap_progress_2_overdue.png',
    note: '예상 시간 초과(불확정) — aria-valuenow 없음',
    svg: svgOf(
      '② 예상 시간 초과 — 불확정 막대(좁은 띠가 왕복 · 채우지 않는다)',
      overdue,
      overdue.label,
      '검출 중… 16초 경과 (예상 약 12초 — 카메라 이동 없음 · simulator-1 · cam 1 현재 화면 그대로)',
      false,
    ),
  },
  {
    file: 'ap_progress_3_done.png',
    note: '완료 — 결과 요약으로 대체',
    svg: svgOf('③ 완료 — 막대를 결과 요약으로 대체(시간이 아니라 결과)', null, doneText, '검출 7면 · 소스 simulator-1(rpc) · 12초 소요', true),
  },
];

for (const s of shots) {
  await sharp(Buffer.from(s.svg)).png().toFile(join(outDir, s.file));
  console.log(`${s.note} → ${join(outDir, s.file)}`);
}
// 3상태를 한 장으로도 붙인다(리더 육안 대조용).
const stack = await sharp({ create: { width: W, height: H * 3 + 16, channels: 4, background: { r: 11, g: 16, b: 22, alpha: 1 } } })
  .composite(shots.map((s, i) => ({ input: Buffer.from(s.svg), top: i * (H + 8), left: 0 })))
  .png()
  .toBuffer();
await sharp(stack).toFile(join(outDir, 'ap_progress_all.png'));
console.log(`3상태 합본 → ${join(outDir, 'ap_progress_all.png')}`);
console.log(
  `\n★ 한계: 브라우저 자동화가 없어 **SVG 재현**이다. 색·치수는 app.css 파싱(track ${trackH}px · 불확정 띠 ${indetW}%),\n` +
    `  문구·진행률은 apProgress.js 호출. 폰트·자간·flex 배치·CSS 애니메이션은 실제 렌더와 다를 수 있다 — 배치 최종 확인은 브라우저 육안.`,
);
