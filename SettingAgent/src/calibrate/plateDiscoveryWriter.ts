// plate_discovery.json 펼침·쓰기(slotPtzWriter 패턴 미러). Repository 비오염 — 별도 writer.
// 디스커버리 대상은 slot_setup 에서 slot3d_front_center(앞면중심) 보유 슬롯을 펼친다(검출 무관).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SlotSetupView } from '../capture/types.js';
import type { NormalizedPoint } from '../domain/types.js';
import { stringify5 } from '../util/round.js';
import type { DiscoveryTarget, PlateDiscoveryArtifact } from './types.js';

const PLATE_H = 0.4; // 번호판 지상 실높이(m) 초기값 — goal/loop 미달 시 1순위 튜닝 노브(0.3~0.5).
// H_CONST: 육면체 높이(m). Finalizer.ts:41 과 동일값 — private 이라 import 불가, 값 변경 시 양쪽 동기 필요(주석 봉인).
const H_CONST = 1.5;
/** roi(바닥 quad) 4모서리 edge — 코너 순서 규약(project.ts BOTTOM_EDGES 동일). */
const BOTTOM_EDGES: readonly (readonly [number, number])[] = [[0, 1], [1, 2], [2, 3], [3, 0]];

/**
 * discovery 앵커를 앞면중심(h=0.75 등가)에서 번호판 높이(plateH)로 하향(설계서 §2). 픽셀은 h 에 선형이라
 * 앞 edge 중점 B(h=0)과 frontCenter F 의 선형보간이 재투영과 항등(§2-1).
 * 앞 edge = roi 4 edge 중 두 끝점 y평균 최대(project.ts frontFaceCornerIdx 동일 판정 — 하향틸트서 y 큰 쪽이 앞).
 * roi 길이≠4 또는 비유한 좌표 → frontCenter 그대로 폴백(throw 금지).
 */
export function lowerFrontAnchor(roi: NormalizedPoint[], frontCenter: NormalizedPoint, plateH = PLATE_H): NormalizedPoint {
  if (roi.length !== 4 || !roi.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))) return frontCenter;
  let best: readonly [number, number] = BOTTOM_EDGES[0];
  let bestVal = -Infinity;
  for (const [a, b] of BOTTOM_EDGES) {
    const avg = (roi[a].y + roi[b].y) / 2;
    if (avg > bestVal) {
      bestVal = avg;
      best = [a, b];
    }
  }
  const [a, b] = best;
  const B = { x: (roi[a].x + roi[b].x) / 2, y: (roi[a].y + roi[b].y) / 2 }; // 앞 edge 중점 = h=0.
  const t = plateH / (H_CONST / 2); // 0.4/0.75 ≈ 0.5333 — F(h=0.75)까지 선형보간.
  return { x: B.x + (frontCenter.x - B.x) * t, y: B.y + (frontCenter.y - B.y) * t };
}

/**
 * slot_setup → 디스커버리 대상 펼침. slot3d_front_center(앞면중심) 보유 슬롯만 1 항목씩.
 * ★ 센터라이징 펼침(lpd 보유분)과 달리 **검출 무관** — 앞면중심은 기하 산출이라 미검출 슬롯도 대상.
 * globalIdx = 정수 slot_id(항상 존재), presetSlotIdx 는 DB preset_slotidx 그대로(재계산 금지).
 */
export function expandDiscoveryTargets(views: SlotSetupView[]): DiscoveryTarget[] {
  const targets: DiscoveryTarget[] = [];
  for (const v of views) {
    if (v.slot3dFrontCenter == null) continue;
    targets.push({
      camIdx: v.camId,
      presetIdx: v.presetId,
      slotId: String(v.slotId),
      globalIdx: v.slotId,
      anchor: lowerFrontAnchor(v.roi, v.slot3dFrontCenter),
      presetSlotIdx: v.presetSlotIdx,
      roi: v.roi, // 주차면 밖 판 기각 게이트 근거(§isInsideOwnRoi). 좌표 재계산 없이 DB 정본 그대로.
    });
  }
  return targets;
}

/** plate_discovery.json 저장(디렉터리 자동 생성, stringify5). Repository 미사용 — 별도 파일. */
export function writePlateDiscovery(artifact: PlateDiscoveryArtifact, outFile: string): void {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, stringify5(artifact, 2), 'utf-8');
}
