// ★ 추적성 봉인 (검증자 D-3) — **산출된 육면체를 원본 VPD 검출로 되짚을 수 있는가?**
//
// 배경: 파이프라인은 배열을 **두 번 재색인**한다.
//   ① `VpdClient.segment()` — 마스크 없는/퇴화 검출을 **drop** (bboxes 와 masks 의 짝이 안 맞을 때)
//   ② 라우트 `[0.5]` — **주차면 필터**(통행차·원경차 제외)
// ∴ `VehicleCuboid.boxIdx`(입력 배열 인덱스)는 **VPD 검출 인덱스가 아니다.** 그것으로 원본
//   `bboxes[i]`/`confidences[i]`/`masks[i]` 를 되짚으면 **엉뚱한 차량**을 가리킨다(응답에 그 배열이 없으니 대조도 불가).
//
// → `vpdIdx`(원본 검출 인덱스)를 산출물까지 관통시킨다. 이 파일은 **두 재색인이 동시에 일어나는** 경로를 봉인한다.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️⚠️ **2026-07-14 — `vpdIdx` 의 의미가 바뀌었다. 이 파일은 그대로 두되 무엇이 바뀌었는지 여기 남긴다.**
//     (직전 커밋 23b24d4 에서 봉인한 내용이므로 조용히 바꾸지 않는다 — 리더 지시.)
//
//   **바뀐 것**: 프로덕션 육면체 경로가 **det 권위**로 이동했다(마스터 결정). 이제 `buildFrameCuboids` 가
//     det 검출 목록(점유 판정이 쓰는 그 배열)을 권위로 삼고, seg 마스크를 `associateDetSeg` 로 **붙인다.**
//     → 프로덕션에서 `VehicleCuboid.vpdIdx` 는 **det 검출 인덱스**다. seg 응답의 `masks[]` 로 되짚는 키는
//       이제 별도로 `FrameCuboids.assoc[].segIdx` 다. **두 키가 분리됐다.**
//
//   ⚠️ **이 문장은 한때 거짓이었다(QA DEFECT-1, 2026-07-15 수정).** `assoc[].segIdx` 가 실제로는
//     **마스크 drop 후 압축된 배열의 위치**였다 — `maskMismatch > 0` 이면 `masks[segIdx]` 가 **엉뚱한 차량**을
//     가리켰다. **바로 이 파일이 봉인하는 D-3 함정의 재발**이었고(해결책인 `SegBox.vpdIdx` 를 손에 쥔 채 안 썼다),
//     실측 3프레임이 `maskDrop=0` 이라 우연히 드러나지 않았다.
//     → 이제 `buildFrameCuboids` 가 **출력 경계에서 `SegBox.vpdIdx`(원문 키)로 되돌려서** 싣는다.
//       봉인: `frameCuboids.test.ts` "DEFECT-1 — assoc[].segIdx 는 seg 응답 원문 인덱스다".
//
//   **안 바뀐 것(그래서 이 파일이 여전히 유효한 것)**:
//     · `VpdClient.segment()` 의 `SegBox.vpdIdx` 는 여전히 **seg 응답 내부의 원본 인덱스**다(마스크 drop 을 뚫는 키).
//     · `buildVehicleCuboids` 는 `SegVehicle.vpdIdx` 를 **그대로 통과**시킨다 — 무엇을 넣든 재색인하지 않는다.
//       이 **통과 보장**(두 번 재색인돼도 키가 안 흔들린다)이 이 파일이 봉인하는 성질이며, **지금도 참이다.**
//
//   ⚠️ 단 이 파일이 조립하는 배선(seg 를 권위로 vpdIdx 를 채우는 것)은 **더 이상 프로덕션 경로가 아니다.**
//      프로덕션의 det-권위 의미는 `frameCuboids.test.ts`("출처 분리") 와 `captureJobCuboid.test.ts` 가 봉인한다.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { VpdClient } from '../src/clients/VpdClient.js';
import { filterVehiclesOnPlace } from '../src/capture/onPlaceFilter.js';
import { buildVehicleCuboids, type SegVehicle } from '../src/ground/contact.js';
import { DEFAULT_CONTACT_OPTIONS } from '../src/ground/contactTypes.js';
import type { Px, Vec3 } from '../src/ground/contactTypes.js';
import { projectToPixel } from '../src/ground/project.js';
import { convexHull } from '../src/domain/polygon.js';
import type { GroundModel } from '../src/ground/types.js';

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

