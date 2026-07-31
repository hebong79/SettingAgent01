// ★ 22회차 — 「근변 무도색」이 구조인가 야간 가시성인가 (교락 판정)
//
// 마스터 가설: ⓕ 측정(`_workspace/02z_developer_emptybay_probe_round22.md`)은 **야간 실카 프레임**에서 나왔다.
// 거기서 내린 「이 현장은 근변에 도색선이 없다 — 재질 경계뿐」이 실은 「밤이라 근변 도색이 안 보였다」일 수 있다.
// 대낮 프리셋 5장(EV1~EV5)이 같은 현장의 통제군이므로, 그 위에서 **순수 밝기 프로파일**로 가린다.
//
// 하는 일 (검출 알고리즘 무수정 · 지면모델/f/PTZ 불필요):
//   A) 정답(truth.json)의 각 변 위치에서 원시 밝기 프로파일을 뽑아
//      **도색 띠**(양옆보다 밝은 국소 봉우리) vs **재질 경계**(계단형 이행)를 수치로 구분
//   B) 낮 이미지에 `detectPaintLines` 를 돌려 근변선을 잡는지(rank·votes·대비) 확인
//   C) 면별 4변(near/far/side×2) 분해 — ⓕ 의 near/far 비대칭이 낮에도 같은 방향인지
//
// ⚠ 관찰·판정 전용. 채점 아님. 정본·DB·카메라 무접촉.
// 사용: npx tsx src/tools/evPresetNearEdge.ts

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  DEFAULT_PAINT_OPTIONS,
  detectPaintLines,
  lineThrough,
  type FrameGray,
  type Line2,
  type RefinedLine,
} from '../ground/floorPaint.js';

// ── 판정 규약 (한 곳에 모음 — 마스터 검수로 갈아끼우기 쉽게)
const PROFILE_HALF_PX = 24; // 변에 수직인 프로파일 반폭
const PROFILE_STEP_PX = 0.5; // 프로파일 표본 간격
const SAMPLES_PER_EDGE = 25; // 변 하나당 프로파일 개수
const CORE_HALF_PX = 8; // 봉우리를 찾는 중심 구간 반폭
const FLANK_INNER_PX = 12; // 양옆 배경 구간 시작(|t| >= 이 값)
const BUMP_MIN = 20; // 도색 띠로 인정하는 최소 봉우리 높이 (peak − max(양옆 배경))
const STEP_MIN = 12; // 재질 경계로 인정하는 최소 계단 높이 |bgR − bgL|
const VERDICT_FRAC = 0.5; // 변 판정: 표본 중 해당 분류 비율
const MIN_SAMPLES = 5; // 이보다 표본이 적으면 unclear(표본부족)
const DETECTOR_MIN_CONTRAST = DEFAULT_PAINT_OPTIONS.minContrast; // 45 — 검출기 자신의 스트라이프 기준

const FIX_DIR = 'test/fixtures/evPreset';
const OUT_DIR = 'reports/overlay_r22g';
mkdirSync(OUT_DIR, { recursive: true });

type Pt = { x: number; y: number };
type EdgeClass = 'paint' | 'material' | 'occluded' | 'unclear';

interface TruthLine {
  id: string;
  kind: 'near' | 'far' | 'sep';
  a: Pt;
  b: Pt;
  uncertain: boolean;
  evidence: string;
}
interface TruthCorner {
  status: 'observed' | 'uncertain' | 'offscreen' | 'occluded';
  pt: Pt | null;
}
interface TruthBay {
  id: string;
  occupied: boolean;
  leftSep: string;
  rightSep: string;
  corners: Record<string, TruthCorner>;
}
interface TruthPreset {
  preset: string;
  imageWidth: number;
  imageHeight: number;
  osdPtz: string;
  sceneNote: string;
  lines: TruthLine[];
  bays: TruthBay[];
}

