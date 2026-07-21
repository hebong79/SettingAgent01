// ★ QA — **경계면 교차 검증 + 강등 경로 전수 + 회귀 봉인**.
//
// 이 파일이 지키는 것은 육면체의 *수학*이 아니라(그건 cuboidBoxPremise.test.ts 가 봉인한다)
// **데이터가 모듈 경계를 넘을 때 조용히 틀어지지 않는가** 다:
//
//   VPD 실응답(masks: 픽셀 정수)  →  VpdClient.segment(정규화 0..1)  →  라우트(다시 픽셀)
//   →  SegVehicle(픽셀)  →  buildVehicleCuboids  →  floorQuad(정규화) → 뷰어
//
// ⚠️ **지면모델은 원본 픽셀에서만 성립한다.** 정규화 좌표가 파이프라인에 새어 들어가면
//    모든 수식이 그대로 돌아가고 **조용히 틀린 육면체**가 나온다 — 그 경로를 여기서 못 박는다.
//
// 강등 철학(설계 §8): throw 0건 · 조용한 0/빈배열 0건 · **모든 강등이 issues 문자열을 남긴다**.
//
// ⚠️ 픽스처 규약(cuboidBoxPremise.test.ts 의 교훈): 마스크는 **육면체 볼록껍질로 만들지 않는다**.
//    바닥면 4점 + **짧고 물러난 지붕 슬래브** 4점 — 검증 대상의 가정(차=직육면체)을 복사하지 않기 위해서다.

import { describe, expect, it } from 'vitest';
import {
  buildVehicleCuboids,
  fitContactLine,
  slotAxes,
  toAxisCoords,
  type SegVehicle,
} from '../src/ground/contact.js';
import { computeAnchorMetrics } from '../src/ground/anchor.js';
import {
  DEFAULT_ANCHOR_OPTIONS,
  DEFAULT_CONTACT_OPTIONS,
  PRIOR_H,
  type Px,
  type Vec3,
} from '../src/ground/contactTypes.js';
import { projectToPixel } from '../src/ground/project.js';
import { convexHull } from '../src/domain/polygon.js';
import { VpdClient } from '../src/clients/VpdClient.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { GroundModel } from '../src/ground/types.js';

const DEG = Math.PI / 180;

function makeGround(tiltDeg = 18.8): GroundModel {
  const t = tiltDeg * DEG;
  return {
    camIdx: 1, presetIdx: 1, imgW: 1920, imgH: 1080, zoom: 1, f: 1500,
    n: [0, Math.cos(t), Math.sin(t)], d: 5.0, tiltDeg, ptzTiltDeg: null, tiltErrDeg: null,
    slotBearingDeg: null, bearingDevDeg: null, dDevRel: null, depthEdgePx: 400,
    metricErr: 0, conf: 1, source: 'file', issues: [],
  };
}

function basis(g: GroundModel) {
  const t = g.tiltDeg * DEG;
  const O: Vec3 = [0, g.d * g.n[1], g.d * g.n[2]];
  const w: Vec3 = [0, -Math.sin(t), Math.cos(t)];
  const X = (a: number, b: number): Vec3 => [O[0] + a, O[1] + b * w[1], O[2] + b * w[2]];
  const up = (p: Vec3, h: number): Vec3 => [p[0] - h * g.n[0], p[1] - h * g.n[1], p[2] - h * g.n[2]];
  const P = (p: Vec3): Px => projectToPixel(p, g)!;
  return { X, up, P };
}

const CAR = { W: 1.85, L: 4.7, B_FRONT: 3.5, H: 1.445 };
const ROOF = { back: 1.9, front: 4.0, halfW: 0.72 };

/** 차다운 마스크(바닥 4점 + 짧고 물러난 지붕 슬래브) — 육면체-껍질 픽스처 금지 규약 준수. */
function carLikeMask(g: GroundModel, aC: number, h = CAR.H, bFront = CAR.B_FRONT): Px[] {
  const { X, up, P } = basis(g);
  const pts: Vec3[] = [];
  for (const [a, b] of [
    [aC - CAR.W / 2, bFront], [aC + CAR.W / 2, bFront],
    [aC + CAR.W / 2, bFront + CAR.L], [aC - CAR.W / 2, bFront + CAR.L],
  ] as const) pts.push(X(a, b));
  for (const [a, b] of [
    [aC - ROOF.halfW, bFront + ROOF.back], [aC + ROOF.halfW, bFront + ROOF.back],
    [aC + ROOF.halfW, bFront + ROOF.front], [aC - ROOF.halfW, bFront + ROOF.front],
  ] as const) pts.push(up(X(a, b), h));
  return convexHull(pts.map(P)) as Px[];
}

/** 슬롯 스트립 5칸(2.5 × 5.0m). PixelQuad 규약. */
function slotStrip(g: GroundModel, da = 0, db = 0): Px[][] {
  const { X, P } = basis(g);
  const out: Px[][] = [];
  for (let k = -2; k <= 2; k++) {
    const a0 = k * 2.5 - 1.25 + da;
    out.push([P(X(a0, 3 + db)), P(X(a0, 8 + db)), P(X(a0 + 2.5, 8 + db)), P(X(a0 + 2.5, 3 + db))]);
  }
  return out;
}