/** 슬롯 3칸(2.5 × 5.0m), 깊이 b ∈ [8, 13]. */
const slotPolysPx: Px[][] = [-1, 0, 1].map((k) => {
  const a0 = k * 2.5 - 1.25;
  return [P(X(a0, 8)), P(X(a0, 13)), P(X(a0 + 2.5, 13)), P(X(a0 + 2.5, 8))];
});

/** 차량 실루엣(바닥 4점 + 지붕 슬래브) → 픽셀 마스크. bFront = 앞범퍼 깊이. */
function carMaskPx(aC: number, bFront: number): Px[] {
  const pts: Vec3[] = [];
  for (const [a, b] of [[aC - 0.93, bFront], [aC + 0.93, bFront], [aC + 0.93, bFront + 4.7], [aC - 0.93, bFront + 4.7]] as const) {
    pts.push(X(a, b));
  }
  for (const [a, b] of [[aC - 0.72, bFront + 1.9], [aC + 0.72, bFront + 1.9], [aC + 0.72, bFront + 4.0], [aC - 0.72, bFront + 4.0]] as const) {
    pts.push(up(X(a, b), 1.45));
  }
  return convexHull(pts.map(P)) as Px[];
}

/** 마스크 → VPD 응답 형식(픽셀 정수 폴리곤) + 그 bbox. */
function toVpd(mask: Px[]) {
  const xs = mask.map((p) => p.x);
  const ys = mask.map((p) => p.y);
  return {
    mask: mask.map((p) => [Math.round(p.x), Math.round(p.y)]),
    bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
  };
}

const jpegOf = (w: number, h: number): Buffer =>
  Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
    (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
  ]);

