import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';

export type AppStack = 'flutter' | 'react-native' | 'swift' | 'android-native' | 'unknown';

export interface DetectedScreen {
  id: string;
  label: string;
  source: 'route' | 'tab' | 'inferred';
  priority: number;
  hints: string[];
}

export interface AppDetection {
  rootPath: string;
  stack: AppStack;
  name: string | null;
  platforms: 'ios' | 'android' | 'both';
  bundleId: string | null;
  locales: string[];
  screens: DetectedScreen[];
  notes: string[];
}

export interface DiscoveredScreenshot {
  path: string;
  relativePath: string;
  locale: string | null;
  order: number;
  basename: string;
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

const SCREENSHOT_ROOTS = [
  'marketing',
  'fastlane/screenshots',
  'ios/fastlane/screenshots',
  'screenshots',
  'store_assets',
  'assets/screenshots',
  'assets/store',
  'design/store',
] as const;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = v.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function parseYamlScalar(block: string, key: string): string | null {
  const m = block.match(new RegExp(`^${key}:\\s*["']?([^"'\\n#]+)`, 'm'));
  return m?.[1]?.trim() ?? null;
}

async function detectStack(root: string): Promise<AppStack> {
  if (await exists(join(root, 'pubspec.yaml'))) return 'flutter';
  const pkg = await readText(join(root, 'package.json'));
  if (pkg) {
    try {
      const json = JSON.parse(pkg) as { dependencies?: Record<string, string> };
      if (json.dependencies?.['react-native'] || json.dependencies?.expo) return 'react-native';
    } catch {
      /* ignore */
    }
  }
  const hasIos = (await exists(join(root, 'ios'))) || (await globOne(root, '*.xcodeproj'));
  const hasAndroid = await exists(join(root, 'android'));
  if (hasIos && !hasAndroid) {
    const swift = await globOne(join(root, 'ios'), '*.swift');
    if (swift) return 'swift';
  }
  if (hasAndroid && !hasIos) return 'android-native';
  if (hasIos && hasAndroid) return 'react-native';
  return 'unknown';
}

async function globOne(dir: string, pattern: string): Promise<string | null> {
  if (!(await exists(dir))) return null;
  const suffix = pattern.replace('*', '');
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(suffix)) return join(dir, e.name);
    if (e.isDirectory() && pattern.startsWith('*')) {
      const nested = await globOne(join(dir, e.name), pattern);
      if (nested) return nested;
    }
  }
  return null;
}

