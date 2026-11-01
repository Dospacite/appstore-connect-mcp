#!/usr/bin/env node
/**
 * App Store Connect MCP server entry point.
 * stdio by default; MCP_TRANSPORT=http starts a local HTTP server instead.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import dotenv from 'dotenv';
import { readFileSync, realpathSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from './server.js';

dotenv.config({ quiet: true } as any);

const USE_HTTP = (process.env.MCP_TRANSPORT || 'stdio').toLowerCase() === 'http';
if (!USE_HTTP) {
  // stdout carries the MCP protocol in stdio mode; keep logs on stderr.
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;
}

const expandHome = (p: string) => (p.startsWith('~') ? path.join(homedir(), p.slice(1)) : p);

function loadPrivateKey(): string {
  let key = process.env.APPLE_PRIVATE_KEY?.trim() || '';
  const keyPath = process.env.APPLE_PRIVATE_KEY_PATH?.trim();
  if (!key && keyPath) key = readFileSync(expandHome(keyPath), 'utf-8').trim();
  if (key && !key.includes('BEGIN PRIVATE KEY')) {
    const decoded = Buffer.from(key, 'base64').toString('utf-8').trim();
    if (decoded.includes('BEGIN PRIVATE KEY')) key = decoded;
  }
  return key.replace(/\\n/g, '\n');
}

async function main() {
  const missing = ['APPLE_KEY_ID', 'APPLE_ISSUER_ID'].filter(v => !process.env[v]?.trim());
  if (!process.env.APPLE_PRIVATE_KEY && !process.env.APPLE_PRIVATE_KEY_PATH) missing.push('APPLE_PRIVATE_KEY_PATH');
  if (missing.length) {
    console.error('Missing required environment variables:', missing.join(', '));
    process.exit(1);
  }
  const options = {
    credentials: {
      keyId: process.env.APPLE_KEY_ID!.trim(),
      issuerId: process.env.APPLE_ISSUER_ID!.trim(),
      privateKey: loadPrivateKey(),
    },
    outputDir: expandHome(process.env.ASC_OUTPUT_DIR?.trim() || '~/Downloads/appstore-connect-mcp'),
    vendorNumber: process.env.APPLE_VENDOR_NUMBER?.trim() || undefined,
  };

  if (!USE_HTTP) {
    await createServer(options).connect(new StdioServerTransport());
    console.error('App Store Connect MCP server running on stdio');
    return;
  }

  const { HttpTransport } = await import('./transport/HttpTransport.js');
  const http = new HttpTransport({
    port: parseInt(process.env.PORT || '3001', 10),
    host: process.env.HOST || '127.0.0.1',
    cors: { origin: process.env.CORS_ORIGIN || 'http://127.0.0.1', credentials: true },
  });
  http.setMcpServerFactory(() => createServer(options));
  await http.start();
  const stop = async () => {
    await http.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function isRunDirectly(): boolean {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isRunDirectly()) {
  main().catch(err => {
    console.error('Server crashed:', err);
    process.exit(1);
  });
}
