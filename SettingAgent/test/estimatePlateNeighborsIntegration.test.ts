import { describe, it, expect } from 'vitest';
import {
  estimatePlateQuadFromNeighbors,
  buildPlateAnchoredQuad,
  resolveFloorPolygon,
  type PlateNeighbor,
} from '../src/capture/floorRoi.js';
import { Finalizer } from '../src/capture/Finalizer.js';
import { plateAngleRad } from '../src/domain/geometry.js';
import type { Repository } from '../src/store/Repository.js';
import type { SqliteStore } from '../src/capture/SqliteStore.js';
import type { DetectionRow } from '../src/capture/types.js';
import type { CaptureSnapshot } from '../src/capture/CaptureJob.js';
import type {
  SetupArtifact,
  NormalizedRect,
  NormalizedPolygon,
  NormalizedQuad,
  NormalizedPoint,
} from '../src/domain/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

/**
 * 검증자(qa-tester) 보강분: estimatePlateQuadFromNeighbors 의 계획 §9 불변식 중
 * 구현자 유닛(estimatePlateFromNeighbors.test.ts)이 덮지 못한 부분을 보강한다.
 *  - 불변식1 end-to-end: estimate → buildPlateAnchoredQuad/resolveFloorPolygon 앞변 각도 ≈ θ.
 *  - 불변식4: 유효 이웃 0개 → 하류 결과가 상수(predictPlateRect·θ=0) 폴백과 **바이트 동일**.
 *  - 불변식3(하드닝): 여러 이웃에서 최근접 argmin(입력 순서 무관) 채택.
 *  - 불변식5(게이트2): 실측 plateQuad 존재 시 추정 미적용(실측 우선) — Finalizer 통합.
 *  - 불변식6(게이트3): plate 부재 슬롯이 추정 quad 로 floor ROI 각도를 추종하되,
 *    slot.plateRoiByPreset 은 저장되지 않고(예상 quad 미저장) deconflict 에도 미주입 — Finalizer 통합.
 *
 * ★ DB 스키마 개편 후 재작성(Finalizer 통합부만): 구 store.createRun/insertObservation/insertDetections
 *   + finalize(runId) 경로 폐기 — 인메모리 CaptureSnapshot({dets, presetRounds, aggregated, occByPreset})
 *   을 직접 구성해 finalizer.finalize(snapshot) 을 호출한다(설계서 §2.3). Finalizer 는 snapshot.dets/
 *   presetRounds 로 자체 재집계하므로 snapshot.aggregated 는 이 테스트에서 빈 배열로 충분하다
 *   (보존할 체크포인트 status 이력이 없음). placeRoiFile 미주입 → slot_setup 저장 분기 미실행 →
 *   FinalizerDeps.store 는 미사용(최소 fake 로 대체, 실 DB 불필요).
 */

// ── 앞변 각도 헬퍼(plateAnchoredQuadInvariants.test.ts 와 동일 규약) ─────────
function axes(theta: number): { nb: NormalizedPoint; u: NormalizedPoint } {
  let nb = { x: Math.sin(theta), y: -Math.cos(theta) };
  if (nb.y > 0) nb = { x: -nb.x, y: -nb.y };
  return { nb, u: { x: -nb.y, y: nb.x } };
}
const dot = (p: NormalizedPoint, a: NormalizedPoint) => p.x * a.x + p.y * a.y;
function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
/** floor 다각형 앞변(nb 투영 최소 두 정점) 방향각. 좌→우 정규화. */
function frontEdgeAngle(q: NormalizedPolygon, theta: number): number {
  const { nb } = axes(theta);
  const idx = [0, 1, 2, 3].sort((a, b) => dot(q[a], nb) - dot(q[b], nb));
  const [f0, f1] = [idx[0], idx[1]];
  let dir = { x: q[f1].x - q[f0].x, y: q[f1].y - q[f0].y };
  if (dir.x < 0) dir = { x: -dir.x, y: -dir.y };
  return Math.atan2(dir.y, dir.x);
}
const DEG3 = (3 * Math.PI) / 180;

