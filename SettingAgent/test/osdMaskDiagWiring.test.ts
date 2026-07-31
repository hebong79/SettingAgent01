// ★ 26회차 26-2 — OSD 자막 마스킹 대조 도구의 **봉인 + 성질 검증**.
//
// 이 테스트가 지키는 것
//   ① 오라클 봉인 — 자막 영역을 정답지에서 가져오지 않는다(정답 파일·씬 정답 토큰 부재).
//   ② 카메라 물리 이동 0 · 정본/DB 쓰기 0 — 디스크 파일만 읽고 `reports/` 에만 쓴다.
//   ③ 라이브러리는 부작용이 없다(파일 I/O 미import) — 그래서 이 테스트가 직접 부를 수 있다.
//   ④ Coons 채움이 **박스 밖을 비트 불변**으로 남기고, **경계에 계단을 만들지 않는다**.
//   ⑤ `findOsdBox` 가 합성 이미지에서 글줄을 찾고, 글줄이 없으면 `null` 을 낸다(위양성 없음).
//   ⑥ `quadOverlapsBox` / `lineCrossesBox` / `edgeDistPx` 의 기하 판정.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_PAINT_OPTIONS, paintMask, type FrameGray } from '../src/ground/floorPaint.js';
import type { BayQuad } from '../src/ground/bayGeometry.js';
import { coonsFill, edgeDistPx, findOsdBox, lineCrossesBox, mirrorBox, quadOverlapsBox, type Box } from '../src/tools/osdMaskLib.js';

/**
 * 봉인 검사 대상은 **주석을 제거한 코드**다(`imageObservation.test.ts` 와 같은 규약).
 * 주석에는 「정답 파일은 읽지 않는다」처럼 **금지를 명시하는 문장**이 있어야 하고,
 * 그 문장 때문에 봉인이 깨지면 검사가 문서화를 벌하는 꼴이 된다.
 */
const codeOf = (path: string): string =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/) // CRLF 체크아웃 대응
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
const TOOL = codeOf('src/tools/osdMaskDiag.ts');
const LIB = codeOf('src/tools/osdMaskLib.ts');

describe('26-2 봉인 — 오라클·카메라·정본', () => {
  it('① 자막 영역을 정답지에서 가져오지 않는다', () => {
    for (const src of [TOOL, LIB]) {
      for (const re of [/truth\.json/, /truthQuad/, /sceneTruth/, /faceSlot/, /\bvisible\b/, /rotY/]) {
        expect(re.test(src), `오라클 토큰 ${re} 가 있다`).toBe(false);
      }
    }
  });

  it('② 카메라 물리 이동 경로를 쓰지 않는다', () => {
    for (const src of [TOOL, LIB]) {
      for (const t of ['CameraSourceClient', 'requestImage', 'req_move', 'roi.auto.apply']) {
        expect(src.includes(t), `카메라/적용 토큰 ${t} 가 있다`).toBe(false);
      }
    }
  });

  it('③ 쓰기는 reports/ 하위만 — 정본·DB 경로에 쓰지 않는다', () => {
    const writes = [...TOOL.matchAll(/writeFileSync\(([^,]+),/g)].map((m) => m[1].trim());
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(w).toBe('jsonPath');
    expect(TOOL.includes('mkdirSync(outDir')).toBe(true);
    expect(/outDir = process\.argv\[3\] \?\? 'reports\//.test(TOOL)).toBe(true);
    for (const t of ['setting.sqlite', 'slot_ptz.json', 'Setup_']) {
      expect(TOOL.includes(t), `정본/DB 토큰 ${t} 가 있다`).toBe(false);
    }
  });

  it('④ 라이브러리는 부작용이 없다 — 파일 I/O import 부재', () => {
    expect(LIB.includes('node:fs')).toBe(false);
    expect(LIB.includes('sharp')).toBe(false);
  });
});

describe('26-2 Coons 채움 — 경계를 만들지 않는다', () => {
  const W = 60;
  const H = 40;
  /** 부드러운 선형 배경(기울기 1). */
  function makeFrame(): Uint8Array {
    const g = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = 40 + x + y;
    return g;
  }

  it('박스 밖은 비트 불변이다', () => {
    const src = makeFrame();
    const box: Box = { x0: 20, y0: 10, x1: 35, y1: 25 };
    const dst = coonsFill(src, W, H, box);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const inside = x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;
        if (!inside) expect(dst[y * W + x]).toBe(src[y * W + x]);
      }
    }
  });

  it('자막을 지우고 경계에 계단을 만들지 않는다', () => {
    const src = makeFrame();
    const dirty = new Uint8Array(src);
    const box: Box = { x0: 20, y0: 10, x1: 35, y1: 25 };
    // 박스 안을 자막처럼 밝게 오염시킨다.
    for (let y = 12; y <= 22; y++) for (let x = 22; x <= 33; x++) dirty[y * W + x] = 230;
    const dst = coonsFill(dirty, W, H, box);
    // ① 오염 제거 — 박스 안이 다시 배경 선형장으로 복원된다(반올림 오차 1 이내).
    for (let y = box.y0; y <= box.y1; y++) {
      for (let x = box.x0; x <= box.x1; x++) expect(Math.abs(dst[y * W + x] - src[y * W + x])).toBeLessThanOrEqual(1);
    }
    // ② 경계 스텝이 배경 기울기(=1) 수준 — 사각 테두리가 생기지 않는다.
    for (let x = box.x0; x <= box.x1; x++) {
      expect(Math.abs(dst[box.y0 * W + x] - dst[(box.y0 - 1) * W + x])).toBeLessThanOrEqual(2);
      expect(Math.abs(dst[box.y1 * W + x] - dst[(box.y1 + 1) * W + x])).toBeLessThanOrEqual(2);
    }
    for (let y = box.y0; y <= box.y1; y++) {
      expect(Math.abs(dst[y * W + box.x0] - dst[y * W + box.x0 - 1])).toBeLessThanOrEqual(2);
      expect(Math.abs(dst[y * W + box.x1] - dst[y * W + box.x1 + 1])).toBeLessThanOrEqual(2);
    }
  });

  it('mirrorBox 는 크기를 보존하고 좌우로 뒤집는다', () => {
    const b: Box = { x0: 1084, y0: 897, x1: 1369, y1: 953 };
    const m = mirrorBox(b, 1920);
    expect(m.x1 - m.x0).toBe(b.x1 - b.x0);
    expect(m.y0).toBe(b.y0);
    expect(m.y1).toBe(b.y1);
    expect(m.x0).toBe(1920 - 1 - b.x1);
  });
});

