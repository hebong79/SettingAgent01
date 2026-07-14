// ★ **실서버 응답 원문 녹화** 픽스처로 정합을 봉인한다(합성 금지 — 마스터 지적 ①).
//
// 픽스처 `test/fixtures/assoc/cam1_p{1,2,3}.json` 은 라이브 VPD(192.168.0.125:9081)가 실프레임 3장
// (`data/refframes/cam1_p{1,2,3}.jpg`, tilt 6.9°/7.5°/18.8° · 차량 7/8/15대)에 대해 준 **det·seg 응답 원문**이다.
// 하네스 `_qa_assoc_iou.ts` 가 녹화했다. 이 파일이 하는 일:
//   1) 원문을 **프로덕션 `VpdClient`** 파서에 그대로 태운다(정규화·마스크 drop 규약을 재구현하지 않는다).
//   2) **프로덕션 `associateDetSeg`** 를 호출한다(재구현 0 — D-1 함정 방어).
//   3) matched/unmatched 카운트를 **봉인**한다.
//
// 🔴 **IoU 로 "정합이 맞다"를 판정하지 않는다**(자기참조). 여기서 쓰는 독립 대조는 **교차프레임 음성대조**다 —
//    다른 프레임의 seg 로 정합하면 matched 가 **붕괴해야 한다**. 안 붕괴하면 IoU 는 변별력이 없는 것이다.
//    ⚠️ 설계서의 "seg 목록 무작위 **순열**" 은 유효한 대조가 **아니다**: `associateDetSeg` 는 기하로만 짝을 찾으므로
//       목록 순서를 섞어도 같은 물리 쌍을 다시 찾는다(순열 불변 — 알고리즘의 성질이지 결함이 아니다).
//       실측에서도 27 → 27 로 안 붕괴했다. 그것을 "변별력 0" 으로 읽으면 **거짓 경보**다. → 교차프레임으로 교체했다.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { VpdClient } from '../src/clients/VpdClient.js';
import { associateDetSeg, DEFAULT_ASSOC_OPTIONS } from '../src/ground/segAssoc.js';
import type { VehicleBox } from '../src/domain/types.js';
import type { SegBox } from '../src/clients/VpdClient.js';

interface Fixture {
  frame: string;
  imgW: number;
  imgH: number;
  det: unknown;
  seg: unknown;
}

const FRAMES = [1, 2, 3] as const;
const fx = (p: number): Fixture => JSON.parse(readFileSync(`test/fixtures/assoc/cam1_p${p}.json`, 'utf8'));

/** 크기만 유효한 최소 JPEG 헤더(VpdClient.readJpegSize 용). 실프레임(런타임 데이터)에 의존하지 않는다. */
const jpegOf = (w: number, h: number): Buffer =>
  Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
    (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
  ]);

