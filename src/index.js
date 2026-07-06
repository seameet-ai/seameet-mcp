/**
 * @seameet/mcp — dual-mode MCP server for SeaMeet.
 *
 * One install, two backends, chosen automatically:
 *
 *   DESKTOP mode — when the SeaMeet desktop app is installed AND running, it
 *   hosts a local bridge on 127.0.0.1 (port 3741, fallback 3742/3743) that owns
 *   the full tool set (start/stop recording, screenshots, transcripts, search).
 *   No auth; nothing leaves the machine.
 *     tools/list  →  GET  http://127.0.0.1:<port>/mcp-bridge/tools
 *     tools/call  →  POST http://127.0.0.1:<port>/mcp-bridge/call-tool
 *
 *   CLOUD mode — the hosted remote MCP worker, for reading your synced library
 *   and managing webhooks from anywhere (no desktop app needed). Authenticated
 *   with a personal API key. If none is configured, the first cloud tool call
 *   starts an OAuth 2.0 Device Authorization flow (RFC 8628): the agent shows
 *   the user a short code + a URL, the user approves in the web app, and a
 *   read+write key is minted and cached locally — no copy/paste.
 *
 * Precedence: desktop-first (richer, can execute, no auth); cloud is the
 * fallback and is OPT-IN — it never activates unless a key is configured or the
 * user completes the device flow. tools/list returns the SUPERSET of whatever
 * each backend offers; a tool the current backend can't serve returns a
 * structured capability error (desktop_required / auth_required).
 *
 * Config / overrides:
 *   SEAMEET_MCP_CREDENTIALS_FILE — explicit desktop-bridge credentials file
 *   SEAMEET_BRIDGE_PORT + SEAMEET_BRIDGE_SECRET — bypass the bridge file
 *   SEAMEET_API_KEY — cloud API key (skips the device flow)
 *   SEAMEET_REMOTE_URL — remote MCP worker /mcp endpoint (default: PROD)
 *   SEAMEET_DEVICE_URL — mcp-device edge function (default: PROD)
 *   SEAMEET_CLOUD_CREDENTIALS_FILE — where the minted key is cached
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const MAX_TOOL_OUTPUT_CHARS = 80000;
const REQUEST_TIMEOUT_MS = 65000; // slightly above the app's own 60 s ceiling
const CLOUD_TIMEOUT_MS = 30000;
const DESKTOP_PROBE_TIMEOUT_MS = 1500;
const REACHABILITY_TTL_MS = 5000;
// First desktop-app build that serves the /mcp-bridge/tools + /call-tool wrapper
// this client drives. An app older than this is running but can't do MCP desktop
// mode — we detect it (404 on the probe) and tell the user to update, precisely.
const MIN_DESKTOP_VERSION = '3.2.0';
const DOWNLOAD_URL = 'https://seameet.ai/download/';
// One-command install/update per OS, so an agent gets a copy-paste command
// instead of a download page to scrape. downloadUrl stays the always-works
// fallback. (Homebrew tap + winget are wired in the app's release pipeline.)
const INSTALL_COMMANDS = {
  macos: 'brew install --cask seameet-ai/tap/seameet',
  windows: 'winget install seameet',
  download: DOWNLOAD_URL,
};
const INSTALL_HINT =
  `Install/update: \`${INSTALL_COMMANDS.macos}\` (macOS) or ` +
  `\`${INSTALL_COMMANDS.windows}\` (Windows), or download from ${DOWNLOAD_URL}.`;

const DEFAULT_REMOTE_URL = 'https://seameet-mcp-remote.seameet.workers.dev/mcp';
const DEFAULT_DEVICE_URL = 'https://tvezjojyndcgkneyxook.supabase.co/functions/v1/mcp-device';

// ---------------------------------------------------------------------------
// Desktop-bridge credentials discovery
// ---------------------------------------------------------------------------

/** Mirrors the sanitization the desktop app applies when writing the file. */
function currentUsername() {
  let username;
  try {
    username = os.userInfo().username;
  } catch {
    username = process.env.USER || process.env.USERNAME || 'default';
  }
  return username.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function credentialsFilePath(env = process.env) {
  if (env.SEAMEET_MCP_CREDENTIALS_FILE) return env.SEAMEET_MCP_CREDENTIALS_FILE;
  return path.join(os.tmpdir(), `seameet-mcp-bridge-${currentUsername()}.json`);
}

/**
 * @returns {{port: number, secret: string} | null} null when the app has
 *   never written credentials (or they're unreadable/invalid).
 */
export function discoverCredentials(env = process.env) {
  if (env.SEAMEET_BRIDGE_PORT && env.SEAMEET_BRIDGE_SECRET) {
    const port = parseInt(env.SEAMEET_BRIDGE_PORT, 10);
    if (Number.isFinite(port)) return { port, secret: env.SEAMEET_BRIDGE_SECRET };
  }
  try {
    const raw = fs.readFileSync(credentialsFilePath(env), 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed?.port === 'number' && typeof parsed?.secret === 'string' && parsed.secret) {
      // version is present on app builds >= 3.2.0; older apps omit it (null).
      return { port: parsed.port, secret: parsed.secret, version: typeof parsed.version === 'string' ? parsed.version : null };
    }
  } catch {
    // missing / unreadable / corrupt — treated as "app not running"
  }
  return null;
}

// ---------------------------------------------------------------------------
// Desktop bridge HTTP client
// ---------------------------------------------------------------------------

export function bridgeRequest(creds, method, bridgePath, body, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port: creds.port,
      path: bridgePath,
      method,
      headers: {
        'X-Bridge-Secret': creds.secret,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    }, (res) => {
      res.setEncoding('utf8');
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = { _raw: raw };
        }
        resolve({ statusCode: res.statusCode || 0, body: parsed });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      const err = new Error(`Bridge request timed out after ${timeoutMs} ms`);
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Cloud: config, credential cache, HTTP
// ---------------------------------------------------------------------------

export function remoteUrl(env = process.env) {
  return env.SEAMEET_REMOTE_URL || DEFAULT_REMOTE_URL;
}
export function deviceUrl(env = process.env) {
  return env.SEAMEET_DEVICE_URL || DEFAULT_DEVICE_URL;
}

export function cloudCredentialPath(env = process.env) {
  if (env.SEAMEET_CLOUD_CREDENTIALS_FILE) return env.SEAMEET_CLOUD_CREDENTIALS_FILE;
  return path.join(os.homedir(), '.seameet', 'credentials.json');
}

/** The cloud API key: explicit env wins, else the cached device-flow key. */
export function loadCloudKey(env = process.env) {
  if (env.SEAMEET_API_KEY && env.SEAMEET_API_KEY.startsWith('smk_')) return env.SEAMEET_API_KEY;
  try {
    const parsed = JSON.parse(fs.readFileSync(cloudCredentialPath(env), 'utf8'));
    if (typeof parsed?.apiKey === 'string' && parsed.apiKey.startsWith('smk_')) return parsed.apiKey;
  } catch {
    // no cached key yet
  }
  return null;
}

export function saveCloudKey(env, apiKey) {
  const file = cloudCredentialPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ apiKey }, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best-effort on platforms without chmod
  }
}

