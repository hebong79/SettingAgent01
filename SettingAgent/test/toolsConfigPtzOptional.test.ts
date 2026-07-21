import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadToolsConfig, CameraSourceConfigSchema, type CameraSourceConfig } from '../src/config/toolsConfig.js';
import { RealPtzSource } from '../src/viewer/RealPtzSource.js';

/**
 * 검증자(qa-tester) — 이터레이션 2 **회귀 가드**: `cameraSources[].ptz` 축별 optional.
 *
 * ★ 이 파일이 존재하는 이유(재발하면 마스터 서버가 기동조차 못 한다):
 *   수정 10 이 실카 소스에 `"ptz": { "zoomRange": [0,16384] }` 만 추가했더니 서버가 ZodError 로 죽었다
 *   (`cameraSources[2].ptz.panRange Required`). 스키마는 세 축 all-or-nothing 이었는데
 *   `RealPtzSource:155~157` 은 이미 축별 `?? HUCOMS_DEFAULT_*` 폴백이었다 —
 *   **코드가 요구하지 않는 것을 스키마만 요구**하고 있었다. 그 불일치를 여기서 고정한다.
 *
 * 검증 축: ① 기존 config(3축 전부) 유효 ② zoomRange 단독 유효(크래시 재현→해소)
 *          ③ ptz 자체 미지정(시뮬) 유효 ④ 축별 optional ↔ RealPtzSource 축별 폴백 정합
 *          ⑤ 느슨해진 것은 "필수 여부"뿐 — 형태 검증은 그대로 엄격
 */

const BASE = { id: 'cam', kind: 'hucoms' as const, host: '127.0.0.1', port: 80 };

// ── ①~③ 스키마 수용 범위 ──────────────────────────────────────────────────────
describe('CameraSourceConfigSchema.ptz — 축별 optional', () => {
  it('① 3축 전부 지정(기존 config 형태) → 유효 · 값 그대로 보존', () => {
    const r = CameraSourceConfigSchema.safeParse({
      ...BASE,
      ptz: { panRange: [0, 35999], tiltRange: [-2000, 9000], zoomRange: [0, 65535] },
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.ptz).toEqual({ panRange: [0, 35999], tiltRange: [-2000, 9000], zoomRange: [0, 65535] });
  });

  it('②★ zoomRange 단독 지정(= 마스터 기동 실패를 냈던 형태) → 유효', () => {
    const r = CameraSourceConfigSchema.safeParse({ ...BASE, ptz: { zoomRange: [0, 16384] } });
    expect(r.success).toBe(true);
    expect(r.success && r.data.ptz?.zoomRange).toEqual([0, 16384]);
    // 지정하지 않은 축은 키 자체가 없어야 한다(빈 튜플·null 로 채우면 폴백이 깨진다).
    expect(r.success && r.data.ptz?.panRange).toBeUndefined();
    expect(r.success && r.data.ptz?.tiltRange).toBeUndefined();
  });

  it('③ ptz 자체 미지정(시뮬 소스) → 유효', () => {
    const r = CameraSourceConfigSchema.safeParse({ id: 'sim', kind: 'sim', baseUrl: 'http://localhost:13110' });
    expect(r.success).toBe(true);
    expect(r.success && r.data.ptz).toBeUndefined();
  });

  it('③-b 빈 ptz 객체 → 유효(전 축 폴백)', () => {
    expect(CameraSourceConfigSchema.safeParse({ ...BASE, ptz: {} }).success).toBe(true);
  });

  it('⑤ 형태 검증은 여전히 엄격 — 느슨해진 것은 "필수 여부"뿐', () => {
    // 2-튜플이 아님 / 숫자가 아님 / 객체가 아님 은 그대로 거부되어야 한다.
    expect(CameraSourceConfigSchema.safeParse({ ...BASE, ptz: { zoomRange: [0, 16384, 9] } }).success).toBe(false);
    expect(CameraSourceConfigSchema.safeParse({ ...BASE, ptz: { zoomRange: [0] } }).success).toBe(false);
    expect(CameraSourceConfigSchema.safeParse({ ...BASE, ptz: { zoomRange: ['0', '16384'] } }).success).toBe(false);
    expect(CameraSourceConfigSchema.safeParse({ ...BASE, ptz: { zoomRange: 16384 } }).success).toBe(false);
  });
});

// ── 실제 config 파일 ───────────────────────────────────────────────────────────
describe('실사용 config 로드 — 수정 10 적용 상태', () => {
  const tmp: string[] = [];
  afterEach(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); tmp.length = 0; });

  it('★ config/tools.config.json 이 throw 없이 로드된다(기동 실패 회귀 가드)', () => {
    expect(() => loadToolsConfig()).not.toThrow();
    const c = loadToolsConfig();
    const reals = (c.cameraSources ?? []).filter((s) => s.kind === 'hucoms');
    expect(reals.length).toBeGreaterThan(0);
    for (const s of reals) {
      // 수정 10: 실측 상한 16384(=2^14). pan/tilt 는 지정하지 않는다(기본값 복제 금지).
      expect(s.ptz?.zoomRange).toEqual([0, 16384]);
      expect(s.ptz?.panRange).toBeUndefined();
      expect(s.ptz?.tiltRange).toBeUndefined();
    }
    // 시뮬 소스는 ptz 블록 자체가 없다.
    for (const s of (c.cameraSources ?? []).filter((x) => x.kind === 'sim')) expect(s.ptz).toBeUndefined();
  });

  it('zoomRange 단독 소스를 담은 임시 config 도 로드된다(파일 경로 종단)', () => {
    const d = mkdtempSync(join(tmpdir(), 'ptzcfg-')); tmp.push(d);
    const p = join(d, 'tools.config.json');
    writeFileSync(p, JSON.stringify({ cameraSources: [{ ...BASE, ptz: { zoomRange: [0, 16384] } }] }), 'utf-8');
    expect(() => loadToolsConfig(p)).not.toThrow();
    expect(loadToolsConfig(p).cameraSources?.[0]?.ptz?.zoomRange).toEqual([0, 16384]);
  });
});

