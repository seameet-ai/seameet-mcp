# @seameet/mcp

MCP server for [SeaMeet](https://seameet.ai) — lets AI agents (Claude Code, Codex, Cursor, Claude Desktop, Windsurf) operate the SeaMeet desktop recorder:

- **Start / stop / pause screen & audio recordings** (`seameet_start_recording`, `seameet_stop_recording`, …)
- **Take screenshots** (`seameet_take_screenshot`)
- **Read the live transcript mid-meeting** (`seameet_get_live_transcript`)
- **Read AI artifacts** — summaries, transcripts, action items, key decisions, chapters, OCR (`seameet_get_artifact`)
- **Search across every recording** (`seameet_search_text`)
- **Save agent-generated artifacts** back to a recording (`seameet_save_artifact`)

17 tools total. The inventory is fetched live from the app, so new SeaMeet releases add tools here automatically — no package update needed.

## Requirements

- The [SeaMeet desktop app](https://seameet.ai/download/) installed and **running** (Windows / macOS)
- Node.js ≥ 18

## Install

**Claude Code**

```bash
claude mcp add seameet -- npx -y @seameet/mcp
```

Or install the [plugin](#claude-code-plugin) to also get the `/seameet` skill (guided workflows):

```bash
claude plugin marketplace add seameet-ai/seameet-mcp
claude plugin install seameet@seameet
```

**Claude Desktop** — install the one-click [extension bundle](#claude-desktop-extension) (`.mcpb`), or use the JSON config below.

**Codex CLI** (`~/.codex/config.toml`)

```toml
[mcp_servers.seameet]
command = "npx"
args = ["-y", "@seameet/mcp"]
```

**Cursor** (`~/.cursor/mcp.json`) / **Claude Desktop** (`claude_desktop_config.json`) / **Windsurf**

```json
{
  "mcpServers": {
    "seameet": {
      "command": "npx",
      "args": ["-y", "@seameet/mcp"]
    }
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
| `app_not_running` | Desktop app is closed — ask the user to launch SeaMeet |
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
| `SEAMEET_MCP_CREDENTIALS_FILE` | Explicit path to the credentials file |
| `SEAMEET_BRIDGE_PORT` + `SEAMEET_BRIDGE_SECRET` | Bypass the credentials file entirely |

## Development

```bash
npm install
npm test             # 13 tests: credentials discovery + end-to-end stdio client against a fake bridge
npm run build:mcpb   # validate manifest.json + pack the Claude Desktop extension into dist/seameet.mcpb
```

## License

MIT © [Seasalt.ai](https://seasalt.ai)