function bilinear(f: FrameGray, x: number, y: number): number | null {
  if (!(x >= 0 && y >= 0 && x <= f.width - 1 && y <= f.height - 1)) return null;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, f.width - 1);
  const y1 = Math.min(y0 + 1, f.height - 1);
  const fx = x - x0;
  const fy = y - y0;
  const p00 = f.data[y0 * f.width + x0];
  const p10 = f.data[y0 * f.width + x1];
  const p01 = f.data[y1 * f.width + x0];
  const p11 = f.data[y1 * f.width + x1];
  return (p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy;
}

function median(v: number[]): number {
  if (v.length === 0) return NaN;
  const s = [...v].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

interface ProfileSample {
  at: Pt;
  /** 중심 구간 최대 밝기 */
  peak: number;
  /** 봉우리 위치(px, 변 기준 부호 있는 법선 거리) */
  tPeak: number;
  /** 양옆 배경(법선 음/양 방향) */
  bgNeg: number;
  bgPos: number;
  /** 봉우리 높이 = peak − max(bgNeg,bgPos) */
  bump: number;
  /** 계단 = bgPos − bgNeg */
  step: number;
  cls: 'paint' | 'material' | 'unclear';
  /** 프로파일 원시값(대표 표본만 저장) */
  values?: number[];
}

interface EdgeReport {
  label: string;
  from: Pt | null;
  to: Pt | null;
  verdict: EdgeClass;
  samples: number;
  paintFrac: number;
  materialFrac: number;
  medianBump: number;
  medianAbsStep: number;
  /** 봉우리가 검출기 기준(minContrast 45)을 넘는 표본 비율 */
  fracBumpOverDetector: number;
  note: string;
  profiles: ProfileSample[];
}

/** 선분 위를 따라 수직 프로파일을 뽑아 도색 띠 / 재질 경계를 분류한다. */
function profileEdge(frame: FrameGray, label: string, from: Pt | null, to: Pt | null, note: string): EdgeReport {
  const empty: EdgeReport = {
    label,
    from,
    to,
    verdict: 'occluded',
    samples: 0,
    paintFrac: NaN,
    materialFrac: NaN,
    medianBump: NaN,
    medianAbsStep: NaN,
    fracBumpOverDetector: NaN,
    note,
    profiles: [],
  };
  if (!from || !to) return empty;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 1)) return { ...empty, verdict: 'unclear', note: `${note} 길이 0` };
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy; // 법선(좌회전)
  const ny = ux;

  const profiles: ProfileSample[] = [];
  for (let i = 0; i < SAMPLES_PER_EDGE; i++) {
    const s = ((i + 0.5) / SAMPLES_PER_EDGE) * len;
    const cx = from.x + ux * s;
    const cy = from.y + uy * s;
    const values: number[] = [];
    let ok = true;
    for (let t = -PROFILE_HALF_PX; t <= PROFILE_HALF_PX + 1e-9; t += PROFILE_STEP_PX) {
      const v = bilinear(frame, cx + nx * t, cy + ny * t);
      if (v === null) {
        ok = false;
        break;
      }
      values.push(v);
    }
    if (!ok) continue;
    const tOf = (k: number) => -PROFILE_HALF_PX + k * PROFILE_STEP_PX;
    let peak = -Infinity;
    let tPeak = 0;
    const neg: number[] = [];
    const pos: number[] = [];
    for (let k = 0; k < values.length; k++) {
      const t = tOf(k);
      if (Math.abs(t) <= CORE_HALF_PX && values[k] > peak) {
        peak = values[k];
        tPeak = t;
      }
      if (t <= -FLANK_INNER_PX) neg.push(values[k]);
      if (t >= FLANK_INNER_PX) pos.push(values[k]);
    }
    const bgNeg = median(neg);
    const bgPos = median(pos);
    const bump = peak - Math.max(bgNeg, bgPos);
    const step = bgPos - bgNeg;
    const cls: ProfileSample['cls'] = bump >= BUMP_MIN ? 'paint' : Math.abs(step) >= STEP_MIN ? 'material' : 'unclear';
    profiles.push({ at: { x: cx, y: cy }, peak, tPeak, bgNeg, bgPos, bump, step, cls, values });
  }

  if (profiles.length < MIN_SAMPLES) {
    return { ...empty, verdict: 'unclear', samples: profiles.length, note: `${note} 표본부족(${profiles.length})`, profiles };
  }
  const paintN = profiles.filter((p) => p.cls === 'paint').length;
  const matN = profiles.filter((p) => p.cls === 'material').length;
  const paintFrac = paintN / profiles.length;
  const materialFrac = matN / profiles.length;
  const verdict: EdgeClass = paintFrac >= VERDICT_FRAC ? 'paint' : materialFrac >= VERDICT_FRAC ? 'material' : 'unclear';
  return {
    label,
    from,
    to,
    verdict,
    samples: profiles.length,
    paintFrac,
    materialFrac,
    medianBump: median(profiles.map((p) => p.bump)),
    medianAbsStep: median(profiles.map((p) => Math.abs(p.step))),
    fracBumpOverDetector: profiles.filter((p) => p.bump >= DETECTOR_MIN_CONTRAST).length / profiles.length,
    note,
    profiles,
  };
}