// ── ④ 스키마 ↔ RealPtzSource 축별 폴백 정합 ────────────────────────────────────
describe('④ 축별 optional 이 RealPtzSource 의 축별 기본값 폴백과 정합하는가', () => {
  /** goptzfpos 로 나가는 raw 목표를 관측한다(뷰어→raw 매핑 = 축별 range 의 유일한 관측 지점). */
  function rawTargetOf(cfg: CameraSourceConfig) {
    const src = new RealPtzSource(cfg, 7000, undefined, { pollMs: 0, timeoutMs: 1, sleep: async () => {} });
    const calls: Array<Record<string, number>> = [];
    Reflect.set(src, 'client', {
      goPtzfPosition: async (o: Record<string, number>) => { calls.push(o); return { values: {} }; },
      getPtzfPosition: async () => undefined, // 조회 미지원 → 정착 대기 즉시 반환
    });
    return { src, calls };
  }

  // 뷰어 좌표계 [1,36] · [-90,90] · [-180,180] 기준 기대 raw(기본 range).
  const DEF = { pan: [0, 35999], tilt: [-2000, 9000], zoom: [0, 65535] } as const;
  const mapExp = (v: number, from: [number, number], to: readonly [number, number]): number =>
    Math.round(to[0] + ((v - from[0]) / (from[1] - from[0])) * (to[1] - to[0]));

  it('ptz 미지정 → 3축 모두 HUCOMS 기본값', async () => {
    const { src, calls } = rawTargetOf({ ...BASE });
    await src.move(1, { pan: 0, tilt: 0, zoom: 36 });
    expect(calls[0]!.zoom).toBe(mapExp(36, [1, 36], DEF.zoom)); // 65535
  });

  it('★ zoomRange 만 지정 → zoom 은 지정값, pan/tilt 는 기본값(현재 실카 config 형태)', async () => {
    const { src: a, calls: ca } = rawTargetOf({ ...BASE, ptz: { zoomRange: [0, 16384] } });
    const { src: b, calls: cb } = rawTargetOf({ ...BASE }); // 대조: ptz 없음
    await a.move(1, { pan: 45, tilt: 30, zoom: 36 });
    await b.move(1, { pan: 45, tilt: 30, zoom: 36 });
    expect(ca[0]!.zoom).toBe(16384);        // 지정값이 먹는다 = 마스터 기동 실패의 목적 달성
    expect(cb[0]!.zoom).toBe(65535);        // 대조군
    expect(ca[0]!.pan).toBe(cb[0]!.pan);    // ★ 미지정 축은 기본값과 완전히 동일해야 한다
    expect(ca[0]!.tilt).toBe(cb[0]!.tilt);
  });

  it('★ panRange 만 지정 → pan 은 지정값, tilt/zoom 은 기본값(축 독립성)', async () => {
    const { src: a, calls: ca } = rawTargetOf({ ...BASE, ptz: { panRange: [0, 1000] } });
    const { src: b, calls: cb } = rawTargetOf({ ...BASE });
    await a.move(1, { pan: 180, tilt: 30, zoom: 36 });
    await b.move(1, { pan: 180, tilt: 30, zoom: 36 });
    expect(ca[0]!.pan).toBe(1000);          // 뷰어 pan 상한 → 지정 raw 상한
    expect(ca[0]!.pan).not.toBe(cb[0]!.pan);
    expect(ca[0]!.tilt).toBe(cb[0]!.tilt);  // 나머지 두 축은 오염되지 않는다
    expect(ca[0]!.zoom).toBe(cb[0]!.zoom);
  });

  it('tiltRange 만 지정 → tilt 만 바뀐다', async () => {
    const { src: a, calls: ca } = rawTargetOf({ ...BASE, ptz: { tiltRange: [0, 500] } });
    const { src: b, calls: cb } = rawTargetOf({ ...BASE });
    await a.move(1, { pan: 45, tilt: 90, zoom: 20 });
    await b.move(1, { pan: 45, tilt: 90, zoom: 20 });
    expect(ca[0]!.tilt).toBe(500);
    expect(ca[0]!.pan).toBe(cb[0]!.pan);
    expect(ca[0]!.zoom).toBe(cb[0]!.zoom);
  });
});