/** 녹화 원문 → **프로덕션 VpdClient** 파서(정규화·마스크 drop 규약을 테스트가 재구현하지 않는다). */
async function parse(p: number): Promise<{ det: VehicleBox[]; seg: SegBox[]; maskMismatch: number; f: Fixture }> {
  const f = fx(p);
  const vpd = new VpdClient({
    endpoint: 'http://x', detPath: '/det/imgupload', segPath: '/seg/imgupload', timeoutMs: 500, maxRetries: 0,
  } as never);
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = (async (url: string) =>
      new Response(JSON.stringify(String(url).includes('/seg/') ? f.seg : f.det), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const jpg = jpegOf(f.imgW, f.imgH);
    const det = await vpd.detect(jpg);
    const seg = await vpd.segment(jpg);
    return { det, seg: seg.boxes, maskMismatch: seg.maskMismatch, f };
  } finally {
    globalThis.fetch = orig;
  }
}

describe('★ 실서버 응답 원문(녹화) — det ↔ seg 정합 봉인', () => {
  it('① det 와 seg 는 **검출 개수가 실제로 다르다** — 정합이 필요하다는 전제의 실증', async () => {
    const counts: Array<[number, number]> = [];
    for (const p of FRAMES) {
      const { det, seg } = await parse(p);
      counts.push([det.length, seg.length]);
    }
    // 실측: p1 det7/seg5 · p2 det8/seg9 · p3 det15/seg14 — **개수가 다르고 방향도 일정하지 않다**.
    expect(counts).toEqual([[7, 5], [8, 9], [15, 14]]);
    expect(counts.some(([d, s]) => d !== s)).toBe(true);
  });

  it('② matched/unmatched 카운트 봉인(τ = DEFAULT_ASSOC_OPTIONS.minIou)', async () => {
    const got: Array<{ matched: number; unDet: number; segOnly: number }> = [];
    for (const p of FRAMES) {
      const { det, seg } = await parse(p);
      const r = associateDetSeg(det.map((b) => b.rect), seg.map((b) => b.rect), DEFAULT_ASSOC_OPTIONS);
      got.push({ matched: r.pairs.length, unDet: r.unmatchedDet.length, segOnly: r.unmatchedSeg.length });

      // 1:1 불변식은 **실데이터에서도** 성립한다.
      expect(new Set(r.pairs.map((x) => x.detIdx)).size).toBe(r.pairs.length);
      expect(new Set(r.pairs.map((x) => x.segIdx)).size).toBe(r.pairs.length);
      // 회계 항등식 — 어떤 det/seg 도 조용히 사라지지 않는다.
      expect(r.pairs.length + r.unmatchedDet.length).toBe(det.length);
      expect(r.pairs.length + r.unmatchedSeg.length).toBe(seg.length);
    }
    expect(got).toEqual([
      { matched: 5, unDet: 2, segOnly: 0 }, // p1 — seg 가 2대를 못 봄.
      { matched: 8, unDet: 0, segOnly: 1 }, // p2 — seg 가 1대를 더 봄(det 권위 → 무시, occluder 로만 씀).
      { matched: 14, unDet: 1, segOnly: 0 }, // p3 — 미정합 1대(V-1 거대 병합 박스 conf 0.39).
    ]);
  });

  it('🔴 J2a 교차프레임 음성대조 — **다른 프레임** seg 로 정합하면 matched 가 붕괴한다(IoU 변별력의 근거)', async () => {
    // ⚠️ **순차 파싱**이어야 한다 — `parse()` 는 globalThis.fetch 를 스텁으로 갈아끼운다. Promise.all 로 돌리면
    //    세 호출이 서로의 스텁을 덮어써 **엉뚱한 프레임의 응답**을 파싱하고도 조용히 통과할 수 있다(실제로 겪음).
    const parsed: Awaited<ReturnType<typeof parse>>[] = [];
    for (const p of FRAMES) parsed.push(await parse(p));
    let same = 0;
    let cross = 0;
    for (let i = 0; i < parsed.length; i++) {
      for (let j = 0; j < parsed.length; j++) {
        const n = associateDetSeg(
          parsed[i].det.map((b) => b.rect),
          parsed[j].seg.map((b) => b.rect),
          DEFAULT_ASSOC_OPTIONS,
        ).pairs.length;
        if (i === j) same += n;
        else cross += n;
      }
    }
    expect(same).toBe(27); // 동일 프레임 — 27쌍.
    // 교차(6조합)는 **붕괴한다**. 붕괴하지 않으면 IoU 가 아무 차량이나 붙이고 있다는 뜻 → 정합 자체가 무의미.
    expect(cross).toBeLessThan(same / 4);
  });

  it('🔴 J3 cls 일치율 — 정합 쌍의 det.cls 와 seg.cls 가 일치한다(기하와 **독립**인 신호)', async () => {
    let hit = 0;
    let tot = 0;
    for (const p of FRAMES) {
      const { det, seg } = await parse(p);
      const r = associateDetSeg(det.map((b) => b.rect), seg.map((b) => b.rect), DEFAULT_ASSOC_OPTIONS);
      for (const pr of r.pairs) {
        tot += 1;
        if (det[pr.detIdx].cls === seg[pr.segIdx].cls) hit += 1;
      }
    }
    expect(tot).toBe(27);
    expect(hit).toBe(27); // 실측 100% — 기하가 붙인 쌍이 의미(class)까지 일치한다.
  });

  it('④ 모호 쌍(best−second < 0.10)이 **2건 존재한다** — 설계의 "0건" 전제는 실데이터에서 거짓이었다', async () => {
    const ambiguous: Array<{ p: number; detIdx: number; gap: number }> = [];
    for (const p of FRAMES) {
      const { det, seg } = await parse(p);
      const r = associateDetSeg(det.map((b) => b.rect), seg.map((b) => b.rect), DEFAULT_ASSOC_OPTIONS);
      r.bestIouByDet.forEach((best, i) => {
        const second = r.secondIouByDet[i];
        if (second > 0 && best - second < 0.1) ambiguous.push({ p, detIdx: i, gap: best - second });
      });
    }
    // ⚠️ 설계 §1-3 은 "모호 쌍 0건이면 그리디 = 헝가리안(자명)" 이라는 조건부 논증을 걸었는데, **조건이 거짓**이다.
    //   그래서 자명성에 기대지 않고 하네스가 **완전탐색 전역최적**과 직접 대조했다 → 3/3 프레임 배정 완전 동일.
    //   즉 이 데이터에서 헝가리안은 아무것도 바꾸지 않는다(리더 보고 항목 — 임의 도입 금지).
    expect(ambiguous).toHaveLength(2);
  });
});
