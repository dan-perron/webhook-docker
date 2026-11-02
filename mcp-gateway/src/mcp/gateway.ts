import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { BackendPool } from './backends.js';

/**
 * A per-request MCP server whose tools are the backends' tools. Built after
 * discovery so `initialize` can return the merged instructions.
 */
export async function createGatewayServer(pool: BackendPool): Promise<Server> {
  const { instructions } = await pool.discover();
  const server = new Server(
    { name: 'djperron', version: '1.0.0' },
    { capabilities: { tools: {} }, instructions }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (await pool.discover()).tools,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    pool.callTool(req.params.name, req.params.arguments)
  );
  return server;
}
