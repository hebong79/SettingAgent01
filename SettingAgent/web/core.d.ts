// core.js(브라우저용 순수 ESM)의 타입 선언. vitest 가 직접 로드하는 core.js 와 1:1.
// 분리 전 SettingAgent 에는 선언이 없어 import 가 implicit any(TS7016)였으나,
// SettingViewer 독립 typecheck 통과를 위해 명시 선언을 추가한다(런타임 JS 무변경).

export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PixelRect {
  px: number;
  py: number;
  pw: number;
  ph: number;
}

export interface NormalizedPoint {
  x: number;
  y: number;
}
export type NormalizedQuad = [NormalizedPoint, NormalizedPoint, NormalizedPoint, NormalizedPoint];

export interface PixelPoint {
  px: number;
  py: number;
}

export interface Ptz {
  pan: number;
  tilt: number;
  zoom: number;
}

export interface GlobalIndexEntry {
  globalIdx: number;
  slotId: string;
}

export interface CaptureStatus {
  state: string;
  runId?: number;
  round: number;
  done: number;
  planned: number;
  startedAt?: string;
  endedAt?: string;
  latestAdvisory?: string[];
  llmFloorUnavailable?: boolean;
}

export function captureProgress(status: Partial<CaptureStatus> | null | undefined): {
  percent: number;
  label: string;
};
export function captureElapsedMs(status: Partial<CaptureStatus> | null | undefined, nowMs: number): number | null;
export function formatElapsed(ms: number | null | undefined): string;
export function captureResultSummary(
  status: Partial<CaptureStatus> | null | undefined,
  nowMs: number,
): { title: string; lines: string[] };
export function mapAdvisory(status: Partial<CaptureStatus> | null | undefined): string[];
export function pollPlan(state: string, intervalMs?: number): { poll: boolean; intervalMs: number };
export function captureUiState(state: string): {
  startDisabled: boolean;
  stopDisabled: boolean;
  finalizeDisabled: boolean;
  suppressFrameMsg: boolean;
  stoppingNote: boolean;
};
export function discoverView(status: { state?: string; done?: number; total?: number; found?: number } | null | undefined): {
  percent: number;
  label: string;
  runDisabled: boolean;
  polling: boolean;
};
export function alignProtocolToKind(
  kind: 'sim' | 'hucoms',
  protocol: 'unity-rpc' | 'unity-rest' | 'hucoms-v1.22' | undefined,
): 'unity-rpc' | 'unity-rest' | 'hucoms-v1.22';
export function capFrameKey(
  cam: number | string | null | undefined,
  preset: number | string | null | undefined,
  round: number | string | null | undefined,
): string | null;
export function settingsFormErrors(form: {
  llm?: { provider?: string; model?: string; baseUrl?: string };
  vpd?: { endpoint?: string; detPath?: string };
  lpd?: { endpoint?: string; detPath?: string };
  camera?: {
    executionMode?: string;
    selectedCameraId?: string;
    source?: {
      id?: string;
      label?: string;
      kind?: 'sim' | 'hucoms';
      protocol?: 'unity-rpc' | 'unity-rest' | 'hucoms-v1.22';
      baseUrl?: string;
      username?: string;
      password?: string;
      rtspUrl?: string;
    };
  };
} | null | undefined): string[];

export function toPixel(rect: NormalizedRect, imgW: number, imgH: number): PixelRect;
export function toPixelQuad(quad: NormalizedQuad, imgW: number, imgH: number): PixelPoint[];
export function presetKey(camIdx: number | string, presetIdx: number | string): string;
export function slotLabel(slotId: string, globalIndex?: GlobalIndexEntry[]): string;
export function clampZoom(z: number, min?: number, max?: number): number;
export function stepPtz(cur: Ptz, dir: string, step: number): Ptz;
export function resolveAbsPtz(
  cur: Ptz,
  raw: { pan?: string; tilt?: string; zoom?: string },
): Ptz;
export function clampPanelWidth(px: number, min?: number, max?: number): number;

export interface CameraListItem {
  camIdx: number;
  presets: Array<{ presetIdx: number; pan?: number; tilt?: number; zoom?: number; label?: string }>;
}
export function findPresetPtz(
  cameras: CameraListItem[] | undefined,
  camIdx: number,
  presetIdx: number,
): Ptz | null;

