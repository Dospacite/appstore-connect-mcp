import type { AscClient } from '../asc/client.js';

export interface ToolContext {
  /** API client for this call. In dry-run calls, writes are recorded instead of sent. */
  client: AscClient;
  /** Directory for downloaded reports, profiles, certificates, etc. */
  outputDir: string;
  /** Vendor number for sales/finance reports (APPLE_VENDOR_NUMBER), if configured. */
  vendorNumber?: string;
  dryRun: boolean;
}

export interface ToolAnnotations {
  title?: string;
  /** True for tools that never change anything in App Store Connect. */
  readOnlyHint?: boolean;
  /** True for tools that delete or irreversibly change things (submit, release, revoke). */
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations: ToolAnnotations;
  handler: (args: any, ctx: ToolContext) => Promise<unknown>;
}
