import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  AUTO_MODEL_ISSUE,
  bootstrapCameraConstants,
  buildAutoGroundModel,
  ptzNormal,
} from '../src/ground/groundBootstrap.js';
import { buildGroundInputs } from '../src/ground/groundInputs.js';
import { crossPresetSimilarityChecks, estimateGroundModels } from '../src/ground/groundModel.js';
import { fitGridFromQuads, gridToPixelQuads } from '../src/ground/groundGrid.js';
import { quadIoU } from '../src/ground/autoRoiPlan.js';
import type { GroundOptions } from '../src/ground/types.js';

/**
 * L3 Loop 3 — 부트스트랩 + 리더 D-3 **홀드아웃 대조**.
 *
 * ★ 리더 원안(`crossPresetSimilarityChecks` 통과)은 자동 모델에 대해 **항진명제**다
 *   (d 를 같은 상수에서 복사하고 방위도 같은 격자에서 나오므로 dDevRel·bearingDevDeg 가 정의상 0).
 *   → 여기서는 preset1 quad **1개**로만 부트스트랩한 뒤 preset2/3 의 auto 모델을
 *     **파일 유래 모델**과 대조한다(|Δd|/d<10%, |Δtilt|<1.0°, |Δf|/f<5%).
 *
 * ⚠️ 정직성: 이 데이터(Unity 시뮬레이터 생성 원형의 동결 사본)는 PTZ 보고값이 **정확**하고
 *    격자가 **구조적으로 완벽**하다. 편차 0.00% 는 "실카에서도 0" 을 뜻하지 않는다.
 *    이 테스트가 증명하는 것은 **파이프라인 수학이 무손실**이라는 것뿐이다.
 */

const OPTS: GroundOptions = { minDepthEdgePx: 250, slotWidthM: 2.5, slotDepthM: 5.0 };
/** 동결 픽스처(런타임 가변 파일 비의존 — groundGrid.test.ts 상단 사유 참조). */
const ROI_FILE = 'test/fixtures/groundGrid.PtzCamRoi.json';

function realCams() {
  const raw = JSON.parse(readFileSync(ROI_FILE, 'utf8'));
  return buildGroundInputs(raw, []).map((cam) => ({ cam, models: estimateGroundModels(cam, OPTS).models }));
}

describe('ptzNormal', () => {
  it('groundModel 의 tiltDeg = asin(n[2]) 의 정확한 역이다', () => {
    for (const t of [0, 8.7, 20.1, 35.8, 60]) {
      const n = ptzNormal(t);
      expect(Math.hypot(...n)).toBeCloseTo(1, 12);
      expect((Math.asin(n[2]) * 180) / Math.PI).toBeCloseTo(t, 10);
      expect(n[1]).toBeGreaterThan(0); // 하향(카메라 y→아래).
    }
  });
});

describe('bootstrapCameraConstants', () => {
  it('주차면 1개 + PTZ → 카메라 상수(d/fovBaseV)', () => {
    for (const { cam } of realCams()) {
      const p = cam.presets[0];
      const boot = bootstrapCameraConstants(
        { camIdx: cam.camIdx, imgW: cam.imgW, imgH: cam.imgH, presetIdx: p.presetIdx,
          zoom: p.zoom!, tilt: p.tilt!, pan: p.pan!, quad: p.quads[0] },
        OPTS,
      )!;
      expect(boot).toBeTruthy();
      expect(boot.constants.d).toBeGreaterThan(3);
      expect(boot.constants.d).toBeLessThan(8);
      expect(boot.constants.fovBaseV).toBeGreaterThan(10);
      expect(boot.constants.rollDeg).toBe(0);
      expect(boot.constants.fromPresetIdx).toBe(p.presetIdx);
      // 표본 1개라는 사실을 반드시 드러낸다(강등 위장 금지).
      expect(boot.issues.some((i) => i.includes('주차면 1개'))).toBe(true);
    }
  });

  it('퇴화 입력 → null (throw 금지)', () => {
    const { cam } = realCams()[0];
    const p = cam.presets[0];
    const base = { camIdx: 1, imgW: cam.imgW, imgH: cam.imgH, presetIdx: 1, zoom: 1, tilt: 10, pan: 0 };
    // 선분(면적 0) quad.
    expect(bootstrapCameraConstants({ ...base, quad: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }] }, OPTS)).toBeNull();
    // zoom 0 → fovBaseV 역산 불가.
    expect(bootstrapCameraConstants({ ...base, zoom: 0, quad: p.quads[0] }, OPTS)).toBeNull();
    // 이미지 크기 오류.
    expect(bootstrapCameraConstants({ ...base, imgW: 0, quad: p.quads[0] }, OPTS)).toBeNull();
  });
});