export interface ArtifactAnalysis {
  ok: boolean;
  createdAt: string | null;
  totals: {
    cameras: number;
    presets: number;
    slots: number;
    globalSlots: number;
    withPlate: number;
    withFloor: number;
    warnings: number;
    zones: number;
  };
  perPreset: Array<{
    key: string;
    camIdx: number;
    presetIdx: number;
    label: string;
    slotCount: number;
    ptz: Ptz | null; // 산출물 보관용 PTZ(pan/tilt/zoom 전부 있을 때만). 없으면 null.
  }>;
  slots: Array<{
    globalIdx: number | null;
    slotId: string;
    zone: string;
    presetKey: string;
    roi: NormalizedRect | null;
    hasPlate: boolean;
    hasFloor: boolean;
  }>;
  warnings: string[];
  report: string;
}
export function analyzeArtifact(artifact: unknown): ArtifactAnalysis;

// ===== 정밀수집 차량 점유율(occupancy) 표시용 순수 로직 =====

export interface OccupancySpace {
  id: number;
  occupied: boolean;
  polygon?: NormalizedQuad;
}

export interface OccupancyEntry {
  camIdx: number;
  presetIdx: number;
  occupiedCount: number;
  total: number;
  rate: number;
  spaces: OccupancySpace[];
}

export type OccupancyTableRow = [string, number, number, number, number, string];

export function formatRatePct(rate: unknown): string;
export function occupancyByKey(rows: unknown): Record<string, OccupancyEntry>;
export function occupancyRows(occByKey: unknown): OccupancyTableRow[];
export function occupancyAverage(occByKey: unknown): { occupied: number; total: number; rate: number };

// ===== 미리 정의된 주차면 폴리곤(PtzCamRoi.json) 정규화 =====

export interface PlaceRoiSpace {
  idx: number;
  points: NormalizedPoint[];
}
export interface PlaceRoiReport {
  camId: number | undefined;
  presetIdx: number | undefined;
  spaceCount: number;
  issues: string[];
}
export function normalizePtzCamRoi(json: unknown): {
  byPreset: Record<string, PlaceRoiSpace[]>;
  report: PlaceRoiReport[];
};

export interface FloorRoiPolygon {
  quad: NormalizedPoint[];
  label: string;
  slotId?: string;
  idx?: number; // 파일 모드 전역 인덱스(선택 하이라이트용).
}
export function selectFloorRoi(args: {
  useLlm: boolean;
  slots?: readonly SlotLike[] | null;
  placeRoi?: Record<string, PlaceRoiSpace[]> | null;
  key: string;
}): { source: 'llm' | 'file'; polygons: FloorRoiPolygon[] };

export function quadCentroid(quad: NormalizedPoint[] | null | undefined): NormalizedPoint | null;

export interface OccupancySpace {
  idx: number;
  occupied: boolean;
  center?: NormalizedPoint;
  /** occupied 일 때만: 판정 근거 번호판 OBB quad(입력 그대로) — 점유영역 사다리꼴 축 소스. */
  plateQuad?: NormalizedPoint[];
}
export function computeOccupancy(
  floorPolygons: Array<{ idx: number; quad: NormalizedPoint[] }> | null | undefined,
  plates: Array<{ quad: NormalizedPoint[] }> | null | undefined,
): OccupancySpace[];

// ===== 전체 주차면 목록 · 전역 인덱스(PtzCamRoi.idx) 순수 로직(R2/R3/R4) =====

export type PlaceRoiMap = Record<string, PlaceRoiSpace[]>;

export function normalizeGlobalIdx(placeRoi: PlaceRoiMap | null | undefined): {
  placeRoi: PlaceRoiMap;
  changed: boolean;
  issues: string[];
};
export function reindexPlaceSpace(
  placeRoi: PlaceRoiMap | null | undefined,
  fromIdx: number,
  toIdx: number,
): PlaceRoiMap;
export function removePlaceSpace(placeRoi: PlaceRoiMap | null | undefined, idx: number): PlaceRoiMap;

