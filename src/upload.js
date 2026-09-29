/**
 * seameet_transcribe_file — upload a local audio/video file and start a
 * cloud transcription job, using the same sequence the web app's /transcribe
 * page runs (web/src/library/importAudio.ts):
 *
 *   1. validate (extension allowlist, 1 byte … 512 MiB)       — no network
 *   2. probe duration + video track with music-metadata         — no network
 *   3. GET  stt-proxy /v1/file/budget   (advisory pre-check; never blocks on failure)
 *   4. sync-api upsert-asset            (the web's exact `web-upload` identity)
 *   5. sync-api multipart-create → multipart-sign + PUT per 8 MiB part → multipart-complete
 *   6. POST stt-proxy /v1/file/jobs
 *
 * Every call carries the user's API key (`X-Api-Key`). The `web-upload`
 * originDeviceId and `web-upload-` clientRef prefix are load-bearing: every
 * server-side import guard (size, in-flight reservation, sweep, entitlement)
 * keys on them, so they must never change.
 *
 * All endpoints and limits live in this file.
 */

import { randomUUID as nodeRandomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TRANSCRIBE_TOOL_NAME = 'seameet_transcribe_file';

export const DEFAULT_SUPABASE_URL = 'https://tvezjojyndcgkneyxook.supabase.co';
// PROD anon key (web/.env.production VITE_SUPABASE_ANON_KEY) — a public client
// credential by design; it only gets a request past the Supabase gateway. The
// caller's identity is the X-Api-Key.
export const DEFAULT_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR2ZXpqb2p5bmRjZ2tuZXl4b29rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MzUxMDgsImV4cCI6MjA4ODQxMTEwOH0.HAssvUYY1QKLaGzQF7P_hTyeYMWSYpg6GEAMoRcZolw';
export const DEFAULT_STT_PROXY_URL = 'https://seameet-stt-proxy.seameet.workers.dev';
export const DEFAULT_WEB_URL = 'https://app.seameet.ai';

/** Same list and order as the web's IMPORT_AUDIO_EXTENSIONS. */
export const ALLOWED_EXTENSIONS = Object.freeze([
  'mp3', 'm4a', 'mp4', 'mov', 'wav', 'flac', 'ogg', 'oga', 'opus', 'webm', 'aac', 'amr', 'spx',
]);
/** Containers that may carry a picture; everything else is audio. */
export const VIDEO_CONTAINERS = Object.freeze(['mp4', 'mov', 'webm']);

export const MAX_FILE_BYTES = 512 * 1024 * 1024; // BytePlus file cap (IMPORT_AUDIO_MAX_BYTES)
export const PART_BYTES = 8 * 1024 * 1024; // IMPORT_PART_BYTES
export const MAX_PARTS_IN_FLIGHT = 3; // ≤ 24 MiB of part buffers in memory
export const PART_RETRY_DELAYS_MS = Object.freeze([1000, 2000, 4000]); // 3 retries after the first try

export const PROBE_TIMEOUT_MS = 10000;
export const BUDGET_TIMEOUT_MS = 10000;
export const API_TIMEOUT_MS = 30000;
// Per-part PUT timeout. An inactivity timeout would be ideal, but a Buffer
// body gives no upload-progress events in fetch, so the simpler robust choice
// is a fixed budget scaled by concurrency: MAX_PARTS_IN_FLIGHT parts share the
// uplink, so each one gets roughly 1/3 of it. 120 s for one 8 MiB part alone
// (~70 KB/s minimum) × 3 keeps that same minimum link speed when 3 run at once.
export const PART_PUT_BASE_TIMEOUT_MS = 120000;
export const PART_PUT_TIMEOUT_MS = PART_PUT_BASE_TIMEOUT_MS * MAX_PARTS_IN_FLIGHT; // 360 s
// A 409 not_synced at job start means R2/the row hadn't settled yet; retry once.
export const JOB_RETRY_DELAY_MS = 2000;

export const TITLE_MAX_CODE_POINTS = 120;
export const MAX_HOTWORDS = 100;
export const MAX_HOTWORD_CHARS = 40;

export const POLL_MIN_SECONDS = 30;
export const POLL_MAX_SECONDS = 300;
export const POLL_UNKNOWN_SECONDS = 60;

const WEB_UPLOAD_ORIGIN = 'web-upload';
const LANGUAGE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;

export const TRANSCRIBE_TOOL = {
  name: TRANSCRIBE_TOOL_NAME,
  description:
    'Upload a local audio or video file to SeaMeet and start transcribing it (speaker-labeled, 50+ ' +
    'languages). Returns an assetId right away; transcription runs in the cloud — poll ' +
    'seameet_get_recording(assetId) until asset.transcriptionJob.state is "done", then read the ' +
    'transcript and summary. Formats: mp3 m4a mp4 mov wav flac ogg oga opus webm aac amr spx; up to ' +
    '512 MB and 5 hours. Uses your transcription allowance.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or ~ path to the file on this machine.' },
      title: { type: 'string', description: 'Display name (default: the file name without extension).' },
      language: { type: 'string', description: 'Spoken language as a BCP-47 tag (e.g. "en", "ja"). Omit to auto-detect.' },
      hotwords: { type: 'array', items: { type: 'string' }, description: 'Names/terms to spell correctly (max 100, ≤40 chars each).' },
    },
    required: ['path'],
  },
};