/** 중심 (cx,cy), 반폭/반높이, phi(rad) 회전 OBB quad(TL,TR,BR,BL, y-down). */
function rotatedPlateQuad(cx: number, cy: number, hw: number, hh: number, phi: number): NormalizedQuad {
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  const rot = (x: number, y: number): NormalizedPoint => ({ x: cx + x * c - y * s, y: cy + x * s + y * c });
  return [rot(-hw, -hh), rot(hw, -hh), rot(hw, hh), rot(-hw, hh)];
}
function neighbor(vehicle: NormalizedRect, frac: { rx: number; ry: number }, plate: { hw: number; hh: number; deg: number }): PlateNeighbor {
  const pc = { x: vehicle.x + frac.rx * vehicle.w, y: vehicle.y + frac.ry * vehicle.h };
  return { vehicle, plateQuad: rotatedPlateQuad(pc.x, pc.y, plate.hw, plate.hh, (plate.deg * Math.PI) / 180) };
}

// ── 1. 순수 경로: estimate → 빌더/리졸버 앞변 각도 추종(불변식1 end-to-end) ─────
describe('estimate → floor ROI 앞변 각도 추종(불변식1 end-to-end)', () => {
  const target: NormalizedRect = { x: 0.6, y: 0.4, w: 0.2, h: 0.2 };

  it('buildPlateAnchoredQuad(target, estimate) 앞변 각도 ≈ 이웃 θ(≤3°)', () => {
    for (const deg of [0, 12, 22, -18]) {
      const nb = neighbor({ x: 0.2, y: 0.4, w: 0.2, h: 0.2 }, { rx: 0.5, ry: 0.72 }, { hw: 0.05, hh: 0.02, deg });
      const est = estimatePlateQuadFromNeighbors(target, [nb])!;
      const floor = buildPlateAnchoredQuad(target, est);
      const theta = (deg * Math.PI) / 180;
      expect(Math.abs(angleDiff(frontEdgeAngle(floor, theta), theta))).toBeLessThanOrEqual(DEG3);
    }
  });

  it('resolveFloorPolygon(null, target, estimate) 도 동일 각도 추종(≤3°)', () => {
    const deg = 20;
    const nb = neighbor({ x: 0.2, y: 0.4, w: 0.2, h: 0.2 }, { rx: 0.5, ry: 0.72 }, { hw: 0.05, hh: 0.02, deg });
    const est = estimatePlateQuadFromNeighbors(target, [nb])!;
    const poly = resolveFloorPolygon(null, target, est) as NormalizedQuad;
    const theta = (deg * Math.PI) / 180;
    expect(Math.abs(angleDiff(frontEdgeAngle(poly, theta), theta))).toBeLessThanOrEqual(DEG3);
  });
});

// ── 2. 유효 이웃 0개 → 상수 폴백 바이트 동일(불변식4) ─────────────────────
describe('유효 이웃 0개 → 상수(predictPlateRect·θ=0) 폴백 바이트 동일(불변식4)', () => {
  const v: NormalizedRect = { x: 0.6, y: 0.4, w: 0.2, h: 0.2 };

  it('빈 이웃/전부 degenerate → estimate=undefined → 빌더 결과가 상수경로와 동일', () => {
    const constFloor = buildPlateAnchoredQuad(v, undefined);
    // 빈 배열
    const est0 = estimatePlateQuadFromNeighbors(v, []);
    expect(est0).toBeUndefined();
    expect(buildPlateAnchoredQuad(v, est0 ?? undefined)).toEqual(constFloor);
    // 전부 degenerate(w/h≈0)
    const degens: PlateNeighbor[] = [
      { vehicle: { x: 0.2, y: 0.4, w: 0, h: 0.2 }, plateQuad: rotatedPlateQuad(0.25, 0.55, 0.05, 0.02, 0.3) },
      { vehicle: { x: 0.3, y: 0.4, w: 0.2, h: 0 }, plateQuad: rotatedPlateQuad(0.35, 0.55, 0.05, 0.02, 0.3) },
    ];
    const estD = estimatePlateQuadFromNeighbors(v, degens);
    expect(estD).toBeUndefined();
    expect(buildPlateAnchoredQuad(v, estD ?? undefined)).toEqual(constFloor);
  });

  it('resolveFloorPolygon 도 estimate=undefined 시 상수경로와 동일', () => {
    const constPoly = resolveFloorPolygon(null, v, undefined, undefined);
    const est = estimatePlateQuadFromNeighbors(v, []);
    expect(resolveFloorPolygon(null, v, est, undefined)).toEqual(constPoly);
  });
});

