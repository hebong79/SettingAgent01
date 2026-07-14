import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// 백엔드 포팅(§06 H2, Map 반환) 순수 함수.
import { normalizePtzCamRoi, loadNormalizedPlaceRoi } from '../src/capture/placeRoi.js';
// 프론트 원본(core.js, 객체 반환) — 포팅 정합(값 동등) 교차검증용.
import { normalizePtzCamRoi as feNormalize, presetKey } from '../web/core.js';

/**
 * 검증자(qa-tester): 백엔드 파일 바닥ROI 정규화 `src/capture/placeRoi.ts`(§06 H2).
 * 근거: 01_architect_plan.md §06 §3 H2 + 02_developer_changes.md 02-I QA 인계.
 * 정규화 정확도·byPreset(Map) 구조/키·프리셋별 검수(issues, throw 없음)·**프론트 core.js 와 값 동등**·loadNormalizedPlaceRoi 방어성.
 */

// ★ 동결 픽스처(Unity 생성 원형). data/Place01/PtzCamRoi.json 은 런타임 가변(뷰어 편집·저장으로 좌표·idx 변경)
// → 좌표·idx 를 단정하는 케이스가 사용자 사용만으로 깨진다. 픽스처로 고정한다(테스트 설계 결함 수정).
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'PtzCamRoi.unity.json');
const realJson = () => JSON.parse(readFileSync(FIXTURE, 'utf8'));

describe('placeRoi.normalizePtzCamRoi — 동결 픽스처(test/fixtures/PtzCamRoi.unity.json)', () => {
  it('정규화 정확도: cam1/preset1/idx0 첫 점 [57.3171,828.721436] → x≈0.02985, y≈0.76733 (±1e-4)', () => {
    const { byPreset } = normalizePtzCamRoi(realJson());
    const sp0 = byPreset.get('1:1')![0];
    expect(sp0.idx).toBe(0); // 파일 원본 idx(0-based 시작값 보존)
    expect(sp0.points[0].x).toBeCloseTo(0.02985, 4); // 57.31739/1920
    expect(sp0.points[0].y).toBeCloseTo(0.76733, 4); // 828.721436/1080
  });

  it('byPreset 키/면수: 1:1=7, 1:2=6, 1:3=4, 각 space points 4개', () => {
    const { byPreset } = normalizePtzCamRoi(realJson());
    expect([...byPreset.keys()].sort()).toEqual(['1:1', '1:2', '1:3']);
    expect(byPreset.get('1:1')!.length).toBe(7);
    expect(byPreset.get('1:2')!.length).toBe(6);
    expect(byPreset.get('1:3')!.length).toBe(4);
    for (const spaces of byPreset.values()) {
      for (const sp of spaces) expect(sp.points).toHaveLength(4);
    }
  });

  it('정상 파일 → 모든 프리셋 report issues 없음', () => {
    const { report } = normalizePtzCamRoi(realJson());
    expect(report.length).toBe(3);
    for (const r of report) expect(r.issues).toEqual([]);
  });

  it('경계면 정합: 백엔드 Map 값이 프론트 core.js normalizePtzCamRoi 객체 값과 동등(포팅 정합)', () => {
    const back = normalizePtzCamRoi(realJson());
    const front = feNormalize(realJson());
    // 키 집합 동일 + presetKey(cam,preset) 형식 정합.
    expect([...back.byPreset.keys()].sort()).toEqual(Object.keys(front.byPreset).sort());
    expect(back.byPreset.has(presetKey(1, 1))).toBe(true);
    // 각 프리셋의 정규화 좌표/idx 가 프론트와 완전히 동일한 값.
    for (const key of back.byPreset.keys()) {
      expect(back.byPreset.get(key)).toEqual(front.byPreset[key]);
    }
    // report(camId/presetIdx/spaceCount/issues) 도 동등.
    expect(back.report).toEqual(front.report);
  });
});

