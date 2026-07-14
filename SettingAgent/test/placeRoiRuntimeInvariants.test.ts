// 런타임 데이터(data/Place01/PtzCamRoi.json)에 대한 **구조 불변식만** 검증한다.
//
// 이 파일은 좌표·idx 값을 **절대 단정하지 않는다.** 그 파일은 사용자가 뷰어에서 주차면을 편집·저장하면
// 바뀌는 런타임 산출물이기 때문이다(자동보정 이동, 전역번호 재부여, 수동 재지정, camera 포즈 스냅샷).
// 값을 단정하면 **사용자가 앱을 쓰는 것만으로 테스트가 깨진다** — 실제로 그렇게 깨졌었다.
//
// 값 단정이 필요한 검증은 전부 test/fixtures/PtzCamRoi.unity.json(동결)로 옮겼다.
// 파일이 없는 환경(신규 클론)에서는 스킵한다.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { normalizePtzCamRoi, normalizeGlobalIdx } from '../src/capture/placeRoi.js';

const FILE = 'data/Place01/PtzCamRoi.json';
const exists = existsSync(FILE);

describe.skipIf(!exists)('런타임 PtzCamRoi.json — 구조 불변식(값 불단정)', () => {
  const json = exists ? JSON.parse(readFileSync(FILE, 'utf8')) : null;

  it('파싱 가능 + 카메라/프리셋/주차면 구조가 성립한다', () => {
    const { byPreset } = normalizePtzCamRoi(json);
    expect(byPreset.size).toBeGreaterThan(0);
  });

  it('모든 주차면: 4점 + 유한 좌표', () => {
    const { byPreset } = normalizePtzCamRoi(json);
    for (const spaces of byPreset.values()) {
      expect(spaces.length).toBeGreaterThan(0);
      for (const sp of spaces) {
        expect(sp.points).toHaveLength(4);
        for (const p of sp.points) {
          expect(Number.isFinite(p.x)).toBe(true);
          expect(Number.isFinite(p.y)).toBe(true);
        }
      }
    }
  });

  it('화면 밖 좌표는 **경고만** 한다(사용자가 주차면을 프레임 밖으로 끌 수 있으므로 실패시키지 않는다)', () => {
    const { byPreset, report } = normalizePtzCamRoi(json);
    const out: string[] = [];
    for (const [key, spaces] of byPreset) {
      for (const sp of spaces) {
        for (const p of sp.points) {
          if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) {
            out.push(`${key} idx${sp.idx}: (${p.x.toFixed(3)}, ${p.y.toFixed(3)})`);
          }
        }
      }
    }
    if (out.length) {
      console.warn(
        `\n[런타임 데이터 경고] 이미지 범위(0..1) 밖 좌표 ${out.length}개 — 자동보정 이동의 부작용일 수 있다:\n  ` +
          out.join('\n  '),
      );
    }
    const issues = report.flatMap((r) => r.issues);
    if (issues.length) console.warn('[런타임 데이터 검수 issue]', issues);
    expect(true).toBe(true); // 정보 제공 전용 — 런타임 데이터 상태로 CI 를 깨뜨리지 않는다.
  });

  it('전역 인덱스 정규화 후 idx 는 1..N 고유(값은 단정하지 않는다)', () => {
    const { byPreset } = normalizePtzCamRoi(json);
    const norm = normalizeGlobalIdx(byPreset);
    const all = [...norm.values()].flat().map((sp) => sp.idx);
    const n = all.length;
    expect(new Set(all).size).toBe(n); // 중복 없음.
    expect([...all].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
  });
});
