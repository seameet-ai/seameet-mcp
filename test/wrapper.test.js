/**
 * wrapper.test.js — tests for @seameet/mcp
 *
 * Style mirrors the seameet-app-desktop test suites: plain node + assert,
 * no test framework. Run with: npm test
 *
 * Covers:
 *   - credentials discovery (env override, file, missing → null)
 *   - end-to-end over a real stdio MCP client against a FAKE bridge server:
 *       tools/list proxies GET /mcp-bridge/tools
 *       tools/call proxies POST /mcp-bridge/call-tool
 *       structured error pass-through
 *   - app-not-running: no credentials → status tool + structured error
 */

import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { discoverCredentials, credentialsFilePath, appNotRunningPayload, STATUS_TOOL } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'seameet-mcp.js');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Fake bridge
// ---------------------------------------------------------------------------

const SECRET = 'fake-bridge-secret-for-tests';
const FAKE_TOOLS = [
  {
    name: 'seameet_get_settings',
    description: 'Fake settings tool',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'seameet_start_recording',
    description: 'Fake start tool',
    inputSchema: { type: 'object', properties: { source: { type: 'string' } } },
  },
];

function startFakeBridge() {
  const calls = [];
  const server = http.createServer((req, res) => {
    if (req.headers['x-bridge-secret'] !== SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/mcp-bridge/tools') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, count: FAKE_TOOLS.length, tools: FAKE_TOOLS }));
      }
      if (req.method === 'POST' && req.url === '/mcp-bridge/call-tool') {
        const body = JSON.parse(raw || '{}');
        calls.push(body);
        if (body.name === 'seameet_get_settings') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true, settings: { defaultSaveDirectory: '/fake/dir' } }));
        }
        // Structured error pass-through case
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: false,
          error: { code: 'path_forbidden', message: 'nope', tool: body.name, hint: 'stay in the save dir' },
        }));
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, calls }));
  });
}

function writeCredsFile(dir, port) {
  const file = path.join(dir, 'creds.json');
  fs.writeFileSync(file, JSON.stringify({ port, secret: SECRET, pid: process.pid, startedAt: new Date().toISOString() }));
  return file;
}

async function connectClient(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN],
    env: { ...process.env, ...env },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'wrapper-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seameet-mcp-test-'));

  console.log('\nCredentials discovery:');

  await test('env port+secret override wins', async () => {
    const creds = discoverCredentials({ SEAMEET_BRIDGE_PORT: '4001', SEAMEET_BRIDGE_SECRET: 's' });
    assert.deepStrictEqual(creds, { port: 4001, secret: 's' });
  });

  await test('reads credentials file via SEAMEET_MCP_CREDENTIALS_FILE', async () => {
    const file = writeCredsFile(tmpDir, 4242);
    const creds = discoverCredentials({ SEAMEET_MCP_CREDENTIALS_FILE: file });
    assert.strictEqual(creds.port, 4242);
    assert.strictEqual(creds.secret, SECRET);
  });

  await test('missing file → null (app not running)', async () => {
    const creds = discoverCredentials({ SEAMEET_MCP_CREDENTIALS_FILE: path.join(tmpDir, 'nope.json') });
    assert.strictEqual(creds, null);
  });

  await test('corrupt file → null', async () => {
    const file = path.join(tmpDir, 'corrupt.json');
    fs.writeFileSync(file, '{not json');
    assert.strictEqual(discoverCredentials({ SEAMEET_MCP_CREDENTIALS_FILE: file }), null);
  });

  await test('default path is $TMPDIR/seameet-mcp-bridge-<username>.json', async () => {
    const p = credentialsFilePath({});
    assert.ok(p.startsWith(os.tmpdir()));
    assert.ok(/seameet-mcp-bridge-[a-zA-Z0-9._-]+\.json$/.test(p));
  });

  console.log('\nEnd-to-end against fake bridge (stdio MCP client):');

  const { server: bridge, port, calls } = await startFakeBridge();
  const credsFile = writeCredsFile(tmpDir, port);
  let client;
  try {
    client = await connectClient({ SEAMEET_MCP_CREDENTIALS_FILE: credsFile });

    await test('tools/list proxies the bridge tool inventory', async () => {
      const res = await client.listTools();
      const names = res.tools.map((t) => t.name);
      assert.deepStrictEqual(names, ['seameet_get_settings', 'seameet_start_recording']);
      assert.ok(res.tools[0].inputSchema, 'schemas proxied through');
    });

    await test('tools/call proxies to POST /mcp-bridge/call-tool', async () => {
      const res = await client.callTool({ name: 'seameet_get_settings', arguments: {} });
      assert.ok(!res.isError, 'should not be an error');
      const body = JSON.parse(res.content[0].text);
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.settings.defaultSaveDirectory, '/fake/dir');
      assert.deepStrictEqual(calls[calls.length - 1], { name: 'seameet_get_settings', args: {} });
    });

    await test('structured bridge errors pass through with isError', async () => {
      const res = await client.callTool({ name: 'seameet_start_recording', arguments: { source: 'screen' } });
      assert.strictEqual(res.isError, true);
      const body = JSON.parse(res.content[0].text);
      assert.strictEqual(body.error.code, 'path_forbidden');
      assert.strictEqual(body.error.hint, 'stay in the save dir');
    });
  } finally {
    if (client) await client.close();
  }

  console.log('\nApp not running:');

  let offlineClient;
  try {
    offlineClient = await connectClient({
      SEAMEET_MCP_CREDENTIALS_FILE: path.join(tmpDir, 'missing.json'),
    });

    await test('tools/list falls back to the status tool', async () => {
      const res = await offlineClient.listTools();
      assert.strictEqual(res.tools.length, 1);
      assert.strictEqual(res.tools[0].name, STATUS_TOOL.name);
    });

    await test('tools/call returns structured app_not_running', async () => {
      const res = await offlineClient.callTool({ name: 'seameet_take_screenshot', arguments: {} });
      assert.strictEqual(res.isError, true);
      const body = JSON.parse(res.content[0].text);
      assert.strictEqual(body.error.code, 'app_not_running');
      assert.ok(body.error.hint.includes('launch'), 'hint should tell the agent to launch the app');
    });

    await test('status tool itself reports app_not_running', async () => {
      const res = await offlineClient.callTool({ name: STATUS_TOOL.name, arguments: {} });
      assert.strictEqual(res.isError, true);
      const body = JSON.parse(res.content[0].text);
      assert.strictEqual(body.error.code, 'app_not_running');
    });
  } finally {
    if (offlineClient) await offlineClient.close();
  }

  console.log('\nCredentials exist but app closed (stale file):');

  let staleClient;
  try {
    await new Promise((resolve) => bridge.close(resolve)); // bridge is now DOWN
    staleClient = await connectClient({ SEAMEET_MCP_CREDENTIALS_FILE: credsFile });

    await test('tools/call maps ECONNREFUSED to app_not_running', async () => {
      const res = await staleClient.callTool({ name: 'seameet_get_settings', arguments: {} });
      assert.strictEqual(res.isError, true);
      const body = JSON.parse(res.content[0].text);
      assert.strictEqual(body.error.code, 'app_not_running');
    });
  } finally {
    if (staleClient) await staleClient.close();
  }

  // Sanity on the exported payload helper
  await test('appNotRunningPayload shape', async () => {
    const p = appNotRunningPayload('seameet_x');
    assert.strictEqual(p.success, false);
    assert.strictEqual(p.error.code, 'app_not_running');
    assert.strictEqual(p.error.tool, 'seameet_x');
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log('wrapper.test.js: PASS');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
