import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// 순수 ESM 모듈(브라우저 API 미참조) 직접 import.
import {
  toPixel,
  toPixelQuad,
  presetKey,
  slotLabel,
  clampZoom,
  stepPtz,
  resolveAbsPtz,
  createSnapshotFetcher,
  capFrameKey,
  moveRenderDirective,
  pickSelected,
  camerasChanged,
  upsertPreset,
  removePreset,
  nextPresetId,
} from '../web/core.js';

describe('toPixel (G2 — 0~1 × 표시크기 환산)', () => {
  it('정규화 ROI → 픽셀(전체)', () => {
    expect(toPixel({ x: 0, y: 0, w: 1, h: 1 }, 1920, 1080)).toEqual({ px: 0, py: 0, pw: 1920, ph: 1080 });
  });
  it('정규화 ROI → 픽셀(부분)', () => {
    expect(toPixel({ x: 0.5, y: 0.25, w: 0.1, h: 0.2 }, 800, 600)).toEqual({ px: 400, py: 150, pw: 80, ph: 120 });
  });
});

describe('toPixelQuad (floor ROI 폴리곤 픽셀 변환)', () => {
  it('정규화 4점 → 표시 픽셀 점 배열', () => {
    const quad: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }] = [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 0.8, y: 0.5 },
      { x: 0.2, y: 0.5 },
    ];
    expect(toPixelQuad(quad, 800, 600)).toEqual([
      { px: 0, py: 600 },
      { px: 800, py: 600 },
      { px: 640, py: 300 },
      { px: 160, py: 300 },
    ]);
  });
});

describe('presetKey', () => {
  it('cam:preset 결합', () => {
    expect(presetKey(1, 2)).toBe('1:2');
    expect(presetKey(3, 10)).toBe('3:10');
  });
});

describe('slotLabel (G3-4 라벨 매핑)', () => {
  const gi = [
    { slotId: 's-1', globalIdx: 5 },
    { slotId: 's-2', globalIdx: 6 },
  ];
  it('globalIndex 매칭 시 globalIdx 반환', () => {
    expect(slotLabel('s-2', gi)).toBe('6');
  });
  it('미매칭 시 slotId 폴백', () => {
    expect(slotLabel('s-99', gi)).toBe('s-99');
  });
  it('globalIndex 부재 시 slotId 폴백', () => {
    expect(slotLabel('s-1', undefined)).toBe('s-1');
  });
});

describe('clampZoom', () => {
  it('범위 클램프(1~36)', () => {
    expect(clampZoom(0)).toBe(1);
    expect(clampZoom(99)).toBe(36);
    expect(clampZoom(18)).toBe(18);
  });
});

describe('stepPtz', () => {
  const cur = { pan: 0, tilt: 0, zoom: 10 };
  it('left/right → pan ±step', () => {
    expect(stepPtz(cur, 'left', 5).pan).toBe(-5);
    expect(stepPtz(cur, 'right', 5).pan).toBe(5);
  });
  it('up/down → tilt ±step', () => {
    expect(stepPtz(cur, 'up', 3).tilt).toBe(3);
    expect(stepPtz(cur, 'down', 3).tilt).toBe(-3);
  });
  it('zoomIn/zoomOut → ±step 클램프(step 값 반영)', () => {
    expect(stepPtz({ ...cur, zoom: 36 }, 'zoomIn', 5).zoom).toBe(36); // 상한 클램프
    expect(stepPtz({ ...cur, zoom: 1 }, 'zoomOut', 5).zoom).toBe(1); // 하한 클램프
    expect(stepPtz(cur, 'zoomIn', 5).zoom).toBe(15); // 10 + step(5)
    expect(stepPtz(cur, 'zoomOut', 3).zoom).toBe(7); // 10 − step(3)
    expect(stepPtz(cur, 'zoomIn', 0.01).zoom).toBeCloseTo(10.01, 5); // 미세 step 반영
  });
  it('원본 불변(순수)', () => {
    const c = { pan: 1, tilt: 2, zoom: 3 };
    stepPtz(c, 'left', 5);
    expect(c).toEqual({ pan: 1, tilt: 2, zoom: 3 });
  });
});

