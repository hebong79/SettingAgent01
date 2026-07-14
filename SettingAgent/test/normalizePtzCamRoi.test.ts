import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// 순수 ESM 모듈(브라우저 API 미참조) 직접 import.
import { normalizePtzCamRoi, presetKey } from '../web/core.js';

/**
 * 검증자(qa-tester): `normalizePtzCamRoi(json)` 순수 함수 유닛테스트.
 * 근거: 01_architect_plan.md #02 §3 F1 검증 기준 + 02_developer_changes.md 02-C QA 인계.
 * 정규화 정확도·byPreset 구조/키·프리셋별 검수(issues, throw 없음)·방어성.
 */

// ★ 동결 픽스처(Unity 생성 원형: 프리셋별 0-based idx, 원본 좌표)를 쓴다.
// data/Place01/PtzCamRoi.json 은 **런타임 가변 데이터**다 — 사용자가 뷰어에서 주차면을 편집·저장하면
// 좌표(자동보정 이동)·idx(전역번호 재부여·수동 재지정)가 바뀐다. 그것을 픽스처로 삼으면
// 사용자가 앱을 쓸 때마다 테스트가 깨진다(실제로 깨졌다). 좌표·idx 를 단정하는 케이스는 픽스처 전용.
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'PtzCamRoi.unity.json');
const realJson = () => JSON.parse(readFileSync(FIXTURE, 'utf8'));

