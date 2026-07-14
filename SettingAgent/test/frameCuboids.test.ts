// buildFrameCuboids — **강등 전종 throw 0** · det/seg **출처 분리** · occluder 규약.
// 전부 **프로덕션 함수를 호출**한다(재구현 0).
//
// ⚠️ 이 파일의 합성 마스크는 "정합이 맞는가"를 판정하지 **않는다**(그건 assocRealFrames 가 실응답으로 본다).
//    여기서 보는 것은 **조립 규약**이다: 무엇이 det 에서 오고 무엇이 seg 에서 오는가, 실패하면 죽는가 강등하는가.

import { describe, expect, it } from 'vitest';
import { buildFrameCuboids, type CuboidContext } from '../src/ground/frameCuboids.js';
import { projectToPixel } from '../src/ground/project.js';
import { convexHull } from '../src/domain/polygon.js';
import type { Px, Vec3 } from '../src/ground/contactTypes.js';
import type { GroundModel } from '../src/ground/types.js';
import type { VehicleBox } from '../src/domain/types.js';
import type { VpdClient, VpdSegResult } from '../src/clients/VpdClient.js';

const DEG = Math.PI / 180;
const TILT = 14;
const IMG_W = 1920;
const IMG_H = 1080;

const g: GroundModel = {
  camIdx: 1, presetIdx: 1, imgW: IMG_W, imgH: IMG_H, zoom: 1, f: 1500,
  n: [0, Math.cos(TILT * DEG), Math.sin(TILT * DEG)], d: 5.0, tiltDeg: TILT,
  ptzTiltDeg: null, tiltErrDeg: null, slotBearingDeg: null, bearingDevDeg: null, dDevRel: null,
  depthEdgePx: 400, metricErr: 0, conf: 1, source: 'file', issues: [],
};
const O: Vec3 = [0, g.d * g.n[1], g.d * g.n[2]];
const W: Vec3 = [0, -Math.sin(TILT * DEG), Math.cos(TILT * DEG)];
const X = (a: number, b: number): Vec3 => [O[0] + a, O[1] + b * W[1], O[2] + b * W[2]];
const P = (v: Vec3): Px => projectToPixel(v, g)!;
const up = (p: Vec3, h: number): Vec3 => [p[0] - h * g.n[0], p[1] - h * g.n[1], p[2] - h * g.n[2]];

const slotPolysPx: Px[][] = [-1, 0, 1].map((k) => {
  const a0 = k * 2.5 - 1.25;
  return [P(X(a0, 8)), P(X(a0, 13)), P(X(a0 + 2.5, 13)), P(X(a0 + 2.5, 8))];
});

const ctx: CuboidContext = { model: g, slotPolysPx, slotWidthM: 2.5, slotDepthM: 5.0 };

/** 차량 실루엣(바닥 4점 + 물러난 지붕 슬래브) → 픽셀 마스크. 육면체-껍질 금지 규약 준수. */
function carMaskPx(aC: number, bFront: number): Px[] {
  const pts: Vec3[] = [];
  for (const [a, b] of [[aC - 0.93, bFront], [aC + 0.93, bFront], [aC + 0.93, bFront + 4.7], [aC - 0.93, bFront + 4.7]] as const) pts.push(X(a, b));
  for (const [a, b] of [[aC - 0.72, bFront + 1.9], [aC + 0.72, bFront + 1.9], [aC + 0.72, bFront + 4.0], [aC - 0.72, bFront + 4.0]] as const) {
    pts.push(up(X(a, b), 1.45));
  }
  return convexHull(pts.map(P)) as Px[];
}

/** 픽셀 마스크 → 정규화 마스크 + 정규화 rect(VPD 응답 규약). */
function toBox(maskPx: Px[]): { rect: VehicleBox['rect']; mask: Array<{ x: number; y: number }> } {
  const mask = maskPx.map((p) => ({ x: p.x / IMG_W, y: p.y / IMG_H }));
  const xs = mask.map((p) => p.x);
  const ys = mask.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { rect: { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }, mask };
}

const jpeg = Buffer.from('jpg');

