import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiBase, assetUrl, editorUrl, gsr } from './client.js';
import {
  cloneDesign,
  deviceAssetId,
  listTextLayers,
  setBackground,
  setLayerText,
  type BackgroundInput,
  type DesignLike,
} from './design-utils.js';
import { mixed, text } from './response.js';
import {
  fetchProject,
  fetchScreenshots,
  orderedScreenshotScreens,
  patchScreenshotDesign,
  screenAtIndex,
  type ProjectRow,
  type ScreenshotRow,
} from './screens.js';

const LISTING_FIELDS = [
  'playAppName',
  'playShortDescription',
  'playDescription',
  'appName',
  'subtitle',
  'promotionalText',
  'description',
  'keywords',
] as const;

const backgroundSchema: z.ZodType<BackgroundInput> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('solid'),
    color: z.string().describe('CSS color, e.g. #ffffff'),
  }),
  z.object({
    type: z.literal('gradient'),
    angle: z.number().optional(),
    stops: z.array(z.object({ color: z.string(), at: z.number() })).min(2),
  }),
  z.object({
    type: z.literal('image'),
    assetId: z.string(),
    fit: z.enum(['cover', 'contain']).optional(),
    split: z.boolean().optional(),
    posX: z.number().min(0).max(1).optional(),
    posY: z.number().min(0).max(1).optional(),
  }),
]);

interface TemplateRow {
  key: string;
  name: string;
  tier: 'free' | 'premium';
  locked: boolean;
  owned: boolean;
  price: number | null;
  excerpt: string | null;
  data: { screens?: unknown[] } | null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveScreens(
  projectId: string,
  locale: string | undefined,
  screenIndices?: number[],
): Promise<{
  locale: string;
  all: ScreenshotRow[];
  targets: Array<{ screenIndex: number; shot: ScreenshotRow }>;
}> {
  const { locale: loc, screenshots } = await fetchScreenshots(projectId, locale);
  const ordered = orderedScreenshotScreens(screenshots);
  const indices =
    screenIndices?.length && screenIndices.length > 0
      ? screenIndices
      : ordered.map((_, i) => i + 1);
  const targets = indices.map((screenIndex) => ({
    screenIndex,
    shot: screenAtIndex(screenshots, screenIndex),
  }));
  return { locale: loc, all: screenshots, targets };
}

export function registerTools(server: McpServer): void {
  server.tool(
    'list_projects',
    "List the authenticated user's GetStoreReady projects.",
    {},
    async () => {
      const { projects } = await gsr.get<{ projects: ProjectRow[] }>('/projects');
      return text(
        projects.map((p) => ({
          id: p.id,
          name: p.name,
          platforms: p.platforms,
          updatedAt: p.updatedAt,
          editorUrl: editorUrl(p.id),
        })),
      );
    },
  );

  server.tool(
    'create_project',
    'Create a new GetStoreReady project. Returns its id and editor URL.',
    {
      name: z.string().trim().min(1).max(80).describe('Project name'),
      platforms: z
        .enum(['ios', 'android', 'both'])
        .optional()
        .describe('Which store(s) this project targets — defaults to both'),
    },
    async ({ name, platforms }) => {
      const { project } = await gsr.post<{ project: ProjectRow }>('/projects', {
        name,
        platforms,
      });
      return text({ projectId: project.id, editorUrl: editorUrl(project.id) });
    },
  );

  server.tool(
    'get_project',
    'Get a summary of a project — name, platforms, screen count, store languages, and editor URL.',
    { projectId: z.string().min(1) },
    async ({ projectId }) => {
      const [project, { screenshots }] = await Promise.all([
        fetchProject(projectId),
        fetchScreenshots(projectId),
      ]);
      return text({
        id: project.id,
        name: project.name,
        platforms: project.platforms,
        defaultStoreLanguage: project.defaultStoreLanguage,
        storeLanguages: project.storeLocales?.map((l) => l.languageCode) ?? [
          project.defaultStoreLanguage,
        ],
        screenCount: orderedScreenshotScreens(screenshots).length,
        hasFeatureGraphic: screenshots.some((s) => s.kind === 'feature_graphic'),
        editorUrl: editorUrl(projectId),
      });
    },
  );

  server.tool(
    'get_screens',
    'List screenshot screens on a project with text layer ids, current copy, and device image asset ids. ' +
      'Use this before update_screen_text or when planning copy from screenshots.',
    {
      projectId: z.string().min(1),
      locale: z
        .string()
        .min(2)
        .optional()
        .describe('Store language code — defaults to the project default'),
    },
    async ({ projectId, locale }) => {
      const { locale: loc, screenshots } = await fetchScreenshots(projectId, locale);
      const screens = orderedScreenshotScreens(screenshots).map((shot, i) => ({
        screenIndex: i + 1,
        screenshotId: shot.id,
        templateKey: shot.templateKey ?? null,
        textLayers: listTextLayers(shot.design),
        deviceAssetId: deviceAssetId(shot.design),
        deviceAssetUrl: deviceAssetId(shot.design)
          ? assetUrl(deviceAssetId(shot.design)!)
          : null,
      }));
      return text({ projectId, locale: loc, screens, editorUrl: editorUrl(projectId) });
    },
  );

  server.tool(
    'get_screen_images',
    'Return raw app screenshot images (device layer assets) as vision input for the host AI. ' +
      'Use with your client vision to read UI content, then call update_screen_text. ' +
      'Also returns a JSON index mapping images to screen indices.',
    {
      projectId: z.string().min(1),
      locale: z.string().min(2).optional(),
      screenIndices: z
        .array(z.number().int().min(1))
        .optional()
        .describe('1-based indices — omit for all screens'),
    },
    async ({ projectId, locale, screenIndices }) => {
      const { locale: loc, targets } = await resolveScreens(projectId, locale, screenIndices);
      const index: Array<{
        screenIndex: number;
        screenshotId: string;
        assetId: string;
        assetUrl: string;
      }> = [];
      const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];

      for (const { screenIndex, shot } of targets) {
        const assetId = deviceAssetId(shot.design);
        if (!assetId) continue;
        const buf = await gsr.download(`/assets/${assetId}`);
        const mimeType = assetId.endsWith('.jpg') ? 'image/jpeg' : 'image/png';
        images.push({
          type: 'image',
          data: buf.toString('base64'),
          mimeType,
        });
        index.push({
          screenIndex,
          screenshotId: shot.id,
          assetId,
          assetUrl: assetUrl(assetId),
        });
      }

      if (!images.length) {
        throw new Error(
          'No device screenshot images found — apply a template and place_screenshot_image first.',
        );
      }

      return mixed([
        {
          type: 'text',
          text: JSON.stringify(
            {
              projectId,
              locale: loc,
              hint: 'Images follow in order matching the index array. Use vision to read them, then update_screen_text.',
              index,
              editorUrl: editorUrl(projectId),
            },
            null,
            2,
          ),
        },
        ...images,
      ]);
    },
  );

