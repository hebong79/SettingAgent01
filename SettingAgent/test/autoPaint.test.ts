import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// 순수 ESM(브라우저 API 미참조) 직접 import — 도색선 자동검출 응답 → 그릴 목록·요약 변환.
import {
  autoPaintViews,
  autoPaintViewFor,
  formatIoU,
  autoQuadItems,
  slotScoreItems,
  passCount,
  autoPaintSummary,
  autoPaintSummaryText,
  autoPaintIssues,
} from '../web/autoPaint.js';

/**
 * 16회차 — 뷰어 「도색선 자동검출」 UI 배선.
 *
 * 봉인하는 것 2가지:
 *  (a) `roi.auto.detect` / `roi.auto.score` 두 응답 형태가 **한 모양으로** 접히고, 좌표·IoU·frameHash 가
 *      서버 값 그대로 전달된다(뷰어가 재계산·귀속 추정을 하지 않는다).
 *  (b) 신규 토글 `#roi-autopaint` 가 off 면 기존 렌더 경로가 **한 줄도 실행되지 않는다**(회귀 0).
 */

const Q = (n: number) => [
  { x: 0.1 * n, y: 0.8 },
  { x: 0.1 * n, y: 0.6 },
  { x: 0.1 * n + 0.08, y: 0.6 },
  { x: 0.1 * n + 0.08, y: 0.8 },
];

/** roi.auto.detect 응답(프리셋 1건). detectView 그대로. */
const DETECT = {
  presets: [
    {
      key: '1:1',
      camId: 1,
      presetIdx: 1,
      frameHash: 'a1b2c3d4e5f6',
      quads: [
        { latticeIndex: 0, quadNorm: Q(1) },
        { latticeIndex: 1, quadNorm: Q(2) },
      ],
      issues: ['지상고 자가보정: 5.000 → 4.973m'],
    },
  ],
  holdout: '검출·기하 모듈은 주차면 좌표를 입력으로 받지 않는다(카메라 제원 + 베이 개수만)',
};

/** roi.auto.score 응답(프리셋 1건). PresetScore 바깥 + detect 중첩. */
const SCORE = {
  presets: [
    {
      key: '1:1',
      camId: 1,
      presetIdx: 1,
      autoQuads: 2,
      manualSlots: 3,
      graded: true,
      gradeReason: null,
      meanIoU: 0.9712,
      minIoU: 0.9,
      pass98: 1,
      slots: [
        { slotIdx: 3, iouVsManual: 0.9834, paintDevPx: 1.2, matched: true, degrade: null },
        { slotIdx: 4, iouVsManual: 0.9611, paintDevPx: 3.4, matched: true, degrade: 'D10_ANCHOR_DEFECT' },
        { slotIdx: 24, iouVsManual: 0, paintDevPx: null, matched: false, degrade: 'D9_SLOT24' },
      ],
      issues: ['slot24: 파일↔DB 소속 불일치 미해소', '지상고 자가보정: 5.000 → 4.973m'],
      detect: DETECT.presets[0],
    },
  ],
  summary: { gradedPresets: 1, gradedSlots: 2, pass98: 1, meanIoU: 0.97225, minIoU: 0.9611 },
};

