export interface RunLike {
  text: string;
  bg?: string;
  color?: string;
  italic?: boolean;
  weight?: number;
}

export interface TextLayerLike {
  id: string;
  type: 'text';
  text?: string;
  runs?: RunLike[];
}

export interface DesignLayer {
  id: string;
  type: string;
  assetId?: string | null;
  text?: string;
  runs?: RunLike[];
  overrides?: Record<string, { text?: string; runs?: RunLike[]; assetId?: string | null }>;
  [key: string]: unknown;
}

export interface BackgroundSolid {
  type: 'solid';
  color: string;
  pattern?: unknown;
  edgeShade?: unknown;
}

export interface BackgroundGradient {
  type: 'gradient';
  angle?: number;
  stops: Array<{ color: string; at: number }>;
  pattern?: unknown;
  edgeShade?: unknown;
}

export interface BackgroundImage {
  type: 'image';
  assetId: string;
  fit?: 'cover' | 'contain';
  split?: boolean;
  posX?: number;
  posY?: number;
  edgeShade?: unknown;
}

export type BackgroundInput = BackgroundSolid | BackgroundGradient | BackgroundImage;

export interface DesignLike {
  background?: BackgroundInput;
  layers?: DesignLayer[];
  [key: string]: unknown;
}

export function runsPlain(runs: RunLike[]): string {
  return runs.map((r) => r.text).join('');
}

export function cloneDesign(design: DesignLike): DesignLike {
  return JSON.parse(JSON.stringify(design)) as DesignLike;
}

export function deviceAssetId(design: DesignLike | null | undefined): string | null {
  if (!design?.layers) return null;
  const device = design.layers.find((l) => l.type === 'device' && l.assetId);
  if (device?.assetId) return device.assetId;
  const image = design.layers.find((l) => l.type === 'image' && l.assetId);
  return image?.assetId ?? null;
}

export interface TextLayerInfo {
  layerId: string;
  text: string;
  entryId: string;
}

/** User-visible text layers on a screen (for MCP read/write). */
export function listTextLayers(design: DesignLike | null | undefined): TextLayerInfo[] {
  if (!design?.layers) return [];
  const out: TextLayerInfo[] = [];
  for (const layer of design.layers) {
    if (layer.type !== 'text') continue;
    const copy = layer.runs?.length ? runsPlain(layer.runs) : (layer.text ?? '');
    out.push({
      layerId: layer.id,
      text: copy,
      entryId: `layer:${layer.id}:text`,
    });
  }
  return out;
}

export function setBackground(design: DesignLike, background: BackgroundInput): DesignLike {
  const next = cloneDesign(design);
  next.background = background;
  return next;
}

export function setLayerText(
  design: DesignLike,
  layerId: string,
  text: string,
): DesignLike {
  const next = cloneDesign(design);
  const layer = next.layers?.find((l) => l.id === layerId);
  if (!layer || layer.type !== 'text') {
    throw new Error(`Text layer "${layerId}" not found on this screen.`);
  }
  layer.text = text;
  delete layer.runs;
  return next;
}
