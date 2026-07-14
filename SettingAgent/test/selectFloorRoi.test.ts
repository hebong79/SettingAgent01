import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// 순수 ESM 모듈(브라우저 API 미참조) 직접 import.
import { selectFloorRoi, normalizePtzCamRoi, presetKey } from '../web/core.js';
import type { SlotLike } from '../web/core.js';

/**
 * 검증자(qa-tester): `selectFloorRoi({ useLlm, slots, placeRoi, key })` 순수 함수 유닛테스트.
 * 근거: 01_architect_plan.md #03 §3-F1 검증 기준 + 02_developer_changes.md 02-D QA 인계.
 * 반환 shape `{ source:'file'|'llm', polygons:[{ quad, label, slotId? }] }`.
 * 파일 모드/LLM 모드/방어성/모드 배타 + 경계면 교차(key 형식 = presetKey).
 */

// 동결 픽스처(Unity 원형). 런타임 파일(data/Place01)은 사용자 편집으로 면 수·좌표가 바뀌므로 값 단정 불가.
const REAL_FILE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'PtzCamRoi.unity.json');
const realByPreset = () => normalizePtzCamRoi(JSON.parse(readFileSync(REAL_FILE, 'utf8'))).byPreset;

// 리터럴 4점(참조 동일성 검증용).
const quadPts = () => [
  { x: 0.1, y: 0.1 },
  { x: 0.2, y: 0.1 },
  { x: 0.2, y: 0.2 },
  { x: 0.1, y: 0.2 },
];

describe('selectFloorRoi — 파일 모드(useLlm:false)', () => {
  it('placeRoi[key] 각 면 → { quad:points, label:String(idx) }, source:file', () => {
    const pts0 = quadPts();
    const pts1 = quadPts();
    const placeRoi = {
      '1:1': [
        { idx: 0, points: pts0 },
        { idx: 1, points: pts1 },
      ],
    };
    const out = selectFloorRoi({ useLlm: false, placeRoi, key: '1:1' });
    expect(out.source).toBe('file');
    expect(out.polygons).toHaveLength(2);
    // quad 는 원본 points 참조 그대로(복사 아님).
    expect(out.polygons[0].quad).toBe(pts0);
    expect(out.polygons[1].quad).toBe(pts1);
    // label 은 idx 의 문자열.
    expect(out.polygons[0].label).toBe('0');
    expect(out.polygons[1].label).toBe('1');
    // 파일 모드 폴리곤엔 slotId 없음.
    expect(out.polygons[0]).not.toHaveProperty('slotId');
  });

  it('동결 픽스처 normalizePtzCamRoi().byPreset → 키 1:1/1:2/1:3 폴리곤 수 7/6/4', () => {
    const placeRoi = realByPreset();
    for (const [key, expected] of [['1:1', 7], ['1:2', 6], ['1:3', 4]] as const) {
      const out = selectFloorRoi({ useLlm: false, placeRoi, key });
      expect(out.source).toBe('file');
      expect(out.polygons).toHaveLength(expected);
      // 각 폴리곤 quad=4점, label=String(idx).
      for (const poly of out.polygons) {
        expect(poly.quad).toHaveLength(4);
        expect(typeof poly.label).toBe('string');
      }
    }
  });

  it('경계면 교차: 파일 분기 key 형식이 presetKey(camIdx,presetIdx)=currentFrameKey() 와 동일', () => {
    const placeRoi = realByPreset();
    // currentFrameKey()=presetKey(cam,preset) 로 만든 키가 그대로 조회되어야 함(1-based 정합).
    for (const presetIdx of [1, 2, 3]) {
      const key = presetKey(1, presetIdx); // "1:1"/"1:2"/"1:3"
      const out = selectFloorRoi({ useLlm: false, placeRoi, key });
      expect(out.polygons.length).toBeGreaterThan(0);
    }
  });

  it('존재하지 않는 프리셋 키 → polygons:[] (source:file 유지, throw 없음)', () => {
    const placeRoi = { '1:1': [{ idx: 0, points: quadPts() }] };
    let out!: ReturnType<typeof selectFloorRoi>;
    expect(() => {
      out = selectFloorRoi({ useLlm: false, placeRoi, key: '1:2' });
    }).not.toThrow();
    expect(out.source).toBe('file');
    expect(out.polygons).toEqual([]);
  });
});

