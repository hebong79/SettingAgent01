import { describe, it, expect } from 'vitest';
import { PtzCalibrator, type PtzCalibratorDeps } from '../src/calibrate/PtzCalibrator.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { LpdClient, PlateBox } from '../src/clients/LpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { SetupArtifact } from '../src/domain/types.js';
import { rectToQuad } from '../src/domain/geometry.js';
import type { SlotPtzArtifact } from '../src/calibrate/types.js';

/**
 * 검증자(qa-tester): PtzCalibrator (camera/lpd 모킹, sleep/now 주입).
 * ★ 명령 PTZ 추적: 모킹 LPD 가 응답 PTZ 가 아닌 "명령한 PTZ"(requestImage ptz override)에 따라
 *   번호판 위치/폭을 만든다(시뮬 echo 0/0/1 무관 가정 재현). 순서(중심→줌)·수렴·폴백 검증.
 */

const cfg: ToolsConfig['calibrate'] = {
  targetPlateWidth: 0.2, centerTol: 0.03, widthTol: 0.02, maxIterations: 30,
  probeStepDeg: 1.0, maxStepDeg: 5.0, fallbackGainPanDeg: -62, fallbackGainTiltDeg: -35.5,
  settleMs: 0, outFile: 'data/slot_ptz.json',
};

/** plateRoiByPreset 1슬롯 fixture. */
function artifact(): SetupArtifact {
  return {
    createdAt: 'T', presets: [],
    globalIndex: [{ globalIdx: 7, slotId: 'c1p1s1', camIdx: 1, presetIdx: 1 }],
    slots: [{ slotId: 'c1p1s1', zone: 'z', roiByPreset: { '1:1': { x: 0.6, y: 0.6, w: 0.1, h: 0.05 } }, plateRoiByPreset: { '1:1': rectToQuad({ x: 0.62, y: 0.62, w: 0.05, h: 0.03 }) } }],
  };
}

function repoWith(a: SetupArtifact | null): Repository {
  return { loadArtifact: () => a } as unknown as Repository;
}

/**
 * 모킹 모델: 명령 PTZ → 번호판 위치/폭.
 *  - 초기(pan0,tilt0): 번호판 중심 (0.7, 0.8) → 우하단(중심정렬 필요).
 *  - centerX = 0.7 - pan*0.02 (pan 늘리면 왼쪽), centerY = 0.8 - tilt*0.02.
 *  - width = 0.05 * zoom (zoom 늘리면 폭 증가). 목표폭 0.2 → zoom≈4 에서 도달.
 * 명령 PTZ 만으로 결정(응답 echo 무관) → ★ 검증.
 */
function makeMockModel() {
  const moves: Array<{ pan: number; tilt: number; zoom: number }> = [];
  const camera = {
    clampZoom: (z: number) => Math.min(36, Math.max(1, z)),
    requestImage: async (_c: number, _p: number, ptz?: { pan?: number; tilt?: number; zoom?: number }) => {
      const pan = ptz?.pan ?? 0;
      const tilt = ptz?.tilt ?? 0;
      const zoom = ptz?.zoom ?? 1;
      moves.push({ pan, tilt, zoom });
      return { camIdx: 1, presetIdx: 1, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('img') };
    },
  } as unknown as CameraClient;

  const lpd = {
    detect: async (): Promise<PlateBox[]> => {
      const last = moves[moves.length - 1];
      const cx = 0.7 - last.pan * 0.02;
      const cy = 0.8 - last.tilt * 0.02;
      const w = Math.min(0.9, 0.05 * last.zoom);
      const h = 0.03;
      return [{ quad: rectToQuad({ x: cx - w / 2, y: cy - h / 2, w, h }), confidence: 0.9, cls: 'plate' }];
    },
  } as unknown as LpdClient;

  return { camera, lpd, moves };
}

function makeCalibrator(over: Partial<PtzCalibratorDeps> = {}, a: SetupArtifact | null = artifact()) {
  const m = makeMockModel();
  let saved: SlotPtzArtifact | undefined;
  const deps: PtzCalibratorDeps = {
    camera: m.camera, lpd: m.lpd, repo: repoWith(a), cfg,
    writer: (art) => { saved = art; },
    sleep: async () => {}, now: () => 'T',
    ...over,
  };
  return { cal: new PtzCalibrator(deps), getSaved: () => saved, moves: m.moves };
}

/** 잡 완료까지 대기(백그라운드 run 의 microtask flush). */
async function waitDone(cal: PtzCalibrator): Promise<void> {
  for (let i = 0; i < 5000 && cal.getStatus().state === 'running'; i++) await Promise.resolve();
}

