const API_BASE = (process.env.GSR_API_BASE ?? 'https://api.getstoreready.com').replace(/\/$/, '');
const SITE_BASE = (process.env.GSR_SITE_URL ?? 'https://getstoreready.com').replace(/\/$/, '');
const API_KEY = process.env.GSR_API_KEY;

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
  if (!API_KEY) {
    throw new Error(
      'GSR_API_KEY is not set. Create one at ' +
        SITE_BASE +
        '/profile/api-keys and set it in your MCP client config.',
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { Authorization: `Bearer ${API_KEY}`, ...(init?.headers ?? {}) },
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

export const gsr = {
  get: <T>(path: string) => request<T>(path, undefined, JSON_TIMEOUT_MS),
  post: <T>(path: string, body?: unknown) =>
    request<T>(
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      },
      JSON_TIMEOUT_MS,
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
  // No Content-Type here on purpose — fetch sets the multipart boundary
  // itself when the body is a FormData instance.
  upload: <T>(path: string, form: FormData) =>
    request<T>(path, { method: 'POST', body: form }, UPLOAD_TIMEOUT_MS),
};

export function editorUrl(projectId: string): string {
  return `${SITE_BASE}/projects/${projectId}`;
}
