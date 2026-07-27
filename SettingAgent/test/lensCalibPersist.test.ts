import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLensCalibFile, setLensCalibEnabled, upsertLensCalibration } from '../src/calibrate/lensCalibFile.js';
import { loadLensCorrector } from '../src/calibrate/lensCorrection.js';

/**
 * data/lens_calibration.json 쓰기 검증. 읽기(loadLensCorrector)와의 왕복까지 본다 —
 * writer 가 만든 파일을 reader 가 못 읽으면 표를 만들어도 조준에 안 걸린다.
 */

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lenscalibfile-'));
  file = join(dir, 'lens_calibration.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const read = (): { _comment?: string; cameras: Array<Record<string, unknown>> } => JSON.parse(readFileSync(file, 'utf8'));

describe('upsertLensCalibration', () => {
  it('파일이 없으면 새로 만든다', () => {
    upsertLensCalibration(file, 'cam-a', { zoomHfov: [{ z: 0, h: 62 }] as never });
    expect(read().cameras).toHaveLength(1);
    expect(read().cameras[0]).toMatchObject({ id: 'cam-a', enabled: false });
  });

  it('깨진 JSON 도 쓰기를 막지 않는다(읽기 실패 ≠ 쓰기 실패)', () => {
    writeFileSync(file, '{ not json', 'utf8');
    upsertLensCalibration(file, 'cam-a', { zoomHfov: [{ z: 0, h: 62 }] as never });
    expect(read().cameras).toHaveLength(1);
  });

  it('★ 다른 카메라 항목과 주석을 보존한다(전량 재작성 금지)', () => {
    writeFileSync(
      file,
      JSON.stringify({
        _comment: '설명 문구',
        cameras: [
          { id: 'other', model: 'cam-001', enabled: true, host: '192.168.0.153' },
          { id: 'cam-a', model: 'cam-001', enabled: true },
        ],
      }),
      'utf8',
    );
    upsertLensCalibration(file, 'cam-a', { zoomHfov: [{ z: 0, h: 62 }] as never });

    const f = read();
    expect(f._comment).toBe('설명 문구');
    expect(f.cameras).toHaveLength(2);
    expect(f.cameras.find((c) => c.id === 'other')).toEqual({ id: 'other', model: 'cam-001', enabled: true, host: '192.168.0.153' });
  });

  it('★ 새 표는 항상 enabled:false — 기존이 true 였어도 강등한다(검증 전 자동적용 금지)', () => {
    writeFileSync(file, JSON.stringify({ cameras: [{ id: 'cam-a', model: 'cam-001', enabled: true }] }), 'utf8');
    const entry = upsertLensCalibration(file, 'cam-a', { centeringGain: [{ z: 0, k: 0.99 }] as never });
    expect(entry.enabled).toBe(false);
    expect(read().cameras[0]!.enabled).toBe(false);
  });

  it('실측 표가 들어오면 model(프리셋 상속)을 떨어뜨린다 — 두 출처 공존 금지', () => {
    writeFileSync(file, JSON.stringify({ cameras: [{ id: 'cam-a', model: 'cam-001', enabled: true }] }), 'utf8');
    upsertLensCalibration(file, 'cam-a', { zoomHfov: [{ z: 0, h: 62 }] as never });
    expect(read().cameras[0]!.model).toBeUndefined();
  });

  it('곡면율만 쓰면 기존 화각·게인 표는 남는다(축끼리 서로 지우지 않는다)', () => {
    upsertLensCalibration(file, 'cam-a', { zoomHfov: [{ z: 0, h: 62 }] as never, centeringGain: [{ z: 0, k: 0.99 }] as never });
    upsertLensCalibration(file, 'cam-a', { lensDistortion: [{ z: 0, k1: -0.12 }] as never });

    const e = read().cameras[0]!;
    expect(e.zoomHfov).toHaveLength(1);
    expect(e.centeringGain).toHaveLength(1);
    expect(e.lensDistortion).toHaveLength(1);
    // 곡면율만 갱신했으므로 model 제거 규칙은 발동하지 않는다(이미 지워졌지만 화각은 보존).
  });

  it('영속화 수치는 소수점 최대 5자리(프로젝트 규약)', () => {
    upsertLensCalibration(file, 'cam-a', { centeringGain: [{ z: 0, k: 0.9881234567 }] as never });
    expect(readFileSync(file, 'utf8')).toContain('0.98812');
    expect(readFileSync(file, 'utf8')).not.toContain('0.9881234567');
  });
});

describe('setLensCalibEnabled', () => {
  it('표가 있는 카메라를 켜고 끈다', () => {
    upsertLensCalibration(file, 'cam-a', { zoomHfov: [{ z: 0, h: 62 }] as never });
    expect(setLensCalibEnabled(file, 'cam-a', true)?.enabled).toBe(true);
    expect(read().cameras[0]!.enabled).toBe(true);
    expect(setLensCalibEnabled(file, 'cam-a', false)?.enabled).toBe(false);
  });

  it('없는 카메라 → null (파일 무변경)', () => {
    upsertLensCalibration(file, 'cam-a', { zoomHfov: [{ z: 0, h: 62 }] as never });
    expect(setLensCalibEnabled(file, 'nope', true)).toBeNull();
    expect(read().cameras).toHaveLength(1);
  });

  it('표가 비어 있으면 켤 수 없다 — 켜도 항등이라 "켰는데 아무 일도 없음" 이 된다', () => {
    writeFileSync(file, JSON.stringify({ cameras: [{ id: 'cam-a' }] }), 'utf8');
    expect(setLensCalibEnabled(file, 'cam-a', true)).toBeNull();
  });

  it('다른 카메라 항목을 건드리지 않는다', () => {
    writeFileSync(file, JSON.stringify({ cameras: [{ id: 'other', model: 'cam-001', enabled: true }, { id: 'cam-a', model: 'cam-001', enabled: false }] }), 'utf8');
    setLensCalibEnabled(file, 'cam-a', true);
    expect(read().cameras.find((c) => c.id === 'other')!.enabled).toBe(true);
  });
});

describe('reader 왕복 — writer 산출물이 실제 보정으로 걸리는가', () => {
  it('enabled:false 면 항등, apply 후에는 보정이 걸린다', () => {
    upsertLensCalibration(file, 'cam-a', {
      zoomHfov: [
        { z: 0, h: 62 },
        { z: 16384, h: 2 },
      ] as never,
      centeringGain: [
        { z: 0, k: 0.9 },
        { z: 16384, k: 1.1 },
      ] as never,
    });

    const off = loadLensCorrector(file, 'cam-a');
    const p = { x: 0.9, y: 0.2 };
    expect(off.correct(p, 8000)).toEqual(p); // 비활성 → 입력 그대로

    setLensCalibEnabled(file, 'cam-a', true);
    const on = loadLensCorrector(file, 'cam-a');
    expect(on.correct(p, 8000)).not.toEqual(p); // 활성 → 게인 적용
  });

  it('readLensCalibFile 은 없는 파일에 빈 구조를 준다', () => {
    expect(readLensCalibFile(join(dir, 'nope.json'))).toEqual({});
  });
});