describe('resolveAbsPtz (절대이동 입력 — 빈 칸=현재값 유지, 버그수정)', () => {
  const cur = { pan: 30, tilt: -10, zoom: 12 };
  it('세 칸 모두 채우면 그 값 사용(zoom 클램프)', () => {
    expect(resolveAbsPtz(cur, { pan: '45', tilt: '5', zoom: '20' })).toEqual({ pan: 45, tilt: 5, zoom: 20 });
    expect(resolveAbsPtz(cur, { pan: '0', tilt: '0', zoom: '99' })).toEqual({ pan: 0, tilt: 0, zoom: 36 });
  });
  it('zoom 만 채우면 pan/tilt 는 현재값 유지(핵심 회귀: 프레이밍 보존)', () => {
    expect(resolveAbsPtz(cur, { pan: '', tilt: '', zoom: '25' })).toEqual({ pan: 30, tilt: -10, zoom: 25 });
  });
  it('zoom 비우면 배율은 현재값 유지(1 로 리셋 안 함)', () => {
    expect(resolveAbsPtz(cur, { pan: '40', tilt: '', zoom: '' })).toEqual({ pan: 40, tilt: -10, zoom: 12 });
  });
  it('입력 0 은 유효값으로 반영(빈 칸과 구분)', () => {
    expect(resolveAbsPtz(cur, { pan: '0', tilt: '', zoom: '' }).pan).toBe(0);
  });
  it('비수치/공백 입력은 현재값 폴백', () => {
    expect(resolveAbsPtz(cur, { pan: 'abc', tilt: '  ', zoom: undefined })).toEqual(cur);
  });
  it('원본 불변(순수)', () => {
    const c = { pan: 1, tilt: 2, zoom: 3 };
    resolveAbsPtz(c, { pan: '9', tilt: '9', zoom: '9' });
    expect(c).toEqual({ pan: 1, tilt: 2, zoom: 3 });
  });
});

describe('capFrameKey (라이브 Unity 동기화 — 최신 캡처 프레임 유일 키)', () => {
  it('(a) 동일 (cam,preset,round) → 동일 문자열(직전 키와 === → 스킵 판정)', () => {
    expect(capFrameKey(1, 2, 3)).toBe('1:2:3');
    expect(capFrameKey(1, 2, 3)).toBe(capFrameKey(1, 2, 3));
    // 서버는 헤더를 String(...)으로 보내므로 문자열 입력도 같은 키여야 함(경계면 안정성)
    expect(capFrameKey('1', '2', '3')).toBe('1:2:3');
    expect(capFrameKey(1, 2, 3)).toBe(capFrameKey('1', '2', '3'));
  });

  it('(b-cam) cam 만 달라도 다른 문자열(스킵 안 함)', () => {
    expect(capFrameKey(1, 2, 3)).not.toBe(capFrameKey(9, 2, 3));
    expect(capFrameKey(9, 2, 3)).toBe('9:2:3');
  });

  it('(b-preset) preset 만 달라도 다른 문자열', () => {
    expect(capFrameKey(1, 2, 3)).not.toBe(capFrameKey(1, 9, 3));
    expect(capFrameKey(1, 9, 3)).toBe('1:9:3');
  });

  it('(b-round) round 만 달라도 다른 문자열(라운드 전환 → 새 프레임)', () => {
    expect(capFrameKey(1, 2, 3)).not.toBe(capFrameKey(1, 2, 4));
    expect(capFrameKey(1, 2, 4)).toBe('1:2:4');
  });

  it('(c) 세 인자 모두 null/undefined → null(식별 불가 → 스킵하지 않음)', () => {
    expect(capFrameKey(null, null, null)).toBeNull();
    expect(capFrameKey(undefined, undefined, undefined)).toBeNull();
    expect(capFrameKey(null, undefined, null)).toBeNull();
  });

  it('(d) 부분 null 조합은 빈 세그먼트로 키 생성(null 아님)', () => {
    expect(capFrameKey(1, null, 3)).toBe('1::3');
    expect(capFrameKey(null, 2, 3)).toBe(':2:3');
    expect(capFrameKey(1, 2, null)).toBe('1:2:');
    expect(capFrameKey(null, null, 3)).toBe('::3');
    // 부분 null 은 null 반환이 아니어야 한다(하나라도 값이 있으면 키 존재)
    expect(capFrameKey(1, null, undefined)).not.toBeNull();
    expect(capFrameKey(1, null, undefined)).toBe('1::');
  });

  it('부분 null 서로 다르면 다른 키(빈 세그먼트끼리 충돌 없음)', () => {
    expect(capFrameKey(1, null, 3)).not.toBe(capFrameKey(null, 1, 3));
    expect(capFrameKey(1, null, 3)).not.toBe(capFrameKey(1, null, 4));
  });
});