const fakeVpd = (seg: VpdSegResult | (() => never), canSeg = true): Pick<VpdClient, 'segment' | 'canSegment'> =>
  ({
    canSegment: () => canSeg,
    segment: async () => (typeof seg === 'function' ? seg() : seg),
  }) as unknown as Pick<VpdClient, 'segment' | 'canSegment'>;

const segOf = (boxes: Array<{ rect: VehicleBox['rect']; mask: Array<{ x: number; y: number }>; cls?: string; conf?: number }>): VpdSegResult => ({
  boxes: boxes.map((b, i) => ({ vpdIdx: i, rect: b.rect, confidence: b.conf ?? 0.9, cls: b.cls ?? 'car', mask: b.mask })),
  segDegraded: false,
  maskMismatch: 0,
});

// ═════════════════════════════════════════════════════════════════════════════
describe('★ 강등 — throw 0. 정밀수집 잡을 절대 죽이지 않는다(마스터 §5)', () => {
  const car = toBox(carMaskPx(0, 8.5));
  const det: VehicleBox[] = [{ rect: car.rect, confidence: 0.9, cls: 'car' }];

  it('① ctx null(지면모델/슬롯 없음) → cuboids:[] + issue. throw 0', async () => {
    const r = await buildFrameCuboids({ jpeg, detBoxes: det, vpd: fakeVpd(segOf([car])), ctx: null });
    expect(r.cuboids).toEqual([]);
    expect(r.issues.some((s) => s.includes('지면모델'))).toBe(true);
    expect(r.estimateUnverified).toBe(true);
  });

  it('② seg 미배선(canSegment=false) → cuboids:[] + issue', async () => {
    const r = await buildFrameCuboids({ jpeg, detBoxes: det, vpd: fakeVpd(segOf([car]), false), ctx });
    expect(r.cuboids).toEqual([]);
    expect(r.issues.some((s) => s.includes('seg 미배선'))).toBe(true);
  });

  it('③ 슬롯 폴리곤 0개 → cuboids:[] + issue(yaw prior 불가)', async () => {
    const r = await buildFrameCuboids({ jpeg, detBoxes: det, vpd: fakeVpd(segOf([car])), ctx: { ...ctx, slotPolysPx: [] } });
    expect(r.cuboids).toEqual([]);
    expect(r.issues.some((s) => s.includes('슬롯 폴리곤 0개'))).toBe(true);
  });

  it('④ ★ seg **호출 실패**(타임아웃/네트워크) → throw 하지 않고 `segError` 로 **드러낸다**', async () => {
    const r = await buildFrameCuboids({
      jpeg, detBoxes: det, ctx,
      vpd: fakeVpd(() => { throw new Error('VPD 연결 실패'); }),
    });
    expect(r.cuboids).toEqual([]);
    expect(r.segError).toContain('VPD 연결 실패'); // 라우트는 이걸로 502 를 낸다 / 잡은 무시하고 계속 돈다.
    expect(r.issues.some((s) => s.includes('seg 호출 실패'))).toBe(true);
  });

  it('⑤ seg HTTP 500(검출 0대 · S-1) → segDegraded=true + 빈 육면체(실패가 아니라 정상 강등 — segError 없음)', async () => {
    const r = await buildFrameCuboids({
      jpeg, detBoxes: det, ctx,
      vpd: fakeVpd({ boxes: [], segDegraded: true, maskMismatch: 0 }),
    });
    expect(r.summary.segDegraded).toBe(true);
    expect(r.segError).toBeUndefined(); // ← 호출 실패와 **구분된다**.
    expect(r.cuboids).toEqual([]);
    expect(r.summary.unmatchedDet).toBe(1); // det 1대는 미정합으로 **드러난다**(조용히 사라지지 않는다).
  });

  it('⑥ masks/bboxes 짝 불일치(maskMismatch) → 카운트가 summary 로 드러난다', async () => {
    const r = await buildFrameCuboids({
      jpeg, detBoxes: det, ctx,
      vpd: fakeVpd({ ...segOf([car]), maskMismatch: 2 }),
    });
    expect(r.summary.maskMismatch).toBe(2);
    expect(r.issues.some((s) => s.includes('짝 불일치'))).toBe(true);
  });

  it('⑦ 정합 실패(seg 가 그 차를 못 봄) → `unmatched[]` 에 **사유 + bestIou** 보존. 육면체 없이 통과', async () => {
    const far = toBox(carMaskPx(2.5, 8.5)); // det 차량과 안 겹치는 seg.
    const r = await buildFrameCuboids({ jpeg, detBoxes: det, vpd: fakeVpd(segOf([far])), ctx });
    expect(r.cuboids).toEqual([]);
    expect(r.unmatched).toHaveLength(1);
    expect(r.unmatched[0].detIdx).toBe(0);
    expect(r.unmatched[0].bestIou).toBe(0);
    expect(r.unmatched[0].reason).toContain('seg 후보 0');
    expect(r.summary.segOnly).toBe(1); // seg-only 도 드러난다.
  });
});

