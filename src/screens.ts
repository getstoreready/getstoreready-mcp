import { GsrApiError, gsr } from './client.js';
import type { DesignLike } from './design-utils.js';

export interface ScreenshotRow {
  id: string;
  order: number;
  kind: 'screenshot' | 'feature_graphic' | 'app_store_header' | 'app_store_search';
  templateKey?: string | null;
  design?: DesignLike | null;
  /** When this locale's design last changed (API echoes it for conflict checks). */
  designUpdatedAt?: string;
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
  return screenshots.filter((s) => s.kind === 'screenshot').sort((a, b) => a.order - b.order);
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

// The design version this agent last LOOKED AT per screen+locale (read via
// get_screen_design / render_preview, or its own last write). Writes send it as
// baseUpdatedAt, so a screen someone changed in the editor meanwhile is not
// silently overwritten: the API answers 409 and the agent must re-read.
const seenVersion = new Map<string, string>();
const seenKey = (screenshotId: string, locale?: string) => `${screenshotId}:${locale ?? ''}`;
export function markSeen(screenshotId: string, locale: string | undefined, at?: string): void {
  if (at) seenVersion.set(seenKey(screenshotId, locale), at);
}

export async function patchScreenshotDesign(
  screenshotId: string,
  design: DesignLike,
  locale?: string,
  /** Version the change was based on when the agent never looked at this screen. */
  fallbackBase?: string,
): Promise<void> {
  const q = locale ? `?locale=${encodeURIComponent(locale)}` : '';
  const baseUpdatedAt = seenVersion.get(seenKey(screenshotId, locale)) ?? fallbackBase;
  try {
    const r = await gsr.patch<{ screenshot?: { designUpdatedAt?: string } }>(
      `/screenshots/${screenshotId}${q}`,
      { design, ...(baseUpdatedAt ? { baseUpdatedAt } : {}) },
    );
    markSeen(screenshotId, locale, r?.screenshot?.designUpdatedAt);
  } catch (err) {
    if (err instanceof GsrApiError && err.status === 409) {
      throw new Error(
        `${err.message} Someone (probably the user, in the editor) changed this screen after ` +
          'you last read it. Call get_screen_design, keep their changes, and re-apply only ' +
          'what you were asked to change. Never overwrite the whole design blindly.',
      );
    }
    throw err;
  }
}
