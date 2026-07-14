import { describe, it, expect, vi } from 'vitest';
import { OccupancyReviewer } from '../src/capture/OccupancyReviewer.js';
import { logger } from '../src/util/logger.js';
import type { SqliteStore } from '../src/capture/SqliteStore.js';
import type { SetupBrain, OccupancyInput, OccupancyJudgment } from '../src/brain/SetupBrain.js';

/**
 * 검증자(qa-tester): OccupancyReviewer (설계서 §3.6, 성공기준 3·4).
 * 전 프리셋 순회(캡 없음) → brain.judgeOccupancy → store.insertOccupancy.
 * 폴백 없음: LLM 불가/실패 시 graceful skip(저장 생략) + llmUnavailable 플래그(잡 미중단).
 * 경계 교차: judgeOccupancy 반환(spaces/occupiedCount/total/rate) → insertOccupancy 레코드 shape.
 */

/** insertOccupancy 호출을 캡처하는 fake store. */
function fakeStore() {
  const rows: Array<{ runId: number; rec: Record<string, unknown> }> = [];
  const store = {
    insertOccupancy: vi.fn((runId: number, rec: Record<string, unknown>) => {
      rows.push({ runId, rec });
    }),
  } as unknown as SqliteStore;
  return { store, rows };
}

/** 판정 함수를 주입받는 fake brain. */
function fakeBrain(
  fn: (input: OccupancyInput) => Promise<OccupancyJudgment | null>,
  over: Partial<Pick<SetupBrain, 'enabled'>> = {},
): SetupBrain {
  return { enabled: true, judgeOccupancy: vi.fn(fn), ...over } as unknown as SetupBrain;
}

const jpeg = (s: string) => Buffer.from(s);
const framesOf = (keys: string[]) => new Map(keys.map((k) => [k, jpeg(k)]));

const judgment = (spaces: OccupancyJudgment['spaces']): OccupancyJudgment => {
  const total = spaces.length;
  const occupiedCount = spaces.filter((s) => s.occupied).length;
  return { spaces, occupiedCount, total, rate: total > 0 ? occupiedCount / total : 0, confidence: 0.8 };
};

describe('OccupancyReviewer graceful skip (LLM 불가 — 성공기준 4)', () => {
  it('brain 미주입 → 저장 0, llmUnavailable:true', async () => {
    const { store, rows } = fakeStore();
    const r = new OccupancyReviewer({ store });
    const res = await r.review(1, 1, framesOf(['1:1', '1:2']));
    expect(res).toEqual({ llmUnavailable: true });
    expect(rows).toHaveLength(0);
  });

  it('brain.enabled=false → 저장 0, llmUnavailable:true(시도 안 함)', async () => {
    const { store, rows } = fakeStore();
    const brain = fakeBrain(async () => judgment([{ id: 1, occupied: true }]), { enabled: false });
    const r = new OccupancyReviewer({ store, brain });
    const res = await r.review(1, 1, framesOf(['1:1']));
    expect(res).toEqual({ llmUnavailable: true });
    expect(rows).toHaveLength(0);
    expect(brain.judgeOccupancy).not.toHaveBeenCalled();
  });

  it('judgeOccupancy 메서드 부재 → 저장 0, llmUnavailable:true', async () => {
    const { store, rows } = fakeStore();
    const brain = { enabled: true } as unknown as SetupBrain; // judgeOccupancy 없음
    const r = new OccupancyReviewer({ store, brain });
    const res = await r.review(1, 1, framesOf(['1:1']));
    expect(res).toEqual({ llmUnavailable: true });
    expect(rows).toHaveLength(0);
  });

  it('전 프리셋 throw(succeeded=0, attempted>0) → llmUnavailable:true', async () => {
    const { store, rows } = fakeStore();
    const brain = fakeBrain(async () => { throw new Error('LLM down'); });
    const r = new OccupancyReviewer({ store, brain });
    const res = await r.review(1, 1, framesOf(['1:1', '1:2']));
    expect(res).toEqual({ llmUnavailable: true });
    expect(rows).toHaveLength(0);
    expect(brain.judgeOccupancy).toHaveBeenCalledTimes(2); // 두 프리셋 모두 시도(잡 미중단)
  });

  it('전 프리셋 null 반환(무효) → 저장 0, llmUnavailable:true', async () => {
    const { store, rows } = fakeStore();
    const brain = fakeBrain(async () => null);
    const r = new OccupancyReviewer({ store, brain });
    const res = await r.review(1, 1, framesOf(['1:1', '1:2']));
    expect(res).toEqual({ llmUnavailable: true });
    expect(rows).toHaveLength(0);
  });
});