describe('placeRoi.normalizePtzCamRoi — malformed 강등(throw 금지)', () => {
  const cam = (spaces: unknown[], over: Record<string, unknown> = {}) => ({
    cameras: [{ camera: { cam_id: 1, imageWidth: 1000, imageHeight: 1000, ...over }, presets: [{ preset_idx: 1, parking_spaces: spaces }] }],
  });

  it('점 3개 → "점 4개 아님(3개)" issue', () => {
    let res: ReturnType<typeof normalizePtzCamRoi>;
    expect(() => { res = normalizePtzCamRoi(cam([{ idx: 0, points: [[10, 10], [20, 10], [15, 20]] }])); }).not.toThrow();
    expect(res!.report[0].issues).toContain('idx 0: 점 4개 아님(3개)');
  });

  // 프레임 밖 좌표는 **정상일 수 있다**(주차면이 화면 밖으로 걸침 — 라이브 검증 확정: preset1 idx7).
  // 따라서 advisory 문구는 결함이 아니라 '정상일 수 있음'을 말해야 하고, 점은 **클램프·드롭 없이 보존**돼야 한다.
  it('좌표 범위(W) 초과 → "좌표 프레임 밖(정상일 수 있음)" issue (클램프·드롭 없이 정규화 기록)', () => {
    const res = normalizePtzCamRoi(cam([{ idx: 0, points: [[10, 10], [2000, 10], [2000, 20], [10, 20]] }]));
    expect(res.report[0].issues).toContain('idx 0: 좌표 프레임 밖(정상일 수 있음)');
    const spaces = res.byPreset.get('1:1');
    expect(spaces).toBeDefined(); // 프레임 밖은 issue 만, byPreset 는 기록(면 드롭 금지).
    // ★ 클램프 금지 봉인: x=2000(폭 1000) → 정규화 2.0 이 **1 로 잘리지 않고** 그대로 보존돼야 한다.
    // (잘리면 지면모델 추정과 육면체 투영이 조용히 왜곡된다 — 프레임 밖 점도 유효한 투영점이다.)
    expect(spaces![0].points[1].x).toBeCloseTo(2.0, 6);
    expect(spaces![0].points[1].x).toBeGreaterThan(1);
  });

  it('빈 parking_spaces → "주차면 없음", byPreset 미기록', () => {
    const res = normalizePtzCamRoi(cam([]));
    expect(res.report[0].issues).toContain('주차면 없음');
    expect(res.byPreset.has('1:1')).toBe(false);
  });

  it('imageWidth=0 → "이미지 크기 누락/오류", byPreset 미기록(정규화 불가)', () => {
    const res = normalizePtzCamRoi(cam([{ idx: 0, points: [[10, 10], [20, 10], [20, 20], [10, 20]] }], { imageWidth: 0 }));
    expect(res.report[0].issues).toContain('이미지 크기 누락/오류');
    expect(res.byPreset.has('1:1')).toBe(false);
  });

  it('null / 비객체 입력 → 빈 결과({ byPreset:Map(0), report:[] }), throw 없음', () => {
    for (const bad of [null, undefined, 42, 'x']) {
      let res: ReturnType<typeof normalizePtzCamRoi>;
      expect(() => { res = normalizePtzCamRoi(bad as unknown); }).not.toThrow();
      expect(res!.byPreset.size).toBe(0);
      expect(res!.report).toEqual([]);
    }
  });
});

describe('placeRoi.loadNormalizedPlaceRoi — best-effort 로더', () => {
  it('임시 파일 왕복 → 정규화 결과(byPreset 채워짐)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'placeroi-'));
    try {
      const file = join(dir, 'PtzCamRoi.json');
      writeFileSync(file, JSON.stringify({
        cameras: [{ camera: { cam_id: 1, imageWidth: 1000, imageHeight: 1000 }, presets: [{ preset_idx: 1, parking_spaces: [{ idx: 1, points: [[100, 100], [200, 100], [200, 200], [100, 200]] }] }] }],
      }));
      const res = await loadNormalizedPlaceRoi(file);
      expect(res).not.toBeNull();
      expect(res!.byPreset.get('1:1')![0].points[0]).toEqual({ x: 0.1, y: 0.1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('파일 경로 미설정(undefined) → null', async () => {
    expect(await loadNormalizedPlaceRoi(undefined)).toBeNull();
  });

  it('없는 파일 경로 → null(graceful)', async () => {
    expect(await loadNormalizedPlaceRoi(join(tmpdir(), 'does-not-exist-xyz.json'))).toBeNull();
  });

  it('파싱 실패 파일 → null(graceful)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'placeroi-bad-'));
    try {
      const file = join(dir, 'bad.json');
      writeFileSync(file, '{ not json');
      expect(await loadNormalizedPlaceRoi(file)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
