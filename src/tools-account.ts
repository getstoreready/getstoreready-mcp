import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  apiBase,
  apiKeySource,
  clearSavedApiKey,
  currentApiKey,
  gsr,
  GsrApiError,
  isRemote,
  saveApiKey,
  siteUrl,
} from './client.js';
import { text } from './response.js';

// Account onboarding for agents: sign in / sign up through the browser
// (OAuth device flow — the user approves on getstoreready.com, the key lands
// in ~/.config/getstoreready), check the plan, and hand the user a checkout
// link. The agent never sees a password and never pays — the user does both
// in their own browser.

interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface PendingSignIn {
  deviceCode: string;
  userCode: string;
  url: string;
  expiresAt: number;
  intervalMs: number;
}

let pending: PendingSignIn | null = null;

/** How long one sign_in call waits for approval before handing back. */
const WAIT_MS = 45_000;

async function oauthPost(path: string, body: Record<string, string>) {
  const res = await fetch(`${apiBase()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  return { ok: res.ok, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

function openInBrowser(url: string): boolean {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

interface Me {
  user: { email: string; firstName: string | null; plan: string; isGuest: boolean } | null;
}

async function whoAmI(): Promise<Me['user']> {
  if (!currentApiKey()) return null;
  try {
    return (await gsr.get<Me>('/auth/me')).user;
  } catch (err) {
    if (err instanceof GsrApiError && err.status === 401) return null;
    throw err;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CatalogPrice {
  id: string;
  billingInterval: 'month' | 'year' | 'once';
  amountCents: number;
  currency: string;
}
interface CatalogProduct {
  slug: string;
  type: string;
  name: string;
  description: string | null;
  metadata: Record<string, unknown>;
  prices: CatalogPrice[];
}

const money = (p: CatalogPrice) =>
  `${(p.amountCents / 100).toFixed(2)} ${p.currency.toUpperCase()}${
    p.billingInterval === 'once' ? '' : ` / ${p.billingInterval}`
  }`;

async function purchasable(): Promise<CatalogProduct[]> {
  const { products } = await gsr.get<{ products: CatalogProduct[] }>('/commerce/catalog');
  return products.filter(
    (p) =>
      (p.type === 'subscription' || p.type === 'credit_pack') && p.metadata.comingSoon !== true,
  );
}

export function registerAccountTools(server: McpServer): void {
  if (!isRemote) {
    server.tool(
      'sign_in',
      'Sign in to (or create) a GetStoreReady account through the browser — no API key or password ' +
        'in the chat. Opens getstoreready.com/connect with a short code; the user signs up or logs ' +
        'in there and clicks Allow. Waits up to ~45s; if the user is not done yet it returns ' +
        'status "pending" — show them the URL and code, then call sign_in again to keep waiting. ' +
        'The key is saved to ~/.config/getstoreready/credentials.json for future sessions.',
      {
        force: z
          .boolean()
          .default(false)
          .describe('Start a fresh sign-in even if already signed in (switch accounts)'),
        openBrowser: z
          .boolean()
          .default(true)
          .describe('Try to open the sign-in page in the default browser'),
      },
      async ({ force, openBrowser }) => {
        if (!force && !pending) {
          const me = await whoAmI();
          if (me && !me.isGuest) {
            return text({
              status: 'signed_in',
              email: me.email,
              plan: me.plan,
              keySource: apiKeySource(),
            });
          }
        }
        if (apiKeySource() === 'env') {
          return text({
            status: 'error',
            message:
              'GSR_API_KEY is set in the MCP config and takes precedence over a browser sign-in. ' +
              'Remove it from the config (or fix the key) and restart the MCP server.',
          });
        }

        let opened = false;
        if (!pending || pending.expiresAt < Date.now()) {
          const clientName = server.server.getClientVersion()?.name;
          const start = await oauthPost('/oauth/device_authorization', {
            client_name: clientName ? `${clientName} (MCP)` : 'GetStoreReady MCP',
          });
          if (!start.ok) throw new Error(`Could not start sign-in: ${JSON.stringify(start.body)}`);
          const d = start.body as unknown as DeviceStart;
          pending = {
            deviceCode: d.device_code,
            userCode: d.user_code,
            url: d.verification_uri_complete,
            expiresAt: Date.now() + d.expires_in * 1000,
            intervalMs: d.interval * 1000,
          };
          if (openBrowser) opened = openInBrowser(pending.url);
        }

        const current = pending;
        const deadline = Math.min(Date.now() + WAIT_MS, current.expiresAt);
        while (Date.now() < deadline) {
          await sleep(current.intervalMs);
          const poll = await oauthPost('/oauth/token', {
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: current.deviceCode,
          });
          if (poll.ok && typeof poll.body.access_token === 'string') {
            pending = null;
            const savedTo = await saveApiKey(poll.body.access_token);
            const me = await whoAmI();
            return text({ status: 'signed_in', email: me?.email, plan: me?.plan, savedTo });
          }
          const error = poll.body.error;
          if (error === 'slow_down') current.intervalMs += 5000;
          else if (error !== 'authorization_pending') {
            pending = null;
            return text({
              status: error === 'access_denied' ? 'denied' : 'expired',
              message:
                error === 'access_denied'
                  ? 'The user declined the sign-in.'
                  : 'The sign-in request expired — call sign_in again for a new code.',
            });
          }
        }
        return text({
          status: 'pending',
          url: current.url,
          code: current.userCode,
          browserOpened: opened,
          message:
            `Ask the user to open ${current.url} (create an account or log in), check that the ` +
            `code ${current.userCode} matches, and click Allow. Then call sign_in again.`,
        });
      },
    );

    server.tool(
      'sign_out',
      'Forget the GetStoreReady key that sign_in saved on this machine. The key itself stays ' +
        'valid until revoked under Profile → API keys.',
      {},
      async () => {
        pending = null;
        const removed = await clearSavedApiKey();
        return text({
          signedOut: removed,
          note: removed
            ? `Revoke the key at ${siteUrl('/profile/api-keys')} to disable it everywhere.`
            : 'No saved key on this machine.',
          ...(apiKeySource() === 'env' ? { stillActive: 'GSR_API_KEY from the MCP config' } : {}),
        });
      },
    );
  }

  server.tool(
    'get_account',
    'Who the MCP is signed in as and their plan (free / premium / pro). Use it to check sign-in ' +
      'before other tools, and after start_checkout to see whether the purchase went through.',
    {},
    async () => {
      const me = await whoAmI();
      if (!me) {
        return text({
          signedIn: false,
          next: isRemote ? 'Reconnect the GetStoreReady connector.' : 'Call sign_in.',
        });
      }
      const credits = await gsr.get<Record<string, unknown>>('/ai/credits').catch(() => undefined);
      return text({
        signedIn: true,
        email: me.email,
        name: me.firstName,
        plan: me.plan,
        aiCredits: credits,
        keySource: apiKeySource(),
        manage: siteUrl('/dashboard'),
      });
    },
  );

  server.tool(
    'list_plans',
    'Plans and AI-credit packs that can be bought, with prices. Free covers basic projects; ' +
      'Premium/Pro unlock more projects, premium templates and direct App Store / Google Play push.',
    {},
    async () => {
      const products = await purchasable();
      return text({
        plans: products.map((p) => ({
          product: p.slug,
          type: p.type,
          name: p.name,
          description: p.description,
          prices: p.prices.map((pr) => ({ interval: pr.billingInterval, price: money(pr) })),
        })),
        compare: siteUrl('/pricing'),
      });
    },
  );

  server.tool(
    'start_checkout',
    'Create a checkout for a plan or credit pack and return the payment link. The agent cannot ' +
      'pay: give the link to the user, who pays in their browser (signed in to the same account). ' +
      'Call get_account afterwards to confirm the new plan. Product slugs come from list_plans.',
    {
      product: z.string().min(1).describe('Product slug from list_plans, e.g. "premium"'),
      interval: z
        .enum(['month', 'year'])
        .optional()
        .describe('Billing interval for subscriptions (default month)'),
    },
    async ({ product, interval }) => {
      const products = await purchasable();
      const p = products.find((x) => x.slug === product);
      if (!p) {
        throw new Error(
          `Unknown product "${product}". Available: ${products.map((x) => x.slug).join(', ')}`,
        );
      }
      const want = p.type === 'subscription' ? (interval ?? 'month') : 'once';
      const price = p.prices.find((x) => x.billingInterval === want);
      if (!price) throw new Error(`${p.name} has no ${want} price.`);
      const { order } = await gsr.post<{ order: { id: string } }>('/commerce/orders', {
        priceId: price.id,
        provider: 'crypto',
      });
      return text({
        checkoutUrl: siteUrl(`/checkout/${order.id}`),
        product: p.name,
        price: money(price),
        message:
          'Share checkoutUrl with the user — they choose a payment method and pay there. ' +
          'Then call get_account to confirm.',
      });
    },
  );
}
