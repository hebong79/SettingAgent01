import { z } from 'zod';
import { validateCoverage } from '../setup/GlobalIndexer.js';
import { rectToQuad } from '../domain/geometry.js';
import type { NormalizedQuad, NormalizedRect, SetupArtifact } from '../domain/types.js';

/**
 * SetupArtifact zod 검증 스키마 + 본문 검증 헬퍼(중립 모듈).
 * server.ts(PUT /mapping)·captureRoutes.ts(POST /capture/save)가 공유해 순환참조를 회피한다.
 * (server.ts↔captureRoutes.ts 가 스키마를 직접 주고받지 않고 여기서 import.)
 */

// 편집된 SetupArtifact 영속화 shape 검증. 계약(@parkagent/types)과 동일 형태.
const NormalizedRectSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
const NormalizedPointSchema = z.object({ x: z.number(), y: z.number() });
const NormalizedQuadSchema = z.tuple([
  NormalizedPointSchema,
  NormalizedPointSchema,
  NormalizedPointSchema,
  NormalizedPointSchema,
]);
const PresetSchema = z.object({
  camIdx: z.number().int(),
  presetIdx: z.number().int(),
  label: z.string(),
  coveredSlotIds: z.array(z.string()),
  pan: z.number().optional(),
  tilt: z.number().optional(),
  zoom: z.number().optional(),
});
// plateRoiByPreset 은 신 quad(4점) 우선, 구데이터(rect) 하위호환 허용 → 저장 전 quad 로 정규화.
const PlateRoiValueSchema = z.union([NormalizedQuadSchema, NormalizedRectSchema]);
// floor 는 가변 다각형(4~10점). 구 4점 저장 데이터도 통과(하위호환).
const FloorPolygonSchema = z.array(NormalizedPointSchema).min(4).max(10);
const ParkingSlotSchema = z.object({
  slotId: z.string(),
  zone: z.string(),
  roiByPreset: z.record(NormalizedRectSchema),
  plateRoiByPreset: z.record(PlateRoiValueSchema).optional(),
  floorRoiByPreset: z.record(FloorPolygonSchema).optional(),
});
const GlobalSlotIndexSchema = z.object({
  globalIdx: z.number().int(),
  slotId: z.string(),
  camIdx: z.number().int(),
  presetIdx: z.number().int(),
});
export const SetupArtifactSchema = z.object({
  presets: z.array(PresetSchema),
  slots: z.array(ParkingSlotSchema),
  globalIndex: z.array(GlobalSlotIndexSchema),
  createdAt: z.string(),
  warnings: z.array(z.string()).optional(),
  report: z.string().optional(),
});

/** validateArtifactBody 결과: 성공(정규화된 artifact) 또는 400 응답 본문. */
export type ArtifactValidation =
  | { ok: true; artifact: SetupArtifact }
  | { ok: false; code: number; body: { error: string; detail?: unknown; missing?: string[]; extra?: string[] } };

/**
 * SetupArtifact 본문 검증(공유): ① zod shape → 400 invalid artifact.
 * ② plateRoiByPreset 구데이터(rect) → quad 승격(저장은 항상 quad).
 * ③ validateCoverage(globalIndex↔slots) 불일치 → 400 coverage mismatch. 통과 시 정규화 artifact 반환.
 */
export function validateArtifactBody(body: unknown): ArtifactValidation {
  const parsed = SetupArtifactSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, code: 400, body: { error: 'invalid artifact', detail: parsed.error.flatten() } };
  }
  const artifact = parsed.data as SetupArtifact;
  for (const slot of artifact.slots) {
    const plate = slot.plateRoiByPreset as Record<string, unknown> | undefined;
    if (!plate) continue;
    for (const key of Object.keys(plate)) {
      const v = plate[key];
      if (v && typeof v === 'object' && 'w' in (v as Record<string, unknown>)) {
        (slot.plateRoiByPreset as Record<string, NormalizedQuad>)[key] = rectToQuad(v as NormalizedRect);
      }
    }
  }
  const cov = validateCoverage(artifact.globalIndex, artifact.slots);
  if (!cov.ok) {
    return { ok: false, code: 400, body: { error: 'coverage mismatch', missing: cov.missing, extra: cov.extra } };
  }
  return { ok: true, artifact };
}
