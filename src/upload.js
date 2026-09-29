/**
 * seameet_transcribe_file — upload a local audio/video file and start a
 * cloud transcription job, using the same sequence the web app's /transcribe
 * page runs (web/src/library/importAudio.ts):
 *
 *   1. open the file once, validate it through that fd (regular file,
 *      extension allowlist, 1 byte … 512 MiB)                    — no network
 *   2. probe duration + video track with music-metadata on the same fd
 *      (a known duration over 5 h is refused here)              — no network
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
import { Readable } from 'node:stream';

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
// JSON responses are read with a byte cap, inside the request's timeout.
export const MAX_JSON_BYTES = 1024 * 1024;
// The longest recording one job can transcribe (stt-proxy SESSION_CAP_MS).
export const MAX_SESSION_MS = 5 * 3600 * 1000;
// Stage progress notifications are throttled to at most one per second.
export const PROGRESS_MIN_INTERVAL_MS = 1000;

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

/**
 * One plain sentence per code, safe to repeat to the user as-is.
 *
 * `ctx.webUrl` is set only once the upload is complete. From then on every
 * hint points at that existing asset and never says to run the tool again:
 * a re-run would upload a duplicate.
 */
export function hintFor(code, ctx = {}) {
  // The web app the user signs in to (SEAMEET_WEB_URL): DEV hints point at DEV.
  const site = (ctx.site || DEFAULT_WEB_URL).replace(/\/$/, '');
  const host = site.replace(/^https?:\/\//, '');
  const w = ctx.webUrl;
  switch (code) {
    case 'auth_required':
      return ctx.envKey
        ? `The SEAMEET_API_KEY set in your environment was rejected (revoked?); replace it with a valid key from ${site}/account, or unset it to authorize in the browser instead.`
        : 'Your SeaMeet cloud key was rejected (revoked?) and has been forgotten; call this tool again to re-authorize in the browser.';
    case 'insufficient_scope':
      if (w) return `The transcription service needs a key with write access, so transcription did not start; the file is saved, so open ${w} to start transcription there.`;
      return ctx.envKey
        ? `The SEAMEET_API_KEY set in your environment is read-only; replace it with a read+write key from ${site}/account.`
        : 'This needs a SeaMeet key with write access; call seameet_logout, then call this tool again to authorize a read+write key.';
    case 'free_exhausted':
      return w
        ? `Your free transcription hours are used up; upgrade at ${host}, then open ${w} to transcribe this file.`
        : `Your free transcription hours are used up; upgrade at ${host} to keep transcribing.`;
    case 'import_cap_reached':
      return w
        ? `You've used this billing period's transcription hours; the file is saved, so open ${w} to transcribe it once your hours renew.`
        : `You've used this billing period's transcription hours; they renew with your next billing period, and ${host}/account shows when.`;
    case 'not_entitled':
      return w
        ? `This SeaMeet account can't transcribe files yet; check your plan at ${host}, then open ${w} to transcribe this file.`
        : `This SeaMeet account can't transcribe files yet; sign in at ${host} to check your plan.`;
    case 'disabled':
      return w
        ? `Transcription is turned off for this SeaMeet account; contact SeaMeet support at info@seameet.ai, and the file stays in your library at ${w}.`
        : 'Transcription is turned off for this SeaMeet account; contact SeaMeet support at info@seameet.ai.';
    case 'daily_import_limit':
      return w
        ? `You've reached today's transcription limit; the file is saved, so open ${w} tomorrow to start transcription there.`
        : "You've reached today's upload limit; try again tomorrow.";
    case 'queue_full':
      return w
        ? `You already have the most files transcribing at once; when one finishes, open ${w} to start this one.`
        : 'You already have the most files transcribing at once; wait for one to finish, then try again.';
    case 'session_too_long':
      return w
        ? `This recording is longer than 5 hours, the most SeaMeet transcribes in one file; it stays in your library at ${w}, and to transcribe it, split it into shorter files.`
        : 'This recording is longer than 5 hours, the most SeaMeet transcribes in one file; split it and try again.';
    case 'upload_incomplete':
      return `SeaMeet was still finishing the upload, so transcription did not start; open ${w} in a minute to start transcription there.`;
    case 'too_large':
      return ctx.quota
        ? `Your SeaMeet cloud storage is full; free up space or upgrade at ${host}, then try again.`
        : `Files over 512 MB: use ${host}, which can extract the audio track.`;
    case 'insufficient_allowance':
      return `This file is about ${ctx.estimatedMinutes} minutes but you have ${ctx.hoursLeft} hours of transcription left; upgrade at ${host} or choose a shorter file.`;
    case 'unsupported_type':
      return `SeaMeet can transcribe ${ALLOWED_EXTENSIONS.join(', ')} files; convert this one to one of those formats and try again.`;
    case 'empty_file':
      return 'That file is empty (0 bytes); check the path and try again.';
    case 'file_changed':
      return 'The file changed while it was uploading, so the upload was stopped; wait until it has finished being written, then call this tool again.';
    case 'upload_failed':
      return ctx.cleanup === 'failed'
        ? `The upload stopped at step "${ctx.step}" and its cleanup failed (SeaMeet clears stale partial uploads on its own); check the network connection and call this tool again.`
        : `The upload stopped at step "${ctx.step}"; check the network connection and call this tool again.`;
    case 'upload_unknown':
      return `The upload may have finished; open ${w} to check before uploading again.`;
    case 'service_unavailable':
      return w
        ? `SeaMeet is briefly unavailable, so transcription did not start; open ${w} in a minute to start transcription there.`
        : 'SeaMeet is briefly unavailable; call this tool again in a minute.';
    case 'job_start_failed':
      return `The file is in your SeaMeet library but transcription could not start; open ${w} to start it there.`;
    case 'outcome_unknown':
      return 'Transcription may have started; check asset.transcriptionJob with seameet_get_recording before doing anything else.';
    case 'cancelled':
      if (w) return `The request was cancelled before transcription started; the file is saved, so open ${w} to start transcription there.`;
      if (ctx.cleanup === 'failed') return 'The upload was cancelled and nothing was transcribed; cleaning up the partial upload failed, but SeaMeet clears stale partial uploads on its own.';
      return ctx.assetId
        ? 'The upload was cancelled and nothing was transcribed; the partial upload was aborted, though an empty entry may remain in your SeaMeet library.'
        : 'The upload was cancelled before anything was sent.';
    default:
      return w
        ? `Something went wrong after the upload finished; open ${w} to start transcription there.`
        : 'Something went wrong talking to SeaMeet; try again in a minute.';
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

export class CancelledError extends Error {
  constructor() {
    super('Cancelled by the client.');
    this.name = 'CancelledError';
  }
}

/**
 * One signal that aborts when any input does, wired by hand. Not
 * AbortSignal.any: it is missing before Node 18.17, and on Node 18.20 a
 * signal composed from another composed signal never fired in our tests (the
 * upload nests them: request timeout → part scope → cancel). The listeners
 * stay attached until dispose() — callers dispose only after the response
 * body has been consumed, so an abort still reaches a body read in progress.
 */
export function anySignal(signals) {
  const list = signals.filter(Boolean);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const s of list) {
    if (s.aborted) { controller.abort(); break; }
    s.addEventListener('abort', onAbort, { once: true });
  }
  return { signal: controller.signal, dispose: () => list.forEach((s) => s.removeEventListener('abort', onAbort)) };
}

/**
 * Settle with `promise`, or reject as soon as `signal` aborts — so a fetch
 * implementation that ignores its signal still can't outlive a timeout or a
 * cancel.
 */
function raceAbort(promise, signal) {
  if (!signal) return promise;
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => {});
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', onAbort));
}

/** Read a response body as text, at most `maxBytes`, stopping when `signal` aborts. */
export async function readCappedText(res, maxBytes, signal) {
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await res.text();
    if (Buffer.byteLength(text) > maxBytes) throw Object.assign(new Error(`response larger than ${maxBytes} bytes`), { code: 'bad_response' });
    return text;
  }
  const reader = body.getReader();
  const onAbort = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw new Error('aborted while reading the response');
      const { done, value } = await raceAbort(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        reader.cancel().catch(() => {});
        throw Object.assign(new Error(`response larger than ${maxBytes} bytes`), { code: 'bad_response' });
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
    if (signal?.aborted) throw new Error('aborted while reading the response');
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

// ---------------------------------------------------------------------------
// File: one fd for validation, probe and every part
// ---------------------------------------------------------------------------

/**
 * Open the file ONCE and validate it through that fd, so the bytes validated,
 * probed and uploaded all come from the same file even if the path is swapped
 * afterwards. The caller owns `handle` and must close it.
 * @returns {Promise<{ok:true, handle, filePath, ext, sizeBytes, baseName, stat} | {ok:false, payload}>}
 */
export async function openFile(rawPath) {
  // trim() only detects blank input: the path itself is used unmodified, so
  // "/tmp/x.wav " never silently becomes "/tmp/x.wav".
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    return { ok: false, payload: toolError('invalid_request', 'path is required.', 'Pass the absolute or ~ path of an audio or video file on this machine.') };
  }
  const filePath = path.resolve(expandHome(rawPath));
  const base = path.basename(filePath);
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  let pre;
  try {
    pre = await fs.promises.stat(filePath);
  } catch (err) {
    return { ok: false, payload: statError(filePath, err) };
  }
  // Checked before open(): a FIFO or device could block open()/read().
  if (!pre.isFile()) {
    return { ok: false, payload: toolError('invalid_request', `${filePath} is not a regular file.`, 'Pass the path of a single audio or video file, not a folder, pipe or device.') };
  }
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return { ok: false, payload: toolError('unsupported_type', `.${ext || '(none)'} files are not supported.`, hintFor('unsupported_type')) };
  }
  let handle;
  try {
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  } catch (err) {
    return { ok: false, payload: statError(filePath, err) };
  }
  try {
    // Re-check through the fd: the path may have been swapped since stat().
    const st = await handle.stat();
    if (!st.isFile()) {
      await handle.close();
      return { ok: false, payload: toolError('invalid_request', `${filePath} is not a regular file.`, 'Pass the path of a single audio or video file, not a folder, pipe or device.') };
    }
    if (st.size <= 0) {
      await handle.close();
      return { ok: false, payload: toolError('empty_file', 'The file is empty.', hintFor('empty_file')) };
    }
    if (st.size > MAX_FILE_BYTES) {
      await handle.close();
      return { ok: false, payload: toolError('too_large', `The file is ${Math.ceil(st.size / 1048576)} MB; the limit is 512 MB.`, hintFor('too_large')) };
    }
    const baseName = (dot > 0 ? base.slice(0, dot) : base).trim() || base;
    return { ok: true, handle, filePath, ext, sizeBytes: st.size, baseName, stat: st };
  } catch (err) {
    try { await handle.close(); } catch { /* ignore */ }
    return { ok: false, payload: statError(filePath, err) };
  }
}

