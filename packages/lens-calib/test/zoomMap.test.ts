import { describe, expect, it } from 'vitest';
import { CameraCalibration } from '../src/calibration.js';
import { ZoomMap } from '../src/zoomMap.js';

const cal = CameraCalibration.from('cam-001');
const map = new ZoomMap(cal);

describe('ZoomMap — zoompos ↔ 배율', () => {
  it('광각단이 배율 1.0 이다', () => {
    expect(map.scaleAt(0)).toBeCloseTo(1, 9);
    expect(map.baseHfov).toBeCloseTo(57.14, 6);
  });

  it('배율은 줌에 대해 단조 증가한다', () => {
    let prev = 0;
    for (const z of [0, 2000, 5129, 8000, 12161, 15000, 16384]) {
      const s = map.scaleAt(z);
      expect(s).toBeGreaterThan(prev);
      prev = s;
    }
  });

  it('왕복(zoomPosFor ∘ scaleAt)이 원래 값을 준다', () => {
    for (const z of [0, 1000, 5129, 9000, 15400, 16384]) {
      expect(map.zoomPosFor(map.scaleAt(z))).toBeCloseTo(z, 6);
    }
  });

  it('★정의역 밖은 클램프한다 — 광학이 포화하므로 외삽은 거짓말이다', () => {
    expect(map.scaleAt(99999)).toBeCloseTo(map.scaleAt(16384), 9);
    expect(map.zoomPosFor(1000)).toBe(16384);
    expect(map.zoomPosFor(0.1)).toBe(0);
  });

  it('★선형 매핑(mapRange)과 크게 다르다 — 그것이 이 모듈이 존재하는 이유', () => {
    // 뷰어의 현행 mapRange 는 zoom 1~36 을 zoompos 0~16384 에 **선형**으로 얹는다.
    const linearZoomPos = (scale: number): number => ((scale - 1) / (36 - 1)) * 16384;
    // 배율 7배: 실측표는 훨씬 큰 레지스터 값을 요구한다.
    const measured = map.zoomPosFor(7);
    expect(Math.abs(measured - linearZoomPos(7))).toBeGreaterThan(3000);
  });

  it('★표가 말하는 최대 배율은 OSD 표기(x36)와 다르다 — 기록해 둔 불일치', () => {
    const maxScale = map.scaleDomain[1];
    expect(maxScale).toBeGreaterThan(20);
    expect(maxScale).toBeLessThan(30); // ≈26x
  });

  it('화각이 단조 감소하지 않는 표는 거부한다(역함수 정의 불가)', () => {
    const broken = new CameraCalibration({
      zoomHfov: [
        { z: 0, h: 30 },
        { z: 1000, h: 40 },
      ],
    });
    expect(() => new ZoomMap(broken)).toThrow(/단조/);
  });
});
