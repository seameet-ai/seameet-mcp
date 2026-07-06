/**
 * wrapper.test.js — tests for @seameet/mcp (dual-mode).
 *
 * Plain node + assert, no framework. Run with: npm test.
 * Fully hermetic: a fake desktop bridge AND a fake cloud server (remote worker
 * /mcp + mcp-device /device) so nothing hits the network.
 *
 * Covers:
 *   - credentials discovery + cloud-key loading
 *   - superset tools/list (desktop ∪ cloud ∪ seameet_status)
 *   - desktop routing + structured error pass-through
 *   - cloud routing with an API key
 *   - device flow: no key → auth_required challenge → approve → mint → succeed
 *   - capability errors: desktop tool while app down → app_not_running
 *   - seameet_status reports both modes
 */

import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  discoverCredentials, credentialsFilePath, appNotRunningPayload, STATUS_TOOL,
  loadCloudKey, cloudCredentialPath,
} from '../src/index.js';

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
// Fake desktop bridge
// ---------------------------------------------------------------------------

const SECRET = 'fake-bridge-secret-for-tests';
const FAKE_TOOLS = [
  { name: 'seameet_get_settings', description: 'Fake settings tool', inputSchema: { type: 'object', properties: {} } },
  { name: 'seameet_start_recording', description: 'Fake start tool', inputSchema: { type: 'object', properties: { source: { type: 'string' } } } },
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
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: { code: 'path_forbidden', message: 'nope', tool: body.name, hint: 'stay in the save dir' } }));
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, calls })));
}

// ---------------------------------------------------------------------------
// Fake cloud: remote worker (/mcp) + mcp-device (/device)
// ---------------------------------------------------------------------------

const FAKE_CLOUD_TOOLS = [
  { name: 'seameet_list_recent_recordings', description: 'cloud read', inputSchema: { type: 'object', properties: {} } },
  { name: 'seameet_create_webhook', description: 'cloud write', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
];
const MINTED_KEY = 'smk_minted00000000000000000000000000000000';

function startFakeCloud() {
  const state = { approved: false, calls: [], rejectKey: null };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/mcp') {
        const auth = req.headers['authorization'] || '';
        if (!auth.startsWith('Bearer smk_')) return send(401, { error: 'unauthorized' });
        if (state.rejectKey && auth === `Bearer ${state.rejectKey}`) return send(401, { error: 'unauthorized' }); // revoked
        if (body.method === 'tools/list') return send(200, { jsonrpc: '2.0', id: body.id, result: { tools: FAKE_CLOUD_TOOLS } });
        if (body.method === 'tools/call') {
          state.calls.push({ auth, name: body.params?.name, args: body.params?.arguments });
          return send(200, { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: body.params?.name }) }] } });
        }
        return send(200, { jsonrpc: '2.0', id: body.id, result: {} });
      }
      if (req.url === '/device') {
        if (body.op === 'start') return send(200, { device_code: 'dev-code-123', user_code: 'TEST-CODE', verification_uri: 'https://app.seameet.ai/link', verification_uri_complete: 'https://app.seameet.ai/link?code=TEST-CODE', expires_in: 600, interval: 1 });
        if (body.op === 'poll') return send(200, state.approved ? { status: 'approved', apiKey: MINTED_KEY } : { status: 'pending' });
      }
      send(404, { error: 'nf' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state })));
}

function writeCredsFile(dir, port) {
  const file = path.join(dir, `creds-${port}.json`);
  fs.writeFileSync(file, JSON.stringify({ port, secret: SECRET, pid: process.pid }));
  return file;
}