function statError(filePath, err) {
  const missing = err?.code === 'ENOENT' || err?.code === 'ENOTDIR';
  return toolError(
    'invalid_request',
    missing ? `No file at ${filePath}.` : `Cannot read ${filePath}: ${err?.message || err}.`,
    missing ? 'Check the path (it must be on this machine) and try again.' : 'Check that the file is readable and try again.',
  );
}

/** Validate a path without keeping it open (tests + callers that only check). */
export async function checkFile(rawPath) {
  const r = await openFile(rawPath);
  if (r.ok) {
    await r.handle.close();
    const { handle, stat, ...rest } = r;
    void handle; void stat;
    return rest;
  }
  return r;
}

/**
 * A Readable over positional reads of `handle`. Node's own fd/FileHandle read
 * streams close the descriptor on destroy() even with autoClose:false, and the
 * upload still needs it, so the probe gets this instead: destroying it only
 * stops reading.
 */
export function handleReadStream(handle, size, chunkBytes = 64 * 1024) {
  let pos = 0;
  return new Readable({
    highWaterMark: chunkBytes,
    read() {
      const len = Math.min(chunkBytes, size - pos);
      if (len <= 0) { this.push(null); return; }
      const buf = Buffer.alloc(len);
      handle.read(buf, 0, len, pos).then(({ bytesRead }) => {
        if (this.destroyed) return;
        if (bytesRead === 0) { this.push(null); return; }
        pos += bytesRead;
        this.push(bytesRead === len ? buf : buf.subarray(0, bytesRead));
      }, (err) => { if (!this.destroyed) this.destroy(err); });
    },
  });
}

