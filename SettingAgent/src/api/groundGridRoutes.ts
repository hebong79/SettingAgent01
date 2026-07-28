// 지면 격자 자동 ROI 라우트(/capture/ground-grid/*) — 설계 §6-1. 얇은 진입점(로직은 ground/autoRoiPlan.ts).
//
// 정본 흐름(리더 D-1): 격자(authored) → **PtzCamRoi.json** → slot_setup(파생).
//   · 자동 격자는 `slot_setup` 에 **직접 쓰지 않는다** — DB 쓰기 신규 코드 0줄, `replaceSlotSetup` 호출자 증가 0.
//     (DB 에만 쓰면 다음 finalize 의 `Finalizer.persistSlotSetupFromPlace` 전량 교체로 반드시 소멸한다.)
//   · 파일 갱신은 기존 `applyPlaceRoiUpdate`(픽셀 역변환·구조 보존 검증필) 재사용.
// 안전 게이트: R-2 사람이 항상 이긴다(승인 버튼에서만 적용) / R-4 기존 슬롯 순서·idx 보존, 미매칭 있으면 거부 /
//              R-5 빈 결과·미적용 프리셋은 **파일에 쓰지 않는다**.
//
// 승인(apply) 쓰기 순서 = **`_auto` → `.bak` → 정본**(설계 §2-3). 앞 단계가 실패하면 정본은 손상되지 않는다.
//   · `PtzCamRoi_auto.json` 은 **감사 기록**이다 — 승인 후에도 삭제하지 않고 `_auto.history[]` 로 이력을 잇는다.
//   · 정본에는 `_auto` 키를 넣지 않는다(정본 스키마 불변). 메타는 `_auto.json` 에만 산다.