export interface FlatSlotRow {
  globalIdx: number;
  cam: number;
  preset: number;
  key: string;
  occupied: boolean;
  vpd: boolean;
  lpd: boolean;
}
export function buildFlatSlotRows(args: {
  placeRoi?: PlaceRoiMap | null;
  detectByKey?: Record<string, { vehicles?: Array<{ plate?: { quad: NormalizedPoint[] } }>; plates?: Array<{ quad: NormalizedPoint[] }> }> | null;
  // vpd/lpd 는 SqliteStore.getSlotSetup(SlotSetupView) 의 검출 객체(없으면 null) — 존재 여부만 태그로 쓴다.
  parkingSlotsByKey?: Record<string, Array<{ slotId: number; vpd?: NormalizedRect | null; lpd?: NormalizedQuad | null }>> | null;
  // 점유 판정기(occupancy.js:OccupancyJudge) 주입 — 전달 시 차량 접지 귀속 기준으로 판정한다.
  // 미전달 기본 경로(번호판 중심)는 하위호환용이며 시차 오귀속 결함이 남는다 — 실소비처는 주입할 것.
  judge?: { judge(floorPolygons: Array<{ idx: number; quad: NormalizedPoint[] }>, detect: unknown): Array<{ idx: number; occupied: boolean }> };
}): FlatSlotRow[];

export interface SlotLike {
  slotId: string;
  zone?: string;
  // 편집 순수 함수는 형태만 읽는다(엄격한 quad 튜플 강제 X) — 호출측 입력 부담 완화.
  roiByPreset?: Record<string, NormalizedRect>;
  plateRoiByPreset?: Record<string, NormalizedPoint[] | NormalizedQuad>;
  floorRoiByPreset?: Record<string, NormalizedPoint[] | NormalizedQuad>;
}
export interface PresetLike {
  camIdx: number;
  presetIdx: number;
  label?: string;
  coveredSlotIds?: string[];
  pan?: number;
  tilt?: number;
  zoom?: number;
}
export interface GlobalSlotIndexEntry {
  globalIdx: number;
  slotId: string;
  camIdx: number;
  presetIdx: number;
}
export interface ArtifactLike {
  presets?: PresetLike[];
  slots?: SlotLike[];
  globalIndex?: GlobalSlotIndexEntry[];
  createdAt?: string;
  warnings?: string[];
  report?: string;
  [k: string]: unknown;
}

export function diffArtifactVsCameras(
  artifact: ArtifactLike | null | undefined,
  cameras: CameraListItem[] | undefined,
): { artifactOnly: string[]; camerasOnly: string[] };
export function pointInRect(nx: number, ny: number, rect: NormalizedRect | null | undefined): boolean;
export function pointInQuad(nx: number, ny: number, quad: NormalizedPoint[] | null | undefined): boolean;
export function hitTestSlots(args: {
  nx: number;
  ny: number;
  slots: readonly SlotLike[] | undefined;
  key: string;
  layers?: { vehicle?: boolean; floor?: boolean };
}): string | null;
export function rebuildGlobalIndex(
  slots: readonly { slotId: string }[] | undefined,
  presets: readonly PresetLike[] | undefined,
): GlobalSlotIndexEntry[];
export function removeSlot<T extends ArtifactLike>(artifact: T, slotId: string): T;
export function clamp01Rect(rect: NormalizedRect): NormalizedRect;
export function resizeRect(rect: NormalizedRect, handle: string, ndx: number, ndy: number): NormalizedRect;
export function updateSlotRoi<T extends ArtifactLike>(artifact: T, slotId: string, key: string, rect: NormalizedRect): T;
export function moveRect(rect: NormalizedRect, ndx: number, ndy: number): NormalizedRect;
export type RectHandle = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';
export function hitTestRectHandle(
  rect: NormalizedRect | null | undefined,
  nx: number,
  ny: number,
  tolX: number,
  tolY: number,
): RectHandle | 'in' | null;
export function nextSlotId(
  artifact: ArtifactLike | null | undefined,
  camIdx: number,
  presetIdx: number,
): string;
export function insertSlotAt<T extends ArtifactLike>(artifact: T, atGlobalIdx: number, newSlot: SlotLike): T;
export function hitTestQuadVertex(
  quad: NormalizedPoint[] | null | undefined,
  nx: number, ny: number, tolX: number, tolY: number,
): number | null;
export function moveQuadVertex(
  quad: NormalizedPoint[], index: number, ndx: number, ndy: number,
): NormalizedPoint[];
export function updateSlotFloorRoi<T extends ArtifactLike>(
  artifact: T, slotId: string, key: string, quad: NormalizedPoint[],
): T;
export function validateManualIndex(
  globalIndex: readonly { globalIdx: number; slotId?: string }[] | undefined,
): { ok: boolean; duplicates: number[]; gaps: number[] };
export function reorderGlobalIndex<T extends ArtifactLike>(artifact: T, orderedSlotIds: string[]): T | null;

