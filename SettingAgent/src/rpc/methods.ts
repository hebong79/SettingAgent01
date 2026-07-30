// RPC 메서드 표(설계서 §6 / 다이어그램 §9) — **이 파일이 제어 평면의 계약이다**.
//
// 각 메서드는 둘 중 하나로만 실행된다:
//   · `http`    — 기존 REST 라우트로 위임(bridge). **로직 0줄** — REST 와 결과가 정의상 같다.
//   · `handler` — REST 에 대응 라우트가 **없는** 승격 기능만(services/*). 그것이 유일한 정의처다.
//
// 파라미터 검증은 **위임 대상이 소유**한다(라우트 zod). 여기서는 URL 조립에 필요한 필드와
// 파괴적 조작의 `confirm` 만 본다 — 스키마를 두 벌 쓰지 않기 위해서다.

import { qs, requireFields } from './bridge.js';
import { RpcCode, RpcMethodError } from './errors.js';
import type { MethodDef } from './types.js';
import {
  placeAlignApply,
  placeBackups,
  placePresetClear,
  placeRevert,
  placeSpaceAdd,
  placeSpaceDelete,
  placeSpaceUpdate,
  placeSpacesList,
} from './services/placeSpaces.js';
import { camGotoPreset, camPresetDelete, camPresetList, camPresetUpsert } from './services/cameraPresets.js';
import { platePickAt } from './services/platePick.js';
import { mappingAutoNumber } from './services/mappingAuto.js';
import { roiAutoApply, roiAutoDetect, roiAutoScore } from './services/roiAuto.js';

/** 파괴적 메서드 공통 게이트 — `confirm:true` 없이는 위임하지 않는다(다이어그램 §8). */
function requireConfirm(params: Record<string, unknown>, method: string, what: string): void {
  if (params.confirm !== true) {
    throw new RpcMethodError(
      RpcCode.INVALID_PARAMS,
      `${method}: confirm:true 가 필요합니다 — ${what}`,
      { confirmRequired: true },
    );
  }
}

/** 본문에서 특정 키를 뺀 payload(브리지 전달용). confirm 같은 RPC 전용 게이트 필드가 라우트로 새지 않게 한다. */
function omit(params: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) if (!keys.includes(k)) out[k] = v;
  return out;
}

