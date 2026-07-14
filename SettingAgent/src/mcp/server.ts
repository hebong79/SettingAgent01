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
 * 노출 도구: camera.req_img, camera.req_move, vpd.detect.
 * tools.config.json(능력 엔드포인트)과 llm.config.json(두뇌 연결)은 분리되어 있다.
 */
export function buildMcpServer(): McpServer {
  const cfg = loadToolsConfig();
  const camera = new CameraClient(cfg.camera);
  const vpd = new VpdClient(cfg.vpd);
  const rpc = new CRpcClient(cfg.unityRpc);

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
