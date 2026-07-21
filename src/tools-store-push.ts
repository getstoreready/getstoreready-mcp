import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { editorUrl, gsr } from './client.js';
import { text } from './response.js';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ascDisplaySlots = z.enum(['iphone-6.9', 'ipad-13']);
const playDisplaySlots = z.enum([
  'android-phone',
  'android-tablet-7',
  'android-tablet-10',
  'feature-graphic',
]);

const previewScope = {
  locales: z.array(z.string().min(2)).optional(),
  includeListing: z.boolean().optional(),
  includeScreenshots: z.boolean().optional(),
  fetchRemoteDiff: z
    .boolean()
    .optional()
    .describe('Compare against live store — default true for review'),
};

const pushBody = {
  locales: z.array(z.string().min(2)).optional(),
  skipUnchanged: z.boolean().optional().describe('Skip locales/assets unchanged since last push'),
  includeListing: z.boolean().optional(),
  includeScreenshots: z.boolean().optional(),
  wait: z.boolean().default(true).describe('Poll until the push job finishes'),
};

async function pollPushJob(
  path: string,
  jobId: string,
  wait: boolean,
): Promise<Record<string, unknown>> {
  const terminal = new Set(['completed', 'partial', 'failed', 'cancelled']);
  const fetchJob = () => gsr.get<Record<string, unknown>>(`${path}/${jobId}`);

  if (!wait) return { ...(await fetchJob()), jobId };

  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const job = await fetchJob();
    const status = String(job.status ?? '');
    if (terminal.has(status)) return job;
    await sleep(3000);
  }
  throw new Error(`Push job timed out after 5 minutes — poll ${path}/${jobId}`);
}

export function registerStorePushTools(server: McpServer): void {
  server.tool(
    'get_app_store_link',
    'Get App Store Connect link status for a project (credential label, app id, bundle id). ' +
      'Requires Premium/Pro. Set up credentials in the web UI first.',
    { projectId: z.string().min(1) },
    async ({ projectId }) => {
      const data = await gsr.get<{ link: unknown }>(`/projects/${projectId}/app-store/link`);
      return text({ ...data, editorUrl: editorUrl(projectId) });
    },
  );

  server.tool(
    'preview_app_store_push',
    'Review what would be pushed to App Store Connect — blockers, warnings, locale plans, and ' +
      'optional remote diff vs the live store. Call this before push_to_app_store.',
    {
      projectId: z.string().min(1),
      ...previewScope,
      displaySlots: z.array(ascDisplaySlots).optional(),
    },
    async ({ projectId, fetchRemoteDiff, ...query }) => {
      const data = await gsr.getQuery<Record<string, unknown>>(
        `/projects/${projectId}/app-store/preview`,
        {
          ...query,
          locales: query.locales?.join(','),
          fetchRemoteDiff: fetchRemoteDiff ?? true,
          displaySlots: query.displaySlots?.join(','),
        },
      );
      return text(data);
    },
  );

  server.tool(
    'push_to_app_store',
    'Enqueue an App Store Connect push (listing + screenshots). Requires Premium/Pro and a linked app. ' +
      'Always call preview_app_store_push first and confirm with the user when blockers exist.',
    {
      projectId: z.string().min(1),
      ...pushBody,
      displaySlots: z.array(ascDisplaySlots).optional(),
    },
    async ({ projectId, wait, displaySlots, ...body }) => {
      const { jobId } = await gsr.post<{ jobId: string }>(
        `/projects/${projectId}/app-store/push`,
        { ...body, displaySlots },
      );
      const job = await pollPushJob(
        `/projects/${projectId}/app-store/push-jobs`,
        jobId,
        wait,
      );
      return text({ jobId, ...job, editorUrl: editorUrl(projectId) });
    },
  );

  server.tool(
    'get_app_store_push_job',
    'Get status of an App Store push job. Optionally wait until it completes.',
    {
      projectId: z.string().min(1),
      jobId: z.string().min(1),
      wait: z.boolean().default(false),
    },
    async ({ projectId, jobId, wait }) => {
      const job = await pollPushJob(
        `/projects/${projectId}/app-store/push-jobs`,
        jobId,
        wait,
      );
      return text(job);
    },
  );

  server.tool(
    'get_google_play_link',
    'Get Google Play Console link status for a project (credential, package name). ' +
      'Requires Premium/Pro. Set up credentials in the web UI first.',
    { projectId: z.string().min(1) },
    async ({ projectId }) => {
      const data = await gsr.get<{ link: unknown }>(`/projects/${projectId}/google-play/link`);
      return text({ ...data, editorUrl: editorUrl(projectId) });
    },
  );

  server.tool(
    'preview_google_play_push',
    'Review what would be pushed to Google Play — blockers, warnings, locale plans, and ' +
      'optional remote diff. Call before push_to_google_play.',
    {
      projectId: z.string().min(1),
      ...previewScope,
      includeAppIcon: z.boolean().optional(),
      displaySlots: z.array(playDisplaySlots).optional(),
    },
    async ({ projectId, fetchRemoteDiff, ...query }) => {
      const data = await gsr.getQuery<Record<string, unknown>>(
        `/projects/${projectId}/google-play/preview`,
        {
          ...query,
          locales: query.locales?.join(','),
          fetchRemoteDiff: fetchRemoteDiff ?? true,
          displaySlots: query.displaySlots?.join(','),
        },
      );
      return text(data);
    },
  );

  server.tool(
    'push_to_google_play',
    'Enqueue a Google Play push (listing, screenshots, app icon). Requires Premium/Pro and a linked app. ' +
      'Call preview_google_play_push first.',
    {
      projectId: z.string().min(1),
      ...pushBody,
      includeAppIcon: z.boolean().optional(),
      displaySlots: z.array(playDisplaySlots).optional(),
    },
    async ({ projectId, wait, displaySlots, ...body }) => {
      const { jobId } = await gsr.post<{ jobId: string }>(
        `/projects/${projectId}/google-play/push`,
        { ...body, displaySlots },
      );
      const job = await pollPushJob(
        `/projects/${projectId}/google-play/push-jobs`,
        jobId,
        wait,
      );
      return text({ jobId, ...job, editorUrl: editorUrl(projectId) });
    },
  );

  server.tool(
    'get_google_play_push_job',
    'Get status of a Google Play push job. Optionally wait until it completes.',
    {
      projectId: z.string().min(1),
      jobId: z.string().min(1),
      wait: z.boolean().default(false),
    },
    async ({ projectId, jobId, wait }) => {
      const job = await pollPushJob(
        `/projects/${projectId}/google-play/push-jobs`,
        jobId,
        wait,
      );
      return text(job);
    },
  );
}
