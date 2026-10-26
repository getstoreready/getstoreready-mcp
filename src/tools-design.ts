import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { editorUrl, gsr } from './client.js';
import { cloneDesign, type DesignLayer, type DesignLike } from './design-utils.js';
import { mixed, text, type McpContent } from './response.js';
import {
  fetchProject,
  fetchScreenshots,
  orderedScreenshotScreens,
  patchScreenshotDesign,
  type ScreenshotRow,
} from './screens.js';

// Full-design editing: everything the web editor can do is a field of the
// screen Design JSON, so these tools read/write that JSON directly. The field
// vocabulary is NOT hardcoded here — it comes from the API's /design/catalog
// (JSON Schema + presets + defaults), and the API validates every write.

interface DesignCatalog {
  version: string;
  layerTypes: string[];
  layerDefaults: Record<string, DesignLayer>;
  deviceModels: string[];
  deviceViewPresets: Array<{ key: string; label: string; tilt: number; lean: number; rot: number }>;
  slots: Array<{ key: string; width: number; height: number; userToggle: boolean; label?: string }>;
  fonts: string[];
  googleFonts: string[];
  icons: string[];
  patternKinds: string[];
  designSchema: unknown;
  guide: string;
}

let catalogCache: DesignCatalog | null = null;
async function fetchCatalog(): Promise<DesignCatalog> {
  catalogCache ??= await gsr.get<DesignCatalog>('/design/catalog');
  return catalogCache;
}

// A screen is addressed by its 1-based position among store screenshots, by
// `featureGraphic: true`, or by its raw screenshotId.
const screenRef = {
  screenIndex: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('1-based screenshot position (ignored when screenshotId / featureGraphic is set)'),
  screenshotId: z.string().min(1).optional(),
  featureGraphic: z
    .boolean()
    .optional()
    .describe('Target the Play feature graphic instead of a screenshot'),
};

type ScreenRefInput = { screenIndex?: number; screenshotId?: string; featureGraphic?: boolean };

function pickScreen(screenshots: ScreenshotRow[], ref: ScreenRefInput): ScreenshotRow {
  if (ref.screenshotId) {
    const s = screenshots.find((x) => x.id === ref.screenshotId);
    if (!s) throw new Error(`No screen with screenshotId ${ref.screenshotId} on this project.`);
    return s;
  }
  if (ref.featureGraphic) {
    const fg = screenshots.find((x) => x.kind === 'feature_graphic');
    if (!fg)
      throw new Error(
        'This project has no feature graphic yet — add_screen with kind "feature_graphic".',
      );
    return fg;
  }
  if (!ref.screenIndex) throw new Error('Pass screenIndex, screenshotId or featureGraphic.');
  const screens = orderedScreenshotScreens(screenshots);
  const s = screens[ref.screenIndex - 1];
  if (!s) {
    throw new Error(
      `No screen at index ${ref.screenIndex} — this project has ${screens.length} screenshot screen(s).`,
    );
  }
  return s;
}

async function loadScreen(projectId: string, ref: ScreenRefInput, locale?: string) {
  const { locale: loc, screenshots } = await fetchScreenshots(projectId, locale);
  const shot = pickScreen(screenshots, ref);
  const design: DesignLike = cloneDesign(
    shot.design ?? { version: 1, background: { type: 'solid', color: '#ffffff' }, layers: [] },
  );
  design.layers ??= [];
  return { locale: loc, shot, design, screenshots };
}

function screenIndexOf(screenshots: ScreenshotRow[], shot: ScreenshotRow): number | null {
  if (shot.kind === 'feature_graphic') return null;
  return orderedScreenshotScreens(screenshots).findIndex((s) => s.id === shot.id) + 1;
}

function layerSummary(design: DesignLike) {
  return (design.layers ?? []).map((l, i) => ({
    z: i,
    id: l.id,
    type: l.type,
    ...(typeof l.text === 'string' ? { text: l.text.slice(0, 60) } : {}),
    ...(l.groupId ? { groupId: l.groupId } : {}),
    ...(l.overrides && Object.keys(l.overrides).length
      ? { overrides: Object.keys(l.overrides) }
      : {}),
  }));
}

