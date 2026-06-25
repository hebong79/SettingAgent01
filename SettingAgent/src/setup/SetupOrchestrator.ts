import type { CameraClient } from '../clients/CameraClient.js';
import type { VpdClient } from '../clients/VpdClient.js';
import type { LpdClient } from '../clients/LpdClient.js';
import type { Repository } from '../store/Repository.js';
import type { ToolsConfig } from '../config/toolsConfig.js';
import type { GlobalSlotIndex, NormalizedRect, ParkingSlot, Preset, SetupArtifact } from '../domain/types.js';
import { buildSlots, type BuiltSlot } from './RoiBuilder.js';
import { buildSlotsAccumulated } from './RoiAccumulator.js';
import { buildGlobalIndex, validateCoverage, type IndexableSlot } from './GlobalIndexer.js';
import { matchPlatesToSlots } from './plateMatch.js';
import type { VehicleBox } from '../domain/types.js';
import type { SetupBrain } from '../brain/SetupBrain.js';

export type SetupState = 'IDLE' | 'SCANNING' | 'MAPPING' | 'PERSISTED' | 'DONE' | 'FAILED';

/** 셋업 대상 1건. ptz 가 주어지면 프리셋 캡처 시 함께 전송. */
export interface SetupTarget {
  camIdx: number;
  presetIdx: number;
  label?: string;
  ptz?: { pan?: number; tilt?: number; zoom?: number };
}

