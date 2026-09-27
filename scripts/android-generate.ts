/**
 * Android project generation: the pinned Bubblewrap 1.25.0 `update`, followed by a PulseBLR
 * postprocess that makes the template buildable and verifiable.
 *
 * Two modes, and the difference is ONLY where Bubblewrap downloads its assets from:
 *
 * - deployed-origin (default, the only mode any workflow uses). Bubblewrap downloads icons and the
 *   web manifest from the production origin named in android/twa-manifest.json and bakes them into
 *   the app. Immediately before it runs, `verifyOriginAssets` re-downloads exactly those assets and
 *   requires the SHA-256 of the checked-in public/ files; afterwards verify-generated re-derives
 *   every embedded PNG and the embedded manifest from public/ and compares bytes. Preflight used to
 *   be the only guard, and it was procedure: a deploy between preflight and generate slipped by.
 *
 * - local-debug (`npm run android:generate -- --local-debug`). For building a DEBUG bundle before
 *   the mobile branch is deployed (production still serves origin/main, whose PNG icons 404). The
 *   script serves ONLY the four checked-in files Bubblewrap fetches from a 127.0.0.1 server on an
 *   ephemeral port it starts and stops itself, and hands Bubblewrap a TEMPORARY copy of
 *   twa-manifest.json in which only those four asset URLs point at that server. host, packageId,
 *   startUrl, shortcuts' target URLs, share target, colours and version are untouched, so the app
 *   still opens https://pulseblr-u9f1.vercel.app. The one asset URL Bubblewrap also EMBEDS
 *   (webManifestUrl, a runtime string resource) is restored to production by the postprocess, and
 *   verify-generated fails on any loopback address left in the generated sources. The output is
 *   marked (android/pulseblr-local-debug.json + a banner) and refused in any release/signing
 *   context by the generator, verify-generated and android-gradle.mjs bundleRelease.
 *
 * The checked-in android/twa-manifest.json is never written by either mode.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ANDROID_PACKAGE_ID,
  PRODUCTION_ORIGIN,
  assertWebAndTwaParity,
} from '../lib/mobile-release-contract';
import { checkAndroidToolchain, type AndroidToolchainPaths } from './android-toolchain';
import {
  ANDROID_BUILD_TOOLS_VERSION,
  BUBBLEWRAP_ASSETS,
  GRADLE_DISTRIBUTION_SHA256,
  GRADLE_DISTRIBUTION_URL,
  LOCAL_DEBUG_MARKER,
  printLocalDebugBanner,
  releaseContextReasons,
  sha256,
  verifyGeneratedProject,
  verifyOriginAssets,
  type BubblewrapAsset,
} from './android-verify';

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
  /** A temporary twa-manifest.json to pass as `--manifest` (local-debug only). */
  manifestPath?: string;
}

export interface BubblewrapCompatibilityResult {
  shortcutCount: number;
  shortcutPaths: string[];
}

export interface BubblewrapPostprocessOptions {
  commitStagedFile?: (staged: string, target: string) => void;
  /**
   * The loopback origin local-debug handed Bubblewrap. When set, the embedded webManifestUrl that
   * Bubblewrap wrote from the temporary manifest is restored to the production value.
   */
  localDebugAssetOrigin?: string;
}

export type GenerateMode = 'deployed-origin' | 'local-debug';
export const LOCAL_DEBUG_FLAG = '--local-debug';

const shortcutPaths = ['/scan', '/card', '/', '/tracker', '/calendar'] as const;
const generatedLimit = 'assert twaManifest.shortcuts.size() < 5, "You can have at most 4 shortcuts."';
const compatibleLimit = 'assert twaManifest.shortcuts.size() == 5, "PulseBLR requires exactly 5 shortcuts."';
const generatedData = "'android:data': s.url)";
const compatibleData = "'android:data': '@string/shortcut_url_' + i)";
const generatedCompileSdk = 'compileSdkVersion 36';
const pinnedBuildTools = `compileSdkVersion 36\n    buildToolsVersion "${ANDROID_BUILD_TOOLS_VERSION}"`;
// The template writes `distributionUrl=https\://...` (a .properties-escaped colon).
const generatedDistributionUrl = `distributionUrl=${GRADLE_DISTRIBUTION_URL.replace('https://', 'https\\://')}`;
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
  return source.replace(expected, () => replacement);
}