describe('응답 정규화 — detect/score 두 형태를 한 모양으로 접는다', () => {
  it('detect 응답: presets[i] 자체가 검출 뷰이며 scored=false', () => {
    const [v] = autoPaintViews(DETECT);
    expect(v.key).toBe('1:1');
    expect(v.camId).toBe(1);
    expect(v.presetIdx).toBe(1);
    expect(v.frameHash).toBe('a1b2c3d4e5f6');
    expect(v.quads).toHaveLength(2);
    expect(v.scored).toBe(false);
    expect(v.slots).toEqual([]); // 검출만 했으면 면별 점수가 없다.
  });

  it('score 응답: presets[i].detect 가 검출 뷰이고 바깥이 채점 결과', () => {
    const [v] = autoPaintViews(SCORE);
    expect(v.scored).toBe(true);
    expect(v.graded).toBe(true);
    expect(v.frameHash).toBe('a1b2c3d4e5f6'); // 좌표·해시는 중첩된 detect 에서 온다.
    expect(v.quads).toHaveLength(2);
    expect(v.slots).toHaveLength(3);
    expect(v.meanIoU).toBe(0.9712);
  });

  it('score 의 issues 는 검출 issues 를 포함한 쪽(바깥)을 쓴다', () => {
    const [v] = autoPaintViews(SCORE);
    expect(v.issues).toHaveLength(2);
    expect(v.issues).toContain('지상고 자가보정: 5.000 → 4.973m');
  });

  it('빈/누락 응답에도 throw 하지 않는다(빈 배열)', () => {
    expect(autoPaintViews(null)).toEqual([]);
    expect(autoPaintViews({})).toEqual([]);
    expect(autoPaintViews({ presets: [null, undefined] })).toEqual([]);
  });

  it('autoPaintViewFor 는 현재 프레임 키만 돌려준다(다른 프리셋이면 null → 렌더 skip)', () => {
    expect(autoPaintViewFor(DETECT, '1:1')?.key).toBe('1:1');
    expect(autoPaintViewFor(DETECT, '1:2')).toBeNull();
    expect(autoPaintViewFor(DETECT, '2:1')).toBeNull();
  });
});

describe('그릴 목록 — 좌표는 서버 값 그대로, 라벨은 규약대로', () => {
  it('자동 quad 는 좌표 무변형 + 라벨 = 격자 인덱스', () => {
    const items = autoQuadItems(autoPaintViews(DETECT)[0]);
    expect(items.map((i) => i.label)).toEqual(['#0', '#1']);
    expect(items[0].quadNorm).toBe(DETECT.presets[0].quads[0].quadNorm); // 복사·재계산 없음.
  });

  it('4점이 아닌 quad 는 그리지 않는다(퇴화 방어)', () => {
    const view = autoPaintViews({ presets: [{ key: '1:1', camId: 1, presetIdx: 1, quads: [{ latticeIndex: 0, quadNorm: [{ x: 0, y: 0 }] }] }] })[0];
    expect(autoQuadItems(view)).toEqual([]);
  });

  it('검출만 했으면 면별 점수 라벨이 0건이다(= 라벨은 인덱스뿐)', () => {
    expect(slotScoreItems(autoPaintViews(DETECT)[0])).toEqual([]);
  });

  it('채점했으면 면별 IoU 라벨이 나온다(`IoU 0.983` 형식)', () => {
    const items = slotScoreItems(autoPaintViews(SCORE)[0]);
    expect(items.map((i) => i.label)).toEqual([
      's3 IoU 0.983',
      's4 IoU 0.961 D10_ANCHOR_DEFECT',
      's24 IoU 0.000 D9_SLOT24',
    ]);
    expect(items[0].slotIdx).toBe(3);
    expect(items[0].iou).toBe(0.9834); // 라벨은 3자리지만 원값은 보존한다.
  });

  it('formatIoU: 수치 아니면 0 으로 위장하지 않는다', () => {
    expect(formatIoU(0.97123)).toBe('IoU 0.971');
    expect(formatIoU(1)).toBe('IoU 1.000');
    expect(formatIoU(null)).toBe('IoU —');
    expect(formatIoU(undefined)).toBe('IoU —');
    expect(formatIoU(Number.NaN)).toBe('IoU —');
  });

  // ★ 실측 회귀(1:1 라이브 채점): 0.9784 를 2자리로 자르면 `0.98` 이 되어 같은 화면의 `≥0.98 0면` 과 모순된다.
  it('판정 경계(0.98) 바로 아래 값이 0.98 로 보이지 않는다', () => {
    expect(formatIoU(0.9784)).toBe('IoU 0.978');
    expect(formatIoU(0.9793)).toBe('IoU 0.979');
  });

  it('null/undefined 뷰에도 빈 배열(렌더 조기 return 과 짝)', () => {
    expect(autoQuadItems(null)).toEqual([]);
    expect(slotScoreItems(undefined)).toEqual([]);
  });
});