export interface MappingRow {
  slotId: string;
  camIdx: number;
  presetIdx: number;
  positionIdx: number | null;
  globalIdx: number | null;
}
export function buildMappingRows(artifact: ArtifactLike | null | undefined): MappingRow[];

export interface SlotMapBox {
  slotId: string;
  label: string;
  group: string;
  bad: boolean;
  selected: boolean;
}
export function slotMapModel(
  rows: MappingRow[] | null | undefined,
  idBySlot: Record<string, number | string | undefined> | null | undefined,
  selectedSlotId: string | null | undefined,
): SlotMapBox[];
export function applyManualGlobalIds<T extends ArtifactLike>(
  artifact: T,
  idBySlot: Record<string, number | string>,
): { ok: true; artifact: T } | { ok: false; error: string; validation?: { ok: boolean; duplicates: number[]; gaps: number[] } };

export interface PlacementSubmit {
  slotId: number;
  camId: number;
  presetId: number;
  presetSlotIdx: number;
}
export function applyManualPlacement(
  artifact: ArtifactLike | null | undefined,
  placementBySlot: Record<string, { camIdx?: number | string; presetIdx?: number | string; positionIdx?: number | string }>,
): { ok: true; placements: PlacementSubmit[]; changed: boolean } | { ok: false; error: string };

export interface SnapshotFetcherDeps {
  fetchFn: (url: string, opt: { signal: AbortSignal }) => Promise<{
    blob: () => Promise<unknown>;
    headers: { get: (name: string) => string | null };
  }>;
  makeUrl: (seq: number) => string;
  createObjectURL: (blob: unknown) => string;
  revokeObjectURL: (url: string) => void;
  setImage: (url: string) => void | Promise<void>;
  onPtz?: (headers: { get: (name: string) => string | null }) => void;
}

export interface SnapshotFetcher {
  tick: () => Promise<void>;
  abort: () => void;
}

export function createSnapshotFetcher(deps: SnapshotFetcherDeps): SnapshotFetcher;

export function nextStreamRetryDelay(prevMs?: number | null): number;
export function streamRetryLabel(attempt: number, delayMs: number): string;

export function moveRenderDirective(
  liveMode: 'off' | 'stream',
): 'stream-reconnect' | 'tick';

export function parseLoadedArtifact(
  text: string,
): { ok: true; artifact: ArtifactLike } | { ok: false; error: string };
export function defaultResultFilename(date?: Date): string;

export function pickSelected<K extends string>(
  prevId: number | string | null,
  list: ReadonlyArray<Record<string, unknown>> | null | undefined,
  key?: K,
): number | string | null;
export function camerasChanged(
  prev: CameraListItem[] | null | undefined,
  next: CameraListItem[] | null | undefined,
): boolean;

export function buildDbTableModel(
  input?: { columns?: string[]; rows?: Array<Record<string, unknown>> },
): { headers: string[]; cells: string[][] };

// ===== 카메라 PTZ 프리셋(camerapos.json) 편집 순수 로직 =====

export interface CameraposView {
  camIdx: number;
  presetIdx: number;
  label: string;
  pan?: number;
  tilt?: number;
  zoom?: number;
}
export function upsertPreset(views: CameraposView[] | null | undefined, entry: CameraposView): CameraposView[];
export function removePreset(
  views: CameraposView[] | null | undefined,
  camIdx: number,
  presetIdx: number,
): CameraposView[];
export function nextPresetId(views: CameraposView[] | null | undefined, camIdx: number): number;

// ===== [기능2] VPD/LPD 검출 박스 선택·편집 순수 로직 =====

