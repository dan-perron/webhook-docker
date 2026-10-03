import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { appConfig } from '../config.js';
import { openDb } from '../db/client.js';
import { createServices } from '../services.js';
import { createMcpServer } from './server.js';

// MCP over stdio for Claude Code / Claude Desktop on `signs`:
//   docker exec -i bet-tracker node built/mcp/stdio.js
// Shares the server's SQLite file (WAL). The server process runs the
// background poller; this process only ticks after adding/confirming bets.
// stdout is the protocol channel: log to stderr only.

const db = openDb(appConfig.databasePath);
const server = createMcpServer(createServices(db));
await server.connect(new StdioServerTransport());
console.error(`bet-tracker MCP (stdio) ready on ${appConfig.databasePath}`);
