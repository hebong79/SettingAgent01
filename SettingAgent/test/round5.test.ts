// 검증자(qa-tester): 영속화 수치 소수점 최대 5자리 정규화(round5/stringify5) + 경계 왕복.
// 근거: 01_architect_plan.md §2(a) 헬퍼 · §3 검증방법, 02_developer_changes.md.
//
// 검증 대상:
//   1) round5 단위        — 반올림·뒤0제거·정수/비유한/null passthrough·경계(0.000005)·음수·불변
//   2) stringify5         — 중첩 재귀 반올림·문자열/불리언/null/정수 보존·Date→ISO·6자리+ 0건 정규식
//   3) DB 왕복 5자리       — replaceSlotSetup/upsertPresetInfo/upsertSlotCentering → getSlotSetup 값 ≤5자리
//   4) JSON 파일 라이터    — slotPtzWriter/cameraposWriter 가 stringify5 로 5자리 파일 기록(정규식 검사)
//
// 경계 규약: 영속화 경계(DB REAL 바인딩 + JSON TEXT/파일 생산지)에서만 5자리. 전송/설정은 제외(본 파일 범위 밖).

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { round5, stringify5 } from '../src/util/round.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { writeSlotPtz } from '../src/calibrate/slotPtzWriter.js';
import { writeCamerapos } from '../src/setup/cameraposWriter.js';
import type { SlotSetupRow } from '../src/capture/types.js';

/** 소수점 6자리 이상을 가진 숫자 리터럴이 문자열에 존재하는지(=5자리 초과 잔존). */
const SIX_PLUS = /\.\d{6,}/;