describe('buildAutoGroundModel — 정직성 규약(설계 §4-3)', () => {
  it('conf 를 1.0 으로 채우지 않고 부트스트랩 conf 를 상속하며 고정 issue 를 항상 붙인다', () => {
    const { cam } = realCams()[0];
    const p = cam.presets[0];
    const boot = bootstrapCameraConstants(
      { camIdx: cam.camIdx, imgW: cam.imgW, imgH: cam.imgH, presetIdx: p.presetIdx,
        zoom: p.zoom!, tilt: p.tilt!, pan: p.pan!, quad: p.quads[0] },
      OPTS,
    )!;
    for (const q of cam.presets) {
      const auto = buildAutoGroundModel(boot.constants, {
        presetIdx: q.presetIdx, zoom: q.zoom!, tilt: q.tilt!, pan: q.pan!,
      })!;
      expect(auto.source).toBe('auto');
      expect(auto.issues).toContain(AUTO_MODEL_ISSUE);
      expect(auto.conf).toBe(boot.constants.bootstrapConf);
      expect(auto.metricErr).toBe(0); // 구성상 0.
      expect(auto.tiltErrDeg).toBe(0); // 구성상 0.
      expect(auto.slotBearingDeg).toBeNull(); // 이미지 증거 없음 → 방위 불변량을 주장하지 않는다.
    }
  });

  it('f 유도 불가 → null', () => {
    const c = { camIdx: 1, imgW: 1920, imgH: 1080, d: 5, fovBaseV: 35, rollDeg: 0, fromPresetIdx: 1, bootstrapConf: 0.5, issues: [] };
    expect(buildAutoGroundModel(c, { presetIdx: 2, zoom: 0, tilt: 20, pan: 0 })).toBeNull();
    expect(buildAutoGroundModel({ ...c, fovBaseV: 0 }, { presetIdx: 2, zoom: 1, tilt: 20, pan: 0 })).toBeNull();
    expect(buildAutoGroundModel({ ...c, d: 0 }, { presetIdx: 2, zoom: 1, tilt: 20, pan: 0 })).toBeNull();
  });
});

describe('★ D-3 홀드아웃 대조 (리더 승인 기준)', () => {
  it('preset1 quad 1개 부트스트랩 → 나머지 프리셋 auto 모델 vs 파일 유래 모델', () => {
    let compared = 0;
    for (const { cam, models } of realCams()) {
      const p1 = cam.presets[0];
      const boot = bootstrapCameraConstants(
        { camIdx: cam.camIdx, imgW: cam.imgW, imgH: cam.imgH, presetIdx: p1.presetIdx,
          zoom: p1.zoom!, tilt: p1.tilt!, pan: p1.pan!, quad: p1.quads[0] },
        OPTS,
      )!;
      for (const p of cam.presets) {
        if (p.presetIdx === p1.presetIdx) continue; // 홀드아웃 — 부트스트랩에 쓴 프리셋은 제외.
        const auto = buildAutoGroundModel(boot.constants, {
          presetIdx: p.presetIdx, zoom: p.zoom!, tilt: p.tilt!, pan: p.pan!,
        })!;
        const file = models.find((m) => m.presetIdx === p.presetIdx)!;
        expect(Math.abs(auto.d - file.d) / file.d, `cam${cam.camIdx} p${p.presetIdx} Δd`).toBeLessThan(0.1);
        expect(Math.abs(auto.tiltDeg - file.tiltDeg), `cam${cam.camIdx} p${p.presetIdx} Δtilt`).toBeLessThan(1.0);
        expect(Math.abs(auto.f - file.f) / file.f, `cam${cam.camIdx} p${p.presetIdx} Δf`).toBeLessThan(0.05);
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThanOrEqual(3);
  });

  it('★ Loop 4: 홀드아웃 프리셋의 격자를 auto 모델로 재투영 → 파일 quad 대비 평균 IoU ≥ 0.9', () => {
    for (const { cam, models } of realCams()) {
      const p1 = cam.presets[0];
      const boot = bootstrapCameraConstants(
        { camIdx: cam.camIdx, imgW: cam.imgW, imgH: cam.imgH, presetIdx: p1.presetIdx,
          zoom: p1.zoom!, tilt: p1.tilt!, pan: p1.pan!, quad: p1.quads[0] },
        OPTS,
      )!;
      for (const p of cam.presets) {
        if (p.presetIdx === p1.presetIdx) continue;
        const file = models.find((m) => m.presetIdx === p.presetIdx)!;
        const auto = buildAutoGroundModel(boot.constants, {
          presetIdx: p.presetIdx, zoom: p.zoom!, tilt: p.tilt!, pan: p.pan!,
        })!;
        // 격자는 그 주차열의 파일 quad 로 적합하고(위상은 그 열 고유), **투영만** auto 모델로 한다.
        const { grid } = fitGridFromQuads(p.quads, file, p.pan, OPTS);
        const { quads } = gridToPixelQuads(grid!, auto, p.pan);
        expect(quads.length).toBe(p.quads.length); // 슬롯 개수 일치.
        const ious = quads.map((q) => quadIoU(q.quad, p.quads[q.slotId - 1]));
        const avg = ious.reduce((s, x) => s + x, 0) / ious.length;
        expect(avg, `cam${cam.camIdx} preset${p.presetIdx}`).toBeGreaterThanOrEqual(0.9);
      }
    }
  });

  it('전제 재확인: 파일 유래 모델 집합은 crossPresetSimilarityChecks 를 통과한다(신규 검증기 0)', () => {
    for (const { cam, models } of realCams()) {
      if (models.length < 2) continue;
      const issues: string[] = [];
      crossPresetSimilarityChecks(models, issues);
      for (const m of models) {
        expect(Math.abs(m.dDevRel ?? 0), `cam${cam.camIdx} p${m.presetIdx} dDevRel`).toBeLessThan(0.1);
        expect(Math.abs(m.bearingDevDeg ?? 0), `cam${cam.camIdx} p${m.presetIdx} bearingDev`).toBeLessThan(8);
      }
    }
  });
});
