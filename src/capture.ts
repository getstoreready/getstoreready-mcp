import { mkdir, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { detectApp, type AppDetection, type AppStack } from './app-detect.js';

export interface CaptureOptions {
  appRootPath: string;
  platform?: 'ios' | 'android';
  count?: number;
  locale?: string;
  outDir?: string;
  deepLinks?: string[];
  screenLabels?: string[];
  deviceName?: string;
  install?: boolean;
  settleMs?: number;
  /** Absolute path to an existing Maestro flow (.yaml). */
  maestroFlowPath?: string;
}

export interface CapturedShot {
  path: string;
  relativePath: string;
  label: string;
  order: number;
}

export interface CaptureResult {
  platform: 'ios' | 'android';
  stack: AppStack;
  bundleId: string | null;
  outDir: string;
  screenshots: CapturedShot[];
  method: 'maestro' | 'simctl' | 'adb' | 'mixed';
  notes: string[];
  warnings: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function run(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, {
      cwd: opts?.cwd,
      env: { ...process.env, ...opts?.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer =
      opts?.timeoutMs &&
      setTimeout(() => {
        child.kill('SIGTERM');
      }, opts.timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code: 1, stdout, stderr: err.message });
    });
  });
}

async function which(bin: string): Promise<boolean> {
  const r = await run(process.platform === 'win32' ? 'where' : 'which', [bin], {
    timeoutMs: 10_000,
  });
  return r.code === 0 && r.stdout.trim().length > 0;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'screen';
}

async function readBundleId(root: string, stack: AppStack): Promise<string | null> {
  const { readFile } = await import('node:fs/promises');
  const tryRead = async (p: string) => {
    try {
      return await readFile(p, 'utf8');
    } catch {
      return null;
    }
  };

  const appJson = await tryRead(join(root, 'app.json'));
  if (appJson) {
    try {
      const j = JSON.parse(appJson) as {
        expo?: { ios?: { bundleIdentifier?: string }; android?: { package?: string } };
        ios?: { bundleIdentifier?: string };
      };
      const id = j.expo?.ios?.bundleIdentifier ?? j.ios?.bundleIdentifier;
      if (id) return id;
    } catch {
      /* ignore */
    }
  }

  const plistCandidates = [
    join(root, 'ios/Runner/Info.plist'),
    join(root, 'ios/App/Info.plist'),
  ];
  for (const p of plistCandidates) {
    const plist = await tryRead(p);
    if (!plist) continue;
    const m = plist.match(
      /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/,
    )?.[1];
    if (m && !m.includes('$(')) return m;
  }

  // Xcode PRODUCT_BUNDLE_IDENTIFIER in pbxproj / xcconfig
  const { readdir } = await import('node:fs/promises');
  async function walk(dir: string, depth = 0): Promise<string | null> {
    if (depth > 5) return null;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (['node_modules', 'Pods', 'build', '.git'].includes(e.name)) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        const nested = await walk(abs, depth + 1);
        if (nested) return nested;
      } else if (/\.(pbxproj|xcconfig)$/.test(e.name)) {
        const raw = await tryRead(abs);
        const m = raw?.match(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;\n]+)/)?.[1]?.trim();
        if (m && !m.includes('$(')) return m.replace(/"/g, '');
      }
    }
    return null;
  }

  if (stack === 'flutter' || stack === 'react-native' || stack === 'swift') {
    const iosDir = join(root, 'ios');
    if (await exists(iosDir)) {
      const fromIos = await walk(iosDir);
      if (fromIos) return fromIos;
    }
    const fromRoot = await walk(root);
    if (fromRoot) return fromRoot;
  }

  return null;
}

