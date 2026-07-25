import { describe, expect, it } from 'vitest';
import { CameraCalibration } from '../src/calibration.js';
import { PtzGeometry, basis, dot3, wrapCd } from '../src/geometry.js';
import { TRUE_DISTORTION } from '../mock/mockCamera.js';

const cal = CameraCalibration.from('cam-001');
const geo = new PtzGeometry({ calibration: cal });

describe('부호 규약 (실기 실측 확정 — 여기가 깨지면 조준이 반대로 간다)', () => {
  it('화면 오른쪽 점을 중앙으로 보내려면 panpos 를 **증가**시킨다 (panpos+ = 시계방향)', () => {
    const d = geo.pixelToDelta({ x: 1440, y: 540, zoom: 0, tiltCd: 0 });
    expect(d.panDelta).toBeGreaterThan(0);
    // 왼쪽은 반대
    expect(geo.pixelToDelta({ x: 480, y: 540, zoom: 0, tiltCd: 0 }).panDelta).toBeLessThan(0);
  });

  it('화면 아래 점을 중앙으로 보내려면 tiltpos 를 **증가**시킨다 (tiltpos+ = 아래를 봄)', () => {
    const d = geo.pixelToDelta({ x: 960, y: 800, zoom: 0, tiltCd: 0 });
    expect(d.tiltDelta).toBeGreaterThan(0);
    expect(geo.pixelToDelta({ x: 960, y: 280, zoom: 0, tiltCd: 0 }).tiltDelta).toBeLessThan(0);
  });

  it('중심 클릭은 움직이지 않는다', () => {
    expect(geo.pixelToDelta({ x: 960, y: 540, zoom: 0, tiltCd: 1681 })).toEqual({ panDelta: 0, tiltDelta: 0 });
  });
});

describe('짐벌 커플링 (팬 축이 월드 수직축이라는 사실의 결과)', () => {
  it('★틸트가 걸려 있으면 가로로만 클릭해도 틸트가 딸려 온다', () => {
    // 참조본 실기 실측: 와이드·틸트 16.81°에서 dx=480 클릭에 dtilt ≈ −62cd.
    const d = geo.pixelToDelta({ x: 960 + 480, y: 540, zoom: 0, tiltCd: 1681 });
    expect(d.tiltDelta).toBeLessThan(0);
    expect(Math.abs(d.tiltDelta)).toBeGreaterThan(50);
    expect(Math.abs(d.tiltDelta)).toBeLessThan(75);
  });

  it('틸트가 0 이면 커플링이 없다 — 가로 클릭은 순수 팬', () => {
    const d = geo.pixelToDelta({ x: 960 + 480, y: 540, zoom: 0, tiltCd: 0 });
    expect(d.tiltDelta).toBe(0);
  });

  it('커플링은 틸트가 커질수록 커진다', () => {
    const a = Math.abs(geo.pixelToDelta({ x: 1440, y: 540, zoom: 0, tiltCd: 600 }).tiltDelta);
    const b = Math.abs(geo.pixelToDelta({ x: 1440, y: 540, zoom: 0, tiltCd: 3300 }).tiltDelta);
    expect(b).toBeGreaterThan(a);
  });
});

describe('곡면율 연동', () => {
  const calD = CameraCalibration.from({ model: 'cam-001', lensDistortion: TRUE_DISTORTION });
  const geoD = new PtzGeometry({ calibration: calD });

  it('★조준은 기본으로 곡면율을 편다 — 배럴이면 더 크게 돈다', () => {
    const plain = geo.pixelToDelta({ x: 1800, y: 540, zoom: 0, tiltCd: 0 });
    const withD = geoD.pixelToDelta({ x: 1800, y: 540, zoom: 0, tiltCd: 0 });
    expect(Math.abs(withD.panDelta)).toBeGreaterThan(Math.abs(plain.panDelta));
  });

  it('undistort:false 는 펌웨어를 흉내낼 때만 — 그때는 곡면율이 없는 것과 같다', () => {
    const off = geoD.pixelToDelta({ x: 1800, y: 540, zoom: 0, tiltCd: 0, undistort: false });
    const plain = geo.pixelToDelta({ x: 1800, y: 540, zoom: 0, tiltCd: 0 });
    expect(off).toEqual(plain);
  });

  it('표가 없으면 undistort 플래그가 아무 영향이 없다 (회귀 고정)', () => {
    expect(geo.pixelToDelta({ x: 1800, y: 900, zoom: 5129, tiltCd: 1200, undistort: true })).toEqual(
      geo.pixelToDelta({ x: 1800, y: 900, zoom: 5129, tiltCd: 1200, undistort: false }),
    );
  });
});

describe('pixelToTarget / directionToPixel 왕복', () => {
  it('조준한 방향은 이동 후 화면 중앙에 온다', () => {
    const ptz = { panpos: 4500, tiltpos: 1200, zoompos: 5129 };
    const target = geo.pixelToTarget({ x: 1500, y: 300, ptz });
    const back = geo.directionToPixel({ view: { ...target, zoompos: ptz.zoompos }, target });
    expect(back.xExact).toBeCloseTo(960, 0);
    expect(back.yExact).toBeCloseTo(540, 0);
  });

  it('원래 자세에서 역투영하면 클릭한 자리로 돌아온다', () => {
    const ptz = { panpos: 4500, tiltpos: 1200, zoompos: 5129 };
    const target = geo.pixelToTarget({ x: 1500, y: 300, ptz });
    const back = geo.directionToPixel({ view: ptz, target });
    // pixelToTarget 이 정수 centidegree 로 반올림하므로 1px 수준의 오차는 남는다.
    expect(back.xExact).toBeCloseTo(1500, -1);
    expect(back.yExact).toBeCloseTo(300, -1);
  });

  it('뒤쪽 방향은 behind 로 보고한다', () => {
    const ptz = { panpos: 0, tiltpos: 0, zoompos: 0 };
    const r = geo.directionToPixel({ view: ptz, target: { panpos: 18000, tiltpos: 0 } });
    expect(r.behind).toBe(true);
    expect(r.inFrame).toBe(false);
  });
});

describe('basis / wrapCd', () => {
  it('기저는 정규직교이고 R 은 항상 수평이다 (롤 없는 짐벌)', () => {
    for (const [pan, tilt] of [
      [0, 0],
      [4500, 1681],
      [30000, -1500],
      [12345, 8000],
    ] as const) {
      const b = basis(pan, tilt);
      expect(dot3(b.F, b.F)).toBeCloseTo(1, 9);
      expect(dot3(b.R, b.R)).toBeCloseTo(1, 9);
      expect(dot3(b.U, b.U)).toBeCloseTo(1, 9);
      expect(dot3(b.F, b.R)).toBeCloseTo(0, 9);
      expect(dot3(b.F, b.U)).toBeCloseTo(0, 9);
      expect(b.R[2]).toBe(0); // 수평
    }
  });

  it('wrapCd 는 0/36000 이음매를 넘긴다', () => {
    expect(wrapCd(100, 35900)).toBe(200);
    expect(wrapCd(35900, 100)).toBe(-200);
    expect(wrapCd(4500, 4500)).toBe(0);
  });
});
