// ★ 20회차 신규 — **현재 화면 그대로 검출**(`roi.auto.detect{view:"current"}`)의 임의 뷰 채점 도구.
//
// ══════════════════════════════════════════════════════════════════════════
// ★ 한계 고지(로그 첫 줄에도 박는다)
//   ① **시뮬 전용.** 분모(씬 진값)를 Unity `preset.list` 에서 얻는데 실카에는 그런 것이 없다(R10).
//   ② **정답과 검출이 f 오차를 공유한다.** 정답 투영에 쓰는 초점거리는 서비스가 검출에 쓴 바로 그 값
//      (`intrinsics.focalPx`)이다 — 완전 독립 채점이 아니다. 앵커 5점(프리셋 위치) 밖에서는
//      IoU 를 **절대치로 해석하지 마라**.
//   ③ **가림 보정 재현율은 측정하지 않는다.** 그 판정에는 프레임(도색 마스크)이 필요한데 이 도구는
//      서비스 응답만 본다. 미측정을 0 이나 추정으로 채우지 않는다.
// ══════════════════════════════════════════════════════════════════════════
//
// 왜 채점을 서비스가 아니라 도구에 두는가: `sceneTruth` 는 채점 전용 정적 봉인이고
// (`test/roiAutoHoldout.test.ts` 가 검출 모듈의 참조를 문자열로도 막는다), 검출과 채점이 한 파일에 있으면
// 그 경계가 사람 약속으로 강등된다. 그리고 도구가 **서비스 응답을 그대로** 채점하므로
// 도구↔서비스 괴리(11회차 U11: 도구가 구 경로를 렌더)가 원리적으로 불가능하다.
//
// 정본·DB 무접촉(읽기만). Unity 는 **읽기 메서드만** 쓴다(`cam.list`·`preset.list`).
//   ★ `roi.create2d` 를 부르지 마라 — 이름과 달리 **쓰기 메서드**이며 빌드 출력에 손상본을 기록한다(F17).
//   ★ 카메라도 움직이지 않는다 — 위치 이동이 필요하면 `roi.auto.detect{view:"preset"}` 로 서비스에 맡겨라.
//
// 사용: npx tsx src/tools/roiAutoCurrentView.ts <camId> <expectedBays> [rowMode] [source]
//   rowMode  rows(기본) | best
//   source   simulator-1(기본)

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { facesOfRow, projectTruth, visibleTruth, type ScenePresetSpec } from '../ground/sceneTruth.js';
import { scoreDetection, type TruthEntry } from '../ground/roiAutoRecall.js';
import { MATCH_MIN_IOU } from '../ground/autoRoiPlan.js';
import type { PixelQuad } from '../ground/types.js';

/** ★ 광학중심↔주차면 평면 거리 4.950m 의 표현(F6). `cam.list` 의 pos.y=5.0 은 트랜스폼 원점이다. */
const PLANE_Y_M = 0.05;
/** 가시 판정 면적 하한(px²) — `roiAutoRecall.ts` 와 같은 값(두 채점기의 분모를 갈라놓지 않는다). */
const MIN_AREA_PX = 200;
/** `f = f@zoom1 × zoom` 규칙이 실측 검산된 줌 구간(그 밖은 미측정). 상단은 float32 왕복분(1.8064301) 포함. */
const ZOOM_ANCHOR_RANGE: readonly [number, number] = [1.0, 1.80644];

const camId = Number(process.argv[2] ?? 1);
const expectedBays = Number(process.argv[3]);
const rowMode = (process.argv[4] ?? 'rows') as 'rows' | 'best';
const source = process.argv[5] ?? 'simulator-1';
if (!Number.isFinite(camId) || camId < 1) throw new Error(`camId: ${process.argv[2]}`);
if (!Number.isFinite(expectedBays) || expectedBays < 1) throw new Error(`expectedBays 필수(현재뷰에는 정본 면수가 없다): ${process.argv[3]}`);
if (rowMode !== 'rows' && rowMode !== 'best') throw new Error(`rowMode: ${rowMode}`);

