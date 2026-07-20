const API_BASE = (process.env.GSR_API_BASE ?? 'https://api.getstoreready.com').replace(/\/$/, '');
const SITE_BASE = (process.env.GSR_SITE_URL ?? 'https://getstoreready.com').replace(/\/$/, '');
const API_KEY = process.env.GSR_API_KEY;

export class GsrApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GsrApiError';
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!API_KEY) {
    throw new Error(
      'GSR_API_KEY is not set. Create one at ' +
        SITE_BASE +
        '/profile/api-keys and set it in your MCP client config.',
    );
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${API_KEY}`, ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new GsrApiError(res.status, await readErrorMessage(res));
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const gsr = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }),
  // No Content-Type here on purpose — fetch sets the multipart boundary
  // itself when the body is a FormData instance.
  upload: <T>(path: string, form: FormData) => request<T>(path, { method: 'POST', body: form }),
};

export function editorUrl(projectId: string): string {
  return `${SITE_BASE}/projects/${projectId}`;
}