describe('moveRenderDirective (루프3 — /stream pan/tilt/zoom override: 이동 시 렌더 경로 결정)', () => {
  // 루프3: Unity /stream 이 pan/tilt/zoom override 를 지원 → 스트림 모드면 새 PTZ 로 재연결('stream-reconnect').
  // off 는 1회 스냅샷 tick. origin 무관(스트림이 수동·프리셋 PTZ 를 모두 렌더). 인자: moveRenderDirective(liveMode).

  it('(stream) → stream-reconnect (스트림 중 이동 → 새 PTZ 로 stream 재연결)', () => {
    expect(moveRenderDirective('stream')).toBe('stream-reconnect');
  });

  it('(off) → tick (라이브 off → 이동은 1회 스냅샷 override)', () => {
    expect(moveRenderDirective('off')).toBe('tick');
  });
});

describe('pickSelected (시뮬레이터 자동 갱신 — 이전 cam/preset 선택 유지, G3)', () => {
  // app.js 소비 경계: renderCamSelect → pickSelected(state.cam, state.cameras, 'camIdx'),
  // renderPresetSelect → pickSelected(state.preset, presets, 'presetIdx').
  // state.cam/state.preset 은 sel-cam/sel-preset 핸들러에서 Number(e.target.value) → 항상 숫자,
  // camIdx/presetIdx 도 숫자 → 순수함수의 strict === 비교와 타입 정합(경계면 확인).

  it('(a) 이전 선택이 목록에 존재 → 그대로 유지', () => {
    expect(pickSelected(3, [{ camIdx: 1 }, { camIdx: 3 }], 'camIdx')).toBe(3);
  });

  it('(b) 이전 선택이 삭제됨 → 첫 항목 폴백', () => {
    expect(pickSelected(9, [{ camIdx: 1 }, { camIdx: 2 }], 'camIdx')).toBe(1);
  });

  it('(c) 빈 목록 → null', () => {
    expect(pickSelected(1, [], 'camIdx')).toBeNull();
  });

  it('(d) prevId=null → 첫 항목(초기 로드)', () => {
    expect(pickSelected(null, [{ presetIdx: 2 }, { presetIdx: 5 }], 'presetIdx')).toBe(2);
  });

  it('(e) prevId=undefined → 첫 항목', () => {
    expect(pickSelected(undefined as unknown as null, [{ camIdx: 7 }], 'camIdx')).toBe(7);
  });

  it('(f) presetIdx 키 동작(존재 시 유지)', () => {
    expect(pickSelected(5, [{ presetIdx: 5 }, { presetIdx: 6 }], 'presetIdx')).toBe(5);
  });

  it('(g) key 생략 시 기본값 camIdx', () => {
    expect(pickSelected(2, [{ camIdx: 1 }, { camIdx: 2 }])).toBe(2);
    expect(pickSelected(99, [{ camIdx: 1 }])).toBe(1);
  });

  it('(h) list=null/undefined → null(방어적)', () => {
    expect(pickSelected(1, null as unknown as [], 'camIdx')).toBeNull();
    expect(pickSelected(1, undefined, 'camIdx')).toBeNull();
  });

  it('(i) 순수: 입력 목록을 변형하지 않음', () => {
    const list = [{ camIdx: 1 }, { camIdx: 2 }];
    const snapshot = JSON.parse(JSON.stringify(list));
    pickSelected(2, list, 'camIdx');
    expect(list).toEqual(snapshot);
  });

  it('(j) 경계: strict === (숫자 3 은 문자열 "3" 과 불일치 → 첫 항목 폴백)', () => {
    // app.js 는 항상 숫자를 넘기므로 실제 회귀는 아니지만, === 계약을 문서화한다.
    expect(pickSelected('3', [{ camIdx: 1 }, { camIdx: 3 }], 'camIdx')).toBe(1);
    expect(pickSelected(3, [{ camIdx: 1 }, { camIdx: 3 }], 'camIdx')).toBe(3);
  });
});

