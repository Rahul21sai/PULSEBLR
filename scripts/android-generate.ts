import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ANDROID_PACKAGE_ID,
  PRODUCTION_ORIGIN,
  assertWebAndTwaParity,
} from '../lib/mobile-release-contract';
import { checkAndroidToolchain, type AndroidToolchainPaths } from './android-toolchain';

interface ChildResult {
  status: number | null;
}

export interface BubblewrapSpawnOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  stdio: 'inherit';
}

export interface BubblewrapUpdateOptions {
  repositoryRoot?: string;
  env?: Record<string, string | undefined>;
  run?: (command: string, args: readonly string[], options: BubblewrapSpawnOptions) => ChildResult;
  postprocess?: (repositoryRoot: string) => unknown;
  validateToolchain?: (env: Record<string, string | undefined>) => AndroidToolchainPaths;
}

export interface BubblewrapCompatibilityResult {
  shortcutCount: number;
  shortcutPaths: string[];
}

export interface BubblewrapPostprocessOptions {
  commitStagedFile?: (staged: string, target: string) => void;
}

const shortcutPaths = ['/scan', '/card', '/', '/tracker', '/calendar'] as const;
const generatedLimit = 'assert twaManifest.shortcuts.size() < 5, "You can have at most 4 shortcuts."';
const compatibleLimit = 'assert twaManifest.shortcuts.size() == 5, "PulseBLR requires exactly 5 shortcuts."';
const generatedData = "'android:data': s.url)";
const compatibleData = "'android:data': '@string/shortcut_url_' + i)";
const bubblewrapEnvironmentAllowlist = new Set([
  'APPDATA',
  'CI',
  'COMSPEC',
  'FORCE_COLOR',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'NO_COLOR',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'TZ',
  'USERPROFILE',
  'WINDIR',
]);

function generationEnvironment(source: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter(([key, value]) =>
      value !== undefined && bubblewrapEnvironmentAllowlist.has(key.toUpperCase()),
    ),
  ) as Record<string, string>;
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function replaceExactlyOnce(source: string, expected: string, replacement: string, label: string): string {
  const count = source.split(expected).length - 1;
  if (count !== 1) {
    throw new Error(`Bubblewrap 1.25.0 ${label} template replacement expected once, found ${count}`);
  }
  return source.replace(expected, replacement);
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function renderShortcutUrlResources(urls: readonly string[]): string {
  const resources = urls.map((url, index) =>
    `    <string name="shortcut_url_${index}" translatable="false">${escapeXml(url)}</string>`,
  );
  return ['<?xml version="1.0" encoding="utf-8"?>', '<resources>', ...resources, '</resources>', ''].join('\n');
}

function renderShortcutsXml(shortcutCount: number): string {
  const packageId = escapeXml(ANDROID_PACKAGE_ID);
  const shortcuts = Array.from({ length: shortcutCount }, (_unused, index) => `
    <shortcut
        android:shortcutId="shortcut${index}"
        android:enabled="true"
        android:icon="@drawable/shortcut_${index}"
        android:shortcutShortLabel="@string/shortcut_short_name_${index}"
        android:shortcutLongLabel="@string/shortcut_name_${index}">
        <intent
            android:action="android.intent.action.MAIN"
            android:targetPackage="${packageId}"
            android:targetClass="${packageId}.LauncherActivity"
            android:data="@string/shortcut_url_${index}" />
        <categories android:name="android.intent.category.LAUNCHER" />
    </shortcut>`);
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">',
    ...shortcuts,
    '</shortcuts>',
    '',
  ].join('\n');
}

function authoritativeShortcutUrls(web: Record<string, unknown>, twa: Record<string, unknown>): string[] {
  assertWebAndTwaParity(web, twa);
  const exactUrls = (manifestShortcuts: unknown, label: string): string[] => {
    if (!Array.isArray(manifestShortcuts) || manifestShortcuts.length !== shortcutPaths.length) {
      throw new Error(`${label} manifest must contain exactly five shortcuts`);
    }
    return manifestShortcuts.map((shortcut, index) => {
      if (typeof shortcut !== 'object' || shortcut === null || typeof (shortcut as { url?: unknown }).url !== 'string') {
        throw new Error(`${label} shortcut ${index} must contain a URL`);
      }
      const url = new URL((shortcut as { url: string }).url, PRODUCTION_ORIGIN);
      const expected = new URL(shortcutPaths[index], PRODUCTION_ORIGIN);
      if (url.href !== expected.href || url.username || url.password || url.search || url.hash) {
        throw new Error(`${label} shortcut ${index} must use the exact permanent-origin path ${shortcutPaths[index]}`);
      }
      return url.href;
    });
  };
  exactUrls(web.shortcuts, 'Web');
  return exactUrls(twa.shortcuts, 'Android');
}