/** 정답 직선을 검출 직선 목록에 대응시킨다. 각도 3° · 최대 수직거리 10px 이내. */
function matchDetected(
  truth: TruthLine,
  lines: RefinedLine[],
): { rank: number; votes: number; contrast: number; spanPx: number; maxDistPx: number; angleDeg: number } | null {
  const tl = lineThrough(truth.a, truth.b);
  if (!tl) return null;
  const mid: Pt = { x: (truth.a.x + truth.b.x) / 2, y: (truth.a.y + truth.b.y) / 2 };
  const probes = [truth.a, mid, truth.b];
  let best: { rank: number; votes: number; contrast: number; spanPx: number; maxDistPx: number; angleDeg: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const dl: Line2 = lines[i].line;
    const dot = Math.abs(tl[0] * dl[0] + tl[1] * dl[1]);
    const angleDeg = (Math.acos(Math.min(1, dot)) * 180) / Math.PI;
    if (angleDeg > 3) continue;
    let maxDist = 0;
    for (const p of probes) maxDist = Math.max(maxDist, Math.abs(dl[0] * p.x + dl[1] * p.y + dl[2]));
    if (maxDist > 10) continue;
    if (!best || maxDist < best.maxDistPx) {
      best = { rank: i, votes: lines[i].votes, contrast: lines[i].contrast, spanPx: lines[i].spanPx, maxDistPx: maxDist, angleDeg };
    }
  }
  return best;
}

const EDGE_COLOR: Record<EdgeClass, string> = {
  paint: '#00e5ff',
  material: '#ff9500',
  occluded: '#8a8a8a',
  unclear: '#c8c8c8',
};
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface PresetOut {
  preset: string;
  osdPtz: string;
  sceneNote: string;
  meanGrey: number;
  p05Grey: number;
  p95Grey: number;
  maskThreshold: number;
  detectedLines: number;
  lineEdges: Array<EdgeReport & { truthId: string; kind: string; detected: ReturnType<typeof matchDetected> }>;
  bayEdges: Array<{ bay: string; occupied: boolean; near: EdgeReport; far: EdgeReport; sideL: EdgeReport; sideR: EdgeReport }>;
}

const truth = JSON.parse(readFileSync(join(FIX_DIR, 'truth.json'), 'utf8')) as { presets: TruthPreset[] };
const out: PresetOut[] = [];

