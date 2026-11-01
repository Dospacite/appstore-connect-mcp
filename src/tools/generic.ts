/**
 * Generic, spec-driven tools. Together they reach every App Store Connect
 * API endpoint, including ones without a dedicated tool.
 */
import { compactDoc } from '../asc/format.js';
import { describeOperation, findOperation, pathMatches, operations, renderSchema, schemaByName, schemaNames, searchOperations, specVersion } from '../asc/spec.js';
import { saveOutput } from './helpers.js';
import type { ToolDef } from './types.js';

export const genericTools: ToolDef[] = [
  {
    name: 'api_search',
    description:
      'Search all ~1300 App Store Connect API operations by keywords (e.g. "subscription offer code", "game center leaderboard", "app clip experience", "custom product page", "xcode cloud workflow"). Use this when no dedicated tool fits, then api_describe, then api_request.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords' },
        method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'DELETE'], description: 'Only this HTTP method' },
        limit: { type: 'number', description: 'Max results (default 25)' },
        include_relationship_endpoints: { type: 'boolean', description: 'Also include /relationships/ linkage endpoints (default false)' },
      },
      required: ['query'],
    },
    annotations: { title: 'Search API operations', readOnlyHint: true },
    async handler(args) {
      const results = searchOperations(args.query, { method: args.method, limit: args.limit, includeRelationshipEndpoints: args.include_relationship_endpoints });
      return { specVersion: specVersion(), results, hint: results.length ? 'Call api_describe with an operationId to see parameters and body shape.' : 'No match; try other words (the API uses terms like appStoreVersions, betaGroups, inAppPurchases, subscriptions).' };
    },
  },
  {
    name: 'api_describe',
    description:
      'Show exactly how to call one App Store Connect API operation: path params, filters with allowed values, include/sort options, the full request body shape (required fields have no "?"), and the response type.',
    inputSchema: {
      type: 'object',
      properties: {
        operation_id: { type: 'string', description: 'operationId from api_search, e.g. appStoreVersions_createInstance' },
        method: { type: 'string', description: 'Alternative to operation_id: HTTP method' },
        path: { type: 'string', description: 'Alternative to operation_id: path, template or concrete (/v1/apps/123/builds)' },
        show_fields: { type: 'boolean', description: 'List values for fields[...] sparse fieldset params' },
      },
    },
    annotations: { title: 'Describe API operation', readOnlyHint: true },
    async handler(args) {
      const found = args.operation_id ? findOperation(args.operation_id) : args.method && args.path ? findOperation(args.method, args.path) : undefined;
      if (!found) throw new Error('Operation not found. Use api_search first and pass its operationId.');
      return describeOperation(found.info, found.op, !!args.show_fields);
    },
  },
  {
    name: 'api_schema',
    description:
      'Show a schema from the App Store Connect API spec (e.g. "AppStoreVersion" for its attributes, "SubscriptionCreateRequest" for a body). Pass a partial name to list matching schema names.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Schema name or part of it' },
        depth: { type: 'number', description: 'How deep to expand nested $refs (default 5)' },
      },
      required: ['name'],
    },
    annotations: { title: 'Show API schema', readOnlyHint: true },
    async handler(args) {
      const s = schemaByName(args.name);
      if (s) return `${args.name} = ${renderSchema(s, 0, args.depth ?? 5, [args.name])}`;
      const matches = schemaNames(args.name).slice(0, 60);
      if (!matches.length) throw new Error(`No schema matches "${args.name}"`);
      return { matches };
    },
  },
  {
    name: 'api_request',
    description:
      'Call any App Store Connect API endpoint (base https://api.appstoreconnect.apple.com). Use api_describe first to get the exact body shape. GET supports all_pages to follow pagination. Responses are flattened: attributes inline, relationships as ids. DELETE needs confirm: true. Writes support dry_run.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'DELETE'] },
        path: { type: 'string', description: 'Path like /v1/apps/123/appStoreVersions, or a full "next" link from a previous result' },
        query: { type: 'object', description: 'Query params, e.g. {"filter[platform]":"IOS","include":"build","limit":50}. Arrays become comma lists.', additionalProperties: true },
        body: { type: 'object', description: 'JSON:API request body: {"data":{"type":..,"attributes":{..},"relationships":{..}}}', additionalProperties: true },
        all_pages: { type: 'boolean', description: 'GET only: follow pagination' },
        max_items: { type: 'number', description: 'GET with all_pages: max items (default 500)' },
        raw: { type: 'boolean', description: 'Return the unflattened JSON:API response' },
        save_to_file: { type: 'string', description: 'Also save the full JSON response to this file name in the output directory' },
        confirm: { type: 'boolean', description: 'Required true for DELETE' },
      },
      required: ['method', 'path'],
    },
    annotations: { title: 'Call API endpoint', destructiveHint: true, openWorldHint: true },
    async handler(args, ctx) {
      const method = String(args.method).toUpperCase();
      const isNextLink = String(args.path).startsWith('http');
      const concrete = isNextLink ? new URL(args.path).pathname : String(args.path).split('?')[0];
      const known = operations().some(o => o.method === method && pathMatches(o.path, concrete.replace(/\/+$/, '')));
      if (!known) {
        const alts = operations().filter(o => pathMatches(o.path, concrete.replace(/\/+$/, ''))).map(o => o.method);
        throw new Error(
          alts.length
            ? `${method} is not supported on ${concrete}. Supported: ${alts.join(', ')}`
            : `${concrete} is not an App Store Connect API path. Use api_search to find the right endpoint.`,
        );
      }
      if (method === 'DELETE' && args.confirm !== true && !ctx.dryRun) {
        throw new Error('DELETE requires confirm: true (after the user agrees), or dry_run: true to preview.');
      }
      let result: any;
      if (method === 'GET' && args.all_pages) {
        const all = await ctx.client.getAll(args.path, args.query ?? {}, args.max_items ?? 500);
        result = args.raw ? all : { data: all.data.map(r => compactDoc({ data: r }).data), included: all.included.length ? all.included.map(r => compactDoc({ data: r }).data) : undefined, count: all.data.length, total: all.total, truncated: all.truncated || undefined };
      } else {
        const doc = await ctx.client.request(method, args.path, { query: args.query, body: args.body });
        result = args.raw ? doc : compactDoc(doc);
      }
      if (args.save_to_file) {
        const file = saveOutput(ctx, args.save_to_file, JSON.stringify(result, null, 2));
        return { saved_to: file, preview: JSON.stringify(result).slice(0, 2000) };
      }
      return result;
    },
  },
];
