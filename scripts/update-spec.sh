#!/usr/bin/env bash
# Refresh the bundled App Store Connect OpenAPI spec from Apple.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp="$(mktemp -d)"
curl -fsSL -o "$tmp/spec.zip" https://developer.apple.com/sample-code/app-store-connect/app-store-connect-openapi-specification.zip
unzip -q -o "$tmp/spec.zip" -d "$tmp"
gzip -9 -c "$tmp/openapi.oas.json" > spec/openapi.json.gz
node -e 'const z=require("zlib"),f=require("fs");console.log("Spec version",JSON.parse(z.gunzipSync(f.readFileSync("spec/openapi.json.gz"))).info.version)'
rm -rf "$tmp"
