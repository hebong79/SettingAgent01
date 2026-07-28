import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalizeQuad, fitGridFromQuads, gridToPixelQuads, sortedCells } from '../src/ground/groundGrid.js';
import { groundCoordsOf, groundFrameOf } from '../src/ground/groundFrame.js';
import { backprojectToGround } from '../src/ground/project.js';
import { buildGroundInputs } from '../src/ground/groundInputs.js';
import { estimateGroundModels, isUsableQuad } from '../src/ground/groundModel.js';
import { quadIoU } from '../src/ground/autoRoiPlan.js';
import { stringify5 } from '../src/util/round.js';
import type { GroundOptions, PixelQuad } from '../src/ground/types.js';

/**
 * L3 Loop 2/3-1 — 격자 자료구조 + 순수 변환 + 실데이터 왕복 복원.
 * 리더 Loop 1(왕복 IoU 1.0000)을 **저장소 테스트로 봉인**한다.
 */

const OPTS: GroundOptions = { minDepthEdgePx: 250, slotWidthM: 2.5, slotDepthM: 5.0 };
/**
 * ★ **동결 픽스처**를 쓴다. 런타임 정본(data/Place01 아래 PtzCamRoi.json)을 쓰면 안 된다:
 *   그 파일은 사용자가 뷰어에서 주차면을 편집·저장하면 바뀌고, **이 기능의 apply 라우트가 스스로 덮어쓴다**
 *   (self-invalidating seal). 아래 골든 해시가 그 파일에 봉인돼 있으면 **기능을 한 번 쓰는 순간 CI 가 red** 다.
 *   선례: `test/groundModelRealData.test.ts` 상단 — "사용자가 앱을 쓰는 것만으로 깨지는 테스트는 테스트가 아니다".
 */
const ROI_FILE = 'test/fixtures/groundGrid.PtzCamRoi.json';

function realCams() {
  const raw = JSON.parse(readFileSync(ROI_FILE, 'utf8'));
  return buildGroundInputs(raw, []).map((cam) => ({ cam, models: estimateGroundModels(cam, OPTS).models }));
}

describe('canonicalizeQuad', () => {
  // 근좌(0,300) 원좌(0,0) 원우(200,0) 근우(200,300) — 픽셀 y 가 클수록 근(화면 아래).
  const ref: PixelQuad = [
    { x: 0, y: 300 },
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 300 },
  ];

  it('임의 회전/감김 입력이 항상 같은 규약 순서로 정규화된다', () => {
    for (let rot = 0; rot < 4; rot++) {
      const rotated = [0, 1, 2, 3].map((i) => ref[(i + rot) % 4]);
      expect(canonicalizeQuad(rotated)).toEqual(ref);
      expect(canonicalizeQuad([...rotated].reverse())).toEqual(ref);
    }
  });

  it('결과는 isUsableQuad 를 통과하고 p0/p3 가 근변(y 최대)이다', () => {
    const q = canonicalizeQuad([ref[2], ref[0], ref[3], ref[1]])!;
    expect(isUsableQuad(q)).toBe(true);
    expect(q[0].y).toBeGreaterThan(q[1].y);
    expect(q[3].y).toBeGreaterThan(q[2].y);
  });

  it('퇴화/비유한 → null (throw 금지)', () => {
    expect(canonicalizeQuad([])).toBeNull();
    expect(canonicalizeQuad([ref[0], ref[1], ref[2]])).toBeNull();
    expect(canonicalizeQuad([ref[0], ref[1], ref[2], { x: Number.NaN, y: 0 }])).toBeNull();
    // 4점 공선 → 면적 0.
    expect(canonicalizeQuad([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }])).toBeNull();
  });
});

