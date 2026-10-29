#!/usr/bin/env node
// Both branches import lazily: client.ts reads GSR_MCP_REMOTE when it loads,
// so the flag must be set before anything pulls it in.
if (process.argv.includes('--http')) {
  // Hosted remote server (Claude / ChatGPT connectors) — see http.ts.
  process.env.GSR_MCP_REMOTE = '1';
  await import('./http.js');
} else {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { createServer } = await import('./server.js');
  await createServer().connect(new StdioServerTransport());
}