  server.tool(
    'upload_screenshots',
    'Upload one or more raw app screenshots. Prefer "path" (a local file path — the server reads ' +
      'it directly, no base64 round-trip through the tool call) over "data" (base64), which is only ' +
      'a fallback for images that do not exist as a local file. Not tied to a project yet — pass the ' +
      'returned assetIds to apply_template or place_screenshot_image.',
    {
      images: z
        .array(
          z
            .object({
              path: z
                .string()
                .optional()
                .describe('Local file path to the image — preferred'),
              data: z.string().optional().describe('Base64-encoded image bytes — fallback only'),
              filename: z.string().optional(),
            })
            .refine((img) => !!img.path || !!img.data, {
              message: 'Provide either "path" or "data"',
            }),
        )
        .min(1)
        .max(20),
    },
    async ({ images }) => {
      const assetIds: string[] = [];
      for (const [i, img] of images.entries()) {
        let buf: Buffer;
        let name = img.filename;
        if (img.path) {
          buf = await readFile(img.path);
          name ??= basename(img.path);
        } else {
          buf = Buffer.from(img.data as string, 'base64');
          name ??= `screenshot-${i + 1}.png`;
        }
        const form = new FormData();
        form.append('file', new Blob([buf]), name);
        const { asset } = await gsr.upload<{ asset: { id: string } }>('/assets', form);
        assetIds.push(asset.id);
      }
      return text({ assetIds });
    },
  );

  server.tool(
    'list_templates',
    "List available templates with this user's actual owned/locked state.",
    {},
    async () => {
      const { templates } = await gsr.get<{ templates: TemplateRow[] }>(
        '/templates?kind=store_screenshot',
      );
      return text(
        templates.map((t) => ({
          key: t.key,
          name: t.name,
          tier: t.tier,
          locked: t.locked,
          owned: t.owned,
          price: t.price,
          excerpt: t.excerpt,
          screenCount: t.data?.screens?.length ?? 0,
        })),
      );
    },
  );

