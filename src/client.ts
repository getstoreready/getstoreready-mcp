import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const API_BASE = (process.env.GSR_API_BASE ?? 'https://api.getstoreready.com').replace(/\/$/, '');
const SITE_BASE = (process.env.GSR_SITE_URL ?? 'https://getstoreready.com').replace(/\/$/, '');

// Where the key comes from, in order: the remote (HTTP) server's per-request
// OAuth token, GSR_API_KEY, then the key `sign_in` saved on this machine.
const requestContext = new AsyncLocalStorage<{ apiKey: string; clientIp?: string }>();
const CREDENTIALS_PATH =
  process.env.GSR_CREDENTIALS_PATH ??
  join(homedir(), '.config', 'getstoreready', 'credentials.json');

/** True when running as the hosted remote MCP server (no local machine). */
export const isRemote = process.env.GSR_MCP_REMOTE === '1';

/** Local file paths mean the user's machine, which the hosted server can't
 * see — refuse instead of reading or writing the server's own disk. */
export function assertLocalFiles(what: string, alternative: string): void {
  if (isRemote) {
    throw new Error(
      `${what} needs a local file, which the hosted GetStoreReady connector cannot access. ` +
        `${alternative} Or use the local MCP server (npx github:getstoreready/getstoreready-mcp).`,
    );
  }
}

/** Run `fn` with the caller's OAuth access token as the API key (remote
 * mode). `clientIp` is forwarded so the API rate-limits per end user, not per
 * this server. */
export function runWithApiKey<T>(apiKey: string, clientIp: string | undefined, fn: () => T): T {
  return requestContext.run({ apiKey, clientIp }, fn);
}

function forwardedHeaders(): Record<string, string> {
  const ip = requestContext.getStore()?.clientIp;
  return ip ? { 'X-Forwarded-For': ip } : {};
}

function savedApiKey(): string | undefined {
  if (isRemote) return undefined;
  try {
    const { apiKey } = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8')) as { apiKey?: unknown };
    return typeof apiKey === 'string' && apiKey ? apiKey : undefined;
  } catch {
    return undefined;
  }
}

export function currentApiKey(): string | undefined {
  return requestContext.getStore()?.apiKey ?? process.env.GSR_API_KEY ?? savedApiKey();
}

/** Which source the active key came from — shown by get_account. */
export function apiKeySource(): 'oauth' | 'env' | 'saved' | 'none' {
  if (requestContext.getStore()) return 'oauth';
  if (process.env.GSR_API_KEY) return 'env';
  return savedApiKey() ? 'saved' : 'none';
}

export async function saveApiKey(apiKey: string): Promise<string> {
  await mkdir(dirname(CREDENTIALS_PATH), { recursive: true, mode: 0o700 });
  await writeFile(CREDENTIALS_PATH, JSON.stringify({ apiKey }, null, 2) + '\n', { mode: 0o600 });
  return CREDENTIALS_PATH;
}

export async function clearSavedApiKey(): Promise<boolean> {
  if (!savedApiKey()) return false;
  await rm(CREDENTIALS_PATH, { force: true });
  return true;
}

function requireApiKey(): string {
  const key = currentApiKey();
  if (!key) {
    throw new Error(
      'Not signed in to GetStoreReady. Call the sign_in tool (opens a browser sign-in / sign-up), ' +
        'or set GSR_API_KEY from ' +
        SITE_BASE +
        '/profile/api-keys in your MCP client config.',
    );
  }
  return key;
}

// Plain fetch() never times out on its own — a stalled request (bad network,
// hung upstream) would otherwise hang the calling agent forever with no
// error. JSON calls get a short budget; uploads (potentially several MB of
// image data) get a longer one.
const JSON_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 60_000;

export class GsrApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GsrApiError';
  }
}

export class GsrTimeoutError extends Error {
  constructor(ms: number) {
    super(`GetStoreReady API request timed out after ${ms}ms.`);
    this.name = 'GsrTimeoutError';
  }
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string') return body.error;
  } catch {
    // body wasn't JSON — fall through to statusText
  }
  return res.statusText || `HTTP ${res.status}`;
}

async function request<T>(
  path: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<T> {
  const apiKey = requireApiKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...forwardedHeaders(),
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new GsrTimeoutError(timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new GsrApiError(res.status, await readErrorMessage(res));
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function apiBase(): string {
  return API_BASE;
}

export function assetUrl(assetId: string): string {
  return `${API_BASE}/assets/${assetId}`;
}

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    q.set(key, String(value));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const gsr = {
  get: <T>(path: string) => request<T>(path, undefined, JSON_TIMEOUT_MS),
  getQuery: <T>(path: string, params: Record<string, string | number | boolean | undefined>) =>
    request<T>(`${path}${buildQuery(params)}`, undefined, JSON_TIMEOUT_MS),
  post: <T>(path: string, body?: unknown, timeoutMs = JSON_TIMEOUT_MS) =>
    request<T>(
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      },
      timeoutMs,
    ),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(
      path,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      },
      JSON_TIMEOUT_MS,
    ),
  put: <T>(path: string, body?: unknown) =>
    request<T>(
      path,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      },
      JSON_TIMEOUT_MS,
    ),
  delete: <T = void>(path: string) => request<T>(path, { method: 'DELETE' }, JSON_TIMEOUT_MS),
  // No Content-Type here on purpose — fetch sets the multipart boundary
  // itself when the body is a FormData instance.
  upload: <T>(path: string, form: FormData) =>
    request<T>(path, { method: 'POST', body: form }, UPLOAD_TIMEOUT_MS),
  /** Download a binary response (e.g. export ZIP, asset image). */
  download: async (path: string, timeoutMs = UPLOAD_TIMEOUT_MS): Promise<Buffer> => {
    const apiKey = requireApiKey();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, ...forwardedHeaders() },
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw new GsrTimeoutError(timeoutMs);
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new GsrApiError(res.status, await readErrorMessage(res));
    return Buffer.from(await res.arrayBuffer());
  },
};

export function siteUrl(path = ''): string {
  return `${SITE_BASE}${path}`;
}

export function editorUrl(projectId: string): string {
  return `${SITE_BASE}/projects/${projectId}`;
}

/** Image MIME type from magic bytes — the API's upload filter rejects
 * untyped (application/octet-stream) multipart files. */
export function imageMimeType(buf: Buffer): string {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP')
    return 'image/webp';
  if (buf.subarray(0, 3).toString() === 'GIF') return 'image/gif';
  return 'application/octet-stream';
}
