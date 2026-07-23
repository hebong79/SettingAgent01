import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 수정 14 — **뷰어 PTZ 동기화 커버리지 봉인**.
 *
 * 배경: 서버 잡이 카메라를 움직여도 `state.ptz` 를 갱신하지 않으면, 방향/절대 이동이 낡은 기준으로 계산돼
 * **그전 위치로 되돌아갔다가 한 스텝 움직인다**(마스터 실측 증상). 수정 7 에서 4곳을 배선했으나
 * 이후 검증에서 **2곳(`/capture/detect`, 자동체인 `discovering`)이 더 발견**됐다.
 * 열거로는 또 빠진다 → **라우트 전수를 분류표로 코드에 고정**하고, 분류되지 않은 라우트가 등장하면 실패시킨다.
 *
 * 이 테스트는 app.js 를 실행하지 않는다(브라우저 전역 의존). **소스 정적 검사**로 커버리지만 봉인한다 —
 * 동작 자체가 아니라 "누락이 생기면 반드시 알아차린다"를 보장하는 것이 목적이다.
 */

const APP = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8');

/**
 * 카메라를 **실제로 움직이는** 라우트(서버 코드까지 따라가 판정).
 * 실카 기준: `snapshot(mode:'manual')` 또는 `move()` 에 도달하는 경로만 해당한다.
 */
const MOVES_CAMERA: Record<string, string> = {
  '/calibrate/point': 'PtzCalibrator(사다리/centerOnPlate/aimPointToCenter) → centerOnPoint·requestImage(ptz)',
  '/calibrate/ptz': '배치 센터라이징 calibrateSlot → requestImage(ptz)',
  '/discover/ptz': 'plateDiscovery → requestImage(presetPtz)',
  '/capture/start': 'CaptureJob → camera.move + requestImage(t.ptz)',
  '/capture/detect': 'detectPipeline:332 미귀속 차량마다 requestImage(확대 ptz) — ★복귀 없음',
  '/capture/start-precise': '정밀수집 파이프라인(discovering=앵커 loop LPD / calibrating=센터라이징) 발화',
  '/capture/pipeline': '자동체인(discovering=앵커 loop LPD / calibrating=센터라이징)',
  '/move': '수동 PTZ 이동',
};

/**
 * 카메라를 움직이지 **않는** 라우트와 그 근거. 새 라우트가 생기면 여기에 분류돼야 한다.
 * `requestImage(cam, preset)` 처럼 **ptz 인자가 없는** 호출은 `mode:'preset'` 이라 실카에서 move 가 일어나지 않는다.
 */
const NO_MOVE: Record<string, string> = {
  '/calibrate/frame': '진행 프레임 조회(GET)',
  '/calibrate/result': '산출물 조회',
  '/calibrate/status': '상태 조회',
  '/camera/login': '자격증명',
  '/camerapos': '파일 IO',
  '/cameras${state.source': '목록 조회',
  '/capture/autocorrect': 'requestImage(cam,preset) — ptz 미지정 → mode preset(실카 move 없음)',
  '/capture/finalize': '순수 계산·DB',
  '/capture/frame': '프레임 조회',
  '/capture/ground-model': '순수 계산',
  '/capture/job-cuboids': '조회',
  '/capture/occupancy': '조회·계산',
  '/capture/place-roi': '파일 IO',
  '/capture/refframe': 'requestImage(cam,preset) — ptz 미지정 → mode preset',
  '/capture/slots': '조회',
  '/capture/slots/lpd': '조회',
  '/capture/slots/occupy': 'DB(lpd→occupy_range 재생성)',
  '/capture/setup-result': '파일 IO(DB→setup_result.json)',
  '/capture/saves/setup_result': '저장본 조회(GET setup_result.json — Touring 순회 입력)', // 파일 읽기만; 카메라 미이동

  '/capture/slots/reset': 'DB',
  '/capture/slots/load-roi': 'DB', // PtzCamRoi.json → slot_setup 재구성(파일·DB 만; 카메라 미이동)
  '/capture/slots/cuboid': 'DB', // 지면모델 → slot3d_front_center 산출·저장(순수 계산·DB 만; 카메라 미이동)
  '/capture/status': '상태 조회',
  '/capture/stop': '잡 중지 신호(이동 없음)',
  '/capture/vehicle-cuboids': 'requestImage(cam,preset) — ptz 미지정 → mode preset',
  '/db/table/${encodeURIComponent': 'DB 조회',
  '/db/tables': 'DB 조회',
  '/discover/frame': '프레임 조회',
  '/discover/result': '산출물 조회',
  '/discover/status': '상태 조회',
  '/health': '헬스',
  '/llm/models': '조회',
  '/llm/select': '설정',
  '/mapping': '파일 IO',
  '/ptz': '읽기 전용 PTZ 조회(동기화 자체가 쓰는 경로)',
  '/rpc': 'Unity RPC 패스스루',
  '/rpc/catalog': '카탈로그 조회',
  '/settings': '설정 조회',
  '/snapshot': 'state.ptz override 렌더 — UI 가 이미 아는 위치',
};

