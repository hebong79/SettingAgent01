import { describe, it, expect } from 'vitest';
// S1 — 슬롯편집 순수함수 web↔src 파리티(설계 §5 단계 10 / §5.1).
//
// ★ 기준변은 web/core.js 다. 서버 포팅본(src/setup/artifactSlotEdit.ts)이 그것을 따라간다.
//   `toEqual` 깊은 비교 — toBeCloseTo 로 풀지 않는다(자구 포팅이므로 완전 일치해야 한다).
//   입력은 **기존 테스트 케이스를 재사용**한다(test/slotInsertEdit.test.ts:16 sampleArtifact).
//   새 입력을 발명하면 두 구현이 아니라 새 기대값을 검증하게 된다.
import {
  nextSlotId as webNextSlotId,
  insertSlotAt as webInsertSlotAt,
  removeSlot as webRemoveSlot,
  rebuildGlobalIndex as webRebuildGlobalIndex,
} from '../web/core.js';
import {
  nextSlotId as srcNextSlotId,
  insertSlotAt as srcInsertSlotAt,
  removeSlot as srcRemoveSlot,
  rebuildGlobalIndex as srcRebuildGlobalIndex,
} from '../src/setup/artifactSlotEdit.js';
import type { ArtifactLike } from '../web/core.js';
import type { ParkingSlot, Preset, SetupArtifact } from '../src/domain/types.js';

