/**
 * upload.test.js — tests for seameet_transcribe_file (src/upload.js).
 *
 * Plain node + assert, no framework. Run with: npm test.
 * Hermetic: fetch is mocked (unit tests) or pointed at a local fake server
 * (stdio integration), and every file is a temp file.
 *
 * Covers the issue's client test table: extension allowlist, size bounds,
 * 8 MiB part split, Content-Length on each PUT, ≤3 parts in flight,
 * retry/backoff, abort on failure, the web-upload identity, duration 0
 * omitted, progress notifications, every error-table row, the return shape
 * (webUrl, pollAfterSeconds clamps), the code-point title cut, and a failing
 * budget GET that does not block.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  ALLOWED_EXTENSIONS, DEFAULT_SUPABASE_URL, DEFAULT_STT_PROXY_URL, DEFAULT_WEB_URL, DEFAULT_SUPABASE_ANON_KEY,
  MAX_FILE_BYTES, MAX_JSON_BYTES, MAX_PARTS_IN_FLIGHT, PART_BYTES, PART_PUT_BASE_TIMEOUT_MS, PART_PUT_TIMEOUT_MS, TRANSCRIBE_TOOL, anySignal, checkFile, cutCodePoints, partCount, pollAfterSeconds,
  transcribeFile, uploadConfig,
} from '../src/upload.js';
import { forgetCachedKeyIf } from '../src/index.js';

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
// Fixtures
// ---------------------------------------------------------------------------

const KEY = 'smk_' + 'a'.repeat(40);
const ASSET_ID = '11111111-2222-3333-4444-555555555555';
const MiB = 1024 * 1024;
const ENV = {
  SEAMEET_SUPABASE_URL: 'https://sb.test',
  SEAMEET_SUPABASE_ANON_KEY: 'anon-test',
  SEAMEET_STT_PROXY_URL: 'https://stt.test',
  SEAMEET_WEB_URL: 'https://web.test',
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seameet-upload-test-'));

/** A sparse temp file of `size` bytes (reads return zeros; nothing is written). */
function tmpFile(name, size) {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, '');
  if (size > 0) fs.truncateSync(file, size);
  return file;
}

const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * A scripted fetch. `routes` overrides per sync-api op (`op:<name>`), per
 * stt route (`GET /v1/file/budget`, `POST /v1/file/jobs`) or `PUT` (R2 part).
 * Each override is (ctx) => Response | Promise<Response>.
 */
function mockFetch(routes = {}) {
  const calls = [];
  const state = { inflight: 0, maxInflight: 0, putAttempts: {} };
  const fetchImpl = async (url, init = {}) => {
    state.redirects = state.redirects || [];
    state.redirects.push(init.redirect);
    const u = new URL(url);
    const method = init.method || 'GET';
    const headers = init.headers || {};
    if (u.host === 'sb.test' && u.pathname === '/functions/v1/sync-api') {
      const body = JSON.parse(init.body);
      calls.push({ kind: 'sync', op: body.op, body, headers });
      const h = routes[`op:${body.op}`];
      if (h) return h({ body, calls });
      switch (body.op) {
        case 'upsert-asset': return json(200, { assetId: ASSET_ID });
        case 'multipart-create': return json(200, { uploadId: 'up-1' });
        case 'multipart-sign': return json(200, { url: `https://r2.test/part/${body.partNumber}`, partNumber: body.partNumber });
        case 'multipart-complete': return json(200, { assetId: ASSET_ID, uploadState: 'complete' });
        case 'multipart-abort': return json(200, { ok: true });
        default: return json(400, { error: 'bad_request' });
      }
    }
    if (u.host === 'stt.test') {
      const key = `${method} ${u.pathname}`;
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ kind: 'stt', route: key, body, headers });
      if (routes[key]) return routes[key]({ body, calls });
      if (key === 'GET /v1/file/budget') return json(200, { plan: 'sync', availableMs: 10 * 3600000, dailyRemaining: null, queueRemaining: 5 });
      if (key === 'POST /v1/file/jobs') return json(202, { jobId: 'job-1', state: 'queued' });
      return json(404, { error: 'nf' });
    }
    if (u.host === 'r2.test' && method === 'PUT') {
      const partNumber = Number(u.pathname.split('/').pop());
      state.putAttempts[partNumber] = (state.putAttempts[partNumber] || 0) + 1;
      calls.push({ kind: 'put', partNumber, headers, bodyLength: init.body?.length });
      state.inflight++;
      state.maxInflight = Math.max(state.maxInflight, state.inflight);
      try {
        if (routes.PUT) return await routes.PUT({ partNumber, attempt: state.putAttempts[partNumber], state, signal: init.signal });
        return new Response(null, { status: 200, headers: { etag: `"etag-${partNumber}"` } });
      } finally {
        state.inflight--;
      }
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
  return { fetchImpl, calls, state };
}

const audioProbe = (duration = 600) => async () => ({ format: { duration, hasVideo: false } });
const noSleep = () => { const sleeps = []; return { sleeps, sleep: async (ms) => { sleeps.push(ms); } }; };

async function run(file, { routes, args = {}, env = ENV, parseStream = audioProbe(), onProgress, onUnauthorized, probeTimeoutMs, signal, partTimeoutMs, now, beforeComplete, apiTimeoutMs } = {}) {
  const m = mockFetch(routes);
  const s = noSleep();
  const result = await transcribeFile({
    env, key: KEY, args: { path: file, ...args }, fetchImpl: m.fetchImpl, sleep: s.sleep,
    parseStream, onProgress, onUnauthorized, probeTimeoutMs, signal, partTimeoutMs, now, beforeComplete, apiTimeoutMs,
  });
  return { result, ...m, sleeps: s.sleeps };
}