describe('26-2 findOsdBox — 이미지에서 찾는다(오라클 아님)', () => {
  const W = 400;
  const H = 200;
  /** 어두운 배경 위에 밝고 균일한 「글자」 n 개를 한 줄로 그린다(획 폭 5px · 높이 26px). */
  function frameWithGlyphs(n: number, gray = 220): FrameGray {
    const g = new Uint8Array(W * H).fill(60);
    for (let k = 0; k < n; k++) {
      const x0 = 40 + k * 30;
      for (let y = 90; y < 116; y++) for (let x = x0; x < x0 + 5; x++) g[y * W + x] = gray;
      for (let y = 90; y < 116; y++) for (let x = x0 + 14; x < x0 + 19; x++) g[y * W + x] = gray;
      for (let y = 90; y < 95; y++) for (let x = x0; x < x0 + 19; x++) g[y * W + x] = gray;
      for (let y = 111; y < 116; y++) for (let x = x0; x < x0 + 19; x++) g[y * W + x] = gray;
    }
    return { data: g, width: W, height: H };
  }

  it('⑤a 5자 글줄을 찾는다 — 박스가 글자 범위를 덮는다', () => {
    const f = frameWithGlyphs(5);
    const { mask } = paintMask(f, DEFAULT_PAINT_OPTIONS);
    const r = findOsdBox(f, mask);
    expect(r.box).not.toBeNull();
    const b = r.box as Box;
    // 글자는 x 40~178, y 90~115 에 있다. 박스가 이를 포함해야 한다.
    expect(b.x0).toBeLessThanOrEqual(40);
    expect(b.x1).toBeGreaterThanOrEqual(178);
    expect(b.y0).toBeLessThanOrEqual(90);
    expect(b.y1).toBeGreaterThanOrEqual(115);
  });

  it('⑤b 글자가 3자 이하면 null — 위양성 없음', () => {
    const f = frameWithGlyphs(2);
    const { mask } = paintMask(f, DEFAULT_PAINT_OPTIONS);
    expect(findOsdBox(f, mask).box).toBeNull();
  });

  it('⑤c 긴 도색선은 글자로 오인하지 않는다 — 폭 조건에서 탈락', () => {
    const g = new Uint8Array(W * H).fill(60);
    // 폭 6px · 길이 300px 밝은 수평선 4개 — 개수는 글줄 조건을 만족해도 글자가 아니다.
    for (let k = 0; k < 4; k++) for (let y = 40 + k * 30; y < 46 + k * 30; y++) for (let x = 50; x < 350; x++) g[y * W + x] = 220;
    const f: FrameGray = { data: g, width: W, height: H };
    const { mask } = paintMask(f, DEFAULT_PAINT_OPTIONS);
    expect(findOsdBox(f, mask).box).toBeNull();
  });
});

describe('26-2 기하 판정', () => {
  const box: Box = { x0: 100, y0: 100, x1: 200, y1: 150 };
  const quadOf = (pts: Array<[number, number]>): BayQuad => ({ latticeIndex: 0, quad: pts.map(([x, y]) => ({ x, y })) as BayQuad['quad'] });

  it('⑥a quadOverlapsBox — 겹칠 때 true, 떨어지면 false', () => {
    expect(quadOverlapsBox(quadOf([[150, 120], [160, 120], [160, 130], [150, 130]]), box)).toBe(true); // 박스 안
    expect(quadOverlapsBox(quadOf([[0, 0], [400, 0], [400, 400], [0, 400]]), box)).toBe(true); // 박스를 감쌈
    expect(quadOverlapsBox(quadOf([[50, 120], [400, 120], [400, 130], [50, 130]]), box)).toBe(true); // 가로지름
    expect(quadOverlapsBox(quadOf([[300, 300], [340, 300], [340, 340], [300, 340]]), box)).toBe(false); // 떨어짐
  });

  it('⑥b lineCrossesBox — 박스를 지나는 직선만 true', () => {
    expect(lineCrossesBox([0, 1, -125], box)).toBe(true); // y=125 수평선
    expect(lineCrossesBox([0, 1, -500], box)).toBe(false); // y=500
    expect(lineCrossesBox([1, 0, -150], box)).toBe(true); // x=150 수직선
  });

  it('⑥c edgeDistPx — 박스 변을 타는 직선은 거리 0', () => {
    expect(edgeDistPx([0, 1, -100], box)).toBeCloseTo(0, 12); // y=100 = 윗변
    // 중앙 수평선 y=125 는 위/아래 변에서 25px 이지만 **좌/우 변**을 21점 샘플링한 평균이 더 작다
    // (mean|2.5k−25|, k=0..20 = 275/21 = 13.0952…). `edgeDistPx` 는 4변 중 최솟값이므로 그 값이 답이다.
    expect(edgeDistPx([0, 1, -125], box)).toBeCloseTo(275 / 21, 12);
  });
});
