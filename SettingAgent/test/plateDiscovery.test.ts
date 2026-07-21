import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import { PlateDiscovery, pickOwnedPlate, type CropFn } from '../src/calibrate/plateDiscovery.js';
import { computeCropWindow, toCropPoint, backmapQuad, gridCenter } from '../src/calibrate/cropZoom.js';
import { rectToQuad } from '../src/domain/geometry.js';
import type { ICameraClient } from '../src/clients/CameraClient.js';
import type { LpdClient, PlateBox } from '../src/clients/LpdClient.js';
import type { NormalizedQuad, NormalizedRect } from '../src/domain/types.js';
import type { DiscoveryTarget } from '../src/calibrate/types.js';

/**
 * 검증자(qa-tester): PlateDiscovery.discoverSlot 탐색 루프(설계서 §3-1, T-4). camera/lpd/crop DI 스텁.
 * - Tier0 full 즉시검출(matchRadius 게이트) / full 반경밖→crop 진입 / crop step k 최초검출 + backmapQuad 역매핑 /
 *   maxSteps 소진 no_plate / anchor 부재 no_anchor / 이웃 후보 배제(anchor 최근접 채택).
 * - 성공 시 lpdOrig 가 원본 좌표(backmapQuad)로 역매핑됨을 실제 함수로 교차검증.
 * crop 은 stub(sharp 불요) — readJpegSize 는 원본 frame 에만 적용되므로 frame 은 실 JPEG(sharp 생성).
 */

const IMG_W = 1920;
const IMG_H = 1080;
const ASPECT = IMG_W / IMG_H;
const FRAC0 = 0.4;
const SHRINK = 0.6;

let frame: Buffer; // 실 JPEG(readJpegSize 통과용). 1920×1080.
beforeAll(async () => {
  frame = await sharp({ create: { width: IMG_W, height: IMG_H, channels: 3, background: { r: 12, g: 24, b: 48 } } })
    .jpeg().toBuffer();
});

/** rect → PlateBox(축정렬 quad). 좌표계는 호출자 문맥(원본 또는 크롭 정규화). */
function plate(cx: number, cy: number, w = 0.06, h = 0.03, conf = 0.9): PlateBox {
  return { quad: rectToQuad({ x: cx - w / 2, y: cy - h / 2, w, h }), confidence: conf, cls: 'plate' };
}

const target = (over: Partial<DiscoveryTarget> = {}): DiscoveryTarget => ({
  camIdx: 1, presetIdx: 1, slotId: '1', globalIdx: 1, anchor: { x: 0.5, y: 0.5 }, presetSlotIdx: 1, ...over,
});

/** 원본 프레임 반환 카메라 스텁(requestImage 호출 카운트 관찰). */
function makeCamera() {
  let calls = 0;
  const camera = {
    requestImage: async () => {
      calls += 1;
      return { camIdx: 1, presetIdx: 1, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: frame };
    },
  } as unknown as Pick<ICameraClient, 'requestImage'>;
  return { camera, calls: () => calls };
}

/** crop 스텁: 호출 인자(W·outLongPx) 기록 + 스텝별 마커 버퍼 반환(내용은 lpd 스텁이 무시). */
function makeCrop() {
  const calls: { W: NormalizedRect; outLongPx: number }[] = [];
  const crop: CropFn = async (_jpeg, W, outLongPx) => {
    calls.push({ W, outLongPx });
    return Buffer.from(`crop${calls.length}`);
  };
  return { crop, calls };
}

/**
 * 기대 크롭창 W_k(격자 세맨틱 개정, 설계 §3-2): level=floor((k-1)/6)+1, frac=frac0·shrink^(level-1),
 * off=GRID_OFFSETS[(k-1)%6] (6방). k=1 은 off(0,0) → 중심=앵커(기존 step1 과 동일).
 */
const GRID_OFFSETS_T = [
  { dx: 0, dy: 0 }, { dx: 0, dy: 0.5 }, { dx: -0.5, dy: 0.5 }, { dx: 0.5, dy: 0.5 }, { dx: -0.5, dy: 0 }, { dx: 0.5, dy: 0 },
] as const;
const windowAt = (k: number, anchor = { x: 0.5, y: 0.5 }): NormalizedRect => {
  const level = Math.floor((k - 1) / 6) + 1;
  const frac = FRAC0 * SHRINK ** (level - 1);
  const off = GRID_OFFSETS_T[(k - 1) % 6];
  return computeCropWindow(gridCenter(anchor, frac, ASPECT, off), frac, ASPECT);
};

