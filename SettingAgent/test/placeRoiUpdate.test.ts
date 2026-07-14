import { describe, it, expect } from 'vitest';
// 백엔드 순수 함수(불변, throw 금지) + 정규화 역함수 교차검증.
import { applyPlaceRoiUpdate, normalizePtzCamRoi } from '../src/capture/placeRoi.js';

/**
 * 검증자(qa-tester): 주차면 자동보정 결과 반영 `applyPlaceRoiUpdate`(기능3, PUT /capture/place-roi 코어).
 * 근거: 01_architect_plan.md §4-2 + 02_developer_changes.md 기능3 §백엔드 역변환.
 * 정규화→픽셀 역변환([0.5,0.5]×1920/1080→[960,540])·대상 프리셋만 교체·타 카메라/프리셋/메타 보존·불변·방어(throw 금지).
 * 경계면 교차검증: applyPlaceRoiUpdate(픽셀 역변환) ↔ normalizePtzCamRoi(정규화)가 왕복 정합.
 * 라우트(파일 read/write·zod·상태코드)는 리더 라이브 실증(place-roi PUT→ok spaceCount:6 확인) — 여기서는 코어만.
 */

function makeJson() {
  return {
    meta: { note: 'keep-me' },
    cameras: [
      {
        camera: { cam_id: 1, imageWidth: 1920, imageHeight: 1080 },
        presets: [
          { preset_idx: 1, parking_spaces: [{ idx: 1, points: [[0, 0], [10, 10]] }] },
          { preset_idx: 2, parking_spaces: [{ idx: 5, points: [[100, 100]] }] },
        ],
      },
      {
        camera: { cam_id: 2, imageWidth: 1280, imageHeight: 720 },
        presets: [{ preset_idx: 1, parking_spaces: [{ idx: 9, points: [[1, 2]] }] }],
      },
    ],
  };
}

describe('applyPlaceRoiUpdate — 정규화→픽셀 역변환 · 보존 · 불변', () => {
  it('대상 프리셋 parking_spaces 를 픽셀로 역변환 교체([0.5,0.5]×1920/1080→[960,540])', () => {
    const json = makeJson();
    const out = applyPlaceRoiUpdate(json, {
      camId: 1,
      presetIdx: 1,
      spaces: [
        {
          idx: 7,
          points: [
            { x: 0.5, y: 0.5 },
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ],
        },
      ],
    }) as ReturnType<typeof makeJson>;
    const preset = out.cameras[0].presets[0];
    expect(preset.parking_spaces).toEqual([
      { idx: 7, points: [[960, 540], [0, 0], [1920, 1080]] },
    ]);
  });

  it('대상 카메라의 타 프리셋(preset 2)은 보존', () => {
    const json = makeJson();
    const out = applyPlaceRoiUpdate(json, { camId: 1, presetIdx: 1, spaces: [] }) as ReturnType<typeof makeJson>;
    expect(out.cameras[0].presets[1].parking_spaces).toEqual([{ idx: 5, points: [[100, 100]] }]);
  });

  it('타 카메라(cam 2)와 최상위 메타 보존', () => {
    const json = makeJson();
    const out = applyPlaceRoiUpdate(json, { camId: 1, presetIdx: 1, spaces: [] }) as ReturnType<typeof makeJson>;
    expect(out.cameras[1]).toEqual(json.cameras[1]);
    expect(out.meta).toEqual({ note: 'keep-me' });
    // 카메라 메타(imageWidth 등) 보존
    expect(out.cameras[0].camera).toEqual({ cam_id: 1, imageWidth: 1920, imageHeight: 1080 });
  });

  it('원본 json 불변', () => {
    const json = makeJson();
    const before = JSON.stringify(json);
    applyPlaceRoiUpdate(json, { camId: 1, presetIdx: 1, spaces: [{ idx: 1, points: [{ x: 0.5, y: 0.5 }] }] });
    expect(JSON.stringify(json)).toBe(before);
  });

  it('대상 카메라 부재 → 내용 동등(변형 없음)', () => {
    const json = makeJson();
    const out = applyPlaceRoiUpdate(json, { camId: 99, presetIdx: 1, spaces: [{ idx: 1, points: [{ x: 0.5, y: 0.5 }] }] });
    expect(out).toEqual(json);
  });

  it('대상 프리셋 부재 → 해당 카메라 프리셋 변형 없음', () => {
    const json = makeJson();
    const out = applyPlaceRoiUpdate(json, { camId: 1, presetIdx: 99, spaces: [{ idx: 1, points: [{ x: 0.5, y: 0.5 }] }] }) as ReturnType<typeof makeJson>;
    expect(out.cameras[0].presets).toEqual(json.cameras[0].presets);
  });

  it('이미지 크기 오류(0) → 해당 카메라 변형 없음(throw 금지)', () => {
    const json = makeJson();
    (json.cameras[0].camera as { imageWidth: number }).imageWidth = 0;
    const out = applyPlaceRoiUpdate(json, { camId: 1, presetIdx: 1, spaces: [{ idx: 1, points: [{ x: 0.5, y: 0.5 }] }] }) as ReturnType<typeof makeJson>;
    expect(out.cameras[0].presets[0].parking_spaces).toEqual([{ idx: 1, points: [[0, 0], [10, 10]] }]);
  });

  it('비객체 입력 → 그대로 반환(방어)', () => {
    expect(applyPlaceRoiUpdate(null, { camId: 1, presetIdx: 1, spaces: [] })).toBeNull();
    expect(applyPlaceRoiUpdate('x', { camId: 1, presetIdx: 1, spaces: [] })).toBe('x');
  });
});

describe('경계면 교차검증 — applyPlaceRoiUpdate ↔ normalizePtzCamRoi 왕복', () => {
  it('정규화 4점 저장 후 normalize 로 되읽으면 동일 정규화값 복원', () => {
    const json = makeJson();
    const spaces = [
      {
        idx: 3,
        points: [
          { x: 0.25, y: 0.5 },
          { x: 0.75, y: 0.5 },
          { x: 0.75, y: 0.9 },
          { x: 0.25, y: 0.9 },
        ],
      },
    ];
    const out = applyPlaceRoiUpdate(json, { camId: 1, presetIdx: 1, spaces });
    const norm = normalizePtzCamRoi(out);
    const readBack = norm.byPreset.get('1:1');
    expect(readBack).toBeDefined();
    expect(readBack![0].idx).toBe(3);
    const pts = readBack![0].points;
    for (let i = 0; i < spaces[0].points.length; i++) {
      expect(pts[i].x).toBeCloseTo(spaces[0].points[i].x, 10);
      expect(pts[i].y).toBeCloseTo(spaces[0].points[i].y, 10);
    }
  });
});