  server.tool(
    'apply_template',
    "Apply a template to a project, either by its exact key or 'random' to pick any unlocked one. " +
      'RECOMMENDED FLOW: call this WITHOUT assetIds first — it applies instantly with the ' +
      "template's own placeholder content and shows up live in an already-open editor tab. Then " +
      'call upload_screenshots + place_screenshot_image to fill in real photos one screen at a ' +
      'time (each placement also shows up live).',
    {
      projectId: z.string().min(1),
      templateKey: z
        .string()
        .min(1)
        .describe("A template key from list_templates, or the literal string 'random'"),
      assetIds: z.array(z.string()).min(1).max(7).optional(),
    },
    async ({ projectId, templateKey, assetIds }) => {
      let key = templateKey;
      if (key === 'random') {
        const { templates } = await gsr.get<{ templates: TemplateRow[] }>(
          '/templates?kind=store_screenshot',
        );
        const choices = templates.filter((t) => !t.locked);
        const pick = choices[Math.floor(Math.random() * choices.length)];
        if (!pick) throw new Error('No unlocked templates available to pick randomly from.');
        key = pick.key;
      }
      const { screenshots } = await gsr.post<{ screenshots: ScreenshotRow[] }>(
        `/projects/${projectId}/apply-template`,
        { templateKey: key, mode: 'pack', assetIds },
      );
      return text({
        appliedTemplateKey: key,
        screensCreated: screenshots.length,
        editorUrl: editorUrl(projectId),
      });
    },
  );

  server.tool(
    'place_screenshot_image',
    'Place an already-uploaded image into a screen that already exists on a project. ' +
      'Each call shows up live in an already-open editor tab.',
    {
      projectId: z.string().min(1),
      screenIndex: z.number().int().min(1).describe('1-based screen position'),
      assetId: z.string().min(1).describe('Asset id from upload_screenshots'),
    },
    async ({ projectId, screenIndex, assetId }) => {
      const { screenshots } = await fetchScreenshots(projectId);
      const target = screenAtIndex(screenshots, screenIndex);
      const design: DesignLike = target.design ?? { layers: [] };
      const layers = Array.isArray(design.layers) ? design.layers : [];
      const targetLayer =
        layers.find((l) => l.type === 'device') ?? layers.find((l) => l.type === 'image');
      if (!targetLayer) {
        throw new Error(
          `Screen ${screenIndex} has no device or image layer to place this asset into.`,
        );
      }
      targetLayer.assetId = assetId;
      await patchScreenshotDesign(target.id, design);
      return text({
        screenIndex,
        screenshotId: target.id,
        editorUrl: editorUrl(projectId),
      });
    },
  );

  server.tool(
    'update_screen_text',
    'Update the marketing headline/body text on one screen (template text layer, not in-app UI text). ' +
      'Use get_screens to find layerId values. Live-updates an open editor tab.',
    {
      projectId: z.string().min(1),
      screenIndex: z.number().int().min(1),
      layerId: z.string().min(1).describe('Text layer id from get_screens'),
      text: z.string().describe('New copy for this layer'),
      locale: z.string().min(2).optional(),
    },
    async ({ projectId, screenIndex, layerId, text: newText, locale }) => {
      const { locale: loc, screenshots } = await fetchScreenshots(projectId, locale);
      const target = screenAtIndex(screenshots, screenIndex);
      const design = target.design ?? { layers: [] };
      const next = setLayerText(design, layerId, newText);
      await patchScreenshotDesign(target.id, next, loc);
      return text({
        screenIndex,
        layerId,
        text: newText,
        locale: loc,
        editorUrl: editorUrl(projectId),
      });
    },
  );

  server.tool(
    'update_screen_design',
    'Update one screen design — background color/gradient and/or multiple text layers at once.',
    {
      projectId: z.string().min(1),
      screenIndex: z.number().int().min(1),
      locale: z.string().min(2).optional(),
      background: backgroundSchema.optional(),
      textUpdates: z
        .array(
          z.object({
            layerId: z.string().min(1),
            text: z.string(),
          }),
        )
        .optional(),
    },
    async ({ projectId, screenIndex, locale, background, textUpdates }) => {
      if (!background && !textUpdates?.length) {
        throw new Error('Provide at least one of background or textUpdates.');
      }
      const { locale: loc, screenshots } = await fetchScreenshots(projectId, locale);
      const target = screenAtIndex(screenshots, screenIndex);
      let next = cloneDesign(target.design ?? { layers: [] });
      if (background) next = setBackground(next, background);
      for (const u of textUpdates ?? []) {
        next = setLayerText(next, u.layerId, u.text);
      }
      await patchScreenshotDesign(target.id, next, loc);
      return text({
        screenIndex,
        locale: loc,
        updated: {
          background: !!background,
          textLayers: textUpdates?.length ?? 0,
        },
        editorUrl: editorUrl(projectId),
      });
    },
  );

