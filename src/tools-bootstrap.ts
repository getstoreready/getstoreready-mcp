import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { detectApp, discoverScreenshots } from './app-detect.js';
import { editorUrl, gsr } from './client.js';
import { listTextLayers } from './design-utils.js';
import { text } from './response.js';
import {
  orderedScreenshotScreens,
  type ProjectRow,
  type ScreenshotRow,
} from './screens.js';

interface TemplateRow {
  key: string;
  name: string;
  locked: boolean;
}

async function uploadPaths(paths: string[]): Promise<string[]> {
  const assetIds: string[] = [];
  for (const [i, p] of paths.entries()) {
    const buf = await readFile(p);
    const form = new FormData();
    form.append('file', new Blob([buf]), basename(p) || `screenshot-${i + 1}.png`);
    const { asset } = await gsr.upload<{ asset: { id: string } }>('/assets', form);
    assetIds.push(asset.id);
  }
  return assetIds;
}

async function pickTemplateKey(requested?: string): Promise<string> {
  if (requested && requested !== 'random') return requested;
  const { templates } = await gsr.get<{ templates: TemplateRow[] }>('/templates?kind=store_screenshot');
  const choices = templates.filter((t) => !t.locked);
  if (!choices.length) throw new Error('No unlocked templates available.');
  if (requested === 'random') {
    return choices[Math.floor(Math.random() * choices.length)]!.key;
  }
  return choices[0]!.key;
}

export function registerBootstrapTools(server: McpServer): void {
  server.tool(
    'detect_app',
    'Inspect a local mobile app repository and infer stack, app name, platforms, locales, and ' +
      'marketing-relevant screens (tabs/routes). Use before bootstrap_store_project.',
    {
      appRootPath: z
        .string()
        .min(1)
        .describe('Absolute or relative path to the app repo root'),
    },
    async ({ appRootPath }) => {
      const detection = await detectApp(appRootPath);
      return text(detection);
    },
  );

  server.tool(
    'discover_screenshots',
    'Find existing marketing/store screenshots under common folders (marketing/, fastlane/screenshots/, ' +
      'screenshots/, etc.) inside an app repo. Returns local file paths ready for upload_screenshots.',
    {
      appRootPath: z.string().min(1),
      max: z.number().int().min(1).max(20).optional().describe('Max images — default 7'),
      locale: z
        .string()
        .optional()
        .describe('Prefer images under this locale folder (e.g. en, en-US)'),
    },
    async ({ appRootPath, max, locale }) => {
      const shots = await discoverScreenshots(appRootPath, { max, locale });
      return text({
        count: shots.length,
        screenshots: shots,
        hint:
          shots.length === 0
            ? 'No images found — capture screenshots manually or use a capture workflow, then retry.'
            : 'Pass paths to bootstrap_store_project.screenshotPaths or upload_screenshots.',
      });
    },
  );

  server.tool(
    'bootstrap_store_project',
    'Create a GetStoreReady project from a local app repo: detect metadata, find screenshots, ' +
      'upload them, apply a template, and return screen text layers for copywriting. ' +
      'After this, use update_screen_text (and optionally update_listing) with marketing copy.',
    {
      appRootPath: z.string().min(1),
      projectName: z.string().trim().min(1).max(80).optional(),
      platforms: z.enum(['ios', 'android', 'both']).optional(),
      templateKey: z
        .string()
        .optional()
        .describe("Template key from list_templates, or omit/'random' for an unlocked pick"),
      screenshotPaths: z
        .array(z.string())
        .optional()
        .describe('Explicit local PNG paths — skips discover_screenshots when set'),
      maxScreenshots: z.number().int().min(1).max(7).optional(),
      locale: z
        .string()
        .optional()
        .describe('When auto-discovering, prefer this locale subfolder'),
    },
    async ({
      appRootPath,
      projectName,
      platforms,
      templateKey,
      screenshotPaths,
      maxScreenshots,
      locale,
    }) => {
      const detection = await detectApp(appRootPath);
      const name = projectName ?? detection.name ?? basename(appRootPath);
      const targetPlatforms = platforms ?? detection.platforms;

      const { project } = await gsr.post<{ project: ProjectRow }>('/projects', {
        name,
        platforms: targetPlatforms,
      });
      const projectId = project.id;

      const paths =
        screenshotPaths ??
        (
          await discoverScreenshots(appRootPath, {
            max: maxScreenshots ?? 7,
            locale,
          })
        ).map((s) => s.path);

      let assetIds: string[] = [];
      if (paths.length) assetIds = await uploadPaths(paths);

      const key = await pickTemplateKey(templateKey);
      const body: { templateKey: string; mode: 'pack'; assetIds?: string[] } = {
        templateKey: key,
        mode: 'pack',
      };
      if (assetIds.length) body.assetIds = assetIds;

      const { screenshots } = await gsr.post<{ screenshots: ScreenshotRow[] }>(
        `/projects/${projectId}/apply-template`,
        body,
      );

      const ordered = orderedScreenshotScreens(screenshots);
      const screens = ordered.map((shot, i) => ({
        screenIndex: i + 1,
        screenshotId: shot.id,
        suggestedSource:
          detection.screens[i]?.label ??
          paths[i]
            ? basename(paths[i]!)
            : null,
        textLayers: listTextLayers(shot.design),
      }));

      return text({
        projectId,
        editorUrl: editorUrl(projectId),
        detection: {
          stack: detection.stack,
          name: detection.name,
          platforms: detection.platforms,
          locales: detection.locales,
          suggestedScreens: detection.screens,
          notes: detection.notes,
        },
        appliedTemplateKey: key,
        uploadedScreenshotCount: assetIds.length,
        screenshotPaths: paths,
        screensCreated: screenshots.length,
        screens,
        nextSteps: [
          'Call get_screen_images if you need vision on placed screenshots.',
          'Call update_screen_text per screen using textLayers[].id — match copy to suggestedSource labels.',
          'Call get_listing / update_listing for App Store / Play metadata when ready.',
        ],
      });
    },
  );
}
