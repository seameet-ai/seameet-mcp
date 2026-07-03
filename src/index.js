/**
 * @seameet/mcp — MCP server for the SeaMeet desktop app.
 *
 * A thin stdio↔HTTP proxy. The SeaMeet desktop app hosts a local bridge on
 * 127.0.0.1 (port 3741, fallback 3742/3743) that owns ALL tool semantics:
 *
 *   tools/list  →  GET  http://127.0.0.1:<port>/mcp-bridge/tools
 *   tools/call  →  POST http://127.0.0.1:<port>/mcp-bridge/call-tool
 *
 * Because the tool inventory is fetched live from the app, this package
 * never goes stale: new tools in a SeaMeet release appear here immediately.
 *
 * Credentials (port + shared secret) are written by the app on startup to:
 *   $TMPDIR/seameet-mcp-bridge-<username>.json   (mode 0600)
 *
 * Overrides (mainly for tests / unusual setups):
 *   SEAMEET_MCP_CREDENTIALS_FILE — explicit path to the credentials file
 *   SEAMEET_BRIDGE_PORT + SEAMEET_BRIDGE_SECRET — bypass the file entirely
 *
 * When the app is not running, the server still starts and exposes a single
 * `seameet_desktop_app_status` tool so agents get an actionable, structured
 * "launch SeaMeet and retry" answer instead of a dead connection.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const MAX_TOOL_OUTPUT_CHARS = 80000;
const REQUEST_TIMEOUT_MS = 65000; // slightly above the app's own 60 s ceiling

// ---------------------------------------------------------------------------
// Credentials discovery
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
      return { port: parsed.port, secret: parsed.secret };
    }
  } catch {
    // missing / unreadable / corrupt — treated as "app not running"
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bridge HTTP client
// ---------------------------------------------------------------------------

export function bridgeRequest(creds, method, bridgePath, body) {
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
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      const err = new Error(`Bridge request timed out after ${REQUEST_TIMEOUT_MS} ms`);
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Structured errors (same contract the app documents in llms.txt)
// ---------------------------------------------------------------------------

export function appNotRunningPayload(toolName, detail) {
  return {
    success: false,
    error: {
      code: 'app_not_running',
      message: detail || 'The SeaMeet desktop app is not running.',
      tool: toolName,
      hint:
        'Ask the user to launch the SeaMeet desktop app, then retry. ' +
        'Download: https://seameet.ai/download/ — the app must be running for recording tools to work.',
    },
  };
}

// ---------------------------------------------------------------------------
// Fallback tool shown when the app is unreachable
// ---------------------------------------------------------------------------

export const STATUS_TOOL = {
  name: 'seameet_desktop_app_status',
  description:
    'Check whether the SeaMeet desktop app is running and reachable. ' +
    'The full SeaMeet tool set (start/stop recording, screenshots, transcripts, ' +
    'summaries, search) appears automatically once the app is running — call this ' +
    'tool to re-check, and if it reports app_not_running, ask the user to launch SeaMeet ' +
    '(download: https://seameet.ai/download/).',
  inputSchema: { type: 'object', properties: {} },
};

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

export async function createServer(env = process.env) {
  const { Server, StdioServerTransport, CallToolRequestSchema, ListToolsRequestSchema } = await loadSdk();

  const server = new Server(
    { name: 'seameet', version: '0.1.0' },
    { capabilities: { tools: { listChanged: false } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const creds = discoverCredentials(env);
    if (creds) {
      try {
        const { statusCode, body } = await bridgeRequest(creds, 'GET', '/mcp-bridge/tools');
        if (statusCode === 200 && Array.isArray(body?.tools) && body.tools.length > 0) {
          return { tools: body.tools };
        }
      } catch {
        // fall through to the status tool
      }
    }
    return { tools: [STATUS_TOOL] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const creds = discoverCredentials(env);

    const respond = (payload, isError) => ({
      content: [{ type: 'text', text: toText(payload) }],
      ...(isError ? { isError: true } : {}),
    });

    if (!creds) {
      if (name === STATUS_TOOL.name) {
        return respond(appNotRunningPayload(name, 'No SeaMeet credentials file found — the desktop app has not started on this machine (or has never run).'), true);
      }
      return respond(appNotRunningPayload(name), true);
    }

    if (name === STATUS_TOOL.name) {
      try {
        const { statusCode, body } = await bridgeRequest(creds, 'GET', '/mcp-bridge/tools');
        if (statusCode === 200) {
          return respond({
            success: true,
            running: true,
            toolCount: body?.count,
            message: 'SeaMeet is running. Its full tool set is available — call tools/list again to see it.',
          });
        }
        return respond(appNotRunningPayload(name, `Bridge answered HTTP ${statusCode}.`), true);
      } catch (err) {
        return respond(appNotRunningPayload(name, `Bridge unreachable: ${err.message}`), true);
      }
    }

    try {
      const { statusCode, body } = await bridgeRequest(creds, 'POST', '/mcp-bridge/call-tool', { name, args });
      if (statusCode >= 200 && statusCode < 300) {
        return respond(body);
      }
      // The bridge already returns the structured error contract — pass it through.
      const payload = body?.error ? body : {
        success: false,
        error: { code: 'internal_error', message: `Bridge answered HTTP ${statusCode}`, tool: name },
      };
      return respond(payload, true);
    } catch (err) {
      if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'EPIPE') {
        return respond(appNotRunningPayload(name, 'The local bridge refused the connection — SeaMeet was running once (credentials exist) but is closed now.'), true);
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
  process.stderr.write('[seameet-mcp] connected (stdio). Tools are proxied from the SeaMeet desktop app.\n');
}
