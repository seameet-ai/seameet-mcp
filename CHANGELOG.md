# Changelog

All notable changes to `@seameet/mcp`. Format based on
[Keep a Changelog](https://keepachangelog.com/); this package uses [SemVer](https://semver.org/)
(pre-1.0, so minor versions may include small breaking changes — called out below).

## [0.2.3] - 2026-07-14

### Changed
- MCPB extension metadata now lists SeaMeet.ai as the author/developer and links
  to SeaMeet terms and privacy pages.

## [0.2.2] - 2026-07-14

### Fixed
- `seameet_status`, desktop capability errors, and docs now use the tap-qualified
  macOS install command `brew install --cask seameet-ai/tap/seameet`. SeaMeet is
  distributed through the `seameet-ai/homebrew-tap` cask today, so this command
  works for users who have not already tapped the custom repository.

## [0.2.1] - 2026-07-14

### Changed
- `seameet_status`, desktop capability errors, and docs briefly recommended the
  short macOS install command `brew install --cask seameet`. Windows remained
  `winget install seameet`.

## [0.2.0] - 2026-07-06

Dual-mode. One install now works whether or not the SeaMeet desktop app is present.

### Added
- **Cloud mode.** When the desktop app isn't running, the server exposes the hosted
  cloud tools (read your synced recordings + manage webhooks) via the remote MCP
  worker. Opt-in: it activates only with `SEAMEET_API_KEY` or after you authorize
  once. `tools/list` returns the **superset** of desktop + cloud tools; a tool the
  current backend can't serve returns a structured capability error
  (`app_not_running` / `auth_required`).
- **Seamless cloud authorization (no key copy/paste).** The first cloud tool call
  with no key starts an OAuth 2.0 Device Authorization flow (RFC 8628): the agent
  shows a short code + `https://app.seameet.ai/link`; you sign in and click
  Authorize; a read+write key is minted and cached at `~/.seameet/credentials.json`.
  The code is also printed to stderr as a backstop.
- **`seameet_status`** tool — reports whether desktop and/or cloud mode is connected.
- **`seameet_logout`** tool — forgets the cached cloud key and cancels a pending
  device flow (e.g. to switch accounts). You can also just delete
  `~/.seameet/credentials.json`.
- New config: `SEAMEET_API_KEY`, `SEAMEET_CLOUD_CREDENTIALS_FILE`,
  `SEAMEET_REMOTE_URL`, `SEAMEET_DEVICE_URL`.
- **One-page install for every major agent** ([INSTALL.md](INSTALL.md), also at
  app.seameet.ai/mcp/install.md): copy-paste recipes and one-line/one-click installs for Claude
  Code, Claude Desktop, Codex (CLI + IDE), Antigravity, Cursor, OpenCode, and GitHub Copilot CLI,
  plus a generic block. Or paste one line to any coding agent and it installs itself.
- **`app_outdated` diagnostic.** When the SeaMeet desktop app is running but too old
  to speak the MCP bridge contract, tools now return a distinct `app_outdated` error
  (with `installedVersion`, `requiredVersion`, and `downloadUrl`) and `seameet_status`
  reports `desktop.mode: "outdated"` — instead of a generic "unavailable" that made
  agents reverse-engineer the bridge. Desktop mode needs the SeaMeet app **v3.2.0+**.
  Desktop capability errors + `seameet_status` now also carry an `install` object with
  one-command paths (`brew install --cask seameet` /
  `winget install seameet`) so an agent can install/update the app
  without scraping the download page.

### Changed
- **BREAKING:** the fallback status tool was renamed
  `seameet_desktop_app_status` → `seameet_status` (it now reports both modes, not
  just the desktop app). If you referenced the old name, update it — the tool set is
  fetched live, so agents that discover tools via `tools/list` need no change.
- Server advertises `tools.listChanged` so clients re-list when the mode changes.
- Cloud tools stay listed even if your cached key was revoked — `tools/list` falls
  back to the public discovery key, so an agent can still call a cloud tool and be
  re-prompted to re-authorize instead of the tools silently vanishing.
- `tools/list` no longer blocks up to 30 s on a slow cloud (discovery uses a 5 s
  timeout), and the desktop probe re-checks instantly after the app launches
  (the "no desktop" result is no longer cached).

## [0.1.0]

### Added
- Initial stdio↔HTTP proxy to the SeaMeet desktop app's local bridge (17 recorder
  tools, fetched live). Structured errors; `seameet_desktop_app_status` fallback
  when the app isn't running.