/** Endpoints, with the documented env overrides. */
export function uploadConfig(env = process.env) {
  const trim = (s) => String(s).replace(/\/+$/, '');
  return {
    supabaseUrl: trim(env.SEAMEET_SUPABASE_URL || DEFAULT_SUPABASE_URL),
    anonKey: env.SEAMEET_SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY,
    sttProxyUrl: trim(env.SEAMEET_STT_PROXY_URL || DEFAULT_STT_PROXY_URL),
    webUrl: trim(env.SEAMEET_WEB_URL || DEFAULT_WEB_URL),
  };
}

// ---------------------------------------------------------------------------
// Errors (the epic's one shape) + relayable hints
// ---------------------------------------------------------------------------

export function toolError(code, message, hint, extras = {}) {
  const { step, assetId, ...rest } = extras;
  return {
    success: false,
    error: {
      code,
      message,
      tool: TRANSCRIBE_TOOL_NAME,
      hint,
      ...(step ? { step } : {}),
      ...rest,
    },
    ...(assetId ? { assetId } : {}),
  };
}

function envKeyInUse(env) {
  return typeof env.SEAMEET_API_KEY === 'string' && env.SEAMEET_API_KEY.startsWith('smk_');
}

/** One plain sentence per code, safe to repeat to the user as-is. */
export function hintFor(code, ctx = {}) {
  switch (code) {
    case 'auth_required':
      return ctx.envKey
        ? 'The SEAMEET_API_KEY set in your environment was rejected (revoked?); replace it with a valid key from https://app.seameet.ai/account, or unset it to authorize in the browser instead.'
        : 'Your SeaMeet cloud key was rejected (revoked?) and has been forgotten; call this tool again to re-authorize in the browser.';
    case 'insufficient_scope':
      return ctx.envKey
        ? 'The SEAMEET_API_KEY set in your environment is read-only; replace it with a read+write key from https://app.seameet.ai/account.'
        : 'This needs a SeaMeet key with write access; call seameet_logout, then call this tool again to authorize a read+write key.';
    case 'free_exhausted':
      return 'Your free transcription hours are used up; upgrade at app.seameet.ai to keep transcribing.';
    case 'import_cap_reached':
      return "You've used this billing period's transcription hours; they renew with your next billing period, and app.seameet.ai/account shows when.";
    case 'not_entitled':
      return "This SeaMeet account can't transcribe files yet; sign in at app.seameet.ai to check your plan.";
    case 'disabled':
      return 'Transcription is turned off for this SeaMeet account; contact SeaMeet support at info@seameet.ai.';
    case 'daily_import_limit':
      return "You've reached today's upload limit; try again tomorrow.";
    case 'queue_full':
      return 'You already have the most files transcribing at once; wait for one to finish, then try again.';
    case 'session_too_long':
      return 'This recording is longer than 5 hours, the most SeaMeet transcribes in one file; split it and try again.';
    case 'upload_incomplete':
      return `SeaMeet was still finishing the upload, so transcription did not start; open ${ctx.webUrl} in a minute to start transcription there.`;
    case 'too_large':
      return ctx.quota
        ? 'Your SeaMeet cloud storage is full; free up space or upgrade at app.seameet.ai, then try again.'
        : 'Files over 512 MB: use app.seameet.ai, which can extract the audio track.';
    case 'insufficient_allowance':
      return `This file is about ${ctx.estimatedMinutes} minutes but you have ${ctx.hoursLeft} hours of transcription left; upgrade at app.seameet.ai or choose a shorter file.`;
    case 'unsupported_type':
      return `SeaMeet can transcribe ${ALLOWED_EXTENSIONS.join(', ')} files; convert this one to one of those formats and try again.`;
    case 'empty_file':
      return 'That file is empty (0 bytes); check the path and try again.';
    case 'upload_failed':
      return `The upload stopped at step "${ctx.step}"; check the network connection and call this tool again.`;
    case 'service_unavailable':
      return ctx.webUrl
        ? `SeaMeet is briefly unavailable; the file is saved at ${ctx.webUrl}, so try this tool again in a minute or start transcription there.`
        : 'SeaMeet is briefly unavailable; call this tool again in a minute.';
    case 'job_start_failed':
      return `The file is in your SeaMeet library but transcription could not start; open ${ctx.webUrl} to start it there.`;
    case 'cancelled':
      return ctx.assetId
        ? 'The upload was cancelled and nothing was transcribed; the partial upload was aborted, though an empty entry may remain in your SeaMeet library.'
        : 'The upload was cancelled before anything was sent.';
    default:
      return 'Something went wrong talking to SeaMeet; try again in a minute.';
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export function expandHome(p, home = os.homedir()) {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

/** Cut to N Unicode code points so an emoji or astral character is never split. */
export function cutCodePoints(s, max = TITLE_MAX_CODE_POINTS) {
  return [...s].slice(0, max).join('');
}

export function partCount(sizeBytes, partBytes = PART_BYTES) {
  return Math.max(1, Math.ceil(sizeBytes / partBytes));
}

export function pollAfterSeconds(estimatedDurationMs) {
  if (!Number.isFinite(estimatedDurationMs) || estimatedDurationMs <= 0) return POLL_UNKNOWN_SECONDS;
  const s = Math.round(estimatedDurationMs / 1000 / 10);
  return Math.min(POLL_MAX_SECONDS, Math.max(POLL_MIN_SECONDS, s));
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`timed out after ${ms} ms`), { code: 'ETIMEDOUT' })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Validate the file without touching the network.
 * @returns {Promise<{ok:true, filePath, ext, sizeBytes, baseName} | {ok:false, payload}>}
 */
export async function checkFile(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    return { ok: false, payload: toolError('invalid_request', 'path is required.', 'Pass the absolute or ~ path of an audio or video file on this machine.') };
  }
  const filePath = path.resolve(expandHome(rawPath.trim()));
  let st;
  try {
    st = await fs.promises.stat(filePath);
  } catch (err) {
    const missing = err?.code === 'ENOENT' || err?.code === 'ENOTDIR';
    return {
      ok: false,
      payload: toolError(
        'invalid_request',
        missing ? `No file at ${filePath}.` : `Cannot read ${filePath}: ${err?.message || err}.`,
        missing ? 'Check the path (it must be on this machine) and try again.' : 'Check that the file is readable and try again.',
      ),
    };
  }
  if (!st.isFile()) {
    return { ok: false, payload: toolError('invalid_request', `${filePath} is not a regular file.`, 'Pass the path of a single audio or video file, not a folder.') };
  }
  const base = path.basename(filePath);
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return { ok: false, payload: toolError('unsupported_type', `.${ext || '(none)'} files are not supported.`, hintFor('unsupported_type')) };
  }
  if (st.size <= 0) return { ok: false, payload: toolError('empty_file', 'The file is empty.', hintFor('empty_file')) };
  if (st.size > MAX_FILE_BYTES) {
    return { ok: false, payload: toolError('too_large', `The file is ${Math.ceil(st.size / 1048576)} MB; the limit is 512 MB.`, hintFor('too_large')) };
  }
  const baseName = (dot > 0 ? base.slice(0, dot) : base).trim() || base;
  return { ok: true, filePath, ext, sizeBytes: st.size, baseName };
}