function findLayer(design: DesignLike, id: string): { layer: DesignLayer; index: number } {
  const index = (design.layers ?? []).findIndex((l) => l.id === id);
  if (index < 0) throw new Error(`No layer with id "${id}" on this screen.`);
  return { layer: design.layers![index]!, index };
}

const layerOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add'),
    layer: z
      .record(z.unknown())
      .describe(
        'Layer fields; must include "type". Missing fields take the catalog layerDefaults; id is generated when omitted.',
      ),
    index: z.number().int().min(0).optional().describe('z-position (default: on top)'),
  }),
  z.object({
    op: z.literal('update'),
    layerId: z.string(),
    patch: z
      .record(z.unknown())
      .describe('Shallow-merged into the layer. Set a key to null to remove it.'),
  }),
  z.object({ op: z.literal('remove'), layerId: z.string() }),
  z.object({
    op: z.literal('move'),
    layerId: z.string(),
    toIndex: z.number().int().min(0).describe('New z-position (0 = bottom)'),
  }),
  z.object({
    op: z.literal('duplicate'),
    layerId: z.string(),
    patch: z.record(z.unknown()).optional().describe('Fields to change on the copy'),
  }),
  z.object({
    op: z.literal('set_override'),
    layerId: z.string(),
    slot: z.string().describe('Device slot key, e.g. "ipad-13", "android-phone"'),
    override: z
      .record(z.unknown())
      .nullable()
      .describe('Merged into the existing slot override; null clears this slot override'),
  }),
  z.object({
    op: z.literal('group'),
    layerIds: z.array(z.string()).min(2),
    groupId: z.string().optional(),
  }),
  z.object({ op: z.literal('ungroup'), layerIds: z.array(z.string()).min(1) }),
]);
type LayerOp = z.infer<typeof layerOp>;

function mergePatch<T extends Record<string, unknown>>(
  target: T,
  patch: Record<string, unknown>,
): T {
  const out: Record<string, unknown> = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out as T;
}

function applyOp(design: DesignLike, op: LayerOp, catalog: DesignCatalog): string | undefined {
  const layers = (design.layers ??= []);
  switch (op.op) {
    case 'add': {
      const type = op.layer.type;
      if (typeof type !== 'string' || !catalog.layerDefaults[type]) {
        throw new Error(
          `add: unknown layer type ${JSON.stringify(type)} (have: ${catalog.layerTypes.join(', ')})`,
        );
      }
      const layer = {
        ...catalog.layerDefaults[type],
        ...op.layer,
        id: typeof op.layer.id === 'string' ? op.layer.id : randomUUID(),
      } as DesignLayer;
      if (layers.some((l) => l.id === layer.id))
        throw new Error(`add: layer id "${layer.id}" exists`);
      layers.splice(op.index ?? layers.length, 0, layer);
      return layer.id;
    }
    case 'update': {
      const { layer, index } = findLayer(design, op.layerId);
      if ('id' in op.patch || 'type' in op.patch) throw new Error('update: id/type cannot change');
      layers[index] = mergePatch(layer, op.patch);
      return op.layerId;
    }
    case 'remove': {
      layers.splice(findLayer(design, op.layerId).index, 1);
      return op.layerId;
    }
    case 'move': {
      const { layer, index } = findLayer(design, op.layerId);
      layers.splice(index, 1);
      layers.splice(Math.min(op.toIndex, layers.length), 0, layer);
      return op.layerId;
    }
    case 'duplicate': {
      const { layer, index } = findLayer(design, op.layerId);
      const copy = mergePatch(JSON.parse(JSON.stringify(layer)) as DesignLayer, op.patch ?? {});
      copy.id = randomUUID();
      layers.splice(index + 1, 0, copy);
      return copy.id;
    }
    case 'set_override': {
      const { layer } = findLayer(design, op.layerId);
      const overrides = { ...(layer.overrides ?? {}) };
      if (op.override === null) delete overrides[op.slot];
      else overrides[op.slot] = mergePatch(overrides[op.slot] ?? {}, op.override);
      layer.overrides = overrides;
      if (!Object.keys(overrides).length) delete layer.overrides;
      return op.layerId;
    }
    case 'group': {
      const groupId = op.groupId ?? randomUUID();
      for (const id of op.layerIds) findLayer(design, id).layer.groupId = groupId;
      return groupId;
    }
    case 'ungroup': {
      for (const id of op.layerIds) delete findLayer(design, id).layer.groupId;
      return undefined;
    }
  }
}