for (const P of truth.presets) {
  const src = join(FIX_DIR, `${P.preset}.png`);
  const meta = await sharp(src).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const gb = await sharp(src).greyscale().raw().toBuffer();
  const frame: FrameGray = { data: new Uint8Array(gb.buffer, gb.byteOffset, gb.byteLength), width: W, height: H };

  // 밝기 통계(밤/낮 확인용)
  const hist = new Float64Array(256);
  let sum = 0;
  for (let i = 0; i < frame.data.length; i++) {
    hist[frame.data[i]]++;
    sum += frame.data[i];
  }
  const meanGrey = sum / frame.data.length;
  let acc = 0;
  let p05 = 0;
  let p95 = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc <= frame.data.length * 0.05) p05 = v;
    if (acc <= frame.data.length * 0.95) p95 = v;
  }

  const { lines, threshold } = detectPaintLines(frame, DEFAULT_PAINT_OPTIONS);

  // A) 정답 직선별 프로파일 + 검출 대응
  const lineEdges = P.lines.map((L) => {
    const r = profileEdge(frame, `${L.id}(${L.kind})`, L.a, L.b, L.uncertain ? '정답 uncertain' : '');
    return { ...r, truthId: L.id, kind: L.kind, detected: matchDetected(L, lines) };
  });

  // C) 면별 4변 분해
  const bayEdges = P.bays.map((b) => {
    const c = b.corners;
    const pt = (k: string) => (c[k] && c[k].pt ? c[k].pt : null);
    const st = (k: string) => (c[k] ? c[k].status : 'missing');
    return {
      bay: b.id,
      occupied: b.occupied,
      near: profileEdge(frame, `${b.id}.near`, pt('nearLeft'), pt('nearRight'), `${st('nearLeft')}/${st('nearRight')}`),
      far: profileEdge(frame, `${b.id}.far`, pt('farLeft'), pt('farRight'), `${st('farLeft')}/${st('farRight')}`),
      sideL: profileEdge(frame, `${b.id}.sideL`, pt('nearLeft'), pt('farLeft'), `${st('nearLeft')}/${st('farLeft')}`),
      sideR: profileEdge(frame, `${b.id}.sideR`, pt('nearRight'), pt('farRight'), `${st('nearRight')}/${st('farRight')}`),
    };
  });

  out.push({
    preset: P.preset,
    osdPtz: P.osdPtz,
    sceneNote: P.sceneNote,
    meanGrey,
    p05Grey: p05,
    p95Grey: p95,
    maskThreshold: threshold,
    detectedLines: lines.length,
    lineEdges,
    bayEdges,
  });

  // ── 오버레이: 변 분류 + 프로파일 표본 위치
  const parts: string[] = [];
  const drawEdge = (e: EdgeReport, w: number) => {
    if (!e.from || !e.to) return;
    const col = EDGE_COLOR[e.verdict];
    const dash = e.verdict === 'occluded' || e.verdict === 'unclear' ? ' stroke-dasharray="10 7"' : '';
    parts.push(
      `<line x1="${e.from.x.toFixed(1)}" y1="${e.from.y.toFixed(1)}" x2="${e.to.x.toFixed(1)}" y2="${e.to.y.toFixed(1)}" stroke="${col}" stroke-width="${w}"${dash} opacity="0.95"/>`,
    );
    for (const p of e.profiles) {
      const c = p.cls === 'paint' ? '#00e5ff' : p.cls === 'material' ? '#ff9500' : '#bdbdbd';
      parts.push(`<circle cx="${p.at.x.toFixed(1)}" cy="${p.at.y.toFixed(1)}" r="2.6" fill="${c}" stroke="#000" stroke-width="0.6"/>`);
    }
  };
  for (const be of bayEdges) {
    drawEdge(be.far, 3);
    drawEdge(be.sideL, 3);
    drawEdge(be.sideR, 3);
    drawEdge(be.near, 6); // 근변만 굵게 — 이번 판정의 주인공
  }
  for (const le of lineEdges) {
    if (le.kind !== 'near') continue;
    parts.push(
      `<text x="${(le.to?.x ?? 0).toFixed(0)}" y="${((le.to?.y ?? 0) - 10).toFixed(0)}" fill="${EDGE_COLOR[le.verdict]}" font-size="24" font-weight="bold" text-anchor="end" stroke="#000" stroke-width="0.8">근변 ${le.truthId} = ${le.verdict}</text>`,
    );
  }
  for (const be of bayEdges) {
    const m = be.near.from && be.near.to ? { x: (be.near.from.x + be.near.to.x) / 2, y: (be.near.from.y + be.near.to.y) / 2 } : null;
    if (m) {
      parts.push(
        `<text x="${m.x.toFixed(0)}" y="${(m.y + 26).toFixed(0)}" fill="${EDGE_COLOR[be.near.verdict]}" font-size="20" font-weight="bold" text-anchor="middle" stroke="#000" stroke-width="0.8">${be.bay} near ${be.near.verdict} b${Number.isFinite(be.near.medianBump) ? be.near.medianBump.toFixed(0) : '—'}</text>`,
      );
    }
  }
  const nearLine = lineEdges.find((l) => l.kind === 'near');
  const farLine = lineEdges.find((l) => l.kind === 'far');
  const hdr = [
    `${P.preset} · OSD ${P.osdPtz} · 근변 도색 판정(밝기 프로파일 · f/PTZ 불필요)`,
    `평균밝기 ${meanGrey.toFixed(1)} (5%${p05} / 95%${p95}) · 마스크임계 ${threshold.toFixed(1)} · 검출직선 ${lines.length}개`,
    `근변선 ${nearLine ? `${nearLine.truthId}=${nearLine.verdict} bump ${nearLine.medianBump.toFixed(1)} step ${nearLine.medianAbsStep.toFixed(1)}` : '—'}` +
      ` │ 원변선 ${farLine ? `${farLine.truthId}=${farLine.verdict} bump ${farLine.medianBump.toFixed(1)}` : '—'}`,
    `시안=도색 띠 · 주황=재질 계단 · 회색점선=가림/불명 · 굵은선=근변`,
  ];
  parts.push(`<rect x="14" y="14" width="1310" height="${28 + hdr.length * 34}" fill="#000000cc" rx="10"/>`);
  hdr.forEach((t, i) =>
    parts.push(
      `<text x="30" y="${54 + i * 34}" fill="${i === 0 ? '#fff' : '#e0e0e0'}" font-size="${i === 0 ? 26 : 21}" font-weight="${i === 0 ? 'bold' : 'normal'}">${esc(t)}</text>`,
    ),
  );

  const dst = join(OUT_DIR, `nearedge_${P.preset}.png`);
  await sharp(src)
    .composite([{ input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`), top: 0, left: 0 }])
    .png()
    .toFile(dst);

  // ── 프로파일 그래프: 근변선 vs 원변선 vs 분리선 평균 프로파일
  const CH_W = 1200;
  const CH_H = 640;
  const gp: string[] = [`<rect width="${CH_W}" height="${CH_H}" fill="#111"/>`];
  const series: Array<{ name: string; color: string; e: EdgeReport }> = [];
  for (const le of lineEdges) {
    const col = le.kind === 'near' ? '#ff3b30' : le.kind === 'far' ? '#34c759' : '#5ac8fa';
    if (le.profiles.length >= MIN_SAMPLES) series.push({ name: `${le.truthId}(${le.kind})`, color: col, e: le });
  }
  const nT = Math.round((2 * PROFILE_HALF_PX) / PROFILE_STEP_PX) + 1;
  const x0 = 90;
  const y0 = 60;
  const pw = CH_W - x0 - 260;
  const ph = CH_H - y0 - 70;
  for (let g = 0; g <= 5; g++) {
    const yy = y0 + (ph * g) / 5;
    gp.push(`<line x1="${x0}" y1="${yy.toFixed(1)}" x2="${x0 + pw}" y2="${yy.toFixed(1)}" stroke="#333"/>`);
    gp.push(`<text x="${x0 - 12}" y="${(yy + 6).toFixed(1)}" fill="#999" font-size="17" text-anchor="end">${255 - g * 51}</text>`);
  }
  for (const t of [-24, -12, 0, 12, 24]) {
    const xx = x0 + ((t + PROFILE_HALF_PX) / (2 * PROFILE_HALF_PX)) * pw;
    gp.push(`<line x1="${xx.toFixed(1)}" y1="${y0}" x2="${xx.toFixed(1)}" y2="${y0 + ph}" stroke="${t === 0 ? '#666' : '#2a2a2a'}"/>`);
    gp.push(`<text x="${xx.toFixed(1)}" y="${y0 + ph + 26}" fill="#999" font-size="17" text-anchor="middle">${t}px</text>`);
  }
  series.forEach((s, si) => {
    const mean = new Array<number>(nT).fill(0);
    let cnt = 0;
    for (const p of s.e.profiles) {
      if (!p.values || p.values.length !== nT) continue;
      for (let k = 0; k < nT; k++) mean[k] += p.values[k];
      cnt++;
    }
    if (cnt === 0) return;
    const pts = mean
      .map((v, k) => {
        const xx = x0 + (k / (nT - 1)) * pw;
        const yy = y0 + ph - ((v / cnt) / 255) * ph;
        return `${xx.toFixed(1)},${yy.toFixed(1)}`;
      })
      .join(' ');
    gp.push(`<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2.6"/>`);
    gp.push(
      `<text x="${x0 + pw + 16}" y="${(y0 + 26 + si * 28).toFixed(0)}" fill="${s.color}" font-size="19">${esc(s.name)} b${s.e.medianBump.toFixed(0)} s${s.e.medianAbsStep.toFixed(0)} ${s.e.verdict}</text>`,
    );
  });
  gp.push(`<text x="${x0}" y="34" fill="#fff" font-size="23" font-weight="bold">${P.preset} 변별 평균 밝기 프로파일 (가로=변 법선거리, 세로=밝기)</text>`);
  gp.push(`<text x="${x0}" y="${CH_H - 18}" fill="#aaa" font-size="17">빨강=근변 · 초록=원변 · 하늘=분리선 │ 봉우리형=도색 띠 · 계단형=재질 경계</text>`);
  await sharp(Buffer.from(`<svg width="${CH_W}" height="${CH_H}" xmlns="http://www.w3.org/2000/svg">${gp.join('')}</svg>`))
    .png()
    .toFile(join(OUT_DIR, `profile_${P.preset}.png`));

  console.log(
    `${P.preset} 평균밝기 ${meanGrey.toFixed(1)} · 직선 ${lines.length} · 근변선 ${nearLine ? nearLine.verdict : '—'} bump ${nearLine ? nearLine.medianBump.toFixed(2) : '—'} · 원변선 ${farLine ? farLine.verdict : '—'} bump ${farLine ? farLine.medianBump.toFixed(2) : '—'}`,
  );
}