describe('요약 — ≥0.95 면수·frameHash·검출 면수', () => {
  it('≥0.95 면수는 구조적 강등(D9_SLOT24)을 제외하고 센다(서버 summarize 와 같은 필터)', () => {
    expect(passCount(SCORE, 0.95)).toBe(2); // 0.9834 · 0.9611 통과, slot24 는 집계 제외.
    expect(passCount(SCORE, 0.98)).toBe(1);
    expect(passCount(SCORE, 0.99)).toBe(0);
  });

  it('미채점(graded:false) 프리셋은 통과 집계에서 제외한다("제외 = 통과" 아님)', () => {
    const ungraded = { presets: [{ ...SCORE.presets[0], graded: false }], summary: SCORE.summary };
    expect(passCount(ungraded, 0.95)).toBe(0);
  });

  it('평균·최소·≥0.98 은 서버 summary 를 그대로 옮긴다(뷰어 재계산 없음)', () => {
    const s = autoPaintSummary(SCORE);
    expect(s.meanIoU).toBe(SCORE.summary.meanIoU);
    expect(s.minIoU).toBe(SCORE.summary.minIoU);
    expect(s.pass98).toBe(SCORE.summary.pass98);
    expect(s.gradedSlots).toBe(SCORE.summary.gradedSlots);
    expect(s.pass95).toBe(2);
    expect(s.quadCount).toBe(2);
    expect(s.frameHashes).toEqual(['a1b2c3d4e5f6']);
    expect(s.scored).toBe(true);
  });

  it('검출 요약에는 frameHash·검출 면수가 반드시 들어간다(F13 — 해시 없는 IoU 는 해석 불가)', () => {
    const t = autoPaintSummaryText(DETECT);
    expect(t).toContain('frameHash a1b2c3d4e5f6');
    expect(t).toContain('검출 2면');
    expect(t).toContain('1:1');
    expect(t).not.toContain('평균 IoU'); // 채점 안 했으면 IoU 를 지어내지 않는다.
  });

  it('채점 요약에는 평균 IoU·≥0.95 면수·frameHash 가 전부 들어간다', () => {
    const t = autoPaintSummaryText(SCORE);
    expect(t).toContain('평균 IoU 0.9722');
    expect(t).toContain('≥0.95 2/2면');
    expect(t).toContain('≥0.98 1면');
    expect(t).toContain('frameHash a1b2c3d4e5f6');
    expect(t).toContain('검출 2면');
  });

  it('frameHash 가 없어도 자리를 비우지 않는다(`-` 로 표기)', () => {
    const noHash = { presets: [{ key: '1:1', camId: 1, presetIdx: 1, quads: [] }] };
    expect(autoPaintSummaryText(noHash)).toContain('frameHash -');
  });

  it('issues 는 프리셋별로 묶이고 빈 프리셋은 빠진다', () => {
    expect(autoPaintIssues(DETECT)).toEqual([{ key: '1:1', issues: ['지상고 자가보정: 5.000 → 4.973m'] }]);
    expect(autoPaintIssues({ presets: [{ key: '1:1', camId: 1, presetIdx: 1, quads: [], issues: [] }] })).toEqual([]);
    expect(autoPaintIssues(null)).toEqual([]);
  });
});

// ── 정적 회귀 가드(DOM/렌더 계층 — 순수함수로 못 잡아 소스/HTML 텍스트로 봉인) ──
const appPath = fileURLToPath(new URL('../web/app.js', import.meta.url));
const htmlPath = fileURLToPath(new URL('../web/index.html', import.meta.url));
const app = readFileSync(appPath, 'utf-8');
const html = readFileSync(htmlPath, 'utf-8');

function functionBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `${name} 함수 존재`).toBeGreaterThan(-1);
  const braceOpen = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(braceOpen + 1, i);
    }
  }
  throw new Error(`${name} 본문 파싱 실패`);
}

describe('회귀 0 — #roi-autopaint off 면 기존 렌더와 픽셀 동일', () => {
  it('토글은 index.html 에서 기본 off(checked 없음)', () => {
    const tag = html.match(/<input[^>]*id="roi-autopaint"[^>]*>/)?.[0];
    expect(tag).toBeTruthy();
    expect(tag).not.toMatch(/\bchecked\b/);
  });

  it('drawAutoPaint 의 첫 문장이 토글·데이터 조기 return 이다(off 면 캔버스에 아무것도 안 그린다)', () => {
    const body = functionBody(app, 'drawAutoPaint').trim();
    expect(body.split('\n')[0].trim()).toBe("if (!$('roi-autopaint')?.checked || !state.autoPaint) return;");
  });

  it('drawAutoPaint 는 자신의 레이어만 그린다(기존 레이어 함수를 부르지 않는다)', () => {
    const body = functionBody(app, 'drawAutoPaint');
    for (const fn of ['drawFileFloorRoi', 'drawAutoRoi', 'drawDetectOverlay', 'drawOccupancyOverlay', 'drawCuboidOverlay']) {
      expect(body).not.toContain(fn);
    }
    expect(body).toContain('ctx.save()');
    expect(body).toContain('ctx.restore()');
  });

  it('drawRoiOverlay 체인에서 drawAutoPaint 는 기존 drawAutoRoi **뒤**에 가산으로 붙는다', () => {
    const body = functionBody(app, 'drawRoiOverlay');
    expect(body).toContain('drawAutoPaint(ctx);');
    expect(body.indexOf('drawAutoRoi(ctx);')).toBeLessThan(body.indexOf('drawAutoPaint(ctx);'));
  });

  it('색은 시안 — 기존 레이어 색(파일 초록·격자 주황·육면체 보라)과 충돌하지 않는다', () => {
    const body = functionBody(app, 'drawAutoPaint');
    expect(body).toContain('#00e5ff');
    for (const c of ['#39ff14', '#ff9f1c', '#b47cff']) expect(body).not.toContain(c);
  });
});

