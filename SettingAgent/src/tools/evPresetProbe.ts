// ★ 22회차 — 실카 프리셋 정답 라벨링 **스캔라인 탐침**(채점 전용 R1, 검출 경로 무접촉).
//
// 눈대중 대신 밝기 프로파일로 도색선/재질경계의 픽셀 위치를 읽는다.
// 라벨러가 좌표를 확정하기 위한 눈금 도구일 뿐, 어떤 알고리즘도 이 출력을 읽지 않는다.
//
// 사용:
//   npx tsx src/tools/evPresetProbe.ts row EV1 300,400,500 [x0] [x1] [thr]
//   npx tsx src/tools/evPresetProbe.ts col EV1 800,900     [y0] [y1] [thr]

import { join } from 'node:path';
import sharp from 'sharp';

const SRC_DIR = 'd:/Work/Parking3D/AgentVLA/ParkAgent/etc/camera_preset';

const mode = process.argv[2] as 'row' | 'col' | 'edge' | 'stripe' | 'vstripe';
const name = process.argv[3];
const at = (process.argv[4] ?? '').split(',').map(Number).filter((v) => Number.isFinite(v));
const a0 = Number(process.argv[5] ?? 0);
const a1 = Number(process.argv[6] ?? (mode === 'row' ? 1919 : 1079));
const thr = Number(process.argv[7] ?? 0);

const src = join(SRC_DIR, `${name}.png`);
const { data, info } = await sharp(src).greyscale().raw().toBuffer({ resolveWithObject: true });
const W = info.width;
const H = info.height;
const g = (x: number, y: number) => data[y * W + x];

// grass 모드: 초록(잔디) 띠의 위/아래 경계를 컬러로 분리해 읽는다.
//   잔디↔포장 경계는 회색조 계단이 약해 눈대중이 흔들린다. 색으로 보면 흔들리지 않는다.
if (mode === ('grass' as string)) {
  const { data: rgb } = await sharp(src).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const green = (x: number, y: number) => {
    const i = (y * W + x) * 3;
    return rgb[i + 1] - (rgb[i] + rgb[i + 2]) / 2;
  };
  const thr = Number(process.argv[7] ?? 6);
  for (const x of at) {
    const ys: number[] = [];
    for (let y = a0; y <= a1; y++) {
      let s = 0;
      for (let k = -2; k <= 2; k++) s += green(x, Math.min(H - 1, Math.max(0, y + k)));
      if (s / 5 >= thr) ys.push(y);
    }
    if (!ys.length) {
      console.log(`x=${x} 잔디 없음`);
      continue;
    }
    // 연속 구간 중 가장 긴 것
    let bs = ys[0];
    let be = ys[0];
    let cs = ys[0];
    for (let i = 1; i < ys.length; i++) {
      if (ys[i] - ys[i - 1] > 4) {
        if (ys[i - 1] - cs > be - bs) {
          bs = cs;
          be = ys[i - 1];
        }
        cs = ys[i];
      }
    }
    if (ys[ys.length - 1] - cs > be - bs) {
      bs = cs;
      be = ys[ys.length - 1];
    }
    console.log(`x=${x} 잔디띠 y=${bs}~${be} (위${bs} 아래${be})`);
  }
  process.exit(0);
}

/** 국소 대비 기준 자동 문턱: 구간 중앙값 + (최대-중앙값)*0.45 */
function autoThr(vals: number[]): number {
  const s = [...vals].sort((p, q) => p - q);
  const med = s[Math.floor(s.length / 2)];
  const hi = s[Math.floor(s.length * 0.98)];
  return med + (hi - med) * 0.45;
}