describe('★ 출처 분리 — det 가 권위다(설계 §2-2)', () => {
  it('cls·confidence·bbox 는 **det** 것이고, mask 만 **seg** 것이다', async () => {
    const car = toBox(carMaskPx(0, 8.5));
    // det 와 seg 가 **다른 cls·conf** 를 준다(두 모델은 다른 모델이다). rect 도 미세하게 다르다.
    const det: VehicleBox[] = [{ rect: car.rect, confidence: 0.42, cls: 'truck' }];
    const segRect = { ...car.rect, x: car.rect.x + 0.002 }; // seg 의 bbox 는 살짝 다르다(IoU 는 여전히 높다).
    const r = await buildFrameCuboids({
      jpeg, detBoxes: det, ctx,
      vpd: fakeVpd(segOf([{ rect: segRect, mask: car.mask, cls: 'car', conf: 0.99 }])),
    });
    expect(r.cuboids).toHaveLength(1);
    const c = r.cuboids[0];
    expect(c.cls).toBe('truck'); // ★ det — seg 의 'car' 를 쓰면 두 모델이 섞인다.
    expect(c.confidence).toBe(0.42); // ★ det.
    expect(c.vpdIdx).toBe(0); // ★ **det(권위) 검출 인덱스**.
    // 마스크에서 유도되는 값(접지선)은 산출됐다 = seg 마스크가 실제로 쓰였다.
    expect(c.contactCols).toBeGreaterThan(0);
    expect(r.assoc[0]).toMatchObject({ detIdx: 0, segIdx: 0 });
  });

  it('★ `vpdIdx` 는 det 인덱스이고, 원본 마스크로 되짚는 키는 `assoc[].segIdx` 다(두 키는 갈린다)', async () => {
    // det 순서와 seg 순서가 **다르다**(실제로 두 모델은 순서가 다르다).
    const a = toBox(carMaskPx(-2.5, 8.5));
    const b = toBox(carMaskPx(2.5, 8.5));
    const det: VehicleBox[] = [
      { rect: a.rect, confidence: 0.9, cls: 'car' }, // det#0 = 왼쪽 차
      { rect: b.rect, confidence: 0.8, cls: 'car' }, // det#1 = 오른쪽 차
    ];
    const seg = segOf([b, a]); // seg 는 **역순**(seg#0 = 오른쪽, seg#1 = 왼쪽).
    const r = await buildFrameCuboids({ jpeg, detBoxes: det, vpd: fakeVpd(seg), ctx });

    expect(r.assoc).toHaveLength(2);
    const bySeg = new Map(r.assoc.map((p) => [p.detIdx, p.segIdx]));
    expect(bySeg.get(0)).toBe(1); // det#0(왼쪽) ↔ seg#1(왼쪽) — 인덱스가 **어긋난다**.
    expect(bySeg.get(1)).toBe(0);
    // 육면체는 det 인덱스로 되짚힌다.
    expect(r.cuboids.map((c) => c.vpdIdx).sort()).toEqual([0, 1]);
    // det#0 의 confidence(0.9)가 det#0 육면체에 실린다 — seg 순서에 오염되지 않았다.
    expect(r.cuboids.find((c) => c.vpdIdx === 0)!.confidence).toBe(0.9);
    expect(r.cuboids.find((c) => c.vpdIdx === 1)!.confidence).toBe(0.8);
  });

  it('주차면 필터: `keptDetIdx` 밖의 det 은 육면체를 만들지 않는다(단 가림자로는 남는다 — 아래 describe)', async () => {
    const a = toBox(carMaskPx(-2.5, 8.5));
    const b = toBox(carMaskPx(2.5, 8.5));
    const det: VehicleBox[] = [
      { rect: a.rect, confidence: 0.9, cls: 'car' },
      { rect: b.rect, confidence: 0.8, cls: 'car' },
    ];
    const r = await buildFrameCuboids({ jpeg, detBoxes: det, keptDetIdx: [0], vpd: fakeVpd(segOf([a, b])), ctx });
    expect(r.summary.detCount).toBe(2);
    expect(r.summary.kept).toBe(1);
    expect(r.summary.filteredOut).toBe(1);
    expect(r.cuboids.map((c) => c.vpdIdx)).toEqual([0]);
  });
});

