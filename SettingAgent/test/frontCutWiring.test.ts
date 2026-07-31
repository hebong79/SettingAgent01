// ★ 26회차 26-3 — **후보 진입 컷 실측 봉인**.
//
// 25회차 §9-2 는 「전경 역전의 진짜 표적은 `frontCandidates=8`」이라고 넘겼다. 26회차가 실측한 결과
// **그 귀착은 틀렸다**: 시뮬 1:1 골든에서 전경 열(씬 정답 r4)의 근변선은 검출 직선 60개 중
// **어느 것과도 대응하지 않는다**(각도 3° · 최대 수직거리 10px 잣대). 순위가 낮은 것이 아니라
// **애초에 검출되지 않았다** — 그 근변은 (a) 양 끝이 프레임 밖이고 (b) 차량이 도색을 덮어
// 근변 도색 지지가 0.1111 뿐이다. 따라서 `frontCandidates` 를 올려도 전경은 회수되지 않는다.
//
// 이 테스트가 지키는 것
//   ① `frontCandidates` 기본값 8 유지 — 26-3 은 이 값을 **바꾸지 않았다**(전경 회수 0 → 0).
//   ② 계측 도구 정적 봉인 — 카메라 물리 이동·정본 쓰기 경로 부재.
//   ③ 전경 열 근변선의 양 끝이 **프레임 밖**이다(순수 산술).
//   ④ ★ 그 근변선에 대응하는 검출 직선이 **없다** — 진입 컷을 풀어도 들어올 것이 없다.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { DEFAULT_PAINT_OPTIONS, detectPaintLines, type FrameGray } from '../src/ground/floorPaint.js';

/**
 * 시뮬 골든 1:1(`6006a034bfe2`) 의 씬 정답 r4(전경 열 3면) 근변선 양 끝.
 * `src/tools/frontCut.ts` 가 씬 진값을 투영해 뽑은 값이며 `reports/overlay_r26c/frontCut_r26c_before.json` 에 원본이 있다.
 */
const FRONT_ROW_NEAR_A = { x: 951.6557054289445, y: 1098.4451698061678 };
const FRONT_ROW_NEAR_B = { x: 2163.6967827897743, y: 950.4571860961684 };
const IMG_W = 1920;
const IMG_H = 1080;

describe('26회차 26-3 후보 진입 컷', () => {
  it('① frontCandidates 기본값은 8 이다 — 26-3 은 상향하지 않았다', () => {
    // 상향을 재시도하려면 먼저 ④ 를 뒤집어야 한다. 전경 열은 검출 직선 자체가 없어서 못 잡는 것이지
    // 상위 8 밖에 밀려 있어서 못 잡는 것이 아니다.
    expect(DEFAULT_PAINT_OPTIONS.frontCandidates).toBe(8);
  });

  it('② 계측 도구가 카메라를 움직이지 않고 정본에 쓰지 않는다', () => {
    const src = readFileSync('src/tools/frontCut.ts', 'utf8');
    for (const t of ['CameraSourceClient', 'requestImage', 'roi.auto.apply', 'setting.sqlite']) {
      expect(src.includes(t), `frontCut.ts 에 ${t} 가 있다`).toBe(false);
    }
  });

  it('③ 전경 열 근변선의 양 끝이 프레임 밖이다', () => {
    expect(FRONT_ROW_NEAR_A.y).toBeGreaterThan(IMG_H);
    expect(FRONT_ROW_NEAR_B.x).toBeGreaterThan(IMG_W);
  });

  it('④ ★ 그 근변선에 대응하는 검출 직선이 60개 중 하나도 없다', async () => {
    const jpg = readFileSync('test/fixtures/roiAutoGolden/frame_1_1_d0.jpg');
    const meta = await sharp(jpg).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    expect([W, H]).toEqual([IMG_W, IMG_H]);
    const gb = await sharp(jpg).greyscale().raw().toBuffer();
    const frame: FrameGray = { data: new Uint8Array(gb.buffer, gb.byteOffset, gb.byteLength), width: W, height: H };
    const { lines } = detectPaintLines(frame, DEFAULT_PAINT_OPTIONS);
    expect(lines.length).toBe(60);

    // `evPresetDetect.matchDetected` 와 같은 잣대: 각도 ≤ 3° · 세 표본점의 최대 수직거리 ≤ 10px.
    const dx = FRONT_ROW_NEAR_B.x - FRONT_ROW_NEAR_A.x;
    const dy = FRONT_ROW_NEAR_B.y - FRONT_ROW_NEAR_A.y;
    const n = Math.hypot(dx, dy);
    const tl = [-dy / n, dx / n];
    const probes = [FRONT_ROW_NEAR_A, { x: (FRONT_ROW_NEAR_A.x + FRONT_ROW_NEAR_B.x) / 2, y: (FRONT_ROW_NEAR_A.y + FRONT_ROW_NEAR_B.y) / 2 }, FRONT_ROW_NEAR_B];
    const matches = lines.filter((l) => {
      const angleDeg = (Math.acos(Math.min(1, Math.abs(tl[0] * l.line[0] + tl[1] * l.line[1]))) * 180) / Math.PI;
      if (angleDeg > 3) return false;
      return probes.every((p) => Math.abs(l.line[0] * p.x + l.line[1] * p.y + l.line[2]) <= 10);
    });
    expect(matches.length).toBe(0);
  }, 120_000);
});
