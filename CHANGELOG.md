# Changelog

All notable changes to `@seameet/mcp`. Format based on
[Keep a Changelog](https://keepachangelog.com/); this package uses [SemVer](https://semver.org/)
(pre-1.0, so minor versions may include small breaking changes — called out below).

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
