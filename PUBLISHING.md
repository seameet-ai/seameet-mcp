# Publishing `@seameet/mcp`

npm releases are **automated** by [`.github/workflows/publish.yml`](.github/workflows/publish.yml):
push a `v<version>` tag and it tests + publishes with build provenance via npm **Trusted Publishing
(OIDC)** — no `NPM_TOKEN` secret. The registry/discovery steps below are one-time.

## ⚠️ Before the first `0.2.0` publish

The published client defaults to **production** endpoints (`DEFAULT_DEVICE_URL` / `DEFAULT_REMOTE_URL`
in `src/index.js`). Do **not** tag `v0.2.0` until PROD is live — `mcp-device` deployed to the PROD
Supabase project and the `/link` page live on `app.seameet.ai` — or a real user's cloud device-flow
(`npx @seameet/mcp` → authorize) fails against endpoints that don't exist yet. Desktop mode is
unaffected (localhost-only). Tracking: seasalt-ai/seameet-app-desktop#461.

## 1. npm release (automated)

1. Bump `package.json` version (SemVer; pre-1.0, so minor may carry small breaking changes — note them in `CHANGELOG.md`).
2. Commit to `main` (via PR).
3. Tag and push:
   ```bash
   git tag v0.2.0        # must equal package.json version, or the job fails fast
   git push --tags
   ```
4. Watch the **Publish to npm** workflow (verify tag == version → `npm install` + `npm test` → `npm publish --provenance --access public`).
5. Confirm: `npm view @seameet/mcp version`.

**Auth (Trusted Publishing / OIDC):** configured once on **npmjs.com → the `@seameet/mcp` package →
Settings → Trusted Publisher →** GitHub Actions, owner `seameet-ai`, repo `seameet-mcp`, workflow
`publish.yml`. If you rename the workflow or move the repo, update that entry.

**Manual fallback** (only if the workflow is unavailable, and you own the `@seameet` scope):
```bash
npm login && npm install && npm test
npm publish --provenance --access public
```
If the `@seameet` scope isn't claimed on npm, create the org at npmjs.com/org/create (or fall back to
the unscoped `seameet-mcp` name — also update `server.json` `identifier`, README snippets, and the
seameet.ai `/en/docs/agents/` page).

## 2. Make this repo public

✅ Done. (npm + GitHub search are primary agent-discovery channels; the README is written for that
audience.) If it ever goes private again: GitHub → Settings → General → Danger Zone → Change visibility.

## 3. Official MCP Registry

Uses `server.json` (already in this repo). Requires GitHub auth matching the `io.github.seameet-ai/*`
namespace — log in as a seameet-ai org member:

```bash
npm i -g @modelcontextprotocol/publisher   # or: brew install mcp-publisher
mcp-publisher login github
mcp-publisher publish
```

Note: the registry verifies npm package ownership via a `mcpName: "io.github.seameet-ai/seameet-mcp"`
field in package.json — add it before `npm publish` (harmless extra field) or re-publish a patch.

## 4. Community registries

- mcp.so — submit via https://mcp.so/submit (form)
- smithery.ai — sign in with GitHub, add server, point at this repo
- glama.ai/mcp — https://glama.ai/mcp/servers — claim via GitHub
- punkpeye/awesome-mcp-servers — open a PR adding a link + one-line description under the right category

## 5. After publishing

- Verify from a clean machine: `npx -y @seameet/mcp`, and `claude mcp add seameet -- npx -y @seameet/mcp` lists tools while the desktop app runs.
- Acceptance test: fresh Claude Code session → "Record my screen for 2 minutes, then give me the transcript."