import { readFile, writeFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { applyPlaceRoiUpdate, normalizePtzCamRoi } from '../capture/placeRoi.js';
import { autoPlaceRoiPathOf, backupPlaceRoiPathOf, fileNameOf } from '../capture/placeRoiPaths.js';
import { assertAutoPromoteSafe, buildApplySpaces, nextGlobalIdxOf, planAutoRoi } from '../ground/autoRoiPlan.js';
import {
  emptyGroundGridFile,
  readGroundGridFile,
  upsertCameraGrids,
  writeGroundGridFile,
} from '../ground/gridStore.js';
import type { ToolsConfig } from '../config/toolsConfig.js';
import { stringify5 } from '../util/round.js';
import { fileErrorReply, parseOr400 } from './routeHelpers.js';

const QuadSchema = z.array(z.object({ x: z.number(), y: z.number() })).length(4);

const BootstrapSchema = z.object({
  camId: z.number().int().positive(),
  presetIdx: z.number().int().positive(),
  /** 기준 주차면 4점(정규화 0..1). */
  quad: QuadSchema,
  cols: z.number().int().min(1).max(200),
  rows: z.number().int().min(1).max(50).default(1),
  colStart: z.number().int().min(-200).max(200).default(0),
  rowStart: z.number().int().min(-50).max(50).default(0),
});

const ApplySchema = BootstrapSchema.extend({
  /** 승인 확인. true 아니면 400 — 승인 없는 저장 불가(R-2). */
  confirm: z.literal(true),
  /** 적용 대상 프리셋. 비면 400. */
  presets: z.array(z.number().int().positive()).min(1),
  /** 기존 슬롯과 대응 없는 자동 quad 를 신규 전역 idx 로 append. 기본 false(기존 슬롯 좌표 교체만). */
  allowNew: z.boolean().default(false),
  /** 기준 주차면의 전역 idx. `_auto.json` 감사기록의 추적성 필드에만 쓰인다(계산에는 무관). */
  refSpaceIdx: z.number().int().positive().optional(),
});

/** `PtzCamRoi_auto.json` 최상위 메타 키의 버전. */
const AUTO_META_VERSION = 1;

/** `_auto.history[]` 1건 — 여러 주차열을 나눠 승인한 이력을 잇는다. */
interface AutoHistoryEntry {
  generatedAt: string;
  camIdx: number;
  appliedPresets: number[];
  refSpaceIdx: number | null;
  backupFile: string;
}

export interface GroundGridRouteDeps {
  /** PtzCamRoi.json 경로(정본 표면). */
  placeRoiFile: string;
  /** ground_grid.json 경로(저작 격자). */
  groundGridFile: string;
  ground: NonNullable<ToolsConfig['ground']>;
}

/**
 * 등록 게이트: `ground.enabled && placeRoiFile && groundGridFile` — 셋 다 있을 때만(가산, 관례).
 * 전부 `{ ok, ... }` 또는 표준 파일에러(404/500). 실패에 throw 하지 않는다.
 */
export function registerGroundGridRoutes(app: FastifyInstance, deps: GroundGridRouteDeps): void {
  // ── 미리보기(부작용 없음). 파일을 **절대 쓰지 않는다**.
  app.post('/capture/ground-grid/bootstrap', async (req, reply) => {
    const body = parseOr400(reply, BootstrapSchema, req.body ?? {});
    if (!body) return;
    // JSON.parse 는 반드시 try 안에 둔다 — 손상 파일에서 500 throw 를 내지 않기 위해
    // (기존 관례: captureRoutes.ts:696-702 `PUT /capture/place-roi`).
    let placeRoiJson: unknown;
    try {
      placeRoiJson = JSON.parse(await readFile(deps.placeRoiFile, 'utf8'));
    } catch (err) {
      fileErrorReply(reply, err, 'PtzCamRoi.json 없음', 'place-roi 읽기/파싱 실패');
      return;
    }
    const { plan, issues } = planAutoRoi({
      placeRoiJson,
      camIdx: body.camId,
      presetIdx: body.presetIdx,
      quadNorm: body.quad,
      cols: body.cols,
      rows: body.rows,
      colStart: body.colStart,
      rowStart: body.rowStart,
      opts: deps.ground,
    });
    if (!plan) return { ok: false, error: '부트스트랩 실패', issues };
    return { ok: true, ...summarize(plan), issues: plan.issues };
  });

  // ── 저장된 격자 조회. 없으면 404.
  app.get('/capture/ground-grid', async (_req, reply) => {
    const file = await readGroundGridFile(deps.groundGridFile);
    if (!file) {
      reply.code(404);
      return { error: 'ground_grid.json 없음' };
    }
    return file;
  });

  // ── 승인 적용: ground_grid.json 저장 + 대상 프리셋 PtzCamRoi.json 갱신(파일 2개).
  app.post('/capture/ground-grid/apply', async (req, reply) => {
    const body = parseOr400(reply, ApplySchema, req.body ?? {});
    if (!body) return;
    // bootstrap 과 동일 — JSON.parse 를 try 안에(손상 파일 → 500 throw 금지).
    // 원문(currentText)은 **`.bak` 을 바이트 단위로 뜨기 위해** 그대로 보관한다(재직렬화 금지).
    let currentText = '';
    let placeRoiJson: unknown;
    try {
      currentText = await readFile(deps.placeRoiFile, 'utf8');
      placeRoiJson = JSON.parse(currentText);
    } catch (err) {
      fileErrorReply(reply, err, 'PtzCamRoi.json 없음', 'place-roi 읽기/파싱 실패');
      return;
    }
    const { plan, issues } = planAutoRoi({
      placeRoiJson,
      camIdx: body.camId,
      presetIdx: body.presetIdx,
      quadNorm: body.quad,
      cols: body.cols,
      rows: body.rows,
      colStart: body.colStart,
      rowStart: body.rowStart,
      opts: deps.ground,
    });
    if (!plan) return { ok: false, error: '부트스트랩 실패', issues };

    // R-4/R-5 사전 게이트 — **하나라도 적용 불가면 파일을 전혀 건드리지 않는다**(부분 적용 금지).
    const targets = plan.presets.filter((p) => body.presets.includes(p.presetIdx));
    if (targets.length !== body.presets.length) {
      const missing = body.presets.filter((i) => !plan.presets.some((p) => p.presetIdx === i));
      return { ok: false, error: `대상 프리셋 없음: ${missing.join(',')}`, issues: plan.issues };
    }
    const blocked = targets.filter((p) => !p.applicable);
    if (blocked.length) {
      return {
        ok: false,
        error: `적용 거부(R-4): preset ${blocked.map((p) => p.presetIdx).join(',')}`,
        issues: [...plan.issues, ...blocked.flatMap((p) => p.issues)],
      };
    }

    const currentJson = placeRoiJson; // 게이트 G2/G3 의 비교 기준(아래 루프는 새 객체를 만들어 재대입한다).
    const { byPreset } = normalizePtzCamRoi(placeRoiJson);
    const nextIdx = nextGlobalIdxOf(placeRoiJson);
    let appended = 0;
    const applied: Array<{ presetIdx: number; spaceCount: number; avgIoU: number | null }> = [];
    for (const p of targets) {
      const fileSpaces = byPreset.get(`${body.camId}:${p.presetIdx}`) ?? [];
      const spaces = buildApplySpaces(p, fileSpaces, {
        allowNew: body.allowNew,
        nextGlobalIdx: nextIdx + appended,
      });
      if (!spaces || spaces.length === 0) {
        // R-5: 빈 결과는 파일에 쓰지 않는다. 여기까지 왔다면 게이트가 새는 것이므로 전량 중단.
        return { ok: false, error: `preset${p.presetIdx}: 적용 spaces 0건 — 파일 무변경`, issues: plan.issues };
      }
      appended += Math.max(0, spaces.length - fileSpaces.length);
      placeRoiJson = applyPlaceRoiUpdate(placeRoiJson, {
        camId: body.camId,
        presetIdx: p.presetIdx,
        spaces,
      });
      applied.push({ presetIdx: p.presetIdx, spaceCount: spaces.length, avgIoU: p.avgIoU });
    }

    // ── S2 파괴 방지 게이트 G1~G4. **DB 접근 전, 파일 계층에서 순수 판정** — 거부면 `_auto.json` 도 쓰지 않는다.
    const gate = assertAutoPromoteSafe(placeRoiJson, currentJson);
    if (!gate.ok) {
      reply.code(409);
      return { ok: false, error: gate.error, detail: gate.detail, issues: plan.issues };
    }

    // 정본에는 `_auto` 를 **넣지 않는다**(정본 스키마 불변 — GET /capture/place-roi raw 서빙·web/core.js 파리티).
    const nextRoot = { ...(placeRoiJson as Record<string, unknown>) };
    delete nextRoot._auto;

    const generatedAt = new Date().toISOString();
    const autoFile = autoPlaceRoiPathOf(deps.placeRoiFile);
    const backupPath = backupPlaceRoiPathOf(deps.placeRoiFile, generatedAt);
    const backupFile = fileNameOf(backupPath);
    const appliedPresets = targets.map((p) => p.presetIdx).sort((a, b) => a - b);
    const extraIssues: string[] = [];

    // ── S3 `_auto.json` 기록(감사 기록 — 승인 후에도 삭제하지 않는다). 손상 시 history 만 포기하고 계속한다.
    let history: AutoHistoryEntry[] = [];
    try {
      const prev = JSON.parse(await readFile(autoFile, 'utf8')) as { _auto?: { history?: unknown } };
      if (Array.isArray(prev?._auto?.history)) history = prev._auto.history as AutoHistoryEntry[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        extraIssues.push(`${fileNameOf(autoFile)} 읽기/파싱 실패 — 이력(history)을 새로 시작한다`);
      }
    }
    const entry: AutoHistoryEntry = {
      generatedAt,
      camIdx: body.camId,
      appliedPresets,
      refSpaceIdx: body.refSpaceIdx ?? null,
      backupFile,
    };
    const autoJson = {
      _auto: {
        version: AUTO_META_VERSION,
        meta: { ...entry, source: 'ground-grid/apply', constants: plan.constants, grid: plan.grid },
        history: [...history, entry],
      },
      ...nextRoot,
    };
    try {
      await writeFile(autoFile, stringify5(autoJson, 2), 'utf8');
    } catch (err) {
      reply.code(500);
      return { ok: false, error: '자동 파일 쓰기 실패 — 정본 무변경', detail: (err as Error).message };
    }

    // ── S4 정본 백업(.bak). 실패하면 **정본을 건드리지 않는다** — 되돌릴 수 없는 갱신을 만들지 않기 위해.
    try {
      await writeFile(backupPath, currentText, 'utf8');
    } catch (err) {
      reply.code(500);
      return { ok: false, error: '백업 실패 — 정본 무변경', detail: (err as Error).message };
    }

    // ── S5 정본(PtzCamRoi.json) 갱신(promote). 실패 시 `.bak` 에서 자동 복원 시도.
    try {
      await writeFile(deps.placeRoiFile, stringify5(nextRoot, 2), 'utf8');
    } catch (err) {
      let restored = true;
      try {
        await writeFile(deps.placeRoiFile, await readFile(backupPath, 'utf8'), 'utf8');
      } catch {
        restored = false;
      }
      reply.code(500);
      return {
        ok: false,
        error: restored ? '정본 갱신 실패 — 백업에서 복원됨' : '정본 갱신 실패 — 자동 복원도 실패',
        backupFile,
        detail: (err as Error).message,
      };
    }

    // ── S5.5 ground_grid.json(추적성 파일). 실패는 **강등**한다 — 이미 성공한 정본 갱신을 되돌리는 편이 더 위험하다.
    try {
      const store = (await readGroundGridFile(deps.groundGridFile)) ?? emptyGroundGridFile();
      await writeGroundGridFile(
        deps.groundGridFile,
        upsertCameraGrids(store, {
          camIdx: body.camId,
          constants: plan.constants,
          grids: [{ grid: plan.grid, appliedPresets, updatedAt: generatedAt }],
        }),
      );
    } catch (err) {
      extraIssues.push(`ground_grid.json 기록 실패(추적성 파일 — 정본은 갱신됨): ${(err as Error).message}`);
    }
    return { ok: true, applied, appended, autoFile: fileNameOf(autoFile), backupFile, issues: [...plan.issues, ...extraIssues] };
  });
}

/** 미리보기 응답 축약(좌표는 프리셋별 pairs 로만 — 응답 폭주 방지). */
function summarize(plan: ReturnType<typeof planAutoRoi>['plan'] & object) {
  return {
    constants: plan.constants,
    grid: plan.grid,
    presets: plan.presets.map((p) => ({
      presetIdx: p.presetIdx,
      generated: p.generated,
      fileCount: p.fileCount,
      matched: p.matched,
      avgIoU: p.avgIoU,
      minIoU: p.minIoU,
      applicable: p.applicable,
      unmatchedFile: p.unmatchedFile,
      // 격자 정합 진단 — matched=0 의 원인이 '창 위치'인지 '다른 주차열'인지 구분하는 유일한 근거.
      onLattice: p.onLattice,
      offLattice: p.offLattice,
      medianResidM: p.medianResidM,
      pairs: p.pairs,
      unmatchedAuto: p.unmatchedAuto,
      issues: p.issues,
    })),
  };
}