describe('fitGridFromQuads / gridToPixelQuads — 실데이터 왕복 복원', () => {
  it('★ 전 카메라·전 프리셋 평균 IoU ≥ 0.95 (리더 Loop 1 봉인)', () => {
    let checked = 0;
    for (const { cam, models } of realCams()) {
      for (const m of models) {
        const p = cam.presets.find((q) => q.presetIdx === m.presetIdx)!;
        const { grid } = fitGridFromQuads(p.quads, m, p.pan, OPTS);
        expect(grid, `cam${cam.camIdx} preset${m.presetIdx}`).toBeTruthy();
        const { quads } = gridToPixelQuads(grid!, m, p.pan);
        expect(quads.length).toBe(p.quads.length); // 조용한 누락 0건.
        const ious = quads.map((q) => quadIoU(q.quad, p.quads[q.slotId - 1]));
        const avg = ious.reduce((s, x) => s + x, 0) / ious.length;
        expect(avg, `cam${cam.camIdx} preset${m.presetIdx} avgIoU`).toBeGreaterThanOrEqual(0.95);
        expect(Math.min(...ious)).toBeGreaterThanOrEqual(0.95);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(5);
  });

  it('★ 함정1: 열 피치는 슬롯 폭(2.5m) — 깊이(5.0m)로 잡으면 IoU 가 1/0 으로 교대한다', () => {
    const { cam, models } = realCams()[0];
    const m = models.find((x) => x.presetIdx === 1)!;
    const p = cam.presets.find((q) => q.presetIdx === 1)!;
    const { grid } = fitGridFromQuads(p.quads, m, p.pan, OPTS);
    expect(grid!.colPitchM).toBe(OPTS.slotWidthM);
    expect(grid!.rowPitchM).toBe(OPTS.slotDepthM);
    // 폭 방향으로 7칸이 반복되는 단일 행이어야 한다(피치를 깊이로 잡으면 rows 가 7이 된다).
    expect(grid!.rows).toBe(1);
    expect(grid!.cols).toBe(7);
  });

  it('★ 함정2/3: 스팬 축이 뒤집힌 프리셋(cam1 preset3)도 (row,col) 로 흡수된다', () => {
    const { cam, models } = realCams()[0];
    const m = models.find((x) => x.presetIdx === 3)!;
    const p = cam.presets.find((q) => q.presetIdx === 3)!;
    const { grid } = fitGridFromQuads(p.quads, m, p.pan, OPTS);
    // preset1(θ≈90) 과 달리 축이 90° 돌아 있다 — [0,90) 로 접었다면 표현 불가능한 상태.
    expect(grid!.thetaDeg).toBeGreaterThanOrEqual(0);
    expect(grid!.thetaDeg).toBeLessThan(180);
    expect(grid!.rows).toBe(2);
    expect(grid!.cols).toBe(1);
  });

  it('순회 순서는 (row asc, col asc) 로 고정된다 — 키 삽입 순서 무관', () => {
    const grid = {
      camIdx: 1, originM: { a: 0, b: 0 }, thetaDeg: 0, colPitchM: 2.5, rowPitchM: 5,
      cols: 2, rows: 2, slotIdByCell: { '1:1': 4, '0:1': 2, '1:0': 3, '0:0': 1 }, issues: [],
    };
    expect(sortedCells(grid).map((c) => `${c.row}:${c.col}`)).toEqual(['0:0', '0:1', '1:0', '1:1']);
  });

  it('강등: PTZ pan 미상 → quads 0 + issues (throw 금지)', () => {
    const { cam, models } = realCams()[0];
    const m = models[0];
    const p = cam.presets[0];
    const r = gridToPixelQuads(fitGridFromQuads(p.quads, m, p.pan, OPTS).grid!, m, null);
    expect(r.quads).toHaveLength(0);
    expect(r.issues.length).toBeGreaterThan(0);
    expect(fitGridFromQuads([], m, p.pan, OPTS).grid).toBeNull();
    expect(fitGridFromQuads([], m, p.pan, OPTS).issues.length).toBeGreaterThan(0);
  });

  it('결정론: 같은 입력 2회 → 산출 문자열 완전 동일', () => {
    const { cam, models } = realCams()[0];
    const m = models[0];
    const p = cam.presets[0];
    const run = () => {
      const { grid } = fitGridFromQuads(p.quads, m, p.pan, OPTS);
      return stringify5({ grid, quads: gridToPixelQuads(grid!, m, p.pan).quads });
    };
    expect(run()).toBe(run());
  });
});

describe('★ 프리셋 불변 프레임 실증 (실데이터, 설계 Loop 3-1)', () => {
  it('전 프리셋 quad 를 지면 2D 로 올리면 축이 e1/e2 에 정렬되고 스팬이 2.5/5.0m 로 나온다', () => {
    const { cam, models } = realCams()[0];
    for (const m of models) {
      const p = cam.presets.find((q) => q.presetIdx === m.presetIdx)!;
      const fr = groundFrameOf(m, p.pan)!;
      for (const q of p.quads) {
        const g = q.map((px) => groundCoordsOf(fr, backprojectToGround(px, m)!));
        for (let i = 0; i < 4; i++) {
          const a = g[i];
          const b = g[(i + 1) % 4];
          const len = Math.hypot(b.a - a.a, b.b - a.b);
          const ang = ((((Math.atan2(b.b - a.b, b.a - a.a) * 180) / Math.PI) % 90) + 90) % 90;
          // 축 정렬: mod 90 각이 0 또는 90 근처(=경계 접힘) 여야 한다.
          expect(Math.min(ang, 90 - ang)).toBeLessThan(0.5);
          // 스팬은 슬롯 폭/깊이 중 하나.
          expect(Math.min(Math.abs(len - 2.5), Math.abs(len - 5.0))).toBeLessThan(0.06);
        }
      }
    }
  });

  it('★ 단일 격자 가정은 실데이터에서 성립하지 않는다(주차열 다중) — 설계 Loop 3-1 판정 기록', () => {
    // cam1 은 주차열 3개를 본다. preset1↔preset2 의 행 간격은 rowPitch(5.0m) 의 정수배가 아니고,
    // preset3 은 방위가 90° 뒤집혀 있다 → 하나의 균일 격자로 덮을 수 없다(격자 = 주차열 1개).
    const { cam, models } = realCams()[0];
    const centers: Record<number, { a: number; b: number }> = {};
    for (const m of models) {
      const p = cam.presets.find((q) => q.presetIdx === m.presetIdx)!;
      const fr = groundFrameOf(m, p.pan)!;
      const pts = p.quads.flatMap((q) => q.map((px) => groundCoordsOf(fr, backprojectToGround(px, m)!)));
      centers[m.presetIdx] = {
        a: pts.reduce((s, x) => s + x.a, 0) / pts.length,
        b: pts.reduce((s, x) => s + x.b, 0) / pts.length,
      };
    }
    const gapA = Math.abs(centers[1].a - centers[2].a);
    expect(gapA).toBeGreaterThan(10); // 다른 주차열.
    const k = gapA / OPTS.slotDepthM;
    expect(Math.abs(k - Math.round(k))).toBeGreaterThan(0.05); // rowPitch 정수배 아님 → 같은 격자 불가.
  });
});

describe('픽스처 봉인 (QA 결함 1 회귀 방지)', () => {
  it('★ 신규 지면격자 테스트는 런타임 정본 경로를 문자열 리터럴로 읽지 않는다', () => {
    // 이 기능의 apply 라우트가 런타임 정본 ROI 파일을 덮어쓴다. 그 파일에 골든 해시를 봉인하면
    // "기능을 한 번 쓰면 CI 가 red"(self-invalidating seal). 정적으로 봉인해 재발을 막는다.
    // 니들은 조립해서 만든다 — 이 파일 자신이 리터럴을 담으면 자기 자신을 잡는다(자기참조 회피).
    const needle = new RegExp(`['"\`]${'data/Place'}01`);
    for (const f of [
      'test/groundGrid.test.ts',
      'test/groundBootstrap.test.ts',
      'test/groundGridRoutes.test.ts',
      'test/groundAutoRoiPlan.test.ts',
    ]) {
      expect(needle.test(readFileSync(f, 'utf8')), `${f} 가 런타임 정본을 직접 읽는다`).toBe(false);
    }
  });
});

describe('골든 해시 (결정론 CI 봉인)', () => {
  it('실데이터 cam1 preset1 격자+quad 의 sha256(stringify5) 고정', () => {
    const { cam, models } = realCams()[0];
    const m = models.find((x) => x.presetIdx === 1)!;
    const p = cam.presets.find((q) => q.presetIdx === 1)!;
    const { grid } = fitGridFromQuads(p.quads, m, p.pan, OPTS);
    const payload = stringify5({ grid, quads: gridToPixelQuads(grid!, m, p.pan).quads });
    const hash = createHash('sha256').update(payload).digest('hex');
    // ※ 이 해시는 **동결 픽스처**(ROI_FILE) 내용에만 의존한다. 픽스처를 의도적으로 바꿨다면
    //    이 상수도 함께 갱신해야 한다(값이 바뀌었는데 이유를 모른다면 회귀다).
    expect(hash).toBe('3b5656b37cf57c4fd00ffa73c5d5d5ea53308c19c1eb60d0b14240f402ea0a73');
  });
});
