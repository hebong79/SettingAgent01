import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { CaptureJob } from '../src/capture/CaptureJob.js';
import { Finalizer } from '../src/capture/Finalizer.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import { assignPlatesToSlotViews } from '../src/setup/plateMatch.js';
import { lowerFrontAnchor } from '../src/calibrate/plateDiscoveryWriter.js';
import { rectToQuad } from '../src/domain/geometry.js';
import { stringify5 } from '../src/util/round.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { PlateBox } from '../src/clients/LpdClient.js';
import type { CapturedImage } from '../src/domain/types.js';
import type { NormalizedPoint, NormalizedQuad } from '../src/domain/types.js';
import type { Repository } from '../src/store/Repository.js';
import type {
  SlotSetupView,
  CameraInfoRow,
  PlaceInfoRow,
  PresetPosRow,
  SlotSetupRow,
} from '../src/capture/types.js';
import type { SetupArtifact } from '../src/domain/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

/**
 * 검증자(qa-tester): LPD 검지 패널 "DB에 추가"(라이브 LPD 박스 → slot_setup.lpd) — **v2 배정**.
 * v2: `assignPlatesToSlotViews` 가 bbox 중심 포함판정 → **nearest 하향앵커(lowerFrontAnchor) 전역 1:1 그리디
 *     + MATCH_RADIUS=0.15 게이트**로 교체(라이브 한 칸 밀림 수정). `slot3dFrontCenter==null` 슬롯 스킵.
 * 대상: `assignPlatesToSlotViews`(plateMatch.ts) + `POST /capture/slots/lpd`(captureRoutes.ts).
 * 신규 파일 1개로 격리(기존 plateMatch/captureRoutes/sqliteStore 테스트 무편집 → 회귀 0 보장).
 *
 * 경계면 교차 비교: 라우트가 store.upsertSlotLpd 로 넘기는 rows(lpdObb=stringify5(quad))와
 *   실 slot_setup 저장/재조회(getSlotSetup.lpd) 정합을 실메모리 DB 왕복으로 실증한다.
 * ★ 앵커는 discovery(plateDiscoveryWriter.lowerFrontAnchor)와 **동일 함수**를 import 해 산출 —
 *   테스트가 상수를 재현하지 않고 구현과 같은 소스로 앵커를 잡는다(정의 갈림 방지).
 */

// ── 픽스처 헬퍼 ─────────────────────────────────────────────

/** 축정렬 직사각형 폴리곤(4점, NormalizedPoint[]). slot_roi 표준(코너 TL→TR→BR→BL). */
const rectPoly = (x: number, y: number, w: number, h: number): NormalizedPoint[] => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

/** SlotSetupView 팩토리. v2 배정은 slot3dFrontCenter(앵커 소스)를 읽으므로 over 로 반드시 부여. */
const slotView = (slotId: number, roi: NormalizedPoint[], over: Partial<SlotSetupView> = {}): SlotSetupView => ({
  slotId, camId: 1, presetId: 1, presetSlotIdx: slotId, presetKey: '1:1',
  roi, vpd: null, lpd: null, occupyRange: null, pan: null, tilt: null, zoom: null,
  centered: false, img1: null, slot3dFrontCenter: null, updatedAt: null, ...over,
});

/** 중심이 (cx,cy) 인 작은 축정렬 plate(quadBoundingRect center == (cx,cy)). */
const plateAtCenter = (cx: number, cy: number, confidence = 0.9, w = 0.02, h = 0.01): PlateBox => ({
  quad: rectToQuad({ x: cx - w / 2, y: cy - h / 2, w, h }),
  confidence,
  cls: 'car_license_plate',
});

/** 슬롯뷰의 v2 앵커(구현과 동일 함수). */
const anchorOf = (s: SlotSetupView) => lowerFrontAnchor(s.roi, s.slot3dFrontCenter!);

/**
 * 주차 한 줄(row) 3슬롯: 앵커가 x=0.175/0.375/0.575, y≈0.42333 로 등간격(0.2). MATCH_RADIUS(0.15)<간격 → 격리.
 * roi 하단중심(B)과 slot3dFrontCenter.x 를 같게 둬 앵커.x = 하단중심.x (계산 단순).
 */
