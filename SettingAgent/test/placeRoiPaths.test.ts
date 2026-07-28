import { describe, it, expect } from 'vitest';
import { autoPlaceRoiPathOf, backupPlaceRoiPathOf, fileNameOf } from '../src/capture/placeRoiPaths.js';

/**
 * L3 후속 Loop 2 — 파생 경로(순수). 신규 config 키 0 이므로 이 파생이 **세 파일의 짝**을 보장하는 유일한 근거다.
 * 구분자는 입력 문자열 그대로 보존해야 한다(node:path 정규화로 `/`→`\` 가 되면 배포 스크립트가 어긋난다).
 */
describe('autoPlaceRoiPathOf', () => {
  it('확장자 앞에 _auto 를 붙인다', () => {
    expect(autoPlaceRoiPathOf('data/Place01/PtzCamRoi.json')).toBe('data/Place01/PtzCamRoi_auto.json');
  });

  it('구분자를 원본 그대로 보존한다(posix/win 혼용)', () => {
    expect(autoPlaceRoiPathOf('D:\\data\\Place01\\PtzCamRoi.json')).toBe('D:\\data\\Place01\\PtzCamRoi_auto.json');
    expect(autoPlaceRoiPathOf('PtzCamRoi.json')).toBe('PtzCamRoi_auto.json');
  });

  it('확장자가 없으면 뒤에 _auto', () => {
    expect(autoPlaceRoiPathOf('data/PtzCamRoi')).toBe('data/PtzCamRoi_auto');
  });

  it('이름에 점이 여러 개면 마지막 점만 확장자로 본다', () => {
    expect(autoPlaceRoiPathOf('data/PtzCamRoi.v2.json')).toBe('data/PtzCamRoi.v2_auto.json');
  });
});

describe('backupPlaceRoiPathOf', () => {
  it('ISO → 파일명 안전 타임스탬프(밀리초 제거·구분자 제거)', () => {
    expect(backupPlaceRoiPathOf('data/Place01/PtzCamRoi.json', '2026-07-28T10:15:30.123Z')).toBe(
      'data/Place01/PtzCamRoi.20260728T101530Z.bak.json',
    );
  });

  it('파일명에 경로·콜론 등 위험 문자가 남지 않는다', () => {
    const name = fileNameOf(backupPlaceRoiPathOf('data/PtzCamRoi.json', new Date().toISOString()));
    expect(name).toMatch(/^PtzCamRoi\.[0-9A-Za-z]+\.bak\.json$/);
  });

  it('승인 시각이 다르면 서로 다른 백업 파일이 된다(덮어쓰지 않는다)', () => {
    const a = backupPlaceRoiPathOf('p/PtzCamRoi.json', '2026-07-28T10:15:30.000Z');
    const b = backupPlaceRoiPathOf('p/PtzCamRoi.json', '2026-07-28T10:15:31.000Z');
    expect(a).not.toBe(b);
  });
});

describe('fileNameOf', () => {
  it('구분자 뒤만 남긴다(서버 절대경로 노출 방지)', () => {
    expect(fileNameOf('D:\\a\\b\\PtzCamRoi_auto.json')).toBe('PtzCamRoi_auto.json');
    expect(fileNameOf('a/b/PtzCamRoi_auto.json')).toBe('PtzCamRoi_auto.json');
    expect(fileNameOf('PtzCamRoi_auto.json')).toBe('PtzCamRoi_auto.json');
  });
});