function expectQuadClose(a: NormalizedQuad, b: NormalizedQuad, eps = 1e-9): void {
  for (let i = 0; i < 4; i++) {
    expect(Math.abs(a[i].x - b[i].x)).toBeLessThan(eps);
    expect(Math.abs(a[i].y - b[i].y)).toBeLessThan(eps);
  }
}

describe('discoverSlot · Tier0 full', () => {
  it('앞면중심 반경 내 검출 → found(tier:full, step:0), 역계산 불요(quad 그대로), crop 미호출', async () => {
    const { camera } = makeCamera();
    const { crop, calls } = makeCrop();
    const fullPlate = plate(0.5, 0.51); // anchor(0.5,0.5) 로부터 ≈0.01 < 0.15
    const lpd = { detect: async () => [fullPlate] } as unknown as Pick<LpdClient, 'detect'>;
    const disc = new PlateDiscovery({ camera, lpd, crop });
    const r = await disc.discoverSlot(target(), { pan: 0, tilt: 0, zoom: 1 });
    expect(r.found).toBe(true);
    expect(r.tier).toBe('full');
    expect(r.step).toBe(0);
    expect(r.lpdOrig).toEqual(fullPlate.quad);
    expect(r.confidence).toBe(0.9);
    expect(r.reason).toBeUndefined();
    expect(calls).toHaveLength(0); // 반경 내면 크롭 진입 안 함
  });

  it('full 후보가 matchRadius 밖 → 기각 후 crop 진입(step1 검출) + backmapQuad 원본좌표', async () => {
    const { camera } = makeCamera();
    const { crop, calls } = makeCrop();
    const farPlate = plate(0.85, 0.85); // dist ≈0.495 > 0.15 → 기각
    const cropPlate = plate(0.5, 0.5); // 크롭 정규화 좌표
    const lpd = {
      detect: async (buf: Buffer) => (buf === frame ? [farPlate] : [cropPlate]),
    } as unknown as Pick<LpdClient, 'detect'>;
    const disc = new PlateDiscovery({ camera, lpd, crop });
    const r = await disc.discoverSlot(target());
    expect(r.found).toBe(true);
    expect(r.tier).toBe('crop');
    expect(r.step).toBe(1);
    expect(calls).toHaveLength(1);
    // 역계산: lpdOrig == backmapQuad(cropPlate, W1).
    expectQuadClose(r.lpdOrig!, backmapQuad(cropPlate.quad, windowAt(1)));
    expect(r.cropWindow).toEqual(windowAt(1));
  });
});

describe('discoverSlot · Tier1 crop 축소반복', () => {
  it('step1 미검출 → step2 최초검출: step/cropWindow=W2 + 역매핑 원본좌표', async () => {
    const { camera } = makeCamera();
    const { crop, calls } = makeCrop();
    const cropPlate = plate(0.55, 0.48, 0.08, 0.04, 0.77);
    const lpd = {
      detect: async (buf: Buffer) => {
        if (buf === frame) return []; // full 미검출
        return calls.length === 2 ? [cropPlate] : []; // 두 번째 크롭에서만 검출
      },
    } as unknown as Pick<LpdClient, 'detect'>;
    const disc = new PlateDiscovery({ camera, lpd, crop });
    const r = await disc.discoverSlot(target());
    expect(r.found).toBe(true);
    expect(r.tier).toBe('crop');
    expect(r.step).toBe(2);
    expect(r.confidence).toBe(0.77); // pick.confidence 전파
    expect(r.cropWindow).toEqual(windowAt(2));
    expectQuadClose(r.lpdOrig!, backmapQuad(cropPlate.quad, windowAt(2)));
  });

  it('크롭 창 안 2개 후보 → anchor(크롭 환산) 최근접 채택(이웃 배제)', async () => {
    const { camera } = makeCamera();
    const { crop } = makeCrop();
    // W1 중심 → anchor_in_crop = (0.5,0.5). near=중심, far=구석.
    const near = plate(0.5, 0.5, 0.05, 0.03, 0.6);
    const far = plate(0.1, 0.1, 0.05, 0.03, 0.99);
    const lpd = {
      detect: async (buf: Buffer) => (buf === frame ? [] : [far, near]),
    } as unknown as Pick<LpdClient, 'detect'>;
    const disc = new PlateDiscovery({ camera, lpd, crop });
    const r = await disc.discoverSlot(target());
    expect(r.found).toBe(true);
    expect(r.step).toBe(1);
    // conf 가 더 높은 far 가 아니라 anchor 최근접 near 를 채택.
    expect(r.confidence).toBe(0.6);
    expectQuadClose(r.lpdOrig!, backmapQuad(near.quad, windowAt(1)));
  });

  it('outLongPx = 원본 장변(1920)로 crop 호출', async () => {
    const { camera } = makeCamera();
    const { crop, calls } = makeCrop();
    const lpd = { detect: async () => [] } as unknown as Pick<LpdClient, 'detect'>;
    const disc = new PlateDiscovery({ camera, lpd, crop });
    await disc.discoverSlot(target());
    expect(calls[0].outLongPx).toBe(1920);
  });
});

