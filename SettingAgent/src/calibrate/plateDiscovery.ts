// 앞면중심 기준 번호판 탐색·확대반복·역계산 루프(설계서 §3, Phase 1 코어).
// 디지털 크롭-줌 tier 전용 — 카메라 무이동(원본 프레임 재사용). 광학 PTZ tier(2차)는 후속(미구현).
//
// PlatePtz(폐루프 광학 도구)와 성격이 다르므로 별도 얇은 루프다(설계서 §3-2). 재사용:
//   pickNearestPlate(controlMath) · cropZoom(computeCropWindow/toCropPoint/backmapQuad/cropAndUpscale).
// camera/lpd/crop 은 주입(DI) — 순수 상태전이 단위테스트 가능(설계서 §7 T-4).
//
// 결정론(LLM 미사용): Tier0 원본 전체 → anchor 최근접(matchRadius 게이트) → 실패 시
//   Tier1 크롭 축소반복(frac0·shrink^(k-1)) → 검출 시 아핀 역계산 → 원본 좌표 OBB.

import type { ICameraClient } from '../clients/CameraClient.js';
import type { LpdClient, PlateBox } from '../clients/LpdClient.js';
import type { NormalizedPoint, NormalizedRect } from '../domain/types.js';
import { quadBoundingRect } from '../domain/geometry.js';
import { readJpegSize } from '../util/jpeg.js';
import { computeCropWindow, backmapQuad, cropAndUpscale, gridCenter } from './cropZoom.js';
import type { DiscoveryTarget, PlateDiscoveryItem, Ptz } from './types.js';

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 격자 오프셋 6방(설계서 §3-1 개정판) — 하향 우선(원인1 보정 방향). 단위 = 창 크기 배수(gridCenter).
 * 중심→하→하좌→하우→좌→우. 하향앵커 적용으로 (0,1.0) 과이동 제거, 순수 좌/우 추가.
 * 0.5배=인접창 50% 겹침(경계 번호판 누락 방지). 줌 5레벨 × 6방 = 30칸.
 */
const GRID_OFFSETS = [
  { dx: 0, dy: 0 }, // 1. 중심(하향앵커)
  { dx: 0, dy: 0.5 }, // 2. 하
  { dx: -0.5, dy: 0.5 }, // 3. 하좌
  { dx: 0.5, dy: 0.5 }, // 4. 하우
  { dx: -0.5, dy: 0 }, // 5. 좌
  { dx: 0.5, dy: 0 }, // 6. 우
] as const;

/** crop IO 시임(테스트는 sharp 없이 stub). 기본 = cropAndUpscale. */
export type CropFn = (jpeg: Buffer, W: NormalizedRect, outLongPx: number) => Promise<Buffer>;

export interface PlateDiscoveryDeps {
  camera: Pick<ICameraClient, 'requestImage'>;
  lpd: Pick<LpdClient, 'detect'>;
  crop?: CropFn;
  sleep?: (ms: number) => Promise<void>;
  /** 매 캡처 직후 원본 프레임 JPEG 관찰 훅(가산·옵셔널 — 뷰어 /discover/frame). */
  onFrame?: (jpeg: Buffer, camIdx: number, presetIdx: number) => void;
}

/** 전부 옵셔널. 기본값 = 설계서 §3-3 상수(눈대중 초기값 — QA 미세조정 대상). config 스키마 확장 없음. */
export interface PlateDiscoveryOpts {
  frac0?: number; // 0.40 — 초기 창 폭 비율
  shrink?: number; // 0.6 — 스텝 축소비
  minFrac?: number; // 0.05 — 최소 창 폭
  maxSteps?: number; // 30 — = 격자 30칸(5줌×6방)
  outLongPx?: number; // 미지정 시 원본 장변(프레임에서 산출)
  matchRadiusNorm?: number; // 0.15 — full tier 앞면중심 게이트
  settleMs?: number; // 0 — 크롭은 무이동이라 정착 불요(기본 0)
}