const rowSlots = (): SlotSetupView[] => [
  slotView(1, rectPoly(0.10, 0.30, 0.15, 0.15), { slot3dFrontCenter: { x: 0.175, y: 0.40 } }),
  slotView(2, rectPoly(0.30, 0.30, 0.15, 0.15), { slot3dFrontCenter: { x: 0.375, y: 0.40 } }),
  slotView(3, rectPoly(0.50, 0.30, 0.15, 0.15), { slot3dFrontCenter: { x: 0.575, y: 0.40 } }),
];

// ════════════════════════════════════════════════════════════════════
// T-1 : assignPlatesToSlotViews (nearest 하향앵커 전역 1:1 그리디 + 게이트)
// ════════════════════════════════════════════════════════════════════
describe('assignPlatesToSlotViews v2 (T-1 nearest 하향앵커 배정)', () => {
  it('(a) plate 중심이 특정 슬롯 lowerFrontAnchor 에 최근접 → 그 slotId 배정 + quad 참조 보존', () => {
    const slots = rowSlots();
    const a2 = anchorOf(slots[1]);
    const p = plateAtCenter(a2.x, a2.y, 0.9); // slot2 앵커에 정확히 착지
    const m = assignPlatesToSlotViews(slots, [p]);
    expect(m.has(2)).toBe(true);
    expect(m.has(1)).toBe(false);
    expect(m.has(3)).toBe(false);
    // ★ 반환 quad 는 입력 plate.quad 참조 그대로(라우트 confidence 역조회 계약).
    expect(m.get(2)).toBe(p.quad);
  });

  it('(b) 한 칸 밀림 회귀 방지 — 두 앵커 사이 plate 는 앵커 최근접 슬롯에 귀속(bbox 밖이어도)', () => {
    const slots = rowSlots();
    const a1 = anchorOf(slots[0]); // x=0.175
    const a2 = anchorOf(slots[1]); // x=0.375
    // x=0.28: 두 슬롯 roi bbox(0.10~0.25, 0.30~0.45) 어느 쪽에도 안 듦 → 구 bbox 판정이면 미배정.
    //   앵커 거리: slot1 0.105 vs slot2 0.095 → slot2 최근접. v2 는 slot2 로 확정(밀림 없음).
    expect(a1.y).toBeCloseTo(a2.y, 10);
    const p = plateAtCenter(0.28, a1.y);
    const m = assignPlatesToSlotViews(slots, [p]);
    expect(m.get(2)).toBe(p.quad);
    expect(m.has(1)).toBe(false);
  });

  it('(c) 전역 1:1 — plate 3개가 각자 최근접 슬롯(plate당 slot≤1·slot당 plate≤1)', () => {
    const slots = rowSlots();
    const [a1, a2, a3] = slots.map(anchorOf);
    const p1 = plateAtCenter(a1.x, a1.y);
    const p2 = plateAtCenter(a2.x, a2.y);
    const p3 = plateAtCenter(a3.x, a3.y);
    const m = assignPlatesToSlotViews(slots, [p1, p2, p3]);
    expect(m.size).toBe(3);
    expect(m.get(1)).toBe(p1.quad);
    expect(m.get(2)).toBe(p2.quad);
    expect(m.get(3)).toBe(p3.quad);
  });

  it('(d) 같은 슬롯 경합 → 더 가까운 plate 가 차지, 나머지는 차선 슬롯으로 폴백(그리디 maximal)', () => {
    const slots = rowSlots();
    const a2 = anchorOf(slots[1]);
    const close = plateAtCenter(a2.x + 0.005, a2.y); // slot2 에 매우 근접(단독 후보)
    const far = plateAtCenter(0.45, a2.y); // slot2(0.075) 최근접이나 slot3(0.125)도 게이트 내
    const m = assignPlatesToSlotViews(slots, [far, close]); // 입력 순서 뒤집어도 거리 우선
    expect(m.get(2)).toBe(close.quad); // 더 가까운 close 가 slot2 확정
    expect(m.get(3)).toBe(far.quad); // far 는 차선(slot3)으로 폴백 — 폐기 아님
    expect(m.size).toBe(2);
  });

  it('(e) 결정성 — 같은 입력 2회 실행 동일 결과(난수·외부상태 없음)', () => {
    const slots = rowSlots();
    const [a1, a2, a3] = slots.map(anchorOf);
    const plates = [plateAtCenter(a1.x, a1.y), plateAtCenter(a2.x, a2.y), plateAtCenter(a3.x, a3.y)];
    expect([...assignPlatesToSlotViews(slots, plates)]).toEqual([...assignPlatesToSlotViews(slots, plates)]);
  });
});

