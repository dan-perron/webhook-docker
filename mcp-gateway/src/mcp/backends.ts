import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

/** One app's MCP endpoint on the stack's network. */
export interface Backend {
  name: string;
  url: string;
  /** Bearer token the backend's /mcp accepts. */
  token: string;
}

interface Discovered {
  instructions?: string;
  tools: Tool[];
}

export interface Discovery {
  /** Every reachable backend's tools, first owner wins a name clash. */
  tools: Tool[];
  owners: Map<string, Backend>;
  instructions: string;
  /** Backends left out this round, with why. */
  errors: string[];
}

const GATEWAY_INSTRUCTIONS =
  "This connector combines several of Dan's self-hosted apps on djperron.com. Each section below is one app's own instructions; its tools are listed alongside the others.";

/**
 * Talks to the backends as an MCP client. Each operation opens a short-lived
 * stateless session (initialize, then the request), like the backends'
 * own stateless HTTP endpoints expect.
 */
export class BackendPool {
  private cache: { at: number; value: Promise<Discovery> } | undefined;

  constructor(
    private readonly backends: Backend[],
    private readonly opts: {
      cacheSeconds: number;
      fetch?: typeof fetch;
      now?: () => number;
      log?: (msg: string) => void;
    }
  ) {}

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  private log(msg: string) {
    (this.opts.log ?? console.warn)(msg);
  }

  private async withClient<T>(
    b: Backend,
    fn: (client: Client) => Promise<T>
  ): Promise<T> {
    const client = new Client({ name: 'mcp-gateway', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(b.url), {
      requestInit: b.token
        ? { headers: { authorization: `Bearer ${b.token}` } }
        : undefined,
      fetch: this.opts.fetch,
    });
    await client.connect(transport);
    try {
      return await fn(client);
    } finally {
      await client.close();
    }
  }

  private async discoverOne(b: Backend): Promise<Discovered> {
    return this.withClient(b, async (client) => {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {});
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      return { instructions: client.getInstructions(), tools };
    });
  }

  private async discoverAll(): Promise<Discovery> {
    const results = await Promise.allSettled(
      this.backends.map((b) => this.discoverOne(b))
    );
    const tools: Tool[] = [];
    const owners = new Map<string, Backend>();
    const sections = [GATEWAY_INSTRUCTIONS];
    const errors: string[] = [];
    results.forEach((r, i) => {
      const b = this.backends[i]!;
      if (r.status === 'rejected') {
        const msg = `${b.name}: unreachable (${String(r.reason)})`;
        errors.push(msg);
        this.log(`mcp-gateway: ${msg}`);
        return;
      }
      for (const t of r.value.tools) {
        const owner = owners.get(t.name);
        if (owner) {
          const msg = `${b.name}: tool ${t.name} already provided by ${owner.name}; skipped`;
          errors.push(msg);
          this.log(`mcp-gateway: ${msg}`);
          continue;
        }
        owners.set(t.name, b);
        tools.push(t);
      }
      if (r.value.instructions) {
        sections.push(`## ${b.name}\n${r.value.instructions}`);
      }
    });
    return { tools, owners, instructions: sections.join('\n\n'), errors };
  }

  /** Merged tools and instructions, cached for `cacheSeconds`. */
  discover(force = false): Promise<Discovery> {
    const fresh =
      this.cache && this.now() - this.cache.at < this.opts.cacheSeconds * 1000;
    if (!force && fresh) return this.cache!.value;
    const value = this.discoverAll();
    this.cache = { at: this.now(), value };
    // Never cache a failed round.
    value.catch(() => (this.cache = undefined));
    return value;
  }

  /** Forward a tool call to the backend that owns it. */
  async callTool(
    name: string,
    args: Record<string, unknown> | undefined
  ): Promise<CallToolResult> {
    let owner = (await this.discover()).owners.get(name);
    // A tool added since the last discovery, or a backend that came back.
    if (!owner) owner = (await this.discover(true)).owners.get(name);
    if (!owner) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    const b = owner;
    try {
      return (await this.withClient(b, (client) =>
        client.callTool({ name, arguments: args ?? {} })
      )) as CallToolResult;
    } catch (e) {
      this.log(`mcp-gateway: ${b.name}.${name} failed: ${String(e)}`);
      return {
        content: [
          {
            type: 'text',
            text: `The ${b.name} app did not answer (${e instanceof Error ? e.message : String(e)}). Try again shortly.`,
          },
        ],
        isError: true,
      };
    }
  }
}