async function detectName(root: string, stack: AppStack): Promise<string | null> {
  if (stack === 'flutter') {
    const pub = await readText(join(root, 'pubspec.yaml'));
    if (pub) {
      const name = parseYamlScalar(pub, 'name');
      if (name) return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }

  const appJson = await readText(join(root, 'app.json'));
  if (appJson) {
    try {
      const j = JSON.parse(appJson) as { expo?: { name?: string }; name?: string };
      const n = j.expo?.name ?? j.name;
      if (n) return n;
    } catch {
      /* ignore */
    }
  }

  const pkg = await readText(join(root, 'package.json'));
  if (pkg) {
    try {
      const j = JSON.parse(pkg) as { displayName?: string; name?: string };
      if (j.displayName) return j.displayName;
      if (j.name && !j.name.startsWith('@')) return j.name;
    } catch {
      /* ignore */
    }
  }

  const plist = await readText(join(root, 'ios/Runner/Info.plist'));
  if (plist) {
    const display = plist.match(
      /<key>CFBundleDisplayName<\/key>\s*<string>([^<]+)<\/string>/,
    )?.[1];
    if (display) return display;
    const name = plist.match(/<key>CFBundleName<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
    if (name) return name;
  }

  const strings = await readText(join(root, 'android/app/src/main/res/values/strings.xml'));
  if (strings) {
    const name = strings.match(/<string name="app_name">([^<]+)<\/string>/)?.[1];
    if (name) return name;
  }

  return basename(root);
}

async function detectPlatforms(root: string): Promise<'ios' | 'android' | 'both'> {
  const hasIos = (await exists(join(root, 'ios'))) || (await globOne(root, '*.xcodeproj'));
  const hasAndroid = await exists(join(root, 'android'));
  if (hasIos && hasAndroid) return 'both';
  if (hasIos) return 'ios';
  if (hasAndroid) return 'android';
  return 'both';
}

async function detectLocales(root: string): Promise<string[]> {
  const locales: string[] = [];

  const xcstrings = await globOne(root, 'Localizable.xcstrings');
  if (xcstrings) {
    const raw = await readText(xcstrings);
    if (raw) {
      try {
        const j = JSON.parse(raw) as { strings?: Record<string, { localizations?: Record<string, unknown> }> };
        for (const entry of Object.values(j.strings ?? {})) {
          for (const code of Object.keys(entry.localizations ?? {})) locales.push(code);
        }
      } catch {
        /* ignore */
      }
    }
  }

  const lprojDir = join(root, 'ios');
  if (await exists(lprojDir)) {
    const iosEntries = await readdir(lprojDir, { withFileTypes: true }).catch(() => []);
    for (const e of iosEntries) {
      if (e.isDirectory() && e.name.endsWith('.lproj')) locales.push(e.name.replace('.lproj', ''));
    }
  }

  const arbDir = join(root, 'lib');
  async function walkArb(dir: string, depth = 0): Promise<void> {
    if (depth > 4) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walkArb(p, depth + 1);
      else if (e.name.endsWith('.arb')) {
        const m = e.name.match(/_([a-z]{2}(?:_[A-Z]{2})?)\.arb$/);
        if (m?.[1]) locales.push(m[1].replace('_', '-'));
      }
    }
  }
  if (await exists(arbDir)) await walkArb(arbDir);

  return uniqueStrings(locales).slice(0, 20);
}

function scoreScreenLabel(label: string): number {
  const l = label.toLowerCase();
  if (/(home|dashboard|feed|today|overview)/.test(l)) return 100;
  if (/(trade|trading|market|portfolio|wallet|invest)/.test(l)) return 90;
  if (/(discover|explore|browse|search)/.test(l)) return 80;
  if (/(profile|account|settings|preferences)/.test(l)) return 40;
  if (/(login|sign.?in|onboard|splash|auth|register)/.test(l)) return 10;
  return 60;
}

function extractQuotedLabels(text: string, patterns: RegExp[]): string[] {
  const found: string[] = [];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const label = m[1] ?? m[2];
      if (label && label.length >= 2 && label.length <= 40) found.push(label);
    }
  }
  return found;
}

