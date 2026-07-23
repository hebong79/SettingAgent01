// 리팩토링 3단계 — 추출 순수함수 봉인(buildPresetModel / crossPresetSimilarityChecks).
//
// ★ buildPresetModel(프리셋 1개 → 지면모델 or null)을 **직접** 호출해 반환 구조·강등(null)·mIssue 를 확정한다.
//    stage(1차 산출물)는 estimateGroundModels 와 **동일한 방식**으로 실 fixture 에서 조립한다(재구현 0).
// ★ crossPresetSimilarityChecks(닮음변환 교차검증)는 최소 GroundModel 로 각 분기를 결정적으로 봉인한다.
// ★ mIssue 문자열은 §6-2 평탄화 후에도 불변임을 exact 스냅샷으로 고정한다.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildPresetModel,
  crossPresetSimilarityChecks,
  estimateGroundVPs,
  focalFromVPs,
  buildGroundPlane,
  poolFovBaseV,
  type PresetStage,
} from '../src/ground/groundModel.js';
import { buildGroundInputs } from '../src/ground/groundInputs.js';
import { parseCameraViews } from '../src/setup/mapTargets.js';
import type { GroundCameraInput, GroundModel, GroundOptions } from '../src/ground/types.js';

const OPTS: GroundOptions = { minDepthEdgePx: 250, slotWidthM: 2.5, slotDepthM: 5.0 };

const placeRoi = JSON.parse(readFileSync('test/fixtures/PtzCamRoi.unity.json', 'utf8'));
const views = parseCameraViews(JSON.parse(readFileSync('test/fixtures/camerapos.sample.json', 'utf8')));
const cam: GroundCameraInput = buildGroundInputs(placeRoi, views)[0];
const CX = cam.imgW / 2;
const CY = cam.imgH / 2;

/** estimateGroundModels 와 **동일 로직**으로 프리셋 1개의 1차 산출물(stage)을 조립한다. */
function makeStage(p: GroundCameraInput['presets'][number]): PresetStage {
  const vps = estimateGroundVPs(p.quads);
  const fSolo = vps ? focalFromVPs(vps.v1, vps.v2, CX, CY) : null;
  const probe = vps && fSolo ? buildGroundPlane(p.quads, fSolo, vps.v1, vps.v2, CX, CY, OPTS) : null;
  const depthEdgePx = !vps ? 0 : (probe?.depthFamily ?? 'a') === 'a' ? vps.edgePxA : vps.edgePxB;
  return { preset: p, vps, fSolo, depthEdgePx };
}

const stages = cam.presets.map(makeStage);
const pooled = poolFovBaseV(
  stages.map((s) => ({ zoom: s.preset.zoom, f: s.fSolo, depthEdgePx: s.depthEdgePx })),
  cam.imgH,
);
const stage1 = stages.find((s) => s.preset.presetIdx === 1)!;

