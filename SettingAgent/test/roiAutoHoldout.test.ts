// V8 — hold-out 정적 봉인(설계 §3 ③, R1).
//
// 검출·기하 모듈이 수동 ROI 를 **어떤 경로로도** 읽지 못한다는 것을 소스 문자열로 못 박는다.
// 약속이 아니라 구조로 막는 것이 요점이다. (`test/groundGrid.test.ts` 의 픽스처 봉인 메타 테스트와 같은 패턴)

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const DETECT_MODULES = ['src/ground/floorPaint.ts', 'src/ground/bayGeometry.ts', 'src/ground/bayGrid.ts'];

/**
 * 봉인 대상이 **아닌** 것으로 의식적으로 판단한 `src/ground/*` 모듈.
 *
 * `roiAutoScore` 는 설계상 유일하게 정답지를 읽는 채점 모듈이고, 나머지는 주차면 데이터를
 * 담지 않는 순수 기하·제원 모듈이다. 이 목록과 `DETECT_MODULES` 어디에도 없는 모듈이
 * `roi.auto` 서비스에 등장하면 아래 메타 테스트가 **터진다** — 신규 검출 모듈이 봉인을
 * 조용히 빠져나가지 못하게 하는 장치다(14회차: `bayGrid.ts` 가 그렇게 2라운드를 빠져나갔다).
 */
const NOT_SEALED = [
  'src/ground/roiAutoScore.ts',
  'src/ground/autoRoiPlan.ts',
  'src/ground/project.ts',
  'src/ground/cameraIntrinsics.ts',
  'src/ground/placeMetaIntrinsics.ts',
  'src/ground/contactTypes.ts',
  // ★ 27-B — `GroundModel` 타입 하나를 쓰려고 들어왔다(아카이브 사이드카가 지면모델 값을 담는다).
  //   **런타임 코드가 0줄인 순수 선언 모듈**이라 주차면 데이터를 담을 수도, 읽을 수도 없다.
  //   (`cameraIntrinsics.ts`·`bayGrid.ts` 가 이미 같은 타입을 여기서 가져다 쓴다 — 신규 의존이 아니다.)
  'src/ground/types.ts',
];

/** 수동 정본에 닿는 심볼·경로. 하나라도 등장하면 hold-out 오염이다. */
const BANNED = [
  'placeRoi',
  'PlaceRoiSpace',
  'normalizePtzCamRoi',
  'placeRoiFile',
  'PtzCamRoi',
  'parking_spaces',
  'applyPlaceRoiUpdate',
];

