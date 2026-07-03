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
npm test   # 13 tests: credentials discovery + end-to-end stdio client against a fake bridge
```

## License

MIT © [Seasalt.ai](https://seasalt.ai)
