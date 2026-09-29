# Changelog

All notable changes to `@seameet/mcp`. Format based on
[Keep a Changelog](https://keepachangelog.com/); this package uses [SemVer](https://semver.org/)
(pre-1.0, so minor versions may include small breaking changes — called out below).

## [0.3.0] - 2026-09-29

> **Release gate:** publish 0.3.0 only after stt-proxy API-key auth
> (seasalt-ai/seameet-app-desktop#845) is deployed to PROD. Until then the
> transcription service rejects keys at job start, so every upload would land
> in the library untranscribed (the tool reports `job_start_failed`).

### Added
- **`seameet_transcribe_file`: transcribe a file from your computer.** Ask
  "Transcribe ~/Downloads/interview.m4a" and the agent uploads the file to your
  SeaMeet library and starts a speaker-labeled transcription, the same way
  app.seameet.ai/transcribe does. It returns right away with the recording's
  `assetId`, a link to it on app.seameet.ai, and when to check back with
  `seameet_get_recording`. Works with mp3, m4a, mp4, mov, wav, flac, ogg, oga,
  opus, webm, aac, amr and spx files up to 512 MB and 5 hours, uses your
  transcription allowance, and needs a read+write key (the one cloud
  authorization mints). Before uploading it checks your remaining allowance and
  daily upload limit, so a file that can't be transcribed isn't uploaded.
- Upload progress arrives as stage notifications (reading the file, checking
  your allowance, each 8 MB part starting and finishing, finishing, starting
  transcription), at most one per second, so hosts that extend their timeout
  on progress don't cut off a big upload. A stalled transfer still needs a long
  enough host timeout (`MCP_TOOL_TIMEOUT` in Claude Code).
- Cancelling the call from your agent stops the upload and cleans up the
  partial upload. Cancelled before the transcription request was sent, no
  transcription starts (`cancelled`); cancelled after it was sent, the tool
  says it may have started (`outcome_unknown`) so your agent checks
  `seameet_get_recording` instead of trying again.
- The file is read from one open handle from validation to the last byte; if
  it changes during the upload you get `file_changed` instead of a corrupted
  upload. Recordings known to be over 5 hours are refused before uploading.
- After the upload has finished, every error points at the file's page on
  app.seameet.ai instead of suggesting a re-run, so a retry never uploads a
  duplicate. An upload whose completion couldn't be confirmed reports
  `upload_unknown` with that link.
- New config: `SEAMEET_SUPABASE_URL`, `SEAMEET_SUPABASE_ANON_KEY`,
  `SEAMEET_STT_PROXY_URL`, `SEAMEET_WEB_URL`.

### Changed
- New dependency: `music-metadata`, used to read a file's length and whether it
  has a picture before uploading.
- The server now reports its real package version in the MCP handshake.

### Security
- Requests that carry your API key never follow redirects, so the key can't be
  forwarded to another host. Server responses are size-capped and time-bounded.
- A rejected key is forgotten only if it is still the one saved on disk, so a
  slow request can't delete a key you authorized in the meantime.

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
