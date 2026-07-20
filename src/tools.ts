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

interface ScreenshotRow {
  id: string;
  order: number;
  kind: 'screenshot' | 'feature_graphic';
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
      const { project } = await gsr.post<{ project: ProjectRow }>('/projects', { name, platforms });
      return text({ projectId: project.id, editorUrl: editorUrl(project.id) });
    },
  );

  server.tool(
    'upload_screenshots',
    'Upload one or more raw app screenshots. Not tied to a project yet — pass the returned ' +
      'assetIds, in order, to apply_template to place them into a template.',
    {
      images: z
        .array(
          z.object({
            data: z.string().describe('Base64-encoded image bytes (PNG/JPEG/WebP)'),
            filename: z.string().optional(),
          }),
        )
        .min(1)
        .max(20),
    },
    async ({ images }) => {
      const assetIds: string[] = [];
      for (const [i, img] of images.entries()) {
        const buf = Buffer.from(img.data, 'base64');
        const form = new FormData();
        form.append('file', new Blob([buf]), img.filename ?? `screenshot-${i + 1}.png`);
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
      'Pass assetIds (from upload_screenshots) to place those photos into the template in order.',
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