// values 는 용량이 크므로 JSON 에서 제외
const slim = JSON.parse(
  JSON.stringify(out, (k, v) => (k === 'values' ? undefined : v)),
);
writeFileSync(join(OUT_DIR, 'nearedge.json'), JSON.stringify(slim, null, 1));

// ── 콘솔 표
console.log('\n=== A) 정답 직선별 판정 + detectPaintLines 대응 ===');
console.log('preset | line(kind) | 판정 | bump중앙 | |step|중앙 | 표본 | paint비 | 검출 rank/votes/contrast/dist');
for (const p of out) {
  for (const le of p.lineEdges) {
    const d = le.detected;
    console.log(
      `${p.preset} | ${le.truthId}(${le.kind}) | ${le.verdict} | ${le.medianBump.toFixed(2)} | ${le.medianAbsStep.toFixed(2)} | ${le.samples} | ${le.paintFrac.toFixed(3)} | ${d ? `#${d.rank}/v${d.votes}/c${d.contrast.toFixed(1)}/${d.maxDistPx.toFixed(1)}px` : '대응없음'}`,
    );
  }
}
console.log('\n=== C) 면별 4변 분해 (ⓕ near/far 비대칭 대조) ===');
console.log('preset | bay | occ | near | far | sideL | sideR | nearBump | farBump');
for (const p of out) {
  for (const b of p.bayEdges) {
    const f = (e: EdgeReport) => (Number.isFinite(e.medianBump) ? e.medianBump.toFixed(2) : '—');
    console.log(
      `${p.preset} | ${b.bay} | ${b.occupied ? 'Y' : 'N'} | ${b.near.verdict} | ${b.far.verdict} | ${b.sideL.verdict} | ${b.sideR.verdict} | ${f(b.near)} | ${f(b.far)}`,
    );
  }
}
console.log(`\n오버레이/그래프 → ${OUT_DIR}/nearedge_EV*.png · profile_EV*.png · nearedge.json`);