let rpcId = 0;
async function rpc(url: string, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const j = (await r.json()) as any;
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
const unity = (m: string, p?: Record<string, unknown>) => rpc('http://localhost:13110/rpc', m, p);
const setting = (m: string, p?: Record<string, unknown>) => rpc('http://localhost:13020/rpc', m, p);

const SPEC_CACHE = '_workspace/18_scene_spec.json';
async function sceneSpecs(): Promise<ScenePresetSpec[]> {
  if (existsSync(SPEC_CACHE)) return JSON.parse(readFileSync(SPEC_CACHE, 'utf8')) as ScenePresetSpec[];
  const raw = (await unity('preset.list')) as Array<{
    idx: number; faceCount: number; offsetPos: { x: number; y: number; z: number };
    xSize: number; zSize: number; faceRot: number; groupRot: number;
  }>;
  const specs: ScenePresetSpec[] = raw.map((r) => ({
    idx: r.idx, faceCount: r.faceCount,
    offsetPos: [r.offsetPos.x, r.offsetPos.y, r.offsetPos.z],
    xSize: r.xSize, zSize: r.zSize, faceRot: r.faceRot, groupRot: r.groupRot,
  }));
  writeFileSync(SPEC_CACHE, JSON.stringify(specs, null, 2));
  return specs;
}

const specs = await sceneSpecs();
const faces = specs.flatMap((s) => facesOfRow(s, PLANE_Y_M) ?? []);

const cams = (await unity('cam.list')) as { cameras?: Array<{ camId: number; pos?: { x: number; y: number; z: number } }> };
const cam = cams.cameras?.find((c) => c.camId === camId);
if (!cam?.pos) throw new Error(`cam.list 에 cam${camId} 의 위치가 없다`);
const camPos: [number, number, number] = [cam.pos.x, cam.pos.y, cam.pos.z];

// ── 서비스가 실제로 낸 산출물을 받는다(검출 파이프라인을 재구현하지 않는다).
const res = (await setting('roi.auto.detect', { camId, view: 'current', source, expectedBays })) as any;
if (res.rejected) {
  console.log(`거부: ${res.gradeReason}\n  ${(res.missing ?? []).join('\n  ')}\n  ${res.note ?? ''}`);
  process.exit(1);
}
const d = res.presets?.[0];
if (!d) throw new Error('검출 응답에 presets 가 없다');
const { imgW, imgH, frameHash, ptzUsed } = d as { imgW: number; imgH: number; frameHash: string; ptzUsed: { pan: number; tilt: number; zoom: number } };
const focalPx = d.intrinsics?.focalPx as number | null;
if (focalPx == null) throw new Error(`검출이 지면모델을 세우지 못했다: ${(d.issues ?? []).join(' | ')}`);

// ★ 정답 투영의 화각은 **서비스가 검출에 쓴 초점거리 그대로**다(§한계 고지 ②).
const fovDeg = ((2 * Math.atan(imgW / 2 / focalPx)) * 180) / Math.PI;
const proj = projectTruth(faces, { camPos, panDeg: ptzUsed.pan, tiltDeg: ptzUsed.tilt, fovDeg, fovAxis: 'horizontal', imgW, imgH, planeYM: PLANE_Y_M });
const vis = visibleTruth(proj, imgW, imgH, MIN_AREA_PX);

/** 정규화 4점 → 픽셀 quad(서버 산출을 옮길 뿐 재계산하지 않는다). */
const toPx = (q: Array<{ x: number; y: number }>): PixelQuad =>
  q.map((p) => ({ x: p.x * imgW, y: p.y * imgH })) as unknown as PixelQuad;

/** rows 합집합 — 같은 면이 두 행에 겹쳐 나오지 않게 좌표 서명으로 접는다(정밀도 분모 부풀림 방지). */
function detectedQuads(): Array<{ quad: PixelQuad; label: string }> {
  const out: Array<{ quad: PixelQuad; label: string }> = [];
  const seen = new Set<string>();
  const push = (qn: Array<{ x: number; y: number }>, label: string) => {
    const sig = qn.map((p) => `${p.x.toFixed(5)},${p.y.toFixed(5)}`).join('|');
    if (seen.has(sig)) return;
    seen.add(sig);
    out.push({ quad: toPx(qn), label });
  };
  for (const q of d.quads ?? []) push(q.quadNorm, `best#${q.latticeIndex}`);
  if (rowMode === 'rows') for (const r of d.rows ?? []) for (const q of r.quads) push(q.quadNorm, q.candidateId);
  return out;
}
const det = detectedQuads();

// `detectable` 은 프레임(도색 마스크)이 있어야 판정된다 — 이 도구에는 프레임이 없다(§한계 고지 ③).
const truth: TruthEntry[] = vis.map((t) => ({ face: t.face, quad: t.quad, detectable: false }));
const sc = scoreDetection(det.map((x) => x.quad), truth, MATCH_MIN_IOU);
const extrapolated = ptzUsed.zoom < ZOOM_ANCHOR_RANGE[0] || ptzUsed.zoom > ZOOM_ANCHOR_RANGE[1];

console.log(
  '20회차 — 현재 화면 그대로 검출의 임의 뷰 채점\n' +
    '★ 시뮬 전용 · 정답과 검출이 f 오차를 공유(독립 채점 아님) · 가림보정 재현율은 미측정\n' +
    `씬 복원: ${specs.length}행 ${faces.length}면 · 가시 기준 면적 ≥ ${MIN_AREA_PX}px² · 매칭 IoU ≥ ${MATCH_MIN_IOU} · 평면 y=${PLANE_Y_M}m\n` +
    `\n=== cam${camId} 현재뷰 · rowMode=${rowMode} · expectedBays=${expectedBays}\n` +
    `    프레임 ${frameHash} · ptzUsed pan ${ptzUsed.pan} tilt ${ptzUsed.tilt} zoom ${ptzUsed.zoom}` +
    `${extrapolated ? `  ⚠ 줌 외삽(검산 구간 [${ZOOM_ANCHOR_RANGE[0]}, ${ZOOM_ANCHOR_RANGE[1]}] 밖 — f 정확도 미측정)` : ''}\n` +
    `    f ${focalPx.toFixed(3)}px (기준 f@zoom1 ${d.intrinsics?.fBasePx ?? '—'}px) → 유효 수평화각 ${fovDeg.toFixed(5)}°\n` +
    `    씬 가시 ${sc.truthTotal}면 · 산출 ${sc.detected}quad(best ${d.quads?.length ?? 0} · rows ${(d.rows ?? []).length}행 ${(d.rows ?? []).reduce((n: number, r: any) => n + r.quads.length, 0)}quad)\n` +
    `    재현율 ${sc.recall.toFixed(4)} (${sc.matched}/${sc.truthTotal}) · 정밀도 ${sc.precision.toFixed(4)} (${sc.matched}/${sc.detected})\n` +
    `    매칭 IoU 평균 ${sc.meanIoU?.toFixed(5) ?? '--'} · 최소 ${sc.minIoU?.toFixed(5) ?? '--'} · ≥0.95 ${sc.pass95}/${sc.matched} · ≥0.98 ${sc.pass98}/${sc.matched}\n` +
    `    매칭: ${sc.pairs.map((q) => `r${q.rowIdx}f${q.faceIdx}=${q.iou.toFixed(4)}`).join(' ') || '없음'}\n` +
    `    미검출: ${sc.missed.map((m) => `r${m.rowIdx}f${m.faceIdx}`).join(' ') || '없음'}\n` +
    `    오검출: ${sc.spurious.map((i) => det[i].label).join(' ') || '없음'}\n` +
    `    issues:\n${(d.issues ?? []).map((s: string) => `      - ${s}`).join('\n')}`,
);
