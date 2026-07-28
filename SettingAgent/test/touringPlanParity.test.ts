import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildTouringPlan as webPlan } from '../web/core.js';
import { buildTouringPlan as srcPlan } from '../src/setup/touringPlan.js';

/**
 * 검증자(qa-tester): **투어링 순회계획 파리티** — `web/core.js:buildTouringPlan`(기준변) ↔
 * `src/setup/touringPlan.ts`(서버 포팅본).
 *
 * ★ 이 파일이 증명하려는 것: 서버 승격이 계산을 바꾸지 않았다.
 *   `src → web` import 는 금지돼 있으므로 같은 알고리즘이 두 벌 존재한다 — 두 벌이 갈리는 순간
 *   웹 화면과 서버 순회가 다른 곳을 본다. 그래서 `toEqual` **깊은 비교**로 고정한다
 *   (`toBeCloseTo` 로 풀지 않는다 — 자구 포팅이라 부동소수까지 같아야 하며, 다르면 그건 포팅 오류다).
 *
 * 입력은 **기존 `test/buildTouringPlan.test.ts` 케이스 + 실데이터 fixture 를 재사용**한다.
 * 새 기대값을 발명하면 두 구현이 아니라 새 기대값을 검증하게 된다.
 */

const realSetup = JSON.parse(readFileSync('test/fixtures/setupResult.23slots.json', 'utf8')) as unknown;

/** web 구현의 인자 타입(JSDoc 유래). 퇴화 입력은 의도적으로 계약 밖이므로 캐스팅해 넣는다. */
type WebInput = Parameters<typeof webPlan>[0];

/** 두 구현에 같은 입력을 넣어 결과가 깊은 값으로 동일함을 단정. */
function expectParity(input: unknown): void {
  const w = webPlan(input as WebInput);
  const s = srcPlan(input);
  expect(s).toEqual(w);
}

describe('touringPlan 파리티 — 실데이터 23슬롯 fixture', () => {
  it('web ↔ src 결과가 깊은 값으로 동일(steps 28 · skipped 0)', () => {
    expectParity(realSetup);
    // 파리티가 "둘 다 빈 결과"로 통과하는 무력화를 막는다(fixture 기준값은 기존 테스트와 동일).
    const s = srcPlan(realSetup);
    expect(s.steps).toHaveLength(28);
    expect(s.skipped).toBe(0);
  });

  it('preset/slot 스텝의 키 구성까지 동일(shape 계약)', () => {
    const w = webPlan(realSetup as WebInput);
    const s = srcPlan(realSetup);
    expect(s.steps.map((x) => Object.keys(x).sort())).toEqual(
      w.steps.map((x) => Object.keys(x).sort()),
    );
  });
});

describe('touringPlan 파리티 — 퇴화 입력(사고는 항상 여기서 났다)', () => {
  it('null', () => expectParity(null));
  it('undefined', () => expectParity(undefined));
  it('{} (slots 없음)', () => expectParity({}));
  it('{slots:[]} 빈 배열', () => expectParity({ slots: [] }));
  it('slots 가 비배열(무효 타입)', () => expectParity({ slots: 'nope' }));
  it('slots 가 객체(무효 타입)', () => expectParity({ slots: { a: 1 } }));
});

describe('touringPlan 파리티 — centering 결손', () => {
  it('centering=null 1건 혼합', () => {
    expectParity({
      slots: [
        { slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1, centering: { pan: 5, tilt: 10, zoom: 3 } },
        { slotId: 2, camId: 1, presetId: 1, presetSlotIdx: 2, centering: null },
      ],
    });
  });

  it('부분 결손(zoom 누락)', () => {
    expectParity({
      slots: [{ slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1, centering: { pan: 5, tilt: 10 } }],
    });
  });

  it('그룹 전체 centering=null(preset 스텝만 발행)', () => {
    expectParity({
      slots: [
        { slotId: 1, camId: 2, presetId: 5, presetSlotIdx: 1, centering: null },
        { slotId: 2, camId: 2, presetId: 5, presetSlotIdx: 2, centering: null },
      ],
    });
  });

  it('centering 키 자체가 없음', () => {
    expectParity({ slots: [{ slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1 }] });
  });
});