async function renderPreviews(
  screenshotId: string,
  slots: string[],
  locale: string | undefined,
  scale: number | undefined,
): Promise<McpContent[]> {
  const out: McpContent[] = [];
  for (const slot of slots) {
    const r = await gsr.post<{ mimeType: string; data: string; width: number; height: number }>(
      `/screenshots/${screenshotId}/preview`,
      { slot, locale, scale },
      120_000,
    );
    out.push({ type: 'text', text: `${slot} — ${r.width}×${r.height}` });
    out.push({ type: 'image', data: r.data, mimeType: r.mimeType });
  }
  return out;
}

/** Default preview slots: the project's enabled phone/tablet slots. */
async function defaultSlots(projectId: string, shot: ScreenshotRow): Promise<string[]> {
  if (shot.kind === 'feature_graphic') return ['feature-graphic'];
  const project = await fetchProject(projectId);
  const enabled = (project.enabledDeviceSlots ?? []).filter(
    (s) => s !== 'feature-graphic' && s !== 'app-icon',
  );
  return enabled.length ? enabled.slice(0, 4) : ['iphone-6.3'];
}

export function registerDesignTools(server: McpServer): void {
  server.resource(
    'design-guide',
    'gsr://design-guide',
    {
      description:
        'How the GetStoreReady design model works (canvas, layers, 3D device poses, overrides, panorama) plus creative recipes.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: (await fetchCatalog()).guide }],
    }),
  );

  server.tool(
    'get_design_catalog',
    'START HERE before designing. Returns the full GetStoreReady design vocabulary: a design guide ' +
      '(layers, coordinates, 3D device views, per-device overrides, panorama, recipes), the JSON ' +
      'Schema of a screen Design, defaults for every layer type, device models + view presets, ' +
      'slot sizes, fonts and icon names. Everything the web editor can do is in here.',
    {
      include: z
        .array(
          z.enum([
            'guide',
            'schema',
            'defaults',
            'presets',
            'slots',
            'fonts',
            'icons',
            'googleFonts',
          ]),
        )
        .optional()
        .describe(
          'Sections to return (default: all except googleFonts — the full 1900-family list)',
        ),
    },
    async ({ include }) => {
      const c = await fetchCatalog();
      const want = new Set(
        include ?? ['guide', 'schema', 'defaults', 'presets', 'slots', 'fonts', 'icons'],
      );
      return text({
        version: c.version,
        layerTypes: c.layerTypes,
        ...(want.has('guide') ? { guide: c.guide } : {}),
        ...(want.has('schema') ? { designSchema: c.designSchema } : {}),
        ...(want.has('defaults') ? { layerDefaults: c.layerDefaults } : {}),
        ...(want.has('presets')
          ? {
              deviceModels: c.deviceModels,
              deviceViewPresets: c.deviceViewPresets,
              patternKinds: c.patternKinds,
            }
          : {}),
        ...(want.has('slots') ? { slots: c.slots } : {}),
        ...(want.has('fonts') ? { fonts: c.fonts } : {}),
        ...(want.has('icons') ? { icons: c.icons } : {}),
        ...(want.has('googleFonts') ? { googleFonts: c.googleFonts } : {}),
      });
    },
  );

  server.tool(
    'get_screen_design',
    'Read the complete Design JSON of one screen (background, backgroundOverrides, every layer with ' +
      'all fields and per-device overrides). Designs are stored per store language — pass locale to ' +
      'read a translation; default is the project default language.',
    { projectId: z.string().min(1), ...screenRef, locale: z.string().min(2).optional() },
    async ({ projectId, locale, ...ref }) => {
      const { locale: loc, shot, design, screenshots } = await loadScreen(projectId, ref, locale);
      return text({
        screenshotId: shot.id,
        screenIndex: screenIndexOf(screenshots, shot),
        kind: shot.kind,
        templateKey: shot.templateKey ?? null,
        locale: loc,
        design,
        editorUrl: editorUrl(projectId),
      });
    },
  );

  server.tool(
    'set_screen_design',
    "Replace one screen's whole Design JSON ({ version: 1, background, backgroundOverrides?, layers }). " +
      'Use for a from-scratch design; for small changes prefer edit_layers. The API validates it ' +
      'against the catalog schema (errors name the bad field). Shows up live in an open editor tab.',
    {
      projectId: z.string().min(1),
      ...screenRef,
      locale: z.string().min(2).optional(),
      design: z.record(z.unknown()).describe('Full Design object'),
    },
    async ({ projectId, locale, design, ...ref }) => {
      const { locale: loc, shot, screenshots } = await loadScreen(projectId, ref, locale);
      const next = { version: 1, ...design } as DesignLike;
      for (const l of (next.layers ?? []) as DesignLayer[]) l.id ??= randomUUID();
      await patchScreenshotDesign(shot.id, next, loc);
      return text({
        screenshotId: shot.id,
        screenIndex: screenIndexOf(screenshots, shot),
        locale: loc,
        layers: layerSummary(next),
        hint: 'Call render_preview to check the result.',
        editorUrl: editorUrl(projectId),
      });
    },
  );

  server.tool(
    'edit_layers',
    'Apply a list of layer operations to one screen in a single save: add (missing fields from ' +
      'catalog defaults), update (shallow patch), remove, move (z-order), duplicate, set_override ' +
      '(per-device-slot tweaks, e.g. bigger text on ipad-13), group, ungroup. Optionally also set ' +
      'the background. Returns the resulting layer list with ids.',
    {
      projectId: z.string().min(1),
      ...screenRef,
      locale: z.string().min(2).optional(),
      ops: z.array(layerOp).min(1).max(50),
    },
    async ({ projectId, locale, ops, ...ref }) => {
      const catalog = await fetchCatalog();
      const { locale: loc, shot, design, screenshots } = await loadScreen(projectId, ref, locale);
      const results = ops.map((op, i) => {
        try {
          return { op: op.op, id: applyOp(design, op, catalog) };
        } catch (err) {
          throw new Error(`ops[${i}] (${op.op}): ${(err as Error).message}`);
        }
      });
      await patchScreenshotDesign(shot.id, design, loc);
      return text({
        screenshotId: shot.id,
        screenIndex: screenIndexOf(screenshots, shot),
        locale: loc,
        results,
        layers: layerSummary(design),
        editorUrl: editorUrl(projectId),
      });
    },
  );

  server.tool(
    'set_background',
    'Set the background of one or more screens (solid / gradient / image, with optional pattern and ' +
      'edgeShade — see catalog schema). Pass slot to set a per-device backgroundOverride instead ' +
      '(slot + background null clears it).',
    {
      projectId: z.string().min(1),
      screenIndices: z
        .array(z.number().int().min(1))
        .optional()
        .describe('Screenshot positions; omit for all screenshots'),
      featureGraphic: z.boolean().optional().describe('Target the feature graphic instead'),
      locale: z.string().min(2).optional(),
      background: z.record(z.unknown()).nullable(),
      slot: z.string().optional(),
    },
    async ({ projectId, screenIndices, featureGraphic, locale, background, slot }) => {
      const { locale: loc, screenshots } = await fetchScreenshots(projectId, locale);
      const ordered = orderedScreenshotScreens(screenshots);
      const targets = featureGraphic
        ? [pickScreen(screenshots, { featureGraphic: true })]
        : (screenIndices ?? ordered.map((_, i) => i + 1)).map((i) =>
            pickScreen(screenshots, { screenIndex: i }),
          );
      if (!slot && background === null) throw new Error('background null is only valid with slot');
      for (const shot of targets) {
        const design = cloneDesign(shot.design ?? { version: 1, layers: [] });
        if (slot) {
          const map = { ...((design.backgroundOverrides as Record<string, unknown>) ?? {}) };
          if (background === null) delete map[slot];
          else map[slot] = background;
          design.backgroundOverrides = map;
        } else {
          design.background = background as unknown as DesignLike['background'];
        }
        await patchScreenshotDesign(shot.id, design, loc);
      }
      return text({
        updated: targets.map((s) => ({
          screenshotId: s.id,
          screenIndex: screenIndexOf(screenshots, s),
        })),
        slot: slot ?? null,
        locale: loc,
        editorUrl: editorUrl(projectId),
      });
    },
  );

  server.tool(
    'render_preview',
    'Render a screen to PNG exactly as the export will (same engine) and return the images for ' +
      'visual review. ALWAYS use this after designing: check wrapping, overlaps, cropping, contrast ' +
      "on phones AND tablets. Default slots = the project's enabled device slots (max 4).",
    {
      projectId: z.string().min(1),
      ...screenRef,
      locale: z.string().min(2).optional(),
      slots: z.array(z.string()).min(1).max(6).optional(),
      scale: z
        .number()
        .min(0.1)
        .max(1)
        .optional()
        .describe('Output scale, default 0.5 (half resolution)'),
    },
    async ({ projectId, locale, slots, scale, ...ref }) => {
      const { locale: loc, shot, screenshots } = await loadScreen(projectId, ref, locale);
      const targets = slots ?? (await defaultSlots(projectId, shot));
      const images = await renderPreviews(shot.id, targets, loc, scale);
      return mixed([
        {
          type: 'text',
          text: JSON.stringify({
            screenshotId: shot.id,
            screenIndex: screenIndexOf(screenshots, shot),
            locale: loc,
            slots: targets,
            editorUrl: editorUrl(projectId),
          }),
        },
        ...images,
      ]);
    },
  );

  server.tool(
    'add_screen',
    'Add a screen: a new screenshot (appended, or at position) or the Play feature graphic. Start ' +
      'it blank, from a template screen (templateKey), as a copy of an existing screen ' +
      '(copyFromScreenIndex), or with a full design.',
    {
      projectId: z.string().min(1),
      kind: z.enum(['screenshot', 'feature_graphic']).default('screenshot'),
      position: z.number().int().min(1).optional().describe('1-based position (default: last)'),
      templateKey: z.string().optional(),
      copyFromScreenIndex: z.number().int().min(1).optional(),
      design: z.record(z.unknown()).optional(),
      locale: z.string().min(2).optional(),
    },
    async ({ projectId, kind, position, templateKey, copyFromScreenIndex, design, locale }) => {
      const { locale: loc, screenshots } = await fetchScreenshots(projectId, locale);
      let initial: DesignLike | undefined = design
        ? ({ version: 1, ...design } as DesignLike)
        : undefined;
      if (!initial && copyFromScreenIndex) {
        const src = pickScreen(screenshots, { screenIndex: copyFromScreenIndex });
        initial = cloneDesign(src.design ?? { version: 1, layers: [] });
        for (const l of initial.layers ?? []) l.id = randomUUID();
      }
      if (!initial && !templateKey) {
        initial = { version: 1, background: { type: 'solid', color: '#ffffff' }, layers: [] };
      }
      const { screenshot } = await gsr.post<{ screenshot: ScreenshotRow }>(
        `/projects/${projectId}/screenshots`,
        { kind, ...(templateKey ? { templateKey } : {}) },
      );
      if (initial) {
        for (const l of (initial.layers ?? []) as DesignLayer[]) l.id ??= randomUUID();
        await patchScreenshotDesign(screenshot.id, initial, loc);
      }
      if (position && kind === 'screenshot') {
        await reorder(projectId, screenshot.id, position);
      }
      const { screenshots: after } = await fetchScreenshots(projectId, loc);
      const created = after.find((s) => s.id === screenshot.id)!;
      return text({
        screenshotId: screenshot.id,
        screenIndex: screenIndexOf(after, created),
        kind,
        editorUrl: editorUrl(projectId),
      });
    },
  );

  server.tool(
    'delete_screen',
    'Delete one screen (screenshot or the feature graphic) from the project. Irreversible.',
    { projectId: z.string().min(1), ...screenRef },
    async ({ projectId, ...ref }) => {
      const { screenshots } = await fetchScreenshots(projectId);
      const shot = pickScreen(screenshots, ref);
      await gsr.delete(`/screenshots/${shot.id}`);
      return text({ deleted: shot.id, editorUrl: editorUrl(projectId) });
    },
  );

  server.tool(
    'move_screen',
    'Move a screenshot to a new 1-based position (store order).',
    {
      projectId: z.string().min(1),
      screenIndex: z.number().int().min(1),
      toPosition: z.number().int().min(1),
    },
    async ({ projectId, screenIndex, toPosition }) => {
      const { screenshots } = await fetchScreenshots(projectId);
      const shot = pickScreen(screenshots, { screenIndex });
      await reorder(projectId, shot.id, toPosition);
      return text({
        screenshotId: shot.id,
        screenIndex: toPosition,
        editorUrl: editorUrl(projectId),
      });
    },
  );

  server.tool(
    'set_device_slots',
    'Choose which device sizes the project produces (e.g. ["iphone-6.3","ipad-13","android-phone",' +
      '"android-tablet-10"]) and whether tablets render landscape. See catalog slots (userToggle).',
    {
      projectId: z.string().min(1),
      slots: z.array(z.string()).min(1).optional(),
      tabletLandscape: z.boolean().optional(),
    },
    async ({ projectId, slots, tabletLandscape }) => {
      if (!slots && tabletLandscape === undefined)
        throw new Error('Pass slots and/or tabletLandscape.');
      const { project } = await gsr.patch<{
        project: { enabledDeviceSlots?: string[]; tabletLandscape?: boolean };
      }>(`/projects/${projectId}`, {
        ...(slots ? { enabledDeviceSlots: slots } : {}),
        ...(tabletLandscape !== undefined ? { tabletLandscape } : {}),
      });
      return text({
        enabledDeviceSlots: project.enabledDeviceSlots,
        tabletLandscape: project.tabletLandscape,
        editorUrl: editorUrl(projectId),
      });
    },
  );

  server.tool(
    'list_media',
    "List images usable as assetId in image/device layers and image backgrounds: the user's " +
      'uploads and (source "stock") the curated site-wide stock images (badges, store logos, …).',
    { source: z.enum(['uploads', 'stock', 'both']).default('both') },
    async ({ source }) => {
      type Row = {
        id: string;
        url: string;
        width: number | null;
        height: number | null;
        category?: string | null;
      };
      const out: Record<string, Row[]> = {};
      if (source !== 'stock') out.uploads = (await gsr.get<{ assets: Row[] }>('/assets')).assets;
      if (source !== 'uploads')
        out.stock = (await gsr.get<{ assets: Row[] }>('/stock-images')).assets;
      return text(out);
    },
  );
}

async function reorder(projectId: string, screenshotId: string, position: number): Promise<void> {
  const { screenshots } = await fetchScreenshots(projectId);
  const ordered = orderedScreenshotScreens(screenshots).filter((s) => s.id !== screenshotId);
  const moving = screenshots.find((s) => s.id === screenshotId);
  if (!moving) throw new Error(`No screen ${screenshotId}`);
  ordered.splice(Math.min(position - 1, ordered.length), 0, moving);
  for (const [i, s] of ordered.entries()) {
    if (s.order !== i) await gsr.patch(`/screenshots/${s.id}`, { order: i });
  }
}