describe('camerasChanged (자동 갱신 — 카메라/프리셋 집합 변경 감지, 변경 시에만 재렌더)', () => {
  // app.js 소비 경계: loadCameras() 가 camerasChanged(state.cameras, next) === true 일 때만 renderCamSelect().
  // camIdx + 각 카메라 presetIdx 집합만 비교(라벨/PTZ 무시), 순서 무관 정규화(.sort()).
  const base = [
    { camIdx: 1, name: 'A', presets: [{ presetIdx: 1 }, { presetIdx: 2 }] },
    { camIdx: 2, name: 'B', presets: [{ presetIdx: 1 }] },
  ];

  it('(a) 동일 집합 → false(재렌더 안 함)', () => {
    const next = [
      { camIdx: 1, name: 'A', presets: [{ presetIdx: 1 }, { presetIdx: 2 }] },
      { camIdx: 2, name: 'B', presets: [{ presetIdx: 1 }] },
    ];
    expect(camerasChanged(base, next)).toBe(false);
  });

  it('(b) 프리셋 추가 → true', () => {
    const next = [
      { camIdx: 1, name: 'A', presets: [{ presetIdx: 1 }, { presetIdx: 2 }, { presetIdx: 3 }] },
      { camIdx: 2, name: 'B', presets: [{ presetIdx: 1 }] },
    ];
    expect(camerasChanged(base, next)).toBe(true);
  });

  it('(c) 프리셋 삭제 → true', () => {
    const next = [
      { camIdx: 1, name: 'A', presets: [{ presetIdx: 1 }] },
      { camIdx: 2, name: 'B', presets: [{ presetIdx: 1 }] },
    ];
    expect(camerasChanged(base, next)).toBe(true);
  });

  it('(d) 카메라 추가 → true', () => {
    const next = [
      ...base,
      { camIdx: 3, name: 'C', presets: [{ presetIdx: 1 }] },
    ];
    expect(camerasChanged(base, next)).toBe(true);
  });

  it('(e) 카메라 삭제 → true', () => {
    const next = [{ camIdx: 1, name: 'A', presets: [{ presetIdx: 1 }, { presetIdx: 2 }] }];
    expect(camerasChanged(base, next)).toBe(true);
  });

  it('(f) 라벨만 변경 → false(idx 집합 동일)', () => {
    const next = [
      { camIdx: 1, name: 'A-renamed', presets: [{ presetIdx: 1, label: '입구' }, { presetIdx: 2, label: '출구' }] },
      { camIdx: 2, name: 'B-renamed', presets: [{ presetIdx: 1, label: 'x' }] },
    ];
    expect(camerasChanged(base, next)).toBe(false);
  });

  it('(g) PTZ만 변경 → false(idx 집합 동일)', () => {
    const next = [
      { camIdx: 1, name: 'A', presets: [{ presetIdx: 1, pan: 10, tilt: 5, zoom: 2 }, { presetIdx: 2, pan: 99 }] },
      { camIdx: 2, name: 'B', presets: [{ presetIdx: 1, zoom: 36 }] },
    ];
    expect(camerasChanged(base, next)).toBe(false);
  });

  it('(h) 빈 ↔ 비어있지 않음 → true(양방향)', () => {
    expect(camerasChanged([], base)).toBe(true);
    expect(camerasChanged(base, [])).toBe(true);
  });

  it('(i) null/undefined ↔ [] → false(둘 다 빈 시그니처)', () => {
    expect(camerasChanged(null, [])).toBe(false);
    expect(camerasChanged(undefined, null)).toBe(false);
    expect(camerasChanged(null, null)).toBe(false);
  });

  it('(j) 카메라 순서 무관 동일 집합 → false(정규화 .sort())', () => {
    const reordered = [
      { camIdx: 2, name: 'B', presets: [{ presetIdx: 1 }] },
      { camIdx: 1, name: 'A', presets: [{ presetIdx: 2 }, { presetIdx: 1 }] },
    ];
    expect(camerasChanged(base, reordered)).toBe(false);
  });

  it('(k) 프리셋 순서 무관 동일 집합 → false(presetIdx sort)', () => {
    const next = [
      { camIdx: 1, name: 'A', presets: [{ presetIdx: 2 }, { presetIdx: 1 }] },
      { camIdx: 2, name: 'B', presets: [{ presetIdx: 1 }] },
    ];
    expect(camerasChanged(base, next)).toBe(false);
  });

  it('(l) presets 필드 부재도 방어적 처리(빈 프리셋으로 간주)', () => {
    const a = [{ camIdx: 1, name: 'A' }];
    const b = [{ camIdx: 1, name: 'A', presets: [] }];
    expect(camerasChanged(a as never, b as never)).toBe(false);
    const c = [{ camIdx: 1, name: 'A', presets: [{ presetIdx: 1 }] }];
    expect(camerasChanged(a as never, c as never)).toBe(true);
  });
});

