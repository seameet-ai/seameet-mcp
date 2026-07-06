# @seameet/mcp

Dual-mode MCP server for [SeaMeet](https://seameet.ai) — one install that works whether or not you have the desktop app, for AI agents (Claude Code, Claude Desktop, Codex, Antigravity, Cursor, OpenCode, GitHub Copilot CLI, Windsurf, and any MCP client — see [INSTALL.md](INSTALL.md)).

- **Desktop mode** — when the SeaMeet desktop app is **running**, agents get the full recorder tool set (start/stop/pause recordings, screenshots, live transcript, AI artifacts, search, save-artifact — 17 tools, fetched live so new releases appear automatically). No auth; nothing leaves your machine.
- **Cloud mode** — when the desktop app isn't there, agents read your **synced cloud library** (recordings, transcripts, summaries) and **manage outbound webhooks** over the network. Authorized by logging into the web app — **no key copy/paste**, works on a headless terminal.

It picks the richest available backend automatically (desktop first, cloud fallback) and exposes the union of both; a tool the current backend can't serve returns a clear, structured error.

## Two modes, one install

`tools/list` returns the superset of whatever's available. Call `seameet_status` any time to see the current mode(s).

- **Desktop** requires the app installed **and running** — if it's installed but closed, desktop tools return `app_not_running` and you're told to launch it (cloud tools still work).
- **Cloud** is opt-in: it never activates unless you provide `SEAMEET_API_KEY` or complete the one-time authorization. The first cloud tool call with no key starts an OAuth 2.0 Device flow — the agent shows you a short code + `https://app.seameet.ai/link`; you open it (signed in), click **Authorize**, and a read+write key is minted and cached at `~/.seameet/credentials.json`. Silent thereafter. Revoke any time under **API keys** on your account.
  - **Disconnect / switch accounts:** call the `seameet_logout` tool (forgets the cached key + cancels a pending flow), or just `rm ~/.seameet/credentials.json`. The next cloud tool call re-authorizes.

## Requirements

- The [SeaMeet desktop app](https://seameet.ai/download/) installed and **running** (Windows / macOS)
  — `brew install --cask seameet-ai/tap/seameet` (macOS) or `winget install SeasaltAI.SeaMeetRecorder`
  (Windows). Desktop mode needs **v3.2.0+**; an older running app reports `app_outdated`.
- Node.js ≥ 18

## Install

**Every tool runs the same command — `npx -y @seameet/mcp` — only the config format differs.**
Full per-tool recipes: **[INSTALL.md](INSTALL.md)** (also at
[app.seameet.ai/mcp/install.md](https://app.seameet.ai/mcp/install.md)).

**Let your agent do it.** Already inside a coding agent? Paste:

> Install the SeaMeet MCP server — fetch
> `https://raw.githubusercontent.com/seameet-ai/seameet-mcp/main/INSTALL.md`, apply the section for
> whichever tool you're running in, and tell me how to reload.

**Or pick your tool:**

| Tool | Fastest install |
|---|---|
| **Claude Code** | `claude mcp add seameet -- npx -y @seameet/mcp` |
| **Codex CLI / IDE** | `codex mcp add seameet -- npx -y @seameet/mcp` |
| **GitHub Copilot CLI** | `copilot mcp add seameet -- npx -y @seameet/mcp` |
| **Cursor** | [Add to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=seameet&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBzZWFtZWV0L21jcCJdfQ==) (one-click) |
| **Claude Desktop** | one-click `.mcpb` bundle — see [INSTALL.md](INSTALL.md#claude-desktop) |
| **Antigravity** · **OpenCode** · **anything else** | see [INSTALL.md](INSTALL.md) |

Claude Code users can also install the [plugin](#claude-code-plugin) to add the `/seameet` skill
(guided workflows):

```bash
claude plugin marketplace add seameet-ai/seameet-mcp
claude plugin install seameet@seameet
```

The generic block, accepted by most MCP clients:

```json
{
  "mcpServers": {
    "seameet": { "command": "npx", "args": ["-y", "@seameet/mcp"] }
  }
}
```

## Claude Desktop extension

`manifest.json` in this repo is an [MCPB](https://github.com/anthropics/mcpb) (MCP Bundle, formerly DXT) manifest, so the server ships as a one-click Claude Desktop extension:

```bash
npm install
npm run build:mcpb   # → dist/seameet.mcpb
```

Install it in Claude Desktop via **Settings → Extensions → Advanced settings → Install extension…** and pick `dist/seameet.mcpb`. No terminal needed after that — the bundle carries the server and its dependencies, and Claude Desktop runs it with its own Node.js runtime.

The SeaMeet desktop app still needs to be installed and running — the extension only bridges Claude to it.

## Claude Code plugin

This repo doubles as a [Claude Code plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces). The `seameet` plugin registers the MCP server **and** a `/seameet` skill that teaches Claude the core workflows (check app status, record + transcribe, capture a bug report, mine meetings for action items) — condensed from the canonical recipes at [app.seameet.ai/.well-known/skills](https://app.seameet.ai/.well-known/skills/index.json).

```bash
claude plugin marketplace add seameet-ai/seameet-mcp
claude plugin install seameet@seameet
```

Then ask Claude to "record my screen" or invoke `/seameet` directly. Plugin source: [`claude-plugin/`](claude-plugin/).

## Try it

Ask your agent:

> Record my screen for 2 minutes, then give me the transcript.

> What were the action items from my last meeting?

> Take a screenshot and describe what's on it.

## How it works

This package is a thin stdio↔HTTP proxy. The SeaMeet desktop app hosts a local bridge on `127.0.0.1` (port 3741, fallbacks 3742/3743). On startup the app writes credentials to `$TMPDIR/seameet-mcp-bridge-<username>.json` (mode 0600); this server reads them and proxies:

- `tools/list` → `GET /mcp-bridge/tools`
- `tools/call` → `POST /mcp-bridge/call-tool`

Nothing leaves your machine — the bridge is localhost-only and authenticated with a per-launch random secret.

Full tool reference (for LLMs): [app.seameet.ai/mcp/llms.txt](https://app.seameet.ai/mcp/llms.txt) — also served locally at `http://localhost:3741/llms.txt` while the app runs.

## Errors are machine-readable

Tool failures return structured JSON your agent can branch on:

```json
{
  "success": false,
  "error": {
    "code": "app_not_running",
    "message": "The SeaMeet desktop app is not running.",
    "tool": "seameet_start_recording",
    "hint": "Ask the user to launch the SeaMeet desktop app, then retry. Download: https://seameet.ai/download/"
  }
}
```

| Code | Meaning |
|---|---|
| `app_not_running` | Desktop app is closed — ask the user to launch SeaMeet (`downloadUrl` + `requiredVersion` included) |
| `app_outdated` | Desktop app is running but too old for MCP — tell the user to **update** to `requiredVersion` (from `downloadUrl`); don't reinstall the same version |
| `app_not_ready` | App is starting up — retry in a few seconds |
| `invalid_request` | A required parameter is missing/invalid — re-check the tool schema |
| `path_forbidden` | `filePath` must be inside the SeaMeet save directory |
| `not_found` | File or artifact doesn't exist — discover with `seameet_list_recordings` |
| `timeout` | App didn't respond in time — check `seameet_recording_status`, retry once |
| `unknown_tool` | Includes `did_you_mean` suggestions |

When the app isn't running, `tools/list` exposes a single `seameet_desktop_app_status` tool so the agent gets an actionable answer instead of a dead connection.

## Configuration (rarely needed)

| Env var | Purpose |
|---|---|
| `SEAMEET_MCP_CREDENTIALS_FILE` | Explicit path to the desktop-bridge credentials file |
| `SEAMEET_BRIDGE_PORT` + `SEAMEET_BRIDGE_SECRET` | Bypass the bridge credentials file entirely |
| `SEAMEET_API_KEY` | Cloud API key (`smk_…`) — skips the device authorization flow |
| `SEAMEET_CLOUD_CREDENTIALS_FILE` | Where the minted cloud key is cached (default `~/.seameet/credentials.json`) |
| `SEAMEET_REMOTE_URL` / `SEAMEET_DEVICE_URL` | Override the cloud endpoints (default: production) |

## Development

```bash
npm install
npm test             # 20 tests: credentials discovery + end-to-end stdio client against a fake bridge + fake cloud
npm run build:mcpb   # validate manifest.json + pack the Claude Desktop extension into dist/seameet.mcpb
```

## License

MIT © [Seasalt.ai](https://seasalt.ai)
