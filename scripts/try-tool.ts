/**
 * Dev helper: run one tool from one module against the real API.
 *   npx tsx scripts/try-tool.ts <module-file> <tool-name> '<json-args>'
 * e.g. npx tsx scripts/try-tool.ts src/tools/generic.ts api_search '{"query":"builds"}'
 * Credentials come from env (APPLE_KEY_ID, APPLE_ISSUER_ID, APPLE_PRIVATE_KEY_PATH)
 * or, if unset, from the Claude Code "appstore-connect" MCP registration.
 * dry_run:true in args records writes instead of sending them.
 */
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import { homedir } from 'os';
import { AscClient } from '../src/asc/client.js';
import type { ToolDef, ToolContext } from '../src/tools/types.js';

function env() {
  if (!process.env.APPLE_KEY_ID) {
    const out = execSync('claude mcp get appstore-connect', { encoding: 'utf-8' });
    for (const m of out.matchAll(/^\s+(APPLE_[A-Z_]+)=(.*)$/gm)) process.env[m[1]] = m[2].trim();
  }
  return {
    keyId: process.env.APPLE_KEY_ID!,
    issuerId: process.env.APPLE_ISSUER_ID!,
    privateKey: readFileSync(process.env.APPLE_PRIVATE_KEY_PATH!.replace(/^~/, homedir()), 'utf-8'),
  };
}

const [file, toolName, json] = process.argv.slice(2);
const mod = await import(path.resolve(file));
const tools: ToolDef[] = Object.values(mod).filter(Array.isArray).flat() as ToolDef[];
const tool = tools.find(t => t.name === toolName);
if (!tool) {
  console.error(`Tool ${toolName} not in ${file}. Available: ${tools.map(t => t.name).join(', ')}`);
  process.exit(1);
}
const args = json ? JSON.parse(json) : {};
const client = new AscClient(env());
const dryRun = !tool.annotations.readOnlyHint && args.dry_run === true;
if (dryRun) client.dryRunLog = [];
const ctx: ToolContext = { client, outputDir: path.join(homedir(), 'Downloads/appstore-connect-mcp'), dryRun, vendorNumber: process.env.APPLE_VENDOR_NUMBER };
try {
  const result = await tool.handler(args, ctx);
  console.log(JSON.stringify(dryRun ? { planned_requests: client.dryRunLog, result } : result, null, 1).slice(0, process.env.FULL ? undefined : 20000));
} catch (e: any) {
  console.error('TOOL ERROR:', e.message);
  process.exit(2);
}