describe('★ 추적성 — vpdIdx 는 마스크 drop + 주차면 필터를 **둘 다** 통과해 원본을 가리킨다', () => {
  it('두 재색인이 동시에 일어나도 vpdIdx 가 원본 VPD 검출을 정확히 가리킨다', async () => {
    // ── VPD 원본 검출 4대 ────────────────────────────────────────────────────
    //   #0 슬롯차(정상)            → 살아남는다
    //   #1 마스크 **누락**          → ① VpdClient 가 drop
    //   #2 통행차(주차면 밖, 앞쪽)  → ② 주차면 필터가 제외
    //   #3 슬롯차(정상)            → 살아남는다
    const cars = [
      toVpd(carMaskPx(-2.5, 8.5)), // #0 슬롯 0
      toVpd(carMaskPx(0, 8.5)), //    #1 슬롯 1 (마스크만 뺀다)
      toVpd(carMaskPx(0, 2.0)), //    #2 주차면 앞 6.5m — 통행차
      toVpd(carMaskPx(2.5, 8.5)), //  #3 슬롯 2
    ];
    const body = {
      success: true,
      id: 1,
      bboxes: cars.map((c) => c.bbox),
      confidences: [0.97, 0.95, 0.93, 0.91],
      classes: ['car', 'car', 'car', 'car'],
      // ★ #1 의 마스크를 **퇴화**시킨다(점 2개) → VpdClient 가 drop → 배열이 4 → 3 으로 줄며 **1차 재색인**.
      masks: [cars[0].mask, [[0, 0], [1, 1]], cars[2].mask, cars[3].mask],
    };

    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    let seg;
    try {
      const vpd = new VpdClient({
        endpoint: 'http://x', detPath: '/det', segPath: '/seg', timeoutMs: 500, maxRetries: 0,
      } as never);
      seg = await vpd.segment(jpegOf(IMG_W, IMG_H));
    } finally {
      globalThis.fetch = orig;
    }

    // ① 마스크 drop 확인 — 3대만 남고, **원본 인덱스는 0·2·3** (배열 위치 0·1·2 와 어긋난다).
    expect(seg.maskMismatch).toBe(1);
    expect(seg.boxes.map((b) => b.vpdIdx)).toEqual([0, 2, 3]);

    // ② 주차면 필터 — 통행차(원본 #2)를 뺀다. 라우트와 **같은 방식**으로 원본 참조를 들고 다닌다.
    const polysNorm = slotPolysPx.map((poly) => poly.map((p) => ({ x: p.x / IMG_W, y: p.y / IMG_H })));
    const all: SegVehicle[] = seg.boxes.map((b) => ({
      vpdIdx: b.vpdIdx,
      mask: b.mask!.map((p) => ({ x: p.x * IMG_W, y: p.y * IMG_H })),
      cls: b.cls,
      confidence: b.confidence,
    }));
    const filt = filterVehiclesOnPlace(
      seg.boxes.map((b, i) => ({ rect: b.rect, i })),
      polysNorm,
    );
    const kept = filt.kept.map((k) => all[k.i]);

    expect(filt.filteredOut).toBe(1); // 통행차 1대 제외 → **2차 재색인**.
    expect(kept.map((v) => v.vpdIdx)).toEqual([0, 3]); // 원본 #0·#3 만 남는다.

    // ③ 육면체 산출 — 가림 배제는 **필터 전 전량**(통행차 포함).
    const r = buildVehicleCuboids({
      vehicles: kept,
      occluderMasks: all.map((v) => v.mask),
      slotPolysPx,
      ground: g,
      slotWidthM: 2.5,
      slotDepthM: 5.0,
      opts: DEFAULT_CONTACT_OPTIONS,
    });

    // ★ 핵심 봉인: boxIdx 는 **입력 배열 위치**(0,1) / vpdIdx 는 **원본 VPD 검출**(0,3).
    //   둘이 다르다는 것 자체가 D-3 의 요점이다 — boxIdx 로 원본을 되짚으면 #1(drop된 차)을 가리킨다.
    const traced = [...r.cuboids, ...r.rejected].sort((a, b) => a.boxIdx - b.boxIdx);
    expect(traced).toHaveLength(2);
    expect(traced.map((c) => c.boxIdx)).toEqual([0, 1]); // 입력 배열 위치.
    expect(traced.map((c) => c.vpdIdx)).toEqual([0, 3]); // ★ 원본 VPD 검출 인덱스.
    expect(traced[1].boxIdx).not.toBe(traced[1].vpdIdx); // 두 키는 실제로 갈린다(무해한 우연 일치 아님).

    // 원본 응답으로 되짚기가 성립하는가 — vpdIdx 로 bbox·confidence 를 정확히 찾아낼 수 있어야 한다.
    for (const c of traced) {
      expect(body.confidences[c.vpdIdx]).toBe(seg.boxes.find((b) => b.vpdIdx === c.vpdIdx)!.confidence);
      expect(body.bboxes[c.vpdIdx]).toEqual(cars[c.vpdIdx].bbox);
    }
  });

  it('강등(rejected)된 차량도 vpdIdx 를 보존한다 — 조용히 사라지지 않고 원본으로 되짚힌다', () => {
    const vehicles: SegVehicle[] = [
      { vpdIdx: 7, mask: carMaskPx(-2.5, 8.5), cls: 'car', confidence: 0.9 },
      { vpdIdx: 9, mask: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], cls: 'car', confidence: 0.5 }, // 면적 퇴화 → 강등.
    ];
    const r = buildVehicleCuboids({
      vehicles, slotPolysPx, ground: g, slotWidthM: 2.5, slotDepthM: 5.0, opts: DEFAULT_CONTACT_OPTIONS,
    });
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0].boxIdx).toBe(1); // 입력 위치.
    expect(r.rejected[0].vpdIdx).toBe(9); // ★ 원본 검출.
    expect(r.rejected[0].issues[0]).toContain('마스크 퇴화'); // 강등 사유는 여전히 남는다(조용한 실패 금지).
    expect(r.cuboids[0].vpdIdx).toBe(7);
  });
});