  server.tool(
    'bulk_update_designs',
    'Apply the same background (e.g. white) and/or text updates across multiple or all screens. ' +
      'Example: set every screen background to solid white.',
    {
      projectId: z.string().min(1),
      locale: z.string().min(2).optional(),
      screenIndices: z.array(z.number().int().min(1)).optional().describe('Omit = all screens'),
      background: backgroundSchema.optional(),
      textUpdates: z
        .array(
          z.object({
            layerId: z.string().min(1),
            text: z.string(),
          }),
        )
        .optional()
        .describe('Same layer id applied on every targeted screen (e.g. a shared headline layer id)'),
    },
    async ({ projectId, locale, screenIndices, background, textUpdates }) => {
      if (!background && !textUpdates?.length) {
        throw new Error('Provide at least one of background or textUpdates.');
      }
      const { locale: loc, targets } = await resolveScreens(projectId, locale, screenIndices);
      const updated: number[] = [];
      for (const { screenIndex, shot } of targets) {
        let next = cloneDesign(shot.design ?? { layers: [] });
        if (background) next = setBackground(next, background);
        for (const u of textUpdates ?? []) {
          next = setLayerText(next, u.layerId, u.text);
        }
        await patchScreenshotDesign(shot.id, next, loc);
        updated.push(screenIndex);
      }
      return text({
        locale: loc,
        screensUpdated: updated,
        editorUrl: editorUrl(projectId),
      });
    },
  );

  server.tool(
    'list_store_languages',
    'List active and available store languages for a project.',
    { projectId: z.string().min(1) },
    async ({ projectId }) => {
      const data = await gsr.get<{
        active: Array<{ languageCode: string; isPrimary: boolean }>;
        available: Array<{ code: string; name: string }>;
      }>(`/projects/${projectId}/store-languages`);
      return text(data);
    },
  );

  server.tool(
    'add_store_language',
    'Add one or more store languages to a project (e.g. de_DE for German). Does not translate — call translate_project after.',
    {
      projectId: z.string().min(1),
      languageCode: z
        .string()
        .min(2)
        .optional()
        .describe('Single code, e.g. de_DE'),
      languageCodes: z
        .array(z.string().min(2))
        .min(1)
        .max(50)
        .optional()
        .describe('Batch add multiple codes'),
    },
    async ({ projectId, languageCode, languageCodes }) => {
      const codes = languageCodes ?? (languageCode ? [languageCode] : []);
      if (!codes.length) throw new Error('Provide languageCode or languageCodes.');
      if (codes.length === 1) {
        await gsr.post(`/projects/${projectId}/store-languages`, {
          languageCode: codes[0],
        });
      } else {
        await gsr.post(`/projects/${projectId}/store-languages/batch`, { languageCodes: codes });
      }
      const langs = await gsr.get<{
        active: Array<{ languageCode: string; isPrimary: boolean }>;
        available: Array<{ code: string; name: string }>;
      }>(`/projects/${projectId}/store-languages`);
      return text({ added: codes, ...langs });
    },
  );

  server.tool(
    'get_listing',
    'Get store listing / ASO text for a project in one locale.',
    {
      projectId: z.string().min(1),
      locale: z.string().min(2).describe('Store language code, e.g. en_US'),
    },
    async ({ projectId, locale }) => {
      const { listing } = await gsr.get<{ listing: unknown }>(
        `/projects/${projectId}/listing/${locale}`,
      );
      return text(listing);
    },
  );

  server.tool(
    'update_listing',
    'Update store listing / ASO text for a project in one language.',
    {
      projectId: z.string().min(1),
      locale: z.string().min(2).describe('Store language code, e.g. en_US'),
      appName: z.string().optional(),
      subtitle: z.string().optional(),
      promotionalText: z.string().optional(),
      description: z.string().optional(),
      keywords: z.string().optional(),
      playAppName: z.string().optional(),
      playShortDescription: z.string().optional(),
      playDescription: z.string().optional(),
    },
    async ({ projectId, locale, ...fields }) => {
      const { listing } = await gsr.patch<{ listing: unknown }>(
        `/projects/${projectId}/listing/${locale}`,
        fields,
      );
      return text(listing);
    },
  );

  server.tool(
    'get_ai_credits',
    'Check AI credit balance and whether translation is available.',
    {},
    async () => {
      const [credits, status] = await Promise.all([
        gsr.get<{ balance: number; granted?: number }>('/ai/credits'),
        gsr.get<{ ready: boolean; defaultModel: unknown }>('/ai/translate-status'),
      ]);
      return text({ ...credits, translate: status });
    },
  );