/**
 * Best-effort header probe over the already-open handle. `duration:false` so a
 * header without a length never triggers a whole-file scan; a missing or 0
 * duration (fragmented MP4) is omitted and the worker reserves the safe
 * maximum. The input stream is destroyed on timeout or cancel, so a stuck
 * probe stops reading instead of running on in the background.
 */
export async function probeMedia(handle, { ext, sizeBytes, name, parseStream, timeoutMs = PROBE_TIMEOUT_MS, signal } = {}) {
  let format = null;
  let stream;
  let timer;
  let onAbort;
  try {
    const parse = parseStream ?? (await import('music-metadata')).parseStream;
    stream = handleReadStream(handle, sizeBytes);
    stream.on('error', () => {}); // destroy() below must not surface as an unhandled error
    const stop = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`probe timed out after ${timeoutMs} ms`), { code: 'ETIMEDOUT' })), timeoutMs);
      if (signal) {
        onAbort = () => reject(new CancelledError());
        if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    const meta = await Promise.race([
      Promise.resolve().then(() => parse(stream, { size: sizeBytes, path: name }, { duration: false, skipCovers: true })),
      stop,
    ]);
    format = meta?.format ?? null;
  } catch {
    format = null;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
    if (stream && !stream.destroyed) stream.destroy();
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

class HttpFailure extends Error {
  constructor(status, body, source) {
    super((body && (body.detail || body.error)) || `HTTP ${status}`);
    this.status = status;
    this.body = body;
    this.source = source; // 'sync-api' | 'stt-proxy'
  }
}

/** A transport failure: `sent` = the request may have reached the server. */
class TransportError extends Error {
  constructor(message, { sent, cause } = {}) {
    super(message);
    this.sent = !!sent;
    this.cause = cause;
  }
}

/**
 * fetch + a capped JSON body read, all inside one timeout and cancel scope.
 * Never follows redirects (they could carry X-Api-Key to another host).
 * A 2xx whose body can't be read or parsed is an error, never `null`.
 */
async function httpJson(fetchImpl, url, init, timeoutMs, signal) {
  if (signal?.aborted) throw new CancelledError();
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const combined = anySignal([timeout.signal, signal]);
  let res;
  try {
    try {
      res = await raceAbort(fetchImpl(url, { ...init, redirect: 'error', signal: combined.signal }), combined.signal);
    } catch (err) {
      if (signal?.aborted) throw new CancelledError();
      // No response (network error, timeout, a refused 3xx): whether the
      // server acted on the request is unknown, so treat it as maybe-sent.
      throw new TransportError(timeout.signal.aborted ? `timed out after ${timeoutMs} ms` : (err?.message || String(err)), { sent: true, cause: err });
    }
    const ok = res.status >= 200 && res.status < 300;
    let text;
    try {
      text = await readCappedText(res, MAX_JSON_BYTES, combined.signal);
    } catch (err) {
      if (signal?.aborted) throw new CancelledError();
      if (!ok) return { status: res.status, body: null };
      throw new TransportError(timeout.signal.aborted ? `timed out reading the response after ${timeoutMs} ms` : `unreadable response: ${err?.message || err}`, { sent: true, cause: err });
    }
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (ok && (body === null || typeof body !== 'object')) {
      throw new TransportError('the response was not a JSON object', { sent: true });
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
    combined.dispose();
  }
}

function makeClients(cfg, key, fetchImpl, defaultSignal, apiTimeoutMs = API_TIMEOUT_MS) {
  // `signal` defaults to the caller's cancellation signal; pass null for
  // cleanup calls (multipart-abort) that must still go out after a cancel.
  async function syncApi(op, args = {}, signal = defaultSignal) {
    const r = await httpJson(fetchImpl, `${cfg.supabaseUrl}/functions/v1/sync-api`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.anonKey}`,
        apikey: cfg.anonKey,
        'X-Api-Key': key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...args, op }),
    }, apiTimeoutMs, signal);
    if (r.status < 200 || r.status >= 300) throw new HttpFailure(r.status, r.body, 'sync-api');
    return r.body;
  }

  async function stt(method, route, body, timeoutMs = apiTimeoutMs) {
    const r = await httpJson(fetchImpl, `${cfg.sttProxyUrl}${route}`, {
      method,
      headers: { 'X-Api-Key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }, timeoutMs, defaultSignal);
    if (r.status < 200 || r.status >= 300) throw new HttpFailure(r.status, r.body, 'stt-proxy');
    return r.body;
  }

  return { syncApi, stt };
}

/** A 2xx that lacks a field the next step needs. */
function requireField(body, field, what) {
  const v = body?.[field];
  if (typeof v !== 'string' || !v) throw new TransportError(`${what} returned no ${field}`, { sent: true });
  return v;
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
// Progress: throttled stage notifications, never awaited
// ---------------------------------------------------------------------------

function makeProgress(onProgress, total, now) {
  let count = 0;
  let lastSent = -Infinity;
  return (message, { force = false } = {}) => {
    count++;
    if (!onProgress) return;
    const t = now();
    if (!force && t - lastSent < PROGRESS_MIN_INTERVAL_MS) return;
    lastSent = t;
    // Fire and forget: notification backpressure must never hold a worker,
    // a cancel or cleanup.
    try {
      Promise.resolve(onProgress(Math.min(count, total), total, message)).catch(() => {});
    } catch { /* ignore */ }
  };
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
 * @param {(progress:number,total:number,message:string)=>unknown} [o.onProgress]  fire-and-forget
 * @param {()=>void} [o.onUnauthorized]      a sync-api 401: drop the cached key
 * @param {Function} [o.parseStream]         music-metadata parseStream override
 * @param {()=>string} [o.randomUUID]
 * @param {AbortSignal} [o.signal]           MCP request cancellation
 * @param {()=>number} [o.now]               clock for progress throttling
 * @param {(handle:object)=>Promise<void>} [o.beforeComplete]  test hook
 */
export async function transcribeFile(o = {}) {
  // Arguments, then the file — neither touches the network.
  const opts = validateOptions(o.args || {});
  if (opts.error) return toolError('invalid_request', opts.error, 'Fix that argument and call the tool again.');
  const opened = await openFile(o.args?.path).catch((err) => ({ ok: false, payload: statError(String(o.args?.path), err) }));
  if (!opened.ok) return opened.payload;
  try {
    return await runUpload(o, opened);
  } finally {
    try { await opened.handle.close(); } catch { /* ignore */ }
  }
}

async function runUpload({
  env = process.env,
  key,
  args = {},
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  onProgress,
  onUnauthorized,
  parseStream,
  randomUUID = nodeRandomUUID,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
  partTimeoutMs = PART_PUT_TIMEOUT_MS,
  jobRetryDelayMs = JOB_RETRY_DELAY_MS,
  signal,
  now = Date.now,
  beforeComplete,
  apiTimeoutMs = API_TIMEOUT_MS,
} = {}, file) {
  const cfg = uploadConfig(env);
  const hint = (code, ctx = {}) => hintFor(code, { site: cfg.webUrl, ...ctx });
  const envKey = envKeyInUse(env);
  const { handle } = file;

  const opts = validateOptions(args || {}); // already checked by transcribeFile

  const total = partCount(file.sizeBytes);
  // probing, allowance, upload started, 2 per part, completing, starting job
  const report = makeProgress(onProgress, 5 + 2 * total, now);

  // Backoff sleeps end early on cancel so a cancelled call returns promptly.
  const pauseOn = (ms, sig) => new Promise((resolve) => {
    if (!sig) { Promise.resolve(sleep(ms)).then(resolve, resolve); return; }
    if (sig.aborted) { resolve(); return; }
    const onAbort = () => resolve();
    sig.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(sleep(ms)).then(() => { sig.removeEventListener('abort', onAbort); resolve(); }, resolve);
  });

  const { syncApi, stt } = makeClients(cfg, key, fetchImpl, signal, apiTimeoutMs);
  let assetId;
  let uploadId;
  let uploadComplete = false; // webUrl only means something once the bytes are in
  const webUrlOf = () => `${cfg.webUrl}/r/${assetId}`;

  const cancelled = (step, extra = {}) => toolError(
    'cancelled',
    'The request was cancelled.',
    hint('cancelled', { assetId, webUrl: uploadComplete ? webUrlOf() : undefined, cleanup: extra.cleanup }),
    { ...(step ? { step } : {}), ...(assetId ? { assetId } : {}), ...(uploadComplete ? { webUrl: webUrlOf() } : {}), ...extra },
  );

  const fail = (err, fallbackCode, extras = {}) => {
    if (err instanceof CancelledError || signal?.aborted) {
      const { step, ...rest } = extras;
      return cancelled(step, rest);
    }
    const mapped = mapHttpFailure(err);
    const webUrl = uploadComplete ? webUrlOf() : undefined;
    const ctxExtras = { ...(assetId ? { assetId } : {}), ...(webUrl ? { webUrl } : {}), ...extras };
    if (mapped?.auth) {
      try { onUnauthorized?.(); } catch { /* best-effort */ }
      return toolError('auth_required', 'Your SeaMeet cloud key was rejected.', hint('auth_required', { envKey }), ctxExtras);
    }
    if (mapped) {
      const message = mapped.sttUnauthorized
        ? 'The transcription service did not accept this key (it may not support API keys yet).'
        : err.message;
      return toolError(mapped.code, message, hint(mapped.code, { envKey, quota: mapped.quota, webUrl }), ctxExtras);
    }
    return toolError(
      fallbackCode,
      err?.message || String(err),
      hint(fallbackCode, { step: extras.step, cleanup: extras.cleanup, webUrl }),
      ctxExtras,
    );
  };

  // 2. Probe on the same fd.
  report('Reading the file’s length', { force: true });
  const { estimatedDurationMs, hasVideo } = await probeMedia(handle, {
    ext: file.ext, sizeBytes: file.sizeBytes, name: path.basename(file.filePath), parseStream, timeoutMs: probeTimeoutMs, signal,
  });
  if (signal?.aborted) return cancelled();
  const estimatedMinutes = estimatedDurationMs !== undefined ? Math.max(1, Math.ceil(estimatedDurationMs / 60000)) : null;
  if (estimatedDurationMs !== undefined && estimatedDurationMs > MAX_SESSION_MS) {
    return toolError(
      'session_too_long',
      `The recording is about ${estimatedMinutes} minutes; one file can be at most 5 hours.`,
      hint('session_too_long'),
      { estimatedDurationMs },
    );
  }

  // 3. Budget pre-check — advisory; any failure (including a 401 from a
  //    proxy that predates key auth) is ignored and sync-api decides.
  report('Checking your transcription allowance');
  let budget = null;
  try {
    budget = await stt('GET', '/v1/file/budget', null, BUDGET_TIMEOUT_MS);
  } catch {
    budget = null;
  }
  if (signal?.aborted) return cancelled();
  if (budget && typeof budget === 'object') {
    if (budget.dailyRemaining === 0) {
      return toolError('daily_import_limit', 'The daily upload limit is reached.', hint('daily_import_limit'));
    }
    if (budget.queueRemaining === 0) {
      return toolError('queue_full', 'Too many files are already transcribing.', hint('queue_full'));
    }
    if (estimatedDurationMs !== undefined && Number.isFinite(budget.availableMs) && estimatedDurationMs > budget.availableMs) {
      const hoursLeft = (budget.availableMs / 3600000).toFixed(1);
      return toolError(
        'insufficient_allowance',
        `The file needs about ${estimatedMinutes} minutes; ${hoursLeft} hours of transcription are left.`,
        hint('insufficient_allowance', { estimatedMinutes, hoursLeft }),
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
    assetId = requireField(up, 'assetId', 'upsert-asset');
  } catch (err) {
    return fail(err, 'upload_failed', { step: 'upsert-asset' });
  }

  // 5. Multipart upload.
  try {
    const mp = await syncApi('multipart-create', { assetId });
    uploadId = requireField(mp, 'uploadId', 'multipart-create');
  } catch (err) {
    // If the response was lost, an upload may exist server-side that we have
    // no uploadId for; sync-api's upload sweep aborts stale multiparts, so
    // there is nothing to clean up here.
    return fail(err, 'upload_failed', { step: 'create' });
  }
  report('Upload started');

  // Deliberately not tied to the cancellation signal: it must go out after a cancel.
  const abortMultipart = async () => {
    try {
      await syncApi('multipart-abort', { assetId, uploadId }, null);
      return 'aborted';
    } catch {
      return 'failed';
    }
  };

  // The first terminal failure aborts every sibling's sign and PUT at once.
  const uploadAbort = new AbortController();
  const partScope = anySignal([signal, uploadAbort.signal]);
  const etags = new Array(total);
  let nextPart = 1;
  let failure = null;
  const setFailure = (n, err) => {
    if (failure) return; // keep the original error
    failure = { n, err };
    uploadAbort.abort();
  };

  const readPart = async (n) => {
    const start = (n - 1) * PART_BYTES;
    const length = Math.min(PART_BYTES, file.sizeBytes - start);
    const buf = Buffer.alloc(length);
    let off = 0;
    while (off < length) {
      const { bytesRead } = await handle.read(buf, off, length - off, start + off);
      if (bytesRead === 0) throw Object.assign(new Error(`the file shrank while reading part ${n}`), { fileChanged: true });
      off += bytesRead;
    }
    return buf;
  };

  const putOnce = async (n, buf) => {
    const signed = await syncApi('multipart-sign', { assetId, uploadId, partNumber: n }, partScope.signal);
    const url = requireField(signed, 'url', 'multipart-sign');
    if (partScope.signal.aborted) throw new CancelledError();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), partTimeoutMs);
    const combined = anySignal([timeout.signal, partScope.signal]);
    try {
      let res;
      try {
        res = await raceAbort(fetchImpl(url, {
          method: 'PUT',
          headers: { 'Content-Length': String(buf.length) },
          body: buf,
          redirect: 'error',
          signal: combined.signal,
        }), combined.signal);
      } catch (err) {
        if (partScope.signal.aborted) throw new CancelledError();
        throw new TransportError(timeout.signal.aborted ? `part ${n} timed out after ${partTimeoutMs} ms` : `part ${n}: ${err?.message || err}`, { sent: true, cause: err });
      }
      // Take the ETag and drop the body unread: R2's reply carries nothing we
      // need, and an unbounded read could outlive the timeout.
      const etag = (res.headers?.get?.('etag') ?? '').replace(/"/g, '');
      try { await res.body?.cancel?.(); } catch { /* ignore */ }
      if (!res.ok) throw new Error(`part ${n} HTTP ${res.status}`);
      if (!etag) throw new Error(`part ${n} missing etag`);
      return etag;
    } finally {
      clearTimeout(timer);
      combined.dispose();
    }
  };

  const putPart = async (n, buf) => {
    let lastErr;
    for (let attempt = 0; attempt <= PART_RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) await pauseOn(PART_RETRY_DELAYS_MS[attempt - 1], partScope.signal);
      if (partScope.signal.aborted) throw new CancelledError();
      try {
        return await putOnce(n, buf);
      } catch (err) {
        if (err instanceof CancelledError || partScope.signal.aborted) throw new CancelledError();
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
      if (partScope.signal.aborted) {
        setFailure(n, new CancelledError());
        return;
      }
      try {
        report(`Uploading part ${n} of ${total}`);
        const buf = await readPart(n);
        etags[n - 1] = await putPart(n, buf);
        report(`Uploaded part ${n} of ${total}`);
      } catch (err) {
        setFailure(n, err);
        return;
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(MAX_PARTS_IN_FLIGHT, total) }, worker));
  } finally {
    partScope.dispose();
  }
  if (failure) {
    const cleanup = await abortMultipart();
    if (failure.err?.fileChanged) {
      return toolError('file_changed', failure.err.message, hint('file_changed'), { assetId, step: `part ${failure.n}`, cleanup });
    }
    return fail(failure.err, 'upload_failed', { step: `part ${failure.n}`, cleanup });
  }

  // The same bytes must still be there: an in-place rewrite changes size or
  // mtime; a rename over the path changes the inode the path points at.
  try { await beforeComplete?.(handle); } catch { /* test hook */ }
  let changed = false;
  try {
    const st = await handle.stat();
    changed = st.size !== file.stat.size || st.mtimeMs !== file.stat.mtimeMs;
    if (!changed) {
      const now2 = await fs.promises.stat(file.filePath).catch(() => null);
      changed = !now2 || now2.ino !== file.stat.ino || now2.dev !== file.stat.dev;
    }
  } catch {
    changed = true;
  }
  if (changed) {
    const cleanup = await abortMultipart();
    return toolError('file_changed', 'The file changed during the upload.', hint('file_changed'), { assetId, step: 'complete', cleanup });
  }

  if (signal?.aborted) {
    const cleanup = await abortMultipart();
    return cancelled('complete', { cleanup });
  }
  report('Finishing the upload');
  try {
    await syncApi('multipart-complete', {
      assetId,
      uploadId,
      parts: etags.map((etag, i) => ({ partNumber: i + 1, etag })),
    });
  } catch (err) {
    if (err instanceof HttpFailure) {
      // A definite refusal: the object is not complete, so abort it.
      const cleanup = await abortMultipart();
      return fail(err, 'upload_failed', { step: 'complete', cleanup });
    }
    // Sent, but no usable answer (network drop, timeout, cancel, garbage):
    // it may have completed. Aborting could destroy a finished upload, and a
    // re-run would duplicate it — so say so and point at the asset.
    return toolError(
      'upload_unknown',
      err instanceof CancelledError ? 'Cancelled while the upload was being finished.' : `multipart-complete: ${err?.message || err}`,
      hint('upload_unknown', { webUrl: webUrlOf() }),
      { assetId, webUrl: webUrlOf(), step: 'complete' },
    );
  }
  uploadComplete = true;

  // 6. Start the job. A failure here leaves the asset in the library,
  //    untranscribed (as on the web) — the error carries assetId + webUrl.
  const webUrl = webUrlOf();
  const jobBody = {
    assetId,
    ...(opts.language ? { language: opts.language } : {}),
    ...(estimatedDurationMs !== undefined ? { estimatedDurationMs } : {}),
    ...(opts.hotwords ? { options: { hotwords: opts.hotwords } } : {}),
  };
  let submitted = false; // a job POST has left this process
  const outcomeUnknown = (err) => toolError(
    'outcome_unknown',
    err instanceof CancelledError ? 'Cancelled after the transcription request was sent.' : `/v1/file/jobs: ${err?.message || err}`,
    hint('outcome_unknown'),
    { assetId, webUrl },
  );
  const postJob = async () => {
    if (signal?.aborted) throw new CancelledError();
    submitted = true;
    const job = await stt('POST', '/v1/file/jobs', jobBody);
    requireField(job, 'jobId', '/v1/file/jobs');
    requireField(job, 'state', '/v1/file/jobs');
    return job;
  };
  let job;
  report('Starting transcription');
  try {
    try {
      job = await postJob();
    } catch (err) {
      // 409 not_synced: the completed object hadn't settled yet. Retry once;
      // re-running the whole tool would upload a duplicate. The first POST
      // was definitively refused, so nothing is pending.
      if (mapHttpFailure(err)?.code !== 'upload_incomplete') throw err;
      submitted = false;
      await pauseOn(jobRetryDelayMs, signal);
      job = await postJob();
    }
  } catch (err) {
    // No definite answer after the POST left: the job may exist.
    if (submitted && !(err instanceof HttpFailure)) return outcomeUnknown(err);
    return fail(err, 'job_start_failed');
  }

  // 7. What the next call needs.
  const poll = pollAfterSeconds(estimatedDurationMs);
  const availableMin = budget && Number.isFinite(budget.availableMs) ? Math.round(budget.availableMs / 60000) : null;
  return {
    success: true,
    assetId,
    jobId: job.jobId,
    state: job.state,
    webUrl,
    estimatedMinutes,
    allowanceRemainingMinutes: availableMin !== null && estimatedMinutes !== null ? Math.max(0, availableMin - estimatedMinutes) : null,
    pollAfterSeconds: poll,
    next:
      `Call seameet_get_recording({assetId: "${assetId}"}) in about ${poll} seconds; it is done when ` +
      'asset.transcriptionJob.state is "done" and failed if it is "failed".',
  };
}
