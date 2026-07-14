import { describe, it, expect } from 'vitest';
// QA 보강(검증자) — 구현자 slotInsertEdit.test.ts 미커버 불변식:
//  · #5 실제 SetupArtifactSchema/validateArtifactBody 서버저장 경로 parse 통과
//  · 경계: 빈 artifact / 단일슬롯 / 순차 다중삽입
//  · nextSlotId 전체집합 유니크
// DOM/fetch 미참조(순수 로직 + zod 스키마 검증).
import { nextSlotId, insertSlotAt, validateManualIndex, buildMappingRows } from '../web/core.js';
import { validateCoverage } from '../src/setup/GlobalIndexer.js';
import { SetupArtifactSchema, validateArtifactBody } from '../src/api/artifactSchema.js';
import type { ArtifactLike } from '../web/core.js';

/** 2프리셋 산출물(구현자 테스트와 동일 shape). */
function sampleArtifact(): ArtifactLike {
  return {
    createdAt: 'T',
    presets: [
      { camIdx: 1, presetIdx: 1, label: '1:1', coveredSlotIds: ['c1p1s1', 'c1p1s2'] },
      { camIdx: 1, presetIdx: 2, label: '1:2', coveredSlotIds: ['c1p2s1'] },
    ],
    slots: [
      { slotId: 'c1p1s1', zone: 'cam1', roiByPreset: { '1:1': { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } } },
      { slotId: 'c1p1s2', zone: 'cam1', roiByPreset: { '1:1': { x: 0.5, y: 0.5, w: 0.2, h: 0.2 } } },
      { slotId: 'c1p2s1', zone: 'cam1', roiByPreset: { '1:2': { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } } },
    ],
    globalIndex: [
      { globalIdx: 1, slotId: 'c1p1s1', camIdx: 1, presetIdx: 1 },
      { globalIdx: 2, slotId: 'c1p1s2', camIdx: 1, presetIdx: 1 },
      { globalIdx: 3, slotId: 'c1p2s1', camIdx: 1, presetIdx: 2 },
    ],
  };
}
function newSlot(id = 'c1p1s3', key = '1:1', zone = 'cam1') {
  return { slotId: id, zone, roiByPreset: { [key]: { x: 0.45, y: 0.45, w: 0.1, h: 0.1 } } };
}

// ===== #5 서버저장 스키마 실제 parse (경계면 교차: core.insertSlotAt 출력 ↔ 서버 SetupArtifactSchema 소비) =====
describe('#5 insertSlotAt 결과가 실제 서버 저장 스키마·검증을 통과', () => {
  it('일반 중간삽입(at=2) → SetupArtifactSchema.safeParse 성공', () => {
    const next = insertSlotAt(sampleArtifact(), 2, newSlot());
    const parsed = SetupArtifactSchema.safeParse(next);
    expect(parsed.success).toBe(true);
  });

  it('validateArtifactBody(서버 PUT /mapping 경로) ok:true + coverage 통과', () => {
    const next = insertSlotAt(sampleArtifact(), 2, newSlot());
    const res = validateArtifactBody(next);
    expect(res.ok).toBe(true);
  });

  it('preset 부재 신규생성 케이스도 서버 검증 통과', () => {
    const next = insertSlotAt(sampleArtifact(), 1, newSlot('c3p9s1', '3:9', 'cam3'));
    expect(SetupArtifactSchema.safeParse(next).success).toBe(true);
    expect(validateArtifactBody(next).ok).toBe(true);
  });

  it('addSlot 경로(nextSlotId→insertSlotAt) 결과 서버 검증 통과', () => {
    const a = sampleArtifact();
    const id = nextSlotId(a, 1, 1);
    const next = insertSlotAt(a, 2, newSlot(id));
    const res = validateArtifactBody(next);
    expect(res.ok).toBe(true);
  });
});

