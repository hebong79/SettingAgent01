import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  normalizePtzCamRoi as srvNormalizePtzCamRoi,
  normalizeGlobalIdx as srvNormalizeGlobalIdx,
} from '../src/capture/placeRoi.js';
import {
  normalizePtzCamRoi as webNormalizePtzCamRoi,
  normalizeGlobalIdx as webNormalizeGlobalIdx,
} from '../web/core.js';

/**
 * 전역번호(PtzCamRoi.idx) 재부여 규칙의 **서버(TypeScript) ↔ 뷰어(web/core.js) 파리티**.
 * 두 구현이 갈라지면 Finalizer 가 DB 에 쓰는 slot_idx 와 뷰어 목록의 전역번호가 어긋나
 * 태그 오귀속/미부착이 재발한다 → 같은 raw JSON 에 대해 **동일 전역번호**임을 못 박는다.
 * 규칙: 파일 전체가 1..N 고유면 무변경(멱등), 아니면 (cam asc → preset asc → 배열순) 1..N 재부여.
 */

/** raw PtzCamRoi JSON → { "cam:preset": [idx...] }. 두 스택 각각의 정규화 경로를 통과시킨다. */
function serverIdx(raw: unknown): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [key, spaces] of srvNormalizeGlobalIdx(srvNormalizePtzCamRoi(raw).byPreset)) {
    out[key] = spaces.map((sp) => sp.idx);
  }
  return out;
}

function webIdx(raw: unknown): Record<string, number[]> {
  const { byPreset } = webNormalizePtzCamRoi(raw);
  const { placeRoi } = webNormalizeGlobalIdx(byPreset);
  const out: Record<string, number[]> = {};
  for (const [key, spaces] of Object.entries(placeRoi)) out[key] = spaces.map((sp) => sp.idx);
  return out;
}

/** 픽셀 4점(정규화 무관 — 전역번호만 검증). */
const P = [[0, 0], [10, 0], [10, 10], [0, 10]];
const file = (presets: Array<{ preset_idx: number; idxs: number[] }>, camId = 1) => ({
  cameras: [
    {
      camera: { cam_id: camId, imageWidth: 100, imageHeight: 100 },
      presets: presets.map((p) => ({
        preset_idx: p.preset_idx,
        parking_spaces: p.idxs.map((idx) => ({ idx, points: P })),
      })),
    },
  ],
});

describe('normalizeGlobalIdx 파리티 — 서버(src/capture/placeRoi.ts) ≡ 뷰어(web/core.js)', () => {
  const cases: Array<{ name: string; raw: unknown; expected: Record<string, number[]> }> = [
    {
      name: '프리셋별 0-based 중복(Unity 생성본) → cam→preset→배열순 1..N 재부여',
      raw: file([
        { preset_idx: 1, idxs: [0, 1, 2] },
        { preset_idx: 2, idxs: [0, 1] },
        { preset_idx: 3, idxs: [0] },
      ]),
      expected: { '1:1': [1, 2, 3], '1:2': [4, 5], '1:3': [6] },
    },
    {
      name: '이미 1..N 고유(순서 뒤섞임) → 무변경(멱등, 사용자 재지정 번호 보존)',
      raw: file([
        { preset_idx: 1, idxs: [6, 3] },
        { preset_idx: 2, idxs: [1, 5] },
        { preset_idx: 3, idxs: [4, 2] },
      ]),
      expected: { '1:1': [6, 3], '1:2': [1, 5], '1:3': [4, 2] },
    },
    {
      name: '누락(1,2,4) → 재부여',
      raw: file([{ preset_idx: 1, idxs: [1, 2, 4] }]),
      expected: { '1:1': [1, 2, 3] },
    },
    {
      name: '0 포함(1..N 범위 밖) → 재부여',
      raw: file([{ preset_idx: 1, idxs: [0, 2] }]),
      expected: { '1:1': [1, 2] },
    },
    {
      name: '비정수(1.5) → 재부여',
      raw: file([{ preset_idx: 1, idxs: [1.5, 2] }]),
      expected: { '1:1': [1, 2] },
    },
    {
      name: '프리셋 순서가 파일에서 뒤바뀌어도 preset asc 기준(1:1 먼저)',
      raw: file([
        { preset_idx: 2, idxs: [0, 1] },
        { preset_idx: 1, idxs: [0] },
      ]),
      expected: { '1:1': [1], '1:2': [2, 3] },
    },
    { name: '빈 파일 → {}', raw: { cameras: [] }, expected: {} },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(serverIdx(c.raw)).toEqual(c.expected);
      expect(webIdx(c.raw)).toEqual(c.expected); // 두 구현이 동일 결과여야 한다.
    });
  }

  it('동결 픽스처(Unity 원형) → 서버·뷰어 전역번호 동일 + 1..N 연속', () => {
    const raw = JSON.parse(readFileSync('test/fixtures/PtzCamRoi.unity.json', 'utf8'));
    const srv = serverIdx(raw);
    const web = webIdx(raw);
    expect(srv).toEqual(web);
    const all = Object.values(srv).flat().sort((a, b) => a - b);
    expect(all).toEqual(all.map((_, i) => i + 1)); // 1..N 순열
  });

  it('멱등: 재부여 결과를 다시 넣어도 무변경(두 구현 공통)', () => {
    const raw = file([{ preset_idx: 1, idxs: [0, 1] }, { preset_idx: 2, idxs: [0] }]);
    const once = file([{ preset_idx: 1, idxs: [1, 2] }, { preset_idx: 2, idxs: [3] }]);
    expect(serverIdx(raw)).toEqual(serverIdx(once));
    expect(webIdx(raw)).toEqual(webIdx(once));
  });
});
