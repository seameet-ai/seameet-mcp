# Installing `@seameet/mcp`

`@seameet/mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI
agents record and read your SeaMeet meetings. It's a single stdio command —
`npx -y @seameet/mcp` — that every MCP-capable tool can launch. This page has the exact recipe
for each tool.

---

## Fastest path — let your agent install it

If you're already in a coding agent (Claude Code, Codex, Cursor, Antigravity, OpenCode, Copilot
CLI…), just paste this to it:

> **Install the SeaMeet MCP server for me.** Fetch
> `https://app.seameet.ai/mcp/install.md` (or
> `https://raw.githubusercontent.com/seasalt-ai/seameet-mcp/main/INSTALL.md`), figure out which
> tool you're running inside, apply the matching section by editing the right config file, and
> tell me how to reload.

The agent reads this file, detects its own host, writes the one config entry, and confirms.
Nothing else to copy.

> **Agent reading this:** identify your host tool from the sections below, edit **its** MCP config
> file (never the user's shell profile or unrelated config), then tell the user the reload step
> for that tool. If you can't tell which tool you are, ask. All servers use the same command —
> `npx -y @seameet/mcp` — only the file format differs.

---

## Pick your tool

| Tool | One-liner / one-click | Config file |
|---|---|---|
| [Claude Code (CLI)](#claude-code-cli) | `claude mcp add seameet -- npx -y @seameet/mcp` | `.mcp.json` / `~/.claude.json` |
| [Claude Desktop](#claude-desktop) | one-click `.mcpb` bundle | `claude_desktop_config.json` |
| [Codex CLI](#codex-cli) | `codex mcp add seameet -- npx -y @seameet/mcp` | `~/.codex/config.toml` |
| [Codex IDE / app](#codex-ide--app) | (shares Codex CLI config) | `~/.codex/config.toml` |
| [Antigravity](#antigravity) | Agent panel → MCP Servers | `~/.gemini/config/mcp_config.json` |
| [Cursor](#cursor) | [Add to Cursor](#cursor) one-click | `~/.cursor/mcp.json` |
| [OpenCode](#opencode) | edit config | `opencode.json` |
| [GitHub Copilot CLI](#github-copilot-cli) | `copilot mcp add seameet -- npx -y @seameet/mcp` | `~/.copilot/mcp-config.json` |
| [Anything else](#generic-any-mcp-client) | generic `mcpServers` block | — |

**Requirements:** Node.js ≥ 18. The SeaMeet desktop app (running) unlocks the full recorder tool
set; without it you still get cloud tools once you authorize. See the [README](README.md) for the
two modes.

---

## Claude Code (CLI)

One command:

```bash
claude mcp add seameet -- npx -y @seameet/mcp
```

The `--` is required — everything after it is the literal launch command. Add `-s user` to enable
it in every project, or `-s project` to write a shared `.mcp.json` into the repo.

Project file (`.mcp.json` at the repo root, commit to share with your team):

```json
{
  "mcpServers": {
    "seameet": { "command": "npx", "args": ["-y", "@seameet/mcp"] }
  }
}
```

Reload: none — it's live after the command. Project-scoped servers prompt for approval on first
use. Docs: <https://code.claude.com/docs/en/mcp>

## Claude Desktop

**One-click (recommended):** install the SeaMeet extension bundle. Build it from this repo with
`npm run build:mcpb` (→ `dist/seameet.mcpb`), then in Claude Desktop go **Settings → Extensions →
Advanced → Install Extension…** and pick the `.mcpb`. Claude Desktop ships its own Node runtime —
no JSON, no Node setup.

**Manual JSON:** open **Settings → Developer → Edit Config** (or edit the file directly):

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "seameet": { "command": "npx", "args": ["-y", "@seameet/mcp"] }
  }
}
```

Reload: **fully quit and relaunch** Claude Desktop — it reads MCP servers only at startup.
Windows: if `npx` isn't found, use `"command": "cmd"`, `"args": ["/c", "npx", "-y", "@seameet/mcp"]`.
Logs: `~/Library/Logs/Claude/mcp*.log` · `%APPDATA%\Claude\logs\mcp*.log`.

## Codex CLI

One command:

```bash
codex mcp add seameet -- npx -y @seameet/mcp
```

Or edit `~/.codex/config.toml` (global) — note this is **TOML**, not JSON:

```toml
[mcp_servers.seameet]
command = "npx"
args = ["-y", "@seameet/mcp"]
```

Reload: restart `codex`, or run `/mcp` in the TUI. `codex mcp list` shows it.
Windows on older builds: `command = "cmd"`, `args = ["/c", "npx", "-y", "@seameet/mcp"]`.
Docs: <https://developers.openai.com/codex/mcp>

## Codex IDE / app

Codex's IDE extension and app **share `~/.codex/config.toml`** — there's no separate store. Add the
same `[mcp_servers.seameet]` block as [Codex CLI](#codex-cli) (Codex panel → gear → MCP settings →
Open config.toml), or just run `codex mcp add seameet -- npx -y @seameet/mcp` in a terminal, then
reload the extension. A per-workspace `.codex/config.toml` applies only in **trusted** projects.

## Antigravity

Edit the global config at `~/.gemini/config/mcp_config.json` (Windows:
`%USERPROFILE%\.gemini\config\mcp_config.json`), or a workspace `.agents/mcp_config.json`:

```json
{
  "mcpServers": {
    "seameet": { "command": "npx", "args": ["-y", "@seameet/mcp"] }
  }
}
```

Or via the UI: **Agent side panel → `…` menu → MCP Servers → Manage MCP Servers → View raw config**,
paste, then **Refresh** (no full restart). Strict JSON — no comments. Docs:
<https://antigravity.google/docs/mcp>

## Cursor

**One-click:** click **[Add to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=seameet&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBzZWFtZWV0L21jcCJdfQ==)** — or paste this URL into your browser:

```
cursor://anysphere.cursor-deeplink/mcp/install?name=seameet&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBzZWFtZWV0L21jcCJdfQ==
```

**Manual:** edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "seameet": { "command": "npx", "args": ["-y", "@seameet/mcp"] }
  }
}
```

Reload: Cursor picks it up automatically; toggle it on under **Settings → MCP** if needed. Docs:
<https://cursor.com/docs/context/mcp>

## OpenCode

OpenCode uses a **different schema** — top-level `mcp`, `type: "local"`, and the command is a
**single array**. Edit `~/.config/opencode/opencode.json` (global) or `opencode.json` (project):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "seameet": {
      "type": "local",
      "command": ["npx", "-y", "@seameet/mcp"],
      "enabled": true
    }
  }
}
```

Don't split into `command`/`args` (that's the other tools' shape). Env vars, if ever needed, go in an
`environment` object. Reload: restart OpenCode. Docs: <https://opencode.ai/docs/mcp-servers/>

## GitHub Copilot CLI

The terminal `copilot` tool (not Copilot in VS Code). One command:

```bash
copilot mcp add seameet -- npx -y @seameet/mcp
```

Or in-session: `/mcp add` → name `seameet` → type **Local/STDIO** → command `npx`, args
`-y @seameet/mcp` → `Ctrl+S`. Or edit `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "seameet": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "@seameet/mcp"],
      "tools": ["*"]
    }
  }
}
```

Reload: restart the CLI. Docs:
<https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers>

## Generic (any MCP client)

Most MCP clients accept the standard `mcpServers` object. Add a `seameet` stdio entry:

```json
{
  "mcpServers": {
    "seameet": { "command": "npx", "args": ["-y", "@seameet/mcp"] }
  }
}
```

If your client uses a different key or shape, the invariant is always the same: run the command
**`npx`** with args **`-y @seameet/mcp`** as a **local/stdio** server. Consult your client's MCP docs
for where its config lives.

---

## Windows note

If a tool can't find `npx`, wrap it with `cmd`:

```json
{ "command": "cmd", "args": ["/c", "npx", "-y", "@seameet/mcp"] }
```

(Recent Codex and Claude Code builds resolve `npx` natively; this is the fallback.)

## Verify it worked

Ask your agent:

> What SeaMeet tools do you have? Call `seameet_status`.

You should see `seameet_status` report the current mode(s). With the SeaMeet desktop app running
you'll also get the recorder tools (start/stop recording, screenshots, transcript…); without it,
the cloud tools appear and the first one prompts you to authorize once. See the
[README](README.md#two-modes-one-install) for details.

Trouble? <https://github.com/seasalt-ai/seameet-mcp/issues>