interface ResolvedOpts {
  frac0: number;
  shrink: number;
  minFrac: number;
  maxSteps: number;
  outLongPx?: number;
  matchRadiusNorm: number;
  settleMs: number;
}

const centerOf = (p: PlateBox): NormalizedPoint => {
  const r = quadBoundingRect(p.quad);
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
};

/**
 * Voronoi 배타성 게이트(설계서 §9-3): 검출 후보 중 **자기 앵커가 모든 peer 앵커보다 엄격히 최근접**인
 * 것만 자기 소유로 남기고, 그 중 자기 앵커 최근접 1개 반환(없으면 null). 옆판 절도(위장 found) 차단.
 * 동률(dSelf < dPeer 불성립)이면 기각 — 결정적·중복청구 불가. peerAnchors=[] 이면 전원 통과(기존 최근접 동작).
 * 비교 좌표계는 **항상 원본 프레임 정규화**(크롭 좌표 직접 비교 금지 — w/h 비등방 왜곡). centerOrig 는 호출측이 환산.
 */
export function pickOwnedPlate(
  candidates: Array<{ plate: PlateBox; centerOrig: NormalizedPoint }>,
  selfAnchor: NormalizedPoint,
  peerAnchors: readonly NormalizedPoint[],
): PlateBox | null {
  let best: { plate: PlateBox; d: number } | null = null;
  for (const cand of candidates) {
    const c = cand.centerOrig;
    const dSelf = Math.hypot(c.x - selfAnchor.x, c.y - selfAnchor.y);
    let owned = true;
    for (const peer of peerAnchors) {
      if (!(dSelf < Math.hypot(c.x - peer.x, c.y - peer.y))) {
        owned = false;
        break;
      }
    }
    if (!owned) continue;
    if (best === null || dSelf < best.d) best = { plate: cand.plate, d: dSelf };
  }
  return best ? best.plate : null;
}

/**
 * 슬롯 앞면중심 기준 번호판 디지털 탐색 루프(무상태 — 호출마다 독립).
 * 전송 계층 오류(CameraApiError·LpdApiError)는 삼키지 않고 전파(재시도는 클라이언트 소유).
 * 검출 소실은 이 도메인의 정상 결과 → found:false + reason 반환(위장 성공 금지).
 */
export class PlateDiscovery {
  private readonly camera: Pick<ICameraClient, 'requestImage'>;
  private readonly lpd: Pick<LpdClient, 'detect'>;
  private readonly crop: CropFn;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onFrame?: (jpeg: Buffer, camIdx: number, presetIdx: number) => void;
  private readonly o: ResolvedOpts;

  constructor(deps: PlateDiscoveryDeps, opts: PlateDiscoveryOpts = {}) {
    this.camera = deps.camera;
    this.lpd = deps.lpd;
    this.crop = deps.crop ?? cropAndUpscale;
    this.sleep = deps.sleep ?? defaultSleep;
    this.onFrame = deps.onFrame;
    this.o = {
      frac0: opts.frac0 ?? 0.4,
      shrink: opts.shrink ?? 0.6,
      minFrac: opts.minFrac ?? 0.05,
      maxSteps: opts.maxSteps ?? 30, // = 격자 30칸(5줌×6방)
      ...(opts.outLongPx !== undefined ? { outLongPx: opts.outLongPx } : {}),
      matchRadiusNorm: opts.matchRadiusNorm ?? 0.15,
      settleMs: opts.settleMs ?? 0,
    };
  }