function replaceExactly(source: string, expected: string, replacement: string, times: number, label: string): string {
  const count = source.split(expected).length - 1;
  if (count !== times) {
    throw new Error(`Bubblewrap 1.25.0 ${label} template replacement expected ${times} times, found ${count}`);
  }
  return source.split(expected).join(replacement);
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

/**
 * Gaps 2-4, applied to the files Gradle reads:
 * - gradle-wrapper.properties gets Gradle's published distributionSha256Sum (the template has
 *   none, so the wrapper would run any bytes the URL returned);
 * - the top-level build.gradle's two jcenter() repositories become mavenCentral(). JCenter has
 *   been read-only since 2021 and the repository method is removed in Gradle 9. The swap was
 *   proven by building: every dependency of the generated project resolved from google() and
 *   mavenCentral() with an empty Gradle cache;
 * - app/build.gradle pins buildToolsVersion to the 36.0.0 the toolchain check requires.
 * Each replacement demands the exact upstream shape, so template drift fails loudly instead of
 * leaving a pin silently unapplied.
 */
function pinGradleBuild(appGradle: string, rootGradle: string, wrapperProperties: string, localDebugAssetOrigin?: string) {
  if (/\bbuildToolsVersion\b/.test(appGradle)) {
    throw new Error('Bubblewrap 1.25.0 app/build.gradle unexpectedly already sets buildToolsVersion');
  }
  let app = replaceExactlyOnce(appGradle, generatedCompileSdk, pinnedBuildTools, 'build-tools pin');
  if (localDebugAssetOrigin) {
    app = replaceExactlyOnce(
      app,
      `resValue "string", "webManifestUrl", '${localDebugAssetOrigin}/manifest.json'`,
      `resValue "string", "webManifestUrl", '${PRODUCTION_ORIGIN}/manifest.json'`,
      'local-debug webManifestUrl restore',
    );
  }
  const root = replaceExactly(rootGradle, 'jcenter()', 'mavenCentral()', 2, 'jcenter repository');
  if (/distributionSha256Sum/.test(wrapperProperties)) {
    throw new Error('Bubblewrap 1.25.0 gradle-wrapper.properties unexpectedly already sets distributionSha256Sum');
  }
  const wrapperLines = wrapperProperties.split(/\r?\n/);
  if (wrapperLines.filter(line => line.trim() === generatedDistributionUrl).length !== 1 ||
    wrapperLines.filter(line => line.trim().startsWith('distributionUrl')).length !== 1) {
    throw new Error(`Bubblewrap 1.25.0 gradle-wrapper.properties must name exactly ${GRADLE_DISTRIBUTION_URL}`);
  }
  const wrapper = `${wrapperProperties.replace(/\s*$/, '')}\n` +
    `# PulseBLR postprocess: Gradle's published SHA-256 for gradle-8.11.1-bin.zip, from\n` +
    `# https://services.gradle.org/distributions/gradle-8.11.1-bin.zip.sha256 (fetched 2026-09-27)\n` +
    `distributionSha256Sum=${GRADLE_DISTRIBUTION_SHA256}\n`;
  return { app, root, wrapper };
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
  const rootGradleFile = path.join(androidRoot, 'build.gradle');
  const wrapperFile = path.join(androidRoot, 'gradle', 'wrapper', 'gradle-wrapper.properties');
  for (const required of [rootGradleFile, wrapperFile]) {
    if (!existsSync(required)) throw new Error(`Bubblewrap 1.25.0 generated ${path.relative(androidRoot, required)} is missing`);
  }
  const originalGradle = readFileSync(gradleFile, 'utf8');
  const shortcutGradle = replaceExactlyOnce(
    replaceExactlyOnce(originalGradle, generatedLimit, compatibleLimit, 'shortcut-limit'),
    generatedData,
    compatibleData,
    'shortcut-data',
  );
  const pinned = pinGradleBuild(
    shortcutGradle,
    readFileSync(rootGradleFile, 'utf8'),
    readFileSync(wrapperFile, 'utf8'),
    options.localDebugAssetOrigin,
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
    { target: gradleFile, content: pinned.app },
    { target: shortcutsFile, content: shortcutsXml },
    { target: resourcesFile, content: shortcutResources },
    { target: rootGradleFile, content: pinned.root },
    { target: wrapperFile, content: pinned.wrapper },
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

interface BubblewrapInvocation {
  command: string;
  args: string[];
  options: BubblewrapSpawnOptions;
  cleanup: () => void;
}

function prepareBubblewrap(
  repositoryRoot: string,
  toolchain: AndroidToolchainPaths,
  sourceEnvironment: Record<string, string | undefined>,
  manifestPath?: string,
): BubblewrapInvocation {
  const cli = path.join(repositoryRoot, 'node_modules', '@bubblewrap', 'cli', 'bin', 'bubblewrap.js');
  const configRoot = mkdtempSync(path.join(tmpdir(), 'pulseblr-bubblewrap-'));
  const configPath = path.join(configRoot, 'config.json');
  try {
    writeFileSync(configPath, `${JSON.stringify({
      jdkPath: toolchain.javaHome,
      androidSdkPath: toolchain.sdkRoot,
    }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(configPath, 0o600);
  } catch (error) {
    rmSync(configRoot, { recursive: true, force: true });
    throw error;
  }
  return {
    command: process.execPath,
    args: [cli, 'update', '--skipVersionUpgrade', '--config', configPath, ...(manifestPath ? ['--manifest', manifestPath] : [])],
    options: { cwd: path.join(repositoryRoot, 'android'), env: generationEnvironment(sourceEnvironment), stdio: 'inherit' },
    cleanup: () => rmSync(configRoot, { recursive: true, force: true }),
  };
}

export function runBubblewrapUpdate(options: BubblewrapUpdateOptions = {}): number {
  const repositoryRoot = options.repositoryRoot ?? process.cwd();
  const sourceEnvironment = options.env ?? process.env;
  const toolchain = (options.validateToolchain ?? (env => checkAndroidToolchain({ env })))(sourceEnvironment);
  const run = options.run ?? ((command, args, spawnOptions) => spawnSync(command, [...args], {
    ...spawnOptions,
    env: spawnOptions.env as NodeJS.ProcessEnv,
  }));
  const invocation = prepareBubblewrap(repositoryRoot, toolchain, sourceEnvironment, options.manifestPath);
  try {
    const child = run(invocation.command, invocation.args, invocation.options);
    if (child.status !== 0) return child.status ?? 1;
    (options.postprocess ?? postprocessGeneratedProject)(repositoryRoot);
    return 0;
  } finally {
    invocation.cleanup();
  }
}

// ---------------------------------------------------------------------------------------------
// Local-debug mode
// ---------------------------------------------------------------------------------------------

export function parseGenerateArgs(args: readonly string[]): { mode: GenerateMode } {
  if (args.length === 0) return { mode: 'deployed-origin' };
  if (args.length === 1 && args[0] === LOCAL_DEBUG_FLAG) return { mode: 'local-debug' };
  throw new Error(`Unknown argument; usage: android-generate.ts [${LOCAL_DEBUG_FLAG}]`);
}

/** Throws, naming every reason, when local-debug would run in a release or signing context. */
export function assertLocalDebugAllowed(
  env: Record<string, string | undefined>,
  androidRoot: string,
  listDirectory?: (directory: string) => string[],
): void {
  const reasons = releaseContextReasons(env, { androidRoot, listDirectory });
  if (reasons.length) {
    throw new Error(`Refusing ${LOCAL_DEBUG_FLAG}: it builds a pre-deployment DEBUG project and must never run in a release or signing context (${reasons.join('; ')})`);
  }
}

/** Dotted paths whose leaf values differ between two JSON values (keys added or removed included). */
export function changedJsonPaths(left: unknown, right: unknown, prefix = ''): string[] {
  const isContainer = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
  if (!isContainer(left) || !isContainer(right) || Array.isArray(left) !== Array.isArray(right)) {
    return JSON.stringify(left) === JSON.stringify(right) ? [] : [prefix || '(root)'];
  }
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])];
  return keys.flatMap(key => changedJsonPaths(left[key], right[key], prefix ? `${prefix}.${key}` : key));
}

const servedRoutes = new Set<string>(BUBBLEWRAP_ASSETS.map(asset => asset.route));

/**
 * The temporary manifest Bubblewrap reads in local-debug mode: the checked-in manifest with ONLY
 * its downloadable asset URLs moved to the loopback server. Each original must be a plain
 * production-origin URL for one of the served files, and the result is diffed against the input so
 * the rewrite provably changed nothing else - host, packageId, startUrl, shortcut target URLs and
 * the share target stay exactly as checked in.
 */
export function localDebugTwaManifest(twa: Record<string, unknown>, assetOrigin: string): Record<string, unknown> {
  if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(assetOrigin)) {
    throw new Error('Local-debug asset origin must be http://127.0.0.1:<port>');
  }
  const rewrite = (value: unknown, label: string): string => {
    if (typeof value !== 'string') throw new Error(`twa-manifest.json ${label} must be a URL string`);
    const url = new URL(value);
    if (url.origin !== PRODUCTION_ORIGIN || url.search || url.hash || url.username || url.password || !servedRoutes.has(url.pathname)) {
      throw new Error(`twa-manifest.json ${label} must be a plain ${PRODUCTION_ORIGIN} URL for a served asset (received ${value})`);
    }
    return `${assetOrigin}${url.pathname}`;
  };
  for (const unsupported of ['monochromeIconUrl']) {
    if (twa[unsupported] !== undefined) throw new Error(`twa-manifest.json ${unsupported} is not in the local-debug asset table`);
  }
  const copy = structuredClone(twa);
  const expectedChanges = ['iconUrl', 'maskableIconUrl', 'webManifestUrl'];
  copy.iconUrl = rewrite(twa.iconUrl, 'iconUrl');
  copy.maskableIconUrl = rewrite(twa.maskableIconUrl, 'maskableIconUrl');
  copy.webManifestUrl = rewrite(twa.webManifestUrl, 'webManifestUrl');
  if (!Array.isArray(copy.shortcuts)) throw new Error('twa-manifest.json shortcuts must be an array');
  copy.shortcuts.forEach((shortcut: Record<string, unknown>, index: number) => {
    if (shortcut.chosenMaskableIconUrl !== undefined || shortcut.chosenMonochromeIconUrl !== undefined) {
      throw new Error(`twa-manifest.json shortcut ${index} icon variants are not in the local-debug asset table`);
    }
    shortcut.chosenIconUrl = rewrite(shortcut.chosenIconUrl, `shortcuts[${index}].chosenIconUrl`);
    expectedChanges.push(`shortcuts.${index}.chosenIconUrl`);
  });
  const changed = changedJsonPaths(twa, copy).sort();
  if (JSON.stringify(changed) !== JSON.stringify([...expectedChanges].sort())) {
    throw new Error(`Local-debug manifest rewrite changed unexpected fields: ${changed.join(', ')}`);
  }
  return copy;
}

export interface LocalAssetServer {
  origin: string;
  served: Map<string, number>;
  unexpected: string[];
  close: () => Promise<void>;
}

/**
 * A 127.0.0.1-bound, ephemeral-port server for exactly the checked-in Bubblewrap assets. Bytes are
 * read once at start, so what is served is what was hashed into the marker. GET/HEAD on an exact
 * route only; anything else is a 404/405 AND recorded, and generation fails on any recorded
 * request - an unexpected fetch means the asset table no longer matches what Bubblewrap does.
 */
export async function startLocalAssetServer(
  repositoryRoot: string,
  assets: readonly BubblewrapAsset[] = BUBBLEWRAP_ASSETS,
): Promise<LocalAssetServer> {
  // Keyed by string, not the route union: it is looked up with the raw request URL, which is
  // attacker-shaped input by definition, and a miss is exactly the case that must be recorded.
  const files = new Map<string, { asset: BubblewrapAsset; bytes: Buffer }>(
    assets.map(asset => [asset.route, { asset, bytes: readFileSync(path.join(repositoryRoot, asset.file)) }]),
  );
  const served = new Map<string, number>(assets.map(asset => [asset.route, 0]));
  const unexpected: string[] = [];
  const server: Server = createServer((request, response) => {
    const target = request.url ?? '';
    const entry = files.get(target);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      unexpected.push(`${request.method} ${target}`);
      response.writeHead(405).end();
      return;
    }
    if (!entry) {
      unexpected.push(`${request.method} ${target}`);
      response.writeHead(404).end();
      return;
    }
    served.set(target, (served.get(target) ?? 0) + 1);
    response.writeHead(200, {
      'content-type': entry.asset.contentType,
      'content-length': entry.bytes.length,
      'cache-control': 'no-store',
    });
    response.end(request.method === 'HEAD' ? undefined : entry.bytes);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    served,
    unexpected,
    close: () => new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

export type AsyncBubblewrapRun = (command: string, args: readonly string[], options: BubblewrapSpawnOptions) => Promise<ChildResult>;

function spawnAsync(command: string, args: readonly string[], options: BubblewrapSpawnOptions): Promise<ChildResult> {
  return new Promise(resolve => {
    const child = spawn(command, [...args], { ...options, env: options.env as NodeJS.ProcessEnv });
    child.once('error', () => resolve({ status: null }));
    child.once('close', code => resolve({ status: code }));
  });
}

export interface LocalDebugOptions {
  repositoryRoot?: string;
  env?: Record<string, string | undefined>;
  validateToolchain?: (env: Record<string, string | undefined>) => AndroidToolchainPaths;
  /** Must be async: the asset server lives in this process, and a synchronous spawn would starve it. */
  run?: AsyncBubblewrapRun;
  postprocess?: (repositoryRoot: string, options: BubblewrapPostprocessOptions) => unknown;
  verify?: (androidRoot: string) => unknown;
  log?: (message: string) => void;
}

export async function runLocalDebugGeneration(options: LocalDebugOptions = {}): Promise<number> {
  const repositoryRoot = options.repositoryRoot ?? process.cwd();
  const androidRoot = path.join(repositoryRoot, 'android');
  const env = options.env ?? process.env;
  assertLocalDebugAllowed(env, androidRoot);
  const toolchain = (options.validateToolchain ?? (source => checkAndroidToolchain({ env: source })))(env);
  const twa = readJson(path.join(androidRoot, 'twa-manifest.json'));
  assertWebAndTwaParity(readJson(path.join(repositoryRoot, 'public', 'manifest.json')), twa);

  const server = await startLocalAssetServer(repositoryRoot);
  const scratch = mkdtempSync(path.join(tmpdir(), 'pulseblr-local-debug-'));
  try {
    const manifestPath = path.join(scratch, 'twa-manifest.json');
    writeFileSync(manifestPath, `${JSON.stringify(localDebugTwaManifest(twa, server.origin), null, 2)}\n`);
    // Written BEFORE Bubblewrap touches android/, so even a half-finished run is marked.
    writeFileSync(path.join(androidRoot, LOCAL_DEBUG_MARKER), `${JSON.stringify({
      mode: 'local-debug',
      releaseArtifact: false,
      note: 'Icons and web manifest were served from checked-in public/ files on 127.0.0.1, not the deployed origin. Debug builds only; refused by every release gate.',
      assets: Object.fromEntries(BUBBLEWRAP_ASSETS.map(asset => [asset.file, sha256(readFileSync(path.join(repositoryRoot, asset.file)))])),
    }, null, 2)}\n`);
    const invocation = prepareBubblewrap(repositoryRoot, toolchain, env, manifestPath);
    let status: number | null;
    try {
      status = (await (options.run ?? spawnAsync)(invocation.command, invocation.args, invocation.options)).status;
    } finally {
      invocation.cleanup();
    }
    if (status !== 0) return status ?? 1;
    if (server.unexpected.length) {
      throw new Error(`Bubblewrap requested assets outside the local-debug table: ${server.unexpected.join(', ')}`);
    }
    const unserved = [...server.served].filter(([, count]) => count === 0).map(([route]) => route);
    if (unserved.length) {
      throw new Error(`Bubblewrap never fetched ${unserved.join(', ')}; the local-debug asset table no longer matches Bubblewrap`);
    }
    (options.postprocess ?? postprocessGeneratedProject)(repositoryRoot, { localDebugAssetOrigin: server.origin });
    (options.verify ?? (root => verifyGeneratedProject(root, { env })))(androidRoot);
    const log = options.log ?? (message => console.log(message));
    log(`Local-debug generation served ${[...server.served].map(([route, count]) => `${route} x${count}`).join(', ')} from ${server.origin}`);
    printLocalDebugBanner();
    return 0;
  } finally {
    await server.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

export interface GenerateOptions {
  args?: readonly string[];
  repositoryRoot?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

export async function generateAndroidProject(options: GenerateOptions = {}): Promise<number> {
  const { mode } = parseGenerateArgs(options.args ?? []);
  const repositoryRoot = options.repositoryRoot ?? process.cwd();
  const env = options.env ?? process.env;
  if (mode === 'local-debug') return runLocalDebugGeneration({ repositoryRoot, env });

  const toolchain = checkAndroidToolchain({ env });
  const checked = await verifyOriginAssets({ repositoryRoot, fetchImpl: options.fetchImpl });
  for (const asset of checked) console.log(`origin asset matches checked-in bytes: ${asset.url} ${asset.sha256}`);
  const status = runBubblewrapUpdate({ repositoryRoot, env, validateToolchain: () => toolchain });
  if (status !== 0) return status;
  const androidRoot = path.join(repositoryRoot, 'android');
  // Removed only after full success: see LOCAL_DEBUG_MARKER in android-verify.ts.
  rmSync(path.join(androidRoot, LOCAL_DEBUG_MARKER), { force: true });
  verifyGeneratedProject(androidRoot, { env });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  generateAndroidProject({ args: process.argv.slice(2) }).then(
    code => { process.exitCode = code; },
    error => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