export interface DetectVehicle {
  rect: NormalizedRect;
  plate?: { quad: NormalizedPoint[]; recovered?: boolean };
}
export interface DetectPlate {
  quad: NormalizedPoint[];
  recovered?: boolean;
}
export interface DetectResult {
  vehicles?: DetectVehicle[];
  plates?: DetectPlate[];
  [k: string]: unknown;
}
export type DetectSelection = { kind: 'vehicle' | 'plate'; index: number };
export type DetectHit =
  | { kind: 'vehicle'; index: number; handle: RectHandle | 'in' }
  | { kind: 'plate'; index: number; vertex?: number }
  | null;
export function hitTestDetections(args: {
  nx: number;
  ny: number;
  detect: DetectResult | null | undefined;
  tolX: number;
  tolY: number;
  selected?: DetectSelection | null;
}): DetectHit;
export function removeDetection(
  detect: DetectResult | null | undefined,
  sel: DetectSelection | null | undefined,
): DetectResult;

// ===== VPD 차량 검출 중복 제거(dedup) 순수 로직 =====
export function rectIoU(a: NormalizedRect, b: NormalizedRect): number;
export function dedupeVehicles<T extends { rect: NormalizedRect }>(vehicles: T[], iouThresh?: number): T[];

// ===== [기능3] 주차면 자동보정 아핀(이동+스케일) 순수 로직 =====

export interface TranslateScale {
  dx?: number;
  dy?: number;
  scale?: number;
  cx?: number;
  cy?: number;
}
export function applyTranslateScale(point: NormalizedPoint, transform: TranslateScale): NormalizedPoint;
export function transformPlaceRoiPreset(
  spaces: PlaceRoiSpace[] | null | undefined,
  transform: TranslateScale,
): PlaceRoiSpace[];

// ===== 3D 육면체(주차면 부피) 투영 =====

/** 서버 GET /capture/ground-model 이 주는 프리셋 지면모델(src/ground/types.ts:GroundModel 과 1:1). */
export interface ViewerGroundModel {
  camIdx: number;
  presetIdx: number;
  imgW: number;
  imgH: number;
  f: number;
  n: [number, number, number];
  d: number;
  tiltDeg: number;
  /** 카메라 보고 PTZ tilt(camerapos). 미상이면 null. */
  ptzTiltDeg?: number | null;
  /** 세로 정합 지표(추정 tilt − PTZ tilt). 미상이면 null. */
  tiltErrDeg?: number | null;
  /** 가로 정합 지표(주차면 metric 재구성 잔차 0~1). */
  metricErr?: number;
  conf: number;
  source: 'file' | 'auto';
  issues: string[];
}

export interface Cuboid {
  /** 0..3=바닥(입력 quad), 4..7=상면(같은 순서). 정규화 0..1. */
  corners: NormalizedPoint[];
  /** 12 모서리(바닥4 + 상면4 + 수직4). */
  edges: Array<[number, number]>;
}

export function projectCuboid(
  floorQuad: NormalizedPoint[] | null | undefined,
  groundModel: ViewerGroundModel | null | undefined,
  heightM: number,
): Cuboid | null;

export function frontFaceCenter(cuboid: Cuboid | null | undefined): NormalizedPoint | null;

export function formatGroundBadge(model: ViewerGroundModel | null | undefined): string;

export function groundModelsByKey(
  models: ViewerGroundModel[] | null | undefined,
): Record<string, ViewerGroundModel>;

// ===== Touring Test 순회 시퀀스 빌더(순수) =====
export interface TouringSetupSlot {
  slotId: number;
  camId: number;
  presetId: number;
  presetSlotIdx: number | null;
  centering: { pan: number; tilt: number; zoom: number } | null;
  [k: string]: unknown; // floor_roi/occupy_roi 등은 빌더가 읽지 않음.
}
export type TouringStep =
  | { kind: 'preset'; camId: number; presetId: number }
  | { kind: 'slot'; camId: number; presetId: number; presetSlotIdx: number | null; slotId: number; ptz: Ptz };
export function buildTouringPlan(
  setupResult: { slots?: TouringSetupSlot[] } | null | undefined,
): { steps: TouringStep[]; skipped: number };
