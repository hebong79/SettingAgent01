// ★ 18회차 — 씬 정답 복원(`sceneTruth.ts`) 고정 테스트.
//
// 이 테스트가 지키는 것: **복원 규칙이 수동 정본을 재현한다**는 사실. 재현이 깨지면 채점 분모가 흔들리므로
// 재현율·정밀도 수치 전부가 무의미해진다. 그래서 IoU 하한을 기대값으로 박는다.
//
// ★ 정본 결함 2건은 **예외로 명시**한다(숨기지 않는다):
//   · `1:2` s8  — 복원값과 IoU 0.91996. U3(idx8 앵커 결함)·U12① 과 같은 대상. 정본 쪽이 틀렸다.
//   · `1:3` s13 — 어느 복원 면과도 IoU 0. U12② "축 뒤바뀜" 확인.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { facesOfRow, projectTruth, quadAreaPx, visibleTruth, type ScenePresetSpec } from '../src/ground/sceneTruth.js';
import { quadIoU } from '../src/ground/autoRoiPlan.js';
import { normalizePtzCamRoi } from '../src/capture/placeRoi.js';
import type { PixelQuad } from '../src/ground/types.js';

/** Unity `preset.list` 실측(2026-07-29). `car.list` 로 독립 교차확인된 값이다. */
const SPECS: ScenePresetSpec[] = [
  { idx: 1, faceCount: 7, offsetPos: [-7.367, 0, 19.176], xSize: 2.5, zSize: 5, faceRot: 0, groupRot: 0 },
  { idx: 2, faceCount: 6, offsetPos: [13.761, 0, 3.332], xSize: 5, zSize: 2.5, faceRot: 0, groupRot: 0 },
  { idx: 3, faceCount: 4, offsetPos: [-3.549, 0, 3.586], xSize: 2.5, zSize: 5, faceRot: 0, groupRot: 0 },
  { idx: 4, faceCount: 4, offsetPos: [-3.549, 0, 8.58], xSize: 2.5, zSize: 5, faceRot: 0, groupRot: 0 },
  { idx: 5, faceCount: 2, offsetPos: [-3.625, 0, -7.114], xSize: 5, zSize: 2.5, faceRot: 0, groupRot: 0 },
];
/** F6 — 광학중심↔주차면 평면 4.950m. `cam.list` 의 pos.y=5.0 은 트랜스폼 원점이다. */
const PLANE_Y_M = 0.05;

const placeJson = JSON.parse(readFileSync('data/Place01/PtzCamRoi.json', 'utf8'));
const { byPreset } = normalizePtzCamRoi(placeJson);
const faces = SPECS.flatMap((s) => facesOfRow(s, PLANE_Y_M) ?? []);

/** 프리셋별 정본 슬롯 ↔ 복원 면 최고 IoU. */
function bestIoUs(camId: number, presetIdx: number): Array<{ slotIdx: number; iou: number }> {
  const cam = placeJson.cameras.find((c: { camera: { cam_id: number } }) => c.camera.cam_id === camId);
  const p = cam.presets.find((x: { preset_idx: number }) => x.preset_idx === presetIdx);
  const W = cam.camera.imageWidth;
  const H = cam.camera.imageHeight;
  const proj = projectTruth(faces, {
    camPos: cam.camera.position,
    panDeg: p.pan,
    tiltDeg: p.tilt,
    fovDeg: p.fov,
    fovAxis: 'vertical',
    imgW: W,
    imgH: H,
    planeYM: PLANE_Y_M,
  });
  const manual = (byPreset.get(`${camId}:${presetIdx}`) ?? []).filter(
    (s) => Array.isArray(s.points) && s.points.length === 4,
  );
  return manual.map((sp) => {
    const mq = sp.points!.map((q) => ({ x: q.x * W, y: q.y * H })) as PixelQuad;
    let iou = 0;
    for (const t of proj) iou = Math.max(iou, quadIoU(mq, t.quad));
    return { slotIdx: sp.idx, iou };
  });
}