// stripe 모드: 지정 행(또는 열)에서 **폭 w 의 밝은 띠**(도색선)만 골라낸다.
//   응답 = 중심 평균 − 양옆 배경 평균. 보도블록처럼 넓게 밝은 면은 응답이 0 에 가깝다.
if (mode === 'stripe' || mode === 'vstripe') {
  const half = Number(process.argv[7] ?? 8); // 띠 반폭
  const gap = half + 4;
  const back = 7;
  const minResp = Number(process.argv[8] ?? 12);
  for (const a of at) {
    const val = (b: number) => (mode === 'stripe' ? g(b, a) : g(a, b));
    const resp: number[] = [];
    for (let b = a0; b <= a1; b++) {
      if (b - gap - back < 0 || b + gap + back > (mode === 'stripe' ? W : H) - 1) {
        resp.push(-999);
        continue;
      }
      let c = 0;
      for (let k = -half; k <= half; k++) c += val(b + k);
      c /= 2 * half + 1;
      let l = 0;
      let r = 0;
      for (let k = 0; k < back; k++) {
        l += val(b - gap - k);
        r += val(b + gap + k);
      }
      resp.push(c - (l + r) / (2 * back));
    }
    const peaks: Array<[number, number]> = [];
    for (let i = 1; i < resp.length - 1; i++) {
      if (resp[i] >= minResp && resp[i] >= resp[i - 1] && resp[i] > resp[i + 1]) {
        if (peaks.length && a0 + i - peaks[peaks.length - 1][0] < half) {
          if (resp[i] > peaks[peaks.length - 1][1]) peaks[peaks.length - 1] = [a0 + i, resp[i]];
        } else peaks.push([a0 + i, resp[i]]);
      }
    }
    console.log(`${mode === 'stripe' ? 'y' : 'x'}=${a} peaks: ${peaks.map(([p, v]) => `${p}(${v.toFixed(0)})`).join(' ')}`);
  }
  process.exit(0);
}

// edge 모드: 지정 컬럼에서 y구간 [a0,a1] 안의 **가장 강한 밝기 계단**(재질 경계) 위치를 찾는다.
// 도색선(밝은 띠)이 아니라 콘크리트↔아스팔트 같은 soft edge 를 좌표로 뽑기 위한 것.
if (mode === 'edge') {
  const half = 6;
  for (const x of at) {
    let bestY = -1;
    let bestD = 0;
    const prof: Array<[number, number]> = [];
    for (let y = a0 + half; y <= a1 - half; y++) {
      let up = 0;
      let dn = 0;
      for (let k = 1; k <= half; k++) {
        up += g(x, y - k);
        dn += g(x, y + k);
      }
      const d = (up - dn) / half; // 위가 밝고 아래가 어두운 계단 = 양수
      prof.push([y, d]);
      if (d > bestD) {
        bestD = d;
        bestY = y;
      }
    }
    const top = prof.sort((p, q) => q[1] - p[1]).slice(0, 4).map(([y, d]) => `${y}(${d.toFixed(0)})`);
    console.log(`x=${x} strongest-down-step y=${bestY} d=${bestD.toFixed(1)} | top: ${top.join(' ')}`);
  }
  process.exit(0);
}

for (const a of at) {
  const vals: number[] = [];
  for (let b = a0; b <= a1; b++) vals.push(mode === 'row' ? g(b, a) : g(a, b));
  const t = thr > 0 ? thr : autoThr(vals);
  const runs: Array<[number, number, number]> = [];
  let st = -1;
  let peak = 0;
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] >= t) {
      if (st < 0) {
        st = i;
        peak = vals[i];
      } else peak = Math.max(peak, vals[i]);
    } else if (st >= 0) {
      if (i - st >= 2) runs.push([a0 + st, a0 + i - 1, peak]);
      st = -1;
    }
  }
  if (st >= 0) runs.push([a0 + st, a1, peak]);
  const label = mode === 'row' ? `y=${a}` : `x=${a}`;
  console.log(
    `${label} thr=${t.toFixed(0)} runs=${runs.length}: ` +
      runs.map(([s, e, p]) => `[${s}~${e} c=${((s + e) / 2).toFixed(0)} w=${e - s + 1} pk=${p}]`).join(' '),
  );
}