async function ensureIosSimulator(deviceName?: string): Promise<{ udid: string; notes: string[] }> {
  const notes: string[] = [];
  if (!(await which('xcrun'))) {
    throw new Error('xcrun not found — iOS capture requires macOS with Xcode Command Line Tools.');
  }

  const list = await run('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], {
    timeoutMs: 30_000,
  });
  if (list.code !== 0) {
    throw new Error(`simctl list failed: ${list.stderr || list.stdout}`);
  }

  type Dev = { udid: string; name: string; state: string; isAvailable?: boolean };
  const json = JSON.parse(list.stdout) as { devices: Record<string, Dev[]> };
  const all: Dev[] = Object.values(json.devices).flat();

  let pick =
    (deviceName
      ? all.find((d) => d.name.toLowerCase() === deviceName.toLowerCase())
      : null) ??
    all.find((d) => d.state === 'Booted') ??
    all.find((d) => /iPhone\s*(1[5-9]|1[6-9]|1[5-9] Pro)/i.test(d.name)) ??
    all.find((d) => /iPhone/i.test(d.name));

  if (!pick) throw new Error('No available iOS Simulator found. Install one via Xcode.');

  if (pick.state !== 'Booted') {
    notes.push(`Booting simulator ${pick.name} (${pick.udid})`);
    const boot = await run('xcrun', ['simctl', 'boot', pick.udid], { timeoutMs: 60_000 });
    if (boot.code !== 0 && !/already booted/i.test(boot.stderr + boot.stdout)) {
      throw new Error(`Failed to boot simulator: ${boot.stderr || boot.stdout}`);
    }
    await run('open', ['-a', 'Simulator'], { timeoutMs: 15_000 });
    await sleep(4000);
  } else {
    notes.push(`Using booted simulator ${pick.name}`);
  }

  return { udid: pick.udid, notes };
}

async function installFlutterIos(root: string, notes: string[]): Promise<void> {
  if (!(await which('flutter'))) {
    notes.push('flutter CLI not found — skipping install; assuming app is already on simulator.');
    return;
  }
  notes.push('Building/installing Flutter app on iOS simulator (may take a few minutes)…');
  const build = await run(
    'flutter',
    ['build', 'ios', '--simulator', '--debug', '--no-codesign'],
    { cwd: root, timeoutMs: 600_000 },
  );
  if (build.code !== 0) {
    notes.push(`flutter build ios failed — try launching the app yourself. ${build.stderr.slice(-400)}`);
    return;
  }
  // Prefer flutter install if available
  const install = await run('flutter', ['install', '-d', 'iPhone'], {
    cwd: root,
    timeoutMs: 180_000,
  });
  if (install.code !== 0) {
    notes.push('flutter install had issues — continuing; launch may still work if previously installed.');
  }
}

async function installReactNativeHint(notes: string[]): Promise<void> {
  notes.push(
    'React Native: ensure the app is already built & installed on the simulator ' +
      '(e.g. `npx react-native run-ios` or Expo). Capture will launch + screenshot.',
  );
}

async function launchIosApp(bundleId: string, udid: string, notes: string[]): Promise<void> {
  const terminate = await run('xcrun', ['simctl', 'terminate', udid, bundleId], {
    timeoutMs: 15_000,
  });
  void terminate;
  const launch = await run('xcrun', ['simctl', 'launch', udid, bundleId], {
    timeoutMs: 30_000,
  });
  if (launch.code !== 0) {
    notes.push(
      `Could not launch ${bundleId}: ${launch.stderr || launch.stdout}. ` +
        'Open the app manually on the simulator, then re-run capture.',
    );
  } else {
    notes.push(`Launched ${bundleId}`);
    await sleep(2500);
  }
}

async function simctlScreenshot(udid: string, outPath: string): Promise<void> {
  const r = await run('xcrun', ['simctl', 'io', udid, 'screenshot', outPath], {
    timeoutMs: 30_000,
  });
  if (r.code !== 0) {
    throw new Error(`simctl screenshot failed: ${r.stderr || r.stdout}`);
  }
}

