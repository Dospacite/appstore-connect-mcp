import { accountTools } from './account.js';
import { genericTools } from './generic.js';
import { mediaTools } from './media.js';
import { metadataTools } from './metadata.js';
import { monetizationTools } from './monetization.js';
import { testflightTools } from './testflight.js';
import type { ToolDef } from './types.js';

/** Tool groups. ASC_TOOLSETS=metadata,media,... limits which are exposed (generic is always on). */
export const TOOLSETS: Record<string, ToolDef[]> = {
  metadata: metadataTools,
  media: mediaTools,
  monetization: monetizationTools,
  testflight: testflightTools,
  account: accountTools,
};

export function allTools(selection = process.env.ASC_TOOLSETS): ToolDef[] {
  const wanted = selection?.trim() ? selection.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : Object.keys(TOOLSETS);
  const unknown = wanted.filter(w => !TOOLSETS[w]);
  if (unknown.length) throw new Error(`Unknown ASC_TOOLSETS value(s): ${unknown.join(', ')}. Valid: ${Object.keys(TOOLSETS).join(', ')}`);
  const tools: ToolDef[] = [...genericTools, ...wanted.flatMap(w => TOOLSETS[w])];
  const seen = new Set<string>();
  for (const t of tools) {
    if (seen.has(t.name)) throw new Error(`Duplicate tool name: ${t.name}`);
    seen.add(t.name);
  }
  return tools;
}