describe('discoverSlot · 실패 경로(정직 리포트)', () => {
  it('full·crop 전부 미검출 → no_plate(tier:crop, step:maxSteps=30, lpdOrig=null) [V-9 maxSteps 30 갱신]', async () => {
    const { camera } = makeCamera();
    const { crop, calls } = makeCrop();
    const lpd = { detect: async () => [] } as unknown as Pick<LpdClient, 'detect'>;
    const disc = new PlateDiscovery({ camera, lpd, crop });
    const r = await disc.discoverSlot(target());
    expect(r.found).toBe(false);
    expect(r.reason).toBe('no_plate');
    expect(r.tier).toBe('crop');
    expect(r.step).toBe(30); // maxSteps 기본 5→30(격자 30칸: 5줌×6방)
    expect(r.lpdOrig).toBeNull();
    // 6방 개정으로 (0,1.0) '더아래' 오프셋이 제거되어 1920×1080 중앙앵커에서도 클램프 중복창이 사라졌다.
    // level5 frac=0.4·0.6^4≈0.05184 ≥ minFrac 0.05 → 30창 전부 고유·유효 → LPD 30회.
    expect(calls).toHaveLength(30);
  });

  it('anchor 부재 → no_anchor 즉시 반환(카메라 캡처조차 안 함)', async () => {
    const { camera, calls } = makeCamera();
    const { crop, calls: cropCalls } = makeCrop();
    const lpd = { detect: async () => [plate(0.5, 0.5)] } as unknown as Pick<LpdClient, 'detect'>;
    const disc = new PlateDiscovery({ camera, lpd, crop });
    const r = await disc.discoverSlot(target({ anchor: null }));
    expect(r.found).toBe(false);
    expect(r.reason).toBe('no_anchor');
    expect(r.tier).toBe('full');
    expect(r.step).toBe(0);
    expect(r.lpdOrig).toBeNull();
    expect(calls()).toBe(0); // requestImage 미호출
    expect(cropCalls).toHaveLength(0);
  });
});

/**
 * V-3~V-6: 2D 격자 탐색(설계서 §3-1·§3-2 개정판 = 6방·30칸). 정사각 프레임(aspect=1)으로 클램프 없이
 * 오프셋 순서를 창 중심으로 직접 검증한다(중앙앵커 0.5,0.5 · frac0 0.4 → k=1..6 창이 [0,1] 안, 클램프 미발동).
 */
const GRID_OFFSETS = [
  { dx: 0, dy: 0 }, // k1 중심
  { dx: 0, dy: 0.5 }, // k2 하
  { dx: -0.5, dy: 0.5 }, // k3 하좌
  { dx: 0.5, dy: 0.5 }, // k4 하우
  { dx: -0.5, dy: 0 }, // k5 좌
  { dx: 0.5, dy: 0 }, // k6 우
] as const;

