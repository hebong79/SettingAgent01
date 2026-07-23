// slot_setup(DB) 조회 결과 → SetupArtifact 즉석 조립(순수·결정형).
// GET /mapping 파일 폴백 전용 — 어떤 것도 영속화하지 않는다(Finalizer.replaceSlotSetup 미호출).
// 타입만 import 한다(server/captureRoutes 미참조 → 순환참조 불가).
import type { SlotSetupView } from '../capture/types.js';
import type {
  GlobalSlotIndex,
  NormalizedPoint,
  NormalizedRect,
  ParkingSlot,
  Preset,
  SetupArtifact,
} from '../domain/types.js';

/**
 * 현재 slot_setup(DB) 조회 결과에서 SetupArtifact 를 즉석 조립(순수·결정형).
 * views 는 SqliteStore.getSlotSetup() 반환(이미 cam_id, preset_id, preset_slotidx 정렬).
 * - roiByPreset = slotRoi 폴리곤의 축정렬 bbox rect
 * - plateRoiByPreset = lpd(quad) 있을 때만
 * - presetKey/label = `${camId}:${presetId}` (Finalizer 규칙과 동일)
 * - globalIdx = DB slotId(전역번호) 직접 사용(재부여 안 함)
 * @param now 테스트 결정성 주입(기본 = 현재 ISO). Finalizer 패턴 동일.
 */
export function buildArtifactFromSlotSetup(
  views: SlotSetupView[],
  now: () => string = () => new Date().toISOString(),
): SetupArtifact {
  const presetMap = new Map<string, Preset>(); // presetKey -> Preset(coveredSlotIds 누적)
  const slots: ParkingSlot[] = [];
  const globalIndex: GlobalSlotIndex[] = [];

  for (const v of views) {
    const key = v.presetKey; // `${camId}:${presetId}` (SlotSetupView 파생값 그대로)
    const sid = String(v.slotId); // number -> string

    // (a) preset 그룹 append (SQL 이 preset_slotidx 오름차순 → coveredSlotIds 위치순 보장)
    let preset = presetMap.get(key);
    if (!preset) {
      preset = { camIdx: v.camId, presetIdx: v.presetId, label: key, coveredSlotIds: [] };
      presetMap.set(key, preset);
    }
    preset.coveredSlotIds.push(sid);

    // (b) slot: roiByPreset = slotRoi(폴리곤)의 축정렬 bbox rect
    const slot: ParkingSlot = {
      slotId: sid,
      zone: `cam${v.camId}`, // DB 에 zone 없음 → Finalizer 강등 규칙(zone=cam{N})과 동일
      roiByPreset: { [key]: bboxOf(v.roi) },
    };
    if (v.lpd) slot.plateRoiByPreset = { [key]: v.lpd }; // lpd(quad) 있을 때만
    slots.push(slot);

    // (c) globalIndex: globalIdx = DB slotId(number) 직접 사용(재부여 안 함)
    globalIndex.push({ globalIdx: v.slotId, slotId: sid, camIdx: v.camId, presetIdx: v.presetId });
  }

  return { presets: [...presetMap.values()], slots, globalIndex, createdAt: now() };
}

/** NormalizedPoint[] 축정렬 bbox → rect(x=min,y=min,w,h). 빈 배열이면 0-rect(방어). */
function bboxOf(points: NormalizedPoint[]): NormalizedRect {
  if (!points || points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
