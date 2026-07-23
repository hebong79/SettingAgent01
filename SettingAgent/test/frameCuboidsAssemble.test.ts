// 리팩토링 3단계 — 추출 순수함수 봉인(assembleSegVehicles / unmatchedReason / lineFitRejectReason).
//
// ★ 목적 두 가지:
//   1. assembleSegVehicles([−1] 정합+조립)의 반환 구조·출처 분리를 **프로덕션 함수로 직접** 확정.
//   2. reason 문자열 3종(unmatchedReason·lineFitRejectReason)이 §6-2 **평탄화(중첩삼항→if나열) 후에도
//      바이트 불변**임을 exact 스냅샷으로 고정한다. 이 문자열들이 운영자가 미정합/기각을 이해하는 유일한 표면이다.
//
// 전부 프로덕션 함수 호출(재구현 0). 합성 rect/mask 는 "정합이 맞는가"가 아니라 **조립·사유 규약**만 본다.

import { describe, expect, it } from 'vitest';
import { assembleSegVehicles, unmatchedReason } from '../src/ground/frameCuboids.js';
import { lineFitRejectReason } from '../src/ground/contact.js';
import { DEFAULT_ASSOC_OPTIONS } from '../src/ground/segAssoc.js';
import { DEFAULT_CONTACT_OPTIONS } from '../src/ground/contactTypes.js';
import type { GroundModel } from '../src/ground/types.js';
import type { VehicleBox } from '../src/domain/types.js';
import type { SegBox } from '../src/clients/VpdClient.js';

const IMG_W = 1920;
const IMG_H = 1080;

/** 조립에 필요한 최소 지면모델(픽셀 스케일만 쓰인다 — assembleSegVehicles 는 육면체를 만들지 않는다). */
const g: GroundModel = {
  camIdx: 1, presetIdx: 1, imgW: IMG_W, imgH: IMG_H, zoom: 1, f: 1500,
  n: [0, 0.97, 0.24], d: 5.0, tiltDeg: 14, ptzTiltDeg: null, tiltErrDeg: null,
  slotBearingDeg: null, bearingDevDeg: null, dDevRel: null,
  depthEdgePx: 400, metricErr: 0, conf: 1, source: 'file', issues: [],
};

const rect = (x: number, y: number, w = 0.1, h = 0.1) => ({ x, y, w, h });
/** 정규화 삼각 마스크(≥3점 — 조립이 px 매핑만 한다). */
const triMask = (x: number, y: number) => [
  { x, y }, { x: x + 0.05, y }, { x: x + 0.025, y: y + 0.05 },
];

