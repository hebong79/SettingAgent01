// roi.auto.* RPC 계약 테스트 — 카탈로그 메타 · confirm 게이트 · D-5 초록 오염 가드 · 스키마.
//
// ★ 정본·DB 를 건드리지 않는다: 정본 파일은 임시 디렉터리에 복제해서만 쓴다(D-6).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { METHODS, buildMethodMap } from '../src/rpc/methods.js';
import {
  GREEN_RATIO_LIMIT,
  RoiAutoApplySchema,
  RoiAutoDetectSchema,
  greenPixelRatio,
  roiAutoApply,
  roiAutoDetect,
  roiAutoScore,
} from '../src/rpc/services/roiAuto.js';
import { RpcMethodError } from '../src/rpc/errors.js';
import type { RpcContext } from '../src/rpc/types.js';

describe('roi.auto.* 카탈로그 계약(R6)', () => {
  const map = buildMethodMap(METHODS);

  it('3종이 등록되어 있고 이름이 중복되지 않는다', () => {
    expect(map.has('roi.auto.detect')).toBe(true);
    expect(map.has('roi.auto.score')).toBe(true);
    expect(map.has('roi.auto.apply')).toBe(true);
    expect(map.size).toBe(METHODS.length);
  });

  it('detect/score 는 무해(mutating:false), apply 만 파괴적이다', () => {
    expect(map.get('roi.auto.detect')!.mutating).toBe(false);
    expect(map.get('roi.auto.score')!.mutating).toBe(false);
    const apply = map.get('roi.auto.apply')!;
    expect(apply.mutating).toBe(true);
    expect(apply.destructive).toBe(true);
  });

  it('3종 전부 requiresCamera:true — 프레임이 반드시 필요하다(기존 place.* 와의 결정적 차이)', () => {
    for (const n of ['roi.auto.detect', 'roi.auto.score', 'roi.auto.apply']) {
      expect(map.get(n)!.requiresCamera, n).toBe(true);
      expect(map.get(n)!.stability, n).toBe('experimental');
      expect(map.get(n)!.requires, n).toEqual(['camera', 'placeRoiFile']);
    }
  });

  it('기존 grid.* 3종은 그대로 살아 있다(무접촉)', () => {
    for (const n of ['grid.bootstrap', 'grid.apply', 'grid.get']) expect(map.has(n)).toBe(true);
  });

  it('apply 는 confirm:true 없이는 거부한다', async () => {
    const def = map.get('roi.auto.apply')!;
    await expect(def.handler!({ presets: [1] }, {} as RpcContext)).rejects.toThrow(/confirm:true/);
  });
});

describe('roi.auto.* 스키마', () => {
  it('detect 는 슬롯 치수 기본값을 준다', () => {
    const p = RoiAutoDetectSchema.parse({});
    expect(p.slotWidthM).toBe(2.5);
    expect(p.slotDepthM).toBe(5.0);
    expect(p.cameraHeightM).toBe(5.0);
  });

  it('apply 는 confirm 리터럴과 presets 를 요구한다', () => {
    expect(() => RoiAutoApplySchema.parse({ presets: [1] })).toThrow();
    expect(() => RoiAutoApplySchema.parse({ confirm: true, presets: [] })).toThrow();
    const p = RoiAutoApplySchema.parse({ confirm: true, presets: [1] });
    expect(p.minIoU).toBe(0.98);
  });
});

describe('D-5 초록 합성 단서 가드', () => {
  it('판정식은 리더 실측 그대로다: g>110 && g−r>55 && g−b>55', () => {
    const rgb = new Uint8Array([
      20, 200, 20, // 채도 높은 초록 → 검출
      200, 200, 200, // 흰색(도색선) → 미검출
      20, 100, 20, // 어두운 초록(g≤110) → 미검출
      20, 200, 160, // 청록(g−b=40) → 미검출
    ]);
    expect(greenPixelRatio(rgb)).toBeCloseTo(0.25, 9);
  });

  it('빈 입력은 0(throw 금지)', () => {
    expect(greenPixelRatio(new Uint8Array())).toBe(0);
  });

  it('임계는 0.1% 다', () => {
    expect(GREEN_RATIO_LIMIT).toBe(0.001);
  });
});

describe('roi.auto.* 의존성 강등', () => {
  const ctx = (deps: Partial<RpcContext['deps']>): RpcContext => ({ app: {} as never, deps: deps as RpcContext['deps'] });

  it('placeRoiFile 미설정이면 UNAVAILABLE', async () => {
    await expect(roiAutoDetect({}, ctx({}))).rejects.toBeInstanceOf(RpcMethodError);
    await expect(roiAutoDetect({}, ctx({}))).rejects.toThrow(/place-roi 미설정/);
  });

  it('정본 파일이 없으면 NOT_FOUND(정본 무변경)', async () => {
    await expect(roiAutoScore({}, ctx({ placeRoiFile: join(tmpdir(), 'no-such-PtzCamRoi.json') }))).rejects.toThrow(
      /PtzCamRoi.json 없음/,
    );
  });
});

describe('roi.auto.apply — 임시 정본 대상 안전 규약(D-6: 실제 정본에 쓰지 않는다)', () => {
  let dir: string;
  let file: string;

  const PLACE = {
    cameras: [
      {
        camera: { cam_id: 1, imageWidth: 1920, imageHeight: 1080 },
        presets: [
          {
            preset_idx: 1,
            parking_spaces: [
              { idx: 1, points: [[100, 900], [120, 700], [400, 700], [420, 900]] },
              { idx: 2, points: [[420, 900], [400, 700], [680, 700], [740, 900]] },
              { idx: 3, points: [[740, 900], [680, 700], [960, 700], [1060, 900]] },
            ],
          },
        ],
      },
    ],
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'roiauto-'));
    file = join(dir, 'PtzCamRoi.json');
    writeFileSync(file, JSON.stringify(PLACE, null, 2), 'utf8');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** 프레임을 못 주는 카메라 시임 — apply 가 정본에 손대기 전에 끊기는지 본다. */
  const brokenCamera = {
    clampZoom: (z: number) => z,
    health: async () => true,
    requestImage: async () => {
      throw new Error('카메라 없음(테스트)');
    },
  } as unknown as NonNullable<RpcContext['deps']['camera']>;

  const ctxOf = (): RpcContext =>
    ({ app: {} as never, deps: { placeRoiFile: file, camera: brokenCamera } } as RpcContext);

  it('카메라 미배선이면 UNAVAILABLE 이고 정본은 그대로다', async () => {
    const before = readFileSync(file, 'utf8');
    await expect(roiAutoDetect({}, { app: {} as never, deps: { placeRoiFile: file } } as RpcContext)).rejects.toThrow(
      /카메라 미배선/,
    );
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('프레임 취득 실패는 UPSTREAM 이고 정본·백업 모두 생기지 않는다', async () => {
    const before = readFileSync(file, 'utf8');
    await expect(roiAutoApply({ confirm: true, presets: [1] }, ctxOf())).rejects.toThrow(/프레임 취득 실패/);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readdirSync(dir).filter((f) => f.includes('.bak'))).toEqual([]);
  });

  it('expectTotal 불일치는 CONFLICT 이고 프레임을 취득하기도 전에 끊는다', async () => {
    const before = readFileSync(file, 'utf8');
    await expect(roiAutoApply({ confirm: true, presets: [1], expectTotal: 99 }, ctxOf())).rejects.toThrow(
      /전체 주차면 개수 불일치/,
    );
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});
