// ★ 22회차 — 실카 프리셋(EV1~EV5) **면 정답 라벨**(채점 전용 R1) 작성기 + 검수 오버레이.
//
// ⚠ 채점 전용이다. `src/ground/*` 는 이 파일도 산출물(truth.json)도 절대 import 하지 않는다.
//   좌표는 사람이 원본 픽셀을 읽어 확정한 값이며, 어떤 검출 알고리즘도 참여하지 않았다.
//
// 정의 방식: 면 경계는 **직선 3종**(근변 / 원변 / 칸막이)의 교점으로 잡는다.
//   각 직선은 이미지에서 육안·스캔라인으로 확인한 두 점으로 고정한다(`evPresetProbe.ts` 로 측정).
//   교점이 실제로 관측 가능한지는 `status` 로 따로 기록한다 — 가려졌거나 화면 밖이면 정직히 남긴다.
//
// 사용:
//   npx tsx src/tools/evPresetTruth.ts          # truth.json + 검수 오버레이 PNG
//   npx tsx src/tools/evPresetTruth.ts lines    # 직선 적합 확인용 오버레이만(라벨 반복 루프)

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const SRC_DIR = 'd:/Work/Parking3D/AgentVLA/ParkAgent/etc/camera_preset';
const FIX_DIR = 'test/fixtures/evPreset';
const OUT_DIR = 'reports/truth_evpreset';
const W = 1920;
const H = 1080;

type Pt = { x: number; y: number };
/** 직선: 확인한 두 점. 세로에 가까운 선도 안전하게 다루려고 점-쌍으로 둔다. */
type Line = { id: string; a: Pt; b: Pt; kind: 'near' | 'far' | 'sep'; evidence: string; uncertain?: boolean };

type CornerStatus =
  | 'observed' // 모서리 자체가 화면에서 보인다
  | 'occluded' // 차량 등에 가려 관측 불가 → 좌표 없음
  | 'offscreen' // 두 직선은 보이나 교점이 화면 밖
  | 'uncertain'; // 두 직선 중 하나가 불확실(희미한 도색/재질 경계 추정)

type Corner = { status: CornerStatus; pt: Pt | null; note?: string };

const round5 = (v: number) => Math.round(v * 1e5) / 1e5;

function cross(l1: Line, l2: Line): Pt | null {
  const x1 = l1.a.x;
  const y1 = l1.a.y;
  const x2 = l1.b.x;
  const y2 = l1.b.y;
  const x3 = l2.a.x;
  const y3 = l2.a.y;
  const x4 = l2.b.x;
  const y4 = l2.b.y;
  const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d;
  return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
}

/** 화면 경계까지 직선을 잘라 그리기용 선분으로. */
function clipToImage(l: Line): [Pt, Pt] | null {
  const dx = l.b.x - l.a.x;
  const dy = l.b.y - l.a.y;
  const ts: number[] = [];
  if (Math.abs(dx) > 1e-9) {
    ts.push((0 - l.a.x) / dx, (W - l.a.x) / dx);
  }
  if (Math.abs(dy) > 1e-9) {
    ts.push((0 - l.a.y) / dy, (H - l.a.y) / dy);
  }
  const inside: Pt[] = [];
  for (const t of ts) {
    const p = { x: l.a.x + t * dx, y: l.a.y + t * dy };
    if (p.x >= -1 && p.x <= W + 1 && p.y >= -1 && p.y <= H + 1) inside.push(p);
  }
  if (inside.length < 2) return null;
  return [inside[0], inside[inside.length - 1]];
}

type BaySpec = {
  id: string;
  left: string; // 칸막이 line id (또는 'none')
  right: string;
  occupied: boolean;
  occluded?: boolean;
  clipped?: boolean;
  uncertain?: boolean;
  note: string;
  /** 직선 교점 대신 화면에서 직접 읽은 모서리(가림 등으로 직선을 못 그을 때). */
  overrides?: Partial<Record<'nearLeft' | 'nearRight' | 'farLeft' | 'farRight', Corner>>;
};

type PresetSpec = {
  name: string;
  file: string;
  osdPtz: string;
  osdNote: string;
  near: Line;
  far: Line;
  seps: Line[];
  bays: BaySpec[];
  sceneNote: string;
};

