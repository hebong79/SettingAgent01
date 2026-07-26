import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { correctorFromCalibration, IDENTITY_CORRECTOR, loadLensCorrector } from '../src/calibrate/lensCorrection.js';
import { CameraCalibration } from '@parkagent/lens-calib';

/**
 * 검증자: 렌즈 보정 어댑터(설계서 20260725 §10). 축:
 *   1. **기본 OFF** — 파일 없음/비활성/빈 표 → 항등(입력 그대로). 회귀 0 의 근거.
 *   2. 활성 + 실측 표 → 실제 보정(정규화 ↔ 픽셀 환산 포함).
 *   3. 잘못된 표/파일 → 조용히 항등 강등(조준을 멈추게 하느니).
 */

const tmpDirs: string[] = [];
function writeFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lenscalib-'));
  tmpDirs.push(dir);
  const p = join(dir, 'lens_calibration.json');
  writeFileSync(p, content, 'utf8');
  return p;
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('loadLensCorrector — 기본 OFF (회귀 0 의 근거)', () => {
  it('파일이 없으면 항등', () => {
    expect(loadLensCorrector('/존재하지/않는/경로.json', 'real-camera-2')).toBe(IDENTITY_CORRECTOR);
  });

  it('해당 id 가 없으면 항등', () => {
    const p = writeFile(JSON.stringify({ cameras: [{ id: 'real-camera-2', model: 'cam-001', enabled: true }] }));
    expect(loadLensCorrector(p, 'real-camera-1')).toBe(IDENTITY_CORRECTOR);
  });

  it('enabled 가 true 가 아니면 항등 (검증 pass 를 사람이 켜야 한다)', () => {
    const p = writeFile(JSON.stringify({ cameras: [{ id: 'real-camera-2', model: 'cam-001' }] })); // enabled 없음
    expect(loadLensCorrector(p, 'real-camera-2')).toBe(IDENTITY_CORRECTOR);
    const p2 = writeFile(JSON.stringify({ cameras: [{ id: 'real-camera-2', model: 'cam-001', enabled: false }] }));
    expect(loadLensCorrector(p2, 'real-camera-2')).toBe(IDENTITY_CORRECTOR);
  });

  it('표가 비어 있으면 항등', () => {
    const p = writeFile(JSON.stringify({ cameras: [{ id: 'real-camera-2', enabled: true }] }));
    expect(loadLensCorrector(p, 'real-camera-2')).toBe(IDENTITY_CORRECTOR);
  });

  it('깨진 JSON 이면 조용히 항등', () => {
    const p = writeFile('{ 깨진 json');
    expect(loadLensCorrector(p, 'real-camera-2')).toBe(IDENTITY_CORRECTOR);
  });

  it('camIdx(숫자) 하위호환 매칭도 된다', () => {
    const p = writeFile(JSON.stringify({ cameras: [{ camIdx: 2, model: 'cam-001', enabled: true }] }));
    expect(loadLensCorrector(p, 2)).not.toBe(IDENTITY_CORRECTOR);
    expect(loadLensCorrector(p, 1)).toBe(IDENTITY_CORRECTOR);
  });
});

describe('correctorFromCalibration — 활성 시 실제 보정', () => {
  it('★게인 표가 있으면 정규화 좌표를 민다', () => {
    const corr = correctorFromCalibration(CameraCalibration.from('cam-001'));
    // z8000(게인 1.11)에서 편심이 커진다. 화면 오른쪽 클릭(0.9)은 더 오른쪽으로.
    const out = corr.correct({ x: 0.9, y: 0.5 }, 8000);
    expect(out.x).toBeGreaterThan(0.9);
    expect(out.y).toBeCloseTo(0.5, 6); // 세로 중앙은 그대로
  });

  it('★게인이 1 에 가까운 줌에서는 거의 안 움직인다', () => {
    const corr = correctorFromCalibration(CameraCalibration.from('cam-001'));
    const out = corr.correct({ x: 0.9, y: 0.5 }, 0); // z0 게인 0.988
    expect(Math.abs(out.x - 0.9)).toBeLessThan(0.02);
  });

  it('중심 클릭은 어떤 줌에서도 중심 그대로', () => {
    const corr = correctorFromCalibration(CameraCalibration.from('cam-001'));
    expect(corr.correct({ x: 0.5, y: 0.5 }, 8000)).toEqual({ x: 0.5, y: 0.5 });
  });

  it('곡면율까지 있으면 게인만일 때보다 편심을 더 민다', () => {
    const gainOnly = correctorFromCalibration(CameraCalibration.from('cam-001'));
    const withDist = correctorFromCalibration(
      CameraCalibration.from({
        model: 'cam-001',
        lensDistortion: [
          { z: 0, k1: -0.085, k2: 0.012 },
          { z: 8000, k1: -0.02, k2: 0 },
        ],
      }),
    );
    const g = gainOnly.correct({ x: 0.95, y: 0.85 }, 0);
    const d = withDist.correct({ x: 0.95, y: 0.85 }, 0);
    expect(Math.hypot(d.x - 0.5, d.y - 0.5)).toBeGreaterThan(Math.hypot(g.x - 0.5, g.y - 0.5));
  });

  it('보정할 표가 전혀 없으면 항등 객체를 그대로 돌려준다', () => {
    expect(correctorFromCalibration(CameraCalibration.from(null))).toBe(IDENTITY_CORRECTOR);
  });

  it('활성 표를 id 로 로드하면 실제 보정기가 나온다 (end-to-end)', () => {
    const p = writeFile(JSON.stringify({ cameras: [{ id: 'real-camera-2', model: 'cam-001', enabled: true }] }));
    const corr = loadLensCorrector(p, 'real-camera-2');
    expect(corr).not.toBe(IDENTITY_CORRECTOR);
    const out = corr.correct({ x: 0.9, y: 0.5 }, 8000);
    expect(out.x).toBeGreaterThan(0.9);
  });
});
