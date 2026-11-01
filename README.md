# App Store Connect MCP Server

An end-to-end [Model Context Protocol](https://modelcontextprotocol.io) server for Apple's
App Store Connect API. It lets an AI assistant (Claude Code, Claude Desktop, Cursor, VS Code)
set up and run apps on the App Store: metadata, screenshots, pricing, in-app purchases,
subscriptions and offers, TestFlight, build uploads, review submission, code signing, users,
reports and webhooks.

Fork of [ryaker/appstore-connect-mcp](https://github.com/ryaker/appstore-connect-mcp), rewritten.

## What it covers

**Every API endpoint.** Apple's OpenAPI spec (v4.5.1, ~1,300 operations) ships with the server.
`api_search` finds an operation, `api_describe` shows its exact parameters and body (allowed
values included), and `api_request` calls it. Game Center, App Clips, Xcode Cloud workflow
editing, alternative distribution and anything else without a dedicated tool go through these.

**179 workflow tools** that do whole jobs in one call:

| Toolset | Tools |
| --- | --- |
| `metadata` | apps, app info and categories, age rating, versions, store text for many locales at once, build attachment, App Review details, phased release, manual release, readiness check, submit / cancel review, EULA |
| `media` | screenshots (upload many locales and sizes, replace, reorder, copy between locales), app previews, review attachments, routing coverage, custom product pages, in-app events, product page optimization experiments |
| `monetization` | territories, app price and availability, in-app purchases, subscription groups and subscriptions, prices in every territory from one base price, introductory / promotional / win-back offers, offer codes, promoted purchases |
| `testflight` | builds, `.ipa` / `.pkg` upload over the API (no Xcode or Transporter needed), export compliance, beta groups and testers, What to Test, beta review, feedback and crash logs, Xcode Cloud builds, sandbox testers |
| `account` | bundle IDs and capabilities, certificates (key and CSR made locally with openssl, `.p12` export), provisioning profiles, devices, users and invitations, customer reviews and replies, sales / finance / analytics reports, performance metrics and diagnostics, webhooks |

**Safety.**
- Every write tool takes `dry_run: true`. Reads still run, and the writes it would send come back without being sent.
- Public or irreversible actions need `confirm: true`. That covers submitting, releasing, deleting, revoking, sending invites and replying to reviews.
- Credentials only go to `api.appstoreconnect.apple.com`.

**What Apple's API can't do** (do these once on the App Store Connect website): create a new
app record, fill in App Privacy labels, accept agreements / tax / banking, read Resolution Center
messages.

## Setup

1. In [App Store Connect](https://appstoreconnect.apple.com), open **Users and Access → Integrations →
   App Store Connect API → Team Keys**. Create a key and download the `.p8` file. Note the Key ID
   and the Issuer ID.
   - Use the **Admin** role for everything, or **App Manager** if you don't need users, signing or finance.
2. Build and register:

```bash
git clone https://github.com/Dospacite/appstore-connect-mcp.git
cd appstore-connect-mcp
npm install            # also builds
./setup.sh             # asks for Key ID, Issuer ID and .p8 path; registers with Claude Code
```

Other clients: add a stdio server.

```json
{
  "mcpServers": {
    "appstore-connect": {
      "command": "node",
      "args": ["/absolute/path/to/appstore-connect-mcp/dist/index.js"],
      "env": {
        "APPLE_KEY_ID": "YOUR_KEY_ID",
        "APPLE_ISSUER_ID": "YOUR_ISSUER_ID",
        "APPLE_PRIVATE_KEY_PATH": "/absolute/path/to/AuthKey_XXXX.p8"
      }
    }
  }
}
```

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `APPLE_KEY_ID` | yes | API key ID |
| `APPLE_ISSUER_ID` | yes | Issuer ID |
| `APPLE_PRIVATE_KEY_PATH` | yes* | Path to the `.p8` file (*or `APPLE_PRIVATE_KEY` with its contents) |
| `APPLE_VENDOR_NUMBER` | no | Needed for sales and finance reports (Payments and Financial Reports page) |
| `ASC_OUTPUT_DIR` | no | Where reports, certificates and profiles are saved (default `~/Downloads/appstore-connect-mcp`) |
| `ASC_TOOLSETS` | no | Comma list to expose fewer tools, e.g. `metadata,media,testflight`. The 4 generic tools are always on. Useful for clients that load every tool definition up front (all 183 are about 50k tokens). |
| `MCP_TRANSPORT` | no | `http` to serve over HTTP on `127.0.0.1:${PORT:-3001}/mcp` instead of stdio |

## Example requests

- "Give me an overview of my app and tell me what's blocking submission."
- "Create version 1.1, write release notes in English, German and Japanese, attach the latest build, and submit it once I approve."
- "Upload the screenshots in ~/shots/iphone and ~/shots/ipad for en-US, replacing the old ones, then copy them to de-DE."
- "Add a monthly subscription at $4.99 in every territory with a one-week free trial."
- "Upload ~/build/App.ipa, give it to the Beta Testers group, set What to Test, and submit for beta review."
- "Create an App Store distribution certificate and profile for com.example.app."
- "Download last month's sales report and summarize units by product."

## Development

```bash
npm run build
npx tsx scripts/try-tool.ts src/tools/metadata.ts app_overview '{"app":"com.example.app"}'
node scripts/smoke.mjs      # end-to-end test over stdio (reads + dry runs)
npm run update-spec         # refresh Apple's OpenAPI spec
```

Code layout: `src/asc/` (API client, spec index, formatting), `src/tools/` (one file per
toolset, conventions in `src/tools/CONVENTIONS.md`), `src/server.ts` (dispatch, dry run).

License: MIT