describe('sceneTruth — 씬 제원에서 주차면 진값 복원', () => {
  it('행 제원 → 면 목록: 행 축은 2.5m 축, 피치 2.5m, offsetPos 는 최소 좌표 면의 중심', () => {
    const r1 = facesOfRow(SPECS[0], 0);
    expect(r1).not.toBeNull();
    expect(r1!.length).toBe(7);
    // row1 은 xSize=2.5 이므로 x 가 행 축. 첫 면 중심 x = offsetPos.x.
    const c0 = r1![0].cornersWorld;
    expect((c0[0][0] + c0[2][0]) / 2).toBeCloseTo(-7.367, 9);
    expect((c0[0][2] + c0[2][2]) / 2).toBeCloseTo(19.176, 9);
    // 폭 2.5m(행 축) · 깊이 5.0m(나머지 축).
    expect(Math.abs(c0[2][0] - c0[0][0])).toBeCloseTo(2.5, 9);
    expect(Math.abs(c0[2][2] - c0[0][2])).toBeCloseTo(5.0, 9);
    // 다음 면은 +x 로 정확히 피치만큼.
    expect((r1![1].cornersWorld[0][0] + r1![1].cornersWorld[2][0]) / 2).toBeCloseTo(-7.367 + 2.5, 9);
    // faceIdx 는 1-based(저장소 규약).
    expect(r1!.map((f) => f.faceIdx)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('row2 처럼 zSize=2.5 인 행은 z 가 행 축이다', () => {
    const r2 = facesOfRow(SPECS[1], 0)!;
    expect(r2.length).toBe(6);
    const a = r2[0].cornersWorld;
    const b = r2[1].cornersWorld;
    expect((b[0][2] + b[2][2]) / 2 - (a[0][2] + a[2][2]) / 2).toBeCloseTo(2.5, 9);
    expect((b[0][0] + b[2][0]) / 2 - (a[0][0] + a[2][0]) / 2).toBeCloseTo(0, 9);
  });

  it('회전 씬은 추정으로 채우지 않고 null 로 강등한다', () => {
    expect(facesOfRow({ ...SPECS[0], faceRot: 15 }, 0)).toBeNull();
    expect(facesOfRow({ ...SPECS[0], groupRot: 90 }, 0)).toBeNull();
    // 정사각 면은 어느 축이 행인지 결정 불가 → 강등.
    expect(facesOfRow({ ...SPECS[0], xSize: 2.5, zSize: 2.5 }, 0)).toBeNull();
  });

  it('전 5행 합이 23면 — 정본 총 면수와 일치한다', () => {
    expect(faces.length).toBe(23);
  });

  it('1:1 · 2:1 · 2:2 는 정본 전 면을 IoU ≥ 0.9999 로 재현한다', () => {
    for (const [cam, preset] of [
      [1, 1],
      [2, 1],
      [2, 2],
    ] as const) {
      for (const r of bestIoUs(cam, preset)) {
        expect(r.iou, `${cam}:${preset} s${r.slotIdx} IoU=${r.iou}`).toBeGreaterThanOrEqual(0.9999);
      }
    }
  });

  it('1:2 는 s8 만 0.92 대다 — 정본 결함(U3·U12①)이며 복원 쪽이 옳다', () => {
    const m = new Map(bestIoUs(1, 2).map((r) => [r.slotIdx, r.iou]));
    expect(m.get(8)!).toBeGreaterThan(0.919);
    expect(m.get(8)!).toBeLessThan(0.921);
    for (const s of [9, 10, 11]) expect(m.get(s)!, `s${s}`).toBeGreaterThanOrEqual(0.9999);
  });

  it('1:3 은 s12 만 재현되고 s13 은 어느 면과도 겹치지 않는다 — 정본 축 뒤바뀜(U12②)', () => {
    const m = new Map(bestIoUs(1, 3).map((r) => [r.slotIdx, r.iou]));
    expect(m.get(12)!).toBeGreaterThanOrEqual(0.9999);
    // 실측 7.6e-8 — 겹침이 없다고 봐도 되는 수준이다(정본 s13 은 축이 뒤바뀌어 다른 면 위에 있다).
    expect(m.get(13)!).toBeLessThan(1e-6);
  });

  it('설치고가 5.00m(평면 y=0)면 재현이 무너진다 — F6(4.95m)의 독립 확인', () => {
    const f0 = SPECS.flatMap((s) => facesOfRow(s, 0) ?? []);
    const cam = placeJson.cameras[0];
    const p = cam.presets[0];
    const proj = projectTruth(f0, {
      camPos: cam.camera.position,
      panDeg: p.pan,
      tiltDeg: p.tilt,
      fovDeg: p.fov,
      fovAxis: 'vertical',
      imgW: cam.camera.imageWidth,
      imgH: cam.camera.imageHeight,
      planeYM: 0,
    });
    const manual = (byPreset.get('1:1') ?? []).filter((s) => Array.isArray(s.points) && s.points.length === 4);
    const mq = manual[0].points!.map((q) => ({ x: q.x * cam.camera.imageWidth, y: q.y * cam.camera.imageHeight })) as PixelQuad;
    let best = 0;
    for (const t of proj) best = Math.max(best, quadIoU(mq, t.quad));
    // 4.95m 에서 0.99995 이던 것이 5.00m 에서 0.89 아래로 떨어진다.
    expect(best).toBeLessThan(0.9);
  });

  it('가시 판정 — 5뷰 합 41면(정본 23면의 178%)', () => {
    let total = 0;
    for (const cam of placeJson.cameras) {
      for (const p of cam.presets) {
        const W = cam.camera.imageWidth;
        const H = cam.camera.imageHeight;
        const proj = projectTruth(faces, {
          camPos: cam.camera.position,
          panDeg: p.pan,
          tiltDeg: p.tilt,
          fovDeg: p.fov,
          fovAxis: 'vertical',
          imgW: W,
          imgH: H,
          planeYM: PLANE_Y_M,
        });
        total += visibleTruth(proj, W, H, 200).length;
      }
    }
    expect(total).toBe(41);
  });

  it('면적 하한과 프레임 밖 중심은 가시에서 제외된다', () => {
    const q: PixelQuad = [
      { x: 10, y: 10 },
      { x: 10, y: 20 },
      { x: 20, y: 20 },
      { x: 20, y: 10 },
    ];
    expect(quadAreaPx(q)).toBeCloseTo(100, 9);
    const entry = [{ face: faces[0], quad: q }];
    expect(visibleTruth(entry, 100, 100, 200).length).toBe(0); // 면적 미달
    expect(visibleTruth(entry, 100, 100, 50).length).toBe(1);
    expect(visibleTruth(entry, 5, 5, 50).length).toBe(0); // 중심이 프레임 밖
  });

  it('카메라 뒤 면은 부분 quad 를 만들지 않고 통째로 버린다', () => {
    const behind = facesOfRow({ idx: 9, faceCount: 1, offsetPos: [-9.5, 0, -60], xSize: 2.5, zSize: 5, faceRot: 0, groupRot: 0 }, 0)!;
    const proj = projectTruth(behind, {
      camPos: [-9.5, 5, -7.1],
      panDeg: 19.8,
      tiltDeg: 8.7,
      fovDeg: 20.86546,
      fovAxis: 'vertical',
      imgW: 1920,
      imgH: 1080,
      planeYM: 0,
    });
    expect(proj.length).toBe(0);
  });
});
