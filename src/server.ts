import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isRemote } from './client.js';
import { registerAccountTools } from './tools-account.js';
import { registerBootstrapTools } from './tools-bootstrap.js';
import { registerDesignTools } from './tools-design.js';
import { registerStorePushTools } from './tools-store-push.js';
import { registerStoreSetupTools } from './tools-store-setup.js';
import { registerTools } from './tools.js';

export const VERSION = '0.11.0';

export function createServer(): McpServer {
  const server = new McpServer({ name: 'gsr-mcp', version: VERSION });
  registerAccountTools(server);
  registerTools(server);
  // Bootstrap reads the app repo and drives the simulator — local only.
  if (!isRemote) registerBootstrapTools(server);
  registerDesignTools(server);
  registerStorePushTools(server);
  registerStoreSetupTools(server);
  return server;
}
