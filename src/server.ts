/**
 * MCP server: registers every tool module and dispatches calls.
 * Write tools automatically get a `dry_run` flag that records the API
 * writes they would make instead of sending them.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AscClient, type AscCredentials } from './asc/client.js';
import { toText } from './asc/format.js';
import { allTools } from './tools/index.js';
import type { ToolContext, ToolDef } from './tools/types.js';

export interface ServerOptions {
  credentials: AscCredentials;
  outputDir: string;
  vendorNumber?: string;
}

const DRY_RUN_PROP = {
  type: 'boolean',
  description: 'Preview only: run reads, but record the writes this would make instead of sending them.',
};

function listedSchema(t: ToolDef) {
  if (t.annotations.readOnlyHint) return t.inputSchema;
  return { ...t.inputSchema, properties: { ...t.inputSchema.properties, dry_run: DRY_RUN_PROP } };
}

export function createServer(opts: ServerOptions): Server {
  const tools = allTools();
  const byName = new Map(tools.map(t => [t.name, t]));
  const sharedClient = new AscClient(opts.credentials);

  const server = new Server(
    { name: 'appstore-connect', version: '3.0.0' },
    {
      capabilities: { tools: {} },
      instructions: [
        'App Store Connect operator for the user\'s own Apple developer account.',
        'Start with list_apps / app_overview. Dedicated tools cover the common workflows; for anything else use api_search -> api_describe -> api_request, which reach every endpoint in the API.',
        'Write tools accept dry_run: true to preview the exact API writes. Submitting for review, releasing, deleting, and revoking require confirm: true: ask the user first.',
        'Apple\'s API cannot create new app records or edit App Privacy labels; tell the user to do those once in the App Store Connect website.',
      ].join('\n'),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: listedSchema(t), annotations: t.annotations })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: rawArgs } = request.params;
    const tool = byName.get(name);
    if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    const args: any = rawArgs ?? {};
    const missing = (tool.inputSchema.required ?? []).filter(k => args[k] === undefined || args[k] === null || args[k] === '');
    if (missing.length) return { content: [{ type: 'text', text: `Missing required argument(s): ${missing.join(', ')}` }], isError: true };

    const dryRun = !tool.annotations.readOnlyHint && args.dry_run === true;
    let client = sharedClient;
    if (dryRun) {
      client = new AscClient(opts.credentials);
      client.dryRunLog = [];
    }
    const ctx: ToolContext = { client, outputDir: opts.outputDir, vendorNumber: opts.vendorNumber, dryRun };
    try {
      const result = await tool.handler(args, ctx);
      const payload = dryRun ? { dry_run: true, note: 'Nothing was changed. These are the writes that would be sent:', planned_requests: client.dryRunLog, result } : result;
      return { content: [{ type: 'text', text: toText(payload ?? 'OK') }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: toText(err?.message ?? String(err)) }], isError: true };
    }
  });

  return server;
}