describe('PtzCalibrator 수렴 happy path', () => {
  it('중심·목표폭 수렴 → centered·converged true, plateWidth≈0.2', async () => {
    const { cal, getSaved } = makeCalibrator();
    cal.start();
    await waitDone(cal);
    expect(cal.getStatus().state).toBe('done');
    const art = getSaved()!;
    expect(art.items).toHaveLength(1);
    const it = art.items[0];
    expect(it.centered).toBe(true);
    expect(it.converged).toBe(true);
    expect(it.plateWidth).toBeCloseTo(0.2, 1);
    expect(it.globalIdx).toBe(7);
  });
});

describe('PtzCalibrator 순서(중심→줌)', () => {
  it('zoom 변화는 중심 수렴 이후에만 발생', async () => {
    const { cal, moves } = makeCalibrator();
    cal.start();
    await waitDone(cal);
    // 첫 zoom!=1 명령의 인덱스 vs 마지막 pan/tilt 변화 인덱스 비교.
    const firstZoomChange = moves.findIndex((m) => Math.abs(m.zoom - 1) > 1e-9);
    // 중심정렬 단계의 마지막 pan/tilt 변화(=중심 수렴 직전)는 firstZoomChange 이전이어야 함.
    let lastPanTiltChange = -1;
    for (let i = 1; i < moves.length; i++) {
      if (Math.abs(moves[i].pan - moves[i - 1].pan) > 1e-9 || Math.abs(moves[i].tilt - moves[i - 1].tilt) > 1e-9) {
        if (firstZoomChange === -1 || i < firstZoomChange) lastPanTiltChange = i;
      }
    }
    expect(firstZoomChange).toBeGreaterThan(0);
    expect(lastPanTiltChange).toBeGreaterThan(0);
    expect(lastPanTiltChange).toBeLessThan(firstZoomChange);
  });
});

describe('PtzCalibrator 번호판 미검출', () => {
  it('LPD 빈 배열 → 스킵·reason no_plate, 잡 계속', async () => {
    const emptyLpd = { detect: async () => [] } as unknown as LpdClient;
    const { cal, getSaved } = makeCalibrator({ lpd: emptyLpd });
    cal.start();
    await waitDone(cal);
    expect(cal.getStatus().state).toBe('done');
    const it = getSaved()!.items[0];
    expect(it.reason).toBe('no_plate');
    expect(it.centered).toBe(false);
    expect(it.converged).toBe(false);
  });
});

describe('PtzCalibrator maxIter 미수렴', () => {
  it('절대 안 맞는 모킹 → converged false, 상한 종료', async () => {
    // 항상 우하단·과대폭 고정(보정 무반응) → 미수렴.
    const stuckLpd = {
      detect: async (): Promise<PlateBox[]> => [{ quad: rectToQuad({ x: 0.8, y: 0.8, w: 0.5, h: 0.03 }), confidence: 0.9, cls: 'plate' }],
    } as unknown as LpdClient;
    const { cal, getSaved } = makeCalibrator({ lpd: stuckLpd });
    cal.start();
    await waitDone(cal);
    expect(cal.getStatus().state).toBe('done');
    const it = getSaved()!.items[0];
    expect(it.centered).toBe(false);
    expect(it.converged).toBe(false);
  });
});

describe('PtzCalibrator 다수 번호판', () => {
  it('대상 prior 최근접 선택(엉뚱한 번호판 무시하고 수렴)', async () => {
    const m = makeMockModel();
    // 진짜 번호판 + prior 에서 먼 노이즈 번호판 1개 추가.
    const origDetect = m.lpd.detect.bind(m.lpd);
    const lpd = {
      detect: async (jpg: Buffer): Promise<PlateBox[]> => {
        const real = await origDetect(jpg);
        return [...real, { quad: rectToQuad({ x: 0.05, y: 0.05, w: 0.05, h: 0.03 }), confidence: 0.95, cls: 'plate' }];
      },
    } as unknown as LpdClient;
    const { cal, getSaved } = makeCalibrator({ camera: m.camera, lpd });
    cal.start();
    await waitDone(cal);
    const it = getSaved()!.items[0];
    expect(it.centered).toBe(true); // 노이즈에 끌려가지 않고 수렴
  });
});

describe('PtzCalibrator 중복 시작·산출물 없음', () => {
  it('running 중 start → throw', async () => {
    const { cal } = makeCalibrator();
    cal.start();
    expect(() => cal.start()).toThrow('already running');
    await waitDone(cal);
  });

  it('setup_artifact 없음 → throw', () => {
    const { cal } = makeCalibrator({}, null);
    expect(() => cal.start()).toThrow('no setup artifact');
  });
});
