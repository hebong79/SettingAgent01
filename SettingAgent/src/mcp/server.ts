import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadToolsConfig } from '../config/toolsConfig.js';
import { CameraClient } from '../clients/CameraClient.js';
import { VpdClient } from '../clients/VpdClient.js';
import { CRpcClient } from '../clients/CRpcClient.js';

/**
 * SettingAgent 의 능력을 MCP 도구로 노출한다 (아키텍처 §8).
 * 두뇌(LLM)는 이 도구만 호출하므로, 어떤 모델(Claude/Qwen3/Gemma...)이든 동일하게 동작한다.
 * tools.config.json(능력 엔드포인트)과 llm.config.json(두뇌 연결)은 분리되어 있다.
 *
 * 노출 도구는 **두 계층**이다:
 *  1. 저수준 능력 — `camera_req_img` / `camera_req_move` / `vpd_detect`(직접 호출).
 *  2. 제어 평면 프록시 — `unity_rpc`(시뮬레이터 13110) / **`setting_rpc`(셋팅 13020)**.
 *
 * ★ `setting_rpc` 를 추가한 이유: 셸이 없는 MCP 클라이언트(Claude Desktop·Codex 등)는
 *   HTTP 를 직접 부를 수 없어, 13020 의 셋팅 제어 메서드에 닿을 방법이 아예 없었다.
 *   메서드를 하나씩 도구로 등록하지 않고 **범용 프록시 2개**로 노출한다 —
 *   카탈로그가 자기 설명적(mutating/destructive/preconditions)이라 LLM 이 읽고 판단할 수 있고,
 *   RPC 메서드가 늘어도 이 파일은 바뀌지 않는다(unity_rpc 와 동일한 설계).
 */
