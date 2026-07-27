// data/lens_calibration.json 쓰기 — 읽기(loadLensCorrector)의 대칭 쪽.
//
// ★ 이 파일의 유일한 책임은 **한 카메라 항목만 건드리는 것**이다. 다른 카메라의 항목·주석·미지 필드는
//   전부 보존한다(DELETE+INSERT 식 전량 재작성 금지 — 검출 데이터 wipe 사고와 같은 부류의 취약점).
//
// ★ 새로 실측한 표는 **항상 enabled:false 로 들어간다**(설계서 20260725 §10 opt-in 원칙).
//   사람이 검증 리포트를 보고 apply 를 눌러야 조준에 걸린다. 자동 활성화하면 검증되지 않은 표가
//   조용히 실운영 조준을 바꾼다.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CalibrationSpec } from '@parkagent/lens-calib';
import { stringify5 } from '../util/round.js';

/** 파일 내 카메라 항목. loadLensCorrector 가 읽는 스키마와 동일(설계서 §8). */
export interface LensCalibEntry extends CalibrationSpec {
  id?: string;
  camIdx?: number;
  host?: string;
  enabled?: boolean;
  /** 실측 시각(감사용). */
  measuredAt?: string;
}

export interface LensCalibFile {
  _comment?: string;
  cameras?: LensCalibEntry[];
  [k: string]: unknown;
}

/** 파일을 읽는다. 없거나 깨졌으면 빈 구조(읽기 실패로 쓰기를 막지 않는다 — 신규 생성 경로). */
export function readLensCalibFile(filePath: string): LensCalibFile {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as LensCalibFile;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeFile(filePath: string, file: LensCalibFile): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${stringify5(file, 2)}\n`, 'utf8');
}

/**
 * 실측 표를 해당 카메라 항목에 병합한다. **enabled 는 false 로 강등**된다.
 *
 * 기존 항목의 다른 필드(host·camIdx·주석성 필드)는 유지하고, 이번에 잰 축만 덮어쓴다 —
 * 게인 스윕이 곡면율 표를 지우거나 그 반대가 되면 안 된다.
 */
export function upsertLensCalibration(
  filePath: string,
  sourceId: string,
  spec: Partial<CalibrationSpec> & { host?: string; measuredAt?: string },
): LensCalibEntry {
  const file = readLensCalibFile(filePath);
  const cameras = Array.isArray(file.cameras) ? [...file.cameras] : [];
  const idx = cameras.findIndex((c) => c.id === sourceId);
  const prev = idx >= 0 ? cameras[idx]! : { id: sourceId };

  const next: LensCalibEntry = {
    ...prev,
    id: sourceId,
    ...(spec.host ? { host: spec.host } : {}),
    ...(spec.zoomHfov ? { zoomHfov: spec.zoomHfov } : {}),
    ...(spec.centeringGain ? { centeringGain: spec.centeringGain } : {}),
    ...(spec.lensDistortion ? { lensDistortion: spec.lensDistortion } : {}),
    ...(spec.measuredAt ? { measuredAt: spec.measuredAt } : {}),
    // ★ 실측 직후는 언제나 비활성. apply 로만 켠다.
    enabled: false,
  };
  // 실측 표가 들어오면 프리셋 상속(model)은 더 이상 정본이 아니다 — 두 출처가 겹치면 어느 쪽이
  // 적용됐는지 사람이 알 수 없다. 이번에 잰 축이 프리셋을 대체하므로 model 을 떨어뜨린다.
  if (spec.zoomHfov || spec.centeringGain) delete next.model;

  if (idx >= 0) cameras[idx] = next;
  else cameras.push(next);
  writeFile(filePath, { ...file, cameras });
  return next;
}

/**
 * 활성/비활성 전환. 표가 없는 카메라는 켤 수 없다(항등 보정이 되어 "켰는데 아무 일도 안 남" 이 된다).
 * @returns 적용된 항목. 대상 항목이 없으면 null.
 */
export function setLensCalibEnabled(filePath: string, sourceId: string, enabled: boolean): LensCalibEntry | null {
  const file = readLensCalibFile(filePath);
  const cameras = Array.isArray(file.cameras) ? [...file.cameras] : [];
  const idx = cameras.findIndex((c) => c.id === sourceId);
  if (idx < 0) return null;
  const entry = cameras[idx]!;
  if (enabled && !entry.model && !entry.zoomHfov && !entry.centeringGain && !entry.lensDistortion) return null;
  const next = { ...entry, enabled };
  cameras[idx] = next;
  writeFile(filePath, { ...file, cameras });
  return next;
}
