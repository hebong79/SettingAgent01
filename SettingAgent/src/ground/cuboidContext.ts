// 육면체 문맥(지면모델 + 슬롯 폴리곤) 해결자 — **단일 구현**.
//
// ★ 이 코드는 원래 `/capture/ground-model` 과 `/capture/vehicle-cuboids` 에 **두 번** 있었고, 이제
//   `/capture/detect` 와 `CaptureJob` 에도 필요하다 → **4중복**이 될 뻔했다(이중구현 금지 규약).
//   `CaptureJob` 은 `index.ts` 에서 조립되고 라우트는 `captureRoutes.ts` 에서 조립되므로, 헬퍼가
//   라우트 파일 안에 있으면 두 조립 지점이 같은 코드를 각자 갖게 된다 → **모듈로 뽑아 팩토리로 공유**한다.
//
// throw 0 — 파일 없음/파싱 실패/추정 실패는 전부 **null**(호출측이 육면체 없이 강등). 잡·검출을 죽이지 않는다.

import { readFile } from 'node:fs/promises';
import { buildGroundInputs } from './groundInputs.js';
import { estimateGroundModels } from './groundModel.js';
import { loadNormalizedPlaceRoi } from '../capture/placeRoi.js';
import { parseCameraViews, type CameraView } from '../setup/mapTargets.js';
import type { CuboidContext } from './frameCuboids.js';
import type { GroundModel, GroundOptions } from './types.js';

export interface CuboidContextSources {
  /** 주차면 폴리곤 + 지면모델 입력(PtzCamRoi.json). 미설정 → 육면체 전 기능 off. */
  placeRoiFile?: string;
  /** 프리셋 zoom 리드백(camerapos.json). 없으면 zoom 미상 강등(모델 issues 에 기록). */
  cameraposFile?: string;
  /** `enabled=false` → 육면체 전 기능 off(**기존 킬스위치 재사용 — 신규 설정 플래그 0**). */
  ground?: GroundOptions & { enabled: boolean; slotWidthM: number; slotDepthM: number };
}

/** (cam, preset) → 육면체 문맥. 미설정/추정 실패 → null. 저빈도 호출(프리셋당 라운드 1회) — 캐시 불요. */
export type CuboidContextResolver = (camIdx: number, presetIdx: number) => Promise<CuboidContext | null>;

export function makeCuboidContextResolver(src: CuboidContextSources): CuboidContextResolver {
  return async (cam, preset) => {
    if (!src.placeRoiFile || !src.ground?.enabled) return null;
    const ground = src.ground;
    try {
      const raw = JSON.parse(await readFile(src.placeRoiFile, 'utf8'));
      let views: CameraView[] = [];
      if (src.cameraposFile) {
        try {
          views = parseCameraViews(JSON.parse(await readFile(src.cameraposFile, 'utf8')));
        } catch {
          /* camerapos 없음/파싱실패 → zoom 미상 강등(모델 issues 에 기록됨) */
        }
      }
      let model: GroundModel | undefined;
      for (const camInput of buildGroundInputs(raw, views)) {
        if (camInput.camIdx !== cam) continue;
        model = estimateGroundModels(camInput, ground).models.find((m) => m.presetIdx === preset);
      }
      if (!model) return null; // 그 프리셋 지면모델 추정 실패 → 육면체 미산출(사유는 호출측 issues).

      // 슬롯 폴리곤(정규화) → **원본 픽셀**. 지면모델은 원본 픽셀에서만 성립한다(groundModel §1-2).
      const place = await loadNormalizedPlaceRoi(src.placeRoiFile);
      const polysNorm = place?.byPreset.get(`${cam}:${preset}`)?.map((s) => s.points) ?? [];
      const m = model;
      return {
        model: m,
        slotPolysPx: polysNorm.map((pts) => pts.map((p) => ({ x: p.x * m.imgW, y: p.y * m.imgH }))),
        slotWidthM: ground.slotWidthM,
        slotDepthM: ground.slotDepthM,
      };
    } catch {
      return null;
    }
  };
}
