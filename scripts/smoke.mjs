// End-to-end smoke test over stdio using the registered Claude Code credentials.
// Read-only calls plus dry-run writes. Usage: node scripts/smoke.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execSync } from 'child_process';

const env = { ...process.env };
if (!env.APPLE_KEY_ID) {
  const out = execSync('claude mcp get appstore-connect', { encoding: 'utf-8' });
  for (const m of out.matchAll(/^\s+(APPLE_[A-Z_]+)=(.*)$/gm)) env[m[1]] = m[2].trim();
}
const client = new Client({ name: 'smoke', version: '1' });
await client.connect(new StdioClientTransport({ command: 'node', args: ['dist/index.js'], env }));
const { tools } = await client.listTools();
console.log(`listed ${tools.length} tools`);

const calls = [
  ['list_apps', {}],
  ['app_overview', { app: 'com.rousoftware.rotationgame' }],
  ['check_submission_readiness', { app: 'com.rousoftware.rotationgame' }],
  ['list_screenshots', { app: 'com.rousoftware.rotationgame' }],
  ['get_app_pricing', { app: 'com.rousoftware.rotationgame' }],
  ['list_in_app_purchases', { app: 'com.rousoftware.rotationgame' }],
  ['list_builds', { app: 'com.rousoftware.rotationgame', limit: 3 }],
  ['list_beta_groups', { app: 'com.rousoftware.rotationgame' }],
  ['list_bundle_ids', {}],
  ['list_customer_reviews', { app: 'com.rousoftware.rotationgame' }],
  ['api_search', { query: 'game center leaderboard', limit: 3 }],
  ['set_version_localizations', { app: 'com.rousoftware.rotationgame', localizations: [{ locale: 'en-US', promotionalText: 'Smoke test text' }], dry_run: true }],
  ['set_app_price', { app: 'com.rousoftware.rotationgame', base_territory: 'USA', price: '0.99', dry_run: true }],
  ['create_beta_group', { app: 'com.rousoftware.rotationgame', name: 'Smoke Group', dry_run: true }],
  ['submit_for_review', { app: 'com.rousoftware.rotationgame' }], // must refuse: no confirm
];
let failures = 0;
for (const [name, args] of calls) {
  const t0 = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? '';
  const expectedError = name === 'submit_for_review';
  const ok = expectedError ? res.isError && /confirm/i.test(text) : !res.isError;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (${Date.now() - t0}ms) ${text.replace(/\s+/g, ' ').slice(0, ok ? 140 : 600)}`);
}
await client.close();
process.exit(failures ? 1 : 0);