async function openDeepLink(udid: string, url: string, notes: string[]): Promise<void> {
  const r = await run('xcrun', ['simctl', 'openurl', udid, url], { timeoutMs: 15_000 });
  if (r.code !== 0) {
    notes.push(`openurl failed for ${url}: ${(r.stderr || r.stdout).slice(0, 200)}`);
  } else {
    await sleep(1500);
  }
}

async function writeMaestroTapFlow(
  flowPath: string,
  bundleId: string,
  label: string,
): Promise<void> {
  const lines = [
    `appId: ${bundleId}`,
    '---',
    `- tapOn: "${label.replace(/"/g, '\\"')}"`,
    '- waitForAnimationToEnd',
  ];
  await writeFile(flowPath, `${lines.join('\n')}\n`, 'utf8');
}

async function runMaestro(flowPath: string, notes: string[]): Promise<boolean> {
  if (!(await which('maestro'))) {
    notes.push('Maestro CLI not found (`brew tap mobile-dev-inc/tap && brew install maestro`).');
    return false;
  }
  notes.push(`Running Maestro flow: ${flowPath}`);
  const r = await run('maestro', ['test', flowPath], { timeoutMs: 120_000 });
  if (r.code !== 0) {
    notes.push(`Maestro failed: ${(r.stderr || r.stdout).slice(-500)}`);
    return false;
  }
  return true;
}

async function ensureAndroidEmulator(notes: string[]): Promise<void> {
  if (!(await which('adb'))) {
    throw new Error('adb not found — Android capture requires Android SDK platform-tools.');
  }
  const devices = await run('adb', ['devices'], { timeoutMs: 15_000 });
  if (!/device\s*$/m.test(devices.stdout.replace('List of devices attached', ''))) {
    notes.push('No adb device online — start an emulator or plug in a device, then retry.');
    throw new Error('No Android emulator/device connected (`adb devices` empty).');
  }
}

async function adbScreenshot(outPath: string): Promise<void> {
  const remote = '/sdcard/gsr-capture.png';
  const cap = await run('adb', ['shell', 'screencap', '-p', remote], { timeoutMs: 20_000 });
  if (cap.code !== 0) throw new Error(`adb screencap failed: ${cap.stderr || cap.stdout}`);
  const pull = await run('adb', ['pull', remote, outPath], { timeoutMs: 20_000 });
  if (pull.code !== 0) throw new Error(`adb pull failed: ${pull.stderr || pull.stdout}`);
}

function pickLabels(detection: AppDetection, opts: CaptureOptions, count: number): string[] {
  if (opts.screenLabels?.length) return opts.screenLabels.slice(0, count);
  const fromDetect = detection.screens
    .filter((s) => s.priority >= 40)
    .map((s) => s.label)
    .slice(0, count);
  if (fromDetect.length) return fromDetect;
  return Array.from({ length: count }, (_, i) => `screen-${i + 1}`);
}

/**
 * Capture marketing screenshots from a local mobile app via simulator/emulator.
 * Prefers Maestro (multi-screen taps) when available; falls back to simctl/adb
 * + optional deep links.
 */