export const METHODS: MethodDef[] = [
  // ────────────────────────────────────────────────────────── system.*
  {
    name: 'system.ping',
    title: 'RPC 평면 생존 확인',
    mutating: false,
    handler: async () => ({ ok: true, service: 'parkagent-setting', rpc: '2.0' }),
  },
  {
    name: 'system.health',
    title: '서버·카메라·VPD·두뇌 상태',
    mutating: false,
    http: () => ({ method: 'GET', url: '/health' }),
  },
  {
    name: 'system.busy',
    title: '카메라 점유자 조회',
    mutating: false,
    note: '카메라를 점유하는 메서드(requiresCamera)는 호출 전 이것을 확인한다.',
    handler: async (_p, ctx) => ctx.deps.isBusy?.() ?? { busy: false },
  },
  // system.catalog 는 dispatch 가 표 전체를 알아야 하므로 routes.ts 에서 주입한다(여기서는 선언만).

  // ────────────────────────────────────────────────────────── cam.*
  {
    name: 'cam.list',
    title: '카메라·프리셋 목록',
    mutating: false,
    http: (p) => ({ method: 'GET', url: `/viewer/api/cameras${qs({ source: p.source })}` }),
  },
  {
    name: 'cam.sources',
    title: '카메라 소스 레지스트리',
    mutating: false,
    http: () => ({ method: 'GET', url: '/viewer/api/health' }),
  },
  {
    name: 'cam.getPTZ',
    title: '장비 보고 현재 PTZ',
    mutating: false,
    http: (p) => {
      requireFields(p, ['cam'], 'cam.getPTZ');
      return { method: 'GET', url: `/viewer/api/ptz${qs({ source: p.source, cam: p.cam })}` };
    },
  },
  {
    name: 'cam.move',
    title: 'PTZ 절대 이동',
    mutating: true,
    requiresCamera: true,
    http: (p) => ({ method: 'POST', url: '/viewer/api/move', payload: p }),
  },
  {
    name: 'cam.gotoPreset',
    title: '프리셋 위치로 실제 이동',
    mutating: true,
    requiresCamera: true,
    note: '프리셋 인덱스만 바꾸면 카메라는 움직이지 않는다 — camerapos 의 PTZ 로 실제 이동시킨다.',
    requires: ['cameraposFile'],
    handler: camGotoPreset,
  },
  {
    name: 'cam.preset.list',
    title: 'PTZ 프리셋 목록(camerapos.json)',
    mutating: false,
    requires: ['cameraposFile'],
    note: '뷰어 비활성(헤드리스) 배포에서도 읽을 수 있도록 파일 정본을 직접 읽는다.',
    handler: camPresetList,
  },
  {
    name: 'cam.preset.upsert',
    title: 'PTZ 프리셋 1건 추가·수정',
    mutating: true,
    requires: ['cameraposFile'],
    handler: camPresetUpsert,
  },
  {
    name: 'cam.preset.delete',
    title: 'PTZ 프리셋 1건 삭제',
    mutating: true,
    requires: ['cameraposFile'],
    handler: camPresetDelete,
  },

  // ────────────────────────────────────────────────────────── place.* (주차면 그리기)
  {
    name: 'place.get',
    title: '주차면 정본 raw JSON',
    mutating: false,
    http: () => ({ method: 'GET', url: '/capture/place-roi' }),
  },
  {
    name: 'place.spaces.list',
    title: '정규화 주차면 목록',
    mutating: false,
    requires: ['placeRoiFile'],
    handler: placeSpacesList,
  },
  {
    name: 'place.space.add',
    title: '주차면 1개 추가',
    mutating: true,
    requires: ['placeRoiFile'],
    note: 'idx 는 서버가 부여한다(끝 append — 기존 번호 불변).',
    handler: placeSpaceAdd,
  },
  {
    name: 'place.space.update',
    title: '주차면 1개 좌표 수정',
    mutating: true,
    requires: ['placeRoiFile'],
    handler: placeSpaceUpdate,
  },
  {
    name: 'place.space.delete',
    title: '주차면 1개 삭제',
    mutating: true,
    destructive: true,
    requires: ['placeRoiFile'],
    note: "mode=clear(기본·기하만 비움·번호보존) / remove(엔트리 제거 + 1..N 재압축 → DB 재구성 필요)",
    handler: placeSpaceDelete,
  },
  {
    name: 'place.preset.clear',
    title: '프리셋 주차면 전체 삭제',
    mutating: true,
    destructive: true,
    requires: ['placeRoiFile'],
    handler: placePresetClear,
  },
  {
    name: 'place.save',
    title: '프리셋 주차면 통째 저장',
    mutating: true,
    destructive: true,
    note: 'expectRawCount 를 함께 보내라 — 내가 읽은 뒤 파일이 바뀌었으면 409(무변경)로 끊긴다.',
    http: (p) => ({ method: 'PUT', url: '/capture/place-roi', payload: p }),
  },
  {
    name: 'place.create',
    title: '신규 주차장 골격 생성',
    mutating: true,
    note: 'pan/tilt/zoom 이 없으면 저장은 되어도 자동생성(L3) 부트스트랩이 "PTZ 미상" 으로 실패한다.',
    http: (p) => {
      requireFields(p, ['camId', 'presetIdx', 'imageWidth', 'imageHeight'], 'place.create');
      return {
        method: 'PUT',
        url: '/capture/place-roi',
        payload: {
          camId: p.camId,
          presetIdx: p.presetIdx,
          spaces: [],
          create: {
            imageWidth: p.imageWidth,
            imageHeight: p.imageHeight,
            ...(p.pan !== undefined ? { pan: p.pan } : {}),
            ...(p.tilt !== undefined ? { tilt: p.tilt } : {}),
            ...(p.zoom !== undefined ? { zoom: p.zoom } : {}),
          },
        },
      };
    },
  },
  {
    name: 'place.validateQuad',
    title: '주차면 quad 사용가능 판정',
    mutating: false,
    http: (p) => ({ method: 'POST', url: '/capture/place-roi/validate', payload: p }),
  },
  {
    name: 'place.backups',
    title: '되돌릴 수 있는 백업 목록',
    mutating: false,
    requires: ['placeRoiFile'],
    handler: placeBackups,
  },
  {
    name: 'place.revert',
    title: '백업에서 정본 복원',
    mutating: true,
    destructive: true,
    requires: ['placeRoiFile'],
    note: '복원 직전 상태도 새 백업으로 남긴다(되돌리기를 되돌릴 수 있다).',
    handler: placeRevert,
  },
  {
    name: 'place.align.saveRef',
    title: '자동보정 기준 프레임 저장',
    mutating: true,
    requiresCamera: true,
    http: (p) => ({ method: 'POST', url: '/capture/refframe', payload: p }),
  },
  {
    name: 'place.align.estimate',
    title: '자동보정 오프셋 추정',
    mutating: false,
    requiresCamera: true,
    note: '이동+스케일만 추정한다(회전·원근 미보정). 적용은 place.align.apply.',
    http: (p) => ({ method: 'POST', url: '/capture/autocorrect', payload: p }),
  },
  {
    name: 'place.align.apply',
    title: '자동보정 오프셋 적용·저장',
    mutating: true,
    destructive: true,
    requires: ['placeRoiFile'],
    handler: placeAlignApply,
  },

  // ────────────────────────────────────────────────────────── grid.* (주차면 자동생성)
  {
    name: 'grid.bootstrap',
    title: '자동 격자 미리보기',
    mutating: false,
    stability: 'experimental',
    note: '파일을 절대 쓰지 않는다(미리보기 전용).',
    http: (p) => ({ method: 'POST', url: '/capture/ground-grid/bootstrap', payload: p }),
  },
  {
    name: 'grid.apply',
    title: '자동 격자 승인 적용',
    mutating: true,
    destructive: true,
    stability: 'experimental',
    note: '_auto → .bak → 정본 3단 쓰기. 실카(RTSP) 격자 스케일은 미검증 상태다.',
    http: (p) => {
      requireConfirm(p, 'grid.apply', '정본(PtzCamRoi.json)을 갱신한다');
      return { method: 'POST', url: '/capture/ground-grid/apply', payload: p };
    },
  },
  {
    name: 'grid.get',
    title: '저장된 격자 조회',
    mutating: false,
    stability: 'experimental',
    http: () => ({ method: 'GET', url: '/capture/ground-grid' }),
  },

  // ─────────────────────────────────────────── roi.auto.* (도색선 기반 자동 바닥 ROI)
  // grid.* 웹 승인 흐름과 **병존**한다(코드 0줄 변경). 차이는 `requiresCamera:true` — 프레임이 반드시 필요하다.
  {
    name: 'roi.auto.detect',
    title: '도색선 기반 바닥 ROI 검출(미리보기)',
    mutating: false,
    requiresCamera: true,
    stability: 'experimental',
    note: '파일·DB 를 쓰지 않는다. 수동 ROI 좌표를 검출 입력으로 쓰지 않는다(hold-out — 베이 개수만 사용).' +
      ' 다시점 합의(consensus, 기본 true)로 고정 디더 **6시점**을 촬영한다 — 카메라 점유·소요시간이 6배(프리셋당 약 70초)다. 단일 시점이 필요하면 consensus:false.',
    requires: ['camera', 'placeRoiFile'],
    handler: roiAutoDetect,
  },
  {
    name: 'roi.auto.score',
    title: '자동 ROI 채점(수동 정본 대비)',
    mutating: false,
    requiresCamera: true,
    stability: 'experimental',
    note: '프레임 취득 전 roi.show2d{visible:false} 를 호출한다. 초록 합성 단서가 0.1% 를 넘으면 채점을 중단한다.' +
      ' 다시점 합의(consensus, 기본 true)로 고정 디더 **6시점**을 촬영한다 — 카메라 점유·소요시간이 6배(프리셋당 약 70초)다. 단일 시점이 필요하면 consensus:false.',
    requires: ['camera', 'placeRoiFile'],
    handler: roiAutoScore,
  },
  {
    name: 'roi.auto.apply',
    title: '자동 ROI 정본 적용',
    mutating: true,
    destructive: true,
    requiresCamera: true,
    stability: 'experimental',
    note: '정본(PtzCamRoi.json) 갱신. DB(slot_setup)는 건드리지 않는다 — 반영은 slot.roi.sync 를 별도 호출.',
    requires: ['camera', 'placeRoiFile'],
    handler: async (p, ctx) => {
      requireConfirm(p, 'roi.auto.apply', '정본(PtzCamRoi.json)을 갱신한다');
      return roiAutoApply(p, ctx);
    },
  },

  // ────────────────────────────────────────────────────────── slot.* (DB 컨트롤)
  {
    name: 'slot.list',
    title: '슬롯 셋업 정본 조회',
    mutating: false,
    http: () => ({ method: 'GET', url: '/capture/slots' }),
  },
  {
    name: 'slot.roi.sync',
    title: 'ROI 정본 → DB 차등 동기(비파괴)',
    mutating: true,
    preconditions: ['slot_setup 부트스트랩 완료(최초 1회는 slot.roi.load)'],
    note: '검출·점유·센터링을 보존한다. 외부 제어자의 기본 경로.',
    http: () => ({ method: 'POST', url: '/capture/slots/sync-roi' }),
  },
  {
    name: 'slot.roi.load',
    title: 'ROI 정본 → DB 전량 재구성',
    mutating: true,
    destructive: true,
    note: '⚠ 검출·점유·센터링이 초기화된다(실측 23→0). 빈 DB 부트스트랩에만 쓰고, 이후에는 slot.roi.sync 를 써라.',
    http: (p) => {
      requireConfirm(p, 'slot.roi.load', 'slot_setup 을 전량 재구성하고 검출·점유·센터링을 초기화한다');
      return { method: 'POST', url: '/capture/slots/load-roi' };
    },
  },
  {
    name: 'slot.reset',
    title: '검출·센터링 초기화',
    mutating: true,
    destructive: true,
    http: (p) => {
      requireConfirm(p, 'slot.reset', 'vpd/lpd/occupy/ptz/centered/img1 을 비운다(slot_roi·행은 보존)');
      return { method: 'POST', url: '/capture/slots/reset' };
    },
  },
  {
    name: 'slot.occupy.build',
    title: '점유영역 재생성',
    mutating: true,
    note: '소스는 DB lpd 뿐이다. lpd 없는 슬롯은 스킵된다(위장 생성 금지).',
    http: (p) => ({ method: 'POST', url: '/capture/slots/occupy', payload: p }),
  },
  {
    name: 'slot.occupancy.evaluate',
    title: '슬롯 점유 판정(차량 접지 우선·번호판 폴백)',
    mutating: false,
    note:
      '순수 판정 — 카메라·DB·파일 무접촉. 검출값은 호출자가 준다(plate.detect 로 얻어 넘겨라). ' +
      'frames[] 배치로 여러 프리셋을 한 번에 판정한다. regions:true 면 점유영역 사다리꼴도 함께 반환.',
    http: (p) => ({ method: 'POST', url: '/capture/slots/judge-occupancy', payload: p }),
  },
  {
    name: 'slot.cuboid.build',
    title: '3D 육면체 앞면 중심 산출',
    mutating: true,
    note: '번호판 탐색(plate.discover)의 대상 조건이 이 컬럼이다 — 비어 있으면 탐색 대상이 0이 된다.',
    http: (p) => ({ method: 'POST', url: '/capture/slots/cuboid', payload: p }),
  },
  {
    name: 'slot.placement.update',
    title: '슬롯 배치(카메라·프리셋·위치) 변경',
    mutating: true,
    note: '기하(slot_roi)·센터링 PTZ 는 변환하지 않는다 — 재수집·재센터라이징이 필요하다.',
    http: (p) => ({ method: 'POST', url: '/mapping/placement', payload: p }),
  },
  {
    name: 'slot.renumber',
    title: '전역번호 재번호',
    mutating: true,
    destructive: true,
    note: '검증 실패 시 DB 무변경. 성공 시 slot_ptz·setup_result·setup_artifact 로 전파된다.',
    http: (p) => ({ method: 'POST', url: '/mapping/renumber', payload: p }),
  },
  {
    name: 'slot.groundModel',
    title: '프리셋별 지면모델',
    mutating: false,
    note: '자동생성·육면체의 유일한 근거. 추정은 서버 소유(클라는 투영만 한다).',
    http: () => ({ method: 'GET', url: '/capture/ground-model' }),
  },

  // ────────────────────────────────────────────────────────── plate.* (선택 차량 번호판)
  {
    name: 'plate.detect',
    title: '라이브 번호판 검출(LPD)',
    mutating: false,
    requiresCamera: true,
    note: 'VPD(차량)는 켜지 않는다 — 제품 정책상 자동검출 금지. 차량이 필요하면 detect.vehicles 를 명시적으로 호출하라.',
    http: (p) => ({ method: 'POST', url: '/capture/detect', payload: { ...omit(p, ['vpdEnabled']), vpdEnabled: false } }),
  },
  {
    name: 'plate.pickAt',
    title: '지정 지점 최근접 번호판 선택',
    mutating: false,
    requiresCamera: true,
    note: '읽기 전용 — 카메라를 움직이지도, DB 를 쓰지도 않는다. 반경 밖이면 채택하지 않는다.',
    requires: ['lpd'],
    handler: platePickAt,
  },
  {
    name: 'plate.assign',
    title: '번호판 → 슬롯 배정·DB 저장',
    mutating: true,
    http: (p) => ({ method: 'POST', url: '/capture/slots/lpd', payload: p }),
  },
  {
    name: 'plate.discover.start',
    title: '번호판 탐색 시작',
    mutating: true,
    requiresCamera: true,
    preconditions: ['slot3d_front_center 산출 완료(slot.cuboid.build)'],
    http: (p) => ({ method: 'POST', url: '/discover/ptz', payload: p }),
  },
  {
    name: 'plate.discover.status',
    title: '번호판 탐색 상태',
    mutating: false,
    http: () => ({ method: 'GET', url: '/discover/status' }),
  },
  {
    name: 'plate.discover.result',
    title: '번호판 탐색 결과',
    mutating: false,
    http: () => ({ method: 'GET', url: '/discover/result' }),
  },
  {
    name: 'detect.vehicles',
    title: '차량 검출 포함 라이브 검출(VPD ON)',
    mutating: false,
    requiresCamera: true,
    note: '⚠ VPD 자동검출은 기본 OFF 가 제품 정책이다. 이 메서드는 명시적 호출 전용이다.',
    http: (p) => ({ method: 'POST', url: '/capture/detect', payload: { ...p, vpdEnabled: true } }),
  },

  // ────────────────────────────────────────────────────────── center.* (센터라이징)
  {
    name: 'center.start',
    title: '센터라이징 배치 시작',
    mutating: true,
    requiresCamera: true,
    http: (p) => ({ method: 'POST', url: '/calibrate/ptz', payload: p }),
  },
  {
    name: 'center.status',
    title: '센터라이징 상태',
    mutating: false,
    http: () => ({ method: 'GET', url: '/calibrate/status' }),
  },
  {
    name: 'center.result',
    title: '센터라이징 결과(slot_ptz)',
    mutating: false,
    http: () => ({ method: 'GET', url: '/calibrate/result' }),
  },
  {
    name: 'center.point',
    title: '지점 조준·번호판 센터+줌',
    mutating: true,
    requiresCamera: true,
    note: "mode='point'=클릭 지점을 화면 중앙으로(기하 오픈루프·pan/tilt only) / 'plate'=번호판 center / 'plate-zoom'=center+zoom",
    http: (p) => ({ method: 'POST', url: '/calibrate/point', payload: p }),
  },

  // ────────────────────────────────────────────────────────── lens.* (렌즈 캘리브레이션)
  {
    name: 'lens.start',
    title: '렌즈 캘리브레이션 시작',
    mutating: true,
    requiresCamera: true,
    note: '⚠ 카메라를 수십 분 점유한다. 다른 잡이 돌면 시작이 거부된다.',
    http: (p) => ({ method: 'POST', url: '/calibrate/lens/start', payload: p }),
  },
  {
    name: 'lens.stop',
    title: '렌즈 캘리브레이션 정지',
    mutating: true,
    http: () => ({ method: 'POST', url: '/calibrate/lens/stop' }),
  },
  {
    name: 'lens.status',
    title: '렌즈 캘리브레이션 상태(증분 로그)',
    mutating: false,
    http: (p) => ({ method: 'GET', url: `/calibrate/lens/status${qs({ sinceSeq: p.sinceSeq })}` }),
  },
  {
    name: 'lens.result',
    title: '렌즈 캘리브레이션 결과',
    mutating: false,
    http: (p) => {
      requireFields(p, ['source'], 'lens.result');
      return { method: 'GET', url: `/calibrate/lens/result${qs({ source: p.source })}` };
    },
  },
  {
    name: 'lens.apply',
    title: '보정표 활성/비활성',
    mutating: true,
    note: 'restartRequired:true — 서버를 재시작해야 조준에 반영된다.',
    http: (p) => ({ method: 'POST', url: '/calibrate/lens/apply', payload: p }),
  },

  // ────────────────────────────────────────────────────────── capture.* (수집·파이프라인)
  {
    name: 'capture.start',
    title: '장기 관측 수집 시작',
    mutating: true,
    requiresCamera: true,
    http: (p) => ({ method: 'POST', url: '/capture/start', payload: p }),
  },
  {
    name: 'capture.startPrecise',
    title: '정밀수집(탐색→점유→센터라이징) 시작',
    mutating: true,
    requiresCamera: true,
    http: (p) => ({ method: 'POST', url: '/capture/start-precise', payload: p }),
  },
  {
    name: 'capture.stop',
    title: '수집 정지',
    mutating: true,
    http: () => ({ method: 'POST', url: '/capture/stop' }),
  },
  {
    name: 'capture.status',
    title: '수집 상태',
    mutating: false,
    http: () => ({ method: 'GET', url: '/capture/status' }),
  },
  {
    name: 'capture.pipeline',
    title: '원버튼 파이프라인 단계',
    mutating: false,
    http: () => ({ method: 'GET', url: '/capture/pipeline' }),
  },
  {
    name: 'capture.finalize',
    title: '수집 최종화',
    mutating: true,
    destructive: true,
    note: '⚠ replaceSlotSetup(DELETE+INSERT) 경유 — 센터링 컬럼 보존은 아직 취약하다(기록된 미해결 항목).',
    http: (p) => {
      requireConfirm(p, 'capture.finalize', 'slot_setup 을 재작성한다');
      return { method: 'POST', url: '/capture/finalize', payload: omit(p, ['confirm']) };
    },
  },

  {
    name: 'capture.tour.start',
    title: '셋업 결과 순회 이동 시작',
    mutating: true,
    requiresCamera: true,
    preconditions: ['setup_result 존재(setup.result.write 또는 정밀수집 완료)'],
    note: 'DB·파일을 쓰지 않는다(읽기 순회). 각 위치 dwellMs(기본 1000ms) 정지.',
    http: (p) => ({ method: 'POST', url: '/capture/tour/start', payload: p }),
  },
  {
    name: 'capture.tour.stop',
    title: '순회 중단',
    mutating: true,
    http: () => ({ method: 'POST', url: '/capture/tour/stop' }),
  },
  {
    name: 'capture.tour.status',
    title: '순회 진행 상태',
    mutating: false,
    http: () => ({ method: 'GET', url: '/capture/tour/status' }),
  },

  // ────────────────────────────────────────────────────────── setup.* (매핑·결과)
  {
    name: 'setup.mapping.get',
    title: '셋업 매핑 조회',
    mutating: false,
    note: '파일 우선 → 없으면 DB(slot_setup)로 즉석 조립.',
    http: () => ({ method: 'GET', url: '/mapping' }),
  },
  {
    name: 'setup.mapping.save',
    title: '셋업 매핑 저장',
    mutating: true,
    http: (p) => ({ method: 'PUT', url: '/mapping', payload: p }),
  },
  {
    name: 'setup.mapping.autoNumber',
    title: '전역번호 자동 부여',
    mutating: true,
    note: '기본 dryRun:true — 계산만 하고 쓰지 않는다. 적용하려면 dryRun:false.',
    requires: ['store'],
    handler: mappingAutoNumber,
  },
  {
    // ★ 이름 주의(리더 결정 Q4): 이 메서드는 **setup_artifact.json 의 슬롯 엔트리 편집**이다.
    //   "주차면(공간)을 늘린다"가 아니다 — 그 경로는 place.space.add + slot.roi.sync 로 이미 승격돼 있다.
    name: 'setup.slot.add',
    title: '셋업 산출물에 슬롯 엔트리 1개 추가',
    mutating: true,
    note:
      'setup_artifact.json 만 바꾼다(DB·ROI 정본 PtzCamRoi.json 은 불변). ' +
      '실제 주차면(공간) 추가는 place.space.add + slot.roi.sync 다 — 이 메서드가 아니다. ' +
      'artifact 미제공 시 서버 파일을 읽는다. dryRun:true 면 편집 결과만 반환하고 파일을 쓰지 않는다. ' +
      '⚠ artifact(호출자 버퍼)는 **계산 전용**이다 — dryRun:true 없이 주면 409(CONFLICT)로 거부된다(버퍼 커밋은 파일 전체 교체가 되므로). ' +
      '⚠ slot.renumber·slot.placement.update 를 부르면 artifact 가 DB 기준으로 재생성되어 이 편집은 사라진다(응답 warnings 참조).',
    http: (p) => ({ method: 'POST', url: '/mapping/slot/add', payload: p }),
  },
  {
    name: 'setup.slot.delete',
    title: '셋업 산출물에서 슬롯 엔트리 1개 삭제',
    mutating: true,
    destructive: true,
    note:
      '위와 동일 — artifact 전용 편집이다. DB slot_setup·ROI 정본(PtzCamRoi.json)은 건드리지 않는다. ' +
      '⚠ artifact(호출자 버퍼)는 계산 전용 — dryRun:true 없이 주면 409(CONFLICT)로 거부된다.',
    http: (p) => {
      requireConfirm(p, 'setup.slot.delete', 'setup_artifact.json 에서 슬롯 엔트리를 제거한다');
      return { method: 'POST', url: '/mapping/slot/delete', payload: omit(p, ['confirm']) };
    },
  },
  {
    name: 'setup.result.write',
    title: '최종 결과 파일 생성',
    mutating: true,
    note: '소스는 DB slot_setup 현재 값. 이력본+고정본 2벌.',
    http: () => ({ method: 'POST', url: '/capture/setup-result' }),
  },
  {
    name: 'setup.saves.list',
    title: '저장 목록',
    mutating: false,
    http: () => ({ method: 'GET', url: '/capture/saves' }),
  },
  {
    name: 'setup.saves.load',
    title: '저장 결과 열기',
    mutating: false,
    http: (p) => {
      requireFields(p, ['name'], 'setup.saves.load');
      return { method: 'GET', url: `/capture/saves/${encodeURIComponent(String(p.name))}` };
    },
  },
  {
    name: 'setup.saves.save',
    title: '결과 저장(이름 지정)',
    mutating: true,
    http: (p) => ({ method: 'POST', url: '/capture/save', payload: p }),
  },

  // ────────────────────────────────────────────────────────── db.* / config.*
  {
    name: 'db.tables',
    title: 'DB 테이블 목록',
    mutating: false,
    http: () => ({ method: 'GET', url: '/db/tables' }),
  },
  {
    name: 'db.table.query',
    title: 'DB 테이블 조회(read-only)',
    mutating: false,
    note: '화이트리스트·바인딩·민감컬럼 마스킹·limit≤1000. 임의 SQL 은 제공하지 않는다.',
    http: (p) => {
      requireFields(p, ['name'], 'db.table.query');
      const query = qs({ search: p.search, limit: p.limit, offset: p.offset });
      return { method: 'GET', url: `/db/table/${encodeURIComponent(String(p.name))}${query}` };
    },
  },
  {
    name: 'config.get',
    title: '편집 대상 설정 조회',
    mutating: false,
    note: '쓰기(PUT /settings)는 RPC 에 노출하지 않는다 — 재시작이 필요한 파일 편집이다.',
    http: () => ({ method: 'GET', url: '/settings' }),
  },
];

/** 이름 → 정의. 등록 시 중복 이름은 개발 실수이므로 즉시 드러낸다. */
export function buildMethodMap(methods: MethodDef[] = METHODS): Map<string, MethodDef> {
  const map = new Map<string, MethodDef>();
  for (const m of methods) {
    if (map.has(m.name)) throw new Error(`RPC 메서드 이름 중복: ${m.name}`);
    map.set(m.name, m);
  }
  return map;
}