describe('selectFloorRoi — LLM 모드(useLlm:true)', () => {
  it('floorRoiByPreset[key] 보유 슬롯만 → { quad, label:"", slotId }, source:llm', () => {
    const q = quadPts();
    const slots: SlotLike[] = [
      { slotId: 's1', floorRoiByPreset: { '1:1': q } },
      { slotId: 's2' }, // floorRoiByPreset 없음 → 제외.
      { slotId: 's3', floorRoiByPreset: { '1:2': quadPts() } }, // 다른 프리셋 → 제외.
    ];
    const out = selectFloorRoi({ useLlm: true, slots, key: '1:1' });
    expect(out.source).toBe('llm');
    expect(out.polygons).toHaveLength(1);
    expect(out.polygons[0].slotId).toBe('s1');
    expect(out.polygons[0].quad).toBe(q); // 참조 동일.
    expect(out.polygons[0].label).toBe(''); // LLM 분기 label 은 빈 문자열(호출측이 렌더).
  });

  it('캡처 전(slots 빈 배열/floorRoiByPreset 미보유) → polygons:[]', () => {
    // 빈 slots.
    expect(selectFloorRoi({ useLlm: true, slots: [], key: '1:1' }).polygons).toEqual([]);
    // floorRoiByPreset 자체가 없는 슬롯들(수집 전).
    const out = selectFloorRoi({
      useLlm: true,
      slots: [{ slotId: 's1' }, { slotId: 's2' }],
      key: '1:1',
    });
    expect(out.source).toBe('llm');
    expect(out.polygons).toEqual([]);
  });
});

describe('selectFloorRoi — 방어성(throw 없음)', () => {
  it('placeRoi:null (파일 모드) → polygons:[]', () => {
    let out!: ReturnType<typeof selectFloorRoi>;
    expect(() => {
      out = selectFloorRoi({ useLlm: false, placeRoi: null, key: '1:1' });
    }).not.toThrow();
    expect(out).toEqual({ source: 'file', polygons: [] });
  });

  it('placeRoi 미지정 (파일 모드) → polygons:[]', () => {
    expect(selectFloorRoi({ useLlm: false, key: '1:1' })).toEqual({ source: 'file', polygons: [] });
  });

  it('slots:undefined (LLM 모드) → polygons:[]', () => {
    let out!: ReturnType<typeof selectFloorRoi>;
    expect(() => {
      out = selectFloorRoi({ useLlm: true, slots: undefined, key: '1:1' });
    }).not.toThrow();
    expect(out).toEqual({ source: 'llm', polygons: [] });
  });
});

describe('selectFloorRoi — 모드 배타(같은 입력에 useLlm 토글 시 소스·폴리곤 전환)', () => {
  it('동일 입력 → useLlm false=파일 분기, true=LLM 분기로 전환', () => {
    const filePts = quadPts();
    const llmQ = quadPts();
    const args = {
      placeRoi: { '1:1': [{ idx: 0, points: filePts }] },
      slots: [{ slotId: 's1', floorRoiByPreset: { '1:1': llmQ } }],
      key: '1:1',
    };
    const fileOut = selectFloorRoi({ ...args, useLlm: false });
    const llmOut = selectFloorRoi({ ...args, useLlm: true });

    // 파일 분기: source=file, 파일 points 사용, slotId 없음.
    expect(fileOut.source).toBe('file');
    expect(fileOut.polygons[0].quad).toBe(filePts);
    expect(fileOut.polygons[0]).not.toHaveProperty('slotId');

    // LLM 분기: source=llm, 슬롯 quad 사용, slotId 존재.
    expect(llmOut.source).toBe('llm');
    expect(llmOut.polygons[0].quad).toBe(llmQ);
    expect(llmOut.polygons[0].slotId).toBe('s1');

    // 배타: 두 분기가 서로 다른 소스·데이터로 명확히 분기.
    expect(fileOut.source).not.toBe(llmOut.source);
  });
});
