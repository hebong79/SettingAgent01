import { describe, it, expect } from 'vitest';
import { buildCameraList } from '../src/viewer/cameraposCatalog.js';
import type { CameraView } from '../src/setup/mapTargets.js';
import { findPresetPtz } from '../web/core.js';

/**
 * buildCameraList(views, devices?) 순수 변환 검증(설계서 §단계1).
 * CameraView[] → CameraList: camIdx 그룹핑 + presetIdx 정렬 + PTZ 보존 + device 병합(name/enabled).
 */
describe('buildCameraList — camerapos views → CameraList (순수)', () => {
  const views: CameraView[] = [
    { camIdx: 1, presetIdx: 2, label: 'C1-P2', pan: 95, tilt: 10, zoom: 2.5 },
    { camIdx: 1, presetIdx: 1, label: 'C1-P1', pan: 22, tilt: 6.8, zoom: 1.6 },
    { camIdx: 1, presetIdx: 3, label: 'C1-P3', pan: 200, tilt: 12, zoom: 3 },
    { camIdx: 2, presetIdx: 1, label: 'C2-P1', pan: 40, tilt: 5, zoom: 4 },
  ];

  it('(a) camIdx 그룹핑 + presetIdx 오름차순 정렬', () => {
    const list = buildCameraList(views);
    expect(list.cameras.map((c) => c.camIdx)).toEqual([1, 2]);
    expect(list.cameras[0].presets.map((p) => p.presetIdx)).toEqual([1, 2, 3]);
    expect(list.cameras[1].presets.map((p) => p.presetIdx)).toEqual([1]);
  });

  it('(b) PTZ(pan/tilt/zoom) + label 보존', () => {
    const list = buildCameraList(views);
    expect(list.cameras[0].presets[0]).toEqual({ presetIdx: 1, label: 'C1-P1', pan: 22, tilt: 6.8, zoom: 1.6 });
    expect(list.cameras[0].presets[2]).toMatchObject({ presetIdx: 3, pan: 200, tilt: 12, zoom: 3 });
  });

  it('(c) devices 없음 → name=`C{camIdx}`, enabled=false([off])', () => {
    const list = buildCameraList(views);
    expect(list.cameras[0]).toMatchObject({ camIdx: 1, name: 'C1', enabled: false });
    expect(list.cameras[1]).toMatchObject({ camIdx: 2, name: 'C2', enabled: false });
  });

  it('(d) devices 병합 → name 매핑 + enabled=true', () => {
    const list = buildCameraList(views, [{ camId: 1, name: 'North Gate' }]);
    // cam1: device 존재 → name=device.name, enabled=true
    expect(list.cameras[0]).toMatchObject({ camIdx: 1, name: 'North Gate', enabled: true });
    // cam2: device 목록에 없음 → name 폴백, enabled=false
    expect(list.cameras[1]).toMatchObject({ camIdx: 2, name: 'C2', enabled: false });
  });

  it('(e) device 이름 없음(name undefined) → `C{camIdx}` 폴백이지만 enabled=true', () => {
    const list = buildCameraList(views, [{ camId: 1 }]);
    expect(list.cameras[0]).toMatchObject({ camIdx: 1, name: 'C1', enabled: true });
  });

  it('(f) 빈 입력 → { cameras: [] }', () => {
    expect(buildCameraList([])).toEqual({ cameras: [] });
    expect(buildCameraList([], [{ camId: 1, name: 'x' }])).toEqual({ cameras: [] });
  });

  it('(g) 카메라 집합은 파일(views) 기준 — device 전용 항목은 미표시(A2)', () => {
    // device 에 cam3 이 있어도 views 에 없으면 목록에 나타나지 않음.
    const list = buildCameraList(views, [{ camId: 3, name: 'Ghost' }]);
    expect(list.cameras.map((c) => c.camIdx)).toEqual([1, 2]);
  });

  it('(h) 경계면: buildCameraList 산출 presets 를 core.findPresetPtz 가 그대로 소비(뷰어 gotoPreset 계약)', () => {
    // /viewer/api/cameras → state.cameras → findPresetPtz(cameras, cam, preset) → /move.
    const list = buildCameraList(views, [{ camId: 1, name: 'North' }]);
    expect(findPresetPtz(list.cameras, 1, 1)).toEqual({ pan: 22, tilt: 6.8, zoom: 1.6 });
    expect(findPresetPtz(list.cameras, 1, 3)).toEqual({ pan: 200, tilt: 12, zoom: 3 });
    // 미존재 프리셋 → null(호출측 폴백).
    expect(findPresetPtz(list.cameras, 1, 9)).toBeNull();
  });

  it('(i) 순수: 입력 views 를 변형하지 않음', () => {
    const src = structuredClone(views);
    buildCameraList(src, [{ camId: 1, name: 'x' }]);
    expect(src).toEqual(views);
  });
});