describe('upsertPreset (camerapos 프리셋 추가/갱신 — 순수·불변)', () => {
  const views = [
    { camIdx: 1, presetIdx: 1, label: 'C1-P1', pan: 22, tilt: 6.8, zoom: 1.6 },
    { camIdx: 1, presetIdx: 2, label: 'C1-P2', pan: 95, tilt: 10, zoom: 2.5 },
  ];

  it('(a) 신규 (camIdx,presetIdx) → 배열 말미에 추가', () => {
    const next = upsertPreset(views, { camIdx: 2, presetIdx: 1, label: 'C2-P1', pan: 40, tilt: 5, zoom: 4 });
    expect(next).toHaveLength(3);
    expect(next[2]).toEqual({ camIdx: 2, presetIdx: 1, label: 'C2-P1', pan: 40, tilt: 5, zoom: 4 });
  });

  it('(b) 동일 (camIdx,presetIdx) → 제자리 갱신(PTZ/라벨 교체, 길이 유지)', () => {
    const next = upsertPreset(views, { camIdx: 1, presetIdx: 2, label: '수정됨', pan: 100, tilt: 20, zoom: 8 });
    expect(next).toHaveLength(2);
    expect(next[1]).toEqual({ camIdx: 1, presetIdx: 2, label: '수정됨', pan: 100, tilt: 20, zoom: 8 });
  });

  it('(c) 순수: 원본 배열/원소 불변', () => {
    const snapshot = structuredClone(views);
    upsertPreset(views, { camIdx: 1, presetIdx: 1, label: 'X', pan: 0, tilt: 0, zoom: 1 });
    expect(views).toEqual(snapshot);
  });

  it('(d) 산출 원소는 PUT /camerapos body 스키마 필드만 보유(경계면: 6필드 정규화)', () => {
    // routes.ts CameraposBody = { camIdx, presetIdx, label, pan, tilt, zoom }. 여분 필드 누출 없어야 함.
    const next = upsertPreset([], { camIdx: 1, presetIdx: 1, label: 'L', pan: 1, tilt: 2, zoom: 3, extra: 'x' } as never);
    expect(Object.keys(next[0]).sort()).toEqual(['camIdx', 'label', 'pan', 'presetIdx', 'tilt', 'zoom']);
  });

  it('(e) views=null/undefined → 신규 1건 배열', () => {
    expect(upsertPreset(undefined, { camIdx: 1, presetIdx: 1, label: 'L', pan: 0, tilt: 0, zoom: 1 })).toHaveLength(1);
  });
});

describe('removePreset (camerapos 프리셋 삭제 — 순수·불변)', () => {
  const views = [
    { camIdx: 1, presetIdx: 1, label: 'a', pan: 0, tilt: 0, zoom: 1 },
    { camIdx: 1, presetIdx: 2, label: 'b', pan: 0, tilt: 0, zoom: 1 },
    { camIdx: 2, presetIdx: 1, label: 'c', pan: 0, tilt: 0, zoom: 1 },
  ];

  it('(a) (camIdx,presetIdx) 항목만 제거', () => {
    const next = removePreset(views, 1, 2);
    expect(next.map((v) => `${v.camIdx}:${v.presetIdx}`)).toEqual(['1:1', '2:1']);
  });

  it('(b) 다른 카메라의 동일 presetIdx 는 보존(cam 매칭 필수)', () => {
    const next = removePreset(views, 1, 1);
    expect(next.map((v) => `${v.camIdx}:${v.presetIdx}`)).toEqual(['1:2', '2:1']);
  });

  it('(c) 미존재 → 변화 없음(길이 유지)', () => {
    expect(removePreset(views, 9, 9)).toHaveLength(3);
  });

  it('(d) 순수: 원본 불변', () => {
    const snapshot = structuredClone(views);
    removePreset(views, 1, 1);
    expect(views).toEqual(snapshot);
  });

  it('(e) views=null/undefined → []', () => {
    expect(removePreset(undefined, 1, 1)).toEqual([]);
  });
});