const syncOps = (calls) => calls.filter((c) => c.kind === 'sync').map((c) => c.op);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
  const small = tmpFile('interview.m4a', 1000);
  const twenty = tmpFile('twenty.mp3', 20 * MiB);

  console.log('\nTool definition + config:');
  await test('tool name, required path, and the issue description', async () => {
    assert.strictEqual(TRANSCRIBE_TOOL.name, 'seameet_transcribe_file');
    assert.deepStrictEqual(TRANSCRIBE_TOOL.inputSchema.required, ['path']);
    assert.ok(TRANSCRIBE_TOOL.description.includes('seameet_get_recording(assetId)'));
  });
  await test('defaults + env overrides', async () => {
    const d = uploadConfig({});
    assert.strictEqual(d.supabaseUrl, 'https://tvezjojyndcgkneyxook.supabase.co');
    assert.strictEqual(d.sttProxyUrl, 'https://seameet-stt-proxy.seameet.workers.dev');
    assert.strictEqual(d.webUrl, 'https://app.seameet.ai');
    assert.strictEqual(d.anonKey, DEFAULT_SUPABASE_ANON_KEY);
    assert.strictEqual(DEFAULT_SUPABASE_URL, d.supabaseUrl);
    assert.strictEqual(DEFAULT_STT_PROXY_URL, d.sttProxyUrl);
    assert.strictEqual(DEFAULT_WEB_URL, d.webUrl);
    const o = uploadConfig(ENV);
    assert.deepStrictEqual(o, { supabaseUrl: 'https://sb.test', anonKey: 'anon-test', sttProxyUrl: 'https://stt.test', webUrl: 'https://web.test' });
  });

  console.log('\nValidation (no network):');
  await test('extension allowlist: all 13 web extensions pass, case-insensitive', async () => {
    assert.deepStrictEqual(ALLOWED_EXTENSIONS, ['mp3', 'm4a', 'mp4', 'mov', 'wav', 'flac', 'ogg', 'oga', 'opus', 'webm', 'aac', 'amr', 'spx']);
    for (const ext of ALLOWED_EXTENSIONS) {
      const r = await checkFile(tmpFile(`ok.${ext.toUpperCase()}`, 10));
      assert.ok(r.ok, `.${ext} should pass`);
      assert.strictEqual(r.ext, ext);
    }
  });
  await test('.mkv / no extension → unsupported_type, no network call', async () => {
    for (const name of ['clip.mkv', 'clip.avi', 'noext']) {
      const { result, calls } = await run(tmpFile(name, 10));
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error.code, 'unsupported_type');
      assert.strictEqual(result.error.tool, 'seameet_transcribe_file');
      assert.strictEqual(calls.length, 0);
    }
  });
  await test('size bounds: 0 bytes → empty_file; 512 MiB + 1 → too_large; 1 byte and 512 MiB pass', async () => {
    const empty = await run(tmpFile('empty.mp3', 0));
    assert.strictEqual(empty.result.error.code, 'empty_file');
    assert.strictEqual(empty.calls.length, 0);
    const big = await run(tmpFile('big.mp4', MAX_FILE_BYTES + 1));
    assert.strictEqual(big.result.error.code, 'too_large');
    assert.strictEqual(big.result.error.hint, 'Files over 512 MB: use app.seameet.ai, which can extract the audio track.');
    assert.strictEqual(big.calls.length, 0);
    assert.ok((await checkFile(tmpFile('one.wav', 1))).ok);
    assert.ok((await checkFile(tmpFile('max.wav', MAX_FILE_BYTES))).ok);
  });
  await test('missing file, a directory, bad language → invalid_request, no network', async () => {
    const missing = await run(path.join(tmpDir, 'nope.mp3'));
    assert.strictEqual(missing.result.error.code, 'invalid_request');
    const dir = path.join(tmpDir, 'adir.mp3');
    fs.mkdirSync(dir);
    assert.strictEqual((await run(dir)).result.error.code, 'invalid_request');
    const lang = await run(small, { args: { language: 'not a tag!' } });
    assert.strictEqual(lang.result.error.code, 'invalid_request');
    for (const r of [missing, lang]) assert.strictEqual(r.calls.length, 0);
  });
  await test('~ expands to the home directory', async () => {
    const r = await checkFile('~/definitely-not-here-seameet.mp3');
    assert.ok(r.payload.error.message.includes(os.homedir()));
  });

  console.log('\nMultipart upload:');
  await test('20 MiB → 3 parts at 8 MiB, Content-Length on each PUT, complete with etags in order', async () => {
    assert.strictEqual(partCount(20 * MiB), 3);
    const { result, calls } = await run(twenty);
    assert.strictEqual(result.success, true, JSON.stringify(result));
    const puts = calls.filter((c) => c.kind === 'put').sort((a, b) => a.partNumber - b.partNumber);
    assert.deepStrictEqual(puts.map((p) => p.partNumber), [1, 2, 3]);
    assert.deepStrictEqual(puts.map((p) => p.headers['Content-Length']), [String(PART_BYTES), String(PART_BYTES), String(4 * MiB)]);
    assert.deepStrictEqual(puts.map((p) => p.bodyLength), [PART_BYTES, PART_BYTES, 4 * MiB]);
    const complete = calls.find((c) => c.op === 'multipart-complete');
    assert.deepStrictEqual(complete.body.parts, [1, 2, 3].map((n) => ({ partNumber: n, etag: `etag-${n}` })));
    assert.strictEqual(complete.body.uploadId, 'up-1');
    assert.ok(!syncOps(calls).includes('multipart-abort'));
  });
  await test('at most 3 parts in flight (and actually parallel)', async () => {
    const file = tmpFile('six.wav', 6 * PART_BYTES);
    const { result, state } = await run(file, {
      routes: { PUT: async ({ partNumber }) => { await new Promise((r) => setTimeout(r, 20)); return new Response(null, { status: 200, headers: { etag: `"e${partNumber}"` } }); } },
    });
    assert.strictEqual(result.success, true);
    assert.ok(state.maxInflight <= 3, `max in flight ${state.maxInflight}`);
    assert.ok(state.maxInflight >= 2, `expected parallel parts, got ${state.maxInflight}`);
  });
  await test('retry/backoff: a part that fails twice succeeds on the third try after 1 s, 2 s', async () => {
    const { result, sleeps, state } = await run(twenty, {
      routes: {
        PUT: ({ partNumber, attempt }) => (partNumber === 2 && attempt <= 2
          ? new Response('boom', { status: 500 })
          : new Response(null, { status: 200, headers: { etag: `"e${partNumber}"` } })),
      },
    });
    assert.strictEqual(result.success, true, JSON.stringify(result));
    assert.deepStrictEqual(sleeps, [1000, 2000]);
    assert.strictEqual(state.putAttempts[2], 3);
  });
  await test('abort on failure: 4 tries (1/2/4 s), then multipart-abort + upload_failed step "part 2"', async () => {
    const { result, sleeps, calls, state } = await run(twenty, {
      routes: {
        PUT: ({ partNumber }) => (partNumber === 2
          ? Promise.reject(new TypeError('fetch failed'))
          : new Response(null, { status: 200, headers: { etag: `"e${partNumber}"` } })),
      },
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error.code, 'upload_failed');
    assert.strictEqual(result.error.step, 'part 2');
    assert.strictEqual(result.assetId, ASSET_ID);
    assert.ok(result.error.hint.includes('part 2'));
    assert.deepStrictEqual(sleeps, [1000, 2000, 4000]);
    assert.strictEqual(state.putAttempts[2], 4);
    const ops = syncOps(calls);
    assert.ok(ops.includes('multipart-abort'));
    assert.ok(!ops.includes('multipart-complete'));
    assert.ok(!calls.some((c) => c.route === 'POST /v1/file/jobs'), 'no job after a failed upload');
  });
  await test('a missing etag counts as a failed part', async () => {
    const { result } = await run(small, { routes: { PUT: () => new Response(null, { status: 200 }) } });
    assert.strictEqual(result.error.code, 'upload_failed');
    assert.strictEqual(result.error.step, 'part 1');
  });
  await test('multipart-create / multipart-complete failures name their step and abort', async () => {
    const create = await run(small, { routes: { 'op:multipart-create': () => json(500, { error: 'internal' }) } });
    assert.strictEqual(create.result.error.code, 'upload_failed');
    assert.strictEqual(create.result.error.step, 'create');
    assert.strictEqual(create.result.assetId, ASSET_ID);
    const complete = await run(small, { routes: { 'op:multipart-complete': () => json(400, { error: 'size_mismatch' }) } });
    assert.strictEqual(complete.result.error.step, 'complete');
    assert.ok(syncOps(complete.calls).includes('multipart-abort'));
  });
  await test('progress: a stage notification per step and per part start/finish, increasing', async () => {
    const seen = [];
    let t = 0;
    const { result } = await run(twenty, { now: () => (t += 1000), onProgress: (p, total, msg) => { seen.push([p, total, msg]); } });
    assert.strictEqual(result.success, true);
    assert.strictEqual(seen.length, 5 + 2 * 3);
    assert.deepStrictEqual(seen.map((x) => x[0]), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.ok(seen.every((x) => x[1] === 11));
    const msgs = seen.map((x) => x[2]);
    for (const m of ['Reading the file’s length', 'Checking your transcription allowance', 'Upload started', 'Uploading part 1 of 3', 'Uploaded part 3 of 3', 'Finishing the upload', 'Starting transcription']) {
      assert.ok(msgs.includes(m), `missing "${m}" in ${msgs.join(' | ')}`);
    }
  });
  await test('progress is throttled to one per second', async () => {
    const seen = [];
    let t = 0;
    await run(twenty, { now: () => (t += 250), onProgress: (p) => { seen.push(p); } });
    assert.ok(seen.length >= 2 && seen.length <= 4, `got ${seen.length}`);
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i] > seen[i - 1], 'progress increases');
  });
  await test('progress is never awaited: a hung or throwing onProgress blocks nothing', async () => {
    let t = 0;
    const hung = await run(twenty, { now: () => (t += 1000), onProgress: () => new Promise(() => {}) });
    assert.strictEqual(hung.result.success, true);
    const threw = await run(twenty, { now: () => (t += 1000), onProgress: () => { throw new Error('closed'); } });
    assert.strictEqual(threw.result.success, true);
    const rejected = await run(twenty, { now: () => (t += 1000), onProgress: () => Promise.reject(new Error('closed')) });
    assert.strictEqual(rejected.result.success, true);
  });

  console.log('\nIdentity + probe:');
  await test('upsert-asset uses the web-upload identity with localPresent:true; sync-api headers + {...args, op}', async () => {
    const { result, calls } = await run(small);
    assert.strictEqual(result.success, true);
    const up = calls.find((c) => c.op === 'upsert-asset');
    assert.match(up.body.clientRef, /^web-upload-[0-9a-f-]{36}$/);
    assert.strictEqual(up.body.originDeviceId, 'web-upload');
    assert.strictEqual(up.body.localPresent, true);
    assert.strictEqual(up.body.kind, 'audio');
    assert.strictEqual(up.body.hasVideo, false);
    assert.strictEqual(up.body.ext, 'm4a');
    assert.strictEqual(up.body.sizeBytes, 1000);
    assert.strictEqual(up.body.displayName, 'interview');
    assert.deepStrictEqual(
      { a: up.headers.Authorization, k: up.headers.apikey, x: up.headers['X-Api-Key'], c: up.headers['Content-Type'] },
      { a: 'Bearer anon-test', k: 'anon-test', x: KEY, c: 'application/json' },
    );
    for (const c of calls.filter((x) => x.kind === 'stt')) assert.strictEqual(c.headers['X-Api-Key'], KEY);
  });
  await test('hasVideo: mp4 with a picture → video; audio-only mp4 → audio; mov with a failed probe → video; mp3 never', async () => {
    const mp4 = tmpFile('screen.mp4', 100);
    const v = await run(mp4, { parseStream: async () => ({ format: { duration: 30, hasVideo: true } }) });
    let up = v.calls.find((c) => c.op === 'upsert-asset').body;
    assert.deepStrictEqual([up.kind, up.hasVideo], ['video', true]);
    const a = await run(mp4, { parseStream: async () => ({ format: { duration: 30, hasVideo: false } }) });
    up = a.calls.find((c) => c.op === 'upsert-asset').body;
    assert.deepStrictEqual([up.kind, up.hasVideo], ['audio', false]);
    const mov = await run(tmpFile('phone.mov', 100), { parseStream: async () => { throw new Error('unparseable'); } });
    up = mov.calls.find((c) => c.op === 'upsert-asset').body;
    assert.deepStrictEqual([up.kind, up.hasVideo], ['video', true]);
    const mp3 = await run(tmpFile('talk.mp3', 100), { parseStream: async () => ({ format: { duration: 30, hasVideo: true } }) });
    assert.strictEqual(mp3.calls.find((c) => c.op === 'upsert-asset').body.hasVideo, false);
  });
  await test('probe is called with {duration:false, skipCovers:true}', async () => {
    let opts;
    let info;
    await run(small, { parseStream: async (_s, i, o) => { info = i; opts = o; return { format: { duration: 10 } }; } });
    assert.deepStrictEqual(opts, { duration: false, skipCovers: true });
    assert.deepStrictEqual(info, { size: 1000, path: 'interview.m4a' });
  });
  await test('duration 0 / NaN / missing / probe timeout → estimatedDurationMs omitted, poll 60 s', async () => {
    const probes = [
      async () => ({ format: { duration: 0 } }),
      async () => ({ format: { duration: NaN } }),
      async () => ({ format: {} }),
      () => new Promise(() => {}), // never resolves → timeout
    ];
    for (const parseStream of probes) {
      const { result, calls } = await run(small, { parseStream, probeTimeoutMs: 20 });
      assert.strictEqual(result.success, true);
      const job = calls.find((c) => c.route === 'POST /v1/file/jobs').body;
      assert.ok(!('estimatedDurationMs' in job), `estimate should be omitted: ${JSON.stringify(job)}`);
      assert.strictEqual(result.estimatedMinutes, null);
      assert.strictEqual(result.pollAfterSeconds, 60);
      assert.strictEqual(result.allowanceRemainingMinutes, null);
    }
  });
  await test('real music-metadata probe on a WAV header (no injection)', async () => {
    // 1 s of 8 kHz mono 16-bit silence.
    const dataLen = 16000;
    const buf = Buffer.alloc(44 + dataLen);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(8000, 24); buf.writeUInt32LE(16000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(dataLen, 40);
    const file = path.join(tmpDir, 'silence.wav');
    fs.writeFileSync(file, buf);
    const m = mockFetch();
    const result = await transcribeFile({ env: ENV, key: KEY, args: { path: file }, fetchImpl: m.fetchImpl, sleep: async () => {} });
    assert.strictEqual(result.success, true, JSON.stringify(result));
    assert.strictEqual(m.calls.find((c) => c.route === 'POST /v1/file/jobs').body.estimatedDurationMs, 1000);
  });
  await test('job body: assetId, language, estimate, options.hotwords', async () => {
    const { calls } = await run(small, { args: { language: 'ja', hotwords: [' SeaMeet ', 'BytePlus', 'SeaMeet'] }, parseStream: audioProbe(90.4) });
    assert.deepStrictEqual(calls.find((c) => c.route === 'POST /v1/file/jobs').body, {
      assetId: ASSET_ID, language: 'ja', estimatedDurationMs: 90400, options: { hotwords: ['SeaMeet', 'BytePlus'] },
    });
  });

  console.log('\nBudget pre-check:');
  await test('dailyRemaining 0 → daily_import_limit; queueRemaining 0 → queue_full; nothing uploaded', async () => {
    const daily = await run(small, { routes: { 'GET /v1/file/budget': () => json(200, { availableMs: 1e9, dailyRemaining: 0, queueRemaining: 5 }) } });
    assert.strictEqual(daily.result.error.code, 'daily_import_limit');
    assert.strictEqual(daily.result.error.hint, "You've reached today's upload limit; try again tomorrow.");
    assert.deepStrictEqual(syncOps(daily.calls), []);
    const queue = await run(small, { routes: { 'GET /v1/file/budget': () => json(200, { availableMs: 1e9, dailyRemaining: null, queueRemaining: 0 }) } });
    assert.strictEqual(queue.result.error.code, 'queue_full');
    assert.deepStrictEqual(syncOps(queue.calls), []);
  });
  await test('estimate > availableMs → insufficient_allowance with the hours left', async () => {
    const { result, calls } = await run(small, {
      parseStream: audioProbe(2 * 3600),
      routes: { 'GET /v1/file/budget': () => json(200, { availableMs: 1.5 * 3600000, dailyRemaining: 3, queueRemaining: 5 }) },
    });
    assert.strictEqual(result.error.code, 'insufficient_allowance');
    assert.ok(result.error.hint.includes('1.5 hours'), result.error.hint);
    assert.deepStrictEqual(syncOps(calls), []);
  });
  await test('a failing budget GET (500, network error, 401) does not block', async () => {
    for (const h of [() => json(500, { error: 'budget_unavailable' }), () => Promise.reject(new TypeError('fetch failed')), () => json(401, { error: 'unauthorized' })]) {
      let unauthorized = false;
      const { result } = await run(small, { routes: { 'GET /v1/file/budget': h }, onUnauthorized: () => { unauthorized = true; } });
      assert.strictEqual(result.success, true, JSON.stringify(result));
      assert.strictEqual(result.allowanceRemainingMinutes, null);
      assert.strictEqual(unauthorized, false, 'a budget 401 must not drop the key');
    }
  });

  console.log('\nError table:');
  await test('401 from sync-api → auth_required, cached key dropped via onUnauthorized', async () => {
    let dropped = 0;
    const { result } = await run(small, { routes: { 'op:upsert-asset': () => json(401, { error: 'unauthorized' }) }, onUnauthorized: () => { dropped++; } });
    assert.strictEqual(result.error.code, 'auth_required');
    assert.strictEqual(dropped, 1);
    assert.ok(result.error.hint.includes('call this tool again'));
  });
  await test('401 with SEAMEET_API_KEY set → hint says to replace that key', async () => {
    let dropped = 0;
    const { result } = await run(small, {
      env: { ...ENV, SEAMEET_API_KEY: KEY },
      routes: { 'op:multipart-create': () => json(401, { error: 'unauthorized' }) },
      onUnauthorized: () => { dropped++; },
    });
    assert.strictEqual(result.error.code, 'auth_required');
    assert.ok(result.error.hint.includes('SEAMEET_API_KEY'));
    assert.strictEqual(result.assetId, ASSET_ID);
    assert.strictEqual(dropped, 1, 'index.js decides not to delete an env key; upload.js still reports the 401');
  });
  await test('401 from stt-proxy after sync-api accepted the key → job_start_failed, key NOT dropped', async () => {
    let dropped = 0;
    const { result, calls } = await run(small, {
      routes: { 'POST /v1/file/jobs': () => json(401, { error: 'unauthorized' }) },
      onUnauthorized: () => { dropped++; },
    });
    assert.strictEqual(result.error.code, 'job_start_failed');
    assert.strictEqual(dropped, 0, 'a stt-proxy 401 must never delete a key sync-api just accepted');
    assert.strictEqual(result.assetId, ASSET_ID);
    assert.strictEqual(result.error.webUrl, `https://web.test/r/${ASSET_ID}`);
    assert.ok(result.error.hint.includes(`open https://web.test/r/${ASSET_ID}`), result.error.hint);
    assert.ok(syncOps(calls).includes('multipart-complete'));
  });
  await test('403 insufficient_scope from upsert-asset → insufficient_scope, nothing created', async () => {
    const { result, calls } = await run(small, { routes: { 'op:upsert-asset': () => json(403, { error: 'insufficient_scope' }) } });
    assert.strictEqual(result.error.code, 'insufficient_scope');
    assert.ok(!('assetId' in result));
    assert.deepStrictEqual(syncOps(calls), ['upsert-asset']);
    assert.ok(!calls.some((c) => c.route === 'POST /v1/file/jobs'));
  });
  await test('stt-proxy job refusals map 1:1 with a hint and keep assetId + webUrl', async () => {
    const rows = [
      [403, 'free_exhausted', 'free_exhausted'],
      [403, 'import_cap_reached', 'import_cap_reached'],
      [403, 'not_entitled', 'not_entitled'],
      [403, 'disabled', 'disabled'],
      [403, 'insufficient_scope', 'insufficient_scope'],
      [429, 'daily_import_limit', 'daily_import_limit'],
      [429, 'queue_full', 'queue_full'],
      [413, 'session_too_long', 'session_too_long'],
      [409, 'not_synced', 'upload_incomplete'],
      [500, 'internal', 'job_start_failed'],
      [503, 'auth_unavailable', 'service_unavailable'],
      [503, 'budget_unavailable', 'service_unavailable'],
    ];
    for (const [status, error, code] of rows) {
      const { result } = await run(small, { routes: { 'POST /v1/file/jobs': () => json(status, { error }) } });
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error.code, code, `${status} ${error}`);
      assert.strictEqual(result.error.tool, 'seameet_transcribe_file');
      assert.strictEqual(result.assetId, ASSET_ID);
      assert.strictEqual(result.error.webUrl, `https://web.test/r/${ASSET_ID}`);
      assert.ok(typeof result.error.hint === 'string' && result.error.hint.length > 10);
      assert.ok(!/\n/.test(result.error.hint));
      // After a complete upload every hint points at the saved asset and
      // never invites a re-run (which would upload a duplicate).
      assert.ok(result.error.hint.includes(`https://web.test/r/${ASSET_ID}`), `${code}: ${result.error.hint}`);
      assert.ok(!/(call|run) this tool|try again/i.test(result.error.hint), `${code}: ${result.error.hint}`);
    }
    const down = await run(small, { routes: { 'POST /v1/file/jobs': () => json(503, { error: 'auth_unavailable' }) } });
    assert.ok(down.result.error.hint.includes(`https://web.test/r/${ASSET_ID}`), 'a 503 names where the saved file is');
    const fe = await run(small, { routes: { 'POST /v1/file/jobs': () => json(403, { error: 'free_exhausted' }) } });
    assert.strictEqual(fe.result.error.hint, `Your free transcription hours are used up; upgrade at app.seameet.ai, then open https://web.test/r/${ASSET_ID} to transcribe this file.`);
  });
  await test('413 from sync-api → too_large (storage quota gets its own sentence)', async () => {
    const size = await run(small, { routes: { 'op:multipart-create': () => json(413, { error: 'import_too_large' }) } });
    assert.strictEqual(size.result.error.code, 'too_large');
    const quota = await run(small, { routes: { 'op:multipart-create': () => json(413, { error: 'quota_exceeded' }) } });
    assert.strictEqual(quota.result.error.code, 'too_large');
    assert.ok(quota.result.error.hint.includes('storage'));
  });

  console.log('\n503 / not_synced / timeouts:');
  await test('503 during upload steps keeps step and never claims the file is saved', async () => {
    const cases = [
      ['create', { 'op:multipart-create': () => json(503, { error: 'auth_unavailable' }) }],
      ['part 1', { 'op:multipart-sign': () => json(503, { error: 'auth_unavailable' }) }],
      ['complete', { 'op:multipart-complete': () => json(503, { error: 'auth_unavailable' }) }],
    ];
    for (const [step, routes] of cases) {
      const { result, calls } = await run(small, { routes });
      assert.strictEqual(result.error.code, 'service_unavailable', step);
      assert.strictEqual(result.error.step, step);
      assert.ok(!('webUrl' in result.error), step);
      assert.ok(!/saved|web\.test/.test(result.error.hint), `${step}: ${result.error.hint}`);
      // create never opened an upload, so there is nothing to abort.
      assert.strictEqual(syncOps(calls).includes('multipart-abort'), step !== 'create', `${step} abort`);
      assert.ok(!calls.some((c) => c.route === 'POST /v1/file/jobs'));
    }
  });
  await test('503 at job start (after the upload completed) points at webUrl', async () => {
    const { result } = await run(small, { routes: { 'POST /v1/file/jobs': () => json(503, { error: 'budget_unavailable' }) } });
    assert.strictEqual(result.error.code, 'service_unavailable');
    assert.strictEqual(result.error.webUrl, `https://web.test/r/${ASSET_ID}`);
    assert.ok(result.error.hint.includes(`https://web.test/r/${ASSET_ID}`), result.error.hint);
    assert.ok(!('step' in result.error));
  });
  await test('409 not_synced at job start is retried once after 2 s and then succeeds', async () => {
    let n = 0;
    const { result, sleeps, calls } = await run(small, {
      routes: { 'POST /v1/file/jobs': () => (++n === 1 ? json(409, { error: 'not_synced' }) : json(202, { jobId: 'job-2', state: 'queued' })) },
    });
    assert.strictEqual(result.success, true, JSON.stringify(result));
    assert.strictEqual(result.jobId, 'job-2');
    assert.deepStrictEqual(sleeps, [2000]);
    assert.strictEqual(calls.filter((c) => c.route === 'POST /v1/file/jobs').length, 2);
    assert.strictEqual(syncOps(calls).filter((o) => o === 'upsert-asset').length, 1, 'no second upload');
  });
  await test('409 not_synced twice → upload_incomplete pointing at the existing asset, not a re-run', async () => {
    const { result, calls } = await run(small, { routes: { 'POST /v1/file/jobs': () => json(409, { error: 'not_synced' }) } });
    assert.strictEqual(result.error.code, 'upload_incomplete');
    assert.strictEqual(calls.filter((c) => c.route === 'POST /v1/file/jobs').length, 2);
    assert.ok(result.error.hint.includes(`open https://web.test/r/${ASSET_ID}`), result.error.hint);
    assert.ok(!/call this tool again|re-?run/i.test(result.error.hint), result.error.hint);
  });
  await test('per-part timeout is 120 s × parts in flight, and a hung PUT times out and is retried', async () => {
    assert.strictEqual(PART_PUT_TIMEOUT_MS, PART_PUT_BASE_TIMEOUT_MS * MAX_PARTS_IN_FLIGHT);
    assert.strictEqual(PART_PUT_TIMEOUT_MS, 360000);
    const hang = ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const { result, state, sleeps } = await run(small, { partTimeoutMs: 20, routes: { PUT: hang } });
    assert.strictEqual(result.error.code, 'upload_failed');
    assert.strictEqual(result.error.step, 'part 1');
    assert.ok(/timed out/.test(result.error.message), result.error.message);
    assert.strictEqual(state.putAttempts[1], 4);
    assert.deepStrictEqual(sleeps, [1000, 2000, 4000]);
  });

  console.log('\nCancellation:');
  await test('anySignal aborts when any input aborts', async () => {
    const a = new AbortController();
    const b = new AbortController();
    const { signal, dispose } = anySignal([a.signal, undefined, b.signal]);
    assert.strictEqual(signal.aborted, false);
    b.abort();
    assert.strictEqual(signal.aborted, true);
    dispose();
    // Nested composition (timeout → part scope → cancel) must propagate.
    const cancel = new AbortController();
    const scope = anySignal([cancel.signal, new AbortController().signal]);
    const inner = anySignal([new AbortController().signal, scope.signal]);
    cancel.abort();
    assert.strictEqual(inner.signal.aborted, true, 'nested composite fired');
    const real = AbortSignal.any;
    try {
      AbortSignal.any = undefined; // Node 18.0–18.16
      const c = new AbortController();
      const fb = anySignal([new AbortController().signal, c.signal]);
      assert.strictEqual(fb.signal.aborted, false);
      c.abort();
      assert.strictEqual(fb.signal.aborted, true);
      fb.dispose();
      const pre = new AbortController();
      pre.abort();
      assert.strictEqual(anySignal([pre.signal]).signal.aborted, true);
    } finally {
      AbortSignal.any = real;
    }
  });
  await test('cancel before starting → cancelled, no network call', async () => {
    const c = new AbortController();
    c.abort();
    const { result, calls } = await run(small, { signal: c.signal });
    assert.strictEqual(result.error.code, 'cancelled');
    assert.strictEqual(calls.length, 0);
  });
  await test('cancel mid-upload → multipart-abort, no /v1/file/jobs, returns promptly', async () => {
    const c = new AbortController();
    const file = tmpFile('cancel.wav', 6 * PART_BYTES);
    const started = Date.now();
    const { result, calls } = await run(file, {
      signal: c.signal,
      routes: {
        PUT: ({ partNumber, signal }) => {
          if (partNumber === 2) setTimeout(() => c.abort(), 5);
          // Honour the fetch signal like a real fetch would.
          return new Promise((resolve, reject) => {
            const t = setTimeout(() => resolve(new Response(null, { status: 200, headers: { etag: `"e${partNumber}"` } })), 50);
            signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); });
          });
        },
      },
    });
    assert.strictEqual(result.error.code, 'cancelled');
    assert.strictEqual(result.assetId, ASSET_ID);
    assert.ok(syncOps(calls).includes('multipart-abort'), 'multipart-abort called');
    assert.ok(!syncOps(calls).includes('multipart-complete'));
    assert.ok(!calls.some((c2) => c2.route === 'POST /v1/file/jobs'), 'job never started');
    assert.ok(calls.filter((c2) => c2.kind === 'put').length < 6, 'stopped before sending every part');
    assert.ok(Date.now() - started < 1000, 'returned promptly');
  });
  await test('cancel during the job-start retry wait → no second job POST', async () => {
    const c = new AbortController();
    const m = mockFetch({ 'POST /v1/file/jobs': () => json(409, { error: 'not_synced' }) });
    const started = Date.now();
    const pending = transcribeFile({
      env: ENV, key: KEY, args: { path: small }, fetchImpl: m.fetchImpl, parseStream: audioProbe(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)), jobRetryDelayMs: 5000, signal: c.signal,
    });
    const poll = setInterval(() => {
      if (m.calls.some((x) => x.route === 'POST /v1/file/jobs')) { clearInterval(poll); c.abort(); }
    }, 2);
    const result = await pending;
    clearInterval(poll);
    assert.strictEqual(result.error.code, 'cancelled');
    assert.strictEqual(m.calls.filter((x) => x.route === 'POST /v1/file/jobs').length, 1);
    assert.ok(Date.now() - started < 2000, 'the 5 s retry wait ended on cancel');
  });

  console.log('\nHardening (redirects, bodies, file identity, outcomes):');
  await test('every request refuses redirects (redirect: "error")', async () => {
    const { result, state } = await run(twenty);
    assert.strictEqual(result.success, true);
    assert.ok(state.redirects.length > 5);
    assert.ok(state.redirects.every((r) => r === 'error'), JSON.stringify(state.redirects));
  });
  await test('a real 3xx from sync-api is not followed and the key never leaves', async () => {
    const hits = [];
    const srv = http.createServer((req, res) => {
      hits.push({ url: req.url, key: req.headers['x-api-key'] });
      req.resume();
      if (req.url === '/functions/v1/sync-api') { res.writeHead(307, { Location: '/steal' }); return res.end(); }
      if (req.url.startsWith('/stt/')) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const base = `http://127.0.0.1:${srv.address().port}`;
      const result = await transcribeFile({
        env: { ...ENV, SEAMEET_SUPABASE_URL: base, SEAMEET_STT_PROXY_URL: `${base}/stt` },
        key: KEY, args: { path: small }, parseStream: audioProbe(), sleep: async () => {},
      });
      assert.strictEqual(result.error.code, 'upload_failed');
      assert.strictEqual(result.error.step, 'upsert-asset');
      assert.ok(!hits.some((h) => h.url === '/steal'), 'redirect was not followed');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
  await test('PUT response bodies are cancelled unread; the ETag is still taken', async () => {
    let cancelled = 0;
    let pulled = 0;
    const { result } = await run(small, {
      routes: {
        PUT: ({ partNumber }) => new Response(new ReadableStream({
          pull(c) { pulled++; c.enqueue(new Uint8Array(1024)); },
          cancel() { cancelled++; },
        }), { status: 200, headers: { etag: `"e${partNumber}"` } }),
      },
    });
    assert.strictEqual(result.success, true, JSON.stringify(result));
    assert.strictEqual(cancelled, 1);
    assert.ok(pulled <= 2, `body was drained (${pulled} pulls)`);
  });
  await test('JSON bodies are capped at 1 MiB', async () => {
    const big = JSON.stringify({ assetId: ASSET_ID, pad: 'x'.repeat(MAX_JSON_BYTES) });
    const { result } = await run(small, { routes: { 'op:upsert-asset': () => new Response(big, { status: 200 }) } });
    assert.strictEqual(result.error.code, 'upload_failed');
    assert.strictEqual(result.error.step, 'upsert-asset');
    assert.ok(/larger than/.test(result.error.message), result.error.message);
  });
  await test('a JSON body that never ends is bounded by the request timeout', async () => {
    const started = Date.now();
    const { result } = await run(small, {
      apiTimeoutMs: 50,
      routes: { 'op:upsert-asset': () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"assetId":')); } }), { status: 200 }) },
    });
    assert.strictEqual(result.error.code, 'upload_failed');
    assert.strictEqual(result.error.step, 'upsert-asset');
    assert.ok(/timed out/.test(result.error.message), result.error.message);
    assert.ok(Date.now() - started < 2000);
  });
  await test('2xx with an unparsable body or a missing field is an error at every step', async () => {
    const garbage = () => new Response('not json', { status: 200 });
    const cases = [
      ['upsert-asset', { 'op:upsert-asset': garbage }],
      ['upsert-asset', { 'op:upsert-asset': () => json(200, { ok: true }) }],
      ['create', { 'op:multipart-create': garbage }],
      ['create', { 'op:multipart-create': () => json(200, {}) }],
      ['part 1', { 'op:multipart-sign': () => json(200, { partNumber: 1 }) }],
    ];
    for (const [step, routes] of cases) {
      const { result, calls } = await run(small, { routes });
      assert.strictEqual(result.error.code, 'upload_failed', step);
      assert.strictEqual(result.error.step, step);
      assert.ok(!calls.some((c) => c.route === 'POST /v1/file/jobs'), step);
    }
    // The job POST: a 2xx without jobId/state means it may exist → outcome_unknown.
    for (const body of [{ state: 'queued' }, { jobId: 'j' }]) {
      const { result } = await run(small, { routes: { 'POST /v1/file/jobs': () => json(202, body) } });
      assert.strictEqual(result.error.code, 'outcome_unknown', JSON.stringify(body));
    }
  });
  await test('a network error or cancel after the job POST was sent → outcome_unknown, never "cancelled"', async () => {
    const hint = 'Transcription may have started; check asset.transcriptionJob with seameet_get_recording before doing anything else.';
    const net = await run(small, { routes: { 'POST /v1/file/jobs': () => Promise.reject(new TypeError('fetch failed')) } });
    assert.strictEqual(net.result.error.code, 'outcome_unknown');
    assert.strictEqual(net.result.error.hint, hint);
    assert.strictEqual(net.result.assetId, ASSET_ID);
    assert.strictEqual(net.result.error.webUrl, `https://web.test/r/${ASSET_ID}`);
    const c = new AbortController();
    const cancelledAfterSend = await run(small, {
      signal: c.signal,
      routes: { 'POST /v1/file/jobs': () => { setTimeout(() => c.abort(), 5); return new Promise(() => {}); } },
    });
    // The mock ignores fetch's signal, like a request already on the wire.
    assert.strictEqual(cancelledAfterSend.result.error.code, 'outcome_unknown');
    assert.strictEqual(cancelledAfterSend.result.error.hint, hint);
  });
  await test('a failing worker aborts its siblings at once (does not wait for a slow part)', async () => {
    const started = Date.now();
    let part2Aborted = false;
    let part2Started;
    const part2InFlight = new Promise((r) => { part2Started = r; });
    const { result } = await run(twenty, {
      routes: {
        PUT: ({ partNumber, signal }) => {
          // Part 1 fails for good only once part 2's PUT is on the wire.
          if (partNumber === 1) return part2InFlight.then(() => Promise.reject(new TypeError('fetch failed')));
          if (partNumber === 2) part2Started();
          return new Promise((resolve, reject) => {
            const t = setTimeout(() => resolve(new Response(null, { status: 200, headers: { etag: `"e${partNumber}"` } })), 5000);
            signal.addEventListener('abort', () => { part2Aborted = true; clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); });
          });
        },
      },
    });
    assert.strictEqual(result.error.code, 'upload_failed');
    assert.strictEqual(result.error.step, 'part 1', 'keeps the original error');
    assert.ok(part2Aborted, 'the slow sibling was aborted');
    assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
  });
  await test('multipart-create with a lost response → upload_failed step create, nothing to abort', async () => {
    const { result, calls } = await run(small, { routes: { 'op:multipart-create': () => Promise.reject(new TypeError('socket hang up')) } });
    assert.strictEqual(result.error.code, 'upload_failed');
    assert.strictEqual(result.error.step, 'create');
    assert.ok(!syncOps(calls).includes('multipart-abort'));
  });
  await test('multipart-complete with an unknown outcome → upload_unknown, no abort, points at webUrl', async () => {
    for (const h of [() => Promise.reject(new TypeError('socket hang up')), () => new Response('garbage', { status: 200 })]) {
      const { result, calls } = await run(small, { routes: { 'op:multipart-complete': h } });
      assert.strictEqual(result.error.code, 'upload_unknown');
      assert.strictEqual(result.error.hint, `The upload may have finished; open https://web.test/r/${ASSET_ID} to check before uploading again.`);
      assert.strictEqual(result.error.webUrl, `https://web.test/r/${ASSET_ID}`);
      assert.ok(!syncOps(calls).includes('multipart-abort'), 'a maybe-finished upload is never aborted');
      assert.ok(!calls.some((c) => c.route === 'POST /v1/file/jobs'));
    }
  });
  await test('a failed multipart-abort is reported as cleanup: "failed"', async () => {
    const { result } = await run(small, {
      routes: { PUT: () => new Response('no', { status: 500 }), 'op:multipart-abort': () => json(500, { error: 'internal' }) },
    });
    assert.strictEqual(result.error.code, 'upload_failed');
    assert.strictEqual(result.error.cleanup, 'failed');
    assert.ok(/cleanup failed/.test(result.error.hint), result.error.hint);
    const ok = await run(small, { routes: { PUT: () => new Response('no', { status: 500 }) } });
    assert.strictEqual(ok.result.error.cleanup, 'aborted');
  });
  await test('the file growing mid-upload → file_changed, upload aborted', async () => {
    const file = tmpFile('grow.wav', 3 * MiB);
    const { result, calls } = await run(file, { beforeComplete: async () => { fs.appendFileSync(file, Buffer.alloc(10)); } });
    assert.strictEqual(result.error.code, 'file_changed');
    assert.ok(syncOps(calls).includes('multipart-abort'));
    assert.ok(!syncOps(calls).includes('multipart-complete'));
  });
  await test('the path swapped for another file mid-upload → file_changed', async () => {
    const file = tmpFile('swap.wav', 3 * MiB);
    const other = tmpFile('other.wav', 3 * MiB);
    const { result } = await run(file, { beforeComplete: async () => { fs.renameSync(other, file); } });
    assert.strictEqual(result.error.code, 'file_changed');
  });
  await test('every part is read from the fd opened before the first request', async () => {
    // Replace the path's file after validation: the bytes uploaded must be the original's.
    const file = path.join(tmpDir, 'fd.wav');
    fs.writeFileSync(file, Buffer.alloc(1000, 0x41));
    let seen;
    const m = mockFetch({ PUT: () => new Response(null, { status: 200, headers: { etag: '"e"' } }) });
    const origFetch = m.fetchImpl;
    const fetchImpl = async (url, init) => {
      if (init?.method === 'PUT') seen = Buffer.from(init.body).toString('latin1');
      return origFetch(url, init);
    };
    const result = await transcribeFile({
      env: ENV, key: KEY, args: { path: file }, fetchImpl, sleep: async () => {},
      parseStream: async () => { fs.rmSync(file); fs.writeFileSync(file, Buffer.alloc(1000, 0x42)); return { format: {} }; },
    });
    assert.strictEqual(seen, 'A'.repeat(1000), 'uploaded the file that was validated');
    assert.strictEqual(result.error?.code, 'file_changed', 'and noticed the path now names another file');
  });
  if (process.platform !== 'win32') {
    await test('a FIFO is refused without blocking', async () => {
      const fifo = path.join(tmpDir, 'pipe.wav');
      execFileSync('mkfifo', [fifo]);
      const { result, calls } = await run(fifo);
      assert.strictEqual(result.error.code, 'invalid_request');
      assert.strictEqual(calls.length, 0);
    });
  }
  await test('a timed-out probe destroys its input stream', async () => {
    let stream;
    const { result } = await run(small, { probeTimeoutMs: 20, parseStream: (s) => { stream = s; return new Promise(() => {}); } });
    assert.strictEqual(result.success, true);
    assert.ok(stream.destroyed, 'probe stream destroyed');
  });
  await test('cancelling during the probe destroys the stream and returns cancelled', async () => {
    let stream;
    const c = new AbortController();
    const { result, calls } = await run(small, { signal: c.signal, parseStream: (s) => { stream = s; setTimeout(() => c.abort(), 5); return new Promise(() => {}); } });
    assert.strictEqual(result.error.code, 'cancelled');
    assert.ok(stream.destroyed);
    assert.strictEqual(calls.length, 0);
  });
  await test('a known duration over 5 hours → session_too_long before any network call', async () => {
    const { result, calls } = await run(small, { parseStream: audioProbe(5 * 3600 + 1) });
    assert.strictEqual(result.error.code, 'session_too_long');
    assert.strictEqual(calls.length, 0);
    const ok = await run(small, { parseStream: audioProbe(5 * 3600) });
    assert.strictEqual(ok.result.success, true);
  });
  await test('the path is not trimmed: "x.wav " does not resolve to "x.wav"', async () => {
    const file = tmpFile('x.wav', 100);
    const { result, calls } = await run(`${file} `);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error.code, 'invalid_request');
    assert.ok(result.error.message.includes(`${file} `), result.error.message);
    assert.strictEqual(calls.length, 0);
    assert.strictEqual((await run('   ')).result.error.code, 'invalid_request');
  });

  await test('forgetCachedKeyIf deletes only the key the request used, never with an env key', async () => {
    const file = path.join(tmpDir, 'forget.json');
    const env = { SEAMEET_CLOUD_CREDENTIALS_FILE: file };
    fs.writeFileSync(file, JSON.stringify({ apiKey: 'smk_new' }));
    assert.strictEqual(forgetCachedKeyIf(env, 'smk_old'), false);
    assert.ok(fs.existsSync(file));
    assert.strictEqual(forgetCachedKeyIf({ ...env, SEAMEET_API_KEY: 'smk_env' }, 'smk_new'), false);
    assert.ok(fs.existsSync(file));
    assert.strictEqual(forgetCachedKeyIf(env, 'smk_new'), true);
    assert.ok(!fs.existsSync(file));
  });

  console.log('\nReturn shape:');
  await test('success: assetId, jobId, state, webUrl, minutes, allowance, poll, next', async () => {
    const { result } = await run(small, { parseStream: audioProbe(1200) });
    assert.deepStrictEqual(Object.keys(result).sort(), ['allowanceRemainingMinutes', 'assetId', 'estimatedMinutes', 'jobId', 'next', 'pollAfterSeconds', 'state', 'success', 'webUrl'].sort());
    assert.strictEqual(result.webUrl, `https://web.test/r/${ASSET_ID}`);
    assert.strictEqual(result.jobId, 'job-1');
    assert.strictEqual(result.state, 'queued');
    assert.strictEqual(result.estimatedMinutes, 20);
    assert.strictEqual(result.allowanceRemainingMinutes, 600 - 20);
    assert.strictEqual(result.pollAfterSeconds, 120);
    assert.ok(result.next.includes(`seameet_get_recording({assetId: "${ASSET_ID}"})`));
    assert.ok(result.next.includes('about 120 seconds'));
    assert.ok(result.next.includes('"done"') && result.next.includes('"failed"'));
  });
  await test('webUrl defaults to app.seameet.ai', async () => {
    const env = { ...ENV };
    delete env.SEAMEET_WEB_URL;
    const { result } = await run(small, { env });
    assert.strictEqual(result.webUrl, `https://app.seameet.ai/r/${ASSET_ID}`);
  });
  await test('pollAfterSeconds clamps to 30…300, 60 when unknown', async () => {
    assert.strictEqual(pollAfterSeconds(60 * 1000), 30);
    assert.strictEqual(pollAfterSeconds(1200 * 1000), 120);
    assert.strictEqual(pollAfterSeconds(5 * 3600 * 1000), 300);
    assert.strictEqual(pollAfterSeconds(undefined), 60);
    assert.strictEqual(pollAfterSeconds(0), 60);
  });
  await test('title is cut to 120 code points, never splitting an emoji', async () => {
    const title = '🎙️'.repeat(10) + 'x'.repeat(100) + '🐳'.repeat(20); // 20 + 100 + 20 code points
    const cut = cutCodePoints(title, 120);
    assert.strictEqual([...cut].length, 120);
    assert.ok(!/[\uD800-\uDBFF]$/.test(cut), 'no dangling high surrogate');
    const { calls } = await run(small, { args: { title } });
    const name = calls.find((c) => c.op === 'upsert-asset').body.displayName;
    assert.strictEqual(name, cut);
    assert.strictEqual([...name].length, 120);
    assert.ok(name.length > 120, 'UTF-16 length exceeds 120 — the cut is by code points');
  });

  // -------------------------------------------------------------------------
  // stdio integration: the real server, a fake sync-api/stt-proxy/R2 on
  // localhost, progress notifications through the SDK client.
  // -------------------------------------------------------------------------

  console.log('\nThrough the MCP server (stdio):');
  const fake = await startFakeBackend();
  const base = `http://127.0.0.1:${fake.port}`;
  const serverEnv = (extra) => ({
    SEAMEET_REMOTE_URL: 'http://127.0.0.1:1/mcp',
    SEAMEET_DEVICE_URL: 'http://127.0.0.1:1/device',
    SEAMEET_MCP_CREDENTIALS_FILE: path.join(tmpDir, 'no-desktop.json'),
    SEAMEET_SUPABASE_URL: base,
    SEAMEET_SUPABASE_ANON_KEY: 'anon-int',
    SEAMEET_STT_PROXY_URL: `${base}/stt`,
    SEAMEET_WEB_URL: 'https://web.test',
    ...extra,
  });
  let client;
  try {
    const credFile = path.join(tmpDir, 'cred-int.json');
    fs.writeFileSync(credFile, JSON.stringify({ apiKey: KEY }));
    client = await connectClient(serverEnv({ SEAMEET_CLOUD_CREDENTIALS_FILE: credFile }));
    await test('tools/list includes seameet_transcribe_file even offline', async () => {
      const names = (await client.listTools()).tools.map((t) => t.name);
      assert.ok(names.includes('seameet_transcribe_file'));
    });
    await test('call uploads 20 MiB and sends throttled, increasing progress', async () => {
      const progress = [];
      const res = await client.callTool(
        { name: 'seameet_transcribe_file', arguments: { path: twenty } },
        undefined,
        { onprogress: (p) => progress.push([p.progress, p.total]), timeout: 60000 },
      );
      assert.ok(!res.isError, res.content[0].text);
      const body = JSON.parse(res.content[0].text);
      assert.strictEqual(body.assetId, ASSET_ID);
      assert.strictEqual(body.jobId, 'job-int');
      assert.ok(progress.length >= 1, 'at least one stage notification');
      assert.ok(progress.every(([, total]) => total === 11));
      for (let i = 1; i < progress.length; i++) assert.ok(progress[i][0] > progress[i - 1][0]);
      assert.strictEqual(fake.state.putLengths.reduce((a, b) => a + b, 0), 20 * MiB);
      assert.ok(fake.state.putHadLength.every(Boolean), 'every PUT carried Content-Length');
      assert.strictEqual(fake.state.lastSyncHeaders['x-api-key'], KEY);
      assert.strictEqual(fake.state.lastSyncHeaders.authorization, 'Bearer anon-int');
    });
    await test('a stt-proxy 401 at job start keeps the cached key', async () => {
      fake.state.sttReject = true;
      const res = await client.callTool({ name: 'seameet_transcribe_file', arguments: { path: small } });
      fake.state.sttReject = false;
      const body = JSON.parse(res.content[0].text);
      assert.strictEqual(body.error.code, 'job_start_failed');
      assert.strictEqual(body.assetId, ASSET_ID);
      assert.ok(fs.existsSync(credFile), 'cached key kept');
    });
    await test('cancelling the tool call aborts the multipart upload and never starts the job', async () => {
      fake.state.hangPuts = true;
      fake.state.ops = [];
      const jobsBefore = fake.state.jobs;
      const putsBefore = fake.state.puts;
      const controller = new AbortController();
      const call = client.callTool({ name: 'seameet_transcribe_file', arguments: { path: twenty } }, undefined, { signal: controller.signal });
      const deadline = Date.now() + 5000;
      while (fake.state.puts === putsBefore && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      controller.abort();
      await assert.rejects(call);
      while (!fake.state.ops.includes('multipart-abort') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      fake.state.hangPuts = false;
      assert.ok(fake.state.ops.includes('multipart-abort'), `ops: ${fake.state.ops.join(',')}`);
      assert.ok(!fake.state.ops.includes('multipart-complete'));
      await new Promise((r) => setTimeout(r, 100));
      assert.strictEqual(fake.state.jobs, jobsBefore, 'no /v1/file/jobs after a cancel');
    });
    await test('a 401 for an old key does not delete a newer key saved meanwhile', async () => {
      const newer = 'smk_' + 'b'.repeat(40);
      fake.state.rewriteKey = { file: credFile, key: newer };
      fake.state.reject = true;
      const res = await client.callTool({ name: 'seameet_transcribe_file', arguments: { path: small } });
      fake.state.reject = false;
      fake.state.rewriteKey = null;
      assert.strictEqual(JSON.parse(res.content[0].text).error.code, 'auth_required');
      assert.strictEqual(JSON.parse(fs.readFileSync(credFile, 'utf8')).apiKey, newer, 'newer key kept');
      fs.writeFileSync(credFile, JSON.stringify({ apiKey: KEY })); // restore for the next test
    });
    await test('a revoked cached key → auth_required and the cached key file is deleted', async () => {
      fake.state.reject = true;
      const res = await client.callTool({ name: 'seameet_transcribe_file', arguments: { path: small } });
      fake.state.reject = false;
      assert.strictEqual(res.isError, true);
      assert.strictEqual(JSON.parse(res.content[0].text).error.code, 'auth_required');
      assert.ok(!fs.existsSync(credFile), 'cached key removed');
    });
  } finally {
    if (client) await client.close();
  }
  let envClient;
  try {
    envClient = await connectClient(serverEnv({ SEAMEET_API_KEY: KEY, SEAMEET_CLOUD_CREDENTIALS_FILE: path.join(tmpDir, 'cred-env.json') }));
    await test('with SEAMEET_API_KEY set, a 401 says to replace that key', async () => {
      fake.state.reject = true;
      const res = await envClient.callTool({ name: 'seameet_transcribe_file', arguments: { path: small } });
      fake.state.reject = false;
      const err = JSON.parse(res.content[0].text).error;
      assert.strictEqual(err.code, 'auth_required');
      assert.ok(err.hint.includes('SEAMEET_API_KEY'));
    });
  } finally {
    if (envClient) await envClient.close();
    await new Promise((r) => fake.server.close(r));
  }
}

function startFakeBackend() {
  const state = { reject: false, sttReject: false, hangPuts: false, putLengths: [], putHadLength: [], lastSyncHeaders: null, ops: [], jobs: 0, puts: 0 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const send = (code, obj, headers = {}) => {
        res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
        res.end(obj === null ? '' : JSON.stringify(obj));
      };
      const port = server.address().port;
      if (req.url === '/functions/v1/sync-api') {
        state.lastSyncHeaders = req.headers;
        // Simulate a re-authorization landing while this request is in flight.
        if (state.rewriteKey) fs.writeFileSync(state.rewriteKey.file, JSON.stringify({ apiKey: state.rewriteKey.key }));
        if (state.reject) return send(401, { error: 'unauthorized' });
        const body = JSON.parse(raw.toString('utf8'));
        state.ops.push(body.op);
        if (body.op === 'upsert-asset') return send(200, { assetId: ASSET_ID });
        if (body.op === 'multipart-create') return send(200, { uploadId: 'up-int' });
        if (body.op === 'multipart-sign') return send(200, { url: `http://127.0.0.1:${port}/r2/${body.partNumber}` });
        if (body.op === 'multipart-complete') return send(200, { uploadState: 'complete' });
        if (body.op === 'multipart-abort') return send(200, {});
        return send(400, { error: 'bad_request' });
      }
      if (req.url.startsWith('/r2/') && req.method === 'PUT') {
        state.puts++;
        if (state.hangPuts) return; // never answer — only a cancel ends it
        state.putLengths.push(raw.length);
        state.putHadLength.push(req.headers['content-length'] === String(raw.length) && !req.headers['transfer-encoding']);
        return send(200, null, { etag: `"int-${req.url.split('/').pop()}"` });
      }
      if (req.url === '/stt/v1/file/budget') return send(200, { availableMs: 3600000, dailyRemaining: null, queueRemaining: 5 });
      if (req.url === '/stt/v1/file/jobs') state.jobs++;
      if (req.url === '/stt/v1/file/jobs' && state.sttReject) return send(401, { error: 'unauthorized' });
      if (req.url === '/stt/v1/file/jobs') return send(202, { jobId: 'job-int', state: 'queued' });
      send(404, { error: 'nf' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state })));
}

async function connectClient(env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN], env: { ...process.env, ...env }, stderr: 'ignore' });
  const client = new Client({ name: 'upload-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

// A hung await would otherwise let the event loop drain and exit 0 silently.
let finished = false;
process.on('beforeExit', () => {
  if (!finished) { console.error('upload.test.js: event loop drained before the suite finished (a test hung)'); process.exit(1); }
});

main()
  .then(() => {
    finished = true;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
    console.log('upload.test.js: PASS');
  })
  .catch((err) => { console.error(err); process.exit(1); });
