// 지면모델 회귀 — **동결 픽스처**(Unity 생성 원형)로 추정한 지면모델을 Unity ground truth 와 수치 대조(설계 §9-1).
//
// ★ 왜 실데이터(data/Place01/PtzCamRoi.json)를 쓰지 않는가:
//   그 파일은 **런타임 가변**이다. 사용자가 뷰어에서 주차면을 편집·저장하면 좌표(자동보정 이동)·idx(전역번호
//   재부여)·camera 블록(카메라 포즈 스냅샷)이 전부 바뀐다. 실제로 바뀌었고, 그것을 픽스처로 삼은 기존
//   테스트들이 깨졌다. **사용자가 앱을 쓰는 것만으로 깨지는 테스트는 테스트가 아니다.**
//
// 프로덕션 경로(추정)는 이미지 위의 점 + zoom 만 쓴다. Unity `camera` 블록(position/eulerAngles/fov)은
// **이 테스트에서만** ground truth 로 읽는다 — 실카메라가 못 주는 값이므로 추정 코드가 쓰면 안 된다(C3).
// 이 테스트가 그 경계를 CI 로 고정한다.
//
// ⚠️ GT 자체의 불확실성(정직하게 명시): 픽스처의 camera 블록은 eulerAngles=[6.8, 22.0] 인데 camerapos
//   preset 1 은 pan=20 이다(2° 차이). 즉 저장 시점 카메라가 프리셋에 **정확히** 있지 않았다 → 그 fov 가
//   zoom=1.6 에 정확히 대응한다는 보장이 없다. 런타임 파일의 camera 블록(preset 3 자세와 정확히 일치)에서
//   역산하면 fovBaseV=33.17, 이 픽스처에서 역산하면 32.83 — **GT 자체가 ~1% 흔들린다.**
//   우리 추정치(32.997)는 두 GT 사이에 있다. 따라서 f 허용오차 5% 는 GT 불확실성(~1%)을 충분히 덮는다.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildGroundInputs } from '../src/ground/groundInputs.js';
import {
  estimateGroundModels,
  estimateGroundVPs,
  focalFromVPs,
  buildGroundPlane,
} from '../src/ground/groundModel.js';
import { parseCameraViews } from '../src/setup/mapTargets.js';
import { fovV } from '../src/calibrate/detectMath.js';
import type { GroundOptions } from '../src/ground/types.js';

const DEG = Math.PI / 180;
const OPTS: GroundOptions = { minDepthEdgePx: 250, slotWidthM: 2.5, slotDepthM: 5.0 };

const placeRoi = JSON.parse(readFileSync('test/fixtures/PtzCamRoi.unity.json', 'utf8')) as {
  cameras: Array<{ camera: { eulerAngles: number[]; fov: number; position: number[]; imageHeight: number } }>;
};
const views = parseCameraViews(JSON.parse(readFileSync('test/fixtures/camerapos.sample.json', 'utf8')));