describe('★★ DEFECT-1 — `assoc[].segIdx` 는 **seg 응답 원문 인덱스**다(압축 배열 위치가 아니다)', () => {
  // 🔴 D-3 의 재발이었다. `VpdClient.segment()` 는 마스크 없는 검출을 **drop** 하므로 `seg.boxes` 배열 위치는
  //    원문 인덱스와 어긋난다. 그런데 payload 는 "masks[segIdx] 로 간다"고 약속한다 → maskMismatch>0 이면 **거짓**.
  //    실측 3프레임이 maskDrop=0 이라 드러나지 않았다. **그 경로를 여기서 봉인한다.**
  it('마스크 drop 이 일어나면 `segIdx` 가 **원문 masks[] 를 정확히** 가리킨다(배열 위치가 아니다)', async () => {
    const target = toBox(carMaskPx(0, 8.5)); // 원문 seg #1 (가운데 차)
    const other = toBox(carMaskPx(2.5, 8.5)); // 원문 seg #2
    const det: VehicleBox[] = [{ rect: target.rect, confidence: 0.9, cls: 'car' }];

    // seg 원문 3대 중 **#0 이 drop** 됐다고 가정 → boxes 는 [원문#1, 원문#2] 로 **압축**된다.
    const seg: VpdSegResult = {
      boxes: [
        { vpdIdx: 1, rect: target.rect, confidence: 0.8, cls: 'car', mask: target.mask }, // 배열위치 0 ↔ 원문 1
        { vpdIdx: 2, rect: other.rect, confidence: 0.7, cls: 'car', mask: other.mask }, //  배열위치 1 ↔ 원문 2
      ],
      segDegraded: false,
      maskMismatch: 1, // ← #0 이 drop 됐다.
    };
    const r = await buildFrameCuboids({ jpeg, detBoxes: det, vpd: fakeVpd(seg), ctx });

    expect(r.assoc).toHaveLength(1);
    // ★ 핵심: 배열 위치는 0 이지만 **원문 인덱스는 1** 이다. 0 이 나오면 소비자가 drop 된 차량의 마스크를 집는다.
    expect(r.assoc[0].segIdx).toBe(1);
    expect(r.assoc[0].detIdx).toBe(0);
    expect(r.summary.maskMismatch).toBe(1);

    // 되짚기가 실제로 성립하는가 — 원문 masks[segIdx] 가 이 차량의 마스크와 같아야 한다.
    const original = [null, target.mask, other.mask]; // 원문 masks[] (0 은 drop 된 퇴화 마스크)
    expect(original[r.assoc[0].segIdx]).toBe(target.mask);
  });

  it('maskDrop 이 없으면 원문 인덱스 == 배열 위치(하위호환 — 기존 단언 불변)', async () => {
    const car = toBox(carMaskPx(0, 8.5));
    const det: VehicleBox[] = [{ rect: car.rect, confidence: 0.9, cls: 'car' }];
    const r = await buildFrameCuboids({ jpeg, detBoxes: det, vpd: fakeVpd(segOf([car])), ctx });
    expect(r.assoc[0].segIdx).toBe(0);
  });
});