describe('roi.auto hold-out 봉인', () => {
  it('검출·기하 모듈은 수동 ROI 를 어떤 경로로도 읽지 않는다', () => {
    for (const f of DETECT_MODULES) {
      const src = readFileSync(f, 'utf8');
      for (const banned of BANNED) {
        expect(src.includes(banned), `${f} 가 "${banned}" 를 참조한다 — hold-out 오염(R1)`).toBe(false);
      }
    }
  });

  it('검출·기하 모듈은 capture 계층을 import 하지 않는다', () => {
    for (const f of DETECT_MODULES) {
      const src = readFileSync(f, 'utf8');
      expect(/from\s+['"][^'"]*capture\//.test(src), `${f} 가 capture/* 를 import 한다`).toBe(false);
    }
  });

  it('수동 ROI 를 읽는 기하 모듈은 roiAutoScore.ts 하나뿐이다', () => {
    // 채점 모듈만 정본을 안다. 이 단언이 깨지면 hold-out 경계가 하나 더 생긴 것이다.
    const score = readFileSync('src/ground/roiAutoScore.ts', 'utf8');
    expect(score).toContain('PlaceRoiSpace');
    for (const f of DETECT_MODULES) {
      expect(readFileSync(f, 'utf8')).not.toContain('PlaceRoiSpace');
    }
  });

  it('검출 모듈은 색 채널을 쓰지 않는다(D-5: 그레이스케일 전용)', () => {
    // 시뮬레이터의 초록 주차면 박스는 실카에 없는 합성 단서다. 색에 의존하면 실카 전이가 불가능해진다.
    for (const f of DETECT_MODULES) {
      const src = readFileSync(f, 'utf8');
      for (const sym of ['greenPixelRatio', 'rgb', 'RGB', 'channels: 3']) {
        expect(src.includes(sym), `${f} 가 색 채널 심볼 "${sym}" 를 쓴다`).toBe(false);
      }
    }
  });

  it('검출·기하 모듈에 Math.random 이 없다(R2)', () => {
    for (const f of [...DETECT_MODULES, 'src/ground/roiAutoScore.ts', 'src/rpc/services/roiAuto.ts']) {
      expect(readFileSync(f, 'utf8')).not.toContain('Math.random');
    }
  });

  it('roi.auto 가 쓰는 ground 모듈은 전부 봉인 대상이거나 명시적 예외다', () => {
    const src = readFileSync('src/rpc/services/roiAuto.ts', 'utf8');
    const used = [...src.matchAll(/from\s+['"][./]*ground\/([A-Za-z0-9_]+)\.js['"]/g)].map((m) => `src/ground/${m[1]}.ts`);
    for (const f of new Set(used)) {
      expect(
        DETECT_MODULES.includes(f) || NOT_SEALED.includes(f),
        `${f} 가 roi.auto 경로에 들어왔는데 봉인 목록에도 예외 목록에도 없다 — DETECT_MODULES 또는 NOT_SEALED 에 넣고 사유를 적어라(R1)`,
      ).toBe(true);
    }
  });

  /**
   * ★ 18회차 R1 확장 — **씬 정답 봉인**.
   *
   * `sceneTruth.ts` 는 Unity `preset.list` 제원에서 주차면을 복원한다. 이건 `fov`·`tilt`·설치고 같은
   * "카메라 사실"과 **범주가 다르다** — 주차면 정답 그 자체다. 검출·제원 모듈이 이걸 읽으면
   * "정답지에서 온 정보를 다른 경로로 다시 끌어온" 사례가 된다(마스터 제약 직격).
   * 채점 모듈(`roiAutoRecall.ts`)과 채점 도구만 이 모듈을 안다.
   */
  const TRUTH_BANNED = ['sceneTruth', 'TruthFace', 'ScenePresetSpec', 'facesOfRow', 'projectTruth', 'preset.list'];
  it('검출·제원 모듈은 씬 정답(sceneTruth)을 문자열로도 참조하지 않는다', () => {
    for (const f of [...DETECT_MODULES, 'src/ground/cameraIntrinsics.ts', 'src/ground/placeMetaIntrinsics.ts']) {
      const src = readFileSync(f, 'utf8');
      for (const banned of TRUTH_BANNED) {
        expect(src.includes(banned), `${f} 가 "${banned}" 를 참조한다 — 씬 정답 누출(R1)`).toBe(false);
      }
    }
  });

  it('씬 정답 모듈 자신도 수동 정본을 읽지 않는다 — 두 정답지가 섞이지 않게', () => {
    const src = readFileSync('src/ground/sceneTruth.ts', 'utf8');
    for (const banned of BANNED) {
      expect(src.includes(banned), `sceneTruth.ts 가 "${banned}" 를 참조한다`).toBe(false);
    }
  });

  it('신규 IoU 구현이 없다 — quadIoU 재사용만(R4)', () => {
    const score = readFileSync('src/ground/roiAutoScore.ts', 'utf8');
    expect(score).toContain('quadIoU');
    // 교집합/합집합 면적을 직접 계산하는 코드가 새로 생기지 않았는지.
    for (const f of ['src/ground/roiAutoScore.ts', 'src/ground/bayGeometry.ts', 'src/rpc/services/roiAuto.ts']) {
      const src = readFileSync(f, 'utf8');
      expect(src.includes('convexIntersectionArea'), `${f} 가 IoU 를 재구현한다`).toBe(false);
      expect(src.includes('polygonArea'), `${f} 가 IoU 를 재구현한다`).toBe(false);
    }
  });
});
