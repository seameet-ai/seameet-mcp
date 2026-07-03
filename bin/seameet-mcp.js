#!/usr/bin/env node
import { main } from '../src/index.js';

main().catch((err) => {
  process.stderr.write(`[seameet-mcp] fatal: ${err.message}\n`);
  process.exit(1);
});
