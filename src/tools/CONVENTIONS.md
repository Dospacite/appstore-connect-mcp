# Tool module conventions

Each module is one file `src/tools/<module>.ts` exporting `export const <module>Tools: ToolDef[]`.
It is registered in `src/tools/index.ts`. Do not edit core files (`src/asc/*`, `src/server.ts`,
`src/tools/helpers.ts`, `src/tools/generic.ts`, `src/tools/types.ts`); put module-specific helpers
in your own file.

## Tool shape

```ts
{
  name: 'snake_case_name',           // unique across all modules
  description: '...',                // say WHAT it does, WHEN to use it, and key gotchas
  inputSchema: { type: 'object', properties: {...}, required: [...] },
  annotations: { title, readOnlyHint?: true, destructiveHint?: true, idempotentHint?: true },
  async handler(args, ctx) { ... return plainJsonValue; }
}
```

- Read-only tools: `readOnlyHint: true`. Every other tool automatically gets a `dry_run` arg
  (the server records writes instead of sending them; GETs still run). Do not declare `dry_run`.
- Irreversible or public actions (submit for review, release, delete, revoke, expire, remove
  from sale, cancel subscriptions offers, send invitations): `destructiveHint: true` and call
  `requireConfirm(args, 'What it does')` before writing. Add `confirm: S.confirm` to properties.
- Accept apps as `app` (`S.app`): resolve with `resolveApp(ctx, args.app)`; it accepts id, bundle id
  or name.
- Versions: `resolveVersion(ctx, appId, platform, versionString?)` finds the editable version.
- Return compact data: `compact()`, `compactList()`, `compactDoc()` from `../asc/format.js`.
  Pick useful fields; avoid dumping huge payloads. Use `fields[...]`/`limit` query params.
- Use `ctx.client.get/post/patch/delete/getAll/download`. Paths are like `/v1/apps/{id}/builds`.
  Relationship helpers: `rel(type, id)`, `rels(type, ids)`. `defined({...})` drops undefined keys
  so PATCH only sends fields the caller set.
- Files: `readLocalFile(path)`; save downloads with `saveOutput(ctx, name, bytes)` and return the path.
- Asset uploads (screenshots, previews, images, review screenshots/attachments): `uploadAsset(ctx, {...})`.
- Errors: throw `new Error('clear message with what to do next')`. API errors already format well.
- Upserts are preferred: e.g. "set localization" creates the locale if missing, otherwise patches.
- Batch where natural (many locales, many files, many testers) so one call does a whole job.
- In dry-run, POSTs return fake ids like `DRY_RUN_3`; code must not crash when it then uses them
  (e.g. skip polling/GETs on ids starting with `DRY_RUN_`, check `ctx.dryRun`).

## Verifying against the spec (mandatory)

Never guess request bodies or attribute names. Check every endpoint you use:

```bash
cd ~/projects/appstore-connect-mcp
npx tsx -e 'import {findOperation,describeOperation} from "./src/asc/spec.ts"; const f=findOperation("POST","/v1/appStoreVersions"); console.log(describeOperation(f.info,f.op))'
npx tsx -e 'import {schemaByName,renderSchema} from "./src/asc/spec.ts"; console.log(renderSchema(schemaByName("AppStoreVersion")))'
npx tsx -e 'import {searchOperations} from "./src/asc/spec.ts"; console.log(searchOperations("price point"))'
```

## Testing against the real account

```bash
npx tsx scripts/try-tool.ts src/tools/<module>.ts <tool> '<json args>'
npx tsc --noEmit -p .        # whole project must typecheck
```

The account is real and has a live app ("Mental Rotation: 3D Puzzles", id 6803721707,
bundle com.rousoftware.rotationgame). Rules:
- Read-only tools: run them for real.
- Write tools: test ONLY with `"dry_run": true`. Never send real writes.