describe('discoverSlot · V-3~V-6 2D 격자 탐색(정사각 프레임, 6방·30칸)', () => {
  const SQ = 1000; // 정사각 → aspect 1
  let sqFrame: Buffer;
  beforeAll(async () => {
    sqFrame = await sharp({ create: { width: SQ, height: SQ, channels: 3, background: { r: 10, g: 20, b: 30 } } })
      .jpeg().toBuffer();
  });

  /** aspect=1 정사각 프레임 카메라 스텁. */
  function sqCamera() {
    return {
      requestImage: async () => ({ camIdx: 1, presetIdx: 1, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: sqFrame }),
    } as unknown as Pick<ICameraClient, 'requestImage'>;
  }
  const sqWindowAt = (k: number, anchor = { x: 0.5, y: 0.5 }): NormalizedRect => {
    const level = Math.floor((k - 1) / 6) + 1;
    const frac = FRAC0 * SHRINK ** (level - 1);
    const off = GRID_OFFSETS[(k - 1) % 6];
    return computeCropWindow(gridCenter(anchor, frac, 1, off), frac, 1);
  };

  it('V-3 격자 순서: k=1..6 창 중심이 GRID_OFFSETS(중심→하→하좌→하우→좌→우), k=7 frac shrink 1회 축소', async () => {
    const camera = sqCamera();
    const { crop, calls } = makeCrop();
    const lpd = { detect: async () => [] } as unknown as Pick<LpdClient, 'detect'>; // 전부 미검출 → 30칸 순회
    const disc = new PlateDiscovery({ camera, lpd, crop });
    await disc.discoverSlot(target());
    // k=1..6 창 중심 = 앵커 + 오프셋·창크기(정사각이라 min(1,0.4)=0.4).
    const expCenters = [
      { x: 0.5, y: 0.5 }, // 중심
      { x: 0.5, y: 0.7 }, // 하 (+0.5·0.4)
      { x: 0.3, y: 0.7 }, // 하좌
      { x: 0.7, y: 0.7 }, // 하우
      { x: 0.3, y: 0.5 }, // 좌 (-0.5·0.4)
      { x: 0.7, y: 0.5 }, // 우 (+0.5·0.4)
    ];
    for (let k = 1; k <= 6; k++) {
      const W = calls[k - 1].W;
      expect(W.x + W.w / 2).toBeCloseTo(expCenters[k - 1].x, 9);
      expect(W.y + W.h / 2).toBeCloseTo(expCenters[k - 1].y, 9);
      expect(W.w).toBeCloseTo(0.4, 9); // level1 frac 유지
    }
    // k=7 → level2, frac = 0.4·0.6 = 0.24(창폭 축소). frac 축소 시점이 k=6→k=7 로 이동.
    expect(calls[6].W.w).toBeCloseTo(0.24, 9);
    expect(calls[6].W).toEqual(sqWindowAt(7));
  });

  it('V-4 30회 캡: 전 스텝 미검출 → crop ≤ 30회, step=30, no_plate(정사각은 중복없어 정확히 30)', async () => {
    const camera = sqCamera();
    const { crop, calls } = makeCrop();
    const lpd = { detect: async () => [] } as unknown as Pick<LpdClient, 'detect'>;
    const disc = new PlateDiscovery({ camera, lpd, crop });
    const r = await disc.discoverSlot(target());
    expect(calls.length).toBeLessThanOrEqual(30);
    expect(calls).toHaveLength(30); // 정사각 중앙앵커 → 30창 전부 고유(클램프 중복 없음)
    expect(r.found).toBe(false);
    expect(r.reason).toBe('no_plate');
    expect(r.step).toBe(30);
    expect(r.lpdOrig).toBeNull();
  });

  it('V-5 특정 오프셋 창(k=2 하)에만 번호판 → found step=2, lpdOrig=backmapQuad(W2) 일치', async () => {
    const camera = sqCamera();
    const { crop, calls } = makeCrop();
    const cropPlate = plate(0.55, 0.48, 0.08, 0.04, 0.82); // 크롭 정규화 좌표
    const lpd = {
      detect: async (buf: Buffer) => {
        if (buf === sqFrame) return []; // full 미검출
        return calls.length === 2 ? [cropPlate] : []; // 2번째 크롭(k=2)에서만 검출
      },
    } as unknown as Pick<LpdClient, 'detect'>;
    const disc = new PlateDiscovery({ camera, lpd, crop });
    const r = await disc.discoverSlot(target());
    expect(r.found).toBe(true);
    expect(r.tier).toBe('crop');
    expect(r.step).toBe(2);
    expect(r.confidence).toBe(0.82);
    expect(r.cropWindow).toEqual(sqWindowAt(2)); // k=2 하 오프셋 창
    // 역계산: 원본좌표 == backmapQuad(cropPlate, W2).
    expectQuadClose(r.lpdOrig!, backmapQuad(cropPlate.quad, sqWindowAt(2)));
  });

  it('V-6 중복창 스킵: 프레임 모서리 앵커 → 클램프 동일창 반복 → LPD 호출 수 < 30', async () => {
    const camera = sqCamera();
    const { crop, calls } = makeCrop();
    const lpd = { detect: async () => [] } as unknown as Pick<LpdClient, 'detect'>;
    const disc = new PlateDiscovery({ camera, lpd, crop });
    // 앵커(0.98,0.98): 하/하우/우 오프셋 창이 우하 모서리에 클램프 → 동일창 다수 → seen 스킵.
    const r = await disc.discoverSlot(target({ anchor: { x: 0.98, y: 0.98 } }));
    expect(calls.length).toBeLessThan(30); // 중복창 LPD 스킵으로 예산 절약(실측 고유창 10회)
    expect(r.step).toBe(30); // 격자 인덱스 k 는 30 까지 소비(상태전이 단순 유지)
    expect(r.reason).toBe('no_plate');
  });
});

