// 검증자(qa-tester): "3D육면체 ROI생성" — 산출식 승격 + 부분 UPDATE 저장 + PTZ 소스 우선순위.
// 근거: _workspace/05_architect_plan_cuboid.md §검증(qa) 1·2·4 + 06_developer_changes_cuboid.md.
//
// 검증 대상:
//   1) SqliteStore.upsertSlotFrontCenter — 지정 slot_id 만 갱신, 타 컬럼 무변경, 미존재 무시,
//      반환 행수 정확, 전량 DELETE 없음(행 수·타 슬롯 보존).
//   2) src/ground/slotFrontCenter.ts 승격 파리티 — Finalizer 가 import 로만 쓰고(이중구현 없음),
//      승격 함수 결과 == project.ts 프리미티브 직접 조합 결과(1e-12).
//   3) buildGroundInputs PTZ 소스 우선순위 — ROI 프리셋 ptz{} / 평면 pan·tilt·zoom > camerapos 뷰,
//      ROI 없으면 camerapos 폴백, 둘 다 없으면 null.
//
// 임시 파일은 os.tmpdir() 아래에만 생성한다(실 data/setting.sqlite 미접촉 — 전부 :memory: 또는 tmpdir).

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

import { SqliteStore } from '../src/capture/SqliteStore.js';
import { H_CONST, slotFrontCenter } from '../src/ground/slotFrontCenter.js';
import { backprojectToGround, projectCuboidPixels, frontFaceCenterPx } from '../src/ground/project.js';
import { buildGroundInputs } from '../src/ground/groundInputs.js';
import type { GroundModel } from '../src/ground/types.js';
import type { Vec3 } from '../src/ground/contactTypes.js';
import type { NormalizedPoint } from '../src/domain/types.js';
import type { CameraView } from '../src/setup/mapTargets.js';
import type { CameraInfoRow, PlaceInfoRow, PresetPosRow, SlotSetupRow } from '../src/capture/types.js';

let store: SqliteStore | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
});

// ── 픽스처 ──────────────────────────────────────────────────
const placeRow = (): PlaceInfoRow => ({ placeId: 1, placeName: 'Place01' });
const cameraRow = (): CameraInfoRow => ({
  camId: 1, camName: null, camUuid: null, url: null, userId: null, password: null, rtspUrl: null,
  camType: 'ptz', camCompany: null, placeId: 1, imgW: 1920, imgH: 1080, updatedAt: 'T',
});
const presetRow = (presetId: number): PresetPosRow => ({
  camId: 1, presetId, sname: `Preset ${presetId}`, pan: 10, tilt: 5, zoom: 2, updatedAt: 'T',
});

const roi: NormalizedPoint[] = [
  { x: 0.2, y: 0.2 }, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.5 }, { x: 0.2, y: 0.5 },
];

/** 검출·센터링 컬럼이 **전부 채워진** 슬롯(파괴 여부를 관측할 수 있게). */
const richSlot = (over: Partial<SlotSetupRow> = {}): SlotSetupRow => ({
  slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1,
  slotRoi: JSON.stringify(roi),
  vpdBbox: JSON.stringify({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }),
  lpdObb: JSON.stringify([{ x: 0.3, y: 0.3 }, { x: 0.35, y: 0.3 }, { x: 0.35, y: 0.35 }, { x: 0.3, y: 0.35 }]),
  occupyRange: JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.1 }, { x: 0.4, y: 0.4 }, { x: 0.1, y: 0.4 }]),
  pan: 11.5, tilt: -6.25, zoom: 2.5, centered: 1, img1: 'slot1.jpg',
  slot3dFrontCenter: null, updatedAt: 'T', ...over,
});

function seededStore(presetIds: number[] = [1]): SqliteStore {
  const s = new SqliteStore(':memory:');
  s.upsertPlaceInfo([placeRow()]);
  s.upsertCameraInfo([cameraRow()]);
  s.upsertPresetPos(presetIds.map(presetRow));
  return s;
}