async function scanFileForScreens(filePath: string): Promise<string[]> {
  const text = await readText(filePath);
  if (!text) return [];
  const patterns = [
    /BottomNavigationBarItem\(\s*[^,]*,\s*label:\s*['"]([^'"]+)['"]/g,
    /NavigationDestination\(\s*value:\s*[^,]+,\s*label:\s*['"]([^'"]+)['"]/g,
    /title:\s*['"]([^'"]{2,40})['"]/g,
    /label:\s*['"]([^'"]{2,40})['"]/g,
    /name:\s*['"]([^'"]{2,40})['"]/g,
    /<Tab\.Screen[^>]*name=["']([^"']+)["']/g,
    /createBottomTabNavigator|createMaterialBottomTabNavigator/g,
    /\bScreen\s+name=["']([^"']+)["']/g,
    /path:\s*['"]\/([^'"]+)['"]/g,
  ];
  return extractQuotedLabels(text, patterns);
}

async function detectScreens(root: string, stack: AppStack): Promise<DetectedScreen[]> {
  const candidates: string[] = [];
  const scanRoots =
    stack === 'flutter'
      ? ['lib']
      : stack === 'react-native'
        ? ['src', 'app', 'screens', '.']
        : ['Sources', 'App', 'ios', '.'];

  for (const rel of scanRoots) {
    const dir = join(root, rel);
    if (!(await exists(dir))) continue;
    await walkCode(dir, async (file) => {
      if (!/\.(dart|tsx?|jsx?|swift)$/.test(file)) return;
      candidates.push(...(await scanFileForScreens(file)));
    });
  }

  const labels = uniqueStrings(candidates).filter((l) => !/^(#|http|\/)/.test(l));
  const screens = labels.map((label, i) => ({
    id: slugify(label) || `screen-${i + 1}`,
    label,
    source: 'route' as const,
    priority: scoreScreenLabel(label),
    hints: [],
  }));

  screens.sort((a, b) => b.priority - a.priority);

  if (!screens.length) {
    return [
      { id: 'home', label: 'Home', source: 'inferred', priority: 100, hints: ['default'] },
      { id: 'feature', label: 'Feature', source: 'inferred', priority: 70, hints: ['default'] },
      { id: 'detail', label: 'Detail', source: 'inferred', priority: 60, hints: ['default'] },
    ];
  }

  return screens.slice(0, 12);
}

async function walkCode(dir: string, onFile: (path: string) => Promise<void>, depth = 0): Promise<void> {
  if (depth > 6) return;
  const skip = new Set(['node_modules', '.git', 'build', 'dist', '.dart_tool', 'Pods', 'DerivedData']);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (skip.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walkCode(p, onFile, depth + 1);
    else await onFile(p);
  }
}

function orderKeyFromName(name: string): number {
  const prefix = name.match(/^(\d{1,3})[-_.\s]/);
  if (prefix?.[1]) return Number(prefix[1]);
  const any = name.match(/(\d{1,3})/);
  if (any?.[1]) return Number(any[1]);
  return 999;
}

function localeFromPath(rel: string): string | null {
  const parts = rel.split(/[/\\]/);
  for (const part of parts) {
    if (/^[a-z]{2}([-_][A-Za-z]{2})?$/.test(part)) return part.replace('_', '-');
    if (/^[a-z]{2}-[A-Z]{2}$/.test(part)) return part;
  }
  return null;
}

async function collectImages(dir: string, root: string, out: DiscoveredScreenshot[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      await collectImages(abs, root, out);
      continue;
    }
    if (!e.isFile()) continue;
    const ext = extname(e.name).toLowerCase();
    if (!IMAGE_EXT.has(ext)) continue;
    const rel = relative(root, abs);
    out.push({
      path: abs,
      relativePath: rel,
      locale: localeFromPath(rel),
      order: orderKeyFromName(e.name),
      basename: e.name,
    });
  }
}

export async function detectApp(rootPath: string): Promise<AppDetection> {
  const root = resolve(rootPath);
  if (!(await exists(root))) throw new Error(`Path does not exist: ${root}`);

  const notes: string[] = [];
  const stack = await detectStack(root);
  const name = await detectName(root, stack);
  const platforms = await detectPlatforms(root);
  const locales = await detectLocales(root);
  const screens = await detectScreens(root, stack);

  if (stack === 'unknown') notes.push('Could not confidently detect the mobile stack.');
  if (!locales.length) notes.push('No locales discovered — defaulting to en_US for store copy.');
  if (screens.every((s) => s.source === 'inferred')) {
    notes.push('No routes/tabs found — using generic screen suggestions.');
  }

  return { rootPath: root, stack, name, platforms, bundleId: null, locales, screens, notes };
}

export async function discoverScreenshots(
  rootPath: string,
  opts?: { max?: number; locale?: string },
): Promise<DiscoveredScreenshot[]> {
  const root = resolve(rootPath);
  const max = opts?.max ?? 7;
  const found: DiscoveredScreenshot[] = [];

  for (const rel of SCREENSHOT_ROOTS) {
    const dir = join(root, rel);
    if (await exists(dir)) await collectImages(dir, root, found);
  }

  let list = found;
  if (opts?.locale) {
    const loc = opts.locale;
    const filtered = list.filter((s) => s.locale === loc || s.locale === null);
    if (filtered.length) list = filtered;
  }

  list.sort((a, b) => a.order - b.order || a.relativePath.localeCompare(b.relativePath));

  const deduped: DiscoveredScreenshot[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (seen.has(item.path)) continue;
    seen.add(item.path);
    deduped.push(item);
    if (deduped.length >= max) break;
  }

  return deduped;
}