describe('touringPlan 파리티 — 단일 그룹 · 역순 · 재정렬', () => {
  it('단일 그룹 다중 슬롯(1:1 에 3개)', () => {
    expectParity({
      slots: [
        { slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1, centering: { pan: 1, tilt: 1, zoom: 1 } },
        { slotId: 2, camId: 1, presetId: 1, presetSlotIdx: 2, centering: { pan: 2, tilt: 2, zoom: 2 } },
        { slotId: 3, camId: 1, presetId: 1, presetSlotIdx: 3, centering: { pan: 3, tilt: 3, zoom: 3 } },
      ],
    });
  });

  it('그룹 뒤섞인 입력(1:1, 2:1, 1:1)', () => {
    expectParity({
      slots: [
        { slotId: 10, camId: 1, presetId: 1, presetSlotIdx: 2, centering: { pan: 2, tilt: 2, zoom: 2 } },
        { slotId: 20, camId: 2, presetId: 1, presetSlotIdx: 1, centering: { pan: 9, tilt: 9, zoom: 9 } },
        { slotId: 11, camId: 1, presetId: 1, presetSlotIdx: 1, centering: { pan: 1, tilt: 1, zoom: 1 } },
      ],
    });
  });

  it('presetSlotIdx=null 동률(slotId tie-break)', () => {
    expectParity({
      slots: [
        { slotId: 5, camId: 1, presetId: 1, presetSlotIdx: null, centering: { pan: 1, tilt: 1, zoom: 1 } },
        { slotId: 3, camId: 1, presetId: 1, presetSlotIdx: null, centering: { pan: 2, tilt: 2, zoom: 2 } },
      ],
    });
  });

  it('완전 역순 입력(실데이터 fixture 를 뒤집어 넣어도 같은 계획)', () => {
    const slots = [...(realSetup as { slots: unknown[] }).slots].reverse();
    expectParity({ slots });
    // 역순 입력이어도 정렬로 원래 계획과 같아진다(방어적 재정렬의 실증).
    expect(srcPlan({ slots })).toEqual(srcPlan(realSetup));
  });

  it('소수 PTZ 값도 부동소수 그대로 일치', () => {
    expectParity({
      slots: [{ slotId: 7, camId: 1, presetId: 2, presetSlotIdx: 3, centering: { pan: 5.10001, tilt: -10.87654, zoom: 11.20003 } }],
    });
  });
});

/**
 * ★ 봉인 강화 — 검증자 음성 대조(변이 주입)로 **위 케이스들이 못 잡는 것**이 확인된 자리다.
 *   각 it 은 "이 변이를 잡는다"를 명시한다. 지우면 그 변이가 green 으로 통과하게 된다.
 *   (측정: 아래 2건 없이 변이를 넣으면 이 파일 전체가 통과했다.)
 */
describe('touringPlan 파리티 — 봉인 강화(음성 대조로 발견한 구멍)', () => {
  // 잡는 변이: `c.pan/tilt/zoom != null` → `!== undefined`.
  // 위 '부분 결손(zoom 누락)' 은 zoom 이 **undefined** 라 두 식이 같은 답을 낸다 — 명시적 null 이어야 갈린다.
  it('centering 내부 값만 null(부분 결손) — null 과 undefined 를 구분한다', () => {
    const input = {
      slots: [{ slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1, centering: { pan: 1, tilt: 1, zoom: null } }],
    };
    expectParity(input);
    expect(srcPlan(input).skipped).toBe(1); // null 은 결손 → 스킵(위장 이동 금지)
    expect(srcPlan(input).steps.filter((x) => x.kind === 'slot')).toHaveLength(0);
  });

  // 잡는 변이: 정렬 tie-break 기본값 `(presetSlotIdx ?? 0)` 의 0 을 다른 값으로 바꾸는 것.
  // 위 'presetSlotIdx=null 동률' 은 **둘 다 null** 이라 기본값이 무엇이든 순서가 같다 —
  // null 과 숫자가 **섞여야** 기본값이 실제 순서를 결정한다.
  it('presetSlotIdx 가 null 과 숫자로 섞인 그룹 — 정렬 기본값(0)이 순서를 결정한다', () => {
    const input = {
      slots: [
        { slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 5, centering: { pan: 1, tilt: 1, zoom: 1 } },
        { slotId: 2, camId: 1, presetId: 1, presetSlotIdx: null, centering: { pan: 2, tilt: 2, zoom: 2 } },
      ],
    };
    expectParity(input);
    // null → 0 이므로 slotId 2 가 먼저다. 기본값이 바뀌면 이 순서가 뒤집힌다.
    expect(srcPlan(input).steps.filter((x) => x.kind === 'slot').map((x) => x.slotId)).toEqual([2, 1]);
  });
});
