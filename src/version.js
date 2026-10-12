import fs from 'node:fs';

// Reported in the MCP initialize handshake and in the User-Agent of every
// request to SeaMeet's cloud; read from package.json (shipped in both the npm
// package and the .mcpb bundle) so it can't drift.
export const PACKAGE_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// SeaMeet's servers count usage per client by User-Agent; this one is
// classified as "seameet-mcp".
export const USER_AGENT = `seameet-mcp/${PACKAGE_VERSION}`;