/** slot_setup 원시 행(모든 컬럼) 스냅샷 — 부분 UPDATE 무접촉 검증용. */
function rawRows(s: SqliteStore): Array<Record<string, unknown>> {
  return (s as unknown as { db: Database.Database }).db
    .prepare(`SELECT * FROM slot_setup ORDER BY slot_id`)
    .all() as Array<Record<string, unknown>>;
}

// ─────────────────────────────────────────────────────────────
// 1) upsertSlotFrontCenter — 부분 UPDATE 계약
// ─────────────────────────────────────────────────────────────
describe('SqliteStore.upsertSlotFrontCenter — 부분 UPDATE(설계 §B)', () => {
  it('지정 slot_id 만 갱신 / 다른 컬럼(roi·vpd·lpd·occupy·pan·tilt·zoom·centered·img1) 무변경', () => {
    store = seededStore([1, 2]);
    store.replaceSlotSetup([
      richSlot({ slotId: 1, presetId: 1, presetSlotIdx: 1 }),
      richSlot({ slotId: 2, presetId: 2, presetSlotIdx: 1 }),
    ]);
    const before = rawRows(store);

    const n = store.upsertSlotFrontCenter([
      { slotId: 1, slot3dFrontCenter: JSON.stringify({ x: 0.5, y: 0.6 }), updatedAt: 'T2' },
    ]);
    expect(n).toBe(1);

    const after = rawRows(store);
    expect(after).toHaveLength(2);
    // slot 1: slot3d_front_center + updated_at 만 변했고 나머지는 문자 단위 동일.
    for (const col of Object.keys(before[0])) {
      if (col === 'slot3d_front_center' || col === 'updated_at') continue;
      expect({ col, v: after[0][col] }).toEqual({ col, v: before[0][col] });
    }
    expect(after[0].slot3d_front_center).toBe(JSON.stringify({ x: 0.5, y: 0.6 }));
    expect(after[0].updated_at).toBe('T2');
    // slot 2: 전 컬럼 무변경(updated_at 포함).
    expect(after[1]).toEqual(before[1]);
  });

  it('미존재 slot_id 는 조용히 무시(throw 없음) / 반환 행수 = 실제 갱신 행수', () => {
    store = seededStore([1]);
    store.replaceSlotSetup([richSlot({ slotId: 1 })]);

    const n = store.upsertSlotFrontCenter([
      { slotId: 1, slot3dFrontCenter: JSON.stringify({ x: 0.1, y: 0.2 }), updatedAt: 'T2' },
      { slotId: 999, slot3dFrontCenter: JSON.stringify({ x: 0.9, y: 0.9 }), updatedAt: 'T2' },
      { slotId: 1000, slot3dFrontCenter: null, updatedAt: 'T2' },
    ]);
    expect(n).toBe(1); // 999·1000 은 미반영.
    expect(rawRows(store)).toHaveLength(1);
    expect(store.getSlotSetup()[0].slot3dFrontCenter).toEqual({ x: 0.1, y: 0.2 });
  });

  it('빈 배열 → 0건, 행 수 불변 (전량 DELETE 없음)', () => {
    store = seededStore([1, 2]);
    store.replaceSlotSetup([
      richSlot({ slotId: 1, presetId: 1 }),
      richSlot({ slotId: 2, presetId: 2 }),
    ]);
    expect(store.upsertSlotFrontCenter([])).toBe(0);
    expect(rawRows(store)).toHaveLength(2);
  });

  it('null 로 명시 갱신 가능(지우기) + getSlotSetup 왕복 파싱', () => {
    store = seededStore([1]);
    store.replaceSlotSetup([richSlot({ slotId: 1, slot3dFrontCenter: JSON.stringify({ x: 0.4, y: 0.4 }) })]);
    expect(store.getSlotSetup()[0].slot3dFrontCenter).toEqual({ x: 0.4, y: 0.4 });
    expect(store.upsertSlotFrontCenter([{ slotId: 1, slot3dFrontCenter: null, updatedAt: 'T3' }])).toBe(1);
    expect(store.getSlotSetup()[0].slot3dFrontCenter).toBeNull();
  });

  it('구현이 DELETE/REPLACE 를 쓰지 않는다(소스 계약 — memory: finalize wipe 취약성)', () => {
    const src = readFileSync('src/capture/SqliteStore.ts', 'utf8');
    const body = src.slice(src.indexOf('upsertSlotFrontCenter('), src.indexOf('clearSlotSetupEnrichment('));
    expect(body).toContain('UPDATE slot_setup SET slot3d_front_center');
    expect(body).not.toMatch(/DELETE\s+FROM/i);
    expect(body).not.toMatch(/REPLACE\s+INTO/i);
  });
});