/** test/slotInsertEdit.test.ts:16 과 **동일** 산출물(2프리셋·3슬롯). */
function sampleArtifact(): SetupArtifact {
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

/** test/slotInsertEdit.test.ts:36 과 동일한 표준 신규 슬롯(현재 (1,1) 프리셋). */
function newSlot(id = 'c1p1s3'): ParkingSlot {
  return { slotId: id, zone: 'cam1', roiByPreset: { '1:1': { x: 0.45, y: 0.45, w: 0.1, h: 0.1 } } };
}

/** 같은 입력을 두 구현에 각각 준다(입력 공유로 인한 제자리 변형 오염 방지). */
function pair<W, S>(web: (a: ArtifactLike) => W, src: (a: SetupArtifact) => S): [W, S] {
  return [web(sampleArtifact() as unknown as ArtifactLike), src(sampleArtifact())];
}

describe('nextSlotId — web↔src', () => {
  it('해당 프리셋 슬롯 0개 → s1', () => {
    const [w, s] = pair(
      (a) => webNextSlotId(a, 2, 5),
      (a) => srcNextSlotId(a, 2, 5),
    );
    expect(s).toEqual(w);
    expect(s).toBe('c2p5s1');
  });

  it('연속 슬롯 → 최대+1', () => {
    const [w, s] = pair(
      (a) => webNextSlotId(a, 1, 1),
      (a) => srcNextSlotId(a, 1, 1),
    );
    expect(s).toEqual(w);
    expect(s).toBe('c1p1s3');
  });

  it('결번(s2 삭제 후 추가) — 기존 slotId 와 충돌 없음', () => {
    // s2 를 삭제하면 (1,1) 에 s1·s3 만 남는다 → length+1(s3)은 충돌, max+1(s4)이 정답.
    const seed = sampleArtifact();
    seed.slots.push(newSlot('c1p1s3'));
    seed.presets[0]!.coveredSlotIds.push('c1p1s3');
    const webAfter = webRemoveSlot(structuredClone(seed) as unknown as ArtifactLike, 'c1p1s2');
    const srcAfter = srcRemoveSlot(structuredClone(seed), 'c1p1s2');
    const w = webNextSlotId(webAfter, 1, 1);
    const s = srcNextSlotId(srcAfter as SetupArtifact, 1, 1);
    expect(s).toEqual(w);
    expect(s).toBe('c1p1s4');
  });
});

describe('insertSlotAt — web↔src', () => {
  for (const at of [0, 1, 2, 4, 999]) {
    it(`at=${at}(0·N+1·999 clamp 포함) 결과 artifact 완전 일치`, () => {
      const [w, s] = pair(
        (a) => webInsertSlotAt(a, at, newSlot()),
        (a) => srcInsertSlotAt(a, at, newSlot()),
      );
      expect(s).toEqual(w);
    });
  }

  it('at=1 → 신규가 맨 앞(globalIdx 1)', () => {
    const [w, s] = pair(
      (a) => webInsertSlotAt(a, 1, newSlot()),
      (a) => srcInsertSlotAt(a, 1, newSlot()),
    );
    expect(s.globalIndex!.find((g) => g.slotId === 'c1p1s3')!.globalIdx).toBe(1);
    expect(s).toEqual(w);
  });

  it('at=N+1(4) → 신규가 맨 끝, at=999 도 같은 결과(clamp)', () => {
    const end = srcInsertSlotAt(sampleArtifact(), 4, newSlot());
    const over = srcInsertSlotAt(sampleArtifact(), 999, newSlot());
    expect(over).toEqual(end);
    expect(end.globalIndex.find((g) => g.slotId === 'c1p1s3')!.globalIdx).toBe(4);
  });

  it('중복 slotId → no-op(원본 참조 그대로) — 두 구현 동일', () => {
    const wa = sampleArtifact() as unknown as ArtifactLike;
    const sa = sampleArtifact();
    const w = webInsertSlotAt(wa, 2, newSlot('c1p1s1'));
    const s = srcInsertSlotAt(sa, 2, newSlot('c1p1s1'));
    expect(w).toBe(wa); // 동일 참조
    expect(s).toBe(sa); // 동일 참조
    expect(s).toEqual(w);
  });

  it('preset 부재 → 신규 preset 생성(label `c:p`·PTZ 없음) — 두 구현 동일', () => {
    const s3: ParkingSlot = { slotId: 'c3p9s1', zone: 'cam3', roiByPreset: { '3:9': { x: 0.45, y: 0.45, w: 0.1, h: 0.1 } } };
    const [w, s] = pair(
      (a) => webInsertSlotAt(a, 1, s3),
      (a) => srcInsertSlotAt(a, 1, s3),
    );
    expect(s).toEqual(w);
    const p = s.presets!.find((pp) => pp.camIdx === 3 && pp.presetIdx === 9)!;
    expect(p.coveredSlotIds).toEqual(['c3p9s1']);
    expect(p.label).toBe('3:9');
    expect(p.pan).toBeUndefined();
  });

  it('roiByPreset 키 없음 → camIdx/presetIdx 0(퇴화 입력) — 두 구현 동일', () => {
    const bare = { slotId: 'cXpYs1', zone: 'z', roiByPreset: {} } as ParkingSlot;
    const [w, s] = pair(
      (a) => webInsertSlotAt(a, 2, bare),
      (a) => srcInsertSlotAt(a, 2, bare),
    );
    expect(s).toEqual(w);
    expect(s.globalIndex!.find((g) => g.slotId === 'cXpYs1')).toEqual({
      globalIdx: 2, slotId: 'cXpYs1', camIdx: 0, presetIdx: 0,
    });
  });
});

describe('removeSlot — web↔src', () => {
  it('중간 슬롯 삭제 → globalIndex 재구성 결과 일치', () => {
    const [w, s] = pair(
      (a) => webRemoveSlot(a, 'c1p1s1'),
      (a) => srcRemoveSlot(a, 'c1p1s1'),
    );
    expect(s).toEqual(w);
    expect(s.slots!.map((x) => x.slotId)).toEqual(['c1p1s2', 'c1p2s1']);
    expect(s.globalIndex!.map((g) => g.globalIdx)).toEqual([1, 2]);
  });

  it('없는 slotId → 조용히 무변경(두 구현 동일 — 이래서 라우트가 사전 존재 확인을 한다)', () => {
    const [w, s] = pair(
      (a) => webRemoveSlot(a, 'nope'),
      (a) => srcRemoveSlot(a, 'nope'),
    );
    expect(s).toEqual(w);
    expect(s.slots!.length).toBe(3);
  });

  it('추가 → 삭제 왕복이 원본과 같다', () => {
    const s = srcRemoveSlot(srcInsertSlotAt(sampleArtifact(), 2, newSlot()), 'c1p1s3');
    expect(s).toEqual(sampleArtifact());
  });
});

describe('rebuildGlobalIndex — web↔src', () => {
  it('coveredSlotIds 순서가 전역순서를 결정한다', () => {
    const a = sampleArtifact();
    const w = webRebuildGlobalIndex(a.slots, a.presets);
    const s = srcRebuildGlobalIndex(a.slots, a.presets);
    expect(s).toEqual(w);
    expect(s.map((g) => g.slotId)).toEqual(['c1p1s1', 'c1p1s2', 'c1p2s1']);
  });

  it('coveredSlotIds 에 없는 슬롯은 뒤로(camIdx/presetIdx=0 안전망)', () => {
    const a = sampleArtifact();
    a.slots.push({ slotId: 'orphan', zone: 'z', roiByPreset: {} });
    const w = webRebuildGlobalIndex(a.slots, a.presets);
    const s = srcRebuildGlobalIndex(a.slots, a.presets);
    expect(s).toEqual(w);
    expect(s.at(-1)).toEqual({ globalIdx: 4, slotId: 'orphan', camIdx: 0, presetIdx: 0 });
  });

  it('빈 입력·undefined 방어', () => {
    expect(srcRebuildGlobalIndex(undefined, undefined)).toEqual(
      webRebuildGlobalIndex(undefined, undefined),
    );
    expect(srcRebuildGlobalIndex([], [] as Preset[])).toEqual(webRebuildGlobalIndex([], []));
  });
});

/**
 * ★ 봉인 강화 — 검증자 음성 대조(변이 주입)로 **위 케이스들이 못 잡는 것**이 확인된 자리다.
 *   각 it 은 "이 변이를 잡는다"를 명시한다. 지우면 그 변이가 green 으로 통과하게 된다.
 *   두 케이스 모두 `sampleArtifact()` 만으로는 재현 불가라 전용 입력을 쓴다
 *   (§5.1-2 "기존 케이스 재사용" 원칙의 예외 — 재사용 가능한 케이스에는 그 자리가 아예 없다).
 */
describe('artifactSlotEdit 파리티 — 봉인 강화(음성 대조로 발견한 구멍)', () => {
  // 잡는 변이: rebuildGlobalIndex 의 preset 정렬 `camIdx → presetIdx` 순서 뒤바꿈.
  // sampleArtifact() 는 **단일 카메라**(1:1, 1:2)라 두 정렬이 같은 답을 낸다 — 카메라가 2대여야 갈린다.
  it('다중 카메라 — preset 정렬은 camIdx 가 presetIdx 보다 우선(cam1p2 < cam2p1)', () => {
    const slots: ParkingSlot[] = [
      { slotId: 'c1p2s1', zone: 'cam1', roiByPreset: { '1:2': { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } } },
      { slotId: 'c2p1s1', zone: 'cam2', roiByPreset: { '2:1': { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } } },
    ];
    const presets: Preset[] = [
      { camIdx: 1, presetIdx: 2, label: '1:2', coveredSlotIds: ['c1p2s1'] },
      { camIdx: 2, presetIdx: 1, label: '2:1', coveredSlotIds: ['c2p1s1'] },
    ];
    const w = webRebuildGlobalIndex(slots, presets);
    const s = srcRebuildGlobalIndex(slots, presets);
    expect(s).toEqual(w);
    // presetIdx 우선으로 뒤바뀌면 c2p1s1(presetIdx 1)이 앞으로 와서 이 단정이 깨진다.
    expect(s.map((g) => g.slotId)).toEqual(['c1p2s1', 'c2p1s1']);
  });

  // 잡는 변이: insertSlotAt 의 `Object.keys(newSlot.roiByPreset)[0]` → 다른 키 선택(`.at(-1)` 등).
  // 위 케이스들의 신규 슬롯은 roiByPreset 키가 **항상 1개**(또는 0개)라 어느 키를 골라도 같다.
  it('roiByPreset 키가 2개인 슬롯 — **첫** 키로 preset 을 귀속한다', () => {
    const dual: ParkingSlot = {
      slotId: 'c1p1s3',
      zone: 'cam1',
      roiByPreset: {
        '1:1': { x: 0.4, y: 0.4, w: 0.1, h: 0.1 },
        '2:7': { x: 0.5, y: 0.5, w: 0.1, h: 0.1 },
      },
    };
    const [w, s] = pair(
      (a) => webInsertSlotAt(a, 2, dual),
      (a) => srcInsertSlotAt(a, 2, dual),
    );
    expect(s).toEqual(w);
    // 마지막 키(2:7)를 고르면 camIdx/presetIdx 가 2/7 이 되고 신규 preset 까지 생겨 갈린다.
    expect(s.globalIndex!.find((g) => g.slotId === 'c1p1s3')).toEqual({
      globalIdx: 2, slotId: 'c1p1s3', camIdx: 1, presetIdx: 1,
    });
    expect(s.presets!.some((p) => p.camIdx === 2 && p.presetIdx === 7)).toBe(false);
  });
});
