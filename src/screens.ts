import { gsr } from './client.js';
import type { DesignLike } from './design-utils.js';

export interface ScreenshotRow {
  id: string;
  order: number;
  kind: 'screenshot' | 'feature_graphic';
  templateKey?: string | null;
  design?: DesignLike | null;
}

export interface ProjectRow {
  id: string;
  name: string;
  platforms: 'ios' | 'android' | 'both';
  defaultStoreLanguage: string;
  enabledDeviceSlots?: string[];
  createdAt: string;
  updatedAt: string;
  storeLocales?: Array<{ languageCode: string; isPrimary: boolean }>;
}

export async function fetchProject(projectId: string): Promise<ProjectRow> {
  const { project } = await gsr.get<{ project: ProjectRow }>(`/projects/${projectId}`);
  return project;
}

export async function fetchScreenshots(
  projectId: string,
  locale?: string,
): Promise<{ locale: string; screenshots: ScreenshotRow[]; defaultStoreLanguage: string }> {
  const project = await fetchProject(projectId);
  const loc = locale ?? project.defaultStoreLanguage;
  const { screenshots, locale: resolved } = await gsr.getQuery<{
    screenshots: ScreenshotRow[];
    locale: string;
  }>(`/projects/${projectId}/screenshots`, { locale: loc });
  return {
    locale: resolved,
    screenshots,
    defaultStoreLanguage: project.defaultStoreLanguage,
  };
}

export function orderedScreenshotScreens(screenshots: ScreenshotRow[]): ScreenshotRow[] {
  return screenshots
    .filter((s) => s.kind === 'screenshot')
    .sort((a, b) => a.order - b.order);
}

export function screenAtIndex(screenshots: ScreenshotRow[], screenIndex: number): ScreenshotRow {
  const screens = orderedScreenshotScreens(screenshots);
  const target = screens[screenIndex - 1];
  if (!target) {
    throw new Error(
      `No screen at index ${screenIndex} — this project currently has ${screens.length} screen(s).`,
    );
  }
  return target;
}

export async function patchScreenshotDesign(
  screenshotId: string,
  design: DesignLike,
  locale?: string,
): Promise<void> {
  const q = locale ? `?locale=${encodeURIComponent(locale)}` : '';
  await gsr.patch(`/screenshots/${screenshotId}${q}`, { design });
}
