// 슬롯별 3D 육면체 앞면 중심(slot3d_front_center) 산출·저장 — **단일 구현**(설계서 §5 W6).
//
// ★ 이 파일은 `POST /capture/slots/cuboid` 라우트 본문(구 captureRoutes.ts:488~524)을 **그대로 옮긴 것**이다.
//   산출식(buildGroundInputs → estimateGroundModels → slotFrontCenter → upsertSlotFrontCenter)은 한 줄도
//   새로 쓰지 않았다. 호출자가 둘(수동 `3D육면체 ROI생성` 버튼 · ROI 파일 로딩 자동 경로)이 되어
//   라우트 본문에 둘 수 없게 되었을 뿐이다.
//
// 부작용 경계: `upsertSlotFrontCenter`(slot3d_front_center 단일 컬럼 UPDATE) 만 호출한다 —
//   lpd/occupy_range/vpd/pan/tilt/zoom/centered 는 접촉하지 않는다.

import { readFile } from 'node:fs/promises';
import type { SqliteStore } from '../capture/SqliteStore.js';
import type { ToolsConfig } from '../config/toolsConfig.js';
import { parseCameraViews } from '../setup/mapTargets.js';
import { stringify5 } from '../util/round.js';
import { buildGroundInputs } from './groundInputs.js';
import { estimateGroundModels } from './groundModel.js';
import { H_CONST, slotFrontCenter } from './slotFrontCenter.js';
import type { GroundModel } from './types.js';

export interface FrontCenterBuildOpts {
  /** 주차면 폴리곤 정본(Place01/PtzCamRoi.json). 읽기 실패는 throw(호출자가 404/500·강등 결정). */
  placeRoiFile: string;
  /** zoom 소스(camerapos.json). 없음/파싱실패 → zoom 미상 강등(ground-model 라우트와 동일 처리). */
  cameraposFile?: string;
  ground: ToolsConfig['ground'];
  /** 육면체 높이(m). 미지정 시 H_CONST(=1.5) — 자동(ROI 로딩) 경로 기본값. */
  heightM?: number;
  now?: () => string;
}

export interface FrontCenterBuildResult {
  updated: number;
  skipped: Array<{ slotId: number; reason: string }>;
  models: Array<{ key: string; conf: number; issues: string[] }>;
  issues: string[];
  heightM: number;
}

/**
 * 지면모델 → 슬롯별 앞면 중심 산출·저장. 모델 없음/퇴화 슬롯은 skipped[] 로 드러내고 **저장하지 않는다**
 * (기존 값 미파괴 — null 로 지우지 않음, 위장 저장 금지).
 * ROI 파일 읽기·파싱 실패는 throw — 호출자가 처리한다(라우트=404/500, 자동 경로=issues 강등).
 */
export async function buildSlotFrontCenters(
  store: Pick<SqliteStore, 'getSlotSetup' | 'upsertSlotFrontCenter'>,
  opts: FrontCenterBuildOpts,
): Promise<FrontCenterBuildResult> {
  const heightM = opts.heightM ?? H_CONST;
  const views = store.getSlotSetup();
  // 프리셋별 지면모델(ground-model 라우트·Finalizer.buildGroundModels 와 동일 조합 — 새 조합 금지).
  const modelByKey = new Map<string, GroundModel>();
  const issues: string[] = [];
  const raw = JSON.parse(await readFile(opts.placeRoiFile, 'utf8'));
  let camViews: ReturnType<typeof parseCameraViews> = [];
  if (opts.cameraposFile) {
    try {
      camViews = parseCameraViews(JSON.parse(await readFile(opts.cameraposFile, 'utf8')));
    } catch {
      /* camerapos 없음/파싱실패 → zoom 미상 강등(ground-model 라우트와 동일 처리). */
    }
  }
  for (const cam of buildGroundInputs(raw, camViews)) {
    const r = estimateGroundModels(cam, opts.ground);
    for (const m of r.models) modelByKey.set(`${m.camIdx}:${m.presetIdx}`, m);
    issues.push(...r.issues);
  }
  const now = (opts.now ?? (() => new Date().toISOString()))();
  const rows: Array<{ slotId: number; slot3dFrontCenter: string; updatedAt: string }> = [];
  const skipped: Array<{ slotId: number; reason: string }> = [];
  for (const v of views) {
    const model = modelByKey.get(`${v.camId}:${v.presetId}`);
    if (!model) {
      skipped.push({ slotId: v.slotId, reason: `지면모델 없음(${v.camId}:${v.presetId})` });
      continue;
    }
    const front = slotFrontCenter(v.roi, model, heightM);
    if (!front) {
      skipped.push({ slotId: v.slotId, reason: '육면체 퇴화(지평선 위/quad 이상)' });
      continue;
    }
    rows.push({ slotId: v.slotId, slot3dFrontCenter: stringify5(front), updatedAt: now });
  }
  const updated = rows.length > 0 ? store.upsertSlotFrontCenter(rows) : 0;
  return {
    updated,
    skipped,
    models: [...modelByKey.entries()].map(([key, m]) => ({ key, conf: m.conf, issues: m.issues })),
    issues,
    heightM,
  };
}