describe('assignPlatesToSlotViews v2 (T-1 게이트 MATCH_RADIUS=0.15 · null 스킵)', () => {
  it('거리 게이트 양면 — 앵커에서 0.14(≤0.15) 배정 / 0.16(>0.15) 미배정', () => {
    const slot = slotView(1, rectPoly(0.10, 0.30, 0.15, 0.15), { slot3dFrontCenter: { x: 0.175, y: 0.40 } });
    const a = anchorOf(slot); // (0.175, 0.42333)
    const within = plateAtCenter(a.x + 0.14, a.y); // 순수 x 오프셋 → dist 0.14
    const exceed = plateAtCenter(a.x + 0.16, a.y); // dist 0.16
    expect(assignPlatesToSlotViews([slot], [within]).has(1)).toBe(true);
    expect(assignPlatesToSlotViews([slot], [exceed]).size).toBe(0);
  });

  it('slot3dFrontCenter==null 슬롯은 앵커 없어 배정 대상 제외(유효 슬롯만 배정)', () => {
    const withFc = slotView(1, rectPoly(0.10, 0.30, 0.15, 0.15), { slot3dFrontCenter: { x: 0.175, y: 0.40 } });
    const nullFc = slotView(2, rectPoly(0.30, 0.30, 0.15, 0.15)); // slot3dFrontCenter=null(기본)
    const a1 = anchorOf(withFc);
    const p1 = plateAtCenter(a1.x, a1.y);
    // slot2 하단중심(0.375,0.45) 근처 plate — null 이라 앵커 없음 → 미배정.
    const p2 = plateAtCenter(0.375, 0.44);
    const m = assignPlatesToSlotViews([withFc, nullFc], [p1, p2]);
    expect(m.size).toBe(1);
    expect(m.get(1)).toBe(p1.quad);
    expect(m.has(2)).toBe(false);
  });

  it('어느 앵커에도 게이트 내 근접이 없는 plate → Map 미포함(미배정)', () => {
    const slots = rowSlots();
    const m = assignPlatesToSlotViews(slots, [plateAtCenter(0.9, 0.9)]);
    expect(m.size).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════
// T-3 · T-4 : POST /capture/slots/lpd (라우트) + 실DB 왕복
// ════════════════════════════════════════════════════════════════════

const captureCfg: ToolsConfig['capture'] = {
  defaultCount: 50, intervalMs: 1000, moveIntervalMs: 1000, checkpointEvery: 10,
  checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, dbFile: ':memory:',
  clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5, slotAssignGate: 0.12, moveBeforeCapture: true,
};
const setupCfg = {
  presetSettleMs: 0, betweenPresetMs: 0, minConfidence: 0.5, roiPadding: 0, yBandTolerance: 0.1,
  accumFrames: 1, accumIntervalMs: 0, clusterDist: 0.06, clusterMinSupport: 1, lpdEnabled: false,
};

const fakeCamera = () => ({
  health: async () => true,
  requestImage: async (c: number, p: number): Promise<CapturedImage> => ({ camIdx: c, presetIdx: p, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('f') }),
} as unknown as CameraClient);
const fakeVpd = () => ({ health: async () => true, detect: async () => [] } as unknown as VpdClient);
const fakeRepo = (): Repository => {
  const saved: SetupArtifact[] = [];
  return { saveArtifact: (a: SetupArtifact) => saved.push(a), loadArtifact: () => saved.at(-1) ?? null, path: 'mem' } as unknown as Repository;
};

function makeServer() {
  const store = new SqliteStore(':memory:');
  const queue: Array<() => void> = [];
  const job = new CaptureJob({
    camera: fakeCamera(), vpd: fakeVpd(), cfg: captureCfg, lpdEnabled: false,
    setTimer: (fn) => { queue.push(fn); return queue as unknown as NodeJS.Timeout; },
    clearTimer: () => {}, sleep: async () => {}, now: () => 'T',
  });
  const repo = fakeRepo();
  const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
  const orchestrator = new SetupOrchestrator({ camera: fakeCamera(), vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
  const app = buildServer({
    orchestrator, repo, camera: fakeCamera(), vpd: fakeVpd(),
    captureJob: job, finalizer, sqlite: store, capture: captureCfg,
  });
  return { app, store, job };
}

let app: FastifyInstance | undefined;
let store: SqliteStore | undefined;
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  if (store) { store.close(); store = undefined; }
});

/** quad(NormalizedQuad) → body JSON 용 [{x,y}×4] (값 복사). */
const quadBody = (q: NormalizedQuad) => q.map((p) => ({ x: p.x, y: p.y }));

describe('POST /capture/slots/lpd (T-3 라우트 · store 스텁 · v2 배정)', () => {
  it('(a)(b) plates 배정 → upsertSlotLpd 가 stringify5(lpdObb)·slotId·updatedAt rows 로 호출 + 반환 {updated,unassigned,assigned}', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const s1 = slotView(1, rectPoly(0.10, 0.30, 0.15, 0.15), { slot3dFrontCenter: { x: 0.175, y: 0.40 } });
    const s2 = slotView(2, rectPoly(0.50, 0.30, 0.15, 0.15), { slot3dFrontCenter: { x: 0.575, y: 0.40 } });
    vi.spyOn(s.store, 'getSlotSetup').mockReturnValue([s1, s2]);
    const upsertSpy = vi.spyOn(s.store, 'upsertSlotLpd');

    const a1 = anchorOf(s1);
    const a2 = anchorOf(s2);
    const pa = plateAtCenter(a1.x, a1.y, 0.91); // slot1
    const pb = plateAtCenter(a2.x, a2.y, 0.82); // slot2
    const r = await app.inject({ method: 'POST', url: '/capture/slots/lpd', payload: { cam: 1, preset: 1, plates: [{ quad: quadBody(pa.quad), confidence: 0.91 }, { quad: quadBody(pb.quad), confidence: 0.82 }] } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(true);
    expect(body.updated).toBe(2);
    expect(body.unassigned).toBe(0);
    expect(body.assigned).toEqual(expect.arrayContaining([
      { slotId: 1, confidence: 0.91 },
      { slotId: 2, confidence: 0.82 },
    ]));

    // ★ upsertSlotLpd 인자 기록 검증(경계면): rows[].lpdObb === stringify5(quad).
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    const rows = upsertSpy.mock.calls[0][0];
    expect(rows).toHaveLength(2);
    const row1 = rows.find((x) => x.slotId === 1)!;
    expect(row1.lpdObb).toBe(stringify5(pa.quad));
    expect(typeof row1.updatedAt).toBe('string');
    const row2 = rows.find((x) => x.slotId === 2)!;
    expect(row2.lpdObb).toBe(stringify5(pb.quad));
  });

  it('(c) 빈 plates → updated 0 · upsertSlotLpd 는 빈 배열로 호출', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const s1 = slotView(1, rectPoly(0.10, 0.30, 0.15, 0.15), { slot3dFrontCenter: { x: 0.175, y: 0.40 } });
    vi.spyOn(s.store, 'getSlotSetup').mockReturnValue([s1]);
    const upsertSpy = vi.spyOn(s.store, 'upsertSlotLpd');
    const r = await app.inject({ method: 'POST', url: '/capture/slots/lpd', payload: { cam: 1, preset: 1, plates: [] } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.updated).toBe(0);
    expect(body.unassigned).toBe(0);
    expect(body.assigned).toEqual([]);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy.mock.calls[0][0]).toEqual([]);
  });

  it('(c2) 어느 앵커에도 안 드는 plate → updated 0 · unassigned 반영', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const s1 = slotView(1, rectPoly(0.10, 0.30, 0.15, 0.15), { slot3dFrontCenter: { x: 0.175, y: 0.40 } });
    vi.spyOn(s.store, 'getSlotSetup').mockReturnValue([s1]);
    const r = await app.inject({ method: 'POST', url: '/capture/slots/lpd', payload: { cam: 1, preset: 1, plates: [{ quad: quadBody(plateAtCenter(0.9, 0.9).quad) }] } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.updated).toBe(0);
    expect(body.unassigned).toBe(1);
  });

  it('cam/preset/roi<3 필터 — 다른 프리셋·짧은 roi 슬롯은 후보에서 제외', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const s1 = slotView(1, rectPoly(0.10, 0.30, 0.15, 0.15), { slot3dFrontCenter: { x: 0.175, y: 0.40 } }); // cam1:preset1 유효
    const s2 = slotView(2, rectPoly(0.50, 0.30, 0.15, 0.15), { presetId: 2, presetKey: '1:2', slot3dFrontCenter: { x: 0.575, y: 0.40 } }); // 다른 프리셋
    const s3 = slotView(3, rectPoly(0.30, 0.60, 0.15, 0.15).slice(0, 2), { slot3dFrontCenter: { x: 0.375, y: 0.70 } }); // roi<3
    vi.spyOn(s.store, 'getSlotSetup').mockReturnValue([s1, s2, s3]);
    const upsertSpy = vi.spyOn(s.store, 'upsertSlotLpd');
    const a1 = anchorOf(s1);
    const pIn1 = plateAtCenter(a1.x, a1.y); // 슬롯1
    const pIn2 = plateAtCenter(0.575, 0.42); // 슬롯2 영역이나 preset 불일치 → 제외
    const pIn3 = plateAtCenter(0.375, 0.68); // 슬롯3 영역이나 roi<3 → 제외
    const r = await app.inject({ method: 'POST', url: '/capture/slots/lpd', payload: { cam: 1, preset: 1, plates: [{ quad: quadBody(pIn1.quad) }, { quad: quadBody(pIn2.quad) }, { quad: quadBody(pIn3.quad) }] } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.updated).toBe(1);
    expect(body.unassigned).toBe(2);
    expect(upsertSpy.mock.calls[0][0].map((x) => x.slotId)).toEqual([1]);
  });

  it('(d) 잘못된 body → 400 (quad 누락 / quad 길이≠4 / cam 누락 / cam 비양수)', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const bad = [
      { cam: 1, preset: 1, plates: [{ confidence: 1 }] }, // quad 누락
      { cam: 1, preset: 1, plates: [{ quad: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }] }, // 3점
      { preset: 1, plates: [] }, // cam 누락
      { cam: 0, preset: 1, plates: [] }, // cam 비양수
    ];
    for (const payload of bad) {
      const r = await app.inject({ method: 'POST', url: '/capture/slots/lpd', payload });
      expect(r.statusCode).toBe(400);
      expect(JSON.parse(r.body).ok).toBe(false);
    }
  });
});

describe('stringify5 규약 (T-4 — 저장 lpdObb 소수점 5자리)', () => {
  it('quad 좌표가 5자리 초과여도 lpdObb 는 round5 직렬화된다', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    // 앵커 (0.175, 0.22333) 근처에 착지하도록 slot 배치(messy quad 중심 ≈ (0.17346,0.20265)).
    const s1 = slotView(1, rectPoly(0.10, 0.10, 0.15, 0.15), { slot3dFrontCenter: { x: 0.175, y: 0.20 } });
    vi.spyOn(s.store, 'getSlotSetup').mockReturnValue([s1]);
    const upsertSpy = vi.spyOn(s.store, 'upsertSlotLpd');
    const messy: NormalizedQuad = [
      { x: 0.123456789, y: 0.187654321 },
      { x: 0.223456789, y: 0.187654321 },
      { x: 0.223456789, y: 0.217654321 },
      { x: 0.123456789, y: 0.217654321 },
    ]; // bbox 중심 (0.173456789, 0.202654321) — s1 앵커와 게이트 내
    const r = await app.inject({ method: 'POST', url: '/capture/slots/lpd', payload: { cam: 1, preset: 1, plates: [{ quad: quadBody(messy) }] } });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).updated).toBe(1); // 배정 성립(게이트 내)
    const rows = upsertSpy.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0].lpdObb).toBe(stringify5(messy));
    const parsed = JSON.parse(rows[0].lpdObb!) as NormalizedQuad;
    expect(parsed[0].x).toBe(0.12346); // 0.123456789 → 0.12346
    expect(parsed[0].y).toBe(0.18765); // 0.187654321 → 0.18765
  });
});