describe('RPC 배선 — 셋팅 자체 평면(/rpc), Unity 프록시(callRpc) 무변경', () => {
  it('settingRpc 는 루트 /rpc 로 JSON-RPC 2.0 을 보낸다', () => {
    const body = functionBody(app, 'settingRpc');
    expect(body).toContain("mutFetch('/rpc'"); // 변이 fetch 규약(token.js) 준수.
    expect(body).toContain("jsonrpc: '2.0'");
    expect(body).toContain('method,');
  });

  it('기존 callRpc 는 여전히 Unity 프록시 경로(api(\'/rpc\'))다', () => {
    expect(functionBody(app, 'callRpc')).toContain("mutFetch(api('/rpc')");
  });

  it('consensus 는 항상 명시 전송한다(서버 스키마 기본이 true — 체크 해제가 무시되면 안 된다)', () => {
    const body = functionBody(app, 'apRun');
    expect(body).toContain("const consensus = Boolean($('ap-consensus')?.checked);");
    expect(body).toContain('consensus,');
  });

  it('검출 성공 시 토글을 자동 체크한다(ggPreview 규약)', () => {
    expect(functionBody(app, 'apRun')).toContain("$('roi-autopaint').checked = true;");
  });

  it('진행 중에는 두 버튼이 잠기고 finally 에서 반드시 풀린다', () => {
    const body = functionBody(app, 'apRun');
    expect(body).toContain('b.disabled = true');
    expect(body).toMatch(/finally \{[\s\S]*b\.disabled = false/);
    /**
     * 주기 표시는 **반드시 있어야 한다** — 최대 70초(다시점 합의 실측 68759ms)라 경과 표시가 없으면 멈춘 줄 안다.
     * ★ 21회차 — 주기를 1000 → **250ms** 로 좁혔다(진행바 추가). **화면 문구는 그대로다**(`elapsed()` 가
     *   초 단위로 반올림하므로 텍스트는 여전히 1초에 한 번만 바뀐다). 좁힌 이유는 막대가 1초 단위로
     *   튀면 "멈춘 것"으로 보이기 때문이며, 타이머는 **하나를 유지**했다(수명 관리 중복 금지).
     */
    expect(body).toMatch(/setInterval\(tick, 250\)/);
    expect(body).toContain('renderApProgress(');
    expect(body).toContain('clearInterval(apTimer)');
  });
});

describe('파괴적 동작 미배선 — roi.auto.apply 는 UI 에 없다', () => {
  // 봉인 대상은 **호출**이다. RPC 메서드는 반드시 따옴표 문자열로 넘어가므로 인용부호까지 포함해 막는다
  // (설명 주석에는 이름이 등장한다 — 그것까지 막으면 "왜 없는지"를 코드에 적을 수 없다).
  it('app.js 에 roi.auto.apply 호출이 0건', () => {
    expect(app).not.toContain("'roi.auto.apply'");
    expect(app).not.toContain('"roi.auto.apply"');
  });

  it('index.html 에 apply 버튼·엘리먼트가 없다', () => {
    expect(html).not.toContain('ap-apply');
    expect(html).not.toMatch(/<button[^>]*id="ap-[^"]*apply/);
  });

  it('패널이 부르는 메서드는 detect·score 둘뿐이다', () => {
    const body = functionBody(app, 'apRun');
    expect(body).toContain("'roi.auto.score'");
    expect(body).toContain("'roi.auto.detect'");
  });
});

describe('신규 엘리먼트 결선(고아 방지)', () => {
  const IDS = ['roi-autopaint', 'ap-target', 'ap-detect', 'ap-score', 'ap-consensus', 'ap-msg', 'ap-issues-box', 'ap-issues'];

  it('8개 id 가 index.html 에 전부 존재한다', () => {
    for (const id of IDS) expect(html, id).toContain(`id="${id}"`);
  });

  it('8개 id 가 app.js 에서 전부 참조된다', () => {
    for (const id of IDS) expect(app, id).toContain(`'${id}'`);
  });

  it('버튼 2개가 apRun 에 결선돼 있다', () => {
    expect(app).toContain("$('ap-detect').addEventListener('click', () => apRun('detect'));");
    expect(app).toContain("$('ap-score').addEventListener('click', () => apRun('score'));");
  });

  it('다시점 합의 툴팁에 소요시간이 명시돼 있다(off ≈ 12초 / on ≈ 70초)', () => {
    const label = html.match(/<label[^>]*>\s*<input id="ap-consensus"[^>]*>/)?.[0] ?? '';
    expect(label).toContain('12초');
    expect(label).toContain('70초');
  });
});

// ── 20회차 — 「현재 화면 그대로」 응답(rows·view·ptzUsed) ────────────────────
//
// 「리스트」 단계는 대표 행(`quads`) 하나가 아니라 **보이는 행 전체**다. 다만 `rows` 는 대표 행을
// 항상 포함하지는 않으므로(19회차 진입 문턱에 걸려 빌 수 있다) 대체가 아니라 **합집합**이다.