// ─────────────────────────────────────────────────────────────
// 2) 승격 파리티 — 이중구현 없음 + 수치 동일
// ─────────────────────────────────────────────────────────────
const DEG = Math.PI / 180;
function makeGround(tiltDeg: number, imgW = 1000, imgH = 1000, f = 900): GroundModel {
  const t = tiltDeg * DEG;
  return {
    camIdx: 1, presetIdx: 1, imgW, imgH, zoom: 1, f,
    n: [0, Math.cos(t), Math.sin(t)], d: 5.0, tiltDeg, ptzTiltDeg: null, tiltErrDeg: null,
    slotBearingDeg: null, bearingDevDeg: null, dDevRel: null, depthEdgePx: 400,
    metricErr: 0, conf: 1, source: 'file', issues: [],
  };
}
const FLOOR_QUAD: NormalizedPoint[] = [
  { x: 0.40, y: 0.72 }, { x: 0.42, y: 0.60 }, { x: 0.58, y: 0.60 }, { x: 0.60, y: 0.72 },
];

describe('src/ground/slotFrontCenter.ts 승격(설계 §A)', () => {
  it('Finalizer 는 import 만 하고 자체 정의를 갖지 않는다(이중구현 금지)', () => {
    const fin = readFileSync('src/capture/Finalizer.ts', 'utf8');
    expect(fin).toContain(`from '../ground/slotFrontCenter.js'`);
    expect(fin).not.toMatch(/function\s+slotFrontCenter\s*\(/);
    expect(fin).not.toMatch(/const\s+H_CONST\s*=/);
  });

  it('H_CONST = 1.5 (뷰어 슬라이더 기본값과 동일)', () => {
    expect(H_CONST).toBe(1.5);
  });

  it.each([
    { tiltDeg: 8, h: 1.5 },
    { tiltDeg: 15, h: H_CONST },
    { tiltDeg: 22, h: 2.4 },
    { tiltDeg: 15, h: 0.0 },
  ])('tilt=$tiltDeg h=$h — 승격 함수 == project.ts 프리미티브 직접 조합(1e-12)', ({ tiltDeg, h }) => {
    const g = makeGround(tiltDeg);
    const got = slotFrontCenter(FLOOR_QUAD, g, h);
    expect(got).not.toBeNull();

    const floorGround: Vec3[] = FLOOR_QUAD.map(
      (p) => backprojectToGround({ x: p.x * g.imgW, y: p.y * g.imgH }, g)!,
    );
    const corners = projectCuboidPixels(floorGround, h, g)!;
    const c = frontFaceCenterPx(corners)!;
    expect(got!.x).toBeCloseTo(c.x / g.imgW, 12);
    expect(got!.y).toBeCloseTo(c.y / g.imgH, 12);
    // 정규화 규약(0~1) — 픽셀 누수 금지.
    expect(got!.x).toBeGreaterThanOrEqual(0);
    expect(got!.y).toBeLessThanOrEqual(1);
  });

  it('점 4개 아님 → null / 지평선 위(퇴화) → null (강등, throw 금지)', () => {
    const g = makeGround(15);
    expect(slotFrontCenter(FLOOR_QUAD.slice(0, 3), g, 1.5)).toBeNull();
    expect(slotFrontCenter([], g, 1.5)).toBeNull();
    // 지평선 위(화면 상단) quad → backprojectToGround 실패 → null.
    const above: NormalizedPoint[] = [
      { x: 0.4, y: 0.02 }, { x: 0.42, y: 0.01 }, { x: 0.58, y: 0.01 }, { x: 0.6, y: 0.02 },
    ];
    expect(slotFrontCenter(above, makeGround(2), 1.5)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// 3) buildGroundInputs — PTZ 소스 우선순위(리더 변경분)
// ─────────────────────────────────────────────────────────────
/** cam1 preset1 하나만 가진 최소 ROI JSON. presetExtra 로 프리셋 PTZ 표현을 주입한다. */
function roiJson(presetExtra: Record<string, unknown>): unknown {
  return {
    cameras: [
      {
        camera: { cam_id: 1, imageWidth: 1000, imageHeight: 1000 },
        presets: [
          {
            preset_idx: 1,
            ...presetExtra,
            parking_spaces: [
              { idx: 1, points: [[400, 720], [420, 600], [580, 600], [600, 720]] },
            ],
          },
        ],
      },
    ],
  };
}
const camView = (over: Partial<CameraView> = {}): CameraView[] => [
  { camIdx: 1, presetIdx: 1, label: 'Preset 1', pan: 100, tilt: 200, zoom: 300, ...over },
];

describe('buildGroundInputs — PTZ 소스 우선순위: ROI 프리셋 > camerapos', () => {
  it('중첩 ptz{} 형태가 camerapos 뷰보다 우선', () => {
    const out = buildGroundInputs(roiJson({ ptz: { pan: 1, tilt: 2, zoom: 3 } }), camView());
    expect(out).toHaveLength(1);
    expect(out[0].presets[0]).toMatchObject({ camIdx: 1, presetIdx: 1, pan: 1, tilt: 2, zoom: 3 });
    expect(out[0].presets[0].quads).toHaveLength(1);
  });

  it('평면(pan/tilt/zoom 직접) 형태도 camerapos 뷰보다 우선', () => {
    const out = buildGroundInputs(roiJson({ pan: 11, tilt: 22, zoom: 33 }), camView());
    expect(out[0].presets[0]).toMatchObject({ pan: 11, tilt: 22, zoom: 33 });
  });

  it('ROI 에 PTZ 없음 → camerapos 폴백', () => {
    const out = buildGroundInputs(roiJson({}), camView());
    expect(out[0].presets[0]).toMatchObject({ pan: 100, tilt: 200, zoom: 300 });
  });

  it('필드 단위 폴백(부분만 ROI 보유) — zoom 만 ROI, pan/tilt 는 camerapos', () => {
    const out = buildGroundInputs(roiJson({ ptz: { zoom: 3 } }), camView());
    expect(out[0].presets[0]).toMatchObject({ zoom: 3, pan: 100, tilt: 200 });
  });

  it('둘 다 없음 → null (undefined 가 아니라 명시적 null)', () => {
    const out = buildGroundInputs(roiJson({}), []);
    expect(out[0].presets[0]).toMatchObject({ pan: null, tilt: null, zoom: null });
  });

  it('비수치(문자열) PTZ 는 무시하고 camerapos 로 폴백', () => {
    const out = buildGroundInputs(roiJson({ ptz: { pan: 'x', tilt: null, zoom: NaN } }), camView());
    expect(out[0].presets[0]).toMatchObject({ pan: 100, tilt: 200, zoom: 300 });
  });

  it('동결 픽스처(PtzCamRoi.unity.json, 프리셋 PTZ 없음) → camerapos 값 그대로(회귀)', () => {
    const raw = JSON.parse(readFileSync('test/fixtures/PtzCamRoi.unity.json', 'utf8'));
    const views: CameraView[] = [
      { camIdx: 1, presetIdx: 1, label: 'P1', pan: 5, tilt: -10, zoom: 1.25 },
    ];
    const out = buildGroundInputs(raw, views);
    const p1 = out[0].presets.find((p) => p.presetIdx === 1)!;
    expect(p1).toMatchObject({ pan: 5, tilt: -10, zoom: 1.25 });
  });
});