// ────────────────────────────────────────────────────────────────────────────
// D) ⓕ 프레임(`2b82336acb05`) 위에서 같은 잣대로 근변을 재본다.
//
// 좌표는 전부 `_workspace/02z_developer_emptybay_probe_round22.md` 가 이미 적어 둔 실측값이다(추정 아님):
//   §2 표 — 검출 직선 rank #1 (1866,750)-(1176,840) = 긴 도색 경계선
//            rank #4/#8/#10/#12/#14 = 그 행의 분리선(정련된 도색 구간 양 끝)
//   §6    — 채택방향 근변 (1740,767)~(1359,817)  ← 위 rank#1 직선과 같은 자리
// 「분리선 도색이 끝나는 지점(카메라 쪽 끝)들을 이은 선」이 칸의 근변이 있어야 할 자리다.
// f·지면모델·PTZ 가 필요 없다 — 도색 구간의 끝은 이미지에서 직접 읽힌 값이다.
// ────────────────────────────────────────────────────────────────────────────
const F_FRAME = 'reports/overlay_r22f/frame_2b82336acb05.jpg';
const F_SEGMENTS: Array<{ label: string; a: Pt; b: Pt; note: string }> = [
  { label: 'far(det#1 긴 도색선)', a: { x: 1866, y: 750 }, b: { x: 1176, y: 840 }, note: 'ⓕ §2 rank#1 votes 666 contrast 133.9 — 양성대조' },
  { label: 'nearAdopted(채택방향 근변)', a: { x: 1740, y: 767 }, b: { x: 1359, y: 817 }, note: 'ⓕ §6 — rank#1 직선 위. paint.near 1.00000 이었다' },
  { label: 'sep det#8', a: { x: 1836, y: 973 }, b: { x: 1561, y: 790 }, note: 'ⓕ §2' },
  { label: 'sep det#4', a: { x: 1376, y: 1024 }, b: { x: 1194, y: 851 }, note: 'ⓕ §2' },
  { label: 'sep det#10', a: { x: 1546, y: 939 }, b: { x: 1371, y: 815 }, note: 'ⓕ §2' },
  { label: '★nearCandidate(분리선 도색 끝을 이은 선)', a: { x: 1376, y: 1024 }, b: { x: 1836, y: 973 }, note: '칸이 실제 있는 방향의 근변 자리 — 단 중간이 주차차량·화단에 가림' },
  // 위 선은 x≈1509~1759 구간이 검은 승용차, 좌측 끝이 화단 연석에 걸린다. 가림 없는 구간만 따로 잰다.
  { label: '★nearCandidate-L(빈칸 구간·가림없음)', a: { x: 1381, y: 1023 }, b: { x: 1500, y: 963 }, note: '가장 왼쪽 빈 칸의 근변 자리만' },
  { label: '대조:칸 내부 빈 아스팔트', a: { x: 1250, y: 900 }, b: { x: 1450, y: 875 }, note: '음성대조 — 아무것도 없어야 한다' },
];

