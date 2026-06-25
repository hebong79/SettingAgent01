import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCamerapos } from '../src/setup/cameraposWriter.js';
import { parseCameraViews, viewsToTargets, type CameraView } from '../src/setup/mapTargets.js';
import { readFileSync } from 'node:fs';

const views: CameraView[] = [
  { camIdx: 1, presetIdx: 1, label: 'C1-P1', pan: 30, tilt: 12, zoom: 2 },
  { camIdx: 1, presetIdx: 2, label: 'C1-P2', pan: 95, tilt: 12, zoom: 2.5 },
  { camIdx: 2, presetIdx: 1, label: 'C2-P1', pan: 200, tilt: 10, zoom: 3 },
];

describe('writeCamerapos (왕복 호환)', () => {
  it('저장한 파일을 parseCameraViews 가 동일하게 다시 읽음', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cpos-'));
    try {
      const path = join(dir, 'camerapos.json');
      writeCamerapos(views, path);
      const reparsed = parseCameraViews(JSON.parse(readFileSync(path, 'utf-8')));
      expect(reparsed.map((v) => `${v.camIdx}:${v.presetIdx}`)).toEqual(['1:1', '1:2', '2:1']);
      // PTZ 보존
      expect(reparsed[0]).toMatchObject({ pan: 30, tilt: 12, zoom: 2, label: 'C1-P1' });
      // 타겟 변환까지 일치
      expect(viewsToTargets(reparsed)[2].ptz).toEqual({ pan: 200, tilt: 10, zoom: 3 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('PTZ 없는 뷰도 저장/재파싱(PTZ 미포함)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cpos-'));
    try {
      const path = join(dir, 'camerapos.json');
      writeCamerapos([{ camIdx: 1, presetIdx: 1, label: 'P1' }], path);
      const reparsed = parseCameraViews(JSON.parse(readFileSync(path, 'utf-8')));
      expect(reparsed[0].pan).toBeUndefined();
      expect(reparsed[0].presetIdx).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
