import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { toPixelQuad } from '../web/core.js';
import { rectToQuad } from '../src/domain/geometry.js';

/**
 * 검증자(qa-tester): W7 `drawDbCentering` — 센터라이징 완료 지점(노란 원) 오버레이 (설계서 §11.1 U9).
 *
 * 이 함수는 `web/app.js` 안의 DOM 렌더 함수라 import 할 수 없다. 그래서 **소스 텍스트를 복사하지 않고**
 * app.js 에서 함수 본문을 그대로 떼어 `new Function` 으로 실행한다(viewerDisplayReset.test.ts 의
 * functionBody 관용구 확장) — 검증 대상은 **실제 배포되는 바이트**다. 의존성(toPixelQuad·overlay)은
 * 주입하고, ctx 는 arc/stroke 호출을 기록하는 스파이다.
 *
 * 봉인 계약(마스터 Q6): 원 중심 = `slot_setup.lpd` quad **bounding rect 중심**,
 * `!centered || !lpd` 행은 **스킵**(위장 표시 금지).
 */

const appPath = fileURLToPath(new URL('../web/app.js', import.meta.url));
const appSrc = readFileSync(appPath, 'utf-8');

/** app.js 에서 함수 선언 전문(중괄호 균형)을 추출. */
function functionSource(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `${name} 함수가 app.js 에 존재해야 함`).toBeGreaterThan(-1);
  const braceOpen = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name} 본문 파싱 실패`);
}

interface Arc { cx: number; cy: number; r: number }
interface CtxSpy { arcs: Arc[]; strokes: number; styles: string[]; ctx: unknown }

function makeCtx(): CtxSpy {
  const arcs: Arc[] = [];
  const styles: string[] = [];
  let strokes = 0;
  const ctx = {
    beginPath: () => {},
    arc: (cx: number, cy: number, r: number) => { arcs.push({ cx, cy, r }); },
    stroke: () => { strokes += 1; styles.push((ctx as { strokeStyle: string }).strokeStyle); },
    strokeStyle: '',
    lineWidth: 0,
  };
  return { arcs, styles, get strokes() { return strokes; }, ctx } as unknown as CtxSpy;
}

const SRC = functionSource(appSrc, 'drawDbCentering');
const OVERLAY = { width: 1920, height: 1080 };

/** 실제 app.js 소스를 주입 의존성과 함께 실행한다(복사본 아님). */
function runDrawDbCentering(rows: unknown[]): CtxSpy {
  const spy = makeCtx();
  const fn = new Function(
    'toPixelQuad', 'overlay', 'ctx', 'rows',
    `${SRC}\nreturn drawDbCentering(ctx, rows);`,
  );
  fn(toPixelQuad, OVERLAY, spy.ctx, rows);
  return spy;
}

const LPD = rectToQuad({ x: 0.4, y: 0.6, w: 0.08, h: 0.04 }); // 중심 (0.44, 0.62).

describe('U9. drawDbCentering — 중심 산출·스킵 규약', () => {
  it('centered:true + lpd 보유 → lpd bounding rect 중심에 원 1개', () => {
    const spy = runDrawDbCentering([{ centered: true, lpd: LPD }]);
    expect(spy.arcs).toHaveLength(1);
    expect(spy.arcs[0].cx).toBeCloseTo(0.44 * OVERLAY.width, 6);
    expect(spy.arcs[0].cy).toBeCloseTo(0.62 * OVERLAY.height, 6);
    expect(spy.arcs[0].r).toBe(5);
    expect(spy.strokes).toBe(1);
    // 파란 원 — 번호판 LPD(노랑 #ffd60a)와 색으로 구분한다(마스터 지시 2026-07-22: 노랑 → 파랑).
    expect(spy.styles[0]).toBe('#0a84ff');
  });

  it('★ centered=0(=false) 행은 스킵 — 센터링 안 된 슬롯을 완료로 위장하지 않는다', () => {
    const spy = runDrawDbCentering([{ centered: 0, lpd: LPD }]);
    expect(spy.arcs).toHaveLength(0);
    expect(spy.strokes).toBe(0);
  });

  it('★ lpd:null 행은 스킵 — 중심 산출 근거가 없으면 그리지 않는다', () => {
    const spy = runDrawDbCentering([{ centered: 1, lpd: null }]);
    expect(spy.arcs).toHaveLength(0);
  });

  it('혼합 배열 → 자격 있는 행 수만큼만 그린다(3행 중 1행)', () => {
    const spy = runDrawDbCentering([
      { centered: 1, lpd: LPD },
      { centered: 0, lpd: LPD },
      { centered: 1, lpd: null },
    ]);
    expect(spy.arcs).toHaveLength(1);
  });

  it('빈 배열 → 아무것도 그리지 않는다(throw 없음)', () => {
    const spy = runDrawDbCentering([]);
    expect(spy.arcs).toHaveLength(0);
  });

  it('회전된(비축정렬) quad 도 bounding rect 중심을 쓴다 — 꼭짓점 평균이 아니다', () => {
    // 사다리꼴: x 범위 [0.2,0.6] → cx 0.4, y 범위 [0.5,0.7] → cy 0.6.
    // 꼭짓점 평균 x 는 (0.2+0.6+0.55+0.25)/4 = 0.4 로 우연히 같지만, y 평균은 0.6 → 구분을 위해 비대칭 사용.
    const quad = [
      { x: 0.2, y: 0.5 }, { x: 0.6, y: 0.52 }, { x: 0.55, y: 0.7 }, { x: 0.25, y: 0.66 },
    ];
    const spy = runDrawDbCentering([{ centered: 1, lpd: quad }]);
    expect(spy.arcs[0].cx).toBeCloseTo(((0.2 + 0.6) / 2) * OVERLAY.width, 6);
    expect(spy.arcs[0].cy).toBeCloseTo(((0.5 + 0.7) / 2) * OVERLAY.height, 6);
  });
});

describe('U9. 배선 — drawDbCentering 은 DB 소스 오버레이 경로에서만 호출된다', () => {
  it('app.js 가 drawDbCentering 을 정의하고 호출한다', () => {
    expect(appSrc).toMatch(/function drawDbCentering\(/);
    expect(appSrc).toMatch(/drawDbCentering\(ctx, rows\)/);
  });

  it('토글·버튼 정리(요건12) — cap-autochain / cap-floorllm 체크박스가 index.html 에서 제거됐다', () => {
    const html = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf-8');
    expect(html).not.toMatch(/id="cap-autochain"/);
    expect(html).not.toMatch(/id="cap-floorllm"/);
    expect(html).toMatch(/id="cap-start"/); // 정밀수집 시작.
    expect(html).toMatch(/id="cap-capture-start"/); // 수집 시작(분리, Q8).
    expect(html).toMatch(/id="cap-finalize"/); // 최종화 보존(Q5 — 표시 전용화).
  });

  it('#cap-start → startPrecise, #cap-capture-start → capCaptureStart 로 배선', () => {
    expect(appSrc).toMatch(/\$\('cap-start'\)\.addEventListener\('click', startPrecise\)/);
    expect(appSrc).toMatch(/\$\('cap-capture-start'\)\.addEventListener\('click', capCaptureStart\)/);
  });
});