export async function captureScreenshots(opts: CaptureOptions): Promise<CaptureResult> {
  const root = resolve(opts.appRootPath);
  const platform = opts.platform ?? 'ios';
  const count = Math.min(7, Math.max(1, opts.count ?? 5));
  const locale = opts.locale ?? 'en';
  const settleMs = opts.settleMs ?? 2000;
  const doInstall = opts.install !== false;
  const notes: string[] = [];
  const warnings: string[] = [];

  const detection = await detectApp(root);
  const bundleId = (await readBundleId(root, detection.stack)) ?? detection.bundleId;
  const labels = pickLabels(detection, opts, count);

  const outRel = opts.outDir ?? join('marketing', locale);
  const outDir = resolve(root, outRel);
  await mkdir(outDir, { recursive: true });

  if (platform === 'android') {
    await ensureAndroidEmulator(notes);
    if (doInstall && detection.stack === 'flutter' && (await which('flutter'))) {
      notes.push('Installing Flutter app on Android…');
      await run('flutter', ['install'], { cwd: root, timeoutMs: 300_000 });
    } else {
      notes.push('Ensure the Android app is installed and in the foreground.');
    }

    const shots: CapturedShot[] = [];
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i]!;
      const deep = opts.deepLinks?.[i];
      if (deep) {
        await run('adb', ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', deep], {
          timeoutMs: 15_000,
        });
        await sleep(settleMs);
      } else if (i > 0) {
        warnings.push(
          `Shot ${i + 1} (${label}): no deep link — may capture the same screen. Pass deepLinks or use Maestro on iOS.`,
        );
        await sleep(settleMs);
      } else {
        await sleep(settleMs);
      }
      const file = `${String(i + 1).padStart(2, '0')}-${slugify(label)}.png`;
      const abs = join(outDir, file);
      await adbScreenshot(abs);
      shots.push({
        path: abs,
        relativePath: join(outRel, file),
        label,
        order: i + 1,
      });
    }

    return {
      platform,
      stack: detection.stack,
      bundleId,
      outDir,
      screenshots: shots,
      method: 'adb',
      notes,
      warnings,
    };
  }

  // ——— iOS ———
  const { udid, notes: bootNotes } = await ensureIosSimulator(opts.deviceName);
  notes.push(...bootNotes);

  if (!bundleId) {
    warnings.push(
      'Could not detect bundle id — install/launch may be skipped. Pass deepLinks or open the app manually.',
    );
  }

  if (doInstall) {
    if (detection.stack === 'flutter') await installFlutterIos(root, notes);
    else if (detection.stack === 'react-native') await installReactNativeHint(notes);
    else notes.push('Swift/native: ensure a Debug build is installed on the simulator.');
  }

  if (bundleId) await launchIosApp(bundleId, udid, notes);

  const hasMaestro = await which('maestro');
  let method: CaptureResult['method'] = opts.deepLinks?.length ? 'simctl' : 'simctl';
  if (hasMaestro && !opts.deepLinks?.length) {
    notes.push('Maestro available — will tap screen labels between simctl screenshots when possible.');
    method = 'mixed';
  } else if (!opts.deepLinks?.length) {
    notes.push(
      'Tip: install Maestro (`brew install maestro`) or pass deepLinks[] for distinct multi-screen captures.',
    );
  }

  // Optional full custom Maestro flow (user-provided) — still finish with simctl inventory
  if (opts.maestroFlowPath && bundleId) {
    const ok = await runMaestro(opts.maestroFlowPath, notes);
    if (ok) method = 'maestro';
  }

  const shots: CapturedShot[] = [];
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i]!;
    const deep = opts.deepLinks?.[i];
    if (deep) {
      await openDeepLink(udid, deep, notes);
    } else if (i > 0 && bundleId && hasMaestro && !opts.maestroFlowPath) {
      const tapFlow = join(outDir, `.gsr-tap-${slugify(label)}.yaml`);
      await writeMaestroTapFlow(tapFlow, bundleId, label);
      const tapped = await runMaestro(tapFlow, notes);
      if (!tapped) {
        warnings.push(
          `Could not tap "${label}" via Maestro — screenshot may duplicate the previous screen.`,
        );
      }
    } else if (i > 0) {
      warnings.push(
        `Shot ${i + 1} (${label}): no deepLink/Maestro tap — capturing current simulator screen (may duplicate).`,
      );
    }
    await sleep(settleMs);
    const file = `${String(i + 1).padStart(2, '0')}-${slugify(label)}.png`;
    const abs = join(outDir, file);
    await simctlScreenshot(udid, abs);
    shots.push({
      path: abs,
      relativePath: join(outRel, file),
      label,
      order: i + 1,
    });
  }

  return {
    platform: 'ios',
    stack: detection.stack,
    bundleId,
    outDir,
    screenshots: shots,
    method,
    notes,
    warnings,
  };
}
