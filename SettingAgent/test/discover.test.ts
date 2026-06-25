import { describe, it, expect } from 'vitest';
import { discoverViews } from '../src/setup/discover.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { CapturedImage } from '../src/domain/types.js';

const img = (camIdx: number, presetIdx: number): CapturedImage => ({
  camIdx, presetIdx, pan: 10 + presetIdx, tilt: 5, zoom: 2, imgName: 'x', jpg: Buffer.from('f'),
});

function camWith(existing: (cam: number, preset: number) => boolean): CameraClient {
  return {
    requestImage: async (cam: number, preset: number) => {
      if (!existing(cam, preset)) throw new Error('m_Cameras null / preset 없음');
      return img(cam, preset);
    },
  } as unknown as CameraClient;
}

const opts = { enabled: true, maxCameras: 32, maxPresetsPerCamera: 32 };

describe('discoverViews', () => {
  it('cam1 프리셋 2개 탐색 + 캡처 PTZ 보관', async () => {
    const camera = camWith((c, p) => c === 1 && p <= 2);
    const v = await discoverViews(camera, opts);
    expect(v.map((x) => `${x.camIdx}:${x.presetIdx}`)).toEqual(['1:1', '1:2']);
    expect(v[0]).toMatchObject({ pan: 11, tilt: 5, zoom: 2 }); // 캡처 응답의 PTZ
  });

  it('카메라 2대, 각 프리셋 수 다름', async () => {
    const camera = camWith((c, p) => (c === 1 && p <= 3) || (c === 2 && p === 1));
    const v = await discoverViews(camera, opts);
    expect(v.map((x) => `${x.camIdx}:${x.presetIdx}`)).toEqual(['1:1', '1:2', '1:3', '2:1']);
  });

  it('cam1 preset1 부터 에러면 빈 목록', async () => {
    expect(await discoverViews(camWith(() => false), opts)).toEqual([]);
  });

  it('항상 성공하면 상한으로 폭주 방지', async () => {
    const v = await discoverViews(camWith(() => true), { enabled: true, maxCameras: 2, maxPresetsPerCamera: 3 });
    expect(v).toHaveLength(6);
  });
});