/** app.js 가 fetch 하는 모든 라우트 경로. */
function fetchedRoutes(): string[] {
  const re = /fetch\((?:api\()?[`'"](\/[a-zA-Z0-9/_?=&{}$.-]+)/g;
  const out = new Set<string>();
  for (const m of APP.matchAll(re)) out.add(m[1]!.split('?')[0]!);
  return [...out].sort();
}

/** 최상위 함수 본문 추출(중괄호 균형). */
function functionBody(name: string): string {
  const i = APP.indexOf(`function ${name}(`);
  expect(i, `함수 ${name} 를 찾지 못했다`).toBeGreaterThan(-1);
  let depth = 0;
  let start = -1;
  for (let j = i; j < APP.length; j++) {
    const c = APP[j];
    if (c === '{') {
      if (depth === 0) start = j;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) return APP.slice(start, j + 1);
    }
  }
  throw new Error(`함수 ${name} 본문 파싱 실패`);
}

describe('수정 14 — 뷰어 PTZ 동기화 커버리지', () => {
  it('app.js 가 부르는 모든 라우트는 이동 여부가 분류돼 있다(새 라우트는 분류를 강제한다)', () => {
    const unclassified = fetchedRoutes().filter((r) => !(r in MOVES_CAMERA) && !(r in NO_MOVE));
    // 실패 시 메시지가 곧 할 일이다: 이 라우트가 카메라를 움직이는지 서버 코드로 판정해 표에 넣어라.
    expect(unclassified, `미분류 라우트 발견 — MOVES_CAMERA/NO_MOVE 중 하나로 분류할 것: ${unclassified.join(', ')}`).toEqual([]);
  });

  it('이동 라우트 목록이 줄어들지 않았다(배선 대상이 조용히 사라지지 않게)', () => {
    for (const route of Object.keys(MOVES_CAMERA)) {
      expect(APP.includes(route), `${route} 가 app.js 에서 사라졌다 — 표를 갱신할 것`).toBe(true);
    }
  });

  /**
   * 이동 라우트별 **동기화 책임 지점**. 폴링 잡은 완료 전이를 감지하는 폴러가, 동기 잡은 자기 함수가 책임진다.
   * `/move` 는 UI 가 목표를 직접 알고 있어 movePtz 가 state.ptz 를 직접 갱신한다(별도 동기화 불요).
   */
  const SYNC_OWNER: Record<string, string> = {
    '/calibrate/point': 'calPointCenter',
    '/calibrate/ptz': 'calPoll',
    '/discover/ptz': 'discPoll',
    '/capture/start': 'capPoll',
    '/capture/detect': 'runLiveDetect',
    '/capture/pipeline': 'pollPipeline',
  };

  it.each(Object.entries(SYNC_OWNER))('%s → %s 가 syncPtzAfterJob 을 호출한다', (_route, owner) => {
    expect(functionBody(owner)).toContain('syncPtzAfterJob');
  });

  it('/move 는 move() 가 state.ptz 를 직접 갱신한다(동기화 불요의 근거를 고정)', () => {
    // 수동 이동은 UI 가 목표 PTZ 를 스스로 알고 있으므로 잡 동기화가 필요 없다.
    // 대신 이 갱신이 사라지면 같은 부패가 생기므로 여기서 고정한다(실카는 이동 후 실측 재조회까지 한다).
    const body = functionBody('move');
    expect(body).toContain('state.ptz = ptz');
    expect(body).toContain('updatePtzDisplay');
    expect(body).toContain('refreshCurrentPtz');
  });

  it('runLiveDetect 는 **실패 경로에서도** 동기화한다(이미 움직인 뒤일 수 있다)', () => {
    const body = functionBody('runLiveDetect');
    // 성공 분기에만 걸면 res.ok=false 에서 같은 버그가 남는다.
    const failIdx = body.indexOf('if (!res.ok)');
    expect(failIdx).toBeGreaterThan(-1);
    expect(body.slice(failIdx, failIdx + 200)).toContain('syncPtzAfterJob');
  });

  it('실카는 명령값이 아니라 장비 실측을 읽는다(syncPtzAfterJob 분기 고정)', () => {
    const body = functionBody('syncPtzAfterJob');
    expect(body).toContain('selectedSourceIsReal()');
    expect(body).toContain('refreshCurrentPtz');
    expect(body).toContain('updatePtzDisplay');
  });
});
