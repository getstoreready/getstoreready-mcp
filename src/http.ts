import { createHash } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { apiBase, runWithApiKey } from './client.js';
import { createServer, VERSION } from './server.js';

// Hosted remote MCP server (`getstoreready-mcp --http`), e.g. behind
// https://api.getstoreready.com/mcp. Stateless Streamable HTTP: every request
// gets a fresh server bound to the caller's OAuth access token. Clients
// without a token get a 401 pointing at the protected-resource metadata, which
// starts the OAuth flow (sign up / log in on getstoreready.com, then Allow).

const PORT = Number(process.env.PORT ?? 3100);
/** Public URL of the API that serves the OAuth metadata (the issuer). */
const PUBLIC_BASE = (process.env.GSR_PUBLIC_API_BASE ?? 'https://api.getstoreready.com').replace(
  /\/$/,
  '',
);
const RESOURCE_METADATA = `${PUBLIC_BASE}/.well-known/oauth-protected-resource/mcp`;
const MAX_BODY_BYTES = 30 * 1024 * 1024; // base64 screenshot uploads

/** Valid tokens, cached briefly so each tool call doesn't re-check. */
const validTokens = new Map<string, number>();
const TOKEN_CACHE_MS = 60_000;

async function tokenIsValid(token: string, clientIp: string | undefined): Promise<boolean> {
  const key = createHash('sha256').update(token).digest('hex');
  const until = validTokens.get(key);
  if (until && until > Date.now()) return true;
  const res = await fetch(`${apiBase()}/auth/me`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(clientIp ? { 'X-Forwarded-For': clientIp } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => ({}))) as { user?: { isGuest?: boolean } | null };
  const ok = res.ok && !!body.user && !body.user.isGuest;
  if (ok) {
    if (validTokens.size > 5000) validTokens.clear();
    validTokens.set(key, Date.now() + TOKEN_CACHE_MS);
  }
  return ok;
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function unauthorized(res: ServerResponse, error?: string) {
  send(
    res,
    401,
    { error: 'unauthorized', error_description: 'Connect your GetStoreReady account.' },
    {
      'WWW-Authenticate':
        `Bearer resource_metadata="${RESOURCE_METADATA}"` + (error ? `, error="${error}"` : ''),
    },
  );
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/health') return send(res, 200, { ok: true, version: VERSION });
  if (path !== '/mcp' && path !== '/') return send(res, 404, { error: 'not_found' });

  // Stateless server: no SSE stream to resume and no session to delete.
  if (req.method !== 'POST') {
    return send(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  }

  // nginx sets X-Real-IP to the end user's address (Cloudflare real-ip).
  const clientIp = (req.headers['x-real-ip'] as string | undefined) ?? req.socket.remoteAddress;
  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return unauthorized(res);
  if (!(await tokenIsValid(token, clientIp))) return unauthorized(res, 'invalid_token');

  let body: unknown;
  try {
    body = await readJson(req);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 400;
    return send(res, status, { error: status === 413 ? 'Body too large' : 'Invalid JSON' });
  }

  await runWithApiKey(token, clientIp, async () => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
}

createHttpServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('[gsr-mcp] request failed:', err);
    if (!res.headersSent) send(res, 500, { error: 'internal_error' });
  });
}).listen(PORT, () => {
  console.error(`[gsr-mcp] remote server v${VERSION} on :${PORT} (API ${apiBase()})`);
});