/** Minimal JSON POST over global fetch (Node >= 18). */
async function postJson(url, headers, body, timeoutMs = CLOUD_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let payload = null;
    try {
      payload = await res.json();
    } catch (err) {
      // A timeout that fires mid-parse aborts res.json() with an AbortError —
      // propagate it as a real timeout, don't disguise it as an empty success.
      if (err?.name === 'AbortError' || controller.signal.aborted) throw err;
      payload = null;
    }
    return { status: res.status, body: payload };
  } finally {
    clearTimeout(timer);
  }
}

/** Relay a JSON-RPC method to the remote worker's /mcp with a bearer key. */
async function remoteRpc(env, apiKey, method, params, timeoutMs = CLOUD_TIMEOUT_MS) {
  const { status, body } = await postJson(
    remoteUrl(env),
    { Authorization: `Bearer ${apiKey}` },
    { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
    timeoutMs,
  );
  if (status === 401) {
    const err = new Error('cloud key rejected');
    err.code = 'cloud_unauthorized';
    throw err;
  }
  if (!body || typeof body !== 'object') {
    const err = new Error(`remote MCP ${method} → HTTP ${status}, no JSON`);
    err.code = 'cloud_error';
    throw err;
  }
  if (body.error) {
    const err = new Error(body.error.message || `remote MCP ${method} error`);
    err.code = 'cloud_error';
    err.rpc = body.error;
    throw err;
  }
  return body.result;
}

// The remote worker returns tools/list for any smk_-prefixed bearer without a
// round-trip (discovery is public; only tool CALLS validate the key), so we can
// enumerate cloud tools for the superset even before the user has authenticated.
const CLOUD_DISCOVERY_KEY = 'smk_discovery';
const DISCOVERY_TIMEOUT_MS = 5000; // don't let tools/list block on a slow cloud

async function fetchCloudTools(env, timeoutMs = DISCOVERY_TIMEOUT_MS) {
  const key = loadCloudKey(env);
  try {
    const result = await remoteRpc(env, key || CLOUD_DISCOVERY_KEY, 'tools/list', null, timeoutMs);
    return Array.isArray(result?.tools) ? result.tools : [];
  } catch (err) {
    // If the cached key was revoked, discovery with it 401s — which would drop
    // cloud tools from tools/list entirely, so the agent could never call one to
    // trigger re-authorization. Fall back to the public discovery key so cloud
    // tools stay listed and the self-healing re-auth flow can fire.
    if (key && err.code === 'cloud_unauthorized') {
      // The cached key was revoked — drop it now so the next cloud tool call
      // re-authorizes immediately instead of failing once first.
      try { fs.rmSync(cloudCredentialPath(env)); } catch { /* nothing cached */ }
      const result = await remoteRpc(env, CLOUD_DISCOVERY_KEY, 'tools/list', null, timeoutMs);
      return Array.isArray(result?.tools) ? result.tools : [];
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Device Authorization flow (RFC 8628)
// ---------------------------------------------------------------------------

// One pending device flow per process, kept in memory across tool calls so the
// agent's "approve then retry" round-trips resolve.
let pendingDevice = null; // { device_code, user_code, verification_uri, expires_at }

async function deviceStart(env) {
  const label = `${os.hostname?.() || 'device'}`;
  const { status, body } = await postJson(deviceUrl(env), {}, { op: 'start', deviceLabel: label });
  if (status !== 200 || !body?.device_code) {
    throw new Error(body?.detail || body?.error || `device start failed (HTTP ${status})`);
  }
  pendingDevice = {
    device_code: body.device_code,
    user_code: body.user_code,
    verification_uri: body.verification_uri,
    verification_uri_complete: body.verification_uri_complete,
    expires_at: Date.now() + (body.expires_in ?? 600) * 1000,
  };
  return pendingDevice;
}

async function devicePoll(env, deviceCode) {
  const { body } = await postJson(deviceUrl(env), {}, { op: 'poll', deviceCode });
  return body || {};
}

function authChallengePayload(toolName, device) {
  return {
    success: false,
    error: {
      code: 'auth_required',
      message: 'Authorize SeaMeet cloud access to use this tool.',
      tool: toolName,
      hint:
        `Ask the user to open ${device.verification_uri_complete || device.verification_uri} ` +
        `(signed in) and confirm the code ${device.user_code}, then call this tool again. ` +
        'A read+write key will be minted automatically — no copy/paste.',
      verification_uri: device.verification_uri,
      user_code: device.user_code,
    },
  };
}

/**
 * Resolve a cloud API key, driving the device flow as needed.
 * @returns {Promise<{key: string} | {challenge: object}>}
 */
async function ensureCloudAuth(env, toolName) {
  const existing = loadCloudKey(env);
  if (existing) return { key: existing };

  // Poll an in-flight device flow if we have one.
  if (pendingDevice && Date.now() < pendingDevice.expires_at) {
    let res;
    try {
      res = await devicePoll(env, pendingDevice.device_code);
    } catch {
      // Transient network error — keep the flow and re-issue the challenge.
      res = { status: 'pending' };
    }
    if (res.status === 'approved' && res.apiKey) {
      saveCloudKey(env, res.apiKey);
      pendingDevice = null;
      return { key: res.apiKey };
    }
    if (res.error === 'key_limit') {
      // NOT terminal: the code is still approved server-side. Preserve the flow
      // so the next poll (after the user frees a key slot) mints the key.
      return {
        challenge: {
          success: false,
          error: {
            code: 'key_limit',
            message: 'Too many active API keys.',
            tool: toolName,
            hint: 'Revoke some keys at https://app.seameet.ai/account, then call this tool again.',
          },
        },
      };
    }
    // Discard ONLY on terminal states (the code is truly gone). A transient
    // db_error or a still-pending poll preserves the flow so the user can
    // finish approving the code they already have.
    if (res.status === 'expired' || res.error === 'already_consumed' || res.error === 'invalid_device_code') {
      pendingDevice = null;
    }
  }

  const device = pendingDevice && Date.now() < pendingDevice.expires_at
    ? pendingDevice
    : await deviceStart(env);
  // Backstop: the agent is supposed to relay the code from the tool-error hint,
  // but that's not guaranteed. Also surface it on stderr — Claude Code (and most
  // MCP clients) show MCP-server stderr in their logs — so the code is never lost.
  process.stderr.write(
    `[seameet-mcp] Authorize cloud access: open ` +
    `${device.verification_uri_complete || device.verification_uri} (signed in) and confirm ` +
    `code ${device.user_code}, then retry the tool.\n`,
  );
  return { challenge: authChallengePayload(toolName, device) };
}

// ---------------------------------------------------------------------------
// Structured errors + status tool
// ---------------------------------------------------------------------------

export function appNotRunningPayload(toolName, detail) {
  return {
    success: false,
    error: {
      code: 'app_not_running',
      message: detail || 'The SeaMeet desktop app is not running.',
      tool: toolName,
      requiredVersion: MIN_DESKTOP_VERSION,
      downloadUrl: DOWNLOAD_URL,
      install: INSTALL_COMMANDS,
      hint:
        `This tool needs the SeaMeet desktop app (v${MIN_DESKTOP_VERSION} or newer). Ask the user ` +
        `to install and launch it, then retry. ${INSTALL_HINT} (Cloud tools that read your synced ` +
        'library work without the desktop app if you authorize cloud access.)',
    },
  };
}

// The app is running but older than MIN_DESKTOP_VERSION, so it doesn't serve the
// bridge wrapper this client drives. Tell the agent exactly that — don't make it
// reverse-engineer the bridge or reinstall a same-version build.
export function appOutdatedPayload(toolName, installedVersion) {
  return {
    success: false,
    error: {
      code: 'app_outdated',
      message:
        `The SeaMeet desktop app is running but too old for MCP desktop mode` +
        (installedVersion ? ` (installed v${installedVersion}, need v${MIN_DESKTOP_VERSION}+).` : '.'),
      tool: toolName,
      installedVersion: installedVersion || null,
      requiredVersion: MIN_DESKTOP_VERSION,
      downloadUrl: DOWNLOAD_URL,
      install: INSTALL_COMMANDS,
      hint:
        `Ask the user to update the SeaMeet desktop app to v${MIN_DESKTOP_VERSION} or newer, then ` +
        `retry. ${INSTALL_HINT} Do NOT reinstall the same version. (Cloud tools work now if you ` +
        'authorize cloud access.)',
    },
  };
}

/** Build the `desktop` block of seameet_status from a resolveDesktop() result. */
export function desktopStatus(desktop) {
  if (desktop.state === 'available') {
    return { mode: 'connected', version: desktop.version || undefined };
  }
  if (desktop.state === 'outdated') {
    return {
      mode: 'outdated',
      installedVersion: desktop.version || null,
      requiredVersion: MIN_DESKTOP_VERSION,
      downloadUrl: DOWNLOAD_URL,
      install: INSTALL_COMMANDS,
      hint:
        `The desktop app is running but too old for MCP — update to v${MIN_DESKTOP_VERSION}+ for ` +
        `record/screenshot/transcript tools. ${INSTALL_HINT}`,
    };
  }
  return {
    mode: 'unavailable',
    requiredVersion: MIN_DESKTOP_VERSION,
    downloadUrl: DOWNLOAD_URL,
    install: INSTALL_COMMANDS,
    hint:
      `Launch the SeaMeet desktop app (v${MIN_DESKTOP_VERSION}+) for record/screenshot/transcript ` +
      `tools. ${INSTALL_HINT}`,
  };
}

export const STATUS_TOOL = {
  name: 'seameet_status',
  description:
    'Report how this SeaMeet MCP is connected: DESKTOP mode (the desktop app is running — full ' +
    'record/screenshot/transcript tools) and/or CLOUD mode (authorized access to your synced ' +
    'library + webhooks). Call this to see the current mode and how to enable the other.',
  inputSchema: { type: 'object', properties: {} },
};

export const LOGOUT_TOOL = {
  name: 'seameet_logout',
  description:
    'Disconnect CLOUD mode: forget the cached cloud API key (~/.seameet/credentials.json) and ' +
    'cancel any pending device authorization, so the next cloud tool call re-authorizes (e.g. to ' +
    'switch accounts). Does not touch DESKTOP mode. The key itself stays valid until you revoke ' +
    'it under API keys at https://app.seameet.ai/account.',
  inputSchema: { type: 'object', properties: {} },
};

// ---------------------------------------------------------------------------
// Mode resolution (cached)
// ---------------------------------------------------------------------------

// state: 'available' (app up + speaks the bridge contract), 'outdated' (app up
// but too old for MCP — probe 404s), or 'down' (creds stale / app not running).
// `reachable` stays as a convenience alias for state === 'available'.
let reachabilityCache = { at: 0, creds: null, state: 'down', reachable: false, tools: [], version: null };

async function resolveDesktop(env) {
  const now = Date.now();
  if (now - reachabilityCache.at < REACHABILITY_TTL_MS) return reachabilityCache;
  const creds = discoverCredentials(env);
  if (!creds) {
    // Don't cache the "no desktop" negative. The creds-file check is a cheap
    // local stat, so re-checking every call lets us detect the app launching
    // instantly instead of after a 5 s cache window.
    return { at: 0, creds: null, state: 'down', reachable: false, tools: [], version: null };
  }
  let state = 'down';
  let tools = [];
  try {
    const { statusCode, body } = await bridgeRequest(creds, 'GET', '/mcp-bridge/tools', null, DESKTOP_PROBE_TIMEOUT_MS);
    if (statusCode === 200 && Array.isArray(body?.tools)) {
      // The probe already fetched the inventory — cache it so tools/list doesn't
      // make a second identical bridge request.
      state = 'available';
      tools = body.tools;
    } else {
      // The bridge answered but doesn't serve /mcp-bridge/tools — the app is
      // running but predates the wrapper (added in v3.2.0). Not "not running".
      state = 'outdated';
    }
  } catch {
    // Connection refused / timeout → the creds are stale; the app isn't running.
    state = 'down';
  }
  const reachable = state === 'available';
  reachabilityCache = { at: now, creds, state, reachable, tools, version: creds.version ?? null };
  return reachabilityCache;
}

// ---------------------------------------------------------------------------
// MCP server assembly
// ---------------------------------------------------------------------------

function toText(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text.length > MAX_TOOL_OUTPUT_CHARS) {
    const note = `\n\n[Output truncated: ${text.length} chars total, showing first ${MAX_TOOL_OUTPUT_CHARS}. Use more specific queries or request smaller portions.]`;
    text = text.slice(0, MAX_TOOL_OUTPUT_CHARS) + note;
  }
  return text;
}

async function loadSdk() {
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  return { Server, StdioServerTransport, CallToolRequestSchema, ListToolsRequestSchema };
}

// Cloud tool names discovered this session — used to route tools/call to the
// cloud backend. Refreshed on every tools/list. `null` = not discovered yet;
// a Set (even empty) = already discovered, so we don't re-probe an offline
// cloud on every single tool call.
let cloudToolNames = null;

export async function createServer(env = process.env) {
  const { Server, StdioServerTransport, CallToolRequestSchema, ListToolsRequestSchema } = await loadSdk();

  const server = new Server(
    { name: 'seameet', version: '0.2.0' },
    { capabilities: { tools: { listChanged: true } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = [];
    const seen = new Set();

    // Desktop tools (live inventory) — reuse the inventory the reachability
    // probe already fetched (no second bridge request).
    const desktop = await resolveDesktop(env);
    if (desktop.reachable) {
      for (const t of desktop.tools) {
        if (t?.name && !seen.has(t.name)) { tools.push(t); seen.add(t.name); }
      }
    }

    // Cloud tools (superset) — discovered from the worker even before auth.
    // Only record the discovered set on SUCCESS; if discovery threw (offline),
    // leave cloudToolNames as-is (null on first run) so a later list/call retries
    // instead of being stuck desktop-only for the rest of the session.
    try {
      const cloud = await fetchCloudTools(env);
      const names = new Set();
      for (const t of cloud) {
        if (t?.name) {
          names.add(t.name);
          if (!seen.has(t.name)) { tools.push(t); seen.add(t.name); }
        }
      }
      cloudToolNames = names;
    } catch {
      // cloud discovery failed (offline) — desktop-only this call; retry later
    }

    if (!seen.has(STATUS_TOOL.name)) tools.push(STATUS_TOOL);
    if (!seen.has(LOGOUT_TOOL.name)) tools.push(LOGOUT_TOOL);
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const respond = (payload, isError) => ({
      content: [{ type: 'text', text: toText(payload) }],
      ...(isError ? { isError: true } : {}),
    });

    // Status tool: report both modes.
    if (name === STATUS_TOOL.name) {
      const desktop = await resolveDesktop(env);
      const hasKey = !!loadCloudKey(env);
      return respond({
        success: true,
        desktop: desktopStatus(desktop),
        cloud: {
          mode: hasKey ? 'authorized' : 'not_authorized',
          hint: hasKey ? undefined : 'Call any cloud tool (e.g. seameet_list_recent_recordings) to authorize via the web app.',
        },
      });
    }

    // Logout: forget the cached cloud key + cancel any pending device flow.
    if (name === LOGOUT_TOOL.name) {
      let forgot = false;
      try { fs.rmSync(cloudCredentialPath(env)); forgot = true; } catch { /* nothing cached */ }
      pendingDevice = null;
      const envKey = typeof env.SEAMEET_API_KEY === 'string' && env.SEAMEET_API_KEY.startsWith('smk_');
      return respond({
        success: true,
        forgotCachedKey: forgot,
        message: envKey
          ? 'Cleared any cached key, but SEAMEET_API_KEY is set in the environment, so cloud mode is still active. Unset it to fully disconnect.'
          : forgot
          ? 'Forgot the cached SeaMeet cloud key. The next cloud tool call will re-authorize. The key stays valid until you revoke it at https://app.seameet.ai/account.'
          : 'No cached cloud key to forget.',
      });
    }

    // If the agent calls a tool before listing (cloudToolNames not yet
    // discovered), lazily discover the cloud tool set once so routing is correct.
    if (cloudToolNames === null && name !== STATUS_TOOL.name && name !== LOGOUT_TOOL.name) {
      try {
        const cloud = await fetchCloudTools(env);
        cloudToolNames = new Set(cloud.map((t) => t.name).filter(Boolean));
      } catch {
        // cloud offline — treat everything unknown as a desktop tool, and don't
        // re-probe the offline cloud on every subsequent call this session.
        cloudToolNames = new Set();
      }
    }

    // Cloud-owned tool → route to the remote worker (auth via device flow).
    if (cloudToolNames.has(name)) {
      try {
        const auth = await ensureCloudAuth(env, name);
        if (auth.challenge) return respond(auth.challenge, true);
        const result = await remoteRpc(env, auth.key, 'tools/call', { name, arguments: args });
        // The worker already returns MCP tool-result shape ({content,[isError]}).
        if (result && Array.isArray(result.content)) return result;
        return respond(result ?? {});
      } catch (err) {
        if (err.code === 'cloud_unauthorized') {
          // Cached key was revoked — drop it and re-challenge next call.
          try { fs.rmSync(cloudCredentialPath(env)); } catch { /* ignore */ }
          pendingDevice = null;
          return respond({
            success: false,
            error: { code: 'auth_required', message: 'Your SeaMeet cloud key was rejected (revoked?). Retry to re-authorize.', tool: name },
          }, true);
        }
        return respond({
          success: false,
          error: { code: 'cloud_error', message: err.message, tool: name },
        }, true);
      }
    }

    // Otherwise it's a desktop tool. Route to the bridge if reachable.
    const desktop = await resolveDesktop(env);
    if (!desktop.reachable) {
      // Distinguish "running but too old" from "not running" so the agent gets an
      // actionable answer (update vs launch/install) instead of guessing.
      return respond(
        desktop.state === 'outdated'
          ? appOutdatedPayload(name, desktop.version)
          : appNotRunningPayload(name),
        true,
      );
    }
    try {
      const { statusCode, body } = await bridgeRequest(desktop.creds, 'POST', '/mcp-bridge/call-tool', { name, args });
      if (statusCode >= 200 && statusCode < 300) return respond(body);
      const payload = body?.error ? body : {
        success: false,
        error: { code: 'internal_error', message: `Bridge answered HTTP ${statusCode}`, tool: name },
      };
      return respond(payload, true);
    } catch (err) {
      if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'EPIPE') {
        return respond(appNotRunningPayload(name, 'The local bridge refused the connection — SeaMeet was running once but is closed now.'), true);
      }
      return respond({
        success: false,
        error: {
          code: err.code === 'ETIMEDOUT' ? 'timeout' : 'internal_error',
          message: err.message,
          tool: name,
          hint: err.code === 'ETIMEDOUT'
            ? 'The app did not respond in time. Call seameet_recording_status to check state, then retry once.'
            : 'Unexpected transport error talking to the local SeaMeet bridge.',
        },
      }, true);
    }
  });

  return { server, StdioServerTransport };
}

export async function main() {
  const { server, StdioServerTransport } = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[seameet-mcp] connected (stdio). Desktop app when running, else cloud (with authorization).\n');
}