/** roi.auto.detect{view:"current"} 응답(현재뷰 1건). */
const CURRENT = {
  usedSource: { id: 'simulator-1', kind: 'rpc', requested: 'simulator-1' },
  presets: [
    {
      key: '1:current',
      camId: 1,
      presetIdx: 1,
      view: 'current',
      frameHash: 'd4503635ef08',
      ptzUsed: { pan: 19.8, tilt: 8.7, zoom: 1.69341 },
      intrinsics: { source: 'current-view(...)', focalPx: 2932.79, fBasePx: 1731.8853, fovAtZoom: 'zoom1' },
      quads: [{ latticeIndex: 0, quadNorm: Q(1) }],
      rows: [
        {
          rowIndex: 0,
          paintScore: 1.23429,
          quads: [
            { candidateId: 'd4503635ef08#0.0', latticeIndex: 0, quadNorm: Q(1) }, // 대표 행과 같은 면 — 접힌다.
            { candidateId: 'd4503635ef08#0.1', latticeIndex: 1, quadNorm: Q(2) },
          ],
        },
        { rowIndex: 1, paintScore: 1.07738, quads: [{ candidateId: 'd4503635ef08#1.-1', latticeIndex: -1, quadNorm: Q(5) }] },
      ],
      issues: ['다시점 합의를 **무시**했다'],
    },
  ],
};

describe('T13 rows 합집합 — preset 응답은 종전 그대로', () => {
  it('rows 없는 뷰(preset 응답)는 목록·순서·라벨이 종전과 완전히 같다', () => {
    expect(autoQuadItems(autoPaintViews(DETECT)[0])).toEqual([
      { quadNorm: Q(1), label: '#0' },
      { quadNorm: Q(2), label: '#1' },
    ]);
    expect(autoPaintViews(DETECT)[0].rows).toEqual([]);
    expect(autoPaintViews(DETECT)[0].view).toBeNull();
  });

  it('rows 있는 뷰는 대표 행 ∪ 모든 행 — 같은 좌표는 두 번 그리지 않는다', () => {
    const view = autoPaintViews(CURRENT)[0];
    expect(view.view).toBe('current');
    expect(view.ptzUsed).toEqual({ pan: 19.8, tilt: 8.7, zoom: 1.69341 });
    expect(autoQuadItems(view)).toEqual([
      { quadNorm: Q(1), label: '#0' },        // 대표 행(종전 라벨 규약 유지)
      { quadNorm: Q(2), label: 'r0#1' },      // 0행의 나머지
      { quadNorm: Q(5), label: 'r1#-1' },     // 1행
    ]);
  });

  it('현재뷰는 프리셋 키를 갖지 않는다 — 같은 카메라의 어느 프리셋 화면에서도 그린다', () => {
    expect(autoPaintViewFor(CURRENT, '1:current')?.key).toBe('1:current');
    expect(autoPaintViewFor(CURRENT, '1:2')?.key).toBe('1:current'); // 카메라가 같으면 그린다.
    expect(autoPaintViewFor(CURRENT, '2:1')).toBeNull();             // 다른 카메라는 안 그린다.
    expect(autoPaintViewFor(DETECT, '1:2')).toBeNull();              // preset 응답의 게이트는 종전 그대로.
  });
});

describe('20회차 UI 결선 — 「현재 화면 그대로」 체크박스와 기준화각 라벨', () => {
  it('체크박스가 index.html 에 있고 **기본 체크**돼 있다(사용자가 보는 기본 = 신규 모드)', () => {
    const label = html.match(/<label[^>]*>\s*<input id="ap-currentview"[^>]*>/)?.[0] ?? '';
    expect(label).toContain('checked');
    expect(label).toContain('이동');
  });

  it('app.js 가 view 를 **항상 명시 전송**한다(와이어 기본은 preset 이므로)', () => {
    expect(app).toContain("view: currentView ? 'current' : 'preset',");
    expect(app).toContain("$('ap-currentview')?.checked");
  });

  it('화각 칸은 시뮬 → baseHfovDeg / 실카 → hfovDeg 로 갈라 보낸다(서버 재해석 금지)', () => {
    expect(app).toContain('if (selectedSourceIsReal()) spec.hfovDeg = hfovDeg;');
    expect(app).toContain('else spec.baseHfovDeg = hfovDeg;');
    expect(html).toContain('id="ap-hfov-label"');
  });
});
