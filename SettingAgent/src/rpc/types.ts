// RPC 계층 공용 타입(설계서 §4·§6 / 다이어그램 §3). 순수 선언 — 런타임 코드 없음.

import type { FastifyInstance } from 'fastify';
import type { CRpcClient } from '../clients/CRpcClient.js';
import type { ToolsConfig } from '../config/toolsConfig.js';
import type { CameraSource } from '../viewer/CameraSource.js';

/** 기존 REST 라우트로의 위임 지정(bridge.ts 가 app.inject 로 실행). */
export interface HttpMapping {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  /** POST/PUT 본문. undefined 면 본문 없이 호출한다. */
  payload?: unknown;
}

/**
 * 승격 서비스·system·unity 핸들러에 주입되는 실행 문맥.
 * `app` 은 브리지 재사용(서비스가 다시 기존 라우트를 부를 때)용.
 */
export interface RpcContext {
  app: FastifyInstance;
  deps: RpcDeps;
  /** 요청 헤더 `x-viewer-token`(있으면 브리지가 하류 라우트에 그대로 전달). */
  token?: string;
}

/**
 * registerRpcRoutes 주입 의존성. **전부 옵셔널** — 미주입이면 해당 메서드가
 * 카탈로그에서 `available:false` 가 되고 호출 시 `-32004 UNAVAILABLE`(가산·graceful, 기존 라우트 관례 동일).
 */
export interface RpcDeps {
  /** 변이 메서드 게이트(`x-viewer-token`). 빈 문자열/미설정이면 게이트 없음(기존 /move 규약 동일). */
  viewer?: ToolsConfig['viewer'];
  /** Unity 13110 프록시 클라이언트. 주입 시에만 `unity.*` 패스스루·카탈로그 병합. */
  unityRpc?: CRpcClient;
  /** 주차면 ROI 정본 경로(place.* 승격 서비스). */
  placeRoiFile?: string;
  /** 카메라 PTZ 프리셋 파일(cam.preset.* 승격 서비스). */
  cameraposFile?: string;
  /** 카메라 소스 레지스트리(plate.pickAt·cam.gotoPreset 의 source 지정). */
  sources?: Map<string, CameraSource>;
  /**
   * `camera`(파이프라인 기본 카메라)가 감싸고 있는 소스 id(= cameraRuntime.selectedCameraId).
   * **응답에 "실제로 어느 소스로 찍었는가"를 적기 위한 값**이다 — 이게 없으면 소스 미지정 호출의
   * 산출물이 어느 카메라의 것인지 사후에 알 수 없다(17회차: 실카 화면에 시뮬 검출을 그린 사고).
   */
  selectedCameraId?: string;
  cameraCfg?: ToolsConfig['camera'];
  /** 번호판 검출 클라이언트(plate.pickAt). */
  lpd?: import('../clients/LpdClient.js').LpdClient;
  /** 파이프라인 카메라(source 미지정 시 기본 대상). */
  camera?: import('../clients/CameraClient.js').ICameraClient;
  /** 슬롯 정본 DB(plate.pickAt 슬롯 후보 · setup.mapping.autoNumber 순서 기준). */
  store?: import('../capture/SqliteStore.js').SqliteStore;
  /**
   * 전역 카메라 점유 판정(`system.busy`). index.ts 의 lensCalib.isBusy 와 **같은 클로저**를 주입해
   * 판정처를 하나로 유지한다(다이어그램 §6).
   */
  isBusy?: () => { busy: boolean; who?: string };
}

/** 메서드 정의 — 카탈로그 메타 + 실행부(http 위임 또는 handler) 중 하나. */
export interface MethodDef {
  name: string;
  title: string;
  /** true 면 `x-viewer-token` 게이트 대상(카탈로그가 게이트 여부의 단일 출처). */
  mutating: boolean;
  /** 정본을 파괴할 수 있는가(문서·경고용 — 실제 가드는 라우트/서비스 소유). */
  destructive?: boolean;
  /** 카메라를 점유하는가 → 호출 전 isBusy 확인. */
  requiresCamera?: boolean;
  stability?: 'stable' | 'experimental';
  /** 호출 전 만족해야 하는 상태(기계 판독용 문자열). */
  preconditions?: string[];
  /** 운영 주의사항(카탈로그 노출). */
  note?: string;
  /** 브리지 위임. params → HTTP 매핑. 필수 필드 누락 시 RpcMethodError(INVALID_PARAMS) throw. */
  http?: (params: Record<string, unknown>) => HttpMapping;
  /** 커스텀 실행(승격 서비스·system.*·unity.*). http 와 배타. */
  handler?: (params: Record<string, unknown>, ctx: RpcContext) => Promise<unknown>;
  /** 이 메서드가 살아 있으려면 필요한 deps 키(미주입 → available:false). */
  requires?: Array<keyof RpcDeps>;
}

/** GET /rpc/catalog 의 엔트리(실행부 제외 — 직렬화 가능한 메타만). */
export interface CatalogEntry {
  name: string;
  title: string;
  mutating: boolean;
  destructive: boolean;
  requiresCamera: boolean;
  stability: 'stable' | 'experimental';
  preconditions?: string[];
  note?: string;
  /** 의존성 주입 상태 기준 호출 가능 여부. */
  available: boolean;
}