// ===== 경계: 빈 artifact / 단일슬롯 =====
describe('경계 — 빈/최소 artifact 삽입', () => {
  it('빈 artifact(slots/presets/globalIndex 빈배열)에 삽입 → 1슬롯, globalIdx=1, 서버검증 통과', () => {
    const empty: ArtifactLike = { createdAt: 'T', presets: [], slots: [], globalIndex: [] };
    const next = insertSlotAt(empty, 1, newSlot());
    expect(next.slots!.length).toBe(1);
    expect(next.globalIndex!.length).toBe(1);
    expect(next.globalIndex![0].globalIdx).toBe(1);
    expect(next.presets!.find((p) => p.camIdx === 1 && p.presetIdx === 1)!.coveredSlotIds).toEqual(['c1p1s3']);
    expect(validateCoverage(next.globalIndex as never, next.slots as never).ok).toBe(true);
    expect(validateManualIndex(next.globalIndex).ok).toBe(true);
    expect(SetupArtifactSchema.safeParse(next).success).toBe(true);
  });

  it('빈 artifact에 at=99(범위밖) 삽입 → clamp 되어 globalIdx=1', () => {
    const empty: ArtifactLike = { createdAt: 'T', presets: [], slots: [], globalIndex: [] };
    const next = insertSlotAt(empty, 99, newSlot());
    expect(next.globalIndex![0].globalIdx).toBe(1);
  });

  it('맨앞 삽입 at=1 → 기존 전체 +1', () => {
    const next = insertSlotAt(sampleArtifact(), 1, newSlot());
    const gid = (id: string) => next.globalIndex!.find((e) => e.slotId === id)!.globalIdx;
    expect(gid('c1p1s3')).toBe(1);
    expect(gid('c1p1s1')).toBe(2);
    expect(gid('c1p1s2')).toBe(3);
    expect(gid('c1p2s1')).toBe(4);
  });
});

// ===== 순차 다중삽입 정합(누적 후에도 coverage·1..N·서버검증 유지) =====
describe('순차 다중삽입 누적 정합', () => {
  it('3회 연속 삽입 후 globalIdx 1..N 연속·서버검증 통과', () => {
    let a = sampleArtifact();
    for (let k = 0; k < 3; k++) {
      const id = nextSlotId(a, 1, 1);
      a = insertSlotAt(a, 2, newSlot(id)) as ArtifactLike; // 매번 at=2 중간삽입
    }
    const idxs = a.globalIndex!.map((g) => g.globalIdx).sort((x, y) => x - y);
    expect(idxs).toEqual([1, 2, 3, 4, 5, 6]);
    expect(validateManualIndex(a.globalIndex).ok).toBe(true);
    expect(validateCoverage(a.globalIndex as never, a.slots as never).ok).toBe(true);
    expect(validateArtifactBody(a).ok).toBe(true);
    // nextSlotId 결번 회피: 3개 신규 slotId 유니크
    const ids = a.slots!.map((s) => s.slotId);
    expect(new Set(ids).size).toBe(ids.length);
    // preset(1,1) coveredSlotIds positionIdx 연속(1..5: 기존2 + 신규3)
    const rows = buildMappingRows(a).filter((r) => r.camIdx === 1 && r.presetIdx === 1);
    expect(rows.map((r) => r.positionIdx)).toEqual([1, 2, 3, 4, 5]);
  });
});

// ===== nextSlotId 전체집합 유니크(결번 다수) =====
describe('nextSlotId 전체집합 충돌회피', () => {
  it('s1,s3 존재(s2 결번) → s4, 전체 slotId 집합과 무충돌', () => {
    const a = sampleArtifact();
    a.slots = [
      { slotId: 'c1p1s1', zone: 'cam1', roiByPreset: { '1:1': { x: 0, y: 0, w: 0.1, h: 0.1 } } },
      { slotId: 'c1p1s3', zone: 'cam1', roiByPreset: { '1:1': { x: 0, y: 0, w: 0.1, h: 0.1 } } },
    ];
    const id = nextSlotId(a, 1, 1);
    expect(id).toBe('c1p1s4');
    expect(a.slots.some((s) => s.slotId === id)).toBe(false);
  });

  it('다른 프리셋 슬롯은 (cam,preset) 카운트에 미간섭', () => {
    // (1,1) 에 s1,s2 / (1,2) 에 s1 → nextSlotId(1,1)=s3, nextSlotId(1,2)=s2
    const a = sampleArtifact();
    expect(nextSlotId(a, 1, 1)).toBe('c1p1s3');
    expect(nextSlotId(a, 1, 2)).toBe('c1p2s2');
  });
});