describe('nextPresetId (해당 카메라 다음 presetIdx — 1-based)', () => {
  it('(a) 빈 목록 → 1', () => {
    expect(nextPresetId([], 1)).toBe(1);
    expect(nextPresetId(undefined, 1)).toBe(1);
  });

  it('(b) 연속 프리셋 → max+1', () => {
    const views = [
      { camIdx: 1, presetIdx: 1, label: 'a' },
      { camIdx: 1, presetIdx: 2, label: 'b' },
    ];
    expect(nextPresetId(views, 1)).toBe(3);
  });

  it('(c) 중간 결번(1,3) → max+1=4 (결번 재사용 안 함 — 충돌 회피)', () => {
    const views = [
      { camIdx: 1, presetIdx: 1, label: 'a' },
      { camIdx: 1, presetIdx: 3, label: 'c' },
    ];
    expect(nextPresetId(views, 1)).toBe(4);
  });

  it('(d) 카메라별 독립 계산(다른 cam 무시)', () => {
    const views = [
      { camIdx: 1, presetIdx: 5, label: 'a' },
      { camIdx: 2, presetIdx: 2, label: 'b' },
    ];
    expect(nextPresetId(views, 2)).toBe(3);
    // cam3 은 프리셋 없음 → 1.
    expect(nextPresetId(views, 3)).toBe(1);
  });
});

describe('createSnapshotFetcher — 백프레셔/revoke/abort', () => {
  /** 수동 해소형 Promise. */
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  function mkDeps() {
    const created: string[] = [];
    const revoked: string[] = [];
    let urlSeq = 0;
    const pending: Array<{ resolve: (v: any) => void }> = [];
    const deps = {
      fetchFn: vi.fn((_url: string, _opt: any) => {
        const d = deferred<any>();
        pending.push({ resolve: d.resolve });
        return d.promise;
      }),
      makeUrl: vi.fn((seq: number) => `/snap?t=${seq}`),
      createObjectURL: vi.fn((_blob: any) => `blob:${urlSeq++}`),
      revokeObjectURL: vi.fn((u: string) => revoked.push(u)),
      setImage: vi.fn(async (u: string) => {
        created.push(u);
      }),
      onPtz: vi.fn(),
    };
    /** 가장 오래된 inflight fetch 를 응답시킨다. */
    const respond = () => {
      const p = pending.shift();
      p?.resolve({ blob: async () => ({}), headers: { get: () => '7' } });
    };
    return { deps, created, revoked, respond, pendingCount: () => pending.length };
  }

  it('백프레셔: inflight 진행 중 tick 겹침은 스킵(fetch 1회)', async () => {
    const { deps, respond } = mkDeps();
    const loop = createSnapshotFetcher(deps);
    const t1 = loop.tick();
    const t2 = loop.tick(); // inflight 가드로 즉시 반환
    await t2;
    expect(deps.fetchFn).toHaveBeenCalledTimes(1);
    respond();
    await t1;
    // 해소 후 다음 tick 은 다시 fetch
    const t3 = loop.tick();
    expect(deps.fetchFn).toHaveBeenCalledTimes(2);
    respond();
    await t3;
  });

  it('새 프레임 시 이전 Blob URL revoke(G3-4), 첫 프레임은 revoke 없음', async () => {
    const { deps, revoked, respond } = mkDeps();
    const loop = createSnapshotFetcher(deps);
    const a = loop.tick();
    respond();
    await a;
    expect(revoked).toHaveLength(0); // 첫 프레임: 이전 URL 없음
    const b = loop.tick();
    respond();
    await b;
    expect(revoked).toEqual(['blob:0']); // 두번째: 이전(blob:0) 해제
    expect(deps.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('onPtz 가 응답 헤더로 호출됨', async () => {
    const { deps, respond } = mkDeps();
    const loop = createSnapshotFetcher(deps);
    const a = loop.tick();
    respond();
    await a;
    expect(deps.onPtz).toHaveBeenCalledTimes(1);
  });

  it('abort: inflight abort', async () => {
    const { deps } = mkDeps();
    const loop = createSnapshotFetcher(deps);
    loop.tick(); // inflight 생성(미해소)
    loop.abort();
    // fetch 에 전달된 signal 이 aborted 여야 함
    const signal = deps.fetchFn.mock.calls[0][1].signal as AbortSignal;
    expect(signal.aborted).toBe(true);
  });
});