export interface SetupStatus {
  state: SetupState;
  total: number;
  scanned: number;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface SetupDeps {
  camera: CameraClient;
  vpd: VpdClient;
  /** LPD(번호판 검출). cfg.lpdEnabled=true 일 때 슬롯별 번호판 ROI 를 저장. */
  lpd?: LpdClient;
  repo: Repository;
  cfg: ToolsConfig['setup'];
  /** LLM 두뇌(전략 C 단계별 게이트). 미주입/비활성 시 결정형 단독 경로. */
  brain?: SetupBrain;
  /** 정착 지연 주입(테스트에서 0). 기본 setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 슬롯 ID 생성: 프리셋·위치 기반 안정 식별자. */
function slotIdOf(camIdx: number, presetIdx: number, positionIdx: number): string {
  return `c${camIdx}p${presetIdx}s${positionIdx}`;
}

function presetKey(camIdx: number, presetIdx: number): string {
  return `${camIdx}:${presetIdx}`;
}

/**
 * 셋업 오케스트레이터 (SettingAgent 핵심 흐름, 설계서 §3).
 * 프리셋 순회 캡처 → VPD 검출 → ROI 산출 → 전역 인덱스 매핑 → 영속화.
 * 결정형 경로(LLM 미개입). 외부 능력은 주입된 클라이언트(=MCP 도구의 어댑터)로 호출.
 */
export class SetupOrchestrator {
  private status: SetupStatus = { state: 'IDLE', total: 0, scanned: 0 };
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => string;

  constructor(private deps: SetupDeps) {
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  getStatus(): SetupStatus {
    return { ...this.status };
  }

  /**
   * 프리셋 1개의 슬롯 ROI 산출. accumFrames>1 이면 다프레임 누적 클러스터링(실 PTZ 권장),
   * 아니면 단일 프레임 검출(시뮬레이터 강체). 설계서 §8-1, §8-1-1.
   */
  private async captureSlots(t: SetupTarget, firstJpg: Buffer): Promise<BuiltSlot[]> {
    const c = this.deps.cfg;
    const firstVehicles = await this.deps.vpd.detect(firstJpg);
    if (c.accumFrames <= 1) {
      return buildSlots(firstVehicles, {
        minConfidence: c.minConfidence,
        roiPadding: c.roiPadding,
        yBandTolerance: c.yBandTolerance,
      });
    }
    const frames: VehicleBox[][] = [firstVehicles];
    for (let f = 1; f < c.accumFrames; f++) {
      if (c.accumIntervalMs > 0) await this.sleep(c.accumIntervalMs);
      const cap = await this.deps.camera.requestImage(t.camIdx, t.presetIdx, t.ptz);
      frames.push(await this.deps.vpd.detect(cap.jpg));
    }
    return buildSlotsAccumulated(frames, {
      minConfidence: c.minConfidence,
      roiPadding: c.roiPadding,
      yBandTolerance: c.yBandTolerance,
      clusterDist: c.clusterDist,
      minSupport: c.clusterMinSupport,
    });
  }

  /**
   * 셋업 실행. 대상 프리셋들을 순회하여 산출물을 만들고 저장한다.
   * expectedFaces 가 주어지면 preset 파일 기대 슬롯 수와 검출 결과를 교차검증해 경고를 남긴다.
   */
  async run(targets: SetupTarget[], expectedFaces?: Record<string, number>): Promise<SetupArtifact> {
    this.status = { state: 'SCANNING', total: targets.length, scanned: 0, startedAt: this.now() };
    const presets: Preset[] = [];
    const slots: ParkingSlot[] = [];
    const indexable: IndexableSlot[] = [];
    const warnings: string[] = [];

    try {
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        if (this.deps.cfg.presetSettleMs > 0) await this.sleep(this.deps.cfg.presetSettleMs);

        const captured = await this.deps.camera.requestImage(t.camIdx, t.presetIdx, t.ptz);
        let built = await this.captureSlots(t, captured.jpg);

        const key = presetKey(t.camIdx, t.presetIdx);
        const expected = expectedFaces?.[key];

        // 게이트 1: 프리셋별 비전 판정(오검출 제외/순서 보정/재촬영 권고).
        if (this.deps.brain?.enabled) {
          built = await this.applyStage1(t, captured.jpg, built, expected, warnings);
        }

        if (expected !== undefined && expected !== built.length) {
          warnings.push(`프리셋 ${key}: 기대 슬롯 ${expected} ≠ 검출 ${built.length}`);
        }

        // LPD: 차량 검지(VPD) 후 번호판 위치를 검출해 슬롯에 귀속(센터라이징 prior).
        const plateByPos = await this.detectPlates(key, captured.jpg, built, warnings);

        const coveredSlotIds: string[] = [];
        for (const b of built) {
          const slotId = slotIdOf(t.camIdx, t.presetIdx, b.positionIdx);
          coveredSlotIds.push(slotId);
          const slot: ParkingSlot = { slotId, zone: `cam${t.camIdx}`, roiByPreset: { [key]: b.roi } };
          const plate = plateByPos?.get(b.positionIdx);
          if (plate) slot.plateRoiByPreset = { [key]: plate };
          slots.push(slot);
          indexable.push({ slotId, camIdx: t.camIdx, presetIdx: t.presetIdx, positionIdx: b.positionIdx });
        }
        presets.push({
          camIdx: t.camIdx,
          presetIdx: t.presetIdx,
          label: t.label ?? key,
          coveredSlotIds,
          pan: captured.pan,
          tilt: captured.tilt,
          zoom: captured.zoom,
        });

        this.status.scanned = i + 1;
        if (this.deps.cfg.betweenPresetMs > 0 && i < targets.length - 1) {
          await this.sleep(this.deps.cfg.betweenPresetMs);
        }
      }

      this.status.state = 'MAPPING';

      // 게이트 2: 프리셋 간 중복 제거 + 존/라벨.
      if (this.deps.brain?.enabled) {
        await this.applyStage2(presets, slots, indexable, warnings);
      }

      const globalIndex: GlobalSlotIndex[] = buildGlobalIndex(indexable);
      const coverage = validateCoverage(globalIndex, slots);
      if (!coverage.ok) {
        throw new Error(`전역 인덱스 커버리지 불일치 missing=${coverage.missing} extra=${coverage.extra}`);
      }

      // 게이트 3: 최종 검증 + 한글 설치 리포트.
      let report: string | undefined;
      if (this.deps.brain?.enabled) {
        report = await this.applyStage3(presets, slots, globalIndex, expectedFaces, warnings);
      }

      const artifact: SetupArtifact = {
        presets,
        slots,
        globalIndex,
        createdAt: this.now(),
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(report ? { report } : {}),
      };
      this.deps.repo.saveArtifact(artifact);
      this.status.state = 'DONE';
      this.status.finishedAt = this.now();
      return artifact;
    } catch (err) {
      this.status.state = 'FAILED';
      this.status.error = err instanceof Error ? err.message : String(err);
      this.status.finishedAt = this.now();
      throw err;
    }
  }

  /**
   * LPD 로 번호판을 검출해 슬롯(positionIdx)에 귀속. cfg.lpdEnabled=false 또는 lpd 미주입 시 undefined.
   * 실패해도 셋업을 막지 않고 경고만 남긴다(번호판 prior 는 선택적).
   */
  private async detectPlates(
    key: string,
    jpg: Buffer,
    built: BuiltSlot[],
    warnings: string[],
  ): Promise<Map<number, NormalizedRect> | undefined> {
    if (!this.deps.cfg.lpdEnabled || !this.deps.lpd || built.length === 0) return undefined;
    try {
      const plates = await this.deps.lpd.detect(jpg);
      const matched = matchPlatesToSlots(built, plates);
      if (matched.size < built.length) {
        warnings.push(`프리셋 ${key}: 번호판 매칭 ${matched.size}/${built.length}`);
      }
      return matched;
    } catch (e) {
      warnings.push(`프리셋 ${key} LPD 실패(번호판 prior 생략): ${e instanceof Error ? e.message : e}`);
      return undefined;
    }
  }

  /** 게이트1 적용: validBoxes 필터 + 순서 보정 → built 재구성(positionIdx 재부여). */
  private async applyStage1(
    t: SetupTarget,
    jpg: Buffer,
    built: BuiltSlot[],
    expected: number | undefined,
    warnings: string[],
  ): Promise<BuiltSlot[]> {
    const key = presetKey(t.camIdx, t.presetIdx);
    let r;
    try {
      r = await this.deps.brain!.judgePreset({
        camIdx: t.camIdx,
        presetIdx: t.presetIdx,
        imageBase64: jpg.toString('base64'),
        boxes: built.map((b) => ({ box: b.positionIdx, roi: b.roi, confidence: b.confidence })),
        expected,
      });
    } catch (e) {
      warnings.push(`프리셋 ${key} 게이트1 실패(결정형 유지): ${e instanceof Error ? e.message : e}`);
      return built;
    }
    if (!r) return built;

    const byBox = new Map(built.map((b) => [b.positionIdx, b]));
    const valid = new Set(r.validBoxes);
    const order = !r.orderOk && r.reorder?.length ? r.reorder : r.validBoxes;
    const chosen = order.filter((n) => valid.has(n) && byBox.has(n));

    for (const ex of r.excluded ?? []) warnings.push(`프리셋 ${key} 박스 ${ex.box} 제외: ${ex.reason}`);
    if (r.rescan?.needed) warnings.push(`프리셋 ${key} 재촬영 권고: ${r.rescan.reason}`);

    // positionIdx 재부여(1..k)로 slotId 안정성 유지.
    return chosen.map((boxNo, i) => ({ ...byBox.get(boxNo)!, positionIdx: i + 1 }));
  }

  /** 게이트2 적용: 중복 슬롯 병합(대표만 유지) + zone 라벨. presets/slots/indexable 를 직접 수정. */
  private async applyStage2(
    presets: Preset[],
    slots: ParkingSlot[],
    indexable: IndexableSlot[],
    warnings: string[],
  ): Promise<void> {
    let r;
    try {
      r = await this.deps.brain!.dedupeAndLabel({
        slotsByPreset: presets.map((p) => ({ key: presetKey(p.camIdx, p.presetIdx), slotIds: p.coveredSlotIds })),
      });
    } catch (e) {
      warnings.push(`게이트2 실패(병합 생략): ${e instanceof Error ? e.message : e}`);
      return;
    }
    if (!r) return;

    // 중복 그룹: 첫 요소(대표)만 남기고 나머지 제거.
    const remove = new Set<string>();
    for (const group of r.duplicates ?? []) {
      for (const id of group.slice(1)) remove.add(id);
      if (group.length > 1) warnings.push(`중복 병합: ${group.join(', ')} → ${group[0]}`);
    }
    if (remove.size > 0) {
      for (let i = slots.length - 1; i >= 0; i--) if (remove.has(slots[i].slotId)) slots.splice(i, 1);
      for (let i = indexable.length - 1; i >= 0; i--) if (remove.has(indexable[i].slotId)) indexable.splice(i, 1);
      for (const p of presets) p.coveredSlotIds = p.coveredSlotIds.filter((id) => !remove.has(id));
    }

    // 존 라벨 적용.
    const labels = r.zoneLabels ?? {};
    for (const s of slots) if (labels[s.slotId]) s.zone = labels[s.slotId];
  }

  /** 게이트3 적용: 최종 검증 + 한글 리포트. mismatches 는 경고로 병합. report_ko 반환. */
  private async applyStage3(
    presets: Preset[],
    slots: ParkingSlot[],
    globalIndex: GlobalSlotIndex[],
    expectedFaces: Record<string, number> | undefined,
    warnings: string[],
  ): Promise<string | undefined> {
    const expectedVsFinal = presets.map((p) => ({
      preset: presetKey(p.camIdx, p.presetIdx),
      expected: expectedFaces?.[presetKey(p.camIdx, p.presetIdx)] ?? -1,
      final: p.coveredSlotIds.length,
    }));
    let r;
    try {
      r = await this.deps.brain!.finalReport({
        totalSlots: slots.length,
        globalCount: globalIndex.length,
        expectedVsFinal,
        warnings,
      });
    } catch (e) {
      warnings.push(`게이트3 실패(리포트 생략): ${e instanceof Error ? e.message : e}`);
      return undefined;
    }
    if (!r) return undefined;
    for (const m of r.mismatches ?? []) {
      warnings.push(`불일치 ${m.preset}: 기대 ${m.expected} vs 최종 ${m.final} (${m.likelyCause})`);
    }
    return r.report_ko;
  }
}