const veh = (g: GroundModel, aC: number, over: Partial<SegVehicle> = {}): SegVehicle => ({
  vpdIdx: 0, mask: carLikeMask(g, aC), cls: 'car', confidence: 0.9, ...over,
});

const build = (g: GroundModel, vehicles: SegVehicle[], slots: Px[][], opts = DEFAULT_CONTACT_OPTIONS, occ?: Px[][]) =>
  buildVehicleCuboids({
    vehicles, occluderMasks: occ, slotPolysPx: slots, ground: g,
    slotWidthM: 2.5, slotDepthM: 5.0, opts,
  });

/** 어느 issues 문자열에든 걸리는가(강등이 **사유를 남겼는가**). */
const anyIssue = (issues: string[], sub: string) => issues.some((s) => s.includes(sub));

// ═════════════════════════════════════════════════════════════════════════════
// 1. 데이터 shape 경계면 — 어디서 정규화이고 어디서 픽셀인가
// ═════════════════════════════════════════════════════════════════════════════

describe('경계면 ①: VPD 실응답(픽셀 정수) → VpdClient(정규화 0..1)', () => {
  const cfg = {
    endpoint: 'http://vpd.test', detPath: '/det', segPath: '/seg', timeoutMs: 1000, maxRetries: 0,
  } as unknown as ToolsConfig['vpd'];

  // 800×576 JPEG(SOF0). readJpegSize 가 여기서 imgW/imgH 를 얻는다 → **정규화의 분모**.
  const jpeg800x576 = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x40, 0x03, 0x20,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
  ]);

  const stubFetch = (status: number, body: unknown) => {
    globalThis.fetch = (async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })) as unknown as typeof fetch;
  };

  it('masks(픽셀 정수 [차량][점][x,y]) → mask(정규화 0..1). rect 는 det 와 **같은 규약**', async () => {
    stubFetch(200, {
      success: true, id: 1,
      bboxes: [[10, 120, 210, 320]],
      confidences: [0.9], classes: ['car'],
      masks: [[[10, 120], [210, 120], [210, 320], [10, 320]]], // 픽셀 정수.
    });
    const r = await new VpdClient(cfg).segment(jpeg800x576);
    expect(r.segDegraded).toBe(false);
    expect(r.maskMismatch).toBe(0);
    expect(r.boxes).toHaveLength(1);

    // ★ 정규화 지점은 **여기 한 곳뿐**이다(VpdClient.normalizeMask). 분모 = JPEG 실크기(800×576).
    const m = r.boxes[0].mask!;
    expect(m[0]).toEqual({ x: 10 / 800, y: 120 / 576 });
    expect(m[2]).toEqual({ x: 210 / 800, y: 320 / 576 });
    for (const p of m) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
    }
    // rect 는 det 와 동일 규약(정규화 x/y/w/h) — mask 가 rect 를 **대체하지 않는다**(점유 판정 회귀 0의 근거).
    expect(r.boxes[0].rect).toEqual({ x: 10 / 800, y: 120 / 576, w: 200 / 800, h: 200 / 576 });
  });

  it('★ 강등 A: HTTP 500(검출 0대) → 빈 결과 + segDegraded. **throw 하지 않는다**', async () => {
    stubFetch(500, {});
    const r = await new VpdClient(cfg).segment(jpeg800x576);
    expect(r.boxes).toEqual([]);
    expect(r.segDegraded).toBe(true); // ← 조용한 빈 배열이 아니라 **사유가 실린 빈 배열**.
    expect(r.maskMismatch).toBe(0);
  });

  it('★ 강등 B: masks.length !== bboxes.length → 짝 없는 bbox drop + maskMismatch 카운트', async () => {
    stubFetch(200, {
      success: true, id: 1,
      bboxes: [[10, 10, 50, 50], [60, 60, 100, 100], [110, 110, 150, 150]],
      confidences: [0.9, 0.8, 0.7], classes: ['car', 'car', 'car'],
      masks: [[[10, 10], [50, 10], [50, 50]]], // 1개뿐 — 나머지 2대는 마스크 없음.
    });
    const r = await new VpdClient(cfg).segment(jpeg800x576);
    expect(r.boxes).toHaveLength(1);
    expect(r.maskMismatch).toBe(2); // ← drop 이 **카운트로 드러난다**(조용히 사라지지 않는다).
    expect(r.segDegraded).toBe(false);
  });

  it('★ 강등 C: 퇴화 마스크(점 3개 미만/비유한) → 그 차량만 drop + 카운트', async () => {
    stubFetch(200, {
      success: true, id: 1,
      bboxes: [[10, 10, 50, 50], [60, 60, 100, 100]],
      confidences: [0.9, 0.8], classes: ['car', 'car'],
      masks: [[[10, 10], [50, 10]], [[60, 60], [100, 60], [100, 100], [60, 100]]], // 첫 번째가 2점(퇴화).
    });
    const r = await new VpdClient(cfg).segment(jpeg800x576);
    expect(r.boxes).toHaveLength(1);
    expect(r.maskMismatch).toBe(1);
    expect(r.boxes[0].confidence).toBe(0.8); // 살아남은 건 두 번째 차량.
  });

  it('detect() 는 mask 를 **절대 채우지 않는다** — det 경로 소비처(CaptureJob·DB) 회귀 0의 타입 근거', async () => {
    stubFetch(200, {
      success: true, id: 1, bboxes: [[10, 10, 50, 50]], confidences: [0.9], classes: ['car'],
      masks: [[[10, 10], [50, 10], [50, 50]]], // 서버가 실수로 masks 를 줘도.
    });
    const boxes = await new VpdClient(cfg).detect(jpeg800x576);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].mask).toBeUndefined(); // ← detect() 는 mask 를 무시한다.
  });
});