const presets: PresetSpec[] = [
  {
    name: 'EV1',
    file: 'EV1.png',
    osdPtz: '70/27/x35',
    osdNote: 'OSD 표기 그대로. pan/tilt/zoom배율로 보이나 단정하지 않음.',
    sceneNote:
      '아스팔트 주차면 1열. 근변(주행로 쪽)은 흰 도색선이 있다. 원변은 보도 연석↔아스팔트 재질 경계이며 스토퍼 열이 그 안쪽에 붙어 있다. 좌측 1면은 검은 스타리아가 점유.',
    near: { id: 'N', a: { x: 900, y: 680 }, b: { x: 1700, y: 314 }, kind: 'near', evidence: '흰 도색선 중심. 열 스캔 x=900/1100/1300/1500/1700 → y=680/588/497/406/314 (잔차<2px)' },
    far: { id: 'F', a: { x: 700, y: 284 }, b: { x: 1300, y: 56 }, kind: 'far', evidence: '연석(콘크리트)↔아스팔트 재질 경계. 열 스캔 x=700/900/1100/1300 하단 → y=284/207/133/56' },
    seps: [
      { id: 'P1', a: { x: 100, y: 602 }, b: { x: 400, y: 804 }, kind: 'sep', evidence: '흰 도색선. 열 스캔 x=100/200/300/400 → y=602/668/734/804' },
      { id: 'P3', a: { x: 700, y: 314 }, b: { x: 1100, y: 532 }, kind: 'sep', evidence: '흰 도색선. 열 스캔 x=700/900/1100 → y=314/422/532' },
      { id: 'P4', a: { x: 965, y: 200 }, b: { x: 1370, y: 400 }, kind: 'sep', evidence: '흰 도색선. 행 스캔 y=200/250/300/350/400 → x=965/1068/1165/1269/1370' },
      { id: 'P5', a: { x: 1220, y: 100 }, b: { x: 1663, y: 300 }, kind: 'sep', evidence: '흰 도색선. 행 스캔 y=100/150/200/250/300 → x=1220/1330/1441/1550/1663' },
      { id: 'P6', a: { x: 1678, y: 100 }, b: { x: 1799, y: 150 }, kind: 'sep', evidence: '흰 도색선(우상단 짧게만 보임). 행 스캔 y=100/150 → x=1678/1799', uncertain: true },
    ],
    bays: [
      {
        id: 'EV1-01',
        left: 'P1',
        right: 'P2',
        occupied: true,
        occluded: true,
        note: '검은 스타리아 점유. 우측 칸막이(P2)는 근변 교점만 보이고(852,700 육안 확인) 원변 쪽은 차량에 가림. 좌측 칸막이 P1 의 원변 교점도 차량 뒤라 관측 불가.',
        overrides: {
          nearRight: { status: 'observed', pt: { x: 852, y: 700 }, note: '근변선과 칸막이가 만드는 V자 꼭짓점을 3.3배 확대에서 직접 읽음' },
          farRight: { status: 'occluded', pt: null, note: '스타리아 차체에 가림' },
          farLeft: { status: 'occluded', pt: null, note: '스타리아 차체에 가림' },
        },
      },
      {
        id: 'EV1-02',
        left: 'P2',
        right: 'P3',
        occupied: false,
        occluded: true,
        note: '좌측 칸막이(P2) 원변 교점이 차량에 가림. 나머지 3점은 관측.',
        overrides: {
          nearLeft: { status: 'observed', pt: { x: 852, y: 700 }, note: 'EV1-01 과 공유하는 꼭짓점' },
          farLeft: { status: 'occluded', pt: null, note: '스타리아 차체에 가림' },
        },
      },
      { id: 'EV1-03', left: 'P3', right: 'P4', occupied: false, note: '4점 모두 관측. 가장 신뢰도 높은 면.' },
      { id: 'EV1-04', left: 'P4', right: 'P5', occupied: false, note: '4점 모두 관측.' },
      {
        id: 'EV1-05',
        left: 'P5',
        right: 'P6',
        occupied: false,
        clipped: true,
        uncertain: true,
        note: '우측 근변 교점이 화면 오른쪽 밖(x>1919). 우측 원변 교점은 상단 경계(y≈2)에 걸림. P6 도색선은 짧게만 보여 불확실.',
      },
    ],
  },
  {
    name: 'EV2',
    file: 'EV2.png',
    osdPtz: '82/20/x95',
    osdNote: 'OSD 표기 그대로 읽음(리더 미제공분, 본 작업자가 판독).',
    sceneNote:
      '아스팔트 주차면 1열을 크게 당겨(x95) 본 장면. 차량 없음. 칸막이는 흰 도색선, 원변은 연석 아래 콘크리트↔아스팔트 재질 경계, 근변은 우하단의 흰 도색선. 화면 우측 가장자리에 세로 광원 번짐(글레어) 있음.',
    near: { id: 'N', a: { x: 1100, y: 998 }, b: { x: 1700, y: 628 }, kind: 'near', evidence: '흰 도색선. 열 스캔 x=1100/1300/1500/1700 → y=998/871/753/628' },
    far: { id: 'F', a: { x: 200, y: 404 }, b: { x: 600, y: 215 }, kind: 'far', evidence: '콘크리트↔아스팔트 계단 경계(gradient). x=200/300/400/500/600 → y=404/357/311/261/215' },
    seps: [
      { id: 'L1', a: { x: 100, y: 778 }, b: { x: 900, y: 1034 }, kind: 'sep', evidence: '흰 도색선. 열 스캔 x=100/300/500/900 → y=778/842/906/1035' },
      { id: 'L2', a: { x: 300, y: 413 }, b: { x: 1300, y: 716 }, kind: 'sep', evidence: '흰 도색선. 열 스캔 x=300/500/700/900/1100/1300 → y=413/475/538/597/653/716' },
      { id: 'L3', a: { x: 900, y: 217 }, b: { x: 1700, y: 441 }, kind: 'sep', evidence: '흰 도색선. 열 스캔 x=900/1100/1300/1500/1700 → y=217/271/330/385/441' },
      { id: 'L5', a: { x: 1500, y: 47 }, b: { x: 1700, y: 98 }, kind: 'sep', evidence: '흰 도색선(우상단 짧게). 열 스캔 x=1500/1700 → y=47/98', uncertain: true },
    ],
    bays: [
      {
        id: 'EV2-00',
        left: 'none',
        right: 'L1',
        occupied: false,
        clipped: true,
        uncertain: true,
        note: '좌측 칸막이가 화면 밖(추정 원변 교점 x≈-930). 좌측 두 점 관측 불가 → 라벨하지 않음.',
      },
      { id: 'EV2-01', left: 'L1', right: 'L2', occupied: false, clipped: true, note: '좌측 원변 교점이 화면 왼쪽 밖(x≈-312). 나머지 3점 관측.' },
      { id: 'EV2-02', left: 'L2', right: 'L3', occupied: false, note: '4점 모두 관측. 가장 신뢰도 높은 면.' },
      {
        id: 'EV2-03',
        left: 'L3',
        right: 'L5',
        occupied: false,
        clipped: true,
        uncertain: true,
        note: '우측 원변 교점이 화면 위쪽 밖(y≈-43), 우측 근변 교점이 오른쪽 밖(x≈2308). L5 도색선이 짧아 불확실.',
      },
    ],
  },
  {
    name: 'EV3',
    file: 'EV3.png',
    osdPtz: '48/16/x35',
    osdNote: 'OSD 표기 그대로.',
    sceneNote:
      '보도블록 포장 주차면 1열. 흰 도색이 없고 칸막이는 **밝은 블록 띠**(포장 패턴 seam)다. 근변은 블록↔아스팔트 재질 경계. 원변(연석/잔디 경계)은 차량·수목에 상당 부분 가려 직선 확정 실패 → 원변 좌표 미확정.',
    near: { id: 'N', a: { x: 1100, y: 732 }, b: { x: 1900, y: 643 }, kind: 'near', evidence: '블록↔아스팔트 계단 경계(gradient). x=1100/1300/1700/1900 → y=732/710/665/643 (잔차<2px)' },
    far: { id: 'F', a: { x: 700, y: 559.3 }, b: { x: 1600, y: 468.9 }, kind: 'far', evidence: '잔디 하단선을 색(G−(R+B)/2)으로 측정: x=500/700/900/1100/1600/1800 → 556/537/519/495/447/428 (잔차<3px). 그 아래 연석 폭만큼(육안 21~24px) 내린 선이 블록 포장 시작=원변. 오프셋이 육안이라 ±15px 불확실.', uncertain: true },
    seps: [
      { id: 'S1', a: { x: 800, y: 640 }, b: { x: 910, y: 740 }, kind: 'sep', evidence: '밝은 블록 띠 중심(원시 밝기 프로파일). y=640/690/740 → x=800/857/910 (잔차<1.5px)' },
      { id: 'S2', a: { x: 1162, y: 640 }, b: { x: 1234, y: 690 }, kind: 'sep', evidence: '밝은 블록 띠 중심(원시 프로파일). y=640/690 → x=1162/1234. 아반떼 그림자로 아래쪽 연장 미확인', uncertain: true },
      { id: 'S3', a: { x: 1523, y: 630 }, b: { x: 1584, y: 666 }, kind: 'sep', evidence: '밝은 블록 띠. 회색 아반떼 아래쪽 짧은 구간만 보임(3.1배 확대 육안)', uncertain: true },
    ],
    bays: [
      { id: 'EV3-01', left: 'S1', right: 'S2', occupied: false, uncertain: true, note: '근변 2점은 관측. 원변 2점은 원변선 미확정으로 좌표 없음.' },
      { id: 'EV3-02', left: 'S2', right: 'S3', occupied: true, occluded: true, uncertain: true, note: '회색 아반떼 점유. 칸막이 S2·S3 모두 차량에 가려 짧은 구간만 보임. 원변 미확정.' },
    ],
  },
  {
    name: 'EV4',
    file: 'EV4.png',
    osdPtz: '64/15/x55',
    osdNote: 'OSD 표기 그대로(리더 미제공분, 본 작업자가 판독).',
    sceneNote:
      '보도블록 포장 주차면 1열에 **흰 도색 칸막이선**이 있다. 근변은 블록↔아스팔트 재질 경계로 매우 또렷하다. 원변은 연석/잔디 경계. 흰색 르노 SUV 1대 점유. 우측에 가로등 기둥이 세로로 서 있어 스캔 잡음을 만든다.',
    near: { id: 'N', a: { x: 100, y: 767 }, b: { x: 1700, y: 444 }, kind: 'near', evidence: '블록↔아스팔트 계단 경계(gradient). x=100/300/900/1100/1700 → y=768/727/604/564/445 (잔차<1.5px)' },
    far: { id: 'F', a: { x: 500, y: 437.5 }, b: { x: 1860, y: 191.6 }, kind: 'far', evidence: '잔디 하단선을 색으로 측정: x=100/500/700/900/1600/1900 → 468/395/360/320/196/142 (잔차<3px). 그 아래 연석 폭(육안 42~43px, 좌우 일치)을 더한 선이 블록 포장 시작=원변. 오프셋이 육안이라 ±10px 불확실.', uncertain: true },
    seps: [
      { id: 'A', a: { x: 654.7, y: 460 }, b: { x: 958.6, y: 575 }, kind: 'sep', evidence: '흰 도색선. 원시 밝기 프로파일 y=460/500/540/575 → x=648/768/872/952 최소자승(잔차<8px)' },
      { id: 'B', a: { x: 397, y: 560 }, b: { x: 587, y: 640 }, kind: 'sep', evidence: '흰 도색선. 원시 프로파일 y=560/600/640 → x=397/495/587 (잔차<2px)' },
      { id: 'C', a: { x: 64, y: 650 }, b: { x: 192, y: 710 }, kind: 'sep', evidence: '흰 도색선. 원시 프로파일 y=650/680/710 → x=64/128/192 (완전 선형, 잔차 0)' },
    ],
    bays: [
      { id: 'EV4-01', left: 'C', right: 'B', occupied: false, clipped: true, uncertain: true, note: '좌측 원변 교점이 화면 왼쪽 밖. C·B 둘 다 짧게만 보여 기울기 불확실.' },
      { id: 'EV4-02', left: 'B', right: 'A', occupied: false, uncertain: true, note: '근변 2점은 신뢰. 원변 2점은 원변선(±10px)과 B 기울기 불확실이 겹침.' },
      {
        id: 'EV4-03',
        left: 'A',
        right: 'none',
        occupied: true,
        occluded: true,
        uncertain: true,
        note: '흰색 르노 SUV 점유. 우측 칸막이가 차량과 가로등에 가려 직선 확정 실패 → 우측 2점 좌표 없음.',
      },
    ],
  },
  {
    name: 'EV5',
    file: 'EV5.png',
    osdPtz: '38/11/x55',
    osdNote: 'OSD 표기 그대로.',
    sceneNote:
      '건물 앞 보도블록 포장 주차면 1열(차량 3대 코 내밀고 주차) + 화면 하단에 다른 열의 흰 아반떼. 흰 도색이 사실상 없고 칸막이는 밝은 블록 띠. 틸트 11°로 매우 비스듬해 원변(건물 쪽)이 압축돼 있고, 가로등 기둥·가로수가 좌우를 가린다.',
    near: { id: 'N', a: { x: 100, y: 531.6 }, b: { x: 1200, y: 497.8 }, kind: 'near', evidence: '블록↔아스팔트 경계. 열 원시 프로파일 x=100/400/1200 → y=532/522/498 최소자승(잔차<0.6px). 다만 대비가 약하고 x=900/1700 은 차량 그림자·수목으로 판독 불가', uncertain: true },
    far: { id: 'F', a: { x: 65, y: 339 }, b: { x: 452, y: 319 }, kind: 'far', evidence: '⚠ 블록↔건물앞 콘크리트 경계. 3.1배 확대 육안 2점뿐이며 우측은 차량에 가려 미확인', uncertain: true },
    seps: [
      { id: 'T1', a: { x: 32, y: 360 }, b: { x: 90, y: 480 }, kind: 'sep', evidence: '밝은 블록 띠. 행 원시 프로파일 y=360/420/480 → x=32/64/90 (띠가 넓고 흐려 중심 ±15px)', uncertain: true },
      { id: 'T2', a: { x: 384, y: 420 }, b: { x: 416, y: 480 }, kind: 'sep', evidence: '밝은 블록 띠. 행 원시 프로파일 y=420/480 → x=384/416. y=360 에서는 띠가 사라져 위쪽 연장 미확인', uncertain: true },
    ],
    bays: [
      { id: 'EV5-01', left: 'T1', right: 'T2', occupied: false, uncertain: true, note: '빈 면 1개만 4점 추정 가능. 근변·원변 모두 육안 2~3점 기반이라 불확실.' },
      {
        id: 'EV5-02',
        left: 'T2',
        right: 'none',
        occupied: true,
        occluded: true,
        uncertain: true,
        note: '투싼 점유. 우측 칸막이가 가로등 기둥과 차량에 가림 → 우측 2점 좌표 없음.',
      },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
const mode = process.argv[2] ?? 'all';
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(FIX_DIR, { recursive: true });

const COL = { near: '#00e676', far: '#ffea00', sep: '#40c4ff' } as const;

const truth: unknown[] = [];

for (const p of presets) {
  const src = join(SRC_DIR, p.file);
  const meta = await sharp(src).metadata();
  const parts: string[] = [];
  const byId = new Map<string, Line>();
  for (const l of [p.near, p.far, ...p.seps]) byId.set(l.id, l);

  // 1) 직선(적합 결과) — 라벨 반복 루프에서 어긋남을 바로 보기 위해 화면 끝까지 연장해 그린다.
  for (const l of [p.near, p.far, ...p.seps]) {
    const seg = clipToImage(l);
    if (!seg) continue;
    const c = COL[l.kind];
    parts.push(
      `<line x1="${seg[0].x.toFixed(1)}" y1="${seg[0].y.toFixed(1)}" x2="${seg[1].x.toFixed(1)}" y2="${seg[1].y.toFixed(1)}" stroke="${c}" stroke-width="${l.uncertain ? 2 : 3}" ${l.uncertain ? 'stroke-dasharray="14,10"' : ''} opacity="0.95"/>`,
    );
    parts.push(
      `<text x="${(seg[1].x - 8).toFixed(0)}" y="${(seg[1].y - 8).toFixed(0)}" fill="${c}" font-size="24" font-weight="bold" text-anchor="end" stroke="#000" stroke-width="0.7">${l.id}${l.uncertain ? '?' : ''}</text>`,
    );
    // 측정에 쓴 두 점을 표시(이 점들이 실제 경계에 얹혔는지 육안 확인용)
    for (const q of [l.a, l.b]) parts.push(`<circle cx="${q.x}" cy="${q.y}" r="5" fill="none" stroke="${c}" stroke-width="2.5"/>`);
  }

  // 2) 면 사각형 + 모서리 상태
  const bayOut: unknown[] = [];
  for (const b of p.bays) {
    const lL = byId.get(b.left);
    const lR = byId.get(b.right);
    const mk = (line: Line | undefined, edge: Line): Corner => {
      if (!line) return { status: 'occluded', pt: null, note: '해당 칸막이 직선 미확정' };
      const q = cross(line, edge);
      if (!q) return { status: 'occluded', pt: null };
      const off = q.x < 0 || q.x > W || q.y < 0 || q.y > H;
      if (off) return { status: 'offscreen', pt: { x: round5(q.x), y: round5(q.y) } };
      if (line.uncertain || edge.uncertain) return { status: 'uncertain', pt: { x: round5(q.x), y: round5(q.y) } };
      return { status: 'observed', pt: { x: round5(q.x), y: round5(q.y) } };
    };
    const corners: Record<string, Corner> = {
      nearLeft: b.overrides?.nearLeft ?? mk(lL, p.near),
      nearRight: b.overrides?.nearRight ?? mk(lR, p.near),
      farRight: b.overrides?.farRight ?? mk(lR, p.far),
      farLeft: b.overrides?.farLeft ?? mk(lL, p.far),
    };
    // ⚠ 원변선 자체가 미확정(uncertain)인 프리셋은 원변 모서리를 좌표 없음으로 강등한다.
    if (p.far.uncertain && (p.name === 'EV3' || p.name === 'EV5')) {
      for (const k of ['farLeft', 'farRight'] as const) {
        if (corners[k].status !== 'occluded') corners[k] = { status: 'uncertain', pt: corners[k].pt, note: '원변선 미확정 — 가안 좌표' };
      }
    }

    const order = ['nearLeft', 'nearRight', 'farRight', 'farLeft'] as const;
    const pts = order.map((k) => corners[k].pt);
    const allObserved = order.every((k) => corners[k].status === 'observed');

    if (pts.every((q) => q)) {
      const poly = pts.map((q) => `${q!.x.toFixed(1)},${q!.y.toFixed(1)}`).join(' ');
      parts.push(
        `<polygon points="${poly}" fill="${allObserved ? '#ff174422' : '#ffffff11'}" stroke="${allObserved ? '#ff1744' : '#ff9100'}" stroke-width="4" ${allObserved ? '' : 'stroke-dasharray="16,10"'}/>`,
      );
    } else {
      // 좌표 없는 모서리가 있으면 확정된 변만 굵게 그린다(없는 변은 그리지 않는다).
      for (let i = 0; i < 4; i++) {
        const q1 = pts[i];
        const q2 = pts[(i + 1) % 4];
        if (!q1 || !q2) continue;
        parts.push(`<line x1="${q1.x}" y1="${q1.y}" x2="${q2.x}" y2="${q2.y}" stroke="#ff9100" stroke-width="4"/>`);
      }
    }
    for (const k of order) {
      const c = corners[k];
      if (!c.pt) continue;
      const col = c.status === 'observed' ? '#ff1744' : c.status === 'offscreen' ? '#7c4dff' : '#ff9100';
      parts.push(`<circle cx="${c.pt.x}" cy="${c.pt.y}" r="9" fill="${col}" stroke="#000" stroke-width="2"/>`);
    }
    const known = pts.filter((q) => q) as Pt[];
    if (known.length) {
      const cx = known.reduce((s, q) => s + q.x, 0) / known.length;
      const cy = known.reduce((s, q) => s + q.y, 0) / known.length;
      const tag = [b.occupied ? '점유' : '빈면', b.occluded ? '가림' : '', b.clipped ? '화면밖' : '', b.uncertain ? '애매' : '']
        .filter(Boolean)
        .join('·');
      parts.push(
        `<rect x="${cx - 118}" y="${cy - 30}" width="236" height="58" rx="8" fill="#000000cc"/>`,
        `<text x="${cx}" y="${cy - 6}" fill="#fff" font-size="27" font-weight="bold" text-anchor="middle">${b.id}</text>`,
        `<text x="${cx}" y="${cy + 20}" fill="#ffd54f" font-size="21" text-anchor="middle">${tag}</text>`,
      );
    }

    bayOut.push({
      id: b.id,
      occupied: b.occupied,
      occluded: !!b.occluded,
      clipped: !!b.clipped,
      uncertain: !!b.uncertain,
      leftSep: b.left,
      rightSep: b.right,
      corners,
      cornerOrder: order,
      note: b.note,
    });
  }

  // 3) 범례
  const ly = H - 158;
  parts.push(`<rect x="14" y="${ly}" width="1180" height="144" fill="#000000d0" rx="10"/>`);
  parts.push(`<text x="30" y="${ly + 36}" fill="#fff" font-size="29" font-weight="bold">${p.name}  OSD ${p.osdPtz}  ${meta.width}x${meta.height}  면 ${p.bays.length}개</text>`);
  parts.push(
    `<text x="30" y="${ly + 72}" fill="#00e676" font-size="22">━ 근변선</text><text x="180" y="${ly + 72}" fill="#ffea00" font-size="22">━ 원변선</text><text x="330" y="${ly + 72}" fill="#40c4ff" font-size="22">━ 칸막이</text><text x="470" y="${ly + 72}" fill="#fff" font-size="22">(점선 = 불확실)</text>`,
  );
  parts.push(
    `<text x="30" y="${ly + 106}" fill="#ff1744" font-size="22">● 관측(실선 사각형)</text><text x="360" y="${ly + 106}" fill="#ff9100" font-size="22">● 애매/가림(점선)</text><text x="680" y="${ly + 106}" fill="#7c4dff" font-size="22">● 화면 밖 교점</text>`,
  );
  parts.push(`<text x="30" y="${ly + 136}" fill="#bbb" font-size="20">채점 전용 R1 정답 — 검출 경로 미참조. 마스터 검수용.</text>`);

  const out = join(OUT_DIR, `truth_${p.name}.png`);
  await sharp(src)
    .composite([{ input: Buffer.from(`<svg width="${meta.width}" height="${meta.height}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`), top: 0, left: 0 }])
    .png()
    .toFile(out);
  console.log(`${p.name}: 면 ${p.bays.length} → ${out}`);

  truth.push({
    preset: p.name,
    sourceFile: p.file,
    imageWidth: meta.width,
    imageHeight: meta.height,
    osdPtz: p.osdPtz,
    osdNote: p.osdNote,
    sceneNote: p.sceneNote,
    lines: [p.near, p.far, ...p.seps].map((l) => ({
      id: l.id,
      kind: l.kind,
      a: { x: round5(l.a.x), y: round5(l.a.y) },
      b: { x: round5(l.b.x), y: round5(l.b.y) },
      uncertain: !!l.uncertain,
      evidence: l.evidence,
    })),
    bays: bayOut,
  });
}

if (mode !== 'lines') {
  for (const p of presets) copyFileSync(join(SRC_DIR, p.file), join(FIX_DIR, p.file));
  writeFileSync(
    join(FIX_DIR, 'truth.json'),
    JSON.stringify(
      {
        schema: 'parkagent.evPreset.truth/1',
        purpose: '실카 프리셋 5장의 주차면 정답(채점 전용 R1). 검출 경로는 절대 이 파일을 읽지 않는다.',
        author: '수동 라벨(육안 + 스캔라인/그라디언트 측정), 마스터 검수 대기',
        createdAt: '2026-07-30',
        coordinateSystem: '원본 이미지 픽셀 (좌상단 0,0 / x→우 / y→아래). 소수점 최대 5자리(round5).',
        cornerStatus: {
          observed: '모서리(또는 이를 만드는 두 경계선)가 화면에서 직접 확인됨',
          uncertain: '경계선 중 하나가 희미하거나 짧게만 보여 좌표 신뢰도가 낮음',
          offscreen: '두 경계선은 확인되나 교점이 이미지 밖',
          occluded: '차량/구조물에 가려 관측 불가 — 좌표 없음(null)',
        },
        presets: truth,
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`\ntruth.json + 원본 5장 복사 → ${FIX_DIR}`);
}