describe('OccupancyReviewer 정상 저장 (성공기준 3)', () => {
  it('전 프리셋 저장(캡 없음): 13 프레임 → 13행(floor 의 12 캡과 대비)', async () => {
    const { store, rows } = fakeStore();
    const brain = fakeBrain(async () => judgment([{ id: 1, occupied: true }, { id: 2, occupied: false }]));
    const r = new OccupancyReviewer({ store, brain });
    const keys = Array.from({ length: 13 }, (_, i) => `1:${i + 1}`);
    const res = await r.review(7, 3, framesOf(keys));
    expect(res).toEqual({ llmUnavailable: false });
    expect(rows).toHaveLength(13); // maxPerCheckpoint 캡 미적용(결정 3)
  });

  it('저장 레코드 shape 교차검증: judgment → insertOccupancy 필드 매핑', async () => {
    const { store, rows } = fakeStore();
    // 3면 중 2면 점유 → rate=2/3(결정형 산출값 그대로 저장).
    const brain = fakeBrain(async () =>
      judgment([{ id: 1, occupied: true }, { id: 2, occupied: false }, { id: 3, occupied: true }]),
    );
    const r = new OccupancyReviewer({ store, brain, now: () => 'NOW' });
    await r.review(42, 5, framesOf(['1:2']));
    expect(rows).toHaveLength(1);
    expect(rows[0].runId).toBe(42);
    const rec = rows[0].rec;
    expect(rec.camIdx).toBe(1);
    expect(rec.presetIdx).toBe(2); // key '1:2' → camIdx 1, presetIdx 2(경계: split(':').map(Number))
    expect(rec.atRound).toBe(5);
    expect(rec.occupiedCount).toBe(2);
    expect(rec.total).toBe(3);
    expect(rec.rate).toBeCloseTo(2 / 3);
    expect(rec.updatedAt).toBe('NOW');
    // spaces 는 JSON 문자열로 보존(box 포함 향후 오버레이용).
    expect(JSON.parse(rec.spacesJson as string)).toEqual([
      { id: 1, occupied: true }, { id: 2, occupied: false }, { id: 3, occupied: true },
    ]);
  });

  it('빈 spaces(total=0) → rate=0 저장(빈 화면 0% 충족)', async () => {
    const { store, rows } = fakeStore();
    const brain = fakeBrain(async () => judgment([]));
    const r = new OccupancyReviewer({ store, brain });
    const res = await r.review(1, 1, framesOf(['1:1']));
    expect(res).toEqual({ llmUnavailable: false });
    expect(rows).toHaveLength(1);
    expect(rows[0].rec.total).toBe(0);
    expect(rows[0].rec.occupiedCount).toBe(0);
    expect(rows[0].rec.rate).toBe(0);
  });

  it('expectedByPreset 전달 시 judgeOccupancy input.expected 채워짐', async () => {
    const { store } = fakeStore();
    const seen: OccupancyInput[] = [];
    const brain = fakeBrain(async (input) => { seen.push(input); return judgment([{ id: 1, occupied: true }]); });
    const r = new OccupancyReviewer({ store, brain });
    await r.review(1, 1, framesOf(['1:1', '2:3']), undefined, { '1:1': 4, '2:3': 7 });
    expect(seen.map((s) => s.expected)).toEqual([4, 7]);
    // imageBase64 는 프레임 JPEG 의 base64(경계: jpeg.toString('base64')).
    expect(seen[0].imageBase64).toBe(Buffer.from('1:1').toString('base64'));
    expect(seen[1].camIdx).toBe(2);
    expect(seen[1].presetIdx).toBe(3);
  });
});