/**
 * V-10: pickOwnedPlate 순수함수(설계 §9-3 Voronoi 소유권 게이트). center 는 원본 정규화 좌표.
 * candidate = { plate, centerOrig }. self 최근접이 모든 peer 보다 엄격히(<) 가까운 것만 소유.
 */
describe('pickOwnedPlate · V-10 Voronoi 소유권', () => {
  const cand = (cx: number, cy: number, conf = 0.9) => ({ plate: plate(cx, cy, 0.06, 0.03, conf), centerOrig: { x: cx, y: cy } });

  it('(a) 이웃 앵커가 더 가까운 후보 기각 → null', () => {
    const self = { x: 0.5, y: 0.5 };
    const peer = { x: 0.62, y: 0.5 };
    // 후보 center 0.60: dSelf=0.10, dPeer=0.02 → peer 소유 → 기각.
    expect(pickOwnedPlate([cand(0.60, 0.5)], self, [peer])).toBeNull();
  });

  it('(b) 자기소유(모든 peer 보다 가까움) 후보 채택', () => {
    const self = { x: 0.5, y: 0.5 };
    const peer = { x: 0.9, y: 0.5 };
    const r = pickOwnedPlate([cand(0.52, 0.5, 0.71)], self, [peer]);
    expect(r).not.toBeNull();
    expect(r!.confidence).toBe(0.71);
  });

  it('(c) 자기소유 다수 → self 최근접 1개(먼 소유후보·고conf 배제)', () => {
    const self = { x: 0.5, y: 0.5 };
    const peer = { x: 0.95, y: 0.5 };
    // 둘 다 self 소유(peer 매우 멂). 0.53(가까움,conf0.5) vs 0.60(멂,conf0.99) → 0.53 채택.
    const r = pickOwnedPlate([cand(0.60, 0.5, 0.99), cand(0.53, 0.5, 0.5)], self, [peer]);
    expect(r).not.toBeNull();
    expect(r!.confidence).toBe(0.5); // 최근접(고conf 아님)
  });

  it('(d) 동률(dSelf==dPeer) → 기각(엄격 부등호 <)', () => {
    const self = { x: 0.4, y: 0.5 };
    const peer = { x: 0.6, y: 0.5 };
    // center 0.5: dSelf==dPeer==0.1 → dSelf<dPeer 불성립 → 기각.
    expect(pickOwnedPlate([cand(0.5, 0.5)], self, [peer])).toBeNull();
  });

  it('(e) peerAnchors=[] → 무조건 통과(self 최근접 반환)', () => {
    const self = { x: 0.5, y: 0.5 };
    const r = pickOwnedPlate([cand(0.9, 0.5, 0.4), cand(0.55, 0.5, 0.6)], self, []);
    expect(r).not.toBeNull();
    expect(r!.confidence).toBe(0.6); // 최근접 0.55
  });
});