describe('normalizePtzCamRoi — 동결 픽스처(test/fixtures/PtzCamRoi.unity.json)', () => {
  it('정규화 정확도: cam1/preset1/idx0 첫 점 [57.3171, 828.721436] → x≈0.02985, y≈0.76733 (±1e-4)', () => {
    const { byPreset } = normalizePtzCamRoi(realJson());
    const sp0 = byPreset['1:1'][0];
    expect(sp0.idx).toBe(0);
    expect(sp0.points[0].x).toBeCloseTo(0.0298528, 4); // 57.31739 / 1920
    expect(sp0.points[0].y).toBeCloseTo(0.7673347, 4); // 828.721436 / 1080
  });

  it('byPreset 구조·키: presetKey(camId,presetIdx) 형식("1:1"/"1:2"/"1:3"), 면 수 7/6/4, 각 면 4점', () => {
    const { byPreset } = normalizePtzCamRoi(realJson());
    expect(Object.keys(byPreset).sort()).toEqual(['1:1', '1:2', '1:3']);
    expect(byPreset['1:1']).toHaveLength(7);
    expect(byPreset['1:2']).toHaveLength(6);
    expect(byPreset['1:3']).toHaveLength(4);
    for (const key of Object.keys(byPreset)) {
      for (const sp of byPreset[key]) {
        expect(sp).toHaveProperty('idx');
        expect(sp.points).toHaveLength(4);
        for (const p of sp.points) {
          expect(typeof p.x).toBe('number');
          expect(typeof p.y).toBe('number');
          // 정규화(0..1) 범위.
          expect(p.x).toBeGreaterThanOrEqual(0);
          expect(p.x).toBeLessThanOrEqual(1);
          expect(p.y).toBeGreaterThanOrEqual(0);
          expect(p.y).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('경계면 교차: byPreset 키가 프론트 currentFrameKey()=presetKey(camIdx,presetIdx) 와 동일 형식', () => {
    const { byPreset } = normalizePtzCamRoi(realJson());
    // 파일 cam_id=1, preset_idx=1/2/3 → presetKey 로 재생성한 키가 그대로 존재해야 함.
    for (const presetIdx of [1, 2, 3]) {
      expect(byPreset).toHaveProperty(presetKey(1, presetIdx));
    }
  });

  it('검수 report: 정상 입력 → 모든 프리셋 issues=0, spaceCount 7/6/4', () => {
    const { report } = normalizePtzCamRoi(realJson());
    expect(report).toHaveLength(3);
    for (const r of report) {
      expect(r.camId).toBe(1);
      expect(r.issues).toEqual([]);
    }
    expect(report.map((r) => r.spaceCount)).toEqual([7, 6, 4]);
  });
});

/** 인위적 이상 케이스 — throw 없이 issues 감지. */
describe('normalizePtzCamRoi — 검수(issues) 이상 케이스(throw 없음)', () => {
  const cam = (imageWidth: number, imageHeight: number, spaces: unknown[]) => ({
    cameras: [
      {
        camera: { cam_id: 1, imageWidth, imageHeight },
        presets: [{ preset_idx: 1, parking_spaces: spaces }],
      },
    ],
  });
  const quad = (): number[][] => [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];

  it('점 개수 ≠ 4 → "idx N: 점 4개 아님(M개)" issue', () => {
    let out!: ReturnType<typeof normalizePtzCamRoi>;
    expect(() => {
      out = normalizePtzCamRoi(cam(1920, 1080, [{ idx: 0, points: [[0, 0], [10, 0], [10, 10]] }]));
    }).not.toThrow();
    expect(out.report[0].issues).toContain('idx 0: 점 4개 아님(3개)');
  });

  it('좌표 범위 이탈(x>W) → "idx N: 좌표 범위 이탈" issue', () => {
    const bad = [{ idx: 5, points: [[9999, 0], [10, 0], [10, 10], [0, 10]] }];
    const out = normalizePtzCamRoi(cam(1920, 1080, bad));
    expect(out.report[0].issues).toContain('idx 5: 좌표 범위 이탈');
  });

  it('좌표 범위 이탈(음수) → "좌표 범위 이탈" issue', () => {
    const bad = [{ idx: 3, points: [[-1, 0], [10, 0], [10, 10], [0, 10]] }];
    const out = normalizePtzCamRoi(cam(1920, 1080, bad));
    expect(out.report[0].issues).toContain('idx 3: 좌표 범위 이탈');
  });

  it('빈 parking_spaces → "주차면 없음" issue + byPreset 미기록', () => {
    const out = normalizePtzCamRoi(cam(1920, 1080, []));
    expect(out.report[0].issues).toContain('주차면 없음');
    expect(out.byPreset['1:1']).toBeUndefined();
  });

  it('imageWidth ≤ 0 → "이미지 크기 누락/오류" issue + byPreset 미기록', () => {
    const out = normalizePtzCamRoi(cam(0, 1080, [{ idx: 0, points: quad() }]));
    expect(out.report[0].issues).toContain('이미지 크기 누락/오류');
    expect(out.byPreset['1:1']).toBeUndefined();
  });

  it('imageHeight ≤ 0 → "이미지 크기 누락/오류" issue + byPreset 미기록', () => {
    const out = normalizePtzCamRoi(cam(1920, 0, [{ idx: 0, points: quad() }]));
    expect(out.report[0].issues).toContain('이미지 크기 누락/오류');
    expect(out.byPreset['1:1']).toBeUndefined();
  });

  it('camera 누락 → "이미지 크기 누락/오류" issue + byPreset 미기록', () => {
    const json = { cameras: [{ presets: [{ preset_idx: 1, parking_spaces: [{ idx: 0, points: quad() }] }] }] };
    const out = normalizePtzCamRoi(json);
    expect(out.report[0].issues).toContain('이미지 크기 누락/오류');
    expect(Object.keys(out.byPreset)).toHaveLength(0);
  });

  it('cam_id 누락 → "cam_id 누락" issue', () => {
    const json = {
      cameras: [
        { camera: { imageWidth: 1920, imageHeight: 1080 }, presets: [{ preset_idx: 1, parking_spaces: [{ idx: 0, points: quad() }] }] },
      ],
    };
    const out = normalizePtzCamRoi(json);
    expect(out.report[0].issues).toContain('cam_id 누락');
  });

  it('preset_idx 누락 → "preset_idx 누락" issue', () => {
    const json = {
      cameras: [{ camera: { cam_id: 1, imageWidth: 1920, imageHeight: 1080 }, presets: [{ parking_spaces: [{ idx: 0, points: quad() }] }] }],
    };
    const out = normalizePtzCamRoi(json);
    expect(out.report[0].issues).toContain('preset_idx 누락');
  });

  it('idx 누락 → "idx 누락" issue', () => {
    const out = normalizePtzCamRoi(cam(1920, 1080, [{ points: quad() }]));
    expect(out.report[0].issues).toContain('idx 누락');
  });

  it('points 누락 → "idx N: points 누락" issue', () => {
    const out = normalizePtzCamRoi(cam(1920, 1080, [{ idx: 7 }]));
    expect(out.report[0].issues).toContain('idx 7: points 누락');
  });
});

describe('normalizePtzCamRoi — 방어성(throw 안 함)', () => {
  it('null → { byPreset:{}, report:[] }', () => {
    expect(() => normalizePtzCamRoi(null)).not.toThrow();
    expect(normalizePtzCamRoi(null)).toEqual({ byPreset: {}, report: [] });
  });
  it('{} → { byPreset:{}, report:[] }', () => {
    expect(() => normalizePtzCamRoi({})).not.toThrow();
    expect(normalizePtzCamRoi({})).toEqual({ byPreset: {}, report: [] });
  });
  it('{cameras:[]} → { byPreset:{}, report:[] }', () => {
    expect(() => normalizePtzCamRoi({ cameras: [] })).not.toThrow();
    expect(normalizePtzCamRoi({ cameras: [] })).toEqual({ byPreset: {}, report: [] });
  });
});