describe('지면모델 회귀 — 동결 픽스처 × Unity ground truth 대조', () => {
  const gtCam = placeRoi.cameras[0].camera;
  const imgH = gtCam.imageHeight;
  // camera 블록의 자세(eulerAngles=[tilt,pan,roll])로 대응 프리셋을 찾고(tilt 매칭), 그 zoom 으로
  // fovBaseV(zoom=1 기준)를 역산해 전 프리셋 GT f 를 만든다. 픽스처는 tilt 6.8 → preset 1(zoom 1.6).
  const gtPreset = views.find((v) => Math.abs((v.tilt ?? 0) - gtCam.eulerAngles[0]) < 0.1)!;
  const gtFovBaseV = (2 * Math.atan(Math.tan((gtCam.fov * DEG) / 2) * (gtPreset.zoom ?? 1))) / DEG;
  const gtFocal = (zoom: number) =>
    imgH / 2 / Math.tan((fovV(zoom, { fovBaseV: gtFovBaseV, zoomRef: 1, aspect: 16 / 9 }) * DEG) / 2);

  const inputs = buildGroundInputs(placeRoi, views);
  const result = estimateGroundModels(inputs[0], OPTS);

  it('GT 자세 프리셋 식별 + fovBaseV 역산 왕복(설계 §1-4 재확인)', () => {
    expect(gtPreset.presetIdx).toBe(1); // 픽스처 camera 블록 = preset 1 자세 스냅샷.
    expect(gtPreset.zoom).toBe(1.6);
    // 역산한 fovBaseV 를 다시 대입하면 파일의 camera.fov 와 일치해야 한다(detectMath.fovV = Unity 카메라 모델).
    expect(fovV(1.6, { fovBaseV: gtFovBaseV, zoomRef: 1, aspect: 16 / 9 })).toBeCloseTo(gtCam.fov, 4);
    // GT 불확실성: 이 블록에서 32.83, 런타임 파일(preset 3 자세 정확히 일치)에서 33.17 — 둘이 ~1% 다르다.
    // 우리 추정치는 그 사이에 있어야 한다(둘 중 어느 GT 를 써도 5% 안).
    expect(gtFovBaseV).toBeGreaterThan(32.5);
    expect(gtFovBaseV).toBeLessThan(33.5);
  });

  it('전 3프리셋 모델 산출 + 공동추정 fovBaseV 가 GT 와 ±5% 이내', () => {
    expect(result.models).toHaveLength(3);
    expect(result.fovBaseV).not.toBeNull();
    expect(Math.abs(result.fovBaseV! - gtFovBaseV) / gtFovBaseV).toBeLessThan(0.05);
  });

  it('★ f 오차 ≤5%, tilt 오차 ≤1° (성공 기준)', () => {
    const rows: string[] = [];
    for (const m of result.models) {
      const view = views.find((v) => v.camIdx === m.camIdx && v.presetIdx === m.presetIdx)!;
      const fGt = gtFocal(view.zoom!);
      const tiltGt = view.tilt!;
      const fErr = (m.f - fGt) / fGt;
      const tiltErr = m.tiltDeg - tiltGt;
      rows.push(
        `preset ${m.presetIdx} zoom=${view.zoom} | f ${m.f.toFixed(0)} vs GT ${fGt.toFixed(0)} (${(fErr * 100).toFixed(2)}%)` +
          ` | tilt ${m.tiltDeg.toFixed(2)}° vs GT ${tiltGt}° (${tiltErr.toFixed(2)}°)` +
          ` | d=${m.d.toFixed(2)}m depthEdge=${m.depthEdgePx.toFixed(0)}px conf=${m.conf.toFixed(2)}` +
          ` || 정합: 가로(metricErr) ${(m.metricErr * 100).toFixed(2)}%  세로(tiltErr) ${m.tiltErrDeg!.toFixed(2)}°`,
      );
      expect(Math.abs(fErr)).toBeLessThanOrEqual(0.05);
      expect(Math.abs(tiltErr)).toBeLessThanOrEqual(1.0);
    }
    console.log('\n[지면모델 실측 — Unity GT 대조]\n' + rows.join('\n'));
  });

  it('카메라 지상고(d) 가 Unity camera.position.y 와 ±10% 이내 — 스케일 앵커(주차면 폭 2.5m) 검증', () => {
    const gtHeight = placeRoi.cameras[0].camera.position[1]; // Unity y = 높이(m).
    for (const m of result.models) {
      expect(Math.abs(m.d - gtHeight) / gtHeight).toBeLessThan(0.1);
    }
  });

  it('★ 폭/깊이 대응 뒤집힘이 실파일에 실재한다 — preset 2 는 점 순서가 다르다(§4-6 의 함정)', () => {
    // 이 파일의 점 규약은 프리셋마다 균일하지 않다. preset 1/3 은 변군 A 가 깊이(5m)지만 preset 2 는 변군 B 다.
    // 규약(변군 A=깊이)을 하드코딩했다면 preset 2 의 metric 스케일이 조용히 2배 틀렸을 것이다.
    // metric 적합도로 배정을 푸는 현 구현만이 세 프리셋 모두에서 카메라고 5m 를 복원한다(위 테스트).
    const cam = buildGroundInputs(placeRoi, views)[0];
    const cx = cam.imgW / 2;
    const cy = cam.imgH / 2;
    const family = cam.presets.map((p) => {
      const vps = estimateGroundVPs(p.quads)!;
      const f = focalFromVPs(vps.v1, vps.v2, cx, cy)!;
      return buildGroundPlane(p.quads, f, vps.v1, vps.v2, cx, cy, OPTS)!.depthFamily;
    });
    expect(family).toEqual(['a', 'b', 'a']);
  });

  it('조건수 지표가 preset 1 을 실제로 낮게 평가한다(R1 advisory 작동)', () => {
    const byIdx = new Map(result.models.map((m) => [m.presetIdx, m]));
    const p1 = byIdx.get(1)!;
    const p3 = byIdx.get(3)!;
    expect(p1.depthEdgePx).toBeLessThan(p3.depthEdgePx);
    expect(p1.conf).toBeLessThan(p3.conf);
    expect(p1.issues.join()).toContain('조건수 낮음');
  });
});