// ═════════════════════════════════════════════════════════════════════════════
describe('buildPresetModel — 프리셋 1개 → 지면모델(정상/강등/mIssue)', () => {
  it('정상: 유효 프리셋 → GroundModel 산출({camIdx,presetIdx,f>0,n,d>0,conf∈[0,1]})', () => {
    const m = buildPresetModel(stage1, pooled, cam.camIdx, cam.imgW, cam.imgH, CX, CY, OPTS);
    expect(m).not.toBeNull();
    const model = m!;
    expect(model.camIdx).toBe(cam.camIdx);
    expect(model.presetIdx).toBe(1);
    expect(model.imgW).toBe(cam.imgW);
    expect(model.imgH).toBe(cam.imgH);
    expect(model.f).toBeGreaterThan(0);
    expect(model.d).toBeGreaterThan(0);
    expect(model.n).toHaveLength(3);
    expect(model.conf).toBeGreaterThanOrEqual(0);
    expect(model.conf).toBeLessThanOrEqual(1);
    expect(model.source).toBe('file');
    // 정상 경로(zoom+공동추정 f)에서는 단독 f 강등 issue 가 없다.
    expect(model.issues.join()).not.toContain('프리셋 단독 f 채택');
  });

  it('강등(null): vps 없음 → 모델 없음(육면체 미표시)', () => {
    const dead: PresetStage = { preset: stage1.preset, vps: null, fSolo: null, depthEdgePx: 0 };
    expect(buildPresetModel(dead, pooled, cam.camIdx, cam.imgW, cam.imgH, CX, CY, OPTS)).toBeNull();
  });

  it('mIssue exact 스냅샷: pooled=null → 프리셋 단독 f 강등, 고정 문장이 issues 에 실린다(§6-2 불변)', () => {
    // pooled 미상 + preset.zoom 유효 → f 공동추정 불가 → fSolo 채택 강등. 문장은 **보간 없는 리터럴**.
    const m = buildPresetModel(stage1, null, cam.camIdx, cam.imgW, cam.imgH, CX, CY, OPTS);
    expect(m).not.toBeNull();
    expect(m!.issues).toContain(
      'zoom/공동추정 불가 — 프리셋 단독 f 채택(얕은 tilt 에서 최대 35% 오차 위험)',
    );
  });

  it('mIssue: 깊이변 하한 상향(minDepthEdgePx 과대) → 조건수 경고 issue 발화(접미부 불변)', () => {
    const strict: GroundOptions = { ...OPTS, minDepthEdgePx: 10_000_000 };
    const m = buildPresetModel(stage1, pooled, cam.camIdx, cam.imgW, cam.imgH, CX, CY, strict);
    expect(m).not.toBeNull();
    expect(m!.issues.some((s) => s.includes('조건수 낮음(f 는 프리셋 공동추정으로 보정)'))).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// crossPresetSimilarityChecks — 지면 닮음변환 교차검증. m.dDevRel/bearingDevDeg/issues 를 채운다.
const baseModel = (over: Partial<GroundModel>): GroundModel => ({
  camIdx: 1, presetIdx: 1, imgW: 1920, imgH: 1080, zoom: 1, f: 1500,
  n: [0, 0.97, 0.24], d: 5.0, tiltDeg: 14, ptzTiltDeg: null, tiltErrDeg: null,
  slotBearingDeg: null, bearingDevDeg: null, dDevRel: null,
  depthEdgePx: 400, metricErr: 0, conf: 1, source: 'file', issues: [],
  ...over,
});

describe('crossPresetSimilarityChecks — 프리셋 간 불변량 대조', () => {
  it('균일스케일 오류: d 불일치(5.0 vs 2.0) → dDevRel 채워지고 model.issues 발화', () => {
    const models = [
      baseModel({ presetIdx: 1, d: 5.0 }),
      baseModel({ presetIdx: 2, d: 2.0 }),
    ];
    const issues: string[] = [];
    crossPresetSimilarityChecks(models, issues);
    for (const m of models) {
      expect(m.dDevRel).not.toBeNull();
      expect(Math.abs(m.dDevRel!)).toBeGreaterThan(0.1); // D_DEV_REL 임계 초과.
      expect(m.issues.some((s) => s.includes('지면 균일스케일 오류 의심'))).toBe(true);
    }
    // slotBearingDeg 전부 null → 수직축 회전 검출 불가 advisory(전역 issues).
    expect(issues.some((s) => s.includes('수직축 회전 검출 불가'))).toBe(true);
  });

  it('수직축 회전: 슬롯 방위 불일치(10° vs 40°) → bearingDevDeg 채워지고 회전 의심 issue', () => {
    const models = [
      baseModel({ presetIdx: 1, d: 5.0, slotBearingDeg: 10 }),
      baseModel({ presetIdx: 2, d: 5.0, slotBearingDeg: 40 }),
    ];
    const issues: string[] = [];
    crossPresetSimilarityChecks(models, issues);
    for (const m of models) {
      expect(m.bearingDevDeg).not.toBeNull();
      expect(Math.abs(m.bearingDevDeg!)).toBeGreaterThan(8); // BEARING_DEV_DEG 임계 초과.
      expect(m.issues.some((s) => s.includes('수직축 회전 의심'))).toBe(true);
    }
    // d 일관 → 균일스케일 issue 없음.
    expect(models.every((m) => !m.issues.some((s) => s.includes('균일스케일')))).toBe(true);
  });

  it('프리셋 1개 → 교차검증 불가 advisory, dDevRel 은 null 유지', () => {
    const models = [baseModel({ presetIdx: 1, d: 5.0, slotBearingDeg: 10 })];
    const issues: string[] = [];
    crossPresetSimilarityChecks(models, issues);
    expect(issues.some((s) => s.includes('교차검증 불가'))).toBe(true);
    expect(models[0].dDevRel).toBeNull();
    expect(models[0].bearingDevDeg).toBeNull();
  });
});