/**
 * Best-effort header probe. `duration:false` so a header without a length
 * never triggers a whole-file scan; a missing or 0 duration (fragmented MP4)
 * is omitted and the worker reserves the safe maximum.
 */
export async function probeMedia(filePath, ext, { parseFile, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  let format = null;
  try {
    const parse = parseFile ?? (await import('music-metadata')).parseFile;
    const meta = await withTimeout(Promise.resolve().then(() => parse(filePath, { duration: false, skipCovers: true })), timeoutMs);
    format = meta?.format ?? null;
  } catch {
    format = null;
  }
  const d = format?.duration;
  const estimatedDurationMs = Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : undefined;
  let hasVideo = false;
  if (VIDEO_CONTAINERS.includes(ext)) {
    // QuickTime is (almost) always video; assume so when the probe fails.
    hasVideo = format ? format.hasVideo === true : ext === 'mov';
  }
  return { estimatedDurationMs, hasVideo };
}

function validateOptions(args) {
  let language;
  if (args.language !== undefined && args.language !== null) {
    if (typeof args.language !== 'string') return { error: 'language must be a string.' };
    const l = args.language.trim();
    if (l && l.toLowerCase() !== 'auto') {
      if (!LANGUAGE_RE.test(l)) return { error: `"${l}" is not a BCP-47 language tag.` };
      language = l;
    }
  }
  let hotwords;
  if (args.hotwords !== undefined && args.hotwords !== null) {
    if (!Array.isArray(args.hotwords) || args.hotwords.some((h) => typeof h !== 'string')) {
      return { error: 'hotwords must be an array of strings.' };
    }
    const cleaned = [...new Set(args.hotwords.map((h) => h.trim()).filter(Boolean))];
    if (cleaned.length > MAX_HOTWORDS) return { error: `At most ${MAX_HOTWORDS} hotwords are allowed.` };
    const long = cleaned.find((h) => [...h].length > MAX_HOTWORD_CHARS);
    if (long) return { error: `Hotword "${long}" is longer than ${MAX_HOTWORD_CHARS} characters.` };
    if (cleaned.length) hotwords = cleaned;
  }
  if (args.title !== undefined && args.title !== null && typeof args.title !== 'string') {
    return { error: 'title must be a string.' };
  }
  return { language, hotwords };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export class CancelledError extends Error {
  constructor() {
    super('Cancelled by the client.');
    this.name = 'CancelledError';
  }
}

/**
 * One signal that aborts when any input does. AbortSignal.any needs Node
 * 20.3 / 18.17; package.json allows Node >= 18.0, so fall back to wiring it
 * by hand. The returned dispose() detaches the listeners.
 */
export function anySignal(signals) {
  const list = signals.filter(Boolean);
  if (typeof AbortSignal.any === 'function') return { signal: AbortSignal.any(list), dispose: () => {} };
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const s of list) {
    if (s.aborted) { controller.abort(); break; }
    s.addEventListener('abort', onAbort, { once: true });
  }
  return { signal: controller.signal, dispose: () => list.forEach((s) => s.removeEventListener('abort', onAbort)) };
}

/** Run fetch with a timeout, also aborted by the caller's `signal` (→ CancelledError). */
async function fetchWithSignal(fetchImpl, url, init, timeoutMs, signal) {
  if (signal?.aborted) throw new CancelledError();
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const combined = anySignal([timeout.signal, signal]);
  try {
    return await fetchImpl(url, { ...init, signal: combined.signal });
  } catch (err) {
    if (signal?.aborted) throw new CancelledError();
    if (timeout.signal.aborted) throw Object.assign(new Error(`timed out after ${timeoutMs} ms`), { code: 'ETIMEDOUT' });
    throw err;
  } finally {
    clearTimeout(timer);
    combined.dispose();
  }
}

async function httpJson(fetchImpl, url, init, timeoutMs, signal) {
  if (signal?.aborted) throw new CancelledError();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const combined = anySignal([controller.signal, signal]);
  try {
    let res;
    try {
      res = await fetchImpl(url, { ...init, signal: combined.signal });
    } catch (err) {
      if (signal?.aborted) throw new CancelledError();
      throw err;
    }
    let body = null;
    try {
      const text = await res.text();
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (signal?.aborted) throw new CancelledError();
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
    combined.dispose();
  }
}

class HttpFailure extends Error {
  constructor(status, body, source) {
    super((body && (body.detail || body.error)) || `HTTP ${status}`);
    this.status = status;
    this.body = body;
    this.source = source; // 'sync-api' | 'stt-proxy'
  }
}

function makeClients(cfg, key, fetchImpl, defaultSignal) {
  // `signal` defaults to the caller's cancellation signal; pass null for
  // cleanup calls (multipart-abort) that must still go out after a cancel.
  async function syncApi(op, args = {}, signal = defaultSignal) {
    let r;
    try {
      r = await httpJson(fetchImpl, `${cfg.supabaseUrl}/functions/v1/sync-api`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.anonKey}`,
          apikey: cfg.anonKey,
          'X-Api-Key': key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...args, op }),
      }, API_TIMEOUT_MS, signal);
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      throw Object.assign(new Error(`sync-api ${op}: ${err?.message || err}`), { network: true });
    }
    if (r.status < 200 || r.status >= 300) throw new HttpFailure(r.status, r.body, 'sync-api');
    return r.body || {};
  }

  async function stt(method, route, body, timeoutMs = API_TIMEOUT_MS) {
    let r;
    try {
      r = await httpJson(fetchImpl, `${cfg.sttProxyUrl}${route}`, {
        method,
        headers: { 'X-Api-Key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }, timeoutMs, defaultSignal);
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      throw Object.assign(new Error(`stt-proxy ${route}: ${err?.message || err}`), { network: true });
    }
    if (r.status < 200 || r.status >= 300) throw new HttpFailure(r.status, r.body, 'stt-proxy');
    return r.body || {};
  }

  return { syncApi, stt };
}

const PASS_THROUGH_STT_CODES = new Set([
  'free_exhausted', 'import_cap_reached', 'not_entitled', 'disabled', 'daily_import_limit', 'queue_full', 'session_too_long',
]);

/**
 * Map an HTTP failure onto the issue's error table. Returns null when the
 * failure is not a mapped row (the caller then uses its step-specific code).
 */
export function mapHttpFailure(err) {
  if (!(err instanceof HttpFailure)) return null;
  const code = err.body?.error;
  // Only sync-api's 401 means the key itself is bad. stt-proxy is always
  // called after sync-api has accepted the same key in this call, so its 401
  // (e.g. a proxy that predates API-key auth) must never delete the key.
  if (err.status === 401 && err.source === 'sync-api') return { code: 'auth_required', auth: true };
  if (err.status === 401) return { code: 'job_start_failed', sttUnauthorized: true };
  if (err.status === 403 && code === 'insufficient_scope') return { code: 'insufficient_scope' };
  if (err.source === 'stt-proxy') {
    if (PASS_THROUGH_STT_CODES.has(code) && [403, 413, 429].includes(err.status)) return { code };
    if (err.status === 413) return { code: 'session_too_long' };
    if (err.status === 409 && code === 'not_synced') return { code: 'upload_incomplete' };
  }
  if (err.source === 'sync-api' && err.status === 413) return { code: 'too_large', quota: code === 'quota_exceeded' };
  // auth_unavailable / budget_unavailable / no_route: a transient outage —
  // the key is fine, so never treat it like a rejected key.
  if (err.status === 503) return { code: 'service_unavailable' };
  return null;
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {object} o.env
 * @param {string} o.key                     the user's smk_ API key
 * @param {object} o.args                    tool arguments
 * @param {typeof fetch} [o.fetchImpl]
 * @param {(ms:number)=>Promise<void>} [o.sleep]   injectable for fast tests
 * @param {(done:number,total:number)=>Promise<void>|void} [o.onProgress]
 * @param {()=>void} [o.onUnauthorized]      a 401: drop the cached key
 * @param {Function} [o.parseFile]           music-metadata parseFile override
 * @param {()=>string} [o.randomUUID]
 * @param {AbortSignal} [o.signal]           MCP request cancellation
 */
export async function transcribeFile({
  env = process.env,
  key,
  args = {},
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  onProgress,
  onUnauthorized,
  parseFile,
  randomUUID = nodeRandomUUID,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
  partTimeoutMs = PART_PUT_TIMEOUT_MS,
  jobRetryDelayMs = JOB_RETRY_DELAY_MS,
  signal,
} = {}) {
  const cfg = uploadConfig(env);
  const envKey = envKeyInUse(env);

  // 1. Validate — no network before this passes.
  const opts = validateOptions(args || {});
  if (opts.error) return toolError('invalid_request', opts.error, 'Fix that argument and call the tool again.');
  const file = await checkFile(args?.path);
  if (!file.ok) return file.payload;

  // 2. Probe.
  const { estimatedDurationMs, hasVideo } = await probeMedia(file.filePath, file.ext, { parseFile, timeoutMs: probeTimeoutMs });
  const estimatedMinutes = estimatedDurationMs !== undefined ? Math.round(estimatedDurationMs / 60000) : null;

  const { syncApi, stt } = makeClients(cfg, key, fetchImpl, signal);
  // Backoff sleeps end early on cancel so a cancelled call returns promptly.
  const pause = (ms) => new Promise((resolve) => {
    if (!signal) { Promise.resolve(sleep(ms)).then(resolve, resolve); return; }
    if (signal.aborted) { resolve(); return; }
    const onAbort = () => resolve();
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(sleep(ms)).then(() => { signal.removeEventListener('abort', onAbort); resolve(); }, resolve);
  });
  let assetId;
  let uploadComplete = false; // webUrl only means something once the bytes are in

  const cancelled = (step) => toolError(
    'cancelled',
    'The request was cancelled.',
    hintFor('cancelled', { assetId }),
    { ...(step ? { step } : {}), ...(assetId ? { assetId } : {}) },
  );

  const fail = (err, fallbackCode, extras = {}) => {
    if (err instanceof CancelledError || signal?.aborted) return cancelled(extras.step);
    const mapped = mapHttpFailure(err);
    const webUrl = uploadComplete ? `${cfg.webUrl}/r/${assetId}` : undefined;
    const ctxExtras = { ...(assetId ? { assetId } : {}), ...extras };
    if (mapped?.auth) {
      try { onUnauthorized?.(); } catch { /* best-effort */ }
      return toolError('auth_required', 'Your SeaMeet cloud key was rejected.', hintFor('auth_required', { envKey }), ctxExtras);
    }
    if (mapped) {
      const message = mapped.sttUnauthorized
        ? 'The transcription service did not accept this key (it may not support API keys yet).'
        : err.message;
      return toolError(mapped.code, message, hintFor(mapped.code, { envKey, quota: mapped.quota, webUrl }), ctxExtras);
    }
    return toolError(
      fallbackCode,
      err?.message || String(err),
      hintFor(fallbackCode, { step: extras.step, webUrl }),
      ctxExtras,
    );
  };

  // 3. Budget pre-check — advisory; any failure (including a 401 from a
  //    proxy that predates key auth) is ignored and sync-api decides.
  let budget = null;
  if (signal?.aborted) return cancelled();
  try {
    budget = await stt('GET', '/v1/file/budget', null, BUDGET_TIMEOUT_MS);
  } catch {
    budget = null;
  }
  if (signal?.aborted) return cancelled();
  if (budget && typeof budget === 'object') {
    if (budget.dailyRemaining === 0) {
      return toolError('daily_import_limit', 'The daily upload limit is reached.', hintFor('daily_import_limit'));
    }
    if (budget.queueRemaining === 0) {
      return toolError('queue_full', 'Too many files are already transcribing.', hintFor('queue_full'));
    }
    if (estimatedDurationMs !== undefined && Number.isFinite(budget.availableMs) && estimatedDurationMs > budget.availableMs) {
      const hoursLeft = (budget.availableMs / 3600000).toFixed(1);
      return toolError(
        'insufficient_allowance',
        `The file needs about ${estimatedMinutes} minutes; ${hoursLeft} hours of transcription are left.`,
        hintFor('insufficient_allowance', { estimatedMinutes, hoursLeft }),
        { availableMs: budget.availableMs, estimatedDurationMs },
      );
    }
  }

  // 4. Asset row — the web's exact identity.
  const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : file.baseName;
  try {
    const up = await syncApi('upsert-asset', {
      clientRef: `web-upload-${randomUUID()}`,
      kind: hasVideo ? 'video' : 'audio',
      displayName: cutCodePoints(title, TITLE_MAX_CODE_POINTS),
      ext: file.ext,
      sizeBytes: file.sizeBytes,
      hasVideo,
      originDeviceId: WEB_UPLOAD_ORIGIN,
      localPresent: true,
    });
    if (!up.assetId) throw new Error('upsert-asset returned no assetId');
    assetId = up.assetId;
  } catch (err) {
    return fail(err, 'upload_failed', { step: 'upsert-asset' });
  }

  // 5. Multipart upload.
  let uploadId;
  try {
    const mp = await syncApi('multipart-create', { assetId });
    if (!mp.uploadId) throw new Error('multipart-create returned no uploadId');
    uploadId = mp.uploadId;
  } catch (err) {
    return fail(err, 'upload_failed', { step: 'create' });
  }

  const total = partCount(file.sizeBytes);
  // Deliberately not tied to the cancellation signal: it must go out after a cancel.
  const abort = async () => {
    try { await syncApi('multipart-abort', { assetId, uploadId }, null); } catch { /* best-effort */ }
  };

  let fh;
  try {
    fh = await fs.promises.open(file.filePath, 'r');
  } catch (err) {
    await abort();
    return fail(err, 'upload_failed', { step: 'part 1' });
  }

  const etags = new Array(total);
  let nextPart = 1;
  let partsDone = 0;
  let failure = null;

  const readPart = async (n) => {
    const start = (n - 1) * PART_BYTES;
    const length = Math.min(PART_BYTES, file.sizeBytes - start);
    const buf = Buffer.alloc(length);
    let off = 0;
    while (off < length) {
      const { bytesRead } = await fh.read(buf, off, length - off, start + off);
      if (bytesRead === 0) throw new Error(`file shrank while reading part ${n}`);
      off += bytesRead;
    }
    return buf;
  };

  const putPart = async (n, buf) => {
    let lastErr;
    for (let attempt = 0; attempt <= PART_RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) await pause(PART_RETRY_DELAYS_MS[attempt - 1]);
      if (signal?.aborted) throw new CancelledError();
      if (failure) throw failure.err; // another part already failed — stop early
      try {
        const signed = await syncApi('multipart-sign', { assetId, uploadId, partNumber: n });
        if (!signed.url) throw new Error('multipart-sign returned no url');
        const res = await fetchWithSignal(fetchImpl, signed.url, {
          method: 'PUT',
          headers: { 'Content-Length': String(buf.length) },
          body: buf,
        }, partTimeoutMs, signal);
        try { await res.arrayBuffer?.(); } catch { /* drain */ }
        if (!res.ok) throw new Error(`part ${n} HTTP ${res.status}`);
        const etag = (res.headers?.get?.('etag') ?? '').replace(/"/g, '');
        if (!etag) throw new Error(`part ${n} missing etag`);
        return etag;
      } catch (err) {
        if (err instanceof CancelledError || signal?.aborted) throw new CancelledError();
        // A rejected key or scope won't get better by retrying.
        if (err instanceof HttpFailure && (err.status === 401 || err.status === 403)) throw err;
        lastErr = err;
      }
    }
    throw lastErr;
  };

  const worker = async () => {
    while (!failure && nextPart <= total) {
      const n = nextPart++;
      if (signal?.aborted) {
        if (!failure) failure = { n, err: new CancelledError() };
        return;
      }
      try {
        const buf = await readPart(n);
        etags[n - 1] = await putPart(n, buf);
        partsDone++;
        try { await onProgress?.(partsDone, total); } catch { /* progress is best-effort */ }
      } catch (err) {
        if (!failure) failure = { n, err };
        return;
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(MAX_PARTS_IN_FLIGHT, total) }, worker));
  } finally {
    try { await fh.close(); } catch { /* ignore */ }
  }
  if (failure) {
    await abort();
    return fail(failure.err, 'upload_failed', { step: `part ${failure.n}` });
  }

  if (signal?.aborted) {
    await abort();
    return cancelled('complete');
  }
  try {
    await syncApi('multipart-complete', {
      assetId,
      uploadId,
      parts: etags.map((etag, i) => ({ partNumber: i + 1, etag })),
    });
  } catch (err) {
    await abort();
    return fail(err, 'upload_failed', { step: 'complete' });
  }
  uploadComplete = true;

  // 6. Start the job. A failure here leaves the asset in the library,
  //    untranscribed (as on the web) — the error carries assetId.
  const webUrl = `${cfg.webUrl}/r/${assetId}`;
  const jobBody = {
    assetId,
    ...(opts.language ? { language: opts.language } : {}),
    ...(estimatedDurationMs !== undefined ? { estimatedDurationMs } : {}),
    ...(opts.hotwords ? { options: { hotwords: opts.hotwords } } : {}),
  };
  let job;
  try {
    if (signal?.aborted) throw new CancelledError();
    try {
      job = await stt('POST', '/v1/file/jobs', jobBody);
    } catch (err) {
      // 409 not_synced: the completed object hadn't settled yet. Retry once;
      // re-running the whole tool would upload a duplicate.
      if (mapHttpFailure(err)?.code !== 'upload_incomplete') throw err;
      await pause(jobRetryDelayMs);
      if (signal?.aborted) throw new CancelledError();
      job = await stt('POST', '/v1/file/jobs', jobBody);
    }
  } catch (err) {
    const payload = fail(err, 'job_start_failed');
    if (payload.error.code !== 'cancelled') payload.error.webUrl = webUrl;
    return payload;
  }

  // 7. What the next call needs.
  const poll = pollAfterSeconds(estimatedDurationMs);
  const availableMin = budget && Number.isFinite(budget.availableMs) ? Math.round(budget.availableMs / 60000) : null;
  return {
    success: true,
    assetId,
    jobId: job.jobId ?? null,
    state: job.state ?? null,
    webUrl,
    estimatedMinutes,
    allowanceRemainingMinutes: availableMin !== null && estimatedMinutes !== null ? Math.max(0, availableMin - estimatedMinutes) : null,
    pollAfterSeconds: poll,
    next:
      `Call seameet_get_recording({assetId: "${assetId}"}) in about ${poll} seconds; it is done when ` +
      'asset.transcriptionJob.state is "done" and failed if it is "failed".',
  };
}