describe('discoverSlot · V-11 절도 재현 회귀(05_live_finding slot8) + V-12 크롭 소유권', () => {
  it('V-11 Tier0 에 이웃 판만(자기 반경 0.15 이내지만 peer 최근접) → full 기각·격자 진입 → 자기판 크롭검출(step≥1)', async () => {
    const { camera } = makeCamera();
    const { crop, calls } = makeCrop();
    const selfAnchor = { x: 0.5, y: 0.5 };
    const peerAnchor = { x: 0.62, y: 0.5 }; // 간격 0.12 < matchRadius 0.15(절도 조건)
    // full-frame 이웃 판 center 0.60: dSelf=0.10(≤0.15, 예전엔 절도 채택) / dPeer=0.02 → 소유권 기각.
    const neighbor = plate(0.60, 0.5, 0.06, 0.03, 0.95);
    // 크롭(W1 중심=selfAnchor)에서 자기 판: 크롭중심(0.5,0.5) → 원본 0.5,0.5 = selfAnchor 소유.
    const selfCrop = plate(0.5, 0.5, 0.06, 0.03, 0.6);
    const lpd = {
      detect: async (buf: Buffer) => (buf === frame ? [neighbor] : [selfCrop]),
    } as unknown as Pick<LpdClient, 'detect'>;
    const disc = new PlateDiscovery({ camera, lpd, crop });
    const r = await disc.discoverSlot(target({ anchor: selfAnchor }), undefined, [peerAnchor]);
    expect(r.found).toBe(true);
    expect(r.tier).toBe('crop'); // full 아님 — 절도 위장(step0 full) 차단
    expect(r.step).toBeGreaterThanOrEqual(1);
    expect(r.step).toBe(1); // 첫 크롭(k=1, off 중심)에서 자기판 소유 채택
    expect(calls.length).toBeGreaterThanOrEqual(1); // 격자 진입(예전엔 full/step0 위장 → 크롭 0회)
    expectQuadClose(r.lpdOrig!, backmapQuad(selfCrop.quad, windowAt(1, selfAnchor)));
  });

  it('V-12 크롭 창에 자기판+이웃판 공존 → 원본좌표 환산·소유권으로 자기판 채택(이웃 고conf 무시)', async () => {
    const { camera } = makeCamera();
    const { crop } = makeCrop();
    const selfAnchor = { x: 0.5, y: 0.5 };
    const peerAnchor = { x: 0.62, y: 0.5 };
    const W1 = windowAt(1, selfAnchor); // {x:0.3,y:0.1444,w:0.4,h:0.711}
    // 자기판: 원본 0.5,0.5(=selfAnchor 소유) → 크롭좌표 = toCropPoint.
    const selfCropX = (0.5 - W1.x) / W1.w; // 0.5
    const selfCropY = (0.5 - W1.y) / W1.h; // 0.5
    const self = plate(selfCropX, selfCropY, 0.05, 0.03, 0.5);
    // 이웃판: 원본 0.60,0.5(peer 0.62 소유) → 크롭좌표 환산. 고conf 라도 소유권 기각돼야 함.
    const nbCropX = (0.60 - W1.x) / W1.w; // 0.75
    const nbCropY = (0.5 - W1.y) / W1.h; // 0.5
    const neighbor = plate(nbCropX, nbCropY, 0.05, 0.03, 0.99);
    const lpd = {
      detect: async (buf: Buffer) => (buf === frame ? [] : [neighbor, self]),
    } as unknown as Pick<LpdClient, 'detect'>;
    const disc = new PlateDiscovery({ camera, lpd, crop });
    const r = await disc.discoverSlot(target({ anchor: selfAnchor }), undefined, [peerAnchor]);
    expect(r.found).toBe(true);
    expect(r.step).toBe(1);
    expect(r.confidence).toBe(0.5); // 자기판(이웃 0.99 아님)
    expectQuadClose(r.lpdOrig!, backmapQuad(self.quad, W1));
  });
});
