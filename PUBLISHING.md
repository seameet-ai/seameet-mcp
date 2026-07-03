# Publishing checklist

One-time steps that need human credentials (in order):

## 1. npm

```bash
npm login                      # as an owner of the @seameet npm scope
npm publish --access public
```

If the `@seameet` scope isn't claimed on npm, either create the org at
npmjs.com/org/create, or fall back to the unscoped name: change `"name"` in
package.json to `"seameet-mcp"` (also update server.json `identifier`,
README snippets, and the seameet.ai `/en/docs/agents/` page).

## 2. Make this repo public

GitHub → Settings → General → Danger Zone → Change visibility → Public.
(npm + GitHub search are primary agent-discovery channels; the README is
written for that audience.)

## 3. Official MCP Registry

Uses `server.json` (already in this repo). Requires GitHub auth matching the
`io.github.seameet-ai/*` namespace — log in as a seameet-ai org member:

```bash
npm i -g @modelcontextprotocol/publisher   # or: brew install mcp-publisher
mcp-publisher login github
mcp-publisher publish
```

Note: the registry verifies npm package ownership via a
`mcpName: "io.github.seameet-ai/seameet-mcp"` field in package.json — add it
before `npm publish` (harmless extra field) or re-publish a patch.

## 4. Community registries

- mcp.so — submit via https://mcp.so/submit (form)
- smithery.ai — sign in with GitHub, add server, point at this repo
- glama.ai/mcp — https://glama.ai/mcp/servers — claim via GitHub
- punkpeye/awesome-mcp-servers — open a PR adding under
  "Browser Automation"/"Productivity": link + one-line description

## 5. After publishing

- Verify: `npx -y @seameet/mcp` from a clean machine + `claude mcp add
  seameet -- npx -y @seameet/mcp` lists tools while the desktop app runs.
- Run the acceptance test: fresh Claude Code session → "Record my screen for
  2 minutes, then give me the transcript."