describe('경계면 ②: 라우트(정규화 → 원본 픽셀) → 지면모델', () => {
  // ★★ 이 프로젝트의 **가장 위험한 조용한 실패**: 지면모델(f, n, d)은 **원본 센서 픽셀**에서만 성립한다.
  //    정규화(0..1) 좌표를 그대로 넣으면 rayOf() 가 (x−960)/1500 ≈ −0.64 인 시선을 만들어
  //    **모든 수식이 예외 없이 돌아가고** 완전히 틀린 지면점을 낸다. 라우트가 imgW/imgH 를 곱하는 이유다.
  it('★ 정규화 좌표가 파이프라인에 새어 들어가면 — **조용히 틀리지 않고 강등된다**(마스크 퇴화)', () => {
    const g = makeGround();
    const pxMask = carLikeMask(g, 0);
    const leaked: Px[] = pxMask.map((p) => ({ x: p.x / g.imgW, y: p.y / g.imgH })); // ← 라우트가 곱하기를 빠뜨린 경우.

    const r = build(g, [{ vpdIdx: 0, mask: leaked, cls: 'car', confidence: 0.9 }], slotStrip(g));

    expect(r.cuboids).toHaveLength(0); // 육면체를 만들지 않는다.
    expect(r.rejected).toHaveLength(1);
    expect(anyIssue(r.rejected[0].issues, '마스크 퇴화')).toBe(true); // ← 사유가 남는다(minMaskAreaPx 400px² 가 잡는다).
  });

  it('정상(픽셀) 입력 → 육면체 산출. floorQuad 는 **정규화 스케일**(뷰어 계약), *Ground 는 **미터**', () => {
    const g = makeGround();
    const r = build(g, [-2.5, 0, 2.5].map((a) => veh(g, a)), slotStrip(g));
    expect(r.cuboids).toHaveLength(3);

    for (const c of r.cuboids) {
      expect(c.floorQuad).toHaveLength(4);
      // ★ 봉인하는 것은 **스케일 규약**이다: floorQuad 가 정규화면 |x| ~ O(1), 픽셀이면 O(1000).
      //   누가 라우트에서 `/g.imgW` 를 빼먹으면 여기서 즉시 깨진다.
      for (const p of c.floorQuad) {
        expect(Math.abs(p.x)).toBeLessThan(2);
        expect(Math.abs(p.y)).toBeLessThan(2);
      }
      // *Ground: 카메라좌표 **미터**(정규화 아님) — 정규화면 O(1) 이 아니라 O(0.01) 이 나온다.
      const dist = Math.hypot(...c.frontGround);
      expect(dist).toBeGreaterThan(1);
      expect(dist).toBeLessThan(100);
      expect(Math.hypot(...c.centerGround)).toBeGreaterThan(1);
      expect(c.floorGround).toHaveLength(4);
      expect(c.heightM).toBeCloseTo(PRIOR_H, 6);
      expect(c.lengthM).toBeCloseTo(DEFAULT_CONTACT_OPTIONS.priorL, 6);
      expect(c.widthM).toBeGreaterThan(1.0);
      expect(c.widthM).toBeLessThan(2.5);
    }

    // ⚠️ **floorQuad 는 [0,1] 을 벗어날 수 있다** — 화면 경계에 잘린 차량의 코너다(실측 x=−0.029 / 1.029).
    //    파이프라인은 어디에서도 이미지 경계로 클리핑하지 않는다(그게 옳다 — 실 VPD 마스크는 애초에 화면 안이다).
    //    **소비처가 [0,1] 을 가정하면 안 된다.** 뷰어는 캔버스 밖으로 그려 무해하다.
    const xs = r.cuboids.flatMap((c) => c.floorQuad.map((p) => p.x));
    expect(Math.min(...xs)).toBeLessThan(0); // 실제로 벗어난다는 사실 자체를 봉인(가정 금지).
  });

  it('★ 1-based/0-based: boxIdx 는 **0-based**(cam/preset/slot 의 1-based 와 섞이지 않는다)', () => {
    const g = makeGround();
    const r = build(g, [-2.5, 0, 2.5].map((a) => veh(g, a)), slotStrip(g));
    expect(r.cuboids.map((c) => c.boxIdx)).toEqual([0, 1, 2]); // 0 부터 시작 — 1-based 가 아니다.

    // 강등된 차량도 **입력 배열 인덱스 그대로**(0-based) 보존 → 응답 내 차량 식별이 어긋나지 않는다.
    const mixed = build(g, [veh(g, -2.5), { vpdIdx: 1, mask: [{ x: 0, y: 0 }], cls: 'car', confidence: 0.5 }, veh(g, 2.5)], slotStrip(g));
    expect(mixed.rejected.map((x) => x.boxIdx)).toEqual([1]); // 가운데(인덱스 1) 만 강등.
    expect(mixed.cuboids.map((c) => c.boxIdx)).toEqual([0, 2]); // 나머지는 **원래 인덱스 유지**(0,2 — 재번호 없음).
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. 강등 경로 전수 — 각 경로가 **실제로 issues 문자열을 남기는가**
//    (throw 하거나 조용히 0/빈배열을 반환하면 결함이다)
// ═════════════════════════════════════════════════════════════════════════════

describe('강등 전수: 모든 실패가 사유 문자열을 남긴다(조용한 실패 0)', () => {
  const g = makeGround();

  it('강등 D: 슬롯 축 스프레드 > 10° → 축 기각 + 전 차량 rejected(사유 보존)', () => {
    const { X, P } = basis(g);
    // 규격 혼재(직각 + 45° 회전 주차면) → 공통 축(스트립) 가정 붕괴.
    const skew: Px[][] = [
      [P(X(-1.25, 3)), P(X(-1.25, 8)), P(X(1.25, 8)), P(X(1.25, 3))],
      [P(X(2, 3)), P(X(5.5, 6.5)), P(X(7.3, 4.7)), P(X(3.8, 1.2))], // 45° 틀어진 면.
    ];
    const r = build(g, [veh(g, 0)], skew);

    expect(r.axes).toBeNull();
    expect(anyIssue(r.issues, '스프레드')).toBe(true);
    expect(r.cuboids).toHaveLength(0);
    expect(r.rejected).toHaveLength(1); // ★ 조용히 빈 배열이 아니다 — 차량마다 사유가 남는다.
    expect(anyIssue(r.rejected[0].issues, 'yaw prior')).toBe(true);
  });

  it('강등 E: 슬롯 폴리곤 0개 → 축 불가 + issue(throw 없음)', () => {
    const r = build(g, [veh(g, 0)], []);
    expect(r.axes).toBeNull();
    expect(anyIssue(r.issues, '슬롯 폴리곤 0개')).toBe(true);
    expect(r.rejected).toHaveLength(1);
  });

  it('강등 F: MIN_FRONT_SPAN_M 미달(flank 만 보임) → 미산출 + "앞범퍼" 사유', () => {
    // 앞선 밴드의 폭축 스팬이 0.6m 뿐 — 앞범퍼(1.85m)가 아니라 **측면**을 잡은 상태.
    const pts = Array.from({ length: 40 }, (_, i) => ({ a: -0.3 + (0.6 * i) / 39, b: 3.5 + 0.004 * i }));
    const res = fitContactLine(pts, DEFAULT_CONTACT_OPTIONS);
    expect('reject' in res).toBe(true);
    if ('reject' in res) {
      expect(res.reject.kind).toBe('front-span');
      if (res.reject.kind === 'front-span') expect(res.reject.frontSpanM).toBeLessThan(1.2);
    }

    // 파이프라인 레벨: 사유 문자열이 rejected 로 올라온다.
    const narrow: Px[] = (() => {
      const { X, up, P } = basis(g);
      const pts3: Vec3[] = [];
      for (const [a, b] of [[-0.3, 3.5], [0.3, 3.5], [0.3, 8.2], [-0.3, 8.2]] as const) pts3.push(X(a, b));
      for (const [a, b] of [[-0.25, 5.4], [0.25, 5.4], [0.25, 7.5], [-0.25, 7.5]] as const) pts3.push(up(X(a, b), 1.445));
      return convexHull(pts3.map(P)) as Px[];
    })();
    const r = build(g, [{ vpdIdx: 0, mask: narrow, cls: 'car', confidence: 0.9 }], slotStrip(g));
    expect(r.cuboids).toHaveLength(0);
    expect(anyIssue(r.rejected[0].issues, '앞범퍼 접지선 미검출')).toBe(true);
  });

  it('강등 G: 앞선 MAD > frontMadMaxM(bridge/파편화) → 미산출 + "파편화" 사유', () => {
    // 앞선 밴드 안에서 b 가 톱니처럼 흔들림(마스크 파편화) → 잔차로 잡는다(비율이 아니라).
    const pts = Array.from({ length: 60 }, (_, i) => ({
      a: -1.0 + (2.0 * i) / 59,
      b: 3.5 + (i % 2 === 0 ? 0 : 0.45), // MAD ≈ 0.22m > 0.20m.
    }));
    const res = fitContactLine(pts, DEFAULT_CONTACT_OPTIONS);
    expect('reject' in res).toBe(true);
    if ('reject' in res) expect(res.reject.kind).toBe('front-mad');
  });

  it('강등 H: 앞선 밴드 열 수 < minFrontCols → 미산출', () => {
    const pts = Array.from({ length: 5 }, (_, i) => ({ a: -0.9 + 0.45 * i, b: 3.5 }));
    const res = fitContactLine(pts, DEFAULT_CONTACT_OPTIONS);
    expect('reject' in res).toBe(true);
    if ('reject' in res) expect(res.reject.kind).toBe('front-cols');
  });

  it('강등 I: 유효 접지열 부족(가림 과다) → 미산출 + "가림 과다" 사유', () => {
    // 뒷차를 앞차가 통째로 가린다(앞차 마스크가 뒷차 접지선 아래를 덮음).
    const target = veh(g, 0, { mask: carLikeMask(g, 0, CAR.H, 9.0) }); // 멀리(b=9) 있는 차.
    const { X, P } = basis(g);
    const bigOccluder: Px[] = [
      P(X(-6, 3.0)), P(X(6, 3.0)), P(X(6, 11.0)), P(X(-6, 11.0)),
    ].map((p) => ({ x: p.x, y: p.y }));
    // 가림자를 **거대한 앞 차량**으로 두고, occluderMasks 로 넘긴다.
    const r = build(g, [target], slotStrip(g), DEFAULT_CONTACT_OPTIONS, [target.mask, bigOccluder]);
    expect(r.cuboids).toHaveLength(0);
    expect(r.rejected).toHaveLength(1);
    expect(anyIssue(r.rejected[0].issues, '가림 과다')).toBe(true);
  });

  it('강등 J: W 클램프 발동 → source.W = prior + **원 스팬을 그대로 실은** 사유', () => {
    // ⚠️ **깨끗한 합성 픽스처에서는 클램프가 자연 발동하지 않는다** — near-edge 적합의 관측 폭은
    //    1.76~1.81m(참값 1.85m, 오차 −2~−5%)로 허용대역 [1.57, 2.13]m 한복판이다.
    //    (F-1 의 +18% 과대는 **육면체-껍질 픽스처**에서 나온 값이었다. 실데이터에서는 실제로 발동한다 —
    //     구현자 실측 p1 3/5 · p2 1/2 · p3 1/4. 여기서는 **분기와 사유 문자열**을 봉인한다.)
    const opts = { ...DEFAULT_CONTACT_OPTIONS, widthClampHiFactor: 0.9 }; // hi = 1.665m < 관측 1.76m → 발동.
    const r = build(g, [veh(g, 0)], slotStrip(g), opts);
    expect(r.cuboids).toHaveLength(1);
    const c = r.cuboids[0];
    expect(c.source.W).toBe('prior'); // ← 관측 실패가 **출처에 드러난다**(뷰어 점선 근거).
    expect(anyIssue(c.issues, '강등')).toBe(true);
    expect(anyIssue(c.issues, '허용대역')).toBe(true);
    expect(c.widthM).toBeCloseTo(opts.priorW * 0.9, 6); // 경계값 채택.
  });

  it('near-edge 적합의 관측 폭은 참값 ±5% 안 → 정상 차량이 클램프에 걸리지 않는다(오탐 0)', () => {
    const r = build(g, [-2.5, 0, 2.5].map((a) => veh(g, a)), slotStrip(g));
    for (const c of r.cuboids) {
      expect(c.source.W).toBe('observed'); // DEFAULT 옵션에서는 강등 없음.
      expect(Math.abs(c.widthM - CAR.W) / CAR.W).toBeLessThan(0.05);
    }
  });

  it('강등 K: 앵커 표본 < minAnchorN → 3지표 전부 null + issue(0 을 반환하지 않는다)', () => {
    const slots = slotStrip(g);
    const r = build(g, [veh(g, 0), veh(g, 2.5)], slots); // 2대 < minAnchorN(3).
    expect(r.cuboids).toHaveLength(2);

    const a = computeAnchorMetrics(r.cuboids, slots, g, r.axes, DEFAULT_ANCHOR_OPTIONS);
    expect(a.depthDevM).toBeNull(); // ★ 0 이 아니라 **null** — "정합됨"으로 오독될 수 없다.
    expect(a.phaseDevM).toBeNull();
    expect(a.unmatchedRate).toBeNull();
    expect(a.n).toBe(2);
    expect(anyIssue(a.issues, 'null')).toBe(true);
  });

  it('강등 L: 슬롯 축 없음(axes=null) → 앵커 3지표 null + issue', () => {
    const a = computeAnchorMetrics([], slotStrip(g), g, null, DEFAULT_ANCHOR_OPTIONS);
    expect(a.depthDevM).toBeNull();
    expect(a.phaseDevM).toBeNull();
    expect(a.unmatchedRate).toBeNull();
    expect(anyIssue(a.issues, '슬롯 축 없음')).toBe(true);
  });

  it('정상 경로에서는 **오탐이 없다**(강등 게이트가 정상 차량을 잡아먹지 않는다)', () => {
    const r = build(g, [-2.5, 0, 2.5].map((a) => veh(g, a)), slotStrip(g));
    expect(r.rejected).toHaveLength(0);
    expect(r.issues).toEqual([]);
    for (const c of r.cuboids) expect(c.source.position).toBe('observed');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. 가림 배제는 **필터 前 전량**을 쓴다 (설계 §D ⚠️ — 필터 후 집합으로 판정하면 가림이 조용히 누락)
// ═════════════════════════════════════════════════════════════════════════════

describe('가림 배제 = 필터 前 전량 (조용한 가림 누락 금지)', () => {
  const g = makeGround();

  it('★ 주차면 필터로 제외된 차량도 **가리기는 한다** — occluderMasks 에 포함되면 접지열이 줄어든다', () => {
    const { X, P } = basis(g);
    const target = veh(g, 0, { mask: carLikeMask(g, 0, CAR.H, 8.0) }); // 안쪽(b=8) 차량.
    // 통행 차량(주차면 밖 → 필터가 제외) 이지만 대상 차량의 발 앞을 덮는다.
    const passerby: Px[] = convexHull(
      ([[-3, 6.0], [3, 6.0], [3, 9.2], [-3, 9.2]] as const).map(([a, b]) => P(X(a, b))),
    ) as Px[];

    // (a) occluders = 자기 자신만(= 필터 後 집합으로 판정한 경우) → 가림이 **누락**된다.
    const without = build(g, [target], slotStrip(g), DEFAULT_CONTACT_OPTIONS, [target.mask]);
    // (b) occluders = 필터 前 전량(설계대로) → 가림이 반영된다.
    const withAll = build(g, [target], slotStrip(g), DEFAULT_CONTACT_OPTIONS, [target.mask, passerby]);

    const cleanWithout = without.cuboids[0]?.cleanRatio ?? 0;
    const cleanWith = withAll.cuboids[0]?.cleanRatio ?? 0;
    // ★ 필터 前 전량을 쓰면 유효비율이 **떨어진다**(= 가림을 실제로 본다). 같으면 규약이 깨진 것이다.
    expect(cleanWith).toBeLessThan(cleanWithout);
  });

  it('자기 자신은 가림자에서 제외된다 — **참조 동일성** 규약(라우트가 같은 배열을 넘겨야 한다)', () => {
    const v = veh(g, 0);
    const r = build(g, [v], slotStrip(g), DEFAULT_CONTACT_OPTIONS, [v.mask]); // 같은 참조.
    expect(r.cuboids).toHaveLength(1);
    expect(r.cuboids[0].cleanRatio).toBeGreaterThan(0.9); // 자기 마스크에 자기가 가려지지 않는다.

    // ⚠️ 참조가 다르면(복사본) 자기 자신을 가림자로 오인한다 → 라우트의 `allVehicles[k.i]` 규약이 **필수**임을 봉인.
    const copy: Px[] = v.mask.map((p) => ({ ...p }));
    const bad = build(g, [v], slotStrip(g), DEFAULT_CONTACT_OPTIONS, [copy]);
    expect(bad.cuboids[0]?.cleanRatio ?? 0).toBeLessThan(r.cuboids[0].cleanRatio);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. 회귀 봉인 — prior 독립성(F-2) · 관측/prior 경계
// ═════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════
// 5. ★★ G2b(frontFitResidPx) 의 **사각** — 자기참조 잔차이지 "배치 지표"가 아니다.
//
// 🔴 QA 발견(Loop 2). 설계서 §C 는 G2b 를 *"관측과 모델을 같은 좌표계에서 직접 비교 — 밀림에 **선형** 반응"*
//    이라 정의하고 **배치 성공기준**으로 채택했다. **프로덕션 구현은 그 성질을 갖지 않는다.**
//
//    frontFitResidPx 는 재투영 앞선(b = tFront)을 **앞선 밴드 그 자신**과 비교한다.
//    그런데 tFront = median(밴드의 b) 다 — **모델이 관측에 적합된 뒤 같은 관측과 비교된다(자기참조).**
//    ∴ 밴드 전체가 Δb 만큼 **균일하게** 밀리면 tFront·FL·FR·재투영관측이 **다 같이** Δb 만큼 움직이고
//      잔차는 **정확히 불변**이다. G2b 는 **균일 밀림을 원리적으로 볼 수 없다.**
//
//    ⚠️ 하필 그 균일 밀림이 설계서 §A-2 ② 가 예측한 **실제 오염 메커니즘**이다:
//       마스크 하단 실루엣은 지면(z=0)이 아니라 **로커패널·범퍼하단·언더바디 그림자(z≈0.15~0.25m)** 다.
//       이를 지면에 역투영하면 접지선 **전체가** 카메라에서 멀어지는 쪽으로 `나디르거리·z/(d−z)` 만큼 밀린다.
//       → **밴드 통째로 균일 밀림** → **G2b 침묵.**
//
//    ⚠️⚠️ 게다가 이 z 잔차를 재도록 설계된 유일한 지표였던 **G2a(H 오차)는 B안에서 폐기됐다**(§B-3 참조:
//       *"CONTACT_Z_OFFSET_M prior 는 G2a 에서 계통 잔차가 실제로 남을 때만 넣는다"*).
//       → **z 오염을 볼 수 있는 계기가 하나도 남아 있지 않다.** 이 사실을 은닉하지 않는다.
//
//    ✅ G2b 가 **실제로** 재는 것: 앞선 밴드의 **비직선성/두께**(yaw 어긋남·flank·bridge). 그건 유효한 적합품질 신호다.
//       실데이터 2.7 / 2.7 / 5.6 px 는 **"밴드가 얇고 곧다"** 는 뜻이지 **"배치가 맞다"** 는 뜻이 아니다.
// ═════════════════════════════════════════════════════════════════════════════

describe('★★ G2b 의 사각: 균일 밀림에 침묵한다(자기참조) — 배치 검증으로 쓰지 마라', () => {
  // 현실적 배치: 차 앞범퍼가 카메라 나디르에서 22m(화면 중앙 부근). tilt 12°, d=5m.
  const g = makeGround(12);
  const B = 22.0;
  const { X, up, P } = basis(g);

  /** 마스크 하단 실루엣이 **높이 z** 에 있는 차(z=0 → 진짜 접지선 / z>0 → 로커패널·그림자 오염). */
  const maskAtZ = (z: number): Px[] => {
    const pts: Vec3[] = [];
    for (const [a, b] of [
      [-CAR.W / 2, B], [CAR.W / 2, B], [CAR.W / 2, B + CAR.L], [-CAR.W / 2, B + CAR.L],
    ] as const) pts.push(up(X(a, b), z)); // ← 하단 윤곽을 z 만큼 띄운다.
    for (const [a, b] of [
      [-ROOF.halfW, B + ROOF.back], [ROOF.halfW, B + ROOF.back],
      [ROOF.halfW, B + ROOF.front], [-ROOF.halfW, B + ROOF.front],
    ] as const) pts.push(up(X(a, b), CAR.H));
    return convexHull(pts.map(P)) as Px[];
  };

  const slots: Px[][] = (() => {
    const out: Px[][] = [];
    for (let k = -2; k <= 2; k++) {
      const a0 = k * 2.5 - 1.25;
      out.push([P(X(a0, B - 0.5)), P(X(a0, B + 4.5)), P(X(a0 + 2.5, B + 4.5)), P(X(a0 + 2.5, B - 0.5))]);
    }
    return out;
  })();
  const axes = slotAxes(slots, g, 2.5, 5.0, 10).axes!;
  const bTrue = toAxisCoords(X(0, B), axes).b; // GT 앞선의 깊이축 좌표.

  const runAtZ = (z: number) => {
    const v: SegVehicle[] = [{ vpdIdx: 0, mask: maskAtZ(z), cls: 'car', confidence: 0.9 }];
    const c = build(g, v, slots, DEFAULT_CONTACT_OPTIONS, [v[0].mask]).cuboids[0];
    return { placeErrM: toAxisCoords(c.frontGround, axes).b - bTrue, g2bPx: c.frontFitResidPx! };
  };

  it('z=0(진짜 접지선) → 배치 정확 + G2b 0px. **정상 기준선**', () => {
    const r = runAtZ(0);
    expect(Math.abs(r.placeErrM)).toBeLessThan(0.01);
    expect(r.g2bPx).toBeLessThan(8);
  });

  it('★★ z=0.30m 오염 → 배치가 **1.4m** 틀리는데 **G2b 는 0px(통과)** — 실패를 통과시킨다', () => {
    const r = runAtZ(0.3);
    // ① 배치가 실제로 크게 틀렸다(이론 push = 나디르거리·z/(d−z) = 22×0.3/4.7 = 1.40m).
    expect(r.placeErrM).toBeGreaterThan(1.0);
    expect(r.placeErrM).toBeCloseTo((B * 0.3) / (g.d - 0.3), 1);
    // ② 그런데 G2b 는 **0px** 를 준다 → 성공기준(≤8px)을 **여유롭게 통과**한다.
    expect(r.g2bPx).toBeLessThan(1);
    // ★ 이것이 사각이다: G2b ≤ 8px 는 **배치가 맞다는 증거가 아니다**.
  });

  it('★ 밀림 크기를 키워도 G2b 는 **미동도 하지 않는다**(선형 반응이 아니라 무반응)', () => {
    const z0 = runAtZ(0);
    const z1 = runAtZ(0.1);
    const z2 = runAtZ(0.2);
    const z3 = runAtZ(0.3);
    // 배치 오차는 단조 증가한다(0 → 0.45 → 0.92 → 1.40m).
    expect(z1.placeErrM).toBeGreaterThan(z0.placeErrM);
    expect(z2.placeErrM).toBeGreaterThan(z1.placeErrM);
    expect(z3.placeErrM).toBeGreaterThan(z2.placeErrM);
    // ★ G2b 는 전부 ~0 — **설계서의 "밀림에 선형 반응"은 프로덕션 구현에 대해 거짓이다.**
    for (const r of [z0, z1, z2, z3]) expect(r.g2bPx).toBeLessThan(1);
  });

  it('✅ G2b 가 **실제로** 재는 것: 앞선 밴드의 비직선성(yaw 어긋남에 반응) — 다만 게인이 낮다', () => {
    const maskYaw = (yawDeg: number): Px[] => {
      const c = Math.cos(yawDeg * DEG);
      const s = Math.sin(yawDeg * DEG);
      const R = (a: number, b: number): [number, number] => [a * c - (b - B) * s, B + a * s + (b - B) * c];
      const pts: Vec3[] = [];
      for (const [a, b] of [
        [-CAR.W / 2, B], [CAR.W / 2, B], [CAR.W / 2, B + CAR.L], [-CAR.W / 2, B + CAR.L],
      ] as const) { const [ra, rb] = R(a, b); pts.push(X(ra, rb)); }
      for (const [a, b] of [
        [-ROOF.halfW, B + ROOF.back], [ROOF.halfW, B + ROOF.back],
        [ROOF.halfW, B + ROOF.front], [-ROOF.halfW, B + ROOF.front],
      ] as const) { const [ra, rb] = R(a, b); pts.push(up(X(ra, rb), CAR.H)); }
      return convexHull(pts.map(P)) as Px[];
    };
    const devAtYaw = (yaw: number) => {
      const v: SegVehicle[] = [{ vpdIdx: 0, mask: maskYaw(yaw), cls: 'car', confidence: 0.9 }];
      return build(g, v, slots, DEFAULT_CONTACT_OPTIONS, [v[0].mask]).cuboids[0].frontFitResidPx!;
    };
    expect(devAtYaw(0)).toBeLessThan(0.1);
    expect(devAtYaw(15)).toBeGreaterThan(devAtYaw(0)); // 반응은 한다(비직선성).
    // ⚠️ 그러나 **게인이 낮다** — 15° 나 틀어져도 1.8px 로 8px 게이트에 한참 못 미친다.
    //    G2b 를 "정합 게이트"로 신뢰하면 안 되는 두 번째 이유.
    expect(devAtYaw(15)).toBeLessThan(8);
  });
});

describe('회귀 봉인: 앵커는 prior 에 오염되지 않는다(F-2)', () => {
  const g = makeGround(20);
  const slots = (da = 0, db = 0) => slotStrip(g, da, db);

  /** PRIOR_L 을 바꿔가며 depthDevM 을 잰다. 앵커가 frontGround(관측)를 쓰면 **불변**이어야 한다. */
  const depthDevAt = (priorL: number, db = 0) => {
    const opts = { ...DEFAULT_CONTACT_OPTIONS, priorL };
    const s = slots(0, db);
    const r = build(g, [-2.5, 0, 2.5].map((a) => veh(g, a)), s, opts);
    return computeAnchorMetrics(r.cuboids, s, g, r.axes, DEFAULT_ANCHOR_OPTIONS).depthDevM!;
  };

  it('★ T-8d: depthDevM 이 PRIOR_L(4.0/4.7/5.2) 에 **비트 단위 불변**', () => {
    const d40 = depthDevAt(4.0);
    const d47 = depthDevAt(4.7);
    const d52 = depthDevAt(5.2);
    expect(d47).toBe(d40); // 비트 단위 동일 — toBeCloseTo 가 아니다.
    expect(d52).toBe(d40);
  });

  it('★ 깊이축 +2.5m 밀림 응답도 PRIOR_L 에 불변 (Δ = −2.500)', () => {
    for (const L of [4.0, 4.7, 5.2]) {
      expect(depthDevAt(L, 2.5) - depthDevAt(L, 0)).toBeCloseTo(-2.5, 6);
    }
  });

  it('centerGround 는 PRIOR_L 에 의존한다(그래서 앵커가 쓰지 않는다) — 경계가 실재함을 봉인', () => {
    const s = slots();
    const c40 = build(g, [veh(g, 0)], s, { ...DEFAULT_CONTACT_OPTIONS, priorL: 4.0 }).cuboids[0];
    const c52 = build(g, [veh(g, 0)], s, { ...DEFAULT_CONTACT_OPTIONS, priorL: 5.2 }).cuboids[0];
    const axes = slotAxes(s, g, 2.5, 5.0, 10).axes!;
    // frontGround(관측) = 불변 / centerGround(prior 주입) = 움직인다.
    expect(toAxisCoords(c40.frontGround, axes).b).toBeCloseTo(toAxisCoords(c52.frontGround, axes).b, 9);
    expect(Math.abs(toAxisCoords(c40.centerGround, axes).b - toAxisCoords(c52.centerGround, axes).b)).toBeCloseTo(0.6, 6);
  });
});
