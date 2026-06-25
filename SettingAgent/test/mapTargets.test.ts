import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCameraViews, viewsToTargets, parseFaceGroups, loadSetupTargets, loadExpectedFaces } from '../src/setup/mapTargets.js';

describe('parseCameraViews', () => {
  it('형식 A (카메라별 그룹) + PTZ 추출(pan/tilt/zoom 직접)', () => {
    const json = {
      datas: [
        { cam_id: 1, datas: [{ cam_id: 1, preset_id: 1, sname: 'C1P1', pan: 30, tilt: 12, zoom: 2 }] },
      ],
    };
    const views = parseCameraViews(json);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ camIdx: 1, presetIdx: 1, label: 'C1P1', pan: 30, tilt: 12, zoom: 2 });
  });

  it('형식 B (단일 카메라, idx 0-based → +1)', () => {
    const json = { datas: [{ idx: 0, sname: 'P1' }, { idx: 1, sname: 'P2' }] };
    const views = parseCameraViews(json);
    expect(views.map((v) => v.presetIdx)).toEqual([1, 2]);
    expect(views[0].pan).toBeUndefined();
  });
});

describe('viewsToTargets', () => {
  it('cam→preset 정렬, PTZ 보유 시 ptz 포함', () => {
    const targets = viewsToTargets([
      { camIdx: 2, presetIdx: 1, label: 'b' },
      { camIdx: 1, presetIdx: 2, label: 'a', pan: 95, tilt: 12, zoom: 2.5 },
      { camIdx: 1, presetIdx: 1, label: 'c' },
    ]);
    expect(targets.map((t) => `${t.camIdx}:${t.presetIdx}`)).toEqual(['1:1', '1:2', '2:1']);
    expect(targets[1].ptz).toEqual({ pan: 95, tilt: 12, zoom: 2.5 });
    expect(targets[0].ptz).toBeUndefined();
  });
});

describe('parseFaceGroups', () => {
  it('faceCount 추출', () => {
    const faces = parseFaceGroups({ datas: [{ camIdx: 1, idx: 1, faceCount: 4 }] });
    expect(faces[0]).toEqual({ camIdx: 1, presetIdx: 1, faceCount: 4 });
  });
});

describe('loadSetupTargets', () => {
  it('camerapos 파일 로딩 → cam→preset 정렬 타겟', () => {
    // 라이브 config/camerapos.json 은 refreshOnRun 으로 바뀌므로 픽스처 파일로 검증.
    const dir = mkdtempSync(join(tmpdir(), 'mt-'));
    try {
      const path = join(dir, 'camerapos.json');
      writeFileSync(path, JSON.stringify({
        datas: [{ cam_id: 1, datas: [
          { cam_id: 1, preset_id: 1, sname: 'C1-P1', pan: 30, tilt: 12, zoom: 2 },
          { cam_id: 1, preset_id: 2, sname: 'C1-P2', pan: 95, tilt: 12, zoom: 2.5 },
        ] }],
      }));
      const targets = loadSetupTargets({ cameraposFile: path });
      expect(targets.map((t) => `${t.camIdx}:${t.presetIdx}`)).toEqual(['1:1', '1:2']);
      expect(targets[0].ptz).toEqual({ pan: 30, tilt: 12, zoom: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('파일 없으면 throw', () => {
    expect(() => loadSetupTargets({ cameraposFile: 'config/__none__.json' })).toThrow();
  });
});

describe('loadExpectedFaces', () => {
  it('preset.json → key별 기대 슬롯 수', () => {
    const m = loadExpectedFaces('config/preset.json');
    expect(m['1:1']).toBe(2);
    expect(m['1:2']).toBe(3);
    expect(m['2:1']).toBe(1);
  });

  it('파일 없거나 미지정이면 빈 맵', () => {
    expect(loadExpectedFaces(undefined)).toEqual({});
    expect(loadExpectedFaces('config/__none__.json')).toEqual({});
  });
});