try {
  const fm = await sharp(F_FRAME).metadata();
  const FW = fm.width ?? 0;
  const FH = fm.height ?? 0;
  const fgb = await sharp(F_FRAME).greyscale().raw().toBuffer();
  const fFrame: FrameGray = { data: new Uint8Array(fgb.buffer, fgb.byteOffset, fgb.byteLength), width: FW, height: FH };
  let fsum = 0;
  for (let i = 0; i < fFrame.data.length; i++) fsum += fFrame.data[i];
  const fMean = fsum / fFrame.data.length;

  console.log(`\n=== D) ⓕ 프레임 2b82336acb05 (평균밝기 ${fMean.toFixed(2)}) — 같은 잣대로 근변 재측정 ===`);
  console.log('구간 | 판정 | bump중앙 | |step|중앙 | 표본 | paint비');
  const fParts: string[] = [];
  const fReports: EdgeReport[] = [];
  for (const s of F_SEGMENTS) {
    const r = profileEdge(fFrame, s.label, s.a, s.b, s.note);
    fReports.push(r);
    console.log(
      `${s.label} | ${r.verdict} | ${r.medianBump.toFixed(2)} | ${r.medianAbsStep.toFixed(2)} | ${r.samples} | ${r.paintFrac.toFixed(3)}`,
    );
    const col = EDGE_COLOR[r.verdict];
    fParts.push(
      `<line x1="${s.a.x}" y1="${s.a.y}" x2="${s.b.x}" y2="${s.b.y}" stroke="${col}" stroke-width="${s.label.startsWith('★') ? 7 : 4}"${r.verdict === 'paint' ? '' : ' stroke-dasharray="12 8"'}/>`,
    );
    for (const p of r.profiles) {
      const c = p.cls === 'paint' ? '#00e5ff' : p.cls === 'material' ? '#ff9500' : '#bdbdbd';
      fParts.push(`<circle cx="${p.at.x.toFixed(1)}" cy="${p.at.y.toFixed(1)}" r="3" fill="${c}" stroke="#000" stroke-width="0.7"/>`);
    }
    fParts.push(
      `<text x="${((s.a.x + s.b.x) / 2).toFixed(0)}" y="${((s.a.y + s.b.y) / 2 - 12).toFixed(0)}" fill="${col}" font-size="21" font-weight="bold" text-anchor="middle" stroke="#000" stroke-width="0.8">${esc(s.label)} ${r.verdict} b${r.medianBump.toFixed(0)}</text>`,
    );
  }
  const fHdr = [
    `ⓕ 프레임 2b82336acb05 (2026-07-30 18:37:57 KST 촬영 · 평균밝기 ${fMean.toFixed(1)}) — 근변 재측정`,
    `같은 잣대(프로파일 반폭 ${PROFILE_HALF_PX}px · bump>=${BUMP_MIN} → 도색 · |step|>=${STEP_MIN} → 재질)`,
    `시안=도색 띠 · 주황=재질 계단 · 회색=불명 · 굵은선=★근변 후보(분리선 도색 끝)`,
  ];
  fParts.push(`<rect x="14" y="14" width="1380" height="${28 + fHdr.length * 34}" fill="#000000cc" rx="10"/>`);
  fHdr.forEach((t, i) =>
    fParts.push(`<text x="30" y="${54 + i * 34}" fill="${i === 0 ? '#fff' : '#e0e0e0'}" font-size="${i === 0 ? 25 : 20}">${esc(t)}</text>`),
  );
  await sharp(F_FRAME)
    .composite([{ input: Buffer.from(`<svg width="${FW}" height="${FH}" xmlns="http://www.w3.org/2000/svg">${fParts.join('')}</svg>`), top: 0, left: 0 }])
    .png()
    .toFile(join(OUT_DIR, 'nearedge_fframe_2b82336acb05.png'));
  writeFileSync(
    join(OUT_DIR, 'nearedge_fframe.json'),
    JSON.stringify(JSON.parse(JSON.stringify({ frame: F_FRAME, meanGrey: fMean, edges: fReports }, (k, v) => (k === 'values' ? undefined : v))), null, 1),
  );
  console.log(`→ ${OUT_DIR}/nearedge_fframe_2b82336acb05.png`);
} catch (e) {
  console.log(`\n=== D) 건너뜀 — ⓕ 프레임 없음(${F_FRAME}) ===`, (e as Error).message);
}