// ── place/camera/preset 부모 시드(FK 충족) ──────────────────
const placeRow = (): PlaceInfoRow => ({ placeId: 1, placeName: 'Place01' });
const cameraRow = (): CameraInfoRow => ({
  camId: 1, camName: null, camUuid: null, url: null, userId: null, password: null, rtspUrl: null,
  camType: 'ptz', camCompany: null, placeId: 1, imgW: 1920, imgH: 1080, updatedAt: 'T',
});
const presetRow = (presetId = 1): PresetPosRow => ({
  camId: 1, presetId, sname: `Preset ${presetId}`, pan: 10, tilt: 5, zoom: 2, updatedAt: 'T',
});
const slotRow = (slotId: number, roi: NormalizedPoint[], over: Partial<SlotSetupRow> = {}): SlotSetupRow => ({
  slotId, camId: 1, presetId: 1, presetSlotIdx: slotId,
  slotRoi: JSON.stringify(roi), vpdBbox: null, lpdObb: null, occupyRange: null,
  pan: null, tilt: null, zoom: null, centered: 0, img1: null, slot3dFrontCenter: null, updatedAt: 'T-orig', ...over,
});

describe('실DB 왕복 (경계면 실증 — 시드→POST→getSlotSetup 재조회 · v2 배정)', () => {
  it('POST /capture/slots/lpd → slot_setup.lpd 반영 + 타 컬럼(vpd/roi/updatedAt)·타 슬롯 wipe 안전', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    s.store.upsertPlaceInfo([placeRow()]);
    s.store.upsertCameraInfo([cameraRow()]);
    s.store.upsertPresetPos([presetRow(1)]);
    const roi1 = rectPoly(0.10, 0.30, 0.15, 0.15);
    const fc1 = { x: 0.175, y: 0.40 };
    s.store.replaceSlotSetup([
      slotRow(1, roi1, {
        vpdBbox: JSON.stringify({ x: 0.15, y: 0.15, w: 0.1, h: 0.1 }),
        slot3dFrontCenter: JSON.stringify(fc1),
      }),
      slotRow(2, rectPoly(0.50, 0.30, 0.15, 0.15), { slot3dFrontCenter: JSON.stringify({ x: 0.575, y: 0.40 }) }),
    ]);

    // 시드 후 실제 getSlotSetup 이 내주는 뷰로 앵커를 산출(파싱 왕복까지 포함).
    const seeded = s.store.getSlotSetup().find((v) => v.slotId === 1)!;
    const a1 = anchorOf(seeded);
    const pa = plateAtCenter(a1.x, a1.y, 0.9);
    const r = await app.inject({ method: 'POST', url: '/capture/slots/lpd', payload: { cam: 1, preset: 1, plates: [{ quad: quadBody(pa.quad), confidence: 0.9 }] } });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).updated).toBe(1);

    const rows = s.store.getSlotSetup();
    expect(rows).toHaveLength(2);
    const v1 = rows.find((x) => x.slotId === 1)!;
    const v2 = rows.find((x) => x.slotId === 2)!;
    // 저장 경로는 stringify5(round5) — 앵커 y(0.41833…)는 5자리 초과라 round5 형과 비교(영속화 계약).
    expect(v1.lpd).toEqual(JSON.parse(stringify5(pa.quad)));
    expect(v1.vpd).toEqual({ x: 0.15, y: 0.15, w: 0.1, h: 0.1 }); // ★ 타 컬럼 불변
    expect(v1.roi).toEqual(roi1);
    expect(v1.slot3dFrontCenter).toEqual(fc1); // 앵커 소스도 불변
    expect(v2.lpd).toBeNull(); // ★ 타 슬롯 불변
    expect(v2.updatedAt).toBe('T-orig');
  });

  it('GET /capture/slots 로도 lpd 반영이 노출된다(뷰어 소비 경로)', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    s.store.upsertPlaceInfo([placeRow()]);
    s.store.upsertCameraInfo([cameraRow()]);
    s.store.upsertPresetPos([presetRow(1)]);
    s.store.replaceSlotSetup([
      slotRow(1, rectPoly(0.10, 0.30, 0.15, 0.15), { slot3dFrontCenter: JSON.stringify({ x: 0.175, y: 0.40 }) }),
    ]);
    const seeded = s.store.getSlotSetup()[0];
    const a1 = anchorOf(seeded);
    const pa = plateAtCenter(a1.x, a1.y);
    await app.inject({ method: 'POST', url: '/capture/slots/lpd', payload: { cam: 1, preset: 1, plates: [{ quad: quadBody(pa.quad) }] } });
    const r = await app.inject({ method: 'GET', url: '/capture/slots' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as SlotSetupView[];
    expect(body[0].lpd).toEqual(JSON.parse(stringify5(pa.quad))); // 영속화 round5 계약 반영
  });
});