// ─────────────────────────────────────────────────────────────
// 1) round5 단위
// ─────────────────────────────────────────────────────────────
describe('round5 — 소수점 최대 5자리 반올림(round-half-up)', () => {
  it('롱플로트 → 5자리 반올림', () => {
    expect(round5(0.11182877131922099)).toBe(0.11183);
  });

  it('뒤 0 없음(0.5·0.10000 → 0.5·0.1)', () => {
    expect(round5(0.5)).toBe(0.5);
    expect(round5(0.10000)).toBe(0.1);
  });

  it('정수 passthrough(5·0·-3)', () => {
    expect(round5(5)).toBe(5);
    expect(round5(0)).toBe(0);
    expect(round5(-3)).toBe(-3);
  });

  it('비유한 passthrough(NaN/±Infinity)', () => {
    expect(round5(NaN)).toBeNaN();
    expect(round5(Infinity)).toBe(Infinity);
    expect(round5(-Infinity)).toBe(-Infinity);
  });

  it('비수치(null/undefined) passthrough — Number.isFinite=false 경로', () => {
    // 타입상 number 시그니처지만 런타임 nullable 경유(SqliteStore 는 x==null 가드로 호출 회피).
    expect(round5(null as unknown as number)).toBeNull();
    expect(round5(undefined as unknown as number)).toBeUndefined();
  });

  it('음수 롱플로트 → 5자리(부호 보존)', () => {
    expect(round5(-0.1118287713)).toBe(-0.11183);
  });

  it('경계: 0.000005 → 0.00001 (round-half-up, 6번째 자리 반올림)', () => {
    expect(round5(0.000005)).toBe(0.00001);
    expect(round5(0.0000049)).toBe(0);
  });

  it('경계: .5 는 +∞ 방향(Math.round 규약) — 0.123455 → 0.12346', () => {
    expect(round5(0.123455)).toBe(0.12346);
  });

  it('이미 5자리 이하는 불변', () => {
    for (const n of [0.1, 0.12, 0.123, 0.1234, 0.12345, 1.5, 828.72144]) {
      expect(round5(n)).toBe(n);
    }
  });

  it('결과에 6자리+ 소수 잔존 없음(무작위 표본)', () => {
    for (let i = 0; i < 500; i++) {
      const n = (Math.random() - 0.5) * 4000; // 좌표/각도 크기대(±2000)
      expect(String(round5(n))).not.toMatch(SIX_PLUS);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 2) stringify5
// ─────────────────────────────────────────────────────────────
describe('stringify5 — 중첩 재귀 5자리 직렬화', () => {
  it('중첩 객체/배열의 모든 숫자가 5자리 이하로 직렬화', () => {
    const input = {
      a: [{ x: 0.123456789, y: 0.987654321 }, { x: 0.5 }],
      nested: { deep: { z: 1234.5678912, arr: [0.111111111, 2, 3.1415926535] } },
    };
    const out = stringify5(input);
    expect(out).not.toMatch(SIX_PLUS);
    const parsed = JSON.parse(out);
    expect(parsed.a[0].x).toBe(0.12346);
    expect(parsed.a[0].y).toBe(0.98765);
    expect(parsed.a[1].x).toBe(0.5);
    expect(parsed.nested.deep.z).toBe(1234.56789);
    expect(parsed.nested.deep.arr).toEqual([0.11111, 2, 3.14159]);
  });

  it('문자열/불리언/null/정수 보존(반올림 안 함)', () => {
    const input = { s: 'hello 0.123456789', b: true, n: null, i: 42, neg: -7 };
    const parsed = JSON.parse(stringify5(input));
    expect(parsed).toEqual({ s: 'hello 0.123456789', b: true, n: null, i: 42, neg: -7 });
  });

  it('Date → ISO 문자열 보존(숫자 변환 안 함 — toJSON 이 replacer 전에 문자열화)', () => {
    const d = new Date(0);
    const parsed = JSON.parse(stringify5({ d }));
    expect(parsed.d).toBe(d.toISOString());
    expect(typeof parsed.d).toBe('string');
  });

  it('indent 전달 시 pretty(2-space) + 여전히 5자리', () => {
    const out = stringify5({ x: 0.123456789 }, 2);
    expect(out).toContain('\n  ');
    expect(out).not.toMatch(SIX_PLUS);
  });

  it('출력 문자열에 소수점 6자리+ 숫자 0건(정규식 스캔)', () => {
    const input = {
      quad: [{ x: 0.37534470992048313, y: 0.3900173453771547 }, { x: 0.2824970408319572, y: 0.3528782777417442 }],
      ptz: { pan: 9.999999999999995, tilt: 15, zoom: 3.722419436408399 },
    };
    expect(stringify5(input, 2)).not.toMatch(SIX_PLUS);
  });
});

// ─────────────────────────────────────────────────────────────
// 3) DB 왕복 5자리
// ─────────────────────────────────────────────────────────────
describe('DB 왕복 — replaceSlotSetup/upsert* → getSlotSetup 값 ≤5자리', () => {
  let stores: SqliteStore[] = [];
  afterEach(() => { for (const s of stores) { try { s.close(); } catch { /* noop */ } } stores = []; });
  function seeded(): SqliteStore {
    const s = new SqliteStore(':memory:');
    stores.push(s);
    s.upsertPlaceInfo([{ placeId: 1, placeName: 'P' }]);
    s.upsertCameraInfo([{
      camId: 1, camName: null, camUuid: null, url: null, userId: null, password: null, rtspUrl: null,
      camType: 'ptz', camCompany: null, placeId: 1, imgW: 1000, imgH: 1000, updatedAt: 'T',
    }]);
    return s;
  }

  it('preset_info REAL pan/tilt/zoom 이 round5 로 저장(upsertPresetInfo)', () => {
    const s = seeded();
    s.upsertPresetInfo([{ camId: 1, presetId: 1, presetName: null, placeId: 1, pan: 9.999999999999995, tilt: 15.123456789, zoom: 3.722419436408399, updatedAt: 'T' }]);
    // getSlotSetup 은 preset_info 를 직접 노출하지 않으므로 slot_setup FK 후 raw 조회로 확인.
    const raw = (s as unknown as { db: import('better-sqlite3').Database }).db
      .prepare(`SELECT pan, tilt, zoom FROM preset_info WHERE cam_id=1 AND preset_id=1`).get() as { pan: number; tilt: number; zoom: number };
    expect(raw.pan).toBe(10);
    expect(raw.tilt).toBe(15.12346);
    expect(raw.zoom).toBe(3.72242);
    expect(String(raw.pan)).not.toMatch(SIX_PLUS);
    expect(String(raw.tilt)).not.toMatch(SIX_PLUS);
    expect(String(raw.zoom)).not.toMatch(SIX_PLUS);
  });

  it('replaceSlotSetup REAL pan/tilt/zoom round5 + stringify5 생산 TEXT 왕복 ≤5자리', () => {
    const s = seeded();
    s.upsertPresetInfo([{ camId: 1, presetId: 1, presetName: null, placeId: 1, pan: 0, tilt: 0, zoom: 1, updatedAt: 'T' }]);
    // 생산지(Finalizer)가 stringify5 로 TEXT 를 만든다는 규약을 그대로 재현.
    const roiQuad = [{ x: 0.37534470992048313, y: 0.3900173453771547 }, { x: 0.2824970408319572, y: 0.3528782777417442 }];
    const front = { x: 0.6572774299064489, y: 0.4900173453771547 };
    const row: SlotSetupRow = {
      slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1,
      slotRoi: stringify5(roiQuad), vpdBbox: null, lpdObb: null,
      occupyRange: stringify5(roiQuad),
      pan: 9.999999999999995, tilt: 15, zoom: 3.722419436408399,
      centered: 1, img1: null, slot3dFrontCenter: stringify5(front), updatedAt: 'T',
    };
    s.replaceSlotSetup([row]);
    const view = s.getSlotSetup()[0];
    // REAL round5.
    expect(view.pan).toBe(10);
    expect(view.zoom).toBe(3.72242);
    // TEXT 파싱본 ≤5자리(6자리+ 0건).
    expect(JSON.stringify(view.roi)).not.toMatch(SIX_PLUS);
    expect(JSON.stringify(view.occupyRange)).not.toMatch(SIX_PLUS);
    expect(JSON.stringify(view.slot3dFrontCenter)).not.toMatch(SIX_PLUS);
    expect(view.slot3dFrontCenter).toEqual({ x: 0.65728, y: 0.49002 });
    expect(view.roi[0]).toEqual({ x: 0.37534, y: 0.39002 });
  });

  it('upsertSlotCentering REAL pan/tilt/zoom round5(부분 UPDATE)', () => {
    const s = seeded();
    s.upsertPresetInfo([{ camId: 1, presetId: 1, presetName: null, placeId: 1, pan: 0, tilt: 0, zoom: 1, updatedAt: 'T' }]);
    s.replaceSlotSetup([{
      slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1, slotRoi: '[]',
      vpdBbox: null, lpdObb: null, occupyRange: null, pan: null, tilt: null, zoom: null,
      centered: 0, img1: null, slot3dFrontCenter: null, updatedAt: 'T',
    }]);
    s.upsertSlotCentering([{ slotId: 1, pan: 9.999999999999995, tilt: 15, zoom: 3.722419436408399, centered: 1, img1: null, updatedAt: 'T2' }]);
    const view = s.getSlotSetup()[0];
    expect(view.pan).toBe(10);
    expect(view.tilt).toBe(15);
    expect(view.zoom).toBe(3.72242);
    expect(view.centered).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// 4) JSON 파일 라이터
// ─────────────────────────────────────────────────────────────
describe('JSON 파일 라이터 — stringify5 로 5자리 파일 기록', () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; } });

  it('slotPtzWriter → slot_ptz.json 에 6자리+ 소수 0건', () => {
    dir = mkdtempSync(join(tmpdir(), 'round5-slotptz-'));
    const outFile = join(dir, 'slot_ptz.json');
    // SlotPtzArtifact 최소 shape(items 에 롱플로트 PTZ/좌표 주입).
    const artifact = {
      createdAt: 'T',
      items: [{
        globalIdx: 1, slotId: '1', camIdx: 1, presetIdx: 1, presetSlotIdx: 1,
        ptz: { pan: 9.999999999999995, tilt: 15.123456789, zoom: 3.722419436408399 },
        plateWidth: 0.18599999999999997, converged: true, centered: true,
      }],
    } as unknown as Parameters<typeof writeSlotPtz>[0];
    writeSlotPtz(artifact, outFile);
    const text = readFileSync(outFile, 'utf-8');
    expect(text).not.toMatch(SIX_PLUS);
    const parsed = JSON.parse(text);
    expect(parsed.items[0].ptz.pan).toBe(10);
    expect(parsed.items[0].ptz.zoom).toBe(3.72242);
  });

  it('cameraposWriter → camerapos.json 에 6자리+ 소수 0건', () => {
    dir = mkdtempSync(join(tmpdir(), 'round5-camerapos-'));
    const path = join(dir, 'camerapos.json');
    const views = [
      { camIdx: 1, presetIdx: 1, label: 'p1', pan: 9.999999999999995, tilt: 15.123456789, zoom: 3.722419436408399 },
      { camIdx: 1, presetIdx: 2, label: 'p2', pan: 22.0000001, tilt: 6.87654321, zoom: 1.69341 },
    ] as unknown as Parameters<typeof writeCamerapos>[0];
    writeCamerapos(views, path);
    const text = readFileSync(path, 'utf-8');
    expect(text).not.toMatch(SIX_PLUS);
    const parsed = JSON.parse(text);
    expect(parsed.datas[0].datas[0].pan).toBe(10);
    expect(parsed.datas[0].datas[0].tilt).toBe(15.12346);
    expect(parsed.datas[0].datas[1].zoom).toBe(1.69341);
  });
});