function assertEmptyUpstreamShortcuts(source: string): void {
  const artifact = source
    .replace(/<!--[^]*?-->/g, '')
    .replace(/<\?xml[^>]*\?>/g, '')
    .trim();
  if (!/^<shortcuts\s+xmlns:android=(['"])http:\/\/schemas\.android\.com\/apk\/res\/android\1\s*\/>$/.test(artifact)) {
    throw new Error('Bubblewrap 1.25.0 upstream shortcuts.xml must have the expected empty shape');
  }
}

export function postprocessGeneratedProject(
  repositoryRoot: string,
  options: BubblewrapPostprocessOptions = {},
): BubblewrapCompatibilityResult {
  const androidRoot = path.join(repositoryRoot, 'android');
  const web = readJson(path.join(repositoryRoot, 'public', 'manifest.json'));
  const twa = readJson(path.join(androidRoot, 'twa-manifest.json'));
  const urls = authoritativeShortcutUrls(web, twa);
  const gradleFile = path.join(androidRoot, 'app', 'build.gradle');
  const originalGradle = readFileSync(gradleFile, 'utf8');
  const compatibleGradle = replaceExactlyOnce(
    replaceExactlyOnce(originalGradle, generatedLimit, compatibleLimit, 'shortcut-limit'),
    generatedData,
    compatibleData,
    'shortcut-data',
  );
  const resourceRoot = path.join(androidRoot, 'app', 'src', 'main', 'res');
  const xmlRoot = path.join(resourceRoot, 'xml');
  const valuesRoot = path.join(resourceRoot, 'values');
  const shortcutsFile = path.join(xmlRoot, 'shortcuts.xml');
  const resourcesFile = path.join(valuesRoot, 'pulseblr_shortcut_urls.xml');
  if (!existsSync(xmlRoot) || !existsSync(valuesRoot)) {
    throw new Error('Bubblewrap 1.25.0 generated resource directories are missing');
  }
  const originalShortcuts = readFileSync(shortcutsFile, 'utf8');
  assertEmptyUpstreamShortcuts(originalShortcuts);
  const shortcutsXml = renderShortcutsXml(urls.length);
  const shortcutResources = renderShortcutUrlResources(urls);
  const outputs = [
    { target: gradleFile, content: compatibleGradle },
    { target: shortcutsFile, content: shortcutsXml },
    { target: resourcesFile, content: shortcutResources },
  ];
  const originals = outputs.map(output => ({
    target: output.target,
    existed: existsSync(output.target),
    content: existsSync(output.target) ? readFileSync(output.target) : undefined,
  }));
  const stageRoot = mkdtempSync(path.join(repositoryRoot, '.pulseblr-android-stage-'));
  const commitStagedFile = options.commitStagedFile ?? copyFileSync;
  try {
    const staged = outputs.map((output, index) => {
      const file = path.join(stageRoot, String(index));
      writeFileSync(file, output.content);
      return { file, target: output.target };
    });
    try {
      for (const output of staged) commitStagedFile(output.file, output.target);
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const original of originals) {
        try {
          if (original.existed && original.content) writeFileSync(original.target, original.content);
          else rmSync(original.target, { force: true });
        } catch {
          rollbackErrors.push(path.basename(original.target));
        }
      }
      const reason = error instanceof Error ? error.message : String(error);
      const rollback = rollbackErrors.length ? `; rollback failed for ${rollbackErrors.join(', ')}` : '';
      throw new Error(`Android compatibility commit failed: ${reason}${rollback}`);
    }
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
  return { shortcutCount: urls.length, shortcutPaths: [...shortcutPaths] };
}

export function runBubblewrapUpdate(options: BubblewrapUpdateOptions = {}): number {
  const repositoryRoot = options.repositoryRoot ?? process.cwd();
  const sourceEnvironment = options.env ?? process.env;
  const toolchain = (options.validateToolchain ?? (env => checkAndroidToolchain({ env })))(sourceEnvironment);
  const env = generationEnvironment(sourceEnvironment);
  const cli = path.join(repositoryRoot, 'node_modules', '@bubblewrap', 'cli', 'bin', 'bubblewrap.js');
  const run = options.run ?? ((command, args, spawnOptions) => spawnSync(command, [...args], {
    ...spawnOptions,
    env: spawnOptions.env as NodeJS.ProcessEnv,
  }));
  const configRoot = mkdtempSync(path.join(tmpdir(), 'pulseblr-bubblewrap-'));
  const configPath = path.join(configRoot, 'config.json');
  try {
    writeFileSync(configPath, `${JSON.stringify({
      jdkPath: toolchain.javaHome,
      androidSdkPath: toolchain.sdkRoot,
    }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(configPath, 0o600);
    const child = run(process.execPath, [cli, 'update', '--skipVersionUpgrade', '--config', configPath], {
      cwd: path.join(repositoryRoot, 'android'),
      env,
      stdio: 'inherit',
    });
    if (child.status !== 0) return child.status ?? 1;
    (options.postprocess ?? postprocessGeneratedProject)(repositoryRoot);
    return 0;
  } finally {
    rmSync(configRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = runBubblewrapUpdate();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