  server.tool(
    'estimate_translation',
    'Estimate AI credit cost before translating listing copy and/or screen text. ' +
      'Always call this before translate_project when credits matter.',
    {
      projectId: z.string().min(1),
      fromLanguage: z.string().min(2),
      toLanguage: z.string().min(2),
      includeListing: z.boolean().optional().describe('Include store listing fields'),
      includeDesigns: z.boolean().optional().describe('Include screenshot text layers — default true'),
      onlyStale: z
        .boolean()
        .optional()
        .describe('Only strings changed since the last translate run'),
      screens: z
        .array(z.number().int().min(0))
        .optional()
        .describe('0-based screenshot indices to include'),
      listingFields: z.array(z.enum(LISTING_FIELDS)).optional(),
    },
    async ({
      projectId,
      fromLanguage,
      toLanguage,
      includeListing,
      includeDesigns,
      onlyStale,
      screens,
      listingFields,
    }) => {
      const estimate = await gsr.getQuery<Record<string, unknown>>(
        `/projects/${projectId}/translate-estimate`,
        {
          from: fromLanguage,
          to: toLanguage,
          includeListing,
          includeDesigns,
          onlyStale,
          screens: screens?.join(','),
          listingFields: listingFields?.join(','),
        },
      );
      return text(estimate);
    },
  );

  server.tool(
    'translate_project',
    'AI-translate store listing copy and/or screenshot text layers between store languages. ' +
      'Deducts AI credits. Call estimate_translation first. Requires a registered account (not guest).',
    {
      projectId: z.string().min(1),
      fromLanguage: z.string().min(2),
      toLanguage: z.string().min(2),
      includeListing: z.boolean().default(false),
      includeDesigns: z.boolean().default(true),
      fitText: z.boolean().default(true).describe('Shrink font size when translated copy is longer'),
      onlyStale: z.boolean().default(false),
      screens: z.array(z.number().int().min(0)).optional(),
      listingFields: z.array(z.enum(LISTING_FIELDS)).optional(),
      modelId: z.string().optional(),
    },
    async (body) => {
      const result = await gsr.post(`/projects/${body.projectId}/translate`, body);
      return text(result);
    },
  );

  server.tool(
    'export_project',
    'Enqueue a PNG/ZIP export for the project. Optionally wait for completion and save locally.',
    {
      projectId: z.string().min(1),
      locales: z
        .array(z.string().min(2))
        .optional()
        .describe('Store languages to export — defaults to all active project languages'),
      slots: z
        .array(z.string())
        .optional()
        .describe('Device slots — defaults to project enabledDeviceSlots'),
      wait: z.boolean().default(true).describe('Poll until the export job completes'),
      savePath: z
        .string()
        .optional()
        .describe('Local path to save the ZIP when wait=true (e.g. /tmp/export.zip)'),
    },
    async ({ projectId, locales, slots, wait, savePath }) => {
      const project = await fetchProject(projectId);
      const exportLocales =
        locales ??
        project.storeLocales?.map((l) => l.languageCode) ?? [project.defaultStoreLanguage];
      const exportSlots = slots ?? project.enabledDeviceSlots ?? ['iphone-6.9', 'android-phone'];

      const { jobId } = await gsr.post<{ jobId: string }>(`/projects/${projectId}/export`, {
        locales: exportLocales,
        slots: exportSlots,
      });

      if (!wait) {
        return text({
          jobId,
          statusUrl: `${apiBase()}/export-jobs/${jobId}`,
          editorUrl: editorUrl(projectId),
        });
      }

      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        const job = await gsr.get<{
          id: string;
          state: string;
          count?: number;
          downloadUrl?: string;
          error?: string;
        }>(`/export-jobs/${jobId}`);
        if (job.state === 'completed') {
          const downloadPath = `/export-jobs/${jobId}/download`;
          const fullUrl = `${apiBase()}${downloadPath}`;
          let savedTo: string | undefined;
          if (savePath) {
            const buf = await gsr.download(downloadPath);
            await writeFile(savePath, buf);
            savedTo = savePath;
          }
          return text({
            jobId,
            state: job.state,
            count: job.count,
            downloadUrl: fullUrl,
            savedTo,
            note: 'Download requires Authorization: Bearer GSR_API_KEY unless savedTo is set.',
            editorUrl: editorUrl(projectId),
          });
        }
        if (job.state === 'failed') {
          throw new Error(job.error ?? 'Export job failed.');
        }
        await sleep(2000);
      }
      throw new Error('Export timed out after 3 minutes — poll /export-jobs/' + jobId);
    },
  );
}
