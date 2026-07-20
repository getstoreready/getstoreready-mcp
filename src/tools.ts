import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gsr, editorUrl } from './client.js';

function text(value: unknown) {
  const str = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text' as const, text: str }] };
}

interface ProjectRow {
  id: string;
  name: string;
  platforms: 'ios' | 'android' | 'both';
  defaultStoreLanguage: string;
  createdAt: string;
  updatedAt: string;
}

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

interface DesignLayer {
  id: string;
  type: string;
  assetId?: string | null;
  [key: string]: unknown;
}

interface DesignLike {
  layers?: DesignLayer[];
  [key: string]: unknown;
}

interface ScreenshotRow {
  id: string;
  order: number;
  kind: 'screenshot' | 'feature_graphic';
  design?: DesignLike | null;
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
                .describe('Local file path to the image — preferred, the server reads it directly'),
              data: z
                .string()
                .optional()
                .describe('Base64-encoded image bytes — only if a local path is not available'),
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
      'time (each placement also shows up live). Passing assetIds here instead bundles everything ' +
      'into one call, which is simpler for small batches but gives no incremental feedback and is ' +
      'less reliable for larger/more images.',
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
    'Place an already-uploaded image (an assetId from upload_screenshots) into a screen that ' +
      "already exists on a project — use this after apply_template to fill in a project's screens " +
      'one at a time. Each call shows up live in an already-open editor tab.',
    {
      projectId: z.string().min(1),
      screenIndex: z
        .number()
        .int()
        .min(1)
        .describe(
          "1-based position among the project's screenshot screens, in their current order",
        ),
      assetId: z.string().min(1).describe('Asset id returned by upload_screenshots'),
    },
    async ({ projectId, screenIndex, assetId }) => {
      const { screenshots } = await gsr.get<{ screenshots: ScreenshotRow[] }>(
        `/projects/${projectId}/screenshots`,
      );
      const screens = screenshots
        .filter((s) => s.kind === 'screenshot')
        .sort((a, b) => a.order - b.order);
      const target = screens[screenIndex - 1];
      if (!target) {
        throw new Error(
          `No screen at index ${screenIndex} — this project currently has ${screens.length} screen(s). Call apply_template first if it has none.`,
        );
      }
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
      await gsr.patch(`/screenshots/${target.id}`, { design });
      return text({
        screenIndex,
        screenshotId: target.id,
        editorUrl: editorUrl(projectId),
      });
    },
  );

  server.tool(
    'update_listing',
    'Update store listing / ASO text (app name, subtitle, description, keywords, etc.) for a project in one language.',
    {
      projectId: z.string().min(1),
      locale: z.string().min(2).describe('Store language code, e.g. en_US'),
      appName: z.string().optional(),
      subtitle: z.string().optional().describe('App Store subtitle'),
      promotionalText: z.string().optional().describe('App Store promotional text'),
      description: z.string().optional(),
      keywords: z.string().optional().describe('App Store keywords, comma-separated'),
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
    'get_project',
    'Get a summary of a project — name, platforms, screen count, and its editor URL.',
    { projectId: z.string().min(1) },
    async ({ projectId }) => {
      const [{ project }, { screenshots }] = await Promise.all([
        gsr.get<{ project: ProjectRow }>(`/projects/${projectId}`),
        gsr.get<{ screenshots: ScreenshotRow[] }>(`/projects/${projectId}/screenshots`),
      ]);
      return text({
        id: project.id,
        name: project.name,
        platforms: project.platforms,
        screenCount: screenshots.filter((s) => s.kind === 'screenshot').length,
        hasFeatureGraphic: screenshots.some((s) => s.kind === 'feature_graphic'),
        editorUrl: editorUrl(project.id),
      });
    },
  );
}