describe('OccupancyReviewer 부분 실패·정지 (성공기준 4)', () => {
  it('일부 프리셋 throw → 해당만 스킵·나머지 저장, succeeded>0 → llmUnavailable:false', async () => {
    const { store, rows } = fakeStore();
    const brain = fakeBrain(async (input) => {
      if (input.presetIdx === 2) throw new Error('preset2 판정 실패');
      return judgment([{ id: 1, occupied: true }]);
    });
    const r = new OccupancyReviewer({ store, brain });
    const res = await r.review(1, 1, framesOf(['1:1', '1:2', '1:3']));
    expect(res).toEqual({ llmUnavailable: false }); // 최소 1건 성공
    expect(rows.map((x) => x.rec.presetIdx)).toEqual([1, 3]); // preset2 스킵, 1·3 저장
  });

  it('shouldStop=()=>true → 첫 프리셋 전 break, 저장 0', async () => {
    const { store, rows } = fakeStore();
    const brain = fakeBrain(async () => judgment([{ id: 1, occupied: true }]));
    const r = new OccupancyReviewer({ store, brain });
    const res = await r.review(1, 1, framesOf(['1:1', '1:2']), () => true);
    expect(rows).toHaveLength(0);
    expect(brain.judgeOccupancy).not.toHaveBeenCalled();
    // 정지로 한 건도 시도 안 함(attempted=0, usable=true) → llmUnavailable:false.
    expect(res).toEqual({ llmUnavailable: false });
  });
});

/**
 * 관측성 로깅 구분(설계 §3-4, T6): null(파싱/스키마 실패) vs throw(타임아웃 등)를
 * 서로 다른 warn 으로 남기고, 요약에 nullCount/errorCount 를 분리 집계한다.
 * logger.warn 을 스파이해 per-call 사유 로그 + 요약 카운트를 검증한다.
 */
describe('OccupancyReviewer 관측성 로깅 (T6 — null vs throw 구분 + 카운트)', () => {
  it('전 프리셋 null → 프리셋별 null warn + 요약 nullCount 집계(errorCount=0)', async () => {
    const { store } = fakeStore();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation((() => {}) as never);
    const brain = fakeBrain(async () => null);
    const r = new OccupancyReviewer({ store, brain });
    await r.review(1, 1, framesOf(['1:1', '1:2']));
    const nullMsgs = warnSpy.mock.calls.filter((c) => String(c[1]).includes('판정 null'));
    expect(nullMsgs).toHaveLength(2);
    const summary = warnSpy.mock.calls.find((c) => String(c[1]).includes('LLM 비활성/불가'));
    expect(summary).toBeDefined();
    expect(summary![0]).toMatchObject({ nullCount: 2, errorCount: 0, attempted: 2, succeeded: 0 });
    warnSpy.mockRestore();
  });

  it('전 프리셋 throw → 실패 warn 에 err·name(타임아웃 구분) 포함 + 요약 errorCount 집계(nullCount=0)', async () => {
    const { store } = fakeStore();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation((() => {}) as never);
    // 타임아웃 유사 에러: name 으로 원인(APIConnectionTimeoutError) 구분 가능해야 함.
    const err = new Error('aborted');
    err.name = 'APIConnectionTimeoutError';
    const brain = fakeBrain(async () => { throw err; });
    const r = new OccupancyReviewer({ store, brain });
    await r.review(1, 1, framesOf(['1:1', '1:2']));
    const failMsgs = warnSpy.mock.calls.filter((c) => String(c[1]).includes('판정 실패'));
    expect(failMsgs).toHaveLength(2);
    // 경계: 실패 로그 obj 에 name(에러 종류) + err 메시지 — 타임아웃(errorCount) vs 파싱(nullCount) 판별 근거.
    expect(failMsgs[0][0]).toMatchObject({ name: 'APIConnectionTimeoutError', err: 'aborted', key: '1:1' });
    const summary = warnSpy.mock.calls.find((c) => String(c[1]).includes('LLM 비활성/불가'));
    expect(summary![0]).toMatchObject({ nullCount: 0, errorCount: 2, attempted: 2, succeeded: 0 });
    warnSpy.mockRestore();
  });
});