// ── 3. 최근접 argmin(입력 순서 무관) 하드닝(불변식3) ─────────────────────
describe('최근접 선택 argmin — 입력 순서 무관(불변식3 하드닝)', () => {
  const target: NormalizedRect = { x: 0.6, y: 0.4, w: 0.2, h: 0.2 }; // 중심(0.7,0.5)

  it('3 이웃 중 중간 배치가 최근접이면 그 각도 채택(첫/끝 요소 아님)', () => {
    const far1 = neighbor({ x: 0.0, y: 0.0, w: 0.2, h: 0.2 }, { rx: 0.5, ry: 0.7 }, { hw: 0.05, hh: 0.02, deg: 40 });
    const nearMid = neighbor({ x: 0.45, y: 0.4, w: 0.2, h: 0.2 }, { rx: 0.5, ry: 0.7 }, { hw: 0.05, hh: 0.02, deg: 7 }); // 중심(0.55,0.5) 최근접
    const far2 = neighbor({ x: 0.9, y: 0.9, w: 0.2, h: 0.2 }, { rx: 0.5, ry: 0.7 }, { hw: 0.05, hh: 0.02, deg: -35 });
    for (const order of [[far1, nearMid, far2], [nearMid, far1, far2], [far2, far1, nearMid]]) {
      const est = estimatePlateQuadFromNeighbors(target, order)!;
      expect(plateAngleRad(est)).toBeCloseTo((7 * Math.PI) / 180, 4);
    }
  });
});

// ── 4. Finalizer 통합: 게이트2·게이트3(불변식5·6) ─────────────────────────
const captureCfg: ToolsConfig['capture'] = {
  defaultCount: 50, intervalMs: 1000, moveIntervalMs: 1000, checkpointEvery: 10,
  checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, dbFile: ':memory:',
  clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5, slotAssignGate: 0.12, moveBeforeCapture: true,
};
const fakeRepo = (): { repo: Repository; saved: SetupArtifact[] } => {
  const saved: SetupArtifact[] = [];
  return { saved, repo: { saveArtifact: (a: SetupArtifact) => saved.push(a), loadArtifact: () => saved.at(-1) ?? null, path: 'mem' } as unknown as Repository };
};
/** placeRoiFile 미주입 → Finalizer 의 slot_setup 저장 분기가 미실행 → store 미사용(최소 fake). */
const fakeStore = {} as unknown as SqliteStore;

const boundingRect = (q: NormalizedQuad): NormalizedRect => {
  const xs = q.map((p) => p.x);
  const ys = q.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
};

/**
 * 같은 프리셋(1:1)에 2개 차량 클러스터를 인메모리 DetectionRow[] 로 직접 구성한다(구 SQLite 관측/검출
 * 적재 대체 — 설계서 §2.2). 좌측(x≈0.15)은 옵션 plate(quad), 우측(x≈0.65)은 옵션 plate(quad).
 * 서로 clusterDist(0.06) 밖이라 별 클러스터, 각 support=3(round 1~3 × vehicle 1건).
 */
function seedTwoSlots(leftPlate?: NormalizedQuad, rightPlate?: NormalizedQuad): CaptureSnapshot {
  const lv = { x: 0.15, y: 0.4, w: 0.1, h: 0.1 };
  const rv = { x: 0.65, y: 0.4, w: 0.1, h: 0.1 };
  const dets: DetectionRow[] = [];
  let obsSeq = 0;
  for (const round of [1, 2, 3]) {
    const obsId = ++obsSeq;
    dets.push({ observationId: obsId, roundIdx: round, camIdx: 1, presetIdx: 1, kind: 'vehicle', x: lv.x, y: lv.y, w: lv.w, h: lv.h, conf: 0.9 });
    dets.push({ observationId: obsId, roundIdx: round, camIdx: 1, presetIdx: 1, kind: 'vehicle', x: rv.x, y: rv.y, w: rv.w, h: rv.h, conf: 0.9 });
    if (leftPlate) {
      const r = boundingRect(leftPlate);
      dets.push({ observationId: obsId, roundIdx: round, camIdx: 1, presetIdx: 1, kind: 'plate', x: r.x, y: r.y, w: r.w, h: r.h, conf: 0.9, quad: leftPlate });
    }
    if (rightPlate) {
      const r = boundingRect(rightPlate);
      dets.push({ observationId: obsId, roundIdx: round, camIdx: 1, presetIdx: 1, kind: 'plate', x: r.x, y: r.y, w: r.w, h: r.h, conf: 0.9, quad: rightPlate });
    }
  }
  // Finalizer 가 fresh 재집계(aggregate(dets, presetRounds, ...)) 하므로 aggregated 는 빈 배열로 충분
  // (보존할 체크포인트 status 이력 없음) — occByPreset 도 이 테스트 무관(빈 맵).
  return { dets, presetRounds: new Map([['1:1', 3]]), aggregated: [], occByPreset: new Map() };
}