async function connectClient(env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN], env: { ...process.env, ...env }, stderr: 'ignore' });
  const client = new Client({ name: 'wrapper-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seameet-mcp-test-'));
  const noDesktop = path.join(tmpDir, 'missing.json');
  const unreachableCloud = { SEAMEET_REMOTE_URL: 'http://127.0.0.1:1/mcp', SEAMEET_DEVICE_URL: 'http://127.0.0.1:1/device' };

  console.log('\nCredentials discovery:');
  await test('env port+secret override wins', async () => {
    assert.deepStrictEqual(discoverCredentials({ SEAMEET_BRIDGE_PORT: '4001', SEAMEET_BRIDGE_SECRET: 's' }), { port: 4001, secret: 's' });
  });
  await test('reads credentials file', async () => {
    const file = writeCredsFile(tmpDir, 4242);
    const creds = discoverCredentials({ SEAMEET_MCP_CREDENTIALS_FILE: file });
    assert.strictEqual(creds.secret, SECRET);
  });
  await test('missing/corrupt file → null', async () => {
    assert.strictEqual(discoverCredentials({ SEAMEET_MCP_CREDENTIALS_FILE: noDesktop }), null);
  });
  await test('default bridge path shape', async () => {
    assert.ok(/seameet-mcp-bridge-[a-zA-Z0-9._-]+\.json$/.test(credentialsFilePath({})));
  });
  await test('loadCloudKey: env SEAMEET_API_KEY wins', async () => {
    assert.strictEqual(loadCloudKey({ SEAMEET_API_KEY: 'smk_env' }), 'smk_env');
    assert.strictEqual(loadCloudKey({ SEAMEET_CLOUD_CREDENTIALS_FILE: noDesktop }), null);
  });

  const bridge = await startFakeBridge();
  const cloud = await startFakeCloud();
  const cloudEnv = (extra = {}) => ({
    SEAMEET_REMOTE_URL: `http://127.0.0.1:${cloud.port}/mcp`,
    SEAMEET_DEVICE_URL: `http://127.0.0.1:${cloud.port}/device`,
    SEAMEET_CLOUD_CREDENTIALS_FILE: path.join(tmpDir, `cloud-${Math.random().toString(36).slice(2)}.json`),
    ...extra,
  });

  console.log('\nSuperset (desktop + cloud, with API key):');
  const credsFile = writeCredsFile(tmpDir, bridge.port);
  let c1;
  try {
    c1 = await connectClient(cloudEnv({ SEAMEET_MCP_CREDENTIALS_FILE: credsFile, SEAMEET_API_KEY: 'smk_testkey' }));
    await test('tools/list returns desktop ∪ cloud ∪ status', async () => {
      const names = (await c1.listTools()).tools.map((t) => t.name);
      for (const n of ['seameet_get_settings', 'seameet_start_recording', 'seameet_list_recent_recordings', 'seameet_create_webhook', 'seameet_status', 'seameet_logout']) {
        assert.ok(names.includes(n), `missing ${n} — got ${names.join(',')}`);
      }
    });
    await test('desktop tool routes to the bridge', async () => {
      const res = await c1.callTool({ name: 'seameet_get_settings', arguments: {} });
      assert.ok(!res.isError);
      assert.strictEqual(JSON.parse(res.content[0].text).settings.defaultSaveDirectory, '/fake/dir');
    });
    await test('cloud tool routes to the worker with the API key', async () => {
      const res = await c1.callTool({ name: 'seameet_list_recent_recordings', arguments: {} });
      assert.ok(!res.isError, 'cloud call should succeed');
      const last = cloud.state.calls[cloud.state.calls.length - 1];
      assert.strictEqual(last.auth, 'Bearer smk_testkey');
      assert.strictEqual(last.name, 'seameet_list_recent_recordings');
    });
    await test('bridge structured errors pass through', async () => {
      const res = await c1.callTool({ name: 'seameet_start_recording', arguments: { source: 'screen' } });
      assert.strictEqual(res.isError, true);
      assert.strictEqual(JSON.parse(res.content[0].text).error.code, 'path_forbidden');
    });
    await test('seameet_status reports both modes connected/authorized', async () => {
      const res = await c1.callTool({ name: 'seameet_status', arguments: {} });
      const body = JSON.parse(res.content[0].text);
      assert.strictEqual(body.desktop.mode, 'connected');
      assert.strictEqual(body.cloud.mode, 'authorized');
    });
  } finally {
    if (c1) await c1.close();
  }

  console.log('\nCloud-only + device flow (no desktop, no key):');
  let c2;
  try {
    cloud.state.approved = false;
    c2 = await connectClient(cloudEnv({ SEAMEET_MCP_CREDENTIALS_FILE: noDesktop }));
    await test('tools/list lists cloud tools + status (no desktop)', async () => {
      const names = (await c2.listTools()).tools.map((t) => t.name);
      assert.ok(names.includes('seameet_list_recent_recordings'));
      assert.ok(names.includes('seameet_status'));
      assert.ok(!names.includes('seameet_get_settings'), 'no desktop tools when app is down');
    });
    await test('cloud tool with no key → auth_required challenge', async () => {
      const res = await c2.callTool({ name: 'seameet_list_recent_recordings', arguments: {} });
      assert.strictEqual(res.isError, true);
      const body = JSON.parse(res.content[0].text);
      assert.strictEqual(body.error.code, 'auth_required');
      assert.strictEqual(body.error.user_code, 'TEST-CODE');
      assert.ok(body.error.hint.includes('app.seameet.ai/link'));
    });
    await test('after approval → next call mints + succeeds', async () => {
      cloud.state.approved = true;
      const res = await c2.callTool({ name: 'seameet_list_recent_recordings', arguments: {} });
      assert.ok(!res.isError, `expected success, got ${res.content[0].text}`);
      const last = cloud.state.calls[cloud.state.calls.length - 1];
      assert.strictEqual(last.auth, `Bearer ${MINTED_KEY}`, 'used the minted key');
    });
    await test('seameet_logout forgets the key → next cloud call re-challenges', async () => {
      const lo = await c2.callTool({ name: 'seameet_logout', arguments: {} });
      assert.ok(!lo.isError);
      assert.strictEqual(JSON.parse(lo.content[0].text).forgotCachedKey, true);
      // key gone + pending flow cleared → next cloud call issues a fresh challenge
      const res = await c2.callTool({ name: 'seameet_list_recent_recordings', arguments: {} });
      assert.strictEqual(res.isError, true);
      assert.strictEqual(JSON.parse(res.content[0].text).error.code, 'auth_required');
    });
    await test('desktop tool while app down → app_not_running', async () => {
      const res = await c2.callTool({ name: 'seameet_take_screenshot', arguments: {} });
      assert.strictEqual(res.isError, true);
      assert.strictEqual(JSON.parse(res.content[0].text).error.code, 'app_not_running');
    });
  } finally {
    if (c2) await c2.close();
  }

  console.log('\nCloud mode, revoked cached key:');
  let cR;
  try {
    // A cached key the fake cloud now rejects (revoked). tools/list must NOT drop
    // cloud tools — it falls back to the discovery key so the agent can still call
    // one and trigger re-auth.
    const revokedKey = 'smk_revoked000000000000000000000000000000';
    const revokedFile = path.join(tmpDir, `revoked-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(revokedFile, JSON.stringify({ apiKey: revokedKey }));
    cloud.state.rejectKey = revokedKey;
    cR = await connectClient(cloudEnv({ SEAMEET_MCP_CREDENTIALS_FILE: noDesktop, SEAMEET_CLOUD_CREDENTIALS_FILE: revokedFile }));
    await test('revoked cached key → cloud tools still listed (discovery fallback)', async () => {
      const names = (await cR.listTools()).tools.map((t) => t.name);
      assert.ok(names.includes('seameet_list_recent_recordings'), 'cloud tools survive a revoked key');
    });
    await test('revoked cached key is deleted on discovery → next call re-auths', async () => {
      assert.ok(!fs.existsSync(revokedFile), 'revoked key file removed so the next cloud call re-authorizes');
    });
  } finally {
    if (cR) await cR.close();
    cloud.state.rejectKey = null;
  }

  console.log('\nOffline (no desktop, cloud unreachable):');
  let c3;
  try {
    c3 = await connectClient({ ...unreachableCloud, SEAMEET_MCP_CREDENTIALS_FILE: noDesktop, SEAMEET_CLOUD_CREDENTIALS_FILE: path.join(tmpDir, 'nokey.json') });
    await test('tools/list → just the local tools (status + logout)', async () => {
      const names = (await c3.listTools()).tools.map((t) => t.name);
      assert.deepStrictEqual(names, ['seameet_status', 'seameet_logout']);
    });
  } finally {
    if (c3) await c3.close();
  }

  console.log('\nStale bridge (creds exist, app closed):');
  let c4;
  try {
    await new Promise((r) => bridge.server.close(r));
    c4 = await connectClient({ ...unreachableCloud, SEAMEET_MCP_CREDENTIALS_FILE: credsFile, SEAMEET_CLOUD_CREDENTIALS_FILE: path.join(tmpDir, 'nokey2.json') });
    await test('desktop tool → app_not_running (ECONNREFUSED)', async () => {
      const res = await c4.callTool({ name: 'seameet_get_settings', arguments: {} });
      assert.strictEqual(res.isError, true);
      assert.strictEqual(JSON.parse(res.content[0].text).error.code, 'app_not_running');
    });
  } finally {
    if (c4) await c4.close();
    await new Promise((r) => cloud.server.close(r));
  }

  await test('appNotRunningPayload shape', async () => {
    const p = appNotRunningPayload('seameet_x');
    assert.strictEqual(p.error.code, 'app_not_running');
    assert.strictEqual(p.error.tool, 'seameet_x');
  });
  await test('cloudCredentialPath defaults under ~/.seameet', async () => {
    assert.ok(cloudCredentialPath({}).includes('.seameet'));
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log('wrapper.test.js: PASS');
}

run().catch((err) => { console.error(err); process.exit(1); });