// ═════════════════════════════════════════════════════════════════════════════
describe('assembleSegVehicles — [−1] 정합 + 조립(det 권위·seg 마스크)', () => {
  it('매칭 성공 — vehicles 1대, cls·confidence 는 det, mask 는 seg, unmatched 없음', () => {
    const R = rect(0.4, 0.5);
    const det: VehicleBox[] = [{ rect: R, confidence: 0.9, cls: 'car' }];
    // seg 는 **다른 cls·confidence**(두 모델은 다른 모델) + 겹치는 rect(IoU=1) + 마스크.
    const seg: SegBox[] = [{ vpdIdx: 0, rect: R, confidence: 0.5, cls: 'truck', mask: triMask(0.4, 0.5) }];

    const r = assembleSegVehicles(det, seg, [0], g);

    expect(r.vehicles).toHaveLength(1);
    expect(r.unmatched).toHaveLength(0);
    const v = r.vehicles[0];
    expect(v.vpdIdx).toBe(0); // ★ det(권위) 검출 인덱스.
    expect(v.cls).toBe('car'); // ★ det — seg 의 'truck' 을 쓰면 두 모델이 섞인다.
    expect(v.confidence).toBe(0.9); // ★ det.
    expect(v.mask).toHaveLength(3); // ★ seg 마스크(px 매핑됨).
    expect(v.mask[0]).toEqual({ x: 0.4 * IMG_W, y: 0.5 * IMG_H }); // 정규화→px 변환 확인.
    // assoc 은 det↔seg 를 1:1 로 이었다.
    expect(r.assoc.pairs).toHaveLength(1);
    expect(r.assoc.pairs[0]).toMatchObject({ detIdx: 0, segIdx: 0 });
  });

  it('매칭 실패(seg 후보 0) — vehicles 없음, unmatched 에 사유+bestIou 보존(조용한 실패 금지)', () => {
    const det: VehicleBox[] = [{ rect: rect(0.4, 0.5), confidence: 0.9, cls: 'car' }];
    const r = assembleSegVehicles(det, [], [0], g); // seg 없음.

    expect(r.vehicles).toHaveLength(0);
    expect(r.unmatched).toHaveLength(1);
    expect(r.unmatched[0].detIdx).toBe(0);
    expect(r.unmatched[0].bestIou).toBe(0);
    expect(r.unmatched[0].reason).toContain('seg 후보 0'); // reason 이 payload 로 드러난다.
    expect(r.assoc.unmatchedDet).toContain(0);
  });

  it('매칭 실패(seg 는 있으나 미겹침 IoU=0) — 여전히 unmatched, det 배열은 보존', () => {
    const det: VehicleBox[] = [{ rect: rect(0.4, 0.5), confidence: 0.9, cls: 'car' }];
    // 완전히 다른 위치의 seg(IoU=0) → bestIou=0.
    const seg: SegBox[] = [{ vpdIdx: 0, rect: rect(0.05, 0.05), confidence: 0.9, cls: 'car', mask: triMask(0.05, 0.05) }];
    const r = assembleSegVehicles(det, seg, [0], g);

    expect(r.vehicles).toHaveLength(0);
    expect(r.unmatched).toHaveLength(1);
    expect(r.unmatched[0].bestIou).toBe(0);
    expect(r.assoc.unmatchedSeg).toContain(0); // seg-only 로 드러난다.
  });

  it('keptIdx 밖의 det 은 조립되지 않는다(주차면 필터 결과 존중)', () => {
    const R0 = rect(0.4, 0.5);
    const R1 = rect(0.1, 0.1);
    const det: VehicleBox[] = [
      { rect: R0, confidence: 0.9, cls: 'car' },
      { rect: R1, confidence: 0.8, cls: 'car' },
    ];
    const seg: SegBox[] = [
      { vpdIdx: 0, rect: R0, confidence: 0.9, cls: 'car', mask: triMask(0.4, 0.5) },
      { vpdIdx: 1, rect: R1, confidence: 0.8, cls: 'car', mask: triMask(0.1, 0.1) },
    ];
    const r = assembleSegVehicles(det, seg, [0], g); // det#1 은 keptIdx 밖.
    expect(r.vehicles.map((v) => v.vpdIdx)).toEqual([0]);
    expect(r.unmatched).toHaveLength(0); // keptIdx 밖은 unmatched 도 아니다(그냥 제외).
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// reason 평탄화 봉인 — §6-2 후에도 문자열이 **바이트 단위로 불변**임을 exact 스냅샷으로 고정.
describe('unmatchedReason — 세 분기 exact 스냅샷(§6-2 평탄화 불변)', () => {
  it('best === 0 → seg 후보 0 문장', () => {
    expect(unmatchedReason(0)).toBe('seg 후보 0 — seg 모델이 이 차량을 못 봄(육면체 없이 통과)');
  });

  it('0 < best < 임계 → 파편화/병합 의심 문장(임계값·수치 포맷 고정)', () => {
    expect(unmatchedReason(0.2)).toBe(
      `seg 최고 IoU 0.200 < 임계 ${DEFAULT_ASSOC_OPTIONS.minIou} — 마스크 파편화/병합 의심(육면체 없이 통과)`,
    );
  });

  it('best ≥ 임계 → 1:1 경합 패배 문장', () => {
    expect(unmatchedReason(0.6)).toBe(
      '1:1 경합 패배 — 최고 IoU 0.600(임계 이상)인 seg 를 **다른 det 이 더 높은 IoU 로 가져갔다**. ' +
        'det 두 대가 같은 마스크를 다툰다 = 마스크 병합 의심(육면체 없이 통과)',
    );
  });

  it('경계값 best === 임계(0.4) 는 "임계 이상" 분기로 간다(< 아님)', () => {
    expect(unmatchedReason(DEFAULT_ASSOC_OPTIONS.minIou)).toContain('임계 이상');
  });
});

describe('lineFitRejectReason — 네 분기 exact 스냅샷(§6-2 조기반환 평탄화 불변)', () => {
  const o = DEFAULT_CONTACT_OPTIONS;

  it("kind 'front-span'", () => {
    expect(lineFitRejectReason({ kind: 'front-span', frontSpanM: 0.5, frontCount: 3 }, o)).toBe(
      `앞범퍼 접지선 미검출(앞선 폭 스팬 0.50m < ${o.minFrontSpanM}m, 앞선열 3개) — ` +
        'flank 만 보임 / 원경 / 가림 과다 → 육면체 미산출',
    );
  });

  it("kind 'front-cols'", () => {
    expect(lineFitRejectReason({ kind: 'front-cols', frontCount: 5 }, o)).toBe(
      `앞선 밴드 열 5개(< ${o.minFrontCols}) — 육면체 미산출`,
    );
  });

  it("kind 'front-mad'", () => {
    expect(lineFitRejectReason({ kind: 'front-mad', frontMadM: 0.35 }, o)).toBe(
      `앞선 잔차(MAD) 0.35m > ${o.frontMadMaxM}m — 마스크 파편화(bridge) 의심 → 육면체 미산출`,
    );
  });

  it("kind 'empty'", () => {
    expect(lineFitRejectReason({ kind: 'empty' }, o)).toBe('접지점 없음 — 육면체 미산출');
  });
});
