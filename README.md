# @seameet/mcp

The [SeaMeet](https://seameet.ai) MCP server — let AI agents **record, transcribe, and mine your meetings**. One install works whether or not you have the desktop app, in Claude Code, Claude Desktop, Codex, Antigravity, Cursor, OpenCode, GitHub Copilot CLI, Windsurf, and any MCP client.

It picks the richest available backend automatically and exposes the union of both:

- **Desktop mode** — when the SeaMeet desktop app is **running**, agents get the full recorder toolset (start/stop recordings, screenshots, live transcript, AI artifacts, search). No auth; nothing leaves your machine.
- **Cloud mode** — when the app isn't there, agents read your **synced library** (recordings, transcripts, summaries) and manage webhooks over the network. Authorized by logging into the web app — **no key copy/paste**, works on a headless terminal.

`tools/list` returns the superset of whatever's available; call **`seameet_status`** any time to see the current mode(s).

## What you can do

**🎙️ Record & capture** *(desktop mode)*
- Start a recording — microphone, screen, or screen + system audio
- Stop, and pause/resume audio-only recordings
- Check recording status and read the **live transcript** mid-recording
- Take a screenshot through SeaMeet

**📚 Work with recordings** *(desktop = local files · cloud = synced library)*
- List recordings & screenshots; browse files in the save directory
- Read generated **artifacts**: summary, transcript, SRT, chapters, action items, key decisions, and screenshot OCR/description
- **Search** across artifact text
- Get a temporary media **stream/download URL**; fetch a recording's asset bundle
- Rename a file; save a new artifact; **regenerate a summary** from a template; list templates

**☁️ Cloud account** *(cloud mode)*
- List recent synced recordings and fetch their summary / transcript / chapters / action items / key decisions
- Check storage usage
- Create / list / update / delete outbound **webhooks** (signed deliveries on `ai.ready` / `recording.synced`)

**🔌 Connection** *(any mode)*
- `seameet_status` — which modes are connected · `seameet_logout` — disconnect cloud / switch accounts

That's **17 desktop tools + 8 cloud tools** (fetched live, so new releases appear automatically). A tool the current backend can't serve returns a clear, structured error instead of failing silently.

## Install

**Every client runs the same command — `npx -y @seameet/mcp` — only the config format differs.** Full per-tool recipes: **[INSTALL.md](INSTALL.md)** (mirrored at [app.seameet.ai/mcp/install.md](https://app.seameet.ai/mcp/install.md)).

**Let your agent do it** — already inside a coding agent? Paste:

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
| **Claude Desktop** | one-click `.mcpb` bundle — see [below](#claude-desktop-one-click-bundle) |
| **Antigravity** · **OpenCode** · **anything else** | see [INSTALL.md](INSTALL.md) |

The generic block, accepted by most MCP clients:

```json
{
  "mcpServers": {
    "seameet": { "command": "npx", "args": ["-y", "@seameet/mcp"] }
  }
}
```

### Requirements
- **Node.js ≥ 18.**
- For desktop mode: the [SeaMeet desktop app](https://seameet.ai/download/) installed and **running** — `brew install --cask seameet-ai/tap/seameet` (macOS) or `winget install seameet` (Windows). Needs **v3.2.0+**; an older running app reports `app_outdated`.
- Cloud mode is opt-in and needs no app — the first cloud tool call starts a one-time authorization (below).

### Cloud authorization (one-time, no key copy/paste)
Cloud mode never activates unless you provide `SEAMEET_API_KEY` or complete the device flow. On the first cloud tool call with no key, the agent shows a short code + `https://app.seameet.ai/link`; you open it (signed in), click **Authorize**, and a read+write key is minted and cached at `~/.seameet/credentials.json`. Silent thereafter; revoke any time under **API keys** on your account. To disconnect or switch accounts, call `seameet_logout` (or `rm ~/.seameet/credentials.json`).

### Claude Desktop one-click bundle
`manifest.json` is an [MCPB](https://github.com/anthropics/mcpb) bundle manifest, so the server ships as a one-click Claude Desktop extension:

```bash
npm install && npm run build:mcpb   # → dist/seameet.mcpb
```

Install via **Settings → Extensions → Advanced → Install extension…** and pick `dist/seameet.mcpb`. Claude Desktop runs it with its own Node.js — no terminal needed. (The desktop app still needs to be installed + running for desktop mode.)

### Claude Code plugin (adds a `/seameet` skill)
This repo doubles as a [Claude Code plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces). The plugin registers the MCP server **and** a `/seameet` skill that teaches the core workflows (record + transcribe, capture a bug report, mine meetings for action items):

```bash
claude plugin marketplace add seameet-ai/seameet-mcp
claude plugin install seameet@seameet
```

## Try it

Ask your agent:

> Record my screen for 2 minutes, then give me the transcript.

> What were the action items from my last meeting?

> Take a screenshot and describe what's on it.

## How it works

A thin stdio↔HTTP proxy. The SeaMeet desktop app hosts a localhost-only bridge (`127.0.0.1:3741`, fallbacks 3742/3743) authenticated with a per-launch random secret; on startup it writes credentials to `$TMPDIR/seameet-mcp-bridge-<username>.json` (mode 0600), which this server reads and proxies (`tools/list` → `GET /mcp-bridge/tools`, `tools/call` → `POST /mcp-bridge/call-tool`). Nothing leaves your machine in desktop mode. Cloud mode talks to the hosted SeaMeet worker over HTTPS with your minted key.

Full tool reference (for LLMs): [app.seameet.ai/mcp/llms.txt](https://app.seameet.ai/mcp/llms.txt) — also served at `http://localhost:3741/llms.txt` while the app runs.

### Errors are machine-readable

Tool failures return structured JSON your agent can branch on:

```json
{ "success": false, "error": { "code": "app_not_running", "tool": "seameet_start_recording",
  "message": "The SeaMeet desktop app is not running.",
  "install": { "macos": "brew install --cask seameet-ai/tap/seameet", "windows": "winget install seameet" },
  "hint": "Ask the user to install and launch it, then retry." } }
```

| Code | Meaning |
|---|---|
| `app_not_running` | Desktop app is closed — launch it (payload carries `install` commands + `downloadUrl`) |
| `app_outdated` | App is running but too old — **update** to `requiredVersion` (don't reinstall the same build) |
| `auth_required` | Cloud tool needs authorization — the payload has a `user_code` + the `/link` URL |
| `app_not_ready` | App is starting up — retry in a few seconds |
| `invalid_request` | A required parameter is missing/invalid — re-check the tool schema |
| `path_forbidden` | `filePath` must be inside the SeaMeet save directory |
| `not_found` | File or artifact doesn't exist — discover it with a list/search tool first |
| `timeout` | App didn't respond in time — check status, retry once |
| `unknown_tool` | Includes `did_you_mean` suggestions |

### Configuration (rarely needed)

| Env var | Purpose |
|---|---|
| `SEAMEET_API_KEY` | Cloud API key (`smk_…`) — skips the device authorization flow |
| `SEAMEET_MCP_CREDENTIALS_FILE` | Explicit path to the desktop-bridge credentials file |
| `SEAMEET_BRIDGE_PORT` + `SEAMEET_BRIDGE_SECRET` | Bypass the bridge credentials file entirely |
| `SEAMEET_CLOUD_CREDENTIALS_FILE` | Where the minted cloud key is cached (default `~/.seameet/credentials.json`) |
| `SEAMEET_REMOTE_URL` / `SEAMEET_DEVICE_URL` | Override the cloud endpoints (default: production) |

## Development

```bash
npm install
npm test             # credentials discovery + end-to-end stdio client against a fake bridge + fake cloud
npm run build:mcpb   # validate manifest.json + pack the Claude Desktop extension
```

Releasing is automated — see [PUBLISHING.md](PUBLISHING.md).

## License

MIT © [Seasalt.ai](https://seasalt.ai)