describe('★★ DEFECT-2 — `keptDetIdx` 붕괴는 **조용히 강등되지 않는다**', () => {
  it('참조 동일성이 깨져 -1 이 섞이면 `issues` 에 사유가 뜬다(빈 오버레이 + 무사유 금지)', async () => {
    const car = toBox(carMaskPx(0, 8.5));
    const det: VehicleBox[] = [{ rect: car.rect, confidence: 0.9, cls: 'car' }];
    // 호출측이 `raw.indexOf(v)` 로 -1 을 얻은 상황(필터가 객체를 **복사**해 참조가 깨진 경우).
    const r = await buildFrameCuboids({ jpeg, detBoxes: det, keptDetIdx: [-1], vpd: fakeVpd(segOf([car])), ctx });
    expect(r.cuboids).toEqual([]);
    // ★ 예전엔 issues 가 **비어 있었다** — 운영자가 사유를 볼 방법이 없었다.
    expect(r.issues.some((s) => s.includes('참조를 보존하지 않는다'))).toBe(true);
    expect(r.summary.kept).toBe(0);
  });

  it('OBS-1 불변식 — 강등 경로에서도 `unmatched.length === summary.unmatchedDet`', async () => {
    const car = toBox(carMaskPx(0, 8.5));
    const det: VehicleBox[] = [
      { rect: car.rect, confidence: 0.9, cls: 'car' },
      { rect: car.rect, confidence: 0.8, cls: 'car' },
    ];
    const r = await buildFrameCuboids({ jpeg, detBoxes: det, vpd: fakeVpd(segOf([car]), false), ctx }); // seg 미배선.
    expect(r.summary.unmatchedDet).toBe(2);
    expect(r.unmatched).toHaveLength(2); // ← 예전엔 [] 라서 불변식이 강등 경로에서만 깨졌다.
    expect(r.unmatched.every((u) => u.reason.includes('seg 미배선'))).toBe(true);
  });
});

describe('★ occluder 규약 — 가림은 **실루엣의 성질**이지 det 권위와 무관하다(리더 Q3 승인)', () => {
  it('**seg-only 마스크**(det 에 없는 차)도 가림자로 쓰인다 — 안 쓰면 가림이 조용히 누락된다', async () => {
    const target = toBox(carMaskPx(0, 8.5)); // 육면체를 만들 차(det + seg 둘 다에 있다).
    const det: VehicleBox[] = [{ rect: target.rect, confidence: 0.9, cls: 'car' }];

    // 대조군: seg 에 대상 차만.
    const clean = await buildFrameCuboids({ jpeg, detBoxes: det, vpd: fakeVpd(segOf([target])), ctx });
    expect(clean.cuboids).toHaveLength(1);
    const cleanRatio = clean.cuboids[0].cleanRatio;

    // 실험군: **det 에는 없고 seg 에만 있는** 차가 대상 차의 발 앞을 덮는다.
    const blockerMask = carMaskPx(0, 4.1); // 대상 차(b=8.5) 앞쪽 → 접지선을 가린다.
    const blocker = toBox(blockerMask);
    const blocked = await buildFrameCuboids({ jpeg, detBoxes: det, vpd: fakeVpd(segOf([target, blocker])), ctx });

    expect(blocked.summary.segOnly).toBe(1); // blocker 는 det 에 없다 → seg-only.
    expect(blocked.summary.detCount).toBe(1); // det 권위: 차량 목록은 여전히 1대.
    // ★ 그런데도 **가림은 반영된다** — seg-only 를 occluder 에서 빼면 이 단언이 깨진다.
    const after = blocked.cuboids[0]?.cleanRatio ?? 0;
    expect(after).toBeLessThan(cleanRatio);
    // seg-only 는 **육면체를 만들지 못한다**(det 권위 위반 불가) — 육면체는 최대 1개.
    expect(blocked.cuboids.length).toBeLessThanOrEqual(1);
    expect(blocked.cuboids.every((c) => c.vpdIdx === 0)).toBe(true);
  });
});
