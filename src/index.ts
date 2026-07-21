#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerBootstrapTools } from './tools-bootstrap.js';
import { registerStorePushTools } from './tools-store-push.js';
import { registerTools } from './tools.js';

const server = new McpServer({ name: 'gsr-mcp', version: '0.4.0' });
registerTools(server);
registerBootstrapTools(server);
registerStorePushTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