async function runFinalize(snapshot: CaptureSnapshot): Promise<SetupArtifact> {
  const { repo } = fakeRepo();
  const finalizer = new Finalizer({ store: fakeStore, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
  const r = await finalizer.finalize(snapshot);
  return r.artifact;
}

describe('Finalizer 통합 — 게이트2(실측 우선)·게이트3(예상 quad 미저장)(불변식5·6)', () => {
  /** slotId 로 슬롯 찾기(좌측 c1p1s1, 우측 c1p1s2 — orderByPosition x 오름차순). */
  const bySlot = (a: SetupArtifact, id: string) => a.slots.find((s) => s.slotId === id)!;

  it('게이트6: plate 부재 슬롯 → floor ROI 각도는 이웃 θ 추종, plateRoiByPreset 은 미저장', async () => {
    // 우측(neighbor)만 25° plate 보유, 좌측(target)은 plate 완전 부재.
    const rightPlate = rotatedPlateQuad(0.70, 0.45, 0.03, 0.015, (25 * Math.PI) / 180);
    const snapshot = seedTwoSlots(undefined, rightPlate);
    const art = await runFinalize(snapshot);

    const left = bySlot(art, 'c1p1s1'); // plate 부재 target
    const right = bySlot(art, 'c1p1s2'); // plate 보유 neighbor
    // 게이트3: 예상 quad 는 plateRoiByPreset 에 저장되지 않는다(실측만).
    expect(left.plateRoiByPreset).toBeUndefined();
    // 실측 보유 이웃은 정상 저장(대조).
    expect(right.plateRoiByPreset).toBeDefined();
    // floor ROI 각도는 이웃(25°) 추종.
    const theta = (25 * Math.PI) / 180;
    const floor = left.floorRoiByPreset!['1:1'] as NormalizedQuad;
    expect(Math.abs(angleDiff(frontEdgeAngle(floor, theta), theta))).toBeLessThanOrEqual(DEG3);
    // 이웃이 아니었다면(각도 0) 벗어났을 것 — 추정이 실제로 각도를 바꿨음을 대조로 확인.
    expect(Math.abs(frontEdgeAngle(floor, theta))).toBeGreaterThan(DEG3);
  });

  it('대조(불변식4): 이웃도 plate 부재면 target floor ROI 는 상수(θ=0) 폴백', async () => {
    const snapshot = seedTwoSlots(undefined, undefined); // 둘 다 plate 부재
    const art = await runFinalize(snapshot);
    const left = bySlot(art, 'c1p1s1');
    // 각도 0(축정렬) — 앞변 수평 ≤3°.
    const floor = left.floorRoiByPreset!['1:1'] as NormalizedQuad;
    expect(Math.abs(frontEdgeAngle(floor, 0))).toBeLessThanOrEqual(DEG3);
    expect(left.plateRoiByPreset).toBeUndefined();
  });

  it('게이트2(실측 우선): target 이 자기 plate(0°) 보유 시 이웃(40°) 무시하고 실측 각도 사용', async () => {
    // 좌측 target: 자기 plate 축정렬(0°). 우측 neighbor: 40°.
    const leftPlate = rotatedPlateQuad(0.20, 0.45, 0.03, 0.015, 0);
    const rightPlate = rotatedPlateQuad(0.70, 0.45, 0.03, 0.015, (40 * Math.PI) / 180);
    const snapshot = seedTwoSlots(leftPlate, rightPlate);
    const art = await runFinalize(snapshot);
    const left = bySlot(art, 'c1p1s1');
    const floor = left.floorRoiByPreset!['1:1'] as NormalizedQuad;
    // 실측 0° 사용 → 앞변 수평(≤3°), 이웃 40° 에 끌려가지 않음.
    expect(Math.abs(frontEdgeAngle(floor, 0))).toBeLessThanOrEqual(DEG3);
    // 실측 plate 보유 → plateRoiByPreset 저장.
    expect(left.plateRoiByPreset).toBeDefined();
  });
});