  /**
   * 슬롯 1건 탐색(설계서 §3-1 상태전이).
   * @param presetPtz 원본 프레임 캡처용 프리셋 PTZ(시뮬 echo 불신 — 호출측이 resolvePresetPtz 로 해결).
   * @param peerAnchors 동일 프리셋 타 슬롯 하향앵커들(배타성 게이트 §9). 기본 [] = 소유권 무조건 통과(하위호환).
   */
  async discoverSlot(t: DiscoveryTarget, presetPtz?: Ptz | null, peerAnchors: NormalizedPoint[] = []): Promise<PlateDiscoveryItem> {
    const base = { camIdx: t.camIdx, presetIdx: t.presetIdx, slotId: t.slotId, globalIdx: t.globalIdx };
    if (!t.anchor) {
      return { ...base, found: false, lpdOrig: null, tier: 'full', step: 0, confidence: 0, reason: 'no_anchor' };
    }
    const anchor = t.anchor;

    // 원본(프리셋) 프레임 1회 캡처(카메라 무이동 — 이후 tier 는 이 프레임을 크롭 재사용).
    const cap = await this.camera.requestImage(t.camIdx, t.presetIdx, presetPtz ?? undefined);
    const frame = cap.jpg;
    this.onFrame?.(frame, t.camIdx, t.presetIdx);
    if (this.o.settleMs > 0) await this.sleep(this.o.settleMs);
    const { width: imgW, height: imgH } = readJpegSize(frame);
    const aspect = imgW / imgH;
    const outLongPx = this.o.outLongPx ?? Math.max(imgW, imgH);

    // Tier 0 (full): 원본 전체 LPD → 소유권(§9-3) 통과 후보 + matchRadius 게이트 병행 → 둘 다면 역계산 불요.
    const fullPlates = await this.lpd.detect(frame);
    const fullCands = fullPlates.map((p) => ({ plate: p, centerOrig: centerOf(p) }));
    const full = pickOwnedPlate(fullCands, anchor, peerAnchors);
    if (full) {
      const c = centerOf(full);
      if (Math.hypot(c.x - anchor.x, c.y - anchor.y) <= this.o.matchRadiusNorm) {
        return { ...base, found: true, lpdOrig: full.quad, tier: 'full', step: 0, confidence: full.confidence };
      }
    }

    // Tier 1 (grid): 줌 5레벨 × 오프셋 6방 격자 순회(설계서 §3-2 개정판) — 하향앵커 중심에서 사방 이동·축소.
    // level = floor((k-1)/6)+1 로 6칸마다 frac 을 shrink 1회 축소. 첫 검출 시 즉시 아핀 역계산 반환.
    const seen = new Set<string>();
    for (let k = 1; k <= this.o.maxSteps; k++) {
      const level = Math.floor((k - 1) / 6) + 1;
      const frac = this.o.frac0 * this.o.shrink ** (level - 1);
      if (frac < this.o.minFrac) break;
      const off = GRID_OFFSETS[(k - 1) % 6];
      const c = gridCenter(anchor, frac, aspect, off);
      const W = computeCropWindow(c, frac, aspect);
      const key = `${W.x},${W.y},${W.w},${W.h}`;
      if (seen.has(key)) continue; // 클램프 중복창 — LPD 스킵(k 는 계속 증가해 예산 절약).
      seen.add(key);
      const cropJpeg = await this.crop(frame, W, outLongPx);
      const plates = await this.lpd.detect(cropJpeg);
      // 크롭 정규화 중심을 원본 프레임 좌표로 아핀 환산(= backmapQuad 점 버전) 후 소유권 판정(§9-3).
      const cands = plates.map((p) => {
        const cc = centerOf(p);
        return { plate: p, centerOrig: { x: W.x + cc.x * W.w, y: W.y + cc.y * W.h } };
      });
      const pick = pickOwnedPlate(cands, anchor, peerAnchors);
      if (pick) {
        return {
          ...base,
          found: true,
          lpdOrig: backmapQuad(pick.quad, W), // §2-1 아핀 역계산 → 원본 좌표.
          tier: 'crop',
          step: k,
          cropWindow: W,
          confidence: pick.confidence,
        };
      }
    }

    // 디지털 tier 소진 — 정직 리포트(광학 tier 후속).
    return { ...base, found: false, lpdOrig: null, tier: 'crop', step: this.o.maxSteps, confidence: 0, reason: 'no_plate' };
  }
}