export function buildMcpServer(): McpServer {
  const cfg = loadToolsConfig();
  const camera = new CameraClient(cfg.camera);
  const vpd = new VpdClient(cfg.vpd);
  const rpc = new CRpcClient(cfg.unityRpc);
  // 자기 자신(13020)의 RPC 평면. 규약이 Unity 와 동형이라 **같은 클라이언트를 재사용**한다(신규 클라이언트 0줄).
  // controlToken 이 설정된 서버에서는 변이 메서드가 403 이 되므로 헤더로 실어 보낸다.
  const settingRpc = new CRpcClient({
    baseUrl: `http://localhost:${cfg.server.port}`,
    timeoutMs: 60_000, // 잡 시작·정본 쓰기까지 포함하므로 카메라 타임아웃보다 넉넉히.
    ...(cfg.viewer?.controlToken ? { headers: { 'x-viewer-token': cfg.viewer.controlToken } } : {}),
  });

  const server = new McpServer({ name: 'parkagent-setting-tools', version: '0.1.0' });

  server.registerTool(
    'camera_req_img',
    {
      title: '카메라 프리셋 캡처',
      description: '지정 카메라/프리셋으로 이동 후 이미지를 캡처한다(base64 JPEG, PTZ 상태 포함).',
      inputSchema: {
        camIdx: z.number().int().positive(),
        presetIdx: z.number().int().positive(),
        pan: z.number().optional(),
        tilt: z.number().optional(),
        zoom: z.number().optional(),
      },
    },
    async ({ camIdx, presetIdx, pan, tilt, zoom }) => {
      const img = await camera.requestImage(camIdx, presetIdx, { pan, tilt, zoom });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              camIdx: img.camIdx,
              presetIdx: img.presetIdx,
              pan: img.pan,
              tilt: img.tilt,
              zoom: img.zoom,
              imgName: img.imgName,
              jpgBase64: img.jpg.toString('base64'),
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'camera_req_move',
    {
      title: '카메라 PTZ 이동',
      description: '지정 카메라를 PTZ 절대값으로 이동한다.',
      inputSchema: {
        camIdx: z.number().int().positive(),
        pan: z.number(),
        tilt: z.number(),
        zoom: z.number(),
      },
    },
    async ({ camIdx, pan, tilt, zoom }) => {
      const ok = await camera.move(camIdx, pan, tilt, zoom);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: ok }) }] };
    },
  );

  server.registerTool(
    'vpd_detect',
    {
      title: 'VPD 차량 검출',
      description: 'base64 JPEG 이미지에서 차량 bbox(정규화 좌표)를 검출한다.',
      inputSchema: { jpgBase64: z.string().min(1) },
    },
    async ({ jpgBase64 }) => {
      const boxes = await vpd.detect(Buffer.from(jpgBase64, 'base64'));
      return { content: [{ type: 'text' as const, text: JSON.stringify({ vehicles: boxes }) }] };
    },
  );

  server.registerTool(
    'unity_rpc',
    {
      title: 'Unity RPC 호출',
      description:
        'Unity(포트 13110) JSON-RPC 2.0 엔드포인트를 호출한다. ' +
        '먼저 unity_rpc_catalog 로 사용 가능한 method 를 조회한 뒤 이 도구를 호출한다. ' +
        'Unity 가 기동 중이지 않으면 연결 오류가 반환된다(크래시 없음).',
      inputSchema: {
        method: z.string().min(1).describe('호출할 RPC method 명 (예: system.ping, scene.load)'),
        params: z.record(z.unknown()).optional().describe('method 에 전달할 파라미터 객체(선택)'),
      },
    },
    async ({ method, params }) => {
      try {
        const result = await rpc.callRpc(method, params as Record<string, unknown> | undefined);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, result }) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: msg }) }] };
      }
    },
  );

  server.registerTool(
    'unity_rpc_catalog',
    {
      title: 'Unity RPC 카탈로그 조회',
      description:
        'Unity 가 노출하는 RPC method 목록을 반환한다. ' +
        'unity_rpc 호출 전에 먼저 이 도구로 사용 가능한 method 를 확인한다. ' +
        'Unity 미기동 시 연결 오류가 반환된다(크래시 없음).',
      inputSchema: {},
    },
    async () => {
      try {
        const catalog = await rpc.getCatalog();
        return { content: [{ type: 'text' as const, text: JSON.stringify(catalog) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: msg }) }] };
      }
    },
  );

  server.registerTool(
    'setting_rpc_catalog',
    {
      title: 'SettingAgent RPC 카탈로그 조회',
      description:
        'SettingAgent(포트 13020)가 노출하는 셋팅 제어 method 목록을 반환한다. ' +
        'setting_rpc 를 호출하기 전에 반드시 이 도구로 사용 가능한 method 와 그 성격을 확인한다. ' +
        '각 항목은 mutating(변이 여부)·destructive(정본 파괴 가능)·requiresCamera(카메라 점유)·' +
        'stability(stable|experimental)·preconditions(선행조건)·note(운영 주의)·available(배선 여부)를 담는다. ' +
        'filter 로 이름 일부를 주면 해당 method 만 걸러낸다(예: "place" · "slot" · "center"). ' +
        '서버 미기동 시 연결 오류가 반환된다(크래시 없음).',
      inputSchema: {
        filter: z.string().optional().describe('method 이름 부분일치 필터(예: place, slot, plate). 미지정 시 전체'),
      },
    },
    async ({ filter }) => {
      try {
        const raw = (await settingRpc.getCatalog()) as unknown as {
          methods?: Array<{ name: string }>;
          unity?: string[];
          issues?: string[];
        };
        const all = Array.isArray(raw.methods) ? raw.methods : [];
        const methods = filter ? all.filter((m) => m.name.includes(filter)) : all;
        const unity = filter ? (raw.unity ?? []).filter((n) => n.includes(filter)) : (raw.unity ?? []);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                methods,
                unity,
                count: methods.length,
                unityCount: unity.length,
                ...(filter ? { filter, totalBeforeFilter: all.length } : {}),
                issues: raw.issues ?? [],
              }),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: msg }) }] };
      }
    },
  );

  server.registerTool(
    'setting_rpc',
    {
      title: 'SettingAgent RPC 호출(셋팅 제어)',
      description:
        'SettingAgent(포트 13020) JSON-RPC 2.0 엔드포인트를 호출해 셋팅 작업을 수행한다. ' +
        '주차면 그리기(place.*) · 주차면 자동생성(grid.*) · DB 컨트롤(slot.*) · 번호판(plate.*) · ' +
        '센터라이징(center.*) · 렌즈 캘리브레이션(lens.*) · 수집(capture.*) · 매핑(setup.*) · 조회(db.*) 를 다룬다. ' +
        '`unity.` 접두어를 붙이면 시뮬레이터(13110) method 로 전달된다(예: unity.cam.setPTZ). ' +
        '★ 반드시 setting_rpc_catalog 로 method 를 먼저 확인하라. ' +
        '★ destructive:true 인 method 는 params 에 confirm:true 가 필요하며 정본(파일·DB)을 되돌리기 어렵게 바꾼다 — ' +
        '사용자가 명시적으로 요청했을 때만 호출한다. ' +
        '오류는 code 로 구분된다: -32001(BUSY, 잡 점유 — 잠시 후 재시도 가능) / -32005(CONFLICT, 가드 거부 — ' +
        '파일·DB 무변경이며 재시도해도 풀리지 않는다) / -32004(UNAVAILABLE, 기능 미배선) / -32002(NOT_FOUND) / ' +
        '-32602(INVALID_PARAMS) / -32003(UPSTREAM, 카메라·검출기 실패).',
      inputSchema: {
        method: z
          .string()
          .min(1)
          .describe('호출할 method 명 (예: slot.list, place.space.add, center.start, unity.cam.list)'),
        params: z.record(z.unknown()).optional().describe('method 에 전달할 파라미터 객체(선택)'),
      },
    },
    async ({ method, params }) => {
      try {
        const result = await settingRpc.callRpc(method, params as Record<string, unknown> | undefined);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, result }) }] };
      } catch (err) {
        // RpcClientError 는 rpc_error 일 때 detail 에 {code,message,data} 를 담는다 — 그대로 실어
        // 두뇌가 BUSY/CONFLICT 를 구분해 재시도 여부를 판단할 수 있게 한다(문자열로 뭉개지 않는다).
        const detail = (err as { detail?: unknown }).detail;
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ ok: false, error: msg, ...(detail ? { detail } : {}) }) },
          ],
        };
      }
    },
  );

  return server;
}

/** stdio MCP 서버로 기동(두뇌가 자식 프로세스로 연결). */
async function main(): Promise<void> {
  const server = buildMcpServer();
  await server.connect(new StdioServerTransport());
}

// 직접 실행 시에만 기동(import 시에는 buildMcpServer 만 노출).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[mcp] 기동 실패:', err);
    process.exit(1);
  });
}
